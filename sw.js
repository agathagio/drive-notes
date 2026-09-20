// Drive Notes: Service Worker
const CACHE_NAME = 'drivenotes-v27';

// Editor, renderer and sanitizer come from CDNs; without them offline the app falls back
// to a bare textarea and plain-text reading. Must match the script tags in index.html.
// The Google Fonts stylesheet is here too, but the font files it names live on
// fonts.gstatic.com under urls we cannot predict: those are caught at runtime by CDN_HOSTS
// the first time a page renders, so the second visit already has the letters offline.
const CDN_ASSETS = [
  'https://unpkg.com/tiny-markdown-editor@0.1.8/dist/tiny-mde.min.js',
  'https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js',
  'https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap',
];
const CDN_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// Static assets to cache for offline use
const STATIC_ASSETS = [
  './index.html',
  './style.css',
  './app.js',
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
      const fresh = (url) => new Request(url, { cache: 'reload' });
      // Best effort: a CDN hiccup must not block the install of the app itself
      return Promise.all([
        cache.addAll(STATIC_ASSETS.map(fresh)),
        ...CDN_ASSETS.map((url) => cache.add(fresh(url)).catch(() => {})),
      ]);
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

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

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Return cached, but also update cache in background
        fetch(event.request).then((response) => {
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, response);
            });
          }
        }).catch(() => {});
        return cached;
      }

      return fetch(event.request).then((response) => {
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
