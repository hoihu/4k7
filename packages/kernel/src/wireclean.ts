/**
 * Clean-up of a stored drawing's wires (docs/design/schematic-drawing.md §2a): the agent draws wire
 * by wire, each routed on its own, so a net drawn bit by bit (and redrawn by Optimize) collects
 * loops, runs drawn twice and detours. After every change, each net's wires are taken apart at
 * every point where something joins them (a pin, a label, a wire end on another wire) and put
 * together again as a tree: one way between any two of its pins and labels (the shortest pieces
 * kept), nothing that leads nowhere. Then each run between two joints loses its U-turns and steps
 * where a straighter way is clear. A piece still drawn badly (a U-turn left, or loops) is also drawn afresh the way a person would, from pin to pin onto what is drawn
 * already, and the cleaner of the two is kept. A run through a part (the part was put down on it)
 * goes round the part. What is connected never changes: a wire joins only where an end touches, and
 * a moved piece touches nothing new. A net that needs none of this keeps its wires; a wire drawn
 * through the agent's corners (wire via) keeps its path, unless a part now stands on it.
 */
import type { Design, PinView, Point, Rect, SheetDrawing, SymbolView } from '@4k7/schema';
import { GRID } from '@4k7/parts';
import { RETURN_LEG, labelRect, textRect } from './scene.ts';
import { BEND, CROSS, SOFT, routeWire } from './schroute.ts';

type Pt = { x: number; y: number };
type Wire = { netId: string; pts: number[]; via?: boolean };
type Seg = [number, number, number, number];

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
  let parts: string | undefined; // where they stand, for what is remembered below
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
      // a piece the layout draws its own way (a bus along an IC's pins) stays messy by these rules and
      // is tried again after every change: the outcome is remembered for the same piece in the same place
      const place = (ws: Wire[]) => `${net}|${JSON.stringify(ws.map((w) => w.pts))}|${JSON.stringify(rest.map((w) => w.pts))}|${(parts ??= JSON.stringify([sheet.pins, sheet.bodies]))}`;
      // a run behind a part goes round it, whoever drew it
      const runs = piece.some((w) => behindPart(w.pts, sheet.bodies)) ? (remembered(`round|${place(piece)}`, () => goRound(net, piece, rest, sheet)) ?? piece) : piece;
      // each run straightened where it can be (the agent's own corners stay)
      const straight = runs.map((w) => (w.via ? w : { ...w, pts: straighten(w.pts, net, [...rest, ...runs.filter((o) => o !== w)], sheet) ?? w.pts }));
      let best = straight;
      if (!runs.some((w) => w.via) && (tree.pruned || straight.some((w) => messy(w.pts)))) {
        best = remembered(`redraw|${place(straight)}`, () => {
          const r = redraw(net, straight, rest, sheet);
          return r && costs(r) < costs(straight) ? r : null;
        }) ?? best;
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

function remembered(memo: string, draw: () => Wire[] | null): Wire[] | null {
  let fresh = redrawn.get(memo);
  if (fresh === undefined) {
    fresh = draw();
    if (redrawn.size > 200) redrawn.delete(redrawn.keys().next().value!);
    redrawn.set(memo, fresh);
  }
  return fresh && fresh.map((w) => ({ ...w, pts: [...w.pts] }));
}

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

/**
 * Whether a run goes through a part's box, which the router never does: the part was put down on it,
 * and hides it or stands across it. (A slanted lead belongs to the part drawn at 45°, a bridge's diamond.)
 */
export function behindPart(pts: number[], boxes: Rect[]): boolean {
  // (asked of every run at every sync, and most runs are nowhere near most boxes)
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]!);
    x1 = Math.max(x1, pts[i]!);
    y0 = Math.min(y0, pts[i + 1]!);
    y1 = Math.max(y1, pts[i + 1]!);
  }
  const near = boxes.filter((r) => x1 > r.x && x0 < r.x + r.w && y1 > r.y && y0 < r.y + r.h);
  return near.length > 0 && segsOf(pts).some((sg) => near.some((r) => intoBox(sg, r)));
}

const intoBox = (sg: Seg, r: Rect) => (sg[0] === sg[2] || sg[1] === sg[3]) && throughBox(sg, r);

/** A run from its first end up to the first box it goes into, on its grid: its first end alone (two numbers) when it starts going in. */
function upToBox(pts: number[], boxes: Rect[]): number[] {
  const out = [pts[0]!, pts[1]!];
  for (const sg of segsOf(pts)) {
    const [x1, y1, x2, y2] = sg;
    const [dx, dy] = [Math.sign(x2 - x1), Math.sign(y2 - y1)];
    const entered = boxes.filter((r) => intoBox(sg, r)).map((r) => (dx > 0 ? r.x - x1 : dx < 0 ? x1 - r.x - r.w : dy > 0 ? r.y - y1 : y1 - r.y - r.h));
    if (!entered.length) {
      out.push(x2, y2);
      continue;
    }
    const clear = Math.floor(Math.max(0, Math.min(...entered)) / GRID) * GRID;
    if (clear) out.push(x1 + dx * clear, y1 + dy * clear);
    break;
  }
  return out;
}

/** Which way a wire must not arrive at a label (through its text or symbol). */
export const NOT_INTO: Record<string, [number, number]> = { up: [0, 1], down: [0, -1], left: [1, 0], right: [-1, 0] };

/** The pins and labels of a net on some wires, and which way each label must not be reached. */
function terminals(net: string, wires: Wire[], sheet: Sheet): { terms: Map<string, Point>; forbid: Map<string, [number, number]> } {
  const segs = wires.flatMap((w) => segsOf(w.pts));
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
  return { terms, forbid };
}

/** What a piece is joined from: pins and labels on their own, and runs drawn already. */
interface Island {
  pts: Point[];
  wires: number[][];
}

/** From the first island, each next (the nearest first) joined onto what is joined so far with the router: the wires drawn. Null when one cannot be reached, or they span pages. */
function joinIslands(net: string, islands: Island[], forbid: Map<string, [number, number]>, rest: Wire[], sheet: Sheet): number[][] | null {
  const pointsOf = (p: Island) => [...p.pts, ...p.wires.flatMap(toPts)];
  const todo = [...islands].sort((a, b) => pointsOf(a)[0]!.x - pointsOf(b)[0]!.x || pointsOf(a)[0]!.y - pointsOf(b)[0]!.y);
  const area = sheet.area(pointsOf(todo[0]!)[0]!);
  const same = (r: Rect | null) => !!r && r.x === area?.x && r.y === area.y;
  if (!area || !todo.every((p) => pointsOf(p).every((t) => same(sheet.area(t))))) return null;
  const soft = sheet.soft.filter((t) => t.net !== net).map((t) => t.r);
  const drawn = islands.flatMap((p) => p.wires);
  const first = todo.shift()!;
  const joined = [...first.pts];
  const built = [...first.wires];
  const fresh: number[][] = [];
  while (todo.length) {
    const far = (p: Island) => Math.min(...pointsOf(p).flatMap((t) => [...joined.map((j) => Math.abs(j.x - t.x) + Math.abs(j.y - t.y)), ...built.flatMap(segsOf).map((sg) => toSeg(t, sg))]));
    todo.sort((a, b) => far(a) - far(b));
    const t = todo.shift()!;
    const pts = routeWire({
      from: t.pts,
      fromWires: t.wires,
      to: joined,
      toWires: built,
      via: [],
      wires: [...rest, ...[...drawn, ...fresh].map((b) => ({ netId: net, pts: b }))],
      symbols: sheet.symbols,
      soft,
      bounds: area,
      forbid,
    });
    if (!pts) return null;
    fresh.push(pts);
    built.push(pts, ...t.wires);
    joined.push(...t.pts);
  }
  return fresh;
}

/**
 * A piece drawn afresh, as a person would: from its first pin, each next pin or label (the nearest
 * first) joined onto what is drawn so far with the router. Null when one cannot be reached, or the
 * piece spans pages.
 */
function redraw(net: string, piece: Wire[], rest: Wire[], sheet: Sheet): Wire[] | null {
  const { terms, forbid } = terminals(net, piece, sheet);
  if (terms.size < 2) return null;
  const built = joinIslands(net, [...terms.values()].map((t) => ({ pts: [t], wires: [] })), forbid, rest, sheet);
  return built && built.map((pts) => ({ netId: net, pts }));
}

/**
 * A piece with runs through a part: each keeps what it has up to the part at either end, the way
 * between goes, and what is left is joined again round the part, so only what stood behind it moves.
 * The rest of the piece stays as it is drawn. Null when one cannot be reached, or the piece spans pages.
 */
function goRound(net: string, piece: Wire[], rest: Wire[], sheet: Sheet): Wire[] | null {
  const gone = piece.filter((w) => behindPart(w.pts, sheet.bodies));
  const left: Wire[] = [
    ...piece.filter((w) => !gone.includes(w)),
    ...gone.flatMap((w) => [upToBox(w.pts, sheet.bodies), upToBox(toPts(w.pts).reverse().flatMap((p) => [p.x, p.y]), sheet.bodies)]).filter((pts) => pts.length > 2).map((pts) => ({ netId: net, pts })),
  ];
  const { terms, forbid } = terminals(net, gone, sheet);
  const alone = [...terms.values()].filter((t) => !left.some((w) => segsOf(w.pts).some((sg) => onSeg(t.x, t.y, sg))));
  const islands: Island[] = [...piecesOf(left).map((p) => ({ pts: [], wires: p.map((w) => w.pts) })), ...alone.map((t) => ({ pts: [t], wires: [] }))];
  const fresh = islands.length > 1 ? joinIslands(net, islands, forbid, rest, sheet) : [];
  if (!fresh) return null;
  // (what is left beyond where the new wire joins it leads nowhere now)
  const tree = treeOf(net, [...left, ...fresh.map((pts) => ({ netId: net, pts }))], sheet);
  return (tree?.chains ?? []).map((c) => ({ netId: net, pts: c.pts, ...(c.via ? { via: true } : {}) }));
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
 * Whether a run drawn anew is allowed: it runs through no part, not even back along a pin's lead,
 * comes into no label of its net through its text or symbol, and touches nothing but its own two
 * ends (no pin, label or wire end on it, no run along a wire); crossing a wire straight across is
 * fine.
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
    if (pin && wayOff(pin, end, next) === 'back') return false;
    const [dx, dy] = dir(next, end);
    for (const l of sheet.labels) {
      const no = l.netId === net && l.x === end.x && l.y === end.y ? NOT_INTO[l.stub ?? l.dir] : undefined;
      if (no && no[0] === dx && no[1] === dy) return false;
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
        // (in line with a wire of its net at its own end, and no further: one straight run with a joint)
        if (overlaps(sg, o.sg) && !(o.net === net && endOn(sg, o.sg, isEnd))) return false;
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

/** How a run leaving a pin goes on from the pin's lead. */
function wayOff(pin: Sheet['pins'][number], end: Pt, next: Pt): 'on' | 'side' | 'back' {
  const [dx, dy] = dir(end, next);
  const [ox, oy] = OUT[pin.side];
  return dx === ox && dy === oy ? 'on' : dx === -ox && dy === -oy ? 'back' : 'side';
}

function costOf(pts: number[], net: string, rest: Wire[], sheet: Sheet): number {
  const segs = segsOf(pts);
  let c = segs.reduce((n, [x1, y1, x2, y2]) => n + Math.abs(x2 - x1) + Math.abs(y2 - y1), 0) + BEND * Math.max(0, segs.length - 1);
  // off a pin to the side: a corner with its lead, as the router counts it. A run as long as a row
  // (the return from one row of a chain to the next, no hump to SCH.DETOUR) counts it twice, so a
  // wire drawn straight out of its pins and back along the row stays as it is.
  const side = segs.some(([x1, y1, x2, y2]) => Math.abs(x2 - x1) + Math.abs(y2 - y1) >= RETURN_LEG) ? 2 * BEND : BEND;
  const P = toPts(pts);
  for (const [end, next] of [[P[0]!, P[1]!], [P.at(-1)!, P.at(-2)!]] as const) {
    const pin = sheet.pins.find((p) => p.x === end.x && p.y === end.y && p.net === net);
    if (pin && wayOff(pin, end, next) === 'side') c += side;
  }
  for (const sg of segs) {
    for (const w of rest) for (const o of segsOf(w.pts)) if (horizontal(sg) !== horizontal(o) && strictCross(sg, o)) c += CROSS;
    for (const t of sheet.soft) if (t.net !== net && throughBox(sg, t.r)) c += SOFT;
  }
  return c;
}

/* -------------------------------- geometry -------------------------------- */

/** A run's segments. (Runs are not changed once made, and this is asked of every wire for every run tried.) */
const segsOfRun = new WeakMap<number[], Seg[]>();

function segsOf(pts: number[]): Seg[] {
  let out = segsOfRun.get(pts);
  if (out) return out;
  out = [];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const s: Seg = [pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!];
    if (s[0] !== s[2] || s[1] !== s[3]) out.push(s);
  }
  segsOfRun.set(pts, out);
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

/** Two segments in line that share just one point, an end of the run. */
function endOn(a: Seg, b: Seg, isEnd: (x: number, y: number) => boolean): boolean {
  const i = horizontal(a) ? 0 : 1;
  const lo = Math.max(Math.min(a[i]!, a[i + 2]!), Math.min(b[i]!, b[i + 2]!));
  const hi = Math.min(Math.max(a[i]!, a[i + 2]!), Math.max(b[i]!, b[i + 2]!));
  return lo === hi && (horizontal(a) ? isEnd(lo, a[1]) : isEnd(a[0], lo));
}

/** Where a horizontal and a vertical segment meet, ends included. */
function crossing(a: Seg, b: Seg): Pt | null {
  const [h, v] = horizontal(a) ? [a, b] : [b, a];
  const [x, y] = [v[0], h[1]];
  return onSeg(x, y, h) && onSeg(x, y, v) ? { x, y } : null;
}

/** A crossing straight across, away from both segments' ends. */
function strictCross(a: Seg, b: Seg): boolean {
  const [h, v] = horizontal(a) ? [a, b] : [b, a];
  const [x, y] = [v[0], h[1]];
  // (a slanted lead, on a part drawn at 45°, is never crossed straight across)
  return v[0] === v[2] && x > Math.min(h[0], h[2]) && x < Math.max(h[0], h[2]) && y > Math.min(v[1], v[3]) && y < Math.max(v[1], v[3]);
}

/** Whether an axis-aligned segment runs through the inside of a box (its edge does not count). */
function throughBox([x1, y1, x2, y2]: Seg, r: Rect): boolean {
  const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)];
  const [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)];
  if (ay === by) return ay > r.y && ay < r.y + r.h && Math.max(ax, r.x) < Math.min(bx, r.x + r.w);
  return ax > r.x && ax < r.x + r.w && Math.max(ay, r.y) < Math.min(by, r.y + r.h);
}
