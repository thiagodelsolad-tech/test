/**
 * sw.js — v36
 * Fuente primaria: gta.deloskiyt.pl (mismo commit que su game.wasm)
 * Fallback: cdn.apkprojects.xyz (tu mirror)
 */

// Fuente 1: el port original (assets sincronizados)
const PRIMARY_BASE   = 'https://gta.deloskiyt.pl/b/8b0b5899ed';

// Fuente 2: tu R2 (fallback)
const FALLBACK_BASE  = 'https://cdn.apkprojects.xyz';
const FALLBACK_BIN   = 'mirror/playgta5.com/b/8b0b5899ed';
const FALLBACK_ROOT  = 'mirror/playgta5.com/data';

const CACHE = 'gta5-v36';
const MAX_BYTES = 5 * 1024 * 1024 * 1024;
const TIMEOUT_DEFAULT = 45000;
const TIMEOUT_RANGE   = 15000;
const TIMEOUT_FULL    = 300000;

const FRONTEND = new Set([
  '/', '/index.html', '/sw.js', '/CNAME', '/README.md',
  '/loader.js', '/game.js', '/wgpu_worker.js', '/io_worker.js', '/audio-worklet.js',
  '/chalet.woff', '/favicon.ico', '/robots.txt', '/google88b6175162f03564.html',
]);

function isFrontend(p) {
  return FRONTEND.has(p) || p.startsWith('/img/') || p.startsWith('/.github/');
}
function isBatchPath(p) {
  return p.startsWith('/data/batchc/') || p === '/data/batch' || p.startsWith('/data/batch?');
}

// ============================================================
// URLs primarias — todo bajo /b/8b0b5899ed/ en el port original
// ============================================================
function primaryURL(localPath) {
  // /game.wasm           → /b/8b0b5899ed/game.wasm
  if (localPath === '/game.wasm') return PRIMARY_BASE + '/game.wasm';

  // /shaders/X           → /b/8b0b5899ed/shaders/X
  if (localPath.startsWith('/shaders/')) return PRIMARY_BASE + localPath;

  // /data/X              → /b/8b0b5899ed/X (el port original no usa /data/)
  if (localPath.startsWith('/data/')) {
    const rest = localPath.slice(6);
    return PRIMARY_BASE + '/' + rest;
  }

  // /game/X              → /b/8b0b5899ed/X
  if (localPath.startsWith('/game/')) {
    const rest = localPath.slice(6);
    return PRIMARY_BASE + '/' + rest;
  }

  return PRIMARY_BASE + localPath;
}

// ============================================================
// URLs de fallback (tu R2)
// ============================================================
function fallbackURLs(localPath) {
  if (localPath === '/game.wasm') {
    return [
      FALLBACK_BASE + '/' + FALLBACK_BIN + '/game.wasm',
      FALLBACK_BASE + '/' + FALLBACK_ROOT + '/game.wasm',
    ];
  }
  if (localPath.startsWith('/shaders/')) {
    const rest = localPath.slice(9);
    return [
      FALLBACK_BASE + '/' + FALLBACK_BIN + '/shaders/' + rest,
      FALLBACK_BASE + '/' + FALLBACK_ROOT + '/shaders/' + rest,
    ];
  }
  if (localPath.startsWith('/data/')) {
    const rest = localPath.slice(6);
    return [
      FALLBACK_BASE + '/' + FALLBACK_ROOT + '/' + rest,
    ];
  }
  if (localPath.startsWith('/game/')) {
    const rest = localPath.slice(6);
    return [
      FALLBACK_BASE + '/' + FALLBACK_ROOT + '/' + rest,
      FALLBACK_BASE + '/' + FALLBACK_BIN + '/' + rest,
    ];
  }
  return [FALLBACK_BASE + localPath.slice(1)];
}

function injectIsolation(r) {
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

// ============================================================
// Ciclo de vida
// ============================================================
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

let trimScheduled = false;
function scheduleTrimCache() {
  if (trimScheduled) return;
  trimScheduled = true;
  setTimeout(() => { trimScheduled = false; trimCache(); }, 8000);
}
async function trimCache() {
  try {
    const c = await caches.open(CACHE);
    const reqs = await c.keys();
    let total = 0; const sizes = [];
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

function fastFetch(url, req, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const headers = {};
  const range = req.headers.get('Range');
  if (range) headers['Range'] = range;
  return fetch(url, {
    method: 'GET', headers, mode: 'cors', credentials: 'omit', signal: ctrl.signal,
  })
    .then((r) => { clearTimeout(timer); return (r.ok || r.status === 206) ? r : null; })
    .catch(() => { clearTimeout(timer); return null; });
}

function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end   = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end === null) return null;
  if (start === null) { start = Math.max(0, totalSize - end); end = totalSize - 1; }
  else if (end === null || end >= totalSize) { end = totalSize - 1; }
  if (start > end || start >= totalSize) return null;
  return { start, end };
}

async function serveRangeFromCache(cachedResponse, rangeHeader) {
  const buf = await cachedResponse.arrayBuffer();
  const total = buf.byteLength;
  const range = parseRange(rangeHeader, total);
  if (!range) return null;
  const { start, end } = range;
  const slice = buf.slice(start, end + 1);
  const headers = new Headers(cachedResponse.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
  headers.set('Content-Length', String(slice.byteLength));
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Type', 'application/octet-stream');
  return new Response(slice, { status: 206, statusText: 'Partial Content', headers });
}

async function handleAsset(event) {
  const req = event.request;
  const url = new URL(req.url);
  const pathname = url.pathname;
  const range = req.headers.get('Range');
  const cache = await caches.open(CACHE);
  const cached = await cache.match(pathname);

  if (cached && range) {
    try {
      const ranged = await serveRangeFromCache(cached, range);
      if (ranged) return injectIsolation(ranged);
    } catch (e) {}
  }
  if (cached && !range) return injectIsolation(cached);

  // Timeout según tipo
  const timeout = range ? TIMEOUT_RANGE
                : pathname.endsWith('.rpf') ? TIMEOUT_FULL
                : TIMEOUT_DEFAULT;

  // ✅ Primero prueba la fuente primaria (gta.deloskiyt.pl)
  const primary = primaryURL(pathname);
  console.log('[SW] →', primary);
  let res = await fastFetch(primary, req, timeout);

  // ✅ Si falla, prueba los fallbacks de tu R2 en paralelo
  if (!res) {
    const fallbacks = fallbackURLs(pathname);
    console.warn('[SW] Primaria falló, probando fallback:', pathname);
    const results = await Promise.all(fallbacks.map((u) => fastFetch(u, req, timeout)));
    res = results.find((r) => r !== null) || null;
  }

  if (!res) return new Response('', { status: 404 });

  if (!range && res.status === 200) {
    const cacheable = res.clone();
    event.waitUntil?.(cache.put(pathname, cacheable).then(() => scheduleTrimCache()).catch(() => {}));
  }
  if (range && res.status === 200) {
    console.warn('[SW] Range ignorado:', pathname);
  }
  return injectIsolation(res);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;

  if (isBatchPath(url.pathname)) {
    event.respondWith(new Response('', { status: 404 }));
    return;
  }
  if (isFrontend(url.pathname)) {
    event.respondWith((async () => {
      try {
        const res = await fetch(event.request);
        if (!res || res.type === 'opaque') return res;
        return injectIsolation(res);
      } catch (err) {
        const c = await caches.match(event.request);
        if (c) return injectIsolation(c);
        return injectIsolation(new Response('', { status: 504 }));
      }
    })());
    return;
  }
  event.respondWith(handleAsset(event));
});
