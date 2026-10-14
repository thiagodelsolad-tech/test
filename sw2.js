'use strict';

/* ───────────────────────── Configuración ───────────────────────── */

const CDN_PRIMARY = 'https://gta.deloskiyt.pl';
const CDN_FALLBACK = 'https://cdn.apkprojects.xyz/mirror/playgta5.com';

// Caché pequeña de código/frontend (versionada: se borra al subir de versión).
const STATIC_PREFIX = 'gta5-static-';
const STATIC_CACHE = STATIC_PREFIX + 'v43';
// Cachés pesadas (SIN versión: sobreviven a las actualizaciones del SW).
const CHUNK_CACHE = 'gta5-chunks';
const META_CACHE = 'gta5-meta';

// ¡No cambies CHUNK_SIZE sin vaciar antes CHUNK_CACHE y META_CACHE!
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB por trozo
const MAX_BYTES = 30 * 1024 * 1024 * 1024; // tope propio (el juego pesa ~20 GB)
const QUOTA_FRACTION = 0.9; // nunca usar más de este % de la cuota del navegador

const HEADER_TIMEOUT = 20000; // esperar cabeceras del CDN
const BODY_TIMEOUT = 90000; // descargar un trozo completo
const TOUCH_INTERVAL = 60000; // cada cuánto actualizar "último uso"
const TRIM_INTERVAL = 15000; // mínimo entre limpiezas automáticas

const FRONTEND = new Set([
  '/', '/index.html', '/sw2.js', '/sw.js', '/favicon.ico',
  '/robots.txt', '/_headers', '/_redirects',
]);

// Scripts propios del juego (el hash del build puede cambiar).
const LOCAL_CODE = /^\/b\/[0-9a-f]+\/(loader|audio-worklet|game|io_worker|wgpu_worker)\.js$/;

// .wasm y .rpf: se prueba primero el mirror (comportamiento original).
// Si el primario también los sirve bien, puedes quitar esta regla.
const FALLBACK_FIRST = /\.(wasm|rpf)$/;

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
  // Las respuestas opacas / redirects manuales no se pueden reconstruir.
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

// Algunos hostings/CDN devuelven el index.html con 200 y un Content-Type engañoso.
// Se detecta por el contenido: ningún asset de /b/ o /game/ debería empezar por <!doctype o <html.
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
      /^gta5-v\d+$/.test(k)) // caché antigua (formato anterior, sin trozos)
    .map((k) => caches.delete(k)));
  await self.clients.claim();
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch (err) { /* opcional */ }
})()));

/* ───────────────────────── Metadatos por archivo ───────────────────────── */

const metas = new Map(); // base -> meta (en memoria)
const inflight = new Map(); // clave de trozo -> Promise<ArrayBuffer>

function parseMeta(j) {
  if (!j || typeof j.base !== 'string' || !(j.size >= 0) || j.chunkSize !== CHUNK_SIZE) return null;
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
  // Serializado por archivo: siempre se escribe el estado más reciente.
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

function originsFor(path) {
  return FALLBACK_FIRST.test(path)
    ? [CDN_FALLBACK, CDN_PRIMARY]
    : [CDN_PRIMARY, CDN_FALLBACK];
}

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
      discard(res); // archivo vacío
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
      // 200: el servidor ignoró Range. Solo sirve si el archivo cabe en un trozo.
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
    if (knownSize != null && total !== knownSize) return ERROR; // el archivo cambió
    const expected = Math.min(end, total - 1) - start + 1;
    if (buf.byteLength !== expected) return ERROR;

    return { state: 'ok', buf, total, ct };
  } catch (e) {
    clearTimeout(timer);
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
  meta.have[i] = 0; // el navegador lo expulsó o está corrupto
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

async function downloadChunk(ctx, i) {
  const { base, path, pq } = ctx;
  const known = metas.get(base);
  const knownSize = known ? known.size : null;
  const start = i * CHUNK_SIZE;
  let end = start + CHUNK_SIZE - 1;
  if (knownSize != null) end = Math.min(end, knownSize - 1);

  let sawError = false;
  for (const origin of originsFor(path)) {
    const r = await tryOrigin(origin, pq, path, start, end, knownSize);
    if (r.state === 'error') { sawError = true; continue; }
    if (r.state !== 'ok') continue;

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
  }
  throw Object.assign(new Error(sawError ? 'network' : 'missing'), { code: sawError ? 'network' : 'missing' });
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
  if (trimPromise) return trimPromise;
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
    const m = await loadMeta(decodeURIComponent(r.url.slice(prefix.length)));
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
  all.sort((a, b) => a.lastUsed - b.lastUsed); // el menos usado primero
  for (const m of all) {
    if (total <= target) break;
    if (m.active > 0) continue; // no tocar lo que se está sirviendo
    total -= cachedBytes(m);
    await evict(m);
  }
}

/* ───────────────────────── Rangos y streaming ───────────────────────── */

// null → sin rango válido (se responde 200 completo); {bad:true} → 416; {s,e} → 206
function parseRange(header, size) {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null; // sintaxis inválida o multi-rango
  let s;
  let e;
  if (m[1] === '') { // sufijo: los últimos N bytes
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
      if (req < s) return null; // inválido → se ignora
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
    // Solo para 404 reales (nunca por fallos de red): evita JSON.parse sobre HTML.
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
  const pq = path + url.search; // la query forma parte de la clave
  const base = url.origin + pq;
  const ctx = { base, path, pq };

  try {
    let meta = await loadMeta(base);
    if (!meta) {
      await getChunkBuf(ctx, 0); // descubre tamaño y tipo
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

    // Se pide el primer trozo antes de responder para poder devolver 503/404 limpios.
    const first = await getChunkBuf(ctx, Math.floor(s / CHUNK_SIZE));
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
