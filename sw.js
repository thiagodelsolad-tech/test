// ═══════════════════════════════════════════════════════════════════════
// Service Worker Proxy — GTA V + Simpsons + Cyberpunk
// ═══════════════════════════════════════════════════════════════════════

const WORKER_URL = 'https://games-proxy.thiagodelsolad.workers.dev'; 

const ORIGIN_GTA = 'https://fiveplay.lol';
const CYBERPUNK_URL = 'https://cyberpunk2077.lol/game?ioShared=1&ioSharedMB=128&ioInflight=4&ioPersist=1&ioPersistMB=6144&binkRecycle=1&psoWarm=0&skipIntro=1&ioLookahead=16&behindLoad=0&floodKeep=1';

const GTA_PREFIXES = ['/b/', '/game/', '/data/', '/audio/', '/x64/', '/log', '/loader.js', '/prejs.js', '/wgpu_worker.js', '/io_worker.js', '/audio-worklet.js', '/sw2.js'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function isOwnStatic(path) {
  return path === '/' || path === '/index.html' || path.startsWith('/img/') || path === '/favicon.ico';
}

function matchesGta(path) {
  return GTA_PREFIXES.some(p => p.endsWith('/') ? path.startsWith(p) : path === p);
}

function isGamePage(path, base) {
  return path === base || path === base + '/' || path === base + '/index.html';
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Si es un recurso estático propio, no hacer nada
  if (url.origin === self.location.origin && isOwnStatic(url.pathname)) return;
  
  event.respondWith(handleFetch(event, url));
});

async function detectMode(event) {
  const check = (u) => {
    if (!u) return null;
    if (u.indexOf('/gta5') !== -1) return 'gta';
    if (u.indexOf('/simpsons') !== -1) return 'simpsons';
    if (u.indexOf('/cyberpunk') !== -1) return 'cyberpunk';
    return null;
  };
  if (event.clientId) {
    try {
      const client = await self.clients.get(event.clientId);
      const m = client && check(client.url);
      if (m) return m;
    } catch (e) {}
  }
  return check(event.request.referrer);
}

async function handleFetch(event, url) {
  const path = url.pathname;
  
  // ── 1. INTERCEPTAR PETICIONES EXTERNAS DE CYBERPUNK ──
  if (url.hostname.includes('part.fn-web-worker.workers.dev')) {
    return proxyViaWorker(event.request, '/cyberpunk-cdn' + path + url.search);
  }

  // ── 2. PÁGINAS DE JUEGO LOCALES (Bootstrap) ──
  if (isGamePage(path, '/gta5')) return serveGameHTML(ORIGIN_GTA, 'gta');
  if (isGamePage(path, '/simpsons')) return serveGameHTML(WORKER_URL + '/simpsons/', 'simpsons');
  if (isGamePage(path, '/cyberpunk')) return serveGameHTML(WORKER_URL + '/cyberpunk/game', 'cyberpunk');

  let mode = await detectMode(event);
  let assetPath = path;

  const m = path.match(/^\/(gta5|simpsons|cyberpunk)(\/.*)$/);
  if (m) {
    mode = mode || (m[1] === 'gta5' ? 'gta' : m[1] === 'simpsons' ? 'simpsons' : 'cyberpunk');
    assetPath = m[2];
  }

  // ── 3. ASSETS ──
  if ((mode === 'gta' || mode === null) && matchesGta(assetPath)) {
    return proxyAssetDirect(event.request, ORIGIN_GTA, assetPath);
  }

  if (mode === 'simpsons') {
    return proxyViaWorker(event.request, '/simpsons' + assetPath + url.search);
  }

  // Cualquier otra petición de Cyberpunk (build, api, cdn, etc.)
  if (mode === 'cyberpunk' || path.startsWith('/api/') || path.startsWith('/build/')) {
    return proxyViaWorker(event.request, '/cyberpunk' + path + url.search);
  }

  return fetch(event.request);
}

// ═══════════════════════════════════════════════════════════════════════
// PROXIES
// ═══════════════════════════════════════════════════════════════════════
async function proxyViaWorker(request, targetPath) {
  try {
    const reqHeaders = new Headers(request.headers);
    const range = request.headers.get('range');
    if (range) reqHeaders.set('Range', range);

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

    return await fetch(WORKER_URL + targetPath, {
      method: request.method,
      headers: reqHeaders,
      body: hasBody ? await request.arrayBuffer() : undefined,
    });
  } catch (e) {
    return new Response('Worker error: ' + e.message, { status: 502 });
  }
}

async function proxyAssetDirect(request, origin, assetPath) {
  const url = new URL(request.url);
  const target = origin + assetPath + url.search;

  if (assetPath === '/sw2.js') {
    return new Response('self.addEventListener("install",()=>self.skipWaiting());', { headers: { 'Content-Type': 'application/javascript' } });
  }

  try {
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const reqHeaders = new Headers();
    const range = request.headers.get('range');
    if (range) reqHeaders.set('Range', range);

    const upstream = await fetch(target, {
      method: request.method, headers: reqHeaders, mode: 'cors', credentials: 'omit', redirect: 'follow',
      body: hasBody ? await request.arrayBuffer() : undefined,
    });

    const headers = new Headers();
    ['content-type', 'content-range', 'accept-ranges', 'last-modified', 'etag'].forEach(k => {
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

    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    return new Response('Proxy error: ' + e.message, { status: 502 });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HTML DEL JUEGO (SIN REESCRITURA DE RUTAS para no romper relativos)
// ═══════════════════════════════════════════════════════════════════════
async function serveGameHTML(origin, type) {
  try {
    let targetUrl = origin + '/';
    if (type === 'simpsons') targetUrl = origin + '?skipmovie';
    if (type === 'cyberpunk') targetUrl = CYBERPUNK_URL;

    const upstream = await fetch(targetUrl, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-cache' });
    if (!upstream.ok) return new Response('Error ' + upstream.status, { status: 502 });

    let html = await upstream.text();
    
    const headPatch = buildHeadPatch(type);
    const bodyPatch = buildBodyPatch(type);

    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + headPatch);
    else html = headPatch + html;

    const idx = html.toLowerCase().lastIndexOf('</body>');
    if (idx !== -1) html = html.slice(0, idx) + bodyPatch + html.slice(idx);
    else html += bodyPatch;

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
    return new Response('Error: ' + e.message, { status: 502 });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PATCHES (Ads, Audio, Gamepad)
// ═══════════════════════════════════════════════════════════════════════
function buildHeadPatch(type) {
  if (type !== 'gta') return '';
  return `<script>
(function(){
  var BLOCKED = ['alwingulla.com','quge5.com','monetag','profit','adsterra','popads','popcash','hilltopads'];
  function isBlocked(v){ if (!v) return false; v = String(v); return BLOCKED.some(function(b){ return v.indexOf(b) !== -1; }); }
  var _srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
  if (_srcDesc && _srcDesc.set) {
    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
      get: _srcDesc.get,
      set: function(v){ if (isBlocked(v)) return; _srcDesc.set.call(this, v); },
      configurable: true, enumerable: _srcDesc.enumerable
    });
  }
  var _setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value){
    if (this.tagName === 'SCRIPT' && String(name).toLowerCase() === 'src' && isBlocked(value)) return;
    return _setAttr.call(this, name, value);
  };
  var AD_SELECTORS = ['[id*="adsterra"]', '[class*="adsterra"]', '[id*="popads"]', '[id*="popcash"]', '[id*="monetag"]', '[class*="monetag"]', 'iframe[src*="profit"]', 'iframe[src*="adsterra"]', 'iframe[src*="highrevenue"]', 'iframe[src*="monetag"]'];
  var AD_TEXTS = ['new message', 'play now', 'hot new game', 'click here', 'sponsored'];
  function isProtected(el){
    if (el.id === 'canvas' || el.id === '__gp_hud' || el.id === '__gp_btn') return true;
    if (el.closest && el.closest('#loading, #__gp_hud, #__gp_btn, .my-ad')) return true;
    if (el.className && typeof el.className === 'string' && el.className.indexOf('my-ad') !== -1) return true;
    return false;
  }
  function killAds() {
    AD_SELECTORS.forEach(function(sel){ try { document.querySelectorAll(sel).forEach(function(el){ if (!isProtected(el)) el.remove(); }); } catch(e){} });
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
  var observer = new MutationObserver(function(){ if (pending) return; pending = true; setTimeout(function(){ pending = false; killAds(); }, 300); });
  function init() { if (!document.body) return setTimeout(init, 100); observer.observe(document.body, { childList: true, subtree: true }); killAds(); setTimeout(killAds, 3000); }
  init();
})();
<\/script>`;
}

function buildBodyPatch(type) {
  if (type === 'simpsons' || type === 'cyberpunk') return buildAudioScript();
  return buildAdsScript() + buildAudioScript() + buildGamepadScript();
}

function buildAdsScript() {
  return `<script>
(function(){
  function addAd(id, w, h, key, pos){
    var f = document.createElement('iframe'); f.id = id; f.className = 'my-ad'; f.width = w; f.height = h; f.scrolling = 'no';
    f.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);z-index:9000;border:0;' + (pos === 'top' ? 'top:8px;' : 'bottom:8px;');
    document.body.appendChild(f);
    var doc = f.contentDocument || (f.contentWindow && f.contentWindow.document); if (!doc) return;
    doc.open(); doc.write('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;}</style></head><body>');
    doc.write('<scr' + 'ipt>atOptions={"key":"' + key + '","format":"iframe","height":' + h + ',"width":' + w + ',"params":{}};</scr' + 'ipt>');
    doc.write('<scr' + 'ipt src="https://www.highrevenueformat.com/' + key + '/invoke.js"></scr' + 'ipt>'); doc.write('</body></html>'); doc.close();
  }
  function removeAds(){ document.querySelectorAll('.my-ad').forEach(function(e){ try { e.remove(); } catch(x){} }); }
  function init(){
    if (!document.body) return setTimeout(init, 50);
    addAd('my-ad-300', 300, 250, 'f49c2e7ae12570d06b9c194497928af0', 'top');
    addAd('my-ad-468', 468, 60, 'f18d77cc1e4b0ecc702e26baff74510e', 'bottom');
    var obs = new MutationObserver(function(){ var l = document.getElementById('loading'); if (!l || l.classList.contains('done')) { removeAds(); obs.disconnect(); } });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    setTimeout(function(){ removeAds(); obs.disconnect(); }, 5 * 60 * 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
<\/script>`;
}

function buildAudioScript() {
  return `<script>
(function(){
  var u = false;
  function resumeAll(){ try { if (window.__audioContexts) window.__audioContexts.forEach(function(c){ if(c.state==='suspended') c.resume().catch(function(){}); }); } catch(e){} }
  function unlock(){
    if (u) return; u = true; try { resumeAll(); var ctx = new (window.AudioContext||window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume().catch(function(){}); } catch(e){}
    var n = 0, iv = setInterval(function(){ resumeAll(); if (++n > 20) clearInterval(iv); }, 500);
  }
  ['click','pointerdown','keydown','touchstart'].forEach(function(e){ window.addEventListener(e, unlock, {once:false, capture:true, passive:true}); });
})();
<\/script>`;
}

function buildGamepadScript() {
  return `<script>
  // ⬇️⬇️⬇️ PEGA AQUÍ TU CÓDIGO COMPLETO DEL GAMEPAD ⬇️⬇️⬇️
  <\/script>`;
}
