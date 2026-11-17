'use strict';
// Rute premium (task-07 + v1.1.0 manual QRIS): paket, transaksi Midtrans,
// transaksi manual QRIS, riwayat, status.
// Alur Midtrans (keputusan pengguna 2026-11-15): pengguna pilih paket →
// bayar lewat Midtrans (Snap) → transaksi tercatat (payment_status 'paid'
// setelah dikonfirmasi) → ADMIN menyetujui di dashboard → premium aktif.
// Alur MANUAL QRIS (keputusan pengguna 2026-11-15 ~07:52 WIB — cara bayar
// UTAMA): pengguna pilih paket → buat transaksi manual (method
// 'manual_qris', payment_status tetap 'unpaid' — tidak ada gateway yang
// memverifikasi) → bayar dengan memindai kode QRIS admin → kirim
// proof_ref dan/atau gambar bukti bayar → ADMIN memeriksa bukti +
// mutasi di aplikasi pembayarannya sendiri lalu menyetujui di dashboard
// → premium aktif. Pembayaran TIDAK langsung mengaktifkan premium di
// kedua alur: admin tetap yang mengaktifkan.
//
// MODEL v1: premium = aksesori profil saja. TIDAK ADA konten terkunci.
// Karena itu tidak ada endpoint/aturan gating konten di sini.
const fs = require('node:fs');
const dbModule = require('../db/database');
const mw = require('../middleware/auth');
const accessories = require('../services/accessories');
const premium = require('../services/premium');
const payment = require('../services/payment');
const manualPayment = require('../services/manualPayment');
const discounts = require('../services/discounts');

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

// Penjaga monotonik status pembayaran (perbaikan N1).
//
// ATURAN: sekali payment_status menjadi 'paid', status itu TERMINAL untuk
// semua jalur masuk dari gateway (webhook Midtrans dan tombol confirm).
// Webhook/confirm tidak boleh mengubah 'paid' menjadi status apa pun yang
// bukan 'paid' — termasuk 'unpaid', 'expired', maupun 'failed'.
// Alasan:
// - Notifikasi Midtrans bisa dikirim ulang dan tiba tidak berurutan;
//   notifikasi 'pending' atau 'capture'+challenge yang lebih tua tidak
//   boleh membatalkan pembayaran yang sudah lunas.
// - Pembayaran yang sudah 'settlement' tidak bisa kadaluarsa atau gagal
//   sesudahnya secara nyata; status 'expire'/'deny'/'cancel' yang datang
//   belakangan hampir pasti notifikasi basi.
// - Kejadian bisnis nyata yang butuh menurunkan status (mis. refund /
//   chargeback) adalah urusan admin, bukan webhook: admin bisa menolak
//   atau mencabut premium secara eksplisit lewat dashboard (tercatat di
//   audit log). Jadi satu-satunya jalan keluar dari 'paid' adalah aksi
//   admin eksplisit.
// Bila dijaga (diblokir): UPDATE dilewati seluruhnya (payment_status DAN
// gateway_status tetap konsisten dengan keadaan paid), kejadian dicatat
// di log server (WARN), dan pemanggil tetap mendapat HTTP 200 supaya
// Midtrans tidak mengulang notifikasi yang memang tidak akan mengubah
// apa pun.
// Mengembalikan true bila UPDATE diterapkan, false bila diblokir penjaga.
function applyPaymentStatus(db, row, nextPaymentStatus, nextGatewayStatus, source) {
  if (row.payment_status === 'paid' && nextPaymentStatus !== 'paid') {
    require('../utils/logger').warn(
      `Penjaga monotonik (${source}): status ${nextPaymentStatus} diabaikan untuk order ${row.gateway_order_id || row.id} — transaksi sudah paid, payment_status dipertahankan.`);
    return false;
  }
  db.prepare(
    'UPDATE premium_transactions SET payment_status = ?, gateway_status = ? WHERE id = ?',
  ).run(nextPaymentStatus, nextGatewayStatus, row.id);
  return true;
}

function publicTx(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    plan_id: row.plan_id,
    plan_name: row.plan_name || null,
    amount_idr: row.amount_idr,
    // v1.3.0: harga asli sebelum diskon + kode/persen (null bila tanpa kode).
    original_amount_idr: row.original_amount_idr ?? null,
    discount_code: row.discount_code || null,
    discount_percent: row.discount_percent ?? null,
    method: row.method,
    proof_ref: row.proof_ref,
    // Nama file bukti TIDAK PERNAH dikirim ke klien (tidak bisa ditebak
    // dari luar); hanya penanda ada/tidaknya bukti.
    has_proof: Boolean(row.proof_file),
    status: row.status,
    payment_status: row.payment_status,
    gateway_order_id: row.gateway_order_id,
    gateway_status: row.gateway_status,
    payment_url: row.payment_url,
    created_at: row.created_at,
    decided_at: row.decided_at,
    note: row.note,
  };
}

// GET /api/plans — paket aktif (publik, dipakai halaman premium).
// Tiap paket menyertakan daftar aksesorinya (tiering v1.2.0) supaya
// halaman premium bisa menampilkan benefit per paket:
// [{ id, name, kind }].
function handlePlans(req, res) {
  const rows = dbModule.get().prepare(
    'SELECT id, name, price_idr, duration_days, description FROM plans WHERE active = 1 ORDER BY price_idr',
  ).all();
  const data = rows.map((p) => ({ ...p, accessories: accessories.listPlanAccessories(p.id) }));
  return send(res, 200, { ok: true, data, total: data.length });
}

// GET /api/premium/status — status premium pengguna login.
function handleStatus(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  return send(res, 200, { ok: true, premium: premium.premiumInfo(req.user) });
}

// POST /api/premium/transactions { plan_id } → buat transaksi + Snap Midtrans.
// Bila gateway belum dikonfigurasi → 503 dan transaksi TIDAK dibuat
// (jangan buat transaksi yang tidak bisa dibayar).
async function handleCreateTx(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  // M3: 5 transaksi per pengguna per jam (tiap panggilan memanggil Snap).
  if (!mw.enforceRateLimit(req, res, `createtx:${req.user.id}`, 5, 60 * 60 * 1000,
    'Terlalu banyak pembuatan transaksi. Coba lagi nanti.')) return true;
  const b = bodyOf(req);
  const planId = Number.parseInt(b.plan_id, 10);
  if (!Number.isFinite(planId) || planId <= 0) {
    return err(res, 400, 'Pilih paket terlebih dahulu.');
  }
  const db = dbModule.get();
  const plan = db.prepare(
    'SELECT * FROM plans WHERE id = ? AND active = 1',
  ).get(planId);
  if (!plan) return err(res, 404, 'Paket tidak ditemukan atau sudah tidak aktif.');

  // v1.3.0: kode diskon (opsional). Divalidasi SEBELUM penjaga transaksi
  // ganda supaya kode yang tidak valid selalu dijawab 400 — bukan
  // transaksi lama tanpa keterangan. Harga yang disimpan + dikirim ke
  // Midtrans adalah HARGA SETELAH DISKON; M1 mencocokkan webhook
  // gross_amount dengan amount_idr ini.
  let discount = null;
  let finalPrice = plan.price_idr;
  if (typeof b.discount_code === 'string' && b.discount_code.trim() !== '') {
    const v = discounts.validateDiscount({ planId: plan.id, code: b.discount_code });
    if (!v.ok) return err(res, 400, v.message);
    discount = v.discount;
    finalPrice = v.final_price;
  }

  // Cegah transaksi ganda: bila ada transaksi pending yang belum dibayar
  // untuk paket yang sama dalam 24 jam terakhir, kembalikan yang itu
  // (beserta tautan bayarnya) agar pengguna tidak membayar dua kali.
  const existing = db.prepare(
    `SELECT * FROM premium_transactions
     WHERE user_id = ? AND plan_id = ? AND status = 'pending' AND payment_status = 'unpaid'
       AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
  ).get(req.user.id, planId, nowSec() - 24 * 3600);
  if (existing) {
    const withPlan = { ...existing, plan_name: plan.name };
    return send(res, 200, {
      ok: true, transaction: publicTx(withPlan),
      message: 'Anda sudah punya transaksi yang menunggu pembayaran untuk paket ini.',
    });
  }

  let adapter;
  try {
    adapter = payment.getAdapter();
    adapter.requireConfigured();
  } catch (e) {
    if (e && e.code === 'not_configured') {
      return err(res, 503, e.message);
    }
    throw e;
  }

  // Pemakaian kode dicatat SEBELUM insert (cek atomik di WHERE — dua
  // permintaan bersamaan tidak bisa sama-sama lolos max_uses). Bila
  // transaksi gagal dibuat setelah ini, pemakaian dibatalkan.
  let reserved = false;
  if (discount) {
    reserved = discounts.reserveUse(discount.id);
    if (!reserved) return err(res, 409, 'Kode diskon sudah habis dipakai.');
  }

  const now = nowSec();
  let txId;
  try {
    const insert = db.prepare(
      `INSERT INTO premium_transactions
       (user_id, plan_id, amount_idr, method, status, payment_status,
        discount_code, discount_percent, original_amount_idr, created_at)
       VALUES (?, ?, ?, 'midtrans', 'pending', 'unpaid', ?, ?, ?, ?)`,
    ).run(req.user.id, plan.id, finalPrice,
      discount ? discount.code : null,
      discount ? discount.percent : null,
      discount ? plan.price_idr : null, now);
    txId = insert.lastInsertRowid;
  } catch (e) {
    if (reserved) discounts.releaseUse(discount.id);
    throw e;
  }
  const orderId = `mitsu-${txId}-${now}`;
  try {
    const snap = await adapter.createTransaction({
      orderId,
      amount: finalPrice,
      customerName: req.user.username,
      itemName: plan.name,
    });
    db.prepare(
      'UPDATE premium_transactions SET gateway_order_id = ?, payment_url = ? WHERE id = ?',
    ).run(orderId, snap.redirect_url, txId);
    const row = db.prepare('SELECT * FROM premium_transactions WHERE id = ?').get(txId);
    return send(res, 201, {
      ok: true,
      transaction: publicTx({ ...row, plan_name: plan.name }),
      payment: { token: snap.token, redirect_url: snap.redirect_url },
      message: 'Transaksi dibuat. Lanjutkan pembayaran lewat Midtrans.',
    });
  } catch (e) {
    // Midtrans gagal: tandai transaksi gagal-bayar supaya tidak menggantung.
    db.prepare(
      "UPDATE premium_transactions SET payment_status = 'failed', gateway_order_id = ? WHERE id = ?",
    ).run(orderId, txId);
    if (reserved) discounts.releaseUse(discount.id);
    if (e && e.code) {
      return err(res, e.status || 502, e.message);
    }
    throw e;
  }
}

// GET /api/premium/mine — riwayat transaksi pengguna login.
function handleMine(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  const rows = dbModule.get().prepare(
    `SELECT t.*, p.name AS plan_name FROM premium_transactions t
     LEFT JOIN plans p ON p.id = t.plan_id
     WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT 50`,
  ).all(req.user.id);
  return send(res, 200, {
    ok: true, data: rows.map(publicTx), total: rows.length,
  });
}

// GET /api/premium/transactions/:id — detail satu transaksi milik sendiri.
function handleGetTx(req, res, idRaw) {
  if (!mw.requireLogin(req, res)) return true;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) return err(res, 404, 'Transaksi tidak ditemukan.');
  const row = dbModule.get().prepare(
    `SELECT t.*, p.name AS plan_name FROM premium_transactions t
     LEFT JOIN plans p ON p.id = t.plan_id WHERE t.id = ?`,
  ).get(id);
  if (!row) return err(res, 404, 'Transaksi tidak ditemukan.');
  if (row.user_id !== req.user.id) {
    return err(res, 403, 'Transaksi ini bukan milik Anda.');
  }
  return send(res, 200, { ok: true, transaction: publicTx(row) });
}

// POST /api/premium/transactions/:id/confirm — tanyakan status bayar ke
// Midtrans lalu perbarui payment_status. Dipakai setelah pengguna kembali
// dari halaman bayar (hosting lokal tidak punya URL publik untuk webhook).
async function handleConfirmTx(req, res, idRaw) {
  if (!mw.requireLogin(req, res)) return true;
  // M3: 10 konfirmasi per pengguna per 5 menit (tiap panggilan memanggil
  // API status Midtrans).
  if (!mw.enforceRateLimit(req, res, `confirmtx:${req.user.id}`, 10, 5 * 60 * 1000,
    'Terlalu banyak pengecekan pembayaran. Coba lagi sebentar lagi.')) return true;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) return err(res, 404, 'Transaksi tidak ditemukan.');
  const db = dbModule.get();
  const row = db.prepare('SELECT * FROM premium_transactions WHERE id = ?').get(id);
  if (!row) return err(res, 404, 'Transaksi tidak ditemukan.');
  if (row.user_id !== req.user.id) {
    return err(res, 403, 'Transaksi ini bukan milik Anda.');
  }
  if (row.status !== 'pending') {
    return send(res, 200, {
      ok: true, transaction: publicTx(row),
      message: row.status === 'approved'
        ? 'Transaksi ini sudah disetujui admin.'
        : 'Transaksi ini sudah ditolak admin.',
    });
  }
  if (row.payment_status === 'paid') {
    return send(res, 200, {
      ok: true, transaction: publicTx(row),
      message: 'Pembayaran sudah terkonfirmasi. Menunggu persetujuan admin.',
    });
  }
  if (!row.gateway_order_id) {
    return err(res, 400, 'Transaksi ini belum memiliki order Midtrans.');
  }
  let adapter;
  try {
    adapter = payment.getAdapter();
    adapter.requireConfigured();
    const st = await adapter.getTransactionStatus(row.gateway_order_id);
    // N1: penjaga monotonik — bila baris sudah 'paid', UPDATE dilewati
    // (pertahanan lapis kedua; pengembalian dini di atas sudah menangani
    // kasus paid yang biasa).
    const applied = applyPaymentStatus(db, row, st.payment_status, st.gateway_status, 'confirm');
    const updated = db.prepare(
      `SELECT t.*, p.name AS plan_name FROM premium_transactions t
       LEFT JOIN plans p ON p.id = t.plan_id WHERE t.id = ?`,
    ).get(id);
    const effective = applied ? st.payment_status : updated.payment_status;
    const msg = effective === 'paid'
      ? 'Pembayaran terkonfirmasi. Menunggu persetujuan admin.'
      : effective === 'expired'
        ? 'Pembayaran sudah kadaluarsa. Buat transaksi baru bila masih ingin Premium.'
        : effective === 'failed'
          ? 'Pembayaran gagal atau dibatalkan.'
          : 'Pembayaran belum diterima. Selesaikan pembayaran di Midtrans terlebih dahulu.';
    return send(res, 200, { ok: true, transaction: publicTx(updated), message: msg });
  } catch (e) {
    if (e && e.code) return err(res, e.status || 502, e.message);
    throw e;
  }
}

// POST /api/premium/webhook/midtrans — notifikasi server-ke-server Midtrans.
// BELUM TERVERIFIKASI (butuh URL publik + kunci asli): endpoint ini ada
// untuk nanti, saat situs sudah hosting publik. Tanda tangan diverifikasi
// dengan SHA512(order_id + status_code + gross_amount + server_key);
// tanpa tanda tangan yang cocok → 403, tanpa bocoran.
async function handleWebhook(req, res) {
  const b = bodyOf(req);
  const orderId = b.order_id;
  const statusCode = b.status_code;
  const grossAmount = b.gross_amount;
  const signatureKey = b.signature_key;
  const txStatus = b.transaction_status;
  const fraudStatus = b.fraud_status || null;
  let adapter;
  try {
    adapter = payment.getAdapter();
  } catch {
    return err(res, 503, 'Gateway belum dikonfigurasi.');
  }
  if (!adapter.verifyWebhookSignature({ orderId, statusCode, grossAmount, signatureKey })) {
    return err(res, 403, 'Tanda tangan tidak valid.');
  }
  const db = dbModule.get();
  const row = db.prepare(
    'SELECT * FROM premium_transactions WHERE gateway_order_id = ?',
  ).get(orderId);
  if (!row) {
    require('../utils/logger').warn(`Webhook Midtrans: order tidak dikenal (${orderId})`);
    // Tetap 200 supaya Midtrans tidak mengulang notifikasi yang tidak
    // akan pernah cocok; log di atas memberi jejak untuk admin.
    return send(res, 200, { ok: false, message: 'Order tidak dikenal.' });
  }
  // M1: cocokkan gross_amount webhook dengan amount_idr yang tercatat.
  // v1.3.0: bila transaksi memakai kode diskon, amount_idr SUDAH harga
  // setelah diskon — webhook harus membawa gross_amount harga diskon,
  // bukan harga penuh.
  // Jumlah salah (mis. Rp1 untuk transaksi Rp29.000 — pembayaran
  // sebagian, anomali gateway, atau notifikasi dipalsukan) TIDAK BOLEH
  // menandai paid. Tolak perubahannya dan catat; tetap 200 agar
  // Midtrans tidak mengulang notifikasi yang memang tidak akan cocok.
  const gross = Number(grossAmount);
  if (!Number.isFinite(gross) || gross !== row.amount_idr) {
    require('../utils/logger').warn(
      `Webhook Midtrans: gross_amount tidak cocok (order ${orderId}, webhook ${grossAmount}, tercatat ${row.amount_idr}) — payment_status TIDAK diubah.`);
    return send(res, 200, { ok: false, message: 'Jumlah pembayaran tidak cocok dengan transaksi.' });
  }
  const paymentStatus = payment.mapMidtransStatus(txStatus, fraudStatus);
  // N1: penjaga monotonik — 'paid' terminal untuk webhook. Bila transaksi
  // sudah paid dan notifikasi ini membawa status yang lebih rendah
  // (pending / capture+challenge / expire / deny / cancel), UPDATE
  // dilewati dan tetap 200 (lihat komentar applyPaymentStatus).
  const applied = applyPaymentStatus(db, row, paymentStatus, txStatus || null, 'webhook');
  if (!applied) {
    return send(res, 200, { ok: false, message: 'Status paid dipertahankan. Notifikasi lama diabaikan.' });
  }
  return send(res, 200, { ok: true, message: 'Notifikasi diterima.' });
}

// --- Bayar manual QRIS (v1.1.0, cara bayar UTAMA) ---

// L-03: stream gambar WAJIB punya handler 'error'. Tanpa itu, berkas
// yang lenyap di antara stat dan open (mis. admin mengganti kode QRIS
// tepat saat pengguna mengambilnya) melempar unhandled 'error' dan
// mematikan proses Node. Header baru ditulis saat stream terbuka; bila
// gagal, jawab 404 (berkas hilang) atau 500 tanpa mematikan server.
function sendImage(res, filePath) {
  const stream = fs.createReadStream(filePath);
  stream.on('error', (e) => {
    require('../utils/logger').warn(`Gagal mengirim gambar ${filePath}: ${e.message}`);
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

// GET /api/premium/qris — info bayar manual untuk pengguna login:
// gateway aktif menurut settings, nama merchant, dan ada/tidaknya kode QRIS.
// Gambarnya sendiri diambil lewat /api/premium/qris/image.
function handleQrisInfo(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  const info = manualPayment.getQrisInfo();
  return send(res, 200, {
    ok: true,
    data: {
      payment_gateway: manualPayment.getPaymentGateway(),
      payment_methods: manualPayment.getSetting('payment_methods'),
      merchant_name: info.merchant_name,
      has_qris: Boolean(info.file),
    },
  });
}

// GET /api/premium/qris/image — gambar kode QRIS (wajib login; gambar
// disimpan di data/qris/, bukan folder publik).
function handleQrisImage(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  const info = manualPayment.getQrisInfo();
  if (!info.file) return err(res, 404, 'Kode QRIS belum diatur admin.');
  const full = manualPayment.resolveQrisFile(info.file);
  if (!full) return err(res, 404, 'Kode QRIS belum diatur admin.');
  return sendImage(res, full);
}

// POST /api/premium/transactions/manual { plan_id, proof_ref?, proof_image? }
// → buat transaksi manual (method 'manual_qris'). proof_image opsional:
// base64 (atau data URL) JPG/PNG/WebP, maksimal 2 MB hasil decode.
// payment_status SELALU 'unpaid' — tidak ada gateway yang memverifikasi;
// verifikasi dilakukan admin sendiri dari bukti + mutasi.
// Transaksi ganda manual untuk paket yang sama (pending + unpaid, 24 jam)
// dikembalikan seperti alur Midtrans, supaya pengguna tidak membayar dua kali.
async function handleCreateManualTx(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  // M3: batas yang sama dengan buat-transaksi Midtrans (5/pengguna/jam,
  // satu keranjang yang sama) — penyerang tidak bisa menghindar dengan
  // berganti metode.
  if (!mw.enforceRateLimit(req, res, `createtx:${req.user.id}`, 5, 60 * 60 * 1000,
    'Terlalu banyak pembuatan transaksi. Coba lagi nanti.')) return true;
  const b = bodyOf(req);
  const planId = Number.parseInt(b.plan_id, 10);
  if (!Number.isFinite(planId) || planId <= 0) {
    return err(res, 400, 'Pilih paket terlebih dahulu.');
  }
  const proofRef = typeof b.proof_ref === 'string' ? b.proof_ref.trim().slice(0, 200) : null;
  const db = dbModule.get();
  const plan = db.prepare(
    'SELECT * FROM plans WHERE id = ? AND active = 1',
  ).get(planId);
  if (!plan) return err(res, 404, 'Paket tidak ditemukan atau sudah tidak aktif.');
  // v1.3.0: kode diskon (opsional) — harga yang disimpan adalah harga
  // setelah diskon; admin melihat kode + harga diskon di dashboard.
  let discount = null;
  let finalPrice = plan.price_idr;
  if (typeof b.discount_code === 'string' && b.discount_code.trim() !== '') {
    const v = discounts.validateDiscount({ planId: plan.id, code: b.discount_code });
    if (!v.ok) return err(res, 400, v.message);
    discount = v.discount;
    finalPrice = v.final_price;
  }
  const existing = db.prepare(
    `SELECT * FROM premium_transactions
     WHERE user_id = ? AND plan_id = ? AND method = 'manual_qris'
       AND status = 'pending' AND payment_status = 'unpaid'
       AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
  ).get(req.user.id, planId, nowSec() - 24 * 3600);
  if (existing) {
    const withPlan = { ...existing, plan_name: plan.name };
    return send(res, 200, {
      ok: true, transaction: publicTx(withPlan),
      message: 'Anda sudah punya transaksi manual yang menunggu untuk paket ini.',
    });
  }
  // Bukti gambar divalidasi + disimpan SEBELUM insert, supaya tidak ada
  // transaksi setengah jadi bila gambar ditolak.
  let proofFile = null;
  if (b.proof_image !== undefined && b.proof_image !== null && b.proof_image !== '') {
    try {
      proofFile = manualPayment.saveProofImage(b.proof_image);
    } catch (e) {
      if (e && e.status) return err(res, e.status, e.message);
      throw e;
    }
  }
  const now = nowSec();
  // Pemakaian kode dicatat SEBELUM insert (cek atomik di WHERE).
  // Bukti gambar sudah disimpan di atas — bila insert gagal, pemakaian
  // dibatalkan (berkas bukti yang mengendap adalah L-04 yang sudah ada,
  // bukan perilaku baru).
  let reserved = false;
  if (discount) {
    reserved = discounts.reserveUse(discount.id);
    if (!reserved) return err(res, 409, 'Kode diskon sudah habis dipakai.');
  }
  let row;
  try {
    const insert = db.prepare(
      `INSERT INTO premium_transactions
       (user_id, plan_id, amount_idr, method, proof_ref, proof_file, status, payment_status,
        discount_code, discount_percent, original_amount_idr, created_at)
       VALUES (?, ?, ?, 'manual_qris', ?, ?, 'pending', 'unpaid', ?, ?, ?, ?)`,
    ).run(req.user.id, plan.id, finalPrice, proofRef || null, proofFile,
      discount ? discount.code : null,
      discount ? discount.percent : null,
      discount ? plan.price_idr : null, now);
    row = db.prepare('SELECT * FROM premium_transactions WHERE id = ?').get(insert.lastInsertRowid);
  } catch (e) {
    if (reserved) discounts.releaseUse(discount.id);
    throw e;
  }
  return send(res, 201, {
    ok: true,
    transaction: publicTx({ ...row, plan_name: plan.name }),
    message: 'Transaksi manual dibuat. Bayar dengan memindai kode QRIS, lalu tunggu admin memeriksa bukti dan mengaktifkan Premium.',
  });
}

// POST /api/premium/discounts/validate { plan_id, code } → harga asli,
// persen, harga setelah diskon. Login wajib. TIDAK memakai kode
// (used_count tidak naik) — pemakaian dicatat saat transaksi dibuat.
function handleValidateDiscount(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  // 30 kali cek per pengguna per jam — cukup untuk mengetik ulang kode.
  if (!mw.enforceRateLimit(req, res, `discount-validate:${req.user.id}`, 30, 60 * 60 * 1000,
    'Terlalu banyak pengecekan kode diskon. Coba lagi nanti.')) return true;
  const b = bodyOf(req);
  const planId = Number.parseInt(b.plan_id, 10);
  if (!Number.isFinite(planId) || planId <= 0) return err(res, 400, 'ID paket tidak valid.');
  const v = discounts.validateDiscount({ planId, code: b.code });
  if (!v.ok) return err(res, 400, v.message);
  return send(res, 200, {
    ok: true,
    code: v.discount.code,
    percent: v.percent,
    original_price: v.original_price,
    final_price: v.final_price,
    plan_id: v.plan.id,
  });
}

// Router /api/* premium — dipanggil server.js. Mengembalikan true bila dikenali.
async function route(req, res, url) {
  const path = url.pathname;
  if (path === '/api/plans' && req.method === 'GET') return handlePlans(req, res);
  if (path === '/api/premium/status' && req.method === 'GET') return handleStatus(req, res);
  if (path === '/api/premium/qris' && req.method === 'GET') return handleQrisInfo(req, res);
  if (path === '/api/premium/qris/image' && req.method === 'GET') return handleQrisImage(req, res);
  if (path === '/api/premium/transactions/manual' && req.method === 'POST') return handleCreateManualTx(req, res);
  if (path === '/api/premium/discounts/validate' && req.method === 'POST') return handleValidateDiscount(req, res);
  if (path === '/api/premium/transactions' && req.method === 'POST') return handleCreateTx(req, res);
  if (path === '/api/premium/mine' && req.method === 'GET') return handleMine(req, res);
  if (path === '/api/premium/webhook/midtrans' && req.method === 'POST') return handleWebhook(req, res);
  const confirmMatch = path.match(/^\/api\/premium\/transactions\/(\d+)\/confirm$/);
  if (confirmMatch && req.method === 'POST') return handleConfirmTx(req, res, confirmMatch[1]);
  const txMatch = path.match(/^\/api\/premium\/transactions\/(\d+)$/);
  if (txMatch && req.method === 'GET') return handleGetTx(req, res, txMatch[1]);
  return false;
}

module.exports = { route, send, err, publicTx };
