// Runs the real app.js inside jsdom against an in-memory fake Drive: saving, conflicts, drafts,
// reading view, navigation, rename, login, formatting and the file browser.
//   npm test
// The editor here is the fallback textarea (TinyMDE needs a real browser: see browser.test.js).
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { ROOT, LIBS, sleep, cdnVersions, installedVersions, reporter } = require('./helpers');

const { check, done } = reporter();

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
        return { ok: true, status: 200, text: async () => f.content };
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
      const parts = opts.body.split(`--${boundary}`);
      const meta = JSON.parse(parts[1].split('\r\n\r\n')[1]);
      const content = parts[2].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
      const id = 'new' + drive.nextId++;
      drive.files.set(id, { id, name: meta.name, content, parents: meta.parents, modifiedTime: drive.tick() });
      drive.log.push(`POST ${id} ${meta.name}`);
      const f = drive.files.get(id);
      return json({ id, name: f.name, parents: f.parents, modifiedTime: f.modifiedTime });
    }
    return json({}, 400);
  };
  return drive;
}

async function boot({ auth = true, seedStorage = {}, watcher = false } = {}) {
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
  w.fetch = drive.fetch;
  w.confirm = () => true;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.console = { log() {}, warn() {}, error() {} };
  for (const [k, v] of Object.entries(seedStorage)) w.localStorage.setItem(k, v);
  w.eval(fs.readFileSync(LIBS.marked, 'utf8'));
  w.eval(fs.readFileSync(LIBS.purify, 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8') + ';window.__App = App;');
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
    check('criado uma vez no Drive', drive.count('POST') === 1 && [...drive.files.values()][0].content === 'ideia', drive.log);
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
    check('conteudo final e o mais novo', all[0].content === 't1 t2', all[0].content);
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
    check('salvar o rascunho faz PATCH, nao um segundo POST', a.drive.count('POST') === 1 && a.drive.files.get('new1').content === 'texto', a.drive.log);
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
    check('embed de imagem vira rotulo', c.querySelector('.wikilink-file')?.textContent === 'foto.png');
    check('HTML dentro de wikilink nao vira elemento', !c.querySelector('img'), c.innerHTML.slice(-200));
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

  const FOLDER = 'application/vnd.google-apps.folder';
  // The browser starts at whatever folder the app is configured with
  const VAULT = /VAULT_FOLDER_ID: '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'))[1];
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
    check('voltar com edicao pendente salva antes', drive.files.get('L').content === 'editado' && d.body.dataset.view === 'welcome');

    for (let i = 0; i < 5; i++) d.querySelector('#welcome h2').click();
    const dbg = d.getElementById('debug-text').textContent;
    check('5 toques no titulo: painel de diagnostico com o modo e o log', d.getElementById('debug-overlay').classList.contains('visible') && dbg.includes('modo de voltar: CloseWatcher') && dbg.includes('watcher: close'));
    w.__back(); await sleep(20);
    check('voltar fecha o painel', !d.getElementById('debug-overlay').classList.contains('visible'));
  }

  done();
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
