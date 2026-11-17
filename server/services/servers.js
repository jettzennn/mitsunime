'use strict';
// Satu sumber kebenaran URL pemilih server (v1.5.0, PRD §9.2).
// Dipakai handleStream (public.js) DAN stream-hd — Frontend TIDAK
// PERNAH membangun URL dari ID (mal_id/ani_id tidak pernah keluar ke
// payload publik). `episode` adalah objek episode Anikoto (dengan
// `number` + `embed_url`); `lang` = 'sub' | 'dub'.
// Aturan (PRD §9.2):
// - ani_id → rute AniList; mal_id (bila ani_id kosong) → rute MAL
//   (hanya VidCloud + TryEmbed yang punya rute MAL terverifikasi;
//   AniEmbed + Nontongo DIHILANGKAN bila ani_id kosong).
// - MegaPlay: SATU entri dari embed_url[lang] (URL s-2); bila tidak
//   ada → entri dihilangkan. Rantai fallback mal/ani internal MegaPlay
//   tetap ada di `fallback_urls` (tidak dihapus).
// - Bila ani_id DAN mal_id kosong → hanya Server HD (+ MegaPlay bila
//   embed_url ada).
function buildServers(animeRaw, episode, lang) {
  const lg = lang === 'dub' ? 'dub' : 'sub';
  const epNum = episode ? Number.parseInt(episode.number, 10) : NaN;
  const a = (animeRaw && typeof animeRaw === 'object') ? animeRaw : {};
  const aniId = a.ani_id != null && String(a.ani_id) !== '' ? String(a.ani_id) : null;
  const malId = a.mal_id != null && String(a.mal_id) !== '' ? String(a.mal_id) : null;
  const out = [{ key: 'hd', name: 'Server HD (Sub Indo)', kind: 'hd' }];
  if (!Number.isFinite(epNum) || epNum <= 0) return out;
  const embed = episode && episode.embed_url && typeof episode.embed_url === 'object'
    ? episode.embed_url : {};
  if (embed[lg]) {
    out.push({ key: 'megaplay', name: 'MegaPlay', kind: 'iframe', url: embed[lg] });
  }
  if (aniId) {
    out.push({
      key: 'vidcloud', name: 'VidCloud', kind: 'iframe',
      url: `https://vidcloud.sbs/embed/ani/${encodeURIComponent(aniId)}/${epNum}?track=${lg}`,
    });
  } else if (malId) {
    out.push({
      key: 'vidcloud', name: 'VidCloud', kind: 'iframe',
      url: `https://vidcloud.sbs/embed/mal/${encodeURIComponent(malId)}/${epNum}?track=${lg}`,
    });
  }
  if (aniId) {
    out.push({
      key: 'aniembed', name: 'AniEmbed', kind: 'iframe',
      url: `https://aniembed.se/e/${encodeURIComponent(aniId)}/${epNum}?lang=${lg}`,
    });
  }
  if (aniId) {
    out.push({
      key: 'tryembed', name: 'TryEmbed', kind: 'iframe',
      url: `https://tryembed.us.cc/embed/anime/${encodeURIComponent(aniId)}/${epNum}/${lg}`,
    });
  } else if (malId) {
    out.push({
      key: 'tryembed', name: 'TryEmbed', kind: 'iframe',
      url: `https://tryembed.us.cc/embed/anime/mal/${encodeURIComponent(malId)}/${epNum}/${lg}`,
    });
  }
  if (aniId) {
    out.push({
      key: 'nontongo', name: 'Nontongo (belum teruji)', kind: 'iframe',
      url: `https://nontongo.win/anime/${encodeURIComponent(aniId)}/${epNum}/play`,
    });
  }
  return out;
}

module.exports = { buildServers };
