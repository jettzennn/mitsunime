'use strict';
// Aksesori profil Mitsunime (task-07): katalog + kepemilikan + pemakaian.
// Premium v1 = aksesori profil saja (keputusan pengguna 2026-11-15 ~06:55
// WIB): border, background, bingkai avatar, lencana, efek nama.
// Aksesori premium_only hanya bisa dipakai saat premium aktif; bila
// premium habis, pemakaiannya diblokir (kepemilikan tetap tersimpan).
const dbModule = require('../db/database');
const premiumStatus = require('./premiumStatus');

const KINDS = ['border', 'background', 'frame', 'badge', 'name_effect'];
const EQUIPPED_COL = {
  border: 'equipped_border',
  background: 'equipped_background',
  frame: 'equipped_frame',
  badge: 'equipped_badge',
  name_effect: 'equipped_name_effect',
};

function listCatalog({ onlyActive = true } = {}) {
  const sql = onlyActive
    ? 'SELECT * FROM accessories WHERE active = 1 ORDER BY kind, id'
    : 'SELECT * FROM accessories ORDER BY kind, id';
  return dbModule.get().prepare(sql).all();
}

function getAccessory(id) {
  return dbModule.get().prepare('SELECT * FROM accessories WHERE id = ?').get(id) || null;
}

function ownsAccessory(userId, accessoryId) {
  const row = dbModule.get().prepare(
    'SELECT 1 AS x FROM user_accessories WHERE user_id = ? AND accessory_id = ?',
  ).get(userId, accessoryId);
  return !!row;
}

// Berikan seluruh aksesori premium yang aktif ke pengguna (dipanggil saat
// premium disetujui/diberikan). INSERT OR IGNORE: aman dipanggil ulang.
function grantPremiumSet(userId) {
  const rows = dbModule.get().prepare(
    "SELECT id FROM accessories WHERE premium_only = 1 AND active = 1",
  ).all();
  const now = Math.floor(Date.now() / 1000);
  const stmt = dbModule.get().prepare(
    'INSERT OR IGNORE INTO user_accessories (user_id, accessory_id, acquired_at) VALUES (?, ?, ?)',
  );
  let granted = 0;
  for (const r of rows) {
    const info = stmt.run(userId, r.id, now);
    granted += info.changes;
  }
  return granted;
}

// Daftar aksesori yang dibuka satu paket (tiering v1.2.0). Hanya aksesori
// aktif, urut id. Paket tanpa pemetaan (mis. buatan admin) → [].
function listPlanAccessories(planId) {
  if (!Number.isFinite(planId)) return [];
  return dbModule.get().prepare(
    `SELECT a.id, a.name, a.kind FROM accessories a
     JOIN plan_accessories pa ON pa.accessory_id = a.id
     WHERE pa.plan_id = ? AND a.active = 1 ORDER BY a.id`,
  ).all(planId);
}

// Berikan aksesori sesuai tier paket (dipanggil saat premium disetujui /
// diberikan). INSERT OR IGNORE: aman dipanggil ulang; bila pengguna
// upgrade ke tier lebih tinggi, aksesori yang belum dimiliki ditambahkan
// dan yang sudah ada TIDAK dicabut. Bila paket tidak punya pemetaan
// (buatan admin), beri seluruh set premium (perilaku lama) supaya admin
// tidak memberi premium tanpa aksesori.
function grantPlanAccessories(userId, planId) {
  const rows = listPlanAccessories(planId);
  if (!rows.length) return grantPremiumSet(userId);
  const now = Math.floor(Date.now() / 1000);
  const stmt = dbModule.get().prepare(
    'INSERT OR IGNORE INTO user_accessories (user_id, accessory_id, acquired_at) VALUES (?, ?, ?)',
  );
  let granted = 0;
  for (const r of rows) {
    const info = stmt.run(userId, r.id, now);
    granted += info.changes;
  }
  return granted;
}

function listOwned(userId) {
  return dbModule.get().prepare(
    `SELECT a.*, ua.acquired_at FROM accessories a
     JOIN user_accessories ua ON ua.accessory_id = a.id
     WHERE ua.user_id = ? ORDER BY a.kind, a.id`,
  ).all(userId);
}

// Aksesori yang sedang dipakai pengguna, dengan aturan premium ditegakkan:
// aksesori premium_only HANYA tampil bila premium aktif. Mengembalikan
// objek { border, background, frame, badge, name_effect } (null bila kosong).
function getEquipped(userId) {
  const user = dbModule.get().prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const active = premiumStatus.isPremiumActive(user);
  const out = {};
  for (const kind of KINDS) {
    const accId = user[EQUIPPED_COL[kind]];
    if (!accId) { out[kind] = null; continue; }
    const acc = getAccessory(accId);
    if (!acc) { out[kind] = null; continue; }
    if (acc.premium_only && !active) { out[kind] = null; continue; }
    out[kind] = acc;
  }
  return out;
}

// Pakai aksesori. Syarat: pengguna memilikinya; bila premium_only, premium
// harus aktif. Mengembalikan { kind, accessory } atau throw Error bermesan.
// Satu aksesori per jenis: memakai yang baru menggantikan yang lama.
function equip(userId, accessoryId) {
  const acc = getAccessory(accessoryId);
  if (!acc) throw new Error('Aksesori tidak ditemukan.');
  if (!acc.active) throw new Error('Aksesori ini sedang tidak aktif.');
  if (!ownsAccessory(userId, accessoryId)) {
    throw new Error('Anda belum memiliki aksesori ini.');
  }
  const user = dbModule.get().prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('Pengguna tidak ditemukan.');
  if (acc.premium_only && !premiumStatus.isPremiumActive(user)) {
    throw new Error('Aksesori ini hanya untuk pengguna Premium yang masih aktif.');
  }
  dbModule.get().prepare(
    `UPDATE users SET ${EQUIPPED_COL[acc.kind]} = ? WHERE id = ?`,
  ).run(accessoryId, userId);
  return { kind: acc.kind, accessory: acc };
}

// Lepas aksesori pada satu jenis.
function unequip(userId, kind) {
  if (!KINDS.includes(kind)) throw new Error('Jenis aksesori tidak dikenal.');
  dbModule.get().prepare(
    `UPDATE users SET ${EQUIPPED_COL[kind]} = NULL WHERE id = ?`,
  ).run(userId);
  return { kind };
}

module.exports = {
  KINDS, listCatalog, getAccessory, ownsAccessory,
  grantPremiumSet, grantPlanAccessories, listPlanAccessories,
  listOwned, getEquipped, equip, unequip,
};
