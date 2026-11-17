/* ============================================================
   subs.js — Mesin subtitle Indonesia progresif (v1.5.0, PRD §8)
   - Parse VTT Inggris (aturan sama dengan server services/subtitles.js).
   - Translate DI BROWSER penonton via endpoint Google Translate gratis
     (pola Sanka: 10 endpoint round-robin; protokol Qt: penanda «N»,
     [BR] untuk newline, lindungi tag HTML, normalisasi Rank/Class)
     + fallback MyMemory per item.
   - Progresif: batch pertama = 10 cue pertama (atau cue < 120 dtk,
     mana lebih sedikit) tampil segera; sisanya 15 cue/batch, maks 2
     worker paralel, cakupan ≥ 60 dtk di depan playhead; seek ke depan
     memprioritaskan batch posisi itu.
   - Satu track "Indonesia (AI)" campuran (cue belum diterjemahkan =
     Inggris, tidak pernah kosong); save-back per batch ke SQLite.
   - TIDAK PERNAH memanggil translate dari server; TIDAK memakai
     plananimek/vttnime/apikey Sanka; TIDAK menulis email apa pun ke
     kode (MyMemory dipanggil tanpa parameter &de=).
   ============================================================ */
(function () {
  'use strict';

  /* 10 endpoint Google Translate gratis (salinan persis dari laporan
     riset Sanka §2.6 — jangan mengarang endpoint baru). */
  var GOOGLE_ENDPOINTS = [
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=id&dt=t&q=',
    'https://clients1.google.com/translate_a/t?client=android&sl=en&tl=id&dt=t&q=',
    'https://www.google.com/translate_a/t?client=gtrans&sl=en&tl=id&q=',
    'https://encrypted.google.com/translate_a/t?client=gtd&sl=en&tl=id&q=',
    'https://translate.google.com/translate_a/t?client=tw-ob&sl=en&tl=id&dt=t&q=',
    'https://clients5.google.com/translate_a/single?client=dict-chrome-ex&sl=en&tl=id&q=',
    'https://translate.google.net/translate_a/t?client=gtd&sl=en&tl=id&q=',
    'https://translate.google.co.id/translate_a/t?client=chrome&sl=en&tl=id&q=',
    'https://google.com/translate_a/t?client=crx&sl=en&tl=id&q=',
    'https://translate.google.com.sg/translate_a/t?client=web&sl=en&tl=id&q=',
  ];
  var MYMEMORY_URL = 'https://api.mymemory.translated.net/get';
  var FIRST_BATCH_SIZE = 10;
  var FIRST_BATCH_MAX_START = 120; /* detik */
  var BATCH_SIZE = 15;
  var MAX_WORKERS = 2;
  var BATCH_GAP_MS = 50;
  var COVERAGE_AHEAD_SEC = 60;
  var TRANSLATE_TIMEOUT_MS = 8000; /* pola TOTAL_TIMEOUT_MS services/translate.js */
  var MYMEMORY_ITEM_GAP_MS = 100;
  var MYMEMORY_COOLDOWN_MS = 3000;

  /* Cache in-memory per halaman (Map sourceKey → { translated: Map,
     complete: bool }): pindah episode lalu kembali tidak mengulang
     translate. */
  var PAGE_CACHE = new Map();

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* ---------- VTT: parse + rakit (aturan = server subtitles.js) ---------- */
  function parseTimestamp(s) {
    var m = String(s || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{1,3})$/);
    if (!m) return null;
    var h = m[1] ? parseInt(m[1], 10) : 0;
    return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
      + parseInt(m[4].padEnd(3, '0'), 10) / 1000;
  }

  function formatTimestamp(sec) {
    var totalMs = Math.round(sec * 1000);
    var ms = totalMs % 1000;
    var s = Math.floor(totalMs / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(ss, 2) + '.' + pad(ms, 3);
  }

  function parseVtt(text) {
    var src = String(text || '').replace(/\r\n?/g, '\n');
    var blocks = src.split(/\n\s*\n/);
    var cues = [];
    for (var b = 0; b < blocks.length; b++) {
      var lines = blocks[b].split('\n').map(function (l) { return l.replace(/\s+$/, ''); })
        .filter(function (l) { return l.trim() !== ''; });
      if (!lines.length) continue;
      if (lines[0].indexOf('WEBVTT') === 0) continue;
      var tsIdx = -1;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('-->') !== -1) { tsIdx = i; break; }
      }
      if (tsIdx === -1) continue;
      var parts = lines[tsIdx].split('-->').map(function (s) { return s.trim(); });
      var start = parseTimestamp(parts[0]);
      var end = parseTimestamp((parts[1] || '').split(/\s+/)[0]);
      if (start == null || end == null || !(end > start)) continue;
      var cueText = lines.slice(tsIdx + 1).join('\n').trim();
      if (!cueText) continue;
      cues.push({ index: cues.length, start: start, end: end, text: cueText });
    }
    return cues;
  }

  function buildVtt(cues, translated) {
    var out = ['WEBVTT', ''];
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      var text = translated.has(c.index) ? translated.get(c.index) : c.text;
      out.push(formatTimestamp(c.start) + ' --> ' + formatTimestamp(c.end));
      out.push(text);
      out.push('');
    }
    return out.join('\n');
  }

  /* ---------- Protokol translate Qt (pola Sanka §3.4) ---------- */
  function protectHtml(text) {
    return String(text).replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)>/g, function (m, slash, tag) {
      return slash ? '___HTMCLS_' + tag + '___' : '___HTMOPN_' + tag + '___';
    });
  }
  function restoreHtml(text) {
    return String(text)
      .replace(/___HTMOPN_([A-Za-z][A-Za-z0-9]*)___/g, '<$1>')
      .replace(/___HTMCLS_([A-Za-z][A-Za-z0-9]*)___/g, '</$1>');
  }
  function normalizeRank(text) {
    return String(text).replace(/\b([A-Za-z])-(Rank|Class|Tier|Grade)\b/g, '$2 $1');
  }

  function buildQuery(cues) {
    return cues.map(function (c) {
      var t = normalizeRank(protectHtml(c.text)).replace(/\n/g, '[BR]');
      return '«' + c.index + '»' + t;
    }).join('\n');
  }

  /* Parse respons Google: /single → w[0] array kalimat; /t → string
     (atau array string). Mengembalikan string gabungan (per baris). */
  function parseGoogleResponse(json, isSingle) {
    if (typeof json === 'string') return json;
    if (!Array.isArray(json)) return null;
    if (isSingle) {
      var sentences = json[0];
      if (!Array.isArray(sentences)) return null;
      return sentences.map(function (s) {
        return Array.isArray(s) ? (s[0] || '') : (typeof s === 'string' ? s : '');
      }).join('');
    }
    var parts = [];
    for (var i = 0; i < json.length; i++) {
      if (typeof json[i] === 'string') parts.push(json[i]);
      else if (Array.isArray(json[i]) && typeof json[i][0] === 'string') parts.push(json[i][0]);
    }
    return parts.join('\n');
  }

  /* Pecah teks gabungan kembali per penanda «N»: baris tanpa penanda
     disambung ke cue sebelumnya; [BR] → newline. */
  function splitTranslated(combined) {
    var out = new Map();
    var lines = String(combined || '').split('\n');
    var cur = null;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^«(\d+)»(.*)$/);
      if (m) {
        cur = parseInt(m[1], 10);
        out.set(cur, restoreHtml(m[2]).replace(/\[BR\]/g, '\n').trim());
      } else if (cur !== null) {
        var prev = out.get(cur) || '';
        out.set(cur, (prev ? prev + '\n' : '') + restoreHtml(lines[i]).replace(/\[BR\]/g, '\n'));
      }
    }
    /* Buang hasil kosong (cue gagal diterjemahkan — tetap Inggris). */
    out.forEach(function (v, k) { if (!v || !v.trim()) out.delete(k); });
    return out;
  }

  function fetchWithTimeout(url, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch(url, { signal: controller.signal })
      .finally(function () { clearTimeout(timer); });
  }

  /* Satu panggilan Google untuk satu batch (cue yang masih kosong).
     Melempar bila endpoint gagal / respons tidak bisa dipakai. */
  async function translateViaGoogle(cues, endpointUrl) {
    var isSingle = endpointUrl.indexOf('/single') !== -1;
    var url = endpointUrl + encodeURIComponent(buildQuery(cues));
    var res = await fetchWithTimeout(url, TRANSLATE_TIMEOUT_MS);
    if (!res.ok) throw new Error('Google ' + res.status);
    var raw = await res.text();
    var json;
    try { json = JSON.parse(raw); } catch (e) { json = raw; }
    var combined = parseGoogleResponse(json, isSingle);
    if (combined == null || !String(combined).trim()) throw new Error('Respons Google kosong');
    var got = splitTranslated(combined);
    /* Hanya kembalikan cue yang memang diminta batch ini. */
    var out = new Map();
    cues.forEach(function (c) { if (got.has(c.index)) out.set(c.index, got.get(c.index)); });
    if (out.size === 0) throw new Error('Tidak ada cue yang diterjemahkan');
    return out;
  }

  /* Fallback MyMemory per item (tanpa parameter &de= — email tidak
     tersedia di client dan TIDAK BOLEH ditulis ke kode). */
  async function translateViaMyMemory(cue) {
    var url = MYMEMORY_URL + '?q=' + encodeURIComponent(cue.text)
      + '&langpair=en|id';
    var res = await fetchWithTimeout(url, TRANSLATE_TIMEOUT_MS);
    if (res.status === 429) {
      var e = new Error('MyMemory 429');
      e.code = 'RATE_LIMITED';
      throw e;
    }
    if (!res.ok) throw new Error('MyMemory ' + res.status);
    var json = await res.json().catch(function () { return null; });
    var t = json && json.responseData && typeof json.responseData.translatedText === 'string'
      ? json.responseData.translatedText.trim() : '';
    if (!t || /^MYMEMORY WARNING/i.test(t) || /QUERY LENGTH LIMIT/i.test(t)) {
      throw new Error('MyMemory tanpa hasil');
    }
    return t;
  }

  /* Terjemahkan satu batch. Google round-robin (mulai dari endpoint
     nomor batchNo), cue kosong dicoba di endpoint berikut (sampai 10
     habis); sisanya MyMemory per item. Sukses bila ≥ 50% cue terisi. */
  async function translateBatch(cues, batchNo) {
    var results = new Map();
    var pending = cues.slice();
    for (var k = 0; k < GOOGLE_ENDPOINTS.length && pending.length > 0; k++) {
      var epIdx = (batchNo + k) % GOOGLE_ENDPOINTS.length;
      try {
        var got = await translateViaGoogle(pending, GOOGLE_ENDPOINTS[epIdx]);
        got.forEach(function (text, idx) { results.set(idx, text); });
        pending = pending.filter(function (c) { return !results.has(c.index); });
      } catch (e) { /* endpoint gagal — coba berikutnya */ }
    }
    for (var i = 0; i < pending.length; i++) {
      if (i > 0) await sleep(MYMEMORY_ITEM_GAP_MS);
      try {
        var t = await translateViaMyMemory(pending[i]);
        results.set(pending[i].index, t);
      } catch (e) {
        if (e && e.code === 'RATE_LIMITED') { await sleep(MYMEMORY_COOLDOWN_MS); break; }
      }
    }
    return { results: results, ok: results.size >= Math.ceil(cues.length / 2) };
  }

  /* ================= Engine ================= */
  function SubtitleEngine(opts) {
    this.animeId = opts.animeId;
    this.episode = opts.episode;
    this.sourceHash = opts.sourceHash;
    this.enVttUrl = opts.enVttUrl;
    this.video = opts.video;
    this.onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : function () {};
    this.onTrackRebuilt = typeof opts.onTrackRebuilt === 'function' ? opts.onTrackRebuilt : function () {};
    this.cacheKey = opts.animeId + ':' + opts.episode + ':' + opts.sourceHash;
    this.cues = [];
    this.translated = new Map();
    this.batches = [];
    this.activeWorkers = 0;
    this.batchCounter = 0;
    this.stopped = false;
    this.failedTotal = false;
    this.firstBatchDone = false;
    this.complete = false;
    this.currentTime = 0;
    this.playingAt = null; /* performance.now saat event playing pertama */
    this.firstBatchAppliedAt = null;
    this.trackReadyAt = null;
    this.trackEl = null;
    this.blobUrl = null;
    this.idVisible = true;
    this.started = false;
  }

  SubtitleEngine.prototype.report = function () {
    this.onStatus({
      /* 'failed' mengalahkan 'complete': bila batch pertama gagal
         total, semua batch lain akhirnya habis dan checkComplete()
         menandai complete — tanpa pengecualian ini tombol "Coba
         lagi" hilang dan status berbohong "Subtitle Indonesia (AI)"
         padahal isinya Inggris (PRD §7.4).
         'partial' mengalahkan 'complete' bila terjemahan hanya
         sebagian: batch pertama berhasil tapi batch berikut gagal
         (F-01) — tanpa ini status berbohong "Subtitle Indonesia
         (AI)" polos padahal sebagian besar cue masih Inggris, dan
         tombol "Coba lagi" tidak pernah tampil. */
      state: (this.failedTotal && this.translated.size < this.cues.length) ? 'failed'
        : (this.complete && this.translated.size < this.cues.length) ? 'partial'
        : this.complete ? 'complete'
        : this.failedTotal ? 'failed'
        : this.firstBatchDone ? 'partial' : 'translating',
      translated: this.translated.size,
      total: this.cues.length,
      failedTotal: this.failedTotal,
      firstBatchDone: this.firstBatchDone,
      complete: this.complete,
    });
  };

  SubtitleEngine.prototype.coverageEnd = function () {
    var end = 0;
    this.translated.forEach(function (text, idx) {
      var c = this.cues[idx];
      if (c && c.end > end) end = c.end;
    }, this);
    return end;
  };

  SubtitleEngine.prototype.rebuildTrack = function () {
    var self = this;
    var vtt = buildVtt(this.cues, this.translated);
    var blob = new Blob([vtt], { type: 'text/vtt' });
    var url = URL.createObjectURL(blob);
    if (this.blobUrl) { try { URL.revokeObjectURL(this.blobUrl); } catch (e) {} }
    this.blobUrl = url;
    var track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = 'Indonesia (AI)';
    track.srclang = 'id';
    track.src = url;
    track.addEventListener('load', function () {
      if (!self.trackReadyAt) self.trackReadyAt = performance.now();
    });
    if (this.trackEl && this.trackEl.parentNode) {
      this.trackEl.parentNode.replaceChild(track, this.trackEl);
    } else {
      this.video.appendChild(track);
    }
    this.trackEl = track;
    if (this.idVisible && track.track) track.track.mode = 'showing';
    else if (track.track) track.track.mode = 'disabled';
    this.onTrackRebuilt();
  };

  SubtitleEngine.prototype.setVisible = function (visible) {
    this.idVisible = !!visible;
    if (this.trackEl && this.trackEl.track) {
      this.trackEl.track.mode = this.idVisible ? 'showing' : 'disabled';
    }
  };

  SubtitleEngine.prototype.markPlaying = function () {
    if (this.playingAt == null) this.playingAt = performance.now();
    this.pump();
  };

  SubtitleEngine.prototype.onTimeUpdate = function (t) {
    this.currentTime = t;
    this.pump();
  };

  /* Pindah batch yang memuat posisi t ke depan antrean. */
  SubtitleEngine.prototype.prioritize = function (t) {
    var target = null;
    for (var i = 0; i < this.batches.length; i++) {
      var b = this.batches[i];
      if (b.status !== 'pending') continue;
      for (var j = 0; j < b.cues.length; j++) {
        if (t >= b.cues[j].start - 0.5 && t <= b.cues[j].end + 0.5) { target = b; break; }
      }
      if (target) break;
    }
    if (!target) {
      /* Tidak ada cue aktif di t — ambil batch pertama yang
         cue-nya mulai setelah t. */
      for (var k = 0; k < this.batches.length; k++) {
        var b2 = this.batches[k];
        if (b2.status === 'pending' && b2.cues[0] && b2.cues[0].start > t) { target = b2; break; }
      }
    }
    if (target) {
      target.priority = true;
      this.pump();
    }
  };

  SubtitleEngine.prototype.nextBatch = function () {
    var fallback = null;
    for (var i = 0; i < this.batches.length; i++) {
      var b = this.batches[i];
      if (b.status !== 'pending') continue;
      if (b.priority) return b;
      if (!fallback) fallback = b;
    }
    return fallback;
  };

  SubtitleEngine.prototype.needsWork = function () {
    if (this.stopped || this.complete) return false;
    if (!this.firstBatchDone) return true;
    if (this.nextBatch() && this.nextBatch().priority) return true;
    return this.coverageEnd() < this.currentTime + COVERAGE_AHEAD_SEC;
  };

  SubtitleEngine.prototype.pump = function () {
    var self = this;
    if (this.stopped || this.complete) return;
    while (this.activeWorkers < MAX_WORKERS && this.needsWork()) {
      var batch = this.nextBatch();
      if (!batch) return;
      /* Jeda antar batch (pola Sanka: 50 ms). */
      if (this.lastBatchStartAt != null
        && performance.now() - this.lastBatchStartAt < BATCH_GAP_MS) {
        var wait = BATCH_GAP_MS - (performance.now() - this.lastBatchStartAt);
        setTimeout(function () { self.pump(); }, wait);
        return;
      }
      batch.status = 'active';
      batch.priority = false;
      this.activeWorkers++;
      this.lastBatchStartAt = performance.now();
      this.runBatch(batch).finally(function () {
        self.activeWorkers--;
        self.pump();
      });
      if (this.activeWorkers >= MAX_WORKERS) break;
    }
  };

  SubtitleEngine.prototype.runBatch = async function (batch) {
    var self = this;
    batch.attempts++;
    var res;
    try {
      res = await translateBatch(batch.cues, this.batchCounter++);
    } catch (e) {
      res = { results: new Map(), ok: false };
    }
    if (this.stopped) {
      /* User memilih Off selagi batch jalan: buang hasilnya dan
         kembalikan batch ke antrean supaya bisa diterjemahkan lagi
         bila translate dilanjutkan (jangan biarkan macet 'active'). */
      batch.status = 'pending';
      return;
    }
    res.results.forEach(function (text, idx) { self.translated.set(idx, text); });
    if (res.ok) {
      batch.status = 'done';
    } else if (batch.attempts < 2) {
      batch.status = 'pending'; /* coba ulang sekali di akhir antrean */
    } else {
      batch.status = 'failed';
    }
    if (!this.firstBatchDone && batch.isFirst) {
      this.firstBatchDone = true;
      this.firstBatchAppliedAt = performance.now();
      if (!res.ok) this.failedTotal = true;
    }
    /* Simpan-kembali per batch (hanya cue yang berhasil). */
    if (res.results.size > 0) this.saveBatch(batch, res.results);
    /* Cache in-memory halaman. */
    var cached = PAGE_CACHE.get(this.cacheKey);
    if (cached) {
      res.results.forEach(function (text, idx) { cached.translated.set(idx, text); });
    }
    this.rebuildTrack();
    this.checkComplete();
    this.report();
  };

  SubtitleEngine.prototype.checkComplete = function () {
    if (this.complete) return;
    var remaining = this.batches.some(function (b) { return b.status === 'pending' || b.status === 'active'; });
    if (!remaining && this.translated.size >= this.cues.length) {
      this.complete = true;
      var cached = PAGE_CACHE.get(this.cacheKey);
      if (cached) cached.complete = true;
    } else if (!remaining) {
      /* Semua batch selesai/gagal final tapi belum semua cue
         terisi — tetap tandai selesai supaya tidak ada lagi
         request translate di sesi ini (PRD §8.4.7). */
      this.complete = true;
    }
  };

  SubtitleEngine.prototype.saveBatch = function (batch, results) {
    if (typeof saveSubCues !== 'function') return;
    var cues = [];
    results.forEach(function (text, idx) {
      var c = this.cues[idx];
      if (c) cues.push({ index: c.index, start: c.start, end: c.end, text: text });
    }, this);
    if (!cues.length) return;
    var self = this;
    var payload = {
      anime_id: this.animeId, episode: this.episode,
      source_hash: this.sourceHash, cues: cues,
    };
    /* Fire-and-forget, retry SEKALI bila gagal jaringan (400
       validasi tidak di-retry — server menolak dengan sengaja). */
    saveSubCues(payload.anime_id, payload.episode, payload.source_hash, payload.cues)
      .catch(function (err) {
        if (err && err.status === 400) return;
        return saveSubCues(payload.anime_id, payload.episode, payload.source_hash, payload.cues)
          .catch(function () { /* cache bisa dilengkapi penonton berikut */ });
      });
  };

  SubtitleEngine.prototype.buildBatches = function () {
    var remaining = this.cues.filter(function (c) { return !this.translated.has(c.index); }, this);
    if (!remaining.length) { this.complete = true; return; }
    /* Batch pertama: 10 cue pertama (atau cue < 120 dtk, mana
       lebih sedikit) — dihitung dari cue sumber, bukan dari sisa. */
    var firstCount = 0;
    for (var i = 0; i < this.cues.length && firstCount < FIRST_BATCH_SIZE; i++) {
      if (this.cues[i].start < FIRST_BATCH_MAX_START) firstCount++;
      else break;
    }
    firstCount = Math.max(1, Math.min(FIRST_BATCH_SIZE, firstCount));
    var firstCues = [];
    var rest = [];
    var taken = 0;
    remaining.forEach(function (c) {
      if (taken < firstCount && c.index < firstCount) { firstCues.push(c); taken++; }
      else rest.push(c);
    });
    /* Bila cue awal sudah diterjemahkan dari cache, batch pertama
       adalah sisa cue awal yang belum diterjemahkan (bila ada). */
    if (firstCues.length) {
      this.batches.push({ cues: firstCues, status: 'pending', attempts: 0, priority: false, isFirst: true });
    } else {
      this.firstBatchDone = true;
      this.firstBatchAppliedAt = performance.now();
    }
    for (var j = 0; j < rest.length; j += BATCH_SIZE) {
      this.batches.push({
        cues: rest.slice(j, j + BATCH_SIZE),
        status: 'pending', attempts: 0, priority: false, isFirst: false,
      });
    }
    /* Jeda antar batch (50 ms) diterapkan di pump lewat penundaan
       start worker kedua — di sini tidak ada yang perlu dilakukan. */
  };

  SubtitleEngine.prototype.start = async function () {
    if (this.started) return;
    this.started = true;
    var self = this;
    /* Ambil VTT Inggris + cek cache server secara paralel. */
    var vttPromise = fetch(this.enVttUrl, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('VTT ' + res.status);
        return res.text();
      });
    var cachePromise = (typeof checkSubCache === 'function')
      ? checkSubCache(this.animeId, this.episode, this.sourceHash)
          .then(function (body) { return body && body.data ? body.data : null; })
          .catch(function () { return null; })
      : Promise.resolve(null);
    var vttText;
    try {
      vttText = await vttPromise;
    } catch (e) {
      this.onStatus({ state: 'no-source', translated: 0, total: 0 });
      return;
    }
    var cached = await cachePromise;
    this.cues = parseVtt(vttText);
    if (!this.cues.length) {
      this.onStatus({ state: 'no-source', translated: 0, total: 0 });
      return;
    }
    /* Modal awal: cache halaman + cache server. */
    var pageCached = PAGE_CACHE.get(this.cacheKey);
    if (pageCached) {
      pageCached.translated.forEach(function (text, idx) { self.translated.set(idx, text); });
      if (pageCached.complete) this.complete = true;
    }
    if (cached && Array.isArray(cached.cues)) {
      cached.cues.forEach(function (c) {
        if (c && typeof c.index === 'number' && typeof c.text === 'string' && c.text) {
          self.translated.set(c.index, c.text);
        }
      });
    }
    if (!PAGE_CACHE.has(this.cacheKey)) {
      PAGE_CACHE.set(this.cacheKey, { translated: new Map(this.translated), complete: this.complete });
    }
    this.rebuildTrack();
    if (this.translated.size >= this.cues.length) {
      this.complete = true;
      this.firstBatchDone = true;
      this.firstBatchAppliedAt = performance.now();
      this.report();
      return;
    }
    this.buildBatches();
    this.report();
    this.pump();
  };

  SubtitleEngine.prototype.stop = function () {
    this.stopped = true;
  };

  SubtitleEngine.prototype.resume = function () {
    if (this.complete) return;
    /* failedTotal TIDAK direset di sini: batch pertama yang gagal
       total hanya bisa diulang lewat retry() ("Coba lagi"). */
    this.stopped = false;
    this.pump();
  };

  SubtitleEngine.prototype.retry = function () {
    /* Antre ulang SEMUA batch yang gagal — bukan hanya batch
       pertama (F-01): bila batch pertama berhasil tapi batch
       berikut gagal, status 'partial' sesudah complete tetap
       harus bisa diulang; kalau tidak, tombol "Coba lagi" hanya
       memperbaiki batch pertama dan cue yang gagal di batch lain
       tidak pernah diterjemahkan. */
    var requeuedFirst = false;
    for (var i = 0; i < this.batches.length; i++) {
      if (this.batches[i].status === 'failed') {
        this.batches[i].status = 'pending';
        this.batches[i].attempts = 0;
        this.batches[i].priority = true;
        if (this.batches[i].isFirst) requeuedFirst = true;
      }
    }
    this.failedTotal = false;
    /* firstBatchDone hanya direset bila batch pertama ikut diantre
       ulang — bila batch pertama sudah berhasil, jangan ganggu
       penandanya (dipakai firstSubtitleMs + needsWork). */
    if (requeuedFirst) this.firstBatchDone = false;
    /* complete harus direset juga: tombol "Coba lagi" tetap tampil
       setelah semua batch habis (lihat report()), dan pump()
       menolak jalan bila complete masih true. */
    this.complete = false;
    this.stopped = false;
    this.report();
    this.pump();
  };

  /* Pengukuran untuk uji (PRD §8.2): milidetik performance.now. */
  SubtitleEngine.prototype.timings = function () {
    return {
      playingAt: this.playingAt,
      firstBatchAppliedAt: this.firstBatchAppliedAt,
      trackReadyAt: this.trackReadyAt,
      firstSubtitleMs: (this.playingAt != null && this.firstBatchAppliedAt != null)
        ? Math.max(0, Math.round(this.firstBatchAppliedAt - this.playingAt)) : null,
      translated: this.translated.size,
      total: this.cues.length,
      complete: this.complete,
    };
  };

  window.SubtitleEngine = SubtitleEngine;
  window.SubsVtt = { parseVtt: parseVtt, buildVtt: buildVtt, formatTimestamp: formatTimestamp };
})();
