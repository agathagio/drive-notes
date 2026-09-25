// Drive Notes: share target and shortcuts (what arrives from outside). Extends App (see app/core.js).

Object.assign(App, {
  // ── Arrivals ──
  // What another app shares into this one (manifest share_target, received by sw.js) and the shortcuts
  // on the app icon (manifest shortcuts). Both open the app with a parameter; see entradas-design in the vault.

  /** The list item a share becomes, in the shape of the capture notes in the vault inbox: one "- " line,
      no date (the note's `updated` has it). '' when nothing but photos arrived. */
  arrivalEntry({ title = '', text = '', url = '' } = {}) {
    title = String(title || '').trim();
    text = String(text || '').trim();
    url = String(url || '').trim();
    const lone = (s) => /^https?:\/\/\S+$/i.test(s);
    // Android sends no url: the link comes in the text, sometimes in the title
    const link = url || (lone(text) ? text : '') || (lone(title) ? title : '');
    const rest = text && text !== link ? text : '';
    if (link && !rest) {
      const name = title && title !== link ? title.replace(/[[\]]/g, '\\$&') : '';
      return name ? `- [${name}](${link})` : `- ${link}`;
    }
    const body = rest || (title !== link ? title : '');
    if (!body) return '';
    const [first, ...more] = body.split(/\r?\n/);
    let entry = `- ${first}` + more.map((line) => (line.trim() ? `\n  ${line}` : '\n')).join('');
    if (link && !body.includes(link)) entry += ` ${link}`;
    return entry;
  },

  /** The note's text with `entry` at its end, ending on a new empty line (where the caret goes). A blank
      line comes first, unless the note ends in a list item and the entry is one too. With no entry (only
      photos arrived) the blank line alone, so the pictures start a paragraph of their own. */
  appendEntry(content, entry) {
    const body = content.replace(/\s+$/, '');
    if (!body) return entry ? `${entry}\n` : '';
    const last = body.slice(body.lastIndexOf('\n') + 1);
    const inList = !!entry && /^\s*([-*+]|\d+[.)])\s/.test(last);
    return `${body}${inList ? '\n' : '\n\n'}${entry ? `${entry}\n` : ''}`;
  },

  /** One line at the top of the sheet saying what arrived */
  arrivalSummary({ title = '', text = '', url = '', photos = [] } = {}) {
    const words = [...new Set([title, text, url].map((s) => String(s || '').trim()).filter(Boolean))];
    const count = (photos || []).length;
    const pictures = count ? (count === 1 ? '1 foto' : `${count} fotos`) : '';
    return [words.join(' · '), pictures].filter(Boolean).join(' + ');
  },

  // What another app shared waits here, on the device, until it is written into a note. The service
  // worker puts it in (sw.js: same database, store and record; keep the two in step) before the page
  // opens, so nothing depends on the login or the network at that moment. The page reads and removes.
  ArrivalBox: Object.assign(makeStore({
    name: 'drivenotes-arrivals',
    store: 'arrivals',
    upgrade: (db) => db.createObjectStore('arrivals', { keyPath: 'id' }),
    warn: (e) => App.log(`arrival box off: ${e?.name || e}`),
  }), {
    get(id) { return this.run('readonly', null, (store) => store.get(id)); },
    async oldest() {
      const all = await this.run('readonly', null, (store) => store.getAll());
      return (all || []).sort((a, b) => a.at - b.at)[0] || null;
    },
    put(record) { return this.run('readwrite', null, (store) => store.put(record)); },
    remove(id) { return this.run('readwrite', null, (store) => store.delete(id)); },
  }),

  /** What the app was opened for from outside: a shortcut on the icon (?atalho=) or something shared into
      it (?chegada=, see sw.js). Read once and taken out of the address, so that a reload, the new version
      bar or "back" never do it again. */
  readLaunch() {
    const params = new URLSearchParams(location.search);
    const launch = { shortcut: params.get('atalho') || '', arrival: params.get('chegada') || '' };
    if (!launch.shortcut && !launch.arrival) return null;
    history.replaceState(history.state, '', location.pathname);
    return launch;
  },

  async startLaunch({ shortcut, arrival }) {
    this.log(`launch ${shortcut || `arrival ${arrival}`}`);
    if (arrival) {
      const record = await this.ArrivalBox.get(arrival);
      if (!record) {
        this.log('arrival not in box');
        return; // already written into a note, or cancelled: home
      }
      // What Chrome handed the service worker (sw.js receiveShare), without content. Older records have no `got`
      const got = Array.isArray(record.got) ? `[${record.got.join(', ')}]` : '?';
      this.log(`arrival photos=${(record.photos || []).length} got=${got}`);
      return this.openArrivalSheet(record);
    }
    if (shortcut === 'anotar') return this.openArrivalSheet(null);
    if (shortcut === 'nova') return this.newFile();
    if (shortcut === 'buscar') return this.startSearch();
  },

  /** The "Buscar" shortcut: the vault's folder screen with the caret in the search field. An opening from
      the icon is no tap inside the page, and the login popup only opens from one: an expired login asks first. */
  async startSearch() {
    if (!this.hasValidToken()
      && !(await this.confirmDialog('Buscar no vault', 'O login do Google venceu. Entre pra buscar.', 'Entrar', { danger: false }))) return;
    await this.browseVault();
    if (document.body.dataset.view === 'browse') this.els.browserSearch.focus();
  },

  /** Something shared earlier and never written into a note (the app died on the sheet, or there was no network).
      Without network it waits: the sheet would have no list, and every opening would land on it. */
  async offerPendingArrival() {
    if (navigator.onLine === false) return;
    const pending = await this.ArrivalBox.oldest();
    if (pending && !this.els.arrivalOverlay.classList.contains('visible')) this.openArrivalSheet(pending);
  },

  /** The notes of the vault inbox, most recently edited first. CLAUDE.md is the folder's rules, not a note to write in. */
  async inboxNotes() {
    const items = await this.driveListFolder(CONFIG.DEFAULT_FOLDER_ID);
    return items
      .filter((f) => !f.isFolder && f.name.toLowerCase() !== 'claude.md')
      .sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')));
  },

  /** The sheet "Guardar em…": `arrival` is a record of the ArrivalBox, or null for the "Anotar em…"
      shortcut, which only picks a note to write at the end of */
  async openArrivalSheet(arrival) {
    this._arrival = arrival;
    this.els.arrivalTitle.textContent = arrival ? 'Guardar em…' : 'Anotar em…';
    this.els.arrivalWhat.hidden = !arrival;
    this.els.arrivalWhat.textContent = arrival ? this.arrivalSummary(arrival) : '';
    this.els.arrivalOverlay.classList.add('visible');
    this.armWatcher();
    await this.fillArrivalList();
  },

  /** The rows of the sheet, or why there are none: no login (a button, since the popup needs a tap) or no list */
  async fillArrivalList() {
    const els = this.els;
    const kept = this._arrival;
    els.arrivalUl.innerHTML = '';
    els.arrivalMessage.hidden = true;
    els.arrivalLogin.hidden = true;
    this._arrivalListed = false;
    const say = (text) => {
      els.arrivalMessage.textContent = text;
      els.arrivalMessage.hidden = false;
    };
    if (!this.hasValidToken()) {
      say('O login do Google venceu.');
      els.arrivalLogin.hidden = false;
      return;
    }
    let notes = null;
    try {
      notes = await this.inboxNotes();
    } catch (e) {
      console.warn('Inbox list failed:', e);
    }
    // Closed, or opened for something else, while the list was on its way
    if (this._arrival !== kept || !els.arrivalOverlay.classList.contains('visible')) return;
    const row = (label, note, extra = '') => {
      const li = document.createElement('li');
      if (extra) li.className = extra;
      const name = document.createElement('span');
      name.className = 'recent-name';
      name.textContent = label;
      li.appendChild(name);
      li.addEventListener('click', () => this.chooseArrivalTarget(note));
      els.arrivalUl.appendChild(li);
    };
    if (!notes) {
      // No list, but a new note still works: without network it is kept as a draft and goes up later.
      // Nothing was decided yet, so _arrivalListed stays false and Cancelar keeps what arrived.
      // Only photos and no network: they cannot go up, and a new note would be born empty.
      if (navigator.onLine === false && kept && !this.arrivalEntry(kept)) {
        const many = (kept.photos || []).length > 1;
        say(`Sem rede. ${many ? 'As fotos ficam guardadas e voltam' : 'A foto fica guardada e volta'} aqui quando você abrir o app com rede.`);
        return;
      }
      if (navigator.onLine === false) {
        say(kept ? 'Sem rede. Dá pra guardar numa nota nova agora, ou cancelar: fica guardado e volta aqui quando você abrir o app com rede.'
          : 'Sem rede. Dá pra escrever numa nota nova.');
      } else {
        say(kept ? 'Não deu pra abrir a lista do _inbox. Dá pra guardar numa nota nova agora, ou cancelar: fica guardado e volta aqui na próxima abertura.'
          : 'Não deu pra abrir a lista do _inbox.');
      }
      row('+ Nota nova', null, 'arrival-new');
      return;
    }
    row('+ Nota nova', null, 'arrival-new');
    for (const note of notes) row(note.name.replace(/\.md$/i, ''), note);
    this._arrivalListed = true;
  },

  hideArrivalSheet() {
    this.els.arrivalOverlay.classList.remove('visible');
    this._arrival = null;
    this._arrivalListed = false;
    this.armWatcher();
  },

  /** Cancelar, or the back button. With the list on screen that is a "no": what arrived is dropped.
      Without it (no login, no list) nothing was decided, and what arrived stays for the next opening. */
  cancelArrivalSheet() {
    const arrival = this._arrival;
    const drop = !!arrival && this._arrivalListed;
    this.hideArrivalSheet();
    if (drop) this.ArrivalBox.remove(arrival.id);
  },

  /** A tap on a row. `note` is { id, name } from the inbox, or null for "+ Nota nova". The tap is the
      gesture that lets the keyboard open, and beginNav has to run inside it (see beginNav). */
  async chooseArrivalTarget(note) {
    const arrival = this._arrival;
    this.hideArrivalSheet();
    const entry = arrival ? this.arrivalEntry(arrival) : '';
    this.log(`arrival -> ${note ? 'note' : 'new'} photos=${arrival ? (arrival.photos || []).length : 'none'}`);

    if (!note) {
      this.newFile({ body: entry ? `${entry}\n` : '' });
      // Born clean, its creation on the Drive running behind: unsaved, the save below queues after that
      // creation and settles without a write when it went through, or keeps the text as a draft when it did not
      if (entry) this.markDirty();
    } else {
      this.beginNav();
      // The Drive's version, not the one kept on the device: an entry added to an old copy would
      // come back as a conflict on the save
      const opened = await this.openFile(note.id, note.name, { fresh: true });
      if (!opened || this.currentFile?.id !== note.id) {
        this.cancelNav();
        this.log('arrival -> note did not open');
        if (arrival) this.setSaveStatus('error', 'Não deu pra abrir a nota. O que chegou fica guardado.');
        return;
      }
      if (this.mode !== 'edit') this.setMode('edit');
      if (arrival) {
        this.setContent(this.appendEntry(this.getContent(), entry));
        this.markDirty();
      }
      this.caretToEnd();
      this.focusEditor();
    }
    if (!arrival) return;

    // The photos, in the order they came, below the entry: the batch path of the gallery button.
    // Without network they are not even tried: the upload can only fail, and its failure forgets the
    // remembered _media folder. They wait in the box for an opening with network.
    this._photoAt = null;
    const photos = arrival.photos || [];
    const offline = navigator.onLine === false;
    let sent = 0;
    if (photos.length && !offline) {
      const files = photos.map((p) => new File([p.bytes], p.name || 'foto.jpg', { type: p.type || 'image/jpeg' }));
      sent = await this.insertPhotos(files);
    }
    await this.save();
    // What is in the note now is safe, on the Drive or as a local draft: it leaves the box. Photos that
    // did not go up stay, and the sheet comes back with them on the next opening.
    const left = photos.slice(sent);
    if (left.length) await this.ArrivalBox.put({ ...arrival, title: '', text: '', url: '', photos: left });
    else await this.ArrivalBox.remove(arrival.id);
    this.log(`arrival done sent=${sent}/${photos.length}${offline && photos.length ? ' offline, photos kept' : ''}`);
    if (offline && photos.length) {
      this.setSaveStatus('', photos.length === 1 ? 'Sem rede: a foto fica guardada e volta quando você abrir o app com rede'
        : 'Sem rede: as fotos ficam guardadas e voltam quando você abrir o app com rede');
    }
  },
});
