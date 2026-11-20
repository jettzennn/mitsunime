'use strict';
// Layanan MegaPlay untuk Server HD (v1.5.1, PRD §4.3).
// Alur: halaman embed → data-id segar → getSources → dekripsi enc
// AES-256-CBC → master.m3u8 + tracks (VTT Inggris dll.).
// Kunci/IV dekripsi hardcode di JS publik MegaPlay (e1-player.min.js)
// — nilainya dari laporan dekripsi 17 Nov §2; BUKAN rahasia Mitsunime,
// tapi jangan pernah ditulis ke log/DB/respons (pesan error di sini
// tidak mengandung URL upstream).
// Token CDN TIDAK dihitung (PRD §17.7 — terverifikasi tidak diperlukan
// 17 Nov dan 19 Nov). data-id BERUBAH tiap request — wajib diambil
// segar, jangan di-cache.
const crypto = require('node:crypto');
const config = require('../config');
const logger = require('../utils/logger');

const MEGAPLAY_BASE = config.MEGAPLAY_BASE_URL; // https://megaplay.buzz
// Referer halaman embed: asal Mitsunime sendiri (terverifikasi Riset
// 19 Nov memakai http://localhost:3000/watch.html → 200 + data-id).
const EMBED_REFERER = `${config.BASE_URL}/watch.html`;
// Referer CDN MegaPlay: persis origin + trailing slash (§3.1 PRD).
const CDN_REFERER = 'https://megaplay.buzz/';
const FETCH_TIMEOUT_MS = 10000; // PRD §4.3: timeout embed/getSources 10 dtk

// Kunci/IV dekripsi enc — laporan dekripsi 17 Nov §2 (nilai publik
// dari e1-player.min.js MegaPlay). Kunci 17 karakter → UTF-8, dipad
// NOL sampai 32 byte; IV 16 karakter → tepat 16 byte.
const ENC_KEY_STRING = 'i?LMTAx0Q6,:}50U';
const ENC_IV_STRING = "W0;27ToaUpl_P%'c";

class MegaPlayError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'MegaPlayError';
    this.status = status;
  }
}

function padKeyBytes(str) {
  const buf = Buffer.alloc(32, 0);
  Buffer.from(str, 'utf8').copy(buf);
  return buf;
}

function base64urlDecode(s) {
  const norm = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4;
  return Buffer.from(pad ? norm + '='.repeat(4 - pad) : norm, 'base64');
}

// Dekripsi field `enc` → objek { file: master.m3u8 }. Melempar bila
// base64 tidak valid, padding salah, atau plaintext bukan JSON.
function decryptEnc(enc) {
  const cipher = base64urlDecode(enc);
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    padKeyBytes(ENC_KEY_STRING),
    Buffer.from(ENC_IV_STRING, 'utf8'),
  );
  const plain = Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal, ...options })
    .finally(() => clearTimeout(timer));
}

// Satu percobaan ulang bila gagal jaringan (status 0) atau 5xx
// (PRD §4.3: maks 2 percobaan per langkah). 4xx dan gagal dekripsi
// TIDAK diulang.
async function retryOnce(fn) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const transient = e && (e.status === 0 || (e.status >= 500 && e.status <= 599));
      if (!transient || attempt === 1) throw e;
      logger.warn(`MegaPlay: percobaan ${attempt + 1} gagal (${e.message}), coba sekali lagi`);
    }
  }
  throw lastErr;
}

// Langkah 1: halaman embed. Tanpa Referer, halaman mengembalikan 200
// berisi error 410 tanpa data-id — jadi Referer wajib ada.
async function fetchEmbedPage(episodeEmbedId, track) {
  const embedUrl = `${MEGAPLAY_BASE}/stream/s-2/${encodeURIComponent(episodeEmbedId)}/${track}`;
  let res;
  try {
    res = await fetchWithTimeout(embedUrl, {
      headers: {
        Accept: 'text/html',
        Referer: EMBED_REFERER,
        'User-Agent': 'Mitsunime/1.5.1 (server)',
      },
    }, FETCH_TIMEOUT_MS);
  } catch (e) {
    throw new MegaPlayError(0, e && e.name === 'AbortError'
      ? 'MegaPlay tidak merespons dalam waktu yang ditentukan'
      : 'Tidak dapat terhubung ke MegaPlay.');
  }
  if (!res.ok) {
    throw new MegaPlayError(res.status, `MegaPlay mengembalikan galat ${res.status}.`);
  }
  return { html: await res.text(), embedUrl };
}

// Parse data-id segar dari HTML halaman embed. `data-realid` dan
// `data-mediaid` tidak cocok dengan pola ini (setelah "data-" harus
// langsung "id=") — hanya data-id player yang diambil.
function parseDataId(html) {
  const m = String(html).match(/data-id="(\d+)"/);
  return m ? m[1] : null;
}

// Langkah 3: getSources. Referer = URL halaman embed + X-Requested-With.
async function fetchGetSources(dataId, embedUrl) {
  const url = `${MEGAPLAY_BASE}/stream/getSources?id=${encodeURIComponent(dataId)}`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      headers: {
        Accept: 'application/json',
        Referer: embedUrl,
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mitsunime/1.5.1 (server)',
      },
    }, FETCH_TIMEOUT_MS);
  } catch (e) {
    throw new MegaPlayError(0, e && e.name === 'AbortError'
      ? 'MegaPlay tidak merespons dalam waktu yang ditentukan'
      : 'Tidak dapat terhubung ke MegaPlay.');
  }
  if (!res.ok) {
    throw new MegaPlayError(res.status, `MegaPlay mengembalikan galat ${res.status}.`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new MegaPlayError(502, 'MegaPlay mengembalikan jawaban bukan JSON.');
  }
  return body;
}

// Tambah ?t=sub|?t=dub ke URL master (pola withAudioType player MegaPlay).
function withAudioType(masterUrl, track) {
  const sep = masterUrl.includes('?') ? '&' : '?';
  return `${masterUrl}${sep}t=${track === 'dub' ? 'dub' : 'sub'}`;
}

// Resolusi sumber MegaPlay — bentuk kembaliannya SAMA seperti
// vidcloud.resolveSources (supaya routes/hd.js hanya mengganti
// pemanggilnya): { sources: [{ file }], tracks, intro, outro, server }.
// `episode` (nomor episode) diterima demi bentuk yang sama, tapi
// MegaPlay mengidentifikasi lewat episode_embed_id, bukan nomor.
async function resolveSources(episodeEmbedId, episode, lang) {
  const track = lang === 'dub' ? 'dub' : 'sub';
  const { html, embedUrl } = await retryOnce(() => fetchEmbedPage(episodeEmbedId, track));
  const dataId = parseDataId(html);
  if (!dataId) {
    throw new MegaPlayError(502, 'MegaPlay tidak mengembalikan tautan video.');
  }
  const body = await retryOnce(() => fetchGetSources(dataId, embedUrl));
  if (!body || typeof body.enc !== 'string' || !body.enc) {
    throw new MegaPlayError(502, 'MegaPlay tidak mengembalikan data video.');
  }
  let decoded;
  try {
    decoded = decryptEnc(body.enc);
  } catch {
    // Gagal dekripsi = kunci berubah, bukan transient — JANGAN retry.
    throw new MegaPlayError(502, 'MegaPlay mengembalikan data yang tidak bisa dibaca.');
  }
  if (!decoded || typeof decoded.file !== 'string' || !/^https?:\/\//.test(decoded.file)) {
    throw new MegaPlayError(502, 'MegaPlay tidak mengembalikan URL video.');
  }
  return {
    sources: [{ file: withAudioType(decoded.file, track) }],
    // Tracks diteruskan apa adanya (bisa kosong; label boleh kosong).
    // Jangan mengasumsikan jumlah/urutan — subdomain VTT berotasi (§3.1).
    tracks: Array.isArray(body.tracks) ? body.tracks : [],
    intro: body.intro && typeof body.intro === 'object' ? body.intro : null,
    outro: body.outro && typeof body.outro === 'object' ? body.outro : null,
    server: typeof body.server === 'number' ? body.server : 1,
  };
}

// Ambil isi teks dari satu URL upstream MegaPlay (dipakai untuk VTT
// Inggris). Referer CDN wajib — tanpa header ini CDN menjawab 403.
// Timeout 20 dtk. Melempar Error biasa (bukan MegaPlayError) — pemanggil
// memutuskan fail soft atau gagal.
async function fetchText(url, timeoutMs = 20000) {
  let res;
  try {
    res = await fetchWithTimeout(url, {
      headers: {
        Referer: CDN_REFERER,
        'User-Agent': 'Mitsunime/1.5.1 (server)',
      },
    }, timeoutMs);
  } catch (e) {
    throw new Error(e && e.name === 'AbortError'
      ? 'Upstream tidak merespons dalam waktu yang ditentukan'
      : 'Tidak dapat terhubung ke upstream.');
  }
  if (!res.ok) {
    const e = new Error(`Upstream mengembalikan galat ${res.status}.`);
    e.status = res.status;
    throw e;
  }
  return res.text();
}

// Peta label track MegaPlay → kode bahasa 2 huruf. Label yang tidak
// dikenal → null (track dilewati — tidak bisa dipakai translate).
const TRACK_LANGS = {
  english: 'en', portuguese: 'pt', spanish: 'es',
  indonesian: 'id', japanese: 'ja',
};

function trackLang(label) {
  const l = String(label == null ? '' : label).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(TRACK_LANGS, l)) return TRACK_LANGS[l];
  // Label MegaPlay seperti "English (English [Full])" — bahasa ada di
  // kata pertama (sebelum spasi atau '('). Label yang kata pertamanya
  // tidak dikenal → null (tidak berubah). (§7F.3 (a), item 19)
  const first = l.split(/[\s(]/)[0];
  return Object.prototype.hasOwnProperty.call(TRACK_LANGS, first) ? TRACK_LANGS[first] : null;
}

// Track Forced (hanya teks tanda, bukan dialog penuh) bila label ATAU
// nama file mengandung kata "forced" (case-insensitive).
// (§7F.3 definisi Forced, item 19)
function isForcedTrack(t) {
  if (!t) return false;
  const label = typeof t.label === 'string' ? t.label : '';
  const file = typeof t.file === 'string' ? t.file : '';
  return /forced/i.test(label) || /forced/i.test(file);
}

// Identifikasi track Inggris (PRD §7F.3 (c), mengikat):
// Pass 1 — track non-Forced dulu (Full menang atas Forced);
// Pass 2 — Forced hanya sebagai fallback (judul yang hanya punya Forced).
// Sinyal "ini track Inggris" (aturan lama, dipertahankan):
// 1. label terpetakan ke 'en';
// 2. bila tidak ada, petunjuk nama file — URL `file` mengandung 'eng';
// 3. bila tetap tidak ada → null (JANGAN menebak, jangan jadikan track
//    pertama sebagai Inggris secara buta).
// Mengembalikan item track apa adanya, atau null.
function englishTrack(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const isEnglish = (t) => {
    if (!t || typeof t.file !== 'string') return false;
    if (trackLang(t.label) === 'en') return true;
    if (!/^https?:\/\//.test(t.file)) return false;
    if (trackLang(t.label)) return false; // label sudah terpetakan ke bahasa lain
    return /eng/i.test(t.file);
  };
  for (const t of list) {
    if (isEnglish(t) && !isForcedTrack(t)) return t;
  }
  for (const t of list) {
    if (isEnglish(t)) return t;
  }
  return null;
}

module.exports = {
  MegaPlayError, decryptEnc, parseDataId, fetchEmbedPage, fetchGetSources,
  resolveSources, fetchText, trackLang, englishTrack, isForcedTrack, CDN_REFERER,
};
