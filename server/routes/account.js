'use strict';
// Rute akun (task-06): daftar, login, logout, profil, ganti password.
// v1.3.0: + verifikasi email OTP (/api/auth/verify/confirm + /request).
// Semua respons JSON { ok, ... }. Pesan error login SELALU generik
// ("Username atau password salah") — jangan bocorkan mana yang salah.
const auth = require('../services/auth');
const mw = require('../middleware/auth');
const premium = require('../services/premium');
const accessories = require('../services/accessories');
const emailCheck = require('../services/emailCheck');
const emailVerification = require('../services/emailVerification');
const levels = require('../services/levels');
const avatars = require('../services/avatars');
const logger = require('../utils/logger');

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
function err(res, status, message) { return send(res, status, { ok: false, message }); }

// 429 dengan header Retry-After (S-01): penolakan rate limit wajib
// memberi tahu klien berapa lama menunggu, dalam Bahasa Indonesia.
function send429(res, message, retryAfterSec) {
  res.writeHead(429, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))),
  });
  res.end(JSON.stringify({ ok: false, message }));
  return true;
}

function bodyOf(req) {
  return (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
}

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password minimal 8 karakter.';
  if (pw.length > 128) return 'Password terlalu panjang (maksimal 128 karakter).';
  return null;
}

// POST /api/register { username, password, email? } → sesi baru + cookie.
async function handleRegister(req, res) {
  // M3: 5 pendaftaran per IP per jam (register menulis DB + hash scrypt
  // yang mahal — tanpa batas, satu IP bisa membuat akun tanpa henti).
  if (!mw.enforceRateLimit(req, res, `register:${mw.clientIp(req)}`, 5, 60 * 60 * 1000,
    'Terlalu banyak pendaftaran dari alamat ini. Coba lagi nanti.')) return true;
  const b = bodyOf(req);
  const username = typeof b.username === 'string' ? b.username.trim() : '';
  const password = b.password;
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (!USERNAME_RE.test(username)) {
    return err(res, 400, 'Username 3–32 karakter, hanya huruf, angka, "_" dan "-".');
  }
  const pwErr = checkPassword(password);
  if (pwErr) return err(res, 400, pwErr);
  if (email && (!EMAIL_RE.test(email) || email.length > 100)) {
    return err(res, 400, 'Alamat email tidak valid.');
  }
  // v1.2.0: tolak email dummy — domain tanpa MX record (dns.resolveMx +
  // fallback DNS-over-HTTPS) dan domain email sekali pakai. Pesan
  // galatnya Bahasa Indonesia, tanpa kode teknis. Bila email diisi,
  // pemeriksaan ini jalan SEBELUM pembuatan akun; bila DNS sama sekali
  // tidak bisa dihubungi, pendaftaran tetap dilanjutkan (fail open,
  // dicatat di log) supaya pengguna asli tidak terkunci saat DNS mati.
  if (email) {
    const emailErr = await emailCheck.checkRegistrationEmail(email);
    if (emailErr) return err(res, 400, emailErr);
  }
  // v1.3.0: bila SMTP aktif, email WAJIB — tanpa email, OTP tidak bisa
  // dikirim dan akun akan terkunci di login. Bila SMTP kosong,
  // verifikasi nonaktif dan email tetap opsional seperti v1.2.0.
  if (!email && emailVerification.isVerificationEnabled()) {
    return err(res, 400, 'Alamat email wajib diisi karena verifikasi email aktif di situs ini.');
  }
  // v1.3.3: konflik dengan akun yang BELUM terverifikasi (verifikasi
  // aktif) dijawab dengan kode khusus, bukan "sudah dipakai" generik —
  // akun itu kemungkinan besar milik pendaftar yang sama yang keluar
  // sebelum sempat memasukkan OTP, jadi frontend mengantarnya
  // melanjutkan verifikasi. Respons TIDAK memuat email/alamat akun
  // tersimpan. Bila verifikasi nonaktif, email_verified tidak bermakna
  // (semua akun 0) dan perilaku lama berlaku persis.
  const byUsername = auth.findUserByUsername(username);
  if (byUsername) {
    if (emailVerification.isVerificationEnabled() && !byUsername.email_verified) {
      // v1.4.3: kirim kode BARU sebelum membalas — kode pendaftaran
      // pertama sudah mati (TTL 1 menit); tanpa kode baru, catatan
      // "cek kode verifikasi di email kamu" di layar verifikasi
      // tidak benar. Penjaga anti-spam sama seperti kirim ulang.
      // H-01: sertakan verification_email_sent supaya frontend tahu
      // kode benar-benar terkirim atau ditahan cooldown/batas —
      // TANPA alamat email, hanya boolean.
      const sent = await sendFreshCodeIfAllowed(byUsername);
      return send(res, 409, {
        ok: false, code: 'username_unverified',
        verification_email_sent: sent,
        message: 'Username ini sudah terdaftar tapi belum diverifikasi. Lanjutkan verifikasi untuk masuk.',
      });
    }
    return err(res, 409, 'Username sudah dipakai. Pilih username lain.');
  }
  if (email) {
    const dup = (() => {
      try {
        return require('../db/database').get()
          .prepare('SELECT id, email_verified FROM users WHERE email = ?').get(email);
      } catch { return null; }
    })();
    if (dup) {
      if (emailVerification.isVerificationEnabled() && !dup.email_verified) {
        // v1.4.3: seperti cabang username — kirim kode BARU dulu.
        // dup hanya punya id + email_verified; ambil baris penuh.
        // H-01: sertakan verification_email_sent (boolean saja,
        // tanpa alamat) supaya frontend tahu kode terkirim atau tidak.
        const full = auth.findUserById(dup.id);
        const sent = full ? await sendFreshCodeIfAllowed(full) : false;
        return send(res, 409, {
          ok: false, code: 'email_unverified',
          verification_email_sent: sent,
          message: 'Email ini sudah terdaftar tapi belum diverifikasi. Lanjutkan verifikasi untuk masuk.',
        });
      }
      return err(res, 409, 'Email sudah dipakai akun lain.');
    }
  }
  let user;
  try {
    user = auth.createUser({ username, email: email || null, password });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return err(res, 409, 'Username atau email sudah dipakai.');
    }
    throw e;
  }
  // v1.3.0: bila verifikasi email aktif, akun dibuat dengan
  // email_verified=0 dan OTP dikirim — sesi TIDAK dibuat sampai kode
  // dikonfirmasi lewat /api/auth/verify/confirm.
  if (emailVerification.isVerificationEnabled()) {
    const sent = await emailVerification.sendCodeForUser(user);
    const pub = auth.publicUser(user);
    return send(res, 201, {
      ok: true, user: pub,
      premium: premium.premiumInfo(pub),
      verification_required: true,
      verification_email_sent: sent.sent,
      message: sent.sent
        ? 'Akun dibuat. Kode verifikasi 6 digit sudah dikirim ke email kamu.'
        : 'Akun dibuat, tapi email gagal dikirim. Minta kode baru lewat halaman verifikasi.',
    });
  }
  const token = auth.createSession(user.id);
  auth.setSessionCookie(res, token);
  auth.touchLastLogin(user.id);
  const pub = auth.publicUser(user);
  return send(res, 201, {
    ok: true, user: pub,
    premium: premium.premiumInfo(pub),
    message: `Selamat datang, ${username}!`,
  });
}

// POST /api/login { email, password } → sesi baru + cookie.
// Login memakai EMAIL (keputusan pengguna — form masuk hanya meminta
// email). Cadangan username di balik layar: bila pengenal tidak cocok
// dengan email mana pun, dicoba sebagai username, TAPI hanya diterima
// bila akun itu TIDAK punya email (v1.4.2, F-04) — akun admin hasil
// auto-seed dan akun daftar tanpa email tidak punya cara lain masuk,
// dan alur tambah-email (email_required) hanya bisa dicapai sesudah
// login pakai username. Akun yang sudah punya email tidak bisa lagi
// masuk pakai username (401, pesan sama seperti password salah).
// Rate limit: 10 kali gagal per IP per 15 menit → 429.
function handleLogin(req, res) {
  const ip = mw.clientIp(req);
  if (mw.loginBlocked(ip)) {
    return err(res, 429, 'Terlalu banyak percobaan login. Coba lagi 15 menit lagi.');
  }
  const b = bodyOf(req);
  const identifier = (typeof b.email === 'string' && b.email.trim())
    || (typeof b.username === 'string' ? b.username.trim() : '');
  const password = b.password;
  let user = null;
  if (identifier) {
    user = auth.findUserByEmail(identifier);
    if (!user) {
      // v1.4.2 (F-04): username hanya diterima bila akun itu TIDAK
      // punya email. Akun ber-email yang dicoba masuk pakai username
      // tetap ditolak (user null → 401 di bawah).
      const byUsername = auth.findUserByUsername(identifier);
      if (byUsername && !byUsername.email) user = byUsername;
    }
  }
  const ok = user && typeof password === 'string' && auth.verifyPassword(password, user.password_hash);
  if (!ok) {
    mw.recordLoginFail(ip);
    return err(res, 401, 'Email atau password salah.');
  }
  mw.recordLoginOk(ip);
  // v1.3.0: akun belum terverifikasi tidak boleh masuk bila SMTP aktif.
  // Kata sandi sudah benar di titik ini (hitungan gagal sudah dihapus),
  // yang ditolak hanya pembuatan sesinya. Akun admin tidak pernah
  // diblokir (lihat emailVerification.loginBlockReason).
  // v1.3.1 (N2): akun TANPA email juga ditolak bila SMTP aktif, dengan
  // kode mesin 'email_required' supaya frontend menampilkan form
  // tambah email (yang memanggil /api/auth/verify/change-email).
  const blockReason = emailVerification.loginBlockReason(user);
  if (blockReason === 'email_required') {
    return send(res, 403, {
      ok: false,
      code: 'email_required',
      username: user.username,
      message: 'Akun kamu belum punya email. Tambahkan email dulu untuk menerima kode verifikasi.',
    });
  }
  if (blockReason === 'verification_required') {
    return send(res, 403, {
      ok: false,
      verification_required: true,
      email: user.email || null,
      message: 'Akun kamu belum terverifikasi. Cek email kamu untuk kode verifikasi, atau minta kode baru.',
    });
  }
  auth.pruneExpiredSessions();
  const token = auth.createSession(user.id);
  auth.setSessionCookie(res, token);
  auth.touchLastLogin(user.id);
  const pub = auth.publicUser(user);
  return send(res, 200, {
    ok: true, user: pub,
    premium: premium.premiumInfo(pub),
    message: `Selamat datang kembali, ${user.username}!`,
  });
}

// POST /api/logout → hapus sesi + hapus cookie.
function handleLogout(req, res) {
  mw.attachUser(req);
  if (req.sessionToken) auth.deleteSession(req.sessionToken);
  auth.clearSessionCookie(res);
  return send(res, 200, { ok: true, message: 'Anda sudah keluar.' });
}

// --- Verifikasi email OTP (v1.3.0) ---

// POST /api/auth/verify/confirm { email, code } → verifikasi OTP.
// v1.4.5: TIDAK lagi membuat sesi — habis verifikasi pengguna
// diarahkan ke halaman login (email terverifikasi terisi di kolom).
// Sesi yang sudah ada tidak disentuh (cookie tidak dihapus/diubah).
// Kode salah 5x -> hangus, kode lewat 1 menit -> kedaluwarsa
// (lihat services/emailVerification.js).
async function handleVerifyConfirm(req, res) {
  const b = bodyOf(req);
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  const code = typeof b.code === 'string' ? b.code.trim() : '';
  if (!email || !/^\d{6}$/.test(code)) {
    return err(res, 400, 'Email dan kode 6 digit wajib diisi.');
  }
  const result = emailVerification.confirmCode(email, code);
  if (!result.ok) {
    return send(res, 400, {
      ok: false,
      code: result.code,
      attempts_left: result.attemptsLeft ?? null,
      message: result.message,
    });
  }
  const user = result.user;
  mw.recordLoginOk(mw.clientIp(req));
  auth.pruneExpiredSessions();
  const pub = auth.publicUser(user);
  return send(res, 200, {
    ok: true, user: pub,
    premium: premium.premiumInfo(pub),
    verification_required: false,
    message: 'Email terverifikasi. Silakan masuk.',
  });
}

// POST /api/auth/verify/request { email } → kirim ulang OTP.
// Rate limit: 5/jam per email (in-memory; restart server mereset
// hitungan — dapat diterima karena kode sendiri kedaluwarsa 1 menit).
// Balasan SAMA bila email tidak terdaftar atau sudah terverifikasi
// (jangan bocorkan mana yang terdaftar).
const verifyRequestAttempts = new Map();
function verifyRequestAllowed(email) {
  const now = Date.now();
  const key = email.toLowerCase();
  const arr = (verifyRequestAttempts.get(key) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (arr.length >= 5) {
    verifyRequestAttempts.set(key, arr);
    return false;
  }
  arr.push(now);
  verifyRequestAttempts.set(key, arr);
  return true;
}

// Cooldown kirim ulang (anti-spam): jeda minimum antar pengiriman
// kode per email, di atas batas 5/jam di atas. Peta ini dicatat
// HANYA oleh endpoint kirim ulang (verify/request dan
// password/forgot) — pengiriman pertama dari register/ganti email
// tidak dicatat di sini, jadi kirim ulang pertama sesudah daftar
// tetap diizinkan; pengulangan sesudahnya yang ditahan. Untuk
// verify/request penolakan berupa 429 + retry_after (akun di titik
// ini sudah diketahui belum terverifikasi dari alur pemanggil, dan
// frontend menampilkan countdown dari retry_after). Untuk
// password/forgot penolakan WAJIB diam-diam (respons generik tidak
// boleh berubah — anti-enumerasi), frontend mengandalkan countdown
// lokalnya.
// v1.4.1: cooldown DIPISAH — kirim ulang kode verifikasi hanya
// 10 detik (keputusan pengguna 2026-11-17: tombol kirim ulang
// langsung abu-abu + countdown sebentar sesudah diklik), sedangkan
// lupa password TETAP 60 detik (tautan reset berlaku 10 menit,
// jadi jeda anti-spam yang lebih panjang tetap masuk akal dan
// mencegah banjir email reset).
const VERIFY_RESEND_COOLDOWN_MS = 10 * 1000; // 10 detik
const FORGOT_RESEND_COOLDOWN_MS = 60 * 1000; // 60 detik — tetap
const verifyLastSentAt = new Map();
const forgotLastSentAt = new Map();
function cooldownLeftSeconds(map, email, cooldownMs) {
  const last = map.get(email.toLowerCase());
  if (!last) return 0;
  const left = Math.ceil((cooldownMs - (Date.now() - last)) / 1000);
  return left > 0 ? left : 0;
}

// v1.4.3: kirim kode verifikasi baru pada daftar ulang akun belum
// terverifikasi — penjaga anti-spam sama seperti endpoint kirim ulang
// (cooldown 10 detik + batas 5/jam per email). Bila penjaga menahan,
// lewati DIAM-DIAM dan kembalikan false (tombol kirim ulang tetap
// tersedia di layar verifikasi). Dipakai kedua cabang 409
// belum-terverifikasi di handleRegister.
async function sendFreshCodeIfAllowed(user) {
  if (!user || !user.email) return false;
  if (cooldownLeftSeconds(verifyLastSentAt, user.email, VERIFY_RESEND_COOLDOWN_MS) > 0) return false;
  if (!verifyRequestAllowed(user.email)) return false;
  verifyLastSentAt.set(user.email.toLowerCase(), Date.now());
  // H-01: kembalikan hasil kirim yang sebenarnya — sendCodeForUser
  // tidak pernah throw, dia mengembalikan { sent: bool }; bila SMTP
  // gagal, kembalikan false supaya verification_email_sent jujur.
  const sent = await emailVerification.sendCodeForUser(user);
  return sent.sent === true;
}

async function handleVerifyRequest(req, res) {
  const b = bodyOf(req);
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (!email || !EMAIL_RE.test(email) || email.length > 100) {
    return err(res, 400, 'Alamat email tidak valid.');
  }
  const db = require('../db/database').get();
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email);
  if (!user || Number(user.email_verified || 0) === 1) {
    return send(res, 200, { ok: true, message: 'Bila email terdaftar dan belum terverifikasi, kode baru sudah dikirim.' });
  }
  if (!emailVerification.isVerificationEnabled()) {
    return err(res, 400, 'Verifikasi email belum diaktifkan di situs ini.');
  }
  const cdLeft = cooldownLeftSeconds(verifyLastSentAt, email, VERIFY_RESEND_COOLDOWN_MS);
  if (cdLeft > 0) {
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': String(cdLeft),
    });
    res.end(JSON.stringify({
      ok: false,
      code: 'cooldown',
      retry_after: cdLeft,
      message: `Kode baru saja dikirim. Tunggu ${cdLeft} detik lagi untuk meminta kode baru.`,
    }));
    return true;
  }
  if (!verifyRequestAllowed(email)) {
    return err(res, 429, 'Terlalu banyak permintaan kode. Coba lagi setelah satu jam.');
  }
  verifyLastSentAt.set(email.toLowerCase(), Date.now());
  const sent = await emailVerification.sendCodeForUser(user);
  return send(res, 200, {
    ok: true,
    email_sent: sent.sent,
    message: sent.sent
      ? 'Kode verifikasi baru sudah dikirim ke email kamu.'
      : 'Kode dibuat, tapi email gagal dikirim. Coba minta kode baru lagi.',
  });
}

// --- Lupa password (reset lewat kode email) ---

// POST /api/auth/password/forgot { email } → kirim kode reset 6 digit.
// Respons SELALU generik yang sama — email terdaftar, tidak terdaftar,
// SMTP nonaktif, kena rate limit, atau gagal kirim: semuanya dijawab
// 200 dengan pesan yang sama persis, tanpa mengirim apa pun bila
// akunnya tidak ada. Jangan jadikan endpoint ini oracle enumerasi
// email. Rate limit per email meniru kirim ulang verifikasi
// (5/jam, in-memory), tetapi diterapkan DIAM-DIAM: melewati batas
// tidak mengubah respons, hanya menghentikan pengiriman.
const FORGOT_GENERIC_MESSAGE = 'Tautan reset terkirim — cek email kamu.';
const forgotAttempts = new Map();
function forgotAllowed(email) {
  const now = Date.now();
  const key = email.toLowerCase();
  const arr = (forgotAttempts.get(key) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (arr.length >= 5) {
    forgotAttempts.set(key, arr);
    return false;
  }
  arr.push(now);
  forgotAttempts.set(key, arr);
  return true;
}

async function handlePasswordForgot(req, res) {
  const b = bodyOf(req);
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (!email || !EMAIL_RE.test(email) || email.length > 100) {
    return err(res, 400, 'Alamat email tidak valid.');
  }
  const db = require('../db/database').get();
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email);
  if (user && emailVerification.isVerificationEnabled()
    && cooldownLeftSeconds(forgotLastSentAt, email, FORGOT_RESEND_COOLDOWN_MS) === 0
    && forgotAllowed(email)) {
    // Hasil kirim (termasuk gagal SMTP) SENGAJA tidak dibocorkan —
    // respons tetap generik yang sama. Cooldown 60 detik juga
    // diterapkan DIAM-DIAM di sini: membalas 429 khusus untuk email
    // terdaftar akan membocorkan keberadaan akun.
    forgotLastSentAt.set(email.toLowerCase(), Date.now());
    // v1.4.2 (F-03): kirim TANPA await (fire-and-forget). Respons
    // generik yang sama dikembalikan apa pun hasil kirim, jadi
    // menunggu SMTP (Gmail dari HP bisa beberapa detik, batas
    // timeout 20 detik/perintah) hanya membuat tombol terasa macet
    // tanpa memberi apa-apa ke pengguna. Kode sudah dicatat
    // sinkron di dalam sendResetCodeForUser (insertCode) sebelum
    // pengiriman; kegagalan kirim sudah dicatat ke log di sana,
    // dan .catch ini menangkap galat tak terduga lainnya.
    emailVerification.sendResetCodeForUser(user).catch((e) => {
      logger.error(`Gagal mengirim kode reset password (latar) ke ${user.email}: ${e && e.message ? e.message : e}`);
    });
  }
  return send(res, 200, { ok: true, message: FORGOT_GENERIC_MESSAGE });
}

// POST /api/auth/password/reset { email, code, new_password } →
// verifikasi kode reset (atomik, tabel password_resets), ganti
// password, cabut SEMUA sesi, lalu user masuk manual dengan password
// baru (TIDAK ada sesi otomatis di sini). Memasukkan kode dari inbox
// adalah bukti kepemilikan email, jadi akun yang belum terverifikasi
// ikut disetel email_verified=1. Validasi password baru berjalan
// SEBELUM kode diperiksa, supaya percobaan kode tidak hangus hanya
// karena password baru tidak memenuhi aturan.
function handlePasswordReset(req, res) {
  const b = bodyOf(req);
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  const code = typeof b.code === 'string' ? b.code.trim() : '';
  if (!email || !/^\d{6}$/.test(code)) {
    return err(res, 400, 'Email dan kode 6 digit wajib diisi.');
  }
  const pwErr = checkPassword(b.new_password);
  if (pwErr) return err(res, 400, pwErr);
  const result = emailVerification.confirmResetCode(email, code);
  if (!result.ok) {
    return send(res, 400, {
      ok: false,
      code: result.code,
      attempts_left: result.attemptsLeft ?? null,
      message: result.message,
    });
  }
  const user = result.user;
  auth.changePassword(user.id, b.new_password);
  if (Number(user.email_verified || 0) !== 1) {
    require('../db/database').get()
      .prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
  }
  auth.deleteUserSessions(user.id);
  auth.clearSessionCookie(res);
  return send(res, 200, {
    ok: true,
    message: 'Password berhasil diatur ulang. Silakan masuk dengan password baru.',
  });
}

// POST /api/auth/verify/change-email { email?, username?, new_email, password }
// → ganti/tambah email akun yang BELUM terverifikasi, lalu kirim OTP
// baru ke email baru (v1.3.1, tombol "Ganti email" di halaman
// verifikasi + form "tambah email" untuk akun tanpa email / N2).
// v1.3.2: akun TERVERIFIKASI boleh ganti email dari Setelan BILA
// pemanggil sudah login DAN akun target adalah akun dari sesi itu
// sendiri (cookie sesi user) — email diubah, email_verified direset
// ke 0, OTP baru dikirim ke email baru, sesi saat ini dicabut, dan
// respons { verification_required: true, email: new_email } supaya
// Frontend menampilkan layar verifikasi. Tanpa sesi, atau sesi akun
// lain, akun terverifikasi TETAP dijawab generik 200 tanpa perubahan
// (perilaku lama — jangan bocorkan status akun). Akun admin tidak
// pernah boleh lewat jalur ini, untuk dirinya sendiri maupun orang
// lain (email admin bukan urusan endpoint ini).
// Minimal satu pengenal (email ATAU username) wajib ada. Bila username
// diisi, pencarian memakai username (lebih tegas); bila hanya email,
// pencarian memakai email.
// Keamanan (v1.3.1, perbaikan atas risiko yang dicatat sebelumnya):
// kata sandi WAJIB diisi dan diverifikasi terhadap hash akun SEBELUM
// email diubah — tanpa ini, siapa pun yang tahu username/email akun
// belum terverifikasi bisa mengganti emailnya lalu masuk sebagai akun
// itu. Kata sandi salah / tidak ada / akun tidak dikenal semuanya
// dijawab 401 dengan pesan generik yang SAMA PERSIS dengan balasan
// generik 200 di bawah — tidak bocor apakah akunnya ada atau kata
// sandinya yang salah.
// F-07 (v1.3.1): jalur ini SENGAJA tidak memakai penghitung gagal login
// (10/IP/15 mnt) sama sekali — tidak membaca loginBlocked, tidak
// memanggil recordLoginFail/recordLoginOk. Kata sandi salah di sini
// tidak boleh mengunci login dari IP itu (lockout via endpoint lain),
// dan IP yang sedang terkunci login pun tetap bisa ganti email.
// S-01 (v1.3.2): perlindungan brute force TIDAK LAGI hanya mengandalkan
// changeEmailAllowed di bawah (yang dihitung SETELAH kata sandi lolos)
// — pembatas tebakan password cePw* di bawah ini berjalan SEBELUM
// verifyPassword, dengan ember terpisah dari penghitung login.
const changeEmailAttempts = new Map();
function changeEmailAllowed(userId) {
  const now = Date.now();
  const arr = (changeEmailAttempts.get(userId) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (arr.length >= 5) {
    changeEmailAttempts.set(userId, arr);
    return false;
  }
  arr.push(now);
  changeEmailAttempts.set(userId, arr);
  return true;
}

// S-01 (v1.3.2): pembatas tebakan password SEBELUM verifyPassword.
// Masalah yang diperbaiki: tanpa pembatas ini, siapa pun yang tahu satu
// username bisa menebak password tanpa batas lewat endpoint ini, dan
// tiap tebakan mengeksekusi scryptSync yang memblokir event loop Node
// satu-proses sehingga banjir tebakan memperlambat seluruh server
// (Pentest: latensi /api/health 3 ms -> 931-1404 ms selama banjir).
// Dua ember TERPISAH dari penghitung gagal login (F-07 tetap berlaku):
//   - per akun target: 10 gagal / 15 menit (sama seperti batas login);
//   - per IP: 30 gagal / 15 menit (penahan semprotan ke banyak akun;
//     ambang lebih tinggi karena satu IP bisa dipakai banyak pengguna
//     HP di belakang CGNAT — ember akun yang utama, ember IP hanya
//     penahan).
// Hukuman bertahap (skill Backend "Lindungi API dari penyalahgunaan"):
// begitu ambang tercapai, kunci diblokir sementara dengan durasi
// menanjak 5 menit -> 1 jam -> 24 jam; blokir kedaluwarsa sendiri.
// Selama diblokir, verifyPassword TIDAK dipanggil (tanpa biaya scrypt)
// dan jawaban 429 berbahasa Indonesia + header Retry-After. Admin
// tidak pernah diblokir dari login/dashboard oleh pembatas ini (ember
// terpisah; endpoint ini pun bukan jalur admin — percobaan ke username
// admin hanya memblokir endpoint ini untuk pengenal itu). Restart
// server menghapus semua blokir (jalur unblock admin untuk pengerahan
// lokal ini). Setiap pemblokiran dicatat di log (IP, kunci, durasi)
// tanpa kata sandi.
const CE_PW_MAX_ACC = 10;
const CE_PW_MAX_IP = 30;
const CE_PW_WINDOW_MS = 15 * 60 * 1000;
const CE_PW_BLOCK_MS = [5 * 60 * 1000, 60 * 60 * 1000, 24 * 60 * 60 * 1000];
const cePwAttempts = new Map(); // key -> { fails, firstAt, blockedUntil, blocks, lastAt }

function cePwBlockedSeconds(key) {
  const rec = cePwAttempts.get(key);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.blockedUntil && now < rec.blockedUntil) {
    return Math.ceil((rec.blockedUntil - now) / 1000);
  }
  if (rec.blockedUntil) rec.blockedUntil = 0;
  // Bersihkan entri lama yang sudah tidak relevan (jendela lewat,
  // tidak diblokir, tidak ada gagal tertunda).
  if (rec.fails === 0 && now - rec.lastAt > 24 * 60 * 60 * 1000) {
    cePwAttempts.delete(key);
  }
  return 0;
}

function cePwRecordFail(key, max, kind, ip) {
  const now = Date.now();
  let rec = cePwAttempts.get(key);
  if (!rec || now - rec.firstAt > CE_PW_WINDOW_MS) {
    rec = { fails: 0, firstAt: now, blockedUntil: 0, blocks: rec ? rec.blocks : 0, lastAt: now };
    cePwAttempts.set(key, rec);
  }
  rec.fails += 1;
  rec.lastAt = now;
  if (rec.fails < max) return 0;
  // Ambang tercapai: blokir sementara, durasi menanjak per pengulangan.
  const dur = CE_PW_BLOCK_MS[Math.min(rec.blocks, CE_PW_BLOCK_MS.length - 1)];
  rec.blocks += 1;
  rec.fails = 0;
  rec.firstAt = now;
  rec.blockedUntil = now + dur;
  logger.warn(`[S-01] Blokir change-email (${kind} ip=${ip} kunci=${key} durasi=${Math.round(dur / 1000)}s blokir-ke-${rec.blocks})`);
  return Math.ceil(dur / 1000);
}

// Kata sandi benar = bukti kepemilikan: hitungan gagal di-nol-kan supaya
// pengguna yang salah ketik lalu berhasil tidak langsung kena blokir.
// Sengaja TIDAK menghapus catatan blokir (blocks): pelanggar berulang
// tetap mendapat durasi menanjak (5 mnt -> 1 jam -> 24 jam) bila
// diblokir lagi — catatan itu baru hilang bila kunci tidak dipakai
// 24 jam (lihat cePwBlockedSeconds) atau server restart.
function cePwClearFails(key) {
  const rec = cePwAttempts.get(key);
  if (!rec) return;
  rec.fails = 0;
  rec.firstAt = Date.now();
  rec.blockedUntil = 0;
  rec.lastAt = Date.now();
}

async function handleVerifyChangeEmail(req, res) {
  const b = bodyOf(req);
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  const username = typeof b.username === 'string' ? b.username.trim() : '';
  const newEmail = typeof b.new_email === 'string' ? b.new_email.trim() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  const generic = 'Bila akun terdaftar dan belum terverifikasi, kode baru sudah dikirim ke email baru.';
  if ((!email && !username) || !newEmail) {
    return err(res, 400, 'Pengenal akun (email atau username) dan email baru wajib diisi.');
  }
  if (!emailVerification.isVerificationEnabled()) {
    return err(res, 400, 'Verifikasi email belum diaktifkan di situs ini.');
  }
  // v1.3.2: lampirkan sesi pemanggil (cookie sesi USER saja — BUKAN
  // cookie admin) untuk mengenali ganti email sendiri. Tanpa sesi,
  // isSelf selalu false dan alur verifikasi register tidak berubah.
  mw.attachUser(req);
  const db = require('../db/database').get();
  let user = null;
  if (username) {
    user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  } else {
    user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email);
  }
  // S-01: pembatas tebakan password SEBELUM verifyPassword (lihat
  // cePwRecordFail di atas). Kunci akun memakai id pengguna bila
  // dikenal, bila tidak memakai pengenal yang dikirim (supaya probe
  // akun tak dikenal pun tetap dibatasi); kunci IP memakai IP soket.
  // Selama salah satu kunci diblokir, jawab 429 generik tanpa memanggil
  // verifyPassword (tanpa biaya scrypt).
  const ceIp = mw.clientIp(req);
  const ceAccKey = user ? `acc:u${user.id}` : `acc:id:${(username || email).toLowerCase()}`;
  const ceIpKey = `ip:${ceIp}`;
  const ceBlockedSec = Math.max(cePwBlockedSeconds(ceAccKey), cePwBlockedSeconds(ceIpKey));
  if (ceBlockedSec > 0) {
    return send429(res, 'Terlalu banyak percobaan ganti email. Coba lagi nanti.', ceBlockedSec);
  }
  // Kata sandi diverifikasi SEBELUM cabang generik di bawah: akun tidak
  // dikenal, kata sandi salah, dan kata sandi tidak ada semuanya dijawab
  // 401 dengan pesan generik yang sama — tidak bocor mana yang salah.
  // Pengecekan ini diletakkan sebelum cabang admin/terverifikasi supaya
  // status akun pun tidak bocor ke pihak yang tidak tahu kata sandinya.
  if (!user || !password || !auth.verifyPassword(password, user.password_hash)) {
    // S-01: catat kegagalan ke kedua ember (akun + IP) SEBELUM 401.
    // verifyPassword tidak dipanggil bila user null (tanpa biaya
    // scrypt), tetapi percobaan tetap dihitung supaya probe akun tak
    // dikenal tidak bisa membanjiri endpoint ini.
    cePwRecordFail(ceAccKey, CE_PW_MAX_ACC, 'akun', ceIp);
    cePwRecordFail(ceIpKey, CE_PW_MAX_IP, 'ip', ceIp);
    return err(res, 401, generic);
  }
  // Kata sandi benar = bukti kepemilikan: hapus hitungan gagal akun ini
  // (ember IP dibiarkan, karena ia menghitung gagal lintas akun).
  // Catatan blokir (blocks) sengaja dipertahankan — lihat cePwClearFails.
  cePwClearFails(ceAccKey);
  // v1.3.2: akun terverifikasi hanya boleh diganti bila pemanggil adalah
  // akun itu sendiri (sesi user yang sama). Akun admin tidak pernah
  // boleh lewat jalur ini. Tanpa sesi, atau sesi akun lain, akun
  // terverifikasi tetap dijawab generik 200 tanpa perubahan apa pun.
  const isSelf = Boolean(req.user && req.user.id === user.id);
  const isVerified = Number(user.email_verified || 0) === 1;
  if (user.role === 'admin' || (isVerified && !isSelf)) {
    return send(res, 200, { ok: true, message: generic });
  }
  if (!changeEmailAllowed(user.id)) {
    return err(res, 429, 'Terlalu banyak permintaan ganti email. Coba lagi setelah satu jam.');
  }
  const result = await emailVerification.changeUserEmail(user, newEmail, {
    resetVerification: isVerified && isSelf,
  });
  if (!result.ok) return err(res, 400, result.message);
  // v1.3.2: akun terverifikasi yang mengganti emailnya sendiri wajib
  // verifikasi ulang sebelum bisa dipakai lagi — sesi dicabut
  // (sesi itu diterbitkan saat akun masih terverifikasi; membiarkannya
  // berarti akun tetap bisa dipakai tanpa verifikasi sampai sesi
  // kedaluwarsa). Layar verifikasi Frontend bekerja tanpa sesi
  // (confirm lewat email + kode membuat sesi baru), jadi pengguna tidak
  // terkunci: kode bisa diminta ulang dari layar verifikasi bila email
  // gagal terkirim. Respons menyertakan email_sent juga supaya cabang
  // Frontend v1.3.2 yang sudah ada (email_sent === true → layar
  // verifikasi) tetap jalan tanpa perubahan.
  // S-02 (v1.3.3): cabut SEMUA sesi pengguna itu, bukan hanya sesi saat
  // ini — sesi di perangkat lain juga harus verifikasi ulang. Pola yang
  // sama seperti ganti password (deleteUserSessions sudah ada di auth).
  if (isVerified && isSelf) {
    auth.deleteUserSessions(user.id);
    auth.clearSessionCookie(res);
    return send(res, 200, {
      ok: true,
      verification_required: true,
      email: newEmail,
      email_sent: result.emailSent,
      message: result.emailSent
        ? 'Email diubah. Kode verifikasi baru sudah dikirim ke email baru kamu.'
        : 'Email diubah, tapi email gagal dikirim. Minta kode baru lewat halaman verifikasi.',
    });
  }
  return send(res, 200, {
    ok: true,
    email_sent: result.emailSent,
    message: result.emailSent
      ? 'Email diubah. Kode verifikasi baru sudah dikirim ke email baru kamu.'
      : 'Email diubah, tapi email gagal dikirim. Minta kode baru lewat halaman verifikasi.',
  });
}

// GET /api/me → profil pengguna login (tanpa password_hash).
function handleMe(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  const pub = req.user;
  return send(res, 200, {
    ok: true,
    user: pub,
    premium: premium.premiumInfo(pub),
    equipped: accessories.getEquipped(pub.id),
    // Level + EXP (v1.3.1): admin selalu level 1000.
    level: levels.levelInfo(pub),
  });
}

// POST /api/watch/complete { anime_id, episode } — tandai satu episode
// selesai ditonton; +10 EXP, hanya sekali per episode per pengguna.
// Endpoint progres yang ada (/api/continue) TIDAK dipakai ulang: ia
// hanya menyimpan posisi tonton berkala dan tidak punya semantik
// "selesai" — event complete datang dari player saat video berakhir.
// F-08 (v1.3.1): SEBELUM memberi EXP, validasi anime_id ada di katalog
// dan nomor episode tidak melebihi jumlah episode anime itu — tanpa ini
// skrip bisa farming EXP dengan (anime_id, episode) fiktif.
// Batas episode = max(is_sub, is_dub) di anime_cache (jumlah episode
// SUB/DUB dari Anikoto), atau episode_count di series_cache bila detail
// anime itu pernah diambil. Catatan progres tonton TIDAK dipakai sebagai
// bukti tambahan: saveContinue saat complete menulis position=0 /
// duration=0 (watch.js) sehingga baris progres saat complete tidak bisa
// diandalkan, dan /api/continue menerima posisi apa pun dari klien
// sehingga buktinya mudah dipalsukan — validasi katalog + nomor episode
// adalah pertahanan yang benar di sini.
function handleWatchComplete(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  // M3: 60 complete per pengguna per menit (satu panggilan per episode
  // selesai — batas ini jauh di atas pemakaian normal, tetapi menahan
  // spam yang menggelembungkan EXP).
  if (!mw.enforceRateLimit(req, res, `complete:${req.user.id}`, 60, 60 * 1000,
    'Terlalu banyak permintaan. Coba lagi sebentar lagi.')) return true;
  const b = bodyOf(req);
  const animeId = Number.parseInt(b.anime_id, 10);
  const episode = Number.parseInt(b.episode, 10);
  if (!Number.isFinite(animeId) || animeId <= 0) return err(res, 400, 'ID anime tidak valid.');
  if (!Number.isFinite(episode) || episode <= 0) return err(res, 400, 'Nomor episode tidak valid.');
  const db = require('../db/database').get();
  const cat = db.prepare('SELECT is_sub, is_dub FROM anime_cache WHERE id = ?').get(animeId);
  if (!cat) return err(res, 404, 'Anime tidak ditemukan di katalog.');
  let maxEp = Math.max(cat.is_sub || 0, cat.is_dub || 0);
  const ser = db.prepare('SELECT episode_count FROM series_cache WHERE id = ?').get(animeId);
  if (ser && ser.episode_count) maxEp = Math.max(maxEp, ser.episode_count);
  if (episode > maxEp) return err(res, 400, 'Nomor episode tidak valid untuk anime ini.');
  const r = levels.awardWatchExp(req.user.id, animeId, episode);
  return send(res, 200, {
    ok: true,
    exp_gained: r.exp_gained,
    exp_total: r.exp_total,
    level: r.level,
    leveled_up: r.leveled_up,
  });
}

// POST /api/account/profile { avatar?, username? } — ubah profil sendiri
// (v1.3.2, panel pensil di halaman akun): pilih avatar preset dan/atau
// ganti nama. Admin boleh ganti nama juga; role tidak berubah (hanya
// kolom avatar/username yang ditulis). Sesi tetap berlaku: sesi memakai
// user id, bukan username (lihat services/auth.js getSessionUser).
// avatar: salah satu dari 8 preset (services/avatars.js); null eksplisit
// = kembali ke avatar default; nilai lain -> 400. username: validasi SAMA
// seperti register (USERNAME_RE 3-32 karakter); sudah dipakai pengguna
// lain -> 409. Tanpa field apa pun -> 400.
function handleUpdateProfile(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  // M3: 10 kali ubah profil per pengguna per 15 menit.
  if (!mw.enforceRateLimit(req, res, `profile:${req.user.id}`, 10, 15 * 60 * 1000,
    'Terlalu banyak perubahan profil. Coba lagi nanti.')) return true;
  const b = bodyOf(req);
  const hasAvatar = Object.prototype.hasOwnProperty.call(b, 'avatar');
  const hasUsername = Object.prototype.hasOwnProperty.call(b, 'username');
  if (!hasAvatar && !hasUsername) {
    return err(res, 400, 'Tidak ada perubahan.');
  }
  let avatar = null;
  let avatarSet = false;
  if (hasAvatar) {
    if (b.avatar === null) {
      avatar = null; avatarSet = true;
    } else if (avatars.isValidAvatar(b.avatar)) {
      avatar = b.avatar; avatarSet = true;
    } else {
      return err(res, 400, 'Avatar tidak dikenal. Pilih salah satu dari avatar yang tersedia.');
    }
  }
  let username = null;
  if (hasUsername) {
    username = typeof b.username === 'string' ? b.username.trim() : '';
    if (!USERNAME_RE.test(username)) {
      return err(res, 400, 'Username 3–32 karakter, hanya huruf, angka, "_" dan "-".');
    }
    const taken = auth.findUserByUsername(username);
    if (taken && taken.id !== req.user.id) {
      return err(res, 409, 'Username sudah dipakai. Pilih username lain.');
    }
  }
  const db = require('../db/database').get();
  const sets = [];
  const params = [];
  if (avatarSet) { sets.push('avatar = ?'); params.push(avatar); }
  if (hasUsername) { sets.push('username = ?'); params.push(username); }
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params, req.user.id);
  const fresh = auth.findUserById(req.user.id);
  const pub = auth.publicUser(fresh);
  return send(res, 200, {
    ok: true,
    user: pub,
    premium: premium.premiumInfo(pub),
    level: levels.levelInfo(pub),
    message: 'Profil diperbarui.',
  });
}

// POST /api/change-password { current, new } → ganti password; sesi di
// perangkat lain dicabut, sesi saat ini tetap jalan.
function handleChangePassword(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  // M3: 5 kali ganti password per pengguna per 15 menit.
  if (!mw.enforceRateLimit(req, res, `changepw:${req.user.id}`, 5, 15 * 60 * 1000,
    'Terlalu banyak percobaan ganti password. Coba lagi nanti.')) return true;
  const b = bodyOf(req);
  const current = b.current;
  const next = b.new;
  const pwErr = checkPassword(next);
  if (pwErr) return err(res, 400, pwErr);
  const full = auth.findUserById(req.user.id);
  if (!full || typeof current !== 'string' || !auth.verifyPassword(current, full.password_hash)) {
    return err(res, 401, 'Password saat ini salah.');
  }
  if (current === next) return err(res, 400, 'Password baru harus berbeda dari password lama.');
  auth.changePassword(req.user.id, next);
  // Cabut semua sesi lain; sesi saat ini dipertahankan.
  const db = require('../db/database').get();
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?')
    .run(req.user.id, req.sessionToken || '');
  return send(res, 200, { ok: true, message: 'Password berhasil diubah. Sesi di perangkat lain sudah dicabut.' });
}

// --- Favorit + lanjutkan menonton (task-10, bagian kecil dari rute akun) ---
// Disimpan di server untuk pengguna login; tamu memakai localStorage di
// frontend (storage.js) karena tidak punya akun. Data anime di-join dari
// anime_cache supaya frontend tidak perlu memanggil /api/series per baris.

function animeSummary(row) {
  if (!row) return null;
  let item = null;
  try { item = JSON.parse(row.payload); } catch { return null; }
  return {
    id: item.id,
    title: item.title || '',
    alternative: item.alternative || null,
    poster: item.poster || null,
    background_image: item.background_image || null,
    score: item.score != null ? item.score : null,
    status: item.status || null,
    year: typeof item.year === 'number' ? item.year : (Number.parseInt(item.year, 10) || null),
    is_sub: item.is_sub || 0,
    is_dub: item.is_dub || 0,
    sub_indo: row.sub_indo ? 1 : 0,
    terms_by_type: item.terms_by_type || null,
  };
}

// GET /api/favorites — Daftar Saya milik pengguna login.
function handleListFavorites(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  const db = require('../db/database').get();
  const rows = db.prepare(
    `SELECT f.created_at, a.payload, a.sub_indo FROM favorites f
     JOIN anime_cache a ON a.id = f.anime_id
     WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 100`,
  ).all(req.user.id);
  const data = rows.map((r) => ({ ...animeSummary(r), saved_at: r.created_at })).filter(Boolean);
  return send(res, 200, { ok: true, data, total: data.length });
}

// POST /api/favorites { anime_id } — tambah ke Daftar Saya.
function handleAddFavorite(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  // M3: 30 aksi favorit per pengguna per menit.
  if (!mw.enforceRateLimit(req, res, `fav:${req.user.id}`, 30, 60 * 1000,
    'Terlalu banyak permintaan. Coba lagi sebentar lagi.')) return true;
  const b = bodyOf(req);
  const animeId = Number.parseInt(b.anime_id, 10);
  if (!Number.isFinite(animeId) || animeId <= 0) {
    return err(res, 400, 'ID anime tidak valid.');
  }
  const db = require('../db/database').get();
  const exists = db.prepare('SELECT id FROM anime_cache WHERE id = ?').get(animeId);
  if (!exists) return err(res, 404, 'Anime tidak ditemukan di katalog.');
  db.prepare(
    'INSERT OR IGNORE INTO favorites (user_id, anime_id, created_at) VALUES (?, ?, ?)',
  ).run(req.user.id, animeId, Math.floor(Date.now() / 1000));
  return send(res, 201, { ok: true, anime_id: animeId, message: 'Ditambahkan ke Daftar Saya.' });
}

// DELETE /api/favorites/:id — hapus dari Daftar Saya.
function handleRemoveFavorite(req, res, idRaw) {
  if (!mw.requireLogin(req, res)) return true;
  if (!mw.enforceRateLimit(req, res, `fav:${req.user.id}`, 30, 60 * 1000,
    'Terlalu banyak permintaan. Coba lagi sebentar lagi.')) return true;
  const animeId = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(animeId) || animeId <= 0) return err(res, 404, 'Anime tidak ditemukan di Daftar Saya.');
  const db = require('../db/database').get();
  const info = db.prepare('DELETE FROM favorites WHERE user_id = ? AND anime_id = ?')
    .run(req.user.id, animeId);
  if (!info.changes) return err(res, 404, 'Anime tidak ada di Daftar Saya.');
  return send(res, 200, { ok: true, anime_id: animeId, message: 'Dihapus dari Daftar Saya.' });
}

// GET /api/continue — posisi tonton pengguna login (terbaru dulu).
function handleListContinue(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  const db = require('../db/database').get();
  const rows = db.prepare(
    `SELECT w.*, a.payload, a.sub_indo FROM watch_progress w
     JOIN anime_cache a ON a.id = w.anime_id
     WHERE w.user_id = ? ORDER BY w.updated_at DESC LIMIT 50`,
  ).all(req.user.id);
  const data = rows.map((r) => {
    const summary = animeSummary(r);
    if (!summary) return null;
    const duration = r.duration_sec || 0;
    const position = r.position_sec || 0;
    return {
      ...summary,
      episode: r.episode,
      position_sec: position,
      duration_sec: duration,
      percent: duration > 0 ? Math.min(100, Math.round((position / duration) * 100)) : 0,
      updated_at: r.updated_at,
    };
  }).filter(Boolean);
  return send(res, 200, { ok: true, data, total: data.length });
}

// GET /api/progress/:animeId — posisi per episode satu anime (untuk
// tanda centang "sudah ditonton" di halaman detail/tonton).
function handleAnimeProgress(req, res, idRaw) {
  if (!mw.requireLogin(req, res)) return true;
  const animeId = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(animeId) || animeId <= 0) return err(res, 404, 'Anime tidak ditemukan.');
  const db = require('../db/database').get();
  const rows = db.prepare(
    'SELECT episode, position_sec, duration_sec, updated_at FROM watch_progress WHERE user_id = ? AND anime_id = ? ORDER BY episode ASC',
  ).all(req.user.id, animeId);
  const data = rows.map((r) => ({
    episode: r.episode,
    position_sec: r.position_sec,
    duration_sec: r.duration_sec,
    percent: r.duration_sec > 0 ? Math.min(100, Math.round((r.position_sec / r.duration_sec) * 100)) : 0,
    watched: r.duration_sec > 0 ? (r.position_sec / r.duration_sec) >= 0.95 : false,
    updated_at: r.updated_at,
  }));
  return send(res, 200, { ok: true, data, total: data.length });
}

// GET /api/history/:animeId — riwayat episode satu anime yang pernah
// ditonton pengguna login (v1.3.2, kartu Riwayat di halaman profil;
// klik kartu -> daftar episode yang ditonton).
// Sumber data: watch_progress (posisi per episode) digabung dengan
// episode_exp_awards (bukti episode selesai, +10 EXP). Catatan jujur:
// watch.js menimpa progres dengan position=0/duration=0 saat complete,
// jadi episode yang selesai bisa ber-percent 0 di watch_progress —
// karena itu "completed" diambil dari award (atau percent >= 95%,
// konsisten dengan flag `watched` di /api/progress), BUKAN dari percent.
// last_watched_at = yang terbaru dari updated_at progres dan awarded_at.
function handleHistory(req, res, idRaw) {
  if (!mw.requireLogin(req, res)) return true;
  const animeId = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(animeId) || animeId <= 0) return err(res, 404, 'Anime tidak ditemukan.');
  const db = require('../db/database').get();
  const byEp = new Map();
  const progRows = db.prepare(
    'SELECT episode, position_sec, duration_sec, updated_at FROM watch_progress WHERE user_id = ? AND anime_id = ?',
  ).all(req.user.id, animeId);
  for (const r of progRows) {
    byEp.set(r.episode, {
      episode: r.episode,
      position_sec: r.position_sec,
      duration_sec: r.duration_sec,
      updated_at: r.updated_at,
      awarded_at: null,
    });
  }
  const awardRows = db.prepare(
    'SELECT episode, awarded_at FROM episode_exp_awards WHERE user_id = ? AND anime_id = ?',
  ).all(req.user.id, animeId);
  for (const r of awardRows) {
    const cur = byEp.get(r.episode);
    if (cur) cur.awarded_at = r.awarded_at;
    else byEp.set(r.episode, {
      episode: r.episode,
      position_sec: 0,
      duration_sec: 0,
      updated_at: r.awarded_at,
      awarded_at: r.awarded_at,
    });
  }
  const data = [...byEp.values()]
    .sort((a, b) => a.episode - b.episode)
    .map((e) => {
      const percent = e.duration_sec > 0
        ? Math.min(100, Math.round((e.position_sec / e.duration_sec) * 100)) : 0;
      return {
        episode: e.episode,
        position_sec: e.position_sec,
        duration_sec: e.duration_sec,
        percent,
        // Selesai = ada award EXP, atau posisi >= 95% (sama seperti
        // `watched` di /api/progress). Episode selesai via event complete
        // bisa ber-percent 0 karena watch.js menimpa progres 0/0.
        completed: e.awarded_at !== null || percent >= 95,
        last_watched_at: Math.max(e.updated_at || 0, e.awarded_at || 0),
      };
    });
  return send(res, 200, { ok: true, anime_id: animeId, data, total: data.length });
}

// POST /api/continue { anime_id, episode, position_sec, duration_sec } —
// simpan posisi tonton. Dipanggil berkala dari player (hemat: frontend
// membatasi paling cepat tiap 10 detik, kecuali mendekati selesai).
function handleSaveContinue(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  // M3: 60 simpan progres per pengguna per menit (pemutar mengirim
  // paling cepat tiap 10 detik — batas ini jauh di atas pemakaian normal,
  // tetapi menahan spam yang menggelembungkan watch_progress).
  if (!mw.enforceRateLimit(req, res, `continue:${req.user.id}`, 60, 60 * 1000,
    'Terlalu banyak permintaan. Coba lagi sebentar lagi.')) return true;
  const b = bodyOf(req);
  const animeId = Number.parseInt(b.anime_id, 10);
  const episode = Number.parseInt(b.episode, 10);
  const position = Math.max(0, Math.floor(Number(b.position_sec) || 0));
  const duration = Math.max(0, Math.floor(Number(b.duration_sec) || 0));
  if (!Number.isFinite(animeId) || animeId <= 0) return err(res, 400, 'ID anime tidak valid.');
  if (!Number.isFinite(episode) || episode <= 0) return err(res, 400, 'Nomor episode tidak valid.');
  if (position > 86400 || duration > 86400) return err(res, 400, 'Posisi atau durasi di luar batas wajar.');
  const now = Math.floor(Date.now() / 1000);
  const db = require('../db/database').get();
  db.prepare(
    `INSERT INTO watch_progress (user_id, anime_id, episode, position_sec, duration_sec, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, anime_id, episode) DO UPDATE SET
       position_sec=excluded.position_sec, duration_sec=excluded.duration_sec, updated_at=excluded.updated_at`,
  ).run(req.user.id, animeId, episode, position, duration, now);
  return send(res, 200, { ok: true, message: 'Posisi tonton tersimpan.' });
}

// DELETE /api/continue/:animeId — hapus riwayat tonton satu anime.
function handleRemoveContinue(req, res, idRaw) {
  if (!mw.requireLogin(req, res)) return true;
  if (!mw.enforceRateLimit(req, res, `continue-del:${req.user.id}`, 10, 60 * 1000,
    'Terlalu banyak permintaan. Coba lagi sebentar lagi.')) return true;
  const animeId = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(animeId) || animeId <= 0) return err(res, 404, 'Anime tidak ditemukan.');
  const db = require('../db/database').get();
  db.prepare('DELETE FROM watch_progress WHERE user_id = ? AND anime_id = ?').run(req.user.id, animeId);
  return send(res, 200, { ok: true, message: 'Riwayat tonton dihapus.' });
}

// Router /api/* akun — dipanggil server.js. Mengembalikan true bila dikenali.
function route(req, res, url) {
  const path = url.pathname;
  if (path === '/api/register' && req.method === 'POST') return handleRegister(req, res);
  if (path === '/api/login' && req.method === 'POST') return handleLogin(req, res);
  if (path === '/api/logout' && req.method === 'POST') return handleLogout(req, res);
  // v1.3.0: verifikasi email OTP.
  if (path === '/api/auth/verify/confirm' && req.method === 'POST') return handleVerifyConfirm(req, res);
  if (path === '/api/auth/verify/request' && req.method === 'POST') return handleVerifyRequest(req, res);
  // v1.3.1: ganti/tambah email akun belum terverifikasi.
  if (path === '/api/auth/verify/change-email' && req.method === 'POST') return handleVerifyChangeEmail(req, res);
  // Lupa password: minta kode reset + atur ulang password.
  if (path === '/api/auth/password/forgot' && req.method === 'POST') return handlePasswordForgot(req, res);
  if (path === '/api/auth/password/reset' && req.method === 'POST') return handlePasswordReset(req, res);
  if (path === '/api/me' && req.method === 'GET') return handleMe(req, res);
  if (path === '/api/change-password' && req.method === 'POST') return handleChangePassword(req, res);
  // v1.3.2: ubah profil (avatar preset + ganti nama) + riwayat episode.
  if (path === '/api/account/profile' && req.method === 'POST') return handleUpdateProfile(req, res);
  const histMatch = path.match(/^\/api\/history\/(\d+)$/);
  if (histMatch && req.method === 'GET') return handleHistory(req, res, histMatch[1]);
  if (path === '/api/favorites' && req.method === 'GET') return handleListFavorites(req, res);
  if (path === '/api/favorites' && req.method === 'POST') return handleAddFavorite(req, res);
  const favMatch = path.match(/^\/api\/favorites\/(\d+)$/);
  if (favMatch && req.method === 'DELETE') return handleRemoveFavorite(req, res, favMatch[1]);
  if (path === '/api/continue' && req.method === 'GET') return handleListContinue(req, res);
  if (path === '/api/continue' && req.method === 'POST') return handleSaveContinue(req, res);
  // v1.3.1: tandai episode selesai → EXP menonton.
  if (path === '/api/watch/complete' && req.method === 'POST') return handleWatchComplete(req, res);
  const progMatch = path.match(/^\/api\/progress\/(\d+)$/);
  if (progMatch && req.method === 'GET') return handleAnimeProgress(req, res, progMatch[1]);
  const contMatch = path.match(/^\/api\/continue\/(\d+)$/);
  if (contMatch && req.method === 'DELETE') return handleRemoveContinue(req, res, contMatch[1]);
  return false;
}

module.exports = { route, send, err };
