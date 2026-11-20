'use strict';
// Entry point Mitsunime: satu proses Node menyajikan frontend statis
// (public/) DAN API sendiri (/api/* + rute admin tersembunyi).
// Tanpa dependensi npm — hanya modul bawaan Node (http + node:sqlite),
// supaya pasti jalan di Termux HP tanpa node-gyp dan tanpa instalasi berat.
// Jalankan: node server/server.js  →  buka http://localhost:3000
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const logger = require('./utils/logger');
const database = require('./db/database');
const mwAuth = require('./middleware/auth');
const adminPath = require('./middleware/adminPath');
const publicApi = require('./routes/public');
const hdApi = require('./routes/hd');
const accountApi = require('./routes/account');
const premiumApi = require('./routes/premium');
const accessoriesApi = require('./routes/accessories');
const adminApi = require('./routes/admin');
const { handleHealth } = require('./routes/health');
const { autoSeedAdmin } = require('./services/adminSeed');
const { syncLight } = require('./services/sync');

// L-03: jangan biarkan satu galat tak tertangani mematikan server
// diam-diam. Catat galatnya (dengan stack bila ada) dan biarkan proses
// tetap jalan — server ini dipakai di localhost Termux dan harus pulih
// sendiri dari kesalahan sementara; galat yang fatal tetap terlihat di log.
process.on('uncaughtException', (e) => {
  logger.error(`uncaughtException (server tetap jalan): ${e && e.stack ? e.stack : String(e)}`);
});
process.on('unhandledRejection', (reason) => {
  logger.error(`unhandledRejection (server tetap jalan): ${reason && reason.stack ? reason.stack : String(reason)}`);
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 64 * 1024; // 64 KB — cukup untuk semua payload API kami
// Batas lebih besar HANYA untuk endpoint unggah gambar (base64 di JSON):
// buat transaksi manual (bukti bayar) + unggah kode QRIS admin. Gambar
// maksimal 2 MB hasil decode (±2,7 MB base64 + JSON), jadi 4 MB cukup.
// Endpoint lain tetap 64 KB.
const MAX_UPLOAD_BODY_BYTES = 4 * 1024 * 1024;
function isUploadPath(pathname) {
  return pathname === '/api/premium/transactions/manual'
    || pathname.endsWith('/api/settings/qris');
}

// Baca body JSON untuk POST/PUT. Bila kosong → req.body = null.
// Body bukan JSON atau melebihi batas → 400/413, dan handler mengembalikan
// false supaya server.js mengirim respons error (bukan melanjutkan).
function readJsonBody(req, res, pathname) {
  const limit = isUploadPath(pathname) ? MAX_UPLOAD_BODY_BYTES : MAX_BODY_BYTES;
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { tooBig = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: 'Data yang dikirim terlalu besar.' }));
        return resolve(false);
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) { req.body = null; return resolve(true); }
      try {
        req.body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: 'Data yang dikirim bukan JSON yang valid.' }));
        return resolve(false);
      }
      resolve(true);
    });
    req.on('error', () => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, message: 'Gagal membaca data yang dikirim.' }));
      resolve(false);
    });
  });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  // admin.html TIDAK PERNAH dilayani sebagai file statis publik — hanya
  // lewat rute admin tersembunyi (routes/admin.js). Minta /admin.html
  // langsung → 404 biasa, tanpa petunjuk.
  if (rel === '/admin.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Tidak ditemukan.');
    return true;
  }
  // Cegah path traversal: hasil resolve harus tetap di dalam public/.
  const file = path.resolve(config.PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(config.PUBLIC_DIR + path.sep) && file !== config.PUBLIC_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Akses ditolak.');
    return true;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  // SEMUA file statis no-store (v1.3.3, S-05): HTML baru + JS lama (campuran
  // versi) pernah merusak halaman tonton di proyek lama, jadi jangan cache
  // apa pun di sini; no-store (bukan no-cache) juga mencegah halaman profil
  // dipulihkan dari cache sesudah logout. Server ini hanya dipakai di
  // localhost, jadi no-store tidak merugikan.
  // L-03: header baru ditulis saat stream terbuka, dan stream WAJIB punya
  // handler 'error' — berkas yang lenyap di antara stat dan open tidak
  // boleh mematikan proses; jawab 404 bila hilang, 500 bila gagal lain.
  const stream = fs.createReadStream(file);
  stream.on('error', (e) => {
    logger.warn(`Gagal mengirim berkas statis ${file}: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Tidak ditemukan.');
    } else if (!res.writableEnded) {
      res.end();
    }
  });
  stream.on('open', () => {
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    stream.pipe(res);
  });
  res.on('error', () => stream.destroy());
  return true;
}

// robots.txt: SENGAJA tidak memuat ADMIN_PATH — menuliskannya di sini
// sama saja membocorkan alamat dashboard ke siapa pun yang membacanya.
// Anti-indeks untuk halaman admin dipasang lewat header X-Robots-Tag
// dan <meta name="robots"> di admin.html.
function serveRobots(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('User-agent: *\nDisallow: /api/\n');
  return true;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const finish = (status) => logger.request(req, status, Date.now() - started);
  const origEnd = res.end.bind(res);
  // Catat status saat respons selesai (untuk log request).
  res.end = (...args) => { finish(res.statusCode || 200); return origEnd(...args); };

  try {
    if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, message: 'Metode tidak diizinkan.' }));
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const okBody = await readJsonBody(req, res, url.pathname);
      if (!okBody) return;
    } else {
      req.body = null;
    }
    // Lampirkan pengguna bila cookie sesi valid (opsional — rute publik
    // tetap jalan tanpa sesi; rute yang butuh login menolak sendiri).
    mwAuth.attachUser(req);

    // Rute admin tersembunyi — dicek DULU, sebelum API publik dan statis.
    // Path yang salah bukan rute admin: bila mirip rute admin (awalan
    // "/a-") tetapi tokennya salah → 404 biasa, BUKAN fallback ke
    // index.html (halaman publik tidak punya rute /a-*, jadi /a- yang
    // salah hampir pasti alamat admin yang salah ketik; jangan sajikan
    // beranda untuknya, dan jangan beri petunjuk apa pun).
    if (adminPath.isAdminPath(url.pathname)) {
      const handled = await adminApi.route(req, res, url);
      if (handled) return;
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, message: 'Tidak ditemukan.' }));
    }
    if (url.pathname.startsWith('/a-')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Tidak ditemukan.');
    }
    if (url.pathname === '/api/health') return handleHealth(req, res);
    if (url.pathname === '/robots.txt') return serveRobots(req, res);
    if (url.pathname.startsWith('/api/')) {
      const routers = [accountApi, premiumApi, accessoriesApi, publicApi, hdApi];
      for (const r of routers) {
        const handled = await r.route(req, res, url);
        if (handled) return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, message: 'Endpoint tidak ditemukan.' }));
    }
    if (!serveStatic(req, res, url)) {
      // File statis yang jelas-jelas dicari (css/js/img) → 404.
      if (/\.(css|js|png|jpg|jpeg|webp|svg|ico|json)$/i.test(url.pathname)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Tidak ditemukan.');
      }
      const index = path.join(config.PUBLIC_DIR, 'index.html');
      if (fs.existsSync(index)) {
        // L-03: seperti serveStatic — header saat stream terbuka, handler
        // 'error' supaya berkas yang lenyap tidak mematikan proses.
        const stream = fs.createReadStream(index);
        stream.on('error', (e) => {
          logger.warn(`Gagal mengirim index.html: ${e.message}`);
          if (!res.headersSent) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Tidak ditemukan.');
          } else if (!res.writableEnded) {
            res.end();
          }
        });
        stream.on('open', () => {
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
          stream.pipe(res);
        });
        res.on('error', () => stream.destroy());
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Tidak ditemukan.');
    }
  } catch (e) {
    logger.error(`Galat server: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, message: 'Terjadi kesalahan di server. Coba muat ulang.' }));
    }
  }
});

database.init();

// v1.3.0: auto-seed admin dari ADMIN_USER/ADMIN_PASS di .env bila belum
// ada admin (lewat diam-diam bila salah satu kosong; seed-admin.js CLI
// tetap berfungsi seperti biasa).
autoSeedAdmin();

server.listen(config.PORT, config.HOST, () => {
  logger.info(`Mitsunime jalan di http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`);
  logger.info(`Anikoto: ${config.ANIKOTO_BASE_URL} | Cache: ${config.DB_PATH}`);
  if (config.ADMIN_PATH) {
    logger.info('Rute admin aktif (alamat hanya dari .env, tidak ditampilkan di log).');
  } else {
    logger.warn('ADMIN_PATH kosong di .env — rute admin TIDAK hidup. Isi ADMIN_PATH lalu jalankan ulang.');
  }
  logger.info(`Gateway: ${config.PAYMENT_GATEWAY}${config.MIDTRANS_SERVER_KEY ? '' : ' (kunci Midtrans belum diisi — pembayaran akan menolak dengan 503)'}`);
  logger.info('Tekan Ctrl+C untuk berhenti.');
  // v1.5.1 (§10): sync katalog ringan otomatis di dalam proses server —
  // sekali saat start (fire-and-forget, tidak memblokir listen) + interval
  // tiap AUTO_SYNC_INTERVAL_MINUTES menit. Guard anti-tumpang-tindih:
  // bila jalan sebelumnya masih aktif, jadwal itu dilewati. Semua error
  // sync hanya dicatat ke log — sync tidak pernah menjatuhkan server.
  if (config.AUTO_SYNC) {
    let syncRunning = false;
    const runAutoSync = async (reason) => {
      if (syncRunning) {
        logger.info(`Sync otomatis (${reason}): jalan sebelumnya masih aktif, dilewati`);
        return;
      }
      syncRunning = true;
      try {
        await syncLight();
      } catch (e) {
        logger.error(`Sync otomatis (${reason}) gagal: ${e && e.message ? e.message : String(e)}`);
      } finally {
        syncRunning = false;
      }
    };
    runAutoSync('startup');
    setInterval(
      () => runAutoSync('interval'),
      config.AUTO_SYNC_INTERVAL_MINUTES * 60 * 1000,
    ).unref();
  }
});

function shutdown() {
  logger.info('Mematikan server...');
  server.close(() => { database.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
