'use strict';
// Kode diskon admin (v1.3.0).
//
// Kode disimpan huruf besar (mis. 'HEMAT10'). percent 1-99.
// plan_id NULL = berlaku untuk semua paket aktif; bila terisi, kode
// hanya berlaku untuk paket itu. max_uses NULL = tanpa batas pakai.
// used_count naik HANYA saat transaksi berhasil dibuat dengan kode
// valid — bukan saat validate, bukan saat transaksi gagal dibuat
// (bila Snap menolak setelah pemakaian dicatat, pemakaian dibatalkan).
// Harga akhir = harga paket - potongan (dibulatkan ke bawah); dijaga
// minimal Rp100 supaya tidak pernah Rp0.
const db = require('../db/database');

const CODE_RE = /^[A-Z0-9]{3,32}$/;

function normalizeCode(code) {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  return c || null;
}

function discountedPrice(priceIdr, percent) {
  const discount = Math.floor((priceIdr * percent) / 100);
  const final = priceIdr - discount;
  return final < 100 ? 100 : final;
}

function getDiscount(id) {
  return db.get().prepare('SELECT * FROM discount_codes WHERE id = ?').get(id) || null;
}

function findByCode(code) {
  const c = normalizeCode(code);
  if (!c) return null;
  return db.get().prepare('SELECT * FROM discount_codes WHERE code = ?').get(c) || null;
}

function listDiscounts() {
  return db.get().prepare('SELECT * FROM discount_codes ORDER BY created_at DESC, id DESC').all();
}

// Validasi kode untuk satu paket. Mengembalikan
// { ok: true, discount, plan, original_price, percent, final_price }
// atau { ok: false, message } (pesan Indonesia, aman ditampilkan).
function validateDiscount({ planId, code }) {
  const c = normalizeCode(code);
  if (!c || !CODE_RE.test(c)) {
    return { ok: false, message: 'Kode diskon tidak valid.' };
  }
  const d = findByCode(c);
  if (!d) return { ok: false, message: 'Kode diskon tidak ditemukan.' };
  if (Number(d.active) !== 1) return { ok: false, message: 'Kode diskon sudah tidak aktif.' };
  if (d.expires_at && d.expires_at <= Math.floor(Date.now() / 1000)) {
    return { ok: false, message: 'Kode diskon sudah kedaluwarsa.' };
  }
  if (d.max_uses !== null && d.max_uses !== undefined && d.used_count >= d.max_uses) {
    return { ok: false, message: 'Kode diskon sudah habis dipakai.' };
  }
  if (d.plan_id !== null && d.plan_id !== undefined && Number(d.plan_id) !== Number(planId)) {
    return { ok: false, message: 'Kode diskon tidak berlaku untuk paket ini.' };
  }
  const plan = db.get().prepare('SELECT * FROM plans WHERE id = ? AND active = 1').get(planId);
  if (!plan) return { ok: false, message: 'Paket tidak ditemukan.' };
  return {
    ok: true,
    discount: d,
    plan,
    original_price: plan.price_idr,
    percent: d.percent,
    final_price: discountedPrice(plan.price_idr, d.percent),
  };
}

// Naikkan used_count hanya bila masih di bawah max_uses (cek atomik di
// WHERE — dua permintaan bersamaan tidak bisa sama-sama lolos batas).
// Mengembalikan true bila pemakaian tercatat.
function reserveUse(discountId) {
  const res = db.get().prepare(
    `UPDATE discount_codes SET used_count = used_count + 1
     WHERE id = ? AND (max_uses IS NULL OR used_count < max_uses)`
  ).run(discountId);
  return res.changes === 1;
}

// Batalkan satu pemakaian (transaksi yang sudah memesan kode ternyata
// gagal dibuat, mis. Snap menolak setelah pemakaian dicatat).
function releaseUse(discountId) {
  db.get().prepare('UPDATE discount_codes SET used_count = MAX(0, used_count - 1) WHERE id = ?').run(discountId);
}

function createDiscount({ code, percent, planId, maxUses, expiresAt, active }) {
  const now = Math.floor(Date.now() / 1000);
  // Hati-hati: active bisa 0 (angka) atau false — keduanya berarti
  // nonaktif. Perbandingan === false saja salah: 0 === false bernilai
  // false sehingga kode yang dibuat nonaktif akan tersimpan aktif.
  const activeFlag = (active === 0 || active === false) ? 0 : 1;
  const res = db.get().prepare(
    `INSERT INTO discount_codes (code, percent, plan_id, max_uses, used_count, expires_at, active, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(code, percent, planId ?? null, maxUses ?? null, expiresAt ?? null, activeFlag, now);
  return getDiscount(res.lastInsertRowid);
}

function updateDiscount(id, patch) {
  const sets = [];
  const args = [];
  if (patch.code !== undefined) { sets.push('code = ?'); args.push(patch.code); }
  if (patch.percent !== undefined) { sets.push('percent = ?'); args.push(patch.percent); }
  if (patch.plan_id !== undefined) { sets.push('plan_id = ?'); args.push(patch.plan_id); }
  if (patch.max_uses !== undefined) { sets.push('max_uses = ?'); args.push(patch.max_uses); }
  if (patch.expires_at !== undefined) { sets.push('expires_at = ?'); args.push(patch.expires_at); }
  if (patch.active !== undefined) { sets.push('active = ?'); args.push(patch.active ? 1 : 0); }
  if (sets.length === 0) return getDiscount(id);
  args.push(id);
  db.get().prepare(`UPDATE discount_codes SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return getDiscount(id);
}

function deleteDiscount(id) {
  const res = db.get().prepare('DELETE FROM discount_codes WHERE id = ?').run(id);
  return res.changes === 1;
}

module.exports = {
  CODE_RE,
  normalizeCode,
  discountedPrice,
  getDiscount,
  findByCode,
  listDiscounts,
  validateDiscount,
  reserveUse,
  releaseUse,
  createDiscount,
  updateDiscount,
  deleteDiscount,
};
