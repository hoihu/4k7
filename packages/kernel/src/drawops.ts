/**
 * The agent's drawing ops (docs/design/schematic-drawing.md §2a): wire two pins, put a net label or
 * supply symbol at a pin, erase what is drawn at pins or of a net. They change only how the
 * netlist is drawn: a wire joins pins that are on one net already. The first one on a sheet takes
 * it over from the auto-layout, like place_symbol.
 */
import type { Design, EditOp, LabelView, OpResult, PinView, Rect, SheetDrawing, SymbolView } from '@4k7/schema';
import { cardOf, pinLabel, reject, resolvePins, type PinHandle } from './doc.ts';
import { drawingArea, joinedWires, onWire, ownSheet, pageAt, symbolOf, syncDrawing, syncSheet } from './drawing.ts';
import { deco, labelRect, leadEnd, textRect, type Dir } from './scene.ts';
import { routeWire } from './schroute.ts';

/** How far a lead runs out of a pin before a label that points across it (a horizontal label on a top pin). */
const LEAD = 200;

interface Spot {
  h: PinHandle;
  sym: SymbolView;
  pin: PinView;
  net: string;
}

const OUT: Record<PinView['side'], Dir> = { left: 'left', right: 'right', top: 'up', bottom: 'down' };
const BACK: Record<string, Dir> = { left: 'right', right: 'left', up: 'down', down: 'up' };

/** Where a pin reference is drawn on its sheet (all of them for a name several pins share), the sheet taken over. */
function spotsOf(d: Design, ref: string): { sheet: string; sd: SheetDrawing; spots: Spot[] } {
  const hs = resolvePins(d, ref);
  const net = hs.map((h) => h.comp.pins[h.pin.number]).find(Boolean);
  if (!net) reject({ code: 'PIN_UNCONNECTED', message: `${pinLabel(hs[0]!)} is not connected in the netlist. The drawing shows the netlist: connect it first.`, fixHints: [{ op: 'connect', pins: [pinLabel(hs[0]!)] }] });
  const sheet = hs[0]!.comp.sheet;
  const sd = ownSheet(d, sheet);
  const views = sd.symbols.map((s) => symbolOf(d, s)!);
  const spots: Spot[] = [];
  for (const h of hs) {
    const n = h.comp.pins[h.pin.number];
    if (!n) continue;
    for (const sym of views) {
      if (sym.componentId !== h.comp.id) continue;
      const pin = sym.pins.find((p) => p.number === h.pin.number);
      if (pin) spots.push({ h, sym, pin, net: n });
    }
  }
  if (!spots.length) reject({ code: 'PIN_UNKNOWN', message: `${ref} is not drawn on its sheet.` });
  return { sheet, sd, spots };
}

/** Boxes a new wire keeps clear of where it can: labels of other nets and the parts' names and values. */
export function softBoxes(d: Design, sd: SheetDrawing, net: string): Rect[] {
  const out: Rect[] = [];
  for (const l of sd.labels) if (l.netId !== net) out.push(labelRect({ ...l, text: d.nets[l.netId]?.name ?? '' }));
  for (const s of sd.symbols) {
    const c = d.components[s.comp];
    if (c) out.push(textRect(s.ref, [c.refdes]), textRect(s.value, [c.refdes]));
  }
  return out;
}

export function wireOp(d: Design, op: Extract<EditOp, { op: 'wire' }>): OpResult {
  syncDrawing(d);
  const A = spotsOf(d, op.from);
  const B = spotsOf(d, op.to);
  const [na, nb] = [A.spots[0]!.net, B.spots[0]!.net];
  const [la, lb] = [pinLabel(A.spots[0]!.h), pinLabel(B.spots[0]!.h)];
  if (na !== nb) {
    reject({ code: 'NET_MISMATCH', message: `The netlist has ${la} on ${d.nets[na]!.name} and ${lb} on ${d.nets[nb]!.name}. A wire only shows a connection the netlist has: connect them first if they belong together.` });
  }
  if (A.sheet !== B.sheet) reject({ code: 'INVALID_OP', message: `${la} and ${lb} are on different sheets; their net connects them by name. Put a label at each (label).` });
  const sd = A.sd;
  // the closest pair of pins of the two references, on one page
  const pairs = A.spots.flatMap((a) => B.spots.map((b) => ({ a, b, dist: Math.abs(a.pin.x - b.pin.x) + Math.abs(a.pin.y - b.pin.y) }))).filter((p) => p.dist > 0);
  pairs.sort((p, q) => p.dist - q.dist);
  const pair = pairs.find((p) => pageAt(sd.pages, p.a.pin) === pageAt(sd.pages, p.b.pin));
  if (!pair) reject({ code: 'INVALID_OP', message: `${la} and ${lb} are on different pages. A wire stays on its page: put a label at each (label), or move one part onto the other's page first (place_symbol).` });
  const { a, b } = pair!;
  const page = sd.pages[pageAt(sd.pages, a.pin)]!;
  const via = (op.via ?? []).map((v) => ({ x: Math.round((page.x + v.x) / 50) * 50, y: Math.round((page.y + v.y) / 50) * 50 }));
  const views = sd.symbols.map((s) => symbolOf(d, s)!);
  // the wire runs from what is drawn at the one pin to what is drawn at the other (a T onto a wire there)
  const fromWires = joinedWires(sd.wires, na, a.pin.x, a.pin.y);
  const toWires = joinedWires(sd.wires, na, b.pin.x, b.pin.y);
  if (fromWires.some((i) => toWires.includes(i))) {
    return { op: 'wire', effect: `${pinLabel(a.h)} and ${pinLabel(b.h)} are already joined by wires of ${d.nets[na]!.name}; nothing drawn`, ids: [A.sheet] };
  }
  const pts = routeWire({
    from: [{ x: a.pin.x, y: a.pin.y }],
    fromWires: fromWires.map((i) => sd.wires[i]!.pts),
    to: [{ x: b.pin.x, y: b.pin.y }],
    toWires: toWires.map((i) => sd.wires[i]!.pts),
    via,
    symbols: views,
    wires: sd.wires,
    soft: softBoxes(d, sd, na),
    bounds: drawingArea(page),
  });
  if (!pts) {
    reject({ code: 'NO_PATH', message: `No clear path from ${la} to ${lb}: parts or wires of other nets are in the way. Give via points (corners the wire must pass, page coordinates in mils), or move parts first (place_symbol).` });
  }
  sd.wires.push({ netId: na, pts: pts!, ...(via.length ? { via: true } : {}) });
  // the net labels at the two pins have done their job
  const at = (l: { x: number; y: number }, p: PinView) => l.x === p.x && l.y === p.y;
  const before = sd.labels.length;
  sd.labels = sd.labels.filter((l) => !(l.kind === 'net' && (at(l, a.pin) || at(l, b.pin))));
  syncSheet(d, A.sheet);
  const corners = pts!.length / 2 - 2;
  const dropped = before - sd.labels.length;
  return {
    op: 'wire',
    effect: `wire ${pinLabel(a.h)} → ${pinLabel(b.h)} (${d.nets[na]!.name}), ${corners ? `${corners} corner${corners === 1 ? '' : 's'}` : 'straight'}${dropped ? `; ${dropped} label${dropped === 1 ? '' : 's'} at its ends taken away` : ''}`,
    ids: [A.sheet],
  };
}

/** Take away what is drawn at a pin as its label: labels on it, and a lead from it that only ends in a label. */
export function clearPinLabels(sd: SheetDrawing, pin: PinView): number {
  const at = (x: number, y: number) => x === pin.x && y === pin.y;
  const before = sd.labels.length + sd.wires.length;
  const leads = sd.wires.filter((w) => {
    if (w.pts.length !== 4) return false;
    const [x1, y1, x2, y2] = w.pts as [number, number, number, number];
    const far = at(x1, y1) ? [x2, y2] : at(x2, y2) ? [x1, y1] : null;
    if (!far) return false;
    const [fx, fy] = far as [number, number];
    const others = sd.wires.filter((o) => o !== w && onWire(fx, fy, o.pts)).length;
    return !others && sd.labels.some((l) => l.x === fx && l.y === fy);
  });
  const ends = new Set(leads.map((w) => (at(w.pts[0]!, w.pts[1]!) ? `${w.pts[2]},${w.pts[3]}` : `${w.pts[0]},${w.pts[1]}`)));
  sd.wires = sd.wires.filter((w) => !leads.includes(w));
  sd.labels = sd.labels.filter((l) => !at(l.x, l.y) && !ends.has(`${l.x},${l.y}`));
  return before - sd.labels.length - sd.wires.length;
}

export function labelOp(d: Design, op: Extract<EditOp, { op: 'label' }>): OpResult {
  syncDrawing(d);
  const { sheet, sd, spots } = spotsOf(d, op.pin);
  const s = spots[0]!;
  const net = d.nets[s.net]!;
  const out = OUT[s.pin.side];
  clearPinLabels(sd, s.pin);
  const type = cardOf(d, s.h.comp.part)?.pins.find((p) => p.number === s.pin.number)?.type;
  const add = (l: LabelView) => {
    const { text: _t, auto: _a, ...stored } = l;
    sd.labels.push(stored);
  };
  let what: string;
  const kind = deco(net, 0, 0, 'right').kind;
  if (kind !== 'net') {
    // a supply symbol points its own way (rails up, ground down); the lead turns aside where it must
    if (out === 'up' || out === 'down') {
      const r = leadEnd(net, s.pin.x, s.pin.y, out);
      sd.wires.push(...r.wires);
      add(r.label);
    } else add(deco(net, s.pin.x, s.pin.y, out, 100, 0, type));
    what = `${kind === 'ground' ? 'ground' : 'supply'} symbol ${net.name}`;
  } else {
    const dir: Dir = op.dir ?? out;
    if (dir === BACK[out]) reject({ code: 'INVALID_OP', message: `A label at ${pinLabel(s.h)} pointing ${dir} would lie on the part: the pin leaves it ${out}. Point it ${out}, or across (a lead runs out first).` });
    if (dir === out) add(deco(net, s.pin.x, s.pin.y, dir, 100, 0, type));
    else {
      // across the pin's direction: a short lead out of the pin, the label at its end
      const [dx, dy] = out === 'left' ? [-LEAD, 0] : out === 'right' ? [LEAD, 0] : out === 'up' ? [0, -LEAD] : [0, LEAD];
      const [ex, ey] = [s.pin.x + dx, s.pin.y + dy];
      sd.wires.push({ netId: net.id, pts: [s.pin.x, s.pin.y, ex, ey] });
      add(deco(net, ex, ey, dir, 100, 0, type));
    }
    what = `label ${net.name} pointing ${dir}${dir === 'left' || dir === 'right' ? ' (horizontal)' : ' (vertical)'}`;
  }
  syncSheet(d, sheet);
  return { op: 'label', effect: `${what} at ${pinLabel(s.h)}`, ids: [sheet] };
}

export function eraseOp(d: Design, op: Extract<EditOp, { op: 'erase' }>): OpResult {
  syncDrawing(d);
  if (!op.pins?.length && !op.net) reject({ code: 'INVALID_OP', message: 'erase needs pins (what is drawn at them) or net (everything drawn of it).' });
  let wires = 0;
  let labels = 0;
  const sheets = new Set<string>();
  const count = (sd: SheetDrawing, run: () => void) => {
    const [w, l] = [sd.wires.length, sd.labels.length];
    run();
    wires += w - sd.wires.length;
    labels += l - sd.labels.length;
  };
  for (const ref of op.pins ?? []) {
    const { sheet, sd, spots } = spotsOf(d, ref);
    sheets.add(sheet);
    for (const s of spots) {
      count(sd, () => {
        const at = (x: number, y: number) => x === s.pin.x && y === s.pin.y;
        sd.wires = sd.wires.filter((w) => !onWire(s.pin.x, s.pin.y, w.pts));
        sd.labels = sd.labels.filter((l) => !at(l.x, l.y));
      });
    }
  }
  if (op.net) {
    const net = Object.values(d.nets).find((n) => n.name === op.net);
    if (!net) reject({ code: 'REF_UNKNOWN', message: `No net ${op.net}.` });
    const on = new Set(Object.values(d.components).filter((c) => Object.values(c.pins).includes(net!.id)).map((c) => c.sheet));
    for (const sheet of on) {
      const sd = ownSheet(d, sheet);
      sheets.add(sheet);
      count(sd, () => {
        sd.wires = sd.wires.filter((w) => w.netId !== net!.id);
        sd.labels = sd.labels.filter((l) => l.netId !== net!.id);
      });
    }
  }
  for (const s of sheets) syncSheet(d, s);
  return { op: 'erase', effect: `erased ${wires} wire${wires === 1 ? '' : 's'} and ${labels} label${labels === 1 ? '' : 's'}; the connections they showed appear as automatic labels until you draw them again`, ids: [...sheets] };
}
