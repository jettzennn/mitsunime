'use strict';
// Premium Mitsunime (task-07): siklus hidup premium pengguna.
// MODEL AKHIR (keputusan pengguna 2026-11-15 ~06:55 WIB):
// premium v1 = AKSESORI PROFIL SAJA (border, background, bingkai avatar,
// lencana, efek nama). TIDAK ADA kunci konten: gating episode baru 7 hari
// dan judul premium_only dari PRD TIDAK dipakai — semua episode/judul bisa
// ditonton pengguna yang sudah login, premium atau bukan. Kunci resolusi
// juga DIHAPUS: MegaPlay tidak menyediakan cara mengontrol kualitas dari
// luar iframe (tidak ada parameter URL/API kualitas di dokumentasi resmi;
// iframe lintas origin). File ini TIDAK berisi fungsi gating konten —
// jangan tambahkan; Frontend juga TIDAK membangun panel terkunci / chip
// PREMIUM pada konten.
//
// Yang dilakukan modul ini: cek status premium aktif, beri premium
// (setelah admin menyetujui transaksi / pemberian manual), cabut premium,
// dan beri aksesori premium saat premium aktif.
const dbModule = require('../db/database');
const accessories = require('./accessories');
const { isPremiumActive, premiumInfo } = require('./premiumStatus');

// (isPremiumActive + premiumInfo tinggal di premiumStatus.js — modul tanpa
// dependensi — agar accessories.js bisa memakainya tanpa dependensi
// melingkar dengan modul ini.)

// Beri premium selama durationDays hari terhitung dari sekarang.
// Dipakai admin saat menyetujui transaksi dan saat pemberian manual.
// Sekaligus memberikan aksesori SESUAI TIER paket (planId): 7 hari =
// border+background, 15 hari = +frame, 30 hari = semua 14 (lihat
// services/accessories.js grantPlanAccessories). Bila planId kosong
// (pemberian manual tanpa paket), diberi seluruh set premium (perilaku
// lama). Upgrade ke tier lebih tinggi hanya MENAMBAH aksesori yang belum
// dimiliki — yang sudah ada tidak dicabut.
// Mengembalikan { premium_until }.
function grantPremium(userId, durationDays, planId) {
  const now = Math.floor(Date.now() / 1000);
  const current = dbModule.get().prepare(
    'SELECT premium_until, is_premium FROM users WHERE id = ?',
  ).get(userId);
  if (!current) throw new Error('Pengguna tidak ditemukan.');
  // Bila masih premium aktif, perpanjang dari tanggal habis yang ada
  // (bukan dari sekarang) supaya sisa hari tidak hilang.
  const base = (current.is_premium && current.premium_until && current.premium_until > now)
    ? current.premium_until : now;
  const until = base + Math.max(1, durationDays) * 86400;
  dbModule.get().prepare(
    'UPDATE users SET is_premium = 1, premium_until = ? WHERE id = ?',
  ).run(until, userId);
  accessories.grantPlanAccessories(userId, planId);
  return { premium_until: until };
}

// Cabut premium: flag mati, tanggal habis dikosongkan. Aksesori premium
// yang sudah dimiliki TETAP tersimpan, tetapi pemakaiannya diblokir selama
// tidak premium (ditegakkan di services/accessories.js saat equip/tampil).
function revokePremium(userId) {
  dbModule.get().prepare(
    'UPDATE users SET is_premium = 0, premium_until = NULL WHERE id = ?',
  ).run(userId);
  return { premium_until: null };
}

module.exports = { isPremiumActive, premiumInfo, grantPremium, revokePremium };
