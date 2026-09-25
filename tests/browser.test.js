// What jsdom cannot show, checked in a real headless browser over the DevTools protocol:
// voice typing (IME composition) in the CodeMirror editor, its formatting toolbar, and the real CloseWatcher.
//   npm run test:browser        (needs Edge or Chrome; set BROWSER_PATH to choose)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT, LIBS, sleep, appSource, buildPage, launch, reporter } = require('./helpers');

const { check, done } = reporter();

// The last version with the dictation bug: proves the composition check can actually fail
const COMMIT_WITH_DICTATION_BUG = '2d8b20b';

const FAKE_DRIVE = `
  localStorage.clear();
  // The device's kept notes too: the profile outlives the run, and a fake Drive that always answers the
  // same modifiedTime would never refresh a note kept in an earlier run
  indexedDB.deleteDatabase('drivenotes');
  localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
  __App.accessToken = 'fake';
  const FOLDER = 'application/vnd.google-apps.folder';
  const files = {
    F1: { id: 'F1', name: 'projetos', mimeType: FOLDER, parents: ['ROOT'] },
    N1: { id: 'N1', name: 'com link.md', mimeType: 'text/markdown', parents: ['ROOT'], content: 'vai [[destino]]' },
    N2: { id: 'N2', name: 'destino.md', mimeType: 'text/markdown', parents: ['F1'], content: '# Destino' },
  };
  window.fetch = async (url) => {
    const u = new URL(url); const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => o, arrayBuffer: async () => new TextEncoder().encode(o).buffer });
    const m = u.pathname.match(/files\\/([^/]+)$/);
    if (m) { const f = files[m[1]]; return u.searchParams.get('alt') === 'media' ? ok(f.content) : ok({ ...f, modifiedTime: 't1' }); }
    const q = u.searchParams.get('q') || ''; const parent = /^'([^']+)' in parents/.exec(q);
    // The note index lists the whole Drive by type: folders first, then the note files (one type
    // alone, or several between parentheses, as the Drive stores a .md made by the API as text/plain)
    const byType = /^\\(?(mimeType = '[^']+'(?: or mimeType = '[^']+')*)\\)? and trashed = false$/.exec(q);
    const types = byType ? [...byType[1].matchAll(/mimeType = '([^']+)'/g)].map(m => m[1]) : [];
    const list = Object.values(files).filter(f => parent ? f.parents.includes(parent[1])
      : byType ? types.includes(f.mimeType || 'text/markdown')
      : q.includes("'" + f.name + "'"));
    return ok({ files: list.map(f => ({ ...f, modifiedTime: '2026-09-19T10:00:00Z' })) });
  };
  CONFIG.VAULT_FOLDER_ID = 'ROOT';
  'ok'`;

(async () => {
  const browser = await launch(9334);
  const { send, js, open, esperar } = browser;
  try {
    const currentApp = appSource();
    // The index.html of an old commit, for a control that runs that commit's app: buildPage needs it
    // to find the app.js tag of the time (the working tree's index.html loads app/*.js instead)
    const indexAt = (commit) => execSync(`git -C "${ROOT}" show ${commit}:index.html`, { encoding: 'utf8', maxBuffer: 1e7, stdio: ['ignore', 'pipe', 'ignore'] });

    // O elemento editavel do CodeMirror, o que o TinyMDE chamava de `editor.e`
    const CONTEUDO = `document.querySelector('.cm-content')`;

    // Posicao no CM6 e um numero so, mas a suite continua falando {row, col} como sempre falou:
    // a conta mora aqui, e nao repetida em oito lugares. Cuidado: a linha do CM6 conta a partir
    // de 1, a do TinyMDE contava a partir de 0, e e dai que vem o `+ 1`.
    //
    // E um pedaco de codigo, e nao uma chamada pronta, pra quem chama poder emendar o que vem
    // depois no mesmo `js()`. Assim mover o cursor e formatar continuam sendo uma viagem so ao
    // navegador, como eram quando o `setSelection` do TinyMDE cabia na mesma linha.
    const SELECIONAR = (foco, ancora) => `(() => {
      const view = __App.Editor._impl.view;
      const pos = ({ row, col }) => view.state.doc.line(row + 1).from + col;
      view.dispatch({ selection: { anchor: pos(${JSON.stringify(ancora || foco)}), head: pos(${JSON.stringify(foco)}) } });
    })();`;
    const selecionar = (foco, ancora) => js(`${SELECIONAR(foco, ancora)} 'ok'`);

    const editNote = (content, row, col) => js(`__App.currentFile = { id: null, name: 't.md', draftKey: 'drivenotes_draft_t' };
      __App.setContent(${JSON.stringify(content)}); __App.showEditor(); __App.isDirty = false; __App.Editor.focus();
      ${SELECIONAR({ row, col })} 'ok'`);

    // O mesmo helper falando TinyMDE. So o controle historico do cenario 1 usa isto: ele roda o
    // app de um commit anterior a troca de editor, e naquele app a instancia do TinyMDE e a API.
    const editNoteTinyMDE = (content, row, col) => js(`__App.currentFile = { id: null, name: 't.md', draftKey: 'drivenotes_draft_t' };
      __App.setContent(${JSON.stringify(content)}); __App.showEditor(); __App.isDirty = false; __App.editor.e.focus();
      __App.editor.setSelection({ row: ${row}, col: ${col} }); 'ok'`);

    // ── 1. Voice typing: growing partial results inside one composition, then the final commit ──
    console.log('1. Ditado (composicao de IME) no CodeMirror');
    // `legado` roda a metade do controle historico, no app de antes da troca de editor
    const dictate = async (url, legado) => {
      await open(url);
      await (legado ? editNoteTinyMDE : editNote)('linha um\n', 1, 0);
      for (const partial of ['Não', 'Não consigo', 'Não consigo ditar', 'Não consigo ditar minhas']) {
        await send('Input.imeSetComposition', { text: partial, selectionStart: partial.length, selectionEnd: partial.length });
        await sleep(60);
      }
      await send('Input.insertText', { text: 'Não consigo ditar minhas notas' });
      await sleep(150);
      const naTela = legado ? '__App.editor.e' : CONTEUDO;
      return JSON.parse(await js(`JSON.stringify({ content: __App.getContent(), dom: ${naTela}.innerText, dirty: __App.isDirty })`));
    };
    const expected = 'linha um\nNão consigo ditar minhas notas';

    let buggyApp = null;
    let buggyHtml = null;
    try {
      buggyApp = execSync(`git -C "${ROOT}" show ${COMMIT_WITH_DICTATION_BUG}:app.js`, { encoding: 'utf8', maxBuffer: 1e7, stdio: ['ignore', 'pipe', 'ignore'] });
      buggyHtml = indexAt(COMMIT_WITH_DICTATION_BUG);
    } catch { /* shallow clone or no git: the control is skipped */ }
    // O app antigo e TinyMDE puro: sem a biblioteca ele cai no textarea de reserva e o helper
    // legado estoura, derrubando o cenario e a suite junto. Pulado e melhor que vermelho falso.
    const temTinyMDE = fs.existsSync(LIBS.tinymde);
    if (buggyApp && temTinyMDE) {
      const before = await dictate(buildPage('dictation-before', buggyApp, { tinymde: true, html: buggyHtml }), true);
      console.log('     versao com o bug:', JSON.stringify(before.content));
      check('controle: o bug se reproduz na versao antiga (texto duplicado)', before.content !== expected);
    } else {
      console.log(`     (controle pulado: ${buggyApp ? 'tiny-markdown-editor nao instalado' : 'commit antigo indisponivel'})`);
    }
    const after = await dictate(buildPage('current', currentApp));
    console.log('     versao atual:    ', JSON.stringify(after.content));
    check('a frase ditada entra uma vez so', after.content === expected, after);
    check('o que esta na tela bate com o conteudo que sera salvo', after.dom.replace(/\n+$/, '') === after.content, after.dom);
    check('marcado como nao salvo', after.dirty === true);

    await editNote('x', 0, 0);
    await send('Input.imeSetComposition', { text: '# Titu', selectionStart: 6, selectionEnd: 6 });
    await send('Input.insertText', { text: '# Titulo ' });
    await sleep(150);
    // O CM6 nao deixa classe estavel no realce: o nome sai do gerador de CSS dele (ͼo, ͼy) e muda
    // a cada build. O que prova o realce e o tamanho que de fato chegou na tela, o 1.5em do
    // heading1 sobre os 15px do editor, num <span> que o parser de markdown criou dentro da linha.
    const realceDeTitulo = `[...${CONTEUDO}.querySelectorAll('span')]
      .some(s => s.textContent.includes('Titulo') && parseFloat(getComputedStyle(s).fontSize) > 20)`;
    check('a formatacao do editor volta a rodar no fim da composicao', await js(realceDeTitulo), await js(`${CONTEUDO}.innerHTML`));

    // ── 2. Formatting toolbar on the real CodeMirror ──
    console.log('2. Barra de formatacao no CodeMirror');
    await open(buildPage('current', currentApp));
    await editNote('primeira linha\nsegunda linha\nterceira', 1, 5);
    const format = async (name, focus, anchor) => {
      await js(`${SELECIONAR(focus, anchor)} __App.applyFormat('${name}'); 'ok'`);
      return js('__App.getContent()');
    };
    const end = (row) => js(`__App.Editor._impl.view.state.doc.line(${row} + 1).text.length`);
    check('codemirror carregado', await js('__App.Editor.kind()') === 'cm6', await js('__App.Editor.kind()'));
    check('titulo: cursor no meio, marcador no comeco da linha', await format('heading', { row: 1, col: 5 }) === 'primeira linha\n## segunda linha\nterceira');
    check('... e marca a nota como nao salva', await js('__App.isDirty') === true);
    check('titulo de novo remove', await format('heading', { row: 1, col: 4 }) === 'primeira linha\nsegunda linha\nterceira');
    check('checklist em 3 linhas selecionadas', await format('checklist', { row: 2, col: 2 }, { row: 0, col: 1 }) === '- [ ] primeira linha\n- [ ] segunda linha\n- [ ] terceira');
    check('checklist de novo remove', await format('checklist', { row: 2, col: 2 }, { row: 0, col: 1 }) === 'primeira linha\nsegunda linha\nterceira');
    check('lista', await format('list', { row: 2, col: 3 }) === 'primeira linha\nsegunda linha\n- terceira');
    check('citacao', await format('quote', { row: 0, col: 3 }) === '> primeira linha\nsegunda linha\n- terceira');
    check('citacao de novo remove', await format('quote', { row: 0, col: 3 }) === 'primeira linha\nsegunda linha\n- terceira');
    check('negrito na selecao', await format('bold', { row: 0, col: 8 }, { row: 0, col: 0 }) === '**primeira** linha\nsegunda linha\n- terceira');
    check('italico na selecao', await format('italic', { row: 1, col: 7 }, { row: 1, col: 0 }) === '**primeira** linha\n*segunda* linha\n- terceira');
    check('codigo na selecao', await format('code', { row: 2, col: 10 }, { row: 2, col: 2 }) === '**primeira** linha\n*segunda* linha\n- `terceira`');
    // Sem selecao o link nasce com o rascunho "texto" ja selecionado, de proposito (tarefa 6): no
    // celular e a pista visual do que preencher, e quem digitar em seguida sobrescreve o rascunho
    check('link com selecao vazia poe o rascunho "texto"', await format('link', { row: 1, col: await end(1) }) === '**primeira** linha\n*segunda* linha[texto](url)\n- `terceira`');

    // ── 3. The real CloseWatcher: on desktop the Esc key is its "back button" ──
    console.log('3. CloseWatcher de verdade (Esc = botao voltar)');
    await open(buildPage('current', currentApp));
    check('o navegador tem CloseWatcher e o app escolheu esse modo', await js('typeof CloseWatcher') === 'function' && await js('__App.useWatcher'));
    await js(FAKE_DRIVE);
    await js(`__App.browseVault().then(() => 'ok')`);
    const view = () => js(`JSON.stringify({ view: document.body.dataset.view, file: __App.currentFile?.id || null, folder: __App.folder?.id || null, stack: __App.navStack.length, hist: history.length })`).then(JSON.parse);
    const back = async () => {
      for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(250);
    };
    const hist0 = (await view()).hist;
    check('pasta raiz aberta', (await view()).view === 'browse', await view());
    await js(`[...document.querySelectorAll('.browser-item')].find(li => li.textContent.includes('com link')).click(); 'ok'`); await sleep(300);
    await js(`document.querySelector('#preview-container a.wikilink').click(); 'ok'`); await sleep(400);
    let v = await view();
    check('pasta > nota > link: na nota de destino, 3 telas na pilha', v.file === 'N2' && v.stack === 3, v);
    await back(); v = await view();
    check('voltar 1: nota anterior', v.file === 'N1' && v.stack === 2, v);
    await back(); v = await view();
    check('voltar 2 (watcher recriado sem toque entre um voltar e outro): pasta', v.view === 'browse' && v.folder === 'ROOT' && v.stack === 1, v);
    await back(); v = await view();
    check('voltar 3: tela inicial', v.view === 'welcome' && v.stack === 0, v);
    check('historico do navegador nunca foi tocado', v.hist === hist0, [hist0, v.hist]);

    // ── 4. Photo: the real canvas shrinks it, the real editor receives the embed ──
    console.log('4. Foto na nota: reducao por canvas e insercao no editor');
    await open(buildPage('current', currentApp));
    await editNote('linha um\nlinha dois', 0, 8);
    const photo = JSON.parse(await js(`(async () => {
      localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
      __App.accessToken = 'fake';
      CONFIG.VAULT_FOLDER_ID = 'ROOT';
      const posts = [];
      window.fetch = async (url, opts = {}) => {
        const ok = (o) => ({ ok: true, status: 200, json: async () => o });
        if (opts.method === 'POST') { posts.push(opts.body); return ok({ id: 'P1', name: 'x' }); }
        return ok({ files: [{ id: 'MEDIA', name: '_media', mimeType: 'application/vnd.google-apps.folder', parents: ['ROOT'] }] });
      };
      // A 12 MP "photo", noisy enough not to compress to nothing
      const canvas = document.createElement('canvas'); canvas.width = 4000; canvas.height = 3000;
      const ctx = canvas.getContext('2d');
      for (let i = 0; i < 4000; i++) { ctx.fillStyle = 'hsl(' + (i * 37 % 360) + ',70%,' + (30 + i % 40) + '%)'; ctx.fillRect(Math.random() * 4000, Math.random() * 3000, 200, 200); }
      const big = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.95));
      const file = new File([big], 'IMG_0001.jpg', { type: 'image/jpeg' });

      const small = await __App.shrinkPhoto(file);
      const dims = await createImageBitmap(small);
      const tiny = new File([await new Promise(r => { const c = document.createElement('canvas'); c.width = 800; c.height = 600; c.toBlob(r, 'image/png'); })], 'print.png', { type: 'image/png' });

      // What the button does, then the picker taking the focus away
      __App._photoAt = __App.Editor.markCaret();
      ${CONTEUDO}.blur(); getSelection().removeAllRanges();
      await __App.insertPhoto(file);
      return JSON.stringify({
        original: file.size, sent: posts[0]?.size, type: small.type, width: dims.width, height: dims.height,
        untouched: (await __App.shrinkPhoto(tiny)) === tiny,
        content: __App.getContent(), dirty: __App.isDirty, status: __App.els.saveStatus.textContent,
      });
    })()`));
    console.log('     original', photo.original, 'bytes -> enviado', photo.sent, 'bytes,', photo.width + 'x' + photo.height);
    check('foto de 4000x3000 sai com 2000 no lado maior, em JPEG', photo.width === 2000 && photo.height === 1500 && photo.type === 'image/jpeg', photo);
    check('o que sobe e bem menor que o original', photo.sent > 0 && photo.sent < photo.original / 2, photo);
    check('imagem pequena sobe como esta', photo.untouched === true);
    check('embed entra onde o cursor estava antes do seletor abrir, com o nome da nota (t.md)', /^linha um\n!\[\[t-foto-\d{6}\.jpg\]\]\n\nlinha dois$/.test(photo.content), photo.content);
    check('nota marcada como nao salva, aviso na tela', photo.dirty === true && photo.status === 'Foto inserida', photo);

    // ── 5. Pictures while editing: a background of the line, never part of the text ──
    console.log('5. Imagem visivel na edicao, embaixo da linha do ![[...]]');
    await open(buildPage('current', currentApp));
    await js(`(() => {
      localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
      __App.accessToken = 'fake';
      window.__searches = 0;
      const svg = (w, h) => '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><rect width="100%" height="100%" fill="#bb86fc"/></svg>';
      window.fetch = async (url) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/WIDE')) return { ok: true, status: 200, blob: async () => new Blob([svg(400, 100)], { type: 'image/svg+xml' }) };
        if (u.pathname.endsWith('/TALL')) return { ok: true, status: 200, blob: async () => new Blob([svg(900, 2000)], { type: 'image/svg+xml' }) };
        // Mais larga que o editor de proposito: e a unica que obriga o app a medir a largura
        // disponivel, em vez de cair no tamanho da propria imagem
        if (u.pathname.endsWith('/HUGE')) return { ok: true, status: 200, blob: async () => new Blob([svg(4000, 1000)], { type: 'image/svg+xml' }) };
        window.__searches++;
        const q = u.searchParams.get('q') || '';
        const hit = q.includes("'larga.png'") ? 'WIDE' : q.includes("'alta.png'") ? 'TALL' : q.includes("'gigante.png'") ? 'HUGE' : null;
        return { ok: true, status: 200, json: async () => ({ files: hit ? [{ id: hit, name: 'x.png', mimeType: 'image/png', parents: ['m'] }] : [] }) };
      };
      return 'ok';
    })()`);
    const NOTE = 'antes\n![[larga.png]]\nmeio ![[larga.png]] no meio da frase\n![[alta.png|300]]\n![[sumiu.png]]\nfim';
    await editNote(NOTE, 0, 5);
    await sleep(600);
    const lines = () => js(`JSON.stringify([...document.querySelectorAll('.cm-line')].map(el => ({
      on: el.classList.contains('embed-line'), pad: Math.round(parseFloat(getComputedStyle(el).paddingBottom)),
      bg: getComputedStyle(el).backgroundImage.startsWith('url("blob:') })))`).then(JSON.parse);
    let l = await lines();
    const lineWidth = Number(await js(`document.querySelectorAll('.cm-line')[1].clientWidth`));
    check('linha que e so o embed ganha a imagem, na proporcao certa e sem esticar', l[1].on && l[1].bg && Math.abs(l[1].pad - (Math.round(Math.min(lineWidth, 400) / 4) + 8)) <= 1, [l[1], lineWidth]);
    check('embed no meio de uma frase nao ganha', !l[2].on && !l[0].on && !l[5].on, l);
    check('imagem alta para em 300px de altura', l[3].on && l[3].pad === 308, l[3]);
    check('imagem que nao existe: linha normal', !l[4].on, l[4]);
    check('o texto da nota nao muda e a nota nao fica suja', await js('__App.getContent()') === NOTE && await js('__App.isDirty') === false);

    const searches = Number(await js('window.__searches'));
    await selecionar({ row: 5, col: 3 });
    await send('Input.insertText', { text: ' da nota' });
    await sleep(400);
    l = await lines();
    check('digitar em outra linha: imagens seguem la, texto certo', l[1].on && l[3].on && (await js('__App.getContent()')).endsWith('fim da nota'));
    check('... sem procurar de novo no Drive (nem a que sumiu)', Number(await js('window.__searches')) === searches, [searches, await js('window.__searches')]);

    await selecionar({ row: 1, col: 0 });
    await send('Input.insertText', { text: 'x ' });
    await sleep(400);
    l = await lines();
    check('linha deixou de ser so o embed: imagem sai', !l[1].on && l[1].pad === 0 && l[3].on, l[1]);

    await js(`__App.setMode('preview'); __App.setMode('edit'); 'ok'`);
    await sleep(300);
    l = await lines();
    check('ir pro modo leitura e voltar mantem a imagem', l[3].on && l[3].bg, l[3]);

    // Foto mais larga que o editor: ela e desenhada com a largura que sobra na linha. O fundo
    // entra com `auto var(--embed-h)`, entao a largura desenhada e a altura vezes a proporcao da
    // imagem (4000x1000 = 4:1). Regressao: medindo o clientWidth do .cm-content, que inclui os
    // 16px de recuo de cada lado, a conta dava 32px a mais que a linha e a foto saia cortada na
    // direita (num celular de 390px, uns 34px). So esta suite tem layout de verdade pra ver isso.
    await editNote('![[gigante.png]]', 0, 0);
    await sleep(600);
    const desenho = JSON.parse(await js(`(() => {
      const el = document.querySelectorAll('.cm-line')[0];
      const altura = parseFloat(getComputedStyle(el).getPropertyValue('--embed-h'));
      const scroller = el.closest('.cm-scroller');
      return JSON.stringify({ embed: el.classList.contains('embed-line'), desenhada: altura * 4, linha: el.clientWidth,
        barra: scroller.offsetWidth - scroller.clientWidth, rola: scroller.scrollHeight > scroller.clientHeight });
    })()`));
    check('a foto desenhada cabe na largura real da linha, sem corte',
      desenho.embed && desenho.desenhada <= desenho.linha + 1 && desenho.desenhada >= desenho.linha - 4, desenho);

    // ── 6. Dates: the caret of a new note in the editor, and the editor catching up out of sight ──
    console.log('6. created e updated no CodeMirror');
    await open(buildPage('current', currentApp));
    await js(`(() => {
      localStorage.clear();
      localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
      __App.accessToken = 'fake';
      window.__written = [];
      window.fetch = async (url, opts = {}) => {
        const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => o, arrayBuffer: async () => new TextEncoder().encode(o).buffer });
        if (opts.method === 'POST') return ok({ id: 'NEW', name: 'n.md', parents: [CONFIG.DEFAULT_FOLDER_ID], modifiedTime: 't1' });
        if (opts.method === 'PATCH') { window.__written.push(opts.body); return ok({ id: 'OLD', modifiedTime: 't1' }); }
        if (new URL(url).searchParams.get('alt') === 'media') return ok('---\\ncreated: 2026-01-02\\nupdated: 2026-01-03\\n---\\n\\ntexto');
        return ok({ id: 'OLD', name: 'velha.md', parents: [CONFIG.VAULT_FOLDER_ID], modifiedTime: 't1' });
      };
      return 'ok';
    })()`);
    const today = await js('__App.today()');
    await js(`__App.newFile(); 'ok'`);
    await sleep(200);
    await send('Input.insertText', { text: 'ideia' });
    await sleep(200);
    check('nota nova: o que se digita cai embaixo das propriedades', await js('__App.getContent()') === `---\ncreated: ${today}\nupdated: ${today}\n---\n\nideia`, await js('__App.getContent()'));

    await js(`__App.isDirty = false; __App.openFile('OLD', 'velha.md').then(() => 'ok')`);
    await js(`__App.setMode('edit'); __App.Editor.focus(); ${SELECIONAR({ row: 5, col: 5 })} 'ok'`);
    await send('Input.insertText', { text: ' novo' });
    await sleep(200);
    await js(`__App.save().then(() => 'ok')`);
    const dated = `---\ncreated: 2026-01-02\nupdated: ${today}\n---\n\ntexto novo`;
    // Onde o cursor esta, em linha:coluna, que e como o TinyMDE respondia e como o cenario fala
    const cursor = () => js(`(() => { const view = __App.Editor._impl.view;
      const cabeca = view.state.selection.main.head; const linha = view.state.doc.lineAt(cabeca);
      return (linha.number - 1) + ':' + (cabeca - linha.from); })()`);
    check('o Drive recebe o updated de hoje', JSON.parse(await js('JSON.stringify(window.__written)'))[0] === dated, await js('JSON.stringify(window.__written)'));
    check('com o teclado aberto o editor fica como esta, cursor no lugar', await js('__App.getContent()') === dated.replace(today, '2026-01-03') && await cursor() === '5:10', await cursor());
    const saveShown = () => js(`getComputedStyle(document.getElementById('btn-save')).display !== 'none'`);
    await js(`__App.setMode('preview'); 'ok'`);
    await sleep(200);
    check('leitura com tudo salvo: sem botao de salvar', await saveShown() === false);
    check('na leitura o editor alcanca o Drive e a nota segue limpa', await js('__App.getContent()') === dated && await js('__App.isDirty') === false, await js('__App.getContent()'));
    await js(`__App.save().then(() => 'ok')`);
    check('sem escrita extra', Number(await js('window.__written.length')) === 1);

    await js(`__App.setMode('edit'); __App.Editor.focus(); ${SELECIONAR({ row: 5, col: 10 })} 'ok'`);
    await send('Input.insertText', { text: '!' });
    await sleep(200);
    await js(`__App.setMode('preview'); 'ok'`);
    check('leitura com texto por salvar: o botao de salvar aparece', await saveShown() === true);
    await js(`document.getElementById('btn-save').click(); 'ok'`);
    await sleep(300);
    check('... salva dali mesmo e some de novo', Number(await js('window.__written.length')) === 2 && await saveShown() === false, await js('window.__written.length'));

    // ── Desenho: canvas de verdade, com dpr, ponta redonda, borracha e recorte ──
    console.log('7. Desenho no canvas de verdade');
    await open(buildPage('sketch', currentApp));
    await js(FAKE_DRIVE);
    await editNote('linha um\n', 0, 8);
    const sketch = JSON.parse(await js(`(async () => {
      __App.setMode('edit');
      document.querySelector('.toolbar-btn[data-sketch]').click();
      const s = __App.sketch;
      const c = s.canvas;
      const move = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true, cancelable: true }));
      // The canvas sits under the 48px top bar, so a point on screen is not a point on the canvas.
      // Reading the pixel under where the finger actually was is what proves the app converts it.
      const rect = c.getBoundingClientRect();
      const under = (x, y) => [...s.ctx.getImageData(Math.round((x - rect.left) * s.dpr), Math.round((y - rect.top) * s.dpr), 1, 1).data];

      // A green stroke, then an eraser stroke over its middle
      document.querySelector('[data-sketch-color="#369680"]').click();
      document.querySelector('[data-sketch-width="12"]').click();
      move('pointerdown', 120, 200); move('pointermove', 220, 200); move('pointerup', 220, 200);
      const painted = under(170, 200);
      const offBy = under(170, 200 + Math.round(rect.top));

      document.getElementById('sketch-erase').click();
      move('pointerdown', 170, 190); move('pointermove', 170, 210); move('pointerup', 170, 210);
      const erased = under(170, 200);

      const out = __App.sketchExport();
      const blob = await new Promise(r => out.toBlob(r, 'image/png'));
      const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
      const box = __App.sketchBounds(s.strokes);
      return JSON.stringify({
        dpr: s.dpr,
        backing: [c.width, c.height],
        cssSize: [c.clientWidth, c.clientHeight],
        cap: s.ctx.lineCap, join: s.ctx.lineJoin,
        painted, erased, offBy, top: rect.top,
        out: [out.width, out.height],
        expected: [Math.round(box.width * s.dpr), Math.round(box.height * s.dpr)],
        png: [...head],
        type: blob.type,
      });
    })()`));

    check('canvas guarda o backing store em pixels do aparelho', sketch.backing[0] === Math.round(sketch.cssSize[0] * sketch.dpr), sketch);
    check('ponta e junta do traco sao redondas', sketch.cap === 'round' && sketch.join === 'round', sketch);
    check('o traco verde pintou de verde opaco', sketch.painted[3] > 200 && sketch.painted[1] > sketch.painted[0], sketch.painted);
    check('e pintou sob o dedo, nao deslocado pela faixa do topo', sketch.top > 0 && sketch.offBy[3] === 0, [sketch.top, sketch.offBy]);
    check('a borracha apagou pra transparente, nao pra preto', sketch.erased[3] === 0, sketch.erased);
    check('o PNG sai no tamanho do recorte vezes o dpr', sketch.out[0] === sketch.expected[0] && sketch.out[1] === sketch.expected[1], sketch);
    check('e e um PNG de verdade', sketch.type === 'image/png' && sketch.png.slice(0, 4).join() === '137,80,78,71', sketch);

    // ── O dialogo de descartar precisa receber o dedo, nao so ficar "visible" ──
    console.log('8. Desenho: o dialogo de descartar e alcancavel pelo dedo');
    await open(buildPage('sketch-dialogo', currentApp));
    await js(FAKE_DRIVE);
    await editNote('linha um\n', 0, 8);
    const dialogo = JSON.parse(await js(`(() => {
      __App.setMode('edit');
      document.querySelector('.toolbar-btn[data-sketch]').click();
      const c = __App.sketch.canvas;
      const r = c.getBoundingClientRect();
      for (const type of ['pointerdown', 'pointerup']) {
        c.dispatchEvent(new PointerEvent(type, { clientX: 100, clientY: r.top + 100, pointerId: 1, bubbles: true, cancelable: true }));
      }
      document.getElementById('sketch-cancel').click();

      // elementFromPoint responde o que o dedo acertaria de verdade, e nao o que a classe diz
      const hit = (el) => {
        const b = el.getBoundingClientRect();
        const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return el === top || el.contains(top);
      };
      const ok = document.getElementById('confirm-ok');
      const cancel = document.getElementById('confirm-cancel');
      return JSON.stringify({
        visivel: document.getElementById('confirm-overlay').classList.contains('visible'),
        okAlcancavel: hit(ok),
        cancelarAlcancavel: hit(cancel),
        porCimaDoOk: (() => { const b = ok.getBoundingClientRect(); const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return t ? (t.id || t.className || t.tagName) : null; })(),
      });
    })()`));
    check('o dialogo abre', dialogo.visivel, dialogo);
    check('o dedo alcanca o "Descartar"', dialogo.okAlcancavel, dialogo);
    check('o dedo alcanca o "Cancelar"', dialogo.cancelarAlcancavel, dialogo);

    // ── Tarefa: um clique de verdade na caixa, com o CodeMirror guardando o texto ──
    console.log('9. Tarefa marcada no modo leitura, com o CodeMirror');
    await open(buildPage('tarefa', currentApp));
    await js(FAKE_DRIVE);
    await editNote('- [ ] Agatha\n- [ ] Banguela\n', 0, 0);
    await js(`__App.setMode('preview'); 'ok'`);
    await sleep(200);
    const box = JSON.parse(await js(`(() => {
      const b = document.querySelectorAll('#preview-container input[type="checkbox"]')[1].getBoundingClientRect();
      return JSON.stringify({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
    })()`));
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await sleep(200);
    check('o clique marca a segunda tarefa no texto', await js('__App.getContent()') === '- [ ] Agatha\n- [x] Banguela\n', await js('__App.getContent()'));
    check('a caixa fica marcada na tela e a nota tem o que salvar', await js(`document.querySelectorAll('#preview-container input[type="checkbox"]')[1].checked && __App.isDirty`) === true);
    await js(`__App.setMode('edit'); 'ok'`);
    await sleep(200);
    check('na edicao o editor mostra o [x]', (await js(`${CONTEUDO}.textContent`)).includes('- [x] Banguela'), await js(`${CONTEUDO}.textContent`));

    // ── Deslizar da borda: toque de verdade, numa tela de celular, com o CloseWatcher real ──
    console.log('10. Deslizar da borda com toque de verdade');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await open(buildPage('swipe', currentApp));
    await js(FAKE_DRIVE);
    await js(`__App.browseVault().then(() => 'ok')`);
    await js(`[...document.querySelectorAll('.browser-item')].find(li => li.textContent.includes('com link')).click(); 'ok'`);
    await esperar(`__App.currentFile && __App.currentFile.id === 'N1'`);
    await js(`document.querySelector('#preview-container a.wikilink').click(); 'ok'`);
    await esperar(`__App.currentFile && __App.currentFile.id === 'N2' && __App.navStack.length === 3`);
    // Este cenario era o unico que lia o estado no relogio (`sleep(400)` depois de soltar), e era
    // o unico intermitente. Duas coisas separam o toque injetado do que o app viu:
    //
    // 1. `Input.dispatchTouchEvent` entra por uma fila do navegador que NAO e a do
    //    `Runtime.evaluate`. Com o renderizador headless engasgado (medido: cinco segundos entre o
    //    toque e o app reagir), a leitura marcada no relogio chega antes de o app ver o gesto.
    //    Por isso cada etapa agora espera o app dizer que viu, com `esperar`.
    // 2. O navegador as vezes manda `touchcancel` no meio da sequencia injetada, e o app faz o
    //    certo: abandona o gesto (`endSwipe`, sem agir). Isso e artefato da injecao, nao do app,
    //    entao o arrasto e refeito, ate tres vezes, e so o que sobrar vira checagem.
    //
    // O sinal esperado e sempre ANTERIOR ao que as checagens olham (elas olham classe, retangulo
    // e cor da seta, e o par arquivo/pilha depois do gesto): espera-se o `_swipe.armed` do app e a
    // pilha mudar. Se a seta parar de ser pintada ou o gesto parar de navegar, fica vermelho.
    await js(`window.__cancelados = 0; document.addEventListener('touchcancel', () => window.__cancelados++, true); 'ok'`);
    const LIMITE_DO_GESTO = 4000;
    const drag = async (x0, x1, y, shot) => {
      let hint = null;
      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        const pilhaAntes = Number(await js('__App.navStack.length'));
        await js('window.__cancelados = 0; "ok"');
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
        for (let i = 1; i <= 8; i++) {
          await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / 8, y }] });
          await sleep(16);
        }
        // `armed` e nao a puxada cheia: o navegador junta movimentos do mesmo quadro e o ultimo as
        // vezes nao chega (medido: `pull` parando em 119 dos 136 arrastados). O que decide o gesto,
        // na hora de soltar, e ter passado do gatilho, e e isso que o app anota aqui.
        const armado = await esperar(`__App._swipe && __App._swipe.armed === true`, LIMITE_DO_GESTO);
        // O print do meio do gesto so na primeira tentativa: capturar quadro com o dedo na tela e
        // um dos jeitos de provocar o `touchcancel` que faz a tentativa ser refeita
        if (shot && tentativa === 1) {
          const { data } = (await send('Page.captureScreenshot', { format: 'png' })).result;
          fs.mkdirSync(path.join(ROOT, 'tests', '.tmp'), { recursive: true });
          fs.writeFileSync(path.join(ROOT, 'tests', '.tmp', shot), Buffer.from(data, 'base64'));
        }
        hint = JSON.parse(await js(`(() => { const h = document.getElementById('swipe-hint'); const b = h.getBoundingClientRect();
          return JSON.stringify({ visible: h.classList.contains('visible'), armed: h.classList.contains('armed'), left: b.left, right: b.right, bg: getComputedStyle(h).backgroundColor }); })()`));
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        let navegou = await esperar(`__App._swipe === null && __App.navStack.length !== ${pilhaAntes}`, LIMITE_DO_GESTO);
        // Uma ultima leitura direta: o limite pode ter estourado justamente na virada
        if (!navegou) navegou = Number(await js('__App.navStack.length')) !== pilhaAntes;
        if (armado && navegou) return hint;
        console.log(`     (tentativa ${tentativa} do gesto perdida: armado=${armado} navegou=${navegou}`
          + ` touchcancel=${await js('window.__cancelados')})`);
      }
      return hint;
    };
    let seta = await drag(4, 140, 400, 'swipe-voltar.png');
    v = await view();
    check('a seta sai da borda esquerda, inteira na tela e roxa', seta.visible && seta.armed && seta.left >= 0 && seta.bg === 'rgb(139, 108, 239)', seta);
    check('soltar volta pra nota anterior', v.file === 'N1' && v.stack === 2, v);
    seta = await drag(386, 250, 400, 'swipe-avancar.png');
    v = await view();
    check('a seta sai da borda direita', seta.visible && seta.armed && seta.right <= 390, seta);
    check('soltar avanca pra nota do link', v.file === 'N2' && v.stack === 3, v);
    await drag(4, 140, 400);
    await drag(4, 140, 400);
    v = await view();
    check('mais dois deslizes da esquerda: volta ate a pasta',v.view === 'browse' && v.folder === 'ROOT', v);
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await send('Emulation.clearDeviceMetricsOverride');

    // ── A barra de formatacao rola de lado de verdade ──
    console.log('11. A barra de formatacao rola de lado de verdade');
    // Largura de celular: o Edge headless nao abre janela pequena, entao e override de metricas
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 2, mobile: true });
    await open(buildPage('toolbar-scroll', currentApp));
    // A barra so existe no CSS com body[data-view="edit"]; numa pagina recem aberta (tela de
    // boas-vindas) ela fica display:none e a medida sai toda zerada, o que foi medido na primeira
    // rodada (RED) e nao e o "os botoes encolhem" que o brief esperava
    await editNote('linha um\nlinha dois', 0, 0);
    const medida = await js(`(() => {
      const barra = document.querySelector('.toolbar');
      const botao = barra.querySelector('.toolbar-btn');
      return {
        conteudo: barra.scrollWidth,
        visivel: barra.clientWidth,
        larguraBotao: Math.round(botao.getBoundingClientRect().width),
        alturaBotao: Math.round(botao.getBoundingClientRect().height),
      };
    })()`);
    check('o conteudo da barra e mais largo que a tela, entao ela rola',
      medida.conteudo > medida.visivel, medida);
    check('o alvo de dedo tem pelo menos 44px', medida.larguraBotao >= 44, medida);

    // ── Arrastar o dedo EM CIMA de um botao rola a barra ──
    // O app cancelava o comeco do toque nos botoes (pra nao roubar o foco do editor e fechar o
    // teclado) e com isso matava o pan: sobrava a fresta de 6px entre os botoes e a borda da
    // barra, que e o "algo muito fino" do relato. So aqui da pra provar o contrario, porque quem
    // rola e o navegador, e o jsdom nao rola nada.
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    const alvo = await js(`(() => {
      // The target has to be on the 360px screen before the bar scrolls: the quote button was, with 11
      // buttons; with 18 it sits past the edge and a touch out there lands on nothing (v37)
      const b = document.querySelector('.toolbar-btn[data-format="wikilink"]').getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), right: Math.round(b.right) };
    })()`);
    const textoAntes = await js('__App.Editor.getText()');
    let rolou = false;
    // Toque injetado entra numa fila diferente da leitura, e o navegador as vezes desiste do
    // gesto no meio (o touchcancel do cenario 10): o arrasto e refeito ate tres vezes
    for (let tentativa = 1; tentativa <= 3 && !rolou; tentativa++) {
      await js('document.querySelector(".toolbar").scrollLeft = 0; "ok"');
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: alvo.x, y: alvo.y }] });
      for (let i = 1; i <= 8; i++) {
        await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: alvo.x - i * 12, y: alvo.y }] });
        await sleep(16);
      }
      rolou = await esperar('document.querySelector(".toolbar").scrollLeft > 20', 3000);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      if (!rolou) console.log(`     (tentativa ${tentativa} de rolar a barra perdida)`);
    }
    check('o botao alvo do arrasto esta na tela (senao o toque cai no nada)', alvo.right <= 360, alvo);
    check('o dedo arrastado em cima de um botao rola a barra', rolou,
      await js('document.querySelector(".toolbar").scrollLeft'));
    check('e o arrasto nao formatou nada: rolar nao e tocar',
      await js('__App.Editor.getText()') === textoAntes, await js('__App.Editor.getText()'));
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await send('Emulation.clearDeviceMetricsOverride');

    // ── O bloco de propriedades e os colchetes que nao sao link saem como texto comum ──
    console.log('12. Propriedades e colchetes como texto comum');
    // So aqui da pra provar: a asserção e de estilo computado (tamanho, peso, cor e sublinhado que
    // de fato chegaram na tela), e isso precisa de layout. O CM6 nao deixa classe estavel no
    // realce (o nome sai do gerador de CSS dele e muda a cada build), entao nao ha classe pra
    // procurar: o que vale e o pixel.
    await open(buildPage('texto-comum', currentApp));
    const NOTA_PROPS = '---\ncreated: 2026-09-21\nupdated: 2026-09-21\ntags: [casa, obra]\n---\n\n'
      + '# Titulo grande\n\nvai [[destino]] e [link](http://x)\n\n> [!note] aviso e mais texto';
    await editNote(NOTA_PROPS, 8, 0);
    const ROXO = 'rgb(166, 141, 255)';   // --accent-hover, o roxo que escreve

    // A linha e cada <span> que o realce criou dentro dela
    const estilos = (i) => js(`(() => {
      const el = [...document.querySelectorAll('.cm-line')][${i}];
      return JSON.stringify([el, ...el.querySelectorAll('span')].map(a => {
        const s = getComputedStyle(a);
        return { txt: a.textContent, px: Math.round(parseFloat(s.fontSize)), peso: Number(s.fontWeight),
          cor: s.color, risco: s.textDecorationLine };
      }));
    })()`).then(JSON.parse);

    // O texto comum da nota, medido e nao chutado: e com ele que o bloco tem que se parecer
    const comum = (await estilos(8))[0];
    const igualAoComum = (p) => p.px === comum.px && p.peso === comum.peso && p.cor === comum.cor && p.risco === 'none';
    const bloco = [].concat(...await Promise.all([0, 1, 2, 3, 4].map(estilos)));
    check('o bloco de propriedades inteiro sai do tamanho, do peso e da cor do texto comum',
      bloco.length >= 6 && bloco.every(igualAoComum), bloco.filter(p => !igualAoComum(p)));

    // Controle: se a regra tivesse vazado pra fora do bloco, o titulo de verdade tambem apagaria
    const titulo = await estilos(6);
    check('titulo de verdade fora do bloco continua grande, negrito e roxo',
      titulo.some(p => p.px > comum.px && p.peso > comum.peso && p.cor === ROXO), titulo);

    // `[[wikilink]]`, `[!note]` e `tags: [a, b]`: o parser le os tres como link de referencia sem
    // destino. A checagem olha o conjunto todo (o span da decoracao e os do realce dentro dele),
    // porque e no de dentro que moram a cor e o sublinhado
    const colchete = (trecho) => js(`(() => {
      const marca = [...document.querySelectorAll('.cm-content .plain-brackets')]
        .find(s => s.textContent === ${JSON.stringify(trecho)});
      if (!marca) return JSON.stringify({ achou: false });
      const dentro = [marca, ...marca.querySelectorAll('span')].map(e => getComputedStyle(e));
      const vizinho = [...marca.closest('.cm-line').querySelectorAll('span')]
        .find(s => s.textContent.includes('aviso'));
      return JSON.stringify({
        achou: true,
        cores: [...new Set(dentro.map(s => s.color))],
        riscos: [...new Set(dentro.map(s => s.textDecorationLine))],
        corDaLinha: getComputedStyle(marca.closest('.cm-line')).color,
        corDoVizinho: vizinho ? getComputedStyle(vizinho).color : null,
      });
    })()`).then(JSON.parse);

    const wiki = await colchete('[destino]');
    check('[[wikilink]]: uma cor so, a do texto em volta, e sem sublinhado',
      wiki.achou && wiki.cores.length === 1 && wiki.cores[0] === wiki.corDaLinha
      && wiki.cores[0] !== ROXO && wiki.riscos.every(r => r === 'none'), wiki);

    const tags = await colchete('[casa, obra]');
    check('tags: [a, b] no bloco de propriedades: sem roxo e sem sublinhado',
      tags.achou && tags.cores.length === 1 && tags.cores[0] !== ROXO && tags.riscos.every(r => r === 'none'), tags);

    // Dentro de uma citacao o realce pinta cada pedaco da linha num span irmao, entao o `[!note]`
    // sai na cor do texto comum e nao na cor apagada da citacao em volta (medido, e anotado no
    // style.css): e texto comum, so um tom mais claro que a citacao. O que nao pode e o roxo
    // sublinhado de antes
    const callout = await colchete('[!note]');
    check('[!note] dentro da citacao sai como texto comum, sem roxo e sem sublinhado',
      callout.achou && callout.cores.length === 1 && callout.cores[0] === comum.cor
      && callout.cores[0] !== ROXO && callout.corDoVizinho !== ROXO
      && callout.riscos.every(r => r === 'none'), callout);

    // Controle do controle: link de verdade nao foi apagado junto
    const link = JSON.parse(await js(`(() => {
      const spans = [...document.querySelectorAll('.cm-content span')].filter(s => s.textContent === 'link');
      const s = getComputedStyle(spans[spans.length - 1]);
      return JSON.stringify({ cor: s.color, risco: s.textDecorationLine });
    })()`));
    check('[texto](url), que e link de verdade, continua roxo e sublinhado',
      link.cor === ROXO && link.risco === 'underline', link);

    console.log('13. A lista de notas do [[ na tela, e o toque num item');
    // So aqui da pra provar: no jsdom o tooltip do CM6 existe no estado, mas nao tem posicao nem
    // recebe toque (getBoundingClientRect devolve zeros). O que importa neste cenario e o que o
    // dedo ve e o que o dedo faz: a lista desenhada, e o item tocado escrevendo o link SEM tirar o
    // foco do editor, que no celular e o que decide se o teclado fecha (ver drive-notes-aprendizados).
    await open(buildPage('link-list', currentApp));
    await js(FAKE_DRIVE);
    // Com nada digitado depois do [[ a lista mostra as recentes: sem elas nao haveria o que desenhar
    await js(`__App.saveToRecents('N1', 'com link.md'); __App.saveToRecents('N2', 'destino.md'); 'ok'`);
    await editNote('vai ', 0, 4);
    // Pelo caminho do teclado, e nao por dispatch no estado: e o `input` do navegador que aciona o
    // activateOnTyping da lista, e e esse caminho que o celular usa
    await send('Input.insertText', { text: '[[' });
    const itens = `[...document.querySelectorAll('.cm-tooltip-autocomplete li')]`;
    const apareceu = await esperar(`${itens}.length >= 2`);
    check('digitar [[ desenha a lista na tela, com as recentes', apareceu === true,
      await js(`JSON.stringify(${itens}.map(li => li.textContent))`));

    await send('Input.insertText', { text: 'de' });
    const filtrou = await esperar(`${itens}.length === 1 && ${itens}[0].textContent.includes('destino')`);
    check('digitar filtra ate sobrar destino', filtrou === true, await js(`JSON.stringify(${itens}.map(li => li.textContent))`));

    // O cromo do app em cima do da biblioteca: o tema do @codemirror/autocomplete manda
    // `font-family: monospace` na lista (e o mesmo seletor que o style.css usa, entao quem ganha
    // e quem vem depois). Se o CSS do app nao pegar, a lista sai branca e em fonte de codigo.
    const cromo = JSON.parse(await js(`(() => {
      const caixa = document.querySelector('.cm-tooltip-autocomplete');
      const ul = caixa.querySelector('ul'); const li = ul.querySelector('li');
      return JSON.stringify({ fonte: getComputedStyle(ul).fontFamily, fundo: getComputedStyle(caixa).backgroundColor,
        altura: Math.round(li.getBoundingClientRect().height), recuo: getComputedStyle(li).paddingLeft,
        detalhe: getComputedStyle(li.querySelector('.cm-completionDetail')).fontSize });
    })()`));
    check('a lista veste o cromo do app: fonte de interface, fundo escuro, item de 44px e a pasta em letra menor',
      cromo.fonte.includes('Figtree') && !cromo.fonte.includes('monospace')
      && cromo.fundo === 'rgb(36, 34, 41)' && cromo.altura >= 44 && cromo.recuo === '14px'
      && cromo.detalhe === '12px', cromo);

    // O print do meio: a lista aberta, com o cromo do app
    {
      const { data } = (await send('Page.captureScreenshot', { format: 'png' })).result;
      fs.mkdirSync(path.join(ROOT, 'tests', '.tmp'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'tests', '.tmp', 'link-list-aberta.png'), Buffer.from(data, 'base64'));
    }

    const item = JSON.parse(await js(`(() => { const b = ${itens}[0].getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }); })()`));
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: item.x, y: item.y, button: 'left', clickCount: 1 });
    }
    const escolheu = await esperar(`__App.getContent() === 'vai [[destino]]'`);
    check('tocar no item escreve o link e fecha a lista',
      escolheu === true && await js(`!document.querySelector('.cm-tooltip-autocomplete')`) === true,
      await js('__App.getContent()'));
    check('o foco continua no editor: no celular, o teclado nao fecharia',
      await js(`document.activeElement === document.querySelector('.cm-content')`) === true,
      await js(`document.activeElement ? document.activeElement.className : null`));

    console.log('14. O botao de extrair: gruda na ponta direita da barra e recebe o toque');
    // So aqui da pra provar: o sticky, a cor e o alvo do dedo precisam de layout. "Esta visivel" e
    // "da pra tocar" sao perguntas diferentes, e quem responde a segunda e o elementFromPoint
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 2, mobile: true });
    await open(buildPage('extract-button', currentApp));
    await js(FAKE_DRIVE);
    await editNote('uma linha\noutra linha', 0, 0);
    await selecionar({ row: 0, col: 9 }, { row: 0, col: 0 });
    const acendeu = await esperar(`document.body.classList.contains('has-selection')`);
    check('texto selecionado acende o botao', acendeu === true);
    const medirExtrair = () => js(`(() => {
      const b = document.querySelector('.toolbar-btn[data-extract]').getBoundingClientRect();
      const t = document.querySelector('.toolbar-btn[data-format="checklist"]').getBoundingClientRect();
      const x = Math.round(b.left + b.width / 2), y = Math.round(b.top + b.height / 2);
      const noPonto = document.elementFromPoint(x, y);
      return JSON.stringify({ x, y, left: Math.round(b.left), right: Math.round(b.right), largura: Math.round(b.width),
        recebe: !!noPonto && !!noPonto.closest('[data-extract]'), tarefaLeft: Math.round(t.left), tarefaRight: Math.round(t.right) });
    })()`).then(JSON.parse);

    await js('document.querySelector(".toolbar").scrollLeft = 0; "ok"');
    const noComeco = await medirExtrair();
    check('barra no comeco: o botao esta na tela, com 44px, e o toque cai nele',
      noComeco.largura >= 44 && noComeco.right <= 360 && noComeco.recebe, noComeco);
    await js('document.querySelector(".toolbar").scrollLeft = 1e6; "ok"');
    await sleep(100);
    const noFim = await medirExtrair();
    check('barra rolada ate o fim: continua na tela e recebendo o toque',
      noFim.largura >= 44 && noFim.right <= 360 && noFim.recebe, noFim);
    check('... e a tarefa, ultima da fila, aparece inteira antes dele',
      noFim.tarefaLeft >= 0 && noFim.tarefaRight <= noFim.left, noFim);

    // O unico botao cheio da barra: --accent #8b6cef preenche, --bg-primary #1c1b1f por cima
    // (identidade-visual: sobre preenchimento colorido, o que esta em cima e escuro)
    const cor = JSON.parse(await js(`(() => { const s = getComputedStyle(document.querySelector('.toolbar-btn[data-extract]'));
      return JSON.stringify({ fundo: s.backgroundColor, tinta: s.color }); })()`));
    check('o botao cheio: fundo --accent e icone --bg-primary',
      cor.fundo === 'rgb(139, 108, 239)' && cor.tinta === 'rgb(28, 27, 31)', cor);
    {
      const { data } = (await send('Page.captureScreenshot', { format: 'png' })).result;
      fs.mkdirSync(path.join(ROOT, 'tests', '.tmp'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'tests', '.tmp', 'extrair-botao.png'), Buffer.from(data, 'base64'));
    }

    await js('document.querySelector(".toolbar").scrollLeft = 0; "ok"');
    const alvoExtrair = await medirExtrair();
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: alvoExtrair.x, y: alvoExtrair.y, button: 'left', clickCount: 1 });
    }
    const abriu = await esperar(`document.getElementById('modal-overlay').classList.contains('visible')
      && document.getElementById('modal-input').value === 'uma-linha'`);
    check('o toque abre a caixa com o nome sugerido', abriu === true, await js(`document.getElementById('modal-input').value`));
    await js('__App.hideModal(); "ok"');
    await send('Emulation.clearDeviceMetricsOverride');

    console.log('15. Nota guardada no aparelho: reabre na hora com a pagina recarregada, e troca sem perder a rolagem');
    // So aqui: o IndexedDB de verdade (o jsdom usa o fake-indexeddb), a pagina recarregada como o app
    // que o Android matou, e a rolagem, que precisa de layout
    const DRIVE_DA_NOTA = `
      localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
      __App.accessToken = 'fake';
      window.__drive = { lento: 0, mt: 't1', texto: null,
        longa: '# Destino\\n\\n' + Array.from({ length: 150 }, (_, i) => 'linha ' + i).join('\\n\\n') };
      window.fetch = async (url) => {
        const u = new URL(url);
        const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => o, arrayBuffer: async () => new TextEncoder().encode(o).buffer });
        await new Promise(r => setTimeout(r, window.__drive.lento));
        if (u.searchParams.get('alt') === 'media') return ok(window.__drive.texto || window.__drive.longa);
        if (/files\\/N2$/.test(u.pathname)) return ok({ id: 'N2', name: 'destino.md', parents: ['F1'], modifiedTime: window.__drive.mt });
        return ok({ files: [] });
      };
      'ok'`;
    const APAGAR_BANCO = `new Promise(r => { const q = indexedDB.deleteDatabase('drivenotes'); q.onsuccess = q.onerror = q.onblocked = () => r('ok'); })`;

    await open(buildPage('nota-guardada', currentApp));
    await js(APAGAR_BANCO);
    await js(DRIVE_DA_NOTA);
    await js(`__App.openFile('N2', 'destino.md').then(() => 'ok')`);
    await sleep(300);
    const guardou = await js(`__App.NoteStore.get('N2').then(e => !!e && e.content.includes('linha 149'))`);
    check('abrir do Drive guardou a nota no IndexedDB de verdade (em file://)', guardou === true);

    // A pagina recarregada e o app que o Android matou: memoria zerada, o aparelho com o que guardou
    await open(buildPage('nota-guardada', currentApp));
    await js(DRIVE_DA_NOTA);
    await js(`window.__drive.lento = 1500; 'ok'`);
    await js(`__App.openFile('N2', 'destino.md'); 'ok'`);
    // Nome proprio: `apareceu` ja e do cenario 13, no mesmo escopo
    const apareceuGuardada = await esperar(`document.getElementById('preview-container').textContent.includes('linha 149')`, 1000);
    check('recarregada a pagina, a nota aparece com o Drive ainda calado', apareceuGuardada === true);
    const linhaDoLog = await js(`__App._log.find(l => l.includes('cached destino.md')) || ''`);
    const ms = Number(/cached destino\.md (\d+)ms/.exec(linhaDoLog)?.[1]);
    console.log('     medida do app:', linhaDoLog.split(' | ')[0]);
    check('... em menos de 200ms, pela medida do proprio app', ms < 200, linhaDoLog);
    await sleep(1800); // a conferencia desta abertura termina ("same")

    // Mudou no Drive: a guardada aparece, rola, e a nova chega sem mexer na rolagem
    await js(`window.__drive.lento = 400; window.__drive.mt = 't2';
      window.__drive.texto = window.__drive.longa + '\\n\\nlinha nova do PC'; 'ok'`);
    await js(`__App.openFile('N2', 'destino.md'); 'ok'`);
    await sleep(100);
    await js(`document.getElementById('preview-container').scrollTop = 1500; 'ok'`);
    const antes = await js(`document.getElementById('preview-container').scrollTop`);
    const trocou = await esperar(`document.getElementById('preview-container').textContent.includes('linha nova do PC')`, 3000);
    const depois = await js(`document.getElementById('preview-container').scrollTop`);
    console.log(`     rolagem antes da troca ${antes}, depois ${depois}`);
    check('mudou no Drive: trocou sozinha, com o aviso',
      trocou === true && await js(`document.getElementById('save-status').textContent`) === 'Atualizada do Drive');
    check('... sem perder a rolagem', antes > 0 && Math.abs(depois - antes) <= 2, { antes, depois });
    await js(APAGAR_BANCO);

    console.log('16. Leitura: lista que vem depois de outra lista abre o mesmo respiro que um grupo');
    // A nota dos prints da Agatha de 20 set 2026: tarefas em dois grupos, uma numerada, uma com
    // marcador e sublista. Grupo dentro da mesma lista ja abria o respiro (li.gap, v28); lista
    // seguinte colava na anterior. Medido em pixels, que so o navegador tem
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await open(buildPage('listas', currentApp));
    await js(FAKE_DRIVE);
    await editNote('- [x] Lady\n- [x] Banguela\n- [x] Chloe\n- [x] Gucci\n\n- [x] Agatha\n- [x] Victor\n- [x] Ceiça\n\n'
      + '1. Wicked\n2. Hadestown\n3. The Phantom of The Opera\n\n\n- Agatha\n  - Lady\n  - Gucci\n', 0, 0);
    await js(`__App.setMode('preview'); 'ok'`);
    await sleep(200);
    const listas = JSON.parse(await js(`(() => {
      const items = [...document.querySelectorAll('#preview-container li')];
      const li = (text) => items.find(el => el.firstChild && el.textContent.trim().startsWith(text) && !el.closest('li li'));
      const between = (a, b) => Math.round(li(b).getBoundingClientRect().top - li(a).getBoundingClientRect().bottom);
      return JSON.stringify({
        mesmoGrupo: between('Lady', 'Banguela'),
        grupo: between('Gucci', 'Agatha'),
        tarefaNumerada: between('Ceiça', 'Wicked'),
        numeradaMarcador: between('The Phantom', 'Agatha\\n'),
      });
    })()`));
    console.log('     distancias em px:', JSON.stringify(listas));
    check('itens do mesmo grupo continuam juntos', listas.mesmoGrupo < 10, listas);
    check('tarefas seguidas de numerada: o mesmo respiro de um grupo', Math.abs(listas.tarefaNumerada - listas.grupo) <= 2, listas);
    check('numerada seguida de lista com marcador: o mesmo respiro', Math.abs(listas.numeradaMarcador - listas.grupo) <= 2, listas);
    await send('Emulation.clearDeviceMetricsOverride');

    console.log('17. Datilografia: a linha que se escreve para no meio da tela, e so a escrita rola');
    // Sem teclado de verdade aqui: a area de escrita e a tela inteira menos cabecalho e barra. No
    // celular o teclado encolhe a pagina (interactive-widget) e o meio passa a ser o meio do que sobra
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await open(buildPage('datilografia', currentApp));
    await js(FAKE_DRIVE);
    const LONGA = Array.from({ length: 80 }, (_, i) => 'linha ' + i).join('\n');
    // Altura do cursor em % da area que rola (0 = topo, 100 = pe), e a rolagem
    const ondeEsta = async () => JSON.parse(await js(`(() => {
      const view = __App.Editor._impl.view;
      const caret = view.coordsAtPos(view.state.selection.main.head);
      const box = view.scrollDOM.getBoundingClientRect();
      return JSON.stringify({ altura: Math.round((caret.bottom - box.top) / box.height * 100),
        rolagem: Math.round(view.scrollDOM.scrollTop) });
    })()`));

    await editNote(LONGA, 79, 'linha 79'.length);
    await send('Input.insertText', { text: ' mais' });
    await sleep(150);
    const datiloFim = await ondeEsta();
    console.log('     escrevendo no fim da nota:', JSON.stringify(datiloFim));
    check('escrevendo no fim de nota longa, a linha fica no meio e nao colada no pe', datiloFim.altura >= 35 && datiloFim.altura <= 55, datiloFim);

    // Ditado que quebra em varias linhas: a tela acompanha linha a linha e a frase entra inteira
    const FRASE = 'hoje fui ao mercado e comprei tudo o que faltava pra semana, inclusive a racao dos cachorros e o cafe';
    for (let n = 10; n <= FRASE.length; n += 15) {
      await send('Input.imeSetComposition', { text: FRASE.slice(0, n), selectionStart: n, selectionEnd: n });
      await sleep(40);
    }
    await send('Input.insertText', { text: FRASE });
    await sleep(150);
    const depoisDoDitado = await ondeEsta();
    const texto = await js('__App.getContent()');
    console.log('     depois de um ditado de varias linhas:', JSON.stringify(depoisDoDitado));
    check('o ditado entra inteiro, uma vez so', texto.endsWith('linha 79 mais' + FRASE), texto.slice(-160));
    check('... e a linha continua no meio, com a tela tendo subido', depoisDoDitado.altura >= 35 && depoisDoDitado.altura <= 55
      && depoisDoDitado.rolagem > datiloFim.rolagem, { datiloFim, depoisDoDitado });

    // No alto da nota nao ha o que rolar: escrever ali nao mexe na tela
    await editNote(LONGA, 2, 0);
    await js(`__App.Editor._impl.view.scrollDOM.scrollTop = 0; 'ok'`);
    await send('Input.insertText', { text: 'x' });
    await sleep(150);
    const noAlto = await ondeEsta();
    check('escrevendo no alto da nota, a tela fica parada', noAlto.rolagem === 0, noAlto);

    // O toque so poe o cursor: tocar numa linha la embaixo nao puxa ela pro meio (quem puxa e a escrita)
    const pe = JSON.parse(await js(`(() => { const b = __App.Editor._impl.view.scrollDOM.getBoundingClientRect();
      return JSON.stringify({ x: b.left + 80, y: b.bottom - 30 }); })()`));
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: pe.x, y: pe.y, button: 'left', clickCount: 1 });
    }
    await sleep(150);
    const depoisDoToque = await ondeEsta();
    check('tocar numa linha perto do pe poe o cursor la sem rolar', depoisDoToque.rolagem === 0 && depoisDoToque.altura > 80, depoisDoToque);
    await send('Emulation.clearDeviceMetricsOverride');

    console.log('18. Retomar a nota onde parou: reabre no mesmo paragrafo, com a foto de cima chegando depois');
    // O que o jsdom nao prova: o layout de verdade, e a foto que chega do Drive depois de a nota aparecer.
    // Guardado em pixels, o lugar cairia mais pra baixo enquanto a foto de cima nao chegou; guardado pelo
    // bloco, cai no mesmo paragrafo, e a ancoragem de rolagem do navegador segura ele quando a foto cresce
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const DRIVE_DA_FOTO = `
      localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
      __App.accessToken = 'fake';
      window.__foto = { atraso: 0, chegou: false };
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><rect width="100%" height="100%" fill="#bb86fc"/></svg>';
      const longa = '# Longa\\n\\n![[foto.png]]\\n\\n'
        + Array.from({ length: 60 }, (_, i) => 'paragrafo ' + i + ' ' + 'texto '.repeat((i % 7) * 6)).join('\\n\\n');
      window.fetch = async (url) => {
        const u = new URL(url);
        const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => o, arrayBuffer: async () => new TextEncoder().encode(o).buffer });
        if (/files\\/FOTO$/.test(u.pathname)) {
          await new Promise(r => setTimeout(r, window.__foto.atraso));
          window.__foto.chegou = true;
          return { ok: true, status: 200, blob: async () => new Blob([svg], { type: 'image/svg+xml' }) };
        }
        if (u.searchParams.get('alt') === 'media') return ok(longa);
        if (/files\\/N3$/.test(u.pathname)) return ok({ id: 'N3', name: 'longa.md', parents: ['F1'], modifiedTime: 't1' });
        const q = u.searchParams.get('q') || '';
        return ok({ files: q.includes("'foto.png'") ? [{ id: 'FOTO', name: 'foto.png', mimeType: 'image/png', parents: ['m'] }] : [] });
      };
      'ok'`;
    // O bloco no topo da tela, onde ele esta em relacao ao topo, e a altura da foto
    const noTopo = async () => JSON.parse(await js(`(() => {
      const c = document.getElementById('preview-container');
      const top = c.getBoundingClientRect().top;
      const el = [...c.children].find(e => e.getBoundingClientRect().bottom > top);
      const foto = document.querySelector('#preview-container img[data-embed]');
      return JSON.stringify({ texto: el ? el.textContent.split(' texto')[0].trim() : '', px: el ? Math.round(el.getBoundingClientRect().top - top) : 0,
        foto: foto ? Math.round(foto.getBoundingClientRect().height) : -1 });
    })()`));
    // O paragrafo 30 no topo, com 30px dele ja passados
    const PARAGRAFO_30 = `(() => {
      const c = document.getElementById('preview-container');
      const p = [...c.children].find(e => e.textContent.startsWith('paragrafo 30 '));
      c.scrollTop += p.getBoundingClientRect().top - c.getBoundingClientRect().top + 30;
      return 'ok';
    })()`;
    const FOTO_NA_TELA = `window.__foto.chegou && document.querySelector('#preview-container img[data-embed]')?.naturalHeight > 0`;
    const abrirLonga = () => js(`__App.openFile('N3', 'longa.md'); 'ok'`);

    // Abre, espera a foto, e deixa o paragrafo 30 no topo. Devolve o que estava no topo ao sair.
    const lerAteOMeio = async (app, html) => {
      await open(buildPage('retomar', app, { html }));
      await js(`localStorage.clear(); 'ok'`);
      await js(APAGAR_BANCO);
      await js(DRIVE_DA_FOTO);
      await abrirLonga();
      await esperar(FOTO_NA_TELA, 3000);
      await sleep(300);
      await js(PARAGRAFO_30);
      await sleep(100);
      return noTopo();
    };

    const aoSair = await lerAteOMeio(currentApp);
    console.log('     ao sair:', JSON.stringify(aoSair));
    check('(o paragrafo 30 no topo, com a foto de cima ja na tela)', aoSair.texto === 'paragrafo 30' && aoSair.px === -30 && aoSair.foto > 500, aoSair);

    await js(`__App.goHome(); 'ok'`);
    await abrirLonga();
    await sleep(300);
    const voltou = await noTopo();
    console.log('     voltando pela home:', JSON.stringify(voltou));
    check('sair e voltar: o mesmo paragrafo, no mesmo ponto', voltou.texto === 'paragrafo 30' && Math.abs(voltou.px - aoSair.px) <= 2, voltou);

    // O app morto com a nota aberta (a pagina vai embora sem sair da nota) e aberto de novo: a foto
    // agora tem que vir do Drive outra vez, e demora
    await open(buildPage('retomar', currentApp));
    await js(DRIVE_DA_FOTO);
    await js(`window.__foto.atraso = 1500; 'ok'`);
    await abrirLonga();
    await sleep(250);
    const cedo = await noTopo();
    const fotoChegou = await js('window.__foto.chegou');
    console.log('     reaberto, foto a caminho:', JSON.stringify(cedo));
    check('app morto e aberto de novo: o mesmo paragrafo, com a foto de cima ainda a caminho',
      cedo.texto === 'paragrafo 30' && Math.abs(cedo.px - aoSair.px) <= 2 && !fotoChegou && cedo.foto < 100, { cedo, fotoChegou });
    await esperar(FOTO_NA_TELA, 4000);
    await sleep(300);
    const tarde = await noTopo();
    console.log('     depois de a foto chegar:', JSON.stringify(tarde));
    check('... e a foto crescendo em cima nao tira o paragrafo do lugar',
      tarde.foto > 500 && tarde.texto === 'paragrafo 30' && Math.abs(tarde.px - aoSair.px) <= 2, tarde);

    // Controle: o app de antes do card abre a mesma nota no topo, senao este cenario nao prova nada
    let appAntesDoRetomar = null;
    let htmlAntesDoRetomar = null;
    try {
      appAntesDoRetomar = execSync(`git -C "${ROOT}" show 7bed916:app.js`, { encoding: 'utf8', maxBuffer: 1e7, stdio: ['ignore', 'pipe', 'ignore'] });
      htmlAntesDoRetomar = indexAt('7bed916');
    } catch { /* shallow clone or no git: the control is skipped */ }
    if (appAntesDoRetomar) {
      await lerAteOMeio(appAntesDoRetomar, htmlAntesDoRetomar);
      await js(`__App.goHome(); 'ok'`);
      await abrirLonga();
      await sleep(300);
      const semOCard = await noTopo();
      check('controle: sem o card (7bed916), a nota reabre no topo', semOCard.texto === 'Longa', semOCard);
    } else {
      console.log('     (controle pulado: commit antigo indisponivel)');
    }
    await js(APAGAR_BANCO);
    await send('Emulation.clearDeviceMetricsOverride');

    console.log('19. Ler e Editar no mesmo trecho, com o CodeMirror de verdade');
    // O topo de cada modo e lido 16px abaixo da borda (App.VIEW_INSET), onde o texto comeca sem rolar
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const NOTA_TRECHO = '---\ncreated: 2026-09-01\nupdated: 2026-09-01\n---\n\n# Trecho\n\n'
      + Array.from({ length: 60 }, (_, i) => i === 20
        ? 'paragrafo longo ' + 'palavra '.repeat(400).trim()
        : 'paragrafo ' + i + ' ' + 'texto '.repeat((i % 7) * 6)).join('\n\n');
    const DRIVE_DO_TRECHO = `
      localStorage.clear();
      localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
      __App.accessToken = 'fake';
      window.__nota = ${JSON.stringify(NOTA_TRECHO)};
      window.fetch = async (url) => {
        const u = new URL(url);
        const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => o, arrayBuffer: async () => new TextEncoder().encode(o).buffer });
        if (u.searchParams.get('alt') === 'media') return ok(window.__nota);
        if (u.pathname.endsWith('/N4')) return ok({ id: 'N4', name: 'trecho.md', parents: ['F1'], modifiedTime: 't1' });
        return ok({ files: [] });
      };
      'ok'`;
    const nome = (s) => s.split(' texto')[0].split(' palavra')[0].trim();
    const leitura = async () => {
      const r = JSON.parse(await js(`(() => {
        const c = document.getElementById('preview-container');
        const probe = c.getBoundingClientRect().top + 16;
        const el = [...c.children].find(e => e.getBoundingClientRect().bottom > probe);
        return JSON.stringify({ texto: el.textContent, px: Math.round(el.getBoundingClientRect().top - probe) });
      })()`));
      return { texto: nome(r.texto), px: r.px };
    };
    const editor = async () => {
      const r = JSON.parse(await js(`(() => {
        const v = __App.Editor._impl.view;
        const top = v.scrollDOM.getBoundingClientRect().top;
        const b = v.lineBlockAtHeight(top + 16 - v.documentTop);
        const line = v.state.doc.lineAt(b.from);
        // Onde, dentro da linha, esta o que aparece na altura da leitura: 0 = comeco, 1 = fim
        const at = v.posAtCoords({ x: v.contentDOM.getBoundingClientRect().left + 40, y: top + 20 });
        return JSON.stringify({ texto: line.text, px: Math.round(v.coordsAtPos(line.from).top - (top + 16)),
          dentro: at == null ? -1 : Math.round((at - line.from) / Math.max(line.length, 1) * 100) / 100, foco: v.hasFocus });
      })()`));
      return { texto: nome(r.texto), px: r.px, dentro: r.dentro, foco: r.foco };
    };
    const tocarNoBotao = async () => {
      const r = JSON.parse(await js(`JSON.stringify(document.getElementById('btn-preview').getBoundingClientRect())`));
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: r.x + r.width / 2, y: r.y + r.height / 2, button: 'left', clickCount: 1 });
      }
      await sleep(500);
    };
    const leituraEm = (inicio, px = 0) => js(`(() => {
      const c = document.getElementById('preview-container');
      const p = [...c.children].find(e => e.textContent.startsWith(${JSON.stringify(inicio)}));
      c.scrollTop += p.getBoundingClientRect().top - (c.getBoundingClientRect().top + 16) + ${px};
      return 'ok';
    })()`);
    const abrirTrecho = async (app, html) => {
      await open(buildPage('trecho', app, { html }));
      await js(APAGAR_BANCO);
      await js(DRIVE_DO_TRECHO);
      await js(`__App.openFile('N4', 'trecho.md').then(() => 'ok')`);
      await sleep(200);
    };

    await abrirTrecho(currentApp);
    await leituraEm('paragrafo 30 ');
    const lendo = await leitura();
    check('(lendo, com o paragrafo 30 no topo)', lendo.texto === 'paragrafo 30' && lendo.px === 0, lendo);
    await tocarNoBotao();
    const editando = await editor();
    console.log('     Editar:', JSON.stringify(editando));
    check('Editar: o editor abre com o paragrafo 30 no topo', await js('__App.mode') === 'edit' && editando.texto === 'paragrafo 30' && Math.abs(editando.px) <= 3, editando);
    check('... sem pegar o foco, entao sem teclado', editando.foco === false, editando);

    await js(`(() => {
      const v = __App.Editor._impl.view;
      const line = [...Array(v.state.doc.lines).keys()].map(n => v.state.doc.line(n + 1)).find(l => l.text.startsWith('paragrafo 45 '));
      v.dispatch({ effects: CM6.EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 16 }) });
      return 'ok';
    })()`);
    await sleep(300);
    await tocarNoBotao();
    const lendoDeNovo = await leitura();
    console.log('     Ler:', JSON.stringify(lendoDeNovo));
    check('Ler: a leitura abre no paragrafo que estava no topo do editor', await js('__App.mode') === 'preview' && lendoDeNovo.texto === 'paragrafo 45' && Math.abs(lendoDeNovo.px) <= 3, lendoDeNovo);

    const idas = [];
    for (let i = 0; i < 3; i++) {
      await tocarNoBotao();
      await tocarNoBotao();
      idas.push(await leitura());
    }
    console.log('     tres idas e voltas:', JSON.stringify(idas));
    check('... e tres idas e voltas nao escorregam', idas.every(l => l.texto === 'paragrafo 45' && Math.abs(l.px - lendoDeNovo.px) <= 3), idas);

    // Um paragrafo de uma linha so, enorme: lido ate a metade, o editor abre na metade dele
    await js(`(() => {
      const c = document.getElementById('preview-container');
      const p = [...c.children].find(e => e.textContent.startsWith('paragrafo longo'));
      c.scrollTop += p.getBoundingClientRect().top - (c.getBoundingClientRect().top + 16) + p.getBoundingClientRect().height / 2;
      return 'ok';
    })()`);
    await tocarNoBotao();
    const noMeio = await editor();
    console.log('     paragrafo longo lido ate a metade:', JSON.stringify(noMeio));
    check('paragrafo enorme lido ate a metade: o editor abre perto da metade dele', noMeio.texto === 'paragrafo longo' && noMeio.dentro > 0.35 && noMeio.dentro < 0.65, noMeio);

    // Controle: a v48 abre o editor no topo da nota
    let appDaV48 = null;
    let htmlDaV48 = null;
    try {
      appDaV48 = execSync(`git -C "${ROOT}" show cf8d4f1:app.js`, { encoding: 'utf8', maxBuffer: 1e7, stdio: ['ignore', 'pipe', 'ignore'] });
      htmlDaV48 = indexAt('cf8d4f1');
    } catch { /* shallow clone or no git: the control is skipped */ }
    if (appDaV48) {
      await abrirTrecho(appDaV48, htmlDaV48);
      await leituraEm('paragrafo 30 ');
      await tocarNoBotao();
      const naV48 = await editor();
      check('controle: sem a fatia 2 (cf8d4f1), o Editar abre no topo da nota', naV48.texto === '---', naV48);
    } else {
      console.log('     (controle pulado: commit antigo indisponivel)');
    }
    await js(APAGAR_BANCO);
    await send('Emulation.clearDeviceMetricsOverride');

    console.log('20. Texto da interface nao seleciona; leitura, editor e campos continuam selecionando');
    // Chrome for Android's "Touch to Search" opens on a single tap that lands on selectable text outside
    // any focusable element. That bar does not exist in desktop Chrome or headless Edge, so what is proven
    // here is what it depends on: a double click (the desktop way of selecting a word) on interface text
    // selects nothing, while reading, the editor and the fields still select. The reading view is also
    // focusable now (tabindex="-1"), which is what keeps a single tap there out of the bar's rule: a click
    // focuses it, draws no outline, does not scroll it, and a link inside it still opens its note.
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    // Counts the clicks the page has seen, so that each read waits for the injected gesture to land
    const COUNT_CLICKS = `window.__clicks = { click: 0, dblclick: 0 };
      document.addEventListener('click', () => window.__clicks.click++, true);
      document.addEventListener('dblclick', () => window.__clicks.dblclick++, true); 'ok'`;
    // The middle of a word inside an element, on screen
    const wordAt = (selector, word) => js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        const i = node.data.indexOf(${JSON.stringify(word)});
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(node, i); range.setEnd(node, i + ${word.length});
        const b = range.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) });
      }
      return 'null';
    })()`).then(JSON.parse);
    const click = async ({ x, y }, count = 1) => {
      const before = Number(await js('window.__clicks.click'));
      for (let clickCount = 1; clickCount <= count; clickCount++) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount });
        }
      }
      // A double click is only over once its dblclick has fired: the word gets selected before that
      return esperar(count === 2 ? `window.__clicks.dblclick >= 1 && window.__clicks.click >= ${before + 2}`
        : `window.__clicks.click >= ${before + 1}`);
    };
    const userSelect = (selector) => js(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).userSelect`);
    const selected = () => js('getSelection().toString()');

    // Interface: the home screen text, where Touch to Search opened
    await open(buildPage('selecao', currentApp));
    await js(COUNT_CLICKS);
    const homeWord = await wordAt('#welcome p', 'pessoal');
    const homeClicked = await click(homeWord, 2);
    const homeSelection = await selected();
    check('duplo clique no texto da home nao seleciona nada', homeClicked === true && homeSelection === '', { homeClicked, homeSelection });
    const chrome = JSON.parse(await js(`JSON.stringify({ header: getComputedStyle(document.querySelector('.header')).userSelect,
      name: getComputedStyle(document.getElementById('file-name')).userSelect,
      title: getComputedStyle(document.querySelector('#welcome h2')).userSelect,
      body: getComputedStyle(document.body).userSelect })`));
    check('cabecalho, nome da nota e titulo da home: user-select none', Object.values(chrome).every(v => v === 'none'), chrome);

    // Reading: a long note, left in the middle
    await js(FAKE_DRIVE);
    await js(COUNT_CLICKS);
    // Only paragraph 20, the one left at the top of the screen, has "girassol": the word looked for is on screen
    const LONG_NOTE = '# Leitura\n\n' + Array.from({ length: 40 }, (_, i) => 'paragrafo ' + i + ' com texto corrido para ler'
      + (i === 20 ? ' e um girassol no meio' : '')).join('\n\n');
    await editNote(LONG_NOTE, 0, 0);
    await js(`__App.setMode('preview'); 'ok'`);
    await sleep(200);
    await js(`(() => {
      const c = document.getElementById('preview-container');
      const p = [...c.children].find(e => e.textContent.startsWith('paragrafo 20 '));
      c.scrollTop += p.getBoundingClientRect().top - c.getBoundingClientRect().top;
      return 'ok';
    })()`);
    await sleep(100);
    const preview = '#preview-container';
    check('a leitura e selecionavel (user-select text)', await userSelect(preview) === 'text', await userSelect(preview));
    check('a leitura tem tabindex="-1": focavel, fora da ordem do tab',
      await js(`document.getElementById('preview-container').getAttribute('tabindex')`) === '-1',
      await js(`document.getElementById('preview-container').getAttribute('tabindex')`));
    const scrollBefore = Number(await js(`document.getElementById('preview-container').scrollTop`));
    const readingWord = await wordAt(preview, 'girassol');
    await click(readingWord);
    await sleep(100);
    const afterTap = JSON.parse(await js(`(() => {
      const c = document.getElementById('preview-container');
      return JSON.stringify({ focused: document.activeElement === c, outline: getComputedStyle(c).outlineStyle,
        scroll: c.scrollTop, selection: getSelection().toString(), view: document.body.dataset.view });
    })()`));
    check('um toque na leitura foca o conteiner, sem contorno', afterTap.focused && afterTap.outline === 'none', afterTap);
    check('... sem rolar a leitura e sem selecionar nada', Math.abs(afterTap.scroll - scrollBefore) <= 1
      && afterTap.selection === '' && afterTap.view === 'preview', { scrollBefore, afterTap });
    await js(`window.__clicks.dblclick = 0; 'ok'`);
    await click(await wordAt(preview, 'girassol'), 2);
    const readingSelection = await selected();
    check('duplo clique numa palavra da leitura seleciona a palavra', readingSelection.trim() === 'girassol', readingSelection);
    check('... e a rolagem continua no mesmo lugar',
      Math.abs(Number(await js(`document.getElementById('preview-container').scrollTop`)) - scrollBefore) <= 1);

    // A link in the reading view still opens its note with a real click
    await js(`getSelection().removeAllRanges(); __App.openFile('N1', 'com link.md').then(() => 'ok')`);
    await esperar(`document.querySelector('#preview-container a.wikilink')`);
    await click(await wordAt('#preview-container a.wikilink', 'destino'));
    const followed = await esperar(`__App.currentFile && __App.currentFile.id === 'N2'`);
    check('um clique de verdade num [[link]] da leitura abre a nota', followed === true, await js('__App.currentFile && __App.currentFile.id'));

    // Editor: explicit user-select text, a real double click selects a word and lights the extract button,
    // typing replaces it, and the [[ list still opens
    await js(`__App.saveToRecents('N1', 'com link.md'); __App.saveToRecents('N2', 'destino.md'); 'ok'`);
    await editNote('uma palavra aqui\noutra linha', 1, 0);
    await sleep(100);
    check('o editor e selecionavel (user-select text no .cm-content)', await userSelect('.cm-editor .cm-content') === 'text',
      await userSelect('.cm-editor .cm-content'));
    await js(`window.__clicks.dblclick = 0; 'ok'`);
    await click(await wordAt('.cm-content', 'palavra'), 2);
    const lit = await esperar(`document.body.classList.contains('has-selection')`);
    const editorSelection = await js(`(() => { const v = __App.Editor._impl.view; const s = v.state.selection.main;
      return v.state.sliceDoc(s.from, s.to); })()`);
    check('duplo clique numa palavra do editor seleciona e acende o botao de extrair', lit === true && editorSelection.trim() === 'palavra',
      { lit, editorSelection });
    await send('Input.insertText', { text: 'termo' });
    const typed = await esperar(`__App.getContent().startsWith('uma termo')`);
    check('digitar por cima da selecao troca a palavra', typed === true, await js('__App.getContent()'));
    await send('Input.insertText', { text: ' [[' });
    const listed = await esperar(`document.querySelectorAll('.cm-tooltip-autocomplete li').length >= 2`);
    check('... e o [[ ainda abre a lista de notas', listed === true);

    // Fields: the rename box, opened by a real click on the note name, still selects a word
    await js(`__App.currentFile.name = 'nota de teste.md'; __App.updateFileNameDisplay(); 'ok'`);
    const nameBox = JSON.parse(await js(`JSON.stringify(document.getElementById('file-name').getBoundingClientRect())`));
    await click({ x: Math.round(nameBox.x + 10), y: Math.round(nameBox.y + nameBox.height / 2) });
    const renaming = await esperar(`document.getElementById('modal-overlay').classList.contains('visible')`);
    check('um clique no nome da nota abre o renomear', renaming === true);
    check('o campo e selecionavel (user-select text)', await userSelect('#modal-input') === 'text', await userSelect('#modal-input'));
    await js(`(() => { const i = document.getElementById('modal-input'); i.value = 'nota de teste'; i.setSelectionRange(0, 0); return 'ok'; })()`);
    const inputBox = JSON.parse(await js(`JSON.stringify(document.getElementById('modal-input').getBoundingClientRect())`));
    // "teste" starts at the 9th character: measured by a canvas with the field's own font, not guessed
    const inputWordX = Number(await js(`(() => {
      const i = document.getElementById('modal-input'); const s = getComputedStyle(i);
      const ctx = document.createElement('canvas').getContext('2d'); ctx.font = s.fontSize + ' ' + s.fontFamily;
      return i.getBoundingClientRect().left + parseFloat(s.paddingLeft) + parseFloat(s.borderLeftWidth)
        + ctx.measureText('nota de ').width + ctx.measureText('teste').width / 2;
    })()`));
    await js(`window.__clicks.dblclick = 0; 'ok'`);
    await click({ x: Math.round(inputWordX), y: Math.round(inputBox.y + inputBox.height / 2) }, 2);
    const inputSelection = await js(`(() => { const i = document.getElementById('modal-input'); return i.value.slice(i.selectionStart, i.selectionEnd); })()`);
    check('duplo clique no campo seleciona a palavra', inputSelection.trim().startsWith('teste'), inputSelection);
    await js('__App.hideModal(); "ok"');
    await send('Emulation.clearDeviceMetricsOverride');

    console.log('21. Guardar em… em largura de celular: cabe na tela, linha do tamanho de um dedo, o topo em tres linhas');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await open(buildPage('guardar', currentApp));
    // The Google Fonts sheet can hold the app back past open's fixed wait (see drive-notes-aprendizados, Testes)
    await esperar('window.__App', 15000);
    await js(`__App.inboxNotes = async () => [
      { id: 'I1', name: 'ideias-drive-notes.md' }, { id: 'I2', name: 'ideias-vault.md' }, { id: 'I3', name: 'ideias-projetos-genai.md' },
      { id: 'I4', name: 'config-notebook.md' }, { id: 'I5', name: 'nwn-new-character.md' } ];
      __App.hasValidToken = () => true;
      __App.openArrivalSheet({ id: 'z', at: 1, title: 'Um título bem comprido de página que o Chrome manda junto com o link, pra ver o corte',
        text: 'https://www.youtube.com/watch?v=abcdefghijk&t=120s&list=PLxyz', url: '', photos: [{}, {}] }).then(() => 'ok')`);
    const sheet = await js(`(() => {
      const modal = document.querySelector('#arrival-overlay .modal').getBoundingClientRect();
      const rows = [...document.querySelectorAll('#arrival-ul li')].map((li) => Math.round(li.getBoundingClientRect().height));
      const what = document.getElementById('arrival-what');
      const line = parseFloat(getComputedStyle(what).lineHeight);
      return { left: modal.left, right: modal.right, rows, whatLines: Math.round((what.clientHeight - 16) / line), pageWidth: document.documentElement.scrollWidth };
    })()`);
    check('a tela cabe nos 390px, sem rolar de lado', sheet.left >= 0 && sheet.right <= 390 && sheet.pageWidth <= 390, sheet);
    check('seis linhas (nota nova e cinco notas), cada uma com pelo menos 44px', sheet.rows.length === 6 && sheet.rows.every((h) => h >= 44), sheet.rows);
    check('o que chegou ocupa no maximo tres linhas', sheet.whatLines <= 3, sheet);
    await js(`__App.hideArrivalSheet(); 'ok'`);
    await send('Emulation.clearDeviceMetricsOverride');

    console.log('22. Toque longo de verdade: segurar o nome abre o sumario, dedo que anda nao, e o painel e tocavel');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await open(buildPage('sumario', currentApp));
    await esperar('window.__App', 15000);
    // Uma nota com titulos, aberta na leitura, sem Drive: o conteudo entra direto
    await js(`(() => { __App.currentFile = { id: 'T', name: 'uma nota com titulos.md' }; __App.setContent('# Um\\n\\ntexto\\n\\n## Dois\\n\\nmais');
      __App.showEditor(); __App.setMode('preview'); __App.updateFileNameDisplay(); return 'ok'; })()`);
    // O que a pagina viu, contado na janela em captura (antes do ouvinte do app, que engole o clique):
    // o toque chegou, o clique veio ou nao, e em quem caiu
    await js(`window.__renamed = 0; __App.promptRename = () => { window.__renamed++; };
      window.__seen = { start: 0, move: 0, end: 0, cancel: 0, clicks: [] };
      window.addEventListener('touchstart', () => window.__seen.start++, true);
      window.addEventListener('touchmove', () => window.__seen.move++, true);
      window.addEventListener('touchend', () => window.__seen.end++, true);
      window.addEventListener('touchcancel', () => window.__seen.cancel++, true);
      window.addEventListener('click', (e) => window.__seen.clicks.push(e.target.id || e.target.className || e.target.tagName), true); 'ok'`);
    const caixaNome = JSON.parse(await js(`JSON.stringify(document.getElementById('file-name').getBoundingClientRect())`));
    const cx = Math.round(caixaNome.x + caixaNome.width / 2), cy = Math.round(caixaNome.y + caixaNome.height / 2);
    const tocAberto = `document.getElementById('toc-overlay').classList.contains('visible')`;
    // Cada etapa espera a pagina dizer que viu o toque (fila do Input nao e a do Runtime.evaluate), e o
    // touchcancel que o navegador as vezes injeta faz a tentativa ser refeita, como no cenario 10
    const segurar = async (dx) => {
      let r = null;
      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        await js(`__App.closeToc(); window.__seen = { start: 0, move: 0, end: 0, cancel: 0, clicks: [] }; 'ok'`);
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy }] });
        await esperar('window.__seen.start >= 1', 4000);
        if (dx) {
          await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + dx, y: cy }] });
          await esperar('window.__seen.move >= 1', 4000);
        }
        // Parado: o app abre o sumario com o dedo ainda na tela. Andou: passado o tempo do toque longo
        // (contado depois de a pagina ver o movimento), nada abriu
        const abriu = dx ? (await sleep(800), await js(tocAberto)) : await esperar(tocAberto, 4000);
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await esperar('window.__seen.end + window.__seen.cancel >= 1', 4000);
        // O clique que o navegador manda depois de soltar (se mandar) vem logo atras do touchend
        await sleep(300);
        const seen = JSON.parse(await js('JSON.stringify(window.__seen)'));
        r = { abriu, seen, aberto: await js(tocAberto), renamed: Number(await js('window.__renamed')) };
        if (!seen.cancel) return r;
        console.log(`     (tentativa ${tentativa} do toque longo perdida: touchcancel)`, JSON.stringify(seen));
      }
      return r;
    };
    const parado = await segurar(0);
    console.log('     segurar parado:', JSON.stringify(parado));
    check('segurar o nome abre o sumario', parado.abriu === true && parado.aberto === true, parado);
    check('... e soltar nao renomeia (o clique, se vier, e engolido)', parado.renamed === 0, parado);
    const linha = JSON.parse(await js(`(() => { const b = document.querySelector('#toc-ul li').getBoundingClientRect();
      const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return JSON.stringify({ hit: !!el && !!el.closest('#toc-ul li'), h: b.height }); })()`));
    check('a primeira linha do sumario e tocavel e tem altura de dedo', linha.hit && linha.h >= 44, linha);
    const fechar = JSON.parse(await js(`(() => { const b = document.getElementById('toc-close').getBoundingClientRect();
      const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return JSON.stringify({ hit: !!el && !!el.closest('#toc-close'), bottom: b.bottom }); })()`));
    check('o Fechar e tocavel, dentro da tela', fechar.hit && fechar.bottom <= 844, fechar);
    // Esc e o voltar do CloseWatcher fora do Android (ver drive-notes-aprendizados, Testes)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    const fechouNoVoltar = await esperar(`!(${tocAberto})`, 4000);
    check('o voltar de verdade (Esc) fecha o sumario e fica na nota', fechouNoVoltar && await js(`__App.currentFile.id`) === 'T');
    const andou = await segurar(40);
    console.log('     dedo que anda:', JSON.stringify(andou));
    check('dedo que anda 40px nao abre', andou.abriu === false && andou.aberto === false, andou);
    // Um toque curto depois de um toque longo: renomeia como sempre (nada ficou preso pra engolir)
    await js(`window.__seen.clicks = []; 'ok'`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const renomeou = await esperar('window.__renamed >= 1', 4000);
    check('toque curto no nome, depois disso, renomeia', renomeou === true && !(await js(tocAberto)), JSON.parse(await js('JSON.stringify(window.__seen)')));
    console.log(`     o nome comeca em x=${Math.round(caixaNome.x)} (faixa do deslizar: ate 32px da borda)`);
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await send('Emulation.clearDeviceMetricsOverride');

    console.log('23. Espiar de verdade: segurar um link abre o cartao sem o menu do Chrome, rolar e deslizar em cima de um link nao');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await open(buildPage('espiar', currentApp));
    await esperar('window.__App', 15000);
    // Uma nota longa, com um link no comeco de cada paragrafo (o texto comeca em x=16, dentro da faixa
    // do deslizar), aberta na leitura. Sem Drive: a busca e o conteudo da nota do outro lado sao trocados
    const NOTA_COM_LINKS = Array.from({ length: 40 }, (_, i) => `[[Outra]] paragrafo ${i} com texto bastante pra ocupar a linha e um pouco mais`).join('\n\n');
    await js(`(() => {
      localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3)); __App.accessToken = 'fake';
      __App.findLinkedNote = async (target) => ({ base: target, note: { id: 'O', name: 'Outra.md' } });
      __App.driveGetFileContent = async () => '# Outra\\n\\ntexto da outra\\n\\n- [ ] uma tarefa';
      __App.currentFile = { id: 'T', name: 'com links.md' }; __App.setContent(${JSON.stringify(NOTA_COM_LINKS)});
      __App.showEditor(); __App.setMode('preview'); __App.updateFileNameDisplay(); __App.isDirty = false;
      window.__seen = { start: 0, move: 0, end: 0, cancel: 0 };
      window.addEventListener('touchstart', () => window.__seen.start++, true);
      window.addEventListener('touchmove', () => window.__seen.move++, true);
      window.addEventListener('touchend', () => window.__seen.end++, true);
      window.addEventListener('touchcancel', () => window.__seen.cancel++, true);
      // Registrado depois do app e em bolha: ve o menu do Chrome como ele chega, depois do ouvinte do app
      window.__ctx = null; document.addEventListener('contextmenu', (e) => { window.__ctx = e.defaultPrevented; });
      return 'ok'; })()`);
    const cartaoAberto = `document.getElementById('peek-overlay').classList.contains('visible')`;
    const topoDoLink = async () => {
      await js(`document.getElementById('preview-container').scrollTop = 0; 'ok'`);
      return JSON.parse(await js(`JSON.stringify(document.querySelector('#preview-container a.wikilink').getBoundingClientRect())`));
    };
    let caixaLink = await topoDoLink();
    const lx = Math.round(caixaLink.x + Math.min(caixaLink.width / 2, 30)), ly = Math.round(caixaLink.y + caixaLink.height / 2);
    const segurarLink = async () => {
      let r = null;
      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        await js(`__App.closePeek(); window.__ctx = null; window.__seen = { start: 0, move: 0, end: 0, cancel: 0 }; 'ok'`);
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: lx, y: ly }] });
        await esperar('window.__seen.start >= 1', 4000);
        const abriu = await esperar(cartaoAberto, 4000);
        // Dedo ainda na tela: o menu do Chrome, se vier, vem agora (medido: o Edge headless nao manda
        // contextmenu pra toque injetado, nem segurando 1,7s; o ouvinte e provado logo abaixo, direto)
        await sleep(400);
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await esperar('window.__seen.end + window.__seen.cancel >= 1', 4000);
        await sleep(300);
        const seen = JSON.parse(await js('JSON.stringify(window.__seen)'));
        r = { abriu, seen, aberto: await js(cartaoAberto), ctx: await js('window.__ctx'), file: await js('__App.currentFile && __App.currentFile.id'), view: await js('document.body.dataset.view') };
        if (!seen.cancel) return r;
        console.log(`     (tentativa ${tentativa} do toque longo perdida: touchcancel)`, JSON.stringify(seen));
      }
      return r;
    };
    const leituraAntes = Number(await js(`document.getElementById('preview-container').scrollTop`));
    const segurou = await segurarLink();
    console.log('     segurar o link:', JSON.stringify(segurou));
    check('segurar o link abre o cartao', segurou.abriu === true && segurou.aberto === true, segurou);
    check('... e soltar nao navega', segurou.file === 'T' && segurou.view === 'preview', segurou);
    check('... o menu do Chrome, se veio, chegou cancelado', segurou.ctx === null || segurou.ctx === true, segurou.ctx);
    // O menu e a selecao, no navegador de verdade: desligados no link de nota, e so nele
    const menu = JSON.parse(await js(`(() => {
      const c = document.getElementById('preview-container');
      const a = c.querySelector('a.wikilink'), p = c.querySelector('p');
      const ctx = (el) => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; };
      return JSON.stringify({ linkCtx: ctx(a), textCtx: ctx(p), linkSelect: getComputedStyle(a).userSelect, textSelect: getComputedStyle(p).userSelect }); })()`));
    check('menu do Chrome cancelado no link de nota, nao no texto; o link nao seleciona, o texto sim',
      menu.linkCtx === true && menu.textCtx === false && menu.linkSelect === 'none' && menu.textSelect === 'text', menu);
    const chegou = await esperar(`document.getElementById('peek-body').textContent.includes('texto da outra')`, 4000);
    check('o cartao mostra a nota do outro lado, com o nome no topo', chegou && await js(`document.getElementById('peek-title').textContent`) === 'Outra');
    // A regra dos campos dos dialogos (.modal input, largura cheia) nao pode esticar a caixinha da tarefa
    const caixinha = JSON.parse(await js(`JSON.stringify(document.querySelector('#peek-body li > input[type="checkbox"]').getBoundingClientRect())`));
    check('a caixinha de tarefa do cartao tem tamanho de caixinha, na linha do texto', caixinha.width < 30, caixinha);
    const botoes = JSON.parse(await js(`(() => { const hit = (id) => { const b = document.getElementById(id).getBoundingClientRect();
      const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return { hit: !!el && !!el.closest('#' + id), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
      const card = document.querySelector('#peek-overlay .modal').getBoundingClientRect();
      return JSON.stringify({ abrir: hit('peek-open'), fechar: hit('peek-close'), card: { top: Math.round(card.top), bottom: Math.round(card.bottom), h: Math.round(card.height) } }); })()`));
    console.log('     cartao:', JSON.stringify(botoes));
    check('o Abrir e o Fechar sao tocaveis, dentro da tela', botoes.abrir.hit && botoes.fechar.hit && botoes.abrir.bottom <= 844 && botoes.fechar.bottom <= 844, botoes);
    check('... e a leitura de baixo nao rolou', Number(await js(`document.getElementById('preview-container').scrollTop`)) === leituraAntes);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    check('o voltar de verdade (Esc) fecha o cartao e fica na nota', await esperar(`!(${cartaoAberto})`, 4000) && await js(`__App.currentFile.id`) === 'T');

    // Rolar a leitura com o dedo comecando em cima de um link: rola, e nenhum cartao
    let rolagem = null;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      caixaLink = await topoDoLink();
      await js(`__App.closePeek(); window.__seen = { start: 0, move: 0, end: 0, cancel: 0 }; 'ok'`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: lx, y: ly }] });
      for (let i = 1; i <= 10; i++) {
        await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: lx, y: ly - 8 * i }] });
        await sleep(16);
      }
      await esperar('window.__seen.move >= 10', 4000);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await esperar('window.__seen.end + window.__seen.cancel >= 1', 4000);
      // Passado o tempo do toque longo desde o comeco: nada abriu
      await sleep(800);
      const seen = JSON.parse(await js('JSON.stringify(window.__seen)'));
      rolagem = { seen, scrollTop: Number(await js(`document.getElementById('preview-container').scrollTop`)), aberto: await js(cartaoAberto) };
      if (!seen.cancel || rolagem.scrollTop > 0) break;
      console.log(`     (tentativa ${tentativa} da rolagem perdida: touchcancel)`, JSON.stringify(seen));
    }
    console.log('     rolar em cima do link:', JSON.stringify(rolagem));
    check('arrastar 80px pra cima comecando no link rola a leitura e nao abre cartao', rolagem.scrollTop > 0 && rolagem.aberto === false, rolagem);

    // Deslizar da borda comecando em cima de um link (o nome da nota comeca fora da faixa, ver o 22):
    // o deslizar volta e o cartao nao abre
    caixaLink = await topoDoLink();
    const naBorda = JSON.parse(await js(`(() => { const el = document.elementFromPoint(20, ${ly}); return JSON.stringify({ link: !!el && !!el.closest('#preview-container a.wikilink'), x: ${Math.round(caixaLink.x)} }); })()`));
    check('(o dedo em x=20 cai em cima do link)', naBorda.link, naBorda);
    let deslizou = null;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      await js(`__App.closePeek(); window.__seen = { start: 0, move: 0, end: 0, cancel: 0 }; 'ok'`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 20, y: ly }] });
      for (let i = 1; i <= 8; i++) {
        await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 20 + 130 * i / 8, y: ly }] });
        await sleep(16);
      }
      await esperar('__App._swipe && __App._swipe.armed === true', 4000);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const voltou = await esperar(`document.body.dataset.view === 'welcome'`, 4000);
      await sleep(800);
      const seen = JSON.parse(await js('JSON.stringify(window.__seen)'));
      deslizou = { voltou, seen, aberto: await js(cartaoAberto), view: await js('document.body.dataset.view') };
      if (voltou) break;
      console.log(`     (tentativa ${tentativa} do deslizar perdida)`, JSON.stringify(deslizou));
    }
    console.log('     deslizar da borda em cima do link:', JSON.stringify(deslizou));
    check('deslizar da borda comecando num link volta, e o cartao nao abre', deslizou.voltou === true && deslizou.aberto === false, deslizou);
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await send('Emulation.clearDeviceMetricsOverride');
  } finally {
    browser.close();
  }
  done();
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
