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
  // O cenario 40 (Enter numa tarefa) ja e CM6: quem ainda usa esta entrada e a suite de navegador
  // (buildPage), ate a tarefa 9 tirar o TinyMDE do index.html de vez.
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

/** Versions the app loads in production, read from the script tags in index.html */
function cdnVersions() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const find = (name) => new RegExp(`${name}@([0-9.]+)/`).exec(html)?.[1];
  return { 'tiny-markdown-editor': find('tiny-markdown-editor'), marked: find('marked'), dompurify: find('dompurify') };
}

function installedVersions() {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(MODULES, name, 'package.json'), 'utf8')).version;
  return { 'tiny-markdown-editor': read('tiny-markdown-editor'), marked: read('marked'), dompurify: read('dompurify') };
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
 * A page with the real index.html and the given app.js source, the libraries served from node_modules,
 * and no Google script or service worker. Returns its file:// URL.
 */
function buildPage(name, appSource) {
  const dir = tmpDir();
  const url = (file) => pathToFileURL(file).href;
  fs.writeFileSync(path.join(dir, `${name}-app.js`), appSource);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace('<head>', `<head><base href="${url(ROOT)}/">`)
    .replace(/<script src="https:\/\/unpkg[^>]*><\/script>/, `<script src="${url(LIBS.tinymde)}"></script>`)
    .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/marked[^>]*><\/script>/, `<script src="${url(LIBS.marked)}"></script>`)
    .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/dompurify[^>]*><\/script>/, `<script src="${url(LIBS.purify)}"></script>`)
    .replace(/<script[^>]*src="https:\/\/(apis\.google|accounts\.google)[^>]*><\/script>/g, '')
    .replace('<script src="app.js"></script>', `<script src="${url(path.join(dir, `${name}-app.js`))}"></script><script>window.__App = App;</script>`)
    .replace(/<script>\s*if \('serviceWorker'[\s\S]*?<\/script>/, '');
  const file = path.join(dir, `${name}.html`);
  fs.writeFileSync(file, html);
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

  await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { send, js, open, close: () => { ws.close(); proc.kill(); } };
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

module.exports = { ROOT, LIBS, sleep, tmpDir, cdnVersions, installedVersions, buildPage, launch, reporter };
