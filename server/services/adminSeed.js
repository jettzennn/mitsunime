'use strict';
// Auto-seed admin (v1.3.0): saat server pertama kali start, bila belum
// ada akun admin DAN .env berisi ADMIN_USER + ADMIN_PASS (keduanya
// terisi), buat akun admin dari nilai itu secara otomatis — supaya
// pengguna tidak perlu mengetik username/password admin manual di tiap
// instalasi.
// - Bila salah satu kosong → lewati diam-diam (seed-admin.js CLI tetap
//   berfungsi seperti biasa).
// - Bila sudah ada admin → lewati (satu admin saja, seperti seed CLI).
// - Password TIDAK PERNAH ditulis ke log.
// - Username/password mengikuti aturan yang sama seperti seed CLI
//   (username 3-32 karakter huruf/angka/_/-, password 8-128 karakter);
//   bila tidak memenuhi syarat, lewati dengan satu baris peringatan.
const config = require('../config');
const auth = require('./auth');
const logger = require('../utils/logger');

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

function autoSeedAdmin() {
  const username = (config.ADMIN_USER || '').trim();
  const password = config.ADMIN_PASS || '';
  if (!username || !password) return false; // lewati diam-diam
  if (auth.countAdmins() > 0) return false;
  if (!USERNAME_RE.test(username)) {
    logger.warn('Auto-seed admin dilewati: ADMIN_USER tidak valid (3-32 karakter, huruf, angka, "_" dan "-").');
    return false;
  }
  if (password.length < 8 || password.length > 128) {
    logger.warn('Auto-seed admin dilewati: ADMIN_PASS harus 8-128 karakter.');
    return false;
  }
  if (auth.findUserByUsername(username)) {
    logger.warn(`Auto-seed admin dilewati: username "${username}" sudah dipakai akun lain.`);
    return false;
  }
  const user = auth.createUser({ username, password, role: 'admin' });
  logger.info(`Admin otomatis dibuat dari .env (username: ${user.username}, id=${user.id}).`);
  return true;
}

module.exports = { autoSeedAdmin };
