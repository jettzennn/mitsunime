'use strict';
// Status premium (tanpa dependensi) — dipisah dari services/premium.js
// karena accessories.js butuh aturan ini dan premium.js butuh
// accessories.js (grantPremiumSet). Bila aturan ini tinggal di premium.js,
// terjadi dependensi melingkar premium ↔ accessories dan
// isPremiumActive menjadi undefined saat modul dimuat (pernah menyebabkan
// 500 di /api/me pada 2026-11-15). Modul ini TIDAK boleh require modul
// services lain.
function isPremiumActive(user) {
  if (!user || !user.is_premium) return false;
  if (!user.premium_until) return false;
  return user.premium_until > Math.floor(Date.now() / 1000);
}

function premiumInfo(user) {
  const now = Math.floor(Date.now() / 1000);
  const active = isPremiumActive(user);
  return {
    is_premium: active ? 1 : 0,
    premium_until: user && user.premium_until ? user.premium_until : null,
    days_left: active ? Math.max(0, Math.ceil((user.premium_until - now) / 86400)) : 0,
  };
}

module.exports = { isPremiumActive, premiumInfo };
