// Runs the real app.js inside jsdom against an in-memory fake Drive: saving, conflicts, drafts,
// reading view, navigation, rename, login, formatting and the file browser.
//   npm test
// The editor here is the fallback textarea, except in scenario 40, which loads TinyMDE into the same
// window to drive its Enter handling. What needs layout, a real caret or a keyboard: browser.test.js.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { ROOT, LIBS, sleep, cdnVersions, installedVersions, reporter } = require('./helpers');

const { check, done } = reporter();

const FOLDER = 'application/vnd.google-apps.folder';
// A note saved inside the vault goes up with its dates (scenario 26); the other scenarios look at the text under them
const bodyOf = (content) => content.replace(/^---\n[\s\S]*?\n---\n\n?/, '');
// The browser and the attachment folder hang off whatever vault the app is configured with
const VAULT = /VAULT_FOLDER_ID: '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'))[1];

function makeDrive() {
  const drive = {
    files: new Map(), log: [], clock: 0, delay: 5, failWrites: false, failReads: false, nextId: 1,
    tick() { return `2026-09-19T10:00:${String(++this.clock).padStart(2, '0')}.000Z`; },
    put(id, name, content, parents = ['folderA']) {
      this.files.set(id, { id, name, content, parents, modifiedTime: this.tick() });
    },
    remoteEdit(id, content) { const f = this.files.get(id); f.content = content; f.modifiedTime = this.tick(); },
    count(method) { return this.log.filter(l => l.startsWith(method)).length; },
  };
  const json = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });
  drive.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const u = new URL(url);
    await sleep(drive.delay);
    const m = u.pathname.match(/files\/([^/?]+)$/);
    if (method === 'GET' && u.pathname.endsWith('/drive/v3/files')) {
      const q = u.searchParams.get('q');
      drive.log.push(`LIST ${q}`);
      const parent = /^'([^']+)' in parents/.exec(q);
      if (parent) {
        if (drive.failReads) return json({}, 500);
        const files = [...drive.files.values()].filter(f => f.parents.includes(parent[1]))
          .map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType || 'text/markdown', modifiedTime: f.modifiedTime }));
        return json({ files });
      }
      if (q.includes(' contains ')) {
        // Search, the way the Drive does it: a name matches on the start of a word, the text on a whole word
        drive.log.push(`SEARCH ${q}`);
        if (drive.failReads) return json({}, 500);
        const words = [...q.matchAll(/name contains '((?:[^'\\]|\\.)*)'/g)].map(x => x[1].replace(/\\(.)/g, '$1').toLowerCase());
        const tokens = (s) => String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        const hit = (f, word) => tokens(f.name).some(t => t.startsWith(word)) || f.name.toLowerCase().startsWith(word) || tokens(f.content).includes(word);
        const files = [...drive.files.values()].filter(f => f.mimeType !== FOLDER && words.every(word => hit(f, word)))
          .map(f => ({ id: f.id, name: f.name, parents: f.parents, mimeType: f.mimeType || 'text/markdown', modifiedTime: f.modifiedTime }));
        return json({ files });
      }
      const names = [...q.matchAll(/name = '((?:[^'\\]|\\.)*)'/g)].map(x => x[1].replace(/\\(.)/g, '$1'));
      const files = [...drive.files.values()].filter(f => names.includes(f.name))
        .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))
        .map(f => ({ id: f.id, name: f.name, parents: f.parents, mimeType: f.mimeType || 'text/markdown' }));
      return json({ files });
    }
    if (method === 'GET' && m) {
      if (drive.failReads) return json({}, 500);
      const f = drive.files.get(m[1]);
      if (!f) return json({}, 404);
      if (u.searchParams.get('alt') === 'media') {
        drive.log.push(`GET content ${f.id}`);
        return { ok: true, status: 200, text: async () => f.content, blob: async () => ({ fake: 'blob', of: f.id }) };
      }
      drive.log.push(`GET meta ${f.id}`);
      return json({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, parents: f.parents });
    }
    if (method === 'PATCH' && m && !u.pathname.startsWith('/upload/')) {
      if (drive.failWrites) return json({}, 500);
      const f = drive.files.get(m[1]);
      f.name = JSON.parse(opts.body).name; f.modifiedTime = drive.tick();
      drive.log.push(`RENAME ${f.id} ${f.name}`);
      return json({ id: f.id, name: f.name, modifiedTime: f.modifiedTime });
    }
    if (method === 'PATCH' && m) {
      if (drive.failWrites) return json({}, 500);
      const f = drive.files.get(m[1]);
      f.content = opts.body; f.modifiedTime = drive.tick();
      drive.log.push(`PATCH ${f.id}`);
      return json({ id: f.id, modifiedTime: f.modifiedTime });
    }
    if (method === 'POST') {
      if (drive.failWrites) return json({}, 500);
      const boundary = opts.headers['Content-Type'].split('boundary=')[1];
      // A note goes up as a string, a photo as a Blob
      const raw = typeof opts.body === 'string' ? opts.body : await new Promise(resolve => {
        const reader = new drive.FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsText(opts.body);
      });
      const parts = raw.split(`--${boundary}`);
      const meta = JSON.parse(parts[1].split('\r\n\r\n')[1]);
      const content = parts[2].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
      const mimeType = /Content-Type: (\S+)/.exec(parts[2])[1];
      const id = 'new' + drive.nextId++;
      drive.files.set(id, { id, name: meta.name, content, mimeType, parents: meta.parents, modifiedTime: drive.tick() });
      drive.log.push(`POST ${id} ${meta.name}`);
      const f = drive.files.get(id);
      return json({ id, name: f.name, parents: f.parents, modifiedTime: f.modifiedTime });
    }
    return json({}, 400);
  };
  return drive;
}

/** Stands in for the 2d context jsdom does not have: records what was painted, in order.
    Kept on the canvas so a resize (which really would reset the context) does not lose the log. */
function fakeCtx(canvas) {
  if (canvas.__ctx) return canvas.__ctx;
  const ops = [];
  const ctx = {
    ops, canvas,
    lineCap: '', lineJoin: '', lineWidth: 0, strokeStyle: '', globalCompositeOperation: 'source-over',
    scale: (x, y) => ops.push(`scale ${x},${y}`),
    clearRect: (x, y, w, h) => ops.push(`clear ${x},${y},${w},${h}`),
    beginPath: () => ops.push('begin'),
    moveTo: (x, y) => ops.push(`move ${x},${y}`),
    lineTo: (x, y) => ops.push(`line ${x},${y}`),
    stroke() { ops.push(`stroke ${this.strokeStyle} w=${this.lineWidth} ${this.globalCompositeOperation}`); },
    drawImage: (src, x, y) => ops.push(`drawImage ${src.width}x${src.height} at ${x},${y}`),
  };
  canvas.__ctx = ctx;
  return ctx;
}

async function boot({ auth = true, seedStorage = {}, watcher = false, editor = false } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  if (watcher) {
    // Stand-in for Chrome's CloseWatcher: w.__back() is the system back button
    w.__watchers = [];
    w.CloseWatcher = class {
      constructor() { w.__watchers.push(this); }
      destroy() { w.__watchers = w.__watchers.filter(x => x !== this); }
    };
    w.__back = () => { const top = w.__watchers.pop(); if (!top) return 'EXIT'; top.onclose(); return 'handled'; };
  }
  const drive = makeDrive();
  drive.FileReader = w.FileReader;
  w.fetch = drive.fetch;
  w.confirm = () => true;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  // jsdom has no canvas and no pointer capture: see drive-notes-aprendizados
  w.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(this); };
  w.HTMLCanvasElement.prototype.toBlob = function (cb, type) { cb(new w.Blob([`png ${this.width}x${this.height}`], { type: type || 'image/png' })); };
  w.Element.prototype.setPointerCapture = function () {};
  w.Element.prototype.releasePointerCapture = function () {};
  w.console = { log() {}, warn() {}, error() {} };
  for (const [k, v] of Object.entries(seedStorage)) w.localStorage.setItem(k, v);
  w.eval(fs.readFileSync(LIBS.marked, 'utf8'));
  w.eval(fs.readFileSync(LIBS.purify, 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8') + ';window.__App = App; window.__CONFIG = CONFIG;');
  await new Promise(r => w.document.readyState === 'complete' ? r() : w.addEventListener('load', r));
  const App = w.__App;
  if (auth) {
    App.accessToken = 'fake';
    w.localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
  }
  const type = (text) => {
    App.els.editorElement.value = text;
    App.els.editorElement.dispatchEvent(new w.Event('input'));
  };
  const drafts = () => App.listDrafts();
  if (editor) {
    // O jsdom nao tem layout: o CM6 mede texto por Range.getClientRects e estoura dentro de um
    // requestAnimationFrame (erro assincrono, barulhento, que nao quebra asserção mas polui).
    // Devolver lista vazia cala a medicao sem tocar no estado, que e o que os testes checam.
    const vazio = () => Object.assign([], { item: () => null });
    w.Range.prototype.getClientRects = vazio;
    w.Range.prototype.getBoundingClientRect = () => new w.DOMRect(0, 0, 0, 0);
    w.Element.prototype.getClientRects = vazio;
    w.eval(fs.readFileSync(LIBS.cm6, 'utf8'));
    const host = w.document.createElement('div');
    w.document.body.appendChild(host);
    App.els.editorElement = host;
    App.initEditor();
  }
  return { w, App, drive, type, drafts };
}

(async () => {
  console.log('0. Os testes usam as mesmas versoes de biblioteca que o app publicado');
  {
    const cdn = cdnVersions();
    const local = installedVersions();
    for (const name of Object.keys(cdn)) {
      check(`${name}: index.html ${cdn[name]} = package.json ${local[name]}`, !!cdn[name] && cdn[name] === local[name]);
    }
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    check('sw.js guarda no cache offline essas mesmas versoes', Object.keys(cdn).every(name => sw.includes(`${name}@${cdn[name]}/`)));
  }

  console.log('1. Trocar de arquivo com edicao pendente salva o arquivo anterior');
  {
    const { App, drive, type } = await boot();
    drive.put('A', 'a.md', 'conteudo A');
    drive.put('B', 'b.md', 'conteudo B');
    await App.openFile('A', 'a.md');
    check('A carregado, nao sujo', App.getContent() === 'conteudo A' && !App.isDirty);
    type('conteudo A editado');
    await App.openFile('B', 'b.md');
    await App._saveChain;
    check('A no Drive tem a edicao', drive.files.get('A').content === 'conteudo A editado', drive.files.get('A').content);
    check('editor mostra B, limpo', App.getContent() === 'conteudo B' && !App.isDirty && App.currentFile.id === 'B');
    check('B intocado no Drive', drive.files.get('B').content === 'conteudo B');
    check('nenhum rascunho sobrou', App.listDrafts().length === 0, App.listDrafts());

    type('B editado');
    App.newFile();
    await App._saveChain;
    check('nova nota com B sujo: B salvo', drive.files.get('B').content === 'B editado');
    check('nova nota criada uma vez', drive.count('POST') === 1, drive.log);
  }

  console.log('2. Abrir sem editar nao gera escrita');
  {
    const { App, drive } = await boot();
    drive.put('A', 'a.md', 'linha\r\ncom crlf\r\n');
    await App.openFile('A', 'a.md');
    await App.save();
    App.flushCurrent();
    await App._saveChain;
    check('zero PATCH', drive.count('PATCH') === 0, drive.log);
  }

  console.log('3. Conflito: Drive mudou depois de abrir');
  {
    const { App, drive, type, w } = await boot();
    drive.put('A', 'a.md', 'original');
    await App.openFile('A', 'a.md');
    drive.remoteEdit('A', 'editado no PC');
    type('editado no celular');
    await App.save();
    check('Drive NAO foi sobrescrito', drive.files.get('A').content === 'editado no PC');
    check('dialogo de conflito visivel', App.els.conflict.classList.contains('visible'));
    check('rascunho guardado com meu texto', App.listDrafts()[0]?.content === 'editado no celular');
    await App.save(); // autosave durante conflito
    check('autosave em conflito nao escreve', drive.count('PATCH') === 0);

    w.document.querySelector('[data-conflict="copy"]').click();
    await sleep(50); await App._saveChain;
    const copy = [...drive.files.values()].find(f => f.id !== 'A');
    check('copia criada com meu texto', copy?.content === 'editado no celular', copy);
    check('copia na mesma pasta do original', copy?.parents?.[0] === 'folderA', copy?.parents);
    check('nome da copia marca conflito', /^a \(conflito \d{4}-\d{2}-\d{2}-\d{4}\)\.md$/.test(copy?.name), copy?.name);
    check('original preservado', drive.files.get('A').content === 'editado no PC');
    check('arquivo atual e a copia, limpo', App.currentFile.id === copy.id && !App.isDirty);
    check('rascunho limpo', App.listDrafts().length === 0, App.listDrafts());
    check('dialogo fechado', !App.els.conflict.classList.contains('visible'));
  }

  console.log('4. Conflito: sobrescrever / recarregar / decidir depois');
  {
    const { App, drive, type, w } = await boot();
    drive.put('A', 'a.md', 'original');
    await App.openFile('A', 'a.md');
    drive.remoteEdit('A', 'PC');
    type('celular');
    await App.save();
    w.document.querySelector('[data-conflict="later"]').click();
    await sleep(10);
    check('depois: nada escrito, continua sujo', drive.files.get('A').content === 'PC' && App.isDirty);
    await App.save({ manual: true });
    check('salvar manual reabre o dialogo', App.els.conflict.classList.contains('visible'));
    w.document.querySelector('[data-conflict="overwrite"]').click();
    await sleep(50); await App._saveChain;
    check('sobrescrever: Drive tem meu texto', drive.files.get('A').content === 'celular');
    check('limpo e sem rascunho', !App.isDirty && App.listDrafts().length === 0);
    type('celular 2');
    await App.save();
    check('save seguinte passa sem conflito', drive.files.get('A').content === 'celular 2');

    drive.remoteEdit('A', 'PC de novo');
    type('celular 3');
    await App.save();
    w.document.querySelector('[data-conflict="reload"]').click();
    await sleep(80);
    check('recarregar: editor tem a versao do Drive', App.getContent() === 'PC de novo' && !App.isDirty, App.getContent());
    check('Drive intacto, sem rascunho', drive.files.get('A').content === 'PC de novo' && App.listDrafts().length === 0);
  }

  console.log('5. Nota nova sem login, depois com login: um arquivo so, sem rascunho orfao');
  {
    const { App, drive, type } = await boot({ auth: false });
    App.newFile();
    type('ideia');
    await App.save();
    check('sem login: virou rascunho, segue marcado como nao salvo', App.listDrafts().length === 1 && App.isDirty);
    App.accessToken = 'fake';
    App.els.fileName.ownerDocument.defaultView.localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
    await App.save();
    check('criado uma vez no Drive', drive.count('POST') === 1 && bodyOf([...drive.files.values()][0].content) === 'ideia', drive.log);
    check('rascunho limpo depois de sincronizar', App.listDrafts().length === 0, App.listDrafts());
    type('ideia 2');
    await App.save();
    check('save seguinte e PATCH, nao outro POST', drive.count('POST') === 1 && drive.count('PATCH') === 1, drive.log);
  }

  console.log('6. Corrida: criar em andamento + saves simultaneos + app indo pro fundo');
  {
    const { App, drive, type } = await boot();
    drive.delay = 40;
    App.newFile();               // POST em andamento
    type('t1');
    App.saveDraft();             // o que o visibilitychange faz
    const p1 = App.save();
    type('t1 t2');
    const p2 = App.save();
    await Promise.all([p1, p2]); await App._saveChain;
    const all = [...drive.files.values()];
    check('um arquivo so', all.length === 1 && drive.count('POST') === 1, drive.log);
    check('conteudo final e o mais novo', bodyOf(all[0].content) === 't1 t2', all[0].content);
    check('limpo, sem rascunho', !App.isDirty && App.listDrafts().length === 0, App.listDrafts());
  }

  console.log('7. Rascunho escrito durante o create ganha o ID (nao duplica ao reabrir)');
  {
    const a = await boot();
    a.drive.delay = 40;
    a.App.newFile();
    a.type('texto');
    a.App.saveDraft();           // fileId ainda null
    await a.App._saveChain;      // create termina
    const d = a.App.listDrafts()[0];
    check('rascunho agora aponta pro arquivo criado', d && d.fileId === 'new1' && !!d.baseModifiedTime, d);
    // "reinicia o app": abre o rascunho e salva
    a.App.currentFile = null; a.App.isDirty = false;
    a.App.openDraft(d.key);
    await a.App.save();
    check('salvar o rascunho faz PATCH, nao um segundo POST', a.drive.count('POST') === 1 && bodyOf(a.drive.files.get('new1').content) === 'texto', a.drive.log);
    check('rascunho limpo', a.App.listDrafts().length === 0);
  }

  console.log('8. Falha do Drive: texto vira rascunho, aparece na tela inicial, volta ao reabrir');
  {
    const { App, drive, type, w } = await boot();
    drive.put('A', 'a.md', 'original');
    await App.openFile('A', 'a.md');
    drive.failWrites = true;
    type('sem rede');
    await App.save();
    check('status de erro, rascunho guardado, segue sujo', App.els.saveStatus.textContent === 'Erro: salvo local' && App.listDrafts().length === 1 && App.isDirty);
    App.renderDrafts();
    check('secao "Nao sincronizados" visivel com 1 item', !w.document.getElementById('drafts-list').classList.contains('hidden') && w.document.querySelectorAll('#drafts-ul li').length === 1);
    drive.failWrites = false;
    App.currentFile = null; App.isDirty = false; // simula reinicio
    await App.openFile('A', 'a.md');
    check('reabrir prefere o rascunho e marca sujo', App.getContent() === 'sem rede' && App.isDirty);
    await App.save();
    check('sincroniza sem conflito (Drive nao mudou)', drive.files.get('A').content === 'sem rede' && App.listDrafts().length === 0);
  }

  console.log('9. Texto digitado durante o save nao e marcado como salvo');
  {
    const { App, drive, type } = await boot();
    drive.put('A', 'a.md', 'x');
    await App.openFile('A', 'a.md');
    drive.delay = 40;
    type('x1');
    const p = App.save();
    await sleep(20);
    type('x12');
    await p;
    check('continua sujo', App.isDirty && drive.files.get('A').content === 'x1');
    await App.save();
    check('segundo save leva o resto', !App.isDirty && drive.files.get('A').content === 'x12');
  }

  console.log('10. Falha ao carregar nao troca o arquivo atual');
  {
    const { App, drive, type } = await boot();
    drive.put('A', 'a.md', 'A');
    drive.put('B', 'b.md', 'B');
    await App.openFile('A', 'a.md');
    drive.failReads = true;
    await App.openFile('B', 'b.md');
    check('atual continua A', App.currentFile.id === 'A' && App.getContent() === 'A');
    drive.failReads = false;
    type('A2');
    await App.save();
    check('save vai pro A, B intacto', drive.files.get('A').content === 'A2' && drive.files.get('B').content === 'B');
  }

  console.log('11. Tela inicial e rascunhos de versoes antigas');
  {
    const empty = await boot();
    check('sem rascunho: secao escondida', empty.w.document.getElementById('drafts-list').classList.contains('hidden'));
    check('botao "Rascunho local" nao existe mais', !empty.w.document.getElementById('welcome-draft'));
    const legacy = await boot({ seedStorage: {
      drivenotes_draft_new: JSON.stringify({ name: 'velho.md', content: 'orfao', timestamp: Date.now() - 5000, fileId: null }),
      drivenotes_draft_latest: 'drivenotes_draft_new',
      drivenotes_draft_XYZ: JSON.stringify({ name: 'x.md', content: '', timestamp: 1, fileId: 'XYZ' }),
    } });
    const items = legacy.w.document.querySelectorAll('#drafts-ul li');
    check('rascunho antigo listado, vazio ignorado', items.length === 1 && items[0].textContent.includes('velho.md'), items.length);
    check('ponteiro antigo removido', legacy.w.localStorage.getItem('drivenotes_draft_latest') === null);
    const ld = legacy.w.document;
    items[0].querySelector('.recent-remove').click(); await sleep(10);
    check('descartar abre o dialogo do app, com o nome da nota', ld.getElementById('confirm-overlay').classList.contains('visible') && ld.getElementById('confirm-text').textContent.includes('velho.md') && ld.getElementById('confirm-ok').textContent === 'Descartar');
    ld.getElementById('confirm-cancel').click(); await sleep(10);
    check('cancelar mantem o rascunho', ld.querySelectorAll('#drafts-ul li').length === 1 && !ld.getElementById('confirm-overlay').classList.contains('visible'));
    ld.querySelector('#drafts-ul .recent-remove').click(); await sleep(10);
    ld.getElementById('confirm-ok').click(); await sleep(10);
    check('descartar remove da lista e do storage', legacy.w.document.querySelectorAll('#drafts-ul li').length === 0 && legacy.w.localStorage.getItem('drivenotes_draft_new') === null);
  }

  console.log('12. Preview sanitizado');
  {
    const { App, drive, w } = await boot();
    drive.put('A', 'a.md', '# Titulo\n\n<img src=x onerror="window.__pwned=1">\n\n<script>window.__pwned=2</script>\n\n[ok](https://example.com) **negrito**');
    await App.openFile('A', 'a.md');
    App.setMode('preview');
    const html = App.els.previewContainer.innerHTML;
    check('markdown renderizado', html.includes('<h1') && html.includes('<strong>negrito</strong>') && html.includes('href="https://example.com"'));
    check('onerror e <script> removidos', !/onerror|<script/i.test(html) && w.__pwned === undefined, html);
    const saved = w.DOMPurify; w.eval('DOMPurify = undefined');
    App.setMode('preview');
    check('sem DOMPurify: texto puro, nenhum HTML', App.els.previewContainer.children.length === 0 && App.els.previewContainer.textContent.includes('<img'));
    w.DOMPurify = saved;
  }

  console.log('13. login_hint');
  {
    const { App, w } = await boot();
    check('sem hint: so prompt', JSON.stringify(App.tokenRequest('')) === '{"prompt":""}');
    w.localStorage.setItem('drivenotes_login_hint', 'x@example.com');
    check('com hint guardado', App.tokenRequest('consent').login_hint === 'x@example.com');
  }

  console.log('14. Abre em leitura; nota nova abre em edicao');
  {
    const { App, drive, w } = await boot();
    const view = () => w.document.body.dataset.view;
    check('inicio: view welcome', view() === 'welcome');
    drive.put('A', 'a.md', '# A');
    await App.openFile('A', 'a.md');
    check('arquivo aberto em leitura', view() === 'preview' && App.mode === 'preview' && App.els.previewContainer.classList.contains('visible') && App.els.editorContainer.classList.contains('hidden'));
    check('botao oferece "Editar"', App.els.btnPreview.textContent === 'Editar');
    App.els.btnPreview.click();
    check('toggle vai pra edicao, botao "Ler"', view() === 'edit' && App.els.btnPreview.textContent === 'Ler' && !App.els.editorContainer.classList.contains('hidden'));
    check('abrir e alternar nao sujou nem escreveu', !App.isDirty && drive.count('PATCH') === 0);
    App.newFile();
    check('nota nova em edicao', view() === 'edit');
    await App._saveChain;
  }

  console.log('15. Frontmatter');
  {
    const { App, drive } = await boot();
    drive.put('A', 'a.md', '---\ntitle: Minha nota\ntags: [a, b]\n---\n\n# Corpo\n\ntexto\n\n---\n\nfim');
    await App.openFile('A', 'a.md');
    const c = App.els.previewContainer;
    const fm = c.querySelector('details.frontmatter');
    check('bloco Propriedades recolhido com o YAML cru', fm && !fm.open && fm.querySelector('pre').textContent === 'title: Minha nota\ntags: [a, b]', fm?.outerHTML);
    check('YAML nao virou titulo', ![...c.querySelectorAll('h1,h2')].some(h => h.textContent.includes('title:')));
    check('corpo renderizado, hr do meio preservado', c.querySelector('h1')?.textContent === 'Corpo' && c.querySelectorAll('hr').length === 1);
    check('conteudo do arquivo intacto', App.getContent().startsWith('---\ntitle: Minha nota'));
    drive.put('B', 'b.md', 'sem front\n\n---\n\nso um hr');
    await App.openFile('B', 'b.md');
    check('nota sem frontmatter: sem bloco', !c.querySelector('.frontmatter') && c.querySelectorAll('hr').length === 1);
  }

  console.log('16. Wikilinks: renderizacao');
  {
    const { App, drive } = await boot();
    drive.put('A', 'a.md', [
      'Veja [[Nota B]] e [[Nota B|apelido]] e [[pasta/Nota B#Secao Dois]].',
      '', 'Codigo: `[[nao link]]`', '', '![[foto.png]]', '', '[[#Local]]', '',
      '| col |', '| --- |', '| [[Nota B\\|na tabela]] |', '',
      '```', '[[em bloco]]', '```', '', '[[<img src=x onerror=1>]]',
    ].join('\n'));
    await App.openFile('A', 'a.md');
    const c = App.els.previewContainer;
    const links = [...c.querySelectorAll('a.wikilink')];
    check('6 wikilinks (o ultimo com HTML escapado)', links.length === 6 && links[5].textContent === '<img src=x onerror=1>', links.map(l => l.outerHTML));
    check('simples', links[0].textContent === 'Nota B' && links[0].dataset.target === 'Nota B');
    check('com apelido', links[1].textContent === 'apelido' && links[1].dataset.target === 'Nota B');
    check('com pasta e titulo', links[2].dataset.target === 'pasta/Nota B' && links[2].dataset.heading === 'Secao Dois');
    check('so titulo local', links[3].dataset.target === '' && links[3].dataset.heading === 'Local');
    check('dentro de tabela com \\|', links[4].textContent === 'na tabela' && links[4].dataset.target === 'Nota B' && !!links[4].closest('td'));
    check('codigo intocado', c.querySelector('p code').textContent === '[[nao link]]' && c.querySelector('pre code').textContent.includes('[[em bloco]]'));
    check('HTML dentro de wikilink nao vira elemento', !c.querySelector('img:not([data-embed])'), c.innerHTML.slice(-200));
    await sleep(60);
    check('embed de imagem que nao existe no Drive vira rotulo', !c.querySelector('img') && c.querySelector('.wikilink-file')?.textContent === 'foto.png', c.innerHTML.slice(0, 300));
  }

  console.log('16b. Imagem embutida: ![[foto.jpg]] carrega do Drive');
  {
    const { App, drive, w } = await boot();
    const made = [];
    w.URL.createObjectURL = (blob) => { made.push(blob.of); return `blob:fake/${blob.of}`; };
    drive.put('media', '_media', '', [VAULT]); drive.files.get('media').mimeType = FOLDER;
    const image = (id, name, parent, type = 'image/jpeg') => { drive.put(id, name, 'bin', [parent]); drive.files.get(id).mimeType = type; };
    image('I1', 'foto.jpg', 'media');
    image('D1', 'repetida.png', 'media', 'image/png');
    image('D2', 'repetida.png', 'folderZ', 'image/png'); // mais nova: sem a regra do _media, ganharia
    drive.put('P', 'doc.pdf', 'bin', ['media']); drive.files.get('P').mimeType = 'application/pdf';
    drive.put('A', 'a.md', '![[foto.jpg]]\n\n![[foto.jpg|300]]\n\n![[_media/repetida.png|legenda]]\n\n![[doc.pdf]]\n\n![[sumiu.webp]]');
    await App.openFile('A', 'a.md');
    const c = App.els.previewContainer;
    await sleep(120);
    const imgs = [...c.querySelectorAll('img')];
    check('3 imagens com src de blob', imgs.length === 3 && imgs.every(i => i.getAttribute('src')?.startsWith('blob:fake/')), c.innerHTML);
    check('mesma foto duas vezes: baixada uma vez so', made.filter(id => id === 'I1').length === 1 && drive.count('GET content I1') === 1, made);
    check('|300 vira largura, nao legenda', imgs[1].getAttribute('width') === '300' && imgs[1].alt === 'foto.jpg');
    check('|texto vira legenda (alt)', imgs[2].alt === 'legenda' && !imgs[2].hasAttribute('width'));
    check('nome repetido: ganha a que esta no _media', imgs[2].getAttribute('src') === 'blob:fake/D1', imgs[2].outerHTML);
    check('pasta _media lembrada no aparelho', w.localStorage.getItem('drivenotes_media_folder') === 'media');
    const labels = [...c.querySelectorAll('.wikilink-file')].map(l => l.textContent);
    check('pdf e imagem sumida ficam como rotulo', labels.join('|') === 'doc.pdf|sumiu.webp', labels);

    const gets = drive.count('GET content');
    App.setMode('edit'); App.setMode('preview');
    await sleep(60);
    check('voltar pro modo leitura reaproveita as imagens ja baixadas', drive.count('GET content') === gets && c.querySelectorAll('img[src]').length === 3);

    App.accessToken = null;
    image('I2', 'outra.jpg', 'media');
    App.currentFile = null; App.els.editorElement.value = '![[outra.jpg]]';
    const lists = drive.count('LIST');
    App.renderPreview();
    await sleep(60);
    check('sem login: nao procura nem abre popup, fica o rotulo', drive.count('LIST') === lists && c.querySelector('.wikilink-file')?.textContent === 'outra.jpg', c.innerHTML);
  }

  console.log('16c. Foto na nota: sobe pro _media e so depois entra o ![[...]]');
  {
    const { App, drive, w } = await boot();
    w.URL.createObjectURL = () => 'blob:fake/local';
    drive.put('media', '_media', '', [VAULT]); drive.files.get('media').mimeType = FOLDER;
    drive.put('A', 'a.md', 'linha um\nlinha dois');
    drive.put('B', 'b.md', 'outra nota');
    await App.openFile('A', 'a.md');
    App.setMode('edit');
    const ta = App.els.editorElement;
    const photo = () => new w.File(['bytes-da-foto'], 'IMG_1234.JPG', { type: 'image/jpeg' });
    const uploaded = () => [...drive.files.values()].filter(f => /^foto-/.test(f.name));

    const opened = [];
    App.els.photoInput.click = () => { opened.push(App.els.photoInput.getAttribute('capture')); };
    w.document.querySelector('[data-photo="camera"]').click();
    w.document.querySelector('[data-photo="gallery"]').click();
    check('botao da camera pede a camera, o da galeria nao', opened.length === 2 && opened[0] === 'environment' && opened[1] === null, opened);
    App.setMode('preview');
    w.document.querySelector('[data-photo="camera"]').click();
    check('fora da edicao os botoes nao fazem nada', opened.length === 2);
    App.setMode('edit');

    ta.selectionStart = ta.selectionEnd = 'linha um'.length;
    await App.insertPhoto(photo());
    const up = uploaded()[0];
    check('foto no _media, com nome foto-data-hora.jpg', uploaded().length === 1 && up.parents[0] === 'media' && /^foto-\d{4}-\d{2}-\d{2}-\d{6}\.jpg$/.test(up.name), up);
    check('conteudo e tipo chegaram inteiros', up.content === 'bytes-da-foto' && up.mimeType === 'image/jpeg', up);
    const pngBlob = new w.Blob(['x'], { type: 'image/png' });
    const drawn = App.mediaName(pngBlob, null, 'desenho');
    check('mediaName carimba o prefixo e tira a extensao do tipo', /^desenho-\d{4}-\d{2}-\d{2}-\d{6}\.png$/.test(drawn), drawn);
    check('embed em linha propria, no cursor', ta.value === `linha um\n![[${up.name}]]\n\nlinha dois`, ta.value);
    check('nota ficou suja pra salvar', App.isDirty && App.els.saveStatus.textContent === 'Foto inserida');
    const gets = drive.count('GET content');
    App.setMode('preview');
    await sleep(40);
    check('modo leitura mostra a foto sem baixar de volta', App.els.previewContainer.querySelector('img')?.getAttribute('src') === 'blob:fake/local' && drive.count('GET content') === gets);
    await App.save(); await App._saveChain;

    App.setMode('edit');
    drive.failWrites = true;
    const before = ta.value;
    await App.insertPhoto(photo());
    check('upload falhou: nada entra na nota, erro na tela', ta.value === before && uploaded().length === 1 && App.els.saveStatus.textContent === 'Erro ao enviar a foto', ta.value);
    drive.failWrites = false;

    const slow = App.insertPhoto(photo());
    await App.openFile('B', 'b.md');
    await slow;
    check('trocou de nota durante o envio: a outra nota fica intacta', App.getContent() === 'outra nota' && uploaded().length === 2 && /mas a nota mudou/.test(App.els.saveStatus.textContent), App.els.saveStatus.textContent);

    drive.files.delete('media'); w.localStorage.removeItem('drivenotes_media_folder');
    App.setMode('edit');
    await App.insertPhoto(photo());
    check('sem pasta _media no vault: avisa e nao sobe', uploaded().length === 2 && /_media/.test(App.els.saveStatus.textContent), App.els.saveStatus.textContent);
  }

  console.log('16d. Galeria: varias fotos de uma vez, em fila');
  {
    const { App, drive, w } = await boot();
    w.URL.createObjectURL = () => 'blob:fake/local';
    drive.put('media', '_media', '', [VAULT]); drive.files.get('media').mimeType = FOLDER;
    drive.put('A', 'a.md', 'linha um');
    await App.openFile('A', 'a.md');
    App.setMode('edit');
    const ta = App.els.editorElement;
    const photo = (n) => new w.File([`bytes-${n}`], `IMG_${n}.JPG`, { type: 'image/jpeg' });
    const uploaded = () => [...drive.files.values()].filter(f => /^foto-/.test(f.name));
    // O seletor devolve uma FileList; aqui basta a lista que o app percorre
    const pick = (...files) => {
      Object.defineProperty(App.els.photoInput, 'files', { configurable: true, value: files });
      App.els.photoInput.dispatchEvent(new w.Event('change'));
    };

    const many = [];
    App.els.photoInput.click = () => many.push(App.els.photoInput.hasAttribute('multiple'));
    w.document.querySelector('[data-photo="gallery"]').click();
    w.document.querySelector('[data-photo="camera"]').click();
    check('galeria aceita varias, camera continua uma por vez', many.join('|') === 'true|false', many);

    // Um envio por vez: contar quantos POST ficam no ar ao mesmo tempo
    const real = w.fetch;
    let flying = 0, most = 0;
    w.fetch = async (url, opts = {}) => {
      if (opts.method !== 'POST') return real(url, opts);
      most = Math.max(most, ++flying);
      try { return await real(url, opts); } finally { flying--; }
    };

    ta.selectionStart = ta.selectionEnd = ta.value.length;
    pick(photo(1), photo(2), photo(3));
    await sleep(300);
    const names = uploaded().map(f => f.name);
    check('as tres subiram, uma de cada vez, na ordem escolhida', most === 1 && uploaded().map(f => f.content).join('|') === 'bytes-1|bytes-2|bytes-3', uploaded());
    check('tres embeds, um por linha, na mesma ordem', ta.value === `linha um\n![[${names[0]}]]\n![[${names[1]}]]\n![[${names[2]}]]\n`, ta.value);
    check('nomes da mesma leva nao se repetem', names.length === 3 && new Set(names).size === 3, names);
    const jpeg = new w.Blob(['x'], { type: 'image/jpeg' });
    const taken = new Set();
    const leva = [App.mediaName(jpeg, null, 'foto', taken), App.mediaName(jpeg, null, 'foto', taken), App.mediaName(jpeg, null, 'foto', taken)];
    check('no mesmo segundo, a segunda e a terceira ganham -2 e -3', /^foto-\d{4}-\d{2}-\d{2}-\d{6}\.jpg$/.test(leva[0])
      && leva[1] === leva[0].replace('.jpg', '-2.jpg') && leva[2] === leva[0].replace('.jpg', '-3.jpg'), leva);

    // No celular o editor volta do seletor sem cursor: cada foto tem que cair embaixo da anterior,
    // nao todas na posicao guardada (a ultima ficaria em cima)
    const fake = {
      lines: ['linha um', ''],
      getSelection: () => null,
      paste(text, pos) {
        const head = this.lines.slice(0, pos.row).concat(this.lines[pos.row].slice(0, pos.col)).join('\n');
        this.lines = (head + text + this.lines[pos.row].slice(pos.col) + this.lines.slice(pos.row + 1).map(l => '\n' + l).join('')).split('\n');
      },
    };
    const editorBefore = App.editor;
    const implBefore = App.Editor._impl;
    App.editor = fake;
    App.Editor._impl = App.apiTinyMDE(fake);
    let at = { row: 1, col: 0 };
    for (const n of [1, 2, 3]) at = App.insertOnOwnLine(`![[f${n}]]`, at) || at;
    App.editor = editorBefore;
    App.Editor._impl = implBefore;
    check('sem cursor no editor, a fila continua na ordem', fake.lines.join('\n') === 'linha um\n![[f1]]\n![[f2]]\n![[f3]]\n', fake.lines);

    // Erro no meio: o que ja entrou fica, o resto nem sobe
    const kept = ta.value;
    const had = uploaded().length;
    let posts = 0;
    w.fetch = async (url, opts = {}) => (opts.method === 'POST' && ++posts === 2)
      ? { ok: false, status: 500, json: async () => ({}), text: async () => '' }
      : real(url, opts);
    pick(photo(4), photo(5), photo(6));
    await sleep(300);
    check('falha no meio: a fila para e o que subiu continua na nota', posts === 2 && uploaded().length === had + 1
      && ta.value === `${kept}![[${uploaded().pop().name}]]\n` && App.els.saveStatus.textContent === 'Erro ao enviar a foto', ta.value);
    w.fetch = real;
  }

  console.log('17. Wikilinks: navegacao e voltar');
  {
    const { App, drive, w } = await boot();
    const view = () => w.document.body.dataset.view;
    drive.put('A', 'a.md', 'vai [[Nota B#Alvo]] e [[Sumida]] e [[Planilha.xlsx]] e [[O\'Brien]]', ['folderA']);
    drive.put('B1', 'Nota B.md', 'B de outra pasta', ['folderZ']);
    drive.put('B2', 'Nota B.md', '# Topo\n\ntexto\n\n## Alvo\n\naqui', ['folderA']);
    drive.put('OB', "O'Brien.md", 'apostrofo', ['folderZ']);
    drive.put('X', 'Planilha.xlsx', 'bin', ['folderA']); drive.files.get('X').mimeType = 'application/vnd.ms-excel';
    drive.remoteEdit('B1', 'B de outra pasta'); // B1 mais recente: sem a regra da pasta, ganharia
    let scrolled = null;
    w.HTMLElement.prototype.scrollIntoView = function () { scrolled = this.textContent; };

    const len0 = w.history.length;
    await App.navigateTo('A', 'a.md');
    check('abrir cria 1 entrada de historico com a nota', w.history.length === len0 + 1 && w.history.state.id === 'A', w.history.state);
    const click = async (i) => { App.els.previewContainer.querySelectorAll('a.wikilink')[i].click(); await sleep(80); };
    App.els.previewContainer.querySelectorAll('a.wikilink')[0].click();
    check('entrada criada DENTRO do toque, antes de qualquer espera', w.history.length === len0 + 2);
    await sleep(80);
    check('abre a nota da MESMA pasta', App.currentFile.id === 'B2', App.currentFile);
    check('em leitura, rolou ate o titulo', view() === 'preview' && scrolled === 'Alvo', scrolled);
    check('entrada atual descreve B2', w.history.state.view === 'file' && w.history.state.id === 'B2', w.history.state);

    App.els.btnBack.click(); await sleep(80);
    check('voltar: de volta em A', App.currentFile.id === 'A' && view() === 'preview' && w.history.state.id === 'A');

    await click(1);
    check('nota inexistente: avisa e fica onde esta', App.currentFile.id === 'A' && App.els.saveStatus.textContent === 'Nota não encontrada: Sumida', App.els.saveStatus.textContent);
    check('entrada do toque frustrado foi desfeita', w.history.state.id === 'A', w.history.state);
    await click(2);
    check('arquivo nao texto: avisa', App.currentFile.id === 'A' && App.els.saveStatus.textContent === 'Não abro esse tipo: Planilha.xlsx', App.els.saveStatus.textContent);
    await click(3);
    check('nome com apostrofo e encontrado', App.currentFile.id === 'OB', drive.log.filter(l => l.startsWith('LIST')).pop());

    w.history.back(); await sleep(80); // gesto de voltar do sistema
    check('gesto do sistema: volta pra A', App.currentFile.id === 'A');
    App.els.btnBack.click(); await sleep(80);
    check('voltar de novo: tela inicial com recentes', view() === 'welcome' && App.currentFile === null && w.document.querySelectorAll('#recents-ul li').length >= 2 && App.els.fileName.textContent === 'Drive Notes');
    check('nada foi escrito no Drive', drive.count('PATCH') === 0 && drive.count('POST') === 0);
  }

  console.log('18. Voltar com edicao pendente salva antes');
  {
    const { App, drive, type, w } = await boot();
    drive.put('A', 'a.md', 'A');
    await App.navigateTo('A', 'a.md');
    type('A editado');
    App.els.btnBack.click(); await sleep(80); await App._saveChain; await sleep(10);
    check('salvou no Drive', drive.files.get('A').content === 'A editado');
    check('tela inicial, sem "Nao sincronizados" sobrando', w.document.body.dataset.view === 'welcome' && w.document.getElementById('drafts-list').classList.contains('hidden'));
  }

  console.log('19. Callouts, tabelas, tarefas, links');
  {
    const { App, drive, w } = await boot();
    drive.put('A', 'a.md', [
      '> [!warning] Cuidado aqui', '> corpo do aviso', '',
      '> [!note]', '> sem titulo', '',
      '> citacao normal', '',
      '| a | b |', '| - | - |', '| 1 | 2 |', '',
      '- [ ] fazer', '- [x] feito', '',
      '[fora](https://example.com) [outra](Outra%20Nota.md#Parte) [ancora](#Parte)',
    ].join('\n'));
    drive.put('O', 'Outra Nota.md', '## Parte\n\nx');
    await App.openFile('A', 'a.md');
    const c = App.els.previewContainer;
    const callouts = [...c.querySelectorAll('blockquote.callout')];
    check('2 callouts, citacao normal intocada', callouts.length === 2 && c.querySelectorAll('blockquote').length === 3);
    check('titulo e tipo', callouts[0].dataset.callout === 'warning' && callouts[0].querySelector('.callout-title').textContent === 'Cuidado aqui');
    check('marcador [!..] sumiu, corpo ficou', !callouts[0].textContent.includes('[!') && callouts[0].textContent.includes('corpo do aviso'));
    check('sem titulo usa o tipo', callouts[1].querySelector('.callout-title').textContent === 'Note' && callouts[1].textContent.includes('sem titulo'));
    check('tabela embrulhada pra rolar', c.querySelector('.table-wrap > table') && c.querySelectorAll('td').length === 2);
    check('checkboxes renderizados', c.querySelectorAll('li > input[type="checkbox"]').length === 2 && c.querySelectorAll('input:checked').length === 1);
    let opened = null; w.open = (href) => { opened = href; };
    const as = [...c.querySelectorAll('a:not(.wikilink)')];
    as[0].click();
    check('link externo abre fora do app', opened === 'https://example.com/' || opened === 'https://example.com', opened);
    as[1].click(); await sleep(80);
    check('link relativo .md abre a nota', App.currentFile.id === 'O', App.currentFile);
  }

  console.log('20. Navegacao: toque nos recentes, falha de carregamento, nota nova');
  {
    const { App, drive, w } = await boot({ seedStorage: {
      drivenotes_recents: JSON.stringify([{ id: 'A', name: 'a.md', timestamp: Date.now() }]),
    } });
    drive.put('A', 'a.md', 'A');
    check('entrada inicial marcada como welcome', w.history.state?.view === 'welcome', w.history.state);
    const len0 = w.history.length;
    drive.failReads = true;
    w.document.querySelector('#recents-ul .recent-name').click();
    check('toque no recente cria a entrada na hora', w.history.length === len0 + 1);
    await sleep(120);
    check('falhou: entrada desfeita, segue na tela inicial com o erro visivel', w.history.state.view === 'welcome' && w.document.body.dataset.view === 'welcome' && App.els.saveStatus.textContent === 'Erro ao carregar', [w.history.state, App.els.saveStatus.textContent]);
    drive.failReads = false;
    w.document.querySelector('#recents-ul .recent-name').click(); await sleep(80);
    check('agora abre', App.currentFile?.id === 'A' && w.history.state.id === 'A');
    App.els.btnNew.click();
    check('nota nova: entrada propria, ainda sem ID', w.history.state.view === 'file' && w.history.state.id === null, w.history.state);
    await App._saveChain;
    check('depois de criada, a entrada ganha o ID', w.history.state.id === 'new1', w.history.state);
    w.history.back(); await sleep(80);
    check('voltar da nota nova: volta pra A', App.currentFile?.id === 'A');
    w.history.back(); await sleep(80);
    check('voltar de novo: tela inicial', w.document.body.dataset.view === 'welcome' && App.currentFile === null);
  }

  console.log('21. Renomear');
  {
    const { App, drive, type, w } = await boot();
    drive.put('A', 'a.md', 'A');
    await App.navigateTo('A', 'a.md');
    App.els.fileName.click();
    check('toque no titulo abre o modal com o nome', App.els.modal.classList.contains('visible') && App.els.modalInput.value === 'a.md' && App.els.modalConfirm.textContent === 'Renomear');
    App.els.modalInput.value = '  Plano: fase 2/3  ';
    App.els.modalConfirm.click(); await sleep(80);
    check('Drive renomeado, caracteres invalidos fora, extensao mantida', drive.files.get('A').name === 'Plano fase 23.md', drive.files.get('A').name);
    check('cabecalho, recentes e historico atualizados', App.els.fileName.textContent === 'Plano fase 23.md' && App.getRecents()[0].name === 'Plano fase 23.md' && w.history.state.name === 'Plano fase 23.md');
    type('A editado');
    await App.save();
    check('salvar depois de renomear: sem falso conflito', drive.files.get('A').content === 'A editado' && !App.els.conflict.classList.contains('visible'));

    drive.remoteEdit('A', 'mudou no PC');
    await App.renameFile(App.currentFile, 'Outro nome');
    type('A editado 2');
    await App.save();
    check('renomear nao esconde conflito real', App.els.conflict.classList.contains('visible') && drive.files.get('A').content === 'mudou no PC');
    App.resolveConflict('later');

    await App.renameFile(App.currentFile, '   ');
    check('nome vazio e ignorado', App.currentFile.name === 'Outro nome.md');
    drive.failWrites = true;
    await App.renameFile(App.currentFile, 'Vai falhar');
    check('falha no Drive: nome volta ao anterior', App.currentFile.name === 'Outro nome.md' && App.els.fileName.textContent === 'Outro nome.md' && App.els.saveStatus.textContent === 'Erro ao renomear');

    const b = await boot({ auth: false });
    b.App.newFile(); b.type('x');
    await b.App.renameFile(b.App.currentFile, 'Ideia boa');
    b.App.accessToken = 'fake'; b.w.localStorage.setItem('drivenotes_token_expires', String(Date.now() + 3600e3));
    await b.App.save();
    check('nota ainda nao criada: nasce ja com o nome novo', [...b.drive.files.values()][0]?.name === 'Ideia boa.md' && b.drive.count('RENAME') === 0, b.drive.log);
  }

  console.log('22. Login expirado');
  {
    const { App, drive, type, w } = await boot();
    drive.put('A', 'a.md', 'A');
    await App.openFile('A', 'a.md');
    w.localStorage.setItem('drivenotes_token_expires', String(Date.now() - 1000));
    let popups = 0;
    App.tokenClient = { requestAccessToken() { popups++; setTimeout(() => App.tokenClient.callback({ access_token: 'novo', expires_in: 3600 }), 5); } };
    w.eval('window.gapi = { client: { setToken() {} } }');
    const before = drive.log.length;
    type('digitado com login vencido');
    await App.save(); // autosave
    check('autosave: nenhum popup, nenhuma requisicao, rascunho guardado', popups === 0 && drive.log.length === before && App.listDrafts().length === 1);
    check('avisa pra tocar em salvar', App.els.saveStatus.textContent === 'Login expirou: toque em salvar' && App.isDirty);
    await App.save({ manual: true });
    check('salvar manual: renova o login e sincroniza', popups === 1 && App.accessToken === 'novo' && drive.files.get('A').content === 'digitado com login vencido');
    check('limpo, rascunho removido', !App.isDirty && App.listDrafts().length === 0);
  }

  console.log('23. Formatacao (editor de fallback)');
  {
    const { App } = await boot();
    const t = (line, p) => App.toggleLinePrefix(line, p);
    check('titulo em linha comum', t('texto', '## ') === '## texto');
    check('titulo de novo remove', t('## texto', '## ') === 'texto' && t('# outro', '## ') === 'outro');
    check('lista vira checklist e volta', t('- item', '- [ ] ') === '- [ ] item' && t('- [x] item', '- ') === '- item' && t('- [ ] item', '- [ ] ') === 'item');
    check('citacao troca titulo', t('## t', '> ') === '> t');
    check('indentacao preservada', t('  - sub', '- [ ] ') === '  - [ ] sub');
    check('lista numerada vira lista', t('1. um', '- ') === '- um');
    check('linha vazia', t('', '- ') === '- ');

    App.newFile();
    const ta = App.els.editorElement;
    ta.value = 'primeira linha\nsegunda linha\nterceira';
    ta.selectionStart = ta.selectionEnd = 20; // no meio da segunda linha
    App.isDirty = false;
    App.applyFormat('heading');
    check('cursor no meio: marcador vai pro comeco da linha', ta.value === 'primeira linha\n## segunda linha\nterceira', ta.value);
    check('marcou como nao salvo', App.isDirty);
    ta.selectionStart = 3; ta.selectionEnd = 20; // pega linhas 1 e 2
    App.applyFormat('list');
    check('selecao de varias linhas: todas ganham o marcador', ta.value === '- primeira linha\n- segunda linha\nterceira', ta.value);
    ta.selectionStart = 2; ta.selectionEnd = 10;
    App.applyFormat('bold');
    check('negrito envolve a selecao', ta.value.startsWith('- **primeira** linha'), ta.value);
    await App._saveChain;
  }

  const seedVault = (drive) => {
    const dir = (id, name, parent) => { drive.put(id, name, '', [parent]); drive.files.get(id).mimeType = FOLDER; };
    dir('d-proj', '20-projetos', VAULT); dir('d-inbox', '_inbox', VAULT); dir('d-obs', '.obsidian', VAULT); dir('d-10', '10-areas', VAULT); dir('d-2', '2-rascunho', VAULT);
    drive.put('n-z', 'zebra.md', 'z', [VAULT]); drive.put('n-a', 'Abacaxi.md', 'a', [VAULT]); drive.put('n-e', 'émile.md', 'e', [VAULT]);
    drive.put('n-img', 'foto.png', 'bin', [VAULT]); drive.files.get('n-img').mimeType = 'image/png';
    drive.put('n-txt', 'lista.txt', 't', [VAULT]);
    drive.put('n-sub', 'nota do projeto.md', '# dentro', ['d-proj']);
  };

  console.log('24. Navegador de pastas');
  {
    const { App, drive, w } = await boot();
    seedVault(drive);
    const d = w.document;
    const rows = () => [...d.querySelectorAll('#browser-list .browser-item')].map(li => li.querySelector('.browser-name').textContent);
    d.getElementById('welcome-open').click(); await sleep(80);
    check('abre na raiz do vault', d.body.dataset.view === 'browse' && App.els.fileName.textContent === 'vault' && !App.els.browser.classList.contains('hidden'));
    check('pastas primeiro, ordem natural por nome, sem .obsidian e sem imagem, .md sem extensao',
      JSON.stringify(rows()) === JSON.stringify(['_inbox', '2-rascunho', '10-areas', '20-projetos', 'Abacaxi', 'émile', 'lista.txt', 'zebra']), rows());
    check('nao ha Picker nem gapi na pagina', !d.querySelector('script[src*="apis.google.com"]') && typeof App.openPicker === 'undefined');

    [...d.querySelectorAll('.browser-item')].find(li => li.textContent.includes('20-projetos')).click(); await sleep(80);
    check('um toque entra na pasta; caminho no topo', App.els.fileName.textContent === '20-projetos' && d.getElementById('browser-path').textContent.includes('vault / 20-projetos') && rows()[0] === 'nota do projeto');
    d.querySelector('.browser-item').click(); await sleep(80);
    check('um toque abre a nota em leitura', App.currentFile?.id === 'n-sub' && d.body.dataset.view === 'preview');

    App.els.btnBack.click(); await sleep(80);
    check('voltar da nota: de volta na pasta', d.body.dataset.view === 'browse' && App.folder?.id === 'd-proj' && App.currentFile === null);
    App.els.btnBack.click(); await sleep(80);
    check('voltar: raiz do vault', App.folder?.id === VAULT && rows().length === 8);
    App.els.btnBack.click(); await sleep(80);
    check('voltar: tela inicial', d.body.dataset.view === 'welcome' && App.folder === null && App.els.fileName.textContent === 'Drive Notes');

    drive.failReads = true;
    d.getElementById('welcome-open').click(); await sleep(80);
    check('falha de rede com pasta ja vista: mostra a listagem guardada', rows().length === 8);
    drive.failReads = false;
    check('nada escrito no Drive', drive.count('PATCH') === 0 && drive.count('POST') === 0);
  }

  console.log('25. Botao voltar do sistema via CloseWatcher');
  {
    const { App, drive, type, w } = await boot({ watcher: true });
    seedVault(drive);
    drive.put('L', 'com link.md', 'vai [[zebra]]', [VAULT]);
    const d = w.document;
    const len0 = w.history.length;
    check('modo CloseWatcher ativo; na tela inicial o voltar sai do app', App.useWatcher && w.__watchers.length === 0 && w.__back() === 'EXIT');

    d.getElementById('welcome-open').click();
    check('watcher armado dentro do toque', w.__watchers.length === 1);
    await sleep(80);
    [...d.querySelectorAll('.browser-item')].find(li => li.textContent.includes('com link')).click(); await sleep(80);
    App.els.previewContainer.querySelector('a.wikilink').click(); await sleep(80);
    check('vault > nota > link: 3 telas na pilha, 1 watcher', App.currentFile?.id === 'n-z' && App.navStack.length === 3 && w.__watchers.length === 1);
    check('historico do navegador intocado', w.history.length === len0);

    check('voltar do sistema: tratado', w.__back() === 'handled'); await sleep(80);
    check('... volta pra nota anterior', App.currentFile?.id === 'L' && w.__watchers.length === 1);
    w.__back(); await sleep(80);
    check('... volta pra pasta', d.body.dataset.view === 'browse' && App.folder?.id === VAULT);
    w.__back(); await sleep(80);
    check('... volta pra tela inicial e desarma o watcher', d.body.dataset.view === 'welcome' && w.__watchers.length === 0);
    check('proximo voltar sai do app', w.__back() === 'EXIT');

    // link quebrado: a tela nao muda, a pilha tambem nao
    await App.navigateTo('L', 'com link.md');
    drive.files.get('n-z').name = 'renomeada.md';
    App.els.previewContainer.querySelector('a.wikilink').click(); await sleep(80);
    check('link quebrado nao deixa entrada sobrando', App.currentFile?.id === 'L' && App.navStack.length === 1, App.navStack);

    // dialogo aberto: voltar fecha o dialogo, nao sai da nota
    App.els.fileName.click();
    check('modal de renomear aberto', App.els.modal.classList.contains('visible'));
    w.__back(); await sleep(20);
    check('voltar fecha o modal e fica na nota', !App.els.modal.classList.contains('visible') && App.currentFile?.id === 'L' && w.__watchers.length === 1);

    App.els.btnPreview.click(); type('editado');
    w.__back(); await sleep(80); await App._saveChain;
    check('voltar com edicao pendente salva antes', bodyOf(drive.files.get('L').content) === 'editado' && d.body.dataset.view === 'welcome');

    for (let i = 0; i < 5; i++) d.querySelector('#welcome h2').click();
    const dbg = d.getElementById('debug-text').textContent;
    check('5 toques no titulo: painel de diagnostico com o modo e o log', d.getElementById('debug-overlay').classList.contains('visible') && dbg.includes('modo de voltar: CloseWatcher') && dbg.includes('watcher: close'));
    w.__back(); await sleep(20);
    check('voltar fecha o painel', !d.getElementById('debug-overlay').classList.contains('visible'));
  }

  console.log('26. created e updated: nota nova nasce com as duas, salvar troca o updated');
  {
    const { App, drive, type } = await boot();
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const born = `---\ncreated: ${today}\nupdated: ${today}\n---\n\n`;
    drive.put('proj', 'projeto', '', [VAULT]);
    drive.put('tpl', '_templates', '', [VAULT]);
    drive.put('tplsub', 'diario', '', ['tpl']);
    drive.put('fora', 'documentos', '', []);

    App.newFile();
    check('nota nova abre com created e updated de hoje', App.getContent() === born && !App.isDirty, App.getContent());
    check('cursor depois das propriedades', App.els.editorElement.selectionStart === born.length, App.els.editorElement.selectionStart);
    await App._saveChain;
    check('e criada no Drive ja com as duas', drive.files.get('new1')?.content === born, drive.files.get('new1')?.content);
    type(born + 'ideia');
    await App.save();
    check('salvar no mesmo dia nao mexe nas datas', drive.files.get('new1').content === born + 'ideia' && drive.count('POST') === 1, drive.files.get('new1').content);

    const old = '---\ntags: [a]\ncreated: 2026-01-02\nupdated: 2026-01-03\n---\n\ntexto';
    drive.put('A', 'a.md', old, ['proj']);
    await App.openFile('A', 'a.md');
    await App.save(); App.flushCurrent(); await App._saveChain;
    check('abrir sem editar nao troca o updated', drive.files.get('A').content === old && drive.count('PATCH') === 1, drive.log);
    App.setMode('edit'); // notes open in reading view
    type(old + ' editado');
    await App.save();
    const saved = `---\ntags: [a]\ncreated: 2026-01-02\nupdated: ${today}\n---\n\ntexto editado`;
    check('editar e salvar troca o updated, o resto fica', drive.files.get('A').content === saved, drive.files.get('A').content);
    check('nota limpa, sem rascunho', !App.isDirty && App.listDrafts().length === 0, App.listDrafts());
    check('na edicao o texto nao e trocado debaixo do teclado', App.getContent() === old + ' editado');
    App.setMode('preview');
    check('ao ir pra leitura o editor alcanca o Drive, sem sujar', App.getContent() === saved && !App.isDirty, App.getContent());
    check('e as propriedades mostram a data nova', App.els.previewContainer.querySelector('details.frontmatter pre').textContent.includes(`updated: ${today}`));
    const patches = drive.count('PATCH');
    await App.save(); App.flushCurrent(); await App._saveChain;
    check('alcancar o Drive nao gera outra escrita', drive.count('PATCH') === patches, drive.log);

    App.setMode('edit');
    drive.delay = 40;
    type(saved + ' 1');
    const p = App.save();
    await sleep(20);
    type(saved + ' 12');
    await p;
    check('texto digitado durante o save continua pendente', App.isDirty && drive.files.get('A').content === saved + ' 1');
    await App.save();
    check('e vai no save seguinte', !App.isDirty && drive.files.get('A').content === saved + ' 12');
    drive.delay = 5;

    const lookups = drive.log.filter(l => l === 'GET meta proj').length;
    check('a pasta e conferida uma vez so', lookups === 1, lookups);

    drive.put('B', 'b.md', '---\ntags: [a]\n---\ncorpo', ['proj']);
    await App.openFile('B', 'b.md');
    type('---\ntags: [a]\n---\ncorpo 2');
    await App.save();
    check('propriedades sem updated: ganha updated, nao inventa created', drive.files.get('B').content === `---\ntags: [a]\nupdated: ${today}\n---\ncorpo 2`, drive.files.get('B').content);

    drive.put('C', 'c.md', 'so texto', ['proj']);
    await App.openFile('C', 'c.md');
    type('so texto 2');
    await App.save();
    check('nota sem propriedades: ganha so o updated', drive.files.get('C').content === `---\nupdated: ${today}\n---\n\nso texto 2`, drive.files.get('C').content);

    const untouched = [
      ['T', 'modelo.md', ['tplsub'], 'dentro de _templates'],
      ['K', 'CLAUDE.md', ['proj'], 'CLAUDE.md'],
      ['O', 'guia-antigo.md', ['proj'], 'arquivo -antigo'],
      ['X', 'lista.txt', ['proj'], 'arquivo .txt'],
      ['F', 'f.md', ['fora'], 'fora do vault'],
    ];
    for (const [id, name, parents, label] of untouched) {
      drive.put(id, name, '---\nupdated: 2026-01-03\n---\nx', parents);
      await App.openFile(id, name);
      type('---\nupdated: 2026-01-03\n---\nx 2');
      await App.save();
      check(`${label}: updated fica como esta`, drive.files.get(id).content === '---\nupdated: 2026-01-03\n---\nx 2', drive.files.get(id).content);
    }

    check('regua no topo nao e propriedade', App.stampDates('---\num titulo solto\n---\ncorpo', today, false) === '---\num titulo solto\n---\ncorpo');
    check('CRLF e preservado', App.stampDates('---\r\nupdated: 2026-01-03\r\n---\r\nx', today, false) === `---\r\nupdated: ${today}\r\n---\r\nx`);
    check('nota criada agora sem created ganha as duas', App.stampDates('ideia', today, true) === `---\ncreated: ${today}\nupdated: ${today}\n---\n\nideia`);
  }

  console.log('27. Salvar a partir da leitura, e o botao de salvar sem roubar o foco');
  {
    const { App, drive, type, w } = await boot();
    const d = w.document;
    drive.put('A', 'a.md', 'texto');
    await App.openFile('A', 'a.md');
    check('nota aberta e limpa: nada por salvar', !d.body.classList.contains('unsaved'));
    App.setMode('edit');
    type('texto editado');
    App.setMode('preview');
    await sleep(30); await App._saveChain;
    check('ir pra leitura nao salva por conta propria', drive.files.get('A').content === 'texto' && App.isDirty);
    check('a leitura sabe que ha texto por salvar', d.body.dataset.view === 'preview' && d.body.classList.contains('unsaved'));
    d.getElementById('btn-save').click();
    await sleep(30); await App._saveChain;
    check('salvar na leitura grava no Drive e a marca some', drive.files.get('A').content === 'texto editado' && !d.body.classList.contains('unsaved'), drive.files.get('A').content);

    App.setMode('edit');
    type('texto editado 2');
    const start = new w.Event('touchstart', { cancelable: true });
    d.getElementById('btn-save').dispatchEvent(start);
    d.getElementById('btn-save').dispatchEvent(new w.Event('touchend', { cancelable: true }));
    await sleep(30); await App._saveChain;
    check('toque no salvar: o comeco do toque e cancelado (teclado fica) e o fim salva', start.defaultPrevented && drive.files.get('A').content === 'texto editado 2', drive.files.get('A').content);
    check('um toque, uma escrita', drive.count('PATCH') === 2, drive.log);
  }

  console.log('28. Busca: filtra a pasta aberta e procura no vault inteiro');
  {
    const { App, drive, w } = await boot();
    seedVault(drive);
    const d = w.document;
    w.__CONFIG.SEARCH_DELAY = 40;
    const dir = (id, name, parent) => { drive.put(id, name, '', parent ? [parent] : []); drive.files.get(id).mimeType = FOLDER; };
    dir('d-cli', 'clientes', 'd-proj'); dir('d-fora', 'documentos', null);
    drive.put('n-deep', 'Relatório do funil.md', 'texto sobre vendas', ['d-cli']);
    drive.put('n-text', 'reuniao.md', 'falamos do funil de conversão', ['d-10']);
    drive.put('x-out', 'Funil pessoal.md', 'x', ['d-fora']);
    drive.put('x-obs', 'funil-config.md', 'x', ['d-obs']);
    drive.put('x-xlsx', 'Funil.xlsx', 'x', [VAULT]); drive.files.get('x-xlsx').mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    drive.put('n-quote', "d'água.md", 'x', ['d-10']);

    const input = d.getElementById('browser-search');
    const search = (text) => { input.value = text; input.dispatchEvent(new w.Event('input')); };
    const local = () => [...d.querySelectorAll('#browser-list .browser-item:not(.is-result)')].map(li => li.querySelector('.browser-name').textContent);
    const found = () => [...d.querySelectorAll('#browser-list .browser-item.is-result')].map(li =>
      [li.querySelector('.browser-name').textContent, li.querySelector('.browser-where').textContent]);
    const searches = () => drive.count('SEARCH');

    d.getElementById('welcome-open').click(); await sleep(80);
    check('campo de busca na tela de pastas, vazio', !!input && input.value === '' && local().length === 8);

    search('ab'); await sleep(100);
    check('digitar filtra a pasta aberta na hora', JSON.stringify(local()) === JSON.stringify(['Abacaxi']), local());
    check('com menos de 3 letras nao procura no Drive', searches() === 0 && found().length === 0, drive.log);
    search('EMILE'); await sleep(10);
    check('sem ligar pra acento nem maiuscula', JSON.stringify(local()) === JSON.stringify(['émile']), local());
    search('proj 20'); await sleep(10);
    check('palavras em qualquer ordem; pasta tambem entra no filtro', JSON.stringify(local()) === JSON.stringify(['20-projetos']), local());

    for (const partial of ['fun', 'funi', 'funil']) { search(partial); await sleep(10); }
    check('nada na pasta aberta com esse nome', local().length === 0, local());
    await sleep(200);
    check('uma busca so no Drive, depois que a digitacao para', searches() === 1, drive.log);
    check('resultados do vault inteiro: nome primeiro, depois o que bate so no texto, cada um com a pasta',
      JSON.stringify(found()) === JSON.stringify([['Relatório do funil', '20-projetos / clientes'], ['reuniao', '10-areas · no texto']]), found());
    check('ficam de fora: fora do vault, pasta com ponto, o que nao e nota', !d.getElementById('browser-list').textContent.match(/pessoal|config|xlsx/i));
    check('titulo da secao', d.querySelector('#browser-list .browser-section')?.textContent === 'No vault inteiro');

    d.querySelector('.browser-item.is-result').click(); await sleep(80);
    check('tocar no resultado abre a nota', App.currentFile?.id === 'n-deep' && d.body.dataset.view === 'preview');
    App.els.btnBack.click(); await sleep(120);
    check('voltar: a busca continua como estava', d.body.dataset.view === 'browse' && input.value === 'funil' && found().length === 2, [input.value, found()]);
    check('... sem perguntar de novo ao Drive', searches() === 1, drive.log);

    d.getElementById('browser-search-clear').click(); await sleep(10);
    check('o X limpa: a pasta inteira volta e a secao some', input.value === '' && local().length === 8 && found().length === 0 && !d.querySelector('.browser-section'));

    search('zebra'); await sleep(200);
    check('nota que ja aparece na pasta aberta nao repete nos resultados', JSON.stringify(local()) === JSON.stringify(['zebra']) && found().length === 0, found());

    search("d'água"); await sleep(200);
    check('apostrofo na busca nao quebra a consulta', found()[0]?.[0] === "d'água", [found(), drive.log.at(-1)]);

    search('');
    [...d.querySelectorAll('.browser-item')].find(li => li.textContent.includes('20-projetos')).click(); await sleep(80);
    check('entrar numa pasta comeca com a busca vazia', input.value === '' && local()[0] === 'clientes', local());
    search('funil'); await sleep(200);
    check('dentro de uma subpasta a busca tambem cobre o vault inteiro', found().length === 2 && searches() === 3, [found(), searches()]);

    drive.failReads = true;
    search('inexistente'); await sleep(200);
    check('sem rede: avisa, e o filtro da pasta segue funcionando', /não deu/i.test(d.querySelector('.browser-message')?.textContent || ''), d.getElementById('browser-list').textContent);
    drive.failReads = false;
    search('inexistente'); await sleep(10); search('inexistentes'); await sleep(200);
    check('nada encontrado: diz que nao achou', /nada/i.test(d.querySelector('.browser-message')?.textContent || ''), d.getElementById('browser-list').textContent);
  }

  console.log('29. Desenho: a caixa de recorte sai dos tracos, nao da tela');
  {
    const { App } = await boot();
    const line = (width, points, erase = false) => ({ color: '#8b6cef', width, erase, points });

    check('sem traco nenhum: sem caixa', App.sketchBounds([]) === null);
    check('so borracha: sem caixa', App.sketchBounds([line(12, [{ x: 10, y: 10 }, { x: 90, y: 90 }], true)]) === null);

    const one = App.sketchBounds([line(6, [{ x: 100, y: 50 }, { x: 140, y: 90 }])]);
    check('caixa cobre o traco, mais meia espessura e a margem',
      one.x === 100 - 3 - 16 && one.y === 50 - 3 - 16 && one.width === 40 + 6 + 32 && one.height === 40 + 6 + 32, one);

    const far = App.sketchBounds([line(6, [{ x: 100, y: 50 }, { x: 140, y: 90 }]), line(12, [{ x: 900, y: 900 }], true)]);
    check('borracha do outro lado da tela nao incha a caixa', far.width === one.width && far.height === one.height, far);

    const thick = App.sketchBounds([line(12, [{ x: 200, y: 200 }])]);
    check('traco grosso empurra a caixa pela metade da espessura', thick.width === 12 + 32 && thick.height === 12 + 32, thick);

    const edge = App.sketchBounds([line(3, [{ x: 2, y: 2 }])]);
    check('traco na borda deixa a caixa entrar no negativo', edge.x === 2 - 1.5 - 16 && edge.y === 2 - 1.5 - 16, edge);
  }

  console.log('30. Desenho: a tela abre a partir da edicao e fecha sem mexer na nota');
  {
    const { App, drive, w } = await boot();
    w.devicePixelRatio = 3;
    drive.put('A', 'a.md', 'linha um');
    await App.openFile('A', 'a.md');
    const screen = w.document.getElementById('sketch-screen');
    const pencil = w.document.querySelector('.toolbar-btn[data-sketch]');

    App.setMode('preview');
    pencil.click();
    check('fora da edicao o lapis nao abre nada', !App.sketch && !screen.classList.contains('visible'));

    App.setMode('edit');
    pencil.click();
    check('na edicao o lapis abre a tela', !!App.sketch && screen.classList.contains('visible'));
    check('comeca no cinza, 6px, sem borracha', App.sketch.color === '#9b94a6' && App.sketch.width === 6 && App.sketch.erase === false, App.sketch);
    check('canvas dimensionado pelo devicePixelRatio', App.sketch.canvas.width === w.innerWidth * 3 && App.sketch.dpr === 3, [App.sketch.canvas.width, App.sketch.dpr]);
    check('contexto sai com ponta redonda', App.sketch.ctx.lineCap === 'round' && App.sketch.ctx.lineJoin === 'round');

    const swatches = [...w.document.getElementById('sketch-colors').children];
    check('seis bolinhas, uma por cor da paleta', swatches.length === 6 && swatches.map(b => b.dataset.sketchColor).join() === App.SKETCH_COLORS.join());
    check('a cor ativa e a unica marcada', swatches.filter(b => b.classList.contains('sketch-active')).length === 1 && swatches[0].classList.contains('sketch-active'));

    swatches[2].click();
    check('tocar numa cor troca a cor ativa', App.sketch.color === '#e0645c' && swatches[2].classList.contains('sketch-active') && !swatches[0].classList.contains('sketch-active'));
    w.document.querySelector('[data-sketch-width="12"]').click();
    check('tocar na espessura troca e marca', App.sketch.width === 12 && w.document.querySelector('[data-sketch-width="12"]').classList.contains('sketch-active'));
    w.document.getElementById('sketch-erase').click();
    check('borracha liga e desmarca a cor', App.sketch.erase === true && !swatches[2].classList.contains('sketch-active'));
    swatches[1].click();
    check('tocar numa cor desliga a borracha', App.sketch.erase === false && App.sketch.color === '#8b6cef');

    const before = App.getContent();
    App.sketchClose();
    check('fechar tira a tela e o estado, sem tocar na nota', !App.sketch && !screen.classList.contains('visible') && App.getContent() === before && !App.isDirty);
  }

  console.log('31. Desenho: traco, borracha e desfazer');
  {
    const { App, drive, w } = await boot();
    drive.put('A', 'a.md', 'linha um');
    await App.openFile('A', 'a.md');
    App.setMode('edit');
    w.document.querySelector('.toolbar-btn[data-sketch]').click();
    const canvas = App.sketch.canvas;
    const ctx = App.sketch.ctx;
    const send = (type, x, y) => canvas.dispatchEvent(new w.PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true, cancelable: true }));
    const drag = (points) => {
      send('pointerdown', points[0].x, points[0].y);
      for (const p of points.slice(1)) send('pointermove', p.x, p.y);
      send('pointerup', points[points.length - 1].x, points[points.length - 1].y);
    };

    drag([{ x: 10, y: 10 }, { x: 20, y: 30 }, { x: 40, y: 30 }]);
    check('um traco, com todos os pontos', App.sketch.strokes.length === 1 && App.sketch.strokes[0].points.length === 3, App.sketch.strokes);
    check('o traco guarda a ferramenta da hora', App.sketch.strokes[0].color === '#9b94a6' && App.sketch.strokes[0].width === 6 && App.sketch.strokes[0].erase === false);
    check('soltar fecha o traco', App.sketch.stroke === null);

    send('pointerdown', 99, 99);
    check('um toque so tambem vale traco', App.sketch.strokes.length === 2 && App.sketch.strokes[1].points.length === 1);
    send('pointerup', 99, 99);

    w.document.querySelector('[data-sketch-width="12"]').click();
    w.document.getElementById('sketch-erase').click();
    ctx.ops.length = 0;
    drag([{ x: 15, y: 15 }, { x: 25, y: 25 }]);
    check('a borracha e um traco como outro, so que erase', App.sketch.strokes.length === 3 && App.sketch.strokes[2].erase === true && App.sketch.strokes[2].width === 12);
    check('a borracha pinta em destination-out', ctx.ops.some(o => o.includes('destination-out')), ctx.ops);
    check('e a composicao volta ao normal depois', ctx.globalCompositeOperation === 'source-over');

    ctx.ops.length = 0;
    w.devicePixelRatio = 2;
    w.dispatchEvent(new w.Event('resize'));
    check('girar o aparelho nao perde traco: repinta a lista no tamanho novo',
      App.sketch.strokes.length === 3 && App.sketch.dpr === 2 && App.sketch.canvas.width === w.innerWidth * 2
      && ctx.ops.filter(o => o.startsWith('stroke')).length === 3, ctx.ops);

    ctx.ops.length = 0;
    w.document.getElementById('sketch-undo').click();
    check('desfazer tira o ultimo traco', App.sketch.strokes.length === 2);
    check('desfazer repinta a lista do zero, nao desenha por cima', ctx.ops[0]?.startsWith('clear') && ctx.ops.filter(o => o.startsWith('stroke')).length === 2, ctx.ops);

    w.document.getElementById('sketch-undo').click();
    w.document.getElementById('sketch-undo').click();
    w.document.getElementById('sketch-undo').click();
    check('desfazer no vazio nao quebra', App.sketch.strokes.length === 0);

    App.sketchClose();
  }

  console.log('32. Desenho: o voltar do sistema fecha a tela, e nao joga fora sem perguntar');
  {
    const { App, drive, w } = await boot({ watcher: true });
    drive.put('A', 'a.md', 'linha um');
    await App.openFile('A', 'a.md');
    App.setMode('edit');
    const confirmOverlay = w.document.getElementById('confirm-overlay');
    const openSketch = () => w.document.querySelector('.toolbar-btn[data-sketch]').click();
    const scribble = () => {
      const c = App.sketch.canvas;
      c.dispatchEvent(new w.PointerEvent('pointerdown', { clientX: 30, clientY: 30, pointerId: 1, bubbles: true, cancelable: true }));
      c.dispatchEvent(new w.PointerEvent('pointerup', { clientX: 30, clientY: 30, pointerId: 1, bubbles: true, cancelable: true }));
    };

    openSketch();
    check('com a tela aberta existe um watcher pra segurar o voltar', w.__watchers.length > 0);
    w.__back();
    await sleep(10);
    check('tela em branco: o voltar fecha sem perguntar', !App.sketch && !confirmOverlay.classList.contains('visible'));

    openSketch();
    scribble();
    w.__back();
    await sleep(10);
    check('com desenho na tela, o voltar pergunta antes', !!App.sketch && confirmOverlay.classList.contains('visible'));

    w.__back();
    await sleep(10);
    check('o voltar de novo e "continuar desenhando": some o dialogo, fica a tela', !!App.sketch && !confirmOverlay.classList.contains('visible') && App.sketch.strokes.length === 1);

    w.__back();
    await sleep(10);
    w.document.getElementById('confirm-ok').click();
    await sleep(10);
    check('descartar fecha a tela e nao mexe na nota', !App.sketch && App.getContent() === 'linha um' && !App.isDirty);
  }

  console.log('33. Desenho: o pronto recorta, sobe pro _media e so entao entra na nota');
  {
    const { App, drive, w } = await boot();
    w.URL.createObjectURL = () => 'blob:fake/sketch';
    w.devicePixelRatio = 2;
    drive.put('media', '_media', '', [VAULT]); drive.files.get('media').mimeType = FOLDER;
    drive.put('A', 'a.md', 'linha um\nlinha dois');
    await App.openFile('A', 'a.md');
    App.setMode('edit');
    const ta = App.els.editorElement;
    const uploaded = () => [...drive.files.values()].filter(f => /^desenho-/.test(f.name));
    const openSketch = () => w.document.querySelector('.toolbar-btn[data-sketch]').click();
    const scribble = (from, to) => {
      const c = App.sketch.canvas;
      c.dispatchEvent(new w.PointerEvent('pointerdown', { clientX: from.x, clientY: from.y, pointerId: 1, bubbles: true, cancelable: true }));
      c.dispatchEvent(new w.PointerEvent('pointermove', { clientX: to.x, clientY: to.y, pointerId: 1, bubbles: true, cancelable: true }));
      c.dispatchEvent(new w.PointerEvent('pointerup', { clientX: to.x, clientY: to.y, pointerId: 1, bubbles: true, cancelable: true }));
    };

    openSketch();
    await App.sketchFinish();
    check('tela em branco: o pronto so fecha, sem subir nada', !App.sketch && uploaded().length === 0 && ta.value === 'linha um\nlinha dois');

    ta.selectionStart = ta.selectionEnd = 'linha um'.length;
    openSketch();
    scribble({ x: 100, y: 50 }, { x: 140, y: 90 });
    await App.sketchFinish();
    const up = uploaded()[0];
    check('desenho no _media, com nome desenho-data-hora.png', uploaded().length === 1 && up.parents[0] === 'media' && /^desenho-\d{4}-\d{2}-\d{2}-\d{6}\.png$/.test(up.name), up);
    check('o PNG sai do tamanho do recorte, em pixels do aparelho', up.content === `png ${(40 + 6 + 32) * 2}x${(40 + 6 + 32) * 2}`, up.content);
    check('embed em linha propria, onde o cursor estava', ta.value === `linha um\n![[${up.name}]]\n\nlinha dois`, ta.value);
    check('tela fechada e nota suja pra salvar', !App.sketch && App.isDirty && App.els.saveStatus.textContent === 'Desenho inserido');

    const gets = drive.count('GET content');
    App.setMode('preview');
    await sleep(40);
    check('modo leitura mostra o desenho sem baixar de volta', App.els.previewContainer.querySelector('img')?.getAttribute('src') === 'blob:fake/sketch' && drive.count('GET content') === gets);
    App.setMode('edit');
    await App.save(); await App._saveChain;

    drive.failWrites = true;
    const before = ta.value;
    openSketch();
    scribble({ x: 10, y: 10 }, { x: 60, y: 60 });
    await App.sketchFinish();
    check('upload falhou: a tela FICA aberta com o desenho, e nada entra na nota',
      !!App.sketch && App.sketch.strokes.length === 1 && ta.value === before && uploaded().length === 1 && App.els.saveStatus.textContent === 'Erro ao enviar o desenho', App.els.saveStatus.textContent);

    drive.failWrites = false;
    await App.sketchFinish();
    check('tentar de novo com a rede de volta sobe o mesmo desenho', uploaded().length === 2 && !App.sketch && /!\[\[desenho-/.test(ta.value));
  }

  console.log('34. Desenho: toque repetido no pronto nao sobe o desenho varias vezes');
  {
    const { App, drive, w } = await boot();
    w.URL.createObjectURL = () => 'blob:fake/sketch';
    drive.put('media', '_media', '', [VAULT]); drive.files.get('media').mimeType = FOLDER;
    drive.put('A', 'a.md', 'nota');
    await App.openFile('A', 'a.md');
    App.setMode('edit');
    const ta = App.els.editorElement;
    const btnDone = w.document.getElementById('sketch-done');
    const btnCancel = w.document.getElementById('sketch-cancel');
    const title = w.document.querySelector('.sketch-title');
    const uploaded = () => [...drive.files.values()].filter(f => /^desenho-/.test(f.name));
    const embeds = () => (ta.value.match(/!\[\[desenho-/g) || []).length;
    const openSketch = () => w.document.querySelector('.toolbar-btn[data-sketch]').click();
    const scribble = () => {
      const c = App.sketch.canvas;
      for (const type of ['pointerdown', 'pointerup']) {
        c.dispatchEvent(new w.PointerEvent(type, { clientX: 40, clientY: 40, pointerId: 1, bubbles: true, cancelable: true }));
      }
    };

    // A rede de verdade nao responde na hora: e essa janela que deixava o segundo toque entrar
    drive.delay = 50;
    openSketch();
    scribble();
    const first = App.sketchFinish();
    check('enquanto sobe, a tela avisa e trava o pronto e o sair', title.textContent === 'Enviando...' && btnDone.disabled && btnCancel.disabled, [title.textContent, btnDone.disabled, btnCancel.disabled]);
    const repeated = [App.sketchFinish(), App.sketchFinish()];
    await Promise.all([first, ...repeated]);
    check('tres toques no mesmo segundo sobem UM desenho so', uploaded().length === 1, uploaded().map(f => f.name));
    check('e escrevem UM embed so na nota', embeds() === 1, ta.value);
    check('a tela volta ao normal depois de fechar', title.textContent === 'Desenho' && !btnDone.disabled && !btnCancel.disabled);

    // O voltar do sistema nao passa por cima da trava: ele chama sketchCancel direto
    openSketch();
    scribble();
    const inFlight = App.sketchFinish();
    App.sketchCancel();
    check('o voltar durante o envio nao abandona a tela', !!App.sketch);
    await inFlight;
    check('e o envio terminou normalmente', uploaded().length === 2 && embeds() === 2, ta.value);

    // Falhar nao pode deixar a tela travada pra sempre: senao nao da nem pra sair
    drive.failWrites = true;
    openSketch();
    scribble();
    await App.sketchFinish();
    check('upload que falha destrava a tela de novo', !!App.sketch && !btnDone.disabled && !btnCancel.disabled && title.textContent === 'Desenho', [btnDone.disabled, title.textContent]);
    drive.failWrites = false;
    await App.sketchFinish();
    check('e dai da pra tentar de novo', uploaded().length === 3 && embeds() === 3 && !App.sketch);
  }

  console.log('35. Tarefa: tocar na caixa no modo leitura marca no texto da nota');
  {
    const { App, drive, w } = await boot();
    const note = [
      '---', 'tags: [a]', '---', '',
      '- [ ] Agatha', '- [x] Banguela', '',
      '```', '- [ ] dentro de codigo, nao e tarefa', '```', '',
      '> - [ ] na citacao',
      '1. [ ] numerada',
    ].join('\n');
    drive.put('A', 'a.md', note);
    await App.openFile('A', 'a.md');
    const boxes = () => [...App.els.previewContainer.querySelectorAll('input[type="checkbox"]')];
    const tap = (i) => { const box = boxes()[i]; box.checked = !box.checked; box.dispatchEvent(new w.Event('change', { bubbles: true })); };
    check('4 caixas, todas tocaveis', boxes().length === 4 && boxes().every(b => !b.disabled), boxes().map(b => b.disabled));

    tap(0);
    check('marcar a primeira troca so ela no texto', App.getContent() === note.replace('- [ ] Agatha', '- [x] Agatha'), App.getContent());
    check('a nota fica com algo pra salvar', App.isDirty);
    tap(1);
    check('desmarcar volta pro [ ]', App.getContent().includes('- [ ] Banguela') && App.getContent().includes('- [x] Agatha'), App.getContent());
    tap(3);
    check('a quarta caixa e a numerada, o bloco de codigo nao conta', App.getContent().includes('1. [x] numerada') && App.getContent().includes('- [ ] dentro de codigo'), App.getContent());
    tap(2);
    check('tarefa dentro de citacao', App.getContent().includes('> - [x] na citacao'), App.getContent());

    await App.save(); await App._saveChain;
    check('e vai pro Drive', bodyOf(drive.files.get('A').content).includes('- [x] Agatha') && drive.files.get('A').content.includes('1. [x] numerada'), drive.files.get('A').content);

    // Se o texto e a tela discordarem de quantas tarefas existem, marcar a errada e pior que nao marcar
    drive.put('B', 'b.md', 'texto\n\n    - [ ] isto e bloco de codigo por recuo\n\n- [ ] uma\n');
    await App.openFile('B', 'b.md');
    check('contagem que nao bate: caixas ficam desligadas', boxes().length === 1 && boxes()[0].disabled, boxes().map(b => b.disabled));
  }

  console.log('36. Deslizar da borda: a esquerda volta, a direita avanca');
  {
    const { App, drive, w } = await boot({ watcher: true });
    seedVault(drive);
    drive.put('L', 'com link.md', 'vai [[zebra]]', [VAULT]);
    const d = w.document;
    const W = w.innerWidth;
    const touch = (type, x, y) => {
      const e = new w.Event(type, { bubbles: true, cancelable: true });
      e.touches = type === 'touchend' ? [] : [{ clientX: x, clientY: y }];
      e.changedTouches = [{ clientX: x, clientY: y }];
      d.body.dispatchEvent(e);
    };
    // Um arrasto de dedo: comeca em (x0, y0), passa pelo meio e solta em (x1, y1)
    const swipe = async (x0, x1, y0 = 300, y1 = 300) => {
      touch('touchstart', x0, y0);
      touch('touchmove', (x0 + x1) / 2, (y0 + y1) / 2);
      touch('touchmove', x1, y1);
      touch('touchend', x1, y1);
      await sleep(80);
    };
    const hint = d.getElementById('swipe-hint');
    const view = () => d.body.dataset.view;

    await swipe(5, 150);
    check('na tela inicial deslizar nao faz nada', view() === 'welcome' && App.navStack.length === 0);

    d.getElementById('welcome-open').click(); await sleep(80);
    [...d.querySelectorAll('.browser-item')].find(li => li.textContent.includes('com link')).click(); await sleep(80);
    App.els.previewContainer.querySelector('a.wikilink').click(); await sleep(80);
    check('pasta > nota > link', App.currentFile?.id === 'n-z' && App.navStack.length === 3);

    await swipe(5, 50);
    check('arrasto curto nao volta', App.currentFile?.id === 'n-z');
    await swipe(5, 60, 300, 500);
    check('arrasto mais vertical que horizontal e rolagem, nao volta', App.currentFile?.id === 'n-z');
    await swipe(100, 300);
    check('arrasto que comeca fora da borda nao volta', App.currentFile?.id === 'n-z');
    await swipe(W - 5, W - 150);
    check('sem nada pra frente, a borda direita nao faz nada', App.currentFile?.id === 'n-z' && App.navStack.length === 3);

    // Dedo de verdade: nao cai colado na borda, e o comeco do arrasto do polegar e um arco, nao uma reta
    await swipe(28, 170);
    check('pega com o dedo a 28px da borda', App.currentFile?.id === 'L', App.currentFile?.id);
    await swipe(W - 28, W - 170);
    check('... e da direita tambem', App.currentFile?.id === 'n-z');
    touch('touchstart', 10, 300); touch('touchmove', 12, 309); touch('touchmove', 16, 316); touch('touchmove', 60, 330); touch('touchmove', 150, 340); touch('touchend', 150, 340);
    await sleep(80);
    check('comeco torto (mais pra baixo que pro lado) nao mata o gesto', App.currentFile?.id === 'L', App.currentFile?.id);
    await swipe(W - 5, W - 150);
    touch('touchstart', 10, 300); touch('touchmove', 14, 330); touch('touchmove', 20, 380); touch('touchmove', 150, 400); touch('touchend', 150, 400);
    await sleep(80);
    check('rolagem que depois entorta pro lado continua sendo rolagem', App.currentFile?.id === 'n-z', App.currentFile?.id);
    App.showDiagnostics();
    const logText = d.getElementById('debug-text').textContent;
    check('o painel de diagnostico conta o que houve com cada gesto', /swipe left x=28/.test(logText) && /swipe: back pull=\d+/.test(logText) && /swipe drop: vertical/.test(logText), logText.split('\n').filter(l => l.includes('swipe')).slice(-8));
    d.getElementById('debug-close').click();

    touch('touchstart', 5, 300); touch('touchmove', 40, 300);
    check('a seta aparece do lado esquerdo, ainda sem armar', hint.classList.contains('visible') && hint.dataset.side === 'left' && !hint.classList.contains('armed'), hint.className);
    touch('touchmove', 150, 300);
    check('passando do ponto a seta arma', hint.classList.contains('armed'));
    touch('touchend', 150, 300); await sleep(80);
    check('soltar volta pra nota anterior, e a seta some', App.currentFile?.id === 'L' && !hint.classList.contains('visible'), App.currentFile);

    await swipe(W - 5, W - 150);
    check('borda direita avanca de volta pra nota do link', App.currentFile?.id === 'n-z' && App.navStack.length === 3, [App.currentFile?.id, App.navStack.length]);
    check('botao voltar do sistema continua voltando depois de avancar', w.__back() === 'handled'); await sleep(80);
    check('... pra nota anterior', App.currentFile?.id === 'L');

    await swipe(5, 150);
    check('voltar de novo: pasta', view() === 'browse' && App.folder?.id === VAULT);
    await swipe(W - 5, W - 150);
    check('avancar da pasta reabre a nota', App.currentFile?.id === 'L');
    await swipe(W - 5, W - 150);
    check('... e avanca mais uma, ate a do link', App.currentFile?.id === 'n-z');

    await swipe(5, 150);
    App.els.previewContainer.querySelector('a.wikilink').click(); await sleep(80);
    check('abrir outra coisa depois de voltar zera o avancar', App.currentFile?.id === 'n-z' && App.fwdStack.length === 0, App.fwdStack);

    // Dialogo aberto: a esquerda fecha o dialogo, como o botao voltar
    App.showDiagnostics();
    await swipe(5, 150);
    check('com dialogo aberto, deslizar fecha o dialogo e fica na nota', !d.getElementById('debug-overlay').classList.contains('visible') && App.currentFile?.id === 'n-z');

    // Texto selecionado: arrastar perto da borda e mexer na selecao, nao voltar
    const range = d.createRange();
    range.selectNodeContents(App.els.previewContainer);
    w.getSelection().removeAllRanges(); w.getSelection().addRange(range);
    await swipe(5, 150);
    check('com texto selecionado nao volta', App.currentFile?.id === 'n-z');
    w.getSelection().removeAllRanges();

    // Tela de desenho: traco que comeca na borda e traco
    App.setMode('edit');
    d.querySelector('.toolbar-btn[data-sketch]').click();
    await swipe(5, 150);
    check('na tela de desenho nao volta nem fecha o desenho', !!App.sketch && App.currentFile?.id === 'n-z');
  }

  console.log('38. Navegar de novo antes de a nota anterior carregar nao suja a pilha do voltar');
  {
    // Do log do aparelho em 19 set 2026: dois "avancar" com 1s de intervalo, rede lenta, e depois o voltar
    // parou tres vezes na mesma pasta. A tela que fica pra tras era lida enquanto a nota ainda carregava.
    const { App, drive, w } = await boot({ watcher: true });
    seedVault(drive);
    drive.put('L', 'com link.md', 'vai [[zebra]]', [VAULT]);
    const d = w.document;
    const stack = () => App.navStack.map(s => s.view === 'file' ? s.id : s.view === 'browse' ? `pasta:${s.id === VAULT ? 'vault' : s.id}` : s.view);
    const item = (text) => [...d.querySelectorAll('.browser-item')].find(li => li.textContent.includes(text));

    d.getElementById('welcome-open').click(); await sleep(80);
    item('com link').click(); await sleep(80);
    App.els.previewContainer.querySelector('a.wikilink').click(); await sleep(80);
    w.__back(); await sleep(80);
    w.__back(); await sleep(80);
    check('pasta, com duas notas pra frente', d.body.dataset.view === 'browse' && App.fwdStack.length === 2, stack());

    drive.delay = 60;
    App.goForward();            // comeca a carregar "com link"...
    await sleep(10);
    await App.goForward();      // ...e avanca de novo antes de ela chegar
    await sleep(200);
    check('dois avancar seguidos: chega na nota do link, com a do meio na pilha', App.currentFile?.id === 'n-z' && stack().join(' > ') === 'welcome > pasta:vault > L', stack());

    w.__back(); await sleep(200);
    check('voltar: a nota do meio', App.currentFile?.id === 'L', App.currentFile?.id);
    w.__back(); await sleep(200);
    check('voltar: a pasta, uma vez so', d.body.dataset.view === 'browse' && stack().join(' > ') === 'welcome', stack());

    // Dois toques seguidos na lista: o segundo nao pode empilhar a pasta de novo
    item('zebra').click();
    await sleep(10);
    item('Abacaxi').click();
    await sleep(250);
    check('dois toques seguidos: abre a segunda nota', App.currentFile?.id === 'n-a', App.currentFile?.id);
    w.__back(); await sleep(200);
    w.__back(); await sleep(200);
    check('dois voltar bastam pra sair da pasta: nenhum cai no vazio', d.body.dataset.view === 'welcome', [d.body.dataset.view, stack()]);

    // Voltar com a nota ainda carregando desiste dela: ela nao pode aparecer sozinha depois
    d.getElementById('welcome-open').click(); await sleep(250);
    item('zebra').click();
    await sleep(10);
    w.__back(); await sleep(250);
    check('voltar no meio do carregamento fica na pasta', d.body.dataset.view === 'browse' && App.currentFile === null && stack().join(' > ') === 'welcome', [d.body.dataset.view, App.currentFile?.id, stack()]);

    // O mesmo de dentro de uma nota: o link tocado e abandonado nao aparece depois
    item('com link').click(); await sleep(250);
    App.els.previewContainer.querySelector('a.wikilink').click();
    await sleep(10);
    w.__back(); await sleep(250);
    check('voltar com o link ainda carregando fica na nota', App.currentFile?.id === 'L' && stack().join(' > ') === 'welcome > pasta:vault', [App.currentFile?.id, stack()]);

    // Toque que nao abre nada, dado com outra nota a caminho, nao pode comer a entrada dela
    drive.put('Q', 'quebrada.md', 'vai [[zebra]] e [[nao existe]]', [VAULT]);
    await App.openFile('Q', 'quebrada.md');
    const links = App.els.previewContainer.querySelectorAll('a.wikilink');
    links[0].click();
    await sleep(10);
    links[1].click();
    await sleep(300);
    check('o ultimo toque vence: link quebrado tocado com outra nota a caminho desiste dela, avisa e fica', App.currentFile?.id === 'Q' && /não encontrada/.test(App.els.saveStatus.textContent) && stack().join(' > ') === 'welcome > pasta:vault', [App.currentFile?.id, App.els.saveStatus.textContent, stack()]);

    // Dois voltar seguidos com a rede lenta sobem dois niveis: o segundo nao pode "desistir" do primeiro
    links[0].click(); await sleep(250);
    check('nota do link aberta a partir da quebrada', App.currentFile?.id === 'n-z' && stack().join(' > ') === 'welcome > pasta:vault > Q', stack());
    w.__back();
    await sleep(10);
    w.__back(); await sleep(250);
    check('o painel de diagnostico diz quanto cada nota levou pra chegar do Drive', App._log.some(l => /loaded zebra\.md \d+ms/.test(l)), App._log.slice(-6));
    check('dois voltar seguidos: da nota do link direto pra pasta',d.body.dataset.view === 'browse' && App.currentFile === null && stack().join(' > ') === 'welcome', [d.body.dataset.view, App.currentFile?.id, stack()]);
    drive.delay = 5;
  }

  console.log('37. Deslizar da borda sem CloseWatcher: anda no historico do navegador');
  {
    const { App, drive, w } = await boot();
    drive.put('A', 'a.md', 'A');
    const d = w.document;
    const touch = (type, x) => {
      const e = new w.Event(type, { bubbles: true, cancelable: true });
      e.touches = type === 'touchend' ? [] : [{ clientX: x, clientY: 300 }];
      e.changedTouches = [{ clientX: x, clientY: 300 }];
      d.body.dispatchEvent(e);
    };
    const swipe = async (x0, x1) => { touch('touchstart', x0); touch('touchmove', x1); touch('touchend', x1); await sleep(120); };
    await App.navigateTo('A', 'a.md');
    await swipe(5, 150);
    check('esquerda volta pra tela inicial', d.body.dataset.view === 'welcome' && App.currentFile === null);
    await swipe(w.innerWidth - 5, w.innerWidth - 150);
    check('direita avanca pra nota', App.currentFile?.id === 'A', App.currentFile);
  }

  console.log('39. Leitura: linha em branco entre itens separa grupos, em vez de espacar a lista toda');
  {
    const { App, drive, w } = await boot();
    const c = App.els.previewContainer;
    const classes = () => [...c.querySelectorAll('li')].map(li => li.className).join('|');

    drive.put('A', 'a.md', '- um\n- dois\n\n- tres\n- quatro\n');
    await App.openFile('A', 'a.md');
    check('4 itens, nenhum embrulhado em paragrafo', c.querySelectorAll('li').length === 4 && c.querySelectorAll('li p').length === 0, c.innerHTML);
    check('so o primeiro item do segundo grupo tem gap (e a classe passa pelo sanitizador)', classes() === '||gap|', c.innerHTML);
    check('o texto dos itens ficou inteiro', [...c.querySelectorAll('li')].map(li => li.textContent.trim()).join(',') === 'um,dois,tres,quatro', c.innerHTML);

    drive.put('B', 'b.md', '- um\n- dois\n- tres\n');
    await App.openFile('B', 'b.md');
    check('lista sem linha em branco: nenhum gap, nenhum paragrafo', classes() === '||' && c.querySelectorAll('li p').length === 0, c.innerHTML);

    drive.put('C', 'c.md', '1. um\n2. dois\n\n\n3. tres\n');
    await App.openFile('C', 'c.md');
    check('numerada continua uma lista so, e duas linhas em branco contam como uma', c.querySelectorAll('ol > li').length === 3 && classes() === '||gap', c.innerHTML);

    drive.put('D', 'd.md', '- pai\n  - a\n  - b\n\n  - c\n- tio\n');
    await App.openFile('D', 'd.md');
    check('na sublista o gap fica no item da sublista', classes() === '|||gap|' && c.querySelectorAll('li ul > li').length === 3, c.innerHTML);

    const tarefas = '- [ ] um\n- [x] dois\n\n- [ ] tres\n- [ ] quatro\n';
    drive.put('E', 'e.md', tarefas);
    await App.openFile('E', 'e.md');
    const boxes = () => [...c.querySelectorAll('li > input[type="checkbox"]')];
    check('4 caixas, filhas diretas do li e tocaveis', boxes().length === 4 && boxes().every(b => !b.disabled), c.innerHTML);
    check('gap no primeiro item do segundo grupo de tarefas', classes() === '||gap|', c.innerHTML);
    const box = boxes()[2];
    box.checked = true;
    box.dispatchEvent(new w.Event('change', { bubbles: true }));
    check('tocar na caixa do segundo grupo marca a linha certa da nota', App.getContent() === tarefas.replace('- [ ] tres', '- [x] tres'), App.getContent());

    drive.put('F', 'f.md', '- um\n\n  continuado\n\n- dois\n');
    await App.openFile('F', 'f.md');
    check('item com dois paragrafos de verdade mantem os dois', c.querySelectorAll('li:first-child p').length === 2, c.innerHTML);
    check('e o item depois dele ganha o respiro', classes() === '|gap', c.innerHTML);

    drive.put('G', 'g.md', '- [[zebra]]\n\n- [[outra|texto]]\n');
    await App.openFile('G', 'g.md');
    check('item com wikilink continua virando link', c.querySelectorAll('li a.wikilink').length === 2 && c.querySelector('li.gap a.wikilink').textContent === 'texto', c.innerHTML);
  }

  console.log('39b. Infra: o CodeMirror 6 sobe no jsdom');
  {
    const { w } = await boot({ editor: true });
    check('o pacote expos o window.CM6', !!w.CM6 && !!w.CM6.EditorView);

    const host = w.document.createElement('div');
    w.document.body.appendChild(host);
    const view = new w.CM6.EditorView({
      doc: '# titulo\n\n- [ ] tarefa\n',
      parent: host,
      extensions: [w.CM6.lineWrapping, w.CM6.markdown({ base: w.CM6.markdownLanguage })],
    });
    // A string termina em \n, que pro CM6 conta como uma quarta linha vazia (doc.lines = numero de \n + 1,
    // contagem de texto puro, sem depender de layout): medido com o pacote real, nao e efeito do jsdom.
    check('o editor desenhou as linhas no DOM', host.querySelectorAll('.cm-line').length === 4,
      host.querySelectorAll('.cm-line').length);
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'fim' } });
    check('escrever por transacao funciona', view.state.doc.toString().endsWith('fim'));
    check('a arvore de sintaxe reconhece tarefa', (() => {
      const nomes = [];
      w.CM6.syntaxTree(view.state).iterate({ enter: (n) => nomes.push(n.name) });
      return nomes.includes('TaskMarker');
    })());
    view.destroy();
  }

  console.log('39c. Fachada: o app fala com o Editor, nao com a lib');
  {
    const { App } = await boot();
    check('sem lib carregada a fachada cai no textarea', App.Editor.ativo() === 'textarea');
    App.Editor.definirTexto('uma linha\noutra linha');
    check('texto ida e volta', App.Editor.texto() === 'uma linha\noutra linha');

    App.Editor.definirTexto('primeira\nsegunda');
    const marca = App.Editor.marcarCursor();
    App.Editor.inserirEmLinhaPropria('![[foto.png]]', marca);
    check('inseriu em linha propria', App.Editor.texto().includes('![[foto.png]]'), App.Editor.texto());

    check('nenhum chamador fora da fachada toca a lib',
      !/this\.editor\.(getContent|setContent|paste|getSelection|setSelection|lines|lineElements|setCommandState|wrapSelection)/
        .test(require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8')
          .split('// ── Editor ──')[0]));
  }

  console.log('39d. CM6: texto, desfazer e a marca de cursor');
  {
    const { App } = await boot({ editor: true });
    check('o editor ativo e o CM6', App.Editor.ativo() === 'cm6', App.Editor.ativo());

    App.Editor.definirTexto('linha um\nlinha dois');
    check('texto ida e volta', App.Editor.texto() === 'linha um\nlinha dois');

    // O jsdom nao tem layout e ninguem consegue tocar no texto: o view e usado so pra pôr o cursor
    // onde um dedo poria, que e o unico jeito de simular o uso real aqui.
    const view = App.Editor._impl.view;
    const NOTA = '---\ncreated: 2026-09-21\nupdated: 2026-09-21\n---\n\ntexto da nota';

    // Nota aberta da lista e camera tocada antes de tocar no texto: a selecao esta em 0 por
    // artefato de carregar o texto, nao por escolha, e a foto ali comeria o frontmatter
    App.Editor.definirTexto(NOTA);
    check('editor nunca focado: nao ha cursor de que falar, a marca e null',
      App.Editor.marcarCursor() === null, App.Editor.marcarCursor());
    const marcaDoFim = App.Editor.inserirEmLinhaPropria('![[foto.png]]', App.Editor.marcarCursor());
    check('editor nunca focado: a foto entra no fim, o frontmatter fica na primeira linha',
      App.Editor.texto() === `${NOTA}\n![[foto.png]]\n`, App.Editor.texto());
    check('a insercao devolve marca, e marca nunca e falsy', !!marcaDoFim, marcaDoFim);

    // A leva da galeria, pelo caminho do savePhoto: cada foto usa o retorno da anterior
    App.Editor.definirTexto('nota com fotos');
    let at = App.Editor.marcarCursor();
    for (const nome of ['um.jpg', 'dois.jpg', 'tres.jpg']) at = App.insertOnOwnLine(`![[${nome}]]`, at) || at;
    check('a leva de fotos sai na ordem em que foi escolhida',
      App.Editor.texto() === 'nota com fotos\n![[um.jpg]]\n![[dois.jpg]]\n![[tres.jpg]]\n', App.Editor.texto());

    // O uso normal: o cursor foi posto no meio do texto e o foco foi embora depois (o seletor de
    // foto rouba). A foto cai no cursor, que e onde ela foi pedida, e nao no fim
    App.Editor.definirTexto(NOTA);
    App.Editor.focar();
    view.dispatch({ selection: { anchor: NOTA.indexOf('texto da nota') + 5 } });
    view.contentDOM.blur();
    check('o foco foi mesmo embora', !view.hasFocus);
    const marcaDoMeio = App.Editor.marcarCursor();
    check('cursor posto antes de o foco sumir: a marca existe', !!marcaDoMeio, marcaDoMeio);
    App.Editor.inserirEmLinhaPropria('![[meio.png]]', marcaDoMeio);
    check('sem foco mas com cursor posto: a foto entra no cursor e o frontmatter fica inteiro',
      App.Editor.texto() === `---\ncreated: 2026-09-21\nupdated: 2026-09-21\n---\n\ntexto\n![[meio.png]]\n da nota`,
      App.Editor.texto());

    // A nota cresce enquanto a foto sobe: a marca anda junto e a foto cai onde foi pedida
    App.Editor.definirTexto('uma nota\ncom tres linhas\nde texto');
    App.Editor.focar();
    App.Editor.cursorNoFim();
    const marca = App.Editor.marcarCursor();
    App.cm6Digitar('\nescrito enquanto a foto subia');
    App.Editor.inserirEmLinhaPropria('![[tarde.png]]', marca);
    check('a foto entra na marca, e o que foi escrito depois continua embaixo',
      App.Editor.texto() === 'uma nota\ncom tres linhas\nde texto\n![[tarde.png]]\n\nescrito enquanto a foto subia',
      App.Editor.texto());

    // Recarga depois de conflito com a pessoa dentro do editor: o texto troca debaixo dela, mas ela
    // continua ali escrevendo, entao o cursor dela continua valendo (nao vira nota aberta da lista)
    check('o editor continua focado', view.hasFocus);
    App.Editor.definirTexto('texto novo, que chegou do Drive');
    check('texto trocado com o editor focado: ainda ha cursor de que falar',
      App.Editor.marcarCursor() !== null, App.Editor.marcarCursor());

    // E a nota encolher inteira embaixo da marca (recarregada durante o upload) nao pode estourar
    App.Editor.definirTexto('curta');
    App.Editor.inserirEmLinhaPropria('![[depois.png]]', marca);
    check('marca de nota que encolheu nao estoura: cai no comeco do texto novo',
      App.Editor.texto() === '![[depois.png]]\ncurta', App.Editor.texto());

    App.Editor.definirTexto('base');
    App.cm6Digitar(' mais');
    check('digitou', App.Editor.texto() === 'base mais', App.Editor.texto());
    check('desfez', App.Editor.desfazer() && App.Editor.texto() === 'base', App.Editor.texto());
    check('refez', App.Editor.refazer() && App.Editor.texto() === 'base mais', App.Editor.texto());
  }

  console.log('40. Edicao: Enter numa tarefa continua a lista de tarefas');
  {
    const { App, w } = await boot({ editor: true });
    const view = App.Editor._impl.view;

    // O Enter no CM6 e um comando: e exatamente o que o keymap chama, no celular e aqui. Fora de
    // lista ou tarefa o proprio pacote documenta que o comando nao faz nada (context.length vazio),
    // por isso o keymap do app tem o Enter do defaultKeymap logo depois: aqui a queda pro mesmo
    // comando repete essa ordem, senao "paragrafo comum" ficaria sem Enter nenhum, o que nao e
    // o que acontece na tela.
    const enterDoParagrafo = w.CM6.defaultKeymap.find(b => b.key === 'Enter').run;
    const enter = (conteudo, em) => {
      App.Editor.definirTexto(conteudo);
      view.dispatch({ selection: { anchor: em } });
      if (!w.CM6.insertNewlineContinueMarkup(view)) enterDoParagrafo(view);
      const doc = view.state.doc;
      const cursor = view.state.selection.main.head;
      const linha = doc.lineAt(cursor);
      return { text: doc.toString(), at: `${linha.number - 1}:${cursor - linha.from}` };
    };

    check('o editor do teste e o CM6, nao o textarea', App.Editor.ativo() === 'cm6');

    let r = enter('- [ ] comprar pao', 17);
    check('tarefa com texto: a linha nova nasce tarefa, cursor depois da caixinha',
      r.text === '- [ ] comprar pao\n- [ ] ' && r.at === '1:6', r);

    r = enter('- [x] feito', 11);
    check('tarefa marcada continua desmarcada', r.text === '- [x] feito\n- [ ] ' && r.at === '1:6', r);

    r = enter('- [ ] ', 6);
    check('tarefa vazia encerra a lista', r.text === '' && r.at === '0:0', r);

    // Regressao: com dois itens na lista (o de um item so cai no caso acima, que nao passa por
    // aqui), sem nonTightLists:false o CM6 gastava tres Enters pra sair de uma lista de tarefa: o
    // segundo inseria uma linha em branco e mantinha a caixinha, so o terceiro encerrava de vez. O
    // TinyMDE encerrava no segundo, e e o comando configurado no keymap do app (nao o
    // insertNewlineContinueMarkup cru) que faz isso continuar valendo.
    {
      const comandoDoApp = w.CM6.insertNewlineContinueMarkupCommand({ nonTightLists: false });
      App.Editor.definirTexto('- [ ] comprar pao');
      view.dispatch({ selection: { anchor: 17 } });
      comandoDoApp(view);
      check('primeiro Enter: nasce uma segunda tarefa vazia',
        view.state.doc.toString() === '- [ ] comprar pao\n- [ ] ', view.state.doc.toString());
      comandoDoApp(view);
      check('segundo Enter na tarefa vazia: encerra a lista de uma vez, sem linha em branco no meio',
        view.state.doc.toString() === '- [ ] comprar pao\n', view.state.doc.toString());
    }

    r = enter('  - [ ] sub', 11);
    check('sublista mantem o recuo', r.text === '  - [ ] sub\n  - [ ] ' && r.at === '1:8', r);

    r = enter('- [ ] ovos leite', 11);
    check('Enter no meio: o texto que desce vira tarefa, sem o espaco que sobrou no fim da linha de cima',
      r.text === '- [ ] ovos\n- [ ] leite' && r.at === '1:6', r);

    r = enter('- [ ] comprar pao', 6);
    check('Enter logo depois da caixinha: o texto desce inteiro e continua tarefa',
      r.text === '- [ ]\n- [ ] comprar pao' && r.at === '1:6', r);

    r = enter('- item', 6);
    check('lista comum continua lista comum', r.text === '- item\n- ' && r.at === '1:2', r);

    r = enter('- ', 2);
    check('item comum vazio tambem encerra a lista', r.text === '' && r.at === '0:0', r);

    r = enter('titulo\n\n- [ ] um\n- [ ] dois', 16);
    check('tarefa no meio da nota: so as duas linhas mexidas mudam',
      r.text === 'titulo\n\n- [ ] um\n- [ ] \n- [ ] dois' && r.at === '3:6', r);

    r = enter('1. um', 5);
    check('lista numerada continua contando', r.text === '1. um\n2. ' && r.at === '1:3', r);

    r = enter('paragrafo', 9);
    check('paragrafo comum nao ganha marcador', r.text === 'paragrafo\n' && r.at === '1:0', r);
  }

  console.log('41. Barra de formatacao no CM6');
  {
    const { App } = await boot({ editor: true });
    const view = App.Editor._impl.view;
    const formatar = (texto, de, ate, nome) => {
      App.Editor.definirTexto(texto);
      view.dispatch({ selection: { anchor: de, head: ate } });
      App.Editor.formatar(nome);
      return App.Editor.texto();
    };

    check('negrito envolve a selecao', formatar('uma palavra', 4, 11, 'bold') === 'uma **palavra**');
    check('italico envolve a selecao', formatar('uma palavra', 4, 11, 'italic') === 'uma _palavra_');
    check('codigo envolve a selecao', formatar('uma palavra', 4, 11, 'code') === 'uma `palavra`');
    check('sem selecao o negrito poe um lugar pra escrever', formatar('vazio', 5, 5, 'bold') === 'vazio**texto**');
    check('link usa o formato do app', formatar('site', 0, 4, 'link') === '[site](url)');
    check('titulo entra no comeco da linha', formatar('uma linha', 3, 3, 'heading') === '## uma linha');
    check('titulo de novo tira', formatar('## uma linha', 4, 4, 'heading') === 'uma linha');
    check('lista troca o marcador do titulo', formatar('## uma linha', 4, 4, 'list') === '- uma linha');
    check('tarefa entra', formatar('uma linha', 3, 3, 'checklist') === '- [ ] uma linha');
    check('citacao em duas linhas de uma vez',
      formatar('uma\ndois', 1, 6, 'quote') === '> uma\n> dois');

    // Regressao: a nota termina em \n, entao o CM6 conta uma terceira linha vazia depois do
    // ultimo Enter. Selecionar a nota inteira e formatar e uso comum, e essa linha vazia nao foi
    // tocada de verdade pela selecao (a selecao termina exatamente no comeco dela): nao pode
    // ganhar o marcador
    {
      const notaComQuebra = 'compra\nleite\n';
      App.Editor.definirTexto(notaComQuebra);
      view.dispatch({ selection: { anchor: 0, head: notaComQuebra.length } });
      App.Editor.formatar('quote');
      check('selecao ate o fim do texto nao marca a linha vazia que a quebra final cria',
        App.Editor.texto() === '> compra\n> leite\n', App.Editor.texto());
    }

    // Sem selecao, o negrito precisa deixar a selecao no miolo (em cima de "texto"), senao quem
    // digitar em seguida escreve fora dos asteriscos
    App.Editor.definirTexto('vazio');
    view.dispatch({ selection: { anchor: 5, head: 5 } });
    App.Editor.formatar('bold');
    const sel = view.state.selection.main;
    check('sem selecao a marcacao fica selecionada, nao so o cursor no fim',
      view.state.doc.sliceString(sel.from, sel.to) === 'texto',
      view.state.doc.sliceString(sel.from, sel.to));

    // Com selecao, formatar tambem deixa a selecao abrangendo so o texto formatado, nao os
    // marcadores: quem digitar em seguida substitui a palavra, nao apaga os asteriscos junto.
    // A selecao armada aqui (a frase inteira) e de proposito diferente da selecao final esperada
    // (so o texto, sem as marcas): se o codigo nao somar antes.length certinho, ou nao mexer na
    // selecao, o resultado nao bate nem no texto nem na posicao
    App.Editor.definirTexto('uma palavra');
    view.dispatch({ selection: { anchor: 0, head: 11 } });
    App.Editor.formatar('bold');
    const sel2 = view.state.selection.main;
    check('com selecao mais ampla que o esperado, a selecao final encolhe pro texto formatado, sem as marcas',
      view.state.doc.sliceString(sel2.from, sel2.to) === 'uma palavra' && sel2.from === 2 && sel2.to === 13,
      { from: sel2.from, to: sel2.to, texto: view.state.doc.sliceString(sel2.from, sel2.to) });

    // O botao e tocado com o teclado aberto: se o foco nao voltar pro editor, o teclado fecha.
    // Os dois caminhos do formatar (wrap e marcador de linha) retornam em pontos diferentes do
    // codigo, entao os dois precisam ser conferidos.
    view.contentDOM.blur();
    App.Editor.definirTexto('uma linha');
    view.dispatch({ selection: { anchor: 3, head: 3 } });
    App.Editor.formatar('heading');
    check('o foco volta pro editor depois de formatar por marcador de linha (senao o teclado fecha)',
      view.hasFocus);

    view.contentDOM.blur();
    App.Editor.definirTexto('uma palavra');
    view.dispatch({ selection: { anchor: 4, head: 11 } });
    App.Editor.formatar('bold');
    check('o foco volta pro editor depois de formatar por wrap (senao o teclado fecha)',
      view.hasFocus);
  }

  console.log('42. Foto desenhada na linha, no CM6');
  {
    const { App, w } = await boot({ editor: true });
    App._embedInfo.set('foto.png', { url: 'blob:x', width: 800, height: 400 });
    App.Editor.definirTexto('antes\n![[foto.png]]\ndepois');
    const mudou = App.Editor.decorarEmbeds((linha) => App.embedDaLinha(linha));
    check('a decoracao disse que mudou algo', mudou === true);

    const linhas = [...w.document.querySelectorAll('.cm-line')];
    const comFoto = linhas.filter((el) => el.classList.contains('embed-line'));
    check('so a linha da foto foi decorada', comFoto.length === 1, linhas.map(e => e.className));
    check('a linha decorada e a do meio', comFoto[0].textContent === '![[foto.png]]', comFoto[0].textContent);
    check('a imagem entrou como variavel de CSS', /blob:x/.test(comFoto[0].getAttribute('style') || ''));

    // Editar uma linha depois da foto (a de cima nao muda de posicao) nao pode fazer a decoracao
    // sumir nem acusar mudanca: a posicao da linha da foto e o estilo dela continuam os mesmos.
    // Medido: editar uma linha ANTES da foto desloca o offset dela no documento, e a assinatura
    // (que leva a posicao) acusa mudanca corretamente ali, entao o teste evita esse caso pra isolar
    // o que quer provar
    App.Editor.definirTexto('antes\n![[foto.png]]\ndepois editado');
    const mudouOutraLinha = App.Editor.decorarEmbeds((linha) => App.embedDaLinha(linha));
    check('editar uma linha depois da foto nao acusa mudanca (mesma posicao, mesmo estilo)',
      mudouOutraLinha === false, mudouOutraLinha);
    check('a foto continua desenhada depois de editar outra linha',
      w.document.querySelectorAll('.cm-line.embed-line').length === 1);

    // Trocar a foto por outra do mesmo tamanho mantem a posicao e a contagem de decoracoes iguais:
    // so o estilo muda. Contar decoracoes nao bastaria pra pegar isso (armadilha do brief); a
    // assinatura tem que levar o estilo, nao so a posicao
    App._embedInfo.set('foto.png', { url: 'blob:novo', width: 800, height: 400 });
    const mudouTrocaDeFoto = App.Editor.decorarEmbeds((linha) => App.embedDaLinha(linha));
    check('trocar a foto por outra do mesmo tamanho e detectado como mudanca de verdade',
      mudouTrocaDeFoto === true, mudouTrocaDeFoto);

    // A medida real chega depois, por uma busca assincrona no Drive: o texto do editor nao muda
    // nada, so a resposta de infoDaLinha. E por isso que o campo se refaz por StateEffect, nao so
    // quando o documento muda
    // Medido: a decoracao que havia (a da troca de foto, acima) some, e isso e uma mudanca real na
    // tela (o espaco da foto fecha), entao decorarEmbeds acusa mudou=true aqui tambem, nao so
    // quando uma decoracao aparece
    App._embedInfo.delete('foto.png');
    App.Editor.definirTexto('antes\n![[foto.png]]\ndepois');
    let semMedidaAinda = App.Editor.decorarEmbeds((linha) => App.embedDaLinha(linha));
    check('sem medida ainda, nenhuma linha decorada, e o sumico da decoracao anterior conta como mudanca',
      w.document.querySelectorAll('.cm-line.embed-line').length === 0 && semMedidaAinda === true,
      semMedidaAinda);

    App._embedInfo.set('foto.png', { url: 'blob:chegou-depois', width: 800, height: 400 });
    const medidaChegouDepois = App.Editor.decorarEmbeds((linha) => App.embedDaLinha(linha));
    check('a medida chegando depois decora sozinha, sem o texto ter mudado',
      medidaChegouDepois === true && w.document.querySelectorAll('.cm-line.embed-line').length === 1,
      medidaChegouDepois);

    App.Editor.definirTexto('so texto');
    App.Editor.decorarEmbeds((linha) => App.embedDaLinha(linha));
    check('sem embed, nenhuma linha decorada',
      w.document.querySelectorAll('.cm-line.embed-line').length === 0);
  }

  done();
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
