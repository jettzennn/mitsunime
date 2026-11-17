'use strict';
// seed-cache.js — isi cache awal: sapu halaman /recent-anime (per_page=100).
// Jalankan sekali sesudah server pertama hidup:
//   node scripts/seed-cache.js                (50 halaman = ±5.000 judul)
//   node scripts/seed-cache.js --pages 95     (sapuan penuh ±9.400 judul)
//   node scripts/seed-cache.js --pages 3      (coba cepat: 300 judul)
// Rate limiter di services/anikoto.js yang mengatur jeda — script ini
// cukup memanggil berurutan. Halaman yang sudah disapu hari ini akan
// dilewati bila masih segar (lihat crawl_state).
const config = require('../server/config');
const database = require('../server/db/database');
const sync = require('../server/services/sync');
const cache = require('../server/services/cache');
const logger = require('../server/utils/logger');

function parseArgs() {
  const args = process.argv.slice(2);
  let pages = config.SEED_PAGES;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pages' && args[i + 1]) {
      pages = Math.max(1, Number.parseInt(args[i + 1], 10) || pages);
    }
    if (args[i] === '--per-page' && args[i + 1]) {
      // Maksimal 100 per halaman (batas wajar API); lebih dari itu ditolak API.
      config.SEED_PER_PAGE = Math.min(100, Math.max(1, Number.parseInt(args[i + 1], 10) || 100));
    }
  }
  return { pages };
}

async function main() {
  const { pages } = parseArgs();
  database.init();
  const before = cache.countAnime();
  logger.info(`Seed cache: ${pages} halaman x ${config.SEED_PER_PAGE} judul (sudah ada ${before} judul di cache)`);
  const stats = await sync.syncRecentPages(1, pages, config.SEED_PER_PAGE);
  const after = cache.countAnime();
  logger.info(`Seed selesai: ${before} -> ${after} judul di cache (baru disapu: ${stats.itemsUpserted}, dilewati: ${stats.pagesSkipped})`);
  database.close();
}

main().catch((e) => { logger.error(`Seed gagal: ${e.message}`); process.exit(1); });
