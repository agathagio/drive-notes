// The service worker end to end, which no other suite goes through: a local server plays GitHub Pages,
// a headless Edge plays the phone, and each "deploy" is the server starting to answer a new version.
//   npm run test:sw        (needs Edge or Chrome; set BROWSER_PATH to choose)
//
// What it proves: a new version reaches the screen in one opening (the home screen reloads on its own,
// once), coming back from the background looks for one, and a note with text not on the Drive yet is
// never reloaded: the bar offers the update, and tapping it saves, reloads and reopens the same note,
// back on the same paragraph of the reading view, or on the same line of the editor.
//
// SW_COMMIT=<commit> serves the app as it was in that commit instead of the working tree. It is the
// control: against dba1d23 (v46, before the card "Versão nova numa abertura só") scenarios 2 to 4 must
// fail, against 7bed916 (v47, before "Retomar a nota onde parou") scenario 5 must, and against f76e959
// (v57, when the bar reopened the editor where the reading was) scenario 9 must, or they prove nothing.
const { execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { ROOT, LIBS, sleep, tmpDir, launch, reporter, appSource } = require('./helpers');

const { check, done } = reporter();
const COMMIT = process.env.SW_COMMIT || '';
if (COMMIT) console.log(`(controle: servindo o app do commit ${COMMIT})`);

const DEBUG_PORT = 9336;
const PORT = 8336;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VAULT = /VAULT_FOLDER_ID: '([^']+)'/.exec(appSource())[1];

// The version the server is publishing. A deploy is changing this number.
let version = 1;
// No network at all, the service worker's own fetches included: the page's offline emulation
// (Network.emulateNetworkConditions) does not reach them. Measured on 22 Sep 2026 in scenario 7: with the
// page offline, the service worker still fetched index.html?atalho=nova from this server and cached it.
let offline = false;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const LOCAL_CDN = {
  'https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js': '/cdn/marked.min.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js': '/cdn/purify.min.js',
};

/** What the server answers for a path: the repository, with the outside world swapped for local copies */
function serve(pathname) {
  if (pathname === '/cdn/marked.min.js') return fs.readFileSync(LIBS.marked);
  if (pathname === '/cdn/purify.min.js') return fs.readFileSync(LIBS.purify);
  if (pathname === '/cdn/fonts.css') return '';
  const file = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  // A control serves a commit, so a file exists when that commit has it: the working tree has no app.js
  // since the split, and the index.html of an older commit still asks for it
  const inCommit = () => {
    try {
      execSync(`git cat-file -e ${COMMIT}:${path.relative(ROOT, file).replace(/\\/g, '/')}`, { cwd: ROOT, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  if (!file.startsWith(ROOT) || !(COMMIT ? inCommit() : fs.existsSync(file) && !fs.statSync(file).isDirectory())) return null;
  const encoding = file.endsWith('.png') ? 'buffer' : 'utf8';
  let text = COMMIT
    ? execSync(`git show ${COMMIT}:${path.relative(ROOT, file).replace(/\\/g, '/')}`, { cwd: ROOT, encoding, maxBuffer: 1 << 26 })
    : fs.readFileSync(file, encoding === 'buffer' ? null : 'utf8');
  const cdnToLocal = (s, absolute) => Object.entries(LOCAL_CDN).reduce((s, [cdn, local]) => s.split(cdn).join(absolute ? ORIGIN + local : local), s);
  if (pathname === '/' || pathname === '/index.html') {
    // Same bytes as the CDN (see tests/README.md), so the integrity hashes still hold
    text = cdnToLocal(text, false)
      .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, '')
      .replace(/<script[^>]*src="https:\/\/accounts\.google[^>]*><\/script>/, '');
  } else if (pathname === '/sw.js') {
    text = cdnToLocal(text, true)
      .replace(/https:\/\/fonts\.googleapis\.com\/css2[^']*/, `${ORIGIN}/cdn/fonts.css`)
      .replace(/const CACHE_NAME = '[^']+';/, `const CACHE_NAME = 'drivenotes-test-${version}';`);
    if (!text.includes(`drivenotes-test-${version}`)) throw new Error('CACHE_NAME not found in sw.js');
  } else if (pathname === '/app.js' || pathname === '/app/core.js') {
    // Which version's files the page is running: the proof that the new one reached the screen.
    // /app.js until the split of the app, /app/core.js after it; both, so that a SW_COMMIT control
    // serving an old commit keeps proving what it proves
    text += `\nwindow.__servedVersion = ${version};\n`;
  }
  return text;
}

const server = http.createServer((req, res) => {
  if (offline) {
    req.socket.destroy();
    return;
  }
  const { pathname } = new URL(req.url, ORIGIN);
  const body = serve(pathname);
  if (body === null) {
    res.writeHead(404);
    res.end();
    return;
  }
  // What GitHub Pages sends: the install's cache: 'reload' is there because of it
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(pathname)] || 'text/html', 'Cache-Control': 'max-age=600' });
  res.end(body);
});

// Runs at the start of every document the page loads, before the app: counts the loads (a reload is
// one more), and stands in for the Google Drive with a single note kept in localStorage, so that what
// a save wrote is still there after the reload
const EVERY_DOCUMENT = `(() => {
  if (location.origin !== ${JSON.stringify(ORIGIN)}) return;
  sessionStorage.setItem('__loads', String(+(sessionStorage.getItem('__loads') || 0) + 1));
  localStorage.setItem('drivenotes_token', 'fake');
  localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
  const read = () => JSON.parse(localStorage.getItem('__drive') || '{}');
  const reply = (o, status = 200) => new Response(typeof o === 'string' ? o : JSON.stringify(o), { status });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), location.href);
    if (u.hostname !== 'www.googleapis.com') return realFetch(url, opts);
    const files = read();
    const m = u.pathname.match(/files\\/([^/]+)$/);
    const f = m && files[m[1]];
    if (m && !f) return reply({}, 404);
    if (f && opts.method === 'PATCH' && u.pathname.startsWith('/upload/')) {
      f.content = opts.body;
      f.modifiedTime = new Date().toISOString();
      localStorage.setItem('__drive', JSON.stringify(files));
      return reply({ id: f.id, modifiedTime: f.modifiedTime });
    }
    if (f) return u.searchParams.get('alt') === 'media' ? reply(f.content) : reply({ id: f.id, name: f.name, parents: f.parents, modifiedTime: f.modifiedTime });
    return reply({ files: [] });
  };
})();`;

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  // A clean profile: the very first opening, with no service worker yet
  const profile = path.join(tmpDir(), `profile-${DEBUG_PORT}`);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch (e) {
    throw new Error(`Profile in use (${e.code}): an Edge left open by an earlier run? See drive-notes-aprendizados, Testes`);
  }
  const browser = await launch(DEBUG_PORT);
  const { send, js, esperar } = browser;

  const state = () => js(`(async () => ({
    loads: +sessionStorage.getItem('__loads'),
    served: window.__servedVersion,
    caches: (await caches.keys()).filter(k => k.startsWith('drivenotes-')),
    controlled: !!navigator.serviceWorker.controller,
    bar: document.getElementById('update-bar')?.classList.contains('hidden') === false,
    view: document.body.dataset.view,
  }))()`, false);
  const deploy = (n) => { version = n; };
  // Coming back from the background. Headless pages are always visible, so the event is enough.
  const resume = () => js(`document.dispatchEvent(new Event('visibilitychange')); document.visibilityState`, false);

  try {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: EVERY_DOCUMENT });

    console.log('1. Primeira abertura de todas: o service worker assume sem recarregar a pagina');
    {
      await send('Page.navigate', { url: `${ORIGIN}/index.html` });
      const took = await esperar(`navigator.serviceWorker.controller && window.__servedVersion`, 15000);
      await sleep(2000);
      const s = await state();
      check('o service worker assumiu a pagina', took && s.controlled, s);
      check('... sem recarregar (a primeira instalacao nao e versao nova)', s.loads === 1 && s.served === 1 && !s.bar, s);
      check('... com o cache da versao 1', s.caches.join() === 'drivenotes-test-1', s.caches);
    }

    console.log('2. Deploy e abrir o app: na home, a versao nova chega nessa mesma abertura');
    {
      deploy(2);
      await send('Page.navigate', { url: `${ORIGIN}/index.html` });
      const arrived = await esperar(`window.__servedVersion === 2`, 20000);
      await sleep(2000);
      const s = await state();
      check('a versao 2 chegou na tela sem abrir de novo', arrived && s.served === 2, s);
      check('... com uma recarga so: a abertura mais a recarga da home', s.loads === 3, s);
      check('... e so o cache novo sobrou', s.caches.join() === 'drivenotes-test-2', s.caches);
    }

    console.log('3. Deploy com o app aberto no fundo: voltar pra ele confere e traz a versao nova');
    {
      deploy(3);
      await sleep(3000);
      const before = await state();
      check('(controle) sem voltar do fundo, nada muda', before.served === 2 && before.loads === 3, before);
      const visibility = await resume();
      const arrived = await esperar(`window.__servedVersion === 3`, 20000);
      await sleep(1500);
      const s = await state();
      check('voltar do fundo trouxe a versao 3', arrived && s.served === 3 && s.loads === 4, { ...s, visibility });
    }

    console.log('4. Nota com texto por salvar: nunca recarrega; o aviso salva, recarrega e reabre a mesma nota');
    {
      await js(`localStorage.setItem('__drive', JSON.stringify({ A: { id: 'A', name: 'a.md', parents: [${JSON.stringify(VAULT)}], modifiedTime: '2026-09-22T10:00:00.000Z', content: 'versao 1' } })); 'ok'`, false);
      await js(`App.navigateTo('A', 'a.md')`);
      await esperar(`App.currentFile?.id === 'A' && document.body.dataset.view === 'preview'`, 5000);
      await js(`App.setMode('edit');
        const view = App.Editor._impl.view;
        view.dispatch({ changes: { from: view.state.doc.length, insert: ' com o que ela escreveu' }, userEvent: 'input.type' });
        'ok'`);
      const typed = await js(`App.isDirty && App.getContent()`, false);
      check('(a nota esta aberta, com texto por salvar)', typed === 'versao 1 com o que ela escreveu', typed);

      deploy(4);
      await resume();
      const offered = await esperar(`document.getElementById('update-bar')?.classList.contains('hidden') === false`, 20000);
      await sleep(2000);
      const s = await state();
      const still = await js(`({ dirty: App.isDirty, text: App.getContent(), mode: App.mode,
        drive: JSON.parse(localStorage.getItem('__drive')).A.content })`, false);
      check('a versao 4 assumiu, e o aviso apareceu', offered && s.bar && s.caches.join() === 'drivenotes-test-4', s);
      check('... sem recarregar: a mesma pagina, na versao 3, com o texto na tela',
        s.loads === 4 && s.served === 3 && still.dirty && still.text === 'versao 1 com o que ela escreveu' && still.mode === 'edit', { ...s, ...still });
      // Otherwise the autosave (30s) could be what saved it, and the check after the tap would prove nothing
      check('... e ainda sem nada no Drive, antes do toque', still.drive === 'versao 1', still.drive);

      await js(`document.getElementById('update-bar')?.click(); 'ok'`);
      const reopened = await esperar(`window.__servedVersion === 4 && App.currentFile?.id === 'A'`, 20000);
      await sleep(1000);
      const after = await state();
      const note = await js(`({ id: App.currentFile?.id, mode: App.mode, text: App.getContent(), dirty: App.isDirty,
        drive: JSON.parse(localStorage.getItem('__drive')).A.content })`, false);
      check('tocar no aviso: o texto foi pro Drive', note.drive.endsWith('versao 1 com o que ela escreveu'), note.drive);
      check('... recarregou uma vez, ja na versao 4', reopened && after.served === 4 && after.loads === 5 && !after.bar, after);
      check('... e reabriu a mesma nota, no modo de edicao, sem nada por salvar',
        note.id === 'A' && note.mode === 'edit' && !note.dirty && note.text.endsWith('versao 1 com o que ela escreveu'), note);
    }

    console.log('5. Nota longa lida ate o meio: o aviso recarrega e ela volta no mesmo paragrafo');
    {
      // The block at the top of the reading view, and where it sits against the top
      const atTop = () => js(`(() => {
        const c = document.getElementById('preview-container');
        const top = c.getBoundingClientRect().top;
        const el = [...c.children].find(e => e.getBoundingClientRect().bottom > top);
        return { text: el ? el.textContent.split(' texto')[0].trim() : '', px: el ? Math.round(el.getBoundingClientRect().top - top) : 0 };
      })()`, false);
      const long = Array.from({ length: 60 }, (_, i) => `paragrafo ${i} ` + 'texto '.repeat((i % 7) * 6)).join('\n\n');
      await js(`const d = JSON.parse(localStorage.getItem('__drive'));
        d.L = { id: 'L', name: 'longa.md', parents: [${JSON.stringify(VAULT)}], modifiedTime: '2026-09-22T11:00:00.000Z', content: ${JSON.stringify(long)} };
        localStorage.setItem('__drive', JSON.stringify(d)); 'ok'`, false);
      await js(`App.navigateTo('L', 'longa.md')`);
      await esperar(`App.currentFile?.id === 'L' && document.body.dataset.view === 'preview'`, 5000);
      await js(`(() => {
        const c = document.getElementById('preview-container');
        const p = [...c.children].find(e => e.textContent.startsWith('paragrafo 30 '));
        c.scrollTop += p.getBoundingClientRect().top - c.getBoundingClientRect().top + 10;
        return 'ok';
      })()`);
      const left = await atTop();
      // 10px, not more: in this wide window a paragraph can be a single 26px line
      check('(o paragrafo 30 no topo, com 10px dele ja passados)', left.text === 'paragrafo 30' && left.px === -10, left);

      deploy(5);
      await resume();
      const offered = await esperar(`document.getElementById('update-bar')?.classList.contains('hidden') === false`, 20000);
      await sleep(2000);
      check('a versao 5 assumiu, e o aviso apareceu', offered, await state());
      await js(`document.getElementById('update-bar')?.click(); 'ok'`);
      const reopened = await esperar(`window.__servedVersion === 5 && App.currentFile?.id === 'L' && document.body.dataset.view === 'preview'`, 20000);
      await sleep(500);
      const back = await atTop();
      check('tocar no aviso: recarregou, na versao 5, e reabriu a mesma nota na leitura', reopened, await state());
      check('... no mesmo paragrafo, no mesmo ponto', back.text === 'paragrafo 30' && Math.abs(back.px - left.px) <= 2, back);
    }

    console.log('6. Compartilhar de outro app: o service worker guarda texto e foto, e o app abre na tela Guardar em…');
    {
      await send('Page.navigate', { url: `${ORIGIN}/index.html` });
      await esperar(`navigator.serviceWorker.controller && window.App`, 15000);
      // What Android does with the manifest's share_target: a multipart POST to the action, as a navigation
      await js(`(() => {
        const form = document.createElement('form');
        form.method = 'POST'; form.enctype = 'multipart/form-data'; form.action = './share-target';
        const field = (name, value) => { const i = document.createElement('input'); i.type = 'hidden'; i.name = name; i.value = value; form.appendChild(i); };
        field('title', 'Um vídeo'); field('text', 'https://youtu.be/abc'); field('url', '');
        const input = document.createElement('input'); input.type = 'file'; input.name = 'photos';
        const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'IMG_1.jpg', { type: 'image/jpeg' }));
        input.files = dt.files; form.appendChild(input);
        document.body.appendChild(form); form.submit(); return 'ok';
      })()`, false);
      const opened = await esperar(`document.getElementById('arrival-overlay')?.classList.contains('visible')`, 15000);
      const s = await js(`(async () => {
        const db = await new Promise((ok, no) => { const r = indexedDB.open('drivenotes-arrivals', 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
        const all = await new Promise((ok) => { const r = db.transaction('arrivals').objectStore('arrivals').getAll(); r.onsuccess = () => ok(r.result); });
        db.close();
        return { search: location.search, path: location.pathname, what: document.getElementById('arrival-what').textContent,
          kept: all.map((a) => ({ title: a.title, text: a.text, photos: a.photos.map((p) => [p.name, p.type, p.bytes.byteLength]) })),
          got: all.map((a) => a.got) };
      })()`, false);
      check('o app abriu na tela Guardar em…', opened === true, s);
      check('... com o parametro ja fora da URL', s.search === '' && s.path === '/index.html', s);
      check('... mostrando o que chegou', s.what === 'Um vídeo · https://youtu.be/abc + 1 foto', s.what);
      check('... e o service worker guardou texto e foto na caixa',
        JSON.stringify(s.kept) === JSON.stringify([{ title: 'Um vídeo', text: 'https://youtu.be/abc', photos: [['IMG_1.jpg', 'image/jpeg', 4]] }]), s.kept);
      check('... e o que o Chrome mandou, campo a campo, sem o conteudo',
        JSON.stringify(s.got) === JSON.stringify([['title:text(8)', 'text:text(20)', 'url:text(0)', 'photos:file(image/jpeg,4,named)']]), s.got);
      // Cancelar with the list on screen drops what arrived: the box is empty for whatever runs next
      await js(`document.getElementById('arrival-cancel').click(); 'ok'`, false);
      await sleep(300);
    }

    console.log('7. Atalho do icone sem rede: o app abre do cache, e a URL com parametro nao vira copia nova no cache');
    {
      await send('Network.enable');
      await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      offline = true;
      await send('Page.navigate', { url: `${ORIGIN}/index.html?atalho=nova` });
      const opened = await esperar(`document.body.dataset.view === 'edit' && App.currentFile && !App.currentFile.id`, 15000);
      const s = await js(`(async () => ({ search: location.search,
        withQuery: (await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).map((r) => r.url))))
          .flat().filter((u) => u.includes('?atalho') || u.includes('?chegada')) }))()`, false);
      await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      offline = false;
      check('sem rede, o atalho abriu o app numa nota nova', opened === true, s);
      check('... com a URL limpa, e nenhuma copia da pagina com parametro no cache', s.search === '' && s.withQuery.length === 0, s);
    }

    console.log('8. Transcricao do gravador (.txt): o service worker le o arquivo e guarda como texto');
    {
      await send('Page.navigate', { url: `${ORIGIN}/index.html` });
      await esperar(`navigator.serviceWorker.controller && window.App`, 15000);
      // Two files in one share: UTF-8 with its byte order mark, and UTF-16LE with its own. The recorder's
      // encoding is unknown until the phone says; both must come out as the same letters.
      await js(`(() => {
        const form = document.createElement('form');
        form.method = 'POST'; form.enctype = 'multipart/form-data'; form.action = './share-target';
        const field = (name, value) => { const i = document.createElement('input'); i.type = 'hidden'; i.name = name; i.value = value; form.appendChild(i); };
        field('title', ''); field('text', ''); field('url', '');
        const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Ideia andando.' + String.fromCharCode(10) + 'Segunda linha, com acentuação.' + String.fromCharCode(10))]);
        const words = 'Outra gravação';
        const utf16 = new Uint8Array(2 + words.length * 2);
        utf16[0] = 0xff; utf16[1] = 0xfe;
        for (let i = 0; i < words.length; i++) { utf16[2 + i * 2] = words.charCodeAt(i) & 0xff; utf16[3 + i * 2] = words.charCodeAt(i) >> 8; }
        const input = document.createElement('input'); input.type = 'file'; input.name = 'texts';
        const dt = new DataTransfer();
        dt.items.add(new File([utf8], 'Gravação 001.txt', { type: 'text/plain' }));
        dt.items.add(new File([utf16], 'Gravação 002.txt', { type: 'text/plain' }));
        input.files = dt.files; form.appendChild(input);
        document.body.appendChild(form); form.submit(); return 'ok';
      })()`, false);
      const opened = await esperar(`document.getElementById('arrival-overlay')?.classList.contains('visible')`, 15000);
      const s = await js(`(async () => {
        const db = await new Promise((ok, no) => { const r = indexedDB.open('drivenotes-arrivals', 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
        const all = await new Promise((ok) => { const r = db.transaction('arrivals').objectStore('arrivals').getAll(); r.onsuccess = () => ok(r.result); });
        db.close();
        return { what: document.getElementById('arrival-what').textContent,
          kept: all.map((a) => ({ text: a.text, photos: a.photos.length })), got: all.map((a) => a.got) };
      })()`, false);
      check('o app abriu na tela Guardar em…', opened === true, s);
      check('... e a caixa tem o texto dos dois arquivos, sem a marca do inicio, separados por uma linha em branco',
        JSON.stringify(s.kept) === JSON.stringify([{ text: 'Ideia andando.\nSegunda linha, com acentuação.\n\nOutra gravação', photos: 0 }]), s.kept);
      check('... mostrando o texto no topo da tela', s.what.startsWith('Ideia andando.'), s.what);
      check('... e o registro diz que chegaram dois arquivos de texto',
        (s.got[0] || []).filter((g) => g.startsWith('texts:file(text/plain,')).length === 2, s.got);
      await js(`document.getElementById('arrival-cancel').click(); 'ok'`, false);
      await sleep(300);
    }

    console.log('9. Nota longa rolada no editor: o aviso recarrega e o editor volta na mesma linha, e nao onde a leitura estava');
    {
      // In this wide window a short paragraph is a single line: 200 of them (399 lines) give the editor room to scroll
      const long = Array.from({ length: 200 }, (_, i) => `linha ${i}`).join('\n\n');
      await js(`const d = JSON.parse(localStorage.getItem('__drive'));
        d.E = { id: 'E', name: 'editada.md', parents: [${JSON.stringify(VAULT)}], modifiedTime: '2026-09-22T12:00:00.000Z', content: ${JSON.stringify(long)} };
        localStorage.setItem('__drive', JSON.stringify(d)); 'ok'`, false);
      await js(`App.navigateTo('E', 'editada.md')`);
      await esperar(`App.currentFile?.id === 'E' && document.body.dataset.view === 'preview'`, 5000);
      // Editar with the reading at the top of the note, then the editor scrolled by hand far below it
      await js(`App.togglePreview(); 'ok'`);
      await esperar(`document.body.dataset.view === 'edit'`, 5000);
      // The editor comes out of hiding with a scroll target of its own still pending (editAtReading's
      // showLine to the top), and the library keeps applying it over a scrollTop written from outside.
      // So scroll the way the app does, with a scrollIntoView effect, which replaces that target; polled,
      // because the editor lays out 399 lines in its own time. Not through App.Editor.showLine on purpose:
      // whoever positions and whoever restores must not be the same function
      await esperar(`(App.Editor._impl.view.dispatch({ effects: window.CM6.EditorView.scrollIntoView(App.Editor._impl.view.state.doc.line(210).from, { y: 'start' }) }), App.Editor.topLine() > 100)`, 8000);
      const left = await js(`App.Editor.topLine()`, false);
      check('(o editor rolado pra longe do topo, com a leitura deixada no topo)', left > 100, left);

      deploy(6);
      await resume();
      const offered = await esperar(`document.getElementById('update-bar')?.classList.contains('hidden') === false`, 20000);
      await sleep(2000);
      check('a versao 6 assumiu, e o aviso apareceu', offered, await state());
      await js(`document.getElementById('update-bar')?.click(); 'ok'`);
      const reopened = await esperar(`window.__servedVersion === 6 && App.currentFile?.id === 'E' && document.body.dataset.view === 'edit'`, 20000);
      // The editor is put back on its line once the note is in: wait for it to have left the top.
      // A real regression (the editor staying on line 1) runs the limit out, and the check below still fails
      await esperar(`App.Editor.topLine() > 100`, 8000);
      const back = await js(`App.Editor.topLine()`, false);
      console.log('     linha do topo do editor, antes e depois:', JSON.stringify({ left, back }));
      check('tocar no aviso: recarregou, na versao 6, e reabriu a mesma nota no editor', reopened, await state());
      check('... na mesma linha do editor, a ate uma linha de onde estava', Math.abs(back - left) <= 1, { left, back });
    }
  } finally {
    browser.close();
    server.close();
  }
  done();
})().catch(e => { console.error('HARNESS ERROR', e); server.close(); process.exit(2); });
