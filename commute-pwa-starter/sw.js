// Basic cache-first service worker with offline support
const CACHE = 'commute-pwa-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './assets/icon-192.png',
  './assets/icon-512.png',
  'https://cdn.plot.ly/plotly-2.35.2.min.js',
  'https://unpkg.com/dexie@4.0.8/dist/dexie.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Cache-first for same-origin and whitelisted CDNs
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(e.request);
    if (cached) return cached;
    try {
      const res = await fetch(e.request);
      // Cache GET responses
      if (e.request.method === 'GET' && (url.origin === location.origin || ASSETS.includes(url.href))) {
        cache.put(e.request, res.clone());
      }
      return res;
    } catch (err) {
      // Offline fallback: return cache if any (cached below)
      if (cached) return cached;
      return new Response('オフラインです。初回アクセス時にキャッシュを作成してください。', { status: 503 });
    }
  })());
});
