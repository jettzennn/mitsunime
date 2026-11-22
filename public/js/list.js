/* Halaman daftar bersih per seksi (item 42 v1.5.8) — "Lihat Semua" dari
   beranda. HANYA judul seksi + grid kartu + tombol "Muat lagi" + footer.
   Tanpa kolom pencarian, tanpa chip genre, tanpa filter — semua itu
   tetap hanya di search.html. Urutan kartu SAMA dengan rail beranda
   (endpoint yang sama, halaman demi halaman). */
(function () {
  'use strict';

  var PER_PAGE = 20;

  var SECTIONS = {
    recent: {
      accent: 'Episode', rest: 'Terbaru', fetchFn: getRecent,
      emptyTitle: 'Belum ada episode terbaru',
      emptyText: 'Katalog belum tersinkron. Jalankan sync terlebih dahulu, lalu muat ulang halaman ini.',
    },
    top: {
      accent: 'Rating', rest: 'Tertinggi', fetchFn: getTop, rank: true,
      emptyTitle: 'Belum ada data rating',
      emptyText: 'Katalog belum tersinkron. Jalankan sync terlebih dahulu, lalu muat ulang halaman ini.',
    },
    airing: {
      accent: 'Sedang', rest: 'Tayang', fetchFn: getAiring,
      emptyTitle: 'Tidak ada yang sedang tayang',
      emptyText: 'Saat ini tidak ada judul dengan status Sedang Tayang di katalog.',
    },
  };

  function sectionFromUrl() {
    var q = new URLSearchParams(window.location.search);
    return q.get('section') || '';
  }

  var section = sectionFromUrl();
  var cfg = SECTIONS[section];
  /* Seksi tidak dikenal / kosong → kembali ke Beranda (bukan error). */
  if (!cfg) { window.location.replace('/'); return; }

  var titleEl = document.getElementById('list-title');
  var gridEl = document.getElementById('list-grid');
  var moreWrap = document.getElementById('list-more-wrap');
  var moreBtn = document.getElementById('btn-more');

  var titleText = cfg.accent + ' ' + cfg.rest;
  document.title = titleText + ' — Mitsunime';
  titleEl.innerHTML = '<span class="accent-word">' + esc(cfg.accent) + '</span> ' + esc(cfg.rest);

  var page = 0; /* halaman terakhir yang berhasil dimuat (0 = belum ada) */
  var totalPages = Infinity;
  var loading = false;
  var seenIds = {}; /* pengaman duplikat: id yang sudah tampil di grid */
  var renderedCount = 0; /* jumlah kartu yang sudah tampil (untuk rank top) */
  var finished = false;

  function setLoading(on) {
    loading = on;
    moreBtn.disabled = on;
    moreBtn.textContent = on ? 'Memuat…' : 'Muat lagi';
  }

  function showMore() {
    moreWrap.hidden = finished || page >= totalPages;
  }

  function renderItems(items) {
    var html = '';
    var added = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var id = it && it.id != null ? String(it.id) : '';
      if (!id || seenIds[id]) continue; /* lewati duplikat */
      seenIds[id] = true;
      renderedCount++;
      var opts = {};
      if (cfg.rank) opts.rank = renderedCount;
      html += cardHTML(it, opts);
      added++;
    }
    if (added) gridEl.insertAdjacentHTML('beforeend', html);
    return added;
  }

  async function loadNext() {
    if (loading || finished) return;
    setLoading(true);
    var nextPage = page + 1;
    try {
      var res = await cfg.fetchFn(nextPage, PER_PAGE);
      var items = Array.isArray(res.data) ? res.data : [];
      var pagination = res.pagination || null;
      if (pagination && typeof pagination.total_pages === 'number') {
        totalPages = pagination.total_pages;
      } else if (items.length < PER_PAGE) {
        totalPages = nextPage; /* halaman terakhir: kurang dari satu halaman penuh */
      }
      page = nextPage;
      if (page === 1 && gridEl.querySelector('.skeleton')) gridEl.innerHTML = '';
      if (page === 1 && items.length === 0) {
        gridEl.innerHTML = stateHTML('empty', cfg.emptyTitle, cfg.emptyText);
        finished = true;
      } else {
        renderItems(items);
        if (page >= totalPages) finished = true;
      }
    } catch (err) {
      if (page === 0) {
        gridEl.innerHTML = stateHTML('error', 'Daftar gagal dimuat',
          (err && err.message) || 'Terjadi kesalahan.', 'Muat Ulang', window.location.href);
      }
      /* Gagal di halaman lanjutan: biarkan tombol "Muat lagi" hidup supaya
         pengguna bisa mencoba lagi; jangan tandai selesai. */
    } finally {
      setLoading(false);
      showMore();
    }
  }

  gridEl.innerHTML = skeletonGridHTML(10);
  moreBtn.addEventListener('click', loadNext);
  loadNext();
})();
