// Drive Notes: rule-based cleanup of dictated text (punctuation, repetitions, hesitations).
// Pure text in, text out: no DOM and no App, so node:test can load it on its own
// (tests/dictation.test.js) and the editor only has to hand it a selection (T15).

const Dictation = {
  // Spoken commands, matched as whole words, case-insensitive, longest first (see COMMAND_RE).
  COMMANDS: [
    ['ponto e vírgula', ';'],
    ['ponto de interrogação', '?'],
    ['interrogação', '?'],
    ['ponto de exclamação', '!'],
    ['exclamação', '!'],
    ['ponto final', '.'],
    ['dois pontos', ':'],
    ['vírgula', ','],
    ['novo parágrafo', '\n\n'],
    ['nova linha', '\n'],
    ['abre parênteses', '('],
    ['abre parêntese', '('],
    ['fecha parênteses', ')'],
    ['fecha parêntese', ')'],
  ],

  // Words people double on purpose ("foi muito muito bom"): kept when said exactly twice.
  KEEP_DOUBLED: ['muito', 'bem', 'tão', 'mais', 'pouco', 'quase', 'nunca', 'sempre', 'já'],

  // A protected span (code, wikilink, URL, link target) stands in the text as one of these.
  // Private-use characters plus digits: no rule matches them and no speech contains them.
  HOLD_OPEN: '',
  HOLD_CLOSE: '',

  clean(text) {
    const out = [];
    let inFence = false;
    for (const line of text.split('\n')) {
      // Fenced code blocks, fences included, pass through untouched
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; out.push(line); continue; }
      if (inFence) { out.push(line); continue; }
      out.push(...this.cleanLine(line));
    }
    return out.join('\n');
  },

  /** One source line in, one or more lines out ("nova linha" splits it). */
  cleanLine(line) {
    const [marker] = /^\s*(?:>\s?)*\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+)?/.exec(line);
    let body = line.slice(marker.length);
    if (!body.trim()) return [line];
    // 1. Protect what is not speech
    const held = [];
    body = this.protect(body, held);
    // 2. Spoken commands; signs get their spacing right away so the next steps see words
    body = this.applyCommands(body);
    const pieces = body.split('\n');
    return pieces.map((piece, i) => {
      // Only the first piece keeps the original marker; the ones after a "nova linha" have none
      const pieceMarker = i === 0 ? marker : '';
      let t = this.fixSpacing(piece);
      if (!t) return pieceMarker.trimEnd();
      t = this.removeHesitations(t);             // 3
      t = this.removeRepetitions(t);             // 4
      t = this.commaBeforeAdversative(t);        // 5
      if (!/[-*+#\d]/.test(pieceMarker)) t = this.endSentence(t); // 6
      t = this.fixSpacing(t);                    // 7
      t = this.capitalize(t);                    // 8
      return pieceMarker + this.restore(t, held);
    });
  },

  /** Step 1: swap code spans, wikilinks, link targets and URLs for placeholders. */
  protect(text, held) {
    const hold = (match) => {
      held.push(match);
      return this.HOLD_OPEN + (held.length - 1) + this.HOLD_CLOSE;
    };
    return text
      .replace(/`[^`\n]+`/g, hold)
      .replace(/!?\[\[[^\]\n]*\]\]/g, hold)
      .replace(/\]\([^)\s]*\)/g, hold)
      // A URL's trailing sentence sign belongs to the sentence
      .replace(/\b(?:https?:\/\/|www\.)[^\s<>()[\]`]*[^\s<>()[\]`.,;:!?]/g, hold);
  },

  restore(text, held) {
    return text.replace(/(\d+)/g, (_, i) => held[Number(i)]);
  },

  /** Step 2: spoken punctuation and line breaks. The word "ponto" alone is never a sign. */
  applyCommands(text) {
    if (!this.COMMAND_RE) {
      const phrases = this.COMMANDS.map(([words]) => words).sort((a, b) => b.length - a.length);
      const alternatives = phrases.map((p) => p.split(' ').join('\\s+')).join('|');
      this.COMMAND_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'giu');
    }
    return text.replace(this.COMMAND_RE, (match) => {
      const spoken = match.toLowerCase().split(/\s+/).join(' ');
      const sign = this.COMMANDS.find(([words]) => words === spoken)[1];
      // Line breaks take the spaces around them, so the next line starts clean
      return sign.includes('\n') ? sign : ' ' + sign + ' ';
    }).replace(/[ \t]*\n[ \t]*/g, '\n');
  },

  /** Step 3: hesitations, as whole words, with the "...", "…" or "," glued to them. */
  removeHesitations(text) {
    return text
      .replace(/(?<![\p{L}\p{N}])(?:hãn|hã|ahn|ãh|hum|hmm|uhm|éé+)(?:\.\.\.|…|,)*(?![\p{L}\p{N}])/giu, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  },

  /** Comparison key of a word: no case, no accents, no trailing ",", "..." or "…". */
  wordKey(word) {
    return word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/(?:,|\.\.\.|…)+$/, '');
  },

  /** Step 4: a run of 1 to 3 words said again right after collapses to the first copy. */
  removeRepetitions(text) {
    let words = text.split(/\s+/);
    // Collapsing can bring two equal runs together, so repeat until nothing changes
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < words.length; i++) {
        for (let n = 3; n >= 1; n--) {
          const keys = words.slice(i, i + n).map((w) => this.wordKey(w));
          if (keys.length < n || keys.some((k) => !k)) continue;
          let copies = 1;
          while (i + (copies + 1) * n <= words.length
            && words.slice(i + copies * n, i + (copies + 1) * n).every((w, j) => this.wordKey(w) === keys[j])) {
            copies++;
          }
          if (copies === 1) continue;
          // Exception: a KEEP_DOUBLED word said exactly twice with only a space between
          if (n === 1 && copies === 2 && this.isKeptDouble(words[i])) continue;
          // Keep the first copy's words, with the sign that followed the last copy
          const last = words[i + copies * n - 1];
          const tail = /(?:,|\.\.\.|…)*$/.exec(last)[0];
          const kept = words.slice(i, i + n);
          kept[n - 1] = kept[n - 1].replace(/(?:,|\.\.\.|…)+$/, '') + tail;
          words.splice(i, copies * n, ...kept);
          changed = true;
          break;
        }
      }
    }
    return words.join(' ');
  },

  /** True for the first of two KEEP_DOUBLED copies that has no sign after it ("muito muito"). */
  isKeptDouble(word) {
    return this.KEEP_DOUBLED.includes(word.toLowerCase()) && !/(?:,|\.\.\.|…)$/.test(word);
  },

  /** Step 5: a comma before "mas", "porém", "contudo", "entretanto" and "só que" after a bare word. */
  commaBeforeAdversative(text) {
    return text.replace(
      /(?<=[\p{L}\p{N}])(\s+)(mas|porém|contudo|entretanto|só\s+que)(?![\p{L}\p{N}])/giu,
      ',$1$2',
    );
  },

  /** Step 6: a line of 3+ words with no closing sign gets "?" when it opens like a question, else ".". */
  endSentence(text) {
    if (/[.?!:;…]$/.test(text)) return text;
    const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    if (words.length < 3) return text;
    const question = /^[("“']*(?:quem|qual|quais|quando|onde|como|quantos?|quantas?|por\s+que|o\s+que|será\s+que|cadê)(?![\p{L}\p{N}])/iu;
    // A dangling comma gives way to the closing sign
    return text.replace(/,+$/, '') + (question.test(text) ? '?' : '.');
  },

  /** Step 7: no space before ", . ; : ? ! )", one after them before a letter, none after "(". */
  fixSpacing(text) {
    return text
      .replace(/\s+([,.;:?!)])/g, '$1')
      // After "." only before a capital, so file names like app.js stay whole
      .replace(/([,;:?!)])(?=\p{L})/gu, '$1 ')
      .replace(/\.(?=\p{Lu})/gu, '. ')
      .replace(/\(\s+/g, '(')
      .replace(/\s{2,}/g, ' ')
      .trim();
  },

  /** Step 8: capital on the first letter and after ". ? !" (not after "..."). Never lower-cases. */
  capitalize(text) {
    const upper = (_, before, letter) => before + letter.toUpperCase();
    return text
      .replace(/^([("“'[]*)(\p{Ll})/u, upper)
      .replace(/((?:(?<!\.)\.|[?!])\s+[("“'[]*)(\p{Ll})/gu, upper);
  },
};

if (typeof App !== 'undefined') App.Dictation = Dictation;
if (typeof module !== 'undefined') module.exports = Dictation;
