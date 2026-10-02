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
  if (l.kind !== 'net') {
    // vertical supply symbol, possibly after a horizontal stub
    const sx = l.x + (l.stub === 'left' ? -1 : l.stub === 'right' ? 1 : 0) * (l.stubLen ?? 100);
    const half = l.kind === 'ground' ? 80 : Math.max(80, w / 2);
    // ground: bars 150 deep; rail: 200 stem + arrow + name
    const h = (l.kind === 'ground' ? 260 : 400) + (l.rise ?? 0);
    const sym: Rect = l.dir === 'up' ? { x: sx - half, y: l.y - h, w: 2 * half, h } : { x: sx - half, y: l.y, w: 2 * half, h };
    const x0 = Math.min(sym.x, l.x);
    const x1 = Math.max(sym.x + sym.w, l.x);
    return { x: x0, y: sym.y, w: x1 - x0, h: sym.h };
  }
  switch (l.dir) {
    case 'right':
      return { x: l.x, y: l.y - 60, w, h: 120 };
    case 'left':
      return { x: l.x - w, y: l.y - 60, w, h: 120 };
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

/** Distance from a two-pin part's axis to its text. */
export const TEXT_GAP = 100;
/** Widest half-body of a neighbouring two-pin part (capacitor plates, 80) plus clear air. */
const NEXT_BODY = 140;

/**
 * Width a vertical two-pin part needs: its text on the right and room for the next part's
 * body. Rounded to a 50-mil grid (the usual schematic grid) to keep columns tight.
 */
export function satWidth(d: Design, c: Component, bottomLabel?: string): number {
  const text = Math.max(tw(c.refdes), ...valueLinesOf(d, c).map(tw));
  const below = bottomLabel ? tw(bottomLabel) / 2 + 80 : 0;
  return Math.max(300, halfGrid(Math.max(TEXT_GAP + text + NEXT_BODY, below + 100)));
}

const halfGrid = (v: number) => Math.ceil(v / 50) * 50;

/* ------------------------------- decorations ------------------------------ */

export type Dir = LabelView['dir'];

/** Negative supplies point down like ground: VSS, VEE, V-, or a negative voltage. */
export function isNegativeRail(net: Net): boolean {
  return (net.attrs.voltage ?? 0) < 0 || /^(-|VSS|VEE|V-|VNEG)/i.test(net.name);
}

/** Which way a net's supply symbol points, or null for signal nets. */
export function supplyDir(net: Net): 'up' | 'down' | null {
  if (isGroundNet(net)) return 'down';
  if (isPowerNet(net)) return isNegativeRail(net) ? 'down' : 'up';
  return null;
}

/**
 * The decoration that shows which net a connection point belongs to. Signal nets get a
 * label pointing `dir`; supplies always get a vertical symbol (up for positive rails, down for
 * ground and negative rails), after a horizontal stub when the lead is horizontal.
 */
export function deco(net: Net, x: number, y: number, dir: Dir, stubLen = 100, rise = 0): LabelView {
  const kind: LabelView['kind'] = isGroundNet(net) ? 'ground' : isPowerNet(net) ? 'rail' : 'net';
  const base = { x, y, text: net.name, netId: net.id, kind };
  if (kind !== 'net' && (dir === 'left' || dir === 'right')) return { ...base, dir: supplyDir(net)!, stub: dir, stubLen, ...(rise ? { rise } : {}) };
  return { ...base, dir };
}

/** Horizontal room a decoration at a left/right pin end needs. */
export function decoWidth(net: Net | undefined, stubLen = 100): number {
  if (!net) return 0;
  if (supplyDir(net)) return stubLen + Math.max(80, tw(net.name) / 2 + 20);
  return tw(net.name) + 80;
}

/**
 * Stub lengths for supply symbols on horizontal leads, so that symbols on neighbouring pins
 * do not run into each other: upward symbols step outwards from the top, downward ones from
 * the bottom (pins closer than 300 mils form a run).
 *
 * An upward symbol below a downward one (a rail pin under a ground pin) would rise into it: then
 * the downward symbols move to columns further out and both get a longer stem (`rises`), the
 * rail symbol up past the highest of those ground pins and the ground symbol down past the
 * lowest rail pin. Their wires cross; the symbols stay clear.
 */
export function supplyStubs(
  pins: { number: string; y: number; side: string }[],
  dirOf: (pin: string) => 'up' | 'down' | null,
  rises?: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const side of ['left', 'right']) {
    const onSide = pins.filter((p) => p.side === side);
    for (const want of ['up', 'down'] as const) {
      const run = onSide.filter((p) => dirOf(p.number) === want).sort((a, b) => (want === 'up' ? a.y - b.y : b.y - a.y));
      let step = 0;
      run.forEach((p, i) => {
        step = i > 0 && Math.abs(p.y - run[i - 1]!.y) <= 300 ? step + 1 : 0;
        out.set(p.number, 100 + 200 * step);
      });
    }
    // rail pins under ground pins, close enough for their symbols to meet (rail 400 up, ground 260 down)
    const ups = onSide.filter((p) => dirOf(p.number) === 'up');
    const downs = onSide.filter((p) => dirOf(p.number) === 'down');
    const pairs = ups.flatMap((u) => downs.filter((g) => g.y < u.y && u.y - g.y < 700).map((g) => [u, g] as const));
    if (!pairs.length) continue;
    const upsHit = [...new Set(pairs.map(([u]) => u))];
    const downsHit = [...new Set(pairs.map(([, g]) => g))];
    // the ground symbols to columns beyond the rail symbols (keeping their own steps)
    const maxUp = Math.max(...upsHit.map((u) => out.get(u.number)!));
    const shift = maxUp + 200 - Math.min(...downsHit.map((g) => out.get(g.number)!));
    if (shift > 0) for (const g of downsHit) out.set(g.number, out.get(g.number)! + shift);
    for (const u of upsHit) {
      const top = Math.min(...pairs.filter(([x]) => x === u).map(([, g]) => g.y));
      rises?.set(u.number, Math.max(rises.get(u.number) ?? 0, u.y - top + 100));
    }
    for (const g of downsHit) {
      const bottom = Math.max(...pairs.filter(([, x]) => x === g).map(([u]) => u.y));
      rises?.set(g.number, Math.max(rises.get(g.number) ?? 0, bottom - g.y + 100));
    }
  }
  return out;
}


/**
 * Junction dots wherever three or more connections meet on one net: wire ends, wires passing
 * through, pins and supply symbols. A point where a wire ends on the middle of another (a T) is
 * one of them, whichever drawing produced it.
 */
export function addJunctions(scene: Scene): void {
  type Seg = { net: string; x1: number; y1: number; x2: number; y2: number };
  const segs: Seg[] = [];
  for (const w of scene.wires) {
    for (let i = 0; i + 3 < w.pts.length; i += 2) {
      const [x1, y1, x2, y2] = [w.pts[i]!, w.pts[i + 1]!, w.pts[i + 2]!, w.pts[i + 3]!];
      if (x1 !== x2 || y1 !== y2) segs.push({ net: w.netId, x1, y1, x2, y2 });
    }
  }
  const key = (x: number, y: number) => `${x},${y}`;
  const pins = new Map<string, number>();
  // pins stacked at one spot of a symbol (repeated VDD, VSS …) are one connection point
  for (const s of scene.symbols) for (const k of new Set(s.pins.map((p) => key(p.x, p.y)))) pins.set(k, (pins.get(k) ?? 0) + 1);
  const supplies = new Map<string, number>();
  for (const l of scene.labels) if (l.kind !== 'net' || l.dir !== 'on') supplies.set(`${l.netId}@${key(l.x, l.y)}`, (supplies.get(`${l.netId}@${key(l.x, l.y)}`) ?? 0) + 1);
  const inside = (s: Seg, x: number, y: number) =>
    (s.x1 === s.x2 && x === s.x1 && y > Math.min(s.y1, s.y2) && y < Math.max(s.y1, s.y2)) ||
    (s.y1 === s.y2 && y === s.y1 && x > Math.min(s.x1, s.x2) && x < Math.max(s.x1, s.x2));
  const have = new Set(scene.junctions.map((j) => key(j.x, j.y)));
  for (const s of segs) {
    for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]] as const) {
      const k = key(x, y);
      if (have.has(k)) continue;
      let degree = (pins.get(k) ?? 0) + (supplies.get(`${s.net}@${k}`) ?? 0);
      for (const o of segs) {
        if (o.net !== s.net) continue;
        if ((o.x1 === x && o.y1 === y) || (o.x2 === x && o.y2 === y)) degree += 1;
        else if (inside(o, x, y)) degree += 2;
      }
      if (degree >= 3) {
        scene.junctions.push({ x, y });
        have.add(k);
      }
    }
  }
  // a pin touching the middle of a wire
  for (const [k] of pins) {
    if (have.has(k)) continue;
    const [x, y] = k.split(',').map(Number) as [number, number];
    if (segs.some((s) => inside(s, x, y))) {
      scene.junctions.push({ x, y });
      have.add(k);
    }
  }
}
