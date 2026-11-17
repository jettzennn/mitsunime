'use strict';
// Koneksi SQLite via modul BAWAAAN Node (node:sqlite, Node >= 22.5).
// Tanpa dependensi npm sama sekali — tidak ada better-sqlite3 / node-gyp
// yang rawan gagal dipasang di Termux HP. DatabaseSync itu sinkron;
// di server kecil satu-proses ini memadai dan jauh lebih sederhana
// daripada pool koneksi.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');
const logger = require('../utils/logger');

let db = null;

// Migrasi ringan: tambah kolom baru ke tabel lama bila belum ada.
// SQLite tidak mendukung ADD COLUMN IF NOT EXISTS, jadi dicek lewat PRAGMA.
// Ini menjaga file DB yang dibuat dari skema cache lama (NontonAnime)
// tetap bisa dipakai tanpa rebuild.
// (Tabel baru + seed INSERT OR IGNORE sudah idempotent lewat schema.sql
// yang dijalankan di setiap init, jadi yang perlu migrasi hanya kolom.)
const ANIME_CACHE_COLUMNS = [
  ['sub_indo', 'INTEGER NOT NULL DEFAULT 0'],
  ['sub_indo_verified_at', 'INTEGER'],
  ['premium_only', 'INTEGER NOT NULL DEFAULT 0'],
];

// Kolom task-06/07 untuk DB yang dibuat sebelum tugas itu ada.
const USERS_COLUMNS = [
  ['equipped_border', 'INTEGER REFERENCES accessories(id)'],
  ['equipped_background', 'INTEGER REFERENCES accessories(id)'],
  ['equipped_frame', 'INTEGER REFERENCES accessories(id)'],
  ['equipped_badge', 'INTEGER REFERENCES accessories(id)'],
  ['equipped_name_effect', 'INTEGER REFERENCES accessories(id)'],
  // Verifikasi email OTP (v1.3.0): 0 = belum terverifikasi.
  ['email_verified', 'INTEGER NOT NULL DEFAULT 0'],
  // Level + EXP (v1.3.1).
  ['exp_total', 'INTEGER NOT NULL DEFAULT 0'],
  // Avatar preset profil (v1.3.2): kode preset, NULL = default.
  ['avatar', 'TEXT'],
];
const TX_COLUMNS = [
  ['payment_status', "TEXT NOT NULL DEFAULT 'unpaid'"],
  ['gateway_order_id', 'TEXT'],
  ['gateway_status', 'TEXT'],
  ['payment_url', 'TEXT'],
  // Alur manual QRIS (v1.1.0): nama file bukti bayar di data/proofs/
  // (nama acak, tidak bisa ditebak). NULL bila transaksi Midtrans atau
  // transaksi manual tanpa bukti gambar.
  ['proof_file', 'TEXT'],
  // Diskon (v1.3.0): kode + persen + harga asli sebelum diskon.
  ['discount_code', 'TEXT'],
  ['discount_percent', 'INTEGER'],
  ['original_amount_idr', 'INTEGER'],
];

function migrateTable(table, columns) {
  // Bila tabel belum ada (DB baru — tabel dibuat sesudahnya oleh schema),
  // lewati: tidak ada yang perlu dimigrasi.
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table);
  if (!exists) return;
  const cols = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name),
  );
  for (const [name, type] of columns) {
    if (!cols.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      logger.info(`Migrasi: kolom ${table}.${name} ditambahkan`);
    }
  }
}

function migrate() {
  migrateTable('anime_cache', ANIME_CACHE_COLUMNS);
  migrateTable('users', USERS_COLUMNS);
  migrateTable('premium_transactions', TX_COLUMNS);
  migratePlans();
  migratePlanAccessories();
  migratePaymentGatewayDefault();
}

// v1.2.0: paket tambahan untuk DB yang sudah ada (DB baru sudah dapat
// seed yang sama dari schema.sql — migrasi ini idempotent dan aman
// dijalankan berulang, berbasis nama paket supaya tidak duplikasi dan
// tidak bentrok dengan paket buatan admin).
const NEW_PLANS_V120 = [
  ['Premium 7 Hari', 10000, 7,
    'Aksesori profil premium: bingkai dan latar profil (6 aksesori) selama 7 hari. Tidak ada konten yang terkunci.'],
  ['Premium 15 Hari', 19000, 15,
    'Aksesori profil premium: bingkai, latar, dan bingkai avatar (9 aksesori) selama 15 hari. Tidak ada konten yang terkunci.'],
];

function migratePlans() {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plans'",
  ).get();
  if (!exists) return;
  const stmt = db.prepare(`INSERT INTO plans (name, price_idr, duration_days, description)
    SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM plans WHERE name = ?)`);
  for (const [name, price, days, desc] of NEW_PLANS_V120) {
    const info = stmt.run(name, price, days, desc, name);
    if (info.changes) logger.info(`Migrasi: paket "${name}" ditambahkan`);
  }
  // Tiering v1.2.0: deskripsi paket 7/15 hari diperbarui mengikuti tier
  // benefit — HANYA bila deskripsi masih teks v1.2.0 lama. Edit admin
  // tidak pernah ditimpa (syarat description = teks lama).
  const DESC_UPDATES_V120 = [
    ['Premium 7 Hari',
      'Aksesori profil premium: bingkai dan latar profil (6 aksesori) selama 7 hari. Tidak ada konten yang terkunci.',
      'Aksesori profil premium: border, background, bingkai avatar, lencana, dan efek nama selama 7 hari. Tidak ada konten yang terkunci.'],
    ['Premium 15 Hari',
      'Aksesori profil premium: bingkai, latar, dan bingkai avatar (9 aksesori) selama 15 hari. Tidak ada konten yang terkunci.',
      'Aksesori profil premium: border, background, bingkai avatar, lencana, dan efek nama selama 15 hari. Tidak ada konten yang terkunci.'],
  ];
  const upd = db.prepare('UPDATE plans SET description = ? WHERE name = ? AND description = ?');
  for (const [name, next, prev] of DESC_UPDATES_V120) {
    const info = upd.run(next, name, prev);
    if (info.changes) logger.info(`Migrasi: deskripsi paket "${name}" diperbarui (tiering)`);
  }
}

// v1.2.0 (tiering benefit): pemetaan paket → aksesori. Idempotent,
// berbasis nama paket (id paket bisa berbeda di tiap DB) + PRIMARY KEY
// (plan_id, accessory_id) — dijalankan di setiap startup, restart
// berkali-kali tidak menduplikasi. Rentang id aksesori 1-14 tetap dari
// seed schema.sql (border 1-3, background 4-6, frame 7-9, badge 10-12,
// efek nama 13-14).
const PLAN_ACCESSORIES_V120 = [
  ['Premium 7 Hari', 1, 6],
  ['Premium 15 Hari', 1, 9],
  ['Premium 1 Bulan', 1, 14],
];

function migratePlanAccessories() {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plan_accessories'",
  ).get();
  if (!exists) return;
  const stmt = db.prepare(`INSERT OR IGNORE INTO plan_accessories (plan_id, accessory_id)
    SELECT p.id, a.id FROM plans p, accessories a
    WHERE p.name = ? AND a.id BETWEEN ? AND ?`);
  for (const [name, from, to] of PLAN_ACCESSORIES_V120) {
    const info = stmt.run(name, from, to);
    if (info.changes) logger.info(`Migrasi: pemetaan aksesori paket "${name}" ditambahkan (${info.changes} baris)`);
  }
}

// v1.1.0: cara bayar default menjadi MANUAL QRIS (keputusan pengguna
// 2026-11-15 ~07:52 WIB). Kunci settings payment_gateway TIDAK PERNAH
// dibaca kode apa pun di v1.0.0 — bukan bagian whitelist PUT dashboard
// dan config memakai .env PAYMENT_GATEWAY — jadi nilainya di DB lama
// pasti berasal dari seed ('midtrans'), bukan pilihan admin. Aman
// dialihkan ke 'manual' saat upgrade; admin yang mau Midtrans bisa
// mengubahnya kembali dari dashboard (PUT settings).
function migratePaymentGatewayDefault() {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
  ).get();
  if (!exists) return;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'payment_gateway'").get();
  if (row && row.value === 'midtrans') {
    db.prepare(
      "UPDATE settings SET value = 'manual', updated_at = ? WHERE key = 'payment_gateway'",
    ).run(Math.floor(Date.now() / 1000));
    logger.info('Migrasi: payment_gateway dialihkan ke manual (default v1.1.0)');
  }
}

function init(dbPath) {
  const file = dbPath || config.DB_PATH;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // URUTAN PENTING: migrate() dulu SEBELUM schema, lalu sesudahnya.
  // DB lama yang dibuat dari skema sebelum task-06/07 belum punya kolom
  // baru (mis. premium_transactions.gateway_order_id), sementara schema.sql
  // membuat indeks di atas kolom itu — bila kolom belum ada, exec(schema)
  // gagal dengan "no such column". migrate() pertama (no-op untuk DB baru,
  // karena tabel belum ada) menambahkan kolom ke tabel lama; migrate()
  // kedua bersifat idempotent dan melengkapi bila ada yang terlewat.
  migrate();
  db.exec(schema);
  migrate();
  logger.info(`Database siap: ${file}`);
  return db;
}

function get() {
  if (!db) init();
  return db;
}

function close() {
  if (db) { db.close(); db = null; }
}

module.exports = { init, get, close };
