'use strict';
// Derivasi dari cache — Anikoto TIDAK punya endpoint trending/genre/
// jadwal, jadi semua ini dihitung dari anime_cache.
// Dipakai ulang dari proyek NontonAnime v1.1.3; yang berubah untuk Mitsunime:
// - semua hasil membawa flag admin sub_indo dan premium_only (badge di UI);
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

const COLS = 'payload, sub_indo, premium_only';
const COLS_A = 'a.payload, a.sub_indo, a.premium_only';

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
        `SELECT a.payload, a.sub_indo, a.premium_only FROM anime_cache a JOIN anime_fts f ON f.rowid = a.id
         WHERE anime_fts MATCH ?${extraWhere} ORDER BY rank LIMIT ? OFFSET ?`)
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
      `SELECT a.payload, a.sub_indo, a.premium_only FROM anime_cache a
       WHERE (a.title LIKE ? COLLATE NOCASE OR a.alternative LIKE ? COLLATE NOCASE)${extraWhere}
       ORDER BY a.title COLLATE NOCASE ASC LIMIT ? OFFSET ?`).all(like, like, ...condParams, perPage, offset);
    total = db.prepare(
      `SELECT COUNT(*) AS c FROM anime_cache a
       WHERE (a.title LIKE ? COLLATE NOCASE OR a.alternative LIKE ? COLLATE NOCASE)${extraWhere}`)
      .get(like, like, ...condParams).c;
  }
  return { items: rowsToAnime(rows), pagination: pageOf(total, page, perPage), total };
}

module.exports = { trending, airing, byGenre, allGenres, az, schedule, upcoming, search };
