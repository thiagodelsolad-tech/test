/**
 * sw.js — Service Worker GTA V Web Edition
 * v25 — Fix crítico Range + /game/ + descarga más rápida
 */

const R2_BASE     = 'https://cdn.apkprojects.xyz';
const PREFIX_ROOT = 'mirror/playgta5.com/data';
const PREFIX_BIN  = 'mirror/playgta5.com/b/8b0b5899ed';

const CACHE       = 'gta5-v25';
const MAX_BYTES   = 2 * 1024 * 1024 * 1024;

// ✅ FIX: timeouts diferenciados
const TIMEOUT_DEFAULT = 45000;
const TIMEOUT_RANGE   = 15000;
const TIMEOUT_FULL    = 180000;

// ✅ NUEVO: paralelismo de prefetch del bootset (antes 16, ahora 32)
const PREFETCH_PAR = 32;

// ============================================================
// Rutas servidas localmente (NO se proxean)
// ============================================================
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
// Candidatos en R2 para cada ruta local
// ============================================================
function candidatesFor(localPath) {
  if (localPath === '/game.wasm') {
    return [`${PREFIX_BIN}/game.wasm`];
  }

  if (localPath.startsWith('/shaders/')) {
    const rest = localPath.slice(9);
    return [`${PREFIX_BIN}/shaders/${rest}`];
  }

  if (localPath === '/data/manifest.json')    return ['manifest.json'];
  if (localPath === '/data/bootset.json')     return ['bootset.json'];
  if (localPath === '/data/bootset_low.json') return ['bootset_low.json'];

  // ✅ FIX IMPORTANTE: RPF, update.rpf y DLC. El motor los pide como /game/...
  if (localPath.startsWith('/game/')) {
    const rest = localPath.slice(6); // quita "game/"
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

// ============================================================
// Cabeceras COOP/COEP
// ============================================================
function injectIsolation(r) {
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(r.body, {
    status: r.status,
    statusText: r.statusText,
    headers: h,
  });
}

// ============================================================
// Ciclo de vida
// ============================================================
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    prefetchBootset();
  })());
});

// ============================================================
// Prefetch del bootset en background — ✅ NUEVO: 32 conexiones paralelas
// ============================================================
async function prefetchBootset() {
  try {
    const cache = await caches.open(CACHE);
    const done = await cache.match('/__bootset_done_v25__');
    if (done) return;

    const res = await fetch(`${R2_BASE}/bootset.json`);
    if (!res.ok) return;

    const entries = await res.json();
    let i = 0;

    const worker = async () => {
      while (i < entries.length) {
        const entry = entries[i++];
        const path = Array.isArray(entry) ? entry[0] : entry;
        const url = `${R2_BASE}/${PREFIX_ROOT}/${path}`;
        const key = new Request(`/data/${path}`);
        try {
          if (await cache.match(key)) continue;
          const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
          if (r.ok) await cache.put(key, r);
        } catch (e) {}
      }
    };

    // ✅ NUEVO: 32 workers en paralelo en lugar de 16
    await Promise.all(Array.from({ length: PREFETCH_PAR }, worker));
    await cache.put('/__bootset_done_v25__', new Response('1'));
  } catch (e) {}
}

// ============================================================
// Recorte de caché
// ============================================================
let trimScheduled = false;
function scheduleTrimCache() {
  if (trimScheduled) return;
  trimScheduled = true;
  setTimeout(() => { trimScheduled = false; trimCache(); }, 5000);
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
      if (total - removed <= MAX_BYTES * 0.8) break;
      await c.delete(r);
      removed += len;
    }
  } catch (e) {}
}

// ============================================================
// Fetch con timeout configurable y Range preservado
// ============================================================
function fastFetch(url, req, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  const headers = {};
  const range = req.headers.get('Range');
  if (range) headers['Range'] = range;

  return fetch(url, {
    method: 'GET',
    headers,
    mode: 'cors',
    credentials: 'omit',
    signal: ctrl.signal,
  })
    .then((r) => {
      clearTimeout(timer);
      return (r.ok || r.status === 206) ? r : null;
    })
    .catch(() => {
      clearTimeout(timer);
      return null;
    });
}

// ============================================================
// Manejo de assets
// ✅ FIX PRINCIPAL: no servir el archivo entero a peticiones Range
// ============================================================
async function handleAsset(event) {
  const req = event.request;
  const url = new URL(req.url);
  const pathname = url.pathname;
  const hasRange = req.headers.has('Range');

  const cache = await caches.open(CACHE);

  // Cache-First solo sin Range
  if (!hasRange) {
    const cached = await cache.match(req);
    if (cached) return injectIsolation(cached);
  }

  const candidates = candidatesFor(pathname);
  if (!candidates.length) {
    return new Response('', { status: 404 });
  }

  const timeout = hasRange ? TIMEOUT_RANGE
                : pathname.endsWith('.rpf') ? TIMEOUT_FULL
                : TIMEOUT_DEFAULT;

  // Primer candidato
  let res = await fastFetch(`${R2_BASE}/${candidates[0]}`, req, timeout);

  // Fallback al resto en paralelo
  if (!res && candidates.length > 1) {
    const rest = candidates.slice(1).map((p) => fastFetch(`${R2_BASE}/${p}`, req, timeout));
    const results = await Promise.all(rest);
    res = results.find((r) => r !== null) || null;
  }

  if (!res) return new Response('', { status: 404 });

  // Cachea solo respuestas completas y sin Range
  if (!hasRange && res.status === 200) {
    const cacheable = res.clone();
    event.waitUntil?.(
      cache.put(req, cacheable)
        .then(() => scheduleTrimCache())
        .catch(() => {})
    );
  }

  if (hasRange && res.status === 200) {
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
