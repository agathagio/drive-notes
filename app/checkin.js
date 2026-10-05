// Drive Notes: the habit check-in of the home ("Hoje"), kept in the frontmatter of the day's journal note.
// Extends App (see app/core.js).
//
// Three parts: reading and writing the tracker keys of a note without touching anything else in it; finding
// or creating the day's note in the journal folder; drawing the section of the home and its sheet. The
// sheet's "Escrever no journal de hoje" is apart from the tracker: it starts a new note in the inbox (see
// writeJournalToday), and never touches the day's note.

/** The tracker keys, in the order a note gets them when they are added */
const CHECKIN_KEYS = [...CONFIG.CHECKIN.habits.map((habit) => habit.key), 'sleep', 'mood', 'energy'];

// The short names of the day's label ("sáb, 3 out"), by getDay() and getMonth()
const CHECKIN_WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const CHECKIN_MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

Object.assign(App, {
  // ── The tracker in the frontmatter ──
  // Line by line, no YAML library: the frontmatter is the person's, written in Obsidian too, and every
  // key the app does not know, its order, its comments and its lists go back exactly as they came.

  isHabitKey(key) {
    return CONFIG.CHECKIN.habits.some((habit) => habit.key === key);
  },

  /** Whether the tracker can hold `value` for `key`. null is not a value: it means "no line". */
  checkinValid(key, value) {
    if (this.isHabitKey(key)) return value === true;
    if (key === 'sleep') return typeof value === 'number' && Number.isFinite(value) && value > 0;
    if (key === 'mood' || key === 'energy') return Number.isInteger(value) && value >= 1 && value <= CONFIG.CHECKIN.scaleMax;
    return false;
  },

  /** A frontmatter line `key: value`, the key at column 0, as [key, value], or null for anything else
      (an indented line, a list item, a comment, a blank line) */
  frontmatterLine(line) {
    const match = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    return match ? [match[1], match[2] || ''] : null;
  },

  /** The value a tracker key's text stands for, or null. Strict: a habit is done only with exactly `true`,
      and `false`, quotes or anything else read as if the line were not there. */
  checkinParse(key, text) {
    if (this.isHabitKey(key)) return text === 'true' ? true : null;
    if (key === 'sleep') return /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) && Number(text) > 0 ? Number(text) : null;
    if (!/^\d+$/.test(text)) return null;
    return this.checkinValid(key, Number(text)) ? Number(text) : null;
  },

  /** The tracker of a note: an object with only the keys that hold a valid value. The first line of a key
      counts, as writeTracker changes the first. */
  readTracker(content) {
    const tracker = {};
    const seen = new Set();
    for (const line of this.splitFrontmatter(String(content ?? '')).frontmatter.split(/\r?\n/)) {
      const pair = this.frontmatterLine(line);
      if (!pair || seen.has(pair[0])) continue;
      seen.add(pair[0]);
      if (!CHECKIN_KEYS.includes(pair[0])) continue;
      const value = this.checkinParse(pair[0], pair[1]);
      if (value !== null) tracker[pair[0]] = value;
    }
    return tracker;
  },

  /** The line a tracker key is written as */
  trackerLine(key, value) {
    return `${key}: ${value === true ? 'true' : String(value)}`;
  },

  /** A journal note's frontmatter block, with these keys after `type: journal` */
  journalTemplate(changes = {}, eol = '\n') {
    const lines = CHECKIN_KEYS.filter((key) => changes[key] != null).map((key) => this.trackerLine(key, changes[key]));
    return ['---', 'type: journal', ...lines, '---'].join(eol) + eol;
  },

  /** The note with its tracker changed: `changes` is { key: value | null }. A key that has a line gets that
      line replaced, one that has none is added at the end of the block, and null takes the line out.
      Everything else stays byte for byte: the other keys and their order, comments, lists, the body, the
      line ending the note already uses (CRLF or LF) and whether it ends with one. A note without a
      frontmatter gets one in front, with `type: journal`. */
  writeTracker(content, changes) {
    const text = String(content ?? '');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const keys = CHECKIN_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(changes, key));
    const { frontmatter, body } = this.splitFrontmatter(text);
    const head = text.slice(0, text.length - body.length);
    if (!head) {
      if (!keys.some((key) => changes[key] != null)) return text;
      return this.journalTemplate(changes, eol) + text;
    }

    // The block is: the opening fence, the frontmatter, then the closing fence with the line break before
    // it. The frontmatter is cut into lines that keep their own break, so an untouched line goes back as it came.
    const open = /^---[ \t]*\r?\n/.exec(head)[0];
    const closing = head.slice(open.length + frontmatter.length);
    const parts = frontmatter.split(/(\r?\n)/);
    let lines = [];
    // An empty block ("---", a blank line, "---") has nothing to keep
    if (frontmatter !== '') {
      for (let i = 0; i < parts.length; i += 2) lines.push({ text: parts[i], sep: parts[i + 1] || '' });
    }

    const added = [];
    for (const key of keys) {
      const value = changes[key];
      const at = [];
      lines.forEach((line, i) => {
        if (this.frontmatterLine(line.text)?.[0] === key) at.push(i);
      });
      const drop = new Set(at.slice(1)); // a second line of the same key would come back once the first is gone
      // A value of this key written over several lines (indented, or a list) goes with its line
      for (const i of at) {
        for (let j = i + 1; j < lines.length && /^(?:[ \t]|-(?:\s|$))/.test(lines[j].text); j++) drop.add(j);
      }
      if (value == null) {
        if (at.length) drop.add(at[0]);
      } else if (at.length) {
        lines[at[0]].text = this.trackerLine(key, value);
      } else {
        added.push({ text: this.trackerLine(key, value), sep: '' });
      }
      lines = lines.filter((_, i) => !drop.has(i));
    }
    // New keys go after the last line with something on it, before any blank lines that close the block
    let end = lines.length;
    while (end > 0 && !lines[end - 1].text.trim()) end--;
    lines.splice(end, 0, ...added);
    // Every line but the last ends with a break (the new ones with the note's), and the last with none:
    // the break before the closing fence belongs to it
    lines.forEach((line, i) => {
      if (i === lines.length - 1) line.sep = '';
      else if (!line.sep) line.sep = eol;
    });
    return open + lines.map((line) => line.text + line.sep).join('') + closing + body;
  },

  // ── The day's note on the Drive ──
  // date: the day the section shows (YYYY-MM-DD, local time). tracker: its keys as the screen shows them.
  // fileId: its note on the Drive, once known. pending: { [date]: { key: value | null } }, the taps not on
  // the Drive yet, by day: a tap without network goes up later, to the note of the day it was made.
  // pendingIds: { [date]: id }, the ID a day's note is being created with (see writeJournalDay).
  // Kept on the device (KEYS.CHECKIN) on every change, so the home draws at once and nothing is lost.
  _checkin: { date: null, tracker: {}, fileId: null, pending: {}, pendingIds: {} },

  // Memory only. missing: the journal folder was not found. readDate, readAt and readSeq: the last read
  // of the day's note (which day, when, and its sequence, so a late answer is dropped). landed: how many
  // writes of today reached the Drive (a read begun before one of them is older than the screen).
  // queued: the push waiting in the write queue, so taps in a row share it.
  _checkinView: { missing: false, readDate: null, readAt: 0, readSeq: 0, landed: 0, queued: null },

  /** The clock of the check-in. A method so the tests can set the day. */
  checkinNow() {
    return new Date();
  },

  /** The day, as YYYY-MM-DD in local time */
  checkinDate(now = this.checkinNow()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  },

  journalFileName(date) {
    return `${date}-journal.md`;
  },

  /** The name of a note started by "Escrever no journal de hoje": <YYYY-MM-DD-HHMM>-journal.md, local time */
  journalEntryName(now = this.checkinNow()) {
    return this.generateFileName(now).replace(/\.md$/, '-journal.md');
  },

  isCheckinDay(date) {
    return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
  },

  /** The valid entries of what came from the device, which may be from an older version or broken.
      With `withNull`, null passes too (a pending "take the line out"). */
  checkinEntries(source, withNull) {
    const entries = {};
    if (!source || typeof source !== 'object' || Array.isArray(source)) return entries;
    for (const key of CHECKIN_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const value = source[key];
      if ((withNull && value === null) || this.checkinValid(key, value)) entries[key] = value;
    }
    return entries;
  },

  /** A tracker with changes over it: null takes the key out */
  applyCheckin(tracker, changes) {
    const next = { ...tracker };
    for (const [key, value] of Object.entries(changes || {})) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return next;
  },

  /** Read what the device kept of the check-in */
  initCheckin() {
    const kept = this.readJson(KEYS.CHECKIN, null);
    const state = { date: null, tracker: {}, fileId: null, pending: {}, pendingIds: {} };
    if (kept && typeof kept === 'object' && !Array.isArray(kept)) {
      if (this.isCheckinDay(kept.date)) state.date = kept.date;
      state.tracker = this.checkinEntries(kept.tracker, false);
      if (typeof kept.fileId === 'string' && kept.fileId) state.fileId = kept.fileId;
      if (kept.pending && typeof kept.pending === 'object' && !Array.isArray(kept.pending)) {
        for (const [date, changes] of Object.entries(kept.pending)) {
          const clean = this.isCheckinDay(date) ? this.checkinEntries(changes, true) : {};
          if (Object.keys(clean).length) state.pending[date] = clean;
        }
      }
      if (kept.pendingIds && typeof kept.pendingIds === 'object' && !Array.isArray(kept.pendingIds)) {
        for (const [date, id] of Object.entries(kept.pendingIds)) {
          if (this.isCheckinDay(date) && typeof id === 'string' && id) state.pendingIds[date] = id;
        }
      }
    }
    this._checkin = state;
    this.checkinToday();
  },

  /** A full or blocked storage only costs the memory: the screen and the queue go on from _checkin */
  saveCheckin() {
    try {
      localStorage.setItem(KEYS.CHECKIN, JSON.stringify(this._checkin));
    } catch (e) {
      console.warn('The check-in could not be kept on the device:', e);
    }
  },

  /** Today's date, and the state moved to it when the day changed with the app open: the tracker starts
      over from what is still to go up today, and what is still to go up of the day before stays. */
  checkinToday() {
    const c = this._checkin;
    const today = this.checkinDate();
    if (c.date !== today) {
      c.date = today;
      c.fileId = null;
      c.tracker = this.applyCheckin({}, c.pending[today]);
      // The ID of a day still to go up stays: its create may have landed already
      for (const date of Object.keys(c.pendingIds)) {
        if (!c.pending[date]) delete c.pendingIds[date];
      }
      this.saveCheckin();
    }
    return today;
  },

  /** ID of the journal folder, or null. Looked up once per device, like the _media: the one found must
      sit right under the root, since the Drive may hold another folder of that name elsewhere. Never
      creates it. */
  async getJournalFolderId() {
    try {
      const cached = localStorage.getItem(KEYS.JOURNAL_FOLDER);
      if (cached) return cached;
    } catch { /* no storage: look it up every time */ }
    const folder = (await this.driveFindByName([CONFIG.JOURNAL_FOLDER])).find((f) =>
      f.mimeType === 'application/vnd.google-apps.folder' && f.parents?.includes(CONFIG.ROOT.id));
    if (!folder) return null;
    try {
      localStorage.setItem(KEYS.JOURNAL_FOLDER, folder.id);
    } catch { /* found again next time */ }
    return folder.id;
  },

  /** In case it was the remembered folder that went away: look it up again next time */
  forgetJournalFolder() {
    try {
      localStorage.removeItem(KEYS.JOURNAL_FOLDER);
    } catch { /* nothing kept */ }
  },

  /** The journal folder was (not) found: the section says so in place of the buttons */
  setCheckinMissing(missing) {
    if (this._checkinView.missing === missing) return;
    this._checkinView.missing = missing;
    this.drawCheckin();
  },

  /** A tap: the screen and the device change now, the Drive through the write queue. Never a history entry. */
  setCheckin(key, value) {
    if (!CHECKIN_KEYS.includes(key) || (value !== null && !this.checkinValid(key, value))) return Promise.resolve(false);
    const date = this.checkinToday();
    const c = this._checkin;
    c.tracker = this.applyCheckin(c.tracker, { [key]: value });
    c.pending[date] = { ...c.pending[date], [key]: value };
    this.saveCheckin();
    this.drawCheckin();
    return this.queueCheckinPush();
  },

  /** pushCheckin through the one write queue (a create and a write racing duplicated notes once). Taps
      in a row before it starts share one push; a tap while it runs queues the next. */
  queueCheckinPush() {
    const view = this._checkinView;
    if (!view.queued) {
      view.queued = this.enqueue(() => {
        view.queued = null;
        return this.pushCheckin();
      });
    }
    return view.queued;
  },

  /** Take what is pending, day by day, to the note of that day. Runs inside the write queue only. Never
      throws and never opens the login window: what fails stays pending for the next try. Answers whether
      everything went up. */
  async pushCheckin() {
    const c = this._checkin;
    const dates = Object.keys(c.pending).sort();
    if (!dates.length) return true;
    if (!this.canRenewQuietly()) return false;
    let folderId = null;
    try {
      folderId = await this.getJournalFolderId();
    } catch (e) {
      console.warn('Check-in: the journal folder could not be looked up:', e);
      return false;
    }
    this.setCheckinMissing(!folderId);
    if (!folderId) return false;

    let all = true;
    for (const date of dates) {
      const sent = { ...c.pending[date] };
      if (!Object.keys(sent).length) {
        delete c.pending[date];
        continue;
      }
      let content;
      try {
        content = await this.writeJournalDay(date, sent, folderId);
      } catch (e) {
        console.warn(`Check-in of ${date} not on the Drive yet:`, e);
        all = false;
        if (e?.status === 404) this.forgetJournalFolder();
        if (e?.code === 'login_needed') break;
        continue;
      }
      // A tap made while this was on its way is still to go up
      const left = { ...c.pending[date] };
      for (const [key, value] of Object.entries(sent)) {
        if (left[key] === value) delete left[key];
      }
      if (Object.keys(left).length) c.pending[date] = left;
      else delete c.pending[date];
      if (date === c.date) {
        c.tracker = this.applyCheckin(this.readTracker(content), c.pending[date]);
        this._checkinView.landed++;
      }
      this.saveCheckin();
      this.drawCheckin();
    }
    return all;
  },

  /** The day's note, { id, content } fresh from the Drive, or null when it does not exist. Today's id, once
      known, is used as is: a note created a moment ago may not show in a search by name yet. */
  async findJournalDay(date, folderId) {
    const c = this._checkin;
    if (date === c.date && c.fileId) {
      const id = c.fileId;
      try {
        return { id, content: await this.driveGetFileContent(id) };
      } catch (e) {
        if (e?.status !== 404) throw e;
        if (c.fileId === id) c.fileId = null; // gone from the Drive: look it up by name
      }
    }
    // The name may exist elsewhere on the Drive: only the one inside the journal folder counts
    const found = (await this.driveFindByName([this.journalFileName(date)])).find((f) => f.parents?.includes(folderId));
    if (!found) return null;
    if (date === c.date) c.fileId = found.id;
    return { id: found.id, content: await this.driveGetFileContent(found.id) };
  },

  /** Write these keys into the day's note, read fresh from the Drive right before (text written on the PC a
      minute ago goes back untouched), or create the note with them. Answers the text now on the Drive.
      The create goes with an ID asked for first and kept in pendingIds: if an earlier create landed and
      its answer was lost (a search by name may not show the note yet), the Drive answers 409 and the
      note that is there is written like a note found. */
  async writeJournalDay(date, changes, folderId) {
    const c = this._checkin;
    const update = async (id, content) => {
      const next = this.writeTracker(content, changes);
      if (next !== content) await this.driveUpdateFile(id, next);
      return next;
    };
    const file = await this.findJournalDay(date, folderId);
    if (file) {
      const next = await update(file.id, file.content);
      delete c.pendingIds[date];
      return next;
    }
    if (!c.pendingIds[date]) {
      c.pendingIds[date] = await this.driveNewId();
      this.saveCheckin(); // before the create goes out: the app may close before its answer
    }
    const id = c.pendingIds[date];
    let written = this.journalTemplate(changes);
    try {
      await this.driveCreateFile(this.journalFileName(date), written, folderId, id);
    } catch (e) {
      if (e?.status !== 409) throw e;
      written = await update(id, await this.driveGetFileContent(id));
    }
    delete c.pendingIds[date];
    if (date === c.date) c.fileId = id;
    return written;
  },

  /** The day's note read from the Drive in the background: the tracker becomes what came, plus what is
      still to go up today. At most once a minute, and whenever the day changes. Never opens the login
      window and never throws. */
  async refreshCheckin() {
    const date = this.checkinToday();
    const view = this._checkinView;
    if (!this.canRenewQuietly()) return;
    if (view.readDate === date && Date.now() - view.readAt < 60000) {
      // Read a moment ago. What a tap without network left behind may go up now.
      if (Object.keys(this._checkin.pending).length) this.queueCheckinPush();
      return;
    }
    view.readDate = date;
    view.readAt = Date.now();
    const seq = ++view.readSeq;
    const landed = view.landed;
    let file = null;
    try {
      const folderId = await this.getJournalFolderId();
      if (seq === view.readSeq) this.setCheckinMissing(!folderId);
      if (!folderId) return;
      file = await this.findJournalDay(date, folderId);
    } catch (e) {
      console.warn('Check-in: the day could not be read from the Drive:', e);
      return;
    }
    const c = this._checkin;
    // A newer read, another day, or a write of today that reached the Drive meanwhile: this answer is
    // older than the screen
    if (seq !== view.readSeq || date !== c.date || landed !== view.landed) return;
    c.tracker = this.applyCheckin(file ? this.readTracker(file.content) : {}, c.pending[date]);
    this.saveCheckin();
    this.drawCheckin();
    if (Object.keys(c.pending).length) this.queueCheckinPush();
  },

  // ── The section of the home and its sheet ──

  /** "sáb, 3 out": built from fixed names, since toLocaleDateString formats differently from one ICU to another */
  checkinDayLabel(date) {
    const [y, m, d] = date.split('-').map(Number);
    return `${CHECKIN_WEEKDAYS[new Date(y, m - 1, d).getDay()]}, ${d} ${CHECKIN_MONTHS[m - 1]}`;
  },

  /** The section, called by renderHome. Without a login there is no Drive to write to: hidden, like the
      tree. With one, drawn at once from what the device kept, and set right by the Drive behind it. */
  renderCheckin() {
    const section = document.getElementById('checkin');
    if (!section) return;
    const signedIn = this.canRenewQuietly();
    section.hidden = !signedIn;
    if (!signedIn) return;
    this.checkinToday();
    this.drawCheckin();
    this.refreshCheckin();
  },

  /** The round buttons, once: the habits of CONFIG.CHECKIN and "mais". The taps are bound in bindEvents. */
  buildCheckinRounds(rounds) {
    const round = (text, name) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'checkin-round';
      const disc = document.createElement('span');
      disc.className = 'checkin-disc';
      disc.setAttribute('aria-hidden', 'true');
      disc.textContent = text;
      const label = document.createElement('span');
      label.className = 'checkin-round-name';
      label.textContent = name;
      button.append(disc, label);
      return button;
    };
    for (const habit of CONFIG.CHECKIN.habits) {
      const button = round(habit.label.charAt(0), habit.label);
      button.dataset.habit = habit.key;
      button.setAttribute('aria-pressed', 'false');
      rounds.appendChild(button);
    }
    const more = round('···', 'mais');
    more.dataset.checkinMore = '';
    more.setAttribute('aria-haspopup', 'dialog');
    more.setAttribute('aria-label', 'Sono, humor e energia');
    rounds.appendChild(more);
  },

  /** Draw the section (and the sheet, when it is there) from _checkin */
  drawCheckin() {
    const section = document.getElementById('checkin');
    if (!section) return;
    const c = this._checkin;
    const rounds = document.getElementById('checkin-rounds');
    if (!rounds.children.length) this.buildCheckinRounds(rounds);
    const missing = this._checkinView.missing;
    const filled = CHECKIN_KEYS.filter((key) => c.tracker[key] != null).length;
    document.getElementById('checkin-day').textContent = `Hoje · ${this.checkinDayLabel(c.date)}`;
    const count = document.getElementById('checkin-count');
    count.textContent = `${filled} de ${CHECKIN_KEYS.length}`;
    count.hidden = missing;
    rounds.querySelectorAll('[data-habit]').forEach((button) => {
      button.setAttribute('aria-pressed', String(c.tracker[button.dataset.habit] === true));
    });
    rounds.hidden = missing;
    document.getElementById('checkin-missing').hidden = !missing;
    this.drawCheckinSheet();
  },

  /** The sheet's rows from _checkin: the day, the sleep and the two scales (their buttons made once) */
  drawCheckinSheet() {
    const overlay = document.getElementById('checkin-overlay');
    if (!overlay) return;
    const c = this._checkin;
    document.getElementById('checkin-sheet-title').textContent = `Hoje · ${this.checkinDayLabel(c.date)}`;
    const sleep = document.getElementById('checkin-sleep');
    sleep.textContent = c.tracker.sleep != null ? `${String(c.tracker.sleep).replace('.', ',')} h` : 'sem registro';
    sleep.classList.toggle('is-empty', c.tracker.sleep == null);
    overlay.querySelectorAll('[data-scale]').forEach((scale) => {
      const key = scale.dataset.scale;
      if (!scale.children.length) {
        const name = scale.dataset.label || key;
        for (let value = 1; value <= CONFIG.CHECKIN.scaleMax; value++) {
          const pip = document.createElement('button');
          pip.type = 'button';
          pip.className = 'checkin-pip';
          pip.dataset.value = String(value);
          pip.setAttribute('aria-label', `${name} ${value}`);
          pip.textContent = String(value);
          scale.appendChild(pip);
        }
      }
      scale.querySelectorAll('[data-value]').forEach((pip) => {
        pip.setAttribute('aria-pressed', String(c.tracker[key] === Number(pip.dataset.value)));
      });
    });
  },

  // ── The sheet of "mais" ──
  // A dialog like the others (.modal-overlay): the system back button closes it through its data-dismiss,
  // and a tap on the dimmed backdrop closes it too.

  openCheckinSheet() {
    this.checkinToday();
    this.drawCheckin();
    document.getElementById('checkin-overlay').classList.add('visible');
    this.armWatcher();
  },

  closeCheckinSheet() {
    const overlay = document.getElementById('checkin-overlay');
    if (!overlay.classList.contains('visible')) return;
    overlay.classList.remove('visible');
    this.armWatcher();
    // A new version that waited for the sheet to close
    this.offerUpdate();
  },

  /** − or + on the sleep: the first tap on either sets sleepStart; then half an hour at a time, up to
      sleepMax, and below half an hour the key goes */
  stepSleep(direction) {
    this.checkinToday();
    const { sleepStep, sleepStart, sleepMax } = CONFIG.CHECKIN;
    const current = this._checkin.tracker.sleep;
    if (current == null) return this.setCheckin('sleep', sleepStart);
    if (direction > 0 && current >= sleepMax) return Promise.resolve(true);
    // Rounded: a value written by hand (6.3) must not drift into 6.799999 on the way
    const next = Math.round((current + direction * sleepStep) * 1000) / 1000;
    return this.setCheckin('sleep', next < sleepStep ? null : Math.min(sleepMax, next));
  },

  /** A tap on a number of a scale writes it; a tap on the number already there takes the key away */
  setScale(key, value) {
    this.checkinToday();
    return this.setCheckin(key, this._checkin.tracker[key] === value ? null : value);
  },

  /** "Escrever no journal de hoje": a new note in the inbox, as "nova nota" makes it, named by the check-in's
      clock (journalEntryName) and holding only the `type: journal` frontmatter, the caret below it. Its text
      is filed into the day's journal note later, outside the app; the tracker keeps writing to the day's
      note itself. Every tap starts a new note, and nothing waits for the Drive: the note is created in the
      background, or by its first save without network. */
  writeJournalToday() {
    const overlay = document.getElementById('checkin-overlay');
    // Only a tap on the sheet on screen: the second tap of a double tap comes after it closed
    if (!overlay.classList.contains('visible')) return;
    // The note first, then the sheet. With the note already open when the sheet closes, a new version
    // that waited for the sheet (offerUpdate, in closeCheckinSheet) finds a note on screen and offers its
    // bar instead of reloading the page; and the CloseWatcher the sheet armed stays on for the note, with
    // the home behind it on the back stack: one "back" from the note lands on the home, sheet closed.
    this.newFile({ name: this.journalEntryName(), body: this.journalTemplate() });
    this.closeCheckinSheet();
  },

  /** A tap on a habit: marks it, or takes the mark away. "Not recorded is not done": never `false`. */
  toggleHabit(key) {
    this.checkinToday();
    return this.setCheckin(key, this._checkin.tracker[key] === true ? null : true);
  },
});
