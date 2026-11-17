'use strict';
// Tool diagnosa email Mitsunime (v1.3.3) — jalankan di Termux:
//   node scripts/test-email.js alamat@tujuan.com
// Mengirim SATU email tes lewat mailer yang sama persis dengan yang
// dipakai OTP (server/services/mailer.js + konfigurasi .env), lalu
// mencetak tiap tahap berhasil/gagal dalam Bahasa Indonesia beserta
// arti kode SMTP umum. TANPA mencetak password / isi .env.
// Exit code: 0 = terkirim, 1 = gagal / belum dikonfigurasi / argumen salah.
const config = require('../server/config');
const mailer = require('../server/services/mailer');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function artiKode(err) {
  const msg = String(err && err.message ? err.message : err || '');
  const code = err && err.smtpCode ? err.smtpCode : null;
  const hints = [];
  if (code === 535 || /\b535\b/.test(msg)) {
    hints.push('535 = login ditolak: SMTP_PASS kemungkinan salah, atau bukan App Password Gmail. Gmail wajib App Password (16 huruf, butuh Verifikasi 2 Langkah aktif) — password Gmail biasa TIDAK bisa dipakai. Cek juga SMTP_USER adalah alamat Gmail yang sama dengan pemilik App Password itu.');
  }
  if (code === 534 || /\b534\b/.test(msg)) {
    hints.push('534 = mekanisme autentikasi ditolak: biasanya App Password / pengaturan keamanan akun Google perlu dicek ulang.');
  }
  if (code === 530 || /\b530\b/.test(msg)) {
    hints.push('530 = autentikasi/TLS wajib: server menolak sebelum login — cek SMTP_HOST/SMTP_PORT (Gmail: smtp.gmail.com port 587 atau 465).');
  }
  if (code === 550 || /\b550\b/.test(msg)) {
    hints.push('550 = permintaan ditolak server: alamat pengirim/tujuan ditolak, atau pengiriman dibatasi. Cek SMTP_FROM (kosongkan saja supaya sama dengan SMTP_USER) dan alamat tujuan.');
  }
  if (code === 421 || code === 450 || code === 451 || /\b42[01]\b|\b45[01]\b/.test(msg)) {
    hints.push('Kode 4xx = gangguan sementara di server/jaringan: tunggu beberapa menit lalu coba lagi.');
  }
  if (/timeout|habis|ETIMEDOUT/i.test(msg)) {
    hints.push('Timeout = jaringan lambat atau port SMTP diblokir operator/Wi-Fi. Coba jaringan lain (data seluler vs Wi-Fi), dan pastikan tidak ada VPN yang menghalangi. Mailer v1.3.3 sudah otomatis mencoba port cadangan 587 <-> 465.');
  }
  if (/ECONNREFUSED|ECONNRESET|EPIPE|Tidak ada respons/i.test(msg)) {
    hints.push('Koneksi ditolak/terputus = port kemungkinan diblokir atau SMTP_HOST salah. Untuk Gmail host harus smtp.gmail.com.');
  }
  if (/certificate|self.signed|CERT|TLS|STARTTLS/i.test(msg)) {
    hints.push('Masalah TLS/sertifikat = koneksi aman gagal dibangun. Cek tanggal/jam HP benar, lalu coba lagi; jangan matikan verifikasi sertifikat.');
  }
  if (/tidak mendukung TLS/i.test(msg)) {
    hints.push('Server tidak menawarkan TLS: kredensial sengaja TIDAK dikirim demi keamanan. Pastikan SMTP_HOST benar (smtp.gmail.com).');
  }
  if (hints.length === 0) {
    hints.push('Tidak ada petunjuk khusus untuk galat ini — baca tahap + kode SMTP pada pesan galat di atas, lalu cek kembali SMTP_HOST, SMTP_PORT, SMTP_USER, dan App Password di .env.');
  }
  return hints;
}

async function main() {
  const to = String(process.argv[2] || '').trim();
  console.log('=== Tes Email Mitsunime ===');
  if (!to || !EMAIL_RE.test(to)) {
    console.log('GAGAL: alamat tujuan tidak valid.');
    console.log('Pemakaian: node scripts/test-email.js alamat@tujuan.com');
    process.exit(1);
  }
  console.log(`Tujuan: ${to}`);
  console.log('[tahap 1/3] Memeriksa konfigurasi SMTP di .env ...');
  const missing = [];
  if (!config.SMTP_HOST) missing.push('SMTP_HOST (contoh Gmail: smtp.gmail.com)');
  if (!config.SMTP_USER) missing.push('SMTP_USER (alamat Gmail pengirim)');
  if (!config.SMTP_PASS) missing.push('SMTP_PASS (App Password Gmail, bukan password biasa)');
  if (missing.length) {
    console.log('GAGAL: SMTP belum dikonfigurasi. Yang kurang:');
    for (const m of missing) console.log(`  - ${m}`);
    console.log('Isi ketiganya di file .env di folder Mitsunime ini, lalu jalankan tes lagi.');
    process.exit(1);
  }
  // Hanya status umum — host/port boleh ditampilkan (bukan rahasia),
  // user ditampilkan ter-mask, password TIDAK PERNAH ditampilkan.
  const maskedUser = config.SMTP_USER.replace(/^(.).*(@.*)$/, '$1***$2');
  console.log(`  OK: SMTP terkonfigurasi (host: ${config.SMTP_HOST}, port: ${config.SMTP_PORT}, user: ${maskedUser}, password: terisi [tidak ditampilkan]).`);
  console.log('  Catatan: spasi pada App Password otomatis dibersihkan oleh server (v1.3.3).');
  console.log('[tahap 2/3] Menghubungi server SMTP + login + mengirim email tes ...');
  console.log('  (Mailer otomatis mencoba port cadangan 587 <-> 465 bila tahap koneksi/TLS gagal, dan mengulang sekali untuk gangguan sesaat. Mohon tunggu, batas waktu sampai ~45 detik per percobaan.)');
  try {
    await mailer.sendMail({
      to,
      subject: 'Tes email Mitsunime',
      text: 'Halo,\n\nIni email tes dari Mitsunime (scripts/test-email.js).\nBila kamu membaca ini, pengiriman email OTP Mitsunime sudah bekerja.\n\n— Mitsunime',
    });
  } catch (e) {
    console.log(`GAGAL terkirim: ${e && e.message ? e.message : e}`);
    if (e && e.smtpStage) console.log(`  Tahap gagal: ${e.smtpStage}${e.smtpCode ? ` (kode SMTP: ${e.smtpCode})` : ''}`);
    console.log('[tahap 3/3] Arti galat:');
    for (const h of artiKode(e)) console.log(`  - ${h}`);
    process.exit(1);
  }
  console.log('  OK: server SMTP menerima email (balasan 250 sesudah DATA).');
  console.log('[tahap 3/3] SELESAI: email tes TERKIRIM. Cek kotak masuk (dan folder Spam) alamat tujuan.');
  process.exit(0);
}

main().catch((e) => {
  console.log(`GAGAL: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
