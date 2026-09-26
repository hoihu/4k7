/**
 * Scene building blocks shared by the schematic layouts: geometry containers, symbol
 * placement, net decorations and extent estimates.
 */
import type { Component, Design, LabelView, Net, PinView, Point, Prim, Rect, SymbolView, WireView } from '@tracewise/schema';
import { CHAR_W, GRID, type SymbolDef } from '@tracewise/parts';
import { isGroundNet, isPowerNet, valueLinesOf, valueOf } from './doc.ts';

/* --------------------------------- scene ---------------------------------- */

export interface Scene {
  symbols: SymbolView[];
  wires: WireView[];
  junctions: Point[];
  labels: LabelView[];
  noConnects: Point[];
}

export const emptyScene = (): Scene => ({ symbols: [], wires: [], junctions: [], labels: [], noConnects: [] });
export const grid = (v: number) => Math.ceil(v / GRID) * GRID;
export const tw = (s: string) => s.length * CHAR_W;

export function translatePrim(p: Prim, dx: number, dy: number): Prim {
  switch (p.t) {
    case 'rect':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'line':
      return { ...p, x1: p.x1 + dx, y1: p.y1 + dy, x2: p.x2 + dx, y2: p.y2 + dy };
    case 'poly':
      return { ...p, pts: p.pts.map((v, i) => v + (i % 2 ? dy : dx)) };
    case 'circle':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'path':
      return {
        ...p,
        d: p.d.replace(/^M(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/, (_, x, y) => `M${Number(x) + dx},${Number(y) + dy}`)
          .replace(/ Q(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/, (_, a, b, c, e) =>
            ` Q${Number(a) + dx},${Number(b) + dy} ${Number(c) + dx},${Number(e) + dy}`),
      };
  }
}

export function translateScene(s: Scene, dx: number, dy: number): void {
  for (const sym of s.symbols) {
    sym.bbox = { ...sym.bbox, x: sym.bbox.x + dx, y: sym.bbox.y + dy };
    sym.prims = sym.prims.map((p) => translatePrim(p, dx, dy));
    sym.pins = sym.pins.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
    sym.refPos = { ...sym.refPos, x: sym.refPos.x + dx, y: sym.refPos.y + dy };
    sym.valuePos = { ...sym.valuePos, x: sym.valuePos.x + dx, y: sym.valuePos.y + dy };
    if (sym.origin) sym.origin = { x: sym.origin.x + dx, y: sym.origin.y + dy };
  }
  for (const w of s.wires) w.pts = w.pts.map((v, i) => v + (i % 2 ? dy : dx));
  for (const j of s.junctions) {
    j.x += dx;
    j.y += dy;
  }
  for (const l of s.labels) {
    l.x += dx;
    l.y += dy;
  }
  for (const n of s.noConnects) {
    n.x += dx;
    n.y += dy;
  }
}

export function mergeScene(into: Scene, s: Scene): void {
  into.symbols.push(...s.symbols);
  into.wires.push(...s.wires);
  into.junctions.push(...s.junctions);
  into.labels.push(...s.labels);
  into.noConnects.push(...s.noConnects);
}

/** Rough extent of a label decoration, for spacing and bounding boxes. */
export function labelRect(l: LabelView): Rect {
  const w = tw(l.text) + 80;
  if (l.kind === 'ground') {
    const ox = l.dir === 'left' ? -100 : l.dir === 'right' ? 100 : 0;
    return { x: l.x + ox - 80, y: l.y, w: 160, h: 260 };
  }
  switch (l.dir) {
    case 'right':
      return { x: l.x, y: l.y - 60, w: w + (l.kind === 'rail' ? 100 : 0), h: 120 + (l.kind === 'rail' ? 200 : 0) };
    case 'left':
      return { x: l.x - w - (l.kind === 'rail' ? 100 : 0), y: l.y - 60, w: w + (l.kind === 'rail' ? 100 : 0), h: 120 + (l.kind === 'rail' ? 200 : 0) };
    case 'up':
      return { x: l.x - w / 2, y: l.y - 260, w, h: 260 };
    case 'down':
      return { x: l.x - w / 2, y: l.y, w, h: 260 };
    case 'on':
      return { x: l.x - w / 2, y: l.y - 110, w, h: 110 };
  }
}

export function sceneBBox(s: Scene): Rect {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const add = (r: Rect) => {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  };
  const textRect = (p: SymbolView['refPos'], lines: string[]): Rect => {
    const w = Math.max(...lines.map(tw)) + 20;
    return { x: p.anchor === 'end' ? p.x - w : p.anchor === 'middle' ? p.x - w / 2 : p.x, y: p.y - 80, w, h: 100 + LINE * (lines.length - 1) };
  };
  for (const sym of s.symbols) {
    add(sym.bbox);
    add(textRect(sym.refPos, [sym.refdes]));
    add(textRect(sym.valuePos, sym.valueLines ?? [sym.value]));
  }
  for (const l of s.labels) add(labelRect(l));
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* -------------------------------- symbols --------------------------------- */

export function makeSymbol(d: Design, c: Component, def: SymbolDef, ox: number, oy: number): SymbolView {
  const sym: SymbolView = {
    componentId: c.id,
    refdes: c.refdes,
    value: valueOf(d, c),
    bbox: { ...def.bbox },
    prims: def.prims.map((p) => ({ ...p })) as Prim[],
    pins: def.pins.map((p) => ({ ...p })) as PinView[],
    refPos: { ...def.refPos },
    valuePos: { ...def.valuePos },
  };
  const lines = valueLinesOf(d, c);
  if (lines.length > 1) {
    sym.valueLines = lines;
    // keep the text block centred on a two-pin part
    if (def.kind === 'two_pin') {
      sym.refPos.y -= (LINE * (lines.length - 1)) / 2;
      sym.valuePos.y -= (LINE * (lines.length - 1)) / 2;
    }
  }
  const s = emptyScene();
  s.symbols.push(sym);
  translateScene(s, ox, oy);
  return sym;
}

/** Line height of stacked value text, in mils. */
export const LINE = 85;

/** Width a vertical two-pin part needs: body, its text on the right, and room for the next part's body. */
export function satWidth(d: Design, c: Component, bottomLabel?: string): number {
  const text = Math.max(tw(c.refdes), ...valueLinesOf(d, c).map(tw));
  const below = bottomLabel ? tw(bottomLabel) / 2 + 80 : 0;
  return Math.max(300, grid(Math.max(TEXT_GAP + text + 120, below + 100)));
}

/** Distance from a two-pin part's axis to its text. */
export const TEXT_GAP = 120;

/* ------------------------------- decorations ------------------------------ */

export type Dir = LabelView['dir'];

export function deco(net: Net, x: number, y: number, dir: Dir): LabelView {
  const kind: LabelView['kind'] = isGroundNet(net) ? 'ground' : isPowerNet(net) ? 'rail' : 'net';
  return { x, y, text: net.name, netId: net.id, kind, dir };
}

/** Horizontal room a decoration at a left/right pin end needs. */
export function decoWidth(net: Net | undefined): number {
  if (!net) return 0;
  if (isGroundNet(net)) return 200;
  return tw(net.name) + 80 + (isPowerNet(net) ? 100 : 0);
}

