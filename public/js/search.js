/* ============================================================
   search.js — Halaman pencarian Mitsunime (task-10)
   Kolom cari debounce 300ms → /api/search (FTS5 dari database
   lokal). Filter genre/status/tahun. Bila belum mengetik apa pun,
   tampilkan Jelajahi Genre + Daftar A–Z. Hasil kosong memakai
   keadaan kosong yang jujur, bukan hasil kosong yang menyesatkan.
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  mountChrome('search');
  var params = new URLSearchParams(window.location.search);
  initYearOptions();
  initGenreChips();
  initAzLetters();
  var input = document.getElementById('search-input');
  var clearBtn = document.getElementById('search-clear');
  document.getElementById('search-icon').innerHTML = icon('search');
  var q = params.get('q') || '';
  var status = params.get('status') || '';
  var genre = params.get('genre') || '';
  if (q) input.value = q;
  if (status) document.getElementById('filter-status').value = status;
  if (genre) searchState.genre = genre;

  var timer = null;
  function scheduleSearch() {
    clearTimeout(timer);
    timer = setTimeout(function () { runSearch(1); }, 300);
  }
  input.addEventListener('input', function () {
    clearBtn.hidden = input.value.trim() === '';
    scheduleSearch();
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); runSearch(1); }
    if (e.key === 'Escape') { input.value = ''; clearBtn.hidden = true; runSearch(1); input.blur(); }
  });
  clearBtn.addEventListener('click', function () {
    input.value = '';
    clearBtn.hidden = true;
    runSearch(1);
    input.focus();
  });
  document.getElementById('filter-status').addEventListener('change', function () { runSearch(1); });
  document.getElementById('filter-year').addEventListener('change', function () { runSearch(1); });
  document.getElementById('btn-prev-page').addEventListener('click', function () { runSearch(searchState.page - 1); });
  document.getElementById('btn-next-page').addEventListener('click', function () { runSearch(searchState.page + 1); });

  if (q || status || genre) {
    clearBtn.hidden = input.value.trim() === '';
    runSearch(1);
  }
});

var searchState = { q: '', genre: '', status: '', year: '', page: 1, totalPages: 1, hasQuery: false };
var _searchRun = 0;

function initYearOptions() {
  var sel = document.getElementById('filter-year');
  var now = new Date().getFullYear();
  for (var y = now + 1; y >= 1990; y--) {
    var opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = String(y);
    sel.appendChild(opt);
  }
}

function initGenreChips() {
  var box = document.getElementById('genre-chips');
  var grid = document.getElementById('genre-grid');
  getGenres().then(function (res) {
    var genres = res.data || [];
    box.innerHTML = genres.slice(0, 12).map(function (g) {
      return '<button class="chip" type="button" data-genre="' + esc(g.name) + '">' + esc(g.name) + '</button>';
    }).join('');
    grid.innerHTML = genres.map(function (g) {
      return '<a class="genre-card" href="/genre.html?name=' + encodeURIComponent(g.name) + '">' + esc(g.name) + ' <span class="count">' + esc(g.count) + ' judul</span></a>';
    }).join('');
    box.querySelectorAll('[data-genre]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-genre');
        searchState.genre = searchState.genre === name ? '' : name;
        box.querySelectorAll('[data-genre]').forEach(function (b) {
          b.classList.toggle('is-active', b.getAttribute('data-genre') === searchState.genre);
        });
        runSearch(1);
      });
    });
  }).catch(function () {
    box.innerHTML = '<span class="muted small">Genre belum bisa dimuat.</span>';
    grid.innerHTML = '';
  });
}

function initAzLetters() {
  var box = document.getElementById('az-letters');
  var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');
  box.innerHTML = letters.map(function (letter) {
    return '<a class="az-letter" href="/az.html?huruf=' + encodeURIComponent(letter) + '" aria-label="Judul berawalan ' + esc(letter) + '">' + esc(letter) + '</a>';
  }).join('');
}

function currentFilters() {
  return {
    q: document.getElementById('search-input').value.trim(),
    genre: searchState.genre,
    status: document.getElementById('filter-status').value,
    year: document.getElementById('filter-year').value,
  };
}

async function runSearch(page) {
  var f = currentFilters();
  searchState.q = f.q;
  searchState.status = f.status;
  searchState.year = f.year;
  searchState.page = Math.max(1, page || 1);
  /* v1.5.2 item 3: saat kolom pencarian berisi teks, chip genre +
     label "Genre:" disembunyikan — halaman khusus menampilkan hasil.
     Chip kembali saat kolom dikosongkan. Filter status/tahun tetap
     terlihat dan tetap berfungsi. (Chip genre yang dipilih lewat
     klik tanpa mengetik tetap tampil, karena q kosong.) */
  var genreChipsEl = document.getElementById('genre-chips');
  var genreLabelEl = document.getElementById('genre-label');
  var hideGenre = !!f.q;
  if (genreChipsEl) genreChipsEl.hidden = hideGenre;
  if (genreLabelEl) genreLabelEl.hidden = hideGenre;
  var hasQuery = !!(f.q || f.genre || f.status || f.year);
  searchState.hasQuery = hasQuery;
  var resultsEl = document.getElementById('search-results');
  var countEl = document.getElementById('result-count');
  var pagEl = document.getElementById('pagination');
  var exploreEl = document.getElementById('sec-explore');
  var azEl = document.getElementById('sec-az');
  var myRun = ++_searchRun;
  if (!hasQuery) {
    resultsEl.innerHTML = '';
    countEl.textContent = '';
    pagEl.hidden = true;
    exploreEl.hidden = false;
    azEl.hidden = false;
    return;
  }
  exploreEl.hidden = true;
  azEl.hidden = true;
  resultsEl.innerHTML = skeletonGridHTML(10);
  countEl.textContent = 'Mencari…';
  try {
    var res = await searchAnime(f.q, {
      genre: f.genre, status: f.status, year: f.year,
      page: searchState.page, perPage: 20,
    });
    if (myRun !== _searchRun) return;
    searchState.totalPages = (res.pagination && res.pagination.total_pages) || 1;
    if (!res.data.length) {
      var msg = res.message || (f.q
        ? 'Tidak ditemukan anime dengan judul itu.'
        : 'Tidak ada judul yang cocok dengan filter itu.');
      resultsEl.innerHTML = stateHTML('empty', 'Tidak ditemukan', msg, 'Hapus Pencarian', '/search.html');
      countEl.textContent = '0 judul ditemukan';
      pagEl.hidden = true;
      return;
    }
    countEl.textContent = res.total + ' judul ditemukan' + (res.stale ? ' (data mungkin tidak terbaru)' : '');
    resultsEl.innerHTML = res.data.map(function (it) { return cardHTML(it); }).join('');
    pagEl.hidden = searchState.totalPages <= 1;
    document.getElementById('page-info').textContent = 'Halaman ' + searchState.page + ' dari ' + searchState.totalPages;
    document.getElementById('btn-prev-page').disabled = searchState.page <= 1;
    document.getElementById('btn-next-page').disabled = searchState.page >= searchState.totalPages;
    if (res.message && res.data.length) showBanner('warning', res.message);
  } catch (err) {
    if (myRun !== _searchRun) return;
    resultsEl.innerHTML = stateHTML('error', 'Pencarian gagal', (err && err.message) || 'Terjadi kesalahan.', 'Muat Ulang', window.location.href);
    countEl.textContent = '';
    pagEl.hidden = true;
  }
}
