'use strict';
// GET /api/health — dipakai smoke test dan pemantauan.
// Mengembalikan kondisi server + jumlah judul di cache (0 bila belum sync).
const cache = require('../services/cache');
const mailer = require('../services/mailer');

function handleHealth(req, res) {
  const payload = JSON.stringify({
    ok: true,
    service: 'mitsunime',
    time: new Date().toISOString(),
    // v1.3.3: hanya boolean terkonfigurasi — TANPA host/user/pass.
    email: { configured: mailer.isConfigured() },
    catalog: { indexed: cache.countAnime() },
    // M4: status Anikoto terakhir yang tercatat (null bila belum pernah
    // dicatat) — untuk pemantauan, bukan klaim "Anikoto mati" dari umur cache.
    anikoto: cache.lastAnikotoStatus(),
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

module.exports = { handleHealth };
