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
  
  // Ignorar solo lo que es estrictamente de nuestro dominio (html, css, imagenes)
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
  
  // ── 1. INTERCEPTAR EL CDN EXTERNO DE CYBERPUNK (WASM) ──
  if (url.hostname.includes('part.fn-web-worker.workers.dev')) {
    return proxyViaWorker(event.request, '/cyberpunk-cdn' + path + url.search);
  }

  // ── 2. Páginas de juego locales ──
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

  // ── 3. Assets ──
  if ((mode === 'gta' || mode === null) && matchesGta(assetPath)) {
    return proxyAssetDirect(event.request, ORIGIN_GTA, assetPath);
  }

  if (mode === 'simpsons') {
    return proxyViaWorker(event.request, '/simpsons' + assetPath + url.search);
  }

  if (mode === 'cyberpunk' || path.startsWith('/api/') || path.startsWith('/play/')) {
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
// HTML DEL JUEGO
// ═══════════════════════════════════════════════════════════════════════
async function serveGameHTML(origin, type) {
  try {
    let targetUrl = origin + '/';
    if (type === 'simpsons') targetUrl = origin + '?skipmovie';
    if (type === 'cyberpunk') targetUrl = CYBERPUNK_URL;

    const upstream = await fetch(targetUrl, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-cache' });
    if (!upstream.ok) return new Response('Error ' + upstream.status, { status: 502 });

    let html = await upstream.text();
    
    // Reescribir rutas absolutas para forzar que pasen por el Worker
    if (type === 'simpsons' || type === 'cyberpunk') {
       const workerBase = WORKER_URL + (type === 'simpsons' ? '/simpsons' : '/cyberpunk');
       html = html.replace(/src="\/(?!\/)(.*?)"/g, 'src="' + workerBase + '/$1"');
       html = html.replace(/href="\/(?!\/)(.*?)"/g, 'href="' + workerBase + '/$1"');
    }

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

    if (gp) {
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

  window.addEventListener('blur', function(){
    setTimeout(function(){ if (document.hidden || !document.hasFocus()) { rAll(); releaseMouse(); } }, 0);
  });
  document.addEventListener('visibilitychange', function(){ if (document.hidden) { rAll(); releaseMouse(); } });

  function wire(){
    var c=gc(); if(!c||c.__gpWired) return;
    c.__gpWired=true;
    c.addEventListener('mousedown', function(){ lock(true); });
    c.addEventListener('click', function(){ lock(true); });
  }
  wire(); setInterval(wire, 2000);

  window.__gamepad = {toggle:toggle, getMode:function(){return MODE;}, isConnected:function(){return active;}};
})();
<\/script>`;
}
