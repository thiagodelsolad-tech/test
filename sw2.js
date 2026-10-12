/**
 * sw2.js — v34
 * Range requests desde caché + fallback entre múltiples rutas R2.
 * Compatibilidad Linux/ext4: fallback case-insensitive + URLs seguras.
 *
 * v34 — FIX DE RENDIMIENTO:
 *   - Ya NO se hace slice en el miss con 200. Antes se descargaba el
 *     archivo DOS veces (una para caché, otra para el slice) → 0.0 MB/s
 *     con .rpf de 300 MB × 12 chunks concurrentes.
 *   - Cache de archivo completo: el primer miss guarda el fichero entero,
 *     las siguientes peticiones de rango se sirven de disco instantáneas.
 *   - Cache de slices 206: cada slice de R2 se guarda con clave
 *     "__range__/path?r=..." para no repetir red.
 *   - 'cache: default' (no 'force-cache') para no meter al HTTP cache del
 *     navegador en medio (era otra fuente de respuestas duplicadas).
 *   - Los candidatos fallidos se memorizan por prefijo solo cuando ACIERTAN.
 */

const R2_BASE     = 'https://cdn.apkprojects.xyz';
const PREFIX_ROOT = 'mirror/playgta5.com/data';
const PREFIX_BIN  = 'mirror/playgta5.com/b/8b0b5899ed';

const CACHE = 'gta5-v34';
const MAX_BYTES = 5 * 1024 * 1024 * 1024;
const TIMEOUT_DEFAULT = 45000;
const TIMEOUT_RANGE   = 15000;
const TIMEOUT_FULL    = 300000;

const CASE_FALLBACK = true;

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
    return [`mirror/playgta5.com/${rest}`, rest];
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

function prefixOf(p) {
  if (p.startsWith('/b/8b0b5899ed/')) return 'b/8b0b5899ed';
  const seg = p.split('/').filter(Boolean)[0] || '';
  return seg;
}

// Candidato ganador por prefijo. Solo se memoriza cuando ACIERTA.
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
  // cache: 'default' — dejamos al navegador gestionar el HTTP cache.
  // Antes era 'force-cache' y en SW se comportaba de forma rara con rangos.
  return fetch(url, {
    method: 'GET',
    headers,
    mode: 'cors',
    credentials: 'omit',
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

function rangeKey(origin, pathname, rangeHeader) {
  return new Request(`${origin}/__range__${pathname}?r=${encodeURIComponent(rangeHeader)}`);
}

// ── Núcleo: resolver un asset ──────────────────────────────────────────
async function handleAsset(event) {
  const req = event.request;
  const url = new URL(req.url);
  const pathname = url.pathname;
  const rangeHeader = req.headers.get('Range');
  const cache = await caches.open(CACHE);

  // ── 1) Archivo COMPLETO en caché → cualquier petición se sirve de aquí ──
  const full = await cache.match(pathname);
  if (full) {
    if (rangeHeader) {
      try {
        const ranged = await serveRangeFromCache(full, rangeHeader);
        if (ranged) return injectIsolation(ranged);
      } catch (e) {}
    } else {
      return injectIsolation(full);
    }
  }

  // ── 2) Slice 206 cacheado previamente ──
  if (rangeHeader) {
    const hit = await cache.match(rangeKey(url.origin, pathname, rangeHeader));
    if (hit) return injectIsolation(hit);
  }

  // ── 3) Miss: al CDN. Candidatos en orden, pero paramos al primero válido.
  const prefix = prefixOf(pathname);
  const candidates = withCaseFallback(candidatesFor(pathname));
  if (!candidates.length) return new Response('', { status: 404 });
  const ordered = pickOrder(candidates, prefix);

  const timeout = rangeHeader ? TIMEOUT_RANGE
                : pathname.endsWith('.rpf') ? TIMEOUT_FULL
                : TIMEOUT_DEFAULT;

  let res = null, winner = null;
  for (const c of ordered) {
    res = await fastFetch(makeUrl(c), req, timeout);
    if (res) { winner = c; break; }
  }
  if (!res) {
    if (PREFERRED.get(prefix)) PREFERRED.delete(prefix);
    return new Response('', { status: 404 });
  }
  PREFERRED.set(prefix, winner);

  // ── 4) Estrategia de caché según lo que devolvió R2 ──

  // 4a) Range request + R2 respeta el Range (206): cachear el slice.
  if (rangeHeader && res.status === 206) {
    const slice = res.clone();
    event.waitUntil?.(cache.put(rangeKey(url.origin, pathname, rangeHeader), slice)
      .then(() => scheduleTrimCache()).catch(() => {}));
    return injectIsolation(res);
  }

  // 4b) Range request pero R2 IGNORÓ el Range (200 con archivo completo):
  //     ⚠️ AQUÍ ESTABA EL BUG DE 0.0 MB/s. Antes hacíamos res.clone() para
  //     cachear Y ADEMÁS serveRangeFromCache(res) → dos descargas completas.
  //     Ahora: cacheamos el fichero entero (UNA descarga) y devolvemos el
  //     200 tal cual. El io_worker / loader.js ya sabe leer lo que necesita
  //     de un 200 completo. Las siguientes peticiones de rango para el
  //     mismo path se servirán ya desde esta caché, sin tocar red.
  if (rangeHeader && res.status === 200) {
    const cacheable = res.clone();
    event.waitUntil?.(cache.put(pathname, cacheable).then(() => scheduleTrimCache()).catch(() => {}));
    return injectIsolation(res);
  }

  // 4c) Petición normal (sin rango) + 200 completo: cachear el fichero entero.
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
