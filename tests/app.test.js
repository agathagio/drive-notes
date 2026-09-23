// Runs the real app.js inside jsdom against an in-memory fake Drive: saving, conflicts, drafts,
// reading view, navigation, rename, login, formatting and the file browser.
//   npm test
// The editor here is the fallback textarea, except where a scenario asks for boot({ editor: true }),
// which loads the real CodeMirror bundle into the same window (scenario 39b onwards). What needs
// layout, a real caret or a keyboard: browser.test.js.
const crypto = require('crypto');
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
// Where a new note is born: the note index puts it in only if the folder answers a trail
const INBOX = /DEFAULT_FOLDER_ID: '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'))[1];

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
        const files = [...drive.files.values()].filter(f => !f.trashed && f.parents.includes(parent[1]))
          .map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType || 'text/markdown', modifiedTime: f.modifiedTime }));
        return json({ files });
      }
      // The index of titles lists the whole Drive by type: folders first, then the note files.
      // One type alone, or several between parentheses: `(mimeType = 'a' or mimeType = 'b') and trashed = false`
      const byType = /^\(?(mimeType = '[^']+'(?: or mimeType = '[^']+')*)\)? and trashed = false$/.exec(q);
      if (byType) {
        const types = [...byType[1].matchAll(/mimeType = '([^']+)'/g)].map(m => m[1]);
        drive.log.push(`LIST-TYPE ${types.join(' ')}`);
        if (drive.failReads) return json({}, 500);
        const files = [...drive.files.values()].filter(f => !f.trashed && types.includes(f.mimeType || 'text/markdown'))
          .map(f => ({ id: f.id, name: f.name, parents: f.parents, mimeType: f.mimeType || 'text/markdown', modifiedTime: f.modifiedTime }));
        return json({ files });
      }
      // "Who links to this note": full text alone, the way the Drive does it (any file with the word, in any form)
      const fullText = /^fullText contains '((?:[^'\\]|\\.)*)'/.exec(q);
      if (fullText) {
        drive.log.push(`FULLTEXT ${fullText[1]}`);
        if (drive.failReads) return json({}, 500);
        const word = fullText[1].replace(/\\(.)/g, '$1').toLowerCase();
        const files = [...drive.files.values()].filter(f => !f.trashed && f.mimeType !== FOLDER
          && (String(f.content).toLowerCase().includes(word) || f.name.toLowerCase().includes(word)))
          .map(f => ({ id: f.id, name: f.name, parents: f.parents, mimeType: f.mimeType || 'text/markdown', modifiedTime: f.modifiedTime }));
        return json({ files });
      }
      if (q.includes(' contains ')) {
        // Search, the way the Drive does it: a name matches on the start of a word, the text on a whole word
        drive.log.push(`SEARCH ${q}`);
        if (drive.failReads) return json({}, 500);
        const words = [...q.matchAll(/name contains '((?:[^'\\]|\\.)*)'/g)].map(x => x[1].replace(/\\(.)/g, '$1').toLowerCase());
        const tokens = (s) => String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        const hit = (f, word) => tokens(f.name).some(t => t.startsWith(word)) || f.name.toLowerCase().startsWith(word) || tokens(f.content).includes(word);
        const files = [...drive.files.values()].filter(f => !f.trashed && f.mimeType !== FOLDER && words.every(word => hit(f, word)))
          .map(f => ({ id: f.id, name: f.name, parents: f.parents, mimeType: f.mimeType || 'text/markdown', modifiedTime: f.modifiedTime }));
        return json({ files });
      }
      const names = [...q.matchAll(/name = '((?:[^'\\]|\\.)*)'/g)].map(x => x[1].replace(/\\(.)/g, '$1'));
      const files = [...drive.files.values()].filter(f => !f.trashed && names.includes(f.name))
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
      const patch = JSON.parse(opts.body);
      // A lixeira do Drive: o arquivo continua existindo, so para de aparecer nas buscas
      if (patch.trashed) {
        if (drive.failTrash) return json({}, 500);
        f.trashed = true; f.modifiedTime = drive.tick();
        drive.log.push(`TRASH ${f.id} ${f.name}`);
        return json({ id: f.id });
      }
      f.name = patch.name; f.modifiedTime = drive.tick();
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

async function boot({ auth = true, seedStorage = {}, seedSession = {}, watcher = false, editor = false, idb = null, drive: givenDrive = null, beforeApp = null, url = 'http://localhost:8000/' } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
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
  // A drive handed in already has its files: what the app's own init opens (the reopening after a new
  // version) needs them before boot returns
  const drive = givenDrive || makeDrive();
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
  for (const [k, v] of Object.entries(seedSession)) w.sessionStorage.setItem(k, v);
  // jsdom has no IndexedDB, and by default the app runs without one: the road it took before the note
  // store, which is also its road on a phone whose IndexedDB fails. `idb: true` gives this boot a clean
  // database; the factory of a previous boot is the same phone's storage, seen by an app opened again.
  let factory = null;
  if (idb) {
    const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
    factory = idb === true ? new IDBFactory() : idb;
    w.indexedDB = factory;
    w.IDBKeyRange = IDBKeyRange;
  }
  w.eval(fs.readFileSync(LIBS.marked, 'utf8'));
  w.eval(fs.readFileSync(LIBS.purify, 'utf8'));
  // Whatever has to be in place before the app's own init runs (it may open a note by itself)
  if (beforeApp) beforeApp(w);
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
  return { w, App, drive, type, drafts, idb: factory };
}

/**
 * Enter de verdade: um keydown no elemento editavel do CM6, que e por onde ele escuta, no celular
 * e aqui. E a unica forma de testar Enter que prova alguma coisa. Chamar o comando na mao pula o
 * keymap, e e no keymap que mora a ordem entre o Enter do app e o da biblioteca: foi assim que o
 * binding do commit 5f96e08, que nunca rodou no app, passou batido pela suite inteira.
 */
function apertarEnter(w, view) {
  view.contentDOM.dispatchEvent(new w.KeyboardEvent('keydown',
    { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
}

/**
 * Digita no fim do documento como uma edicao de usuario: o `userEvent` e o que faz o historico do
 * desfazer registrar a digitacao. Isto morava no app.js como App.cm6Digitar ate 21 set 2026, onde
 * era o unico lugar fora da fachada a alcancar a implementacao do editor. E codigo de teste, e o
 * lugar dele e aqui.
 */
function cm6Type(App, texto) {
  const view = App.Editor._impl.view;
  view.dispatch({ changes: { from: view.state.doc.length, insert: texto }, userEvent: 'input.type' });
}

/**
 * Onde a decoracao `plain-brackets` esta AGORA, lida das fontes de decoracao do editor em vez do
 * DOM: o DOM so desenha a janela visivel, e o que este cenario precisa saber e o que o editor
 * calculou pro documento inteiro. Fonte de StateField vem como conjunto pronto; fonte de
 * ViewPlugin vem como funcao da view.
 */
function colchetesComuns(App, w) {
  const view = App.Editor._impl.view;
  const marcas = [];
  for (const fonte of view.state.facet(w.CM6.EditorView.decorations)) {
    const conjunto = typeof fonte === 'function' ? fonte(view) : fonte;
    conjunto.between(0, view.state.doc.length, (de, ate, deco) => {
      if (deco.spec?.class === 'plain-brackets') marcas.push([de, ate]);
    });
  }
  return marcas;
}

/** Poe o texto, poe o cursor, aperta Enter. Devolve o texto e onde o cursor parou (linha:coluna) */
function enterEm(App, w, conteudo, em) {
  const view = App.Editor._impl.view;
  App.Editor.setText(conteudo);
  view.dispatch({ selection: { anchor: em } });
  apertarEnter(w, view);
  const cursor = view.state.selection.main.head;
  const linha = view.state.doc.lineAt(cursor);
  return { text: view.state.doc.toString(), at: `${linha.number - 1}:${cursor - linha.from}` };
}

/** Puts a record in the arrival box of a phone (an IndexedDB factory, see boot's `idb`), the way sw.js does */
async function seedArrival(factory, record) {
  await new Promise((resolve, reject) => {
    const request = factory.open('drivenotes-arrivals', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('arrivals', { keyPath: 'id' });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const tx = request.result.transaction('arrivals', 'readwrite');
      tx.objectStore('arrivals').put(record);
      tx.oncomplete = () => { request.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
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

    // O sw.js e quem decide se o celular pega a versao nova ou fica na velha. Arquivo nosso que o
    // index.html carrega e que nao esta no STATIC_ASSETS nunca entra no cache: o app abre pela
    // metade sem rede, e ninguem percebe ate o aparelho estar offline. Foi assim que o
    // vendor/codemirror.js quase ficou de fora na troca de editor.
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const estaticos = /const STATIC_ASSETS = \[([\s\S]*?)\]/.exec(sw)[1];
    const nossos = [...html.matchAll(/<script[^>]*\ssrc="(?!https?:|\/\/|data:)([^"]+)"/g)]
      .map(m => m[1].replace(/^\.\//, ''));
    check('todo arquivo nosso que o index.html carrega esta no STATIC_ASSETS do sw.js',
      nossos.length > 0 && nossos.every(src => estaticos.includes(`'./${src}'`)),
      { nossos, faltando: nossos.filter(src => !estaticos.includes(`'./${src}'`)) });

    // The CDN scripts carry an integrity hash: the browser refuses a file that does not match it,
    // and a wrong hash shows up on the phone as a reading view with no formatting. jsDelivr serves
    // the same bytes npm installs (compared on 22 Sep 2026), so the hash of the file in
    // node_modules is the one the phone checks against. Bumping a library: the failure prints the
    // new value to paste into index.html.
    for (const [name, file] of [['marked', LIBS.marked], ['dompurify', LIBS.purify]]) {
      const attrs = new RegExp(`<script src="https://cdn\\.jsdelivr\\.net/npm/${name}@[^"]+"([^>]*)>`).exec(html)?.[1] || '';
      const expected = 'sha384-' + crypto.createHash('sha384').update(fs.readFileSync(file)).digest('base64');
      check(`${name}: integrity do index.html = hash do arquivo instalado`, attrs.includes(`integrity="${expected}"`), { expected });
      // The service worker fetches the same file on its own and has to check the same hash
      const swHash = new RegExp(`npm/${name}@[^']+': '([^']+)'`).exec(sw)?.[1];
      check(`${name}: sw.js confere a copia do cache com o mesmo hash`, swHash === expected, { swHash, expected });
      // Without it the request goes out without CORS, and the browser blocks the script because it cannot check the hash
      check(`${name}: tag com crossorigin="anonymous"`, attrs.includes('crossorigin="anonymous"'));
    }
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
    const uploaded = () => [...drive.files.values()].filter(f => /(^|-)foto-\d/.test(f.name));

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
    check('foto no _media, com o nome da nota e a hora', uploaded().length === 1 && up.parents[0] === 'media' && /^a-foto-\d{6}\.jpg$/.test(up.name), up);
    check('conteudo e tipo chegaram inteiros', up.content === 'bytes-da-foto' && up.mimeType === 'image/jpeg', up);
    const pngBlob = new w.Blob(['x'], { type: 'image/png' });
    const drawn = App.mediaName(pngBlob, null, 'desenho');
    check('mediaName carimba a nota, o prefixo e a extensao do tipo', /^a-desenho-\d{6}\.png$/.test(drawn), drawn);
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
    const uploaded = () => [...drive.files.values()].filter(f => /(^|-)foto-\d/.test(f.name));
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
    check('no mesmo segundo, a segunda e a terceira ganham -2 e -3', /^a-foto-\d{6}\.jpg$/.test(leva[0])
      && leva[1] === leva[0].replace('.jpg', '-2.jpg') && leva[2] === leva[0].replace('.jpg', '-3.jpg'), leva);

    // Uma leva de fotos tem que cair uma embaixo da outra, e nao todas na mesma posicao guardada
    // (a ultima ficaria em cima). Quem segura isso e a marca que cada insercao devolve, entao a
    // prova roda no editor de verdade, nao no textarea.
    {
      const { App: comEditor } = await boot({ editor: true });
      const view = comEditor.Editor._impl.view;

      // Caminho de reserva: a camera tocada antes de o dedo encostar no texto. Sem cursor posto, a
      // foto vai pro fim da nota, e o fim anda junto com a leva.
      comEditor.Editor.setText('linha um');
      let at = comEditor.Editor.markCaret();
      check('o editor voltou do seletor sem cursor nenhum', at === null, at);
      for (const n of [1, 2, 3]) at = comEditor.insertOnOwnLine(`![[f${n}]]`, at) || at;
      check('sem cursor no editor, a fila continua na ordem',
        comEditor.Editor.getText() === 'linha um\n![[f1]]\n![[f2]]\n![[f3]]\n', comEditor.Editor.getText());

      // O caso do celular: o cursor foi posto no texto e o seletor de foto levou o foco embora
      // (no CM6 a marca sobrevive a isso). So aqui a ordem depende MESMO de cada insercao devolver
      // a marca da linha seguinte: sem esse retorno, a marca velha e mapeada pra ANTES do que
      // acabou de entrar e a leva sai de tras pra frente, que e o bug do commit 439b920. Partir de
      // marca nula, como o caminho de cima, deixaria a ordem certa por acidente.
      comEditor.Editor.setText('linha um');
      comEditor.Editor.focus();
      view.dispatch({ selection: { anchor: 'linha um'.length } });
      view.contentDOM.blur();
      at = comEditor.Editor.markCaret();
      check('cursor posto antes de o seletor roubar o foco: a marca existe', !!at, at);
      for (const n of [1, 2, 3]) at = comEditor.insertOnOwnLine(`![[f${n}]]`, at) || at;
      check('com cursor posto, a fila empilha a partir dele, na ordem',
        comEditor.Editor.getText() === 'linha um\n![[f1]]\n![[f2]]\n![[f3]]\n', comEditor.Editor.getText());
    }

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
    // The Drive types a .txt as text/plain, and the note index only lists text/markdown
    drive.put('n-txt', 'lista.txt', 't', [VAULT]); drive.files.get('n-txt').mimeType = 'text/plain';
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
    const uploaded = () => [...drive.files.values()].filter(f => /(^|-)desenho-\d/.test(f.name));
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
    check('desenho no _media, com o nome da nota e a hora', uploaded().length === 1 && up.parents[0] === 'media' && /^a-desenho-\d{6}\.png$/.test(up.name), up);
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
    check('tentar de novo com a rede de volta sobe o mesmo desenho', uploaded().length === 2 && !App.sketch && /!\[\[a-desenho-/.test(ta.value));
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
    const uploaded = () => [...drive.files.values()].filter(f => /(^|-)desenho-\d/.test(f.name));
    const embeds = () => (ta.value.match(/!\[\[a-desenho-/g) || []).length;
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
    check('sem lib carregada a fachada cai no textarea', App.Editor.kind() === 'textarea');
    App.Editor.setText('uma linha\noutra linha');
    check('texto ida e volta', App.Editor.getText() === 'uma linha\noutra linha');

    App.Editor.setText('primeira\nsegunda');
    const marca = App.Editor.markCaret();
    App.Editor.insertOnOwnLine('![[foto.png]]', marca);
    check('inseriu em linha propria', App.Editor.getText().includes('![[foto.png]]'), App.Editor.getText());

    // A lib do editor tem que ficar atras da fachada: quem esta fora da secao `Editor` fala com
    // App.Editor e mais nada. A secao e delimitada pelos dois marcadores de comentario (o dela e o
    // da secao seguinte), e o que sobra dos dois lados e onde moram os chamadores. O vocabulario
    // procurado e o do CM6; `\.dispatch\(` nao pega o `dispatchEvent(` que o app usa no DOM.
    const fonteDoApp = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
    const foraDaFachada = fonteDoApp.split('// ── Editor ──')[0]
      + fonteDoApp.split('// ── Google Auth ──').slice(1).join('');
    // `Editor\._impl` fecha a fuga mais obvia: um chamador que pegasse a implementacao pela
    // fachada (`App.Editor._impl.view.focus()`) nao casaria com nenhum dos outros pedacos
    const VOCABULARIO_DA_LIB = /window\.CM6|EditorView|view\.state|\.dispatch\(|doc\.line|Editor\._impl/;
    check('nenhum chamador fora da fachada toca a lib',
      !VOCABULARIO_DA_LIB.test(foraDaFachada), VOCABULARIO_DA_LIB.exec(foraDaFachada)?.[0]);
    // ... e a checagem acima so vale se ela souber achar a lib quando ela aparece de verdade
    check('a checagem acima enxerga a lib: dentro da fachada o vocabulario esta la',
      VOCABULARIO_DA_LIB.test(fonteDoApp.split('// ── Editor ──')[1].split('// ── Google Auth ──')[0]));

    // O app nao carrega ajudante que so o teste usa. O cm6Type (cm6Digitar, no nome de antes da
    // traducao) vivia aqui dentro por ser codigo de teste morando no app: ele alcancava
    // Editor._impl.view de dentro da secao do editor, que e justo o pedaco onde a checagem acima
    // nao olha. Agora e uma funcao do proprio arquivo de teste
    check('o app nao expoe ajudante que so o teste usa',
      App.cm6Type === undefined && App.cm6Digitar === undefined);
    check('... e o fonte tambem nao o traz', !/cm6Type|cm6Digitar/.test(fonteDoApp));
  }

  console.log('39d. CM6: texto, desfazer e a marca de cursor');
  {
    const { App } = await boot({ editor: true });
    check('o editor ativo e o CM6', App.Editor.kind() === 'cm6', App.Editor.kind());

    App.Editor.setText('linha um\nlinha dois');
    check('texto ida e volta', App.Editor.getText() === 'linha um\nlinha dois');

    // Abrir uma nota NAO pode entrar na pilha do desfazer. Se entrar, um toque em desfazer logo
    // depois de abrir apaga a nota aberta e traz de volta o texto da anterior, que e o pior jeito
    // de perder texto que este app tem. Quem garante isso e a anotacao addToHistory:false do
    // setText, mas quem executa e a biblioteca: e propriedade emergente dela, e sem esta
    // checagem nada no projeto acusaria a volta do bug.
    check('abrir uma nota nao entra na pilha: nao ha o que desfazer', App.Editor.undo() === false);
    check('... e o texto aberto nao se mexe', App.Editor.getText() === 'linha um\nlinha dois', App.Editor.getText());

    // O jsdom nao tem layout e ninguem consegue tocar no texto: o view e usado so pra pôr o cursor
    // onde um dedo poria, que e o unico jeito de simular o uso real aqui.
    const view = App.Editor._impl.view;
    const NOTA = '---\ncreated: 2026-09-21\nupdated: 2026-09-21\n---\n\ntexto da nota';

    // Nota aberta da lista e camera tocada antes de tocar no texto: a selecao esta em 0 por
    // artefato de carregar o texto, nao por escolha, e a foto ali comeria o frontmatter
    App.Editor.setText(NOTA);
    check('editor nunca focado: nao ha cursor de que falar, a marca e null',
      App.Editor.markCaret() === null, App.Editor.markCaret());
    const marcaDoFim = App.Editor.insertOnOwnLine('![[foto.png]]', App.Editor.markCaret());
    check('editor nunca focado: a foto entra no fim, o frontmatter fica na primeira linha',
      App.Editor.getText() === `${NOTA}\n![[foto.png]]\n`, App.Editor.getText());
    check('a insercao devolve marca, e marca nunca e falsy', !!marcaDoFim, marcaDoFim);

    // A leva da galeria, pelo caminho do savePhoto: cada foto usa o retorno da anterior. Parte de
    // cursor posto de proposito: com marca nula toda insercao cairia no fim do documento e a ordem
    // sairia certa por acidente, mesmo se o retorno da marca sumisse (o bug do commit 439b920).
    App.Editor.setText('nota com fotos');
    App.Editor.focus();
    view.dispatch({ selection: { anchor: 'nota com fotos'.length } });
    view.contentDOM.blur();
    let at = App.Editor.markCaret();
    check('cursor posto antes de a leva comecar: a marca existe', !!at, at);
    for (const nome of ['um.jpg', 'dois.jpg', 'tres.jpg']) at = App.insertOnOwnLine(`![[${nome}]]`, at) || at;
    check('a leva de fotos sai na ordem em que foi escolhida',
      App.Editor.getText() === 'nota com fotos\n![[um.jpg]]\n![[dois.jpg]]\n![[tres.jpg]]\n', App.Editor.getText());

    // O uso normal: o cursor foi posto no meio do texto e o foco foi embora depois (o seletor de
    // foto rouba). A foto cai no cursor, que e onde ela foi pedida, e nao no fim
    App.Editor.setText(NOTA);
    App.Editor.focus();
    view.dispatch({ selection: { anchor: NOTA.indexOf('texto da nota') + 5 } });
    view.contentDOM.blur();
    check('o foco foi mesmo embora', !view.hasFocus);
    const marcaDoMeio = App.Editor.markCaret();
    check('cursor posto antes de o foco sumir: a marca existe', !!marcaDoMeio, marcaDoMeio);
    App.Editor.insertOnOwnLine('![[meio.png]]', marcaDoMeio);
    check('sem foco mas com cursor posto: a foto entra no cursor e o frontmatter fica inteiro',
      App.Editor.getText() === `---\ncreated: 2026-09-21\nupdated: 2026-09-21\n---\n\ntexto\n![[meio.png]]\n da nota`,
      App.Editor.getText());

    // A nota cresce enquanto a foto sobe: a marca anda junto e a foto cai onde foi pedida
    App.Editor.setText('uma nota\ncom tres linhas\nde texto');
    App.Editor.focus();
    App.Editor.moveCaretToEnd();
    const marca = App.Editor.markCaret();
    cm6Type(App, '\nescrito enquanto a foto subia');
    App.Editor.insertOnOwnLine('![[tarde.png]]', marca);
    check('a foto entra na marca, e o que foi escrito depois continua embaixo',
      App.Editor.getText() === 'uma nota\ncom tres linhas\nde texto\n![[tarde.png]]\n\nescrito enquanto a foto subia',
      App.Editor.getText());

    // A marca vence o cursor vivo, e e isso que a docstring do insertOnOwnLine descreve: entre
    // tocar na camera e a foto chegar do Drive a pessoa continua na nota e o cursor anda. A foto
    // cai onde ela estava quando pediu a foto, e nao onde o cursor esta agora.
    App.Editor.setText('primeira\nsegunda\nterceira');
    App.Editor.focus();
    view.dispatch({ selection: { anchor: 'primeira'.length } });
    const marcaDaPrimeira = App.Editor.markCaret();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    App.insertOnOwnLine('![[pedida-antes.png]]', marcaDaPrimeira);
    check('a marca vence o cursor vivo: a foto cai onde foi pedida',
      App.Editor.getText() === 'primeira\n![[pedida-antes.png]]\n\nsegunda\nterceira', App.Editor.getText());

    // Recarga depois de conflito com a pessoa dentro do editor: o texto troca debaixo dela, mas ela
    // continua ali escrevendo, entao o cursor dela continua valendo (nao vira nota aberta da lista)
    check('o editor continua focado', view.hasFocus);
    App.Editor.setText('texto novo, que chegou do Drive');
    check('texto trocado com o editor focado: ainda ha cursor de que falar',
      App.Editor.markCaret() !== null, App.Editor.markCaret());

    // E a nota encolher inteira embaixo da marca (recarregada durante o upload) nao pode estourar
    App.Editor.setText('curta');
    App.Editor.insertOnOwnLine('![[depois.png]]', marca);
    check('marca de nota que encolheu nao estoura: cai no comeco do texto novo',
      App.Editor.getText() === '![[depois.png]]\ncurta', App.Editor.getText());

    App.Editor.setText('base');
    cm6Type(App, ' mais');
    check('digitou', App.Editor.getText() === 'base mais', App.Editor.getText());
    check('desfez', App.Editor.undo() && App.Editor.getText() === 'base', App.Editor.getText());
    check('refez', App.Editor.redo() && App.Editor.getText() === 'base mais', App.Editor.getText());

    // O mesmo, mas com a pilha cheia: escreveu numa nota e abriu outra da lista. O que foi digitado
    // na nota anterior nao pode sobrar pra ser desfeito em cima desta
    App.Editor.setText('outra nota, aberta da lista');
    check('abrir outra nota depois de escrever: nao sobra o que desfazer', App.Editor.undo() === false);
    check('... e o texto da nota aberta fica intacto',
      App.Editor.getText() === 'outra nota, aberta da lista', App.Editor.getText());
  }

  console.log('39e. Nota longa: os colchetes comuns acompanham o que esta na tela');
  {
    // A decoracao que devolve [[wikilink]] e [!note] ao texto comum percorria a arvore de sintaxe
    // INTEIRA, e so quando o documento mudava. Numa nota grande isso custava uma varredura da nota
    // toda a cada tecla e, pior, o que o parser ainda nao tinha alcancado (ele tem orcamento de
    // tempo e continua depois, por transacoes que NAO mudam o documento) ficava sem decoracao ate
    // a proxima tecla: colchete roxo e sublinhado no fim da nota. Agora quem decora e um plugin de
    // view, que olha so a janela visivel e refaz a conta quando a tela rola ou a arvore cresce.
    const { App, w } = await boot({ editor: true });
    const view = App.Editor._impl.view;

    const linhas = ['[[comeco]] e o resto da primeira linha'];
    for (let i = 0; i < 3000; i++) linhas.push(`linha ${i} com texto suficiente pra nota ficar grande de verdade`);
    linhas.push('[[fim]]');
    App.Editor.setText(linhas.join('\n'));

    check('o editor tem so uma parte da nota na tela', view.viewport.to < view.state.doc.length,
      `viewport ate ${view.viewport.to} de ${view.state.doc.length}`);
    const noComeco = colchetesComuns(App, w);
    check('decora so o que esta na tela: o [[comeco]] sim, o [[fim]] la embaixo ainda nao',
      noComeco.length === 1 && noComeco[0][1] < view.viewport.to, noComeco);

    // Rolar ate o fim. O jsdom nao tem layout, entao a janela visivel se move fingindo o retangulo
    // do editor bem acima da tela, que e como o CM6 le "esta rolado la pra baixo" sem layout nenhum
    const fundo = new w.DOMRect(0, -2e6, 800, 4e6);
    view.scrollDOM.getBoundingClientRect = () => fundo;
    view.contentDOM.getBoundingClientRect = () => fundo;
    view.dom.getBoundingClientRect = () => fundo;
    view.requestMeasure();
    for (let i = 0; i < 60 && view.viewport.to < view.state.doc.length; i++) await sleep(25);
    check('a tela chegou ao fim da nota', view.viewport.to === view.state.doc.length, JSON.stringify(view.viewport));

    const ultima = view.state.doc.line(view.state.doc.lines);
    const noFim = colchetesComuns(App, w);
    check('o [[fim]] ganha a decoracao so de a tela chegar nele, sem ninguem digitar nada',
      noFim.some(([de, ate]) => de >= ultima.from && ate <= ultima.to), noFim.slice(-3));
    check('... e no DOM a linha sai como texto comum, nao como link',
      [...w.document.querySelectorAll('.plain-brackets')].some((el) => el.textContent === '[fim]'),
      [...w.document.querySelectorAll('.cm-line')].map((el) => el.className));
  }

  console.log('40. Edicao: Enter numa tarefa continua a lista de tarefas');
  {
    const { App, w } = await boot({ editor: true });
    const view = App.Editor._impl.view;

    // Enter de verdade, pelo caminho do teclado. Este cenario chamava os comandos na mao e por
    // isso deixou passar que o Enter configurado pelo app (o do commit 5f96e08) nunca rodava: o
    // markdown() instala o dele em Prec.high e ganhava de qualquer binding do keymap do app.
    // Agora o comando do app entra em Prec.highest, e e isto aqui que prova que ele chega la.
    const enter = (conteudo, em) => enterEm(App, w, conteudo, em);

    check('o editor do teste e o CM6, nao o textarea', App.Editor.kind() === 'cm6');

    let r = enter('- [ ] comprar pao', 17);
    check('tarefa com texto: a linha nova nasce tarefa, cursor depois da caixinha',
      r.text === '- [ ] comprar pao\n- [ ] ' && r.at === '1:6', r);

    r = enter('- [x] feito', 11);
    check('tarefa marcada continua desmarcada', r.text === '- [x] feito\n- [ ] ' && r.at === '1:6', r);

    r = enter('- [ ] ', 6);
    check('tarefa vazia encerra a lista', r.text === '' && r.at === '0:0', r);

    // A checagem que estava faltando, e que e o motivo de este cenario apertar Enter de verdade:
    // SAIR DE UMA LISTA DE UM ITEM SO CUSTA UM ENTER. Sem o nonTightLists:false chegando ao
    // teclado, o segundo Enter insere uma linha em branco e mantem o marcador, e so o terceiro
    // encerra. Era o que o app fazia de verdade enquanto esta suite achava que nao: o binding do
    // commit 5f96e08 nunca rodou, porque o Enter do markdown() esta em Prec.high.
    {
      App.Editor.setText('- [ ] comprar pao');
      view.dispatch({ selection: { anchor: 17 } });
      apertarEnter(w, view);
      check('primeiro Enter: nasce uma segunda tarefa vazia',
        view.state.doc.toString() === '- [ ] comprar pao\n- [ ] ', view.state.doc.toString());
      apertarEnter(w, view);
      check('segundo Enter na tarefa vazia: encerra a lista de uma vez, sem linha em branco no meio',
        view.state.doc.toString() === '- [ ] comprar pao\n', view.state.doc.toString());

      App.Editor.setText('- item');
      view.dispatch({ selection: { anchor: 6 } });
      apertarEnter(w, view);
      apertarEnter(w, view);
      check('o mesmo na lista comum: dois Enters e a lista acabou, sem linha em branco no meio',
        view.state.doc.toString() === '- item\n', view.state.doc.toString());
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
      App.Editor.setText(texto);
      view.dispatch({ selection: { anchor: de, head: ate } });
      App.Editor.format(nome);
      return App.Editor.getText();
    };

    check('negrito envolve a selecao', formatar('uma palavra', 4, 11, 'bold') === 'uma **palavra**');
    check('italico envolve a selecao', formatar('uma palavra', 4, 11, 'italic') === 'uma *palavra*');
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
      App.Editor.setText(notaComQuebra);
      view.dispatch({ selection: { anchor: 0, head: notaComQuebra.length } });
      App.Editor.format('quote');
      check('selecao ate o fim do texto nao marca a linha vazia que a quebra final cria',
        App.Editor.getText() === '> compra\n> leite\n', App.Editor.getText());
    }

    // Sem selecao, o negrito precisa deixar a selecao no miolo (em cima de "texto"), senao quem
    // digitar em seguida escreve fora dos asteriscos
    App.Editor.setText('vazio');
    view.dispatch({ selection: { anchor: 5, head: 5 } });
    App.Editor.format('bold');
    const sel = view.state.selection.main;
    check('sem selecao a marcacao fica selecionada, nao so o cursor no fim',
      view.state.doc.sliceString(sel.from, sel.to) === 'texto',
      view.state.doc.sliceString(sel.from, sel.to));

    // Com selecao, formatar tambem deixa a selecao abrangendo so o texto formatado, nao os
    // marcadores: quem digitar em seguida substitui a palavra, nao apaga os asteriscos junto.
    // A selecao armada aqui (a frase inteira) e de proposito diferente da selecao final esperada
    // (so o texto, sem as marcas): se o codigo nao somar antes.length certinho, ou nao mexer na
    // selecao, o resultado nao bate nem no texto nem na posicao
    App.Editor.setText('uma palavra');
    view.dispatch({ selection: { anchor: 0, head: 11 } });
    App.Editor.format('bold');
    const sel2 = view.state.selection.main;
    check('com selecao mais ampla que o esperado, a selecao final encolhe pro texto formatado, sem as marcas',
      view.state.doc.sliceString(sel2.from, sel2.to) === 'uma palavra' && sel2.from === 2 && sel2.to === 13,
      { from: sel2.from, to: sel2.to, texto: view.state.doc.sliceString(sel2.from, sel2.to) });

    // O botao e tocado com o teclado aberto: se o foco nao voltar pro editor, o teclado fecha.
    // Os dois caminhos do formatar (wrap e marcador de linha) retornam em pontos diferentes do
    // codigo, entao os dois precisam ser conferidos.
    view.contentDOM.blur();
    App.Editor.setText('uma linha');
    view.dispatch({ selection: { anchor: 3, head: 3 } });
    App.Editor.format('heading');
    check('o foco volta pro editor depois de formatar por marcador de linha (senao o teclado fecha)',
      view.hasFocus);

    view.contentDOM.blur();
    App.Editor.setText('uma palavra');
    view.dispatch({ selection: { anchor: 4, head: 11 } });
    App.Editor.format('bold');
    check('o foco volta pro editor depois de formatar por wrap (senao o teclado fecha)',
      view.hasFocus);

    // O cursor depois do marcador de linha. Trocar a linha inteira (o que o codigo fazia) manda o
    // cursor pro comeco dela: uma posicao dentro de um trecho substituido volta pro inicio do
    // trecho. No celular isso e tocar em lista e ver o cursor pular pra antes do marcador, longe
    // de onde se estava escrevendo.
    const cursorDepoisDe = (texto, pos, nome) => {
      App.Editor.setText(texto);
      view.dispatch({ selection: { anchor: pos, head: pos } });
      App.Editor.format(nome);
      const linha = view.state.doc.lineAt(view.state.selection.main.head);
      return {
        texto: App.Editor.getText(),
        coluna: view.state.selection.main.head - linha.from,
        linha: linha.number,
      };
    };

    let r = cursorDepoisDe('uma linha', 3, 'list');
    check('marcador novo: o cursor segue o texto, nao volta pro comeco da linha',
      r.texto === '- uma linha' && r.coluna === 5, r);

    r = cursorDepoisDe('', 0, 'list');
    check('linha vazia: o cursor fica depois do marcador, que e de onde se digita',
      r.texto === '- ' && r.coluna === 2, r);

    r = cursorDepoisDe('uma linha', 0, 'checklist');
    check('cursor no comeco da linha: passa pra depois do marcador, nao fica antes dele',
      r.texto === '- [ ] uma linha' && r.coluna === 6, r);

    r = cursorDepoisDe('- uma linha', 7, 'list');
    check('tirando o marcador o cursor volta junto com o texto',
      r.texto === 'uma linha' && r.coluna === 5, r);

    r = cursorDepoisDe('- uma linha', 1, 'list');
    check('cursor dentro do marcador que sai: fica no comeco do texto',
      r.texto === 'uma linha' && r.coluna === 0, r);

    r = cursorDepoisDe('## titulo', 5, 'quote');
    check('trocando um marcador por outro de tamanho diferente o cursor acompanha',
      r.texto === '> titulo' && r.coluna === 4, r);

    r = cursorDepoisDe('  - sub item', 6, 'checklist');
    check('com recuo o cursor tambem acompanha',
      r.texto === '  - [ ] sub item' && r.coluna === 10, r);

    // Varias linhas de uma vez: a segunda linha so cai no lugar certo se o deslocamento das
    // anteriores for somado
    App.Editor.setText('uma\ndois\ntres');
    view.dispatch({ selection: { anchor: 1, head: 10 } });
    App.Editor.format('quote');
    const selFinal = view.state.selection.main;
    const linhaFinal = view.state.doc.lineAt(selFinal.head);
    check('selecao de tres linhas: as pontas acompanham o texto que se moveu',
      App.Editor.getText() === '> uma\n> dois\n> tres' && selFinal.anchor === 3
      && linhaFinal.number === 3 && selFinal.head - linhaFinal.from === 3,
      { texto: App.Editor.getText(), anchor: selFinal.anchor, head: selFinal.head });
  }

  console.log('41b. O teclado do celular sobe a primeira letra da frase');
  {
    const { App } = await boot({ editor: true });
    const contentDOM = App.Editor._impl.view.contentDOM;
    // O CM6 poe autocapitalize="off" na area de escrita, e o Android obedece: a nota inteira saia
    // em minuscula. O editor antigo era um contenteditable comum e nao desligava nada.
    check('a area de escrita pede maiuscula no comeco de frase',
      contentDOM.getAttribute('autocapitalize') === 'sentences',
      contentDOM.getAttribute('autocapitalize'));
  }

  console.log('42. Foto desenhada na linha, no CM6');
  {
    const { App, w } = await boot({ editor: true });
    App._embedInfo.set('foto.png', { url: 'blob:x', width: 800, height: 400 });
    App.Editor.setText('antes\n![[foto.png]]\ndepois');
    const mudou = App.Editor.decorateEmbeds((linha) => App.embedForLine(linha));
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
    App.Editor.setText('antes\n![[foto.png]]\ndepois editado');
    const mudouOutraLinha = App.Editor.decorateEmbeds((linha) => App.embedForLine(linha));
    check('editar uma linha depois da foto nao acusa mudanca (mesma posicao, mesmo estilo)',
      mudouOutraLinha === false, mudouOutraLinha);
    check('a foto continua desenhada depois de editar outra linha',
      w.document.querySelectorAll('.cm-line.embed-line').length === 1);

    // Trocar a foto por outra do mesmo tamanho mantem a posicao e a contagem de decoracoes iguais:
    // so o estilo muda. Contar decoracoes nao bastaria pra pegar isso (armadilha do brief); a
    // assinatura tem que levar o estilo, nao so a posicao
    App._embedInfo.set('foto.png', { url: 'blob:novo', width: 800, height: 400 });
    const mudouTrocaDeFoto = App.Editor.decorateEmbeds((linha) => App.embedForLine(linha));
    check('trocar a foto por outra do mesmo tamanho e detectado como mudanca de verdade',
      mudouTrocaDeFoto === true, mudouTrocaDeFoto);

    // A medida real chega depois, por uma busca assincrona no Drive: o texto do editor nao muda
    // nada, so a resposta de infoDaLinha. E por isso que o campo se refaz por StateEffect, nao so
    // quando o documento muda
    // Medido: a decoracao que havia (a da troca de foto, acima) some, e isso e uma mudanca real na
    // tela (o espaco da foto fecha), entao decorateEmbeds acusa mudou=true aqui tambem, nao so
    // quando uma decoracao aparece
    App._embedInfo.delete('foto.png');
    App.Editor.setText('antes\n![[foto.png]]\ndepois');
    let semMedidaAinda = App.Editor.decorateEmbeds((linha) => App.embedForLine(linha));
    check('sem medida ainda, nenhuma linha decorada, e o sumico da decoracao anterior conta como mudanca',
      w.document.querySelectorAll('.cm-line.embed-line').length === 0 && semMedidaAinda === true,
      semMedidaAinda);

    App._embedInfo.set('foto.png', { url: 'blob:chegou-depois', width: 800, height: 400 });
    const medidaChegouDepois = App.Editor.decorateEmbeds((linha) => App.embedForLine(linha));
    check('a medida chegando depois decora sozinha, sem o texto ter mudado',
      medidaChegouDepois === true && w.document.querySelectorAll('.cm-line.embed-line').length === 1,
      medidaChegouDepois);

    App.Editor.setText('so texto');
    App.Editor.decorateEmbeds((linha) => App.embedForLine(linha));
    check('sem embed, nenhuma linha decorada',
      w.document.querySelectorAll('.cm-line.embed-line').length === 0);
  }

  console.log('42b. A tela so volta pro cursor com o editor em foco');
  {
    // O scrollCaretIntoView antigo so rolava quando a selecao do DOM estava dentro do editor, ou
    // seja, com o editor em foco. Sem essa guarda: abrir uma nota longa, tocar em Editar sem tocar
    // no texto (o cursor fica em 0), rolar pra ler, e a tela pula de volta pro topo assim que uma
    // foto termina de carregar. O mesmo vale pro resize do visualViewport, que no Android dispara
    // tambem quando a barra do navegador se esconde ao rolar.
    const { App, w } = await boot({ editor: true });
    const view = App.Editor._impl.view;
    const ROLAGEM = w.CM6.EditorView.scrollIntoView(0).type;
    const dispatchDeVerdade = view.dispatch.bind(view);
    let rolagens = 0;
    view.dispatch = (...specs) => {
      for (const spec of specs) {
        for (const efeito of [].concat(spec?.effects || [])) if (efeito.is(ROLAGEM)) rolagens++;
      }
      return dispatchDeVerdade(...specs);
    };

    App.setMode('edit');
    App._embedInfo.set('foto.png', { url: 'blob:x', width: 800, height: 400 });
    App.Editor.setText('antes\n![[foto.png]]\ndepois');
    view.contentDOM.blur();
    check('o editor esta sem foco, como quem abriu a nota e so rolou pra ler', !view.hasFocus);
    App.decorateEditorEmbeds();
    check('a foto chegou do Drive e mudou a altura da linha',
      w.document.querySelectorAll('.cm-line.embed-line').length === 1);
    check('sem foco, a foto que chegou nao joga a tela de volta pro cursor', rolagens === 0, rolagens);

    App.Editor.focus();
    check('o editor esta em foco', view.hasFocus);
    App._embedInfo.set('foto.png', { url: 'blob:outra', width: 800, height: 400 });
    App.decorateEditorEmbeds();
    check('com foco, a linha que mudou de altura continua perseguindo o cursor', rolagens === 1, rolagens);
    view.dispatch = dispatchDeVerdade;
  }

  console.log('43. Botoes de desfazer e refazer na barra');
  {
    const { App, w } = await boot({ editor: true });
    App.Editor.setText('base');
    cm6Type(App, ' mais');
    const desfazer = w.document.querySelector('.toolbar-btn[data-history="undo"]');
    const refazer = w.document.querySelector('.toolbar-btn[data-history="redo"]');
    check('os dois botoes existem na barra', !!desfazer && !!refazer);
    desfazer.dispatchEvent(new w.Event('click', { bubbles: true }));
    check('o botao desfez', App.Editor.getText() === 'base', App.Editor.getText());
    refazer.dispatchEvent(new w.Event('click', { bubbles: true }));
    check('o botao refez', App.Editor.getText() === 'base mais', App.Editor.getText());
  }

  console.log('43b. Desfazer sem nada pra desfazer nao suja a nota');
  {
    // Nota recem aberta: a pilha esta vazia. Sem olhar o retorno de undo(), o botao marcava a
    // nota como suja de qualquer jeito, e trinta segundos depois o autosave gravava no Drive com o
    // updated de hoje sem uma unica edicao ter acontecido
    const { App, w } = await boot({ editor: true });
    const view = App.Editor._impl.view;
    const NOTA = '---\ncreated: 2026-01-02\nupdated: 2026-01-03\n---\n\ntexto';
    App.setContent(NOTA);
    const desfazer = w.document.querySelector('.toolbar-btn[data-history="undo"]');
    const refazer = w.document.querySelector('.toolbar-btn[data-history="redo"]');
    check('nota recem aberta esta limpa', App.isDirty === false);
    desfazer.dispatchEvent(new w.Event('click', { bubbles: true }));
    check('desfazer sem nada pra desfazer nao suja a nota', App.isDirty === false, App.isDirty);
    refazer.dispatchEvent(new w.Event('click', { bubbles: true }));
    check('refazer sem nada pra refazer tambem nao', App.isDirty === false, App.isDirty);
    check('e o texto continua o que foi aberto', App.Editor.getText() === NOTA, App.Editor.getText());

    // E o botao continua marcando quando desfaz de verdade
    cm6Type(App, ' novo');
    App.isDirty = false;
    desfazer.dispatchEvent(new w.Event('click', { bubbles: true }));
    check('desfazer de verdade marca a nota como nao salva', App.isDirty === true);
    check('... e desfez mesmo', App.Editor.getText() === NOTA, App.Editor.getText());

    // A pilha do desfazer nao pode atravessar a troca de nota. A edicao da nota A aqui e uma
    // DELECAO (sair de uma lista de um item), que e o caso que sobrevivia ao remapeamento: desfazer
    // na nota B colava o `- [ ] ` no fim dela, marcava como alterada e o autosave gravava isso no
    // Drive trinta segundos depois. Corromper nota que a pessoa so abriu.
    const NOTA_B = 'nota B, so aberta da lista e nao tocada';
    App.setContent('- [ ] comprar pao');
    view.dispatch({ selection: { anchor: 17 } });
    apertarEnter(w, view);
    apertarEnter(w, view);
    check('na nota A, sair da lista deixou uma delecao pra tras',
      App.Editor.getText() === '- [ ] comprar pao\n', App.Editor.getText());
    App.setContent(NOTA_B);
    check('nota B aberta e limpa', App.isDirty === false && App.Editor.getText() === NOTA_B, App.Editor.getText());
    desfazer.dispatchEvent(new w.Event('click', { bubbles: true }));
    check('desfazer na nota B nao traz pedaco da nota A', App.Editor.getText() === NOTA_B, App.Editor.getText());
    check('... e a nota B continua limpa, entao o autosave nao tem o que gravar', App.isDirty === false);
  }

  console.log('44. Edicao: Enter continua a citacao, e a linha de citacao vazia encerra na hora');
  {
    const { App, w } = await boot({ editor: true });
    const view = App.Editor._impl.view;

    // Enter de verdade, como no cenario 40: o comando do app so chega ao teclado por estar em
    // Prec.highest, acima do Enter que o markdown() instala em Prec.high
    const enter = (conteudo, em) => enterEm(App, w, conteudo, em);

    check('o editor do teste e o CM6, nao o textarea', App.Editor.kind() === 'cm6');

    let r = enter('> citacao', 9);
    check('citacao com texto: o Enter continua a citacao', r.text === '> citacao\n> ' && r.at === '1:2', r);

    r = enter('> citacao\n> ', 12);
    check('citacao vazia: encerra com um Enter so, sem linha de citacao no meio',
      r.text === '> citacao\n' && r.at === '1:0', r);

    r = enter('> citacao\n>', 11);
    check('citacao vazia sem o espaco depois do sinal tambem encerra',
      r.text === '> citacao\n' && r.at === '1:0', r);

    // O caso que motivou a decisao: sair de um bloco de callout sem gastar tres Enters
    r = enter('> [!note] aviso\n> corpo\n> ', 26);
    check('bloco de callout: a linha vazia encerra na hora',
      r.text === '> [!note] aviso\n> corpo\n' && r.at === '2:0', r);

    r = enter('  > recuada\n  > ', 16);
    check('citacao recuada vazia tambem encerra', r.text === '  > recuada\n' && r.at === '1:0', r);

    // O comando so pode pegar a linha que e SO citacao vazia: sinal de maior no meio da frase e
    // texto comum, e um Enter ali e um Enter comum
    r = enter('a > b', 5);
    check('sinal de maior no meio da frase nao e citacao', r.text === 'a > b\n' && r.at === '1:0', r);

    // Dentro de bloco de codigo, `> ` e texto do codigo, nao citacao: o Enter so quebra a linha. O
    // comando decidia pelo texto da linha e apagava o conteudo dela
    r = enter('```\n> \n```', 6);
    check('linha "> " dentro de bloco de codigo: o Enter quebra a linha e o "> " fica',
      r.text === '```\n> \n\n```' && r.at === '2:0', r);
    r = enter('```\n>\n```', 5);
    check('linha ">" dentro de bloco de codigo tambem fica', r.text === '```\n>\n\n```' && r.at === '2:0', r);
    // Bloco de codigo dentro de uma citacao: a linha e codigo, a citacao em volta nao encerra nela
    r = enter('> ```\n> \n> ```', 8);
    check('"> " dentro de codigo que mora numa citacao continua sendo codigo',
      r.text.startsWith('> ```\n> \n') && r.text.endsWith('> ```') && r.text.split('\n').length === 4, r);

    // Com um trecho selecionado, o Enter e o da biblioteca: ele troca a selecao pela linha nova.
    // O comando de encerrar citacao olhava so a linha do cursor e ignorava a selecao, entao apagava
    // o `> ` e deixava o trecho selecionado na nota: o Enter da pessoa sumia no caminho.
    App.Editor.setText('> um\n> dois\n> ');
    view.dispatch({ selection: { anchor: 2, head: 14 } });
    apertarEnter(w, view);
    check('Enter com trecho selecionado substitui a selecao, em vez de so encerrar a citacao',
      !view.state.doc.toString().includes('dois'), view.state.doc.toString());

    // Regressao: o que ja funcionava continua com a biblioteca, e igual ao cenario 40
    r = enter('- item', 6);
    check('lista comum continua lista comum', r.text === '- item\n- ' && r.at === '1:2', r);
    r = enter('1. um', 5);
    check('lista numerada continua contando', r.text === '1. um\n2. ' && r.at === '1:3', r);
    r = enter('- [ ] comprar pao', 17);
    check('tarefa com texto: a linha nova nasce tarefa', r.text === '- [ ] comprar pao\n- [ ] ' && r.at === '1:6', r);
    r = enter('- [x] feito', 11);
    check('tarefa marcada continua desmarcada', r.text === '- [x] feito\n- [ ] ' && r.at === '1:6', r);
    r = enter('paragrafo', 9);
    check('paragrafo comum nao ganha marcador', r.text === 'paragrafo\n' && r.at === '1:0', r);
  }

  console.log('45. A barra rola com o dedo em cima dos botoes');
  {
    const { App, w } = await boot({ editor: true });
    const d = w.document;
    App.newFile();
    App.setMode('edit');

    // O toque como o Chrome entrega: as coordenadas do fim vem em changedTouches, porque no
    // touchend a lista touches ja esta vazia
    const toque = (el, tipo, x, y) => {
      const e = new w.Event(tipo, { cancelable: true, bubbles: true });
      const ponto = [{ clientX: x, clientY: y }];
      e.touches = tipo === 'touchend' ? [] : ponto;
      e.changedTouches = ponto;
      el.dispatchEvent(e);
      return e;
    };

    const lista = d.querySelector('.toolbar-btn[data-format="list"]');
    App.Editor.setText('uma linha');
    App.Editor._impl.view.dispatch({ selection: { anchor: 9, head: 9 } });

    const comeco = toque(lista, 'touchstart', 100, 700);
    const fim = toque(lista, 'touchend', 100, 700);
    check('o comeco do toque nao e cancelado: e ele que deixa o navegador rolar a barra',
      !comeco.defaultPrevented);
    check('o fim do toque e cancelado: e o que segura o teclado aberto', fim.defaultPrevented);
    check('dedo parado em cima do botao: a formatacao acontece',
      App.Editor.getText() === '- uma linha', App.Editor.getText());

    // Arrastar em cima do botao e rolar a barra, nao tocar nele
    App.Editor.setText('outra linha');
    toque(lista, 'touchstart', 100, 700);
    toque(lista, 'touchend', 160, 704);
    check('dedo arrastado de lado em cima do botao nao formata nada',
      App.Editor.getText() === 'outra linha', App.Editor.getText());

    // Um tremor de dedo continua sendo toque
    toque(lista, 'touchstart', 100, 700);
    toque(lista, 'touchend', 104, 703);
    check('tremida de dedo ainda e toque', App.Editor.getText() === '- outra linha', App.Editor.getText());

    // O navegador que assume a rolagem manda touchcancel e nunca chega ao touchend: o proximo
    // toque nao pode herdar a posicao do gesto abandonado
    App.Editor.setText('mais uma');
    toque(lista, 'touchstart', 100, 700);
    toque(lista, 'touchcancel', 300, 700);
    toque(lista, 'touchend', 300, 700);
    check('gesto que virou rolagem nao formata quando o dedo larga longe',
      App.Editor.getText() === 'mais uma', App.Editor.getText());

    // O mouse continua no clique, e sem roubar o foco do editor
    App.Editor.setText('no mouse');
    const abaixou = new w.Event('mousedown', { cancelable: true, bubbles: true });
    lista.dispatchEvent(abaixou);
    lista.click();
    check('no mouse o clique formata, e o mousedown e cancelado pra nao tirar o foco',
      App.Editor.getText() === '- no mouse' && abaixou.defaultPrevented, App.Editor.getText());

    // A camera e a galeria abrem o seletor de dentro do toque, e o desenho abre a tela cheia:
    // os dois passam pelo mesmo caminho, entao um toque neles tambem tem que agir
    let abriu = 0;
    App.els.photoInput.click = () => { abriu++; };
    const galeria = d.querySelector('.toolbar-btn[data-photo="gallery"]');
    toque(galeria, 'touchstart', 300, 700);
    toque(galeria, 'touchend', 300, 700);
    check('o botao da galeria abre o seletor no fim do toque', abriu === 1, abriu);
    toque(galeria, 'touchstart', 300, 700);
    toque(galeria, 'touchend', 360, 700);
    check('arrastar em cima do botao da galeria nao abre o seletor', abriu === 1, abriu);
  }

  console.log('46. Painel de diagnostico: a versao do cache e o editor em uso');
  {
    const { App, w } = await boot();
    const d = w.document;
    // O jsdom nao tem Cache Storage: a leitura falha e o painel diz que nao deu, em vez de
    // inventar um numero. Versao errada no painel e pior que versao nenhuma
    check('sem cache storage a versao sai como indisponivel', App._version === 'indisponível', App._version);

    w.caches = { keys: async () => ['drivenotes-v36', 'outra-coisa-v1'] };
    await App.readVersion();
    check('so os caches do app entram na linha', App._version === 'drivenotes-v36', App._version);

    App.showDiagnostics();
    const dbg = d.getElementById('debug-text').textContent;
    check('o painel abre dizendo a versao e o editor em uso',
      dbg.includes('versão: drivenotes-v36') && dbg.includes('editor: textarea'),
      dbg.slice(0, 60));

    w.caches = { keys: async () => [] };
    await App.readVersion();
    check('primeira abertura, sem cache ainda: o painel diz isso', App._version === 'sem cache', App._version);
  }

  console.log('47. A barra de formatacao: 18 botoes, todos desenhados');
  {
    const { w } = await boot();
    const botoes = [...w.document.querySelectorAll('.toolbar .toolbar-btn')];
    const ordem = botoes.map(b => b.dataset.history || b.dataset.format || b.dataset.photo || b.dataset.sketch
      || (b.hasAttribute('data-extract') ? 'extract' : undefined));
    // A ordem e a barra que a Agatha usa com o polegar: desfazer e refazer, os links da nota, a
    // foto e o desenho, a formatacao de texto, os blocos, e as listas no fim. O de extrair (v43) so
    // aparece com texto selecionado e gruda na ponta direita: e o ultimo da fila de proposito
    const esperada = ['undo', 'redo', 'wikilink', 'tag', 'camera', 'gallery', 'open', 'heading',
      'bold', 'italic', 'strikethrough', 'highlight', 'code', 'quote', 'link', 'list', 'ordered', 'checklist', 'extract'];
    check('a barra tem os 18 botoes na ordem combinada, e o de extrair no fim', ordem.join(',') === esperada.join(','), ordem);
    // Letra e emoji na barra saiam com a fonte de cada Android e nao herdavam a cor do botao:
    // todo botao e SVG de traco, e nenhum tem texto solto dentro
    const semDesenho = botoes.filter(b => !b.querySelector('svg') || b.textContent.trim());
    check('todo botao e um SVG, sem letra nem emoji sobrando', semDesenho.length === 0,
      semDesenho.map(b => b.title));
    const semNome = botoes.filter(b => !(b.getAttribute('aria-label') || '').trim());
    check('todo botao se anuncia pro leitor de tela', semNome.length === 0, semNome.map(b => b.title));
  }

  console.log('48. Botoes de link entre notas e de tag');
  {
    const { App } = await boot({ editor: true });
    const view = App.Editor._impl.view;
    const sel = () => { const s = view.state.selection.main; return `${s.from},${s.to}`; };

    App.Editor.setText('nome');
    view.dispatch({ selection: { anchor: 0, head: 4 } });
    App.applyFormat('wikilink');
    check('com texto selecionado o botao envolve a selecao',
      App.Editor.getText() === '[[nome]]', App.Editor.getText());

    App.Editor.setText('');
    App.applyFormat('wikilink');
    // Mudou com a lista de notas (v39): o link nasce vazio, cursor no meio, e a lista abre em cima
    // dele. Um "texto" de enfeite filtraria a lista ate nao sobrar nada. Ver o cenario 55.
    check('sem selecao entra [[]] com o cursor no meio, pra lista filtrar do zero',
      App.Editor.getText() === '[[]]' && sel() === '2,2', { texto: App.Editor.getText(), sel: sel() });

    App.Editor.setText('etiqueta');
    view.dispatch({ selection: { anchor: 0, head: 8 } });
    App.applyFormat('tag');
    check('a tag so poe o # na frente da selecao',
      App.Editor.getText() === '#etiqueta', App.Editor.getText());

    App.Editor.setText('');
    App.applyFormat('tag');
    check('sem selecao a tag deixa #texto com "texto" selecionado',
      App.Editor.getText() === '#texto' && sel() === '1,6', { texto: App.Editor.getText(), sel: sel() });
  }

  console.log('49. Lista numerada na barra');
  {
    // A numerada entra pela tabela FORMATS como qualquer outro marcador de linha: quem faz o
    // trabalho e o linePrefixChange, e e ele que segura o cursor onde a escrita estava
    const { App } = await boot({ editor: true });
    const view = App.Editor._impl.view;
    const cursor = () => view.state.selection.main.head;

    App.Editor.setText('- a');
    view.dispatch({ selection: { anchor: 3 } });
    App.applyFormat('ordered');
    check('a lista vira numerada e o cursor continua depois do "a"',
      App.Editor.getText() === '1. a' && cursor() === 4, { texto: App.Editor.getText(), cursor: cursor() });

    App.applyFormat('ordered');
    check('numerada de novo tira o marcador',
      App.Editor.getText() === 'a' && cursor() === 1, { texto: App.Editor.getText(), cursor: cursor() });

    App.Editor.setText('1. a');
    view.dispatch({ selection: { anchor: 4 } });
    App.applyFormat('list');
    check('numerada vira lista com um toque, sem virar duas linhas de marcador',
      App.Editor.getText() === '- a' && cursor() === 3, { texto: App.Editor.getText(), cursor: cursor() });
  }

  console.log('50. O leitor entende marca-texto e riscado');
  {
    const { App } = await boot();
    const ler = (texto) => { App.setContent(texto); App.setMode('preview'); return App.els.previewContainer.innerHTML; };
    check('==x== vira marca-texto', ler('==x==').includes('<mark>x</mark>'), ler('==x=='));
    check('o negrito sobrevive dentro da marca',
      ler('==**x**==').includes('<mark><strong>x</strong></mark>'), ler('==**x**=='));
    // O sanitizador nao pode comer a tag nova, e os casos que nao sao marca-texto continuam texto
    check('o DOMPurify deixa o <mark> passar', ler('==x==').includes('<mark'), ler('==x=='));
    check('==== sozinho nao abre marca nenhuma', !ler('====').includes('<mark'), ler('===='));
    check('== x == com espaco encostado fica texto', !ler('== x ==').includes('<mark'), ler('== x =='));
    check('~~x~~ continua saindo riscado pelo GFM', ler('~~x~~').includes('<del>x</del>'), ler('~~x~~'));
  }

  console.log('51. Foto e desenho nascem com o nome da nota, sem a data');
  {
    const { App, drive, w } = await boot();
    const slug = (nome) => App.slugForMedia(nome);
    check("'Voz Blue' vira voz-blue", slug('Voz Blue') === 'voz-blue', slug('Voz Blue'));
    check('acento, dois pontos e exclamacao viram hifen ou somem',
      slug('Reunião 17 set: decisões!') === 'reuniao-17-set-decisoes', slug('Reunião 17 set: decisões!'));
    check('nome de 60 letras corta em 40', slug('a'.repeat(60)) === 'a'.repeat(40), slug('a'.repeat(60)));
    // O corte cai bem em cima do hifen: ele nao pode ficar pendurado no fim do nome
    check('corte que cairia num hifen nao deixa hifen no fim',
      slug(`${'x'.repeat(39)} y`) === 'x'.repeat(39), slug(`${'x'.repeat(39)} y`));
    check("'---' nao deixa nada", slug('---') === '', slug('---'));
    check('nome vazio ou ausente tambem nao', slug('') === '' && slug(null) === '' && slug(undefined) === '');

    // Relogio parado: o nome carrega a hora, e sem isso a checagem dependeria do segundo em que rodou
    const Real = w.Date;
    const FIXO = Real.parse('2026-09-19T15:30:12');
    w.Date = function (...a) { return a.length ? new Real(...a) : new Real(FIXO); };
    w.Date.now = () => Real.now();
    w.Date.parse = Real.parse;
    w.Date.UTC = Real.UTC;

    const jpeg = new w.Blob(['x'], { type: 'image/jpeg' });
    const png = new w.Blob(['x'], { type: 'image/png' });
    drive.put('A', 'Voz Blue.md', 'texto');
    await App.openFile('A', 'Voz Blue.md');
    check('foto com a nota aberta: nome da nota, prefixo e hora',
      App.mediaName(jpeg, null, 'foto') === 'voz-blue-foto-153012.jpg', App.mediaName(jpeg, null, 'foto'));
    check('desenho igual, com o prefixo e a extensao dele',
      App.mediaName(png, null, 'desenho') === 'voz-blue-desenho-153012.png', App.mediaName(png, null, 'desenho'));

    App.currentFile = null;
    check('sem nota aberta: o formato antigo, com a data',
      App.mediaName(jpeg, null, 'foto') === 'foto-2026-09-19-153012.jpg', App.mediaName(jpeg, null, 'foto'));
    App.currentFile = { name: '---.md' };
    check('nota cujo nome nao deixa slug: tambem cai na data',
      App.mediaName(jpeg, null, 'foto') === 'foto-2026-09-19-153012.jpg', App.mediaName(jpeg, null, 'foto'));
    w.Date = Real;
  }

  console.log('52. Sem a data no nome, o Drive e quem diz se ele esta livre');
  {
    const { App, drive, w } = await boot();
    w.URL.createObjectURL = () => 'blob:fake/local';
    const Real = w.Date;
    const FIXO = Real.parse('2026-09-19T15:30:12');
    w.Date = function (...a) { return a.length ? new Real(...a) : new Real(FIXO); };
    w.Date.now = () => Real.now();
    w.Date.parse = Real.parse;
    w.Date.UTC = Real.UTC;

    drive.put('media', '_media', '', [VAULT]); drive.files.get('media').mimeType = FOLDER;
    drive.put('A', 'a.md', 'linha um');
    // A foto do mesmo minuto de OUTRO dia, que sem esta checagem seria a que o ![[...]] novo acharia
    drive.put('velha', 'a-foto-153012.jpg', 'bin', ['media']); drive.files.get('velha').mimeType = 'image/jpeg';
    await App.openFile('A', 'a.md');
    App.setMode('edit');
    const ta = App.els.editorElement;
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    const photo = (n) => new w.File([`bytes-${n}`], `IMG_${n}.JPG`, { type: 'image/jpeg' });
    const nomeDe = (n) => [...drive.files.values()].find(f => f.content === `bytes-${n}`)?.name;

    await App.insertPhoto(photo(1));
    check('nome ja ocupado no _media: a foto sobe como -2', nomeDe(1) === 'a-foto-153012-2.jpg', nomeDe(1));
    check('e o ![[...]] da nota aponta pro nome que subiu', ta.value.includes('![[a-foto-153012-2.jpg]]'), ta.value);

    w.Date = Real;
  }

  console.log('52b. Leva de fotos no mesmo segundo: -2 e -3, sem consultar o que a leva ja deu');
  {
    const { App, drive, w } = await boot();
    w.URL.createObjectURL = () => 'blob:fake/local';
    const Real = w.Date;
    const FIXO = Real.parse('2026-09-19T15:30:12');
    w.Date = function (...a) { return a.length ? new Real(...a) : new Real(FIXO); };
    w.Date.now = () => Real.now();
    w.Date.parse = Real.parse;
    w.Date.UTC = Real.UTC;

    drive.put('media', '_media', '', [VAULT]); drive.files.get('media').mimeType = FOLDER;
    drive.put('A', 'a.md', 'linha um');
    drive.put('velha', 'a-foto-153012.jpg', 'bin', ['media']); drive.files.get('velha').mimeType = 'image/jpeg';
    await App.openFile('A', 'a.md');
    App.setMode('edit');
    const ta = App.els.editorElement;
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    const photo = (n) => new w.File([`bytes-${n}`], `IMG_${n}.JPG`, { type: 'image/jpeg' });
    const nomeDe = (n) => [...drive.files.values()].find(f => f.content === `bytes-${n}`)?.name;
    const buscas = (nome) => drive.log.filter(l => l.startsWith('LIST ') && l.includes(`name = '${nome}'`)).length;

    // Com o nome base ja ocupado, -2 fica com a primeira foto e a segunda tem que ir pra -3 SEM
    // gastar uma consulta no que a leva ja distribuiu
    drive.log.length = 0;
    await App.insertPhotos([photo(1), photo(2)]);
    check('duas fotos no mesmo segundo viram -2 e -3',
      nomeDe(1) === 'a-foto-153012-2.jpg' && nomeDe(2) === 'a-foto-153012-3.jpg', [nomeDe(1), nomeDe(2)]);
    check('a segunda foto nao consulta de novo o que a leva ja deu',
      buscas('a-foto-153012.jpg') === 1 && buscas('a-foto-153012-2.jpg') === 1 && buscas('a-foto-153012-3.jpg') === 1,
      drive.log.filter(l => l.startsWith('LIST ')));
    check('as duas entraram na nota, uma por linha',
      ta.value === 'linha um\n![[a-foto-153012-2.jpg]]\n![[a-foto-153012-3.jpg]]\n', ta.value);

    // Sem rede pra conferir, a foto sobe assim mesmo: nome repetido incomoda, foto perdida e perda
    const real = App.driveFindByName;
    App.driveFindByName = async () => { throw new Error('sem rede'); };
    await App.insertPhoto(photo(3));
    check('busca falhando nao trava a foto: sobe com o nome sem conferir',
      nomeDe(3) === 'a-foto-153012.jpg', nomeDe(3));
    App.driveFindByName = real;
    w.Date = Real;
  }

  console.log('53. Tocar na foto: sai da nota e vai pra lixeira do Drive');
  {
    const { App, drive, w } = await boot({ editor: true });
    w.URL.createObjectURL = () => 'blob:fake/local';
    drive.put('media', '_media', '', [VAULT]); drive.files.get('media').mimeType = FOLDER;
    const image = (id, name) => { drive.put(id, name, 'bin', ['media']); drive.files.get(id).mimeType = 'image/jpeg'; };
    image('X', 'x.jpg'); image('Y', 'y.jpg'); image('Z', 'z.jpg');
    drive.put('A', 'a.md', 'a\n![[x.jpg]]\nb');
    drive.put('B', 'b.md', 'a\n![[y.jpg]]');
    drive.put('C', 'c.md', 'a\n![[z.jpg]]\nb');

    await App.openFile('A', 'a.md');
    App.setMode('edit');
    check('o editor deste cenario e o CM6', App.Editor.kind() === 'cm6');
    App._embedUrls.set('x.jpg', Promise.resolve('blob:fake/local'));
    App._embedInfo.set('x.jpg', { url: 'blob:fake/local', width: 800, height: 400 });

    App.confirmDialog = async () => false;
    const naoQuis = await App.removeEmbedLine(2);
    check('o dialogo respondendo nao deixa tudo como estava',
      naoQuis === false && App.getContent() === 'a\n![[x.jpg]]\nb'
      && !drive.files.get('X').trashed && App._embedInfo.has('x.jpg'), App.getContent());

    App.confirmDialog = async () => true;
    const foi = await App.removeEmbedLine(2);
    await App._saveChain;
    check('confirmando, a linha inteira sai e nao sobra quebra',
      foi === true && App.getContent() === 'a\nb', JSON.stringify(App.getContent()));
    check('o texto sem a linha chegou no Drive', bodyOf(drive.files.get('A').content) === 'a\nb', drive.files.get('A').content);
    check('o arquivo da foto foi pra lixeira', drive.files.get('X').trashed === true);
    const ordem = drive.log.filter(l => /^(PATCH A|TRASH X)/.test(l));
    check('salvou no Drive ANTES de mandar pra lixeira', ordem.join('|') === 'PATCH A|TRASH X x.jpg', ordem);
    check('a foto sai dos dois caches de decoracao',
      !App._embedUrls.has('x.jpg') && !App._embedInfo.has('x.jpg'));

    // Ultima linha da nota: o que tem que sair com ela e a quebra de CIMA
    await App.openFile('B', 'b.md');
    App.setMode('edit');
    await App.removeEmbedLine(2);
    await App._saveChain;
    check('foto na ultima linha: a nota termina em "a", sem linha em branco',
      App.getContent() === 'a', JSON.stringify(App.getContent()));
    check('e a foto dela tambem foi pra lixeira', drive.files.get('Y').trashed === true);

    // A lixeira falhando e a metade inofensiva: a nota ja esta certa e a tela diz o que faltou
    await App.openFile('C', 'c.md');
    App.setMode('edit');
    drive.failTrash = true;
    const meio = await App.removeEmbedLine(2);
    await App._saveChain;
    check('lixeira falhou: a nota continua sem a linha, e o aviso aparece',
      meio === false && App.getContent() === 'a\nb' && bodyOf(drive.files.get('C').content) === 'a\nb'
      && !drive.files.get('Z').trashed
      && App.els.saveStatus.textContent === 'A foto saiu da nota, mas não foi pra lixeira',
      App.els.saveStatus.textContent);
    drive.failTrash = false;

    check('linha que nao e foto nenhuma nao abre dialogo nem mexe no texto',
      await App.removeEmbedLine(1) === false && App.getContent() === 'a\nb', App.getContent());
    check('linha que nao existe tambem nao',
      await App.removeEmbedLine(99) === false && App.getContent() === 'a\nb');

    // O salvamento que virou rascunho em vez de chegar no Drive (aqui, um conflito): o Drive ainda
    // tem a nota COM a linha, entao mandar a foto pra lixeira agora deixaria o texto de la apontando
    // pro vazio. O aviso do proprio save ja basta, e a lixeira nao e tocada.
    image('W', 'w.jpg');
    drive.put('D', 'd.md', 'a\n![[w.jpg]]\nb');
    await App.openFile('D', 'd.md');
    App.setMode('edit');
    drive.remoteEdit('D', 'mexeram no PC');
    const semSave = await App.removeEmbedLine(2);
    await App._saveChain;
    check('save que nao chegou no Drive: a foto NAO vai pra lixeira',
      semSave === false && !drive.files.get('W').trashed
      && drive.files.get('D').content === 'mexeram no PC'
      && App.els.saveStatus.textContent === 'Conflito com o Drive',
      [semSave, drive.files.get('W').trashed, App.els.saveStatus.textContent]);
  }

  console.log('54. Indice de titulos: monta do Drive, guarda no aparelho, filtra e ordena');
  {
    const { App, drive, w } = await boot();
    seedVault(drive);
    drive.put('n-old', 'antiga.md', 'x', ['d-proj']); drive.files.get('n-old').modifiedTime = '2026-01-01T00:00:00.000Z';
    drive.put('n-fora', 'fora do vault.md', 'x', ['outra-pasta']);
    drive.put('n-obs', 'workspace.md', 'x', ['d-obs']);
    // Nota criada pelo proprio app: o Drive guarda ela como text/plain, e mesmo assim ela e do indice
    drive.put('n-plain', 'criada pelo app.md', 'x', [VAULT]); drive.files.get('n-plain').mimeType = 'text/plain';

    const notes = await App.noteIndex();
    const names = notes.map(n => n.name).sort();
    check('indice tem as notas .md do vault (inclusive as text/plain), sem .obsidian, sem fora do vault, sem png nem txt',
      JSON.stringify(names) === JSON.stringify(['Abacaxi.md', 'antiga.md', 'criada pelo app.md', 'nota do projeto.md', 'zebra.md', 'émile.md'].sort()), names);
    check('pasta em texto: raiz e vault, subpasta e o nome dela',
      notes.find(n => n.id === 'n-z').where === 'vault' && notes.find(n => n.id === 'n-sub').where === '20-projetos');
    check('duas listagens, nenhuma ida pasta a pasta',
      drive.log.filter(l => l.startsWith('LIST-TYPE')).length === 2 && drive.log.filter(l => l.startsWith('GET meta')).length === 0, drive.log);
    const stored = JSON.parse(w.localStorage.getItem('drivenotes_note_index'));
    check('guardado no aparelho com a hora', Array.isArray(stored.notes) && stored.notes.length === 6 && typeof stored.builtAt === 'number');

    // filtro: sem acento, sem maiuscula, comeca-com antes de contem, recente primeiro
    check('"ab" acha Abacaxi', App.searchNoteIndex('ab').map(n => n.name).join() === 'Abacaxi.md');
    check('"emile" acha émile', App.searchNoteIndex('emile').map(n => n.name).join() === 'émile.md');
    const nota = App.searchNoteIndex('nota').map(n => n.name);
    check('"nota" acha nota do projeto', nota.join() === 'nota do projeto.md', nota);
    drive.files.get('n-a').modifiedTime = '2026-09-01T00:00:00.000Z';
    await App.refreshNoteIndex();
    const a = App.searchNoteIndex('a').map(n => n.name);
    check('"a": comeca-com (Abacaxi, antiga) antes de contem (zebra, nota do projeto, criada pelo app), recente primeiro dentro do grupo',
      a[0] === 'Abacaxi.md' && a[1] === 'antiga.md' && a.slice(2).sort().join() === ['criada pelo app.md', 'nota do projeto.md', 'zebra.md'].sort().join(), a);
    check('nada digitado: as recentes que estao no indice', (() => {
      w.localStorage.setItem('drivenotes_recents', JSON.stringify([{ id: 'n-sub', name: 'nota do projeto.md', timestamp: 1 }, { id: 'n-fora', name: 'fora do vault.md', timestamp: 1 }]));
      return App.searchNoteIndex('').map(n => n.id).join() === 'n-sub';
    })());

    // sessao seguinte (janela nova, w2): abre da copia guardada na hora e atualiza por tras
    const storedIndex = w.localStorage.getItem('drivenotes_note_index');
    const { App: App2, drive: drive2, w: w2 } = await boot({ seedStorage: { drivenotes_note_index: storedIndex } });
    seedVault(drive2);
    // A pasta onde nota nova nasce (DEFAULT_FOLDER_ID) precisa existir no Drive falso, dentro do vault,
    // pro folderTrail dela responder quando o createOnDrive puser a nota no indice
    drive2.put(INBOX, '_inbox', '', [VAULT]); drive2.files.get(INBOX).mimeType = FOLDER;
    drive2.put('n-new', 'nova.md', 'x', [VAULT]);
    drive2.delay = 50;
    const first = await App2.noteIndex();
    check('copia guardada responde na hora, sem esperar o Drive', first.length === 6 && !first.find(n => n.id === 'n-new'));
    await sleep(300);
    check('a atualizacao por tras trouxe a nota nova', App2._noteIndex.find(n => n.id === 'n-new') && drive2.log.filter(l => l.startsWith('LIST-TYPE')).length === 2);

    // o app mantem o indice em dia com o que ele mesmo faz
    App2.noteIndexRename('n-new', 'renomeada.md');
    check('renomear muda o nome no indice', App2._noteIndex.find(n => n.id === 'n-new').name === 'renomeada.md');
    App2.noteIndexRemove('n-new');
    check('apagar tira do indice', !App2._noteIndex.find(n => n.id === 'n-new'));
    await App2.noteIndexAdd({ id: 'n-add', name: 'criada.md', parents: ['d-proj'], modifiedTime: '2026-09-22T00:00:00.000Z' });
    const added = App2._noteIndex.find(n => n.id === 'n-add');
    check('nota criada entra com a pasta em texto', added && added.where === '20-projetos', added);
    // 5 no Drive falso (4 do seedVault mais n-new), menos n-new apagada, mais n-add: 5.
    // A contagem sozinha nao provaria nada (era 5 antes do par apagar/criar): os ids provam.
    const guardado = JSON.parse(w2.localStorage.getItem('drivenotes_note_index')).notes;
    check('o guardado acompanha', guardado.length === 5 && guardado.some(n => n.id === 'n-add')
      && !guardado.some(n => n.id === 'n-new'), guardado.map(n => n.id));

    // nota nova salva no Drive entra sozinha
    App2.newFile(); App2.setContent('oi'); App2.markDirty();
    await App2.save({ manual: true });
    await sleep(100);
    check('createOnDrive poe a nota no indice', App2._noteIndex.find(n => n.id === App2.currentFile.id), App2.currentFile.name);

    // Drive fora do ar: o indice guardado continua servindo
    const { App: App3, drive: drive3 } = await boot({ seedStorage: { drivenotes_note_index: storedIndex } });
    drive3.failReads = true;
    const third = await App3.noteIndex();
    await sleep(50);
    check('sem Drive, a copia guardada serve e nada estoura', third.length === 6 && App3._noteIndex.length === 6);
  }

  console.log('55. Lista de notas ao digitar [[ (autocompletar no CodeMirror)');
  {
    const { App, drive, w } = await boot({ editor: true });
    seedVault(drive);
    drive.put('n-voz', 'voz-blue.md', 'v', ['d-proj']);
    const { completionStatus, currentCompletions, acceptCompletion } = w.CM6;
    const view = App.Editor._impl.view;
    const typeAtCaret = (text) => {
      const at = view.state.selection.main.head;
      view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: 'input.type' });
    };
    const labels = () => currentCompletions(view.state).map(c => c.label);

    drive.put('N', 'n.md', 'texto ', [VAULT]); // in the vault, so that it is in the index and shows up among the recents
    await App.openFile('N', 'n.md');
    App.setMode('edit');
    App.Editor.moveCaretToEnd();

    typeAtCaret('[[');
    await sleep(200);
    check('digitar [[ abre a lista', completionStatus(view.state) === 'active', completionStatus(view.state));
    check('a lista veio do indice (montado na primeira vez)', App._noteIndex && App._noteIndex.length > 0);
    typeAtCaret('voz');
    await sleep(200);
    check('filtra pelo que foi digitado', labels().join() === 'voz-blue', labels());
    check('o item mostra a pasta', currentCompletions(view.state)[0].detail === '20-projetos');

    acceptCompletion(view);
    check('escolher escreve o nome e fecha o link', App.getContent() === 'texto [[voz-blue]]', App.getContent());
    check('cursor depois dos ]]', view.state.selection.main.head === App.getContent().length);
    check('lista fechada depois de escolher', completionStatus(view.state) === null);

    // ]] ja presentes (o botao da barra poe): nao duplica
    App.setContent('a  b');
    view.dispatch({ selection: { anchor: 2 } });
    App.applyFormat('wikilink');
    await sleep(200);
    check('botao [[ escreve [[]] com o cursor no meio e abre a lista com as recentes',
      App.getContent() === 'a [[]] b' && view.state.selection.main.head === 4 && completionStatus(view.state) === 'active' && labels().includes('n'),
      [App.getContent(), view.state.selection.main.head, completionStatus(view.state), labels()]);
    typeAtCaret('ze');
    await sleep(200);
    check('filtra: zebra', labels().join() === 'zebra', labels());
    acceptCompletion(view);
    check('nao duplica os ]] e o cursor pula pra depois deles', App.getContent() === 'a [[zebra]] b' && view.state.selection.main.head === 11, [App.getContent(), view.state.selection.main.head]);

    // Enter com a lista fechada continua sendo o Enter do app (continua a lista)
    App.setContent('- item');
    App.Editor.moveCaretToEnd();
    apertarEnter(w, view);
    check('Enter sem lista aberta segue o Enter do app', App.getContent() === '- item\n- ', JSON.stringify(App.getContent()));

    // fora do [[ nada abre
    App.setContent('so texto');
    App.Editor.moveCaretToEnd();
    typeAtCaret(' mais');
    await sleep(200);
    check('digitar fora de [[ nao abre lista', completionStatus(view.state) === null);

    // o botao voltar do Android fecha a lista, nao a nota
    const { App: AppW, drive: driveW, w: wW } = await boot({ editor: true, watcher: true });
    seedVault(driveW);
    driveW.put('N2', 'n2.md', 'texto ', [VAULT]); // no vault: entra no indice e nas recentes, que e o que a lista vazia mostra
    await AppW.navigateTo('N2', 'n2.md');
    AppW.setMode('edit');
    AppW.Editor.moveCaretToEnd();
    const viewW = AppW.Editor._impl.view;
    viewW.dispatch({ changes: { from: viewW.state.doc.length, insert: '[[' }, selection: { anchor: viewW.state.doc.length + 2 }, userEvent: 'input.type' });
    await sleep(200);
    check('(watcher) lista aberta', wW.CM6.completionStatus(viewW.state) === 'active', wW.CM6.completionStatus(viewW.state));
    check('voltar fecha a lista e fica na nota', wW.__back() === 'handled' && wW.CM6.completionStatus(viewW.state) === null && AppW.currentFile?.id === 'N2');
    check('proximo voltar sai da nota', wW.__back() === 'handled' && (await sleep(80), AppW.currentFile == null || AppW.currentFile.id !== 'N2'));
  }

  console.log('56. Quem aponta pra esta nota: busca no Drive, conferida no texto');
  {
    const { App, drive } = await boot();
    seedVault(drive);
    drive.put('L1', 'um.md', 'vai [[zebra]] e volta', ['d-proj']);
    drive.put('L2', 'dois.md', 'foto ![[zebra]] alias [[Zebra|a bicha]] secao [[zebra#Cabeca]] com md [[zebra.md]]', [VAULT]);
    drive.put('L3', 'tres.md', 'a palavra zebra sem link, e [[zebra-maior]] que e outra nota', [VAULT]);
    drive.put('L4', 'fora.md', '[[zebra]] fora do vault', ['outra-pasta']);
    drive.put('L5', 'oculta.md', '[[zebra]] dentro do .obsidian', ['d-obs']);
    drive.put('L6', 'lixo.json', '[[zebra]]', [VAULT]); drive.files.get('L6').mimeType = 'application/json';

    const re = App.linkPattern('zebra');
    const forms = ['[[zebra]]', '![[zebra]]', '[[Zebra|a]]', '[[zebra#Cabeca]]', '[[zebra#Cabeca|a]]', '[[zebra.md]]'];
    check('a regex casa todas as formas de link', forms.every(f => { re.lastIndex = 0; return re.test(f); }));
    const not = ['[[zebra-maior]]', 'zebra', '[zebra]', '[[pasta/zebra]]'];
    check('e nao casa o que nao e link pra ela', not.every(f => { re.lastIndex = 0; return !re.test(f); }));

    const linking = await App.findLinkingNotes('zebra.md');
    check('acha as duas notas do vault com link de verdade, e so elas',
      linking.map(n => n.id).sort().join() === 'L1,L2', linking.map(n => n.id));
    check('cada uma vem com o texto e o modifiedTime de antes do download',
      linking.every(n => typeof n.content === 'string' && n.modifiedTime === drive.files.get(n.id).modifiedTime));
    // Baixadas: L1, L2, L3 (tem a palavra, sem link) e a propria zebra.md (o nome casa na busca). Fora do
    // vault (L4), dentro do .obsidian (L5) e o json (L6) nao sao baixados.
    check('so as candidatas do vault foram baixadas',
      drive.log.filter(l => l.startsWith('GET content')).length === 4, drive.log.filter(l => l.startsWith('GET content')));
    const except = await App.findLinkingNotes('zebra.md', { exceptId: 'L1' });
    check('exceptId deixa a propria nota de fora', except.map(n => n.id).join() === 'L2');
  }

  console.log('57. Apagar a nota aberta: lixeira do Drive, some das recentes e do indice, volta a tela');
  {
    const { App, drive, w, type } = await boot({ watcher: true });
    seedVault(drive);
    drive.put('L1', 'um.md', 'vai [[zebra]]', ['d-proj']);
    drive.put('L2', 'dois.md', '[[zebra]] de novo', [VAULT]);
    const d = w.document;
    await App.noteIndex();

    // nota nova, ainda sem id: o botao nem aparece
    App.newFile();
    App.els.fileName.click();
    check('nota sem id: modal sem o botao apagar', App.els.modal.classList.contains('visible') && d.getElementById('modal-delete').hidden);
    App.hideModal();

    d.getElementById('welcome-open').click(); await sleep(80);
    [...d.querySelectorAll('.browser-item')].find(li => li.textContent.includes('zebra')).click(); await sleep(80);
    // Tres passos atras dela: a tela inicial, a nota nova de cima e a pasta. E dessa pasta que o apagar tem que voltar.
    check('zebra aberta', App.currentFile?.id === 'n-z' && App.navStack.length === 3
      && App.navStack[2].view === 'browse' && App.navStack[2].id === VAULT, [App.navStack.length, App.navStack]);
    App.els.fileName.click();
    check('nota do Drive: modal com o botao apagar', !d.getElementById('modal-delete').hidden);

    // cancelar nao apaga
    d.getElementById('modal-delete').click();
    await sleep(20);
    check('modal do nome fechou e o dialogo de confirmacao abriu',
      !App.els.modal.classList.contains('visible') && d.getElementById('confirm-overlay').classList.contains('visible')
      && d.getElementById('confirm-title').textContent === 'Apagar esta nota?');
    await sleep(120);
    check('o dialogo ganhou a contagem de quem aponta pra ela',
      d.getElementById('confirm-text').textContent.includes('2 notas têm link pra esta; os links ficam.'), d.getElementById('confirm-text').textContent);
    d.getElementById('confirm-cancel').click(); await sleep(20);
    check('cancelar: nada na lixeira, nota continua aberta', !drive.files.get('n-z').trashed && App.currentFile?.id === 'n-z');

    // edicao pendente e apagar: o save enfileirado roda antes, e a lixeira depois; nada recria a nota
    App.setMode('edit'); type('mexi');
    App.els.fileName.click(); d.getElementById('modal-delete').click(); await sleep(20);
    d.getElementById('confirm-ok').click();
    await sleep(150); await App._saveChain; await sleep(50);
    const trashed = drive.files.get('n-z');
    check('foi pra lixeira', trashed.trashed === true);
    check('a fila terminou na lixeira, nao num save', drive.log.filter(l => l.startsWith('TRASH ') || l.startsWith('PATCH n-z')).pop().startsWith('TRASH'), drive.log.slice(-4));
    check('saiu das recentes', !App.getRecents().some(r => r.id === 'n-z'));
    check('saiu do indice', !App._noteIndex.some(n => n.id === 'n-z'));
    check('sem rascunho sobrando', !w.localStorage.getItem('drivenotes_draft_n-z'));
    check('voltou pra pasta', d.body.dataset.view === 'browse' && App.folder?.id === VAULT, d.body.dataset.view);
    check('os links das outras notas ficaram', drive.files.get('L1').content === 'vai [[zebra]]' && drive.files.get('L2').content === '[[zebra]] de novo');
    check('nao ha mais nota nenhuma com id n-z criada de novo', [...drive.files.values()].filter(f => f.name === 'zebra.md').length === 1);

    // o Drive recusa: a nota fica
    await App.navigateTo('n-a', 'Abacaxi.md'); await sleep(50);
    drive.failTrash = true;
    App.els.fileName.click(); d.getElementById('modal-delete').click(); await sleep(20);
    d.getElementById('confirm-ok').click();
    await sleep(100); await App._saveChain;
    check('Drive recusou: nota continua aberta, status diz', App.currentFile?.id === 'n-a' && !drive.files.get('n-a').trashed
      && App.els.saveStatus.textContent === 'Erro ao apagar', App.els.saveStatus.textContent);
    drive.failTrash = false;
  }

  console.log('58. Renomear conserta os [[links]] nas outras notas');
  {
    const { App, drive, w } = await boot();
    seedVault(drive);
    drive.put('L1', 'um.md', '---\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\nvai [[zebra]] e ![[zebra]] e [[Zebra|bicho]] e [[zebra#Cabeca]] e [[zebra.md]]', ['d-proj']);
    drive.put('L2', 'dois.md', 'a palavra zebra e [[zebra-maior]]', [VAULT]);
    drive.put('L3', 'tres.md', '[[zebra]] mas alguem mexeu', [VAULT]);
    drive.put('L4', 'quatro.md', '[[zebra]] com rascunho local', [VAULT]);
    w.localStorage.setItem('drivenotes_draft_L4', JSON.stringify({ fileId: 'L4', name: 'quatro.md', content: '[[zebra]] com rascunho local, editado', baseModifiedTime: drive.files.get('L4').modifiedTime, parents: [VAULT] }));

    check('relinkText troca todas as formas e deixa o resto',
      App.relinkText('x [[zebra]] ![[zebra]] [[Zebra|b]] [[zebra#C]] [[zebra.md]] [[zebra-maior]] zebra', 'zebra', 'girafa')
        === 'x [[girafa]] ![[girafa]] [[girafa|b]] [[girafa#C]] [[girafa]] [[zebra-maior]] zebra');
    check('nome novo com cifrao nao vira padrao de substituicao', App.relinkText('[[zebra]]', 'zebra', 'a$1b') === '[[a$1b]]');

    await App.openFile('n-z', 'zebra.md');
    // L3 muda entre a busca e a gravacao: o Drive falso adianta o modifiedTime no primeiro GET de meta dela
    const realFetch = drive.fetch;
    let bumped = false;
    w.fetch = drive.fetch = async (url, opts) => {
      if (!bumped && String(url).includes('/files/L3?') && !String(url).includes('alt=media') && (!opts || !opts.method || opts.method === 'GET')) {
        bumped = true; drive.remoteEdit('L3', '[[zebra]] mas alguem mexeu MESMO');
      }
      return realFetch(url, opts);
    };

    await App.renameFile(App.currentFile, 'girafa');
    await App._saveChain;
    await sleep(100);
    check('a nota foi renomeada', drive.files.get('n-z').name === 'girafa.md');
    check('L1: todas as formas trocadas, frontmatter intacto (updated nao mudou)',
      drive.files.get('L1').content === '---\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\nvai [[girafa]] e ![[girafa]] e [[girafa|bicho]] e [[girafa#Cabeca]] e [[girafa]]', drive.files.get('L1').content);
    check('L2: sem link de verdade, nao foi escrita', drive.files.get('L2').content === 'a palavra zebra e [[zebra-maior]]' && !drive.log.some(l => l === 'PATCH L2'));
    check('L3: mudou no meio, pulada', drive.files.get('L3').content === '[[zebra]] mas alguem mexeu MESMO' && !drive.log.some(l => l === 'PATCH L3'));
    check('L4: Drive e rascunho local trocados', drive.files.get('L4').content === '[[girafa]] com rascunho local'
      && JSON.parse(w.localStorage.getItem('drivenotes_draft_L4')).content === '[[girafa]] com rascunho local, editado');
    check('o rascunho de L4 aponta pra versao nova do Drive (sem falso conflito depois)',
      JSON.parse(w.localStorage.getItem('drivenotes_draft_L4')).baseModifiedTime === drive.files.get('L4').modifiedTime);
    check('status conta certo', App.els.saveStatus.textContent === 'Renomeado, 2 links atualizados, 1 nota pulada', App.els.saveStatus.textContent);
    check('o indice acompanhou o nome', App._noteIndex == null || App._noteIndex.find(n => n.id === 'n-z')?.name === 'girafa.md');

    // busca fora do ar: renomeia, avisa que nao procurou
    w.fetch = drive.fetch = realFetch;
    await App.openFile('n-a', 'Abacaxi.md');
    drive.put('L5', 'cinco.md', '[[Abacaxi]]', [VAULT]);
    const okFetch = drive.fetch;
    w.fetch = drive.fetch = async (url, opts) => {
      if (String(url).includes('fullText')) return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
      return okFetch(url, opts);
    };
    await App.renameFile(App.currentFile, 'Abacate');
    await App._saveChain; await sleep(50);
    check('renomeou mesmo sem conseguir procurar os links', drive.files.get('n-a').name === 'Abacate.md' && drive.files.get('L5').content === '[[Abacaxi]]');
    check('status avisa', App.els.saveStatus.textContent === 'Renomeado, não deu pra procurar os links', App.els.saveStatus.textContent);
    w.fetch = drive.fetch = okFetch;

    // sem links: so "Renomeado"
    await App.openFile('n-e', 'émile.md');
    await App.renameFile(App.currentFile, 'emilia');
    await App._saveChain; await sleep(50);
    check('sem links, status curto', App.els.saveStatus.textContent === 'Renomeado', App.els.saveStatus.textContent);
  }

  console.log('59. Extrair trecho: o editor entrega o trecho selecionado e so troca o que conferiu');
  {
    const { App, w } = await boot({ editor: true });
    const view = App.Editor._impl.view;
    const aceso = () => w.document.body.classList.contains('has-selection');

    App.Editor.setText('uma linha\n\n   \noutra');
    App.Editor.focus();
    await sleep(30);
    view.dispatch({ selection: { anchor: 2 } });
    check('cursor sem selecao: botao apagado', !aceso());
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    check('texto selecionado com o editor em foco: botao aceso', aceso());
    view.dispatch({ selection: { anchor: 10, head: 14 } });
    check('selecao so de espaco e quebra de linha: apagado', !aceso());
    check('... e o editor nao entrega trecho nenhum', App.Editor.selectedStretch() === null);
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    view.contentDOM.blur();
    await sleep(50);
    check('o editor perdeu o foco (a caixa do nome pega ele): apagado', !aceso());

    // Linhas inteiras com a quebra do fim, que e como o dedo costuma selecionar
    App.Editor.setText('antes\nTrecho um\nlinha dois\ndepois');
    view.dispatch({ selection: { anchor: 6, head: 27 } });
    const trecho = App.Editor.selectedStretch();
    check('o trecho vem sem as pontas em branco', trecho && trecho.text === 'Trecho um\nlinha dois', trecho);
    view.dispatch({ changes: { from: 0, insert: 'bem ' }, userEvent: 'input.type' });
    check('texto digitado antes do trecho: a troca acompanha e acerta o lugar',
      App.Editor.replaceStretch(trecho, '[[x]]') === true && App.Editor.getText() === 'bem antes\n[[x]]\ndepois', App.Editor.getText());
    check('o cursor fica logo depois do link', view.state.selection.main.head === 'bem antes\n[[x]]'.length, view.state.selection.main.head);
    App.Editor.undo();
    check('desfazer devolve o trecho', App.Editor.getText() === 'bem antes\nTrecho um\nlinha dois\ndepois', App.Editor.getText());

    view.dispatch({ selection: { anchor: 10, head: 30 } });
    const mexido = App.Editor.selectedStretch();
    view.dispatch({ changes: { from: 17, insert: 'mexido ' }, userEvent: 'input.type' });
    check('texto mexido dentro do trecho: a troca recusa e nao mexe em nada',
      App.Editor.replaceStretch(mexido, '[[x]]') === false
      && App.Editor.getText() === 'bem antes\nTrecho mexido um\nlinha dois\ndepois', App.Editor.getText());

    App.Editor.setText('um\nTrecho\ndois');
    view.dispatch({ selection: { anchor: 3, head: 9 } });
    const trocado = App.Editor.selectedStretch();
    App.Editor.setText('outra nota inteira');
    check('a nota trocou por baixo: a troca recusa',
      App.Editor.replaceStretch(trocado, '[[x]]') === false && App.Editor.getText() === 'outra nota inteira');

    const { App: semLib } = await boot();
    check('no textarea de reserva nao ha trecho nem troca',
      semLib.Editor.selectedStretch() === null && semLib.Editor.replaceStretch({ text: 'x' }, 'y') === false);
  }

  console.log('59b. A caixa do nome pode recusar e ficar aberta dizendo por que');
  {
    const { App, w } = await boot();
    const aviso = w.document.getElementById('modal-message');
    let recebido = null;
    App.showModal('Teste', 'Nome', (v) => { recebido = v; },
      { value: 'ocupado', validate: async (v) => (v === 'ocupado' ? 'Já existe' : '') });
    await App._modalConfirm();
    check('recusado: a caixa continua aberta, com o aviso, e nada foi confirmado',
      App.els.modal.classList.contains('visible') && !aviso.hidden && aviso.textContent === 'Já existe' && recebido === null);
    App.els.modalInput.value = 'livre';
    await App._modalConfirm();
    check('aceito: fecha e entrega o valor', !App.els.modal.classList.contains('visible') && recebido === 'livre');

    // Fechada no meio da conferencia, nao confirma depois
    let tarde = null;
    let soltar;
    App.showModal('Teste', 'Nome', (v) => { tarde = v; }, { value: 'x', validate: () => new Promise(r => { soltar = r; }) });
    check('abrir de novo apaga o aviso anterior', aviso.hidden && aviso.textContent === '');
    const pendente = App._modalConfirm();
    App.hideModal();
    soltar('');
    await pendente;
    check('cancelada durante a conferencia: nao confirma', tarde === null);

    // O renomear, que nao passa validate, continua fechando na hora
    let sincrono = null;
    App.showModal('Renomear nota', 'Nome do arquivo', (v) => { sincrono = v; }, { value: 'a.md' });
    App._modalConfirm();
    check('sem validate: fecha e confirma no mesmo instante', sincrono === 'a.md' && !App.els.modal.classList.contains('visible'));
  }

  console.log('60. Extrair trecho: o nome sugerido vem da primeira linha, livre no vault');
  {
    const { App, drive } = await boot();
    seedVault(drive);
    drive.put('n-ideia', 'ideia-de-home-bonita.md', 'x', ['d-proj']);
    check('titulo, maiuscula e acento', await App.suggestNoteName('\n\n## Ideia de Casa Açaí\ncorpo') === 'ideia-de-casa-acai');
    check('tarefa: o marcador cai', await App.suggestNoteName('- [ ] comprar pão\n- [ ] leite') === 'comprar-pao');
    check('nome que ja existe no vault ganha -2', await App.suggestNoteName('# Ideia de home bonita') === 'ideia-de-home-bonita-2');
    drive.put('n-ideia2', 'ideia-de-home-bonita-2.md', 'x', [VAULT]);
    await App.refreshNoteIndex();
    check('... e -3 quando o -2 tambem existe', await App.suggestNoteName('# Ideia de home bonita') === 'ideia-de-home-bonita-3');
    check('a comparacao ignora maiuscula, como o link do Obsidian', await App.suggestNoteName('Zebra') === 'zebra-2');
    check('linha so de simbolos cai no nome de data', /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(await App.suggestNoteName('***\ntexto')));
  }

  console.log('61. Extrair trecho: a nota nova nasce no Drive, e so entao o trecho vira link');
  {
    const { App, drive, w } = await boot({ editor: true });
    seedVault(drive);
    const d = w.document;
    const view = App.Editor._impl.view;
    const original = '---\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\nantes\n## Ideia de home\nlinha dois\ndepois';
    drive.put('O', 'origem.md', original, ['d-proj']);
    await App.openFile('O', 'origem.md');
    App.setMode('edit');
    App.Editor.focus();
    await sleep(30);
    // Linhas inteiras, com a quebra do fim, como o dedo costuma selecionar
    view.dispatch({ selection: { anchor: original.indexOf('## Ideia'), head: original.indexOf('depois') } });
    check('com o trecho selecionado o botao acende', d.body.classList.contains('has-selection'));
    // O toque pelo caminho do mouse no bindToolbarButton: prova a ligacao do botao
    d.querySelector('.toolbar-btn[data-extract]').click();
    await sleep(150);
    check('o toque abre a caixa com o nome sugerido', App.els.modal.classList.contains('visible')
      && d.querySelector('#modal-overlay h3').textContent === 'Nota nova com o trecho'
      && App.els.modalInput.value === 'ideia-de-home', App.els.modalInput.value);
    await App._modalConfirm();
    await sleep(150); await App._saveChain; await sleep(50); await App._saveChain;

    const nova = [...drive.files.values()].find(f => f.name === 'ideia-de-home.md');
    check('a nota nova foi criada na pasta da original', nova && nova.parents[0] === 'd-proj', nova);
    check('com as datas de nota nova em cima e o trecho inteiro embaixo',
      nova && /^---\ncreated: \d{4}-\d{2}-\d{2}\nupdated: \d{4}-\d{2}-\d{2}\n---\n\n## Ideia de home\nlinha dois$/.test(nova.content), nova && nova.content);
    check('no editor o trecho virou link numa linha propria, e a linha seguinte ficou inteira',
      bodyOf(App.getContent()) === 'antes\n[[ideia-de-home]]\ndepois', App.getContent());
    check('o cursor ficou logo depois do link',
      view.state.selection.main.head === App.getContent().indexOf('[[ideia-de-home]]') + '[[ideia-de-home]]'.length);
    check('a original foi salva sem esperar os 30 segundos',
      bodyOf(drive.files.get('O').content) === 'antes\n[[ideia-de-home]]\ndepois' && !App.isDirty, drive.files.get('O').content);
    const criou = drive.log.findIndex(l => l.startsWith('POST') && l.includes('ideia-de-home.md'));
    check('a criacao veio antes do salvar da original', criou >= 0 && criou < drive.log.lastIndexOf('PATCH O'), drive.log);
    check('a nota nova esta nas recentes e no indice',
      App.getRecents().some(r => r.id === nova.id) && App._noteIndex.some(n => n.id === nova.id));
    check('o cabecalho diz Nota criada', App.els.saveStatus.textContent === 'Nota criada', App.els.saveStatus.textContent);
    App.Editor.undo();
    check('desfazer devolve o trecho pra original',
      bodyOf(App.getContent()) === 'antes\n## Ideia de home\nlinha dois\ndepois', App.getContent());
  }

  console.log('62. Extrair trecho: quando algo da errado, o texto fica, nunca some');
  {
    const { App, drive, w } = await boot({ editor: true });
    seedVault(drive);
    const view = App.Editor._impl.view;
    const texto = 'um\nTrecho que sai\ndois';
    drive.put('O', 'origem.md', texto, [VAULT]);
    await App.openFile('O', 'origem.md');
    App.setMode('edit');
    App.Editor.focus();
    const selecionarTrecho = () => {
      const de = App.getContent().indexOf('Trecho');
      view.dispatch({ selection: { anchor: de, head: de + 'Trecho que sai'.length } });
    };

    // Nome repetido digitado: a caixa fica aberta, avisa, e nada e criado
    selecionarTrecho();
    await App.promptExtract();
    check('a sugestao sai da primeira linha', App.els.modalInput.value === 'trecho-que-sai', App.els.modalInput.value);
    App.els.modalInput.value = 'Zebra';
    await App._modalConfirm();
    const aviso = w.document.getElementById('modal-message');
    check('nome repetido: a caixa continua aberta e diz por que',
      App.els.modal.classList.contains('visible') && !aviso.hidden && aviso.textContent === 'Já existe uma nota com esse nome', aviso.textContent);
    check('... e nada foi criado', drive.count('POST') === 0, drive.log);
    App.hideModal();

    // O Drive recusa a criacao: a original fica como estava, sem nenhuma escrita
    drive.failWrites = true;
    selecionarTrecho();
    await App.promptExtract();
    await App._modalConfirm();
    await sleep(100); await App._saveChain;
    check('criacao recusada: o trecho continua na original', App.getContent() === texto && !App.isDirty, App.getContent());
    check('... nenhuma escrita na original', drive.count('PATCH') === 0, drive.log);
    check('... e o status diz', App.els.saveStatus.textContent === 'Erro ao criar a nota, o trecho ficou', App.els.saveStatus.textContent);
    drive.failWrites = false;

    // O trecho muda enquanto a nota nova esta a caminho: ela fica, e a original nao e tocada
    selecionarTrecho();
    await App.promptExtract();
    drive.delay = 60;
    await App._modalConfirm();
    await sleep(20);
    view.dispatch({ changes: { from: App.getContent().indexOf('que'), insert: 'mexido ' }, userEvent: 'input.type' });
    await sleep(400); await App._saveChain;
    check('trecho mexido no meio: a nota nova foi criada', [...drive.files.values()].some(f => f.name === 'trecho-que-sai.md'), drive.log);
    check('... e a original ficou com o trecho (agora mexido), sem link',
      App.getContent() === 'um\nTrecho mexido que sai\ndois', App.getContent());
    check('... e o aviso diz que o texto ficou nos dois',
      App.els.saveStatus.textContent === 'Nota criada, o trecho ficou aqui também', App.els.saveStatus.textContent);
    drive.delay = 5;

    // Sem login: nada e criado e o trecho fica
    const { App: semLogin, drive: driveSemLogin } = await boot({ editor: true, auth: false });
    semLogin.newFile();
    semLogin.setContent(texto);
    const de = texto.indexOf('Trecho');
    semLogin.Editor._impl.view.dispatch({ selection: { anchor: de, head: de + 'Trecho que sai'.length } });
    await semLogin.promptExtract();
    await semLogin._modalConfirm();
    await sleep(50);
    check('sem login: nada criado, o trecho fica, e o status pede login',
      driveSemLogin.count('POST') === 0 && semLogin.getContent() === texto
      && semLogin.els.saveStatus.textContent === 'Faça login pra extrair', [driveSemLogin.log, semLogin.els.saveStatus.textContent]);
  }

  console.log('63. Notas guardadas no aparelho: guarda, devolve, apaga, e nunca estoura');
  {
    const { App, idb } = await boot({ idb: true });
    const S = App.NoteStore;
    check('nada guardado: null', await S.get('A') === null);
    await S.put({ id: 'A', name: 'a.md', parents: ['p'], modifiedTime: 't1', content: 'texto de A' });
    const a = await S.get('A');
    check('guarda e devolve a entrada inteira', a && a.name === 'a.md' && a.parents[0] === 'p'
      && a.modifiedTime === 't1' && a.content === 'texto de A' && typeof a.openedAt === 'number', a);
    await S.put({ id: 'A', name: 'a2.md', parents: ['p'], modifiedTime: 't2', content: 'nova' });
    check('guardar de novo substitui', (await S.get('A')).content === 'nova');
    await S.remove('A');
    check('apagar tira', await S.get('A') === null);

    // O limite: passou dele, sai a aberta ha mais tempo. Pequeno aqui pra nao gravar 101 notas
    S.LIMIT = 3;
    for (const id of ['n1', 'n2', 'n3']) await S.put({ id, name: `${id}.md`, modifiedTime: 't', content: id });
    await S.put({ id: 'n1', name: 'n1.md', modifiedTime: 't', content: 'n1 de novo' }); // reaberta: agora e a mais recente
    await S.put({ id: 'n4', name: 'n4.md', modifiedTime: 't', content: 'n4' });
    check('passou do limite: sai a aberta ha mais tempo (n2), e a reaberta fica',
      await S.get('n2') === null && !!(await S.get('n1')) && !!(await S.get('n3')) && !!(await S.get('n4')));
    S.LIMIT = 100;

    // O app aberto de novo ve o que ficou no aparelho
    const { App: App2 } = await boot({ idb });
    check('outra sessao, mesmo aparelho: a entrada esta la', (await App2.NoteStore.get('n4'))?.content === 'n4');

    // Sem IndexedDB (o boot padrao dos testes, e o celular quando o banco falha): responde vazio, nao estoura
    const { App: semBanco } = await boot();
    let estourou = false;
    try {
      await semBanco.NoteStore.put({ id: 'x', name: 'x.md', modifiedTime: 't', content: 'x' });
      check('sem banco: get responde null', await semBanco.NoteStore.get('x') === null);
      await semBanco.NoteStore.remove('x');
    } catch { estourou = true; }
    check('sem banco: nada estoura', !estourou);

    // Banco que falha ao abrir (aba anonima, navegador que recusa): mesma coisa
    const { App: quebrado, w: wq } = await boot();
    wq.indexedDB = { open() { throw new Error('SecurityError'); } };
    check('banco que falha ao abrir: null, sem estourar', await quebrado.NoteStore.get('x') === null);
  }

  console.log('64. Nota ja vista abre na hora, do aparelho, e so pergunta ao Drive se mudou');
  {
    const { App, drive, w, idb } = await boot({ idb: true });
    drive.put('A', 'a.md', 'texto de A');
    drive.put('B', 'b.md', 'texto de B');
    await App.openFile('A', 'a.md');
    await App.openFile('B', 'b.md');
    await sleep(30);
    check('abrir do Drive guarda a nota no aparelho', (await App.NoteStore.get('A'))?.content === 'texto de A');

    drive.log.length = 0;
    drive.delay = 200; // um Drive lento: o que aparecer antes de 200ms nao veio dele
    const aberta = App.openFile('A', 'a.md');
    await sleep(60);
    check('A na tela, no modo leitura, antes de o Drive responder',
      App.currentFile?.id === 'A' && App.getContent() === 'texto de A' && w.document.body.dataset.view === 'preview',
      [App.currentFile?.id, App.getContent()]);
    await aberta;
    await sleep(300);
    check('uma pergunta ao Drive e nenhum download', drive.count('GET meta') === 1 && drive.count('GET content') === 0, drive.log);
    check('nada mudou: nenhum aviso', App.els.saveStatus.textContent === '', App.els.saveStatus.textContent);
    check('o log conta que veio do guardado, e que conferiu',
      App._log.some(l => /cached a\.md \d+ms/.test(l)) && App._log.some(l => /checked a\.md same \d+ms/.test(l)), App._log.slice(-4));
    drive.delay = 5;

    // O app aberto de novo (o Android matou): o aparelho ainda tem A
    const { App: App2, drive: drive2 } = await boot({ idb });
    drive2.put('A', 'a.md', 'texto de A');
    drive2.files.get('A').modifiedTime = (await App2.NoteStore.get('A')).modifiedTime;
    drive2.delay = 200;
    const reaberta = App2.openFile('A', 'a.md');
    await sleep(60);
    check('app aberto de novo: A aparece na hora, do aparelho', App2.getContent() === 'texto de A', App2.getContent());
    await reaberta;
    await sleep(300);
    check('... e a pergunta ao Drive disse que nao mudou', drive2.count('GET content') === 0, drive2.log);
  }

  console.log('65. Mudou no Drive: troca sozinha; mudou so a data: fica quieto; ela ja escreveu: nao troca');
  {
    const { App, drive, type } = await boot({ idb: true });
    drive.put('A', 'a.md', 'versao 1');
    drive.put('B', 'b.md', 'b');
    await App.openFile('A', 'a.md');
    await App.openFile('B', 'b.md');
    await sleep(30);

    // Mudou no Drive (o PC): a guardada aparece, depois troca
    drive.remoteEdit('A', 'versao do PC');
    drive.delay = 100;
    const aberta = App.openFile('A', 'a.md');
    await sleep(30);
    check('primeiro aparece a guardada', App.getContent() === 'versao 1', App.getContent());
    await aberta;
    await sleep(400);
    check('depois troca pela do Drive, na leitura tambem',
      App.getContent() === 'versao do PC' && App.els.previewContainer.textContent.includes('versao do PC'), App.getContent());
    check('sem ficar suja, com o aviso', !App.isDirty && App.els.saveStatus.textContent === 'Atualizada do Drive', App.els.saveStatus.textContent);
    check('a nota na tela passou pra versao nova (o proximo salvar nao da conflito falso)',
      App.currentFile.modifiedTime === drive.files.get('A').modifiedTime);
    drive.delay = 5;
    await sleep(30);
    check('e a entrada guardada tambem virou a nova', (await App.NoteStore.get('A'))?.content === 'versao do PC');

    // So a data mudou (um renomear, o Obsidian tocando no arquivo): baixa, ve que e igual, nao avisa
    await App.openFile('B', 'b.md');
    drive.files.get('A').modifiedTime = drive.tick();
    await App.openFile('A', 'a.md');
    await sleep(100);
    check('mesma letra com data nova: nenhum aviso, e a nota acompanha a data',
      App.els.saveStatus.textContent === '' && App.currentFile.modifiedTime === drive.files.get('A').modifiedTime,
      [App.els.saveStatus.textContent, App.currentFile.modifiedTime]);

    // Mudou no Drive e ela ja escreveu: nao troca, e o salvar acha o conflito
    await App.openFile('B', 'b.md');
    await sleep(30);
    drive.remoteEdit('A', 'de novo no PC');
    drive.delay = 100;
    const outra = App.openFile('A', 'a.md');
    await sleep(30);
    App.setMode('edit');
    type('versao do PC com o que ela escreveu');
    await outra;
    await sleep(400);
    check('nao trocou por baixo do que ela escreveu', App.getContent() === 'versao do PC com o que ela escreveu' && App.isDirty, App.getContent());
    drive.delay = 5;
    await App.save({ manual: true });
    check('o salvar acha o conflito, com o dialogo de sempre',
      App.currentFile.conflict === true && drive.files.get('A').content === 'de novo no PC', drive.files.get('A').content);
  }

  console.log('66. Nota guardada: salvar atualiza, rascunho ganha, sem rede, sem login, recarregar e apagar');
  {
    const { App, drive, w, type, idb } = await boot({ idb: true });
    drive.put('A', 'a.md', 'versao 1');
    drive.put('B', 'b.md', 'b');
    await App.openFile('A', 'a.md');
    await App.openFile('B', 'b.md');
    await sleep(30);

    // Salvar atualiza a entrada: editar A, sair, voltar nao baixa nada
    await App.openFile('A', 'a.md');
    await sleep(50);
    App.setMode('edit');
    type('versao 1 editada');
    await App.openFile('B', 'b.md');
    await App._saveChain;
    await sleep(30);
    drive.log.length = 0;
    await App.openFile('A', 'a.md');
    await sleep(80);
    check('o que ela salvou ja estava guardado: voltar nao baixa',
      App.getContent() === 'versao 1 editada' && drive.count('GET content') === 0 && App.els.saveStatus.textContent === '',
      [App.getContent(), drive.log]);

    // Rascunho ganha do guardado
    await App.openFile('B', 'b.md');
    w.localStorage.setItem('drivenotes_draft_A', JSON.stringify({ fileId: 'A', name: 'a.md', content: 'rascunho de A',
      baseModifiedTime: drive.files.get('A').modifiedTime, timestamp: Date.now() }));
    await App.openFile('A', 'a.md');
    check('com rascunho, abre o rascunho e nao o guardado', App.getContent() === 'rascunho de A' && App.isDirty, App.getContent());
    // Sai sem salvar o rascunho, pra nao mudar A no Drive falso
    App.isDirty = false;
    w.localStorage.removeItem('drivenotes_draft_A');

    // Sem rede: a guardada, com o aviso
    await App.openFile('B', 'b.md');
    await sleep(30);
    drive.failReads = true;
    await App.openFile('A', 'a.md');
    await sleep(80);
    check('sem rede: a guardada na tela, com o aviso',
      App.currentFile?.id === 'A' && App.getContent() === 'versao 1 editada' && App.els.saveStatus.textContent === 'Sem conexão: versão guardada',
      [App.getContent(), App.els.saveStatus.textContent]);
    drive.failReads = false;

    // Sem login: a guardada, com o outro aviso
    const { App: semLogin } = await boot({ idb, auth: false });
    await semLogin.openFile('A', 'a.md');
    await sleep(80);
    check('sem login: a guardada na tela, com o aviso',
      semLogin.getContent() === 'versao 1 editada' && semLogin.els.saveStatus.textContent === 'Sem login: versão guardada',
      [semLogin.getContent(), semLogin.els.saveStatus.textContent]);

    // Recarregar do Drive, no conflito, vai ao Drive e nao ao guardado
    await App.openFile('B', 'b.md');
    await App.openFile('A', 'a.md');
    await sleep(80);
    App.setMode('edit');
    type('mexi no celular');
    drive.remoteEdit('A', 'mexi no PC');
    await App.save({ manual: true });
    check('(conflito armado)', App.currentFile.conflict === true);
    drive.log.length = 0;
    await App.resolveConflict('reload');
    check('recarregar trouxe a do Drive na hora, baixando',
      App.getContent() === 'mexi no PC' && drive.count('GET content') === 1, [App.getContent(), drive.log]);

    // Apagar tira a entrada
    await App.deleteFile(App.currentFile);
    await sleep(50);
    check('apagar a nota tira ela do aparelho', await App.NoteStore.get('A') === null);
  }

  console.log('67. A propria nota reaberta com texto por salvar (link pra ela mesma): fica o que esta na tela');
  {
    // Achado na revisao do Opus: com o caminho rapido, tocar em [[a#Secao]] dentro de `a` logo depois de
    // escrever punha a versao guardada, mais velha, no lugar do texto dela, e a edicao seguinte abria um
    // conflito falso. A nota na tela ja e a versao mais nova que existe: reabrir so rola ate o titulo.
    const { App, drive, type } = await boot({ idb: true });
    drive.put('A', 'a.md', 'versao 1\n\n## Secao');
    await App.openFile('A', 'a.md');
    await sleep(50);
    App.setMode('edit');
    type('versao 1 com o que ela escreveu\n\n## Secao');
    App.setMode('preview');
    const naTela = App.currentFile;
    drive.log.length = 0;
    await App.openFile('A', 'a.md', { heading: 'Secao' });
    check('o texto dela continua na tela, por salvar',
      App.getContent() === 'versao 1 com o que ela escreveu\n\n## Secao' && App.isDirty, App.getContent());
    check('... na mesma nota, sem ir ao Drive', App.currentFile === naTela && drive.log.length === 0, drive.log);
    await App.save({ manual: true });
    check('e o salvar sobe o texto dela, sem conflito falso',
      !App.currentFile.conflict && drive.files.get('A').content === 'versao 1 com o que ela escreveu\n\n## Secao',
      drive.files.get('A').content);
  }

  console.log('68. Versao nova: a home recarrega sozinha, fora dela o aviso, e texto por salvar nunca recarrega');
  {
    // Stand-in for navigator.serviceWorker: takeOver() is a new version taking this page over. The real
    // service worker, end to end, is `npm run test:sw`; here it is the decision the page makes.
    const watch = async (App, w, { controller = true } = {}) => {
      const container = new w.EventTarget();
      container.controller = controller ? {} : null;
      const registration = { updates: 0, update() { this.updates++; return Promise.resolve(); } };
      container.register = async () => registration;
      App.watchVersions(container);
      await sleep(0);
      const takeOver = async () => {
        container.controller = {};
        container.dispatchEvent(new w.Event('controllerchange'));
        await sleep(20);
      };
      return { registration, takeOver };
    };
    // Counts reloads, and tap() waits for the tap on the bar to finish instead of sleeping a fixed time:
    // under load the save behind the tap outlasted a 50ms sleep, and the check read it half done
    const counting = (App) => {
      const counter = { reloads: 0, tapped: null };
      App.reloadPage = () => counter.reloads++;
      const apply = App.applyUpdate.bind(App);
      App.applyUpdate = () => (counter.tapped = apply());
      counter.tap = async () => {
        App.els.updateBar.click();
        await counter.tapped;
      };
      return counter;
    };
    const until = async (cond, limit = 3000) => {
      const end = Date.now() + limit;
      while (!cond() && Date.now() < end) await sleep(10);
    };
    const barShown = (App) => !App.els.updateBar.classList.contains('hidden');
    const TOKEN = { drivenotes_token: 'fake', drivenotes_token_expires: String(Date.now() + 3600e3) };

    {
      const { App, w } = await boot();
      const counter = counting(App);
      const sw = await watch(App, w, { controller: false });
      await sw.takeOver();
      check('primeira instalacao de todas: nao e versao nova, nada acontece', counter.reloads === 0 && !barShown(App), counter.reloads);
      await sw.takeOver();
      check('... mas um deploy depois dela, com a mesma pagina aberta, e', counter.reloads === 1, counter.reloads);
    }

    {
      const { App, w } = await boot();
      const counter = counting(App);
      const sw = await watch(App, w);
      w.document.dispatchEvent(new w.Event('visibilitychange'));
      check('voltar do fundo pergunta se ha versao nova', sw.registration.updates === 1, sw.registration.updates);
      await sw.takeOver();
      check('na home: recarrega sozinha, sem aviso', counter.reloads === 1 && !barShown(App), counter.reloads);
      await sw.takeOver();
      check('... uma vez so, mesmo com outra troca em seguida', counter.reloads === 1, counter.reloads);
    }

    {
      const { App, w } = await boot();
      const counter = counting(App);
      const sw = await watch(App, w);
      App.showDiagnostics();
      await sw.takeOver();
      check('home com uma janela aberta: aviso, sem recarregar', counter.reloads === 0 && barShown(App), counter.reloads);
    }

    {
      const { App, w, drive } = await boot({ watcher: true });
      drive.put('A', 'a.md', 'versao 1');
      const counter = counting(App);
      const sw = await watch(App, w);
      await App.navigateTo('A', 'a.md');
      await sw.takeOver();
      check('nota aberta, mesmo sem nada por salvar: aviso, sem recarregar', counter.reloads === 0 && barShown(App), counter.reloads);
      w.__back();
      await until(() => counter.reloads > 0);
      check('aviso deixado pra depois: de volta na home, recarrega', counter.reloads === 1, counter.reloads);
    }

    // The heart of it: text not on the Drive yet. The reopening marker is kept for the next block.
    let marker = null;
    {
      const { App, w, drive, type } = await boot({ watcher: true });
      drive.put('A', 'a.md', 'versao 1');
      const counter = counting(App);
      const sw = await watch(App, w);
      await App.navigateTo('A', 'a.md');
      App.setMode('edit');
      type('versao 1 com o que ela escreveu');
      await sw.takeOver();
      check('nota com texto por salvar: aviso, sem recarregar',
        counter.reloads === 0 && barShown(App) && App.isDirty && App.getContent() === 'versao 1 com o que ela escreveu', counter.reloads);

      drive.failWrites = true;
      await counter.tap();
      const draft = JSON.parse(w.localStorage.getItem('drivenotes_draft_A') || 'null');
      check('tocar no aviso com o salvar falhando: nao recarrega, o aviso fica',
        counter.reloads === 0 && barShown(App) && App.isDirty, [counter.reloads, App.els.saveStatus.textContent]);
      check('... e o texto fica no aparelho, com o motivo na tela',
        draft?.content === 'versao 1 com o que ela escreveu' && App.els.saveStatus.textContent === 'Erro: salvo local',
        [draft, App.els.saveStatus.textContent]);

      drive.failWrites = false;
      await counter.tap();
      check('tocar de novo, com o Drive de volta: salva e so entao recarrega',
        counter.reloads === 1 && !App.isDirty && bodyOf(drive.files.get('A').content) === 'versao 1 com o que ela escreveu',
        [counter.reloads, App._reloading, App.els.saveStatus.textContent, drive.files.get('A').content, App._log.slice(-4)]);
      marker = w.sessionStorage.getItem('drivenotes_reopen');
      const kept = JSON.parse(marker || 'null');
      check('... guardando a nota, o modo e o caminho do voltar',
        kept?.view?.id === 'A' && kept.mode === 'edit' && kept.navStack.length === 1 && kept.navStack[0].view === 'welcome', kept);
    }

    {
      const drive = makeDrive();
      drive.put('A', 'a.md', 'versao 1 com o que ela escreveu');
      const { App, w } = await boot({ watcher: true, drive, seedStorage: TOKEN, seedSession: { drivenotes_reopen: marker } });
      await until(() => App.currentFile?.id === 'A');
      check('depois de recarregar: a mesma nota, no modo de edicao',
        App.currentFile?.id === 'A' && App.mode === 'edit' && App.getContent() === 'versao 1 com o que ela escreveu',
        [App.currentFile?.id, App.mode, App.getContent()]);
      check('... uma vez so: a marca sai do sessionStorage', w.sessionStorage.getItem('drivenotes_reopen') === null);
      const back = w.__back();
      await until(() => w.document.body.dataset.view === 'welcome');
      check('... e o voltar leva pra home, como antes de recarregar',
        back === 'handled' && App.currentFile === null && w.document.body.dataset.view === 'welcome', [back, w.document.body.dataset.view]);
    }

    {
      // History mode keeps its own entries across a reload; the folder comes back with its search
      const drive = makeDrive();
      drive.put('B', 'dentro.md', 'b', ['F']);
      const folder = { view: 'browse', id: 'F', name: 'pasta', path: ['vault'], query: 'dentro' };
      const { App, w } = await boot({ drive, seedStorage: TOKEN,
        seedSession: { drivenotes_reopen: JSON.stringify({ view: folder, mode: 'edit', navStack: [], fwdStack: [] }) } });
      await until(() => App.folder?.id === 'F');
      check('pasta aberta: volta pra mesma pasta, com a busca',
        App.folder?.id === 'F' && w.document.body.dataset.view === 'browse' && App.els.browserSearch.value === 'dentro',
        [App.folder, w.document.body.dataset.view]);
    }
  }

  // jsdom has no layout. Stand-in for the reading view: every block is 100px tall, stacked from the top of
  // the container, which sits at 50px on screen. Installed before the app runs (boot's beforeApp), so it
  // also holds for what init opens by itself. The real layout is test:browser 18 and 19.
  const layout = (w) => {
    const c = w.document.getElementById('preview-container');
    let scroll = 0;
    Object.defineProperty(c, 'scrollTop', { configurable: true, get: () => scroll, set: (v) => { scroll = Math.max(0, v); } });
    c.getBoundingClientRect = () => ({ top: 50, bottom: 850, height: 800 });
    const real = w.Element.prototype.getBoundingClientRect;
    w.Element.prototype.getBoundingClientRect = function () {
      const i = this.parentElement === c ? [...c.children].indexOf(this) : -1;
      if (i < 0) return real.call(this);
      return { top: 50 + i * 100 - scroll, bottom: 150 + i * 100 - scroll, height: 100 };
    };
    w.__scroll = (px) => { scroll = px; };
    // The block at the top of the screen, and how far into it
    w.__at = () => ({ block: Math.floor(scroll / 100), into: scroll % 100 });
  };

  console.log('69. Retomar a nota onde parou: a leitura reabre no bloco em que ficou');
  {
    // 31 blocks: the title, then paragraph i at block i + 1
    const LONG = '# Titulo\n\n' + Array.from({ length: 30 }, (_, i) => `paragrafo ${i}`).join('\n\n');
    const places = (w) => JSON.parse(w.localStorage.getItem('drivenotes_places') || '[]');
    const TOKEN = { drivenotes_token: 'fake', drivenotes_token_expires: String(Date.now() + 3600e3) };
    const until = async (cond, limit = 3000) => {
      const end = Date.now() + limit;
      while (!cond() && Date.now() < end) await sleep(10);
    };

    {
      const { App, w, drive } = await boot({ beforeApp: layout });
      drive.put('A', 'a.md', LONG);
      drive.put('B', 'b.md', 'b curta');
      await App.openFile('A', 'a.md');
      check('(sem nada guardado, abre no topo, como sempre)', w.__at().block === 0 && w.__at().into === 0, w.__at());
      w.__scroll(1250);
      await App.openFile('B', 'b.md');
      check('sair da nota guarda o bloco do topo da tela e quanto dele ja passou',
        JSON.stringify(places(w)) === JSON.stringify([{ id: 'A', block: 12, into: 50 }]), places(w));
      await App.openFile('A', 'a.md');
      check('voltar pra ela: o mesmo bloco, no mesmo ponto', w.__at().block === 12 && w.__at().into === 50, w.__at());
      check('... e nada guardado pra B, deixada no topo', !places(w).some(p => p.id === 'B'), places(w));
      check('... e o painel de diagnostico conta', App._log.some(l => l.includes('resume block 12')), App._log.slice(-4));

      await App.openFile('B', 'b.md');
      let intoView = null;
      w.HTMLElement.prototype.scrollIntoView = function () { intoView = this.textContent; };
      await App.openFile('A', 'a.md', { heading: 'Titulo' });
      check('link com #Secao: vai pro titulo, e nao pro lugar guardado', intoView === 'Titulo' && w.__at().block === 0, [intoView, w.__at()]);

      w.__scroll(2000);
      App.togglePreview();
      check('tocar em Editar guarda onde a leitura estava', places(w)[0]?.id === 'A' && places(w)[0].block === 20, places(w));
      App.goHome();
      await App.openFile('A', 'a.md');
      check('... e sair pela edicao nao apaga: reabre no bloco 20', w.__at().block === 20, w.__at());

      // A note with a draft opens straight into the editor, with A still drawn in the reading view behind it
      w.__scroll(500);
      drive.put('C', 'c.md', 'c do Drive');
      w.localStorage.setItem('drivenotes_draft_C', JSON.stringify({ fileId: 'C', name: 'c.md', content: 'rascunho de C',
        baseModifiedTime: drive.files.get('C').modifiedTime, timestamp: Date.now() }));
      await App.openFile('C', 'c.md');
      check('(C abriu no rascunho, na edicao)', App.currentFile?.id === 'C' && App.mode === 'edit', [App.currentFile?.id, App.mode]);
      check('nota com rascunho nao herda o lugar da nota de tras, que fica com o dela',
        !places(w).some(p => p.id === 'C') && places(w).find(p => p.id === 'A')?.block === 5, places(w));
      // Leaves without saving the draft, so C stays as it is on the fake Drive
      App.isDirty = false;
      w.localStorage.removeItem('drivenotes_draft_C');
    }

    {
      const old = Array.from({ length: 25 }, (_, i) => ({ id: `X${i}`, block: 3, into: 0 }));
      const { App, w, drive } = await boot({ beforeApp: layout,
        seedStorage: { drivenotes_places: JSON.stringify([{ id: 'A', block: 100, into: 30 }, ...old]) } });
      drive.put('A', 'a.md', LONG);
      drive.put('B', 'b.md', 'b');
      await App.openFile('A', 'a.md');
      check('nota que encolheu desde que foi deixada (mudou no PC): cai no ultimo bloco', w.__at().block === 30 && w.__at().into === 30, w.__at());
      await App.openFile('B', 'b.md');
      check('a lista fica nas ultimas 20 notas, a mais recente primeiro', places(w).length === 20 && places(w)[0].id === 'A', places(w).length);
    }

    {
      const { App, w, drive, idb } = await boot({ beforeApp: layout, idb: true });
      drive.put('A', 'a.md', LONG);
      await App.openFile('A', 'a.md');
      w.__scroll(900);
      w.dispatchEvent(new w.Event('pagehide'));
      check('a pagina indo embora guarda o lugar', places(w)[0]?.block === 9, places(w));
      w.__scroll(730);
      Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      w.document.dispatchEvent(new w.Event('visibilitychange'));
      check('o app indo pro fundo com a nota aberta tambem', places(w)[0]?.block === 7 && places(w)[0].into === 30, places(w));
      await sleep(30);

      // The Android kills it in the background; opened again, with what the device kept
      const { App: App2, w: w2 } = await boot({ beforeApp: layout, idb, drive,
        seedStorage: { drivenotes_places: w.localStorage.getItem('drivenotes_places') } });
      await App2.openFile('A', 'a.md');
      check('app morto e aberto de novo: a nota guardada no aparelho reabre no mesmo ponto',
        w2.__at().block === 7 && w2.__at().into === 30, w2.__at());
      check('(veio do aparelho, sem esperar o Drive)', App2._log.some(l => /cached a\.md/.test(l)), App2._log.slice(-4));
    }

    {
      const drive = makeDrive();
      drive.put('A', 'a.md', LONG);
      const { App, w } = await boot({ beforeApp: layout, drive, watcher: true });
      await App.navigateTo('A', 'a.md');
      w.__scroll(1840);
      App.reloadPage = () => {};
      await App.applyUpdate();
      const marker = w.sessionStorage.getItem('drivenotes_reopen');
      check('tocar na faixa de versao nova guarda o lugar junto', !!marker && places(w)[0]?.block === 18, [marker, places(w)]);

      const { App: App2, w: w2 } = await boot({ beforeApp: layout, drive, watcher: true,
        seedStorage: { ...TOKEN, drivenotes_places: w.localStorage.getItem('drivenotes_places') },
        seedSession: { drivenotes_reopen: marker } });
      await until(() => App2.currentFile?.id === 'A');
      check('depois de recarregar pela faixa: a mesma nota, no mesmo ponto da leitura',
        App2.mode === 'preview' && w2.__at().block === 18 && w2.__at().into === 40, [App2.mode, w2.__at()]);
    }
  }

  console.log('70. Ler e Editar no mesmo trecho: o que esta no topo de um fica no topo do outro');
  {
    // Lines:  1-4 properties, 6 title, 8-9 paragraph, 11 comment, 13-15 list, 17-19 code, 21 iframe, 23 last
    const NOTE = '---\ncreated: 2026-09-01\nupdated: 2026-09-01\n---\n\n# Titulo\n\nprimeiro paragrafo\ncontinua aqui\n\n'
      + '<!-- comentario -->\n\n- um\n- dois\n- tres\n\n```\ncodigo\n```\n\n<iframe src="https://example.com"></iframe>\n\nultimo';
    const { App, w, drive } = await boot({ beforeApp: layout });
    drive.put('A', 'a.md', NOTE);
    await App.openFile('A', 'a.md');
    const blocks = App.noteBlocks(App.getContent());
    check('cada bloco da leitura sabe de que linhas veio; comentario e iframe nao desenham nada e ficam de fora',
      JSON.stringify(blocks) === JSON.stringify([{ from: 1, to: 4 }, { from: 6, to: 6 }, { from: 8, to: 9 }, { from: 13, to: 15 }, { from: 17, to: 19 }, { from: 23, to: 23 }]),
      blocks);
    check('... um por bloco que a leitura desenhou', App.els.previewContainer.children.length === blocks.length, App.els.previewContainer.children.length);

    // The editor is a stand-in here: what is checked is the line the app hands it and reads from it
    const shown = [];
    App.Editor.showLine = (at) => shown.push(at);
    w.__scroll(350);
    App.togglePreview();
    check('Editar com o meio da lista no topo: o editor abre na linha do meio da lista',
      App.mode === 'edit' && Math.floor(shown[0]) === 14, shown);

    App.Editor.topLine = () => 17.5;
    App.togglePreview();
    check('Ler com o bloco de codigo no topo do editor: a leitura abre nele',
      App.mode === 'preview' && Math.round(App.els.previewContainer.scrollTop) === 401, App.els.previewContainer.scrollTop);
    App.togglePreview();
    check('... e ir e voltar nao escorrega: o editor volta na mesma linha', Math.abs(shown.at(-1) - 17.5) < 0.01, shown);

    App.Editor.topLine = () => 20;
    App.togglePreview();
    check('linha em branco entre dois blocos: a leitura abre no bloco seguinte', Math.round(App.els.previewContainer.scrollTop) === 484,
      App.els.previewContainer.scrollTop);

    App.togglePreview();
    App.Editor.topLine = () => 1;
    App.togglePreview();
    check('no topo do editor, a leitura fica no topo', App.mode === 'preview' && App.els.previewContainer.scrollTop === 0,
      [App.mode, App.els.previewContainer.scrollTop]);
  }

  {
    // The reopening after a new version, in edit mode: the fallback textarea's own showLine this time,
    // spied through its scroll (jsdom gives it no height, so one is lent here)
    const withTextareaHeight = (w) => {
      layout(w);
      w.__taScroll = [];
      Object.defineProperty(w.HTMLTextAreaElement.prototype, 'scrollHeight', { configurable: true, get: () => 1000 });
      Object.defineProperty(w.HTMLTextAreaElement.prototype, 'scrollTop', { configurable: true, get: () => 0, set: (v) => w.__taScroll.push(v) });
    };
    const LONG = '# Titulo\n\n' + Array.from({ length: 30 }, (_, i) => `paragrafo ${i}`).join('\n\n');
    const drive = makeDrive();
    drive.put('A', 'a.md', LONG);
    const until = async (cond, limit = 3000) => {
      const end = Date.now() + limit;
      while (!cond() && Date.now() < end) await sleep(10);
    };
    const { App, w } = await boot({ beforeApp: withTextareaHeight, drive, watcher: true,
      seedStorage: { drivenotes_token: 'fake', drivenotes_token_expires: String(Date.now() + 3600e3),
        drivenotes_places: JSON.stringify([{ id: 'A', block: 12, into: 0 }]) },
      seedSession: { drivenotes_reopen: JSON.stringify({ view: { view: 'file', id: 'A', name: 'a.md' }, mode: 'edit', navStack: [], fwdStack: [] }) } });
    // The screen, not App.mode: the mode starts out as 'edit' before any note is open
    await until(() => App.currentFile?.id === 'A' && w.document.body.dataset.view === 'edit');
    // Block 12 is "paragrafo 11", line 25 of 61, and the top is read 16px into it (VIEW_INSET, 16 of its
    // 100px): line 25.16, and the textarea scrolls to (25.16 - 1) / 61 of its height
    const expected = Math.round((24.16 / 61) * 1000);
    const scrolled = w.__taScroll.map(Math.round);
    check('recarregado pela faixa em modo edicao: o editor abre no trecho em que a leitura estava',
      App.mode === 'edit' && scrolled.some(v => Math.abs(v - expected) <= 2), [scrolled, expected]);
  }

  console.log('71. Entradas: o que chega vira um item de lista no formato das notas de captura');
  {
    const { App } = await boot();
    const e = (a) => App.arrivalEntry(a);
    check('link do Chrome: titulo e endereco', e({ title: 'Uma página', text: 'https://ex.com/a', url: '' }) === '- [Uma página](https://ex.com/a)',
      e({ title: 'Uma página', text: 'https://ex.com/a', url: '' }));
    check('link sem titulo', e({ text: 'https://youtu.be/abc' }) === '- https://youtu.be/abc');
    check('titulo igual ao endereco nao vira titulo', e({ title: 'https://youtu.be/abc', text: 'https://youtu.be/abc' }) === '- https://youtu.be/abc');
    check('link so no title (o Android as vezes manda assim)', e({ title: 'https://ex.com/b', text: '' }) === '- https://ex.com/b');
    check('campo url preenchido (fora do Android)', e({ title: 'T', text: '', url: 'https://ex.com/c' }) === '- [T](https://ex.com/c)');
    check('colchete no titulo e escapado', e({ title: 'a [b] c', text: 'https://ex.com' }) === '- [a \\[b\\] c](https://ex.com)', e({ title: 'a [b] c', text: 'https://ex.com' }));
    check('texto com endereco no meio: vai como veio', e({ text: 'olha isso https://ex.com/d legal' }) === '- olha isso https://ex.com/d legal');
    check('texto de varias linhas: as seguintes recuadas no mesmo item', e({ text: 'um\ndois\n\ntres' }) === '- um\n  dois\n\n  tres',
      JSON.stringify(e({ text: 'um\ndois\n\ntres' })));
    check('texto e url em campos separados: o endereco vai no fim', e({ text: 'veja', url: 'https://ex.com/e' }) === '- veja https://ex.com/e');
    check('so foto: nenhum item de texto', e({ title: '', text: '', url: '' }) === '');

    const a = (content, entry) => App.appendEntry(content, entry);
    check('nota que termina em lista: sem linha em branco', a('- um\n- dois\n', '- tres') === '- um\n- dois\n- tres\n', JSON.stringify(a('- um\n- dois\n', '- tres')));
    check('nota que termina em paragrafo: linha em branco antes', a('texto\n', '- item') === 'texto\n\n- item\n');
    check('nota so com propriedades: linha em branco depois do ---', a('---\ncreated: x\n---\n\n', '- item') === '---\ncreated: x\n---\n\n- item\n');
    check('nota vazia: so o item', a('', '- item') === '- item\n');
    check('so foto: a linha em branco, pras fotos abrirem paragrafo proprio', a('- um\n', '') === '- um\n\n');
    check('linhas vazias sobrando no fim nao acumulam', a('- um\n\n\n', '- dois') === '- um\n- dois\n');

    const s = (x) => App.arrivalSummary(x);
    check('resumo: titulo e link', s({ title: 'T', text: 'https://ex.com' }) === 'T · https://ex.com', s({ title: 'T', text: 'https://ex.com' }));
    check('resumo: uma foto', s({ photos: [{}] }) === '1 foto');
    check('resumo: texto e duas fotos', s({ text: 'oi', photos: [{}, {}] }) === 'oi + 2 fotos');
  }

  console.log('72. Abrir pelo atalho do icone: le o parametro, tira da URL e age');
  {
    const TOKEN = { drivenotes_token: 'fake', drivenotes_token_expires: String(Date.now() + 3600e3) };
    const until = async (cond, limit = 3000) => {
      const end = Date.now() + limit;
      while (!(await cond()) && Date.now() < end) await sleep(10);
    };
    {
      const { App, w } = await boot({ url: 'http://localhost:8000/index.html?atalho=nova', seedStorage: TOKEN });
      await until(() => w.document.body.dataset.view === 'edit');
      check('atalho nova: nota nova no editor', w.document.body.dataset.view === 'edit' && !!App.currentFile && !App.currentFile.id,
        [w.document.body.dataset.view, App.currentFile]);
      check('... e a URL ficou sem o parametro', w.location.search === '' && w.location.pathname === '/index.html', w.location.href);
    }
    {
      const drive = makeDrive();
      drive.put('R', 'recente.md', 'texto');
      const { App, w } = await boot({ url: 'http://localhost:8000/index.html?atalho=buscar', drive, seedStorage: TOKEN,
        seedSession: { drivenotes_reopen: JSON.stringify({ view: { view: 'file', id: 'R', name: 'recente.md' }, mode: 'preview', navStack: [], fwdStack: [] }) } });
      await until(() => w.document.body.dataset.view === 'browse');
      await sleep(50);
      check('atalho buscar: a tela de pastas, com o foco no campo de busca',
        w.document.body.dataset.view === 'browse' && w.document.activeElement === App.els.browserSearch,
        [w.document.body.dataset.view, w.document.activeElement?.id]);
      check('... a nota da recarga nao reabriu por cima, e a marca dela saiu da sessao',
        App.currentFile === null && w.sessionStorage.getItem('drivenotes_reopen') === null,
        [App.currentFile, w.sessionStorage.getItem('drivenotes_reopen')]);
    }
    {
      const { w } = await boot({ url: 'http://localhost:8000/index.html?atalho=buscar', auth: false });
      await until(() => w.document.getElementById('confirm-overlay').classList.contains('visible'));
      check('atalho buscar sem login: pede o toque antes, sem tentar o login sozinho',
        w.document.getElementById('confirm-overlay').classList.contains('visible') && w.document.body.dataset.view === 'welcome');
      const ok = w.document.getElementById('confirm-ok');
      check('... e o Entrar e o botao de sempre, nao o vermelho de apagar',
        ok.textContent === 'Entrar' && !ok.classList.contains('btn-danger') && ok.classList.contains('active'), ok.className);
      // The same dialog asked right after for a delete is red again
      w.__App.confirmDialog('Apagar nota?', 'x', 'Apagar');
      check('... e o proximo confirm de apagar volta a ser vermelho', ok.classList.contains('btn-danger') && !ok.classList.contains('active'), ok.className);
    }
    {
      const { w } = await boot({ url: 'http://localhost:8000/index.html?chegada=nao-existe', idb: true, seedStorage: TOKEN });
      await sleep(100);
      check('chegada que nao esta na caixa: fica na home, sem erro, URL limpa', w.document.body.dataset.view === 'welcome' && w.location.search === '');
    }
    {
      const idb = new (require('fake-indexeddb').IDBFactory)();
      await seedArrival(idb, { id: 'x1', at: 5, title: '', text: 'b', url: '', photos: [] });
      await seedArrival(idb, { id: 'x0', at: 1, title: '', text: 'a', url: '', photos: [] });
      const { App } = await boot({ idb });
      const oldest = await App.ArrivalBox.oldest();
      await App.ArrivalBox.remove('x0');
      const after = await App.ArrivalBox.oldest();
      check('a caixa: a mais antiga primeiro, e o apagar tira so ela', oldest?.id === 'x0' && after?.id === 'x1', [oldest?.id, after?.id]);
    }
  }

  console.log('73. Guardar em…: o que chegou entra no fim da nota escolhida, sobe na hora e sai da caixa');
  {
    const TOKEN = { drivenotes_token: 'fake', drivenotes_token_expires: String(Date.now() + 3600e3) };
    const { IDBFactory } = require('fake-indexeddb');
    const until = async (cond, limit = 4000) => {
      const end = Date.now() + limit;
      while (!(await cond()) && Date.now() < end) await sleep(10);
    };
    const rows = (w) => [...w.document.querySelectorAll('#arrival-ul li')];
    const inbox = () => {
      const drive = makeDrive();
      drive.put('media', '_media', '', [VAULT]); drive.files.get('media').mimeType = FOLDER;
      drive.put('I1', 'ideias-vault.md', '---\ncreated: 2026-09-20\nupdated: 2026-09-20\n---\n\n## Ideias\n\n- uma\n- duas\n', [INBOX]);
      drive.put('I2', 'CLAUDE.md', 'regras', [INBOX]);
      drive.put('I3', 'config-notebook.md', 'texto solto', [INBOX]);
      drive.put('F', 'subpasta', '', [INBOX]); drive.files.get('F').mimeType = FOLDER;
      return drive;
    };

    // Um link, pra uma nota de captura que termina em lista
    {
      const drive = inbox();
      const idb = new IDBFactory();
      await seedArrival(idb, { id: 'a1', at: 1, title: 'Um vídeo', text: 'https://youtu.be/abc', url: '', photos: [] });
      const { App, w } = await boot({ url: 'http://localhost:8000/index.html?chegada=a1', drive, idb, editor: true, watcher: true, seedStorage: TOKEN });
      await until(() => rows(w).length > 0);
      check('a tela abre, com o que chegou no topo', App.els.arrivalOverlay.classList.contains('visible')
        && App.els.arrivalTitle.textContent === 'Guardar em…' && App.els.arrivalWhat.textContent === 'Um vídeo · https://youtu.be/abc',
        App.els.arrivalWhat.textContent);
      check('a lista: nota nova primeiro, depois o _inbox do mais recente pro mais antigo, sem CLAUDE.md nem pasta',
        JSON.stringify(rows(w).map((li) => li.textContent.trim())) === JSON.stringify(['+ Nota nova', 'config-notebook', 'ideias-vault']),
        rows(w).map((li) => li.textContent.trim()));
      rows(w)[2].click();
      await until(() => drive.log.includes('PATCH I1'));
      check('o item entrou no fim da nota, no formato da lista, e subiu na hora',
        bodyOf(drive.files.get('I1').content) === '## Ideias\n\n- uma\n- duas\n- [Um vídeo](https://youtu.be/abc)\n',
        JSON.stringify(bodyOf(drive.files.get('I1').content)));
      const view = App.Editor._impl.view;
      check('a nota ficou no editor, com o cursor na linha vazia embaixo do item',
        w.document.body.dataset.view === 'edit' && view.state.selection.main.head === view.state.doc.length
        && App.getContent().endsWith(')\n'), [w.document.body.dataset.view, view.state.selection.main.head, view.state.doc.length]);
      await until(async () => (await App.ArrivalBox.get('a1')) === null);
      check('... e saiu da caixa de chegada', (await App.ArrivalBox.get('a1')) === null);
      check('a tela fechou', !App.els.arrivalOverlay.classList.contains('visible'));
    }

    // Voltar com a lista na tela: descarta, sem gravar nada
    {
      const drive = inbox();
      const idb = new IDBFactory();
      await seedArrival(idb, { id: 'a2', at: 1, title: '', text: 'descartar', url: '', photos: [] });
      const { App, w } = await boot({ url: 'http://localhost:8000/index.html?chegada=a2', drive, idb, editor: true, watcher: true, seedStorage: TOKEN });
      await until(() => rows(w).length > 0);
      const writes = () => drive.log.filter((l) => /^(PATCH|POST)/.test(l)).length;
      const before = writes();
      w.__back();
      await until(async () => (await App.ArrivalBox.get('a2')) === null);
      check('voltar com a lista na tela: fecha, descarta e nao grava nada',
        !App.els.arrivalOverlay.classList.contains('visible') && (await App.ArrivalBox.get('a2')) === null && writes() === before
        && w.document.body.dataset.view === 'welcome');
    }

    // Nota nova, com texto de duas linhas
    {
      const drive = inbox();
      const idb = new IDBFactory();
      await seedArrival(idb, { id: 'a3', at: 1, title: '', text: 'uma ideia\nem duas linhas', url: '', photos: [] });
      const { App, w } = await boot({ url: 'http://localhost:8000/index.html?chegada=a3', drive, idb, editor: true, watcher: true, seedStorage: TOKEN });
      await until(() => rows(w).length > 0);
      rows(w)[0].click();
      await until(() => drive.log.some((l) => l.startsWith('POST')));
      const born = [...drive.files.values()].find((f) => f.parents?.includes(INBOX) && /^\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(f.name));
      check('nota nova: nasce no _inbox, com nome de data e hora e o item dentro',
        !!born && bodyOf(born.content) === '- uma ideia\n  em duas linhas\n', born && JSON.stringify(bodyOf(born.content)));
      await until(async () => (await App.ArrivalBox.get('a3')) === null);
      check('... e saiu da caixa', (await App.ArrivalBox.get('a3')) === null);
      check('... com uma escrita so, a da criacao, e nada por salvar', drive.count('POST') === 1 && drive.count('PATCH') === 0 && !App.isDirty,
        [drive.log.filter((l) => /^(POST|PATCH)/.test(l)), App.isDirty]);
    }

    // Nota nova com o Drive recusando a criacao: o item so sai da caixa depois de estar num rascunho do aparelho
    {
      const drive = inbox();
      const idb = new IDBFactory();
      await seedArrival(idb, { id: 'a7', at: 1, title: '', text: 'nao pode sumir', url: '', photos: [] });
      const { App, w } = await boot({ url: 'http://localhost:8000/index.html?chegada=a7', drive, idb, editor: true, watcher: true, seedStorage: TOKEN });
      await until(() => rows(w).length > 0);
      drive.failWrites = true;
      rows(w)[0].click();
      await until(async () => (await App.ArrivalBox.get('a7')) === null);
      const draft = App.listDrafts()[0];
      check('nota nova com o Drive falhando: o item fica num rascunho do aparelho, e so entao sai da caixa',
        (await App.ArrivalBox.get('a7')) === null && !!draft && bodyOf(draft.content) === '- nao pode sumir\n' && App.isDirty,
        [draft, App.isDirty]);
    }

    // So uma foto, pra uma nota que termina em paragrafo
    {
      const drive = inbox();
      const idb = new IDBFactory();
      const bytes = new TextEncoder().encode('bytes-da-foto').buffer;
      await seedArrival(idb, { id: 'a4', at: 1, title: '', text: '', url: '', photos: [{ name: 'IMG_1.jpg', type: 'image/jpeg', bytes }] });
      const { App, w } = await boot({ url: 'http://localhost:8000/index.html?chegada=a4', drive, idb, editor: true, watcher: true, seedStorage: TOKEN });
      w.URL.createObjectURL = () => 'blob:fake/local';
      await until(() => rows(w).length > 0);
      check('o topo diz que chegou uma foto', App.els.arrivalWhat.textContent === '1 foto', App.els.arrivalWhat.textContent);
      rows(w)[1].click(); // config-notebook
      await until(() => drive.log.includes('PATCH I3'));
      const up = [...drive.files.values()].find((f) => f.parents?.includes('media') && /-foto-\d{6}\.jpg$/.test(f.name));
      check('a foto subiu pro _media, inteira', !!up && up.content === 'bytes-da-foto', up);
      check('... e entrou no fim da nota, depois de uma linha em branco', !!up && drive.files.get('I3').content.endsWith(`texto solto\n\n![[${up.name}]]\n`),
        JSON.stringify(drive.files.get('I3').content));
      await until(async () => (await App.ArrivalBox.get('a4')) === null);
      check('... e saiu da caixa', (await App.ArrivalBox.get('a4')) === null);
    }

    // Login vencido: botao Entrar antes da lista; voltar nao descarta
    {
      const drive = inbox();
      const idb = new IDBFactory();
      await seedArrival(idb, { id: 'a5', at: 1, title: '', text: 'guardar', url: '', photos: [] });
      const { App, w } = await boot({ url: 'http://localhost:8000/index.html?chegada=a5', drive, idb, editor: true, watcher: true, auth: false });
      await until(() => !App.els.arrivalLogin.hidden);
      check('login vencido: o botao Entrar, a mensagem, e nenhuma lista',
        !App.els.arrivalLogin.hidden && App.els.arrivalMessage.textContent === 'O login do Google venceu.' && rows(w).length === 0
        && !drive.log.some((l) => l.startsWith('LIST')));
      w.__back();
      await sleep(50);
      check('... voltar fecha, mas o que chegou fica na caixa', !App.els.arrivalOverlay.classList.contains('visible') && (await App.ArrivalBox.get('a5'))?.id === 'a5');

      // Abrir o app de novo (mesmo aparelho, mesma caixa), sem parametro: a tela volta
      const again = await boot({ drive, idb, editor: true, watcher: true, auth: false });
      await until(() => again.App.els.arrivalOverlay.classList.contains('visible'));
      check('abertura normal com algo na caixa: a tela Guardar em… volta', again.App.els.arrivalOverlay.classList.contains('visible')
        && again.App.els.arrivalWhat.textContent === 'guardar');
    }

    // A lista nao abre (Drive falhando): mensagem, e o que chegou fica
    {
      const drive = inbox();
      drive.failReads = true;
      const idb = new IDBFactory();
      await seedArrival(idb, { id: 'a6', at: 1, title: '', text: 'fica', url: '', photos: [] });
      const { App, w } = await boot({ url: 'http://localhost:8000/index.html?chegada=a6', drive, idb, editor: true, watcher: true, seedStorage: TOKEN });
      await until(() => !App.els.arrivalMessage.hidden);
      check('lista que nao abre: diz que da pra usar nota nova ou deixar guardado',
        App.els.arrivalMessage.textContent === 'Não deu pra abrir a lista do _inbox. Dá pra guardar numa nota nova agora, ou cancelar: fica guardado e volta aqui na próxima abertura.',
        App.els.arrivalMessage.textContent);
      check('... e oferece so a nota nova', JSON.stringify(rows(w).map((li) => li.textContent.trim())) === '["+ Nota nova"]'
        && rows(w)[0].classList.contains('arrival-new'), rows(w).map((li) => li.textContent.trim()));
      w.__back();
      await sleep(50);
      check('... e voltar nao descarta', (await App.ArrivalBox.get('a6'))?.id === 'a6');
    }

    // Atalho Anotar em…: a mesma lista, sem nada chegando; a nota abre no fim, sem mudar nada
    {
      const drive = inbox();
      const { App, w } = await boot({ url: 'http://localhost:8000/index.html?atalho=anotar', drive, idb: true, editor: true, watcher: true, seedStorage: TOKEN });
      await until(() => rows(w).length > 0);
      check('atalho anotar: titulo Anotar em…, sem o bloco do topo',
        App.els.arrivalTitle.textContent === 'Anotar em…' && App.els.arrivalWhat.hidden);
      rows(w)[2].click(); // ideias-vault
      await until(() => w.document.body.dataset.view === 'edit' && App.currentFile?.id === 'I1');
      await sleep(50);
      const view = App.Editor._impl.view;
      check('... a nota abre no editor, com o cursor no fim, sem gravar nada',
        view.state.selection.main.head === view.state.doc.length && !App.isDirty && !drive.log.includes('PATCH I1'));
    }
  }

  console.log('74. Manifest: compartilhar e atalhos dentro do endereco do app, icones PNG do tamanho declarado');
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const base = 'https://agathagio.github.io/drive-notes/manifest.json';
    const inside = (u) => new URL(u, base).pathname.startsWith('/drive-notes/');
    const st = manifest.share_target || {};
    check('share_target: POST multipart pro ./share-target, com texto, link e fotos',
      st.action === './share-target' && st.method === 'POST' && st.enctype === 'multipart/form-data'
      && st.params?.title === 'title' && st.params?.text === 'text' && st.params?.url === 'url'
      && st.params?.files?.[0]?.name === 'photos' && (st.params.files[0].accept || []).includes('image/*'), st);
    const shortcuts = manifest.shortcuts || [];
    check('tres atalhos, na ordem: anotar, nova, buscar',
      JSON.stringify(shortcuts.map((s) => new URL(s.url, base).searchParams.get('atalho'))) === JSON.stringify(['anotar', 'nova', 'buscar']),
      shortcuts.map((s) => s.url));
    check('... todos dentro do endereco do app, e o compartilhar tambem', shortcuts.length === 3 && shortcuts.every((s) => inside(s.url)) && inside(st.action || 'x:'));
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const s of shortcuts) {
      check(`${s.short_name}: tem icone de 96 e de 192`, ['96x96', '192x192'].every((z) => (s.icons || []).some((i) => i.sizes === z)));
      for (const icon of s.icons || []) {
        const file = path.join(ROOT, icon.src);
        const png = fs.existsSync(file) ? fs.readFileSync(file) : null;
        const isPng = !!png && png.subarray(0, 8).equals(PNG);
        const size = isPng ? `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` : null;
        check(`${s.short_name}: ${icon.src} e PNG ${icon.sizes}`, isPng && icon.type === 'image/png' && size === icon.sizes, size);
      }
    }
  }

  console.log('75. Compartilhar sem rede: a tela oferece nota nova, as fotos esperam, e abrir sem rede nao cai na tela');
  {
    const TOKEN = { drivenotes_token: 'fake', drivenotes_token_expires: String(Date.now() + 3600e3), drivenotes_media_folder: 'media' };
    const { IDBFactory } = require('fake-indexeddb');
    const until = async (cond, limit = 4000) => {
      const end = Date.now() + limit;
      while (!(await cond()) && Date.now() < end) await sleep(10);
    };
    const rows = (w) => [...w.document.querySelectorAll('#arrival-ul li')];
    const visible = (App) => App.els.arrivalOverlay.classList.contains('visible');
    const logged = (App, text) => App._log.some((l) => l.includes(text));
    // Offline the way the phone is: navigator.onLine false and every request failing before it leaves.
    // Each boot is a window of its own, so nothing has to be put back afterwards.
    const offline = (w) => {
      Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => false });
      w.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    };
    const inbox = () => {
      const drive = makeDrive();
      drive.put('media', '_media', '', [VAULT]); drive.files.get('media').mimeType = FOLDER;
      drive.put('I1', 'ideias-vault.md', 'texto', [INBOX]);
      return drive;
    };
    const drive = inbox();
    const bytes = new TextEncoder().encode('bytes-da-foto').buffer;
    const photo = { name: 'IMG_1.jpg', type: 'image/jpeg', bytes };
    const got = ['title:text(0)', 'text:text(8)', 'url:text(0)', 'photos:file(image/jpeg,13,named)'];

    // Na hora de compartilhar: a mensagem e a nota nova; cancelar deixa na caixa
    const idb = new IDBFactory();
    await seedArrival(idb, { id: 'o1', at: 1, title: '', text: 'sem rede', url: '', photos: [photo], got });
    {
      const { App, w } = await boot({ url: 'http://localhost:8000/index.html?chegada=o1', drive, idb, watcher: true, seedStorage: TOKEN, beforeApp: offline });
      await until(() => rows(w).length > 0);
      check('sem rede: a tela abre, com a mensagem e so a linha da nota nova',
        visible(App) && App.els.arrivalMessage.textContent === 'Sem rede. Dá pra guardar numa nota nova agora, ou cancelar: fica guardado e volta aqui quando você abrir o app com rede.'
        && JSON.stringify(rows(w).map((li) => li.textContent.trim())) === '["+ Nota nova"]' && rows(w)[0].classList.contains('arrival-new'),
        [App.els.arrivalMessage.textContent, rows(w).map((li) => li.textContent.trim())]);
      check('o log diz o que o Chrome mandou, sem conteudo',
        logged(App, `arrival photos=1 got=[${got.join(', ')}]`) && !App._log.some((l) => l.includes('sem rede')), App._log);
      w.__back();
      await sleep(50);
      check('... voltar fecha, e o que chegou fica na caixa, inteiro',
        !visible(App) && (await App.ArrivalBox.get('o1'))?.text === 'sem rede' && (await App.ArrivalBox.get('o1'))?.photos.length === 1);
    }
    // Abrir de novo sem rede: nao cai na tela; com rede, cai
    {
      const { App } = await boot({ drive, idb, watcher: true, seedStorage: TOKEN, beforeApp: offline });
      await sleep(200);
      check('abertura sem rede com algo na caixa: fica na home, sem a tela', !visible(App) && (await App.ArrivalBox.get('o1'))?.id === 'o1');
    }
    {
      const { App } = await boot({ drive, idb, watcher: true, seedStorage: TOKEN });
      await until(() => visible(App));
      check('... e a abertura com rede traz a tela de volta', visible(App) && App.els.arrivalWhat.textContent === 'sem rede + 1 foto',
        App.els.arrivalWhat.textContent);
    }

    // Nota nova sem rede: o texto vai pra nota (rascunho do aparelho), as fotos ficam na caixa, nenhum envio tentado
    {
      const idb = new IDBFactory();
      await seedArrival(idb, { id: 'o2', at: 1, title: '', text: 'sem rede', url: '', photos: [photo], got });
      const drive = inbox();
      const { App, w } = await boot({ url: 'http://localhost:8000/index.html?chegada=o2', drive, idb, watcher: true, seedStorage: TOKEN, beforeApp: offline });
      await until(() => rows(w).length > 0);
      rows(w)[0].click();
      await until(async () => (await App.ArrivalBox.get('o2'))?.text === '');
      const kept = await App.ArrivalBox.get('o2');
      const draft = App.listDrafts()[0];
      check('nota nova sem rede: o texto entra na nota nova e fica num rascunho do aparelho',
        w.document.body.dataset.view === 'edit' && bodyOf(App.getContent()) === '- sem rede\n' && !!draft && bodyOf(draft.content) === '- sem rede\n',
        [w.document.body.dataset.view, App.getContent(), draft]);
      check('... a foto fica na caixa, sem o texto', !!kept && kept.photos.length === 1 && kept.title === '' && kept.url === ''
        && new TextDecoder().decode(kept.photos[0].bytes) === 'bytes-da-foto', kept);
      check('... nenhum envio tentado, e a pasta _media lembrada continua', drive.log.length === 0 && w.localStorage.getItem('drivenotes_media_folder') === 'media',
        [drive.log, w.localStorage.getItem('drivenotes_media_folder')]);
      check('... o aviso diz que a foto espera a rede', App.els.saveStatus.textContent === 'Sem rede: a foto fica guardada e volta quando você abrir o app com rede',
        App.els.saveStatus.textContent);
      check('... e o log diz pra onde foi e o que ficou', logged(App, 'arrival -> new photos=1') && logged(App, 'arrival done sent=0/1 offline, photos kept'), App._log);
    }

    // Registro de versao anterior, sem `got`, e chegada que nao esta mais na caixa: o log nao quebra
    {
      const idb = new IDBFactory();
      await seedArrival(idb, { id: 'o3', at: 1, title: '', text: 'antigo', url: '', photos: [] });
      const { App } = await boot({ url: 'http://localhost:8000/index.html?chegada=o3', drive, idb, watcher: true, seedStorage: TOKEN });
      await until(() => visible(App));
      check('registro sem got: a tela abre e o log diz que nao se sabe', visible(App) && logged(App, 'arrival photos=0 got=?'), App._log);
      const gone = await boot({ url: 'http://localhost:8000/index.html?chegada=sumiu', drive, idb, seedStorage: TOKEN });
      await until(() => logged(gone.App, 'arrival not in box'));
      check('chegada que nao esta na caixa: o log diz', logged(gone.App, 'arrival not in box'), gone.App._log);
    }

    // So foto, sem rede: nota nova nasceria vazia, entao a tela so avisa e cancelar guarda
    {
      const idb = new IDBFactory();
      await seedArrival(idb, { id: 'o4', at: 1, title: '', text: '', url: '', photos: [photo], got: ['photos:file(image/jpeg,13,named)'] });
      const { App, w } = await boot({ url: 'http://localhost:8000/index.html?chegada=o4', drive, idb, watcher: true, seedStorage: TOKEN, beforeApp: offline });
      await until(() => !App.els.arrivalMessage.hidden);
      check('so foto sem rede: a tela avisa que a foto espera, sem linha de nota nova',
        visible(App) && rows(w).length === 0
        && App.els.arrivalMessage.textContent === 'Sem rede. A foto fica guardada e volta aqui quando você abrir o app com rede.',
        [App.els.arrivalMessage.textContent, rows(w).length]);
      w.__back();
      await sleep(50);
      check('... e voltar deixa a foto na caixa', !visible(App) && (await App.ArrivalBox.get('o4'))?.photos.length === 1);
    }
  }

  done();
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
