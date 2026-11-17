'use strict';
// Cache subtitle Indonesia (v1.5.0, PRD §6, §5.3–§5.4).
// - Header `subtitle_cache`: satu baris per (anime, episode, source_hash)
//   + source_cues JSON (untuk validasi save + rakit file).
// - Cue `subtitle_cues`: satu baris per cue terjemahan; start/end
//   disimpan milidetik bulat, API memakai detik desimal.
// - Validasi save: cue HARUS cocok dengan source cues (index +
//   start/end dalam toleransi 10 ms); cue yang tidak cocok → seluruh
//   request ditolak 400 (jangan simpan sebagian — mencegah cache
//   keracunan). Semua-atau-tidak-ada (transaksi).
const crypto = require('node:crypto');
const dbModule = require('../db/database');

const TOLERANCE_MS = 10;
const MAX_CUES_PER_SAVE = 50;
const MAX_TEXT_CHARS = 1000;

class SubtitleError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SubtitleError';
    this.status = status;
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// sha256 16 heks — pola sourceHash() di services/translate.js.
function sourceHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// Parse stempel waktu VTT ("MM:SS.mmm" atau "HH:MM:SS.mmm") → detik.
function parseTimestamp(s) {
  const m = String(s || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{1,3})$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
    + parseInt(m[4].padEnd(3, '0'), 10) / 1000;
}

// Parse WEBVTT → [{index, start, end, text}] (detik desimal).
// Aturan (Frontend subs.js memakai aturan yang sama — jaga sinkron):
// blok dipisah baris kosong; baris pertama yang mengandung '-->' adalah
// baris timestamp (baris sebelumnya, bila ada, adalah identifier cue
// dan diabaikan); teks = baris setelahnya digabung '\n'. Cue tanpa teks
// dilewati. Baris WEBVTT/NOTE dilewati.
function parseVtt(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const blocks = src.split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    if (lines[0].startsWith('WEBVTT')) continue;
    let tsIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) { tsIdx = i; break; }
    }
    if (tsIdx === -1) continue;
    const parts = lines[tsIdx].split('-->').map((s) => s.trim());
    const start = parseTimestamp(parts[0]);
    const end = parseTimestamp((parts[1] || '').split(/\s+/)[0]);
    if (start == null || end == null || !(end > start)) continue;
    const cueText = lines.slice(tsIdx + 1).join('\n').trim();
    if (!cueText) continue;
    cues.push({ index: cues.length, start, end, text: cueText });
  }
  return cues;
}

function getHeader(animeId, episode, hash) {
  return dbModule.get().prepare(
    'SELECT * FROM subtitle_cache WHERE anime_id = ? AND episode = ? AND source_hash = ?',
  ).get(animeId, episode, hash) || null;
}

// Buat baris header bila belum ada (INSERT OR IGNORE — baris lama
// dipertahankan beserta translated_count-nya).
function ensureHeader(animeId, episode, hash, sourceCues) {
  dbModule.get().prepare(`INSERT OR IGNORE INTO subtitle_cache
      (anime_id, episode, source_hash, source_lang, source_cues, cue_count,
       translated_count, status, created_at, updated_at)
    VALUES (?, ?, ?, 'en', ?, ?, 0, 'partial', ?, ?)`)
    .run(animeId, episode, hash, JSON.stringify(sourceCues), sourceCues.length, nowSec(), nowSec());
}

// Status cache untuk check-cache / stream-hd (dihitung dari data,
// bukan mempercayai kolom status mentah).
function getStatus(animeId, episode, hash) {
  const h = getHeader(animeId, episode, hash);
  if (!h) return { status: 'none', cue_count: 0, translated_count: 0 };
  const status = (h.cue_count > 0 && h.translated_count >= h.cue_count) ? 'complete' : 'partial';
  return { status, cue_count: h.cue_count, translated_count: h.translated_count };
}

// Cue terjemahan yang sudah tersimpan, urut index — untuk check-cache.
function getTranslatedCues(animeId, episode, hash) {
  const rows = dbModule.get().prepare(`SELECT cue_index, start_ms, end_ms, translated_text
      FROM subtitle_cues
      WHERE anime_id = ? AND episode = ? AND source_hash = ?
      ORDER BY cue_index ASC`)
    .all(animeId, episode, hash);
  return rows.map((r) => ({
    index: r.cue_index,
    start: r.start_ms / 1000,
    end: r.end_ms / 1000,
    text: r.translated_text,
  }));
}

// Simpan batch cue terjemahan (validasi §5.4, semua-atau-tidak-ada).
// Mengembalikan { saved, status }. Melempar SubtitleError(400) bila
// validasi gagal — TIDAK ADA yang tersimpan dalam kasus itu.
function saveCues(animeId, episode, hash, cues) {
  if (!Array.isArray(cues) || cues.length === 0 || cues.length > MAX_CUES_PER_SAVE) {
    throw new SubtitleError(400, 'Jumlah cue harus 1–50 per permintaan.');
  }
  const db = dbModule.get();
  const header = getHeader(animeId, episode, hash);
  if (!header) {
    throw new SubtitleError(400, 'Episode ini belum punya cache subtitle. Buka dulu lewat Server HD.');
  }
  let sourceCues;
  try {
    sourceCues = JSON.parse(header.source_cues);
  } catch {
    throw new SubtitleError(400, 'Data sumber subtitle rusak.');
  }
  if (!Array.isArray(sourceCues)) {
    throw new SubtitleError(400, 'Data sumber subtitle rusak.');
  }
  const byIndex = new Map(sourceCues.map((c) => [c.index, c]));
  // Validasi SEMUA dulu — satu cue tidak cocok → tolak seluruh request.
  for (const cue of cues) {
    if (!cue || typeof cue !== 'object') {
      throw new SubtitleError(400, 'Format cue tidak valid.');
    }
    if (!Number.isInteger(cue.index) || cue.index < 0) {
      throw new SubtitleError(400, 'Nomor cue tidak valid.');
    }
    const src = byIndex.get(cue.index);
    if (!src) {
      throw new SubtitleError(400, `Cue ${cue.index} tidak cocok dengan subtitle sumber.`);
    }
    if (typeof cue.start !== 'number' || typeof cue.end !== 'number'
      || !Number.isFinite(cue.start) || !Number.isFinite(cue.end)
      || cue.start < 0 || !(cue.end > cue.start)) {
      throw new SubtitleError(400, 'Waktu cue tidak valid.');
    }
    if (Math.abs(Math.round(cue.start * 1000) - Math.round(src.start * 1000)) > TOLERANCE_MS
      || Math.abs(Math.round(cue.end * 1000) - Math.round(src.end * 1000)) > TOLERANCE_MS) {
      throw new SubtitleError(400, `Cue ${cue.index} tidak cocok dengan subtitle sumber.`);
    }
    if (typeof cue.text !== 'string' || !cue.text.trim() || cue.text.length > MAX_TEXT_CHARS) {
      throw new SubtitleError(400, 'Teks terjemahan tidak valid (kosong atau lebih dari 1000 karakter).');
    }
  }
  const upsert = db.prepare(`INSERT INTO subtitle_cues
      (anime_id, episode, source_hash, cue_index, start_ms, end_ms, translated_text, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(anime_id, episode, source_hash, cue_index) DO UPDATE SET
      start_ms=excluded.start_ms, end_ms=excluded.end_ms,
      translated_text=excluded.translated_text, updated_at=excluded.updated_at`);
  // Semua-atau-tidak-ada: node:sqlite tidak punya helper transaction
  // (itu API better-sqlite3), jadi BEGIN/COMMIT manual — DatabaseSync
  // sinkron satu-proses, jadi ini aman.
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const cue of cues) {
      upsert.run(animeId, episode, hash, cue.index,
        Math.round(cue.start * 1000), Math.round(cue.end * 1000), cue.text, nowSec());
    }
    const row = db.prepare(
      'SELECT COUNT(*) AS c FROM subtitle_cues WHERE anime_id = ? AND episode = ? AND source_hash = ?',
    ).get(animeId, episode, hash);
    const translated = row.c;
    const status = (header.cue_count > 0 && translated >= header.cue_count) ? 'complete' : 'partial';
    db.prepare(`UPDATE subtitle_cache
        SET translated_count = ?, status = ?, updated_at = ?
        WHERE anime_id = ? AND episode = ? AND source_hash = ?`)
      .run(translated, status, nowSec(), animeId, episode, hash);
    db.exec('COMMIT');
    return { saved: cues.length, status };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* sudah rollback / tidak ada transaksi */ }
    throw e;
  }
}

module.exports = {
  SubtitleError, sourceHash, parseVtt, parseTimestamp,
  getHeader, ensureHeader, getStatus, getTranslatedCues, saveCues,
  MAX_CUES_PER_SAVE, MAX_TEXT_CHARS,
};
