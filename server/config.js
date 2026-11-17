'use strict';
// Konfigurasi Mitsunime — semua dari environment (.env), semua punya nilai
// default sehingga server jalan tanpa file .env.
// Parser .env ditulis sendiri (tanpa dependensi dotenv) agar tetap
// nol-dependensi di Termux. Rahasia TIDAK PERNAH ditulis di kode.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

function num(name, fallback) {
  const v = Number.parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

module.exports = {
  ROOT,
  PORT: num('PORT', 3000),
  HOST: process.env.HOST || '0.0.0.0',
  ANIKOTO_BASE_URL: (process.env.ANIKOTO_BASE_URL || 'https://anikotoapi.site').replace(/\/$/, ''),
  // Alamat publik situs ini (dipakai tautan di surat, mis. reset
  // password). Default localhost:3000 untuk Termux; isi alamat publik
  // bila situs di-hosting (mis. https://mitsunime.contoh).
  BASE_URL: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  MEGAPLAY_BASE_URL: 'https://megaplay.buzz',
  // TTL cache: recent 15 menit, series 1 jam.
  RECENT_TTL_SECONDS: num('RECENT_TTL_SECONDS', 15 * 60),
  SERIES_TTL_SECONDS: num('SERIES_TTL_SECONDS', 60 * 60),
  // Banner "data mungkin tidak terbaru" (v1.2.0): hanya muncul bila data
  // terbaru di cache sudah lebih tua dari ini. 12 jam — pemakaian
  // sehari-hari (sync pagi, dibuka sore hari) tidak memunculkan banner;
  // data sehari atau lebih yang belum di-sync baru memunculkannya.
  // Berbeda dari RECENT_TTL_SECONDS (15 menit) yang dipakai untuk
  // keputusan refresh internal, BUKAN untuk banner.
  STALE_BANNER_AGE_SECONDS: num('STALE_BANNER_AGE_SECONDS', 12 * 3600),
  DB_PATH: process.env.DB_PATH || path.join(ROOT, 'data', 'mitsunime.db'),
  PUBLIC_DIR: path.join(ROOT, 'public'),
  // Rate limit Anikoto (terverifikasi langsung): 60 request / IP / 120 detik.
  RATE_LIMIT_MAX: 60,
  RATE_LIMIT_WINDOW_MS: 120 * 1000,
  // Percobaan ulang untuk gangguan sesaat Anikoto (jaringan/timeout/5xx).
  MAX_RETRIES_TRANSIENT: 2,
  // Jeda minimum antar request ke Anikoto (hemat kuota + jaga limit).
  MIN_REQUEST_GAP_MS: 1000,
  FETCH_TIMEOUT_MS: 20000,
  MAX_RETRIES_429: 3,
  // Rute admin tersembunyi: token acak dari .env, tanpa default yang bisa ditebak.
  // Bila kosong, rute admin tidak hidup sama sekali.
  ADMIN_PATH: (process.env.ADMIN_PATH || '').trim(),
  // Sesi server-side: 30 hari.
  SESSION_TTL_SECONDS: num('SESSION_TTL_SECONDS', 30 * 24 * 60 * 60),
  // Nama cookie sesi + apakah cookie Secure (aktifkan bila situs sudah HTTPS;
  // di localhost HTTP harus false, kalau tidak cookie tidak akan tersimpan).
  COOKIE_NAME: process.env.COOKIE_NAME || 'mitsunime_session',
  // v1.3.1 (G): cookie sesi admin BERBEDA dari cookie sesi user supaya
  // login admin tidak menimpa sesi user biasa di browser yang sama
  // (satu origin, satu nama cookie sebelumnya membuat halaman akun
  // posoposa3 berubah menjadi faygo setelah login admin + refresh).
  ADMIN_COOKIE_NAME: process.env.ADMIN_COOKIE_NAME || 'mitsunime_admin_session',
  COOKIE_SECURE: (process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true',
  // --- Gateway pembayaran (keputusan pengguna 2026-11-15: Midtrans sandbox) ---
  // Adapter dipilih lewat PAYMENT_GATEWAY; nilainya 'midtrans' dan kunci di .env.
  // Bila pengguna nanti bilang Xendit, tambah adapter xendit dengan antarmuka
  // yang sama dan ganti nilai ini — tanpa mengubah route premium.
  PAYMENT_GATEWAY: (process.env.PAYMENT_GATEWAY || 'midtrans').trim().toLowerCase(),
  MIDTRANS_SERVER_KEY: (process.env.MIDTRANS_SERVER_KEY || '').trim(),
  MIDTRANS_CLIENT_KEY: (process.env.MIDTRANS_CLIENT_KEY || '').trim(),
  // --- Email verifikasi OTP (v1.3.0) ---
  // Semua kosong secara default = verifikasi NONAKTIF (register/login
  // jalan seperti v1.2.0). Aktif hanya bila ketiganya terisi: host, user,
  // DAN password. SMTP_FROM boleh kosong (dipakai SMTP_USER sebagai
  // pengirim). Port 587 = STARTTLS (Gmail), 465 = TLS langsung.
  SMTP_HOST: (process.env.SMTP_HOST || '').trim(),
  SMTP_PORT: num('SMTP_PORT', 587),
  SMTP_USER: (process.env.SMTP_USER || '').trim(),
  // v1.3.3: App Password Gmail tampil dengan spasi ("xxxx xxxx xxxx xxxx")
  // — bila user menempel apa adanya, AUTH pasti gagal 535. Bersihkan SEMUA
  // whitespace (spasi/tab/newline) dari password, bukan hanya trim ujung.
  // Password TIDAK PERNAH ditulis ke log.
  SMTP_PASS: (process.env.SMTP_PASS || '').replace(/\s+/g, ''),
  SMTP_FROM: (process.env.SMTP_FROM || '').trim(),
  // --- Auto-seed admin (v1.3.0) ---
  // Bila keduanya terisi dan belum ada admin, server membuat akun admin
  // dari nilai ini saat pertama start (lihat services/adminSeed.js).
  // ADMIN_USER bukan rahasia; ADMIN_PASS ADALAH rahasia — jangan pernah
  // kirim lewat chat atau tulis ke file yang dibagikan.
  ADMIN_USER: (process.env.ADMIN_USER || '').trim(),
  ADMIN_PASS: process.env.ADMIN_PASS || '',
  // 'true' = sandbox (app.sandbox.midtrans.com), 'false' = produksi.
  MIDTRANS_SANDBOX: (process.env.MIDTRANS_SANDBOX || 'true').toLowerCase() !== 'false',
  // Terjemahan sinopsis v1.2.0 (opsional): alamat email untuk parameter
  // &de= MyMemory — BUKAN kunci/API key, hanya penanda pemakaian yang
  // menaikkan kuota gratis MyMemory dari 5.000 menjadi 50.000 karakter
  // per hari per IP. Kosong = anonim (kuota 5.000/hari, dipakai bersama
  // per IP sehingga bisa habis). Isi di .env bila kuota anonim sering
  // habis; jangan tulis email orang lain.
  MYMEMORY_EMAIL: (process.env.MYMEMORY_EMAIL || '').trim(),
  // TIDAK DIPAKAI di v1 (keputusan pengguna 2026-11-15 ~06:55 WIB): tidak ada
  // kunci konten — episode baru 7 hari dan judul premium_only dari PRD
  // TIDAK dipakai. Disimpan sebagai knob bila model kunci dihidupkan lagi.
  PREMIUM_NEW_DAYS: num('PREMIUM_NEW_DAYS', 7),
  // Seed/sync: jumlah halaman per jalan dan ukuran halaman API.
  SEED_PAGES: num('SEED_PAGES', 50),
  SEED_PER_PAGE: 100,
  SYNC_LIGHT_PAGES: 5,
  // Batas pagination API sendiri (lindungi server HP).
  MAX_PER_PAGE: num('MAX_PER_PAGE', 50),
  DEFAULT_PER_PAGE: num('DEFAULT_PER_PAGE', 20),
};
