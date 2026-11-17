/* ============================================================
   browse.js — Halaman genre, A–Z, dan Daftar Saya (task-10)
   Dipakai genre.html, az.html, dan favorites.html.
   Daftar Saya: server (/api/favorites) bila login, localStorage
   bila tamu.
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  var path = window.location.pathname;
  if (path.indexOf('genre.html') !== -1) {
    mountChrome('genre');
    initGenrePage();
  } else if (path.indexOf('az.html') !== -1) {
    mountChrome('az');
    initAzPage();
  } else if (path.indexOf('favorites.html') !== -1) {
    mountChrome('favorites');
    initFavoritesPage();
  } else {
    mountChrome('home');
  }
});

var browse = { page: 1, totalPages: 1 };

function bindPagination(onPage) {
  document.getElementById('btn-prev-page').addEventListener('click', function () { onPage(browse.page - 1); });
  document.getElementById('btn-next-page').addEventListener('click', function () { onPage(browse.page + 1); });
}

function renderPagination() {
  var pag = document.getElementById('pagination');
  if (!pag) return;
  pag.hidden = browse.totalPages <= 1;
  document.getElementById('page-info').textContent = 'Halaman ' + browse.page + ' dari ' + browse.totalPages;
  document.getElementById('btn-prev-page').disabled = browse.page <= 1;
  document.getElementById('btn-next-page').disabled = browse.page >= browse.totalPages;
}

/* ---------- Halaman genre ---------- */
function initGenrePage() {
  var params = new URLSearchParams(window.location.search);
  var name = params.get('name') || '';
  if (!name) {
    document.getElementById('page-title').textContent = 'Genre';
    document.getElementById('sec-results').hidden = true;
    loadAllGenres();
    return;
  }
  document.getElementById('sec-genres').hidden = true;
  document.getElementById('page-title').textContent = name.toUpperCase();
  document.title = name + ' — Mitsunime';
  document.getElementById('sec-results').hidden = false;
  bindPagination(function (p) { loadGenre(name, p); });
  loadGenre(name, 1);
}

function loadAllGenres() {
  var grid = document.getElementById('genre-grid');
  grid.innerHTML = skeletonGridHTML(8);
  getGenres().then(function (res) {
    if (!res.data.length) {
      grid.innerHTML = stateHTML('empty', 'Belum ada genre', 'Katalog belum tersinkron. Jalankan sync terlebih dahulu.');
      return;
    }
    grid.innerHTML = res.data.map(function (g) {
      return '<a class="genre-card" href="/genre.html?name=' + encodeURIComponent(g.name) + '">' + esc(g.name) + ' <span class="count">' + esc(g.count) + ' judul</span></a>';
    }).join('');
  }).catch(function (err) {
    grid.innerHTML = stateHTML('error', 'Genre gagal dimuat', (err && err.message) || 'Terjadi kesalahan.', 'Muat Ulang', window.location.href);
  });
}

async function loadGenre(name, page) {
  browse.page = Math.max(1, page || 1);
  var box = document.getElementById('results');
  var countEl = document.getElementById('page-count');
  box.innerHTML = skeletonGridHTML(10);
  try {
    var res = await getGenre(name, browse.page, 20);
    browse.totalPages = (res.pagination && res.pagination.total_pages) || 1;
    countEl.textContent = res.total + ' judul bergenre ' + name;
    if (!res.data.length) {
      box.innerHTML = stateHTML('empty', 'Belum ada judul di genre ini.', res.message || ('Tidak ada anime bergenre "' + name + '" di katalog.'));
    } else {
      box.innerHTML = res.data.map(function (it) { return cardHTML(it); }).join('');
    }
    renderPagination();
  } catch (err) {
    box.innerHTML = stateHTML('error', 'Genre gagal dimuat', (err && err.message) || 'Terjadi kesalahan.', 'Muat Ulang', window.location.href);
  }
}

/* ---------- Halaman A–Z ---------- */
function initAzPage() {
  var params = new URLSearchParams(window.location.search);
  var letter = (params.get('huruf') || 'A').toUpperCase();
  var box = document.getElementById('az-letters');
  var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');
  box.innerHTML = letters.map(function (l) {
    return '<a class="az-letter' + (l === letter ? ' is-active' : '') + '" href="/az.html?huruf=' + encodeURIComponent(l) + '" aria-label="Judul berawalan ' + esc(l) + '">' + esc(l) + '</a>';
  }).join('');
  document.title = 'Daftar A–Z — ' + letter + ' — Mitsunime';
  bindPagination(function (p) { loadAz(letter, p); });
  loadAz(letter, 1);
}

async function loadAz(letter, page) {
  browse.page = Math.max(1, page || 1);
  var box = document.getElementById('results');
  var countEl = document.getElementById('page-count');
  box.innerHTML = skeletonGridHTML(10);
  try {
    var res = await getAZ(letter, browse.page, 20);
    browse.totalPages = (res.pagination && res.pagination.total_pages) || 1;
    countEl.textContent = res.total + ' judul berawalan huruf ' + letter;
    if (!res.data.length) {
      box.innerHTML = stateHTML('empty', 'Belum ada judul di huruf ini.', 'Tidak ada judul yang diawali huruf ' + letter + ' di katalog.');
    } else {
      box.innerHTML = res.data.map(function (it) { return cardHTML(it); }).join('');
    }
    renderPagination();
  } catch (err) {
    box.innerHTML = stateHTML('error', 'Daftar A–Z gagal dimuat', (err && err.message) || 'Terjadi kesalahan.', 'Muat Ulang', window.location.href);
  }
}

/* ---------- Halaman Daftar Saya ---------- */
async function initFavoritesPage() {
  var box = document.getElementById('results');
  box.innerHTML = skeletonGridHTML(10);
  try {
    var me = await currentUser();
    var list = [];
    if (me) {
      var res = await apiFavorites();
      list = res.data;
    } else {
      list = getLocalFavorites();
    }
    if (!list.length) {
      box.innerHTML = stateHTML('empty', 'Belum ada favorit', 'Tambahkan anime ke Daftar Saya dari halaman detail anime.', 'Jelajahi Anime', '/');
      return;
    }
    box.innerHTML = list.map(function (it) { return cardHTML(it, { remove: true }); }).join('');
    box.querySelectorAll('[data-remove-fav]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        removeFav(btn.getAttribute('data-remove-fav'));
      });
    });
  } catch (err) {
    box.innerHTML = stateHTML('error', 'Daftar Saya gagal dimuat', (err && err.message) || 'Terjadi kesalahan.', 'Muat Ulang', window.location.href);
  }
}

async function removeFav(animeId) {
  try {
    var me = await currentUser();
    if (me) await apiRemoveFavorite(animeId);
    else removeLocalFavorite(animeId);
    showToast('Dihapus dari Daftar Saya.');
    initFavoritesPage();
  } catch (err) {
    showToast((err && err.message) || 'Gagal menghapus favorit.', 'error');
  }
}
