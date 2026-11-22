'use strict';
// API dashboard admin tersembunyi (task-08). Di-mount HANYA pada ADMIN_PATH
// dari .env (token acak); tidak ada tautan publik ke sini. Semua endpoint
// API di bawahnya wajib sesi admin (role = 'admin'). Setiap aksi yang
// mengubah data tercatat di admin_audit_log.
//
// Keamanan:
// - Path salah → 404 biasa (ditangani server.js, tanpa petunjuk rute admin).
// - Tanpa sesi admin → 401/403 generik.
// - robots.txt SENGAJA tidak memuat path admin (akan membocorkannya);
//   anti-indeks dipasang lewat header X-Robots-Tag + <meta name="robots">
//   di admin.html.
// - Login admin memakai rate limit yang sama dengan login biasa.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const dbModule = require('../db/database');
const logger = require('../utils/logger');
const auth = require('../services/auth');
const mw = require('../middleware/auth');
const emailVerification = require('../services/emailVerification');
const levels = require('../services/levels');
const cache = require('../services/cache');
const adminPath = require('../middleware/adminPath');

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
function err(res, status, message) { return send(res, status, { ok: false, message }); }
function bodyOf(req) {
  return (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
}
function nowSec() { return Math.floor(Date.now() / 1000); }

function parsePage(url) {
  const q = url.searchParams;
  const page = Math.max(1, Number.parseInt(q.get('page'), 10) || 1);
  const perPage = Math.min(50, Math.max(1, Number.parseInt(q.get('per_page'), 10) || 20));
  return { page, perPage };
}

function audit(adminId, action, targetType, targetId, detail) {
  dbModule.get().prepare(
    `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(adminId, action, targetType || null, targetId == null ? null : String(targetId),
    detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)), nowSec());
}

function requireAdmin(req, res) {
  return mw.requireAdmin(req, res);
}

// --- Halaman admin (HTML) ---
// GET {ADMIN_PATH}/ → admin.html. BUKAN file statis publik: server.js
// memblokir /admin.html, dan file ini hanya disajikan lewat rute ini,
// dengan header noindex. Isi halaman dibangun Frontend (task-13);
// sementara ini placeholder.
function handleAdminPage(req, res) {
  const file = path.join(config.PUBLIC_DIR, 'admin.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Tidak ditemukan.'), true;
  }
  // L-03: seperti sendImage — header saat stream terbuka, handler 'error'
  // supaya berkas yang lenyap di tengah pembacaan tidak mematikan proses.
  const stream = fs.createReadStream(file);
  stream.on('error', (e) => {
    logger.warn(`Gagal mengirim admin.html: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Tidak ditemukan.');
    } else if (!res.writableEnded) {
      res.end();
    }
  });
  stream.on('open', () => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    stream.pipe(res);
  });
  res.on('error', () => stream.destroy());
  return true;
}

// --- Login admin ---
// POST {ADMIN_PATH}/api/login { username, password } (akun admin hanya
// dibuat lewat CLI seed-admin.js atau auto-seed dari .env (v1.3.0);
// endpoint publik TIDAK bisa membuat admin).
function handleAdminLogin(req, res) {
  const ip = mw.clientIp(req);
  if (mw.loginBlocked(ip)) {
    return err(res, 429, 'Terlalu banyak percobaan login. Coba lagi 15 menit lagi.');
  }
  const b = bodyOf(req);
  // v1.4.6: kolom `username` diperlakukan sebagai PENGENAL — bila
  // mengandung '@' cari by email, bila tidak by username. Pesan galat
  // tetap generik (tanpa oracle akun ada / email terdaftar).
  const identifier = typeof b.username === 'string' ? b.username.trim() : '';
  const password = b.password;
  const user = identifier
    ? (identifier.includes('@') ? auth.findUserByEmail(identifier) : auth.findUserByUsername(identifier))
    : null;
  const ok = user && user.role === 'admin'
    && typeof password === 'string' && auth.verifyPassword(password, user.password_hash);
  if (!ok) {
    mw.recordLoginFail(ip);
    return err(res, 401, 'Username atau password salah.');
  }
  mw.recordLoginOk(ip);
  const token = auth.createSession(user.id);
  // v1.3.1 (G): login admin memakai cookie sesi admin yang BERBEDA —
  // tidak menimpa cookie sesi user biasa di browser yang sama.
  auth.setAdminSessionCookie(res, token);
  auth.touchLastLogin(user.id);
  const pub = auth.publicUser(user);
  return send(res, 200, { ok: true, user: pub, message: 'Login admin berhasil.' });
}

function handleAdminLogout(req, res) {
  mw.attachUser(req);
  if (req.adminSessionToken) {
    // Logout admin hanya menghapus sesi + cookie admin; sesi user
    // biasa di browser yang sama tetap utuh (v1.3.1 G).
    auth.deleteSession(req.adminSessionToken);
    auth.clearAdminSessionCookie(res);
  } else if (req.sessionToken && req.user && req.user.role === 'admin') {
    // Admin yang masuk lewat form login biasa: sesinya ada di cookie
    // user — hapus sesi itu (tidak ada cookie admin yang dihapus).
    auth.deleteSession(req.sessionToken);
    auth.clearSessionCookie(res);
  }
  return send(res, 200, { ok: true, message: 'Anda sudah keluar.' });
}

function handleAdminMe(req, res) {
  if (!requireAdmin(req, res)) return true;
  // Level + EXP (v1.3.1): admin selalu level 1000.
  return send(res, 200, { ok: true, user: req.user, level: levels.levelInfo(req.user) });
}

// --- Ringkasan ---
function handleSummary(req, res) {
  if (!requireAdmin(req, res)) return true;
  const db = dbModule.get();
  const usersCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const catalog = cache.countAnime();
  return send(res, 200, {
    ok: true,
    data: {
      users: usersCount,
      catalog_titles: catalog,
      // v1.3.0: status verifikasi email OTP — dashboard menampilkan
      // peringatan bila SMTP belum dikonfigurasi (verifikasi nonaktif).
      email_verification: emailVerification.verificationStatus(),
    },
  });
}

// --- Pengguna ---
function handleListUsers(req, res, url) {
  if (!requireAdmin(req, res)) return true;
  const search = (url.searchParams.get('search') || '').trim();
  const { page, perPage } = parsePage(url);
  const db = dbModule.get();
  const where = search ? 'WHERE username LIKE ? OR email LIKE ?' : '';
  const like = `%${search.replace(/[%_]/g, '')}%`;
  const params = search ? [like, like] : [];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM users ${where}`).get(...params).c;
  const rows = db.prepare(
    `SELECT id, username, email, role, exp_total, created_at, last_login_at
     FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).all(...params, perPage, (page - 1) * perPage);
  return send(res, 200, {
    ok: true,
    // Level + EXP (v1.3.1) per pengguna; admin selalu level 1000.
    data: rows.map((r) => ({ ...r, level: levels.levelInfo(r) })),
    pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    total,
  });
}

// --- Judul (flag admin) ---
// POST {ADMIN_PATH}/api/anime/:id/flags { sub_indo? }
// sub_indo = 1 hanya bila admin sudah memverifikasi Sub Indo secara manual.
function handleAnimeFlags(req, res, idRaw) {
  if (!requireAdmin(req, res)) return true;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) return err(res, 404, 'Anime tidak ditemukan di katalog.');
  const b = bodyOf(req);
  const patch = {};
  if (b.sub_indo !== undefined) {
    if (b.sub_indo !== 0 && b.sub_indo !== 1 && b.sub_indo !== true && b.sub_indo !== false) {
      return err(res, 400, 'sub_indo harus 0 atau 1.');
    }
    patch.sub_indo = b.sub_indo ? 1 : 0;
  }
  if (!Object.keys(patch).length) {
    return err(res, 400, 'Tidak ada flag yang diubah.');
  }
  const flags = cache.setAnimeFlags(id, patch);
  if (!flags) return err(res, 404, 'Anime tidak ditemukan di katalog.');
  audit(req.user.id, 'flag_anime', 'anime', id, patch);
  return send(res, 200, {
    ok: true, anime_id: id, flags,
    message: 'Flag anime diperbarui.',
  });
}

// --- Audit log ---
function handleAudit(req, res, url) {
  if (!requireAdmin(req, res)) return true;
  const { page, perPage } = parsePage(url);
  const db = dbModule.get();
  const total = db.prepare('SELECT COUNT(*) AS c FROM admin_audit_log').get().c;
  const rows = db.prepare(
    `SELECT a.*, u.username AS admin_username FROM admin_audit_log a
     LEFT JOIN users u ON u.id = a.admin_user_id
     ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
  ).all(perPage, (page - 1) * perPage);
  return send(res, 200, {
    ok: true, data: rows,
    pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    total,
  });
}

// Router admin — HANYA dipanggil server.js bila path cocok ADMIN_PATH.
// Mengembalikan true bila dikenali.
function route(req, res, url) {
  const sub = adminPath.adminSubPath(url.pathname);
  if (sub === null) return false;
  if (sub === '/' && req.method === 'GET') return handleAdminPage(req, res);
  if (sub === '/api/login' && req.method === 'POST') return handleAdminLogin(req, res);
  if (sub === '/api/logout' && req.method === 'POST') return handleAdminLogout(req, res);
  // M3: aksi tulis admin (ubah flag) — 60 aksi per admin per 5 menit.
  // Login/logout tidak dibatasi di sini (login sudah memakai batas login);
  // yang bukan admin tidak menghabiskan batas (handler menolak 401/403).
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    mw.attachUser(req);
    // v1.3.1 (G): admin bisa datang dari cookie admin maupun cookie user.
    const adminEff = req.adminUser || (req.user && req.user.role === 'admin' ? req.user : null);
    if (adminEff) {
      if (!mw.enforceRateLimit(req, res, `admin-write:${adminEff.id}`, 60, 5 * 60 * 1000,
        'Terlalu banyak aksi admin. Coba lagi sebentar lagi.')) return true;
    }
  }
  if (sub === '/api/me' && req.method === 'GET') return handleAdminMe(req, res);
  if (sub === '/api/summary' && req.method === 'GET') return handleSummary(req, res);
  if (sub === '/api/users' && req.method === 'GET') return handleListUsers(req, res, url);
  const flagsMatch = sub.match(/^\/api\/anime\/(\d+)\/flags$/);
  if (flagsMatch && req.method === 'POST') return handleAnimeFlags(req, res, flagsMatch[1]);
  if (sub === '/api/audit' && req.method === 'GET') return handleAudit(req, res, url);
  // Path admin yang dikenal polanya tetapi endpoint tidak ada → 404 generik.
  return err(res, 404, 'Tidak ditemukan.');
}

module.exports = { route, send, err };
