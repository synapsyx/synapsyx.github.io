/* synxGlobe — minimal Canvas2D orthographic globe for /v2/'s Footprint
   section. No external libraries: a wireframe sphere (lat/lng grid) with
   pin glyphs and great-circle arcs from the HQ to each deployment.
   Auto-rotates around Y; pauses on hover; pauses RAF when offscreen.
   Reduced-motion: renders a single static frame at the HQ-centered angle.

   Data shape (from data/deployments.yaml, jsonify'd into a <script
   type="application/json"> block): {hq:{lat,lng,city,...},
   deployments:[{lat,lng,region,...}]}.

   Force-dark surface in both site themes — same approach as the existing
   ePATH demo video and the noted G/S-Flow visual fix. */
window.synxGlobe = function(container, data){
  if (!container || !data || !data.hq) return false;
  var canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);
  var ctx = canvas.getContext('2d');
  if (!ctx) return false;

  var TAU = Math.PI * 2;
  var dprCap = 2;
  var rotY = 0;
  var raf = 0;
  var visible = true;
  var paused = false;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function deg2rad(d){ return d * Math.PI / 180; }
  function hexToRGB(h){
    h = (h || '').replace('#','').trim();
    if (h.length !== 6) return null;
    return parseInt(h.slice(0,2),16) + ',' + parseInt(h.slice(2,4),16) + ',' + parseInt(h.slice(4,6),16);
  }
  function readColors(){
    var s = getComputedStyle(document.documentElement);
    return {
      grid: '237,237,238',
      gridA: 0.10,
      gridStrongA: 0.18,
      pin: '237,237,238',
      mg: hexToRGB(s.getPropertyValue('--magenta')) || '230,18,100'
    };
  }
  var colors = readColors();

  function resize(){
    var dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    var w = container.clientWidth | 0;
    canvas.width = (w*dpr) | 0;
    canvas.height = (w*dpr) | 0;
    canvas.style.width = w + 'px';
    canvas.style.height = w + 'px';
  }

  function latLngToVec(lat, lng){
    var phi = deg2rad(90 - lat);
    var theta = deg2rad(lng);
    return {
      x: Math.sin(phi) * Math.cos(theta),
      y: Math.cos(phi),
      z: Math.sin(phi) * Math.sin(theta)
    };
  }
  function rotateY(v, ang){
    var c = Math.cos(ang), s = Math.sin(ang);
    return { x: v.x*c + v.z*s, y: v.y, z: -v.x*s + v.z*c };
  }
  function project(lat, lng){
    return rotateY(latLngToVec(lat, lng), rotY);
  }

  function draw(){
    raf = 0;
    if (!visible) return;
    var dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    var W = canvas.width, H = canvas.height;
    var cx = W / 2, cy = H / 2;
    var r = Math.min(W, H) * 0.42;

    ctx.clearRect(0, 0, W, H);

    // Sphere base. Force-dark in both themes for visual consistency with
    // the ePATH demo + the rest of the dark canvas elements.
    var sphereGrad = ctx.createRadialGradient(cx - r*0.3, cy - r*0.35, r*0.05, cx, cy, r);
    sphereGrad.addColorStop(0, 'rgba(28,28,32,1)');
    sphereGrad.addColorStop(0.55, 'rgba(14,14,18,1)');
    sphereGrad.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = sphereGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();

    // Outer rim glow (subtle, magenta).
    var rim = ctx.createRadialGradient(cx, cy, r*0.92, cx, cy, r*1.15);
    rim.addColorStop(0, 'rgba(' + colors.mg + ',0)');
    rim.addColorStop(0.5, 'rgba(' + colors.mg + ',0.06)');
    rim.addColorStop(1, 'rgba(' + colors.mg + ',0)');
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(cx, cy, r*1.15, 0, TAU);
    ctx.fill();

    // Outline.
    ctx.strokeStyle = 'rgba(' + colors.grid + ',' + (colors.gridStrongA + 0.04).toFixed(3) + ')';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();

    // Lat lines (front hemisphere only).
    ctx.lineWidth = 0.6 * dpr;
    ctx.strokeStyle = 'rgba(' + colors.grid + ',' + colors.gridA + ')';
    for (var lat = -60; lat <= 60; lat += 30) {
      drawCircle(lat, true, ctx, cx, cy, r);
    }
    // Equator slightly stronger.
    ctx.strokeStyle = 'rgba(' + colors.grid + ',' + colors.gridStrongA + ')';
    drawCircle(0, true, ctx, cx, cy, r);
    // Lng lines.
    ctx.strokeStyle = 'rgba(' + colors.grid + ',' + colors.gridA + ')';
    for (var lng = -180; lng < 180; lng += 30) {
      drawCircle(lng, false, ctx, cx, cy, r);
    }

    // Arcs HQ → each deployment (solid) and HQ → each team member (dashed,
    // dimmer) so the two categories read as different relationships.
    var hq = data.hq;
    if (data.deployments) {
      for (var i=0; i<data.deployments.length; i++){
        drawArc(hq.lat, hq.lng, data.deployments[i].lat, data.deployments[i].lng, ctx, cx, cy, r, dpr, false);
      }
    }
    if (data.team) {
      for (var i=0; i<data.team.length; i++){
        drawArc(hq.lat, hq.lng, data.team[i].lat, data.team[i].lng, ctx, cx, cy, r, dpr, true);
      }
    }

    // Pins. HQ first so smaller deployment pins layer on top.
    drawPin(hq.lat, hq.lng, true, ctx, cx, cy, r, dpr);
    if (data.deployments) {
      for (var i=0; i<data.deployments.length; i++){
        var d = data.deployments[i];
        drawPin(d.lat, d.lng, false, ctx, cx, cy, r, dpr);
      }
    }
    if (data.team) {
      for (var i=0; i<data.team.length; i++){
        var m = data.team[i];
        drawTeamPin(m.lat, m.lng, ctx, cx, cy, r, dpr);
      }
    }

    if (!reduce && !paused) raf = requestAnimationFrame(animate);
  }

  function drawCircle(angle, isLatitude, ctx, cx, cy, r){
    ctx.beginPath();
    var first = true;
    var step = 4;
    var range = isLatitude ? [-180, 180] : [-90, 90];
    for (var v = range[0]; v <= range[1]; v += step) {
      var p = isLatitude ? project(angle, v) : project(v, angle);
      if (p.z < 0) { first = true; continue; }
      var x = cx + p.x * r;
      var y = cy - p.y * r;
      if (first) { ctx.moveTo(x, y); first = false; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function drawPin(lat, lng, isHQ, ctx, cx, cy, r, dpr){
    var p = project(lat, lng);
    if (p.z < -0.02) return; // back hemisphere
    var x = cx + p.x * r;
    var y = cy - p.y * r;
    var color = isHQ ? colors.mg : colors.pin;
    var depthAlpha = Math.max(0.35, Math.min(1, p.z * 0.9 + 0.45));
    var rDot = (isHQ ? 5.5 : 3.5) * dpr;
    var rGlow = (isHQ ? 18 : 11) * dpr;

    var pgrad = ctx.createRadialGradient(x, y, 0, x, y, rGlow);
    pgrad.addColorStop(0, 'rgba(' + color + ',' + (depthAlpha * 0.55) + ')');
    pgrad.addColorStop(1, 'rgba(' + color + ',0)');
    ctx.fillStyle = pgrad;
    ctx.beginPath();
    ctx.arc(x, y, rGlow, 0, TAU);
    ctx.fill();

    ctx.fillStyle = 'rgba(' + color + ',' + depthAlpha + ')';
    ctx.beginPath();
    ctx.arc(x, y, rDot, 0, TAU);
    ctx.fill();
  }

  function drawArc(lat1, lng1, lat2, lng2, ctx, cx, cy, r, dpr, isTeam){
    var v1 = latLngToVec(lat1, lng1);
    var v2 = latLngToVec(lat2, lng2);
    var dot = Math.max(-1, Math.min(1, v1.x*v2.x + v1.y*v2.y + v1.z*v2.z));
    var omega = Math.acos(dot);
    var sinO = Math.sin(omega);
    var steps = 56;
    var prev = null;
    ctx.lineWidth = (isTeam ? 0.8 : 1.1) * dpr;
    var alphaCap = isTeam ? 0.30 : 0.55;
    for (var s=0; s<=steps; s++){
      var t = s / steps;
      var k1, k2;
      if (sinO < 1e-6) { k1 = 1-t; k2 = t; }
      else { k1 = Math.sin((1-t)*omega)/sinO; k2 = Math.sin(t*omega)/sinO; }
      var v = { x: v1.x*k1 + v2.x*k2, y: v1.y*k1 + v2.y*k2, z: v1.z*k1 + v2.z*k2 };
      var lift = 1 + Math.sin(t * Math.PI) * 0.20;
      v.x *= lift; v.y *= lift; v.z *= lift;
      var rv = rotateY(v, rotY);
      var sx = cx + rv.x * r;
      var sy = cy - rv.y * r;
      var pt = { x: sx, y: sy, z: rv.z };
      // For team arcs, render as a dashed line (every other segment) so it
      // visually reads as "remote collaboration" rather than a deployment.
      var skip = isTeam && (s % 2 === 0);
      if (!skip && prev && prev.z > -0.08 && pt.z > -0.08) {
        var avgZ = (prev.z + pt.z) / 2;
        var alpha = Math.max(0.04, Math.min(alphaCap, (avgZ + 0.08) * 0.7));
        ctx.strokeStyle = 'rgba(' + colors.mg + ',' + alpha.toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y); ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
      }
      prev = pt;
    }
  }

  function drawTeamPin(lat, lng, ctx, cx, cy, r, dpr){
    var p = project(lat, lng);
    if (p.z < -0.02) return; // back hemisphere
    var x = cx + p.x * r;
    var y = cy - p.y * r;
    var depthAlpha = Math.max(0.35, Math.min(1, p.z * 0.9 + 0.45));
    var rRing = 4.5 * dpr;
    var rGlow = 12 * dpr;

    // Soft glow behind the ring so it doesn't disappear against the sphere.
    var pgrad = ctx.createRadialGradient(x, y, 0, x, y, rGlow);
    pgrad.addColorStop(0, 'rgba(' + colors.pin + ',' + (depthAlpha * 0.30) + ')');
    pgrad.addColorStop(1, 'rgba(' + colors.pin + ',0)');
    ctx.fillStyle = pgrad;
    ctx.beginPath();
    ctx.arc(x, y, rGlow, 0, TAU);
    ctx.fill();

    // Outlined ring (no fill) — the visual cue that distinguishes "team"
    // from solid deployment dots.
    ctx.strokeStyle = 'rgba(' + colors.pin + ',' + depthAlpha + ')';
    ctx.lineWidth = 1.4 * dpr;
    ctx.beginPath();
    ctx.arc(x, y, rRing, 0, TAU);
    ctx.stroke();
  }

  function animate(){
    if (!reduce && !paused) rotY += 0.0018;
    draw();
  }

  resize();
  // Center HQ longitude initially so the user lands on Vienna in view.
  rotY = -deg2rad(data.hq.lng);

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        visible = e.isIntersecting;
        if (visible && !raf) raf = requestAnimationFrame(animate);
      });
    }, {threshold:0}).observe(container);
  }

  window.addEventListener('resize', function(){ resize(); if (!raf) raf = requestAnimationFrame(animate); }, {passive:true});

  new MutationObserver(function(){
    colors = readColors();
    if (!raf) raf = requestAnimationFrame(animate);
  }).observe(document.documentElement, {attributes:true, attributeFilter:['data-theme']});

  // Pause on hover so the user can read pins; resume on leave.
  container.addEventListener('mouseenter', function(){ paused = true; });
  container.addEventListener('mouseleave', function(){ paused = false; if (!raf) raf = requestAnimationFrame(animate); });

  container.setAttribute('data-globe-ready', '');

  if (reduce) draw();
  else raf = requestAnimationFrame(animate);

  return true;
};
