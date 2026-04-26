/* hero-fluid — WebGL Navier-Stokes fluid sim hero variant for /v2/.
   Stable Fluids (Stam '99) on GPU via ping-pong FBOs:
   curl → vorticity confinement → divergence → Jacobi pressure (~20 iter)
   → gradient subtract → semi-Lagrangian advect of velocity + dye.
   Cursor leaves real ink trails that diffuse and curl. Idle auto-splats
   keep the field gently moving. Click adds a magenta-tinted high-force
   splat. Theme-reactive (display shader maps dye intensity onto
   bg→fg + magenta tint). Pauses offscreen; reduced-motion paints a few
   static splats then freezes. Returns false on no WebGL / no half-float
   linear so the caller can fall back to synxHeroFlow. Inspired by
   Pavel Dobryakov's WebGL-Fluid-Simulation. */
window.synxHeroFluid = function(canvas){
  var glOpts = {alpha:false, depth:false, stencil:false, antialias:false, premultipliedAlpha:false, preserveDrawingBuffer:false};
  var gl = canvas.getContext('webgl', glOpts) || canvas.getContext('experimental-webgl', glOpts);
  if (!gl) return false;
  var hf = gl.getExtension('OES_texture_half_float');
  var hfl = gl.getExtension('OES_texture_half_float_linear');
  if (!hf || !hfl) return false;
  var TT = hf.HALF_FLOAT_OES;

  // Probe render-to-half-float — some mobile GPUs advertise the ext but
  // can't actually attach a half-float texture as a color buffer.
  var probeTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, probeTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, TT, null);
  var probeFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, probeFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, probeTex, 0);
  var probeOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(probeFbo);
  gl.deleteTexture(probeTex);
  if (!probeOk) return false;

  // Sim params. SIM_RES is the velocity/pressure grid; DYE_RES is the
  // dye grid (visible, kept higher for crisper trails). PRESSURE_ITER
  // controls Jacobi pressure-solve quality (more = more incompressible).
  var SIM_RES = 192;
  var DYE_RES = 768;
  var PRESSURE_ITER = 20;
  var PRESSURE = 0.8;          // pressure dissipation between frames
  var CURL = 22;               // vorticity confinement strength
  var VEL_DISSIPATION = 0.20;  // velocity decay (per second-ish)
  var DYE_DISSIPATION = 1.35;  // dye decay (higher = trails fade faster)
  var SPLAT_RADIUS = 0.22;     // gaussian sigma in normalized coords
  var SPLAT_FORCE = 5800;      // cursor-velocity → splat strength
  var AUTO_SPLAT_INTERVAL = 1900; // ms between idle auto-splats
  // Global tint cap. Splat colors below are tuned for a calm "ambient"
  // hero feel; raise toward 1.0 for a more present, distracting look.
  var DYE_GAIN = 0.55;

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Shaders (GLSL ES 1.00) -----------------------------------------
  var BASE_VERT = [
    'precision highp float;',
    'attribute vec2 aPos;',
    'varying vec2 vUv, vL, vR, vT, vB;',
    'uniform vec2 texelSize;',
    'void main(){',
    '  vUv = aPos * 0.5 + 0.5;',
    '  vL = vUv - vec2(texelSize.x, 0.0);',
    '  vR = vUv + vec2(texelSize.x, 0.0);',
    '  vT = vUv + vec2(0.0, texelSize.y);',
    '  vB = vUv - vec2(0.0, texelSize.y);',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var SPLAT_FRAG = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTarget;',
    'uniform float uAspect;',
    'uniform vec3 uColor;',
    'uniform vec2 uPoint;',
    'uniform float uRadius;',
    'void main(){',
    '  vec2 p = vUv - uPoint;',
    '  p.x *= uAspect;',
    '  vec3 splat = exp(-dot(p, p) / uRadius) * uColor;',
    '  vec3 base = texture2D(uTarget, vUv).xyz;',
    '  gl_FragColor = vec4(base + splat, 1.0);',
    '}'
  ].join('\n');

  var ADVECT_FRAG = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uSource;',
    'uniform vec2 texelSize;',
    'uniform float dt;',
    'uniform float dissipation;',
    'void main(){',
    '  vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;',
    '  vec4 result = texture2D(uSource, coord);',
    '  float decay = 1.0 + dissipation * dt;',
    '  gl_FragColor = result / decay;',
    '}'
  ].join('\n');

  var DIV_FRAG = [
    'precision highp float;',
    'varying vec2 vUv, vL, vR, vT, vB;',
    'uniform sampler2D uVelocity;',
    'void main(){',
    '  float L = texture2D(uVelocity, vL).x;',
    '  float R = texture2D(uVelocity, vR).x;',
    '  float T = texture2D(uVelocity, vT).y;',
    '  float B = texture2D(uVelocity, vB).y;',
    '  vec2 C = texture2D(uVelocity, vUv).xy;',
    '  if (vL.x < 0.0) L = -C.x;',
    '  if (vR.x > 1.0) R = -C.x;',
    '  if (vT.y > 1.0) T = -C.y;',
    '  if (vB.y < 0.0) B = -C.y;',
    '  float div = 0.5 * (R - L + T - B);',
    '  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var CURL_FRAG = [
    'precision highp float;',
    'varying vec2 vUv, vL, vR, vT, vB;',
    'uniform sampler2D uVelocity;',
    'void main(){',
    '  float L = texture2D(uVelocity, vL).y;',
    '  float R = texture2D(uVelocity, vR).y;',
    '  float T = texture2D(uVelocity, vT).x;',
    '  float B = texture2D(uVelocity, vB).x;',
    '  float vorticity = R - L - T + B;',
    '  gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var VORT_FRAG = [
    'precision highp float;',
    'varying vec2 vUv, vL, vR, vT, vB;',
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uCurl;',
    'uniform float curl;',
    'uniform float dt;',
    'void main(){',
    '  float L = texture2D(uCurl, vL).x;',
    '  float R = texture2D(uCurl, vR).x;',
    '  float T = texture2D(uCurl, vT).x;',
    '  float B = texture2D(uCurl, vB).x;',
    '  float C = texture2D(uCurl, vUv).x;',
    '  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));',
    '  force /= length(force) + 0.0001;',
    '  force *= curl * C;',
    '  force.y *= -1.0;',
    '  vec2 vel = texture2D(uVelocity, vUv).xy;',
    '  vel += force * dt;',
    '  vel = clamp(vel, -1000.0, 1000.0);',
    '  gl_FragColor = vec4(vel, 0.0, 1.0);',
    '}'
  ].join('\n');

  var PRESSURE_FRAG = [
    'precision highp float;',
    'varying vec2 vUv, vL, vR, vT, vB;',
    'uniform sampler2D uPressure;',
    'uniform sampler2D uDivergence;',
    'void main(){',
    '  float L = texture2D(uPressure, vL).x;',
    '  float R = texture2D(uPressure, vR).x;',
    '  float T = texture2D(uPressure, vT).x;',
    '  float B = texture2D(uPressure, vB).x;',
    '  float div = texture2D(uDivergence, vUv).x;',
    '  float p = (L + R + B + T - div) * 0.25;',
    '  gl_FragColor = vec4(p, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var GRAD_FRAG = [
    'precision highp float;',
    'varying vec2 vUv, vL, vR, vT, vB;',
    'uniform sampler2D uPressure;',
    'uniform sampler2D uVelocity;',
    'void main(){',
    '  float L = texture2D(uPressure, vL).x;',
    '  float R = texture2D(uPressure, vR).x;',
    '  float T = texture2D(uPressure, vT).x;',
    '  float B = texture2D(uPressure, vB).x;',
    '  vec2 vel = texture2D(uVelocity, vUv).xy;',
    '  vel.xy -= vec2(R - L, T - B);',
    '  gl_FragColor = vec4(vel, 0.0, 1.0);',
    '}'
  ].join('\n');

  var CLEAR_FRAG = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTexture;',
    'uniform float value;',
    'void main(){',
    '  gl_FragColor = value * texture2D(uTexture, vUv);',
    '}'
  ].join('\n');

  // Display shader: dye is RGB-additive intensity. We map the max
  // channel onto bg→fg, then bias the hue toward magenta where the dye
  // is reddish (which is how cursor / click splats are colored). This
  // keeps the look monochromatic+restrained while letting cursor strokes
  // glow on-brand.
  var DISPLAY_FRAG = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTexture;',
    'uniform vec3 uBg;',
    'uniform vec3 uFg;',
    'uniform vec3 uMagenta;',
    'void main(){',
    '  vec3 dye = texture2D(uTexture, vUv).rgb;',
    '  float intensity = clamp(max(max(dye.r, dye.g), dye.b), 0.0, 1.0);',
    '  float pinkBias = clamp((dye.r - 0.5*(dye.g + dye.b)) * 2.5, 0.0, 1.0);',
    '  vec3 fg = mix(uFg, uMagenta, pinkBias * 0.55);',
    '  vec3 col = mix(uBg, fg, intensity);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  // ---- Shader compile / program link ----------------------------------
  function compile(type, src){
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      // Fail silently in production; caller falls back to flow.
      return null;
    }
    return s;
  }
  function makeProgram(vsSrc, fsSrc){
    var p = gl.createProgram();
    var vs = compile(gl.VERTEX_SHADER, vsSrc);
    var fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
    var u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i=0; i<n; i++){
      var name = gl.getActiveUniform(p, i).name;
      u[name] = gl.getUniformLocation(p, name);
    }
    return {p: p, u: u};
  }

  var splatProg = makeProgram(BASE_VERT, SPLAT_FRAG);
  var advProg   = makeProgram(BASE_VERT, ADVECT_FRAG);
  var divProg   = makeProgram(BASE_VERT, DIV_FRAG);
  var curlProg  = makeProgram(BASE_VERT, CURL_FRAG);
  var vortProg  = makeProgram(BASE_VERT, VORT_FRAG);
  var presProg  = makeProgram(BASE_VERT, PRESSURE_FRAG);
  var gradProg  = makeProgram(BASE_VERT, GRAD_FRAG);
  var clearProg = makeProgram(BASE_VERT, CLEAR_FRAG);
  var dispProg  = makeProgram(BASE_VERT, DISPLAY_FRAG);
  if (!splatProg || !advProg || !divProg || !curlProg || !vortProg || !presProg || !gradProg || !clearProg || !dispProg) return false;

  // ---- Quad VBO + blit ------------------------------------------------
  var quadV = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadV);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, -1,1, 1,1, 1,-1]), gl.STATIC_DRAW);
  var quadI = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadI);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2, 0,2,3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  function blit(target){
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  // ---- FBOs -----------------------------------------------------------
  function makeFBO(w, h, filter){
    gl.activeTexture(gl.TEXTURE0);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, TT, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      tex: tex, fbo: fbo, width: w, height: h,
      texelX: 1.0 / w, texelY: 1.0 / h,
      attach: function(unit){ gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); return unit; }
    };
  }
  function makeDoubleFBO(w, h, filter){
    var a = makeFBO(w, h, filter);
    var b = makeFBO(w, h, filter);
    return {
      width: w, height: h, texelX: a.texelX, texelY: a.texelY,
      read: a, write: b, swap: function(){ var t = this.read; this.read = this.write; this.write = t; }
    };
  }

  // Sim resolution honors canvas aspect — short edge gets SIM_RES, long
  // edge scales up. Keeps texel size square so splats look round.
  function resolution(target){
    var ar = canvas.width / canvas.height;
    if (ar < 1) ar = 1.0 / ar;
    var lo = Math.round(target);
    var hi = Math.round(target * ar);
    return canvas.width > canvas.height ? {w: hi, h: lo} : {w: lo, h: hi};
  }

  var velocity, dye, divergence, curl, pressure;
  function initFBOs(){
    var sim = resolution(SIM_RES);
    var dyeR = resolution(DYE_RES);
    velocity   = makeDoubleFBO(sim.w, sim.h, gl.LINEAR);
    dye        = makeDoubleFBO(dyeR.w, dyeR.h, gl.LINEAR);
    divergence = makeFBO(sim.w, sim.h, gl.NEAREST);
    curl       = makeFBO(sim.w, sim.h, gl.NEAREST);
    pressure   = makeDoubleFBO(sim.w, sim.h, gl.NEAREST);
  }

  // ---- Canvas sizing --------------------------------------------------
  var dprCap = 1.5;
  function resize(){
    var dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    var w = (canvas.clientWidth * dpr) | 0;
    var h = (canvas.clientHeight * dpr) | 0;
    if (w === canvas.width && h === canvas.height) return false;
    canvas.width = w; canvas.height = h;
    return true;
  }
  resize();
  initFBOs();

  // ---- Splat ----------------------------------------------------------
  function splat(x, y, dx, dy, color){
    gl.useProgram(splatProg.p);
    var aspect = canvas.width / canvas.height;
    gl.uniform1f(splatProg.u.uAspect, aspect);
    gl.uniform2f(splatProg.u.uPoint, x, y);
    gl.uniform1f(splatProg.u.uRadius, SPLAT_RADIUS / 100.0);

    // Velocity splat: encode (dx, dy) as color into vel texture.
    gl.uniform1i(splatProg.u.uTarget, velocity.read.attach(0));
    gl.uniform3f(splatProg.u.uColor, dx, dy, 0.0);
    blit(velocity.write); velocity.swap();

    // Dye splat: same shader, using actual color this time. Scale by
    // DYE_GAIN so all splat colors are quoted at "full strength" but
    // the rendered intensity stays whatever the global tint says.
    gl.uniform1i(splatProg.u.uTarget, dye.read.attach(0));
    gl.uniform3f(splatProg.u.uColor, color.r * DYE_GAIN, color.g * DYE_GAIN, color.b * DYE_GAIN);
    blit(dye.write); dye.swap();
  }

  // ---- Sim step -------------------------------------------------------
  function setTexel(prog, fbo){
    gl.uniform2f(prog.u.texelSize, fbo.texelX, fbo.texelY);
  }

  function step(dt){
    gl.disable(gl.BLEND);

    // 1. curl(vel) → curl
    gl.useProgram(curlProg.p);
    setTexel(curlProg, velocity);
    gl.uniform1i(curlProg.u.uVelocity, velocity.read.attach(0));
    blit(curl);

    // 2. vorticity confinement: vel += force(curl) * dt
    gl.useProgram(vortProg.p);
    setTexel(vortProg, velocity);
    gl.uniform1i(vortProg.u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vortProg.u.uCurl, curl.attach(1));
    gl.uniform1f(vortProg.u.curl, CURL);
    gl.uniform1f(vortProg.u.dt, dt);
    blit(velocity.write); velocity.swap();

    // 3. divergence(vel) → divergence
    gl.useProgram(divProg.p);
    setTexel(divProg, velocity);
    gl.uniform1i(divProg.u.uVelocity, velocity.read.attach(0));
    blit(divergence);

    // 4. dampen pressure (carry-over with dissipation; cheaper than zero clear)
    gl.useProgram(clearProg.p);
    gl.uniform1i(clearProg.u.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProg.u.value, PRESSURE);
    blit(pressure.write); pressure.swap();

    // 5. Jacobi pressure solve (Poisson)
    gl.useProgram(presProg.p);
    setTexel(presProg, velocity);
    gl.uniform1i(presProg.u.uDivergence, divergence.attach(0));
    for (var i=0; i<PRESSURE_ITER; i++){
      gl.uniform1i(presProg.u.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }

    // 6. vel -= grad(pressure) → divergence-free velocity
    gl.useProgram(gradProg.p);
    setTexel(gradProg, velocity);
    gl.uniform1i(gradProg.u.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradProg.u.uVelocity, velocity.read.attach(1));
    blit(velocity.write); velocity.swap();

    // 7. advect velocity through itself
    gl.useProgram(advProg.p);
    setTexel(advProg, velocity);
    var vAttach = velocity.read.attach(0);
    gl.uniform1i(advProg.u.uVelocity, vAttach);
    gl.uniform1i(advProg.u.uSource, vAttach);
    gl.uniform1f(advProg.u.dt, dt);
    gl.uniform1f(advProg.u.dissipation, VEL_DISSIPATION);
    blit(velocity.write); velocity.swap();

    // 8. advect dye by velocity
    setTexel(advProg, velocity);
    gl.uniform1i(advProg.u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advProg.u.uSource, dye.read.attach(1));
    gl.uniform1f(advProg.u.dissipation, DYE_DISSIPATION);
    blit(dye.write); dye.swap();
  }

  // ---- Theme colors (re-read on data-theme change) --------------------
  var bgColor = [0.04, 0.04, 0.043];
  var fgColor = [0.93, 0.93, 0.93];
  var magentaColor = [230/255, 18/255, 100/255];
  function readColors(){
    var s = getComputedStyle(document.documentElement);
    function hex(prop){
      var h = (s.getPropertyValue(prop) || '').trim().replace('#','');
      if (h.length !== 6) return null;
      return [parseInt(h.slice(0,2),16)/255, parseInt(h.slice(2,4),16)/255, parseInt(h.slice(4,6),16)/255];
    }
    bgColor = hex('--bg') || bgColor;
    fgColor = hex('--fg') || fgColor;
    var mrgb = (s.getPropertyValue('--magenta-rgb') || '').trim();
    if (mrgb) {
      var parts = mrgb.split(',');
      if (parts.length === 3) {
        magentaColor = [parseInt(parts[0])/255, parseInt(parts[1])/255, parseInt(parts[2])/255];
      }
    }
  }
  readColors();

  // ---- Display --------------------------------------------------------
  function display(){
    gl.useProgram(dispProg.p);
    gl.uniform1i(dispProg.u.uTexture, dye.read.attach(0));
    gl.uniform3f(dispProg.u.uBg, bgColor[0], bgColor[1], bgColor[2]);
    gl.uniform3f(dispProg.u.uFg, fgColor[0], fgColor[1], fgColor[2]);
    gl.uniform3f(dispProg.u.uMagenta, magentaColor[0], magentaColor[1], magentaColor[2]);
    blit(null);
  }

  // ---- Pointer --------------------------------------------------------
  // Stored in normalized canvas coords with y flipped (WebGL origin
  // bottom-left). Cursor delta drives velocity splats directly; click
  // adds an additional magenta-tinted high-force burst.
  var pointer = {x: -1, y: -1, dx: 0, dy: 0, prevX: -1, prevY: -1, moved: false, color: {r: 0.45, g: 0.45, b: 0.45}};
  function setPointer(clientX, clientY){
    var rect = canvas.getBoundingClientRect();
    var nx = (clientX - rect.left) / rect.width;
    var ny = 1.0 - (clientY - rect.top) / rect.height;
    if (pointer.prevX < 0) { pointer.prevX = nx; pointer.prevY = ny; }
    var ar = canvas.width / canvas.height;
    pointer.dx = (nx - pointer.x) * (ar > 1 ? ar : 1.0);
    pointer.dy = (ny - pointer.y) / (ar > 1 ? 1.0 : ar);
    pointer.prevX = pointer.x; pointer.prevY = pointer.y;
    pointer.x = nx; pointer.y = ny;
    pointer.moved = (Math.abs(pointer.dx) + Math.abs(pointer.dy)) > 0;
  }
  function pulseSplat(){
    if (pointer.x < 0) return;
    var theta = Math.random() * Math.PI * 2;
    var force = 1800;
    splat(pointer.x, pointer.y, Math.cos(theta) * force, Math.sin(theta) * force, {r: 0.95, g: 0.30, b: 0.55});
  }

  // ---- Auto-splat (idle motion) ---------------------------------------
  // Bias toward lower-left where the existing magenta accent glow lives,
  // so the ambient motion overlaps the design accent rather than
  // distributing uniformly. Color is slightly desaturated FG to keep
  // background drift visually quieter than cursor strokes.
  var lastAutoSplat = 0;
  function maybeAutoSplat(now){
    if (now - lastAutoSplat < AUTO_SPLAT_INTERVAL) return;
    lastAutoSplat = now + (Math.random() - 0.5) * 600;
    var x = 0.10 + Math.random() * 0.80;
    var y = 0.10 + Math.random() * 0.65;
    var theta = Math.random() * Math.PI * 2;
    var force = 700 + Math.random() * 500;
    var pinky = Math.random() < 0.18;
    var color = pinky ? {r: 0.55, g: 0.18, b: 0.32} : {r: 0.36, g: 0.36, b: 0.40};
    splat(x, y, Math.cos(theta) * force, Math.sin(theta) * force, color);
  }

  // ---- Frame loop -----------------------------------------------------
  var visible = true;
  var raf = 0;
  var lastT = 0;
  function frame(t){
    raf = 0;
    if (!visible) return;
    var dt = lastT ? Math.min((t - lastT) / 1000, 0.033) : 0.016;
    lastT = t;

    if (resize()) initFBOs();

    if (pointer.moved) {
      pointer.moved = false;
      var dx = pointer.dx * SPLAT_FORCE;
      var dy = pointer.dy * SPLAT_FORCE;
      splat(pointer.x, pointer.y, dx, dy, pointer.color);
    }
    maybeAutoSplat(t);

    step(dt);
    display();

    if (!reduce) raf = requestAnimationFrame(frame);
  }

  // ---- Reduced motion: static initial pattern, then freeze -----------
  if (reduce) {
    for (var i=0; i<8; i++){
      var sx = 0.10 + Math.random() * 0.80;
      var sy = 0.10 + Math.random() * 0.80;
      var st = Math.random() * Math.PI * 2;
      splat(sx, sy, Math.cos(st) * 1200, Math.sin(st) * 1200, {r: 0.42, g: 0.42, b: 0.46});
    }
    for (var k=0; k<60; k++) step(0.016);
    display();
    return true;
  }

  // ---- Listeners ------------------------------------------------------
  var hero = canvas.closest('.hero') || canvas.parentNode;
  if (hero) {
    hero.addEventListener('mousemove', function(e){
      setPointer(e.clientX, e.clientY);
      if (!raf && visible) raf = requestAnimationFrame(frame);
    });
    hero.addEventListener('mousedown', function(e){
      setPointer(e.clientX, e.clientY);
      pulseSplat();
      if (!raf && visible) raf = requestAnimationFrame(frame);
    });
    hero.addEventListener('mouseleave', function(){ pointer.x = -1; pointer.y = -1; });
    hero.addEventListener('touchstart', function(e){
      if (e.touches[0]) { setPointer(e.touches[0].clientX, e.touches[0].clientY); pulseSplat(); if (!raf && visible) raf = requestAnimationFrame(frame); }
    }, {passive:true});
    hero.addEventListener('touchmove', function(e){
      if (e.touches[0]) { setPointer(e.touches[0].clientX, e.touches[0].clientY); if (!raf && visible) raf = requestAnimationFrame(frame); }
    }, {passive:true});
    hero.addEventListener('touchend', function(){ pointer.x = -1; pointer.y = -1; });
  }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        visible = e.isIntersecting;
        if (visible && !raf) { lastT = 0; raf = requestAnimationFrame(frame); }
      });
    }, {threshold: 0}).observe(canvas);
  }

  window.addEventListener('resize', function(){
    if (resize()) initFBOs();
    if (!raf && visible) raf = requestAnimationFrame(frame);
  }, {passive: true});

  new MutationObserver(readColors).observe(document.documentElement, {attributes:true, attributeFilter:['data-theme']});

  // Seed a few splats so the hero isn't blank for the first second.
  for (var s=0; s<6; s++){
    var x0 = 0.15 + Math.random() * 0.70;
    var y0 = 0.20 + Math.random() * 0.65;
    var t0 = Math.random() * Math.PI * 2;
    splat(x0, y0, Math.cos(t0) * 1000, Math.sin(t0) * 1000, {r: 0.40, g: 0.40, b: 0.44});
  }

  raf = requestAnimationFrame(frame);
  return true;
};
