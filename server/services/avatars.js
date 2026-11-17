'use strict';
// Avatar preset profil (v1.3.2): 8 pilihan avatar yang digambar dari kode
// saja (tanpa gambar eksternal) — lingkaran huruf awal username dengan
// warna latar + huruf + ring, dari tema Dark Lime. Frontend merender
// lingkaran dengan background = bg, huruf = fg, border 2px = ring.
// NULL di kolom users.avatar = avatar huruf default (latar gelap + huruf
// lime, seperti sebelum v1.3.2). Nol dependensi.
const AVATAR_PRESETS = [
  { code: 'lime',   name: 'Lime',   bg: '#c7f632', fg: '#0c0f14', ring: '#84cc16' },
  { code: 'emas',   name: 'Emas',   bg: '#f5c542', fg: '#1a1405', ring: '#d97706' },
  { code: 'zamrud', name: 'Zamrud', bg: '#10b981', fg: '#06281c', ring: '#059669' },
  { code: 'merah',  name: 'Merah',  bg: '#ef4444', fg: '#2b0606', ring: '#dc2626' },
  { code: 'perak',  name: 'Perak',  bg: '#e5e7eb', fg: '#111827', ring: '#9ca3af' },
  { code: 'langit', name: 'Langit', bg: '#38bdf8', fg: '#082f49', ring: '#0284c7' },
  { code: 'ungu',   name: 'Ungu',   bg: '#a78bfa', fg: '#1e1033', ring: '#7c3aed' },
  { code: 'jingga', name: 'Jingga', bg: '#fb923c', fg: '#2b1003', ring: '#ea580c' },
];

const AVATAR_CODES = new Set(AVATAR_PRESETS.map((p) => p.code));

function isValidAvatar(code) {
  return typeof code === 'string' && AVATAR_CODES.has(code);
}

function getAvatar(code) {
  return AVATAR_PRESETS.find((p) => p.code === code) || null;
}

module.exports = { AVATAR_PRESETS, AVATAR_CODES, isValidAvatar, getAvatar };
