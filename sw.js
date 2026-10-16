// ═══════════════════════════════════════════════════════════════════════
// Service Worker Proxy — GTA V + Simpsons
// ═══════════════════════════════════════════════════════════════════════

const ORIGIN_GTA = 'https://fiveplay.lol';
const ORIGIN_SIMPSONS = 'https://simpsons-proxy.kitofree1221.workers.dev';

const GTA_PREFIXES = [
  '/b/', '/game/', '/data/', '/audio/', '/x64/',
  '/log', '/loader.js', '/prejs.js', '/wgpu_worker.js',
  '/io_worker.js', '/audio-worklet.js', '/sw2.js',
];

const SIMPSONS_CACHE = 'simpsons-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  event.respondWith(handleFetch(event));
});

async function handleFetch(event) {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return fetch(event.request);

  const path = url.pathname;

  // ── Estáticos propios: pasar directo ──
  if (path === '/' || path === '/index.html' ||
      path.startsWith('/img/') ||
      path === '/favicon.ico') {
    return fetch(event.request);
  }

  // ── Detectar de qué juego viene la petición ──
  let mode = null;
  if (event.clientId) {
    try {
      const client = await self.clients.get(event.clientId);
      if (client && client.url) {
        if (client.url.indexOf('/gta5') !== -1) mode = 'gta';
        else if (client.url.indexOf('/simpsons') !== -1) mode = 'simpsons';
      }
    } catch (e) {}
  }

  // ── Páginas de juego ──
  if (path === '/gta5' || path === '/gta5/' || path === '/gta5/index.html') {
    return serveGameHTML(ORIGIN_GTA, 'gta');
  }
  if (path === '/simpsons' || path === '/simpsons/' || path === '/simpsons/index.html') {
    return serveGameHTML(ORIGIN_SIMPSONS, 'simpsons');
  }

  // ── Assets por juego ──
  if (mode === 'gta') {
    if (GTA_PREFIXES.some(p => path.startsWith(p))) {
      return proxyAsset(event.request, ORIGIN_GTA);
    }
  }

  if (mode === 'simpsons') {
    // Cualquier otro path del juego → al Worker con caché SW
    return fetchWithSWCache(event.request);
  }

  // ── Fallback: GTA paths conocidos ──
  if (GTA_PREFIXES.some(p => path.startsWith(p))) {
    return proxyAsset(event.request, ORIGIN_GTA);
  }

  return fetch(event.request);
}

// ═══════════════════════════════════════════════════════════════════════
// Cache SW para Simpsons (evita llamar al Worker más de 1 vez por asset)
// ═══════════════════════════════════════════════════════════════════════
async function fetchWithSWCache(request) {
  try {
    const cache = await caches.open(SIMPSONS_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;

    const response = await fetch(request);
    if (response.ok && request.method === 'GET') {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (e) {
    return new Response('SW cache error: ' + e.message, { status: 502 });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Proxy de assets (GTA)
// ═══════════════════════════════════════════════════════════════════════
async function proxyAsset(request, origin) {
  const url = new URL(request.url);
  const target = origin + url.pathname + url.search;

  if (url.pathname === '/sw2.js') {
    return new Response('self.addEventListener("install",()=>self.skipWaiting());', {
      headers: { 'Content-Type': 'application/javascript' }
    });
  }

  try {
    const upstream = await fetch(target, {
      method: request.method,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-cache',
      redirect: 'follow',
      body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
    });

    const headers = new Headers();
    ['content-type','content-length','content-encoding','content-range',
     'accept-ranges','last-modified','etag','cache-control'].forEach(k => {
      const v = upstream.headers.get(k);
      if (v) headers.set(k, v);
    });

    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    headers.set('Access-Control-Allow-Origin', '*');

    const p = url.pathname.toLowerCase();
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
    return new Response('Proxy error: ' + e.message, { status: 502 });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HTML DEL JUEGO (común para GTA y Simpsons)
// ═══════════════════════════════════════════════════════════════════════
async function serveGameHTML(origin, type) {
  try {
    const targetUrl = type === 'simpsons' ? origin + '/?skipmovie' : origin + '/';

    const upstream = await fetch(targetUrl, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-cache',
    });

    let html = await upstream.text();

    // ── Limpieza de anuncios SOLO para GTA ──
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

    if (html.indexOf('<head>') !== -1) {
      html = html.replace('<head>', '<head>' + headPatch);
    }
    if (html.indexOf('</body>') !== -1) {
      html = html.replace('</body>', bodyPatch + '</body>');
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
    return new Response(
      '<!doctype html><meta charset="utf-8"><style>body{background:#0e1419;color:#8ba6bf;font:14px Arial;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style><div>Error cargando juego: ' + e.message + '</div>',
      { status: 502, headers: { 'Content-Type': 'text/html' } }
    );
  }
}

function buildHeadPatch(type) {
  if (type === 'simpsons') return '';

  return `<script>
(function(){
  var _create = document.createElement.bind(document);
  var _srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
  var BLOCKED = ['alwingulla.com', 'quge5.com', 'monetag'];
  document.createElement = function(tag){
    var el = _create(tag);
    if (tag && tag.toLowerCase() === 'script') {
      Object.defineProperty(el, 'src', {
        set: function(v){
          if (v && BLOCKED.some(function(b){ return v.indexOf(b) !== -1; })) return;
          _srcDesc.set.call(this, v);
        },
        get: function(){ return _srcDesc.get.call(this); },
        configurable: true
      });
    }
    return el;
  };
})();
<\/script>`;
}

function buildBodyPatch(type) {
  if (type === 'simpsons') {
    return buildAudioScript();
  }
  return buildAdsScript() + buildAudioScript() + buildGamepadScript();
}

// ═══════════════════════════════════════════════════════════════════════
// ADS del juego (solo GTA)
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
    var doc = f.contentDocument || f.contentWindow.document;
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;}</style></head><body>');
    doc.write('<scr' + 'ipt>atOptions={"key":"' + key + '","format":"iframe","height":' + h + ',"width":' + w + ',"params":{}};</scr' + 'ipt>');
    doc.write('<scr' + 'ipt src="https://www.highrevenueformat.com/' + key + '/invoke.js"></scr' + 'ipt>');
    doc.write('</body></html>');
    doc.close();
  }
  function rm(){
    document.querySelectorAll('.my-ad').forEach(function(e){ try { e.remove(); } catch(x){} });
  }
  function init(){
    if (!document.body) return setTimeout(init, 50);
    addAd('my-ad-300', 300, 250, 'f49c2e7ae12570d06b9c194497928af0', 'top');
    addAd('my-ad-468', 468, 60, 'f18d77cc1e4b0ecc702e26baff74510e', 'bottom');
    var obs = new MutationObserver(function(){
      var l = document.getElementById('loading');
      if (!l || l.classList.contains('done')) { rm(); obs.disconnect(); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    setTimeout(function(){ rm(); obs.disconnect(); }, 5 * 60 * 1000);
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
  function unlock(){
    if (u) return; u = true;
    try {
      if (window.__audioContexts) window.__audioContexts.forEach(function(c){ if(c.state==='suspended') c.resume().catch(function(){}); });
      var ctx = new (window.AudioContext||window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume().catch(function(){});
    } catch(e){}
    var n = 0, iv = setInterval(function(){
      try { if (window.__audioContexts) window.__audioContexts.forEach(function(c){ if(c.state==='suspended') c.resume().catch(function(){}); }); } catch(e){}
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
// GAMEPAD (solo GTA)
// ═══════════════════════════════════════════════════════════════════════
function buildGamepadScript() {
  // ⚠️ AQUÍ PEGA EL CÓDIGO COMPLETO DEL GAMEPAD QUE YA TENÍAS
  // Debe empezar con: (function(){ if (window.__gamepadInjected) return; ...
  // Y terminar con: })();
  return `<script>/* ... TU CÓDIGO DEL GAMEPAD AQUÍ ... */<\/script>`;
}
