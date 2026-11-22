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

  /* 12 pilihan font — 4 lama TETAP + 8 baru item 44 (v1.5.8):
     Noto Sans, Lato, Helvetica, Trebuchet MS, Trebuchet MS Bold,
     Roboto, Arial, Poppins. Inter + Comic DIHAPUS (v1.5.8): berkas
     woff2 + @font-face dihapus; simpanan lama 'inter'/'comic'
     disanitasi ke 'system' (lihat sanitize — tanpa migrasi khusus).
     Bobot: 'Trebuchet MS Bold' = keluarga yang sama, bobot 700
     (bukan keluarga terpisah — D10); buildCss memakai weight ini.
     Kunci disimpan di localStorage; nilai font-family adalah string
     TETAP dari allowlist ini, bukan dari simpanan — nama font bebas
     tidak pernah dipakai. */
  var FONT_OPTIONS = {
    system: { label: 'Bawaan', family: 'sans-serif', weight: 400 },
    jakarta: { label: 'Plus Jakarta Sans', family: '\'Plus Jakarta Sans\', sans-serif', weight: 400 },
    serif: { label: 'Serif', family: 'serif', weight: 400 },
    mono: { label: 'Monospace', family: 'monospace', weight: 400 },
    noto: { label: 'Noto Sans', family: '\'Noto Sans\', sans-serif', weight: 400 },
    lato: { label: 'Lato', family: '\'Lato\', sans-serif', weight: 400 },
    helvetica: { label: 'Helvetica', family: 'Helvetica, \'TeX Gyre Heros\', \'Liberation Sans\', sans-serif', weight: 400 },
    trebuchet: { label: 'Trebuchet MS', family: '\'Trebuchet MS\', sans-serif', weight: 400 },
    trebuchetBold: { label: 'Trebuchet MS Bold', family: '\'Trebuchet MS\', sans-serif', weight: 700 },
    roboto: { label: 'Roboto', family: '\'Roboto\', sans-serif', weight: 400 },
    arial: { label: 'Arial', family: 'Arial, \'Liberation Sans\', sans-serif', weight: 400 },
    poppins: { label: 'Poppins', family: '\'Poppins\', sans-serif', weight: 400 }
  };

  var DEFAULTS = {
    font: 'system',
    size: 20,
    color: '#FFFFFF',
    background: '#000000',
    opacity: 75,
    shadow: true,
    shadowColor: '#000000',
    shadowBlur: 2,
    outline: false,
    outlineColor: '#000000'
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
  function validBool(v) { return typeof v === 'boolean'; }
  function validShadowBlur(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0 && v <= 12; }

  /* Validasi allowlist per-field: yang tidak lolos → default field itu.
     Simpanan lama (tanpa field shadow/outline item 33, tanpa
     shadowBlur item 45) dibaca sebagai default — TIDAK ADA migrasi
     khusus. Simpanan lama font 'inter'/'comic' (dihapus item 44)
     → bukan kunci allowlist lagi → 'system'. */
  function sanitize(raw) {
    var p = {};
    if (!isPlainObject(raw)) raw = {};
    p.font = validFont(raw.font) ? raw.font : DEFAULTS.font;
    p.size = validSize(raw.size) ? raw.size : DEFAULTS.size;
    p.color = validHex(raw.color) ? raw.color.toUpperCase() : DEFAULTS.color;
    p.background = validHex(raw.background) ? raw.background.toUpperCase() : DEFAULTS.background;
    p.opacity = validOpacity(raw.opacity) ? raw.opacity : DEFAULTS.opacity;
    p.shadow = validBool(raw.shadow) ? raw.shadow : DEFAULTS.shadow;
    p.shadowColor = validHex(raw.shadowColor) ? raw.shadowColor.toUpperCase() : DEFAULTS.shadowColor;
    p.shadowBlur = validShadowBlur(raw.shadowBlur) ? raw.shadowBlur : DEFAULTS.shadowBlur;
    p.outline = validBool(raw.outline) ? raw.outline : DEFAULTS.outline;
    p.outlineColor = validHex(raw.outlineColor) ? raw.outlineColor.toUpperCase() : DEFAULTS.outlineColor;
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
  /* text-shadow disusun dari bagian yang AKTIF saja (item 33):
     outline nyala → 4 bayangan 1 px tanpa blur (video::cue tidak
     mendukung text-stroke/outline); shadow nyala → 0 1px <blur>px
     rgba(shadowColor, 0.8) — blur dari preferensi shadowBlur
     (item 45, default 2 = render v1.5.7); keduanya mati → none.
     Urutan: outline dulu, lalu drop shadow. Default (shadow nyala
     hitam blur 2, outline mati) menghasilkan CSS yang SAMA seperti
     v1.5.7. Bobot font dari opsi (Trebuchet MS Bold = 700). */
  function buildCss(p) {
    var bg = hexToRgb(p.background);
    var alpha = Math.round((p.opacity / 100) * 100) / 100;
    var shadows = [];
    if (p.outline) {
      shadows.push('-1px 0 0 ' + p.outlineColor);
      shadows.push('1px 0 0 ' + p.outlineColor);
      shadows.push('0 -1px 0 ' + p.outlineColor);
      shadows.push('0 1px 0 ' + p.outlineColor);
    }
    if (p.shadow) {
      var sc = hexToRgb(p.shadowColor);
      shadows.push('0 1px ' + p.shadowBlur + 'px rgba(' + sc.r + ', ' + sc.g + ', ' + sc.b + ', 0.8)');
    }
    return 'video::cue {\n'
      + '  font-family: ' + FONT_OPTIONS[p.font].family + ';\n'
      + '  font-weight: ' + (FONT_OPTIONS[p.font].weight || 400) + ';\n'
      + '  font-size: ' + p.size + 'px;\n'
      + '  line-height: 1.4;\n'
      + '  color: ' + p.color + ';\n'
      + '  background-color: rgba(' + bg.r + ', ' + bg.g + ', ' + bg.b + ', ' + alpha + ');\n'
      + '  text-shadow: ' + (shadows.length ? shadows.join(', ') : 'none') + ';\n'
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
      + '<div class="sub-field" id="sub-shadow-field"><span class="sub-label">Shadow</span><div class="sub-row">'
      + '<label class="sub-toggle"><input class="sub-check" id="sub-shadow" type="checkbox"' + (state.shadow ? ' checked' : '') + '>Aktif</label>'
      + '<input class="sub-color" id="sub-shadow-color" type="color" value="' + state.shadowColor + '" aria-label="Warna shadow subtitle"' + (state.shadow ? '' : ' disabled') + '>'
      + '<span class="sub-swatches">' + swatchRow('shadow-color', COLOR_PRESETS, state.shadowColor) + '</span></div></div>'
      + '<div class="sub-field" id="sub-shadow-blur-field"><label class="sub-label" for="sub-shadow-blur">Blur shadow · <span id="sub-shadow-blur-val">' + state.shadowBlur + ' px</span></label>'
      + '<input class="sub-range" id="sub-shadow-blur" type="range" min="0" max="12" step="1" value="' + state.shadowBlur + '" aria-label="Blur shadow subtitle"' + (state.shadow ? '' : ' disabled') + '></div>'
      + '<div class="sub-field" id="sub-outline-field"><span class="sub-label">Outline</span><div class="sub-row">'
      + '<label class="sub-toggle"><input class="sub-check" id="sub-outline" type="checkbox"' + (state.outline ? ' checked' : '') + '>Aktif</label>'
      + '<input class="sub-color" id="sub-outline-color" type="color" value="' + state.outlineColor + '" aria-label="Warna outline subtitle"' + (state.outline ? '' : ' disabled') + '>'
      + '<span class="sub-swatches">' + swatchRow('outline-color', COLOR_PRESETS, state.outlineColor) + '</span></div></div>'
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
    /* Saklar + warna shadow/outline, dan status mati/hidupnya
       (input color + preset dimatikan bila saklar mati). */
    var sh = el('sub-shadow');
    if (sh) sh.checked = !!state.shadow;
    var shC = el('sub-shadow-color');
    if (shC) { shC.value = state.shadowColor; shC.disabled = !state.shadow; }
    /* Item 45: slider blur shadow + status mati/hidupnya. */
    var shB = el('sub-shadow-blur');
    if (shB) { shB.value = String(state.shadowBlur); shB.disabled = !state.shadow; }
    var shBVal = el('sub-shadow-blur-val');
    if (shBVal) shBVal.textContent = state.shadowBlur + ' px';
    var shBF = el('sub-shadow-blur-field');
    if (shBF) shBF.classList.toggle('is-off', !state.shadow);
    var ol = el('sub-outline');
    if (ol) ol.checked = !!state.outline;
    var olC = el('sub-outline-color');
    if (olC) { olC.value = state.outlineColor; olC.disabled = !state.outline; }
    var shF = el('sub-shadow-field');
    if (shF) shF.classList.toggle('is-off', !state.shadow);
    var olF = el('sub-outline-field');
    if (olF) olF.classList.toggle('is-off', !state.outline);
    /* Tandai preset yang sedang aktif + matikan preset yang
       saklarnya mati (semua 4 kelompok warna). */
    var swatchKinds = [
      ['data-color', 'color'], ['data-bg', 'background'],
      ['data-shadow-color', 'shadowColor'], ['data-outline-color', 'outlineColor']
    ];
    swatchKinds.forEach(function (pair) {
      var attr = pair[0], field = pair[1];
      var cur = state[field].toUpperCase();
      var off = (field === 'shadowColor' && !state.shadow) || (field === 'outlineColor' && !state.outline);
      document.querySelectorAll('#menu-sub-body .sub-swatch[' + attr + ']').forEach(function (sw) {
        sw.classList.toggle('is-active', cur === sw.getAttribute(attr));
        sw.disabled = off;
      });
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
      /* Item 31 (§4.2.5 butir 1): slider TIDAK LAGI menutup menu
         pada change — pengguna menyesuaikan berulang kali tanpa
         membuka ulang menu. Nilai tetap disimpan lewat set(). */
      size.addEventListener('change', function () {
        set({ size: parseInt(size.value, 10) });
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
        else if (sw.getAttribute('data-bg')) set({ background: sw.getAttribute('data-bg') });
        else if (sw.getAttribute('data-shadow-color')) set({ shadowColor: sw.getAttribute('data-shadow-color') });
        else if (sw.getAttribute('data-outline-color')) set({ outlineColor: sw.getAttribute('data-outline-color') });
        closeMenu('sub-preset');
      });
    });
    var op = el('sub-opacity');
    if (op) {
      op.addEventListener('input', function () {
        preview({ opacity: parseInt(op.value, 10) });
        resetHideTimer();
      });
      /* Item 31 (§4.2.5 butir 1): seperti slider Ukuran — tidak
         lagi menutup menu pada change. */
      op.addEventListener('change', function () {
        set({ opacity: parseInt(op.value, 10) });
      });
    }
    /* Item 33: saklar + warna shadow/outline. Saklar memakai change
       → set() TANPA menutup menu (penyesuaian berulang, §4.2.5
       butir 1); color input memakai pola yang ada (preview saat
       input, set + tutup menu saat change). */
    var sh = el('sub-shadow');
    if (sh) sh.addEventListener('change', function () {
      set({ shadow: sh.checked });
      resetHideTimer();
    });
    var shC = el('sub-shadow-color');
    if (shC) {
      shC.addEventListener('input', function () {
        preview({ shadowColor: shC.value });
        resetHideTimer();
      });
      shC.addEventListener('change', function () {
        set({ shadowColor: shC.value });
        closeMenu('sub-color');
      });
    }
    /* Item 45: slider blur shadow — preview saat digeser (live),
       simpan saat lepas; seperti slider Ukuran/Opacity, TIDAK
       menutup menu pada change. */
    var shB = el('sub-shadow-blur');
    if (shB) {
      shB.addEventListener('input', function () {
        preview({ shadowBlur: parseInt(shB.value, 10) });
        resetHideTimer();
      });
      shB.addEventListener('change', function () {
        set({ shadowBlur: parseInt(shB.value, 10) });
      });
    }
    var ol = el('sub-outline');
    if (ol) ol.addEventListener('change', function () {
      set({ outline: ol.checked });
      resetHideTimer();
    });
    var olC = el('sub-outline-color');
    if (olC) {
      olC.addEventListener('input', function () {
        preview({ outlineColor: olC.value });
        resetHideTimer();
      });
      olC.addEventListener('change', function () {
        set({ outlineColor: olC.value });
        closeMenu('sub-color');
      });
    }
    var resetBtn = el('sub-reset');
    if (resetBtn) resetBtn.addEventListener('click', function () { reset(); });
  }

  /* Item 31 (§4.2.5 butir 3): gulir di dalam menu ⋮ me-reset timer
     auto-hide — pengguna yang sedang menggulir tidak boleh
     kehilangan menu di tengah jalan. Dipasang SEKALI pada wadah
     gulir menu (.player-menu__body sejak T2 v1.5.8; dulu #player-menu
     — elemen itu tidak lagi menggulir). Tanpa guard, renderMenu
     kedua akan menumpuk listener. (Item 47: saat menu terbuka timer
     memang ditangguhkan, jadi reset ini praktis no-op — dipertahankan
     sebagai pengaman perilaku lama.) */
  var menuScrollWired = false;
  function wireMenuScroll() {
    if (menuScrollWired) return;
    var menu = document.querySelector('.player-menu__body') || document.getElementById('player-menu');
    if (!menu) return;
    menuScrollWired = true;
    menu.addEventListener('scroll', function () { resetHideTimer(); }, { passive: true });
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
  wireMenuScroll();

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
