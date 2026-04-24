(function(){
  var SCROLL_SHRINK_PX = 40;
  var SCROLL_HIDE_PX = 200;
  var SCROLL_HIDE_VELOCITY = 6;
  var SCROLL_SHOW_VELOCITY = 4;
  var SCROLL_SHOW_PX = 100;
  var SECTION_ACTIVE_OFFSET = 200;
  var NAV_OFFSET_PX = 80;
  var REVEAL_ROOT_MARGIN_BOTTOM = 60;

  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Respect reduced-motion: stop autoplay on demo videos, keep poster visible.
  if (reducedMotion) {
    document.querySelectorAll('video[autoplay]').forEach(function(v){
      v.removeAttribute('autoplay');
      v.pause();
      v.setAttribute('controls','');
    });
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

    var sections = ['about','products','team','partners'];
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
  window.addEventListener('scroll', onScroll, {passive:true});
  onScroll();

  // Theme toggle — persists to localStorage
  var themeBtn = document.getElementById('themeToggle');
  var stored = null;
  try { stored = localStorage.getItem('synx_v2_theme'); } catch(e){ console.warn('v2: theme read failed', e); }
  if (stored === 'light') document.documentElement.setAttribute('data-theme','light');
  if (themeBtn) {
    themeBtn.addEventListener('click', function(){
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'light' ? 'dark' : 'light';
      if (next === 'dark') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme','light');
      try { localStorage.setItem('synx_v2_theme', next); } catch(e){ console.warn('v2: theme persist failed', e); }
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
      window.scrollTo({top:y, behavior:'smooth'});
    });
  });
})();
