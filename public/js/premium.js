/* ============================================================
   premium.js — Halaman paket Premium Mitsunime (task-12, v1.1.0)
   Paket dari /api/plans. Cara bayar dibaca dari
   GET /api/premium/qris (payment_gateway: 'manual' atau
   'midtrans'):
   - MANUAL (utama): pilih paket → tampilkan kode QRIS admin →
     pengguna bayar dengan memindai QRIS → isi referensi/nama
     pengirim (opsional) + unggah bukti (opsional, JPG/PNG/WebP
     maks. 2 MB) → kirim transaksi → MENUNGGU persetujuan admin.
     TIDAK ada tautan bayar Midtrans dan TIDAK ada tombol Cek
     Status untuk transaksi manual (confirm hanya untuk Midtrans).
   - MIDTRANS (opsi): pilih paket → buat transaksi Midtrans →
     buka halaman bayar → kembali → Cek Status Pembayaran → bila
     paid, menunggu persetujuan admin.
   Pembayaran TIDAK langsung mengaktifkan Premium di kedua alur.
   Copy jujur: Premium = aksesori profil saja. TIDAK ada janji
   "episode terbaru tanpa menunggu" atau "judul premium terbuka" —
   semua episode bisa ditonton pengguna login, premium atau bukan.
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  mountChrome('home');
  loadPremiumPage();
});

var currentTx = null;
/* v1.1.0: cara bayar aktif ('manual' default) + info QRIS + paket
   yang dipilih untuk transaksi manual + bukti (data URL) yang dipilih. */
var gatewayMode = 'manual';
var qrisInfo = null;
var plansCache = [];
var manualPlan = null;
var manualProofDataUrl = null;
/* v1.3.0: paket yang dipilih untuk transaksi berjalan + kode diskon
   yang sudah dicek ke server (null bila tanpa kode). Kode direset
   setiap kali paket diganti — kode bisa saja hanya berlaku untuk
   paket tertentu. */
var discountPlan = null;
var appliedDiscount = null;

async function loadPremiumPage() {
  var me = await currentUser();
  if (!me) {
    document.getElementById('plan-grid').innerHTML =
      stateHTML('empty', 'Masuk dulu untuk berlangganan', 'Paket Premium bisa dibeli setelah masuk. Masuk atau daftar dulu — gratis.', 'Masuk / Daftar', '/account.html?mode=login');
    return;
  }
  renderStatus(me);
  loadQrisInfo();
  loadPlans();
  loadMyTx();
}

/* Info bayar manual menentukan alur yang ditampilkan. Bila gagal
   dimuat (mis. server belum v1.1.0), pakai 'manual' sebagai default
   yang aman: alur manual tidak butuh kunci gateway apa pun. */
async function loadQrisInfo() {
  try {
    var res = await apiQrisInfo();
    qrisInfo = (res && res.data) || null;
    if (qrisInfo && qrisInfo.payment_gateway === 'midtrans') gatewayMode = 'midtrans';
    else gatewayMode = 'manual';
  } catch (err) {
    gatewayMode = 'manual';
    qrisInfo = null;
  }
}

function renderStatus(me) {
  var el = document.getElementById('premium-status');
  var premium = me.premium || { is_premium: 0, premium_until: null, days_left: 0 };
  if (premium.is_premium === 1) {
    el.innerHTML = '<div class="banner"><span>Akun kamu sudah <strong>Premium</strong> sampai ' + esc(fmtDate(premium.premium_until)) + ' (' + esc(premium.days_left) + ' hari lagi). Aksesori premium bisa dipakai dari halaman Akun.</span></div>';
  } else {
    el.innerHTML = '<div class="banner"><span>Akun kamu masih <strong>Gratis</strong>. Premium memberi aksesori profil eksklusif — tanpa mengunci konten apa pun.</span></div>';
  }
}

var PREMIUM_BENEFITS = [
  'Semua aksesori profil premium (border, background, bingkai avatar, lencana, efek nama)',
  'Lencana Premium di profil kamu',
  'Mendukung Mitsunime tetap berjalan',
];

/* Label jenis aksesori untuk daftar benefit per paket (v1.2.0 tiering).
   Nama aksesori di API sudah membawa awalan jenisnya ("Bingkai Lime
   Neon", "Latar Lime", "Bingkai Avatar Pochita"); awalan itu dipangkas
   saat diringkas supaya satu jenis muat dalam satu baris ("Bingkai:
   Lime Neon, Emas, Gelap"). Awalan dicocokkan tanpa peduli huruf
   besar/kecil karena nama memakai "Bingkai Avatar"/"Efek Nama"
   sedangkan label tampil memakai "Bingkai avatar"/"Efek nama". Bila
   nama tidak berawalan jenisnya, nama dipakai utuh. */
var PLAN_KIND_LABELS = {
  border: 'Bingkai',
  background: 'Latar profil',
  frame: 'Bingkai avatar',
  badge: 'Lencana',
  name_effect: 'Efek nama',
};
var PLAN_KIND_STRIP = {
  border: 'Bingkai ',
  background: 'Latar ',
  frame: 'Bingkai Avatar ',
  badge: 'Lencana ',
  name_effect: 'Efek Nama ',
};
var PLAN_KIND_ORDER = ['border', 'background', 'frame', 'badge', 'name_effect'];

function shortAccessoryName(acc) {
  var prefix = PLAN_KIND_STRIP[acc.kind] || '';
  var name = acc.name || '';
  if (prefix && name.toLowerCase().indexOf(prefix.toLowerCase()) === 0) return name.slice(prefix.length);
  return name;
}

/* Susun <li> benefit dari data API (bukan hardcode): deskripsi paket,
   lalu satu baris per jenis aksesori, lalu baris dukungan. Bila API
   belum mengirim accessories (server lama), kembali ke daftar generik
   lama supaya halaman tidak kosong. */
function planBenefitItems(plan) {
  var items = [];
  if (plan.description) items.push('<li>' + esc(plan.description) + '</li>');
  var accs = Array.isArray(plan.accessories) ? plan.accessories : [];
  if (accs.length) {
    PLAN_KIND_ORDER.forEach(function (kind) {
      var names = [];
      accs.forEach(function (a) { if (a && a.kind === kind) names.push(shortAccessoryName(a)); });
      if (names.length) {
        items.push('<li><span class="plan-benefits__kind">' + esc(PLAN_KIND_LABELS[kind]) + '</span> ' +
          names.map(function (n) { return esc(n); }).join(', ') + '</li>');
      }
    });
    /* Jenis yang tidak dikenal (mis. aksesori baru dari admin) tetap
       ditampilkan apa adanya, jangan dihilangkan diam-diam. */
    accs.forEach(function (a) {
      if (a && PLAN_KIND_ORDER.indexOf(a.kind) === -1) {
        items.push('<li>' + esc(a.name || '') + '</li>');
      }
    });
    items.push('<li>Mendukung Mitsunime tetap berjalan</li>');
    return items;
  }
  var rest = plan.description ? PREMIUM_BENEFITS.slice(1) : PREMIUM_BENEFITS;
  rest.forEach(function (b) { items.push('<li>' + esc(b) + '</li>'); });
  return items;
}

async function loadPlans() {
  var grid = document.getElementById('plan-grid');
  grid.innerHTML = '<div class="skeleton" style="height:220px"></div><div class="skeleton" style="height:220px"></div>';
  try {
    var res = await apiPlans();
    if (!res.data.length) {
      grid.innerHTML = stateHTML('empty', 'Belum ada paket', 'Saat ini belum ada paket Premium yang aktif. Coba lagi nanti.');
      return;
    }
    plansCache = res.data;
    /* Urutkan dari durasi terpendek ke terpanjang (7, 15, 30 hari)
       supaya kartu tersusun sebagai tangga harga; badge "Paling
       Populer" selalu menempel pada paket 30 hari (bila tidak ada,
       pada paket termahal). Urutan API (harga) tidak diandalkan. */
    plansCache.sort(function (a, b) { return (a.duration_days || 0) - (b.duration_days || 0); });
    var popular = null;
    plansCache.forEach(function (p) { if (p.duration_days === 30) popular = p; });
    if (!popular) popular = plansCache[plansCache.length - 1];
    grid.innerHTML = plansCache.map(function (plan) {
      var isPopular = popular && plan.id === popular.id;
      return '<article class="plan-card' + (isPopular ? ' plan-card--popular' : '') + '">' +
        (isPopular ? '<span class="plan-pop">Paling Populer</span>' : '') +
        '<h3>' + esc(plan.name) + '</h3>' +
        '<div class="plan-price">' + esc(fmtRupiah(plan.price_idr)) + '</div>' +
        '<div class="plan-duration">' + esc(plan.duration_days) + ' hari</div>' +
        '<ul class="plan-benefits">' + planBenefitItems(plan).join('') + '</ul>' +
        '<button class="btn btn-primary btn-block" type="button" data-plan="' + esc(plan.id) + '">Pilih Paket</button>' +
      '</article>';
    }).join('');
    grid.querySelectorAll('[data-plan]').forEach(function (btn) {
      btn.addEventListener('click', function () { choosePlan(parseInt(btn.getAttribute('data-plan'), 10), btn); });
    });
  } catch (err) {
    grid.innerHTML = stateHTML('error', 'Paket gagal dimuat', (err && err.message) || 'Terjadi kesalahan.', 'Muat Ulang', window.location.href);
  }
}

async function createTx(planId, discountCode, btn) {
  var errEl = document.getElementById('pay-error');
  var msgEl = document.getElementById('pay-message');
  errEl.textContent = '';
  msgEl.textContent = '';
  if (btn) btn.disabled = true;
  try {
    var out = await apiCreateTransaction(planId, discountCode);
    currentTx = out.transaction;
    showPayBox(out);
    loadMyTx();
    showToast((out && out.message) || 'Transaksi dibuat.');
  } catch (err) {
    /* Kotak bayar Midtrans tersembunyi secara bawaan — tampilkan agar
       pesan galat bisa dibaca (bukan hanya lewat toast 4 detik).
       Tautan bayar disembunyikan: tidak ada transaksi yang dibuat. */
    var sec = document.getElementById('pay-section');
    var mid = document.getElementById('pay-midtrans');
    var manual = document.getElementById('pay-manual');
    var link = document.getElementById('btn-pay-link');
    if (sec) sec.hidden = false;
    if (mid) mid.hidden = false;
    if (manual) manual.hidden = true;
    if (link) link.hidden = true;
    if (err && err.status === 503) {
      errEl.textContent = (err && err.message) || 'Pembayaran belum dikonfigurasi di server. Hubungi admin.';
      showToast('Pembayaran belum dikonfigurasi di server.', 'error');
    } else {
      errEl.textContent = (err && err.message) || 'Gagal membuat transaksi.';
      showToast((err && err.message) || 'Gagal membuat transaksi.', 'error');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* Pilih paket: kode diskon dicek SEBELUM transaksi dibuat (v1.3.0).
   Alur Midtrans tidak lagi membuat transaksi langsung saat paket
   diklik — pengguna melihat harga setelah diskon dulu, lalu menekan
   "Lanjut ke Pembayaran". Alur manual memakai kotak diskon yang sama;
   transaksi manual dibuat saat formulir dikirim. */
function choosePlan(planId, btn) {
  var plan = null;
  plansCache.forEach(function (p) { if (p.id === planId) plan = p; });
  if (!plan) { showToast('Paket tidak ditemukan.', 'error'); return; }
  discountPlan = plan;
  appliedDiscount = null;
  showDiscountBox(plan, gatewayMode === 'midtrans');
  if (gatewayMode === 'midtrans') return;
  showManualBox(plan);
}

/* ---------- Kode diskon (v1.3.0) ---------- */
function showDiscountBox(plan, withContinue) {
  var sec = document.getElementById('pay-section');
  var box = document.getElementById('discount-box');
  sec.hidden = false;
  box.hidden = false;
  document.getElementById('discount-plan-line').textContent =
    'Paket: ' + (plan.name || 'Paket Premium') + ' — ' + fmtRupiah(plan.price_idr) + ' · ' + plan.duration_days + ' hari';
  document.getElementById('discount-code').value = '';
  document.getElementById('discount-success').textContent = '';
  document.getElementById('discount-error').textContent = '';
  document.getElementById('btn-clear-discount').hidden = true;
  /* Tombol lanjut hanya untuk Midtrans (transaksi dibuat dari sini);
     alur manual memakai tombol "Kirim Transaksi" di kotaknya. */
  document.getElementById('btn-discount-continue').hidden = !withContinue;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function discountPriceLine() {
  if (!discountPlan) return '';
  if (!appliedDiscount) return 'Jumlah: ' + fmtRupiah(discountPlan.price_idr);
  return 'Jumlah: ' + fmtRupiah(appliedDiscount.final_price) +
    ' (diskon ' + appliedDiscount.code + ' ' + appliedDiscount.percent + '% dari ' + fmtRupiah(appliedDiscount.original_price) + ')';
}

/* Perbarui teks jumlah di kotak bayar yang sedang tampil supaya harga
   setelah diskon terlihat sebelum transaksi dibuat. */
function refreshDiscountPriceText() {
  if (!discountPlan) return;
  var manual = document.getElementById('pay-manual');
  if (manual && !manual.hidden) {
    document.getElementById('manual-desc').textContent = discountPriceLine() + ' · Durasi: ' + discountPlan.duration_days + ' hari';
  }
}

async function applyDiscount() {
  var errEl = document.getElementById('discount-error');
  var okEl = document.getElementById('discount-success');
  errEl.textContent = '';
  okEl.textContent = '';
  if (!discountPlan) return;
  var code = document.getElementById('discount-code').value.trim();
  if (!code) { errEl.textContent = 'Isi kode diskon dulu.'; return; }
  var btn = document.getElementById('btn-apply-discount');
  btn.disabled = true;
  try {
    var out = await apiValidateDiscount(discountPlan.id, code);
    appliedDiscount = { code: out.code, percent: out.percent, original_price: out.original_price, final_price: out.final_price };
    var saved = out.original_price - out.final_price;
    okEl.textContent = 'Kode ' + out.code + ' dipakai: ' + fmtRupiah(out.original_price) + ' → ' + fmtRupiah(out.final_price) + ' (hemat ' + fmtRupiah(saved) + ').';
    document.getElementById('btn-clear-discount').hidden = false;
    refreshDiscountPriceText();
  } catch (err) {
    /* Kode salah/kadaluarsa/habis/bukan untuk paket ini — pesan server
       yang tampil, kode sebelumnya (bila ada) dibatalkan. */
    appliedDiscount = null;
    document.getElementById('btn-clear-discount').hidden = true;
    refreshDiscountPriceText();
    errEl.textContent = (err && err.message) || 'Kode diskon tidak valid.';
  } finally {
    btn.disabled = false;
  }
}

function clearDiscount() {
  appliedDiscount = null;
  document.getElementById('discount-code').value = '';
  document.getElementById('discount-success').textContent = '';
  document.getElementById('discount-error').textContent = '';
  document.getElementById('btn-clear-discount').hidden = true;
  refreshDiscountPriceText();
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('btn-apply-discount').addEventListener('click', function () { applyDiscount(); });
  document.getElementById('btn-clear-discount').addEventListener('click', function () { clearDiscount(); });
  var lanjut = document.getElementById('btn-discount-continue');
  lanjut.addEventListener('click', function () {
    if (!discountPlan) return;
    createTx(discountPlan.id, appliedDiscount ? appliedDiscount.code : null, lanjut);
  });
});

/* ---------- Alur manual QRIS (v1.1.0) ---------- */
var MANUAL_PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
var MANUAL_PROOF_MAX = 2 * 1024 * 1024;

function showManualBox(plan) {
  manualPlan = plan;
  manualProofDataUrl = null;
  var sec = document.getElementById('pay-section');
  var mid = document.getElementById('pay-midtrans');
  var box = document.getElementById('pay-manual');
  if (mid) mid.hidden = true;
  sec.hidden = false;
  box.hidden = false;
  document.getElementById('manual-title').textContent = 'Bayar dengan QRIS — ' + (plan.name || 'Paket Premium');
  document.getElementById('manual-desc').textContent = 'Jumlah: ' + fmtRupiah(plan.price_idr) + ' · Durasi: ' + plan.duration_days + ' hari';
  document.getElementById('manual-message').textContent = '';
  document.getElementById('manual-error').textContent = '';
  var ref = document.getElementById('manual-proof-ref');
  if (ref) ref.value = '';
  var file = document.getElementById('manual-proof-file');
  if (file) file.value = '';
  var preview = document.getElementById('manual-proof-preview');
  if (preview) { preview.hidden = true; preview.removeAttribute('src'); }
  var submit = document.getElementById('btn-manual-submit');
  var missing = document.getElementById('manual-qris-missing');
  var figure = document.getElementById('manual-qris-figure');
  var merchant = document.getElementById('manual-qris-merchant');
  var img = document.getElementById('manual-qris-img');
  if (qrisInfo && qrisInfo.merchant_name) merchant.textContent = 'Merchant: ' + qrisInfo.merchant_name;
  else merchant.textContent = '';
  if (qrisInfo && qrisInfo.has_qris) {
    /* <img src> same-origin: cookie sesi terkirim, gambar dibaca lewat
       endpoint ber-login (bukan file statis publik). */
    if (img) img.src = '/api/premium/qris/image';
    if (figure) figure.hidden = false;
    if (missing) missing.hidden = true;
    if (submit) submit.disabled = false;
  } else {
    if (figure) figure.hidden = true;
    if (missing) missing.hidden = false;
    if (submit) submit.disabled = true;
  }
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.addEventListener('DOMContentLoaded', function () {
  var file = document.getElementById('manual-proof-file');
  if (file) file.addEventListener('change', function () {
    var preview = document.getElementById('manual-proof-preview');
    var errEl = document.getElementById('manual-error');
    manualProofDataUrl = null;
    if (preview) { preview.hidden = true; preview.removeAttribute('src'); }
    if (errEl) errEl.textContent = '';
    var f = file.files && file.files[0];
    if (!f) return;
    if (MANUAL_PROOF_TYPES.indexOf(f.type) === -1) {
      if (errEl) errEl.textContent = 'Bukti harus berupa gambar JPG, PNG, atau WebP.';
      file.value = '';
      return;
    }
    if (f.size > MANUAL_PROOF_MAX) {
      if (errEl) errEl.textContent = 'Ukuran bukti maksimal 2 MB.';
      file.value = '';
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      manualProofDataUrl = reader.result;
      if (preview) { preview.src = reader.result; preview.hidden = false; }
    };
    reader.onerror = function () {
      if (errEl) errEl.textContent = 'Bukti gagal dibaca. Coba pilih file lain.';
      file.value = '';
    };
    reader.readAsDataURL(f);
  });
  var form = document.getElementById('form-manual-tx');
  if (form) form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!manualPlan) return;
    var msgEl = document.getElementById('manual-message');
    var errEl = document.getElementById('manual-error');
    var submit = document.getElementById('btn-manual-submit');
    msgEl.textContent = '';
    errEl.textContent = '';
    submit.disabled = true;
    try {
      var ref = document.getElementById('manual-proof-ref').value.trim();
      var out = await apiCreateManualTransaction(manualPlan.id, ref, manualProofDataUrl, appliedDiscount ? appliedDiscount.code : null);
      currentTx = out.transaction;
      msgEl.textContent = (out && out.message) || 'Transaksi manual dibuat. Menunggu persetujuan admin.';
      showToast(msgEl.textContent);
      var dbox = document.getElementById('discount-box');
      if (dbox) dbox.hidden = true;
      loadMyTx();
      var me = await currentUser();
      renderStatus(me);
    } catch (err) {
      errEl.textContent = (err && err.message) || 'Gagal membuat transaksi manual.';
      showToast((err && err.message) || 'Gagal membuat transaksi manual.', 'error');
    } finally {
      submit.disabled = false;
    }
  });
});

function showPayBox(out) {
  var tx = out.transaction;
  var pay = out.payment || {};
  var sec = document.getElementById('pay-section');
  var manual = document.getElementById('pay-manual');
  if (manual) manual.hidden = true;
  var dbox = document.getElementById('discount-box');
  if (dbox) dbox.hidden = true;
  var mid = document.getElementById('pay-midtrans');
  if (mid) mid.hidden = false;
  var link = document.getElementById('btn-pay-link');
  var msgEl = document.getElementById('pay-message');
  var errEl = document.getElementById('pay-error');
  sec.hidden = false;
  document.getElementById('pay-title').textContent = 'Selesaikan Pembayaran — ' + (tx.plan_name || 'Paket Premium');
  document.getElementById('pay-desc').textContent = 'Jumlah: ' + fmtRupiah(tx.amount_idr) +
    (tx.original_amount_idr && tx.original_amount_idr !== tx.amount_idr
      ? ' (diskon ' + (tx.discount_code || '') + ' ' + (tx.discount_percent || '') + '% dari ' + fmtRupiah(tx.original_amount_idr) + ')' : '') +
    ' · Order: ' + (tx.gateway_order_id || ('#' + tx.id));
  if (pay.redirect_url || tx.payment_url) {
    link.href = pay.redirect_url || tx.payment_url;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
  msgEl.textContent = (out && out.message) || '';
  errEl.textContent = '';
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.addEventListener('DOMContentLoaded', function () {
  var btn = document.getElementById('btn-confirm-pay');
  if (btn) btn.addEventListener('click', async function () {
    if (!currentTx) return;
    var msgEl = document.getElementById('pay-message');
    var errEl = document.getElementById('pay-error');
    btn.disabled = true;
    try {
      var out = await apiConfirmTransaction(currentTx.id);
      currentTx = out.transaction;
      msgEl.textContent = (out && out.message) || 'Status pembayaran diperbarui.';
      errEl.textContent = '';
      showToast(msgEl.textContent);
      loadMyTx();
      var me = await currentUser();
      renderStatus(me);
    } catch (err) {
      errEl.textContent = (err && err.message) || 'Gagal mengecek status pembayaran.';
    } finally {
      btn.disabled = false;
    }
  });
});

async function loadMyTx() {
  var sec = document.getElementById('sec-my-tx');
  var list = document.getElementById('tx-list');
  if (!sec || !list) return;
  try {
    var res = await apiMyTransactions();
    if (!res.data.length) { sec.hidden = true; return; }
    sec.hidden = false;
    list.innerHTML = res.data.map(function (tx) {
      var cls = tx.status === 'approved' ? 'tx-row--ok' : tx.status === 'rejected' ? 'tx-row--no' : 'tx-row--wait';
      var statusChip = tx.status === 'approved' ? '<span class="chip-status chip-status--ok">DISETUJUI</span>'
        : tx.status === 'rejected' ? '<span class="chip-status chip-status--no">DITOLAK</span>'
        : '<span class="chip-status chip-status--wait">MENUNGGU</span>';
      var isManual = tx.method === 'manual_qris';
      /* Transaksi manual: payment_status SELALU 'unpaid' (tidak ada
         gateway yang memverifikasi) — itu keadaan normal, bukan
         "belum dibayar". Tampilkan status persetujuan admin, bukan
         status gateway. */
      var payChip;
      if (isManual) {
        payChip = tx.status === 'approved' ? '<span class="chip-status chip-status--paid">DIVERIFIKASI ADMIN</span>'
          : tx.status === 'rejected' ? '<span class="chip-status chip-status--unpaid">DITOLAK</span>'
          : '<span class="chip-status chip-status--wait">MENUNGGU PERSETUJUAN</span>';
      } else {
        payChip = tx.payment_status === 'paid' ? '<span class="chip-status chip-status--paid">SUDAH DIBAYAR</span>'
          : tx.payment_status === 'expired' ? '<span class="chip-status chip-status--unpaid">KADALUARSA</span>'
          : tx.payment_status === 'failed' ? '<span class="chip-status chip-status--unpaid">GAGAL</span>'
          : '<span class="chip-status chip-status--unpaid">BELUM DIBAYAR</span>';
      }
      var methodLabel = isManual ? 'QRIS Manual' : (tx.method || 'midtrans');
      var actions = '';
      /* Tombol Bayar / Cek Status hanya untuk Midtrans (punya
         payment_url). Transaksi manual tidak punya keduanya: bayar
         lewat QRIS, lalu menunggu persetujuan admin. */
      if (tx.status === 'pending' && tx.payment_status === 'unpaid' && tx.payment_url) {
        actions = '<a class="btn btn-primary btn-sm" href="' + esc(tx.payment_url) + '" target="_blank" rel="noopener">Bayar</a>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-confirm-tx="' + esc(tx.id) + '">Cek Status</button>';
      }
      return '<div class="tx-row ' + cls + '"><div class="tx-row__body">' +
        '<p class="tx-row__title">' + esc(tx.plan_name || 'Paket Premium') + ' — ' + esc(fmtRupiah(tx.amount_idr)) + '</p>' +
        '<p class="tx-row__meta">' + esc(fmtDateTime(tx.created_at)) + ' · ' + esc(methodLabel) + (tx.has_proof ? ' · Ada bukti bayar' : '') + '</p>' +
        /* v1.3.0: harga asli + kode diskon bila transaksi memakai kode. */
        (tx.original_amount_idr && tx.original_amount_idr !== tx.amount_idr
          ? '<p class="tx-row__meta">Diskon ' + esc(tx.discount_code || '') + ' (' + esc(tx.discount_percent) + '%): dari ' + esc(fmtRupiah(tx.original_amount_idr)) + '</p>' : '') +
        (tx.proof_ref ? '<p class="tx-row__meta">Referensi: ' + esc(tx.proof_ref) + '</p>' : '') +
        (tx.note ? '<p class="tx-row__note">Catatan admin: ' + esc(tx.note) + '</p>' : '') +
        '</div><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' + statusChip + payChip + actions + '</div></div>';
    }).join('');
    list.querySelectorAll('[data-confirm-tx]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = b.getAttribute('data-confirm-tx');
        b.disabled = true;
        try {
          var out = await apiConfirmTransaction(id);
          showToast((out && out.message) || 'Status pembayaran diperbarui.');
          loadMyTx();
        } catch (err) {
          showToast((err && err.message) || 'Gagal mengecek status.', 'error');
        } finally {
          b.disabled = false;
        }
      });
    });
  } catch (err) {
    sec.hidden = true;
  }
}
