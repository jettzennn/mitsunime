'use strict';
// Middleware auth (task-06/08): parse cookie, lampirkan pengguna bila ada
// sesi valid, dan penjaga rute login/admin. Nol dependensi.
const config = require('../config');
const auth = require('../services/auth');

// Batas percobaan login: 10 kali gagal per IP per 15 menit, lalu 429.
// In-memory (satu proses, server kecil); cukup untuk Termux lokal.
// Catatan: IP dilihat dari socket (tanpa proxy tepercaya). Bila nanti ada
// reverse proxy, isi X-Forwarded-For HANYA dari proxy tepercaya.
const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const _fails = new Map(); // ip -> { count, firstAt }

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function loginBlocked(ip) {
  const rec = _fails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > LOGIN_WINDOW_MS) { _fails.delete(ip); return false; }
  return rec.count >= LOGIN_MAX_FAILS;
}

function recordLoginFail(ip) {
  const now = Date.now();
  const rec = _fails.get(ip);
  if (!rec || now - rec.firstAt > LOGIN_WINDOW_MS) {
    _fails.set(ip, { count: 1, firstAt: now });
    return;
  }
  rec.count += 1;
}

function recordLoginOk(ip) {
  _fails.delete(ip);
}

// Bersihkan entri lama sesekali (hindari Map tumbuh tanpa batas).
function pruneFailMap() {
  const now = Date.now();
  for (const [ip, rec] of _fails) {
    if (now - rec.firstAt > LOGIN_WINDOW_MS) _fails.delete(ip);
  }
}

// --- Rate limit umum (perbaiki M3) ---
// Pembatas per kunci + jendela, pola sama dengan batas login: Map
// in-memory per proses. Dipakai endpoint tulis (register, transaksi,
// confirm, favorit, progres, aksi admin) dan endpoint baca
// yang memicu panggilan ke Anikoto (cache-miss /api/series + stream).
// Kunci membedakan pemanggil (IP untuk tamu, id pengguna untuk yang
// sudah login) supaya satu penyerang tidak memblokir semua orang.
const _rate = new Map(); // key -> { count, firstAt, windowMs }

function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const rec = _rate.get(key);
  if (!rec || now - rec.firstAt > rec.windowMs) {
    _rate.set(key, { count: 1, firstAt: now, windowMs });
    return false;
  }
  rec.count += 1;
  return rec.count > max;
}

function pruneRateMap() {
  const now = Date.now();
  for (const [key, rec] of _rate) {
    if (now - rec.firstAt > rec.windowMs) _rate.delete(key);
  }
}
setInterval(() => { pruneFailMap(); pruneRateMap(); }, 5 * 60 * 1000).unref();

// Periksa batas; bila terlampaui kirim 429 dan kembalikan false.
// Bila masih boleh, kembalikan true. Dipakai di awal handler.
function enforceRateLimit(req, res, key, max, windowMs, message) {
  if (rateLimited(key, max, windowMs)) {
    sendJson(res, 429, { ok: false, message: message || 'Terlalu banyak permintaan. Coba lagi sebentar lagi.' });
    return false;
  }
  return true;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers && req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

// Lampirkan req.user bila cookie sesi user valid; TIDAK menolak bila
// tidak ada (dipakai rute publik yang menyesuaikan tampilan, mis.
// /api/series). v1.3.1 (G): lampirkan JUGA req.adminUser dari cookie
// sesi admin yang BERBEDA — login admin tidak boleh menimpa sesi user
// biasa di browser yang sama (satu origin, satu nama cookie sebelumnya
// membuat halaman akun berubah identitas setelah login admin + refresh).
function attachUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[config.COOKIE_NAME];
  req.user = token ? auth.getSessionUser(token) : null;
  req.sessionToken = token || null;
  const adminToken = cookies[config.ADMIN_COOKIE_NAME];
  req.adminUser = adminToken ? auth.getSessionUser(adminToken) : null;
  req.adminSessionToken = adminToken || null;
  return req.user;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

// Wajib login. Bila bukan → 401 dengan pesan generik (tanpa detail).
function requireLogin(req, res) {
  attachUser(req);
  if (!req.user) {
    sendJson(res, 401, { ok: false, message: 'Anda harus login terlebih dahulu.' });
    return false;
  }
  return true;
}

// Wajib login sebagai admin (role 'admin'). Bila bukan → 403 generik.
// Dipakai endpoint admin; penjaga path tersembunyi ada di adminPath.js.
// v1.3.1 (G): jalur utama memakai cookie sesi admin (req.adminUser).
// Bila tidak ada sesi admin, fallback ke cookie user dengan role admin
// (admin yang masuk lewat form login biasa tetap bisa memakai endpoint
// admin, seperti sebelum pemisahan cookie). Bila memakai cookie admin,
// req.user disamakan dengan admin supaya handler admin (audit log,
// rate limit admin-write, /api/me) tetap jalan tanpa perubahan.
function requireAdmin(req, res) {
  attachUser(req);
  if (req.adminUser) {
    if (req.adminUser.role !== 'admin') {
      sendJson(res, 403, { ok: false, message: 'Akses ditolak.' });
      return false;
    }
    req.user = req.adminUser;
    return true;
  }
  if (!req.user) {
    sendJson(res, 401, { ok: false, message: 'Anda harus login terlebih dahulu.' });
    return false;
  }
  if (req.user.role !== 'admin') {
    sendJson(res, 403, { ok: false, message: 'Akses ditolak.' });
    return false;
  }
  return true;
}

module.exports = {
  parseCookies, attachUser, requireLogin, requireAdmin, sendJson,
  clientIp, loginBlocked, recordLoginFail, recordLoginOk,
  rateLimited, enforceRateLimit,
};
