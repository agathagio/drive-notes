// Phone-sized screenshots of every screen, with the real app and canned data. Not a test: a way to
// look at the UI without a phone, and to compare before and after a visual change.
//   npm run screenshots         (writes PNGs to tests/.tmp/screens/)
const fs = require('fs');
const path = require('path');
const { ROOT, sleep, tmpDir, appSource, buildPage, launch } = require('./helpers');

const NOTE = [
  '---', 'projeto: exemplo', 'tags: [trabalho, revisao]', '---', '',
  '# Relatório semanal', '',
  'Texto corrido com **negrito**, _itálico_, `código`, um link pra [[Plano de ação|o plano]] e outro pra [[Reunião 17 set#Decisões]].', '',
  '## Resumo', '', '> [!note] Contexto', '> Esta semana fechamos a leva 1.', '', '> [!warning]', '> Atenção ao prazo de sexta.', '',
  '> [!success] Feito', '> Deploy no ar.', '', '> Citação comum, sem callout.', '',
  '## Tarefas', '', '- [x] Corrigir perda de texto', '- [ ] Modo leitura', '- [ ] Busca', '',
  '## Tabela larga', '', '| Projeto | Status | Responsável | Prazo | Observação |', '| --- | --- | --- | --- | --- |',
  '| Drive Notes | Em andamento | Agatha | 30 set | Falta a busca no vault inteiro |', '| Vault | Estável | Agatha | sem prazo | ver nota |', '',
  '```js', 'const x = "bloco de código comprido pra testar a rolagem lateral";', '```', '', '![[diagrama.png]]', '', 'Fim.',
].join('\n');

const SETUP = `
  localStorage.clear();
  // The device's kept notes too: the profile outlives the run, and a fake Drive that always answers the
  // same modifiedTime would never refresh a note kept in an earlier run
  indexedDB.deleteDatabase('drivenotes');
  localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
  __App.accessToken = 'fake';
  const now = Date.now();
  localStorage.setItem('drivenotes_draft_new_1', JSON.stringify({ name: '2026-08-14-1530.md', content: 'x', timestamp: now - 36e5, fileId: null }));
  localStorage.setItem('drivenotes_recents', JSON.stringify(['ideias-drive-notes.md', '01-core.md', '00-estado-projeto.md', 'guia-voz-geral.md']
    .map((name, i) => ({ id: 'r' + i, name, timestamp: now - (i + 1) * 4 * 6e4 }))));
  const FOLDER = 'application/vnd.google-apps.folder';
  const folders = ['_archive', '_inbox', '_media', '00-meta', '10-areas', '20-projetos'];
  const notes = ['00-estado-projeto.md', '01-core.md', 'guia-voz-geral.md', 'Uma nota com um nome bem comprido pra ver como a linha quebra no celular.md', 'voz-blue.md'];
  // Each note's folder: it is what the [[ list shows in smaller type under the name
  const notesIn = ['ROOT', 'd5', 'd4', 'd3', 'd5'];
  window.fetch = async (url) => {
    const u = new URL(url); const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => o, arrayBuffer: async () => new TextEncoder().encode(o).buffer });
    // The embedded image of the sample note: found by name, then downloaded as a blob
    if ((u.searchParams.get('q') || '').includes("name = 'diagrama.png'")) return ok({ files: [{ id: 'IMG', name: 'diagrama.png', mimeType: 'image/png', parents: ['d2'] }] });
    if (u.pathname.endsWith('/IMG')) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="#2d2d52"/><circle cx="300" cy="300" r="160" fill="#bb86fc"/><rect x="620" y="160" width="400" height="280" rx="24" fill="#03dac6"/></svg>';
      return { ok: true, status: 200, blob: async () => new Blob([svg], { type: 'image/svg+xml' }) };
    }
    // Search of the whole vault, and the folders its results live in
    if ((u.searchParams.get('q') || '').includes(' contains ')) return ok({ files: [
      { id: 's1', name: 'guia-de-voz-onryo.md', parents: ['d5'], mimeType: 'text/markdown', modifiedTime: new Date(now - 9e8).toISOString() },
      { id: 's2', name: 'Reunião 17 set.md', parents: ['d4'], mimeType: 'text/markdown', modifiedTime: new Date(now - 2e8).toISOString() },
    ] });
    // The note index lists the whole Drive by type: the folders, then the note files (one type alone,
    // or several between parentheses, as the Drive stores a .md made by the API as text/plain)
    const byType = /^\\(?(mimeType = '[^']+'(?: or mimeType = '[^']+')*)\\)? and trashed = false$/.exec(u.searchParams.get('q') || '');
    if (byType) return ok({ files: byType[1].includes(FOLDER)
      ? folders.map((name, i) => ({ id: 'd' + i, name, mimeType: FOLDER, parents: ['ROOT'] }))
      : notes.map((name, i) => ({ id: 'n' + i, name, mimeType: 'text/markdown', parents: [notesIn[i]],
          modifiedTime: new Date(now - i * i * 40e6 - 5e6).toISOString() })) });
    const dir = /files\\/d(\\d)$/.exec(u.pathname);
    if (dir) return ok({ id: 'd' + dir[1], name: folders[dir[1]], parents: ['ROOT'] });
    if (u.searchParams.get('alt') === 'media') return ok(${JSON.stringify(NOTE)});
    if (/files\\/[^/]+$/.test(u.pathname)) return ok({ id: 'N', name: 'Relatório semanal.md', modifiedTime: 't', parents: ['ROOT'] });
    return ok({ files: [
      ...folders.map((name, i) => ({ id: 'd' + i, name, mimeType: FOLDER })),
      ...notes.map((name, i) => ({ id: 'n' + i, name, mimeType: 'text/markdown', modifiedTime: new Date(now - i * i * 40e6 - 5e6).toISOString() })),
    ] });
  };
  CONFIG.VAULT_FOLDER_ID = 'ROOT';
  __App.goHome();
  'ok'`;

(async () => {
  const out = path.join(tmpDir(), 'screens');
  fs.mkdirSync(out, { recursive: true });
  const browser = await launch(9335);
  const { send, js, open } = browser;
  try {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await open(buildPage('current', appSource()));
    await js(SETUP);

    const shot = async (name) => {
      await sleep(350);
      const png = (await send('Page.captureScreenshot', { format: 'png' })).result.data;
      fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(png, 'base64'));
      console.log(`  ${name}.png`);
    };

    await shot('1-inicio');
    await js(`__App.browseVault().then(() => 'ok')`);
    await shot('2-pastas');
    await js(`__App.els.browserSearch.value = 'voz'; __App.onSearchInput(); 'ok'`);
    await sleep(800);
    await shot('2b-busca');
    await js(`__App.els.browserSearch.value = ''; __App.onSearchInput(); 'ok'`);
    await js(`__App.navigateTo('N', 'Relatório semanal.md').then(() => 'ok')`);
    await shot('3-leitura');
    // The new version notice, which only shows up outside the home screen (on the home screen the page reloads by itself).
    // It goes away again right after, so it is not left over on the next screens
    await js(`__App.els.updateBar.classList.remove('hidden'); 'ok'`);
    await shot('3b-versao-nova');
    await js(`__App.els.updateBar.classList.add('hidden'); 'ok'`);
    await js(`document.querySelector('details.frontmatter').open = true; __App.els.previewContainer.scrollTop = 0; 'ok'`);
    await shot('4-leitura-propriedades');
    await js(`__App.els.previewContainer.scrollTop = 1e6; 'ok'`);
    await shot('4b-leitura-imagem');
    // The table of contents (holding the note's name in the reading view): the sample note's headings, one step in per level
    await js(`__App.openToc(); 'ok'`);
    await shot('4c-sumario');
    await js(`__App.closeToc(); 'ok'`);
    // Peek (holding a note link in the reading view): the card with the note on the other side, open at the link's
    // heading. The lookup and the content are swapped only here, and go back to what they were after the screenshot
    const PEEK_NOTE = [
      '---', 'created: 2026-09-17', '---', '', '# Reunião 17 set', '', 'Pauta curta, com **três** pontos e um link pra [[Plano de ação]].', '',
      '![[quadro-branco.jpg]]', '', '## Presentes', '', '- Agatha', '- Time de produto', '',
      '## Decisões', '', '- [x] Leva 1 fecha na sexta', '- [ ] Revisar a busca', '- [ ] Marcar a próxima', '',
      '> [!tip] Lembrete', '> Mandar o resumo no grupo.', '', '## Próximos passos', '', 'Texto corrido pra ver a rolagem dentro do cartão. '.repeat(8),
    ].join('\n');
    await js(`(() => {
      window.__peekOrig = { find: __App.findLinkedNote, get: __App.driveGetFileContent };
      __App.findLinkedNote = async (target) => ({ base: target, note: { id: 'R', name: 'Reunião 17 set.md' } });
      __App.driveGetFileContent = async () => ${JSON.stringify(PEEK_NOTE)};
      __App.els.previewContainer.scrollTop = 0;
      __App.openPeek({ target: 'Reunião 17 set', heading: '' });
      return 'ok'; })()`);
    await sleep(400);
    await shot('4e-espiar');
    await js(`__App.closePeek(); __App.findLinkedNote = window.__peekOrig.find; __App.driveGetFileContent = window.__peekOrig.get; 'ok'`);
    // A note with many headings: the list scrolls inside the panel and Fechar stays in view
    await js(`__App.setContent(${JSON.stringify(Array.from({ length: 30 }, (_, i) => `${'#'.repeat(1 + (i % 3))} Titulo ${i + 1}\n\ntexto`).join('\n\n'))});
      __App.setMode('preview'); __App.openToc(); 'ok'`);
    await shot('4d-sumario-longo');
    await js(`__App.closeToc(); 'ok'`);
    // Kanban board (reading only): the tests' backlog sample, columns stacked with their count,
    // Descartados folded as in Obsidian and the settings block hidden
    const BOARD = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'kanban-backlog.md'), 'utf8').replace(/\r\n/g, '\n');
    await js(`__App.setContent(${JSON.stringify(BOARD)}); __App.setMode('preview'); __App.els.previewContainer.scrollTop = 0; 'ok'`);
    await shot('4f-kanban');
    await js(`__App.els.previewContainer.scrollTop = 1e6; 'ok'`);
    await shot('4g-kanban-fim');
    // YouTube video (![](link)): the cover with the play mark, and below it a cover that did not load, which goes back to
    // being the link's text. The first one comes from the network (i.ytimg.com); without a network it becomes text too
    const VIDEO = ['# Aula gravada', '', 'Antes do vídeo, um parágrafo.', '', '![Me at the zoo](https://www.youtube.com/watch?v=jNQXAC9IVRw)', '',
      'Depois do vídeo, outro parágrafo.', '', '![](https://youtu.be/a1b2c3d4e5f?si=xyz)', '', 'Fim.'].join('\n');
    await js(`__App.setContent(${JSON.stringify(VIDEO)}); __App.setMode('preview'); __App.els.previewContainer.scrollTop = 0;
      __App.els.previewContainer.querySelectorAll('a.yt-embed img')[1]?.dispatchEvent(new Event('error')); 'ok'`);
    await sleep(1500);
    // What a finger on the play mark hits: it takes no taps, so it has to be the cover inside the link
    await js(`JSON.stringify([...__App.els.previewContainer.querySelectorAll('a.yt-embed img, a.yt-fallback')]
      .map(el => el.tagName === 'IMG' ? { src: el.src, complete: el.complete, width: el.naturalWidth } : { fallback: el.textContent })
      .concat((() => { const r = document.querySelector('.yt-play').getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { playHit: hit?.tagName, inLink: !!hit?.closest('a.yt-embed') }; })()))`)
      .then((r) => console.log(`  (youtube: ${r})`));
    await shot('4h-youtube');
    await js(`__App.setContent(${JSON.stringify(NOTE)}); __App.setMode('preview'); 'ok'`);
    await js(`__App.setMode('edit'); 'ok'`);
    await shot('5-edicao');
    // Through the end of the note, which is where the photo lives: what scrolls inside is .cm-scroller, and the facade's
    // path (cursor at the end + scroll to it) avoids depending on which CM6 element that is.
    // The focus is part of the path: since 21 Sep 2026 the facade only follows the cursor with the editor
    // focused, so the screen does not jump on its own for someone who opened the note just to read
    await js(`__App.Editor.focus(); __App.Editor.moveCaretToEnd(); __App.Editor.scrollToCaret(); 'ok'`);
    await shot('5b-edicao-imagem');
    // The [[ note list: the cursor at the end of the paragraph, and the text goes in through the keyboard path
    // (it is the browser's `input` that triggers the list, as on the phone)
    await js(`__App.Editor.focus();
      (() => { const view = __App.Editor._impl.view; const line = view.state.doc.line(8);
        view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true }); })(); 'ok'`);
    await send('Input.insertText', { text: ' [[vo' });
    await sleep(900);
    await shot('5c-link-list');
    // The note goes back to what it was, so the list is not left over on the next screens
    await js(`__App.Editor.closeLinkList(); __App.setContent(${JSON.stringify(NOTE)}); 'ok'`);
    // The extract button, which only exists with text selected, and the box it opens. The selection goes
    // from "## Resumo" to the end of the first callout, so the suggested name is "resumo"
    await js(`__App.Editor.focus();
      (() => { const view = __App.Editor._impl.view;
        view.dispatch({ selection: { anchor: view.state.doc.line(10).from, head: view.state.doc.line(13).to }, scrollIntoView: true }); })(); 'ok'`);
    await shot('5d-extrair');
    await js(`__App.promptExtract().then(() => 'ok')`);
    await shot('5e-extrair-caixa');
    await js(`__App.hideModal(); 'ok'`);
    // The name dialog on a note that is already on the Drive: it is through it that a note is deleted, which is why Apagar
    // shows up here, discreet and on the other side of the two usual buttons
    await js(`__App.promptRename(); 'ok'`);
    await shot('6-renomear');
    // The delete dialog. The name comes from a note the others point to, so that the link count
    // (which arrives after the dialog opens) shows up in the screenshot
    await js(`__App.promptDelete({ id: 'n1', name: 'Plano de ação.md' }); 'ok'`);
    await sleep(600);
    await shot('6b-delete-dialog');
    await js(`document.getElementById('confirm-cancel').click(); 'ok'`);
    await js(`__App.hideModal(); __App.showConflict(__App.currentFile); 'ok'`);
    await shot('7-conflito');
    await js(`__App.resolveConflict('later'); __App.goHome();
      __App.confirmDialog('Descartar rascunho', '"2026-08-14-1530.md": o texto que não está no Drive será perdido.', 'Descartar'); 'ok'`);
    await shot('8-confirmar');
    await js(`document.getElementById('confirm-cancel').click(); __App.newFile(); 'ok'`);
    await send('Input.insertText', { text: 'Ideia anotada na rua' });
    await shot('9-nota-nova');
    await js(`__App.inboxNotes = async () => [
      { id: 'I1', name: 'ideias-drive-notes.md' }, { id: 'I2', name: 'ideias-vault.md' }, { id: 'I3', name: 'config-notebook.md' } ];
      __App.hasValidToken = () => true;
      __App.openArrivalSheet({ id: 'z', at: 1, title: 'Como organizar um vault', text: 'https://www.youtube.com/watch?v=abc', url: '', photos: [] }).then(() => 'ok')`);
    await shot('10-guardar-em');
    await js(`__App.hideArrivalSheet(); 'ok'`);
    console.log(`\nem ${out}`);
  } finally {
    browser.close();
  }
})().catch(e => { console.error('ERRO', e); process.exit(1); });
