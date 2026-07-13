const CACHE_NAME = 'jm-studio-v4-20260713';
const APP_SHELL = [
  './',
  'manifest.json',
  '../assets/img/favicons/favicon.svg',
  '../assets/img/favicons/apple-touch-icon.png',
  '../assets/img/favicons/pwa-192.png',
  '../assets/img/favicons/pwa-512.png',
  '../assets/img/favicons/pwa-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.allSettled(APP_SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(keys.filter((key) => key.startsWith('jm-studio-') && key !== CACHE_NAME).map((key) => caches.delete(key)))
      ),
      self.clients.claim(),
    ])
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    const cacheKey = new Request(url.origin + url.pathname);
    const isOAuthCallback = url.searchParams.has('code') || url.searchParams.has('state') || url.searchParams.has('error');
    let cacheWrite = Promise.resolve();
    const networkResponse = fetch(event.request).then((response) => {
      if (response.ok && !isOAuthCallback) {
        cacheWrite = caches.open(CACHE_NAME)
          .then((cache) => cache.put(cacheKey, response.clone()))
          .catch(() => undefined);
      }
      return response;
    });

    event.waitUntil(networkResponse.then(() => cacheWrite).catch(() => undefined));
    event.respondWith(
      networkResponse.catch(async () => {
        return (await caches.match(cacheKey)) || (await caches.match('./')) || Response.error();
      })
    );
    return;
  }

  let cacheWrite = Promise.resolve();
  const networkUpdate = fetch(event.request).then((response) => {
    if (response.ok) {
      cacheWrite = caches.open(CACHE_NAME)
        .then((cache) => cache.put(event.request, response.clone()))
        .catch(() => undefined);
    }
    return response;
  }).catch(() => null);

  event.waitUntil(networkUpdate.then(() => cacheWrite).catch(() => undefined));
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return networkUpdate.then((response) => response || Response.error());
    })
  );
});
