/**
 * The production files' copper checked against the design's netlist, read back from the files
 * themselves. Every copper layer is drawn on a fine grid, its objects in order (clear polarity
 * erases what the file drew before it), and its copper joined into islands; the islands of the
 * layers are joined through the walls of the plated holes in the drill file. The design's pads,
 * found by a flash where the board has them, then say which nets the copper joins (a short), which
 * net it leaves in pieces (an open), and which copper is joined to no pad.
 *
 * Nothing here knows how the files were written: it holds the files against the design the way a
 * fab house's netlist test does, so it finds what the board view and the design checks cannot see
 * (they look at the board, not at the files). Its own blind spot is the reader (fabread.ts), which
 * the writer's tests hold against an independent one.
 */
import type { Box, DrillHit, FabObject, FabSet, FabShape, Path } from './fabread.ts';

/** A pad of the design, in the files' coordinates (mm, y up). */
export interface NetPad {
  /** The part's designator and the pad's number: "J2.S1". */
  name: string;
  /** Its net's name; null where the design leaves it unconnected. */
  net: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: 'rect' | 'round';
  /** The copper layers it is on, by the files' layer ids (F.Cu, In1.Cu, B.Cu); a plated hole's pad is on all of them. */
  layers: string[];
  /** A plated hole's diameter (a slot's width). */
  drill?: number;
  /** A slotted hole's extent, round-ended along its longer side. */
  slot?: { w: number; h: number };
}

/** A via of the design, in the files' coordinates. */
export interface NetVia {
  net: string;
  x: number;
  y: number;
  pad: number;
  drill: number;
}

/** What the files are held against: the design's pads and vias with their nets. */
export interface NetDesign {
  pads: NetPad[];
  vias: NetVia[];
  /** Connections the design itself leaves open (not routed), pad to pad by name: the files leave them open too. */
  open?: [string, string][];
  /** The design's copper areas (planes, pours), to say what copper joined to nothing was meant to be. */
  areas?: { net: string; layer: string; box: Box }[];
  /** Copper meant to be joined to nothing (a panel's fiducials), by a point in it. */
  loose?: { x: number; y: number }[];
}

export type CopperFindingKind = 'short' | 'open' | 'pad' | 'floating';

export interface CopperFinding {
  kind: CopperFindingKind;
  /** The nets it is about: those a short joins, the net an open cuts. */
  nets: string[];
  /** What is wrong, in words, for the user and the agent (positions in the files' coordinates). */
  text: string;
  /** The layer where it shows, if one does. */
  layer?: string;
  /** Where to look (files' mm), and an area round it to show. */
  at: { x: number; y: number };
  area: Box;
  /** The pads it is about, by name. */
  pads: string[];
}

export interface CopperCheck {
  /** Shorts first, then opens, pads without copper and copper joined to nothing; each kind's worst first. */
  findings: CopperFinding[];
  /** The design's pads (plated ones) the files have where the board has them, and all of them. */
  found: number;
  total: number;
  /** Parts with a pad the files do not have where the board has it (moved since the files were made, or left out). */
  notFound: string[];
  /** Connections the files leave open that the design leaves open too (not routed). */
  openInDesign: number;
  /** Per copper layer: its copper (mm²) and how many pieces it is in. */
  copper: Record<string, { area: number; islands: number }>;
  nets: number;
  layers: string[];
  holes: number;
  /** mm per grid step. */
  resolution: number;
  ms: number;
}

/** Copper finer than this is drawn coarser on a big board, to keep a layer's grid to MAX_CELLS. */
const RESOLUTION = 0.02;
const MAX_CELLS = 40e6;
/** A polygon round a circle lies at most this far inside it (mm). */
const ROUND_TOL = 0.0005;
/** Copper this close outside a hole's wall counts as touching it (drill tolerance, plating). */
const WALL = 0.025;
/** Copper joined to nothing is reported from this area on (mm²): a via left over is not a plane cut off. */
const FLOATING_MM2 = 2;
/** Shorts: spots per pair of nets listed; and spots this close are one. */
const SPOTS = 3;
const SPOT_APART = 2;

/* shapes as polygons */

/** A path's corners, flat x, y; its arcs in steps of 2° at most. */
function corners(p: Path): number[] {
  const out = [p.x, p.y];
  let [x, y] = [p.x, p.y];
  for (const s of p.segs) {
    if (s.arc) {
      const { cx, cy, ccw } = s.arc;
      const [r, a0] = [Math.hypot(x - cx, y - cy), Math.atan2(y - cy, x - cx)];
      let sweep = Math.atan2(s.y - cy, s.x - cx) - a0;
      if (ccw) while (sweep <= 1e-9) sweep += 2 * Math.PI;
      else while (sweep >= -1e-9) sweep -= 2 * Math.PI;
      const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 90)));
      for (let i = 1; i <= n; i++) out.push(cx + r * Math.cos(a0 + (sweep * i) / n), cy + r * Math.sin(a0 + (sweep * i) / n));
    } else out.push(s.x, s.y);
    [x, y] = [s.x, s.y];
  }
  return out;
}

const steps = (r: number) => Math.max(16, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - ROUND_TOL / Math.max(r, 1e-6)))));

function circlePoly(cx: number, cy: number, r: number): number[] {
  const n = steps(r);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n));
  return out;
}

/** The segment a, b drawn with a round pen of radius r, counter-clockwise. */
function capsulePoly(ax: number, ay: number, bx: number, by: number, r: number): number[] {
  if (Math.hypot(bx - ax, by - ay) < 1e-9) return circlePoly(ax, ay, r);
  const t = Math.atan2(by - ay, bx - ax);
  const n = Math.max(8, Math.ceil(steps(r) / 2));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(bx + r * Math.cos(t - Math.PI / 2 + (Math.PI * i) / n), by + r * Math.sin(t - Math.PI / 2 + (Math.PI * i) / n));
  for (let i = 0; i <= n; i++) out.push(ax + r * Math.cos(t + Math.PI / 2 + (Math.PI * i) / n), ay + r * Math.sin(t + Math.PI / 2 + (Math.PI * i) / n));
  return out;
}

/** A shape as polygons filled non-zero (all counter-clockwise but a fill's holes). */
function shapePolys(s: FabShape): number[][] {
  if (s.k === 'circle') return s.r > 0 ? [circlePoly(s.x, s.y, s.r)] : [];
  if (s.k === 'fill') return s.contours.map(corners);
  if (!(s.w > 0)) return [];
  const p = corners(s.path);
  if (p.length === 2) return [circlePoly(p[0]!, p[1]!, s.w / 2)];
  const out: number[][] = [];
  for (let i = 0; i + 3 < p.length; i += 2) out.push(capsulePoly(p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!, s.w / 2));
  return out;
}

/* the grid */

interface Grid {
  x0: number;
  y0: number;
  W: number;
  H: number;
  res: number;
}

/** Calls span(j, i0, i1) for each row of cells whose centres the polygons cover (non-zero). */
function scan(g: Grid, ps: number[][], span: (j: number, i0: number, i1: number) => void) {
  const edges: { y0: number; y1: number; x: number; dx: number; w: number }[] = [];
  for (const p of ps) {
    const n = p.length / 2;
    for (let e = 0; e < n; e++) {
      const [ax, ay, bx, by] = [p[2 * e]!, p[2 * e + 1]!, p[(2 * e + 2) % p.length]!, p[(2 * e + 3) % p.length]!];
      if (ay === by) continue;
      edges.push(ay < by ? { y0: ay, y1: by, x: ax, dx: (bx - ax) / (by - ay), w: 1 } : { y0: by, y1: ay, x: bx, dx: (ax - bx) / (ay - by), w: -1 });
    }
  }
  if (!edges.length) return;
  let [lo, hi] = [Infinity, -Infinity];
  for (const e of edges) [lo, hi] = [Math.min(lo, e.y0), Math.max(hi, e.y1)];
  const j0 = Math.max(0, Math.ceil((lo - g.y0) / g.res - 0.5));
  const j1 = Math.min(g.H - 1, Math.floor((hi - g.y0) / g.res - 0.5));
  edges.sort((a, b) => a.y0 - b.y0);
  let next = 0;
  let active: typeof edges = [];
  const xs: [number, number][] = [];
  for (let j = j0; j <= j1; j++) {
    const yc = g.y0 + (j + 0.5) * g.res;
    while (next < edges.length && edges[next]!.y0 <= yc) active.push(edges[next++]!);
    active = active.filter((e) => e.y1 > yc);
    xs.length = 0;
    for (const e of active) xs.push([e.x + (yc - e.y0) * e.dx, e.w]);
    xs.sort((a, b) => a[0] - b[0]);
    let wind = 0;
    let start = 0;
    for (const [x, w] of xs) {
      const before = wind;
      wind += w;
      if (before === 0 && wind !== 0) start = x;
      else if (before !== 0 && wind === 0) {
        const i0 = Math.max(0, Math.ceil((start - g.x0) / g.res - 0.5));
        const i1 = Math.min(g.W - 1, Math.floor((x - g.x0) / g.res - 0.5));
        if (i1 >= i0) span(j, i0, i1);
      }
    }
  }
}

/** A layer's copper: its objects in order, dark ones adding, clear ones erasing. */
function draw(g: Grid, objects: FabObject[]): Uint8Array {
  const px = new Uint8Array(g.W * g.H);
  for (const o of objects) {
    const v = o.dark ? 1 : 0;
    if (o.parts.length === 1 && !o.parts[0]!.off) {
      scan(g, shapePolys(o.parts[0]!.shape), (j, i0, i1) => px.fill(v, j * g.W + i0, j * g.W + i1 + 1));
      continue;
    }
    // several parts (a macro): what the object covers, part by part, then the object onto the layer
    const [bi0, bj0] = [Math.max(0, Math.floor((o.box[0] - g.x0) / g.res) - 1), Math.max(0, Math.floor((o.box[1] - g.y0) / g.res) - 1)];
    const [bi1, bj1] = [Math.min(g.W - 1, Math.ceil((o.box[2] - g.x0) / g.res) + 1), Math.min(g.H - 1, Math.ceil((o.box[3] - g.y0) / g.res) + 1)];
    if (bi1 < bi0 || bj1 < bj0) continue;
    const bw = bi1 - bi0 + 1;
    const covered = new Uint8Array(bw * (bj1 - bj0 + 1));
    for (const p of o.parts) scan(g, shapePolys(p.shape), (j, i0, i1) => covered.fill(p.off ? 0 : 1, (j - bj0) * bw + Math.max(i0, bi0) - bi0, (j - bj0) * bw + Math.min(i1, bi1) - bi0 + 1));
    for (let j = bj0; j <= bj1; j++) for (let i = bi0; i <= bi1; i++) if (covered[(j - bj0) * bw + i - bi0]) px[j * g.W + i] = v;
  }
  return px;
}

/** A layer's copper as runs of cells per row, joined into islands (4-connected). */
interface Islands {
  /** The island at x, y (files' mm), -1 where there is no copper. */
  at(x: number, y: number): number;
  count: number;
  area: Float64Array;
  box: Box[];
  /** A point in each island. */
  point: { x: number; y: number }[];
  /** Calls run(j, i0, i1) for each run of cells of island k (row j, columns i0 to i1). */
  runs(k: number, run: (j: number, i0: number, i1: number) => void): void;
}

function islandsOf(g: Grid, px: Uint8Array): Islands {
  const { W, H, res } = g;
  const rowStart = new Int32Array(H + 1);
  let i0s = new Int32Array(1024);
  let i1s = new Int32Array(1024);
  let parent = new Int32Array(1024);
  let n = 0;
  const find = (a: number) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!;
    return a;
  };
  for (let j = 0; j < H; j++) {
    rowStart[j] = n;
    const row = j * W;
    let q = j > 0 ? rowStart[j - 1]! : 0;
    const qEnd = j > 0 ? rowStart[j]! : 0;
    for (let i = 0; i < W; i++) {
      if (!px[row + i]) continue;
      let e = i;
      while (e + 1 < W && px[row + e + 1]) e++;
      if (n === i0s.length) {
        const grow = (a: Int32Array) => {
          const b = new Int32Array(a.length * 2);
          b.set(a);
          return b;
        };
        [i0s, i1s, parent] = [grow(i0s), grow(i1s), grow(parent)];
      }
      i0s[n] = i;
      i1s[n] = e;
      parent[n] = n;
      // the runs above that this one overlaps (runs of a row are in order)
      while (q < qEnd && i1s[q]! < i) q++;
      for (let r = q; r < qEnd && i0s[r]! <= e; r++) {
        const [a, b] = [find(n), find(r)];
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
      n++;
      i = e;
    }
  }
  rowStart[H] = n;
  // islands numbered from 0
  const id = new Int32Array(n);
  const roots = new Map<number, number>();
  for (let r = 0; r < n; r++) {
    const root = find(r);
    let k = roots.get(root);
    if (k === undefined) roots.set(root, (k = roots.size));
    id[r] = k;
  }
  const count = roots.size;
  const area = new Float64Array(count);
  const box: Box[] = Array.from({ length: count }, () => [Infinity, Infinity, -Infinity, -Infinity]);
  const point: { x: number; y: number }[] = new Array(count);
  for (let j = 0; j < H; j++) {
    for (let r = rowStart[j]!; r < rowStart[j + 1]!; r++) {
      const k = id[r]!;
      area[k]! += (i1s[r]! - i0s[r]! + 1) * res * res;
      const b = box[k]!;
      b[0] = Math.min(b[0], g.x0 + i0s[r]! * res);
      b[1] = Math.min(b[1], g.y0 + j * res);
      b[2] = Math.max(b[2], g.x0 + (i1s[r]! + 1) * res);
      b[3] = Math.max(b[3], g.y0 + (j + 1) * res);
      point[k] ??= { x: g.x0 + ((i0s[r]! + i1s[r]!) / 2 + 0.5) * res, y: g.y0 + (j + 0.5) * res };
    }
  }
  const at = (x: number, y: number) => {
    const [i, j] = [Math.floor((x - g.x0) / res), Math.floor((y - g.y0) / res)];
    if (j < 0 || j >= H || i < 0 || i >= W) return -1;
    let [lo, hi] = [rowStart[j]!, rowStart[j + 1]! - 1];
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (i1s[m]! < i) lo = m + 1;
      else if (i0s[m]! > i) hi = m - 1;
      else return id[m]!;
    }
    return -1;
  };
  const runs = (k: number, run: (j: number, i0: number, i1: number) => void) => {
    const b = box[k]!;
    for (let j = Math.max(0, Math.round((b[1] - g.y0) / res)); j < Math.min(H, Math.round((b[3] - g.y0) / res)); j++) {
      for (let r = rowStart[j]!; r < rowStart[j + 1]!; r++) if (id[r] === k) run(j, i0s[r]!, i1s[r]!);
    }
  };
  return { at, count, area, box, point, runs };
}

/** A meeting of two sources' copper on an island: the two (indices), and the middle of where they meet. */
interface Meeting {
  a: number;
  b: number;
  x: number;
  y: number;
  /** Grid cells along it. */
  n: number;
}

/** Coarser cells for splitting an island: no wider than this (mm), so two never span a gap between copper. */
const SPLIT_CELL = 0.04;
const SPLIT_MAX_CELLS = 12e6;

/**
 * Where the nets on an island meet: its copper split among its sources (pads, hole walls), each
 * cell going to the source it is nearest along the copper (breadth first from all of them at once);
 * then every pair of sources of different nets whose parts touch, and where. Sources of two nets
 * that are joined only through a third's copper do not meet: the third meets each of them. Null
 * when the island is too big to split.
 */
function meetings(g: Grid, isl: Islands, k: number, srcs: { net: string; shape: Shape; hole: boolean }[]): Meeting[] | null {
  const f = Math.max(1, Math.floor(SPLIT_CELL / g.res + 1e-9));
  const c = g.res * f;
  const b = isl.box[k]!;
  const [i0, j0] = [Math.round((b[0] - g.x0) / g.res), Math.round((b[1] - g.y0) / g.res)];
  const [cw, ch] = [Math.ceil((Math.round((b[2] - g.x0) / g.res) - i0) / f) + 1, Math.ceil((Math.round((b[3] - g.y0) / g.res) - j0) / f) + 1];
  if (cw * ch > SPLIT_MAX_CELLS) return null;
  const mask = new Uint8Array(cw * ch);
  isl.runs(k, (j, a, e) => {
    const row = Math.floor((j - j0) / f) * cw;
    for (let ci = Math.floor((a - i0) / f); ci <= Math.floor((e - i0) / f); ci++) mask[row + ci] = 1;
  });
  const cx = (ci: number) => g.x0 + (i0 + (ci + 0.5) * f) * g.res;
  const cy = (cj: number) => g.y0 + (j0 + (cj + 0.5) * f) * g.res;
  const owner = new Int32Array(cw * ch).fill(-1);
  const met = new Map<number, { a: number; b: number; sx: number; sy: number; n: number }>();
  const meet = (p: number, q: number, cell: number) => {
    const [a, e] = p < q ? [p, q] : [q, p];
    const key = a * srcs.length + e;
    const m = met.get(key) ?? { a, b: e, sx: 0, sy: 0, n: 0 };
    m.sx += cx(cell % cw);
    m.sy += cy(Math.floor(cell / cw));
    m.n++;
    met.set(key, m);
  };
  let queue = new Int32Array(1 << 16);
  let [head, tail] = [0, 0];
  const push = (cell: number) => {
    if (tail - head === queue.length) {
      const bigger = new Int32Array(queue.length * 2);
      for (let i = 0; i < tail - head; i++) bigger[i] = queue[(head + i) % queue.length]!;
      [queue, head, tail] = [bigger, 0, tail - head];
    }
    queue[tail++ % queue.length] = cell;
  };
  // each source's own cells: its pad, or the band round its hole's wall
  srcs.forEach((s, si) => {
    const sh = s.shape;
    const reach = s.hole ? sh.r + WALL + c : c * 0.71;
    const [x0, y0, x1, y1] = [Math.min(sh.ax, sh.bx) - reach - (sh.k === 'seg' ? sh.r : 0), Math.min(sh.ay, sh.by) - reach - (sh.k === 'seg' ? sh.r : 0), Math.max(sh.ax, sh.bx) + reach + (sh.k === 'seg' ? sh.r : 0), Math.max(sh.ay, sh.by) + reach + (sh.k === 'seg' ? sh.r : 0)];
    for (let cj = Math.max(0, Math.floor((y0 - cy(0)) / c)); cj < ch && cy(cj) <= y1; cj++) {
      for (let ci = Math.max(0, Math.floor((x0 - cx(0)) / c)); ci < cw && cx(ci) <= x1; ci++) {
        const cell = cj * cw + ci;
        if (!mask[cell]) continue;
        const [x, y] = [cx(ci), cy(cj)];
        let inside: boolean;
        if (sh.k === 'rect') inside = Math.hypot(Math.max(sh.ax - x, 0, x - sh.bx), Math.max(sh.ay - y, 0, y - sh.by)) <= reach;
        else {
          const d = segDist(x, y, sh.ax, sh.ay, sh.bx, sh.by);
          inside = s.hole ? d >= sh.r - c && d <= reach : d <= sh.r + reach;
        }
        if (!inside) continue;
        const o = owner[cell]!;
        if (o < 0) {
          owner[cell] = si;
          push(cell);
        } else if (srcs[o]!.net !== s.net) meet(o, si, cell);
      }
    }
  });
  while (tail > head) {
    const cell = queue[head++ % queue.length]!;
    const o = owner[cell]!;
    const [ci, cj] = [cell % cw, Math.floor(cell / cw)];
    for (const q of [ci > 0 ? cell - 1 : -1, ci < cw - 1 ? cell + 1 : -1, cj > 0 ? cell - cw : -1, cj < ch - 1 ? cell + cw : -1]) {
      if (q < 0 || !mask[q]) continue;
      const p = owner[q]!;
      if (p < 0) {
        owner[q] = o;
        push(q);
      } else if (p !== o && srcs[p]!.net !== srcs[o]!.net) meet(o, p, q);
    }
  }
  return [...met.values()].map((m) => ({ a: m.a, b: m.b, x: m.sx / m.n, y: m.sy / m.n, n: m.n }));
}

/* geometry of pads and holes */

/** A source of a net on the copper: a pad, or a hole's wall (a plated hole the design has). */
interface Shape {
  /** A capsule from a to b with radius r (a disc when a = b), or a rectangle. */
  k: 'seg' | 'rect';
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
}

const padShape = (p: NetPad): Shape => {
  if (p.shape === 'rect') return { k: 'rect', ax: p.x - p.w / 2, ay: p.y - p.h / 2, bx: p.x + p.w / 2, by: p.y + p.h / 2, r: 0 };
  const r = Math.min(p.w, p.h) / 2;
  return { k: 'seg', ax: p.x - (p.w / 2 - r), ay: p.y - (p.h / 2 - r), bx: p.x + (p.w / 2 - r), by: p.y + (p.h / 2 - r), r };
};

/** A drill hit's centre line: its two ends (the same point for a round hole). */
function holeLine(h: DrillHit): [number, number, number, number] {
  if (!h.slot) return [h.x, h.y, h.x, h.y];
  const e = corners(h.slot);
  return [h.x, h.y, e[e.length - 2]!, e[e.length - 1]!];
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const [dx, dy] = [bx - ax, by - ay];
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function segSeg(a: Shape, b: Shape): number {
  const cross = (ox: number, oy: number, px: number, py: number, qx: number, qy: number) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
  const d1 = cross(a.ax, a.ay, a.bx, a.by, b.ax, b.ay);
  const d2 = cross(a.ax, a.ay, a.bx, a.by, b.bx, b.by);
  const d3 = cross(b.ax, b.ay, b.bx, b.by, a.ax, a.ay);
  const d4 = cross(b.ax, b.ay, b.bx, b.by, a.bx, a.by);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(segDist(a.ax, a.ay, b.ax, b.ay, b.bx, b.by), segDist(a.bx, a.by, b.ax, b.ay, b.bx, b.by), segDist(b.ax, b.ay, a.ax, a.ay, a.bx, a.by), segDist(b.bx, b.by, a.ax, a.ay, a.bx, a.by));
}

/** The gap between two shapes' copper (0 where they touch or overlap). */
function gapOf(a: Shape, b: Shape): number {
  if (a.k === 'rect' && b.k === 'rect') return Math.hypot(Math.max(a.ax - b.bx, b.ax - a.bx, 0), Math.max(a.ay - b.by, b.ay - a.by, 0));
  if (a.k === 'seg' && b.k === 'seg') return Math.max(0, segSeg(a, b) - a.r - b.r);
  const [s, r] = a.k === 'seg' ? [a, b] : [b, a];
  const inside = (x: number, y: number) => x >= r.ax && x <= r.bx && y >= r.ay && y <= r.by;
  if (inside(s.ax, s.ay) || inside(s.bx, s.by)) return 0;
  const edges: Shape[] = [
    { k: 'seg', ax: r.ax, ay: r.ay, bx: r.bx, by: r.ay, r: 0 },
    { k: 'seg', ax: r.bx, ay: r.ay, bx: r.bx, by: r.by, r: 0 },
    { k: 'seg', ax: r.bx, ay: r.by, bx: r.ax, by: r.by, r: 0 },
    { k: 'seg', ax: r.ax, ay: r.by, bx: r.ax, by: r.ay, r: 0 },
  ];
  return Math.max(0, Math.min(...edges.map((e) => segSeg(s, e))) - s.r);
}

const shapeBox = (s: Shape): Box => [Math.min(s.ax, s.bx) - s.r, Math.min(s.ay, s.by) - s.r, Math.max(s.ax, s.bx) + s.r, Math.max(s.ay, s.by) + s.r];
const centreOf = (s: Shape) => ({ x: (s.ax + s.bx) / 2, y: (s.ay + s.by) / 2 });
const joinBoxes = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
/** A box grown to at least `min` each way and by `m` round it. */
const around = (b: Box, m = 1, min = 3): Box => {
  const [cx, cy] = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const [hw, hh] = [Math.max((b[2] - b[0]) / 2 + m, min / 2), Math.max((b[3] - b[1]) / 2 + m, min / 2)];
  return [cx - hw, cy - hh, cx + hw, cy + hh];
};
const mm = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
const at = (p: { x: number; y: number }) => `x ${mm(p.x)}, y ${mm(p.y)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (names: string[], max = 6) => (names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', '));

/* the check */

/**
 * The files' copper against the design. `layers`: the copper layers, top down, each read back
 * (readGerber); `holes`: the plated holes and slots (readExcellon). `fresh`: the files were just
 * made from this design, so a pad they do not have is a finding (else the part moved since).
 */
export function checkCopper(layers: { id: string; objects: FabObject[] }[], holes: DrillHit[], design: NetDesign, opts: { fresh?: boolean; resolution?: number } = {}): CopperCheck {
  const t0 = performance.now();
  // the grid spans every layer's copper
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const l of layers) for (const o of l.objects) [x0, y0, x1, y1] = [Math.min(x0, o.box[0]), Math.min(y0, o.box[1]), Math.max(x1, o.box[2]), Math.max(y1, o.box[3])];
  const empty = x0 > x1;
  if (empty) [x0, y0, x1, y1] = [0, 0, 1, 1];
  [x0, y0, x1, y1] = [x0 - 0.5, y0 - 0.5, x1 + 0.5, y1 + 0.5];
  const res = Math.max(opts.resolution ?? RESOLUTION, Math.sqrt(((x1 - x0) * (y1 - y0)) / MAX_CELLS));
  const g: Grid = { x0, y0, W: Math.ceil((x1 - x0) / res), H: Math.ceil((y1 - y0) / res), res };

  // the pads the files have where the design has them: a flash centred there on an outer layer
  const ids = layers.map((l) => l.id);
  const outer = new Set([ids[0], ids[ids.length - 1]].filter((x): x is string => !!x));
  const flashes = new Set<string>();
  const key = (l: string, x: number, y: number) => `${l}:${Math.round(x * 1000)},${Math.round(y * 1000)}`;
  for (const l of layers) {
    if (!outer.has(l.id)) continue;
    for (const o of l.objects) if (o.kind === 'flash' && o.dark) flashes.add(key(l.id, (o.box[0] + o.box[2]) / 2, (o.box[1] + o.box[3]) / 2));
  }
  const flashAt = (l: string, x: number, y: number) => [-2, -1, 0, 1, 2].some((dx) => [-2, -1, 0, 1, 2].some((dy) => flashes.has(key(l, x + dx / 1000, y + dy / 1000))));
  const all = design.pads;
  const pads = all.filter((p) => {
    const on = p.layers.filter((l) => outer.has(l));
    return (on.length ? on : p.layers.filter((l) => ids.includes(l))).some((l) => flashAt(l, p.x, p.y));
  });
  const kept = new Set(pads);
  const notFound = [...new Set(all.filter((p) => !kept.has(p)).map((p) => p.name.replace(/\.[^.]*$/, '')))];
  const findings: CopperFinding[] = [];
  if (opts.fresh) {
    for (const part of notFound) {
      const ps = all.filter((p) => p.name.replace(/\.[^.]*$/, '') === part && !kept.has(p));
      const box = ps.map(padShape).map(shapeBox).reduce(joinBoxes);
      findings.push({ kind: 'pad', nets: [...new Set(ps.flatMap((p) => (p.net ? [p.net] : [])))], text: `${list(ps.map((p) => p.name))} ${ps.length === 1 ? 'is' : 'are'} not in the files: no pad is drawn where the board has ${ps.length === 1 ? 'it' : 'them'}`, at: { x: ps[0]!.x, y: ps[0]!.y }, area: around(box), pads: ps.map((p) => p.name) });
    }
  }

  // the holes the design has, by position: whose net a hole's wall carries
  const named = new Map<string, { name: string; net: string | null; pad?: NetPad }>();
  const pos = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
  for (const v of design.vias) named.set(pos(v.x, v.y), { name: `via of ${v.net}`, net: v.net });
  for (const p of pads) {
    if (!p.drill) continue;
    const [ax, ay] = p.slot ? (p.slot.w > p.slot.h ? [p.x - (p.slot.w - p.slot.h) / 2, p.y] : [p.x, p.y - (p.slot.h - p.slot.w) / 2]) : [p.x, p.y];
    for (const [x, y] of [[ax, ay], [p.x, p.y], [2 * p.x - ax, 2 * p.y - ay]] as const) named.set(pos(x, y), { name: p.name, net: p.net, pad: p });
  }
  const holeInfo = holes.map((h) => named.get(pos(h.x, h.y)) ?? null);

  // each layer: its islands; what each pad and hole touches
  type Node = number;
  const nodeOf = new Map<string, Node>();
  const nodeLayer: string[] = [];
  const nodeIsland: number[] = [];
  const parent: number[] = [];
  const node = (l: number, isl: number): Node => {
    const k = `${l}:${isl}`;
    let n = nodeOf.get(k);
    if (n === undefined) {
      n = parent.length;
      nodeOf.set(k, n);
      parent.push(n);
      nodeLayer.push(ids[l]!);
      nodeIsland.push(isl);
    }
    return n;
  };
  const find = (a: number) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!;
    return a;
  };
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  /** Per pad, the island it lies on per layer (-1: no copper there). */
  const padNodes = new Map<NetPad, Map<string, Node>>(pads.map((p) => [p, new Map()]));
  const holeNodes: Node[][] = holes.map(() => []);
  const islandsByLayer: Islands[] = [];
  const noCopper: { pad: NetPad; layer: string }[] = [];
  layers.forEach((l, li) => {
    const isl = islandsOf(g, empty ? new Uint8Array(g.W * g.H) : draw(g, l.objects));
    islandsByLayer.push(isl);
    for (const p of pads) {
      if (!p.layers.includes(l.id)) continue;
      const r = isl.at(p.x, p.y);
      if (r >= 0) padNodes.get(p)!.set(l.id, node(li, r));
      // (a plated hole's pad may be left off an inner layer: its wall joins the copper there)
      else if (!p.drill || outer.has(l.id)) noCopper.push({ pad: p, layer: l.id });
    }
    holes.forEach((h, n) => {
      // the barrel joins the copper that reaches its wall on every layer
      const [ax, ay, bx, by] = holeLine(h);
      const r = h.d / 2 + WALL;
      const len = Math.hypot(bx - ax, by - ay);
      const t = Math.atan2(by - ay, bx - ax);
      const pts: [number, number][] = [];
      const ring = 16;
      for (let a = 0; a < ring; a++) {
        const u = t + Math.PI / 2 + (Math.PI * 2 * a) / ring;
        // a slot: the half rounds at its ends, the straight sides between them
        const end = Math.cos(u - t) >= 0 ? [bx, by] : [ax, ay];
        pts.push([end[0]! + r * Math.cos(u), end[1]! + r * Math.sin(u)]);
      }
      for (let s = 1; len > 0 && s * 0.1 < len; s++) {
        const [x, y] = [ax + ((bx - ax) * s * 0.1) / len, ay + ((by - ay) * s * 0.1) / len];
        pts.push([x - r * Math.sin(t), y + r * Math.cos(t)], [x + r * Math.sin(t), y - r * Math.cos(t)]);
      }
      const seen = new Set<number>();
      for (const [x, y] of pts) {
        const k = isl.at(x, y);
        if (k >= 0 && !seen.has(k)) {
          seen.add(k);
          holeNodes[n]!.push(node(li, k));
        }
      }
    });
  });
  for (const ns of holeNodes) for (let i = 1; i < ns.length; i++) union(ns[0]!, ns[i]!);

  // a plated hole's pad whose layers no hole joins (the drill file lacks it)
  for (const p of pads) {
    const ns = [...padNodes.get(p)!.entries()];
    if (!p.drill || ns.length < 2) continue;
    const apart = ns.filter(([, n]) => find(n) !== find(ns[0]![1]));
    if (!apart.length) continue;
    findings.push({ kind: 'open', nets: p.net ? [p.net] : [], text: `${p.name}${p.net ? ` (${p.net})` : ''}: its copper on ${ns[0]![0]} and on ${apart.map(([l]) => l).join(', ')} is not joined, as if its hole were missing from the drill file`, layer: apart[0]![0], at: { x: p.x, y: p.y }, area: around(shapeBox(padShape(p))), pads: [p.name] });
  }
  for (const { pad, layer } of noCopper) {
    findings.push({ kind: 'pad', nets: pad.net ? [pad.net] : [], text: `${pad.name}${pad.net ? ` (${pad.net})` : ''} has no copper on ${layer} in the files, where the board has the pad (something drawn after it cleared it)`, layer, at: { x: pad.x, y: pad.y }, area: around(shapeBox(padShape(pad))), pads: [pad.name] });
  }

  // nets per joined piece of copper
  const netName = (p: NetPad) => p.net ?? `${p.name} (not connected)`;
  const padRoot = (p: NetPad) => {
    const ns = [...padNodes.get(p)!.values()];
    return ns.length ? find(ns[0]!) : -1;
  };
  const byRoot = new Map<number, Map<string, NetPad[]>>();
  const byNet = new Map<string, Map<number, NetPad[]>>();
  for (const p of pads) {
    const root = padRoot(p);
    if (root < 0) continue;
    const net = netName(p);
    const r = byRoot.get(root) ?? new Map<string, NetPad[]>();
    byRoot.set(root, r);
    r.set(net, [...(r.get(net) ?? []), p]);
    if (!p.net) continue;
    const n = byNet.get(net) ?? new Map<number, NetPad[]>();
    byNet.set(net, n);
    n.set(root, [...(n.get(root) ?? []), p]);
  }

  /* shorts: copper that joins pads of two nets, and where they meet */
  interface Source {
    name: string;
    net: string;
    shape: Shape;
    hole: boolean;
  }
  const islandSources = new Map<Node, Source[]>();
  const addSource = (n: Node, s: Source) => islandSources.set(n, [...(islandSources.get(n) ?? []), s]);
  for (const p of pads) for (const n of padNodes.get(p)!.values()) addSource(n, { name: p.name, net: netName(p), shape: padShape(p), hole: false });
  holes.forEach((h, i) => {
    const info = holeInfo[i];
    if (!info) return;
    const [ax, ay, bx, by] = holeLine(h);
    // (a pad's own hole: its pad stands for it, unless the pad has no copper on that layer)
    for (const n of holeNodes[i]!) {
      const here = islandSources.get(n) ?? [];
      if (info.pad && here.some((s) => s.name === info.pad!.name && !s.hole)) continue;
      addSource(n, { name: info.name, net: info.net ?? `${info.name} (not connected)`, shape: { k: 'seg', ax, ay, bx, by, r: h.d / 2 }, hole: true });
    }
  });
  for (const [root, nets] of byRoot) {
    if (nets.size < 2) continue;
    const netList = [...nets.keys()].sort((a, b) => nets.get(b)!.length - nets.get(a)!.length || a.localeCompare(b));
    // the islands of this piece where two nets meet, and the sources whose copper meets there
    const spots: { a: Source; b: Source; gap: number; layer: string; minority: Source; x: number; y: number }[] = [];
    for (const [n, srcs] of islandSources) {
      if (find(n) !== root) continue;
      const count = new Map<string, number>();
      for (const s of srcs) count.set(s.net, (count.get(s.net) ?? 0) + 1);
      if (count.size < 2) continue;
      const li = ids.indexOf(nodeLayer[n]!);
      let pairs = meetings(g, islandsByLayer[li]!, nodeIsland[n]!, srcs)?.map((m) => ({ s: srcs[m.a]!, t: srcs[m.b]!, x: m.x, y: m.y })) ?? null;
      if (!pairs) {
        // (too big to split: each source with the closest one of another net)
        pairs = [];
        for (const s of srcs) {
          let best: { t: Source; d: number } | null = null;
          for (const t of srcs) if (t.net !== s.net && (!best || gapOf(s.shape, t.shape) < best.d)) best = { t, d: gapOf(s.shape, t.shape) };
          if (best) pairs.push({ s, t: best.t, x: (centreOf(s.shape).x + centreOf(best.t.shape).x) / 2, y: (centreOf(s.shape).y + centreOf(best.t.shape).y) / 2 });
        }
      }
      for (const { s, t, x, y } of pairs) {
        // the one whose net has fewer sources on this island is the one out of place
        const minority = count.get(s.net)! < count.get(t.net)! || (count.get(s.net) === count.get(t.net) && s.hole) ? s : t;
        spots.push({ a: s, b: t, gap: gapOf(s.shape, t.shape), layer: nodeLayer[n]!, minority, x, y });
      }
    }
    // where the two sources touch, the spot is where they meet; else the one out of place
    const spotOf = (s: (typeof spots)[number]) => (s.gap <= 0.3 ? { x: s.x, y: s.y } : centreOf(s.minority.shape));
    spots.sort((p, q) => p.gap - q.gap || Number(q.minority.hole) - Number(p.minority.hole));
    const chosen: (typeof spots)[number][] = [];
    const perPair = new Map<string, number>();
    for (const s of spots) {
      const pair = [s.a.net, s.b.net].sort().join('|');
      if ((perPair.get(pair) ?? 0) >= SPOTS) continue;
      const c = spotOf(s);
      if (chosen.some((o) => o.layer === s.layer && Math.hypot(spotOf(o).x - c.x, spotOf(o).y - c.y) < SPOT_APART)) continue;
      chosen.push(s);
      perPair.set(pair, (perPair.get(pair) ?? 0) + 1);
    }
    const joined = `${netList.join(' and ')} ${netList.length > 2 ? 'are all' : 'are'} joined in the files`;
    const allPads = netList.flatMap((net) => nets.get(net)!.map((p) => p.name));
    for (const s of chosen) {
      const [m, o] = s.minority === s.a ? [s.a, s.b] : [s.b, s.a];
      const what = (x: Source) => (x.hole ? `the plated hole of ${x.name}` : x.name);
      const text =
        s.gap <= 0.05 && !m.hole && !o.hole
          ? `${joined}: ${m.name} (${m.net}) touches ${o.name} (${o.net}) on ${s.layer}`
          : `${joined}: ${what(m)} (${m.net}) touches copper of ${o.net} on ${s.layer}`;
      const spot = spotOf(s);
      const box = joinBoxes(shapeBox(m.shape), [spot.x, spot.y, spot.x, spot.y]);
      findings.push({ kind: 'short', nets: [m.net, o.net], text, layer: s.layer, at: spot, area: around(s.gap <= 0.3 ? joinBoxes(box, shapeBox(o.shape)) : box), pads: allPads });
    }
    if (!chosen.length) {
      // no island holds two nets: a hole the design does not have joins them
      const stray = holes.map((h, i) => ({ h, i })).filter(({ i }) => !holeInfo[i] && holeNodes[i]!.some((n) => find(n) === root));
      const h = stray[0]?.h;
      const first = nets.get(netList[netList.length - 1]!)![0]!;
      findings.push({
        kind: 'short',
        nets: netList,
        text: h ? `${joined}: a plated hole the board does not have (${at(h)}, Ø${mm(h.d)}) joins their copper` : `${joined} (${list(allPads)})`,
        at: h ? { x: h.x, y: h.y } : { x: first.x, y: first.y },
        area: around(h ? [h.x - h.d / 2, h.y - h.d / 2, h.x + h.d / 2, h.y + h.d / 2] : shapeBox(padShape(first))),
        pads: allPads,
      });
    }
  }

  /* opens: a net's pads on pieces of copper not joined, beyond what the design leaves open */
  const padByName = new Map(pads.map((p) => [p.name, p]));
  let openInDesign = 0;
  for (const [net, pieces] of byNet) {
    if (pieces.size < 2) continue;
    // the design's own open connections join pieces (the files may leave those open)
    const roots = [...pieces.keys()];
    const up = new Map(roots.map((r) => [r, r]));
    const top = (r: number) => {
      while (up.get(r) !== r) r = up.get(r)!;
      return r;
    };
    for (const [a, b] of design.open ?? []) {
      const [pa, pb] = [padByName.get(a), padByName.get(b)];
      if (!pa || !pb || netName(pa) !== net || netName(pb) !== net) continue;
      const [ra, rb] = [top(padRoot(pa)), top(padRoot(pb))];
      if (ra !== rb) {
        up.set(ra, rb);
        openInDesign++;
      }
    }
    const groups = new Map<number, NetPad[]>();
    for (const [r, ps] of pieces) groups.set(top(r), [...(groups.get(top(r)) ?? []), ...ps]);
    if (groups.size < 2) continue;
    const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
    const off = sorted.slice(1);
    const first = off[0]!;
    const box = first.map(padShape).map(shapeBox).reduce(joinBoxes);
    const shown = off.slice(0, 4).map((ps) => list(ps.map((p) => p.name), 3));
    findings.push({
      kind: 'open',
      nets: [net],
      text: `${net} is in ${groups.size} pieces in the files, where the board has it joined: the biggest has ${plural(sorted[0]!.length, 'pad')}; cut off from it: ${shown.join(' | ')}${off.length > 4 ? ` and ${plural(off.length - 4, 'piece')} more` : ''}`,
      at: { x: first[0]!.x, y: first[0]!.y },
      area: around(box),
      pads: off.flat().map((p) => p.name),
    });
  }

  /* copper joined to no pad */
  const rootsWithPads = new Set(byRoot.keys());
  const loose = new Set<number>();
  for (const pt of design.loose ?? []) {
    layers.forEach((_, li) => {
      const k = islandsByLayer[li]!.at(pt.x, pt.y);
      if (k >= 0) loose.add(find(node(li, k)));
    });
  }
  const floating = new Map<number, { area: number; biggest: { layer: number; island: number; area: number } }>();
  islandsByLayer.forEach((isl, li) => {
    for (let k = 0; k < isl.count; k++) {
      const n = nodeOf.get(`${li}:${k}`);
      const root = n === undefined ? -1 - parent.length - li * 1e7 - k : find(n);
      if (rootsWithPads.has(root) || loose.has(root)) continue;
      const f = floating.get(root) ?? { area: 0, biggest: { layer: li, island: k, area: 0 } };
      f.area += isl.area[k]!;
      if (isl.area[k]! > f.biggest.area) f.biggest = { layer: li, island: k, area: isl.area[k]! };
      floating.set(root, f);
    }
  });
  const floats = [...floating.values()].filter((f) => f.area >= FLOATING_MM2).sort((a, b) => b.area - a.area);
  for (const f of floats) {
    const isl = islandsByLayer[f.biggest.layer]!;
    const b = isl.box[f.biggest.island]!;
    const p = isl.point[f.biggest.island]!;
    const layer = ids[f.biggest.layer]!;
    const meant = (design.areas ?? []).filter((a) => a.layer === layer && p.x >= a.box[0] && p.x <= a.box[2] && p.y >= a.box[1] && p.y <= a.box[3]).map((a) => a.net);
    findings.push({
      kind: 'floating',
      nets: [...new Set(meant)],
      text: `${Math.round(f.area * 10) / 10} mm² of copper on ${layer} is joined to no pad (x ${mm(b[0])}–${mm(b[2])}, y ${mm(b[1])}–${mm(b[3])})${meant.length ? `, where the board has ${list([...new Set(meant)])} copper` : ''}`,
      layer,
      at: p,
      area: around(b, 0.5),
      pads: [],
    });
  }

  const rank: Record<CopperFindingKind, number> = { short: 0, open: 1, pad: 2, floating: 3 };
  findings.sort((a, b) => rank[a.kind] - rank[b.kind]);
  const copper = Object.fromEntries(
    islandsByLayer.map((isl, li) => [ids[li]!, { area: Math.round(isl.area.reduce((a, v) => a + v, 0) * 1000) / 1000, islands: isl.count }]),
  );
  return {
    findings,
    copper,
    found: pads.length,
    total: all.length,
    notFound,
    openInDesign,
    nets: byNet.size,
    layers: ids,
    holes: holes.length,
    resolution: Math.round(res * 1e4) / 1e4,
    ms: Math.round(performance.now() - t0),
  };
}

/** The check for a set of files read back (readFabFiles): its copper layers top down and its plated holes; null without copper or without the design's pads in it. */
export function checkFabSet(set: FabSet, design: NetDesign, opts: { fresh?: boolean } = {}): CopperCheck | null {
  const copper = set.files.filter((f) => f.layer.kind === 'copper').sort((a, b) => (a.layer.order ?? 0) - (b.layer.order ?? 0));
  if (!copper.length) return null;
  const holes = set.files.filter((f) => f.layer.kind === 'drill' && f.layer.plated !== false).flatMap((f) => f.holes.filter((h) => h.plated !== false));
  return checkCopper(copper.map((f) => ({ id: f.layer.id, objects: f.objects })), holes, design, opts);
}

/** The check in words: what was compared, then each finding (positions in the files' coordinates). */
export function copperCheckText(c: CopperCheck, opts: { max?: number } = {}): string {
  const lines: string[] = [];
  const counts = (['short', 'open', 'pad', 'floating'] as const).map((k) => [k, c.findings.filter((f) => f.kind === k).length] as const).filter(([, n]) => n);
  const words = { short: ['short', 'shorts'], open: ['open', 'opens'], pad: ['pad without copper', 'pads without copper'], floating: ['piece of copper joined to nothing', 'pieces of copper joined to nothing'] } as const;
  const what = `${plural(c.found, 'pad')} of ${c.total} found where the board has them, ${plural(c.nets, 'net')}, ${c.layers.length} copper layers, ${plural(c.holes, 'plated hole')}`;
  lines.push(
    counts.length
      ? `Netlist check of the files: ${counts.map(([k, n]) => `${n} ${n === 1 ? words[k][0] : words[k][1]}`).join(', ')} (${what}).`
      : `Netlist check of the files: the copper joins every net's pads and no two nets (${what}).`,
  );
  if (c.notFound.length) lines.push(`Not in the files where the board has them (moved since the files were made?), so not checked: ${list(c.notFound, 12)}.`);
  if (c.openInDesign) lines.push(`${plural(c.openInDesign, 'connection')} the board leaves unrouted ${c.openInDesign === 1 ? 'is' : 'are'} open in the files too (not counted above).`);
  const max = opts.max ?? 12;
  for (const f of c.findings.slice(0, max)) lines.push(`- ${f.text}; at ${at(f.at)}.`);
  if (c.findings.length > max) lines.push(`- and ${c.findings.length - max} more.`);
  return lines.join('\n');
}
