/**
 * The path of a schematic wire the agent asks for (drawing ops, `wire`): orthogonal, on the grid
 * of its two pins, leaving and entering each pin outwards, never through a part, along a wire of
 * another net or onto another net's pin or wire end. Bends and crossings cost, so the path is the
 * plain one a person would draw. The agent can force corners (`via`).
 */
import type { PinView, Point, Rect, SymbolView, WireView } from '@4k7/schema';
import { GRID } from '@4k7/parts';

export interface RouteEnd {
  x: number;
  y: number;
  side: PinView['side'];
}

export interface RouteInput {
  from: RouteEnd;
  to: RouteEnd;
  via: Point[];
  net: string;
  symbols: SymbolView[];
  wires: WireView[];
  /** Boxes to keep clear of where possible (labels, text). */
  soft: Rect[];
  /** Where the wire may go (the page's drawing area). */
  bounds: Rect;
}

const BEND = 300;
const CROSS = 400;
const SOFT = 600;

const OUT: Record<PinView['side'], [number, number]> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** The wire's points, corners only; null when there is no way through. */
export function routeWire(r: RouteInput): number[] | null {
  const stops: { p: Point; out?: [number, number]; into?: [number, number] }[] = [
    { p: r.from, out: OUT[r.from.side] },
    ...r.via.map((p) => ({ p })),
    { p: r.to, into: OUT[r.to.side].map((v) => -v) as [number, number] },
  ];
  const pts: Point[] = [{ x: r.from.x, y: r.from.y }];
  for (let i = 0; i + 1 < stops.length; i++) {
    const leg = routeLeg(r, stops[i]!.p, stops[i + 1]!.p, stops[i]!.out, stops[i + 1]!.into, pts.length > 1 ? dirOf(pts.at(-2)!, pts.at(-1)!) : undefined);
    if (!leg) return null;
    pts.push(...leg.slice(1));
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
  for (const t of through) {
    for (let v = t; v >= lo; v -= GRID) out.add(v);
    for (let v = t + GRID; v <= hi; v += GRID) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

function routeLeg(r: RouteInput, a: Point, b: Point, out?: [number, number], into?: [number, number], came?: [number, number]): Point[] | null {
  const bx0 = Math.min(r.bounds.x, a.x, b.x);
  const bx1 = Math.max(r.bounds.x + r.bounds.w, a.x, b.x);
  const by0 = Math.min(r.bounds.y, a.y, b.y);
  const by1 = Math.max(r.bounds.y + r.bounds.h, a.y, b.y);
  const xs = lattice(bx0, bx1, [a.x, b.x]);
  const ys = lattice(by0, by1, [a.y, b.y]);
  const nx = xs.length;
  const ny = ys.length;
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));
  const ends = new Set([`${a.x},${a.y}`, `${b.x},${b.y}`]);

  // what each node is: inside a part, on a foreign pin or wire end (blocked), on a foreign wire (crossing only)
  const blocked = new Uint8Array(nx * ny);
  const onH = new Uint8Array(nx * ny); // on a foreign horizontal segment's inside
  const onV = new Uint8Array(nx * ny);
  const soft = new Uint8Array(nx * ny);
  const id = (i: number, j: number) => j * nx + i;
  const span = (vals: number[], lo: number, hi: number) => {
    let s = 0;
    while (s < vals.length && vals[s]! < lo) s++;
    let e = s;
    while (e < vals.length && vals[e]! <= hi) e++;
    return [s, e] as const;
  };
  for (const s of r.symbols) {
    const [i0, i1] = span(xs, s.bbox.x + 1, s.bbox.x + s.bbox.w - 1);
    const [j0, j1] = span(ys, s.bbox.y + 1, s.bbox.y + s.bbox.h - 1);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) blocked[id(i, j)] = 1;
    for (const p of s.pins) {
      const i = xi.get(p.x);
      const j = yi.get(p.y);
      if (i !== undefined && j !== undefined && !ends.has(`${p.x},${p.y}`)) blocked[id(i, j)] = 1;
    }
  }
  for (const box of r.soft) {
    const [i0, i1] = span(xs, box.x, box.x + box.w);
    const [j0, j1] = span(ys, box.y, box.y + box.h);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) soft[id(i, j)] = 1;
  }
  const foreignH: [number, number, number][] = []; // y, x0, x1
  const foreignV: [number, number, number][] = []; // x, y0, y1
  for (const w of r.wires) {
    if (w.netId === r.net) continue;
    for (let k = 0; k + 3 < w.pts.length; k += 2) {
      const [x1, y1, x2, y2] = [w.pts[k]!, w.pts[k + 1]!, w.pts[k + 2]!, w.pts[k + 3]!];
      if (y1 === y2) foreignH.push([y1, Math.min(x1, x2), Math.max(x1, x2)]);
      else if (x1 === x2) foreignV.push([x1, Math.min(y1, y2), Math.max(y1, y2)]);
      for (const [x, y] of [[x1, y1], [x2, y2]] as const) {
        const i = xi.get(x);
        const j = yi.get(y);
        if (i !== undefined && j !== undefined) blocked[id(i, j)] = 1;
      }
    }
  }
  for (const [y, x0, x1] of foreignH) {
    const j = yi.get(y);
    if (j === undefined) continue;
    const [i0, i1] = span(xs, x0 + 1, x1 - 1);
    for (let i = i0; i < i1; i++) onH[id(i, j)] = 1;
  }
  for (const [x, y0, y1] of foreignV) {
    const i = xi.get(x);
    if (i === undefined) continue;
    const [j0, j1] = span(ys, y0 + 1, y1 - 1);
    for (let j = j0; j < j1; j++) onV[id(i, j)] = 1;
  }
  // an edge along a foreign segment that lies between lattice points
  const alongForeign = (i: number, j: number, di: number, dj: number) => {
    if (dj === 0) {
      const y = ys[j]!;
      const [p, q] = [Math.min(xs[i]!, xs[i + di]!), Math.max(xs[i]!, xs[i + di]!)];
      return foreignH.some(([fy, x0, x1]) => fy === y && x0 < q && x1 > p);
    }
    const x = xs[i]!;
    const [p, q] = [Math.min(ys[j]!, ys[j + dj]!), Math.max(ys[j]!, ys[j + dj]!)];
    return foreignV.some(([fx, y0, y1]) => fx === x && y0 < q && y1 > p);
  };

  const si = xi.get(a.x)!;
  const sj = yi.get(a.y)!;
  const ti = xi.get(b.x)!;
  const tj = yi.get(b.y)!;
  const dirIndex = (d: [number, number]) => DIRS.findIndex(([x, y]) => x === d[0] && y === d[1]);
  // states: node × the direction it was entered (4 = the start, no direction yet)
  const S = nx * ny * 5;
  const cost = new Float64Array(S).fill(Infinity);
  const prev = new Int32Array(S).fill(-1);
  const heap = new Heap();
  const h = (i: number, j: number) => Math.abs(xs[i]! - b.x) + Math.abs(ys[j]! - b.y);
  const start = id(si, sj) * 5 + (came ? dirIndex(came) : 4);
  cost[start] = 0;
  heap.push(start, h(si, sj));
  let goal = -1;
  while (heap.size) {
    const st = heap.pop();
    const node = Math.floor(st / 5);
    const din = st % 5;
    const i = node % nx;
    const j = Math.floor(node / nx);
    if (i === ti && j === tj && (!into || din === dirIndex(into))) {
      goal = st;
      break;
    }
    const c = cost[st]!;
    for (let k = 0; k < 4; k++) {
      const [di, dj] = DIRS[k]!;
      if (din === 4 && out && (di !== out[0] || dj !== out[1])) continue;
      if (din < 4 && DIRS[din]![0] === -di && DIRS[din]![1] === -dj) continue; // no turning back
      const i2 = i + di;
      const j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) continue;
      const n2 = id(i2, j2);
      const isEnd = i2 === ti && j2 === tj;
      if (blocked[n2] && !isEnd) continue;
      if (alongForeign(i, j, di, dj)) continue;
      // through a foreign wire only straight across, never along it or turning on it
      const bend = din < 4 && din !== k;
      if ((onH[node] || onV[node]) && bend && !(i === si && j === sj)) continue;
      if (dj === 0 ? onH[n2] : onV[n2]) continue;
      let step = Math.abs(xs[i2]! - xs[i]!) + Math.abs(ys[j2]! - ys[j]!);
      if (bend) step += BEND;
      if (dj === 0 ? onV[n2] : onH[n2]) step += CROSS;
      if (soft[n2] && !isEnd) step += SOFT;
      // turn on the target's grid rather than the start's, so the wire does not end in a short jog
      if ((xs[i2]! - b.x) % GRID || (ys[j2]! - b.y) % GRID) step += 1;
      const s2 = n2 * 5 + k;
      if (c + step < cost[s2]!) {
        cost[s2] = c + step;
        prev[s2] = st;
        heap.push(s2, c + step + h(i2, j2));
      }
    }
  }
  if (goal < 0) return null;
  const path: Point[] = [];
  for (let st = goal; st >= 0; st = prev[st]!) {
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
