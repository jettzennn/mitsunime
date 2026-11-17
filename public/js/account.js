/* ============================================================
   account.js — Halaman akun Mitsunime (task-12)
   Bila belum login: form masuk/daftar. Bila sudah login: PROFIL
   WEB saja (avatar + pensil, nama, level, premium), Daftar Saya,
   Riwayat Tontonan (klik kartu -> daftar episode yang ditonton).
   Urusan akun tidak ada di halaman ini — akun diurus dari
   container akun di kaki sidebar.
   Aksesori TIDAK lagi tampil di halaman profil — semuanya pindah
   ke panel pensil (Ubah Profil), per jenis masing-masing.
   F-05: Pakai/Lepas aksesori hanya memperbarui baris yang diklik,
   tanpa render ulang profil/aksesori dan tanpa skeleton.
   F-04: pill lencana hanya satu label (aturan ::after dihapus).
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  mountChrome('home');
  var params = new URLSearchParams(window.location.search);
  var mode = params.get('mode');
  if (mode === 'verify') {
    /* Tautan dari login yang ditolak karena belum terverifikasi. */
    startInVerify = true;
    verifyEmail = params.get('email') || '';
    initAuth('login');
  } else if (mode === 'reset') {
    /* Tautan dari email reset password: email + kode dibaca dari
       URL, lalu URL langsung dibersihkan supaya kode tidak
       tertinggal di address bar / riwayat browser. User tidak
       pernah mengetik kode — panelnya hanya berisi password baru. */
    startInResetLink = true;
    resetLinkEmail = params.get('email') || '';
    resetLinkCode = params.get('code') || '';
    window.history.replaceState(null, '', '/account.html');
    initAuth('login');
  } else {
    initAuth(mode === 'register' ? 'register' : 'login');
  }
  document.getElementById('form-verify').addEventListener('submit', function (e) {
    e.preventDefault();
    submitVerify();
  });
  initOtpBoxes();
  document.getElementById('btn-resend-code').addEventListener('click', function () { resendVerifyCode(); });
  /* Ganti email (v1.3.1) + tambah email (v1.3.1, akun tanpa email). */
  document.getElementById('btn-change-email').addEventListener('click', function () { showChangeEmailForm(); });
  document.getElementById('form-change-email').addEventListener('submit', function (e) {
    e.preventDefault();
    submitChangeEmail();
  });
  document.getElementById('btn-change-email-cancel').addEventListener('click', function () { hideChangeEmailForm(); });
  document.getElementById('form-add-email').addEventListener('submit', function (e) {
    e.preventDefault();
    submitAddEmail();
  });
  /* Lupa password: tautan di form masuk -> form email (satu tahap);
     panel password baru hanya muncul dari tautan email reset. */
  document.getElementById('btn-forgot-password').addEventListener('click', function () { showForgotScreen(); });
  document.getElementById('form-forgot').addEventListener('submit', function (e) {
    e.preventDefault();
    submitForgot();
  });
  document.getElementById('form-reset-link').addEventListener('submit', function (e) {
    e.preventDefault();
    submitResetLink();
  });
  document.getElementById('btn-reset-link-forgot').addEventListener('click', function () { showForgotScreen(); });
  loadAccount();
});

/* ---------- Penjaga tombol Back / bfcache (v1.3.3) ----------
   Setelah sesi diakhiri dari sidebar (location.replace), halaman
   profil tidak ada di riwayat — tapi halaman profil yang masih
   terbuka di tab lain / dipulihkan dari bfcache bisa saja tampil
   lagi dengan DOM lama berisi profil. Bila halaman dipulihkan
   dari bfcache (pageshow persisted) atau riwayat bergerak
   (popstate), sesi diperiksa ULANG secara segar ke /api/me
   (apiFetch memakai cache 'no-store' + cache sesi lokal dibuang
   dulu). Bila sesi sudah tidak ada, tampilan profil langsung
   disembunyikan dan diganti form masuk. */
async function revalidateSessionFresh() {
  var accRoot = document.getElementById('account-root');
  if (!accRoot || accRoot.hidden) return;
  var me = null;
  try {
    clearMeCache();
    me = await apiMe();
  } catch (err) {
    me = null;
  }
  if (me && me.user) {
    currentMe = me;
    return;
  }
  accRoot.hidden = true;
  var authRoot = document.getElementById('auth-root');
  if (authRoot) authRoot.hidden = false;
  currentMe = null;
  window.location.replace('/account.html?mode=login');
}
window.addEventListener('pageshow', function (e) {
  if (e.persisted) revalidateSessionFresh();
});
window.addEventListener('popstate', function () {
  revalidateSessionFresh();
});

var ACC_KIND_LABEL = {
  border: 'Border',
  background: 'Background',
  frame: 'Bingkai Avatar',
  badge: 'Lencana',
  name_effect: 'Efek Nama',
};

/* Profil yang sedang tampil (dari /api/me) — dipakai panel pensil
   supaya tidak perlu memuat ulang halaman setelah ubah
   profil/pakai aksesori. */
var currentMe = null;

/* Avatar preset (v1.3.2, sama seperti server/services/avatars.js):
   lingkaran huruf awal username dengan warna latar + huruf + ring.
   avatar null = avatar huruf default (latar gelap + huruf lime). */
var AVATAR_PRESETS = [
  { code: 'lime', name: 'Lime', bg: '#c7f632', fg: '#0c0f14', ring: '#84cc16' },
  { code: 'emas', name: 'Emas', bg: '#f5c542', fg: '#1a1405', ring: '#d97706' },
  { code: 'zamrud', name: 'Zamrud', bg: '#10b981', fg: '#06281c', ring: '#059669' },
  { code: 'merah', name: 'Merah', bg: '#ef4444', fg: '#2b0606', ring: '#dc2626' },
  { code: 'perak', name: 'Perak', bg: '#e5e7eb', fg: '#111827', ring: '#9ca3af' },
  { code: 'langit', name: 'Langit', bg: '#38bdf8', fg: '#082f49', ring: '#0284c7' },
  { code: 'ungu', name: 'Ungu', bg: '#a78bfa', fg: '#1e1033', ring: '#7c3aed' },
  { code: 'jingga', name: 'Jingga', bg: '#fb923c', fg: '#2b1003', ring: '#ea580c' },
];
function avatarPreset(code) {
  for (var i = 0; i < AVATAR_PRESETS.length; i++) {
    if (AVATAR_PRESETS[i].code === code) return AVATAR_PRESETS[i];
  }
  return null;
}
function avatarStyle(user) {
  if (!user || !user.avatar) return '';
  var p = avatarPreset(user.avatar);
  if (!p) return '';
  return 'background:' + p.bg + ';color:' + p.fg + ';border-color:' + p.ring;
}
/* Terapkan avatar preset ke avatar di kartu profil (+ avatar kecil di
   header situs bila ada) — hanya mengubah node itu, tanpa render ulang. */
function applyAvatarToHeader(user) {
  var letter = (user.username || '?').charAt(0).toUpperCase();
  var style = avatarStyle(user);
  var av = document.getElementById('profile-avatar');
  if (av) {
    av.style.cssText = style;
    av.textContent = letter;
  }
  var headerAv = document.querySelector('.header-avatar');
  if (headerAv) {
    headerAv.style.cssText = style;
    headerAv.textContent = letter;
  }
}

/* ---------- Cooldown kirim ulang kode (anti-spam) ----------
   Verifikasi (v1.4.1, "sat-set"): begitu diklik, tombol LANGSUNG
   abu-abu + countdown 10 detik, tanpa menunggu balasan server.
   Lupa password: tetap 60 detik. Countdown tampil pada teksnya
   ("Kirim ulang kode (9)") dengan gaya abu-abu redup — mencegah
   email ter-spam klik berulang. Server menegakkan jedanya sendiri
   per email (verify/request membalas 429 + retry_after bila masih
   dalam jeda server; password/forgot menahan diam-diam); bila
   server menolak, countdown di sini mengikuti retry_after server.
   Gaya disabled memakai style inline karena file CSS di luar
   cakupan perubahan ini. Timer dibersihkan setiap user pindah layar
   (renderAuthForm, showAddEmailScreen, showForgotScreen, profil
   tampil) supaya tidak ada countdown yatim yang menimpa tombol di
   layar lain. */
var resendCooldowns = {};

function resetResendButton(btn) {
  if (!btn) return;
  var rec = resendCooldowns[btn.id];
  if (rec) {
    clearInterval(rec.timer);
    delete resendCooldowns[btn.id];
    btn.textContent = rec.label;
  }
  btn.disabled = false;
  btn.style.opacity = '';
  btn.style.color = '';
  btn.style.cursor = '';
}

function startResendCooldown(btn, seconds, label) {
  if (!btn) return;
  resetResendButton(btn);
  var left = Math.max(1, Math.floor(Number(seconds) || 60));
  btn.disabled = true;
  btn.style.opacity = '0.45';
  btn.style.color = '#8a94a3';
  btn.style.cursor = 'not-allowed';
  btn.textContent = label + ' (' + left + ')';
  var timer = setInterval(function () {
    left -= 1;
    if (left <= 0) {
      resetResendButton(btn);
      return;
    }
    btn.textContent = label + ' (' + left + ')';
  }, 1000);
  resendCooldowns[btn.id] = { timer: timer, label: label };
}

function stopAllResendCooldowns() {
  ['btn-resend-code', 'btn-forgot'].forEach(function (id) {
    resetResendButton(document.getElementById(id));
  });
}

/* ---------- Masuk / daftar ---------- */
var authMode = 'login';
/* Verifikasi email OTP (v1.3.0): alamat email akun yang sedang
   diverifikasi + apakah halaman dibuka langsung dalam mode verifikasi. */
var verifyEmail = '';
var startInVerify = false;
/* Lupa password berbasis tautan email: email + kode reset dibaca
   dari URL email (?mode=reset&email&code) saat halaman dibuka, lalu
   URL dibersihkan — user tidak pernah mengetik kode di web. */
var resetLinkEmail = '';
var resetLinkCode = '';
var startInResetLink = false;

function initAuth(mode) {
  authMode = mode;
  renderAuthForm();
  document.getElementById('form-login').addEventListener('submit', function (e) {
    e.preventDefault();
    submitAuth();
  });
}

function renderAuthForm() {
  stopAllResendCooldowns();
  var isLogin = authMode === 'login';
  document.getElementById('auth-title').textContent = isLogin ? 'Masuk' : 'Daftar';
  document.getElementById('btn-auth').textContent = isLogin ? 'Masuk' : 'Daftar';
  document.getElementById('field-email').hidden = isLogin;
  /* v1.4.0: mode masuk memakai EMAIL sebagai pengenal (keputusan
     pengguna — login bukan lagi username). Kolom pertama berganti
     label/jenis menjadi Email; mode daftar tetap Username + Email. */
  var idInput = document.getElementById('login-username');
  var idLabel = document.getElementById('login-identifier-label');
  if (idLabel && idInput) {
    idLabel.textContent = isLogin ? 'Email' : 'Username';
    idInput.type = isLogin ? 'email' : 'text';
    idInput.placeholder = isLogin ? 'nama@email.com' : 'Username';
    idInput.setAttribute('autocomplete', isLogin ? 'email' : 'username');
  }
  document.getElementById('login-password').setAttribute('autocomplete', isLogin ? 'current-password' : 'new-password');
  document.getElementById('auth-switch').innerHTML = isLogin
    ? 'Belum punya akun? <a href="/account.html?mode=register">Daftar di sini</a>'
    : 'Sudah punya akun? <a href="/account.html?mode=login">Masuk di sini</a>';
  document.getElementById('auth-error').textContent = '';
  document.getElementById('auth-success').textContent = '';
  /* Tautan "Lupa password?" hanya relevan di mode masuk. */
  document.getElementById('forgot-row').hidden = !isLogin;
  /* Kembali ke form masuk/daftar: panel verifikasi + tambah email
     + lupa password disembunyikan. */
  document.getElementById('login-panel').hidden = false;
  document.getElementById('verify-root').hidden = true;
  document.getElementById('add-email-root').hidden = true;
  document.getElementById('reset-root').hidden = true;
  document.getElementById('reset-link-root').hidden = true;
  hideChangeEmailForm();
}

function switchAuthMode(mode) {
  authMode = mode;
  var url = '/account.html?mode=' + mode;
  window.history.replaceState(null, '', url);
  renderAuthForm();
}

async function submitAuth() {
  var errEl = document.getElementById('auth-error');
  errEl.textContent = '';
  var username = document.getElementById('login-username').value.trim();
  var password = document.getElementById('login-password').value;
  var email = document.getElementById('login-email').value.trim();
  if (!username || !password) {
    errEl.textContent = authMode === 'login'
      ? 'Isi email dan password terlebih dahulu.'
      : 'Isi username dan password terlebih dahulu.';
    return;
  }
  var btn = document.getElementById('btn-auth');
  btn.disabled = true;
  try {
    if (authMode === 'login') {
      await apiLogin(username, password);
    } else {
      var out = await apiRegister(username, password, email);
      /* v1.3.0: bila SMTP terkonfigurasi, register tidak membuat sesi
         — akun harus memasukkan kode OTP dulu. Bila SMTP tidak
         diatur, respons tidak membawa verification_required dan alur
         lanjut seperti v1.2.0 (langsung masuk). */
      if (out && out.verification_required === true) {
        showVerifyScreen(email, (out && out.message) || '');
        return;
      }
    }
    clearMeCache();
    showToast(authMode === 'login' ? 'Selamat datang kembali!' : 'Akun berhasil dibuat. Selamat datang!');
    await loadAccount(true);
  } catch (err) {
    /* v1.3.1: login ditolak 403 karena akun belum punya email (SMTP
       aktif) — tampilkan form tambah email, bukan galat masuk biasa. */
    if (err && err.data && err.data.code === 'email_required') {
      showAddEmailScreen((err.data && err.data.username) || username, (err && err.message) || '');
      return;
    }
    /* v1.3.0: login ditolak 403 karena akun belum terverifikasi —
       tampilkan layar verifikasi dengan pesan server, bukan galat
       masuk biasa. */
    if (err && err.data && err.data.verification_required === true) {
      /* F-04: tandai asal 'login' — deskripsi layar verifikasi
         menyebut kode dari saat mendaftar, bukan pengiriman baru. */
      showVerifyScreen((err.data && err.data.email) || email, (err && err.message) || '', true, 'login');
      return;
    }
    /* v1.3.3: daftar ditolak 409 karena username/email sudah terdaftar
       tapi akunnya BELUM terverifikasi — kemungkinan besar akun milik
       user sendiri yang keluar sebelum sempat memasukkan OTP. */
    if (err && err.data && (err.data.code === 'username_unverified' || err.data.code === 'email_unverified')) {
      /* v1.4.3 (H-01): pisah kedua kode — server mengirim kode baru ke
         email TERSIMPAN, bukan ke email yang diketik. Untuk
         username_unverified, email yang diketik bisa jadi BUKAN email
         akun, jadi layar verifikasi dibuka dengan email KOSONG supaya
         kolom email tampil dan pengguna memasukkan email akunnya;
         konfirmasi + kirim ulang lalu memakai email itu (lewat
         verifyScreenEmail). Untuk email_unverified, email yang diketik
         == email akun, jadi tetap ditampilkan. Alamat tersimpan tidak
         pernah dimuat dari mana pun. */
      var sent409 = err.data.verification_email_sent;
      var note409;
      if (sent409 === false) {
        note409 = 'Kode verifikasi belum terkirim. Tekan "Kirim ulang kode" di bawah untuk meminta kode baru.';
      } else if (err.data.code === 'username_unverified') {
        note409 = 'Kode verifikasi baru sudah dikirim ke email akun kamu.';
      } else {
        /* v1.4.0: catatan dibuat singkat sesuai permintaan pengguna
           (gaya web umumnya), tampil di bawah kotak kode. */
        note409 = 'Akun sudah dibuat — cek kode verifikasi di email kamu, atau kirim ulang kode.';
      }
      if (err.data.code === 'username_unverified') {
        showVerifyScreen('', note409, sent409 !== false);
      } else {
        showVerifyScreen(email, note409, sent409 !== false);
      }
      return;
    }
    errEl.textContent = (err && err.message) || 'Gagal. Coba lagi.';
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Kotak kode 6 digit (v1.4.0) ----------
   Enam kotak satu digit menggantikan satu kolom panjang (permintaan
   pengguna): mengetik berpindah otomatis ke kotak berikutnya,
   Backspace di kotak kosong mundur sambil menghapus, menempel
   (paste) atau autofill 6 digit tersebar ke semua kotak. */
function otpBoxes() {
  return Array.prototype.slice.call(document.querySelectorAll('#otp-boxes .otp-box'));
}
function getOtpCode() {
  return otpBoxes().map(function (b) { return b.value; }).join('').trim();
}
function clearOtpBoxes() {
  otpBoxes().forEach(function (b) { b.value = ''; });
}
/* Ekstraksi kode dari teks tempelan (v1.4.2): cari RANGKAIAN 6 digit
   pertama — bukan 6 digit pertama dari semua angka. Blok email
   mengandung "6 digit" dan "© 2026" yang akan mengacaukan bila
   semua angka digabung ("684506..." dari "6"+"845061"+"1"+"2026").
   Digit ber-spasi ("8 4 5 0 6 1") digabung dulu baru dicari. */
function extractOtpCode(text) {
  var t = String(text || '');
  var m = t.match(/\d{6}/);
  if (m) return m[0];
  var joined = t.replace(/(\d)[\s\-]+(?=\d)/g, '$1');
  m = joined.match(/\d{6}/);
  if (m) return m[0];
  return joined.replace(/\D/g, '').slice(0, 6);
}
function setOtpCode(digits) {
  var boxes = otpBoxes();
  var clean = extractOtpCode(digits);
  boxes.forEach(function (b, i) { b.value = clean[i] || ''; });
  var next = boxes[Math.min(clean.length, boxes.length - 1)];
  if (next) next.focus();
}
function initOtpBoxes() {
  var boxes = otpBoxes();
  boxes.forEach(function (box, i) {
    box.addEventListener('input', function () {
      /* v1.4.2: tempelan Gboard masuk lewat event input (bukan paste)
         dan membawa teks utuh — JANGAN buang non-digit dulu:
         rangkaian 6 digit harus dicari di teks aslinya (label
         "6 digit" + "2026" di blok email akan mengacaukan bila
         semua angka digabung). maxlength sudah dihapus dari HTML
         supaya browser tidak memotong sisipan jadi 1 karakter. */
      var raw = box.value;
      var clean = extractOtpCode(raw);
      if (clean.length > 1) {
        /* v1.4.2 (L-09): bila yang masuk adalah KODE LENGKAP (6 digit),
           ganti semua kotak — JANGAN gabung dengan digit sebelumnya
           ("38" + tempel "845061" jadi "388450" yang salah). Gabung
           dengan digit sebelumnya hanya untuk potongan parsial
           (< 6 digit), mis. tempel "45" sesudah "38" -> "3845". */
        if (clean.length >= 6) { setOtpCode(raw); return; }
        var before = boxes.slice(0, i).map(function (b) { return b.value; }).join('');
        setOtpCode(before + raw);
        return;
      }
      box.value = clean;
      if (clean && i < boxes.length - 1) boxes[i + 1].focus();
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !box.value && i > 0) {
        boxes[i - 1].value = '';
        boxes[i - 1].focus();
        e.preventDefault();
      } else if (e.key === 'ArrowLeft' && i > 0) {
        boxes[i - 1].focus();
      } else if (e.key === 'ArrowRight' && i < boxes.length - 1) {
        boxes[i + 1].focus();
      }
    });
    box.addEventListener('paste', function (e) {
      var text = (e.clipboardData || window.clipboardData).getData('text') || '';
      if (text) { setOtpCode(text); e.preventDefault(); }
    });
    box.addEventListener('focus', function () { box.select(); });
  });
}

/* ---------- Verifikasi email OTP (v1.3.0) ----------
   Param ketiga codeSent (opsional, default true): bila false, kode
   belum terkirim ke email itu — deskripsi dan pesan jujur soal itu
   (dipakai F-09 saat ganti email terverifikasi tapi SMTP gagal).
   Param keempat origin (F-04): 'login' bila layar ini datang dari
   MASUK yang ditolak — login tidak mengirim email baru, yang
   berlaku kode lama dari pendaftaran, jadi deskripsinya dibedakan
   dari jalur daftar/kirim ulang yang memang baru mengirim kode. */
function showVerifyScreen(email, note, codeSent, origin) {
  verifyEmail = (email || '').trim();
  document.getElementById('auth-root').hidden = false;
  document.getElementById('account-root').hidden = true;
  document.getElementById('login-panel').hidden = true;
  document.getElementById('verify-root').hidden = false;
  document.getElementById('add-email-root').hidden = true;
  document.getElementById('reset-root').hidden = true;
  document.getElementById('reset-link-root').hidden = true;
  hideChangeEmailForm();
  document.getElementById('verify-error').textContent = '';
  document.getElementById('verify-success').textContent = '';
  if (codeSent === false) {
    /* Pesan gagal kirim masuk ke elemen galat, bukan elemen sukses. */
    document.getElementById('verify-error').textContent = note || 'Kode verifikasi belum terkirim. Tekan "Kirim ulang kode" di bawah untuk meminta kode baru.';
  } else {
    document.getElementById('verify-success').textContent = note || '';
  }
  var emailField = document.getElementById('field-verify-email');
  var desc = document.getElementById('verify-desc');
  if (verifyEmail) {
    emailField.hidden = true;
    if (codeSent === false) {
      desc.textContent = 'Kode verifikasi belum terkirim ke ' + verifyEmail + '. Tekan "Kirim ulang kode" di bawah untuk meminta kode baru.';
    } else if (origin === 'login') {
      /* F-04: dari jalur masuk TIDAK ada pengiriman baru — jangan
         mengklaim kode "sudah dikirim" seolah barusan. */
      desc.textContent = 'Masukkan kode verifikasi yang dikirim saat kamu mendaftar. Kode berlaku 1 menit sejak dikirim.';
    } else {
      desc.textContent = 'Kode verifikasi 6 digit sudah dikirim ke ' + verifyEmail + '. Kode berlaku 1 menit.';
    }
  } else {
    emailField.hidden = false;
    desc.textContent = 'Masukkan email akun kamu, lalu kode verifikasi 6 digit yang dikirim ke email itu.';
  }
  clearOtpBoxes();
  var firstOtpBox = document.querySelector('#otp-boxes .otp-box');
  if (firstOtpBox) firstOtpBox.focus();
  /* Cooldown kirim ulang (v1.4.1): kode barusan dikirim
     (daftar/masuk/ganti email) -> tombol dimatikan 10 detik dengan
     countdown. Bila kode GAGAL terkirim (codeSent === false),
     tombol justru harus bisa langsung dipakai — itu jalur
     pemulihannya (F-09). */
  var resendBtn = document.getElementById('btn-resend-code');
  if (codeSent === false) {
    resetResendButton(resendBtn);
  } else {
    startResendCooldown(resendBtn, 10, 'Kirim ulang kode');
  }
}

function verifyScreenEmail() {
  var email = verifyEmail;
  if (!email) {
    email = document.getElementById('verify-email-input').value.trim();
    if (!email) {
      document.getElementById('verify-error').textContent = 'Isi email akun kamu dulu.';
      return '';
    }
    verifyEmail = email;
  }
  return email;
}

async function submitVerify() {
  var errEl = document.getElementById('verify-error');
  var okEl = document.getElementById('verify-success');
  errEl.textContent = '';
  okEl.textContent = '';
  var email = verifyScreenEmail();
  if (!email) return;
  var code = getOtpCode();
  if (!/^\d{6}$/.test(code)) { errEl.textContent = 'Kode verifikasi harus 6 digit angka.'; return; }
  var btn = document.getElementById('btn-verify');
  btn.disabled = true;
  try {
    await apiVerifyConfirm(email, code);
    clearMeCache();
    /* v1.4.5: habis verifikasi, langsung masuk HANYA bila sesi sudah
       ada (cabang pertahanan — dalam praktik sesi hampir selalu sudah
       tidak ada: ganti email mencabut semua sesi saat diminta (S-02).
       Bila tidak ada sesi (daftar baru, tambah email, ganti email,
       login akun belum terverifikasi), lempar ke halaman login dengan
       kolom pengenal sudah terisi email terverifikasi — pengguna
       tinggal memasukkan password. */
    var me = await currentUser();
    if (me) {
      showToast('Email terverifikasi. Selamat datang!');
      await loadAccount(true);
    } else {
      switchAuthMode('login');
      var idInput = document.getElementById('login-username');
      if (idInput) idInput.value = email;
      var pwInput = document.getElementById('login-password');
      if (pwInput) { pwInput.value = ''; pwInput.focus(); }
      showToast('Email terverifikasi. Silakan masuk.');
    }
  } catch (err) {
    /* F-02: pesan server sudah memuat "Sisa percobaan: N." —
       tampilkan apa adanya, jangan ditambah lagi di sini (dulu
       frasanya tampil dua kali). */
    errEl.textContent = (err && err.message) || 'Kode salah. Coba lagi.';
  } finally {
    btn.disabled = false;
  }
}

async function resendVerifyCode() {
  var errEl = document.getElementById('verify-error');
  var okEl = document.getElementById('verify-success');
  errEl.textContent = '';
  okEl.textContent = '';
  var email = verifyScreenEmail();
  if (!email) return;
  var btn = document.getElementById('btn-resend-code');
  /* v1.4.1 "sat-set": tombol LANGSUNG abu-abu + countdown 10 detik
     begitu diklik — tanpa menunggu balasan server. */
  startResendCooldown(btn, 10, 'Kirim ulang kode');
  try {
    var out = await apiVerifyRequest(email);
    okEl.textContent = (out && out.message) || 'Kode verifikasi baru sudah dikirim ke email kamu.';
  } catch (err) {
    /* 429 cooldown dari server: tampilkan pesannya dan jalankan
       countdown sesuai retry_after yang diberikan server. Galat
       lain: tombol dihidupkan lagi + pesan galat ditampilkan. */
    errEl.textContent = (err && err.message) || 'Gagal mengirim ulang kode.';
    if (err && err.data && err.data.code === 'cooldown' && err.data.retry_after > 0) {
      startResendCooldown(btn, err.data.retry_after, 'Kirim ulang kode');
    } else {
      resetResendButton(btn);
    }
  } finally {
    /* Bila cooldown berjalan, tombol memang harus tetap mati —
       jangan dihidupkan lagi oleh finally. */
    if (!resendCooldowns[btn.id]) btn.disabled = false;
  }
}

/* ---------- Ganti email (v1.3.1) ----------
   Hanya kolom email BARU (kosong) + password akun yang ditampilkan —
   username sudah tersimpan di akun. Password WAJIB: tanpa itu server
   menjawab 401. Sukses → layar verifikasi diperbarui ke email baru
   (OTP lama hangus, kode baru dikirim ke email baru). */
function showChangeEmailForm() {
  var email = verifyScreenEmail();
  if (!email) return;
  var verifyForm = document.getElementById('form-verify');
  if (verifyForm) verifyForm.hidden = true;
  ['btn-resend-code', 'btn-change-email', 'verify-back'].forEach(function (id) {
    var el = document.getElementById(id);
    var wrap = el && el.closest ? el.closest('p') : null;
    if (wrap) wrap.hidden = true;
  });
  document.getElementById('form-change-email').hidden = false;
  document.getElementById('change-email-error').textContent = '';
  document.getElementById('change-email-success').textContent = '';
  document.getElementById('change-email-new').value = '';
  document.getElementById('change-email-password').value = '';
  document.getElementById('change-email-new').focus();
}

function hideChangeEmailForm() {
  var form = document.getElementById('form-change-email');
  if (!form) return;
  form.hidden = true;
  /* Dijaga null: elemen-elemen ini milik layar verifikasi; bila
     suatu saat tidak ada di DOM, fungsi ini tidak boleh melempar. */
  var verifyForm = document.getElementById('form-verify');
  if (verifyForm) verifyForm.hidden = false;
  ['btn-resend-code', 'btn-change-email', 'verify-back'].forEach(function (id) {
    var el = document.getElementById(id);
    var wrap = el && el.closest ? el.closest('p') : null;
    if (wrap) wrap.hidden = false;
  });
}

async function submitChangeEmail() {
  var errEl = document.getElementById('change-email-error');
  var okEl = document.getElementById('change-email-success');
  errEl.textContent = '';
  okEl.textContent = '';
  var email = verifyScreenEmail();
  if (!email) { hideChangeEmailForm(); return; }
  var newEmail = document.getElementById('change-email-new').value.trim();
  var password = document.getElementById('change-email-password').value;
  if (!newEmail) { errEl.textContent = 'Isi email baru kamu dulu.'; return; }
  if (!password) { errEl.textContent = 'Isi password akun kamu.'; return; }
  var btn = document.getElementById('btn-change-email-submit');
  btn.disabled = true;
  try {
    var out = await apiChangeEmail({ email: email, new_email: newEmail, password: password });
    /* F-09b: teruskan email_sent — bila false (OTP gagal terkirim),
       layar verifikasi tampil dengan catatan jujur "belum terkirim",
       bukan klaim "sudah dikirim". */
    showVerifyScreen(newEmail, (out && out.message) || '', out && out.email_sent !== false);
  } catch (err) {
    errEl.textContent = (err && err.message) || 'Gagal mengganti email.';
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Tambah email (v1.3.1, N2) ----------
   Tampil bila login ditolak 403 code 'email_required' (akun tanpa
   email, SMTP aktif). Memanggil endpoint yang sama dengan ganti
   email, memakai username dari respons 403 — sukses lanjut ke
   layar verifikasi dengan email baru. */
var addEmailUsername = '';

function showAddEmailScreen(username, note) {
  stopAllResendCooldowns();
  addEmailUsername = username || '';
  document.getElementById('auth-root').hidden = false;
  document.getElementById('account-root').hidden = true;
  document.getElementById('login-panel').hidden = true;
  document.getElementById('verify-root').hidden = true;
  document.getElementById('add-email-root').hidden = false;
  document.getElementById('reset-root').hidden = true;
  document.getElementById('reset-link-root').hidden = true;
  document.getElementById('add-email-error').textContent = '';
  document.getElementById('add-email-success').textContent = note || '';
  document.getElementById('add-email-input').value = '';
  document.getElementById('add-email-password').value = '';
  document.getElementById('add-email-input').focus();
}

async function submitAddEmail() {
  var errEl = document.getElementById('add-email-error');
  var okEl = document.getElementById('add-email-success');
  errEl.textContent = '';
  okEl.textContent = '';
  var email = document.getElementById('add-email-input').value.trim();
  var password = document.getElementById('add-email-password').value;
  if (!email) { errEl.textContent = 'Isi email kamu dulu.'; return; }
  if (!password) { errEl.textContent = 'Isi password akun kamu.'; return; }
  var btn = document.getElementById('btn-add-email');
  btn.disabled = true;
  try {
    var out = await apiChangeEmail({ username: addEmailUsername, new_email: email, password: password });
    /* F-09b: teruskan email_sent — bila false (OTP gagal terkirim),
       layar verifikasi tampil dengan catatan jujur "belum terkirim",
       bukan klaim "sudah dikirim". */
    showVerifyScreen(email, (out && out.message) || '', out && out.email_sent !== false);
  } catch (err) {
    errEl.textContent = (err && err.message) || 'Gagal menyimpan email.';
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Lupa password (alur tautan email) ----------
   Satu tahap saja di web: isi email -> POST /api/auth/password/
   forgot. Respons server SELALU generik (tidak membocorkan apakah
   email terdaftar). Email yang dikirim berisi tombol "Reset
   Password" yang menaut ke ?mode=reset&email&code — user membuka
   tautan itu dan HANYA mengisi password baru (kode dibaca dari
   URL, tidak diketik). TIDAK ada tombol kirim ulang terpisah:
   sesudah terkirim, tombol "Kirim kode reset" itu sendiri masuk
   cooldown 60 detik; mau tautan baru karena kedaluwarsa, tekan
   tombol yang sama lagi sesudah countdown selesai. Sukses reset
   TIDAK membuat sesi — user kembali ke form masuk dan masuk manual
   dengan password baru. */
function showForgotScreen() {
  stopAllResendCooldowns();
  document.getElementById('auth-root').hidden = false;
  document.getElementById('account-root').hidden = true;
  document.getElementById('login-panel').hidden = true;
  document.getElementById('verify-root').hidden = true;
  document.getElementById('add-email-root').hidden = true;
  document.getElementById('reset-root').hidden = false;
  document.getElementById('reset-link-root').hidden = true;
  hideChangeEmailForm();
  document.getElementById('forgot-error').textContent = '';
  document.getElementById('forgot-success').textContent = '';
  document.getElementById('reset-desc').textContent = 'Masukkan email kamu, kami kirimkan tautan reset password.';
  var input = document.getElementById('reset-email');
  var loginEmail = document.getElementById('login-email');
  if (!input.value && loginEmail && loginEmail.value) input.value = loginEmail.value;
  input.focus();
}

async function submitForgot() {
  var errEl = document.getElementById('forgot-error');
  var okEl = document.getElementById('forgot-success');
  errEl.textContent = '';
  okEl.textContent = '';
  var email = document.getElementById('reset-email').value.trim();
  if (!email) { errEl.textContent = 'Isi email akun kamu dulu.'; return; }
  var btn = document.getElementById('btn-forgot');
  /* v1.4.2 (F-03): umpan balik LANGSUNG — tombol langsung mati +
     teks "Mengirim…" begitu diklik, tanpa menunggu balasan server
     (SMTP Gmail bisa butuh beberapa detik). */
  btn.disabled = true;
  btn.textContent = 'Mengirim…';
  try {
    var out = await apiPost('/api/auth/password/forgot', { email: email });
    okEl.textContent = (out && out.message) || 'Tautan reset terkirim — cek email kamu.';
    /* Tombol yang sama masuk cooldown 60 detik (abu-abu +
       countdown) — tidak ada tombol kirim ulang lain di alur ini. */
    startResendCooldown(btn, 60, 'Kirim Tautan Reset');
  } catch (err) {
    errEl.textContent = (err && err.message) || 'Gagal meminta tautan reset.';
    btn.textContent = 'Kirim Tautan Reset';
  } finally {
    /* Bila cooldown berjalan, tombol memang harus tetap mati. */
    if (!resendCooldowns[btn.id]) btn.disabled = false;
  }
}

/* Panel dari tautan email reset (?mode=reset&email&code): HANYA
   kolom password baru. Email + kode sudah tersimpan di
   resetLinkEmail/resetLinkCode sejak halaman dibuka (URL-nya
   sudah dibersihkan saat itu juga). */
function showResetLinkScreen() {
  stopAllResendCooldowns();
  document.getElementById('auth-root').hidden = false;
  document.getElementById('account-root').hidden = true;
  document.getElementById('login-panel').hidden = true;
  document.getElementById('verify-root').hidden = true;
  document.getElementById('add-email-root').hidden = true;
  document.getElementById('reset-root').hidden = true;
  document.getElementById('reset-link-root').hidden = false;
  hideChangeEmailForm();
  document.getElementById('reset-link-desc').textContent = resetLinkEmail
    ? 'Buat password baru untuk akun dengan email ' + resetLinkEmail + '.'
    : 'Buat password baru untuk akun kamu.';
  document.getElementById('form-reset-link').hidden = false;
  document.getElementById('reset-link-invalid').hidden = true;
  document.getElementById('reset-link-error').textContent = '';
  var pw = document.getElementById('reset-link-password');
  pw.value = '';
  pw.focus();
}

/* Keadaan tautan mati (kode salah/kedaluwarsa/sudah dipakai):
   form diganti pesan jelas + tombol ke form lupa password untuk
   meminta tautan baru. */
function showResetLinkInvalid() {
  document.getElementById('form-reset-link').hidden = true;
  document.getElementById('reset-link-invalid').hidden = false;
}

async function submitResetLink() {
  var errEl = document.getElementById('reset-link-error');
  errEl.textContent = '';
  var newPassword = document.getElementById('reset-link-password').value;
  if (!newPassword || newPassword.length < 8) { errEl.textContent = 'Password baru minimal 8 karakter.'; return; }
  if (newPassword.length > 128) { errEl.textContent = 'Password terlalu panjang (maksimal 128 karakter).'; return; }
  if (!resetLinkEmail || !/^\d{6}$/.test(resetLinkCode)) { showResetLinkInvalid(); return; }
  var btn = document.getElementById('btn-reset-link');
  btn.disabled = true;
  try {
    await apiPost('/api/auth/password/reset', { email: resetLinkEmail, code: resetLinkCode, new_password: newPassword });
    /* Sukses: kembali ke form masuk dengan pesan sukses hijau.
       switchAuthMode -> renderAuthForm mengosongkan #auth-success,
       jadi pesan diisi SESUDAH beralih mode. */
    switchAuthMode('login');
    document.getElementById('auth-success').textContent = 'Password berhasil diatur ulang. Silakan masuk.';
    var pwInput = document.getElementById('login-password');
    pwInput.value = '';
    pwInput.focus();
  } catch (err) {
    /* Galat berkode dari endpoint reset (not_found/expired/void/
       wrong) berarti tautannya mati — kode berasal dari email itu
       sendiri, bukan ketikan user. Galat tanpa kode (validasi
       password / jaringan) ditampilkan apa adanya di form. */
    if (err && err.data && err.data.code) {
      showResetLinkInvalid();
    } else {
      errEl.textContent = (err && err.message) || 'Gagal mengatur ulang password.';
    }
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Profil ---------- */
async function loadAccount(force) {
  var authRoot = document.getElementById('auth-root');
  var accRoot = document.getElementById('account-root');
  try {
    var me = await currentUser();
    if (!me) {
      /* F-01: chrome digambar ulang sebagai tamu juga — sesi bisa
         saja baru berakhir di halaman ini, drawer tidak boleh
         tertinggal menampilkan akun lama. */
      refreshChrome('home', null);
      accRoot.hidden = true;
      authRoot.hidden = false;
      if (startInVerify) {
        showVerifyScreen(verifyEmail, '');
        startInVerify = false;
      } else if (startInResetLink) {
        startInResetLink = false;
        if (resetLinkCode) {
          showResetLinkScreen();
        } else {
          /* Tautan dari email reset lama (dibuat sebelum alur
             tautan berkode): URL-nya tidak membawa kode, jadi panel
             password baru tidak bisa dipakai — antar ke form lupa
             password untuk meminta tautan baru. */
          showForgotScreen();
        }
      } else {
        renderAuthForm();
      }
      return;
    }
    authRoot.hidden = true;
    accRoot.hidden = false;
    stopAllResendCooldowns();
    currentMe = me;
    /* F-01: gambar ulang chrome (header + drawer) dari sesi terbaru
       TANPA reload — tanpa ini drawer tetap keadaan tamu sesudah
       masuk/verifikasi berhasil di halaman ini. */
    refreshChrome('home', me);
    renderProfile(me);
    loadFavorites();
    loadHistorySection();
  } catch (err) {
    authRoot.hidden = false;
    accRoot.hidden = true;
    renderAuthForm();
  }
}

function equippedClass(equipped, kind) {
  if (!equipped || !equipped[kind]) return '';
  var asset = equipped[kind].asset;
  return asset ? esc(asset) : '';
}

/* Level + EXP (v1.3.1): chip level + bar progres ke level berikut.
   Admin selalu level 1000 (di atas cap pengguna 100) dan tampil
   dengan chip emas ADMIN, bukan chip level biasa dan tanpa bar. */
function levelHTML(level, user) {
  if (!level) return '';
  var isAdmin = user && user.role === 'admin';
  if (isAdmin) {
    return '<div class="level-row"><span class="chip-status chip-status--admin">Admin · Level 1000</span>' +
      '<span class="level-exp">Level admin — di atas level maks pengguna (100).</span></div>';
  }
  var pct = Math.max(0, Math.min(100, Math.round((level.progress || 0) * 100)));
  var expText = level.level >= 100
    ? 'Level maks tercapai · ' + esc(level.exp_total) + ' EXP'
    : esc(level.exp_total) + ' EXP · ' + esc(level.exp_for_next) + ' EXP lagi ke level ' + esc(level.level + 1);
  return '<div class="level-row"><span class="chip-status chip-status--level">Level ' + esc(level.level) + '</span>' +
    '<span class="level-exp">' + expText + '</span></div>' +
    '<div class="level-progress" title="Progres ke level ' + esc(level.level + 1) + '"><i style="width:' + pct + '%"></i></div>';
}

/* Terapkan aksesori terpasang ke kartu profil yang sudah tampil —
   hanya class + chip yang disentuh (F-05: tanpa renderProfile penuh).
   Dipakai setelah Pakai/Lepas dari panel pensil. */
function applyEquippedToHeader(me) {
  if (!me) return;
  var equipped = me.equipped || {};
  var card = document.getElementById('profile-card');
  if (card) {
    card.className = 'profile-card' +
      (equippedClass(equipped, 'border') ? ' ' + equippedClass(equipped, 'border') : '') +
      (equippedClass(equipped, 'background') ? ' ' + equippedClass(equipped, 'background') : '');
  }
  var av = document.getElementById('profile-avatar');
  if (av) {
    av.className = 'profile-avatar' +
      (equippedClass(equipped, 'frame') ? ' ' + equippedClass(equipped, 'frame') : '');
  }
  var nameEl = document.getElementById('profile-name');
  if (nameEl) {
    nameEl.className = 'profile-name' +
      (equippedClass(equipped, 'name_effect') ? ' ' + equippedClass(equipped, 'name_effect') : '');
  }
  var badgeRow = document.getElementById('profile-badge-row');
  if (badgeRow) {
    /* F-04: satu chip, satu label — nama lencana saja. */
    badgeRow.innerHTML = equipped.badge
      ? '<span class="chip-status chip-status--premium">' + esc(equipped.badge.name) + '</span>'
      : '';
  }
}

function renderProfile(me) {
  var user = me.user;
  var premium = me.premium || { is_premium: 0, premium_until: null, days_left: 0 };
  var equipped = me.equipped || {};
  var isPremium = premium.is_premium === 1;
  var nameCls = equippedClass(equipped, 'name_effect');
  var frameCls = equippedClass(equipped, 'frame');
  var borderCls = equippedClass(equipped, 'border');
  var bgCls = equippedClass(equipped, 'background');
  var badge = equipped.badge || null;
  var until = premium.premium_until ? fmtDate(premium.premium_until) : '';
  var daysLeft = premium.days_left || 0;
  var totalDays = 30;
  var pct = isPremium ? Math.max(4, Math.min(100, Math.round((daysLeft / totalDays) * 100))) : 0;
  document.getElementById('profile-section').innerHTML =
    '<div class="profile-card ' + borderCls + ' ' + bgCls + '" id="profile-card">' +
      '<div class="profile-avatar-wrap">' +
        '<div class="profile-avatar ' + frameCls + '" id="profile-avatar" style="' + avatarStyle(user) + '">' + esc((user.username || '?').charAt(0).toUpperCase()) + '</div>' +
        '<button class="avatar-edit-btn" id="btn-edit-profile" type="button" aria-label="Ubah profil">' + icon('pencil') + '</button>' +
      '</div>' +
      '<div style="flex:1;min-width:200px">' +
        '<h2 class="profile-name ' + nameCls + '" id="profile-name">' + esc(user.username) + '</h2>' +
        (user.email ? '<p class="profile-email">' + esc(user.email) + '</p>' : '') +
        '<div class="profile-status">' +
          (isPremium
            ? '<span class="chip-status chip-status--premium">PREMIUM</span>'
            : '<span class="chip-status chip-status--gratis">GRATIS</span>') +
          (isPremium
            ? '<span class="profile-until">Aktif sampai ' + esc(until) + ' (' + daysLeft + ' hari lagi)</span>'
            : '<a class="btn btn-primary btn-sm" href="/premium.html">Naik ke Premium</a>') +
        '</div>' +
        '<div class="profile-badge-row" id="profile-badge-row">' +
          (badge ? '<span class="chip-status chip-status--premium">' + esc(badge.name) + '</span>' : '') +
        '</div>' +
        (isPremium ? '<div class="premium-progress" title="Sisa masa premium"><i style="width:' + pct + '%"></i></div>' : '') +
        levelHTML(me.level, user) +
        '<p class="muted small" style="margin:8px 0 0">Bergabung ' + esc(fmtDate(user.created_at)) + (user.last_login_at ? ' · Terakhir masuk ' + esc(fmtDateTime(user.last_login_at)) : '') + '</p>' +
      '</div>' +
    '</div>';
  var editBtn = document.getElementById('btn-edit-profile');
  if (editBtn) editBtn.addEventListener('click', openEditProfilePanel);
}

/* ---------- Daftar Saya ---------- */
async function loadFavorites() {
  var grid = document.getElementById('fav-grid');
  if (!grid) return;
  grid.innerHTML = skeletonGridHTML(5);
  try {
    var res = await apiFavorites();
    if (!res.data.length) {
      grid.innerHTML = stateHTML('empty', 'Belum ada favorit', 'Tambahkan anime ke Daftar Saya dari halaman detail anime.', 'Jelajahi Anime', '/');
      return;
    }
    grid.innerHTML = res.data.slice(0, 10).map(function (it) { return cardHTML(it); }).join('');
  } catch (err) {
    grid.innerHTML = stateHTML('error', 'Daftar Saya gagal dimuat', (err && err.message) || 'Terjadi kesalahan.');
  }
}

/* ---------- Riwayat tontonan (v1.3.2) ----------
   Kartu anime yang pernah ditonton (dari /api/continue — satu kartu
   per anime, baris episode ganda digabung dengan mengambil yang
   terbaru). Klik kartu membuka daftar episode yang ditonton
   (GET /api/history/:anime_id) di modal. */
async function loadHistorySection() {
  var grid = document.getElementById('history-grid');
  if (!grid) return;
  grid.innerHTML = skeletonGridHTML(5);
  try {
    var res = await apiContinue();
    var seen = {};
    var list = [];
    (res.data || []).forEach(function (it) {
      if (!it || !it.id || seen[it.id]) return;
      seen[it.id] = true;
      list.push(it);
    });
    if (!list.length) {
      grid.innerHTML = stateHTML('empty', 'Belum ada riwayat', 'Tonton satu episode, dan riwayatmu muncul di sini.', 'Jelajahi Anime', '/');
      return;
    }
    grid.innerHTML = list.slice(0, 20).map(historyCardHTML).join('');
    grid.querySelectorAll('[data-history-anime]').forEach(function (card) {
      card.addEventListener('click', function () { openHistoryModal(card); });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHistoryModal(card); }
      });
    });
  } catch (err) {
    grid.innerHTML = stateHTML('error', 'Riwayat gagal dimuat', (err && err.message) || 'Terjadi kesalahan.');
  }
}

function historyCardHTML(item) {
  var score = scoreNum(item);
  return '<div class="anime-card history-card" role="button" tabindex="0" data-history-anime="' + esc(item.id) + '" data-history-title="' + esc(item.title) + '" aria-label="Lihat episode ' + esc(item.title) + ' yang ditonton">' +
    '<div class="anime-card__poster">' + posterImg(item) +
      '<div class="anime-card__badges">' + badgesHTML(item, false) + '</div>' +
      (score != null ? '<span class="anime-card__score">' + icon('star') + ' ' + score.toFixed(2) + '</span>' : '') +
    '</div>' +
    '<h3 class="anime-card__title">' + esc(item.title) + '</h3>' +
    '<p class="anime-card__meta">' + esc(metaLine(item)) + '</p>' +
    '<p class="anime-card__continue">Ep ' + esc(item.episode) + ' · ' + esc(item.percent || 0) + '% ditonton · ' + esc(timeAgo(item.updated_at)) + '</p>' +
    '<p class="history-card__more">Lihat episode yang ditonton ›</p>' +
  '</div>';
}

/* Modal daftar episode yang ditonton untuk satu anime. Status selesai
   diambil dari field `completed` (BUKAN dari percent — episode yang
   selesai via event complete bisa ber-percent 0). */
async function openHistoryModal(card) {
  var animeId = card.getAttribute('data-history-anime');
  var title = card.getAttribute('data-history-title') || 'Riwayat';
  var back = openModal(
    '<button class="modal__close" type="button" aria-label="Tutup">×</button>' +
    '<h2>' + esc(title) + '</h2>' +
    '<p class="edit-panel__hint">Episode yang pernah kamu tonton.</p>' +
    '<div id="history-ep-list"><div class="skeleton" style="height:120px"></div></div>'
  );
  var list = back.querySelector('#history-ep-list');
  try {
    var res = await apiHistory(animeId);
    var eps = res.data || [];
    if (!eps.length) {
      list.innerHTML = stateHTML('empty', 'Belum ada episode', 'Belum ada episode yang tercatat untuk anime ini.');
      return;
    }
    list.innerHTML = '<div class="history-ep-list">' + eps.map(function (ep) {
      var status = ep.completed
        ? '<span class="chip-status chip-status--ok">SELESAI</span>'
        : '<span class="chip-status chip-status--wait">' + esc(ep.percent || 0) + '% DITONTON</span>';
      return '<a class="history-ep-row" href="/watch.html?id=' + encodeURIComponent(animeId) + '&ep=' + esc(ep.episode) + '">' +
        '<span class="history-ep-row__num">Episode ' + esc(ep.episode) + '</span>' + status +
        '<span class="history-ep-row__meta">' + esc(ep.last_watched_at ? fmtDateTime(ep.last_watched_at) : '') + '</span></a>';
    }).join('') + '</div>';
  } catch (err) {
    list.innerHTML = stateHTML('error', 'Riwayat episode gagal dimuat', (err && err.message) || 'Terjadi kesalahan.');
  }
}

/* ---------- Panel pensil: Ubah Profil (v1.3.2) ----------
   Foto profil (8 preset avatar + default), ganti nama, dan form
   aksesori per jenis — masing-masing bagiannya sendiri. Panel dibuka
   dari ikon pensil di sudut avatar. Aksesori yang ditampilkan HANYA
   yang sudah dimiliki; yang premium terkunci bila Premium tidak
   aktif. F-05: Pakai/Lepas hanya memperbarui baris yang diklik +
   tampilan terpasang di header — tanpa renderProfile()/muat ulang
   penuh dan tanpa skeleton. */
var panelAccData = null;

function openEditProfilePanel() {
  if (!currentMe) return;
  var user = currentMe.user;
  var letter = esc((user.username || '?').charAt(0).toUpperCase());
  var avatarButtons = AVATAR_PRESETS.map(function (p) {
    var selected = user.avatar === p.code;
    return '<button type="button" class="avatar-option' + (selected ? ' is-selected' : '') + '" data-avatar="' + p.code + '" aria-pressed="' + (selected ? 'true' : 'false') + '" aria-label="Avatar ' + esc(p.name) + '">' +
      '<span class="avatar-option__circle" style="background:' + p.bg + ';color:' + p.fg + ';border-color:' + p.ring + '">' + letter + '</span>' +
      '<span class="avatar-option__name">' + esc(p.name) + '</span></button>';
  }).join('');
  var defaultSelected = !user.avatar;
  avatarButtons += '<button type="button" class="avatar-option' + (defaultSelected ? ' is-selected' : '') + '" data-avatar="" aria-pressed="' + (defaultSelected ? 'true' : 'false') + '" aria-label="Avatar default">' +
    '<span class="avatar-option__circle">' + letter + '</span>' +
    '<span class="avatar-option__name">Default</span></button>';
  var back = openModal(
    '<button class="modal__close" type="button" aria-label="Tutup">×</button>' +
    '<h2>Ubah Profil</h2>' +
    '<p class="edit-panel__hint">Foto, nama, dan aksesori profil kamu.</p>' +
    '<div class="edit-panel__section"><h3>Foto Profil</h3>' +
    '<p class="edit-panel__hint">Pilih salah satu — langsung tersimpan.</p>' +
    '<div class="avatar-grid" id="edit-avatar-grid">' + avatarButtons + '</div></div>' +
    '<div class="edit-panel__section"><h3>Nama</h3>' +
    '<div class="field"><label for="edit-username">Username</label>' +
    '<input id="edit-username" type="text" value="' + esc(user.username) + '" autocomplete="username" maxlength="32">' +
    '<p class="form-error" id="edit-username-error" role="alert"></p></div>' +
    '<button class="btn btn-primary" type="button" id="btn-save-username">Simpan Nama</button></div>' +
    '<div class="edit-panel__section"><h3>Aksesori</h3>' +
    '<p class="edit-panel__hint">Hanya aksesori yang sudah kamu miliki yang bisa dipakai. Aksesori premium terkunci bila Premium tidak aktif.</p>' +
    '<div id="edit-acc-groups"></div></div>' +
    '<p class="form-error" id="edit-panel-error" role="alert"></p>'
  );
  var grid = back.querySelector('#edit-avatar-grid');
  grid.addEventListener('click', function (e) {
    var btn = e.target.closest('.avatar-option');
    if (!btn) return;
    selectEditAvatar(btn.getAttribute('data-avatar') || null);
  });
  back.querySelector('#btn-save-username').addEventListener('click', saveEditUsername);
  var accBox = back.querySelector('#edit-acc-groups');
  accBox.addEventListener('click', function (e) {
    var eqBtn = e.target.closest('[data-equip]');
    if (eqBtn) { panelEquip(eqBtn); return; }
    var unBtn = e.target.closest('[data-unequip]');
    if (unBtn) panelUnequip(unBtn);
  });
  loadPanelAccessories();
}

async function selectEditAvatar(code) {
  var errEl = document.getElementById('edit-panel-error');
  if (errEl) errEl.textContent = '';
  try {
    var out = await apiUpdateProfile({ avatar: code });
    if (out && out.user) {
      if (currentMe) currentMe.user = out.user;
      clearMeCache();
      applyAvatarToHeader(out.user);
      document.querySelectorAll('#edit-avatar-grid .avatar-option').forEach(function (btn) {
        var selected = (btn.getAttribute('data-avatar') || null) === (out.user.avatar || null);
        btn.classList.toggle('is-selected', selected);
        btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
      });
      showToast('Foto profil diubah.');
    }
  } catch (err) {
    if (errEl) errEl.textContent = (err && err.message) || 'Gagal mengubah foto profil.';
  }
}

async function saveEditUsername() {
  var input = document.getElementById('edit-username');
  var errEl = document.getElementById('edit-username-error');
  if (!input || !errEl) return;
  errEl.textContent = '';
  var name = input.value.trim();
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(name)) {
    errEl.textContent = 'Username 3–32 karakter, hanya huruf, angka, _ dan -.';
    return;
  }
  if (currentMe && name === currentMe.user.username) {
    showToast('Nama tidak berubah.');
    return;
  }
  var btn = document.getElementById('btn-save-username');
  if (btn) btn.disabled = true;
  try {
    var out = await apiUpdateProfile({ username: name });
    if (out && out.user) {
      if (currentMe) currentMe.user = out.user;
      clearMeCache();
      applyAvatarToHeader(out.user);
      var nameEl = document.getElementById('profile-name');
      if (nameEl) nameEl.textContent = out.user.username;
      /* Huruf awal avatar ikut berubah mengikuti nama baru. */
      document.querySelectorAll('#edit-avatar-grid .avatar-option__circle').forEach(function (c) {
        c.textContent = (out.user.username || '?').charAt(0).toUpperCase();
      });
      showToast((out && out.message) || 'Nama berhasil diubah.');
    }
  } catch (err) {
    /* Termasuk 409 bila username sudah dipakai pengguna lain. */
    errEl.textContent = (err && err.message) || 'Gagal mengubah nama.';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadPanelAccessories() {
  var box = document.getElementById('edit-acc-groups');
  if (!box) return;
  if (panelAccData) { renderPanelAccessories(panelAccData); return; }
  box.innerHTML = '<div class="skeleton" style="height:120px"></div>';
  try {
    var res = await apiAccessories();
    panelAccData = res;
    renderPanelAccessories(res);
  } catch (err) {
    box.innerHTML = stateHTML('error', 'Aksesori gagal dimuat', (err && err.message) || 'Terjadi kesalahan.');
  }
}

function renderPanelAccessories(res) {
  var box = document.getElementById('edit-acc-groups');
  if (!box) return;
  var catalog = res.data || [];
  var owned = res.owned || [];
  var equipped = res.equipped || {};
  var isPremium = currentMe && currentMe.premium && currentMe.premium.is_premium === 1;
  var ownedIds = {};
  owned.forEach(function (o) { ownedIds[o.id] = true; });
  var kinds = ['border', 'background', 'frame', 'badge', 'name_effect'];
  box.innerHTML = kinds.map(function (kind) {
    var items = catalog.filter(function (a) { return a.kind === kind && ownedIds[a.id]; });
    var head = '<h3 style="margin:20px 0 0;font-size:15px">' + esc(ACC_KIND_LABEL[kind] || kind) + '</h3>';
    if (!items.length) {
      return head + '<p class="edit-panel__hint" style="margin-top:8px">Belum ada — dapatkan dari <a href="/premium.html">paket Premium</a>.</p>';
    }
    return head + items.map(function (a) { return accRowHTML(a, kind, equipped, isPremium); }).join('');
  }).join('');
}

/* Pratinjau kecil di baris opsi: bentuknya saja (huruf/bintang/
   contoh efek), bukan nama — nama sudah tertulis di badan baris,
   supaya tidak ganda. */
function accPreviewHTML(a, kind) {
  if (kind === 'frame') {
    return '<div class="acc-row__preview"><span class="profile-avatar ' + esc(a.asset || '') + '" style="width:40px;height:40px;font-size:16px">A</span></div>';
  }
  if (kind === 'badge') {
    return '<div class="acc-row__preview"><span style="font-size:22px;color:var(--lime)">★</span></div>';
  }
  if (kind === 'name_effect') {
    return '<div class="acc-row__preview"><span class="' + esc(a.asset || '') + '" style="font-size:18px">Aa</span></div>';
  }
  return '<div class="acc-row__preview ' + esc(a.asset || '') + '"></div>';
}

function accRowHTML(a, kind, equipped, isPremium) {
  var isEq = equipped[kind] && equipped[kind].id === a.id;
  var locked = a.premium_only && !isPremium;
  var btn = '';
  if (locked) {
    btn = '<button class="btn btn-ghost btn-sm" type="button" disabled>Premium</button>';
  } else if (isEq) {
    btn = '<button class="btn btn-ghost btn-sm" type="button" data-unequip="' + esc(kind) + '">Lepas</button>';
  } else {
    btn = '<button class="btn btn-primary btn-sm" type="button" data-equip="' + esc(a.id) + '">Pakai</button>';
  }
  return '<div class="acc-row' + (isEq ? ' is-equipped' : '') + '" data-acc-row="' + esc(a.id) + '" data-kind="' + esc(kind) + '">' +
    accPreviewHTML(a, kind) +
    '<div class="acc-row__body"><p class="acc-row__name">' + esc(a.name) + '</p>' +
    (locked ? '<p class="acc-row__note">Hanya untuk Premium aktif.</p>' : '') +
    '</div>' + btn + '</div>';
}

/* F-05: Pakai/Lepas hanya memperbarui baris yang diklik (+ baris
   sejenis yang tadinya terpasang) dan tampilan terpasang di header.
   Tidak ada renderProfile(), tidak ada muat ulang daftar, tidak ada
   skeleton — jadi tidak ada kedip. */
async function panelEquip(btn) {
  var id = parseInt(btn.getAttribute('data-equip'), 10);
  var row = btn.closest('.acc-row');
  var kind = row ? row.getAttribute('data-kind') : '';
  btn.disabled = true;
  try {
    var out = await apiEquipAccessory(id);
    if (out && out.equipped) {
      panelAccData.equipped = out.equipped;
      if (currentMe) currentMe.equipped = out.equipped;
      clearMeCache();
      applyEquippedToHeader(currentMe);
      var box = document.getElementById('edit-acc-groups');
      if (box) {
        box.querySelectorAll('.acc-row[data-kind="' + kind + '"]').forEach(function (r) {
          var b = r.querySelector('[data-equip],[data-unequip]');
          if (!b) return;
          var rowId = parseInt(r.getAttribute('data-acc-row'), 10);
          if (rowId === id) {
            r.classList.add('is-equipped');
            b.textContent = 'Lepas';
            b.className = 'btn btn-ghost btn-sm';
            b.setAttribute('data-unequip', kind);
            b.removeAttribute('data-equip');
          } else if (b.hasAttribute('data-unequip')) {
            r.classList.remove('is-equipped');
            b.textContent = 'Pakai';
            b.className = 'btn btn-primary btn-sm';
            b.setAttribute('data-equip', String(rowId));
            b.removeAttribute('data-unequip');
          }
          b.disabled = false;
        });
      }
    }
    showToast((out && out.message) || 'Aksesori dipakai.');
  } catch (err) {
    showToast((err && err.message) || 'Gagal memakai aksesori.', 'error');
    btn.disabled = false;
  }
}

async function panelUnequip(btn) {
  var kind = btn.getAttribute('data-unequip');
  var row = btn.closest('.acc-row');
  btn.disabled = true;
  try {
    var out = await apiUnequipAccessory(kind);
    if (out && out.equipped) {
      panelAccData.equipped = out.equipped;
      if (currentMe) currentMe.equipped = out.equipped;
      clearMeCache();
      applyEquippedToHeader(currentMe);
      if (row) {
        var rowId = parseInt(row.getAttribute('data-acc-row'), 10);
        row.classList.remove('is-equipped');
        btn.textContent = 'Pakai';
        btn.className = 'btn btn-primary btn-sm';
        btn.setAttribute('data-equip', String(rowId));
        btn.removeAttribute('data-unequip');
      }
    }
    showToast('Aksesori dilepas.');
  } catch (err) {
    showToast((err && err.message) || 'Gagal melepas aksesori.', 'error');
  } finally {
    btn.disabled = false;
  }
}
