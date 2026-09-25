// Drive Notes: the CodeMirror 6 implementation behind App.Editor. Extends App (see app/core.js).

Object.assign(App, {
  /** The real editor: the CodeMirror 6. `window.CM6` is the single bundle from vendor/codemirror.js.
      The functions of the facade come from here; `mount` and `kind` belong to the facade,
      not to this one. */
  createCM6Editor(host, onChange) {
    const {
      EditorView, ViewPlugin, StateField, StateEffect, Transaction, Prec, Compartment,
      Decoration, keymap, drawSelection,
      history, undo, redo, defaultKeymap, historyKeymap,
      markdown, markdownLanguage, insertNewlineContinueMarkupCommand,
      syntaxHighlighting, HighlightStyle, syntaxTree, tags: t, lineWrapping,
      autocompletion, startCompletion, closeCompletion, completionStatus, tooltips,
    } = window.CM6;

    // Caret marks. The CM6 knows how to carry a position through the edits that happened after it
    // (mapPos), and that is what makes the picture land in the right place.
    const setMark = StateEffect.define();
    const markField = StateField.define({
      create: () => new Map(),
      update(marks, tr) {
        let next = marks;
        if (tr.docChanged) {
          next = new Map();
          for (const [id, pos] of marks) next.set(id, tr.changes.mapPos(pos));
        }
        for (const effect of tr.effects) {
          if (!effect.is(setMark)) continue;
          next = new Map(next);
          next.set(effect.value.id, effect.value.pos);
        }
        return next;
      },
    });

    // Embed decoration. It is part of the editor's state, so it survives every redraw of the line
    // on its own: nobody has to reapply class and style after a change.
    let lineInfo = () => null;      // swapped in by decorateEmbeds
    let lastSignature = '';         // to know whether any line really changed
    const redoEmbeds = StateEffect.define();

    // How much width the picture really has: the contentDOM's `clientWidth` includes the 16px of
    // padding on each side that the style.css puts on it, and the line does not have that slack.
    // Counting the padding, the picture comes out 32px wider than the line and its right side is
    // cut off (on a 390px phone, some 34px). The discount comes from the computed style, and not
    // from a fixed number, so that it follows the style.css if the padding changes. With no layout
    // (jsdom) it answers 0, and the caller falls back to the picture's own size, as it already did
    // when clientWidth was 0.
    const availableWidth = () => {
      if (!view) return 0;
      const style = getComputedStyle(view.contentDOM);
      const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      return Math.max(view.contentDOM.clientWidth - padding, 0);
    };

    const buildEmbeds = (state) => {
      const marks = [];
      // One measurement per redraw, and none when the note has no picture: this runs on every key
      // pressed, and reading the DOM in here forces the browser to recompute style and layout then
      // and there
      let available = null;
      for (let n = 1; n <= state.doc.lines; n++) {
        const line = state.doc.line(n);
        const info = lineInfo(line.text);
        if (!info) continue;
        if (available === null) available = availableWidth();
        const width = Math.min(available || info.width, info.width);
        // Down, never to the nearest: the picture is drawn at this height times its proportion, and a
        // height rounded up draws it a pixel or two wider than the line, cut on the right
        const height = Math.floor(Math.min(width * info.height / info.width, App.EMBED_MAX_HEIGHT));
        marks.push(Decoration.line({
          attributes: { class: 'embed-line', style: `--embed: url("${info.url}"); --embed-h: ${height}px` },
        }).range(line.from));
      }
      return Decoration.set(marks);
    };

    const embedField = StateField.define({
      create: (state) => buildEmbeds(state),
      update(marks, tr) {
        if (!tr.docChanged && !tr.effects.some((e) => e.is(redoEmbeds))) return marks;
        return buildEmbeds(tr.state);
      },
      provide: (field) => EditorView.decorations.from(field),
    });

    // Counting decorations is not enough to know whether something changed: swapping a picture for
    // another of the same size keeps the count and changes the screen. That is why the signature
    // carries the style, and not just the position.
    const signatureOf = (set) => {
      const parts = [];
      set.between(0, Number.MAX_SAFE_INTEGER, (from, to, deco) => {
        parts.push(`${from}:${deco.spec.attributes.style}`);
      });
      return parts.join('|');
    };

    const highlight = HighlightStyle.define([
      { tag: t.heading1, fontSize: '1.5em', fontWeight: '700', color: 'var(--accent-hover)' },
      { tag: t.heading2, fontSize: '1.3em', fontWeight: '600', color: 'var(--accent-hover)' },
      { tag: t.heading3, fontSize: '1.1em', fontWeight: '600', color: 'var(--accent-hover)' },
      { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600', color: 'var(--accent-hover)' },
      { tag: t.strong, fontWeight: '700' },
      { tag: t.emphasis, fontStyle: 'italic' },
      { tag: t.link, color: 'var(--accent-hover)', textDecoration: 'underline' },
      { tag: t.url, color: 'var(--accent-hover)' },
      { tag: t.monospace, background: 'var(--code-bg)' },
      { tag: t.quote, color: 'var(--text-secondary)' },
      { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--text-secondary)' },
    ]);

    // ── Two things the parser reads as markup and the note never wanted painted ──
    //
    // 1. The property block. `---\ncreated: ...\nupdated: ...\n---` at the start of the note is,
    //    to the markdown, a horizontal rule followed by a level 2 setext heading: the property
    //    lines came out big, purple and bold on the first screen of EVERY note. The old editor read
    //    it the same way, but the style.css never styled that case, and so it came out as plain
    //    text. That is where the block goes back to.
    // 2. `[[wikilink]]`, `[!note]` and `tags: [a, b]`. To the parser, all three are a reference
    //    link with no destination: a `Link` that only has LinkMark inside. `[text](url)` has a URL
    //    inside and `[text][label]` has a LinkLabel, so those two stay real links, purple and
    //    underlined. The old style.css had the same rule, naming the same cases.
    //
    // Both become a decoration here and plain text in the style.css: it is there that the <span>s
    // the highlighting creates inside the line can also be reached, and that is where the size, the
    // weight and the color live.
    const FRONTMATTER_LINE = Decoration.line({ class: 'frontmatter-line' });
    const PLAIN_BRACKETS = Decoration.mark({ class: 'plain-brackets' });
    // The same fence the splitFrontmatter accepts
    const FENCE = /^---[ \t]*$/;

    // The two live apart because they depend on different things. The property block is read off
    // the text alone, so a state field that recomputes on every document change says all there is
    // to say about it.
    const buildFrontmatter = (state) => {
      const marks = [];
      const doc = state.doc;
      // It is only a property block if it starts on the first line AND closes: `---` in the middle
      // of the note is a horizontal rule, and a note that opens with `---` without closing has no
      // block at all
      if (FENCE.test(doc.line(1).text)) {
        for (let n = 2; n <= doc.lines; n++) {
          if (!FENCE.test(doc.line(n).text)) continue;
          for (let k = 1; k <= n; k++) marks.push(FRONTMATTER_LINE.range(doc.line(k).from));
          break;
        }
      }
      return Decoration.set(marks);
    };

    const frontmatterField = StateField.define({
      create: (state) => buildFrontmatter(state),
      update: (marks, tr) => (tr.docChanged ? buildFrontmatter(tr.state) : marks),
      provide: (field) => EditorView.decorations.from(field),
    });

    // The brackets depend on the syntax tree, which is not finished when the document changes: the
    // parser has a time budget and goes on afterwards, in transactions that do NOT change the
    // document (see drive-notes-aprendizados). A state field that only recomputes on tr.docChanged
    // never hears about that, so everything the first budget missed stayed a link, purple and
    // underlined, until the next keystroke: in a long note, that is the whole bottom of it. And it
    // walked the entire tree on every key, in a note of any size.
    //
    // A view plugin is what syntaxHighlighting itself does: it decorates only the visible window
    // and redoes the work when the document changes, when the window moves, or when the tree grew.
    const buildPlainLinks = (view) => {
      const marks = [];
      for (const { from, to } of view.visibleRanges) {
        syntaxTree(view.state).iterate({
          from,
          to,
          enter: (node) => {
            if (node.name !== 'Link') return;
            for (let child = node.node.firstChild; child; child = child.nextSibling) {
              if (child.name !== 'LinkMark') return;
            }
            marks.push(PLAIN_BRACKETS.range(node.from, node.to));
          },
        });
      }
      return Decoration.set(marks);
    };

    const plainLinks = ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = buildPlainLinks(view); }

      update(update) {
        if (update.docChanged || update.viewportChanged
            || syntaxTree(update.state) !== syntaxTree(update.startState)) {
          this.decorations = buildPlainLinks(update.view);
        }
      }
    }, { decorations: (plugin) => plugin.decorations });

    // ── The app's Enter, a single command ──
    //
    // It does two things, in this order:
    //
    // 1. An empty quote line ends the quote right away, as in the Obsidian. The library's command
    //    only ends it after TWO empty quote lines, and getting out of a `> [!note]` block costs
    //    three Enters.
    // 2. For everything else, it hands control back to the library's command configured with
    //    nonTightLists:false, without which getting out of a one-item list costs three Enters
    //    instead of one (the second Enter inserts a blank line and keeps the marker).
    //
    // The precedence is the point, and it is not decoration: the `markdown()` installs its Enter in
    // Prec.high (the package's `addKeymap`), and precedence beats position in the extension list. A
    // binding in a plain `keymap.of([...])` ALWAYS runs after the library's, which by then has
    // already continued the list and answered true. That is what happened to the binding of commit
    // 5f96e08: it never ran, and the app went on spending three Enters to get out of a list. That
    // is why this command's keymap goes in `Prec.highest`, and why scenario 40 presses a real Enter.
    const EMPTY_QUOTE_LINE = /^\s*>\s*$/;
    // The text says "empty quote line"; only the syntax tree says whether it really is a quote. Inside
    // a fenced code block, `> ` is code, and ending a quote there wiped the line. The node right
    // after the `>` is a QuoteMark in a quote and code text in a code block, so the walk up from it
    // meets a Blockquote or a code block first. The code check comes first on purpose: a code block
    // that lives inside a quote has the Blockquote further up, and the line is still code.
    const inQuote = (state, line) => {
      const markEnd = line.from + line.text.indexOf('>') + 1;
      for (let node = syntaxTree(state).resolveInner(markEnd, -1); node; node = node.parent) {
        if (node.name === 'FencedCode' || node.name === 'CodeBlock') return false;
        if (node.name === 'Blockquote') return true;
      }
      return false;
    };
    const endQuote = (v) => {
      // With something selected, Enter is a replacement, and only the library command knows how to
      // make one. Looking at the line the caret happens to sit on would wipe the `> ` and leave the
      // selected text where it was, which is the Enter going missing.
      if (!v.state.selection.main.empty) return false;
      const line = v.state.doc.lineAt(v.state.selection.main.head);
      if (!EMPTY_QUOTE_LINE.test(line.text) || !inQuote(v.state, line)) return false;
      v.dispatch({ changes: { from: line.from, to: line.to, insert: '' }, userEvent: 'input' });
      return true;
    };
    const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });
    const appEnter = (v) => endQuote(v) || continueMarkup(v);

    // Swapping the whole text is opening another document, and the previous one's undo stack does
    // not describe it any more. The addToHistory:false annotation keeps the swap from ENTERING the
    // stack, but it does not clear what was already there: the previous note's events are remapped
    // by the new document, and a remapped deletion becomes an insertion at the end. Measured:
    // getting out of a one-item list in note A, opening note B and tapping undo pasted `- ` at the
    // end of note B, which became unsaved and went up to the Drive like that thirty seconds later.
    //
    // Clearing it is taking the history() out of the configuration and putting it back. Reconfiguring
    // with a fresh `history()` is NOT enough (measured): its state field is the same object on every
    // call, and the CM6 preserves the value of a field that stays in the configuration.
    const historyCompartment = new Compartment();
    const clearHistory = () => {
      view.dispatch({ effects: historyCompartment.reconfigure([]) });
      view.dispatch({ effects: historyCompartment.reconfigure(history()) });
    };

    // Is the caret sitting in the text a choice by whoever is writing, or an artifact of having
    // loaded the note? This flag is the difference. The CM6's selection is permanent state: after a
    // note is loaded it sits at 0 without anyone having chosen that, and a picture taken there would
    // go into the first line, on top of the frontmatter, leaving the note without `created` or
    // `updated`. A caret placed by the user, on the other hand, holds even after the focus is gone,
    // because the picture chooser steals the focus and the picture has to land where she left it.
    let caretPlaced = false;

    // ── The link list: `[[` opens the vault's note names ──
    //
    // The list is the library's (position, keyboard, scrolling, aria); what it shows and what it
    // writes is the app's: the options come from App.searchNoteIndex, already filtered and ordered
    // (hence filter: false), and `apply` is a function so that only the stretch between `[[` and
    // the caret is replaced. Replacing more than that loses the caret and, with the keyboard open,
    // breaks the dictation. The `]]` only go in when they are not already there: the toolbar button
    // writes them before opening the list.
    const LINK_START = /\[\[([^\]\[\n]*)$/;
    const linkSource = async (context) => {
      const word = context.matchBefore(LINK_START);
      if (!word) return null;
      if (!App._noteIndex) {
        // First list of the session: the index comes from the device or from the Drive. A failure
        // is not the list's problem: it shows what it has, and the next `[[` tries again.
        await App.noteIndex().catch((e) => console.warn('Note index unavailable:', e));
        if (context.aborted) return null;
      }
      const from = word.from + 2;
      const typed = word.text.slice(2);
      return {
        from,
        filter: false,
        options: App.searchNoteIndex(typed).map((note) => ({
          label: note.name.replace(/\.md$/i, ''),
          detail: note.where,
          apply: (v, completion, start, end) => {
            const closed = v.state.doc.sliceString(end, end + 2) === ']]';
            const insert = completion.label + (closed ? '' : ']]');
            v.dispatch({
              changes: { from: start, to: end, insert },
              selection: { anchor: start + completion.label.length + 2 },
              userEvent: 'input.complete',
            });
          },
        })),
      };
    };

    // `let` and not `const`: the decoration field of task 7 runs while the EditorView is being
    // built and needs to read `view`. With `const`, that read would fall in the temporal dead zone
    // and throw a ReferenceError instead of answering null.
    let view = null;
    view = new EditorView({
      parent: host,
      extensions: [
        // In a compartment so that the stack can be cleared when another note is opened (see clearHistory)
        historyCompartment.of(history()),
        drawSelection(),
        lineWrapping,
        // The CM6 puts autocapitalize="off" on its writing area, and with that the Android keyboard
        // stopped raising the first letter of every sentence, which is what the old editor (a plain
        // contenteditable) let happen. The spell checking stays off, as it comes from the library:
        // the text is markdown, full of markers it would underline.
        //
        // A line that opens with a marker keeps its first letter small, and that is the keyboard's
        // own rule: to decide on the capital it walks back from the caret, skips the spaces and
        // wants the start of the line or a full stop, so on `- [ ] |` it finds the `]` and says no.
        // Tried in ee4b76a and reverted here: flipping this to 'words' while the caret sits right
        // after a marker. The attribute does change, but the Android keyboard holds on to the
        // capitals mode it was handed when the field took focus, and on the phone nothing came of
        // it. Raising the letter from here instead would mean waiting for the word to end, because
        // the keyboard rewrites the whole word it is composing on every keystroke; that was offered
        // and turned down, so the shift key stays in charge on a line with a marker.
        EditorView.contentAttributes.of({ autocapitalize: 'sentences' }),
        // Typewriter scrolling: the line being written stops at the middle of the writing area and the
        // text moves up a line at a time, instead of the caret sinking to the bottom edge, right on top
        // of the toolbar and the keyboard. It is the library's own scroll-into-view with half the area
        // as a bottom margin, so it only ever runs where the library already scrolls: typing and
        // dictation. A tap or a finger dragging a selection never scrolls (the CM6 scrolls a selection
        // into view only when it came from the keys), and the app's scrollToCaret still asks for focus.
        // Measured at scroll time, so it follows the keyboard opening and closing. The room to lift the
        // last line of the note up to the middle is the 50vh at the bottom of .cm-content, in the style.css.
        EditorView.scrollMargins.of((v) => ({ bottom: v.scrollDOM.clientHeight / 2 })),
        // Before the app's Enter on purpose: the list's Enter (acceptCompletion) is installed in
        // Prec.highest too, and equal precedence is decided by position. With no list open it
        // answers false and the app's Enter runs as always.
        autocompletion({ override: [linkSource], activateOnTyping: true, icons: false, maxRenderedOptions: 12 }),
        // The list must float above the keyboard and over the fixed toolbar: fixed, on the body,
        // not inside the container that scrolls
        tooltips({ position: 'fixed', parent: document.body }),
        // Above the Enter the markdown() installs in Prec.high: see the appEnter comment
        Prec.highest(keymap.of([{ key: 'Enter', run: appEnter }])),
        markdown({ base: markdownLanguage, codeLanguages: [] }),
        syntaxHighlighting(highlight),
        frontmatterField,
        plainLinks,
        markField,
        embedField,
        // The Enter does not live here: it is up there, in Prec.highest, because from here it does not reach
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange();
          if (u.focusChanged && u.view.hasFocus) caretPlaced = true;
          // The extract button shows while there is text selected in here, with the focus. Losing the
          // focus counts: the name dialog's field taking it hides the button, and so does leaving the editor
          if (u.selectionSet || u.focusChanged || u.docChanged) {
            const sel = u.state.selection.main;
            App.onEditorSelection(u.view.hasFocus && !sel.empty && u.state.sliceDoc(sel.from, sel.to).trim() !== '');
          }
        }),
        // A tap on the picture of an embed line offers to delete it. The picture is not an element:
        // it is the line's background, drawn over the bottom padding the decoration asked for, so the
        // tap counts when it lands in the last --embed-h + 8 pixels of the line's box (the 8 is the
        // gap the style.css leaves between the text and the picture). Only geometry lives here; what
        // to do about it is App.removeEmbedLine's business. Answering true keeps the editor from
        // putting the caret in the line and opening the keyboard behind the dialog.
        EditorView.domEventHandlers({
          click: (event) => {
            if (App.mode !== 'edit') return false;
            const el = event.target?.closest?.('.cm-line.embed-line');
            if (!el) return false;
            const height = parseFloat(el.style.getPropertyValue('--embed-h'));
            if (!height) return false;
            const rect = el.getBoundingClientRect();
            if (event.clientY < rect.bottom - height - 8) return false;
            App.removeEmbedLine(view.state.doc.lineAt(view.posAtDOM(el)).number);
            return true;
          },
        }),
      ],
    });

    // Opening a note swaps the whole text, and that is not an edit by the user: without this
    // annotation, an undo right after writing wipes the note and brings back the previous one's text.
    const noHistory = Transaction.addToHistory.of(false);

    let nextMarkId = 0;
    const newMark = (pos) => {
      const id = `m${nextMarkId++}`;
      return { id, effect: setMark.of({ id, pos }) };
    };
    const posOfMark = (mark) => {
      if (mark == null) return null;
      const pos = view.state.field(markField).get(mark);
      return pos == null ? null : Math.min(pos, view.state.doc.length);
    };

    return {
      view,
      openLinkList: () => startCompletion(view),
      closeLinkList: () => {
        if (completionStatus(view.state) === null) return false;
        closeCompletion(view);
        return true;
      },
      getText: () => view.state.doc.toString(),
      setText: (text) => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          annotations: noHistory,
        });
        // New document, new stack. This holds for every caller of setContent, and all of them swap
        // the whole document: opening a note, a new note, a draft, ticking a task in the reading
        // view, catching up with the dates that went up, and the reload after a conflict. In none
        // of them does the old stack describe the text on the screen.
        clearHistory();
        // New text. If the swap caught the person inside the editor (the reload after a conflict),
        // she is in there writing and her caret is still the best bet; with the editor out of focus
        // it is a note opened from the list, and then nobody placed any caret in this text
        caretPlaced = view.hasFocus;
      },
      focus: () => view.focus(),
      moveCaretToEnd: () => view.dispatch({ selection: { anchor: view.state.doc.length } }),
      markCaret: () => {
        if (!caretPlaced) return null;
        const mark = newMark(view.state.selection.main.head);
        view.dispatch({ effects: mark.effect });
        return mark.id;
      },
      insertOnOwnLine: (text, mark) => {
        // With no mark and no caret placed (a note opened from the list and the camera tapped
        // before the text), the safe place is the end of the note: the start is where the
        // frontmatter lives
        const pos = posOfMark(mark)
          ?? (caretPlaced ? view.state.selection.main.head : view.state.doc.length);
        const line = view.state.doc.lineAt(pos);
        // If there is text before the caret on the line, the insertion starts on a new line
        const before = view.state.doc.sliceString(line.from, pos).trim() ? '\n' : '';
        // The start of the next line, already in the new document. The received mark cannot be
        // handed back: a position mapped through an insertion at that very point ends up BEFORE
        // what was inserted, and the next picture of the batch would land on top of this one (the
        // inverted order of commit 439b920).
        const next = pos + before.length + text.length + 1;
        const nextMark = newMark(next);
        view.dispatch({
          changes: { from: pos, insert: `${before}${text}\n` },
          selection: { anchor: next },
          effects: nextMark.effect,
        });
        return nextMark.id;
      },
      undo: () => undo(view),
      redo: () => redo(view),
      format: (name) => {
        const format = App.FORMATS[name];
        if (!format) { view.focus(); return; }
        const sel = view.state.selection.main;

        if (format.wrap) {
          const [before, after] = format.wrap;
          const chosen = (view.state.doc.sliceString(sel.from, sel.to)) || (format.placeholder ?? 'texto');
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: `${before}${chosen}${after}` },
            // the selection stays in the middle, so that typing overwrites "texto"
            selection: { anchor: sel.from + before.length, head: sel.from + before.length + chosen.length },
            userEvent: 'input',
          });
          view.focus();
          return;
        }

        // Line marker: it holds for every line the selection touches. If the selection ends exactly
        // at the start of a line, that line was not really touched (it is just where the selection
        // stopped), and it does not count, unless it is the selection's only line. It is the same
        // guard as the CM6's own changeBySelectedLine (@codemirror/commands, used by indentMore and
        // by toggleLineComment), adapted to a single selection instead of several.
        const first = view.state.doc.lineAt(sel.from).number;
        let last = view.state.doc.lineAt(sel.to).number;
        if (!sel.empty && last > first && sel.to <= view.state.doc.line(last).from) last--;
        // Only the marker is replaced, never the whole line: a position that was INSIDE a replaced
        // stretch goes back to the start of it, and that is why tapping list, task, heading or
        // quote sent the caret to the start of the line, far from where the writing was.
        const changes = [];
        const swaps = new Map();
        for (let n = first; n <= last; n++) {
          const line = view.state.doc.line(n);
          const swap = App.linePrefixChange(line.text, format.line);
          swaps.set(n, swap);
          changes.push({ from: line.from + swap.from, to: line.from + swap.to, insert: swap.insert });
        }
        // Where a position of the text from before ends up. Whoever was in the text moves along
        // with it; whoever was in the old marker, or before it, stops right after the new marker,
        // which is where the typing goes on in a line that has just become a list item.
        const move = (pos) => {
          const line = view.state.doc.lineAt(pos);
          let running = 0;
          for (let n = first; n < Math.min(line.number, last + 1); n++) {
            const earlier = swaps.get(n);
            running += earlier.insert.length - (earlier.to - earlier.from);
          }
          const swap = swaps.get(line.number);
          if (!swap) return pos + running;
          const column = pos - line.from;
          const moved = column < swap.to
            ? swap.from + swap.insert.length
            : column + swap.insert.length - (swap.to - swap.from);
          return line.from + running + moved;
        };
        view.dispatch({
          changes,
          selection: { anchor: move(sel.anchor), head: move(sel.head) },
          userEvent: 'input',
        });
        view.focus();
      },
      decorateEmbeds: (fn) => {
        lineInfo = fn;
        view.dispatch({ effects: redoEmbeds.of(null) });
        const now = signatureOf(view.state.field(embedField));
        const changed = now !== lastSignature;
        lastSignature = now;
        return changed;
      },
      lineText: (number) => {
        if (!Number.isInteger(number) || number < 1 || number > view.state.doc.lines) return null;
        return view.state.doc.line(number).text;
      },
      removeLine: (number) => {
        if (!Number.isInteger(number) || number < 1 || number > view.state.doc.lines) return false;
        const line = view.state.doc.line(number);
        // The line's own newline goes with it. On the last line there is none, so the one above goes
        // instead, or the note would be left ending in a blank line. Only this stretch is replaced,
        // never the whole text: swapping the whole document loses the caret and, with the keyboard
        // open, breaks the dictation halfway through.
        const last = line.to >= view.state.doc.length;
        const from = last ? Math.max(0, line.from - 1) : line.from;
        const to = last ? line.to : line.to + 1;
        view.dispatch({
          changes: { from, to },
          selection: { anchor: from },
          userEvent: 'delete',
        });
        return true;
      },
      selectedStretch: () => {
        const sel = view.state.selection.main;
        const raw = view.state.sliceDoc(sel.from, sel.to);
        const text = raw.trim();
        if (!text) return null;
        // The blank ends stay out of it. A selection of whole lines usually takes the newline at the
        // end, and swapping that too would glue the next line onto the link
        const from = sel.from + (raw.length - raw.trimStart().length);
        const start = newMark(from);
        const end = newMark(from + text.length);
        view.dispatch({ effects: [start.effect, end.effect] });
        return { text, start: start.id, end: end.id };
      },
      replaceStretch: (stretch, insert) => {
        // Only what was checked is taken out. The marks followed every edit made since the stretch was
        // picked; if what lies between them is no longer exactly its text (typed into, or the note
        // swapped underneath), nothing is touched and the text stays where it is. Only this stretch is
        // replaced, never the whole text: that would lose the caret, and the undo that brings it back.
        const from = posOfMark(stretch?.start);
        const to = posOfMark(stretch?.end);
        if (from == null || to == null || view.state.sliceDoc(from, to) !== stretch.text) return false;
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
          userEvent: 'input',
        });
        return true;
      },
      // Read and written at App.VIEW_INSET below the top edge, where the first line sits unscrolled
      topLine: () => {
        const probe = view.scrollDOM.getBoundingClientRect().top + App.VIEW_INSET - view.documentTop;
        const block = view.lineBlockAtHeight(Math.max(probe, 0));
        const share = block.height > 0 ? Math.min(Math.max((probe - block.top) / block.height, 0), 0.999) : 0;
        return view.state.doc.lineAt(block.from).number + share;
      },
      showLine: (at) => {
        const doc = view.state.doc;
        const line = doc.line(Math.min(Math.max(Math.floor(at), 1), doc.lines));
        const pos = line.from + Math.floor((at % 1) * line.length);
        // The library's own scroll, done in its measuring pass: the editor has just come out of hiding,
        // and until then it could only guess the height of its lines
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: App.VIEW_INSET }) });
      },
      scrollToCaret: () => {
        // Only while the editor has the focus, which is what the old editor did by asking whether
        // the DOM selection was inside it. Whoever calls this does not check: the embed decoration
        // calls it when a picture's size arrives from the Drive, and the visualViewport resize
        // fires on Android when the browser bar hides on a scroll. Without the guard, opening a
        // long note, tapping Edit without touching the text (caret at 0) and scrolling to read
        // ends with the screen jumping back to the top on its own.
        if (!view.hasFocus) return;
        view.dispatch({
          effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 32 }),
        });
      },
    };
  },
});
