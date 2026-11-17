'use strict';
// Job sinkronisasi /recent-anime -> SQLite + FTS5 (PRD task-04).
// Anikoto hanya punya endpoint daftar terbaru, jadi katalog lengkap
// disusun dengan menyapu halaman /recent-anime berurutan (per_page=100).
// Rate limit Anikoto (60 request / IP / 120 detik) ditahan oleh antrean
// di services/anikoto.js — job ini cukup memanggil berurutan.
// Progres dicatat di crawl_state supaya jalan berikutnya tidak mengulang
// halaman yang sudah tersimpan dan supaya sapuan yang terputus bisa lanjut.
// Halaman yang sudah disapu dan masih segar (dalam TTL recent) dilewati.
const config = require('../config');
const logger = require('../utils/logger');
const anikoto = require('./anikoto');
const cache = require('./cache');

const PER_PAGE = 100;

function pageKey(page) {
  return `recent-anime:page:${page}`;
}

function pageIsFresh(page) {
  const cachedAt = Number.parseInt(cache.getState(pageKey(page)), 10) || 0;
  return cachedAt && (cache.nowSec() - cachedAt) <= config.RECENT_TTL_SECONDS;
}

// Sapu satu rentang halaman. Mengembalikan statistik jalan ini.
async function syncRecentPages(fromPage, toPage, perPage = PER_PAGE) {
  const stats = { pagesFetched: 0, pagesSkipped: 0, itemsUpserted: 0, stoppedAtPage: 0 };
  for (let page = fromPage; page <= toPage; page++) {
    if (pageIsFresh(page)) {
      stats.pagesSkipped += 1;
      logger.info(`Sync: halaman ${page} sudah segar, dilewati`);
      continue;
    }
    let body;
    try {
      body = await anikoto.getRecentAnime(page, perPage);
      cache.recordAnikotoStatus(true, 200, null);
    } catch (e) {
      cache.recordAnikotoStatus(false, e.status || 0, e.message);
      logger.error(`Sync: halaman ${page} gagal (${e.message}) — berhenti, progres tersimpan`);
      stats.stoppedAtPage = page - 1;
      break;
    }
    const items = Array.isArray(body.data) ? body.data : [];
    if (!items.length) {
      logger.warn(`Sync: halaman ${page} kosong — katalog selesai di halaman ${page - 1}`);
      cache.setState('recent-anime:completed_at', String(cache.nowSec()));
      stats.stoppedAtPage = page - 1;
      break;
    }
    cache.upsertMany(items);
    cache.setState(pageKey(page), String(cache.nowSec()));
    cache.setState('recent-anime:last_page', String(page));
    stats.pagesFetched += 1;
    stats.itemsUpserted += items.length;
    logger.info(`Sync: halaman ${page} +${items.length} judul (total jalan ${stats.itemsUpserted})`);
  }
  return stats;
}

// Sapuan penuh: ambil halaman 1 dulu untuk mengetahui total katalog,
// lalu sapu semua halaman sampai selesai. Jalan kedua tidak mengulang
// halaman yang sudah tersimpan (stempel segar di crawl_state): bila total
// katalog sudah tersimpan dan sapuan terakhir masih segar, halaman 1 pun
// tidak diambil ulang.
async function syncFull(perPage = PER_PAGE) {
  const started = Date.now();
  logger.info('Sync penuh dimulai');
  const storedTotal = Number.parseInt(cache.getState('recent-anime:total'), 10) || 0;
  const completedAt = Number.parseInt(cache.getState('recent-anime:completed_at'), 10) || 0;
  const completedFresh = completedAt && (cache.nowSec() - completedAt) <= config.RECENT_TTL_SECONDS;
  if (storedTotal > 0 && completedFresh) {
    const totalPages = Math.max(1, Math.ceil(storedTotal / perPage));
    logger.info(`Sync penuh: total ${storedTotal} judul sudah tersimpan dan segar, cek ulang halaman tanpa ambil ulang`);
    const rest = await syncRecentPages(1, totalPages, perPage);
    const stats = {
      totalPages, totalKnown: storedTotal,
      pagesFetched: rest.pagesFetched, pagesSkipped: rest.pagesSkipped,
      itemsUpserted: rest.itemsUpserted,
      durationSec: Math.round((Date.now() - started) / 1000),
    };
    logger.info(`Sync penuh selesai: ${stats.pagesFetched} halaman diambil, ${stats.pagesSkipped} dilewati, ${stats.itemsUpserted} judul, ${stats.durationSec} dtk`);
    return stats;
  }
  // Halaman 1 dulu: pelajari total katalog dari pagination API.
  const first = await anikoto.getRecentAnime(1, perPage);
  const firstItems = Array.isArray(first.data) ? first.data : [];
  if (!firstItems.length) {
    throw new Error('Anikoto mengembalikan halaman 1 kosong; sync penuh dibatalkan.');
  }
  cache.upsertMany(firstItems);
  cache.setState(pageKey(1), String(cache.nowSec()));
  cache.setState('recent-anime:last_page', '1');
  let totalKnown = firstItems.length;
  const pagination = first.pagination || first.meta || null;
  if (pagination && Number.isFinite(Number(pagination.total))) {
    totalKnown = Number(pagination.total);
    cache.setState('recent-anime:total', String(totalKnown));
  }
  const totalPages = Math.max(1, Math.ceil(totalKnown / perPage));
  logger.info(`Sync penuh: total katalog ${totalKnown} judul, ${totalPages} halaman (per_page=${perPage})`);
  const rest = await syncRecentPages(2, totalPages, perPage);
  const stats = {
    totalPages,
    totalKnown,
    pagesFetched: rest.pagesFetched + 1,
    pagesSkipped: rest.pagesSkipped,
    itemsUpserted: rest.itemsUpserted + firstItems.length,
    durationSec: Math.round((Date.now() - started) / 1000),
  };
  cache.setState('recent-anime:completed_at', String(cache.nowSec()));
  logger.info(`Sync penuh selesai: ${stats.pagesFetched} halaman, ${stats.itemsUpserted} judul, ${stats.durationSec} dtk`);
  return stats;
}

// Sapuan ringan: halaman 1-5 saja (episode terbaru) — untuk cron per jam.
async function syncLight(perPage = PER_PAGE) {
  logger.info('Sync ringan dimulai (halaman 1-5)');
  const stats = await syncRecentPages(1, config.SYNC_LIGHT_PAGES, perPage);
  logger.info(`Sync ringan selesai: ${stats.pagesFetched} halaman diambil, ${stats.pagesSkipped} dilewati, ${stats.itemsUpserted} judul`);
  return stats;
}

module.exports = { syncRecentPages, syncFull, syncLight, PER_PAGE };
