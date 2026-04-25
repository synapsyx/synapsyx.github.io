(function(){
  var SCROLL_SHRINK_PX = 40;
  var SCROLL_HIDE_PX = 200;
  var SCROLL_HIDE_VELOCITY = 6;
  var SCROLL_SHOW_VELOCITY = 4;
  var SCROLL_SHOW_PX = 100;
  var SECTION_ACTIVE_OFFSET = 200;
  var NAV_OFFSET_PX = 80;
  var REVEAL_ROOT_MARGIN_BOTTOM = 60;

  var reducedMotionMQ = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  var autoplayVideos = document.querySelectorAll('video[autoplay]');

  function stopAutoplay(){
    autoplayVideos.forEach(function(v){
      v.removeAttribute('autoplay');
      v.pause();
      v.setAttribute('controls','');
    });
  }

  if (reducedMotionMQ) {
    if (reducedMotionMQ.matches) stopAutoplay();
    // Honor mid-session preference changes (once reduced, stays reduced —
    // restoring autoplay after load is unreliable cross-browser).
    if (reducedMotionMQ.addEventListener) {
      reducedMotionMQ.addEventListener('change', function(e){ if (e.matches) stopAutoplay(); });
    }
  }

  // Hero generative background — three drafts, each defined as a global
  // window.synxHeroX(canvas) earlier in the bundle. Variant chosen by
  // ?hero=mesh|network|flow (default: mesh). If the chosen one returns
  // false (e.g. no WebGL for mesh), we fall through to the next available
  // variant. On success, .hero gets .has-canvas which fades the static
  // grid fallback. This dispatcher exists for reviewing all three side by
  // side; collapses to a single chosen variant after selection.
  function pickHeroVariant(){
    try {
      var p = new URLSearchParams(location.search);
      var v = p.get('hero');
      if (v === 'mesh' || v === 'network' || v === 'flow') return v;
    } catch(e){}
    return 'mesh';
  }
  var heroCanvas = document.querySelector('.hero-canvas');
  if (heroCanvas) {
    var hero = heroCanvas.closest('.hero');
    var first = pickHeroVariant();
    var order = [first];
    if (first !== 'mesh') order.push('mesh');
    if (order.indexOf('network') < 0) order.push('network');
    if (order.indexOf('flow') < 0) order.push('flow');
    var heroFns = {mesh:window.synxHeroMesh, network:window.synxHeroNetwork, flow:window.synxHeroFlow};
    for (var hi=0; hi<order.length; hi++){
      var fn = heroFns[order[hi]];
      if (typeof fn === 'function' && fn(heroCanvas) !== false) {
        if (hero) {
          hero.classList.add('has-canvas');
          hero.setAttribute('data-hero-variant', order[hi]);
        }
        break;
      }
    }
  }

  // Footprint globe — deferred init via IntersectionObserver so the canvas
  // doesn't allocate or compute anything until the section is near-viewport.
  // Data is embedded as a <script type="application/json"> block alongside
  // the canvas container; globe.js (window.synxGlobe) reads it.
  var globeContainer = document.querySelector('.footprint-canvas[data-globe]');
  if (globeContainer && typeof window.synxGlobe === 'function' && 'IntersectionObserver' in window) {
    var globeMounted = false;
    var globeObs = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if (!globeMounted && e.isIntersecting) {
          var dataEl = globeContainer.querySelector('#footprint-data');
          if (!dataEl) return;
          var data = null;
          try { data = JSON.parse(dataEl.textContent); } catch(err){ console.warn('globe: data parse failed', err); return; }
          if (window.synxGlobe(globeContainer, data) !== false) {
            globeMounted = true;
            globeObs.disconnect();
          }
        }
      });
    }, {rootMargin:'200px 0px'});
    globeObs.observe(globeContainer);
  }

  // Loading splash dismissal. The inline anti-flash script in baseof.html sets
  // html[data-loaded] before paint when sessionStorage says we've shown it
  // already this tab; CSS hides the overlay in that case, and we just clear
  // the orphan node here to keep the DOM tidy.
  var v2Loading = document.getElementById('v2Loading');
  if (v2Loading) {
    var alreadyLoaded = document.documentElement.hasAttribute('data-loaded');
    if (alreadyLoaded) {
      v2Loading.parentNode.removeChild(v2Loading);
    } else {
      document.documentElement.classList.add('v2-loading-active');
      var reduceLoading = reducedMotionMQ && reducedMotionMQ.matches;
      var loadingHoldMs = reduceLoading ? 0 : 1900;
      var loadingFadeMs = reduceLoading ? 0 : 650;
      var dismissLoading = function(){
        if (v2Loading.parentNode) v2Loading.parentNode.removeChild(v2Loading);
        document.documentElement.classList.remove('v2-loading-active');
        document.documentElement.setAttribute('data-loaded','');
        try { sessionStorage.setItem('synx_v2_loaded_once','1'); } catch(e){}
      };
      var fadeLoading = function(){
        setTimeout(function(){
          v2Loading.classList.add('is-out');
          setTimeout(dismissLoading, loadingFadeMs);
        }, loadingHoldMs);
      };
      if (document.readyState === 'complete') fadeLoading();
      else window.addEventListener('load', fadeLoading);
    }
  }

  // Scroll reveal via IntersectionObserver
  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, {threshold:0.12, rootMargin:'0px 0px -' + REVEAL_ROOT_MARGIN_BOTTOM + 'px 0px'});
    revealEls.forEach(function(el){ io.observe(el); });
  } else {
    revealEls.forEach(function(el){ el.classList.add('in'); });
  }

  // Nav scroll behavior: shrink on scroll + hide on scroll-down + progress bar + active section
  var nav = document.getElementById('nav');
  var progress = document.getElementById('navProgress');
  var lastY = 0;
  function onScroll(){
    if (!nav) return;
    var y = window.scrollY || window.pageYOffset;
    if (y > SCROLL_SHRINK_PX) nav.classList.add('scrolled'); else nav.classList.remove('scrolled');
    if (y > SCROLL_HIDE_PX && y > lastY + SCROLL_HIDE_VELOCITY) nav.classList.add('hidden');
    else if (y < lastY - SCROLL_SHOW_VELOCITY || y < SCROLL_SHOW_PX) nav.classList.remove('hidden');
    lastY = y;

    if (progress) {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      var pct = h > 0 ? Math.min(100, Math.max(0, (y/h)*100)) : 0;
      progress.style.width = pct + '%';
    }

    var sections = ['about','products','team','partners','footprint'];
    var current = '';
    for (var i=0;i<sections.length;i++){
      var el = document.getElementById(sections[i]);
      if (el && el.getBoundingClientRect().top < SECTION_ACTIVE_OFFSET) current = sections[i];
    }
    document.querySelectorAll('.nav .links a').forEach(function(a){
      var isActive = a.getAttribute('data-target') === current;
      a.classList.toggle('active', isActive);
      if (isActive) a.setAttribute('aria-current', 'location');
      else a.removeAttribute('aria-current');
    });
  }
  // Coalesce scroll-driven DOM writes to one per frame — the raw scroll
  // event fires dozens of times/sec and onScroll does classList toggles,
  // style writes, and getBoundingClientRect reads.
  var scrollRafPending = false;
  function onScrollThrottled(){
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(function(){
      scrollRafPending = false;
      onScroll();
    });
  }
  window.addEventListener('scroll', onScrollThrottled, {passive:true});
  onScroll();

  // Theme toggle — persists to localStorage; falls back to OS preference
  // when no explicit choice has been made (matches the inline anti-flash
  // script in baseof.html so first-paint and JS state agree).
  var themeBtn = document.getElementById('themeToggle');
  var prefersLightMQ = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
  function readStoredTheme(){
    try { return localStorage.getItem('synx_v2_theme'); } catch(e){ return null; }
  }
  function applyTheme(theme){
    if (theme === 'light') document.documentElement.setAttribute('data-theme','light');
    else document.documentElement.removeAttribute('data-theme');
    syncThemeButton();
  }
  function syncThemeButton(){
    if (!themeBtn) return;
    var isLight = document.documentElement.getAttribute('data-theme') === 'light';
    themeBtn.setAttribute('aria-pressed', isLight ? 'true' : 'false');
    themeBtn.setAttribute('aria-label', isLight ? 'Switch to dark theme' : 'Switch to light theme');
  }
  syncThemeButton();
  if (themeBtn) {
    themeBtn.addEventListener('click', function(){
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'light' ? 'dark' : 'light';
      applyTheme(next);
      try { localStorage.setItem('synx_v2_theme', next); } catch(e){ console.warn('v2: theme persist failed', e); }
    });
  }
  // Follow OS theme changes only when the user hasn't made an explicit choice.
  if (prefersLightMQ && prefersLightMQ.addEventListener) {
    prefersLightMQ.addEventListener('change', function(e){
      var s = readStoredTheme();
      if (s === 'light' || s === 'dark') return;
      applyTheme(e.matches ? 'light' : 'dark');
    });
  }

  // Smooth scroll for in-page anchors (covers #top too)
  document.querySelectorAll('a[href^="#"]').forEach(function(a){
    a.addEventListener('click', function(e){
      var h = a.getAttribute('href');
      if (!h || h === '#') return;
      var target = h === '#top' ? document.body : document.querySelector(h);
      if (!target) return;
      e.preventDefault();
      var y = h === '#top' ? 0 : (target.getBoundingClientRect().top + window.scrollY - NAV_OFFSET_PX);
      var prefersReduced = reducedMotionMQ && reducedMotionMQ.matches;
      window.scrollTo({top:y, behavior: prefersReduced ? 'auto' : 'smooth'});
      // Update the URL so deep-links are shareable, and move keyboard focus
      // to the target so tabbing continues from the new location. For #top,
      // strip the hash entirely for a clean URL.
      if (history.replaceState) {
        history.replaceState(null, '', h === '#top' ? (location.pathname + location.search) : h);
      }
      if (h !== '#top' && typeof target.focus === 'function') {
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({preventScroll: true});
      }
    });
  });
})();
