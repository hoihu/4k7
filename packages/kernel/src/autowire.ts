/**
 * A two-pin part the agent places on its own (place_symbol) is wired to its neighbours where that
 * draws cleanly (docs/design/schematic-drawing.md §2a): each signal pin to the nearest other pin
 * or wire of its net on the page, by the `wire` op's path finder, when the path crosses no wire of
 * another net, runs through no label or name, turns back on no part, makes no jog and is short.
 * Otherwise nothing is drawn and the connection shows as the labels the drawing completes itself
 * with (`auto`), so a connection is never left out. Run once, as the part is placed: the wires are
 * ordinary ones, and an erase or a label of the agent's afterwards stays.
 */
import type { Component, Design, PinView, Rect, SheetDrawing, SheetView, SymbolView } from '@4k7/schema';
import { boxOf, crossings, doublesBack, gap, lengthOf, pieces } from './blocks.ts';
import { clearPinLabels, softBoxes } from './drawops.ts';
import { drawingArea, pageAt, symbolOf, syncSheet } from './drawing.ts';
import { deco, type Scene } from './scene.ts';
import { routeWire } from './schroute.ts';
import { wireShape } from './scope.ts';

/** The farthest a pin is wired to its neighbour, and how much longer than the direct way the wire may be. */
const REACH = 4000;
const SLACK = 800;
/** Corners a wire may have. */
const BENDS = 3;
/** How many neighbours, nearest first, are tried for a pin. */
const TRIES = 3;

export interface AutoWired {
  /** "R1.1 to U1.IN1" for each wire drawn. */
  wired: string[];
  /** "R1.2 (+3V3: why)" for each pin left to labels. */
  labelled: string[];
}

type PinRef = { sym: number; pin: PinView };

export function wirePlaced(d: Design, comp: Component): AutoWired {
  const out: AutoWired = { wired: [], labelled: [] };
  const sd = d.drawing?.[comp.sheet];
  if (!sd?.symbols.some((s) => s.comp === comp.id)) return out;
  const views = sd.symbols.map((s) => symbolOf(d, s)!);
  const self = views.findIndex((v) => v.componentId === comp.id);
  for (const pin of [...views[self]!.pins].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))) {
    const net = comp.pins[pin.number];
    const nn = net ? d.nets[net] : undefined;
    // a supply is a symbol at the pin, which place_symbol carried along
    if (!net || !nn || deco(nn, 0, 0, 'right').kind !== 'net') continue;
    const r = wirePin(d, sd, views, { sym: self, pin }, net);
    const ref = `${comp.refdes}.${pin.name === pin.number ? pin.number : pin.name}`;
    if (r.to) out.wired.push(`${ref} to ${r.to}`);
    else if (r.why) out.labelled.push(`${ref} (${nn.name}: ${r.why})`);
  }
  if (out.wired.length) syncSheet(d, comp.sheet);
  return out;
}

function wirePin(d: Design, sd: SheetDrawing, views: SymbolView[], me: PinRef, net: string): { to?: string; why?: string } {
  const { pin } = me;
  const scene = (): Scene => ({ symbols: views, wires: sd.wires, labels: [], junctions: [], noConnects: [] });
  const page = pageAt(sd.pages, pin);
  const onPage = (q: { x: number; y: number }) => pageAt(sd.pages, q) === page;
  const same = (a: PinRef, b: PinRef) => a.sym === b.sym && a.pin.number === b.pin.number;
  const refOf = (q: PinRef) => `${d.components[views[q.sym]!.componentId]!.refdes}.${q.pin.name === q.pin.number ? q.pin.number : q.pin.name}`;
  const all = pieces(d, scene(), net);
  const home = all.find((p) => p.pins.some((q) => same(q, me)));
  if (!home || home.pins.some((q) => q.sym !== me.sym)) return {}; // joined to a neighbour already
  const from = boxOf(scene(), home);
  const near = all
    .filter((p) => p !== home && p.pins.some((q) => onPage(q.pin)))
    .map((p) => ({ first: p.pins.find((q) => onPage(q.pin))!, p, g: gap(from, boxOf(scene(), p)) }))
    .sort((a, b) => a.g - b.g)
    .slice(0, TRIES);
  if (!near.length) return { why: 'no other pin of it on this page' };
  const area = drawingArea(sd.pages[page]!);
  const saved = { wires: sd.wires, labels: sd.labels };
  let why = '';
  for (const c of near) {
    // the labels (and their leads) at the pin and at the neighbour's pins are in the way of a wire
    for (const q of [pin, ...c.p.pins.map((x) => x.pin)]) clearPinLabels(sd, q);
    const ps = pieces(d, scene(), net);
    const mine = ps.find((p) => p.pins.some((q) => same(q, me)))!;
    const target = ps.find((p) => p.pins.some((q) => same(q, c.first)))!;
    const pts = routeWire({
      from: [{ x: pin.x, y: pin.y }],
      fromWires: mine.wires.map((i) => sd.wires[i]!.pts),
      to: target.pins.filter((q) => onPage(q.pin)).map((q) => ({ x: q.pin.x, y: q.pin.y })),
      toWires: target.wires.map((i) => sd.wires[i]!.pts),
      via: [],
      wires: sd.wires,
      symbols: views,
      soft: softBoxes(d, sd, net),
      bounds: area,
    });
    const bad = pts ? unclean(d, sd, views, net, pts, gap(from, boxOf(scene(), target))) : 'no clear path';
    sd.wires = saved.wires;
    sd.labels = saved.labels;
    if (pts && !bad) {
      // the wire takes the place of the labels at both ends
      clearPinLabels(sd, pin);
      const end = target.pins.find((q) => q.pin.x === pts.at(-2) && q.pin.y === pts.at(-1));
      if (end) clearPinLabels(sd, end.pin);
      sd.wires.push({ netId: net, pts });
      return { to: refOf(end ?? c.first) };
    }
    why ||= bad!;
  }
  return { why };
}

/** Why a path would not draw cleanly (undefined when it would). */
function unclean(d: Design, sd: SheetDrawing, views: SymbolView[], net: string, pts: number[], span: number): string | undefined {
  const direct = Math.abs(pts.at(-2)! - pts[0]!) + Math.abs(pts.at(-1)! - pts[1]!);
  if (crossings(pts, net, sd.wires)) return 'a wire would cross another';
  if (span > REACH) return 'too far';
  if (lengthOf(pts) > direct + SLACK) return 'a wire would wander';
  if (pts.length / 2 - 2 > BENDS || doublesBack(pts)) return 'a wire would turn back';
  // through the name of a part or the label of another net
  const text: Rect[] = softBoxes(d, sd, net);
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const [x1, y1, x2, y2] = [pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!];
    const l = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    if (text.some((r) => l.x < r.x + r.w && r.x < l.x + l.w && l.y < r.y + r.h && r.y < l.y + l.h)) return 'a name or label is in the way';
  }
  // no jog or detour the net did not have
  const sheet = (wires: SheetDrawing['wires']) => ({ wires, symbols: views, labels: sd.labels.map((l) => ({ ...l, text: '' })) }) as unknown as SheetView;
  const was = wireShape(sheet(sd.wires), net);
  const now = wireShape(sheet([...sd.wires, { netId: net, pts }]), net);
  if (now.jogs.length > was.jogs.length || now.detours.length > was.detours.length) return 'the wire would jog';
  return undefined;
}
