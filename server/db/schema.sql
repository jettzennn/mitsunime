-- Skema database Mitsunime (PRD §5). Satu file: data/mitsunime.db.
-- Dijalankan otomatis oleh server/db/database.js saat server pertama hidup.
-- Dipakai ulang dari proyek NontonAnime (cache + FTS5) ditambah tabel akun
-- dan admin. File DB tidak ikut zip; dibuat ulang lewat seed.

-- Cache daftar anime (satu baris per judul dari /recent-anime)
CREATE TABLE IF NOT EXISTS anime_cache (
  id            INTEGER PRIMARY KEY,   -- id Anikoto
  title         TEXT NOT NULL,
  alternative   TEXT,
  titles        TEXT,                  -- semua alias (Inggris/Jepang) untuk pencarian FTS
  slug          TEXT,
  poster        TEXT,
  background_image TEXT,
  score         REAL,                  -- untuk derivasi "Rating Tertinggi"
  score_raw     TEXT,                  -- skor apa adanya dari API (string, contoh "8.18")
  status        TEXT,                  -- "Currently Airing" dll (untuk "Sedang Tayang")
  year          INTEGER,
  is_sub        INTEGER DEFAULT 0,     -- jumlah episode SUB (badge)
  is_dub        INTEGER DEFAULT 0,     -- jumlah episode DUB (badge)
  mal_id        TEXT,
  ani_id        TEXT,
  genres        TEXT,                  -- JSON array dari terms_by_type.genre
  studios       TEXT,                  -- JSON array dari terms_by_type.studios
  description   TEXT,
  next_air_schedule_time INTEGER,      -- untuk "Segera Tayang" & "Jadwal Tayang"
  next_air_ep   INTEGER,
  updated_at    TEXT,
  payload       TEXT NOT NULL,         -- JSON mentah item (jaga-jaga field baru)
  fetched_at    INTEGER NOT NULL,      -- epoch detik, untuk TTL
  sub_indo      INTEGER NOT NULL DEFAULT 0,  -- 1 = admin sudah memverifikasi judul ini bersubtitle Indonesia
  sub_indo_verified_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_anime_score   ON anime_cache(score DESC);
CREATE INDEX IF NOT EXISTS idx_anime_status  ON anime_cache(status);
CREATE INDEX IF NOT EXISTS idx_anime_year    ON anime_cache(year DESC);
CREATE INDEX IF NOT EXISTS idx_anime_fetched ON anime_cache(fetched_at);
CREATE INDEX IF NOT EXISTS idx_anime_updated ON anime_cache(updated_at DESC);

-- Pencarian judul (FTS5 di atas judul + alternatif + titles).
-- Kolom `titles` berisi semua alias Inggris/Jepang — pencarian jauh lebih kena.
-- Halaman pengindeksan tetap merujuk ke anime_cache via content_rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS anime_fts USING fts5(
  title, alternative, titles, content='anime_cache', content_rowid='id'
);

-- Cache detail series + episode (satu baris per anime)
CREATE TABLE IF NOT EXISTS series_cache (
  id            INTEGER PRIMARY KEY,   -- id Anikoto
  payload       TEXT NOT NULL,         -- JSON mentah {anime, episodes[]}
  episode_count INTEGER,               -- panjang array episodes
  fetched_at    INTEGER NOT NULL       -- epoch detik, untuk TTL
);

-- Jejak sapuan cache (supaya sync tidak mengulang halaman yang sama sia-sia)
CREATE TABLE IF NOT EXISTS crawl_state (
  key         TEXT PRIMARY KEY,        -- mis. "recent-anime:last_page"
  value       TEXT,
  updated_at  INTEGER NOT NULL
);

-- Akun pengguna
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  username         TEXT NOT NULL UNIQUE,
  email            TEXT UNIQUE,
  -- Password di-hash scrypt (node:crypto, tanpa modul native). PRD §3
  -- menyebut Argon2id/bcrypt, tetapi keduanya butuh build native
  -- (node-gyp) yang tidak bisa dikirim di zip untuk Termux aarch64 dan
  -- rawan gagal pasang di HP. Format hash berversi ("scrypt$v1$..."),
  -- jadi migrasi ke Argon2id tetap bisa dilakukan nanti tanpa reset akun.
  password_hash    TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  -- Verifikasi email OTP (v1.3.0): 0 = belum terverifikasi, 1 = sudah.
  -- Berlaku HANYA bila SMTP terkonfigurasi (lihat services/
  -- emailVerification.js). Bila SMTP kosong, kolom ini diabaikan dan
  -- register/login jalan seperti v1.2.0 — pengguna lama (0) tidak
  -- terkunci. Akun admin (role='admin', tanpa email) tidak pernah
  -- diblokir verifikasi.
  email_verified   INTEGER NOT NULL DEFAULT 0,
  -- Level + EXP (v1.3.1): total EXP pengguna; level dihitung dari sini
  -- (100 EXP = 1 level, maks level 100; admin selalu level 1000).
  exp_total        INTEGER NOT NULL DEFAULT 0,
  -- Avatar preset profil (v1.3.2): salah satu kode di
  -- server/services/avatars.js ('lime', 'emas', ...); NULL = avatar
  -- huruf default (latar gelap + huruf lime, seperti sebelum v1.3.2).
  avatar           TEXT,
  -- Login Google (v1.5.7, item 37): google_id = nilai `sub` Google
  -- (stabil per akun); avatar_url = URL foto Google (NULL =
  -- tidak ada foto → avatar huruf); provider = 'password' (daftar
  -- biasa) atau 'google' (dibuat lewat Google). Akun password yang
  -- DITAUTKAN ke Google tetap provider='password'.
  -- Keunikan google_id ditegakkan indeks unik di bawah (bukan UNIQUE
  -- pada kolom — ALTER TABLE ADD COLUMN tidak bisa membawa UNIQUE,
  -- jadi skema baru dan migrasi memakai cara yang sama).
  google_id        TEXT,
  avatar_url       TEXT,
  provider         TEXT NOT NULL DEFAULT 'password'
                   CHECK (provider IN ('password', 'google')),
  -- TIDAK ADA kolom preferensi/kunci resolusi di v1 ini. Keputusan pengguna
  -- 2026-11-15 ~06:55 WIB: kunci resolusi HANYA bila bisa ditegakkan lewat
  -- embed MegaPlay. Pengecekan (dokumen resmi megaplay.buzz/api + pencarian
  -- web, 2026-11-15): tidak ada parameter URL kualitas, tidak ada API
  -- embed, tidak ada perintah postMessage untuk kualitas; iframe lintas
  -- origin sehingga DOM pemutar tidak bisa dijangkau. Jadi kunci resolusi
  -- DIHAPUS sepenuhnya. Jangan tambahkan lagi kolom/endpoint kualitas tanpa
  -- bukti baru bahwa MegaPlay mendukungnya.
  created_at       INTEGER NOT NULL,
  last_login_at    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

-- Sesi server-side (cookie HttpOnly, bisa dicabut admin)
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,            -- token acak
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Cache terjemahan sinopsis Indonesia (v1.2.0, on-demand).
-- Satu baris per anime; source_hash membedakan bila sinopsis Inggris
-- berubah setelah sync ulang (bila berubah, diterjemahkan ulang).
-- Diisi HANYA saat halaman detail seri dibuka (tidak pernah batch ke
-- seluruh katalog). Bila layanan terjemah gagal, baris tidak dibuat dan
-- sinopsis Inggris tetap ditampilkan (fail soft).
CREATE TABLE IF NOT EXISTS synopsis_translations (
  anime_id        INTEGER PRIMARY KEY,  -- id Anikoto
  source_hash     TEXT NOT NULL,        -- sha256 (16 heks) sinopsis sumber
  source_text     TEXT NOT NULL,        -- sinopsis Inggris yang diterjemahkan
  translated_text TEXT NOT NULL,        -- sinopsis Indonesia hasil terjemahan
  provider        TEXT,                 -- 'google' | 'mymemory'
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Verifikasi email OTP (v1.3.0). Satu baris per pengiriman kode; kode
-- lama yang belum dipakai dihanguskan (used=1) saat kode baru diminta.
-- Kode disimpan sebagai SHA256 (bukan teks biasa) — bocornya DB tidak
-- langsung membocorkan kode yang masih berlaku.
CREATE TABLE IF NOT EXISTS email_verifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  email       TEXT NOT NULL,               -- alamat tujuan saat kode dikirim
  code_hash   TEXT NOT NULL,               -- sha256 heks dari kode 6 digit
  attempts    INTEGER NOT NULL DEFAULT 0,  -- percobaan konfirmasi yang salah
  used        INTEGER NOT NULL DEFAULT 0,  -- 1 = sudah dipakai / dihanguskan
  expires_at  INTEGER NOT NULL,           -- epoch detik (1 menit dari kirim)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ev_user ON email_verifications(user_id, created_at DESC);

-- Reset password (lupa password). Tabel TERPISAH dari
-- email_verifications secara sengaja: kode reset dan kode verifikasi
-- email tidak boleh bisa saling dipakai. Struktur meniru
-- email_verifications: kode SHA256, maks 5 percobaan, berlaku
-- 10 menit, kode baru menghanguskan kode lama (used=1).
CREATE TABLE IF NOT EXISTS password_resets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  email       TEXT NOT NULL,               -- alamat tujuan saat kode dikirim
  code_hash   TEXT NOT NULL,               -- sha256 heks dari kode 6 digit
  attempts    INTEGER NOT NULL DEFAULT 0,  -- percobaan reset yang salah
  used        INTEGER NOT NULL DEFAULT 0,  -- 1 = sudah dipakai / dihanguskan
  expires_at  INTEGER NOT NULL,            -- epoch detik (10 menit dari kirim)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_user ON password_resets(user_id, created_at DESC);

-- Progres tonton pengguna (server)
CREATE TABLE IF NOT EXISTS watch_progress (
  user_id       INTEGER NOT NULL REFERENCES users(id),
  anime_id      INTEGER NOT NULL,
  episode       INTEGER NOT NULL,
  position_sec  INTEGER NOT NULL DEFAULT 0,
  duration_sec  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, anime_id, episode)
);

-- Penghargaan EXP menonton (v1.3.1): sekali per episode per pengguna.
-- PRIMARY KEY rangkap menjamin tonton ulang episode yang sama = 0 EXP.
CREATE TABLE IF NOT EXISTS episode_exp_awards (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  anime_id   INTEGER NOT NULL,
  episode    INTEGER NOT NULL,
  awarded_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, anime_id, episode)
);

-- Favorit pengguna (server)
CREATE TABLE IF NOT EXISTS favorites (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  anime_id    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, anime_id)
);

-- Pengaturan situs (kunci admin)
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,            -- mis. "site_name"
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Log audit admin
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL,             -- mis. "flag_sub_indo", "user_update"
  target_type   TEXT,                      -- "transaction" | "user" | "anime" | "plan" | "setting"
  target_id     TEXT,
  detail        TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_admin ON admin_audit_log(admin_user_id, created_at DESC);

-- Cache subtitle Indonesia (v1.5.0, Server HD — PRD §6).
-- Satu baris per episode + versi sumber (source_hash membedakan bila
-- isi VTT Inggris berubah; cache lama tidak terpakai lagi, episode
-- diterjemahkan ulang — benar). Diisi saat stream-hd berhasil mengambil
-- VTT Inggris (header + source_cues); cue terjemahan masuk lewat
-- POST /api/vtt/save per batch. Dibuat otomatis saat init
-- (CREATE TABLE IF NOT EXISTS), jadi DB lama maupun DB seed baru
-- sama-sama mendapat tabel ini; TIDAK perlu migrasi terpisah.
CREATE TABLE IF NOT EXISTS subtitle_cache (
  anime_id        INTEGER NOT NULL,  -- id Anikoto
  episode         INTEGER NOT NULL,  -- nomor episode
  source_hash     TEXT NOT NULL,     -- sha256 (16 heks) isi VTT Inggris
  source_lang     TEXT NOT NULL DEFAULT 'en',
  source_cues     TEXT NOT NULL,     -- JSON array cue sumber [{index,start,end,text}]
  cue_count       INTEGER NOT NULL,  -- jumlah cue sumber
  translated_count INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'partial',  -- 'partial' | 'complete'
  created_at      INTEGER NOT NULL,  -- epoch detik
  updated_at      INTEGER NOT NULL,  -- epoch detik
  PRIMARY KEY (anime_id, episode, source_hash)
);
CREATE INDEX IF NOT EXISTS idx_subcache_episode ON subtitle_cache(anime_id, episode);

-- Satu baris per cue terjemahan (v1.5.0, PRD §6.2). start/end disimpan
-- milidetik bulat (hindari float di kunci); API memakai detik desimal.
CREATE TABLE IF NOT EXISTS subtitle_cues (
  anime_id        INTEGER NOT NULL,
  episode         INTEGER NOT NULL,
  source_hash     TEXT NOT NULL,
  cue_index       INTEGER NOT NULL,  -- posisi cue di VTT sumber
  start_ms        INTEGER NOT NULL,  -- awal cue (milidetik)
  end_ms          INTEGER NOT NULL,  -- akhir cue (milidetik)
  translated_text TEXT NOT NULL,     -- teks Indonesia
  updated_at      INTEGER NOT NULL,  -- epoch detik
  PRIMARY KEY (anime_id, episode, source_hash, cue_index)
);
