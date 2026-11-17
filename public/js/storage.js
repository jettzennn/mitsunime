/* ============================================================
   storage.js — Data lokal Mitsunime (localStorage, untuk tamu)
   - Favorit tamu: dipakai bila pengguna BELUM login. Bila sudah
     login, favorit memakai endpoint server (/api/favorites).
   - Episode ditonton: penanda lokal, dipakai untuk centang di
     daftar episode saat data server belum dimuat.
   - Lanjutkan Menonton: hanya dari server (menonton wajib login),
     jadi tidak ada salinan lokal di sini.
   Semua dibungkus try/catch: bila storage penuh / dibersihkan,
   halaman tetap jalan (fitur lokal hilang, bukan halaman rusak).
   ============================================================ */

var LS_FAVORITES = 'mitsu_favorites_v1';
var LS_WATCHED = 'mitsu_watched_v1';

function lsRead(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function lsWrite(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    return false;
  }
}

/* ---------- Favorit tamu ---------- */
function getLocalFavorites() {
  var list = lsRead(LS_FAVORITES, []);
  return Array.isArray(list) ? list : [];
}

function isLocalFavorite(animeId) {
  return getLocalFavorites().some(function (f) { return String(f.id) === String(animeId); });
}

function toggleLocalFavorite(anime) {
  var list = getLocalFavorites();
  var id = String(anime.id);
  var exists = list.some(function (f) { return String(f.id) === id; });
  if (exists) {
    list = list.filter(function (f) { return String(f.id) !== id; });
  } else {
    list.unshift({
      id: anime.id,
      title: anime.title || '',
      poster: anime.poster || '',
      score: anime.score || null,
      year: anime.year || null,
      status: anime.status || '',
      is_sub: anime.is_sub || 0,
      is_dub: anime.is_dub || 0,
      sub_indo: anime.sub_indo || 0,
      terms_by_type: anime.terms_by_type || null,
      savedAt: Date.now(),
    });
  }
  lsWrite(LS_FAVORITES, list);
  return !exists;
}

function removeLocalFavorite(animeId) {
  var list = getLocalFavorites().filter(function (f) { return String(f.id) !== String(animeId); });
  lsWrite(LS_FAVORITES, list);
}

/* ---------- Episode ditonton (penanda lokal) ---------- */
function markEpisodeWatchedLocal(animeId, epNumber) {
  var map = lsRead(LS_WATCHED, {});
  map[String(animeId) + ':' + epNumber] = Date.now();
  lsWrite(LS_WATCHED, map);
}

function isEpisodeWatchedLocal(animeId, epNumber) {
  var map = lsRead(LS_WATCHED, {});
  return !!map[String(animeId) + ':' + epNumber];
}

/* ---------- Util waktu (Bahasa Indonesia) ---------- */
function timeAgo(ts) {
  if (!ts) return '';
  var ms = ts < 10000000000 ? ts * 1000 : ts;
  var diff = Date.now() - ms;
  if (diff < 0) diff = 0;
  var menit = Math.floor(diff / 60000);
  if (menit < 1) return 'baru saja';
  if (menit < 60) return menit + ' mnt lalu';
  var jam = Math.floor(menit / 60);
  if (jam < 24) return jam + ' jam lalu';
  var hari = Math.floor(jam / 24);
  if (hari < 7) return hari + ' hari lalu';
  var minggu = Math.floor(hari / 7);
  if (minggu < 5) return minggu + ' minggu lalu';
  return Math.floor(hari / 30) + ' bln lalu';
}

function formatDuration(sec) {
  if (!sec || sec <= 0) return '';
  var m = Math.floor(sec / 60);
  var s = Math.floor(sec % 60);
  if (m >= 60) {
    var h = Math.floor(m / 60);
    return h + ' jam ' + (m % 60) + ' mnt';
  }
  return s > 0 ? m + ' mnt ' + s + ' dtk' : m + ' mnt';
}
