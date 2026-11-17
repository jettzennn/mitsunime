'use strict';
// Pengirim email SMTP mentah (v1.3.0) — NOL DEPENDENSI: hanya
// node:net + node:tls bawaan. Dipakai untuk OTP verifikasi email.
// Tidak ada nodemailer di sini (modul npm itu tidak bisa dikirim di
// dalam zip Termux tanpa npm install di HP).
//
// Alur: connect → 220 → EHLO → STARTTLS (port 587, bila diiklankan)
// atau TLS langsung (port 465) → EHLO lagi → AUTH LOGIN → MAIL FROM →
// RCPT TO → DATA → QUIT.
//
// KEAMANAN:
// - Kredensial HANYA dikirim setelah TLS aktif, KECUALI ke host loopback
//   (127.0.0.1/localhost — hanya untuk server SMTP palsu saat pengujian
//   di sandbox; Gmail dan SMTP publik lain selalu mewajibkan TLS).
// - Verifikasi sertifikat TLS AKTIF secara default (rejectUnauthorized).
//   Opsi tlsOptions hanya dipakai pengujian langsung modul ini (bukan
//   lewat .env) untuk sertifikat self-signed server palsu.
// - Password TIDAK PERNAH ditulis di log atau di pesan galat.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const config = require('../config');
const logger = require('../utils/logger');

const COMMAND_TIMEOUT_MS = 20000; // v1.3.3: 10s -> 20s (Gmail/Termux lambat)
const SOCKET_TIMEOUT_MS = 45000; // v1.3.3: 30s -> 45s
const RETRY_DELAY_MS = 800;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// v1.3.3: kegagalan transien = timeout / reset / putus — layak dicoba
// ulang sekali. Kegagalan permanen (AUTH 535, RCPT 550, dst) TIDAK
// di-retry karena hasilnya akan sama.
function isTransientError(err) {
  const m = String(err && err.message ? err.message : err || '');
  return /timeout|habis|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|Tidak ada respons|socket hang up|connection reset/i.test(m);
}
function isConnectStageError(err) {
  const stage = err && err.smtpStage ? err.smtpStage : '';
  return stage === 'connect' || stage === 'STARTTLS' || stage === 'EHLO';
}

function isConfigured() {
  return Boolean(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS);
}

function isLoopback(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// Pembaca baris SMTP (respons bisa multi-baris: "250-..." lalu "250 ...").
function createLineReader(socket) {
  let buf = '';
  let closed = false;
  const lines = [];
  const waiters = [];
  function onData(chunk) {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      const entry = waiters.shift();
      if (entry) entry.fn(line);
      else lines.push(line);
    }
  }
  function onEnd() {
    closed = true;
    while (waiters.length) waiters.shift().fn(null);
  }
  socket.on('data', onData);
  socket.on('error', onEnd);
  socket.on('close', onEnd);
  return {
    nextLine(timeoutMs) {
      if (lines.length) return Promise.resolve(lines.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        const entry = { done: false, fn: null };
        const timer = setTimeout(() => {
          entry.done = true;
          const i = waiters.indexOf(entry);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        entry.fn = (line) => {
          if (entry.done) return;
          entry.done = true;
          clearTimeout(timer);
          resolve(line);
        };
        waiters.push(entry);
      });
    },
    detach() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onEnd);
      socket.removeListener('close', onEnd);
    },
  };
}

class SmtpClient {
  constructor({ host, port, tlsOptions }) {
    this.host = host;
    this.port = port;
    this.tlsOptions = tlsOptions || {};
    this.socket = null;
    this.reader = null;
    this.secure = false;
    this.stage = 'connect'; // v1.3.3: tahap terakhir untuk pesan galat + fallback port
  }

  async connect() {
    this.stage = 'connect';
    const implicitTls = this.port === 465;
    this.socket = implicitTls
      ? tls.connect({
        host: this.host,
        port: this.port,
        servername: this.host,
        rejectUnauthorized: this.tlsOptions.rejectUnauthorized !== false,
      })
      : net.connect({ host: this.host, port: this.port });
    this.socket.setTimeout(SOCKET_TIMEOUT_MS);
    this.socket.on('timeout', () => this.socket.destroy(new Error('Waktu koneksi SMTP habis.')));
    // Catat penyebab kegagalan koneksi (pesan galat socket tidak berisi
    // kredensial); pembaca baris menerjemahkannya menjadi "tidak ada
    // respons" bila koneksi putus sebelum balasan 220 tiba.
    this.socket.on('error', (e) => logger.error(`Koneksi SMTP gagal: ${e && e.message ? e.message : e}`));
    this.reader = createLineReader(this.socket);
    this.secure = implicitTls;
    await this._readResponse('connect', [220]);
  }

  async _readResponse(what, expectCodes) {
    const lines = [];
    for (;;) {
      const line = await this.reader.nextLine(COMMAND_TIMEOUT_MS);
      if (line === null) {
        const e = new Error(`Tidak ada respons dari server SMTP saat ${what} (tahap: ${what}).`);
        e.smtpStage = what;
        throw e;
      }
      lines.push(line);
      // Baris terakhir respons: "NNN " (kode + spasi). "NNN-" = lanjutan.
      if (/^\d{3} /.test(line)) break;
      if (!/^\d{3}-/.test(line)) break;
    }
    const code = Number.parseInt(lines[0].slice(0, 3), 10);
    const text = lines.join(' ');
    if (!expectCodes.includes(code)) {
      // v1.3.3: galat selalu menyebut tahap + kode SMTP, TANPA kredensial.
      const e = new Error(`Server SMTP menolak ${what} (tahap: ${what}, kode: ${code} ${text}).`);
      e.smtpStage = what;
      e.smtpCode = code;
      throw e;
    }
    return { code, text, lines };
  }

  async _command(cmd, expectCodes, what) {
    const stage = what || cmd;
    this.stage = stage;
    await new Promise((resolve, reject) => {
      this.socket.write(`${cmd}\r\n`, (e) => (e ? reject(e) : resolve()));
    });
    return this._readResponse(stage, expectCodes);
  }

  // Naikkan koneksi biasa menjadi TLS (STARTTLS). Dipanggil bila server
  // mengiklankannya di EHLO dan koneksi belum aman.
  async _startTls() {
    this.stage = 'STARTTLS';
    await this._command('STARTTLS', [220], 'STARTTLS');
    this.reader.detach();
    const tlsSocket = tls.connect({
      socket: this.socket,
      servername: this.host,
      rejectUnauthorized: this.tlsOptions.rejectUnauthorized !== false,
    });
    tlsSocket.setTimeout(SOCKET_TIMEOUT_MS);
    tlsSocket.on('timeout', () => tlsSocket.destroy(new Error('Waktu koneksi SMTP habis.')));
    tlsSocket.on('error', (e) => logger.error(`Koneksi SMTP (STARTTLS) gagal: ${e && e.message ? e.message : e}`));
    this.socket = tlsSocket;
    this.reader = createLineReader(tlsSocket);
    this.secure = true;
  }

  async ehlo() {
    // v1.3.3: EHLO memakai "localhost" — sebagian server (Gmail) lebih
    // konsisten menerima nama generik ini dari klien Termux/mobile.
    const res = await this._command('EHLO localhost', [250], 'EHLO');
    return res;
  }

  static capabilities(ehloRes) {
    const caps = new Set();
    for (const line of ehloRes.lines) {
      const m = line.match(/^\d{3}[ -](.+)$/);
      if (m) caps.add(m[1].trim().toUpperCase());
    }
    return caps;
  }

  // v1.3.1: sendMail menerima { text, html? }. Bila html diisi,
  // pesan dikirim sebagai multipart/alternative: bagian text/plain
  // dulu (untuk klien yang tidak menampilkan HTML), lalu text/html.
  // Bila html tidak diisi, pesan tetap text/plain seperti sebelumnya.
  // v1.4.1: `attachments` opsional — array berisi MAKSIMAL SATU
  // lampiran gambar CID { filename, contentType, contentId, content
  // (Buffer) }. Bila diisi (dan html ada), pesan dibungkus
  // multipart/related yang di dalamnya ada multipart/alternative
  // lama (text/plain + text/html) lalu bagian gambar base64 dengan
  // Content-ID — dipakai logo surat. Tanpa attachments, perilaku
  // lama tidak berubah sama sekali.
  async sendMail({ from, to, subject, text, html, attachments }) {
    if (!EMAIL_RE.test(to)) throw new Error('Alamat email tujuan tidak valid.');
    if (/[\r\n]/.test(subject) || /[\r\n]/.test(from)) {
      throw new Error('Subjek atau pengirim mengandung karakter baris yang tidak diizinkan.');
    }
    // v1.4.1: validasi lampiran CID — maksimal satu, hanya bila ada
    // html, dan semua field wajib valid (tanpa karakter baris).
    const atts = attachments || [];
    if (!Array.isArray(atts) || atts.length > 1) {
      throw new Error('Lampiran email: maksimal satu lampiran gambar CID.');
    }
    if (atts.length > 0 && !html) {
      throw new Error('Lampiran CID hanya didukung bila badan HTML diisi.');
    }
    let attachment = null;
    if (atts.length > 0) {
      const a = atts[0];
      if (!a || typeof a.filename !== 'string' || typeof a.contentType !== 'string'
        || typeof a.contentId !== 'string' || !Buffer.isBuffer(a.content)) {
        throw new Error('Lampiran email tidak valid (filename/contentType/contentId/content).');
      }
      if (/[\r\n"]/.test(a.filename) || /[\r\n"]/.test(a.contentType) || /[\r\n\s]/.test(a.contentId)) {
        throw new Error('Lampiran email mengandung karakter yang tidak diizinkan.');
      }
      attachment = a;
    }
    try {
      await this.connect();
      let caps = SmtpClient.capabilities(await this.ehlo());
      if (!this.secure) {
        const hasStartTls = [...caps].some((c) => c === 'STARTTLS');
        if (hasStartTls) {
          await this._startTls();
          caps = SmtpClient.capabilities(await this.ehlo());
        } else if (!isLoopback(this.host)) {
          // Tanpa TLS, kredensial tidak boleh dikirim ke server publik.
          throw new Error('Server SMTP tidak mendukung TLS (STARTTLS). Kredensial tidak dikirim.');
        }
        // Loopback tanpa STARTTLS: diizinkan HANYA untuk server SMTP
        // palsu saat pengujian lokal (lihat komentar di atas).
      }
      const authCaps = [...caps].some((c) => c.startsWith('AUTH'));
      if (!authCaps) throw new Error('Server SMTP tidak mengiklankan AUTH.');
      await this._command('AUTH LOGIN', [334], 'AUTH LOGIN');
      await this._command(Buffer.from(config.SMTP_USER, 'utf8').toString('base64'), [334], 'AUTH LOGIN (username)');
      await this._command(Buffer.from(config.SMTP_PASS, 'utf8').toString('base64'), [235], 'AUTH LOGIN (password)');
      await this._command(`MAIL FROM:<${from}>`, [250], 'MAIL FROM');
      await this._command(`RCPT TO:<${to}>`, [250], 'RCPT TO');
      await this._command('DATA', [354], 'DATA');
      // Dot-stuffing: baris isi yang diawali '.' harus diawali satu '.' lagi.
      const stuff = (s) => s.split(/\r?\n/).map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
      let headers;
      let body;
      if (html) {
        // multipart/alternative (RFC 2046): boundary acak; bagian
        // plain dulu, lalu HTML. Kedua bagian membawa isi yang sama
        // (teks vs HTML) supaya klien mana pun menampilkan pesannya.
        const boundary = 'mitsunime-' + crypto.randomBytes(16).toString('hex');
        const alternative =
          `--${boundary}\r\n` +
          'Content-Type: text/plain; charset=utf-8\r\n' +
          'Content-Transfer-Encoding: 8bit\r\n' +
          '\r\n' +
          stuff(text) +
          '\r\n' +
          `--${boundary}\r\n` +
          'Content-Type: text/html; charset=utf-8\r\n' +
          'Content-Transfer-Encoding: 8bit\r\n' +
          '\r\n' +
          stuff(html) +
          '\r\n' +
          `--${boundary}--`;
        if (attachment) {
          // v1.4.1: multipart/related (RFC 2387) membungkus
          // alternative di atas + satu bagian gambar base64 (CID).
          // Base64 tidak mengandung '.', jadi tidak butuh
          // dot-stuffing; baris dibungkus 76 karakter (RFC 2045).
          const relBoundary = 'mitsunime-' + crypto.randomBytes(16).toString('hex');
          const b64 = attachment.content.toString('base64').replace(/(.{76})/g, '$1\r\n');
          headers =
            'MIME-Version: 1.0\r\n' +
            `Content-Type: multipart/related; boundary="${relBoundary}"\r\n`;
          body =
            `--${relBoundary}\r\n` +
            `Content-Type: multipart/alternative; boundary="${boundary}"\r\n` +
            '\r\n' +
            alternative +
            '\r\n' +
            `--${relBoundary}\r\n` +
            `Content-Type: ${attachment.contentType}; name="${attachment.filename}"\r\n` +
            'Content-Transfer-Encoding: base64\r\n' +
            `Content-ID: <${attachment.contentId}>\r\n` +
            `Content-Disposition: inline; filename="${attachment.filename}"\r\n` +
            '\r\n' +
            b64 +
            '\r\n' +
            `--${relBoundary}--`;
        } else {
          headers =
            'MIME-Version: 1.0\r\n' +
            `Content-Type: multipart/alternative; boundary="${boundary}"\r\n`;
          body = alternative;
        }
      } else {
        headers =
          'MIME-Version: 1.0\r\n' +
          'Content-Type: text/plain; charset=utf-8\r\n' +
          'Content-Transfer-Encoding: 8bit\r\n';
        body = stuff(text);
      }
      const message =
        `From: ${from}\r\n` +
        `To: ${to}\r\n` +
        `Subject: ${subject}\r\n` +
        headers +
        '\r\n' +
        body +
        '\r\n.\r\n';
      await new Promise((resolve, reject) => {
        this.socket.write(message, (e) => (e ? reject(e) : resolve()));
      });
      await this._readResponse('DATA (isi email)', [250]);
      try { await this._command('QUIT', [221], 'QUIT'); } catch { /* abaikan galat saat menutup */ }
    } catch (e) {
      // v1.3.3: pastikan galat selalu membawa tahap (untuk log + logika
      // fallback port di sendMail tingkat atas). Tanpa kredensial.
      if (e && !e.smtpStage) e.smtpStage = this.stage;
      throw e;
    } finally {
      try { if (this.socket) this.socket.destroy(); } catch { /* abaikan */ }
    }
  }
}

// Kirim satu email. Konfigurasi dari .env (config.SMTP_*).
// tlsOptions hanya untuk pengujian langsung modul ini (sertifikat
// self-signed server palsu); jalur produksi TIDAK pernah memakainya.
// `html` opsional — bila diisi, pesan dikirim multipart/alternative
// (text/plain + text/html); bila tidak, tetap text/plain saja.
// `attachments` opsional (v1.4.1) — diteruskan apa adanya ke
// SmtpClient.sendMail (maksimal satu lampiran gambar CID).
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function sendMail({ to, subject, text, html, attachments }, opts = {}) {
  if (!isConfigured()) {
    throw new Error('Pengiriman email belum dikonfigurasi. Isi SMTP_HOST, SMTP_USER, dan SMTP_PASS di .env.');
  }
  const from = config.SMTP_FROM || config.SMTP_USER;
  const primaryPort = opts.port || config.SMTP_PORT;
  const tlsOptions = opts.tlsOptions || {};
  // v1.3.3: ketahanan jaringan Termux/operator —
  // 1) Bila gagal di tahap connect/STARTTLS/EHLO pada port 587, coba
  //    sekali ke port 465 (TLS langsung), dan sebaliknya (465 -> 587).
  //    Operator/HP kadang memblokir salah satu port.
  // 2) Kegagalan transien (timeout/reset) di tahap lain dicoba ulang
  //    sekali pada port yang sama sesudah jeda singkat — KECUALI
  //    tahap 'DATA (isi email)': isi sudah terkirim, kirim ulang
  //    pasti mendobelkan email (lihat catatan v1.3.6 di bawah).
  // Kegagalan permanen (mis. AUTH 535) langsung dilempar — retry tidak
  // akan mengubah hasil dan hanya menunda pesan galat ke pengguna.
  // opts.disableFallback hanya untuk pengujian deterministik.
  const attempts = [{ port: primaryPort }];
  try {
    const c = new SmtpClient({ host: config.SMTP_HOST, port: primaryPort, tlsOptions });
    await c.sendMail({ from, to, subject, text, html, attachments });
    logger.info(`Email terkirim ke ${to} (subjek: ${subject}).`);
    return;
  } catch (firstErr) {
    const stage = firstErr && firstErr.smtpStage ? firstErr.smtpStage : '';
    // v1.3.6 — ANTI EMAIL DOBEL (teguran user 2026-11-16: email
    // verifikasi DAN reset tiba 2 kali dengan kode/tautan yang sama
    // persis). Akar masalahnya: isi email sudah terkirim utuh ke
    // server (tahap 'DATA (isi email)') dan server hampir pasti
    // sudah menerimanya, tetapi balasan konfirmasi 250 hilang/putus
    // di jaringan — galatnya terbaca "transien" sehingga logika
    // retry lama mengirim SELURUH email sekali lagi. Aturannya:
    // bila kegagalan terjadi sesudah isi email terkirim, JANGAN
    // PERNAH kirim ulang; anggap terkirim (pengguna bisa meminta
    // email baru bila memang tidak sampai). Retry hanya aman untuk
    // kegagalan SEBELUM isi email ditulis.
    if (stage === 'DATA (isi email)') {
      logger.warn(`Balasan final SMTP tidak diterima sesudah isi email terkirim ke ${to}; dianggap terkirim agar tidak dobel.`);
      return;
    }
    const altPort = primaryPort === 587 ? 465 : (primaryPort === 465 ? 587 : null);
    let retryPort = null;
    let reason = '';
    if (!opts.disableFallback && altPort && isConnectStageError(firstErr)) {
      retryPort = altPort;
      reason = `gagal di tahap ${stage || 'connect'} pada port ${primaryPort}`;
    } else if (!opts.disableFallback && isTransientError(firstErr)) {
      retryPort = primaryPort;
      reason = 'kegagalan transien (timeout/reset)';
    }
    if (retryPort === null) throw firstErr;
    logger.warn(`Pengiriman SMTP ${reason}; mencoba ulang sekali lewat port ${retryPort}...`);
    await delay(RETRY_DELAY_MS);
    try {
      const c2 = new SmtpClient({ host: config.SMTP_HOST, port: retryPort, tlsOptions });
      await c2.sendMail({ from, to, subject, text, html, attachments });
      logger.info(`Email terkirim ke ${to} (subjek: ${subject}, port ${retryPort}).`);
    } catch (secondErr) {
      // Lempar galat kedua (lebih segar) dengan konteks kedua tahap.
      const s2 = secondErr && secondErr.smtpStage ? secondErr.smtpStage : 'tidak diketahui';
      const c2code = secondErr && secondErr.smtpCode ? `, kode: ${secondErr.smtpCode}` : '';
      const wrapped = new Error(
        `Pengiriman email gagal. Percobaan 1 (port ${primaryPort}): ${firstErr.message} Percobaan 2 (port ${retryPort}, tahap: ${s2}${c2code}): ${secondErr.message}`,
      );
      wrapped.smtpStage = s2;
      wrapped.smtpCode = secondErr && secondErr.smtpCode;
      throw wrapped;
    }
  }
}

module.exports = { isConfigured, sendMail, SmtpClient, COMMAND_TIMEOUT_MS, SOCKET_TIMEOUT_MS };
