/**
 * sw.js — Service Worker GTA V Web Edition
 * v24 — CDN directo + fix Range header
 */

const R2_BASE     = 'https://cdn.apkprojects.xyz';
const PREFIX_ROOT = 'mirror/playgta5.com/data';
const PREFIX_BIN  = 'mirror/playgta5.com/b/8b0b5899ed';

const CACHE       = 'gta5-v24';
const MAX_BYTES   = 2 * 1024 * 1024 * 1024;
const FETCH_TIMEOUT = 30000;

// ============================================================
// Rutas servidas localmente por GitHub Pages (NO se proxean)
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
  // game.wasm → R2
  if (localPath === '/game.wasm') {
    return [`${PREFIX_BIN}/game.wasm`];
  }

  // shaders → R2
  if (localPath.startsWith('/shaders/')) {
    const rest = localPath.slice(9);
    return [`${PREFIX_BIN}/shaders/${rest}`];
  }

  // manifest / bootset en la raíz del bucket
  if (localPath === '/data/manifest.json')    return ['manifest.json'];
  if (localPath === '/data/bootset.json')     return ['bootset.json'];
  if (localPath === '/data/bootset_low.json') return ['bootset_low.json'];

  // assets del motor bajo /data/
  if (localPath.startsWith('/data/')) {
    const rest = localPath.slice(6);
    const list = [`${PREFIX_ROOT}/${rest}`, `${PREFIX_ROOT}/common/data/${rest}`];

    // levels con guion bajo (_citye, _hills, _prologue)
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

  // cualquier otra ruta
  const rest = localPath.slice(1);
  return [`${PREFIX_ROOT}/${rest}`, `${PREFIX_BIN}/${rest}`];
}

// ============================================================
// Cabeceras COOP/COEP (para SharedArrayBuffer + WebGPU)
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
    // Limpia cachés antiguas
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    // Pre-descarga el bootset en background
    prefetchBootset();
  })());
});

// ============================================================
// Prefetch del bootset en background (opcional, acelera cargas)
// ============================================================
async function prefetchBootset() {
  try {
    const cache = await caches.open(CACHE);
    const done = await cache.match('/__bootset_done__');
    if (done) return;

    const res = await fetch(`${R2_BASE}/bootset.json`);
    if (!res.ok) return;

    const entries = await res.json();
    const PAR = 16;
    let i = 0;

    const worker = async () => {
      while (i < entries.length) {
        const entry = entries[i++];
        const path = entry[0];
        const url = `${R2_BASE}/${PREFIX_ROOT}/${path}`;
        const key = new Request(`/data/${path}`);
        try {
          if (await cache.match(key)) continue;
          const r = await fetch(url);
          if (r.ok) await cache.put(key, r);
        } catch (e) {}
      }
    };

    await Promise.all(Array.from({ length: PAR }, worker));
    await cache.put('/__bootset_done__', new Response('1'));
  } catch (e) {
    // silencioso
  }
}

// ============================================================
// Recorte de caché (máx 2 GB)
// ============================================================
async function trimCache() {
  try {
    const c = await caches.open(CACHE);
    const reqs = await c.keys();
    let total = 0;
    const sizes = [];
    for (const r of reqs) {
      const res = await c.match(r);
      if (!res) continue;
      const len = parseInt(res.headers.get('Content-Length') || '0', 10);
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
// FETCH CORREGIDO: no envía Range vacío (era el bug)
// ============================================================
function fastFetch(url, req, timeout = FETCH_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  // Solo añade Range si el navegador lo envió explícitamente
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
// Manejo de assets con fallback entre candidatos
// ============================================================
async function handleAsset(event) {
  const req = event.request;
  const url = new URL(req.url);
  const pathname = url.pathname;

  // 1. Cache-First
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return injectIsolation(cached);

  // 2. Prueba cada candidato en R2
  const candidates = candidatesFor(pathname);
  const first = `${R2_BASE}/${candidates[0]}`;
  let res = await fastFetch(first, req);

  // Si falla el primero, prueba el resto en paralelo
  if (!res && candidates.length > 1) {
    const rest = candidates.slice(1).map((p) => fastFetch(`${R2_BASE}/${p}`, req));
    const results = await Promise.all(rest);
    res = results.find((r) => r !== null) || null;
  }

  if (res) {
    // Guarda en caché local si es una respuesta completa
    if (res.status === 200) {
      const cacheable = res.clone();
      event.waitUntil?.(cache.put(req, cacheable).then(trimCache).catch(() => {}));
    }
    return injectIsolation(res);
  }

  // Nada funcionó
  return new Response('', { status: 404 });
}

// ============================================================
// Fetch principal
// ============================================================
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Solo intercepta peticiones del mismo origen
  if (url.origin !== self.location.origin) return;

  // Solo GET/HEAD
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;

  // Evita error "only-if-cached"
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;

  // Bloquea batchc (no existe en R2, devuelve 404 rápido)
  if (isBatchPath(url.pathname)) {
    event.respondWith(new Response('', { status: 404 }));
    return;
  }

  // Frontend estático (GitHub Pages): sirve con COOP/COEP
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

  // Resto de assets: CDN con caché
  event.respondWith(handleAsset(event));
});
