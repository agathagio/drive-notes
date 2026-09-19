// What jsdom cannot show, checked in a real headless browser over the DevTools protocol:
// voice typing (IME composition) in TinyMDE, the formatting toolbar on TinyMDE, and the real CloseWatcher.
//   npm run test:browser        (needs Edge or Chrome; set BROWSER_PATH to choose)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT, sleep, buildPage, launch, reporter } = require('./helpers');

const { check, done } = reporter();

// The last version with the dictation bug: proves the composition check can actually fail
const COMMIT_WITH_DICTATION_BUG = '2d8b20b';

const FAKE_DRIVE = `
  localStorage.clear();
  localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
  __App.accessToken = 'fake';
  const FOLDER = 'application/vnd.google-apps.folder';
  const files = {
    F1: { id: 'F1', name: 'projetos', mimeType: FOLDER, parents: ['ROOT'] },
    N1: { id: 'N1', name: 'com link.md', mimeType: 'text/markdown', parents: ['ROOT'], content: 'vai [[destino]]' },
    N2: { id: 'N2', name: 'destino.md', mimeType: 'text/markdown', parents: ['F1'], content: '# Destino' },
  };
  window.fetch = async (url) => {
    const u = new URL(url); const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => o });
    const m = u.pathname.match(/files\\/([^/]+)$/);
    if (m) { const f = files[m[1]]; return u.searchParams.get('alt') === 'media' ? ok(f.content) : ok({ ...f, modifiedTime: 't1' }); }
    const q = u.searchParams.get('q') || ''; const parent = /^'([^']+)' in parents/.exec(q);
    const list = Object.values(files).filter(f => parent ? f.parents.includes(parent[1]) : q.includes("'" + f.name + "'"));
    return ok({ files: list.map(f => ({ ...f, modifiedTime: '2026-09-19T10:00:00Z' })) });
  };
  CONFIG.VAULT_FOLDER_ID = 'ROOT';
  'ok'`;

(async () => {
  const browser = await launch(9334);
  const { send, js, open } = browser;
  try {
    const currentApp = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const editNote = (content, row, col) => js(`__App.currentFile = { id: null, name: 't.md', draftKey: 'drivenotes_draft_t' };
      __App.setContent(${JSON.stringify(content)}); __App.showEditor(); __App.isDirty = false; __App.editor.e.focus();
      __App.editor.setSelection({ row: ${row}, col: ${col} }); 'ok'`);

    // ── 1. Voice typing: growing partial results inside one composition, then the final commit ──
    console.log('1. Ditado (composicao de IME) no TinyMDE');
    const dictate = async (url) => {
      await open(url);
      await editNote('linha um\n', 1, 0);
      for (const partial of ['Não', 'Não consigo', 'Não consigo ditar', 'Não consigo ditar minhas']) {
        await send('Input.imeSetComposition', { text: partial, selectionStart: partial.length, selectionEnd: partial.length });
        await sleep(60);
      }
      await send('Input.insertText', { text: 'Não consigo ditar minhas notas' });
      await sleep(150);
      return JSON.parse(await js(`JSON.stringify({ content: __App.getContent(), dom: __App.editor.e.innerText, dirty: __App.isDirty })`));
    };
    const expected = 'linha um\nNão consigo ditar minhas notas';

    let buggyApp = null;
    try {
      buggyApp = execSync(`git -C "${ROOT}" show ${COMMIT_WITH_DICTATION_BUG}:app.js`, { encoding: 'utf8', maxBuffer: 1e7, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { /* shallow clone or no git: the control is skipped */ }
    if (buggyApp) {
      const before = await dictate(buildPage('dictation-before', buggyApp));
      console.log('     versao com o bug:', JSON.stringify(before.content));
      check('controle: o bug se reproduz na versao antiga (texto duplicado)', before.content !== expected);
    } else {
      console.log('     (controle pulado: commit antigo indisponivel)');
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
    check('a formatacao do TinyMDE volta a rodar no fim da composicao', await js(`!!__App.editor.e.querySelector('.TMH1')`), await js('__App.editor.e.innerHTML'));

    // ── 2. Formatting toolbar on the real TinyMDE ──
    console.log('2. Barra de formatacao no TinyMDE');
    await open(buildPage('current', currentApp));
    await editNote('primeira linha\nsegunda linha\nterceira', 1, 5);
    const format = async (name, focus, anchor) => {
      await js(`__App.editor.setSelection(${JSON.stringify(focus)}${anchor ? ', ' + JSON.stringify(anchor) : ''}); __App.applyFormat('${name}'); 'ok'`);
      return js('__App.getContent()');
    };
    const end = (row) => js(`__App.editor.lines[${row}].length`);
    check('tinymde carregado', await js('!!__App.editor'));
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
    check('link com selecao vazia', await format('link', { row: 1, col: await end(1) }) === '**primeira** linha\n*segunda* linha[](url)\n- `terceira`');

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

    // ── 4. Photo: the real canvas shrinks it, the real TinyMDE receives the embed ──
    console.log('4. Foto na nota: reducao por canvas e insercao no TinyMDE');
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
      __App._photoAt = __App.editor.getSelection(false);
      __App.editor.e.blur(); getSelection().removeAllRanges();
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
    check('embed entra onde o cursor estava antes do seletor abrir', /^linha um\n!\[\[foto-[\d-]+\.jpg\]\]\n\nlinha dois$/.test(photo.content), photo.content);
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
        window.__searches++;
        const q = u.searchParams.get('q') || '';
        const hit = q.includes("'larga.png'") ? 'WIDE' : q.includes("'alta.png'") ? 'TALL' : null;
        return { ok: true, status: 200, json: async () => ({ files: hit ? [{ id: hit, name: 'x.png', mimeType: 'image/png', parents: ['m'] }] : [] }) };
      };
      return 'ok';
    })()`);
    const NOTE = 'antes\n![[larga.png]]\nmeio ![[larga.png]] no meio da frase\n![[alta.png|300]]\n![[sumiu.png]]\nfim';
    await editNote(NOTE, 0, 5);
    await sleep(600);
    const lines = () => js(`JSON.stringify([...__App.editor.lineElements].map(el => ({
      on: el.classList.contains('embed-line'), pad: Math.round(parseFloat(getComputedStyle(el).paddingBottom)),
      bg: getComputedStyle(el).backgroundImage.startsWith('url("blob:') })))`).then(JSON.parse);
    let l = await lines();
    const lineWidth = Number(await js('__App.editor.lineElements[1].clientWidth'));
    check('linha que e so o embed ganha a imagem, na proporcao certa e sem esticar', l[1].on && l[1].bg && Math.abs(l[1].pad - (Math.round(Math.min(lineWidth, 400) / 4) + 8)) <= 1, [l[1], lineWidth]);
    check('embed no meio de uma frase nao ganha', !l[2].on && !l[0].on && !l[5].on, l);
    check('imagem alta para em 300px de altura', l[3].on && l[3].pad === 308, l[3]);
    check('imagem que nao existe: linha normal', !l[4].on, l[4]);
    check('o texto da nota nao muda e a nota nao fica suja', await js('__App.getContent()') === NOTE && await js('__App.isDirty') === false);

    const searches = Number(await js('window.__searches'));
    await js(`__App.editor.setSelection({ row: 5, col: 3 }); 'ok'`);
    await send('Input.insertText', { text: ' da nota' });
    await sleep(400);
    l = await lines();
    check('digitar em outra linha: imagens seguem la, texto certo', l[1].on && l[3].on && (await js('__App.getContent()')).endsWith('fim da nota'));
    check('... sem procurar de novo no Drive (nem a que sumiu)', Number(await js('window.__searches')) === searches, [searches, await js('window.__searches')]);

    await js(`__App.editor.setSelection({ row: 1, col: 0 }); 'ok'`);
    await send('Input.insertText', { text: 'x ' });
    await sleep(400);
    l = await lines();
    check('linha deixou de ser so o embed: imagem sai', !l[1].on && l[1].pad === 0 && l[3].on, l[1]);

    await js(`__App.setMode('preview'); __App.setMode('edit'); 'ok'`);
    await sleep(300);
    l = await lines();
    check('ir pro modo leitura e voltar mantem a imagem', l[3].on && l[3].bg, l[3]);

    // ── 6. Dates: the caret of a new note in TinyMDE, and the editor catching up out of sight ──
    console.log('6. created e updated no TinyMDE');
    await open(buildPage('current', currentApp));
    await js(`(() => {
      localStorage.clear();
      localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
      __App.accessToken = 'fake';
      window.__written = [];
      window.fetch = async (url, opts = {}) => {
        const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => o });
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
    await js(`__App.setMode('edit'); __App.editor.e.focus(); __App.editor.setSelection({ row: 5, col: 5 }); 'ok'`);
    await send('Input.insertText', { text: ' novo' });
    await sleep(200);
    await js(`__App.save().then(() => 'ok')`);
    const dated = `---\ncreated: 2026-01-02\nupdated: ${today}\n---\n\ntexto novo`;
    check('o Drive recebe o updated de hoje', JSON.parse(await js('JSON.stringify(window.__written)'))[0] === dated, await js('JSON.stringify(window.__written)'));
    check('com o teclado aberto o editor fica como esta, cursor no lugar', await js('__App.getContent()') === dated.replace(today, '2026-01-03') && await js(`(({ row, col }) => row + ':' + col)(__App.editor.getSelection())`) === '5:10', await js('JSON.stringify(__App.editor.getSelection())'));
    const saveShown = () => js(`getComputedStyle(document.getElementById('btn-save')).display !== 'none'`);
    await js(`__App.setMode('preview'); 'ok'`);
    await sleep(200);
    check('leitura com tudo salvo: sem botao de salvar', await saveShown() === false);
    check('na leitura o editor alcanca o Drive e a nota segue limpa', await js('__App.getContent()') === dated && await js('__App.isDirty') === false, await js('__App.getContent()'));
    await js(`__App.save().then(() => 'ok')`);
    check('sem escrita extra', Number(await js('window.__written.length')) === 1);

    await js(`__App.setMode('edit'); __App.editor.e.focus(); __App.editor.setSelection({ row: 5, col: 10 }); 'ok'`);
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
  } finally {
    browser.close();
  }
  done();
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
