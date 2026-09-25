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
  // The app no longer loads TinyMDE. What still needs this entry is the historical control of
  // scenario 1 of the browser suite, which runs the app of a commit from before the editor swap.
  //
  // That is why `tiny-markdown-editor` stays in devDependencies ON PURPOSE, even after the
  // editor swap: it is not a leftover. Without the library, the old app falls back to the textarea and
  // the control stops proving that the dictation bug existed, which is the only reason it runs.
  tinymde: path.join(MODULES, 'tiny-markdown-editor', 'dist', 'tiny-mde.js'),
  // The single bundle built by esbuild, the same file index.html loads
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
 * Only marked and dompurify: the editor is no longer a CDN with a version in the path, but
 * vendor/codemirror.js, versioned in the repository, which has no number at all to compare.
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
 * The app's own scripts, in the order index.html loads them: `app/*.js` in the working tree, `app.js`
 * in the commits from before the split (the historical controls). Never vendor/codemirror.js, which
 * is a library. `html` is the index.html to read, the one
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
 * CodeMirror 6 needs no swap at all: index.html loads `vendor/codemirror.js` by a relative
 * path, and the <base> above resolves that inside the repository itself. TinyMDE comes in on
 * request, `{ tinymde: true }`, and the one asking is the historical dictation control (scenario 1
 * of the browser suite): it runs the app of a commit from before the editor swap, which is pure
 * TinyMDE and without the library falls back to the textarea. That commit's index.html loads the lib
 * from unpkg, and that tag becomes the local copy from node_modules (or goes, if nobody asked). An
 * index.html without that tag, like today's tree, gets the local copy at the end of head when it is asked for.
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
   * Waits for the page to answer true to `expression`, instead of sleeping a fixed time.
   * Returns true if it got there, false if it ran past the limit (the caller decides what to do).
   *
   * Why it exists: touches and keys injected by `Input.dispatch*` come in through a browser queue
   * that is NOT the same as the one of `Runtime.evaluate`. When the headless renderer stalls
   * (measured: five seconds between the touch and the app reacting), a read timed by the clock arrives
   * before the app has seen the gesture and the check goes red with nothing broken. Whoever waits
   * for a condition pays only the time it needs, and at the limit returns false instead of lying.
   *
   * Wait for a signal EARLIER than the one the check looks at (the app having registered the drag,
   * and not the arrow being painted): that way a real regression still goes red, only more slowly.
   * The expression may throw while the page is not ready, and that counts as "not yet".
   */
  const waitFor = async (expression, limit = 8000, step = 50) => {
    let deadline = Date.now() + limit;
    for (;;) {
      const t0 = Date.now();
      let ready = false;
      try { ready = await js(`!!(${expression})`, false) === true; } catch { /* not yet */ }
      // The time the browser took to answer does not count toward the limit. When it stalls, the
      // answer is slow and arrives describing an instant earlier than the events still in the
      // queue: without discounting it, a single slow question would spend the whole limit and the wait
      // would give up without ever having asked again (seen in the first version of this function).
      deadline += Date.now() - t0;
      if (ready) return true;
      if (Date.now() >= deadline) return false;
      await sleep(step);
    }
  };

  await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { send, js, open, waitFor, close: () => { ws.close(); proc.kill(); } };
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
