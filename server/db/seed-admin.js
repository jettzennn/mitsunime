'use strict';
// CLI: buat akun admin pertama Mitsunime (task-06).
//   node server/db/seed-admin.js <username> <password>
// Akun admin juga bisa dibuat OTOMATIS saat server pertama start bila
// .env berisi ADMIN_USER + ADMIN_PASS (v1.3.0, lihat services/adminSeed.js).
// CLI ini tetap berfungsi seperti biasa — pakai bila auto-seed dilewati
// (mis. ADMIN_PASS kosong di .env). Akun admin TIDAK PERNAH dibuat lewat
// pendaftaran publik. Keputusan pengguna: SATU admin saja; bila sudah ada
// admin, perintah ini menolak (jalan kedua tidak membuat admin kedua).
// Password tidak pernah dicetak ke layar.
const auth = require('../services/auth');
const database = require('../db/database');

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

function fail(message) {
  console.error(`Gagal: ${message}`);
  process.exit(1);
}

function main() {
  const [, , username, password] = process.argv;
  if (!username || !password) {
    fail('Pemakaian: node server/db/seed-admin.js <username> <password>');
  }
  if (!USERNAME_RE.test(username)) {
    fail('Username 3–32 karakter, hanya huruf, angka, "_" dan "-".');
  }
  if (password.length < 8) fail('Password minimal 8 karakter.');
  if (password.length > 128) fail('Password terlalu panjang (maksimal 128 karakter).');

  database.init();
  if (auth.countAdmins() > 0) {
    fail('Admin sudah ada. Mitsunime hanya memakai satu admin; hapus akun admin lama lewat database bila memang ingin menggantinya.');
  }
  if (auth.findUserByUsername(username)) {
    fail(`Username "${username}" sudah dipakai akun lain.`);
  }
  const user = auth.createUser({ username, password, role: 'admin' });
  console.log(`Admin dibuat: id=${user.id}, username=${user.username}`);
  console.log('Simpan password ini baik-baik; tidak ada cara melihatnya kembali dari server.');
  database.close();
}

main();
