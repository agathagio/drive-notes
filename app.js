// Drive Notes — Main application logic
// =====================================================
// CONFIG: Replace these with your Google Cloud project values
// =====================================================
const CONFIG = {
  CLIENT_ID: '104411957628-eu5gbpopvot1ai5a95qbpdn3frcvko4r.apps.googleusercontent.com',
  // Folder where new notes are created (the vault inbox on Google Drive)
  DEFAULT_FOLDER_ID: '1xONP1bGB7qqNDQ1XNQRSk8rqWKoqCuuV',
  // Root of the file browser
  VAULT_FOLDER_ID: '1xJYm3FFeafY1IAcvAHuQ5BaMX7KxRM-K',
  VAULT_NAME: 'vault',
};

const SCOPES = 'https://www.googleapis.com/auth/drive';

// =====================================================

const App = {
  // State
  editor: null,
  // { id, name, draftKey, modifiedTime, parents, lastSavedContent }
  // id is the Drive file ID (null until created); modifiedTime is the Drive version our edits are based on
  currentFile: null,
  isDirty: false,
  mode: 'edit',
  autoSaveTimer: null,
  accessToken: null,
  tokenClient: null,
  // All Drive writes run through this chain, one at a time, so a create and a save
  // (or two saves) of the same file can never race and duplicate or reorder content
  _saveChain: Promise.resolve(),
  // Bumped on every file open; a slow load that lost the race is discarded
  _loadSeq: 0,
  // Folder on screen in the file browser: { id, name, path }, or null
  folder: null,
  // Folder listings seen in this session, by folder ID
  _folderCache: new Map(),
  // "Back" without the history stack (see Navigation): views left behind, and the active CloseWatcher
  useWatcher: false,
  navStack: [],
  _watcher: null,
  // Recent navigation events, for the hidden diagnostics panel
  _log: [],

  // DOM refs
  els: {},

  init() {
    this.els = {
      fileName: document.getElementById('file-name'),
      saveStatus: document.getElementById('save-status'),
      btnBack: document.getElementById('btn-back'),
      btnNew: document.getElementById('btn-new'),
      btnOpen: document.getElementById('btn-open'),
      btnSave: document.getElementById('btn-save'),
      btnPreview: document.getElementById('btn-preview'),
      editorContainer: document.getElementById('editor-container'),
      editorElement: document.getElementById('editor'),
      previewContainer: document.getElementById('preview-container'),
      welcome: document.getElementById('welcome'),
      modal: document.getElementById('modal-overlay'),
      modalInput: document.getElementById('modal-input'),
      modalCancel: document.getElementById('modal-cancel'),
      modalConfirm: document.getElementById('modal-confirm'),
      conflict: document.getElementById('conflict-overlay'),
      conflictText: document.getElementById('conflict-text'),
      browser: document.getElementById('browser'),
    };

    // Pointer used by older versions; drafts are now found by scanning their keys
    localStorage.removeItem('drivenotes_draft_latest');

    this.useWatcher = typeof CloseWatcher !== 'undefined';
    this.log('init');
    // The saved login does not depend on Google's script having loaded
    this.restoreToken();

    this.initEditor();
    this.bindEvents();
    this.initToolbarKeyboardHandler();
    this.showWelcome();
    this.syncHistory();
    this.renderDrafts();
    this.renderRecents();
  },

  // ── Editor ──

  initEditor() {
    try {
      this.editor = new TinyMDE.Editor({
        element: this.els.editorElement,
      });

      this.editor.addEventListener('change', () => {
        this.markDirty();
      });
      this.guardComposition();
    } catch (e) {
      console.warn('TinyMDE failed to load, using fallback textarea:', e);
      this.useFallbackEditor();
    }
  },

  /** TinyMDE redraws the line and resets the caret on every input event. While the keyboard is
      composing (voice typing, swipe, word suggestions) that throws away the region the keyboard is
      working on, and each partial result lands as new text: "NãoNão consigoNão consigo ditar".
      So composition updates are kept from TinyMDE, and it gets one input event when the composition ends. */
  guardComposition() {
    const editable = this.editor.e;
    if (!editable) return;

    editable.addEventListener('input', (e) => {
      if (e.isComposing && /CompositionText$/.test(e.inputType || '')) {
        e.stopImmediatePropagation();
        this._composed = true;
        this.markDirty(); // TinyMDE's change event is on hold with the rest
      }
    }, true);

    editable.addEventListener('compositionend', () => {
      if (!this._composed) return;
      this._composed = false;
      editable.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }));
    });
  },

  useFallbackEditor() {
    const textarea = document.createElement('textarea');
    textarea.className = 'editor-fallback';
    textarea.placeholder = 'Comece a escrever...';
    this.els.editorElement.replaceWith(textarea);
    this.els.editorElement = textarea;
    this.editor = null;

    textarea.addEventListener('input', () => {
      this.markDirty();
    });
  },

  getContent() {
    if (this.editor) {
      return this.editor.getContent();
    }
    return this.els.editorElement.value || '';
  },

  setContent(text) {
    if (this.editor) {
      this.editor.setContent(text);
    } else {
      this.els.editorElement.value = text;
    }
    this.isDirty = false;
    this.updateFileNameDisplay();
  },

  // ── Google Auth ──

  onGisLoaded() {
    this.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: SCOPES,
      callback: '', // set dynamically
      // Popup blocked or closed: fail the pending request instead of leaving it hanging
      error_callback: (err) => {
        if (this._authReject) this._authReject(err);
      },
    });
  },

  /** Save token + expiry to localStorage (persists across PWA restarts) */
  saveToken(accessToken, expiresIn) {
    this.accessToken = accessToken;
    const expiresAt = Date.now() + (expiresIn || 3600) * 1000;
    localStorage.setItem('drivenotes_token', accessToken);
    localStorage.setItem('drivenotes_token_expires', expiresAt.toString());

    // Schedule silent refresh 5 minutes before expiry
    this.scheduleTokenRefresh(expiresAt);
    this.rememberLoginHint();
  },

  /** Learn the account email once, so later logins skip the account chooser.
      Kept in localStorage only: the repo is public, so it must not live in CONFIG. */
  async rememberLoginHint() {
    if (localStorage.getItem('drivenotes_login_hint')) return;
    try {
      const response = await fetch(
        'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
        { headers: { 'Authorization': `Bearer ${this.accessToken}` } }
      );
      if (!response.ok) return;
      const email = (await response.json()).user?.emailAddress;
      if (email) localStorage.setItem('drivenotes_login_hint', email);
    } catch {
      // ignore: the hint is a convenience
    }
  },

  /** Options for tokenClient.requestAccessToken */
  tokenRequest(prompt) {
    const hint = localStorage.getItem('drivenotes_login_hint');
    return hint ? { prompt, login_hint: hint } : { prompt };
  },

  /** Restore token from localStorage if still valid. Falls back to legacy sessionStorage. */
  restoreToken() {
    const token = localStorage.getItem('drivenotes_token')
      || sessionStorage.getItem('drivenotes_token');
    const expiresAt = parseInt(
      localStorage.getItem('drivenotes_token_expires')
      || sessionStorage.getItem('drivenotes_token_expires')
      || '0'
    );

    if (token && expiresAt > Date.now() + 60000) {
      // Token exists and has more than 1 minute left
      this.accessToken = token;
      this.scheduleTokenRefresh(expiresAt);
      console.log('Drive Notes: token restored, expires in', Math.round((expiresAt - Date.now()) / 60000), 'min');
    }
  },

  /** Schedule silent token refresh before expiry */
  scheduleTokenRefresh(expiresAt) {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);

    // Refresh 5 minutes before expiry
    const refreshIn = expiresAt - Date.now() - 5 * 60 * 1000;
    if (refreshIn <= 0) return;

    this._refreshTimer = setTimeout(() => {
      this.silentRefresh();
    }, refreshIn);
  },

  /** Silently refresh the token without user interaction */
  silentRefresh() {
    if (!this.tokenClient) return;

    this.tokenClient.callback = (response) => {
      if (response.error) {
        console.warn('Silent refresh failed:', response.error);
        this.accessToken = null;
        localStorage.removeItem('drivenotes_token');
        localStorage.removeItem('drivenotes_token_expires');
        sessionStorage.removeItem('drivenotes_token');
        sessionStorage.removeItem('drivenotes_token_expires');
        return;
      }
      this.saveToken(response.access_token, response.expires_in);
      console.log('Drive Notes: token refreshed silently');
    };
    this.tokenClient.requestAccessToken(this.tokenRequest(''));
  },

  /** Ensure we have a valid access token. Returns a promise. */
  /** True while the token in hand has more than a minute left */
  hasValidToken() {
    const expiresAt = parseInt(
      localStorage.getItem('drivenotes_token_expires')
      || sessionStorage.getItem('drivenotes_token_expires')
      || '0'
    );
    return !!this.accessToken && expiresAt > Date.now() + 60000;
  },

  async ensureAuth() {
    if (this.hasValidToken()) {
      return this.accessToken;
    }

    // Token missing or expiring: request a new one
    this.accessToken = null;
    return this.requestToken('');
  },

  /** Ask Google for a token. Always settles: a blocked popup, an error or 3 minutes of silence reject,
      so a save waiting on it falls back to the local draft instead of hanging. */
  requestToken(prompt) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('auth timeout')), 180000);
      this._authReject = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      this.tokenClient.callback = (response) => {
        clearTimeout(timer);
        if (response.error) {
          reject(response);
          return;
        }
        this.saveToken(response.access_token, response.expires_in);
        resolve(this.accessToken);
      };
      this.tokenClient.requestAccessToken(this.tokenRequest(prompt));
    });
  },

  /** Re-authenticate (e.g. after token expiry / 401) */
  async reAuth() {
    this.accessToken = null;
    localStorage.removeItem('drivenotes_token');
    localStorage.removeItem('drivenotes_token_expires');
    sessionStorage.removeItem('drivenotes_token');
    sessionStorage.removeItem('drivenotes_token_expires');

    // No forced consent screen: with the login hint this is a popup that closes by itself
    return this.requestToken('');
  },

  // ── File browser ──
  // Replaces the Google Picker: a plain list, folders first, sorted by name like Obsidian's file tree.

  /** Tap on "open": start at the vault root */
  async browseVault() {
    this.beginNav();
    const opened = await this.openFolder({ id: CONFIG.VAULT_FOLDER_ID, name: CONFIG.VAULT_NAME, path: [] });
    if (!opened) this.cancelNav();
  },

  /** Show a folder. `folder` is { id, name, path }, path being the names of the folders above it.
      Resolves to false only when the view never changed (no login). */
  async openFolder(folder) {
    try {
      await this.ensureAuth();
    } catch {
      this.setSaveStatus('error', 'Faça login primeiro');
      return false;
    }

    // Whatever is open gets saved before it is replaced
    this.flushCurrent();
    const seq = ++this._loadSeq;
    this.currentFile = null;
    this.isDirty = false;
    this.folder = folder;
    this.updateFileNameDisplay();
    this.setSaveStatus('', '');
    this.showBrowser();
    this.syncHistory();

    // What we saw last time shows at once; the fresh listing replaces it when it arrives
    const cached = this._folderCache.get(folder.id);
    this.renderBrowser(folder, cached, cached ? '' : 'Carregando...');

    try {
      const items = await this.driveListFolder(folder.id);
      this._folderCache.set(folder.id, items);
      if (seq === this._loadSeq) this.renderBrowser(folder, items, items.length ? '' : 'Pasta vazia');
    } catch (e) {
      console.error('Failed to list folder:', e);
      if (seq === this._loadSeq && !cached) this.renderBrowser(folder, null, 'Erro ao carregar a pasta');
    }
    return true;
  },

  renderBrowser(folder, items, message) {
    const pathEl = document.getElementById('browser-path');
    const list = document.getElementById('browser-list');
    // The element is right-to-left so a long path is cut at the start; the marks keep the text itself left-to-right
    pathEl.textContent = `‎${[...folder.path, folder.name].join(' / ')}‎`;
    list.innerHTML = '';

    (items || []).forEach(item => {
      const li = document.createElement('li');
      li.className = 'browser-item' + (item.isFolder ? ' is-folder' : '');

      const icon = document.createElement('span');
      icon.className = 'browser-icon';
      icon.textContent = item.isFolder ? '\u{1F4C1}' : '';
      li.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'browser-name';
      name.textContent = item.isFolder ? item.name : item.name.replace(/\.md$/i, '');
      li.appendChild(name);

      if (!item.isFolder) {
        const when = document.createElement('span');
        when.className = 'browser-meta';
        when.textContent = this.shortDate(item.modifiedTime);
        li.appendChild(when);
      }

      li.addEventListener('click', () => {
        if (item.isFolder) {
          this.beginNav();
          this.openFolder({ id: item.id, name: item.name, path: [...folder.path, folder.name] });
        } else {
          this.navigateTo(item.id, item.name);
        }
      });
      list.appendChild(li);
    });

    if (message) {
      const li = document.createElement('li');
      li.className = 'browser-message';
      li.textContent = message;
      list.appendChild(li);
    }
  },

  /** "14:32" for today, "19 set" for this year, "19/09/25" before that */
  shortDate(iso) {
    const date = new Date(iso);
    if (!iso || isNaN(date)) return '';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    if (date.getFullYear() === now.getFullYear()) return `${date.getDate()} ${months[date.getMonth()]}`;
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear()).slice(2)}`;
  },


  /** Open a Drive file, in the reading view. Shared by the Picker, the recents list, links and "back".
      `heading` scrolls to a title once open. Callers reacting to a tap call beginNav() first. */
  async openFile(fileId, fileName, { heading = '' } = {}) {
    try {
      return await this.loadFile(fileId, fileName, heading);
    } finally {
      // Whatever ended up on screen: the note, its draft, or the previous view if loading failed
      this.syncHistory();
    }
  },

  async loadFile(fileId, fileName, heading) {
    const draftKey = `drivenotes_draft_${fileId}`;

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
      // Offline or Drive error: unsynced local edits of this file are still reachable
      if (this.openDraft(draftKey)) return true;
      this.setSaveStatus('error', 'Erro ao carregar');
      return false;
    }
    if (seq !== this._loadSeq) return true; // another file was opened meanwhile: not ours to undo

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
      this.scrollToHeading(heading);
      this.setSaveStatus('saved', 'Carregado');
      setTimeout(() => {
        if (this.currentFile === file) this.setSaveStatus('', '');
      }, 2000);
    }
    this.saveToRecents(fileId, file.name);
    return true;
  },

  /** A tap that leads to a note: the history entry is created now, and dropped again if the note never opens */
  async navigateTo(fileId, fileName, options) {
    this.beginNav();
    if (!(await this.openFile(fileId, fileName, options))) this.cancelNav();
  },

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

  /** Folders and notes directly inside a folder: folders first, then by name the way a person sorts ("2" before "10") */
  async driveListFolder(folderId) {
    const FOLDER = 'application/vnd.google-apps.folder';
    const found = [];
    let pageToken = '';
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id,name,mimeType,modifiedTime)',
        pageSize: '1000',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await this.driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`);
      const data = await response.json();
      found.push(...(data.files || []));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }

    const isNote = (f) => /\.(md|markdown|txt)$/i.test(f.name) || (f.mimeType || '').startsWith('text/');
    return found
      // Dot-folders (.obsidian, .trash) stay hidden, as in Obsidian
      .filter(f => !f.name.startsWith('.') && (f.mimeType === FOLDER || isNote(f)))
      .map(f => ({ id: f.id, name: f.name, isFolder: f.mimeType === FOLDER, modifiedTime: f.modifiedTime }))
      .sort((a, b) => (b.isFolder - a.isFolder)
        || a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' }));
  },

  /** Files with exactly one of these names, anywhere in Drive, newest first */
  async driveFindByName(names) {
    const quote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    const q = `(${names.map(n => `name = ${quote(n)}`).join(' or ')}) and trashed = false`;
    const params = new URLSearchParams({
      q,
      fields: 'files(id,name,parents,mimeType)',
      orderBy: 'modifiedTime desc',
      pageSize: '20',
    });
    const response = await this.driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    return (await response.json()).files || [];
  },

  /** Fetch file content by ID */
  async driveGetFileContent(fileId) {
    const response = await this.driveFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
    );
    return response.text();
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

  // ── Recents (localStorage) ──

  saveToRecents(fileId, fileName) {
    try {
      const raw = localStorage.getItem('drivenotes_recents');
      let recents = raw ? JSON.parse(raw) : [];

      // Remove duplicate
      recents = recents.filter(r => r.id !== fileId);

      // Add to front
      recents.unshift({ id: fileId, name: fileName, timestamp: Date.now() });

      // Keep max 20
      recents = recents.slice(0, 20);

      localStorage.setItem('drivenotes_recents', JSON.stringify(recents));
    } catch {
      // ignore
    }
  },

  getRecents() {
    try {
      const raw = localStorage.getItem('drivenotes_recents');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  renderRecents() {
    const recents = this.getRecents();
    const container = document.getElementById('recents-list');
    const ul = document.getElementById('recents-ul');

    if (!recents.length || !container || !ul) return;

    container.classList.remove('hidden');
    ul.innerHTML = '';

    recents.slice(0, 8).forEach(r => {
      const li = document.createElement('li');

      // File name (clickable)
      const nameSpan = document.createElement('span');
      nameSpan.className = 'recent-name';
      nameSpan.textContent = r.name;
      nameSpan.addEventListener('click', () => this.navigateTo(r.id, r.name));
      li.appendChild(nameSpan);

      // Relative time
      const ago = this.timeAgo(r.timestamp);
      if (ago) {
        const timeSpan = document.createElement('span');
        timeSpan.className = 'recent-time';
        timeSpan.textContent = ago;
        li.appendChild(timeSpan);
      }

      // Remove button
      const removeBtn = document.createElement('button');
      removeBtn.className = 'recent-remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.title = 'Remover dos recentes';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeFromRecents(r.id);
      });
      li.appendChild(removeBtn);

      ul.appendChild(li);
    });
  },

  removeFromRecents(fileId) {
    try {
      const raw = localStorage.getItem('drivenotes_recents');
      let recents = raw ? JSON.parse(raw) : [];
      recents = recents.filter(r => r.id !== fileId);
      localStorage.setItem('drivenotes_recents', JSON.stringify(recents));
      this.renderRecents();
    } catch {
      // ignore
    }
  },

  timeAgo(timestamp) {
    if (!timestamp) return '';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'agora';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;
    return '';
  },

  // ── UI State ──

  showBrowser() {
    this.els.welcome.classList.add('hidden');
    this.els.editorContainer.classList.add('hidden');
    this.els.previewContainer.classList.remove('visible');
    this.els.browser.classList.remove('hidden');
    this.els.browser.scrollTop = 0;
    document.body.dataset.view = 'browse';
  },

  showWelcome() {
    this.els.welcome.classList.remove('hidden');
    this.els.browser.classList.add('hidden');
    this.els.editorContainer.classList.add('hidden');
    this.els.previewContainer.classList.remove('visible');
    // The stylesheet keys off data-view: the formatting toolbar only exists while editing
    document.body.dataset.view = 'welcome';
  },

  showEditor(mode = 'edit') {
    this.els.welcome.classList.add('hidden');
    this.els.browser.classList.add('hidden');
    this.setMode(mode);
  },

  setMode(mode) {
    this.mode = mode;
    document.body.dataset.view = mode;

    if (mode === 'preview') {
      this.renderPreview();
      this.els.editorContainer.classList.add('hidden');
      this.els.previewContainer.classList.add('visible');
      this.els.previewContainer.scrollTop = 0;
      this.els.btnPreview.textContent = 'Editar';
    } else {
      this.els.editorContainer.classList.remove('hidden');
      this.els.previewContainer.classList.remove('visible');
      this.els.btnPreview.textContent = 'Ler';
    }
  },

  // ── Reading view ──

  renderPreview() {
    const container = this.els.previewContainer;
    const { frontmatter, body } = this.splitFrontmatter(this.getContent());

    // The token in this page has full Drive scope, so rendered HTML is never trusted:
    // without the sanitizer (or the renderer) the note is shown as plain text instead
    const canRender = typeof DOMPurify !== 'undefined' && typeof marked !== 'undefined';
    container.style.whiteSpace = canRender ? '' : 'pre-wrap';
    if (!canRender) {
      container.textContent = body;
      return;
    }

    container.innerHTML = DOMPurify.sanitize(marked.parse(body));
    this.decoratePreview(container);

    if (frontmatter) {
      // YAML properties: out of the way, one tap to see. Shown raw, never parsed.
      const details = document.createElement('details');
      details.className = 'frontmatter';
      const summary = document.createElement('summary');
      summary.textContent = 'Propriedades';
      const pre = document.createElement('pre');
      pre.textContent = frontmatter;
      details.append(summary, pre);
      container.prepend(details);
    }
  },

  /** Split a leading YAML block (--- ... ---) from the note body */
  splitFrontmatter(content) {
    const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
    if (!match) return { frontmatter: '', body: content };
    return { frontmatter: match[1], body: content.slice(match[0].length) };
  },

  /** Obsidian-flavoured touches on the already sanitized DOM */
  decoratePreview(container) {
    // Wide tables scroll sideways inside their own box instead of stretching the page
    container.querySelectorAll('table').forEach(table => {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.replaceWith(wrap);
      wrap.appendChild(table);
    });

    // Callouts: a blockquote whose first line is [!type] Optional title
    container.querySelectorAll('blockquote').forEach(quote => {
      const first = quote.querySelector(':scope > p');
      const textNode = first?.firstChild;
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;
      const match = /^\[!([\w-]+)\][+-]?[ \t]*(.*)$/.exec(textNode.textContent.trim());
      if (!match) return;

      const type = match[1].toLowerCase();
      const title = document.createElement('div');
      title.className = 'callout-title';
      title.textContent = match[2] || type.charAt(0).toUpperCase() + type.slice(1);

      if (textNode.nextSibling?.nodeName === 'BR') textNode.nextSibling.remove();
      textNode.remove();
      if (!first.textContent.trim() && !first.children.length) first.remove();
      quote.prepend(title);
      quote.classList.add('callout');
      quote.dataset.callout = type;
    });
  },

  /** Taps inside the reading view: wikilinks and relative .md links open notes, the rest leaves the app */
  onPreviewClick(e) {
    const link = e.target.closest('a');
    if (!link || !this.els.previewContainer.contains(link)) return;
    e.preventDefault();

    if (link.classList.contains('wikilink')) {
      this.followLink(link.dataset.target || '', link.dataset.heading || '');
      return;
    }

    const href = link.getAttribute('href') || '';
    if (href.startsWith('#')) {
      this.scrollToHeading(decodeURIComponent(href.slice(1)));
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      window.open(href, '_blank', 'noopener');
    } else {
      // Relative link to another note: [texto](pasta/nota.md#titulo)
      const [file, heading = ''] = decodeURIComponent(href).split('#');
      this.followLink(file, heading);
    }
  },

  /** Open the note a link points to. Notes are found by file name, like Obsidian does. */
  async followLink(target, heading) {
    if (!target) {
      this.scrollToHeading(heading);
      return;
    }

    // Still inside the tap: the history entry has to be created now (see beginNav).
    // Every way out that does not open a note drops it again with cancelNav().
    this.beginNav();

    const base = target.split('/').pop().trim();
    const names = /\.md$/i.test(base) ? [base] : [`${base}.md`, base];
    this.setSaveStatus('saving', 'Procurando...');

    let matches;
    try {
      await this.ensureAuth();
      matches = await this.driveFindByName(names);
    } catch (e) {
      console.error('Link lookup failed:', e);
      this.setSaveStatus('error', 'Erro ao procurar a nota');
      this.cancelNav();
      return;
    }

    const isText = (f) => /\.(md|markdown|txt)$/i.test(f.name) || (f.mimeType || '').startsWith('text/');
    const notes = matches.filter(isText);
    if (!notes.length) {
      this.setSaveStatus('error', matches.length ? `Não abro esse tipo: ${base}` : `Nota não encontrada: ${base}`);
      this.cancelNav();
      return;
    }

    // Same name in more than one place: the one next to the open note wins, then .md over the rest
    const folder = this.currentFile?.parents?.[0];
    const pick = notes.find(f => folder && f.parents?.includes(folder))
      || notes.find(f => /\.md$/i.test(f.name))
      || notes[0];

    if (!(await this.openFile(pick.id, pick.name, { heading }))) this.cancelNav();
  },

  scrollToHeading(heading) {
    if (!heading) return;
    const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    const wanted = norm(heading);
    const slug = wanted.replace(/ /g, '-');
    const found = [...this.els.previewContainer.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .find(h => norm(h.textContent) === wanted || norm(h.textContent).replace(/ /g, '-') === slug);
    if (found) found.scrollIntoView({ block: 'start' });
  },

  // ── Navigation (back button, Android back gesture) ──

  // A view is described by { view: 'welcome' }, { view: 'file', id, name } or { view: 'browse', id, name, path }.
  //
  // Two ways to make the system back button walk through views instead of closing the app:
  // - CloseWatcher (useWatcher): the API Chrome gives apps for the Android back button. While one is
  //   active, "back" fires its close event and never touches the session history. The views left
  //   behind live in navStack. This is the one used wherever it exists.
  // - History API: one history entry per view, carrying its description; "back" lands on an entry
  //   and onPopState shows what it says.

  viewState() {
    const file = this.currentFile;
    if (file) return { view: 'file', id: file.id, name: file.name };
    if (this.folder) return { view: 'browse', ...this.folder };
    return { view: 'welcome' };
  },

  /** Show the view a description stands for; nothing to do if it is already on screen */
  show(state) {
    this.log(`show ${state?.view || 'welcome'} ${state?.name || ''}`);
    if (state?.view === 'file' && state.id) {
      if (state.id !== this.currentFile?.id) this.openFile(state.id, state.name);
    } else if (state?.view === 'browse') {
      if (this.currentFile || this.folder?.id !== state.id) {
        this.openFolder({ id: state.id, name: state.name, path: state.path || [] });
      }
    } else if (this.currentFile || this.folder || document.body.dataset.view !== 'welcome') {
      // (already there when a failed navigation is being undone: its error message stays on screen)
      this.goHome();
    }
  },

  /** Call synchronously from the tap that starts a navigation. In History mode Chrome's back button
      skips entries that were not created during a user gesture, so this cannot wait for the Drive. */
  beginNav() {
    if (this.useWatcher) {
      this.navStack.push(this.viewState());
      this.armWatcher();
    } else {
      history.pushState(this.viewState(), '');
    }
    this.log('beginNav');
  },

  /** The navigation begun never changed the view: forget it */
  cancelNav() {
    if (this.useWatcher) {
      this.navStack.pop();
      this.armWatcher();
    } else {
      history.back();
    }
    this.log('cancelNav');
  },

  /** History mode: make the current entry describe what is on screen */
  syncHistory() {
    if (!this.useWatcher) history.replaceState(this.viewState(), '');
  },

  /** Keep a CloseWatcher alive exactly while "back" has something to do inside the app.
      With none active, the system back button leaves the app, which is what the welcome screen wants. */
  armWatcher() {
    if (!this.useWatcher) return;
    const needed = this.navStack.length > 0 || !!document.querySelector('.modal-overlay.visible');
    if (needed && !this._watcher) {
      try {
        const watcher = new CloseWatcher();
        watcher.onclose = () => {
          this._watcher = null;
          this.log('watcher: close');
          this.handleBack();
        };
        this._watcher = watcher;
      } catch (e) {
        this.log(`watcher failed: ${e.message}`);
      }
    } else if (!needed && this._watcher) {
      this._watcher.destroy();
      this._watcher = null;
    }
  },

  /** One step back: close the dialog on top, or else return to the previous view */
  handleBack() {
    const dismiss = document.querySelector('.modal-overlay.visible [data-dismiss]');
    if (dismiss) {
      dismiss.click();
    } else if (this.navStack.length) {
      this.show(this.navStack.pop());
    } else {
      this.show(null);
    }
    this.armWatcher();
  },

  /** Header back button */
  goBack() {
    this.log('goBack (button)');
    if (this.useWatcher) {
      this.handleBack();
      return;
    }
    this._popped = false;
    history.back();
    // No entry of ours behind this one (should not happen): still leave the note
    setTimeout(() => {
      if (!this._popped) this.goHome();
    }, 500);
  },

  onPopState(state) {
    this._popped = true;
    this.log('popstate');
    if (!this.useWatcher) this.show(state);
  },

  /** Line for the hidden diagnostics panel (five taps on the welcome title) */
  log(message) {
    const time = new Date().toTimeString().slice(0, 8);
    this._log.push(`${time} ${message} | hist=${history.length} stack=${this.navStack.length} watcher=${this._watcher ? 1 : 0}`);
    if (this._log.length > 60) this._log.shift();
  },

  showDiagnostics() {
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches ?? '?';
    document.getElementById('debug-text').textContent = [
      `modo de voltar: ${this.useWatcher ? 'CloseWatcher' : 'History API'}`,
      `instalado (standalone): ${standalone}`,
      `view: ${document.body.dataset.view}`,
      navigator.userAgent,
      '',
      ...this._log,
    ].join('\n');
    document.getElementById('debug-overlay').classList.add('visible');
    this.armWatcher();
  },

  goHome() {
    this.flushCurrent();
    this._loadSeq++;
    this.currentFile = null;
    this.folder = null;
    this.isDirty = false;
    this.syncHistory();
    this.els.fileName.textContent = 'Drive Notes';
    this.els.fileName.classList.remove('unsaved');
    this.setSaveStatus('', '');
    this.showWelcome();
    this.renderDrafts();
    this.renderRecents();
    // The note just left may still be syncing; once it settles its draft is gone
    this._saveChain.then(() => {
      if (!this.currentFile) this.renderDrafts();
    });
  },

  togglePreview() {
    this.setMode(this.mode === 'edit' ? 'preview' : 'edit');
  },

  markDirty() {
    this.isDirty = true;
    this.updateFileNameDisplay();
    this.scheduleAutoSave();
  },

  updateFileNameDisplay() {
    const name = this.currentFile ? this.currentFile.name : (this.folder ? this.folder.name : 'Drive Notes');
    this.els.fileName.textContent = name;
    this.els.fileName.classList.toggle('unsaved', this.isDirty);
  },

  setSaveStatus(status, text) {
    this.els.saveStatus.textContent = text;
    this.els.saveStatus.className = 'save-status ' + status;
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

  newFile() {
    // Whatever is open gets saved before it is replaced
    this.flushCurrent();
    this._loadSeq++; // a file still loading must not land on top of the new note
    this.beginNav();

    const name = this.generateFileName();
    // The draft key is fixed for the life of the note, so the draft is still found
    // (and cleared) after the note gets its Drive ID
    const file = { id: null, name: name, draftKey: `drivenotes_draft_new_${Date.now()}` };
    this.currentFile = file;
    this.syncHistory();
    this.setContent('');
    this.showEditor();
    this.updateFileNameDisplay();
    this.focusEditor();

    // Create on Drive in background, not awaited, so the user can type immediately.
    // If it fails, the first save creates the file instead.
    if (this.hasValidToken()) {
      this.setSaveStatus('saving', 'Criando no Drive...');
      this.enqueue(() => this.createOnDrive(file, '')).then(() => {
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
    if (this.editor) {
      // TinyMDE — focus its internal contentEditable element
      const editable = this.els.editorElement.querySelector('[contenteditable]');
      if (editable) editable.focus();
      else this.els.editorElement.focus();
    } else {
      this.els.editorElement.focus();
    }
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
      The draft is written first, synchronously, so the text survives whatever happens to the request. */
  flushCurrent() {
    clearTimeout(this.autoSaveTimer);
    const file = this.currentFile;
    if (!file || !this.isDirty) return;

    const content = this.getContent();
    this.saveDraft(file, content);
    if (file.conflict) return; // stays as a draft; the dialog comes back when it is reopened
    this.enqueue(() => this.saveSnapshot(file, content));
  },

  /** Write one snapshot of one file to Drive. The file may no longer be the open one,
      so the UI is only touched while it still is. Never throws: on failure the snapshot becomes a draft. */
  async saveSnapshot(file, content) {
    const isCurrent = () => this.currentFile === file;

    if (file.conflict) {
      // Queued behind a save of the same file that hit a conflict
      this.saveDraft(file, content);
      return;
    }

    if (content === file.lastSavedContent) {
      this.settleSaved(file, content);
      return;
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
      return;
    }

    if (isCurrent()) {
      this.setSaveStatus('saving', file.id ? 'Salvando...' : 'Criando no Drive...');
    }

    try {
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
          return;
        }

        const result = await this.driveUpdateFile(file.id, content);
        file.modifiedTime = result.modifiedTime;
        file.lastSavedContent = content;
      } else {
        await this.createOnDrive(file, content);
      }
    } catch (e) {
      console.error('Drive save failed:', e);
      this.saveDraft(file, content);
      if (isCurrent()) {
        this.setSaveStatus('error', 'Erro: salvo local');
      } else {
        this.setSaveStatus('error', `Erro ao salvar ${file.name}: rascunho guardado`);
      }
      return;
    }

    this.settleSaved(file, content);
    if (isCurrent()) {
      this.setSaveStatus('saved', 'Salvo no Drive');
      setTimeout(() => {
        if (isCurrent()) this.setSaveStatus('', '');
      }, 3000);
    }
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

  /** Create `file` on Drive and record its ID and version on the file object */
  async createOnDrive(file, content) {
    const folderId = file.parents?.[0] || CONFIG.DEFAULT_FOLDER_ID;
    const result = await this.driveCreateFile(file.name, content, folderId);
    file.id = result.id;
    file.modifiedTime = result.modifiedTime;
    file.parents = result.parents;
    file.lastSavedContent = content;

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
    if (this.currentFile === file) this.syncHistory(); // the entry can now name the note by ID
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
      if (!key.startsWith('drivenotes_draft') || key === 'drivenotes_draft_latest') continue;
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

  /** The app's own confirm(). Resolves to true on OK, false on cancel or "back". */
  confirmDialog(title, text, okLabel) {
    const overlay = document.getElementById('confirm-overlay');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-text').textContent = text;
    const ok = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    ok.textContent = okLabel;

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
      await this.openFile(file.id, file.name);
      return;
    }

    if (action === 'copy') {
      const content = this.getContent();
      const copy = {
        id: null,
        name: this.conflictCopyName(file.name),
        draftKey: `drivenotes_draft_new_${Date.now()}`,
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

  // ── Rename ──

  promptRename() {
    const file = this.currentFile;
    if (!file) return;
    this.showModal('Renomear nota', 'Nome do arquivo', (value) => this.renameFile(file, value), {
      value: file.name,
      confirmLabel: 'Renomear',
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
      });
    } catch (e) {
      console.error('Rename failed:', e);
      applyName(oldName);
      if (this.currentFile === file) this.setSaveStatus('error', 'Erro ao renomear');
      return;
    }

    if (this.currentFile === file) {
      this.setSaveStatus('saved', 'Renomeado');
      setTimeout(() => {
        if (this.currentFile === file) this.setSaveStatus('', '');
      }, 2000);
    }
  },

  // ── Modal ──

  showModal(title, placeholder, onConfirm, { value = '', confirmLabel = 'Criar' } = {}) {
    this.els.modal.querySelector('h3').textContent = title;
    this.els.modalInput.placeholder = placeholder;
    this.els.modalInput.value = value;
    this.els.modalConfirm.textContent = confirmLabel;
    this.els.modal.classList.add('visible');
    this.els.modalInput.focus();
    // Ready to type over the name, keeping the extension
    const dot = value.lastIndexOf('.');
    if (dot > 0) this.els.modalInput.setSelectionRange(0, dot);
    this.armWatcher();

    this._modalConfirm = () => {
      const value = this.els.modalInput.value;
      this.hideModal();
      onConfirm(value);
    };
  },

  hideModal() {
    this.els.modal.classList.remove('visible');
    this._modalConfirm = null;
    this.armWatcher();
  },

  // ── Toolbar formatting ──

  // `wrap` formats go around the selection; `line` formats toggle a marker at the start of every
  // selected line, wherever the cursor is in it. `command` is the TinyMDE command doing the same job.
  FORMATS: {
    bold: { wrap: ['**', '**'], command: 'bold' },
    italic: { wrap: ['_', '_'], command: 'italic' },
    code: { wrap: ['`', '`'], command: 'code' },
    link: { wrap: ['[', '](url)'] },
    heading: { line: '## ', command: 'h2' },
    list: { line: '- ', command: 'ul' },
    quote: { line: '> ', command: 'blockquote' },
    checklist: { line: '- [ ] ' },
  },

  applyFormat(name) {
    const format = this.FORMATS[name];
    if (!format) return;

    if (this.editor) {
      this.applyFormatTinyMDE(format);
    } else if (format.line) {
      this.toggleLinesInTextarea(format.line);
    } else {
      this.wrapInTextarea(...format.wrap);
    }
    // TinyMDE commands change the text without firing its change event
    this.markDirty();
  },

  applyFormatTinyMDE(format) {
    const ed = this.editor;
    if (format.command) {
      ed.setCommandState(format.command, ed.getCommandState()[format.command] !== true);
    } else if (format.wrap) {
      ed.wrapSelection(...format.wrap);
    } else {
      // No TinyMDE command for this marker: same steps its own line commands take
      const focus = ed.getSelection(false);
      const anchor = ed.getSelection(true) || focus;
      if (!focus) return;
      const first = Math.min(focus.row, anchor.row);
      const last = Math.max(focus.row, anchor.row);
      for (let row = first; row <= last; row++) {
        ed.lines[row] = this.toggleLinePrefix(ed.lines[row], format.line);
        ed.lineDirty[row] = true;
      }
      ed.updateFormatting();
      ed.setSelection({ row: last, col: ed.lines[last].length });
    }
  },

  /** Put `prefix` at the start of the line, replacing any other block marker; take it off if it is already there */
  toggleLinePrefix(line, prefix) {
    const kindOf = (marker) => {
      if (marker.startsWith('#')) return 'heading';
      if (marker.startsWith('>')) return 'quote';
      if (marker.includes('[')) return 'checklist';
      if (/^[-*+]/.test(marker)) return 'list';
      return marker ? 'ordered' : '';
    };
    const [, indent, marker = '', rest] =
      /^(\s*)((?:#{1,6}|[0-9]{1,9}[).]|>|[-*+](?: \[[ xX]\])?)\s+)?(.*)$/.exec(line);
    return kindOf(marker) === kindOf(prefix) ? indent + rest : indent + prefix + rest;
  },

  toggleLinesInTextarea(prefix) {
    const ta = this.els.editorElement;
    const value = ta.value;
    const start = value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let end = value.indexOf('\n', ta.selectionEnd);
    if (end < 0) end = value.length;

    const block = value.slice(start, end).split('\n')
      .map(line => this.toggleLinePrefix(line, prefix)).join('\n');
    ta.value = value.slice(0, start) + block + value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + block.length;
    ta.focus();
  },

  wrapInTextarea(prefix, suffix) {
    const ta = this.els.editorElement;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end) || 'texto';
    ta.value = ta.value.substring(0, start) + prefix + selected + suffix + ta.value.substring(end);
    ta.selectionStart = start + prefix.length;
    ta.selectionEnd = start + prefix.length + selected.length;
    ta.focus();
  },

  // ── Events ──

  scrollCaretIntoView() {
    if (this.mode !== 'edit' || !this.editor) return;
    const scroller = this.editor.e;
    const selection = window.getSelection();
    if (!scroller || !selection.rangeCount || !scroller.contains(selection.focusNode)) return;

    // A collapsed range at the end of a line can report an empty box: use its line instead
    let rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect.height) {
      const node = selection.focusNode;
      rect = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement).getBoundingClientRect();
    }
    const box = scroller.getBoundingClientRect();
    if (rect.bottom > box.bottom - 12) scroller.scrollTop += rect.bottom - box.bottom + 32;
    else if (rect.top < box.top) scroller.scrollTop -= box.top - rect.top + 12;
  },

  /** Keep toolbar visible above virtual keyboard using visualViewport API */
  initToolbarKeyboardHandler() {
    const toolbar = document.querySelector('.toolbar');
    if (!toolbar || !window.visualViewport) return;

    const update = () => {
      const vv = window.visualViewport;
      // How much the keyboard is covering: difference between layout and visual viewport
      const keyboardHeight = window.innerHeight - vv.height;
      if (keyboardHeight > 50) {
        // Keyboard is open: move toolbar up
        toolbar.style.transform = `translateY(-${keyboardHeight}px)`;
      } else {
        toolbar.style.transform = '';
      }
      // The page itself resizes with the keyboard (interactive-widget in the viewport meta),
      // so the editor just got shorter: keep the line being typed above the toolbar
      this.scrollCaretIntoView();
    };

    window.visualViewport.addEventListener('resize', update);
    window.visualViewport.addEventListener('scroll', update);
    window.addEventListener('resize', update);
  },

  bindEvents() {
    // Header buttons
    this.els.btnNew.addEventListener('click', () => this.newFile());
    this.els.btnOpen.addEventListener('click', () => this.browseVault());
    this.els.btnSave?.addEventListener('click', () => this.save({ manual: true }));
    this.els.btnPreview.addEventListener('click', () => this.togglePreview());

    // Tap the title to rename the open note
    this.els.fileName.addEventListener('click', () => this.promptRename());

    // Navigation
    this.els.btnBack?.addEventListener('click', () => this.goBack());
    window.addEventListener('popstate', (e) => this.onPopState(e.state));
    this.els.previewContainer.addEventListener('click', (e) => this.onPreviewClick(e));

    // Conflict dialog
    document.querySelectorAll('[data-conflict]').forEach(btn => {
      btn.addEventListener('click', () => this.resolveConflict(btn.dataset.conflict));
    });

    // Modal
    this.els.modalCancel.addEventListener('click', () => this.hideModal());
    this.els.modalConfirm.addEventListener('click', () => {
      if (this._modalConfirm) this._modalConfirm();
    });
    this.els.modalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this._modalConfirm) this._modalConfirm();
      if (e.key === 'Escape') this.hideModal();
    });

    // Toolbar buttons: prevent focus steal so the virtual keyboard stays open.
    // Cancelling touchstart also cancels the click that would follow, so on touch the
    // action runs on touchend; click is what a mouse or a keyboard produces.
    document.querySelectorAll('.toolbar-btn[data-format]').forEach(btn => {
      btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
      btn.addEventListener('touchend', (e) => {
        e.preventDefault();
        this.applyFormat(btn.dataset.format);
      }, { passive: false });
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => this.applyFormat(btn.dataset.format));
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        this.save({ manual: true });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        this.togglePreview();
      }
    });

    // Welcome buttons
    document.getElementById('welcome-new')?.addEventListener('click', () => this.newFile());
    document.getElementById('welcome-open')?.addEventListener('click', () => this.browseVault());

    // Diagnostics: five quick taps on the welcome title
    let taps = [];
    document.querySelector('#welcome h2')?.addEventListener('click', () => {
      const now = Date.now();
      taps = [...taps.filter(t => now - t < 3000), now];
      if (taps.length >= 5) {
        taps = [];
        this.showDiagnostics();
      }
    });
    document.getElementById('debug-close')?.addEventListener('click', () => {
      document.getElementById('debug-overlay').classList.remove('visible');
      this.armWatcher();
    });
    document.getElementById('debug-copy')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(document.getElementById('debug-text').textContent).catch(() => {});
    });

    // Flush on hide/close — mobile users switch apps constantly.
    // saveDraft is sync (localStorage) so it always runs; save() is async best-effort.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.isDirty) {
        this.saveDraft();
        this.save();
      }
    });
    window.addEventListener('pagehide', () => {
      if (this.isDirty) this.saveDraft();
    });
  },
};

// ── marked.js config ──
// Obsidian links: [[nota]], [[nota|texto]], [[nota#titulo]], ![[embed]].
// An inline extension, so links inside code spans and code blocks are left alone.
const wikilinkExtension = {
  name: 'wikilink',
  level: 'inline',
  start(src) {
    const index = src.search(/!?\[\[/);
    return index < 0 ? undefined : index;
  },
  tokenizer(src) {
    // Inside a table the alias separator is written \|
    const match = /^(!?)\[\[([^\]\n|#\\]*)(?:#([^\]\n|\\]*))?(?:\\?\|([^\]\n]*))?\]\]/.exec(src);
    if (!match) return undefined;
    return {
      type: 'wikilink',
      raw: match[0],
      embed: match[1] === '!',
      target: match[2].trim(),
      heading: (match[3] || '').trim(),
      alias: (match[4] || '').trim(),
    };
  },
  renderer(token) {
    const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const label = token.alias
      || [token.target, token.heading].filter(Boolean).join(' > ');
    // Embedded images and PDFs are not fetched: shown as a plain label
    if (token.embed && /\.(png|jpe?g|gif|webp|svg|pdf|mp3|mp4|canvas)$/i.test(token.target)) {
      return `<span class="wikilink-file">${escape(label)}</span>`;
    }
    return `<a href="#" class="wikilink" data-target="${escape(token.target)}" data-heading="${escape(token.heading)}">${escape(label)}</a>`;
  },
};

if (typeof marked !== 'undefined') {
  marked.setOptions({
    breaks: true,
    gfm: true,
  });
  marked.use({ extensions: [wikilinkExtension] });
}

// ── Google Identity callback (called from script onload in index.html) ──
function onGisLoaded() {
  App.onGisLoaded();
}

// ── Start ──
document.addEventListener('DOMContentLoaded', () => App.init());
