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
      if (!meta.trashed) content = await this.driveGetFileContent(fileId);
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
    if (meta.trashed) {
      // In the Drive's bin (deleted on the PC, or by /ingest): an opening that failed
      if (this._opening === opening) this._opening = null;
      this.forgetNote(fileId);
      this.setSaveStatus('error', 'Esta nota foi apagada no Drive');
      return false;
    }
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
      leaves the kept version on screen, saying so. Gone from the Drive (in the bin, or a 404): nothing is
      kept, the note is let go on this device, and the text stays on screen to read; `file.gone` sends
      its first save straight to the dialog (showGone). */
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
      if (!meta.trashed && meta.modifiedTime !== kept.modifiedTime) content = await this.driveGetFileContent(file.id);
    } catch (e) {
      if (e?.status === 404) {
        meta = { trashed: true }; // deleted for good: the same as the bin, here
      } else {
        console.warn('Kept note not checked:', e);
        if (here()) this.setSaveStatus('error', 'Sem conexão: versão guardada');
        return;
      }
    }

    if (meta.trashed) {
      this.log(`checked ${kept.name} gone ${Date.now() - tapped}ms`);
      file.gone = true;
      this.forgetNote(file.id);
      if (here()) this.setSaveStatus('error', 'Esta nota foi apagada no Drive');
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

  /** Generate a timestamp-based filename like 2026-04-11-2143.md, from `now` in local time */
  generateFileName(now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.md`;
  },

  // The names given by freeNewName since the app opened, lowercased and without .md: a note just born may
  // be in neither the index nor the drafts yet (still empty, or its creation still on its way)
  _newNames: new Set(),

  /** `name` made free with -2, -3 before the extension, so two new notes in the same minute do not share
      a name. Synchronous, it runs inside the tap: it looks only at what is already in memory (the note
      index if loaded, the drafts, the new notes of this run). Case and .md do not count, as in takenNoteNames. */
  freeNewName(name) {
    const key = (n) => n.replace(/\.md$/i, '').toLowerCase();
    const taken = new Set([
      ...(this._noteIndex || []).map(note => key(note.name)),
      ...this.listDrafts().filter(d => d.name).map(d => key(d.name)),
      ...this._newNames,
    ]);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let free = name;
    for (let n = 2; taken.has(key(free)); n++) free = `${stem}-${n}${ext}`;
    this._newNames.add(key(free));
    return free;
  },

  /** A new note in the inbox, open in the editor at once. `body` is its starting text, `name` its file
      name (a timestamp, see generateFileName, when not given). */
  newFile({ body = '', name = this.generateFileName() } = {}) {
    name = this.freeNewName(name);
    // Whatever is open gets saved before it is replaced
    this.flushCurrent();
    this._loadSeq++; // a file still loading must not land on top of the new note
    this.beginNav();

    // The draft key is fixed for the life of the note, so the draft is still found
    // (and cleared) after the note gets its Drive ID
    const file = { id: null, name: name, draftKey: `${KEYS.DRAFT_PREFIX}new_${Date.now()}` };
    this.currentFile = file;
    this.syncHistory();
    this.setContent(body);
    this.showEditor();
    this.updateFileNameDisplay();
    this.focusEditor();
    this.caretToEnd(); // typing starts after what came in the body
    const born = this.getContent();

    // Create on Drive in background, not awaited, so the user can type immediately.
    // If it fails, the first save creates the file instead. Needs a login that renews without a window.
    if (this.canRenewQuietly()) {
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

  /** Save the open file. `manual` is a tap on save: the only thing that reopens a pending conflict dialog
      (or the one of a note gone from the Drive). */
  async save({ manual = false } = {}) {
    const file = this.currentFile;
    if (!file || !this.isDirty) return;
    clearTimeout(this.autoSaveTimer);

    if (file.conflict || file.gone) {
      // Never write over a Drive version the user hasn't ruled on; keep the text safe locally
      this.saveDraft();
      if (manual) {
        if (file.gone) this.showGone(file);
        else this.showConflict(file);
      }
      return;
    }

    // With a refresh token the login renews inside driveFetch. Without one, a tap is the only moment a
    // login popup is allowed to open, so an expired login is renewed here; automatic saves never try:
    // they fall back to the local draft (see saveSnapshot).
    if (manual && !this.canRenewQuietly()) {
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
    if (file.conflict || file.gone) return; // stays as a draft; the dialog comes back when it is reopened
    this.enqueue(() => this.saveSnapshot(file, content));
  },

  /** Write one snapshot of one file to Drive. The file may no longer be the open one,
      so the UI is only touched while it still is. Never throws: on failure the snapshot becomes a draft.
      Answers whether the text is ON DRIVE, which is not the same as the promise resolving: every failure
      here resolves too, having written a local draft instead. Whoever acts on the Drive afterwards
      (removeEmbedLine binning a picture) has to tell the two apart. */
  async saveSnapshot(file, content) {
    const isCurrent = () => this.currentFile === file;

    if (file.conflict || file.gone) {
      // Queued behind a save of the same file that hit a conflict, or found it gone from the Drive
      this.saveDraft(file, content);
      return false;
    }

    if (content === file.lastSavedContent) {
      this.settleSaved(file, content);
      return true;
    }

    if (!this.canRenewQuietly()) {
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

    // A 404 while writing an existing file means it is gone; on a create it is an ordinary error
    const updating = !!file.id;
    try {
      if (file.id) {
        // Someone else (the PC, another device) may have written the file since we opened it, or binned it
        const remote = await this.driveGetFileMeta(file.id, 'modifiedTime,trashed');
        if (remote.trashed) return this.fileGone(file, content);
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

        const result = await this.driveUpdateFile(file.id, content);
        file.modifiedTime = result.modifiedTime;
        // The device keeps what is now on the Drive: opening this note again needs no download
        this.NoteStore.put({ id: file.id, name: file.name, parents: file.parents, modifiedTime: file.modifiedTime, content });
      } else {
        await this.createOnDrive(file, content);
      }
      // Saved text is compared with the editor's, so it is recorded the way the editor has it
      file.lastSavedContent = content;
    } catch (e) {
      // Not a hiccup: trying again every 30 s would never reach a file that is not there
      if (updating && e?.status === 404) return this.fileGone(file, content);
      console.error('Drive save failed:', e);
      this.saveDraft(file, content);
      if (isCurrent()) {
        // A refresh token found dead on the way: the same message as a login expired without one
        this.setSaveStatus('error', e.code === 'login_needed' ? 'Login expirou: toque em salvar' : 'Erro: salvo local');
        // A Drive hiccup is tried again on its own; a dead login waits for a tap
        if (e.code !== 'login_needed') this.scheduleAutoSave();
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

  /** The file went to the Drive's bin, or is gone for good, under a save: nothing is written to it. The
      text stays as a draft and the person rules on it (showGone). Answers false, like any save that did
      not reach the Drive. */
  fileGone(file, content) {
    file.gone = true;
    this.saveDraft(file, content);
    if (this.currentFile === file) {
      this.setSaveStatus('error', 'Esta nota foi apagada no Drive');
      this.showGone(file);
    } else {
      this.setSaveStatus('error', 'Nota apagada no Drive: rascunho guardado');
    }
    return false;
  },

  /** A note gone from the Drive is let go on this device: the recents, the index of titles, the kept copy */
  forgetNote(fileId) {
    this.removeFromRecents(fileId);
    this.noteIndexRemove(fileId);
    this.NoteStore.remove(fileId);
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
    }
  },

  /** Create `file` on Drive and record its ID and version on the file object. The ID is asked for first
      and kept in file.pendingId (and in its draft) until the create is known to have landed: a create whose
      answer was lost, sent again with the same ID, gets a 409 and takes over the file the first one made. */
  async createOnDrive(file, content) {
    const folderId = file.parents?.[0] || CONFIG.DEFAULT_FOLDER_ID;
    if (!file.pendingId) {
      file.pendingId = await this.driveNewId();
      // Written before the create goes out: the app closed before its answer must try the same ID again
      const pending = this.readDraft(file.draftKey);
      if (pending) {
        pending.pendingId = file.pendingId;
        localStorage.setItem(file.draftKey, JSON.stringify(pending));
      }
    }

    let result;
    try {
      result = await this.driveCreateFile(file.name, content, folderId, file.pendingId);
    } catch (e) {
      if (e?.status !== 409) throw e;
      // An earlier try made the file with its own text: write today's over it, under the name it has now
      // (renameFile may have renamed the note on this device while the create was out)
      const made = await this.driveGetFileMeta(file.pendingId, 'id,name,parents,modifiedTime');
      result = { ...made, ...(await this.driveUpdateFile(made.id, content)) };
      if (made.name !== file.name) result = { ...result, ...(await this.driveRenameFile(made.id, file.name)) };
    }
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
      draft.pendingId = file.pendingId;
      localStorage.setItem(file.draftKey, JSON.stringify(draft));
    }

    this.saveToRecents(file.id, file.name);
    this.noteIndexAdd(file).catch((e) => console.warn('Note index not updated:', e));
    if (this.currentFile === file) this.syncHistory(); // the entry can now name the note by ID
  },

  // ── Where a folder sits ──

  /** The folder names below the root down to this folder ([] for the root itself), or null outside it.
      Walks up the Drive, one request per level, once per folder, until it reaches a folder already known
      (the root and the inbox are known from the start). */
  folderTrail(folderId) {
    if (!this._folderTrails.has(folderId)) {
      const trail = this.driveGetFileMeta(folderId, 'name,parents').then(async (folder) => {
        const parent = folder.parents?.[0];
        const above = parent ? await this.folderTrail(parent) : null; // top of the Drive: not in the root
        return above && [...above, folder.name];
      });
      this._folderTrails.set(folderId, trail);
      trail.catch(() => this._folderTrails.delete(folderId));
    }
    return this._folderTrails.get(folderId);
  },

  // ── Drafts (localStorage) ──
  // One draft per file, under file.draftKey. A draft means "text that is not on Drive yet".

  /** Answers whether the draft is stored. A full localStorage gives up the caches the Drive gives back (the
      note index, the tree listings; the copies in memory stay) and tries once more; failing again, the note
      on screen says so, since the text is then only in the editor. */
  saveDraft(file = this.currentFile, content = this.getContent()) {
    if (!file) return false;
    const draft = {
      name: file.name,
      content: content,
      // A draft that syncDrafts failed to send keeps its age: it is not newer for having been tried
      timestamp: file.draftTimestamp || Date.now(),
      fileId: file.id,
      // Drive version the text was based on, so the conflict check still works after a restart
      baseModifiedTime: file.modifiedTime,
      parents: file.parents,
      // The ID a create in flight was sent with (see createOnDrive)
      pendingId: file.pendingId,
    };
    // The Drive version moved on, or the note is gone: syncDrafts leaves it for her to rule on
    if (file.conflict || file.gone) draft.conflict = true;
    const json = JSON.stringify(draft);
    try {
      localStorage.setItem(file.draftKey, json);
      return true;
    } catch (e) {
      console.warn('Draft did not fit, dropping the caches:', e);
    }
    localStorage.removeItem(KEYS.NOTE_INDEX);
    localStorage.removeItem(KEYS.TREE_LISTINGS);
    try {
      localStorage.setItem(file.draftKey, json);
      return true;
    } catch (e) {
      console.error('Failed to save draft:', e);
    }
    this.log('draft not stored');
    if (this.currentFile === file) this.setSaveStatus('error', 'Sem espaço no aparelho: toque em salvar');
    return false;
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

  /** Drafts left behind (no network, a dead login, the app closed mid-save) go up on their own: at the
      opening, back on the home, when the network returns. Never opens a login window and never throws.
      Skips the note on screen and the drafts in conflict, which wait for her. Each draft is read again
      inside the queue: a save of its own note may have gone up and cleared it in the meantime. */
  async syncDrafts() {
    if (this._syncingDrafts || navigator.onLine === false || !this.canRenewQuietly()) return;
    this._syncingDrafts = true;
    try {
      const keys = this.listDrafts()
        .filter((d) => !d.conflict && d.key !== this.currentFile?.draftKey)
        .reverse() // oldest first
        .map((d) => d.key);
      await Promise.all(keys.map((key) => this.enqueue(async () => {
        if (key === this.currentFile?.draftKey) return; // opened while the queue was moving
        const draft = this.readDraft(key);
        if (!draft || draft.conflict || !draft.content.trim()) return;
        const file = {
          id: draft.fileId || null,
          name: draft.name || 'sem-titulo.md',
          draftKey: key,
          modifiedTime: draft.baseModifiedTime,
          parents: draft.parents,
          draftTimestamp: draft.timestamp,
          pendingId: draft.pendingId,
        };
        await this.saveSnapshot(file, draft.content);
      }).catch((e) => console.warn('Draft sync failed:', key, e))));
      if (document.body.dataset.view === 'welcome') this.renderDrafts();
    } catch (e) {
      console.warn('Draft sync stopped:', e);
    } finally {
      this._syncingDrafts = false;
    }
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
      pendingId: draft.pendingId,
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
    const count = document.getElementById('drafts-count');
    if (count) count.textContent = String(drafts.length);
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

      // A draft in conflict waits for her: that says more than its age
      const ago = d.conflict ? 'conflito' : this.timeAgo(d.timestamp);
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
    this.conflictMode('conflict');
    this.els.conflictText.textContent =
      `"${file.name}" mudou no Drive depois que você abriu. Sua versão está guardada neste aparelho.`;
    this.els.conflict.classList.add('visible');
    this.armWatcher();
  },

  /** The same dialog, for a note gone from the Drive: a new note, letting it go, or later */
  showGone(file) {
    this._conflictFile = file;
    this.conflictMode('gone');
    this.els.conflictText.textContent =
      `"${file.name}" foi apagada no Drive. Sua versão está guardada neste aparelho.`;
    this.els.conflict.classList.add('visible');
    this.armWatcher();
  },

  /** One overlay serves both cases, in the same session: `mode` swaps the labels that have a
      `data-gone` one (the original is kept the first time) and shows only the buttons of that mode. */
  conflictMode(mode) {
    const overlay = this.els.conflict;
    const gone = mode === 'gone';
    overlay.dataset.mode = mode;
    overlay.querySelectorAll('[data-gone]').forEach((el) => {
      if (!('label' in el.dataset)) el.dataset.label = el.textContent;
      el.textContent = gone ? el.dataset.gone : el.dataset.label;
    });
    const only = { overwrite: 'conflict', reload: 'conflict', discard: 'gone' };
    overlay.querySelectorAll('[data-conflict]').forEach((btn) => {
      const of = only[btn.dataset.conflict];
      btn.hidden = !!of && of !== mode;
    });
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
      this.setSaveStatus('error', file.gone ? 'Nota apagada no Drive: toque em salvar' : 'Conflito pendente: toque em salvar');
      return;
    }

    if (action === 'discard') {
      // Gone from the Drive, and her version let go too: nothing of the note stays, and the note is left
      // the way deleteFile leaves it
      clearTimeout(this.autoSaveTimer);
      this.clearDraft(file);
      this.forgetNote(file.id);
      this.isDirty = false;
      this.goBack('delete');
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
      // A note gone from the Drive comes back as a new note: its own name, in the inbox
      const gone = !!file.gone;
      const content = this.getContent();
      const copy = {
        id: null,
        name: gone ? file.name : this.conflictCopyName(file.name),
        draftKey: `${KEYS.DRAFT_PREFIX}new_${Date.now()}`,
        parents: gone ? [CONFIG.DEFAULT_FOLDER_ID] : file.parents,
      };
      this.setSaveStatus('saving', gone ? 'Salvando...' : 'Salvando cópia...');
      try {
        await this.enqueue(() => this.createOnDrive(copy, content));
      } catch (e) {
        // Conflict stays pending and the draft stays in place
        console.error('Failed to save conflict copy:', e);
        this.setSaveStatus('error', gone ? 'Erro: salvo local' : 'Erro ao salvar cópia');
        return;
      }
      if (this.currentFile !== file) return;

      this.clearDraft(file);
      if (gone) this.forgetNote(file.id);
      file.conflict = false;
      this.currentFile = copy;
      this.syncHistory();
      this.settleSaved(copy, content);
      this.setSaveStatus('saved', gone ? 'Salvo no Drive' : 'Cópia salva no Drive');
    }
  },
});
