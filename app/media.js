// Drive Notes: toolbar formatting, photos, and pictures while editing. Extends App (see app/core.js).

Object.assign(App, {
  // ── Toolbar formatting ──

  // `wrap` formats go around the selection; `line` formats toggle a marker at the start of every
  // selected line, wherever the cursor is in it.
  FORMATS: {
    bold: { wrap: ['**', '**'] },
    // An asterisk and not an underscore: it is what the app wrote before the editor was swapped,
    // and it is what is written in the notes that already exist
    italic: { wrap: ['*', '*'] },
    code: { wrap: ['`', '`'] },
    link: { wrap: ['[', '](url)'] },
    strikethrough: { wrap: ['~~', '~~'] },
    // Obsidian's highlight. The reader learns it in the markExtension at the end of this file
    highlight: { wrap: ['==', '=='] },
    // With nothing selected the link is born empty, caret in the middle, and the list opens on it:
    // "texto" as a placeholder would filter the list down to nothing
    wikilink: { wrap: ['[[', ']]'], placeholder: '' },
    tag: { wrap: ['#', ''] },
    heading: { line: '## ' },
    list: { line: '- ' },
    ordered: { line: '1. ' },
    quote: { line: '> ' },
    checklist: { line: '- [ ] ' },
  },

  applyFormat(name) {
    if (!this.FORMATS[name]) return;
    this.Editor.format(name);
    if (name === 'wikilink') this.Editor.openLinkList();
    // For the fallback textarea, and only for it. It writes into ta.value, which fires no input
    // event, so this line is what gets the note saved there. In the CodeMirror the updateListener
    // already calls the change handler on every docChanged, and this is a second, harmless call.
    this.markDirty();
  },

  /** The smallest edit that puts `prefix` at the start of the line, replacing any other block marker,
      or takes it off when it is already there: `{ from, to, insert }`, in columns of the line.
      The editor needs the change this narrow to keep the caret where the writing was; whoever only
      wants the line's new text goes through toggleLinePrefix. */
  linePrefixChange(line, prefix) {
    const kindOf = (marker) => {
      if (marker.startsWith('#')) return 'heading';
      if (marker.startsWith('>')) return 'quote';
      if (marker.includes('[')) return 'checklist';
      if (/^[-*+]/.test(marker)) return 'list';
      return marker ? 'ordered' : '';
    };
    const [, indent, marker = ''] =
      /^(\s*)((?:#{1,6}|[0-9]{1,9}[).]|>|[-*+](?: \[[ xX]\])?)\s+)?(.*)$/.exec(line);
    return {
      from: indent.length,
      to: indent.length + marker.length,
      insert: kindOf(marker) === kindOf(prefix) ? '' : prefix,
    };
  },

  /** Put `prefix` at the start of the line, replacing any other block marker; take it off if it is already there */
  toggleLinePrefix(line, prefix) {
    const { from, to, insert } = this.linePrefixChange(line, prefix);
    return line.slice(0, from) + insert + line.slice(to);
  },

  // ── Photo into the note ──

  /** Tap on a photo button: `source` is 'camera' or 'gallery'. The picker takes the focus away,
      so the cursor position is kept for later. */
  pickPhoto(source) {
    if (this.mode !== 'edit') return;
    this._photoAt = this.Editor.markCaret();
    const camera = source === 'camera';
    // With "capture" Android goes straight to the camera; without it, to the photo picker
    if (camera) this.els.photoInput.setAttribute('capture', 'environment');
    else this.els.photoInput.removeAttribute('capture');
    // The camera takes one shot at a time; from the gallery several photos can come at once
    this.els.photoInput.toggleAttribute('multiple', !camera);
    this.els.photoInput.value = '';
    this.els.photoInput.click();
  },

  /** Everything that was picked, one upload at a time and in the order it was picked: in parallel the
      embeds would land out of order, and the phone's upload is slow enough to jam. A failure stops the
      queue and keeps whatever already went into the note. */
  async insertPhotos(picked) {
    // Names are only unique to the second, and a batch goes up inside one: this keeps them apart
    const taken = new Set();
    for (let i = 0; i < picked.length; i++) {
      const status = picked.length > 1 ? `Enviando foto ${i + 1} de ${picked.length}...` : 'Enviando foto...';
      if (!await this.insertPhoto(picked[i], taken, status)) return i;
    }
    return picked.length;
  },

  /** Shrink, upload to the vault's attachment folder, and only then write ![[name]] into the note:
      a failed upload leaves no broken embed behind. Answers whether the queue can carry on. */
  async insertPhoto(picked, taken, status = 'Enviando foto...') {
    const file = this.currentFile;
    this.setSaveStatus('saving', status);

    let name;
    try {
      await this.ensureAuth();
      const folderId = await this.getMediaFolderId();
      if (!folderId) {
        this.setSaveStatus('error', `Pasta ${CONFIG.MEDIA_FOLDER} não encontrada no vault`);
        return false;
      }
      const photo = await this.shrinkPhoto(picked);
      name = await this.freeMediaName(this.mediaName(photo, picked.name, 'foto', taken), folderId, taken);
      await this.driveUploadBlob(name, photo, folderId);
      // The reading view shows it straight from here, without asking Drive for it back
      this._embedUrls.set(name, Promise.resolve(URL.createObjectURL(photo)));
    } catch (e) {
      console.error('Photo upload failed:', e);
      this.log(`photo failed: ${e?.name || 'Error'} ${String(e?.message ?? e).slice(0, 80)}`);
      // In case it was the remembered folder that went away: look it up again next time
      localStorage.removeItem('drivenotes_media_folder');
      this.setSaveStatus('error', 'Erro ao enviar a foto');
      return false;
    }

    if (this.currentFile !== file) {
      this.setSaveStatus('error', `Foto salva, mas a nota mudou: ${name}`);
      return false;
    }
    // Back from the picker the editor may have no cursor, and every photo of a batch would fall back
    // on the same spot, the last one on top: the next one goes below the one just inserted
    this._photoAt = this.insertOnOwnLine(`![[${name}]]`, this._photoAt) || this._photoAt;
    this.markDirty();
    this.setSaveStatus('saved', 'Foto inserida');
    return true;
  },

  PHOTO_MAX_SIDE: 2000,

  /** Phone photos are 4 to 8 MB and everything in the vault syncs to the computer: anything larger than
      PHOTO_MAX_SIDE is scaled down. What the browser cannot decode or redraw goes up as it is. */
  async shrinkPhoto(file) {
    // Not GIF (would lose the animation) nor SVG (no pixels to scale)
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap !== 'function') return file;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = this.PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height);
      if (scale >= 1) return file;

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      // PNG stays PNG (screenshots, transparency); the rest becomes JPEG
      const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const blob = await new Promise(resolve => canvas.toBlob(resolve, type, 0.85));
      return blob && blob.size < file.size ? blob : file;
    } catch (e) {
      console.warn('Photo not resized:', e);
      this.log(`photo not resized: ${e?.name || 'Error'} ${String(e?.message ?? e).slice(0, 80)}`);
      return file;
    }
  },

  /** The vault's kebab-case for a note name: lowercase, no accents, anything that is not a letter or a
      digit becomes a single hyphen, no hyphen at either end, 40 characters at most. Answers '' when
      nothing is left of the name, and whoever asked falls back to the dated shape. */
  slugForMedia(name) {
    return String(name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '');
  },

  /** voz-blue-foto-153012.jpg, voz-blue-desenho-153012.png: the open note's name, what kind of picture it
      is, and the time of day. Naming it after the note is what tells one photo from another inside the
      attachment folder, and it is also why the date is no longer in there: the two together make a name
      too long to read on a phone. With no note open (or with a name that leaves no slug behind) it falls
      back to the old dated shape, foto-2026-09-19-153012.jpg, which stands on its own.

      Several photos picked at once go up inside the same second, so `taken` collects the names already
      given and the repeats become -2, -3. Alone, the name keeps its plain shape. Without the date, the
      same second comes back every day: what goes up is not this name, but what freeMediaName makes of it. */
  mediaName(blob, originalName, prefix, taken) {
    const two = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const time = `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
    const date = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
    const fromType = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[blob.type];
    const ext = fromType || (/\.([a-z0-9]+)$/i.exec(originalName || '')?.[1] || 'jpg').toLowerCase();
    const slug = this.slugForMedia(this.currentFile?.name?.replace(/\.md$/i, ''));
    const base = slug ? `${slug}-${prefix}-${time}` : `${prefix}-${date}-${time}`;
    let name = `${base}.${ext}`;
    if (!taken) return name;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}.${ext}`;
    taken.add(name);
    return name;
  },

  /** The same name, or the first -2, -3 after it that no file of the attachment folder is already using.
      Named after the note and the time of day, a picture carries no date, so the same note photographed at
      the same second on another day would hand the new `![[...]]` the older picture. One lookup settles
      that, and in practice it is the only one.

      A lookup that fails (no network, Drive down) gives the name back as it came: a repeated name is a
      nuisance, a photo that does not go up is a loss. `taken` is the batch's own list of names, read here
      as well so that the second photo of a batch spends no lookup on what the first one already took. */
  async freeMediaName(name, folderId, taken) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    let n = 2;
    for (let tries = 0; tries < 20; tries++) {
      let busy;
      try {
        busy = (await this.driveFindByName([candidate])).some(f => f.parents?.includes(folderId));
      } catch (e) {
        console.warn('Media name not checked against Drive:', e);
        return candidate;
      }
      if (!busy) return candidate;
      do { candidate = `${base}-${n}${ext}`; n++; } while (taken?.has(candidate));
      taken?.add(candidate);
    }
    return candidate;
  },

  /** Insert `text` as a line of its own: at the mark (`at`) taken before the editor lost the focus,
      else at the cursor, else at the end. The mark wins over the live cursor on purpose (49e65a4):
      the picture lands where the writing was when the camera was tapped, however much the note
      changed while it was uploading. The cursor ends on a fresh line below; with the editor,
      answers where that is. */
  insertOnOwnLine(text, at) {
    return this.Editor.insertOnOwnLine(text, at);
  },

  // ── Pictures while editing ──
  // A line that is nothing but ![[image]] shows the picture right under it, so a note can be written
  // while looking at what it talks about. The picture is a background of the line plus bottom padding:
  // the text stays raw markdown and the editor, which draws a line from its text, never meets an <img>.

  EMBED_LINE: /^\s*!\[\[([^\]\n|#]+\.(?:png|jpe?g|gif|webp|bmp|avif|svg))(?:\|[^\]\n]*)?\]\]\s*$/i,

  EMBED_MAX_HEIGHT: 300,

  scheduleEmbedDecoration() {
    clearTimeout(this._embedTimer);
    this._embedTimer = setTimeout(() => this.decorateEditorEmbeds(), 120);
  },

  /** The picture of a line that is nothing but ![[image]], if its size has already arrived from the
      Drive. Answers null and fires the lookup when it has not arrived yet. */
  embedForLine(line) {
    const name = this.EMBED_LINE.exec(line)?.[1].split('/').pop().trim();
    if (!name) return null;
    const info = this._embedInfo.get(name);
    if (!info) {
      if (!this._embedInfo.has(name)) this.loadEmbedInfo(name);
      return null;
    }
    return info;
  },

  decorateEditorEmbeds() {
    if (this.mode !== 'edit') return;
    const changed = this.Editor.decorateEmbeds((line) => this.embedForLine(line));
    // Lines got taller or shorter: the one being typed must stay above the keyboard
    if (changed) this.scrollCaretIntoView();
  },

  async loadEmbedInfo(name) {
    this._embedInfo.set(name, null);
    if (!this._embedUrls.has(name)) {
      this._embedUrls.set(name, this.fetchEmbed(name).catch(() => null));
    }
    const url = await this._embedUrls.get(name);
    if (!url) {
      this._embedUrls.delete(name);
      return;
    }
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      return;
    }
    if (!img.naturalWidth || !img.naturalHeight) return;
    this._embedInfo.set(name, { url, width: img.naturalWidth, height: img.naturalHeight });
    this.decorateEditorEmbeds();
  },

  /** A tap on the picture of line `lineNumber`, which is a line that is nothing but `![[picture]]`: ask,
      and on a yes take the line out of the note and send the file to the Drive's bin. Answers whether the
      whole thing went through.

      The order is what keeps the text safe. The line leaves the note first and the file is binned last,
      and only once the note is known to be ON DRIVE: binning first would leave the note pointing at a
      picture that is no longer there, and binning after a save that only became a local draft would do
      the same to whatever device reads the note next. A bin that fails is the harmless half: the note is
      already right, and the status line says the rest out loud.

      It does not look for the same picture in other notes: a picture in the bin comes back with a tap
      for thirty days, and a search of the whole vault on every deletion is not worth that. */
  async removeEmbedLine(lineNumber) {
    const text = this.Editor.lineText(lineNumber);
    const name = text && this.EMBED_LINE.exec(text)?.[1].split('/').pop().trim();
    if (!name) return false;

    const remove = await this.confirmDialog(
      'Apagar esta foto?',
      'Sai da nota e vai pra lixeira do Drive, de onde dá pra recuperar por 30 dias.',
      'Apagar'
    );
    if (!remove) return false;
    // The note may have moved on while the dialog was open
    if (this.Editor.lineText(lineNumber) !== text) return false;
    if (!this.Editor.removeLine(lineNumber)) return false;

    // Both caches remember a picture by its name. Left behind, the next picture to go up under the
    // same name would be drawn with this one's image and measurements.
    this._embedUrls.delete(name);
    this._embedInfo.delete(name);

    if (!await this.save({ manual: true })) return false; // the save's own status already says why

    try {
      const file = await this.findEmbedFile(name);
      if (!file) throw new Error(`no Drive file named ${name}`);
      await this.driveTrashFile(file.id);
    } catch (e) {
      console.error('Photo not moved to the bin:', e);
      this.setSaveStatus('error', 'A foto saiu da nota, mas não foi pra lixeira');
      return false;
    }
    this.setSaveStatus('saved', 'Foto apagada');
    return true;
  },
});
