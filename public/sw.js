/* ============================================================
   sw.js — Service worker Mitsunime (v1.5.5)
   Cache-first HANYA untuk app shell (daftar SHELL di bawah, dengan
   ?v= PERSIS seperti yang dirujuk HTML yang disajikan). SEGALA YANG
   LAIN — semua /api/* (termasuk /api/hd/*: segmen video + VTT +
   token), semua POST/PUT/DELETE, semua request Range, semua
   cross-origin, semua URL yang tidak ada di SHELL — passthrough
   network murni, TANPA caching. Video dan API TIDAK PERNAH masuk
   Cache Storage. SW tidak mengubah request apa pun.
   ============================================================ */

var CACHE_NAME = 'mitsu-v1.5.5';

/* Daftar SHELL — dicatat persis di laporan Frontend v1.5.4.
   HTML: '/' + 10 halaman publik (tanpa query — navigasi tidak
   membawa ?v=). '/admin.html' TIDAK ada di sini (penyimpangan dari
   PRD §6.5, terdokumentasi): server mengembalikan 404 untuk
   /admin.html langsung (server.js — halaman admin HANYA dilayani
   lewat rute admin tersembunyi, routes/admin.js), dan satu entri
   404 membuat cache.addAll() gagal total -> install SW gagal ->
   PWA mati. Halaman admin tetap punya <link rel="manifest"> di
   berkasnya (bila dibuka lewat rute tersembunyi) dan tidak butuh
   offline shell.
   CSS/JS: dengan ?v= persis seperti dirujuk HTML sesudah T2
   (api.js punya TIGA ?v= berbeda di halaman berbeda — ketiganya ada). */
var SHELL = [
  '/',
 '/index.html', '/account.html', '/az.html',
  '/detail.html', '/favorites.html', '/genre.html', '/premium.html',
  '/search.html', '/settings.html', '/watch.html',
  '/css/style.css?v=1.5.5', '/css/admin.css?v=1.3.2',
  '/js/api.js?v=1.3.2', '/js/api.js?v=1.4.0', '/js/api.js?v=1.5.0',
  '/js/common.js?v=1.5.4', '/js/storage.js?v=1.5.2',
  '/js/account.js?v=1.4.0', '/js/admin.js?v=1.3.2',
  '/js/browse.js?v=1.3.2', '/js/detail.js?v=1.5.2',
  '/js/home.js?v=1.5.2', '/js/premium.js?v=1.3.2',
  '/js/search.js?v=1.5.2', '/js/settings.js?v=1.4.0',
  '/js/subprefs.js?v=1.5.3', '/js/subs.js?v=1.5.4',
  '/js/watch.js?v=1.5.5', '/js/vendor/hls.min.js?v=1.5.0',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/icons/icon-512-maskable.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      /* addAll() gagal total bila SATU entri 404 (pernah terjadi:
         /admin.html) -> satu entri rusak mematikan seluruh PWA.
         Tambah per entri, gagal per entri ditolerir; entri yang
         gagal tidak masuk cache dan disajikan dari network. */
      .then(function (cache) {
        return Promise.all(SHELL.map(function (u) {
          return cache.add(u).catch(function () { /* lewati entri gagal */ });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME) return caches.delete(key);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  /* Guard Chrome: only-if-cached + bukan same-origin → jangan tangani. */
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;
  var url;
  try { url = new URL(event.request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (SHELL.indexOf(url.pathname + url.search) === -1) return;
  event.respondWith(
    caches.match(event.request).then(function (hit) {
      if (hit) return hit;
      return fetch(event.request).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        }
        return res;
      });
    })
  );
});
