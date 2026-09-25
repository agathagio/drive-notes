// Drive Notes: the Editor facade and the fallback textarea. Extends App (see app/core.js).

Object.assign(App, {
  // ── Editor ──
  // The app talks to App.Editor and to nothing else. Behind it there are two implementations (the
  // CodeMirror 6 and a fallback textarea); neither of them leaks out of here. A position inside the
  // text, in particular, is each implementation's own vocabulary: whoever needs one is handed an
  // opaque mark and hands it back.
  //
  // Two rules that hold for every implementation, present or future:
  //
  // 1. `markCaret()` answers an opaque mark or null, and nothing outside here may open the mark.
  //    It can never be a falsy value other than null (not 0, not ''): every caller tests the mark
  //    with `||`, and a falsy mark would be thrown away without anyone noticing.
  // 2. `insertOnOwnLine(text, mark)` answers the mark of the next line, the one left free below
  //    what was inserted. It is not optional: a batch of pictures uses that answer to make each one
  //    land below the previous (see savePhoto). Answering undefined brings back the bug commit
  //    439b920 fixed, in which the batch came out back to front. Whoever cannot say where it ended
  //    up (the textarea, whose caret moves on its own) answers undefined on purpose.

  Editor: {
    _impl: null,
    _kind: 'textarea',

    mount(host, onChange) {
      const attempts = [
        ['cm6', () => {
          if (!window.CM6) throw new Error('no CM6 bundle');
          return App.createCM6Editor(host, onChange);
        }],
        ['textarea', () => App.createTextareaEditor(host, onChange)],
      ];
      for (const [kind, create] of attempts) {
        try {
          this._impl = create();
          this._kind = kind;
          return kind;
        } catch (e) {
          // The whole error, not just its message: a bug inside the implementation becomes a
          // warning with a file and a line, instead of the app falling silently to the textarea
          console.warn(`editor ${kind} unavailable:`, e);
          // The attempt may have blown up with half an editor already hanging off the host: the
          // next one needs a clean host, or the fallback shows up on top of the previous one's mess
          host.replaceChildren();
        }
      }
      return this._kind;
    },

    kind() { return this._kind; },
    getText() { return this._impl ? this._impl.getText() : ''; },
    setText(t) { this._impl?.setText(t); },
    focus() { this._impl?.focus(); },
    moveCaretToEnd() { this._impl?.moveCaretToEnd(); },
    markCaret() { return this._impl ? this._impl.markCaret() : null; },
    insertOnOwnLine(text, mark) { return this._impl?.insertOnOwnLine(text, mark); },
    format(name) { this._impl?.format(name); },
    undo() { return this._impl ? this._impl.undo() : false; },
    redo() { return this._impl ? this._impl.redo() : false; },
    decorateEmbeds(lineInfo) { return this._impl ? this._impl.decorateEmbeds(lineInfo) : false; },
    scrollToCaret() { this._impl?.scrollToCaret(); },
    // The link list. The fallback textarea has none: opening does nothing and closing answers false.
    openLinkList() { this._impl?.openLinkList?.(); },
    closeLinkList() { return this._impl?.closeLinkList?.() || false; },
    // Lines are counted from 1, the way every editor counts them. Both answer null/false for a line
    // number the text does not have, so the caller never has to know how long the text is.
    lineText(number) { return this._impl ? this._impl.lineText(number) : null; },
    removeLine(number) { return this._impl ? this._impl.removeLine(number) : false; },
    // Where the screen is, so that Ler and Editar agree on it: a line counted from 1, with a fraction
    // for how far down that line (a long paragraph is one line wrapped into many rows). Scrolling there
    // moves neither the caret nor the focus, so no keyboard comes up.
    topLine() { return this._impl ? this._impl.topLine() : null; },
    showLine(at) { this._impl?.showLine(at); },
    // Extract to a new note. The stretch is opaque, like a mark: `text` is the only field anyone
    // outside may read. The fallback textarea has neither: no stretch, and nothing gets replaced.
    selectedStretch() { return this._impl?.selectedStretch?.() ?? null; },
    replaceStretch(stretch, insert) { return this._impl?.replaceStretch?.(stretch, insert) || false; },
  },

  initEditor() {
    this.Editor.mount(this.els.editorElement, () => this.markDirty());
  },

  /** The fallback editor, for when the library did not load: a plain textarea. It takes the host's
      place in the DOM and becomes the els.editorElement, which is how the rest of the app reaches it. */
  createTextareaEditor(host, onChange) {
    const textarea = document.createElement('textarea');
    textarea.className = 'editor-fallback';
    textarea.placeholder = 'Comece a escrever...';
    host.replaceWith(textarea);
    this.els.editorElement = textarea;

    textarea.addEventListener('input', () => {
      onChange();
    });

    return {
      getText() {
        return App.els.editorElement.value || '';
      },

      setText(t) {
        App.els.editorElement.value = t;
      },

      focus() {
        App.els.editorElement.focus();
      },

      moveCaretToEnd() {
        const el = App.els.editorElement;
        el.selectionStart = el.selectionEnd = el.value.length;
      },

      markCaret() {
        // In an object, never the raw number: position 0 is falsy and would vanish in the receiver's `||`
        return { pos: App.els.editorElement.selectionStart };
      },

      insertOnOwnLine(text) {
        // The textarea's caret survives the file chooser, so the mark is not used here. Nobody can
        // say where the next line ended up: it answers undefined, as the contract demands.
        const ta = App.els.editorElement;
        const value = ta.value;
        const index = ta.selectionStart;
        const before = index > 0 && value[index - 1] !== '\n' ? '\n' : '';
        ta.value = value.slice(0, index) + before + text + '\n' + value.slice(index);
        ta.selectionStart = ta.selectionEnd = index + before.length + text.length + 1;
      },

      format(name) {
        const format = App.FORMATS[name];
        if (!format) return;
        const ta = App.els.editorElement;

        if (format.line) {
          const value = ta.value;
          const start = value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
          let end = value.indexOf('\n', ta.selectionEnd);
          if (end < 0) end = value.length;

          const block = value.slice(start, end).split('\n')
            .map(line => App.toggleLinePrefix(line, format.line)).join('\n');
          ta.value = value.slice(0, start) + block + value.slice(end);
          ta.selectionStart = ta.selectionEnd = start + block.length;
          ta.focus();
          return;
        }

        const [prefix, suffix] = format.wrap;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const selected = (ta.value.substring(start, end)) || (format.placeholder ?? 'texto');
        ta.value = ta.value.substring(0, start) + prefix + selected + suffix + ta.value.substring(end);
        ta.selectionStart = start + prefix.length;
        ta.selectionEnd = start + prefix.length + selected.length;
        ta.focus();
      },

      // The textarea's stack is the browser's own
      undo() { return typeof document.execCommand === 'function' && document.execCommand('undo'); },
      redo() { return typeof document.execCommand === 'function' && document.execCommand('redo'); },

      lineText(number) {
        const lines = (App.els.editorElement.value || '').split('\n');
        return number >= 1 && number <= lines.length ? lines[number - 1] : null;
      },

      removeLine(number) {
        const ta = App.els.editorElement;
        const lines = (ta.value || '').split('\n');
        if (number < 1 || number > lines.length) return false;
        lines.splice(number - 1, 1);
        ta.value = lines.join('\n');
        // Where the removed line started: the start of the line that took its place
        const at = lines.slice(0, number - 1).reduce((sum, line) => sum + line.length + 1, 0);
        ta.selectionStart = ta.selectionEnd = Math.min(at, ta.value.length);
        return true;
      },

      // With no lines of its own in the DOM there is nowhere to hang the picture, and no caret to chase
      decorateEmbeds() { return false; },
      scrollToCaret() {},

      // No rows to measure either: the lines are shared out over the height, roughly
      topLine() {
        const ta = App.els.editorElement;
        const total = (ta.value || '').split('\n').length;
        return ta.scrollHeight > 0 ? 1 + (ta.scrollTop / ta.scrollHeight) * total : 1;
      },
      showLine(at) {
        const ta = App.els.editorElement;
        const total = (ta.value || '').split('\n').length;
        ta.scrollTop = ((at - 1) / total) * ta.scrollHeight;
      },
    };
  },

  getContent() {
    return this.Editor.getText();
  },

  setContent(text) {
    this.Editor.setText(text);
    this.isDirty = false;
    this.updateFileNameDisplay();
    // Another note: pictures that were not found get another chance
    for (const [name, info] of this._embedInfo) if (!info) this._embedInfo.delete(name);
    this.scheduleEmbedDecoration();
  },
});
