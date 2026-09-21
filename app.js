// Drive Notes — Main application logic
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
  // The note on its way from the Drive, as a view description. Until it arrives the screen still shows the
  // previous view, but for navigation the note is already where we are (see viewState).
  _opening: null,
  // A navigation begun by a tap (or a swipe forward) whose view has not landed yet: { pushed }, pushed
  // telling whether it put an entry on navStack. Null once a view lands or the navigation is dropped.
  _pending: null,
  // The drawing screen while it is open: { canvas, ctx, dpr, strokes, stroke, color, width, erase, at }.
  // `strokes` is the whole drawing (painting works from it, never from the pixels on screen) and
  // `at` is where the caret was in the note. Null while the screen is closed.
  sketch: null,
  // Recent navigation events, for the hidden diagnostics panel
  _log: [],

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
    };

    // Pointer used by older versions; drafts are now found by scanning their keys
    localStorage.removeItem('drivenotes_draft_latest');

    this.useWatcher = typeof CloseWatcher !== 'undefined';
    this.log('init');
    // The saved login does not depend on Google's script having loaded
    this.restoreToken();

    this.initEditor();
    this.bindEvents();
    this.initToolbarKeyboardHandler();
    this.showWelcome();
    this.syncHistory();
    this.renderDrafts();
    this.renderRecents();
  },

  // ── Editor ──
  // O app fala só com App.Editor. Atrás dele há três implementações (o CodeMirror 6, o TinyMDE
  // antigo e um textarea de reserva); nenhuma delas vaza pra fora daqui. Em especial, linha e
  // coluna ({row, col}) são vocabulário do TinyMDE: quem precisa de posição recebe uma marca
  // opaca e devolve ela.
  //
  // Duas regras que valem pra toda implementação, presente ou futura:
  //
  // 1. `marcarCursor()` devolve uma marca opaca ou null, e nada fora daqui pode abrir a marca.
  //    Ela nunca pode ser um valor falsy que não seja null (nem 0, nem ''): todo chamador testa a
  //    marca com `||`, e uma marca falsy seria jogada fora sem ninguém perceber.
  // 2. `inserirEmLinhaPropria(texto, marca)` devolve a marca da linha seguinte, a que ficou livre
  //    embaixo do que foi inserido. Não é opcional: uma leva de fotos usa esse retorno pra cada uma
  //    cair embaixo da anterior (ver savePhoto). Devolver undefined reintroduz o bug que o commit
  //    439b920 consertou, em que a leva saía de trás pra frente. Quem não souber dizer onde ficou
  //    (o textarea, cujo cursor anda sozinho) devolve undefined de propósito.

  Editor: {
    _impl: null,
    _tipo: 'textarea',

    iniciar(elemento, aoMudar) {
      const tentativas = [
        ['cm6', () => {
          if (!window.CM6) throw new Error('sem CM6');
          return App.implCM6(elemento, aoMudar);
        }],
        ['textarea', () => App.implTextarea(elemento, aoMudar)],
      ];
      for (const [tipo, montar] of tentativas) {
        try {
          this._impl = montar();
          this._tipo = tipo;
          return tipo;
        } catch (e) {
          // O erro inteiro, não só a mensagem: um bug dentro da implementação vira um aviso com
          // arquivo e linha, em vez de o app cair calado no textarea
          console.warn(`editor ${tipo} indisponivel:`, e);
          // A tentativa pode ter estourado já com meio editor pendurado no elemento: a próxima
          // precisa de um host limpo, senão a reserva aparece em cima do lixo da anterior
          elemento.replaceChildren();
        }
      }
      return this._tipo;
    },

    ativo() { return this._tipo; },
    texto() { return this._impl ? this._impl.texto() : ''; },
    definirTexto(t) { this._impl?.definirTexto(t); },
    focar() { this._impl?.focar(); },
    cursorNoFim() { this._impl?.cursorNoFim(); },
    marcarCursor() { return this._impl ? this._impl.marcarCursor() : null; },
    inserirEmLinhaPropria(texto, marca) { return this._impl?.inserirEmLinhaPropria(texto, marca); },
    formatar(nome) { this._impl?.formatar(nome); },
    desfazer() { return this._impl ? this._impl.desfazer() : false; },
    refazer() { return this._impl ? this._impl.refazer() : false; },
    decorarEmbeds(infoDaLinha) { return this._impl ? this._impl.decorarEmbeds(infoDaLinha) : false; },
    rolarAteOCursor() { this._impl?.rolarAteOCursor(); },
  },

  initEditor() {
    this.Editor.iniciar(this.els.editorElement, () => this.markDirty());
  },

  /** O editor de verdade: o CodeMirror 6. `window.CM6` é o pacote único de vendor/codemirror.js.
      As onze funções da fachada saem daqui; `iniciar` e `ativo` são da fachada, não desta. */
  implCM6(elemento, aoMudar) {
    const {
      EditorView, StateField, StateEffect, Transaction, Decoration, keymap, drawSelection,
      history, undo, redo, defaultKeymap, historyKeymap,
      markdown, markdownLanguage, insertNewlineContinueMarkupCommand,
      syntaxHighlighting, HighlightStyle, tags: t, lineWrapping,
    } = window.CM6;

    // Marcas de cursor. O CM6 sabe carregar uma posição através das edições que
    // aconteceram depois dela (mapPos), e é isso que faz a foto cair no lugar certo.
    const porMarca = StateEffect.define();
    const campoMarcas = StateField.define({
      create: () => new Map(),
      update(marcas, tr) {
        let novo = marcas;
        if (tr.docChanged) {
          novo = new Map();
          for (const [id, pos] of marcas) novo.set(id, tr.changes.mapPos(pos));
        }
        for (const efeito of tr.effects) {
          if (!efeito.is(porMarca)) continue;
          novo = new Map(novo);
          novo.set(efeito.value.id, efeito.value.pos);
        }
        return novo;
      },
    });

    // Decoração de embed. Ao contrário do TinyMDE, que zerava class e style a cada redesenho
    // e obrigava a reaplicar, aqui a decoração é parte do estado e sobrevive sozinha.
    let infoDaLinha = () => null;    // trocada por decorarEmbeds
    let ultimaAssinatura = '';       // pra saber se alguma linha mudou de verdade
    const refazerEmbeds = StateEffect.define();

    // Quanto de largura a foto tem de verdade: o `clientWidth` do contentDOM inclui o recuo de
    // 16px de cada lado que o style.css põe nele, e a linha não tem essa sobra. Contando o recuo,
    // a foto sai 32px mais larga que a linha e o lado direito fica cortado (num celular de 390px
    // são uns 34px). O desconto vem do estilo computado, e não de um número fixo, pra acompanhar
    // o style.css se o recuo mudar. Sem layout (jsdom) devolve 0, e quem chama cai no tamanho
    // da própria imagem, como já caía quando o clientWidth era 0.
    const larguraDisponivel = () => {
      if (!view) return 0;
      const estilo = getComputedStyle(view.contentDOM);
      const recuo = (parseFloat(estilo.paddingLeft) || 0) + (parseFloat(estilo.paddingRight) || 0);
      return Math.max(view.contentDOM.clientWidth - recuo, 0);
    };

    const construirEmbeds = (state) => {
      const marcas = [];
      // Uma medida por redesenho, e nenhuma quando a nota não tem foto: isto roda em toda tecla
      // digitada, e ler o DOM aqui dentro força o navegador a recalcular estilo e layout na hora
      let disponivel = null;
      for (let n = 1; n <= state.doc.lines; n++) {
        const linha = state.doc.line(n);
        const info = infoDaLinha(linha.text);
        if (!info) continue;
        if (disponivel === null) disponivel = larguraDisponivel();
        const largura = Math.min(disponivel || info.width, info.width);
        const altura = Math.round(Math.min(largura * info.height / info.width, App.EMBED_MAX_HEIGHT));
        marcas.push(Decoration.line({
          attributes: { class: 'embed-line', style: `--embed: url("${info.url}"); --embed-h: ${altura}px` },
        }).range(linha.from));
      }
      return Decoration.set(marcas);
    };

    const campoEmbeds = StateField.define({
      create: (state) => construirEmbeds(state),
      update(marcas, tr) {
        if (!tr.docChanged && !tr.effects.some((e) => e.is(refazerEmbeds))) return marcas;
        return construirEmbeds(tr.state);
      },
      provide: (campo) => EditorView.decorations.from(campo),
    });

    // Contar decorações não basta pra saber se algo mudou: trocar uma foto por outra do mesmo
    // tamanho mantém a contagem e muda a tela. Por isso a assinatura leva o estilo, não só a posição.
    const assinaturaDos = (conjunto) => {
      const partes = [];
      conjunto.between(0, Number.MAX_SAFE_INTEGER, (de, ate, deco) => {
        partes.push(`${de}:${deco.spec.attributes.style}`);
      });
      return partes.join('|');
    };

    const pintura = HighlightStyle.define([
      { tag: t.heading1, fontSize: '1.5em', fontWeight: '700', color: 'var(--accent-hover)' },
      { tag: t.heading2, fontSize: '1.3em', fontWeight: '600', color: 'var(--accent-hover)' },
      { tag: t.heading3, fontSize: '1.1em', fontWeight: '600', color: 'var(--accent-hover)' },
      { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600', color: 'var(--accent-hover)' },
      { tag: t.strong, fontWeight: '700' },
      { tag: t.emphasis, fontStyle: 'italic' },
      { tag: t.link, color: 'var(--accent-hover)', textDecoration: 'underline' },
      { tag: t.url, color: 'var(--accent-hover)' },
      { tag: t.monospace, background: 'rgba(255,255,255,0.08)' },
      { tag: t.quote, color: 'var(--text-secondary)' },
      { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--text-secondary)' },
    ]);

    // O cursor que está no texto é escolha de quem escreve, ou artefato de ter carregado a nota? A
    // diferença é esta marca. A seleção do CM6 é estado permanente: depois de carregar uma nota ela
    // fica em 0 sem ninguém ter escolhido isso, e uma foto tirada aí entraria na primeira linha, em
    // cima do frontmatter, deixando a nota sem `created` nem `updated`. Já um cursor posto pela
    // usuária vale mesmo depois que o foco vai embora, porque o seletor de foto rouba o foco e a
    // foto tem que cair onde ela deixou o cursor.
    let cursorPosto = false;

    // `let` e não `const`: o campo de decoração da tarefa 7 roda durante a construção do
    // EditorView e precisa consultar `view`. Com `const`, essa leitura cairia na zona morta
    // temporal e estouraria ReferenceError em vez de devolver null.
    let view = null;
    view = new EditorView({
      parent: elemento,
      extensions: [
        history(),
        drawSelection(),
        lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: [] }),
        syntaxHighlighting(pintura),
        campoMarcas,
        campoEmbeds,
        keymap.of([
          // nonTightLists:false: sem isso, sair de uma lista de tarefa de um item so custa tres
          // Enters em vez de um (o segundo insere uma linha em branco no meio e so o terceiro
          // encerra). O TinyMDE encerrava no segundo Enter, e e isso que continua acontecendo aqui.
          { key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) aoMudar();
          if (u.focusChanged && u.view.hasFocus) cursorPosto = true;
        }),
      ],
    });

    // Abrir uma nota troca o texto inteiro, e isso não é uma edição do usuário: sem esta marcação,
    // um desfazer logo depois de escrever apaga a nota e traz de volta o texto da nota anterior.
    const semHistorico = Transaction.addToHistory.of(false);

    let proximaMarca = 0;
    const novaMarca = (pos) => {
      const id = `m${proximaMarca++}`;
      return { id, efeito: porMarca.of({ id, pos }) };
    };
    const posDaMarca = (marca) => {
      if (marca == null) return null;
      const pos = view.state.field(campoMarcas).get(marca);
      return pos == null ? null : Math.min(pos, view.state.doc.length);
    };

    return {
      view,
      texto: () => view.state.doc.toString(),
      definirTexto: (t2) => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: t2 },
          annotations: semHistorico,
        });
        // Texto novo. Se a troca pegou a pessoa dentro do editor (a recarga depois de um conflito),
        // ela está ali escrevendo e o cursor dela continua sendo a melhor aposta; com o editor fora
        // de foco é nota aberta da lista, e aí ninguém pôs cursor nenhum neste texto
        cursorPosto = view.hasFocus;
      },
      focar: () => view.focus(),
      cursorNoFim: () => view.dispatch({ selection: { anchor: view.state.doc.length } }),
      marcarCursor: () => {
        if (!cursorPosto) return null;
        const nova = novaMarca(view.state.selection.main.head);
        view.dispatch({ effects: nova.efeito });
        return nova.id;
      },
      inserirEmLinhaPropria: (texto, marca) => {
        // Sem marca e sem cursor posto (nota aberta da lista e câmera tocada antes do texto), o
        // lugar seguro é o fim da nota: o começo é onde mora o frontmatter
        const pos = posDaMarca(marca)
          ?? (cursorPosto ? view.state.selection.main.head : view.state.doc.length);
        const linha = view.state.doc.lineAt(pos);
        // Se há texto antes do cursor na linha, a inserção começa numa linha nova
        const antes = view.state.doc.sliceString(linha.from, pos).trim() ? '\n' : '';
        // Começo da linha seguinte, já no documento novo. Não dá pra devolver a marca recebida:
        // uma posição mapeada por uma inserção no próprio ponto fica ANTES do que foi inserido,
        // e a foto seguinte da leva entraria em cima desta (a ordem invertida do commit 439b920).
        const seguinte = pos + antes.length + texto.length + 1;
        const nova = novaMarca(seguinte);
        view.dispatch({
          changes: { from: pos, insert: `${antes}${texto}\n` },
          selection: { anchor: seguinte },
          effects: nova.efeito,
        });
        return nova.id;
      },
      desfazer: () => undo(view),
      refazer: () => redo(view),
      formatar: (nome) => {
        const formato = App.FORMATS[nome];
        if (!formato) { view.focus(); return; }
        const sel = view.state.selection.main;

        if (formato.wrap) {
          const [antes, depois] = formato.wrap;
          const escolhido = view.state.doc.sliceString(sel.from, sel.to) || 'texto';
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: `${antes}${escolhido}${depois}` },
            // a seleção fica no miolo, pra sobrescrever "texto" digitando
            selection: { anchor: sel.from + antes.length, head: sel.from + antes.length + escolhido.length },
            userEvent: 'input',
          });
          view.focus();
          return;
        }

        // Marcador de linha: vale pra toda linha tocada pela seleção. Se a seleção termina
        // exatamente no começo de uma linha, essa linha não foi tocada de verdade (é só onde a
        // seleção parou), e não entra, a não ser que seja a única linha da seleção. É a mesma
        // guarda do changeBySelectedLine do próprio CM6 (@codemirror/commands, usada por
        // indentMore e por toggleLineComment), adaptada pra uma seleção só em vez de várias.
        const primeira = view.state.doc.lineAt(sel.from).number;
        let ultima = view.state.doc.lineAt(sel.to).number;
        if (!sel.empty && ultima > primeira && sel.to <= view.state.doc.line(ultima).from) ultima--;
        const mudancas = [];
        for (let n = primeira; n <= ultima; n++) {
          const linha = view.state.doc.line(n);
          mudancas.push({ from: linha.from, to: linha.to, insert: App.toggleLinePrefix(linha.text, formato.line) });
        }
        view.dispatch({ changes: mudancas, userEvent: 'input' });
        view.focus();
      },
      decorarEmbeds: (fn) => {
        infoDaLinha = fn;
        view.dispatch({ effects: refazerEmbeds.of(null) });
        const agora = assinaturaDos(view.state.field(campoEmbeds));
        const mudou = agora !== ultimaAssinatura;
        ultimaAssinatura = agora;
        return mudou;
      },
      rolarAteOCursor: () => view.dispatch({
        effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 32 }),
      }),
    };
  },

  /** Só pros testes: digita no fim do documento como uma edição de usuário. O `userEvent` é o que
      faz o histórico do desfazer registrar a digitação. */
  cm6Digitar(texto) {
    const view = this.Editor._impl?.view;
    if (!view) return;
    view.dispatch({ changes: { from: view.state.doc.length, insert: texto }, userEvent: 'input.type' });
  },

  /** O editor rico de hoje, o TinyMDE 0.1.8. A instância fica pendurada em App.editor porque é por
      lá que a suíte de navegador dirige o editor; as funções da fachada não leem de lá, recebem a
      instância pronta. */
  implTinyMDE(elemento, aoMudar) {
    const ed = new TinyMDE.Editor({ element: elemento });
    this.editor = ed;

    ed.addEventListener('change', () => {
      aoMudar();
    });
    this.guardComposition();

    return this.apiTinyMDE(ed);
  },

  /** As onze funções da fachada sobre uma instância do TinyMDE já montada. Separado da construção
      para que um editor de mentira possa ocupar o lugar dela (é o que o teste da fila de fotos faz). */
  apiTinyMDE(ed) {
    return {
      texto() {
        return ed.getContent();
      },

      definirTexto(t) {
        ed.setContent(t);
      },

      focar() {
        // TinyMDE: o foco vai no contentEditable de dentro, que é o ed.e
        ed.e?.focus();
      },

      cursorNoFim() {
        const row = ed.lines.length - 1;
        ed.setSelection({ row, col: ed.lines[row].length });
      },

      marcarCursor() {
        return ed.getSelection(false);
      },

      inserirEmLinhaPropria(texto, marca) {
        const last = ed.lines.length - 1;
        const wanted = ed.getSelection(false) || marca || { row: last, col: ed.lines[last].length };
        // A nota pode ter encolhido enquanto a foto subia
        const row = Math.min(wanted.row, last);
        const pos = { row, col: Math.min(wanted.col, ed.lines[row].length) };
        const before = ed.lines[row].slice(0, pos.col).trim() ? '\n' : '';
        ed.paste(`${before}${texto}\n`, pos, { ...pos });
        return { row: pos.row + (before ? 2 : 1), col: 0 };
      },

      formatar(nome) {
        const format = App.FORMATS[nome];
        if (!format) return;
        if (format.command) {
          ed.setCommandState(format.command, ed.getCommandState()[format.command] !== true);
        } else if (format.wrap) {
          ed.wrapSelection(...format.wrap);
        } else {
          // No TinyMDE command for this marker: same steps its own line commands take
          const focus = ed.getSelection(false);
          const anchor = ed.getSelection(true) || focus;
          if (!focus) return;
          const first = Math.min(focus.row, anchor.row);
          const last = Math.max(focus.row, anchor.row);
          for (let row = first; row <= last; row++) {
            ed.lines[row] = App.toggleLinePrefix(ed.lines[row], format.line);
            ed.lineDirty[row] = true;
          }
          ed.updateFormatting();
          ed.setSelection({ row: last, col: ed.lines[last].length });
        }
      },

      // O TinyMDE não tem pilha própria de desfazer: é por isso que a troca de editor existe
      desfazer() { return false; },
      refazer() { return false; },

      decorarEmbeds(infoDaLinha) {
        let changed = false;

        ed.lines.forEach((line, row) => {
          const el = ed.lineElements[row];
          if (!el?.style) return;
          const info = infoDaLinha(line);

          if (!info) {
            if (el.classList.contains('embed-line')) {
              el.classList.remove('embed-line');
              el.style.removeProperty('--embed');
              el.style.removeProperty('--embed-h');
              changed = true;
            }
            return;
          }

          // As wide as the line at most, never blown up, and a tall screenshot does not take over the screen
          const width = Math.min(el.clientWidth || info.width, info.width);
          const height = `${Math.round(Math.min(width * info.height / info.width, App.EMBED_MAX_HEIGHT))}px`;
          // TinyMDE wipes class and style whenever it redraws the line, so this is put back after every change
          if (!el.classList.contains('embed-line') || el.style.getPropertyValue('--embed-h') !== height) {
            el.classList.add('embed-line');
            el.style.setProperty('--embed', `url("${info.url}")`);
            el.style.setProperty('--embed-h', height);
            changed = true;
          }
        });

        return changed;
      },

      rolarAteOCursor() {
        const scroller = ed.e;
        const selection = window.getSelection();
        if (!scroller || !selection.rangeCount || !scroller.contains(selection.focusNode)) return;

        // A collapsed range at the end of a line can report an empty box: use its line instead
        let rect = selection.getRangeAt(0).getBoundingClientRect();
        if (!rect.height) {
          const node = selection.focusNode;
          rect = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement).getBoundingClientRect();
        }
        const box = scroller.getBoundingClientRect();
        if (rect.bottom > box.bottom - 12) scroller.scrollTop += rect.bottom - box.bottom + 32;
        else if (rect.top < box.top) scroller.scrollTop -= box.top - rect.top + 12;
      },
    };
  },

  /** TinyMDE redraws the line and resets the caret on every input event. While the keyboard is
      composing (voice typing, swipe, word suggestions) that throws away the region the keyboard is
      working on, and each partial result lands as new text: "NãoNão consigoNão consigo ditar".
      So composition updates are kept from TinyMDE, and it gets one input event when the composition ends. */
  guardComposition() {
    const editable = this.editor.e;
    if (!editable) return;

    editable.addEventListener('input', (e) => {
      if (e.isComposing && /CompositionText$/.test(e.inputType || '')) {
        e.stopImmediatePropagation();
        this._composed = true;
        this.markDirty(); // TinyMDE's change event is on hold with the rest
      }
    }, true);

    editable.addEventListener('compositionend', () => {
      if (!this._composed) return;
      this._composed = false;
      editable.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }));
    });
  },

  /** O editor de reserva, para quando a biblioteca não carregou: um textarea puro. Ele toma o lugar
      do elemento no DOM e vira o els.editorElement, que é por onde o resto do app o alcança. */
  implTextarea(elemento, aoMudar) {
    const textarea = document.createElement('textarea');
    textarea.className = 'editor-fallback';
    textarea.placeholder = 'Comece a escrever...';
    elemento.replaceWith(textarea);
    this.els.editorElement = textarea;
    this.editor = null;

    textarea.addEventListener('input', () => {
      aoMudar();
    });

    return {
      texto() {
        return App.els.editorElement.value || '';
      },

      definirTexto(t) {
        App.els.editorElement.value = t;
      },

      focar() {
        App.els.editorElement.focus();
      },

      cursorNoFim() {
        const el = App.els.editorElement;
        el.selectionStart = el.selectionEnd = el.value.length;
      },

      marcarCursor() {
        // Num objeto, nunca no número cru: a posição 0 é falsy e sumiria no `||` de quem recebe
        return { pos: App.els.editorElement.selectionStart };
      },

      inserirEmLinhaPropria(texto) {
        // O cursor do textarea sobrevive ao seletor de arquivo, então a marca não é usada aqui.
        // Ninguém sabe dizer onde a linha seguinte ficou: devolve undefined, como manda o contrato.
        const ta = App.els.editorElement;
        const value = ta.value;
        const index = ta.selectionStart;
        const before = index > 0 && value[index - 1] !== '\n' ? '\n' : '';
        ta.value = value.slice(0, index) + before + texto + '\n' + value.slice(index);
        ta.selectionStart = ta.selectionEnd = index + before.length + texto.length + 1;
      },

      formatar(nome) {
        const format = App.FORMATS[nome];
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
        const selected = ta.value.substring(start, end) || 'texto';
        ta.value = ta.value.substring(0, start) + prefix + selected + suffix + ta.value.substring(end);
        ta.selectionStart = start + prefix.length;
        ta.selectionEnd = start + prefix.length + selected.length;
        ta.focus();
      },

      // A pilha do textarea é a do próprio navegador
      desfazer() { return typeof document.execCommand === 'function' && document.execCommand('undo'); },
      refazer() { return typeof document.execCommand === 'function' && document.execCommand('redo'); },

      // Sem linhas próprias no DOM não há onde pendurar a imagem, e não há cursor a perseguir
      decorarEmbeds() { return false; },
      rolarAteOCursor() {},
    };
  },

  getContent() {
    return this.Editor.texto();
  },

  setContent(text) {
    this.Editor.definirTexto(text);
    this.isDirty = false;
    this.updateFileNameDisplay();
    // Another note: pictures that were not found get another chance
    for (const [name, info] of this._embedInfo) if (!info) this._embedInfo.delete(name);
    this.scheduleEmbedDecoration();
  },

  // ── Google Auth ──

  onGisLoaded() {
    this.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: SCOPES,
      callback: '', // set dynamically
      // Popup blocked or closed: fail the pending request instead of leaving it hanging
      error_callback: (err) => {
        if (this._authReject) this._authReject(err);
      },
    });
  },

  /** Save token + expiry to localStorage (persists across PWA restarts) */
  saveToken(accessToken, expiresIn) {
    this.accessToken = accessToken;
    const expiresAt = Date.now() + (expiresIn || 3600) * 1000;
    localStorage.setItem('drivenotes_token', accessToken);
    localStorage.setItem('drivenotes_token_expires', expiresAt.toString());

    // Schedule silent refresh 5 minutes before expiry
    this.scheduleTokenRefresh(expiresAt);
    this.rememberLoginHint();
  },

  /** Learn the account email once, so later logins skip the account chooser.
      Kept in localStorage only: the repo is public, so it must not live in CONFIG. */
  async rememberLoginHint() {
    if (localStorage.getItem('drivenotes_login_hint')) return;
    try {
      const response = await fetch(
        'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
        { headers: { 'Authorization': `Bearer ${this.accessToken}` } }
      );
      if (!response.ok) return;
      const email = (await response.json()).user?.emailAddress;
      if (email) localStorage.setItem('drivenotes_login_hint', email);
    } catch {
      // ignore: the hint is a convenience
    }
  },

  /** Options for tokenClient.requestAccessToken */
  tokenRequest(prompt) {
    const hint = localStorage.getItem('drivenotes_login_hint');
    return hint ? { prompt, login_hint: hint } : { prompt };
  },

  /** Restore token from localStorage if still valid. Falls back to legacy sessionStorage. */
  restoreToken() {
    const token = localStorage.getItem('drivenotes_token')
      || sessionStorage.getItem('drivenotes_token');
    const expiresAt = parseInt(
      localStorage.getItem('drivenotes_token_expires')
      || sessionStorage.getItem('drivenotes_token_expires')
      || '0'
    );

    if (token && expiresAt > Date.now() + 60000) {
      // Token exists and has more than 1 minute left
      this.accessToken = token;
      this.scheduleTokenRefresh(expiresAt);
      console.log('Drive Notes: token restored, expires in', Math.round((expiresAt - Date.now()) / 60000), 'min');
    }
  },

  /** Schedule silent token refresh before expiry */
  scheduleTokenRefresh(expiresAt) {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);

    // Refresh 5 minutes before expiry
    const refreshIn = expiresAt - Date.now() - 5 * 60 * 1000;
    if (refreshIn <= 0) return;

    this._refreshTimer = setTimeout(() => {
      this.silentRefresh();
    }, refreshIn);
  },

  /** Silently refresh the token without user interaction */
  silentRefresh() {
    if (!this.tokenClient) return;

    this.tokenClient.callback = (response) => {
      if (response.error) {
        console.warn('Silent refresh failed:', response.error);
        this.accessToken = null;
        localStorage.removeItem('drivenotes_token');
        localStorage.removeItem('drivenotes_token_expires');
        sessionStorage.removeItem('drivenotes_token');
        sessionStorage.removeItem('drivenotes_token_expires');
        return;
      }
      this.saveToken(response.access_token, response.expires_in);
      console.log('Drive Notes: token refreshed silently');
    };
    this.tokenClient.requestAccessToken(this.tokenRequest(''));
  },

  /** Ensure we have a valid access token. Returns a promise. */
  /** True while the token in hand has more than a minute left */
  hasValidToken() {
    const expiresAt = parseInt(
      localStorage.getItem('drivenotes_token_expires')
      || sessionStorage.getItem('drivenotes_token_expires')
      || '0'
    );
    return !!this.accessToken && expiresAt > Date.now() + 60000;
  },

  async ensureAuth() {
    if (this.hasValidToken()) {
      return this.accessToken;
    }

    // Token missing or expiring: request a new one
    this.accessToken = null;
    return this.requestToken('');
  },

  /** Ask Google for a token. Always settles: a blocked popup, an error or 3 minutes of silence reject,
      so a save waiting on it falls back to the local draft instead of hanging. */
  requestToken(prompt) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('auth timeout')), 180000);
      this._authReject = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      this.tokenClient.callback = (response) => {
        clearTimeout(timer);
        if (response.error) {
          reject(response);
          return;
        }
        this.saveToken(response.access_token, response.expires_in);
        resolve(this.accessToken);
      };
      this.tokenClient.requestAccessToken(this.tokenRequest(prompt));
    });
  },

  /** Re-authenticate (e.g. after token expiry / 401) */
  async reAuth() {
    this.accessToken = null;
    localStorage.removeItem('drivenotes_token');
    localStorage.removeItem('drivenotes_token_expires');
    sessionStorage.removeItem('drivenotes_token');
    sessionStorage.removeItem('drivenotes_token_expires');

    // No forced consent screen: with the login hint this is a popup that closes by itself
    return this.requestToken('');
  },

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


  /** Open a Drive file, in the reading view. Shared by the Picker, the recents list, links and "back".
      `heading` scrolls to a title once open. Callers reacting to a tap call beginNav() first. */
  async openFile(fileId, fileName, { heading = '' } = {}) {
    try {
      return await this.loadFile(fileId, fileName, heading);
    } finally {
      // Whatever ended up on screen: the note, its draft, or the previous view if loading failed
      this.syncHistory();
    }
  },

  async loadFile(fileId, fileName, heading) {
    const draftKey = `drivenotes_draft_${fileId}`;

    try {
      await this.ensureAuth();
    } catch {
      // No login (offline, popup blocked): unsynced local edits of this file are still reachable
      if (this.openDraft(draftKey)) return true;
      this.setSaveStatus('error', 'Faça login primeiro');
      return false;
    }

    // Whatever is open gets saved before it is replaced
    this.flushCurrent();

    const seq = ++this._loadSeq;
    const opening = this._opening = { view: 'file', id: fileId, name: fileName };
    const started = Date.now();
    this.setSaveStatus('saving', 'Carregando...');

    let meta, content;
    try {
      // Metadata first: if the file changes between the two requests we end up with an
      // older modifiedTime than the content, which errs towards a false conflict, never a missed one
      meta = await this.driveGetFileMeta(fileId);
      content = await this.driveGetFileContent(fileId);
    } catch (e) {
      console.error('Failed to load file:', e);
      if (seq !== this._loadSeq) return true;
      if (this._opening === opening) this._opening = null;
      // Offline or Drive error: unsynced local edits of this file are still reachable
      if (this.openDraft(draftKey)) return true;
      this.setSaveStatus('error', 'Erro ao carregar');
      return false;
    }
    if (seq !== this._loadSeq) return true; // another file was opened meanwhile: not ours to undo
    this.log(`loaded ${meta.name || fileName} ${Date.now() - started}ms`);

    const file = {
      id: fileId,
      name: meta.name || fileName,
      draftKey,
      modifiedTime: meta.modifiedTime,
      parents: meta.parents,
    };

    // Unsynced local edits win over the Drive copy; the conflict check on save arbitrates
    const draft = this.readDraft(draftKey);
    if (draft && draft.content !== content) {
      file.modifiedTime = draft.baseModifiedTime;
      this.currentFile = file;
      this.setContent(draft.content);
      this.isDirty = true;
      this.updateFileNameDisplay();
      this.showEditor();
      this.setSaveStatus('', 'Rascunho não sincronizado');
    } else {
      if (draft) localStorage.removeItem(draftKey);
      this.currentFile = file;
      this.setContent(content);
      // What the editor gives back for an untouched file, so opening never counts as a change
      file.lastSavedContent = this.getContent();
      this.showEditor('preview');
      this.scrollToHeading(heading);
      this.setSaveStatus('saved', 'Carregado');
      setTimeout(() => {
        if (this.currentFile === file) this.setSaveStatus('', '');
      }, 2000);
    }
    this.saveToRecents(fileId, file.name);
    return true;
  },

  /** A tap that leads to a note: the history entry is created now, and dropped again if the note never opens */
  async navigateTo(fileId, fileName, options) {
    this.beginNav();
    if (!(await this.openFile(fileId, fileName, options))) this.cancelNav();
  },

  // ── Google Drive API ──

  /** fetch with the access token; on 401 re-authenticates and retries once */
  async driveFetch(url, options = {}, retried = false) {
    const response = await fetch(url, {
      ...options,
      headers: { ...options.headers, 'Authorization': `Bearer ${this.accessToken}` },
    });

    if (response.status === 401 && !retried) {
      await this.reAuth();
      return this.driveFetch(url, options, true);
    }

    if (!response.ok) {
      throw new Error(`Drive request failed: ${response.status}`);
    }

    return response;
  },

  /** Fetch file metadata by ID */
  async driveGetFileMeta(fileId, fields = 'id,name,modifiedTime,parents') {
    const response = await this.driveFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=${fields}`
    );
    return response.json();
  },

  /** Folders and notes directly inside a folder: folders first, then by name the way a person sorts ("2" before "10") */
  async driveListFolder(folderId) {
    const FOLDER = 'application/vnd.google-apps.folder';
    const found = [];
    let pageToken = '';
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id,name,mimeType,modifiedTime)',
        pageSize: '1000',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await this.driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`);
      const data = await response.json();
      found.push(...(data.files || []));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }

    return found
      // Dot-folders (.obsidian, .trash) stay hidden, as in Obsidian
      .filter(f => !f.name.startsWith('.') && (f.mimeType === FOLDER || this.isNote(f)))
      .map(f => ({ id: f.id, name: f.name, isFolder: f.mimeType === FOLDER, modifiedTime: f.modifiedTime }))
      .sort((a, b) => (b.isFolder - a.isFolder)
        || a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' }));
  },

  isNote(f) {
    return /\.(md|markdown|txt)$/i.test(f.name) || (f.mimeType || '').startsWith('text/');
  },

  /** A string inside a Drive query */
  driveQuote(s) {
    return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  },

  /** Files with every word in the name or in the text, anywhere in Drive, in the Drive's own order of relevance.
      The name is matched on the start of a word and minds accents; the text is matched on whole words and
      does not, and it includes the name: between the two, "relat" and "relatorio" both find "Relatório". */
  async driveSearch(words) {
    const has = (w) => `(name contains ${this.driveQuote(w)} or fullText contains ${this.driveQuote(w)})`;
    const params = new URLSearchParams({
      q: `${words.map(has).join(' and ')} and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name,parents,mimeType,modifiedTime)',
      pageSize: '50',
    });
    const response = await this.driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    return (await response.json()).files || [];
  },

  /** Files with exactly one of these names, anywhere in Drive, newest first */
  async driveFindByName(names) {
    const q = `(${names.map(n => `name = ${this.driveQuote(n)}`).join(' or ')}) and trashed = false`;
    const params = new URLSearchParams({
      q,
      fields: 'files(id,name,parents,mimeType)',
      orderBy: 'modifiedTime desc',
      pageSize: '20',
    });
    const response = await this.driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    return (await response.json()).files || [];
  },

  /** ID of the vault's attachment folder, or null. Looked up once per device. */
  async getMediaFolderId() {
    const cached = localStorage.getItem('drivenotes_media_folder');
    if (cached) return cached;
    const folder = (await this.driveFindByName([CONFIG.MEDIA_FOLDER])).find(f =>
      f.mimeType === 'application/vnd.google-apps.folder' && f.parents?.includes(CONFIG.VAULT_FOLDER_ID));
    if (!folder) return null;
    localStorage.setItem('drivenotes_media_folder', folder.id);
    return folder.id;
  },

  /** Fetch file content by ID */
  async driveGetFileContent(fileId) {
    const response = await this.driveFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
    );
    return response.text();
  },

  /** Rename a file. Resolves to { id, name, modifiedTime }. */
  async driveRenameFile(fileId, name) {
    const response = await this.driveFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,modifiedTime`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }
    );
    return response.json();
  },

  /** Update existing file content. Resolves to { id, modifiedTime }. */
  async driveUpdateFile(fileId, content) {
    const response = await this.driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,modifiedTime`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'text/plain' },
        body: content,
      }
    );
    return response.json();
  },

  /** Create a new file on Drive */
  async driveCreateFile(name, content, folderId) {
    const metadata = {
      name: name,
      mimeType: 'text/markdown',
    };
    if (folderId) {
      metadata.parents = [folderId];
    }

    // Multipart upload: metadata + content in one request
    const boundary = '---drivenotes' + Date.now();
    const body =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/markdown\r\n\r\n` +
      `${content}\r\n` +
      `--${boundary}--`;

    const response = await this.driveFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,parents,modifiedTime',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: body,
      }
    );
    return response.json();
  },

  /** Upload a binary file (a photo) into a folder. Resolves to { id, name }. */
  async driveUploadBlob(name, blob, folderId) {
    const boundary = '---drivenotes' + Date.now();
    const body = new Blob([
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify({ name, parents: [folderId] })}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);

    const response = await this.driveFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: body,
      }
    );
    return response.json();
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

  // ── Reading view ──

  renderPreview() {
    const container = this.els.previewContainer;
    const { frontmatter, body } = this.splitFrontmatter(this.getContent());

    // The token in this page has full Drive scope, so rendered HTML is never trusted:
    // without the sanitizer (or the renderer) the note is shown as plain text instead
    const canRender = typeof DOMPurify !== 'undefined' && typeof marked !== 'undefined';
    container.style.whiteSpace = canRender ? '' : 'pre-wrap';
    if (!canRender) {
      container.textContent = body;
      return;
    }

    container.innerHTML = DOMPurify.sanitize(marked.parse(body));
    this.decoratePreview(container);
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

  /** Blob URL for an image found by file name, or null. Never opens a login popup just for a picture. */
  async fetchEmbed(name) {
    if (!this.hasValidToken()) return null;
    const images = (await this.driveFindByName([name])).filter(f => (f.mimeType || '').startsWith('image/'));
    if (!images.length) return null;

    // Same name in more than one place: the one in the attachment folder wins, then the newest
    let pick = images[0];
    if (images.length > 1) {
      const media = await this.getMediaFolderId().catch(() => null);
      pick = images.find(f => media && f.parents?.includes(media)) || pick;
    }
    const response = await this.driveFetch(`https://www.googleapis.com/drive/v3/files/${pick.id}?alt=media`);
    return URL.createObjectURL(await response.blob());
  },

  // ── Pictures while editing ──
  // A line that is nothing but ![[image]] shows the picture right under it, so a note can be written
  // while looking at what it talks about. The picture is a background of the line plus bottom padding:
  // the text stays raw markdown and TinyMDE, which rebuilds a line from its text, never meets an <img>.

  EMBED_LINE: /^\s*!\[\[([^\]\n|#]+\.(?:png|jpe?g|gif|webp|bmp|avif|svg))(?:\|[^\]\n]*)?\]\]\s*$/i,
  EMBED_MAX_HEIGHT: 300,

  scheduleEmbedDecoration() {
    clearTimeout(this._embedTimer);
    this._embedTimer = setTimeout(() => this.decorateEditorEmbeds(), 120);
  },

  /** A foto de uma linha que é só ![[imagem]], se as medidas dela já chegaram do Drive.
      Devolve null e dispara a busca quando ainda não chegaram. */
  embedDaLinha(linha) {
    const nome = this.EMBED_LINE.exec(linha)?.[1].split('/').pop().trim();
    if (!nome) return null;
    const info = this._embedInfo.get(nome);
    if (!info) {
      if (!this._embedInfo.has(nome)) this.loadEmbedInfo(nome);
      return null;
    }
    return info;
  },

  decorateEditorEmbeds() {
    if (this.mode !== 'edit') return;
    const mudou = this.Editor.decorarEmbeds((linha) => this.embedDaLinha(linha));
    // Lines got taller or shorter: the one being typed must stay above the keyboard
    if (mudou) this.scrollCaretIntoView();
  },

  async loadEmbedInfo(name) {
    this._embedInfo.set(name, null);
    if (!this._embedUrls.has(name)) {
      this._embedUrls.set(name, this.fetchEmbed(name).catch(() => null));
    }
    const url = await this._embedUrls.get(name);
    if (!url) {
      this._embedUrls.delete(name);
      return;
    }
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      return;
    }
    if (!img.naturalWidth || !img.naturalHeight) return;
    this._embedInfo.set(name, { url, width: img.naturalWidth, height: img.naturalHeight });
    this.decorateEditorEmbeds();
  },

  /** Taps inside the reading view: wikilinks and relative .md links open notes, the rest leaves the app */
  onPreviewClick(e) {
    const link = e.target.closest('a');
    if (!link || !this.els.previewContainer.contains(link)) return;
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

    const base = target.split('/').pop().trim();
    const names = /\.md$/i.test(base) ? [base] : [`${base}.md`, base];
    this.setSaveStatus('saving', 'Procurando...');

    let matches;
    try {
      await this.ensureAuth();
      matches = await this.driveFindByName(names);
    } catch (e) {
      console.error('Link lookup failed:', e);
      if (seq !== this._loadSeq) return;
      this.setSaveStatus('error', 'Erro ao procurar a nota');
      this.cancelNav();
      return;
    }
    if (seq !== this._loadSeq) return; // overtaken by another tap, or dropped by "back"

    const isText = (f) => /\.(md|markdown|txt)$/i.test(f.name) || (f.mimeType || '').startsWith('text/');
    const notes = matches.filter(isText);
    if (!notes.length) {
      this.setSaveStatus('error', matches.length ? `Não abro esse tipo: ${base}` : `Nota não encontrada: ${base}`);
      this.cancelNav();
      return;
    }

    // Same name in more than one place: the one next to the open note wins, then .md over the rest
    const folder = this.currentFile?.parents?.[0];
    const pick = notes.find(f => folder && f.parents?.includes(folder))
      || notes.find(f => /\.md$/i.test(f.name))
      || notes[0];

    if (!(await this.openFile(pick.id, pick.name, { heading }))) this.cancelNav();
  },

  scrollToHeading(heading) {
    if (!heading) return;
    const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    const wanted = norm(heading);
    const slug = wanted.replace(/ /g, '-');
    const found = [...this.els.previewContainer.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .find(h => norm(h.textContent) === wanted || norm(h.textContent).replace(/ /g, '-') === slug);
    if (found) found.scrollIntoView({ block: 'start' });
  },

  // ── Navigation (back button, Android back gesture) ──

  // A view is described by { view: 'welcome' }, { view: 'file', id, name } or { view: 'browse', id, name, path }.
  //
  // Two ways to make the system back button walk through views instead of closing the app:
  // - CloseWatcher (useWatcher): the API Chrome gives apps for the Android back button. While one is
  //   active, "back" fires its close event and never touches the session history. The views left
  //   behind live in navStack. This is the one used wherever it exists.
  // - History API: one history entry per view, carrying its description; "back" lands on an entry
  //   and onPopState shows what it says.

  viewState() {
    // Read while a note is still loading, the screen would describe the view before it: two quick steps
    // (forward twice, two taps on the list) then left the same folder on the back stack more than once
    if (this._opening) return this._opening;
    const file = this.currentFile;
    if (file) return { view: 'file', id: file.id, name: file.name };
    if (this.folder) return { view: 'browse', ...this.folder };
    return { view: 'welcome' };
  },

  /** Show the view a description stands for; nothing to do if it is already on screen */
  show(state) {
    this.log(`show ${state?.view || 'welcome'} ${state?.name || ''}`);
    if (state?.view === 'file' && state.id) {
      if (state.id !== this.currentFile?.id) return this.openFile(state.id, state.name);
      if (this._opening) {
        // Back to the note on screen while another was on its way: give up on that one
        this._loadSeq++;
        this._opening = null;
        this.setSaveStatus('', '');
      }
    } else if (state?.view === 'browse') {
      if (this._opening || this.currentFile || this.folder?.id !== state.id) {
        return this.openFolder({ id: state.id, name: state.name, path: state.path || [], query: state.query || '' });
      }
    } else if (this.currentFile || this.folder || document.body.dataset.view !== 'welcome') {
      // (already there when a failed navigation is being undone: its error message stays on screen)
      this.goHome();
    }
  },

  /** Call synchronously from the tap that starts a navigation. In History mode Chrome's back button
      skips entries that were not created during a user gesture, so this cannot wait for the Drive. */
  beginNav() {
    if (this.useWatcher) {
      // A navigation still under way (looking a link up, a note loading) never reached the screen:
      // its entry already stands for the view being left
      const pushed = this._pending ? this._pending.pushed : true;
      if (!this._pending) this.navStack.push(this.viewState());
      this._pending = { pushed };
      this.fwdStack = []; // going somewhere new: nothing is "ahead" any more, as in a browser
      this.armWatcher();
    } else {
      history.pushState(this.viewState(), '');
    }
    this.log('beginNav');
  },

  /** The navigation begun never changed the view: forget it */
  cancelNav() {
    if (this.useWatcher) {
      if (this._pending?.pushed) this.navStack.pop();
      this._pending = null;
      this._opening = null;
      this.armWatcher();
    } else {
      history.back();
    }
    this.log('cancelNav');
  },

  /** History mode: make the current entry describe what is on screen */
  syncHistory() {
    if (!this.useWatcher) history.replaceState(this.viewState(), '');
  },

  /** Keep a CloseWatcher alive exactly while "back" has something to do inside the app.
      With none active, the system back button leaves the app, which is what the welcome screen wants. */
  armWatcher() {
    if (!this.useWatcher) return;
    const needed = this.navStack.length > 0 || !!this.sketch || !!document.querySelector('.modal-overlay.visible');
    if (needed && !this._watcher) {
      try {
        const watcher = new CloseWatcher();
        watcher.onclose = () => {
          this._watcher = null;
          this.log('watcher: close');
          this.handleBack();
        };
        this._watcher = watcher;
      } catch (e) {
        this.log(`watcher failed: ${e.message}`);
      }
    } else if (!needed && this._watcher) {
      this._watcher.destroy();
      this._watcher = null;
    }
  },

  /** One step back: close the dialog on top, or leave the drawing screen, or else return to the previous view */
  handleBack() {
    const dismiss = document.querySelector('.modal-overlay.visible [data-dismiss]');
    if (dismiss) {
      dismiss.click();
    } else if (this.sketch) {
      this.sketchCancel();
    } else if (this._pending) {
      // Something tapped is still on its way (a link being looked up, a note loading): "back" gives up
      // on it and stays on the view that is on screen, instead of leaving it for the note to land later.
      // (A note that an earlier "back" is still loading is different: see viewState, back goes on from it.)
      this._loadSeq++;
      this.cancelNav();
      this.setSaveStatus('', '');
    } else {
      // The view being left is where a swipe from the right edge returns to. A note not yet on the Drive has no way back.
      const leaving = this.viewState();
      if (leaving.view === 'browse' || (leaving.view === 'file' && leaving.id)) this.fwdStack.push(leaving);
      // An entry for the view already on screen would make this "back" do nothing: skip it
      const same = (a, b) => a.view === b.view && (a.id || null) === (b.id || null);
      let target = this.navStack.pop();
      while (target && same(target, leaving)) target = this.navStack.pop();
      this.show(target || null);
    }
    this.armWatcher();
  },

  /** Swipe from the right edge: back into the view that "back" last left */
  async goForward() {
    if (!this.useWatcher) {
      history.forward();
      return;
    }
    const next = this.fwdStack.pop();
    if (!next) return;
    // Forward again while the last step is still loading: what is left behind is that step, not the screen
    this.navStack.push(this.viewState());
    this._pending = { pushed: true };
    this.armWatcher();
    if ((await this.show(next)) === false) {
      // Did not open (no network): the screen stayed where it was, and so do the two stacks
      this.cancelNav();
      this.fwdStack.push(next);
    }
  },

  // ── Edge swipe ──
  //
  // With the three-button bar Android has no back gesture, and the swipe Chrome offers in a tab does not
  // exist in an installed app. So the app has its own, with Chrome's meaning: a drag inwards from the left
  // edge is "back" (the same as the system button), from the right edge is "forward".

  swipeAllowed(side) {
    if (this.sketch) return false; // a stroke that starts at the edge is a stroke
    const dialog = !!document.querySelector('.modal-overlay.visible');
    if (side === 'left') return dialog || document.body.dataset.view !== 'welcome';
    return !dialog && (!this.useWatcher || this.fwdStack.length > 0);
  },

  onSwipeStart(e) {
    this._swipe = null;
    if (e.touches.length !== 1) return;
    const { clientX: x, clientY: y } = e.touches[0];
    const fromEdge = Math.min(x, window.innerWidth - x);
    const side = x < window.innerWidth / 2 ? 'left' : 'right';
    if (fromEdge > SWIPE_EDGE * 2 || !this.swipeAllowed(side)) return;
    // Dragging near the edge with text selected is moving a selection handle; and these scroll sideways themselves
    const selection = window.getSelection();
    const blocked = selection && !selection.isCollapsed ? 'selection' : e.target.closest?.('input, .toolbar, .table-wrap, pre') ? 'target' : '';
    // A start just outside the strip (or a blocked one) does nothing, but is followed so the diagnostics panel can tell
    const skip = blocked || (fromEdge > SWIPE_EDGE ? 'outside' : '');
    this._swipe = { side, x, y, pull: 0, armed: false, skip };
    if (!skip) this.log(`swipe ${side} x=${Math.round(x)}`);
  },

  onSwipeMove(e) {
    const swipe = this._swipe;
    if (!swipe) return;
    const { clientX, clientY } = e.touches[0];
    const pull = (clientX - swipe.x) * (swipe.side === 'left' ? 1 : -1);
    const drift = Math.abs(clientY - swipe.y);
    swipe.pull = Math.max(swipe.pull, pull);
    if (swipe.skip) return;
    // Clearly more down than across: that is the page scrolling. The first few px decide nothing:
    // a thumb starts its swipe in an arc, and dropping the gesture there made it hard to catch.
    if (drift > SWIPE_SCROLL && drift > pull) {
      this.log(`swipe drop: vertical pull=${Math.round(pull)} drift=${Math.round(drift)}`);
      this.endSwipe();
      return;
    }
    swipe.armed = pull >= SWIPE_TRIGGER;
    const hint = this.els.swipeHint;
    hint.textContent = swipe.side === 'left' ? '‹' : '›';
    hint.dataset.side = swipe.side;
    hint.style.top = `${swipe.y}px`;
    hint.style.setProperty('--pull', `${Math.max(0, Math.min(pull, SWIPE_TRIGGER + 20))}px`);
    hint.classList.toggle('visible', pull > 10);
    hint.classList.toggle('armed', swipe.armed);
  },

  /** Finger up (act = true) or gesture abandoned */
  endSwipe(act = false) {
    const swipe = this._swipe;
    this._swipe = null;
    this.els.swipeHint.classList.remove('visible', 'armed');
    if (!act || !swipe) return;
    const pull = Math.round(swipe.pull);
    if (swipe.skip) {
      // Only what looked like an attempt at the gesture is worth a line
      if (pull >= SWIPE_TRIGGER) this.log(`swipe miss (${swipe.skip}) ${swipe.side} x=${Math.round(swipe.x)} pull=${pull}`);
      return;
    }
    if (!swipe.armed || !this.swipeAllowed(swipe.side)) {
      if (pull > 10) this.log(`swipe end: short pull=${pull}`);
      return;
    }
    if (swipe.side === 'left') {
      this.log(`swipe: back pull=${pull}`);
      // History mode has no step for "close the dialog": goBack would leave the note behind it
      const dismiss = !this.useWatcher && document.querySelector('.modal-overlay.visible [data-dismiss]');
      if (dismiss) dismiss.click();
      else this.goBack('swipe');
    } else {
      this.log(`swipe: forward pull=${pull}`);
      this.goForward();
    }
  },

  /** Header back button */
  goBack(from = 'button') {
    this.log(`goBack (${from})`);
    if (this.useWatcher) {
      this.handleBack();
      return;
    }
    this._popped = false;
    history.back();
    // No entry of ours behind this one (should not happen): still leave the note
    setTimeout(() => {
      if (!this._popped) this.goHome();
    }, 500);
  },

  onPopState(state) {
    this._popped = true;
    this.log('popstate');
    if (!this.useWatcher) this.show(state);
  },

  /** Line for the hidden diagnostics panel (five taps on the welcome title) */
  log(message) {
    const time = new Date().toTimeString().slice(0, 8);
    this._log.push(`${time} ${message} | hist=${history.length} stack=${this.navStack.length} watcher=${this._watcher ? 1 : 0}`);
    if (this._log.length > 60) this._log.shift();
  },

  showDiagnostics() {
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches ?? '?';
    document.getElementById('debug-text').textContent = [
      `modo de voltar: ${this.useWatcher ? 'CloseWatcher' : 'History API'}`,
      `instalado (standalone): ${standalone}`,
      `view: ${document.body.dataset.view}`,
      navigator.userAgent,
      '',
      ...this._log,
    ].join('\n');
    document.getElementById('debug-overlay').classList.add('visible');
    this.armWatcher();
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
  },

  togglePreview() {
    this.setMode(this.mode === 'edit' ? 'preview' : 'edit');
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

  // ── Auto-save ──

  scheduleAutoSave() {
    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => {
      this.save();
    }, 30000);
  },

  // ── File operations ──

  /** Generate a timestamp-based filename like 2026-04-11-2143.md */
  generateFileName() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.md`;
  },

  newFile() {
    // Whatever is open gets saved before it is replaced
    this.flushCurrent();
    this._loadSeq++; // a file still loading must not land on top of the new note
    this.beginNav();

    const name = this.generateFileName();
    // The draft key is fixed for the life of the note, so the draft is still found
    // (and cleared) after the note gets its Drive ID
    const file = { id: null, name: name, draftKey: `drivenotes_draft_new_${Date.now()}` };
    this.currentFile = file;
    this.syncHistory();
    const today = this.today();
    this.setContent(`---\ncreated: ${today}\nupdated: ${today}\n---\n\n`);
    this.showEditor();
    this.updateFileNameDisplay();
    this.focusEditor();
    this.caretToEnd(); // typing starts below the properties
    const born = this.getContent();

    // Create on Drive in background, not awaited, so the user can type immediately.
    // If it fails, the first save creates the file instead.
    if (this.hasValidToken()) {
      this.setSaveStatus('saving', 'Criando no Drive...');
      this.enqueue(() => this.createOnDrive(file, born)).then(() => {
        if (this.currentFile !== file) return;
        this.setSaveStatus('saved', 'Criado no Drive');
        setTimeout(() => {
          if (this.currentFile === file) this.setSaveStatus('', '');
        }, 2000);
      }).catch((e) => {
        console.error('Failed to create on Drive:', e);
        if (this.currentFile === file) this.setSaveStatus('error', 'Erro ao criar no Drive');
      });
    }
  },

  /** Focus the editor for immediate typing */
  focusEditor() {
    this.Editor.focar();
  },

  caretToEnd() {
    this.Editor.cursorNoFim();
  },

  /** Run a Drive write after every write queued before it */
  enqueue(task) {
    const run = this._saveChain.then(task);
    this._saveChain = run.catch(() => {});
    return run;
  },

  /** Save the open file. `manual` is a tap on save: the only thing that reopens a pending conflict dialog. */
  async save({ manual = false } = {}) {
    const file = this.currentFile;
    if (!file || !this.isDirty) return;
    clearTimeout(this.autoSaveTimer);

    if (file.conflict) {
      // Never write over a Drive version the user hasn't ruled on; keep the text safe locally
      this.saveDraft();
      if (manual) this.showConflict(file);
      return;
    }

    // A tap is the only moment a login popup is allowed to open, so an expired login is renewed here.
    // Automatic saves never try: they fall back to the local draft (see saveSnapshot).
    if (manual && !this.hasValidToken()) {
      this.saveDraft();
      try {
        await this.ensureAuth();
      } catch (e) {
        console.warn('Login on save failed:', e);
      }
      if (this.currentFile !== file) return; // flushCurrent already took care of it
    }

    const content = this.getContent();
    return this.enqueue(() => this.saveSnapshot(file, content));
  },

  /** Called before the editor switches to another file: the open one is saved in the background.
      The draft is written first, synchronously, so the text survives whatever happens to the request. */
  flushCurrent() {
    clearTimeout(this.autoSaveTimer);
    const file = this.currentFile;
    if (!file || !this.isDirty) return;

    const content = this.getContent();
    this.saveDraft(file, content);
    if (file.conflict) return; // stays as a draft; the dialog comes back when it is reopened
    this.enqueue(() => this.saveSnapshot(file, content));
  },

  /** Write one snapshot of one file to Drive. The file may no longer be the open one,
      so the UI is only touched while it still is. Never throws: on failure the snapshot becomes a draft. */
  async saveSnapshot(file, content) {
    const isCurrent = () => this.currentFile === file;

    if (file.conflict) {
      // Queued behind a save of the same file that hit a conflict
      this.saveDraft(file, content);
      return;
    }

    if (content === file.lastSavedContent) {
      this.settleSaved(file, content);
      return;
    }

    if (!this.hasValidToken()) {
      // No usable login: keep it locally. It stays flagged as unsaved because it is not on Drive.
      this.saveDraft(file, content);
      if (isCurrent()) {
        if (this.accessToken) {
          this.setSaveStatus('error', 'Login expirou: toque em salvar');
        } else {
          this.setSaveStatus('saved', 'Rascunho salvo');
          setTimeout(() => {
            if (isCurrent()) this.setSaveStatus('', '');
          }, 3000);
        }
      }
      return;
    }

    if (isCurrent()) {
      this.setSaveStatus('saving', file.id ? 'Salvando...' : 'Criando no Drive...');
    }

    try {
      // What goes to the Drive carries today's `updated`; the editor's text is left alone (see Dates)
      const dated = await this.withDates(file, content);

      if (file.id) {
        // Someone else (the PC, another device) may have written the file since we opened it
        const remote = await this.driveGetFileMeta(file.id, 'modifiedTime');
        if (remote.modifiedTime !== file.modifiedTime) {
          file.conflict = true;
          file.remoteModifiedTime = remote.modifiedTime;
          this.saveDraft(file, content);
          if (isCurrent()) {
            this.setSaveStatus('error', 'Conflito com o Drive');
            this.showConflict(file);
          } else {
            this.setSaveStatus('error', `Conflito em ${file.name}: rascunho guardado`);
          }
          return;
        }

        const result = await this.driveUpdateFile(file.id, dated);
        file.modifiedTime = result.modifiedTime;
      } else {
        await this.createOnDrive(file, dated);
      }
      // Saved text is compared with the editor's, so it is recorded the way the editor has it
      file.lastSavedContent = content;
      file.driveContent = dated === content ? null : dated;
    } catch (e) {
      console.error('Drive save failed:', e);
      this.saveDraft(file, content);
      if (isCurrent()) {
        this.setSaveStatus('error', 'Erro: salvo local');
      } else {
        this.setSaveStatus('error', `Erro ao salvar ${file.name}: rascunho guardado`);
      }
      return;
    }

    this.settleSaved(file, content);
    if (isCurrent()) {
      this.setSaveStatus('saved', 'Salvo no Drive');
      setTimeout(() => {
        if (isCurrent()) this.setSaveStatus('', '');
      }, 3000);
    }
  },

  /** Bookkeeping after `content` is known to be on Drive */
  settleSaved(file, content) {
    if (this.currentFile !== file) {
      this.clearDraft(file);
      return;
    }

    // Text typed while the request was in flight is not on Drive yet
    const changed = this.getContent() !== content;
    this.isDirty = changed;
    this.updateFileNameDisplay();
    if (changed) {
      this.scheduleAutoSave();
    } else {
      this.clearDraft(file);
      this.showSavedDates();
    }
  },

  /** Create `file` on Drive and record its ID and version on the file object */
  async createOnDrive(file, content) {
    const folderId = file.parents?.[0] || CONFIG.DEFAULT_FOLDER_ID;
    const result = await this.driveCreateFile(file.name, content, folderId);
    file.id = result.id;
    file.modifiedTime = result.modifiedTime;
    file.parents = result.parents;
    file.lastSavedContent = content;

    // A draft written while the create was in flight still says "not on Drive";
    // opening it later would create the file a second time
    const draft = this.readDraft(file.draftKey);
    if (draft) {
      draft.fileId = file.id;
      draft.baseModifiedTime = file.modifiedTime;
      draft.parents = file.parents;
      localStorage.setItem(file.draftKey, JSON.stringify(draft));
    }

    this.saveToRecents(file.id, file.name);
    if (this.currentFile === file) this.syncHistory(); // the entry can now name the note by ID
  },

  // ── Dates (created / updated) ──
  // The vault keeps `created` and `updated` (YYYY-MM-DD) in the properties of its notes. A new note is born
  // with both. After that, `updated` is set in the text on its way to the Drive, not in the editor: replacing
  // the editor's text while the keyboard is up loses the caret and breaks dictation. The editor catches up
  // when it is out of sight (showSavedDates).

  today() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  },

  /** `content` the way it goes to the Drive. Never throws: when in doubt, the note is saved as it is. */
  async withDates(file, content) {
    const name = file.name.toLowerCase();
    if (!name.endsWith('.md') || name.includes('-antigo') || CONFIG.NO_DATES_FILES.includes(name)) return content;

    try {
      const dated = await this.folderKeepsDates(file.parents?.[0] || CONFIG.DEFAULT_FOLDER_ID);
      return dated ? this.stampDates(content, this.today(), !file.id) : content;
    } catch (e) {
      console.warn('Could not tell where the note lives, dates left alone:', e);
      return content;
    }
  },

  /** True for a folder inside the vault and outside NO_DATES_FOLDERS */
  async folderKeepsDates(folderId) {
    if (folderId === CONFIG.DEFAULT_FOLDER_ID) return true; // new notes are born here: never costs a request
    const trail = await this.folderTrail(folderId);
    return !!trail && !trail.some(name => CONFIG.NO_DATES_FOLDERS.includes(name));
  },

  /** The folder names from the vault root down to this folder, or null outside the vault.
      Walks up the Drive, one request per level, once per folder. */
  folderTrail(folderId) {
    if (!this._folderTrails.has(folderId)) {
      const trail = this.driveGetFileMeta(folderId, 'name,parents').then(async (folder) => {
        const parent = folder.parents?.[0];
        const above = parent ? await this.folderTrail(parent) : null; // top of the Drive: not in the vault
        return above && [...above, folder.name];
      });
      this._folderTrails.set(folderId, trail);
      trail.catch(() => this._folderTrails.delete(folderId));
    }
    return this._folderTrails.get(folderId);
  },

  /** Set `updated` to `today` in the note's properties, adding the line (or the whole block) when missing.
      `created` is only ever added to a note that is being created: an old note never gets an invented one. */
  stampDates(content, today, isNew) {
    const bom = content.startsWith('﻿') ? '﻿' : '';
    const text = content.slice(bom.length);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const updated = `updated: ${today}`;

    if (lines[0] !== '---') {
      const props = isNew ? [`created: ${today}`, updated] : [updated];
      return bom + ['---', ...props, '---', '', ...lines].join(eol);
    }

    const end = lines.indexOf('---', 1);
    if (end === -1) return content;
    const props = lines.slice(1, end);
    // A leading `---` with no YAML under it is a horizontal rule, not properties
    const isYaml = props.every((l) => l.trim() === '' || /^\s*#/.test(l) || /^\s+\S/.test(l) || /^\s*- /.test(l) || /^[^\s:#][^:]*:(\s|$)/.test(l));
    if (!isYaml) return content;

    const needsCreated = isNew && !props.some((l) => /^created:/.test(l));
    let at = props.findIndex((l) => /^updated:/.test(l));
    if (at !== -1 && props[at].trim() === updated && !needsCreated) return content;

    if (at === -1) at = props.push(updated) - 1;
    else props[at] = updated;
    if (needsCreated) props.splice(at, 0, `created: ${today}`);
    return bom + ['---', ...props, ...lines.slice(end)].join(eol);
  },

  /** Bring the editor up to the dates that went to the Drive. Only in reading view, with nothing unsaved. */
  showSavedDates() {
    const file = this.currentFile;
    if (!file || !file.driveContent || this.isDirty || this.mode !== 'preview') return;

    if (this.getContent() === file.lastSavedContent) {
      this.setContent(file.driveContent);
      file.lastSavedContent = this.getContent();
      const shown = this.els.previewContainer.querySelector('details.frontmatter pre');
      if (shown) shown.textContent = this.splitFrontmatter(this.getContent()).frontmatter;
    }
    file.driveContent = null;
  },

  // ── Drafts (localStorage) ──
  // One draft per file, under file.draftKey. A draft means "text that is not on Drive yet".

  saveDraft(file = this.currentFile, content = this.getContent()) {
    if (!file) return;
    const draft = {
      name: file.name,
      content: content,
      timestamp: Date.now(),
      fileId: file.id,
      // Drive version the text was based on, so the conflict check still works after a restart
      baseModifiedTime: file.modifiedTime,
      parents: file.parents,
    };
    try {
      localStorage.setItem(file.draftKey, JSON.stringify(draft));
    } catch (e) {
      console.error('Failed to save draft:', e);
    }
  },

  clearDraft(file = this.currentFile) {
    if (file) localStorage.removeItem(file.draftKey);
  },

  readDraft(key) {
    try {
      const draft = JSON.parse(localStorage.getItem(key));
      return draft && typeof draft.content === 'string' ? draft : null;
    } catch {
      return null;
    }
  },

  /** All non-empty drafts, newest first. Includes keys written by older versions of the app. */
  listDrafts() {
    const drafts = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key.startsWith('drivenotes_draft') || key === 'drivenotes_draft_latest') continue;
      const draft = this.readDraft(key);
      if (draft && draft.content.trim()) drafts.push({ key, ...draft });
    }
    return drafts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  },

  openDraft(key) {
    const draft = this.readDraft(key);
    if (!draft) return false;

    this.flushCurrent();
    this._loadSeq++;

    this.currentFile = {
      id: draft.fileId || null,
      name: draft.name || 'sem-titulo.md',
      draftKey: key,
      modifiedTime: draft.baseModifiedTime,
      parents: draft.parents,
    };
    this.setContent(draft.content);
    this.showEditor();
    // Draft exists precisely because it wasn't synced: flag as unsaved
    this.isDirty = true;
    this.updateFileNameDisplay();
    this.setSaveStatus('', 'Rascunho não sincronizado');
    this.syncHistory();
    return true;
  },

  renderDrafts() {
    const drafts = this.listDrafts();
    const container = document.getElementById('drafts-list');
    const ul = document.getElementById('drafts-ul');
    if (!container || !ul) return;

    container.classList.toggle('hidden', !drafts.length);
    ul.innerHTML = '';

    drafts.forEach(d => {
      const li = document.createElement('li');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'recent-name';
      nameSpan.textContent = d.name || 'sem-titulo.md';
      nameSpan.addEventListener('click', () => {
        this.beginNav();
        this.openDraft(d.key);
      });
      li.appendChild(nameSpan);

      const ago = this.timeAgo(d.timestamp);
      if (ago) {
        const timeSpan = document.createElement('span');
        timeSpan.className = 'recent-time';
        timeSpan.textContent = ago;
        li.appendChild(timeSpan);
      }

      const removeBtn = document.createElement('button');
      removeBtn.className = 'recent-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Descartar rascunho';
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const discard = await this.confirmDialog(
          'Descartar rascunho',
          `"${d.name}": o texto que não está no Drive será perdido.`,
          'Descartar'
        );
        if (!discard) return;
        localStorage.removeItem(d.key);
        this.renderDrafts();
      });
      li.appendChild(removeBtn);

      ul.appendChild(li);
    });
  },

  // ── Confirm dialog ──

  /** The app's own confirm(). Resolves to true on OK, false on cancel or "back". */
  confirmDialog(title, text, okLabel) {
    const overlay = document.getElementById('confirm-overlay');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-text').textContent = text;
    const ok = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    ok.textContent = okLabel;

    return new Promise((resolve) => {
      const close = (answer) => {
        overlay.classList.remove('visible');
        ok.onclick = cancel.onclick = null;
        this.armWatcher();
        resolve(answer);
      };
      ok.onclick = () => close(true);
      cancel.onclick = () => close(false);
      overlay.classList.add('visible');
      this.armWatcher();
    });
  },

  // ── Conflict with Drive ──

  showConflict(file) {
    this._conflictFile = file;
    this.els.conflictText.textContent =
      `"${file.name}" mudou no Drive depois que você abriu. Sua versão está guardada neste aparelho.`;
    this.els.conflict.classList.add('visible');
    this.armWatcher();
  },

  conflictCopyName(name) {
    const stamp = this.generateFileName().replace(/\.md$/, '');
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    return `${base} (conflito ${stamp})${ext}`;
  },

  async resolveConflict(action) {
    const file = this._conflictFile;
    this._conflictFile = null;
    this.els.conflict.classList.remove('visible');
    this.armWatcher();
    if (!file || this.currentFile !== file) return;

    if (action === 'later') {
      this.setSaveStatus('error', 'Conflito pendente: toque em salvar');
      return;
    }

    if (action === 'overwrite') {
      // Accept the Drive version as seen; if it changes yet again, the check fires again
      file.modifiedTime = file.remoteModifiedTime;
      file.conflict = false;
      this.isDirty = true;
      await this.save();
      return;
    }

    if (action === 'reload') {
      this.clearDraft(file);
      file.conflict = false;
      this.isDirty = false;
      await this.openFile(file.id, file.name);
      return;
    }

    if (action === 'copy') {
      const content = this.getContent();
      const copy = {
        id: null,
        name: this.conflictCopyName(file.name),
        draftKey: `drivenotes_draft_new_${Date.now()}`,
        parents: file.parents,
      };
      this.setSaveStatus('saving', 'Salvando cópia...');
      try {
        await this.enqueue(() => this.createOnDrive(copy, content));
      } catch (e) {
        // Conflict stays pending and the draft stays in place
        console.error('Failed to save conflict copy:', e);
        this.setSaveStatus('error', 'Erro ao salvar cópia');
        return;
      }
      if (this.currentFile !== file) return;

      this.clearDraft(file);
      file.conflict = false;
      this.currentFile = copy;
      this.syncHistory();
      this.settleSaved(copy, content);
      this.setSaveStatus('saved', 'Cópia salva no Drive');
    }
  },

  // ── Rename ──

  promptRename() {
    const file = this.currentFile;
    if (!file) return;
    this.showModal('Renomear nota', 'Nome do arquivo', (value) => this.renameFile(file, value), {
      value: file.name,
      confirmLabel: 'Renomear',
    });
  },

  /** A name Drive, Windows and Obsidian all accept. The extension never changes: a rename is not a conversion. */
  cleanFileName(value, oldName) {
    const name = value.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
    if (!name) return '';
    const dot = oldName.lastIndexOf('.');
    const ext = dot > 0 ? oldName.slice(dot) : '.md';
    return name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext;
  },

  async renameFile(file, value) {
    const name = this.cleanFileName(value, file.name);
    if (!name || name === file.name) return;

    // A note that is already on Drive is only renamed there, never just locally
    if (file.id) {
      try {
        await this.ensureAuth();
      } catch {
        this.setSaveStatus('error', 'Faça login pra renomear');
        return;
      }
    }

    const oldName = file.name;
    const applyName = (n) => {
      file.name = n;
      const draft = this.readDraft(file.draftKey);
      if (draft) {
        draft.name = n;
        localStorage.setItem(file.draftKey, JSON.stringify(draft));
      }
      if (this.currentFile === file) {
        this.updateFileNameDisplay();
        this.syncHistory();
      }
    };

    // Applied right away, so a note whose creation is still queued is created with the new name
    applyName(name);

    try {
      await this.enqueue(async () => {
        if (!file.id) return; // not on Drive yet and nothing queued: the first save creates it with this name
        const before = await this.driveGetFileMeta(file.id, 'modifiedTime');
        const result = await this.driveRenameFile(file.id, name);
        // Our own rename moves modifiedTime. Adopt the new value only if nobody else wrote in between,
        // otherwise the next save must still see the conflict.
        if (before.modifiedTime === file.modifiedTime) file.modifiedTime = result.modifiedTime;
        this.saveToRecents(file.id, name);
      });
    } catch (e) {
      console.error('Rename failed:', e);
      applyName(oldName);
      if (this.currentFile === file) this.setSaveStatus('error', 'Erro ao renomear');
      return;
    }

    if (this.currentFile === file) {
      this.setSaveStatus('saved', 'Renomeado');
      setTimeout(() => {
        if (this.currentFile === file) this.setSaveStatus('', '');
      }, 2000);
    }
  },

  // ── Modal ──

  showModal(title, placeholder, onConfirm, { value = '', confirmLabel = 'Criar' } = {}) {
    this.els.modal.querySelector('h3').textContent = title;
    this.els.modalInput.placeholder = placeholder;
    this.els.modalInput.value = value;
    this.els.modalConfirm.textContent = confirmLabel;
    this.els.modal.classList.add('visible');
    this.els.modalInput.focus();
    // Ready to type over the name, keeping the extension
    const dot = value.lastIndexOf('.');
    if (dot > 0) this.els.modalInput.setSelectionRange(0, dot);
    this.armWatcher();

    this._modalConfirm = () => {
      const value = this.els.modalInput.value;
      this.hideModal();
      onConfirm(value);
    };
  },

  hideModal() {
    this.els.modal.classList.remove('visible');
    this._modalConfirm = null;
    this.armWatcher();
  },

  // ── Toolbar formatting ──

  // `wrap` formats go around the selection; `line` formats toggle a marker at the start of every
  // selected line, wherever the cursor is in it. `command` is the TinyMDE command doing the same job.
  FORMATS: {
    bold: { wrap: ['**', '**'], command: 'bold' },
    // Asterisco e não sublinhado: é o que o app escrevia antes da troca de editor (o TinyMDE ia
    // pelo `command` e ignorava o `wrap`), e é o que está escrito nas notas que já existem
    italic: { wrap: ['*', '*'], command: 'italic' },
    code: { wrap: ['`', '`'], command: 'code' },
    link: { wrap: ['[', '](url)'] },
    heading: { line: '## ', command: 'h2' },
    list: { line: '- ', command: 'ul' },
    quote: { line: '> ', command: 'blockquote' },
    checklist: { line: '- [ ] ' },
  },

  applyFormat(name) {
    if (!this.FORMATS[name]) return;
    this.Editor.formatar(name);
    // Os comandos do editor mudam o texto sem disparar o evento de mudança dele
    this.markDirty();
  },

  /** Put `prefix` at the start of the line, replacing any other block marker; take it off if it is already there */
  toggleLinePrefix(line, prefix) {
    const kindOf = (marker) => {
      if (marker.startsWith('#')) return 'heading';
      if (marker.startsWith('>')) return 'quote';
      if (marker.includes('[')) return 'checklist';
      if (/^[-*+]/.test(marker)) return 'list';
      return marker ? 'ordered' : '';
    };
    const [, indent, marker = '', rest] =
      /^(\s*)((?:#{1,6}|[0-9]{1,9}[).]|>|[-*+](?: \[[ xX]\])?)\s+)?(.*)$/.exec(line);
    return kindOf(marker) === kindOf(prefix) ? indent + rest : indent + prefix + rest;
  },

  // ── Photo into the note ──

  /** Tap on a photo button: `source` is 'camera' or 'gallery'. The picker takes the focus away,
      so the cursor position is kept for later. */
  pickPhoto(source) {
    if (this.mode !== 'edit') return;
    this._photoAt = this.Editor.marcarCursor();
    const camera = source === 'camera';
    // With "capture" Android goes straight to the camera; without it, to the photo picker
    if (camera) this.els.photoInput.setAttribute('capture', 'environment');
    else this.els.photoInput.removeAttribute('capture');
    // The camera takes one shot at a time; from the gallery several photos can come at once
    this.els.photoInput.toggleAttribute('multiple', !camera);
    this.els.photoInput.value = '';
    this.els.photoInput.click();
  },

  /** Everything that was picked, one upload at a time and in the order it was picked: in parallel the
      embeds would land out of order, and the phone's upload is slow enough to jam. A failure stops the
      queue and keeps whatever already went into the note. */
  async insertPhotos(picked) {
    // Names are only unique to the second, and a batch goes up inside one: this keeps them apart
    const taken = new Set();
    for (let i = 0; i < picked.length; i++) {
      const status = picked.length > 1 ? `Enviando foto ${i + 1} de ${picked.length}...` : 'Enviando foto...';
      if (!await this.insertPhoto(picked[i], taken, status)) return;
    }
  },

  /** Shrink, upload to the vault's attachment folder, and only then write ![[name]] into the note:
      a failed upload leaves no broken embed behind. Answers whether the queue can carry on. */
  async insertPhoto(picked, taken, status = 'Enviando foto...') {
    const file = this.currentFile;
    this.setSaveStatus('saving', status);

    let name;
    try {
      await this.ensureAuth();
      const folderId = await this.getMediaFolderId();
      if (!folderId) {
        this.setSaveStatus('error', `Pasta ${CONFIG.MEDIA_FOLDER} não encontrada no vault`);
        return false;
      }
      const photo = await this.shrinkPhoto(picked);
      name = this.mediaName(photo, picked.name, 'foto', taken);
      await this.driveUploadBlob(name, photo, folderId);
      // The reading view shows it straight from here, without asking Drive for it back
      this._embedUrls.set(name, Promise.resolve(URL.createObjectURL(photo)));
    } catch (e) {
      console.error('Photo upload failed:', e);
      // In case it was the remembered folder that went away: look it up again next time
      localStorage.removeItem('drivenotes_media_folder');
      this.setSaveStatus('error', 'Erro ao enviar a foto');
      return false;
    }

    if (this.currentFile !== file) {
      this.setSaveStatus('error', `Foto salva, mas a nota mudou: ${name}`);
      return false;
    }
    // Back from the picker the editor may have no cursor, and every photo of a batch would fall back
    // on the same spot, the last one on top: the next one goes below the one just inserted
    this._photoAt = this.insertOnOwnLine(`![[${name}]]`, this._photoAt) || this._photoAt;
    this.markDirty();
    this.setSaveStatus('saved', 'Foto inserida');
    return true;
  },

  PHOTO_MAX_SIDE: 2000,

  /** Phone photos are 4 to 8 MB and everything in the vault syncs to the computer: anything larger than
      PHOTO_MAX_SIDE is scaled down. What the browser cannot decode or redraw goes up as it is. */
  async shrinkPhoto(file) {
    // Not GIF (would lose the animation) nor SVG (no pixels to scale)
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap !== 'function') return file;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = this.PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height);
      if (scale >= 1) return file;

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      // PNG stays PNG (screenshots, transparency); the rest becomes JPEG
      const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const blob = await new Promise(resolve => canvas.toBlob(resolve, type, 0.85));
      return blob && blob.size < file.size ? blob : file;
    } catch (e) {
      console.warn('Photo not resized:', e);
      return file;
    }
  },

  /** foto-2026-09-19-153012.jpg, desenho-2026-09-19-153012.png: the vault's kebab-case, unique to the second.
      Several photos picked at once go up inside the same second, so `taken` collects the names already given
      and the repeats become -2, -3. Alone, the name keeps its plain shape. */
  mediaName(blob, originalName, prefix, taken) {
    const two = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
    const fromType = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[blob.type];
    const ext = fromType || (/\.([a-z0-9]+)$/i.exec(originalName || '')?.[1] || 'jpg').toLowerCase();
    let name = `${prefix}-${stamp}.${ext}`;
    if (!taken) return name;
    for (let n = 2; taken.has(name); n++) name = `${prefix}-${stamp}-${n}.${ext}`;
    taken.add(name);
    return name;
  },

  /** Insert `text` as a line of its own: at the cursor, or where it was (`at`) when the editor lost the focus,
      or at the end. The cursor ends on a fresh line below; with the editor, answers where that is. */
  insertOnOwnLine(text, at) {
    return this.Editor.inserirEmLinhaPropria(text, at);
  },

  // ── Sketch (the drawing screen) ──

  // The palette lives here, not in the CSS, because the strokes are painted from it. The CSS only
  // needs the purple, for the selected ring and the active button. See desenho-na-nota-design.
  SKETCH_COLORS: ['#9b94a6', '#8b6cef', '#e0645c', '#c47f2e', '#369680', '#4b8fe3'],
  SKETCH_WIDTHS: [3, 6, 12],
  SKETCH_MARGIN: 16,

  /** The box the exported PNG is cropped to: everything the ink touches, plus each stroke's half
      width (its round cap sticks out that far) and a margin. Eraser strokes lay down no ink, so
      they never grow the box. Null when nothing was drawn. Coordinates are screen points and may
      go negative, for a stroke against the edge. */
  sketchBounds(strokes) {
    let box = null;
    for (const stroke of strokes) {
      if (stroke.erase) continue;
      const pad = stroke.width / 2;
      for (const p of stroke.points) {
        if (!box) box = { left: p.x - pad, top: p.y - pad, right: p.x + pad, bottom: p.y + pad };
        else {
          box.left = Math.min(box.left, p.x - pad);
          box.top = Math.min(box.top, p.y - pad);
          box.right = Math.max(box.right, p.x + pad);
          box.bottom = Math.max(box.bottom, p.y + pad);
        }
      }
    }
    if (!box) return null;
    const m = this.SKETCH_MARGIN;
    return { x: box.left - m, y: box.top - m, width: (box.right - box.left) + m * 2, height: (box.bottom - box.top) + m * 2 };
  },

  /** Open the drawing screen over the editor. Only from the edit view, with a note open. */
  sketchOpen() {
    if (this.mode !== 'edit' || !this.currentFile || this.sketch) return;
    // A marca vem a null depois que o foco some, então o cursor é lido antes do blur
    const at = this.Editor.marcarCursor();
    // Without the blur the keyboard sits over half the canvas
    document.activeElement?.blur?.();

    this.sketch = {
      canvas: this.els.sketchCanvas, ctx: null, dpr: 1,
      strokes: [], stroke: null,
      color: this.SKETCH_COLORS[0], width: 6, erase: false, at,
    };
    this.els.sketchScreen.classList.add('visible');
    this.sketchResize();
    this.sketchRenderTools();
    this.armWatcher();
    this.log('sketch: open');
  },

  /** Leave the screen. Nothing here touches the note: that is sketchFinish's job. */
  sketchClose() {
    this.els.sketchScreen.classList.remove('visible');
    this.sketch = null;
    this.armWatcher();
    this.log('sketch: close');
  },

  /** This screen covers the app header, which is where setSaveStatus writes, so it has to carry its
      own "sending" state: without it a tap on ✓ looks like nothing happened, and the next tap starts
      a second upload. Everything on the screen stops taking taps, including the canvas, so a
      frustrated tap does not turn into a stroke. */
  sketchBusy(on) {
    this.els.sketchScreen.classList.toggle('sketch-sending', on);
    this.els.sketchDone.disabled = on;
    this.els.sketchCancel.disabled = on;
    document.querySelector('.sketch-title').textContent = on ? 'Enviando...' : 'Desenho';
  },

  /** ✕ and the system back button. A drawing with ink in it is never thrown away without asking;
      an untouched screen just closes. */
  async sketchCancel() {
    // The back button reaches this without going through the (disabled) ✕
    if (!this.sketch || this.sketch.busy) return;
    if (this.sketchBounds(this.sketch.strokes)) {
      const discard = await this.confirmDialog('Descartar o desenho?', 'O desenho não vai pra nota.', 'Descartar');
      // Back may have been pressed again while the dialog was up
      if (!discard || !this.sketch) return;
    }
    this.sketchClose();
  },

  /** Size the backing store in device pixels and repaint. Without the dpr the stroke comes out
      jagged on a phone and the 3px one nearly disappears. Setting canvas.width wipes the context
      state, so the scale and the round caps are set again every time. Also the rotation handler:
      the strokes are repainted at the new size, with their coordinates untouched. */
  sketchResize() {
    const s = this.sketch;
    if (!s) return;
    s.dpr = window.devicePixelRatio || 1;
    const width = s.canvas.clientWidth || window.innerWidth;
    const height = s.canvas.clientHeight || window.innerHeight;
    s.canvas.width = Math.round(width * s.dpr);
    s.canvas.height = Math.round(height * s.dpr);
    s.ctx = s.canvas.getContext('2d');
    if (s.ctx) {
      s.ctx.scale(s.dpr, s.dpr);
      s.ctx.lineCap = 'round';
      s.ctx.lineJoin = 'round';
    }
    this.sketchRepaint();
  },

  /** The colour row is built from SKETCH_COLORS, so the palette is written down in one place only */
  sketchRenderTools() {
    const s = this.sketch;
    if (!s) return;
    const row = this.els.sketchColors;
    if (!row.children.length) {
      for (const color of this.SKETCH_COLORS) {
        const btn = document.createElement('button');
        btn.className = 'sketch-swatch';
        btn.style.background = color;
        btn.dataset.sketchColor = color;
        btn.setAttribute('aria-label', `Cor ${color}`);
        row.appendChild(btn);
      }
    }
    for (const btn of row.children) btn.classList.toggle('sketch-active', !s.erase && btn.dataset.sketchColor === s.color);
    for (const btn of document.querySelectorAll('[data-sketch-width]')) btn.classList.toggle('sketch-active', Number(btn.dataset.sketchWidth) === s.width);
    this.els.sketchErase.classList.toggle('sketch-active', s.erase);
  },

  /** Where a pointer event lands on the canvas, in screen points (the context is already dpr-scaled) */
  sketchPoint(e) {
    const rect = this.sketch.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  },

  sketchDown(e) {
    const s = this.sketch;
    if (!s) return;
    e.preventDefault();
    // Keep the stroke fed even if the finger wanders off the canvas
    s.canvas.setPointerCapture?.(e.pointerId);
    s.stroke = { color: s.color, width: s.width, erase: s.erase, points: [this.sketchPoint(e)] };
    s.strokes.push(s.stroke);
    this.sketchPaintStroke(s.stroke);
  },

  sketchMove(e) {
    const s = this.sketch;
    if (!s || !s.stroke) return;
    e.preventDefault();
    const from = s.stroke.points.length;
    // Android delivers the finger's points in batches and only the last of each frame reaches
    // pointermove: without the swallowed ones a quick stroke comes out as a chain of straight lines.
    // The list is empty in browsers that do not have it (and in jsdom), so the event itself is the fallback.
    const batch = e.getCoalescedEvents?.() ?? [];
    for (const point of (batch.length ? batch : [e])) s.stroke.points.push(this.sketchPoint(point));
    this.sketchPaintStroke(s.stroke, from);
  },

  sketchUp(e) {
    const s = this.sketch;
    if (!s || !s.stroke) return;
    s.canvas.releasePointerCapture?.(e.pointerId);
    s.stroke = null;
  },

  /** Undo drops the last stroke and repaints the list. Painting from the list, and never from the
      pixels already on screen, is what keeps undo right when an eraser stroke came before it. */
  sketchUndo() {
    const s = this.sketch;
    if (!s || !s.strokes.length) return;
    s.strokes.pop();
    s.stroke = null;
    this.sketchRepaint();
  },

  /** Paint one stroke from point `from` onwards. from = 0 paints it whole (a repaint); while a
      stroke is being drawn only its new segment is painted, so a long drawing does not repaint
      the whole list on every move. */
  sketchPaintStroke(stroke, from = 0) {
    const ctx = this.sketch?.ctx;
    if (!ctx || !stroke.points.length) return;
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.beginPath();
    const start = stroke.points[Math.max(0, from - 1)];
    ctx.moveTo(start.x, start.y);
    const rest = stroke.points.slice(Math.max(1, from));
    // A single tap still has to leave a dot
    if (!rest.length) ctx.lineTo(start.x, start.y);
    for (const p of rest) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  },

  sketchRepaint() {
    const s = this.sketch;
    if (!s?.ctx) return;
    s.ctx.clearRect(0, 0, s.canvas.width / s.dpr, s.canvas.height / s.dpr);
    for (const stroke of s.strokes) this.sketchPaintStroke(stroke);
  },

  /** The PNG that goes to the vault: only the part with ink on it, at the screen's pixel density.
      Null when nothing was drawn. */
  sketchExport() {
    const s = this.sketch;
    const box = s && this.sketchBounds(s.strokes);
    if (!box) return null;
    const out = document.createElement('canvas');
    out.width = Math.round(box.width * s.dpr);
    out.height = Math.round(box.height * s.dpr);
    // The source canvas holds its backing store in device pixels, so the shift is in device pixels
    // too. Drawing the whole source at an offset (rather than cropping with the nine-argument
    // drawImage) is what lets the box hang off the edge into the negative.
    out.getContext('2d')?.drawImage(s.canvas, Math.round(-box.x * s.dpr), Math.round(-box.y * s.dpr));
    return out;
  },

  /** ✓: crop, upload to the vault's attachment folder, and only then write ![[name]] into the note,
      the same order as a photo. What differs: a failed upload leaves the screen open with the
      drawing still on it, because a drawing cannot be picked again. */
  async sketchFinish() {
    const s = this.sketch;
    // Upload takes seconds on a phone. Without this guard every extra tap in that window starts
    // another upload, and the note ends up with the same drawing embedded several times over.
    if (!s || s.busy) return;
    const out = this.sketchExport();
    if (!out) { this.sketchClose(); return; }

    const file = this.currentFile;
    const at = s.at;
    s.busy = true;
    this.sketchBusy(true);
    this.setSaveStatus('saving', 'Enviando desenho...');

    let name;
    try {
      await this.ensureAuth();
      const folderId = await this.getMediaFolderId();
      if (!folderId) {
        this.setSaveStatus('error', `Pasta ${CONFIG.MEDIA_FOLDER} não encontrada no vault`);
        return;
      }
      const blob = await new Promise(resolve => out.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('canvas produced no blob');
      name = this.mediaName(blob, null, 'desenho');
      await this.driveUploadBlob(name, blob, folderId);
      // The reading view shows it straight from here, without asking Drive for it back
      this._embedUrls.set(name, Promise.resolve(URL.createObjectURL(blob)));
    } catch (e) {
      console.error('Sketch upload failed:', e);
      // In case it was the remembered folder that went away: look it up again next time
      localStorage.removeItem('drivenotes_media_folder');
      this.setSaveStatus('error', 'Erro ao enviar o desenho');
      return;
    } finally {
      // Every failure leaves the screen open, so it has to be usable again: locked for good would
      // mean not even being able to leave
      s.busy = false;
      this.sketchBusy(false);
    }

    this.sketchClose();
    if (this.currentFile !== file) {
      this.setSaveStatus('error', `Desenho salvo, mas a nota mudou: ${name}`);
      return;
    }
    this.insertOnOwnLine(`![[${name}]]`, at);
    this.markDirty();
    this.setSaveStatus('saved', 'Desenho inserido');
  },

  // ── Events ──

  scrollCaretIntoView() {
    if (this.mode !== 'edit') return;
    this.Editor.rolarAteOCursor();
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
    // Save is tapped in the middle of writing: like the toolbar buttons below, it must not take the
    // focus (and the keyboard, and the caret) away from the editor
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

    // Tap the title to rename the open note
    this.els.fileName.addEventListener('click', () => this.promptRename());

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
    this.els.modalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this._modalConfirm) this._modalConfirm();
      if (e.key === 'Escape') this.hideModal();
    });

    // Toolbar buttons: prevent focus steal so the virtual keyboard stays open.
    // Cancelling touchstart also cancels the click that would follow, so on touch the
    // action runs on touchend; click is what a mouse or a keyboard produces.
    document.querySelectorAll('.toolbar-btn[data-format]').forEach(btn => {
      btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
      btn.addEventListener('touchend', (e) => {
        e.preventDefault();
        this.applyFormat(btn.dataset.format);
      }, { passive: false });
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => this.applyFormat(btn.dataset.format));
    });

    // Photo buttons: same touch handling as the formatting buttons. The file picker only opens from
    // inside a tap, and touchend counts as one.
    document.querySelectorAll('.toolbar-btn[data-photo]').forEach(btn => {
      btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
      btn.addEventListener('touchend', (e) => {
        e.preventDefault();
        this.pickPhoto(btn.dataset.photo);
      }, { passive: false });
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => this.pickPhoto(btn.dataset.photo));
    });
    this.els.photoInput.addEventListener('change', () => {
      const picked = [...this.els.photoInput.files];
      if (picked.length) this.insertPhotos(picked);
    });

    // Drawing: the pencil sits with the photo buttons and gets the same touch handling, because it
    // is tapped with the keyboard open (see the toolbar note above)
    const pencil = document.querySelector('.toolbar-btn[data-sketch]');
    pencil?.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    pencil?.addEventListener('touchend', (e) => { e.preventDefault(); this.sketchOpen(); }, { passive: false });
    pencil?.addEventListener('mousedown', (e) => e.preventDefault());
    pencil?.addEventListener('click', () => this.sketchOpen());

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
    document.getElementById('debug-copy')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(document.getElementById('debug-text').textContent).catch(() => {});
    });

    // Flush on hide/close — mobile users switch apps constantly.
    // saveDraft is sync (localStorage) so it always runs; save() is async best-effort.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.isDirty) {
        this.saveDraft();
        this.save();
      }
    });
    window.addEventListener('pagehide', () => {
      if (this.isDirty) this.saveDraft();
    });
  },
};

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
    extensions: [wikilinkExtension],
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

// ── Google Identity callback (called from script onload in index.html) ──
function onGisLoaded() {
  App.onGisLoaded();
}

// ── Start ──
document.addEventListener('DOMContentLoaded', () => App.init());
