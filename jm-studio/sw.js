const CACHE_NAME = 'jm-studio-v7-sky-20261105';
const APP_SHELL = [
  './',
  'manifest.json?v=sky-20261105',
  '../assets/img/favicons/favicon-96x96.png?v=kindness-20260906-2',
  '../assets/img/favicons/favicon.svg?v=kindness-20260906-2',
  '../assets/img/favicons/favicon.ico?v=kindness-20260906-2',
  '../assets/img/favicons/apple-touch-icon.png?v=kindness-20260906-2',
  '../assets/img/favicons/pwa-192.png?v=kindness-20260906-2',
  '../assets/img/favicons/pwa-512.png?v=kindness-20260906-2',
  '../assets/img/favicons/pwa-maskable-512.png?v=kindness-20260906-2',
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

/* Share target (manifest.json): photos and text sent from another app arrive
   as a POST here. They wait in their own cache, which the jm-studio- cleanup
   above leaves alone, until Studio opens them as a new post (?share=1). */
const SHARE_CACHE = 'studio-share';
const SHARE_LIMIT = 20;

async function receiveShare(request) {
  const form = await request.formData();
  await caches.delete(SHARE_CACHE);
  const cache = await caches.open(SHARE_CACHE);
  const files = form.getAll('photos')
    .filter((file) => file && typeof file === 'object' && file.size > 0)
    .slice(0, SHARE_LIMIT);
  await Promise.all(files.map((file, index) => cache.put('shared/' + index, new Response(file, {
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name || ''),
    },
  }))));
  const meta = {
    title: String(form.get('title') || ''),
    text: String(form.get('text') || ''),
    url: String(form.get('url') || ''),
    count: files.length,
  };
  await cache.put('shared/meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  return Response.redirect(new URL('./?share=1', self.location.href).href, 303);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(event.request).catch(() => Response.redirect(new URL('./', self.location.href).href, 303)));
    return;
  }
  if (event.request.method !== 'GET') return;
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
