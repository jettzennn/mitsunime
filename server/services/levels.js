'use strict';
// Sistem level + EXP (v1.3.1, diputuskan user 2026-11-15 ~16:22 WIB).
// ANGKA FINAL (klarifikasi user 2026-11-15 ~16:26 WIB): kembali ke angka
// semula — revisi 100 EXP/episode + cap 1000 DIBATALKAN (cap 1000 terlalu
// berat buat pengguna gratis). Jangan ubah lagi tanpa instruksi baru.
// Aturan:
// - Level pengguna maks 100; admin SELALU level 1000 (khusus admin,
//   di atas cap pengguna).
// - Setiap 100 EXP = 1 level: level = min(100, floor(exp_total/100)+1).
// - Menonton: +10 EXP setiap menyelesaikan satu episode, hanya SEKALI
//   per episode per pengguna (tonton ulang episode yang sama = 0 EXP).
// SEMUA ANGKA EXP adalah konstanta di file ini (EXP_PER_EPISODE,
// EXP_PER_LEVEL, MAX_USER_LEVEL) supaya mudah diubah di
// update berikutnya tanpa menyentuh logika lain.
// Nol dependensi; semua fungsi sinkron (node:sqlite).
const dbModule = require('../db/database');

const EXP_PER_EPISODE = 10;
const EXP_PER_LEVEL = 100;
const MAX_USER_LEVEL = 100;
const ADMIN_LEVEL = 1000;

function levelFromExp(expTotal) {
  const exp = Math.max(0, Math.floor(expTotal || 0));
  return Math.min(MAX_USER_LEVEL, Math.floor(exp / EXP_PER_LEVEL) + 1);
}

// Info level untuk satu baris user { role, exp_total }.
// Level 100 (maks) tidak punya level berikut: exp_for_next 0, progress 1.
function levelInfo(user) {
  const exp = Math.max(0, Math.floor((user && user.exp_total) || 0));
  if (user && user.role === 'admin') {
    return { level: ADMIN_LEVEL, exp_total: exp, exp_for_next: 0, progress: 1 };
  }
  const level = levelFromExp(exp);
  if (level >= MAX_USER_LEVEL) {
    return { level, exp_total: exp, exp_for_next: 0, progress: 1 };
  }
  const intoLevel = exp % EXP_PER_LEVEL;
  return {
    level,
    exp_total: exp,
    exp_for_next: EXP_PER_LEVEL - intoLevel,
    progress: Math.round((intoLevel / EXP_PER_LEVEL) * 100) / 100,
  };
}

// Tambah EXP ke pengguna. Sinkron tanpa await di jalur kritis — di
// runtime Node satu-proses ini dua panggilan tidak bisa saling menyela
// di tengah fungsi, jadi baca-tambah-tulis tidak balapan (alasan yang
// sama dengan perbaikan N3 pada confirm OTP).
function addExp(userId, amount) {
  const db = dbModule.get();
  const before = db.prepare('SELECT exp_total FROM users WHERE id = ?').get(userId);
  const beforeExp = before ? Math.max(0, before.exp_total || 0) : 0;
  const afterExp = beforeExp + amount;
  db.prepare('UPDATE users SET exp_total = ? WHERE id = ?').run(afterExp, userId);
  const levelBefore = levelFromExp(beforeExp);
  const levelAfter = levelFromExp(afterExp);
  return {
    exp_gained: amount,
    exp_total: afterExp,
    level: levelAfter,
    leveled_up: levelAfter > levelBefore,
  };
}

// EXP menonton: +10 per episode, SEKALI per episode per pengguna.
// INSERT OR IGNORE + PRIMARY KEY (user_id, anime_id, episode) menjamin
// tonton ulang episode yang sama = 0 EXP.
function awardWatchExp(userId, animeId, episode) {
  const db = dbModule.get();
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO episode_exp_awards (user_id, anime_id, episode, awarded_at) VALUES (?, ?, ?, ?)',
  ).run(userId, animeId, episode, now);
  if (ins.changes === 1) return addExp(userId, EXP_PER_EPISODE);
  const row = db.prepare('SELECT exp_total FROM users WHERE id = ?').get(userId);
  const exp = row ? Math.max(0, row.exp_total || 0) : 0;
  return { exp_gained: 0, exp_total: exp, level: levelFromExp(exp), leveled_up: false };
}

module.exports = {
  EXP_PER_EPISODE, EXP_PER_LEVEL, MAX_USER_LEVEL, ADMIN_LEVEL,
  levelFromExp, levelInfo,
  addExp, awardWatchExp,
};
