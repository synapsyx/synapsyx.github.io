/* hero-flow — generative Canvas2D hero variant for /v2/.
   Particles seeded across the hero, advected through a Perlin-style flow
   field. Each frame, prior pixels are partially erased toward the bg
   color so trails fade. Reads as "wind currents" / generative art.
   Theme-reactive; pauses offscreen; reduced-motion renders 12 static
   ribbons traced once. */
window.synxHeroFlow = function(canvas){
  var ctx = canvas.getContext('2d');
  if (!ctx) return false;

  var dprCap = 1.5;
  var particles = [];
  var raf = 0;
  var visible = true;
  var time = 0;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Tiny 2D value-noise + FBM. ~30 lines, smooth enough for visual flow,
  // far cheaper than a true gradient noise implementation.
  function hash(x, y, seed){
    var n = (x|0) * 374761393 + (y|0) * 668265263 + seed * 982451653;
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) & 0x7fffffff) / 0x7fffffff;
  }
  function fade(t){ return t*t*t*(t*(t*6 - 15) + 10); }
  function lerp(a, b, t){ return a + (b - a) * t; }
  function vnoise(x, y, seed){
    var ix = Math.floor(x), iy = Math.floor(y);
    var fx = x - ix, fy = y - iy;
    var u = fade(fx), v = fade(fy);
    var a = hash(ix,   iy,   seed), b = hash(ix+1, iy,   seed);
    var c = hash(ix,   iy+1, seed), d = hash(ix+1, iy+1, seed);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }
  function fbm(x, y, seed){
    var s = 0, amp = 0.5, freq = 1;
    for (var i=0; i<3; i++){
      s += vnoise(x*freq, y*freq, seed) * amp;
      freq *= 2; amp *= 0.5;
    }
    return s;
  }
  function flowAngle(x, y, t){
    return fbm(x*0.0035, y*0.0035 + t*0.05, 17) * Math.PI * 4;
  }

  function hexToRGB(h){
    h = (h || '').replace('#','').trim();
    if (h.length !== 6) return null;
    return parseInt(h.slice(0,2),16) + ',' + parseInt(h.slice(2,4),16) + ',' + parseInt(h.slice(4,6),16);
  }
  function readColors(){
    var s = getComputedStyle(document.documentElement);
    var fgRGB = hexToRGB(s.getPropertyValue('--fg')) || '237,237,238';
    var bgRGB = hexToRGB(s.getPropertyValue('--bg')) || '10,10,11';
    var isLight = document.documentElement.getAttribute('data-theme') === 'light';
    return {
      lineRGB: fgRGB,
      lineA: isLight ? 0.05 : 0.07,
      bgFadeA: isLight ? 0.06 : 0.045,
      bgRGB: bgRGB,
      glow: '230,18,100'
    };
  }
  var colors = readColors();

  function resize(){
    var dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    var w = canvas.clientWidth | 0;
    var h = canvas.clientHeight | 0;
    canvas.width = (w*dpr) | 0;
    canvas.height = (h*dpr) | 0;
    // Fresh background after resize so old pixels don't smear.
    ctx.fillStyle = 'rgb(' + colors.bgRGB + ')';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  function seed(){
    var w = canvas.clientWidth, h = canvas.clientHeight;
    var n = Math.max(180, Math.min(380, Math.round(w*h / 4500)));
    if (window.matchMedia && window.matchMedia('(max-width: 720px)').matches) n = Math.round(n * 0.55);
    particles = [];
    for (var i=0; i<n; i++){
      particles.push({
        x: Math.random()*w, y: Math.random()*h,
        life: Math.random() * 200, maxLife: 180 + Math.random()*120
      });
    }
  }

  function step(){
    raf = 0;
    if (!visible) return;
    time += 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    if (canvas.width !== ((w*dpr)|0) || canvas.height !== ((h*dpr)|0)) { resize(); seed(); }
    var c = colors;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Bg fade: paint a transparent layer of the page bg so older trails decay.
    ctx.fillStyle = 'rgba(' + c.bgRGB + ',' + c.bgFadeA + ')';
    ctx.fillRect(0, 0, w, h);

    // Subtle magenta glow (lower-left, matches hero accent placement).
    var grad = ctx.createRadialGradient(w*0.2, h*0.78, 0, w*0.2, h*0.78, Math.max(w, h)*0.55);
    grad.addColorStop(0, 'rgba(' + c.glow + ',0.04)');
    grad.addColorStop(1, 'rgba(' + c.glow + ',0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(' + c.lineRGB + ',' + c.lineA + ')';
    ctx.lineWidth = 0.6;
    for (var i=0; i<particles.length; i++){
      var p = particles[i];
      var ang = flowAngle(p.x, p.y, time*0.04);
      var nx = p.x + Math.cos(ang) * 0.7;
      var ny = p.y + Math.sin(ang) * 0.7;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny);
      ctx.stroke();
      p.x = nx; p.y = ny;
      p.life++;
      if (p.life > p.maxLife || p.x < -10 || p.x > w+10 || p.y < -10 || p.y > h+10){
        p.x = Math.random()*w; p.y = Math.random()*h;
        p.life = 0; p.maxLife = 180 + Math.random()*120;
      }
    }

    ctx.restore();
    if (!reduce) raf = requestAnimationFrame(step);
  }

  resize(); seed();

  if (reduce) {
    var dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = 'rgba(' + colors.lineRGB + ',' + (colors.lineA * 1.8) + ')';
    ctx.lineWidth = 0.7;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    for (var k=0; k<14; k++){
      var p = { x: Math.random()*w, y: Math.random()*h };
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      for (var s=0; s<160; s++){
        var ang = flowAngle(p.x, p.y, 0);
        p.x += Math.cos(ang) * 1.2;
        p.y += Math.sin(ang) * 1.2;
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.restore();
    return true;
  }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        visible = e.isIntersecting;
        if (visible && !raf) raf = requestAnimationFrame(step);
      });
    }, {threshold:0}).observe(canvas);
  }

  window.addEventListener('resize', function(){ resize(); seed(); if (!raf) raf = requestAnimationFrame(step); }, {passive:true});

  new MutationObserver(function(){
    colors = readColors();
  }).observe(document.documentElement, {attributes:true, attributeFilter:['data-theme']});

  step();
  return true;
};
