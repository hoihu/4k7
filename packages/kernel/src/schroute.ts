/**
 * The path of a schematic wire (drawing ops `wire`, the wire clean-up): orthogonal, on the grid of
 * its ends, never through a part, along a wire or onto a pin or wire end that is not one of its
 * ends (`through` lets it through the pins of its own net). It joins a pin from any side but the
 * part's own; the side costs a corner, because it draws one with the pin's lead. It runs from one
 * drawn piece of a net to another: from a pin or anywhere on the wires already joined to it, to a
 * pin or anywhere on the wires joined to that (a T onto a wire), so a net drawn bit by bit stays
 * one tree. Bends and crossings cost, so the path is the plain one a person would draw. The agent
 * can force corners (`via`).
 */
import type { PinView, Point, Rect, SymbolView, WireView } from '@4k7/schema';
import { GRID } from '@4k7/parts';
import { segmentsOf, type Seg } from './geom.ts';
import { Heap } from './heap.ts';
import { RETURN_LEG } from './scene.ts';

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
  /** Spots the wire must not reach moving this way, nor leave the opposite way (a label: not through its text). */
  forbid?: Map<string, [number, number]>;
  /** Pins of the wire's own net: it runs through their ends, which joins them, rather than hop over. */
  through?: Point[];
}

/** What one more corner, a crossing and running through text cost against length. */
export const BEND = 300;
export const CROSS = 400;
export const SOFT = 600;

const OUT: Record<PinView['side'], [number, number]> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const key = (x: number, y: number) => `${x},${y}`;


/** One leg's ends: points (a pin's way out or in comes from the pin there) and wires to start or end anywhere on. */
interface Ends {
  pts: Point[];
  segs: Seg[];
}

/** The wire's points, corners only; null when there is no way through. */
export function routeWire(r: RouteInput): number[] | null {
  const pts = pathOf(r, BEND);
  // a run as long as a row (the return from one row of a chain to the next) goes straight out of its
  // pins where a stub will do, as the clean-up keeps it: off their side counts twice
  return pts && offSideOfLong(r, pts) ? (pathOf(r, 2 * BEND) ?? pts) : pts;
}

function pathOf(r: RouteInput, side: number): number[] | null {
  const from: Ends = { pts: r.from, segs: r.fromWires.flatMap(segmentsOf) };
  const to: Ends = { pts: r.to, segs: r.toWires.flatMap(segmentsOf) };
  // it sets off from the last corner on what is drawn at its start (a pin itself, the wires joined
  // to it) and is done at the first on what is drawn at its end: the way along those is there already
  const via = r.via.slice(r.via.findLastIndex((p) => reaches(from, p)) + 1);
  const done = via.findIndex((p) => reaches(to, p));
  const legs: Ends[] = [from, ...(done < 0 ? via : via.slice(0, done)).map((p) => ({ pts: [p], segs: [] })), to];
  const pts: Point[] = [];
  for (let i = 0; i + 1 < legs.length; i++) {
    if (pts.length && reaches(legs[i + 1]!, pts.at(-1)!)) continue; // the same corner twice
    const start = pts.length ? { pts: [pts.at(-1)!], segs: [] } : legs[i]!;
    const leg = routeLeg(r, start, legs[i + 1]!, side, pts.length > 1 ? dirOf(pts.at(-2)!, pts.at(-1)!) : undefined);
    if (!leg) return null;
    pts.push(...(pts.length ? leg.slice(1) : leg));
  }
  return corners(pts);
}

/** A run as long as a row, on a wire that leaves a pin to the side at either end. */
function offSideOfLong(r: RouteInput, pts: number[]): boolean {
  if (!segmentsOf(pts).some(([x1, y1, x2, y2]) => Math.abs(x2 - x1) + Math.abs(y2 - y1) >= RETURN_LEG)) return false;
  const off = (x: number, y: number, nx: number, ny: number) => {
    const pin = r.symbols.flatMap((s) => s.pins).find((p) => p.x === x && p.y === y);
    return !!pin && (Math.sign(nx - x) !== OUT[pin.side][0] || Math.sign(ny - y) !== OUT[pin.side][1]);
  };
  return off(pts[0]!, pts[1]!, pts[2]!, pts[3]!) || off(pts.at(-2)!, pts.at(-1)!, pts.at(-4)!, pts.at(-3)!);
}

const onSegs = (segs: Seg[], p: Point) => segs.some(([x1, y1, x2, y2]) => p.x >= Math.min(x1, x2) && p.x <= Math.max(x1, x2) && p.y >= Math.min(y1, y2) && p.y <= Math.max(y1, y2));
const reaches = (e: Ends, p: Point) => e.pts.some((q) => q.x === p.x && q.y === p.y) || onSegs(e.segs, p);

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

function routeLeg(r: RouteInput, A: Ends, B: Ends, side: number, came?: [number, number]): Point[] | null {
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

  // the two ends: start and goal nodes
  const start = new Uint8Array(nx * ny);
  const goal = new Uint8Array(nx * ny);
  for (const p of A.pts) if (nodeAt(p) >= 0) start[nodeAt(p)] = 1;
  for (const s of A.segs) for (const n of nodesOn(s)) start[n] = 1;
  for (const p of B.pts) if (nodeAt(p) >= 0) goal[nodeAt(p)] = 1;
  for (const s of B.segs) for (const n of nodesOn(s)) goal[n] = 1;
  // a wire goes on from a pin's lead: straight out it draws no corner, to the side one, back never
  // (at a pin its piece's wires already run to it makes a T, whichever way it goes)
  const wired = (p: Point) => onSegs([...A.segs, ...B.segs], p);
  const lead = new Map<number, [number, number]>();
  for (const s of r.symbols) {
    for (const p of s.pins) {
      const n = nodeAt(p);
      if (n >= 0 && (start[n] || goal[n]) && !wired(p)) lead.set(n, OUT[p.side]);
    }
  }

  // what each node is: inside a part, on a pin or wire end that is not an end (blocked), on a wire (crossing only)
  const blocked = new Uint8Array(nx * ny);
  const onH = new Uint8Array(nx * ny); // on a horizontal segment's inside
  const onV = new Uint8Array(nx * ny);
  const soft = new Uint8Array(nx * ny);
  const through = new Set((r.through ?? []).map(nodeAt));
  const free = (n: number) => start[n] || goal[n] || through.has(n);
  // a pin between the lattice's lines (a part drawn off the wire's grid) is in the way of a run over it, like a wire along that run
  const pinsOnRow: [number, number, number][] = []; // y, x, x
  const pinsOnColumn: [number, number, number][] = []; // x, y, y
  for (const s of r.symbols) {
    const [i0, i1] = span(xs, s.bbox.x + 1, s.bbox.x + s.bbox.w - 1);
    const [j0, j1] = span(ys, s.bbox.y + 1, s.bbox.y + s.bbox.h - 1);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) blocked[id(i, j)] = 1;
    for (const p of s.pins) {
      const n = nodeAt(p);
      if (n >= 0) {
        if (!free(n)) blocked[n] = 1;
      } else if (!r.through?.some((q) => q.x === p.x && q.y === p.y)) {
        if (yi.has(p.y)) pinsOnRow.push([p.y, p.x, p.x]);
        else if (xi.has(p.x)) pinsOnColumn.push([p.x, p.y, p.y]);
      }
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
    for (const [x1, y1, x2, y2] of segmentsOf(w.pts)) {
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
  // an edge along a drawn segment, or over a pin, that lies between lattice points (by row and column: this is asked for every step of the search)
  const byLine = (segs: [number, number, number][], index: Map<number, number>, lines: number) => {
    const out: [number, number][][] = Array.from({ length: lines }, () => []);
    for (const [at, a, b] of segs) {
      const n = index.get(at);
      if (n !== undefined) out[n]!.push([a, b]);
    }
    return out;
  };
  const [rowsOfWire, columnsOfWire] = [byLine([...wireH, ...pinsOnRow], yi, ny), byLine([...wireV, ...pinsOnColumn], xi, nx)];
  const overLine = (line: [number, number][], p: number, q: number) => {
    for (let n = 0; n < line.length; n++) if (line[n]![0] < q && line[n]![1] > p) return true;
    return false;
  };
  const alongWire = (i: number, j: number, di: number, dj: number) => {
    if (dj === 0) return rowsOfWire[j]!.length > 0 && overLine(rowsOfWire[j]!, Math.min(xs[i]!, xs[i + di]!), Math.max(xs[i]!, xs[i + di]!));
    return columnsOfWire[i]!.length > 0 && overLine(columnsOfWire[i]!, Math.min(ys[j]!, ys[j + dj]!), Math.max(ys[j]!, ys[j + dj]!));
  };

  // the heuristic: the distance to the nearest goal point or wire
  const goalPts = B.pts;
  const toSeg = (x: number, y: number, [x1, y1, x2, y2]: Seg) => Math.abs(x - Math.min(Math.max(x, Math.min(x1, x2)), Math.max(x1, x2))) + Math.abs(y - Math.min(Math.max(y, Math.min(y1, y2)), Math.max(y1, y2)));
  const toGoal = new Float64Array(nx * ny).fill(-1);
  const h = (i: number, j: number) => {
    const n = id(i, j);
    if (toGoal[n]! >= 0) return toGoal[n]!;
    const [x, y] = [xs[i]!, ys[j]!];
    let best = Infinity;
    for (const p of goalPts) best = Math.min(best, Math.abs(x - p.x) + Math.abs(y - p.y));
    for (const s of B.segs) best = Math.min(best, toSeg(x, y, s));
    return (toGoal[n] = best);
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
    const going = came ?? lead.get(n);
    const st = n * 5 + (going ? dirIndex(going) : 4);
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
    if (goal[node] && din < 4 && prev[st]! >= 0) {
      const no = r.forbid?.get(key(xs[i]!, ys[j]!));
      const [dx, dy] = DIRS[din]!;
      if (!no || dx !== no[0] || dy !== no[1]) {
        found = st;
        break;
      }
    }
    const c = cost[st]!;
    // (a spot it sets off from: out the way it may not come in is through the same text or symbol)
    const notOut = prev[st]! < 0 ? r.forbid?.get(key(xs[i]!, ys[j]!)) : undefined;
    for (let k = 0; k < 4; k++) {
      const [di, dj] = DIRS[k]!;
      if (din < 4 && DIRS[din]![0] === -di && DIRS[din]![1] === -dj) continue; // no turning back
      if (notOut && di === -notOut[0] && dj === -notOut[1]) continue;
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
      const into = goal[n2] ? lead.get(n2) : undefined;
      if (into && di === into[0] && dj === into[1]) continue; // from behind the pin: through its part
      let step = Math.abs(xs[i2]! - xs[i]!) + Math.abs(ys[j2]! - ys[j]!);
      if (bend) step += prev[st]! < 0 && !came && lead.has(node) ? side : BEND; // (off a pin's lead: its corner)
      if (into && (di !== -into[0] || dj !== -into[1])) step += side; // the corner with its lead
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
