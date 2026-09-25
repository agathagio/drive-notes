// Drive Notes: the App object, its state, init, screens and events. The other files in app/ extend it.
//
// The app is one object, App, split into classic scripts by area (index.html lists them, in order).
// This file declares `const App = { ... }`; every other app/*.js does `Object.assign(App, { ... })`
// with the methods of its area, so `this` is always App and a method may live in any of the files.
// Classic scripts share the global scope: App, CONFIG and the SWIPE_* constants are visible in all
// of them. Object.assign copies values, not accessors: a getter or setter in an extension file
// would arrive as a fixed value. App has none, and should stay that way.
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
  // Attachment folder at the vault root (Obsidian's attachmentFolderPath)
  MEDIA_FOLDER: '_media',
  // Notes that keep their dates as they are: the same exceptions as the vault's own date automation
  NO_DATES_FOLDERS: ['.obsidian', '.claude', '_media', '_tasknotes', '_archive', '_templates', '_source-docs', '_evernote', 'referencia-cnd'],
  NO_DATES_FILES: ['claude.md', 'skill.md'],
  // Pause in the typing, in ms, before a search goes to the Drive
  SEARCH_DELAY: 500,
};

const SCOPES = 'https://www.googleapis.com/auth/drive';

// Edge swipe: how close to the side of the screen the finger must start, and how far in it must drag (px)
const SWIPE_EDGE = 32;
const SWIPE_TRIGGER = 60;
// Vertical travel that means "this is a scroll", when it is also more than the travel inwards
const SWIPE_SCROLL = 36;

// =====================================================

const App = {
  // State
  editor: null,

  // { id, name, draftKey, modifiedTime, parents, lastSavedContent, driveContent }
  // id is the Drive file ID (null until created); modifiedTime is the Drive version our edits are based on;
  // driveContent is set while the Drive copy has dates the editor has not caught up with (see Dates)
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

  // Embedded images fetched in this session: file name -> promise of a blob URL (null when not found)
  _embedUrls: new Map(),

  // Pictures shown under their ![[...]] line while editing: file name -> { url, width, height },
  // or null while it is on its way (or was not found: not asked again until another note is opened)
  _embedInfo: new Map(),

  // Where a folder sits in the vault: folder ID -> (a promise of) the folder names from the vault root
  // down to it, or null for a folder outside the vault. Used by the dates and by the search.
  _folderTrails: new Map([[CONFIG.VAULT_FOLDER_ID, []]]),

  // What is on screen in the file browser: { folder, items, message }
  _listing: null,

  // Search of the whole vault for the text in the search field: { query, results, failed }, results being
  // null while the Drive has not answered. Answers are kept for the session, by query.
  _search: null,

  _searchCache: new Map(),

  _searchTimer: null,

  _searchSeq: 0,

  // "Back" without the history stack (see Navigation): views left behind, and the active CloseWatcher
  useWatcher: false,

  navStack: [],

  _watcher: null,

  // Views ahead of this one after going back (CloseWatcher mode), and the edge swipe under way: { side, x, y, armed }
  fwdStack: [],

  _swipe: null,

  // The element a long press just fired on: the click its lift sends is swallowed (see onLongPress)
  _longPressed: null,

  // The peek card (hold an internal link): the link it shows, { target, heading, note }, or null while
  // closed; and its sequence, bumped on every open and close, so a late answer never fills a card
  _peek: null,

  _peekSeq: 0,

  // The note on its way from the Drive, as a view description. Until it arrives the screen still shows the
  // previous view, but for navigation the note is already where we are (see viewState).
  _opening: null,

  // A navigation begun by a tap (or a swipe forward) whose view has not landed yet: { pushed }, pushed
  // telling whether it put an entry on navStack. Null once a view lands or the navigation is dropped.
  _pending: null,

  // The note the reading view was last drawn for (see rememberPlace). Not always currentFile: a note with
  // a draft opens straight into the editor, and the reading view behind it still holds the previous note.
  _previewOf: null,

  // The drawing screen while it is open: { canvas, ctx, dpr, strokes, stroke, color, width, erase, at }.
  // `strokes` is the whole drawing (painting works from it, never from the pixels on screen) and
  // `at` is where the caret was in the note. Null while the screen is closed.
  sketch: null,

  // Recent navigation events, for the hidden diagnostics panel
  _log: [],

  // Which cache is serving the app, for the diagnostics panel. It is the service worker's
  // CACHE_NAME, and the activate step deletes every other one, so what is left is the version
  // running on the phone. Without it there was no telling a deploy that had arrived from one still
  // waiting behind the old cache, which is the first thing to rule out when a fix does not show up.
  _version: '?',

  // New version (see watchVersions): the service worker registration, whether a new version has taken
  // over this page, and whether the reload into it is under way (it happens once, never in a loop)
  _swRegistration: null,

  _updateReady: false,

  _reloading: false,

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
      browserSearch: document.getElementById('browser-search'),
      btnPreview: document.getElementById('btn-preview'),
      photoInput: document.getElementById('photo-input'),
      editorContainer: document.getElementById('editor-container'),
      editorElement: document.getElementById('editor'),
      previewContainer: document.getElementById('preview-container'),
      swipeHint: document.getElementById('swipe-hint'),
      welcome: document.getElementById('welcome'),
      modal: document.getElementById('modal-overlay'),
      modalInput: document.getElementById('modal-input'),
      modalCancel: document.getElementById('modal-cancel'),
      modalConfirm: document.getElementById('modal-confirm'),
      modalDelete: document.getElementById('modal-delete'),
      modalMessage: document.getElementById('modal-message'),
      conflict: document.getElementById('conflict-overlay'),
      conflictText: document.getElementById('conflict-text'),
      browser: document.getElementById('browser'),
      sketchScreen: document.getElementById('sketch-screen'),
      sketchCanvas: document.getElementById('sketch-canvas'),
      sketchColors: document.getElementById('sketch-colors'),
      sketchCancel: document.getElementById('sketch-cancel'),
      sketchDone: document.getElementById('sketch-done'),
      sketchErase: document.getElementById('sketch-erase'),
      sketchUndo: document.getElementById('sketch-undo'),
      arrivalOverlay: document.getElementById('arrival-overlay'),
      arrivalTitle: document.getElementById('arrival-title'),
      arrivalWhat: document.getElementById('arrival-what'),
      arrivalMessage: document.getElementById('arrival-message'),
      arrivalLogin: document.getElementById('arrival-login'),
      arrivalUl: document.getElementById('arrival-ul'),
      tocOverlay: document.getElementById('toc-overlay'),
      tocUl: document.getElementById('toc-ul'),
      tocEmpty: document.getElementById('toc-empty'),
      peekOverlay: document.getElementById('peek-overlay'),
      peekTitle: document.getElementById('peek-title'),
      peekMessage: document.getElementById('peek-message'),
      peekBody: document.getElementById('peek-body'),
      peekOpen: document.getElementById('peek-open'),
      updateBar: document.getElementById('update-bar'),
    };

    // Pointer used by older versions; drafts are now found by scanning their keys
    localStorage.removeItem('drivenotes_draft_latest');

    this.useWatcher = typeof CloseWatcher !== 'undefined';
    this.log('init');
    this.readVersion();
    // The saved login does not depend on Google's script having loaded
    this.restoreToken();
    // Opened from a shortcut or a share: read before anything rewrites the history entry
    const launch = this.readLaunch();

    this.initEditor();
    this.bindEvents();
    this.initToolbarKeyboardHandler();
    this.showWelcome();
    this.syncHistory();
    this.renderDrafts();
    this.renderRecents();
    if (launch) {
      // Opened for something else: the note of an update's reload does not come back on top of it
      sessionStorage.removeItem(this.REOPEN_KEY);
      this.startLaunch(launch);
    } else {
      this.reopenAfterUpdate().then(() => this.offerPendingArrival());
    }
  },

  // ── UI State ──

  showBrowser() {
    this._pending = this._opening = null; // a view has landed
    this.els.welcome.classList.add('hidden');
    this.els.editorContainer.classList.add('hidden');
    this.els.previewContainer.classList.remove('visible');
    this.els.browser.classList.remove('hidden');
    this.els.browser.scrollTop = 0;
    document.body.dataset.view = 'browse';
  },

  showWelcome() {
    this._pending = this._opening = null; // a view has landed
    this.els.welcome.classList.remove('hidden');
    this.els.browser.classList.add('hidden');
    this.els.editorContainer.classList.add('hidden');
    this.els.previewContainer.classList.remove('visible');
    // The stylesheet keys off data-view: the formatting toolbar only exists while editing
    document.body.dataset.view = 'welcome';
  },

  showEditor(mode = 'edit') {
    this._pending = this._opening = null; // a view has landed
    this.els.welcome.classList.add('hidden');
    this.els.browser.classList.add('hidden');
    this.setMode(mode);
  },

  setMode(mode) {
    // "Editar" leaves the reading view behind: its place is kept for the next opening
    if (mode === 'edit') this.rememberPlace();
    this.mode = mode;
    document.body.dataset.view = mode;

    if (mode === 'preview') {
      this.showSavedDates();
      this.renderPreview();
      this.els.editorContainer.classList.add('hidden');
      this.els.previewContainer.classList.add('visible');
      this.els.previewContainer.scrollTop = 0;
      this.els.btnPreview.textContent = 'Editar';
    } else {
      this.els.editorContainer.classList.remove('hidden');
      this.els.previewContainer.classList.remove('visible');
      this.els.btnPreview.textContent = 'Ler';
      this.decorateEditorEmbeds();
    }
  },

  goHome() {
    this.flushCurrent();
    this._loadSeq++;
    this._opening = null;
    this.currentFile = null;
    this.folder = null;
    this.isDirty = false;
    this.syncHistory();
    this.updateFileNameDisplay();
    this.setSaveStatus('', '');
    this.showWelcome();
    this.renderDrafts();
    this.renderRecents();
    // The note just left may still be syncing; once it settles its draft is gone
    this._saveChain.then(() => {
      if (!this.currentFile) this.renderDrafts();
    });
    // A new version offered by the bar and left for later: the home screen is where it can just reload
    this.offerUpdate();
  },

  /** Ler / Editar on the note on screen: the stretch at the top of one is at the top of the other */
  togglePreview() {
    if (this.mode !== 'edit') {
      this.editAtReading();
      return;
    }
    const at = this.Editor.topLine();
    this.setMode('preview');
    this.showReadingLine(at);
  },

  markDirty() {
    this.isDirty = true;
    this.updateFileNameDisplay();
    this.scheduleAutoSave();
    this.scheduleEmbedDecoration();
  },

  updateFileNameDisplay() {
    const name = this.currentFile ? this.currentFile.name : (this.folder ? this.folder.name : 'Drive Notes');
    this.els.fileName.textContent = name;
    this.els.fileName.classList.toggle('unsaved', this.isDirty);
    // In reading view the save button only shows while there is something to save (see the stylesheet)
    document.body.classList.toggle('unsaved', this.isDirty);
  },

  setSaveStatus(status, text) {
    this.els.saveStatus.textContent = text;
    this.els.saveStatus.className = 'save-status ' + status;
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

  // ── Events ──

  scrollCaretIntoView() {
    if (this.mode !== 'edit') return;
    this.Editor.scrollToCaret();
  },

  // How far the finger may travel and the touch still count as a touch, in pixels. Above that it
  // was a drag, and a drag on the toolbar is a scroll. The Android decides its own scroll by a
  // similar distance (some 8dp).
  DRAG_MAX: 10,

  /** A toolbar button: tapped with the keyboard open and with the toolbar scrolling sideways, which
      are two demands that fight each other. It must not steal the focus from the editor (the
      keyboard would close and the caret would vanish) and it must not swallow the drag that scrolls
      the toolbar, which does not fit on the screen.

      The way out is to cancel the END of the touch instead of its start. Cancelling the
      `touchstart`, which is what the app used to do, prevents the focus but also prevents the
      scroll: all that was left was scrolling through the 6px gap between the buttons and the edge
      of the toolbar. Cancelling only the `touchend` prevents the synthetic click just as well (and
      with it the focus), and lets the browser scroll while the finger moves. That is why the action
      lives in the `touchend`; the `click` is the path of the mouse and of the keyboard.

      Dragged further than DRAG_MAX: it was a scroll, and the button does not act. (A long scroll
      does not even get here: the browser sends `touchcancel` as soon as it takes over the gesture.) */
  bindToolbarButton(btn, act) {
    let start = null;
    btn.addEventListener('touchstart', (e) => {
      const touch = e.touches?.[0];
      start = { x: touch?.clientX, y: touch?.clientY };
    }, { passive: true });
    // The browser taking over the scroll says so through here, and the gesture stops being a touch on the button
    btn.addEventListener('touchcancel', () => { start = null; }, { passive: true });
    btn.addEventListener('touchend', (e) => {
      // Always cancelled: it is what holds the keyboard, and also what keeps the synthetic click
      // from acting again after a drag
      e.preventDefault();
      const gesture = start;
      start = null;
      if (!gesture) return;
      const touch = e.changedTouches?.[0];
      const dragged = touch && Number.isFinite(gesture.x)
        && Math.hypot(touch.clientX - gesture.x, touch.clientY - gesture.y) > this.DRAG_MAX;
      if (!dragged) act();
    }, { passive: false });
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => act());
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
    // Save is tapped in the middle of writing: it must not take the focus (and the keyboard, and the
    // caret) away from the editor. Here the whole touch is cancelled, and not just its end as in the
    // toolbar (bindToolbarButton): there is nothing to scroll in the header, so nothing to make room for
    this.els.btnSave?.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    this.els.btnSave?.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.save({ manual: true });
    }, { passive: false });
    this.els.btnSave?.addEventListener('mousedown', (e) => e.preventDefault());
    this.els.btnSave?.addEventListener('click', () => this.save({ manual: true }));
    this.els.btnPreview.addEventListener('click', () => this.togglePreview());

    // Search field of the file browser
    this.els.browserSearch.addEventListener('input', () => this.onSearchInput());
    this.els.browserSearch.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      this.els.browserSearch.blur(); // the keyboard gets out of the way of the results
      this.searchVault({ now: true });
      this.drawBrowser();
    });
    document.getElementById('browser-search-clear').addEventListener('click', () => {
      this.els.browserSearch.value = '';
      this.onSearchInput();
      this.els.browserSearch.focus();
    });

    // The click a lift sends after a long press: swallowed before anything else sees it. It does not
    // land on the held element: what the long press opened is on top by then, and the click goes to
    // it (measured in Edge: the TOC's backdrop, which closed the TOC as it opened). So the one
    // swallowed is the first click after the long press, wherever it lands, and only until a new
    // touch begins: any click after that belongs to the new touch and passes untouched.
    document.addEventListener('touchstart', () => {
      this._longPressed = null;
    }, { capture: true, passive: true });
    document.addEventListener('click', (e) => {
      if (!this._longPressed) return;
      this._longPressed = null;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);

    // Tap the title to rename the open note; hold it in reading view for the table of contents
    this.els.fileName.addEventListener('click', () => this.promptRename());
    this.onLongPress(this.els.fileName, '#file-name', () => this.openToc(), {
      accept: () => this.mode === 'preview' && !!this.currentFile && document.body.dataset.view === 'preview',
    });
    document.getElementById('toc-close')?.addEventListener('click', () => this.closeToc());
    // A tap on the dimmed backdrop closes, like Fechar
    this.els.tocOverlay.addEventListener('click', (e) => {
      if (e.target === this.els.tocOverlay) this.closeToc();
    });

    // Hold a link to another note in reading view: peek at it. Only the reading view listens, so a link
    // held inside the card peeks at nothing (no peek inside a peek), and links out of the app keep
    // Chrome's own long press.
    this.onLongPress(this.els.previewContainer, 'a', (a) => {
      const link = this.internalLinkOf(a);
      if (link) this.openPeek(link);
    }, {
      accept: (a) => this.mode === 'preview' && document.body.dataset.view === 'preview' && !!this.internalLinkOf(a),
    });
    document.getElementById('peek-close')?.addEventListener('click', () => this.closePeek());
    this.els.peekOpen.addEventListener('click', () => this.openPeeked());
    this.els.peekBody.addEventListener('click', (e) => this.onPeekClick(e));
    this.els.peekOverlay.addEventListener('click', (e) => {
      if (e.target === this.els.peekOverlay) this.closePeek();
    });

    // Navigation
    this.els.btnBack?.addEventListener('click', () => this.goBack());
    window.addEventListener('popstate', (e) => this.onPopState(e.state));
    // Passive: the swipe only watches the finger, scrolling stays with the browser
    document.addEventListener('touchstart', (e) => this.onSwipeStart(e), { passive: true });
    document.addEventListener('touchmove', (e) => this.onSwipeMove(e), { passive: true });
    document.addEventListener('touchend', () => this.endSwipe(true), { passive: true });
    document.addEventListener('touchcancel', () => this.endSwipe(), { passive: true });
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
    this.els.modalDelete.addEventListener('click', () => {
      if (this._modalDelete) this._modalDelete();
    });
    this.els.modalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this._modalConfirm) this._modalConfirm();
      if (e.key === 'Escape') this.hideModal();
    });

    // Undo and redo
    document.querySelectorAll('.toolbar-btn[data-history]').forEach(btn => {
      // Nothing marks the note as unsaved here, on purpose. Undoing for real changes the text, and
      // both editors report that by themselves (the CodeMirror through its updateListener, the
      // textarea through the input event execCommand fires). With an empty stack nothing changes,
      // and the note stays clean: tapping undo on a just-opened note used to mark it as unsaved,
      // and thirty seconds later the autosave wrote it to the Drive with today's `updated` without
      // a single edit having happened.
      this.bindToolbarButton(btn, () => {
        if (btn.dataset.history === 'undo') this.Editor.undo(); else this.Editor.redo();
      });
    });

    document.querySelectorAll('.toolbar-btn[data-format]').forEach(btn => {
      this.bindToolbarButton(btn, () => this.applyFormat(btn.dataset.format));
    });

    // Photo buttons: same touch handling as the rest of the toolbar. The file picker only opens from
    // inside a tap, and touchend counts as one.
    document.querySelectorAll('.toolbar-btn[data-photo]').forEach(btn => {
      this.bindToolbarButton(btn, () => this.pickPhoto(btn.dataset.photo));
    });
    this.els.photoInput.addEventListener('change', () => {
      const picked = [...this.els.photoInput.files];
      if (picked.length) this.insertPhotos(picked);
    });

    // Drawing: the pencil sits with the photo buttons and is tapped with the keyboard open too
    const pencil = document.querySelector('.toolbar-btn[data-sketch]');
    if (pencil) this.bindToolbarButton(pencil, () => this.sketchOpen());

    // Extract to a new note: tapped with text selected, often with the keyboard open. The same touch
    // handling as the rest of the toolbar, because taking the focus would take the selection with it
    const extract = document.querySelector('.toolbar-btn[data-extract]');
    if (extract) this.bindToolbarButton(extract, () => this.promptExtract());

    this.els.sketchCancel.addEventListener('click', () => this.sketchCancel());
    this.els.sketchColors.addEventListener('click', (e) => {
      const color = e.target.dataset?.sketchColor;
      if (!color || !this.sketch) return;
      this.sketch.color = color;
      this.sketch.erase = false;
      this.sketchRenderTools();
    });
    document.querySelectorAll('[data-sketch-width]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!this.sketch) return;
        this.sketch.width = Number(btn.dataset.sketchWidth);
        this.sketchRenderTools();
      });
    });
    this.els.sketchErase.addEventListener('click', () => {
      if (!this.sketch) return;
      this.sketch.erase = !this.sketch.erase;
      this.sketchRenderTools();
    });
    this.els.sketchCanvas.addEventListener('pointerdown', (e) => this.sketchDown(e));
    this.els.sketchCanvas.addEventListener('pointermove', (e) => this.sketchMove(e));
    this.els.sketchCanvas.addEventListener('pointerup', (e) => this.sketchUp(e));
    this.els.sketchCanvas.addEventListener('pointercancel', (e) => this.sketchUp(e));
    this.els.sketchUndo.addEventListener('click', () => this.sketchUndo());
    this.els.sketchDone.addEventListener('click', () => this.sketchFinish());
    // A rotated phone changes the canvas size
    window.addEventListener('resize', () => this.sketchResize());

    // Pictures in the editor are sized to the line: a rotated phone changes that
    window.addEventListener('resize', () => this.scheduleEmbedDecoration());

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
    // Guardar em…: Cancelar is also what the system back button presses (data-dismiss)
    document.getElementById('arrival-cancel')?.addEventListener('click', () => this.cancelArrivalSheet());
    // A tap: the only moment the login popup is allowed to open
    this.els.arrivalLogin?.addEventListener('click', async () => {
      try {
        await this.ensureAuth();
      } catch (e) {
        console.warn('Login from the arrival sheet failed:', e);
        return;
      }
      this.fillArrivalList();
    });
    document.getElementById('debug-copy')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(document.getElementById('debug-text').textContent).catch(() => {});
    });

    this.els.updateBar?.addEventListener('click', () => this.applyUpdate());

    // Flush on hide/close: mobile users switch apps constantly.
    // saveDraft is sync (localStorage) so it always runs; save() is async best-effort.
    // The place in the note too: an app killed in the background never gets to leave the note.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      this.rememberPlace();
      if (this.isDirty) {
        this.saveDraft();
        this.save();
      }
    });
    window.addEventListener('pagehide', () => {
      this.rememberPlace();
      if (this.isDirty) this.saveDraft();
    });
  },
};

// ── Start ──
document.addEventListener('DOMContentLoaded', () => App.init());

