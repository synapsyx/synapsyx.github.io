/* synxGlobe — interactive Canvas2D orthographic globe for /v2/'s
   Footprint section. No external libraries.

   Features:
   - Wireframe sphere (lat/lng grid) with two-axis rotation.
   - HQ + satellite pins (magenta), deployment pins (white), great-circle
     arcs from HQ to every other pin.
   - Pointer drag to rotate (mouse + touch + pen via Pointer Events).
     Vertical drag clamps to ~±70°. Inertia decays after release.
   - Idle auto-rotation resumes ~1.8s after the last interaction.
   - Always-visible pin labels with depth-fade. Hover/touch highlights
     the nearest pin and brightens its label + glow.
   - Animated arc draw-in on first reveal, staggered per arc.
   - Subtle pulse on HQ pins.
   - Pauses RAF when offscreen (IntersectionObserver) and re-renders
     on theme change. Honors prefers-reduced-motion (static frame).

   Data shape (from data/deployments.yaml, jsonify'd into a <script
   type="application/json"> block):
     { hq: {lat,lng,city,...,satellites:[{lat,lng,city,...}]},
       deployments: [{lat,lng,region,...}] }.

   Force-dark surface in both site themes — same approach as the existing
   ePATH demo video and the noted G/S-Flow visual fix. */
window.synxGlobe = function(container, data){
  if (!container || !data || !data.hq) return false;
  var canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'grab';
  container.appendChild(canvas);
  var ctx = canvas.getContext('2d');
  if (!ctx) return false;

  var TAU = Math.PI * 2;
  var DPR_CAP = 2;
  var ROT_X_CLAMP = 1.22;            // ~70° tilt limit
  var DRAG_SENS = 0.0055;
  var INERTIA_DECAY = 0.93;          // per-frame velocity multiplier
  var INERTIA_MIN = 0.00006;         // velocity below this stops
  var IDLE_RESUME_MS = 1800;
  var AUTO_ROT_SPEED = 0.00022;      // radians per ms
  var REVEAL_MS = 1200;              // arc draw-in duration
  var REVEAL_STAGGER_MS = 180;
  var PULSE_PERIOD_MS = 2400;
  var PACKET_PERIOD_MS = 2800;       // arc-traversal time per packet
  var PACKET_FADE_IN_MS = 400;       // soft fade-in once arc reveal completes
  var HOVER_RADIUS = 22;             // CSS px

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
      label: '237,237,238',
      mg: hexToRGB(s.getPropertyValue('--magenta')) || '230,18,100'
    };
  }
  var colors = readColors();

  // Flatten data into a single pin/arc list so the render and hit-test
  // loops don't have to walk the nested structure.
  var pins = [];
  pins.push(makePin(data.hq, true));
  if (data.hq.satellites) {
    for (var i=0; i<data.hq.satellites.length; i++) pins.push(makePin(data.hq.satellites[i], true));
  }
  if (data.deployments) {
    for (var i=0; i<data.deployments.length; i++) pins.push(makePin(data.deployments[i], false));
  }
  function makePin(loc, isHQ){
    return {
      lat: loc.lat,
      lng: loc.lng,
      isHQ: !!isHQ,
      label: (loc.city || loc.region || '').toUpperCase(),
      // Filled in each frame:
      sx: 0, sy: 0, sz: 0, onFront: false
    };
  }

  // Arcs always run from primary HQ outward. We precompute the great-circle
  // basis (v1, v2, omega, sinO) once per arc so per-frame sampling — used by
  // both the polyline draw and the data-packet animation — is just a couple
  // of trig ops, not a fresh arccos.
  function makeArc(lat1, lng1, lat2, lng2){
    var v1 = latLngToVec(lat1, lng1);
    var v2 = latLngToVec(lat2, lng2);
    var dot = Math.max(-1, Math.min(1, v1.x*v2.x + v1.y*v2.y + v1.z*v2.z));
    var omega = Math.acos(dot);
    return { v1: v1, v2: v2, omega: omega, sinO: Math.sin(omega) };
  }
  var arcs = [];
  if (data.hq.satellites) {
    for (var i=0; i<data.hq.satellites.length; i++) {
      arcs.push(makeArc(data.hq.lat, data.hq.lng, data.hq.satellites[i].lat, data.hq.satellites[i].lng));
    }
  }
  if (data.deployments) {
    for (var i=0; i<data.deployments.length; i++) {
      arcs.push(makeArc(data.hq.lat, data.hq.lng, data.deployments[i].lat, data.deployments[i].lng));
    }
  }

  // --- State -----------------------------------------------------------

  var rotY = -deg2rad(data.hq.lng);
  var rotX = deg2rad(12);            // gentle initial tilt
  var raf = 0;
  var visible = true;
  // Float32Array of (x,y,z) unit vectors for each land sample point.
  // Filled asynchronously by loadLandmask(); null until then so the globe
  // renders fine if the fetch is slow or fails.
  var landVecs = null;
  var dragging = false;
  var pointerId = null;
  var dragVX = 0, dragVY = 0;        // velocity (rad / ms)
  var lastPX = 0, lastPY = 0;
  var lastPT = 0;
  var idleResumeAt = 0;
  var revealStartAt = 0;             // 0 until first visible
  var hoveredPin = -1;
  var hoverPx = -1, hoverPy = -1;
  var hoverActive = false;
  // Tap-vs-drag tracking. A pointerup within TAP_MOVE_PX of where the
  // pointer went down, on the same pin that was hovered at down-time,
  // dispatches a 'pin-click' CustomEvent on the container. v2.js uses
  // it to scroll to the matching footprint-list item.
  var TAP_MOVE_PX = 6;
  var downPin = -1, downX = 0, downY = 0;

  // --- Geometry --------------------------------------------------------

  function latLngToVec(lat, lng){
    // Place lng=0 on the +Z axis (camera-facing) and lng=+90° on +X (screen
    // right) so increasing longitude — going East — moves points to the
    // right on screen, matching the standard map view. Pairs with
    // rotY = -deg2rad(HQ.lng) below, which then centers HQ at +Z.
    var phi = deg2rad(90 - lat);
    var theta = deg2rad(lng);
    return {
      x: Math.sin(phi) * Math.sin(theta),
      y: Math.cos(phi),
      z: Math.sin(phi) * Math.cos(theta)
    };
  }
  function rotateY(v, ang){
    var c = Math.cos(ang), s = Math.sin(ang);
    return { x: v.x*c + v.z*s, y: v.y, z: -v.x*s + v.z*c };
  }
  function rotateX(v, ang){
    var c = Math.cos(ang), s = Math.sin(ang);
    return { x: v.x, y: v.y*c - v.z*s, z: v.y*s + v.z*c };
  }
  function projectVec(v){
    return rotateX(rotateY(v, rotY), rotX);
  }
  function project(lat, lng){
    return projectVec(latLngToVec(lat, lng));
  }

  // --- Render ----------------------------------------------------------

  function resize(){
    var dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    var w = container.clientWidth | 0;
    canvas.width = (w*dpr) | 0;
    canvas.height = (w*dpr) | 0;
    canvas.style.width = w + 'px';
    canvas.style.height = w + 'px';
  }

  function draw(now){
    raf = 0;
    if (!visible) return;
    var dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    var W = canvas.width, H = canvas.height;
    var cx = W / 2, cy = H / 2;
    var r = Math.min(W, H) * 0.42;

    ctx.clearRect(0, 0, W, H);

    // Atmosphere halo — drawn BEFORE the sphere so the inner half of the
    // gradient is hidden by the disk; only the soft outer bloom shows.
    // Outer extent r*1.20 keeps the falloff within the canvas (r is 0.42*W).
    var halo = ctx.createRadialGradient(cx, cy, r*0.50, cx, cy, r*1.20);
    halo.addColorStop(0, 'rgba(' + colors.mg + ',0)');
    halo.addColorStop(0.70, 'rgba(' + colors.mg + ',0.04)');
    halo.addColorStop(0.83, 'rgba(' + colors.mg + ',0.22)');  // peak at the rim
    halo.addColorStop(0.92, 'rgba(' + colors.mg + ',0.07)');
    halo.addColorStop(1, 'rgba(' + colors.mg + ',0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, r*1.20, 0, TAU);
    ctx.fill();

    // Sphere base (force-dark in both themes).
    var sphereGrad = ctx.createRadialGradient(cx - r*0.3, cy - r*0.35, r*0.05, cx, cy, r);
    sphereGrad.addColorStop(0, 'rgba(28,28,32,1)');
    sphereGrad.addColorStop(0.55, 'rgba(14,14,18,1)');
    sphereGrad.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = sphereGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();

    // Inner rim accent on top of the sphere — soft magenta glow at the
    // disk edge so the planet reads as "lit from behind".
    var innerRim = ctx.createRadialGradient(cx, cy, r*0.86, cx, cy, r);
    innerRim.addColorStop(0, 'rgba(' + colors.mg + ',0)');
    innerRim.addColorStop(0.85, 'rgba(' + colors.mg + ',0.04)');
    innerRim.addColorStop(1, 'rgba(' + colors.mg + ',0.18)');
    ctx.fillStyle = innerRim;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();

    // Dot-matrix landmass (Stripe-style). Drawn on top of the sphere fill
    // but under the lat/lng grid so the grid still reads as overlay.
    drawLandmass(ctx, cx, cy, r, dpr);

    // Outline.
    ctx.strokeStyle = 'rgba(' + colors.grid + ',' + (colors.gridStrongA + 0.04).toFixed(3) + ')';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();

    // Lat lines.
    ctx.lineWidth = 0.6 * dpr;
    ctx.strokeStyle = 'rgba(' + colors.grid + ',' + colors.gridA + ')';
    for (var lat = -60; lat <= 60; lat += 30) drawCircle(lat, true, ctx, cx, cy, r);
    // Equator slightly stronger.
    ctx.strokeStyle = 'rgba(' + colors.grid + ',' + colors.gridStrongA + ')';
    drawCircle(0, true, ctx, cx, cy, r);
    // Lng lines.
    ctx.strokeStyle = 'rgba(' + colors.grid + ',' + colors.gridA + ')';
    for (var lng = -180; lng < 180; lng += 30) drawCircle(lng, false, ctx, cx, cy, r);

    // Arcs with progressive draw-in (staggered).
    for (var i=0; i<arcs.length; i++){
      var revealT;
      if (revealStartAt === 0) revealT = 0;
      else {
        revealT = (now - revealStartAt - i * REVEAL_STAGGER_MS) / REVEAL_MS;
      }
      revealT = Math.max(0, Math.min(1, revealT));
      // Ease-out cubic.
      var eased = 1 - Math.pow(1 - revealT, 3);
      drawArc(arcs[i], ctx, cx, cy, r, dpr, eased);
    }

    // Animated data packets travelling HQ→destination along each arc.
    drawPackets(now, ctx, cx, cy, r, dpr);

    // Pins. Compute screen positions in pin objects so hit-testing later
    // can read them without re-projecting.
    var pulseT = (now % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
    var pulse = 0.5 + 0.5 * Math.sin(pulseT * TAU);  // 0..1
    for (var i=0; i<pins.length; i++) {
      var pin = pins[i];
      var p = project(pin.lat, pin.lng);
      pin.sx = cx + p.x * r;
      pin.sy = cy - p.y * r;
      pin.sz = p.z;
      pin.onFront = p.z >= -0.02;
      if (pin.onFront) drawPin(pin, i === hoveredPin, pulse, ctx, dpr);
    }

    // Labels above pins. Drawn after all pins so they're never overlapped.
    ctx.font = (10.5 * dpr).toFixed(0) + 'px "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (var i=0; i<pins.length; i++) {
      var pin = pins[i];
      if (!pin.onFront) continue;
      drawLabel(pin, i === hoveredPin, ctx, dpr);
    }

    // Decide whether to keep the RAF loop running.
    if (shouldKeepAnimating(now)) raf = requestAnimationFrame(animate);
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

  // Dot-matrix landmass (Stripe / Linear / Vercel idiom). landVecs is a
  // Float32Array of (x,y,z) unit vectors sampled at land positions on a
  // Fibonacci sphere. We bin dots into four depth-alpha buckets so the
  // ~3K-point loop only touches ctx.fillStyle four times per frame and
  // batches all rects in each bucket into a single Path2D fill.
  // Rotation math is inlined to dodge ~3K object allocations / frame.
  function drawLandmass(ctx, cx, cy, r, dpr){
    if (!landVecs) return;
    var dotR = 0.7 * dpr;
    var size = 2 * dotR;
    var cyR = Math.cos(rotY), syR = Math.sin(rotY);
    var cxR = Math.cos(rotX), sxR = Math.sin(rotX);
    var b0 = [], b1 = [], b2 = [], b3 = [];
    var n = landVecs.length;
    for (var i = 0; i < n; i += 3) {
      var x = landVecs[i], y = landVecs[i+1], z = landVecs[i+2];
      // rotateY then rotateX, composed inline:
      var x2 = x*cyR + z*syR;
      var y2 = y*cxR + x*syR*sxR - z*cyR*sxR;
      var z2 = y*sxR - x*syR*cxR + z*cyR*cxR;
      if (z2 < 0.04) continue;  // back-cull + soft horizon margin
      var sx = cx + x2 * r - dotR;
      var sy = cy - y2 * r - dotR;
      var bucket = z2 > 0.7 ? b3 : z2 > 0.45 ? b2 : z2 > 0.20 ? b1 : b0;
      bucket.push(sx, sy);
    }
    var alphas = [0.16, 0.30, 0.48, 0.70];
    var buckets = [b0, b1, b2, b3];
    for (var bi = 0; bi < 4; bi++){
      var pts = buckets[bi];
      if (pts.length === 0) continue;
      ctx.fillStyle = 'rgba(' + colors.grid + ',' + alphas[bi] + ')';
      ctx.beginPath();
      for (var j = 0; j < pts.length; j += 2){
        ctx.rect(pts[j], pts[j+1], size, size);
      }
      ctx.fill();
    }
  }

  function drawPin(pin, isHovered, pulse, ctx, dpr){
    var color = pin.isHQ ? colors.mg : colors.pin;
    var depthAlpha = Math.max(0.35, Math.min(1, pin.sz * 0.9 + 0.45));
    var hoverBoost = isHovered ? 1.45 : 1.0;
    var pulseBoost = pin.isHQ && !reduce ? 1 + 0.18 * pulse : 1;
    var rDot = (pin.isHQ ? 5.6 : 3.6) * dpr * hoverBoost;
    var rGlow = (pin.isHQ ? 19 : 12) * dpr * hoverBoost * pulseBoost;

    var pgrad = ctx.createRadialGradient(pin.sx, pin.sy, 0, pin.sx, pin.sy, rGlow);
    pgrad.addColorStop(0, 'rgba(' + color + ',' + (depthAlpha * (isHovered ? 0.7 : 0.55)) + ')');
    pgrad.addColorStop(1, 'rgba(' + color + ',0)');
    ctx.fillStyle = pgrad;
    ctx.beginPath();
    ctx.arc(pin.sx, pin.sy, rGlow, 0, TAU);
    ctx.fill();

    ctx.fillStyle = 'rgba(' + color + ',' + depthAlpha + ')';
    ctx.beginPath();
    ctx.arc(pin.sx, pin.sy, rDot, 0, TAU);
    ctx.fill();
  }

  function drawLabel(pin, isHovered, ctx, dpr){
    if (!pin.label) return;
    var depth = Math.max(0.0, Math.min(1, pin.sz * 1.1 + 0.05));
    var alpha = (isHovered ? 1.0 : 0.55) * (0.4 + 0.6 * depth);
    if (alpha < 0.05) return;
    var ox = (pin.isHQ ? 9 : 7) * dpr;
    var oy = -(pin.isHQ ? 11 : 9) * dpr;
    var color = isHovered && pin.isHQ ? colors.mg : colors.label;
    // Slight halo under the text so it stays readable when overlapping
    // grid lines or another pin's glow.
    ctx.fillStyle = 'rgba(0,0,0,' + (0.55 * alpha).toFixed(3) + ')';
    ctx.fillText(pin.label, pin.sx + ox + dpr, pin.sy + oy + dpr);
    ctx.fillStyle = 'rgba(' + color + ',' + alpha.toFixed(3) + ')';
    ctx.fillText(pin.label, pin.sx + ox, pin.sy + oy);
  }

  // Sample a great-circle arc at parameter t∈[0,1] using the precomputed
  // basis. Used by both arc drawing and packet animation.
  function arcSample(arc, t){
    var k1, k2;
    if (arc.sinO < 1e-6) { k1 = 1-t; k2 = t; }
    else { k1 = Math.sin((1-t)*arc.omega)/arc.sinO; k2 = Math.sin(t*arc.omega)/arc.sinO; }
    var lift = 1 + Math.sin(t * Math.PI) * 0.20;
    return {
      x: (arc.v1.x*k1 + arc.v2.x*k2) * lift,
      y: (arc.v1.y*k1 + arc.v2.y*k2) * lift,
      z: (arc.v1.z*k1 + arc.v2.z*k2) * lift
    };
  }

  function drawArc(arc, ctx, cx, cy, r, dpr, reveal){
    if (reveal <= 0) return;
    var steps = 56;
    var lastIdx = Math.ceil(reveal * steps);
    var prev = null;
    ctx.lineWidth = 1.1 * dpr;
    for (var s=0; s<=lastIdx; s++){
      var t = s / steps;
      var v = arcSample(arc, t);
      var rv = projectVec(v);
      var sx = cx + rv.x * r;
      var sy = cy - rv.y * r;
      var pt = { x: sx, y: sy, z: rv.z };
      if (prev && prev.z > -0.08 && pt.z > -0.08) {
        var avgZ = (prev.z + pt.z) / 2;
        var alpha = Math.max(0.04, Math.min(0.55, (avgZ + 0.08) * 0.7));
        ctx.strokeStyle = 'rgba(' + colors.mg + ',' + alpha.toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y); ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
      }
      prev = pt;
    }
  }

  // Travelling-packet animation: per arc, one packet head with a short
  // fading polyline trail, looping from HQ→destination. Phase is staggered
  // so launches don't all coincide. Suppressed during the arc reveal and
  // skipped entirely under prefers-reduced-motion.
  function drawPackets(now, ctx, cx, cy, r, dpr){
    if (reduce) return;
    if (revealStartAt === 0) return;
    ctx.lineWidth = 1.6 * dpr;
    ctx.lineCap = 'round';
    var trailSteps = 8;
    var trailDt = 0.020;
    for (var i=0; i<arcs.length; i++){
      var arc = arcs[i];
      var sinceArcReady = now - revealStartAt - i * REVEAL_STAGGER_MS - REVEAL_MS;
      if (sinceArcReady < 0) continue;
      var fade = Math.min(1, sinceArcReady / PACKET_FADE_IN_MS);
      var phase = (i * 0.327) % 1;
      var t = ((now / PACKET_PERIOD_MS) + phase) % 1;

      var prev = null;
      for (var s=trailSteps; s>=0; s--){
        var ts = t - s * trailDt;
        if (ts < 0) { prev = null; continue; }
        var v = arcSample(arc, ts);
        var rv = projectVec(v);
        if (rv.z < -0.05) { prev = null; continue; }
        var sx = cx + rv.x * r;
        var sy = cy - rv.y * r;
        if (prev){
          var alphaSeg = (1 - s / trailSteps) * 0.65 * fade;
          ctx.strokeStyle = 'rgba(' + colors.mg + ',' + alphaSeg.toFixed(3) + ')';
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(sx, sy);
          ctx.stroke();
        }
        prev = { x: sx, y: sy };
      }

      var head = arcSample(arc, t);
      var rh = projectVec(head);
      if (rh.z < -0.05) continue;
      var hx = cx + rh.x * r;
      var hy = cy - rh.y * r;
      var depthA = Math.max(0.5, Math.min(1, rh.z + 0.5)) * fade;

      var glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, 9 * dpr);
      glow.addColorStop(0, 'rgba(' + colors.mg + ',' + (depthA * 0.7).toFixed(3) + ')');
      glow.addColorStop(1, 'rgba(' + colors.mg + ',0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(hx, hy, 9 * dpr, 0, TAU);
      ctx.fill();

      ctx.fillStyle = 'rgba(' + colors.mg + ',' + (depthA * 0.95).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(hx, hy, 2.0 * dpr, 0, TAU);
      ctx.fill();
    }
  }

  // --- Animation loop --------------------------------------------------

  function shouldKeepAnimating(now){
    if (!visible) return false;
    if (reduce) {
      // Reduced-motion: keep the frame static unless we're still in the
      // initial reveal (which we skip below) or being dragged.
      if (dragging) return true;
      return false;
    }
    return true;
  }

  function animate(now){
    var t = now || performance.now();
    var dt = 16; // approximate; smoothed below
    if (animate._last) dt = Math.min(64, t - animate._last);
    animate._last = t;

    if (!dragging) {
      var hasInertia = Math.abs(dragVX) > INERTIA_MIN || Math.abs(dragVY) > INERTIA_MIN;
      if (hasInertia) {
        rotY += dragVX * dt;
        rotX = Math.max(-ROT_X_CLAMP, Math.min(ROT_X_CLAMP, rotX + dragVY * dt));
        var decay = Math.pow(INERTIA_DECAY, dt / 16);
        dragVX *= decay;
        dragVY *= decay;
        if (Math.abs(dragVX) < INERTIA_MIN) dragVX = 0;
        if (Math.abs(dragVY) < INERTIA_MIN) dragVY = 0;
        if (!dragVX && !dragVY) idleResumeAt = t + IDLE_RESUME_MS;
      } else if (!reduce && t >= idleResumeAt) {
        rotY += AUTO_ROT_SPEED * dt;
      }
    }

    draw(t);
  }

  // --- Pointer interaction --------------------------------------------

  function localXY(e){
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function findHoveredPin(localX, localY){
    var dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    var px = localX * dpr;
    var py = localY * dpr;
    var thresh = HOVER_RADIUS * dpr;
    var best = -1;
    var bestD = thresh * thresh;
    for (var i=0; i<pins.length; i++) {
      var pin = pins[i];
      if (!pin.onFront) continue;
      var dx = pin.sx - px;
      var dy = pin.sy - py;
      var d2 = dx*dx + dy*dy;
      if (d2 < bestD) { bestD = d2; best = i; }
    }
    return best;
  }

  canvas.addEventListener('pointerdown', function(e){
    dragging = true;
    pointerId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    canvas.style.cursor = 'grabbing';
    var lp = localXY(e);
    lastPX = lp.x; lastPY = lp.y;
    lastPT = performance.now();
    dragVX = 0; dragVY = 0;
    // Touch devices don't fire pointermove before pointerdown, so the
    // hovered pin under a finger tap isn't known yet — recompute here so
    // the tap path can match the down position to a pin.
    var pin = findHoveredPin(lp.x, lp.y);
    downPin = pin;
    downX = lp.x; downY = lp.y;
    e.preventDefault();
    if (!raf) raf = requestAnimationFrame(animate);
  });

  canvas.addEventListener('pointermove', function(e){
    var lp = localXY(e);
    if (dragging && e.pointerId === pointerId) {
      var t = performance.now();
      var dt = Math.max(1, t - lastPT);
      var dx = lp.x - lastPX;
      var dy = lp.y - lastPY;
      rotY += dx * DRAG_SENS;
      rotX = Math.max(-ROT_X_CLAMP, Math.min(ROT_X_CLAMP, rotX + dy * DRAG_SENS));
      // Velocity in rad/ms for inertia.
      dragVX = (dx * DRAG_SENS) / dt;
      dragVY = (dy * DRAG_SENS) / dt;
      lastPX = lp.x; lastPY = lp.y; lastPT = t;
      idleResumeAt = t + IDLE_RESUME_MS;
      if (!raf) raf = requestAnimationFrame(animate);
    } else {
      hoverPx = lp.x; hoverPy = lp.y;
      var prev = hoveredPin;
      hoveredPin = findHoveredPin(lp.x, lp.y);
      hoverActive = hoveredPin >= 0;
      canvas.style.cursor = hoverActive ? 'pointer' : 'grab';
      if (hoveredPin !== prev && !raf) raf = requestAnimationFrame(animate);
    }
  });

  function endPointer(e){
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    canvas.style.cursor = hoverActive ? 'pointer' : 'grab';
    idleResumeAt = performance.now() + IDLE_RESUME_MS;
    // Tap detection: same pin under both down and up, no real drag.
    // 'pointercancel' (e.type) shouldn't trigger a click — only release.
    if (e.type === 'pointerup' && downPin >= 0) {
      var lp = localXY(e);
      var moved = Math.hypot(lp.x - downX, lp.y - downY);
      if (moved < TAP_MOVE_PX) {
        var upPin = findHoveredPin(lp.x, lp.y);
        if (upPin === downPin) {
          try {
            container.dispatchEvent(new CustomEvent('pin-click', {detail:{index: downPin}}));
          } catch(_) {}
        }
      }
    }
    downPin = -1;
    if (!raf) raf = requestAnimationFrame(animate);
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('pointerleave', function(){
    if (hoveredPin !== -1) {
      hoveredPin = -1;
      hoverActive = false;
      if (!raf) raf = requestAnimationFrame(animate);
    }
    if (!dragging) canvas.style.cursor = 'grab';
  });

  // --- Lifecycle -------------------------------------------------------

  resize();

  // Lazy-load the precomputed land-mask points. URL is on the container
  // (set by Hugo template) so we don't hardcode a path. On success, convert
  // each (lat, lng) pair to a unit vector once and stash in landVecs;
  // drawLandmass() picks it up automatically the next frame.
  (function loadLandmask(){
    var url = container.getAttribute('data-landmask-url');
    if (!url || typeof fetch !== 'function') return;
    fetch(url, {credentials:'same-origin'}).then(function(res){
      if (!res.ok) throw new Error('landmask fetch ' + res.status);
      return res.json();
    }).then(function(arr){
      if (!Array.isArray(arr) || arr.length < 2) return;
      var n = arr.length / 2;
      var buf = new Float32Array(n * 3);
      for (var i = 0; i < n; i++){
        var v = latLngToVec(arr[i*2], arr[i*2+1]);
        buf[i*3]   = v.x;
        buf[i*3+1] = v.y;
        buf[i*3+2] = v.z;
      }
      landVecs = buf;
      if (!raf) raf = requestAnimationFrame(animate);
    }).catch(function(err){
      // Globe still renders without the landmass — log and move on.
      if (window.console && console.warn) console.warn('globe: landmask load failed', err);
    });
  })();

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        var wasVisible = visible;
        visible = e.isIntersecting;
        if (visible) {
          if (revealStartAt === 0) revealStartAt = performance.now();
          if (!raf) raf = requestAnimationFrame(animate);
        }
      });
    }, {threshold:0}).observe(container);
  } else {
    revealStartAt = performance.now();
  }

  window.addEventListener('resize', function(){
    resize();
    if (!raf) raf = requestAnimationFrame(animate);
  }, {passive:true});

  new MutationObserver(function(){
    colors = readColors();
    if (!raf) raf = requestAnimationFrame(animate);
  }).observe(document.documentElement, {attributes:true, attributeFilter:['data-theme']});

  container.setAttribute('data-globe-ready', '');

  // Kick off either the static frame (reduced-motion) or the RAF loop.
  if (reduce) {
    revealStartAt = performance.now() - REVEAL_MS - arcs.length * REVEAL_STAGGER_MS;
    draw(performance.now());
  } else {
    raf = requestAnimationFrame(animate);
  }

  return true;
};
