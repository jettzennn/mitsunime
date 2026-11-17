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
const premium = require('../services/premium');
const accessories = require('../services/accessories');
const manualPayment = require('../services/manualPayment');
const emailVerification = require('../services/emailVerification');
const discounts = require('../services/discounts');
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
  const pendingTx = db.prepare(
    "SELECT COUNT(*) AS c FROM premium_transactions WHERE status = 'pending'",
  ).get().c;
  const paidAwaiting = db.prepare(
    "SELECT COUNT(*) AS c FROM premium_transactions WHERE status = 'pending' AND payment_status = 'paid'",
  ).get().c;
  const usersCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const premiumCount = db.prepare(
    'SELECT COUNT(*) AS c FROM users WHERE is_premium = 1 AND premium_until > ?',
  ).get(nowSec()).c;
  const catalog = cache.countAnime();
  return send(res, 200, {
    ok: true,
    data: {
      pending_transactions: pendingTx,
      paid_awaiting_approval: paidAwaiting,
      users: usersCount,
      premium_active: premiumCount,
      catalog_titles: catalog,
      // v1.3.0: status verifikasi email OTP — dashboard menampilkan
      // peringatan bila SMTP belum dikonfigurasi (verifikasi nonaktif).
      email_verification: emailVerification.verificationStatus(),
    },
  });
}

// --- Transaksi ---
function txWithNames(row) {
  return {
    id: row.id, user_id: row.user_id, username: row.username || null,
    plan_id: row.plan_id, plan_name: row.plan_name || null,
    amount_idr: row.amount_idr, method: row.method,
    // v1.3.0: kode diskon + harga asli sebelum diskon (null bila tanpa kode).
    discount_code: row.discount_code || null,
    discount_percent: row.discount_percent ?? null,
    original_amount_idr: row.original_amount_idr ?? null,
    proof_ref: row.proof_ref, status: row.status,
    // Nama file bukti TIDAK PERNAH dikirim (tidak bisa ditebak dari luar);
    // admin mengambil gambarnya lewat /api/transactions/:id/proof.
    has_proof: Boolean(row.proof_file),
    payment_status: row.payment_status,
    gateway_order_id: row.gateway_order_id, gateway_status: row.gateway_status,
    payment_url: row.payment_url,
    created_at: row.created_at, decided_by: row.decided_by,
    decided_at: row.decided_at, note: row.note,
  };
}

function handleListTx(req, res, url) {
  if (!requireAdmin(req, res)) return true;
  const status = (url.searchParams.get('status') || 'pending').trim();
  const allowed = ['pending', 'approved', 'rejected', 'all'];
  if (!allowed.includes(status)) return err(res, 400, 'Parameter status tidak valid.');
  const { page, perPage } = parsePage(url);
  const db = dbModule.get();
  const where = status === 'all' ? '' : "WHERE t.status = ?";
  const params = status === 'all' ? [] : [status];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM premium_transactions t ${where}`).get(...params).c;
  const rows = db.prepare(
    `SELECT t.*, u.username, p.name AS plan_name FROM premium_transactions t
     LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN plans p ON p.id = t.plan_id
     ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
  ).all(...params, perPage, (page - 1) * perPage);
  return send(res, 200, {
    ok: true, data: rows.map(txWithNames),
    pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    total,
  });
}

// Setujui transaksi → pengguna jadi premium selama durasi paket.
// Peringatan (bukan penolakan) bila payment_status belum 'paid': admin
// memegang keputusan akhir — mis. bila bayar terverifikasi di luar
// webhook/confirm. Peringatan itu dikembalikan di respons.
function handleApproveTx(req, res, idRaw) {
  if (!requireAdmin(req, res)) return true;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) return err(res, 404, 'Transaksi tidak ditemukan.');
  const b = bodyOf(req);
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) : null;
  const db = dbModule.get();
  const tx = db.prepare('SELECT * FROM premium_transactions WHERE id = ?').get(id);
  if (!tx) return err(res, 404, 'Transaksi tidak ditemukan.');
  if (tx.status !== 'pending') {
    return err(res, 409, `Transaksi ini sudah ${tx.status === 'approved' ? 'disetujui' : 'ditolak'} sebelumnya.`);
  }
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(tx.plan_id);
  const durationDays = plan ? plan.duration_days : 30;
  // Tiering v1.2.0: grant memberi aksesori sesuai tier paket transaksi ini.
  const granted = premium.grantPremium(tx.user_id, durationDays, tx.plan_id);
  db.prepare(
    "UPDATE premium_transactions SET status = 'approved', decided_by = ?, decided_at = ?, note = ? WHERE id = ?",
  ).run(req.user.id, nowSec(), note, id);
  // Level + EXP (v1.3.1): pembelian memberi EXP sesuai durasi paket
  // (7 hari +100, 15 hari +250, 30 hari +500, custom durasi x 10).
  // Beri Premium langsung (handleSetUserPremium) TIDAK memberi EXP.
  const exp = levels.awardPurchaseExp(tx.user_id, durationDays);
  audit(req.user.id, 'approve_transaction', 'transaction', id, {
    user_id: tx.user_id, plan_id: tx.plan_id, amount_idr: tx.amount_idr,
    payment_status: tx.payment_status, premium_until: granted.premium_until, note,
    exp_awarded: exp.exp_gained,
  });
  logger.info(`Admin ${req.user.username} menyetujui transaksi #${id} (user ${tx.user_id}, premium sampai ${granted.premium_until})`);
  const body = {
    ok: true,
    transaction: txWithNames({ ...tx, status: 'approved', decided_by: req.user.id, decided_at: nowSec(), note,
      username: undefined, plan_name: plan ? plan.name : null }),
    premium_until: granted.premium_until,
    exp_awarded: exp.exp_gained,
    level: exp.level,
    leveled_up: exp.leveled_up,
    message: 'Transaksi disetujui. Pengguna sekarang Premium.',
  };
  if (tx.method === 'manual_qris') {
    // Verifikasi MANUAL (bukan gateway): payment_status 'unpaid' adalah
    // keadaan NORMAL untuk transaksi manual — tidak ada gateway yang
    // memverifikasi. Admin menyetujui berdasarkan bukti bayar + mutasi di
    // aplikasi pembayarannya sendiri. Ini BUKAN payment_warning gateway;
    // penandanya dibedakan supaya UI tidak salah menampilkannya sebagai
    // "bayar belum terverifikasi Midtrans".
    body.manual_verification = true;
    body.proof_present = Boolean(tx.proof_file);
    body.verification_note = 'Verifikasi manual: pembayaran dicek sendiri oleh admin berdasarkan bukti bayar dan mutasi di aplikasi pembayaran (tidak ada verifikasi gateway). Pastikan bukti sudah diperiksa sebelum menyetujui.';
  } else if (tx.payment_status !== 'paid') {
    body.payment_warning = `Perhatian: pembayaran di Midtrans belum terkonfirmasi (payment_status: ${tx.payment_status}). Anda menyetujui transaksi yang bayarnya belum terverifikasi gateway.`;
  }
  return send(res, 200, body);
}

function handleRejectTx(req, res, idRaw) {
  if (!requireAdmin(req, res)) return true;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) return err(res, 404, 'Transaksi tidak ditemukan.');
  const b = bodyOf(req);
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) : null;
  const db = dbModule.get();
  const tx = db.prepare('SELECT * FROM premium_transactions WHERE id = ?').get(id);
  if (!tx) return err(res, 404, 'Transaksi tidak ditemukan.');
  if (tx.status !== 'pending') {
    return err(res, 409, `Transaksi ini sudah ${tx.status === 'approved' ? 'disetujui' : 'ditolak'} sebelumnya.`);
  }
  db.prepare(
    "UPDATE premium_transactions SET status = 'rejected', decided_by = ?, decided_at = ?, note = ? WHERE id = ?",
  ).run(req.user.id, nowSec(), note, id);
  audit(req.user.id, 'reject_transaction', 'transaction', id, {
    user_id: tx.user_id, plan_id: tx.plan_id, amount_idr: tx.amount_idr,
    payment_status: tx.payment_status, note,
  });
  return send(res, 200, {
    ok: true,
    transaction: txWithNames({ ...tx, status: 'rejected', decided_by: req.user.id, decided_at: nowSec(), note }),
    message: 'Transaksi ditolak.',
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
    `SELECT id, username, email, role, is_premium, premium_until, exp_total, created_at, last_login_at
     FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).all(...params, perPage, (page - 1) * perPage);
  return send(res, 200, {
    ok: true,
    // Level + EXP (v1.3.1) per pengguna; admin selalu level 1000.
    data: rows.map((r) => ({ ...r, premium: premium.premiumInfo(r), level: levels.levelInfo(r) })),
    pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    total,
  });
}

// POST {ADMIN_PATH}/api/users/:id/premium { days } → beri premium manual;
// { revoke: true } → cabut premium.
function handleSetUserPremium(req, res, idRaw) {
  if (!requireAdmin(req, res)) return true;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) return err(res, 404, 'Pengguna tidak ditemukan.');
  const b = bodyOf(req);
  const user = auth.findUserById(id);
  if (!user) return err(res, 404, 'Pengguna tidak ditemukan.');
  if (b.revoke === true) {
    premium.revokePremium(id);
    audit(req.user.id, 'revoke_premium', 'user', id, { username: user.username });
    return send(res, 200, {
      ok: true, user: auth.publicUser(auth.findUserById(id)),
      message: `Premium ${user.username} dicabut.`,
    });
  }
  const days = Number.parseInt(b.days, 10);
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    return err(res, 400, 'Parameter days harus 1–3650 hari.');
  }
  // v1.3.1 (H): grant manual ikut tiering — bila days sama dengan
  // duration_days sebuah paket yang ada (7/15/30), aksesori mengikuti
  // tier paket itu (7→6, 15→9, 30→14) lewat plan_id paket tersebut.
  // Bila tidak cocok dengan paket mana pun (mis. 45 hari), grantPremium
  // tanpa plan_id memberi set penuh seperti dulu. Paket aktif
  // didahulukan bila ada dua paket dengan durasi yang sama.
  const planRow = dbModule.get().prepare(
    'SELECT id FROM plans WHERE duration_days = ? ORDER BY active DESC, id ASC LIMIT 1',
  ).get(days);
  const planId = planRow ? planRow.id : undefined;
  const granted = premium.grantPremium(id, days, planId);
  audit(req.user.id, 'set_premium', 'user', id, {
    username: user.username, days, plan_id: planId || null, premium_until: granted.premium_until,
  });
  return send(res, 200, {
    ok: true,
    user: auth.publicUser(auth.findUserById(id)),
    premium_until: granted.premium_until,
    message: `Premium ${user.username} aktif selama ${days} hari.`,
  });
}

// --- Judul (flag admin) ---
// POST {ADMIN_PATH}/api/anime/:id/flags { sub_indo?, premium_only? }
// premium_only disimpan SEBAGAI DATA SAJA dan tidak mengunci apa pun di v1
// (keputusan pengguna 2026-11-15 ~06:55 WIB). sub_indo = 1 hanya bila
// admin sudah memverifikasi Sub Indo secara manual.
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
  if (b.premium_only !== undefined) {
    if (b.premium_only !== 0 && b.premium_only !== 1 && b.premium_only !== true && b.premium_only !== false) {
      return err(res, 400, 'premium_only harus 0 atau 1.');
    }
    patch.premium_only = b.premium_only ? 1 : 0;
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
    note: patch.premium_only !== undefined
      ? 'Catatan: premium_only hanya data di v1 — tidak mengunci konten apa pun.'
      : undefined,
  });
}

// --- Paket (CRUD) ---
function validPlan(b) {
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const price = Number.parseInt(b.price_idr, 10);
  const days = Number.parseInt(b.duration_days, 10);
  const desc = typeof b.description === 'string' ? b.description.trim().slice(0, 500) : null;
  if (!name || name.length > 100) return { error: 'Nama paket 1–100 karakter.' };
  if (!Number.isFinite(price) || price < 0 || price > 100000000) {
    return { error: 'Harga harus 0–100.000.000 rupiah.' };
  }
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    return { error: 'Durasi harus 1–3650 hari.' };
  }
  return { name, price_idr: price, duration_days: days, description: desc || null };
}

function handleListPlans(req, res) {
  if (!requireAdmin(req, res)) return true;
  const rows = dbModule.get().prepare(
    'SELECT * FROM plans ORDER BY price_idr',
  ).all();
  // F-03: sertakan accessories per paket (tiering v1.2.0) supaya dashboard
  // admin bisa menampilkan rincian tier, sama seperti handler publik.
  const data = rows.map((p) => ({ ...p, accessories: accessories.listPlanAccessories(p.id) }));
  return send(res, 200, { ok: true, data, total: data.length });
}

function handleCreatePlan(req, res) {
  if (!requireAdmin(req, res)) return true;
  const v = validPlan(bodyOf(req));
  if (v.error) return err(res, 400, v.error);
  const db = dbModule.get();
  const info = db.prepare(
    'INSERT INTO plans (name, price_idr, duration_days, description, active) VALUES (?, ?, ?, ?, 1)',
  ).run(v.name, v.price_idr, v.duration_days, v.description);
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(info.lastInsertRowid);
  audit(req.user.id, 'plan_create', 'plan', row.id, { name: v.name, price_idr: v.price_idr, duration_days: v.duration_days });
  return send(res, 201, { ok: true, plan: row, message: 'Paket dibuat.' });
}

function handleUpdatePlan(req, res, idRaw) {
  if (!requireAdmin(req, res)) return true;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) return err(res, 404, 'Paket tidak ditemukan.');
  const b = bodyOf(req);
  const db = dbModule.get();
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!plan) return err(res, 404, 'Paket tidak ditemukan.');
  const patch = {};
  if (b.name !== undefined || b.price_idr !== undefined || b.duration_days !== undefined || b.description !== undefined) {
    const v = validPlan({
      name: b.name !== undefined ? b.name : plan.name,
      price_idr: b.price_idr !== undefined ? b.price_idr : plan.price_idr,
      duration_days: b.duration_days !== undefined ? b.duration_days : plan.duration_days,
      description: b.description !== undefined ? b.description : plan.description,
    });
    if (v.error) return err(res, 400, v.error);
    patch.name = v.name; patch.price_idr = v.price_idr;
    patch.duration_days = v.duration_days; patch.description = v.description;
  }
  if (b.active !== undefined) {
    if (b.active !== 0 && b.active !== 1 && b.active !== true && b.active !== false) {
      return err(res, 400, 'active harus 0 atau 1.');
    }
    patch.active = b.active ? 1 : 0;
  }
  if (!Object.keys(patch).length) return err(res, 400, 'Tidak ada perubahan.');
  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE plans SET ${sets} WHERE id = ?`).run(...Object.values(patch), id);
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  audit(req.user.id, 'plan_update', 'plan', id, patch);
  return send(res, 200, { ok: true, plan: row, message: 'Paket diperbarui.' });
}

function handleDeletePlan(req, res, idRaw) {
  if (!requireAdmin(req, res)) return true;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) return err(res, 404, 'Paket tidak ditemukan.');
  const db = dbModule.get();
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!plan) return err(res, 404, 'Paket tidak ditemukan.');
  const used = db.prepare('SELECT COUNT(*) AS c FROM premium_transactions WHERE plan_id = ?').get(id).c;
  if (used > 0) {
    // Paket yang sudah dipakai transaksi tidak dihapus — cukup nonaktifkan.
    db.prepare('UPDATE plans SET active = 0 WHERE id = ?').run(id);
    audit(req.user.id, 'plan_update', 'plan', id, { active: 0, reason: 'sudah dipakai transaksi, dinonaktifkan' });
    return send(res, 200, { ok: true, plan: { ...plan, active: 0 }, message: 'Paket sudah dipakai transaksi, jadi dinonaktifkan (bukan dihapus).' });
  }
  db.prepare('DELETE FROM plans WHERE id = ?').run(id);
  audit(req.user.id, 'plan_delete', 'plan', id, { name: plan.name });
  return send(res, 200, { ok: true, message: 'Paket dihapus.' });
}

// --- Kode diskon (v1.3.0) ---
// Kode 3-32 karakter huruf/angka (disimpan huruf besar), persen 1-99,
// plan_id null = semua paket, max_uses null = tanpa batas pakai,
// expires_at null = tidak kadaluarsa (terima epoch detik atau string
// tanggal ISO). Mengembalikan { error } bila tidak valid, atau nilai
// yang sudah dinormalisasi.
function validDiscount(b, isCreate) {
  const code = discounts.normalizeCode(b.code);
  if (isCreate && (!code || !discounts.CODE_RE.test(code))) {
    return { error: 'Kode diskon 3-32 karakter, hanya huruf dan angka (mis. HEMAT10).' };
  }
  if (code !== null && !discounts.CODE_RE.test(code)) {
    return { error: 'Kode diskon 3-32 karakter, hanya huruf dan angka (mis. HEMAT10).' };
  }
  const percent = b.percent !== undefined ? Number.parseInt(b.percent, 10) : undefined;
  if (percent !== undefined && (!Number.isFinite(percent) || percent < 1 || percent > 99)) {
    return { error: 'Persen diskon harus 1 sampai 99.' };
  }
  let planId = null;
  if (b.plan_id !== undefined && b.plan_id !== null) {
    planId = Number.parseInt(b.plan_id, 10);
    if (!Number.isFinite(planId) || planId <= 0) return { error: 'ID paket tidak valid.' };
    const plan = dbModule.get().prepare('SELECT id FROM plans WHERE id = ?').get(planId);
    if (!plan) return { error: 'Paket tidak ditemukan.' };
  }
  let maxUses = null;
  if (b.max_uses !== undefined && b.max_uses !== null) {
    maxUses = Number.parseInt(b.max_uses, 10);
    if (!Number.isFinite(maxUses) || maxUses < 1) return { error: 'Batas pakai minimal 1.' };
  }
  let expiresAt = null;
  if (b.expires_at !== undefined && b.expires_at !== null) {
    if (typeof b.expires_at === 'string' && b.expires_at.trim() !== '') {
      const ms = Date.parse(b.expires_at);
      if (!Number.isFinite(ms)) return { error: 'Tanggal kedaluwarsa tidak valid.' };
      expiresAt = Math.floor(ms / 1000);
    } else {
      expiresAt = Number.parseInt(b.expires_at, 10);
      if (!Number.isFinite(expiresAt) || expiresAt <= 0) return { error: 'Tanggal kedaluwarsa tidak valid.' };
    }
  }
  let active;
  if (b.active !== undefined) {
    if (b.active !== 0 && b.active !== 1 && b.active !== true && b.active !== false) {
      return { error: 'active harus 0 atau 1.' };
    }
    active = b.active ? 1 : 0;
  }
  return { code, percent, plan_id: planId, max_uses: maxUses, expires_at: expiresAt, active };
}

function handleListDiscounts(req, res) {
  if (!requireAdmin(req, res)) return true;
  const rows = discounts.listDiscounts();
  return send(res, 200, { ok: true, data: rows, total: rows.length });
}

function handleCreateDiscount(req, res) {
  if (!requireAdmin(req, res)) return true;
  const v = validDiscount(bodyOf(req), true);
  if (v.error) return err(res, 400, v.error);
  if (v.percent === undefined) return err(res, 400, 'Persen diskon wajib diisi.');
  let row;
  try {
    row = discounts.createDiscount({
      code: v.code, percent: v.percent, planId: v.plan_id,
      maxUses: v.max_uses, expiresAt: v.expires_at, active: v.active,
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return err(res, 409, 'Kode diskon sudah dipakai.');
    }
    throw e;
  }
  audit(req.user.id, 'discount_create', 'discount', row.id, { code: row.code, percent: row.percent, plan_id: row.plan_id });
  return send(res, 201, { ok: true, discount: row, message: 'Kode diskon dibuat.' });
}

function handleUpdateDiscount(req, res, idRaw) {
  if (!requireAdmin(req, res)) return true;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) return err(res, 404, 'Kode diskon tidak ditemukan.');
  const b = bodyOf(req);
  const existing = discounts.getDiscount(id);
  if (!existing) return err(res, 404, 'Kode diskon tidak ditemukan.');
  const merged = {
    code: b.code !== undefined ? b.code : existing.code,
    percent: b.percent !== undefined ? b.percent : existing.percent,
    plan_id: b.plan_id !== undefined ? b.plan_id : existing.plan_id,
    max_uses: b.max_uses !== undefined ? b.max_uses : existing.max_uses,
    expires_at: b.expires_at !== undefined ? b.expires_at : existing.expires_at,
    active: b.active !== undefined ? b.active : existing.active,
  };
  const v = validDiscount(merged, false);
  if (v.error) return err(res, 400, v.error);
  let row;
  try {
    row = discounts.updateDiscount(id, {
      code: v.code, percent: v.percent, plan_id: v.plan_id,
      max_uses: v.max_uses, expires_at: v.expires_at, active: v.active,
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return err(res, 409, 'Kode diskon sudah dipakai.');
    throw e;
  }
  audit(req.user.id, 'discount_update', 'discount', id, { code: v.code, percent: v.percent, active: v.active });
  return send(res, 200, { ok: true, discount: row, message: 'Kode diskon diperbarui.' });
}

function handleDeleteDiscount(req, res, idRaw) {
  if (!requireAdmin(req, res)) return true;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) return err(res, 404, 'Kode diskon tidak ditemukan.');
  const existing = discounts.getDiscount(id);
  if (!existing) return err(res, 404, 'Kode diskon tidak ditemukan.');
  if (existing.used_count > 0) {
    // Sudah pernah dipakai transaksi: nonaktifkan saja supaya riwayat
    // transaksi tetap bisa dibaca dan kode tidak hilang dari daftar.
    discounts.updateDiscount(id, { active: 0 });
    audit(req.user.id, 'discount_update', 'discount', id, { active: 0, reason: 'sudah dipakai transaksi, dinonaktifkan' });
    return send(res, 200, { ok: true, discount: { ...existing, active: 0 }, message: 'Kode diskon sudah dipakai transaksi, jadi dinonaktifkan (bukan dihapus).' });
  }
  discounts.deleteDiscount(id);
  audit(req.user.id, 'discount_delete', 'discount', id, { code: existing.code });
  return send(res, 200, { ok: true, message: 'Kode diskon dihapus.' });
}

// --- Pengaturan ---
const SETTING_RULES = {
  premium_new_days: (v) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1 || n > 365) return null;
    return String(n);
  },
  payment_methods: (v) => {
    if (typeof v !== 'string' || !v.trim() || v.trim().length > 200) return null;
    return v.trim();
  },
  // Cara bayar utama yang ditampilkan Frontend (v1.1.0): 'manual' (QRIS,
  // default baru) atau 'midtrans' (gateway otomatis, opsi). Keduanya tetap
  // jalan — pengaturan ini hanya menentukan alur yang ditampilkan default.
  payment_gateway: (v) => {
    if (v !== 'manual' && v !== 'midtrans') return null;
    return v;
  },
};

function handleGetSettings(req, res) {
  if (!requireAdmin(req, res)) return true;
  const rows = dbModule.get().prepare('SELECT key, value FROM settings ORDER BY key').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return send(res, 200, { ok: true, data: out });
}

function handlePutSettings(req, res) {
  if (!requireAdmin(req, res)) return true;
  const b = bodyOf(req);
  const key = typeof b.key === 'string' ? b.key.trim() : '';
  if (!Object.prototype.hasOwnProperty.call(SETTING_RULES, key)) {
    return err(res, 400, 'Kunci pengaturan tidak dikenal atau tidak boleh diubah dari dashboard.');
  }
  const value = SETTING_RULES[key](b.value);
  if (value === null) return err(res, 400, 'Nilai pengaturan tidak valid.');
  dbModule.get().prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(key, value, nowSec());
  audit(req.user.id, 'setting_update', 'setting', key, { value });
  return send(res, 200, { ok: true, key, value, message: 'Pengaturan disimpan.' });
}

// --- Kode QRIS manual (v1.1.0) ---
// Gambar kode QRIS disimpan di data/qris/ (bukan folder publik) dan hanya
// dibaca lewat endpoint ber-login/admin. Nama merchant + rujukan file
// disimpan di settings (qris_merchant_name, qris_image).

// L-03: stream gambar WAJIB punya handler 'error' (lihat sendImage di
// routes/premium.js). Header baru ditulis saat stream terbuka; bila gagal,
// jawab 404 (berkas hilang) atau 500 tanpa mematikan server.
function sendImage(res, filePath) {
  const stream = fs.createReadStream(filePath);
  stream.on('error', (e) => {
    logger.warn(`Gagal mengirim gambar ${filePath}: ${e.message}`);
    if (!res.headersSent) {
      const status = e.code === 'ENOENT' ? 404 : 500;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify({ ok: false, message: status === 404 ? 'Gambar tidak ditemukan.' : 'Gagal mengirim gambar.' }));
    } else if (!res.writableEnded) {
      res.end();
    }
  });
  stream.on('open', () => {
    res.writeHead(200, {
      'Content-Type': manualPayment.mimeForExt(filePath),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    stream.pipe(res);
  });
  res.on('error', () => stream.destroy());
  return true;
}

// POST {ADMIN_PATH}/api/settings/qris { merchant_name?, image? } —
// unggah/ganti gambar kode QRIS dan/atau nama merchant. Salah satu dari
// keduanya wajib ada. Gambar: base64/data URL JPG/PNG/WebP, maks. 2 MB.
function handleQrisUpload(req, res) {
  if (!requireAdmin(req, res)) return true;
  const b = bodyOf(req);
  const hasName = typeof b.merchant_name === 'string' && b.merchant_name.trim().length > 0;
  const hasImage = typeof b.image === 'string' && b.image.trim().length > 0;
  if (!hasName && !hasImage) {
    return err(res, 400, 'Isi nama merchant dan/atau gambar kode QRIS.');
  }
  let merchantName = null;
  if (hasName) merchantName = b.merchant_name.trim().slice(0, 100);
  if (hasImage) {
    try {
      manualPayment.saveQrisImage(b.image);
    } catch (e) {
      if (e && e.status) return err(res, e.status, e.message);
      throw e;
    }
  }
  if (merchantName !== null) manualPayment.writeSetting('qris_merchant_name', merchantName);
  const info = manualPayment.getQrisInfo();
  audit(req.user.id, 'qris_update', 'setting', 'qris', {
    merchant_name: info.merchant_name, has_image: Boolean(info.file),
  });
  return send(res, 200, {
    ok: true,
    data: { merchant_name: info.merchant_name, has_qris: Boolean(info.file) },
    message: 'Kode QRIS disimpan.',
  });
}

// GET {ADMIN_PATH}/api/settings/qris — konfigurasi QRIS saat ini.
function handleQrisGet(req, res) {
  if (!requireAdmin(req, res)) return true;
  const info = manualPayment.getQrisInfo();
  return send(res, 200, {
    ok: true,
    data: { merchant_name: info.merchant_name, has_qris: Boolean(info.file) },
  });
}

// GET {ADMIN_PATH}/api/settings/qris/image — gambar kode QRIS (hanya admin).
function handleQrisImage(req, res) {
  if (!requireAdmin(req, res)) return true;
  const info = manualPayment.getQrisInfo();
  if (!info.file) return err(res, 404, 'Kode QRIS belum diatur.');
  const full = manualPayment.resolveQrisFile(info.file);
  if (!full) return err(res, 404, 'Kode QRIS belum diatur.');
  return sendImage(res, full);
}

// GET {ADMIN_PATH}/api/transactions/:id/proof — gambar bukti bayar
// transaksi manual (hanya admin; file di data/proofs/, nama acak).
function handleTxProof(req, res, idRaw) {
  if (!requireAdmin(req, res)) return true;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) return err(res, 404, 'Transaksi tidak ditemukan.');
  const tx = dbModule.get().prepare('SELECT * FROM premium_transactions WHERE id = ?').get(id);
  if (!tx) return err(res, 404, 'Transaksi tidak ditemukan.');
  if (tx.method !== 'manual_qris' || !tx.proof_file) {
    return err(res, 404, 'Transaksi ini tidak punya bukti bayar.');
  }
  const full = manualPayment.resolveProofFile(tx.proof_file);
  if (!full) return err(res, 404, 'Bukti bayar tidak ditemukan.');
  return sendImage(res, full);
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

// --- Aksesori (CRUD katalog) ---
const CODE_RE = /^[a-z0-9-]{2,50}$/;

function validAccessory(b, partial = false) {
  const out = {};
  if (b.code !== undefined || !partial) {
    const code = typeof b.code === 'string' ? b.code.trim() : '';
    if (!CODE_RE.test(code)) return { error: 'code 2–50 karakter, huruf kecil, angka, dan "-".' };
    out.code = code;
  }
  if (b.name !== undefined || !partial) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 100) return { error: 'Nama aksesori 1–100 karakter.' };
    out.name = name;
  }
  if (b.kind !== undefined || !partial) {
    if (!accessories.KINDS.includes(b.kind)) return { error: 'kind tidak dikenal.' };
    out.kind = b.kind;
  }
  if (b.asset !== undefined) {
    const asset = typeof b.asset === 'string' ? b.asset.trim().slice(0, 200) : null;
    out.asset = asset || null;
  }
  if (b.premium_only !== undefined) {
    if (![0, 1, true, false].includes(b.premium_only)) return { error: 'premium_only harus 0 atau 1.' };
    out.premium_only = b.premium_only ? 1 : 0;
  }
  if (b.active !== undefined) {
    if (![0, 1, true, false].includes(b.active)) return { error: 'active harus 0 atau 1.' };
    out.active = b.active ? 1 : 0;
  }
  return out;
}

function handleListAccessories(req, res) {
  if (!requireAdmin(req, res)) return true;
  const rows = accessories.listCatalog({ onlyActive: false });
  return send(res, 200, { ok: true, data: rows, total: rows.length });
}

function handleCreateAccessory(req, res) {
  if (!requireAdmin(req, res)) return true;
  const v = validAccessory(bodyOf(req));
  if (v.error) return err(res, 400, v.error);
  const db = dbModule.get();
  try {
    const info = db.prepare(
      `INSERT INTO accessories (code, name, kind, asset, premium_only, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(v.code, v.name, v.kind, v.asset ?? null, v.premium_only ?? 0, v.active ?? 1, nowSec());
    const row = db.prepare('SELECT * FROM accessories WHERE id = ?').get(info.lastInsertRowid);
    audit(req.user.id, 'accessory_create', 'accessory', row.id, { code: v.code, kind: v.kind });
    return send(res, 201, { ok: true, accessory: row, message: 'Aksesori dibuat.' });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return err(res, 409, 'code aksesori sudah dipakai.');
    throw e;
  }
}

function handleUpdateAccessory(req, res, idRaw) {
  if (!requireAdmin(req, res)) return true;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) return err(res, 404, 'Aksesori tidak ditemukan.');
  const db = dbModule.get();
  const acc = accessories.getAccessory(id);
  if (!acc) return err(res, 404, 'Aksesori tidak ditemukan.');
  const v = validAccessory(bodyOf(req), true);
  if (v.error) return err(res, 400, v.error);
  if (!Object.keys(v).length) return err(res, 400, 'Tidak ada perubahan.');
  try {
    const sets = Object.keys(v).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE accessories SET ${sets} WHERE id = ?`).run(...Object.values(v), id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return err(res, 409, 'code aksesori sudah dipakai.');
    throw e;
  }
  const row = accessories.getAccessory(id);
  audit(req.user.id, 'accessory_update', 'accessory', id, v);
  return send(res, 200, { ok: true, accessory: row, message: 'Aksesori diperbarui.' });
}

function handleDeleteAccessory(req, res, idRaw) {
  if (!requireAdmin(req, res)) return true;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) return err(res, 404, 'Aksesori tidak ditemukan.');
  const db = dbModule.get();
  const acc = accessories.getAccessory(id);
  if (!acc) return err(res, 404, 'Aksesori tidak ditemukan.');
  const owned = db.prepare('SELECT COUNT(*) AS c FROM user_accessories WHERE accessory_id = ?').get(id).c;
  if (owned > 0) {
    // Sudah dimiliki pengguna: nonaktifkan saja, jangan hapus.
    db.prepare('UPDATE accessories SET active = 0 WHERE id = ?').run(id);
    audit(req.user.id, 'accessory_update', 'accessory', id, { active: 0, reason: 'sudah dimiliki pengguna, dinonaktifkan' });
    return send(res, 200, { ok: true, accessory: { ...acc, active: 0 }, message: 'Aksesori sudah dimiliki pengguna, jadi dinonaktifkan (bukan dihapus).' });
  }
  db.prepare('DELETE FROM accessories WHERE id = ?').run(id);
  db.prepare(`UPDATE users SET equipped_border = NULL WHERE equipped_border = ?`).run(id);
  db.prepare(`UPDATE users SET equipped_background = NULL WHERE equipped_background = ?`).run(id);
  db.prepare(`UPDATE users SET equipped_frame = NULL WHERE equipped_frame = ?`).run(id);
  db.prepare(`UPDATE users SET equipped_badge = NULL WHERE equipped_badge = ?`).run(id);
  db.prepare(`UPDATE users SET equipped_name_effect = NULL WHERE equipped_name_effect = ?`).run(id);
  audit(req.user.id, 'accessory_delete', 'accessory', id, { code: acc.code });
  return send(res, 200, { ok: true, message: 'Aksesori dihapus.' });
}

// Router admin — HANYA dipanggil server.js bila path cocok ADMIN_PATH.
// Mengembalikan true bila dikenali.
function route(req, res, url) {
  const sub = adminPath.adminSubPath(url.pathname);
  if (sub === null) return false;
  if (sub === '/' && req.method === 'GET') return handleAdminPage(req, res);
  if (sub === '/api/login' && req.method === 'POST') return handleAdminLogin(req, res);
  if (sub === '/api/logout' && req.method === 'POST') return handleAdminLogout(req, res);
  // M3: aksi tulis admin (approve, reject, beri premium, ubah flag,
  // paket, pengaturan, aksesori) — 60 aksi per admin per 5 menit.
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
  if (sub === '/api/transactions' && req.method === 'GET') return handleListTx(req, res, url);
  const approveMatch = sub.match(/^\/api\/transactions\/(\d+)\/approve$/);
  if (approveMatch && req.method === 'POST') return handleApproveTx(req, res, approveMatch[1]);
  const rejectMatch = sub.match(/^\/api\/transactions\/(\d+)\/reject$/);
  if (rejectMatch && req.method === 'POST') return handleRejectTx(req, res, rejectMatch[1]);
  if (sub === '/api/users' && req.method === 'GET') return handleListUsers(req, res, url);
  const premiumMatch = sub.match(/^\/api\/users\/(\d+)\/premium$/);
  if (premiumMatch && req.method === 'POST') return handleSetUserPremium(req, res, premiumMatch[1]);
  const flagsMatch = sub.match(/^\/api\/anime\/(\d+)\/flags$/);
  if (flagsMatch && req.method === 'POST') return handleAnimeFlags(req, res, flagsMatch[1]);
  if (sub === '/api/plans' && req.method === 'GET') return handleListPlans(req, res);
  if (sub === '/api/plans' && req.method === 'POST') return handleCreatePlan(req, res);
  const planMatch = sub.match(/^\/api\/plans\/(\d+)$/);
  if (planMatch && req.method === 'PUT') return handleUpdatePlan(req, res, planMatch[1]);
  if (planMatch && req.method === 'DELETE') return handleDeletePlan(req, res, planMatch[1]);
  // v1.3.0: kode diskon admin.
  if (sub === '/api/discounts' && req.method === 'GET') return handleListDiscounts(req, res);
  if (sub === '/api/discounts' && req.method === 'POST') return handleCreateDiscount(req, res);
  const discMatch = sub.match(/^\/api\/discounts\/(\d+)$/);
  if (discMatch && req.method === 'PUT') return handleUpdateDiscount(req, res, discMatch[1]);
  if (discMatch && req.method === 'DELETE') return handleDeleteDiscount(req, res, discMatch[1]);
  if (sub === '/api/settings' && req.method === 'GET') return handleGetSettings(req, res);
  if (sub === '/api/settings' && req.method === 'PUT') return handlePutSettings(req, res);
  if (sub === '/api/settings/qris' && req.method === 'GET') return handleQrisGet(req, res);
  if (sub === '/api/settings/qris' && req.method === 'POST') return handleQrisUpload(req, res);
  if (sub === '/api/settings/qris/image' && req.method === 'GET') return handleQrisImage(req, res);
  const proofMatch = sub.match(/^\/api\/transactions\/(\d+)\/proof$/);
  if (proofMatch && req.method === 'GET') return handleTxProof(req, res, proofMatch[1]);
  if (sub === '/api/audit' && req.method === 'GET') return handleAudit(req, res, url);
  if (sub === '/api/accessories' && req.method === 'GET') return handleListAccessories(req, res);
  if (sub === '/api/accessories' && req.method === 'POST') return handleCreateAccessory(req, res);
  const accMatch = sub.match(/^\/api\/accessories\/(\d+)$/);
  if (accMatch && req.method === 'PUT') return handleUpdateAccessory(req, res, accMatch[1]);
  if (accMatch && req.method === 'DELETE') return handleDeleteAccessory(req, res, accMatch[1]);
  // Path admin yang dikenal polanya tetapi endpoint tidak ada → 404 generik.
  return err(res, 404, 'Tidak ditemukan.');
}

module.exports = { route, send, err };
