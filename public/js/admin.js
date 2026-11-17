/* ============================================================
   admin.js — Dashboard Admin Mitsunime (task-13)
   PENTING: alamat API admin TIDAK PERNAH ditulis di file ini.
   Halaman ini disajikan di /{ADMIN_PATH}/ (token dari .env), jadi
   basis API dibaca dari URL halaman saat ini:
   location.pathname (tanpa garis miring akhir) + "/api".
   Tidak ada tautan ke halaman ini dari situs publik mana pun.
   ============================================================ */

/* Basis API admin dari URL halaman saat ini — tanpa hardcode token. */
function adminBase() {
  var p = window.location.pathname.replace(/\/+$/, '');
  return p + '/api';
}

function adminFetch(path, opts) {
  var init = { headers: { Accept: 'application/json' } };
  if (opts) {
    if (opts.method) init.method = opts.method;
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
  }
  return fetch(adminBase() + path, init).then(function (res) {
    return res.json().catch(function () { return null; }).then(function (body) {
      if (!res.ok) {
        var msg = (body && body.message) || ('Server mengembalikan galat ' + res.status + '.');
        throw new ApiError(msg, res.status);
      }
      if (!body || body.ok === false) {
        throw new ApiError((body && body.message) || 'Respons server tidak dikenali.', res.status);
      }
      return body;
    });
  }).catch(function (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(API_OFFLINE_MESSAGE, 0);
  });
}

var SECTIONS = {
  ringkasan: 'Ringkasan',
  transaksi: 'Transaksi',
  pengguna: 'Pengguna',
  judul: 'Judul',
  paket: 'Paket',
  diskon: 'Diskon',
  aksesoris: 'Aksesori',
  pengaturan: 'Pengaturan',
  audit: 'Log Audit',
};
var adminState = { section: 'ringkasan', txStatus: 'pending', txPage: 1, txPages: 1, userPage: 1, userPages: 1, userSearch: '', auditPage: 1, auditPages: 1 };

document.addEventListener('DOMContentLoaded', function () {
  checkAdminSession();
  document.getElementById('form-admin-login').addEventListener('submit', function (e) {
    e.preventDefault();
    submitAdminLogin();
  });
  document.getElementById('btn-admin-logout').addEventListener('click', async function () {
    try { await adminFetch('/logout', { method: 'POST', body: {} }); } catch (err) { /* abaikan */ }
    window.location.reload();
  });
  document.getElementById('btn-admin-drawer').addEventListener('click', function () {
    document.getElementById('admin-sidebar').classList.toggle('is-open');
  });
  document.getElementById('admin-nav').addEventListener('click', function (e) {
    var a = e.target.closest('a[data-section]');
    if (!a) return;
    e.preventDefault();
    showSection(a.getAttribute('data-section'));
    document.getElementById('admin-sidebar').classList.remove('is-open');
  });
  window.addEventListener('hashchange', function () {
    var s = (window.location.hash || '#ringkasan').slice(1);
    if (SECTIONS[s]) showSection(s);
  });
});

async function checkAdminSession() {
  try {
    await adminFetch('/me');
    document.getElementById('admin-login').hidden = true;
    document.getElementById('admin-app').hidden = false;
    var s = (window.location.hash || '#ringkasan').slice(1);
    showSection(SECTIONS[s] ? s : 'ringkasan');
  } catch (err) {
    document.getElementById('admin-app').hidden = true;
    document.getElementById('admin-login').hidden = false;
  }
}

async function submitAdminLogin() {
  var errEl = document.getElementById('admin-login-error');
  errEl.textContent = '';
  var username = document.getElementById('admin-username').value.trim();
  var password = document.getElementById('admin-password').value;
  if (!username || !password) { errEl.textContent = 'Isi username atau email dan password.'; return; }
  try {
    await adminFetch('/login', { method: 'POST', body: { username: username, password: password } });
    window.location.reload();
  } catch (err) {
    errEl.textContent = (err && err.message) || 'Username atau password salah.';
  }
}

function showSection(name) {
  adminState.section = name;
  document.getElementById('admin-page-title').textContent = SECTIONS[name];
  document.querySelectorAll('#admin-nav a').forEach(function (a) {
    a.classList.toggle('is-active', a.getAttribute('data-section') === name);
  });
  document.querySelectorAll('[data-panel]').forEach(function (p) {
    p.hidden = p.getAttribute('data-panel') !== name;
  });
  if (window.location.hash !== '#' + name) window.history.replaceState(null, '', '#' + name);
  if (name === 'ringkasan') loadSummary();
  if (name === 'transaksi') loadTransactions();
  if (name === 'pengguna') loadUsers();
  if (name === 'paket') loadPlans();
  if (name === 'diskon') loadDiscounts();
  if (name === 'aksesoris') loadAccessories();
  if (name === 'pengaturan') loadSettings();
  if (name === 'audit') loadAudit();
}

/* ---------- Ringkasan ---------- */
async function loadSummary() {
  try {
    var s = await adminFetch('/summary');
    var d = s.data;
    document.getElementById('summary-cards').innerHTML =
      '<div class="admin-card"><p class="admin-card__label">Transaksi Menunggu</p><p class="admin-card__num">' + esc(d.pending_transactions) + (d.paid_awaiting_approval ? ' <span class="chip-status chip-status--wait">' + esc(d.paid_awaiting_approval) + ' sudah dibayar</span>' : '') + '</p></div>' +
      '<div class="admin-card"><p class="admin-card__label">Pengguna</p><p class="admin-card__num">' + esc(d.users) + '</p></div>' +
      '<div class="admin-card"><p class="admin-card__label">Pengguna Premium</p><p class="admin-card__num">' + esc(d.premium_active) + '</p></div>' +
      '<div class="admin-card"><p class="admin-card__label">Judul di Katalog</p><p class="admin-card__num">' + esc(d.catalog_titles) + '</p></div>';
    var tx = await adminFetch('/transactions?status=pending&per_page=5');
    document.getElementById('summary-pending').innerHTML = tx.data.length
      ? tx.data.map(function (t) {
        return '<div class="admin-panel__row"><div class="grow"><strong>' + esc(t.username || ('Pengguna #' + t.user_id)) + '</strong> — ' + esc(t.plan_name || 'Paket') + ' · ' + esc(fmtRupiah(t.amount_idr)) + '<br><span class="muted">' + esc(fmtDateTime(t.created_at)) + ' · ' + esc(t.payment_status) + '</span></div><a class="btn btn-ghost btn-sm" href="#transaksi">Proses</a></div>';
      }).join('')
      : '<p class="muted">Tidak ada transaksi menunggu.</p>';
    /* v1.3.0: peringatan bila verifikasi email belum aktif — admin
       yang mengatur SMTP di .env, bukan pengguna. */
    var notice = document.getElementById('summary-notice');
    if (d.email_verification && !d.email_verification.enabled) {
      notice.innerHTML = '<div class="banner"><span>Verifikasi email belum aktif — isi SMTP_HOST, SMTP_USER, dan SMTP_PASS di .env supaya pendaftaran memakai kode OTP. Tanpa itu, email apa pun bisa daftar.</span></div>';
    } else {
      notice.innerHTML = '';
    }
    var audit = await adminFetch('/audit?per_page=5');
    document.getElementById('summary-audit').innerHTML = audit.data.length
      ? audit.data.map(function (r) {
        return '<div class="admin-panel__row"><div class="grow"><strong>' + esc(r.action) + '</strong> — ' + esc(r.admin_username || 'admin') + '<br><span class="muted">' + esc(fmtDateTime(r.created_at)) + '</span></div></div>';
      }).join('')
      : '<p class="muted">Belum ada aktivitas.</p>';
  } catch (err) {
    document.getElementById('summary-cards').innerHTML = stateHTML('error', 'Ringkasan gagal dimuat', (err && err.message) || 'Terjadi kesalahan.');
  }
}

/* ---------- Transaksi ---------- */
function txAdminStatusChip(tx) {
  if (tx.status === 'approved') return '<span class="chip-status chip-status--ok">DISETUJUI</span>';
  if (tx.status === 'rejected') return '<span class="chip-status chip-status--no">DITOLAK</span>';
  return '<span class="chip-status chip-status--wait">MENUNGGU</span>';
}

async function loadTransactions() {
  var rows = document.getElementById('tx-rows');
  rows.innerHTML = '<tr><td colspan="7" class="muted">Memuat…</td></tr>';
  try {
    var res = await adminFetch('/transactions?status=' + encodeURIComponent(adminState.txStatus) + '&page=' + adminState.txPage + '&per_page=20');
    adminState.txPages = (res.pagination && res.pagination.total_pages) || 1;
    if (!res.data.length) {
      rows.innerHTML = '<tr><td colspan="7" class="muted">Tidak ada transaksi ' + esc(adminState.txStatus === 'all' ? '' : adminState.txStatus) + '.</td></tr>';
    } else {
      rows.innerHTML = res.data.map(function (tx) {
        var isManual = tx.method === 'manual_qris';
        var methodLabel = isManual ? 'QRIS Manual' : (tx.method || 'Midtrans');
        /* Transaksi manual: payment_status 'unpaid' adalah keadaan
           normal (tidak ada gateway) — tampilkan "menunggu verifikasi
           admin", bukan status gateway mentah. */
        var payMeta = isManual ? 'menunggu verifikasi admin'
          : esc(tx.payment_status || '') + (tx.gateway_order_id ? ' · ' + esc(tx.gateway_order_id) : '');
        return '<tr' + (tx.status === 'pending' ? ' class="is-pending"' : '') + '>' +
          '<td><strong>' + esc(tx.username || ('#' + tx.user_id)) + '</strong></td>' +
          '<td>' + esc(tx.plan_name || '—') + '</td>' +
          '<td>' + esc(fmtRupiah(tx.amount_idr)) + '</td>' +
          '<td>' + esc(methodLabel) + '<br><span class="muted small">' + payMeta + (tx.proof_ref ? ' · Ref: ' + esc(tx.proof_ref) : '') + '</span></td>' +
          '<td>' + txAdminStatusChip(tx) + (tx.note ? '<br><span class="muted small">' + esc(tx.note) + '</span>' : '') + '</td>' +
          '<td>' + esc(fmtDateTime(tx.created_at)) + '</td>' +
          '<td class="actions">' + (isManual && tx.has_proof
            ? '<button class="btn btn-ghost btn-sm" type="button" data-tx-proof="' + esc(tx.id) + '">Lihat Bukti</button>' : '') +
            (tx.status === 'pending'
            ? '<button class="btn btn-primary btn-sm" type="button" data-tx-approve="' + esc(tx.id) + '" data-tx-method="' + esc(tx.method || '') + '" data-tx-proof-flag="' + (tx.has_proof ? '1' : '0') + '">Setujui</button>' +
              '<button class="btn btn-danger btn-sm" type="button" data-tx-reject="' + esc(tx.id) + '" data-tx-method="' + esc(tx.method || '') + '" data-tx-proof-flag="' + (tx.has_proof ? '1' : '0') + '">Tolak</button>'
            : '<span class="muted small">Sudah diputuskan</span>') + '</td></tr>';
      }).join('');
    }
    var pag = document.getElementById('tx-pagination');
    pag.hidden = adminState.txPages <= 1;
    document.getElementById('tx-page-info').textContent = 'Halaman ' + adminState.txPage + ' dari ' + adminState.txPages;
    document.getElementById('tx-prev').disabled = adminState.txPage <= 1;
    document.getElementById('tx-next').disabled = adminState.txPage >= adminState.txPages;
    rows.querySelectorAll('[data-tx-proof]').forEach(function (btn) {
      btn.addEventListener('click', function () { showProofModal(parseInt(btn.getAttribute('data-tx-proof'), 10)); });
    });
    rows.querySelectorAll('[data-tx-approve]').forEach(function (btn) {
      btn.addEventListener('click', function () { decideTx(parseInt(btn.getAttribute('data-tx-approve'), 10), 'approve', { method: btn.getAttribute('data-tx-method'), hasProof: btn.getAttribute('data-tx-proof-flag') === '1' }); });
    });
    rows.querySelectorAll('[data-tx-reject]').forEach(function (btn) {
      btn.addEventListener('click', function () { decideTx(parseInt(btn.getAttribute('data-tx-reject'), 10), 'reject', { method: btn.getAttribute('data-tx-method'), hasProof: btn.getAttribute('data-tx-proof-flag') === '1' }); });
    });
  } catch (err) {
    rows.innerHTML = '<tr><td colspan="7" class="muted">Gagal memuat transaksi: ' + esc(err.message || 'Terjadi kesalahan.') + '</td></tr>';
  }
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('tx-filters').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-status]');
    if (!btn) return;
    adminState.txStatus = btn.getAttribute('data-status');
    adminState.txPage = 1;
    document.querySelectorAll('#tx-filters .chip').forEach(function (c) { c.classList.toggle('is-active', c === btn); });
    loadTransactions();
  });
  document.getElementById('tx-prev').addEventListener('click', function () { adminState.txPage = Math.max(1, adminState.txPage - 1); loadTransactions(); });
  document.getElementById('tx-next').addEventListener('click', function () { adminState.txPage = Math.min(adminState.txPages, adminState.txPage + 1); loadTransactions(); });
});

/* ---------- Bukti bayar manual (v1.1.0) ---------- */
/* Gambar bukti diambil lewat <img src> same-origin — cookie sesi admin
   terkirim; jangan lewat fetch tanpa kredensial. */
function showProofModal(txId) {
  openModal(
    '<button class="modal__close" type="button" aria-label="Tutup">×</button>' +
    '<h2>Bukti Bayar — Transaksi #' + esc(txId) + '</h2>' +
    '<p class="muted" style="font-size:14px">Periksa bukti ini dan mutasi di aplikasi pembayaran kamu sebelum menyetujui.</p>' +
    '<img class="proof-img" src="' + adminBase() + '/transactions/' + encodeURIComponent(txId) + '/proof" alt="Bukti bayar transaksi #' + esc(txId) + '">' +
    '<div class="modal__actions"><button class="btn btn-primary" type="button" id="proof-close">Tutup</button></div>'
  );
  document.getElementById('proof-close').addEventListener('click', closeModal);
}

function decideTx(id, action, txMeta) {
  var isApprove = action === 'approve';
  var isManual = txMeta && txMeta.method === 'manual_qris';
  var hasProof = txMeta && txMeta.hasProof;
  openModal(
    '<button class="modal__close" type="button" aria-label="Tutup">×</button>' +
    '<h2>' + (isApprove ? 'Setujui Transaksi' : 'Tolak Transaksi') + '</h2>' +
    '<p class="muted" style="font-size:14px">' + (isApprove
      ? 'Pengguna langsung menjadi Premium selama durasi paket dan mendapat aksesori premium.'
      : 'Pengguna bisa melihat catatan penolakan di halaman akunnya.') + '</p>' +
    (isManual && isApprove
      ? '<p class="muted" style="font-size:14px"><strong>Verifikasi manual:</strong> transaksi ini dibayar lewat QRIS. Periksa bukti bayar dan mutasi di aplikasi pembayaran kamu sebelum menyetujui — tidak ada verifikasi gateway.</p>' +
        (hasProof ? '<p><button class="btn btn-ghost btn-sm" type="button" id="tx-modal-proof">Lihat Bukti Bayar</button></p>' : '<p class="muted" style="font-size:14px">Transaksi ini tidak melampirkan gambar bukti — periksa dari mutasi di aplikasi pembayaran kamu.</p>')
      : '') +
    '<div class="field"><label for="tx-note">Catatan admin (opsional' + (isApprove ? '' : ', akan dibaca pengguna') + ')</label>' +
    '<textarea id="tx-note" placeholder="Tulis catatan bila perlu"></textarea></div>' +
    '<p class="form-error" id="tx-modal-error" role="alert"></p>' +
    '<div class="modal__actions">' +
      '<button class="btn btn-ghost" type="button" id="tx-modal-cancel">Batalkan</button>' +
      '<button class="btn ' + (isApprove ? 'btn-primary' : 'btn-danger') + '" type="button" id="tx-modal-ok">' + (isApprove ? 'Ya, Setujui' : 'Ya, Tolak') + '</button>' +
    '</div>'
  );
  document.getElementById('tx-modal-cancel').addEventListener('click', closeModal);
  var proofBtn = document.getElementById('tx-modal-proof');
  if (proofBtn) proofBtn.addEventListener('click', function () { showProofModal(id); });
  document.getElementById('tx-modal-ok').addEventListener('click', async function () {
    var note = document.getElementById('tx-note').value.trim();
    var errEl = document.getElementById('tx-modal-error');
    var okBtn = document.getElementById('tx-modal-ok');
    okBtn.disabled = true;
    try {
      var out = await adminFetch('/transactions/' + id + '/' + action, { method: 'POST', body: { note: note || null } });
      closeModal();
      var msg = (out && out.message) || (isApprove ? 'Transaksi disetujui.' : 'Transaksi ditolak.');
      if (out && out.manual_verification) {
        /* Penanda verifikasi manual dari respons approve (v1.1.0):
           bukan payment_warning gateway — ditampilkan utuh, bukan
           sebagai peringatan. */
        openModal(
          '<button class="modal__close" type="button" aria-label="Tutup">×</button>' +
          '<h2>Transaksi Disetujui</h2>' +
          '<p>' + esc(msg) + '</p>' +
          '<p class="muted" style="font-size:14px">' + esc(out.verification_note || 'Verifikasi manual: pembayaran dicek sendiri oleh admin berdasarkan bukti bayar dan mutasi di aplikasi pembayaran (tidak ada verifikasi gateway).') + '</p>' +
          '<p class="muted" style="font-size:14px">Bukti bayar terlampir: ' + (out.proof_present ? 'ada' : 'tidak ada') + '.</p>' +
          '<div class="modal__actions"><button class="btn btn-primary" type="button" id="manual-ok-close">Tutup</button></div>'
        );
        document.getElementById('manual-ok-close').addEventListener('click', closeModal);
      } else {
        if (out && out.payment_warning) msg += ' ' + out.payment_warning;
        showToast(msg, out && out.payment_warning ? 'wait' : 'ok');
      }
      loadTransactions();
    } catch (err) {
      errEl.textContent = (err && err.message) || 'Gagal memproses transaksi.';
      okBtn.disabled = false;
    }
  });
}

/* ---------- Pengguna ---------- */
var _userSearchTimer = null;
document.addEventListener('DOMContentLoaded', function () {
  var input = document.getElementById('user-search');
  if (input) input.addEventListener('input', function () {
    clearTimeout(_userSearchTimer);
    _userSearchTimer = setTimeout(function () { adminState.userSearch = input.value.trim(); adminState.userPage = 1; loadUsers(); }, 300);
  });
  document.getElementById('user-prev').addEventListener('click', function () { adminState.userPage = Math.max(1, adminState.userPage - 1); loadUsers(); });
  document.getElementById('user-next').addEventListener('click', function () { adminState.userPage = Math.min(adminState.userPages, adminState.userPage + 1); loadUsers(); });
});

/* Level + EXP (v1.3.1): admin selalu level 1000. */
function levelCellHTML(u) {
  var lv = u.level || null;
  if (!lv) return '—';
  if (u.role === 'admin') return '<strong>Lv 1000</strong><br><span class="muted small">Admin</span>';
  return '<strong>Lv ' + esc(lv.level) + '</strong><br><span class="muted small">' + esc(lv.exp_total) + ' EXP</span>';
}

async function loadUsers() {
  var rows = document.getElementById('user-rows');
  rows.innerHTML = '<tr><td colspan="7" class="muted">Memuat…</td></tr>';
  try {
    var res = await adminFetch('/users?search=' + encodeURIComponent(adminState.userSearch) + '&page=' + adminState.userPage + '&per_page=20');
    adminState.userPages = (res.pagination && res.pagination.total_pages) || 1;
    if (!res.data.length) {
      rows.innerHTML = '<tr><td colspan="7" class="muted">Tidak ada pengguna yang cocok.</td></tr>';
    } else {
      rows.innerHTML = res.data.map(function (u) {
        var p = u.premium || { is_premium: 0 };
        return '<tr>' +
          '<td><strong>' + esc(u.username) + '</strong>' + (u.role === 'admin' ? ' <span class="chip-status chip-status--premium">ADMIN</span>' : '') + '</td>' +
          '<td>' + esc(u.email || '—') + '</td>' +
          '<td>' + (p.is_premium ? '<span class="chip-status chip-status--premium">PREMIUM</span>' : '<span class="chip-status chip-status--gratis">GRATIS</span>') + '</td>' +
          '<td>' + levelCellHTML(u) + '</td>' +
          '<td>' + (u.premium_until ? esc(fmtDate(u.premium_until)) : '—') + '</td>' +
          '<td>' + esc(fmtDate(u.created_at)) + '</td>' +
          '<td class="actions">' + (u.role === 'admin'
            ? '<span class="muted small">Admin tidak bisa diubah dari sini</span>'
            : '<button class="btn btn-primary btn-sm" type="button" data-user-grant="' + esc(u.id) + '" data-username="' + esc(u.username) + '">Beri Premium</button>' +
              (p.is_premium ? '<button class="btn btn-danger btn-sm" type="button" data-user-revoke="' + esc(u.id) + '" data-username="' + esc(u.username) + '">Cabut Premium</button>' : '')) +
          '</td></tr>';
      }).join('');
    }
    var pag = document.getElementById('user-pagination');
    pag.hidden = adminState.userPages <= 1;
    document.getElementById('user-page-info').textContent = 'Halaman ' + adminState.userPage + ' dari ' + adminState.userPages;
    document.getElementById('user-prev').disabled = adminState.userPage <= 1;
    document.getElementById('user-next').disabled = adminState.userPage >= adminState.userPages;
    rows.querySelectorAll('[data-user-grant]').forEach(function (btn) {
      btn.addEventListener('click', function () { grantPremiumModal(parseInt(btn.getAttribute('data-user-grant'), 10), btn.getAttribute('data-username')); });
    });
    rows.querySelectorAll('[data-user-revoke]').forEach(function (btn) {
      btn.addEventListener('click', function () { revokePremiumModal(parseInt(btn.getAttribute('data-user-revoke'), 10), btn.getAttribute('data-username')); });
    });
  } catch (err) {
    rows.innerHTML = '<tr><td colspan="7" class="muted">Gagal memuat pengguna: ' + esc(err.message || 'Terjadi kesalahan.') + '</td></tr>';
  }
}

function grantPremiumModal(userId, username) {
  openModal(
    '<button class="modal__close" type="button" aria-label="Tutup">×</button>' +
    '<h2>Beri Premium — ' + esc(username) + '</h2>' +
    '<div class="field"><label for="grant-days">Durasi (hari)</label><input id="grant-days" type="number" min="1" max="3650" value="30" inputmode="numeric"></div>' +
    '<p class="form-error" id="grant-error" role="alert"></p>' +
    '<div class="modal__actions"><button class="btn btn-ghost" type="button" id="grant-cancel">Batalkan</button>' +
    '<button class="btn btn-primary" type="button" id="grant-ok">Ya, Beri Premium</button></div>'
  );
  document.getElementById('grant-cancel').addEventListener('click', closeModal);
  document.getElementById('grant-ok').addEventListener('click', async function () {
    var days = parseInt(document.getElementById('grant-days').value, 10);
    var errEl = document.getElementById('grant-error');
    if (!days || days < 1) { errEl.textContent = 'Durasi harus 1 hari atau lebih.'; return; }
    try {
      var out = await adminFetch('/users/' + userId + '/premium', { method: 'POST', body: { days: days } });
      closeModal();
      showToast((out && out.message) || 'Premium diberikan.');
      loadUsers();
    } catch (err) {
      errEl.textContent = (err && err.message) || 'Gagal memberi premium.';
    }
  });
}

function revokePremiumModal(userId, username) {
  openModal(
    '<button class="modal__close" type="button" aria-label="Tutup">×</button>' +
    '<h2>Cabut Premium — ' + esc(username) + '</h2>' +
    '<p class="muted" style="font-size:14px">Premium pengguna dicabut. Aksesori premium yang sudah dimiliki tetap tersimpan, tetapi tidak bisa dipakai selama tidak premium.</p>' +
    '<div class="modal__actions"><button class="btn btn-ghost" type="button" id="revoke-cancel">Batalkan</button>' +
    '<button class="btn btn-danger" type="button" id="revoke-ok">Ya, Cabut Premium</button></div>'
  );
  document.getElementById('revoke-cancel').addEventListener('click', closeModal);
  document.getElementById('revoke-ok').addEventListener('click', async function () {
    try {
      var out = await adminFetch('/users/' + userId + '/premium', { method: 'POST', body: { revoke: true } });
      closeModal();
      showToast((out && out.message) || 'Premium dicabut.');
      loadUsers();
    } catch (err) {
      showToast((err && err.message) || 'Gagal mencabut premium.', 'error');
    }
  });
}

/* ---------- Judul (flag admin) ---------- */
var _animeSearchTimer = null;
document.addEventListener('DOMContentLoaded', function () {
  var input = document.getElementById('anime-search');
  if (input) input.addEventListener('input', function () {
    clearTimeout(_animeSearchTimer);
    _animeSearchTimer = setTimeout(function () { loadAnimeFlags(input.value.trim()); }, 300);
  });
});

async function loadAnimeFlags(q) {
  var rows = document.getElementById('anime-rows');
  if (!q) {
    rows.innerHTML = '<tr><td colspan="7" class="muted">Ketik judul untuk mencari.</td></tr>';
    return;
  }
  rows.innerHTML = '<tr><td colspan="7" class="muted">Mencari…</td></tr>';
  try {
    var res = await searchAnime(q, { page: 1, perPage: 10 });
    if (!res.data.length) {
      rows.innerHTML = '<tr><td colspan="7" class="muted">Tidak ditemukan untuk "' + esc(q) + '".</td></tr>';
      return;
    }
    rows.innerHTML = res.data.map(function (a) {
      var score = scoreNum(a);
      return '<tr data-anime="' + esc(a.id) + '">' +
        '<td><img class="thumb" src="' + esc(a.poster || PLACEHOLDER_IMG) + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=\'' + PLACEHOLDER_IMG + '\'"></td>' +
        '<td><strong>' + esc(a.title) + '</strong></td>' +
        '<td>' + esc(a.year || '—') + '</td>' +
        '<td>' + (score != null ? score.toFixed(2) : '—') + '</td>' +
        '<td><label class="checkbox-cell"><input type="checkbox" data-flag="sub_indo" ' + (a.sub_indo ? 'checked' : '') + '> Sub Indo</label>' +
          '<p class="admin-note">Hanya centang bila sudah diverifikasi manual.</p></td>' +
        '<td><label class="checkbox-cell"><input type="checkbox" data-flag="premium_only" ' + (a.premium_only ? 'checked' : '') + '> Premium</label>' +
          '<p class="admin-note">Data saja di v1 — tidak mengunci konten.</p></td>' +
        '<td><button class="btn btn-primary btn-sm" type="button" data-save-flags="' + esc(a.id) + '">Simpan</button></td></tr>';
    }).join('');
    rows.querySelectorAll('[data-save-flags]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var tr = btn.closest('tr');
        var animeId = parseInt(btn.getAttribute('data-save-flags'), 10);
        var sub = tr.querySelector('[data-flag="sub_indo"]').checked;
        var prem = tr.querySelector('[data-flag="premium_only"]').checked;
        btn.disabled = true;
        try {
          await adminFetch('/anime/' + animeId + '/flags', { method: 'POST', body: { sub_indo: sub, premium_only: prem } });
          showToast('Perubahan judul tersimpan.');
        } catch (err) {
          showToast((err && err.message) || 'Gagal menyimpan.', 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    rows.innerHTML = '<tr><td colspan="7" class="muted">Gagal mencari: ' + esc(err.message || 'Terjadi kesalahan.') + '</td></tr>';
  }
}

/* ---------- Paket ---------- */
async function loadPlans() {
  var box = document.getElementById('plan-list');
  box.innerHTML = '<div class="skeleton" style="height:120px"></div>';
  try {
    var res = await adminFetch('/plans');
    if (!res.data.length) {
      box.innerHTML = stateHTML('empty', 'Belum ada paket', 'Buat paket pertama dengan tombol Tambah Paket di atas.');
      return;
    }
    box.innerHTML = res.data.map(function (p) {
      return '<div class="admin-panel" style="margin-bottom:12px"><div class="admin-panel__row" style="border-top:none">' +
        '<div class="grow"><strong>' + esc(p.name) + '</strong> — ' + esc(fmtRupiah(p.price_idr)) + ' · ' + esc(p.duration_days) + ' hari' +
        (p.description ? '<br><span class="muted">' + esc(p.description) + '</span>' : '') +
        '<br><span class="muted small">' + (p.active ? 'Aktif' : 'Nonaktif') + '</span></div>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-plan-edit="' + esc(p.id) + '">Ubah</button>' +
        (p.active
          ? '<button class="btn btn-danger btn-sm" type="button" data-plan-toggle="' + esc(p.id) + '" data-active="0">Nonaktifkan</button>'
          : '<button class="btn btn-primary btn-sm" type="button" data-plan-toggle="' + esc(p.id) + '" data-active="1">Aktifkan</button>') +
        '<button class="btn btn-danger btn-sm" type="button" data-plan-delete="' + esc(p.id) + '">Hapus</button>' +
      '</div></div>';
    }).join('');
    box.querySelectorAll('[data-plan-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () { planFormModal(parseInt(btn.getAttribute('data-plan-edit'), 10)); });
    });
    box.querySelectorAll('[data-plan-toggle]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = parseInt(btn.getAttribute('data-plan-toggle'), 10);
        var active = btn.getAttribute('data-active') === '1';
        try {
          await adminFetch('/plans/' + id, { method: 'PUT', body: { active: active } });
          showToast(active ? 'Paket diaktifkan.' : 'Paket dinonaktifkan.');
          loadPlans();
        } catch (err) { showToast((err && err.message) || 'Gagal mengubah paket.', 'error'); }
      });
    });
    box.querySelectorAll('[data-plan-delete]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = parseInt(btn.getAttribute('data-plan-delete'), 10);
        try {
          var out = await adminFetch('/plans/' + id, { method: 'DELETE' });
          showToast((out && out.message) || 'Paket dihapus.');
          loadPlans();
        } catch (err) { showToast((err && err.message) || 'Gagal menghapus paket.', 'error'); }
      });
    });
  } catch (err) {
    box.innerHTML = stateHTML('error', 'Paket gagal dimuat', (err && err.message) || 'Terjadi kesalahan.');
  }
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('btn-add-plan').addEventListener('click', function () { planFormModal(null); });
});

function planFormModal(planId) {
  var isNew = planId == null;
  openModal(
    '<button class="modal__close" type="button" aria-label="Tutup">×</button>' +
    '<h2>' + (isNew ? 'Tambah Paket' : 'Ubah Paket') + '</h2>' +
    '<div class="field"><label for="plan-name">Nama paket</label><input id="plan-name" type="text" placeholder="Premium 1 Bulan"></div>' +
    '<div class="field"><label for="plan-price">Harga (rupiah)</label><input id="plan-price" type="number" min="0" max="100000000" inputmode="numeric" placeholder="29000"></div>' +
    '<div class="field"><label for="plan-days">Durasi (hari)</label><input id="plan-days" type="number" min="1" max="3650" inputmode="numeric" placeholder="30"></div>' +
    '<div class="field"><label for="plan-desc">Deskripsi (opsional)</label><textarea id="plan-desc" placeholder="Manfaat paket"></textarea></div>' +
    '<p class="form-error" id="plan-error" role="alert"></p>' +
    '<div class="modal__actions"><button class="btn btn-ghost" type="button" id="plan-cancel">Batalkan</button>' +
    '<button class="btn btn-primary" type="button" id="plan-save">Simpan</button></div>'
  );
  document.getElementById('plan-cancel').addEventListener('click', closeModal);
  if (!isNew) {
    adminFetch('/plans').then(function (res) {
      var p = (res.data || []).find(function (x) { return x.id === planId; });
      if (!p) return;
      document.getElementById('plan-name').value = p.name || '';
      document.getElementById('plan-price').value = p.price_idr;
      document.getElementById('plan-days').value = p.duration_days;
      document.getElementById('plan-desc').value = p.description || '';
    }).catch(function () { /* abaikan */ });
  }
  document.getElementById('plan-save').addEventListener('click', async function () {
    var errEl = document.getElementById('plan-error');
    var body = {
      name: document.getElementById('plan-name').value.trim(),
      price_idr: parseInt(document.getElementById('plan-price').value, 10),
      duration_days: parseInt(document.getElementById('plan-days').value, 10),
      description: document.getElementById('plan-desc').value.trim() || null,
    };
    if (!body.name) { errEl.textContent = 'Nama paket wajib diisi.'; return; }
    try {
      if (isNew) await adminFetch('/plans', { method: 'POST', body: body });
      else await adminFetch('/plans/' + planId, { method: 'PUT', body: body });
      closeModal();
      showToast(isNew ? 'Paket dibuat.' : 'Paket diperbarui.');
      loadPlans();
    } catch (err) {
      errEl.textContent = (err && err.message) || 'Gagal menyimpan paket.';
    }
  });
}

/* ---------- Diskon (v1.3.0) ---------- */
var adminPlansCache = [];

async function loadDiscountPlans() {
  try {
    var res = await adminFetch('/plans');
    adminPlansCache = res.data || [];
  } catch (err) {
    adminPlansCache = [];
  }
}

function discountPlanName(planId) {
  if (planId == null) return 'Semua paket';
  var found = null;
  adminPlansCache.forEach(function (x) { if (x.id === planId) found = x; });
  return found ? found.name : 'Paket #' + planId;
}

/* Epoch detik → nilai input type="date" (YYYY-MM-DD, waktu lokal). */
function fmtDateInput(epochSec) {
  if (!epochSec) return '';
  var d = new Date(epochSec * 1000);
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

async function loadDiscounts() {
  var rows = document.getElementById('discount-rows');
  rows.innerHTML = '<tr><td colspan="7" class="muted">Memuat…</td></tr>';
  try {
    await loadDiscountPlans();
    var res = await adminFetch('/discounts');
    if (!res.data.length) {
      rows.innerHTML = '<tr><td colspan="7" class="muted">Belum ada kode diskon.</td></tr>';
      return;
    }
    rows.innerHTML = res.data.map(function (dsc) {
      return '<tr>' +
        '<td><code>' + esc(dsc.code) + '</code></td>' +
        '<td><strong>' + esc(dsc.percent) + '%</strong></td>' +
        '<td>' + esc(discountPlanName(dsc.plan_id)) + '</td>' +
        '<td>' + esc(dsc.used_count) + (dsc.max_uses ? ' / ' + esc(dsc.max_uses) : '') + '</td>' +
        '<td>' + (dsc.expires_at ? esc(fmtDate(dsc.expires_at)) : '—') + '</td>' +
        '<td>' + (dsc.active ? 'Aktif' : 'Nonaktif') + '</td>' +
        '<td class="actions">' +
          '<button class="btn btn-ghost btn-sm" type="button" data-disc-edit="' + esc(dsc.id) + '">Ubah</button>' +
          (dsc.active
            ? '<button class="btn btn-danger btn-sm" type="button" data-disc-toggle="' + esc(dsc.id) + '" data-active="0">Nonaktifkan</button>'
            : '<button class="btn btn-primary btn-sm" type="button" data-disc-toggle="' + esc(dsc.id) + '" data-active="1">Aktifkan</button>') +
          '<button class="btn btn-danger btn-sm" type="button" data-disc-delete="' + esc(dsc.id) + '">Hapus</button>' +
        '</td></tr>';
    }).join('');
    rows.querySelectorAll('[data-disc-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () { discountFormModal(parseInt(btn.getAttribute('data-disc-edit'), 10)); });
    });
    rows.querySelectorAll('[data-disc-toggle]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = parseInt(btn.getAttribute('data-disc-toggle'), 10);
        var active = btn.getAttribute('data-active') === '1';
        try {
          await adminFetch('/discounts/' + id, { method: 'PUT', body: { active: active ? 1 : 0 } });
          showToast(active ? 'Kode diskon diaktifkan.' : 'Kode diskon dinonaktifkan.');
          loadDiscounts();
        } catch (err) { showToast((err && err.message) || 'Gagal mengubah kode diskon.', 'error'); }
      });
    });
    rows.querySelectorAll('[data-disc-delete]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = parseInt(btn.getAttribute('data-disc-delete'), 10);
        try {
          var out = await adminFetch('/discounts/' + id, { method: 'DELETE' });
          showToast((out && out.message) || 'Kode diskon dihapus.');
          loadDiscounts();
        } catch (err) { showToast((err && err.message) || 'Gagal menghapus kode diskon.', 'error'); }
      });
    });
  } catch (err) {
    rows.innerHTML = '<tr><td colspan="7" class="muted">Gagal memuat kode diskon: ' + esc(err.message || 'Terjadi kesalahan.') + '</td></tr>';
  }
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('btn-add-discount').addEventListener('click', function () { discountFormModal(null); });
});

function discountFormModal(discId) {
  var isNew = discId == null;
  var planOptions = '<option value="">Semua paket</option>' + adminPlansCache.map(function (p) {
    return '<option value="' + esc(p.id) + '">' + esc(p.name) + ' — ' + esc(fmtRupiah(p.price_idr)) + '</option>';
  }).join('');
  openModal(
    '<button class="modal__close" type="button" aria-label="Tutup">×</button>' +
    '<h2>' + (isNew ? 'Tambah Kode Diskon' : 'Ubah Kode Diskon') + '</h2>' +
    '<div class="field"><label for="disc-code">Kode (3–32 huruf/angka)</label><input id="disc-code" type="text" maxlength="32" placeholder="HEMAT10" autocomplete="off" style="text-transform:uppercase"></div>' +
    '<div class="field"><label for="disc-percent">Diskon (%)</label><input id="disc-percent" type="number" min="1" max="99" inputmode="numeric" placeholder="10"></div>' +
    '<div class="field"><label for="disc-plan">Berlaku untuk paket</label><select id="disc-plan">' + planOptions + '</select></div>' +
    '<div class="field"><label for="disc-max">Maksimal pemakaian (kosong = tanpa batas)</label><input id="disc-max" type="number" min="1" inputmode="numeric" placeholder="Tanpa batas"></div>' +
    '<div class="field"><label for="disc-expires">Kedaluwarsa (kosong = tidak kedaluwarsa)</label><input id="disc-expires" type="date"></div>' +
    '<div class="field"><label class="checkbox-cell"><input type="checkbox" id="disc-active" checked> Aktif</label></div>' +
    '<p class="form-error" id="disc-error" role="alert"></p>' +
    '<div class="modal__actions"><button class="btn btn-ghost" type="button" id="disc-cancel">Batalkan</button>' +
    '<button class="btn btn-primary" type="button" id="disc-save">Simpan</button></div>'
  );
  document.getElementById('disc-cancel').addEventListener('click', closeModal);
  if (!isNew) {
    adminFetch('/discounts').then(function (res) {
      var dsc = (res.data || []).find(function (x) { return x.id === discId; });
      if (!dsc) return;
      document.getElementById('disc-code').value = dsc.code || '';
      document.getElementById('disc-percent').value = dsc.percent;
      document.getElementById('disc-plan').value = dsc.plan_id == null ? '' : String(dsc.plan_id);
      document.getElementById('disc-max').value = dsc.max_uses == null ? '' : dsc.max_uses;
      document.getElementById('disc-expires').value = fmtDateInput(dsc.expires_at);
      document.getElementById('disc-active').checked = !!dsc.active;
    }).catch(function () { /* abaikan */ });
  }
  document.getElementById('disc-save').addEventListener('click', async function () {
    var errEl = document.getElementById('disc-error');
    var code = document.getElementById('disc-code').value.trim();
    var percent = parseInt(document.getElementById('disc-percent').value, 10);
    var planVal = document.getElementById('disc-plan').value;
    var maxVal = document.getElementById('disc-max').value.trim();
    var expVal = document.getElementById('disc-expires').value;
    var body = {
      code: code,
      percent: percent,
      plan_id: planVal === '' ? null : parseInt(planVal, 10),
      max_uses: maxVal === '' ? null : parseInt(maxVal, 10),
      expires_at: expVal === '' ? null : expVal,
      active: document.getElementById('disc-active').checked ? 1 : 0,
    };
    if (!code) { errEl.textContent = 'Kode diskon wajib diisi.'; return; }
    if (!Number.isFinite(percent) || percent < 1 || percent > 99) { errEl.textContent = 'Diskon harus 1 sampai 99 persen.'; return; }
    try {
      if (isNew) await adminFetch('/discounts', { method: 'POST', body: body });
      else await adminFetch('/discounts/' + discId, { method: 'PUT', body: body });
      closeModal();
      showToast(isNew ? 'Kode diskon dibuat.' : 'Kode diskon diperbarui.');
      loadDiscounts();
    } catch (err) {
      errEl.textContent = (err && err.message) || 'Gagal menyimpan kode diskon.';
    }
  });
}

/* ---------- Aksesori ---------- */
async function loadAccessories() {
  var rows = document.getElementById('accessory-rows');
  rows.innerHTML = '<tr><td colspan="6" class="muted">Memuat…</td></tr>';
  try {
    var res = await adminFetch('/accessories');
    if (!res.data.length) {
      rows.innerHTML = '<tr><td colspan="6" class="muted">Belum ada aksesori.</td></tr>';
      return;
    }
    rows.innerHTML = res.data.map(function (a) {
      return '<tr>' +
        '<td><code>' + esc(a.code) + '</code></td>' +
        '<td><strong>' + esc(a.name) + '</strong><br><span class="muted small">' + esc(a.asset || '') + '</span></td>' +
        '<td>' + esc(a.kind) + '</td>' +
        '<td>' + (a.premium_only ? 'Ya' : 'Tidak') + '</td>' +
        '<td>' + (a.active ? 'Aktif' : 'Nonaktif') + '</td>' +
        '<td class="actions">' +
          '<button class="btn btn-ghost btn-sm" type="button" data-acc-edit="' + esc(a.id) + '">Ubah</button>' +
          '<button class="btn btn-danger btn-sm" type="button" data-acc-delete="' + esc(a.id) + '">Hapus</button>' +
        '</td></tr>';
    }).join('');
    rows.querySelectorAll('[data-acc-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () { accessoryFormModal(parseInt(btn.getAttribute('data-acc-edit'), 10)); });
    });
    rows.querySelectorAll('[data-acc-delete]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = parseInt(btn.getAttribute('data-acc-delete'), 10);
        try {
          var out = await adminFetch('/accessories/' + id, { method: 'DELETE' });
          showToast((out && out.message) || 'Aksesori dihapus.');
          loadAccessories();
        } catch (err) { showToast((err && err.message) || 'Gagal menghapus aksesori.', 'error'); }
      });
    });
  } catch (err) {
    rows.innerHTML = '<tr><td colspan="6" class="muted">Gagal memuat aksesori: ' + esc(err.message || 'Terjadi kesalahan.') + '</td></tr>';
  }
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('btn-add-accessory').addEventListener('click', function () { accessoryFormModal(null); });
});

function accessoryFormModal(accId) {
  var isNew = accId == null;
  openModal(
    '<button class="modal__close" type="button" aria-label="Tutup">×</button>' +
    '<h2>' + (isNew ? 'Tambah Aksesori' : 'Ubah Aksesori') + '</h2>' +
    '<div class="field"><label for="acc-code">Kode (huruf kecil, angka, "-")</label><input id="acc-code" type="text" placeholder="border-baru"></div>' +
    '<div class="field"><label for="acc-name">Nama</label><input id="acc-name" type="text" placeholder="Bingkai Baru"></div>' +
    '<div class="field"><label for="acc-kind">Jenis</label><select id="acc-kind">' +
      '<option value="border">Border</option><option value="background">Background</option>' +
      '<option value="frame">Bingkai Avatar</option><option value="badge">Lencana</option>' +
      '<option value="name_effect">Efek Nama</option></select></div>' +
    '<div class="field"><label for="acc-asset">Kelas CSS asset (mis. acc-border-lime-neon)</label><input id="acc-asset" type="text" placeholder="acc-"></div>' +
    '<div class="field"><label class="checkbox-cell"><input type="checkbox" id="acc-premium" checked> Premium saja</label></div>' +
    '<p class="form-error" id="acc-error" role="alert"></p>' +
    '<div class="modal__actions"><button class="btn btn-ghost" type="button" id="acc-cancel">Batalkan</button>' +
    '<button class="btn btn-primary" type="button" id="acc-save">Simpan</button></div>'
  );
  document.getElementById('acc-cancel').addEventListener('click', closeModal);
  if (!isNew) {
    adminFetch('/accessories').then(function (res) {
      var a = (res.data || []).find(function (x) { return x.id === accId; });
      if (!a) return;
      document.getElementById('acc-code').value = a.code || '';
      document.getElementById('acc-name').value = a.name || '';
      document.getElementById('acc-kind').value = a.kind || 'border';
      document.getElementById('acc-asset').value = a.asset || '';
      document.getElementById('acc-premium').checked = !!a.premium_only;
    }).catch(function () { /* abaikan */ });
  }
  document.getElementById('acc-save').addEventListener('click', async function () {
    var errEl = document.getElementById('acc-error');
    var body = {
      code: document.getElementById('acc-code').value.trim(),
      name: document.getElementById('acc-name').value.trim(),
      kind: document.getElementById('acc-kind').value,
      asset: document.getElementById('acc-asset').value.trim() || null,
      premium_only: document.getElementById('acc-premium').checked ? 1 : 0,
    };
    try {
      if (isNew) await adminFetch('/accessories', { method: 'POST', body: body });
      else await adminFetch('/accessories/' + accId, { method: 'PUT', body: body });
      closeModal();
      showToast(isNew ? 'Aksesori dibuat.' : 'Aksesori diperbarui.');
      loadAccessories();
    } catch (err) {
      errEl.textContent = (err && err.message) || 'Gagal menyimpan aksesori.';
    }
  });
}

/* ---------- Pengaturan ---------- */
var QRIS_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
var QRIS_IMAGE_MAX = 2 * 1024 * 1024;
var qrisNewImage = null;

async function loadSettings() {
  try {
    var res = await adminFetch('/settings');
    var d = res.data || {};
    document.getElementById('set-premium-days').value = d.premium_new_days || '7';
    document.getElementById('set-payment-methods').value = d.payment_methods || '';
    document.getElementById('set-payment-gateway').value = d.payment_gateway === 'midtrans' ? 'midtrans' : 'manual';
  } catch (err) {
    document.getElementById('settings-error').textContent = (err && err.message) || 'Pengaturan gagal dimuat.';
  }
  loadQrisConfig();
}

/* Konfigurasi QRIS saat ini + pratinjau gambar yang tersimpan.
   <img src> same-origin: cookie sesi admin terkirim; tambah penanda
   waktu supaya gambar baru tidak tertukar dengan gambar lama. */
async function loadQrisConfig() {
  var statusEl = document.getElementById('admin-qris-status');
  var figure = document.getElementById('admin-qris-figure');
  var img = document.getElementById('admin-qris-img');
  var merchant = document.getElementById('admin-qris-merchant');
  try {
    var res = await adminFetch('/settings/qris');
    var d = res.data || {};
    document.getElementById('set-qris-merchant').value = d.merchant_name || '';
    if (d.has_qris) {
      img.src = adminBase() + '/settings/qris/image?t=' + Date.now();
      merchant.textContent = d.merchant_name ? 'Merchant: ' + d.merchant_name : '';
      figure.hidden = false;
      statusEl.textContent = 'Kode QRIS sudah tersimpan dan tampil di halaman Premium saat cara bayar utama adalah QRIS Manual.';
    } else {
      figure.hidden = true;
      statusEl.textContent = 'Belum ada kode QRIS yang tersimpan.';
    }
  } catch (err) {
    figure.hidden = true;
    statusEl.textContent = 'Konfigurasi QRIS gagal dimuat: ' + ((err && err.message) || 'Terjadi kesalahan.');
  }
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('btn-save-settings').addEventListener('click', async function () {
    var errEl = document.getElementById('settings-error');
    var okEl = document.getElementById('settings-success');
    errEl.textContent = '';
    okEl.textContent = '';
    try {
      await adminFetch('/settings', { method: 'PUT', body: { key: 'premium_new_days', value: document.getElementById('set-premium-days').value } });
      await adminFetch('/settings', { method: 'PUT', body: { key: 'payment_methods', value: document.getElementById('set-payment-methods').value } });
      await adminFetch('/settings', { method: 'PUT', body: { key: 'payment_gateway', value: document.getElementById('set-payment-gateway').value } });
      okEl.textContent = 'Pengaturan disimpan.';
    } catch (err) {
      errEl.textContent = (err && err.message) || 'Gagal menyimpan pengaturan.';
    }
  });
  var qrisFile = document.getElementById('set-qris-image');
  if (qrisFile) qrisFile.addEventListener('change', function () {
    var preview = document.getElementById('admin-qris-preview');
    var errEl = document.getElementById('qris-error');
    qrisNewImage = null;
    if (preview) { preview.hidden = true; preview.removeAttribute('src'); }
    if (errEl) errEl.textContent = '';
    var f = qrisFile.files && qrisFile.files[0];
    if (!f) return;
    if (QRIS_IMAGE_TYPES.indexOf(f.type) === -1) {
      if (errEl) errEl.textContent = 'Gambar kode QRIS harus JPG, PNG, atau WebP.';
      qrisFile.value = '';
      return;
    }
    if (f.size > QRIS_IMAGE_MAX) {
      if (errEl) errEl.textContent = 'Ukuran gambar kode QRIS maksimal 2 MB.';
      qrisFile.value = '';
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      qrisNewImage = reader.result;
      if (preview) { preview.src = reader.result; preview.hidden = false; }
    };
    reader.onerror = function () {
      if (errEl) errEl.textContent = 'Gambar gagal dibaca. Coba pilih file lain.';
      qrisFile.value = '';
    };
    reader.readAsDataURL(f);
  });
  document.getElementById('btn-save-qris').addEventListener('click', async function () {
    var errEl = document.getElementById('qris-error');
    var okEl = document.getElementById('qris-success');
    var btn = document.getElementById('btn-save-qris');
    errEl.textContent = '';
    okEl.textContent = '';
    var merchantName = document.getElementById('set-qris-merchant').value.trim();
    if (!merchantName && !qrisNewImage) {
      errEl.textContent = 'Isi nama merchant dan/atau pilih gambar kode QRIS.';
      return;
    }
    btn.disabled = true;
    try {
      var body = {};
      if (merchantName) body.merchant_name = merchantName;
      if (qrisNewImage) body.image = qrisNewImage;
      var out = await adminFetch('/settings/qris', { method: 'POST', body: body });
      okEl.textContent = (out && out.message) || 'Kode QRIS disimpan.';
      qrisNewImage = null;
      document.getElementById('set-qris-image').value = '';
      var preview = document.getElementById('admin-qris-preview');
      if (preview) { preview.hidden = true; preview.removeAttribute('src'); }
      loadQrisConfig();
    } catch (err) {
      errEl.textContent = (err && err.message) || 'Gagal menyimpan kode QRIS.';
    } finally {
      btn.disabled = false;
    }
  });
});

/* ---------- Audit ---------- */
async function loadAudit() {
  var rows = document.getElementById('audit-rows');
  rows.innerHTML = '<tr><td colspan="5" class="muted">Memuat…</td></tr>';
  try {
    var res = await adminFetch('/audit?page=' + adminState.auditPage + '&per_page=20');
    adminState.auditPages = (res.pagination && res.pagination.total_pages) || 1;
    if (!res.data.length) {
      rows.innerHTML = '<tr><td colspan="5" class="muted">Belum ada aktivitas tercatat.</td></tr>';
    } else {
      rows.innerHTML = res.data.map(function (r) {
        return '<tr><td>' + esc(fmtDateTime(r.created_at)) + '</td>' +
          '<td>' + esc(r.admin_username || '—') + '</td>' +
          '<td><strong>' + esc(r.action) + '</strong></td>' +
          '<td>' + esc((r.target_type || '') + (r.target_id ? ' #' + r.target_id : '')) + '</td>' +
          '<td class="muted small">' + esc(r.detail || '') + '</td></tr>';
      }).join('');
    }
    var pag = document.getElementById('audit-pagination');
    pag.hidden = adminState.auditPages <= 1;
    document.getElementById('audit-page-info').textContent = 'Halaman ' + adminState.auditPage + ' dari ' + adminState.auditPages;
    document.getElementById('audit-prev').disabled = adminState.auditPage <= 1;
    document.getElementById('audit-next').disabled = adminState.auditPage >= adminState.auditPages;
  } catch (err) {
    rows.innerHTML = '<tr><td colspan="5" class="muted">Gagal memuat log: ' + esc(err.message || 'Terjadi kesalahan.') + '</td></tr>';
  }
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('audit-prev').addEventListener('click', function () { adminState.auditPage = Math.max(1, adminState.auditPage - 1); loadAudit(); });
  document.getElementById('audit-next').addEventListener('click', function () { adminState.auditPage = Math.min(adminState.auditPages, adminState.auditPage + 1); loadAudit(); });
});
