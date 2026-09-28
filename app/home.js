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
  // down the screen was, and whether the next drawing should go back there. ahead and fetching: the
  // folders waiting to be asked for one level ahead of the taps, and the ones on their way (see askAhead).
  _tree: { open: new Set(), shown: new Map(), seq: new Map(), loading: new Set(), failed: new Set(), scroll: 0, restore: false, ahead: [], fetching: new Set() },

  // How long the tree waits on the Drive, for the diagnostics panel. Memory only, and kept out of the
  // _log: its 60 lines are the navigation's, and the listings of one opening would fill them.
  // count and trips: every listing asked (taps and ahead) and the last 200 durations, in ms. taps: the
  // last 10 taps that opened a folder, { name, wait, failed }. waiting: folder id -> { name, at } of a
  // tap whose rows are not on screen yet.
  _treeTimes: { count: 0, trips: [], taps: [], waiting: new Map() },

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
    // Waiting in the queue ahead: this listing takes its place
    tree.ahead = tree.ahead.filter((id) => id !== folderId);
    this.drawTree();

    let items = null;
    let loginNeeded = false;
    try {
      await this.ensureAuth({ quiet: true });
      items = await this.listTreeFolder(folderId);
    } catch (e) {
      console.error('Failed to list folder:', e);
      loginNeeded = e?.code === 'login_needed';
    }
    if (tree.seq.get(folderId) !== seq) return; // a newer listing of this folder is on its way

    tree.loading.delete(folderId);
    if (items) {
      this._folderCache.set(folderId, items);
      this.saveTree();
      this.askAhead(folderId);
    } else if (loginNeeded && !this._folderCache.has(CONFIG.VAULT_FOLDER_ID)) {
      this.showTreeLogin(true);
      return;
    } else if (!this._folderCache.has(folderId)) {
      tree.failed.add(folderId);
    }
    this.drawTree();
  },

  /** driveListFolder, timed for the diagnostics panel */
  async listTreeFolder(folderId) {
    const times = this._treeTimes;
    const start = Date.now();
    try {
      return await this.driveListFolder(folderId);
    } finally {
      times.count++;
      times.trips.push(Date.now() - start);
      if (times.trips.length > 200) times.trips.shift();
    }
  },

  // ── One level ahead ──
  // Each folder opened for the first time used to be a trip to the Drive begun by the tap, half a second
  // to more than one on the phone, with grey bars meanwhile. Now, once a folder is listed (or opened from
  // what is kept), the folders the tree shows inside it are asked for behind the user's back. One level
  // only: what arrives this way asks for nothing more, or the app would walk the whole vault.

  /** Queue the folders shown inside `folderId` that the app has never listed. Only a folder on screen
      counts, and only what it shows: hidden system folders and whatever sits past "Ver mais" stay out. */
  askAhead(folderId) {
    const tree = this._tree;
    if (!this.canRenewQuietly()) return;
    if (folderId !== CONFIG.VAULT_FOLDER_ID && !this.openFoldersInView().includes(folderId)) return;
    const items = this.treeItems(folderId) || [];
    for (const item of items.slice(0, tree.shown.get(folderId) || CONFIG.TREE_PAGE)) {
      if (!item.isFolder || this._folderCache.has(item.id) || tree.loading.has(item.id)
        || tree.fetching.has(item.id) || tree.ahead.includes(item.id)) continue;
      tree.ahead.push(item.id);
    }
    this.pumpAhead();
  },

  /** Start what the queue holds, CONFIG.TREE_AHEAD at a time */
  pumpAhead() {
    const tree = this._tree;
    while (tree.fetching.size < CONFIG.TREE_AHEAD && tree.ahead.length) this.fetchAhead(tree.ahead.shift());
  },

  /** One listing asked ahead. Silent: no bars, no "carregando", no error, no "Entrar", and it never
      touches seq. A failure is forgotten (a later round may ask again); a login that cannot be had
      without a window empties the queue, since nothing behind it would get through either. */
  async fetchAhead(folderId) {
    const tree = this._tree;
    tree.fetching.add(folderId);
    let items = null;
    try {
      await this.ensureAuth({ quiet: true });
    } catch (e) {
      console.warn('No login for the folders ahead:', e);
      tree.ahead = [];
      tree.fetching.delete(folderId);
      return;
    }
    try {
      items = await this.listTreeFolder(folderId);
    } catch (e) {
      console.warn('A folder asked ahead failed:', e);
    }
    tree.fetching.delete(folderId);
    this.pumpAhead();
    // A listing already there came from a tap, and is as new as this one or newer
    if (!items || this._folderCache.has(folderId)) return;
    this._folderCache.set(folderId, items);
    // Only an open folder in view changes what is on screen: the rest waits in memory for its tap
    if (this.openFoldersInView().includes(folderId)) this.drawTree();
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
      this._treeTimes.waiting.delete(item.id);
    } else {
      tree.open.add(item.id);
      // The tree only walks down from the vault root, so it knows where this folder sits without asking
      if (!this._folderTrails.has(item.id)) this._folderTrails.set(item.id, [...folder.path, folder.name, item.name].slice(1));
      if (this._folderCache.has(item.id)) this.noteTreeTap(item.name, 0, false);
      else this._treeTimes.waiting.set(item.id, { name: item.name, at: Date.now() });
      this.loadTreeFolder(item.id);
      // What is kept is enough to know the folders inside: they need not wait for the fresh listing
      this.askAhead(item.id);
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
    this.noteTreeWaits();
  },

  /** The taps whose folder now shows its rows (or its error): how long they waited, into the panel */
  noteTreeWaits() {
    const times = this._treeTimes;
    for (const [id, tap] of times.waiting) {
      const failed = this._tree.failed.has(id);
      if (!this._folderCache.has(id) && !failed) continue;
      times.waiting.delete(id);
      this.noteTreeTap(tap.name, Date.now() - tap.at, failed);
    }
  },

  /** One tap into the panel's last 10. A folder already listed is 0: its rows are drawn by the tap itself. */
  noteTreeTap(name, wait, failed) {
    const taps = this._treeTimes.taps;
    taps.push({ name, wait, failed });
    if (taps.length > 10) taps.shift();
  },

  /** The lines of the diagnostics panel about the tree's trips to the Drive */
  treeTimesReport() {
    const { count, trips, taps } = this._treeTimes;
    const sorted = [...trips].sort((a, b) => a - b);
    const half = sorted.length >> 1;
    const middle = sorted.length % 2 ? sorted[half] : Math.round((sorted[half - 1] + sorted[half]) / 2);
    const lines = [count
      ? `árvore: ${count} ${count === 1 ? 'ida' : 'idas'} ao Drive, mediana ${middle} ms, pior ${sorted[sorted.length - 1]} ms`
      : 'árvore: nenhuma ida ao Drive'];
    if (taps.length) {
      lines.push('toques em pasta (espera até as linhas):');
      for (const tap of taps) lines.push(`  ${tap.name}: ${tap.failed ? 'erro em ' : ''}${tap.wait} ms`);
    }
    return lines;
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
      this.askAhead(folder.id);
    });
    li.appendChild(button);
    return li;
  },
});
