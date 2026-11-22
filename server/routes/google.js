'use strict';
// Rute login Google (v1.5.7, item 37; v1.5.8, item 41) — OAuth 2.0
// Authorization Code.
//   GET /api/auth/google/config    → { configured: true|false }
//   GET /api/auth/google           → mulai (302 ke accounts.google.com)
//   GET /api/auth/google/callback  → kembali dari Google
//   GET /api/auth/google/status    → status tukar kode (poll halaman transisi)
//   GET /api/auth/google/land      → pasang cookie sesi, 302 ke /account.html
// TANPA PKCE (diputuskan di PRD §4.7.3 butir 1): confidential client;
// `state` adalah pelindung CSRF-nya. State disimpan di cookie HttpOnly
// sekali pakai (dihapus sesudah dipakai, cocok atau tidak).
// Secret TIDAK PERNAH muncul di respons/log — hanya dipakai di dalam
// tukar kode (services/google.js).
//
// Item 41 (v1.5.8): kegagalan callback TIDAK PERNAH lagi menampilkan
// JSON mentah pada navigasi top-level — browser dialihkan (302) ke
// halaman login dengan ?google_err=<kode>, dan halaman login
// menampilkan pesan Bahasa Indonesia (account.js). JSON hanya bila
// permintaan meminta application/json (Accept / X-Requested-With).
// Selama tukar kode, callback langsung mengembalikan halaman transisi
// ("Menghubungkan ke Google…") dan tukar kode berjalan di latar
// belakang di bawah tiket sekali pakai; endpoint /land memasang cookie
// sesi sesudah tukar kode selesai — cookie sesi hanya bisa dibuat
// sesudah profil Google didapat. State tetap sekali pakai
// (timingSafeEqual, cookie dihapus di setiap jawaban callback) dan
// batas laju tidak dilonggarkan (PRD §4.3.4.4).
//
// Item 54 B1 (v1.5.10): callback + land IDEMPOTEN (race tab Chrome +
// PWA memuat callback dua kali). Callback kedua dengan code+state yang
// sama mengembalikan halaman transisi yang SAMA (tiket yang sama) —
// dicocokkan lewat hash code + state query, karena cookie state sudah
// dihapus pemuatan pertama. /land boleh dipakai dua kali untuk tiket
// yang sama selama hasilnya 'done' — tiket selesai disimpan sampai
// TTL 5 menit, baru dihapus. Tukar kode tetap SEKALI (code Google
// sekali pakai; konteks kedua memakai hasil yang sama).
const crypto = require('node:crypto');
const config = require('../config');
const auth = require('../services/auth');
const mw = require('../middleware/auth');
const google = require('../services/google');
const logger = require('../utils/logger');

const STATE_COOKIE = 'mitsu_oauth_state';
const STATE_MAX_AGE_SECONDS = 600; // 10 menit
const TICKET_TTL_MS = 5 * 60 * 1000; // 5 menit — tiket sekali pakai

// Pesan Bahasa Indonesia per kode google_err. Kode yang sama dipakai
// server (redirect) dan account.js (tampilan) — jangan ubah satu sisi
// saja.
const GOOGLE_ERR_MESSAGES = {
  login: 'Login Google gagal. Coba lagi.',
  code: 'Kode login Google tidak berlaku.',
  network: 'Gagal menghubungi Google.',
  admin: 'Akun ini tidak bisa masuk lewat Google.',
  rate: 'Terlalu banyak percobaan login. Coba lagi 15 menit lagi.',
  config: 'Login Google belum dikonfigurasi.',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
function err(res, status, message) { return send(res, status, { ok: false, message }); }

// Benar bila permintaan ini mengharapkan JSON (bukan navigasi
// top-level): header Accept meminta application/json, atau header
// X-Requested-With dari XHR/fetch. Navigasi biasa (Accept text/html)
// dan fetch tanpa Accept JSON → false → dialihkan ke halaman login.
function wantsJson(req) {
  const accept = String((req.headers && req.headers.accept) || '');
  if (accept.toLowerCase().includes('application/json')) return true;
  const xrw = String((req.headers && req.headers['x-requested-with']) || '');
  return xrw.toLowerCase() === 'xmlhttprequest';
}

// Jawaban gagal yang sadar jenis permintaan: JSON (status + pesan)
// bila diminta JSON, 302 ke halaman login + ?google_err=<kode> bila
// navigasi. Dipakai start (503 belum dikonfigurasi) dan callback.
function redirectOrJson(req, res, status, code) {
  const message = GOOGLE_ERR_MESSAGES[code] || GOOGLE_ERR_MESSAGES.login;
  if (wantsJson(req)) return err(res, status, message);
  res.writeHead(302, {
    Location: `/account.html?mode=login&google_err=${encodeURIComponent(code)}`,
    'Cache-Control': 'no-store',
  });
  res.end();
  return true;
}

function stateCookieValue(state) {
  const parts = [
    `${STATE_COOKIE}=${state}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${STATE_MAX_AGE_SECONDS}`,
  ];
  if (config.COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

function clearStateCookieValue() {
  const parts = [`${STATE_COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (config.COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

// Tambah satu Set-Cookie tanpa menimpa yang sudah dipasang (mis.
// cookie sesi dari setSessionCookie + penghapus cookie state).
function appendSetCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) { res.setHeader('Set-Cookie', value); return; }
  res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, value] : [existing, value]);
}

// GET /api/auth/google/config — hanya { configured } (TIDAK PERNAH
// mengembalikan client id / secret). Dipakai frontend untuk
// menampilkan/menyembunyikan tombol Google.
function handleGoogleConfig(req, res) {
  return send(res, 200, { ok: true, configured: google.isGoogleConfigured() });
}

// GET /api/auth/google — mulai: buat state acak, simpan di cookie
// HttpOnly sekali pakai, redirect 302 ke Google. Bila GOOGLE_*
// kosong → 503 dengan pesan konfigurasi (bukan 500 / redirect rusak);
// pada navigasi, 503 itu dialihkan ke halaman login + google_err.
function handleGoogleStart(req, res) {
  if (!google.isGoogleConfigured()) {
    return redirectOrJson(req, res, 503, 'config');
  }
  // PRD §4.7.3 butir 9: mulai dibatasi 30/IP/15 menit. Batas dihitung
  // sekali per panggilan lewat rateLimited (sama seperti
  // enforceRateLimit), tapi jawaban 429 lewat redirectOrJson — navigasi
  // kembali ke halaman login (?google_err=rate), JSON hanya bila
  // diminta (F-02 v1.5.8, TB2). Batas TIDAK dilonggarkan.
  if (mw.rateLimited(`google-start:${mw.clientIp(req)}`, 30, 15 * 60 * 1000)) {
    return redirectOrJson(req, res, 429, 'rate');
  }
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', stateCookieValue(state));
  res.writeHead(302, { Location: google.buildAuthUrl(state), 'Cache-Control': 'no-store' });
  res.end();
  return true;
}

// ---- Tiket tukar kode (item 41) -------------------------------------
// Satu tiket = satu callback yang lolos cek state. Tiket acak 32 byte,
// sekali pakai, TTL 5 menit. Tukar kode berjalan di latar belakang;
// halaman transisi mem-poll /status, lalu /land memasang cookie sesi.
const pendingTickets = new Map(); // ticket -> { status, userId, errorCode, promise, createdAt }

// B1 (v1.5.10): peta code→tiket untuk callback idempotent. Kunci =
// hash SHA-256 dari code Google (code TIDAK PERNAH disimpan mentah);
// nilai menyimpan tiket + state query saat pertama lolos. Entri hidup
// selama TTL tiket (5 menit) — replay lintas-percobaan mustahil karena
// code berbeda tiap percobaan.
const codeTickets = new Map(); // sha256(code) -> { ticket, state, createdAt }

function pruneTickets() {
  const now = Date.now();
  for (const [ticket, t] of pendingTickets) {
    if (now - t.createdAt > TICKET_TTL_MS) pendingTickets.delete(ticket);
  }
  for (const [hash, e] of codeTickets) {
    if (now - e.createdAt > TICKET_TTL_MS) codeTickets.delete(hash);
  }
}

// Halaman transisi selama tukar kode (item 41, §4.3.4.3): langsung
// dikirim callback supaya pengguna tidak menatap halaman putih.
// Poll /status tiap 1,5 detik; sesudah 10 detik teks berubah menjadi
// "Masih mencoba…". Tanpa JS, meta refresh membawa ke /land (yang
// menunggu tukar kode selesai — halaman ini tetap tampil selama
// navigasi tertunda). Tiket heksadesimal sehingga aman disisipkan.
function interimPageHtml(ticket) {
  const statusUrl = `/api/auth/google/status?ticket=${ticket}`;
  const landUrl = `/api/auth/google/land?ticket=${ticket}`;
  return '<!doctype html>\n<html lang="id">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>Menghubungkan ke Google… — Mitsunime</title>\n'
    + `<noscript><meta http-equiv="refresh" content="0; url=${landUrl}"></noscript>\n`
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0c0f14;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}main{text-align:center;padding:24px;max-width:420px}.spin{width:44px;height:44px;margin:0 auto 20px;border:4px solid #1c2530;border-top-color:#d9ff4d;border-radius:50%;animation:putar 1s linear infinite}@keyframes putar{to{transform:rotate(360deg)}}h1{font-size:20px;margin:0 0 8px}p{color:#c9d1d9;font-size:14px;line-height:1.6;margin:0}.logo{color:#d9ff4d;font-weight:800;letter-spacing:2px;font-size:13px;margin-bottom:16px}</style>\n'
    + '</head>\n<body>\n<main>\n<div class="logo">MITSUNIME</div>\n<div class="spin" aria-hidden="true"></div>\n'
    + '<h1 id="judul">Menghubungkan ke Google…</h1>\n'
    + '<p id="sub">Mohon tunggu sebentar, kami sedang menyelesaikan proses masuk.</p>\n</main>\n<script>\n'
    + `(function(){var ticket=${JSON.stringify(ticket)};var land=${JSON.stringify(landUrl)};var done=false;`
    + 'setTimeout(function(){if(done)return;var j=document.getElementById("judul");var s=document.getElementById("sub");if(j)j.textContent="Masih mencoba menghubungi Google…";if(s)s.textContent="Koneksi sedang lambat, mohon tetap tunggu.";},10000);'
    + 'function poll(){fetch(' + JSON.stringify(statusUrl) + ',{headers:{Accept:"application/json"},cache:"no-store"}).then(function(r){return r.json();}).then(function(d){'
    + 'if(!d||!d.ok){done=true;location.replace("/account.html?mode=login&google_err=login");return;}'
    + 'if(d.status==="done"){done=true;location.replace(land);return;}'
    + 'if(d.status==="error"){done=true;location.replace("/account.html?mode=login&google_err="+encodeURIComponent(d.code||"login"));return;}'
    + 'setTimeout(poll,1500);}).catch(function(){setTimeout(poll,1500);});}'
    + 'setTimeout(poll,1500);})();\n</script>\n</body>\n</html>\n';
}

// Tukar kode + ambil profil + siapkan akun, di latar belakang.
// Mengisi outcome (status 'done' + userId, atau 'error' + errorCode).
// Pemetaan pesan → kode sama seperti callback lama (v1.5.7).
async function runGoogleExchange(outcome, ip, code) {
  try {
    const accessToken = await google.exchangeCode(code);
    const profile = await google.fetchUserInfo(accessToken);
    if (!profile.email_verified) {
      logger.warn('Login Google: email_verified Google bukan true — ditolak');
      throw Object.assign(new Error('Login Google gagal. Coba lagi.'), { errorCode: 'login' });
    }
    let result;
    try {
      result = google.findOrCreateGoogleUser(profile);
    } catch (e) {
      if (e && e.message === 'ADMIN_GOOGLE') {
        throw Object.assign(new Error('Akun ini tidak bisa masuk lewat Google.'), { errorCode: 'admin' });
      }
      logger.error(`Login Google: gagal menyiapkan akun (${e && e.message ? e.message : e})`);
      throw Object.assign(new Error('Login Google gagal. Coba lagi.'), { errorCode: 'login' });
    }
    outcome.userId = result.user.id;
    outcome.status = 'done';
    mw.recordLoginOk(ip);
  } catch (e) {
    mw.recordLoginFail(ip);
    outcome.status = 'error';
    if (e && e.errorCode) {
      outcome.errorCode = e.errorCode;
    } else if (e && e.message === 'Kode login Google tidak berlaku.') {
      outcome.errorCode = 'code';
    } else if (e && e.message === 'Gagal menghubungi Google.') {
      outcome.errorCode = 'network';
    } else if (e && e.message === 'Profil Google tidak lengkap.') {
      // userinfo non-ok / profil tak lengkap = sisi Google gagal
      // memberi profil yang bisa dipakai → pesan 'network'.
      outcome.errorCode = 'network';
      logger.warn('Login Google: profil Google tidak lengkap');
    } else {
      outcome.errorCode = 'login';
    }
    if (outcome.errorCode !== 'login' && outcome.errorCode !== 'admin') {
      logger.warn(`Login Google: tukar kode gagal (${outcome.errorCode})`);
    }
  }
}

// GET /api/auth/google/callback — kembali dari Google.
async function handleGoogleCallback(req, res, url) {
  const ip = mw.clientIp(req);
  // State SEKALI PAKAI: cookie dihapus sesudah dipakai, cocok atau
  // tidak — penghapus dipasang di SEMUA balasan callback di bawah.
  const cookies = mw.parseCookies(req);
  const cookieState = typeof cookies[STATE_COOKIE] === 'string' ? cookies[STATE_COOKIE] : '';
  const queryState = url.searchParams.get('state') || '';
  const queryError = url.searchParams.get('error') || '';
  const code = url.searchParams.get('code') || '';

  // PRD §4.7.3 butir 9: callback memakai pembatas yang sama seperti
  // login (10 gagal per IP per 15 menit → 429).
  if (mw.loginBlocked(ip)) {
    appendSetCookie(res, clearStateCookieValue());
    return redirectOrJson(req, res, 429, 'rate');
  }
  // Gagal sebelum tukar kode: catat gagal-login, hapus cookie state,
  // lalu JSON bila diminta, redirect ke halaman login bila navigasi.
  const fail = (status, code) => {
    mw.recordLoginFail(ip);
    appendSetCookie(res, clearStateCookieValue());
    return redirectOrJson(req, res, status, code);
  };

  if (queryError) {
    logger.warn(`Login Google: Google mengembalikan error (${queryError})`);
    return fail(401, 'login');
  }
  // B1 (v1.5.10): callback idempotent. Bila code+state yang sama
  // sudah pernah lolos (pemuatan kedua dari race Chrome/PWA — cookie
  // state sudah dihapus pemuatan pertama sehingga cek state di bawah
  // pasti gagal), kembalikan halaman transisi yang SAMA (tiket yang
  // sama). Tukar kode TIDAK diulang; tidak dicatat sebagai gagal login.
  // State dicocokkan dari QUERY (sama di kedua pemuatan), bukan dari
  // cookie. Code beda / state beda → jatuh ke cek normal di bawah.
  if (code && queryState) {
    pruneTickets();
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const seen = codeTickets.get(codeHash);
    if (seen && seen.state === queryState) {
      const prior = pendingTickets.get(seen.ticket);
      if (prior) {
        appendSetCookie(res, clearStateCookieValue());
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(interimPageHtml(seen.ticket));
        return true;
      }
      codeTickets.delete(codeHash);
    }
  }
  // Bandingkan state dengan timingSafeEqual (panjang harus sama dulu).
  let stateOk = false;
  if (cookieState && queryState && cookieState.length === queryState.length) {
    try {
      stateOk = crypto.timingSafeEqual(Buffer.from(cookieState), Buffer.from(queryState));
    } catch { stateOk = false; }
  }
  if (!stateOk) {
    return fail(401, 'login');
  }
  if (!code) {
    return fail(401, 'login');
  }
  // State + kode valid: buat tiket, jalankan tukar kode di latar
  // belakang, langsung kirim halaman transisi (bukan menunggu diam).
  pruneTickets();
  const ticket = crypto.randomBytes(32).toString('hex');
  const outcome = { status: 'pending', userId: null, errorCode: null, createdAt: Date.now(), promise: null };
  pendingTickets.set(ticket, outcome);
  // B1: catat code→tiket supaya callback kedua dengan code+state yang
  // sama mengembalikan halaman transisi yang sama (bukan gagal 401).
  codeTickets.set(
    crypto.createHash('sha256').update(code).digest('hex'),
    { ticket, state: queryState, createdAt: Date.now() },
  );
  outcome.promise = runGoogleExchange(outcome, ip, code);
  appendSetCookie(res, clearStateCookieValue());
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(interimPageHtml(ticket));
  return true;
}

// GET /api/auth/google/status?ticket=… — poll halaman transisi.
// Selalu JSON (hanya dipanggil fetch): pending / done / error (+kode).
// Tiket tidak dikenal → 404.
function handleGoogleStatus(req, res, url) {
  const ticket = url.searchParams.get('ticket') || '';
  const outcome = pendingTickets.get(ticket);
  if (!outcome) return err(res, 404, 'Tiket tidak ditemukan.');
  if (outcome.status === 'done') return send(res, 200, { ok: true, status: 'done' });
  if (outcome.status === 'error') {
    return send(res, 200, { ok: true, status: 'error', code: outcome.errorCode || 'login' });
  }
  return send(res, 200, { ok: true, status: 'pending' });
}

// GET /api/auth/google/land?ticket=… — pendaratan: tunggu tukar kode,
// pasang cookie sesi, 302 ke /account.html. Tiket 'done' BOLEH dipakai
// dua kali (B1: race dua konteks) — disimpan sampai TTL 5 menit, baru
// dihapus pruneTickets(). Tiket gagal/pending yang berakhir error
// dibuang supaya tidak bisa dipakai ulang. Selalu redirect (endpoint
// navigasi).
async function handleGoogleLand(req, res, url) {
  pruneTickets();
  const ticket = url.searchParams.get('ticket') || '';
  const outcome = pendingTickets.get(ticket);
  const goLogin = (code) => {
    res.writeHead(302, {
      Location: `/account.html?mode=login&google_err=${encodeURIComponent(code)}`,
      'Cache-Control': 'no-store',
    });
    res.end();
    return true;
  };
  if (!outcome) return goLogin('login');
  if (outcome.status === 'pending' && outcome.promise) {
    try { await outcome.promise; } catch { /* status outcome yang bicara */ }
  }
  if (outcome.status !== 'done' || !outcome.userId) {
    pendingTickets.delete(ticket);
    return goLogin(outcome.errorCode || 'login');
  }
  // B1: 'done' — JANGAN hapus tiket di sini; pendaratan kedua untuk
  // tiket yang sama membuat sesi sendiri untuk pengguna yang sama.
  auth.pruneExpiredSessions();
  const token = auth.createSession(outcome.userId);
  auth.setSessionCookie(res, token);
  auth.touchLastLogin(outcome.userId);
  res.writeHead(302, { Location: '/account.html', 'Cache-Control': 'no-store' });
  res.end();
  return true;
}

// Router /api/auth/google* — dipanggil server.js. Mengembalikan true
// bila dikenali.
function route(req, res, url) {
  const path = url.pathname;
  if (path === '/api/auth/google/config' && req.method === 'GET') return handleGoogleConfig(req, res);
  if (path === '/api/auth/google' && req.method === 'GET') return handleGoogleStart(req, res);
  if (path === '/api/auth/google/callback' && req.method === 'GET') return handleGoogleCallback(req, res, url);
  if (path === '/api/auth/google/status' && req.method === 'GET') return handleGoogleStatus(req, res, url);
  if (path === '/api/auth/google/land' && req.method === 'GET') return handleGoogleLand(req, res, url);
  return false;
}

module.exports = { route, send, err, GOOGLE_ERR_MESSAGES };
