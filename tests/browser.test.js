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
  const { send, js, open, waitFor } = browser;
  try {
    const currentApp = appSource();
    // The index.html of an old commit, for a control that runs that commit's app: buildPage needs it
    // to find the app.js tag of the time (the working tree's index.html loads app/*.js instead)
    const indexAt = (commit) => execSync(`git -C "${ROOT}" show ${commit}:index.html`, { encoding: 'utf8', maxBuffer: 1e7, stdio: ['ignore', 'pipe', 'ignore'] });

    // CodeMirror's editable element, what TinyMDE called `editor.e`
    const CONTENT = `document.querySelector('.cm-content')`;

    // A position in CM6 is a single number, but the suite keeps speaking {row, col} as it always did:
    // the math lives here, and is not repeated in eight places. Careful: CM6's line counts from
    // 1, TinyMDE's counted from 0, and that is where the `+ 1` comes from.
    //
    // It is a piece of code, and not a ready call, so the caller can chain what comes
    // after in the same `js()`. That way moving the cursor and formatting are still a single trip to the
    // browser, as they were when TinyMDE's `setSelection` fit on the same line.
    const SELECT = (focus, anchor) => `(() => {
      const view = __App.Editor._impl.view;
      const pos = ({ row, col }) => view.state.doc.line(row + 1).from + col;
      view.dispatch({ selection: { anchor: pos(${JSON.stringify(anchor || focus)}), head: pos(${JSON.stringify(focus)}) } });
    })();`;
    const select = (focus, anchor) => js(`${SELECT(focus, anchor)} 'ok'`);

    const editNote = (content, row, col) => js(`__App.currentFile = { id: null, name: 't.md', draftKey: 'drivenotes_draft_t' };
      __App.setContent(${JSON.stringify(content)}); __App.showEditor(); __App.isDirty = false; __App.Editor.focus();
      ${SELECT({ row, col })} 'ok'`);

    // The same helper speaking TinyMDE. Only the historical control of scenario 1 uses this: it runs the
    // app of a commit from before the editor swap, and in that app the TinyMDE instance is the API.
    const editNoteTinyMDE = (content, row, col) => js(`__App.currentFile = { id: null, name: 't.md', draftKey: 'drivenotes_draft_t' };
      __App.setContent(${JSON.stringify(content)}); __App.showEditor(); __App.isDirty = false; __App.editor.e.focus();
      __App.editor.setSelection({ row: ${row}, col: ${col} }); 'ok'`);

    // ── 1. Voice typing: growing partial results inside one composition, then the final commit ──
    console.log('1. Ditado (composicao de IME) no CodeMirror');
    // `legacy` runs the historical control's half, on the app from before the editor swap
    const dictate = async (url, legacy) => {
      await open(url);
      await (legacy ? editNoteTinyMDE : editNote)('linha um\n', 1, 0);
      for (const partial of ['Não', 'Não consigo', 'Não consigo ditar', 'Não consigo ditar minhas']) {
        await send('Input.imeSetComposition', { text: partial, selectionStart: partial.length, selectionEnd: partial.length });
        await sleep(60);
      }
      await send('Input.insertText', { text: 'Não consigo ditar minhas notas' });
      await sleep(150);
      const onScreen = legacy ? '__App.editor.e' : CONTENT;
      return JSON.parse(await js(`JSON.stringify({ content: __App.getContent(), dom: ${onScreen}.innerText, dirty: __App.isDirty })`));
    };
    const expected = 'linha um\nNão consigo ditar minhas notas';

    let buggyApp = null;
    let buggyHtml = null;
    try {
      buggyApp = execSync(`git -C "${ROOT}" show ${COMMIT_WITH_DICTATION_BUG}:app.js`, { encoding: 'utf8', maxBuffer: 1e7, stdio: ['ignore', 'pipe', 'ignore'] });
      buggyHtml = indexAt(COMMIT_WITH_DICTATION_BUG);
    } catch { /* shallow clone or no git: the control is skipped */ }
    // The old app is pure TinyMDE: without the library it falls back to the textarea and the legacy
    // helper throws, taking down the scenario and the suite with it. Skipped is better than a false red.
    const hasTinyMDE = fs.existsSync(LIBS.tinymde);
    if (buggyApp && hasTinyMDE) {
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
    // CM6 leaves no stable class on the highlighting: the name comes out of its CSS generator (ͼo, ͼy) and changes
    // with every build. What proves the highlighting is the size that actually reached the screen, heading1's 1.5em
    // over the editor's 15px, in a <span> the markdown parser created inside the line.
    const headingHighlight = `[...${CONTENT}.querySelectorAll('span')]
      .some(s => s.textContent.includes('Titulo') && parseFloat(getComputedStyle(s).fontSize) > 20)`;
    check('a formatacao do editor volta a rodar no fim da composicao', await js(headingHighlight), await js(`${CONTENT}.innerHTML`));

    // ── 2. Formatting toolbar on the real CodeMirror ──
    console.log('2. Barra de formatacao no CodeMirror');
    await open(buildPage('current', currentApp));
    await editNote('primeira linha\nsegunda linha\nterceira', 1, 5);
    const format = async (name, focus, anchor) => {
      await js(`${SELECT(focus, anchor)} __App.applyFormat('${name}'); 'ok'`);
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
    // With no selection the link is born with the placeholder "texto" already selected, on purpose (task 6): on the
    // phone it is the visual hint of what to fill in, and whoever types next overwrites the placeholder
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
      ${CONTENT}.blur(); getSelection().removeAllRanges();
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
        // Wider than the editor on purpose: it is the only one that forces the app to measure the available
        // width, instead of falling back to the image's own size
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
    await select({ row: 5, col: 3 });
    await send('Input.insertText', { text: ' da nota' });
    await sleep(400);
    l = await lines();
    check('digitar em outra linha: imagens seguem la, texto certo', l[1].on && l[3].on && (await js('__App.getContent()')).endsWith('fim da nota'));
    check('... sem procurar de novo no Drive (nem a que sumiu)', Number(await js('window.__searches')) === searches, [searches, await js('window.__searches')]);

    await select({ row: 1, col: 0 });
    await send('Input.insertText', { text: 'x ' });
    await sleep(400);
    l = await lines();
    check('linha deixou de ser so o embed: imagem sai', !l[1].on && l[1].pad === 0 && l[3].on, l[1]);

    await js(`__App.setMode('preview'); __App.setMode('edit'); 'ok'`);
    await sleep(300);
    l = await lines();
    check('ir pro modo leitura e voltar mantem a imagem', l[3].on && l[3].bg, l[3]);

    // A photo wider than the editor: it is drawn at the width left on the line. The background
    // goes in with `auto var(--embed-h)`, so the drawn width is the height times the image's
    // ratio (4000x1000 = 4:1). Regression: measuring the clientWidth of .cm-content, which includes the
    // 16px inset on each side, the math came out 32px wider than the line and the photo came out cut on the
    // right (on a 390px phone, about 34px). Only this suite has real layout to see that.
    await editNote('![[gigante.png]]', 0, 0);
    await sleep(600);
    const drawing = JSON.parse(await js(`(() => {
      const el = document.querySelectorAll('.cm-line')[0];
      const height = parseFloat(getComputedStyle(el).getPropertyValue('--embed-h'));
      const scroller = el.closest('.cm-scroller');
      return JSON.stringify({ embed: el.classList.contains('embed-line'), drawn: height * 4, line: el.clientWidth,
        bar: scroller.offsetWidth - scroller.clientWidth, scrolls: scroller.scrollHeight > scroller.clientHeight });
    })()`));
    check('a foto desenhada cabe na largura real da linha, sem corte',
      drawing.embed && drawing.drawn <= drawing.line + 1 && drawing.drawn >= drawing.line - 4, drawing);

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
    await js(`__App.setMode('edit'); __App.Editor.focus(); ${SELECT({ row: 5, col: 5 })} 'ok'`);
    await send('Input.insertText', { text: ' novo' });
    await sleep(200);
    await js(`__App.save().then(() => 'ok')`);
    const dated = `---\ncreated: 2026-01-02\nupdated: ${today}\n---\n\ntexto novo`;
    // Where the cursor is, as line:column, which is how TinyMDE answered and how the scenario speaks
    const cursor = () => js(`(() => { const view = __App.Editor._impl.view;
      const head = view.state.selection.main.head; const line = view.state.doc.lineAt(head);
      return (line.number - 1) + ':' + (head - line.from); })()`);
    check('o Drive recebe o updated de hoje', JSON.parse(await js('JSON.stringify(window.__written)'))[0] === dated, await js('JSON.stringify(window.__written)'));
    check('com o teclado aberto o editor fica como esta, cursor no lugar', await js('__App.getContent()') === dated.replace(today, '2026-01-03') && await cursor() === '5:10', await cursor());
    const saveShown = () => js(`getComputedStyle(document.getElementById('btn-save')).display !== 'none'`);
    await js(`__App.setMode('preview'); 'ok'`);
    await sleep(200);
    check('leitura com tudo salvo: sem botao de salvar', await saveShown() === false);
    check('na leitura o editor alcanca o Drive e a nota segue limpa', await js('__App.getContent()') === dated && await js('__App.isDirty') === false, await js('__App.getContent()'));
    await js(`__App.save().then(() => 'ok')`);
    check('sem escrita extra', Number(await js('window.__written.length')) === 1);

    await js(`__App.setMode('edit'); __App.Editor.focus(); ${SELECT({ row: 5, col: 10 })} 'ok'`);
    await send('Input.insertText', { text: '!' });
    await sleep(200);
    await js(`__App.setMode('preview'); 'ok'`);
    check('leitura com texto por salvar: o botao de salvar aparece', await saveShown() === true);
    await js(`document.getElementById('btn-save').click(); 'ok'`);
    await sleep(300);
    check('... salva dali mesmo e some de novo', Number(await js('window.__written.length')) === 2 && await saveShown() === false, await js('window.__written.length'));

    // ── Drawing: a real canvas, with dpr, round tip, eraser and crop ──
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

    // ── The discard dialog has to take the finger, not only be "visible" ──
    console.log('8. Desenho: o dialogo de descartar e alcancavel pelo dedo');
    await open(buildPage('sketch-dialogo', currentApp));
    await js(FAKE_DRIVE);
    await editNote('linha um\n', 0, 8);
    const dialog = JSON.parse(await js(`(() => {
      __App.setMode('edit');
      document.querySelector('.toolbar-btn[data-sketch]').click();
      const c = __App.sketch.canvas;
      const r = c.getBoundingClientRect();
      for (const type of ['pointerdown', 'pointerup']) {
        c.dispatchEvent(new PointerEvent(type, { clientX: 100, clientY: r.top + 100, pointerId: 1, bubbles: true, cancelable: true }));
      }
      document.getElementById('sketch-cancel').click();

      // elementFromPoint answers what the finger would really hit, and not what the class says
      const hit = (el) => {
        const b = el.getBoundingClientRect();
        const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return el === top || el.contains(top);
      };
      const ok = document.getElementById('confirm-ok');
      const cancel = document.getElementById('confirm-cancel');
      return JSON.stringify({
        visible: document.getElementById('confirm-overlay').classList.contains('visible'),
        okReachable: hit(ok),
        cancelReachable: hit(cancel),
        overOk: (() => { const b = ok.getBoundingClientRect(); const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return t ? (t.id || t.className || t.tagName) : null; })(),
      });
    })()`));
    check('o dialogo abre', dialog.visible, dialog);
    check('o dedo alcanca o "Descartar"', dialog.okReachable, dialog);
    check('o dedo alcanca o "Cancelar"', dialog.cancelReachable, dialog);

    // ── Task: a real click on the box, with CodeMirror keeping the text ──
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
    check('na edicao o editor mostra o [x]', (await js(`${CONTENT}.textContent`)).includes('- [x] Banguela'), await js(`${CONTENT}.textContent`));

    // ── Edge swipe: a real touch, on a phone screen, with the real CloseWatcher ──
    console.log('10. Deslizar da borda com toque de verdade');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await open(buildPage('swipe', currentApp));
    await js(FAKE_DRIVE);
    await js(`__App.browseVault().then(() => 'ok')`);
    await js(`[...document.querySelectorAll('.browser-item')].find(li => li.textContent.includes('com link')).click(); 'ok'`);
    await waitFor(`__App.currentFile && __App.currentFile.id === 'N1'`);
    await js(`document.querySelector('#preview-container a.wikilink').click(); 'ok'`);
    await waitFor(`__App.currentFile && __App.currentFile.id === 'N2' && __App.navStack.length === 3`);
    // This scenario was the only one that read the state by the clock (`sleep(400)` after letting go), and it was
    // the only flaky one. Two things separate the injected touch from what the app saw:
    //
    // 1. `Input.dispatchTouchEvent` comes in through a browser queue that is NOT the one of
    //    `Runtime.evaluate`. With the headless renderer stalled (measured: five seconds between the
    //    touch and the app reacting), the read timed by the clock arrives before the app sees the gesture.
    //    That is why each step now waits for the app to say it saw, with `waitFor`.
    // 2. The browser sometimes sends `touchcancel` in the middle of the injected sequence, and the app does the
    //    right thing: it abandons the gesture (`endSwipe`, without acting). That is an artifact of the injection, not of the app,
    //    so the drag is redone, up to three times, and only what is left becomes a check.
    //
    // The signal waited for is always EARLIER than what the checks look at (they look at the arrow's class, rectangle
    // and color, and the file/stack pair after the gesture): the wait is for the app's `_swipe.armed` and for the
    // stack to change. If the arrow stops being painted or the gesture stops navigating, it goes red.
    await js(`window.__cancelled = 0; document.addEventListener('touchcancel', () => window.__cancelled++, true); 'ok'`);
    const GESTURE_LIMIT = 4000;
    const drag = async (x0, x1, y, shot) => {
      let hint = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const stackBefore = Number(await js('__App.navStack.length'));
        await js('window.__cancelled = 0; "ok"');
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
        for (let i = 1; i <= 8; i++) {
          await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / 8, y }] });
          await sleep(16);
        }
        // `armed` and not the full pull: the browser merges moves from the same frame and the last one
        // sometimes does not arrive (measured: `pull` stopping at 119 of the 136 dragged). What decides the gesture,
        // at the moment of letting go, is having passed the trigger, and that is what the app notes here.
        const armed = await waitFor(`__App._swipe && __App._swipe.armed === true`, GESTURE_LIMIT);
        // The mid-gesture screenshot only on the first attempt: capturing a frame with the finger on the screen is
        // one of the ways of provoking the `touchcancel` that makes the attempt be redone
        if (shot && attempt === 1) {
          const { data } = (await send('Page.captureScreenshot', { format: 'png' })).result;
          fs.mkdirSync(path.join(ROOT, 'tests', '.tmp'), { recursive: true });
          fs.writeFileSync(path.join(ROOT, 'tests', '.tmp', shot), Buffer.from(data, 'base64'));
        }
        hint = JSON.parse(await js(`(() => { const h = document.getElementById('swipe-hint'); const b = h.getBoundingClientRect();
          return JSON.stringify({ visible: h.classList.contains('visible'), armed: h.classList.contains('armed'), left: b.left, right: b.right, bg: getComputedStyle(h).backgroundColor }); })()`));
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        let navigated = await waitFor(`__App._swipe === null && __App.navStack.length !== ${stackBefore}`, GESTURE_LIMIT);
        // One last direct read: the limit may have run out right at the turn
        if (!navigated) navigated = Number(await js('__App.navStack.length')) !== stackBefore;
        if (armed && navigated) return hint;
        console.log(`     (tentativa ${attempt} do gesto perdida: armado=${armed} navegou=${navigated}`
          + ` touchcancel=${await js('window.__cancelled')})`);
      }
      return hint;
    };
    let arrow = await drag(4, 140, 400, 'swipe-voltar.png');
    v = await view();
    check('a seta sai da borda esquerda, inteira na tela e roxa', arrow.visible && arrow.armed && arrow.left >= 0 && arrow.bg === 'rgb(139, 108, 239)', arrow);
    check('soltar volta pra nota anterior', v.file === 'N1' && v.stack === 2, v);
    arrow = await drag(386, 250, 400, 'swipe-avancar.png');
    v = await view();
    check('a seta sai da borda direita', arrow.visible && arrow.armed && arrow.right <= 390, arrow);
    check('soltar avanca pra nota do link', v.file === 'N2' && v.stack === 3, v);
    await drag(4, 140, 400);
    await drag(4, 140, 400);
    v = await view();
    check('mais dois deslizes da esquerda: volta ate a pasta',v.view === 'browse' && v.folder === 'ROOT', v);
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await send('Emulation.clearDeviceMetricsOverride');

    // ── The formatting toolbar really scrolls sideways ──
    console.log('11. A barra de formatacao rola de lado de verdade');
    // Phone width: headless Edge does not open a small window, so it is a metrics override
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 2, mobile: true });
    await open(buildPage('toolbar-scroll', currentApp));
    // The bar only exists in the CSS with body[data-view="edit"]; on a freshly opened page (welcome
    // screen) it is display:none and the measure comes out all zeros, which was measured on the first
    // run (RED) and is not the "the buttons shrink" the brief expected
    await editNote('linha um\nlinha dois', 0, 0);
    const measure = await js(`(() => {
      const bar = document.querySelector('.toolbar');
      const button = bar.querySelector('.toolbar-btn');
      return {
        content: bar.scrollWidth,
        visible: bar.clientWidth,
        buttonWidth: Math.round(button.getBoundingClientRect().width),
        buttonHeight: Math.round(button.getBoundingClientRect().height),
      };
    })()`);
    check('o conteudo da barra e mais largo que a tela, entao ela rola',
      measure.content > measure.visible, measure);
    check('o alvo de dedo tem pelo menos 44px', measure.buttonWidth >= 44, measure);

    // ── Dragging the finger ON TOP of a button scrolls the bar ──
    // The app cancelled the start of the touch on the buttons (so as not to steal the editor's focus and close the
    // keyboard) and with that killed the pan: what was left was the 6px gap between the buttons and the edge of the
    // bar, which is the "something very thin" of the report. Only here can the opposite be proven, because what
    // scrolls is the browser, and jsdom scrolls nothing.
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    const target = await js(`(() => {
      // The target has to be on the 360px screen before the bar scrolls: the quote button was, with 11
      // buttons; with 18 it sits past the edge and a touch out there lands on nothing (v37)
      const b = document.querySelector('.toolbar-btn[data-format="wikilink"]').getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), right: Math.round(b.right) };
    })()`);
    const textBefore = await js('__App.Editor.getText()');
    let scrolled = false;
    // An injected touch comes in through a queue different from the read, and the browser sometimes gives up on the
    // gesture halfway (the touchcancel of scenario 10): the drag is redone up to three times
    for (let attempt = 1; attempt <= 3 && !scrolled; attempt++) {
      await js('document.querySelector(".toolbar").scrollLeft = 0; "ok"');
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y }] });
      for (let i = 1; i <= 8; i++) {
        await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: target.x - i * 12, y: target.y }] });
        await sleep(16);
      }
      scrolled = await waitFor('document.querySelector(".toolbar").scrollLeft > 20', 3000);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      if (!scrolled) console.log(`     (tentativa ${attempt} de rolar a barra perdida)`);
    }
    check('o botao alvo do arrasto esta na tela (senao o toque cai no nada)', target.right <= 360, target);
    check('o dedo arrastado em cima de um botao rola a barra', scrolled,
      await js('document.querySelector(".toolbar").scrollLeft'));
    check('e o arrasto nao formatou nada: rolar nao e tocar',
      await js('__App.Editor.getText()') === textBefore, await js('__App.Editor.getText()'));
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await send('Emulation.clearDeviceMetricsOverride');

    // ── The properties block and the brackets that are not links come out as plain text ──
    console.log('12. Propriedades e colchetes como texto comum');
    // Only here can it be proven: the assertion is about computed style (size, weight, color and underline that
    // actually reached the screen), and that needs layout. CM6 leaves no stable class on the
    // highlighting (the name comes out of its CSS generator and changes with every build), so there is no class to
    // look for: what counts is the pixel.
    await open(buildPage('texto-comum', currentApp));
    const PROPS_NOTE = '---\ncreated: 2026-09-21\nupdated: 2026-09-21\ntags: [casa, obra]\n---\n\n'
      + '# Titulo grande\n\nvai [[destino]] e [link](http://x)\n\n> [!note] aviso e mais texto';
    await editNote(PROPS_NOTE, 8, 0);
    const PURPLE = 'rgb(166, 141, 255)';   // --accent-hover, the purple that writes

    // The line and each <span> the highlighting created inside it
    const styles = (i) => js(`(() => {
      const el = [...document.querySelectorAll('.cm-line')][${i}];
      return JSON.stringify([el, ...el.querySelectorAll('span')].map(a => {
        const s = getComputedStyle(a);
        return { txt: a.textContent, px: Math.round(parseFloat(s.fontSize)), weight: Number(s.fontWeight),
          color: s.color, decoration: s.textDecorationLine };
      }));
    })()`).then(JSON.parse);

    // The note's plain text, measured and not guessed: it is what the block has to look like
    const plain = (await styles(8))[0];
    const sameAsPlain = (p) => p.px === plain.px && p.weight === plain.weight && p.color === plain.color && p.decoration === 'none';
    const block = [].concat(...await Promise.all([0, 1, 2, 3, 4].map(styles)));
    check('o bloco de propriedades inteiro sai do tamanho, do peso e da cor do texto comum',
      block.length >= 6 && block.every(sameAsPlain), block.filter(p => !sameAsPlain(p)));

    // Control: if the rule had leaked out of the block, the real heading would fade too
    const heading = await styles(6);
    check('titulo de verdade fora do bloco continua grande, negrito e roxo',
      heading.some(p => p.px > plain.px && p.weight > plain.weight && p.color === PURPLE), heading);

    // `[[wikilink]]`, `[!note]` and `tags: [a, b]`: the parser reads all three as a reference link with no
    // destination. The check looks at the whole set (the decoration span and the highlighting ones inside it),
    // because it is in the inner ones that the color and the underline live
    const bracket = (stretch) => js(`(() => {
      const mark = [...document.querySelectorAll('.cm-content .plain-brackets')]
        .find(s => s.textContent === ${JSON.stringify(stretch)});
      if (!mark) return JSON.stringify({ found: false });
      const inside = [mark, ...mark.querySelectorAll('span')].map(e => getComputedStyle(e));
      const neighbor = [...mark.closest('.cm-line').querySelectorAll('span')]
        .find(s => s.textContent.includes('aviso'));
      return JSON.stringify({
        found: true,
        colors: [...new Set(inside.map(s => s.color))],
        decorations: [...new Set(inside.map(s => s.textDecorationLine))],
        lineColor: getComputedStyle(mark.closest('.cm-line')).color,
        neighborColor: neighbor ? getComputedStyle(neighbor).color : null,
      });
    })()`).then(JSON.parse);

    const wiki = await bracket('[destino]');
    check('[[wikilink]]: uma cor so, a do texto em volta, e sem sublinhado',
      wiki.found && wiki.colors.length === 1 && wiki.colors[0] === wiki.lineColor
      && wiki.colors[0] !== PURPLE && wiki.decorations.every(r => r === 'none'), wiki);

    const tags = await bracket('[casa, obra]');
    check('tags: [a, b] no bloco de propriedades: sem roxo e sem sublinhado',
      tags.found && tags.colors.length === 1 && tags.colors[0] !== PURPLE && tags.decorations.every(r => r === 'none'), tags);

    // Inside a quote the highlighting paints each piece of the line in a sibling span, so the `[!note]`
    // comes out in the plain text color and not in the faded color of the quote around it (measured, and noted in
    // style.css): it is plain text, just a shade lighter than the quote. What must not happen is the underlined
    // purple from before
    const callout = await bracket('[!note]');
    check('[!note] dentro da citacao sai como texto comum, sem roxo e sem sublinhado',
      callout.found && callout.colors.length === 1 && callout.colors[0] === plain.color
      && callout.colors[0] !== PURPLE && callout.neighborColor !== PURPLE
      && callout.decorations.every(r => r === 'none'), callout);

    // The control's control: a real link was not faded along with them
    const link = JSON.parse(await js(`(() => {
      const spans = [...document.querySelectorAll('.cm-content span')].filter(s => s.textContent === 'link');
      const s = getComputedStyle(spans[spans.length - 1]);
      return JSON.stringify({ color: s.color, decoration: s.textDecorationLine });
    })()`));
    check('[texto](url), que e link de verdade, continua roxo e sublinhado',
      link.color === PURPLE && link.decoration === 'underline', link);

    console.log('13. A lista de notas do [[ na tela, e o toque num item');
    // Only here can it be proven: in jsdom CM6's tooltip exists in the state, but it has no position and
    // takes no touch (getBoundingClientRect returns zeros). What matters in this scenario is what the
    // finger sees and what the finger does: the list drawn, and the tapped item writing the link WITHOUT taking the
    // focus from the editor, which on the phone is what decides whether the keyboard closes (see drive-notes-aprendizados).
    await open(buildPage('link-list', currentApp));
    await js(FAKE_DRIVE);
    // With nothing typed after the [[ the list shows the recents: without them there would be nothing to draw
    await js(`__App.saveToRecents('N1', 'com link.md'); __App.saveToRecents('N2', 'destino.md'); 'ok'`);
    await editNote('vai ', 0, 4);
    // Through the keyboard path, and not through a dispatch on the state: it is the browser's `input` that triggers the
    // list's activateOnTyping, and that is the path the phone uses
    await send('Input.insertText', { text: '[[' });
    const items = `[...document.querySelectorAll('.cm-tooltip-autocomplete li')]`;
    const appeared = await waitFor(`${items}.length >= 2`);
    check('digitar [[ desenha a lista na tela, com as recentes', appeared === true,
      await js(`JSON.stringify(${items}.map(li => li.textContent))`));

    await send('Input.insertText', { text: 'de' });
    const filtered = await waitFor(`${items}.length === 1 && ${items}[0].textContent.includes('destino')`);
    check('digitar filtra ate sobrar destino', filtered === true, await js(`JSON.stringify(${items}.map(li => li.textContent))`));

    // The app's chrome over the library's: the @codemirror/autocomplete theme sets
    // `font-family: monospace` on the list (it is the same selector style.css uses, so whichever comes
    // later wins). If the app's CSS does not apply, the list comes out white and in a code font.
    const listChrome = JSON.parse(await js(`(() => {
      const box = document.querySelector('.cm-tooltip-autocomplete');
      const ul = box.querySelector('ul'); const li = ul.querySelector('li');
      return JSON.stringify({ font: getComputedStyle(ul).fontFamily, background: getComputedStyle(box).backgroundColor,
        height: Math.round(li.getBoundingClientRect().height), padding: getComputedStyle(li).paddingLeft,
        detail: getComputedStyle(li.querySelector('.cm-completionDetail')).fontSize });
    })()`));
    check('a lista veste o cromo do app: fonte de interface, fundo escuro, item de 44px e a pasta em letra menor',
      listChrome.font.includes('Figtree') && !listChrome.font.includes('monospace')
      && listChrome.background === 'rgb(36, 34, 41)' && listChrome.height >= 44 && listChrome.padding === '14px'
      && listChrome.detail === '12px', listChrome);

    // The screenshot in the middle: the list open, with the app's chrome
    {
      const { data } = (await send('Page.captureScreenshot', { format: 'png' })).result;
      fs.mkdirSync(path.join(ROOT, 'tests', '.tmp'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'tests', '.tmp', 'link-list-aberta.png'), Buffer.from(data, 'base64'));
    }

    const item = JSON.parse(await js(`(() => { const b = ${items}[0].getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }); })()`));
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: item.x, y: item.y, button: 'left', clickCount: 1 });
    }
    const picked = await waitFor(`__App.getContent() === 'vai [[destino]]'`);
    check('tocar no item escreve o link e fecha a lista',
      picked === true && await js(`!document.querySelector('.cm-tooltip-autocomplete')`) === true,
      await js('__App.getContent()'));
    check('o foco continua no editor: no celular, o teclado nao fecharia',
      await js(`document.activeElement === document.querySelector('.cm-content')`) === true,
      await js(`document.activeElement ? document.activeElement.className : null`));

    console.log('14. O botao de extrair: gruda na ponta direita da barra e recebe o toque');
    // Only here can it be proven: the sticky, the color and the finger target need layout. "It is visible" and
    // "it can be tapped" are different questions, and the one that answers the second is elementFromPoint
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 2, mobile: true });
    await open(buildPage('extract-button', currentApp));
    await js(FAKE_DRIVE);
    await editNote('uma linha\noutra linha', 0, 0);
    await select({ row: 0, col: 9 }, { row: 0, col: 0 });
    const extractLit = await waitFor(`document.body.classList.contains('has-selection')`);
    check('texto selecionado acende o botao', extractLit === true);
    const measureExtract = () => js(`(() => {
      const b = document.querySelector('.toolbar-btn[data-extract]').getBoundingClientRect();
      const t = document.querySelector('.toolbar-btn[data-format="checklist"]').getBoundingClientRect();
      const x = Math.round(b.left + b.width / 2), y = Math.round(b.top + b.height / 2);
      const atPoint = document.elementFromPoint(x, y);
      return JSON.stringify({ x, y, left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width),
        receives: !!atPoint && !!atPoint.closest('[data-extract]'), taskLeft: Math.round(t.left), taskRight: Math.round(t.right) });
    })()`).then(JSON.parse);

    await js('document.querySelector(".toolbar").scrollLeft = 0; "ok"');
    const atStart = await measureExtract();
    check('barra no comeco: o botao esta na tela, com 44px, e o toque cai nele',
      atStart.width >= 44 && atStart.right <= 360 && atStart.receives, atStart);
    await js('document.querySelector(".toolbar").scrollLeft = 1e6; "ok"');
    await sleep(100);
    const atEnd = await measureExtract();
    check('barra rolada ate o fim: continua na tela e recebendo o toque',
      atEnd.width >= 44 && atEnd.right <= 360 && atEnd.receives, atEnd);
    check('... e a tarefa, ultima da fila, aparece inteira antes dele',
      atEnd.taskLeft >= 0 && atEnd.taskRight <= atEnd.left, atEnd);

    // The bar's only filled button: --accent #8b6cef fills, --bg-primary #1c1b1f on top
    // (identidade-visual: on a colored fill, what sits on top is dark)
    const extractColors = JSON.parse(await js(`(() => { const s = getComputedStyle(document.querySelector('.toolbar-btn[data-extract]'));
      return JSON.stringify({ background: s.backgroundColor, ink: s.color }); })()`));
    check('o botao cheio: fundo --accent e icone --bg-primary',
      extractColors.background === 'rgb(139, 108, 239)' && extractColors.ink === 'rgb(28, 27, 31)', extractColors);
    {
      const { data } = (await send('Page.captureScreenshot', { format: 'png' })).result;
      fs.mkdirSync(path.join(ROOT, 'tests', '.tmp'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'tests', '.tmp', 'extrair-botao.png'), Buffer.from(data, 'base64'));
    }

    await js('document.querySelector(".toolbar").scrollLeft = 0; "ok"');
    const extractTarget = await measureExtract();
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: extractTarget.x, y: extractTarget.y, button: 'left', clickCount: 1 });
    }
    const opened = await waitFor(`document.getElementById('modal-overlay').classList.contains('visible')
      && document.getElementById('modal-input').value === 'uma-linha'`);
    check('o toque abre a caixa com o nome sugerido', opened === true, await js(`document.getElementById('modal-input').value`));
    await js('__App.hideModal(); "ok"');
    await send('Emulation.clearDeviceMetricsOverride');

    console.log('15. Nota guardada no aparelho: reabre na hora com a pagina recarregada, e troca sem perder a rolagem');
    // Only here: the real IndexedDB (jsdom uses fake-indexeddb), the page reloaded like the app
    // Android killed, and the scrolling, which needs layout
    const NOTE_DRIVE = `
      localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
      __App.accessToken = 'fake';
      window.__drive = { delay: 0, mt: 't1', text: null,
        longNote: '# Destino\\n\\n' + Array.from({ length: 150 }, (_, i) => 'linha ' + i).join('\\n\\n') };
      window.fetch = async (url) => {
        const u = new URL(url);
        const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => o, arrayBuffer: async () => new TextEncoder().encode(o).buffer });
        await new Promise(r => setTimeout(r, window.__drive.delay));
        if (u.searchParams.get('alt') === 'media') return ok(window.__drive.text || window.__drive.longNote);
        if (/files\\/N2$/.test(u.pathname)) return ok({ id: 'N2', name: 'destino.md', parents: ['F1'], modifiedTime: window.__drive.mt });
        return ok({ files: [] });
      };
      'ok'`;
    const WIPE_DB = `new Promise(r => { const q = indexedDB.deleteDatabase('drivenotes'); q.onsuccess = q.onerror = q.onblocked = () => r('ok'); })`;

    await open(buildPage('nota-guardada', currentApp));
    await js(WIPE_DB);
    await js(NOTE_DRIVE);
    await js(`__App.openFile('N2', 'destino.md').then(() => 'ok')`);
    await sleep(300);
    const kept = await js(`__App.NoteStore.get('N2').then(e => !!e && e.content.includes('linha 149'))`);
    check('abrir do Drive guardou a nota no IndexedDB de verdade (em file://)', kept === true);

    // The reloaded page is the app Android killed: memory wiped, the device with what it kept
    await open(buildPage('nota-guardada', currentApp));
    await js(NOTE_DRIVE);
    await js(`window.__drive.delay = 1500; 'ok'`);
    await js(`__App.openFile('N2', 'destino.md'); 'ok'`);
    // A name of its own: `appeared` already belongs to scenario 13, in the same scope
    const appearedKept = await waitFor(`document.getElementById('preview-container').textContent.includes('linha 149')`, 1000);
    check('recarregada a pagina, a nota aparece com o Drive ainda calado', appearedKept === true);
    const logLine = await js(`__App._log.find(l => l.includes('cached destino.md')) || ''`);
    const ms = Number(/cached destino\.md (\d+)ms/.exec(logLine)?.[1]);
    console.log('     medida do app:', logLine.split(' | ')[0]);
    check('... em menos de 200ms, pela medida do proprio app', ms < 200, logLine);
    await sleep(1800); // this opening's check finishes ("same")

    // Changed on the Drive: the stored one shows up, scrolls, and the new one arrives without touching the scroll
    await js(`window.__drive.delay = 400; window.__drive.mt = 't2';
      window.__drive.text = window.__drive.longNote + '\\n\\nlinha nova do PC'; 'ok'`);
    await js(`__App.openFile('N2', 'destino.md'); 'ok'`);
    await sleep(100);
    await js(`document.getElementById('preview-container').scrollTop = 1500; 'ok'`);
    const topBefore = await js(`document.getElementById('preview-container').scrollTop`);
    const swapped = await waitFor(`document.getElementById('preview-container').textContent.includes('linha nova do PC')`, 3000);
    const topAfter = await js(`document.getElementById('preview-container').scrollTop`);
    console.log(`     rolagem antes da troca ${topBefore}, depois ${topAfter}`);
    check('mudou no Drive: trocou sozinha, com o aviso',
      swapped === true && await js(`document.getElementById('save-status').textContent`) === 'Atualizada do Drive');
    check('... sem perder a rolagem', topBefore > 0 && Math.abs(topAfter - topBefore) <= 2, { topBefore, topAfter });
    await js(WIPE_DB);

    console.log('16. Leitura: lista que vem depois de outra lista abre o mesmo respiro que um grupo');
    // The note from Agatha's screenshots of 20 Sep 2026: tasks in two groups, a numbered list, a bulleted
    // one with a sublist. A group inside the same list already opened the gap (li.gap, v28); the next
    // list stuck to the previous one. Measured in pixels, which only the browser has
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await open(buildPage('listas', currentApp));
    await js(FAKE_DRIVE);
    await editNote('- [x] Lady\n- [x] Banguela\n- [x] Chloe\n- [x] Gucci\n\n- [x] Agatha\n- [x] Victor\n- [x] Ceiça\n\n'
      + '1. Wicked\n2. Hadestown\n3. The Phantom of The Opera\n\n\n- Agatha\n  - Lady\n  - Gucci\n', 0, 0);
    await js(`__App.setMode('preview'); 'ok'`);
    await sleep(200);
    const lists = JSON.parse(await js(`(() => {
      const items = [...document.querySelectorAll('#preview-container li')];
      const li = (text) => items.find(el => el.firstChild && el.textContent.trim().startsWith(text) && !el.closest('li li'));
      const between = (a, b) => Math.round(li(b).getBoundingClientRect().top - li(a).getBoundingClientRect().bottom);
      return JSON.stringify({
        sameGroup: between('Lady', 'Banguela'),
        group: between('Gucci', 'Agatha'),
        taskToNumbered: between('Ceiça', 'Wicked'),
        numberedToBullet: between('The Phantom', 'Agatha\\n'),
      });
    })()`));
    console.log('     distancias em px:', JSON.stringify(lists));
    check('itens do mesmo grupo continuam juntos', lists.sameGroup < 10, lists);
    check('tarefas seguidas de numerada: o mesmo respiro de um grupo', Math.abs(lists.taskToNumbered - lists.group) <= 2, lists);
    check('numerada seguida de lista com marcador: o mesmo respiro', Math.abs(lists.numberedToBullet - lists.group) <= 2, lists);
    await send('Emulation.clearDeviceMetricsOverride');

    console.log('17. Datilografia: a linha que se escreve para no meio da tela, e so a escrita rola');
    // No real keyboard here: the writing area is the whole screen minus header and bar. On the
    // phone the keyboard shrinks the page (interactive-widget) and the middle becomes the middle of what is left
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await open(buildPage('datilografia', currentApp));
    await js(FAKE_DRIVE);
    const TYPING_NOTE = Array.from({ length: 80 }, (_, i) => 'linha ' + i).join('\n');
    // Height of the cursor as a % of the scrolling area (0 = top, 100 = bottom), and the scroll
    const whereItIs = async () => JSON.parse(await js(`(() => {
      const view = __App.Editor._impl.view;
      const caret = view.coordsAtPos(view.state.selection.main.head);
      const box = view.scrollDOM.getBoundingClientRect();
      return JSON.stringify({ height: Math.round((caret.bottom - box.top) / box.height * 100),
        scroll: Math.round(view.scrollDOM.scrollTop) });
    })()`));

    await editNote(TYPING_NOTE, 79, 'linha 79'.length);
    await send('Input.insertText', { text: ' mais' });
    await sleep(150);
    const typingAtEnd = await whereItIs();
    console.log('     escrevendo no fim da nota:', JSON.stringify(typingAtEnd));
    check('escrevendo no fim de nota longa, a linha fica no meio e nao colada no pe', typingAtEnd.height >= 35 && typingAtEnd.height <= 55, typingAtEnd);

    // Dictation that breaks into several lines: the screen follows line by line and the phrase goes in whole
    const PHRASE = 'hoje fui ao mercado e comprei tudo o que faltava pra semana, inclusive a racao dos cachorros e o cafe';
    for (let n = 10; n <= PHRASE.length; n += 15) {
      await send('Input.imeSetComposition', { text: PHRASE.slice(0, n), selectionStart: n, selectionEnd: n });
      await sleep(40);
    }
    await send('Input.insertText', { text: PHRASE });
    await sleep(150);
    const afterDictation = await whereItIs();
    const dictated = await js('__App.getContent()');
    console.log('     depois de um ditado de varias linhas:', JSON.stringify(afterDictation));
    check('o ditado entra inteiro, uma vez so', dictated.endsWith('linha 79 mais' + PHRASE), dictated.slice(-160));
    check('... e a linha continua no meio, com a tela tendo subido', afterDictation.height >= 35 && afterDictation.height <= 55
      && afterDictation.scroll > typingAtEnd.scroll, { typingAtEnd, afterDictation });

    // At the top of the note there is nothing to scroll: writing there does not move the screen
    await editNote(TYPING_NOTE, 2, 0);
    await js(`__App.Editor._impl.view.scrollDOM.scrollTop = 0; 'ok'`);
    await send('Input.insertText', { text: 'x' });
    await sleep(150);
    const nearTop = await whereItIs();
    check('escrevendo no alto da nota, a tela fica parada', nearTop.scroll === 0, nearTop);

    // The tap only sets the cursor: tapping a line down below does not pull it to the middle (what pulls is the writing)
    const nearBottom = JSON.parse(await js(`(() => { const b = __App.Editor._impl.view.scrollDOM.getBoundingClientRect();
      return JSON.stringify({ x: b.left + 80, y: b.bottom - 30 }); })()`));
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: nearBottom.x, y: nearBottom.y, button: 'left', clickCount: 1 });
    }
    await sleep(150);
    const afterTouch = await whereItIs();
    check('tocar numa linha perto do pe poe o cursor la sem rolar', afterTouch.scroll === 0 && afterTouch.height > 80, afterTouch);
    await send('Emulation.clearDeviceMetricsOverride');

    console.log('18. Retomar a nota onde parou: reabre no mesmo paragrafo, com a foto de cima chegando depois');
    // What jsdom does not prove: the real layout, and the photo that arrives from the Drive after the note shows up.
    // Kept in pixels, the place would land further down while the photo above had not arrived; kept by the
    // block, it lands on the same paragraph, and the browser's scroll anchoring holds it when the photo grows
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const PHOTO_DRIVE = `
      localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
      __App.accessToken = 'fake';
      window.__photo = { delay: 0, arrived: false };
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><rect width="100%" height="100%" fill="#bb86fc"/></svg>';
      const longNote = '# Longa\\n\\n![[foto.png]]\\n\\n'
        + Array.from({ length: 60 }, (_, i) => 'paragrafo ' + i + ' ' + 'texto '.repeat((i % 7) * 6)).join('\\n\\n');
      window.fetch = async (url) => {
        const u = new URL(url);
        const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => o, arrayBuffer: async () => new TextEncoder().encode(o).buffer });
        if (/files\\/FOTO$/.test(u.pathname)) {
          await new Promise(r => setTimeout(r, window.__photo.delay));
          window.__photo.arrived = true;
          return { ok: true, status: 200, blob: async () => new Blob([svg], { type: 'image/svg+xml' }) };
        }
        if (u.searchParams.get('alt') === 'media') return ok(longNote);
        if (/files\\/N3$/.test(u.pathname)) return ok({ id: 'N3', name: 'longa.md', parents: ['F1'], modifiedTime: 't1' });
        const q = u.searchParams.get('q') || '';
        return ok({ files: q.includes("'foto.png'") ? [{ id: 'FOTO', name: 'foto.png', mimeType: 'image/png', parents: ['m'] }] : [] });
      };
      'ok'`;
    // The block at the top of the screen, where it sits against the top, and the photo's height
    const atTop = async () => JSON.parse(await js(`(() => {
      const c = document.getElementById('preview-container');
      const top = c.getBoundingClientRect().top;
      const el = [...c.children].find(e => e.getBoundingClientRect().bottom > top);
      const photo = document.querySelector('#preview-container img[data-embed]');
      return JSON.stringify({ text: el ? el.textContent.split(' texto')[0].trim() : '', px: el ? Math.round(el.getBoundingClientRect().top - top) : 0,
        photo: photo ? Math.round(photo.getBoundingClientRect().height) : -1 });
    })()`));
    // Paragraph 30 at the top, with 30px of it already scrolled past
    const PARAGRAPH_30 = `(() => {
      const c = document.getElementById('preview-container');
      const p = [...c.children].find(e => e.textContent.startsWith('paragrafo 30 '));
      c.scrollTop += p.getBoundingClientRect().top - c.getBoundingClientRect().top + 30;
      return 'ok';
    })()`;
    const PHOTO_ON_SCREEN = `window.__photo.arrived && document.querySelector('#preview-container img[data-embed]')?.naturalHeight > 0`;
    const openLong = () => js(`__App.openFile('N3', 'longa.md'); 'ok'`);

    // Opens, waits for the photo, and leaves paragraph 30 at the top. Returns what was at the top on leaving.
    const readToTheMiddle = async (app, html) => {
      await open(buildPage('retomar', app, { html }));
      await js(`localStorage.clear(); 'ok'`);
      await js(WIPE_DB);
      await js(PHOTO_DRIVE);
      await openLong();
      await waitFor(PHOTO_ON_SCREEN, 3000);
      await sleep(300);
      await js(PARAGRAPH_30);
      await sleep(100);
      return atTop();
    };

    const onLeaving = await readToTheMiddle(currentApp);
    console.log('     ao sair:', JSON.stringify(onLeaving));
    check('(o paragrafo 30 no topo, com a foto de cima ja na tela)', onLeaving.text === 'paragrafo 30' && onLeaving.px === -30 && onLeaving.photo > 500, onLeaving);

    await js(`__App.goHome(); 'ok'`);
    await openLong();
    await sleep(300);
    const cameBack = await atTop();
    console.log('     voltando pela home:', JSON.stringify(cameBack));
    check('sair e voltar: o mesmo paragrafo, no mesmo ponto', cameBack.text === 'paragrafo 30' && Math.abs(cameBack.px - onLeaving.px) <= 2, cameBack);

    // The app killed with the note open (the page goes away without leaving the note) and opened again: the photo
    // now has to come from the Drive once more, and it takes a while
    await open(buildPage('retomar', currentApp));
    await js(PHOTO_DRIVE);
    await js(`window.__photo.delay = 1500; 'ok'`);
    await openLong();
    await sleep(250);
    const early = await atTop();
    const photoArrived = await js('window.__photo.arrived');
    console.log('     reaberto, foto a caminho:', JSON.stringify(early));
    check('app morto e aberto de novo: o mesmo paragrafo, com a foto de cima ainda a caminho',
      early.text === 'paragrafo 30' && Math.abs(early.px - onLeaving.px) <= 2 && !photoArrived && early.photo < 100, { early, photoArrived });
    await waitFor(PHOTO_ON_SCREEN, 4000);
    await sleep(300);
    const later = await atTop();
    console.log('     depois de a foto chegar:', JSON.stringify(later));
    check('... e a foto crescendo em cima nao tira o paragrafo do lugar',
      later.photo > 500 && later.text === 'paragrafo 30' && Math.abs(later.px - onLeaving.px) <= 2, later);

    // Control: the app from before the card opens the same note at the top, otherwise this scenario proves nothing
    let appBeforeResume = null;
    let htmlBeforeResume = null;
    try {
      appBeforeResume = execSync(`git -C "${ROOT}" show 7bed916:app.js`, { encoding: 'utf8', maxBuffer: 1e7, stdio: ['ignore', 'pipe', 'ignore'] });
      htmlBeforeResume = indexAt('7bed916');
    } catch { /* shallow clone or no git: the control is skipped */ }
    if (appBeforeResume) {
      await readToTheMiddle(appBeforeResume, htmlBeforeResume);
      await js(`__App.goHome(); 'ok'`);
      await openLong();
      await sleep(300);
      const withoutCard = await atTop();
      check('controle: sem o card (7bed916), a nota reabre no topo', withoutCard.text === 'Longa', withoutCard);
    } else {
      console.log('     (controle pulado: commit antigo indisponivel)');
    }
    await js(WIPE_DB);
    await send('Emulation.clearDeviceMetricsOverride');

    console.log('19. Ler e Editar no mesmo trecho, com o CodeMirror de verdade');
    // The top of each mode is read 16px below the edge (App.VIEW_INSET), where the text starts without scrolling
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const STRETCH_NOTE = '---\ncreated: 2026-09-01\nupdated: 2026-09-01\n---\n\n# Trecho\n\n'
      + Array.from({ length: 60 }, (_, i) => i === 20
        ? 'paragrafo longo ' + 'palavra '.repeat(400).trim()
        : 'paragrafo ' + i + ' ' + 'texto '.repeat((i % 7) * 6)).join('\n\n');
    const STRETCH_DRIVE = `
      localStorage.clear();
      localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
      __App.accessToken = 'fake';
      window.__note = ${JSON.stringify(STRETCH_NOTE)};
      window.fetch = async (url) => {
        const u = new URL(url);
        const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => o, arrayBuffer: async () => new TextEncoder().encode(o).buffer });
        if (u.searchParams.get('alt') === 'media') return ok(window.__note);
        if (u.pathname.endsWith('/N4')) return ok({ id: 'N4', name: 'trecho.md', parents: ['F1'], modifiedTime: 't1' });
        return ok({ files: [] });
      };
      'ok'`;
    const name = (s) => s.split(' texto')[0].split(' palavra')[0].trim();
    const reading = async () => {
      const r = JSON.parse(await js(`(() => {
        const c = document.getElementById('preview-container');
        const probe = c.getBoundingClientRect().top + 16;
        const el = [...c.children].find(e => e.getBoundingClientRect().bottom > probe);
        return JSON.stringify({ text: el.textContent, px: Math.round(el.getBoundingClientRect().top - probe) });
      })()`));
      return { text: name(r.text), px: r.px };
    };
    const editor = async () => {
      const r = JSON.parse(await js(`(() => {
        const v = __App.Editor._impl.view;
        const top = v.scrollDOM.getBoundingClientRect().top;
        const b = v.lineBlockAtHeight(top + 16 - v.documentTop);
        const line = v.state.doc.lineAt(b.from);
        // Where, inside the line, sits what shows at the reading's height: 0 = start, 1 = end
        const at = v.posAtCoords({ x: v.contentDOM.getBoundingClientRect().left + 40, y: top + 20 });
        return JSON.stringify({ text: line.text, px: Math.round(v.coordsAtPos(line.from).top - (top + 16)),
          inside: at == null ? -1 : Math.round((at - line.from) / Math.max(line.length, 1) * 100) / 100, focus: v.hasFocus });
      })()`));
      return { text: name(r.text), px: r.px, inside: r.inside, focus: r.focus };
    };
    const tapTheButton = async () => {
      const r = JSON.parse(await js(`JSON.stringify(document.getElementById('btn-preview').getBoundingClientRect())`));
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: r.x + r.width / 2, y: r.y + r.height / 2, button: 'left', clickCount: 1 });
      }
      await sleep(500);
    };
    const readingAt = (start, px = 0) => js(`(() => {
      const c = document.getElementById('preview-container');
      const p = [...c.children].find(e => e.textContent.startsWith(${JSON.stringify(start)}));
      c.scrollTop += p.getBoundingClientRect().top - (c.getBoundingClientRect().top + 16) + ${px};
      return 'ok';
    })()`);
    const openStretch = async (app, html) => {
      await open(buildPage('trecho', app, { html }));
      await js(WIPE_DB);
      await js(STRETCH_DRIVE);
      await js(`__App.openFile('N4', 'trecho.md').then(() => 'ok')`);
      await sleep(200);
    };

    await openStretch(currentApp);
    await readingAt('paragrafo 30 ');
    const readingNow = await reading();
    check('(lendo, com o paragrafo 30 no topo)', readingNow.text === 'paragrafo 30' && readingNow.px === 0, readingNow);
    await tapTheButton();
    const editing = await editor();
    console.log('     Editar:', JSON.stringify(editing));
    check('Editar: o editor abre com o paragrafo 30 no topo', await js('__App.mode') === 'edit' && editing.text === 'paragrafo 30' && Math.abs(editing.px) <= 3, editing);
    check('... sem pegar o foco, entao sem teclado', editing.focus === false, editing);

    await js(`(() => {
      const v = __App.Editor._impl.view;
      const line = [...Array(v.state.doc.lines).keys()].map(n => v.state.doc.line(n + 1)).find(l => l.text.startsWith('paragrafo 45 '));
      v.dispatch({ effects: CM6.EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 16 }) });
      return 'ok';
    })()`);
    await sleep(300);
    await tapTheButton();
    const readingAgain = await reading();
    console.log('     Ler:', JSON.stringify(readingAgain));
    check('Ler: a leitura abre no paragrafo que estava no topo do editor', await js('__App.mode') === 'preview' && readingAgain.text === 'paragrafo 45' && Math.abs(readingAgain.px) <= 3, readingAgain);

    const roundTrips = [];
    for (let i = 0; i < 3; i++) {
      await tapTheButton();
      await tapTheButton();
      roundTrips.push(await reading());
    }
    console.log('     tres idas e voltas:', JSON.stringify(roundTrips));
    check('... e tres idas e voltas nao escorregam', roundTrips.every(l => l.text === 'paragrafo 45' && Math.abs(l.px - readingAgain.px) <= 3), roundTrips);

    // A single-line paragraph, huge: read halfway, the editor opens at its middle
    await js(`(() => {
      const c = document.getElementById('preview-container');
      const p = [...c.children].find(e => e.textContent.startsWith('paragrafo longo'));
      c.scrollTop += p.getBoundingClientRect().top - (c.getBoundingClientRect().top + 16) + p.getBoundingClientRect().height / 2;
      return 'ok';
    })()`);
    await tapTheButton();
    const inTheMiddle = await editor();
    console.log('     paragrafo longo lido ate a metade:', JSON.stringify(inTheMiddle));
    check('paragrafo enorme lido ate a metade: o editor abre perto da metade dele', inTheMiddle.text === 'paragrafo longo' && inTheMiddle.inside > 0.35 && inTheMiddle.inside < 0.65, inTheMiddle);

    // Control: v48 opens the editor at the top of the note
    let appOfV48 = null;
    let htmlOfV48 = null;
    try {
      appOfV48 = execSync(`git -C "${ROOT}" show cf8d4f1:app.js`, { encoding: 'utf8', maxBuffer: 1e7, stdio: ['ignore', 'pipe', 'ignore'] });
      htmlOfV48 = indexAt('cf8d4f1');
    } catch { /* shallow clone or no git: the control is skipped */ }
    if (appOfV48) {
      await openStretch(appOfV48, htmlOfV48);
      await readingAt('paragrafo 30 ');
      await tapTheButton();
      const inV48 = await editor();
      check('controle: sem a fatia 2 (cf8d4f1), o Editar abre no topo da nota', inV48.text === '---', inV48);
    } else {
      console.log('     (controle pulado: commit antigo indisponivel)');
    }
    await js(WIPE_DB);
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
      return waitFor(count === 2 ? `window.__clicks.dblclick >= 1 && window.__clicks.click >= ${before + 2}`
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
    await waitFor(`document.querySelector('#preview-container a.wikilink')`);
    await click(await wordAt('#preview-container a.wikilink', 'destino'));
    const followed = await waitFor(`__App.currentFile && __App.currentFile.id === 'N2'`);
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
    const lit = await waitFor(`document.body.classList.contains('has-selection')`);
    const editorSelection = await js(`(() => { const v = __App.Editor._impl.view; const s = v.state.selection.main;
      return v.state.sliceDoc(s.from, s.to); })()`);
    check('duplo clique numa palavra do editor seleciona e acende o botao de extrair', lit === true && editorSelection.trim() === 'palavra',
      { lit, editorSelection });
    await send('Input.insertText', { text: 'termo' });
    const typed = await waitFor(`__App.getContent().startsWith('uma termo')`);
    check('digitar por cima da selecao troca a palavra', typed === true, await js('__App.getContent()'));
    await send('Input.insertText', { text: ' [[' });
    const listed = await waitFor(`document.querySelectorAll('.cm-tooltip-autocomplete li').length >= 2`);
    check('... e o [[ ainda abre a lista de notas', listed === true);

    // Fields: the rename box, opened by a real click on the note name, still selects a word
    await js(`__App.currentFile.name = 'nota de teste.md'; __App.updateFileNameDisplay(); 'ok'`);
    const nameBox = JSON.parse(await js(`JSON.stringify(document.getElementById('file-name').getBoundingClientRect())`));
    await click({ x: Math.round(nameBox.x + 10), y: Math.round(nameBox.y + nameBox.height / 2) });
    const renaming = await waitFor(`document.getElementById('modal-overlay').classList.contains('visible')`);
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
    await waitFor('window.__App', 15000);
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
    await waitFor('window.__App', 15000);
    // A note with headings, open in the reading view, with no Drive: the content goes in directly
    await js(`(() => { __App.currentFile = { id: 'T', name: 'uma nota com titulos.md' }; __App.setContent('# Um\\n\\ntexto\\n\\n## Dois\\n\\nmais');
      __App.showEditor(); __App.setMode('preview'); __App.updateFileNameDisplay(); return 'ok'; })()`);
    // What the page saw, counted on the window in the capture phase (before the app's listener, which swallows the click):
    // the touch arrived, the click came or not, and on what it landed
    await js(`window.__renamed = 0; __App.promptRename = () => { window.__renamed++; };
      window.__seen = { start: 0, move: 0, end: 0, cancel: 0, clicks: [] };
      window.addEventListener('touchstart', () => window.__seen.start++, true);
      window.addEventListener('touchmove', () => window.__seen.move++, true);
      window.addEventListener('touchend', () => window.__seen.end++, true);
      window.addEventListener('touchcancel', () => window.__seen.cancel++, true);
      window.addEventListener('click', (e) => window.__seen.clicks.push(e.target.id || e.target.className || e.target.tagName), true); 'ok'`);
    const fileNameBox = JSON.parse(await js(`JSON.stringify(document.getElementById('file-name').getBoundingClientRect())`));
    const cx = Math.round(fileNameBox.x + fileNameBox.width / 2), cy = Math.round(fileNameBox.y + fileNameBox.height / 2);
    const tocOpen = `document.getElementById('toc-overlay').classList.contains('visible')`;
    // Each step waits for the page to say it saw the touch (the Input queue is not the Runtime.evaluate one), and the
    // touchcancel the browser sometimes injects makes the attempt be redone, as in scenario 10
    const hold = async (dx) => {
      let r = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await js(`__App.closeToc(); window.__seen = { start: 0, move: 0, end: 0, cancel: 0, clicks: [] }; 'ok'`);
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy }] });
        await waitFor('window.__seen.start >= 1', 4000);
        if (dx) {
          await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + dx, y: cy }] });
          await waitFor('window.__seen.move >= 1', 4000);
        }
        // Still: the app opens the table of contents with the finger still on the screen. Moved: once the long press time
        // has passed (counted after the page sees the move), nothing opened
        const opened = dx ? (await sleep(800), await js(tocOpen)) : await waitFor(tocOpen, 4000);
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await waitFor('window.__seen.end + window.__seen.cancel >= 1', 4000);
        // The click the browser sends after letting go (if it sends one) comes right behind the touchend
        await sleep(300);
        const seen = JSON.parse(await js('JSON.stringify(window.__seen)'));
        r = { opened, seen, openAfter: await js(tocOpen), renamed: Number(await js('window.__renamed')) };
        if (!seen.cancel) return r;
        console.log(`     (tentativa ${attempt} do toque longo perdida: touchcancel)`, JSON.stringify(seen));
      }
      return r;
    };
    const still = await hold(0);
    console.log('     segurar parado:', JSON.stringify(still));
    check('segurar o nome abre o sumario', still.opened === true && still.openAfter === true, still);
    check('... e soltar nao renomeia (o clique, se vier, e engolido)', still.renamed === 0, still);
    const firstRow = JSON.parse(await js(`(() => { const b = document.querySelector('#toc-ul li').getBoundingClientRect();
      const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return JSON.stringify({ hit: !!el && !!el.closest('#toc-ul li'), h: b.height }); })()`));
    check('a primeira linha do sumario e tocavel e tem altura de dedo', firstRow.hit && firstRow.h >= 44, firstRow);
    const closeButton = JSON.parse(await js(`(() => { const b = document.getElementById('toc-close').getBoundingClientRect();
      const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return JSON.stringify({ hit: !!el && !!el.closest('#toc-close'), bottom: b.bottom }); })()`));
    check('o Fechar e tocavel, dentro da tela', closeButton.hit && closeButton.bottom <= 844, closeButton);
    // Esc is the CloseWatcher's back outside Android (see drive-notes-aprendizados, Testes)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    const closedOnBack = await waitFor(`!(${tocOpen})`, 4000);
    check('o voltar de verdade (Esc) fecha o sumario e fica na nota', closedOnBack && await js(`__App.currentFile.id`) === 'T');
    const moved = await hold(40);
    console.log('     dedo que anda:', JSON.stringify(moved));
    check('dedo que anda 40px nao abre', moved.opened === false && moved.openAfter === false, moved);
    // A short tap after a long press: renames as always (nothing was left stuck to swallow)
    await js(`window.__seen.clicks = []; 'ok'`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const renamedAfter = await waitFor('window.__renamed >= 1', 4000);
    check('toque curto no nome, depois disso, renomeia', renamedAfter === true && !(await js(tocOpen)), JSON.parse(await js('JSON.stringify(window.__seen)')));
    console.log(`     o nome comeca em x=${Math.round(fileNameBox.x)} (faixa do deslizar: ate 32px da borda)`);
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await send('Emulation.clearDeviceMetricsOverride');

    console.log('23. Espiar de verdade: segurar um link abre o cartao sem o menu do Chrome, rolar e deslizar em cima de um link nao');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await open(buildPage('espiar', currentApp));
    await waitFor('window.__App', 15000);
    // A long note, with a link at the start of each paragraph (the text starts at x=16, inside the swipe
    // band), open in the reading view. No Drive: the lookup and the content of the note on the other side are swapped in
    const LINKS_NOTE = Array.from({ length: 40 }, (_, i) => `[[Outra]] paragrafo ${i} com texto bastante pra ocupar a linha e um pouco mais`).join('\n\n');
    await js(`(() => {
      localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3)); __App.accessToken = 'fake';
      __App.findLinkedNote = async (target) => ({ base: target, note: { id: 'O', name: 'Outra.md' } });
      __App.driveGetFileContent = async () => '# Outra\\n\\ntexto da outra\\n\\n- [ ] uma tarefa';
      __App.currentFile = { id: 'T', name: 'com links.md' }; __App.setContent(${JSON.stringify(LINKS_NOTE)});
      __App.showEditor(); __App.setMode('preview'); __App.updateFileNameDisplay(); __App.isDirty = false;
      window.__seen = { start: 0, move: 0, end: 0, cancel: 0 };
      window.addEventListener('touchstart', () => window.__seen.start++, true);
      window.addEventListener('touchmove', () => window.__seen.move++, true);
      window.addEventListener('touchend', () => window.__seen.end++, true);
      window.addEventListener('touchcancel', () => window.__seen.cancel++, true);
      // Registered after the app and in the bubble phase: sees Chrome's menu as it arrives, after the app's listener
      window.__ctx = null; document.addEventListener('contextmenu', (e) => { window.__ctx = e.defaultPrevented; });
      return 'ok'; })()`);
    const cardOpen = `document.getElementById('peek-overlay').classList.contains('visible')`;
    const linkTop = async () => {
      await js(`document.getElementById('preview-container').scrollTop = 0; 'ok'`);
      return JSON.parse(await js(`JSON.stringify(document.querySelector('#preview-container a.wikilink').getBoundingClientRect())`));
    };
    let linkBox = await linkTop();
    const lx = Math.round(linkBox.x + Math.min(linkBox.width / 2, 30)), ly = Math.round(linkBox.y + linkBox.height / 2);
    const holdLink = async () => {
      let r = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await js(`__App.closePeek(); window.__ctx = null; window.__seen = { start: 0, move: 0, end: 0, cancel: 0 }; 'ok'`);
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: lx, y: ly }] });
        await waitFor('window.__seen.start >= 1', 4000);
        const opened = await waitFor(cardOpen, 4000);
        // Finger still on the screen: Chrome's menu, if it comes, comes now (measured: headless Edge does not send
        // contextmenu for an injected touch, not even holding for 1.7s; the listener is proven right below, directly)
        await sleep(400);
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await waitFor('window.__seen.end + window.__seen.cancel >= 1', 4000);
        await sleep(300);
        const seen = JSON.parse(await js('JSON.stringify(window.__seen)'));
        r = { opened, seen, openAfter: await js(cardOpen), ctx: await js('window.__ctx'), file: await js('__App.currentFile && __App.currentFile.id'), view: await js('document.body.dataset.view') };
        if (!seen.cancel) return r;
        console.log(`     (tentativa ${attempt} do toque longo perdida: touchcancel)`, JSON.stringify(seen));
      }
      return r;
    };
    const readingScrollBefore = Number(await js(`document.getElementById('preview-container').scrollTop`));
    const held = await holdLink();
    console.log('     segurar o link:', JSON.stringify(held));
    check('segurar o link abre o cartao', held.opened === true && held.openAfter === true, held);
    check('... e soltar nao navega', held.file === 'T' && held.view === 'preview', held);
    check('... o menu do Chrome, se veio, chegou cancelado', held.ctx === null || held.ctx === true, held.ctx);
    // The menu and the selection, on the real browser: off on a note link, and only there
    const menu = JSON.parse(await js(`(() => {
      const c = document.getElementById('preview-container');
      const a = c.querySelector('a.wikilink'), p = c.querySelector('p');
      const ctx = (el) => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; };
      return JSON.stringify({ linkCtx: ctx(a), textCtx: ctx(p), linkSelect: getComputedStyle(a).userSelect, textSelect: getComputedStyle(p).userSelect }); })()`));
    check('menu do Chrome cancelado no link de nota, nao no texto; o link nao seleciona, o texto sim',
      menu.linkCtx === true && menu.textCtx === false && menu.linkSelect === 'none' && menu.textSelect === 'text', menu);
    const arrived = await waitFor(`document.getElementById('peek-body').textContent.includes('texto da outra')`, 4000);
    check('o cartao mostra a nota do outro lado, com o nome no topo', arrived && await js(`document.getElementById('peek-title').textContent`) === 'Outra');
    // The dialogs' field rule (.modal input, full width) must not stretch the task's checkbox
    const checkbox = JSON.parse(await js(`JSON.stringify(document.querySelector('#peek-body li > input[type="checkbox"]').getBoundingClientRect())`));
    check('a caixinha de tarefa do cartao tem tamanho de caixinha, na linha do texto', checkbox.width < 30, checkbox);
    const peekButtons = JSON.parse(await js(`(() => { const hit = (id) => { const b = document.getElementById(id).getBoundingClientRect();
      const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return { hit: !!el && !!el.closest('#' + id), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
      const card = document.querySelector('#peek-overlay .modal').getBoundingClientRect();
      return JSON.stringify({ open: hit('peek-open'), close: hit('peek-close'), card: { top: Math.round(card.top), bottom: Math.round(card.bottom), h: Math.round(card.height) } }); })()`));
    console.log('     cartao:', JSON.stringify(peekButtons));
    check('o Abrir e o Fechar sao tocaveis, dentro da tela', peekButtons.open.hit && peekButtons.close.hit && peekButtons.open.bottom <= 844 && peekButtons.close.bottom <= 844, peekButtons);
    check('... e a leitura de baixo nao rolou', Number(await js(`document.getElementById('preview-container').scrollTop`)) === readingScrollBefore);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    check('o voltar de verdade (Esc) fecha o cartao e fica na nota', await waitFor(`!(${cardOpen})`, 4000) && await js(`__App.currentFile.id`) === 'T');

    // Scrolling the reading view with the finger starting on top of a link: it scrolls, and no card
    let scrolling = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      linkBox = await linkTop();
      await js(`__App.closePeek(); window.__seen = { start: 0, move: 0, end: 0, cancel: 0 }; 'ok'`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: lx, y: ly }] });
      for (let i = 1; i <= 10; i++) {
        await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: lx, y: ly - 8 * i }] });
        await sleep(16);
      }
      await waitFor('window.__seen.move >= 10', 4000);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await waitFor('window.__seen.end + window.__seen.cancel >= 1', 4000);
      // Once the long press time has passed since the start: nothing opened
      await sleep(800);
      const seen = JSON.parse(await js('JSON.stringify(window.__seen)'));
      scrolling = { seen, scrollTop: Number(await js(`document.getElementById('preview-container').scrollTop`)), openAfter: await js(cardOpen) };
      if (!seen.cancel || scrolling.scrollTop > 0) break;
      console.log(`     (tentativa ${attempt} da rolagem perdida: touchcancel)`, JSON.stringify(seen));
    }
    console.log('     rolar em cima do link:', JSON.stringify(scrolling));
    check('arrastar 80px pra cima comecando no link rola a leitura e nao abre cartao', scrolling.scrollTop > 0 && scrolling.openAfter === false, scrolling);

    // An edge swipe starting on top of a link (the note's name starts outside the band, see 22):
    // the swipe goes back and the card does not open
    linkBox = await linkTop();
    const atEdge = JSON.parse(await js(`(() => { const el = document.elementFromPoint(20, ${ly}); return JSON.stringify({ link: !!el && !!el.closest('#preview-container a.wikilink'), x: ${Math.round(linkBox.x)} }); })()`));
    check('(o dedo em x=20 cai em cima do link)', atEdge.link, atEdge);
    let swiped = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await js(`__App.closePeek(); window.__seen = { start: 0, move: 0, end: 0, cancel: 0 }; 'ok'`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 20, y: ly }] });
      for (let i = 1; i <= 8; i++) {
        await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 20 + 130 * i / 8, y: ly }] });
        await sleep(16);
      }
      await waitFor('__App._swipe && __App._swipe.armed === true', 4000);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const wentBack = await waitFor(`document.body.dataset.view === 'welcome'`, 4000);
      await sleep(800);
      const seen = JSON.parse(await js('JSON.stringify(window.__seen)'));
      swiped = { wentBack, seen, openAfter: await js(cardOpen), view: await js('document.body.dataset.view') };
      if (wentBack) break;
      console.log(`     (tentativa ${attempt} do deslizar perdida)`, JSON.stringify(swiped));
    }
    console.log('     deslizar da borda em cima do link:', JSON.stringify(swiped));
    check('deslizar da borda comecando num link volta, e o cartao nao abre', swiped.wentBack === true && swiped.openAfter === false, swiped);
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await send('Emulation.clearDeviceMetricsOverride');
  } finally {
    browser.close();
  }
  done();
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
