/**
 * sw2.js — v35
 * Sirve los assets del juego desde gta.deloskiyt.pl
 * (el CDN rápido con mejor peering para LatAm).
 */

const CDN = 'https://gta.deloskiyt.pl';
const CACHE = 'gta5-v35';
const MAX_BYTES = 5 * 1024 * 1024 * 1024;
const TIMEOUT_DEFAULT = 45000;
const TIMEOUT_FULL = 300000;

const FRONTEND = new Set([
  '/', '/index.html', '/sw2.js', '/sw.js',
  '/CNAME', '/README.md', '/favicon.ico', '/robots.txt',
]);

function isFrontend(p) {
  return FRONTEND.has(p) || p.startsWith('/img/') || p.startsWith('/.github/');
}

function makeUrl(pathname) {
  return CDN + pathname;
}

function injectIsolation(r) {
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function fastFetch(url, req, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const headers = {};
  const range = req.headers.get('Range');
  if (range) headers['Range'] = range;
  return fetch(url, { method: 'GET', headers, mode: 'cors', credentials: 'omit', signal: ctrl.signal })
    .then((r) => { clearTimeout(timer); return (r.ok || r.status === 206) ? r : null; })
    .catch(() => { clearTimeout(timer); return null; });
}

async function handleAsset(event) {
  const req = event.request;
  const url = new URL(req.url);
  const pathname = url.pathname;
  const range = req.headers.get('Range');
  const cache = await caches.open(CACHE);

  // Caché local
  const cached = await cache.match(pathname);
  if (cached && !range) return injectIsolation(cached);

  // Fetch del CDN gta
  const timeout = range ? 15000 : pathname.endsWith('.rpf') ? TIMEOUT_FULL : TIMEOUT_DEFAULT;
  const res = await fastFetch(makeUrl(pathname), req, timeout);
  if (!res) return new Response('', { status: 404 });

  // Cachear respuestas completas
  if (!range && res.status === 200) {
    const cacheable = res.clone();
    event.waitUntil?.(cache.put(pathname, cacheable).catch(() => {}));
  }

  return injectIsolation(res);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;

  if (isFrontend(url.pathname)) {
    event.respondWith((async () => {
      try {
        const res = await fetch(event.request);
        return injectIsolation(res);
      } catch (err) {
        const c = await caches.match(event.request);
        if (c) return injectIsolation(c);
        return new Response('', { status: 504 });
      }
    })());
    return;
  }
  event.respondWith(handleAsset(event));
});
