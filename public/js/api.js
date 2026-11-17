/* ============================================================
   api.js — Klien API Mitsunime
   Frontend HANYA memanggil backend sendiri (/api/*, asal yang sama).
   DILARANG fetch langsung ke anikotoapi.site (CORS diblokir).
   Player MegaPlay tetap <iframe> langsung ke megaplay.buzz (watch.js).

   Bentuk respons sukses: { ok: true, stale, data, pagination, total }
   Bentuk error: { ok: false, message } + status HTTP.
   Item anime: { id, title, alternative, titles, poster,
     background_image, description, score, status, year, aired,
     season, duration, source, rating, s_id,
     is_sub, is_dub, terms_by_type { genre, studios, type },
     sub_indo (0/1, flag admin), premium_only (0/1, data saja di v1),
     next_air_schedule_time, next_air_ep, updated_at }
   (mal_id/ani_id TIDAK ada di payload publik — keduanya bahan
   pembangun URL fallback MegaPlay, hanya diberikan lewat endpoint
   stream yang butuh login.)
   GET /api/series/:id → { data: { anime, episodes: [
     { id, number, title, jp_title, updated_at } ] } }
   (embed_url TIDAK ada di payload publik — hanya lewat endpoint
   stream yang butuh login.)
   ============================================================ */

var API_OFFLINE_MESSAGE =
  'Tidak dapat terhubung ke server. Periksa Termux masih berjalan (node server/server.js), lalu muat ulang halaman.';

function ApiError(message, status) {
  this.name = 'ApiError';
  this.message = message || 'Terjadi kesalahan saat memuat data.';
  this.status = status || 0;
}
ApiError.prototype = Object.create(Error.prototype);
ApiError.prototype.constructor = ApiError;

function apiFetch(path, opts) {
  /* v1.3.3: cache 'no-store' — respons API (terutama /api/me) tidak
     boleh disajikan dari cache HTTP/bfcache, supaya status sesi yang
     dibaca frontend selalu segar (penjaga bug tombol Back). */
  var init = { headers: { Accept: 'application/json' }, cache: 'no-store' };
  if (opts) {
    if (opts.method) init.method = opts.method;
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
  }
  return fetch(path, init).then(function (res) {
    return res.json().catch(function () { return null; }).then(function (body) {
      if (!res.ok) {
        var msg = (body && body.message) || ('Server mengembalikan galat ' + res.status + '. Coba muat ulang.');
        /* v1.3.0: badan respons mentah ikut dilampirkan supaya pemanggil
           bisa membaca penanda seperti verification_required (login
           ditolak karena belum terverifikasi) atau attempts_left
           (sisa percobaan kode OTP) — pesan saja tidak cukup. */
        var apiErr = new ApiError(msg, res.status);
        apiErr.data = body || null;
        throw apiErr;
      }
      if (!body || body.ok === false) {
        var badErr = new ApiError((body && body.message) || 'Respons server tidak dikenali. Coba muat ulang.', res.status);
        badErr.data = body || null;
        throw badErr;
      }
      return body;
    });
  }).catch(function (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(API_OFFLINE_MESSAGE, 0);
  });
}

function apiGet(path) { return apiFetch(path); }
function apiPost(path, body) { return apiFetch(path, { method: 'POST', body: body || {} }); }
function apiPut(path, body) { return apiFetch(path, { method: 'PUT', body: body || {} }); }
function apiDelete(path) { return apiFetch(path, { method: 'DELETE' }); }

function normalizeList(body, fallbackData) {
  var data = Array.isArray(body.data) ? body.data : (fallbackData || []);
  return {
    data: data,
    stale: body.stale === true,
    /* M4: true HANYA bila status Anikoto terakhir benar-benar gagal.
       Dipakai pemilih teks banner (staleBannerText) — stale saja tidak
       cukup untuk menyalahkan Anikoto. */
    anikotoDown: body.anikoto_down === true,
    message: body.message || null,
    pagination: body.pagination || null,
    total: typeof body.total === 'number' ? body.total : (body.pagination && body.pagination.total) || data.length,
    indexedTotal: typeof body.indexed_total === 'number' ? body.indexed_total : null,
    raw: body,
  };
}

function qs(params) {
  var parts = [];
  Object.keys(params).forEach(function (k) {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
  });
  return parts.length ? '?' + parts.join('&') : '';
}

/* --- Katalog --- */
function getRecent(page, perPage) {
  return apiGet('/api/recent' + qs({ page: page || 1, per_page: perPage || 20 })).then(normalizeList);
}
function getTop(page, perPage) {
  return apiGet('/api/top' + qs({ page: page || 1, per_page: perPage || 20 })).then(normalizeList);
}
function getAiring(page, perPage) {
  return apiGet('/api/airing' + qs({ page: page || 1, per_page: perPage || 20 })).then(normalizeList);
}
function getSeries(id) {
  return apiGet('/api/series/' + encodeURIComponent(id)).then(function (body) {
    var data = body.data || {};
    return { data: data, anime: data.anime || null, episodes: Array.isArray(data.episodes) ? data.episodes : [], stale: body.stale === true, anikotoDown: body.anikoto_down === true, raw: body };
  });
}

/* Pesan banner data basi (perbaiki M4): "Anikoto tidak dapat dijangkau"
   HANYA bila status terakhir Anikoto benar-benar gagal; bila hanya cache
   yang tua, pesannya jujur tanpa menyalahkan Anikoto. */
function staleBannerText(anikotoDown) {
  return anikotoDown
    ? 'Data mungkin tidak terbaru — Anikoto sedang tidak dapat dijangkau. Menampilkan data terakhir yang tersimpan.'
    : 'Data mungkin tidak terbaru. Menampilkan data terakhir yang tersimpan.';
}
function searchAnime(q, opts) {
  opts = opts || {};
  return apiGet('/api/search' + qs({ q: q, genre: opts.genre, status: opts.status, year: opts.year, page: opts.page || 1, per_page: opts.perPage || 20 })).then(normalizeList);
}
function getGenres() {
  return apiGet('/api/genres').then(normalizeList);
}
function getGenre(name, page, perPage) {
  return apiGet('/api/genre/' + encodeURIComponent(name) + qs({ page: page || 1, per_page: perPage || 20 })).then(normalizeList);
}
function getAZ(letter, page, perPage) {
  return apiGet('/api/az' + qs({ huruf: letter || '', page: page || 1, per_page: perPage || 20 })).then(normalizeList);
}
function getStream(id, ep, lang) {
  /* v1.5.0: `lang` menentukan URL tiap server di daftar `servers`
     (dibangun server-side); tanpa itu daftar selalu SUB. */
  return apiGet('/api/series/' + encodeURIComponent(id) + '/episodes/' + encodeURIComponent(ep) + '/stream' + qs({ lang: lang || 'sub' }));
}
/* --- Server HD + Sub Indo (v1.5.0, PRD §5) --- */
function getStreamHD(id, ep, lang) {
  return apiGet('/api/series/' + encodeURIComponent(id) + '/episodes/' + encodeURIComponent(ep) + '/stream-hd' + qs({ lang: lang || 'sub' }));
}
function checkSubCache(animeId, episode, sourceHash) {
  return apiGet('/api/vtt/check-cache' + qs({ anime: animeId, ep: episode, source_hash: sourceHash }));
}
function saveSubCues(animeId, episode, sourceHash, cues) {
  return apiPost('/api/vtt/save', { anime_id: animeId, episode: episode, source_hash: sourceHash, cues: cues });
}
function getHealth() {
  return apiGet('/api/health').catch(function (err) {
    return { ok: false, status: 'down', error: err.message };
  });
}

/* --- Akun --- */
function apiRegister(username, password, email) {
  return apiPost('/api/register', { username: username, password: password, email: email || '' });
}
function apiLogin(email, password) {
  return apiPost('/api/login', { email: email, password: password });
}
function apiLogout() { return apiPost('/api/logout', {}); }
function apiMe() { return apiGet('/api/me'); }
function apiChangePassword(current, next) {
  return apiPost('/api/change-password', { current: current, 'new': next });
}
/* Verifikasi email OTP (v1.3.0): konfirmasi kode 6 digit + minta
   kode baru. Endpoint ini hanya bermakna bila SMTP terkonfigurasi di
   server; bila tidak, register/login berjalan seperti v1.2.0 dan
   pemanggil tidak pernah sampai ke sini. */
function apiVerifyConfirm(email, code) {
  return apiPost('/api/auth/verify/confirm', { email: email, code: code });
}
function apiVerifyRequest(email) {
  return apiPost('/api/auth/verify/request', { email: email });
}
/* Ganti/tambah email akun belum terverifikasi (v1.3.1):
   { email?, username?, new_email, password }. Password WAJIB — tanpa
   itu server menjawab 401 dengan pesan generik. Sukses mengembalikan
   { email_sent, message }; email_sent false berarti OTP gagal
   terkirim (mis. SMTP mati) dan UI wajib menampilkannya dengan jujur. */
function apiChangeEmail(body) {
  return apiPost('/api/auth/verify/change-email', body);
}
/* Tandai satu episode selesai ditonton (v1.3.1): +10 EXP, hanya sekali
   per episode per pengguna. Mengembalikan { exp_gained, exp_total,
   level, leveled_up }. */
function apiWatchComplete(animeId, episode) {
  return apiPost('/api/watch/complete', { anime_id: animeId, episode: episode });
}
/* Ubah profil (v1.3.2): { avatar?, username? } — avatar salah satu dari
   8 preset atau null (kembali ke avatar huruf default). Mengembalikan
   { user, premium, level }. Sesi tetap berlaku setelah ganti nama. */
function apiUpdateProfile(body) {
  return apiPost('/api/account/profile', body || {});
}
/* Riwayat episode satu anime (v1.3.2): { data: [{ episode, position_sec,
   duration_sec, percent, completed, last_watched_at }] }, terurut
   menaik. `completed` dari field ini — episode selesai bisa ber-percent
   0, jadi percent SAJA bukan bukti selesai. */
function apiHistory(animeId) {
  return apiGet('/api/history/' + encodeURIComponent(animeId)).then(normalizeList);
}

/* --- Favorit & lanjutkan menonton (server, pengguna login) --- */
function apiFavorites() { return apiGet('/api/favorites').then(normalizeList); }
function apiAddFavorite(animeId) { return apiPost('/api/favorites', { anime_id: animeId }); }
function apiRemoveFavorite(animeId) { return apiDelete('/api/favorites/' + encodeURIComponent(animeId)); }
function apiContinue() { return apiGet('/api/continue').then(normalizeList); }
function apiProgress(animeId) { return apiGet('/api/progress/' + encodeURIComponent(animeId)).then(normalizeList); }
function apiSaveContinue(animeId, episode, positionSec, durationSec) {
  return apiPost('/api/continue', { anime_id: animeId, episode: episode, position_sec: positionSec, duration_sec: durationSec });
}
function apiRemoveContinue(animeId) { return apiDelete('/api/continue/' + encodeURIComponent(animeId)); }

/* --- Premium & aksesori --- */
function apiPlans() { return apiGet('/api/plans').then(normalizeList); }
function apiPremiumStatus() { return apiGet('/api/premium/status'); }
/* Info bayar manual (v1.1.0): { payment_gateway, payment_methods,
   merchant_name, has_qris } — dipakai halaman Premium untuk memilih
   alur yang ditampilkan (manual QRIS atau Midtrans). */
function apiQrisInfo() { return apiGet('/api/premium/qris'); }
/* Buat transaksi manual QRIS (v1.1.0): proofRef teks (opsional),
   proofImage data URL/base64 JPG/PNG/WebP maks. 2 MB (opsional).
   v1.3.0: discountCode opsional — harga yang disimpan adalah harga
   setelah diskon. */
function apiCreateManualTransaction(planId, proofRef, proofImage, discountCode) {
  return apiPost('/api/premium/transactions/manual', { plan_id: planId, proof_ref: proofRef || '', proof_image: proofImage || null, discount_code: discountCode || undefined });
}
/* v1.3.0: discountCode opsional, sama seperti di atas. */
function apiCreateTransaction(planId, discountCode) { return apiPost('/api/premium/transactions', { plan_id: planId, discount_code: discountCode || undefined }); }
/* Cek kode diskon (v1.3.0): TIDAK memakai kode — pemakaian dicatat
   saat transaksi dibuat. Mengembalikan { code, percent,
   original_price, final_price, plan_id }. */
function apiValidateDiscount(planId, code) {
  return apiPost('/api/premium/discounts/validate', { plan_id: planId, code: code });
}
function apiMyTransactions() { return apiGet('/api/premium/mine').then(normalizeList); }
function apiConfirmTransaction(id) { return apiPost('/api/premium/transactions/' + encodeURIComponent(id) + '/confirm', {}); }
function apiAccessories() { return apiGet('/api/accessories'); }
function apiEquipAccessory(id) { return apiPost('/api/accessories/equip', { accessory_id: id }); }
function apiUnequipAccessory(kind) { return apiPost('/api/accessories/unequip', { kind: kind }); }

/* URL fallback player MegaPlay (mal → ani) TIDAK LAGI dibangun di sini:
   mal_id/ani_id sudah dihapus dari payload publik (perbaiki M2). URL
   cadangan diberikan server lewat endpoint stream yang butuh login
   (stream.data.fallback_urls), dan dipakai watch.js dari sana. */
