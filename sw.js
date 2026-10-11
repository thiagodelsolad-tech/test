/**
 * sw.js — Service Worker para GTA V Web Edition
 */

const R2_BASE = 'https://gta-proxy.kitofree1221.workers.dev';

// Prefijos en R2
const PREFIX_BIN  = 'mirror/playgta5.com/b/8b0b5899ed';   // game.wasm, shaders/, *.js
const PREFIX_ROOT = 'mirror/playgta5.com';                // el resto (data/x64/audio/...)

const CACHE = 'gta5-v10';
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

const LOCAL_EXACT = new Set([
  '/', '/index.html', '/sw.js', '/CNAME', '/README.md',
  '/loader.js', '/game.js', '/wgpu_worker.js', '/io_worker.js', '/audio-worklet.js',
  '/chalet.woff', '/favicon.ico', '/robots.txt',
  '/google88b6175162f03564.html',
]);

function isFrontend(pathname) {
  if (LOCAL_EXACT.has(pathname)) return true;
  if (pathname.startsWith('/img/')) return true;
  if (pathname.startsWith('/.github/')) return true;
  return false;
}

// ============================================================
// CANDIDATOS
// ============================================================
function candidatesFor(localPath) {
  const list = [];

  // ---------- game.wasm ----------
  if (localPath === '/game.wasm') {
    list.push(`${PREFIX_BIN}/game.wasm`);
    list.push('game.wasm');
    list.push('x64/game.wasm');
    return list;
  }

  // ---------- shaders ----------
  if (localPath.startsWith('/shaders/')) {
    const rest = localPath.slice(9);
    list.push(`${PREFIX_BIN}/shaders/${rest}`);
    list.push(`shaders/${rest}`);
    list.push(`common/shaders/${rest}`);
    return list;
  }

  // ---------- manifest / bootset (en la RAÍZ del bucket) ----------
  if (localPath === '/data/manifest.json') {
    list.push('manifest.json');
    list.push(`${PREFIX_ROOT}/manifest.json`);
    return list;
  }
  if (localPath === '/data/bootset.json') {
    list.push('bootset.json');
    list.push(`${PREFIX_ROOT}/bootset.json`);
    return list;
  }
  if (localPath === '/data/bootset_low.json') {
    list.push('bootset_low.json');
    list.push(`${PREFIX_ROOT}/bootset_low.json`);
    return list;
  }

  // ---------- assets del juego (/data/...) ----------
  if (localPath.startsWith('/data/')) {
    const rest = localPath.slice(6);  // sin el "/data/" inicial
    // Ejemplo: "x64/audio/sfx/RADIO_01_CLASS_ROCK.rpf"

    // 1. Ruta más probable: mismo path que el motor, bajo PREFIX_ROOT
    list.push(`${PREFIX_ROOT}/data/${rest}`);

    // 2. Sin el "/data/" extra (por si en R2 quedó aplanado)
    list.push(`${PREFIX_ROOT}/${rest}`);

    // 3. Raíz del bucket directamente
    list.push(`data/${rest}`);
    list.push(rest);

    // 4. Fallbacks por si el path tenía prefijos raros
    list.push(`${PREFIX_ROOT}/data/common/data/${rest}`);
    list.push(`mirror/${rest}`);

    return list;
  }

  // ---------- rutas sin prefijo conocido ----------
  const rest = localPath.slice(1);
  list.push(`${PREFIX_ROOT}/${rest}`);
  list.push(`${PREFIX_BIN}/${rest}`);
  list.push(rest);
  return list;
}

// ============================================================
// AISLAMIENTO CROSS-ORIGIN
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
  console.log('[SW] Instalado. Base:', R2_BASE);
  console.log('[SW] PREFIX_BIN:', PREFIX_BIN);
  console.log('[SW] PREFIX_ROOT:', PREFIX_ROOT);
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
  } catch (e) { console.warn('[SW] trimCache:', e); }
}

// ============================================================
// FETCH CON TIMEOUT
// ============================================================
async function tryFetch(url, originalRequest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: originalRequest.method,
      headers: { 'Range': originalRequest.headers.get('Range') || '' },
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);
    return (res.ok || res.status === 206) ? res : null;
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

// ============================================================
// HANDLER DE ASSETS
// ============================================================
async function handleAsset(event) {
  const req = event.request;
  const url = new URL(req.url);
  const cache = await caches.open(CACHE);

  const cached = await cache.match(req);
  if (cached) return injectIsolation(cached);

  const localRes = await tryFetch(url.origin + url.pathname, req);
  if (localRes) {
    console.log(`[SW] LOCAL: ${url.pathname}`);
    return injectIsolation(localRes);
  }

  const candidates = candidatesFor(url.pathname);
  for (let i = 0; i < candidates.length; i++) {
    const path = candidates[i];
    const r2Url = R2_BASE + '/' + path;
    const r2Res = await tryFetch(r2Url, req);
    if (r2Res) {
      console.log(`[SW] R2 OK (${i}): ${path}`);
      if (r2Res.status === 200) {
        cache.put(req, r2Res.clone()).then(trimCache).catch(() => {});
      }
      return injectIsolation(r2Res);
    }
  }

  console.error(`[SW] 404: ${url.pathname}`);
  console.error(`[SW]    Probé: ${candidates.join(' | ')}`);
  return new Response(`No encontrado: ${url.pathname}`, {
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

  if (isFrontend(url.pathname)) {
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

  event.respondWith(handleAsset(event));
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'PING') e.source?.postMessage({ type: 'PONG' });
});
