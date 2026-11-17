# Mitsunime

![version](https://img.shields.io/badge/version-1.5.0-brightgreen)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=node.js&logoColor=white)
![dependencies](https://img.shields.io/badge/dependensi-0%20npm-blue)
![Termux](https://img.shields.io/badge/Termux-Android-3DDC84?logo=android&logoColor=white)
![Bahasa](https://img.shields.io/badge/bahasa-Indonesia-red)
![Katalog](https://img.shields.io/badge/katalog-9.403%20judul-orange)

Website streaming anime **full-stack berbahasa Indonesia** yang jalan lokal di HP Android (Termux) — katalog dari Anikoto, player video milik sendiri, dan subtitle Indonesia (AI) yang muncul dalam hitungan detik.

**Nonton bebas tanpa login.** Login hanya dibutuhkan untuk riwayat tonton, Daftar Saya, dan level/EXP. Tidak ada konten yang dikunci premium — premium hanya aksesori profil.

## ✨ Yang baru di v1.5.0 — Server HD + Sub Indo

| Fitur | Keterangan |
|---|---|
| **Server HD** | Player video milik sendiri (hls.js) dari VidCloud — jadi server utama, bukan lagi iframe semata |
| **Subtitle Indonesia (AI)** | VTT Inggris diterjemahkan ke Indonesia di browser, progresif per batch — subtitle pertama tampil dalam hitungan detik setelah play, lalu di-cache di server supaya penonton berikut langsung instan |
| **Pemilih 6 server** | Satu dropdown, banyak opsi — satu server mati tidak mematikan nonton |
| **Pilih kualitas** | Otomatis / 1080p / 720p / dst. (level HLS) |
| **Lewati intro/outro** | Tombol lewati dari data VidCloud |

## 🎬 Cara nonton

1. Buka halaman detail anime → pilih episode.
2. Video memutar lewat **Server HD** (default).
3. Bila HD gagal, player otomatis pindah ke server berikut — dengan pesan jujur di layar.
4. Ganti server kapan saja lewat dropdown atau tombol **Ganti Server**.

## 🌐 Daftar server

| # | Server | Jenis | Keterangan |
|---|---|---|---|
| 1 | **Server HD (Sub Indo)** | Player sendiri (VidCloud + hls.js) | Default. Satu-satunya server dengan Sub Indo AI, progres, dan auto-next |
| 2 | MegaPlay | Iframe | Cadangan pertama; progres & auto-next jalan |
| 3 | VidCloud | Iframe | Embed langsung |
| 4 | AniEmbed | Iframe | Embed langsung |
| 5 | TryEmbed | Iframe | Embed langsung |
| 6 | Nontongo (belum teruji) | Iframe | Ditandai jelas — pemutarannya belum terverifikasi |

> Progres tonton, riwayat, dan auto-next hanya jalan di Server HD dan MegaPlay. Di server iframe lain video tetap bisa ditonton, tapi "Lanjutkan Menonton" tidak ter-update dari server itu.

## 🇮🇩 Subtitle Indonesia (AI) — cara kerjanya

Bukan subtitle bawaan provider — tidak ada provider yang menyediakannya. Alurnya:

1. Server mengambil VTT Inggris dari VidCloud lewat proxy sendiri.
2. Browser menerjemahkan cue Inggris → Indonesia secara **progresif**: batch pertama (cue paling awal) diterjemahkan dulu supaya subtitle langsung tampil, sisanya menyusul di background mendahului playhead.
3. Tiap batch yang selesai **disimpan kembali ke server** (SQLite) — penonton berikut pada episode yang sama mendapat Sub Indo **instan dari cache**, tanpa translate ulang.
4. Cue yang belum/gagal diterjemahkan tetap tampil dalam bahasa Inggris — tidak pernah ada subtitle kosong.

- Target: subtitle Indonesia pertama ≤ 5 detik setelah video diputar (batas terima 8 detik).
- Bila episode tidak punya track Inggris, tidak ada opsi "Indonesia (AI)" — itu bukan error, episode itu memang tidak punya bahan terjemahan.
- Mesin translate: endpoint Google Translate gratis (round-robin, client-side) dengan cadangan MyMemory.

## 🔓 Akun — nonton bebas, login untuk progres

- **Tamu** bisa menonton semua episode tanpa login (sejak v1.4.5).
- **Login** untuk: riwayat tonton, Daftar Saya, dan level/EXP.
- **Level/EXP:** 1 episode selesai = +10 EXP (sekali per episode); 100 EXP = 1 level; level maks 100 (admin 1000).
- **Pendaftaran:** verifikasi email OTP 6 digit (berlaku 1 menit; butuh SMTP di `.env` — bila kosong, verifikasi nonaktif dan register/login jalan seperti biasa). Habis verifikasi, pengguna diarahkan ke halaman login dengan email sudah terisi.
- **Keamanan akun:** password di-hash scrypt, sesi server-side + cookie HttpOnly, pesan error login generik, rate limit login.

## 💎 Premium — aksesori profil saja

**Premium tidak mengunci konten apa pun.** Semua episode dan judul bisa ditonton siapa saja, premium atau bukan. Premium hanya memberi aksesori profil: border profil, background profil, bingkai avatar, lencana, dan efek nama.

| Paket | Harga | Durasi | Aksesori |
|---|---|---|---|
| 7 Hari | Rp10.000 | 7 hari | 6 aksesori |
| 15 Hari | Rp19.000 | 15 hari | 9 aksesori |
| 1 Bulan | Rp29.000 | 30 hari | Semua 14 aksesori |

Pembayaran via **Midtrans** (Snap). Premium aktif setelah admin menyetujui — pembayaran saja tidak langsung mengaktifkan.

> ⚠️ Pembayaran Midtrans live (transaksi nyata + webhook) **masih perlu uji nyata** dengan kunci asli dan URL publik. Sampai terverifikasi, anggap alur ini belum terbukti ujung-ke-ujung.

## 🚀 Jalankan di Termux (HP Android)

**Yang dibutuhkan**

- Node.js 22.5 atau lebih baru (memakai modul bawaan `node:sqlite`).
- **Tanpa dependensi npm** — tidak perlu `npm install`, tidak ada node-gyp.
- Akses internet ke Anikoto (sync katalog) dan provider video.

```sh
# 1. Masuk ke folder proyek yang sudah diekstrak
cd ~/mitsunime

# 2. Salin konfigurasi, lalu isi di .env (lihat .env.example)
cp .env.example .env

# 3. Buat akun admin pertama (sekali saja)
node server/db/seed-admin.js <username> <password>

# 4. Jalankan server
node server/server.js
# Buka di browser HP: http://localhost:3000
# Cek kesehatan: http://localhost:3000/api/health
```

Katalog sudah terisi di `data/mitsunime.db` yang ikut dalam paket (9.403 judul). Bila DB kosong/hilang, isi ulang dengan `node scripts/seed-cache.js`.

**Sync berkala (cron Termux)**

```sh
# Sapuan ringan tiap jam — episode terbaru
node scripts/sync-cron.js
# Sapuan penuh seminggu sekali
node scripts/sync-cron.js --full
```

## ⚙️ Konfigurasi

Semua rahasia ada di `.env` — **tidak pernah di kode, tidak pernah ikut dalam paket/zip**. Lihat `.env.example` untuk daftar lengkap.

- `PORT` (default 3000), `DB_PATH` (default `data/mitsunime.db`)
- Alamat dashboard admin diatur lewat `.env` (bila kosong, rute admin tidak hidup)
- Kunci Midtrans + mode sandbox/produksi (opsional — hanya bila Midtrans dipakai)
- SMTP (opsional — hanya bila verifikasi email OTP dipakai)

## 🛡️ Keamanan & privasi

- Proxy Server HD memakai **token opaque** (32 karakter heks, TTL 3 jam) — URL dan token upstream **tidak pernah sampai ke browser**.
- Semua fetch ke provider video dilakukan server-side; browser hanya memanggil origin Mitsunime sendiri.
- Validasi ketat pada penyimpanan cache subtitle (cue palsu ditolak — seluruh request, bukan sebagian).
- Rate limit: login, resolusi stream, dan simpan subtitle.
- Dashboard admin tersembunyi (tanpa tautan publik, tanpa entri `robots.txt`).
- Tidak ada pelacak pihak ketiga di halaman.

## ⚠️ Jujur soal batasan

- **Kecepatan Server HD tergantung koneksi.** Potongan video diunduh lewat proxy dari CDN VidCloud — bila koneksi lambat, video bisa buffering lalu fallback otomatis ke MegaPlay. Pada satu pengujian di koneksi 4G lambat, tiap potongan video butuh ~13 detik sehingga HD tidak bisa jalan dan player pindah ke MegaPlay. Bila koneksi sedang sangat lambat (belasan KB/detik), tidak ada server yang bisa streaming.
- **Subtitle Indonesia adalah hasil terjemahan mesin (AI)** — kualitasnya tidak setara subtitle manusia, dan Google Translate bisa membatasi/memblokir kapan saja (saat itu subtitle Inggris tetap tampil).
- **Nontongo belum terverifikasi memutar** — ada di pemilih dengan label "belum teruji".
- **Pembayaran Midtrans live belum terverifikasi** ujung-ke-ujung (lihat bagian Premium).
- **Belum ada CI** — tidak ada workflow GitHub Actions untuk proyek ini, jadi tidak ada badge status build.

## 📁 Struktur proyek

```
mitsunime/
├── .env.example            # template konfigurasi (tanpa rahasia)
├── package.json            # tanpa dependensi; scripts: start, sync, sync:full, seed
├── server/
│   ├── server.js           # titik masuk HTTP (statis + /api + rute admin)
│   ├── db/                 # schema.sql, database.js, seed-admin.js
│   ├── services/           # anikoto, vidcloud, subtitles, servers, proxyTokens, auth, premium, ...
│   ├── routes/             # public, hd, account, premium, accessories, admin, health
│   └── middleware/         # auth, adminPath
├── scripts/                # sync-cron.js, seed-cache.js
├── public/                 # frontend: watch.html, subs.js, watch.js, vendor/hls.min.js
└── data/                   # mitsunime.db (tidak di-commit)
```

## 📜 Catatan

Proyek pribadi (private, UNLICENSED). Dibangun untuk pemakaian lokal di Termux. Bukan aplikasi resmi dan tidak berafiliasi dengan Anikoto, MegaPlay, VidCloud, atau penyedia sumber video lainnya. Hormati hak cipta dan ketentuan layanan masing-masing sumber.
