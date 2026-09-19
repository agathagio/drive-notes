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
  } finally {
    browser.close();
  }
  done();
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
