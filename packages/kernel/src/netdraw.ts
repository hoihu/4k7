/**
 * A net forced to be drawn one way (docs/design/schematic-drawing.md §2f; set_net draw_as, the
 * app's net panel). Everything happens on stored drawings: a sheet with such a net is taken over
 * from the auto-layout, and after every transaction the kernel draws the net that way again, so a
 * block redrawn, a part added or moved, or a hand edit elsewhere does not undo it.
 */
import type { Design, Net, SheetDrawing, SymbolView } from '@4k7/schema';
import { wireNet } from './autowire.ts';
import { boxOf, gap, pieces, type Piece } from './blocks.ts';
import { cardOf } from './doc.ts';
import { softBoxes } from './drawops.ts';
import { groups, ownSheet, pageAt, pinsOf, symbolOf, syncSheet } from './drawing.ts';
import { deco, drawingArea, labelForPin, type Scene, supplyDir, supplyStubs } from './scene.ts';
import { routeWire } from './schroute.ts';

const views = (d: Design, sheet: string) => d.drawing![sheet]!.symbols.map((s) => symbolOf(d, s)!);
const isSupply = (net: Net) => deco(net, 0, 0, 'right').kind !== 'net';

/** The label (and the lead to it, for a supply that must turn aside) a pin gets, as it is stored. */
function addLabel(d: Design, sheet: string, net: Net, p: ReturnType<typeof pinsOf>[number], stub?: number): void {
  const sd = d.drawing![sheet]!;
  const r = labelForPin(net, p.pin, cardOf(d, p.comp.part)?.pins.find((x) => x.number === p.pin.number)?.type, stub);
  sd.wires.push(...r.wires);
  const { text: _t, auto: _a, ...stored } = r.label;
  sd.labels.push(stored);
}

/** No wire between two pins, and a label or supply symbol at each. A lead from one pin to its own label stays. */
function byLabels(d: Design, sheet: string, net: Net): void {
  const sd = d.drawing![sheet]!;
  const symbols = views(d, sheet);
  const pins = pinsOf(d, symbols);
  const spot = (x: { x: number; y: number }) => `${x.x},${x.y}`;
  const wires = new Set<number>();
  const labels = new Set<number>();
  for (const g of groups(pins, sd.wires, sd.labels)) {
    const spots = new Set(g.pins.map((i) => pins[i]!).filter((p) => p.net === net.id).map((p) => spot(p.pin)));
    if (spots.size < 2) continue;
    g.wires.forEach((i) => wires.add(i));
    // what stands on those wires goes with them
    g.labels.forEach((i) => spots.has(spot(sd.labels[i]!)) || labels.add(i));
  }
  sd.wires = sd.wires.filter((_, i) => !wires.has(i));
  sd.labels = sd.labels.filter((_, i) => !labels.has(i));
  const now = groups(pins, sd.wires, sd.labels);
  const seen = new Set<string>();
  let added = false;
  pins.forEach((p, i) => {
    if (p.net !== net.id || seen.has(spot(p.pin))) return;
    seen.add(spot(p.pin));
    if (now.find((g) => g.pins.includes(i))!.labels.length) return;
    // (the symbols of neighbouring pins step out, clear of each other)
    const stubs = supplyStubs(symbols[p.sym]!.pins, (n) => (p.comp.pins[n] === net.id ? supplyDir(net) : null));
    addLabel(d, sheet, net, p, stubs.get(p.pin.number));
    added = true;
  });
  if (wires.size || labels.size || added) syncSheet(d, sheet);
}

/**
 * Every pin joined by wires, page by page, and no label; what no wire can join is left to the
 * automatic labels. A supply keeps one symbol per piece: a rail with none could not be read.
 * Returns how many pieces the net is drawn in.
 */
function byWires(d: Design, sheet: string, net: Net): number {
  const sd = d.drawing![sheet]!;
  const supply = isSupply(net);
  if (!supply && sd.labels.some((l) => l.netId === net.id)) {
    sd.labels = sd.labels.filter((l) => l.netId !== net.id);
    syncSheet(d, sheet); // (the leads that only ended in them are cut back)
  }
  const symbols = views(d, sheet);
  const scene = (): Scene => ({ symbols, wires: sd.wires, labels: [], junctions: [], noConnects: [] });
  const pagesOf = new Set(pieces(d, scene(), net.id).map((p) => pageAt(sd.pages, p.pins[0]!.pin)));
  let wired = false;
  for (const page of pagesOf) if (joinOnPage(d, sd, symbols, net, page)) wired = true;
  // (the new wires are tidied together: a sync per wire takes seconds on a net of many pins)
  if (wired) syncSheet(d, sheet);
  if (supply) keepOneSymbol(d, sheet, net);
  return pieces(d, { ...scene(), symbols: views(d, sheet) }, net.id).length;
}

/** Wire a net's pieces on one page together, from the biggest out, nearest first, however the wire runs; one with no way through stays apart. True if any wire was drawn. */
function joinOnPage(d: Design, sd: SheetDrawing, symbols: SymbolView[], net: Net, page: number): boolean {
  const scene = (): Scene => ({ symbols, wires: sd.wires, labels: [], junctions: [], noConnects: [] });
  const here = () => pieces(d, scene(), net.id).filter((p) => pageAt(sd.pages, p.pins[0]!.pin) === page);
  const name = (p: Piece) => `${p.pins[0]!.pin.x},${p.pins[0]!.pin.y}`;
  const spots = (p: Piece) => p.pins.map((q) => ({ x: q.pin.x, y: q.pin.y }));
  const lines = (p: Piece) => p.wires.map((i) => sd.wires[i]!.pts);
  const bounds = drawingArea(sd.pages[page]!);
  const soft = softBoxes(d, sd, net.id);
  const through = here().flatMap(spots);
  const stuck = new Set<string>();
  let wired = false;
  for (;;) {
    const [joined, ...rest] = here().sort((a, b) => b.pins.length - a.pins.length);
    if (!joined) return wired;
    const box = boxOf(scene(), joined);
    const next = rest.filter((p) => !stuck.has(name(p))).sort((a, b) => gap(boxOf(scene(), a), box) - gap(boxOf(scene(), b), box))[0];
    if (!next) return wired;
    const pts = routeWire({ from: spots(next), fromWires: lines(next), to: spots(joined), toWires: lines(joined), via: [], wires: sd.wires, symbols, soft, bounds, through });
    if (pts) (sd.wires.push({ netId: net.id, pts }), (wired = true));
    else stuck.add(name(next));
  }
}

/** One symbol on each drawn piece of a supply: the first there, or a new one at its first pin. */
function keepOneSymbol(d: Design, sheet: string, net: Net): void {
  const sd = d.drawing![sheet]!;
  const pins = pinsOf(d, views(d, sheet));
  const extra = new Set<number>();
  const bare: (typeof pins)[number][] = [];
  for (const g of groups(pins, sd.wires, sd.labels)) {
    const mine = g.pins.map((i) => pins[i]!).filter((p) => p.net === net.id);
    if (!mine.length) continue;
    const symbols = g.labels.filter((i) => sd.labels[i]!.netId === net.id);
    if (!symbols.length) bare.push(mine[0]!);
    symbols.slice(1).forEach((i) => extra.add(i));
  }
  sd.labels = sd.labels.filter((_, i) => !extra.has(i));
  for (const p of bare) addLabel(d, sheet, net, p);
  if (extra.size || bare.length) syncSheet(d, sheet);
}

/** No longer forced: drawn afresh by the rule for a part placed on its own, wired where that is clean. A supply stands at its pins, as the layout draws it. */
function afresh(d: Design, sheet: string, net: Net): void {
  if (isSupply(net)) return byLabels(d, sheet, net);
  const sd = d.drawing![sheet]!;
  sd.wires = sd.wires.filter((w) => w.netId !== net.id);
  sd.labels = sd.labels.filter((l) => l.netId !== net.id);
  syncSheet(d, sheet);
  wireNet(d, sheet, net.id);
}

/** Draw a net that way on every sheet it is on. `auto` leaves the sheets the layout draws to the layout. Returns how many connections no wire could show (`wire`). */
export function drawNet(d: Design, netId: string, as: 'label' | 'wire' | 'auto'): number {
  const net = d.nets[netId];
  if (!net) return 0;
  const sheets = new Set(Object.values(d.components).filter((c) => Object.values(c.pins).includes(netId)).map((c) => c.sheet));
  let drawn = 0;
  for (const sheet of sheets) {
    if (as === 'auto' && !d.drawing?.[sheet]) continue;
    ownSheet(d, sheet);
    if (as === 'label') byLabels(d, sheet, net);
    else if (as === 'wire') drawn += byWires(d, sheet, net);
    else afresh(d, sheet, net);
  }
  return Math.max(0, drawn - 1);
}

/** Draw every forced net its way again; run after every transaction. */
export function keepForcedNets(d: Design): void {
  for (const net of Object.values(d.nets)) if (net.attrs.drawAs) drawNet(d, net.id, net.attrs.drawAs);
}
