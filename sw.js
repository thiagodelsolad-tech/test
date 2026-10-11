/**
 * sw.js — Service Worker para GTA V Web Edition
 * 
 * IMPORTANTE: los archivos en R2 están bajo un prefijo. Si los mueves,
 * solo cambia R2_PREFIX aquí abajo.
 */

const R2_BASE_URL = 'https://pub-a092af97260c44d9b24dcb93dbfbb9ef.r2.dev';

// Prefijo donde están game.wasm, shaders/ y el resto en R2
const R2_PREFIX = 'mirror/playgta5.com/b/8b0b5899ed';

const CACHE = 'gta5-v5';
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

// Candidatos en R2: se prueban en orden con el prefijo y sin el
function candidatesFor(localPath) {
  const paths = [];
  let inner = null;

  if (localPath === '/game.wasm') {
    inner = ['game.wasm', 'x64/game.wasm'];
  } else if (localPath.startsWith('/shaders/')) {
    const rest = localPath.slice(9);
    inner = ['shaders/' + rest, 'common/shaders/' + rest];
  } else if (localPath.startsWith('/data/')) {
    const rest = localPath.slice(6);
    inner = [rest, 'data/' + rest];
  } else if (localPath.startsWith('/mirror/') || localPath.startsWith('/runtime/')) {
    inner = [localPath.slice(1)];
  } else if (localPath.startsWith('/x64/') || localPath.startsWith('/common/')) {
    inner = [localPath.slice(1)];
  } else {
    // Ruta desconocida: prueba tal cual
    inner = [localPath.slice(1)];
  }

  // Primero con el prefijo (donde TÚ los subiste), luego sin él
  for (const p of inner) {
    paths.push(R2_PREFIX + '/' + p);       // mirror/playgta5.com/b/8b0b5899ed/game.wasm
    paths.push(p);                          // game.wasm (por si algún día los mueves)
  }
  return paths;
}

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

self.addEventListener('install', () => {
  self.skipWaiting();
  console.log('[SW] Instalado. Prefijo R2:', R2_PREFIX);
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

  // 1. Cache-First
  const cached = await cache.match(req);
  if (cached) return injectIsolation(cached);

  // 2. Local primero (GitHub Pages)
  const localRes = await tryFetch(url.origin + url.pathname, req);
  if (localRes) {
    console.log(`[SW] LOCAL: ${url.pathname}`);
    return injectIsolation(localRes);
  }

  // 3. Fallback a R2 (con prefijo y sin él)
  const candidates = candidatesFor(url.pathname);
  for (let i = 0; i < candidates.length; i++) {
    const path = candidates[i];
    const r2Url = R2_BASE_URL + '/' + path;
    const r2Res = await tryFetch(r2Url, req);
    if (r2Res) {
      console.log(`[SW] R2 OK: ${path}`);
      if (r2Res.status === 200) {
        cache.put(req, r2Res.clone()).then(trimCache).catch(() => {});
      }
      return injectIsolation(r2Res);
    }
  }

  console.error(`[SW] No encontrado: ${url.pathname}`);
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
