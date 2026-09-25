// Drive Notes: rename, links to a note, delete, extract a stretch, and the modal. Extends App (see app/core.js).

Object.assign(App, {
  // ── Rename ──

  promptRename() {
    const file = this.currentFile;
    if (!file) return;
    this.showModal('Renomear nota', 'Nome do arquivo', (value) => this.renameFile(file, value), {
      value: file.name,
      confirmLabel: 'Renomear',
      onDelete: file.id ? () => this.promptDelete(file) : null,
    });
  },

  /** A name Drive, Windows and Obsidian all accept. The extension never changes: a rename is not a conversion. */
  cleanFileName(value, oldName) {
    const name = value.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
    if (!name) return '';
    const dot = oldName.lastIndexOf('.');
    const ext = dot > 0 ? oldName.slice(dot) : '.md';
    return name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext;
  },

  async renameFile(file, value) {
    const name = this.cleanFileName(value, file.name);
    if (!name || name === file.name) return;

    // A note that is already on Drive is only renamed there, never just locally
    if (file.id) {
      try {
        await this.ensureAuth();
      } catch {
        this.setSaveStatus('error', 'Faça login pra renomear');
        return;
      }
    }

    const oldName = file.name;
    const applyName = (n) => {
      file.name = n;
      const draft = this.readDraft(file.draftKey);
      if (draft) {
        draft.name = n;
        localStorage.setItem(file.draftKey, JSON.stringify(draft));
      }
      if (this.currentFile === file) {
        this.updateFileNameDisplay();
        this.syncHistory();
      }
    };

    // Applied right away, so a note whose creation is still queued is created with the new name
    applyName(name);

    try {
      await this.enqueue(async () => {
        if (!file.id) return; // not on Drive yet and nothing queued: the first save creates it with this name
        const before = await this.driveGetFileMeta(file.id, 'modifiedTime');
        const result = await this.driveRenameFile(file.id, name);
        // Our own rename moves modifiedTime. Adopt the new value only if nobody else wrote in between,
        // otherwise the next save must still see the conflict.
        if (before.modifiedTime === file.modifiedTime) file.modifiedTime = result.modifiedTime;
        this.saveToRecents(file.id, name);
        this.noteIndexRename(file.id, name);
      });
    } catch (e) {
      console.error('Rename failed:', e);
      applyName(oldName);
      if (this.currentFile === file) this.setSaveStatus('error', 'Erro ao renomear');
      return;
    }

    if (this.currentFile === file) this.setSaveStatus('saved', 'Renomeado');

    // The links in the other notes, only for a note the Drive already knew by the old name
    const links = file.id ? await this.relinkNotes(oldName, name, file.id) : { updated: 0, skipped: 0 };
    let summary = 'Renomeado';
    if (!links) {
      summary = 'Renomeado, não deu pra procurar os links';
    } else if (links.updated || links.skipped) {
      summary += `, ${links.updated} ${links.updated === 1 ? 'link atualizado' : 'links atualizados'}`;
      if (links.skipped) summary += `, ${links.skipped} ${links.skipped === 1 ? 'nota pulada' : 'notas puladas'}`;
    }
    if (this.currentFile === file) {
      this.setSaveStatus('saved', summary);
      setTimeout(() => {
        if (this.currentFile === file && this.els.saveStatus.textContent === summary) this.setSaveStatus('', '');
      }, summary === 'Renomeado' ? 2000 : 5000);
    }
  },

  // ── Links to a note ──

  /** Every form of a link to the note called `base` (the name without .md): [[base]], [[base|alias]],
      [[base#heading]], [[base#heading|alias]], ![[base]], with or without the .md inside. Case does not
      matter, as in the Obsidian. `[[base-bigger]]` and `[[folder/base]]` are other links and do not match.
      Group 1 is the opening `[[`, so that a replacement can keep it. */
  linkPattern(base) {
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(\\[\\[)${escaped}(?:\\.md)?(?=[\\]#|])`, 'gi');
  },

  /** The vault notes whose text links to the note called `name`, each with its text as downloaded and
      the modifiedTime read BEFORE the download (the conflict check of whoever writes it back).
      The Drive's full-text search brings every file with the word, in any form: only a real link counts. */
  async findLinkingNotes(name, { exceptId = null } = {}) {
    const base = name.replace(/\.md$/i, '');
    const pattern = this.linkPattern(base);
    const params = new URLSearchParams({
      q: `fullText contains ${this.driveQuote(base)} and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name,parents,mimeType,modifiedTime)',
      pageSize: '100',
    });
    const response = await this.driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    const candidates = ((await response.json()).files || []).filter(f => this.isNote(f) && f.id !== exceptId);
    const linking = [];
    for (const f of candidates) {
      const folder = f.parents?.[0];
      const trail = folder ? await Promise.resolve(this.folderTrail(folder)).catch(() => null) : null;
      if (!trail || trail.some(n => n.startsWith('.'))) continue;
      const content = await this.driveGetFileContent(f.id);
      pattern.lastIndex = 0;
      if (!pattern.test(content)) continue;
      linking.push({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, content });
    }
    return linking;
  },

  /** `text` with every link to `oldBase` pointing to `newBase`. A function replacement: `$` in the new name is a character, not a pattern */
  relinkText(text, oldBase, newBase) {
    return text.replace(this.linkPattern(oldBase), (match, open) => `${open}${newBase}`);
  },

  /** After a rename: rewrite the links in every note that pointed to the old name, one note at a time
      through the write queue, each with the save's own conflict check. The change is mechanical, so
      `updated` is left alone. A local draft of one of them gets the same rewrite, and its base moves
      to the new version, or saving it later would undo the fix or raise a false conflict.
      Never throws. Answers { updated, skipped }, or null when the search itself failed. */
  async relinkNotes(oldName, newName, exceptId) {
    let linking;
    try {
      linking = await this.findLinkingNotes(oldName, { exceptId });
    } catch (e) {
      console.error('Link search failed:', e);
      return null;
    }
    const oldBase = oldName.replace(/\.md$/i, '');
    const newBase = newName.replace(/\.md$/i, '');
    let updated = 0;
    let skipped = 0;
    for (const note of linking) {
      const text = this.relinkText(note.content, oldBase, newBase);
      try {
        const written = await this.enqueue(async () => {
          const remote = await this.driveGetFileMeta(note.id, 'modifiedTime');
          if (remote.modifiedTime !== note.modifiedTime) return null; // someone is writing in it: not ours to touch
          return this.driveUpdateFile(note.id, text);
        });
        if (!written) { skipped++; continue; }
        updated++;
        const draftKey = `${KEYS.DRAFT_PREFIX}${note.id}`;
        const draft = this.readDraft(draftKey);
        if (draft) {
          draft.content = this.relinkText(draft.content, oldBase, newBase);
          draft.baseModifiedTime = written.modifiedTime;
          localStorage.setItem(draftKey, JSON.stringify(draft));
        }
      } catch (e) {
        console.error('Relink failed:', note.name, e);
        skipped++;
      }
    }
    return { updated, skipped };
  },

  // ── Delete ──

  /** "Apagar" in the name dialog: confirm, then the note goes to the Drive's bin. The count of notes
      that link to it arrives while the dialog is open, and the dialog does not wait for it. */
  async promptDelete(file) {
    this.hideModal();
    const title = 'Apagar esta nota?';
    const base = 'Vai pra lixeira do Drive, de onde dá pra recuperar por 30 dias.';
    this.findLinkingNotes(file.name, { exceptId: file.id }).then((notes) => {
      const overlay = document.getElementById('confirm-overlay');
      if (!notes.length || !overlay.classList.contains('visible')) return;
      if (document.getElementById('confirm-title').textContent !== title) return;
      const count = notes.length === 1 ? '1 nota tem' : `${notes.length} notas têm`;
      document.getElementById('confirm-text').textContent = `${base} ${count} link pra esta; os links ficam.`;
    }).catch((e) => console.warn('Link count failed:', e));
    const remove = await this.confirmDialog(title, base, 'Apagar');
    if (!remove) return false;
    return this.deleteFile(file);
  },

  /** The note goes to the bin, after whatever the queue still holds for it (a save on its way would
      otherwise recreate it). Unsaved text in the editor is let go: deleting is the decision. */
  async deleteFile(file) {
    if (!file.id) return false;
    try {
      await this.ensureAuth();
    } catch {
      this.setSaveStatus('error', 'Faça login pra apagar');
      return false;
    }
    if (this.currentFile === file) {
      clearTimeout(this.autoSaveTimer);
      this.isDirty = false;
    }
    try {
      await this.enqueue(() => this.driveTrashFile(file.id));
    } catch (e) {
      console.error('Delete failed:', e);
      if (this.currentFile === file) this.setSaveStatus('error', 'Erro ao apagar');
      return false;
    }
    this.clearDraft(file);
    this.removeFromRecents(file.id);
    this.noteIndexRemove(file.id);
    this.NoteStore.remove(file.id);
    if (this.currentFile === file) {
      this.setSaveStatus('saved', 'Apagada');
      this.goBack('delete');
    }
    return true;
  },

  // ── Extract a stretch to a new note ──
  // Select a stretch, tap the button that only exists while there is a selection, confirm the name:
  // the stretch becomes a note of its own in the same folder, and a [[link]] takes its place. The
  // text is never in neither place: the new note is created first, and the stretch only leaves once
  // the Drive has it. See extrair-trecho-design in the vault.

  /** The editor says whether there is text selected in it, with the focus: the button shows while there is */
  onEditorSelection(hasText) {
    document.body.classList.toggle('has-selection', hasText);
  },

  /** The name a stretch suggests for its own note: its first line with text in it, in the vault's
      kebab-case (the same rule as the photos' names), made free against the vault with -2, -3. With
      nothing left of that line (only symbols), the dated name of a new note. Without .md. */
  async suggestNoteName(text) {
    const first = text.split('\n').find(line => line.trim()) || '';
    const base = this.slugForMedia(first) || this.generateFileName().replace(/\.md$/, '');
    const taken = await this.takenNoteNames();
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    return name;
  },

  /** The vault's note names, lowercased and without .md: what a new note must not repeat, because the
      app finds a note by its name and a repeated one would make the link ambiguous. Case does not
      count, as in the Obsidian's links. With no index to be had (no network, no login), an empty set:
      the name goes unchecked rather than the extraction being refused. */
  async takenNoteNames() {
    const notes = await this.noteIndex().catch(() => null);
    return new Set((notes || []).map(note => note.name.replace(/\.md$/i, '').toLowerCase()));
  },

  /** The toolbar's extract button. The stretch is taken right away, with its marks: the dialog is
      about to take the focus, and the selection would go with it. */
  async promptExtract() {
    const file = this.currentFile;
    const stretch = this.Editor.selectedStretch();
    if (!file || !stretch) return;
    const suggested = await this.suggestNoteName(stretch.text);
    // The index may have come from the Drive, and meanwhile another note may have been opened
    if (this.currentFile !== file) return;
    this.showModal('Nota nova com o trecho', 'Nome da nota', (value) => this.extractToNote(file, stretch, value), {
      value: suggested,
      validate: (value) => this.extractNameRefusal(value),
    });
  },

  /** Why `value` cannot name the new note, or '' when it can */
  async extractNameRefusal(value) {
    const name = this.cleanFileName(value, 'nota.md');
    if (!name) return 'Dê um nome pra nota';
    const taken = await this.takenNoteNames();
    return taken.has(name.replace(/\.md$/i, '').toLowerCase()) ? 'Já existe uma nota com esse nome' : '';
  },

  /** Create the new note, and only then take the stretch out of the note it came from. Until the Drive
      confirms, the text is still where it was. If anything moved meanwhile (the stretch was edited,
      another note was opened), the new note stays and so does the stretch: the text is in both, never
      in neither. */
  async extractToNote(file, stretch, value) {
    const name = this.cleanFileName(value, 'nota.md');
    if (!name) return;
    const isCurrent = () => this.currentFile === file;

    // The tap on Criar is what allows a login popup, so an expired login is renewed here
    try {
      await this.ensureAuth();
    } catch {
      if (isCurrent()) this.setSaveStatus('error', 'Faça login pra extrair');
      return;
    }

    // Born next to the note it came from. A note not yet on the Drive is being born in the default folder
    const note = {
      id: null,
      name,
      parents: [file.parents?.[0] || CONFIG.DEFAULT_FOLDER_ID],
      draftKey: `${KEYS.DRAFT_PREFIX}new_${Date.now()}`,
    };
    if (isCurrent()) this.setSaveStatus('saving', 'Criando nota...');
    try {
      // Through the write queue, behind whatever it holds (the original's own creation, if it is new).
      // The dates come the way of any save: created and updated only in a folder that keeps them.
      await this.enqueue(async () => this.createOnDrive(note, await this.withDates(note, stretch.text)));
    } catch (e) {
      console.error('Extract failed:', e);
      if (isCurrent()) this.setSaveStatus('error', 'Erro ao criar a nota, o trecho ficou');
      return;
    }

    // Only now does the stretch leave. The swap is an edit like any other: the editor reports it and
    // the note becomes unsaved, and the save below takes it to the Drive without waiting for the autosave
    const link = `[[${name.replace(/\.md$/i, '')}]]`;
    if (!isCurrent() || !this.Editor.replaceStretch(stretch, link)) {
      // On another note's screen this message would be about the wrong note
      if (isCurrent()) this.setSaveStatus('saved', 'Nota criada, o trecho ficou aqui também');
      return;
    }
    const onDrive = await this.save();
    // A save that did not reach the Drive (a conflict, a login gone) keeps its own message
    if (onDrive && isCurrent()) this.setSaveStatus('saved', 'Nota criada');
  },

  // ── Modal ──

  showModal(title, placeholder, onConfirm, { value = '', confirmLabel = 'Criar', onDelete = null, validate = null } = {}) {
    this.els.modal.querySelector('h3').textContent = title;
    this.els.modalInput.placeholder = placeholder;
    this.els.modalInput.value = value;
    this.els.modalConfirm.textContent = confirmLabel;
    this.els.modalMessage.hidden = true;
    this.els.modalMessage.textContent = '';
    // The delete button only exists for a note that is on the Drive; showModal is also the "new note" dialog
    this.els.modalDelete.hidden = !onDelete;
    this._modalDelete = onDelete;
    this.els.modal.classList.add('visible');
    this.els.modalInput.focus();
    // Ready to type over the name, keeping the extension
    const dot = value.lastIndexOf('.');
    if (dot > 0) this.els.modalInput.setSelectionRange(0, dot);
    this.armWatcher();

    // `validate` answers why the value cannot be used ('' when it can), and then the dialog stays open
    // saying so. Without it the dialog closes on confirm in the same instant, as it always has: the
    // await only happens when there is something to wait for.
    const confirm = async () => {
      const value = this.els.modalInput.value;
      const refusal = validate ? await validate(value) : '';
      // Closed, or opened again for something else, while the check was running: not ours any more.
      // It is also what makes a second tap on Criar do nothing.
      if (this._modalConfirm !== confirm) return;
      if (refusal) {
        this.els.modalMessage.textContent = refusal;
        this.els.modalMessage.hidden = false;
        return;
      }
      this.hideModal();
      onConfirm(value);
    };
    this._modalConfirm = confirm;
  },

  hideModal() {
    this.els.modal.classList.remove('visible');
    this._modalConfirm = null;
    this._modalDelete = null;
    this.armWatcher();
  },
});
