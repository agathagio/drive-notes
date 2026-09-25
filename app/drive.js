// Drive Notes: the Drive API, the note index and the notes kept on the device. Extends App (see app/core.js).

/**
 * A small IndexedDB store with one object store and one rule: it never throws. `open()` answers the
 * database, or null when there is none to be had (no IndexedDB, or it failed to open), opened once on
 * first use. `run(mode, fallback, work)` runs one transaction and answers `fallback` on any failure:
 * `work(store)` makes its requests and may answer a function, read once the transaction has completed,
 * or a request, whose result is then the answer. `warn(e)` is told once per session, so the panel
 * says the store is off and the app goes on without it.
 */
function makeStore({ name, store, upgrade, warn }) {
  let db = null;
  let warned = false;
  const tell = (e) => { if (warned) return; warned = true; warn(e); };
  return {
    open() {
      if (!db) {
        db = new Promise((resolve, reject) => {
          if (typeof indexedDB === 'undefined') return resolve(null);
          const request = indexedDB.open(name, 1);
          request.onupgradeneeded = () => upgrade(request.result);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error(`${name} blocked`));
        }).catch((e) => { tell(e); return null; });
      }
      return db;
    },
    async run(mode, fallback, work) {
      try {
        const opened = await this.open();
        if (!opened) return fallback;
        return await new Promise((resolve, reject) => {
          const tx = opened.transaction(store, mode);
          const answer = work(tx.objectStore(store));
          tx.oncomplete = () => resolve(typeof answer === 'function' ? answer()
            : answer && typeof answer === 'object' && 'result' in answer ? (answer.result ?? fallback) : fallback);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } catch (e) {
        tell(e);
        return fallback;
      }
    },
  };
}

Object.assign(App, {
  // ── Google Drive API ──

  /** fetch with the access token; on 401 re-authenticates and retries once */
  async driveFetch(url, options = {}, retried = false) {
    const response = await fetch(url, {
      ...options,
      headers: { ...options.headers, 'Authorization': `Bearer ${this.accessToken}` },
    });

    if (response.status === 401 && !retried) {
      await this.reAuth();
      return this.driveFetch(url, options, true);
    }

    if (!response.ok) {
      throw new Error(`Drive request failed: ${response.status}`);
    }

    return response;
  },

  /** Fetch file metadata by ID */
  async driveGetFileMeta(fileId, fields = 'id,name,modifiedTime,parents') {
    const response = await this.driveFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=${fields}`
    );
    return response.json();
  },

  /** Every file that matches `q`, across the whole Drive, page after page (1000 a page, 20 pages at most) */
  async driveListAll(q, fileFields) {
    const found = [];
    let pageToken = '';
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({
        q,
        fields: `nextPageToken, files(${fileFields})`,
        pageSize: '1000',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await this.driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`);
      const data = await response.json();
      found.push(...(data.files || []));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return found;
  },

  /** Folders and notes directly inside a folder: folders first, then by name the way a person sorts ("2" before "10") */
  async driveListFolder(folderId) {
    const FOLDER = 'application/vnd.google-apps.folder';
    const found = await this.driveListAll(`'${folderId}' in parents and trashed = false`, 'id,name,mimeType,modifiedTime');

    return found
      // Dot-folders (.obsidian, .trash) stay hidden, as in Obsidian
      .filter(f => !f.name.startsWith('.') && (f.mimeType === FOLDER || this.isNote(f)))
      .map(f => ({ id: f.id, name: f.name, isFolder: f.mimeType === FOLDER, modifiedTime: f.modifiedTime }))
      .sort((a, b) => (b.isFolder - a.isFolder)
        || a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' }));
  },

  isNote(f) {
    return /\.(md|markdown|txt)$/i.test(f.name) || (f.mimeType || '').startsWith('text/');
  },

  /** A string inside a Drive query */
  driveQuote(s) {
    return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  },

  /** Files with every word in the name or in the text, anywhere in Drive, in the Drive's own order of relevance.
      The name is matched on the start of a word and minds accents; the text is matched on whole words and
      does not, and it includes the name: between the two, "relat" and "relatorio" both find "Relatório". */
  async driveSearch(words) {
    const has = (w) => `(name contains ${this.driveQuote(w)} or fullText contains ${this.driveQuote(w)})`;
    const params = new URLSearchParams({
      q: `${words.map(has).join(' and ')} and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name,parents,mimeType,modifiedTime)',
      pageSize: '50',
    });
    const response = await this.driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    return (await response.json()).files || [];
  },

  /** Files with exactly one of these names, anywhere in Drive, newest first */
  async driveFindByName(names) {
    const q = `(${names.map(n => `name = ${this.driveQuote(n)}`).join(' or ')}) and trashed = false`;
    const params = new URLSearchParams({
      q,
      fields: 'files(id,name,parents,mimeType)',
      orderBy: 'modifiedTime desc',
      pageSize: '20',
    });
    const response = await this.driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    return (await response.json()).files || [];
  },

  /** ID of the vault's attachment folder, or null. Looked up once per device. */
  async getMediaFolderId() {
    const cached = localStorage.getItem(KEYS.MEDIA_FOLDER);
    if (cached) return cached;
    const folder = (await this.driveFindByName([CONFIG.MEDIA_FOLDER])).find(f =>
      f.mimeType === 'application/vnd.google-apps.folder' && f.parents?.includes(CONFIG.VAULT_FOLDER_ID));
    if (!folder) return null;
    localStorage.setItem(KEYS.MEDIA_FOLDER, folder.id);
    return folder.id;
  },

  /** Fetch file content by ID */
  async driveGetFileContent(fileId) {
    const response = await this.driveFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
    );
    // Not response.text(): it always reads UTF-8, and a voice recorder's transcript comes in UTF-16
    const bytes = await response.arrayBuffer();
    return this.decodeText(bytes);
  },

  /** The words of a file: UTF-8, unless a byte order mark says UTF-16. TextDecoder drops the mark.
      A copy of readText in sw.js (the two run apart and share no code): change both together. */
  decodeText(bytes) {
    const [a, b] = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
    const encoding = a === 0xff && b === 0xfe ? 'utf-16le' : a === 0xfe && b === 0xff ? 'utf-16be' : 'utf-8';
    return new TextDecoder(encoding).decode(bytes);
  },

  /** Rename a file. Resolves to { id, name, modifiedTime }. */
  async driveRenameFile(fileId, name) {
    const response = await this.driveFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,modifiedTime`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }
    );
    return response.json();
  },

  /** Send a file to the Drive's bin, where it can be fetched back for 30 days. Resolves to { id }. */
  async driveTrashFile(fileId) {
    const response = await this.driveFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      }
    );
    return response.json();
  },

  /** Update existing file content. Resolves to { id, modifiedTime }. */
  async driveUpdateFile(fileId, content) {
    const response = await this.driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,modifiedTime`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'text/plain' },
        body: content,
      }
    );
    return response.json();
  },

  /** Create a new file on Drive */
  async driveCreateFile(name, content, folderId) {
    const metadata = {
      name: name,
      mimeType: 'text/markdown',
    };
    if (folderId) {
      metadata.parents = [folderId];
    }

    // Multipart upload: metadata + content in one request
    const boundary = '---drivenotes' + Date.now();
    const body =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/markdown\r\n\r\n` +
      `${content}\r\n` +
      `--${boundary}--`;

    const response = await this.driveFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,parents,modifiedTime',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: body,
      }
    );
    return response.json();
  },

  /** Upload a binary file (a photo) into a folder. Resolves to { id, name }. */
  async driveUploadBlob(name, blob, folderId) {
    const boundary = '---drivenotes' + Date.now();
    const body = new Blob([
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify({ name, parents: [folderId] })}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);

    const response = await this.driveFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: body,
      }
    );
    return response.json();
  },

  // ── Note index ──
  // Every note of the vault, for the link list: [{ id, name, folder, where, modifiedTime }], `where`
  // being the folder trail as text ("onryo / personagens"), what the list shows under the name.
  // Built from two listings of the whole Drive (folders, then the note files) instead of walking
  // folder by folder, kept in localStorage, and refreshed in the background from the second session
  // on. The app keeps it in step with what it does itself (create, rename, delete) without waiting.

  _noteIndex: null,

  _noteIndexRefresh: null,

  /** The index, from the device when there is a copy (then a refresh runs by itself) or from the Drive */
  async noteIndex() {
    if (this._noteIndex) return this._noteIndex;
    const stored = this.readNoteIndex();
    if (stored) {
      this._noteIndex = stored.notes;
      this.refreshNoteIndex().catch((e) => console.warn('Note index refresh failed:', e));
      return this._noteIndex;
    }
    return this.refreshNoteIndex();
  },

  readNoteIndex() {
    try {
      const raw = localStorage.getItem(KEYS.NOTE_INDEX);
      const stored = raw ? JSON.parse(raw) : null;
      return Array.isArray(stored?.notes) ? stored : null;
    } catch {
      return null;
    }
  },

  writeNoteIndex() {
    if (!this._noteIndex) return;
    try {
      localStorage.setItem(KEYS.NOTE_INDEX, JSON.stringify({ builtAt: Date.now(), notes: this._noteIndex }));
    } catch (e) {
      console.warn('Note index not stored, kept in memory only:', e);
    }
  },

  /** Rebuild from the Drive. One rebuild at a time: a second call joins the one running. */
  refreshNoteIndex() {
    if (!this._noteIndexRefresh) {
      this._noteIndexRefresh = this.buildNoteIndex()
        .then((notes) => {
          this._noteIndex = notes;
          this.writeNoteIndex();
          return notes;
        })
        .finally(() => { this._noteIndexRefresh = null; });
    }
    return this._noteIndexRefresh;
  },

  /** Two listings of the whole Drive, then the tree: the folders under the vault (minus dot-folders), then the .md notes in them */
  async buildNoteIndex() {
    await this.ensureAuth();
    const FOLDER = 'application/vnd.google-apps.folder';
    const folders = await this.driveListAll(`mimeType = '${FOLDER}' and trashed = false`, 'id,name,parents');
    const byId = new Map(folders.map(f => [f.id, f]));
    // Trail of names from the vault root, or null outside it. Memoized: each folder is walked once.
    const trails = new Map([[CONFIG.VAULT_FOLDER_ID, []]]);
    const trailOf = (id, depth = 0) => {
      if (trails.has(id)) return trails.get(id);
      const folder = byId.get(id);
      let trail = null;
      if (folder && depth < 50 && !folder.name.startsWith('.')) {
        const above = trailOf(folder.parents?.[0], depth + 1);
        trail = above && [...above, folder.name];
      }
      trails.set(id, trail);
      return trail;
    };
    // Two types, and not text/markdown alone: the Drive does not type a .md consistently, and a note
    // the app itself uploads as text/markdown is stored as text/plain. The extension is what decides,
    // because text/plain also brings .txt, .log and the like.
    const files = await this.driveListAll(`(mimeType = 'text/markdown' or mimeType = 'text/plain') and trashed = false`, 'id,name,parents,modifiedTime');
    const notes = [];
    for (const f of files) {
      if (!/\.md$/i.test(f.name)) continue;
      const folder = f.parents?.[0];
      const trail = folder ? trailOf(folder) : null;
      if (!trail) continue;
      notes.push({ id: f.id, name: f.name, folder, where: trail.join(' / ') || CONFIG.VAULT_NAME, modifiedTime: f.modifiedTime });
    }
    return notes;
  },

  /** A note the app just created on the Drive. Outside the vault, or with the index not loaded yet, nothing to do. */
  async noteIndexAdd(file) {
    if (!this._noteIndex || !file?.id || !this.isNote(file)) return;
    const folder = file.parents?.[0];
    const trail = folder ? await Promise.resolve(this.folderTrail(folder)).catch(() => null) : null;
    if (!trail) return;
    this._noteIndex = this._noteIndex.filter(n => n.id !== file.id);
    this._noteIndex.push({ id: file.id, name: file.name, folder, where: trail.join(' / ') || CONFIG.VAULT_NAME, modifiedTime: file.modifiedTime });
    this.writeNoteIndex();
  },

  noteIndexRename(id, name) {
    const note = this._noteIndex?.find(n => n.id === id);
    if (!note) return;
    note.name = name;
    this.writeNoteIndex();
  },

  noteIndexRemove(id) {
    if (!this._noteIndex?.some(n => n.id === id)) return;
    this._noteIndex = this._noteIndex.filter(n => n.id !== id);
    this.writeNoteIndex();
  },

  /** The notes for the link list. `typed` is matched on the name without extension, minding neither
      accents nor case; names that start with it come first, then the ones that contain it, and inside
      each group the most recently edited first. Nothing typed: the recents that are in the index. */
  searchNoteIndex(typed, limit = 12) {
    const notes = this._noteIndex || [];
    const q = this.plain(typed).trim();
    if (!q) {
      return this.getRecents().map(r => notes.find(n => n.id === r.id)).filter(Boolean).slice(0, limit);
    }
    const ranked = [];
    for (const note of notes) {
      const title = this.plain(note.name.replace(/\.md$/i, ''));
      const rank = title.startsWith(q) ? 0 : title.includes(q) ? 1 : -1;
      if (rank >= 0) ranked.push({ note, rank });
    }
    ranked.sort((a, b) => a.rank - b.rank || (b.note.modifiedTime || '').localeCompare(a.note.modifiedTime || ''));
    return ranked.slice(0, limit).map(r => r.note);
  },

  // ── Notes kept on the device (IndexedDB) ──
  // The notes already opened, the way the Drive has them, so that opening one again shows it at once and
  // only asks the Drive whether it changed (see openKept). A cache and nothing more: the browser may clear
  // it whenever it is short of space, and nothing is lost, because the truth is on the Drive and text that
  // is not there yet lives in the drafts, in localStorage. A separate store on purpose: filling this one
  // can never make a draft fail to be written. Hence the one rule of this section: it never throws.
  // Without IndexedDB (a private tab, a browser that refuses it) or with it failing, get answers null,
  // put and remove do nothing, and the app takes the road it took before there was a store.

  NoteStore: Object.assign(makeStore({
    name: 'drivenotes',
    store: 'notes',
    upgrade: (db) => db.createObjectStore('notes', { keyPath: 'id' }).createIndex('openedAt', 'openedAt'),
    warn: (e) => {
      console.warn('Note store unavailable, notes come from the Drive only:', e);
      App.log(`note store off: ${e?.name || e}`);
    },
  }), {
    // The notes opened most recently; past this, the one opened longest ago goes
    LIMIT: 100,
    _lastStamp: 0,

    /** Strictly increasing, so that two notes kept in the same millisecond still have an order */
    stamp() {
      this._lastStamp = Math.max(Date.now(), this._lastStamp + 1);
      return this._lastStamp;
    },

    /** The kept entry, { id, name, parents, modifiedTime, content, openedAt }, or null */
    get(id) {
      if (!id) return Promise.resolve(null);
      return this.run('readonly', null, (store) => {
        const request = store.get(id);
        return () => request.result || null;
      });
    },

    /** Keep this as the note's latest, stamped as opened now, and let the oldest go past LIMIT.
        `content` and `modifiedTime` must be of the same moment: see checkKept. */
    put({ id, name, parents, modifiedTime, content }) {
      if (!id || typeof content !== 'string') return Promise.resolve();
      return this.run('readwrite', undefined, (store) => {
        store.put({ id, name, parents: parents || null, modifiedTime, content, openedAt: this.stamp() });
        const count = store.count();
        count.onsuccess = () => {
          let extra = count.result - this.LIMIT;
          if (extra <= 0) return;
          store.index('openedAt').openCursor().onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor || extra <= 0) return;
            extra--;
            cursor.delete();
            cursor.continue();
          };
        };
      });
    },

    remove(id) {
      if (!id) return Promise.resolve();
      return this.run('readwrite', undefined, (store) => { store.delete(id); });
    },
  }),
});
