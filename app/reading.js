// Drive Notes: the reading view, the place in the note, long press, table of contents and peek. Extends App (see app/core.js).

Object.assign(App, {
  // ── Where the reading stopped (localStorage) ──
  //
  // A note opens in the reading view where it was left, instead of at the top. What is kept is the block
  // at the top of the screen and how far into it, not the scroll in pixels: pictures come from the Drive
  // after the note shows, so a pixel count taken with them in place lands too far down while they are
  // still on their way. Anchored to a block, the note lands on the same paragraph, and the browser's
  // scroll anchoring holds it there as the pictures above grow. Per device, for the last 20 notes, like the
  // recents. A note changed on the computer in between may land a little off: accepted.

  getPlaces() {
    try {
      return JSON.parse(localStorage.getItem(KEYS.PLACES)) || [];
    } catch {
      return [];
    }
  },

  /** Keep where the reading view is, for the note it shows. Called whenever that note is about to be
      left: another view (flushCurrent), "Editar", the app going to the background, the reload into a
      new version. */
  rememberPlace() {
    const file = this._previewOf;
    const container = this.els.previewContainer;
    const blocks = [...container.children];
    if (!file?.id || document.body.dataset.view !== 'preview' || !blocks.length) return;
    const top = container.getBoundingClientRect().top;
    // The first block still on screen: everything before it is above the top (a hidden one is never on screen)
    const block = blocks.findIndex((el) => !el.hidden && el.getBoundingClientRect().bottom > top);
    const places = this.getPlaces().filter((p) => p.id !== file.id);
    // Left at the top, there is nothing to keep: that is where a note opens anyway
    if (container.scrollTop > 0 && block >= 0) {
      places.unshift({ id: file.id, block, into: Math.round(top - blocks[block].getBoundingClientRect().top) });
    }
    try {
      localStorage.setItem(KEYS.PLACES, JSON.stringify(places.slice(0, 20)));
    } catch { /* storage full or blocked: the note opens at the top, as it always did */ }
  },

  /** A note just drawn in the reading view: to the heading a link asked for, or else back where it was left */
  landInNote(heading) {
    if (heading) {
      this.scrollToHeading(heading);
      return;
    }
    const container = this.els.previewContainer;
    const blocks = container.children;
    const place = this.getPlaces().find((p) => p.id === this.currentFile?.id);
    if (!place || !blocks.length) return;
    // Fewer blocks than when it was left (it changed on the computer): the last one
    const kept = Math.min(place.block, blocks.length - 1);
    const i = this.shownBlockAt(blocks, kept);
    const el = blocks[i];
    // A block hidden now (a board's column that opens folded) has no place of its own: the one before it
    const into = i === kept ? place.into : 0;
    container.scrollTop += el.getBoundingClientRect().top - container.getBoundingClientRect().top + into;
    this.log(`resume block ${place.block}`);
  },

  // ── The same stretch in both modes ──
  //
  // "Editar" opens the editor on the stretch of the note that was at the top of the reading view, and
  // "Ler" does the reverse: switching modes never throws the screen back to the top of the note. The two
  // views meet in the note's lines. Each block of the reading view knows the lines it comes from
  // (noteBlocks), and the editor speaks lines (Editor.topLine, Editor.showLine).

  // Both views start their text 16px below the top edge (the padding in the style.css), and that is the
  // height where "the top of the screen" is read and written: going back and forth does not creep
  VIEW_INSET: 16,

  /** The lines each block of the reading view comes from, in screen order: [{ from, to }], counted from 1
      like the editor's, the property block first when there is one. The blocks are cut by the renderer's
      own tokenizer, so they are the ones renderPreview draws; what draws nothing is skipped: blank lines,
      link definitions, and raw HTML the sanitizer leaves empty (a comment, a web clipping's iframe). Those
      two were 290 of the vault's 2380 notes, measured in 22 set 2026. What still does not match is HTML
      that opens in one block and closes in another (a clipping wrapped in a <div>): see readingBlocks. */
  noteBlocks(content) {
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return [];
    const { frontmatter, body } = this.splitFrontmatter(content);
    const newlines = (s) => s.split('\n').length - 1;
    const drawsNothing = (token) => {
      if (token.type === 'space' || token.type === 'def') return true;
      if (token.type !== 'html') return false;
      const probe = document.createElement('template');
      probe.innerHTML = DOMPurify.sanitize(token.raw);
      return probe.content.children.length === 0;
    };
    const head = content.slice(0, content.length - body.length);
    const blocks = frontmatter ? [{ from: 1, to: newlines(head.replace(/\n$/, '')) + 1 }] : [];
    let line = 1 + newlines(head);
    for (const token of marked.lexer(body)) {
      if (!drawsNothing(token)) {
        blocks.push({ from: line, to: line + newlines(token.raw.replace(/\n+$/, '')) });
      }
      line += newlines(token.raw);
    }
    return blocks;
  },

  /** noteBlocks for the reading view on screen. When the count does not match what is drawn (raw HTML in
      the note can draw more or fewer elements than it has blocks), the note is shared out evenly over the
      blocks instead: rougher, but still near the stretch. */
  readingBlocks() {
    const count = this.els.previewContainer.children.length;
    const content = this.getContent();
    const blocks = this.noteBlocks(content);
    if (blocks.length === count) return blocks;
    this.log(`blocks ${blocks.length} drawn ${count}`);
    const total = content.split('\n').length;
    return Array.from({ length: count }, (_, i) => {
      const from = 1 + Math.floor(i * total / count);
      return { from, to: Math.max(from, Math.floor((i + 1) * total / count)) };
    });
  },

  /** The line at the top of the reading view, with the share of it already scrolled past */
  readingTopLine() {
    const container = this.els.previewContainer;
    const els = [...container.children];
    if (!els.length) return null;
    const probe = container.getBoundingClientRect().top + this.VIEW_INSET;
    // Hidden blocks (a board's folded cards, its settings) take no room and are never the top
    let i = els.findIndex((el) => !el.hidden && el.getBoundingClientRect().bottom > probe);
    if (i < 0) i = this.shownBlockAt(els, els.length - 1);
    const { from, to } = this.readingBlocks()[i];
    const rect = els[i].getBoundingClientRect();
    const height = rect.bottom - rect.top;
    const share = height > 0 ? Math.min(Math.max((probe - rect.top) / height, 0), 0.999) : 0;
    return from + share * (to - from + 1);
  },

  /** Block `i`, or the nearest one before it that is shown: a hidden block measures 0 and cannot be scrolled
      to. Only a board hides blocks (decorateKanban); its column headings never are, so a folded card lands
      on its column. Nothing shown before it: the first shown block after. */
  shownBlockAt(els, i) {
    for (let j = i; j >= 0; j--) if (!els[j].hidden) return j;
    const after = els.findIndex((el) => !el.hidden);
    return after < 0 ? i : after;
  },

  /** The reading view scrolled so that this line is at the top */
  showReadingLine(at) {
    const container = this.els.previewContainer;
    const els = [...container.children];
    if (!els.length || !at) return;
    const blocks = this.readingBlocks();
    const line = Math.floor(at);
    // The block holding the line, or the next one when the line is a blank one between two blocks
    let i = blocks.findIndex((b) => b.to >= line);
    if (i < 0) i = blocks.length - 1;
    // A line in a hidden block (a board's folded column, its settings): the shown block before it, from its top
    const shown = this.shownBlockAt(els, i);
    const { from, to } = blocks[i];
    const share = shown !== i || line < from ? 0 : Math.min((at - from) / (to - from + 1), 1);
    i = shown;
    const rect = els[i].getBoundingClientRect();
    container.scrollTop += rect.top + share * (rect.bottom - rect.top) - (container.getBoundingClientRect().top + this.VIEW_INSET);
  },

  /** Into the editor on the stretch the reading view shows. Also the reopening after a new version in
      edit mode, whose reading view has just been put back where it was (landInNote). */
  editAtReading() {
    const at = this._previewOf === this.currentFile ? this.readingTopLine() : null;
    this.setMode('edit');
    if (at) this.Editor.showLine(at);
  },

  // ── Long press ──

  LONG_PRESS_MS: 500,

  LONG_PRESS_SLOP: 10,

  /** Hold a finger still for LONG_PRESS_MS on an element inside `root` that matches `selector` (and that
      `accept` agrees to): `fire(el)`. Passive touch listeners, like the edge swipe: the browser keeps the
      scroll, and the swipe (on document) sees every touch as before. A finger that moves more than
      LONG_PRESS_SLOP px, lifts early or is cancelled is no long press. The click the lift may send after
      a long press is swallowed (see the capture listener in bindEvents), so a held name does not rename
      and a held link does not open. */
  onLongPress(root, selector, fire, { accept = () => true } = {}) {
    let timer = null;
    let start = null;
    const stop = () => {
      clearTimeout(timer);
      timer = null;
    };
    const target = (e) => {
      const el = e.target.closest?.(selector);
      return el && root.contains(el) && accept(el) ? el : null;
    };
    root.addEventListener('touchstart', (e) => {
      stop();
      const el = e.touches.length === 1 ? target(e) : null;
      if (!el) return;
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      timer = setTimeout(() => {
        timer = null;
        if (!accept(el)) return; // the screen changed under the finger (another mode, another view)
        this._longPressed = el;
        this.log(`long press ${el.id || el.tagName.toLowerCase()}`);
        fire(el);
      }, this.LONG_PRESS_MS);
    }, { passive: true });
    root.addEventListener('touchmove', (e) => {
      if (!timer) return;
      const t = e.touches[0];
      if (!t || e.touches.length > 1 || Math.hypot(t.clientX - start.x, t.clientY - start.y) > this.LONG_PRESS_SLOP) stop();
    }, { passive: true });
    root.addEventListener('touchend', stop, { passive: true });
    root.addEventListener('touchcancel', stop, { passive: true });
    // Chrome's own long press (the link menu, the text selection): off only where ours lives
    root.addEventListener('contextmenu', (e) => {
      if (target(e)) e.preventDefault();
    });
  },

  // ── Table of contents ──

  /** The note's headings as drawn in the reading view, each level one step in. Each row scrolls to its
      own element, so two headings with the same text are two different rows. Where the reading stops
      after the jump is kept like any scroll: rememberPlace measures the view when the note is left. */
  openToc() {
    const headings = [...this.els.previewContainer.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .filter(h => !h.closest('[hidden]'));
    const ul = this.els.tocUl;
    ul.innerHTML = '';
    this.els.tocEmpty.hidden = headings.length > 0;
    const level = (h) => Number(h.tagName[1]);
    const top = Math.min(...headings.map(level));
    for (const h of headings) {
      const li = document.createElement('li');
      li.className = 'toc-item';
      li.style.paddingLeft = `${12 + (level(h) - top) * 16}px`;
      li.textContent = h.textContent.trim();
      li.addEventListener('click', () => {
        this.closeToc();
        h.scrollIntoView({ block: 'start' });
      });
      ul.appendChild(li);
    }
    this.els.tocOverlay.classList.add('visible');
    this.els.tocOverlay.querySelector('.toc-list').scrollTop = 0;
    this.armWatcher();
  },

  closeToc() {
    this.els.tocOverlay.classList.remove('visible');
    this.armWatcher();
  },

  // ── Peek ──

  /** Hold an internal link: the note on the other side, drawn in a card over the reading view. Nothing of
      the reading view changes (the note on screen, its place, the back stack, the pictures it holds).
      Every await checks the card's own sequence: a card closed, or replaced by another one, is never
      filled late. */
  async openPeek({ target, heading }) {
    const seq = ++this._peekSeq;
    const els = this.els;
    this._peek = { target, heading, note: null };
    const say = (text) => {
      els.peekMessage.textContent = text;
      els.peekMessage.hidden = !text;
    };
    els.peekTitle.textContent = target.split('/').pop().trim().replace(/\.md$/i, '');
    els.peekBody.innerHTML = '';
    els.peekBody.scrollTop = 0;
    say('Carregando…');
    els.peekOverlay.classList.add('visible');
    this.armWatcher();
    this.log(`peek ${target}`);

    // Finding a note by its name always asks the Drive: without network there is nothing to show
    if (navigator.onLine === false) return say('Sem rede.');
    // Never a login popup from a long press: the tap on Abrir is where that can happen
    if (!this.hasValidToken()) return say('O login do Google venceu.');
    let found;
    try {
      found = await this.findLinkedNote(target);
    } catch (e) {
      console.error('Peek lookup failed:', e);
      if (seq !== this._peekSeq) return;
      return say(navigator.onLine === false ? 'Sem rede.' : 'Não deu pra procurar a nota.');
    }
    if (seq !== this._peekSeq) return;
    if (found.error) return say(found.error === 'type' ? `Não abro esse tipo: ${found.base}` : `Nota não encontrada: ${found.base}`);
    this._peek.note = found.note;
    els.peekTitle.textContent = found.note.name.replace(/\.md$/i, '');

    // The copy kept on the device is on screen at once; the Drive's replaces it when it arrives
    const kept = await this.NoteStore.get(found.note.id);
    if (seq !== this._peekSeq) return;
    let shown = null;
    if (typeof kept?.content === 'string') {
      this.fillPeek(kept.content, heading);
      shown = kept.content;
    }
    try {
      const content = await this.driveGetFileContent(found.note.id);
      if (seq !== this._peekSeq) return;
      // Only a different text is drawn again, and then where the card already is stays put
      if (content !== shown) this.fillPeek(content, heading, { keepScroll: shown !== null });
    } catch (e) {
      console.error('Peek load failed:', e);
      if (seq !== this._peekSeq) return;
      if (shown === null) say(navigator.onLine === false ? 'Sem rede.' : 'Não deu pra abrir a nota.');
    }
  },

  /** The note's body in the card: no properties, pictures as their label (no download), tasks left
      switched off as the renderer draws them. Opens at the link's heading, or at the top; `keepScroll`
      keeps the card where it is (the Drive's text replacing the kept one, which may have been scrolled). */
  fillPeek(content, heading, { keepScroll = false } = {}) {
    const body = this.els.peekBody;
    const { body: text } = this.splitFrontmatter(content);
    const at = body.scrollTop;
    this.els.peekMessage.hidden = true;
    if (typeof DOMPurify === 'undefined' || typeof marked === 'undefined') {
      // The same rule as the reading view: no sanitizer, no HTML
      body.style.whiteSpace = 'pre-wrap';
      body.textContent = text;
    } else {
      body.style.whiteSpace = '';
      this.renderMarkdownInto(body, text);
      body.querySelectorAll('img[data-embed]').forEach((img) => {
        const label = document.createElement('span');
        label.className = 'wikilink-file';
        label.textContent = img.alt;
        img.replaceWith(label);
      });
    }
    if (keepScroll) {
      body.scrollTop = at;
      return;
    }
    body.scrollTop = 0;
    this.scrollToHeading(heading, body);
  },

  closePeek() {
    this._peekSeq++;
    this._peek = null;
    this.els.peekOverlay.classList.remove('visible');
    this.armWatcher();
  },

  /** Abrir: exactly what a short tap on the held link does. This runs inside the tap on Abrir, which is
      where followLink's history entry has to be born (see beginNav). */
  openPeeked() {
    const peek = this._peek;
    this.closePeek();
    if (peek) this.followLink(peek.target, peek.heading);
  },

  /** Taps inside the card: a link to another note closes the card and is followed, as in the reading
      view; a link to a heading of the same note scrolls the card; the rest leaves the app */
  onPeekClick(e) {
    const link = e.target.closest('a');
    if (!link || !this.els.peekBody.contains(link)) return;
    e.preventDefault();
    const inner = this.internalLinkOf(link);
    if (inner) {
      this.closePeek();
      this.followLink(inner.target, inner.heading);
      return;
    }
    const href = link.getAttribute('href') || '';
    if (link.classList.contains('wikilink')) {
      this.scrollToHeading(link.dataset.heading || '', this.els.peekBody);
    } else if (href.startsWith('#')) {
      this.scrollToHeading(decodeURIComponent(href.slice(1)), this.els.peekBody);
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      window.open(href, '_blank', 'noopener');
    }
  },

  // ── Reading view ──

  renderPreview() {
    const container = this.els.previewContainer;
    const { frontmatter, body } = this.splitFrontmatter(this.getContent());
    this._previewOf = this.currentFile;
    container.classList.remove('kanban');

    // The token in this page has full Drive scope, so rendered HTML is never trusted:
    // without the sanitizer (or the renderer) the note is shown as plain text instead
    const canRender = typeof DOMPurify !== 'undefined' && typeof marked !== 'undefined';
    container.style.whiteSpace = canRender ? '' : 'pre-wrap';
    if (!canRender) {
      container.textContent = body;
      return;
    }

    this.renderMarkdownInto(container, body);
    // Only here, not in renderMarkdownInto: the peek card shows a board as its plain list
    if (this.isKanban(frontmatter)) this.decorateKanban(container);
    this.enableTasks(container);
    this.loadEmbeds(container);

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

  /** Markdown to sanitized, decorated HTML inside `container`: the reading view's own drawing, shared
      with the peek. The caller checks that the renderer and the sanitizer are there. */
  renderMarkdownInto(container, body) {
    container.innerHTML = DOMPurify.sanitize(marked.parse(body));
    this.decoratePreview(container);
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

    this.decorateYouTube(container);
  },

  // youtube.com/watch?v= (also m.), youtu.be/ and youtube.com/shorts/, with an 11 character video ID
  YOUTUBE_ID: /^https?:\/\/(?:(?:www|m)\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/,

  /** ![](a YouTube link) is Obsidian's video embed. Here it is the video's cover with a play mark, and a tap
      opens the link, which Android hands to the YouTube app: nothing of YouTube runs inside an app that holds
      the Drive login. Built by the app from the checked ID, after the sanitizer, and it replaces the img
      inside its own paragraph, so the reading view keeps one child per block. A cover that does not load
      (no network) goes back to the link as text. */
  decorateYouTube(container) {
    container.querySelectorAll('img').forEach((img) => {
      // ![[foto.jpg]] is a Drive picture; an image already inside a link keeps that link (no link in a link)
      if (img.dataset.embed || img.closest('a')) return;
      const src = img.getAttribute('src') || '';
      const id = this.YOUTUBE_ID.exec(src)?.[1];
      if (!id) return;
      const link = document.createElement('a');
      link.className = 'yt-embed';
      link.href = src;
      link.setAttribute('aria-label', img.alt || 'Vídeo do YouTube');
      const cover = document.createElement('img');
      cover.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
      cover.alt = img.alt || '';
      cover.loading = 'lazy';
      const play = document.createElement('span');
      play.className = 'yt-play';
      play.setAttribute('aria-hidden', 'true');
      // U+FE0E asks for the text glyph: bare, Android may draw ▶ as the coloured emoji, off the palette
      play.textContent = '▶︎';
      cover.addEventListener('error', () => {
        link.className = 'yt-fallback';
        link.removeAttribute('aria-label');
        link.textContent = img.alt || src;
      });
      link.append(cover, play);
      img.replaceWith(link);
    });
  },

  /** A board of the Obsidian Kanban plugin: `kanban-plugin: board` in the properties */
  isKanban(frontmatter) {
    return /^kanban-plugin:\s*board\s*$/m.test(frontmatter || '');
  },

  /** The note as a board, read only. Nothing is wrapped, moved or removed: every block stays a child of
      the reading view, in order, because "Ler" and "Editar" meet block by block (noteBlocks). A column is
      its ## heading, marked, plus the blocks up to the next one; folding hides those blocks. The count is
      a data attribute drawn by the stylesheet, so the heading's text (the table of contents, the links to
      a heading) stays the column's name. The plugin's settings block (%% kanban:settings, its code block,
      %%) is hidden too, and its list-collapse says which columns start folded. What comes before the
      first column stays as plain text. */
  decorateKanban(container) {
    const kids = [...container.children].filter((el) => !el.matches('details.frontmatter'));
    let collapse = [];
    const start = kids.findIndex((el) => el.tagName === 'P' && /^%%\s*kanban:settings/.test(el.textContent.trim()));
    if (start >= 0) {
      const settings = [kids[start]];
      // The opening line, then its code block and the closing %%, when they are blocks of their own
      if (!/%%$/.test(kids[start].textContent.trim().replace(/^%%/, ''))) {
        for (const el of kids.slice(start + 1)) {
          if (el.tagName === 'PRE') {
            settings.push(el);
          } else {
            if (el.tagName === 'P' && el.textContent.trim() === '%%') settings.push(el);
            break;
          }
        }
      }
      for (const el of settings) {
        el.hidden = true;
        el.classList.add('kanban-settings');
      }
      const code = settings.find((el) => el.tagName === 'PRE');
      try {
        const list = code ? JSON.parse(code.textContent)['list-collapse'] : [];
        collapse = Array.isArray(list) ? list : [];
      } catch {
        collapse = []; // settings that do not parse: every column open
      }
    }
    let col = -1;
    let head = null;
    for (const el of kids) {
      if (el.classList.contains('kanban-settings')) continue;
      if (el.tagName === 'H2') {
        col++;
        head = el;
        el.classList.add('kanban-col-head');
        el.classList.toggle('collapsed', !!collapse[col]);
        el.dataset.count = '0';
        continue;
      }
      if (!head) continue;
      el.classList.add('kanban-col-body');
      if (el.tagName === 'UL' || el.tagName === 'OL') {
        const cards = [...el.children].filter((li) => li.tagName === 'LI').length;
        head.dataset.count = String(Number(head.dataset.count) + cards);
      }
      if (collapse[col]) el.hidden = true;
    }
    container.classList.add('kanban');
  },

  /** Fold or unfold one column. Only the screen changes: nothing is written to the note. */
  toggleKanbanColumn(head) {
    const folded = head.classList.toggle('collapsed');
    for (let el = head.nextElementSibling; el && el.classList.contains('kanban-col-body'); el = el.nextElementSibling) {
      el.hidden = folded;
    }
    this.log(`kanban ${folded ? 'fold' : 'unfold'} ${head.textContent.trim()}`);
  },

  /** Where each task's mark (the space or the x between the brackets) sits in the note, in the order
      the reading view shows them. Fenced code is skipped, as the renderer skips it. */
  taskMarks(content) {
    const start = content.length - this.splitFrontmatter(content).body.length;
    const marks = [];
    let fence = null;
    let at = start;
    for (const line of content.slice(start).split('\n')) {
      const fenceMatch = /^[\s>]*(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        if (!fence) fence = fenceMatch[1][0];
        else if (fenceMatch[1][0] === fence) fence = null;
      } else if (!fence) {
        const task = /^[\s>]*(?:[-*+]|\d+[.)])\s+\[[ xX]\] /.exec(line);
        if (task) marks.push(at + task[0].length - 3);
      }
      at += line.length + 1;
    }
    return marks;
  },

  /** Task boxes come out of the renderer switched off. They are switched on only when the note's text
      and the screen agree on how many tasks there are: ticking the wrong line is worse than not ticking. */
  enableTasks(container) {
    const boxes = [...container.querySelectorAll('li > input[type="checkbox"]')];
    if (boxes.length !== this.taskMarks(this.getContent()).length) return;
    boxes.forEach((box, i) => {
      box.disabled = false;
      box.addEventListener('change', () => this.toggleTask(i, box));
    });
  },

  /** The editor is out of sight in reading view, so its text can be replaced (see setContent and the keyboard) */
  toggleTask(index, box) {
    const content = this.getContent();
    const at = this.taskMarks(content)[index];
    if (at === undefined) {
      box.checked = !box.checked;
      return;
    }
    this.setContent(content.slice(0, at) + (box.checked ? 'x' : ' ') + content.slice(at + 1));
    this.markDirty();
  },

  /** ![[foto.jpg]]: Drive only hands the file over with the login, so an <img> cannot point at it.
      The image is fetched here and given to the <img> as a blob. No image, no login: back to a label. */
  loadEmbeds(container) {
    container.querySelectorAll('img[data-embed]').forEach(async (img) => {
      const name = img.dataset.embed.split('/').pop().trim();
      if (!this._embedUrls.has(name)) {
        this._embedUrls.set(name, this.fetchEmbed(name).catch(() => null));
      }
      const url = await this._embedUrls.get(name);
      if (url) {
        img.src = url;
        return;
      }
      // Not cached, so the next render tries again (the photo may still be syncing)
      this._embedUrls.delete(name);
      const label = document.createElement('span');
      label.className = 'wikilink-file';
      label.textContent = img.alt;
      img.replaceWith(label);
    });
  },

  /** The Drive file an `![[picture]]` names, or null. Same name in more than one place: the one in the
      attachment folder wins, then the newest. Showing the picture and binning it have to land on the
      same file, so both ask here. */
  async findEmbedFile(name) {
    const images = (await this.driveFindByName([name])).filter(f => (f.mimeType || '').startsWith('image/'));
    if (!images.length) return null;
    if (images.length === 1) return images[0];
    const media = await this.getMediaFolderId().catch(() => null);
    return images.find(f => media && f.parents?.includes(media)) || images[0];
  },

  /** Blob URL for an image found by file name, or null. Never opens a login popup just for a picture. */
  async fetchEmbed(name) {
    if (!this.hasValidToken()) return null;
    const pick = await this.findEmbedFile(name);
    if (!pick) return null;
    const response = await this.driveFetch(`https://www.googleapis.com/drive/v3/files/${pick.id}?alt=media`);
    return URL.createObjectURL(await response.blob());
  },

  /** Taps inside the reading view: wikilinks and relative .md links open notes, the rest leaves the app */
  onPreviewClick(e) {
    const link = e.target.closest('a');
    if (!link || !this.els.previewContainer.contains(link)) {
      // A board's column heading (a link inside one is still a link): fold or unfold the column
      const column = e.target.closest('h2.kanban-col-head');
      if (column && this.els.previewContainer.contains(column)) this.toggleKanbanColumn(column);
      return;
    }
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
    const seq = ++this._loadSeq; // this tap wins over a note still loading, and "back" can give up on it
    this.setSaveStatus('saving', 'Procurando...');

    let found;
    try {
      await this.ensureAuth();
      found = await this.findLinkedNote(target);
    } catch (e) {
      console.error('Link lookup failed:', e);
      if (seq !== this._loadSeq) return;
      this.setSaveStatus('error', 'Erro ao procurar a nota');
      this.cancelNav();
      return;
    }
    if (seq !== this._loadSeq) return; // overtaken by another tap, or dropped by "back"
    if (found.error) {
      this.setSaveStatus('error', found.error === 'type' ? `Não abro esse tipo: ${found.base}` : `Nota não encontrada: ${found.base}`);
      this.cancelNav();
      return;
    }
    if (!(await this.openFile(found.note.id, found.note.name, { heading }))) this.cancelNav();
  },

  /** The note a link's target names, picked the way a tap picks it: same name in more than one place,
      the one next to the open note wins, then .md over the rest. { base, note }, or { base, error } with
      'missing' or 'type'. Throws when the Drive cannot be asked. The tap and the peek both come here, so
      they always land on the same note. */
  async findLinkedNote(target) {
    const base = target.split('/').pop().trim();
    const names = /\.md$/i.test(base) ? [base] : [`${base}.md`, base];
    const matches = await this.driveFindByName(names);
    const notes = matches.filter(f => this.isNote(f));
    if (!notes.length) return { base, error: matches.length ? 'type' : 'missing' };
    const folder = this.currentFile?.parents?.[0];
    const note = notes.find(f => folder && f.parents?.includes(folder))
      || notes.find(f => /\.md$/i.test(f.name))
      || notes[0];
    return { base, note };
  },

  /** { target, heading } of a link to another note (a wikilink, or a relative link to a .md), or null:
      links out of the app, and links to a heading of this same note, are not notes to peek at.
      The same reading of a link as onPreviewClick's. */
  internalLinkOf(link) {
    if (link.classList.contains('wikilink')) {
      const target = link.dataset.target || '';
      return target ? { target, heading: link.dataset.heading || '' } : null;
    }
    const href = link.getAttribute('href') || '';
    if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      return null;
    }
    const [target, heading = ''] = decoded.split('#');
    return target ? { target, heading } : null;
  },

  /** Scroll to the heading a link names, looked for inside `root` only (the reading view, or the peek) */
  scrollToHeading(heading, root = this.els.previewContainer) {
    if (!heading) return;
    const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    const wanted = norm(heading);
    const slug = wanted.replace(/ /g, '-');
    const found = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .find(h => norm(h.textContent) === wanted || norm(h.textContent).replace(/ /g, '-') === slug);
    if (found) found.scrollIntoView({ block: 'start' });
  },
});
