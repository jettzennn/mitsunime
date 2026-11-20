/* ============================================================
   detail.js — Halaman detail anime Mitsunime (task-09)
   Backdrop + poster + metadata + sinopsis + chip SUB/DUB dan
   SUB INDO (hanya bila sub_indo = 1, sudah diverifikasi admin) +
   daftar episode bernomor + tombol Daftar Saya.
   TIDAK ada konten terkunci di v1: semua episode bisa ditonton
   pengguna yang sudah login, premium atau bukan.
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
var detail = { anime: null, episodes: [], shown: PAGE_SIZE, jump: 0, asc: true, fav: false, loggedIn: false, progress: {} };

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
function renderEpisodeList() {
  var sec = document.getElementById('sec-episodes');
  var box = document.getElementById('episode-list');
  var btnMore = document.getElementById('btn-more-episodes');
  var jumpSel = document.getElementById('ep-jump-select');
  var jumpInfo = document.getElementById('ep-jump-info');
  var countEl = document.getElementById('ep-count');
  if (!sec || !box) return;
  var list = detail.episodes.slice();
  list.sort(function (x, y) { return detail.asc ? (x.number - y.number) : (y.number - x.number); });
  sec.hidden = false;
  if (countEl) countEl.textContent = list.length ? list.length + ' episode' : '';
  if (!list.length) {
    box.innerHTML = stateHTML('empty', 'Belum ada episode', 'Daftar episode belum tersedia untuk judul ini.');
    if (btnMore) btnMore.hidden = true;
    if (jumpSel) jumpSel.hidden = true;
    return;
  }
  var totalPages = Math.ceil(list.length / PAGE_SIZE);
  if (jumpSel) {
    var opts = '';
    for (var p = 0; p < totalPages; p++) {
      opts += '<option value="' + p + '"' + (p === detail.jump ? ' selected' : '') + '>Ep ' + list[p * PAGE_SIZE].number + '–' + list[Math.min((p + 1) * PAGE_SIZE, list.length) - 1].number + '</option>';
    }
    jumpSel.innerHTML = opts;
    jumpSel.hidden = totalPages <= 1;
    jumpSel.onchange = function () {
      detail.jump = parseInt(jumpSel.value, 10) || 0;
      detail.shown = PAGE_SIZE;
      renderEpisodeList();
    };
  }
  var start = detail.jump * PAGE_SIZE;
  var shown = list.slice(start, start + detail.shown);
  if (jumpInfo) jumpInfo.textContent = 'Menampilkan Ep ' + shown[0].number + '–' + shown[shown.length - 1].number + ' dari ' + list.length + ' episode';
  box.innerHTML = shown.map(function (ep) {
    var prog = detail.progress[ep.number];
    var watched = (prog && prog.watched) || isEpisodeWatchedLocal(detail.anime.id, ep.number);
    return '<a class="episode-item" href="/watch.html?id=' + encodeURIComponent(detail.anime.id) + '&ep=' + ep.number + '">' +
      '<span class="episode-item__num">' + esc(ep.number) + '</span>' +
      '<span class="episode-item__body">' +
        '<span class="episode-item__title">' + esc(ep.title || ('Episode ' + ep.number)) + '</span>' +
        (ep.jp_title ? '<span class="episode-item__sub">' + esc(ep.jp_title) + '</span>' : '') +
      '</span>' +
      (watched ? '<span class="episode-item__watched" title="Sudah ditonton">' + icon('check') + '</span>' : '') +
      '<span class="episode-item__chev">' + icon('chevron') + '</span></a>';
  }).join('');
  if (btnMore) {
    btnMore.hidden = (start + detail.shown) >= list.length;
    btnMore.onclick = function () { detail.shown += PAGE_SIZE; renderEpisodeList(); };
  }
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
