'use strict';
// Logger ringan untuk Termux: satu baris per kejadian, tanpa warna,
// tanpa password/token/kunci (tidak ada secret yang dicatat).
// v1.4.1 (H-01): query string TIDAK PERNAH masuk log — tautan reset
// membawa kode 6 digit di URL, dan log Termux sering dibagikan.
function stamp() {
  return new Date().toISOString();
}

function log(level, msg, extra) {
  const line = `[${stamp()}] [${level}] ${msg}` + (extra ? ` ${extra}` : '');
  if (level === 'ERROR') console.error(line);
  else console.log(line);
}

// L-15 (v1.5.1, PRD §4.5): samarkan token proxy HD di path log.
// Token mentah dari log v1.5.0 terbukti bisa dipakai ulang (pentest:
// token dari log → master 200). Pola /api/hd/(m|v|s|sub)/<32 heks>
// diganti /api/hd/<jenis>/[token] sebelum dicatat — baris REQ tetap
// berguna untuk debug, tapi log tidak lagi menjadi jalan memperoleh token.
function maskHdToken(pathname) {
  return pathname.replace(/\/api\/hd\/(m|v|s|sub)\/[0-9a-f]{32}/g, '/api/hd/$1/[token]');
}

module.exports = {
  info: (msg, extra) => log('INFO', msg, extra),
  warn: (msg, extra) => log('WARN', msg, extra),
  error: (msg, extra) => log('ERROR', msg, extra),
  // Log tiap request HTTP: metode, path (TANPA query string), status,
  // durasi. Path saja: query bisa membawa kode reset (H-01).
  request: (req, status, ms) =>
    log('REQ', `${req.method} ${maskHdToken((req.url || '').split('?')[0])} -> ${status} (${ms}ms)`),
};
