/**
 * Optimize scope (docs/design/zoom-optimize.md): which parts of the zoomed area the agent may move,
 * the guard that keeps its edits inside it, and the numbers that say whether a change helped.
 */
import type { Component, Design, EditOp, OptimizeScope, Rect, SchematicView, ScopeInfo, ScopeMeasures, SheetView, SymbolView } from '@4k7/schema';
import { componentsSorted, natCmp, netMembers, reject, RejectError, resolveUnitRef } from './doc.ts';
import { overlap, segmentsOf } from './geom.ts';
import { viewOf } from './drawing.ts';
import { blockAssignment } from './layout.ts';
import { textOverlaps } from './parttext.ts';
import { labelOverlaps, wireCrossings, wireShape } from './sheetmeasures.ts';

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
    } else if (syms.some((s) => centreIn(scope.rect, s.bbox) || overlap(scope.rect, s.bbox))) {
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
    measures: measure(sheet, nets, free),
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
    for (const [x1, y1, x2, y2] of segmentsOf(w.pts)) {
      if (overlap(r, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) })) nets.add(w.netId);
    }
  }
  for (const l of sheet.labels) if (l.x >= r.x && l.x <= r.x + r.w && l.y >= r.y && l.y <= r.y + r.h) nets.add(l.netId);
  const ids = new Set(sheet.symbols.filter((s) => overlap(r, s.bbox)).map((s) => s.componentId));
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
    case 'place_symbol': {
      const c = resolveUnitRef(d, op.ref).comp;
      mustBeFree(c, 'place_symbol');
      if (d.drawing?.[c.sheet]?.symbols.some((s) => s.comp === c.id && s.by === 'user')) out(`place_symbol: the user put ${c.refdes} where it stands; leave it, or ask them.`);
      return;
    }
    case 'wire':
    case 'label':
    case 'erase': {
      if (op.op === 'erase' && op.net) out('erase of a whole net reaches beyond this area; erase at pins inside it.');
      if (op.op === 'erase' && op.at?.length) out('erase at a point is for the user; erase at pins inside the area.');
      const refs = op.op === 'wire' ? [op.from, op.to] : op.op === 'label' ? [op.pin] : op.pins ?? [];
      for (const r of refs) mayRefer(resolveUnitRef(d, r.slice(0, Math.max(0, r.indexOf('.')))).comp);
      return;
    }
    case 'move_supply': {
      const pg = viewOf(d).sheets.find((s) => s.id === sc.scope.sheet)?.pages.find((p) => p.number === op.page)?.rect;
      const r = sc.scope.rect;
      const inArea = (x: number, y: number) => !!pg && pg.x + x >= r.x && pg.x + x <= r.x + r.w && pg.y + y >= r.y && pg.y + y <= r.y + r.h;
      if (!inArea(op.x, op.y) || !inArea(op.to.x, op.to.y)) out('move_supply: the symbol and the spot it goes to must both be inside this area.');
      return;
    }
    case 'place_text': {
      const refs = [...(op.ref ? [op.ref] : []), ...(op.refs ?? [])];
      if (!refs.length) out('place_text of a whole sheet reaches beyond this area; give ref or refs (parts inside it).');
      for (const r of refs) {
        const c = resolveUnitRef(d, r).comp;
        mayRefer(c);
        if (!op.auto && d.drawing?.[c.sheet]?.symbols.some((s) => s.comp === c.id && s.textBy === 'user')) out(`place_text: the user put ${c.refdes}'s name or value where they stand; leave them, or ask them.`);
      }
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
      out(`${op.op} changes more than how this area is drawn. Optimize may only use constrain (left_of, right_of, above, below, arrangement), remove_constraint, place_symbol, place_text, place_block, wire, label, erase at pins, move_supply, auto_draw with refs and set_symbol on parts inside the area.`);
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

/** Wire crossings, the wires' shape, wire length and net labels of the given nets on a sheet; the overlaps with those of the names and values of `parts` (component ids). */
export function measure(sheet: SheetView, nets: Set<string>, parts: ReadonlySet<string> = new Set()): ScopeMeasures {
  const mine = sheet.wires.filter((w) => nets.has(w.netId)).map((w) => ({ net: w.netId, segs: segmentsOf(w.pts) }));
  const mils = mine.reduce((n, w) => n + w.segs.reduce((m, [x1, y1, x2, y2]) => m + Math.abs(x2 - x1) + Math.abs(y2 - y1), 0), 0);
  const labels = sheet.labels.filter((l) => l.kind === 'net' && nets.has(l.netId)).length;
  const shape = { bends: 0, jogs: 0, detours: 0 };
  for (const net of nets) {
    const s = wireShape(sheet, net);
    shape.bends += s.bends;
    shape.jogs += s.jogs.length;
    shape.detours += s.detours.length;
  }
  return { crossings: wireCrossings(sheet, nets).length, ...shape, overlaps: labelOverlaps(sheet, nets).length + (parts.size ? textOverlaps(sheet, parts).length : 0), wireIn: Math.round(mils / 100) / 10, labels };
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
