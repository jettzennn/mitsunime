'use strict';
// Login Google (v1.5.7, item 37) — logika OAuth 2.0 Authorization Code.
// Nol dependensi baru: pertukaran kode + pengambilan profil memakai
// fetch bawaan Node 22. TANPA PKCE (diputuskan di PRD §4.7.3 butir 1):
// klien ini confidential client (client_secret mengautentikasi server
// saat tukar kode); `state` adalah pelindung CSRF-nya. PKCE adalah
// tambahan untuk public client — bukan untuk alur ini. Dicatat supaya
// Pentest tidak menandainya sebagai temuan tanpa membaca alasan ini.
//
// RAHASIA: client_secret TIDAK PERNAH ditulis ke log, respons, atau
// berkas apa pun — hanya dipakai di dalam POST tukar kode di bawah.
// `code` dan token akses juga tidak pernah dicatat; kegagalan hanya
// dicatat sebagai jenisnya (tanpa nilai).
const crypto = require('node:crypto');
const config = require('../config');
const auth = require('./auth');
const logger = require('../utils/logger');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const FETCH_TIMEOUT_MS = 15000;

function isGoogleConfigured() {
  return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
}

function redirectUri() {
  return `${config.BASE_URL}/api/auth/google/callback`;
}

function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function fetchWithTimeout(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Tukar `code` menjadi access_token. Mengembalikan token (string) atau
// melempar Error generik (pesan TIDAK memuat code/token/secret).
async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
  let res;
  try {
    res = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch (e) {
    logger.warn(`Login Google: tukar kode gagal di jaringan (${e && e.name === 'AbortError' ? 'timeout' : 'jaringan'})`);
    throw new Error('Gagal menghubungi Google.');
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data || typeof data.access_token !== 'string' || !data.access_token) {
    logger.warn(`Login Google: tukar kode ditolak Google (status ${res.status})`);
    throw new Error('Kode login Google tidak berlaku.');
  }
  return data.access_token;
}

// Ambil profil dari userinfo. Mengembalikan { sub, email,
// email_verified, picture } atau melempar Error generik.
async function fetchUserInfo(accessToken) {
  let res;
  try {
    res = await fetchWithTimeout(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
  } catch (e) {
    logger.warn(`Login Google: ambil profil gagal di jaringan (${e && e.name === 'AbortError' ? 'timeout' : 'jaringan'})`);
    throw new Error('Gagal menghubungi Google.');
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data || typeof data.sub !== 'string' || !data.sub
    || typeof data.email !== 'string' || !data.email) {
    logger.warn(`Login Google: profil Google tidak lengkap (status ${res.status})`);
    throw new Error('Profil Google tidak lengkap.');
  }
  return {
    sub: data.sub,
    email: data.email,
    // PRD §4.7.3: tolak bila email_verified Google bukan true.
    email_verified: data.email_verified === true,
    picture: typeof data.picture === 'string' && data.picture ? data.picture : null,
  };
}

// Turunkan username dari local-part email: lowercase, buang karakter
// di luar [a-z0-9_-], potong 32 karakter. Bila hasil <3 karakter /
// kosong → 'pengguna' + 4 angka acak. Bila sudah dipakai → tambah
// '-2', '-3', … sampai lolos USERNAME_RE + UNIQUE.
function deriveUniqueUsername(email) {
  const local = String(email || '').split('@')[0] || '';
  let base = local.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  if (base.length < 3) {
    base = `pengguna${Math.floor(1000 + Math.random() * 9000)}`;
  }
  let candidate = base;
  let n = 2;
  while (auth.findUserByUsername(candidate)) {
    const suffix = `-${n}`;
    candidate = base.slice(0, 32 - suffix.length) + suffix;
    n += 1;
  }
  return candidate;
}

// Cari / tautkan / buat akun dari profil Google.
// Mengembalikan { user, mode } dengan mode:
//   'existing' — sudah pernah masuk lewat Google (google_id cocok);
//   'linked'   — akun password lama dengan email sama, kini tertaut;
//   'created'  — akun baru dibuat dari Google.
// Melempar Error('ADMIN_GOOGLE') bila email cocok dengan akun admin
// (admin TIDAK bisa ditautkan/dibuat lewat Google — PRD §4.7.3 butir 6).
function findOrCreateGoogleUser(profile) {
  const byGoogleId = auth.findUserByGoogleId(profile.sub);
  if (byGoogleId) {
    if (byGoogleId.role === 'admin') throw new Error('ADMIN_GOOGLE');
    auth.updateGoogleAvatar(byGoogleId.id, profile.picture);
    return { user: auth.findUserById(byGoogleId.id), mode: 'existing' };
  }
  const byEmail = auth.findUserByEmail(profile.email);
  if (byEmail) {
    if (byEmail.role === 'admin') throw new Error('ADMIN_GOOGLE');
    const linked = auth.linkGoogleAccount(byEmail.id, profile.sub, profile.picture);
    return { user: linked, mode: 'linked' };
  }
  const username = deriveUniqueUsername(profile.email);
  const created = auth.createGoogleUser({
    username,
    email: profile.email,
    googleId: profile.sub,
    avatarUrl: profile.picture,
  });
  return { user: created, mode: 'created' };
}

module.exports = {
  isGoogleConfigured, redirectUri, buildAuthUrl,
  exchangeCode, fetchUserInfo,
  deriveUniqueUsername, findOrCreateGoogleUser,
};
