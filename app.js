// Drive Notes — Main application logic
// =====================================================
// CONFIG: Replace these with your Google Cloud project values
// =====================================================
const CONFIG = {
  CLIENT_ID: '104411957628-eu5gbpopvot1ai5a95qbpdn3frcvko4r.apps.googleusercontent.com',
  API_KEY: 'AIzaSyD4muL3FkZEVc5c4bN0cmOj2rpCQMDGOGo',
  APP_ID: '104411957628',
  // Default folder for new files (vault/00-inbox/ on Google Drive)
  // Set this to the folder ID after first setup, or leave null to use Picker
  DEFAULT_FOLDER_ID: '1xONP1bGB7qqNDQ1XNQRSk8rqWKoqCuuV',
  VAULT_FOLDER_ID: '1xJYm3FFeafY1IAcvAHuQ5BaMX7KxRM-K',
};

const SCOPES = 'https://www.googleapis.com/auth/drive';
const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';

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
  gapiLoaded: false,
  gisLoaded: false,
  // All Drive writes run through this chain, one at a time, so a create and a save
  // (or two saves) of the same file can never race and duplicate or reorder content
  _saveChain: Promise.resolve(),
  // Bumped on every file open; a slow load that lost the race is discarded
  _loadSeq: 0,

  // DOM refs
  els: {},

  init() {
    this.els = {
      fileName: document.getElementById('file-name'),
      saveStatus: document.getElementById('save-status'),
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
    };

    // Pointer used by older versions; drafts are now found by scanning their keys
    localStorage.removeItem('drivenotes_draft_latest');

    this.initEditor();
    this.bindEvents();
    this.initToolbarKeyboardHandler();
    this.showWelcome();
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
    } catch (e) {
      console.warn('TinyMDE failed to load, using fallback textarea:', e);
      this.useFallbackEditor();
    }
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

  onGapiLoaded() {
    gapi.load('client:picker', async () => {
      await gapi.client.init({
        apiKey: CONFIG.API_KEY,
        discoveryDocs: [DISCOVERY_DOC],
      });
      this.gapiLoaded = true;
      this.checkReady();
    });
  },

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
    this.gisLoaded = true;
    this.checkReady();
  },

  checkReady() {
    if (this.gapiLoaded && this.gisLoaded) {
      console.log('Drive Notes: Google APIs ready');
      // Try to restore saved token
      this.restoreToken();
    }
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
      gapi.client.setToken({ access_token: token });
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
      gapi.client.setToken({ access_token: response.access_token });
      console.log('Drive Notes: token refreshed silently');
    };
    this.tokenClient.requestAccessToken(this.tokenRequest(''));
  },

  /** Ensure we have a valid access token. Returns a promise. */
  async ensureAuth() {
    // Check if current token is still valid
    const expiresAt = parseInt(
      localStorage.getItem('drivenotes_token_expires')
      || sessionStorage.getItem('drivenotes_token_expires')
      || '0'
    );
    if (this.accessToken && expiresAt > Date.now() + 60000) {
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
        gapi.client.setToken({ access_token: response.access_token });
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

    return this.requestToken('consent');
  },

  // ── Google Picker ──

  async openPicker() {
    try {
      await this.ensureAuth();
    } catch (e) {
      console.error('Auth failed:', e);
      this.setSaveStatus('error', 'Erro na autenticação');
      return;
    }

    // Default view: vault folder
    const vaultView = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setParent(CONFIG.VAULT_FOLDER_ID)
      .setMimeTypes('text/markdown,text/plain,text/x-markdown');

    // Fallback: search all Drive
    const allView = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setMimeTypes('text/markdown,text/plain,text/x-markdown');

    const picker = new google.picker.PickerBuilder()
      .addView(vaultView)
      .addView(allView)
      .setOAuthToken(this.accessToken)
      .setDeveloperKey(CONFIG.API_KEY)
      .setAppId(CONFIG.APP_ID)
      .setCallback((data) => this.onPickerResult(data))
      .setTitle('Abrir arquivo markdown')
      .build();

    picker.setVisible(true);
  },

  async onPickerResult(data) {
    if (data[google.picker.Response.ACTION] !== google.picker.Action.PICKED) {
      return;
    }

    const doc = data[google.picker.Response.DOCUMENTS][0];
    this.openFile(doc[google.picker.Document.ID], doc[google.picker.Document.NAME]);
  },

  /** Open a Drive file in the editor. Shared by the Picker and the recents list. */
  async openFile(fileId, fileName) {
    const draftKey = `drivenotes_draft_${fileId}`;

    try {
      await this.ensureAuth();
    } catch {
      // No login (offline, popup blocked): unsynced local edits of this file are still reachable
      if (!this.openDraft(draftKey)) this.setSaveStatus('error', 'Faça login primeiro');
      return;
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
      if (seq !== this._loadSeq) return;
      // Offline or Drive error: unsynced local edits of this file are still reachable
      if (!this.openDraft(draftKey)) this.setSaveStatus('error', 'Erro ao carregar');
      return;
    }
    if (seq !== this._loadSeq) return; // another file was opened meanwhile

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
      this.showEditor();
      this.setSaveStatus('saved', 'Carregado');
      setTimeout(() => {
        if (this.currentFile === file) this.setSaveStatus('', '');
      }, 2000);
    }
    this.saveToRecents(fileId, file.name);
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

  /** Fetch file content by ID */
  async driveGetFileContent(fileId) {
    const response = await this.driveFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
    );
    return response.text();
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
      nameSpan.addEventListener('click', () => this.openFile(r.id, r.name));
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

  showWelcome() {
    this.els.welcome.classList.remove('hidden');
    this.els.editorContainer.classList.add('hidden');
    this.els.previewContainer.classList.remove('visible');
  },

  showEditor() {
    this.els.welcome.classList.add('hidden');
    this.els.editorContainer.classList.remove('hidden');
    this.setMode('edit');
  },

  setMode(mode) {
    this.mode = mode;

    if (mode === 'preview') {
      const content = this.getContent();
      // The token in this page has full Drive scope, so rendered HTML is never trusted:
      // without the sanitizer the note is shown as plain text instead
      const sanitized = typeof DOMPurify !== 'undefined';
      if (sanitized) {
        this.els.previewContainer.innerHTML = DOMPurify.sanitize(marked.parse(content));
      } else {
        this.els.previewContainer.textContent = content;
      }
      this.els.previewContainer.style.whiteSpace = sanitized ? '' : 'pre-wrap';
      this.els.editorContainer.classList.add('hidden');
      this.els.previewContainer.classList.add('visible');
      this.els.btnPreview.classList.add('active');
      this.els.btnPreview.textContent = 'Editar';
    } else {
      this.els.editorContainer.classList.remove('hidden');
      this.els.previewContainer.classList.remove('visible');
      this.els.btnPreview.classList.remove('active');
      this.els.btnPreview.textContent = 'Preview';
    }
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
    const name = this.currentFile ? this.currentFile.name : 'Sem título';
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

    const name = this.generateFileName();
    // The draft key is fixed for the life of the note, so the draft is still found
    // (and cleared) after the note gets its Drive ID
    const file = { id: null, name: name, draftKey: `drivenotes_draft_new_${Date.now()}` };
    this.currentFile = file;
    this.setContent('');
    this.showEditor();
    this.updateFileNameDisplay();
    this.focusEditor();

    // Create on Drive in background, not awaited, so the user can type immediately.
    // If it fails, the first save creates the file instead.
    if (this.accessToken) {
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
  save({ manual = false } = {}) {
    const file = this.currentFile;
    if (!file || !this.isDirty) return Promise.resolve();
    clearTimeout(this.autoSaveTimer);

    if (file.conflict) {
      // Never write over a Drive version the user hasn't ruled on; keep the text safe locally
      this.saveDraft();
      if (manual) this.showConflict(file);
      return Promise.resolve();
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

    if (!this.accessToken) {
      // No auth: keep it locally. It stays flagged as unsaved because it is not on Drive.
      this.saveDraft(file, content);
      if (isCurrent()) {
        this.setSaveStatus('saved', 'Rascunho salvo');
        setTimeout(() => {
          if (isCurrent()) this.setSaveStatus('', '');
        }, 3000);
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
      nameSpan.addEventListener('click', () => this.openDraft(d.key));
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
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Descartar o rascunho de "${d.name}"? O texto que não está no Drive será perdido.`)) return;
        localStorage.removeItem(d.key);
        this.renderDrafts();
      });
      li.appendChild(removeBtn);

      ul.appendChild(li);
    });
  },

  // ── Conflict with Drive ──

  showConflict(file) {
    this._conflictFile = file;
    this.els.conflictText.textContent =
      `"${file.name}" mudou no Drive depois que você abriu. Sua versão está guardada neste aparelho.`;
    this.els.conflict.classList.add('visible');
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
      this.settleSaved(copy, content);
      this.setSaveStatus('saved', 'Cópia salva no Drive');
    }
  },

  // ── Modal ──

  showModal(title, placeholder, onConfirm) {
    this.els.modal.querySelector('h3').textContent = title;
    this.els.modalInput.placeholder = placeholder;
    this.els.modalInput.value = '';
    this.els.modal.classList.add('visible');
    this.els.modalInput.focus();

    this._modalConfirm = () => {
      const value = this.els.modalInput.value;
      this.hideModal();
      onConfirm(value);
    };
  },

  hideModal() {
    this.els.modal.classList.remove('visible');
    this._modalConfirm = null;
  },

  // ── Toolbar formatting ──

  insertFormatting(prefix, suffix) {
    if (!this.editor) {
      const ta = this.els.editorElement;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const selected = ta.value.substring(start, end);
      const replacement = prefix + (selected || 'texto') + (suffix || '');
      ta.value = ta.value.substring(0, start) + replacement + ta.value.substring(end);
      ta.selectionStart = start + prefix.length;
      ta.selectionEnd = start + prefix.length + (selected || 'texto').length;
      ta.focus();
      this.markDirty();
      return;
    }

    const sel = window.getSelection();
    if (sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const selected = range.toString();
      const text = prefix + (selected || 'texto') + (suffix || '');

      range.deleteContents();
      range.insertNode(document.createTextNode(text));

      this.editor.update();
      this.markDirty();
    }
  },

  // ── Events ──

  /** Keep toolbar visible above virtual keyboard using visualViewport API */
  initToolbarKeyboardHandler() {
    const toolbar = document.querySelector('.toolbar');
    if (!toolbar || !window.visualViewport) return;

    const update = () => {
      const vv = window.visualViewport;
      // How much the keyboard is covering: difference between layout and visual viewport
      const keyboardHeight = window.innerHeight - vv.height;
      if (keyboardHeight > 50) {
        // Keyboard is open — move toolbar up
        toolbar.style.transform = `translateY(-${keyboardHeight}px)`;
      } else {
        toolbar.style.transform = '';
      }
    };

    window.visualViewport.addEventListener('resize', update);
    window.visualViewport.addEventListener('scroll', update);
  },

  bindEvents() {
    // Header buttons
    this.els.btnNew.addEventListener('click', () => this.newFile());
    this.els.btnOpen.addEventListener('click', () => this.openPicker());
    this.els.btnSave?.addEventListener('click', () => this.save({ manual: true }));
    this.els.btnPreview.addEventListener('click', () => this.togglePreview());

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

    // Toolbar buttons — prevent focus steal so virtual keyboard stays open
    document.querySelectorAll('.toolbar-btn[data-format]').forEach(btn => {
      btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        const format = btn.dataset.format;
        const formats = {
          bold: ['**', '**'],
          italic: ['_', '_'],
          heading: ['## ', ''],
          link: ['[', '](url)'],
          list: ['- ', ''],
          checklist: ['- [ ] ', ''],
          code: ['`', '`'],
          quote: ['> ', ''],
        };
        const [prefix, suffix] = formats[format] || ['', ''];
        this.insertFormatting(prefix, suffix);
      });
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
    document.getElementById('welcome-open')?.addEventListener('click', () => this.openPicker());

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
if (typeof marked !== 'undefined') {
  marked.setOptions({
    breaks: true,
    gfm: true,
  });
}

// ── Google API callbacks (called from script onload in index.html) ──
function onGapiLoaded() {
  App.onGapiLoaded();
}

function onGisLoaded() {
  App.onGisLoaded();
}

// ── Start ──
document.addEventListener('DOMContentLoaded', () => App.init());
