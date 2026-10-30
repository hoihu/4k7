// The background of 4k7.dev: a giant 4k7 resistor adrift in space, drawn in block characters. It floats like
// a ship, barely turning. The sun goes round slowly behind it, and its light sweeps the ceramic body and
// glints along the metal leads; starlight leaves a faint blue cast on the shadowed side. A small ray caster renders into 2x2 "pixels" per character cell, which become quadrant and shade
// glyphs (▘▀▙█ ░▒▓), drawn as shapes from an atlas so the cells join up in every browser. Plain canvas 2D,
// no libraries. `?scene=30` on the URL freezes it at second 30 (for screenshots). While a feature is open
// (`.open` on <html>, set by index.html) the ship drifts down out of the picture, and back when it closes.
(function () {
  'use strict';
  var canvas = document.getElementById('scene');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var frozen = new URLSearchParams(location.search).get('scene');
  frozen = frozen === null ? null : parseFloat(frozen);

  // ---------- materials ----------
  var MAT = [null, '#1b2a44', '#7fb3e6', '#ffe9a3', '#f2a24a', '#cfd6e6', '#dccaa3', '#f2c230', '#a770e6', '#ea4c41', '#d7a63a', '#aeb3bd', '#fff6dc', '#8fb0d8'];
  var M_SUN = 3, M_GLOW = 4, M_STAR = 5, M_BODY = 6, M_BAND = 7,   // 7-10: yellow, violet, red, gold (1 and 2 are spare)
      M_LEAD = 11, M_SPEC = 12, M_SHINE = 13;
  var BAND_AT = [0.21, 0.40, 0.60, 0.83], BAND_HALF = 0.058;         // as on the logo, left to right
  var LVL = [0.38, 0.6, 0.82, 1];                                     // opacity of a style
  var NG = 21;                                                        // 0-15 quadrants, 16-18 ░▒▓, 19 dot, 20 big dot
  var G_DOT = 19, SHADE_OF = [16, 17, 18, 15];
  var NSTYLE = MAT.length * 4;

  var dpr, W, H, cw, ch, cols, rows, sw, sh, atlas;
  var g3, sub, subL, stars;
  var away = 0;                                                       // the ship's drift: 0 in its place, 1 gone

  function rng(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // ---------- the glyph atlas ----------
  function buildAtlas() {
    var d = Math.max(1, Math.round(dpr)), SW = Math.round(cw * dpr), SH = Math.round(ch * dpr);
    atlas = document.createElement('canvas');
    atlas.width = NG * SW; atlas.height = NSTYLE * SH;
    var a = atlas.getContext('2d'), hw = Math.round(SW / 2), hh = Math.round(SH / 2);
    for (var m = 1; m < MAT.length; m++) {
      var rgb = [parseInt(MAT[m].slice(1, 3), 16), parseInt(MAT[m].slice(3, 5), 16), parseInt(MAT[m].slice(5, 7), 16)];
      for (var l = 0; l < 4; l++) {
        var y0 = (m * 4 + l) * SH;
        a.fillStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + LVL[l] + ')';
        for (var g = 0; g < NG; g++) {
          var x0 = g * SW, i, j;
          if (g < 16) {
            if (g & 1) a.fillRect(x0, y0, hw, hh);
            if (g & 2) a.fillRect(x0 + hw, y0, SW - hw, hh);
            if (g & 4) a.fillRect(x0, y0 + hh, hw, SH - hh);
            if (g & 8) a.fillRect(x0 + hw, y0 + hh, SW - hw, SH - hh);
          } else if (g < 19) {                       // ░ ▒ ▓ as a dither of 2-pixel dots
            if (g === 18) a.fillRect(x0, y0, SW, SH);
            for (j = 0; j * 2 * d < SH; j++) {
              if (g !== 17 && (j & 1)) continue;     // ░ and ▓ use every other row of dots, ▒ every row
              var off = (g === 17 ? j & 1 : (j >> 1) & 1) * 2 * d;
              for (i = 0; i * 4 * d < SW; i++) {
                var px = x0 + i * 4 * d + off, wd = Math.min(2 * d, x0 + SW - px);
                if (wd <= 0) continue;
                if (g === 18) a.clearRect(px, y0 + j * 2 * d, wd, 2 * d); else a.fillRect(px, y0 + j * 2 * d, wd, 2 * d);
              }
            }
          } else {
            var rr = g === 20 ? SW * 0.42 : SW * 0.26;
            a.beginPath(); a.ellipse(x0 + SW / 2, y0 + SH / 2, rr, rr, 0, 0, 6.2832); a.fill();
          }
        }
      }
    }
  }

  // ---------- layout of the canvas ----------
  function setup() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cw = Math.max(7, Math.min(11, Math.round(W / 150))); ch = cw * 2;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    cols = Math.ceil(W / cw); rows = Math.ceil(H / ch); sw = cols * 2; sh = rows * 2;
    g3 = new Int16Array(cols * rows);
    sub = new Uint8Array(sw * sh); subL = new Uint8Array(sw * sh);
    var r = rng(11); stars = [];
    for (var i = 0; i < Math.round(cols * rows / 60); i++) stars.push({ c: Math.floor(r() * cols), r: Math.floor(r() * rows), ph: r() * 6.28, sp: 0.2 + r() * 0.5 });
    buildAtlas();
  }

  // ---------- the resistor ----------
  // Along its own x axis: the body a capsule of half-length LB and radius RB, a lead of radius RL out to LL each side.
  var hMat, hNx, hNy, hNz;
  function bandAt(f) {
    for (var k = 0; k < 4; k++) if (Math.abs(f - BAND_AT[k]) < BAND_HALF) return M_BAND + k;
    return M_BODY;
  }
  // ray (o, d) against a capsule on the x axis from -hl..hl with radius r; sets hN*, returns t or -1
  function capsule(ox, oy, oz, dx, dy, dz, hl, r) {
    var a = dy * dy + dz * dz, b = oy * dy + oz * dz, c = oy * oy + oz * oz - r * r, best = -1, t, x;
    if (a > 1e-9) {
      var disc = b * b - a * c;
      if (disc > 0) {
        t = (-b - Math.sqrt(disc)) / a; x = ox + t * dx;
        if (t > 0 && x >= -hl && x <= hl) { best = t; hNx = 0; hNy = (oy + t * dy) / r; hNz = (oz + t * dz) / r; }
      }
    }
    for (var e = -1; e <= 1; e += 2) {
      var px = ox - e * hl, b2 = px * dx + oy * dy + oz * dz, c2 = px * px + oy * oy + oz * oz - r * r, d2 = b2 * b2 - c2;
      if (d2 > 0) {
        t = -b2 - Math.sqrt(d2);
        if (t > 0 && (best < 0 || t < best)) {
          x = px + t * dx;
          if (e < 0 ? x <= 0 : x >= 0) { best = t; hNx = x / r; hNy = (oy + t * dy) / r; hNz = (oz + t * dz) / r; }
        }
      }
    }
    return best;
  }

  function render(t) {
    var hx = cw / 2, hy = ch / 2, i, sx, sy, si;
    sub.fill(0);

    // the sun, on a long slow round behind everything; its light comes from where it is
    var a = -0.6 + t * (6.2832 / 300), SX = W / 2 + 0.46 * W * Math.cos(a), SY = H * 0.38 + 0.22 * H * Math.sin(a), rs = Math.min(W, H) * 0.04;
    var LX = (SX - W / 2) / (0.46 * W), LY = -(SY - H * 0.38) / (0.22 * H) * 0.8, LZ = 0.55, ln = 1 / Math.sqrt(LX * LX + LY * LY + LZ * LZ);
    LX *= ln; LY *= ln; LZ *= ln;
    var gr = rs * 3.2, x0 = Math.max(0, Math.floor((SX - gr) / hx)), x1 = Math.min(sw - 1, Math.ceil((SX + gr) / hx)), y0 = Math.max(0, Math.floor((SY - gr) / hy)), y1 = Math.min(sh - 1, Math.ceil((SY + gr) / hy));
    for (sy = y0; sy <= y1; sy++) for (sx = x0; sx <= x1; sx++) {
      var dd = Math.hypot((sx + 0.5) * hx - SX, (sy + 0.5) * hy - SY), si2 = sy * sw + sx;
      if (dd < rs) { sub[si2] = M_SUN; subL[si2] = 3; }
      else if (dd < gr) { var g = 1 - (dd - rs) / (gr - rs); sub[si2] = M_GLOW; subL[si2] = g > 0.7 ? 2 : g > 0.35 ? 1 : 0; }
    }

    // the ship: adrift, turning so little you have to watch for it
    var yaw = 0.42 + 0.1 * Math.sin(t * 0.041), pitch = -0.08 + 0.07 * Math.sin(t * 0.029), roll = 0.12 * Math.sin(t * 0.023);
    var size = Math.max(W * 0.78, Math.min(H * 0.95, W * 1.2)), LB = size * 0.26, RB = size * 0.085, LL = size * 0.5, RL = size * 0.012;
    var CXr = W * 0.5 + 0.015 * W * Math.sin(t * 0.021), CYr = H * (H > W ? 0.82 : 0.72) + 0.012 * H * Math.sin(t * 0.017) + away * away * (3 - 2 * away) * H * 0.5, D = size * 2.4, fpx = D;
    var cy_ = Math.cos(yaw), sy_ = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    // world -> ship: undo yaw (about y), then pitch (about z), then roll (about x)
    function toShip(x, y, z, out) {
      var x1 = x * cy_ - z * sy_, z1 = x * sy_ + z * cy_;
      var x2 = x1 * cp + y * sp, y2 = -x1 * sp + y * cp;
      out[0] = x2; out[1] = y2 * cr + z1 * sr; out[2] = -y2 * sr + z1 * cr;
    }
    function toWorld(x, y, z, out) {
      var y1 = y * cr - z * sr, z1 = y * sr + z * cr;
      var x2 = x * cp - y1 * sp, y2 = x * sp + y1 * cp;
      out[0] = x2 * cy_ + z1 * sy_; out[1] = y2; out[2] = -x2 * sy_ + z1 * cy_;
    }
    var O = [0, 0, 0], Dd = [0, 0, 0], Nw = [0, 0, 0];
    toShip(0, 0, D, O);                                  // the camera, in the ship's axes (world: at +z, looking at -z)
    var reach = LL + RB, bx0 = Math.max(0, Math.floor((CXr - reach * 1.05) / hx)), bx1 = Math.min(sw - 1, Math.ceil((CXr + reach * 1.05) / hx));
    var by0 = Math.max(0, Math.floor((CYr - reach * 0.55) / hy)), by1 = Math.min(sh - 1, Math.ceil((CYr + reach * 0.55) / hy));
    for (sy = by0; sy <= by1; sy++) {
      var vy = -((sy + 0.5) * hy - CYr) / fpx;
      for (sx = bx0; sx <= bx1; sx++) {
        var vx = ((sx + 0.5) * hx - CXr) / fpx, nr = 1 / Math.sqrt(vx * vx + vy * vy + 1);
        toShip(vx * nr, vy * nr, -nr, Dd);
        var th = capsule(O[0], O[1], O[2], Dd[0], Dd[1], Dd[2], LB, RB), mat, shin, nx = hNx, ny = hNy, nz = hNz;
        if (th > 0) { mat = bandAt((O[0] + th * Dd[0] + LB) / (2 * LB)); shin = 70; }
        else {
          th = capsule(O[0], O[1], O[2], Dd[0], Dd[1], Dd[2], LL, RL);
          if (th < 0) continue;
          nx = hNx; ny = hNy; nz = hNz; mat = M_LEAD; shin = 90;
        }
        toWorld(nx, ny, nz, Nw);
        var ndl = Nw[0] * LX + Nw[1] * LY + Nw[2] * LZ, diff = ndl > 0 ? ndl : 0;
        var hvx = LX - vx * nr, hvy = LY - vy * nr, hvz = LZ + nr, hn = 1 / Math.sqrt(hvx * hvx + hvy * hvy + hvz * hvz);
        var ndh = (Nw[0] * hvx + Nw[1] * hvy + Nw[2] * hvz) * hn, spec = ndh > 0 ? Math.pow(ndh, shin) : 0;
        var lvl = diff < 0.1 ? 0 : diff < 0.38 ? 1 : diff < 0.72 ? 2 : 3;
        si = sy * sw + sx;
        if (spec > (mat === M_LEAD ? 0.3 : 0.62)) { sub[si] = M_SPEC; subL[si] = spec > 0.85 ? 3 : 2; }
        else if (mat === M_LEAD && diff > 0.5 && ndh > 0.9) { sub[si] = M_LEAD; subL[si] = 3; }
        else if (lvl === 0 && ndl < -0.5) { sub[si] = M_SHINE; subL[si] = 0; }   // starlight on the shadowed side
        else { sub[si] = mat; subL[si] = lvl; }
      }
    }

    // subpixels to characters
    g3.fill(-1);
    var mm = [0, 0, 0, 0], ll = [0, 0, 0, 0];
    for (var r_ = 0; r_ < rows; r_++) for (var c_ = 0; c_ < cols; c_++) {
      var i0 = r_ * 2 * sw + c_ * 2;
      mm[0] = sub[i0]; mm[1] = sub[i0 + 1]; mm[2] = sub[i0 + sw]; mm[3] = sub[i0 + sw + 1];
      ll[0] = subL[i0]; ll[1] = subL[i0 + 1]; ll[2] = subL[i0 + sw]; ll[3] = subL[i0 + sw + 1];
      var cov = 0, qm = 0, sum = 0, j, best = 0, bn = 0;
      for (j = 0; j < 4; j++) if (mm[j]) { cov++; qm |= 1 << j; sum += ll[j]; }
      if (!cov) continue;
      for (j = 0; j < 4; j++) if (mm[j]) {               // the material most of it is made of
        var n = 0; for (var k2 = 0; k2 < 4; k2++) if (mm[k2] === mm[j]) n++;
        if (n > bn) { bn = n; best = mm[j]; }
      }
      var avg = Math.round(sum / cov);
      // the glow is dithered by its level; the ship and the sun are solid
      g3[r_ * cols + c_] = cov === 4 && best === M_GLOW ? (best * 4 + 3) * NG + SHADE_OF[avg] : (best * 4 + avg) * NG + qm;
    }
    // stars, where the sky is empty
    for (i = 0; i < stars.length; i++) {
      var S = stars[i], idx = S.r * cols + S.c;
      if (g3[idx] >= 0) continue;
      var tw = 0.5 + 0.5 * Math.sin(t * S.sp + S.ph), sl = tw > 0.85 ? 3 : tw > 0.5 ? 2 : tw > 0.2 ? 1 : -1;
      if (sl >= 0) g3[idx] = (M_STAR * 4 + sl) * NG + G_DOT;
    }
  }

  // ---------- one frame ----------
  function frame(t) {
    render(t);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var SW = Math.round(cw * dpr), SH = Math.round(ch * dpr), n = cols * rows;
    for (var i = 0; i < n; i++) {
      var g = g3[i];
      if (g < 0) continue;
      var s = (g / NG) | 0;
      ctx.drawImage(atlas, (g - s * NG) * SW, s * SH, SW, SH, (i % cols) * cw, ((i / cols) | 0) * ch, cw, ch);
    }
    canvas.classList.add('live');
  }

  // ---------- run ----------
  var t0 = performance.now(), last = 0, raf = 0, rt;
  function wanted() { return document.documentElement.classList.contains('open') ? 1 : 0; }
  away = wanted();                                                    // opened from a link: it is gone already
  function tick(now) {
    raf = requestAnimationFrame(tick);
    var want = wanted();
    if (now - last < (away === want ? 50 : 16)) return;                // 20 fps, smooth while it drifts
    away = want > away ? Math.min(want, away + (now - last) / 1400) : Math.max(want, away - (now - last) / 1400);
    last = now;
    frame((now - t0) / 1000);
  }
  function still() {                                                   // one picture, the ship where it belongs
    var at = frozen !== null && !isNaN(frozen) ? frozen : reduce.matches ? 40 : null;
    if (at === null) return false;
    away = wanted(); frame(at);
    return true;
  }
  function start() {
    cancelAnimationFrame(raf);
    setup();
    if (still()) return;
    t0 = performance.now();
    raf = requestAnimationFrame(tick);
  }
  new MutationObserver(still).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(start, 200); });
  reduce.addEventListener && reduce.addEventListener('change', start);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) cancelAnimationFrame(raf); else if (frozen === null && !reduce.matches) { cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); }
  });
  start();
})();
