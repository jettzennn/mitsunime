'use strict';
// Penjaga rute admin tersembunyi (task-08): rute admin HANYA hidup bila
// path cocok persis dengan ADMIN_PATH dari .env (token acak, tanpa default
// yang bisa ditebak). Bila ADMIN_PATH kosong di .env, rute admin tidak
// hidup sama sekali (semua path → 404 biasa dari server).
// Path yang salah TIDAK memberi petunjuk apa pun: server mengembalikan 404
// biasa, sama seperti halaman yang memang tidak ada.
const config = require('../config');

function adminBase() {
  const p = (config.ADMIN_PATH || '').trim();
  if (!p) return null;
  return p.endsWith('/') && p.length > 1 ? p.slice(0, -1) : p;
}

// true bila pathname ini berada di bawah rute admin (halaman atau API-nya).
function isAdminPath(pathname) {
  const base = adminBase();
  if (!base) return false;
  return pathname === base || pathname.startsWith(base + '/');
}

// Bagian path setelah ADMIN_PATH, mis. "/api/transactions" atau "".
function adminSubPath(pathname) {
  const base = adminBase();
  if (!base) return null;
  if (pathname === base) return '/';
  if (pathname.startsWith(base + '/')) return pathname.slice(base.length);
  return null;
}

module.exports = { adminBase, isAdminPath, adminSubPath };
