/**
 * Clean-up of a stored drawing's wires (docs/design/schematic-drawing.md §2a): the agent draws wire
 * by wire, each routed on its own, so a net drawn bit by bit (and redrawn by Optimize) collects
 * loops, runs drawn twice and detours. After every change, each net's wires are taken apart at
 * every point where something joins them (a pin, a label, a wire end on another wire) and put
 * together again as a tree: one way between any two of its pins and labels (the shortest pieces
 * kept), nothing that leads nowhere. Then each run between two joints loses its U-turns and steps
 * where a straighter way is clear. A piece still drawn badly (a U-turn left, or loops) is also drawn afresh the way a person would, from pin to pin onto what is drawn
 * already, and the cleaner of the two is kept. What is connected never changes: a wire joins only
 * where an end touches, and a moved piece touches nothing new. A net that needs none of this keeps
 * its wires; a wire drawn through the agent's corners (wire via) keeps its path.
 */
import type { Design, PinView, Point, Rect, SheetDrawing, SymbolView } from '@4k7/schema';
import { labelRect, textRect } from './scene.ts';
import { routeWire } from './schroute.ts';

type Pt = { x: number; y: number };
type Wire = { netId: string; pts: number[]; via?: boolean };
type Seg = [number, number, number, number];

/** What one more corner, a crossing and running through text cost against length (as the router counts). */
const BEND = 300;
const CROSS = 400;
const SOFT = 600;

const key = (x: number, y: number) => `${x},${y}`;
const OUT: Record<PinView['side'], [number, number]> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

interface Sheet {
  pins: { x: number; y: number; net: string | null; side: PinView['side'] }[];
  labels: SheetDrawing['labels'];
  bodies: Rect[];
  soft: { net: string | null; r: Rect }[];
  symbols: SymbolView[];
  /** The drawing area of the page a point is on; null when it is on none. */
  area: (p: Point) => Rect | null;
}

/** Clean every net's wires; true if any changed. */
export function cleanWires(d: Design, sd: SheetDrawing, symbols: SymbolView[], area: Sheet['area']): boolean {
  const sheet: Sheet = {
    symbols,
    area,
    pins: symbols.flatMap((s) => s.pins.map((p) => ({ x: p.x, y: p.y, net: d.components[s.componentId]?.pins[p.number] ?? null, side: p.side }))),
    labels: sd.labels,
    bodies: symbols.map((s) => s.bbox),
    soft: [
      ...sd.labels.map((l) => ({ net: l.netId, r: labelRect({ ...l, text: d.nets[l.netId]?.name ?? '' }) })),
      ...symbols.flatMap((s) => [{ net: null, r: textRect(s.refPos, [s.refdes]) }, { net: null, r: textRect(s.valuePos, [s.refdes]) }]),
    ],
  };
  const nets = [...new Set(sd.wires.map((w) => w.netId))];
  let wires: Wire[] = sd.wires.map((w) => ({ ...w, pts: [...w.pts] }));
  let changed = false;
  for (const net of nets) {
    const mine = wires.filter((w) => w.netId === net);
    const others = wires.filter((w) => w.netId !== net);
    const tree = treeOf(net, mine, sheet);
    if (!tree) continue;
    const chains: Wire[] = tree.chains.map((c) => ({ netId: net, pts: c.pts, ...(c.via ? { via: true } : {}) }));
    let cur: Wire[] = [...others, ...chains];
    let better = tree.pruned;
    for (const piece of piecesOf(chains)) {
      const rest = cur.filter((w) => !piece.includes(w));
      const costs = (ws: Wire[]) => ws.reduce((n, w) => n + costOf(w.pts, net, rest, sheet), 0);
      // each run straightened where it can be (the agent's own corners stay)
      const straight = piece.map((w) => (w.via ? w : { ...w, pts: straighten(w.pts, net, [...rest, ...piece.filter((o) => o !== w)], sheet) ?? w.pts }));
      let best = straight;
      if (!piece.some((w) => w.via) && (tree.pruned || straight.some((w) => messy(w.pts)))) {
        // a piece the layout draws its own way (a bus along an IC's pins) stays messy by these rules and
        // is tried again after every change: the outcome is remembered for the same piece in the same place
        const memo = `${net}|${JSON.stringify(straight.map((w) => w.pts))}|${JSON.stringify(rest.map((w) => w.pts))}|${JSON.stringify(sheet.pins)}`;
        let fresh = redrawn.get(memo);
        if (fresh === undefined) {
          const r = redraw(net, straight, rest, sheet);
          fresh = r && costs(r) < costs(straight) ? r : null;
          if (redrawn.size > 200) redrawn.delete(redrawn.keys().next().value!);
          redrawn.set(memo, fresh);
        }
        if (fresh) best = fresh.map((w) => ({ ...w, pts: [...w.pts] }));
      }
      if (JSON.stringify(best.map((w) => w.pts)) !== JSON.stringify(piece.map((w) => w.pts))) better = true;
      cur = [...rest, ...best];
    }
    if (!better) continue;
    wires = cur;
    changed = true;
  }
  if (changed) sd.wires = wires;
  return changed;
}

/* ---------------------------------- tree ---------------------------------- */

/**
 * The net's wires as a tree: split at every joint, each piece once, the shortest pieces that keep
 * every pin and label joined as before (pieces of a wire drawn through the agent's corners first),
 * no piece leading nowhere. Chains run from joint to joint. Null for a net without wires.
 */
function treeOf(net: string, wires: Wire[], sheet: Sheet): { chains: Chain[]; pruned: boolean } | null {
  const segs: Seg[] = wires.flatMap((w) => segsOf(w.pts));
  const fixed = wires.filter((w) => w.via).flatMap((w) => segsOf(w.pts));
  if (!segs.length) return null;
  // the points that must stay: pins and labels of the net, and what the wires end on
  const anchors = new Set<string>();
  for (const p of sheet.pins) if (p.net === net) anchors.add(key(p.x, p.y));
  for (const l of sheet.labels) if (l.netId === net) anchors.add(key(l.x, l.y));
  const nodes = new Map<string, Pt>();
  for (const [x1, y1, x2, y2] of segs) {
    nodes.set(key(x1, y1), { x: x1, y: y1 });
    nodes.set(key(x2, y2), { x: x2, y: y2 });
  }
  for (const k of anchors) {
    const [x, y] = k.split(',').map(Number) as [number, number];
    if (segs.some((s) => onSeg(x, y, s))) nodes.set(k, { x, y });
  }
  // pieces between neighbouring nodes, each once (runs drawn twice become one)
  const edges = new Map<string, [Pt, Pt, number, boolean]>();
  for (const s of segs) {
    const on = [...nodes.values()].filter((p) => onSeg(p.x, p.y, s));
    on.sort((a, b) => a.x - b.x || a.y - b.y);
    for (let i = 0; i + 1 < on.length; i++) {
      const [a, b] = [on[i]!, on[i + 1]!];
      const k = `${key(a.x, a.y)}|${key(b.x, b.y)}`;
      const via = fixed.some((f) => onSeg(a.x, a.y, f) && onSeg(b.x, b.y, f));
      const had = edges.get(k);
      if (!had || (via && !had[3])) edges.set(k, [a, b, Math.abs(a.x - b.x) + Math.abs(a.y - b.y), via]);
    }
  }
  const total = segs.reduce((n, [x1, y1, x2, y2]) => n + Math.abs(x2 - x1) + Math.abs(y2 - y1), 0);
  // shortest pieces first (Kruskal); a piece that closes a loop is left out
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const kept: Edge[] = [];
  for (const [, [a, b, , via]] of [...edges].sort((p, q) => Number(q[1][3]) - Number(p[1][3]) || p[1][2] - q[1][2] || (p[0] < q[0] ? -1 : 1))) {
    const [ra, rb] = [find(key(a.x, a.y)), find(key(b.x, b.y))];
    if (ra === rb) continue;
    parent.set(ra, rb);
    kept.push([a, b, via]);
  }
  // pieces that lead nowhere go, end by end
  const adj = new Map<string, Set<number>>();
  const link = (k: string, i: number) => adj.set(k, (adj.get(k) ?? new Set()).add(i));
  kept.forEach(([a, b], i) => (link(key(a.x, a.y), i), link(key(b.x, b.y), i)));
  const gone = new Set<number>();
  const leaves = [...adj.keys()].filter((k) => adj.get(k)!.size === 1 && !anchors.has(k));
  while (leaves.length) {
    const k = leaves.pop()!;
    const [e] = [...adj.get(k)!];
    if (e === undefined) continue;
    gone.add(e);
    const [a, b] = kept[e]!;
    const other = key(a.x, a.y) === k ? key(b.x, b.y) : key(a.x, a.y);
    adj.get(k)!.delete(e);
    adj.get(other)!.delete(e);
    if (adj.get(other)!.size === 1 && !anchors.has(other)) leaves.push(other);
  }
  const left = kept.filter((_, i) => !gone.has(i));
  const length = left.reduce((n, [a, b]) => n + Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 0);
  return { chains: chainsOf(left, anchors), pruned: length !== total };
}

type Edge = [Pt, Pt, boolean];
interface Chain {
  pts: number[];
  /** Has a piece of a wire drawn through the agent's corners. */
  via: boolean;
}

/** The tree's pieces joined into runs from joint to joint (anchors, branches and ends), corners only. */
function chainsOf(edges: Edge[], anchors: Set<string>): Chain[] {
  const adj = new Map<string, number[]>();
  const pt = new Map<string, Pt>();
  edges.forEach(([a, b], i) => {
    for (const p of [a, b]) {
      const k = key(p.x, p.y);
      pt.set(k, p);
      adj.set(k, [...(adj.get(k) ?? []), i]);
    }
  });
  const joint = (k: string) => anchors.has(k) || adj.get(k)!.length !== 2;
  const used = new Set<number>();
  const chains: Chain[] = [];
  const walk = (start: string, first: number) => {
    const pts: Pt[] = [pt.get(start)!];
    let at = start;
    let e = first;
    let via = false;
    for (;;) {
      used.add(e);
      const [a, b, v] = edges[e]!;
      via ||= v;
      at = key(a.x, a.y) === at ? key(b.x, b.y) : key(a.x, a.y);
      pts.push(pt.get(at)!);
      if (joint(at)) break;
      const next = adj.get(at)!.find((i) => !used.has(i));
      if (next === undefined) break;
      e = next;
    }
    chains.push({ pts: corners(pts), via });
  };
  for (const k of [...adj.keys()].sort()) if (joint(k)) for (const e of adj.get(k)!) if (!used.has(e)) walk(k, e);
  return chains;
}

/** Pieces drawn afresh, by what they were and where: the cleaner drawing, or null to keep them. */
const redrawn = new Map<string, Wire[] | null>();

/** The tree's runs grouped into the pieces they make (runs meet only at their ends). */
function piecesOf(chains: Wire[]): Wire[][] {
  const parent = chains.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const at = new Map<string, number>();
  chains.forEach((w, i) => {
    for (const k of [key(w.pts[0]!, w.pts[1]!), key(w.pts.at(-2)!, w.pts.at(-1)!)]) {
      const o = at.get(k);
      if (o === undefined) at.set(k, i);
      else parent[find(i)] = find(o);
    }
  });
  const out = new Map<number, Wire[]>();
  chains.forEach((w, i) => out.set(find(i), [...(out.get(find(i)) ?? []), w]));
  return [...out.values()];
}

/* -------------------------------- redraw ---------------------------------- */

/**
 * A run that makes a U-turn (out, across, back). A run that leaves a pin sideways is not messy by
 * itself: the layout runs wires straight across pin ends on purpose (the tops of two standing parts).
 */
function messy(pts: number[]): boolean {
  const P = toPts(pts);
  for (let i = 0; i + 3 < P.length; i++) {
    const [d0, d2] = [dir(P[i]!, P[i + 1]!), dir(P[i + 2]!, P[i + 3]!)];
    if (d0[0] === -d2[0] && d0[1] === -d2[1]) return true;
  }
  return false;
}

/** Which way a wire must not arrive at a label (through its text or symbol). */
const NOT_INTO: Record<string, [number, number]> = { up: [0, 1], down: [0, -1], left: [1, 0], right: [-1, 0] };

/**
 * A piece drawn afresh, as a person would: from its first pin, each next pin or label (the nearest
 * first) joined onto what is drawn so far with the router. Null when one cannot be reached, or the
 * piece spans pages.
 */
function redraw(net: string, piece: Wire[], rest: Wire[], sheet: Sheet): Wire[] | null {
  const segs = piece.flatMap((w) => segsOf(w.pts));
  const on = (x: number, y: number) => segs.some((sg) => onSeg(x, y, sg));
  const terms = new Map<string, Point>();
  const forbid = new Map<string, [number, number]>();
  for (const p of sheet.pins) if (p.net === net && on(p.x, p.y)) terms.set(key(p.x, p.y), { x: p.x, y: p.y });
  for (const l of sheet.labels) {
    if (l.netId !== net || !on(l.x, l.y) || terms.has(key(l.x, l.y))) continue;
    terms.set(key(l.x, l.y), { x: l.x, y: l.y });
    const way = l.stub ?? l.dir;
    if (NOT_INTO[way]) forbid.set(key(l.x, l.y), NOT_INTO[way]!);
  }
  const todo = [...terms.values()].sort((a, b) => a.x - b.x || a.y - b.y);
  if (todo.length < 2) return null;
  const area = sheet.area(todo[0]!);
  const same = (r: Rect | null) => !!r && r.x === area?.x && r.y === area.y;
  if (!area || !todo.every((t) => same(sheet.area(t)))) return null;
  const soft = sheet.soft.filter((t) => t.net !== net).map((t) => t.r);
  const joined = [todo.shift()!];
  const built: number[][] = [];
  while (todo.length) {
    const far = (t: Point) => Math.min(...joined.map((j) => Math.abs(j.x - t.x) + Math.abs(j.y - t.y)), ...built.flatMap(segsOf).map((sg) => toSeg(t, sg)));
    todo.sort((a, b) => far(a) - far(b));
    const t = todo.shift()!;
    const pts = routeWire({
      from: [t],
      fromWires: [],
      to: joined,
      toWires: built,
      via: [],
      wires: [...rest, ...built.map((b) => ({ netId: net, pts: b }))],
      symbols: sheet.symbols,
      soft,
      bounds: area,
      forbid,
    });
    if (!pts) return null;
    built.push(pts);
    joined.push(t);
  }
  return built.map((pts) => ({ netId: net, pts }));
}

const toSeg = (p: Point, [x1, y1, x2, y2]: Seg) =>
  Math.abs(p.x - Math.min(Math.max(p.x, Math.min(x1, x2)), Math.max(x1, x2))) + Math.abs(p.y - Math.min(Math.max(p.y, Math.min(y1, y2)), Math.max(y1, y2)));

/* ------------------------------- straighten -------------------------------- */

/**
 * A run with its U-turns taken out (the middle piece moved back as far as the shorter arm allows)
 * and its steps moved to an end where they fold into a corner, while that is clear and cheaper.
 * Null when nothing gets better.
 */
function straighten(pts: number[], net: string, rest: Wire[], sheet: Sheet): number[] | null {
  let cur = pts;
  let cost = costOf(cur, net, rest, sheet);
  let improved = false;
  for (let round = 0; round < 20; round++) {
    let best: { pts: number[]; cost: number } | null = null;
    const P = toPts(cur);
    for (let i = 0; i + 3 < P.length; i++) {
      const d0 = dir(P[i]!, P[i + 1]!);
      const d2 = dir(P[i + 2]!, P[i + 3]!);
      const a = len(P[i]!, P[i + 1]!);
      const b = len(P[i + 2]!, P[i + 3]!);
      const shifts: number[] = [];
      if (d0[0] === -d2[0] && d0[1] === -d2[1]) shifts.push(-Math.min(a, b)); // U-turn: back by the shorter arm
      else if (d0[0] === d2[0] && d0[1] === d2[1]) shifts.push(-a, b); // step: to its start or its end
      for (const m of shifts) {
        const Q = P.map((p) => ({ ...p }));
        for (const j of [i + 1, i + 2]) (Q[j]!.x += d0[0] * m), (Q[j]!.y += d0[1] * m);
        const cand = corners(Q);
        if (!valid(cand, pts, net, rest, sheet)) continue;
        const c = costOf(cand, net, rest, sheet);
        if (c < (best?.cost ?? cost)) best = { pts: cand, cost: c };
      }
    }
    if (!best) break;
    cur = best.pts;
    cost = best.cost;
    improved = true;
  }
  return improved ? cur : null;
}

/**
 * Whether a run drawn anew is allowed: it leaves and enters pins outwards, runs through no part,
 * and touches nothing but its own two ends (no pin, label or wire end on it, no run along a wire);
 * crossing a wire straight across is fine.
 */
function valid(pts: number[], was: number[], net: string, rest: Wire[], sheet: Sheet): boolean {
  if (pts.length < 4) return false;
  const P = toPts(pts);
  const [s, e] = [P[0]!, P.at(-1)!];
  const W = toPts(was);
  if (s.x !== W[0]!.x || s.y !== W[0]!.y || e.x !== W.at(-1)!.x || e.y !== W.at(-1)!.y) return false;
  const isEnd = (x: number, y: number) => (x === s.x && y === s.y) || (x === e.x && y === e.y);
  for (const [end, next] of [[P[0]!, P[1]!], [P.at(-1)!, P.at(-2)!]] as const) {
    const pin = sheet.pins.find((p) => p.x === end.x && p.y === end.y && p.net === net);
    if (pin) {
      const [dx, dy] = dir(end, next);
      if (dx !== OUT[pin.side][0] || dy !== OUT[pin.side][1]) return false;
    }
  }
  const restSegs = rest.flatMap((w) => segsOf(w.pts).map((sg) => ({ sg, net: w.netId })));
  for (const sg of segsOf(pts)) {
    if (sheet.bodies.some((r) => throughBox(sg, r))) return false;
    for (const p of sheet.pins) if (onSeg(p.x, p.y, sg) && !(isEnd(p.x, p.y) && p.net === net)) return false;
    for (const l of sheet.labels) if (onSeg(l.x, l.y, sg) && !(isEnd(l.x, l.y) && l.netId === net)) return false;
    for (const o of restSegs) {
      const [x1, y1, x2, y2] = o.sg;
      if (horizontal(sg) === horizontal(o.sg)) {
        if (overlaps(sg, o.sg)) return false;
        continue;
      }
      const hit = crossing(sg, o.sg);
      if (!hit) continue;
      // touching at an end of either is a joint: only where this run ends, on its own net
      const atEnd = (hit.x === sg[0] && hit.y === sg[1]) || (hit.x === sg[2] && hit.y === sg[3]) || (hit.x === x1 && hit.y === y1) || (hit.x === x2 && hit.y === y2);
      if (atEnd && !(isEnd(hit.x, hit.y) && o.net === net)) return false;
    }
  }
  return true;
}

function costOf(pts: number[], net: string, rest: Wire[], sheet: Sheet): number {
  const segs = segsOf(pts);
  let c = segs.reduce((n, [x1, y1, x2, y2]) => n + Math.abs(x2 - x1) + Math.abs(y2 - y1), 0) + BEND * Math.max(0, segs.length - 1);
  for (const sg of segs) {
    for (const w of rest) for (const o of segsOf(w.pts)) if (horizontal(sg) !== horizontal(o) && strictCross(sg, o)) c += CROSS;
    for (const t of sheet.soft) if (t.net !== net && throughBox(sg, t.r)) c += SOFT;
  }
  return c;
}

/* -------------------------------- geometry -------------------------------- */

function segsOf(pts: number[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const s: Seg = [pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!];
    if (s[0] !== s[2] || s[1] !== s[3]) out.push(s);
  }
  return out;
}

const toPts = (pts: number[]): Pt[] => Array.from({ length: pts.length / 2 }, (_, i) => ({ x: pts[2 * i]!, y: pts[2 * i + 1]! }));
const dir = (a: Pt, b: Pt): [number, number] => [Math.sign(b.x - a.x), Math.sign(b.y - a.y)];
const len = (a: Pt, b: Pt) => Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
const horizontal = (s: Seg) => s[1] === s[3];

/** Only the points where the run turns: no repeats, no straight-through points, no doubling back. */
function corners(pts: Pt[]): number[] {
  const keep: Pt[] = [];
  for (const p of pts) {
    if (keep.length && keep.at(-1)!.x === p.x && keep.at(-1)!.y === p.y) continue;
    keep.push(p);
    while (keep.length >= 3) {
      const [a, b, c] = keep.slice(-3) as [Pt, Pt, Pt];
      if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) {
        keep.splice(-2, 1);
        if (keep.length >= 2 && keep.at(-1)!.x === keep.at(-2)!.x && keep.at(-1)!.y === keep.at(-2)!.y) keep.pop();
      } else break;
    }
  }
  return keep.flatMap((p) => [p.x, p.y]);
}

function onSeg(x: number, y: number, [x1, y1, x2, y2]: Seg): boolean {
  if (x < Math.min(x1, x2) || x > Math.max(x1, x2) || y < Math.min(y1, y2) || y > Math.max(y1, y2)) return false;
  return (x2 - x1) * (y - y1) === (y2 - y1) * (x - x1);
}

/** Two parallel segments on one line sharing more than nothing (a point counts: it would join them). */
function overlaps(a: Seg, b: Seg): boolean {
  if (horizontal(a)) {
    if (a[1] !== b[1]) return false;
    return Math.max(Math.min(a[0], a[2]), Math.min(b[0], b[2])) <= Math.min(Math.max(a[0], a[2]), Math.max(b[0], b[2]));
  }
  if (a[0] !== b[0]) return false;
  return Math.max(Math.min(a[1], a[3]), Math.min(b[1], b[3])) <= Math.min(Math.max(a[1], a[3]), Math.max(b[1], b[3]));
}

/** Where a horizontal and a vertical segment meet, ends included. */
function crossing(a: Seg, b: Seg): Pt | null {
  const [h, v] = horizontal(a) ? [a, b] : [b, a];
  const [x, y] = [v[0], h[1]];
  return onSeg(x, y, h) && onSeg(x, y, v) ? { x, y } : null;
}

/** A crossing straight across, away from both segments' ends. */
function strictCross(a: Seg, b: Seg): boolean {
  const p = crossing(a, b);
  if (!p) return false;
  return ![a, b].some((s) => (p.x === s[0] && p.y === s[1]) || (p.x === s[2] && p.y === s[3]));
}

/** Whether an axis-aligned segment runs through the inside of a box (its edge does not count). */
function throughBox([x1, y1, x2, y2]: Seg, r: Rect): boolean {
  const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)];
  const [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)];
  if (ay === by) return ay > r.y && ay < r.y + r.h && Math.max(ax, r.x) < Math.min(bx, r.x + r.w);
  return ax > r.x && ax < r.x + r.w && Math.max(ay, r.y) < Math.min(by, r.y + r.h);
}
