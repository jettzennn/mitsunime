'use strict';
// Cache SQLite: baca/tulis anime_cache, series_cache, crawl_state.
// Dipakai ulang dari proyek NontonAnime v1.1.3; yang berubah untuk Mitsunime:
// - upsert TIDAK menyentuh kolom sub_indo, supaya flag yang
//   sudah diisi admin tidak hilang saat sync ulang (flag hanya diubah admin).
// - hasil baca membawa flag sub_indo (untuk badge di UI).
// Semua query memakai parameter binding — tidak ada string SQL dari input
// pengguna (pencegahan injeksi, OWASP).
// TTL: recent 15 mnt, series 1 jam. Data basi tetap disajikan dengan
// flag stale:true bila Anikoto gagal.
const dbModule = require('../db/database');
const config = require('../config');
const logger = require('../utils/logger');

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function toInt(v, fallback = 0) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toScore(v) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function genresOf(item) {
  const g = item && item.terms_by_type && item.terms_by_type.genre;
  return Array.isArray(g) ? g : [];
}

function studiosOf(item) {
  const s = item && item.terms_by_type && item.terms_by_type.studios;
  return Array.isArray(s) ? s : [];
}

// Simpan SATU baris anime (payload mentah dipertahankan apa adanya,
// jadi `score` tetap string "8.18" seperti dari Anikoto — frontend
// mem-parse float sendiri; kolom score REAL hanya untuk pengurutan).
// PENTING: kolom sub_indo TIDAK ada di daftar upsert,
// jadi flag admin bertahan apa adanya saat sync ulang.
function upsertAnime(item) {
  const db = dbModule.get();
  const fetched = nowSec();
  db.prepare(`INSERT INTO anime_cache
    (id, title, alternative, titles, slug, poster, background_image, score, score_raw,
     status, year, is_sub, is_dub, mal_id, ani_id, genres, studios,
     description, next_air_schedule_time, next_air_ep, updated_at, payload, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, alternative=excluded.alternative, titles=excluded.titles, slug=excluded.slug,
      poster=excluded.poster, background_image=excluded.background_image,
      score=excluded.score, score_raw=excluded.score_raw, status=excluded.status,
      year=excluded.year, is_sub=excluded.is_sub, is_dub=excluded.is_dub,
      mal_id=excluded.mal_id, ani_id=excluded.ani_id, genres=excluded.genres,
      studios=excluded.studios, description=excluded.description,
      next_air_schedule_time=excluded.next_air_schedule_time,
      next_air_ep=excluded.next_air_ep, updated_at=excluded.updated_at,
      payload=excluded.payload, fetched_at=excluded.fetched_at`)
    .run(
      toInt(item.id), item.title || '', item.alternative || null, item.titles || null, item.slug || null,
      item.poster || null, item.background_image || null,
      toScore(item.score), item.score != null ? String(item.score) : null,
      item.status || null, toInt(item.year, null),
      toInt(item.is_sub), toInt(item.is_dub),
      item.mal_id != null ? String(item.mal_id) : null,
      item.ani_id != null ? String(item.ani_id) : null,
      JSON.stringify(genresOf(item)), JSON.stringify(studiosOf(item)),
      item.description || null,
      item.next_air_schedule_time != null ? toInt(item.next_air_schedule_time) : null,
      item.next_air_ep != null ? toInt(item.next_air_ep) : null,
      item.updated_at || null, JSON.stringify(item), fetched,
    );
  // Sinkronkan FTS (content table: rebuild baris ini).
  db.prepare("INSERT INTO anime_fts(rowid, title, alternative, titles) VALUES (?, ?, ?, ?)")
    .run(toInt(item.id), item.title || '', item.alternative || '', item.titles || '');
  return fetched;
}

// Hapus baris FTS lama sebelum upsert ulang (hindari duplikat FTS).
function upsertAnimeSafe(item) {
  const db = dbModule.get();
  db.prepare('DELETE FROM anime_fts WHERE rowid = ?').run(toInt(item.id));
  return upsertAnime(item);
}

function upsertMany(items) {
  const db = dbModule.get();
  // node:sqlite tidak punya db.transaction() (itu API better-sqlite3) —
  // pakai BEGIN/COMMIT manual.
  db.exec('BEGIN');
  try {
    for (const item of items) {
      db.prepare('DELETE FROM anime_fts WHERE rowid = ?').run(toInt(item.id));
      upsertAnime(item);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  logger.info(`Cache: ${items.length} judul disimpan`);
}

// Gabungkan payload mentah Anikoto dengan flag admin Mitsunime.
// Flag ditulis sebagai angka 0/1 di level atas objek hasil.
function rowToAnime(row) {
  if (!row) return null;
  try {
    const item = JSON.parse(row.payload);
    if (row.sub_indo !== undefined) item.sub_indo = row.sub_indo ? 1 : 0;
    // M2: mal_id/ani_id TIDAK PERNAH keluar ke payload publik — keduanya
    // adalah bahan pembangun URL fallback MegaPlay. URL tontonan hanya
    // diberikan lewat endpoint stream yang butuh login (routes/public.js).
    delete item.mal_id;
    delete item.ani_id;
    return item;
  } catch {
    return null;
  }
}

// Flag admin untuk satu judul (dipakai route/gating tanpa parse payload).
function getAnimeFlags(id) {
  const row = dbModule.get().prepare(
    'SELECT sub_indo FROM anime_cache WHERE id = ?',
  ).get(toInt(id));
  return row ? { sub_indo: row.sub_indo ? 1 : 0 } : null;
}

// Ubah flag admin untuk satu judul. Hanya field yang diberikan yang diubah.
// sub_indo = 1 berarti admin sudah memverifikasi Sub Indo.
// Mengembalikan flag terbaru, atau null bila id tidak ada di katalog.
function setAnimeFlags(id, { sub_indo } = {}) {
  const db = dbModule.get();
  const row = db.prepare('SELECT id FROM anime_cache WHERE id = ?').get(toInt(id));
  if (!row) return null;
  const sets = [];
  const params = [];
  if (sub_indo !== undefined) {
    sets.push('sub_indo = ?'); params.push(sub_indo ? 1 : 0);
    if (sub_indo) { sets.push('sub_indo_verified_at = ?'); params.push(nowSec()); }
    else { sets.push('sub_indo_verified_at = NULL'); }
  }
  if (!sets.length) return getAnimeFlags(id);
  params.push(toInt(id));
  db.prepare(`UPDATE anime_cache SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getAnimeFlags(id);
}

function listRecent(page, perPage) {
  const db = dbModule.get();
  const offset = (page - 1) * perPage;
  const rows = db.prepare(
    'SELECT payload, fetched_at, sub_indo FROM anime_cache ORDER BY updated_at DESC, fetched_at DESC LIMIT ? OFFSET ?',
  ).all(perPage, offset);
  const total = db.prepare('SELECT COUNT(*) AS c FROM anime_cache').get().c;
  return { items: rows.map(rowToAnime).filter(Boolean), total, freshest: rows[0] ? rows[0].fetched_at : 0 };
}

function getAnimeById(id) {
  const row = dbModule.get().prepare(
    'SELECT payload, fetched_at, sub_indo FROM anime_cache WHERE id = ?',
  ).get(id);
  return row ? { item: rowToAnime(row), fetchedAt: row.fetched_at } : null;
}

function countAnime() {
  return dbModule.get().prepare('SELECT COUNT(*) AS c FROM anime_cache').get().c;
}

function freshestFetchedAt() {
  const row = dbModule.get().prepare('SELECT MAX(fetched_at) AS m FROM anime_cache').get();
  return row ? row.m : 0;
}

// Stale bila cache terbaru sudah lebih tua dari TTL recent (15 mnt).
// Dipakai untuk keputusan refresh internal. BUKAN untuk banner —
// banner memakai isDataOld() di bawah (ambang 12 jam), supaya banner
// tidak muncul hanya karena cache berumur belasan menit.
function cacheIsStale() {
  const freshest = freshestFetchedAt();
  return !freshest || (nowSec() - freshest) > config.RECENT_TTL_SECONDS;
}

// v1.2.0 — ambang umur untuk BANNER "data mungkin tidak terbaru".
// true hanya bila data yang disajikan memang sudah lama (lebih tua dari
// STALE_BANNER_AGE_SECONDS, default 12 jam) atau tidak ada data sama
// sekali. Satu kegagalan refresh sesaat TIDAK membuat data lama —
// bila cache masih segar, banner tidak muncul. Pemakaian sehari-hari
// (sync pagi, dibuka sore) berada di bawah ambang ini.
// Catatan jujur: akar masalah banner di HP pengguna 2026-11-15: DB di
// zip di-sync jam ~07:00 WIB, situs dibuka ~13:57 WIB (umur ~7 jam) —
// cacheIsStale() lama (ambang 15 menit) langsung menandai stale, dan
// server tidak pernah me-refresh cache sendiri (sync hanya lewat
// cron/manual). Jadi banner muncul padahal internet pengguna jalan.
function isDataOld(fetchedAt) {
  if (!fetchedAt) return true;
  return (nowSec() - fetchedAt) > config.STALE_BANNER_AGE_SECONDS;
}

// --- series_cache ---
function getSeries(id) {
  const row = dbModule.get().prepare('SELECT payload, fetched_at FROM series_cache WHERE id = ?').get(id);
  if (!row) return null;
  try {
    return { data: JSON.parse(row.payload), fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}

function putSeries(id, data) {
  const episodes = data && Array.isArray(data.episodes) ? data.episodes : [];
  dbModule.get().prepare(`INSERT INTO series_cache (id, payload, episode_count, fetched_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,
      episode_count=excluded.episode_count, fetched_at=excluded.fetched_at`)
    .run(id, JSON.stringify(data), episodes.length, nowSec());
}

function countSeries() {
  return dbModule.get().prepare('SELECT COUNT(*) AS c FROM series_cache').get().c;
}

// --- crawl_state ---
function getState(key) {
  const row = dbModule.get().prepare('SELECT value FROM crawl_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setState(key, value) {
  dbModule.get().prepare(`INSERT INTO crawl_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(key, String(value), nowSec());
}

function lastAnikotoStatus() {
  const raw = getState('anikoto:last_status');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function recordAnikotoStatus(ok, status, message) {
  setState('anikoto:last_status', JSON.stringify({ ok, status, message: message || null, at: nowSec() }));
}

// M4: true HANYA bila status Anikoto terakhir yang tercatat adalah gagal.
// Tanpa catatan sama sekali → false (jangan tuduh Anikoto mati hanya
// karena cache sudah tua — itu dua keadaan berbeda).
function anikotoDown() {
  const s = lastAnikotoStatus();
  return !!s && s.ok === false;
}

module.exports = {
  nowSec, rowToAnime, upsertAnimeSafe, upsertMany, listRecent, getAnimeById, getAnimeFlags,
  setAnimeFlags,
  countAnime, freshestFetchedAt, cacheIsStale, isDataOld,
  getSeries, putSeries, countSeries,
  getState, setState, lastAnikotoStatus, recordAnikotoStatus, anikotoDown,
};
