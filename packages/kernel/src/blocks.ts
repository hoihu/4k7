/**
 * Functional blocks on the schematic (docs/design/schematic-drawing.md §2b). The agent says which
 * parts belong together (the description's blocks) and roughly where each block goes; the kernel
 * draws the inside of a block. This file is that drawing's geometry: the block's pieces (an IC
 * with the small parts at its pins, a regulator, a chain of small parts) arranged so that the pins
 * that connect face each other, the connections inside the block wired, a label only where a net
 * leaves the block (or where no clear wire was found), and the frame with the block's title.
 */
import type { Component, Design, LabelView, PinView, Point, Rect, WireView } from '@4k7/schema';
import { GRID, isTwoPin } from '@4k7/parts';
import { cardOf, isPowerNet, natCmp, type NetPin } from './doc.ts';
import { grow, onSegment, overlap } from './geom.ts';
import { routeWire } from './schroute.ts';
import { RETURN_LEG, crowding, emptyScene, labelForPin, labelRect, mergeScene, sceneBBox, textRect, translateScene, type Scene } from './scene.ts';

/** One piece of a block, drawn by the layout: an IC or connector with its small parts, a regulator, a bridge, a chain of small parts. */
export interface BlockNode {
  key: string;
  /** Its drawing at its own origin, the IC or connector mirrored (left pins on the right) or not. */
  build(mirror: boolean): Scene;
  canMirror: boolean;
  /** The agent's choice (constrain arrangement mirrored / unmirrored), kept. */
  mirror?: boolean;
  /** The parts a page showing it is named after. */
  heads: Component[];
}

export interface BlockOptions {
  title: string;
  /** Width the block should stay within (a page's drawing area): a long chain wraps into rows. */
  maxW: number;
  /** Height of a page's drawing area: a block taller than that is cut between its rows. */
  maxH: number;
  /** Draw the frame with the title (not for parts added to a stored drawing). */
  frame: boolean;
  /** The agent's order of two pieces (left_of / right_of), by node key. */
  order?: { left: string; right: string }[];
}

/** Room between columns of a block (its wires run there), and more for each net crossing between them. */
const COL_GAP = 500;
const PER_NET = 100;
/** Room between pieces stacked in a column, between the rows of a wrapped chain, between unconnected groups. */
const ROW_GAP = 300;
const BAND_GAP = 300;
const GROUP_GAP = 500;
/** The frame: air around the drawing, and room on top for the title. */
export const FRAME_PAD = 200;
export const FRAME_TITLE = 250;

type Side = PinView['side'];
interface Port {
  net: string;
  side: Side;
  x: number;
  y: number;
}

const snap = (v: number) => Math.round(v / GRID) * GRID;
const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** A block's frame round what it draws: air on every side, room for the title on top, on the grid. */
export function frameAround(bb: Rect): Rect {
  const x0 = Math.floor((bb.x - FRAME_PAD) / GRID) * GRID;
  const y0 = Math.floor((bb.y - FRAME_PAD - FRAME_TITLE) / GRID) * GRID;
  const x1 = Math.ceil((bb.x + bb.w + FRAME_PAD) / GRID) * GRID;
  const y1 = Math.ceil((bb.y + bb.h + FRAME_PAD) / GRID) * GRID;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Everything a scene draws, wires included (sceneBBox leaves wires out). */
export function drawnBox(s: Scene): Rect {
  let r = sceneBBox(s);
  const empty = !s.symbols.length && !s.labels.length && !s.blocks?.length;
  for (const w of s.wires) {
    const xs = w.pts.filter((_, i) => i % 2 === 0);
    const ys = w.pts.filter((_, i) => i % 2 === 1);
    const wr = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    r = empty && r.w === 0 && r.h === 0 ? wr : union(r, wr);
  }
  return r;
}

/**
 * Where a piece's nets leave it toward the rest of the block: per net, a pin on it, preferably the
 * one the piece labelled (that is where the drawing says the net goes on), else one of its IC.
 */
function portsOf(d: Design, scene: Scene, nets: ReadonlySet<string>): Map<string, Port> {
  const out = new Map<string, Port & { rank: number }>();
  for (const s of scene.symbols) {
    const comp = d.components[s.componentId];
    const card = comp && cardOf(d, comp.part);
    if (!comp || !card) continue;
    const big = !isTwoPin(card);
    for (const p of s.pins) {
      const net = comp.pins[p.number];
      if (!net || !nets.has(net)) continue;
      const labelled = scene.labels.some((l) => l.netId === net && l.x === p.x && l.y === p.y);
      const rank = (labelled ? 2 : 0) + (big ? 1 : 0);
      const have = out.get(net);
      if (!have || rank > have.rank) out.set(net, { net, side: p.side, x: p.x, y: p.y, rank });
    }
  }
  return out;
}

/** The side most of these nets leave a piece on. */
function sideOf(ports: Map<string, Port>, nets: string[]): Side | undefined {
  const count = new Map<Side, number>();
  for (const n of nets) {
    const p = ports.get(n);
    if (p) count.set(p.side, (count.get(p.side) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Draw a block: its pieces arranged, the connections inside wired, labels for what leaves it, the
 * frame. `members`: the nets' pins in the design, to tell which nets go on beyond the block.
 */
export function drawBlock(d: Design, members: Map<string, NetPin[]>, nodes: BlockNode[], opts: BlockOptions): { scene: Scene; heads: Component[] }[] {
  const n = nodes.length;
  const scenes = nodes.map((x) => x.build(x.mirror ?? false));
  const mirrored = nodes.map((x) => x.mirror ?? false);
  const nodeOf = new Map<string, number>();
  scenes.forEach((s, i) => s.symbols.forEach((sym) => nodeOf.set(sym.componentId, i)));

  // the signal nets joining two or more pieces: drawn as wires inside the block
  const where = new Map<string, Set<number>>();
  for (const [id, i] of nodeOf) {
    for (const net of Object.values(d.components[id]!.pins)) {
      const nn = d.nets[net];
      if (!nn || isPowerNet(nn)) continue;
      let set = where.get(net);
      if (!set) where.set(net, (set = new Set()));
      set.add(i);
    }
  }
  const internal = new Set([...where].filter(([, s]) => s.size > 1).map(([net]) => net));
  const ports = scenes.map((s) => portsOf(d, s, internal));
  const rebuild = (i: number, mirror: boolean) => {
    mirrored[i] = mirror;
    scenes[i] = nodes[i]!.build(mirror);
    ports[i] = portsOf(d, scenes[i]!, internal);
  };

  // which pieces each net joins, and how strongly two pieces are linked
  const links = new Map<number, Map<number, string[]>>();
  const link = (a: number, b: number, net: string) => {
    let m = links.get(a);
    if (!m) links.set(a, (m = new Map()));
    m.set(b, [...(m.get(b) ?? []), net]);
  };
  for (const net of [...internal].sort(natCmp)) {
    const ns = [...where.get(net)!].sort((a, b) => a - b);
    for (const a of ns) for (const b of ns) if (a !== b) link(a, b, net);
  }
  const degree = (i: number) => [...(links.get(i)?.values() ?? [])].reduce((k, nets) => k + nets.length, 0);

  // orientation and column of every piece, outward from the most connected one of each group:
  // a piece goes to the side of its neighbour where the neighbour's pins for it are, and is
  // mirrored when that turns its own pins for it toward the neighbour
  const layer = new Array<number>(n).fill(0);
  const parent = new Array<number>(n).fill(-1);
  const via = new Array<string[]>(n).fill([]);
  const seen = new Array<boolean>(n).fill(false);
  const groups: number[][] = [];
  const byDegree = [...Array(n).keys()].sort((a, b) => degree(b) - degree(a) || a - b);
  for (const h of byDegree) {
    if (seen[h]) continue;
    seen[h] = true;
    const group = [h];
    const queue = [h];
    while (queue.length) {
      const m = queue.shift()!;
      const next = [...(links.get(m) ?? [])].filter(([o]) => !seen[o]);
      // top to bottom along the neighbour's pins, so stacked pieces keep their order
      const yOn = (nets: string[]) => Math.min(...nets.map((net) => ports[m]!.get(net)?.y ?? Infinity));
      next.sort((a, b) => yOn(a[1]) - yOn(b[1]) || b[1].length - a[1].length || a[0] - b[0]);
      for (const [o, nets] of next) {
        if (seen[o]) continue;
        seen[o] = true;
        group.push(o);
        queue.push(o);
        const sM = sideOf(ports[m]!, nets);
        const sO = sideOf(ports[o]!, nets);
        const asked = opts.order?.find((x) => (x.left === nodes[o]!.key && x.right === nodes[m]!.key) || (x.left === nodes[m]!.key && x.right === nodes[o]!.key));
        const dir = asked ? (asked.left === nodes[o]!.key ? -1 : 1) : sM === 'left' ? -1 : sM === 'right' ? 1 : sO === 'right' ? -1 : 1;
        if (nodes[o]!.canMirror && nodes[o]!.mirror === undefined && ((dir < 0 && sO === 'left') || (dir > 0 && sO === 'right'))) rebuild(o, true);
        layer[o] = layer[m]! + dir;
        parent[o] = m;
        via[o] = nets;
      }
    }
    groups.push(group);
  }

  // positions: each group in columns (wrapped into rows when wider than the page), groups side by
  // side; spaced without the flags of the nets that are about to become wires between the pieces
  const offsets = new Array<Point>(n).fill({ x: 0, y: 0 });
  const boxes = scenes.map((s) => drawnBox({ ...s, labels: s.labels.filter((l) => l.kind !== 'net' || !internal.has(l.netId)) }));
  const groupBoxes: { group: number[]; box: Rect }[] = [];
  for (const group of groups) {
    const head = group[0]!;
    const layers = [...new Set(group.map((i) => layer[i]!))].sort((a, b) => a - b);
    const width = (L: number) => Math.max(...group.filter((i) => layer[i] === L).map((i) => boxes[i]!.w));
    const between = (L1: number, L2: number) => {
      let k = 0;
      for (const i of group) {
        if (layer[i] !== L1) continue;
        for (const [o, nets] of links.get(i) ?? []) if (layer[o] === L2) k += nets.length;
      }
      return COL_GAP + Math.min(1000, PER_NET * k);
    };
    // bands: runs of columns that fit the width
    const bands: number[][] = [];
    let cur: number[] = [];
    let w = 0;
    for (const L of layers) {
      const gap = cur.length ? between(cur.at(-1)!, L) : 0;
      if (cur.length && w + gap + width(L) > opts.maxW) {
        bands.push(cur);
        cur = [];
        w = 0;
      }
      w += (cur.length ? between(cur.at(-1)!, L) : 0) + width(L);
      cur.push(L);
    }
    if (cur.length) bands.push(cur);
    const bandOf = new Map<number, number>();
    bands.forEach((b, bi) => b.forEach((L) => bandOf.set(L, bi)));
    // the left edge of each column within its band
    const colX = new Map<number, number>();
    for (const b of bands) {
      let x = 0;
      b.forEach((L, k) => {
        if (k) x += between(b[k - 1]!, L);
        colX.set(L, x);
        x += width(L);
      });
    }
    const headLayer = layer[head]!;
    // pieces left of the head lean right (toward it), right of it lean left, the head's column centred
    const xOf = (i: number) => {
      const L = layer[i]!;
      const b = boxes[i]!;
      const x0 = colX.get(L)!;
      const shift = L < headLayer ? width(L) - b.w : L === headLayer ? Math.floor((width(L) - b.w) / 2 / GRID) * GRID : 0;
      return snap(x0 + shift - b.x);
    };
    // rows: a piece level with its neighbour's pins (a straight wire), pushed down past pieces already in its column
    const placedIn = new Map<string, Rect[]>();
    const ys = new Array<number>(n).fill(0);
    for (const i of group) {
      const L = layer[i]!;
      const b = boxes[i]!;
      const p = parent[i]!;
      let dy = -b.y;
      if (p >= 0 && bandOf.get(layer[p]!) === bandOf.get(L)) {
        // the shift that puts the most of their nets in line (a bus between two ICs: as many straight wires as their pins allow)
        const shifts = via[i]!.filter((x) => ports[p]!.has(x) && ports[i]!.has(x)).map((x) => ys[p]! + ports[p]!.get(x)!.y - ports[i]!.get(x)!.y);
        const best = [...new Set(shifts)].sort((s, t) => shifts.filter((v) => v === t).length - shifts.filter((v) => v === s).length)[0];
        if (best !== undefined) dy = best;
      }
      dy = snap(dy);
      const key = `${bandOf.get(L)}:${L}`;
      const column = placedIn.get(key) ?? [];
      for (let guard = 0; guard < 200; guard++) {
        const r = { x: 0, y: b.y + dy, w: 1, h: b.h };
        const clash = column.filter((c) => overlap(grow(c, ROW_GAP / 2 - 1), { ...r, x: c.x }));
        if (!clash.length) break;
        dy = snap(Math.max(...clash.map((c) => c.y + c.h)) + ROW_GAP - b.y);
      }
      column.push({ x: 0, y: b.y + dy, w: 1, h: b.h });
      placedIn.set(key, column);
      ys[i] = dy;
      offsets[i] = { x: xOf(i), y: dy };
    }
    // bands one under the other
    let top = 0;
    for (const [bi] of bands.entries()) {
      const mine = group.filter((i) => bandOf.get(layer[i]!) === bi);
      const y0 = Math.min(...mine.map((i) => boxes[i]!.y + offsets[i]!.y));
      const y1 = Math.max(...mine.map((i) => boxes[i]!.y + boxes[i]!.h + offsets[i]!.y));
      const shift = snap(top - y0);
      for (const i of mine) offsets[i] = { x: offsets[i]!.x, y: offsets[i]!.y + shift };
      top = snap(top + (y1 - y0) + BAND_GAP);
    }
    const gb = group.map((i) => ({ x: boxes[i]!.x + offsets[i]!.x, y: boxes[i]!.y + offsets[i]!.y, w: boxes[i]!.w, h: boxes[i]!.h })).reduce(union);
    groupBoxes.push({ group, box: gb });
  }
  // unconnected groups side by side, wrapping at the width (the biggest first)
  groupBoxes.sort((a, b) => b.group.length - a.group.length || a.group[0]! - b.group[0]!);
  let gx = 0;
  let gy = 0;
  let rowH = 0;
  for (const g of groupBoxes) {
    if (gx > 0 && gx + g.box.w > opts.maxW) {
      gx = 0;
      gy = snap(gy + rowH + GROUP_GAP);
      rowH = 0;
    }
    const dx = snap(gx - g.box.x);
    const dy = snap(gy - g.box.y);
    for (const i of g.group) offsets[i] = { x: offsets[i]!.x + dx, y: offsets[i]!.y + dy };
    gx = snap(gx + g.box.w + GROUP_GAP);
    rowH = Math.max(rowH, g.box.h);
  }

  // a block taller than a page is cut between its rows, a page's worth each (a long chain): the
  // connections across a cut get labels, the pieces after the first a frame of their own
  const placedBox = (i: number) => ({ y: boxes[i]!.y + offsets[i]!.y, h: boxes[i]!.h });
  const order = [...Array(n).keys()].sort((a, b) => placedBox(a).y - placedBox(b).y);
  const slabs: { nodes: number[]; top: number; bottom: number }[] = [];
  for (const i of order) {
    const b = placedBox(i);
    const last = slabs.at(-1);
    if (last && b.y < last.bottom) {
      last.nodes.push(i);
      last.bottom = Math.max(last.bottom, b.y + b.h);
    } else slabs.push({ nodes: [i], top: b.y, bottom: b.y + b.h });
  }
  const cuts: number[][] = [];
  let top = -Infinity;
  for (const slab of slabs) {
    if (!cuts.length || slab.bottom - top > opts.maxH) {
      cuts.push([]);
      top = slab.top;
    }
    cuts.at(-1)!.push(...slab.nodes);
  }
  return cuts.map((part, k) => {
    const scene = emptyScene();
    for (const i of part) {
      translateScene(scenes[i]!, offsets[i]!.x, offsets[i]!.y);
      mergeScene(scene, scenes[i]!);
    }
    const comps = new Set(scene.symbols.map((sym) => sym.componentId));
    finish(d, members, scene, comps);
    if (opts.frame) scene.blocks = [{ title: k ? `${opts.title} (continued)` : opts.title, rect: frameAround(drawnBox(scene)) }];
    return { scene, heads: part.flatMap((i) => nodes[i]!.heads) };
  });
}

/**
 * Inside a block (or a page's piece of it) a connection is a wire: between its pieces, and between
 * pins of one piece the layout labelled (the two D+ pins of a USB-C socket); a label stays only
 * where the net leaves it or no clear wire was found, one for each drawn piece of the net. Supply
 * symbols on a row of pins become bars.
 */
function finish(d: Design, members: Map<string, NetPin[]>, scene: Scene, comps: ReadonlySet<string>): void {
  const routable = new Set<string>();
  const count = new Map<string, number>();
  for (const sym of scene.symbols) {
    const comp = d.components[sym.componentId]!;
    for (const p of sym.pins) {
      const net = comp.pins[p.number];
      const nn = net ? d.nets[net] : undefined;
      if (!nn || isPowerNet(nn)) continue;
      count.set(net!, (count.get(net!) ?? 0) + 1);
      if (count.get(net!)! > 1) routable.add(net!);
    }
  }
  // a net cut off at a page break gets its labels back: the pieces' own labels went with the wiring
  barSupplies(scene);
  wireNets(d, scene, [...routable]);
  const nets = new Set([...routable, ...scene.symbols.flatMap((sym) => Object.values(d.components[sym.componentId]!.pins))]);
  for (const net of [...nets].sort(natCmp)) {
    const nn = d.nets[net];
    if (!nn || isPowerNet(nn)) continue;
    tidyLabels(d, scene, net, (members.get(net) ?? []).some((m) => !comps.has(m.comp.id)));
  }
}

/* --------------------------------- wiring ---------------------------------- */

export interface Piece {
  pins: { sym: number; pin: PinView }[];
  wires: number[];
}

const onWire = (x: number, y: number, pts: number[]) => {
  for (let i = 0; i + 3 < pts.length; i += 2) if (onSegment(x, y, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!)) return true;
  return false;
};
const endsOf = (pts: number[]): [number, number][] => [[pts[0]!, pts[1]!], [pts.at(-2)!, pts.at(-1)!]];

/** A net's drawn pieces in a scene: its pins and the wires that join them (pins on one spot join too). */
export function pieces(d: Design, scene: Scene, net: string): Piece[] {
  const pins: Piece['pins'] = [];
  scene.symbols.forEach((s, sym) => {
    const comp = d.components[s.componentId];
    for (const pin of s.pins) if (comp?.pins[pin.number] === net) pins.push({ sym, pin });
  });
  const wires = scene.wires.map((w, i) => [w, i] as const).filter(([w]) => w.netId === net);
  const parent = Array.from({ length: pins.length + wires.length }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const join = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  wires.forEach(([a], i) => {
    wires.forEach(([b], j) => {
      if (j > i && (endsOf(a.pts).some(([x, y]) => onWire(x, y, b.pts)) || endsOf(b.pts).some(([x, y]) => onWire(x, y, a.pts)))) join(pins.length + i, pins.length + j);
    });
    pins.forEach((p, k) => {
      if (onWire(p.pin.x, p.pin.y, a.pts)) join(k, pins.length + i);
    });
  });
  pins.forEach((p, k) => {
    pins.forEach((q, m) => {
      if (m > k && p.pin.x === q.pin.x && p.pin.y === q.pin.y) join(k, m);
    });
  });
  const out = new Map<number, Piece>();
  const get = (i: number) => {
    const r = find(i);
    let g = out.get(r);
    if (!g) out.set(r, (g = { pins: [], wires: [] }));
    return g;
  };
  pins.forEach((p, k) => get(k).pins.push(p));
  wires.forEach(([, wi], i) => get(pins.length + i).wires.push(wi));
  return [...out.values()].filter((g) => g.pins.length);
}

export const boxOf = (scene: Scene, p: Piece): Rect => {
  const pts: Point[] = [...p.pins.map((x) => ({ x: x.pin.x, y: x.pin.y })), ...p.wires.flatMap((i) => endsOf(scene.wires[i]!.pts).map(([x, y]) => ({ x, y })))];
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

/** Manhattan gap between two boxes (0 when they overlap). */
export const gap = (a: Rect, b: Rect) => Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)) + Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));

/** Wires of other nets a path crosses. */
export function crossings(pts: number[], net: string, wires: WireView[]): number {
  let k = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const [x1, y1, x2, y2] = [pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!];
    for (const w of wires) {
      if (w.netId === net) continue;
      for (let j = 0; j + 3 < w.pts.length; j += 2) {
        const [a1, b1, a2, b2] = [w.pts[j]!, w.pts[j + 1]!, w.pts[j + 2]!, w.pts[j + 3]!];
        const h1 = y1 === y2;
        const h2 = b1 === b2;
        if (h1 === h2) continue;
        const [hx1, hx2, hy, vx, vy1, vy2] = h1 ? [x1, x2, y1, a1, b1, b2] : [a1, a2, b1, x1, y1, y2];
        if (vx > Math.min(hx1, hx2) && vx < Math.max(hx1, hx2) && hy > Math.min(vy1, vy2) && hy < Math.max(vy1, vy2)) k++;
      }
    }
  }
  return k;
}

export const lengthOf = (pts: number[]) => {
  let l = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) l += Math.abs(pts[i + 2]! - pts[i]!) + Math.abs(pts[i + 3]! - pts[i + 1]!);
  return l;
};

/**
 * The path goes round something and turns back the way it came: a U with a leg of 500 mils or
 * more, shorter than a row (a row's return is fine). A shallow step (a pin entered from below) is
 * not one: two labels side by side would read worse.
 */
export function doublesBack(pts: number[]): boolean {
  const runs: [number, number][] = [];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const v: [number, number] = [pts[i + 2]! - pts[i]!, pts[i + 3]! - pts[i + 1]!];
    if (!v[0] && !v[1]) continue;
    const last = runs.at(-1);
    if (last && Math.sign(last[0]) === Math.sign(v[0]) && Math.sign(last[1]) === Math.sign(v[1])) runs[runs.length - 1] = [last[0] + v[0], last[1] + v[1]];
    else runs.push(v);
  }
  const len = (v: [number, number]) => Math.abs(v[0]) + Math.abs(v[1]);
  for (let i = 0; i + 2 < runs.length; i++) {
    const [a, b, c] = [runs[i]!, runs[i + 1]!, runs[i + 2]!];
    const across = a[0] ? b[1] && !b[0] && c[0] && Math.sign(a[0]) !== Math.sign(c[0]) : b[0] && !b[1] && c[1] && Math.sign(a[1]) !== Math.sign(c[1]);
    if (across && Math.max(len(a), len(c)) >= 500 && Math.max(len(a), len(c)) < RETURN_LEG) return true;
  }
  return false;
}

/**
 * Wire each net's pieces together, nearest first, with the path finder of the wire op. A wire that
 * would cross more than a few others, wander far round what is in the way or turn back on itself is
 * not drawn: the label at each end reads better.
 */
function wireNets(d: Design, scene: Scene, nets: string[]): void {
  const soft = (net: string) => [
    ...scene.labels.filter((l) => l.netId !== net).map(labelRect),
    ...scene.symbols.flatMap((s) => [textRect(s.refPos, [s.refdes]), textRect(s.valuePos, s.valueLines ?? [s.value])]),
  ];
  // the short connections first: they get the straight paths
  const span = (net: string) => {
    const ps = pieces(d, scene, net);
    if (ps.length < 2) return Infinity;
    const bs = ps.map((p) => boxOf(scene, p));
    return Math.min(...bs.flatMap((a, i) => bs.slice(i + 1).map((b) => gap(a, b))));
  };
  const order = nets.map((net) => ({ net, s: span(net) })).filter((x) => x.s < Infinity).sort((a, b) => a.s - b.s || natCmp(a.net, b.net));
  const area = grow(drawnBox(scene), 800);
  for (const { net } of order) {
    const ps = pieces(d, scene, net);
    if (ps.length < 2) continue;
    // grow from the biggest piece
    ps.sort((a, b) => b.pins.length - a.pins.length || boxOf(scene, a).x - boxOf(scene, b).x);
    let joined = ps[0]!;
    let rest = ps.slice(1);
    while (rest.length) {
      const jb = boxOf(scene, joined);
      rest.sort((a, b) => gap(boxOf(scene, a), jb) - gap(boxOf(scene, b), jb));
      const next = rest.shift()!;
      const nb = boxOf(scene, next);
      const reach = gap(nb, jb);
      const b = grow(union(nb, jb), 1500);
      const bounds = { x: Math.max(b.x, area.x), y: Math.max(b.y, area.y), w: 0, h: 0 };
      bounds.w = Math.min(b.x + b.w, area.x + area.w) - bounds.x;
      bounds.h = Math.min(b.y + b.h, area.y + area.h) - bounds.y;
      const pts = routeWire({
        from: next.pins.map((p) => ({ x: p.pin.x, y: p.pin.y })),
        fromWires: next.wires.map((i) => scene.wires[i]!.pts),
        to: joined.pins.map((p) => ({ x: p.pin.x, y: p.pin.y })),
        toWires: joined.wires.map((i) => scene.wires[i]!.pts),
        via: [],
        wires: scene.wires,
        symbols: scene.symbols,
        soft: soft(net),
        bounds,
      });
      if (!pts || crossings(pts, net, scene.wires) > 3 || lengthOf(pts) > 3 * reach + 2500 || doublesBack(pts)) continue;
      scene.wires.push({ netId: net, pts });
      joined = pieces(d, scene, net).find((p) => p.pins.some((q) => joined.pins.some((r) => r.pin === q.pin))) ?? joined;
    }
  }
}

/**
 * A net's labels after wiring: one per drawn piece where the net goes on (another piece, or beyond
 * the block), none where it is all one piece inside it. A label at a pin a new wire leaves through
 * would sit on that wire, so another one is kept or one is made (labelPiece). A label's lead goes
 * with it.
 */
function tidyLabels(d: Design, scene: Scene, net: string, outside: boolean): void {
  const ps = pieces(d, scene, net);
  const pieceOf = (l: LabelView) => ps.findIndex((p) => p.pins.some((q) => q.pin.x === l.x && q.pin.y === l.y) || p.wires.some((i) => onWire(l.x, l.y, scene.wires[i]!.pts)));
  const wireAt = (x: number, y: number) => scene.wires.some((w) => w.netId === net && onWire(x, y, w.pts));
  const isPin = (x: number, y: number) => scene.symbols.some((s) => s.pins.some((p) => p.x === x && p.y === y));
  const drop = new Set<LabelView>();
  const mine = scene.labels.filter((l) => l.netId === net && l.kind === 'net');
  ps.forEach((piece, i) => {
    const here = mine.filter((l) => pieceOf(l) === i);
    if (ps.length < 2 && !outside) {
      here.forEach((l) => drop.add(l));
      return;
    }
    // at a pin with a wire through its end, a flag would lie on the wire
    const keep = here.find((l) => l.dir === 'on' || !isPin(l.x, l.y) || !wireAt(l.x, l.y));
    for (const l of here) if (l !== keep) drop.add(l);
    if (!keep) labelPiece(d, scene, net, piece);
  });
  if (!drop.size) return;
  for (const l of drop) {
    // its lead: a wire of the net that ends at the label and nothing else meets there
    if (isPin(l.x, l.y)) continue;
    const at = scene.wires.filter((w) => w.netId === net && onWire(l.x, l.y, w.pts));
    if (at.length !== 1) continue;
    const ends = endsOf(at[0]!.pts);
    if (ends.some(([x, y]) => x === l.x && y === l.y)) scene.wires.splice(scene.wires.indexOf(at[0]!), 1);
  }
  scene.labels = scene.labels.filter((l) => !drop.has(l));
}

/** How far a bar runs above (rails) or below (grounds) the pin ends it joins. */
const BAR = 100;
/** The longest gap a bar bridges between two pins. */
const BAR_SPAN = 3000;

/**
 * Supply symbols standing on pin ends of one height and one net, side by side (a row of LEDs, each
 * with its +5V above and its GND below), become one bar: a short lead from each pin, a wire along
 * them, the symbol once, at the bar's start. Only where the bar runs clear of parts, text, labels
 * and other wires.
 */
function barSupplies(scene: Scene): void {
  const pinAt = new Map<string, PinView>();
  for (const s of scene.symbols) for (const p of s.pins) pinAt.set(`${p.x},${p.y}`, p);
  // a symbol standing straight on a pin with nothing else there (a bank of caps has its own wires)
  const standing = (l: LabelView) =>
    ((l.kind === 'rail' && l.dir === 'up') || (l.kind === 'ground' && l.dir === 'down')) &&
    !l.stub &&
    !l.rise &&
    pinAt.get(`${l.x},${l.y}`)?.side === (l.dir === 'up' ? 'top' : 'bottom') &&
    !scene.wires.some((w) => onWire(l.x, l.y, w.pts));
  const groups = new Map<string, LabelView[]>();
  for (const l of scene.labels) {
    if (!standing(l)) continue;
    const k = `${l.netId}|${l.dir}|${l.y}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.x - b.x);
    const up = list[0]!.dir === 'up';
    const y = list[0]!.y + (up ? -BAR : BAR);
    const net = list[0]!.netId;
    // the bar from a to b runs clear: no part, text or other label on it (the run's own symbols go), no other wire across or along it
    const clear = (xa: number, xb: number, mine: LabelView[]) => {
      const r = { x: xa + 1, y: y - 40, w: xb - xa - 2, h: 80 };
      const others = [
        ...scene.symbols.flatMap((sym) => [sym.bbox, textRect(sym.refPos, [sym.refdes]), textRect(sym.valuePos, sym.valueLines ?? [sym.value])]),
        ...scene.labels.filter((l) => !mine.includes(l)).map(labelRect),
      ];
      if (others.some((b) => overlap(b, r))) return false;
      return !scene.wires.some((w) => {
        if (w.netId === net) return false;
        for (let i = 0; i + 3 < w.pts.length; i += 2) {
          const [x1, y1, x2, y2] = [w.pts[i]!, w.pts[i + 1]!, w.pts[i + 2]!, w.pts[i + 3]!];
          if (x1 === x2 && x1 > xa && x1 < xb && Math.min(y1, y2) <= y && Math.max(y1, y2) >= y) return true;
          if (y1 === y2 && y1 === y && Math.max(x1, x2) > xa && Math.min(x1, x2) < xb) return true;
        }
        return false;
      });
    };
    // the one symbol left stands at an end of the bar where it has room
    const room = (l: LabelView, mine: LabelView[]) => {
      const r = labelRect(l);
      return ![
        ...scene.symbols.flatMap((sym) => [sym.bbox, textRect(sym.refPos, [sym.refdes]), textRect(sym.valuePos, sym.valueLines ?? [sym.value])]),
        ...scene.labels.filter((o) => !mine.includes(o)).map(labelRect),
      ].some((b) => overlap(b, r));
    };
    let run: LabelView[] = [list[0]!];
    const flush = () => {
      if (run.length < 2) return;
      const at = [run[0]!, run.at(-1)!].map((l) => ({ ...l, y })).find((l) => room(l, run));
      if (!at) return;
      for (const l of run) scene.wires.push({ netId: net, pts: [l.x, l.y, l.x, y] });
      scene.wires.push({ netId: net, pts: [run[0]!.x, y, run.at(-1)!.x, y] });
      scene.labels = scene.labels.filter((l) => !run.includes(l));
      scene.labels.push(at);
    };
    for (const l of list.slice(1)) {
      const prev = run.at(-1)!;
      if (l.x - prev.x <= BAR_SPAN && clear(prev.x, l.x, [...run, l])) run.push(l);
      else {
        flush();
        run = [l];
      }
    }
    flush();
  }
}

/**
 * A net label for one piece of a net: at a pin of it whose end is free, where the label runs into
 * the least; where every pin is wired, the name on its longest horizontal wire.
 */
function labelPiece(d: Design, scene: Scene, net: string, piece: Piece): void {
  const n = d.nets[net];
  if (!n) return;
  const wiredAt = new Set<string>();
  for (const w of scene.wires) if (w.netId === net) for (const [x, y] of endsOf(w.pts)) wiredAt.add(`${x},${y}`);
  for (const w of scene.wires) {
    if (w.netId !== net) continue;
    for (const p of piece.pins) if (onWire(p.pin.x, p.pin.y, w.pts)) wiredAt.add(`${p.pin.x},${p.pin.y}`);
  }
  const cands = piece.pins
    .filter((p) => !wiredAt.has(`${p.pin.x},${p.pin.y}`))
    .map((p) => {
      const comp = d.components[scene.symbols[p.sym]!.componentId]!;
      const type = cardOf(d, comp.part)?.pins.find((x) => x.number === p.pin.number)?.type;
      const r = labelForPin(n, p.pin, type);
      return { r, hits: crowding(scene, r.label, p.sym), ref: `${comp.refdes}.${p.pin.number}` };
    })
    .sort((a, b) => a.hits - b.hits || natCmp(a.ref, b.ref));
  const best = cands[0];
  if (best && (best.hits === 0 || !piece.wires.length)) {
    scene.wires.push(...best.r.wires);
    scene.labels.push(best.r.label);
    return;
  }
  // the name on the piece's longest horizontal run
  let run: { x: number; y: number; len: number } | null = null;
  for (const i of piece.wires) {
    const pts = scene.wires[i]!.pts;
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const [x1, y1, x2, y2] = [pts[k]!, pts[k + 1]!, pts[k + 2]!, pts[k + 3]!];
      const len = Math.abs(x2 - x1);
      if (y1 === y2 && len >= 300 && (!run || len > run.len)) run = { x: Math.round((x1 + x2) / 2 / 50) * 50, y: y1, len };
    }
  }
  if (run) {
    scene.labels.push({ x: run.x, y: run.y, text: n.name, netId: net, kind: 'net', dir: 'on' } satisfies LabelView);
    return;
  }
  if (best) {
    scene.wires.push(...best.r.wires);
    scene.labels.push(best.r.label);
  }
}

