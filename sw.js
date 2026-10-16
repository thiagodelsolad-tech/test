// ═══════════════════════════════════════════════════════════════════════
// Service Worker Proxy — GTA V + Simpsons Hit & Run (versión corregida)
// ═══════════════════════════════════════════════════════════════════════

const ORIGIN_GTA = 'https://fiveplay.lol';
const ORIGIN_SIMPSONS = 'https://simpsons-proxy.kitofree1221.workers.dev';

// Los que terminan en "/" son prefijos; los demás son coincidencia exacta
// (antes '/log' también capturaba '/login', '/logo.png', etc.)
const GTA_PREFIXES = [
  '/b/', '/game/', '/data/', '/audio/', '/x64/',
  '/log', '/loader.js', '/prejs.js', '/wgpu_worker.js',
  '/io_worker.js', '/audio-worklet.js', '/sw2.js',
];

const SIMPSONS_CACHE = 'simpsons-v1';
const GTA_HTML_CACHE = 'gta-html-v1';
const GTA_HTML_TTL = 5 * 60 * 1000; // 5 minutos

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Limpia caches viejos
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SIMPSONS_CACHE && k !== GTA_HTML_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isOwnStatic(path) {
  return path === '/' || path === '/index.html' ||
         path.startsWith('/img/') ||
         path === '/favicon.ico';
}

function matchesGta(path) {
  return GTA_PREFIXES.some(p => p.endsWith('/') ? path.startsWith(p) : path === p);
}

function isGamePage(path, base) {
  return path === base || path === base + '/' || path === base + '/index.html';
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Decisión síncrona: lo que no es nuestro lo maneja el navegador directamente
  if (url.origin !== self.location.origin) return;
  if (isOwnStatic(url.pathname)) return;

  event.respondWith(handleFetch(event, url));
});

async function detectMode(event) {
  const check = (u) => {
    if (!u) return null;
    if (u.indexOf('/gta5') !== -1) return 'gta';
    if (u.indexOf('/simpsons') !== -1) return 'simpsons';
    return null;
  };

  if (event.clientId) {
    try {
      const client = await self.clients.get(event.clientId);
      const m = client && check(client.url);
      if (m) return m;
    } catch (e) {}
  }
  // Fallback: workers (su clientId es el del worker, no el de la página)
  return check(event.request.referrer);
}

async function handleFetch(event, url) {
  const path = url.pathname;

  // ── Páginas de juego ──
  if (isGamePage(path, '/gta5')) return serveGameHTML(ORIGIN_GTA, 'gta');
  if (isGamePage(path, '/simpsons')) return serveGameHTML(ORIGIN_SIMPSONS, 'simpsons');

  // ── Detectar de qué juego viene la petición ──
  let mode = await detectMode(event);

  // Si la ruta viene con prefijo (/gta5/game/x.js), se quita el prefijo
  let assetPath = path;
  const m = path.match(/^\/(gta5|simpsons)(\/.*)$/);
  if (m) {
    mode = mode || (m[1] === 'gta5' ? 'gta' : 'simpsons');
    assetPath = m[2];
  }

  // ── Assets ──
  if ((mode === 'gta' || mode === null) && matchesGta(assetPath)) {
    return proxyAsset(event.request, ORIGIN_GTA, assetPath);
  }
  if (mode === 'simpsons') {
    return proxySimpsons(event.request, assetPath);
  }

  return fetch(event.request);
}

// ═══════════════════════════════════════════════════════════════════════
// Proxy de assets (con cache opcional para Simpsons)
// ═══════════════════════════════════════════════════════════════════════
async function proxyAsset(request, origin, assetPath) {
  const url = new URL(request.url);
  const target = origin + assetPath + url.search;

  if (assetPath === '/sw2.js') {
    return new Response('self.addEventListener("install",()=>self.skipWaiting());', {
      headers: { 'Content-Type': 'application/javascript' }
    });
  }

  try {
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

    // Solo se reenvían los headers necesarios (Range es vital para wasm/data grandes)
    const reqHeaders = new Headers();
    const range = request.headers.get('range');
    if (range) reqHeaders.set('Range', range);
    if (hasBody) {
      const ct = request.headers.get('content-type');
      if (ct) reqHeaders.set('Content-Type', ct);
    }

    const init = {
      method: request.method,
      headers: reqHeaders,
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      body: hasBody ? await request.arrayBuffer() : undefined,
    };

    // Con Range del cliente se reenvía tal cual (el 206 pasa directo con su Content-Range).
    // Sin Range, si el origen responde 206 igualmente (HTML/JSON/etc.) se reensambla el archivo.
    const upstream = range ? await fetch(target, init) : await fetchComplete(target, init);

    if (upstream.status >= 500 || upstream.status === 403 || upstream.status === 429) {
      notifyClients(upstream.status, request.url).catch(() => {});
    }

    // OJO: no se copian content-encoding ni content-length, porque fetch()
    // ya descomprimió el cuerpo y esos valores ya no coinciden.
    const headers = new Headers();
    ['content-type', 'content-range', 'accept-ranges',
     'last-modified', 'etag', 'cache-control'].forEach(k => {
      const v = upstream.headers.get(k);
      if (v) headers.set(k, v);
    });

    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    headers.set('Access-Control-Allow-Origin', '*');

    const p = assetPath.toLowerCase();
    if (p.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
    if (p.endsWith('.js') || p.endsWith('.mjs')) headers.set('Content-Type', 'application/javascript');
    if (p.endsWith('.json')) headers.set('Content-Type', 'application/json');
    if (p.endsWith('.woff')) headers.set('Content-Type', 'font/woff');
    if (p.endsWith('.woff2')) headers.set('Content-Type', 'font/woff2');

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (e) {
    const isUp = e instanceof UpstreamError;
    const code = (isUp && e.status >= 400) ? e.status : 502;
    notifyClients(isUp && e.status >= 400 ? e.status : 0, request.url).catch(() => {});
    return new Response(
      'Proxy error (' + (isUp && e.status >= 400 ? 'HTTP ' + e.status : 'red') + ') en ' + assetPath + ': ' + e.message,
      { status: code, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }
}

async function proxySimpsons(request, assetPath) {
  try {
    const url = new URL(request.url);
    const key = ORIGIN_SIMPSONS + assetPath + url.search;
    // Las peticiones Range no se cachean (devolverían el archivo completo / 206 no es cacheable)
    const canCache = request.method === 'GET' && !request.headers.has('range');

    const cache = await caches.open(SIMPSONS_CACHE);
    if (canCache) {
      const cached = await cache.match(key);
      if (cached) return cached;
    }

    const response = await proxyAsset(request, ORIGIN_SIMPSONS, assetPath);
    if (canCache && response.status === 200) {
      cache.put(key, response.clone()).catch(() => {});
    }
    return response;
  } catch (e) {
    return new Response('SW cache error: ' + e.message, { status: 502 });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HTML del juego
// ═══════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════
// Errores explícitos + Range completo + cache del HTML de GTA
// ═══════════════════════════════════════════════════════════════════════
class UpstreamError extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status || 0; // 0 = error de red (no hubo respuesta HTTP)
    this.url = url || '';
  }
}

function hostOf(u) {
  try { return new URL(u).host; } catch (e) { return String(u); }
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function errorTitle(status) {
  if (!status) return 'No se pudo conectar con el servidor del juego';
  if (status === 403) return 'Acceso denegado por el servidor del juego';
  if (status === 404) return 'El juego no se encontró en el servidor';
  if (status === 429) return 'Demasiadas solicitudes, intenta de nuevo en un momento';
  if (status >= 500) return 'El servidor del juego no está disponible';
  return 'El servidor del juego devolvió un error';
}

function errorPage(err) {
  const upstreamStatus = err instanceof UpstreamError ? err.status : 0;
  const httpStatus = upstreamStatus >= 400 ? upstreamStatus : 502;
  const codeLabel = upstreamStatus >= 400 ? 'HTTP ' + upstreamStatus : 'ERROR DE RED';
  const detail = (err && err.message) ? err.message : 'Error desconocido';
  const source = (err instanceof UpstreamError && err.url) ? hostOf(err.url) : '';

  const html = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHTML(codeLabel) + '</title>' +
    '<style>' +
    'html,body{height:100%;margin:0}' +
    'body{background:#0e1419;color:#8ba6bf;font:14px/1.5 -apple-system,BlinkMacSystemFont,Arial,sans-serif;display:flex;align-items:center;justify-content:center}' +
    '.box{max-width:480px;padding:28px 32px;text-align:center;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.03)}' +
    '.code{font:700 34px Consolas,monospace;color:#f87171;letter-spacing:2px}' +
    'h1{font-size:17px;color:#fff;margin:10px 0 6px}' +
    'p{margin:4px 0;word-break:break-word}' +
    '.src{font-size:12px;opacity:.7}' +
    'button{margin-top:16px;padding:9px 22px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:14px;cursor:pointer}' +
    '</style></head><body><div class="box">' +
    '<div class="code">' + escapeHTML(codeLabel) + '</div>' +
    '<h1>' + escapeHTML(errorTitle(upstreamStatus)) + '</h1>' +
    '<p>' + escapeHTML(detail) + '</p>' +
    (source ? '<p class="src">Origen: ' + escapeHTML(source) + '</p>' : '') +
    '<button onclick="location.reload()">Reintentar</button>' +
    '</div></body></html>';

  return new Response(html, {
    status: httpStatus,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// Avisa a las pestañas abiertas para que muestren un overlay con el código HTTP
// (máximo 1 aviso cada 3 s para no inundar la pantalla)
let lastNotifyAt = 0;
async function notifyClients(status, url) {
  const now = Date.now();
  if (now - lastNotifyAt < 3000) return;
  lastNotifyAt = now;
  let path = url;
  try { path = new URL(url).pathname; } catch (e) {}
  const list = await self.clients.matchAll({ type: 'window' });
  list.forEach(c => c.postMessage({ type: 'sw-proxy-error', status: status || 0, path }));
}

// ── Range ────────────────────────────────────────────────────────────────
function parseContentRange(h) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec((h || '').trim());
  if (!m) return null;
  return { start: +m[1], end: +m[2], total: m[3] === '*' ? null : +m[3] };
}

// Si el origen responde 206 (parcial) a una petición que no pidió Range,
// se piden los fragmentos restantes y se reensambla una respuesta 200 completa.
async function fetchComplete(url, init) {
  const res = await fetch(url, init);
  if (res.status !== 206) return res;

  const first = parseContentRange(res.headers.get('content-range'));
  if (!first || first.start !== 0) {
    throw new UpstreamError('El origen devolvió una respuesta parcial (206) inesperada', 206, url);
  }

  const chunks = [new Uint8Array(await res.arrayBuffer())];
  let next = first.end + 1;
  let total = first.total;
  let done = total !== null && next >= total;

  for (let i = 0; !done && i < 50; i++) {
    const h = new Headers((init && init.headers) || undefined);
    h.set('Range', 'bytes=' + next + '-');
    const r = await fetch(url, Object.assign({}, init, { headers: h }));

    if (r.status === 416) { done = true; break; } // ya no queda nada
    if (r.status !== 206) {
      throw new UpstreamError('Fallo al completar la descarga por rangos (HTTP ' + r.status + ')', r.status, url);
    }
    const c = parseContentRange(r.headers.get('content-range'));
    if (!c || c.start !== next) {
      throw new UpstreamError('Rango inconsistente al reensamblar la respuesta', 206, url);
    }
    chunks.push(new Uint8Array(await r.arrayBuffer()));
    next = c.end + 1;
    if (c.total !== null) total = c.total;
    done = total !== null && next >= total;
  }
  if (!done) throw new UpstreamError('Respuesta fragmentada en demasiadas partes', 206, url);

  const size = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(size);
  let off = 0;
  chunks.forEach(c => { merged.set(c, off); off += c.length; });

  const headers = new Headers(res.headers);
  headers.delete('content-range');
  headers.delete('content-length');
  return new Response(merged, { status: 200, statusText: 'OK', headers });
}

// ── HTML de GTA: cache de 5 min + stale-if-error + dedupe de peticiones ──
async function fetchHTMLText(targetUrl) {
  let res;
  try {
    res = await fetchComplete(targetUrl, {
      method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-cache',
    });
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError('No se pudo conectar con ' + hostOf(targetUrl) + ': ' + e.message, 0, targetUrl);
  }
  if (!res.ok) {
    throw new UpstreamError(
      hostOf(targetUrl) + ' respondió ' + res.status + (res.statusText ? ' ' + res.statusText : ''),
      res.status, targetUrl
    );
  }
  return res.text();
}

const inflightHTML = new Map();

async function getGameHTML(origin, type) {
  const targetUrl = type === 'simpsons' ? origin + '/?skipmovie' : origin + '/';
  if (type !== 'gta') return fetchHTMLText(targetUrl);

  const cache = await caches.open(GTA_HTML_CACHE);
  const cached = await cache.match(targetUrl);
  if (cached) {
    const age = Date.now() - Number(cached.headers.get('x-sw-fetched-at') || 0);
    if (age < GTA_HTML_TTL) return cached.text();
  }

  // Si ya hay una petición en vuelo (varias pestañas), se comparte
  if (inflightHTML.has(targetUrl)) return inflightHTML.get(targetUrl);

  const p = (async () => {
    try {
      const html = await fetchHTMLText(targetUrl);
      await cache.put(targetUrl, new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'x-sw-fetched-at': String(Date.now()),
        },
      })).catch(() => {});
      return html;
    } catch (e) {
      if (cached) return cached.text(); // origen caído: se sirve la copia vieja
      throw e;
    }
  })().finally(() => inflightHTML.delete(targetUrl));

  inflightHTML.set(targetUrl, p);
  return p;
}

async function serveGameHTML(origin, type) {
  try {
    let html = await getGameHTML(origin, type);

    if (type === 'gta') {
      html = html.replace(
        /<script[^>]*src\s*=\s*["'][^"']*(quge5\.com|alwingulla\.com|monetag|tag\.min\.js|cloudflareinsights)[^"']*["'][^>]*>\s*<\/script>/gi,
        ''
      );
      html = html.replace(/<meta\s+name=["']monetag["'][^>]*>/gi, '');
      html = html.replace(
        /<iframe[^>]*src=["'][^"']*(adsterra|monetag|highrevenue)[^"']*["'][^>]*>\s*<\/iframe>/gi,
        ''
      );
      html = html.replace(
        /navigator\.serviceWorker\.register\(\s*['"]\/sw2\.js['"][^)]*\)/g,
        'Promise.resolve()'
      );
    }

    const headPatch = buildHeadPatch(type);
    const bodyPatch = buildBodyPatch(type);

    // Funciones como reemplazo: los "$" del código inyectado no se interpretan
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (m) => m + headPatch);
    } else {
      html = headPatch + html;
    }

    const idx = html.toLowerCase().lastIndexOf('</body>');
    if (idx !== -1) {
      html = html.slice(0, idx) + bodyPatch + html.slice(idx);
    } else {
      html += bodyPatch;
    }

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return errorPage(e);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// OVERLAY DE ERRORES HTTP (ambos juegos)
// ═══════════════════════════════════════════════════════════════════════
function buildErrorOverlayScript() {
  return `<script>
(function(){
  if (!('serviceWorker' in navigator)) return;
  var timer = null;
  function overlay(msg){
    var d = document.getElementById('__sw_err');
    if (!d) {
      d = document.createElement('div');
      d.id = '__sw_err';
      d.setAttribute('role', 'alert');
      d.style.cssText = 'position:fixed;left:14px;top:14px;z-index:9600;max-width:min(420px,90vw);padding:10px 16px;border-radius:10px;background:rgba(127,29,29,.95);color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);pointer-events:none;word-break:break-all;';
      (document.body || document.documentElement).appendChild(d);
    }
    d.textContent = msg;
    d.style.display = 'block';
    clearTimeout(timer);
    timer = setTimeout(function(){ d.style.display = 'none'; }, 8000);
  }
  navigator.serviceWorker.addEventListener('message', function(e){
    var m = e.data;
    if (!m || m.type !== 'sw-proxy-error') return;
    var code = m.status ? 'Error HTTP ' + m.status : 'Error de red';
    overlay(code + ' al cargar ' + m.path);
  });
})();
<\/script>`;
}

// ═══════════════════════════════════════════════════════════════════════
// HEAD PATCH — bloquea ads estáticos y dinámicos
// ═══════════════════════════════════════════════════════════════════════
function buildHeadPatch(type) {
  if (type === 'simpsons') return buildErrorOverlayScript();

  return buildErrorOverlayScript() + `<script>
(function(){
  var BLOCKED = ['alwingulla.com','quge5.com','monetag','profit','adsterra','popads','popcash','hilltopads'];
  function isBlocked(v){
    if (!v) return false;
    v = String(v);
    return BLOCKED.some(function(b){ return v.indexOf(b) !== -1; });
  }

  // Bloquea script.src = "..." (setter del prototipo, cubre todos los scripts)
  var _srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
  if (_srcDesc && _srcDesc.set) {
    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
      get: _srcDesc.get,
      set: function(v){ if (isBlocked(v)) return; _srcDesc.set.call(this, v); },
      configurable: true,
      enumerable: _srcDesc.enumerable
    });
  }

  // Bloquea script.setAttribute('src', "...")
  var _setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value){
    if (this.tagName === 'SCRIPT' && String(name).toLowerCase() === 'src' && isBlocked(value)) return;
    return _setAttr.call(this, name, value);
  };

  var AD_SELECTORS = [
    '[id*="adsterra"]', '[class*="adsterra"]',
    '[id*="popads"]', '[id*="popcash"]',
    '[id*="monetag"]', '[class*="monetag"]',
    'iframe[src*="profit"]', 'iframe[src*="adsterra"]',
    'iframe[src*="highrevenue"]', 'iframe[src*="monetag"]'
  ];
  var AD_TEXTS = ['new message', 'play now', 'hot new game', 'click here', 'sponsored'];

  function isProtected(el){
    if (el.id === 'canvas' || el.id === '__gp_hud' || el.id === '__gp_btn' || el.id === '__sw_err') return true;
    if (el.closest && el.closest('#loading, #__gp_hud, #__gp_btn, #__sw_err, .my-ad')) return true;
    if (el.className && typeof el.className === 'string' && el.className.indexOf('my-ad') !== -1) return true;
    return false;
  }

  function killAds() {
    AD_SELECTORS.forEach(function(sel){
      try {
        document.querySelectorAll(sel).forEach(function(el){
          if (isProtected(el)) return;
          el.remove();
        });
      } catch(e){}
    });

    document.querySelectorAll('div, section, aside').forEach(function(el){
      if (isProtected(el)) return;
      var text = (el.textContent || '').toLowerCase().trim();
      if (text.length < 100 && AD_TEXTS.some(function(t){ return text.indexOf(t) !== -1; })) {
        var style = window.getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'absolute') el.remove();
      }
    });
  }

  var pending = false;
  var observer = new MutationObserver(function(){
    if (pending) return;
    pending = true;
    setTimeout(function(){ pending = false; killAds(); }, 300);
  });

  function init() {
    if (!document.body) return setTimeout(init, 100);
    // Solo childList: observar atributos disparaba el escaneo en cada frame del juego
    observer.observe(document.body, { childList: true, subtree: true });
    killAds();
    setTimeout(killAds, 3000);
  }
  init();
})();
<\/script>`;
}

function buildBodyPatch(type) {
  if (type === 'simpsons') return buildAudioScript();
  return buildAdsScript() + buildAudioScript() + buildGamepadScript();
}

// ═══════════════════════════════════════════════════════════════════════
// ANUNCIOS DEL JUEGO (solo GTA)
// ═══════════════════════════════════════════════════════════════════════
function buildAdsScript() {
  return `<script>
(function(){
  function addAd(id, w, h, key, pos){
    var f = document.createElement('iframe');
    f.id = id; f.className = 'my-ad';
    f.width = w; f.height = h; f.scrolling = 'no';
    f.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);z-index:9000;border:0;' +
      (pos === 'top' ? 'top:8px;' : 'bottom:8px;');
    document.body.appendChild(f);
    var doc = f.contentDocument || (f.contentWindow && f.contentWindow.document);
    if (!doc) return;
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;}</style></head><body>');
    doc.write('<scr' + 'ipt>atOptions={"key":"' + key + '","format":"iframe","height":' + h + ',"width":' + w + ',"params":{}};</scr' + 'ipt>');
    doc.write('<scr' + 'ipt src="https://www.highrevenueformat.com/' + key + '/invoke.js"></scr' + 'ipt>');
    doc.write('</body></html>');
    doc.close();
  }
  function removeAds(){
    document.querySelectorAll('.my-ad').forEach(function(e){ try { e.remove(); } catch(x){} });
  }
  function init(){
    if (!document.body) return setTimeout(init, 50);
    addAd('my-ad-300', 300, 250, 'f49c2e7ae12570d06b9c194497928af0', 'top');
    addAd('my-ad-468', 468, 60, 'f18d77cc1e4b0ecc702e26baff74510e', 'bottom');
    var obs = new MutationObserver(function(){
      var l = document.getElementById('loading');
      if (!l || l.classList.contains('done')) { removeAds(); obs.disconnect(); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    setTimeout(function(){ removeAds(); obs.disconnect(); }, 5 * 60 * 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
<\/script>`;
}

// ═══════════════════════════════════════════════════════════════════════
// AUDIO UNLOCK
// ═══════════════════════════════════════════════════════════════════════
function buildAudioScript() {
  return `<script>
(function(){
  var u = false;
  function resumeAll(){
    try { if (window.__audioContexts) window.__audioContexts.forEach(function(c){ if(c.state==='suspended') c.resume().catch(function(){}); }); } catch(e){}
  }
  function unlock(){
    if (u) return; u = true;
    try {
      resumeAll();
      var ctx = new (window.AudioContext||window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume().catch(function(){});
    } catch(e){}
    var n = 0, iv = setInterval(function(){
      resumeAll();
      if (++n > 20) clearInterval(iv);
    }, 500);
  }
  ['click','pointerdown','keydown','touchstart'].forEach(function(e){
    window.addEventListener(e, unlock, {once:false, capture:true, passive:true});
  });
})();
<\/script>`;
}

// ═══════════════════════════════════════════════════════════════════════
// GAMEPAD + HUD (solo GTA)
// ═══════════════════════════════════════════════════════════════════════
function buildGamepadScript() {
  return `<script>
(function(){
  if (window.__gamepadInjected) return;
  window.__gamepadInjected = true;

  var MODE = 'foot';
  var HUD_HIDE = 3000;
  var hideTimer = null, hideAnim = null;
  var active = false, backAt = 0, backLong = false;

  var MODES = {
    foot: {
      emoji: '🚶', name: 'ON FOOT', accent: '#22c55e', accentSoft: 'rgba(34,197,94,.15)',
      buttons: [
        {key:'STICK L', fn:'Move (WASD)'},{key:'STICK R', fn:'Camera'},
        {key:'L2', fn:'Aim / Fight (Right Click)'},{key:'R2', fn:'Shoot / Punch (Left Click)'},
        {key:'L1', fn:'Weapon Wheel (Tab)'},{key:'R1', fn:'Take Cover (Q)'},
        {key:'A / ✕', fn:'Sprint (Shift)'},{key:'B / ○', fn:'Reload (R)'},
        {key:'X / □', fn:'Jump / Climb (Space)'},{key:'Y / △', fn:'Enter / Exit Vehicle (F)'},
        {key:'L3', fn:'Stealth (CapsLock)'},{key:'R3', fn:'Look Behind (C)'},
        {key:'D-PAD', fn:'Navigation'},{key:'START', fn:'Pause (Esc)'},{key:'BACK', fn:'Switch Mode'}
      ]
    },
    vehicle: {
      emoji: '🚗', name: 'VEHICLE', accent: '#3b82f6', accentSoft: 'rgba(59,130,246,.15)',
      buttons: [
        {key:'STICK L', fn:'Steer (A / D)'},{key:'STICK R', fn:'Camera'},
        {key:'L2', fn:'Brake / Reverse (S)'},{key:'R2', fn:'Accelerate (W)'},
        {key:'L1', fn:'Drive-by Aim (Right Click)'},{key:'R1', fn:'Drive-by Shoot (Left Click)'},
        {key:'A / ✕', fn:'Duck (X)'},{key:'B / ○', fn:'Reload (R)'},
        {key:'X / □', fn:'Handbrake (Space)'},{key:'Y / △', fn:'Exit Vehicle (F)'},
        {key:'L3', fn:'Horn (E)'},{key:'R3', fn:'Rear View (C)'},
        {key:'D-PAD', fn:'Navigation'},{key:'START', fn:'Pause (Esc)'},{key:'BACK', fn:'Switch Mode'}
      ]
    },
    air: {
      emoji: '✈️', name: 'AIRCRAFT', accent: '#f97316', accentSoft: 'rgba(249,115,22,.15)',
      buttons: [
        {key:'STICK L ↑', fn:'Descend (Num 8)'},{key:'STICK L ↓', fn:'Ascend (Num 5)'},
        {key:'STICK L ←', fn:'Roll Left (Num 4)'},{key:'STICK L →', fn:'Roll Right (Num 6)'},
        {key:'STICK R', fn:'Camera'},
        {key:'L2', fn:'Throttle Down (S)'},{key:'R2', fn:'Throttle Up (W)'},
        {key:'L1', fn:'Yaw Left (A)'},{key:'R1', fn:'Yaw Right (D)'},
        {key:'A / ✕', fn:'Change Weapon (Tab)'},{key:'B / ○', fn:'Reload (R)'},
        {key:'X / □', fn:'Fire (Space)'},{key:'Y / △', fn:'Exit Aircraft (F)'},
        {key:'L3', fn:'Landing Gear (G)'},{key:'R3', fn:'Look Behind (C)'},
        {key:'START', fn:'Pause (Esc)'},{key:'BACK', fn:'Switch Mode'}
      ]
    }
  };

  var MAP_FOOT    = {0:'ShiftLeft',1:'KeyR',2:'Space',3:'KeyF',4:'Tab',5:'KeyQ',9:'Escape',10:'CapsLock',11:'KeyC',12:'ArrowUp',13:'KeyZ',14:'KeyG',15:'KeyE'};
  var MAP_VEHICLE = {0:'KeyX',1:'KeyR',2:'Space',3:'KeyF',9:'Escape',10:'KeyE',11:'KeyC',12:'ArrowUp',13:'KeyZ',14:'ArrowLeft',15:'KeyH'};
  var MAP_AIR     = {0:'Tab',1:'KeyR',2:'Space',3:'KeyF',4:'KeyA',5:'KeyD',9:'Escape',10:'KeyG',11:'KeyC',12:'ArrowUp',13:'KeyZ',14:'KeyQ',15:'KeyE'};
  var MODE_MAP = {foot:MAP_FOOT, vehicle:MAP_VEHICLE, air:MAP_AIR};

  var SENS = 29, DZ = 0.12, TT = 0.25, BT = 400;
  var held = new Set();
  var lm = false, rm = false;
  var lastLock = 0;

  var KC = {'ShiftLeft':16,'KeyR':82,'Space':32,'KeyF':70,'Tab':9,'KeyQ':81,'Escape':27,'CapsLock':20,'KeyC':67,'ArrowUp':38,'ArrowDown':40,'ArrowLeft':37,'ArrowRight':39,'KeyZ':90,'KeyG':71,'KeyE':69,'KeyW':87,'KeyA':65,'KeyS':83,'KeyD':68,'KeyX':88,'KeyH':72,'Numpad4':100,'Numpad5':101,'Numpad6':102,'Numpad8':104,'Backspace':8};
  var KCh = {'ShiftLeft':'Shift','Space':' ','Tab':'Tab','Escape':'Escape','CapsLock':'CapsLock','ArrowUp':'ArrowUp','ArrowDown':'ArrowDown','ArrowLeft':'ArrowLeft','ArrowRight':'ArrowRight','Backspace':'Backspace','KeyA':'a','KeyC':'c','KeyD':'d','KeyE':'e','KeyF':'f','KeyG':'g','KeyH':'h','KeyQ':'q','KeyR':'r','KeyS':'s','KeyW':'w','KeyX':'x','KeyZ':'z','Numpad4':'4','Numpad5':'5','Numpad6':'6','Numpad8':'8'};

  function mk(t,c){
    var e = new KeyboardEvent(t, {code:c, key:KCh[c]||c, bubbles:true, cancelable:true, view:window});
    try {
      Object.defineProperty(e,'keyCode',{get:function(){return KC[c]||0;}});
      Object.defineProperty(e,'which',{get:function(){return KC[c]||0;}});
    } catch(x){}
    return e;
  }
  function pk(c){ if(held.has(c))return; held.add(c); window.dispatchEvent(mk('keydown',c)); document.dispatchEvent(mk('keydown',c)); }
  function rk(c){ if(!held.has(c))return; held.delete(c); window.dispatchEvent(mk('keyup',c)); document.dispatchEvent(mk('keyup',c)); }
  function rAll(){ held.forEach(function(k){ window.dispatchEvent(mk('keyup',k)); document.dispatchEvent(mk('keyup',k)); }); held.clear(); }

  function gc(){ return document.getElementById('canvas'); }

  // Throttle: sin gesto de usuario el navegador rechaza el lock; antes se intentaba en cada frame
  function lock(force){
    var c = gc(); if(!c || document.pointerLockElement === c) return;
    var now = Date.now();
    if (!force && now - lastLock < 500) return;
    lastLock = now;
    try {
      var p = c.requestPointerLock({unadjustedMovement:true});
      if (p && p.catch) p.catch(function(){ try{c.requestPointerLock();}catch(x){} });
    } catch(x){ try{c.requestPointerLock();}catch(y){} }
  }
  function mv(dx,dy){
    if (!dx && !dy) return;
    var c = gc(); if (!c) return;
    if (document.pointerLockElement !== c) lock();
    var e = new MouseEvent('mousemove', {bubbles:true,cancelable:true,view:window,movementX:dx,movementY:dy,clientX:(c.clientWidth/2)|0,clientY:(c.clientHeight/2)|0});
    try{window.dispatchEvent(e);}catch(x){}
    try{document.dispatchEvent(e);}catch(x){}
    try{c.dispatchEvent(e);}catch(x){}
  }
  function hm(w){
    var c = gc(); if(!c) return;
    if (w==='left' && lm) return;
    if (w==='right' && rm) return;
    if (w==='left') lm=true; else rm=true;
    var bc = w==='left'?0:2, bm = w==='left'?1:2;
    c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window,button:bc,buttons:bm,clientX:(c.clientWidth/2)|0,clientY:(c.clientHeight/2)|0}));
  }
  function rmv(w){
    var c = gc(); if(!c) return;
    if (w==='left' && !lm) return;
    if (w==='right' && !rm) return;
    if (w==='left') lm=false; else rm=false;
    var bc = w==='left'?0:2;
    c.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window,button:bc,buttons:0,clientX:(c.clientWidth/2)|0,clientY:(c.clientHeight/2)|0}));
  }
  function releaseMouse(){ if(lm) rmv('left'); if(rm) rmv('right'); }

  function sty(){
    if (document.getElementById('__gp_style')) return;
    var s = document.createElement('style'); s.id='__gp_style';
    s.textContent =
      '@keyframes gp-fadeIn{from{opacity:0;transform:translateY(10px) scale(.97);}to{opacity:1;transform:translateY(0) scale(1);}}' +
      '@keyframes gp-fadeOut{from{opacity:1;transform:translateY(0) scale(1);}to{opacity:0;transform:translateY(10px) scale(.97);}}' +
      '#__gp_hud{position:fixed;left:14px;bottom:14px;z-index:9500;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:12px;line-height:1.4;color:#fff;max-width:420px;filter:drop-shadow(0 10px 24px rgba(0,0,0,.5));}' +
      '#__gp_hud.gp-show{animation:gp-fadeIn .35s cubic-bezier(.16,1,.3,1) forwards;}' +
      '#__gp_hud.gp-hide{animation:gp-fadeOut .35s cubic-bezier(.16,1,.3,1) forwards;}' +
      '#__gp_btn{position:fixed;left:14px;bottom:14px;z-index:9501;width:52px;height:52px;border-radius:50%;background:linear-gradient(145deg,rgba(18,18,24,.94),rgba(28,28,38,.90));backdrop-filter:blur(16px) saturate(180%);-webkit-backdrop-filter:blur(16px) saturate(180%);border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 24px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.10);display:flex;align-items:center;justify-content:center;font-size:24px;cursor:pointer;pointer-events:auto;user-select:none;}' +
      '#__gp_btn.gp-hidden{display:none;}';
    document.head.appendChild(s);
  }

  function ch(){ sty(); var h = document.getElementById('__gp_hud'); if(h) return h; h = document.createElement('div'); h.id='__gp_hud'; document.body.appendChild(h); return h; }
  function cb(){ sty(); var b = document.getElementById('__gp_btn'); if(b) return b; b = document.createElement('div'); b.id='__gp_btn'; b.textContent='🎮'; b.addEventListener('click',function(e){e.stopPropagation();brief();}); document.body.appendChild(b); return b; }

  function render(){
    var hud = ch(), m = MODES[MODE], rows='';
    m.buttons.forEach(function(btn,i){
      var last = i === m.buttons.length - 1;
      rows += '<div style="display:flex;align-items:center;gap:10px;padding:5px 0;'+(last?'':'border-bottom:1px solid rgba(255,255,255,.05);')+'"><span style="flex-shrink:0;min-width:86px;display:inline-flex;align-items:center;justify-content:center;background:'+m.accentSoft+';border:1px solid '+m.accent+'50;color:'+m.accent+';padding:3px 9px;border-radius:6px;font-size:10px;font-weight:700;font-family:Consolas,monospace;white-space:nowrap;">'+btn.key+'</span><span style="color:rgba(255,255,255,.88);font-size:11.5px;">'+btn.fn+'</span></div>';
    });
    hud.innerHTML = '<div style="position:relative;background:linear-gradient(145deg,rgba(18,18,24,.94) 0%,rgba(28,28,38,.90) 100%);backdrop-filter:blur(16px) saturate(180%);-webkit-backdrop-filter:blur(16px) saturate(180%);border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:14px 16px;box-shadow:0 12px 40px rgba(0,0,0,.5);overflow:hidden;"><div style="position:absolute;left:0;top:16px;bottom:16px;width:3px;background:'+m.accent+';border-radius:0 4px 4px 0;box-shadow:0 0 16px '+m.accent+'80;"></div><div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;padding-left:8px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,.08);"><div style="width:42px;height:42px;border-radius:12px;background:'+m.accentSoft+';border:1px solid '+m.accent+'40;display:flex;align-items:center;justify-content:center;font-size:22px;">'+m.emoji+'</div><div style="flex:1;"><div style="font-size:9.5px;letter-spacing:2.5px;color:'+m.accent+';font-weight:700;opacity:.8;">CONTROLLER</div><div style="font-size:17px;font-weight:700;color:#fff;">'+m.name+'</div></div></div><div style="padding-left:8px;">'+rows+'</div><div style="padding:10px 8px 0;margin-top:6px;border-top:1px solid rgba(255,255,255,.08);font-size:10.5px;color:rgba(255,255,255,.55);"><span style="display:inline-flex;align-items:center;gap:5px;background:'+m.accentSoft+';border:1px solid '+m.accent+'60;color:'+m.accent+';padding:2px 9px;border-radius:6px;font-weight:700;font-size:9.5px;">⟵ BACK</span> <span>switch mode</span></div></div>';
  }

  function show(){
    if(!active) return;
    var h=ch(), b=document.getElementById('__gp_btn');
    // Si había un ocultado en curso, se cancela (antes podía esconder el HUD recién mostrado)
    if (hideAnim) { clearTimeout(hideAnim); hideAnim = null; }
    if(b) b.classList.add('gp-hidden');
    h.classList.remove('gp-hide'); h.classList.add('gp-show'); h.style.display='block';
  }
  function hide(){
    var h=document.getElementById('__gp_hud'), b=document.getElementById('__gp_btn');
    if(b) b.classList.remove('gp-hidden');
    if(h){
      h.classList.remove('gp-show'); h.classList.add('gp-hide');
      if (hideAnim) clearTimeout(hideAnim);
      hideAnim = setTimeout(function(){
        hideAnim = null;
        var hh = document.getElementById('__gp_hud');
        if(hh) hh.style.display='none';
      },350);
    }
  }
  function brief(){ if(!active) return; render(); show(); if(hideTimer) clearTimeout(hideTimer); hideTimer = setTimeout(hide, HUD_HIDE); }
  function destroy(){
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (hideAnim) { clearTimeout(hideAnim); hideAnim = null; }
    var h=document.getElementById('__gp_hud'), b=document.getElementById('__gp_btn');
    if(h) try{h.remove();}catch(e){}
    if(b) try{b.remove();}catch(e){}
  }

  function releaseAll(){
    rAll(); releaseMouse();
    backAt = 0; backLong = false;
  }

  function toggle(){
    rAll(); releaseMouse();
    MODE = MODE === 'foot' ? 'vehicle' : MODE === 'vehicle' ? 'air' : 'foot';
    brief(); lock();
  }

  function poll(){
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    var gp = null;
    for (var i=0;i<pads.length;i++) if(pads[i] && pads[i].connected){gp=pads[i];break;}

    if (gp && !active) { active=true; cb(); brief(); }
    else if (!gp && active) { active=false; destroy(); rAll(); releaseMouse(); }

    // Sin foco (alt-tab, otra ventana encima) no se envía input y se suelta todo
    var focused = !document.hidden && document.hasFocus();
    if (gp && !focused && (held.size || lm || rm || backAt)) releaseAll();

    if (gp && focused) {
      var map = MODE_MAP[MODE];

      gp.buttons.forEach(function(b,i){
        if (i===8) {
          if (b.pressed && backAt===0) { backAt=Date.now(); backLong=false; }
          else if (b.pressed && backAt>0) { if (!backLong && Date.now()-backAt>BT) { backLong=true; pk('Backspace'); } }
          else if (!b.pressed && backAt>0) {
            var d = Date.now()-backAt;
            if (!backLong && d<BT) toggle();
            if (backLong) rk('Backspace');
            backAt=0; backLong=false;
          }
          return;
        }
        var code = map[i];
        if (!code) return;
        if (b.pressed) pk(code); else rk(code);
      });

      var ltV = gp.buttons[6] ? (gp.buttons[6].value||0) : 0;
      var rtV = gp.buttons[7] ? (gp.buttons[7].value||0) : 0;
      var ltOn = ltV>TT, rtOn = rtV>TT;

      if (MODE==='foot') {
        if (ltOn) hm('right'); else rmv('right');
        if (rtOn) hm('left'); else rmv('left');
      } else {
        if (rtOn) pk('KeyW'); else rk('KeyW');
        if (ltOn) pk('KeyS'); else rk('KeyS');
      }

      // Vehículo: L1 / R1 = apuntar / disparar (el HUD lo anunciaba pero no estaba implementado)
      if (MODE==='vehicle') {
        var l1 = gp.buttons[4] && gp.buttons[4].pressed;
        var r1 = gp.buttons[5] && gp.buttons[5].pressed;
        if (l1) hm('right'); else rmv('right');
        if (r1) hm('left'); else rmv('left');
      }

      var lx = gp.axes[0]||0, ly = gp.axes[1]||0;

      if (MODE==='air') {
        if (Math.abs(lx)>DZ) { if(lx>0){pk('Numpad6');rk('Numpad4');} else {pk('Numpad4');rk('Numpad6');} }
        else { rk('Numpad4'); rk('Numpad6'); }
      } else {
        if (Math.abs(lx)>DZ) { if(lx>0){pk('KeyD');rk('KeyA');} else {pk('KeyA');rk('KeyD');} }
        else { rk('KeyA'); rk('KeyD'); }
      }

      if (MODE==='foot') {
        if (Math.abs(ly)>DZ) { if(ly>0){pk('KeyS');rk('KeyW');} else {pk('KeyW');rk('KeyS');} }
        else { rk('KeyW'); rk('KeyS'); }
      } else if (MODE==='air') {
        if (Math.abs(ly)>DZ) { if(ly>0){pk('Numpad5');rk('Numpad8');} else {pk('Numpad8');rk('Numpad5');} }
        else { rk('Numpad5'); rk('Numpad8'); }
      }

      var rx = gp.axes[2]||0, ry = gp.axes[3]||0;
      var curve = function(v){ return Math.sign(v)*v*v; };
      if (Math.abs(rx)>DZ) mv(curve(rx)*SENS, 0);
      if (Math.abs(ry)>DZ) mv(0, curve(ry)*SENS);
    }
    requestAnimationFrame(poll);
  }
  requestAnimationFrame(poll);

  window.addEventListener('gamepadconnected', function(){
    active=true; cb(); brief();
    var c = gc();
    if (c) {
      c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));
      setTimeout(function(){ c.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0})); }, 30);
      setTimeout(function(){ lock(true); }, 200);
      setTimeout(function(){ lock(true); }, 600);
      setTimeout(function(){ lock(true); }, 1500);
    }
  });
  window.addEventListener('gamepaddisconnected', function(){
    active=false; destroy(); rAll(); releaseMouse();
  });

  function wire(){
    var c=gc(); if(!c||c.__gpWired) return;
    c.__gpWired=true;
    // Envuelto para no pasar el evento como argumento "force"
    c.addEventListener('mousedown', function(){ lock(true); });
    c.addEventListener('click', function(){ lock(true); });
  }
  wire(); setInterval(wire, 2000);

  // En pestañas ocultas requestAnimationFrame se pausa, así que hay que soltar aquí
  window.addEventListener('blur', function(){
    // setTimeout 0: si el foco solo pasó a un iframe (ad) hasFocus() sigue true y no se suelta nada
    setTimeout(function(){ if (document.hidden || !document.hasFocus()) releaseAll(); }, 0);
  });
  document.addEventListener('visibilitychange', function(){ if (document.hidden) releaseAll(); });
  window.addEventListener('pagehide', releaseAll);

  window.__gamepad = {toggle:toggle, getMode:function(){return MODE;}, isConnected:function(){return active;}};
})();
<\/script>`;
}
