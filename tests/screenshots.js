// Phone-sized screenshots of every screen, with the real app and canned data. Not a test: a way to
// look at the UI without a phone, and to compare before and after a visual change.
//   npm run screenshots         (writes PNGs to tests/.tmp/screens/)
const fs = require('fs');
const path = require('path');
const { ROOT, sleep, tmpDir, buildPage, launch } = require('./helpers');

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
  localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
  __App.accessToken = 'fake';
  const now = Date.now();
  localStorage.setItem('drivenotes_draft_new_1', JSON.stringify({ name: '2026-08-14-1530.md', content: 'x', timestamp: now - 36e5, fileId: null }));
  localStorage.setItem('drivenotes_recents', JSON.stringify(['ideias-drive-notes.md', '01-core.md', '00-estado-projeto.md', 'guia-voz-geral.md']
    .map((name, i) => ({ id: 'r' + i, name, timestamp: now - (i + 1) * 4 * 6e4 }))));
  const FOLDER = 'application/vnd.google-apps.folder';
  const folders = ['_archive', '_inbox', '_media', '00-meta', '10-areas', '20-projetos'];
  const notes = ['00-estado-projeto.md', '01-core.md', 'guia-voz-geral.md', 'Uma nota com um nome bem comprido pra ver como a linha quebra no celular.md', 'voz-blue.md'];
  // A pasta de cada nota: é ela que a lista do [[ mostra em letra menor debaixo do nome
  const notesIn = ['ROOT', 'd5', 'd4', 'd3', 'd5'];
  window.fetch = async (url) => {
    const u = new URL(url); const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => o });
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
    await open(buildPage('current', fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')));
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
    await js(`document.querySelector('details.frontmatter').open = true; __App.els.previewContainer.scrollTop = 0; 'ok'`);
    await shot('4-leitura-propriedades');
    await js(`__App.els.previewContainer.scrollTop = 1e6; 'ok'`);
    await shot('4b-leitura-imagem');
    await js(`__App.setMode('edit'); 'ok'`);
    await shot('5-edicao');
    // Pelo fim da nota, que e onde mora a foto: quem rola por dentro e o .cm-scroller, e o caminho
    // da fachada (cursor no fim + rolar ate ele) evita depender de qual elemento do CM6 e esse.
    // O foco e parte do caminho: desde 21 set 2026 a fachada so persegue o cursor com o editor em
    // foco, pra tela nao pular sozinha pra quem abriu a nota so pra ler
    await js(`__App.Editor.focus(); __App.Editor.moveCaretToEnd(); __App.Editor.scrollToCaret(); 'ok'`);
    await shot('5b-edicao-imagem');
    // A lista de notas do [[: o cursor no fim do parágrafo, e o texto entra pelo caminho do teclado
    // (é o `input` do navegador que aciona a lista, como no celular)
    await js(`__App.Editor.focus();
      (() => { const view = __App.Editor._impl.view; const line = view.state.doc.line(8);
        view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true }); })(); 'ok'`);
    await send('Input.insertText', { text: ' [[vo' });
    await sleep(900);
    await shot('5c-link-list');
    // A nota volta ao que era, pra lista não sobrar nas telas seguintes
    await js(`__App.Editor.closeLinkList(); __App.setContent(${JSON.stringify(NOTE)}); 'ok'`);
    // O modal do nome numa nota que ja esta no Drive: e por ele que se apaga, e por isso o Apagar
    // aparece aqui, discreto e do outro lado dos dois botoes de sempre
    await js(`__App.promptRename(); 'ok'`);
    await shot('6-renomear');
    // O dialogo de apagar. O nome vem de uma nota que as outras apontam, pra contagem de links
    // (que chega depois de o dialogo abrir) sair no print
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
    console.log(`\nem ${out}`);
  } finally {
    browser.close();
  }
})().catch(e => { console.error('ERRO', e); process.exit(1); });
