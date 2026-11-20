/* Pengaturan subtitle (item 14, v1.5.3) — modul mandiri, dimuat SEBELUM
   watch.js supaya <style id="cue-style"> sudah ada sebelum cue pertama
   dirender. State di localStorage `mitsu_subprefs_v1` lewat helper
   lsRead/lsWrite (storage.js); nilai divalidasi allowlist sebelum
   dipakai — TIDAK PERNAH disisipkan mentah ke HTML, hanya sebagai
   nilai properti CSS di dalam <style> (teks diisi lewat textContent).
   Berlaku untuk kedua track (Indonesia + Inggris) karena ::cue
   menempel pada elemen video, bukan pada satu track. */
(function () {
  'use strict';

  var LS_KEY = 'mitsu_subprefs_v1';

  /* 4 pilihan font — TETAP (§6.2). Kunci disimpan di localStorage;
     nilai font-family adalah string TETAP dari allowlist ini, bukan
     dari simpanan — nama font bebas tidak pernah dipakai. */
  var FONT_OPTIONS = {
    system: { label: 'Bawaan', family: 'sans-serif' },
    jakarta: { label: 'Plus Jakarta Sans', family: '\'Plus Jakarta Sans\', sans-serif' },
    serif: { label: 'Serif', family: 'serif' },
    mono: { label: 'Monospace', family: 'monospace' }
  };

  var DEFAULTS = {
    font: 'system',
    size: 20,
    color: '#FFFFFF',
    background: '#000000',
    opacity: 75
  };

  /* Preset warna (§6.2) — string TETAP dari PRD. */
  var COLOR_PRESETS = ['#FFFFFF', '#FFFF00', '#00E5FF', '#7CFC00'];
  var BG_PRESETS = ['#000000', '#222222', '#0B1D33'];

  var HEX_RE = /^#[0-9A-Fa-f]{6}$/;

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }
  function validFont(v) { return typeof v === 'string' && Object.prototype.hasOwnProperty.call(FONT_OPTIONS, v); }
  function validSize(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 14 && v <= 32; }
  function validHex(v) { return typeof v === 'string' && HEX_RE.test(v); }
  function validOpacity(v) { return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 100; }

  /* Validasi allowlist per-field: yang tidak lolos → default field itu. */
  function sanitize(raw) {
    var p = {};
    if (!isPlainObject(raw)) raw = {};
    p.font = validFont(raw.font) ? raw.font : DEFAULTS.font;
    p.size = validSize(raw.size) ? raw.size : DEFAULTS.size;
    p.color = validHex(raw.color) ? raw.color.toUpperCase() : DEFAULTS.color;
    p.background = validHex(raw.background) ? raw.background.toUpperCase() : DEFAULTS.background;
    p.opacity = validOpacity(raw.opacity) ? raw.opacity : DEFAULTS.opacity;
    return p;
  }

  function readStored() {
    try {
      if (typeof window.lsRead === 'function') return window.lsRead(LS_KEY, null);
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function writeStored(prefs) {
    try {
      if (typeof window.lsWrite === 'function') return window.lsWrite(LS_KEY, prefs);
      localStorage.setItem(LS_KEY, JSON.stringify(prefs));
      return true;
    } catch (e) {
      return false;
    }
  }

  function hexToRgb(hex) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16)
    };
  }

  /* Ukuran px (bukan vw) — keputusan terukur §6.3: di fullscreen HP
     landscape, 20 px → blok 2 baris 56 px (14% tinggi video, terbaca
     jelas); vw akan membuat subtitle HP 40 px (29% video, terlalu
     dominan) DAN menjepit gap bawah fullscreen ke 12,8 px (margin
     0,8 px dari batas ≥12 px §7.4 — terlalu rapuh). Lihat laporan. */
  function buildCss(p) {
    var bg = hexToRgb(p.background);
    var alpha = Math.round((p.opacity / 100) * 100) / 100;
    return 'video::cue {\n'
      + '  font-family: ' + FONT_OPTIONS[p.font].family + ';\n'
      + '  font-size: ' + p.size + 'px;\n'
      + '  line-height: 1.4;\n'
      + '  color: ' + p.color + ';\n'
      + '  background-color: rgba(' + bg.r + ', ' + bg.g + ', ' + bg.b + ', ' + alpha + ');\n'
      + '  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);\n'
      + '}';
  }

  var state = sanitize(readStored());

  function cueStyleEl() {
    var el = document.getElementById('cue-style');
    if (!el) {
      el = document.createElement('style');
      el.id = 'cue-style';
      document.head.appendChild(el);
    }
    return el;
  }

  function apply() {
    /* textContent, bukan innerHTML — tidak ada penyisipan HTML. */
    cueStyleEl().textContent = buildCss(state);
  }

  function closeMenu(reason) {
    if (typeof window.closePlayerMenu === 'function') {
      try { window.closePlayerMenu(reason); } catch (e) {}
    }
  }
  function resetHideTimer() {
    if (typeof window.resetCustomHideTimer === 'function') {
      try { window.resetCustomHideTimer(); } catch (e) {}
    }
  }

  /* ---------- Render isi #menu-sub ---------- */
  function el(id) { return document.getElementById(id); }

  function swatchRow(kind, presets, current) {
    return presets.map(function (hex) {
      var active = current.toUpperCase() === hex ? ' is-active' : '';
      return '<button type="button" class="sub-swatch' + active + '" data-' + kind + '="' + hex + '" style="background-color:' + hex + '" aria-label="' + hex + '"></button>';
    }).join('');
  }

  function renderMenu() {
    var body = el('menu-sub-body');
    if (!body) return;
    var fontOpts = Object.keys(FONT_OPTIONS).map(function (key) {
      return '<option value="' + key + '"' + (state.font === key ? ' selected' : '') + '>' + FONT_OPTIONS[key].label + '</option>';
    }).join('');
    body.innerHTML =
      '<div class="sub-field"><label class="sub-label" for="sub-font">Font</label>'
      + '<select class="sub-select" id="sub-font">' + fontOpts + '</select></div>'
      + '<div class="sub-field"><label class="sub-label" for="sub-size">Ukuran · <span id="sub-size-val">' + state.size + ' px</span></label>'
      + '<input class="sub-range" id="sub-size" type="range" min="14" max="32" step="2" value="' + state.size + '" aria-label="Ukuran subtitle"></div>'
      + '<div class="sub-field"><span class="sub-label">Warna</span><div class="sub-row">'
      + '<input class="sub-color" id="sub-color" type="color" value="' + state.color + '" aria-label="Warna teks subtitle">'
      + '<span class="sub-swatches">' + swatchRow('color', COLOR_PRESETS, state.color) + '</span></div></div>'
      + '<div class="sub-field"><span class="sub-label">Background</span><div class="sub-row">'
      + '<input class="sub-color" id="sub-bg" type="color" value="' + state.background + '" aria-label="Warna background subtitle">'
      + '<span class="sub-swatches">' + swatchRow('bg', BG_PRESETS, state.background) + '</span></div></div>'
      + '<div class="sub-field"><label class="sub-label" for="sub-opacity">Opacity · <span id="sub-opacity-val">' + state.opacity + '%</span></label>'
      + '<input class="sub-range" id="sub-opacity" type="range" min="0" max="100" step="5" value="' + state.opacity + '" aria-label="Opacity background subtitle"></div>'
      + '<button class="sub-reset" id="sub-reset" type="button">Atur Ulang</button>';
    wireMenu();
  }

  function refreshControls() {
    var font = el('sub-font');
    if (font) font.value = state.font;
    var size = el('sub-size');
    if (size) size.value = String(state.size);
    var sizeVal = el('sub-size-val');
    if (sizeVal) sizeVal.textContent = state.size + ' px';
    var color = el('sub-color');
    if (color) color.value = state.color;
    var bg = el('sub-bg');
    if (bg) bg.value = state.background;
    var op = el('sub-opacity');
    if (op) op.value = String(state.opacity);
    var opVal = el('sub-opacity-val');
    if (opVal) opVal.textContent = state.opacity + '%';
    /* Tandai preset yang sedang aktif. */
    var swatches = document.querySelectorAll('#menu-sub-body .sub-swatch');
    swatches.forEach(function (sw) {
      var hex = sw.getAttribute('data-color') || sw.getAttribute('data-bg');
      var cur = sw.getAttribute('data-color') ? state.color : state.background;
      sw.classList.toggle('is-active', cur.toUpperCase() === hex);
    });
  }

  /* set(): ubah state + simpan + terapkan + segarkan kontrol. Dipakai
     untuk pilihan yang sudah final (select, preset, lepas slider). */
  function set(patch) {
    var next = sanitize(Object.assign({}, state, patch));
    state = next;
    writeStored(state);
    apply();
    refreshControls();
    return state;
  }
  /* preview(): terapkan langsung tanpa simpan — dipakai saat drag
     slider / memilih warna (live preview, §6.5.1); disimpan saat
     change (lepas). */
  function preview(patch) {
    state = sanitize(Object.assign({}, state, patch));
    apply();
    refreshControls();
  }

  function wireMenu() {
    var font = el('sub-font');
    if (font) font.addEventListener('change', function () {
      set({ font: font.value });
      closeMenu('sub-select');
    });
    var size = el('sub-size');
    if (size) {
      size.addEventListener('input', function () {
        preview({ size: parseInt(size.value, 10) });
        resetHideTimer();
      });
      size.addEventListener('change', function () {
        set({ size: parseInt(size.value, 10) });
        closeMenu('sub-slider');
      });
    }
    var color = el('sub-color');
    if (color) {
      color.addEventListener('input', function () {
        preview({ color: color.value });
        resetHideTimer();
      });
      color.addEventListener('change', function () {
        set({ color: color.value });
        closeMenu('sub-color');
      });
    }
    var bg = el('sub-bg');
    if (bg) {
      bg.addEventListener('input', function () {
        preview({ background: bg.value });
        resetHideTimer();
      });
      bg.addEventListener('change', function () {
        set({ background: bg.value });
        closeMenu('sub-color');
      });
    }
    var swatches = document.querySelectorAll('#menu-sub-body .sub-swatch');
    swatches.forEach(function (sw) {
      sw.addEventListener('click', function () {
        if (sw.getAttribute('data-color')) set({ color: sw.getAttribute('data-color') });
        else set({ background: sw.getAttribute('data-bg') });
        closeMenu('sub-preset');
      });
    });
    var op = el('sub-opacity');
    if (op) {
      op.addEventListener('input', function () {
        preview({ opacity: parseInt(op.value, 10) });
        resetHideTimer();
      });
      op.addEventListener('change', function () {
        set({ opacity: parseInt(op.value, 10) });
        closeMenu('sub-slider');
      });
    }
    var resetBtn = el('sub-reset');
    if (resetBtn) resetBtn.addEventListener('click', function () { reset(); });
  }

  function reset() {
    state = sanitize(null);
    writeStored(state);
    apply();
    refreshControls();
    closeMenu('sub-reset');
    return state;
  }

  /* Terapkan sedini mungkin — sebelum cue pertama dirender. */
  apply();
  renderMenu();

  window.SubPrefs = {
    get: function () { return Object.assign({}, state); },
    set: set,
    reset: reset,
    apply: apply,
    renderMenu: renderMenu,
    DEFAULTS: Object.assign({}, DEFAULTS),
    FONTS: Object.keys(FONT_OPTIONS)
  };
})();
