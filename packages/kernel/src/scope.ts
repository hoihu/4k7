/**
 * Optimize scope (docs/design/zoom-optimize.md): which parts of the zoomed area the agent may move,
 * the guard that keeps its edits inside it, and the numbers that say whether a change helped.
 */
import type { Component, Design, EditOp, LabelView, OptimizeScope, Rect, SchematicView, ScopeInfo, ScopeMeasures, SheetView, SymbolView } from '@4k7/schema';
import { resolveUnitRef } from './apply.ts';
import { RejectError, componentsSorted, natCmp, netMembers, reject } from './doc.ts';
import { RETURN_LEG, textRect, tw } from './scene.ts';
import { blockAssignment } from './layout.ts';

export interface ResolvedScope {
  scope: OptimizeScope;
  /** Component ids the agent may move. */
  free: Set<string>;
  /** Component ids it may refer to but not move. */
  anchored: Map<string, string>;
  /** Nets with a pin on a free part: the ones the measures are about. */
  nets: Set<string>;
  info: ScopeInfo;
}

/** The area must hold at least this many movable parts to be worth optimizing. */
export const MIN_FREE = 2;

const inside = (r: Rect, b: Rect) => b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h;
const centreIn = (r: Rect, b: Rect) => b.x + b.w / 2 >= r.x && b.x + b.w / 2 <= r.x + r.w && b.y + b.h / 2 >= r.y && b.y + b.h / 2 <= r.y + r.h;
const refOf = (s: SymbolView) => `${s.refdes}${s.unit ?? ''}`;

export function resolveScope(d: Design, view: SchematicView, scope: OptimizeScope): ResolvedScope | { error: string } {
  const sheet = view.sheets.find((s) => s.id === scope.sheet);
  if (!sheet) return { error: `No sheet ${scope.sheet}.` };
  const free = new Set<string>();
  const anchored = new Map<string, string>();
  const hard = new Set<string>();
  for (const k of Object.values(d.ledger)) if (k.strength === 'hard') for (const id of [k.a, k.b]) if (id) hard.add(id);

  const byComp = new Map<string, SymbolView[]>();
  for (const s of sheet.symbols) byComp.set(s.componentId, [...(byComp.get(s.componentId) ?? []), s]);
  let context = 0;
  for (const [id, syms] of byComp) {
    if (syms.every((s) => inside(scope.rect, s.bbox))) {
      if (hard.has(id)) anchored.set(id, 'a hard constraint in the ledger fixes it');
      else free.add(id);
    } else if (syms.some((s) => centreIn(scope.rect, s.bbox) || overlaps(scope.rect, s.bbox))) {
      anchored.set(id, syms.every((s) => !inside(scope.rect, s.bbox) && centreIn(scope.rect, s.bbox)) ? 'cut by the edge of the area' : 'partly outside the area');
    } else {
      context++;
    }
  }

  const nets = new Set<string>();
  const boundary = new Set<string>();
  const members = netMembers(d);
  for (const [netId, pins] of members) {
    const ins = pins.some((m) => free.has(m.comp.id));
    if (ins) nets.add(netId);
    if (ins && pins.some((m) => !free.has(m.comp.id))) boundary.add(netId);
  }

  const refs = (ids: Iterable<string>) =>
    [...ids]
      .flatMap((id) => (byComp.get(id) ?? []).map(refOf))
      .sort(natCmp);
  const info: ScopeInfo = {
    scope,
    sheetName: sheet.name,
    free: refs(free),
    anchored: [...anchored].flatMap(([id, why]) => (byComp.get(id) ?? []).map((s) => ({ ref: refOf(s), why }))).sort((a, b) => natCmp(a.ref, b.ref)),
    context,
    boundaryNets: [...boundary].map((n) => d.nets[n]?.name ?? n).sort(natCmp),
    measures: measure(sheet, nets),
  };
  return { scope, free, anchored, nets, info };
}

/**
 * A view with fewer than MIN_FREE whole parts (zoomed onto a wire, a rail label, a junction) is
 * widened to the parts it is about: those with a symbol in the view, and those on the nets whose
 * wires or labels are in it (nets with many pins, like ground, are skipped). Null when there is
 * nothing in the view to widen to.
 */
export function widenScope(d: Design, view: SchematicView, scope: OptimizeScope): OptimizeScope | null {
  const sheet = view.sheets.find((s) => s.id === scope.sheet);
  if (!sheet) return null;
  const r = scope.rect;
  const nets = new Set<string>();
  for (const w of sheet.wires) {
    for (const [x1, y1, x2, y2] of segments(w.pts)) {
      if (overlaps(r, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) })) nets.add(w.netId);
    }
  }
  for (const l of sheet.labels) if (l.x >= r.x && l.x <= r.x + r.w && l.y >= r.y && l.y <= r.y + r.h) nets.add(l.netId);
  const ids = new Set(sheet.symbols.filter((s) => overlaps(r, s.bbox)).map((s) => s.componentId));
  const members = netMembers(d);
  for (const n of nets) {
    const pins = members.get(n) ?? [];
    if (pins.length <= WIDEN_MAX_PINS) for (const m of pins) ids.add(m.comp.id);
  }
  const boxes = sheet.symbols.filter((s) => ids.has(s.componentId)).map((s) => s.bbox);
  if (boxes.length < MIN_FREE) return null;
  const x0 = Math.min(r.x, ...boxes.map((b) => b.x)) - WIDEN_PAD;
  const y0 = Math.min(r.y, ...boxes.map((b) => b.y)) - WIDEN_PAD;
  const x1 = Math.max(r.x + r.w, ...boxes.map((b) => b.x + b.w)) + WIDEN_PAD;
  const y1 = Math.max(r.y + r.h, ...boxes.map((b) => b.y + b.h)) + WIDEN_PAD;
  return { ...scope, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

const WIDEN_MAX_PINS = 8;
const WIDEN_PAD = 100;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/* --------------------------------- guard ---------------------------------- */

const PLACEMENT_KINDS = new Set(['left_of', 'right_of', 'above', 'below']);

/**
 * Throws OUT_OF_SCOPE unless `op` is one the area allows: moving free parts relative to free or
 * anchored ones (soft constraints), drawing a free recognised circuit differently, splitting a
 * free big IC. Never anything that changes the circuit.
 */
export function guardOp(d: Design, op: EditOp, sc: ResolvedScope): void {
  const out = (message: string, candidates?: string[]): never => reject({ code: 'OUT_OF_SCOPE', message, ...(candidates ? { candidates } : {}) });
  const free = [...sc.free].map((id) => d.components[id]?.refdes ?? id).sort(natCmp);
  const mustBeFree = (c: Component, what: string) => {
    if (!sc.free.has(c.id)) out(`${what}: ${c.refdes} is ${sc.anchored.has(c.id) ? `anchored (${sc.anchored.get(c.id)})` : 'outside the area'}, so it cannot be moved. Parts you may move: ${free.join(', ')}.`, free);
  };
  const mayRefer = (c: Component) => {
    if (!sc.free.has(c.id) && !sc.anchored.has(c.id)) out(`${c.refdes} is outside the area; place parts relative to parts inside it (${free.join(', ')}) or anchored ones.`, free);
  };

  switch (op.op) {
    case 'constrain': {
      if (op.strength === 'hard') out('Optimize adds soft constraints only; the user decides what is fixed.');
      if (PLACEMENT_KINDS.has(op.kind)) {
        mustBeFree(resolveUnitRef(d, op.a ?? '').comp, op.kind);
        mayRefer(resolveUnitRef(d, op.b ?? '').comp);
      } else if (op.kind === 'arrangement') {
        const a = resolveUnitRef(d, op.a ?? '').comp;
        mustBeFree(a, 'arrangement');
      } else {
        out(`constrain ${op.kind} is not part of Optimize (only left_of, right_of, above, below and arrangement).`);
      }
      return;
    }
    case 'remove_constraint': {
      const k = d.ledger[op.id];
      if (!k) return; // the op itself reports the unknown id
      if (k.strength === 'hard') out(`${op.id} is a hard constraint; only the user removes those.`);
      if (!PLACEMENT_KINDS.has(k.kind) && k.kind !== 'arrangement' && k.kind !== 'sch_position' && k.kind !== 'sch_block') out(`${op.id} is not a placement constraint.`);
      const a = k.a ? d.components[k.a] : undefined;
      if (a) mustBeFree(a, `remove ${op.id}`);
      return;
    }
    case 'place_symbol':
      mustBeFree(resolveUnitRef(d, op.ref).comp, 'place_symbol');
      return;
    case 'wire':
    case 'label':
    case 'erase': {
      if (op.op === 'erase' && op.net) out('erase of a whole net reaches beyond this area; erase at pins inside it.');
      const refs = op.op === 'wire' ? [op.from, op.to] : op.op === 'label' ? [op.pin] : op.pins ?? [];
      for (const r of refs) mayRefer(resolveUnitRef(d, r.slice(0, Math.max(0, r.indexOf('.')))).comp);
      return;
    }
    case 'auto_draw':
      if (!op.refs?.length) out('auto_draw of a whole sheet redraws more than this area; give refs (parts inside it) to redraw only those.');
      for (const r of op.refs ?? []) mustBeFree(resolveUnitRef(d, r).comp, 'auto_draw');
      return;
    case 'set_symbol': {
      const c = resolveUnitRef(d, op.ref).comp;
      for (const u of componentsSorted(d).filter((x) => x.part === c.part)) mustBeFree(u, 'set_symbol (it redraws every component of the part)');
      return;
    }
    case 'place_block': {
      // a block moves with all its parts on the sheet (those put with it too): every one of them inside the area
      const want = op.block.trim().toLowerCase();
      const ids = blockAssignment(d, sc.scope.sheet ?? '')?.blocks.find((b) => b.title.toLowerCase() === want)?.ids ?? [];
      for (const id of ids) mustBeFree(d.components[id]!, `place_block "${op.block}"`);
      return;
    }
    default:
      out(`${op.op} changes more than how this area is drawn. Optimize may only use constrain (left_of, right_of, above, below, arrangement), remove_constraint, place_symbol, place_block, wire, label, erase at pins, auto_draw with refs and set_symbol on parts inside the area.`);
  }
}

/** True if `e` is the guard's own refusal (so the caller reports it like any rejected op). */
export const isScopeRefusal = (e: unknown) => e instanceof RejectError && e.rejection.code === 'OUT_OF_SCOPE';

/* ------------------------------ circuit identity --------------------------- */

/** Everything that makes the circuit what it is, in a form that compares equal iff nothing changed. */
export function circuitSignature(d: Design): string {
  const comps = componentsSorted(d).map((c) => [c.refdes, c.part, Object.entries(c.params).sort(), Object.entries(c.pins).map(([p, n]) => [p, d.nets[n]?.name ?? n]).sort(), [...c.noConnect].sort(), !!c.dnp]);
  const nets = Object.values(d.nets).map((n) => [n.name, Object.entries(n.attrs).sort()]).sort();
  return JSON.stringify([comps, nets]);
}

/* -------------------------------- measures -------------------------------- */

export type Seg = [number, number, number, number];

export function segments(pts: number[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i + 3 < pts.length; i += 2) out.push([pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!]);
  return out;
}

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
    const segs = segments(w.pts);
    for (const o of sheet.wires) {
      if (o.netId === w.netId || (nets.has(o.netId) && o.netId < w.netId)) continue;
      const os = segments(o.pts);
      for (const a of segs) for (const b of os) if (cross(a, b)) out.push({ net: w.netId, other: o.netId });
    }
  }
  return out;
}

/** Wire crossings, the wires' shape, wire length and net labels of the given nets on a sheet. */
export function measure(sheet: SheetView, nets: Set<string>): ScopeMeasures {
  const mine = sheet.wires.filter((w) => nets.has(w.netId)).map((w) => ({ net: w.netId, segs: segments(w.pts) }));
  const mils = mine.reduce((n, w) => n + w.segs.reduce((m, [x1, y1, x2, y2]) => m + Math.abs(x2 - x1) + Math.abs(y2 - y1), 0), 0);
  const labels = sheet.labels.filter((l) => l.kind === 'net' && nets.has(l.netId)).length;
  const shape = { bends: 0, jogs: 0, detours: 0 };
  for (const net of nets) {
    const s = wireShape(sheet, net);
    shape.bends += s.bends;
    shape.jogs += s.jogs.length;
    shape.detours += s.detours.length;
  }
  return { crossings: wireCrossings(sheet, nets).length, ...shape, overlaps: labelOverlaps(sheet, nets).length, wireIn: Math.round(mils / 100) / 10, labels };
}

/* -------------------------------- overlaps -------------------------------- */

/**
 * Strict overlap; a zero-width rect is a line, so two lines overlap only where they cross, except
 * that two lines on the same line overlap where they run along each other.
 */
const meets = (a: Rect, b: Rect) => {
  const along = (p: number, q: number, lp: number, lq: number, both: boolean) => (both ? p <= q + lq && q <= p + lp : p < q + lq && q < p + lp);
  return along(a.x, b.x, a.w, b.w, a.w === 0 && b.w === 0) && along(a.y, b.y, a.h, b.h, a.h === 0 && b.h === 0);
};
const line = (x1: number, y1: number, x2: number, y2: number): Rect => ({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) });

/**
 * What a label draws, as the canvas draws it: the head (a flag; a rail's arrow and name; ground
 * bars) and, for a supply, the lines leading to it (stub, stem).
 */
function labelParts(l: LabelView): { r: Rect; head: boolean }[] {
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
 * Labels and supply symbols of the given nets that run into something: the head (arrow and name,
 * ground bars, a flag) on a wire of another net, a stem along such a wire (it reads as connected),
 * and any part of them through another label (rail names keep 50 mils of air beside them), a
 * symbol, a part's body or its text. A supply's stem merely crossing a wire of another net is not
 * counted: the symbol stands upright whatever is in the way (SCH.RAIL_UP), the crossing is the
 * price. Each label is reported once, with the first thing it hits, however much it hits.
 */
export function labelOverlaps(sheet: SheetView, nets: Set<string>): Overlap[] {
  const wires = sheet.wires.flatMap((w) => segments(w.pts).map(([x1, y1, x2, y2]) => ({ net: w.netId, r: line(x1, y1, x2, y2) })));
  const texts = sheet.symbols.flatMap((s) => [{ sym: s, which: 'name' as const, r: textRect(s.refPos, [s.refdes]) }, { sym: s, which: 'value' as const, r: textRect(s.valuePos, s.valueLines ?? [s.value]) }]);
  const parts = sheet.labels.map((l) => ({ l, parts: labelParts(l) }));
  const out: Overlap[] = [];
  for (const a of parts) {
    if (!nets.has(a.l.netId)) continue;
    const hit = ({ r, head }: { r: Rect; head: boolean }): OverlapHit | undefined => {
      const w = wires.find((w) => w.net !== a.l.netId && (head ? meets(r, w.r) : alongLine(r, w.r)));
      if (w) return { on: 'wire', net: w.net };
      const s = sheet.symbols.find((s) => meets(r, s.bbox));
      if (s) return { on: 'symbol', sym: s };
      const t = texts.find((t) => meets(r, t.r));
      if (t) return { on: 'text', sym: t.sym, which: t.which };
      const b = parts.find((b) => b !== a && !(b.l.netId === a.l.netId && b.l.x === a.l.x && b.l.y === a.l.y) && b.parts.some((q) => meets(wider(r, head && a.l.kind === 'rail' && q.head && b.l.kind === 'rail' ? 50 : 0), q.r)));
      if (b) return { on: 'label', label: b.l };
      return undefined;
    };
    for (const p of a.parts) {
      const h = hit(p);
      if (h) {
        out.push({ label: a.l, head: p.head, hit: h });
        break;
      }
    }
  }
  return out;
}

type Way = 'l' | 'r' | 'u' | 'd';
const OPPOSITE: Record<Way, Way> = { l: 'r', r: 'l', u: 'd', d: 'u' };
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
 * - detours: a wire that turns, steps sideways and turns back the way it came (a U), with nothing
 *   attached to the sideways step, and no leg as long as a row (RETURN_LEG); each is that sideways segment;
 * - jogs: a pin facing down (or right) at pins facing it on the same wire, none of them in line,
 *   so the wire has to step across (two resistors of a divider side by side instead of stacked).
 */
export function wireShape(sheet: SheetView, net: string): { bends: number; jogs: Jog[]; detours: Seg[] } {
  const segs = sheet.wires.filter((w) => w.netId === net).flatMap((w) => segments(w.pts)).filter(([x1, y1, x2, y2]) => x1 !== x2 || y1 !== y2);
  if (!segs.length) return { bends: 0, jogs: [], detours: [] };
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
  const detours: Seg[] = [];
  for (const g of segs) {
    const [x1, y1, x2, y2] = g;
    if (!bend(x1, y1) || !bend(x2, y2) || !bare(g)) continue;
    const out1 = ends.get(key(x1, y1))!.find((w) => w !== wayFrom(x1, y1, x2, y2));
    const out2 = ends.get(key(x2, y2))!.find((w) => w !== wayFrom(x2, y2, x1, y1));
    if (out1 && out1 === out2 && Math.max(legOf(x1, y1, g), legOf(x2, y2, g)) < RETURN_LEG) detours.push(g);
  }

  // pins on these wires, with the way each faces and the drawing it is on
  const pins = sheet.symbols.flatMap((s) => s.pins.map((p) => ({ sym: s, x: p.x, y: p.y, way: pinWay(s, p.x, p.y), on: drawingOf(p.x, p.y) })).filter((p) => p.on >= 0));
  const jogs: Jog[] = [];
  for (const a of pins) {
    if (a.way !== 'd' && a.way !== 'r') continue;
    const facing = pins.filter((b) => b.sym !== a.sym && b.on === a.on && b.way === OPPOSITE[a.way!] && (a.way === 'd' ? b.y >= a.y : b.x >= a.x));
    if (facing.length && !facing.some((b) => (a.way === 'd' ? b.x === a.x : b.y === a.y))) jogs.push({ pin: a, facing });
  }
  return { bends, jogs, detours };
}

/* --------------------------------- ripple --------------------------------- */

/** A symbol's drawing, to tell whether it moved. */
const shape = (s: SymbolView) => [s.bbox.x, s.bbox.y, s.bbox.w, s.bbox.h, s.rotation ?? 0] as const;

/** Positions of every symbol on the sheet by component and unit. */
export function positions(sheet: SheetView): Map<string, readonly number[]> {
  return new Map(sheet.symbols.map((s) => [`${s.componentId}${s.unit ?? ''}`, shape(s)]));
}

/**
 * Parts outside the area whose drawing moved. A block or page that shifted as a whole (the layout
 * centres each page's drawing, so one part growing moves its neighbours along) is not counted:
 * per baseline page, the most common displacement among the outside parts is taken as that shift.
 */
export function ripple(before: SheetView, beforePos: Map<string, readonly number[]>, after: SheetView, sc: ResolvedScope): string[] {
  const now = positions(after);
  const pageOf = (s: SymbolView) => before.pages.findIndex((p) => centreIn(p.rect, s.bbox));
  const groups = new Map<number, { s: SymbolView; delta: string }[]>();
  for (const s of before.symbols) {
    if (sc.free.has(s.componentId)) continue;
    const key = `${s.componentId}${s.unit ?? ''}`;
    const b = beforePos.get(key)!;
    const a = now.get(key);
    const delta = a ? `${a[0]! - b[0]!},${a[1]! - b[1]!},${a[2]! - b[2]!},${a[3]! - b[3]!},${a[4]! - b[4]!}` : 'gone';
    const g = groups.get(pageOf(s)) ?? [];
    g.push({ s, delta });
    groups.set(pageOf(s), g);
  }
  const out: string[] = [];
  for (const g of groups.values()) {
    const counts = new Map<string, number>();
    for (const x of g) counts.set(x.delta, (counts.get(x.delta) ?? 0) + 1);
    const [mode] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [''];
    for (const x of g) if (x.delta !== mode) out.push(refOf(x.s));
  }
  return [...new Set(out)].sort(natCmp);
}
