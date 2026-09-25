// Drive Notes: the file browser and the search. Extends App (see app/core.js).

Object.assign(App, {
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
    this._opening = null;
    this.currentFile = null;
    this.isDirty = false;
    this.folder = folder;
    // The browser only walks down from the vault root, so it knows where this folder sits without asking
    if (!this._folderTrails.has(folder.id)) this._folderTrails.set(folder.id, [...folder.path, folder.name].slice(1));
    this.els.browserSearch.value = folder.query || '';
    this.searchVault();
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
    this._listing = { folder, items, message };
    this.drawBrowser();
  },

  /** Draw the folder through the search field: what matches in the folder itself, then in the whole vault */
  drawBrowser() {
    const { folder, items, message } = this._listing;
    const pathEl = document.getElementById('browser-path');
    const list = document.getElementById('browser-list');
    // The element is right-to-left so a long path is cut at the start; the marks keep the text itself left-to-right
    pathEl.textContent = `‎${[...folder.path, folder.name].join(' / ')}‎`;
    list.innerHTML = '';

    const words = this.searchWords(folder.query).map(w => this.plain(w));
    const shown = (items || []).filter(item => words.every(w => this.plain(item.name).includes(w)));
    shown.forEach(item => list.appendChild(this.browserRow(item, folder)));

    const say = (text) => {
      const li = document.createElement('li');
      li.className = 'browser-message';
      li.textContent = text;
      list.appendChild(li);
    };
    if (!words.length || !items) {
      if (message) say(message);
      return;
    }

    const search = this._search;
    if (!search) {
      if (!shown.length) say('Nada nesta pasta com esse nome. Com 3 letras ou mais, a busca vai pro vault inteiro.');
      return;
    }
    if (search.failed) {
      say('Não deu pra buscar no vault inteiro. Sem conexão?');
      return;
    }
    const here = new Set(shown.map(item => item.id));
    const found = (search.results || []).filter(item => !here.has(item.id));
    if (search.results && !found.length) {
      if (!shown.length) say('Nada encontrado, nem nesta pasta nem no resto do vault.');
      return;
    }

    const title = document.createElement('li');
    title.className = 'browser-section';
    title.textContent = 'No vault inteiro';
    list.appendChild(title);
    if (!search.results) say('Buscando...');
    found.forEach(item => list.appendChild(this.browserRow(item, folder)));
  },

  /** One line of the browser. A search result (`item.where`) also says which folder the note lives in. */
  browserRow(item, folder) {
    const li = document.createElement('li');
    li.className = 'browser-item' + (item.isFolder ? ' is-folder' : '') + (item.where ? ' is-result' : '');

    const icon = document.createElement('span');
    icon.className = 'browser-icon';
    icon.textContent = item.isFolder ? '\u{1F4C1}' : '';
    li.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'browser-name';
    name.textContent = item.isFolder ? item.name : item.name.replace(/\.md$/i, '');
    if (item.where) {
      const main = document.createElement('span');
      main.className = 'browser-main';
      const where = document.createElement('span');
      where.className = 'browser-where';
      where.textContent = item.where;
      main.append(name, where);
      li.appendChild(main);
    } else {
      li.appendChild(name);
    }

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
    return li;
  },

  // ── Search ──
  // One field, two reaches. The open folder is filtered as the text is typed, on the device. After a pause
  // the same text goes to the Drive, which looks at names and at the text of the notes; only notes inside
  // the vault are shown, each with the folder it lives in.

  /** Lower case, no accents: "Relatório" is found by "relatorio" */
  plain(text) {
    return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  },

  searchWords(query) {
    return (query || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  },

  onSearchInput() {
    if (!this.folder || this.currentFile) return;
    this.folder.query = this.els.browserSearch.value;
    this.syncHistory(); // "back" from a result returns to this search
    this.searchVault();
    this.drawBrowser();
  },

  /** Line up the vault search for the text in the field. `now` skips the pause (the search key was pressed). */
  searchVault({ now = false } = {}) {
    clearTimeout(this._searchTimer);
    const seq = ++this._searchSeq;
    const words = this.searchWords(this.folder?.query);
    const query = words.join(' ').toLowerCase();
    if (query.length < 3) {
      this._search = null;
      return;
    }
    if (this._searchCache.has(query)) {
      this._search = { query, results: this._searchCache.get(query) };
      return;
    }

    this._search = { query, results: null };
    this._searchTimer = setTimeout(async () => {
      let results = null;
      try {
        results = await this.findNotes(words);
        this._searchCache.set(query, results);
      } catch (e) {
        console.error('Vault search failed:', e);
      }
      if (seq !== this._searchSeq) return; // the text has changed since
      this._search = { query, results, failed: !results };
      if (this.folder && !this.currentFile) this.drawBrowser();
    }, now ? 0 : CONFIG.SEARCH_DELAY);
  },

  /** Notes of the vault with every word in the name or in the text: name matches first */
  async findNotes(words) {
    const files = (await this.driveSearch(words)).filter(f => this.isNote(f));
    const placed = await Promise.all(files.map(async (f) => {
      const parent = f.parents?.[0];
      const trail = parent ? await Promise.resolve(this.folderTrail(parent)).catch(() => null) : null;
      return { f, trail };
    }));

    const plainWords = words.map(w => this.plain(w));
    return placed
      // Outside the vault, or inside a dot-folder (.obsidian, .trash): not a note of the vault
      .filter(({ trail }) => trail && !trail.some(name => name.startsWith('.')))
      .map(({ f, trail }) => {
        const inName = plainWords.every(w => this.plain(f.name).includes(w));
        const where = trail.join(' / ') || CONFIG.VAULT_NAME;
        return { id: f.id, name: f.name, isFolder: false, modifiedTime: f.modifiedTime, inName, where: inName ? where : `${where} · no texto` };
      })
      .sort((a, b) => b.inName - a.inName);
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
});
