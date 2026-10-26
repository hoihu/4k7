/**
 * The path of a schematic wire (drawing ops `wire`, the wire clean-up): orthogonal, on the grid of
 * its ends, leaving and entering each pin outwards, never through a part, along a wire or onto a
 * pin or wire end that is not one of its ends. It runs from one drawn piece of a net to another:
 * from a pin or anywhere on the wires already joined to it, to a pin or anywhere on the wires
 * joined to that (a T onto a wire), so a net drawn bit by bit stays one tree. Bends and crossings
 * cost, so the path is the plain one a person would draw. The agent can force corners (`via`).
 */
import type { PinView, Point, Rect, SymbolView, WireView } from '@4k7/schema';
import { GRID } from '@4k7/parts';

export interface RouteInput {
  /** Where the wire may start: pins or label spots, and the wires joined to them (polylines). */
  from: Point[];
  fromWires: number[][];
  /** Where it may end, likewise. */
  to: Point[];
  toWires: number[][];
  via: Point[];
  /** Everything drawn on the page (every net, the two pieces included): never run along it. */
  wires: WireView[];
  symbols: SymbolView[];
  /** Boxes to keep clear of where possible (labels, text). */
  soft: Rect[];
  /** Where the wire may go (the page's drawing area). */
  bounds: Rect;
  /** Spots the wire must not reach moving this way (a label: not through its text). */
  forbid?: Map<string, [number, number]>;
}

const BEND = 300;
const CROSS = 400;
const SOFT = 600;

const OUT: Record<PinView['side'], [number, number]> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const key = (x: number, y: number) => `${x},${y}`;

type Seg = [number, number, number, number];
const segsOf = (pts: number[]): Seg[] => {
  const out: Seg[] = [];
  for (let k = 0; k + 3 < pts.length; k += 2) out.push([pts[k]!, pts[k + 1]!, pts[k + 2]!, pts[k + 3]!]);
  return out;
};

/** One leg's ends: points (a pin's way out or in comes from the pin there) and wires to start or end anywhere on. */
interface Ends {
  pts: Point[];
  segs: Seg[];
}

/** The wire's points, corners only; null when there is no way through. */
export function routeWire(r: RouteInput): number[] | null {
  const legs: Ends[] = [
    { pts: r.from, segs: r.fromWires.flatMap(segsOf) },
    ...r.via.map((p) => ({ pts: [p], segs: [] })),
    { pts: r.to, segs: r.toWires.flatMap(segsOf) },
  ];
  const pts: Point[] = [];
  for (let i = 0; i + 1 < legs.length; i++) {
    const from = pts.length ? { pts: [pts.at(-1)!], segs: [] } : legs[i]!;
    const leg = routeLeg(r, from, legs[i + 1]!, pts.length > 1 ? dirOf(pts.at(-2)!, pts.at(-1)!) : undefined);
    if (!leg) return null;
    pts.push(...(pts.length ? leg.slice(1) : leg));
  }
  return corners(pts);
}

function dirOf(a: Point, b: Point): [number, number] {
  return [Math.sign(b.x - a.x), Math.sign(b.y - a.y)];
}

/** Only the points where the wire turns. */
function corners(pts: Point[]): number[] {
  const keep: Point[] = [];
  for (const p of pts) {
    if (keep.length && keep.at(-1)!.x === p.x && keep.at(-1)!.y === p.y) continue;
    if (keep.length >= 2) {
      const a = keep.at(-2)!;
      const b = keep.at(-1)!;
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) keep.pop();
    }
    keep.push(p);
  }
  return keep.flatMap((p) => [p.x, p.y]);
}

/** The coordinates a leg may use: the grid through each end, inside the bounds. */
function lattice(lo: number, hi: number, through: number[]): number[] {
  const out = new Set<number>(through);
  for (const t of new Set(through.map((v) => ((v % GRID) + GRID) % GRID))) {
    for (let v = lo - (((lo - t) % GRID) + GRID) % GRID; v <= hi; v += GRID) if (v >= lo) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

function routeLeg(r: RouteInput, A: Ends, B: Ends, came?: [number, number]): Point[] | null {
  const coords = (f: (p: Point) => number, g: (s: Seg) => number[]) => [...A.pts.map(f), ...B.pts.map(f), ...A.segs.flatMap(g), ...B.segs.flatMap(g)];
  const allX = coords((p) => p.x, (s) => [s[0], s[2]]);
  const allY = coords((p) => p.y, (s) => [s[1], s[3]]);
  const bx0 = Math.min(r.bounds.x, ...allX);
  const bx1 = Math.max(r.bounds.x + r.bounds.w, ...allX);
  const by0 = Math.min(r.bounds.y, ...allY);
  const by1 = Math.max(r.bounds.y + r.bounds.h, ...allY);
  const xs = lattice(bx0, bx1, allX);
  const ys = lattice(by0, by1, allY);
  const nx = xs.length;
  const ny = ys.length;
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));
  const id = (i: number, j: number) => j * nx + i;
  const span = (vals: number[], lo: number, hi: number) => {
    let s = 0;
    while (s < vals.length && vals[s]! < lo) s++;
    let e = s;
    while (e < vals.length && vals[e]! <= hi) e++;
    return [s, e] as const;
  };
  /** Every lattice node on a segment (ends included). */
  const nodesOn = ([x1, y1, x2, y2]: Seg): number[] => {
    const out: number[] = [];
    if (y1 === y2) {
      const j = yi.get(y1);
      if (j === undefined) return out;
      const [i0, i1] = span(xs, Math.min(x1, x2), Math.max(x1, x2));
      for (let i = i0; i < i1; i++) out.push(id(i, j));
    } else {
      const i = xi.get(x1);
      if (i === undefined) return out;
      const [j0, j1] = span(ys, Math.min(y1, y2), Math.max(y1, y2));
      for (let j = j0; j < j1; j++) out.push(id(i, j));
    }
    return out;
  };
  const nodeAt = (p: Point) => {
    const i = xi.get(p.x);
    const j = yi.get(p.y);
    return i === undefined || j === undefined ? -1 : id(i, j);
  };

  // the two ends: start and goal nodes; at a pin the wire leaves (or enters) outwards
  const start = new Uint8Array(nx * ny);
  const goal = new Uint8Array(nx * ny);
  for (const p of A.pts) if (nodeAt(p) >= 0) start[nodeAt(p)] = 1;
  for (const s of A.segs) for (const n of nodesOn(s)) start[n] = 1;
  for (const p of B.pts) if (nodeAt(p) >= 0) goal[nodeAt(p)] = 1;
  for (const s of B.segs) for (const n of nodesOn(s)) goal[n] = 1;
  // (a pin its piece's wires already run to takes a wire from any side: the lead out of it is drawn)
  const wired = (p: Point) => [...A.segs, ...B.segs].some(([x1, y1, x2, y2]) => p.x >= Math.min(x1, x2) && p.x <= Math.max(x1, x2) && p.y >= Math.min(y1, y2) && p.y <= Math.max(y1, y2));
  const pinWay = new Map<number, [number, number]>();
  for (const s of r.symbols) {
    for (const p of s.pins) {
      const n = nodeAt(p);
      if (n >= 0 && (start[n] || goal[n]) && !wired(p)) pinWay.set(n, OUT[p.side]);
    }
  }

  // what each node is: inside a part, on a pin or wire end that is not an end (blocked), on a wire (crossing only)
  const blocked = new Uint8Array(nx * ny);
  const onH = new Uint8Array(nx * ny); // on a horizontal segment's inside
  const onV = new Uint8Array(nx * ny);
  const soft = new Uint8Array(nx * ny);
  const free = (n: number) => start[n] || goal[n];
  for (const s of r.symbols) {
    const [i0, i1] = span(xs, s.bbox.x + 1, s.bbox.x + s.bbox.w - 1);
    const [j0, j1] = span(ys, s.bbox.y + 1, s.bbox.y + s.bbox.h - 1);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) blocked[id(i, j)] = 1;
    for (const p of s.pins) {
      const n = nodeAt(p);
      if (n >= 0 && !free(n)) blocked[n] = 1;
    }
  }
  for (const box of r.soft) {
    const [i0, i1] = span(xs, box.x, box.x + box.w);
    const [j0, j1] = span(ys, box.y, box.y + box.h);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) soft[id(i, j)] = 1;
  }
  const wireH: [number, number, number][] = []; // y, x0, x1
  const wireV: [number, number, number][] = []; // x, y0, y1
  for (const w of r.wires) {
    for (const [x1, y1, x2, y2] of segsOf(w.pts)) {
      if (y1 === y2 && x1 !== x2) wireH.push([y1, Math.min(x1, x2), Math.max(x1, x2)]);
      else if (x1 === x2 && y1 !== y2) wireV.push([x1, Math.min(y1, y2), Math.max(y1, y2)]);
      for (const n of [nodeAt({ x: x1, y: y1 }), nodeAt({ x: x2, y: y2 })]) if (n >= 0 && !free(n)) blocked[n] = 1;
    }
  }
  for (const [y, x0, x1] of wireH) {
    const j = yi.get(y);
    if (j === undefined) continue;
    const [i0, i1] = span(xs, x0 + 1, x1 - 1);
    for (let i = i0; i < i1; i++) onH[id(i, j)] = 1;
  }
  for (const [x, y0, y1] of wireV) {
    const i = xi.get(x);
    if (i === undefined) continue;
    const [j0, j1] = span(ys, y0 + 1, y1 - 1);
    for (let j = j0; j < j1; j++) onV[id(i, j)] = 1;
  }
  // an edge along a drawn segment that lies between lattice points
  const alongWire = (i: number, j: number, di: number, dj: number) => {
    if (dj === 0) {
      const y = ys[j]!;
      const [p, q] = [Math.min(xs[i]!, xs[i + di]!), Math.max(xs[i]!, xs[i + di]!)];
      return wireH.some(([fy, x0, x1]) => fy === y && x0 < q && x1 > p);
    }
    const x = xs[i]!;
    const [p, q] = [Math.min(ys[j]!, ys[j + dj]!), Math.max(ys[j]!, ys[j + dj]!)];
    return wireV.some(([fx, y0, y1]) => fx === x && y0 < q && y1 > p);
  };

  // the heuristic: the distance to the nearest goal point or wire
  const goalPts = B.pts;
  const toSeg = (x: number, y: number, [x1, y1, x2, y2]: Seg) => Math.abs(x - Math.min(Math.max(x, Math.min(x1, x2)), Math.max(x1, x2))) + Math.abs(y - Math.min(Math.max(y, Math.min(y1, y2)), Math.max(y1, y2)));
  const h = (i: number, j: number) => {
    const [x, y] = [xs[i]!, ys[j]!];
    let best = Infinity;
    for (const p of goalPts) best = Math.min(best, Math.abs(x - p.x) + Math.abs(y - p.y));
    for (const s of B.segs) best = Math.min(best, toSeg(x, y, s));
    return best;
  };
  // turn on a goal's grid rather than the start's, so the wire does not end in a short jog
  const aim = B.pts[0] ?? (B.segs[0] ? { x: B.segs[0][0], y: B.segs[0][1] } : undefined);

  const dirIndex = (d: [number, number]) => DIRS.findIndex(([x, y]) => x === d[0] && y === d[1]);
  // states: node × the direction it was entered (4 = a start, no direction yet)
  const S = nx * ny * 5;
  const cost = new Float64Array(S).fill(Infinity);
  const prev = new Int32Array(S).fill(-1);
  const heap = new Heap();
  for (let n = 0; n < nx * ny; n++) {
    if (!start[n]) continue;
    const st = n * 5 + (came ? dirIndex(came) : 4);
    cost[st] = 0;
    heap.push(st, h(n % nx, Math.floor(n / nx)));
  }
  let found = -1;
  while (heap.size) {
    const st = heap.pop();
    const node = Math.floor(st / 5);
    const din = st % 5;
    const i = node % nx;
    const j = Math.floor(node / nx);
    if (goal[node] && din < 4) {
      const way = pinWay.get(node);
      const no = r.forbid?.get(key(xs[i]!, ys[j]!));
      const [dx, dy] = DIRS[din]!;
      if ((!way || (dx === -way[0] && dy === -way[1])) && (!no || dx !== no[0] || dy !== no[1])) {
        found = st;
        break;
      }
    }
    const c = cost[st]!;
    const out = din === 4 ? pinWay.get(node) : undefined;
    for (let k = 0; k < 4; k++) {
      const [di, dj] = DIRS[k]!;
      if (out && (di !== out[0] || dj !== out[1])) continue;
      if (din < 4 && DIRS[din]![0] === -di && DIRS[din]![1] === -dj) continue; // no turning back
      const i2 = i + di;
      const j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) continue;
      const n2 = id(i2, j2);
      if (blocked[n2] && !goal[n2]) continue;
      if (start[n2] && !goal[n2]) continue; // back onto where it started
      if (alongWire(i, j, di, dj)) continue;
      // through a wire only straight across, never along it or turning on it
      const bend = din < 4 && din !== k;
      if ((onH[node] || onV[node]) && bend && !start[node]) continue;
      if (!goal[n2] && (dj === 0 ? onH[n2] : onV[n2])) continue;
      let step = Math.abs(xs[i2]! - xs[i]!) + Math.abs(ys[j2]! - ys[j]!);
      if (bend) step += BEND;
      if (!goal[n2] && (dj === 0 ? onV[n2] : onH[n2])) step += CROSS;
      if (soft[n2] && !goal[n2]) step += SOFT;
      if (aim && ((xs[i2]! - aim.x) % GRID || (ys[j2]! - aim.y) % GRID)) step += 1;
      const s2 = n2 * 5 + k;
      if (c + step < cost[s2]!) {
        cost[s2] = c + step;
        prev[s2] = st;
        heap.push(s2, c + step + h(i2, j2));
      }
    }
  }
  if (found < 0) return null;
  const path: Point[] = [];
  for (let st = found; st >= 0; st = prev[st]!) {
    const node = Math.floor(st / 5);
    path.push({ x: xs[node % nx]!, y: ys[Math.floor(node / nx)]! });
  }
  return path.reverse();
}

/** A binary min-heap of states by priority. */
class Heap {
  private items: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.items.length;
  }
  push(item: number, key: number) {
    const a = this.items;
    const k = this.keys;
    a.push(item);
    k.push(key);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p]! <= k[i]!) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      [k[p], k[i]] = [k[i]!, k[p]!];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const k = this.keys;
    const top = a[0]!;
    const lastA = a.pop()!;
    const lastK = k.pop()!;
    if (a.length) {
      a[0] = lastA;
      k[0] = lastK;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && k[l]! < k[m]!) m = l;
        if (r < a.length && k[r]! < k[m]!) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        [k[m], k[i]] = [k[i]!, k[m]!];
        i = m;
      }
    }
    return top;
  }
}
