/**
 * Production files read back, for the Gerber viewer: Gerber RS-274X (X2 attributes, macros, arcs,
 * regions, polarity, step and repeat, aperture blocks) and Excellon drill files, as filled shapes
 * in mm in the files' own coordinates (x right, y up). Each file's layer is told from its own
 * attributes, else from its content or its name; and the set says what a fab house looks at
 * first: the board's size, the copper layers, the holes per drill, the smallest drill and track.
 */

/** x0, y0, x1, y1 (mm). */
export type Box = [number, number, number, number];

/** A path from (x, y): each segment a straight line to its end, or an arc round its centre. An arc that ends where it starts is a whole circle. */
export interface Path {
  x: number;
  y: number;
  segs: PathSeg[];
}
export interface PathSeg {
  x: number;
  y: number;
  arc?: { cx: number; cy: number; ccw: boolean };
}

/**
 * What an object covers. fill: closed contours, filled non-zero (outer ones counter-clockwise,
 * holes clockwise); circle: a disc; stroke: the path drawn with a round pen `w` wide.
 */
export type FabShape = { k: 'fill'; contours: Path[] } | { k: 'circle'; x: number; y: number; r: number } | { k: 'stroke'; path: Path; w: number };

/** A part of an object; one that is off (a macro primitive's exposure off) cuts the parts before it, of this object only. */
export interface FabPart {
  shape: FabShape;
  off?: boolean;
}

/** One graphics object of a file, in the order the file draws them. */
export interface FabObject {
  /** Dark adds to the image; clear (LPC) erases what the file drew before it. */
  dark: boolean;
  /** draw: a track or arc (D01, a slot), flash: a pad (D03) or a drill hit, region: a filled contour (G36). */
  kind: 'draw' | 'flash' | 'region';
  parts: FabPart[];
  box: Box;
  /** A draw's width where it is a track (not drawn with an aperture X2 calls a non-conductor), mm. */
  track?: number;
}

/** A drill hit: a hole, or a slot routed along `slot` (from x, y). */
export interface DrillHit {
  x: number;
  y: number;
  d: number;
  plated?: boolean;
  slot?: Path;
}

export interface GerberRead {
  objects: FabObject[];
  /** The file's X2 attributes (TF), by name: FileFunction → ['Copper', 'L1', 'Top']. */
  attributes: Record<string, string[]>;
  /** What was read with a caveat or not at all (deprecated or unknown commands). */
  notes: string[];
}

export interface ExcellonRead extends GerberRead {
  holes: DrillHit[];
  /** The file says it holds plated holes (true), non-plated ones (false), or does not say. */
  plated?: boolean;
}

const TAU = 2 * Math.PI;
const EPS = 1e-9;
const same = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) < EPS && Math.abs(ay - by) < EPS;

/* geometry */

/** x' = a x + b y + e, y' = c x + d y + f. */
type Mat = [number, number, number, number, number, number];
const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[1] * y + m[4], m[2] * x + m[3] * y + m[5]];
/** n first, then m. */
const compose = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[0] * n[4] + m[1] * n[5] + m[4],
  m[2] * n[4] + m[3] * n[5] + m[5],
];
const rotation = (deg: number): Mat => {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  return [c, -s, s, c, 0, 0];
};
const scaling = (s: number): Mat => [s, 0, 0, s, 0, 0];
const translation = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** The start angle, end angle and radius of an arc from (x0, y0); a whole circle ends a turn on. */
export function arcAngles(x0: number, y0: number, s: PathSeg & { arc: NonNullable<PathSeg['arc']> }): { r: number; a0: number; a1: number } {
  const { cx, cy, ccw } = s.arc;
  const a0 = Math.atan2(y0 - cy, x0 - cx);
  const a1 = same(x0, y0, s.x, s.y) ? a0 + (ccw ? TAU : -TAU) : Math.atan2(s.y - cy, s.x - cx);
  return { r: Math.hypot(x0 - cx, y0 - cy), a0, a1 };
}

/** How far an arc turns, radians (positive). */
function sweep(a0: number, a1: number, ccw: boolean): number {
  if (Math.abs(a1 - a0) >= TAU - EPS) return TAU;
  const d = (((ccw ? a1 - a0 : a0 - a1) % TAU) + TAU) % TAU;
  return d < EPS ? TAU : d;
}

function grow(b: Box, x: number, y: number, m = 0) {
  if (x - m < b[0]) b[0] = x - m;
  if (y - m < b[1]) b[1] = y - m;
  if (x + m > b[2]) b[2] = x + m;
  if (y + m > b[3]) b[3] = y + m;
}
const emptyBox = (): Box => [Infinity, Infinity, -Infinity, -Infinity];

/** Grow `b` by a path (its arcs' bulges too), `m` round it. */
function pathBox(b: Box, p: Path, m = 0) {
  grow(b, p.x, p.y, m);
  let [x, y] = [p.x, p.y];
  for (const s of p.segs) {
    if (s.arc) {
      const { r, a0, a1 } = arcAngles(x, y, s as Parameters<typeof arcAngles>[2]);
      const turn = sweep(a0, a1, s.arc.ccw);
      for (let k = 0; k < 4; k++) {
        const ang = (k * Math.PI) / 2;
        const d = ((((s.arc.ccw ? ang - a0 : a0 - ang) % TAU) + TAU) % TAU);
        if (d <= turn + EPS) grow(b, s.arc.cx + r * Math.cos(ang), s.arc.cy + r * Math.sin(ang), m);
      }
    }
    grow(b, s.x, s.y, m);
    [x, y] = [s.x, s.y];
  }
}

function shapeBox(b: Box, s: FabShape) {
  if (s.k === 'circle') grow(b, s.x, s.y, s.r);
  else if (s.k === 'stroke') pathBox(b, s.path, s.w / 2);
  else for (const c of s.contours) pathBox(b, c);
}

function partsBox(parts: FabPart[]): Box {
  const b = emptyBox();
  for (const p of parts) if (!p.off) shapeBox(b, p.shape);
  return b;
}

/** The signed area a closed path encloses (counter-clockwise positive), its arcs' segments included. */
function area(p: Path): number {
  let a = 0;
  let [x, y] = [p.x, p.y];
  for (const s of p.segs) {
    a += (x * s.y - s.x * y) / 2;
    if (s.arc) {
      const { r, a0, a1 } = arcAngles(x, y, s as Parameters<typeof arcAngles>[2]);
      const t = sweep(a0, a1, s.arc.ccw);
      a += ((s.arc.ccw ? 1 : -1) * r * r * (t - Math.sin(t))) / 2;
    }
    [x, y] = [s.x, s.y];
  }
  return a;
}

/** The same path the other way round. */
function reversed(p: Path): Path {
  const pts = [{ x: p.x, y: p.y }, ...p.segs];
  const segs: PathSeg[] = [];
  for (let i = pts.length - 1; i > 0; i--) {
    const s = p.segs[i - 1]!;
    const to = pts[i - 1]!;
    segs.push(s.arc ? { x: to.x, y: to.y, arc: { ...s.arc, ccw: !s.arc.ccw } } : { x: to.x, y: to.y });
  }
  const end = pts[pts.length - 1]!;
  return { x: end.x, y: end.y, segs };
}

/** Counter-clockwise (an outer contour), or with `hole` clockwise. */
const oriented = (p: Path, hole = false) => ((area(p) < 0) !== hole ? reversed(p) : p);

function movePath(p: Path, m: Mat, flip: boolean): Path {
  const [x, y] = apply(m, p.x, p.y);
  return {
    x,
    y,
    segs: p.segs.map((s) => {
      const [sx, sy] = apply(m, s.x, s.y);
      if (!s.arc) return { x: sx, y: sy };
      const [cx, cy] = apply(m, s.arc.cx, s.arc.cy);
      return { x: sx, y: sy, arc: { cx, cy, ccw: s.arc.ccw !== flip } };
    }),
  };
}

function moveShape(s: FabShape, m: Mat): FabShape {
  const det = m[0] * m[3] - m[1] * m[2];
  const k = Math.sqrt(Math.abs(det));
  const flip = det < 0;
  if (s.k === 'circle') {
    const [x, y] = apply(m, s.x, s.y);
    return { k: 'circle', x, y, r: s.r * k };
  }
  if (s.k === 'stroke') return { k: 'stroke', path: movePath(s.path, m, flip), w: s.w * k };
  // a mirror turns every contour the other way: turned back, outer ones stay counter-clockwise
  return { k: 'fill', contours: s.contours.map((c) => (flip ? reversed(movePath(c, m, true)) : movePath(c, m, false))) };
}

function moveObject(o: FabObject, m: Mat, toggle: boolean): FabObject {
  const parts = o.parts.map((p) => ({ ...p, shape: moveShape(p.shape, m) }));
  const k = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  return { ...o, dark: toggle ? !o.dark : o.dark, parts, box: partsBox(parts), ...(o.track !== undefined ? { track: o.track * k } : {}) };
}

/** A closed polygon of straight sides (flat x, y list), counter-clockwise. */
function polygon(pts: number[]): Path {
  const segs: PathSeg[] = [];
  for (let i = 2; i + 1 < pts.length; i += 2) segs.push({ x: pts[i]!, y: pts[i + 1]! });
  if (!same(pts[0]!, pts[1]!, pts.at(-2)!, pts.at(-1)!)) segs.push({ x: pts[0]!, y: pts[1]! });
  return oriented({ x: pts[0]!, y: pts[1]!, segs });
}

const circlePath = (x: number, y: number, r: number, ccw = true): Path => ({ x: x + r, y, segs: [{ x: x + r, y, arc: { cx: x, cy: y, ccw } }] });
const rect = (cx: number, cy: number, w: number, h: number) => [cx - w / 2, cy - h / 2, cx + w / 2, cy - h / 2, cx + w / 2, cy + h / 2, cx - w / 2, cy + h / 2];
const fill = (...contours: Path[]): FabShape => ({ k: 'fill', contours });

/** An oval w × h centred on 0, 0: two half circles joined by straight sides. */
function obround(w: number, h: number): FabShape {
  if (Math.abs(w - h) < EPS) return { k: 'circle', x: 0, y: 0, r: w / 2 };
  if (w > h) {
    const [a, r] = [(w - h) / 2, h / 2];
    return fill({ x: -a, y: -r, segs: [{ x: a, y: -r }, { x: a, y: r, arc: { cx: a, cy: 0, ccw: true } }, { x: -a, y: r }, { x: -a, y: -r, arc: { cx: -a, cy: 0, ccw: true } }] });
  }
  const [a, r] = [(h - w) / 2, w / 2];
  return fill({ x: r, y: -a, segs: [{ x: r, y: a }, { x: -r, y: a, arc: { cx: 0, cy: a, ccw: true } }, { x: -r, y: -a }, { x: r, y: -a, arc: { cx: 0, cy: -a, ccw: true } }] });
}

/** A regular polygon: `n` corners on a circle of diameter d, the first at `deg`. */
function regular(cx: number, cy: number, d: number, n: number, deg: number): Path {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((deg + (360 * i) / n) * Math.PI) / 180;
    pts.push(cx + (d / 2) * Math.cos(a), cy + (d / 2) * Math.sin(a));
  }
  return polygon(pts);
}

/** A standard aperture's round hole (transparent: it does not erase what is under the flash). */
function withHole(s: FabShape, hole: number): FabShape {
  if (!(hole > 0)) return s;
  const outer = s.k === 'circle' ? [circlePath(s.x, s.y, s.r)] : s.k === 'fill' ? s.contours : [];
  return fill(...outer, circlePath(0, 0, hole / 2, false));
}

/** The convex hull of some points (flat x, y list), counter-clockwise. */
function hull(pts: number[]): number[] {
  const ps = [];
  for (let i = 0; i + 1 < pts.length; i += 2) ps.push([pts[i]!, pts[i + 1]!] as const);
  ps.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: readonly number[], a: readonly number[], b: readonly number[]) => (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const lower: (readonly [number, number])[] = [];
  for (const p of ps) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: (readonly [number, number])[] = [];
  for (const p of ps.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].flat();
}

/* macros */

/** A macro's arithmetic: numbers, $n, + − x / and brackets. */
function evaluate(expr: string, vars: number[]): number {
  const s = expr.replace(/\s+/g, '');
  let i = 0;
  const NUM = /\d*\.?\d+(?:[eE][+-]?\d+)?|\d+\./y;
  const primary = (): number => {
    const c = s[i];
    if (c === '(') {
      i++;
      const v = sum();
      if (s[i] === ')') i++;
      return v;
    }
    if (c === '-') return i++, -primary();
    if (c === '+') return i++, primary();
    if (c === '$') {
      i++;
      const m = /\d+/y;
      m.lastIndex = i;
      const k = m.exec(s)?.[0] ?? '0';
      i += k.length;
      return vars[Number(k)] ?? 0;
    }
    NUM.lastIndex = i;
    const m = NUM.exec(s);
    if (!m) throw new Error(`cannot read "${expr}"`);
    i += m[0].length;
    return Number(m[0]);
  };
  const product = (): number => {
    let v = primary();
    while (s[i] === 'x' || s[i] === 'X' || s[i] === '/') {
      const op = s[i++];
      const w = primary();
      v = op === '/' ? v / w : v * w;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (s[i] === '+' || s[i] === '-') {
      const op = s[i++];
      const w = product();
      v = op === '+' ? v + w : v - w;
    }
    return v;
  };
  const v = sum();
  if (i < s.length) throw new Error(`cannot read "${expr}"`);
  return v;
}

/** The thermal primitive: a ring cut by a cross of gaps, four pieces. */
function thermal(cx: number, cy: number, outer: number, inner: number, gap: number): Path[] {
  const [ro, ri, g] = [outer / 2, inner / 2, gap / 2];
  if (ro <= g) return [];
  const out: Path[] = [];
  const xo = Math.sqrt(ro * ro - g * g);
  for (let q = 0; q < 4; q++) {
    // the first quadrant's piece, turned by q quarters
    const turn = (x: number, y: number): [number, number] => {
      const [c, s] = [Math.round(Math.cos((q * Math.PI) / 2)), Math.round(Math.sin((q * Math.PI) / 2))];
      return [cx + c * x - s * y, cy + s * x + c * y];
    };
    const [sx, sy] = turn(xo, g);
    const [ex, ey] = turn(g, xo);
    const [ox, oy] = turn(0, 0);
    const segs: PathSeg[] = [{ x: ex, y: ey, arc: { cx: ox, cy: oy, ccw: true } }];
    if (ri > g) {
      const xi = Math.sqrt(ri * ri - g * g);
      const [ax, ay] = turn(g, xi);
      const [bx, by] = turn(xi, g);
      segs.push({ x: ax, y: ay }, { x: bx, y: by, arc: { cx: ox, cy: oy, ccw: false } });
    } else {
      const [ax, ay] = turn(g, g);
      segs.push({ x: ax, y: ay });
    }
    segs.push({ x: sx, y: sy });
    out.push({ x: sx, y: sy, segs });
  }
  return out;
}

/** A macro aperture's parts for its parameters, in the file's units. */
function macroParts(body: string[], params: number[], notes: Set<string>): FabPart[] {
  const vars = [0, ...params];
  const out: FabPart[] = [];
  for (const st of body) {
    if (!st || /^0(\D|$)/.test(st)) continue; // a comment
    try {
      if (st.startsWith('$')) {
        const [k, e] = st.split('=');
        vars[Number(k!.slice(1))] = evaluate(e ?? '0', vars);
        continue;
      }
      const f = st.split(',');
      const code = Number(f[0]);
      const v = f.slice(1).map((e) => evaluate(e, vars));
      const at = (i: number) => v[i] ?? 0;
      // exposure, first but for the moiré and the thermal: 0 off, 1 on (2, a toggle in old files, read as on)
      const off = code !== 6 && code !== 7 && at(0) === 0;
      if (code !== 6 && code !== 7 && at(0) === 2) notes.add('a macro primitive with exposure 2 (toggle): read as on');
      const turned = (s: FabShape, deg: number): FabPart => ({ shape: deg ? moveShape(s, rotation(deg)) : s, ...(off ? { off } : {}) });
      switch (code) {
        case 1:
          out.push(turned({ k: 'circle', x: at(2), y: at(3), r: at(1) / 2 }, at(4)));
          break;
        case 2:
        case 20: {
          const [w, x1, y1, x2, y2] = [at(1), at(2), at(3), at(4), at(5)];
          const len = Math.hypot(x2 - x1, y2 - y1);
          if (len < EPS || w <= 0) break;
          const [nx, ny] = [(-(y2 - y1) / len) * (w / 2), ((x2 - x1) / len) * (w / 2)];
          out.push(turned(fill(polygon([x1 - nx, y1 - ny, x2 - nx, y2 - ny, x2 + nx, y2 + ny, x1 + nx, y1 + ny])), at(6)));
          break;
        }
        case 21:
          if (at(1) > 0 && at(2) > 0) out.push(turned(fill(polygon(rect(at(3), at(4), at(1), at(2)))), at(5)));
          break;
        case 22:
          if (at(1) > 0 && at(2) > 0) out.push(turned(fill(polygon(rect(at(3) + at(1) / 2, at(4) + at(2) / 2, at(1), at(2)))), at(5)));
          break;
        case 4: {
          const n = Math.round(at(1));
          const pts = v.slice(2, 2 + 2 * (n + 1));
          if (pts.length >= 6) out.push(turned(fill(polygon(pts)), at(2 + 2 * (n + 1))));
          break;
        }
        case 5:
          out.push(turned(fill(regular(at(2), at(3), at(4), Math.max(3, Math.round(at(1))), 0)), at(5)));
          break;
        case 6: {
          // moiré (old files): rings and a cross hair, all on
          const [cx, cy, d, ring, gap, max, cw, cl, rot] = [at(0), at(1), at(2), at(3), at(4), Math.round(at(5)), at(6), at(7), at(8)];
          for (let k = 0, r = d / 2; k < max && r > 0; k++, r -= ring + gap) {
            out.push({ shape: moveShape(r - ring > 0 ? fill(circlePath(cx, cy, r), circlePath(cx, cy, r - ring, false)) : { k: 'circle', x: cx, y: cy, r }, rotation(rot)) });
          }
          if (cw > 0 && cl > 0) for (const [w, h] of [[cl, cw], [cw, cl]] as const) out.push({ shape: moveShape(fill(polygon(rect(cx, cy, w, h))), rotation(rot)) });
          break;
        }
        case 7: {
          const pieces = thermal(at(0), at(1), at(2), at(3), at(4));
          if (pieces.length) out.push({ shape: moveShape(fill(...pieces), rotation(at(5))) });
          break;
        }
        default:
          notes.add(`a macro primitive ${code} this viewer does not know`);
      }
    } catch (e) {
      notes.add(`a macro that could not be read (${(e as Error).message})`);
    }
  }
  return out;
}

/* Gerber */

interface Aperture {
  /** A flash at 0, 0, mm. */
  parts: FabPart[];
  /** A circle's diameter: a draw with it is a round stroke. */
  round?: number;
  /** A rectangle: a draw sweeps it. */
  rect?: [number, number];
  /** A block aperture's objects (AB). */
  block?: FabObject[];
  /** X2 says what it draws is no conductor (an outline, a marking on a copper layer). */
  nonConductor?: boolean;
}

const DATA = /^(?:G0*(\d+))?(?:X([+-]?[\d.]+))?(?:Y([+-]?[\d.]+))?(?:I([+-]?[\d.]+))?(?:J([+-]?[\d.]+))?(?:D0*(\d+))?$/;

/** Read a Gerber file (RS-274X; X2 attributes in attribute commands or in G04 comments). */
export function readGerber(src: string): GerberRead {
  const notes = new Set<string>();
  const attributes: Record<string, string[]> = {};
  const apAttrs: Record<string, string[]> = {};
  const apertures = new Map<number, Aperture>();
  const macros = new Map<string, string[]>();
  let unit = 1;
  let unitKnown = false;
  let [int, dec, omitTrailing, incremental] = [3, 6, false, false];
  let formatKnown = false;
  let [x, y] = [0, 0];
  let interp: 'line' | 'cw' | 'ccw' = 'line';
  let multi = true;
  let dark = true;
  let ap: Aperture | undefined;
  let lastOp = 0;
  let apMat: Mat = IDENTITY;
  let [mirror, turn, scale] = ['N', 0, 1];
  const offset = [0, 0];
  let region: { contours: Path[]; cur: Path | null } | null = null;
  let repeat: { nx: number; ny: number; dx: number; dy: number; from: number } | null = null;
  const blocks: { d: number; outer: FabObject[] }[] = [];
  let objects: FabObject[] = [];

  const updateApMat = () => {
    const m: Mat = mirror === 'X' ? [-1, 0, 0, 1, 0, 0] : mirror === 'Y' ? [1, 0, 0, -1, 0, 0] : mirror === 'XY' ? [-1, 0, 0, -1, 0, 0] : IDENTITY;
    apMat = compose(scaling(scale), compose(rotation(turn), m));
  };
  const coord = (s: string): number => {
    if (!formatKnown) {
      notes.add('no format statement (FS): 3.6 digits assumed');
      formatKnown = true;
    }
    let v: number;
    if (s.includes('.')) v = Number(s);
    else if (omitTrailing) {
      const neg = s.startsWith('-');
      v = (Number(s.replace(/^[+-]/, '').padEnd(int + dec, '0')) / 10 ** dec) * (neg ? -1 : 1);
    } else v = Number(s) / 10 ** dec;
    return v * unit;
  };
  const push = (o: FabObject) => {
    if (o.box[0] <= o.box[2]) objects.push(o);
  };

  function closeContour() {
    const c = region!.cur;
    region!.cur = null;
    if (!c?.segs.length) return;
    const last = c.segs.at(-1)!;
    if (!same(last.x, last.y, c.x, c.y)) c.segs.push({ x: c.x, y: c.y });
    region!.contours.push(c);
  }
  function endRegion() {
    if (!region) return;
    closeContour();
    for (const c of region.contours) {
      const parts = [{ shape: fill(oriented(c)) }];
      push({ dark, kind: 'region', parts, box: partsBox(parts) });
    }
    region = null;
  }
  function endRepeat() {
    if (!repeat) return;
    const block = objects.slice(repeat.from);
    for (let j = 0; j < repeat.ny; j++) {
      for (let i = 0; i < repeat.nx; i++) {
        if (!i && !j) continue;
        const m = translation(i * repeat.dx, j * repeat.dy);
        for (const o of block) objects.push(moveObject(o, m, false));
      }
    }
    repeat = null;
  }

  function arcCentre(x1: number, y1: number, i: number, j: number, ccw: boolean) {
    if (multi) return { cx: x + i, cy: y + j, ccw };
    // single quadrant (old files): I and J are distances; the centre is the one of the four that
    // gives an arc of at most 90° ending at the same radius
    let best = { cx: x + i, cy: y + j };
    let err = Infinity;
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const [cx, cy] = [x + sx * Math.abs(i), y + sy * Math.abs(j)];
      const t = sweep(Math.atan2(y - cy, x - cx), Math.atan2(y1 - cy, x1 - cx), ccw);
      const e = Math.abs(Math.hypot(x - cx, y - cy) - Math.hypot(x1 - cx, y1 - cy));
      if (t <= Math.PI / 2 + 1e-6 && e < err) [best, err] = [{ cx, cy }, e];
    }
    return { ...best, ccw };
  }

  function interpolate(x1: number, y1: number, i: number, j: number) {
    // an arc from a point to itself is a whole circle, except in single-quadrant mode
    const seg: PathSeg = interp === 'line' || (!multi && same(x, y, x1, y1)) ? { x: x1, y: y1 } : { x: x1, y: y1, arc: arcCentre(x1, y1, i, j, interp === 'ccw') };
    if (region) {
      region.cur ??= { x, y, segs: [] };
      region.cur.segs.push(seg);
      return;
    }
    if (!ap) return notes.add('a draw before any aperture was chosen');
    if (ap.block) return notes.add('a draw with a block aperture');
    if (ap.rect && !seg.arc) {
      // a rectangle swept along a line: the hull of the rectangle at both ends
      const [w, h] = [ap.rect[0] * scale, ap.rect[1] * scale];
      const parts = [{ shape: fill(polygon(hull([...rect(x, y, w, h), ...rect(x1, y1, w, h)]))) }];
      return push({ dark, kind: 'draw', parts, box: partsBox(parts) });
    }
    let w = ap.round;
    if (w === undefined) {
      notes.add('a draw with an aperture that is not a circle: drawn round, as wide as the aperture');
      const b = partsBox(ap.parts);
      w = b[0] <= b[2] ? Math.min(b[2] - b[0], b[3] - b[1]) : 0;
    }
    w *= scale;
    // a draw of no length is a dot
    const shape: FabShape = !seg.arc && same(x, y, x1, y1) ? { k: 'circle', x, y, r: w / 2 } : { k: 'stroke', path: { x, y, segs: [seg] }, w };
    const parts = [{ shape }];
    const box = partsBox(parts);
    if (box[0] > box[2]) grow(box, x, y); // a zero-width line still shows where it is
    push({ dark, kind: 'draw', parts, box, ...(ap.nonConductor ? {} : { track: w }) });
  }

  function flash(x1: number, y1: number) {
    if (region) return notes.add('a flash inside a region');
    if (!ap) return notes.add('a flash before any aperture was chosen');
    const m = compose(translation(x1, y1), apMat);
    if (ap.block) {
      // a block flashed in clear polarity turns its objects' polarities round
      for (const o of ap.block) push(moveObject(o, m, !dark));
      return;
    }
    if (!ap.parts.length) return;
    const parts = ap.parts.map((p) => ({ ...p, shape: moveShape(p.shape, m) }));
    push({ dark, kind: 'flash', parts, box: partsBox(parts) });
  }

  function attribute(cmd: string) {
    const [name, ...values] = cmd.slice(3).split(',');
    if (cmd.startsWith('TF.')) attributes[name!] = values;
    else if (cmd.startsWith('TA.')) apAttrs[name!] = values;
    else if (cmd.startsWith('TD')) {
      const k = cmd.slice(2).replace(/^\./, '');
      if (k) delete apAttrs[k];
      else for (const key of Object.keys(apAttrs)) delete apAttrs[key];
    }
  }

  function defineAperture(cmd: string) {
    const m = /^ADD0*(\d+)([^,]+)(?:,(.*))?$/.exec(cmd);
    if (!m) return notes.add(`an aperture that could not be read: ${cmd.slice(0, 30)}`);
    const d = Number(m[1]);
    const name = m[2]!;
    const p = (m[3] ?? '').split('X').filter((s) => s !== '').map(Number);
    const u = (k: number) => (p[k] ?? 0) * unit;
    let a: Aperture;
    if (name === 'C') a = { parts: u(0) > 0 ? [{ shape: withHole({ k: 'circle', x: 0, y: 0, r: u(0) / 2 }, u(1)) }] : [], round: u(0) };
    else if (name === 'R') a = { parts: u(0) > 0 && u(1) > 0 ? [{ shape: withHole(fill(polygon(rect(0, 0, u(0), u(1)))), u(2)) }] : [], rect: [u(0), u(1)] };
    else if (name === 'O') a = { parts: u(0) > 0 && u(1) > 0 ? [{ shape: withHole(obround(u(0), u(1)), u(2)) }] : [] };
    else if (name === 'P') a = { parts: u(0) > 0 ? [{ shape: withHole(fill(regular(0, 0, u(0), Math.max(3, Math.round(p[1] ?? 3)), p[2] ?? 0)), u(3)) }] : [] };
    else {
      const body = macros.get(name);
      if (!body) notes.add(`aperture D${d} uses a macro that is not defined (${name})`);
      a = { parts: body ? macroParts(body, p, notes).map((q) => ({ ...q, shape: moveShape(q.shape, scaling(unit)) })) : [] };
    }
    const fn = apAttrs['AperFunction']?.[0];
    if (fn && fn !== 'Conductor') a.nonConductor = true;
    apertures.set(d, a);
  }

  function extended(cmd: string) {
    const code = cmd.slice(0, 2);
    switch (code) {
      case 'FS': {
        const m = /^FS([LTD])?([AI])?.*?X(\d)(\d)Y(\d)(\d)/.exec(cmd);
        if (!m) return notes.add(`a format statement that could not be read: ${cmd}`);
        omitTrailing = m[1] === 'T';
        incremental = m[2] === 'I';
        [int, dec] = [Number(m[3]), Number(m[4])];
        formatKnown = true;
        if (omitTrailing) notes.add('trailing zeros omitted (deprecated)');
        if (incremental) notes.add('incremental coordinates (deprecated)');
        return;
      }
      case 'MO':
        unit = cmd.startsWith('MOIN') ? 25.4 : 1;
        unitKnown = true;
        return;
      case 'AD':
        return defineAperture(cmd);
      case 'LP':
        dark = cmd[2] !== 'C';
        return;
      case 'LM':
        mirror = cmd.slice(2) || 'N';
        return updateApMat();
      case 'LR':
        turn = Number(cmd.slice(2)) || 0;
        return updateApMat();
      case 'LS':
        scale = Number(cmd.slice(2)) || 1;
        return updateApMat();
      case 'SR': {
        endRepeat();
        const m = /^SRX(\d+)Y(\d+)I([+-]?[\d.]+)J([+-]?[\d.]+)/.exec(cmd);
        if (m && (Number(m[1]) > 1 || Number(m[2]) > 1)) repeat = { nx: Number(m[1]), ny: Number(m[2]), dx: Number(m[3]) * unit, dy: Number(m[4]) * unit, from: objects.length };
        return;
      }
      case 'AB': {
        const m = /^ABD0*(\d+)/.exec(cmd);
        if (m) {
          blocks.push({ d: Number(m[1]), outer: objects });
          objects = [];
        } else {
          const b = blocks.pop();
          if (!b) return notes.add('an aperture block closed that was not opened');
          apertures.set(b.d, { parts: [], block: objects });
          objects = b.outer;
        }
        return;
      }
      case 'TF':
      case 'TA':
      case 'TD':
      case 'TO':
        return attribute(cmd);
      case 'IP':
        if (cmd === 'IPNEG') notes.add('a negative image (IPNEG, deprecated): shown as drawn');
        return;
      case 'OF': {
        const m = /^OF(?:A([+-]?[\d.]+))?(?:B([+-]?[\d.]+))?/.exec(cmd);
        offset[0] = Number(m?.[1] ?? 0) * unit;
        offset[1] = Number(m?.[2] ?? 0) * unit;
        if (offset[0] || offset[1]) notes.add('an image offset (OF, deprecated)');
        return;
      }
      case 'IN':
      case 'LN':
      case 'AS':
        return;
      case 'IR':
      case 'MI':
      case 'SF':
        if (!/^(IR0|MIA0B0|SFA1B1|SFA1\.0+B1\.0+)$/.test(cmd)) notes.add(`${code} (deprecated) is not applied`);
        return;
      default:
        notes.add(`an unknown command %${cmd.slice(0, 20)}%`);
    }
  }

  /** One word command; false at the end of the file. */
  function data(cmd: string): boolean {
    if (cmd.startsWith('G04') || cmd === 'G4' || cmd.startsWith('G4 ')) {
      // X2 attributes written as comments (older KiCad)
      const m = /^G0?4\s*#@!\s*(T[FAOD].*)$/.exec(cmd);
      if (m) attribute(m[1]!.trim());
      return true;
    }
    if (/^M0*[02]$/.test(cmd)) return false;
    if (cmd === 'M01' || cmd === 'M1') return true;
    const m = DATA.exec(cmd);
    if (!m) {
      notes.add(`an unknown command ${cmd.slice(0, 20)}`);
      return true;
    }
    const [, g, xs, ys, is, js, ds] = m;
    if (g !== undefined) {
      switch (Number(g)) {
        case 1:
          interp = 'line';
          break;
        case 2:
          interp = 'cw';
          break;
        case 3:
          interp = 'ccw';
          break;
        case 36:
          endRegion();
          region = { contours: [], cur: null };
          break;
        case 37:
          endRegion();
          break;
        case 74:
          multi = false;
          break;
        case 75:
          multi = true;
          break;
        case 70:
          if (!unitKnown) unit = 25.4;
          break;
        case 71:
          if (!unitKnown) unit = 1;
          break;
        case 90:
          incremental = false;
          break;
        case 91:
          incremental = true;
          break;
        case 54:
        case 55:
          break; // (old aperture select and flash prefix)
        default:
          notes.add(`G${g} is not known`);
      }
    }
    let op = 0;
    if (ds !== undefined) {
      const d = Number(ds);
      if (d >= 10) {
        ap = apertures.get(d);
        if (!ap) notes.add(`aperture D${d} is used but not defined`);
        return true;
      }
      op = d;
    }
    const coords = xs !== undefined || ys !== undefined || is !== undefined || js !== undefined;
    if (!op && coords) {
      // coordinates without an operation: the one before (deprecated)
      op = lastOp;
      if (!op) return true;
      notes.add('coordinates without D01/D02/D03 (deprecated): taken as the operation before');
    }
    if (!op) return true;
    lastOp = op;
    const x1 = xs === undefined ? x : incremental ? x + coord(xs) : coord(xs) + offset[0]!;
    const y1 = ys === undefined ? y : incremental ? y + coord(ys) : coord(ys) + offset[1]!;
    if (op === 1) interpolate(x1, y1, is === undefined ? 0 : coord(is), js === undefined ? 0 : coord(js));
    else if (op === 2) {
      if (region) closeContour();
    } else if (op === 3) flash(x1, y1);
    else notes.add(`D0${op} is not an operation`);
    [x, y] = [x1, y1];
    return true;
  }

  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '%') {
      const end = src.indexOf('%', i + 1);
      if (end < 0) break;
      const block = src.slice(i + 1, end).replace(/[\r\n]+/g, '');
      i = end + 1;
      if (block.startsWith('AM')) {
        const [head, ...body] = block.split('*');
        macros.set(head!.slice(2), body.map((s) => s.trim()));
        continue;
      }
      for (const part of block.split('*')) {
        const p = part.trim();
        if (p) extended(p);
      }
      continue;
    }
    if (c === '\n' || c === '\r' || c === ' ' || c === '\t') {
      i++;
      continue;
    }
    let end = src.indexOf('*', i);
    if (end < 0) end = n;
    const word = src.slice(i, end).replace(/[\r\n]+/g, '').trim();
    i = end + 1;
    if (word && !data(word)) break;
  }
  endRegion();
  endRepeat();
  if (!unitKnown && objects.length) notes.add('no unit statement (MO): millimetres assumed');
  return { objects, attributes, notes: [...notes] };
}

/* Excellon */

/** Read an Excellon drill file: holes, slots (G85) and routed holes (G00 … M15 G01 … M16), in mm. */
export function readExcellon(src: string): ExcellonRead {
  const notes = new Set<string>();
  const attributes: Record<string, string[]> = {};
  let unit = 25.4;
  let unitKnown = false;
  let [int, dec, keepLeading] = [2, 4, false];
  let formatKnown = false;
  const tools = new Map<number, { d: number; plated?: boolean }>();
  let tool: { d: number; plated?: boolean } | undefined;
  let [x, y] = [0, 0];
  let incremental = false;
  let plated: boolean | undefined;
  let nextPlated: boolean | undefined;
  let rout = false;
  let down: Path | null = null;
  let routMode: 'line' | 'cw' | 'ccw' = 'line';
  const holes: DrillHit[] = [];

  const num = (s: string): number => {
    if (s.includes('.')) return Number(s) * unit;
    const neg = s.startsWith('-');
    const digits = s.replace(/^[+-]/, '');
    // LZ keeps the leading zeros (the trailing ones are left out), TZ the trailing ones
    const v = keepLeading ? Number(digits.padEnd(int + dec, '0')) / 10 ** dec : Number(digits) / 10 ** dec;
    return (neg ? -v : v) * unit;
  };
  const setUnits = (line: string) => {
    unit = line.startsWith('METRIC') ? 1 : 25.4;
    unitKnown = true;
    if (!formatKnown) [int, dec] = unit === 1 ? [3, 3] : [2, 4];
    if (/,LZ/.test(line)) keepLeading = true;
    if (/,TZ/.test(line)) keepLeading = false;
    const f = /,(0+)\.(0+)/.exec(line);
    if (f) [int, dec, formatKnown] = [f[1]!.length, f[2]!.length, true];
  };
  const hit = (h: Omit<DrillHit, 'd' | 'plated'>) => {
    if (!tool) return notes.add('a hole before any tool was chosen');
    const p = tool.plated ?? plated;
    holes.push({ ...h, d: tool.d, ...(p !== undefined ? { plated: p } : {}) });
  };
  const endRout = () => {
    if (down?.segs.length) hit({ x: down.x, y: down.y, slot: down });
    down = null;
  };

  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(';')) {
      const c = line.slice(1).trim();
      const attr = /^#@!\s*(T[FA])\.(\w+),?(.*)$/.exec(c);
      if (attr) {
        const values = attr[3]!.split(',');
        if (attr[1] === 'TF') attributes[attr[2]!] = values;
        if (attr[2] === 'FileFunction' || attr[2] === 'AperFunction') {
          const p = values[0] === 'Plated' ? true : values[0] === 'NonPlated' ? false : undefined;
          if (attr[1] === 'TF') plated = p;
          else nextPlated = p;
        }
        continue;
      }
      const fmt = /FILE_FORMAT\s*=\s*(\d+):(\d+)/i.exec(c) ?? /FORMAT\s*=\s*\{(\d+):(\d+)/i.exec(c);
      if (fmt) [int, dec, formatKnown] = [Number(fmt[1]), Number(fmt[2]), true];
      if (/suppress trailing zeros/i.test(c)) keepLeading = true;
      if (/suppress leading zeros/i.test(c)) keepLeading = false;
      if (/TYPE\s*=\s*NON[_-]?PLATED/i.test(c)) nextPlated = false;
      else if (/TYPE\s*=\s*PLATED/i.test(c)) nextPlated = true;
      else if (/\bNON[-_ ]?PLATED\b/i.test(c)) plated ??= false;
      else if (/\bPLATED\b/i.test(c)) plated ??= true;
      continue;
    }
    if (line === 'M48' || line === '%' || line === 'M95') continue;
    if (/^(METRIC|INCH)\b/.test(line)) {
      setUnits(line);
      continue;
    }
    if (line === 'M71' || line === 'M72') {
      setUnits(line === 'M71' ? 'METRIC' : 'INCH');
      continue;
    }
    if (line === 'M30' || line === 'M00') break;
    if (/^(FMAT|VER|ICI|DETECT|ATC|BLKD|SBK|SG|TCST|RUNTIME|AFS|OSTOP|FSB|CCW|CP|M47|M97|M98|M25|M01|M02|M08|M09|G93)/.test(line)) continue;
    const t = /^T0*(\d+)(.*)$/.exec(line);
    if (t) {
      const k = Number(t[1]);
      const c = /C([+-]?[\d.]+)/.exec(t[2]!);
      if (c) {
        const p = nextPlated;
        tools.set(k, { d: (c[1]!.includes('.') ? Number(c[1]) : Number(c[1]) / 10 ** dec) * unit, ...(p !== undefined ? { plated: p } : {}) });
        nextPlated = undefined;
        tool = tools.get(k);
      } else {
        tool = tools.get(k);
        if (!tool && k !== 0) notes.add(`tool T${k} is used but has no size`);
      }
      continue;
    }
    if (line === 'G90') {
      incremental = false;
      continue;
    }
    if (line === 'G91') {
      incremental = true;
      continue;
    }
    if (line === 'G05' || line === 'G81') {
      endRout();
      rout = false;
      continue;
    }
    if (line === 'M15') {
      down = { x, y, segs: [] };
      continue;
    }
    if (line === 'M16' || line === 'M17') {
      endRout();
      continue;
    }
    const rep = /^R(\d+)(?:X([+-]?[\d.]+))?(?:Y([+-]?[\d.]+))?$/.exec(line);
    if (rep) {
      const [dx, dy] = [rep[2] ? num(rep[2]) : 0, rep[3] ? num(rep[3]) : 0];
      for (let k = 0; k < Number(rep[1]); k++) {
        [x, y] = [x + dx, y + dy];
        hit({ x, y });
      }
      continue;
    }
    const m = /^(?:G0*(\d+))?(?:X([+-]?[\d.]+))?(?:Y([+-]?[\d.]+))?(?:G85(?:X([+-]?[\d.]+))?(?:Y([+-]?[\d.]+))?)?(?:A([+-]?[\d.]+))?(?:I([+-]?[\d.]+))?(?:J([+-]?[\d.]+))?$/.exec(line);
    if (!m) {
      notes.add(`an unknown line ${line.slice(0, 20)}`);
      continue;
    }
    const [, g, xs, ys, x2s, y2s, as, is, js] = m;
    if (!unitKnown && (xs || ys)) {
      notes.add('no unit (METRIC or INCH): inches assumed');
      unitKnown = true;
    }
    const at = (s: string | undefined, from: number) => (s === undefined ? from : incremental ? from + num(s) : num(s));
    const [x1, y1] = [at(xs, x), at(ys, y)];
    if (g === '0') {
      endRout();
      rout = true;
      [x, y] = [x1, y1];
      continue;
    }
    if (g === '1' || g === '2' || g === '3') routMode = g === '1' ? 'line' : g === '2' ? 'cw' : 'ccw';
    if (x2s !== undefined || y2s !== undefined) {
      // G85: a slot from the first point to the second
      const [x2, y2] = [x2s === undefined ? x1 : num(x2s), y2s === undefined ? y1 : num(y2s)];
      hit({ x: x1, y: y1, slot: { x: x1, y: y1, segs: [{ x: x2, y: y2 }] } });
      [x, y] = [x2, y2];
      continue;
    }
    if (rout && down) {
      if (routMode === 'line') down.segs.push({ x: x1, y: y1 });
      else {
        const ccw = routMode === 'ccw';
        let c: { cx: number; cy: number };
        if (as !== undefined) {
          // a radius: the centre on the side the arc turns to (the shorter arc)
          const r = num(as);
          const [mx, my] = [(x + x1) / 2, (y + y1) / 2];
          const half = Math.hypot(x1 - x, y1 - y) / 2;
          const h = Math.sqrt(Math.max(0, r * r - half * half));
          const [ux, uy] = half > 0 ? [-(y1 - y) / (2 * half), (x1 - x) / (2 * half)] : [0, 0];
          c = { cx: mx + (ccw ? 1 : -1) * ux * h, cy: my + (ccw ? 1 : -1) * uy * h };
        } else c = { cx: x + (is ? num(is) : 0), cy: y + (js ? num(js) : 0) };
        down.segs.push({ x: x1, y: y1, arc: { ...c, ccw } });
      }
      [x, y] = [x1, y1];
      continue;
    }
    if (rout) {
      [x, y] = [x1, y1];
      continue;
    }
    if (xs !== undefined || ys !== undefined) hit({ x: x1, y: y1 });
    [x, y] = [x1, y1];
  }
  endRout();

  const objects: FabObject[] = holes.map((h) => {
    const parts: FabPart[] = [{ shape: h.slot ? { k: 'stroke', path: h.slot, w: h.d } : { k: 'circle', x: h.x, y: h.y, r: h.d / 2 } }];
    return { dark: true, kind: h.slot ? 'draw' : 'flash', parts, box: partsBox(parts) };
  });
  return { objects, attributes, notes: [...notes], holes, ...(plated !== undefined ? { plated } : {}) };
}

/* layers */

export type FabLayerKind = 'copper' | 'mask' | 'paste' | 'silk' | 'outline' | 'drill' | 'other';

export interface FabLayer {
  /** F.Cu, In1.Cu, B.Cu, F.Mask, B.Mask, F.Paste, B.Paste, F.Silkscreen, B.Silkscreen, Edge.Cuts, PTH, NPTH, Drill; other layers by their file. */
  id: string;
  /** In words: "top copper", "bottom solder mask", "board outline", "plated holes". */
  label: string;
  kind: FabLayerKind;
  side: 'top' | 'bottom' | 'inner' | null;
  /** Copper: its place in the stack (1 the top, inner ones by their number). */
  order?: number;
  /** Drill: plated holes, or not (undefined: it does not say). */
  plated?: boolean;
  /** How it was told: the file's own attribute (X2), its content (a drill file), its name, or not (a guess). */
  by: 'attribute' | 'content' | 'name' | 'guess';
}

type Told = Omit<FabLayer, 'id' | 'label' | 'by'>;

/** A layer from X2's FileFunction. */
function fromFunction(f: string[]): Told | null {
  const side = (s?: string) => (s === 'Top' ? 'top' : s === 'Bot' ? 'bottom' : s === 'Inr' ? 'inner' : null);
  switch (f[0]) {
    case 'Copper': {
      const order = Number(/^L(\d+)$/.exec(f[1] ?? '')?.[1]) || undefined;
      return { kind: 'copper', side: side(f[2]) ?? (order === 1 ? 'top' : 'inner'), ...(order ? { order } : {}) };
    }
    case 'Soldermask':
      return { kind: 'mask', side: side(f[1]) };
    case 'Paste':
      return { kind: 'paste', side: side(f[1]) };
    case 'Legend':
      return { kind: 'silk', side: side(f[1]) };
    case 'Profile':
      return { kind: 'outline', side: null };
    case 'Plated':
      return { kind: 'drill', side: null, plated: true };
    case 'NonPlated':
      return { kind: 'drill', side: null, plated: false };
    default:
      return f[0] ? { kind: 'other', side: side(f[1]) ?? side(f[2]) } : null;
  }
}

/** File names as KiCad, Altium/Protel, Eagle and EasyEDA write them. */
const NAMES: [RegExp, Told][] = [
  [/(^|[-_.])F[._]Cu\b/i, { kind: 'copper', side: 'top' }],
  [/(^|[-_.])B[._]Cu\b/i, { kind: 'copper', side: 'bottom' }],
  [/(^|[-_.])F[._]Mask\b/i, { kind: 'mask', side: 'top' }],
  [/(^|[-_.])B[._]Mask\b/i, { kind: 'mask', side: 'bottom' }],
  [/(^|[-_.])F[._]Paste\b/i, { kind: 'paste', side: 'top' }],
  [/(^|[-_.])B[._]Paste\b/i, { kind: 'paste', side: 'bottom' }],
  [/(^|[-_.])F[._]Silk(S|screen)?\b/i, { kind: 'silk', side: 'top' }],
  [/(^|[-_.])B[._]Silk(S|screen)?\b/i, { kind: 'silk', side: 'bottom' }],
  [/(^|[-_.])Edge[._]Cuts\b/i, { kind: 'outline', side: null }],
  [/\.gtl$/i, { kind: 'copper', side: 'top' }],
  [/\.gbl$/i, { kind: 'copper', side: 'bottom' }],
  [/\.gts$/i, { kind: 'mask', side: 'top' }],
  [/\.gbs$/i, { kind: 'mask', side: 'bottom' }],
  [/\.gtp$/i, { kind: 'paste', side: 'top' }],
  [/\.gbp$/i, { kind: 'paste', side: 'bottom' }],
  [/\.gto$/i, { kind: 'silk', side: 'top' }],
  [/\.gbo$/i, { kind: 'silk', side: 'bottom' }],
  [/\.(gko|gm1|gml|dim|mil|oln|bor)$/i, { kind: 'outline', side: null }],
  [/\.cmp$/i, { kind: 'copper', side: 'top' }],
  [/\.sol$/i, { kind: 'copper', side: 'bottom' }],
  [/\.stc$/i, { kind: 'mask', side: 'top' }],
  [/\.sts$/i, { kind: 'mask', side: 'bottom' }],
  [/\.crc$/i, { kind: 'paste', side: 'top' }],
  [/\.crs$/i, { kind: 'paste', side: 'bottom' }],
  [/\.plc$/i, { kind: 'silk', side: 'top' }],
  [/\.pls$/i, { kind: 'silk', side: 'bottom' }],
];

/** Words in a file name, for the names no tool's rule above covers ("copper_top.gbr", "Gerber_TopSolderMaskLayer.GTS"). */
function fromWords(name: string): Told | null {
  const n = name.toLowerCase().replace(/\.[^.]*$/, '');
  const kind: FabLayerKind | null = /paste|cream|stencil/.test(n)
    ? 'paste'
    : /mask|stop|resist/.test(n)
      ? 'mask'
      : /silk|legend|overlay/.test(n)
        ? 'silk'
        : /outline|edge|profile|dimension|contour|board_?shape|mill/.test(n)
          ? 'outline'
          : /copper|signal|(^|[^a-z])cu([^a-z]|$)|layer/.test(n)
            ? 'copper'
            : null;
  if (!kind) return null;
  if (kind === 'outline') return { kind, side: null };
  const inner = /(?:inner|mid)_?(?:layer)?_?(\d+)/.exec(n);
  if (kind === 'copper' && inner) return { kind, side: 'inner', order: Number(inner[1]) + 1 };
  // (the kind's own words out first: "stop" holds a "top")
  const rest = n.replace(/solder|mask|stop|resist|paste|cream|stencil|silkscreen|silk|legend|overlay|copper|signal|layer/g, ' ');
  const side = /top|front|(^|[^a-z])f([^a-z]|$)|comp/.test(rest) ? 'top' : /bottom|bot|back|(^|[^a-z])b([^a-z]|$)/.test(rest) ? 'bottom' : null;
  return side ? { kind, side } : null;
}

/** A file's layer, before the copper layers are numbered (readFabFiles). */
export function identifyLayer(name: string, read: GerberRead | ExcellonRead, drill: boolean): Omit<FabLayer, 'id' | 'label'> {
  const f = read.attributes['FileFunction'];
  const told = f ? fromFunction(f) : null;
  if (told && (!drill || told.kind === 'drill')) return { ...told, by: 'attribute' };
  if (drill) {
    const plated = (read as ExcellonRead).plated ?? (/npth|non[-_ ]?plated|unplated/i.test(name) ? false : /pth|plated/i.test(name) ? true : undefined);
    return { kind: 'drill', side: null, ...(plated !== undefined ? { plated } : {}), by: 'content' };
  }
  const inner = /(?:^|[-_.])In(\d+)[._]Cu\b/i.exec(name) ?? /\.g(\d+)$/i.exec(name) ?? /\.ly?(\d+)$/i.exec(name);
  if (inner) {
    const k = Number(inner[1]);
    // KiCad and Altium count the inner layers from 1, Eagle's .ly2 is the stack's second layer
    return { kind: 'copper', side: 'inner', order: /\.ly?\d+$/i.test(name) ? k : k + 1, by: 'name' };
  }
  if (/\.gp(\d+)$/i.test(name)) return { kind: 'copper', side: 'inner', order: 100 + Number(/\.gp(\d+)$/i.exec(name)![1]), by: 'name' };
  for (const [re, t] of NAMES) if (re.test(name)) return { ...t, by: 'name' };
  const words = fromWords(name);
  if (words) return { ...words, by: 'name' };
  return { kind: 'other', side: null, by: 'guess' };
}

const SIDE = { top: 'F', bottom: 'B' } as const;
const SIDE_WORD = { top: 'top', bottom: 'bottom' } as const;

/* the set */

export interface FabFileRead {
  name: string;
  format: 'gerber' | 'excellon';
  layer: FabLayer;
  objects: FabObject[];
  /** Drill files: the holes and slots. */
  holes: DrillHit[];
  /** Everything it draws (null: nothing). */
  box: Box | null;
  /** Negative polarity (X2): what it draws are openings (a solder mask). */
  negative: boolean;
  notes: string[];
  /** The program that wrote it, when it says (X2). */
  software?: string;
}

export interface FabSummary {
  /** The board's extent in the files' coordinates: from the outline, else from everything drawn. */
  board: { x: number; y: number; w: number; h: number; fromOutline: boolean } | null;
  copperLayers: number;
  /** Holes per drill size (mm), plated and non-plated apart; slots counted with their tool's size. */
  drills: { d: number; plated?: boolean; holes: number; slots: number }[];
  smallestDrill: number | null;
  smallestTrack: number | null;
  /** What looks wrong across the set: no outline or drill file, a layer past the outline, two files for one layer. */
  notes: string[];
}

export interface FabSet {
  files: FabFileRead[];
  /** Files that are neither Gerber nor drill files (a BOM, a pick-and-place list), by name. */
  skipped: string[];
  summary: FabSummary;
}

/** Gerber: a format or unit statement, an aperture, or a G04 comment with D codes; Excellon: M48, or tools and coordinates. */
export function fileFormat(content: string): 'gerber' | 'excellon' | null {
  const head = content.slice(0, 4000);
  if (/%FS[LTD]?[AI]?|%MO(MM|IN)|%ADD\d/.test(head)) return 'gerber';
  if (/^\s*(;[^\n]*\n\s*)*(M48|M72|M71)\b/.test(head) || (/^\s*(METRIC|INCH)\b/m.test(head) && /^T\d+C[\d.]+/m.test(head)) || /^;\s*DRILL|^T\d+C[\d.]+\s*$/m.test(head)) return 'excellon';
  if (/^G04[^\n]*\*\s*$/m.test(head) && /D0?[123]\*/.test(content)) return 'gerber';
  return null;
}

/** Where a layer is in the stack, top down: the top's silkscreen, paste and mask, the copper, the bottom's mask, paste and silkscreen; then the outline, the holes and other layers. */
export function stackRank(l: FabLayer): number {
  const side = { silk: 0, paste: 1, mask: 2 } as Record<string, number>;
  if (l.kind === 'copper') return 10 + (l.order ?? 0);
  if (l.kind in side) return l.side === 'top' ? side[l.kind]! : 2000 - side[l.kind]!;
  return l.kind === 'outline' ? 3000 : l.kind === 'drill' ? 3001 + (l.plated === false ? 1 : l.plated === undefined ? 2 : 0) : 4000;
}

/** Read a set of production files: each one's layer and shapes, and what the set says about the board. */
export function readFabFiles(files: { name: string; content: string }[]): FabSet {
  const read: FabFileRead[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const format = fileFormat(f.content);
    if (!format) {
      skipped.push(f.name);
      continue;
    }
    const r = format === 'gerber' ? readGerber(f.content) : readExcellon(f.content);
    const told = identifyLayer(f.name, r, format === 'excellon');
    const box = emptyBox();
    for (const o of r.objects) {
      grow(box, o.box[0], o.box[1]);
      grow(box, o.box[2], o.box[3]);
    }
    const software = r.attributes['GenerationSoftware']?.filter(Boolean).join(' ');
    read.push({
      name: f.name,
      format,
      layer: { ...told, id: '', label: '' },
      objects: r.objects,
      holes: format === 'excellon' ? (r as ExcellonRead).holes : [],
      box: box[0] <= box[2] ? box : null,
      negative: r.attributes['FilePolarity']?.[0] === 'Negative',
      notes: r.notes,
      ...(software ? { software } : {}),
    });
  }

  // the copper layers in stack order: the top, the inner ones by their number (In1 is the stack's
  // second layer; one without a number, an Altium plane, after the numbered ones), the bottom
  const copper = read.filter((f) => f.layer.kind === 'copper').sort((a, b) => rank(a.layer) - rank(b.layer));
  let inner = 0;
  for (const f of copper) {
    const l = f.layer;
    if (l.side === 'top') [l.id, l.label, l.order] = ['F.Cu', 'top copper', 1];
    else if (l.side === 'bottom') [l.id, l.label, l.order] = ['B.Cu', 'bottom copper', copper.length];
    else {
      inner = l.order && l.order < 100 ? Math.max(inner + 1, l.order - 1) : inner + 1;
      [l.id, l.label, l.order] = [`In${inner}.Cu`, `inner copper ${inner}`, inner + 1];
    }
  }
  for (const f of read) {
    const l = f.layer;
    if (l.kind === 'copper') continue;
    const s = l.side === 'top' || l.side === 'bottom' ? l.side : null;
    if (l.kind === 'mask' && s) [l.id, l.label] = [`${SIDE[s]}.Mask`, `${SIDE_WORD[s]} solder mask`];
    else if (l.kind === 'paste' && s) [l.id, l.label] = [`${SIDE[s]}.Paste`, `${SIDE_WORD[s]} paste`];
    else if (l.kind === 'silk' && s) [l.id, l.label] = [`${SIDE[s]}.Silkscreen`, `${SIDE_WORD[s]} silkscreen`];
    else if (l.kind === 'outline') [l.id, l.label] = ['Edge.Cuts', 'board outline'];
    else if (l.kind === 'drill') [l.id, l.label] = l.plated === true ? ['PTH', 'plated holes'] : l.plated === false ? ['NPTH', 'non-plated holes'] : ['Drill', 'holes'];
    else {
      // a mask, paste or silkscreen whose side is not known, or another layer (assembly, fab drawing): by its file
      const fn = f.name.replace(/\.[^.]*$/, '');
      [l.kind, l.id, l.label] = ['other', fn, l.kind === 'other' ? 'other layer' : `${l.kind} (side not known)`];
    }
  }
  // two files for one layer: the second keeps its file's name
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const f of read) {
    if (seen.has(f.layer.id)) {
      notes.push(`two files for ${f.layer.id}: ${f.name} is shown as a layer of its own`);
      f.layer.id = `${f.layer.id} (${f.name})`;
    }
    seen.add(f.layer.id);
  }
  read.sort((a, b) => stackRank(a.layer) - stackRank(b.layer) || a.layer.id.localeCompare(b.layer.id));
  return { files: read, skipped, summary: summarize(read, notes) };
}

function rank(l: Omit<FabLayer, 'id' | 'label'> | FabLayer): number {
  if (l.side === 'top') return 0;
  if (l.side === 'bottom') return 1e6;
  return l.order ?? 1e3;
}

function summarize(files: FabFileRead[], notes: string[]): FabSummary {
  const outline = files.find((f) => f.layer.kind === 'outline' && f.box);
  let box: Box | null = outline?.box ?? null;
  if (outline) {
    // the outline's own line width is not the board's
    const w = Math.max(0, ...outline.objects.flatMap((o) => o.parts.map((p) => (p.shape.k === 'stroke' ? p.shape.w : 0))));
    box = [box![0] + w / 2, box![1] + w / 2, box![2] - w / 2, box![3] - w / 2];
  } else {
    const all = emptyBox();
    for (const f of files) if (f.box) for (const k of [0, 2]) grow(all, f.box[k]!, f.box[k + 1]!);
    if (all[0] <= all[2]) box = all;
    if (files.length) notes.push('no board outline (Edge.Cuts, profile): the size is that of everything drawn');
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const board = box ? { x: r3(box[0]), y: r3(box[1]), w: r3(box[2] - box[0]), h: r3(box[3] - box[1]), fromOutline: !!outline } : null;

  const drills = new Map<string, { d: number; plated?: boolean; holes: number; slots: number }>();
  for (const f of files) {
    for (const h of f.holes) {
      const d = r3(h.d);
      const plated = h.plated ?? f.layer.plated;
      const key = `${d}|${plated}`;
      const e = drills.get(key) ?? { d, ...(plated !== undefined ? { plated } : {}), holes: 0, slots: 0 };
      if (h.slot) e.slots++;
      else e.holes++;
      drills.set(key, e);
    }
  }
  const tracks = files.filter((f) => f.layer.kind === 'copper').flatMap((f) => f.objects.flatMap((o) => (o.dark && o.kind === 'draw' && o.track && o.track > 0 ? [o.track] : [])));
  if (files.length && !files.some((f) => f.layer.kind === 'drill')) notes.push('no drill file');
  if (board?.fromOutline) {
    const [x0, y0, x1, y1] = [board.x, board.y, board.x + board.w, board.y + board.h];
    for (const f of files) {
      if (!f.box || f.layer.kind === 'outline') continue;
      const past = Math.max(x0 - f.box[0], y0 - f.box[1], f.box[2] - x1, f.box[3] - y1);
      if (past > 0.5) notes.push(`${f.layer.id} (${f.name}) reaches ${past.toFixed(1)} mm past the board outline`);
    }
  }
  const sizes = [...drills.values()].sort((a, b) => a.d - b.d || Number(b.plated ?? 0) - Number(a.plated ?? 0));
  return {
    board,
    copperLayers: files.filter((f) => f.layer.kind === 'copper').length,
    drills: sizes,
    smallestDrill: sizes.length ? sizes[0]!.d : null,
    smallestTrack: tracks.length ? r3(Math.min(...tracks)) : null,
    notes,
  };
}

const mm = (v: number) => `${Math.round(v * 1000) / 1000}`;

/** What a file holds, in words: "120 pads, 340 tracks, 6 areas", "245 holes, 4 slots". */
export function fileContents(f: FabFileRead): string {
  if (f.format === 'excellon') {
    const slots = f.holes.filter((h) => h.slot).length;
    return [`${f.holes.length - slots} hole${f.holes.length - slots === 1 ? '' : 's'}`, slots ? `${slots} slot${slots === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
  }
  const n = { flash: 0, draw: 0, region: 0 };
  for (const o of f.objects) n[o.kind]++;
  const clear = f.objects.filter((o) => !o.dark).length;
  return [
    n.flash ? `${n.flash} pad${n.flash === 1 ? '' : 's'}` : '',
    n.draw ? `${n.draw} line${n.draw === 1 ? '' : 's'}` : '',
    n.region ? `${n.region} area${n.region === 1 ? '' : 's'}` : '',
    clear ? `${clear} cleared` : '',
  ].filter(Boolean).join(', ') || 'empty';
}

/** The set in words, for the agent: the board, the files and their layers, the drills, and what looks wrong. */
export function fabSetText(set: FabSet): string {
  const s = set.summary;
  const lines: string[] = [];
  lines.push(`${set.files.length} file${set.files.length === 1 ? '' : 's'} read${set.skipped.length ? `; not Gerber or drill files, so not shown: ${set.skipped.join(', ')}` : ''}.`);
  if (s.board) lines.push(`Board ${mm(s.board.w)} × ${mm(s.board.h)} mm (${s.board.fromOutline ? 'its outline' : 'everything drawn, no outline'}), from x ${mm(s.board.x)}, y ${mm(s.board.y)}; ${s.copperLayers} copper layer${s.copperLayers === 1 ? '' : 's'}.`);
  lines.push('Layers (file: layer, how it was told; what it holds):');
  for (const f of set.files) {
    const how = f.layer.by === 'attribute' ? 'its X2 attribute' : f.layer.by === 'content' ? 'a drill file' : f.layer.by === 'name' ? 'its name' : 'not told: shown as another layer';
    lines.push(`- ${f.name}: ${f.layer.id} (${f.layer.label}${f.negative ? ', negative: the openings' : ''}), ${how}; ${fileContents(f)}${f.notes.length ? `; read with: ${f.notes.join('; ')}` : ''}`);
  }
  if (s.drills.length) {
    const kind = (p?: boolean) => (p === true ? 'plated' : p === false ? 'non-plated' : 'plating not said');
    const count = (n: number, what: string) => (n ? `${n} ${what}${n === 1 ? '' : 's'}` : '');
    lines.push(`Holes: ${s.drills.map((d) => `Ø${mm(d.d)} mm: ${[count(d.holes, 'hole'), count(d.slots, 'slot')].filter(Boolean).join(' + ')} (${kind(d.plated)})`).join(', ')}.`);
  }
  const small = [s.smallestDrill !== null ? `smallest drill ${mm(s.smallestDrill)} mm` : '', s.smallestTrack !== null ? `smallest track ${mm(s.smallestTrack)} mm` : ''].filter(Boolean);
  if (small.length) lines.push(`${small.join(', ')}.`.replace(/^s/, 'S'));
  if (s.notes.length) lines.push(`Notes: ${s.notes.join('; ')}.`);
  return lines.join('\n');
}
