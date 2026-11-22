/* ============================================================
   watch.js — Halaman tonton Mitsunime (v1.5.1: Server HD MegaPlay + Sub Indo)
   - Server HD (default): player <video> + hls.js (file vendor, lazy)
     memutar HLS MegaPlay lewat proxy origin sendiri; subtitle
     Indonesia (AI) diterjemahkan progresif di browser (subs.js) dan
     di-cache di server. v1.5.1 (T5): player DIPATOK mulai dari
     varian bitrate TERENDAH (hls.js mengurutkan level MENAIK menurut
     bitrate — startLevel: 0 = terendah, terverifikasi via probe;
     master MegaPlay sendiri mengurutkan tertinggi dulu).
   - Pemilih server banyak (satu <select> + tombol "Ganti Server"):
     Server HD, MegaPlay, VidCloud, AniEmbed, TryEmbed, Nontongo.
     Daftar server HANYA dari endpoint stream (servers.js) — frontend
     tidak pernah membangun URL dari ID.
   - MegaPlay tetap <iframe> seperti sebelumnya, termasuk rantai
     fallback internal s-2 → mal → ani SEBELUM pindah ke server
     berikut. postMessage MegaPlay (time/complete/error) tidak berubah.
   - Iframe non-MegaPlay: tidak ada postMessage — "gagal" hanya dari
     load yang tidak terjadi; bila sudah load, overlay hilang setelah
     grace 3 detik. Progres/complete/auto-next HANYA di Server HD dan
     MegaPlay (PRD §9.5).
   - Overlay loading TETAP menutupi player sampai ada bukti player
     hidup (video `playing` + currentTime > 0, atau postMessage time
     > 0). Timer: 15 detik tanpa bukti = server gagal; timer keras
     30 detik sebagai backstop anti-deadlock.
   - Menonton tanpa login (v1.4.5): tamu memutar seperti biasa;
     progres / riwayat / complete HANYA dikirim bila login.
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  mountChrome('home');
  var params = new URLSearchParams(window.location.search);
  var id = params.get('id');
  var ep = parseInt(params.get('ep') || '1', 10) || 1;
  var lang = params.get('lang') === 'dub' ? 'dub' : 'sub';
  if (!id) {
    document.getElementById('watch-main').innerHTML =
      stateHTML('empty', 'Anime tidak ditemukan', 'Tautan tonton tidak membawa ID anime.', 'Kembali ke Beranda', '/');
    return;
  }
  initWatch(id, ep, lang);
});

var PAGE_SIZE = 50;
var PLAYER_TIMEOUT_MS = 15000; /* tiap server: 15 detik tanpa bukti player hidup = gagal */
var PLAYER_HARD_TIMEOUT_MS = 30000; /* timer keras: 30 detik sejak playServer, bila overlay
  loading masih tampil → coba server berikutnya.
  TIDAK boleh dibersihkan oleh pesan postMessage apa pun (hanya oleh
  bukti putar / overlay error / ganti server-episode). */
var AUTONEXT_SECONDS = 5;
var watch = {
  anime: null, episodes: [], epNum: 1, lang: 'sub',
  servers: [], serverIdx: 0, currentEp: null,
  autonextTimer: null, autonextLeft: AUTONEXT_SECONDS,
  lastSave: 0, shown: PAGE_SIZE, jump: 0, asc: true,
  playerTimer: null, playerHardTimer: null, hasPlayed: false, playerAlive: false,
  playedServerIdx: -1, /* server tempat bukti putar pertama tercatat */
  failedServers: [], overlayKind: null, /* 'loading' | 'error' | null */
  progress: {}, progressPromise: null, /* janji loadProgress() — ditunggu loadEpisode supaya resume tidak membaca progres kosong (fix F-02) */
  expReported: {}, /* episode yang sudah dilaporkan selesai (anti-duplikat) */
  loggedIn: false, /* v1.4.5: diisi initWatch — tamu tidak mengirim progres/complete ke server */
  /* v1.5.0: Server HD + pemilih multi-server */
  hd: null, subs: null, subMode: 'id', subStatus: null, subHasEn: false,
  mpUrls: null, mpIdx: 0, mpNames: [], mpFallbacks: [],
  hdResolvedOnce: false, hlsLoading: null,
};

function clearPlayerTimer() {
  if (watch.playerTimer) { clearTimeout(watch.playerTimer); watch.playerTimer = null; }
}
function clearPlayerHardTimer() {
  if (watch.playerHardTimer) { clearTimeout(watch.playerHardTimer); watch.playerHardTimer = null; }
}

async function initWatch(id, epNum, lang) {
  watch.epNum = epNum;
  watch.lang = lang;
  try {
    /* v1.4.5: tamu boleh menonton — status login hanya menentukan
       apakah progres / riwayat / complete dikirim ke server. */
    watch.loggedIn = !!(await currentUser());
    var res = await getSeries(id);
    if (!res.anime) {
      document.getElementById('watch-main').innerHTML =
        stateHTML('empty', 'Anime tidak ditemukan', 'Anime dengan ID ' + id + ' tidak ada di katalog.', 'Kembali ke Beranda', '/');
      return;
    }
    watch.anime = res.anime;
    watch.episodes = (res.episodes || []).slice().sort(function (a, b) { return (a.number || 0) - (b.number || 0); });
    if (res.stale) showBanner('warning', staleBannerText(res.anikotoDown));
    renderWatchHead();
    renderEpisodeList();
    /* v1.5.4 fix F-02: progres HARUS selesai dimuat sebelum episode
       dimuat — posisi tersimpan dipakai sebagai resume saat muat awal. */
    watch.progressPromise = loadProgress();
    loadRelated(watch.anime);
    await watch.progressPromise;
    loadEpisode(watch.epNum, watch.lang);
  } catch (err) {
    if (err && err.status === 401) {
      document.getElementById('watch-main').innerHTML =
        stateHTML('empty', 'Masuk dulu untuk menonton', 'Sesi login Anda sudah habis. Masuk lagi untuk melanjutkan.', 'Masuk / Daftar', '/account.html?mode=login');
      return;
    }
    document.getElementById('watch-main').innerHTML =
      stateHTML('error', 'Halaman tonton gagal dimuat', (err && err.message) || 'Terjadi kesalahan.', 'Muat Ulang', window.location.href);
  }
}

function findEpisode(num) {
  return watch.episodes.find(function (ep) { return ep.number === num; }) || null;
}

function renderWatchHead() {
  var a = watch.anime;
  var score = scoreNum(a);
  document.title = decodeEntities(displayTitle(a) || 'Tonton') + ' — Mitsunime';
  var titleEl = document.getElementById('watch-title');
  if (titleEl) titleEl.textContent = decodeEntities(displayTitle(a) || 'Tonton');
  var dubTab = document.querySelector('#lang-tabs .tab[data-lang="dub"], #lang-tabs .lang-tab[data-lang="dub"]');
  if (dubTab && (parseInt(a.is_dub, 10) || 0) === 0) dubTab.disabled = true;

  document.querySelectorAll('#lang-tabs .lang-tab').forEach(function (tab) {
    tab.classList.toggle('is-active', tab.getAttribute('data-lang') === watch.lang);
    tab.addEventListener('click', function () {
      if (tab.disabled) return;
      switchLang(tab.getAttribute('data-lang'));
    });
  });

  var btnPrev = document.getElementById('btn-prev');
  if (btnPrev) btnPrev.addEventListener('click', function () { goEpisode(watch.epNum - 1); });
  var btnNext = document.getElementById('btn-next');
  if (btnNext) btnNext.addEventListener('click', function () { goEpisode(watch.epNum + 1); });
  var btnServer = document.getElementById('btn-change-server');
  if (btnServer) btnServer.addEventListener('click', function () { cycleServer(); });
  var btnCancel = document.getElementById('btn-cancel-autonext');
  if (btnCancel) btnCancel.addEventListener('click', cancelAutoNext);
  var btnNow = document.getElementById('btn-autonext-now');
  if (btnNow) btnNow.addEventListener('click', function () { cancelAutoNext(); goEpisode(watch.epNum + 1); });
  var btnSort = document.getElementById('btn-ep-sort');
  if (btnSort) btnSort.addEventListener('click', function () {
    watch.asc = !watch.asc;
    btnSort.textContent = watch.asc ? 'Urutan: Naik' : 'Urutan: Turun';
    renderEpisodeList();
  });

  window.addEventListener('message', onPlayerMessage);
  wirePlayerControls();
}

/* ---------- Kontrol player: video HD, iframe, pemilih server ---------- */
function wirePlayerControls() {
  var serverSel = document.getElementById('server-select');
  if (serverSel) serverSel.addEventListener('change', function () {
    var key = serverSel.value;
    var idx = -1;
    for (var i = 0; i < watch.servers.length; i++) {
      if (watch.servers[i].key === key) { idx = i; break; }
    }
    if (idx === -1 || idx === watch.serverIdx) return;
    watch.failedServers = [];
    playServer(idx);
  });

  var subSel = document.getElementById('sub-select');
  if (subSel) subSel.addEventListener('change', function () {
    setSubMode(subSel.value);
  });

  var qSel = document.getElementById('quality-select');
  if (qSel) qSel.addEventListener('change', function () {
    var hls = watch.hd && watch.hd.hls;
    if (!hls) return;
    var v = parseInt(qSel.value, 10);
    hls.nextLevel = isNaN(v) ? -1 : v;
  });

  var btnSkipIntro = document.getElementById('btn-skip-intro');
  if (btnSkipIntro) btnSkipIntro.addEventListener('click', function () {
    var video = document.getElementById('player-video');
    var d = watch.hd && watch.hd.manifest;
    if (video && d && d.intro) { try { video.currentTime = d.intro.end; } catch (e) {} }
  });
  var btnSkipOutro = document.getElementById('btn-skip-outro');
  if (btnSkipOutro) btnSkipOutro.addEventListener('click', function () {
    var video = document.getElementById('player-video');
    var d = watch.hd && watch.hd.manifest;
    if (video && d && d.outro) { try { video.currentTime = d.outro.end; } catch (e) {} }
  });

  var video = document.getElementById('player-video');
  if (video) {
    video.addEventListener('playing', function () {
      var srv = watch.servers[watch.serverIdx];
      if (!srv || srv.kind !== 'hd') return;
      if (video.currentTime > 0) markPlayerAlive();
      if (watch.subs) watch.subs.markPlaying();
    });
    video.addEventListener('timeupdate', function () {
      var srv = watch.servers[watch.serverIdx];
      if (!srv || srv.kind !== 'hd') return;
      var t = video.currentTime || 0;
      var dur = video.duration || 0;
      if (t > 0 && !watch.playerAlive) markPlayerAlive();
      if (watch.subs) watch.subs.onTimeUpdate(t);
      updateSkipButtons(t);
      var now = Date.now();
      var percent = dur > 0 ? (t / dur) * 100 : 0;
      if (now - watch.lastSave > 10000 || percent >= 95) {
        watch.lastSave = now;
        if (watch.currentEp) saveContinue(watch.anime, watch.currentEp, { lang: watch.lang, percent: percent, time: t, duration: dur });
      }
    });
    video.addEventListener('seeked', function () {
      var srv = watch.servers[watch.serverIdx];
      if (!srv || srv.kind !== 'hd') return;
      if (watch.subs) watch.subs.prioritize(video.currentTime || 0);
    });
    video.addEventListener('ended', function () {
      var srv = watch.servers[watch.serverIdx];
      if (!srv || srv.kind !== 'hd') return;
      onWatchComplete();
    });
    /* Rework item 2 (natif): Chrome mengaktifkan sendiri track
       Inggris ~1 dtk setelah video JALAN masuk fullscreen
       (auto-caption) — tanpa ini subtitle ganda di fullscreen
       (Inggris natif + Indonesia natif). Tegakkan kembali mode
       yang benar setiap kali ada mode track yang berubah.
       applySubMode() idempotent — mode yang sudah benar tidak
       memicu event lagi, jadi tidak ada loop. */
    video.textTracks.addEventListener('change', function () {
      applySubMode();
    });
    video.addEventListener('error', function () {
      var srv = watch.servers[watch.serverIdx];
      if (!srv || srv.kind !== 'hd') return;
      /* video.load() setelah src dibersihkan juga memicu error dengan
         currentSrc kosong — bukan kegagalan nyata, abaikan. */
      if (!video.currentSrc) return;
      if (watch.playerAlive) return;
      if (!watch.hdResolvedOnce) {
        watch.hdResolvedOnce = true;
        playHdServer(srv, video.currentTime || 0);
        return;
      }
      onServerFailed('Server Mitsunime gagal memutar video');
      tryNextServer(false);
    });
    /* Item 12 (v1.5.3, T3): watchdog interval v1.5.2 DIHAPUS (§4.2).
       Penggantinya dua pemicu peristiwa di bawah (dropCueOnce):
       (a) hideCustomControls() saat bar custom hilang, dan
       (b) listener 'cuechange' pada track yang showing — keduanya
       SATU spaced toggle (disabled → ~50 ms → showing) dengan flag
       penekan applySubMode. Tanpa interval apa pun. */
  }

  var iframe = document.getElementById('player-iframe');
  if (iframe) iframe.addEventListener('load', function () {
    var srv = watch.servers[watch.serverIdx];
    if (!srv || srv.kind !== 'iframe' || srv.key === 'megaplay') return;
    if (watch.playerAlive) return;
    var idx = watch.serverIdx;
    /* Iframe non-MegaPlay tidak mengirim bukti putar — bila sudah
       load, player terlihat = dianggap jalan (grace 3 dtk). */
    setTimeout(function () {
      if (watch.overlayKind !== 'loading') return;
      if (watch.serverIdx !== idx) return;
      var cur = watch.servers[watch.serverIdx];
      if (!cur || cur.kind !== 'iframe' || cur.key === 'megaplay') return;
      if (watch.playerAlive) return;
      watch.playerAlive = true;
      watch.hasPlayed = true;
      watch.playedServerIdx = watch.serverIdx;
      clearPlayerTimer();
      hidePlayerOverlay();
    }, 3000);
  });

  /* v1.5.3 item 13: kontrol player custom (gagal init → kontrol
     natif kembali, §5.6). */
  initCustomControls();
}

/* ---------- Kontrol player custom (v1.5.3 item 13) ----------
   Menggantikan kontrol bawaan Chrome HANYA untuk Server HD.
   Bar + menu adalah satu unit dengan satu timer auto-hide ~3,6 dtk
   (disamakan dengan timing hide kontrol natif). State tampil/hilang
   di satu tempat (cc.visible) — dibaca pemicu item 12 (T3).
   Item 47 (v1.5.8): timer DITANGGUHKAN selama menu terbuka
   (armHideTimer no-op saat cc.menuOpen; hideCustomControls menolak
   menyembunyikan bar) — menu menutup hanya lewat 5 jalur, lihat
   closePlayerMenu().
   Bila init gagal (exception apa pun), video mendapat kembali
   atribut controls (kontrol natif) — video tidak pernah tanpa
   kontrol (§5.6). */
var CC_HIDE_MS = 3600;
var CC_DBLTAP_MS = 300;
var CC_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
var cc = {
  enabled: false, visible: false, overlayUp: false, menuOpen: false,
  video: null, player: null, bar: null, menu: null, center: null,
  hideTimer: null, lastTapAt: 0, lastTapX: 0, lastTapSide: 0,
  scrubbing: false, suppressApply: false, dropPending: false,
  dropInFlight: false, dropLastAt: 0, dropCount: 0, applyDeferred: false,
  inited: false, failed: false,
  menuDrag: null, dragEndAt: 0, /* v1.5.8 item 46: status drag menu */
};

function ccEl(id) { return document.getElementById(id); }

function fallbackNativeControls() {
  cc.failed = true;
  cc.enabled = false;
  var v = cc.video || ccEl('player-video');
  if (v) { try { v.setAttribute('controls', ''); } catch (e) {} }
  ['player-bar', 'player-menu', 'player-center'].forEach(function (id) {
    var el = ccEl(id);
    if (el) el.hidden = true;
  });
}

function refreshBarDom() {
  if (!cc.bar || !cc.center || !cc.video) return;
  cc.bar.hidden = !(cc.enabled && cc.visible && !cc.overlayUp);
  /* Item 48 H2 (v1.5.8, T3): tombol play tengah tampil saat pause —
     JUGA di atas overlay loading (bukan overlay error): saat video
     mentok "Memuat video..." dalam keadaan jeda, pengguna tetap
     punya tombol untuk mencoba lagi. Kelas --over-overlay menaikkan
     z-index di atas overlay (5). */
  var overLoading = cc.overlayUp && typeof watch !== 'undefined' && watch.overlayKind === 'loading';
  cc.center.hidden = !(cc.enabled && cc.video.paused && (!cc.overlayUp || overLoading));
  if (cc.center.classList) cc.center.classList.toggle('player__center--over-overlay', overLoading && !cc.center.hidden);
}

function clearHideTimer() {
  if (cc.hideTimer) { clearTimeout(cc.hideTimer); cc.hideTimer = null; }
}
function armHideTimer() {
  clearHideTimer();
  if (cc.menuOpen) return; /* v1.5.8 item 47: timer auto-hide DITANGGUHKAN selama menu ⋮ terbuka */
  if (!cc.video || cc.video.paused) return; /* pause: bar tetap tampil */
  cc.hideTimer = setTimeout(function () { cc.hideTimer = null; hideCustomControls(); }, CC_HIDE_MS);
}
function resetHideTimer() { if (cc.visible) armHideTimer(); }

function showCustomControls() {
  if (!cc.enabled || cc.failed || !cc.video) return;
  cc.visible = true;
  refreshBarDom();
  armHideTimer();
}
function hideCustomControls() {
  if (cc.menuOpen) return; /* v1.5.8 item 47: bar ditahan tampil selama menu terbuka */
  var wasVisible = cc.visible;
  cc.visible = false;
  closePlayerMenu('autohide');
  clearHideTimer();
  refreshBarDom();
  /* T3 (a): bar baru saja hilang → SATU spaced toggle supaya cue
     aktif langsung turun (hanya bila bar memang sedang tampil;
     bila sudah hilang, ini bukan peristiwa hide baru). */
  if (wasVisible) dropCueOnce('hide');
}

/* ---------- Item 12 (T3): subtitle langsung turun — spaced toggle ----------
   Chrome TIDAK memosisikan ulang cue aktif saat kontrol hilang; cue
   tetap terangkat sampai update internal Chrome berikutnya. Satu
   toggle mode (disabled → ~50 ms → showing) memaksa Chrome me-render
   ulang cue aktif sesuai keadaan kontrol SAAT ITU. Dua pemicu (§4.2):
   (a) hideCustomControls() saat bar hilang; (b) 'cuechange' pada track
   yang showing selagi kontrol hilang (cue baru mulai). Larangan §4.2:
   tanpa interval, tanpa toggle saat kontrol tampil / pause / tidak
   ada track showing / lebih dari 1× per peristiwa.
   - suppressApply: listener 'change' di textTracks memanggil
     applySubMode() yang akan menghidupkan lagi track dalam ~2 ms
     (T17 Exp 5) — flag ini menekannya selama jeda 50 ms.
   - dropInFlight + cooldown 200 ms: mencegah toggle berulang dari
     cuechange yang dipicu toggle itu sendiri (mode disabled/showing
     memicu cuechange) dan dari dua cue yang mulai hampir bersamaan
     (item 17) — satu toggle me-render ulang SEMUA cue aktif (§4.6). */
function dropCueOnce(reason) {
  var video = cc.video;
  if (!video || !cc.enabled || cc.failed) return false;
  if (video.paused) return false;
  if (cc.dropInFlight) return false;
  var now = performance.now();
  if (now - cc.dropLastAt < 200) return false;
  var target = null;
  for (var i = 0; i < video.textTracks.length; i++) {
    var tt = video.textTracks[i];
    if (tt.mode === 'showing' && tt.activeCues && tt.activeCues.length > 0) { target = tt; break; }
  }
  if (!target) return false;
  cc.dropInFlight = true;
  cc.dropLastAt = now;
  cc.dropCount++;
  cc.suppressApply = true;
  try { target.mode = 'disabled'; } catch (e) {}
  setTimeout(function () {
    try { target.mode = 'showing'; } catch (e) {}
    cc.suppressApply = false;
    cc.dropInFlight = false;
  }, 50);
  return true;
}

/* Pemicu (b): cuechange pada track yang showing. Diikat SATU KALI per
   objek TextTrack (marker _mitsuCueDrop) — rebuildTrack() membuat
   elemen <track> baru tiap batch, jadi track baru mendapat ikatan
   baru lewat applySubMode() yang memanggil bindCueDrop(). */
function bindCueDrop(track) {
  if (!track || track._mitsuCueDrop) return;
  track._mitsuCueDrop = true;
  track.addEventListener('cuechange', function () {
    if (cc.visible) return; /* kontrol tampil: cue memang terangkat */
    if (!cc.enabled || cc.failed) return;
    var video = cc.video;
    if (!video || video.paused) return;
    dropCueOnce('cuechange');
  });
}
function setCustomBarEnabled(on) {
  cc.enabled = !!on && !cc.failed;
  if (!cc.enabled) {
    cc.visible = false;
    closePlayerMenu('server');
    clearHideTimer();
  }
  refreshBarDom();
}

function openPlayerMenu() {
  if (!cc.enabled || cc.failed || !cc.menu) return;
  resetMenuPosition(); /* item 46: tiap buka, posisi kembali default */
  cc.menuOpen = true;
  cc.menu.hidden = false;
  var btn = ccEl('player-menu-btn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  clearHideTimer(); /* item 47: timer ditangguhkan selama menu terbuka */
}
/* v1.5.8 item 47 — menu menutup HANYA lewat 5 jalur (§4.9.3 butir 3):
   outside / toggle / esc / server / overlay / fullscreen. Alasan lain
   ('select', 'sub-*', 'autohide') DIABAIKAN: memilih isi menu tidak
   lagi menutup menu. Penegakan terpusat di sini — subprefs.js masih
   memanggil window.closePlayerMenu('sub-*') dan pemilih Bahasa/
   Kecepatan lama memanggil 'select'; semuanya menjadi no-op di sini,
   jadi subprefs.js tidak perlu diubah. */
var MENU_CLOSE_ALLOWED = { outside: 1, toggle: 1, esc: 1, server: 1, overlay: 1, fullscreen: 1 };
function closePlayerMenu(reason) {
  if (!cc.menuOpen) return;
  if (!MENU_CLOSE_ALLOWED[reason]) return; /* item 47: abaikan */
  cc.menuOpen = false;
  if (cc.menu) cc.menu.hidden = true;
  var btn = ccEl('player-menu-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  resetMenuPosition(); /* item 46: posisi kembali default tiap tutup */
  /* item 47 butir 4: sesudah menu tertutup, timer 3,6 dtk jalan lagi. */
  if (cc.visible) armHideTimer();
}
function togglePlayerMenu() {
  if (cc.menuOpen) closePlayerMenu('toggle');
  else openPlayerMenu();
}
/* Dipakai subprefs.js (menu Subtitle): closePlayerMenu() kini
   menegakkan aturan item 47 — panggilan 'sub-*' (pilih font/warna,
   Atur Ulang) DIABAIKAN, menu tetap terbuka. resetCustomHideTimer
   tetap ada; saat menu terbuka armHideTimer() menjadi no-op. */
window.closePlayerMenu = closePlayerMenu;
/* Dipakai subprefs.js (T2): interaksi di dalam menu (drag slider,
   memilih warna) me-reset timer auto-hide — §5.8 (d) alasan 3.
   Saat menu terbuka, reset ini no-op (item 47: timer ditangguhkan). */
window.resetCustomHideTimer = resetHideTimer;

/* ---------- Item 46 (v1.5.8, T2): drag menu ⋮ ----------
   Gagang #player-menu-grip (bukan seluruh menu) yang bisa diseret —
   pointer events (sentuh + mouse); gulir isi menu + geser slider
   tetap jalan karena drag hanya dari gagang. Posisi dijepit di dalam
   player (min 40 px menu tetap terlihat tiap sisi); posisi TIDAK
   disimpan — tiap buka/tutup kembali ke default (resetMenuPosition).
   Selama drag, timer ditahan + menu tidak menutup; klik yang muncul
   sesudah drag (pointerup di luar menu) ditelan supaya tidak diartikan
   sebagai ketuk-di-luar (item 47). */
var MENU_DRAG_MIN_VISIBLE = 40;
var MENU_DRAG_KEY_STEP = 16;
function menuDragParentRect() {
  var parent = (cc.menu && cc.menu.offsetParent) || cc.player;
  if (!parent) return null;
  return parent.getBoundingClientRect();
}
function clampMenuPos(left, top) {
  var menu = cc.menu;
  var parentRect = menuDragParentRect();
  if (!menu || !parentRect) return { left: 0, top: 0 };
  var w = menu.offsetWidth || 0, h = menu.offsetHeight || 0;
  /* Atas: gagang di ujung atas menu — bila menu naik terlalu jauh,
     gagang terpotong overflow player dan tidak bisa diraih lagi
     (menu macet sampai ditutup + buka ulang). Jepit atas memakai
     tinggi gagang: selalu ≥20 px gagang terlihat. Sisi lain tetap
     aturan 40 px (§4.8.3 butir 2). */
  var grip = ccEl('player-menu-grip');
  var gripH = (grip && grip.offsetHeight) || 40;
  var minTop = Math.max(-(h - MENU_DRAG_MIN_VISIBLE), -(gripH - 20));
  /* F-03 (v1.5.8, TF2): jepit JUGA terhadap viewport — menu tidak
     boleh menggantung melewati tepi layar. Batas viewport dihitung
     dalam koordinat relatif-parent (left/top diukur dari parentRect).
     Bila menu lebih lebar/tinggi dari viewport, kedua jepit bertabrakan
     — utamakan tepi kiri/atas viewport supaya gagang tetap terjangkau. */
  var vw = (typeof window !== 'undefined' && window.innerWidth) || parentRect.width;
  var vh = (typeof window !== 'undefined' && window.innerHeight) || parentRect.height;
  var leftMin = Math.max(-(w - MENU_DRAG_MIN_VISIBLE), -parentRect.left);
  var leftMax = Math.min(parentRect.width - MENU_DRAG_MIN_VISIBLE, vw - parentRect.left - w);
  if (leftMax < leftMin) leftMax = leftMin;
  var topMin = Math.max(minTop, -parentRect.top);
  var topMax = Math.min(parentRect.height - MENU_DRAG_MIN_VISIBLE, vh - parentRect.top - h);
  if (topMax < topMin) topMax = topMin;
  return {
    left: Math.max(leftMin, Math.min(leftMax, left)),
    top: Math.max(topMin, Math.min(topMax, top)),
  };
}
function applyMenuPos(left, top) {
  var p = clampMenuPos(left, top);
  cc.menu.style.left = p.left + 'px';
  cc.menu.style.top = p.top + 'px';
  cc.menu.style.right = 'auto';
  cc.menu.style.bottom = 'auto';
  return p;
}
function resetMenuPosition() {
  if (!cc.menu) return;
  cc.menu.style.left = '';
  cc.menu.style.top = '';
  cc.menu.style.right = '';
  cc.menu.style.bottom = '';
}
function menuCurrentPos() {
  var menu = cc.menu;
  var parentRect = menuDragParentRect();
  if (!menu || !parentRect) return { left: 0, top: 0 };
  var r = menu.getBoundingClientRect();
  return { left: r.left - parentRect.left, top: r.top - parentRect.top };
}
function nudgeMenu(dx, dy) {
  if (!cc.menuOpen || !cc.menu) return;
  var cur = menuCurrentPos();
  applyMenuPos(cur.left + dx, cur.top + dy);
}
function onMenuGripPointerDown(e) {
  if (!cc.menuOpen || !cc.menu) return;
  if (e.button != null && e.button !== 0) return;
  /* Rotasi fallback CSS memutar .player__stage 90° — rect terhitung
     jadi kotak sumbu-sejajar, drag akan terasa miring; di keadaan itu
     gagang tidak memulai drag (menu tetap bisa dibuka/ditutup). */
  if (cc.player && cc.player.classList.contains('ar-css-fallback')) return;
  e.preventDefault();
  var grip = ccEl('player-menu-grip');
  var start = menuCurrentPos();
  cc.menuDrag = {
    pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
    startLeft: start.left, startTop: start.top, moved: false,
  };
  clearHideTimer(); /* item 47: drag = aktivitas, timer ditahan */
  try { if (grip) grip.setPointerCapture(e.pointerId); } catch (err) {}
}
function onMenuGripPointerMove(e) {
  var d = cc.menuDrag;
  if (!d || e.pointerId !== d.pointerId) return;
  var dx = e.clientX - d.startX, dy = e.clientY - d.startY;
  if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
  if (!d.moved) return;
  e.preventDefault();
  applyMenuPos(d.startLeft + dx, d.startTop + dy);
}
function onMenuGripPointerUp(e) {
  var d = cc.menuDrag;
  if (!d || e.pointerId !== d.pointerId) return;
  cc.menuDrag = null;
  cc.dragEndAt = Date.now();
  /* Klik yang lahir dari pointerup di luar menu ditelan sekali —
     kalau tidak, ketuk-di-luar (item 47) akan menutup menu tepat
     sesudah drag selesai. */
  if (d.moved) {
    var swallow = function (ev) {
      ev.stopPropagation();
      ev.preventDefault();
      document.removeEventListener('click', swallow, true);
    };
    document.addEventListener('click', swallow, true);
    setTimeout(function () { document.removeEventListener('click', swallow, true); }, 500);
  }
}
function onMenuGripPointerCancel(e) {
  if (cc.menuDrag && e.pointerId === cc.menuDrag.pointerId) {
    cc.menuDrag = null;
    /* Drag dibatalkan browser (mis. gesture diambil alih) — tandai
       juga sebagai akhir drag supaya klik yang menyusul tidak
       diartikan sebagai ketuk-di-luar. */
    cc.dragEndAt = Date.now();
  }
}

/* v1.5.9 item 52: play TIDAK PERNAH lagi memicu fullscreen/rotasi.
   Rotasi hanya saat tombol fullscreen ditekan (handler
   fullscreenchange). */
function togglePlay() {
  var v = cc.video;
  if (!v) return;
  if (v.paused) v.play().catch(function () {});
  else v.pause();
}
function syncPlayUI() {
  var v = cc.video;
  if (!v) return;
  var playing = !v.paused;
  var btn = ccEl('player-play');
  if (btn) {
    btn.classList.toggle('is-playing', playing);
    btn.setAttribute('aria-label', playing ? 'Jeda' : 'Putar');
  }
  refreshBarDom();
}
function fmtTime(s) {
  if (s == null || !isFinite(s)) return '--:--';
  s = Math.max(0, Math.floor(s));
  var m = Math.floor(s / 60), ss = s % 60;
  return m + ':' + (ss < 10 ? '0' : '') + ss;
}
function syncTimeUI() {
  var v = cc.video;
  if (!v) return;
  var timeEl = ccEl('player-time');
  if (timeEl) timeEl.textContent = fmtTime(v.currentTime) + ' / ' + fmtTime(v.duration);
  var seek = ccEl('player-seek');
  if (seek && !cc.scrubbing) {
    var dur = v.duration || 0;
    if (dur > 0) seek.max = String(dur);
    seek.value = String(v.currentTime || 0);
  }
}
function syncVolumeUI() {
  var v = cc.video;
  if (!v) return;
  var btn = ccEl('player-mute');
  if (btn) {
    btn.classList.toggle('is-muted', v.muted || v.volume === 0);
    btn.setAttribute('aria-label', v.muted ? 'Nyalakan suara' : 'Bisu');
  }
  var vol = ccEl('player-vol');
  if (vol) vol.value = String(Math.round((v.muted ? 0 : v.volume) * 100));
}
function toggleMute() {
  var v = cc.video;
  if (!v) return;
  v.muted = !v.muted;
  syncVolumeUI();
}
function seekBy(d) {
  var v = cc.video;
  if (!v) return;
  var dur = v.duration || 0;
  try { v.currentTime = Math.max(0, Math.min(dur, (v.currentTime || 0) + d)); } catch (e) {}
}
function toggleFullscreen() {
  var p = cc.player;
  if (!p) return;
  if (document.fullscreenElement) { document.exitFullscreen().catch(function () {}); }
  else if (p.requestFullscreen) { p.requestFullscreen().catch(function () {}); }
}
function syncFsUI() {
  var btn = ccEl('player-fs');
  if (!btn) return;
  btn.setAttribute('aria-label', document.fullscreenElement ? 'Keluar dari layar penuh' : 'Layar penuh');
}

/* v1.5.9 item 52: auto-rotate saat play (Item 25, v1.5.4) DIHAPUS —
   play tidak pernah lagi memicu fullscreen/rotasi. Rotasi hanya saat
   tombol fullscreen ditekan (handler fullscreenchange di bawah).
   Keluar fullscreen membuka kunci. Pause TIDAK keluar fullscreen
   dan TIDAK unlock. */
var _arFbTimer = null; /* timer cek efek lock 600 ms (jalur B, Item 28) — hanya satu */
function orientationLockSupported() {
  return !!(window.screen && screen.orientation && typeof screen.orientation.lock === 'function');
}
/* Item 28 (v1.5.5): apakah orientasi (menurut API) sudah landscape. */
function isLandscapeOrientation() {
  try {
    var t = (window.screen && screen.orientation && screen.orientation.type) || '';
    return t.indexOf('landscape') === 0;
  } catch (e) { return false; }
}
function cssFallbackActive() {
  return !!(cc.player && cc.player.classList.contains('ar-css-fallback'));
}
/* Item 28: pasang fallback CSS. Cek ulang type TEPAT sebelum memasang
   (§4.3.3) dan hanya di dalam fullscreen — bila sudah landscape, jangan
   pasang. Idempoten (kelas yang sudah ada = no-op). */
function applyCssFallback() {
  var p = cc.player;
  if (!p || !document.fullscreenElement) return;
  if (isLandscapeOrientation()) return;
  p.classList.add('ar-css-fallback');
}
function removeCssFallback() {
  if (cc.player) cc.player.classList.remove('ar-css-fallback');
}
function clearFallbackCheckTimer() {
  if (_arFbTimer !== null) { clearTimeout(_arFbTimer); _arFbTimer = null; }
}
/* Item 28 jalur B: lock resolve → tunggu 600 ms, lalu cek efek. Timer
   lama dibersihkan bila pemicu datang lagi (satu timer saja). */
function scheduleFallbackCheck() {
  clearFallbackCheckTimer();
  _arFbTimer = setTimeout(function () {
    _arFbTimer = null;
    if (!document.fullscreenElement) return;
    applyCssFallback();
  }, 600);
}
function lockLandscape() {
  if (!orientationLockSupported()) return;
  try {
    var p = screen.orientation.lock('landscape');
    if (p && typeof p.then === 'function') {
      /* Jalur B: resolve → cek efek sesudah 600 ms (§4.3.2).
         Jalur A: reject → fallback langsung, tanpa menunggu. */
      p.then(function () { scheduleFallbackCheck(); })
       .catch(function () { applyCssFallback(); });
    } else {
      /* lock tanpa promise (browser lama): tidak ada cara tahu hasil —
         pakai jalur cek efek yang sama. */
      scheduleFallbackCheck();
    }
  } catch (e) { applyCssFallback(); } /* throw sinkron = jalur A */
}
function unlockOrientation() {
  if (!orientationLockSupported()) return;
  try { screen.orientation.unlock(); } catch (e) { /* diam */ }
}
/* v1.5.9 item 53: ketuk tunggal pada video HANYA menampilkan kontrol —
   TIDAK LAGI toggle play/pause (perilaku v1.5.8 item 48 dihapus karena
   ketuk ⋮ ikut mem-pause video). Play/pause hanya lewat tombol play
   (tengah + bar kontrol). Tap ganda di sepertiga kiri/kanan tetap =
   ∓10 dtk — tanpa timer 300 ms: ketuk pertama langsung tampilkan
   kontrol, ketuk kedua di sisi yang sama <300 ms langsung seek. */
function onVideoTap(e) {
  if (!cc.enabled || cc.failed || !cc.video) return;
  var v = cc.video;
  var now = performance.now();
  var rect = v.getBoundingClientRect();
  var x, span;
  if (cssFallbackActive()) {
    /* Item 28 (§4.3.5): fallback aktif → sumbu bertukar. rotate(90deg)
       searah jarum jam: kiri penonton = tepi ATAS layar portrait
       (clientY), kanan penonton = tepi BAWAH layar. rect di sini sudah
       kotak sesudah transform (lebar = lebar layar, tinggi = tinggi
       layar); posisi sepanjang video diukur dari clientY terhadap
       rect.top, rentangnya rect.height — sepertiga ATAS layar = mundur,
       sepertiga BAWAH layar = maju. */
    x = (e.clientY || 0) - rect.top;
    span = rect.height;
  } else {
    x = (e.clientX || 0) - rect.left;
    span = rect.width;
  }
  var side = x < span / 3 ? -1 : (x > span * 2 / 3 ? 1 : 0);
  var dt = now - cc.lastTapAt;
  if (dt < CC_DBLTAP_MS && side !== 0 && side === cc.lastTapSide) {
    cc.lastTapAt = 0;
    seekBy(side * 10);
    resetHideTimer();
    return;
  }
  cc.lastTapAt = now;
  cc.lastTapSide = side;
  /* Ketuk tunggal: HANYA tampilkan kontrol — tanpa timer, tanpa
     toggle play/pause (v1.5.9 item 53). */
  showCustomControls();
  resetHideTimer();
}

function onPlayerKeydown(e) {
  if (!cc.enabled || cc.failed) return;
  var t = e.target;
  var tag = t && t.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  var k = e.key;
  if (k === ' ' || k === 'k' || k === 'K') { e.preventDefault(); togglePlay(); }
  else if (k === 'f' || k === 'F') { toggleFullscreen(); }
  else if (k === 'm' || k === 'M') { toggleMute(); }
  else if (k === 'ArrowLeft') { e.preventDefault(); seekBy(-10); }
  else if (k === 'ArrowRight') { e.preventDefault(); seekBy(10); }
  else if (k === 'Escape' && cc.menuOpen) { closePlayerMenu('esc'); }
  else return;
  resetHideTimer();
}

/* Item 16 (a): tap di luar menu menutup menu SAJA. Listener capture
   di document — tap yang ditelan tidak pernah mencapai video/tombol
   di bawahnya, jadi tidak ada aksi kontrol yang tidak diminta
   (tidak play/pause, tidak seek, tidak toggle bar). */
function onDocumentClickCapture(e) {
  if (!cc.menuOpen) return;
  if (cc.menuDrag) return; /* item 46: sedang drag — bukan ketuk-di-luar */
  if (Date.now() - (cc.dragEndAt || 0) < 500) return; /* item 46: klik sesudah drag */
  var menu = cc.menu, btn = ccEl('player-menu-btn');
  if (menu && menu.contains(e.target)) return;
  if (btn && btn.contains(e.target)) return;
  e.stopPropagation();
  e.preventDefault();
  closePlayerMenu('outside');
  resetHideTimer();
}

/* Satu sumber kebenaran ganti bahasa subtitle — dipakai #sub-select
   DAN baris Bahasa di menu ⋮ (bukan logika ganda, §5.4.6). */
function setSubMode(mode) {
  var prev = watch.subMode;
  watch.subMode = mode;
  if (mode === 'off') {
    if (watch.subs) watch.subs.stop();
  } else if (prev === 'off' && watch.subs) {
    watch.subs.resume();
  }
  applySubMode();
  var sel = document.getElementById('sub-select');
  if (sel) sel.value = mode;
  renderMenuLang();
}

function renderMenuLang() {
  var list = ccEl('menu-lang-list');
  if (!list) return;
  var tracks = watch.menuTracks || [];
  var hasEn = !!watch.subHasEn;
  var translating = watch.subStatus && watch.subStatus.state === 'translating';
  var rows = [{ value: 'off', label: 'Off' }];
  tracks.forEach(function (t) {
    if (!t || !t.lang) return;
    rows.push({ value: t.lang, label: t.label || t.lang });
  });
  if (hasEn) rows.push({ value: 'id', label: translating ? 'Indonesia (AI) — Menerjemahkan…' : 'Indonesia (AI)' });
  var html = rows.map(function (r) {
    return '<button type="button" class="player-menu__row' + (watch.subMode === r.value ? ' is-active' : '') + '" data-lang="' + esc(r.value) + '">' +
      '<span class="player-menu__label">' + esc(r.label) + '</span>' +
      '<span class="player-menu__check">' + icon('check') + '</span></button>';
  }).join('');
  /* Jangan ganti DOM bila isinya sama — supaya baris yang sedang
     disentuh pengguna tidak hilang saat onSubStatus me-refresh
     (batch translate selesai) selagi menu terbuka. */
  if (list._mitsuHtml === html) return;
  list._mitsuHtml = html;
  list.innerHTML = html;
  list.querySelectorAll('.player-menu__row').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setSubMode(btn.getAttribute('data-lang'));
      /* item 47 (v1.5.8): memilih bahasa TIDAK menutup menu. */
    });
  });
}

function speedLabel(v) {
  if (v === 1) return '1× (Normal)';
  return String(v).replace('.', ',') + '×';
}
function renderMenuSpeed() {
  var list = ccEl('menu-speed-list');
  if (!list || !cc.video) return;
  var cur = cc.video.playbackRate || 1;
  var html = CC_SPEEDS.map(function (v) {
    return '<button type="button" class="player-menu__row' + (cur === v ? ' is-active' : '') + '" data-speed="' + v + '">' +
      '<span class="player-menu__label">' + esc(speedLabel(v)) + '</span>' +
      '<span class="player-menu__check">' + icon('check') + '</span></button>';
  }).join('');
  if (list._mitsuHtml === html) return;
  list._mitsuHtml = html;
  list.innerHTML = html;
  list.querySelectorAll('.player-menu__row').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var v = parseFloat(btn.getAttribute('data-speed'));
      if (!isNaN(v) && cc.video) cc.video.playbackRate = v;
      renderMenuSpeed();
      /* item 47 (v1.5.8): memilih kecepatan TIDAK menutup menu. */
    });
  });
}
function resetPlaybackRate() {
  if (cc.video) { try { cc.video.playbackRate = 1; } catch (e) {} }
  renderMenuSpeed();
}

function initCustomControls() {
  try {
    var video = ccEl('player-video');
    var player = ccEl('player');
    var bar = ccEl('player-bar');
    var menu = ccEl('player-menu');
    var center = ccEl('player-center');
    if (!video || !player || !bar || !menu || !center) throw new Error('elemen kontrol custom tidak ada');
    cc.video = video; cc.player = player; cc.bar = bar; cc.menu = menu; cc.center = center;
    ccEl('player-play').addEventListener('click', function () { togglePlay(); resetHideTimer(); });
    ccEl('player-center-play').addEventListener('click', function () { togglePlay(); });
    ccEl('player-mute').addEventListener('click', function () { toggleMute(); resetHideTimer(); });
    ccEl('player-menu-btn').addEventListener('click', function () { togglePlayerMenu(); });
    /* Item 46 (v1.5.8, T2): drag menu lewat gagang. Panah keyboard
       menggeser 16 px (dengan jepit yang sama). */
    var grip = ccEl('player-menu-grip');
    if (grip) {
      grip.addEventListener('pointerdown', onMenuGripPointerDown);
      grip.addEventListener('pointermove', onMenuGripPointerMove);
      grip.addEventListener('pointerup', onMenuGripPointerUp);
      grip.addEventListener('pointercancel', onMenuGripPointerCancel);
      grip.addEventListener('keydown', function (e) {
        var step = MENU_DRAG_KEY_STEP;
        if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeMenu(-step, 0); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); nudgeMenu(step, 0); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); nudgeMenu(0, -step); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); nudgeMenu(0, step); }
      });
    }
    ccEl('player-fs').addEventListener('click', function () { toggleFullscreen(); resetHideTimer(); });
    if (!document.fullscreenEnabled) { var fsBtn = ccEl('player-fs'); if (fsBtn) fsBtn.hidden = true; }
    var seek = ccEl('player-seek');
    seek.addEventListener('input', function () {
      cc.scrubbing = true;
      var v = cc.video;
      if (v) { try { v.currentTime = parseFloat(seek.value) || 0; } catch (e) {} }
      syncTimeUI();
      resetHideTimer();
    });
    seek.addEventListener('change', function () { cc.scrubbing = false; });
    var vol = ccEl('player-vol');
    vol.addEventListener('input', function () {
      var v = cc.video;
      if (!v) return;
      var val = parseInt(vol.value, 10) || 0;
      v.volume = val / 100;
      if (val > 0) v.muted = false;
      syncVolumeUI();
      resetHideTimer();
    });
    video.addEventListener('click', onVideoTap);
    video.addEventListener('playing', function () { syncPlayUI(); showCustomControls(); });
    video.addEventListener('pause', function () { syncPlayUI(); showCustomControls(); });
    video.addEventListener('timeupdate', syncTimeUI);
    video.addEventListener('loadedmetadata', syncTimeUI);
    video.addEventListener('durationchange', syncTimeUI);
    video.addEventListener('volumechange', syncVolumeUI);
    video.addEventListener('ratechange', renderMenuSpeed);
    /* Item 29 (v1.5.6): TITIK CEKIK — SETIAP jalan masuk fullscreen
       pada player custom mencoba lock (tombol manual, keyboard f).
       Kunci HANYA bila elemen fullscreen adalah .player sendiri
       (bukan iframe) dan player custom aktif. Rotasi diputuskan
       saat MASUK FULLSCREEN, bukan saat play/pause (keputusan
       Faygo 23:39 WIB; v1.5.9 item 52: jalur play sudah tidak
       pernah lagi memicu fullscreen). */
    document.addEventListener('fullscreenchange', function () {
      syncFsUI();
      if (document.fullscreenElement) {
        resetMenuPosition(); /* item 46: ukuran player berubah — posisi drag direset */
        if (document.fullscreenElement === cc.player && cc.enabled && !cc.failed && cc.player) {
          lockLandscape();
        }
      } else {
        if (cc.menuOpen) closePlayerMenu('fullscreen'); /* item 47 butir 3e */
        /* Item 28: keluar fullscreen → LEPAS fallback + bersihkan timer
           pengecekan (§4.3.4). Video tetap jalan (keluar fullscreen
           bukan pause). */
        removeCssFallback();
        clearFallbackCheckTimer();
        unlockOrientation();
      }
    });
    /* Item 28 (§4.3.3): pengaman rotasi ganda — bila rotasi ASLI
       belakangan berhasil (type jadi landscape) saat fallback aktif,
       LEPAS fallback segera (di sini langsung di event, ≤300 ms).
       Listener dipasang SEKALI di sini; tidak berbuat apa-apa bila
       fallback tidak aktif. */
    if (orientationLockSupported()) {
      window.addEventListener('orientationchange', function () {
        if (isLandscapeOrientation()) removeCssFallback();
      });
    }
    player.addEventListener('keydown', onPlayerKeydown);
    document.addEventListener('click', onDocumentClickCapture, true);
    renderMenuSpeed();
    syncPlayUI();
    syncVolumeUI();
    syncTimeUI();
    cc.inited = true;
  } catch (err) {
    fallbackNativeControls();
  }
}

/* Bukti putar HD (playing + currentTime > 0) — menggantikan
   postMessage MegaPlay untuk Server HD. */
function markPlayerAlive() {
  if (!watch.hasPlayed) watch.playedServerIdx = watch.serverIdx;
  watch.hasPlayed = true;
  watch.playerAlive = true;
  clearPlayerTimer();
  hidePlayerOverlay();
}

/* ---------- Memuat episode ke player ---------- */
async function loadEpisode(epNum, lang) {
  /* v1.5.4 fix F-02: tunggu progres bila masih dimuat (mis. klik
     episode sangat cepat sesudah halaman dibuka) — janji yang sudah
     selesai tidak menambah tunggu. */
  if (watch.progressPromise) { try { await watch.progressPromise; } catch (e) {} }
  cancelAutoNext();
  clearPlayerTimer();
  clearPlayerHardTimer();
  stopHd();
  watch.hasPlayed = false;
  watch.playedServerIdx = -1;
  watch.playerAlive = false;
  watch.servers = [];
  watch.serverIdx = 0;
  watch.failedServers = [];
  watch.hdResolvedOnce = false;
  watch.subMode = 'id';
  var ep = findEpisode(epNum);
  if (!ep) {
    showPlayerError('Video gagal dimuat', 'Episode ' + epNum + ' tidak ada untuk anime ini.', false);
    return;
  }
  watch.currentEp = ep;
  watch.epNum = epNum;
  watch.lang = lang;

  var wtEl = document.getElementById('watch-title');
  if (wtEl) wtEl.textContent = decodeEntities(displayTitle(watch.anime) || 'Tonton');
  var weEl = document.getElementById('watch-ep-title');
  if (weEl) weEl.textContent = 'Episode ' + ep.number + (ep.title ? ' — ' + decodeEntities(ep.title) : '');
  document.querySelectorAll('#lang-tabs .lang-tab').forEach(function (tab) {
    var active = tab.getAttribute('data-lang') === lang;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  var prev = findEpisode(epNum - 1);
  var next = findEpisode(epNum + 1);
  var bpEl = document.getElementById('btn-prev');
  if (bpEl) bpEl.disabled = !prev;
  var bnEl = document.getElementById('btn-next');
  if (bnEl) bnEl.disabled = !next;

  var url = '/watch.html?id=' + encodeURIComponent(watch.anime.id) + '&ep=' + epNum + '&lang=' + lang;
  if (window.location.pathname + window.location.search !== url) {
    window.history.replaceState(null, '', url);
  }

  renderEpisodeList();

  /* Daftar server HANYA dari endpoint stream (servers.js) — frontend
     tidak pernah membangun URL dari ID. */
  showPlayerLoading('Memuat video…');
  var stream;
  try {
    stream = await getStream(watch.anime.id, epNum, lang);
  } catch (err) {
    if (err && err.status === 401) {
      showPlayerError('Sesi login habis', 'Masuk lagi untuk melanjutkan menonton.', false);
      return;
    }
    showPlayerError('Video gagal dimuat', (err && err.message) || 'Tautan video tidak bisa diambil dari server.', true);
    return;
  }
  var servers = (stream.data && Array.isArray(stream.data.servers)) ? stream.data.servers : null;
  watch.mpFallbacks = (stream.data && stream.data.fallback_urls && stream.data.fallback_urls[lang]) || [];
  if (!servers || !servers.length) {
    /* Defensif (seharusnya tidak terjadi — server selalu memberi
       daftar): bangun dari embed_url seperti kode lama. */
    servers = [];
    var embed = (stream.data && stream.data.embed_url) || {};
    if (embed[lang]) servers.push({ key: 'megaplay', name: 'MegaPlay', kind: 'iframe', url: embed[lang] });
  }
  watch.servers = servers;
  populateServerSelect();
  if (!servers.length) {
    showPlayerError('Video gagal dimuat', 'Episode ini tidak punya tautan video untuk bahasa ' + (lang === 'dub' ? 'DUB' : 'SUB') + '. Coba ganti bahasa.', true);
    return;
  }
  playServer(0, resumePositionFor(epNum));
  /* v1.5.4 fix F-02: save awal HANYA bila episode ini belum punya
     entri progres — menimpa dengan 0 akan menghapus posisi tersimpan
     (dan menandai ulang episode yang sudah selesai). */
  if (!watch.progress || !watch.progress[epNum]) {
    saveContinue(watch.anime, ep, { lang: lang, percent: 0, time: 0, duration: 0 });
  }
}

/* ---------- Pemilih server ---------- */
function populateServerSelect() {
  var sel = document.getElementById('server-select');
  if (!sel) return;
  sel.innerHTML = watch.servers.map(function (s) {
    return '<option value="' + esc(s.key) + '">' + esc(s.name) + '</option>';
  }).join('');
  syncServerSelect();
}
function syncServerSelect() {
  var sel = document.getElementById('server-select');
  if (!sel || !watch.servers.length) return;
  var cur = watch.servers[watch.serverIdx];
  if (cur) sel.value = cur.key;
}

/* ---------- Timer server ---------- */
function armPlayerTimer() {
  clearPlayerTimer();
  watch.playerTimer = setTimeout(function () {
    watch.playerTimer = null;
    if (watch.playerAlive) return;
    failCurrentServer('tidak merespons dalam 15 detik');
  }, PLAYER_TIMEOUT_MS);
}

/* Server aktif gagal: MegaPlay masih punya rantai internal s-2 → mal →
   ani (coba dulu); bila tidak, pindah ke server berikut. */
function failCurrentServer(reason) {
  var srv = watch.servers[watch.serverIdx];
  if (srv && srv.key === 'megaplay' && watch.mpUrls && watch.mpIdx + 1 < watch.mpUrls.length) {
    watch.failedServers.push(watch.mpNames[watch.mpIdx] + ' (' + reason + ')');
    watch.mpIdx++;
    updateServerIndicator(watch.mpNames[watch.mpIdx], 'retrying');
    showPlayerLoading('MegaPlay gagal, mencoba ' + watch.mpNames[watch.mpIdx] + '…');
    document.getElementById('player-iframe').src = watch.mpUrls[watch.mpIdx];
    armPlayerTimer();
    return;
  }
  onServerFailed(reason);
  tryNextServer(false);
}

/* Overlay loading TETAP menutupi player sampai ada bukti player hidup. */
function playServer(idx, resumeTime) {
  clearPlayerTimer();
  clearPlayerHardTimer();
  cancelAutoNext();
  watch.hasPlayed = false;
  watch.playedServerIdx = -1;
  watch.playerAlive = false;
  if (!watch.servers.length || idx < 0 || idx >= watch.servers.length) {
    watch.serverIdx = 0;
    showPlayerError('Video gagal dimuat', 'Tidak ada server video untuk episode ini. Coba ganti bahasa atau kembali ke detail anime.', true);
    return;
  }
  watch.serverIdx = idx;
  var srv = watch.servers[idx];
  syncServerSelect();
  updateServerIndicator(srv.name, 'active');
  /* v1.5.3 item 13: bar custom hanya untuk Server HD; pindah server
     menutup menu (§5.8.2 (e)) dan mereset kecepatan ke 1× (§5.4.7). */
  setCustomBarEnabled(srv.kind === 'hd');
  closePlayerMenu('server');
  resetPlaybackRate();
  showPlayerLoading('Memuat video… (Server: ' + srv.name + ')');
  armPlayerTimer();
  watch.playerHardTimer = setTimeout(function () {
    watch.playerHardTimer = null;
    if (watch.overlayKind !== 'loading') return;
    var cur = watch.servers[watch.serverIdx];
    if (cur) watch.failedServers.push(cur.name + ' (tidak merespons dalam 30 detik)');
    updateServerIndicator(cur ? cur.name : '', 'failed');
    tryNextServer(false);
  }, PLAYER_HARD_TIMEOUT_MS);
  if (srv.kind === 'hd') playHdServer(srv, resumeTime);
  else playIframeServer(srv);
}

function onServerFailed(reason) {
  var srv = watch.servers[watch.serverIdx];
  if (srv) watch.failedServers.push(srv.name + ' (' + reason + ')');
}

function retryCurrentServer() {
  watch.failedServers = [];
  hidePlayerOverlay();
  if (!watch.servers.length || watch.serverIdx < 0 || watch.serverIdx >= watch.servers.length) {
    showPlayerError('Video gagal dimuat', 'Tidak ada server video untuk episode ini. Coba ganti bahasa atau kembali ke detail anime.', true);
    return;
  }
  playServer(watch.serverIdx);
}

function tryNextServer(manual) {
  cancelAutoNext();
  if (!watch.servers.length) {
    showPlayerError('Video gagal dimuat', 'Tidak ada server video untuk episode ini. Coba ganti bahasa atau kembali ke detail anime.', true);
    return false;
  }
  var nextIdx = watch.serverIdx + 1;
  if (nextIdx >= watch.servers.length) {
    var tried = watch.failedServers.length
      ? watch.failedServers.join('; ')
      : 'Semua server tidak merespons.';
    showPlayerError('Video gagal dimuat di semua server',
      tried + '. Coba lagi nanti, ganti server, atau ganti bahasa.', true);
    var curExhausted = watch.servers[watch.serverIdx];
    updateServerIndicator(curExhausted ? curExhausted.name : '', 'failed');
    return false;
  }
  var cur = watch.servers[watch.serverIdx];
  updateServerIndicator(cur ? cur.name : '', 'failed');
  var prevName = cur ? cur.name : 'server sebelumnya';
  var nextName = watch.servers[nextIdx].name;
  updateServerIndicator(nextName, 'retrying');
  playServer(nextIdx);
  showPlayerLoading(prevName + ' gagal, mencoba ' + nextName + '…');
  return true;
}

function cycleServer() {
  if (!watch.servers.length) return;
  clearPlayerTimer();
  clearPlayerHardTimer();
  watch.failedServers = [];
  var nextIdx = (watch.serverIdx + 1) % watch.servers.length;
  playServer(nextIdx);
}

function switchLang(lang) {
  if (lang === watch.lang) return;
  loadEpisode(watch.epNum, lang);
}

function goEpisode(num) {
  var ep = findEpisode(num);
  if (!ep) return;
  loadEpisode(num, watch.lang);
  var player = document.getElementById('player');
  if (player) player.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- Server HD (hls.js) ---------- */
function loadHlsScript() {
  if (window.Hls) return Promise.resolve(true);
  if (watch.hlsLoading) return watch.hlsLoading;
  watch.hlsLoading = new Promise(function (resolve) {
    var s = document.createElement('script');
    s.src = '/js/vendor/hls.min.js?v=1.5.0';
    s.onload = function () { resolve(!!window.Hls); };
    s.onerror = function () { resolve(false); };
    document.head.appendChild(s);
  });
  return watch.hlsLoading;
}

function showHdControls(show) {
  var el = document.getElementById('hd-controls');
  if (el) el.hidden = !show;
  /* v1.5.3 §5.5: #sub-select disembunyikan saat HD aktif (fungsinya
     pindah ke seksi Bahasa menu ⋮). Elemen tetap ada di DOM dan tetap
     diisi renderSubMenu (cermin state). */
  var subSel = document.getElementById('sub-select');
  if (subSel && subSel.parentElement) subSel.parentElement.hidden = !!show;
}

function stopHd() {
  if (watch.subs) { try { watch.subs.stop(); } catch (e) {} watch.subs = null; }
  if (watch.hd && watch.hd.hls) { try { watch.hd.hls.destroy(); } catch (e) {} }
  watch.hd = null;
  var video = document.getElementById('player-video');
  if (video) {
    try { video.pause(); } catch (e) {}
    video.removeAttribute('src');
    try { video.load(); } catch (e) {}
    var trs = video.querySelectorAll('track');
    for (var i = 0; i < trs.length; i++) trs[i].remove();
  }
  showHdControls(false);
  hideQualityMenu();
  var st = document.getElementById('sub-status');
  if (st) { st.textContent = ''; st.classList.remove('sub-status--error'); }
}

async function playHdServer(entry, resumeTime) {
  var video = document.getElementById('player-video');
  var iframe = document.getElementById('player-iframe');
  var resume = typeof resumeTime === 'number' && resumeTime > 0 ? resumeTime : 0;
  /* Bersihkan sesi HD sebelumnya (re-resolve) — posisi putar sudah
     disimpan di `resume`. */
  stopHd();
  /* Sembunyikan iframe + bersihkan src supaya postMessage MegaPlay
     tidak bocor ke sesi HD. */
  iframe.removeAttribute('src');
  iframe.hidden = true;
  video.hidden = false;
  showHdControls(true);
  updateServerIndicator(entry.name, 'active');
  showPlayerLoading('Memuat Server Mitsunime…');
  var hd;
  try {
    hd = await getStreamHD(watch.anime.id, watch.epNum, watch.lang);
  } catch (err) {
    onServerFailed(err && err.message ? err.message : 'Server Mitsunime tidak merespons');
    tryNextServer(false);
    return;
  }
  var d = hd && hd.data;
  if (!d || !d.hls_url) {
    onServerFailed('Server Mitsunime tidak mengembalikan video');
    tryNextServer(false);
    return;
  }
  watch.hd = { manifest: d, hls: null, useNative: false, mediaRecovered: false };
  /* v1.5.1 (T5): patok AWAL dari varian terendah. Master MegaPlay
     mengurutkan varian dari bitrate TERTINGGI ke terendah, TAPI hls.js
     mengurutkan ulang level MENAIK menurut bitrate saat manifest
     dimuat (terverifikasi via probe: levels[0] = 360p/409545,
     levels[2] = 1080p/1969481) — jadi indeks TERENDAH selalu 0,
     bukan indeks terakhir. Jumlah varian baru diketahui setelah
     manifest dibaca: baca master dulu (same-origin, ~400 byte),
     lalu bangun Hls dengan startLevel = 0 (bila varian > 1).
     config.startLevel dihormati hls.js saat manifest dimuat;
     nextLevel TIDAK dipakai — ia mematikan auto-level. Bila
     pre-fetch gagal, startLevel -1 (perilaku lama). Auto-level
     tetap aktif sesudah jalan — hanya AWAL yang dipatok rendah. */
  var startLevel = -1;
  try {
    var masterRes = await fetch(d.hls_url, { cache: 'no-store' });
    if (masterRes.ok) {
      var masterText = await masterRes.text();
      var variantCount = (masterText.match(/#EXT-X-STREAM-INF/g) || []).length;
      if (variantCount > 1) startLevel = 0;
    }
  } catch (e) { /* perilaku lama */ }
  /* Muat hls.js (lazy) bila perlu; bila gagal dan browser tidak bisa
     HLS native → HD gagal → fallback. */
  var hls = null;
  var useNative = false;
  if (window.Hls && window.Hls.isSupported()) {
    hls = new Hls({ maxBufferLength: 30, manifestLoadingMaxRetry: 2, startLevel: startLevel });
  } else {
    var ok = await loadHlsScript();
    if (ok && window.Hls && window.Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 30, manifestLoadingMaxRetry: 2, startLevel: startLevel });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      useNative = true;
    } else {
      onServerFailed('Browser ini tidak bisa memutar Server Mitsunime');
      tryNextServer(false);
      return;
    }
  }
  watch.hd.hls = hls;
  watch.hd.useNative = useNative;
  /* Track subtitle dari manifest — Inggris langsung dipasang (tampil
     tanpa menunggu translate). */
  var tracks = Array.isArray(d.tracks) ? d.tracks : [];
  tracks.forEach(function (t) {
    if (!t || !t.url) return;
    var tr = document.createElement('track');
    tr.kind = 'subtitles';
    tr.label = t.label || t.lang;
    tr.srclang = t.lang || 'en';
    tr.src = t.url;
    if (t.default) tr.setAttribute('default', '');
    video.appendChild(tr);
  });
  renderSubMenu(tracks);
  /* Sub Indo (bila ada track Inggris + source_hash). */
  var enTrack = null;
  tracks.forEach(function (t) { if (t && t.lang === 'en' && !enTrack) enTrack = t; });
  if (enTrack && d.source_hash && typeof SubtitleEngine === 'function') {
    watch.subs = new SubtitleEngine({
      animeId: watch.anime.id, episode: watch.epNum, sourceHash: d.source_hash,
      enVttUrl: enTrack.url, video: video,
      onStatus: onSubStatus,
      onTrackRebuilt: function () { applySubMode(); },
    });
    watch.subs.start();
  } else {
    onSubStatus({ state: 'no-source', translated: 0, total: 0 });
  }
  /* Pasang sumber video. */
  if (hls) {
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      renderQualityMenu(hls.levels || []);
      if (resume > 0) { try { video.currentTime = resume; } catch (e) {} }
      video.play().catch(function () { /* pengguna menekan play sendiri */ });
    });
    hls.on(Hls.Events.ERROR, function (event, data) { onHlsError(data); });
    hls.loadSource(d.hls_url);
    hls.attachMedia(video);
  } else {
    video.src = d.hls_url;
    hideQualityMenu();
    if (resume > 0) {
      video.addEventListener('loadedmetadata', function onMeta() {
        video.removeEventListener('loadedmetadata', onMeta);
        try { video.currentTime = resume; } catch (e) {}
      });
    }
    video.play().catch(function () { /* pengguna menekan play sendiri */ });
  }
}

function onHlsError(data) {
  if (!data || !data.fatal) return;
  var video = document.getElementById('player-video');
  var hls = watch.hd && watch.hd.hls;
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR && hls && watch.hd && !watch.hd.mediaRecovered) {
    watch.hd.mediaRecovered = true;
    try { hls.recoverMediaError(); } catch (e) {}
    return;
  }
  if (!watch.hdResolvedOnce) {
    watch.hdResolvedOnce = true;
    var t = video ? video.currentTime || 0 : 0;
    var entry = watch.servers[watch.serverIdx];
    playHdServer(entry, t);
    return;
  }
  onServerFailed('Server Mitsunime gagal memutar video');
  tryNextServer(false);
}

/* ---------- Server iframe ---------- */
function playIframeServer(srv) {
  stopHd();
  /* Item 25 (§5.3.3): pindah ke server iframe saat fullscreen aktif →
     keluar fullscreen + unlock (unlock ikut fullscreenchange). */
  if (document.fullscreenElement) { document.exitFullscreen().catch(function () {}); }
  var video = document.getElementById('player-video');
  if (video) { video.hidden = true; try { video.pause(); } catch (e) {} }
  var iframe = document.getElementById('player-iframe');
  iframe.hidden = false;
  updateServerIndicator(srv.name, 'active');
  if (srv.key === 'megaplay') {
    watch.mpUrls = [srv.url].concat((watch.mpFallbacks || []).map(function (f) { return f.url; }));
    watch.mpNames = ['MegaPlay'].concat((watch.mpFallbacks || []).map(function (f) { return 'MegaPlay (' + f.server + ')'; }));
    watch.mpIdx = 0;
    iframe.src = watch.mpUrls[0];
  } else {
    watch.mpUrls = null;
    iframe.src = srv.url;
  }
}

/* ---------- Menu subtitle / kualitas / lewati ---------- */
function renderSubMenu(tracks) {
  var sel = document.getElementById('sub-select');
  if (!sel) return;
  var hasEn = tracks.some(function (t) { return t && t.lang === 'en'; });
  watch.subHasEn = hasEn;
  watch.menuTracks = tracks; /* sumber baris Bahasa menu ⋮ (v1.5.3) */
  var html = '<option value="off">Off</option>';
  tracks.forEach(function (t) {
    if (!t || !t.lang) return;
    html += '<option value="' + esc(t.lang) + '">' + esc(t.label || t.lang) + '</option>';
  });
  if (hasEn) html += '<option value="id">Indonesia (AI)</option>';
  sel.innerHTML = html;
  watch.subMode = hasEn ? 'id' : (tracks.length && tracks[0].lang ? tracks[0].lang : 'off');
  sel.value = watch.subMode;
  applySubMode();
  renderMenuLang();
}

function applySubMode() {
  /* T3: selama jeda toggle drop (50 ms), penegakan mode DITUNDA
     (bukan dibuang) — pilihan bahasa pengguna tidak boleh hilang
     bila terjadi tepat saat toggle. Dijadwalkan sekali, jalan
     sesudah toggle selesai. */
  if (cc.suppressApply) {
    if (!cc.applyDeferred) {
      cc.applyDeferred = true;
      setTimeout(function () { cc.applyDeferred = false; applySubMode(); }, 70);
    }
    return;
  }
  var video = document.getElementById('player-video');
  if (!video) return;
  var mode = watch.subMode;
  if (watch.subs) watch.subs.setVisible(mode === 'id');
  var tracks = video.textTracks;
  for (var i = 0; i < tracks.length; i++) {
    var tt = tracks[i];
    if (tt.label === 'Indonesia (AI)') continue; /* mode diatur engine */
    if (mode === 'off' || mode === 'id') tt.mode = 'disabled';
    else tt.mode = (tt.language === mode) ? 'showing' : 'disabled';
  }
  /* T3 (b): ikat pemicu cuechange pada track yang sedang showing
     (sekali per objek track — lihat bindCueDrop). */
  for (var j = 0; j < tracks.length; j++) {
    if (tracks[j].mode === 'showing') bindCueDrop(tracks[j]);
  }
}

function onSubStatus(st) {
  watch.subStatus = st;
  var opt = document.querySelector('#sub-select option[value="id"]');
  if (opt) opt.textContent = st.state === 'translating' ? 'Indonesia (AI) — Menerjemahkan…' : 'Indonesia (AI)';
  var el = document.getElementById('sub-status');
  if (!el) return;
  el.classList.remove('sub-status--error');
  var html = '';
  if (st.state === 'no-source') {
    html = '';
  } else if (st.state === 'translating') {
    html = 'Menerjemahkan subtitle…';
  } else if (st.state === 'partial') {
    /* v1.5.2 item 4 (A): hitungan "N/total cue" disembunyikan —
       translate tetap jalan di latar belakang. Saat masih berjalan
       (complete false) tidak ada teks sama sekali; saat selesai
       dengan celah (complete true) tampil sinyal jujur tanpa
       hitungan + tombol "Coba lagi" supaya pengguna tahu sebagian
       subtitle masih Inggris dan bisa mengulang batch yang gagal. */
    if (st.complete) {
      html = 'Subtitle Indonesia (AI) — sebagian belum diterjemahkan';
      html += ' <button class="btn btn-ghost btn-sm" id="btn-sub-retry" type="button">Coba lagi</button>';
    } else {
      html = '';
    }
  } else if (st.state === 'complete') {
    html = 'Subtitle Indonesia (AI)';
  } else if (st.state === 'failed') {
    html = 'Subtitle Indonesia gagal diterjemahkan — menampilkan Inggris';
    el.classList.add('sub-status--error');
    html += ' <button class="btn btn-ghost btn-sm" id="btn-sub-retry" type="button">Coba lagi</button>';
  }
  el.innerHTML = html;
  var retryBtn = document.getElementById('btn-sub-retry');
  if (retryBtn) retryBtn.addEventListener('click', function () {
    if (watch.subs) watch.subs.retry();
  });
  /* v1.5.3: label "Menerjemahkan…" juga tampil di baris Bahasa menu ⋮. */
  renderMenuLang();
}

function renderQualityMenu(levels) {
  var sel = document.getElementById('quality-select');
  if (!sel) return;
  if (!levels || levels.length <= 1) { sel.innerHTML = ''; sel.hidden = true; return; }
  sel.hidden = false;
  var html = '<option value="-1">Otomatis</option>';
  levels.forEach(function (lv, i) {
    var h = lv && lv.height ? lv.height + 'p' : ('Level ' + (i + 1));
    html += '<option value="' + i + '">' + esc(h) + '</option>';
  });
  sel.innerHTML = html;
  sel.value = '-1';
}

function hideQualityMenu() {
  var sel = document.getElementById('quality-select');
  if (sel) { sel.innerHTML = ''; sel.hidden = true; }
}

function updateSkipButtons(t) {
  var d = watch.hd && watch.hd.manifest;
  var introBtn = document.getElementById('btn-skip-intro');
  var outroBtn = document.getElementById('btn-skip-outro');
  if (!d || !introBtn || !outroBtn) return;
  var showIntro = d.intro && d.intro.end > d.intro.start && t >= d.intro.start && t < d.intro.end;
  var showOutro = d.outro && d.outro.end > d.outro.start && t >= d.outro.start && t < d.outro.end;
  introBtn.hidden = !showIntro;
  outroBtn.hidden = !showOutro;
}

/* ---------- Indikator server ---------- */
function updateServerIndicator(name, state) {
  var box = document.getElementById('server-switch');
  var nameEl = document.getElementById('server-name');
  if (nameEl) nameEl.textContent = name;
  if (box) {
    box.classList.toggle('is-failed', state === 'failed');
  }
  var note = document.getElementById('server-note');
  if (note) {
    note.textContent = state === 'failed'
      ? name + ' gagal, mencoba server berikutnya…'
      : watch.serverIdx > 0 ? 'Memakai server cadangan ' + name + '.' : '';
  }
}

/* ---------- Overlay player ---------- */
function showPlayerLoading(text) {
  var ov = document.getElementById('player-overlay');
  if (!ov) return;
  ov.hidden = false;
  ov.classList.remove('player__overlay--error');
  ov.classList.add('player__overlay--loading');
  watch.overlayKind = 'loading';
  /* v1.5.3: bar custom disembunyikan selama overlay tampil (§5.2);
     menu ikut tertutup. */
  cc.overlayUp = true;
  closePlayerMenu('overlay');
  refreshBarDom();
  ov.innerHTML = '<div class="spinner" role="status" aria-label="Memuat video"></div>' +
    '<p>' + esc(text) + '</p>';
}

function showPlayerError(title, text, showLangBtn) {
  clearPlayerTimer();
  clearPlayerHardTimer();
  cancelAutoNext();
  var ov = document.getElementById('player-overlay');
  if (!ov) return;
  ov.hidden = false;
  ov.classList.add('player__overlay--error');
  ov.classList.remove('player__overlay--loading');
  watch.overlayKind = 'error';
  cc.overlayUp = true;
  closePlayerMenu('overlay');
  refreshBarDom();
  var hasServers = watch.servers && watch.servers.length > 0;
  var backHref = watch.anime ? '/detail.html?id=' + encodeURIComponent(watch.anime.id) : '/';
  ov.innerHTML = '<p class="player__overlay-title">' + esc(title) + '</p>' +
    '<p>' + esc(text) + '</p>' +
    '<div class="player__overlay-actions">' +
      (hasServers ? '<button class="btn btn-primary btn-sm" id="ov-retry" type="button">Coba Lagi</button>' : '') +
      (showLangBtn ? '<button class="btn btn-ghost btn-sm" id="ov-lang" type="button">Ganti Bahasa</button>' : '') +
      (hasServers ? '<button class="btn btn-ghost btn-sm" id="ov-server" type="button">Ganti Server</button>' : '') +
      (!hasServers ? '<a class="btn btn-ghost btn-sm" href="' + esc(backHref) + '">Kembali ke Detail Anime</a>' : '') +
    '</div>';
  var retryBtn = document.getElementById('ov-retry');
  if (retryBtn) retryBtn.addEventListener('click', retryCurrentServer);
  var langBtn = document.getElementById('ov-lang');
  if (langBtn) langBtn.addEventListener('click', function () { switchLang(watch.lang === 'sub' ? 'dub' : 'sub'); });
  var serverBtn = document.getElementById('ov-server');
  if (serverBtn) serverBtn.addEventListener('click', function () { tryNextServer(true); });
}

function hidePlayerOverlay() {
  clearPlayerHardTimer();
  var ov = document.getElementById('player-overlay');
  if (!ov) return;
  ov.hidden = true;
  ov.classList.remove('player__overlay--error', 'player__overlay--loading');
  watch.overlayKind = null;
  cc.overlayUp = false;
  refreshBarDom();
  ov.innerHTML = '';
}

/* ---------- Event postMessage dari MegaPlay ---------- */
function onPlayerMessage(event) {
  if (event.origin !== MEGAPLAY_ORIGIN) return;
  var srv = watch.servers[watch.serverIdx];
  if (!srv || srv.key !== 'megaplay') return;
  var data = event.data || {};
  var type = data.type || data.event || '';
  if (data.channel && data.channel !== 'megacloud' && type !== 'watching-log') return;

  if (type === 'time' || type === 'watching-log') {
    var time = typeof data.time === 'number' ? data.time : (typeof data.currentTime === 'number' ? data.currentTime : 0);
    var duration = typeof data.duration === 'number' ? data.duration : 0;
    var percent = duration > 0 ? (time / duration) * 100 : 0;
    if (time > 0) {
      if (!watch.hasPlayed) watch.playedServerIdx = watch.serverIdx;
      watch.hasPlayed = true;
      watch.playerAlive = true;
      clearPlayerTimer();
      hidePlayerOverlay();
    }
    var now = Date.now();
    if (now - watch.lastSave > 10000 || percent >= 95) {
      watch.lastSave = now;
      if (watch.currentEp) saveContinue(watch.anime, watch.currentEp, { lang: watch.lang, percent: percent, time: time, duration: duration });
    }
  } else if (type === 'complete') {
    onWatchComplete();
  } else if (type === 'error') {
    cancelAutoNext();
    clearPlayerTimer();
    failCurrentServer('player mengirim error');
  }
}

/* ---------- Selesai menonton (HD `ended` + MegaPlay `complete`) ---------- */
function onWatchComplete() {
  watch.playerAlive = true;
  clearPlayerTimer();
  if (!watch.hasPlayed) return;
  if (watch.playedServerIdx !== watch.serverIdx) return;
  if (watch.overlayKind === 'loading') return;
  hidePlayerOverlay();
  if (watch.currentEp) {
    markEpisodeWatchedLocal(watch.anime.id, watch.currentEp.number);
    /* F-01 (v1.5.8, TB2): kirim durasi sebenarnya, bukan 0/0 — save
       0/0 menimpa baris progres server jadi percent 0 / belum
       ditonton. Sumber: <video> HD bila ada, kalau tidak durasi dari
       progres yang dimuat di awal halaman; 0 bila tidak diketahui
       (server menandai lewat /api/watch/complete). */
    var dur = 0;
    var v = cc.video;
    if (v && typeof v.duration === 'number' && v.duration > 0) dur = Math.round(v.duration);
    if (!dur && watch.progress && watch.progress[watch.currentEp.number]) {
      dur = Math.round(watch.progress[watch.currentEp.number].duration_sec || 0);
    }
    saveContinue(watch.anime, watch.currentEp, { lang: watch.lang, percent: 100, time: dur, duration: dur });
    reportWatchComplete(watch.anime.id, watch.currentEp.number);
    watch.progress[watch.currentEp.number] = { episode: watch.currentEp.number, percent: 100, watched: true };
    renderEpisodeList();
  }
  startAutoNext();
}

/* ---------- Auto-next (hitung mundur 5 detik + Batalkan) ---------- */
function startAutoNext() {
  if (!watch.hasPlayed) return;
  var next = findEpisode(watch.epNum + 1);
  if (!next) return;
  cancelAutoNext();
  var toast = document.getElementById('autonext-toast');
  if (!toast) return;
  toast.hidden = false;
  watch.autonextLeft = AUTONEXT_SECONDS;
  var countEl = document.getElementById('autonext-count');
  if (countEl) countEl.textContent = String(AUTONEXT_SECONDS);
  watch.autonextTimer = setInterval(function () {
    watch.autonextLeft--;
    if (watch.autonextLeft <= 0) {
      cancelAutoNext();
      goEpisode(watch.epNum + 1);
    } else if (countEl) {
      countEl.textContent = String(watch.autonextLeft);
    }
  }, 1000);
}

function cancelAutoNext() {
  if (watch.autonextTimer) { clearInterval(watch.autonextTimer); watch.autonextTimer = null; }
  var toast = document.getElementById('autonext-toast');
  if (toast) toast.hidden = true;
}

/* ---------- Simpan progres ke server (throttle di pemanggil) ---------- */
/* EXP menonton (v1.3.1): laporkan episode selesai SEKALI per episode
   per halaman (server juga menolak duplikat — exp_gained 0 bila episode
   itu sudah pernah diselesaikan). Toast HANYA bila naik level; bila
   exp_gained 0 (tonton ulang) tidak ada toast EXP apa pun. */
function reportWatchComplete(animeId, epNum) {
  /* v1.4.5: tamu tidak mengirim complete ke server (tanpa akun, tanpa
     EXP) — penanda lokal + auto-next tetap jalan dari pemanggil. */
  if (!watch.loggedIn) return;
  if (!animeId || !epNum) return;
  var key = animeId + ':' + epNum;
  if (watch.expReported[key]) return;
  watch.expReported[key] = true;
  apiWatchComplete(animeId, epNum).then(function (out) {
    if (out && out.leveled_up) showToast('Naik level! Kamu sekarang level ' + out.level + '.');
  }).catch(function () {
    /* Gagal lapor EXP (mis. sesi habis): tontonan tetap jalan, EXP
       episode ini tidak masuk — coba lagi di episode berikutnya. */
    delete watch.expReported[key];
  });
}

function saveContinue(anime, episode, progress) {
  /* v1.4.5: tamu tidak mengirim progres ke server — skip diam-diam. */
  if (!watch.loggedIn) return;
  if (!anime || !episode) return;
  var position = Math.round(progress && typeof progress.time === 'number' ? progress.time : 0);
  var duration = Math.round(progress && typeof progress.duration === 'number' ? progress.duration : 0);
  if (progress && progress.percent >= 100 && duration > 0) position = duration;
  apiSaveContinue(anime.id, episode.number, position, duration).catch(function () {
    /* gagal simpan ke server: halaman tetap jalan, progres tidak hilang
       total karena penanda lokal tetap dicatat saat complete */
  });
}

/* v1.5.4 fix F-02: posisi resume episode ini dari progres tersimpan.
   0 bila tidak ada progres / tamu / posisi sudah di ujung episode
   (sisa ≤5 dtk atau ≥95% — episode dianggap habis, mulai dari awal). */
function resumePositionFor(epNum) {
  var p = watch.progress && watch.progress[epNum];
  if (!p) return 0;
  var pos = typeof p.position_sec === 'number' ? p.position_sec : 0;
  var dur = typeof p.duration_sec === 'number' ? p.duration_sec : 0;
  if (pos <= 0) return 0;
  if (dur > 0 && (pos >= dur - 5 || pos / dur >= 0.95)) return 0;
  return pos;
}

async function loadProgress() {
  /* v1.4.5: tamu tidak memuat progres dari server ("Lanjutkan
     Menonton" hanya untuk yang login) — centang lokal tetap dipakai. */
  if (!watch.loggedIn) return;
  try {
    var res = await apiProgress(watch.anime.id);
    watch.progress = {};
    res.data.forEach(function (p) { watch.progress[p.episode] = p; });
    renderEpisodeList();
  } catch (err) { /* tamu / gagal: centang lokal tetap dipakai */ }
}

/* ---------- Daftar episode ---------- */

/* v1.5.8 item 49: ambang ditonton klien ≥90% (sama seperti detail.js). */
function isEpisodeWatchedWatch(ep) {
  var prog = watch.progress[ep.number];
  var pct = prog && typeof prog.percent === 'number' ? prog.percent : null;
  if (pct !== null && pct >= 90) return true;
  if (prog && prog.watched) return true;
  return isEpisodeWatchedLocal(watch.anime.id, ep.number);
}

function renderEpisodeList() {
  var box = document.getElementById('episode-list');
  var btnMore = document.getElementById('btn-more-episodes');
  var jumpSel = document.getElementById('ep-jump-select');
  var jumpInfo = document.getElementById('ep-jump-info');
  var countEl = document.getElementById('ep-count');
  if (!box) return;
  var list = watch.episodes.slice();
  list.sort(function (a, b) { return watch.asc ? (a.number - b.number) : (b.number - a.number); });
  if (countEl) countEl.textContent = list.length ? list.length + ' episode' : '';
  if (!list.length) {
    box.innerHTML = stateHTML('empty', 'Belum ada episode', 'Daftar episode belum tersedia.');
    if (btnMore) btnMore.hidden = true;
    return;
  }
  var totalPages = Math.ceil(list.length / PAGE_SIZE);
  if (jumpSel) {
    var opts = '';
    for (var p = 0; p < totalPages; p++) {
      opts += '<option value="' + p + '"' + (p === watch.jump ? ' selected' : '') + '>Ep ' + list[p * PAGE_SIZE].number + '–' + list[Math.min((p + 1) * PAGE_SIZE, list.length) - 1].number + '</option>';
    }
    jumpSel.innerHTML = opts;
    jumpSel.hidden = totalPages <= 1;
    jumpSel.onchange = function () {
      watch.jump = parseInt(jumpSel.value, 10) || 0;
      watch.shown = PAGE_SIZE;
      renderEpisodeList();
    };
  }
  var start = watch.jump * PAGE_SIZE;
  var shown = list.slice(start, start + watch.shown);
  if (jumpInfo) jumpInfo.textContent = 'Menampilkan Ep ' + shown[0].number + '–' + shown[shown.length - 1].number + ' dari ' + list.length + ' episode';
  box.innerHTML = shown.map(function (ep) {
    var watched = isEpisodeWatchedWatch(ep);
    var isCurrent = ep.number === watch.epNum;
    return '<button type="button" class="episode-item' + (isCurrent ? ' is-current' : '') + (watched ? ' is-watched' : '') + '" data-ep="' + ep.number + '">' +
      '<span class="episode-item__num">' + esc(ep.number) + '</span>' +
      '<span class="episode-item__body">' +
        '<span class="episode-item__title">' + esc(ep.title || ('Episode ' + ep.number)) + '</span>' +
        (ep.jp_title ? '<span class="episode-item__sub">' + esc(ep.jp_title) + '</span>' : '') +
      '</span>' +
      (watched ? '<span class="episode-item__watched" title="Sudah ditonton">' + icon('check') + '<span class="episode-item__watched-label">Sudah ditonton</span></span>' : '') +
      '<span class="episode-item__chev">' + icon('chevron') + '</span></button>';
  }).join('');
  box.querySelectorAll('.episode-item').forEach(function (btn) {
    btn.addEventListener('click', function () { goEpisode(parseInt(btn.getAttribute('data-ep'), 10)); });
  });
  if (btnMore) {
    btnMore.hidden = (start + watch.shown) >= list.length;
    btnMore.onclick = function () { watch.shown += PAGE_SIZE; renderEpisodeList(); };
  }
}

async function loadRelated(anime) {
  var sec = document.getElementById('sec-related');
  var rail = document.getElementById('rail-related');
  if (!sec || !rail) return;
  var genres = genreList(anime);
  if (!genres.length) { sec.hidden = true; return; }
  try {
    var res = await getGenre(genres[0], 1, 12);
    var items = res.data.filter(function (it) { return String(it.id) !== String(anime.id); }).slice(0, 8);
    if (!items.length) { sec.hidden = true; return; }
    sec.hidden = false;
    rail.innerHTML = items.map(function (item) { return cardHTML(item); }).join('');
    rail.dispatchEvent(new Event('scroll'));
  } catch (err) {
    sec.hidden = true;
  }
}

/* Pegangan uji (hanya baca): Cari Bug / Pentest memakai ini untuk
   membaca state player + waktu subtitle tanpa mengubah perilaku.
   controls: state kontrol custom v1.5.3 (visible/menuOpen/dll). */
window.__mitsu = { watch: watch, controls: cc };
