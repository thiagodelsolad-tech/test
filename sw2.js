/**
 * sw2.js — v32
 * Range requests desde caché + fallback entre múltiples rutas R2.
 * Compatibilidad Linux/ext4: fallback case-insensitive + URLs seguras.
 *
 * Sirve como pasarela transparente entre el navegador (que pide rutas del
 * origin: /loader.js, /data/*, /shaders/*, /game/*) y el CDN de R2
 * (https://cdn.apkprojects.xyz/mirror/playgta5.com/...).
 *
 * Rutas que reescribe hacia R2:
 *   /loader.js, /game.js, /wgpu_worker.js, /io_worker.js, /audio-worklet.js  →  <R2>/<PREFIX>/...
 *   /data/*      → mirror/playgta5.com/data/*
 *   /shaders/*   → mirror/playgta5.com/data/shaders/* (o b/8b0b5899ed/shaders/*)
 *   /game/*      → mirror/playgta5.com/data/game/*
 *   /game.wasm   → mirror/playgta5.com/b/8b0b5899ed/game.wasm
 *   /b/8b0b5899ed/* → mirror/playgta5.com/b/8b0b5899ed/*
 *
 * Rutas que sirve del propio origin (frontend estático):
 *   /, /index.html, /sw2.js, /favicon.ico, /robots.txt, /CNAME, /README.md
 */

const R2_BASE     = 'https://cdn.apkprojects.xyz';
const PREFIX_ROOT = 'mirror/playgta5.com/data';
const PREFIX_BIN  = 'mirror/playgta5.com/b/8b0b5899ed';

const CACHE = 'gta5-v32';
const MAX_BYTES = 5 * 1024 * 1024 * 1024;
const TIMEOUT_DEFAULT = 45000;
const TIMEOUT_RANGE   = 15000;
const TIMEOUT_FULL    = 300000;

// ext4 / S3 son case-sensitive. Duplicamos cada candidato en minúsculas.
// (Si tu mirror está perfectamente en minúsculas, pon false y ahorras fetches.)
const CASE_FALLBACK = true;

// Solo estas rutas se sirven del propio origin. Todo lo demás va al CDN.
const FRONTEND = new Set([
  '/', '/index.html', '/sw2.js', '/sw.js',
  '/CNAME', '/README.md',
  '/favicon.ico', '/robots.txt',
  '/google88b6175162f03564.html',
]);

function isFrontend(p) {
  return FRONTEND.has(p) || p.startsWith('/img/') || p.startsWith('/.github/');
}
function isBatchPath(p) {
  return p.startsWith('/data/batchc/') || p === '/data/batch' || p.startsWith('/data/batch?');
}

function candidatesFor(localPath) {
  // ── Build-specific: /b/8b0b5899ed/{loader,game,audio-worklet,...}.js, /b/8b0b5899ed/title/* ──
  if (localPath.startsWith('/b/8b0b5899ed/')) {
    const rest = localPath.slice(1);              // "b/8b0b5899ed/loader.js"
    return [
      `mirror/playgta5.com/${rest}`,              // mirror/playgta5.com/b/8b0b5899ed/loader.js
      rest,                                        // b/8b0b5899ed/loader.js
    ];
  }

  // ── Root-level engine files (los que pide el index con BASE='' y loader.js) ──
  if (localPath === '/loader.js' || localPath === '/game.js' ||
      localPath === '/wgpu_worker.js' || localPath === '/io_worker.js' ||
      localPath === '/audio-worklet.js') {
    const rest = localPath.slice(1);              // "loader.js"
    return [
      `${PREFIX_BIN}/${rest}`,                    // mirror/playgta5.com/b/8b0b5899ed/loader.js
      `mirror/playgta5.com/${rest}`,              // mirror/playgta5.com/loader.js
      rest,
    ];
  }

  if (localPath === '/game.wasm') {
    return [
      `${PREFIX_BIN}/game.wasm`,
      `${PREFIX_ROOT}/game.wasm`,
      `mirror/playgta5.com/game.wasm`,
      `game.wasm`,
    ];
  }

  if (localPath.startsWith('/shaders/')) {
    const rest = localPath.slice(9);              // "index.json"
    return [
      `${PREFIX_BIN}/shaders/${rest}`,            // mirror/playgta5.com/b/8b0b5899ed/shaders/index.json
      `${PREFIX_ROOT}/shaders/${rest}`,           // mirror/playgta5.com/data/shaders/index.json
      `mirror/playgta5.com/shaders/${rest}`,      // mirror/playgta5.com/shaders/index.json
    ];
  }

  if (localPath === '/data/manifest.json')    return ['manifest.json', `${PREFIX_ROOT}/manifest.json`];
  if (localPath === '/data/bootset.json')     return ['bootset.json', `${PREFIX_ROOT}/bootset.json`];
  if (localPath === '/data/bootset_low.json') return ['bootset_low.json', `${PREFIX_ROOT}/bootset_low.json`];

  if (localPath.startsWith('/game/')) {
    const rest = localPath.slice(6);              // "x64/levels/..."
    return [
      `${PREFIX_ROOT}/${rest}`,
      `${PREFIX_ROOT}/game/${rest}`,
      `${PREFIX_BIN}/${rest}`,
    ];
  }

  if (localPath.startsWith('/data/')) {
    const rest = localPath.slice(6);              // "x64a.rpf", "x64/levels/gta5/..."
    const list = [`${PREFIX_ROOT}/${rest}`, `${PREFIX_ROOT}/common/data/${rest}`];
    if (rest.startsWith('x64/levels/gta5/')) {
      const after = rest.slice('x64/levels/gta5/'.length);
      const slash = after.indexOf('/');
      if (slash > 0) {
        list.push(`${PREFIX_ROOT}/x64/levels/gta5/_${after.slice(0, slash)}/${after.slice(slash + 1)}`);
      }
    }
    return list;
  }

  const rest = localPath.slice(1);
  return [`${PREFIX_ROOT}/${rest}`, `${PREFIX_BIN}/${rest}`];
}

// ── Linux-friendly: duplica candidatos con su versión minúscula ──
function withCaseFallback(list) {
  if (!CASE_FALLBACK) return list;
  const out = [];
  for (const p of list) {
    out.push(p);
    const low = p.toLowerCase();
    if (low !== p) out.push(low);
  }
  return out;
}

// ── Construcción de URL segura (escapa #, ?, %, espacios) ──
function makeUrl(candidate) {
  try { return new URL(candidate, R2_BASE + '/').href; }
  catch (e) { return R2_BASE + '/' + candidate; }
}

function injectIsolation(r) {
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
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
  return fetch(url, { method: 'GET', headers, mode: 'cors', credentials: 'omit', signal: ctrl.signal })
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
  // Linux + nginx/Caddy: sin esto el player no ve los headers vía CORS
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers',
    'Content-Range, Content-Length, Accept-Ranges, ETag');
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

  const candidates = withCaseFallback(candidatesFor(pathname));
  if (!candidates.length) return new Response('', { status: 404 });

  const timeout = range ? TIMEOUT_RANGE
                : pathname.endsWith('.rpf') ? TIMEOUT_FULL
                : TIMEOUT_DEFAULT;

  // Prueba todos los candidatos en paralelo; el primero que responda gana.
  const results = await Promise.all(
    candidates.map((c) => fastFetch(makeUrl(c), req, timeout))
  );
  const res = results.find((r) => r !== null) || null;

  if (!res) return new Response('', { status: 404 });

  // Caché solo para respuestas completas (no rangos)
  if (!range && res.status === 200) {
    const cacheable = res.clone();
    event.waitUntil?.(cache.put(pathname, cacheable).then(() => scheduleTrimCache()).catch(() => {}));
  }
  if (range && res.status === 200) console.warn('[SW] Range ignorado por R2:', pathname);

  return injectIsolation(res);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;

  // Rutas de batch (no existen) → 404 inmediato
  if (isBatchPath(url.pathname)) {
    event.respondWith(new Response('', { status: 404 }));
    return;
  }

  // Frontend estático → pasa tal cual + aislamiento COOP/COEP
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

  // Todo lo demás (loader, data, shaders, game, b/*) → CDN
  event.respondWith(handleAsset(event));
});
