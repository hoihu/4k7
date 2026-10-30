/**
 * Congestion estimate of a placement, before anything is routed: where the ratsnest wants more
 * track than the layers carry. RUDY-style: every ratsnest line spreads its Manhattan length evenly
 * over its bounding box (a thin line is given a minimum width), a cell's demand is the sum of what
 * the lines put in it, and its capacity is the track the signal layers fit in it (the free area
 * over the track pitch, pads and their clearance taken out). What counts is the demand above a
 * share of the capacity (the router never packs a layer full: vias, detours, escapes).
 *
 * The same grid serves the placer's searches (refine.ts): `delta` is what drawing some lines
 * again would change, cell by cell, without touching the rest.
 */
import type { BoardPad, BoardRules, BoardView } from '@4k7/schema';

/** Cell size (mm). */
export const CELL_MM = 3;
/** Demand up to this share of a cell's capacity is free; only the part above it counts. */
export const FREE_SHARE = 0.4;
/** A crossing of two ratsnest lines costs as much as this much more ratsnest (mm) in the score the placement searches use: untangling comes first. */
export const CROSSING_MM = 4;
/** One mm of congestion costs as much as this many mm of ratsnest in that score. */
export const CONGESTION_WEIGHT = 8;

/** How well a placement lends itself to routing, in one number (lower is better): 4 × crossings + ratsnest mm + 8 × congestion mm. */
export const routability = (m: { ratsnestMm: number; crossings: number; congestion: { overflowMm: number } }) => CROSSING_MM * m.crossings + m.ratsnestMm + CONGESTION_WEIGHT * m.congestion.overflowMm;
/** A ratsnest line spreads over a box at least this wide and tall (mm). */
const MIN_BOX_MM = 1;

export interface Congestion {
  /** Track (mm) wanted above the free share of the cells' capacity, summed over the board. */
  overflowMm: number;
  /** The worst cell's demand over its capacity (1: full). */
  peak: number;
  /** Cells whose demand is over the free share of their capacity. */
  hot: number;
}

export interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Board {
  w: number;
  h: number;
  /** The rules the pitch comes from. */
  rules: Pick<BoardRules, 'track' | 'clearance'>;
  /** Copper layers that carry signal tracks (not the dedicated planes). */
  signal: string[];
  /** Every pad of the parts, as they stand. */
  pads: Pick<BoardPad, 'x' | 'y' | 'w' | 'h' | 'drill' | 'layers'>[];
}

export class Grid {
  readonly nx: number;
  readonly ny: number;
  /** Capacity of each cell (mm of track). */
  readonly cap: Float64Array;
  /** Demand of each cell (mm of track). */
  readonly demand: Float64Array;

  constructor(
    b: Board,
    readonly cell = CELL_MM,
    readonly free = FREE_SHARE,
  ) {
    this.nx = Math.max(1, Math.ceil(b.w / cell));
    this.ny = Math.max(1, Math.ceil(b.h / cell));
    this.demand = new Float64Array(this.nx * this.ny);
    this.cap = new Float64Array(this.nx * this.ny);
    const pitch = b.rules.track + b.rules.clearance;
    // free area per signal layer: the cell's part on the board less the pads (and their clearance) on that layer
    const room = b.signal.map(() => new Float64Array(this.nx * this.ny));
    for (let cy = 0; cy < this.ny; cy++) {
      for (let cx = 0; cx < this.nx; cx++) {
        const inside = Math.max(0, Math.min(b.w, (cx + 1) * cell) - cx * cell) * Math.max(0, Math.min(b.h, (cy + 1) * cell) - cy * cell);
        for (const f of room) f[cy * this.nx + cx] = inside;
      }
    }
    for (const p of b.pads) {
      const c = b.rules.clearance;
      const x0 = p.x - p.w / 2 - c;
      const x1 = p.x + p.w / 2 + c;
      const y0 = p.y - p.h / 2 - c;
      const y1 = p.y + p.h / 2 + c;
      for (let cy = Math.max(0, Math.floor(y0 / cell)); cy <= Math.min(this.ny - 1, Math.floor(y1 / cell)); cy++) {
        for (let cx = Math.max(0, Math.floor(x0 / cell)); cx <= Math.min(this.nx - 1, Math.floor(x1 / cell)); cx++) {
          const a = Math.max(0, Math.min(x1, (cx + 1) * cell) - Math.max(x0, cx * cell)) * Math.max(0, Math.min(y1, (cy + 1) * cell) - Math.max(y0, cy * cell));
          b.signal.forEach((layer, k) => {
            if (p.drill || p.layers.includes(layer as never)) room[k]![cy * this.nx + cx]! -= a;
          });
        }
      }
    }
    for (let i = 0; i < this.cap.length; i++) this.cap[i] = room.reduce((s, f) => s + Math.max(0, f[i]!), 0) / pitch;
  }

  /** The cells a line puts demand in, and how much: calls `put(cell, mm)`. */
  spread(l: Line, put: (cell: number, mm: number) => void) {
    const len = Math.abs(l.x2 - l.x1) + Math.abs(l.y2 - l.y1);
    if (len <= 0) return;
    const cx = (l.x1 + l.x2) / 2;
    const cy = (l.y1 + l.y2) / 2;
    const w = Math.max(Math.abs(l.x2 - l.x1), MIN_BOX_MM);
    const h = Math.max(Math.abs(l.y2 - l.y1), MIN_BOX_MM);
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const y0 = cy - h / 2;
    const y1 = cy + h / 2;
    const c = this.cell;
    for (let j = Math.max(0, Math.floor(y0 / c)); j <= Math.min(this.ny - 1, Math.floor(y1 / c)); j++) {
      const oy = Math.min(y1, (j + 1) * c) - Math.max(y0, j * c);
      if (oy <= 0) continue;
      for (let i = Math.max(0, Math.floor(x0 / c)); i <= Math.min(this.nx - 1, Math.floor(x1 / c)); i++) {
        const ox = Math.min(x1, (i + 1) * c) - Math.max(x0, i * c);
        if (ox > 0) put(j * this.nx + i, (len * ox * oy) / (w * h));
      }
    }
  }

  /** Take a line's demand in (sign 1) or out (-1). */
  add(l: Line, sign = 1) {
    this.spread(l, (cell, mm) => (this.demand[cell]! += sign * mm));
  }

  /** The part of a cell's demand that counts. */
  private over(cell: number, demand: number) {
    return Math.max(0, demand - this.free * this.cap[cell]!);
  }

  measure(): Congestion {
    let overflow = 0;
    let peak = 0;
    let hot = 0;
    for (let i = 0; i < this.cap.length; i++) {
      const o = this.over(i, this.demand[i]!);
      overflow += o;
      if (o > 1e-9) hot++;
      if (this.cap[i]! > 1e-9) peak = Math.max(peak, this.demand[i]! / this.cap[i]!);
    }
    return { overflowMm: Math.round(overflow * 10) / 10, peak: Math.round(peak * 100) / 100, hot };
  }

  /** How the overflow (mm) would change if the lines in `gone` were taken out and those in `come` put in. */
  delta(gone: Line[], come: Line[]): number {
    const change = new Map<number, number>();
    const put = (sign: number) => (cell: number, mm: number) => change.set(cell, (change.get(cell) ?? 0) + sign * mm);
    for (const l of gone) this.spread(l, put(-1));
    for (const l of come) this.spread(l, put(1));
    let d = 0;
    for (const [cell, mm] of change) d += this.over(cell, this.demand[cell]! + mm) - this.over(cell, this.demand[cell]!);
    return d;
  }
}

/** The congestion of ratsnest lines on a board. */
export function congestion(b: Board, lines: Line[], cell = CELL_MM, free = FREE_SHARE): Congestion {
  const g = new Grid(b, cell, free);
  for (const l of lines) g.add(l);
  return g.measure();
}

/** The board as the estimate sees it, from a board view (the dedicated inner planes carry no signal). */
export function boardOf(b: Pick<BoardView, 'outline' | 'rules' | 'layers' | 'planes' | 'parts'>): Board {
  return {
    w: b.outline.w,
    h: b.outline.h,
    rules: b.rules,
    signal: (b.layers ?? ['F.Cu', 'B.Cu']).filter((l) => !(b.planes ?? []).some((pl) => pl.layer === l && l !== 'F.Cu' && l !== 'B.Cu' && !pl.area)),
    pads: b.parts.flatMap((p) => p.pads),
  };
}
