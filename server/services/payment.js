'use strict';
// Adapter gateway pembayaran Mitsunime (task-07): Midtrans sandbox.
// Antarmuka adapter sengaja kecil agar bisa diganti (mis. Xendit) tanpa
// mengubah route premium: cukup tambah file adapter dengan antarmuka yang
// sama dan ganti PAYMENT_GATEWAY di .env.
//
// Alur (keputusan pengguna 2026-11-15): pengguna pilih paket → server
// membuat transaksi (status 'pending', payment_status 'unpaid') dan
// meminta Snap token ke Midtrans → pengguna bayar di halaman Midtrans →
// server mengecek status lewat API (tombol konfirmasi di akun, karena
// hosting lokal Termux tidak punya URL publik untuk webhook) → bila
// 'paid', admin melihatnya di dashboard dan menyetujui → premium aktif.
// Webhook tetap disediakan untuk nanti (bila sudah hosting publik),
// tetapi BELUM terverifikasi tanpa URL publik + kunci asli.
//
// Kunci HANYA dari .env (MIDTRANS_SERVER_KEY / MIDTRANS_CLIENT_KEY).
// Tanpa server key, adapter menolak dengan kesalahan yang jelas — tidak
// pernah membuat transaksi palsu.
const crypto = require('node:crypto');
const config = require('../config');
const logger = require('../utils/logger');

class PaymentError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;       // 'not_configured' | 'gateway_error' | 'network_error'
    this.status = status;   // status HTTP yang sebaiknya dikembalikan ke klien
  }
}

function midtransBases() {
  if (config.MIDTRANS_SANDBOX) {
    return {
      snap: 'https://app.sandbox.midtrans.com',
      api: 'https://api.sandbox.midtrans.com',
    };
  }
  return { snap: 'https://app.midtrans.com', api: 'https://api.midtrans.com' };
}

function midtransAuth() {
  return 'Basic ' + Buffer.from(`${config.MIDTRANS_SERVER_KEY}:`).toString('base64');
}

async function midtransFetch(url, { method = 'GET', body = null } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': midtransAuth(),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new PaymentError('network_error', 502,
      `Tidak dapat menghubungi Midtrans (${e.name === 'TimeoutError' ? 'waktu habis' : 'jaringan'}). Coba lagi sebentar lagi.`);
  }
  let data = null;
  try { data = await res.json(); } catch { /* respons bukan JSON */ }
  if (!res.ok) {
    const detail = data && (data.error_messages || data.message)
      ? (Array.isArray(data.error_messages) ? data.error_messages.join('; ') : data.message)
      : '';
    throw new PaymentError('gateway_error', res.status === 401 ? 502 : res.status,
      `Midtrans menolak permintaan (HTTP ${res.status})${detail ? `: ${detail}` : ''}. Periksa kunci di .env.`);
  }
  return data;
}

// Pemetaan status transaksi Midtrans → payment_status Mitsunime.
// 'capture' dengan fraud_status 'challenge' (kartu masih ditinjau
// Midtrans) TIDAK boleh dianggap lunas — perbaiki M1.
function mapMidtransStatus(status, fraudStatus) {
  switch (status) {
    case 'settlement': return 'paid';
    case 'capture': return fraudStatus === 'challenge' ? 'unpaid' : 'paid';
    case 'pending':   return 'unpaid';
    case 'expire':    return 'expired';
    case 'deny':
    case 'cancel':
    case 'failure':   return 'failed';
    default:          return 'unpaid';
  }
}

const midtransAdapter = {
  name: 'midtrans',

  isConfigured() {
    return !!config.MIDTRANS_SERVER_KEY;
  },

  requireConfigured() {
    if (!this.isConfigured()) {
      throw new PaymentError('not_configured', 503,
        'Pembayaran Midtrans belum dikonfigurasi. Isi MIDTRANS_SERVER_KEY dan MIDTRANS_CLIENT_KEY di .env (lihat .env.example), lalu jalankan ulang server.');
    }
  },

  // Buat transaksi Snap. Mengembalikan { token, redirect_url, raw }.
  async createTransaction({ orderId, amount, customerName, itemName }) {
    this.requireConfigured();
    const { snap } = midtransBases();
    const data = await midtransFetch(`${snap}/snap/v1/transactions`, {
      method: 'POST',
      body: {
        transaction_details: { order_id: orderId, gross_amount: Math.trunc(amount) },
        item_details: [{ id: 'plan', price: Math.trunc(amount), quantity: 1, name: itemName }],
        customer_details: { first_name: customerName || 'Pengguna Mitsunime' },
      },
    });
    if (!data || !data.token || !data.redirect_url) {
      throw new PaymentError('gateway_error', 502,
        'Midtrans mengembalikan respons yang tidak lengkap (tanpa token Snap).');
    }
    logger.info(`Midtrans Snap dibuat: order ${orderId}`);
    return { token: data.token, redirect_url: data.redirect_url, raw: data };
  },

  // Cek status transaksi di Midtrans. Mengembalikan
  // { payment_status, gateway_status, raw }.
  async getTransactionStatus(orderId) {
    this.requireConfigured();
    const { api } = midtransBases();
    const data = await midtransFetch(
      `${api}/v2/${encodeURIComponent(orderId)}/status`,
    );
    const paymentStatus = mapMidtransStatus(data.transaction_status, data.fraud_status);
    return { payment_status: paymentStatus, gateway_status: data.transaction_status || null, raw: data };
  },

  // Verifikasi signature_key notifikasi Midtrans:
  // SHA512(order_id + status_code + gross_amount + server_key).
  verifyWebhookSignature({ orderId, statusCode, grossAmount, signatureKey }) {
    if (!config.MIDTRANS_SERVER_KEY) return false;
    if (!orderId || !statusCode || !grossAmount || !signatureKey) return false;
    const expected = crypto
      .createHash('sha512')
      .update(`${orderId}${statusCode}${grossAmount}${config.MIDTRANS_SERVER_KEY}`)
      .digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signatureKey)));
    } catch {
      return false;
    }
  },
};

// Pabrik adapter: tambah adapter baru di sini dengan antarmuka yang sama.
function getAdapter() {
  const name = config.PAYMENT_GATEWAY || 'midtrans';
  if (name === 'midtrans') return midtransAdapter;
  throw new PaymentError('not_configured', 503,
    `Gateway pembayaran "${name}" belum didukung. Isi PAYMENT_GATEWAY=midtrans di .env.`);
}

module.exports = { getAdapter, PaymentError, mapMidtransStatus, midtransAdapter };
