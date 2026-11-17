'use strict';
// Peta token proxy opaque (v1.5.0, PRD §4.4).
// Token: 16 byte acak → 32 heks (/^[0-9a-f]{32}$/). TIDAK mengandung
// informasi apa pun tentang URL upstream — client TIDAK PERNAH boleh
// meminta proxy mengambil URL sembarang (larangan SSRF). URL upstream
// (beserta token VidCloud ?t=) hanya hidup di peta in-memory ini dan
// TIDAK PERNAH ditulis ke log, respons, atau DB.
// TTL 3 jam (satu episode + jeda); entri kedaluwarsa dibuang saat
// diakses; batas 1000 entri (yang kedaluwarsa dibuang dulu, lalu
// yang terlama).
const crypto = require('node:crypto');

const TOKEN_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_ENTRIES = 1000;
const TOKEN_RE = /^[0-9a-f]{32}$/;

// token -> { url, kind: 'master'|'variant'|'segment'|'vtt', expiresAt }
const store = new Map();

function prune() {
  const now = Date.now();
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) store.delete(token);
  }
  while (store.size > MAX_ENTRIES) {
    // Map menjaga urutan sisip — hapus yang terlama.
    store.delete(store.keys().next().value);
  }
}

// Terbitkan token untuk satu URL upstream. `ttlMs` hanya untuk uji
// (kedaluwarsa token); pemakaian normal memakai TOKEN_TTL_MS.
function issue(url, kind, ttlMs = TOKEN_TTL_MS) {
  prune();
  let token;
  do {
    token = crypto.randomBytes(16).toString('hex');
  } while (store.has(token));
  store.set(token, { url, kind, expiresAt: Date.now() + ttlMs });
  return token;
}

// Ambil entri token; null bila format salah, tidak dikenal, atau
// kedaluwarsa (entri kedaluwarsa langsung dibuang).
function lookup(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(token);
    return null;
  }
  return entry;
}

module.exports = { issue, lookup, TOKEN_TTL_MS, TOKEN_RE, MAX_ENTRIES };
