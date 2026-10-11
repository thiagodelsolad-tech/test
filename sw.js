/**
 * sw.js — v28
 * - Sirve Range requests desde Cache Storage (blob.slice) → 206 correcto
 * - Soporta montaje de audio packs (x64/audio/sfx/*.rpf)
 * - Cache bump a v28
 */

const R2_BASE     = 'https://cdn.apkprojects.xyz';
const PREFIX_ROOT = 'mirror/playgta5.com/data';
const PREFIX_BIN  = 'mirror/playgta5.com/b/8b0b5899ed';

const CACHE = 'gta5-v28';
const MAX_BYTES = 5 * 1024 * 1024 * 1024;   // 5 GB

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

function candidatesFor(localPath) {
  if (localPath === '/game.wasm') {
    return [
      `${PREFIX_BIN}/game.wasm`,
      `${PREFIX_ROOT}/game.wasm`,
      `mirror/playgta5.com/game.wasm`,
      `game.wasm`,
    ];
  }
  if (localPath.startsWith('/shaders/')) {
    const rest = localPath.slice(9);
    return [`${PREFIX_BIN}/shaders/${rest}`, `${PREFIX_ROOT}/shaders/${rest}`];
  }
  if (localPath === '/data/manifest.json')    return ['manifest.json', `${PREFIX_ROOT}/manifest.json`];
  if (localPath === '/data/bootset.json')     return ['bootset.json', `${PREFIX_ROOT}/bootset.json`];
  if (localPath === '/data/bootset_low.json') return ['bootset_low.json', `${PREFIX_ROOT}/bootset_low.json`];

  // ✅ FIX: RPF de audio y otros RPF
  if (localPath.startsWith('/game/')) {
    const rest = localPath.slice(6);
    return [
      `${PREFIX_ROOT}/${rest}`,
      `${PREFIX_ROOT}/game/${rest}`,
      `${PREFIX_BIN}/${rest}`,
    ];
  }
  if (localPath.startsWith('/data/')) {
    const rest = localPath.slice(6);
    const list = [
      `${PREFIX_ROOT}/${rest}`,
      `${PREFIX_ROOT}/common/data/${rest}`,
    ];
    if (rest.startsWith('x64/levels/gta5/')) {
      const after = rest.slice('x64/levels/gta5/'.length);
      const slash = after.indexOf('/');
      if (slash > 0) {
        const folder = after.slice(0, slash);
        const sub = after.slice(slash + 1);
        list.push(`${PREFIX_ROOT}/x64/levels/gta5/_${folder}/${sub}`);
      }
    }
    return list;
  }
  const rest = localPath.slice(1);
  return [`${PREFIX_ROOT}/${rest}`, `${PREFIX_BIN}/${rest}`];
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
    // ✅ No borramos la cache si es la actual. Solo las viejas.
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
    let total = 0;
    const sizes = [];
    for (const r of reqs) {
      const res = await c.match(r);
      if (!res) continue;
      const len = parseInt(res.headers.get('Content-Length') || '0', 10) || 0;
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
  } catch (e) {}
}

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

// ============================================================
// ✅ NUEVO: parsear Range header
//    Soporta: "bytes=X-Y", "bytes=X-", "bytes=-N"
// ============================================================
function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end   = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end === null) return null;
  if (start === null) {
    // "bytes=-N" → últimos N bytes
    start = Math.max(0, totalSize - end);
    end = totalSize - 1;
  } else if (end === null || end >= totalSize) {
    // "bytes=X-" → desde X hasta el final
    end = totalSize - 1;
  }
  if (start > end || start >= totalSize) return null;
  return { start, end };
}

// ============================================================
// ✅ NUEVO: Sirve un Range desde un blob cacheado
// ============================================================
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

// ============================================================
// Manejo de assets
// ============================================================
async function handleAsset(event) {
  const req = event.request;
  const url = new URL(req.url);
  const pathname = url.pathname;
  const range = req.headers.get('Range');

  const cache = await caches.open(CACHE);
  const cached = await cache.match(pathname);

  // ✅ Si está en caché y es una petición Range, servimos desde el blob
  if (cached && range) {
    try {
      const ranged = await serveRangeFromCache(cached, range);
      if (ranged) return injectIsolation(ranged);
    } catch (e) { /* fallback a red */ }
  }

  // ✅ Si está en caché y no es Range, devolvemos el cached entero
  if (cached && !range) return injectIsolation(cached);

  // Descarga de red
  const candidates = candidatesFor(pathname);
  if (!candidates.length) return new Response('', { status: 404 });

  const timeout = range ? TIMEOUT_RANGE
                : pathname.endsWith('.rpf') ? TIMEOUT_FULL
                : TIMEOUT_DEFAULT;

  const results = await Promise.all(
    candidates.map((c) => fastFetch(`${R2_BASE}/${c}`, req, timeout))
  );
  const res = results.find((r) => r !== null) || null;

  if (!res) return new Response('', { status: 404 });

  // ✅ Cachea solo respuestas 200 completas y sin Range
  if (!range && res.status === 200) {
    const cacheable = res.clone();
    event.waitUntil?.(
      cache.put(pathname, cacheable)
        .then(() => scheduleTrimCache())
        .catch(() => {})
    );
  }

  if (range && res.status === 200) {
    console.warn('[SW] Range ignorado por R2:', pathname);
  }

  return injectIsolation(res);
}

// ============================================================
// Fetch principal
// ============================================================
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
