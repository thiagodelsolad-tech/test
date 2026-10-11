/**
 * sw.js — Service Worker para GTA V Web Edition
 * 
 * Reglas de mapeo:
 *   /data/x64/levels/...  → mirror/playgta5.com/data/common/data/levels/...
 *   /data/x64/audio/...   → mirror/playgta5.com/data/x64/audio/...  (o common/data/audio/)
 *   /data/common/...      → mirror/playgta5.com/data/common/...
 *   /game.wasm            → mirror/playgta5.com/b/8b0b5899ed/game.wasm
 *   /shaders/...          → mirror/playgta5.com/b/8b0b5899ed/shaders/...
 */

const R2_BASE = 'https://gta-proxy.kitofree1221.workers.dev';
const PREFIX_ROOT = 'mirror/playgta5.com/data';           // raíz de assets (levels, maps, audio...)
const PREFIX_BIN  = 'mirror/playgta5.com/b/8b0b5899ed';   // game.wasm y shaders

const CACHE = 'gta5-v12';
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

const LOCAL_EXACT = new Set([
  '/', '/index.html', '/sw.js', '/CNAME', '/README.md',
  '/loader.js', '/game.js', '/wgpu_worker.js', '/io_worker.js', '/audio-worklet.js',
  '/chalet.woff', '/favicon.ico', '/robots.txt',
  '/google88b6175162f03564.html',
]);

function isFrontend(p) {
  if (LOCAL_EXACT.has(p)) return true;
  if (p.startsWith('/img/')) return true;
  if (p.startsWith('/.github/')) return true;
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
    return list;
  }

  // ---------- shaders ----------
  if (localPath.startsWith('/shaders/')) {
    const rest = localPath.slice(9);
    list.push(`${PREFIX_BIN}/shaders/${rest}`);
    list.push(`shaders/${rest}`);
    return list;
  }

  // ---------- manifest / bootset (raíz del bucket) ----------
  if (localPath === '/data/manifest.json') { list.push('manifest.json'); return list; }
  if (localPath === '/data/bootset.json') { list.push('bootset.json'); return list; }
  if (localPath === '/data/bootset_low.json') { list.push('bootset_low.json'); return list; }

  // ---------- assets del juego (/data/...) ----------
  if (localPath.startsWith('/data/')) {
    const rest = localPath.slice(6);  // quita "/data/"
    // Ejemplos:
    //   rest = "x64/levels/gta5/citye/downtown_01/fwy_01.rpf"
    //   rest = "x64/audio/sfx/RADIO_01_CLASS_ROCK.rpf"
    //   rest = "common/shaders/win32_40_cable.fxc"

    // 1. Ruta tal cual (funciona para audio, shaders comunes)
    list.push(`${PREFIX_ROOT}/${rest}`);

    // 2. Si empieza con "x64/", probar SIN el x64/ dentro de common/data/
    //    (aquí es donde están levels/, maps/, anim/, textures/, etc.)
    if (rest.startsWith('x64/')) {
      const noX64 = rest.slice(4);   // "levels/gta5/citye/downtown_01/fwy_01.rpf"
      list.push(`${PREFIX_ROOT}/common/data/${noX64}`);
      list.push(`${PREFIX_ROOT}/common/data/${rest}`);
    }

    // 3. Fallbacks genéricos
    list.push(`data/${rest}`);
    list.push(rest);

    return list;
  }

  // ---------- rutas sin prefijo ----------
  const rest = localPath.slice(1);
  list.push(`${PREFIX_ROOT}/${rest}`);
  list.push(`${PREFIX_BIN}/${rest}`);
  list.push(rest);
  return list;
}

// ============================================================
// AISLAMIENTO
// ============================================================
function injectIsolation(r) {
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

// ============================================================
// CICLO DE VIDA
// ============================================================
self.addEventListener('install', () => {
  self.skipWaiting();
  console.log('[SW] Instalado v12.');
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    console.log('[SW] Activo v12.');
  })());
});

async function trimCache() {
  try {
    const c = await caches.open(CACHE);
    const reqs = await c.keys();
    let total = 0; const sizes = [];
    for (const r of reqs) {
      const res = await c.match(r); if (!res) continue;
      const len = parseInt(res.headers.get('Content-Length') || '0', 10);
      sizes.push({ r, len }); total += len;
    }
    if (total <= MAX_BYTES) return;
    let removed = 0;
    for (const { r, len } of sizes) {
      if (total - removed <= MAX_BYTES * 0.8) break;
      await c.delete(r); removed += len;
    }
  } catch (e) {}
}

async function tryFetch(url, originalRequest) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: originalRequest.method,
      headers: { 'Range': originalRequest.headers.get('Range') || '' },
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return (res.ok || res.status === 206) ? res : null;
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

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

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;

  if (isFrontend(url.pathname)) {
    event.respondWith((async () => {
      try {
        const res = await fetch(event.request);
        if (!res || res.type === 'opaque') return res;
        return injectIsolation(res);
      } catch (err) {
        const c = await caches.match(event.request);
        if (c) return injectIsolation(c);
        throw err;
      }
    })());
    return;
  }

  event.respondWith(handleAsset(event));
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'PING') e.source?.postMessage({ type: 'PONG' });
});
