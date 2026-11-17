'use strict';
// Rute aksesori profil (task-07): katalog, milik sendiri, pakai/lepas.
// Premium v1 = aksesori profil saja: border, background, bingkai avatar,
// lencana, efek nama. Aksesori premium_only hanya bisa dipakai saat
// premium aktif (ditegakkan di services/accessories.js).
const mw = require('../middleware/auth');
const accessories = require('../services/accessories');

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
function err(res, status, message) { return send(res, status, { ok: false, message }); }
function bodyOf(req) {
  return (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
}

// GET /api/accessories — katalog (aktif) + milik sendiri + yang dipakai.
function handleList(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  const catalog = accessories.listCatalog();
  const owned = accessories.listOwned(req.user.id);
  const ownedIds = new Set(owned.map((a) => a.id));
  return send(res, 200, {
    ok: true,
    data: catalog.map((a) => ({ ...a, owned: ownedIds.has(a.id) })),
    owned,
    equipped: accessories.getEquipped(req.user.id),
    total: catalog.length,
  });
}

// POST /api/accessories/equip { accessory_id }
function handleEquip(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  // M3: 30 aksi aksesori per pengguna per menit.
  if (!mw.enforceRateLimit(req, res, `acc:${req.user.id}`, 30, 60 * 1000,
    'Terlalu banyak permintaan. Coba lagi sebentar lagi.')) return true;
  const b = bodyOf(req);
  const id = Number.parseInt(b.accessory_id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return err(res, 400, 'Pilih aksesori terlebih dahulu.');
  }
  try {
    const out = accessories.equip(req.user.id, id);
    return send(res, 200, {
      ok: true, equipped: accessories.getEquipped(req.user.id),
      message: `"${out.accessory.name}" sekarang dipakai.`,
    });
  } catch (e) {
    return err(res, 400, e.message);
  }
}

// POST /api/accessories/unequip { kind }
function handleUnequip(req, res) {
  if (!mw.requireLogin(req, res)) return true;
  if (!mw.enforceRateLimit(req, res, `acc:${req.user.id}`, 30, 60 * 1000,
    'Terlalu banyak permintaan. Coba lagi sebentar lagi.')) return true;
  const b = bodyOf(req);
  const kind = typeof b.kind === 'string' ? b.kind.trim() : '';
  try {
    accessories.unequip(req.user.id, kind);
    return send(res, 200, {
      ok: true, equipped: accessories.getEquipped(req.user.id),
      message: 'Aksesori dilepas.',
    });
  } catch (e) {
    return err(res, 400, e.message);
  }
}

function route(req, res, url) {
  const path = url.pathname;
  if (path === '/api/accessories' && req.method === 'GET') return handleList(req, res);
  if (path === '/api/accessories/equip' && req.method === 'POST') return handleEquip(req, res);
  if (path === '/api/accessories/unequip' && req.method === 'POST') return handleUnequip(req, res);
  return false;
}

module.exports = { route, send, err };
