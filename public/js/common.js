/* ============================================================
   common.js — Helper UI bersama Mitsunime (dipakai semua halaman)
   Ikon: SVG inline saja, tanpa emoji. Warna: hanya lewat variabel CSS.
   ============================================================ */

var PLACEHOLDER_IMG = '/img/placeholder.svg';
var MEGAPLAY_ORIGIN = 'https://megaplay.buzz';

/* Dekode HTML entity dari payload API (Anikoto menyimpan judul episode
   mentah, mis. "President&#39;s Daughter…" — terbukti di series_cache).
   Aman dipakai sebelum esc(): hasil decode TIDAK pernah dimasukkan mentah
   ke innerHTML; esc() selalu meng-escape ulang. Idempotent. */
var NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#34': '"',
  nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', times: '×',
  divide: '÷', plusmn: '±', deg: '°', laquo: '«', raquo: '»', middot: '·',
  eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', oacute: 'ó', uacute: 'ú',
  iacute: 'í', ntilde: 'ñ', ccedil: 'ç', szlig: 'ß', ouml: 'ö', uuml: 'ü',
  auml: 'ä', euml: 'ë', iuml: 'ï', aring: 'å', aelig: 'æ', oslash: 'ø',
};

function decodeEntities(value) {
  var s = String(value == null ? '' : value);
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, function (m, body) {
    if (body.charAt(0) === '#') {
      var code;
      if (body.charAt(1) === 'x' || body.charAt(1) === 'X') code = parseInt(body.slice(2), 16);
      else code = parseInt(body.slice(1), 10);
      if (!isFinite(code) || code <= 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return m;
      try { return String.fromCodePoint(code); } catch (e) { return m; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : m;
  });
}

/* Escape teks dari API sebelum dimasukkan ke HTML (anti-XSS).
   PENTING: decode dulu, baru escape. */
function esc(value) {
  return decodeEntities(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Ikon SVG inline (stroke 2, ukuran 16 default). */
var ICONS = {
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>',
  play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  playBig: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  heart: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>',
  heartFill: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>',
  home: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
  grid: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  az: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 9 4-5 4 5"/><path d="M5 9h8"/><path d="m9 16 5 5 5-5"/><path d="M19 16H9"/></svg>',
  chevron: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  chevronLeft: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
  chevronRight: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  empty: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>',
  star: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.26 6.6.57-5 4.36 1.5 6.45L12 16.9 5.99 19.64l1.5-6.45-5-4.36 6.6-.57z"/></svg>',
  clock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>',
  x: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  menu: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>',
  user: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  crown: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 8l4.5 3.5L12 5l4.5 6.5L21 8l-1.8 10H4.8L3 8zm1.4 11h15.2v2H4.4v-2z"/></svg>',
  eye: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
  /* Ikon pensil (v1.3.2): tombol ubah profil di sudut avatar. */
  pencil: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
  /* Ikon gerigi setelan (v1.3.3): WAJIB gerigi untuk "Setelan akun"
     di popover akun sidebar. SVG inline stroke, gaya Lucide settings. */
  gear: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  settings: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  /* Ikon surat (v1.3.3): opsi "Ganti Email" di container akun
     sidebar. SVG inline stroke, gaya Lucide mail. */
  mail: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>',
  email: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>',
  /* Ikon gembok/kunci (v1.3.3): opsi "Ganti Password" di container
     akun sidebar. SVG inline stroke, gaya Lucide lock. */
  lock: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  key: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  /* Ikon pintu keluar (v1.3.3): opsi "Keluar" di popover akun
     sidebar. SVG inline stroke, gaya Lucide log-out (pintu + panah). */
  logout: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  door: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
};

function icon(name) { return ICONS[name] || ''; }

/* ---------- Format data API ---------- */
function scoreNum(item) {
  var s = parseFloat(item && item.score);
  return isNaN(s) ? null : s;
}

function animeType(item) {
  var t = item && item.terms_by_type;
  if (t && Array.isArray(t.type) && t.type[0]) return t.type[0];
  return '';
}

function genreList(item) {
  var t = item && item.terms_by_type;
  if (t && Array.isArray(t.genre)) return t.genre;
  return [];
}

function statusLabel(status) {
  if (status === 'Currently Airing') return 'Sedang Tayang';
  if (status === 'Finished Airing') return 'Tamat';
  if (status === 'Not yet aired' || status === 'Not yet published') return 'Segera Tayang';
  return status || '';
}

function badgesHTML(item, withCount) {
  var out = '';
  var sub = parseInt(item.is_sub, 10) || 0;
  var dub = parseInt(item.is_dub, 10) || 0;
  if (sub > 0) out += '<span class="badge badge-sub">SUB' + (withCount ? ' ' + sub : '') + '</span>';
  if (dub > 0) out += '<span class="badge badge-dub">DUB' + (withCount ? ' ' + dub : '') + '</span>';
  /* SUB INDO hanya bila admin sudah memverifikasi (sub_indo = 1). */
  if (item.sub_indo === 1 || item.sub_indo === true) out += '<span class="badge badge-subindo">SUB INDO</span>';
  return out;
}

function metaLine(item) {
  var parts = [];
  if (item.year) parts.push(item.year);
  var t = animeType(item);
  if (t) parts.push(t);
  var sl = statusLabel(item.status);
  if (sl) parts.push(sl);
  var sub = parseInt(item.is_sub, 10) || 0;
  if (sub > 0) parts.push(sub + ' ep');
  return parts.join(' · ');
}

function posterImg(item, cls) {
  var src = (item && item.poster) ? esc(item.poster) : PLACEHOLDER_IMG;
  return '<img src="' + src + '" alt="' + esc(item && item.title ? item.title : 'Poster anime') + '"' +
    (cls ? ' class="' + cls + '"' : '') + ' loading="lazy"' +
    ' onerror="this.onerror=null;this.src=\'' + PLACEHOLDER_IMG + '\'">';
}

function bgImg(item) {
  var src = (item && (item.background_image || item.poster)) ? esc(item.background_image || item.poster) : PLACEHOLDER_IMG;
  return '<img src="' + src + '" alt="" loading="lazy"' +
    ' onerror="this.onerror=null;this.src=\'' + PLACEHOLDER_IMG + '\'">';
}

function cardHTML(item, opts) {
  opts = opts || {};
  var score = scoreNum(item);
  var extra = '';
  if (opts.rank) extra += '<span class="anime-card__rank">#' + opts.rank + '</span>';
  if (opts.remove) extra += '<button class="anime-card__remove" data-remove-fav="' + esc(item.id) + '" aria-label="Hapus ' + esc(item.title) + ' dari favorit" title="Hapus dari favorit">×</button>';
  var cls = 'anime-card' + (opts.continueItem ? ' continue-card' : '');
  var poster = opts.continueItem
    ? '<div class="continue-thumb">' + bgImg(item) + '<div class="progress"><div class="progress__bar" style="width:' + Math.min(100, Math.max(0, opts.continueItem.percent || 0)) + '%"></div></div></div>'
    : '<div class="anime-card__poster">' + posterImg(item) +
      '<div class="anime-card__badges">' + badgesHTML(item, false) + '</div>' +
      (score != null ? '<span class="anime-card__score">' + icon('star') + ' ' + score.toFixed(2) + '</span>' : '') +
      extra + '</div>';
  var html = '<a class="' + cls + '" href="/detail.html?id=' + encodeURIComponent(item.id) + '">' + poster +
    '<h3 class="anime-card__title">' + esc(item.title) + '</h3>' +
    '<p class="anime-card__meta">' + esc(metaLine(item)) + '</p>';
  if (opts.continueItem) {
    html += '<p class="anime-card__continue">Ep ' + esc(opts.continueItem.episode) + ' · ' + esc(opts.continueItem.percent || 0) + '% ditonton · ' + esc(timeAgo(opts.continueItem.updated_at)) + '</p>';
  }
  html += '</a>';
  return html;
}

function skeletonGridHTML(count) {
  var out = '';
  for (var i = 0; i < count; i++) {
    out += '<div><div class="skeleton skeleton-card"></div>' +
      '<div class="skeleton" style="height:12px;margin-top:8px;width:85%"></div>' +
      '<div class="skeleton" style="height:10px;margin-top:6px;width:60%"></div></div>';
  }
  return out;
}

function stateHTML(kind, title, text, btnText, btnHref) {
  var ic = kind === 'empty' ? icon('empty') : icon('info');
  if (kind === 'error') ic = icon('warn');
  var html = '<div class="state"><span class="state__icon' + (kind === 'error' ? ' state__icon--error' : '') + '">' + ic + '</span>' +
    '<p class="state__title">' + esc(title) + '</p>' +
    '<p class="state__text">' + esc(text) + '</p>';
  if (btnText && btnHref) html += '<a class="btn btn-primary" href="' + esc(btnHref) + '">' + esc(btnText) + '</a>';
  html += '</div>';
  return html;
}

/* ---------- Tanggal (zona Asia/Jakarta, Bahasa Indonesia) ---------- */
function fmtDate(epochSec) {
  if (!epochSec) return '';
  var d = new Date(epochSec * 1000);
  try {
    return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  } catch (e) {
    return d.toLocaleDateString('id-ID');
  }
}

function fmtDateTime(epochSec) {
  if (!epochSec) return '';
  var d = new Date(epochSec * 1000);
  try {
    return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
  } catch (e) {
    return d.toLocaleString('id-ID');
  }
}

function fmtRupiah(n) {
  var v = Number(n) || 0;
  return 'Rp' + v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/* ---------- Sesi pengguna (di-cache per muat halaman) ---------- */
var _meCache = null;
var _mePromise = null;

function currentUser() {
  if (_meCache) return Promise.resolve(_meCache);
  if (_mePromise) return _mePromise;
  _mePromise = apiMe().then(function (body) {
    _meCache = body;
    return body;
  }).catch(function () {
    _meCache = null;
    return null;
  });
  return _mePromise;
}
function clearMeCache() { _meCache = null; _mePromise = null; }

/* ---------- Avatar preset untuk chrome (v1.3.3) ----------
   Salinan preset yang sama dengan account.js (8 preset + default),
   dengan nama berbeda supaya tidak bertabrakan saat kedua file
   dimuat bersama di halaman akun. Dipakai avatar header + avatar
   di kaki sidebar. `u` di sini adalah objek user dari /api/me
   (body.user), bukan body-nya. */
var SIDEBAR_AVATAR_PRESETS = [
  { code: 'lime', bg: '#c7f632', fg: '#0c0f14', ring: '#84cc16' },
  { code: 'emas', bg: '#f5c542', fg: '#1a1405', ring: '#d97706' },
  { code: 'zamrud', bg: '#10b981', fg: '#06281c', ring: '#059669' },
  { code: 'merah', bg: '#ef4444', fg: '#2b0606', ring: '#dc2626' },
  { code: 'perak', bg: '#e5e7eb', fg: '#111827', ring: '#9ca3af' },
  { code: 'langit', bg: '#38bdf8', fg: '#082f49', ring: '#0284c7' },
  { code: 'ungu', bg: '#a78bfa', fg: '#1e1033', ring: '#7c3aed' },
  { code: 'jingga', bg: '#fb923c', fg: '#2b1003', ring: '#ea580c' },
];
function sidebarAvatarStyle(u) {
  if (!u || !u.avatar) return '';
  for (var i = 0; i < SIDEBAR_AVATAR_PRESETS.length; i++) {
    var p = SIDEBAR_AVATAR_PRESETS[i];
    if (p.code === u.avatar) return 'background:' + p.bg + ';color:' + p.fg + ';border-color:' + p.ring;
  }
  return '';
}

/* Kaki sidebar (v1.3.3): area PALING BAWAH drawer, terpisah dari
   menu navigasi. Ini AKUN ala Google (bukan profil web): container
   akunnya hanya berisi urusan akun — Ganti Email, Ganti Password,
   Keluar — dibuka dengan mengetuk avatar + email di kaki ini.
   Tamu: tautan Masuk/Daftar tanpa popover. */
function drawerFooterHTML(user) {
  if (!user || !user.user) {
    return '<div class="drawer__footer">' +
      '<a class="drawer__account drawer__account--guest" href="/account.html?mode=login" aria-label="Masuk atau daftar">' +
        '<span class="header-avatar header-avatar--guest">' + icon('user') + '</span>' +
        '<span class="drawer__account-text"><strong>Belum masuk</strong>' +
        '<span class="drawer__account-email">Masuk / Daftar</span></span>' +
      '</a></div>';
  }
  var u = user.user;
  var letter = esc((u.username || '?').charAt(0).toUpperCase());
  var style = sidebarAvatarStyle(u);
  var emailText = u.email ? esc(u.email) : 'Belum ada email';
  return '<div class="drawer__footer" id="drawer-footer">' +
    '<div class="drawer-account-popover" id="drawer-account-popover" hidden role="menu" aria-label="Menu akun">' +
      '<div class="drawer-account-popover__title">' + icon('gear') + '<span>Setelan Akun</span></div>' +
      '<a href="/settings.html#ganti-email" role="menuitem">' + icon('mail') + '<span>Ganti Email</span></a>' +
      '<a href="/settings.html#ganti-password" role="menuitem">' + icon('lock') + '<span>Ganti Password</span></a>' +
      '<button type="button" id="drawer-logout-btn" role="menuitem">' + icon('logout') + '<span>Keluar</span></button>' +
    '</div>' +
    '<button class="drawer__account" id="drawer-account-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="drawer-account-popover" aria-label="Menu akun ' + esc(u.username || '') + '">' +
      '<span class="header-avatar" style="' + style + '">' + letter + '</span>' +
      '<span class="drawer__account-text"><strong>' + esc(u.username || '') + '</strong>' +
      '<span class="drawer__account-email">' + emailText + '</span></span>' +
      '<span class="drawer__account-chevron" aria-hidden="true">' + icon('chevron') + '</span>' +
    '</button></div>';
}

/* ---------- Chrome: header, footer, drawer ---------- */
function chromeHTML(active, user) {
  var nav = [
    { href: '/', label: 'Beranda', icon: 'home', key: 'home' },
    { href: '/search.html', label: 'Pencarian', icon: 'search', key: 'search' },
    { href: '/genre.html', label: 'Genre', icon: 'grid', key: 'genre' },
    { href: '/az.html', label: 'A–Z', icon: 'az', key: 'az' },
    { href: '/favorites.html', label: 'Daftar Saya', icon: 'heart', key: 'favorites' },
  ];
  var top = nav.map(function (n) {
    return '<a href="' + n.href + '"' + (active === n.key ? ' class="is-active" aria-current="page"' : '') + '>' + n.label + '</a>';
  }).join('');
  var drawerLinks = nav.map(function (n) {
    return '<a href="' + n.href + '"' + (active === n.key ? ' class="is-active" aria-current="page"' : '') + '>' + icon(n.icon) + '<span>' + n.label + '</span></a>';
  }).join('');
  var premiumBtn = '';
  if (user && user.premium && user.premium.is_premium) {
    premiumBtn = '<span class="chip-status chip-status--premium">' + icon('crown') + ' PREMIUM</span>';
  } else {
    premiumBtn = '<a class="btn btn-primary btn-sm header-premium-btn" href="/premium.html">Premium</a>';
  }
  var accountBtn = user
    ? '<a class="header-avatar" href="/account.html" style="' + sidebarAvatarStyle(user.user) + '" aria-label="Akun ' + esc(user.user.username) + '">' + esc((user.user.username || '?').charAt(0).toUpperCase()) + '</a>'
    : '<a class="header-icon-btn" href="/account.html" aria-label="Masuk atau daftar">' + icon('user') + '</a>';
  return {
    header:
      '<header class="site-header"><div class="site-header__inner">' +
        '<button class="header-icon-btn hamburger" id="btn-drawer" type="button" aria-label="Buka menu" aria-expanded="false">' + icon('menu') + '</button>' +
        '<a class="site-logo" href="/" aria-label="Mitsunime — Beranda">Mitsunime</a>' +
        '<nav class="site-nav" aria-label="Navigasi utama">' + top + '</nav>' +
        '<div class="header-actions">' +
          '<button class="header-icon-btn" id="btn-header-search" type="button" aria-label="Cari anime">' + icon('search') + '</button>' +
          premiumBtn + accountBtn +
        '</div>' +
      '</div></header>' +
      '<div class="drawer-backdrop" id="drawer-backdrop" hidden></div>' +
      '<div class="drawer" id="drawer" hidden role="dialog" aria-label="Menu navigasi">' +
        '<div class="drawer__head"><span class="site-logo">Mitsunime</span>' +
        '<button class="header-icon-btn" id="btn-drawer-close" type="button" aria-label="Tutup menu">' + icon('x') + '</button></div>' +
        '<nav class="drawer__nav" aria-label="Menu sidebar">' +
        drawerLinks +
        '<a href="/premium.html">' + icon('crown') + '<span>Premium</span></a>' +
        (user ? '<a href="/account.html">' + icon('user') + '<span>Akun Saya</span></a>'
          : '<a href="/account.html?mode=login">' + icon('user') + '<span>Masuk / Daftar</span></a>') +
        '</nav>' +
        drawerFooterHTML(user) +
      '</div>',
    footer:
      '<footer class="site-footer"><div class="footer-inner">' +
        '<div class="footer-logo">Mitsunime</div>' +
        '<div class="footer-cols">' +
          '<div class="footer-col"><h4>Tentang</h4><p class="muted" style="font-size:14px;margin:0">Mitsunime, streaming anime berbahasa Indonesia.</p></div>' +
          '<div class="footer-col"><h4>Navigasi</h4><a href="/">Beranda</a><a href="/search.html">Pencarian</a><a href="/genre.html">Genre</a><a href="/az.html">Daftar A–Z</a><a href="/favorites.html">Daftar Saya</a></div>' +
          '<div class="footer-col"><h4>Akun</h4><a href="/account.html">Akun Saya</a><a href="/premium.html">Paket Premium</a></div>' +
          '<div class="footer-col"><h4>Bantuan</h4><a href="/premium.html">Cara Berlangganan</a><a href="/account.html">Kelola Akun</a></div>' +
        '</div>' +
        '<div class="footer-bottom"><span>© 2026 Mitsunime. Situs ini untuk pemakaian pribadi.</span>' +
        '<span class="footer-status" id="footer-server-status"><span class="dot"></span><span id="footer-server-text">Memeriksa server…</span></span></div>' +
      '</div></footer>',
  };
}

/* Pasang chrome (header + drawer + footer) dari objek hasil
   chromeHTML(). Muat pertama memakai slot penampung di HTML;
   pemasangan ULANG (F-01: status masuk berubah tanpa reload)
   mengganti elemen header/drawer/footer yang sudah ada di DOM —
   slot-nya sudah hilang sejak pemasangan pertama. Elemen lama
   ditangkap SEBELUM yang baru disisipkan supaya tidak ada ID
   ganda yang tertinggal. */
function applyChrome(c) {
  var headerSlot = document.getElementById('site-header-slot');
  if (headerSlot) {
    headerSlot.outerHTML = c.header;
  } else {
    var oldHeader = document.querySelector('header.site-header');
    var oldBackdrop = document.getElementById('drawer-backdrop');
    var oldDrawer = document.getElementById('drawer');
    if (oldHeader && oldHeader.parentNode) {
      var tmp = document.createElement('div');
      tmp.innerHTML = c.header;
      var parent = oldHeader.parentNode;
      while (tmp.firstChild) parent.insertBefore(tmp.firstChild, oldHeader);
    }
    if (oldHeader) oldHeader.remove();
    if (oldBackdrop) oldBackdrop.remove();
    if (oldDrawer) oldDrawer.remove();
  }
  var footerSlot = document.getElementById('site-footer-slot');
  if (footerSlot) {
    footerSlot.outerHTML = c.footer;
  } else {
    var oldFooter = document.querySelector('footer.site-footer');
    if (oldFooter) oldFooter.outerHTML = c.footer;
  }
  initChromeInteractions();
  refreshServerStatus();
}

function mountChrome(active) {
  return currentUser().then(function (user) {
    applyChrome(chromeHTML(active, user));
    return user;
  });
}

/* F-01: gambar ulang chrome dari status sesi TERBARU tanpa reload
   halaman — dipanggil sesudah status autentikasi berubah (masuk /
   verifikasi berhasil / keluar) supaya drawer tidak basi dalam
   keadaan tamu. `user` adalah badan /api/me (atau null = tamu). */
function refreshChrome(active, user) {
  applyChrome(chromeHTML(active, user || null));
}

/* Keluar dari sidebar (v1.3.3): location.replace — halaman profil
   TIDAK masuk riwayat sesi, jadi tombol Back tidak bisa kembali
   menampilkan profil setelah keluar. */
async function handleSidebarLogout(btn) {
  if (btn) btn.disabled = true;
  try { await apiLogout(); } catch (err) { /* abaikan: sesi lokal ikut dibersihkan */ }
  clearMeCache();
  window.location.replace('/account.html?mode=login');
}

/* Tutup popover akun sidebar — elemen dicari SAAT kejadian, bukan
   ditangkap dari render tertentu, supaya tetap benar sesudah
   chrome digambar ulang (F-01). */
function chromeClosePopover() {
  var popover = document.getElementById('drawer-account-popover');
  var accountBtn = document.getElementById('drawer-account-btn');
  if (!popover || popover.hidden) return;
  popover.hidden = true;
  if (accountBtn) accountBtn.setAttribute('aria-expanded', 'false');
}

/* Listener tingkat dokumen untuk chrome dipasang SEKALI saja
   (F-01): initChromeInteractions berjalan setiap chrome digambar
   ulang, dan listener dokumen yang menumpuk akan menutup popover
   berlapis-lapis. Handler-nya mencari elemen yang hidup saat
   kejadian terjadi. */
var _chromeDocBound = false;
function bindChromeDocumentListeners() {
  if (_chromeDocBound) return;
  _chromeDocBound = true;
  document.addEventListener('click', function (e) {
    var popover = document.getElementById('drawer-account-popover');
    if (!popover || popover.hidden) return;
    var footer = document.getElementById('drawer-footer');
    if (footer && footer.contains(e.target)) return;
    chromeClosePopover();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var popover = document.getElementById('drawer-account-popover');
    if (!popover || popover.hidden) return;
    chromeClosePopover();
    var accountBtn = document.getElementById('drawer-account-btn');
    if (accountBtn) accountBtn.focus();
  });
}

function initChromeInteractions() {
  var btnOpen = document.getElementById('btn-drawer');
  var btnClose = document.getElementById('btn-drawer-close');
  var drawer = document.getElementById('drawer');
  var backdrop = document.getElementById('drawer-backdrop');
  var accountBtn = document.getElementById('drawer-account-btn');
  var popover = document.getElementById('drawer-account-popover');
  function openPopover() {
    if (!popover) return;
    popover.hidden = false;
    if (accountBtn) accountBtn.setAttribute('aria-expanded', 'true');
  }
  function openDrawer() {
    if (!drawer) return;
    drawer.hidden = false;
    if (backdrop) backdrop.hidden = false;
    if (btnOpen) btnOpen.setAttribute('aria-expanded', 'true');
  }
  function closeDrawer() {
    if (!drawer) return;
    chromeClosePopover();
    drawer.hidden = true;
    if (backdrop) backdrop.hidden = true;
    if (btnOpen) btnOpen.setAttribute('aria-expanded', 'false');
  }
  if (btnOpen) btnOpen.addEventListener('click', openDrawer);
  if (btnClose) btnClose.addEventListener('click', closeDrawer);
  if (backdrop) backdrop.addEventListener('click', closeDrawer);
  if (drawer) drawer.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', closeDrawer); });
  /* Popover akun sidebar: ketuk avatar/email membuka-menutupnya. */
  if (accountBtn && popover) {
    accountBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (popover.hidden) openPopover(); else chromeClosePopover();
    });
    popover.addEventListener('click', function (e) { e.stopPropagation(); });
    bindChromeDocumentListeners();
  }
  var logoutBtn = document.getElementById('drawer-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () { handleSidebarLogout(logoutBtn); });
  }
  var btnSearch = document.getElementById('btn-header-search');
  if (btnSearch) btnSearch.addEventListener('click', function () { window.location.href = '/search.html'; });
}

function refreshServerStatus() {
  var el = document.getElementById('footer-server-status');
  var txt = document.getElementById('footer-server-text');
  if (!el || !txt) return;
  getHealth().then(function (h) {
    if (h && h.ok !== false && h.status !== 'down') {
      el.classList.remove('is-down');
      txt.textContent = 'Server aktif';
    } else {
      el.classList.add('is-down');
      txt.textContent = 'Server tidak terjangkau';
    }
  });
}

/* ---------- Banner, toast, modal ---------- */
function showBanner(kind, message, withReload) {
  var slot = document.getElementById('page-banner');
  if (!slot) return;
  var cls = kind === 'error' ? 'banner banner--error' : 'banner banner--warning';
  slot.innerHTML = '<div class="' + cls + '" role="alert">' + icon('warn') + '<span>' + esc(message) + '</span>' +
    (withReload ? '<button class="btn btn-sm btn-ghost" type="button" onclick="window.location.reload()">Muat Ulang</button>' : '') +
    '</div>';
  slot.hidden = false;
}

var _toastTimer = null;
function showToast(message, kind) {
  var old = document.querySelector('.toast');
  if (old) old.remove();
  if (_toastTimer) clearTimeout(_toastTimer);
  var el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' toast--error' : kind === 'wait' ? ' toast--wait' : ' toast--ok');
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  _toastTimer = setTimeout(function () { el.remove(); }, 4000);
}

function openModal(html) {
  closeModal();
  var back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.id = 'modal-backdrop';
  back.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + html + '</div>';
  back.addEventListener('click', function (e) { if (e.target === back) closeModal(); });
  document.body.appendChild(back);
  var closeBtn = back.querySelector('.modal__close');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  return back;
}
function closeModal() {
  var back = document.getElementById('modal-backdrop');
  if (back) back.remove();
}
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeModal();
});

/* ---------- Toggle lihat/sembunyikan password (v1.3.1) ----------
   Tombol mata (.pw-toggle) duduk di dalam .pw-wrap bersama input
   password-nya. Markup tombol ditulis di HTML; helper ini hanya
   mengikat kliknya: ganti type password <-> text, tukar ikon mata,
   perbarui aria-label/aria-pressed, kembalikan fokus ke input. */
function bindPasswordToggle(btn) {
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', function () {
    var wrap = btn.closest('.pw-wrap');
    var input = wrap ? wrap.querySelector('input') : null;
    if (!input) return;
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.innerHTML = show ? icon('eyeOff') : icon('eye');
    btn.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Lihat password');
    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
    input.focus();
  });
}
function initPasswordToggles(scope) {
  (scope || document).querySelectorAll('.pw-toggle').forEach(bindPasswordToggle);
}
document.addEventListener('DOMContentLoaded', function () { initPasswordToggles(document); });
