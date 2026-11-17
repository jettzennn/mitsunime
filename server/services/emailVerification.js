'use strict';
// Verifikasi email OTP (v1.3.0).
//
// ATURAN AKTIF/NONAKTIF (keputusan pengguna 2026-11-15):
// - Verifikasi AKTIF hanya bila SMTP terkonfigurasi (SMTP_HOST +
//   SMTP_USER + SMTP_PASS terisi di .env). Bila tidak, register/login
//   jalan persis seperti v1.2.0 dan tidak ada pengguna yang terkunci.
// - Bila SMTP aktif: register membuat akun email_verified=0 lalu
//   mengirim OTP 6 digit (berlaku 1 menit); login DITOLAK sampai
//   email terverifikasi. Pengguna lama (email_verified default 0)
//   ikut aturan yang sama saat SMTP aktif.
// - Akun admin (role='admin', dibuat lewat CLI tanpa email) TIDAK
//   pernah diblokir verifikasi.
// - Kode disimpan sebagai SHA256 (bukan teks biasa): bocornya DB tidak
//   langsung membocorkan kode yang masih berlaku.
// - Kode benar 6 digit acak dari crypto.randomInt (bukan Math.random).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db/database');
const mailer = require('./mailer');
const emailCheck = require('./emailCheck');
const logger = require('../utils/logger');
const config = require('../config');

// v1.4.1 (keputusan pengguna 2026-11-17): kode verifikasi berlaku
// 1 menit — "buat kode berlaku 1 menit sebelum kadaluarsa". Aturan
// lama 10 menit (v1.3.3) dicabut atas permintaan pengguna.
const OTP_TTL_SECONDS = 60; // 1 menit — kode verifikasi email
// Tautan reset password BUKAN kode verifikasi: tetap 10 menit
// (pengguna butuh waktu membuka inbox lalu mengisi password baru).
const RESET_TTL_SECONDS = 600; // 10 menit — tautan reset password
const OTP_MAX_ATTEMPTS = 5; // 5 percobaan salah -> kode hangus
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Logo surat sebagai gambar (v1.4.1): font display Anton tidak bisa
// dimuat Gmail dari luar, jadi logo dirender jadi PNG (Anton, lime
// #c7f632, latar transparan, 2x retina) dan dilampirkan sebagai CID —
// tampil sama persis seperti logo website di semua klien email.
// Bila berkas tidak ada (mis. zip lama), surat tetap terkirim
// dengan teks logo sebagai fallback (alt "MITSUNIME").
const LOGO_CID = 'logo-mitsunime';
const LOGO_IMG_WIDTH = 203; // setengah lebar PNG 407px (retina 2x)
let logoAttachmentCache = null;
let logoAttachmentTried = false;
function logoAttachment() {
  if (logoAttachmentTried) return logoAttachmentCache;
  logoAttachmentTried = true;
  try {
    const content = fs.readFileSync(path.join(__dirname, '..', 'assets', 'logo-email.png'));
    logoAttachmentCache = [{
      filename: 'logo-email.png',
      contentType: 'image/png',
      contentId: LOGO_CID,
      content,
    }];
  } catch (e) {
    logger.warn('Logo email tidak ditemukan (server/assets/logo-email.png); surat dikirim dengan logo teks.');
    logoAttachmentCache = [];
  }
  return logoAttachmentCache;
}

function isVerificationEnabled() {
  return mailer.isConfigured();
}

function verificationStatus() {
  return {
    enabled: isVerificationEnabled(),
    smtp_configured: mailer.isConfigured(),
  };
}

// Alasan login diblokir verifikasi (v1.3.1): null = boleh masuk,
// 'verification_required' = punya email tapi belum terverifikasi,
// 'email_required' = TIDAK punya email sama sekali (N2: akun yang
// dibuat saat SMTP nonaktif tidak punya alamat untuk dikirimi OTP —
// tanpa jalur ini mereka bisa login selamanya tanpa verifikasi).
// Akun admin tidak pernah diblokir; bila SMTP tidak terkonfigurasi,
// verifikasi nonaktif dan tidak ada yang diblokir.
function loginBlockReason(user) {
  if (!user || user.role === 'admin') return null;
  if (!isVerificationEnabled()) return null;
  if (!user.email) return 'email_required';
  if (Number(user.email_verified || 0) !== 1) return 'verification_required';
  return null;
}

// True bila akun ini wajib terverifikasi dulu sebelum boleh masuk.
function isLoginBlocked(user) {
  return loginBlockReason(user) !== null;
}

function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code), 'utf8').digest('hex');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Hanguskan kode lama yang belum dipakai + sisipkan kode baru, atomik.
// node:sqlite tidak punya db.transaction() (itu API better-sqlite3) —
// pakai BEGIN/COMMIT manual seperti services/cache.js.
// `table` HANYA salah satu dari dua konstanta internal di file ini
// ('email_verifications' | 'password_resets') — tidak pernah dari
// input pengguna; kedua tabel sengaja terpisah supaya kode verifikasi
// dan kode reset tidak bisa saling dipakai.
function insertCode(userId, email, codeHash, expiresAt, createdAt, table) {
  const t = table === 'password_resets' ? 'password_resets' : 'email_verifications';
  const dbConn = db.get();
  dbConn.exec('BEGIN IMMEDIATE');
  try {
    dbConn.prepare(`UPDATE ${t} SET used = 1 WHERE user_id = ? AND used = 0`).run(userId);
    dbConn.prepare(
      `INSERT INTO ${t} (user_id, email, code_hash, attempts, used, expires_at, created_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)`
    ).run(userId, email, codeHash, expiresAt, createdAt);
    dbConn.exec('COMMIT');
  } catch (e) {
    dbConn.exec('ROLLBACK');
    throw e;
  }
}

// Escape untuk menyisipkan teks pengguna (username) ke HTML email.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// v1.4.0: desain dirapikan sesuai demo yang disetujui pengguna
// 2026-11-17 — teks dipangkas, logo Anton bold, kode memakai font
// bold lain (Montserrat) warna lime, email verifikasi TANPA tombol.
// Badan HTML email OTP — dipakai bersama oleh email verifikasi
// (variant 'verify', default) dan email reset password (variant
// 'reset': label/judul/paragraf/tombol/tautan disesuaikan). Template mengikuti struktur referensi visual
// dari pengguna: kartu tengah berisi merek + deskripsi, label kecil
// "VERIFIKASI AKUN", judul besar berkata aksen miring serif, paragraf,
// KOTAK KODE (KHUSUS verifikasi — varian reset TIDAK menampilkan
// angka kode sama sekali, jalannya hanya tombol tautan "Reset
// Password"), tombol besar, peringatan, lalu pita footer
// hitam. Tema Dark Lime dari public/css/style.css: latar #0c0f14,
// permukaan #141a22/#1c2530, aksen lime #c7f632, teks
// #ffffff/#c9d1d9/#8a94a3, font display Anton dan font UI Plus Jakarta
// Sans. Semua Bahasa Indonesia. Semua CSS INLINE (atribut style) dan
// layout memakai tabel sederhana karena klien email (Gmail) tidak
// mendukung stylesheet eksternal; tanpa gambar eksternal. Kode 6 digit
// tampil BESAR dan RATA TENGAH di dalam kotak berborder
// (letter-spacing lebar; padding-left yang sama besarnya mengimbangi
// spasi ekstra sesudah digit terakhir supaya benar-benar di tengah).
// CATATAN JUJUR: Gmail bisa memaksakan chrome-nya sendiri di sekitar
// isi email — yang dijamin adalah isi email yang di-style ini, bukan
// seluruh tampilan aplikasi Gmail.
function otpHtmlBody(code, email, variant) {
  const isReset = variant === 'reset';
  // v1.4.1: masa berlaku berbeda per varian — kode verifikasi
  // 1 menit, tautan reset 10 menit.
  const ttlMinutes = Math.round((isReset ? RESET_TTL_SECONDS : OTP_TTL_SECONDS) / 60);
  // v1.4.0 (keputusan pengguna 2026-11-17): email verifikasi TIDAK
  // lagi mempunyai tombol — tombol di email hanya bisa jadi tautan
  // dan tidak bisa menyalin kode (JavaScript diblokir di semua
  // aplikasi email), jadi yang tampil hanya kodenya, besar di tengah.
  // Varian reset tetap memakai tombol tautan di bawah ini.
  const actionUrl = escapeHtml(
    config.BASE_URL + '/account.html?mode=' + (isReset ? 'reset' : 'verify') +
    '&email=' + encodeURIComponent(email || '') +
    // Varian reset: kode ikut di tautan tombol "Reset Password" —
    // halaman web membacanya dari URL, jadi user TIDAK mengetik kode
    // sama sekali (alur tautan). Angka kode TIDAK ditampilkan di
    // email reset — email reset bukan email kode verifikasi, jadi
    // tidak ada kotak kode dan tidak ada baris kode di teks biasa.
    // Varian verifikasi tidak berubah (kode tetap tampil besar).
    (isReset ? '&code=' + encodeURIComponent(code) : '')
  );
  const label = isReset ? 'RESET PASSWORD' : 'VERIFIKASI AKUN';
  const heading = isReset ? 'Atur Ulang Password Kamu' : 'Konfirmasi Email Kamu';
  const intro = isReset
    ? 'Tekan tombol di bawah ini untuk membuat password baru. Tombol ini berlaku ' + ttlMinutes + ' menit.'
    : 'Masukkan kode di bawah ini di halaman verifikasi Mitsunime.';
  const buttonText = 'Reset Password';
  const ignoreText = isReset
    ? 'Abaikan email ini jika kamu tidak meminta reset password — password kamu tidak berubah.'
    : '';
  const fontUi = "'Plus Jakarta Sans','Inter',system-ui,sans-serif";
  const fontDisplay = "'Anton','Arial Black',sans-serif";
  // Kode 6 digit: font bold LAIN, bukan Anton-nya logo (keputusan
  // pengguna 2026-11-17) — warna tetap lime.
  const fontCode = "'Montserrat','Arial Black','Segoe UI',Arial,sans-serif";
  const secretWarning = isReset
    ? 'Jangan bagikan tautan ini ke siapa pun.'
    : 'Kode ini berlaku ' + ttlMinutes + ' menit. Jangan berikan kode ini ke siapa pun.';
  // Kotak kode HANYA untuk verifikasi. Email reset tidak menampilkan
  // angka kode sama sekali; satu-satunya jalan adalah tombol tautan.
  const codeBox = isReset
    ? ''
    : '<tr><td style="padding:24px 32px 0 32px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td align="center" bgcolor="#0c0f14" style="background-color:#0c0f14;border:1px solid #2a3442;border-radius:12px;padding:18px 10px;color:#c7f632;">' +
      '<div style="text-align:center;font-family:' + fontCode + ';font-size:42px;font-weight:900;letter-spacing:9px;padding-left:9px;color:#c7f632;"><span style="color:#c7f632;">' + code + '</span></div>' +
      '</td></tr></table>' +
      '</td></tr>';
  // Baris tombol HANYA untuk reset. Verifikasi tidak punya tombol
  // sama sekali (keputusan pengguna di atas).
  const buttonRow = isReset
    ? '<tr><td style="padding:24px 32px 0 32px;">' +
      '<a href="' + actionUrl + '" style="display:block;background-color:#c7f632;border-radius:10px;padding:16px 10px;text-align:center;font-family:' + fontUi + ';font-size:16px;font-weight:bold;letter-spacing:2px;color:#0c0f14;text-decoration:none;">' + buttonText + '</a>' +
      '</td></tr>'
    : '';
  const ignoreRow = ignoreText
    ? '<tr><td style="padding:6px 32px 0 32px;text-align:center;font-family:' + fontUi + ';font-size:13px;line-height:20px;color:#8a94a3;">' + ignoreText + '</td></tr>'
    : '';
  // Baris-baris digabung dengan '\n': mailer mengirim badan 8bit apa
  // adanya dan SMTP membatasi 1000 oktet per baris — satu string
  // raksasa tanpa jeda baris bisa dilipat paksa server di tengah tag.
  // Jedah antar-tag tidak berpengaruh ke tampilan HTML.
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head>',
    '<body style="margin:0;padding:0;background-color:#0c0f14;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0c0f14;">',
    '<tr><td align="center" style="padding:32px 16px;">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background-color:#141a22;border:1px solid #2a3442;border-radius:12px;">',
    '<tr><td style="padding:36px 32px 0 32px;text-align:center;">' +
      // v1.4.1: logo sebagai gambar CID (render Anton, retina 2x).
      // Bila gambar diblokir/tidak tampil, alt "MITSUNIME" tampil
      // sebagai teks dengan font display yang sama.
      '<div style="font-family:' + fontDisplay + ';font-size:40px;font-weight:bold;letter-spacing:4px;color:#c7f632;">' +
      '<img src="cid:' + LOGO_CID + '" alt="MITSUNIME" width="' + LOGO_IMG_WIDTH + '" style="display:block;margin:0 auto;border:0;width:' + LOGO_IMG_WIDTH + 'px;height:auto;" />' +
      '</div>' +
      '</td></tr>',
    '<tr><td style="padding:26px 32px 0 32px;text-align:center;font-family:' + fontUi + ';font-size:12px;font-weight:bold;letter-spacing:4px;color:#c7f632;">' + label + '</td></tr>',
    '<tr><td style="padding:12px 32px 0 32px;text-align:center;font-family:' + fontUi + ';font-size:29px;line-height:37px;font-weight:bold;color:#ffffff;">' + heading + '</td></tr>',
    '<tr><td style="padding:14px 32px 0 32px;text-align:center;font-family:' + fontUi + ';font-size:15px;line-height:24px;color:#c9d1d9;">' + intro + '</td></tr>',
    codeBox,
    buttonRow,
    '<tr><td style="padding:20px 32px 0 32px;text-align:center;font-family:' + fontUi + ';font-size:13px;line-height:20px;color:#8a94a3;">' + secretWarning + '</td></tr>',
    ignoreRow,
    '<tr><td style="padding:22px 32px 30px 32px;text-align:center;">' +
      '<div style="border-top:1px solid #2a3442;padding-top:16px;font-family:' + fontUi + ';font-size:12px;line-height:18px;color:#8a94a3;">© 2026 Mitsunime — Email ini dikirim otomatis, mohon jangan dibalas.</div>' +
      '</td></tr>',
    '</table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('\n');
}

// Buat + kirim OTP untuk pengguna. Mengembalikan { sent: true } bila
// email berhasil dikirim, { sent: false, reason } bila tidak — TIDAK
// pernah melempar galat SMTP: register sudah berhasil, dan kegagalan
// pengiriman bukan alasan menggagalkan pendaftaran (pengguna bisa
// meminta kode baru lewat /api/auth/verify/request).
async function sendCodeForUser(user) {
  if (!isVerificationEnabled()) return { sent: false, reason: 'smtp_not_configured' };
  const code = generateCode();
  const now = nowSeconds();
  insertCode(user.id, user.email, hashCode(code), now + OTP_TTL_SECONDS, now);
  const subject = 'Kode verifikasi Mitsunime';
  const ttlMinutes = Math.round(OTP_TTL_SECONDS / 60);
  // Teks polos mengikuti isi template HTML baru: salam + kode + masa
  // berlaku + peringatan + deskripsi, semua Bahasa Indonesia.
  const text =
    `Halo ${user.username || ''},\n\n` +
    `Masukkan kode di bawah ini di halaman verifikasi Mitsunime.\n\n` +
    `${code}\n\n` +
    `Kode ini berlaku ${ttlMinutes} menit. Jangan berikan kode ini ke siapa pun.\n\n` +
    `© 2026 Mitsunime — Email ini dikirim otomatis, mohon jangan dibalas.`;
  // Kirim multipart/alternative — teks polos di atas + HTML tema Dark
  // Lime. mailer memilih multipart hanya bila html diisi.
  const html = otpHtmlBody(code, user.email);
  try {
    await mailer.sendMail({ to: user.email, subject, text, html, attachments: logoAttachment() });
    return { sent: true };
  } catch (e) {
    logger.error(`Gagal mengirim OTP ke ${user.email}: ${e && e.message ? e.message : e}`);
    return { sent: false, reason: 'send_failed' };
  }
}

// Ganti/tambah email (v1.3.1, jalur "Ganti email" di halaman verifikasi +
// jalur "tambah email" untuk akun tanpa email / N2; v1.3.2: juga untuk akun
// TERVERIFIKASI yang mengganti emailnya sendiri dari Setelan).
// Mengembalikan { ok: true, emailSent } atau { ok: false, message }.
// Email baru divalidasi sama seperti saat register (format + MX + tolak
// domain sekali pakai); bila lolos, users.email diperbarui lalu OTP baru
// dikirim ke alamat baru — insertCode di dalam sendCodeForUser
// menghanguskan semua OTP lama akun itu, jadi kode yang dikirim ke alamat
// lama tidak bisa dipakai lagi.
// opts.resetVerification (v1.3.2): bila true, email_verified ikut
// direset ke 0 DALAM statement UPDATE yang sama dengan perubahan email —
// sebelum await kirim OTP, supaya tidak ada jendela di mana email baru
// masih berstatus terverifikasi. Dipakai hanya untuk akun terverifikasi
// yang mengganti emailnya sendiri; akun belum terverifikasi sudah 0.
// Fungsi ini TIDAK memeriksa apakah akun sudah terverifikasi atau admin —
// itu urusan pemanggil (rute), supaya balasan generik untuk akun tak
// dikenal tetap bisa diberikan di sana.
async function changeUserEmail(user, newEmail, opts = {}) {
  const email = String(newEmail || '').trim();
  if (!email || !EMAIL_RE.test(email) || email.length > 100) {
    return { ok: false, message: 'Alamat email baru tidak valid.' };
  }
  const emailErr = await emailCheck.checkRegistrationEmail(email);
  if (emailErr) return { ok: false, message: emailErr };
  const dup = db.get().prepare(
    'SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?',
  ).get(email, user.id);
  if (dup) return { ok: false, message: 'Email sudah dipakai akun lain.' };
  if (opts.resetVerification) {
    db.get().prepare('UPDATE users SET email = ?, email_verified = 0 WHERE id = ?').run(email, user.id);
  } else {
    db.get().prepare('UPDATE users SET email = ? WHERE id = ?').run(email, user.id);
  }
  const fresh = db.get().prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const sent = await sendCodeForUser(fresh);
  return { ok: true, emailSent: sent.sent };
}

// Konfirmasi kode. Mengembalikan { ok: true, user } bila cocok, atau
// { ok: false, code, message, attemptsLeft? } dengan kode galat:
// 'not_found' (tidak ada kode aktif — termasuk email tak dikenal DAN
// email yang sudah terverifikasi, S-03 v1.3.3: jawaban harus identik
// supaya endpoint ini tidak jadi oracle enumerasi email),
// 'expired' (lewat 1 menit),
// 'void' (hangus: 5x salah, sudah dipakai, atau sudah dihanguskan),
// 'wrong' (salah, masih ada sisa percobaan).
// N3 (v1.3.1): semua penandaan kode sebagai terpakai memakai UPDATE
// atomik `WHERE id = ? AND used = 0` lalu memeriksa `changes` —
// dua confirm bersamaan dengan kode yang sama tidak bisa sama-sama
// lolos (hanya yang pertama mengubah baris yang diterima).
function confirmCode(email, code) {
  const user = db.get().prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(String(email || '').trim());
  if (!user) {
    return { ok: false, code: 'not_found', message: 'Kode verifikasi tidak ditemukan. Minta kode baru.' };
  }
  if (Number(user.email_verified || 0) === 1) {
    // S-03 (v1.3.3): jawab SAMA PERSIS dengan kasus not_found di atas —
    // kode + pesan identik — supaya probe tanpa autentikasi tidak bisa
    // membedakan "email terdaftar + terverifikasi" dari "tidak dikenal".
    return { ok: false, code: 'not_found', message: 'Kode verifikasi tidak ditemukan. Minta kode baru.' };
  }
  const row = db.get().prepare(
    `SELECT * FROM email_verifications WHERE user_id = ? AND used = 0
     ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(user.id);
  if (!row) {
    return { ok: false, code: 'not_found', message: 'Kode verifikasi tidak ditemukan. Minta kode baru.' };
  }
  const now = nowSeconds();
  if (row.expires_at <= now) {
    db.get().prepare('UPDATE email_verifications SET used = 1 WHERE id = ? AND used = 0').run(row.id);
    return { ok: false, code: 'expired', message: 'Kode sudah kedaluwarsa. Minta kode baru.' };
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    db.get().prepare('UPDATE email_verifications SET used = 1 WHERE id = ? AND used = 0').run(row.id);
    return { ok: false, code: 'void', message: 'Kode sudah hangus karena terlalu banyak percobaan salah. Minta kode baru.' };
  }
  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(hashCode(code), 'hex');
  const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!match) {
    // Naikkan percobaan secara atomik dari nilai tersimpan (bukan dari
    // hasil SELECT) supaya dua percobaan salah bersamaan tidak saling
    // menimpa hitungan. Bila baris sudah dipakai/hangus di tengah jalan
    // (changes = 0), anggap kode hangus.
    const info = db.get().prepare(
      `UPDATE email_verifications
       SET attempts = attempts + 1,
           used = CASE WHEN attempts + 1 >= ? THEN 1 ELSE 0 END
       WHERE id = ? AND used = 0`,
    ).run(OTP_MAX_ATTEMPTS, row.id);
    if (info.changes === 0) {
      return { ok: false, code: 'void', attemptsLeft: 0, message: 'Kode sudah hangus. Minta kode baru.' };
    }
    const after = db.get().prepare('SELECT attempts, used FROM email_verifications WHERE id = ?').get(row.id);
    if (after && after.used === 1) {
      return { ok: false, code: 'void', attemptsLeft: 0, message: 'Kode salah 5 kali. Kode hangus, minta kode baru.' };
    }
    const left = OTP_MAX_ATTEMPTS - (after ? after.attempts : row.attempts + 1);
    return {
      ok: false,
      code: 'wrong',
      attemptsLeft: left,
      message: `Kode salah. Sisa percobaan: ${left}.`,
    };
  }
  // N3: tandai terpakai secara atomik. Bila changes = 0, permintaan
  // confirm lain sudah memakai kode ini lebih dulu — tolak.
  const used = db.get().prepare('UPDATE email_verifications SET used = 1 WHERE id = ? AND used = 0').run(row.id);
  if (used.changes === 0) {
    return { ok: false, code: 'void', message: 'Kode sudah dipakai. Minta kode baru.' };
  }
  db.get().prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
  const fresh = db.get().prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  return { ok: true, user: fresh };
}

// --- Reset password (lupa password) ---
// Kode reset hidup di tabel password_resets yang TERPISAH dari
// email_verifications: kode verifikasi email TIDAK bisa dipakai untuk
// reset password, dan sebaliknya. Aturan lain sama persis dengan OTP
// verifikasi: SHA256, TTL RESET_TTL_SECONDS (10 menit), maks
// OTP_MAX_ATTEMPTS percobaan, kode baru menghanguskan kode lama,
// konfirmasi atomik (N3).

// Buat + kirim kode reset untuk pengguna. Sama seperti
// sendCodeForUser: tidak pernah melempar galat SMTP.
async function sendResetCodeForUser(user) {
  if (!isVerificationEnabled()) return { sent: false, reason: 'smtp_not_configured' };
  const code = generateCode();
  const now = nowSeconds();
  insertCode(user.id, user.email, hashCode(code), now + RESET_TTL_SECONDS, now, 'password_resets');
  const subject = 'Reset password Mitsunime';
  const ttlMinutes = Math.round(RESET_TTL_SECONDS / 60);
  const text =
    `Halo ${user.username || ''},\n\n` +
    `Kami menerima permintaan untuk mengatur ulang password akun Mitsunime kamu. Buka tautan ini untuk membuat password baru:\n\n` +
    `${config.BASE_URL}/account.html?mode=reset&email=${encodeURIComponent(user.email)}&code=${code}\n\n` +
    `Tautan ini berlaku ${ttlMinutes} menit. Jangan bagikan tautan ini ke siapa pun.\n\n` +
    `Tidak merasa meminta reset password? Abaikan saja email ini — password kamu tidak berubah.\n\n` +
    `© 2026 Mitsunime — Email ini dikirim otomatis, mohon jangan dibalas.`;
  const html = otpHtmlBody(code, user.email, 'reset');
  try {
    await mailer.sendMail({ to: user.email, subject, text, html, attachments: logoAttachment() });
    return { sent: true };
  } catch (e) {
    logger.error(`Gagal mengirim kode reset password ke ${user.email}: ${e && e.message ? e.message : e}`);
    return { sent: false, reason: 'send_failed' };
  }
}

// Konfirmasi kode reset. Pola sama seperti confirmCode (atomik N3),
// tetapi dari tabel password_resets dan TANPA memeriksa
// email_verified — akun terverifikasi justru pengguna utama fitur
// ini. Mengembalikan { ok: true, user } bila cocok (kode sudah
// ditandai terpakai); pemanggil (rute) yang mengganti password,
// menyetel email_verified=1 bila belum, dan mencabut semua sesi —
// semuanya sinkron dalam satu handler, tanpa jeda await.
function confirmResetCode(email, code) {
  const user = db.get().prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(String(email || '').trim());
  if (!user) {
    return { ok: false, code: 'not_found', message: 'Kode reset tidak ditemukan. Minta kode baru.' };
  }
  const row = db.get().prepare(
    `SELECT * FROM password_resets WHERE user_id = ? AND used = 0
     ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(user.id);
  if (!row) {
    return { ok: false, code: 'not_found', message: 'Kode reset tidak ditemukan. Minta kode baru.' };
  }
  const now = nowSeconds();
  if (row.expires_at <= now) {
    db.get().prepare('UPDATE password_resets SET used = 1 WHERE id = ? AND used = 0').run(row.id);
    return { ok: false, code: 'expired', message: 'Kode reset sudah kedaluwarsa. Minta kode baru.' };
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    db.get().prepare('UPDATE password_resets SET used = 1 WHERE id = ? AND used = 0').run(row.id);
    return { ok: false, code: 'void', message: 'Kode reset sudah hangus karena terlalu banyak percobaan salah. Minta kode baru.' };
  }
  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(hashCode(code), 'hex');
  const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!match) {
    const info = db.get().prepare(
      `UPDATE password_resets
       SET attempts = attempts + 1,
           used = CASE WHEN attempts + 1 >= ? THEN 1 ELSE 0 END
       WHERE id = ? AND used = 0`,
    ).run(OTP_MAX_ATTEMPTS, row.id);
    if (info.changes === 0) {
      return { ok: false, code: 'void', attemptsLeft: 0, message: 'Kode reset sudah hangus. Minta kode baru.' };
    }
    const after = db.get().prepare('SELECT attempts, used FROM password_resets WHERE id = ?').get(row.id);
    if (after && after.used === 1) {
      return { ok: false, code: 'void', attemptsLeft: 0, message: 'Kode salah 5 kali. Kode reset hangus, minta kode baru.' };
    }
    const left = OTP_MAX_ATTEMPTS - (after ? after.attempts : row.attempts + 1);
    return {
      ok: false,
      code: 'wrong',
      attemptsLeft: left,
      message: `Kode salah. Sisa percobaan: ${left}.`,
    };
  }
  // N3: tandai terpakai secara atomik sebelum pemanggil mengganti
  // password — dua reset bersamaan dengan kode yang sama tidak bisa
  // sama-sama lolos.
  const used = db.get().prepare('UPDATE password_resets SET used = 1 WHERE id = ? AND used = 0').run(row.id);
  if (used.changes === 0) {
    return { ok: false, code: 'void', message: 'Kode reset sudah dipakai. Minta kode baru.' };
  }
  return { ok: true, user };
}

module.exports = {
  OTP_TTL_SECONDS,
  RESET_TTL_SECONDS,
  OTP_MAX_ATTEMPTS,
  isVerificationEnabled,
  verificationStatus,
  isLoginBlocked,
  loginBlockReason,
  sendCodeForUser,
  changeUserEmail,
  confirmCode,
  sendResetCodeForUser,
  confirmResetCode,
};
