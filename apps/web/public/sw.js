/* global self, caches, clients, addEventListener, location */

/**
 * Motoro service worker — no build step, plain JS.
 *
 * Strategy:
 *  - navigations        → network-first, offline fallback = precached /offline
 *  - /_next/static, icons, manifest → cache-first with network populate
 *  - anything else (notably /api/)  → never intercepted (network only)
 */

const CACHE_VERSION = 'motoro-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const KNOWN_CACHES = [STATIC_CACHE];

const OFFLINE_URL = '/offline';
const PRECACHE_URLS = [
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-maskable.svg',
];

const STATIC_FILES = new Set(['/manifest.webmanifest', '/icon.svg', '/icon-maskable.svg']);
const STATIC_PREFIXES = ['/_next/static/', '/_next/image'];

/** next dev serves mutable chunk URLs — never serve those from cache. */
function isDevHost() {
  const host = location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** Never persist 2xx-less or cookie-bearing responses. */
function isCacheable(response) {
  if (!response) return false;
  if (response.status !== 200) return false;
  if (response.headers.get('set-cookie')) return false;
  return true;
}

function isStaticAsset(pathname) {
  if (STATIC_FILES.has(pathname)) return true;
  return STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

async function precache(urls) {
  const cache = await caches.open(STATIC_CACHE);
  await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await fetch(url);
        if (isCacheable(response)) await cache.put(url, response);
      } catch (err) {
        // Install must never fail because one asset was unreachable.
        void err;
      }
    }),
  );
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) {
    const cache = await caches.open(STATIC_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstForNavigation(request) {
  try {
    return await fetch(request);
  } catch (err) {
    void err;
    const offline = await caches.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Offline · Motoro</title>' +
        '<body style="font-family:system-ui;background:#fbfaf7;color:#14161c;padding:2rem;text-align:center">' +
        '<h1>You are offline</h1><p>Motoro could not reach the network. Please reconnect.</p>' +
        '<a href="/" style="color:#14161c">Retry</a></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

addEventListener('install', (event) => {
  event.waitUntil(
    precache(PRECACHE_URLS)
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !KNOWN_CACHES.includes(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => clients.claim()),
  );
});

addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    void err;
    return;
  }

  // Cross-origin (maps, CDNs) → leave alone.
  if (url.origin !== location.origin) return;

  // Sessions/cookies: /api/ is always straight to the network.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstForNavigation(request));
    return;
  }

  // Dev-safe: in development only navigations are handled, so HMR chunks are
  // always fetched from the dev server.
  if (isDevHost()) return;

  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

// ---------------------------------------------------------------------------
// Web Push (payload is encrypted aes128gcm JSON from the worker)
// ---------------------------------------------------------------------------

function defaultUrlForType(type) {
  if (type === 'JOB_OFFER' || type === 'DISPATCH_TIMEOUT') return '/mechanic';
  return '/notifications';
}

addEventListener('push', (event) => {
  let payload = { title: 'Motoro', body: 'You have a new notification' };
  try {
    const data = event.data ? event.data.json() : null;
    if (data && typeof data === 'object') {
      payload = {
        title: data.title || payload.title,
        body: data.body || payload.body,
        url: data.url || defaultUrlForType(data.type),
      };
    }
  } catch (err) {
    if (event.data) payload.body = event.data.text();
    else void err;
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon.svg',
      badge: '/icon-maskable.svg',
      data: { url: payload.url },
    }),
  );
});

addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/notifications';
  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((list) => {
        for (const client of list) {
          if ('focus' in client) {
            void client.navigate(target);
            return client.focus();
          }
        }
        return clients.openWindow(target);
      }),
  );
});
