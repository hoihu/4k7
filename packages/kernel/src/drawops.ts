/**
 * The agent's drawing ops (docs/design/schematic-drawing.md §2a): wire two pins, put a net label or
 * supply symbol at a pin, erase what is drawn at pins or of a net. They change only how the
 * netlist is drawn: a wire joins pins that are on one net already. The first one on a sheet takes
 * it over from the auto-layout, like place_symbol.
 */
import type { Component, Design, EditOp, LabelView, OpResult, PinView, Rect, SheetDrawing, SheetView, SymbolView } from '@4k7/schema';
import { resolveUnitRef } from './apply.ts';
import { RejectError, cardOf, natCmp, pinLabel, reject, resolvePins, type PinHandle } from './doc.ts';
import { drawingArea, groups, isDrawn, joinedWires, onWire, ownSheet, pageAt, pinsOf, schematicView, symbolOf, syncDrawing, syncSheet } from './drawing.ts';
import { clashWords, clearTexts, placeTexts, textBox, textClashes, within, type TextArrange, type TextClash, type TextSide } from './parttext.ts';
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
  const own = views.flatMap((s) => s.pins.filter((p) => d.components[s.componentId]?.pins[p.number] === na));
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
    through: own,
  });
  if (!pts) {
    reject({ code: 'NO_PATH', message: `No clear path from ${la} to ${lb}: parts or wires of other nets are in the way. Give via points (corners the wire must pass, page coordinates in mils), or move parts first (place_symbol).` });
  }
  sd.wires.push({ netId: na, pts: pts!, ...(via.length ? { via: true } : {}) });
  // the net labels at the two pins, and at those it runs through, have done their job
  const done = [a.pin, b.pin, ...own.filter((p) => onWire(p.x, p.y, pts!))];
  const before = sd.labels.length;
  sd.labels = sd.labels.filter((l) => !(l.kind === 'net' && done.some((p) => l.x === p.x && l.y === p.y)));
  syncSheet(d, A.sheet);
  const corners = pts!.length / 2 - 2;
  const dropped = before - sd.labels.length;
  return {
    op: 'wire',
    effect: `wire ${pinLabel(a.h)} → ${pinLabel(b.h)} (${d.nets[na]!.name}), ${corners ? `${corners} corner${corners === 1 ? '' : 's'}` : 'straight'}${dropped ? `; ${dropped} label${dropped === 1 ? '' : 's'} at its ends taken away` : ''}`,
    ids: [A.sheet],
  };
}

type PinKey = `${string}.${string}`;

/** The pins that hang together by wires on a sheet, as "refdes.number" (each group of two or more with a wire). */
export function wiredPins(d: Design, sd: SheetDrawing): PinKey[][] {
  const pins = pinsOf(d, sd.symbols.map((s) => symbolOf(d, s)!));
  return groups(pins, sd.wires, sd.labels)
    .filter((g) => g.wires.length && g.pins.length > 1)
    .map((g) => g.pins.map((i): PinKey => `${pins[i]!.comp.refdes}.${pins[i]!.pin.number}`));
}

/**
 * Wire again what a move or turn of a symbol cut: `before` is wiredPins from before it. Each group
 * that fell apart is joined by the shortest wire between its pieces the path finder finds, until
 * it is one again or no clear path is left; those connections show as automatic labels. Returns
 * how many wires were drawn and how many connections were left to labels.
 */
export function rewire(d: Design, sheetId: string, before: PinKey[][]): { wired: number; left: number } {
  let wired = 0;
  let left = 0;
  // what hangs together now, worked out again only after a wire was tried: most groups are untouched
  let joined: PinKey[][] | undefined;
  const wiredNow = () => (joined ??= wiredPins(d, d.drawing![sheetId]!));
  for (const keys of before) {
    const failed = new Set<string>();
    for (let tries = 0; tries < 6; tries++) {
      // the pieces the group is in now
      const piece = new Map(keys.map((k, i) => [k, i] as const));
      for (const g of wiredNow()) {
        const hit = g.filter((k) => piece.has(k));
        for (const k of hit) piece.set(k, piece.get(hit[0]!)!);
      }
      if (new Set(piece.values()).size < 2) break;
      const sd = d.drawing![sheetId]!;
      const pins = pinsOf(d, sd.symbols.map((s) => symbolOf(d, s)!));
      const at = new Map(pins.map((p) => [`${p.comp.refdes}.${p.pin.number}` as PinKey, p.pin] as const));
      const pairs = keys
        .flatMap((a) => keys.map((b) => [a, b] as const))
        .filter(([a, b]) => piece.get(a)! < piece.get(b)! && at.has(a) && at.has(b) && !failed.has(`${a} ${b}`))
        .sort(([a, b], [c, e]) => dist(at.get(a)!, at.get(b)!) - dist(at.get(c)!, at.get(e)!));
      if (!pairs.length) break;
      const [a, b] = pairs[0]!;
      joined = undefined;
      try {
        wireOp(d, { op: 'wire', from: a, to: b });
        wired++;
      } catch (e) {
        if (!(e instanceof RejectError)) throw e;
        failed.add(`${a} ${b}`);
      }
    }
    const now = wiredNow();
    if (keys.some((k) => !now.some((g) => g.includes(k) && keys.every((o) => g.includes(o))))) left++;
  }
  return { wired, left };
}
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

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
  if (!op.pins?.length && !op.net && !op.at?.length) reject({ code: 'INVALID_OP', message: 'erase needs pins (what is drawn at them), net (everything drawn of it) or at (one wire or label).' });
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
  // one wire or label, where the page coordinates point
  if (op.at?.length) {
    const view = schematicView(d);
    for (const a of op.at) {
      const sh = view.sheets.find((x) => x.pages.some((p) => p.number === a.page));
      if (!sh) reject({ code: 'INVALID_OP', message: `There is no page ${a.page}.` });
      const pg = sh!.pages.find((p) => p.number === a.page)!.rect;
      const [x, y] = [pg.x + a.x, pg.y + a.y];
      const sd = ownSheet(d, sh!.id);
      sheets.add(sh!.id);
      const [w, l] = [wires, labels];
      count(sd, () => {
        if (a.what === 'wire') sd.wires = sd.wires.filter((v) => !onWire(x, y, v.pts));
        else sd.labels = sd.labels.filter((v) => !(v.x === x && v.y === y));
      });
      if (wires + labels === w + l) reject({ code: 'INVALID_OP', message: `No ${a.what} is drawn at (${a.x}, ${a.y}) on page ${a.page}. design_query get_schematic shows what is where.` });
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

const WORDS: Record<TextArrange, string> = { stacked: 'stacked', side_by_side: 'side by side' };
const symRef = (s: SymbolView) => `${s.refdes}${s.unit ?? ''}`;

/**
 * Where a part's name and value stand (place_text, parttext.ts): only their positions change. A
 * sheet the layout draws keeps its text clear itself, so auto leaves it alone; the other ways take
 * it over, as any drawing op does. Text the user put somewhere is theirs: auto leaves it, and the
 * agent's other ways say so.
 */
export function textOp(d: Design, op: Extract<EditOp, { op: 'place_text' }>, by: 'user' | 'agent'): OpResult {
  syncDrawing(d); // parts added earlier in this transaction are drawn first
  const exact = op.name || op.value;
  if ([exact, op.at || op.arrange, op.auto].filter(Boolean).length !== 1) {
    reject({ code: 'INVALID_OP', message: 'place_text takes one of: at and/or arrange (the kernel works out the spot), name and/or value (exact spots, for one part), auto: true (only text that runs into something moves).' });
  }
  const picks = [...(op.ref ? [op.ref] : []), ...(op.refs ?? [])].map((r) => resolveUnitRef(d, r));
  if (op.auto) return autoTexts(d, op, picks);
  if (!picks.length) reject({ code: 'INVALID_OP', message: 'place_text needs ref (or refs): the part whose name and value move.' });
  if (exact && picks.length > 1) reject({ code: 'INVALID_OP', message: 'Exact spots (name, value) are for one part at a time.' });
  const notes: string[] = [];
  for (const id of new Set(picks.map((p) => p.comp.sheet))) {
    if (isDrawn(d, id)) continue;
    notes.push(`sheet ${d.sheets[id]?.name ?? id} is drawn as you arrange it from now on`);
    ownSheet(d, id);
  }
  const view = schematicView(d);
  const done: string[] = [];
  for (const { comp, unit } of picks) {
    const sheet = view.sheets.find((s) => s.id === comp.sheet)!;
    const syms = sheet.symbols.filter((s) => s.componentId === comp.id && (unit === undefined || s.unit === unit));
    if (!syms.length) reject({ code: 'INVALID_OP', message: `${comp.refdes}${unit ?? ''} is not drawn on its sheet.` });
    if (exact && syms.length > 1) reject({ code: 'INVALID_OP', message: `${comp.refdes} is drawn as units: give one of them (${syms.map(symRef).join(', ')}).` });
    for (const sym of syms) {
      let clashes: TextClash[];
      if (exact) {
        sym.refPos = op.name ? textAt(sheet, sym, 'name', op.name) : sym.refPos;
        sym.valuePos = op.value ? textAt(sheet, sym, 'value', op.value) : sym.valuePos;
        clashes = textClashes(sheet, sym);
        done.push(`${symRef(sym)}: ${[op.name ? `name at (${op.name.x}, ${op.name.y})` : '', op.value ? `value at (${op.value.x}, ${op.value.y})` : ''].filter(Boolean).join(', ')}`);
      } else {
        const to = placeTexts(sheet, sym, { ...(op.at ? { side: op.at as TextSide } : {}), ...(op.arrange ? { arrange: op.arrange } : {}) });
        clashes = to.clashes;
        done.push(`${symRef(sym)}: name and value ${WORDS[to.arrange]} ${to.side === 'above' || to.side === 'below' ? to.side : `on the ${to.side}`}`);
      }
      const stored = storeText(d, comp, sym);
      const wasUsers = stored.textBy === 'user';
      if (by === 'user') stored.textBy = 'user';
      else delete stored.textBy;
      if (wasUsers && by === 'agent') notes.push(`${symRef(sym)}'s text was the user's placement; now yours`);
      for (const c of clashes) notes.push(clashWords(c, (n) => d.nets[n]?.name ?? n));
    }
  }
  return { op: op.op, effect: `${done.join('; ')}${notes.length ? `; ${notes.join('; ')}` : ''}`, ids: picks.map((p) => p.comp.id) };
}

/** An exact spot of a part's text as canvas coordinates; it stays inside the frame of the page the part stands on, or it is refused. */
function textAt(sheet: SheetView, sym: SymbolView, which: 'name' | 'value', at: { x: number; y: number; anchor?: SymbolView['refPos']['anchor'] | undefined }): SymbolView['refPos'] {
  const c = { x: sym.bbox.x + sym.bbox.w / 2, y: sym.bbox.y + sym.bbox.h / 2 };
  const page = sheet.pages[pageAt(sheet.pages.map((p) => p.rect), c)]!;
  const area = drawingArea(page.rect);
  const pos = { x: Math.round(page.rect.x + at.x), y: Math.round(page.rect.y + at.y), anchor: at.anchor ?? (which === 'name' ? sym.refPos : sym.valuePos).anchor };
  if (!within(area, textBox(sym, which, pos))) {
    reject({ code: 'INVALID_OP', message: `${symRef(sym)}'s ${which} at (${at.x}, ${at.y}) would leave the drawing area of page ${page.number}, where the part stands: x from ${area.x - page.rect.x} to ${area.x - page.rect.x + area.w}, y from ${area.y - page.rect.y} to ${area.y - page.rect.y + area.h}. Move the part first (place_symbol).` });
  }
  return pos;
}

/** A symbol's text as it stands in the view goes into the stored drawing. */
function storeText(d: Design, comp: Component, sym: SymbolView) {
  const stored = d.drawing![comp.sheet]!.symbols.find((s) => s.comp === comp.id && (s.unit ?? undefined) === (sym.unit ?? undefined))!;
  stored.ref = { ...sym.refPos };
  stored.value = { ...sym.valuePos };
  return stored;
}

/** Text that runs into something goes to the nearest clear spot: of the given parts, a sheet, or every sheet the agent arranged. */
function autoTexts(d: Design, op: Extract<EditOp, { op: 'place_text' }>, picks: { comp: Component; unit?: string }[]): OpResult {
  const named = op.sheet !== undefined ? Object.values(d.sheets).find((s) => s.name.toLowerCase() === op.sheet!.toLowerCase()) : undefined;
  if (op.sheet !== undefined && !named) reject({ code: 'REF_UNKNOWN', message: `No sheet "${op.sheet}".`, candidates: Object.values(d.sheets).map((s) => s.name) });
  const ids = picks.length ? [...new Set(picks.map((p) => p.comp.sheet))] : named ? [named.id] : Object.values(d.sheets).sort((a, b) => a.order - b.order).map((s) => s.id);
  const picked = (s: SymbolView) => !picks.length || picks.some((p) => p.comp.id === s.componentId && (p.unit === undefined || p.unit === s.unit));
  const view = schematicView(d);
  const moved: string[] = [];
  const stuck: string[] = [];
  const kept: string[] = [];
  const touched: string[] = [];
  const clash = (c: TextClash) => clashWords(c, (n) => d.nets[n]?.name ?? n);
  for (const id of ids.filter((x) => isDrawn(d, x))) {
    const sheet = view.sheets.find((s) => s.id === id)!;
    const r = clearTexts(sheet, (s) => !s.textBy && picked(s));
    for (const m of r.moved) {
      storeText(d, d.components[m.sym.componentId]!, m.sym);
      moved.push(`${symRef(m.sym)} ${WORDS[m.arrange]} ${m.side === 'above' || m.side === 'below' ? m.side : `on the ${m.side}`}`);
      touched.push(m.sym.componentId);
    }
    stuck.push(...r.stuck.map(clash));
    for (const s of sheet.symbols) if (s.textBy && picked(s)) kept.push(...textClashes(sheet, s).map(clash));
  }
  const byLayout = ids.filter((x) => !isDrawn(d, x)).map((x) => d.sheets[x]?.name ?? x);
  const parts = [
    moved.length ? `moved ${moved.sort(natCmp).join(', ')}` : 'no name or value moved',
    stuck.length ? `no clear spot: ${stuck.join('; ')}` : '',
    kept.length ? `left where the user put them: ${kept.join('; ')}` : '',
    byLayout.length ? `drawn by the auto-layout, which keeps its text clear itself: ${byLayout.join(', ')}` : '',
  ].filter(Boolean);
  return { op: op.op, effect: parts.join('; '), ids: touched };
}
