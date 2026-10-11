/**
 * sw.js — Service Worker para GTA V Web Edition
 * 
 * Flujo:
 *   Navegador → GitHub Pages (frontend) → sw.js intercepta →
 *   Cloudflare Worker (gta-proxy.kitofree1221.workers.dev) → R2
 * 
 * El Worker añade CORS + COOP/COEP. El SW cachea en disco y sirve local-first.
 */

// ============================================================
// CONFIGURACIÓN
// ============================================================
const R2_BASE = 'https://gta-proxy.kitofree1221.workers.dev';

// Prefijos en R2 (donde TÚ subiste los archivos)
const PREFIX_BIN  = 'mirror/playgta5.com/b/8b0b5899ed';       // game.wasm, shaders/, *.js, title/
const PREFIX_DATA = 'mirror/playgta5.com/data/common/data';   // anim/, audio/, levels/, etc.

const CACHE = 'gta5-v8';
const MAX_BYTES = 2 * 1024 * 1024 * 1024;  // 2 GB

// Rutas que viven SOLO en GitHub Pages (frontend estático)
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
// CANDIDATOS EN R2 (para cada ruta que pida el motor)
// ============================================================
function candidatesFor(localPath) {
  const list = [];

  // ---------- game.wasm ----------
  if (localPath === '/game.wasm') {
    list.push(`${PREFIX_BIN}/game.wasm`);   // mirror/playgta5.com/b/8b0b5899ed/game.wasm
    list.push('game.wasm');                 // raíz (fallback)
    list.push('x64/game.wasm');
    list.push('data/x64/game.wasm');
    return list;
  }

  // ---------- shaders ----------
  if (localPath.startsWith('/shaders/')) {
    const rest = localPath.slice(9);        // quita "/shaders/"
    list.push(`${PREFIX_BIN}/shaders/${rest}`);      // mirror/playgta5.com/b/8b0b5899ed/shaders/...
    list.push(`shaders/${rest}`);                    // raíz shaders/
    list.push(`common/shaders/${rest}`);
    list.push(`data/common/shaders/${rest}`);
    return list;
  }

  // ---------- manifest / bootset (raíz del bucket) ----------
  if (localPath === '/data/manifest.json') {
    list.push('manifest.json');             // raíz del bucket ✅
    list.push('data/manifest.json');
    return list;
  }
  if (localPath === '/data/bootset.json') {
    list.push('bootset.json');
    list.push('data/bootset.json');
    return list;
  }
  if (localPath === '/data/bootset_low.json') {
    list.push('bootset_low.json');
    list.push('data/bootset_low.json');
    return list;
  }

  // ---------- assets del juego (/data/mirror/...) ----------
  if (localPath.startsWith('/data/mirror/')) {
    const rest = localPath.slice(12);       // quita "/data/mirror/"
    list.push(`${PREFIX_DATA}/${rest}`);            // .../common/data/anim/...
    list.push(`mirror/${rest}`);                    // mirror/anim/...
    list.push(`${PREFIX_DATA}/mirror/${rest}`);
    list.push(rest);
    return list;
  }

  // ---------- runtime (/data/runtime/...) ----------
  if (localPath.startsWith('/data/runtime/')) {
    const rest = localPath.slice(13);       // quita "/data/runtime/"
    list.push(`${PREFIX_BIN}/runtime/${rest}`);
    list.push(`runtime/${rest}`);
    list.push(rest);
    return list;
  }

  // ---------- cualquier otra cosa bajo /data/ ----------
  if (localPath.startsWith('/data/')) {
    const rest = localPath.slice(6);        // quita "/data/"
    list.push(rest);
    list.push(`data/${rest}`);
    list.push(`${PREFIX_BIN}/${rest}`);
    list.push(`${PREFIX_DATA}/${rest}`);
    return list;
  }

  // ---------- rutas sin prefijo conocido ----------
  const rest = localPath.slice(1);
  list.push(`${PREFIX_BIN}/${rest}`);
  list.push(`${PREFIX_DATA}/${rest}`);
  list.push(rest);
  return list;
}

// ============================================================
// INYECCIÓN DE AISLAMIENTO CROSS-ORIGIN
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
  console.log('[SW] PREFIX_DATA:', PREFIX_DATA);
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
      console.log('[SW] Activo y controlando.');
    })()
  );
});

// ============================================================
// RECORTE DE CACHÉ (LRU aproximado)
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
    console.log(`[SW] Caché recortada: ${(removed / 1048576).toFixed(1)} MB liberados.`);
  } catch (e) {
    console.warn('[SW] trimCache:', e);
  }
}

// ============================================================
// FETCH CON TIMEOUT + RETRY
// ============================================================
async function tryFetch(url, originalRequest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000); // 30s timeout
  try {
    const res = await fetch(url, {
      method: originalRequest.method,
      headers: {
        'Range': originalRequest.headers.get('Range') || '',
      },
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
// HANDLER PRINCIPAL DE ASSETS (local-first → R2)
// ============================================================
async function handleAsset(event) {
  const req = event.request;
  const url = new URL(req.url);
  const cache = await caches.open(CACHE);

  // 1. Cache-First (disco del jugador)
  const cached = await cache.match(req);
  if (cached) {
    return injectIsolation(cached);
  }

  // 2. Intenta local (GitHub Pages) primero
  const localRes = await tryFetch(url.origin + url.pathname, req);
  if (localRes) {
    console.log(`[SW] LOCAL: ${url.pathname}`);
    return injectIsolation(localRes);
  }

  // 3. Fallback a R2 (prueba todos los candidatos)
  const candidates = candidatesFor(url.pathname);
  for (let i = 0; i < candidates.length; i++) {
    const path = candidates[i];
    const r2Url = R2_BASE + '/' + path;
    const r2Res = await tryFetch(r2Url, req);
    if (r2Res) {
      console.log(`[SW] R2 OK (${i}): ${path}`);
      // Solo cachea respuestas completas (no fragmentos 206)
      if (r2Res.status === 200) {
        cache.put(req, r2Res.clone()).then(trimCache).catch(() => {});
      }
      return injectIsolation(r2Res);
    }
  }

  // 4. Ningún candidato funcionó
  console.error(`[SW] 404: ${url.pathname}`);
  console.error(`[SW]    Probé: ${candidates.join(' | ')}`);
  return new Response(
    `No encontrado: ${url.pathname}\nProbé:\n- ${candidates.join('\n- ')}`,
    {
      status: 404,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Content-Type': 'text/plain',
      },
    }
  );
}

// ============================================================
// FETCH PRINCIPAL
// ============================================================
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Solo intercepta peticiones del mismo origen
  if (url.origin !== self.location.origin) return;

  // Solo GET y HEAD
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;

  // Evita error de only-if-cached
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;

  // ----- Rutas del frontend (GitHub Pages): sirve local con COOP/COEP -----
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

  // ----- Todo lo demás: assets del motor, con fallback a R2 -----
  event.respondWith(handleAsset(event));
});

// ============================================================
// MENSAJES (PING/PONG para debugging)
// ============================================================
self.addEventListener('message', (e) => {
  if (e.data?.type === 'PING') {
    e.source?.postMessage({ type: 'PONG', status: 'ready' });
  }
});
