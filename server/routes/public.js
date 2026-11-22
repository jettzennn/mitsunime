'use strict';
// Rute /api/* katalog publik — dilayani dari database lokal (PRD task-05).
// Semua respons sukses: { ok: true, stale: <bool>, data, pagination?, total?, ... }
// `stale` = data yang disajikan memang sudah lama (lebih tua dari
// STALE_BANNER_AGE_SECONDS, default 12 jam — lihat services/cache.js
// isDataOld). `stale` BUKAN pertanda satu kegagalan refresh sesaat:
// bila cache masih segar, stale=false walau Anikoto barusan gagal.
// Pola cache-first: layani cache bila masih segar; bila basi, coba Anikoto;
// bila Anikoto gagal tapi cache lama ada → sajikan cache + stale sesuai umur.
// Bila katalog belum tersinkron sama sekali → pesan jujur, bukan error 500.
const config = require('../config');
const logger = require('../utils/logger');
const mw = require('../middleware/auth');
const anikoto = require('../services/anikoto');
const cache = require('../services/cache');
const derive = require('../services/derive');
const translate = require('../services/translate');
const servers = require('../services/servers');

function parsePage(url) {
  const q = url.searchParams;
  const page = Math.max(1, Number.parseInt(q.get('page'), 10) || 1);
  const perPage = Math.min(
    config.MAX_PER_PAGE,
    Math.max(1, Number.parseInt(q.get('per_page'), 10) || config.DEFAULT_PER_PAGE));
  return { page, perPage };
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
  return true; // penanda untuk router: rute sudah ditangani
}

function err(res, status, message) {
  return send(res, status, { ok: false, message });
}

function paginationOf(page, perPage, total) {
  return { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) };
}

function emptyCatalogMessage() {
  return 'Katalog belum tersinkron. Jalankan sync terlebih dahulu (npm run sync:full).';
}

function listHandler(fn) {
  return (req, res, url) => {
    const { page, perPage } = parsePage(url);
    const result = fn(page, perPage);
    return send(res, 200, {
      // M4: stale = umur cache; anikoto_down = status Anikoto terakhir
      // benar-benar gagal. Keduanya dikirim terpisah supaya UI tidak
      // lagi menyalahkan Anikoto hanya karena cache sudah tua.
      ok: true, stale: cache.isDataOld(cache.freshestFetchedAt()), anikoto_down: cache.anikotoDown(),
      data: result.items, pagination: result.pagination, total: result.total,
    });
  };
}

// Dekode HTML entity dari payload Anikoto saat MENYAJIKAN /api/series.
// Bukti dari proyek lama: series_cache menyimpan judul episode mentah
// ("President&#39;s Daughter Kidnapping Case", Case Closed Ep 2) — payload
// Anikoto sendiri sudah berisi entity, disimpan verbatim. Decode
// idempotent, dan cache di disk tetap mentah (decode diulang tiap sajian).
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#34': '"',
  nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”',
};
function decodeEntities(value) {
  const s = String(value == null ? '' : value);
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body) => {
    if (body.charAt(0) === '#') {
      const code = (body.charAt(1) === 'x' || body.charAt(1) === 'X')
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : m;
  });
}
function normalizeSeriesData(data) {
  if (!data || typeof data !== 'object') return data;
  const a = data.anime;
  if (a && typeof a === 'object') {
    for (const k of ['title', 'alternative', 'description', 'titles']) {
      if (typeof a[k] === 'string') a[k] = decodeEntities(a[k]);
    }
    // Flag admin Mitsunime pada data anime di dalam detail series.
    const flags = cache.getAnimeFlags(a.id);
    if (flags) { a.sub_indo = flags.sub_indo; }
    // M2: mal_id/ani_id TIDAK PERNAH keluar ke payload publik — keduanya
    // adalah bahan pembangun URL fallback MegaPlay (lihat handleStream).
    delete a.mal_id;
    delete a.ani_id;
  }
  if (Array.isArray(data.episodes)) {
    for (const ep of data.episodes) {
      if (ep && typeof ep === 'object') {
        if (typeof ep.title === 'string') ep.title = decodeEntities(ep.title);
        if (typeof ep.jp_title === 'string') ep.jp_title = decodeEntities(ep.jp_title);
        // URL embed TIDAK PERNAH disertakan di payload publik: menonton
        // wajib login (keputusan pengguna), jadi embed_url hanya diberikan
        // lewat endpoint stream yang butuh sesi (di bawah). Ini mencegah
        // tamu mengambil URL embed dari JSON detail.
        delete ep.embed_url;
        delete ep.episode_embed_id;
      }
    }
  }
  return data;
}

// GET /api/recent?page=&per_page= — Episode Terbaru dari cache.
function handleRecent(req, res, url) {
  if (cache.countAnime() === 0) {
    return send(res, 200, {
      ok: true, stale: cache.isDataOld(cache.freshestFetchedAt()), anikoto_down: cache.anikotoDown(), data: [], pagination: paginationOf(1, 20, 0), total: 0,
      message: emptyCatalogMessage(),
    });
  }
  const { page, perPage } = parsePage(url);
  const list = cache.listRecent(page, perPage);
  return send(res, 200, {
    ok: true, stale: cache.isDataOld(cache.freshestFetchedAt()), anikoto_down: cache.anikotoDown(), data: list.items,
    pagination: paginationOf(page, perPage, list.total), total: list.total,
  });
}

// Terjemahan sinopsis on-demand (v1.2.0): ganti description Inggris
// dengan hasil terjemahan Indonesia bila tersedia (dari cache DB atau
// baru diterjemahkan). Selalu fail soft — bila terjemah gagal, teks
// Inggris tetap tampil dan description_lang = 'en'. Frontend lama
// tidak perlu berubah: ia membaca a.description seperti biasa.
async function withTranslation(data) {
  if (!data || !data.anime || typeof data.anime.description !== 'string'
    || !data.anime.description.trim()) return data;
  const t = await translate.getTranslatedSynopsis(data.anime.id, data.anime.description);
  data.anime.description = t.text;
  data.anime.description_lang = t.translated ? 'id' : 'en';
  return data;
}

// GET /api/series/:id — detail + episode. Cache dulu, sinkron bila kadaluarsa.
async function handleSeries(req, res, idRaw) {
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return err(res, 404, 'Anime tidak ditemukan. Periksa kembali tautan yang Anda buka.');
  }
  const cached = cache.getSeries(id);
  const fresh = cached && (cache.nowSec() - cached.fetchedAt) <= config.SERIES_TTL_SECONDS;
  if (fresh) {
    return send(res, 200, { ok: true, stale: false, anikoto_down: cache.anikotoDown(), data: await withTranslation(normalizeSeriesData(cached.data)) });
  }
  // M3: cache-miss memicu panggilan ke Anikoto — batasi 30/IP/menit agar
  // satu penyerang tidak membanjiri kuota Anikoto (60 req/120 dtk).
  // Bila batas tercapai: sajikan cache basi bila ada, kalau tidak ada → 429.
  if (mw.rateLimited(`series-miss:${mw.clientIp(req)}`, 30, 60 * 1000)) {
    if (cached) {
      logger.warn(`series/${id}: batas cache-miss tercapai, sajikan cache basi`);
      return send(res, 200, {
        ok: true, stale: cache.isDataOld(cached.fetchedAt), anikoto_down: cache.anikotoDown(), data: await withTranslation(normalizeSeriesData(cached.data)),
        message: 'Terlalu banyak permintaan. Menampilkan data terakhir yang tersimpan.',
      });
    }
    return err(res, 429, 'Terlalu banyak permintaan. Coba lagi sebentar lagi.');
  }
  try {
    const body = await anikoto.getSeries(id);
    const data = body.data || null;
    if (!data || !data.anime) throw new anikoto.AnikotoError(404, 'Anime tidak ditemukan di Anikoto.');
    cache.putSeries(id, data);
    if (data.anime) cache.upsertAnimeSafe(data.anime);
    cache.recordAnikotoStatus(true, 200, null);
    return send(res, 200, { ok: true, stale: false, anikoto_down: cache.anikotoDown(), data: await withTranslation(normalizeSeriesData(data)) });
  } catch (e) {
    if (e.status === 404) {
      return err(res, 404, 'Anime tidak ditemukan. ID ini tidak ada di katalog Anikoto.');
    }
    cache.recordAnikotoStatus(false, e.status || 0, e.message);
    if (cached) {
      // F-02: klaim "mungkin tidak terbaru" hanya bila data cache memang
      // sudah lama (isDataOld); bila cache masih segar, pesannya netral
      // (tanpa klaim basi) supaya tidak bertentangan dengan stale:false.
      const old = cache.isDataOld(cached.fetchedAt);
      logger.warn(`series/${id}: Anikoto gagal (${e.message}), sajikan cache basi`);
      return send(res, 200, {
        ok: true, stale: old, anikoto_down: cache.anikotoDown(), data: await withTranslation(normalizeSeriesData(cached.data)),
        message: old
          ? 'Data mungkin tidak terbaru — Anikoto sedang tidak dapat dijangkau.'
          : 'Anikoto sedang tidak dapat dijangkau. Menampilkan data terakhir yang tersimpan.',
      });
    }
    return err(res, 502, 'Anikoto sedang tidak dapat dijangkau. Coba lagi sebentar lagi.');
  }
}

// GET /api/search?q=&genre=&status=&year= — pencarian FTS5 dari database lokal.
// q boleh kosong bila filter lain diisi (dipakai halaman genre/A–Z).
function handleSearch(req, res, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const genre = (url.searchParams.get('genre') || '').trim();
  const status = (url.searchParams.get('status') || '').trim();
  const yearRaw = (url.searchParams.get('year') || '').trim();
  if (q.length > 100) {
    return err(res, 400, 'Kata kunci pencarian terlalu panjang (maksimal 100 karakter).');
  }
  if (genre.length > 50) {
    return err(res, 400, 'Nama genre terlalu panjang.');
  }
  if (status.length > 50) {
    return err(res, 400, 'Nilai status terlalu panjang.');
  }
  let year = null;
  if (yearRaw) {
    year = Number.parseInt(yearRaw, 10);
    if (!Number.isFinite(year) || year < 1900 || year > 2100) {
      return err(res, 400, 'Parameter tahun harus berupa tahun 1900–2100.');
    }
  }
  if (!q && !genre && !status && !year) {
    return err(res, 400, 'Masukkan kata kunci pencarian atau pilih filter terlebih dahulu.');
  }
  const { page, perPage } = parsePage(url);
  const result = derive.search(q, { page, perPage, genre, status, year });
  const body = {
    ok: true,
    stale: cache.isDataOld(cache.freshestFetchedAt()),
    anikoto_down: cache.anikotoDown(),
    data: result.items,
    pagination: result.pagination,
    total: result.total,
    indexed_total: cache.countAnime(),
  };
  if (cache.countAnime() === 0) {
    body.message = emptyCatalogMessage();
  } else if (result.total === 0) {
    body.message = q
      ? `Tidak ditemukan untuk "${q}". Coba kata kunci lain.`
      : 'Tidak ada judul yang cocok dengan filter itu.';
  }
  return send(res, 200, body);
}

// GET /api/genre/:name — judul per genre.
function handleGenre(req, res, url, nameRaw) {
  const name = decodeURIComponent(nameRaw || '').trim();
  if (!name || name.length > 50) return err(res, 400, 'Nama genre tidak boleh kosong.');
  const { page, perPage } = parsePage(url);
  const result = derive.byGenre(name, page, perPage);
  return send(res, 200, {
    ok: true, stale: cache.isDataOld(cache.freshestFetchedAt()), anikoto_down: cache.anikotoDown(), data: result.items,
    pagination: result.pagination, total: result.total,
    message: result.total === 0 ? `Belum ada anime bergenre "${name}" di katalog.` : undefined,
  });
}

// GET /api/genres — daftar genre + jumlah judul.
function handleGenres(req, res) {
  const genres = derive.allGenres();
  return send(res, 200, { ok: true, stale: cache.isDataOld(cache.freshestFetchedAt()), anikoto_down: cache.anikotoDown(), data: genres, total: genres.length });
}

// GET /api/az?huruf=A — daftar A–Z.
function handleAZ(req, res, url) {
  let huruf = (url.searchParams.get('huruf') || '').trim().toUpperCase();
  if (huruf && huruf !== '#' && !/^[A-Z]$/.test(huruf)) {
    return err(res, 400, 'Parameter huruf harus satu huruf A–Z atau "#".');
  }
  const { page, perPage } = parsePage(url);
  const result = derive.az(huruf || '', page, perPage);
  return send(res, 200, {
    ok: true, stale: cache.isDataOld(cache.freshestFetchedAt()), anikoto_down: cache.anikotoDown(), data: result.items,
    pagination: result.pagination, total: result.total,
  });
}

// GET /api/series/:id/episodes/:ep/stream — URL embed MegaPlay untuk satu
// episode. v1.4.5: TAMU BOLEH menonton (keputusan pengguna berubah —
// "WAJIB LOGIN" dicabut); riwayat/progres/complete tetap wajib login.
// TIDAK ADA konten terkunci di sini: semua episode bisa ditonton siapa
// saja yang sudah login.
async function handleStream(req, res, url, idRaw, epRaw) {
  const id = Number.parseInt(idRaw, 10);
  const epNum = Number.parseInt(epRaw, 10);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(epNum) || epNum <= 0) {
    return err(res, 404, 'Episode tidak ditemukan.');
  }
  const cached = cache.getSeries(id);
  let data = cached ? cached.data : null;
  const fresh = cached && (cache.nowSec() - cached.fetchedAt) <= config.SERIES_TTL_SECONDS;
  if (!fresh) {
    // M3: cache-miss memicu panggilan ke Anikoto — batasi 30/menit
    // (per pengguna bila login, per IP bila tamu). Bila batas tercapai:
    // pakai cache basi bila ada, kalau tidak ada → 429 (jangan antre
    // tanpa batas ke Anikoto).
    // v1.4.5: kunci batas tahan tamu — req.user null bila tidak login,
    // jangan baca req.user.id saat tamu (crash).
    const missKey = req.user
      ? `stream-miss:user:${req.user.id}`
      : `stream-miss:guest:${mw.clientIp(req)}`;
    const limited = mw.rateLimited(missKey, 30, 60 * 1000);
    if (limited) {
      if (!data) return err(res, 429, 'Terlalu banyak permintaan. Coba lagi sebentar lagi.');
      logger.warn(`stream/${id}: batas cache-miss tercapai, pakai cache basi`);
    } else {
      try {
        const body = await anikoto.getSeries(id);
        data = body.data || null;
        if (!data || !data.anime) throw new anikoto.AnikotoError(404, 'Anime tidak ditemukan di Anikoto.');
        cache.putSeries(id, data);
        if (data.anime) cache.upsertAnimeSafe(data.anime);
        cache.recordAnikotoStatus(true, 200, null);
      } catch (e) {
        if (e.status === 404) {
          return err(res, 404, 'Anime tidak ditemukan. ID ini tidak ada di katalog Anikoto.');
        }
        cache.recordAnikotoStatus(false, e.status || 0, e.message);
        if (!data) return err(res, 502, 'Anikoto sedang tidak dapat dijangkau. Coba lagi sebentar lagi.');
      }
    }
  }
  const episodes = Array.isArray(data.episodes) ? data.episodes : [];
  const ep = episodes.find((x) => x && Number.parseInt(x.number, 10) === epNum);
  if (!ep) return err(res, 404, `Episode ${epNum} tidak ada untuk judul ini.`);
  const embed = ep.embed_url || {};
  if (!embed.sub && !embed.dub) {
    return err(res, 404, 'Episode ini belum punya tautan pemutar.');
  }
  // M2: URL server cadangan (mal/ani) dibangun DI SINI, dari data Anikoto
  // mentah di server — frontend tidak pernah lagi membangunnya sendiri
  // dari mal_id/ani_id (keduanya sudah dihapus dari payload publik).
  const fallbackUrls = { sub: [], dub: [] };
  const aRaw = (data.anime && typeof data.anime === 'object') ? data.anime : {};
  for (const key of ['mal', 'ani']) {
    const extId = key === 'mal' ? aRaw.mal_id : aRaw.ani_id;
    if (extId == null || extId === '') continue;
    for (const lg of ['sub', 'dub']) {
      fallbackUrls[lg].push({
        server: key,
        url: `https://megaplay.buzz/stream/${key}/${encodeURIComponent(extId)}/${epNum}/${lg}`,
      });
    }
  }
  // v1.5.0 (PRD §5.6, §9.2): daftar server pemilih — satu sumber
  // kebenaran (servers.js); `fallback_urls` TETAP ada (kompatibilitas).
  // `lang` dari query (?lang=dub) menentukan URL tiap server; default sub.
  const lang = url.searchParams.get('lang') === 'dub' ? 'dub' : 'sub';
  return send(res, 200, {
    ok: true,
    data: {
      anime_id: id,
      episode: epNum,
      title: typeof ep.title === 'string' ? decodeEntities(ep.title) : null,
      embed_url: { sub: embed.sub || null, dub: embed.dub || null },
      fallback_urls: fallbackUrls,
      servers: servers.buildServers(aRaw, ep, lang),
    },
  });
}

// Router /api/* publik — dipanggil server.js. Mengembalikan true bila dikenali.
async function route(req, res, url) {
  const path = url.pathname;
  if (path === '/api/recent') return handleRecent(req, res, url);
  if (path === '/api/search') return handleSearch(req, res, url);
  if (path === '/api/top') return listHandler((p, pp) => derive.trending(p, pp))(req, res, url);
  if (path === '/api/airing') return listHandler((p, pp) => derive.airing(p, pp))(req, res, url);
  if (path === '/api/genres') return handleGenres(req, res);
  if (path === '/api/az') return handleAZ(req, res, url);
  const streamMatch = path.match(/^\/api\/series\/([^/]+)\/episodes\/([^/]+)\/stream$/);
  if (streamMatch) return handleStream(req, res, url, streamMatch[1], streamMatch[2]);
  const seriesMatch = path.match(/^\/api\/series\/([^/]+)$/);
  if (seriesMatch) return handleSeries(req, res, seriesMatch[1]);
  const genreMatch = path.match(/^\/api\/genre\/(.+)$/);
  if (genreMatch) return handleGenre(req, res, url, genreMatch[1]);
  return false;
}

module.exports = { route, send, err };
