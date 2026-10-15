'use strict';

/* ───────────────────────── Configuración ───────────────────────── */

// Solo fiveplay — R2 eliminado del flujo (evita el TypeError de CORS
// en consola y no satura ni depende de dos CDNs).
const CDN_PRIMARY = 'https://fiveplay.lol/playgta5.com';

const STATIC_PREFIX = 'gta5-static-';
const STATIC_CACHE = STATIC_PREFIX + 'v45';
const CHUNK_CACHE = 'gta5-chunks-v3';
const META_CACHE = 'gta5-meta-v3';

const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MiB por trozo
const MAX_BYTES = 30 * 1024 * 1024 * 1024;
const QUOTA_FRACTION = 0.9;

// ⚠️ Concurrencia limitada: fiveplay corta a las ~10-15 conexiones por IP.
// Si subes esto por encima de 8, empezarás a ver AbortError / timeouts.
const MAX_CONCURRENT = 8;
let activeDownloads = 0;

// ⚠️ Timeouts amplios: fiveplay puede tardar 20-30 s en servir un rango de 16 MiB.
const HEADER_TIMEOUT = 45000;   // 45 s para las cabeceras
const BODY_TIMEOUT = 180000;    // 3 min para el cuerpo completo
const TOUCH_INTERVAL = 60000;
const TRIM_INTERVAL = 15000;

const FRONTEND = new Set([
  '/', '/index.html', '/sw2.js', '/sw.js', '/favicon.ico',
  '/robots.txt', '/_headers', '/_redirects',
]);

const LOCAL_CODE = /^\/b\/[0-9a-f]+\/(loader|audio-worklet|game|io_worker|wgpu_worker)\.js$/;

const MISSING = { state: 'missing' };
const ERROR = { state: 'error' };

/* ───────────────────────── Utilidades ───────────────────────── */

function isFrontend(p) {
  return FRONTEND.has(p) || p.startsWith('/img/') || p.startsWith('/.github/');
}

function isLocalCode(p) {
  return LOCAL_CODE.test(p);
}

function setIso(h) {
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
}

function iso(r) {
  if (!r || r.status === 0 || r.type === 'opaque' || r.type === 'opaqueredirect' || r.type === 'error') return r;
  const h = new Headers(r.headers);
  setIso(h);
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

function typeFor(path) {
  if (path.endsWith('.wasm')) return 'application/wasm';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript';
  if (path.endsWith('.json')) return 'application/json';
  return null;
}

function discard(res) {
  try { if (res && res.body) res.body.cancel().catch(() => {}); } catch (e) { /* nada */ }
}

function isQuota(e) {
  return !!e && (e.name === 'QuotaExceededError' || e.code === 22);
}

function expectsNonHtml(path) {
  return !/\.(html?|svg|xml)$/i.test(path);
}

function looksLikeHtml(buf) {
  const n = Math.min(64, buf.byteLength);
  if (n === 0) return false;
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, n)).trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

function netError(msg) {
  return Object.assign(new Error(msg || 'network'), { code: 'network' });
}

function metaKey(base) {
  return self.location.origin + '/__meta/' + encodeURIComponent(base);
}

function chunkKey(base, i) {
  return self.location.origin + '/__chunk/' + i + '/' + encodeURIComponent(base);
}

function expectedLen(meta, i) {
  return Math.min(CHUNK_SIZE, meta.size - i * CHUNK_SIZE);
}

function cachedBytes(meta) {
  let n = 0;
  for (let i = 0; i < meta.have.length; i++) if (meta.have[i]) n += expectedLen(meta, i);
  return n;
}

/* ───────────────────────── Ciclo de vida ───────────────────────── */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys
    .filter((k) =>
      (k.startsWith(STATIC_PREFIX) && k !== STATIC_CACHE) ||
      (k === 'gta5-chunks' || k === 'gta5-meta' || k === 'gta5-chunks-v2' || k === 'gta5-meta-v2') ||
      /^gta5-v\d+$/.test(k))
    .map((k) => caches.delete(k)));
  await self.clients.claim();
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch (err) { /* opcional */ }
})()));

/* ───────────────────────── Metadatos por archivo ───────────────────────── */

const metas = new Map();
const inflight = new Map();

function parseMeta(j) {
  if (!j || typeof j.base !== 'string' || !Number.isFinite(j.size) || j.size < 0 || j.chunkSize !== CHUNK_SIZE) return null;
  const chunks = Math.max(1, Math.ceil(j.size / CHUNK_SIZE));
  if (typeof j.have !== 'string' || j.have.length !== chunks) return null;
  return {
    base: j.base,
    size: j.size,
    type: j.type || 'application/octet-stream',
    chunks,
    have: Uint8Array.from(j.have, (c) => (c === '1' ? 1 : 0)),
    lastUsed: j.lastUsed || 0,
    active: 0,
    saving: Promise.resolve(),
  };
}

async function loadMeta(base) {
  let m = metas.get(base);
  if (m) return m;
  const mc = await caches.open(META_CACHE);
  const res = await mc.match(metaKey(base));
  if (!res) return null;
  try {
    m = parseMeta(await res.json());
  } catch (e) {
    m = null;
  }
  if (!m) {
    await mc.delete(metaKey(base));
    return null;
  }
  const existing = metas.get(base);
  if (existing) return existing;
  metas.set(base, m);
  return m;
}

function saveMeta(meta) {
  meta.saving = meta.saving.then(async () => {
    if (!metas.has(meta.base)) metas.set(meta.base, meta);
    const mc = await caches.open(META_CACHE);
    await mc.put(metaKey(meta.base), new Response(JSON.stringify({
      base: meta.base,
      size: meta.size,
      type: meta.type,
      chunkSize: CHUNK_SIZE,
      chunks: meta.chunks,
      lastUsed: meta.lastUsed,
      have: Array.from(meta.have).join(''),
    }), { headers: { 'Content-Type': 'application/json' } }));
  }).catch((e) => console.warn('[SW] No se pudo guardar metadatos:', e));
  return meta.saving;
}

/* ───────────────────────── Descarga de trozos ───────────────────────── */

async function tryOrigin(origin, pq, path, start, end, knownSize) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), HEADER_TIMEOUT);
  try {
    const res = await fetch(origin + pq, {
      method: 'GET',
      headers: { Range: 'bytes=' + start + '-' + end },
      mode: 'cors',
      credentials: 'omit',
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (res.status === 404 || res.status === 410) { discard(res); return MISSING; }
    if (res.status === 416 && start === 0) {
      discard(res);
      return { state: 'ok', buf: new ArrayBuffer(0), total: 0, ct: '' };
    }
    if (res.status !== 206 && res.status !== 200) { discard(res); return ERROR; }

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) { discard(res); return MISSING; }
    if (path.endsWith('.js') && !ct.includes('javascript')) { discard(res); return MISSING; }
    if (path.endsWith('.wasm') && !ct.includes('wasm') && !ct.includes('octet-stream')) { discard(res); return MISSING; }

    let total = null;
    if (res.status === 206) {
      const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('Content-Range') || '');
      if (m) {
        if (parseInt(m[1], 10) !== start) { discard(res); return ERROR; }
        if (m[3] !== '*') total = parseInt(m[3], 10);
      }
    } else {
      const len = parseInt(res.headers.get('Content-Length') || '', 10);
      if (start !== 0 || !(len >= 0 && len <= CHUNK_SIZE)) { discard(res); return ERROR; }
      total = len;
    }

    timer = setTimeout(() => ctrl.abort(), BODY_TIMEOUT);
    const buf = await res.arrayBuffer();
    clearTimeout(timer);

    if (start === 0 && expectsNonHtml(path) && looksLikeHtml(buf)) return MISSING;

    if (total === null) {
      if (start === 0 && buf.byteLength < CHUNK_SIZE) {
        total = buf.byteLength;
      } else {
        console.error('[SW] El CDN no expone Content-Range (falta Access-Control-Expose-Headers):', origin);
        return ERROR;
      }
    }
    if (knownSize != null && total !== knownSize) return ERROR;
    const expected = Math.min(end, total - 1) - start + 1;
    if (buf.byteLength !== expected) return ERROR;

    return { state: 'ok', buf, total, ct };
  } catch (e) {
    clearTimeout(timer);
    // Solo logueamos si NO es un abort provocado por nosotros (timeout real)
    console.warn('[SW] Fallo de red con', origin, e && e.name);
    return ERROR;
  }
}

async function readCachedChunk(base, i) {
  const meta = metas.get(base);
  if (!meta || !meta.have[i]) return null;
  const cc = await caches.open(CHUNK_CACHE);
  const res = await cc.match(chunkKey(base, i));
  if (res) {
    const buf = await res.arrayBuffer();
    const poisoned = i === 0 && expectsNonHtml(new URL(base).pathname) && looksLikeHtml(buf);
    if (!poisoned && buf.byteLength === expectedLen(meta, i)) return buf;
    await cc.delete(chunkKey(base, i));
  }
  meta.have[i] = 0;
  saveMeta(meta);
  return null;
}

async function putChunk(base, i, buf) {
  const cc = await caches.open(CHUNK_CACHE);
  const mk = () => new Response(buf, { headers: { 'Content-Length': String(buf.byteLength) } });
  try {
    await cc.put(chunkKey(base, i), mk());
    return true;
  } catch (e) {
    if (!isQuota(e)) { console.warn('[SW] cache.put falló:', e); return false; }
    await trim(true);
    try {
      await cc.put(chunkKey(base, i), mk());
      return true;
    } catch (e2) {
      console.warn('[SW] Sin espacio para cachear el trozo (se sirve sin guardar):', e2);
      return false;
    }
  }
}

/* ───────────────────────── Cola de descargas ───────────────────────── */

const downloadQueue = [];

function acquireSlot() {
  if (activeDownloads < MAX_CONCURRENT) {
    activeDownloads++;
    return Promise.resolve();
  }
  return new Promise((resolve) => downloadQueue.push(resolve));
}

function releaseSlot() {
  activeDownloads--;
  const next = downloadQueue.shift();
  if (next) {
    activeDownloads++;
    next();
  }
}

async function downloadChunk(ctx, i) {
  await acquireSlot();
  try {
    const { base, path, pq } = ctx;
    const known = metas.get(base);
    const knownSize = known ? known.size : null;
    const start = i * CHUNK_SIZE;
    let end = start + CHUNK_SIZE - 1;
    if (knownSize != null) end = Math.min(end, knownSize - 1);

    const r = await tryOrigin(CDN_PRIMARY, pq, path, start, end, knownSize);
    if (r.state !== 'ok') {
      throw Object.assign(
        new Error(r.state === 'missing' ? 'missing' : 'network'),
        { code: r.state === 'missing' ? 'missing' : 'network' }
      );
    }

    let meta = metas.get(base);
    if (!meta) {
      meta = {
        base,
        size: r.total,
        type: typeFor(path) || r.ct || 'application/octet-stream',
        chunks: Math.max(1, Math.ceil(r.total / CHUNK_SIZE)),
        have: new Uint8Array(Math.max(1, Math.ceil(r.total / CHUNK_SIZE))),
        lastUsed: Date.now(),
        active: 0,
        saving: Promise.resolve(),
      };
      metas.set(base, meta);
    }
    if (r.buf.byteLength > 0 && await putChunk(base, i, r.buf)) {
      meta.have[i] = 1;
      saveMeta(meta);
      trim(false);
    } else if (r.buf.byteLength === 0) {
      saveMeta(meta);
    }
    return r.buf;
  } finally {
    releaseSlot();
  }
}

async function getChunkBuf(ctx, i) {
  const hit = await readCachedChunk(ctx.base, i);
  if (hit) return hit;
  const key = chunkKey(ctx.base, i);
  let p = inflight.get(key);
  if (!p) {
    p = downloadChunk(ctx, i).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/* ───────────────────────── Limpieza LRU ───────────────────────── */

let trimPromise = null;
let lastTrim = 0;

function trim(force) {
  if (trimPromise) {
    return force ? trimPromise.then(() => trim(true)) : trimPromise;
  }
  if (!force && Date.now() - lastTrim < TRIM_INTERVAL) return Promise.resolve();
  trimPromise = doTrim(force)
    .catch((e) => console.warn('[SW] trim falló:', e))
    .finally(() => { lastTrim = Date.now(); trimPromise = null; });
  return trimPromise;
}

async function evict(meta) {
  const cc = await caches.open(CHUNK_CACHE);
  const jobs = [];
  for (let i = 0; i < meta.have.length; i++) {
    if (meta.have[i]) { jobs.push(cc.delete(chunkKey(meta.base, i))); meta.have[i] = 0; }
  }
  await Promise.all(jobs);
  metas.delete(meta.base);
  const mc = await caches.open(META_CACHE);
  await mc.delete(metaKey(meta.base));
}

async function doTrim(force) {
  const mc = await caches.open(META_CACHE);
  const reqs = await mc.keys();
  const prefix = metaKey('');
  const all = [];
  for (const r of reqs) {
    let base;
    try {
      base = decodeURIComponent(r.url.slice(prefix.length));
    } catch (e) {
      await mc.delete(r);
      continue;
    }
    const m = await loadMeta(base);
    if (m) all.push(m);
  }
  let total = all.reduce((a, m) => a + cachedBytes(m), 0);

  let budget = MAX_BYTES;
  try {
    const est = await navigator.storage.estimate();
    if (est && est.quota) {
      const others = Math.max(0, (est.usage || 0) - total);
      budget = Math.min(budget, est.quota * QUOTA_FRACTION - others);
    }
  } catch (e) { /* sin estimate */ }
  budget = Math.max(0, budget);
  if (force) budget = Math.min(budget, total * 0.9);
  if (total <= budget) return;

  const target = budget * 0.9;
  all.sort((a, b) => a.lastUsed - b.lastUsed);
  for (const m of all) {
    if (total <= target) break;
    if (m.active > 0) continue;
    total -= cachedBytes(m);
    await evict(m);
  }
}

/* ───────────────────────── Rangos y streaming ───────────────────────── */

function parseRange(header, size) {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let s;
  let e;
  if (m[1] === '') {
    const n = parseInt(m[2], 10);
    if (n === 0) return { bad: true };
    s = Math.max(0, size - n);
    e = size - 1;
  } else {
    s = parseInt(m[1], 10);
    if (m[2] === '') {
      e = size - 1;
    } else {
      const req = parseInt(m[2], 10);
      if (req < s) return null;
      e = Math.min(req, size - 1);
    }
  }
  if (s >= size) return { bad: true };
  return { s, e };
}

function chunkStream(ctx, meta, start, end, firstBuf) {
  meta.active++;
  let released = false;
  const release = () => { if (!released) { released = true; meta.active--; } };
  let i = Math.floor(start / CHUNK_SIZE);
  const last = Math.floor(end / CHUNK_SIZE);
  let first = firstBuf;

  return new ReadableStream({
    async pull(controller) {
      try {
        const buf = first || await getChunkBuf(ctx, i);
        first = null;
        const cs = i * CHUNK_SIZE;
        const from = Math.max(start, cs) - cs;
        const to = Math.min(end, cs + buf.byteLength - 1) - cs;
        controller.enqueue(new Uint8Array(buf, from, to - from + 1));
        i++;
        if (i > last) { controller.close(); release(); }
      } catch (e) {
        release();
        controller.error(e);
      }
    },
    cancel() { release(); },
  });
}

function failure(err, path) {
  const h = new Headers({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  setIso(h);
  if (err && err.code === 'missing') {
    if (path.endsWith('.json')) {
      h.set('Content-Type', 'application/json');
      return new Response('{}', { status: 200, headers: h });
    }
    return new Response('Not found', { status: 404, headers: h });
  }
  h.set('Retry-After', '5');
  return new Response('Servicio no disponible', { status: 503, headers: h });
}

async function serveAsset(req, url) {
  const path = url.pathname;
  const pq = path + url.search;
  const base = url.origin + pq;
  const ctx = { base, path, pq };

  try {
    let meta = await loadMeta(base);
    let probe = null;
    if (!meta) {
      probe = await getChunkBuf(ctx, 0);
      meta = await loadMeta(base);
      if (!meta) throw netError('sin metadatos');
    }
    if (Date.now() - meta.lastUsed > TOUCH_INTERVAL) {
      meta.lastUsed = Date.now();
      saveMeta(meta);
    }

    const size = meta.size;
    const headers = new Headers({ 'Content-Type': meta.type, 'Accept-Ranges': 'bytes' });
    setIso(headers);

    if (size === 0) {
      headers.set('Content-Length', '0');
      return new Response(null, { status: 200, headers });
    }

    const rng = parseRange(req.headers.get('Range'), size);
    if (rng && rng.bad) {
      headers.set('Content-Range', 'bytes */' + size);
      return new Response(null, { status: 416, headers });
    }

    const s = rng ? rng.s : 0;
    const e = rng ? rng.e : size - 1;
    const status = rng ? 206 : 200;
    headers.set('Content-Length', String(e - s + 1));
    if (rng) headers.set('Content-Range', 'bytes ' + s + '-' + e + '/' + size);

    if (req.method === 'HEAD') return new Response(null, { status, headers });

    const idx = Math.floor(s / CHUNK_SIZE);
    const first = (idx === 0 && probe) ? probe : await getChunkBuf(ctx, idx);
    return new Response(chunkStream(ctx, meta, s, e, first), { status, headers });
  } catch (err) {
    return failure(err, path);
  }
}

/* ───────────────────────── Frontend y código propio ───────────────────────── */

async function networkFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(req);
    if (req.method === 'GET' && res.status === 200 && res.type === 'basic') {
      cache.put(req, res.clone()).catch((e) => console.warn('[SW] cache.put frontend:', e));
    }
    return iso(res);
  } catch (e) {
    const c = await cache.match(req);
    if (c) return iso(c);
    const h = new Headers({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    setIso(h);
    return new Response('Sin conexión', { status: 503, headers: h });
  }
}

/* ───────────────────────── Fetch ───────────────────────── */

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') return;

  const p = url.pathname;
  if (isFrontend(p) || isLocalCode(p)) {
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(serveAsset(req, url));
});
