'use strict';
// Pembayaran premium MANUAL QRIS (keputusan pengguna 2026-11-15 ~07:52 WIB):
// cara bayar utama menjadi QRIS manual — admin menampilkan gambar kode
// QRIS (dari DANA Bisnis atau penyedia QRIS mana pun), pembeli memindai
// dan membayar di aplikasi pembayarannya sendiri, lalu admin menyetujui
// transaksi setelah memeriksa bukti bayar + mutasi di aplikasinya.
// Midtrans TETAP ada sebagai opsi (adapter di services/payment.js) —
// modul ini TIDAK mengubah alur Midtrans sama sekali (termasuk aturan
// monotonik M1/N1 di routes/premium.js).
//
// Arsip:
// - Gambar kode QRIS: data/qris/ (BUKAN folder publik — hanya dibaca
//   lewat endpoint ber-login).
// - Gambar bukti bayar pengguna: data/proofs/ (BUKAN folder publik;
//   hanya dibaca admin lewat endpoint admin).
//
// Keamanan:
// - Gambar diterima sebagai base64 di JSON (server hanya mem-parse JSON).
// - Tipe dipastikan dari MAGIC BYTES, bukan dari label data-URL (label
//   bisa berbohong). Hanya JPG, PNG, WebP.
// - Ukuran hasil decode maksimal 2 MB (lebih dari itu → 413).
// - Nama file acak 128-bit (crypto.randomBytes) sehingga tidak bisa
//   ditebak dari luar; jalur file selalu divalidasi tetap di dalam
//   direktorinya (cegah path traversal).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dbModule = require('../db/database');
const config = require('../config');
const logger = require('../utils/logger');

const QRIS_DIR = path.join(config.ROOT, 'data', 'qris');
const PROOFS_DIR = path.join(config.ROOT, 'data', 'proofs');
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB hasil decode
const QRIS_MAX_BYTES = MAX_IMAGE_BYTES; // kode QRIS memakai batas yang sama

function nowSec() { return Math.floor(Date.now() / 1000); }

function imageError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Deteksi tipe dari magic bytes. Mengembalikan { ext, mime } atau null.
function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return { ext: 'png', mime: 'image/png' };
  }
  // WebP: "RIFF" + 4 byte ukuran + "WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

// Terima string gambar: data URL ("data:image/png;base64,...") ATAU
// base64 mentah. Kembalikan { buf, ext, mime }.
// Melempar imageError(400) bila format tidak didukung, (413) bila
// ukuran hasil decode melebihi batas.
function parseImageData(input, maxBytes, label) {
  if (typeof input !== 'string' || !input.trim()) {
    throw imageError(400, `${label} tidak valid.`);
  }
  const text = input.trim();
  let b64 = text;
  let claimed = null;
  const dataUrl = text.match(/^data:image\/([a-zA-Z]+);base64,([A-Za-z0-9+/=]+)$/);
  if (dataUrl) {
    claimed = dataUrl[1].toLowerCase();
    b64 = dataUrl[2];
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(claimed)) {
      throw imageError(400, `${label} harus JPG, PNG, atau WebP.`);
    }
  } else if (!/^[A-Za-z0-9+/=]+$/.test(text)) {
    throw imageError(400, `${label} harus base64 (atau data URL gambar).`);
  }
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    throw imageError(400, `${label} bukan base64 yang valid.`);
  }
  if (!buf.length) throw imageError(400, `${label} kosong.`);
  if (buf.length > maxBytes) {
    throw imageError(413, `${label} terlalu besar (maksimal ${Math.round(maxBytes / (1024 * 1024))} MB).`);
  }
  const detected = detectImageType(buf);
  if (!detected) {
    throw imageError(400, `${label} harus JPG, PNG, atau WebP.`);
  }
  // Label data URL harus cocok dengan isi sebenarnya.
  if (claimed) {
    const claimedExt = claimed === 'jpeg' ? 'jpg' : claimed;
    if (claimedExt !== detected.ext) {
      throw imageError(400, `${label}: jenis gambar di label tidak cocok dengan isi file.`);
    }
  }
  return { buf, ext: detected.ext, mime: detected.mime };
}

function randomName(prefix, ext) {
  return `${prefix}-${crypto.randomBytes(16).toString('hex')}.${ext}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readSetting(key) {
  const row = dbModule.get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function writeSetting(key, value) {
  dbModule.get().prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(key, value, nowSec());
}

// Info QRIS dari settings: { merchant_name, file } (file = nama file saja).
function getQrisInfo() {
  const merchantName = readSetting('qris_merchant_name');
  const file = readSetting('qris_image');
  if (!file) return { merchant_name: merchantName || null, file: null };
  const full = resolveStoredFile(QRIS_DIR, file);
  if (!full) return { merchant_name: merchantName || null, file: null };
  return { merchant_name: merchantName || null, file };
}

// Gateway aktif menurut settings (dipakai Frontend untuk memilih alur
// bayar yang ditampilkan). 'manual' (default baru) atau 'midtrans'.
function getPaymentGateway() {
  const v = readSetting('payment_gateway');
  return v === 'midtrans' ? 'midtrans' : 'manual';
}

// Simpan gambar kode QRIS baru (validasi + ganti file lama). Mengembalikan
// nama file yang disimpan. Image wajib string base64/data URL.
function saveQrisImage(input) {
  const { buf, ext } = parseImageData(input, QRIS_MAX_BYTES, 'Gambar kode QRIS');
  ensureDir(QRIS_DIR);
  const old = readSetting('qris_image');
  const name = randomName('qris', ext);
  fs.writeFileSync(path.join(QRIS_DIR, name), buf);
  writeSetting('qris_image', name);
  if (old && old !== name) {
    try { fs.unlinkSync(path.join(QRIS_DIR, old)); } catch { /* file lama sudah tidak ada */ }
  }
  logger.info(`Kode QRIS disimpan: ${name}`);
  return name;
}

// Simpan gambar bukti bayar (validasi saja + tulis file). Mengembalikan
// nama file yang disimpan.
function saveProofImage(input) {
  const { buf, ext } = parseImageData(input, MAX_IMAGE_BYTES, 'Gambar bukti bayar');
  ensureDir(PROOFS_DIR);
  const name = randomName('proof', ext);
  fs.writeFileSync(path.join(PROOFS_DIR, name), buf);
  return name;
}

// Resolve nama file di dalam direktori penyimpanan dengan aman.
// Mengembalikan path absolut bila nama valid DAN file ada, selain itu null.
function resolveStoredFile(dir, filename) {
  if (typeof filename !== 'string' || !/^[A-Za-z0-9-]+\.(jpg|jpeg|png|webp)$/.test(filename)) {
    return null;
  }
  const full = path.resolve(dir, filename);
  if (!full.startsWith(dir + path.sep)) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return full;
}

function resolveQrisFile(filename) {
  return resolveStoredFile(QRIS_DIR, filename);
}

function resolveProofFile(filename) {
  return resolveStoredFile(PROOFS_DIR, filename);
}

function mimeForExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

module.exports = {
  QRIS_DIR,
  PROOFS_DIR,
  MAX_IMAGE_BYTES,
  parseImageData,
  saveQrisImage,
  saveProofImage,
  getQrisInfo,
  getPaymentGateway,
  getSetting: readSetting,
  writeSetting,
  resolveQrisFile,
  resolveProofFile,
  mimeForExt,
};
