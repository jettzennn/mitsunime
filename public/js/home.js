/* ============================================================
   home.js — Beranda Mitsunime (task-09)
   Hero carousel dari Rating Tertinggi (5 judul), lalu Episode
   Terbaru, Rating Tertinggi, Sedang Tayang, dan Lanjutkan Menonton
   (hanya pengguna login, dari /api/continue).
   Label "Rating Tertinggi" dipakai karena API tidak memberi data
   trending sungguhan — section tidak pernah menyebut "Trending".
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  mountChrome('home');
  initRailArrows();
  loadHome();
});

var HERO_COUNT = 5;
var HERO_INTERVAL_MS = 7000;
var hero = { items: [], idx: 0, timer: null, paused: false };

function initRailArrows() {
  document.querySelectorAll('.rail-arrow').forEach(function (btn) {
    btn.innerHTML = btn.classList.contains('rail-arrow--left') ? icon('chevronLeft') : icon('chevronRight');
    btn.addEventListener('click', function () {
      var rail = document.getElementById(btn.getAttribute('data-rail'));
      if (!rail) return;
      var dir = btn.classList.contains('rail-arrow--left') ? -1 : 1;
      rail.scrollBy({ left: dir * rail.clientWidth * 0.8, behavior: 'smooth' });
    });
  });
  document.querySelectorAll('.rail').forEach(function (rail) {
    var wrap = rail.closest('.rail-wrap');
    if (!wrap) return;
    var left = wrap.querySelector('.rail-arrow--left');
    var right = wrap.querySelector('.rail-arrow--right');
    function update() {
      if (left) left.disabled = rail.scrollLeft <= 4;
      if (right) right.disabled = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 4;
    }
    rail.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
    setTimeout(update, 300);
  });
}

async function loadHome() {
  loadContinue();
  var recentEl = document.getElementById('rail-recent');
  var topEl = document.getElementById('grid-top');
  var airingEl = document.getElementById('rail-airing');
  recentEl.innerHTML = skeletonGridHTML(6).replace(/skeleton-card/g, 'skeleton-card');
  topEl.innerHTML = skeletonGridHTML(10);
  airingEl.innerHTML = skeletonGridHTML(6);
  try {
    var results = await Promise.allSettled([
      getRecent(1, 12),
      getTop(1, 10),
      getAiring(1, 12),
    ]);
    var recent = results[0];
    var top = results[1];
    var airing = results[2];
    var anyOk = false;
    if (recent.status === 'fulfilled' && recent.value.data.length) {
      anyOk = true;
      recentEl.innerHTML = recent.value.data.map(function (it) { return cardHTML(it); }).join('');
      if (recent.value.stale) showBanner('warning', staleBannerText(recent.value.anikotoDown));
    } else {
      recentEl.innerHTML = stateHTML('empty', 'Belum ada episode terbaru', 'Katalog belum tersinkron. Jalankan sync terlebih dahulu, lalu muat ulang halaman ini.');
    }
    if (top.status === 'fulfilled' && top.value.data.length) {
      anyOk = true;
      topEl.innerHTML = top.value.data.map(function (it, i) { return cardHTML(it, { rank: i + 1 }); }).join('');
      buildHero(top.value.data.slice(0, HERO_COUNT));
    } else {
      topEl.innerHTML = stateHTML('empty', 'Belum ada data rating', 'Katalog belum tersinkron. Jalankan sync terlebih dahulu, lalu muat ulang halaman ini.');
    }
    if (airing.status === 'fulfilled' && airing.value.data.length) {
      anyOk = true;
      airingEl.innerHTML = airing.value.data.map(function (it) { return cardHTML(it); }).join('');
    } else {
      airingEl.innerHTML = stateHTML('empty', 'Tidak ada yang sedang tayang', 'Saat ini tidak ada judul dengan status Sedang Tayang di katalog.');
    }
    document.querySelectorAll('.rail').forEach(function (rail) {
      rail.dispatchEvent(new Event('scroll'));
    });
    if (!anyOk) showBanner('error', 'Katalog belum bisa dimuat. Periksa server masih berjalan, lalu muat ulang.', true);
  } catch (err) {
    recentEl.innerHTML = stateHTML('error', 'Beranda gagal dimuat', (err && err.message) || 'Terjadi kesalahan.', 'Muat Ulang', window.location.href);
    topEl.innerHTML = '';
    airingEl.innerHTML = '';
  }
}

async function loadContinue() {
  var sec = document.getElementById('sec-continue');
  var rail = document.getElementById('rail-continue');
  if (!sec || !rail) return;
  try {
    var res = await apiContinue();
    var list = res.data.filter(function (it) { return (it.percent || 0) < 100; });
    if (!list.length) { sec.hidden = true; return; }
    sec.hidden = false;
    rail.innerHTML = list.map(function (it) {
      return cardHTML(it, { continueItem: it });
    }).join('');
    rail.dispatchEvent(new Event('scroll'));
  } catch (err) {
    sec.hidden = true; /* tamu / server mati: section tidak tampil */
  }
}

/* ---------- Hero carousel ---------- */
function buildHero(items) {
  hero.items = items;
  hero.idx = 0;
  var heroEl = document.getElementById('hero');
  var slidesEl = document.getElementById('hero-slides');
  var thumbsEl = document.getElementById('hero-thumbs');
  var dotsEl = document.getElementById('hero-dots');
  if (!heroEl || !items.length) return;
  heroEl.hidden = false;
  slidesEl.innerHTML = items.map(function (item, i) {
    var score = scoreNum(item);
    var genres = genreList(item).slice(0, 4).join(' · ');
    return '<article class="hero__slide' + (i === 0 ? ' is-active' : '') + '" data-slide="' + i + '">' +
      '<div class="hero__bg">' + bgImg(item) + '</div>' +
      '<div class="hero__content">' +
        '<span class="hero__rank">#' + (i + 1) + ' Rating Tertinggi</span>' +
        '<h2 class="hero__title display-title">' + esc(displayTitle(item)) + '</h2>' +
        (item.description ? '<p class="hero__synopsis">' + esc(item.description) + '</p>' : '') +
        '<div class="hero__meta">' +
          (score != null ? '<span class="hero__score">' + icon('star') + ' ' + score.toFixed(2) + '</span>' : '') +
          (genres ? '<span class="hero__genres">' + esc(genres) + '</span>' : '') +
        '</div>' +
        '<div class="hero__badges" style="margin-top:12px">' + badgesHTML(item, false) + '</div>' +
        '<div class="hero__actions">' +
          '<a class="btn btn-primary" href="/watch.html?id=' + encodeURIComponent(item.id) + '&ep=1">' + icon('play') + ' Tonton</a>' +
          '<a class="btn btn-ghost" href="/detail.html?id=' + encodeURIComponent(item.id) + '">Detail</a>' +
        '</div>' +
      '</div>' +
    '</article>';
  }).join('');
  thumbsEl.innerHTML = items.map(function (item, i) {
    return '<button class="hero__thumb' + (i === 0 ? ' is-active' : '') + '" type="button" data-thumb="' + i + '" aria-label="Slide ' + (i + 1) + ': ' + esc(displayTitle(item)) + '">' +
      '<img src="' + esc(item.background_image || item.poster || PLACEHOLDER_IMG) + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=\'' + PLACEHOLDER_IMG + '\'">' +
      '<span>' + esc(displayTitle(item)) + '</span></button>';
  }).join('');
  dotsEl.innerHTML = items.map(function (_, i) {
    return '<button class="hero__dot' + (i === 0 ? ' is-active' : '') + '" type="button" data-dot="' + i + '" role="tab" aria-label="Slide ' + (i + 1) + '"></button>';
  }).join('');
  document.getElementById('hero-prev').innerHTML = icon('chevronLeft');
  document.getElementById('hero-next').innerHTML = icon('chevronRight');
  document.getElementById('hero-prev').addEventListener('click', function () { goHero(hero.idx - 1); restartHeroTimer(); });
  document.getElementById('hero-next').addEventListener('click', function () { goHero(hero.idx + 1); restartHeroTimer(); });
  thumbsEl.querySelectorAll('[data-thumb]').forEach(function (btn) {
    btn.addEventListener('click', function () { goHero(parseInt(btn.getAttribute('data-thumb'), 10)); restartHeroTimer(); });
  });
  dotsEl.querySelectorAll('[data-dot]').forEach(function (btn) {
    btn.addEventListener('click', function () { goHero(parseInt(btn.getAttribute('data-dot'), 10)); restartHeroTimer(); });
  });
  heroEl.addEventListener('mouseenter', function () { hero.paused = true; stopHeroTimer(); });
  heroEl.addEventListener('mouseleave', function () { hero.paused = false; restartHeroTimer(); });
  heroEl.addEventListener('touchstart', function () { hero.paused = true; stopHeroTimer(); }, { passive: true });
  heroEl.addEventListener('touchend', function () { hero.paused = false; restartHeroTimer(); }, { passive: true });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopHeroTimer();
    else if (!hero.paused) restartHeroTimer();
  });
  updateHeroUI();
  restartHeroTimer();
}

function goHero(idx) {
  if (!hero.items.length) return;
  hero.idx = ((idx % hero.items.length) + hero.items.length) % hero.items.length;
  updateHeroUI();
}

function updateHeroUI() {
  document.querySelectorAll('.hero__slide').forEach(function (el, i) {
    el.classList.toggle('is-active', i === hero.idx);
  });
  document.querySelectorAll('.hero__thumb').forEach(function (el, i) {
    el.classList.toggle('is-active', i === hero.idx);
  });
  document.querySelectorAll('.hero__dot').forEach(function (el, i) {
    el.classList.toggle('is-active', i === hero.idx);
  });
  var page = document.getElementById('hero-page');
  if (page) page.textContent = String(hero.idx + 1).padStart(2, '0');
  var prog = document.getElementById('hero-progress');
  if (prog) prog.style.width = Math.round(((hero.idx + 1) / hero.items.length) * 100) + '%';
  /* v1.5.2 item 8: di strip mobile, geser strip supaya thumb aktif
     selalu kelihatan. Hanya menggeser kontainer strip (scrollLeft)
     — tidak pernah menggerakkan scroll halaman. */
  var thumbsEl = document.getElementById('hero-thumbs');
  var activeThumb = thumbsEl && thumbsEl.querySelector('.hero__thumb.is-active');
  if (thumbsEl && activeThumb) {
    var tr = thumbsEl.getBoundingClientRect();
    var ar = activeThumb.getBoundingClientRect();
    if (ar.left < tr.left) thumbsEl.scrollLeft += ar.left - tr.left - 8;
    else if (ar.right > tr.right) thumbsEl.scrollLeft += ar.right - tr.right + 8;
  }
}

function stopHeroTimer() {
  if (hero.timer) { clearInterval(hero.timer); hero.timer = null; }
}
function restartHeroTimer() {
  stopHeroTimer();
  if (hero.items.length <= 1) return;
  hero.timer = setInterval(function () { goHero(hero.idx + 1); }, HERO_INTERVAL_MS);
}
