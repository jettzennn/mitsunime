'use strict';
// sync-cron.js — job sinkronisasi berkala untuk cron Termux atau jalan manual.
//   node scripts/sync-cron.js            → sapuan ringan (halaman 1–5, episode terbaru)
//   node scripts/sync-cron.js --full     → sapuan penuh seluruh katalog (~94 halaman)
//   node scripts/sync-cron.js --pages 20 → sapu 20 halaman pertama
// Rate limiter di services/anikoto.js yang mengatur jeda — script ini
// cukup memanggil berurutan. Halaman yang sudah disapu dan masih segar
// dilewati (lihat crawl_state), jadi jalan kedua tidak mengulang sia-sia.
const config = require('../server/config');
const database = require('../server/db/database');
const sync = require('../server/services/sync');
const logger = require('../server/utils/logger');

function parseArgs() {
  const args = process.argv.slice(2);
  let full = false;
  let pages = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--full') full = true;
    if (args[i] === '--pages' && args[i + 1]) {
      pages = Math.max(1, Number.parseInt(args[i + 1], 10) || 0);
    }
  }
  return { full, pages };
}

async function main() {
  const { full, pages } = parseArgs();
  database.init();
  const t0 = Date.now();
  if (full) {
    const stats = await sync.syncFull();
    logger.info(`Sync penuh selesai (${stats.durationSec} dtk di job): ${stats.itemsUpserted} judul`);
  } else if (pages > 0) {
    const stats = await sync.syncRecentPages(1, pages);
    logger.info(`Sync ${pages} halaman selesai: ${stats.itemsUpserted} judul, ${stats.pagesSkipped} halaman dilewati`);
  } else {
    const stats = await sync.syncLight();
    logger.info(`Sync ringan selesai: ${stats.itemsUpserted} judul, ${stats.pagesSkipped} halaman dilewati`);
  }
  logger.info(`Total waktu jalan: ${Math.round((Date.now() - t0) / 1000)} dtk`);
  database.close();
}

main().catch((e) => { logger.error(`Sync gagal: ${e.message}`); process.exit(1); });
