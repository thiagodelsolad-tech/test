
/**
 * sw.js — Service Worker GTA V Web Edition
 * v16 — Ultra optimizado
 */

const R2_BASE     = 'https://gta-proxy.kitofree1221.workers.dev';
const PREFIX_ROOT = 'mirror/playgta5.com/data';
const PREFIX_BIN  = 'mirror/playgta5.com/b/8b0b5899ed';

const CACHE       = 'gta5-v16';
const MAX_BYTES   = 2 * 1024 * 1024 * 1024;
const FETCH_TIMEOUT = 30000;

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

function candidatesFor(localPath) {
  if (localPath === '/game.wasm') return [`${PREFIX_BIN}/game.wasm`];
  if (localPath.startsWith('/shaders/')) {
    const rest = localPath.slice(9);
    return [`${PREFIX_BIN}/shaders/${rest}`];
  }
  if (localPath === '/data/manifest.json')    return ['manifest.json'];
  if (localPath === '/data/bootset.json')     return ['bootset.json'];
  if (localPath === '/data/bootset_low.json') return ['bootset_low.json'];
  if (localPath.startsWith('/data/')) {
    const rest = localPath.slice(6);
    const list = [`${PREFIX_ROOT}/${rest}`, `${PREFIX_ROOT}/common/data/${rest}`];
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

function injectIsolation(r) {
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    prefetchBootset();
  })());
});

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
  } catch (e) {}
}

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

function fastFetch(url, req, timeout = FETCH_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  return fetch(url, {
    method: 'GET',
    headers: { 'Range': req.headers.get('Range') || '' },
    mode: 'cors', credentials: 'omit', signal: ctrl.signal,
  }).then((r) => { clearTimeout(timer); return (r.ok || r.status === 206) ? r : null; })
    .catch(() => { clearTimeout(timer); return null; });
}

async function handleAsset(event) {
  const req = event.request;
  const url = new URL(req.url);
  const pathname = url.pathname;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return injectIsolation(cached);
  const candidates = candidatesFor(pathname);
  const first = `${R2_BASE}/${candidates[0]}`;
  let res = await fastFetch(first, req);
  if (!res && candidates.length > 1) {
    const rest = candidates.slice(1).map((p) => fastFetch(`${R2_BASE}/${p}`, req));
    const results = await Promise.all(rest);
    res = results.find((r) => r !== null) || null;
  }
  if (res) {
    if (res.status === 200) {
      const cacheable = res.clone();
      event.waitUntil?.(cache.put(req, cacheable).then(trimCache).catch(() => {}));
    }
    return injectIsolation(res);
  }
  return new Response('', { status: 404 });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;
  if (isBatchPath(url.pathname)) { event.respondWith(new Response('', { status: 404 })); return; }
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
