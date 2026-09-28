// Drive Notes: the home screen, which is the vault tree. Extends App (see app/core.js).

const TREE_CHEVRON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

Object.assign(App, {
  // ── Getting here ──

  /** The folder button of an open note. The vault is the home screen, and the home screen is the bottom
      of the back stack: nothing is left behind it, so "back" from here leaves the app. */
  openHome() {
    this.navStack = [];
    this.fwdStack = [];
    this._pending = null;
    this.goHome();
    this.armWatcher();
  },

  // ── Sections that fold (recents, drafts) ──

  /** A tap on the title of a section: show or hide its list. Folded on every opening of the app. */
  toggleHomeSection(button) {
    const list = button.parentElement.querySelector('ul');
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    if (list) list.hidden = !open;
  },

  // ── Menu (the three dots) ──
  // A dialog like the others (.modal-overlay): the system back button closes it through its data-dismiss.

  openMenu() {
    document.getElementById('menu-version').textContent = this._version.replace(/drivenotes-/g, '');
    this.renderAccount();
    this.drawMenuSwitch();
    document.getElementById('menu-overlay').classList.add('visible');
    this.armWatcher();
  },

  closeMenu() {
    document.getElementById('menu-overlay').classList.remove('visible');
    this.armWatcher();
  },

  drawMenuSwitch() {
    document.getElementById('menu-system').setAttribute('aria-checked', String(this.showsSystemFolders()));
  },

  /** The switch of the menu: CONFIG.HIDDEN_FOLDERS in the tree, or out of it. The menu stays open. */
  toggleSystemFolders() {
    try {
      if (this.showsSystemFolders()) localStorage.removeItem(KEYS.SHOW_SYSTEM);
      else localStorage.setItem(KEYS.SHOW_SYSTEM, '1');
    } catch (e) {
      console.warn('The system folders switch could not be kept:', e);
    }
    this.drawMenuSwitch();
    this.drawTree();
  },

  // ── The vault tree ──
  // Folders open in place, the way Obsidian's file tree does. Opening one is not a navigation: nothing
  // goes on the back stack, so "back" on the home screen still leaves the app.
  //
  // open: ids of the folders left open. shown: how many items each open folder shows. seq: the latest
  // listing asked of each folder, so a late answer never draws. loading: folders with a listing on its
  // way. failed: folders whose listing failed with nothing kept to show. scroll and restore: how far
  // down the screen was, and whether the next drawing should go back there.
  _tree: { open: new Set(), shown: new Map(), seq: new Map(), loading: new Set(), failed: new Set(), scroll: 0, restore: false },

  /** A JSON value kept on the device, or `fallback` when there is none or it does not parse */
  readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },

  /** Read what the device kept of the tree. Whatever is there may be from an older version, or broken. */
  initTree() {
    const open = this.readJson(KEYS.TREE_OPEN, []);
    this._tree.open = new Set(Array.isArray(open) ? open.filter((id) => typeof id === 'string') : []);
    const kept = this.readJson(KEYS.TREE_LISTINGS, {});
    for (const [id, items] of Object.entries(kept && typeof kept === 'object' ? kept : {})) {
      if (!Array.isArray(items) || this._folderCache.has(id)) continue;
      this._folderCache.set(id, items.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string'));
    }
    this._tree.scroll = Number(localStorage.getItem(KEYS.TREE_SCROLL)) || 0;
  },

  /** Keep the open folders and what is in view. A full or blocked storage only costs the memory. */
  saveTree() {
    try {
      localStorage.setItem(KEYS.TREE_OPEN, JSON.stringify([...this._tree.open]));
      const kept = {};
      for (const id of [CONFIG.VAULT_FOLDER_ID, ...this.openFoldersInView()]) {
        const items = this._folderCache.get(id);
        if (items) kept[id] = items;
      }
      localStorage.setItem(KEYS.TREE_LISTINGS, JSON.stringify(kept));
    } catch (e) {
      console.warn('The home tree could not be kept:', e);
    }
  },

  showsSystemFolders() {
    return localStorage.getItem(KEYS.SHOW_SYSTEM) === '1';
  },

  /** What a folder shows in the tree, or null while the app has never seen it */
  treeItems(folderId) {
    const items = this._folderCache.get(folderId);
    if (!items) return null;
    if (this.showsSystemFolders()) return items;
    return items.filter((item) => !(item.isFolder && CONFIG.HIDDEN_FOLDERS.includes(item.name)));
  },

  /** The open folders that are really on screen: open ones reached from the root through open ones.
      A folder that left the Drive, or whose parent is closed, is not among them. */
  openFoldersInView() {
    const found = [];
    const walk = (id, above) => {
      for (const item of this.treeItems(id) || []) {
        if (!item.isFolder || !this._tree.open.has(item.id) || above.includes(item.id)) continue;
        found.push(item.id);
        walk(item.id, [...above, item.id]);
      }
    };
    walk(CONFIG.VAULT_FOLDER_ID, [CONFIG.VAULT_FOLDER_ID]);
    return found;
  },

  /** What scrolls on the home screen */
  homeScroller() {
    return document.getElementById('home-scroll') || this.els.welcome;
  },

  /** Called right before the home screen is left, or the app goes to the background */
  rememberHomeScroll() {
    if (document.body.dataset.view !== 'welcome') return;
    this._tree.scroll = this.homeScroller().scrollTop;
    try {
      localStorage.setItem(KEYS.TREE_SCROLL, String(this._tree.scroll));
    } catch (e) {
      console.warn('The home scroll could not be kept:', e);
    }
  },

  /** Everything the home screen shows */
  renderHome() {
    this.renderDrafts();
    this.renderRecents();
    this.renderTree();
  },

  showTreeLogin(show) {
    const login = document.getElementById('tree-login');
    const tree = document.getElementById('tree');
    if (login) login.hidden = !show;
    if (tree) tree.hidden = show;
  },

  /** The tree, from what the device kept, and a fresh listing of everything in view behind it.
      Without a login there is no Drive to list: the "Entrar" button takes the tree's place. */
  renderTree() {
    const signedIn = this.hasValidToken() || !!localStorage.getItem(KEYS.REFRESH_TOKEN);
    this.showTreeLogin(!signedIn);
    if (!signedIn) return;
    this.drawTree();
    this.loadTreeFolder(CONFIG.VAULT_FOLDER_ID);
    this.openFoldersInView().forEach((id) => this.loadTreeFolder(id));
  },

  /** The "Entrar" button: a tap, the only moment the login popup is allowed to open */
  async loginFromTree() {
    try {
      await this.ensureAuth();
    } catch (e) {
      console.warn('Login from the home screen failed:', e);
      this.setSaveStatus('error', 'Faça login primeiro');
      return;
    }
    this.setSaveStatus('', '');
    this.renderAccount();
    this.renderHome();
  },

  /** Ask the Drive what a folder holds. Never opens the login popup: this runs outside a tap too. */
  async loadTreeFolder(folderId) {
    const tree = this._tree;
    const seq = (tree.seq.get(folderId) || 0) + 1;
    tree.seq.set(folderId, seq);
    tree.loading.add(folderId);
    tree.failed.delete(folderId);
    this.drawTree();

    let items = null;
    let loginNeeded = false;
    try {
      await this.ensureAuth({ quiet: true });
      items = await this.driveListFolder(folderId);
    } catch (e) {
      console.error('Failed to list folder:', e);
      loginNeeded = e?.code === 'login_needed';
    }
    if (tree.seq.get(folderId) !== seq) return; // a newer listing of this folder is on its way

    tree.loading.delete(folderId);
    if (items) {
      this._folderCache.set(folderId, items);
      this.saveTree();
    } else if (loginNeeded && !this._folderCache.has(CONFIG.VAULT_FOLDER_ID)) {
      this.showTreeLogin(true);
      return;
    } else if (!this._folderCache.has(folderId)) {
      tree.failed.add(folderId);
    }
    this.drawTree();
  },

  /** A tap on a folder: open it, close it, or try again if its listing had failed */
  toggleTreeFolder(item, folder) {
    const tree = this._tree;
    if (tree.open.has(item.id) && tree.failed.has(item.id)) {
      this.loadTreeFolder(item.id);
      return;
    }
    if (tree.open.has(item.id)) {
      tree.open.delete(item.id);
      tree.shown.delete(item.id);
    } else {
      tree.open.add(item.id);
      // The tree only walks down from the vault root, so it knows where this folder sits without asking
      if (!this._folderTrails.has(item.id)) this._folderTrails.set(item.id, [...folder.path, folder.name, item.name].slice(1));
      this.loadTreeFolder(item.id);
    }
    this.saveTree();
    this.drawTree();
  },

  /** Draw the whole tree again, and leave the screen scrolled where it was */
  drawTree() {
    const list = document.getElementById('tree-list');
    if (!list) return;
    const scroller = this.homeScroller();
    const top = this._tree.restore ? this._tree.scroll : scroller.scrollTop;
    list.innerHTML = '';
    const root = { id: CONFIG.VAULT_FOLDER_ID, name: CONFIG.VAULT_NAME, path: [] };
    this.drawTreeLevel(list, root, [root.id]);
    scroller.scrollTop = top;
    if (list.querySelector('.tree-row')) this._tree.restore = false;
  },

  /** The rows of one folder into `list`. `above` holds the ids from the root down to this folder: a
      folder never opens inside itself, whatever the listings say. */
  drawTreeLevel(list, folder, above) {
    const items = this.treeItems(folder.id);
    const say = (text) => {
      const li = document.createElement('li');
      li.className = 'tree-message';
      li.textContent = text;
      list.appendChild(li);
    };
    if (!items) {
      if (this._tree.failed.has(folder.id)) {
        say('Erro ao carregar a pasta');
        return;
      }
      for (let i = 0; i < 3; i++) {
        const li = document.createElement('li');
        li.className = 'tree-skeleton';
        li.setAttribute('aria-hidden', 'true');
        list.appendChild(li);
      }
      return;
    }
    if (!items.length) {
      say('Pasta vazia');
      return;
    }

    const shown = this._tree.shown.get(folder.id) || CONFIG.TREE_PAGE;
    for (const item of items.slice(0, shown)) {
      list.appendChild(this.treeRow(item, folder));
      if (!item.isFolder || !this._tree.open.has(item.id) || above.includes(item.id)) continue;
      const branch = document.createElement('li');
      branch.className = 'tree-branch';
      const children = document.createElement('ul');
      children.className = 'tree-children';
      this.drawTreeLevel(children, { id: item.id, name: item.name, path: [...folder.path, folder.name] }, [...above, item.id]);
      branch.appendChild(children);
      list.appendChild(branch);
    }
    if (items.length > shown) list.appendChild(this.treeMore(folder, items.length - shown, shown));
  },

  /** One row: a folder (an arrow and the name) or a note (the name alone, without the .md) */
  treeRow(item, folder) {
    const open = item.isFolder && this._tree.open.has(item.id);
    const li = document.createElement('li');
    li.className = 'tree-row' + (item.isFolder ? ' is-folder' : '') + (open ? ' is-open' : '');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tree-item';
    if (item.isFolder) {
      button.setAttribute('aria-expanded', String(open));
      button.insertAdjacentHTML('beforeend', TREE_CHEVRON);
    }
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = item.isFolder ? item.name : item.name.replace(/\.md$/i, '');
    button.appendChild(name);
    if (open && this._tree.loading.has(item.id) && !this._folderCache.has(item.id)) {
      const loading = document.createElement('span');
      loading.className = 'tree-loading';
      loading.textContent = 'carregando';
      button.appendChild(loading);
    }

    button.addEventListener('click', () => {
      if (item.isFolder) this.toggleTreeFolder(item, folder);
      else this.navigateTo(item.id, item.name);
    });
    li.appendChild(button);
    return li;
  },

  /** The "Ver mais" row at the end of a folder that holds more than it shows */
  treeMore(folder, left, shown) {
    const li = document.createElement('li');
    li.className = 'tree-more';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tree-item';
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = 'Ver mais';
    const count = document.createElement('span');
    count.className = 'tree-more-count';
    count.textContent = String(left);
    button.append(name, count);
    button.addEventListener('click', () => {
      this._tree.shown.set(folder.id, shown + CONFIG.TREE_PAGE);
      this.drawTree();
    });
    li.appendChild(button);
    return li;
  },
});
