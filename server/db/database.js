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
];

// Kolom task-06/07 untuk DB yang dibuat sebelum tugas itu ada.
const USERS_COLUMNS = [
  // Verifikasi email OTP (v1.3.0): 0 = belum terverifikasi.
  ['email_verified', 'INTEGER NOT NULL DEFAULT 0'],
  // Level + EXP (v1.3.1).
  ['exp_total', 'INTEGER NOT NULL DEFAULT 0'],
  // Avatar preset profil (v1.3.2): kode preset, NULL = default.
  ['avatar', 'TEXT'],
];

// Kolom login Google (v1.5.7, item 37 — PRD §5.2): google_id = nilai
// `sub` Google (stabil per akun); avatar_url = URL foto Google
// (NULL = tidak ada foto → avatar huruf); provider = 'password'
// (daftar biasa) atau 'google' (dibuat lewat Google). Akun password
// yang DITAUTKAN ke Google tetap provider='password' (kedua cara
// masuk berlaku) — lihat services/google.js.
// CATATAN SQLite: ALTER TABLE ADD COLUMN TIDAK BISA membawa UNIQUE
// ("Cannot add a UNIQUE column") — keunikan google_id ditegakkan
// lewat indeks unik (migrateGoogleIdIndex di bawah; jaminan sama,
// NULL ganda tetap diizinkan). PRD §5.2 menulis `google_id TEXT
// UNIQUE` untuk skema baru; perilaku yang ditegakkan identik.
const USERS_GOOGLE_COLUMNS = [
  ['google_id', 'TEXT'],
  ['avatar_url', 'TEXT'],
  ['provider', "TEXT NOT NULL DEFAULT 'password' CHECK (provider IN ('password', 'google'))"],
];

// Indeks unik google_id (lihat catatan di atas). Idempotent: hanya
// dibuat bila belum ada (tanpa log tiap boot).
function migrateGoogleIdIndex() {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'",
  ).get();
  if (!exists) return;
  const idx = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_google_id'",
  ).get();
  if (!idx) {
    db.exec('CREATE UNIQUE INDEX idx_users_google_id ON users(google_id)');
    logger.info('Migrasi: indeks unik idx_users_google_id dibuat');
  }
}

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

// v1.5.7 (item 35): hapus data fitur yang sudah tidak ada — 6 tabel,
// 8 kolom, 3 kunci settings. Idempotent: DROP TABLE IF EXISTS,
// hapus kolom HANYA bila PRAGMA table_info masih menemukannya
// (SQLite tidak punya DROP COLUMN IF EXISTS), dan DELETE kunci
// settings bila tabel settings sudah ada. Aman dijalankan berulang
// dan aman di DB baru yang sudah bersih (semua pemeriksaan no-op).
// Urutan di dalam dropRemovedData penting: kolom users.equipped_*
// dihapus DULU (membawa FOREIGN KEY ke accessories), baru tabel
// di-drop — dan FK dimatikan sementara selama blok itu, karena
// node:sqlite mengaktifkan foreign_keys secara default.
const DROPPED_TABLES = [
  'plans', 'discount_codes', 'premium_transactions',
  'accessories', 'user_accessories', 'plan_accessories',
];
const DROPPED_COLUMNS = [
  ['users', 'is_premium'],
  ['users', 'premium_until'],
  ['users', 'equipped_border'],
  ['users', 'equipped_background'],
  ['users', 'equipped_frame'],
  ['users', 'equipped_badge'],
  ['users', 'equipped_name_effect'],
  ['anime_cache', 'premium_only'],
];
const DROPPED_SETTING_KEYS = ['premium_new_days', 'payment_gateway', 'payment_methods'];

function dropRemovedData() {
  // Urutan penting + FK dimatikan sementara: kolom users.equipped_*
  // punya FOREIGN KEY ke accessories(id) — DROP TABLE accessories
  // gagal selama kolom itu masih ada (node:sqlite mengaktifkan
  // foreign_keys secara default). Hapus kolom dulu, baru tabel;
  // matikan FK selama blok ini, lalu kembalikan seperti semula.
  const fkBefore = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const [table, column] of DROPPED_COLUMNS) {
      const exists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table);
      if (!exists) continue;
      const cols = new Set(
        db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name),
      );
      if (cols.has(column)) {
        db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
        logger.info(`Migrasi: kolom ${table}.${column} dihapus`);
      }
    }
    for (const table of DROPPED_TABLES) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    const settingsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
    ).get();
    if (settingsExists) {
      const placeholders = DROPPED_SETTING_KEYS.map(() => '?').join(', ');
      const info = db.prepare(
        `DELETE FROM settings WHERE key IN (${placeholders})`,
      ).run(...DROPPED_SETTING_KEYS);
      if (info.changes > 0) logger.info(`Migrasi: ${info.changes} kunci settings lama dihapus`);
    }
  } finally {
    db.exec(`PRAGMA foreign_keys = ${fkBefore ? 'ON' : 'OFF'}`);
  }
}

function migrate() {
  migrateTable('anime_cache', ANIME_CACHE_COLUMNS);
  migrateTable('users', USERS_COLUMNS);
  migrateTable('users', USERS_GOOGLE_COLUMNS);
  migrateGoogleIdIndex();
  dropRemovedData();
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
  // baru (mis. users.email_verified), sementara schema.sql membuat
  // indeks di atas kolom itu — bila kolom belum ada, exec(schema)
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
