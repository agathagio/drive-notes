// Drive Notes: opening, saving, dates, drafts and the conflict with the Drive. Extends App (see app/core.js).

Object.assign(App, {
  /** Open a Drive file, in the reading view. Shared by the recents list, links and "back".
      `heading` scrolls to a title once open. `fresh` skips the version kept on the device and goes to
      the Drive (the reload after a conflict). Callers reacting to a tap call beginNav() first. */
  async openFile(fileId, fileName, { heading = '', fresh = false } = {}) {
    try {
      return await this.loadFile(fileId, fileName, heading, fresh);
    } finally {
      // Whatever ended up on screen: the note, its draft, or the previous view if loading failed
      this.syncHistory();
    }
  },

  async loadFile(fileId, fileName, heading, fresh = false) {
    const draftKey = `${KEYS.DRAFT_PREFIX}${fileId}`;
    const tapped = Date.now();

    // The note on screen, opened again with text not saved yet (a [[link#heading]] to itself, right after
    // writing): what is on screen is the newest version there is. Reloading would put an older one in its
    // place, the kept one or the Drive's, with the save of that text still on its way, and the next save
    // would then raise a false conflict. Only the heading is followed.
    if (this.currentFile?.id === fileId && this.isDirty) {
      this.scrollToHeading(heading);
      return true;
    }

    // A note seen before shows at once, before any trip to the Drive, the login's included. Not with a
    // draft (the draft wins, and telling whether it differs from the Drive takes the Drive's text), and
    // not when the Drive's version is asked for on purpose.
    if (!fresh && !this.readDraft(draftKey)) {
      const kept = await this.NoteStore.get(fileId);
      if (kept) return this.openKept(kept, heading, tapped);
    }

    try {
      await this.ensureAuth();
    } catch {
      // No login (offline, popup blocked): unsynced local edits of this file are still reachable
      if (this.openDraft(draftKey)) return true;
      this.setSaveStatus('error', 'Faça login primeiro');
      return false;
    }

    // Whatever is open gets saved before it is replaced
    this.flushCurrent();

    const seq = ++this._loadSeq;
    const opening = this._opening = { view: 'file', id: fileId, name: fileName };
    const started = Date.now();
    this.setSaveStatus('saving', 'Carregando...');

    let meta, content;
    try {
      // Metadata first: if the file changes between the two requests we end up with an
      // older modifiedTime than the content, which errs towards a false conflict, never a missed one
      meta = await this.driveGetFileMeta(fileId);
      content = await this.driveGetFileContent(fileId);
    } catch (e) {
      console.error('Failed to load file:', e);
      if (seq !== this._loadSeq) return true;
      if (this._opening === opening) this._opening = null;
      // Offline or Drive error: unsynced local edits of this file are still reachable
      if (this.openDraft(draftKey)) return true;
      this.setSaveStatus('error', 'Erro ao carregar');
      return false;
    }
    if (seq !== this._loadSeq) return true; // another file was opened meanwhile: not ours to undo
    this.log(`loaded ${meta.name || fileName} ${Date.now() - started}ms`);
    // Kept the way the Drive has it, whatever ends up on screen (a draft included): the next opening shows it at once
    this.NoteStore.put({ id: fileId, name: meta.name || fileName, parents: meta.parents, modifiedTime: meta.modifiedTime, content });

    const file = {
      id: fileId,
      name: meta.name || fileName,
      draftKey,
      modifiedTime: meta.modifiedTime,
      parents: meta.parents,
    };

    // Unsynced local edits win over the Drive copy; the conflict check on save arbitrates
    const draft = this.readDraft(draftKey);
    if (draft && draft.content !== content) {
      file.modifiedTime = draft.baseModifiedTime;
      this.currentFile = file;
      this.setContent(draft.content);
      this.isDirty = true;
      this.updateFileNameDisplay();
      this.showEditor();
      this.setSaveStatus('', 'Rascunho não sincronizado');
    } else {
      if (draft) localStorage.removeItem(draftKey);
      this.currentFile = file;
      this.setContent(content);
      // What the editor gives back for an untouched file, so opening never counts as a change
      file.lastSavedContent = this.getContent();
      this.showEditor('preview');
      this.landInNote(heading);
      this.setSaveStatus('saved', 'Carregado');
      setTimeout(() => {
        if (this.currentFile === file) this.setSaveStatus('', '');
      }, 2000);
    }
    this.saveToRecents(fileId, file.name);
    return true;
  },

  /** A note kept on the device (NoteStore): on screen at once, in the reading view, then a single
      question to the Drive, behind it, whether it changed (checkKept). Answers true: the note landed. */
  openKept(kept, heading, tapped) {
    // Whatever is open gets saved before it is replaced
    this.flushCurrent();
    const seq = ++this._loadSeq;
    const file = {
      id: kept.id,
      name: kept.name,
      draftKey: `${KEYS.DRAFT_PREFIX}${kept.id}`,
      modifiedTime: kept.modifiedTime,
      parents: kept.parents || undefined,
    };
    this.currentFile = file;
    this.setContent(kept.content);
    // What the editor gives back for an untouched file, so opening never counts as a change
    file.lastSavedContent = this.getContent();
    this.showEditor('preview');
    this.landInNote(heading);
    this.setSaveStatus('', '');
    this.saveToRecents(file.id, file.name);
    this.log(`cached ${file.name} ${Date.now() - tapped}ms`);
    this.checkKept(file, kept, seq, tapped);
    return true;
  },

  /** The question behind a kept note: did it change on the Drive? The comparison is with the KEPT
      modifiedTime, never with the one on screen, which a save may have moved in the meantime: a kept
      entry must never pair old text with a new modifiedTime, or the next question would answer "same"
      forever. Changed: the new text is fetched, kept, and swapped in only if this note is still the one
      on screen, with nothing unsaved and no save in between. With something unsaved it is left alone,
      and the note keeps the old modifiedTime, which is what makes the save find the conflict. Only the
      modifiedTime moved (a rename, a sync touching the file): quietly up to date. Never throws: a failure
      leaves the kept version on screen, saying so. */
  async checkKept(file, kept, seq, tapped) {
    const here = () => seq === this._loadSeq && this.currentFile === file;
    try {
      await this.ensureAuth();
    } catch {
      if (here()) this.setSaveStatus('error', 'Sem login: versão guardada');
      return;
    }

    let meta;
    let content = null;
    try {
      meta = await this.driveGetFileMeta(file.id);
      if (meta.modifiedTime !== kept.modifiedTime) content = await this.driveGetFileContent(file.id);
    } catch (e) {
      console.warn('Kept note not checked:', e);
      if (here()) this.setSaveStatus('error', 'Sem conexão: versão guardada');
      return;
    }

    const name = meta.name || kept.name;
    const changed = content !== null && content !== kept.content;
    this.log(`checked ${name} ${changed ? 'changed' : 'same'} ${Date.now() - tapped}ms`);
    // The pair of the same moment: the kept text with the kept date, or the new text with the new date
    this.NoteStore.put(content === null
      ? { ...kept, name, parents: meta.parents }
      : { id: file.id, name, parents: meta.parents, modifiedTime: meta.modifiedTime, content });

    if (!here()) return;
    if (name !== file.name) {
      file.name = name;
      this.updateFileNameDisplay();
      this.saveToRecents(file.id, name);
      this.syncHistory();
    }
    // Nothing unsaved, and no save moved the note since it was shown
    if (content === null || this.isDirty || file.modifiedTime !== kept.modifiedTime) return;

    file.modifiedTime = meta.modifiedTime;
    file.parents = meta.parents;
    if (!changed) return;

    // setMode would put the reading view back at the top: the swap redraws it and keeps the scroll
    const scroll = this.els.previewContainer.scrollTop;
    this.setContent(content);
    file.lastSavedContent = this.getContent();
    file.driveContent = null;
    if (this.mode === 'preview') {
      this.renderPreview();
      this.els.previewContainer.scrollTop = scroll;
    }
    this.setSaveStatus('saved', 'Atualizada do Drive');
    setTimeout(() => {
      if (this.currentFile === file && this.els.saveStatus.textContent === 'Atualizada do Drive') this.setSaveStatus('', '');
    }, 2000);
  },

  /** A tap that leads to a note: the history entry is created now, and dropped again if the note never opens */
  async navigateTo(fileId, fileName, options) {
    this.beginNav();
    if (!(await this.openFile(fileId, fileName, options))) this.cancelNav();
  },

  // ── Auto-save ──

  scheduleAutoSave() {
    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => {
      this.save();
    }, 30000);
  },

  // ── File operations ──

  /** Generate a timestamp-based filename like 2026-04-11-2143.md */
  generateFileName() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.md`;
  },

  newFile({ body = '' } = {}) {
    // Whatever is open gets saved before it is replaced
    this.flushCurrent();
    this._loadSeq++; // a file still loading must not land on top of the new note
    this.beginNav();

    const name = this.generateFileName();
    // The draft key is fixed for the life of the note, so the draft is still found
    // (and cleared) after the note gets its Drive ID
    const file = { id: null, name: name, draftKey: `${KEYS.DRAFT_PREFIX}new_${Date.now()}` };
    this.currentFile = file;
    this.syncHistory();
    const today = this.today();
    this.setContent(`---\ncreated: ${today}\nupdated: ${today}\n---\n\n${body}`);
    this.showEditor();
    this.updateFileNameDisplay();
    this.focusEditor();
    this.caretToEnd(); // typing starts below the properties
    const born = this.getContent();

    // Create on Drive in background, not awaited, so the user can type immediately.
    // If it fails, the first save creates the file instead.
    if (this.hasValidToken()) {
      this.setSaveStatus('saving', 'Criando no Drive...');
      this.enqueue(() => this.createOnDrive(file, born)).then(() => {
        if (this.currentFile !== file) return;
        this.setSaveStatus('saved', 'Criado no Drive');
        setTimeout(() => {
          if (this.currentFile === file) this.setSaveStatus('', '');
        }, 2000);
      }).catch((e) => {
        console.error('Failed to create on Drive:', e);
        if (this.currentFile === file) this.setSaveStatus('error', 'Erro ao criar no Drive');
      });
    }
  },

  /** Focus the editor for immediate typing */
  focusEditor() {
    this.Editor.focus();
  },

  caretToEnd() {
    this.Editor.moveCaretToEnd();
  },

  /** Run a Drive write after every write queued before it */
  enqueue(task) {
    const run = this._saveChain.then(task);
    this._saveChain = run.catch(() => {});
    return run;
  },

  /** Save the open file. `manual` is a tap on save: the only thing that reopens a pending conflict dialog. */
  async save({ manual = false } = {}) {
    const file = this.currentFile;
    if (!file || !this.isDirty) return;
    clearTimeout(this.autoSaveTimer);

    if (file.conflict) {
      // Never write over a Drive version the user hasn't ruled on; keep the text safe locally
      this.saveDraft();
      if (manual) this.showConflict(file);
      return;
    }

    // A tap is the only moment a login popup is allowed to open, so an expired login is renewed here.
    // Automatic saves never try: they fall back to the local draft (see saveSnapshot).
    if (manual && !this.hasValidToken()) {
      this.saveDraft();
      try {
        await this.ensureAuth();
      } catch (e) {
        console.warn('Login on save failed:', e);
      }
      if (this.currentFile !== file) return; // flushCurrent already took care of it
    }

    const content = this.getContent();
    return this.enqueue(() => this.saveSnapshot(file, content));
  },

  /** Called before the editor switches to another file: the open one is saved in the background.
      The draft is written first, synchronously, so the text survives whatever happens to the request.
      Where its reading stopped is kept too (rememberPlace). */
  flushCurrent() {
    this.rememberPlace();
    clearTimeout(this.autoSaveTimer);
    const file = this.currentFile;
    if (!file || !this.isDirty) return;

    const content = this.getContent();
    this.saveDraft(file, content);
    if (file.conflict) return; // stays as a draft; the dialog comes back when it is reopened
    this.enqueue(() => this.saveSnapshot(file, content));
  },

  /** Write one snapshot of one file to Drive. The file may no longer be the open one,
      so the UI is only touched while it still is. Never throws: on failure the snapshot becomes a draft.
      Answers whether the text is ON DRIVE, which is not the same as the promise resolving: every failure
      here resolves too, having written a local draft instead. Whoever acts on the Drive afterwards
      (removeEmbedLine binning a picture) has to tell the two apart. */
  async saveSnapshot(file, content) {
    const isCurrent = () => this.currentFile === file;

    if (file.conflict) {
      // Queued behind a save of the same file that hit a conflict
      this.saveDraft(file, content);
      return false;
    }

    if (content === file.lastSavedContent) {
      this.settleSaved(file, content);
      return true;
    }

    if (!this.hasValidToken()) {
      // No usable login: keep it locally. It stays flagged as unsaved because it is not on Drive.
      this.saveDraft(file, content);
      if (isCurrent()) {
        if (this.accessToken) {
          this.setSaveStatus('error', 'Login expirou: toque em salvar');
        } else {
          this.setSaveStatus('saved', 'Rascunho salvo');
          setTimeout(() => {
            if (isCurrent()) this.setSaveStatus('', '');
          }, 3000);
        }
      }
      return false;
    }

    if (isCurrent()) {
      this.setSaveStatus('saving', file.id ? 'Salvando...' : 'Criando no Drive...');
    }

    try {
      // What goes to the Drive carries today's `updated`; the editor's text is left alone (see Dates)
      const dated = await this.withDates(file, content);

      if (file.id) {
        // Someone else (the PC, another device) may have written the file since we opened it
        const remote = await this.driveGetFileMeta(file.id, 'modifiedTime');
        if (remote.modifiedTime !== file.modifiedTime) {
          file.conflict = true;
          file.remoteModifiedTime = remote.modifiedTime;
          this.saveDraft(file, content);
          if (isCurrent()) {
            this.setSaveStatus('error', 'Conflito com o Drive');
            this.showConflict(file);
          } else {
            this.setSaveStatus('error', `Conflito em ${file.name}: rascunho guardado`);
          }
          return false;
        }

        const result = await this.driveUpdateFile(file.id, dated);
        file.modifiedTime = result.modifiedTime;
        // The device keeps what is now on the Drive: opening this note again needs no download
        this.NoteStore.put({ id: file.id, name: file.name, parents: file.parents, modifiedTime: file.modifiedTime, content: dated });
      } else {
        await this.createOnDrive(file, dated);
      }
      // Saved text is compared with the editor's, so it is recorded the way the editor has it
      file.lastSavedContent = content;
      file.driveContent = dated === content ? null : dated;
    } catch (e) {
      console.error('Drive save failed:', e);
      this.saveDraft(file, content);
      if (isCurrent()) {
        this.setSaveStatus('error', 'Erro: salvo local');
      } else {
        this.setSaveStatus('error', `Erro ao salvar ${file.name}: rascunho guardado`);
      }
      return false;
    }

    this.settleSaved(file, content);
    if (isCurrent()) {
      this.setSaveStatus('saved', 'Salvo no Drive');
      setTimeout(() => {
        if (isCurrent()) this.setSaveStatus('', '');
      }, 3000);
    }
    return true;
  },

  /** Bookkeeping after `content` is known to be on Drive */
  settleSaved(file, content) {
    if (this.currentFile !== file) {
      this.clearDraft(file);
      return;
    }

    // Text typed while the request was in flight is not on Drive yet
    const changed = this.getContent() !== content;
    this.isDirty = changed;
    this.updateFileNameDisplay();
    if (changed) {
      this.scheduleAutoSave();
    } else {
      this.clearDraft(file);
      this.showSavedDates();
    }
  },

  /** Create `file` on Drive and record its ID and version on the file object */
  async createOnDrive(file, content) {
    const folderId = file.parents?.[0] || CONFIG.DEFAULT_FOLDER_ID;
    const result = await this.driveCreateFile(file.name, content, folderId);
    file.id = result.id;
    file.modifiedTime = result.modifiedTime;
    file.parents = result.parents;
    file.lastSavedContent = content;
    this.NoteStore.put({ id: file.id, name: file.name, parents: file.parents, modifiedTime: file.modifiedTime, content });

    // A draft written while the create was in flight still says "not on Drive";
    // opening it later would create the file a second time
    const draft = this.readDraft(file.draftKey);
    if (draft) {
      draft.fileId = file.id;
      draft.baseModifiedTime = file.modifiedTime;
      draft.parents = file.parents;
      localStorage.setItem(file.draftKey, JSON.stringify(draft));
    }

    this.saveToRecents(file.id, file.name);
    this.noteIndexAdd(file).catch((e) => console.warn('Note index not updated:', e));
    if (this.currentFile === file) this.syncHistory(); // the entry can now name the note by ID
  },

  // ── Dates (created / updated) ──
  // The vault keeps `created` and `updated` (YYYY-MM-DD) in the properties of its notes. A new note is born
  // with both. After that, `updated` is set in the text on its way to the Drive, not in the editor: replacing
  // the editor's text while the keyboard is up loses the caret and breaks dictation. The editor catches up
  // when it is out of sight (showSavedDates).

  today() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  },

  /** `content` the way it goes to the Drive. Never throws: when in doubt, the note is saved as it is. */
  async withDates(file, content) {
    const name = file.name.toLowerCase();
    if (!name.endsWith('.md') || name.includes('-antigo') || CONFIG.NO_DATES_FILES.includes(name)) return content;

    try {
      const dated = await this.folderKeepsDates(file.parents?.[0] || CONFIG.DEFAULT_FOLDER_ID);
      return dated ? this.stampDates(content, this.today(), !file.id) : content;
    } catch (e) {
      console.warn('Could not tell where the note lives, dates left alone:', e);
      return content;
    }
  },

  /** True for a folder inside the vault and outside NO_DATES_FOLDERS */
  async folderKeepsDates(folderId) {
    if (folderId === CONFIG.DEFAULT_FOLDER_ID) return true; // new notes are born here: never costs a request
    const trail = await this.folderTrail(folderId);
    return !!trail && !trail.some(name => CONFIG.NO_DATES_FOLDERS.includes(name));
  },

  /** The folder names from the vault root down to this folder, or null outside the vault.
      Walks up the Drive, one request per level, once per folder. */
  folderTrail(folderId) {
    if (!this._folderTrails.has(folderId)) {
      const trail = this.driveGetFileMeta(folderId, 'name,parents').then(async (folder) => {
        const parent = folder.parents?.[0];
        const above = parent ? await this.folderTrail(parent) : null; // top of the Drive: not in the vault
        return above && [...above, folder.name];
      });
      this._folderTrails.set(folderId, trail);
      trail.catch(() => this._folderTrails.delete(folderId));
    }
    return this._folderTrails.get(folderId);
  },

  /** Set `updated` to `today` in the note's properties, adding the line (or the whole block) when missing.
      `created` is only ever added to a note that is being created: an old note never gets an invented one. */
  stampDates(content, today, isNew) {
    const bom = content.startsWith('﻿') ? '﻿' : '';
    const text = content.slice(bom.length);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const updated = `updated: ${today}`;

    if (lines[0] !== '---') {
      const props = isNew ? [`created: ${today}`, updated] : [updated];
      return bom + ['---', ...props, '---', '', ...lines].join(eol);
    }

    const end = lines.indexOf('---', 1);
    if (end === -1) return content;
    const props = lines.slice(1, end);
    // A leading `---` with no YAML under it is a horizontal rule, not properties
    const isYaml = props.every((l) => l.trim() === '' || /^\s*#/.test(l) || /^\s+\S/.test(l) || /^\s*- /.test(l) || /^[^\s:#][^:]*:(\s|$)/.test(l));
    if (!isYaml) return content;

    const needsCreated = isNew && !props.some((l) => /^created:/.test(l));
    let at = props.findIndex((l) => /^updated:/.test(l));
    if (at !== -1 && props[at].trim() === updated && !needsCreated) return content;

    if (at === -1) at = props.push(updated) - 1;
    else props[at] = updated;
    if (needsCreated) props.splice(at, 0, `created: ${today}`);
    return bom + ['---', ...props, ...lines.slice(end)].join(eol);
  },

  /** Bring the editor up to the dates that went to the Drive. Only in reading view, with nothing unsaved. */
  showSavedDates() {
    const file = this.currentFile;
    if (!file || !file.driveContent || this.isDirty || this.mode !== 'preview') return;

    if (this.getContent() === file.lastSavedContent) {
      this.setContent(file.driveContent);
      file.lastSavedContent = this.getContent();
      const shown = this.els.previewContainer.querySelector('details.frontmatter pre');
      if (shown) shown.textContent = this.splitFrontmatter(this.getContent()).frontmatter;
    }
    file.driveContent = null;
  },

  // ── Drafts (localStorage) ──
  // One draft per file, under file.draftKey. A draft means "text that is not on Drive yet".

  saveDraft(file = this.currentFile, content = this.getContent()) {
    if (!file) return;
    const draft = {
      name: file.name,
      content: content,
      timestamp: Date.now(),
      fileId: file.id,
      // Drive version the text was based on, so the conflict check still works after a restart
      baseModifiedTime: file.modifiedTime,
      parents: file.parents,
    };
    try {
      localStorage.setItem(file.draftKey, JSON.stringify(draft));
    } catch (e) {
      console.error('Failed to save draft:', e);
    }
  },

  clearDraft(file = this.currentFile) {
    if (file) localStorage.removeItem(file.draftKey);
  },

  readDraft(key) {
    try {
      const draft = JSON.parse(localStorage.getItem(key));
      return draft && typeof draft.content === 'string' ? draft : null;
    } catch {
      return null;
    }
  },

  /** All non-empty drafts, newest first. Includes keys written by older versions of the app. */
  listDrafts() {
    const drafts = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key.startsWith(KEYS.DRAFT_PREFIX) || key === KEYS.DRAFT_LATEST) continue;
      const draft = this.readDraft(key);
      if (draft && draft.content.trim()) drafts.push({ key, ...draft });
    }
    return drafts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  },

  openDraft(key) {
    const draft = this.readDraft(key);
    if (!draft) return false;

    this.flushCurrent();
    this._loadSeq++;

    this.currentFile = {
      id: draft.fileId || null,
      name: draft.name || 'sem-titulo.md',
      draftKey: key,
      modifiedTime: draft.baseModifiedTime,
      parents: draft.parents,
    };
    this.setContent(draft.content);
    this.showEditor();
    // Draft exists precisely because it wasn't synced: flag as unsaved
    this.isDirty = true;
    this.updateFileNameDisplay();
    this.setSaveStatus('', 'Rascunho não sincronizado');
    this.syncHistory();
    return true;
  },

  renderDrafts() {
    const drafts = this.listDrafts();
    const container = document.getElementById('drafts-list');
    const ul = document.getElementById('drafts-ul');
    if (!container || !ul) return;

    container.classList.toggle('hidden', !drafts.length);
    ul.innerHTML = '';

    drafts.forEach(d => {
      const li = document.createElement('li');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'recent-name';
      nameSpan.textContent = d.name || 'sem-titulo.md';
      nameSpan.addEventListener('click', () => {
        this.beginNav();
        this.openDraft(d.key);
      });
      li.appendChild(nameSpan);

      const ago = this.timeAgo(d.timestamp);
      if (ago) {
        const timeSpan = document.createElement('span');
        timeSpan.className = 'recent-time';
        timeSpan.textContent = ago;
        li.appendChild(timeSpan);
      }

      const removeBtn = document.createElement('button');
      removeBtn.className = 'recent-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Descartar rascunho';
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const discard = await this.confirmDialog(
          'Descartar rascunho',
          `"${d.name}": o texto que não está no Drive será perdido.`,
          'Descartar'
        );
        if (!discard) return;
        localStorage.removeItem(d.key);
        this.renderDrafts();
      });
      li.appendChild(removeBtn);

      ul.appendChild(li);
    });
  },

  // ── Confirm dialog ──

  /** The app's own confirm(). Resolves to true on OK, false on cancel or "back". OK is red by default
      (delete, discard); `danger: false` is for a harmless yes, like signing in. */
  confirmDialog(title, text, okLabel, { danger = true } = {}) {
    const overlay = document.getElementById('confirm-overlay');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-text').textContent = text;
    const ok = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    ok.textContent = okLabel;
    ok.classList.toggle('btn-danger', danger);
    ok.classList.toggle('active', !danger);

    return new Promise((resolve) => {
      const close = (answer) => {
        overlay.classList.remove('visible');
        ok.onclick = cancel.onclick = null;
        this.armWatcher();
        resolve(answer);
      };
      ok.onclick = () => close(true);
      cancel.onclick = () => close(false);
      overlay.classList.add('visible');
      this.armWatcher();
    });
  },

  // ── Conflict with Drive ──

  showConflict(file) {
    this._conflictFile = file;
    this.els.conflictText.textContent =
      `"${file.name}" mudou no Drive depois que você abriu. Sua versão está guardada neste aparelho.`;
    this.els.conflict.classList.add('visible');
    this.armWatcher();
  },

  conflictCopyName(name) {
    const stamp = this.generateFileName().replace(/\.md$/, '');
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    return `${base} (conflito ${stamp})${ext}`;
  },

  async resolveConflict(action) {
    const file = this._conflictFile;
    this._conflictFile = null;
    this.els.conflict.classList.remove('visible');
    this.armWatcher();
    if (!file || this.currentFile !== file) return;

    if (action === 'later') {
      this.setSaveStatus('error', 'Conflito pendente: toque em salvar');
      return;
    }

    if (action === 'overwrite') {
      // Accept the Drive version as seen; if it changes yet again, the check fires again
      file.modifiedTime = file.remoteModifiedTime;
      file.conflict = false;
      this.isDirty = true;
      await this.save();
      return;
    }

    if (action === 'reload') {
      this.clearDraft(file);
      file.conflict = false;
      this.isDirty = false;
      // Straight from the Drive: the kept version is exactly what the conflict is about
      await this.openFile(file.id, file.name, { fresh: true });
      return;
    }

    if (action === 'copy') {
      const content = this.getContent();
      const copy = {
        id: null,
        name: this.conflictCopyName(file.name),
        draftKey: `${KEYS.DRAFT_PREFIX}new_${Date.now()}`,
        parents: file.parents,
      };
      this.setSaveStatus('saving', 'Salvando cópia...');
      try {
        await this.enqueue(() => this.createOnDrive(copy, content));
      } catch (e) {
        // Conflict stays pending and the draft stays in place
        console.error('Failed to save conflict copy:', e);
        this.setSaveStatus('error', 'Erro ao salvar cópia');
        return;
      }
      if (this.currentFile !== file) return;

      this.clearDraft(file);
      file.conflict = false;
      this.currentFile = copy;
      this.syncHistory();
      this.settleSaved(copy, content);
      this.setSaveStatus('saved', 'Cópia salva no Drive');
    }
  },
});
