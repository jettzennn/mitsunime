/* ============================================================
   detail.js — Halaman detail anime Mitsunime (task-09)
   Backdrop + poster + metadata + sinopsis + chip SUB/DUB dan
   SUB INDO (hanya bila sub_indo = 1, sudah diverifikasi admin) +
   daftar episode bernomor + tombol Daftar Saya.
   TIDAK ada konten terkunci di v1: semua episode bisa ditonton
   pengguna yang sudah login.
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  mountChrome('home');
  var params = new URLSearchParams(window.location.search);
  var id = params.get('id');
  if (!id) {
    document.getElementById('detail-root').innerHTML =
      stateHTML('empty', 'Anime tidak ditemukan', 'Tautan detail tidak membawa ID anime.', 'Kembali ke Beranda', '/');
    return;
  }
  initDetail(id);
});

var PAGE_SIZE = 50;
var EP_SEARCH_MAX = 100; /* v1.5.8 item 50: hasil pencarian yang ditampilkan */
var detail = { anime: null, episodes: [], shown: PAGE_SIZE, asc: true, fav: false, loggedIn: false, progress: {}, query: '', searchBound: false };

async function initDetail(id) {
  var root = document.getElementById('detail-root');
  root.innerHTML = '<div class="skeleton" style="height:320px;border-radius:20px"></div>' +
    '<div class="skeleton" style="height:28px;margin-top:16px;width:60%"></div>' +
    '<div class="skeleton" style="height:14px;margin-top:10px;width:90%"></div>' +
    '<div class="skeleton" style="height:14px;margin-top:8px;width:80%"></div>';
  try {
    var res = await getSeries(id);
    if (!res.anime) {
      root.innerHTML = stateHTML('empty', 'Anime tidak ditemukan', 'Anime dengan ID ' + id + ' tidak ada di katalog.', 'Kembali ke Beranda', '/');
      return;
    }
    detail.anime = res.anime;
    detail.episodes = (res.episodes || []).slice().sort(function (a, b) { return (a.number || 0) - (b.number || 0); });
    if (res.stale) showBanner('warning', staleBannerText(res.anikotoDown));
    document.title = decodeEntities(displayTitle(res.anime) || 'Detail Anime') + ' — Mitsunime';
    renderDetail();
    renderEpisodeList();
    loadRelated(res.anime);
    loadFavoriteState();
    loadProgress();
  } catch (err) {
    var status = err && err.status;
    root.innerHTML = stateHTML('error', 'Detail gagal dimuat', (err && err.message) || 'Terjadi kesalahan.',
      status === 404 ? 'Kembali ke Beranda' : 'Muat Ulang',
      status === 404 ? '/' : window.location.href);
  }
}

function renderDetail() {
  var a = detail.anime;
  var score = scoreNum(a);
  var genres = genreList(a);
  var studios = (a.terms_by_type && Array.isArray(a.terms_by_type.studios)) ? a.terms_by_type.studios : [];
  var sub = parseInt(a.is_sub, 10) || 0;
  var dub = parseInt(a.is_dub, 10) || 0;
  var firstEp = detail.episodes.length ? detail.episodes[0].number : 1;
  var watchHref = '/watch.html?id=' + encodeURIComponent(a.id) + '&ep=' + firstEp;
  var html =
    '<div class="detail-hero">' +
      '<div class="detail-backdrop">' + bgImg(a) + '</div>' +
      '<div class="detail-body">' +
        '<div class="detail-poster">' + posterImg(a) + '</div>' +
        '<div class="detail-info">' +
          '<h1 class="page-title">' + esc(displayTitle(a)) + '</h1>' +
          '<div class="detail-meta">' +
            (a.year ? '<span>' + esc(a.year) + '</span>' : '') +
            (animeType(a) ? '<span>' + esc(animeType(a)) + '</span>' : '') +
            (a.status ? '<span>' + esc(statusLabel(a.status)) + '</span>' : '') +
            (score != null ? '<span class="score">' + icon('star') + ' ' + score.toFixed(2) + '</span>' : '') +
            (studios.length ? '<span>' + esc(studios.join(', ')) + '</span>' : '') +
            (a.duration ? '<span>' + esc(a.duration) + '</span>' : '') +
          '</div>' +
          '<div class="detail-chips">' + badgesHTML(a, true) + '</div>' +
          (a.description ? '<p class="detail-synopsis">' + esc(a.description) + '</p>' : '') +
          (genres.length ? '<div class="detail-chips">' + genres.map(function (g) {
            return '<a class="chip chip-static" href="/genre.html?name=' + encodeURIComponent(g) + '">' + esc(g) + '</a>';
          }).join('') + '</div>' : '') +
          '<div class="detail-actions">' +
            '<a class="btn btn-primary" href="' + watchHref + '" id="btn-watch">' + icon('play') + ' Tonton</a>' +
            '<button class="btn btn-ghost" id="btn-fav" type="button">+ Daftar Saya</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.getElementById('detail-root').innerHTML = html;
  var favBtn = document.getElementById('btn-fav');
  if (favBtn) favBtn.addEventListener('click', onToggleFav);
}

async function loadFavoriteState() {
  var a = detail.anime;
  if (!a) return;
  try {
    var me = await currentUser();
    detail.loggedIn = !!me;
    if (me) {
      var list = await apiFavorites();
      detail.fav = list.data.some(function (f) { return String(f.id) === String(a.id); });
    } else {
      detail.fav = isLocalFavorite(a.id);
    }
  } catch (err) {
    detail.fav = isLocalFavorite(a.id);
  }
  updateFavBtn();
}

function updateFavBtn() {
  var btn = document.getElementById('btn-fav');
  if (!btn) return;
  if (detail.fav) {
    btn.innerHTML = '✓ Sudah di Daftar Saya';
    btn.classList.add('is-active');
  } else {
    btn.textContent = '+ Daftar Saya';
    btn.classList.remove('is-active');
  }
}

async function onToggleFav() {
  var a = detail.anime;
  if (!a) return;
  var btn = document.getElementById('btn-fav');
  if (btn) btn.disabled = true;
  try {
    if (detail.loggedIn) {
      if (detail.fav) {
        await apiRemoveFavorite(a.id);
        detail.fav = false;
        showToast('Dihapus dari Daftar Saya.');
      } else {
        await apiAddFavorite(a.id);
        detail.fav = true;
        showToast('Ditambahkan ke Daftar Saya.');
      }
    } else {
      detail.fav = toggleLocalFavorite(a);
      showToast(detail.fav ? 'Ditambahkan ke Daftar Saya (disimpan di HP ini).' : 'Dihapus dari Daftar Saya.');
    }
    updateFavBtn();
  } catch (err) {
    showToast((err && err.message) || 'Gagal menyimpan favorit.', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadProgress() {
  try {
    var res = await apiProgress(detail.anime.id);
    detail.progress = {};
    res.data.forEach(function (p) { detail.progress[p.episode] = p; });
    renderEpisodeList();
  } catch (err) {
    /* tamu: tanpa data server, centang lokal tetap dipakai */
  }
}

/* ---------- Daftar episode ---------- */

/* v1.5.8 item 49: ambang ditonton klien ≥90% (server memakai 95% — lihat
   diagnosis-item49.md). Tamu: hanya penanda lokal. */
function isEpisodeWatchedDetail(ep) {
  var prog = detail.progress[ep.number];
  var pct = prog && typeof prog.percent === 'number' ? prog.percent : null;
  if (pct !== null && pct >= 90) return true;
  if (prog && prog.watched) return true;
  return isEpisodeWatchedLocal(detail.anime.id, ep.number);
}

function episodeItemHTML(ep) {
  var watched = isEpisodeWatchedDetail(ep);
  return '<a class="episode-item' + (watched ? ' is-watched' : '') + '" href="/watch.html?id=' + encodeURIComponent(detail.anime.id) + '&ep=' + ep.number + '">' +
    '<span class="episode-item__num">' + esc(ep.number) + '</span>' +
    '<span class="episode-item__body">' +
      '<span class="episode-item__title">' + esc(ep.title || ('Episode ' + ep.number)) + '</span>' +
      (ep.jp_title ? '<span class="episode-item__sub">' + esc(ep.jp_title) + '</span>' : '') +
    '</span>' +
    (watched ? '<span class="episode-item__watched" title="Sudah ditonton">' + icon('check') + '<span class="episode-item__watched-label">Sudah ditonton</span></span>' : '') +
    '<span class="episode-item__chev">' + icon('chevron') + '</span></a>';
}

/* v1.5.8 item 50: cocokkan episode dengan kueri — nomor ("12" cocok
   dengan 12, 120–129) atau potongan judul (tidak peka huruf besar). */
function episodeMatchesQuery(ep, q) {
  if (!q) return true;
  if (String(ep.number).indexOf(q) !== -1) return true;
  var needle = q.toLowerCase();
  if ((ep.title || '').toLowerCase().indexOf(needle) !== -1) return true;
  return (ep.jp_title || '').toLowerCase().indexOf(needle) !== -1;
}

var _epSearchTimer = null;
function bindEpisodeSearch() {
  if (detail.searchBound) return;
  var input = document.getElementById('ep-search');
  var clearBtn = document.getElementById('ep-search-clear');
  var iconEl = document.getElementById('ep-search-icon');
  if (!input) return;
  detail.searchBound = true;
  if (iconEl) iconEl.innerHTML = icon('search');
  function applyQuery() {
    detail.query = input.value.trim();
    detail.shown = PAGE_SIZE;
    renderEpisodeList();
  }
  input.addEventListener('input', function () {
    if (clearBtn) clearBtn.hidden = !input.value;
    if (_epSearchTimer) clearTimeout(_epSearchTimer);
    _epSearchTimer = setTimeout(applyQuery, 150);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (_epSearchTimer) { clearTimeout(_epSearchTimer); _epSearchTimer = null; }
    applyQuery();
    /* Enter membuka episode pertama yang cocok (urut tampil saat ini). */
    var list = detail.episodes.slice();
    list.sort(function (x, y) { return detail.asc ? (x.number - y.number) : (y.number - x.number); });
    for (var i = 0; i < list.length; i++) {
      if (episodeMatchesQuery(list[i], detail.query)) {
        window.location.href = '/watch.html?id=' + encodeURIComponent(detail.anime.id) + '&ep=' + list[i].number;
        return;
      }
    }
  });
  if (clearBtn) clearBtn.addEventListener('click', function () {
    input.value = '';
    clearBtn.hidden = true;
    if (_epSearchTimer) { clearTimeout(_epSearchTimer); _epSearchTimer = null; }
    detail.query = '';
    detail.shown = PAGE_SIZE;
    renderEpisodeList();
    input.focus();
  });
}

function renderEpisodeList() {
  var sec = document.getElementById('sec-episodes');
  var box = document.getElementById('episode-list');
  var btnMore = document.getElementById('btn-more-episodes');
  var searchInfo = document.getElementById('ep-search-info');
  var countEl = document.getElementById('ep-count');
  if (!sec || !box) return;
  var list = detail.episodes.slice();
  list.sort(function (x, y) { return detail.asc ? (x.number - y.number) : (y.number - x.number); });
  sec.hidden = false;
  if (countEl) countEl.textContent = list.length ? list.length + ' episode' : '';
  bindEpisodeSearch();
  if (!list.length) {
    box.innerHTML = stateHTML('empty', 'Belum ada episode', 'Daftar episode belum tersedia untuk judul ini.');
    if (btnMore) btnMore.hidden = true;
    if (searchInfo) searchInfo.textContent = '';
    return;
  }
  var q = detail.query;
  var filtered = q ? list.filter(function (ep) { return episodeMatchesQuery(ep, q); }) : list;
  var shown;
  if (q) {
    /* Mode cari: tampilkan hingga 100 hasil pertama + hitungan jujur;
       tanpa "Muat lagi" (data sudah di klien — nol request per ketikan). */
    shown = filtered.slice(0, EP_SEARCH_MAX);
    if (searchInfo) {
      searchInfo.textContent = filtered.length
        ? 'Menampilkan ' + shown.length + ' dari ' + filtered.length + ' episode'
        : 'Tidak ada episode yang cocok dengan "' + q + '"';
    }
    if (btnMore) btnMore.hidden = true;
  } else {
    shown = filtered.slice(0, detail.shown);
    if (searchInfo) {
      searchInfo.textContent = shown.length
        ? 'Menampilkan Ep ' + shown[0].number + '–' + shown[shown.length - 1].number + ' dari ' + list.length + ' episode'
        : '';
    }
    if (btnMore) {
      btnMore.hidden = detail.shown >= list.length;
      btnMore.onclick = function () { detail.shown += PAGE_SIZE; renderEpisodeList(); };
    }
  }
  box.innerHTML = shown.length
    ? shown.map(episodeItemHTML).join('')
    : stateHTML('empty', 'Tidak ada episode', 'Tidak ada episode yang cocok dengan pencarian ini.');
  var sortBtn = document.getElementById('btn-ep-sort');
  if (sortBtn) {
    sortBtn.textContent = detail.asc ? 'Urutan: Naik' : 'Urutan: Turun';
    sortBtn.onclick = function () { detail.asc = !detail.asc; renderEpisodeList(); };
  }
}

async function loadRelated(anime) {
  var sec = document.getElementById('sec-related');
  var rail = document.getElementById('rail-related');
  if (!sec || !rail) return;
  var genres = genreList(anime);
  if (!genres.length) { sec.hidden = true; return; }
  try {
    var res = await getGenre(genres[0], 1, 12);
    var items = res.data.filter(function (it) { return String(it.id) !== String(anime.id); }).slice(0, 8);
    if (!items.length) { sec.hidden = true; return; }
    sec.hidden = false;
    rail.innerHTML = items.map(function (item) { return cardHTML(item); }).join('');
    rail.dispatchEvent(new Event('scroll'));
  } catch (err) {
    sec.hidden = true;
  }
}
