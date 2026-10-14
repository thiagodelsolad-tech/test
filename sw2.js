/**
 * sw2.js — v39
 * Los workers JS (loader, audio-worklet, wgpu, io, game) se sirven
 * directamente desde Cloudflare Pages (raíz del repo).
 * Los assets (data, shaders, rpf, title) desde gta.deloskiyt.pl con
 * fallback a R2.
 */

const CDN_PRIMARY = 'https://gta.deloskiyt.pl';
const CDN_FALLBACK = 'https://cdn.apkprojects.xyz/mirror/playgta5.com';
const CACHE = 'gta5-v39';
const MAX_BYTES = 8 * 1024 * 1024 * 1024;

// Workers JS que están en la raíz del repo (NO pedirlos al CDN)
const ROOT_JS = new Set([
  '/b/8b0b5899ed/loader.js',
  '/b/8b0b5899ed/audio-worklet.js',
  '/b/8b0b5899ed/game.js',
  '/b/8b0b5899ed/io_worker.js',
  '/b/8b0b5899ed/wgpu_worker.js',
]);

const FRONTEND = new Set(['/', '/index.html', '/sw2.js', '/sw.js', '/favicon.ico', '/robots.txt', '/_headers']);

function isFrontend(p) {
  return FRONTEND.has(p) || p.startsWith('/img/') || p.startsWith('/.github/');
}

function iso(r) {
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

function isGoodResponse(res, pathname) {
  if (!res) return false;
  if (res.status !== 200 && res.status !== 206) return false;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  // Para JS, MIME DEBE ser javascript (browsers lo exigen para módulos)
  if (pathname.endsWith('.js')) {
    if (!ct.includes('javascript')) return false;
  }
  // Para JSON, MIME no debe ser HTML
  if (pathname.endsWith('.json') && ct.includes('text/html')) return false;
  return true;
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
  await self.clients.claim();
})()));

async function trim() {
  try {
    const c = await caches.open(CACHE);
    const reqs = await c.keys();
    let total = 0, sizes = [];
    for (const r of reqs) {
      const res = await c.match(r);
      if (!res) continue;
      const len = parseInt(res.headers.get('Content-Length') || '0', 10) || 0;
      sizes.push({ r, len }); total += len;
    }
    if (total <= MAX_BYTES) return;
    let removed = 0;
    for (const { r, len } of sizes) {
      if (total - removed <= MAX_BYTES * 0.9) break;
      await c.delete(r); removed += len;
    }
  } catch (e) {}
}

async function fetchFrom(url, range) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), range ? 15000 : 300000);
  const headers = {};
  if (range) headers['Range'] = range;
  try {
    const res = await fetch(url, {
      method: 'GET', headers, mode: 'cors', credentials: 'omit', signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

async function asset(event) {
  const req = event.request;
  const url = new URL(req.url);
  const p = url.pathname;
  const range = req.headers.get('Range');

  // ═══════════════════════════════════════════════════════════════════
  // 1. WORKERS JS → servir del ROOT de Cloudflare Pages (mismo origin)
  //    (evita el CDN que no tiene estos archivos en /b/8b0b5899ed/)
  // ═══════════════════════════════════════════════════════════════════
  if (ROOT_JS.has(p)) {
    const rootPath = '/' + p.split('/').pop();  // /b/8b0b5899ed/loader.js → /loader.js
    try {
      const res = await fetch(rootPath);
      if (res.ok) return iso(res);
    } catch (e) {}
    // Si falla, cae al CDN como último recurso
  }

  // ═══════════════════════════════════════════════════════════════════
  // 2. Caché local
  // ═══════════════════════════════════════════════════════════════════
  const cache = await caches.open(CACHE);
  const cached = await cache.match(p);
  if (cached && !range) return iso(cached);

  if (cached && range) {
    try {
      const buf = await cached.arrayBuffer();
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        let s = m[1] === '' ? 0 : parseInt(m[1], 10);
        let e = m[2] === '' ? buf.byteLength - 1 : parseInt(m[2], 10);
        if (e >= buf.byteLength) e = buf.byteLength - 1;
        if (s <= e && s < buf.byteLength) {
          const slice = buf.slice(s, e + 1);
          const h = new Headers(cached.headers);
          h.set('Content-Range', `bytes ${s}-${e}/${buf.byteLength}`);
          h.set('Content-Length', String(slice.byteLength));
          h.set('Accept-Ranges', 'bytes');
          return iso(new Response(slice, { status: 206, headers: h }));
        }
      }
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3. CDN primario → CDN fallback
  // ═══════════════════════════════════════════════════════════════════
  let res = await fetchFrom(CDN_PRIMARY + p + url.search, range);
  if (!isGoodResponse(res, p)) {
    const fb = await fetchFrom(CDN_FALLBACK + p + url.search, range);
    if (isGoodResponse(fb, p)) res = fb;
  }

  if (!isGoodResponse(res, p)) {
    return new Response('', { status: 404 });
  }

  if (res.status === 200 && !range) {
    try {
      const clone = res.clone();
      event.waitUntil?.(cache.put(p, clone).then(() => trim()).catch(() => {}));
    } catch (e) {}
  }

  return iso(res);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;

  if (isFrontend(url.pathname)) {
    event.respondWith((async () => {
      try { return iso(await fetch(event.request)); }
      catch (e) {
        const c = await caches.match(event.request);
        if (c) return iso(c);
        return new Response('', { status: 504 });
      }
    })());
    return;
  }
  event.respondWith(asset(event));
});
