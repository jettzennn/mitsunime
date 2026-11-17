'use strict';
// Layanan VidCloud untuk Server HD (v1.5.0, PRD §3.1).
// getSources terbuka tanpa key, tanpa Referer, CORS `*` — respons
// {"encrypted":true,"data":"<base64url>"}; dekode: base64url → byte,
// tiap byte di-XOR dengan (0x4D + (i % 23)) & 0xff → JSON berisi
// sources[0].file (master.m3u8 + token ?t=), tracks[] (VTT EN/PT/ES),
// intro, outro, server. Terverifikasi live dari riset:
// - Case Closed 235/1 server 1 → Sora; server 2 → Zexy; dub jalan.
// - Token ?t= terbukti ≥ 25 menit — ambil segar per permintaan
//   stream-hd, JANGAN di-cache lama, JANGAN ditulis ke log/DB.
// Kunci XOR bisa dirotasi VidCloud kapan saja (ada di kode player
// publik mereka) — bila dekode gagal, Server HD gagal jujur (502)
// dan pemilih server pindah ke MegaPlay.
const logger = require('../utils/logger');

const GETSOURCES_BASE = 'https://vidcloud.sbs/embed-2/v3/e-1/getSources';
const FETCH_TIMEOUT_MS = 10000; // PRD §4.5: timeout getSources 10 dtk
const SERVERS = [1, 2, 3]; // dicoba berurutan bila gagal

class VidCloudError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'VidCloudError';
    this.status = status;
  }
}

function base64urlDecode(s) {
  const norm = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4;
  return Buffer.from(pad ? norm + '='.repeat(4 - pad) : norm, 'base64');
}

// Dekode payload getSources (parseSourcePayload dari kode player VidCloud).
function decodeSourcesPayload(data) {
  const buf = base64urlDecode(data);
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ ((0x4D + (i % 23)) & 0xff);
  }
  return JSON.parse(out.toString('utf8'));
}

// Satu percobaan getSources ke satu nomor server. Melempar VidCloudError
// bila HTTP gagal, jawaban bukan JSON, format tidak dikenal, atau dekode
// gagal (URL upstream TIDAK PERNAH ditulis ke log/pesan).
async function fetchGetSources(extId, ep, serverNum, track) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(
      `${GETSOURCES_BASE}?id=${encodeURIComponent(`${extId}-${ep}-${serverNum}-${track}`)}`,
      {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'Mitsunime/1.5.0 (server)' },
      },
    );
  } catch (e) {
    throw new VidCloudError(0, e && e.name === 'AbortError'
      ? 'VidCloud tidak merespons dalam waktu yang ditentukan'
      : 'Tidak dapat terhubung ke VidCloud.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new VidCloudError(res.status, `VidCloud mengembalikan galat ${res.status}.`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new VidCloudError(502, 'VidCloud mengembalikan jawaban bukan JSON.');
  }
  if (!body || body.encrypted !== true || typeof body.data !== 'string') {
    throw new VidCloudError(502, 'VidCloud mengembalikan format jawaban tidak dikenal.');
  }
  let decoded;
  try {
    decoded = decodeSourcesPayload(body.data);
  } catch {
    throw new VidCloudError(502, 'VidCloud mengembalikan data yang tidak bisa dibaca.');
  }
  if (!decoded || !Array.isArray(decoded.sources) || !decoded.sources[0]
    || typeof decoded.sources[0].file !== 'string') {
    throw new VidCloudError(502, 'VidCloud tidak mengembalikan URL video.');
  }
  return decoded;
}

// Resolusi sumber VidCloud: coba server 1→2→3 berurutan; yang pertama
// berhasil dipakai. `serverOrder` bisa diubah pemanggil (mis. uji yang
// memaksa server pertama gagal). Semua gagal → VidCloudError 502.
// Mengembalikan JSON hasil dekode + `server` = nomor server yang
// dipakai (bila JSON membawa `server`, nilai itu yang dipakai).
async function resolveSources(extId, ep, track, serverOrder = SERVERS) {
  let lastErr = null;
  for (const n of serverOrder) {
    try {
      const decoded = await fetchGetSources(extId, ep, n, track);
      return { ...decoded, server: typeof decoded.server === 'number' ? decoded.server : n };
    } catch (e) {
      lastErr = e;
      logger.warn(`VidCloud getSources server ${n} gagal (${e.message})`);
    }
  }
  throw new VidCloudError(502, lastErr && lastErr.message
    ? lastErr.message : 'VidCloud sedang tidak dapat dijangkau.');
}

// Ambil isi teks dari satu URL upstream (dipakai untuk VTT Inggris).
// Timeout 20 dtk (FETCH_TIMEOUT_MS). Melempar Error biasa (bukan
// VidCloudError) — pemanggil memutuskan fail soft atau gagal.
async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mitsunime/1.5.0 (server)' },
    });
  } catch (e) {
    throw new Error(e && e.name === 'AbortError'
      ? 'Upstream tidak merespons dalam waktu yang ditentukan'
      : 'Tidak dapat terhubung ke upstream.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const e = new Error(`Upstream mengembalikan galat ${res.status}.`);
    e.status = res.status;
    throw e;
  }
  return res.text();
}

// Peta label track VidCloud → kode bahasa 2 huruf. Label yang tidak
// dikenal → null (track dilewati — tidak bisa dipakai translate).
const TRACK_LANGS = {
  english: 'en', portuguese: 'pt', spanish: 'es',
  indonesian: 'id', japanese: 'ja',
};

function trackLang(label) {
  const l = String(label == null ? '' : label).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TRACK_LANGS, l) ? TRACK_LANGS[l] : null;
}

module.exports = {
  VidCloudError, decodeSourcesPayload, fetchGetSources, resolveSources,
  fetchText, trackLang, SERVERS,
};
