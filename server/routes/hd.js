'use strict';
// Rute Server HD (v1.5.0, PRD §4–§5; mesin diganti ke MegaPlay di
// v1.5.1, PRD §4): resolusi stream-hd, proxy HLS/VTT lewat token
// opaque, dan cache subtitle (check-cache + save).
// Semua fetch ke upstream dilakukan server-side; browser penonton HANYA
// memanggil origin Mitsunime sendiri. URL/token upstream TIDAK PERNAH
// keluar ke client, log, atau DB (anti-SSRF — kriteria Pentest §12.4).
const config = require('../config');
const logger = require('../utils/logger');
const mw = require('../middleware/auth');
const anikoto = require('../services/anikoto');
const cache = require('../services/cache');
const megaplay = require('../services/megaplay');
const subtitles = require('../services/subtitles');
const proxyTokens = require('../services/proxyTokens');

const FETCH_TIMEOUT_MS = config.FETCH_TIMEOUT_MS; // 20 dtk (proxy upstream)

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
  return true; // penanda untuk router: rute sudah ditangani
}

function err(res, status, message) {
  return send(res, status, { ok: false, message });
}

// Dekode HTML entity (salinan dari routes/public.js — dipakai untuk
// judul episode dari payload Anikoto).
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#34': '"',
  nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”',
};
function decodeEntities(value) {
  const s = String(value == null ? '' : value);
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body) => {
    if (body.charAt(0) === '#') {
      const code = (body.charAt(1) === 'x' || body.charAt(1) === 'X')
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : m;
  });
}

function numOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Muat data series untuk stream-hd: cache-first seperti handleStream
// (public.js), dengan guard cache-miss sendiri `stream-hd-miss:*`
// (30/menit per pengguna login, per IP bila tamu — PRD §4.5).
// Mengembalikan { data } atau null (respons sudah dikirim).
async function loadSeriesForHd(req, res, id) {
  const cached = cache.getSeries(id);
  let data = cached ? cached.data : null;
  const fresh = cached && (cache.nowSec() - cached.fetchedAt) <= config.SERIES_TTL_SECONDS;
  if (fresh) return { data };
  const missKey = req.user
    ? `stream-hd-miss:user:${req.user.id}`
    : `stream-hd-miss:guest:${mw.clientIp(req)}`;
  if (mw.rateLimited(missKey, 30, 60 * 1000)) {
    if (!data) {
      err(res, 429, 'Terlalu banyak permintaan. Coba lagi sebentar lagi.');
      return null;
    }
    logger.warn(`stream-hd/${id}: batas cache-miss tercapai, pakai cache basi`);
    return { data };
  }
  try {
    const body = await anikoto.getSeries(id);
    data = body.data || null;
    if (!data || !data.anime) throw new anikoto.AnikotoError(404, 'Anime tidak ditemukan di Anikoto.');
    cache.putSeries(id, data);
    if (data.anime) cache.upsertAnimeSafe(data.anime);
    cache.recordAnikotoStatus(true, 200, null);
    return { data };
  } catch (e) {
    if (e.status === 404) {
      err(res, 404, 'Anime tidak ditemukan. ID ini tidak ada di katalog Anikoto.');
      return null;
    }
    cache.recordAnikotoStatus(false, e.status || 0, e.message);
    if (!data) {
      err(res, 502, 'Anikoto sedang tidak dapat dijangkau. Coba lagi sebentar lagi.');
      return null;
    }
    return { data };
  }
}

// GET /api/series/:id/episodes/:ep/stream-hd?lang=sub|dub — PRD §5.1.
async function handleStreamHd(req, res, url, idRaw, epRaw) {
  const id = Number.parseInt(idRaw, 10);
  const epNum = Number.parseInt(epRaw, 10);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(epNum) || epNum <= 0) {
    return err(res, 404, 'Episode tidak ditemukan.');
  }
  // L-16 (v1.5.1, PRD §4.6): rate limit stream-hd itu sendiri, 30/menit,
  // TERLEPAS dari status cache — di awal handler, sebelum loadSeriesForHd.
  // Kunci terpisah dari guard cache-miss `stream-hd-miss:*` (yang tetap ada).
  const hdKey = req.user
    ? `stream-hd:user:${req.user.id}`
    : `stream-hd:guest:${mw.clientIp(req)}`;
  if (mw.rateLimited(hdKey, 30, 60 * 1000)) {
    return err(res, 429, 'Terlalu banyak permintaan. Coba lagi sebentar lagi.');
  }
  const lang = url.searchParams.get('lang') === 'dub' ? 'dub' : 'sub';
  const loaded = await loadSeriesForHd(req, res, id);
  if (!loaded) return true;
  const { data } = loaded;
  const episodes = Array.isArray(data.episodes) ? data.episodes : [];
  const ep = episodes.find((x) => x && Number.parseInt(x.number, 10) === epNum);
  if (!ep) return err(res, 404, `Episode ${epNum} tidak ada untuk judul ini.`);
  // v1.5.1: Server HD bermesin MegaPlay — diidentifikasi lewat
  // episode_embed_id Anikoto (field yang sama dipakai URL iframe MegaPlay).
  // ani_id/mal_id TIDAK lagi dipakai untuk Server HD (tetap dipakai
  // buildServers untuk URL iframe — servers.js tidak berubah).
  const episodeEmbedId = ep.episode_embed_id != null && String(ep.episode_embed_id) !== ''
    ? String(ep.episode_embed_id) : null;
  if (!episodeEmbedId) return err(res, 404, 'Episode ini belum punya tautan Server HD.');
  let resolved;
  try {
    resolved = await megaplay.resolveSources(episodeEmbedId, epNum, lang);
  } catch (e) {
    // Pesan e TIDAK mengandung URL upstream (megaplay.js menjaminnya).
    logger.warn(`stream-hd/${id}/${epNum}: MegaPlay gagal (${e.message})`);
    return err(res, 502, 'MegaPlay sedang tidak dapat dijangkau.');
  }
  const masterUrl = resolved.sources && resolved.sources[0] && resolved.sources[0].file;
  if (typeof masterUrl !== 'string' || !/^https?:\/\//.test(masterUrl)) {
    return err(res, 502, 'MegaPlay sedang tidak dapat dijangkau.');
  }
  const hlsToken = proxyTokens.issue(masterUrl, 'master');
  // Track subtitle: hanya label yang terpetakan ke kode bahasa.
  // Satu entri per bahasa — track non-Forced (Full) menang; Forced hanya
  // disimpan bila tidak ada non-Forced bahasa itu (§7F.3 (b), item 19).
  const picked = new Map(); // lang -> { label, file, isDefault, forced }
  for (const t of (Array.isArray(resolved.tracks) ? resolved.tracks : [])) {
    if (!t || typeof t.file !== 'string' || !/^https?:\/\//.test(t.file)) continue;
    const lg = megaplay.trackLang(t.label);
    if (!lg) continue;
    const forced = megaplay.isForcedTrack(t);
    const cur = picked.get(lg);
    if (cur) {
      // Sudah ada entri: ganti HANYA bila yang tersimpan Forced dan yang
      // baru bukan Forced. Selain itu simpan yang pertama.
      if (!(cur.forced && !forced)) continue;
    }
    picked.set(lg, { label: t.label, file: t.file, isDefault: t.default === true, forced });
  }
  const tracks = [];
  let enFile = null;
  let hasDefault = false;
  for (const [lg, p] of picked) {
    const token = proxyTokens.issue(p.file, 'vtt');
    if (p.isDefault) hasDefault = true;
    tracks.push({ label: p.label, lang: lg, url: `/api/hd/sub/${token}`, default: p.isDefault });
    if (lg === 'en' && !enFile) enFile = p.file;
  }
  // PRD §5.1.1 langkah 2: bila belum ada track Inggris dari label,
  // pakai petunjuk nama file ('eng' di URL) — jangan menebak track pertama.
  if (!enFile) {
    const enTrack = megaplay.englishTrack(resolved.tracks);
    if (enTrack) {
      const token = proxyTokens.issue(enTrack.file, 'vtt');
      tracks.push({
        label: (enTrack.label && String(enTrack.label).trim()) || 'English',
        lang: 'en',
        url: `/api/hd/sub/${token}`,
        default: false,
      });
      enFile = enTrack.file;
    }
  }
  if (!hasDefault) {
    const en = tracks.find((t) => t.lang === 'en');
    if (en) en.default = true;
  }
  // VTT Inggris → source_hash + source cues (untuk validasi save +
  // status cache). Gagal mengambil VTT = fail soft: video tetap jalan,
  // Sub Indo tidak tersedia untuk resolusi ini (tanpa source_hash).
  let sourceHash = null;
  let cacheStatus = { status: 'none', cue_count: 0, translated_count: 0 };
  if (enFile) {
    try {
      const vttText = await megaplay.fetchText(enFile, FETCH_TIMEOUT_MS);
      const cues = subtitles.parseVtt(vttText);
      if (cues.length > 0) {
        sourceHash = subtitles.sourceHash(vttText);
        subtitles.ensureHeader(id, epNum, sourceHash, cues);
        cacheStatus = subtitles.getStatus(id, epNum, sourceHash);
      }
    } catch (e) {
      logger.warn(`stream-hd/${id}/${epNum}: VTT Inggris tidak bisa diambil, Sub Indo tidak tersedia`);
    }
  }
  const intro = resolved.intro && typeof resolved.intro === 'object'
    ? { start: numOrZero(resolved.intro.start), end: numOrZero(resolved.intro.end) }
    : { start: 0, end: 0 };
  const outro = resolved.outro && typeof resolved.outro === 'object'
    ? { start: numOrZero(resolved.outro.start), end: numOrZero(resolved.outro.end) }
    : { start: 0, end: 0 };
  return send(res, 200, {
    ok: true,
    data: {
      anime_id: id,
      episode: epNum,
      title: typeof ep.title === 'string' ? decodeEntities(ep.title) : null,
      lang,
      hls_url: `/api/hd/m/${hlsToken}`,
      tracks,
      intro,
      outro,
      server: typeof resolved.server === 'number' ? resolved.server : 1,
      source_hash: sourceHash,
      subtitle_cache: cacheStatus,
    },
  });
}

// Tulis ulang playlist HLS: setiap URI (baris biasa maupun atribut
// URI="..." di baris #EXT-X-...) diganti token proxy origin sendiri.
// `kind` = 'master' (URI → token variant /api/hd/v/) atau 'variant'
// (URI → token segmen /api/hd/s/). Atribut URI (mis. kunci AES) selalu
// token segmen (byte pass-through).
function rewritePlaylist(text, baseUrl, kind) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (line.startsWith('#')) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) {
        let abs;
        try {
          abs = new URL(m[1], baseUrl).toString();
        } catch {
          out.push(line);
          continue;
        }
        const token = proxyTokens.issue(abs, 'segment');
        out.push(line.replace(m[1], `/api/hd/s/${token}`));
      } else {
        out.push(line);
      }
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    let abs;
    try {
      abs = new URL(trimmed, baseUrl).toString();
    } catch {
      out.push(line);
      continue;
    }
    if (kind === 'master') {
      out.push(`/api/hd/v/${proxyTokens.issue(abs, 'variant')}`);
    } else {
      out.push(`/api/hd/s/${proxyTokens.issue(abs, 'segment')}`);
    }
  }
  return out.join('\n');
}

async function fetchUpstream(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // v1.5.1 (PRD §4.4): SEMUA fetch upstream lewat proxy HD wajib
    // mengirim Referer MegaPlay persis — tanpa header ini CDN menjawab 403.
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Referer: megaplay.CDN_REFERER,
        'User-Agent': 'Mitsunime/1.5.1 (server)',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Proxy HLS/VTT lewat token opaque (PRD §5.2). Token yang tidak dikenal
// / kedaluwarsa / jenisnya salah → 404. Upstream 4xx/5xx diteruskan
// statusnya seadanya (tanpa body upstream). Playlist (master/variant)
// di-retry SEKALI bila upstream 502/503; segmen + VTT tidak di-retry.
async function handleProxy(req, res, token, expectedKind) {
  const entry = proxyTokens.lookup(token);
  if (!entry || entry.kind !== expectedKind) {
    return err(res, 404, 'Tautan tidak ditemukan atau sudah kedaluwarsa.');
  }
  const allowRetry = expectedKind === 'master' || expectedKind === 'variant';
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let upstream;
    try {
      upstream = await fetchUpstream(entry.url);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        return err(res, 502, 'Server video tidak merespons.');
      }
      return err(res, 502, 'Server video tidak dapat dijangkau.');
    }
    if ((upstream.status === 502 || upstream.status === 503) && allowRetry && attempt === 1) {
      continue; // retry sekali untuk playlist
    }
    if (!upstream.ok) {
      return err(res, upstream.status, 'Server video mengembalikan galat.');
    }
    if (expectedKind === 'master' || expectedKind === 'variant') {
      const text = await upstream.text();
      const rewritten = rewritePlaylist(text, entry.url, expectedKind);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
      res.end(rewritten);
      return true;
    }
    if (expectedKind === 'vtt') {
      const text = await upstream.text();
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(text);
      return true;
    }
    // Segmen: byte pass-through apa adanya.
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': buf.length,
    });
    res.end(buf);
    return true;
  }
}

// GET /api/vtt/check-cache?anime=&ep=&source_hash= — PRD §5.3.
function handleCheckCache(req, res, url) {
  const q = url.searchParams;
  const animeId = Number.parseInt(q.get('anime'), 10);
  const episode = Number.parseInt(q.get('ep'), 10);
  const hash = (q.get('source_hash') || '').trim();
  if (!Number.isFinite(animeId) || animeId <= 0 || !Number.isFinite(episode) || episode <= 0
    || !/^[0-9a-f]{16}$/.test(hash)) {
    return err(res, 400, 'Parameter tidak valid.');
  }
  if (!mw.enforceRateLimit(req, res, `vtt-check:${mw.clientIp(req)}`, 60, 60 * 1000)) {
    return true;
  }
  const st = subtitles.getStatus(animeId, episode, hash);
  const cues = st.translated_count > 0
    ? subtitles.getTranslatedCues(animeId, episode, hash) : [];
  return send(res, 200, {
    ok: true,
    data: { status: st.status, cue_count: st.cue_count, translated_count: st.translated_count, cues },
  });
}

// POST /api/vtt/save — PRD §5.4. Body ≤ 64 KB ditegakkan server.js
// (bukan jalur unggah). Rate limit 30/menit per IP.
function handleSave(req, res) {
  if (!mw.enforceRateLimit(req, res, `vtt-save:${mw.clientIp(req)}`, 30, 60 * 1000)) {
    return true;
  }
  const b = req.body;
  if (!b || typeof b !== 'object') return err(res, 400, 'Data yang dikirim tidak valid.');
  const animeId = Number.parseInt(b.anime_id, 10);
  const episode = Number.parseInt(b.episode, 10);
  const hash = typeof b.source_hash === 'string' ? b.source_hash.trim() : '';
  if (!Number.isFinite(animeId) || animeId <= 0 || !Number.isFinite(episode) || episode <= 0
    || !/^[0-9a-f]{16}$/.test(hash)) {
    return err(res, 400, 'Parameter tidak valid.');
  }
  if (!Array.isArray(b.cues) || b.cues.length === 0 || b.cues.length > subtitles.MAX_CUES_PER_SAVE) {
    return err(res, 400, 'Jumlah cue harus 1–50 per permintaan.');
  }
  try {
    const result = subtitles.saveCues(animeId, episode, hash, b.cues);
    return send(res, 200, { ok: true, data: result });
  } catch (e) {
    if (e && e instanceof subtitles.SubtitleError) return err(res, e.status, e.message);
    logger.error(`vtt/save gagal: ${e && e.message ? e.message : String(e)}`);
    return err(res, 500, 'Terjadi kesalahan di server. Coba lagi sebentar lagi.');
  }
}

// Router /api/* Server HD — dipanggil server.js. Mengembalikan true bila dikenali.
async function route(req, res, url) {
  const path = url.pathname;
  if (req.method === 'GET') {
    const hdMatch = path.match(/^\/api\/series\/([^/]+)\/episodes\/([^/]+)\/stream-hd$/);
    if (hdMatch) return handleStreamHd(req, res, url, hdMatch[1], hdMatch[2]);
    const mMatch = path.match(/^\/api\/hd\/m\/([^/]+)$/);
    if (mMatch) return handleProxy(req, res, mMatch[1], 'master');
    const vMatch = path.match(/^\/api\/hd\/v\/([^/]+)$/);
    if (vMatch) return handleProxy(req, res, vMatch[1], 'variant');
    const sMatch = path.match(/^\/api\/hd\/s\/([^/]+)$/);
    if (sMatch) return handleProxy(req, res, sMatch[1], 'segment');
    const subMatch = path.match(/^\/api\/hd\/sub\/([^/]+)$/);
    if (subMatch) return handleProxy(req, res, subMatch[1], 'vtt');
    if (path === '/api/vtt/check-cache') return handleCheckCache(req, res, url);
  }
  if (req.method === 'POST' && path === '/api/vtt/save') return handleSave(req, res);
  return false;
}

module.exports = { route, send, err };
