/* ============================================================
 *  Service Worker — PlayGTA5
 *  Cache + fallback multi-CDN + soporte COOP/COEP
 * ============================================================ */

const CDN_PRIMARY  = 'https://gta.deloskiyt.pl';
const CDN_FALLBACK = 'https://cdn.apkprojects.xyz/mirror/playgta5.com';

const CACHE_PREFIX = 'gta5-';
const CACHE        = CACHE_PREFIX + 'v43';
const MAX_BYTES    = 8 * 1024 * 1024 * 1024; // 8 GB

const ROOT_JS = new Set([
  '/b/8b0b5899ed/loader.js',
  '/b/8b0b5899ed/audio-worklet.js',
  '/b/8b0b5899ed/game.js',
  '/b/8b0b5899ed/io_worker.js',
  '/b/8b0b5899ed/wgpu_worker.js',
]);

const FRONTEND = new Set([
  '/', '/index.html', '/sw2.js', '/sw.js',
  '/favicon.ico', '/robots.txt', '/_headers', '/_redirects',
]);

/* ---------- utilidades ---------- */

function isFrontend(p) {
  return FRONTEND.has(p) || p.startsWith('/img/') || p.startsWith('/.github/');
}

function iso(r) {
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(r.body, {
    status: r.status,
    statusText: r.statusText,
    headers: h,
  });
}

function headFrom(r) {
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(null, {
    status: r.status,
    statusText: r.statusText,
    headers: h,
  });
}

function errorResponse(status, statusText) {
  return iso(new Response('', {
    status,
    statusText: statusText || (status === 404 ? 'Not Found' : 'Gateway Timeout'),
  }));
}

function emptyJsonResponse() {
  return iso(new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function isGoodResponse(res, pathname, method) {
  if (!res) return false;
  if (method === 'HEAD') {
    // El CDN puede omitir Content-Type en HEAD; basta con 200.
    return res.status === 200;
  }
  if (res.status !== 200 && res.status !== 206) return false;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) return false;
  if (pathname.endsWith('.js')   && !ct.includes('javascript')) return false;
  if (pathname.endsWith('.wasm') && !ct.includes('wasm') && !ct.includes('octet-stream')) return false;
  if (pathname.endsWith('.json') && !ct.includes('json')) return false;
  return true;
}

/* ---------- ciclo de vida ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE)
        .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ---------- gestión de tamaño ---------- */

async function entrySize(res) {
  const len = parseInt(res.headers.get('Content-Length') || '0', 10);
  if (len > 0) return len;
  try {
    const blob = await res.clone().blob();
    return blob.size;
  } catch (e) {
    return 0;
  }
}

async function trim() {
  try {
    const c = await caches.open(CACHE);
    const reqs = await c.keys();
    const sizes = [];
    let total = 0;

    for (const r of reqs) {
      const res = await c.match(r);
      if (!res) continue;
      const len = await entrySize(res);
      sizes.push({ r, len });
      total += len;
    }

    if (total <= MAX_BYTES) return;

    let removed = 0;
    for (const { r, len } of sizes) {
      if (total - removed <= MAX_BYTES * 0.9) break;
      await c.delete(r);
      removed += len;
    }
  } catch (e) { /* noop */ }
}

/* ---------- fetch a CDN ---------- */

async function fetchFrom(url, range, method) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), range ? 15000 : 120000);
  const headers = {};
  if (range) headers['Range'] = range;

  try {
    const res = await fetch(url, {
      method: method || 'GET',
      headers,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

/* ---------- rangos desde caché ---------- */

async function sliceCached(cached, range) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return null;
  if (m[1] === '' && m[2] === '') return null;

  let blob;
  try {
    blob = await cached.clone().blob();
  } catch (e) {
    return null;
  }
  const total = blob.size;
  if (total <= 0) return null;

  let s, e;
  if (m[1] === '') {
    // rango sufijo: bytes=-N  → últimos N bytes
    const n = parseInt(m[2], 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    s = Math.max(0, total - n);
    e = total - 1;
  } else {
    s = parseInt(m[1], 10);
    e = m[2] === '' ? total - 1 : parseInt(m[2], 10);
  }

  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  if (e >= total) e = total - 1;
  if (s < 0 || s > e || s >= total) {
    // rango insatisfacible
    const h = new Headers(cached.headers);
    h.set('Content-Range', `bytes */${total}`);
    h.set('Accept-Ranges', 'bytes');
    return iso(new Response('', { status: 416, statusText: 'Range Not Satisfiable', headers: h }));
  }

  const slice = blob.slice(s, e + 1);
  const h = new Headers(cached.headers);
  h.delete('Content-Encoding');
  h.set('Content-Range',  `bytes ${s}-${e}/${total}`);
  h.set('Content-Length', String(slice.size));
  h.set('Accept-Ranges',  'bytes');
  return iso(new Response(slice, {
    status: 206,
    statusText: 'Partial Content',
    headers: h,
  }));
}

/* ---------- handler de assets ---------- */

async function asset(event) {
  const req    = event.request;
  const method = req.method;
  const url    = new URL(req.url);
  const p      = url.pathname;
  const key    = p + url.search;      // incluye query string
  const range  = req.headers.get('Range');
  const cache  = await caches.open(CACHE);
  const wantsJson = p.endsWith('.json');

  const cached = await cache.match(key);

  if (cached) {
    if (!range) {
      return method === 'HEAD' ? headFrom(cached) : iso(cached);
    }
    const partial = await sliceCached(cached, range);
    if (partial) return partial;
  }

  const isWasmOrRpf = p.endsWith('.wasm') || p.endsWith('.rpf');

  let res = null;

  if (isWasmOrRpf) {
    res = await fetchFrom(CDN_FALLBACK + p + url.search, range, method);
    if (!isGoodResponse(res, p, method)) {
      const second = await fetchFrom(CDN_PRIMARY + p + url.search, range, method);
      if (isGoodResponse(second, p, method)) res = second;
    }
  } else {
    res = await fetchFrom(CDN_PRIMARY + p + url.search, range, method);
    if (!isGoodResponse(res, p, method)) {
      const fb = await fetchFrom(CDN_FALLBACK + p + url.search, range, method);
      if (isGoodResponse(fb, p, method)) res = fb;
    }
  }

  // Si pedimos un rango y el CDN ignoró la cabecera, la respuesta no es válida
  // para una petición Range: la descartamos.
  if (range && res && res.status === 200) res = null;

  if (!isGoodResponse(res, p, method)) {
    if (wantsJson && method !== 'HEAD') return emptyJsonResponse();
    return errorResponse(404);
  }

  // Solo cacheamos respuestas completas (200) de tipo GET.
  if (method === 'GET' && res.status === 200 && !range) {
    try {
      const clone = res.clone();
      event.waitUntil(cache.put(key, clone).then(trim).catch(() => {}));
    } catch (e) { /* noop */ }
  }

  return method === 'HEAD' ? headFrom(res) : iso(res);
}

/* ---------- handler de frontend ---------- */

async function frontend(event) {
  const req   = event.request;
  const cache = await caches.open(CACHE);

  try {
    const res = await fetch(req);

    if (req.method === 'GET' && res && res.status === 200) {
      try {
        const clone = res.clone();
        event.waitUntil(cache.put(req, clone).catch(() => {}));
      } catch (e) { /* noop */ }
    }

    return req.method === 'HEAD' ? headFrom(res) : iso(res);
  } catch (e) {
    // Fallback offline: primero por petición exacta, luego por pathname.
    const c = (await cache.match(req)) ||
              (await cache.match(new URL(req.url).pathname));
    if (c) return req.method === 'HEAD' ? headFrom(c) : iso(c);
    return errorResponse(504, 'Gateway Timeout');
  }
}

/* ---------- router ---------- */

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const method = event.request.method;
  if (method !== 'GET' && method !== 'HEAD') return;

  // Estos scripts los gestiona el navegador directamente.
  if (ROOT_JS.has(url.pathname)) return;

  if (isFrontend(url.pathname)) {
    event.respondWith(frontend(event));
    return;
  }

  event.respondWith(asset(event));
});
