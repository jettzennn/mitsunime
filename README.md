# Mitsunime

Website streaming anime full-stack berbahasa Indonesia: katalog dari Anikoto API, player MegaPlay, pencarian dari database lokal (SQLite + FTS5), akun (email+password + login Google), dashboard admin tersembunyi. Desain Dark Lime.

**Status (v1.5.8):** 12 perbaikan temuan uji HP v1.5.7 (item 39–50): halaman legal diperbaiki (judul satu baris, garis di bawah judul, tanpa tombol kembali), avatar akun tidak berkedip, login Google tanpa JSON mentah (tiket sekali pakai + halaman transisi), halaman "Lihat Semua" per seksi Beranda, menu ⋮ satu kolom + bisa digeser + tidak hilang sendiri, 8 font subtitle baru (Inter + Comic Neue dihapus), shadow subtitle dengan blur yang bisa diatur, tombol play di tengah video, tanda "Sudah ditonton" per episode (ambang ≥90%), dan cari episode pengganti dropdown. Premium tetap tidak ada. Lolos Cari Bug re-test (API 18/18 + browser 30/30, 0 temuan) + Pentest (0 Critical/High/Medium) — SIAP DEPLOY untuk pemakaian lokal di Termux.

**Menonton wajib login** (keputusan pengguna): tamu tidak bisa menonton. URL embed tidak pernah ada di payload `/api/series/:id`; hanya diberikan lewat `GET /api/series/:id/episodes/:ep/stream` yang butuh sesi login.

## Yang dibutuhkan

- Node.js 22.5 atau lebih baru (modul bawaan `node:sqlite` dipakai; **tanpa dependensi npm**, jadi tidak perlu `npm install` dan tidak ada node-gyp di Termux).
- Akses internet ke `https://anikotoapi.site` (untuk sync katalog) dan `https://megaplay.buzz` (player, dari browser).
- Termux di HP Android, atau PC/laptop apa pun dengan Node.js.

## Jalankan di Termux (HP)

```sh
# 1. Masuk ke folder proyek yang sudah diekstrak
cd ~/mitsunime

# 2. (Opsional) Salin konfigurasi dan ubah bila perlu
cp .env.example .env
# WAJIB isi sebelum memakai admin:
#   ADMIN_PATH — kosong di .env.example; isi nilai rahasiamu sendiri di .env (format: /a-<kata-acak-panjang>);
#   ganti kapan saja lewat .env bila sudah pernah dibagikan. Bila kosong,
#   rute admin tidak hidup.
# OPSIONAL (verifikasi email OTP): isi SMTP_HOST/SMTP_USER/SMTP_PASS
#   bila ingin pendaftaran mengirim kode verifikasi. Bila kosong,
#   verifikasi nonaktif dan register/login jalan seperti biasa.
# OPSIONAL (login Google): isi GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
#   dari Google Cloud Console (lihat .env.example). Bila kosong,
#   tombol Google tidak tampil.

# 3. (Boleh dilewati) Katalog sudah terisi di data/mitsunime.db yang ikut
#    di dalam zip (9.403 judul, 0 pengguna) — jalankan seed hanya bila
#    DB kosong atau hilang (sekali, ±5.000 judul; sapuan penuh ±9.400
#    judul pakai --pages 95)
# node scripts/seed-cache.js

# 4. Buat akun admin pertama (SATU admin saja; perintah menolak bila admin sudah ada)
node server/db/seed-admin.js <username> <password>

# 5. Jalankan server
node server/server.js
# Buka di browser HP: http://localhost:3000
# Cek kesehatan: http://localhost:3000/api/health
```

## Konfigurasi (.env)

Semua rahasia di `.env`, tidak pernah di kode. Lihat `.env.example` untuk daftar lengkap. Yang penting:

- `PORT` (default 3000), `HOST` (default 0.0.0.0)
- `DB_PATH` (default `data/mitsunime.db`)
- `ANIKOTO_BASE_URL` (default `https://anikotoapi.site` — ganti bila domain API berubah)
- `ADMIN_PATH` (tidak ada default — isi sendiri di `.env`, format `/a-<kata-acak-panjang>`; bila kosong, rute admin tidak hidup — ganti kapan saja lewat `.env`)
- `ADMIN_USER` (default `faygo`, bukan rahasia) dan `ADMIN_PASS` (kosong di `.env.example` — isi sekali di `.env` di HP; jangan pernah kirim lewat chat) — auto-seed admin: bila keduanya terisi dan belum ada admin, server membuat akun admin saat pertama start
- `SMTP_HOST`, `SMTP_PORT` (default `587`), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — verifikasi email OTP, **opsional**; bila `SMTP_USER` kosong, verifikasi nonaktif dan register/login jalan seperti biasa
- `MYMEMORY_EMAIL` — **opsional**, hanya menaikkan kuota gratis MyMemory (sinopsis) dari 5.000 menjadi 50.000 karakter/hari
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — login Google, **opsional**; bila kosong, tombol Google tidak tampil. Secret JANGAN pernah dikirim lewat chat
- `COOKIE_SECURE` (default `false` — aktifkan hanya bila situs sudah HTTPS; di localhost HTTP harus false)
- `AUTO_SYNC` (default `true`) — sync katalog ringan tiap jam di dalam server; set `false` untuk mematikan (lalu pasang cron Termux sebagai gantinya)

## Akun

- **Daftar (email+password):** username 3–32 karakter, password min. 8. Email hanya diterima dari domain **Google** (gmail.com, googlemail.com), **Yahoo** (yahoo.com, yahoo.co.id, yahoo.co.uk, ymail.com, rocketmail.com), dan **Microsoft** (outlook.com, hotmail.com, live.com, msn.com, outlook.co.id) — pencocokan persis, subdomain ditolak. Aturan yang sama berlaku untuk ganti email. Login dan reset password tidak kena aturan ini.
- **Verifikasi email OTP:** bila SMTP terisi, pendaftaran mengirim kode 6 digit (berlaku 1 menit); login ditolak sampai email terverifikasi. Bila SMTP kosong, verifikasi nonaktif.
- **Login Google:** ketuk "Lanjutkan dengan Google" → pilih akun → masuk tanpa OTP (Google sudah memverifikasi emailnya). Nama + foto profil mengikuti akun Google; pemilih warna preset avatar disembunyikan untuk pengguna Google (tetap ada untuk pengguna email+password). Akun email+password dengan email yang sama akan ditautkan (bukan akun ganda). **Admin tidak bisa login lewat Google** — admin tetap password-only.
- **Level/EXP:** 1 episode selesai +10 EXP (sekali per episode), 100 EXP = 1 level, level maks 100, admin selalu level 1000.
- **Keamanan:** password di-hash scrypt (bukan teks polos; format berversi agar bisa migrasi ke Argon2id nanti), sesi server-side + cookie HttpOnly/SameSite=Lax, pesan error login generik (tidak membocorkan username/password yang salah), rate limit login 10 gagal/IP/15 menit → 429, semua query berparameter (tidak ada SQL injection dari input), `admin.html` tidak dilayani sebagai file statis publik, `robots.txt` sengaja **tidak** memuat path admin (akan membocorkannya) — anti-indeks lewat header `X-Robots-Tag` + `<meta name="robots">`.

## Struktur proyek

```text
mitsunime/
├── .env.example
├── package.json            # tanpa dependensi; scripts: start, sync, sync:full, seed
├── server/
│   ├── server.js           # titik masuk HTTP (statis + /api + rute admin)
│   ├── config.js           # baca .env + default
│   ├── db/
│   │   ├── schema.sql      # skema lengkap (cache + FTS5 + akun + admin)
│   │   ├── database.js     # buka DB + migrasi kolom baru
│   │   └── seed-admin.js   # CLI: buat satu akun admin
│   ├── services/           # anikoto, cache, derive, sync, auth, emailCheck,
│   │                       # emailVerification, google, levels, mailer, megaplay,
│   │                       # proxyTokens, servers, subtitles, translate, avatars, adminSeed
│   ├── middleware/         # auth.js (requireLogin/requireAdmin + rate limit login),
│   │                       # adminPath.js (penjaga rute admin tersembunyi)
│   └── routes/
│       ├── public.js       # /api/recent, /api/search, /api/series/:id, /api/genre, /api/az, /api/series/:id/episodes/:ep/stream
│       ├── account.js      # register/login/logout/me/ganti password
│       ├── google.js       # login Google (OAuth)
│       ├── hd.js           # Server Mitsunime (Sub Indo)
│       ├── admin.js        # API dashboard admin (mount di ADMIN_PATH)
│       └── health.js       # /api/health
├── scripts/
│   ├── sync-cron.js        # sapuan ringan / penuh
│   ├── seed-cache.js       # isi cache awal
│   └── test-email.js       # uji kirim email SMTP
├── public/                 # frontend (index, detail, watch, account, settings, admin,
│   │                       # privacy, terms, fonts Inter + Comic Neue, sw.js, manifest)
└── data/                   # mitsunime.db (ikut di zip: katalog 9.403 judul, 0 pengguna)
```

## API

### Akun

| Endpoint | Keterangan |
|---|---|
| `POST /api/register` | Daftar (username 3–32, password min. 8) → sesi + cookie. Menolak email dummy — domain tanpa MX record (dns.resolveMx + fallback DNS-over-HTTPS) dan domain email sekali pakai; hanya domain Google/Yahoo/Microsoft yang diterima; pesan galat Bahasa Indonesia. |
| `POST /api/login` | Login (rate limit 10 gagal/15 mnt) → sesi + cookie |
| `POST /api/logout` | Keluar (hapus sesi + cookie) |
| `GET /api/me` | Profil + level/EXP (wajib login) |
| `POST /api/change-password` | Ganti password; sesi perangkat lain dicabut |
| `GET /api/auth/google/config` | Apakah login Google aktif (`{ configured: true/false }`) |
| `GET /api/auth/google/start` | Mulai login Google (redirect ke Google) |
| `GET /api/auth/google/callback` | Callback OAuth Google → sesi + cookie |
| `POST /api/account/profile` | Ganti nama + preset warna avatar (pengguna email+password) |

### Tonton (wajib login)

| Endpoint | Keterangan |
|---|---|
| `GET /api/series/:id/episodes/:ep/stream` | URL embed MegaPlay satu episode (wajib login; semua episode terbuka untuk pengguna login) |

### Admin (hanya di `/{ADMIN_PATH}`)

| Endpoint | Keterangan |
|---|---|
| `GET {ADMIN_PATH}/` | Halaman dashboard |
| `POST {ADMIN_PATH}/api/login` | Login admin (terpisah) |
| `GET {ADMIN_PATH}/api/summary` | Ringkasan (pengguna, katalog) |
| `GET {ADMIN_PATH}/api/users?search=` | Daftar pengguna |
| `GET {ADMIN_PATH}/api/audit` | Log audit |

## API publik

Semua respons sukses: `{ ok: true, stale, data, pagination, total }`.
Semua error: `{ ok: false, message: "..." }` + status HTTP.

| Endpoint | Keterangan |
|---|---|
| `GET /api/health` | Kesehatan server + jumlah judul terindeks |
| `GET /api/recent?page=&per_page=` | Episode Terbaru dari cache (urut updated_at) |
| `GET /api/search?q=&genre=&status=&year=` | Pencarian FTS5 dari database lokal (+ fallback LIKE), filter genre/status/tahun |
| `GET /api/series/:id` | Detail + episode (cache dulu, sinkron bila kadaluarsa). Sinopsis diterjemahkan ke Indonesia on-demand saat dibuka (sekali, lalu di-cache di DB; bila layanan terjemah gagal, sinopsis Inggris tetap tampil). Respons membawa `anime.description_lang` (`id`/`en`). |
| `GET /api/top` | Rating Tertinggi (derivasi skor) |
| `GET /api/airing` | Sedang Tayang (status Currently Airing) |
| `GET /api/genres` | Daftar genre + jumlah judul |
| `GET /api/genre/:name` | Judul per genre |
| `GET /api/az?huruf=A` | Daftar A–Z (`#` untuk angka/simbol) |

## Sync berkala (cron Termux)

Sync katalog **AKTIF bawaan** di dalam server (tiap jam, ±200 KB/jam) — **tidak perlu cron**.

```sh
# Sapuan ringan tiap jam — episode terbaru (halaman 1–5)
node scripts/sync-cron.js
# Sapuan penuh seminggu sekali
node scripts/sync-cron.js --full
```

Contoh cron di Termux (`crontab -e`) — hanya bila `AUTO_SYNC=false`:

```cron
0 * * * * cd ~/mitsunime && node scripts/sync-cron.js >> data/sync.log 2>&1
0 3 * * 0 cd ~/mitsunime && node scripts/sync-cron.js --full >> data/sync.log 2>&1
```

Angka kuota (diukur langsung, bukan kira-kira): 1 halaman sync ±30–45 KB di kabel, maksimal 5 halaman/jam = **±150–220 KB/jam**, worst case **±5 MB/hari**. Jangan menjalankan auto-sync dan cron bersamaan tanpa alasan (dobel fetch yang sama). Interval hanya jalan selama proses server hidup; bila HP tidur lama (Doze Android menjeda Termux) dan server terjeda berjam-jam, cache bisa menua dan banner muncul lagi dengan benar — itu perilaku jujur, bukan bug.

## Backup dan restore

```sh
# Backup database
cp data/mitsunime.db data/mitsunime.db.bak
# Restore
cp data/mitsunime.db.bak data/mitsunime.db
```

File `data/` tidak di-commit. Bila file DB hilang, jalankan ulang `node scripts/seed-cache.js` (katalog disusun ulang dari API; flag admin dan data akun ikut hilang — karena itu backup penting sebelum deploy ulang).

## Catatan kejujuran

- Pemutaran MegaPlay nyata di HP pengguna sudah terverifikasi di v1.5.x; akses langsung ke URL embed dinonaktifkan MegaPlay (hanya jalan sebagai iframe di website) — jadi uji `curl` ke URL embed yang mengembalikan halaman error "410" **bukan** bukti file episode hilang.
- Subtitle Indonesia adalah terjemahan AI (menu subtitle: Inggris + Indonesia (AI)); terjemahan pertama butuh internet, lalu tersimpan di server dan langsung tampil di tontonan berikutnya.
- Terjemahan sinopsis memakai endpoint Google Translate tidak resmi (tanpa API key) dengan cadangan MyMemory. Google bisa membatasi/memblokir kapan saja; kuota gratis MyMemory dipakai bersama per IP dan sudah habis saat pengujian — bila keduanya gagal, sinopsis Inggris tetap tampil (fail soft). Terjemahan hanya terjadi saat halaman detail dibuka; katalog tidak diterjemahkan sekaligus.
- Pendaftaran menolak email dummy (domain tanpa MX + domain sekali pakai), tetapi cara ini TIDAK membuktikan kepemilikan email — verifikasi kode lewat SMTP adalah langkah lanjutan yang terpisah dan butuh pengaturan email.
- Password di-hash scrypt, bukan Argon2id: Argon2id/bcrypt butuh modul native (node-gyp) yang tidak bisa dikirim di zip untuk Termux aarch64. Format hash berversi, jadi migrasi ke Argon2id tetap bisa tanpa reset akun.
- Rate limit Anikoto 60 request/IP/120 detik: sync penuh pertama butuh ±4 menit (dibatasi antrean, bukan diblokir).
