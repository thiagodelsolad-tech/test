/**
 * sw.js — Service Worker para GTA V Web Edition
 *
 * Estructura real en R2:
 *   - game.wasm, shaders/, *.js  → mirror/playgta5.com/b/8b0b5899ed/
 *   - assets del juego           → mirror/playgta5.com/data/common/data/
 *   - manifest/bootset           → raíz del bucket
 */

const R2_BASE = 'https://pub-a092af97260c44d9b24dcb93dbfbb9ef.r2.dev';

// Prefijos en R2
const PREFIX_BIN  = 'mirror/playgta5.com/b/8b0b5899ed'; // game.wasm, shaders/, *.js
const PREFIX_DATA = 'mirror/playgta5.com/data/common/data'; // assets del juego

const CACHE = 'gta5-v7';
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

const LOCAL_EXACT = new Set([
  '/', '/index.html', '/sw.js', '/CNAME', '/README.md',
  '/loader.js', '/game.js', '/wgpu_worker.js', '/io_worker.js', '/audio-worklet.js',
  '/chalet.woff', '/favicon.ico', '/robots.txt', '/google88b6175162f03564.html',
]);

function isFrontend(pathname) {
  if (LOCAL_EXACT.has(pathname)) return true;
  if (pathname.startsWith('/img/')) return true;
  if (pathname.startsWith('/.github/')) return true;
  return false;
}

// ============================================================
// CANDIDATOS EN R2
// ============================================================
function candidatesFor(localPath) {
  const list = [];

  // /game.wasm
  if (localPath === '/game.wasm') {
    list.push(PREFIX_BIN + '/game.wasm');
    list.push('game.wasm');
    list.push('x64/game.wasm');
    return list;
  }

  // /shaders/*
  if (localPath.startsWith('/shaders/')) {
    const rest = localPath.slice(9);
    list.push(PREFIX_BIN + '/shaders/' + rest);
    list.push('shaders/' + rest);
    list.push('common/shaders/' + rest);
    list.push('data/common/shaders/' + rest);
    return list;
  }

  // /data/manifest.json, /data/bootset.json, etc.
  // (el motor los pide con /data/ delante, y están en la raíz de R2)
  if (localPath === '/data/manifest.json' ||
      localPath === '/data/bootset.json' ||
      localPath === '/data/bootset_low.json') {
    const rest = localPath.slice(6); // quita "/data/"
    list.push(rest);                 // manifest.json (en la raíz)
    list.push('data/' + rest);
    return list;
  }

  // /data/mirror/* → assets del juego
  if (localPath.startsWith('/data/mirror/')) {
    const rest = localPath.slice(12); // quita "/data/mirror/"
    list.push(PREFIX_DATA + '/' + rest);                  // .../common/data/anim/...
    list.push('mirror/' + rest);                          // mirror/anim/...
    list.push(PREFIX_DATA + '/mirror/' + rest);
    list.push(rest);
    return list;
  }

  // /data/runtime/*
  if (localPath.startsWith('/data/runtime/')) {
    const rest = localPath.slice(13);
    list.push(PREFIX_BIN + '/runtime/' + rest);
    list.push('runtime/' + rest);
    list.push(rest);
    return list;
  }

  // /data/<cualquier cosa> (fallback)
  if (localPath.startsWith('/data/')) {
    const rest = localPath.slice(6);
    list.push(rest);
    list.push('data/' + rest);
    return list;
  }

  // Rutas desconocidas
  const rest = localPath.slice(1);
  list.push(rest);
  list.push(PREFIX_DATA + '/' + rest);
  list.push(PREFIX_BIN + '/' + rest);
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
  console.log('[SW] Instalado. Prefijos:', PREFIX_BIN, '|', PREFIX_DATA);
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
// TRIM DE CACHÉ
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

async function tryFetch(url, originalRequest) {
  try {
    const res = await fetch(url, {
      method: originalRequest.method,
      headers: originalRequest.headers,
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
    });
    return (res.ok || res.status === 206) ? res : null;
  } catch (e) {
    return null;
  }
}

async function handleAsset(event) {
  const req = event.request;
  const url = new URL(req.url);
  const cache = await caches.open(CACHE);

  const cached = await cache.match(req);
  if (cached) return injectIsolation(cached);

  // 1. Intenta local (GitHub Pages)
  const localRes = await tryFetch(url.origin + url.pathname, req);
  if (localRes) {
    console.log(`[SW] LOCAL: ${url.pathname}`);
    return injectIsolation(localRes);
  }

  // 2. Fallback a R2
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

  console.error(`[SW] ${url.pathname} → probé: ${candidates.join(' | ')}`);
  return new Response('Recurso no encontrado', {
    status: 404,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Content-Type': 'text/plain',
    },
  });
}

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
  if (e.data?.type === 'PING') e.source?.postMessage({ type: 'PONG', status: 'ready' });
});
