// Drive Notes: the search, from the field at the bottom of the home screen. Extends App (see app/core.js).

Object.assign(App, {
  // ── Search ──
  // One field, two reaches. What is typed is matched at once against the names the device knows (the
  // note index, the one the link list uses). After a pause the same text goes to the Drive, which looks
  // at names and at the text of the notes. Only notes inside the vault are shown, each with the folder
  // it lives in. The search is a state of the home screen, not a view: opening and closing it is not a
  // navigation, and the back stack never hears of it.

  // open: the results are in the tree's place. query: the text of the field, kept while the app is
  // open, so that "back" from a result finds the search as it was.
  _homeSearch: { open: false, query: '' },

  /** Lower case, no accents: "Relatório" is found by "relatorio" */
  plain(text) {
    return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  },

  searchWords(query) {
    return (query || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  },

  /** The field took the focus: the results take the tree's place */
  openHomeSearch() {
    const search = this._homeSearch;
    if (search.open) return;
    this.rememberHomeScroll(); // before the tree is hidden: hidden, it forgets how far it was scrolled
    search.open = true;
    this.drawHomeSearch();
    this.armWatcher();
    this.loadSearchIndex();
  },

  /** The names the device knows. With none kept yet this builds the index from the Drive, which may ask
      for the login: the call comes from a tap on the field. */
  async loadSearchIndex() {
    try {
      await this.noteIndex();
    } catch (e) {
      console.warn('Note index not loaded for the search:', e);
      return;
    }
    if (this._homeSearch.open) this.drawHomeSearch();
  },

  /** Forget the search without drawing anything: the state, the field, and whatever was on its way */
  resetHomeSearch() {
    clearTimeout(this._searchTimer);
    this._searchSeq++;
    this._search = null;
    this._homeSearch.open = false;
    this._homeSearch.query = '';
    this.els.homeSearch.value = '';
    this.els.homeSearch.blur();
  },

  /** The X, the system back button, the swipe from the left edge: the tree comes back as it was */
  closeHomeSearch() {
    if (!this._homeSearch.open) return;
    this.resetHomeSearch();
    this.drawHomeSearch();
    this._tree.restore = true;
    // A login made on the way (the index asked for it) leaves the "Entrar" button behind: list the tree then
    if (document.getElementById('tree')?.hidden) this.renderTree();
    else this.drawTree();
    this.armWatcher();
    // A new version that waited for the search to close
    this.offerUpdate();
  },

  onSearchInput() {
    if (!this._homeSearch.open) this.openHomeSearch();
    this._homeSearch.query = this.els.homeSearch.value;
    this.searchVault();
    this.drawHomeSearch();
  },

  /** Line up the vault search for the text in the field. `now` skips the pause (the search key was pressed). */
  searchVault({ now = false } = {}) {
    clearTimeout(this._searchTimer);
    const seq = ++this._searchSeq;
    const words = this.searchWords(this._homeSearch.query);
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
      if (this._homeSearch.open) this.drawHomeSearch();
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
      .map(({ f, trail }) => ({
        id: f.id,
        name: f.name,
        where: trail.join(' / ') || CONFIG.VAULT_NAME,
        inName: plainWords.every(w => this.plain(f.name).includes(w)),
      }))
      .sort((a, b) => b.inName - a.inName);
  },

  /** Notes the device knows by name, every word somewhere in it. Names that start with the first word
      come first; inside each group, the most recently edited. */
  indexMatches(words, limit = 20) {
    const plainWords = words.map(w => this.plain(w));
    if (!plainWords.length) return [];
    const ranked = [];
    for (const note of this._noteIndex || []) {
      const title = this.plain(note.name.replace(/\.md$/i, ''));
      if (!plainWords.every(w => title.includes(w))) continue;
      ranked.push({ note, rank: title.startsWith(plainWords[0]) ? 0 : 1 });
    }
    ranked.sort((a, b) => a.rank - b.rank || (b.note.modifiedTime || '').localeCompare(a.note.modifiedTime || ''));
    return ranked.slice(0, limit).map(({ note }) => ({ id: note.id, name: note.name, where: note.where, inName: true }));
  },

  /** `name` as nodes, the stretches that match a word of the search inside a .search-hit. Matched the
      way the search matches, with neither accents nor case. Never innerHTML: a name is text. */
  markedName(name, words) {
    // The plain text, and for each character of it the character of `name` it came from
    let flat = '';
    const from = [];
    for (let i = 0; i < name.length; i++) {
      for (const c of this.plain(name[i])) {
        flat += c;
        from.push(i);
      }
    }
    const marked = new Array(name.length).fill(false);
    for (const word of words.map(w => this.plain(w)).filter(Boolean)) {
      for (let at = flat.indexOf(word); at !== -1; at = flat.indexOf(word, at + word.length)) {
        for (let k = at; k < at + word.length; k++) marked[from[k]] = true;
      }
    }
    // A combining mark (a name in decomposed form) goes with the letter it sits on
    for (let i = 1; i < name.length; i++) {
      if (!this.plain(name[i])) marked[i] = marked[i - 1];
    }

    const nodes = document.createDocumentFragment();
    for (let i = 0; i < name.length;) {
      let end = i;
      while (end < name.length && marked[end] === marked[i]) end++;
      const text = name.slice(i, end);
      if (marked[i]) {
        const hit = document.createElement('span');
        hit.className = 'search-hit';
        hit.textContent = text;
        nodes.appendChild(hit);
      } else {
        nodes.appendChild(document.createTextNode(text));
      }
      i = end;
    }
    return nodes;
  },

  /** What the search shows, best first: the names the device knows, then what the Drive found beyond them */
  searchHits(words) {
    const known = this.indexMatches(words);
    const seen = new Set(known.map(item => item.id));
    return [...known, ...(this._search?.results || []).filter(item => !seen.has(item.id))];
  },

  /** The search as it is now: which of the two lists shows, the bar, the header, and the results. The
      list is drawn from the bottom up (column-reverse in the stylesheet): its first row is the one
      next to the field, the closest to the thumb, then the message, and the count on top. */
  drawHomeSearch() {
    const { open, query } = this._homeSearch;
    const list = document.getElementById('home-results');
    if (!list) return;
    document.getElementById('home-scroll').hidden = open;
    list.hidden = !open;
    document.getElementById('welcome-new').hidden = open;
    document.getElementById('home-search-close').hidden = !open;
    document.getElementById('home-label').textContent = open ? 'busca' : CONFIG.VAULT_NAME;
    this.drawCollapseButton();
    list.innerHTML = '';
    if (!open) return;

    const words = this.searchWords(query);
    const hits = this.searchHits(words);
    hits.forEach(item => list.appendChild(this.searchRow(item, words)));

    const say = (className, text) => {
      const li = document.createElement('li');
      li.className = className;
      li.textContent = text;
      list.appendChild(li);
    };
    const search = this._search;
    if (!words.length) say('search-message', 'Digite pra buscar no vault');
    else if (search && !search.results && !search.failed) say('search-message', 'Buscando...');
    else if (search?.failed) say('search-message', 'Não deu pra buscar no texto das notas. Sem conexão?');
    else if (!hits.length && !search) say('search-message', 'Nada com esse nome. Com 3 letras ou mais, a busca olha também o texto das notas.');
    else if (!hits.length) say('search-message', 'Nada encontrado no vault.');
    if (hits.length) say('search-count', hits.length === 1 ? '1 nota' : `${hits.length} notas`);
  },

  /** One result: the name, with what matched marked, and under it the folder the note lives in */
  searchRow(item, words) {
    const li = document.createElement('li');
    li.className = 'search-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-item';
    const name = document.createElement('span');
    name.className = 'search-name';
    name.appendChild(this.markedName(item.name.replace(/\.md$/i, ''), words));
    const where = document.createElement('span');
    where.className = 'search-where';
    where.textContent = item.inName ? item.where : `${item.where} · no texto`;
    button.append(name, where);
    button.addEventListener('click', () => {
      this.els.homeSearch.blur();
      this.navigateTo(item.id, item.name);
    });
    li.appendChild(button);
    return li;
  },
});
