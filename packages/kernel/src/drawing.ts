/**
 * The schematic drawing the agent owns (docs/design/schematic-drawing.md §2a). The netlist is the
 * truth; a sheet's drawing says how it is shown. A sheet nobody has arranged has no stored drawing:
 * the auto-layout draws it afresh after every change, as it always did. The first time the agent
 * arranges it (place_symbol), the layout's drawing is stored in the design (`Design.drawing`) and
 * from then on kept as it is. The kernel keeps it in step with the netlist (syncDrawing) and
 * completes it on the way to the canvas: a connection the drawing does not show gets a net label of
 * its own (`auto`), so the picture never leaves a connection out.
 */
import { DEFAULT_PAPER, PAGE, paperOf, type BlockView, type Component, type Design, type DrawnSymbol, type LabelView, type PageView, type PinView, type Rect, type SchematicView, type SheetDrawing, type SheetView, type SymbolView, type WireView } from '@4k7/schema';
import { GRID, isTwoPin, symbolFor, symbolFromSpec, unitCount, uprightSymbol } from '@4k7/parts';
import { cardOf, componentsSorted, natCmp } from './doc.ts';
import { PAGE_GAP, blockAssignment, drawnWith, evaluateConstraints, layoutSheetOf, pageName, pagesBBox, symbolKey } from './layout.ts';
import { FRAME_PAD, frameAround, pieces } from './blocks.ts';
import { cleanWires } from './wireclean.ts';
import { addJunctions, crowding, deco, labelForPin, labelRect, leadEnd, makeSymbol, rotateSymbol, symbolMaking, textRect, type Dir, type Scene } from './scene.ts';

/* ---------------------------------- view ----------------------------------- */

/** The schematic as the canvas shows it: each sheet's stored drawing, or the auto-layout's. */
export function schematicView(d: Design): SchematicView {
  const sheets = Object.values(d.sheets).sort((a, b) => a.order - b.order);
  const views = sheets.map((s) => {
    const sd = d.drawing?.[s.id];
    return sd ? renderSheet(d, s.id, s.name, sd) : layoutSheetOf(d, s.id);
  });
  // pages are numbered through the whole design, as on a printout
  let n = 0;
  for (const v of views) for (const p of v.pages) p.number = ++n;
  const { status, why } = evaluateConstraints(d, views);
  for (const k of Object.values(d.ledger)) {
    if (status[k.id] !== 'violated' || !['left_of', 'right_of', 'above', 'below'].includes(k.kind)) continue;
    const sheet = d.components[k.a ?? '']?.sheet;
    if (sheet && d.drawing?.[sheet]) why[k.id] = `sheet ${d.sheets[sheet]!.name} is drawn as arranged, and an order only guides the auto-layout: move the part with place_symbol, or let the layout redraw the sheet with auto_draw`;
  }
  return { paper: d.paper ?? DEFAULT_PAPER, sheets: views, constraintStatus: status, ...(Object.keys(why).length ? { constraintWhy: why } : {}) };
}

/** Whether the agent has taken over this sheet's drawing. */
export const isDrawn = (d: Design, sheetId: string) => !!d.drawing?.[sheetId];

/** The symbol a stored drawing names, where it stands; undefined when its component or card is gone. */
export function symbolOf(d: Design, s: DrawnSymbol): SymbolView | undefined {
  const c = d.components[s.comp];
  const card = c && cardOf(d, s.part);
  if (!c || !card) return undefined;
  const def = symbolFromSpec(card, s.spec);
  const sym = makeSymbol(d, c, def, s.x, s.y);
  if (s.rot) rotateSymbol(sym, def, s.x, s.y, s.rot);
  if (s.unit) sym.unit = s.unit;
  sym.bbox = { ...s.bbox };
  sym.refPos = { ...s.ref };
  sym.valuePos = { ...s.value };
  return sym;
}

function renderSheet(d: Design, id: string, name: string, sd: SheetDrawing): SheetView {
  const scene: Scene = { symbols: [], wires: [], junctions: [], labels: [], noConnects: [] };
  for (const s of sd.symbols) {
    const sym = symbolOf(d, s);
    if (!sym) continue;
    scene.symbols.push(sym);
    const c = d.components[s.comp]!;
    for (const p of sym.pins) if (c.noConnect.includes(p.number)) scene.noConnects.push({ x: p.x, y: p.y });
  }
  for (const w of sd.wires) if (d.nets[w.netId]) scene.wires.push({ netId: w.netId, pts: [...w.pts] });
  for (const l of sd.labels) {
    const net = d.nets[l.netId];
    if (net) scene.labels.push({ ...l, text: net.name });
  }
  autoLabels(d, scene);
  addJunctions(scene);
  const frames = storedFrames(d, id, scene, sd.pages);
  if (frames.length) scene.blocks = frames;
  const paper = paperOf(d.paper);
  const pages: PageView[] = sd.pages.map((rect, i) => ({
    number: i + 1,
    name: pageName(d, headsOn(d, scene.symbols, rect)),
    rect: { ...rect },
    ...(rect.w > paper.w || rect.h > paper.h ? { oversized: true } : {}),
  }));
  return { id, name, bbox: pagesBBox(pages), pages, ...scene };
}

/**
 * The frames of the functional blocks on a stored drawing: round each block whose parts stand
 * together on one page, with what is drawn at them (the labels at their pins, and the wires and
 * labels of a net's drawn piece that joins parts of the block alone: a supply's lead and symbol,
 * a wire between two of its parts), as long as the frame takes in no part of another block and
 * runs no deeper into another frame than the air round their drawings. A block scattered over
 * the sheet has none.
 */
function storedFrames(d: Design, sheetId: string, scene: Scene, pages: Rect[]): BlockView[] {
  const groups = blockAssignment(d, sheetId);
  if (!groups) return [];
  const blockOf = new Map<string, string>();
  for (const b of groups.blocks) for (const id of b.ids) blockOf.set(id, b.title);
  const around = new Map<string, Rect[]>();
  for (const net of new Set(scene.symbols.flatMap((s) => Object.values(d.components[s.componentId]?.pins ?? {})))) {
    for (const p of pieces(d, scene, net)) {
      const titles = new Set(p.pins.map((q) => blockOf.get(scene.symbols[q.sym]!.componentId)));
      const [title] = titles;
      if (titles.size !== 1 || !title || !p.wires.length) continue;
      const wires = p.wires.map((i) => scene.wires[i]!.pts);
      const labels = scene.labels.filter((l) => l.netId === net && wires.some((pts) => onWire(l.x, l.y, pts)));
      around.set(title, [...(around.get(title) ?? []), ...wires.map(wireBox), ...labels.map(labelRect)]);
    }
  }
  const out: BlockView[] = [];
  for (const b of groups.blocks) {
    const syms = scene.symbols.filter((s) => blockOf.get(s.componentId) === b.title);
    if (!syms.length || new Set(syms.map((s) => pageAt(pages, centre(s.bbox)))).size > 1) continue;
    const pinsAt = new Set(syms.flatMap((s) => s.pins.map((p) => `${p.x},${p.y}`)));
    const rects = [
      ...syms.flatMap((s) => [s.bbox, textRect(s.refPos, [s.refdes]), textRect(s.valuePos, s.valueLines ?? [s.value])]),
      ...scene.labels.filter((l) => pinsAt.has(`${l.x},${l.y}`)).map(labelRect),
      ...(around.get(b.title) ?? []),
    ];
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    const rect = frameAround({ x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y });
    const intruder = scene.symbols.some((s) => blockOf.get(s.componentId) !== b.title && inside(rect, centre(s.bbox)));
    if (!intruder) out.push({ title: b.title, rect });
  }
  // two frames may share the air round their drawings, not more
  const deep = (a: Rect, b: Rect) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 2 * FRAME_PAD && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 2 * FRAME_PAD;
  return out.filter((f) => !out.some((o) => o !== f && deep(o.rect, f.rect)));
}

/** The ICs and connectors standing on a page, which it is named after. */
function headsOn(d: Design, symbols: SymbolView[], rect: Rect): Component[] {
  const out = new Map<string, Component>();
  for (const s of symbols) {
    const c = d.components[s.componentId];
    if (!c || out.has(c.id) || isTwoPin(cardOf(d, c.part)!) || !inside(rect, centre(s.bbox))) continue;
    out.set(c.id, c);
  }
  return [...out.values()];
}

/* ------------------------------- connections ------------------------------- */

interface PinAt {
  sym: number;
  pin: PinView;
  comp: Component;
  /** The pin's net, null when it is not connected (or marked no-connect). */
  net: string | null;
}

const pinsOf = (d: Design, symbols: SymbolView[]): PinAt[] =>
  symbols.flatMap((s, i) => {
    const comp = d.components[s.componentId]!;
    return s.pins.map((pin) => ({ sym: i, pin, comp, net: comp.pins[pin.number] ?? null }));
  });

/** Whether (x, y) lies on the segment, ends included. */
function onSeg(x: number, y: number, x1: number, y1: number, x2: number, y2: number): boolean {
  if (x < Math.min(x1, x2) || x > Math.max(x1, x2) || y < Math.min(y1, y2) || y > Math.max(y1, y2)) return false;
  return (x2 - x1) * (y - y1) === (y2 - y1) * (x - x1);
}

export function onWire(x: number, y: number, pts: number[]): boolean {
  for (let i = 0; i + 3 < pts.length; i += 2) if (onSeg(x, y, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!)) return true;
  return pts.length === 2 && pts[0] === x && pts[1] === y;
}

const ends = (w: WireView): [number, number][] => [[w.pts[0]!, w.pts[1]!], [w.pts.at(-2)!, w.pts.at(-1)!]];

/** The wires of a net joined to a spot (a pin): those on it, and those whose end touches one of them, and so on. Indices into `wires`. */
export function joinedWires(wires: WireView[], netId: string, x: number, y: number): number[] {
  const mine = wires.map((w, i) => [w, i] as const).filter(([w]) => w.netId === netId);
  const out = new Set(mine.filter(([w]) => onWire(x, y, w.pts)).map(([, i]) => i));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [w, i] of mine) {
      if (out.has(i)) continue;
      const touches = [...out].some((o) => ends(w).some(([ex, ey]) => onWire(ex, ey, wires[o]!.pts)) || ends(wires[o]!).some(([ex, ey]) => onWire(ex, ey, w.pts)));
      if (touches) (out.add(i), (grew = true));
    }
  }
  return [...out];
}

/**
 * What hangs together on the sheet: wires of one net that touch (an end on the other wire), the
 * pins and labels on them, a label on a pin, pins stacked on one spot. Pins join a wire whatever
 * its net, so a wire that runs to a pin of another net shows up as one group with two nets.
 */
interface Group {
  wires: number[];
  pins: number[];
  labels: number[];
}

function groups(pins: PinAt[], wires: WireView[], labels: Pick<LabelView, 'x' | 'y' | 'netId'>[]): Group[] {
  const n = pins.length + wires.length + labels.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const join = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const W = (i: number) => pins.length + i;
  const L = (i: number) => pins.length + wires.length + i;
  wires.forEach((a, i) => {
    wires.forEach((b, j) => {
      if (j <= i || a.netId !== b.netId) return;
      if (ends(a).some(([x, y]) => onWire(x, y, b.pts)) || ends(b).some(([x, y]) => onWire(x, y, a.pts))) join(W(i), W(j));
    });
    pins.forEach((p, k) => {
      if (onWire(p.pin.x, p.pin.y, a.pts)) join(k, W(i));
    });
    labels.forEach((l, k) => {
      if (l.netId === a.netId && onWire(l.x, l.y, a.pts)) join(L(k), W(i));
    });
  });
  const at = new Map<string, number>();
  pins.forEach((p, k) => {
    const key = `${p.pin.x},${p.pin.y}`;
    const o = at.get(key);
    if (o === undefined) at.set(key, k);
    else if (pins[o]!.net === p.net) join(k, o);
  });
  labels.forEach((l, k) => {
    const o = at.get(`${l.x},${l.y}`);
    if (o !== undefined) join(L(k), o);
  });
  const out = new Map<number, Group>();
  const get = (i: number) => {
    const r = find(i);
    let g = out.get(r);
    if (!g) out.set(r, (g = { wires: [], pins: [], labels: [] }));
    return g;
  };
  pins.forEach((_, i) => get(i).pins.push(i));
  wires.forEach((_, i) => get(W(i)).wires.push(i));
  labels.forEach((_, i) => get(L(i)).labels.push(i));
  return [...out.values()];
}

/**
 * Labels for the connections the drawing does not show: a net drawn in pieces (groups of pins
 * joined by wires) that no label ties together gets a label at a pin of each untied piece. A net
 * that goes on to parts not in the scene (another sheet) counts that as a piece of its own.
 */
function autoLabels(d: Design, scene: Scene): void {
  const pins = pinsOf(d, scene.symbols);
  const gs = groups(pins, scene.wires, scene.labels);
  const here = new Set(scene.symbols.map((s) => s.componentId));
  const offSheet = new Set<string>();
  for (const c of Object.values(d.components)) if (!here.has(c.id)) for (const n of Object.values(c.pins)) offSheet.add(n);
  const byNet = new Map<string, Group[]>();
  for (const g of gs) {
    const net = g.pins.map((i) => pins[i]!.net).find((x) => x);
    if (net) byNet.set(net, [...(byNet.get(net) ?? []), g]);
  }
  const wired = new Set<string>();
  for (const w of scene.wires) for (const [x, y] of ends(w)) wired.add(`${x},${y}`);
  for (const [netId, list] of [...byNet].sort(([a], [b]) => natCmp(a, b))) {
    const net = d.nets[netId];
    if (!net) continue;
    const tied = list.filter((g) => g.labels.length);
    const loose = list.filter((g) => !g.labels.length);
    const pieces = loose.length + (tied.length ? 1 : 0) + (offSheet.has(netId) ? 1 : 0);
    if (pieces < 2) continue;
    for (const g of loose) {
      // at the pin where the label runs into the least (a free pin end first), else by name
      const cand = g.pins
        .map((i) => pins[i]!)
        .filter((p) => p.net === netId)
        .map((p) => ({ p, ...labelAt(d, net, p), wired: wired.has(`${p.pin.x},${p.pin.y}`) }))
        .map((c) => ({ ...c, hits: crowding(scene, c.label, c.p.sym) }))
        .sort((a, b) => a.hits - b.hits || Number(a.wired) - Number(b.wired) || natCmp(`${a.p.comp.refdes}.${a.p.pin.number}`, `${b.p.comp.refdes}.${b.p.pin.number}`));
      const best = cand[0];
      if (!best) continue;
      scene.wires.push(...best.wires.map((w) => ({ ...w, auto: true })));
      scene.labels.push({ ...best.label, auto: true });
    }
  }
}

/** The label (and the lead to it, for a supply that must turn aside) a pin's net gets at that pin. */
function labelAt(d: Design, net: NonNullable<Design['nets'][string]>, p: PinAt): { label: LabelView; wires: WireView[] } {
  return labelForPin(net, p.pin, cardOf(d, p.comp.part)?.pins.find((x) => x.number === p.pin.number)?.type);
}

/* --------------------------------- storing --------------------------------- */

/** A sheet as the auto-layout drew it, to be stored and kept. */
function freeze(d: Design, view: Pick<SheetView, 'pages' | 'symbols' | 'wires' | 'labels'>): SheetDrawing {
  return {
    pages: view.pages.map((p) => ({ ...p.rect })),
    symbols: view.symbols.map((s) => freezeSymbol(d, s)),
    wires: view.wires.filter((w) => !w.auto).map((w) => ({ netId: w.netId, pts: [...w.pts] })),
    labels: view.labels.filter((l) => !l.auto).map(({ text: _t, auto: _a, ...l }) => ({ ...l })),
  };
}

function freezeSymbol(d: Design, s: SymbolView): DrawnSymbol {
  const m = symbolMaking(s);
  if (!m) throw new Error(`${s.refdes}: symbol made without makeSymbol, so it cannot be stored`);
  const w = drawnWith(s);
  return {
    comp: s.componentId,
    ...(s.unit ? { unit: s.unit } : {}),
    part: d.components[s.componentId]!.part,
    ...(w ? { with: w } : {}),
    spec: m.spec,
    x: m.x,
    y: m.y,
    ...(s.rotation ? { rot: s.rotation } : {}),
    bbox: { ...s.bbox },
    ref: { ...s.refPos },
    value: { ...s.valuePos },
  };
}

/** Take a sheet over from the auto-layout: its drawing as it is now is stored, and kept from here on. */
export function ownSheet(d: Design, sheetId: string): SheetDrawing {
  const have = d.drawing?.[sheetId];
  if (have) {
    syncSheet(d, sheetId);
    return have;
  }
  const sd = freeze(d, layoutSheetOf(d, sheetId));
  d.drawing = { ...d.drawing, [sheetId]: sd };
  return sd;
}

/** Hand a sheet back to the auto-layout (auto_draw): it draws it afresh after every change again. */
export function releaseSheet(d: Design, sheetId: string): boolean {
  if (!d.drawing?.[sheetId]) return false;
  delete d.drawing[sheetId];
  if (!Object.keys(d.drawing).length) delete d.drawing;
  return true;
}

/* -------------------------------- in step ---------------------------------- */

/** Keep every stored drawing in step with the netlist; run after every change of the design. */
export function syncDrawing(d: Design): void {
  if (!d.drawing) return;
  for (const id of Object.keys(d.drawing)) {
    if (d.sheets[id]) syncSheet(d, id);
    else delete d.drawing[id];
  }
  if (!Object.keys(d.drawing).length) delete d.drawing;
}

export function syncSheet(d: Design, sheetId: string): void {
  const sd = d.drawing![sheetId]!;
  const comps = componentsSorted(d).filter((c) => c.sheet === sheetId && cardOf(d, c.part));
  // symbols: a component that is gone, on another sheet, drawn from another card or with other units leaves
  const want = new Map(comps.map((c) => {
    const card = cardOf(d, c.part)!;
    return [c.id, unitCount(card) > 1 ? card.units!.map((u) => u.name).sort() : ['']] as const;
  }));
  const units = new Map<string, string[]>();
  for (const s of sd.symbols) units.set(s.comp, [...(units.get(s.comp) ?? []), s.unit ?? '']);
  const fits = (s: DrawnSymbol) => {
    const w = want.get(s.comp);
    return !!w && d.components[s.comp]!.part === s.part && JSON.stringify([...units.get(s.comp)!].sort()) === JSON.stringify(w);
  };
  sd.symbols = sd.symbols.filter(fits);
  fixConnections(d, sd);
  const drawn = new Set(sd.symbols.map((s) => s.comp));
  const fresh = comps.filter((c) => !drawn.has(c.id)).map((c) => c.id);
  if (fresh.length) placeFresh(d, sheetId, sd, fresh);
  cleanWires(d, sd, sd.symbols.map((s) => symbolOf(d, s)!), (p) => {
    const page = sd.pages.find((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
    return page ? drawingArea(page) : null;
  });
  tidyPages(d, sd);
}

/**
 * Wires and labels follow the netlist: a group of wires takes the net of the pins it joins; a wire
 * running to a pin of another net (the pin was disconnected or moved to another net) is taken out,
 * and the ends left loose are cut back. A label takes the net of what it sits on, and one that sits
 * on nothing any more goes.
 */
function fixConnections(d: Design, sd: SheetDrawing): void {
  const symbols = sd.symbols.map((s) => symbolOf(d, s)!);
  const pins = pinsOf(d, symbols);
  for (let round = 0; round < 8; round++) {
    let changed = false;
    const drop = new Set<number>();
    for (const g of groups(pins, sd.wires, sd.labels)) {
      if (!g.wires.length) continue;
      const nets = g.pins.map((i) => pins[i]!.net);
      if (!nets.length) {
        if (!d.nets[sd.wires[g.wires[0]!]!.netId]) g.wires.forEach((i) => drop.add(i));
        continue;
      }
      const count = new Map<string, number>();
      for (const n of nets) if (n) count.set(n, (count.get(n) ?? 0) + 1);
      const best = [...count].sort((a, b) => b[1] - a[1] || natCmp(a[0], b[0]))[0]?.[0];
      if (!best) {
        g.wires.forEach((i) => drop.add(i));
        continue;
      }
      if (nets.every((n) => n === best)) {
        for (const i of g.wires) if (sd.wires[i]!.netId !== best) (sd.wires[i]!.netId = best), (changed = true);
        continue;
      }
      // the wires that run to a pin of another net go; what they leave loose is cut back below
      for (const i of g.pins) {
        const p = pins[i]!;
        if (p.net === best) continue;
        for (const w of g.wires) if (onWire(p.pin.x, p.pin.y, sd.wires[w]!.pts)) drop.add(w);
      }
    }
    if (drop.size) {
      sd.wires = sd.wires.filter((_, i) => !drop.has(i));
      changed = true;
    }
    if (pruneLoose(sd, pins)) changed = true;
    if (!changed) break;
  }
  // labels: the net of the wire or pin they sit on (it may have changed: two nets merged), or gone
  sd.labels = sd.labels.flatMap((l) => {
    const on = sd.wires.filter((w) => onWire(l.x, l.y, w.pts));
    const n = (on.find((w) => w.netId === l.netId) ?? on[0])?.netId ?? pins.find((p) => p.pin.x === l.x && p.pin.y === l.y)?.net;
    const net = n ? d.nets[n] : undefined;
    if (!net) return [];
    const kind: LabelView['kind'] = deco(net, 0, 0, 'right').kind;
    if (kind === l.kind) return [{ ...l, netId: net.id }];
    // the net became a supply (or stopped being one): drawn the way such a net is
    const dir: Dir = l.stub ?? (l.dir === 'on' ? 'right' : l.dir);
    const { text: _t, ...nl } = deco(net, l.x, l.y, dir);
    return [nl];
  });
}

/**
 * Cut back wire ends that lead nowhere (not on a pin, a label of the net or another wire of the
 * net), each to the last point where something joins it. True if anything changed.
 */
function pruneLoose(sd: SheetDrawing, pins: PinAt[]): boolean {
  let changed = false;
  const joined = (wi: number, x: number, y: number) => {
    const w = sd.wires[wi]!;
    if (pins.some((p) => p.pin.x === x && p.pin.y === y)) return true;
    if (sd.labels.some((l) => l.x === x && l.y === y)) return true;
    return sd.wires.some((o, j) => j !== wi && o.netId === w.netId && o.pts.length >= 4 && onWire(x, y, o.pts));
  };
  /** A point on the segment from (ax, ay) to the loose end (bx, by) where something joins, nearest the end. */
  const stopOn = (wi: number, ax: number, ay: number, bx: number, by: number): [number, number] | undefined => {
    const w = sd.wires[wi]!;
    const cand: [number, number][] = [];
    for (const p of pins) if (onSeg(p.pin.x, p.pin.y, ax, ay, bx, by)) cand.push([p.pin.x, p.pin.y]);
    for (const l of sd.labels) if (onSeg(l.x, l.y, ax, ay, bx, by)) cand.push([l.x, l.y]);
    sd.wires.forEach((o, j) => {
      if (j === wi || o.netId !== w.netId) return;
      for (const [x, y] of ends(o)) if (onSeg(x, y, ax, ay, bx, by)) cand.push([x, y]);
    });
    const far = cand.filter(([x, y]) => x !== ax || y !== ay);
    far.sort((p, q) => Math.abs(p[0] - bx) + Math.abs(p[1] - by) - (Math.abs(q[0] - bx) + Math.abs(q[1] - by)));
    return far[0];
  };
  for (let wi = 0; wi < sd.wires.length; wi++) {
    for (const side of [0, 1]) {
      const w = sd.wires[wi]!;
      if (side) w.pts = reversePts(w.pts);
      while (w.pts.length >= 4) {
        const [bx, by] = [w.pts.at(-2)!, w.pts.at(-1)!];
        if (joined(wi, bx, by)) break;
        const [ax, ay] = [w.pts.at(-4)!, w.pts.at(-3)!];
        const stop = stopOn(wi, ax, ay, bx, by);
        changed = true;
        if (stop) {
          w.pts.splice(-2, 2, stop[0], stop[1]);
          break;
        }
        w.pts.splice(-2, 2);
      }
      if (side) w.pts = reversePts(w.pts);
    }
  }
  const before = sd.wires.length;
  sd.wires = sd.wires.filter((w) => w.pts.length >= 4 && (w.pts[0] !== w.pts.at(-2) || w.pts[1] !== w.pts.at(-1) || w.pts.length > 4));
  return changed || sd.wires.length !== before;
}

function reversePts(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i]!, pts[i + 1]!);
  return out;
}

/* ------------------------------- new parts --------------------------------- */

/** Room kept around what is already drawn when new parts are put in. */
const CLEAR = 200;

/**
 * Parts the drawing does not have yet: the auto-layout draws them on their own (each of its pages
 * a block), and each block goes into the first free spot, top-left first, or on a new page. Their
 * connections to the parts already drawn show as labels (autoLabels) until the agent wires them.
 */
function placeFresh(d: Design, sheetId: string, sd: SheetDrawing, ids: string[]): void {
  // a part of a functional block goes next to the parts of its block already drawn, drawn with
  // the others of its block that are new
  const groups = blockAssignment(d, sheetId);
  const loose: string[] = [];
  const byBlock = new Map<string, string[]>();
  for (const id of ids) {
    const b = groups?.blocks.find((x) => x.ids.includes(id));
    if (b) byBlock.set(b.title, [...(byBlock.get(b.title) ?? []), id]);
    else loose.push(id);
  }
  for (const [title, fresh] of byBlock) {
    const mine = new Set(groups!.blocks.find((b) => b.title === title)!.ids);
    const old = sd.symbols.filter((s) => mine.has(s.comp) && !fresh.includes(s.comp));
    const view = layoutSheetOf(d, sheetId, new Set(fresh));
    const scene: Scene = { symbols: view.symbols, wires: view.wires, labels: view.labels, junctions: [], noConnects: [] };
    autoLabels(d, scene);
    for (const x of [...scene.labels, ...scene.wires]) delete x.auto;
    const frozen = freeze(d, { pages: [], ...scene });
    const bb = extent(d, frozen);
    const near = old.length ? old.map((s) => s.bbox).reduce((a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) })) : undefined;
    const spot = (near && freeSpotNear(d, sd, bb, near)) || freeSpot(d, sd, bb);
    translate(frozen, spot.dx, spot.dy);
    sd.symbols.push(...frozen.symbols);
    sd.wires.push(...frozen.wires);
    sd.labels.push(...frozen.labels);
  }
  if (!loose.length) return;
  const view = layoutSheetOf(d, sheetId, new Set(loose));
  for (const page of view.pages) {
    const block = {
      symbols: view.symbols.filter((s) => inside(page.rect, centre(s.bbox))),
      wires: view.wires.filter((w) => inside(page.rect, { x: w.pts[0]!, y: w.pts[1]! })),
      labels: view.labels.filter((l) => inside(page.rect, l)),
    };
    if (!block.symbols.length) continue;
    // their connections to the parts already drawn get labels now, so the spot leaves room for them
    const scene: Scene = { ...block, junctions: [], noConnects: [] };
    autoLabels(d, scene);
    for (const x of [...scene.labels, ...scene.wires]) delete x.auto;
    const frozen = freeze(d, { pages: [], ...scene });
    const bb = extent(d, frozen);
    const spot = freeSpot(d, sd, bb);
    translate(frozen, spot.dx, spot.dy);
    sd.symbols.push(...frozen.symbols);
    sd.wires.push(...frozen.wires);
    sd.labels.push(...frozen.labels);
  }
}

/** Where a block with this extent fits: an offset on the grid that keeps it clear of everything on a page, else on a new page. */
function freeSpot(d: Design, sd: SheetDrawing, bb: Rect): { dx: number; dy: number } {
  const taken = boxes(d, sd).map((r) => grow(r, CLEAR));
  for (const page of sd.pages) {
    const area = drawingArea(page);
    const dx0 = Math.ceil((area.x - bb.x) / GRID) * GRID;
    const dy0 = Math.ceil((area.y - bb.y) / GRID) * GRID;
    for (let dy = dy0; bb.y + dy + bb.h <= area.y + area.h; dy += GRID) {
      for (let dx = dx0; bb.x + dx + bb.w <= area.x + area.w; dx += GRID) {
        const r = { x: bb.x + dx, y: bb.y + dy, w: bb.w, h: bb.h };
        if (!taken.some((t) => hits(t, r))) return { dx, dy };
      }
    }
  }
  // a new page, as big as it must be, after the others (tidyPages puts it in the grid)
  const paper = paperOf(d.paper);
  const last = sd.pages.at(-1);
  const rect = { x: last ? last.x + last.w + PAGE_GAP : 0, y: last ? last.y : 0, w: Math.max(paper.w, grid(bb.w) + 2 * PAGE.margin), h: Math.max(paper.h, grid(bb.h) + 2 * PAGE.margin + PAGE.title) };
  sd.pages.push(rect);
  return { dx: Math.round((rect.x + PAGE.margin - bb.x) / GRID) * GRID, dy: Math.round((rect.y + PAGE.margin - bb.y) / GRID) * GRID };
}

/**
 * The clear spot for a block of this extent nearest to `near` (the parts of its functional block),
 * on the page `near` is on; undefined when that page has no room.
 */
function freeSpotNear(d: Design, sd: SheetDrawing, bb: Rect, near: Rect): { dx: number; dy: number } | undefined {
  const taken = boxes(d, sd).map((r) => grow(r, CLEAR));
  const area = drawingArea(sd.pages[pageAt(sd.pages, centre(near))]!);
  const dx0 = Math.ceil((area.x - bb.x) / GRID) * GRID;
  const dy0 = Math.ceil((area.y - bb.y) / GRID) * GRID;
  const gapTo = (r: Rect) => Math.max(0, near.x - (r.x + r.w), r.x - (near.x + near.w)) + Math.max(0, near.y - (r.y + r.h), r.y - (near.y + near.h));
  let best: { dx: number; dy: number; gap: number } | undefined;
  for (let dy = dy0; bb.y + dy + bb.h <= area.y + area.h; dy += GRID) {
    for (let dx = dx0; bb.x + dx + bb.w <= area.x + area.w; dx += GRID) {
      const r = { x: bb.x + dx, y: bb.y + dy, w: bb.w, h: bb.h };
      const g = gapTo(r);
      if (best && g >= best.gap) continue;
      if (!taken.some((t) => hits(t, r))) best = { dx, dy, gap: g };
    }
  }
  return best && { dx: best.dx, dy: best.dy };
}

const grid = (v: number) => Math.ceil(v / GRID) * GRID;
export const drawingArea = (p: Rect): Rect => ({ x: p.x + PAGE.margin, y: p.y + PAGE.margin, w: p.w - 2 * PAGE.margin, h: p.h - 2 * PAGE.margin - PAGE.title });
const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const inside = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const grow = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });

/** The boxes what is drawn takes: symbols with their text, labels, wires. */
function boxes(d: Design, sd: Pick<SheetDrawing, 'symbols' | 'wires' | 'labels'>): Rect[] {
  const out: Rect[] = [];
  for (const s of sd.symbols) {
    const c = d.components[s.comp];
    out.push(s.bbox);
    if (c) out.push(textRect(s.ref, [c.refdes]), textRect(s.value, [c.refdes]));
  }
  for (const l of sd.labels) out.push(labelRect({ ...l, text: d.nets[l.netId]?.name ?? '' }));
  for (const w of sd.wires) out.push(wireBox(w.pts));
  return out;
}

const wireBox = (pts: number[]): Rect => {
  const xs = pts.filter((_, i) => i % 2 === 0);
  const ys = pts.filter((_, i) => i % 2 === 1);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

function extent(d: Design, sd: Pick<SheetDrawing, 'symbols' | 'wires' | 'labels'>): Rect {
  const bs = boxes(d, sd);
  if (!bs.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
}

function translate(sd: Pick<SheetDrawing, 'symbols' | 'wires' | 'labels'>, dx: number, dy: number): void {
  for (const s of sd.symbols) moveSymbolBy(s, dx, dy);
  for (const w of sd.wires) w.pts = w.pts.map((v, i) => v + (i % 2 ? dy : dx));
  for (const l of sd.labels) {
    l.x += dx;
    l.y += dy;
  }
}

function moveSymbolBy(s: DrawnSymbol, dx: number, dy: number): void {
  s.x += dx;
  s.y += dy;
  s.bbox = { ...s.bbox, x: s.bbox.x + dx, y: s.bbox.y + dy };
  s.ref = { ...s.ref, x: s.ref.x + dx, y: s.ref.y + dy };
  s.value = { ...s.value, x: s.value.x + dx, y: s.value.y + dy };
}

/* ---------------------------------- pages ---------------------------------- */

/** The page a point belongs to: the one it is on, else the nearest. */
export function pageAt(pages: Rect[], p: { x: number; y: number }): number {
  const on = pages.findIndex((r) => inside(r, p));
  if (on >= 0) return on;
  let best = 0;
  let dist = Infinity;
  pages.forEach((r, i) => {
    const dd = Math.max(r.x - p.x, 0, p.x - r.x - r.w) + Math.max(r.y - p.y, 0, p.y - r.y - r.h);
    if (dd < dist) (dist = dd), (best = i);
  });
  return best;
}

/**
 * Pages fit what is on them (at least the paper, as big as their content needs), empty pages at the
 * end go (one stays), and the pages stand in a near-square grid like the layout's, their content
 * moving with them.
 */
function tidyPages(d: Design, sd: SheetDrawing): void {
  if (!sd.pages.length) sd.pages.push({ x: 0, y: 0, ...paperOf(d.paper) });
  const of = {
    symbols: sd.symbols.map((s) => pageAt(sd.pages, centre(s.bbox))),
    wires: sd.wires.map((w) => pageAt(sd.pages, { x: w.pts[0]!, y: w.pts[1]! })),
    labels: sd.labels.map((l) => pageAt(sd.pages, l)),
  };
  const used = new Set([...of.symbols, ...of.wires, ...of.labels]);
  let n = sd.pages.length;
  while (n > 1 && !used.has(n - 1)) n--;
  const paper = paperOf(d.paper);
  const sizes = sd.pages.slice(0, n).map((r, i) => {
    const mine = {
      symbols: sd.symbols.filter((_, j) => of.symbols[j] === i),
      wires: sd.wires.filter((_, j) => of.wires[j] === i),
      labels: sd.labels.filter((_, j) => of.labels[j] === i),
    };
    const e = mine.symbols.length || mine.labels.length || mine.wires.length ? extent(d, mine) : { x: r.x, y: r.y, w: 0, h: 0 };
    return { w: Math.max(paper.w, grid(e.x + e.w - r.x + PAGE.margin)), h: Math.max(paper.h, grid(e.y + e.h - r.y + PAGE.margin + PAGE.title)) };
  });
  const cols = Math.ceil(Math.sqrt(n));
  const colW = Array.from({ length: cols }, (_, c) => Math.max(0, ...sizes.filter((_, i) => i % cols === c).map((z) => z.w)));
  const rowH = Array.from({ length: Math.ceil(n / cols) }, (_, r) => Math.max(0, ...sizes.slice(r * cols, (r + 1) * cols).map((z) => z.h)));
  const colX = colW.map((_, c) => colW.slice(0, c).reduce((x, w) => x + w + PAGE_GAP, 0));
  const rowY = rowH.map((_, r) => rowH.slice(0, r).reduce((y, h) => y + h + PAGE_GAP, 0));
  const pages = sizes.map((z, i) => ({ x: colX[i % cols]!, y: rowY[Math.floor(i / cols)]!, ...z }));
  const shift = pages.map((p, i) => ({ dx: p.x - sd.pages[i]!.x, dy: p.y - sd.pages[i]!.y }));
  sd.symbols.forEach((s, j) => {
    const m = shift[Math.min(of.symbols[j]!, n - 1)]!;
    if (m.dx || m.dy) moveSymbolBy(s, m.dx, m.dy);
  });
  sd.wires.forEach((w, j) => {
    const m = shift[Math.min(of.wires[j]!, n - 1)]!;
    if (m.dx || m.dy) w.pts = w.pts.map((v, i) => v + (i % 2 ? m.dy : m.dx));
  });
  sd.labels.forEach((l, j) => {
    const m = shift[Math.min(of.labels[j]!, n - 1)]!;
    l.x += m.dx;
    l.y += m.dy;
  });
  sd.pages = pages;
}

/** Add empty pages until the sheet has `count`. */
export function addPages(d: Design, sd: SheetDrawing, count: number): void {
  const paper = paperOf(d.paper);
  while (sd.pages.length < count) {
    const last = sd.pages.at(-1)!;
    sd.pages.push({ x: last.x + last.w + PAGE_GAP, y: last.y, w: paper.w, h: paper.h });
  }
}

/* ------------------------------ arranging ---------------------------------- */

/**
 * Move a symbol so its centre is at (x, y) on a page of its sheet (place_symbol), optionally lying
 * or standing (two-pin parts) or mirrored (ICs and connectors). An IC or connector takes the small
 * parts drawn at its pins with it, still wired; a two-pin part goes alone. Wires to what stays are
 * cut back; the connections they made show as labels until the agent wires them again.
 * The move is a whole number of grid steps, so the drawing stays on the grid. Returns where the
 * symbol's centre ended up (page coordinates) and the symbol that now lies under it, if any.
 */
export function moveSymbol(d: Design, sheetId: string, comp: Component, unit: string | undefined, page: number, x: number, y: number, look: { orient?: 'upright' | 'lying'; mirror?: boolean }): { x: number; y: number; under?: string } {
  const sd = ownSheet(d, sheetId);
  const i = sd.symbols.findIndex((s) => s.comp === comp.id && (s.unit ?? undefined) === unit);
  if (i < 0) throw new Error(`${comp.refdes}${unit ?? ''} is not on its sheet`);
  addPages(d, sd, page);
  const card = cardOf(d, comp.part)!;
  const two = isTwoPin(card);
  const target = sd.symbols[i]!;
  const key = symbolKey(comp.id, unit);
  // what moves with it: for an IC or connector, the small parts drawn with it or wired only to it
  const moving = new Set([i]);
  if (!two) {
    sd.symbols.forEach((s, j) => {
      if (s.with === key) moving.add(j);
    });
    const symbols = sd.symbols.map((s) => symbolOf(d, s)!);
    const pins = pinsOf(d, symbols);
    for (let grew = true; grew; ) {
      grew = false;
      for (const g of groups(pins, sd.wires, sd.labels)) {
        const syms = new Set(g.pins.map((p) => pins[p]!.sym));
        if (![...syms].some((s) => moving.has(s))) continue;
        const others = [...syms].filter((s) => !moving.has(s));
        if (!others.length || !others.every((s) => isTwoPin(cardOf(d, sd.symbols[s]!.part)!) && (!sd.symbols[s]!.with || sd.symbols[s]!.with === key))) continue;
        for (const s of others) moving.add(s);
        grew = true;
      }
    }
  } else {
    delete target.with; // it stands apart now
  }
  // the wires and labels that only touch what moves go with it
  const symbols = sd.symbols.map((s) => symbolOf(d, s)!);
  const pins = pinsOf(d, symbols);
  const carried = { wires: new Set<number>(), labels: new Set<number>() };
  for (const g of groups(pins, sd.wires, sd.labels)) {
    const syms = g.pins.map((p) => pins[p]!.sym);
    if (!syms.length || !syms.every((s) => moving.has(s))) continue;
    g.wires.forEach((w) => carried.wires.add(w));
    g.labels.forEach((l) => carried.labels.add(l));
  }
  // its new look: the symbol is made again, and what was wired to it is cut back
  const relook = restyle(d, comp, target, two, look);
  if (relook) {
    for (const g of groups(pins, sd.wires, sd.labels)) {
      if (!g.pins.some((p) => pins[p]!.sym === i)) continue;
      g.wires.forEach((w) => carried.wires.delete(w));
      g.labels.forEach((l) => carried.labels.delete(l));
    }
    sd.symbols[i] = relook;
  }
  const now = sd.symbols[i]!;
  const rect = sd.pages[page - 1]!;
  const c = centre(now.bbox);
  const dx = Math.round((rect.x + x - c.x) / GRID) * GRID;
  const dy = Math.round((rect.y + y - c.y) / GRID) * GRID;
  for (const j of moving) moveSymbolBy(sd.symbols[j]!, dx, dy);
  sd.wires.forEach((w, j) => {
    if (carried.wires.has(j)) w.pts = w.pts.map((v, k) => v + (k % 2 ? dy : dx));
  });
  sd.labels.forEach((l, j) => {
    if (!carried.labels.has(j)) return;
    l.x += dx;
    l.y += dy;
  });
  syncSheet(d, sheetId);
  const moved = sd.symbols.find((s) => s.comp === comp.id && (s.unit ?? undefined) === unit)!;
  const under = sd.symbols.find((s) => s !== moved && hits(s.bbox, moved.bbox));
  const at = centre(moved.bbox);
  const pg = sd.pages[pageAt(sd.pages, at)]!;
  return { x: Math.round(at.x - pg.x), y: Math.round(at.y - pg.y), ...(under ? { under: `${d.components[under.comp]!.refdes}${under.unit ?? ''}` } : {}) };
}

/** The symbol made again with a new look (lying or standing, mirrored), centred where it was; undefined when the look does not change. */
function restyle(d: Design, comp: Component, s: DrawnSymbol, two: boolean, look: { orient?: 'upright' | 'lying'; mirror?: boolean }): DrawnSymbol | undefined {
  const card = cardOf(d, comp.part)!;
  const c = centre(s.bbox);
  const [cx, cy] = [Math.round(c.x / GRID) * GRID, Math.round(c.y / GRID) * GRID];
  const base = { comp: s.comp, ...(s.unit ? { unit: s.unit } : {}), part: s.part, ...(s.with ? { with: s.with } : {}) };
  if (two && look.orient) {
    const lying = !!s.rot;
    if ((look.orient === 'lying') === lying) return undefined;
    if (look.orient === 'lying') {
      const def = uprightSymbol(card);
      return { ...base, spec: def.spec!, x: cx, y: cy, rot: -90, bbox: { x: cx - 200, y: cy - 100, w: 400, h: 200 }, ref: { x: cx, y: cy - 175, anchor: 'middle' }, value: { x: cx, y: cy - 90, anchor: 'middle' } };
    }
    return made(d, comp, base, symbolFor(card), cx, cy);
  }
  if (!two && look.mirror !== undefined && look.mirror !== !!s.spec.mirror) {
    return made(d, comp, base, symbolFor(card, false, { ...s.spec, mirror: look.mirror }), cx, cy);
  }
  return undefined;
}

/**
 * A part whose card now draws its symbol differently (set_symbol layout) is made again on every
 * stored drawing, centred where it stood; the next sync cuts back the wires to pins that moved.
 * Split units are left to the sync (it draws them afresh). The names of the sheets touched.
 */
export function remakeSymbols(d: Design, partId: string): string[] {
  const card = cardOf(d, partId);
  const touched: string[] = [];
  if (!card) return touched;
  for (const [sheetId, sd] of Object.entries(d.drawing ?? {})) {
    let hit = false;
    sd.symbols = sd.symbols.map((s) => {
      const comp = d.components[s.comp];
      if (s.part !== partId || !comp || s.unit || s.spec.unit !== undefined) return s;
      hit = true;
      const c = centre(s.bbox);
      const base = { comp: s.comp, part: s.part, ...(s.with ? { with: s.with } : {}) };
      return made(d, comp, base, symbolFromSpec(card, s.spec), Math.round(c.x / GRID) * GRID, Math.round(c.y / GRID) * GRID);
    });
    if (hit) touched.push(d.sheets[sheetId]?.name ?? sheetId);
  }
  return touched;
}

function made(d: Design, comp: Component, base: Omit<DrawnSymbol, 'spec' | 'x' | 'y' | 'bbox' | 'ref' | 'value'>, def: ReturnType<typeof symbolFor>, cx: number, cy: number): DrawnSymbol {
  // centre the new symbol's box where the old one was
  const ox = cx - Math.round((def.bbox.x + def.bbox.w / 2) / GRID) * GRID;
  const oy = cy - Math.round((def.bbox.y + def.bbox.h / 2) / GRID) * GRID;
  const sym = makeSymbol(d, comp, def, ox, oy);
  return { ...base, spec: def.spec!, x: ox, y: oy, bbox: sym.bbox, ref: sym.refPos, value: sym.valuePos };
}

/**
 * Draw a functional block afresh on a stored drawing (place_block): its parts leave where they
 * stood, the layout draws them together and wired (blocks.ts), and the drawing goes in with its
 * frame's centre at (x, y) on that page of the sheet. Wires to the rest are cut back; those
 * connections show as labels. Returns where the centre ended up (page coordinates), the frame and
 * its page (canvas coordinates), and the part of another block it lies on, if any.
 */
export function redrawBlock(d: Design, sheetId: string, title: string, page: number, x: number, y: number): { x: number; y: number; frame: Rect; page: Rect; under?: string } {
  const sd = ownSheet(d, sheetId);
  const ids = new Set(blockAssignment(d, sheetId)?.blocks.find((b) => b.title === title)?.ids ?? []);
  addPages(d, sd, page);
  sd.symbols = sd.symbols.filter((s) => !ids.has(s.comp));
  const view = layoutSheetOf(d, sheetId, ids);
  const scene: Scene = { symbols: view.symbols, wires: view.wires, labels: view.labels, junctions: [], noConnects: [] };
  autoLabels(d, scene);
  for (const v of [...scene.labels, ...scene.wires]) delete v.auto;
  const frozen = freeze(d, { pages: [], ...scene });
  const frame = frameAround(extent(d, frozen));
  const rect = sd.pages[page - 1]!;
  const dx = Math.round((rect.x + x - (frame.x + frame.w / 2)) / GRID) * GRID;
  const dy = Math.round((rect.y + y - (frame.y + frame.h / 2)) / GRID) * GRID;
  translate(frozen, dx, dy);
  sd.symbols.push(...frozen.symbols);
  sd.wires.push(...frozen.wires);
  sd.labels.push(...frozen.labels);
  syncSheet(d, sheetId);
  const area = { ...frame, x: frame.x + dx, y: frame.y + dy };
  const under = sd.symbols.find((s) => !ids.has(s.comp) && hits(s.bbox, area));
  const pg = sd.pages[pageAt(sd.pages, centre(area))]!;
  return { x: Math.round(area.x + area.w / 2 - pg.x), y: Math.round(area.y + area.h / 2 - pg.y), frame: area, page: pg, ...(under ? { under: `${d.components[under.comp]!.refdes}${under.unit ?? ''}` } : {}) };
}

/**
 * Take symbols out of a stored drawing so the parts are drawn afresh in free space (auto_draw of
 * some parts, place_symbol auto). The wires to them are cut back. False if the sheet is not stored.
 */
export function redrawParts(d: Design, sheetId: string, compIds: Set<string>): boolean {
  const sd = d.drawing?.[sheetId];
  if (!sd) return false;
  sd.symbols = sd.symbols.filter((s) => !compIds.has(s.comp));
  syncSheet(d, sheetId);
  return true;
}
