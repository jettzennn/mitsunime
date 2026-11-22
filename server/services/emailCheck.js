'use strict';
// Tolak email dummy saat pendaftaran (v1.2.0): domain tanpa MX record
// dan domain email sekali pakai / sementara. Dipakai routes/account.js
// handleRegister — hanya bila email diisi (email opsional saat daftar).
//
// JUJUR TENTANG BATASNYA: cara ini memblokir domain palsu dan layanan
// email sekali pakai yang dikenal, tetapi TIDAK membuktikan kepemilikan
// email — siapa pun bisa mendaftar dengan alamat Gmail orang lain
// bila formatnya benar dan domainnya punya MX. Pembuktian kepemilikan
// butuh verifikasi kode lewat SMTP (langkah lanjutan yang terpisah dan
// butuh pengaturan email) — bukan bagian dari fitur ini.
//
// Cara kerja MX:
// 1. dns.resolveMx bawaan Node (tanpa dependensi, tanpa kunci).
// 2. Bila resolver lokal gagal (menolak/timeout — terjadi di sandbox
//    ini dan bisa terjadi di Termux bila DNS operator bermasalah),
//    tanyakan DNS-over-HTTPS ke dns.google (GET /resolve?type=MX).
//    Ini tetap tanpa kunci dan tanpa akun.
// 3. Bila KEDUA jalur tidak bisa memastikan (jaringan DNS mati total),
//    pendaftaran DILANJUTKAN (fail open) dengan peringatan di log —
//    lebih baik daripada mengunci pengguna asli saat DNS sedang
//    bermasalah. Satu-satunya yang ditolak tegas: domain yang
//    terbukti tidak punya MX (NXDOMAIN / jawaban kosong).
const dns = require('node:dns').promises;
const logger = require('../utils/logger');

// Domain layanan email sekali pakai / sementara yang umum (dirangkum
// dari layanan yang dikenal luas, 2026). Cocokkan persis ATAU subdomain
// dari yang terdaftar (mis. apa pun .mailinator.com ikut tertolak).
const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com', '10minutemail.net', '20minutemail.com', '30minutemail.com',
  'anonymbox.com', 'anonymail.com', 'binkmail.com', 'bobmail.info',
  'chammy.info', 'deadaddress.com', 'despam.it', 'devnullmail.com',
  'dispostable.com', 'e4ward.com', 'emailondeck.com', 'emailtemporanea.com',
  'fakeinbox.com', 'getairmail.com', 'getnada.com', 'grr.la',
  'guerrillamail.com', 'guerrillamailblock.com', 'guerrillamail.net', 'guerrillamail.org',
  'harakirimail.com', 'incognitomail.com', 'infraconn.com', 'jetable.org',
  'kasmail.com', 'letthemeatspam.com', 'mail-temporaire.fr', 'mailcatch.com',
  'maildrop.cc', 'mailforspam.com', 'mailimate.com', 'mailinator.com',
  'mailna.me', 'mailnesia.com', 'mailnull.com', 'mailshell.com',
  'mailtm.com', 'mail.tm', 'mintemail.com', 'moakt.com', 'mohmal.com',
  'mytemp.email', 'notmail.com', 'nurfuerspam.de', 'pookmail.com',
  'sharklasers.com', 'sneakemail.com', 'soodonims.com', 'spam4.me',
  'spambox.us', 'spamcero.com', 'spamday.com', 'spamex.com',
  'spamgourmet.com', 'spammotel.com', 'spambog.com', 'spam.la', 'spam.su',
  'superrito.com', 'tempail.com', 'tempinbox.com', 'temp-mail.org',
  'tempmail.com', 'tempmailaddress.com', 'tempmailo.com', 'tempomail.fr',
  'temp-mail.de', 'temporaryemail.net', 'tempemail.com', 'tempr.email',
  'thankyou2010.com', 'throwawaymail.com', 'tmpmail.net', 'tmpmail.org',
  'trash2000.com', 'trashmail.com', 'trashmail.de', 'trashmail.net',
  'trashymail.com', 'uplip.com', 'wegwerfmail.de', 'wegwerfmail.net',
  'wegwerfmail.org', 'willselfdestruct.com', 'yopmail.com', 'yopmail.fr',
  'yopmail.net', 'zoemail.com',
]);

// Domain email yang diizinkan untuk pendaftaran (v1.5.7, item 36 —
// keputusan Faygo 2026-11-21): HANYA tiga keluarga ini — Google,
// Yahoo, Microsoft. Daftar FINAL, tanpa tambahan diam-diam.
// Pencocokan PERSIS (lihat isAllowedEmailDomain): subdomain dari
// domain yang diizinkan pun DITOLAK (mis. mail.yahoo.com ditolak
// walau yahoo.com diizinkan). Aturannya kebalikan dari daftar
// sekali pakai di atas (yang cocok akhiran); di sini hanya persis
// yang lolos.
const ALLOWED_EMAIL_DOMAINS = new Set([
  // Google
  'gmail.com', 'googlemail.com',
  // Yahoo
  'yahoo.com', 'yahoo.co.id', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
  // Microsoft
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.co.id',
]);

function isAllowedEmailDomain(email) {
  const domain = domainOf(email);
  if (!domain) return false;
  return ALLOWED_EMAIL_DOMAINS.has(domain);
}

function domainOf(email) {
  if (typeof email !== 'string') return '';
  const at = email.lastIndexOf('@');
  if (at <= 0) return '';
  return email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '');
}

function isDisposableDomain(domain) {
  if (!domain) return false;
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  for (const base of DISPOSABLE_DOMAINS) {
    if (domain.endsWith('.' + base)) return true;
  }
  return false;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TIMEOUT')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// resolveMx sistem: true = ada MX, false = terbukti tidak ada MX
// (ENODATA/ENOTFOUND), null = resolver-nya sendiri yang gagal.
async function resolveMxSystem(domain) {
  try {
    const recs = await withTimeout(dns.resolveMx(domain), 3000);
    return Array.isArray(recs) && recs.length > 0;
  } catch (e) {
    if (e && (e.code === 'ENODATA' || e.code === 'ENOTFOUND')) return false;
    return null;
  }
}

// DNS-over-HTTPS (dns.google, tanpa kunci): true/false/null seperti di atas.
async function resolveMxDoh(domain) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    let res;
    try {
      res = await fetch(
        'https://dns.google/resolve?name=' + encodeURIComponent(domain) + '&type=MX',
        { signal: controller.signal, headers: { Accept: 'application/dns-json' } },
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const data = await res.json();
    // Status 3 = NXDOMAIN (domain tidak ada). Status 0 tanpa Answer =
    // domain ada tetapi tanpa MX. Keduanya = tidak bisa terima email.
    if (data.Status === 3) return false;
    if (data.Status === 0) {
      const answers = Array.isArray(data.Answer) ? data.Answer.filter((a) => a.type === 15) : [];
      return answers.length > 0;
    }
    return null;
  } catch {
    return null;
  }
}

// true = domain punya MX, false = terbukti tidak punya, null = tidak
// bisa dipastikan (kedua jalur DNS gagal — pemanggil memutuskan).
async function hasMxRecord(domain) {
  const sys = await resolveMxSystem(domain);
  if (sys !== null) return sys;
  return resolveMxDoh(domain);
}

// Periksa email untuk pendaftaran. Mengembalikan null bila boleh lanjut,
// atau pesan galat Bahasa Indonesia bila harus ditolak. Tidak pernah
// mengirim email apa pun.
//
// Urutan (v1.5.7, item 36 — mengikat): allowlist DULU (murah, sinkron,
// tanpa DNS) → lalu pemeriksaan lama (sekali pakai + MX) tetap jalan
// sesudahnya untuk domain yang lolos allowlist. Allowlist berlaku di
// pendaftaran DAN ganti email (keduanya memanggil fungsi ini);
// TIDAK berlaku di login, reset password, dan login Google.
async function checkRegistrationEmail(email) {
  const domain = domainOf(email);
  if (!domain) return 'Alamat email tidak valid.';
  if (!isAllowedEmailDomain(email)) {
    return 'Pendaftaran hanya menerima email Google, Yahoo, atau Microsoft (mis. Gmail, Yahoo Mail, Outlook). Subdomain tidak diterima.';
  }
  if (isDisposableDomain(domain)) {
    return 'Alamat email sekali pakai tidak diterima. Gunakan alamat email asli Anda.';
  }
  const mx = await hasMxRecord(domain);
  if (mx === false) {
    return 'Domain email ini tidak ditemukan atau tidak bisa menerima email. Periksa kembali alamat email Anda, atau gunakan email asli (mis. Gmail).';
  }
  if (mx === null) {
    logger.warn(`Pemeriksaan MX ${domain} tidak bisa dipastikan (DNS tidak terjangkau) — pendaftaran dilanjutkan.`);
  }
  return null;
}

module.exports = { domainOf, isDisposableDomain, isAllowedEmailDomain, hasMxRecord, checkRegistrationEmail };
