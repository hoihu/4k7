// SPIKE: the background of 4k7.dev drawn smooth instead of in block characters. The same scene as bg.js, a 4k7 resistor
// adrift in space with the sun going round behind it, but ray-traced per pixel in a WebGL fragment shader: a ceramic body
// with painted bands, tinned leads that glint, a sun with a soft limb and a corona, hashed stars. No libraries. The ship
// is smaller than in bg.js. `?scene=30` freezes it at second 30, `?size=0.6` scales the ship (1 = bg.js's size).
// `data-ship="none"` on the canvas (or `?ship=none`) leaves the ship out. Without WebGL it loads bg.js instead.
(function () {
  'use strict';
  var canvas = document.getElementById('scene');
  if (!canvas) return;
  var gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  if (!gl) { var s = document.createElement('script'); s.src = '/bg.js'; document.head.appendChild(s); return; }
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var q = new URLSearchParams(location.search);
  var frozen = q.get('scene'); frozen = frozen === null ? null : parseFloat(frozen);
  var SCALE = parseFloat(q.get('size') || '0.58');
  var noShip = canvas.dataset.ship === 'none' || q.get('ship') === 'none';   // the sky alone: sun and stars

  var VS = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
  var FS = [
    'precision highp float;',
    'uniform vec2 uRes; uniform float uDpr, uTime, uSunR, uF, uD, uLB, uRB, uLL, uRL, uFade;',
    'uniform vec2 uSun, uCenter; uniform vec3 uLight; uniform mat3 uRot;',
    'const vec3 BODY = vec3(0.91, 0.85, 0.74);',        // #e8d9bd, slightly warmer
    'const vec3 LEAD = vec3(0.72, 0.70, 0.66);',
    'vec3 bandColor(int k) {',
    '  if (k == 0) return vec3(0.95, 0.76, 0.19);',    // yellow
    '  if (k == 1) return vec3(0.52, 0.27, 0.72);',    // violet
    '  if (k == 2) return vec3(0.84, 0.22, 0.18);',    // red
    '  return vec3(0.84, 0.65, 0.23);',                // gold
    '}',
    'float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }',
    'vec3 lin(vec3 c) { return c * c; }',               // cheap gamma in / out
    // ray against a capsule on the x axis, -hl..hl, radius r. returns t (<0: miss) and the normal
    'float capsule(vec3 o, vec3 d, float hl, float r, out vec3 n) {',
    '  float a = dot(d.yz, d.yz), b = dot(o.yz, d.yz), c = dot(o.yz, o.yz) - r * r, best = -1.0;',
    '  n = vec3(0.0);',
    '  if (a > 1e-9) { float disc = b * b - a * c; if (disc > 0.0) { float t = (-b - sqrt(disc)) / a; float x = o.x + t * d.x;',
    '    if (t > 0.0 && abs(x) <= hl) { best = t; n = vec3(0.0, (o.yz + t * d.yz) / r); } } }',
    '  for (int e = -1; e <= 1; e += 2) { vec3 p = o - vec3(float(e) * hl, 0.0, 0.0); float b2 = dot(p, d), c2 = dot(p, p) - r * r, d2 = b2 * b2 - c2;',
    '    if (d2 > 0.0) { float t = -b2 - sqrt(d2); if (t > 0.0 && (best < 0.0 || t < best)) { vec3 hp = p + t * d; if ((e < 0 && hp.x <= 0.0) || (e > 0 && hp.x >= 0.0)) { best = t; n = hp / r; } } } }',
    '  return best;',
    '}',
    // the sky behind: stars and the sun. px in css pixels, y down
    'vec4 sky(vec2 px) {',
    '  vec3 col = vec3(0.0); float al = 0.0;',
    // stars: one candidate per 26 px cell, a third of them lit
    '  vec2 cell = floor(px / 22.0), f = px / 22.0 - cell;',
    '  float h = hash(cell), h2 = hash(cell + 7.1), h3 = hash(cell + 19.3);',
    '  if (h < 0.42) { vec2 sp = vec2(hash(cell + 3.3), hash(cell + 5.7)) * 0.8 + 0.1; float dd = length(f - sp) * 22.0;',
    '    float tw = 0.55 + 0.45 * sin(uTime * (0.3 + h2 * 1.2) + h3 * 6.28); float big = step(0.9, h2);',
    '    float r = 0.75 + big * 1.1; float st = exp(-dd * dd / (r * r)) * (0.5 + 0.5 * tw) * (0.7 + big * 0.5);',
    '    st += big * exp(-dd / 2.5) * 0.25 * tw;',                              // the bright ones have a little halo
    '    vec3 sc = mix(vec3(0.80, 0.85, 1.0), vec3(1.0, 0.92, 0.78), step(0.6, h3));',
    '    col += sc * st; al += st; }',
    // the sun: a disc with a soft limb, a corona falling off with distance, faint rays
    '  vec2 v = px - uSun; float d = length(v), rs = uSunR;',
    '  float disc = 1.0 - smoothstep(rs * 0.94, rs * 1.03, d);',
    '  float limb = smoothstep(rs * 0.3, rs, d);',
    '  vec3 sunc = mix(vec3(1.0, 0.97, 0.86), vec3(1.0, 0.78, 0.42), limb * limb);',
    '  float ang = atan(v.y, v.x);',
    '  float rays = 0.5 + 0.5 * sin(ang * 9.0 + uTime * 0.05) * sin(ang * 5.0 - uTime * 0.031 + 1.3);',
    '  float cor = pow(rs / max(d, rs), 1.6) * (0.55 + 0.45 * rays) * (1.0 - disc);',
    '  float far = exp(-d / (rs * 7.0)) * 0.22 + exp(-d / (rs * 22.0)) * 0.06;',
    '  float streak = exp(-abs(v.y) / (rs * 0.12)) * exp(-abs(v.x) / (rs * 5.0)) * 0.35 * (1.0 - disc);',   // a thin lens streak
    '  vec3 corc = mix(vec3(0.95, 0.42, 0.14), vec3(1.0, 0.86, 0.6), clamp(cor + streak, 0.0, 1.0));',
    '  float glow = clamp(cor * 0.7 + far + streak, 0.0, 1.0);',
    '  col = col * (1.0 - disc) + sunc * disc + corc * glow;',
    '  al = max(al * (1.0 - disc) + disc, 0.0) + glow;',
    '  return vec4(col, min(al, 1.0));',
    '}',
    // the ship: one ray. returns colour with alpha 1 on a hit, 0 otherwise; the sky shows through where it misses
    'vec4 ship(vec2 px, vec4 bg) {',
    '  vec3 dw = normalize(vec3((px.x - uCenter.x) / uF, -(px.y - uCenter.y) / uF, -1.0));',
    '  vec3 o = uRot * vec3(0.0, 0.0, uD), d = uRot * dw;',
    '  vec3 n; float t = capsule(o, d, uLB, uRB, n); bool body = t > 0.0; vec3 base; float gloss, shin;',
    '  if (body) {',
    '    float fx = (o.x + t * d.x + uLB) / (2.0 * uLB);',
    '    base = BODY; float edge = 0.0; float bandIn = 0.0; int which = 0;',
    '    float at[4]; at[0] = 0.21; at[1] = 0.40; at[2] = 0.60; at[3] = 0.83;',
    '    for (int k = 0; k < 4; k++) { float dk = abs(fx - at[k]) - 0.052; float w = 0.006;',
    '      float inside = 1.0 - smoothstep(-w, w, dk); if (inside > bandIn) { bandIn = inside; which = k; }',
    '      edge = max(edge, exp(-dk * dk / 0.00012)); }',
    '    base = mix(base, bandColor(which), bandIn);',
    '    base *= 1.0 - 0.22 * edge;',                                   // the paint's own small shadow at a band's edge
    '    vec3 hp = o + t * d; base *= 0.97 + 0.06 * hash(floor(vec2(fx * 300.0, atan(hp.z, hp.y) * 40.0)));',   // ceramic speckle
    '    gloss = 0.35 + 0.35 * bandIn; shin = 36.0 + 60.0 * bandIn;',
    '  } else {',
    '    t = capsule(o, d, uLL, uRL, n); if (t < 0.0) return bg;',
    '    base = LEAD; gloss = 1.2; shin = 70.0;',
    '  }',
    '  vec3 N = normalize(n * uRot);',                                   // ship -> world (uRot is orthonormal)
    '  vec3 V = -dw, L = uLight, H = normalize(L + V);',
    '  float ndl = dot(N, L), diff = max(ndl, 0.0), ndv = max(dot(N, V), 0.0), ndh = max(dot(N, H), 0.0);',
    '  float fres = pow(1.0 - ndv, 4.0);',
    '  vec3 sunL = vec3(1.0, 0.93, 0.80) * 1.35, starL = vec3(0.30, 0.40, 0.62);',
    '  float wrap = max((ndl + 0.25) / 1.25, 0.0);',                      // a little light creeps round the terminator
    '  vec3 col = lin(base) * (sunL * (body ? wrap : diff) + starL * (0.10 + 0.12 * max(-N.y, 0.0) + 0.1 * (1.0 - diff)));',
    '  float spec = pow(ndh, shin) * gloss * (0.4 + 0.6 * step(0.0, ndl));',
    '  if (!body) { spec += pow(ndh, 8.0) * 0.18 * diff; col = col * 0.9 + lin(LEAD) * fres * 0.4 * starL * 2.0; }',
    '  col += sunL * spec;',
    '  col += starL * fres * (body ? 0.35 : 0.6);',                      // starlight on the shoulders
    '  col += sunL * fres * fres * max(dot(L, -V) * 0.5 + 0.5, 0.0) * 0.25 * (1.0 - diff);',  // the sun's rim when it is behind
    '  col = sqrt(max(col, 0.0));',
    '  col = col / (1.0 + col * 0.12);',
    '  return vec4(col, 1.0);',
    '}',
    'void main() {',
    '  vec2 px = gl_FragCoord.xy / uDpr; px.y = uRes.y / uDpr - px.y;',
    '  vec4 bg = sky(px);',
    // is the ship anywhere near? a quick test against its bounding disc keeps the sky cheap
    '  vec2 rel = px - uCenter; float reach = (uLL + uRB) * 1.08 * uD / (uD - uRB);',
    '  vec4 c;',
    '  if (dot(rel, rel) > reach * reach) c = bg; else {',
    '    c = vec4(0.0);',
    '    c += ship(px + vec2(-0.3, -0.1), bg); c += ship(px + vec2(0.1, -0.3), bg); c += ship(px + vec2(0.3, 0.1), bg); c += ship(px + vec2(-0.1, 0.3), bg);',
    '    c *= 0.25;',
    '  }',
    '  gl_FragColor = vec4(c.rgb * c.a, c.a) * uFade;',
    '}'
  ].join('\n');

  function shader(type, src) {
    var sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }
  var prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var U = {};
  ['uRes', 'uDpr', 'uTime', 'uSunR', 'uF', 'uD', 'uLB', 'uRB', 'uLL', 'uRL', 'uFade', 'uSun', 'uCenter', 'uLight', 'uRot'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });

  var dpr, W, H, away = 0;
  function setup() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function frame(t) {
    // the sun, on a long slow round behind everything; its light comes from where it is
    var a = -0.6 + t * (6.2832 / 300), SX = W / 2 + 0.46 * W * Math.cos(a), SY = H * 0.38 + 0.22 * H * Math.sin(a), rs = Math.min(W, H) * 0.034;
    var LX = (SX - W / 2) / (0.46 * W), LY = -(SY - H * 0.38) / (0.22 * H) * 0.8, LZ = 0.55, ln = 1 / Math.sqrt(LX * LX + LY * LY + LZ * LZ);
    // the ship: adrift, turning so little you have to watch for it
    var yaw = 0.42 + 0.1 * Math.sin(t * 0.041), pitch = -0.08 + 0.07 * Math.sin(t * 0.029), roll = 0.12 * Math.sin(t * 0.023);
    var size = Math.max(W * 0.78, Math.min(H * 0.95, W * 1.2)) * SCALE, LB = size * 0.26, RB = size * 0.085, LL = size * 0.5, RL = size * 0.012;
    var CX = W * 0.5 + 0.015 * W * Math.sin(t * 0.021), CY = H * (H > W ? 0.82 : 0.72) + 0.012 * H * Math.sin(t * 0.017) + away * away * (3 - 2 * away) * H * 0.5, D = size * 2.4;
    var cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    // world -> ship, as toShip in bg.js: undo yaw (about y), then pitch (about z), then roll (about x). Column-major for GL.
    var m = [], e = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var c = 0; c < 3; c++) {
      var x = e[c][0], y = e[c][1], z = e[c][2];
      var x1 = x * cy - z * sy, z1 = x * sy + z * cy, x2 = x1 * cp + y * sp, y2 = -x1 * sp + y * cp;
      m.push(x2, y2 * cr + z1 * sr, -y2 * sr + z1 * cr);
    }
    gl.uniform2f(U.uRes, canvas.width, canvas.height); gl.uniform1f(U.uDpr, dpr); gl.uniform1f(U.uTime, t);
    gl.uniform2f(U.uSun, SX, SY); gl.uniform1f(U.uSunR, rs); gl.uniform3f(U.uLight, LX * ln, LY * ln, LZ * ln);
    gl.uniform2f(U.uCenter, CX, CY); gl.uniform1f(U.uF, D); gl.uniform1f(U.uD, D);
    if (noShip) { RB = 0; LL = -1; D = 1; gl.uniform1f(U.uD, D); }      // a reach below zero: every pixel is sky
    gl.uniform1f(U.uLB, LB); gl.uniform1f(U.uRB, RB); gl.uniform1f(U.uLL, LL); gl.uniform1f(U.uRL, RL); gl.uniform1f(U.uFade, 1);
    gl.uniformMatrix3fv(U.uRot, false, m);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    canvas.classList.add('live');
  }

  // ---------- run (as bg.js) ----------
  var t0 = performance.now(), last = 0, raf = 0, rt;
  function wanted() { return document.documentElement.classList.contains('open') ? 1 : 0; }
  away = wanted();
  function tick(now) {
    raf = requestAnimationFrame(tick);
    var want = wanted();
    if (now - last < (away === want ? 33 : 16)) return;                // 30 fps, smooth while it drifts
    away = want > away ? Math.min(want, away + (now - last) / 1400) : Math.max(want, away - (now - last) / 1400);
    last = now;
    frame((now - t0) / 1000);
  }
  function still() {
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
