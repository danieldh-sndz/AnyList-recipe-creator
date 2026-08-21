// Caches the app shell so the app opens without a connection once installed.
// Bump CACHE when any shell file changes.

const CACHE = 'recipe-to-anylist-v2';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/parser.js',
  'js/paprika.js',
  'js/recipe-doc.js',
  'js/store.js',
  'js/claude.js',
  'js/imagegen.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) {
        // Refresh in the background so the next launch has the newer file.
        event.waitUntil(
          fetch(request)
            .then((response) => response.ok && caches.open(CACHE).then((cache) => cache.put(request, response)))
            .catch(() => {}),
        );
        return hit;
      }
      return fetch(request).catch(() => caches.match('index.html'));
    }),
  );
});
