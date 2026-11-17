'use strict';
// Terjemahan sinopsis Inggris → Indonesia, ON-DEMAND (v1.2.0).
// Dipanggil hanya saat halaman detail seri dibuka (routes/public.js);
// sinopsis yang sudah diterjemahkan disimpan di tabel
// synopsis_translations dan dipakai untuk permintaan berikutnya —
// katalog 9.403 judul TIDAK PERNAH diterjemahkan sekaligus.
// Bila layanan terjemah gagal/timeout, pemanggil tetap menampilkan
// sinopsis Inggris (fail soft): fungsi ini melempar, dan pemanggil
// menangkapnya lalu memakai teks sumber.
//
// Layanan: GRATIS, tanpa API key, tanpa kunci apa pun.
// - Utama: endpoint Google Translate tidak resmi
//   (translate.googleapis.com/translate_a/single?client=gtx).
//   Terverifikasi langsung 2026-11-15: mengembalikan terjemahan
//   Indonesia yang benar, tanpa kunci. Bukan API resmi — Google bisa
//   membatasi/memblokir kapan saja; bila itu terjadi, fallback di
//   bawah dicoba, lalu fail soft ke Inggris.
// - Cadangan: MyMemory (api.mymemory.translated.net/get, langpair
//   en|id). Terverifikasi langsung 2026-11-15: endpoint bisa
//   dihubungi, TETAPI kuota gratis anonim (5.000 karakter/hari)
//   dipakai bersama per IP — saat pengujian kuota IP ini sudah
//   habis (429 "YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR
//   TODAY"). Jadi MyMemory hanya cadangan yang kadang jalan; jangan
//   diandalkan sebagai satu-satunya layanan. Batas ukuran tiap
//   permintaan anonim 500 byte — teks dipotong per 450 karakter.
// Batas: total waktu 8 detik untuk seluruh percobaan (satu judul),
// teks sumber dibatasi 4.000 karakter (sinopsis Anikoto umumnya
// < 2.000 karakter; sisanya dipotong di batas kalimat agar hasil
// terjemahan tetap utuh, bukan terpotong di tengah kata).
const crypto = require('node:crypto');
const config = require('../config');
const dbModule = require('../db/database');
const logger = require('../utils/logger');

const TOTAL_TIMEOUT_MS = 8000;
const MAX_SOURCE_CHARS = 4000;
const GOOGLE_CHUNK_CHARS = 2000;
const MYMEMORY_CHUNK_CHARS = 450;

// Kata fungsi Indonesia yang umum — dipakai untuk menebak apakah teks
// sumber sebenarnya sudah berbahasa Indonesia (Anikoto kadang menyimpan
// sinopsis berbahasa Indonesia untuk sebagian judul). Bila >= 3 cocok,
// teks dianggap sudah Indonesia dan tidak diterjemahkan.
const INDONESIAN_MARKERS = /\b(yang|dan|adalah|sebuah|ketika|dengan|untuk|dalam|seorang|mereka|tersebut|sehingga|namun|karena|kemudian|tersebut)\b/gi;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function sourceHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function looksIndonesian(text) {
  const hits = text.match(INDONESIAN_MARKERS);
  return hits && hits.length >= 3;
}

// Pecah teks menjadi potongan <= maxLen, sebisa mungkin di batas kalimat.
function splitIntoChunks(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const packed = [];
  let cur = '';
  for (const s of sentences) {
    if (!cur) { cur = s; continue; }
    if ((cur + ' ' + s).length <= maxLen) cur += ' ' + s;
    else { packed.push(cur); cur = s; }
  }
  if (cur) packed.push(cur);
  const out = [];
  for (const c of packed) {
    for (let i = 0; i < c.length; i += maxLen) out.push(c.slice(i, i + maxLen));
  }
  return out;
}

function fetchWithTimeout(url, options, signal) {
  return fetch(url, {
    ...options,
    signal,
    headers: { 'User-Agent': 'Mitsunime/1.2.0', ...(options && options.headers ? options.headers : {}) },
  });
}

// Google Translate tidak resmi: GET .../translate_a/single?client=gtx
// &sl=en&tl=id&dt=t&q=... → JSON; segmen terjemahan ada di data[0][i][0].
async function translateGoogle(text, signal) {
  const chunks = splitIntoChunks(text, GOOGLE_CHUNK_CHARS);
  const parts = [];
  for (const chunk of chunks) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=id&dt=t&q='
      + encodeURIComponent(chunk);
    const res = await fetchWithTimeout(url, {}, signal);
    if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      throw new Error('Google Translate: format jawaban tidak dikenal.');
    }
    const joined = data[0].map((seg) => (Array.isArray(seg) ? seg[0] : '')).join('');
    if (!joined || !joined.trim()) throw new Error('Google Translate: terjemahan kosong.');
    parts.push(joined);
  }
  return parts.join(' ');
}

// MyMemory: GET .../get?q=...&langpair=en|id →
// { responseData: { translatedText }, responseStatus: 200 }.
// 429 / teks peringatan kuota = gagal (bukan hasil).
async function translateMyMemory(text, signal) {
  const chunks = splitIntoChunks(text, MYMEMORY_CHUNK_CHARS);
  const parts = [];
  for (const chunk of chunks) {
    const url = 'https://api.mymemory.translated.net/get?q='
      + encodeURIComponent(chunk) + '&langpair=en%7Cid'
      // Opsional (config.MYMEMORY_EMAIL): parameter &de= menaikkan kuota
      // gratis harian dari 5.000 menjadi 50.000 karakter. Bukan kunci.
      + (config.MYMEMORY_EMAIL ? '&de=' + encodeURIComponent(config.MYMEMORY_EMAIL) : '');
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, signal);
    if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
    const data = await res.json();
    const t = data && data.responseData && data.responseData.translatedText;
    if (!t || !String(t).trim()) throw new Error('MyMemory: terjemahan kosong.');
    if (String(t).startsWith('MYMEMORY WARNING') || String(t).startsWith('QUERY LENGTH LIMIT')) {
      throw new Error('MyMemory: kuota gratis habis atau teks terlalu panjang.');
    }
    parts.push(String(t));
  }
  return parts.join(' ');
}

// Terjemahkan teks Inggris ke Indonesia. Mencoba Google dulu, lalu
// MyMemory, dengan satu tenggat total. Melempar bila keduanya gagal.
async function translateText(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  try {
    try {
      const out = await translateGoogle(text, controller.signal);
      return { text: out, provider: 'google' };
    } catch (e) {
      logger.warn(`Terjemahan Google gagal (${e.message}) — coba MyMemory.`);
    }
    const out = await translateMyMemory(text, controller.signal);
    return { text: out, provider: 'mymemory' };
  } finally {
    clearTimeout(timer);
  }
}

// Janji yang sedang berjalan per (anime_id + hash sumber) — dua
// pembuka detail yang sama persis tidak memicu dua panggilan terjemah.
const inFlight = new Map();

// Negative cache kegagalan (perbaikan F-01, retest v1.2.0): bila kedua
// layanan gagal untuk satu (anime_id + hash), jangan coba lagi selama
// 5 menit — tiap buka detail saat layanan mati tidak lagi memicu satu
// percobaan penuh (sampai 8 detik) per request. In-memory saja: gagal
// total layanan adalah keadaan sementara; restart server menghapusnya.
// Kunci sama dengan inFlight supaya satu anime + satu versi sinopsis
// berbagi satu catatan gagal.
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const failedAt = new Map(); // key `${animeId}:${hash}` -> Date.now() ms

function isRecentlyFailed(key) {
  const at = failedAt.get(key);
  if (!at) return false;
  if (Date.now() - at < NEGATIVE_CACHE_TTL_MS) return true;
  failedAt.delete(key);
  return false;
}

function markFailed(key) {
  // Jaga ukuran map tetap kecil: buang catatan yang sudah kedaluwarsa
  // bila map membengkak (banyak anime gagal dalam waktu singkat).
  if (failedAt.size > 500) {
    const now = Date.now();
    for (const [k, at] of failedAt) {
      if (now - at >= NEGATIVE_CACHE_TTL_MS) failedAt.delete(k);
    }
  }
  failedAt.set(key, Date.now());
}

// Ambil sinopsis Indonesia untuk satu anime, dari cache bila ada.
// Mengembalikan { text, translated: bool, cached: bool }.
// - text = sinopsis Indonesia bila berhasil, sinonim Inggris bila tidak.
// - translated = true hanya bila text yang dikembalikan memang hasil
//   terjemahan (berbeda dari sumber). Bila layanan mengembalikan teks
//   yang sama persis dengan sumber, hasil itu tetap di-cache supaya
//   tidak dicoba ulang tiap request, tetapi translated = false.
// - Tidak pernah melempar: segala kegagalan → teks sumber.
async function getTranslatedSynopsis(animeId, sourceText) {
  const source = typeof sourceText === 'string' ? sourceText.trim() : '';
  if (!source) return { text: sourceText || '', translated: false, cached: false };
  if (looksIndonesian(source)) {
    return { text: source, translated: true, cached: false };
  }
  const usable = source.length > MAX_SOURCE_CHARS ? source.slice(0, MAX_SOURCE_CHARS) : source;
  const hash = sourceHash(usable);
  const db = dbModule.get();
  const row = db.prepare(
    'SELECT translated_text FROM synopsis_translations WHERE anime_id = ? AND source_hash = ?',
  ).get(animeId, hash);
  if (row) {
    return { text: row.translated_text, translated: row.translated_text !== usable, cached: true };
  }
  const key = `${animeId}:${hash}`;
  // F-01: gagal baru-baru ini → langsung Inggris tanpa mencoba lagi.
  if (isRecentlyFailed(key)) {
    return { text: source, translated: false, cached: false };
  }
  if (inFlight.has(key)) return inFlight.get(key);
  const job = (async () => {
    try {
      const result = await translateText(usable);
      const translated = result.text.trim();
      if (!translated) return { text: source, translated: false, cached: false };
      db.prepare(`INSERT INTO synopsis_translations
          (anime_id, source_hash, source_text, translated_text, provider, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(anime_id) DO UPDATE SET
          source_hash=excluded.source_hash, source_text=excluded.source_text,
          translated_text=excluded.translated_text, provider=excluded.provider,
          updated_at=excluded.updated_at`)
        .run(animeId, hash, usable, translated, result.provider, nowSec(), nowSec());
      logger.info(`Terjemahan sinopsis anime ${animeId} via ${result.provider} (cache disimpan).`);
      return { text: translated, translated: translated !== usable, cached: false };
    } catch (e) {
      // Fail soft: jangan simpan apa pun, jangan lempar — pemanggil
      // menampilkan sinopsis Inggris seperti biasa. F-01: catat
      // kegagalan supaya percobaan ulang ditahan 5 menit.
      markFailed(key);
      logger.warn(`Terjemahan sinopsis anime ${animeId} gagal (${e.message}) — tampilkan Inggris.`);
      return { text: source, translated: false, cached: false };
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

module.exports = { getTranslatedSynopsis, translateText, splitIntoChunks };
