-- Skema database Mitsunime (PRD §5). Satu file: data/mitsunime.db.
-- Dijalankan otomatis oleh server/db/database.js saat server pertama hidup.
-- Dipakai ulang dari proyek NontonAnime (cache + FTS5) ditambah tabel akun,
-- premium, dan admin. File DB tidak ikut zip; dibuat ulang lewat seed.

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
  sub_indo_verified_at INTEGER,
  premium_only  INTEGER NOT NULL DEFAULT 0   -- 1 = seluruh judul hanya dibuka pengguna premium (diatur admin)
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
  is_premium       INTEGER NOT NULL DEFAULT 0,
  premium_until    INTEGER,                 -- epoch detik; NULL bila bukan premium
  -- Level + EXP (v1.3.1): total EXP pengguna; level dihitung dari sini
  -- (100 EXP = 1 level, maks level 100; admin selalu level 1000).
  exp_total        INTEGER NOT NULL DEFAULT 0,
  -- Avatar preset profil (v1.3.2): salah satu kode di
  -- server/services/avatars.js ('lime', 'emas', ...); NULL = avatar
  -- huruf default (latar gelap + huruf lime, seperti sebelum v1.3.2).
  avatar           TEXT,
  -- TIDAK ADA kolom preferensi/kunci resolusi di v1 ini. Keputusan pengguna
  -- 2026-11-15 ~06:55 WIB: kunci resolusi HANYA bila bisa ditegakkan lewat
  -- embed MegaPlay. Pengecekan (dokumen resmi megaplay.buzz/api + pencarian
  -- web, 2026-11-15): tidak ada parameter URL kualitas, tidak ada API
  -- embed, tidak ada perintah postMessage untuk kualitas; iframe lintas
  -- origin sehingga DOM pemutar tidak bisa dijangkau. Jadi kunci resolusi
  -- DIHAPUS sepenuhnya — premium v1 = aksesori profil saja, tanpa konten
  -- terkunci. Jangan tambahkan lagi kolom/endpoint kualitas tanpa bukti
  -- baru bahwa MegaPlay mendukungnya.
  equipped_border      INTEGER REFERENCES accessories(id),
  equipped_background  INTEGER REFERENCES accessories(id),
  equipped_frame       INTEGER REFERENCES accessories(id),
  equipped_badge       INTEGER REFERENCES accessories(id),
  equipped_name_effect INTEGER REFERENCES accessories(id),
  created_at       INTEGER NOT NULL,
  last_login_at    INTEGER
);

-- Sesi server-side (cookie HttpOnly, bisa dicabut admin)
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,            -- token acak
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Paket premium
CREATE TABLE IF NOT EXISTS plans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,             -- mis. "Premium 1 Bulan"
  price_idr     INTEGER NOT NULL,          -- harga dalam rupiah
  duration_days INTEGER NOT NULL,          -- mis. 30
  description   TEXT,
  active        INTEGER NOT NULL DEFAULT 1
);
-- Paket bawaan dari template Dark Lime (keputusan pengguna 2026-11-15):
-- Premium 1 Bulan Rp29.000 untuk 30 hari. Admin bisa ubah/tambah/nonaktifkan.
INSERT OR IGNORE INTO plans (id, name, price_idr, duration_days, description) VALUES
  (1, 'Premium 1 Bulan', 29000, 30, 'Aksesori profil premium: border, background, bingkai avatar, lencana, dan efek nama selama 30 hari. Tidak ada konten yang terkunci.');
-- v1.2.0: dua paket tambahan (keputusan pengguna 2026-11-15 ~14:03 WIB).
-- Sisipan berbasis nama (WHERE NOT EXISTS) supaya idempotent dan tidak
-- duplikasi bila dijalankan berulang atau pada DB yang sudah ada; paket
-- lama tidak diubah. Pemberian premium memakai duration_days paket yang
-- dibeli (lihat routes/admin.js handleApproveTx → grantPremium).
-- Deskripsi mengikuti TIERING benefit (keputusan pengguna 2026-11-15
-- ~14:25 WIB): 7 hari = border+background (6 aksesori), 15 hari =
-- +frame avatar (9), 1 bulan = semua 14 (badge + efek nama eksklusif).
INSERT INTO plans (name, price_idr, duration_days, description)
SELECT 'Premium 7 Hari', 10000, 7, 'Aksesori profil premium: bingkai dan latar profil (6 aksesori) selama 7 hari. Tidak ada konten yang terkunci.'
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE name = 'Premium 7 Hari');
INSERT INTO plans (name, price_idr, duration_days, description)
SELECT 'Premium 15 Hari', 19000, 15, 'Aksesori profil premium: bingkai, latar, dan bingkai avatar (9 aksesori) selama 15 hari. Tidak ada konten yang terkunci.'
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE name = 'Premium 15 Hari');

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

-- Kode diskon admin (v1.3.0). percent 1–99. plan_id NULL = berlaku untuk
-- semua paket aktif; bila terisi, kode hanya berlaku untuk paket itu.
-- max_uses NULL = tanpa batas pakai; used_count naik HANYA saat transaksi
-- dibuat dengan kode valid (bukan saat validate, bukan saat transaksi
-- gagal dibuat). expires_at NULL = tidak kadaluarsa.
CREATE TABLE IF NOT EXISTS discount_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,        -- disimpan huruf besar (mis. 'HEMAT10')
  percent     INTEGER NOT NULL CHECK (percent BETWEEN 1 AND 99),
  plan_id     INTEGER REFERENCES plans(id),
  max_uses    INTEGER,
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dc_code ON discount_codes(code);

-- Transaksi premium (gateway Midtrans, diaktifkan admin)
CREATE TABLE IF NOT EXISTS premium_transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  plan_id       INTEGER NOT NULL REFERENCES plans(id),
  amount_idr    INTEGER NOT NULL,          -- harga saat transaksi dibuat
  -- Diskon (v1.3.0): amount_idr SELALU harga SETELAH diskon — ke
  -- Midtrans pun dikirim harga diskon, dan webhook M1 mencocokkan
  -- gross_amount dengan amount_idr ini. original_amount_idr = harga
  -- paket sebelum diskon (NULL bila tanpa kode), supaya admin bisa
  -- melihat berapa yang dipotong.
  discount_code      TEXT,
  discount_percent   INTEGER,
  original_amount_idr INTEGER,
  method        TEXT NOT NULL,             -- 'midtrans' (gateway; dipakai ulang nanti bila ganti adapter)
  proof_ref     TEXT,                      -- nomor referensi / keterangan bukti bayar dari pengguna
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),
  -- Status bayar di gateway, terpisah dari status persetujuan admin:
  -- 'unpaid' = belum dibayar di Midtrans, 'paid' = Midtrans mengonfirmasi
  -- (lewat confirm/webhook), 'failed'/'expired' = bayar gagal/kadaluarsa.
  -- Admin hanya menyetujui transaksi yang payment_status-nya 'paid'.
  payment_status TEXT NOT NULL DEFAULT 'unpaid'
                CHECK (payment_status IN ('unpaid','paid','failed','expired')),
  gateway_order_id TEXT,                   -- order_id yang dikirim ke Midtrans
  gateway_status   TEXT,                   -- status terakhir dari Midtrans (mis. 'settlement')
  payment_url      TEXT,                   -- tautan bayar Midtrans (Snap redirect_url)
  proof_file       TEXT,                   -- nama file bukti bayar manual (data/proofs/, nama acak); NULL bila Midtrans atau tanpa bukti gambar
  created_at    INTEGER NOT NULL,
  decided_by    INTEGER REFERENCES users(id),
  decided_at    INTEGER,
  note          TEXT                       -- catatan admin saat menolak/menyetujui
);
CREATE INDEX IF NOT EXISTS idx_tx_status ON premium_transactions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_user   ON premium_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_gateway ON premium_transactions(gateway_order_id);

-- Katalog aksesori profil (dikelola admin; premium membuka set premium_only)
CREATE TABLE IF NOT EXISTS accessories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,      -- mis. 'border-lime-neon' (dipakai sebagai token CSS oleh Frontend)
  name          TEXT NOT NULL,             -- nama yang tampil di UI
  kind          TEXT NOT NULL CHECK (kind IN ('border','background','frame','badge','name_effect')),
  asset         TEXT,                      -- token/kelas CSS atau URL aset; boleh NULL
  premium_only  INTEGER NOT NULL DEFAULT 0, -- 1 = hanya dibuka pengguna premium
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
-- Aksesori milik pengguna (diberikan saat premium disetujui; tetap ada saat
-- premium habis, tetapi pemakaian premium_only diblokir saat tidak premium)
CREATE TABLE IF NOT EXISTS user_accessories (
  user_id       INTEGER NOT NULL REFERENCES users(id),
  accessory_id  INTEGER NOT NULL REFERENCES accessories(id),
  acquired_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, accessory_id)
);
CREATE INDEX IF NOT EXISTS idx_ua_user ON user_accessories(user_id);

-- Katalog bawaan: satu set premium (dibuka saat premium disetujui).
INSERT OR IGNORE INTO accessories (id, code, name, kind, asset, premium_only, active, created_at) VALUES
  (1,  'border-lime-neon',   'Bingkai Lime Neon',    'border',     'acc-border-lime-neon',   1, 1, strftime('%s','now')),
  (2,  'border-emas',        'Bingkai Emas',         'border',     'acc-border-emas',        1, 1, strftime('%s','now')),
  (3,  'border-gelap',       'Bingkai Gelap',        'border',     'acc-border-gelap',       1, 1, strftime('%s','now')),
  (4,  'bg-lime',            'Latar Lime',           'background', 'acc-bg-lime',            1, 1, strftime('%s','now')),
  (5,  'bg-bintang',         'Latar Bintang',        'background', 'acc-bg-bintang',         1, 1, strftime('%s','now')),
  (6,  'bg-gelap',           'Latar Gelap',          'background', 'acc-bg-gelap',           1, 1, strftime('%s','now')),
  (7,  'frame-pochita',      'Bingkai Avatar Pochita','frame',     'acc-frame-pochita',      1, 1, strftime('%s','now')),
  (8,  'frame-neon',         'Bingkai Avatar Neon',  'frame',      'acc-frame-neon',         1, 1, strftime('%s','now')),
  (9,  'frame-klasik',       'Bingkai Avatar Klasik','frame',      'acc-frame-klasik',       1, 1, strftime('%s','now')),
  (10, 'badge-premium',      'Lencana Premium',      'badge',      'acc-badge-premium',      1, 1, strftime('%s','now')),
  (11, 'badge-setia',        'Lencana Penonton Setia','badge',     'acc-badge-setia',        1, 1, strftime('%s','now')),
  (12, 'badge-kolektor',     'Lencana Kolektor',     'badge',      'acc-badge-kolektor',     1, 1, strftime('%s','now')),
  (13, 'nama-kilau',         'Efek Nama Kilau',      'name_effect','acc-nama-kilau',         1, 1, strftime('%s','now')),
  (14, 'nama-lime',          'Efek Nama Lime',       'name_effect','acc-nama-lime',          1, 1, strftime('%s','now'));

-- Pemetaan paket → aksesori (TIERING benefit v1.2.0, keputusan pengguna
-- 2026-11-15 ~14:25 WIB): 7 hari = border+background (id 1-6), 15 hari =
-- +frame avatar (id 1-9), 1 bulan = semua 14 (badge + efek nama hanya di
-- paket 30 hari). Berbasis NAMA paket (bukan id) supaya idempotent di DB
-- lama maupun baru; INSERT OR IGNORE + PRIMARY KEY (plan_id,
-- accessory_id) mencegah duplikasi bila dijalankan berulang. Id aksesori
-- 1-14 tetap dari seed di atas, jadi rentang BETWEEN aman.
CREATE TABLE IF NOT EXISTS plan_accessories (
  plan_id       INTEGER NOT NULL REFERENCES plans(id),
  accessory_id  INTEGER NOT NULL REFERENCES accessories(id),
  PRIMARY KEY (plan_id, accessory_id)
);
INSERT OR IGNORE INTO plan_accessories (plan_id, accessory_id)
  SELECT p.id, a.id FROM plans p, accessories a
  WHERE p.name = 'Premium 7 Hari' AND a.id BETWEEN 1 AND 6;
INSERT OR IGNORE INTO plan_accessories (plan_id, accessory_id)
  SELECT p.id, a.id FROM plans p, accessories a
  WHERE p.name = 'Premium 15 Hari' AND a.id BETWEEN 1 AND 9;
INSERT OR IGNORE INTO plan_accessories (plan_id, accessory_id)
  SELECT p.id, a.id FROM plans p, accessories a
  WHERE p.name = 'Premium 1 Bulan' AND a.id BETWEEN 1 AND 14;

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
  key         TEXT PRIMARY KEY,            -- mis. "premium_new_days", "payment_methods"
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
-- Isi awal settings
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('premium_new_days', '7', strftime('%s','now')),
  -- Cara bayar utama: MANUAL QRIS (keputusan pengguna 2026-11-15 ~07:52 WIB).
  -- 'manual' = tampilkan kode QRIS, verifikasi oleh admin; 'midtrans' =
  -- gateway otomatis (opsi, tetap jalan). Nilai ini dibaca Frontend dari
  -- GET /api/premium/qris untuk memilih alur bayar yang ditampilkan.
  ('payment_gateway', 'manual', strftime('%s','now')),
  -- Metode bayar yang tampil: QRIS manual (admin mengunggah kode QRIS).
  ('payment_methods', 'QRIS Manual', strftime('%s','now'));

-- Log audit admin
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL,             -- mis. "approve_transaction", "set_premium", "flag_sub_indo"
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
