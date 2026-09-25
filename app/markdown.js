// Drive Notes: marked.js config: wikilinks, highlights and lists.

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
    // Embedded images get their src after sanitizing (see loadEmbeds). ![[foto.jpg|300]] sets the width.
    if (token.embed && /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(token.target)) {
      const width = /^\d+/.exec(token.alias)?.[0];
      return `<img class="embed-img" data-embed="${escape(token.target)}" alt="${escape(width ? token.target : label)}"${width ? ` width="${width}"` : ''}>`;
    }
    // PDFs, audio and the like are not fetched: shown as a plain label
    if (token.embed && /\.(pdf|mp3|mp4|canvas)$/i.test(token.target)) {
      return `<span class="wikilink-file">${escape(label)}</span>`;
    }
    return `<a href="#" class="wikilink" data-target="${escape(token.target)}" data-heading="${escape(token.heading)}">${escape(label)}</a>`;
  },
};

// Obsidian's highlight: ==texto== becomes <mark>texto</mark>. Inline, so a highlight inside a code
// span or a fenced block is left alone, and its children go back through the lexer so ==**x**==
// keeps the bold inside the mark.
const markExtension = {
  name: 'highlight',
  level: 'inline',
  start(src) {
    const index = src.indexOf('==');
    return index < 0 ? undefined : index;
  },
  tokenizer(src) {
    // The lookahead rules out ==== and "== x ==": a highlight opens on a non-space and closes on one
    const match = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
    if (!match) return undefined;
    return {
      type: 'highlight',
      raw: match[0],
      text: match[1],
      tokens: this.lexer.inlineTokens(match[1]),
    };
  },
  renderer(token) {
    return `<mark>${this.parser.parseInline(token.tokens)}</mark>`;
  },
};

// ── Lists: a blank line groups, it does not respace ──
// A blank line between two items is how a list is split into groups while writing, and Obsidian shows it
// that way: the items of a group stay together and only the groups are set apart. One blank line makes
// marked call the WHOLE list "loose": every item gets its text wrapped in <p>, so every item ends up
// equally spaced and the grouping disappears. The looseness is dropped here and the item that comes right
// after the blank line is tagged instead, so the CSS opens the gap only there.

// The blank line that closes an item is the last thing in its raw text (the last item is trimmed)
const LIST_ITEM_GAP = /\n[^\S\n]*\n\s*$/;

function ungroupLooseLists(token) {
  if (token.type !== 'list') return;
  let afterBlankLine = false;
  for (const item of token.items) {
    item.gap = afterBlankLine;
    item.loose = false;
    // Real paragraphs inside one item (indented text after a blank line) come out of the lexer as several
    // text blocks. Those keep their <p>: a blank line INSIDE an item is not a gap between items.
    const blocks = (item.tokens || []).filter(t => t.type === 'text');
    if (blocks.length > 1) blocks.forEach(block => { block.type = 'paragraph'; });
    afterBlankLine = LIST_ITEM_GAP.test(item.raw);
  }
  token.loose = false;
}

if (typeof marked !== 'undefined') {
  marked.setOptions({
    breaks: true,
    gfm: true,
  });
  marked.use({
    extensions: [wikilinkExtension, markExtension],
    walkTokens: ungroupLooseLists,
    renderer: {
      listitem(item) {
        // The default item first: it is what puts the task checkbox straight into the <li> (only a loose
        // item hides the box inside a <p>, where neither the tap handler nor the CSS can reach it)
        const html = marked.Renderer.prototype.listitem.call(this, item);
        return item.gap ? html.replace('<li>', '<li class="gap">') : html;
      },
    },
  });
}
