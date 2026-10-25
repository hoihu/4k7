/**
 * The impedance of a track (docs/design/impedance.md): a 2D quasi-static field solver for the
 * cross-section of a track over its plane. A microstrip, a coplanar line (ground copper beside it
 * on its layer), a differential pair of either, with solder mask over them, or a stripline between
 * two planes. Laplace's equation on a graded rectangular grid (finite volumes, dielectric
 * interfaces on grid lines), solved by conjugate gradients; the capacitance per length from the
 * field's energy, once with the dielectrics and once in air: Z0 = η0 / √(C · C0) in units of ε0,
 * εeff = C / C0. The tests hold it to the exact solutions (stripline and coplanar waveguide by
 * conformal mapping) and to Hammerstad and Jensen's microstrip, within 0.3 %.
 *
 * And the inverse: the width, or a pair's gap, that gives a target impedance.
 */

/** Free-space impedance, Ω. */
const ETA0 = 376.730313668;
/** Speed of light, mm per ns. */
const C0 = 299.792458;

/** A slab of dielectric: thickness (mm) and relative permittivity. */
export interface Dielectric {
  h: number;
  er: number;
}

/** A track's cross-section, in mm. */
export interface Section {
  /** Copper thickness. */
  t: number;
  /** Track width. */
  w: number;
  /** The dielectric between the track's layer and its plane, from the plane up (one slab, or several: a plane two layers down). */
  below: Dielectric[];
  /** A stripline: the dielectric from the track's layer up to a second plane (the copper sits in it). Absent: air above, a microstrip. */
  above?: Dielectric[];
  /** A differential pair: the gap between its two tracks, edge to edge. */
  s?: number;
  /** Coplanar: the gap to the ground copper beside the track (or the pair) on its layer. */
  g?: number;
  /** Solder mask over a microstrip: its thickness over the laminate and over the copper, and its εr. */
  mask?: { base: number; copper: number; er: number };
}

export interface LineResult {
  /** The line's impedance (Ω): Z0 of one track, a pair's differential impedance. */
  z: number;
  /** A pair: odd- and even-mode impedance of one track, and the common-mode impedance (Zeven / 2). */
  odd?: number;
  even?: number;
  common?: number;
  /** Effective permittivity (a pair: of the odd mode, which the differential signal travels in). */
  eeff: number;
  /** Delay, ps per mm. */
  delay: number;
}

type Mode = 'single' | 'odd' | 'even';

/**
 * How fine the grid is: cells at the copper's edges a `thick`-th of the smallest feature (thickness,
 * half width, gaps; `thin` for copper of no thickness, whose edges crowd the field more), at most a
 * `cap`-th of the line's size near it, growing by `ratio` from cell to cell. Each line is solved on
 * this grid and on one twice as fine; the error is first order in the cell size, so the two give
 * the answer extrapolated to cells of no size (Richardson), to about 0.1 %.
 */
const GRID = { thick: 8, thin: 50, cap: 4, ratio: 1.3 };

const sum = (d: Dielectric[]) => d.reduce((s, x) => s + x.h, 0);

/* --------------------------------- the grid -------------------------------- */

/**
 * Grid lines between a and b, fine next to each end (cells dl at a, dr at b) and growing by
 * `ratio` towards the middle, no cell larger than `cap`.
 */
function fill(a: number, b: number, dl: number, dr: number, ratio: number, cap: number): number[] {
  const left: number[] = [];
  const right: number[] = [];
  let lo = a;
  let hi = b;
  dl = Math.min(dl, cap);
  dr = Math.min(dr, cap);
  while (hi - lo > dl + dr) {
    if (dl <= dr) {
      lo += dl;
      left.push(lo);
      dl = Math.min(dl * ratio, cap);
    } else {
      hi -= dr;
      right.push(hi);
      dr = Math.min(dr * ratio, cap);
    }
  }
  const n = Math.max(1, Math.round((hi - lo) / Math.max(dl, dr)));
  for (let i = 1; i < n; i++) left.push(lo + ((hi - lo) * i) / n);
  return [...left, ...right.reverse()];
}

/** Grid lines through the given coordinates (each with the cell size wanted next to it), graded between them. */
function lines(keys: { at: number; fine: number }[], ratio: number, cap: (a: number, b: number) => number): number[] {
  // (one line where keys meet, with the finest cells any of them wants)
  const ks: { at: number; fine: number }[] = [];
  for (const k of [...keys].sort((p, q) => p.at - q.at)) {
    const last = ks.at(-1);
    if (last && k.at - last.at <= 1e-9) last.fine = Math.min(last.fine, k.fine);
    else ks.push({ ...k });
  }
  const out: number[] = [];
  for (let i = 0; i < ks.length; i++) {
    out.push(ks[i]!.at);
    if (i + 1 < ks.length) out.push(...fill(ks[i]!.at, ks[i + 1]!.at, ks[i]!.fine, ks[i + 1]!.fine, ratio, cap(ks[i]!.at, ks[i + 1]!.at)));
  }
  return out;
}

interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface Geometry {
  xs: number[];
  ys: number[];
  signal: Rect;
  ground?: Rect;
  /** y of the second plane (stripline). */
  upper?: number;
  /** The permittivity at a point outside the copper (1 in air). */
  eps: (x: number, y: number) => number;
}

/**
 * The half cross-section x ≥ 0 (the line is symmetric about x = 0): the plane at y = 0, the
 * laminate above it, the copper on top of it; a single track is cut in half by x = 0, a pair has
 * one track at x = s/2 … s/2 + w.
 */
function geometry(sec: Section, mode: Mode, res: number): Geometry {
  const { t, w } = sec;
  const top = sum(sec.below);
  const x0 = mode === 'single' ? 0 : sec.s! / 2;
  const xo = mode === 'single' ? w / 2 : sec.s! / 2 + w;
  const signal: Rect = { x0, x1: xo, y0: top, y1: top + t };
  const mask = sec.above ? undefined : sec.mask;
  const coats = mask ? [mask.base, mask.copper].filter((c) => c > 1e-6) : [];
  const lateral = xo + (sec.g ?? 0);
  const span = Math.max(Math.min(top, 3 * lateral + w), w, sec.s ?? 0);
  const upper = sec.above ? top + sum(sec.above) : undefined;
  const xFar = lateral + (upper !== undefined ? 8 * upper : 40 * Math.max(span, top));
  const yFar = upper ?? top + t + 40 * span;
  const ground: Rect | undefined = sec.g !== undefined ? { x0: xo + sec.g, x1: xFar, y0: top, y1: top + t } : undefined;
  // the line's near field: cells no larger than capIn within it, growing beyond
  const near = Math.min(top, lateral + w);
  const xIn = Math.min(xFar, lateral + 2 * near);
  const yLo = Math.max(0, top - 2 * near);
  const yHi = Math.min(yFar, top + t + 2 * near);
  // the cells at the copper's edges (where the field crowds), and the largest in the near field:
  // the line's own scale, but no more than about 60 across it (a narrow gap is resolved by the
  // cells growing from its two edges; capping a wide near field by it would fill it with tiny cells)
  const feature = Math.min(t > 0 ? t : Infinity, w / 2, sec.s ?? Infinity, sec.g ?? Infinity, top);
  const fine = Math.max(5e-5, feature / ((t > 0 ? GRID.thick : GRID.thin) * res));
  const capIn = Math.max(fine, Math.min(top, w) / (GRID.cap * res), Math.max(xIn, yHi - yLo) / (60 * res));
  // (the mask's surfaces are dielectric interfaces, not edges: no crowding there)
  const coatFine = Math.max(fine, Math.min(...coats, Infinity) / (2 * res));
  // (a single track's middle, on the symmetry line, is no edge)
  const xKeys = [
    { at: 0, fine: mode === 'single' ? capIn : fine * 3 },
    ...(mode === 'single' ? [] : [{ at: x0, fine }]),
    { at: xo, fine },
    { at: xIn, fine: capIn },
    { at: xFar, fine: span },
  ];
  if (ground) xKeys.push({ at: ground.x0, fine });
  for (const c of mask ? [mask.copper] : []) {
    if (c <= 1e-6) continue;
    if (!ground || c < sec.g! - fine) xKeys.push({ at: xo + c, fine: coatFine });
    if (ground && c < sec.g! - fine) xKeys.push({ at: ground.x0 - c, fine: coatFine });
    if (mode !== 'single' && c < x0 - fine) xKeys.push({ at: x0 - c, fine: coatFine });
  }
  // (a plane has no edges to crowd the field)
  const yKeys = [
    { at: 0, fine: Math.min(capIn, top / 4) },
    { at: top, fine },
    { at: top + t, fine },
    { at: yHi, fine: capIn },
    { at: yFar, fine: upper !== undefined ? Math.min(capIn, (upper - top) / 4) : span },
  ];
  if (yLo > capIn) yKeys.push({ at: yLo, fine: capIn });
  let y = 0;
  for (const d of sec.below.slice(0, -1)) yKeys.push({ at: (y += d.h), fine: fine * 2 });
  if (sec.above) {
    y = top;
    for (const d of sec.above.slice(0, -1)) yKeys.push({ at: (y += d.h), fine: fine * 2 });
  }
  if (mask) {
    if (mask.base > 1e-6) yKeys.push({ at: top + mask.base, fine: coatFine });
    if (mask.copper > 1e-6) yKeys.push({ at: top + t + mask.copper, fine: coatFine });
  }
  // cells between two grid keys: capIn inside the near field, larger the further out
  const capOf = (lo: number, hi: number) => (a: number, b: number) => {
    const out = Math.max(lo - (a + b) / 2, (a + b) / 2 - hi, 0);
    return out > 1e-9 ? Math.max(capIn, out / 2) : capIn;
  };
  const xs = lines(xKeys.filter((k) => k.at <= xFar + 1e-9), GRID.ratio, capOf(0, xIn));
  const ys = lines(yKeys.filter((k) => k.at <= yFar + 1e-9), GRID.ratio, capOf(yLo, yHi));
  // the box distance from a point to the copper (outside it), for the mask's coat over it
  const boxDist = (r: Rect, px: number, py: number) => Math.max(r.x0 - px, px - r.x1, r.y0 - py, py - r.y1, 0);
  const slabAt = (slabs: Dielectric[], from: number, py: number) => {
    let at = from;
    for (const d of slabs) {
      at += d.h;
      if (py < at) return d.er;
    }
    return slabs.at(-1)!.er;
  };
  const eps = (px: number, py: number): number => {
    if (py < top) return slabAt(sec.below, 0, py);
    if (sec.above) return slabAt(sec.above, top, py);
    if (mask && (py <= top + mask.base || Math.min(boxDist(signal, px, py), ground ? boxDist(ground, px, py) : Infinity) <= mask.copper)) return mask.er;
    return 1;
  };
  return { xs, ys, signal, ...(ground ? { ground } : {}), ...(upper !== undefined ? { upper } : {}), eps };
}

/* --------------------------------- the solve -------------------------------- */

/**
 * The field's energy per length of one half cross-section with the track at 1 V and every plane
 * and ground at 0 (in units of ε0: the capacitance, as C = ε0 · energy), with the dielectrics
 * (e) and with air everywhere (e0).
 */
function energies(sec: Section, mode: Mode, res = 1): { e: number; e0: number } {
  const geo = geometry(sec, mode, res);
  const { xs, ys } = geo;
  const nx = xs.length;
  const ny = ys.length;
  const tol = 1e-9;
  const inRect = (r: Rect, x: number, y: number) => x >= r.x0 - tol && x <= r.x1 + tol && y >= r.y0 - tol && y <= r.y1 + tol;
  // fixed potentials (NaN: solved for)
  const fixed = new Float64Array(nx * ny).fill(Number.NaN);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const k = i * ny + j;
      const [x, y] = [xs[i]!, ys[j]!];
      if (j === 0 || j === ny - 1 || i === nx - 1 || (mode === 'odd' && i === 0)) fixed[k] = 0;
      else if (inRect(geo.signal, x, y)) fixed[k] = 1;
      else if (geo.ground && inRect(geo.ground, x, y)) fixed[k] = 0;
    }
  }
  // the unknowns, numbered along the grid's shorter side first (k = i·ny + j is the node)
  const index = new Int32Array(nx * ny).fill(-1);
  let n = 0;
  const byColumn = ny <= nx;
  for (let o = 0; o < (byColumn ? nx : ny); o++) {
    for (let q = 0; q < (byColumn ? ny : nx); q++) {
      const k = byColumn ? o * ny + q : q * ny + o;
      if (Number.isNaN(fixed[k]!)) index[k] = n++;
    }
  }
  let last: Float64Array | undefined;
  const solve = (air: boolean): number => {
    // each cell's permittivity, from its centre
    const cell = new Float64Array((nx - 1) * (ny - 1));
    for (let i = 0; i + 1 < nx; i++) for (let j = 0; j + 1 < ny; j++) cell[i * (ny - 1) + j] = air ? 1 : geo.eps((xs[i]! + xs[i + 1]!) / 2, (ys[j]! + ys[j + 1]!) / 2);
    const epsC = (i: number, j: number) => cell[i * (ny - 1) + j]!;
    // the edges' conductances (finite volumes): gx from node k to k + ny, gy from k to k + 1
    const gx = new Float64Array(nx * ny);
    const gy = new Float64Array(nx * ny);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const k = i * ny + j;
        if (i + 1 < nx) {
          const below = j > 0 ? (epsC(i, j - 1) * (ys[j]! - ys[j - 1]!)) / 2 : 0;
          const above = j + 1 < ny ? (epsC(i, j) * (ys[j + 1]! - ys[j]!)) / 2 : 0;
          gx[k] = (below + above) / (xs[i + 1]! - xs[i]!);
        }
        if (j + 1 < ny) {
          const left = i > 0 ? (epsC(i - 1, j) * (xs[i]! - xs[i - 1]!)) / 2 : 0;
          const right = i + 1 < nx ? (epsC(i, j) * (xs[i + 1]! - xs[i]!)) / 2 : 0;
          gy[k] = (left + right) / (ys[j + 1]! - ys[j]!);
        }
      }
    }
    // the system: each unknown's diagonal, and its neighbour numbered before it along the short
    // side (slot 1) and across it (slot 2), with their couplings; n stands for none
    const sys: System = { n, diag: new Float64Array(n), lo1: new Int32Array(n).fill(n), lo2: new Int32Array(n).fill(n), g1: new Float64Array(n + 1), g2: new Float64Array(n + 1), up1: new Int32Array(n).fill(n), up2: new Int32Array(n).fill(n) };
    const rhs = new Float64Array(n);
    const join = (p: number, q: number, g: number, along: boolean) => {
      const a = index[p]!;
      const b = index[q]!;
      if (a >= 0) sys.diag[a] = sys.diag[a]! + g;
      if (b >= 0) sys.diag[b] = sys.diag[b]! + g;
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        if (along) {
          sys.lo1[hi] = lo;
          sys.g1[hi] = g;
          sys.up1[lo] = hi;
        } else {
          sys.lo2[hi] = lo;
          sys.g2[hi] = g;
          sys.up2[lo] = hi;
        }
      } else if (a >= 0) rhs[a] = rhs[a]! + g * fixed[q]!;
      else if (b >= 0) rhs[b] = rhs[b]! + g * fixed[p]!;
    };
    for (let k = 0; k < nx * ny; k++) {
      if (gx[k]) join(k, k + ny, gx[k]!, !byColumn);
      if (gy[k]) join(k, k + 1, gy[k]!, byColumn);
    }
    // (the field in air is much like the field with the dielectrics: start from it)
    const phi = conjugateGradients(sys, rhs, last);
    last = phi;
    const pot = (k: number) => (index[k]! >= 0 ? phi[index[k]!]! : fixed[k]!);
    let e = 0;
    for (let k = 0; k < nx * ny; k++) {
      if (gx[k]) e += gx[k]! * (pot(k) - pot(k + ny)) ** 2;
      if (gy[k]) e += gy[k]! * (pot(k) - pot(k + 1)) ** 2;
    }
    return e;
  };
  return { e: solve(false), e0: solve(true) };
}

/**
 * A five-point system on a grid: A = diag − couplings, each unknown joined to the one before it
 * along the numbering's short side (lo1, g1) and the one before it across it (lo2, g2), up1 and
 * up2 the other way round. Index n stands for none (its coupling and value are 0).
 */
interface System {
  n: number;
  diag: Float64Array;
  lo1: Int32Array;
  lo2: Int32Array;
  g1: Float64Array;
  g2: Float64Array;
  up1: Int32Array;
  up2: Int32Array;
}

/**
 * Solves the system by conjugate gradients, preconditioned with its incomplete Cholesky factor
 * (no fill: for five points that is two couplings a row). The energy is quadratic in the error, so
 * a residual of 1e-8 leaves it exact for all purposes. `start`: a first guess.
 */
function conjugateGradients(s: System, b: Float64Array, start?: Float64Array): Float64Array {
  const { n, diag, lo1, lo2, g1, g2, up1, up2 } = s;
  // the factor: l1, l2 below the diagonal, ld on it
  const ld = new Float64Array(n);
  const l1 = new Float64Array(n + 1);
  const l2 = new Float64Array(n + 1);
  for (let r = 0; r < n; r++) {
    const v1 = lo1[r]! < n ? -g1[r]! / ld[lo1[r]!]! : 0;
    const v2 = lo2[r]! < n ? -g2[r]! / ld[lo2[r]!]! : 0;
    l1[r] = v1;
    l2[r] = v2;
    const d = diag[r]! - v1 * v1 - v2 * v2;
    if (!(d > 0)) throw new Error('impedance: the field equations are singular');
    ld[r] = Math.sqrt(d);
  }
  const precondition = (r: Float64Array, z: Float64Array) => {
    for (let k = 0; k < n; k++) z[k] = (r[k]! - l1[k]! * z[lo1[k]!]! - l2[k]! * z[lo2[k]!]!) / ld[k]!;
    for (let k = n - 1; k >= 0; k--) z[k] = (z[k]! - l1[up1[k]!]! * z[up1[k]!]! - l2[up2[k]!]! * z[up2[k]!]!) / ld[k]!;
  };
  const multiply = (x: Float64Array, y: Float64Array) => {
    for (let k = 0; k < n; k++) y[k] = diag[k]! * x[k]! - g1[k]! * x[lo1[k]!]! - g2[k]! * x[lo2[k]!]! - g1[up1[k]!]! * x[up1[k]!]! - g2[up2[k]!]! * x[up2[k]!]!;
  };
  // (every vector has a slot n, always 0, for "no neighbour")
  const x = new Float64Array(n + 1);
  const r = new Float64Array(n + 1);
  const z = new Float64Array(n + 1);
  const p = new Float64Array(n + 1);
  const ap = new Float64Array(n + 1);
  r.set(b);
  if (start) {
    x.set(start.subarray(0, n));
    multiply(x, ap);
    for (let k = 0; k < n; k++) r[k] = b[k]! - ap[k]!;
  }
  let bb = 0;
  for (let k = 0; k < n; k++) bb += b[k]! * b[k]!;
  precondition(r, z);
  p.set(z);
  let rz = 0;
  for (let k = 0; k < n; k++) rz += r[k]! * z[k]!;
  // (it converges in a few hundred iterations; the ceiling only guards against a stall)
  for (let it = 0, most = Math.min(4 * n + 100, 5000); it < most; it++) {
    multiply(p, ap);
    let pap = 0;
    for (let k = 0; k < n; k++) pap += p[k]! * ap[k]!;
    const alpha = rz / pap;
    let rr = 0;
    for (let k = 0; k < n; k++) {
      x[k] = x[k]! + alpha * p[k]!;
      r[k] = r[k]! - alpha * ap[k]!;
      rr += r[k]! * r[k]!;
    }
    if (rr <= 1e-16 * bb) break;
    precondition(r, z);
    let rz1 = 0;
    for (let k = 0; k < n; k++) rz1 += r[k]! * z[k]!;
    const beta = rz1 / rz;
    rz = rz1;
    for (let k = 0; k < n; k++) p[k] = z[k]! + beta * p[k]!;
  }
  return x;
}

/* ------------------------------- the line -------------------------------- */

const cache = new Map<string, LineResult>();
const CACHE_MAX = 4000;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** The impedance of a line with this cross-section (solved once per cross-section, then remembered). */
export function analyse(sec: Section): LineResult {
  return line(sec, false);
}

/**
 * `draft`: on one coarse grid, about 2 % off and a tenth of the work (where a search starts);
 * otherwise extrapolated from two grids.
 */
function line(sec: Section, draft: boolean): LineResult {
  check(sec);
  const key = (draft ? 'd' : '') + JSON.stringify(sec, (_, v) => (typeof v === 'number' ? r6(v) : v));
  const hit = cache.get(key);
  if (hit) return hit;
  const solve = (mode: Mode) => (draft ? energies(sec, mode, 0.5) : extrapolated(sec, mode));
  let out: LineResult;
  if (sec.s === undefined) {
    const { e, e0 } = solve('single');
    // (the half cross-section holds half the field)
    const eeff = e / e0;
    out = { z: ETA0 / Math.sqrt(4 * e * e0), eeff, delay: (1000 * Math.sqrt(eeff)) / C0 };
  } else {
    const o = solve('odd');
    const v = solve('even');
    const odd = ETA0 / Math.sqrt(o.e * o.e0);
    const even = ETA0 / Math.sqrt(v.e * v.e0);
    const eeff = o.e / o.e0;
    out = { z: 2 * odd, odd, even, common: even / 2, eeff, delay: (1000 * Math.sqrt(eeff)) / C0 };
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}

/** The energies on the grid and on one twice as fine, extrapolated to cells of no size (the error is first order). */
function extrapolated(sec: Section, mode: Mode): { e: number; e0: number } {
  const a = energies(sec, mode, 1);
  const b = energies(sec, mode, 2);
  return { e: 2 * b.e - a.e, e0: 2 * b.e0 - a.e0 };
}

function check(sec: Section) {
  const bad = (what: string) => {
    throw new RangeError(`impedance: ${what}`);
  };
  if (!(sec.w > 0)) bad('the width must be positive');
  if (!(sec.t >= 0)) bad('the copper thickness must not be negative');
  if (!sec.below.length || sec.below.some((d) => !(d.h > 0) || !(d.er >= 1))) bad('every dielectric needs a positive thickness and εr ≥ 1');
  if (sec.above && (!sec.above.length || sec.above.some((d) => !(d.h > 0) || !(d.er >= 1)) || sum(sec.above) <= sec.t)) bad('the dielectric above a stripline must be thicker than its copper');
  if (sec.s !== undefined && !(sec.s > 0)) bad('a pair\'s gap must be positive');
  if (sec.g !== undefined && !(sec.g > 0)) bad('the gap to the coplanar ground must be positive');
  if (sec.mask && (!(sec.mask.er >= 1) || sec.mask.base < 0 || sec.mask.copper < 0)) bad('the solder mask needs εr ≥ 1 and thicknesses ≥ 0');
}

/**
 * Hammerstad and Jensen's microstrip (1980; zero thickness to within 0.01 % of the exact Z0 for
 * w/h ≤ 1, with their correction for the copper's thickness): the closed form the solver is
 * checked against, and where its searches start.
 */
export function microstripHJ(w: number, h: number, er: number, t = 0): { z: number; eeff: number } {
  const zl1 = (u: number) => {
    const f = 6 + (2 * Math.PI - 6) * Math.exp(-Math.pow(30.666 / u, 0.7528));
    return (ETA0 / (2 * Math.PI)) * Math.log(f / u + Math.sqrt(1 + (2 / u) ** 2));
  };
  const ee = (u: number) => {
    const a = 1 + Math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + Math.log(1 + (u / 18.1) ** 3) / 18.7;
    const b = 0.564 * Math.pow((er - 0.9) / (er + 3), 0.053);
    return (er + 1) / 2 + ((er - 1) / 2) * Math.pow(1 + 10 / u, -a * b);
  };
  const u = w / h;
  if (t <= 0) return { z: zl1(u) / Math.sqrt(ee(u)), eeff: ee(u) };
  const tn = t / h;
  const du1 = (tn / Math.PI) * Math.log(1 + (4 * Math.E * Math.tanh(Math.sqrt(6.517 * u)) ** 2) / tn);
  const dur = 0.5 * (1 + 1 / Math.cosh(Math.sqrt(er - 1))) * du1;
  const [u1, ur] = [u + du1, u + dur];
  return { z: zl1(ur) / Math.sqrt(ee(ur)), eeff: ee(ur) * (zl1(u1) / zl1(ur)) ** 2 };
}

/** The width a microstrip of Z0 wants, from Hammerstad and Jensen (a starting point for the search). */
function guessWidth(z: number, h: number, er: number, t: number): number {
  let lo = h / 200;
  let hi = h * 40;
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(lo * hi);
    if (microstripHJ(mid, h, er, t).z > z) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

/**
 * Finds the value of one dimension that gives impedance `z` (`up`: the impedance rises with it, as
 * with a pair's gap; else it falls, as with the width), searching in log–log space (impedance
 * against size is nearly a straight line there). `start` is a first guess; the answer is good to
 * 0.05 % of the impedance or 0.0005 mm. Null if no size within [min, max] reaches it.
 */
function search(zOf: (x: number) => number, z: number, start: number, min: number, max: number, up: boolean, step = 1.6): number | null {
  const sign = up ? 1 : -1;
  const err = (x: number) => sign * (Math.log(zOf(x)) - Math.log(z));
  // bracket: err(lo) < 0 < err(hi) (in the direction the size moves the impedance)
  let x = Math.min(max, Math.max(min, start));
  let ex = err(x);
  let lo: { x: number; e: number } | null = ex < 0 ? { x, e: ex } : null;
  let hi: { x: number; e: number } | null = ex >= 0 ? { x, e: ex } : null;
  for (let k = 0; k < 40 && (!lo || !hi); k++) {
    x = lo ? Math.min(max, x * step) : Math.max(min, x / step);
    ex = err(x);
    if (ex < 0) lo = { x, e: ex };
    else hi = { x, e: ex };
    if ((!lo && x <= min) || (!hi && x >= max)) break;
    step = Math.min(2, step * step);
  }
  if (!lo || !hi) return null;
  // regula falsi on log size (Illinois), then the closer end
  let [a, c] = [lo, hi];
  let side = 0;
  for (let k = 0; k < 40; k++) {
    const [la, lc] = [Math.log(a.x), Math.log(c.x)];
    const x = Math.exp(lc - (c.e * (lc - la)) / (c.e - a.e));
    const m = { x, e: err(x) };
    if (Math.abs(m.e) < 5e-4 || Math.abs(c.x - a.x) < 5e-4) return m.x;
    if (m.e < 0) {
      a = m;
      if (side === -1) c = { ...c, e: c.e / 2 };
      side = -1;
    } else {
      c = m;
      if (side === 1) a = { ...a, e: a.e / 2 };
      side = 1;
    }
  }
  return Math.abs(a.e) < Math.abs(c.e) ? a.x : c.x;
}

/** The (dielectric-weighted) height and εr of what lies under a track, for first guesses. */
function equivalent(sec: Pick<Section, 'below'>): { h: number; er: number } {
  const h = sum(sec.below);
  return { h, er: sec.below.reduce((s, d) => s + d.er * d.h, 0) / h };
}

/**
 * A dimension that gives impedance `z`: found on the draft grid first, then finished on the
 * accurate one from there (a few solves instead of a dozen).
 */
function find(zOf: (x: number, draft: boolean) => number, z: number, start: number, min: number, max: number, up: boolean): number | null {
  const rough = search((x) => zOf(x, true), z, start, min, max, up);
  if (rough === null) return search((x) => zOf(x, false), z, start, min, max, up);
  // the draft is off by much the same factor nearby: corrected by it, it finds the answer again
  const bias = zOf(rough, false) / zOf(rough, true);
  const next = search((x) => zOf(x, true) * bias, z, rough, min, max, up, 1.03);
  if (next !== null && Math.abs(Math.log(zOf(next, false) / z)) < 5e-4) return next;
  return search((x) => zOf(x, false), z, next ?? rough, min, max, up, 1.01);
}

/**
 * The track width (mm) that gives `z` (Ω; a pair: its differential impedance) for this
 * cross-section otherwise, or null if no width between `min` and `max` mm does.
 */
export function widthFor(z: number, sec: Omit<Section, 'w'>, min = 0.02, max = 20): number | null {
  const { h, er } = equivalent(sec);
  // (a pair: each track about as wide as a single track of half the impedance would be, a bit narrower)
  const start = guessWidth(sec.s !== undefined ? z / 2 : z, h, er, sec.t) * (sec.g !== undefined || sec.s !== undefined ? 0.8 : 1);
  return find((w, draft) => line({ ...sec, w }, draft).z, z, start, min, max, false);
}

/** The gap between a pair's tracks (mm) that gives the differential impedance `z` (Ω) with the tracks this wide, or null. */
export function gapFor(z: number, sec: Omit<Section, 's'>, min = 0.02, max = 10): number | null {
  return find((s, draft) => line({ ...sec, s }, draft).z, z, Math.max(min, sec.w), min, max, true);
}

/** The gap to the coplanar ground (mm) that gives `z` (Ω) with the track this wide, or null (the ground too far to matter). */
export function sideGapFor(z: number, sec: Omit<Section, 'g'>, min = 0.02, max = 5): number | null {
  return find((g, draft) => line({ ...sec, g }, draft).z, z, Math.max(min, sec.w / 2), min, max, true);
}
