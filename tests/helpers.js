// Shared by the test scripts: paths, the pinned libraries, and a headless browser driven over the DevTools protocol.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const MODULES = path.join(ROOT, 'node_modules');

// Same files index.html loads from the CDNs, from the versions pinned in package.json
const LIBS = {
  // O app nao carrega mais o TinyMDE. Quem ainda precisa desta entrada e o controle historico do
  // cenario 1 da suite de navegador, que roda o app de um commit anterior a troca de editor.
  //
  // Por isso o `tiny-markdown-editor` fica nas devDependencies DE PROPOSITO, mesmo depois da
  // troca de editor: nao e sobra. Sem a biblioteca, o app antigo cai no textarea de reserva e o
  // controle deixa de provar que o bug do ditado existia, que e a unica razao de ele rodar.
  tinymde: path.join(MODULES, 'tiny-markdown-editor', 'dist', 'tiny-mde.js'),
  // O pacote único gerado por esbuild, o mesmo arquivo que o index.html carrega
  cm6: path.join(ROOT, 'vendor', 'codemirror.js'),
  marked: path.join(MODULES, 'marked', 'marked.min.js'),
  purify: path.join(MODULES, 'dompurify', 'dist', 'purify.min.js'),
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function tmpDir() {
  fs.mkdirSync(TMP, { recursive: true });
  return TMP;
}

/**
 * Versions the app loads in production, read from the script tags in index.html.
 *
 * So o marked e o dompurify: o editor nao e mais uma CDN com versao no caminho, e sim o
 * vendor/codemirror.js versionado no repositorio, que nao tem numero nenhum pra comparar.
 */
function cdnVersions() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const find = (name) => new RegExp(`${name}@([0-9.]+)/`).exec(html)?.[1];
  return { marked: find('marked'), dompurify: find('dompurify') };
}

function installedVersions() {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(MODULES, name, 'package.json'), 'utf8')).version;
  return { marked: read('marked'), dompurify: read('dompurify') };
}

/** Chromium-based browser to drive. Set BROWSER_PATH to pick one. */
function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error('No Chromium-based browser found. Set BROWSER_PATH to msedge.exe or chrome.exe.');
  return found;
}

/**
 * The app's own scripts, in the order index.html loads them: `app.js` today, `app/*.js` once the app
 * is split. Never vendor/codemirror.js, which is a library. `html` is the index.html to read, the one
 * in the working tree by default; a historical control passes the one of its commit.
 */
function appScripts(html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')) {
  return [...html.matchAll(/<script src="(app\.js|app\/[^"]+)"><\/script>/g)].map(m => m[1]);
}

/** The app as one script: the files of appScripts() joined in order, which is what the browser runs */
function appSource() {
  return appScripts().map(src => fs.readFileSync(path.join(ROOT, src), 'utf8')).join('\n');
}

/**
 * A page with the real index.html and the given app source, the libraries served from node_modules,
 * and no Google script or service worker. Returns its file:// URL.
 *
 * The app's own script tags (one app.js, or the run of app/*.js) become one tag with `source`. `html`
 * is the index.html to build from: the working tree's by default. A historical control, which runs
 * the app of an old commit, passes that commit's index.html too; without it the app.js tag would not
 * be found, and the page would run the current app without anyone noticing.
 *
 * O CodeMirror 6 nao precisa de troca nenhuma: o index.html carrega `vendor/codemirror.js` por
 * caminho relativo, e o <base> acima resolve isso dentro do proprio repositorio. O TinyMDE entra
 * por pedido, `{ tinymde: true }`, e quem pede e o controle historico do ditado (cenario 1 da suite
 * de navegador): ele roda o app de um commit anterior a troca de editor, que e TinyMDE puro e sem a
 * biblioteca cai no textarea de reserva. O index.html daquele commit carrega a lib do unpkg, e essa
 * tag vira a copia local do node_modules (ou sai, se ninguem pediu). Um index.html sem essa tag,
 * como o da arvore de hoje, recebe a copia local no fim do head quando ela e pedida.
 */
function buildPage(name, source, { tinymde = false, html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8') } = {}) {
  const dir = tmpDir();
  const url = (file) => pathToFileURL(file).href;
  fs.writeFileSync(path.join(dir, `${name}-app.js`), source);
  const APP_TAGS = /(?:[ \t]*<script src="(?:app\.js|app\/[^"]+)"><\/script>\r?\n)+/;
  if (!APP_TAGS.test(html)) throw new Error('buildPage: no app script tag in the index.html given');
  const page = html
    .replace('<head>', `<head><base href="${url(ROOT)}/">`)
    // The TinyMDE, only for the control that runs the app of before the editor swap: that commit's
    // index.html (2d8b20b) loads it from unpkg, so the tag becomes the local copy when asked for and
    // goes otherwise; an index.html without the tag gets the local copy injected at the end of head
    .replace(/<script src="https:\/\/unpkg\.com\/tiny-markdown-editor[^>]*><\/script>/, tinymde ? `<script src="${url(LIBS.tinymde)}"></script>` : '')
    .replace('</head>', tinymde && !/unpkg\.com\/tiny-markdown-editor/.test(html) ? `<script src="${url(LIBS.tinymde)}"></script></head>` : '</head>')
    .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/marked[^>]*><\/script>/, `<script src="${url(LIBS.marked)}"></script>`)
    .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/dompurify[^>]*><\/script>/, `<script src="${url(LIBS.purify)}"></script>`)
    .replace(/<script[^>]*src="https:\/\/(apis\.google|accounts\.google)[^>]*><\/script>/g, '')
    .replace(APP_TAGS, `  <script src="${url(path.join(dir, `${name}-app.js`))}"></script><script>window.__App = App;</script>\n`)
    .replace(/<script>\s*if \('serviceWorker'[\s\S]*?<\/script>/, '');
  const file = path.join(dir, `${name}.html`);
  fs.writeFileSync(file, page);
  return url(file);
}

/** Launch the browser headless and connect to its first page. Call close() when done. */
async function launch(port) {
  const profile = path.join(tmpDir(), `profile-${port}`);
  const proc = spawn(findBrowser(), ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`,
    '--allow-file-access-from-files', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

  let targets;
  for (let i = 0; i < 60 && !targets; i++) {
    await sleep(250);
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { /* not up yet */ }
  }
  if (!targets) { proc.kill(); throw new Error('Browser did not open its debugging port'); }

  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  });

  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expression, userGesture = true) => {
    const r = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture })).result;
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const open = async (url) => { await send('Page.navigate', { url }); await sleep(1200); };

  /**
   * Espera a pagina responder verdadeiro a `expressao`, em vez de dormir um tempo fixo.
   * Devolve true se chegou, false se estourou o limite (quem chama decide o que fazer).
   *
   * Por que existe: toque e tecla injetados por `Input.dispatch*` entram por uma fila do
   * navegador que NAO e a mesma do `Runtime.evaluate`. Quando o renderizador headless engasga
   * (medido: cinco segundos entre o toque e o app reagir), uma leitura marcada no relogio chega
   * antes de o app ter visto o gesto e a checagem fica vermelha sem nada estar quebrado. Quem
   * espera uma condicao paga so o tempo que precisa, e no limite devolve false em vez de mentir.
   *
   * Espere um sinal ANTERIOR ao que a checagem olha (o app ter registrado o arrasto, e nao a seta
   * estar pintada): assim uma regressao de verdade continua ficando vermelha, so que mais devagar.
   * A expressao pode estourar enquanto a pagina nao esta pronta, e isso conta como "ainda nao".
   */
  const esperar = async (expressao, limite = 8000, passo = 50) => {
    let ate = Date.now() + limite;
    for (;;) {
      const t0 = Date.now();
      let pronto = false;
      try { pronto = await js(`!!(${expressao})`, false) === true; } catch { /* ainda nao */ }
      // O tempo que o navegador levou pra responder nao conta no limite. Quando ele engasga, a
      // resposta demora e chega descrevendo um instante anterior aos eventos que ainda estao na
      // fila: sem descontar, uma unica pergunta lenta gastaria o limite inteiro e a espera
      // desistiria sem nunca ter perguntado de novo (visto na primeira versao desta funcao).
      ate += Date.now() - t0;
      if (pronto) return true;
      if (Date.now() >= ate) return false;
      await sleep(passo);
    }
  };

  await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { send, js, open, esperar, close: () => { ws.close(); proc.kill(); } };
}

/** Counts and prints checks; done() prints the verdict and exits with it */
function reporter() {
  let passed = 0;
  let failures = 0;
  return {
    check(label, cond, extra) {
      if (cond) passed++; else failures++;
      console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || extra === undefined ? '' : '  -> ' + JSON.stringify(extra)}`);
    },
    done() {
      console.log(failures ? `\n${failures} FALHA(S), ${passed} ok` : `\nTUDO OK (${passed} checagens)`);
      process.exit(failures ? 1 : 0);
    },
  };
}

module.exports = { ROOT, LIBS, sleep, tmpDir, cdnVersions, installedVersions, appScripts, appSource, buildPage, launch, reporter };
