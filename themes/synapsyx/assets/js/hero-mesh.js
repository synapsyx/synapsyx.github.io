/* hero-mesh — generative WebGL hero variant for /v2/.
   Fullscreen-quad fragment shader: layered 2D simplex noise (FBM) blended
   from --bg toward the magenta accent, with a soft lower-left glow that
   tracks the existing hero accent placement. Runs at devicePixelRatio
   capped to 1.5x; pauses RAF when the hero is offscreen; honors
   prefers-reduced-motion by rendering a single static frame.

   Returns false on WebGL unavailable so the dispatcher can fall back. */
window.synxHeroMesh = function(canvas){
  var gl = canvas.getContext('webgl', {alpha:false,antialias:false,premultipliedAlpha:false}) ||
           canvas.getContext('experimental-webgl', {alpha:false,antialias:false,premultipliedAlpha:false});
  if (!gl) return false;

  var VERT = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}';
  var FRAG = [
    'precision mediump float;',
    'uniform vec2 u_res;',
    'uniform float u_t;',
    'uniform vec3 u_bg;',
    'uniform vec3 u_acc;',
    'vec3 permute(vec3 x){return mod(((x*34.0)+1.0)*x,289.0);}',
    'float sn(vec2 v){',
    '  const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);',
    '  vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);',
    '  vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);',
    '  vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;i=mod(i,289.0);',
    '  vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));',
    '  vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);',
    '  m=m*m;m=m*m;',
    '  vec3 x=2.0*fract(p*C.www)-1.0;vec3 h=abs(x)-0.5;vec3 ox=floor(x+0.5);vec3 a0=x-ox;',
    '  m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);',
    '  vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;',
    '  return 130.0*dot(m,g);',
    '}',
    'void main(){',
    '  vec2 p=(gl_FragCoord.xy-u_res*0.5)/u_res.y;',
    '  float t=u_t*0.05;',
    '  float n=sn(p*0.9+vec2(t,t*0.6))*0.55;',
    '  n+=sn(p*1.8+vec2(-t*1.1,t*0.8))*0.28;',
    '  n+=sn(p*3.4+vec2(t*0.3,-t*1.4))*0.14;',
    '  n=n*0.5+0.5;',
    '  float glow=smoothstep(1.4,0.0,length(p+vec2(0.55,0.25)));',
    '  vec3 col=mix(u_bg,u_acc,n*0.16+glow*0.55);',
    '  float vig=smoothstep(1.5,0.4,length(p));',
    '  col*=vig*0.5+0.5;',
    '  gl_FragColor=vec4(col,1.0);',
    '}'
  ].join('\n');

  function compile(type, src){
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('hero-mesh: shader compile failed', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }
  var vs = compile(gl.VERTEX_SHADER, VERT);
  var fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return false;
  var prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
  gl.useProgram(prog);

  var quad = new Float32Array([-1,-1, 1,-1, -1,1, 1,-1, 1,1, -1,1]);
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  var aPos = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  var uRes = gl.getUniformLocation(prog, 'u_res');
  var uT   = gl.getUniformLocation(prog, 'u_t');
  var uBg  = gl.getUniformLocation(prog, 'u_bg');
  var uAcc = gl.getUniformLocation(prog, 'u_acc');

  function hexToFloats(h){
    h = (h || '').replace('#','').trim();
    if (h.length !== 6) return null;
    return [parseInt(h.slice(0,2),16)/255, parseInt(h.slice(2,4),16)/255, parseInt(h.slice(4,6),16)/255];
  }
  function readColors(){
    var s = getComputedStyle(document.documentElement);
    var bg = hexToFloats(s.getPropertyValue('--bg')) || [0.04,0.04,0.045];
    var acc = hexToFloats(s.getPropertyValue('--magenta')) || [0.9,0.07,0.39];
    return {bg:bg, acc:acc};
  }
  var colors = readColors();

  var dprCap = 1.5;
  function resize(){
    var dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    var w = canvas.clientWidth | 0;
    var h = canvas.clientHeight | 0;
    var W = (w*dpr) | 0, H = (h*dpr) | 0;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W; canvas.height = H;
      gl.viewport(0, 0, W, H);
    }
  }

  var startT = performance.now();
  var raf = 0;
  var visible = true;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function frame(){
    raf = 0;
    if (!visible) return;
    resize();
    var t = (performance.now() - startT) / 1000;
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uT, reduce ? 14.0 : t);
    gl.uniform3f(uBg, colors.bg[0], colors.bg[1], colors.bg[2]);
    gl.uniform3f(uAcc, colors.acc[0], colors.acc[1], colors.acc[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (!reduce) raf = requestAnimationFrame(frame);
  }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        visible = e.isIntersecting;
        if (visible && !raf && !reduce) raf = requestAnimationFrame(frame);
      });
    }, {threshold:0}).observe(canvas);
  }

  new MutationObserver(function(){
    colors = readColors();
    if (!raf) raf = requestAnimationFrame(frame);
  }).observe(document.documentElement, {attributes:true, attributeFilter:['data-theme']});

  window.addEventListener('resize', function(){ if (!raf) raf = requestAnimationFrame(frame); }, {passive:true});

  frame();
  return true;
};
