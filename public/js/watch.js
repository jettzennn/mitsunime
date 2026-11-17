/* ============================================================
   watch.js — Halaman tonton Mitsunime (v1.5.0: Server HD + Sub Indo)
   - Server HD (default): player <video> + hls.js (file vendor, lazy)
     memutar HLS VidCloud lewat proxy origin sendiri; subtitle
     Indonesia (AI) diterjemahkan progresif di browser (subs.js) dan
     di-cache di server.
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
  progress: {}, expReported: {}, /* episode yang sudah dilaporkan selesai (anti-duplikat) */
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
    loadProgress();
    loadRelated(watch.anime);
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
  document.title = decodeEntities(a.title || 'Tonton') + ' — Mitsunime';
  var titleEl = document.getElementById('watch-title');
  if (titleEl) titleEl.textContent = decodeEntities(a.title || 'Tonton');
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
    var prev = watch.subMode;
    watch.subMode = subSel.value;
    if (watch.subMode === 'off') {
      if (watch.subs) watch.subs.stop();
    } else if (prev === 'off' && watch.subs) {
      watch.subs.resume();
    }
    applySubMode();
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
      onServerFailed('Server HD gagal memutar video');
      tryNextServer(false);
    });
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
  if (wtEl) wtEl.textContent = decodeEntities(watch.anime.title || 'Tonton');
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
  playServer(0);
  saveContinue(watch.anime, ep, { lang: lang, percent: 0, time: 0, duration: 0 });
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
function playServer(idx) {
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
  if (srv.kind === 'hd') playHdServer(srv, 0);
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
  showPlayerLoading('Server ' + prevName + ' gagal, mencoba ' + nextName + '…');
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
  showPlayerLoading('Memuat Server HD…');
  var hd;
  try {
    hd = await getStreamHD(watch.anime.id, watch.epNum, watch.lang);
  } catch (err) {
    onServerFailed(err && err.message ? err.message : 'Server HD tidak merespons');
    tryNextServer(false);
    return;
  }
  var d = hd && hd.data;
  if (!d || !d.hls_url) {
    onServerFailed('Server HD tidak mengembalikan video');
    tryNextServer(false);
    return;
  }
  watch.hd = { manifest: d, hls: null, useNative: false, mediaRecovered: false };
  /* Muat hls.js (lazy) bila perlu; bila gagal dan browser tidak bisa
     HLS native → HD gagal → fallback. */
  var hls = null;
  var useNative = false;
  if (window.Hls && window.Hls.isSupported()) {
    hls = new Hls({ maxBufferLength: 30, manifestLoadingMaxRetry: 2 });
  } else {
    var ok = await loadHlsScript();
    if (ok && window.Hls && window.Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 30, manifestLoadingMaxRetry: 2 });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      useNative = true;
    } else {
      onServerFailed('Browser ini tidak bisa memutar Server HD');
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
  onServerFailed('Server HD gagal memutar video');
  tryNextServer(false);
}

/* ---------- Server iframe ---------- */
function playIframeServer(srv) {
  stopHd();
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
}

function applySubMode() {
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
    html = 'Subtitle Indonesia (AI) — ' + st.translated + '/' + st.total + ' cue';
    if (st.complete) {
      /* Terjemahan selesai tapi hanya sebagian (F-01): beri tombol
         "Coba lagi" — tanpa ini pengguna tidak bisa tahu sebagian
         besar subtitle masih Inggris, dan tidak ada jalan untuk
         mengulang batch yang gagal. Selama translate masih berjalan
         (complete false) tombol tidak tampil. */
      html += ' <button class="btn btn-ghost btn-sm" id="btn-sub-retry" type="button">Coba lagi</button>';
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
      ? 'Server ' + name + ' gagal, mencoba server berikutnya…'
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
    saveContinue(watch.anime, watch.currentEp, { lang: watch.lang, percent: 100, time: 0, duration: 0 });
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
    var prog = watch.progress[ep.number];
    var watched = (prog && prog.watched) || isEpisodeWatchedLocal(watch.anime.id, ep.number);
    var isCurrent = ep.number === watch.epNum;
    return '<button type="button" class="episode-item' + (isCurrent ? ' is-current' : '') + '" data-ep="' + ep.number + '">' +
      '<span class="episode-item__num">' + esc(ep.number) + '</span>' +
      '<span class="episode-item__body">' +
        '<span class="episode-item__title">' + esc(ep.title || ('Episode ' + ep.number)) + '</span>' +
        (ep.jp_title ? '<span class="episode-item__sub">' + esc(ep.jp_title) + '</span>' : '') +
      '</span>' +
      (watched ? '<span class="episode-item__watched" title="Sudah ditonton">' + icon('check') + '</span>' : '') +
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
   membaca state player + waktu subtitle tanpa mengubah perilaku. */
window.__mitsu = { watch: watch };
