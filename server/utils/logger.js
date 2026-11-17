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

module.exports = {
  info: (msg, extra) => log('INFO', msg, extra),
  warn: (msg, extra) => log('WARN', msg, extra),
  error: (msg, extra) => log('ERROR', msg, extra),
  // Log tiap request HTTP: metode, path (TANPA query string), status,
  // durasi. Path saja: query bisa membawa kode reset (H-01).
  request: (req, status, ms) =>
    log('REQ', `${req.method} ${(req.url || '').split('?')[0]} -> ${status} (${ms}ms)`),
};
