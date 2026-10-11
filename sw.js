/**
 * sw.js — Service Worker para GTA V Web Edition
 *
 * - Inyecta COOP/COEP/CORP (imprescindible para SharedArrayBuffer + WebGPU)
 * - Proxea a R2 los recursos pesados (wasm, shaders, data, mirror, runtime)
 * - Prueba varias rutas candidatas en R2 hasta encontrar la correcta (fallback automático)
 * - Cache-First en disco para cargas posteriores
 */

const R2_BASE_URL = 'https://r2.dev';
const CACHE = 'gta5-v3';
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

// ============================================================
// RUTAS LOCALES DEL FRONTEND (viven en GitHub Pages, no se proxean)
// ============================================================
const LOCAL_EXACT = new Set([
  '/', '/index.html', '/sw.js', '/CNAME', '/README.md',
  '/loader.js', '/game.js', '/wgpu_worker.js', '/io_worker.js', '/audio-worklet.js',
  '/chalet.woff', '/favicon.ico', '/robots.txt', '/google88b6175162f03564.html',
]);

function isLocal(pathname) {
  if (LOCAL_EXACT.has(pathname)) return true;
  if (pathname.startsWith('/img/')) return true;
  if (pathname.startsWith('/.github/')) return true;
  return false;
}

// ============================================================
// CANDIDATOS EN R2 (se prueban en orden hasta encontrar uno con 200)
// ============================================================
function candidatesFor(localPath) {
  // /data/manifest.json, /data/bootset.json, /data/mirror/... etc
  if (localPath.startsWith('/data/')) {
    const rest = localPath.slice(6); // quita "/data/"
    return [
      rest,                 // →  /manifest.json
      'data/' + rest,       // →  /data/manifest.json
    ];
  }

  // /shaders/index.json, /shaders/pack0.bin, /shaders/<hash>.wgsl
  if (localPath.startsWith('/shaders/')) {
    const rest = localPath.slice(9); // quita "/shaders/"
    return [
      'common/shaders/' + rest,       // →  /common/shaders/index.json
      'shaders/' + rest,              // →  /shaders/index.json
      'data/common/shaders/' + rest,  // →  /data/common/shaders/index.json
      'runtime/shaders/' + rest,      // →  /runtime/shaders/index.json
    ];
  }

  // /game.wasm
  if (localPath === '/game.wasm') {
    return [
      'x64/game.wasm',        // →  /x64/game.wasm
      'game.wasm',            // →  /game.wasm
      'data/x64/game.wasm',   // →  /data/x64/game.wasm
      'runtime/game.wasm',    // →  /runtime/game.wasm
    ];
  }

  // /mirror/..., /runtime/...
  if (localPath.startsWith('/mirror/') || localPath.startsWith('/runtime/')) {
    return [
      localPath.slice(1),            // →  /mirror/...
      'data' + localPath,            // →  /data/mirror/...
    ];
  }

  // /x64/..., /common/... (por si el motor los pide directos)
  if (localPath.startsWith('/x64/') || localPath.startsWith('/common/')) {
    return [
      localPath.slice(1),
      'data' + localPath,
    ];
  }

  return null;
}

// ============================================================
// AISLAMIENTO CROSS-ORIGIN (crítico para SharedArrayBuffer)
// ============================================================
function injectIsolation(response) {
  const h = new Headers(response.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h,
  });
}

// ============================================================
// CICLO DE VIDA
// ============================================================
self.addEventListener('install', () => {
  self.skipWaiting();
  console.log('[SW] Instalado.');
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
      console.log('[SW] Activo.');
    })()
  );
});

// ============================================================
// RECORTE DE CACHÉ
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
    console.log(`[SW] Caché recortada: ${(removed / 1048576).toFixed(1)} MB.`);
  } catch (e) { console.warn('[SW] trimCache:', e); }
}

// ============================================================
// PROXY CON FALLBACK AUTOMÁTICO + CACHE-FIRST
// ============================================================
async function handleProxy(event, candidates) {
  const req = event.request;
  const cache = await caches.open(CACHE);

  // 1. Cache-First
  const cached = await cache.match(req);
  if (cached) return injectIsolation(cached);

  // 2. Prueba cada candidato en R2 hasta que uno responda 200/206
  for (let i = 0; i < candidates.length; i++) {
    const path = candidates[i];
    const r2Url = R2_BASE_URL + '/' + path;
    try {
      const res = await fetch(r2Url, {
        method: req.method,
        headers: req.headers,
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
      });

      if (res.ok || res.status === 206) {
        if (i > 0) console.log(`[SW] Fallback OK: ${path}`);
        if (res.status === 200) {
          cache.put(req, res.clone()).then(trimCache).catch(() => {});
        }
        return injectIsolation(res);
      }
      // 404/403 → prueba el siguiente candidato
      console.log(`[SW] ${res.status} en ${path}, probando siguiente…`);
    } catch (err) {
      console.warn(`[SW] Error en ${path}:`, err.message);
    }
  }

  // Ningún candidato funcionó
  console.error(`[SW] Ningún candidato funcionó para ${req.url}`);
  return new Response('Recurso no encontrado en R2', {
    status: 404,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Content-Type': 'text/plain',
    },
  });
}

// ============================================================
// FETCH PRINCIPAL
// ============================================================
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;

  // Local (GitHub Pages): solo inyecta COOP/COEP
  if (isLocal(url.pathname)) {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(event.request);
          if (!res || res.type === 'opaque') return res;
          return injectIsolation(res);
        } catch (err) {
          const c = await caches.match(event.request);
          if (c) return injectIsolation(c);
          throw err;
        }
      })()
    );
    return;
  }

  // Intenta proxy a R2
  const candidates = candidatesFor(url.pathname);
  if (candidates) {
    event.respondWith(handleProxy(event, candidates));
  } else {
    // Ruta desconocida → la deja pasar (a GitHub Pages)
    event.respondWith(fetch(event.request));
  }
});

// ============================================================
// PING (para debugging)
// ============================================================
self.addEventListener('message', (e) => {
  if (e.data?.type === 'PING') e.source?.postMessage({ type: 'PONG', status: 'ready' });
});
