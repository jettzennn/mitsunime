'use strict';
// Auth Mitsunime (task-06): hash password, sesi server-side, cookie.
// Nol dependensi: hash memakai scrypt bawaan Node (node:crypto).
//
// KEPUTUSAN HASH — PRD §3 menyebut Argon2id/bcrypt, tetapi keduanya butuh
// modul native (node-gyp) yang tidak bisa dikirim di dalam zip untuk
// Termux aarch64 dan rawan gagal pasang di HP. scrypt adalah KDF kuat
// yang sudah bawaan Node, tanpa build apa pun. Format hash berversi
// ("scrypt$v1$N$r$p$salt$hash") sehingga migrasi ke Argon2id tetap bisa
// dilakukan nanti tanpa mereset akun pengguna.
const crypto = require('node:crypto');
const config = require('../config');
const dbModule = require('../db/database');
const logger = require('../utils/logger');

// Parameter scrypt: N=16384, r=8, p=1 (OWASP: N>=16384 untuk login interaktif).
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return [
    'scrypt', 'v1', String(SCRYPT_N), String(SCRYPT_R), String(SCRYPT_P),
    salt.toString('base64'), derived.toString('base64'),
  ].join('$');
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== 'v1') return false;
  const n = Number.parseInt(parts[2], 10);
  const r = Number.parseInt(parts[3], 10);
  const p = Number.parseInt(parts[4], 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  try {
    const salt = Buffer.from(parts[5], 'base64');
    const expected = Buffer.from(parts[6], 'base64');
    const derived = crypto.scryptSync(password, salt, expected.length, { N: n, r, p });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// --- Pengguna ---

function findUserByUsername(username) {
  return dbModule.get().prepare(
    'SELECT * FROM users WHERE username = ?',
  ).get(username) || null;
}

// v1.4.0: login memakai email. Pencarian tidak peka huruf besar/kecil,
// sama seperti jalur verifikasi/reset yang sudah ada.
function findUserByEmail(email) {
  return dbModule.get().prepare(
    'SELECT * FROM users WHERE lower(email) = lower(?)',
  ).get(String(email || '').trim()) || null;
}

function findUserById(id) {
  return dbModule.get().prepare(
    'SELECT * FROM users WHERE id = ?',
  ).get(id) || null;
}

function findUserByGoogleId(googleId) {
  if (!googleId) return null;
  return dbModule.get().prepare(
    'SELECT * FROM users WHERE google_id = ?',
  ).get(googleId) || null;
}

function countAdmins() {
  return dbModule.get().prepare(
    "SELECT COUNT(*) AS c FROM users WHERE role = 'admin'",
  ).get().c;
}

function createUser({ username, email, password, role = 'user' }) {
  const now = Math.floor(Date.now() / 1000);
  const result = dbModule.get().prepare(
    'INSERT INTO users (username, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(username, email || null, hashPassword(password), role, now);
  return findUserById(result.lastInsertRowid);
}

// Buat akun baru dari profil Google (v1.5.7, item 37): email sudah
// terverifikasi oleh Google (email_verified=1, tanpa OTP); provider =
// 'google'. Password diisi hash scrypt dari string acak 64 karakter
// yang dibuat di sini dan TIDAK disimpan di mana pun — login password
// untuk akun ini tidak bisa ditebak; bila pemilik mau password, ia
// memakai lupa password (reset lewat OTP email tetap jalan).
// googleId = nilai `sub` Google (stabil per akun); avatarUrl = URL
// foto Google (boleh null bila akun Google tanpa foto).
function createGoogleUser({ username, email, googleId, avatarUrl }) {
  const randomPassword = crypto.randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const result = dbModule.get().prepare(
    `INSERT INTO users (username, email, password_hash, role, email_verified,
       google_id, avatar_url, provider, created_at)
     VALUES (?, ?, ?, 'user', 1, ?, ?, 'google', ?)`,
  ).run(username, email, hashPassword(randomPassword), googleId, avatarUrl || null, now);
  return findUserById(result.lastInsertRowid);
}

// Tautkan akun password yang sudah ada ke Google (v1.5.7, item 37):
// Google sudah membuktikan kepemilikan email itu, jadi penautan aman.
// Provider TETAP 'password' (login password tetap berfungsi; kedua
// cara masuk berlaku). email_verified disetel 1. avatar_url hanya
// ditulis bila Google memberi foto (jangan menimpa foto yang sudah
// ada dengan NULL).
function linkGoogleAccount(userId, googleId, avatarUrl) {
  const db = dbModule.get();
  if (avatarUrl) {
    db.prepare(
      'UPDATE users SET google_id = ?, avatar_url = ?, email_verified = 1 WHERE id = ?',
    ).run(googleId, avatarUrl, userId);
  } else {
    db.prepare(
      'UPDATE users SET google_id = ?, email_verified = 1 WHERE id = ?',
    ).run(googleId, userId);
  }
  return findUserById(userId);
}

// Perbarui foto Google pengguna yang masuk ulang lewat Google (foto
// bisa berubah di akun Google-nya). Hanya bila ada foto baru.
function updateGoogleAvatar(userId, avatarUrl) {
  if (!avatarUrl) return;
  dbModule.get().prepare(
    'UPDATE users SET avatar_url = ? WHERE id = ?',
  ).run(avatarUrl, userId);
}

function touchLastLogin(userId) {
  dbModule.get().prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000), userId);
}

function changePassword(userId, newPassword) {
  dbModule.get().prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(newPassword), userId);
}

// Tampilan publik pengguna: TIDAK PERNAH memuat password_hash.
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    // Verifikasi email OTP (v1.3.0): 1 = sudah terverifikasi.
    email_verified: row.email_verified ? 1 : 0,
    role: row.role,
    // Level + EXP (v1.3.1): total EXP; level dihitung di services/levels.
    exp_total: row.exp_total || 0,
    // Avatar preset profil (v1.3.2): kode preset atau null (= default).
    avatar: row.avatar || null,
    // Login Google (v1.5.7, item 37): URL foto Google (null = tidak
    // ada foto → avatar huruf) + provider ('password' / 'google').
    // Frontend memakai avatar_url untuk menampilkan foto Google dan
    // menyembunyikan pemilih preset bila foto Google terisi.
    avatar_url: row.avatar_url || null,
    provider: row.provider || 'password',
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  };
}

// --- Sesi server-side (tabel sessions) ---

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  dbModule.get().prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(token, userId, now, now + config.SESSION_TTL_SECONDS);
  return token;
}

// Kembalikan baris user bila token valid dan belum kadaluarsa; hapus sesi
// kadaluarsa saat ditemukan. Mengembalikan null untuk token apa pun yang
// tidak dikenal — tanpa memberi tahu alasannya ke luar.
function getSessionUser(token) {
  if (!token || typeof token !== 'string' || token.length < 32) return null;
  const db = dbModule.get();
  const row = db.prepare(
    'SELECT s.*, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?',
  ).get(token);
  if (!row) return null;
  if (row.expires_at <= Math.floor(Date.now() / 1000)) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
    return null;
  }
  return publicUser(row);
}

function deleteSession(token) {
  if (!token) return;
  dbModule.get().prepare('DELETE FROM sessions WHERE id = ?').run(token);
}

function deleteUserSessions(userId) {
  dbModule.get().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// --- Cookie sesi ---
// v1.3.1 (G): dua nama cookie — sesi user (default COOKIE_NAME) dan sesi
// admin (ADMIN_COOKIE_NAME). Parameter `name` opsional; bila tidak diisi
// memakai cookie user seperti sebelumnya.

function setSessionCookie(res, token, name) {
  const parts = [
    `${name || config.COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${config.SESSION_TTL_SECONDS}`,
  ];
  if (config.COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res, name) {
  const parts = [
    `${name || config.COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (config.COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function setAdminSessionCookie(res, token) {
  return setSessionCookie(res, token, config.ADMIN_COOKIE_NAME);
}

function clearAdminSessionCookie(res) {
  return clearSessionCookie(res, config.ADMIN_COOKIE_NAME);
}

// Bersihkan sesi kadaluarsa (dipanggil berkala saat login/register; murah).
function pruneExpiredSessions() {
  try {
    const info = dbModule.get().prepare(
      'DELETE FROM sessions WHERE expires_at <= ?',
    ).run(Math.floor(Date.now() / 1000));
    if (info.changes > 0) logger.info(`Auth: ${info.changes} sesi kadaluarsa dibersihkan`);
  } catch { /* abaikan: pembersihan bukan penghalang login */ }
}

module.exports = {
  hashPassword, verifyPassword,
  findUserByUsername, findUserByEmail, findUserById, findUserByGoogleId, countAdmins,
  createUser, createGoogleUser, linkGoogleAccount, updateGoogleAvatar,
  touchLastLogin, changePassword, publicUser,
  createSession, getSessionUser, deleteSession, deleteUserSessions,
  setSessionCookie, clearSessionCookie,
  setAdminSessionCookie, clearAdminSessionCookie,
  pruneExpiredSessions,
};
