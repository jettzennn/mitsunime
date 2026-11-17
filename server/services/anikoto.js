'use strict';
// Klien Anikoto server-to-server (bebas CORS — CORS hanya berlaku di browser).
// Dipakai ulang dari proyek NontonAnime v1.1.3; yang berubah hanya User-Agent
// (nama paket) — logika antrean dan rate limit tidak diubah.
// Hanya 2 endpoint terverifikasi: /recent-anime dan /series/{id}.
// Rate limit: 60 request / IP / 120 detik. Penahan: antrean sliding-window
// + jeda minimum antar request + retry 429 dengan backoff.
// 403 = IP diblokir (jangan retry membabi buta), 404 = ID tidak ada.
const config = require('../config');
const logger = require('../utils/logger');

const BASE = config.ANIKOTO_BASE_URL;

// Stempel waktu request dalam 120 detik terakhir (sliding window).
const recentCalls = [];
let lastCallAt = 0;
// Promise rantai antrean — request dijalankan berurutan, tidak bersamaan.
let queue = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tunggu sampai ada slot rate limit, lalu catat request ini.
async function acquireSlot() {
  const now = Date.now();
  // Jeda minimum antar request.
  const gap = config.MIN_REQUEST_GAP_MS - (now - lastCallAt);
  if (gap > 0) await sleep(gap);
  // Sliding window: buang stempel yang sudah lewat 120 detik.
  let waited = 0;
  for (;;) {
    const t = Date.now();
    while (recentCalls.length && recentCalls[0] <= t - config.RATE_LIMIT_WINDOW_MS) {
      recentCalls.shift();
    }
    if (recentCalls.length < config.RATE_LIMIT_MAX) break;
    const waitMs = recentCalls[0] + config.RATE_LIMIT_WINDOW_MS - t + 50;
    waited += waitMs;
    logger.warn(`Rate limit Anikoto hampir penuh, menunggu ${Math.round(waitMs / 1000)} dtk...`);
    await sleep(waitMs);
  }
  lastCallAt = Date.now();
  recentCalls.push(lastCallAt);
  return waited;
}

class AnikotoError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AnikotoError';
    this.status = status;
  }
}

async function fetchJson(path, attempt = 0) {
  const url = `${BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'Mitsunime/1.0 (server)' },
    });
  } catch (err) {
    // v1.2.0: gangguan sesaat (jaringan putus / timeout) dicoba lagi —
    // sebelumnya sekali gagal langsung melempar, sehingga satu
    // kegagalan sesaat membuat halaman detail menyajikan cache basi
    // dengan banner. Maks 2x, backoff 2 dtk lalu 4 dtk.
    if (attempt < config.MAX_RETRIES_TRANSIENT) {
      const waitMs = Math.pow(2, attempt) * 2000;
      logger.warn(`Anikoto tidak terjangkau (${err.name}), retry ${attempt + 1} dalam ${waitMs / 1000} dtk`);
      await sleep(waitMs);
      return fetchJson(path, attempt + 1);
    }
    throw new AnikotoError(0, err.name === 'AbortError'
      ? 'Anikoto tidak merespons dalam waktu yang ditentukan'
      : `Tidak dapat terhubung ke Anikoto: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  // 429: mundur lalu coba lagi (maks 3x), hormati Retry-After bila ada.
  if (res.status === 429 && attempt < config.MAX_RETRIES_429) {
    const retryAfter = Number.parseInt(res.headers.get('retry-after'), 10);
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.pow(2, attempt) * 5000;
    logger.warn(`Anikoto 429 (percobaan ${attempt + 1}), retry dalam ${Math.round(waitMs / 1000)} dtk`);
    await sleep(waitMs);
    return fetchJson(path, attempt + 1);
  }
  if (res.status === 403) {
    throw new AnikotoError(403, 'Anikoto menolak permintaan (403 — IP mungkin dibatasi). Coba lagi nanti.');
  }
  if (res.status === 404) {
    throw new AnikotoError(404, 'Data tidak ditemukan di Anikoto.');
  }
  if (!res.ok) {
    // v1.2.0: 5xx juga gangguan sesaat — retry seperti di atas.
    // 4xx lain (400/401/dll) bukan gangguan sesaat: langsung lempar.
    if (res.status >= 500 && attempt < config.MAX_RETRIES_TRANSIENT) {
      const waitMs = Math.pow(2, attempt) * 2000;
      logger.warn(`Anikoto galat ${res.status}, retry ${attempt + 1} dalam ${waitMs / 1000} dtk`);
      await sleep(waitMs);
      return fetchJson(path, attempt + 1);
    }
    throw new AnikotoError(res.status, `Anikoto mengembalikan galat ${res.status}.`);
  }
  const body = await res.json();
  if (body && body.ok === false) {
    throw new AnikotoError(res.status, 'Anikoto mengembalikan ok: false.');
  }
  return body;
}

// Semua request lewat antrean ini agar rate limiter tidak bisa dilanggar
// oleh dua endpoint yang dipanggil bersamaan.
function queued(path) {
  const run = queue.then(async () => {
    await acquireSlot();
    return fetchJson(path);
  });
  // Rantai tetap jalan walau satu request gagal.
  queue = run.catch(() => {});
  return run;
}

async function getRecentAnime(page = 1, perPage = 20) {
  return queued(`/recent-anime?page=${page}&per_page=${perPage}`);
}

async function getSeries(id) {
  return queued(`/series/${id}`);
}

module.exports = { getRecentAnime, getSeries, AnikotoError };
