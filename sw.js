// Drive Notes: Service Worker
const CACHE_NAME = 'drivenotes-v58';

// Renderer and sanitizer come from CDNs; without them offline the reading view falls back to
// plain text. Must match the script tags in index.html, hash included (scenario 0 of
// tests/app.test.js checks both files against node_modules).
//
// The page checks the hash of whatever it gets, the cached copy too, so a changed file never
// runs. The service worker checks it as well, because the page's hash does not reach it: in
// Chrome the request arrives here with `integrity` empty (measured on 22 Sep 2026), and a plain
// fetch(event.request) would store a changed file over the good copy, leaving the reading view
// without formatting from the next opening on. Those copies are also fetched in CORS mode (the
// default for a url), since the page cannot check an opaque response.
const CDN_SCRIPTS = {
  'https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js': 'sha384-H+hy9ULve6xfxRkWIh/YOtvDdpXgV2fmAGQkIDTxIgZwNoaoBal14Di2YTMR6MzR',
  'https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js': 'sha384-JEyTNhjM6R1ElGoJns4U2Ln4ofPcqzSsynQkmEc/KGy6336qAZl70tDLufbkla+3',
};
// The Google Fonts stylesheet is here too, but the font files it names live on
// fonts.gstatic.com under urls we cannot predict: those are caught at runtime by CDN_HOSTS
// the first time a page renders, so the second visit already has the letters offline.
//
// O editor não entra nesta lista: ele é o vendor/codemirror.js, versionado no repositório e
// guardado logo abaixo, junto com os arquivos estáticos.
const CDN_ASSETS = [
  ...Object.keys(CDN_SCRIPTS),
  'https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap',
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// Static assets to cache for offline use
const STATIC_ASSETS = [
  './index.html',
  './style.css',
  './app.js',
  './vendor/codemirror.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // cache: 'reload' obriga cada pedido a ir na rede. Sem isso o navegador responde do
      // cache HTTP dele, e como o GitHub Pages manda max-age=600, um cache novo nasce com
      // os arquivos velhos dentro: o deploy sai, o numero do cache sobe, e o aparelho segue
      // mostrando a versao anterior por dez minutos.
      const fresh = (url) => new Request(url, { cache: 'reload', integrity: CDN_SCRIPTS[url] || '' });
      // Best effort: a CDN hiccup must not block the install of the app itself
      return Promise.all([
        cache.addAll(STATIC_ASSETS.map(fresh)),
        ...CDN_ASSETS.map((url) => cache.add(fresh(url)).catch(() => {})),
      ]);
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches, and only then take over the open pages. Taking over is what tells a
// page there is a new version, and the home screen reloads on the spot (App.watchVersions). The
// fetch below looks in every cache there is, oldest first: claimed before the old cache is gone,
// that reload could get the old index.html back and open on the old version once more.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// The locked CDN scripts go out with their hash, everything else as the page asked
const network = (request) => CDN_SCRIPTS[request.url]
  ? fetch(request.url, { integrity: CDN_SCRIPTS[request.url] })
  : fetch(request);

// Something shared from another app (manifest share_target) arrives as a POST, which GitHub Pages cannot
// take. It goes into the arrival box, and the app opens pointing at it. The box is the same database
// as App.ArrivalBox in app.js (name, store and record: keep the two in step). Kept here, before the page
// opens, so an expired login or no network at that moment loses nothing.
const ARRIVALS_DB = 'drivenotes-arrivals';
const ARRIVALS_STORE = 'arrivals';

function keepArrival(record) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ARRIVALS_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(ARRIVALS_STORE, { keyPath: 'id' });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(ARRIVALS_STORE, 'readwrite');
      tx.objectStore(ARRIVALS_STORE).put(record);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

/** The words of a shared .txt: UTF-8, unless a byte order mark says UTF-16. TextDecoder drops the mark. */
function readText(bytes) {
  const [a, b] = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  const encoding = a === 0xff && b === 0xfe ? 'utf-16le' : a === 0xfe && b === 0xff ? 'utf-16be' : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}

async function receiveShare(request) {
  const form = await request.formData();
  // What Chrome sent, every entry and without content (the app's diagnostic log shows it): tells a photo
  // that never came from one that came empty, under another name or in a type the app cannot use
  const got = [...form.entries()].map(([key, value]) => (typeof value === 'string'
    ? `${key}:text(${value.length})`
    : `${key}:file(${value.type || ''},${value.size},${value.name ? 'named' : 'noname'})`));
  const photos = [];
  for (const file of form.getAll('photos')) {
    // Photos go in as bytes: an ArrayBuffer crosses IndexedDB anywhere, a File not always
    if (file && typeof file === 'object' && file.size) {
      photos.push({ name: file.name || '', type: file.type || '', bytes: await file.arrayBuffer() });
    }
  }
  const text = (name) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  // A .txt file (the transcript a voice recorder shares) arrives as text, like text shared as such.
  // Several files, or a file plus text, are joined by a blank line; the same words twice go in once.
  const texts = [text('text')];
  for (const file of form.getAll('texts')) {
    if (file && typeof file === 'object' && file.size) texts.push(readText(await file.arrayBuffer()));
  }
  const shared = [...new Set(texts.map((s) => s.trim()).filter(Boolean))].join('\n\n');
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await keepArrival({ id, at: Date.now(), title: text('title'), text: shared, url: text('url'), photos, got });
  return Response.redirect(`./index.html?chegada=${encodeURIComponent(id)}`, 303);
}

// Fetch: cache-first for static assets, network-first for API calls
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache Google API calls
  if (
    url.hostname === 'www.googleapis.com' ||
    url.hostname === 'apis.google.com' ||
    url.hostname === 'accounts.google.com'
  ) {
    return;
  }

  // As paginas de experimento em /lab/ ficam de fora do cache. Elas existem pra ser
  // trocadas e reabertas no celular a cada ajuste, e o cache-first abaixo devolveria a
  // versao anterior: o mesmo "abrir e fechar duas vezes" que ja e dor no app viraria dor
  // no proprio lugar onde a gente esta tentando medir uma coisa.
  if (url.origin === self.location.origin && url.pathname.includes('/lab/')) {
    return;
  }

  if (event.request.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(event.request).catch(() => Response.redirect('./index.html', 303)));
    return;
  }

  // An opening from a shortcut on the icon (index.html?atalho=...) or from a share (?chegada=...) is the
  // same page: answered from the cached index.html, the query ignored. Without this it never matches the
  // cache (no network: an error page) and every new query would be stored as one more copy of the page.
  if (event.request.mode === 'navigate' && url.origin === self.location.origin && url.search) {
    event.respondWith(
      caches.match('./index.html', { ignoreSearch: true }).then((cached) => cached || network(event.request))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Return cached, but also update cache in background
        network(event.request).then((response) => {
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, response);
            });
          }
        }).catch(() => {});
        return cached;
      }

      return network(event.request).then((response) => {
        // Cache successful responses for our own assets and the pinned CDN libraries
        if (response.ok && (url.origin === self.location.origin || CDN_HOSTS.includes(url.hostname))) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      });
    })
  );
});
