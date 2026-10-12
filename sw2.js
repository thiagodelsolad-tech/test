/**
 * sw2.js — v33
 * Range requests desde caché + fallback entre múltiples rutas R2.
 * Compatibilidad Linux/ext4: fallback case-insensitive + URLs seguras.
 *
 * v33: RENDIMIENTO
 *   - Fetch SECUENCIAL de candidatos (v31 los lanzaba todos en paralelo
 *     y duplicaba/triplicaba el ancho de banda en cada petición).
 *   - Caché de "candidato ganador" por prefijo: una vez que sabemos qué
 *     ruta responde para /data/*, /shaders/*, /b/8b0b5899ed/*, etc., los
 *     siguientes archivos del mismo prefijo van directos al ganador.
 *   - Caché de rangos: cada respuesta 206 se guarda como entrada con clave
 *     "__range__/path?r=bytes=..." y las repeticiones se sirven de disco.
 *   - Auto-slice: si R2 ignora el Range y devuelve 200 completo, se corta
 *     el slice localmente y se cachea el completo.
 */

const R2_BASE     = 'https://cdn.apkprojects.xyz';
const PREFIX_ROOT = 'mirror/playgta5.com/data';
const PREFIX_BIN  = 'mirror/playgta5.com/b/8b0b5899ed';

const CACHE = 'gta5-v33';
const MAX_BYTES = 5 * 1024 * 1024 * 1024;
const TIMEOUT_DEFAULT = 45000;
const TIMEOUT_RANGE   = 15000;
const TIMEOUT_FULL    = 300000;

// ext4 / S3 son case-sensitive. Duplicamos cada candidato en minúsculas.
const CASE_FALLBACK = true;

// Rutas que sirve el propio origin (frontend estático) — no van al CDN.
const FRONTEND = new Set([
  '/', '/index.html', '/sw2.js', '/sw.js', '/CNAME', '/README.md',
  '/favicon.ico', '/robots.txt', '/google88b6175162f03564.html',
]);

function isFrontend(p) {
  return FRONTEND.has(p) || p.startsWith('/img/') || p.startsWith('/.github/');
}
function isBatchPath(p) {
  return p.startsWith('/data/batchc/') || p === '/data/batch' || p.startsWith('/data/batch?');
}

function candidatesFor(localPath) {
  if (localPath.startsWith('/b/8b0b5899ed/')) {
    const rest = localPath.slice(1);
    return [
      `mirror/playgta5.com/${rest}`,
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
    const rest = localPath.slice(9);
    return [`${PREFIX_BIN}/shaders/${rest}`, `${PREFIX_ROOT}/shaders/${rest}`];
  }
  if (localPath === '/data/manifest.json')    return ['manifest.json', `${PREFIX_ROOT}/manifest.json`];
  if (localPath === '/data/bootset.json')     return ['bootset.json', `${PREFIX_ROOT}/bootset.json`];
  if (localPath === '/data/bootset_low.json') return ['bootset_low.json', `${PREFIX_ROOT}/bootset_low.json`];

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

function makeUrl(candidate) {
  try { return new URL(candidate, R2_BASE + '/').href; }
  catch (e) { return R2_BASE + '/' + candidate; }
}

// ── Prefijo corto de una ruta, para memorizar el candidato ganador ──
//   "/data/x64a.rpf"       -> "data"
//   "/shaders/index.json"  -> "shaders"
//   "/b/8b0b5899ed/x.js"   -> "b/8b0b5899ed"
function prefixOf(p) {
  if (p.startsWith('/b/8b0b5899ed/')) return 'b/8b0b5899ed';
  const seg = p.split('/').filter(Boolean)[0] || '';
  return seg;
}

// Candidato ganador por prefijo. Se rellena la 1ª vez y se reutiliza; si
// el ganador falla más tarde, se borra para que la próxima petición
// vuelva a probar la lista completa.
let PREFERRED = new Map();

function pickOrder(candidates, prefix) {
  const winner = PREFERRED.get(prefix);
  if (!winner || !candidates.includes(winner)) return candidates;
  return [winner, ...candidates.filter((c) => c !== winner)];
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
  // 'force-cache': deja que el HTTP cache del navegador sirva si R2 mandó
  // ETag/Cache-Control (no siempre lo hace, pero cuando lo hace ahorra red).
  return fetch(url, {
    method: 'GET',
    headers,
    mode: 'cors',
    credentials: 'omit',
    cache: 'force-cache',
    signal: ctrl.signal,
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
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers',
    'Content-Range, Content-Length, Accept-Ranges, ETag');
  return new Response(slice, { status: 206, statusText: 'Partial Content', headers });
}

// Clave sintética para guardar una respuesta de rango en el Cache API.
function rangeKey(origin, pathname, rangeHeader) {
  return new Request(`${origin}/__range__${pathname}?r=${encodeURIComponent(rangeHeader)}`);
}

// ── Núcleo: resolver una petición de asset ─────────────────────────────
async function handleAsset(event) {
  const req = event.request;
  const url = new URL(req.url);
  const pathname = url.pathname;
  const rangeHeader = req.headers.get('Range');
  const cache = await caches.open(CACHE);

  // ── 1) Rango: intenta servir desde la caché de rangos ──
  if (rangeHeader) {
    const rk = rangeKey(url.origin, pathname, rangeHeader);
    const hit = await cache.match(rk);
    if (hit) return injectIsolation(hit);
    // Si tenemos el archivo COMPLETO cacheado, recórtalo localmente.
    const full = await cache.match(pathname);
    if (full) {
      try {
        const ranged = await serveRangeFromCache(full, rangeHeader);
        if (ranged) return injectIsolation(ranged);
      } catch (e) {}
    }
  } else {
    // ── 2) Sin rango: caché completa ──
    const hit = await cache.match(pathname);
    if (hit) return injectIsolation(hit);
  }

  // ── 3) Miss: ir al CDN. Candidatos en ORDEN SECUENCIAL, no en paralelo ──
  const prefix = prefixOf(pathname);
  const candidates = withCaseFallback(candidatesFor(pathname));
  if (!candidates.length) return new Response('', { status: 404 });
  const ordered = pickOrder(candidates, prefix);

  const timeout = rangeHeader ? TIMEOUT_RANGE
                : pathname.endsWith('.rpf') ? TIMEOUT_FULL
                : TIMEOUT_DEFAULT;

  let res = null;
  let winner = null;
  for (const c of ordered) {
    res = await fastFetch(makeUrl(c), req, timeout);
    if (res) { winner = c; break; }
  }

  // Si el ganador memorizado falló, olvídalo (la próxima petición probará
  // la lista completa de nuevo).
  if (!res && PREFERRED.get(prefix)) PREFERRED.delete(prefix);
  if (!res) return new Response('', { status: 404 });

  PREFERRED.set(prefix, winner);

  // ── 4) Cachear según el tipo de respuesta ──

  // 4a) Petición de rango + R2 devolvió 206: guardar el slice con clave rango.
  if (rangeHeader && res.status === 206) {
    const slice = res.clone();
    event.waitUntil?.(cache.put(rangeKey(url.origin, pathname, rangeHeader), slice)
      .then(() => scheduleTrimCache()).catch(() => {}));
    return injectIsolation(res);
  }

  // 4b) Petición de rango pero R2 IGNORÓ el Range y devolvió 200 completo:
  //     corta el slice localmente, guarda el completo y devuelve solo el slice.
  if (rangeHeader && res.status === 200) {
    const full = res.clone();
    event.waitUntil?.(cache.put(pathname, full).then(() => scheduleTrimCache()).catch(() => {}));
    try {
      const ranged = await serveRangeFromCache(res, rangeHeader);
      if (ranged) return injectIsolation(ranged);
    } catch (e) {}
    return injectIsolation(res);
  }

  // 4c) Petición normal y 200: cachear el archivo completo.
  if (!rangeHeader && res.status === 200) {
    const cacheable = res.clone();
    event.waitUntil?.(cache.put(pathname, cacheable).then(() => scheduleTrimCache()).catch(() => {}));
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
