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
  pengguna: 'Pengguna',
  judul: 'Judul',
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
  if (name === 'pengguna') loadUsers();
  if (name === 'audit') loadAudit();
}

/* ---------- Ringkasan ---------- */
async function loadSummary() {
  try {
    var s = await adminFetch('/summary');
    var d = s.data;
    document.getElementById('summary-cards').innerHTML =
      '<div class="admin-card"><p class="admin-card__label">Pengguna</p><p class="admin-card__num">' + esc(d.users) + '</p></div>' +
      '<div class="admin-card"><p class="admin-card__label">Judul di Katalog</p><p class="admin-card__num">' + esc(d.catalog_titles) + '</p></div>';
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
  rows.innerHTML = '<tr><td colspan="4" class="muted">Memuat…</td></tr>';
  try {
    var res = await adminFetch('/users?search=' + encodeURIComponent(adminState.userSearch) + '&page=' + adminState.userPage + '&per_page=20');
    adminState.userPages = (res.pagination && res.pagination.total_pages) || 1;
    if (!res.data.length) {
      rows.innerHTML = '<tr><td colspan="4" class="muted">Tidak ada pengguna yang cocok.</td></tr>';
    } else {
      rows.innerHTML = res.data.map(function (u) {
        return '<tr>' +
          '<td><strong>' + esc(u.username) + '</strong>' + (u.role === 'admin' ? ' <span class="chip-status chip-status--admin">ADMIN</span>' : '') + '</td>' +
          '<td>' + esc(u.email || '—') + '</td>' +
          '<td>' + levelCellHTML(u) + '</td>' +
          '<td>' + esc(fmtDate(u.created_at)) + '</td></tr>';
      }).join('');
    }
    var pag = document.getElementById('user-pagination');
    pag.hidden = adminState.userPages <= 1;
    document.getElementById('user-page-info').textContent = 'Halaman ' + adminState.userPage + ' dari ' + adminState.userPages;
    document.getElementById('user-prev').disabled = adminState.userPage <= 1;
    document.getElementById('user-next').disabled = adminState.userPage >= adminState.userPages;
  } catch (err) {
    rows.innerHTML = '<tr><td colspan="4" class="muted">Gagal memuat pengguna: ' + esc(err.message || 'Terjadi kesalahan.') + '</td></tr>';
  }
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
    rows.innerHTML = '<tr><td colspan="6" class="muted">Ketik judul untuk mencari.</td></tr>';
    return;
  }
  rows.innerHTML = '<tr><td colspan="6" class="muted">Mencari…</td></tr>';
  try {
    var res = await searchAnime(q, { page: 1, perPage: 10 });
    if (!res.data.length) {
      rows.innerHTML = '<tr><td colspan="6" class="muted">Tidak ditemukan untuk "' + esc(q) + '".</td></tr>';
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
        '<td><button class="btn btn-primary btn-sm" type="button" data-save-flags="' + esc(a.id) + '">Simpan</button></td></tr>';
    }).join('');
    rows.querySelectorAll('[data-save-flags]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var tr = btn.closest('tr');
        var animeId = parseInt(btn.getAttribute('data-save-flags'), 10);
        var sub = tr.querySelector('[data-flag="sub_indo"]').checked;
        btn.disabled = true;
        try {
          await adminFetch('/anime/' + animeId + '/flags', { method: 'POST', body: { sub_indo: sub } });
          showToast('Perubahan judul tersimpan.');
        } catch (err) {
          showToast((err && err.message) || 'Gagal menyimpan.', 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    rows.innerHTML = '<tr><td colspan="6" class="muted">Gagal mencari: ' + esc(err.message || 'Terjadi kesalahan.') + '</td></tr>';
  }
}

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
