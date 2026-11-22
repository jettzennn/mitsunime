/* ============================================================
   settings.js — Halaman Setelan Akun Mitsunime (v1.3.3)
   Isi setelan yang tadinya menempel di halaman profil (v1.3.2):
   Ganti Email, Ubah Password. Dibuka dari
   popover akun di kaki sidebar (ikon gerigi + "Setelan akun").
   TIDAK ada tombol Keluar di sini — Keluar ada di popover
   sidebar yang sama (common.js, location.replace).
   Halaman ini WAJIB login: tamu diarahkan dengan
   location.replace ke /account.html?mode=login, dan penjaga
   bfcache/popstate memeriksa ulang sesi secara segar supaya
   tombol Back tidak menampilkan setelan setelah keluar.
   Jangkar: container akun sidebar menautkan langsung ke
   #ganti-email / #ganti-password — focusSettingsHash menggulir
   ke blok itu dan memfokuskan kolom pertamanya.
   ============================================================ */

var settingsMe = null;

document.addEventListener('DOMContentLoaded', function () {
  initSettings();
});

/* Penjaga Back / bfcache: sesi diperiksa ulang tanpa cache
   (clearMeCache + apiMe dengan cache 'no-store' dari apiFetch).
   Bila sesi sudah tidak ada, tinggalkan halaman ini. */
async function revalidateSettingsSession() {
  var root = document.getElementById('settings-root');
  if (!root || root.hidden) return;
  var me = null;
  try {
    clearMeCache();
    me = await apiMe();
  } catch (err) {
    me = null;
  }
  if (me && me.user) {
    settingsMe = me;
    return;
  }
  root.hidden = true;
  window.location.replace('/account.html?mode=login');
}
window.addEventListener('pageshow', function (e) {
  if (e.persisted) revalidateSettingsSession();
});
window.addEventListener('popstate', function () {
  revalidateSettingsSession();
});

async function initSettings() {
  var user = await mountChrome('home');
  if (!user || !user.user) {
    window.location.replace('/account.html?mode=login');
    return;
  }
  settingsMe = user;
  var root = document.getElementById('settings-root');
  if (root) root.hidden = false;
  var line = document.getElementById('settings-account-line');
  if (line) {
    line.textContent = user.user.email
      ? 'Masuk sebagai ' + user.user.username + ' · ' + user.user.email
      : 'Masuk sebagai ' + user.user.username + ' · belum ada email';
  }
  initSettingsChangeEmail();
  initPasswordForm();
  if (typeof initPasswordToggles === 'function') initPasswordToggles(document);
  focusSettingsHash();
}

/* ---------- Jangkar dari container akun sidebar ----------
   #ganti-email -> blok Ganti Email (fokus ke kolom email baru),
   #ganti-password -> blok Ubah Password (fokus ke kolom password
   saat ini). Dipanggil saat halaman dibuka dan tiap hash berubah
   (mis. pengguna sudah di halaman ini lalu mengetuk opsi lain di
   sidebar). Blok yang dituju diberi sorotan singkat. */
var SETTINGS_HASH_TARGETS = {
  '#ganti-email': 'settings-new-email',
  '#ganti-password': 'pw-current',
};
function focusSettingsHash() {
  var inputId = SETTINGS_HASH_TARGETS[window.location.hash || ''];
  if (!inputId) return;
  var block = document.getElementById(window.location.hash.slice(1));
  var input = document.getElementById(inputId);
  if (!block) return;
  /* Tunggu satu frame: root baru saja ditampilkan (hidden=false)
     dan chrome selesai dipasang, supaya gulirnya akurat. */
  window.requestAnimationFrame(function () {
    block.scrollIntoView({ block: 'start' });
    document.querySelectorAll('.settings-block--target').forEach(function (el) {
      el.classList.remove('settings-block--target');
    });
    var inner = block.querySelector('.settings-block');
    if (inner) {
      inner.classList.add('settings-block--target');
      window.setTimeout(function () { inner.classList.remove('settings-block--target'); }, 2400);
    }
    if (input) {
      try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
    }
  });
}
window.addEventListener('hashchange', function () { focusSettingsHash(); });

/* ---------- Ganti email (F-09) ----------
   Memakai endpoint change-email yang sama dengan layar
   verifikasi (wajib password). Untuk akun terverifikasi yang
   sedang login, server mengubah email, mereset verifikasi,
   mengirim OTP baru ke email baru, dan mencabut sesi saat ini —
   respons membawa verification_required: true. Bila true,
   arahkan ke layar verifikasi di halaman akun dengan email
   baru (location.replace, supaya Back tidak kembali ke form
   setelan dengan sesi yang sudah dicabut). */
function initSettingsChangeEmail() {
  var form = document.getElementById('form-settings-change-email');
  if (!form || form.dataset.bound) return;
  form.dataset.bound = '1';
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var errEl = document.getElementById('settings-change-email-error');
    var okEl = document.getElementById('settings-change-email-success');
    errEl.textContent = '';
    okEl.textContent = '';
    var newEmail = document.getElementById('settings-new-email').value.trim();
    var password = document.getElementById('settings-change-email-password').value;
    if (!newEmail) { errEl.textContent = 'Isi email baru kamu dulu.'; return; }
    if (!password) { errEl.textContent = 'Isi password akun kamu.'; return; }
    var username = (settingsMe && settingsMe.user && settingsMe.user.username) || '';
    if (!username) { errEl.textContent = 'Sesi tidak ditemukan. Muat ulang halaman.'; return; }
    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      var out = await apiChangeEmail({ username: username, new_email: newEmail, password: password });
      if (out && out.verification_required === true) {
        clearMeCache();
        window.location.replace('/account.html?mode=verify&email=' + encodeURIComponent(newEmail));
        return;
      }
      /* Balasan sukses tanpa verification_required (mis. SMTP
         tidak diatur di server): email sudah berubah, tidak ada
         verifikasi lanjutan. */
      if (out && out.ok !== false) {
        okEl.textContent = (out && out.message) || 'Email berhasil diganti.';
        form.reset();
        return;
      }
      errEl.textContent = (out && out.message) || 'Gagal mengganti email.';
    } catch (err) {
      /* F-05: jalur setelan SELALU akun sendiri yang sedang masuk
         (username dari sesi), jadi 401 dari endpoint change-email
         di sini hanya bisa berarti password yang diisi salah.
         Pesan server untuk 401 itu generik anti-enumerasi dari
         alur verifikasi ("Bila akun terdaftar dan belum
         terverifikasi, kode baru sudah dikirim…") — menyesatkan
         di sini dan TIDAK boleh ditampilkan. Galat lain (400
         email sudah dipakai, 429 terlalu banyak percobaan, dst.)
         pesannya memang pesan sebenarnya: tampilkan apa adanya. */
      if (err && err.status === 401) {
        errEl.textContent = 'Password salah. Coba lagi.';
      } else {
        errEl.textContent = (err && err.message) || 'Gagal mengganti email.';
      }
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------- Ubah password ---------- */
function initPasswordForm() {
  var form = document.getElementById('form-password');
  if (!form || form.dataset.bound) return;
  form.dataset.bound = '1';
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var errEl = document.getElementById('pw-error');
    var okEl = document.getElementById('pw-success');
    errEl.textContent = '';
    okEl.textContent = '';
    var current = document.getElementById('pw-current').value;
    var next = document.getElementById('pw-new').value;
    if (!current || !next) { errEl.textContent = 'Isi kedua kolom password.'; return; }
    try {
      var out = await apiChangePassword(current, next);
      okEl.textContent = (out && out.message) || 'Password berhasil diubah.';
      form.reset();
    } catch (err) {
      errEl.textContent = (err && err.message) || 'Gagal mengubah password.';
    }
  });
}
