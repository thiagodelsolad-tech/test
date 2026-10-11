/**
 * ============================================================
 * sw.js — Service Worker para GTA V Web Edition
 * Versión: v15 (final)
 * ============================================================
 *
 * Arquitectura:
 *   Navegador → GitHub Pages (frontend) → sw.js intercepta →
 *   Cloudflare Worker (gta-proxy) → R2
 *
 * Mapeo de rutas del motor → R2:
 *   /game.wasm                          → PREFIX_BIN/game.wasm
 *   /shaders/...                        → PREFIX_BIN/shaders/...
 *   /data/manifest.json                 → manifest.json (raíz)
 *   /data/bootset.json                  → bootset.json (raíz)
 *   /data/bootset_low.json              → bootset_low.json (raíz)
 *   /data/x64/audio/...                 → PREFIX_ROOT/x64/audio/...
 *   /data/x64/levels/gta5/citye/...     → PREFIX_ROOT/x64/levels/gta5/_citye/... (con guion)
 *   /data/x64/levels/gta5/_citye/...    → directo
 *   /data/common/data/gameconfig.xml    → PREFIX_ROOT/common/data/gameconfig.xml
 *   /data/batchc/*                      → 404 rápido (io_worker salta a fallback)
 * ============================================================
 */

// ============================================================
// CONFIGURACIÓN
// ============================================================
const R2_BASE      = 'https://gta-proxy.kitofree1221.workers.dev';
const PREFIX_ROOT  = 'mirror/playgta5.com/data';
const PREFIX_BIN   = 'mirror/playgta5.com/b/8b0b5899ed';

const CACHE        = 'gta5-v15';
const MAX_BYTES    = 2 * 1024 * 1024 * 1024;   // 2 GB
const FETCH_TIMEOUT = 30000;                    // 30 s

// Rutas estáticas servidas por GitHub Pages (frontend)
const LOCAL_EXACT = new Set([
  '/', '/index.html', '/sw.js', '/CNAME', '/README.md',
  '/loader.js', '/game.js', '/wgpu_worker.js', '/io_worker.js', '/audio-worklet.js',
  '/chalet.woff', '/favicon.ico', '/robots.txt',
  '/google88b6175162f03564.html',
]);

// ============================================================
// UTILIDADES
// ============================================================
function isFrontend(pathname) {
  if (LOCAL_EXACT.has(pathname)) return true;
  if (pathname.startsWith('/img/')) return true;
  if (pathname.startsWith('/.github/')) return true;
  return false;
}

function isBatchPath(pathname) {
  // Rutas del io_worker que no existen en R2: fallar rápido para que use el fallback
  if (pathname.startsWith('/data/batchc/')) return true;
  if (pathname === '/data/batch') return true;
  if (pathname.startsWith('/data/batch?')) return true;
  return false;
}

// ============================================================
// CANDIDATOS POR RUTA
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
    list.push(`common/shaders/${rest}`);
    return list;
  }

  // ---------- manifest / bootset (en la raíz del bucket) ----------
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

  // ---------- assets bajo /data/ ----------
  if (localPath.startsWith('/data/')) {
    const rest = localPath.slice(6);   // sin el "/data/" inicial

    // 1. Ruta directa (funciona para audio, streaming, script, etc.)
    list.push(`${PREFIX_ROOT}/${rest}`);

    // 2. Fallback common/data/ — necesario para gameconfig.xml, default.xml,
    //    timecycle.xml, camera.xml, etc. (configs del motor)
    list.push(`${PREFIX_ROOT}/common/data/${rest}`);

    // 3. Carpetas de levels con guion bajo:
    //    el motor pide "citye/...", "hills/...", "prologue/...", pero en R2 son
    //    "_citye/...", "_hills/...", "_prologue/..."
    if (rest.startsWith('x64/levels/gta5/')) {
      const after = rest.slice('x64/levels/gta5/'.length);
      const slash = after.indexOf('/');
      if (slash > 0) {
        const folder = after.slice(0, slash);
        const sub = after.slice(slash + 1);
        // Variante con guion bajo
        list.push(`${PREFIX_ROOT}/x64/levels/gta5/_${folder}/${sub}`);
        // Variante en common/data/ con guion bajo
        list.push(`${PREFIX_ROOT}/common/data/x64/levels/gta5/_${folder}/${sub}`);
      }
    }

    // 4. Fallbacks finales por si el asset está en otra estructura
    list.push(`data/${rest}`);
    list.push(rest);
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
// INYECCIÓN DE CABECERAS COOP/COEP
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
  console.log('[SW] Instalado v15.');
  console.log('[SW]   R2_BASE:', R2_BASE);
  console.log('[SW]   PREFIX_ROOT:', PREFIX_ROOT);
  console.log('[SW]   PREFIX_BIN:', PREFIX_BIN);
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    console.log('[SW] Activo v15.');
  })());
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
    console.log(`[SW] Caché recortada: ${(removed / 1048576).toFixed(1)} MB.`);
  } catch (e) {
    console.warn('[SW] trimCache:', e);
  }
}

// ============================================================
// FETCH CON TIMEOUT
// ============================================================
async function tryFetch(url, originalRequest) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: originalRequest.method,
      headers: {
        'Range': originalRequest.headers.get('Range') || '',
      },
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

// ============================================================
// HANDLER DE ASSETS
// ============================================================
async function handleAsset(event) {
  const req = event.request;
  const url = new URL(req.url);
  const cache = await caches.open(CACHE);

  // 1. Cache-First
  const cached = await cache.match(req);
  if (cached) {
    return injectIsolation(cached);
  }

  // 2. Intenta local (GitHub Pages)
  const localRes = await tryFetch(url.origin + url.pathname, req);
  if (localRes) {
    console.log(`[SW] LOCAL: ${url.pathname}`);
    return injectIsolation(localRes);
  }

  // 3. Fallback a R2 (vía Worker), probando candidatos en orden
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

  // 4. Nada funcionó — 404 silencioso (menos spam en consola)
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

  // Ignora peticiones a otros orígenes
  if (url.origin !== self.location.origin) return;

  // Solo GET/HEAD
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;

  // Evita el error "only-if-cached"
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;

  // Bypass rápido de batchc/batch (no existen en R2)
  if (isBatchPath(url.pathname)) {
    event.respondWith(new Response('', { status: 404 }));
    return;
  }

  // Frontend estático (GitHub Pages) — sirve con COOP/COEP
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

  // Todo lo demás → assets con fallback a R2
  event.respondWith(handleAsset(event));
});

// ============================================================
// MENSAJES (PING/PONG)
// ============================================================
self.addEventListener('message', (e) => {
  if (e.data?.type === 'PING') {
    e.source?.postMessage({ type: 'PONG', status: 'ready' });
  }
});
