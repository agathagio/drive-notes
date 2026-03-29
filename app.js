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
  DEFAULT_FOLDER_ID: null,
};

const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';

// =====================================================

const App = {
  // State
  editor: null,
  currentFile: null,   // { id, name } — id is Drive file ID
  isDirty: false,
  mode: 'edit',
  autoSaveTimer: null,
  accessToken: null,
  tokenClient: null,
  gapiLoaded: false,
  gisLoaded: false,

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
    };

    this.initEditor();
    this.bindEvents();
    this.showWelcome();
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
    });
    this.gisLoaded = true;
    this.checkReady();
  },

  checkReady() {
    if (this.gapiLoaded && this.gisLoaded) {
      console.log('Drive Notes: Google APIs ready');
    }
  },

  /** Ensure we have a valid access token. Returns a promise. */
  async ensureAuth() {
    if (this.accessToken) {
      return this.accessToken;
    }

    return new Promise((resolve, reject) => {
      this.tokenClient.callback = (response) => {
        if (response.error) {
          reject(response);
          return;
        }
        this.accessToken = response.access_token;
        resolve(this.accessToken);
      };
      this.tokenClient.requestAccessToken({ prompt: '' });
    });
  },

  /** Re-authenticate (e.g. after token expiry) */
  async reAuth() {
    this.accessToken = null;
    return new Promise((resolve, reject) => {
      this.tokenClient.callback = (response) => {
        if (response.error) {
          reject(response);
          return;
        }
        this.accessToken = response.access_token;
        resolve(this.accessToken);
      };
      this.tokenClient.requestAccessToken({ prompt: 'consent' });
    });
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

    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setMimeTypes('text/markdown,text/plain,text/x-markdown');

    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .addView(new google.picker.DocsView(google.picker.ViewId.FOLDERS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false)
        .setMimeTypes('text/markdown,text/plain,text/x-markdown'))
      .enableFeature(google.picker.Feature.NAV_HIDDEN)
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
    const fileId = doc[google.picker.Document.ID];
    const fileName = doc[google.picker.Document.NAME];

    this.currentFile = { id: fileId, name: fileName };
    this.updateFileNameDisplay();
    this.setSaveStatus('saving', 'Carregando...');

    try {
      const content = await this.driveGetFileContent(fileId);
      this.setContent(content);
      this.showEditor();
      this.setSaveStatus('saved', 'Carregado');
      this.saveToRecents(fileId, fileName);
      setTimeout(() => this.setSaveStatus('', ''), 2000);
    } catch (e) {
      console.error('Failed to load file:', e);
      this.setSaveStatus('error', 'Erro ao carregar');
    }
  },

  // ── Google Drive API ──

  /** Fetch file content by ID */
  async driveGetFileContent(fileId) {
    const response = await gapi.client.drive.files.get({
      fileId: fileId,
      alt: 'media',
    });
    return response.body;
  },

  /** Update existing file content */
  async driveUpdateFile(fileId, content) {
    // gapi.client doesn't support media upload well,
    // so we use a raw fetch with the access token
    const response = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'text/markdown',
        },
        body: content,
      }
    );

    if (response.status === 401) {
      // Token expired — re-auth and retry
      await this.reAuth();
      return this.driveUpdateFile(fileId, content);
    }

    if (!response.ok) {
      throw new Error(`Drive update failed: ${response.status}`);
    }

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

    const response = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,parents',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: body,
      }
    );

    if (response.status === 401) {
      await this.reAuth();
      return this.driveCreateFile(name, content, folderId);
    }

    if (!response.ok) {
      throw new Error(`Drive create failed: ${response.status}`);
    }

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
      li.textContent = r.name;

      // Relative time
      const ago = this.timeAgo(r.timestamp);
      if (ago) {
        const span = document.createElement('span');
        span.className = 'recent-time';
        span.textContent = ago;
        li.appendChild(span);
      }

      li.addEventListener('click', () => this.openRecent(r.id, r.name));
      ul.appendChild(li);
    });
  },

  async openRecent(fileId, fileName) {
    if (!this.accessToken) {
      try {
        await this.ensureAuth();
      } catch {
        this.setSaveStatus('error', 'Faça login primeiro');
        return;
      }
    }

    this.currentFile = { id: fileId, name: fileName };
    this.updateFileNameDisplay();
    this.setSaveStatus('saving', 'Carregando...');

    try {
      const content = await this.driveGetFileContent(fileId);
      this.setContent(content);
      this.showEditor();
      this.setSaveStatus('saved', 'Carregado');
      this.saveToRecents(fileId, fileName);
      setTimeout(() => this.setSaveStatus('', ''), 2000);
    } catch (e) {
      console.error('Failed to load recent file:', e);
      this.setSaveStatus('error', 'Erro ao carregar');
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
      this.els.previewContainer.innerHTML = marked.parse(content);
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

  newFile() {
    this.showModal('Nova nota', 'Nome do arquivo', async (name) => {
      if (!name.trim()) return;
      if (!name.endsWith('.md')) name += '.md';

      this.currentFile = { id: null, name: name };
      this.setContent('');
      this.showEditor();
      this.updateFileNameDisplay();

      // If authenticated, create on Drive immediately
      if (this.accessToken) {
        try {
          this.setSaveStatus('saving', 'Criando no Drive...');
          const result = await this.driveCreateFile(
            name,
            '',
            CONFIG.DEFAULT_FOLDER_ID
          );
          this.currentFile.id = result.id;
          this.saveToRecents(result.id, name);
          this.setSaveStatus('saved', 'Criado no Drive');
          setTimeout(() => this.setSaveStatus('', ''), 2000);
        } catch (e) {
          console.error('Failed to create on Drive:', e);
          this.setSaveStatus('error', 'Erro — salvo local');
          this.saveDraft();
        }
      } else {
        this.saveDraft();
      }
    });
  },

  async save() {
    if (!this.isDirty) return;

    const content = this.getContent();

    // If we have a Drive file ID, save to Drive
    if (this.currentFile && this.currentFile.id && this.accessToken) {
      this.setSaveStatus('saving', 'Salvando...');
      try {
        await this.driveUpdateFile(this.currentFile.id, content);
        this.isDirty = false;
        this.updateFileNameDisplay();
        this.setSaveStatus('saved', 'Salvo no Drive');
        this.saveDraft(); // also keep local draft as backup
        setTimeout(() => this.setSaveStatus('', ''), 3000);
      } catch (e) {
        console.error('Drive save failed:', e);
        this.setSaveStatus('error', 'Erro ao salvar');
        this.saveDraft();
      }
    } else if (this.currentFile && !this.currentFile.id && this.accessToken) {
      // New file not yet on Drive — create it
      this.setSaveStatus('saving', 'Criando no Drive...');
      try {
        const result = await this.driveCreateFile(
          this.currentFile.name,
          content,
          CONFIG.DEFAULT_FOLDER_ID
        );
        this.currentFile.id = result.id;
        this.saveToRecents(result.id, this.currentFile.name);
        this.isDirty = false;
        this.updateFileNameDisplay();
        this.setSaveStatus('saved', 'Salvo no Drive');
        this.saveDraft();
        setTimeout(() => this.setSaveStatus('', ''), 3000);
      } catch (e) {
        console.error('Drive create failed:', e);
        this.setSaveStatus('error', 'Erro — salvo local');
        this.saveDraft();
      }
    } else {
      // No auth — save locally
      this.saveDraft();
      this.isDirty = false;
      this.updateFileNameDisplay();
      this.setSaveStatus('saved', 'Rascunho salvo');
      setTimeout(() => this.setSaveStatus('', ''), 3000);
    }
  },

  saveDraft() {
    const draft = {
      name: this.currentFile ? this.currentFile.name : 'sem-titulo.md',
      content: this.getContent(),
      timestamp: Date.now(),
      fileId: this.currentFile ? this.currentFile.id : null,
    };
    localStorage.setItem('drivenotes_draft', JSON.stringify(draft));
  },

  loadDraft() {
    try {
      const raw = localStorage.getItem('drivenotes_draft');
      if (!raw) return false;

      const draft = JSON.parse(raw);
      this.currentFile = { id: draft.fileId, name: draft.name };
      this.setContent(draft.content);
      this.showEditor();
      this.updateFileNameDisplay();
      return true;
    } catch {
      return false;
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

  bindEvents() {
    // Header buttons
    this.els.btnNew.addEventListener('click', () => this.newFile());
    this.els.btnOpen.addEventListener('click', () => this.openPicker());
    this.els.btnSave?.addEventListener('click', () => this.save());
    this.els.btnPreview.addEventListener('click', () => this.togglePreview());

    // Modal
    this.els.modalCancel.addEventListener('click', () => this.hideModal());
    this.els.modalConfirm.addEventListener('click', () => {
      if (this._modalConfirm) this._modalConfirm();
    });
    this.els.modalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this._modalConfirm) this._modalConfirm();
      if (e.key === 'Escape') this.hideModal();
    });

    // Toolbar buttons
    document.querySelectorAll('.toolbar-btn[data-format]').forEach(btn => {
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
        this.save();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        this.togglePreview();
      }
    });

    // Welcome buttons
    document.getElementById('welcome-new')?.addEventListener('click', () => this.newFile());
    document.getElementById('welcome-open')?.addEventListener('click', () => this.openPicker());
    document.getElementById('welcome-draft')?.addEventListener('click', () => {
      if (this.loadDraft()) {
        this.setSaveStatus('', 'Rascunho carregado');
      }
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
