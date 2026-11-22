'use strict';
// Derivasi dari cache — Anikoto TIDAK punya endpoint trending/genre/
// jadwal, jadi semua ini dihitung dari anime_cache.
// Dipakai ulang dari proyek NontonAnime v1.1.3; yang berubah untuk Mitsunime:
// - semua hasil membawa flag admin sub_indo (badge di UI);
// - search() menerima filter genre, status, dan tahun (PRD task-05).
// Label UI jujur: "trending" = urutan skor tertinggi ("Rating Tertinggi").
// Semua query memakai parameter binding — tidak ada string SQL dari input
// pengguna (pencegahan injeksi, OWASP).
const dbModule = require('../db/database');
const cache = require('./cache');

const rowsToAnime = (rows) => rows.map(cache.rowToAnime).filter(Boolean);

function pageOf(total, page, perPage) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  return { page, per_page: perPage, total, total_pages: totalPages };
}

const COLS = 'payload, sub_indo';
const COLS_A = 'a.payload, a.sub_indo';

// Rating Tertinggi: skor menurun (judul tanpa skor di belakang).
function trending(page = 1, perPage = 20) {
  const db = dbModule.get();
  const offset = (page - 1) * perPage;
  const rows = db.prepare(
    `SELECT ${COLS} FROM anime_cache
     ORDER BY (score IS NULL) ASC, score DESC, updated_at DESC
     LIMIT ? OFFSET ?`).all(perPage, offset);
  const total = db.prepare('SELECT COUNT(*) AS c FROM anime_cache WHERE score IS NOT NULL').get().c;
  return { items: rowsToAnime(rows), pagination: pageOf(total, page, perPage), total };
}

// Sedang Tayang: status Currently Airing, update terbaru dulu.
function airing(page = 1, perPage = 20) {
  const db = dbModule.get();
  const offset = (page - 1) * perPage;
  const rows = db.prepare(
    `SELECT ${COLS} FROM anime_cache WHERE status = 'Currently Airing'
     ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(perPage, offset);
  const total = db.prepare("SELECT COUNT(*) AS c FROM anime_cache WHERE status = 'Currently Airing'").get().c;
  return { items: rowsToAnime(rows), pagination: pageOf(total, page, perPage), total };
}

// Per genre: kolom genres menyimpan JSON array, dicocokkan persis
// dengan pola '"Nama"' agar "Action" tidak kena "Live Action".
function genrePattern(name) {
  return `%\"${String(name).replace(/"/g, '')}\"%`;
}

function byGenre(name, page = 1, perPage = 20) {
  const db = dbModule.get();
  const offset = (page - 1) * perPage;
  const pattern = genrePattern(name);
  const rows = db.prepare(
    `SELECT ${COLS} FROM anime_cache WHERE genres LIKE ? ESCAPE '\\'
     ORDER BY (score IS NULL) ASC, score DESC LIMIT ? OFFSET ?`)
    .all(pattern, perPage, offset);
  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM anime_cache WHERE genres LIKE ? ESCAPE '\\'`).get(pattern).c;
  return { items: rowsToAnime(rows), pagination: pageOf(total, page, perPage), total };
}

// Daftar semua genre yang ada di cache + jumlah judul per genre.
function allGenres() {
  const rows = dbModule.get().prepare('SELECT genres FROM anime_cache').all();
  const map = new Map();
  for (const r of rows) {
    try {
      for (const g of JSON.parse(r.genres || '[]')) {
        map.set(g, (map.get(g) || 0) + 1);
      }
    } catch { /* abaikan baris rusak */ }
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// Daftar A–Z: huruf A–Z, atau '#' untuk judul berawalan angka/simbol.
function az(letter, page = 1, perPage = 20) {
  const db = dbModule.get();
  const offset = (page - 1) * perPage;
  let where, params;
  if (letter === '#') {
    where = "upper(substr(title, 1, 1)) NOT BETWEEN 'A' AND 'Z'";
    params = [];
  } else if (letter) {
    where = 'upper(substr(title, 1, 1)) = ?';
    params = [letter.toUpperCase()];
  } else {
    where = '1 = 1';
    params = [];
  }
  const rows = db.prepare(
    `SELECT ${COLS} FROM anime_cache WHERE ${where} ORDER BY title COLLATE NOCASE ASC LIMIT ? OFFSET ?`)
    .all(...params, perPage, offset);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM anime_cache WHERE ${where}`).get(...params).c;
  return { items: rowsToAnime(rows), pagination: pageOf(total, page, perPage), total };
}

// Jadwal Tayang: next_air_schedule_time di masa depan, paling dekat dulu.
// Tiap item membawa next_air_schedule_time (epoch detik) + next_air_ep.
function schedule(limit = 50) {
  const now = cache.nowSec();
  const rows = dbModule.get().prepare(
    `SELECT ${COLS} FROM anime_cache
     WHERE next_air_schedule_time IS NOT NULL AND next_air_schedule_time > ?
     ORDER BY next_air_schedule_time ASC LIMIT ?`).all(now, limit);
  return rowsToAnime(rows);
}

// Segera Tayang: status belum tayang ATAU jadwal berikutnya di masa depan.
function upcoming(limit = 20) {
  const now = cache.nowSec();
  const rows = dbModule.get().prepare(
    `SELECT ${COLS} FROM anime_cache
     WHERE (status = 'Not yet aired' OR next_air_schedule_time > ?)
     ORDER BY next_air_schedule_time ASC, updated_at DESC LIMIT ?`).all(now, limit);
  return rowsToAnime(rows);
}

// Item 11 (v1.5.2, PRD addendum §26): urutan hasil pencarian — TV dulu,
// lalu tanggal rilis menaik. Satu fragmen ORDER BY bersama untuk jalur FTS
// dan fallback LIKE (satu sumber, dua pemakaian — dilarang menduplikasi
// string SQL). Tanpa kolom baru / migrasi: tipe dari
// payload.terms_by_type.type[0], tanggal mulai dari payload.aired
// ("Mon D, YYYY", bagian sebelum " to "), fallback kolom year.
// Fragmen ini konstanta kode — tidak ada potongan SQL dari input pengguna.

// Bagian awal aired (sebelum " to "), atau seluruh nilai bila tanpa rentang.
const AIRED_START =
  `CASE WHEN instr(json_extract(a.payload, '$.aired'), ' to ') > 0 ` +
  `THEN substr(json_extract(a.payload, '$.aired'), 1, instr(json_extract(a.payload, '$.aired'), ' to ') - 1) ` +
  `ELSE json_extract(a.payload, '$.aired') END`;

// Kunci tanggal "YYYY-MM-DD": parse "Mon D, YYYY" (hari boleh bernol/tidak);
// bila tidak terparse ("?", "Not available", kosong, format lain) fallback
// ke kolom year ("YYYY-00-00", urut di awal tahunnya); bila year juga
// kosong, "9999-99-99" (paling akhir di kelompok tipenya).
const SEARCH_DATE_KEY =
  `CASE WHEN length(${AIRED_START}) IN (11, 12) ` +
  `AND substr(${AIRED_START}, 4, 1) = ' ' ` +
  `AND substr(${AIRED_START}, -6, 1) = ',' ` +
  `AND substr(${AIRED_START}, 1, 3) IN ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec') ` +
  `THEN substr(${AIRED_START}, -4) || '-' || ` +
  `CASE substr(${AIRED_START}, 1, 3) ` +
  `WHEN 'Jan' THEN '01' WHEN 'Feb' THEN '02' WHEN 'Mar' THEN '03' WHEN 'Apr' THEN '04' ` +
  `WHEN 'May' THEN '05' WHEN 'Jun' THEN '06' WHEN 'Jul' THEN '07' WHEN 'Aug' THEN '08' ` +
  `WHEN 'Sep' THEN '09' WHEN 'Oct' THEN '10' WHEN 'Nov' THEN '11' WHEN 'Dec' THEN '12' END ` +
  `|| '-' || printf('%02d', CAST(substr(substr(${AIRED_START}, 5), 1, instr(substr(${AIRED_START}, 5), ',') - 1) AS INTEGER)) ` +
  `WHEN a.year IS NOT NULL THEN printf('%04d-00-00', a.year) ` +
  `ELSE '9999-99-99' END`;

// Peringkat tipe: TV/TV_SHORT 0, ONA 1, OVA 2, Movie 3, Special/TV Special 4,
// lainnya/NULL 5.
const SEARCH_TYPE_RANK =
  `CASE json_extract(a.payload, '$.terms_by_type.type[0]') ` +
  `WHEN 'TV' THEN 0 WHEN 'TV_SHORT' THEN 0 ` +
  `WHEN 'ONA' THEN 1 WHEN 'OVA' THEN 2 WHEN 'Movie' THEN 3 ` +
  `WHEN 'Special' THEN 4 WHEN 'TV Special' THEN 4 ` +
  `ELSE 5 END`;

// Tie-break deterministik sesudah peringkat tipe + kunci tanggal (supaya
// pagination stabil): judul ASC lalu id ASC. Jalur FTS menyisipkan `rank`
// FTS di depan tie-break ini (§26.3.3) — peringkat tipe + tanggal tetap
// mendominasi rank, sesuai urutan mengikat §26.3 (tipe → tanggal → rank).
const SEARCH_TIEBREAK = `a.title COLLATE NOCASE ASC, a.id ASC`;

// Fragmen ORDER BY bersama (peringkat tipe + kunci tanggal + tie-break).
// Dipakai utuh di jalur LIKE; jalur FTS menyusun ulang dari konstanta
// yang sama dengan `rank` di antara kunci tanggal dan tie-break.
const SEARCH_ORDER = `${SEARCH_TYPE_RANK}, ${SEARCH_DATE_KEY}, ${SEARCH_TIEBREAK}`;

// Pencarian judul: FTS5 atas title + alternative + titles, plus filter
// genre/status/tahun bila diberikan. Query dibersihkan dari karakter
// sintaks FTS; bila FTS gagal/kosong, fallback ke LIKE agar pencarian
// tetap jalan. Filter selalu diterapkan, baik di jalur FTS maupun LIKE.
function search(query, opts = {}) {
  const db = dbModule.get();
  const q = String(query || '').trim();
  const page = opts.page || 1;
  const perPage = opts.perPage || 20;
  const offset = (page - 1) * perPage;

  // Susun kondisi filter dari parameter yang tervalidasi di route.
  const conds = [];
  const condParams = [];
  if (opts.genre) {
    conds.push("a.genres LIKE ? ESCAPE '\\'");
    condParams.push(genrePattern(opts.genre));
  }
  if (opts.status) {
    conds.push('a.status = ?');
    condParams.push(opts.status);
  }
  if (opts.year) {
    conds.push('a.year = ?');
    condParams.push(opts.year);
  }
  const extraWhere = conds.length ? ` AND ${conds.join(' AND ')}` : '';

  if (!q) {
    // Tanpa kata kunci: daftar terfilter saja (dipakai halaman genre/A–Z
    // lewat endpoint search yang sama).
    const rows = db.prepare(
      `SELECT ${COLS_A} FROM anime_cache a
       WHERE 1 = 1${extraWhere} ORDER BY (a.score IS NULL) ASC, a.score DESC LIMIT ? OFFSET ?`)
      .all(...condParams, perPage, offset);
    const total = db.prepare(
      `SELECT COUNT(*) AS c FROM anime_cache a WHERE 1 = 1${extraWhere}`).get(...condParams).c;
    return { items: rowsToAnime(rows), pagination: pageOf(total, page, perPage), total };
  }

  const terms = q.split(/\s+/).map((t) => `"${t.replace(/["*]/g, '')}"`).filter((t) => t.length > 2);
  let rows = [];
  let total = 0;
  if (terms.length) {
    const match = terms.join(' ');
    try {
      rows = db.prepare(
        `SELECT a.payload, a.sub_indo FROM anime_cache a JOIN anime_fts f ON f.rowid = a.id
         WHERE anime_fts MATCH ?${extraWhere} ORDER BY ${SEARCH_TYPE_RANK}, ${SEARCH_DATE_KEY}, rank, ${SEARCH_TIEBREAK} LIMIT ? OFFSET ?`)
        .all(match, ...condParams, perPage, offset);
      total = db.prepare(
        `SELECT COUNT(*) AS c FROM anime_cache a JOIN anime_fts f ON f.rowid = a.id
         WHERE anime_fts MATCH ?${extraWhere}`).get(match, ...condParams).c;
    } catch { rows = []; total = 0; }
  }
  if (!rows.length) {
    // Fallback LIKE: cocok untuk kata pendek / karakter khusus.
    const like = `%${q.replace(/[%_]/g, '')}%`;
    rows = db.prepare(
      `SELECT a.payload, a.sub_indo FROM anime_cache a
       WHERE (a.title LIKE ? COLLATE NOCASE OR a.alternative LIKE ? COLLATE NOCASE)${extraWhere}
       ORDER BY ${SEARCH_ORDER} LIMIT ? OFFSET ?`).all(like, like, ...condParams, perPage, offset);
    total = db.prepare(
      `SELECT COUNT(*) AS c FROM anime_cache a
       WHERE (a.title LIKE ? COLLATE NOCASE OR a.alternative LIKE ? COLLATE NOCASE)${extraWhere}`)
      .get(like, like, ...condParams).c;
  }
  return { items: rowsToAnime(rows), pagination: pageOf(total, page, perPage), total };
}

module.exports = { trending, airing, byGenre, allGenres, az, schedule, upcoming, search };
