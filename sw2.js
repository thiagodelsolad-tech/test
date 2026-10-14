const CDN = 'https://gta.deloskiyt.pl';
const CACHE = 'gta5-v37';
const MAX_BYTES = 8 * 1024 * 1024 * 1024;
const FRONTEND = new Set(['/', '/index.html', '/sw2.js', '/sw.js', '/favicon.ico', '/robots.txt', '/_headers']);
function isFrontend(p) { return FRONTEND.has(p) || p.startsWith('/img/') || p.startsWith('/.github/'); }
function iso(r) {
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
  await self.clients.claim();
})()));
async function trim() {
  try {
    const c = await caches.open(CACHE);
    const reqs = await c.keys();
    let total = 0, sizes = [];
    for (const r of reqs) {
      const res = await c.match(r);
      if (!res) continue;
      const len = parseInt(res.headers.get('Content-Length') || '0', 10) || 0;
      sizes.push({ r, len }); total += len;
    }
    if (total <= MAX_BYTES) return;
    let removed = 0;
    for (const { r, len } of sizes) {
      if (total - removed <= MAX_BYTES * 0.9) break;
      await c.delete(r); removed += len;
    }
  } catch (e) {}
}
async function asset(event) {
  const req = event.request;
  const url = new URL(req.url);
  const p = url.pathname;
  const range = req.headers.get('Range');
  const cache = await caches.open(CACHE);
  const cached = await cache.match(p);
  if (cached && !range) return iso(cached);
  if (cached && range) {
    try {
      const buf = await cached.arrayBuffer();
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        let s = m[1] === '' ? 0 : parseInt(m[1], 10);
        let e = m[2] === '' ? buf.byteLength - 1 : parseInt(m[2], 10);
        if (e >= buf.byteLength) e = buf.byteLength - 1;
        if (s <= e && s < buf.byteLength) {
          const slice = buf.slice(s, e + 1);
          const h = new Headers(cached.headers);
          h.set('Content-Range', `bytes ${s}-${e}/${buf.byteLength}`);
          h.set('Content-Length', String(slice.byteLength));
          h.set('Accept-Ranges', 'bytes');
          return iso(new Response(slice, { status: 206, headers: h }));
        }
      }
    } catch (e) {}
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), range ? 15000 : 300000);
  const hdrs = {};
  if (range) hdrs['Range'] = range;
  try {
    const res = await fetch(CDN + p + url.search, {
      method: 'GET', headers: hdrs, mode: 'cors', credentials: 'omit', signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok || res.status === 206) {
      if (res.status === 200 && !range) {
        event.waitUntil?.(cache.put(p, res.clone()).then(() => trim()).catch(() => {}));
      }
      return iso(res);
    }
    return new Response('', { status: res.status });
  } catch (e) {
    clearTimeout(timer);
    return new Response('', { status: 504 });
  }
}
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;
  if (isFrontend(url.pathname)) {
    event.respondWith((async () => {
      try { return iso(await fetch(event.request)); }
      catch (e) {
        const c = await caches.match(event.request);
        if (c) return iso(c);
        return new Response('', { status: 504 });
      }
    })());
    return;
  }
  event.respondWith(asset(event));
});
