/**
 * What a sheet's drawing measures, for the SCH checks and for Optimize: wires that cross, labels that
 * run into something, the bends, jogs and detours of a net.
 */
import type { LabelView, Rect, SheetView, SymbolView, WireView } from '@4k7/schema';
import { segmentsOf, type Seg } from './geom.ts';
import { RETURN_LEG, textRect, tw } from './scene.ts';

/** Two segments cross in their interiors (touching ends and T-joints are junctions, not crossings). */
function cross(a: Seg, b: Seg): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const d1 = o(a[0], a[1], a[2], a[3], b[0], b[1]);
  const d2 = o(a[0], a[1], a[2], a[3], b[2], b[3]);
  const d3 = o(b[0], b[1], b[2], b[3], a[0], a[1]);
  const d4 = o(b[0], b[1], b[2], b[3], a[2], a[3]);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Every crossing of the given nets' wires with a wire of another net; two nets both in the set are paired once. */
export function wireCrossings(sheet: SheetView, nets: Set<string>): { net: string; other: string }[] {
  const out: { net: string; other: string }[] = [];
  for (const w of sheet.wires) {
    if (!nets.has(w.netId)) continue;
    const segs = segmentsOf(w.pts);
    for (const o of sheet.wires) {
      if (o.netId === w.netId || (nets.has(o.netId) && o.netId < w.netId)) continue;
      const os = segmentsOf(o.pts);
      for (const a of segs) for (const b of os) if (cross(a, b)) out.push({ net: w.netId, other: o.netId });
    }
  }
  return out;
}

/* -------------------------------- overlaps -------------------------------- */

/**
 * Strict overlap; a zero-width rect is a line, so two lines overlap only where they cross, except
 * that two lines on the same line overlap where they run along each other.
 */
export const meets = (a: Rect, b: Rect) => {
  const along = (p: number, q: number, lp: number, lq: number, both: boolean) => (both ? p <= q + lq && q <= p + lp : p < q + lq && q < p + lp);
  return along(a.x, b.x, a.w, b.w, a.w === 0 && b.w === 0) && along(a.y, b.y, a.h, b.h, a.h === 0 && b.h === 0);
};
export const line = (x1: number, y1: number, x2: number, y2: number): Rect => ({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) });
/** Two lines (or a line and a point) have a point in common, an end touching included, which `meets` leaves out. */
const share = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

/**
 * What a label draws, as the canvas draws it: the head (a flag; a rail's arrow and name; ground
 * bars) and, for a supply, the lines leading to it (stub, stem).
 */
export function labelParts(l: LabelView): { r: Rect; head: boolean }[] {
  // a name on its wire: the letters (72 high, baseline 30 above the wire), not the room kept for it
  if (l.kind === 'net' && l.dir === 'on') return [{ r: { x: l.x - tw(l.text) / 2, y: l.y - 85, w: tw(l.text), h: 60 }, head: true }];
  // a flag, as the canvas draws it: tw(text) + 110 along the lead, 45 to each side (labelRect is the room kept for it)
  if (l.kind === 'net') {
    const len = tw(l.text) + 110;
    const r: Rect = l.dir === 'right' ? { x: l.x, y: l.y - 45, w: len, h: 90 } : l.dir === 'left' ? { x: l.x - len, y: l.y - 45, w: len, h: 90 } : l.dir === 'down' ? { x: l.x - 45, y: l.y, w: 90, h: len } : { x: l.x - 45, y: l.y - len, w: 90, h: len };
    return [{ r, head: true }];
  }
  const sx = l.x + (l.stub === 'left' ? -1 : l.stub === 'right' ? 1 : 0) * (l.stubLen ?? 100);
  const s = l.dir === 'up' ? -1 : 1;
  const r = l.rise ?? 0;
  const stem = (l.kind === 'ground' ? 80 : 200) + r;
  const half = l.kind === 'ground' ? 70 : Math.max(45, tw(l.text) / 2);
  const depth = l.kind === 'ground' ? 70 : 175;
  const parts = [{ r: line(sx, l.y, sx, l.y + s * stem), head: false }, { r: line(sx - half, l.y + s * stem, sx + half, l.y + s * (stem + depth)), head: true }];
  if (sx !== l.x) parts.push({ r: line(l.x, l.y, sx, l.y), head: false });
  return parts;
}

/** Two lines on one line that run along each other. */
const alongLine = (a: Rect, b: Rect) => ((a.w === 0 && b.w === 0 && a.x === b.x) || (a.h === 0 && b.h === 0 && a.y === b.y)) && meets(a, b);
/** Wider by `by` on each side: the air a rail name keeps from a name beside it (names on different rows are fine). */
const wider = (r: Rect, by: number): Rect => ({ ...r, x: r.x - by, w: r.w + 2 * by });

/** What a label ran into: a wire of another net (its head on it, or its stem along it), a symbol, a part's text, another label. */
export type OverlapHit = { on: 'wire'; net: string } | { on: 'symbol'; sym: SymbolView } | { on: 'text'; sym: SymbolView; which: 'name' | 'value' } | { on: 'label'; label: LabelView };
export interface Overlap {
  label: LabelView;
  /** The head (arrow and name, ground bars, a flag) hit it, else the stem or stub. */
  head: boolean;
  hit: OverlapHit;
}

/**
 * What a label runs into on a drawing: the head (arrow and name, ground bars, a flag) on a wire of
 * another net, a stem along such a wire (it reads as connected), and any part of it through another
 * label (rail names keep 50 mils of air beside them), a symbol, a part's body or its text. A
 * supply's stem merely crossing a wire of another net is not counted: the symbol stands upright
 * whatever is in the way (SCH.RAIL_UP), the crossing is the price. `find` gives the first thing it
 * hits, however much it hits, with `air` kept beside its head from a wire; `add` is for what joins
 * the drawing after this was made.
 */
export function labelClashes(sheet: Pick<SheetView, 'symbols' | 'wires' | 'labels'>) {
  const segsOf = (w: WireView) => segmentsOf(w.pts).map(([x1, y1, x2, y2]) => ({ net: w.netId, r: line(x1, y1, x2, y2) }));
  const wires = sheet.wires.flatMap(segsOf);
  const texts = sheet.symbols.flatMap((s) => [{ sym: s, which: 'name' as const, r: textRect(s.refPos, [s.refdes]) }, { sym: s, which: 'value' as const, r: textRect(s.valuePos, s.valueLines ?? [s.value]) }]);
  const parts = sheet.labels.map((l) => ({ l, parts: labelParts(l) }));
  return {
    find(l: LabelView, air = 0): Overlap | undefined {
      const hit = ({ r, head }: { r: Rect; head: boolean }): OverlapHit | undefined => {
        const aired = air ? wider(r, air) : r;
        const w = wires.find((w) => w.net !== l.netId && (head ? meets(aired, w.r) : alongLine(r, w.r)));
        if (w) return { on: 'wire', net: w.net };
        const s = sheet.symbols.find((s) => meets(r, s.bbox));
        if (s) return { on: 'symbol', sym: s };
        const t = texts.find((t) => meets(r, t.r));
        if (t) return { on: 'text', sym: t.sym, which: t.which };
        const b = parts.find((b) => b.l !== l && !(b.l.netId === l.netId && b.l.x === l.x && b.l.y === l.y) && b.parts.some((q) => meets(wider(r, head && l.kind === 'rail' && q.head && b.l.kind === 'rail' ? 50 : 0), q.r)));
        if (b) return { on: 'label', label: b.l };
        return undefined;
      };
      for (const p of labelParts(l)) {
        const h = hit(p);
        if (h) return { label: l, head: p.head, hit: h };
      }
      return undefined;
    },
    add(l: LabelView, leads: WireView[] = []): void {
      parts.push({ l, parts: labelParts(l) });
      wires.push(...leads.flatMap(segsOf));
    },
  };
}

/** Labels and supply symbols of the given nets that run into something (labelClashes), each reported once. */
export function labelOverlaps(sheet: SheetView, nets: Set<string>): Overlap[] {
  const clashes = labelClashes(sheet);
  return sheet.labels.filter((l) => nets.has(l.netId)).flatMap((l) => clashes.find(l) ?? []);
}

type Way = 'l' | 'r' | 'u' | 'd';
const OPPOSITE: Record<Way, Way> = { l: 'r', r: 'l', u: 'd', d: 'u' };
const STEP: Record<Way, [number, number]> = { l: [-1, 0], r: [1, 0], u: [0, -1], d: [0, 1] };
const key = (x: number, y: number) => `${x},${y}`;

/** The way a wire leaves (x, y) along a segment that starts there. */
function wayFrom(x: number, y: number, ox: number, oy: number): Way | undefined {
  if (oy === y && ox !== x) return ox > x ? 'r' : 'l';
  if (ox === x && oy !== y) return oy > y ? 'd' : 'u';
  return undefined;
}

/** The way a pin's wire leaves its symbol: the edge of the box the pin sits on (none for a diagonal part). */
function pinWay(s: SymbolView, x: number, y: number): Way | undefined {
  const b = s.bbox;
  if (x <= b.x) return 'l';
  if (x >= b.x + b.w) return 'r';
  if (y <= b.y) return 'u';
  if (y >= b.y + b.h) return 'd';
  return undefined;
}

/** (x, y) lies strictly inside an orthogonal segment. */
const within = (seg: Seg, x: number, y: number) => {
  const [x1, y1, x2, y2] = seg;
  return (x1 === x2 && x === x1 && y > Math.min(y1, y2) && y < Math.max(y1, y2)) || (y1 === y2 && y === y1 && x > Math.min(x1, x2) && x < Math.max(x1, x2));
};
/** (x, y) is an end of the segment or lies inside it. */
export const touches = (seg: Seg, x: number, y: number) => (seg[0] === x && seg[1] === y) || (seg[2] === x && seg[3] === y) || within(seg, x, y);

/** A pin as the measures see it: its symbol and connection point. */
export interface PinOn {
  sym: SymbolView;
  x: number;
  y: number;
}
/** A pin and the pins facing it on one wire, none of them in line with it. */
export interface Jog {
  pin: PinOn;
  facing: PinOn[];
}

/**
 * How one net's wires are drawn, apart from where they go:
 * - bends: corners, where exactly two wires meet at a right angle (no pin, no T);
 * - uTurns: a wire that turns, steps sideways and turns back the way it came (a U), with nothing
 *   attached to the sideways step, and no leg as long as a row (RETURN_LEG); each is that sideways segment;
 * - detours: the U-turns with nothing in the way, whose sideways step could slide back to the end of
 *   the shorter leg and run straight. A U round a part or another net is how the wire gets past it;
 * - jogs: a pin facing down (or right) at pins facing it on the same wire, none of them in line,
 *   so the wire has to step across (two resistors of a divider side by side instead of stacked).
 */
export function wireShape(sheet: SheetView, net: string): { bends: number; jogs: Jog[]; uTurns: Seg[]; detours: Seg[] } {
  const segs = sheet.wires.filter((w) => w.netId === net).flatMap((w) => segmentsOf(w.pts)).filter(([x1, y1, x2, y2]) => x1 !== x2 || y1 !== y2);
  if (!segs.length) return { bends: 0, jogs: [], uTurns: [], detours: [] };
  // what a wire can be attached to: a pin, or a supply symbol / net flag standing at its end
  const pinAt = new Set(sheet.symbols.flatMap((s) => s.pins.map((p) => key(p.x, p.y))));
  for (const l of sheet.labels) if (l.netId === net && (l.kind !== 'net' || l.dir !== 'on')) pinAt.add(key(l.x, l.y));
  // a net may be drawn in several places (its parts joined through supply symbols or labels):
  // each connected drawing is judged on its own
  const comp = segs.map((_, i) => i);
  const find = (i: number): number => (comp[i] === i ? i : (comp[i] = find(comp[i]!)));
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [a, b] = [segs[i]!, segs[j]!];
      if (touches(a, b[0], b[1]) || touches(a, b[2], b[3]) || touches(b, a[0], a[1]) || touches(b, a[2], a[3])) comp[find(i)] = find(j);
    }
  }
  const drawingOf = (x: number, y: number) => {
    const i = segs.findIndex((g) => touches(g, x, y));
    return i < 0 ? -1 : find(i);
  };

  // the ways wires leave each end point
  const ends = new Map<string, Way[]>();
  for (const [x1, y1, x2, y2] of segs) {
    for (const [x, y, ox, oy] of [[x1, y1, x2, y2], [x2, y2, x1, y1]] as const) {
      const w = wayFrom(x, y, ox, oy);
      if (w) ends.set(key(x, y), [...(ends.get(key(x, y)) ?? []), w]);
    }
  }
  const bend = (x: number, y: number) => {
    const ws = ends.get(key(x, y));
    return !!ws && ws.length === 2 && ws[0] !== ws[1] && ws[0] !== OPPOSITE[ws[1]!] && !pinAt.has(key(x, y)) && !segs.some((g) => within(g, x, y));
  };
  let bends = 0;
  for (const k of ends.keys()) {
    const [x, y] = k.split(',').map(Number) as [number, number];
    if (bend(x, y)) bends++;
  }
  // a run with nothing attached along it (a bus with taps that turns up at both ends is no detour)
  const bare = (g: Seg) => ![...pinAt].some((k) => within(g, ...(k.split(',').map(Number) as [number, number]))) && !segs.some(([x1, y1, x2, y2]) => within(g, x1, y1) || within(g, x2, y2));
  // (a wire running back along a whole row, like the return from the end of a row of a wrapped
  // chain to the start of the next, is no hump: one of its legs is long)
  const legOf = (x: number, y: number, g: Seg) => Math.max(0, ...segs.filter((o) => o !== g && touches(o, x, y)).map(([a, b, c, e]) => Math.abs(c - a) + Math.abs(e - b)));
  // what a straight run cannot go through: a part, a pin this net's wires do not reach, a wire or label of another net
  const inTheWay = (run: Rect) =>
    sheet.symbols.some((s) => meets(run, s.bbox) || s.pins.some((p) => share(run, line(p.x, p.y, p.x, p.y)) && !segs.some((g) => touches(g, p.x, p.y)))) ||
    sheet.wires.some((w) => w.netId !== net && segmentsOf(w.pts).some(([a, b, c, e]) => share(run, line(a, b, c, e)))) ||
    sheet.labels.some((l) => l.netId !== net && labelParts(l).some((p) => meets(run, p.r)));
  const uTurns: Seg[] = [];
  const detours: Seg[] = [];
  for (const g of segs) {
    const [x1, y1, x2, y2] = g;
    if (!bend(x1, y1) || !bend(x2, y2) || !bare(g)) continue;
    const out1 = ends.get(key(x1, y1))!.find((w) => w !== wayFrom(x1, y1, x2, y2));
    const out2 = ends.get(key(x2, y2))!.find((w) => w !== wayFrom(x2, y2, x1, y1));
    const [leg1, leg2] = [legOf(x1, y1, g), legOf(x2, y2, g)];
    if (!out1 || out1 !== out2 || Math.max(leg1, leg2) >= RETURN_LEG) continue;
    uTurns.push(g);
    const [dx, dy] = [STEP[out1][0] * Math.min(leg1, leg2), STEP[out1][1] * Math.min(leg1, leg2)];
    if (!inTheWay(line(x1 + dx, y1 + dy, x2 + dx, y2 + dy))) detours.push(g);
  }

  // pins on these wires, with the way each faces and the drawing it is on
  const pins = sheet.symbols.flatMap((s) => s.pins.map((p) => ({ sym: s, x: p.x, y: p.y, way: pinWay(s, p.x, p.y), on: drawingOf(p.x, p.y) })).filter((p) => p.on >= 0));
  const jogs: Jog[] = [];
  for (const a of pins) {
    if (a.way !== 'd' && a.way !== 'r') continue;
    const facing = pins.filter((b) => b.sym !== a.sym && b.on === a.on && b.way === OPPOSITE[a.way!] && (a.way === 'd' ? b.y >= a.y : b.x >= a.x));
    if (facing.length && !facing.some((b) => (a.way === 'd' ? b.x === a.x : b.y === a.y))) jogs.push({ pin: a, facing });
  }
  return { bends, jogs, uTurns, detours };
}
