/* hero-network — generative Canvas2D hero variant for /v2/.
   N drifting nodes plus thin proximity lines — reads as "a network" /
   "a graph". Density scales with viewport area, halved on narrow screens.
   Theme-reactive (re-reads CSS custom props on data-theme change). Pauses
   RAF when offscreen. Reduced-motion: renders one static frame. */
window.synxHeroNetwork = function(canvas){
  var ctx = canvas.getContext('2d');
  if (!ctx) return false;

  var dprCap = 1.5;
  var nodes = [];
  var raf = 0;
  var visible = true;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function hexToRGB(h){
    h = (h || '').replace('#','').trim();
    if (h.length !== 6) return null;
    return parseInt(h.slice(0,2),16) + ',' + parseInt(h.slice(2,4),16) + ',' + parseInt(h.slice(4,6),16);
  }
  function readColors(){
    var s = getComputedStyle(document.documentElement);
    var fgRGB = hexToRGB(s.getPropertyValue('--fg')) || '237,237,238';
    var isLight = document.documentElement.getAttribute('data-theme') === 'light';
    return {
      lineRGB: fgRGB,
      lineMaxA: isLight ? 0.18 : 0.14,
      nodeFill: 'rgba(' + fgRGB + ',' + (isLight ? 0.55 : 0.65) + ')',
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
  }
  function seed(){
    var w = canvas.clientWidth, h = canvas.clientHeight;
    var density = Math.max(45, Math.min(110, Math.round(w * h / 16000)));
    if (window.matchMedia && window.matchMedia('(max-width: 720px)').matches) density = Math.round(density * 0.55);
    nodes = [];
    for (var i=0; i<density; i++){
      nodes.push({
        x: Math.random()*w, y: Math.random()*h,
        vx: (Math.random()-0.5)*0.18, vy: (Math.random()-0.5)*0.18,
        r: Math.random()*1.5 + 0.7
      });
    }
  }

  function step(){
    raf = 0;
    if (!visible) return;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    if (canvas.width !== ((w*dpr)|0) || canvas.height !== ((h*dpr)|0)) { resize(); seed(); }
    var c = colors;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    var grad = ctx.createRadialGradient(w*0.2, h*0.78, 0, w*0.2, h*0.78, Math.max(w, h)*0.55);
    grad.addColorStop(0, 'rgba(' + c.glow + ',0.12)');
    grad.addColorStop(0.5, 'rgba(' + c.glow + ',0.04)');
    grad.addColorStop(1, 'rgba(' + c.glow + ',0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    for (var i=0; i<nodes.length; i++){
      var n = nodes[i];
      n.x += n.vx; n.y += n.vy;
      if (n.x < 0 || n.x > w) n.vx *= -1;
      if (n.y < 0 || n.y > h) n.vy *= -1;
    }

    var maxD = 140, maxD2 = maxD*maxD;
    ctx.lineWidth = 0.6;
    for (var i=0; i<nodes.length; i++){
      for (var j=i+1; j<nodes.length; j++){
        var a = nodes[i], b = nodes[j];
        var dx = a.x - b.x, dy = a.y - b.y;
        var d2 = dx*dx + dy*dy;
        if (d2 < maxD2){
          var alpha = (1 - Math.sqrt(d2)/maxD) * c.lineMaxA;
          ctx.strokeStyle = 'rgba(' + c.lineRGB + ',' + alpha.toFixed(3) + ')';
          ctx.beginPath();
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    ctx.fillStyle = c.nodeFill;
    for (var i=0; i<nodes.length; i++){
      var n = nodes[i];
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI*2);
      ctx.fill();
    }

    ctx.restore();
    if (!reduce) raf = requestAnimationFrame(step);
  }

  resize(); seed();

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
    if (!raf) raf = requestAnimationFrame(step);
  }).observe(document.documentElement, {attributes:true, attributeFilter:['data-theme']});

  step();
  return true;
};
