/**
 * Polarity marks: which way round each part goes, and the silkscreen mark that says so. The pins'
 * names say it (K for the cathode, + for the plus terminal, pin 1 for an IC or a connector), or the
 * card does (set_polarity). The mark is a dot beside pin 1, a band across the body at the cathode
 * (where the part carries its own band) or a "+" beside the plus pad; never a lone dash, which reads
 * as a minus. Each is placed clear of copper, holes, the board edge and the other marks, and nearer
 * its own pad than any other part's; DRC.SILK_POLARITY says when there was no room.
 */
import { bodyOutline, cutoutDistance, insideBoard, padPins, roundPadDist, type BoardDiagnostic, type BoardPad, type BoardPart, type BoardView, type BodyCorner, type PartCard, type PolarityKind, type PolarityMark } from '@4k7/schema';

export interface Polarity {
  kind: PolarityKind;
  /** The pin it marks, by number. */
  pin: string;
}

const CATHODE = /^(k|cathode|kathode)$/i;
const ANODE = /^anode$/i;
const PLUS = /^\+$/;
const MINUS = /^(-|−)$/;
/** Two-pin parts that fit either way round unless their pins say otherwise. */
const EITHER_WAY = new Set(['resistor', 'capacitor', 'inductor', 'crystal']);

/**
 * Which way round a part goes, from its card: what set_polarity put on it, else its pins' names (a
 * pin named K: the cathode; + or −: the plus terminal; pin 1 of anything with three pins or more).
 * 'unknown': a two-pin diode or LED whose pins do not say which is the cathode. null: it fits
 * either way round.
 */
export function polarityOf(card: PartCard): Polarity | 'unknown' | null {
  const pins = card.pins;
  const named = (re: RegExp) => pins.find((p) => re.test(p.name.trim()));
  const first = () => pins.find((p) => p.number === '1') ?? [...pins].sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }))[0];
  const set = card.polarity;
  if (set) {
    if (set.mark === 'none') return null;
    const pin = set.pin ?? (set.mark === 'cathode' ? named(CATHODE)?.number : set.mark === 'plus' ? named(PLUS)?.number : undefined) ?? first()?.number;
    return pin ? { kind: set.mark, pin } : null;
  }
  if (pins.length < 2) return null;
  if (pins.length === 2) {
    const other = (p: { number: string }) => pins.find((q) => q.number !== p.number)!;
    const diode = card.category === 'diode' || card.category === 'led';
    const k = named(CATHODE);
    if (k) return { kind: 'cathode', pin: k.number };
    // an anode: the other pin is the cathode ("A" alone only on a diode or an LED)
    const a = named(ANODE) ?? (diode ? named(/^a$/i) : undefined);
    if (a) return { kind: 'cathode', pin: other(a).number };
    const plus = named(PLUS);
    if (plus) return { kind: 'plus', pin: plus.number };
    const minus = named(MINUS);
    if (minus) return { kind: 'plus', pin: other(minus).number };
    if (diode) return 'unknown';
    if (EITHER_WAY.has(card.category)) return null;
  }
  const p1 = first();
  return p1 ? { kind: 'pin1', pin: p1.number } : null;
}

/** The pad that carries a pin (its number or one of the pins sharing it). */
export function padOfPin(pads: BoardPad[], pin: string): BoardPad | undefined {
  const n = pin.toUpperCase();
  return pads.find((p) => padPins(p).some((x) => x.toUpperCase() === n));
}

/**
 * The body corner nearest a pad, chamfered on the outline: where pin 1 is, read at a glance. Bodies
 * under 2 mm keep their corners (on a SOT-23 the pads clip the chamfer down to a stub).
 */
export function pin1Chamfer(body: { x: number; y: number; w: number; h: number; round?: boolean }, pad: { x: number; y: number }): { size: number; corners: BodyCorner[] } | null {
  if (body.round || Math.min(body.w, body.h) < 2) return null;
  const corners: [BodyCorner, number, number][] = [
    ['tl', body.x, body.y],
    ['tr', body.x + body.w, body.y],
    ['br', body.x + body.w, body.y + body.h],
    ['bl', body.x, body.y + body.h],
  ];
  const near = corners.reduce((best, c) => (Math.hypot(c[1] - pad.x, c[2] - pad.y) < Math.hypot(best[1] - pad.x, best[2] - pad.y) - 1e-9 ? c : best));
  return { size: Math.round(Math.min(1, 0.25 * Math.min(body.w, body.h)) * 1000) / 1000, corners: [near[0]] };
}

/* ------------------------------------ placing the marks ------------------------------------ */

/** The silkscreen's line width (as the Gerber draws it). */
const INK = 0.15;
/** Ink stays this far from copper, holes, the board edge and other marks. */
const CLEAR = 0.15;
/** The pin-1 dot, the cathode band's width and the "+" sign's half width: the bigger size first, the smaller where it does not fit. */
const DOT = [0.5, 0.35];
const BAND = [0.3, 0.2];
const ARM = [0.4, 0.3];
/** A little slack so a mark is not placed exactly at its clearance. */
const SLACK = 0.02;

type Seg = { x0: number; y0: number; x1: number; y1: number; w: number };
type Dot = { x: number; y: number; d: number };
interface Shape {
  segs: Seg[];
  dots: Dot[];
}

/** Something ink must keep clear of: its box, its owner (a part's componentId; null: a via or a mark) and the distance to it. */
interface Obstacle {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  owner: string | null;
  /** A copper pad (counts for which part a mark is nearest). */
  pad: boolean;
  /** A part's body outline: not in the way of that part's own mark. */
  outlineOf?: string;
  label: string;
  dist: (x: number, y: number) => number;
}

/** Obstacles in 2 mm cells. */
class Grid {
  private cells = new Map<string, Obstacle[]>();
  private static S = 2;
  add(o: Obstacle) {
    for (let i = Math.floor(o.x0 / Grid.S); i <= Math.floor(o.x1 / Grid.S); i++) {
      for (let j = Math.floor(o.y0 / Grid.S); j <= Math.floor(o.y1 / Grid.S); j++) {
        const k = `${i},${j}`;
        const list = this.cells.get(k);
        if (list) list.push(o);
        else this.cells.set(k, [o]);
      }
    }
  }
  near(x0: number, y0: number, x1: number, y1: number): Obstacle[] {
    const out = new Set<Obstacle>();
    for (let i = Math.floor(x0 / Grid.S); i <= Math.floor(x1 / Grid.S); i++) {
      for (let j = Math.floor(y0 / Grid.S); j <= Math.floor(y1 / Grid.S); j++) for (const o of this.cells.get(`${i},${j}`) ?? []) if (o.x1 >= x0 && o.x0 <= x1 && o.y1 >= y0 && o.y0 <= y1) out.add(o);
    }
    return [...out];
  }
}

const rectDist = (p: { x: number; y: number; w: number; h: number }, x: number, y: number) => Math.hypot(Math.max(Math.abs(x - p.x) - p.w / 2, 0), Math.max(Math.abs(y - p.y) - p.h / 2, 0));
const segDist = (s: Seg, x: number, y: number) => {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - s.x0) * dx + (y - s.y0) * dy) / l2)) : 0;
  return Math.hypot(x - (s.x0 + t * dx), y - (s.y0 + t * dy));
};

/** Points along a shape's ink with the ink's half width there. */
function samples(s: Shape): { x: number; y: number; r: number }[] {
  const out = s.dots.map((d) => ({ x: d.x, y: d.y, r: d.d / 2 }));
  for (const g of s.segs) {
    const n = Math.max(1, Math.ceil(Math.hypot(g.x1 - g.x0, g.y1 - g.y0) / 0.05));
    for (let i = 0; i <= n; i++) out.push({ x: g.x0 + ((g.x1 - g.x0) * i) / n, y: g.y0 + ((g.y1 - g.y0) * i) / n, r: g.w / 2 });
  }
  return out;
}

function bounds(s: Shape): [number, number, number, number] {
  const pts = samples(s);
  return [Math.min(...pts.map((p) => p.x - p.r)), Math.min(...pts.map((p) => p.y - p.r)), Math.max(...pts.map((p) => p.x + p.r)), Math.max(...pts.map((p) => p.y + p.r))];
}

/** The pads on one side of the board: that side's SMD pads, every through-hole pad and hole. */
const onSide = (pad: BoardPad, side: 'top' | 'bottom') => !!pad.drill || !!pad.npth || pad.layers.includes(side === 'top' ? 'F.Cu' : 'B.Cu');

/** Where a part's mark could go, in the order it is preferred. */
function candidates(p: BoardPart, pad: BoardPad, kind: PolarityKind): Shape[][] {
  const others = p.pads.filter((q) => q !== pad && !q.npth);
  if (kind === 'pin1' || !others.length) return DOT.map((d) => pin1Spots(p, pad, d));
  return kind === 'cathode' ? BAND.map((w) => cathodeSpots(p, pad, others, w)) : ARM.map((a) => plusSpots(pad, others, a));
}

/** A dot beside pin 1: beyond the pad's outer end, off the body corner, at the end of its row, further out, inside a big body's corner. */
function pin1Spots(p: BoardPart, pad: BoardPad, d: number): Shape[] {
  const B = p.body;
  const gap = CLEAR + d / 2 + SLACK;
  // the side of the body pin 1 is on: the axis it lies furthest out along, for the body's size
  const fx = Math.abs(pad.x - p.x) / Math.max(B.w / 2, 1e-6);
  const fy = Math.abs(pad.y - p.y) / Math.max(B.h / 2, 1e-6);
  const sx = Math.sign(pad.x - p.x) || -1;
  const sy = Math.sign(pad.y - p.y) || -1;
  const out: [number, number][] = [];
  const beyond = (extra: number) => (fx >= fy ? [pad.x + sx * (pad.w / 2 + gap + extra), pad.y] : [pad.x, pad.y + sy * (pad.h / 2 + gap + extra)]) as [number, number];
  out.push(beyond(0));
  const kx = sx > 0 ? B.x + B.w : B.x;
  const ky = sy > 0 ? B.y + B.h : B.y;
  for (const t of [0, 0.3, 0.6]) out.push([kx + sx * (gap + t) * Math.SQRT1_2, ky + sy * (gap + t) * Math.SQRT1_2]);
  out.push(fx >= fy ? [pad.x, pad.y + sy * (pad.h / 2 + gap)] : [pad.x + sx * (pad.w / 2 + gap), pad.y]);
  out.push(beyond(0.3), beyond(0.6));
  out.push([kx - sx * (gap + 0.3), ky - sy * (gap + 0.3)]);
  return out.map(([x, y]) => ({ segs: [], dots: [{ x, y, d }] }));
}

/** The axis from a part's other pads to the marked pad: horizontal or not, and which way. */
function axis(pad: BoardPad, others: BoardPad[]) {
  const ox = others.reduce((s, q) => s + q.x, 0) / others.length;
  const oy = others.reduce((s, q) => s + q.y, 0) / others.length;
  const horizontal = Math.abs(pad.x - ox) >= Math.abs(pad.y - oy);
  const s = (horizontal ? Math.sign(pad.x - ox) : Math.sign(pad.y - oy)) || 1;
  return { horizontal, s };
}

/** A band across the body at the cathode: between the pads against the cathode (where the part has its band), else beyond the cathode's end. */
function cathodeSpots(p: BoardPart, k: BoardPad, others: BoardPad[], w: number): Shape[] {
  const { horizontal, s } = axis(k, others);
  const half = horizontal ? k.w / 2 : k.h / 2;
  const gap = CLEAR + w / 2 + SLACK;
  const mid = horizontal ? p.body.y + p.body.h / 2 : p.body.x + p.body.w / 2;
  const across = (horizontal ? Math.max(p.body.h, k.h) : Math.max(p.body.w, k.w)) / 2;
  const padAcross = (horizontal ? k.h : k.w) / 2;
  const kc = horizontal ? k.x : k.y;
  const at = (along: number, len: number): Shape => ({
    segs: [horizontal ? { x0: along, y0: mid - len, x1: along, y1: mid + len, w } : { x0: mid - len, y0: along, x1: mid + len, y1: along, w }],
    dots: [],
  });
  return [at(kc - s * (half + gap), across), at(kc + s * (half + gap), padAcross), at(kc + s * (half + gap + 0.3), padAcross)];
}

/** A "+" beside the plus pad: by its outer half on either side, beyond its end, at its outer corners. */
function plusSpots(pad: BoardPad, others: BoardPad[], arm: number): Shape[] {
  const { horizontal, s } = axis(pad, others);
  const half = arm + INK / 2;
  const gap = CLEAR + half + SLACK;
  const along = horizontal ? pad.w / 2 : pad.h / 2;
  const across = horizontal ? pad.h / 2 : pad.w / 2;
  const glyph = (a: number, c: number): Shape => {
    const [x, y] = horizontal ? [pad.x + s * a, pad.y + c] : [pad.x + c, pad.y + s * a];
    return {
      segs: [
        { x0: x - arm, y0: y, x1: x + arm, y1: y, w: INK },
        { x0: x, y0: y - arm, x1: x, y1: y + arm, w: INK },
      ],
      dots: [],
    };
  };
  const outer = Math.max(along - half, 0);
  return [glyph(outer, -(across + gap)), glyph(outer, across + gap), glyph(along + gap, 0), glyph(along + gap, -across), glyph(along + gap, across), glyph(along + gap, -(across + gap)), glyph(along + gap, across + gap)];
}

/** Why a spot does not fit: what is in its way, or null when it fits. */
function blocked(view: BoardView, grid: Grid, p: BoardPart, shape: Shape): string[] | null {
  const [x0, y0, x1, y1] = bounds(shape);
  const near = grid.near(x0 - 2, y0 - 2, x1 + 2, y1 + 2);
  const why = new Set<string>();
  for (const s of samples(shape)) {
    const need = CLEAR + s.r - 1e-6;
    if (insideBoard(view, s.x, s.y) < need) why.add('the board edge');
    for (const c of view.cutouts) if (cutoutDistance(c, s.x, s.y) < need) why.add(`cutout ${c.id}`);
    for (const o of near) {
      if (o.outlineOf === p.componentId) continue;
      if (o.x0 - need <= s.x && s.x <= o.x1 + need && o.y0 - need <= s.y && s.y <= o.y1 + need && o.dist(s.x, s.y) < need) why.add(o.label);
    }
  }
  if (why.size) return [...why];
  // nearer its own pads than any other part's, so it is not read as another part's mark
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let best: Obstacle | null = null;
  let bestD = Infinity;
  for (const o of grid.near(cx - 3, cy - 3, cx + 3, cy + 3)) {
    if (!o.pad) continue;
    const d = o.dist(cx, cy);
    if (d < bestD) [best, bestD] = [o, d];
  }
  return best && best.owner !== p.componentId ? [`${best.label} (nearer than its own)`] : null;
}

/** What a mark is called in a message. */
const MARK_NAME: Record<PolarityKind, string> = { pin1: 'pin-1 dot', cathode: 'cathode band', plus: '"+"' };

/**
 * Every part's mark placed on its side's silkscreen, in refdes order: the first spot that fits, the
 * bigger size first. Returns the parts with their marks and a DRC.SILK_POLARITY warning for each
 * part that got none.
 */
export function placeMarks(view: BoardView): { parts: BoardPart[]; diagnostics: BoardDiagnostic[] } {
  const grids = { top: new Grid(), bottom: new Grid() };
  for (const side of ['top', 'bottom'] as const) {
    const g = grids[side];
    for (const q of view.parts) {
      for (const pad of q.pads) {
        if (!onSide(pad, side)) continue;
        const label = q.componentId.startsWith('hole:') ? `hole ${q.refdes}` : `${q.refdes} pad ${pad.number}`;
        if (pad.npth) {
          const r = pad.drill! / 2;
          g.add({ x0: pad.x - r, y0: pad.y - r, x1: pad.x + r, y1: pad.y + r, owner: q.componentId, pad: false, label, dist: (x, y) => Math.hypot(x - pad.x, y - pad.y) - r });
        } else {
          g.add({ x0: pad.x - pad.w / 2, y0: pad.y - pad.h / 2, x1: pad.x + pad.w / 2, y1: pad.y + pad.h / 2, owner: q.componentId, pad: true, label, dist: pad.shape === 'round' ? (x, y) => roundPadDist(pad, x, y) : (x, y) => rectDist(pad, x, y) });
        }
      }
    }
    // the other parts' body outlines on this side: a mark touching one would read as part of it
    for (const q of view.parts) {
      if (q.componentId.startsWith('hole:') || (q.side !== side && !q.pads.some((pad) => pad.drill))) continue;
      const B = q.body;
      const label = `${q.refdes}'s outline`;
      if (B.round) {
        const [cx, cy, r] = [B.x + B.w / 2, B.y + B.h / 2, B.w / 2];
        g.add({ x0: B.x - INK, y0: B.y - INK, x1: B.x + B.w + INK, y1: B.y + B.h + INK, owner: q.componentId, pad: false, outlineOf: q.componentId, label, dist: (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) - INK / 2 });
        continue;
      }
      const o = bodyOutline(B);
      for (let i = 0; i < o.length; i += 2) {
        const e: Seg = { x0: o[i]!, y0: o[i + 1]!, x1: o[(i + 2) % o.length]!, y1: o[(i + 3) % o.length]!, w: INK };
        g.add({ x0: Math.min(e.x0, e.x1) - INK, y0: Math.min(e.y0, e.y1) - INK, x1: Math.max(e.x0, e.x1) + INK, y1: Math.max(e.y0, e.y1) + INK, owner: q.componentId, pad: false, outlineOf: q.componentId, label, dist: (x, y) => segDist(e, x, y) - INK / 2 });
      }
    }
    for (const v of view.vias) {
      const r = v.pad / 2;
      g.add({ x0: v.x - r, y0: v.y - r, x1: v.x + r, y1: v.y + r, owner: null, pad: false, label: `the via at ${round2(v.x)}, ${round2(v.y)}`, dist: (x, y) => Math.hypot(x - v.x, y - v.y) - r });
    }
  }
  const diagnostics: BoardDiagnostic[] = [];
  const marks = new Map<string, PolarityMark>();
  const order = view.parts.filter((p) => p.mark).sort((a, b) => a.refdes.localeCompare(b.refdes, 'en', { numeric: true }));
  for (const p of order) {
    const m = p.mark!;
    const pad = p.pads.find((q) => q.number === m.pad);
    const grid = grids[p.side];
    let found: Shape | null = null;
    let why: string[] | null = null;
    if (pad) {
      for (const size of candidates(p, pad, m.kind)) {
        for (const shape of size) {
          const no = blocked(view, grid, p, shape);
          if (!no) {
            found = shape;
            break;
          }
          why ??= no;
        }
        if (found) break;
      }
    }
    if (!found) {
      marks.set(p.componentId, { ...m, strokes: [], dots: [] });
      const crowd = (why ?? []).slice(0, 3).join(', ');
      diagnostics.push({
        code: 'DRC.SILK_POLARITY',
        severity: 'warning',
        message: `No room on the silkscreen for ${p.refdes}'s ${MARK_NAME[m.kind]} by pad ${m.pad}${crowd ? `: ${crowd} ${(why?.length ?? 0) > 1 ? 'are' : 'is'} in the way` : ''}. Without it the assembler cannot see which way round ${p.refdes} goes and will ask: give it about 0.6 mm beside that pad (move what is in the way, or the part).`,
        at: pad ? { x: pad.x, y: pad.y } : { x: p.x, y: p.y },
        entities: [p.refdes],
      });
      continue;
    }
    const mark: PolarityMark = {
      ...m,
      strokes: found.segs.map((s) => ({ pts: [round3(s.x0), round3(s.y0), round3(s.x1), round3(s.y1)], w: s.w })),
      dots: found.dots.map((d) => ({ x: round3(d.x), y: round3(d.y), d: d.d })),
    };
    marks.set(p.componentId, mark);
    // the next marks keep clear of this one
    for (const d of found.dots) grid.add({ x0: d.x - d.d / 2, y0: d.y - d.d / 2, x1: d.x + d.d / 2, y1: d.y + d.d / 2, owner: null, pad: false, label: `${p.refdes}'s mark`, dist: (x, y) => Math.hypot(x - d.x, y - d.y) - d.d / 2 });
    for (const s of found.segs) grid.add({ x0: Math.min(s.x0, s.x1) - s.w / 2, y0: Math.min(s.y0, s.y1) - s.w / 2, x1: Math.max(s.x0, s.x1) + s.w / 2, y1: Math.max(s.y0, s.y1) + s.w / 2, owner: null, pad: false, label: `${p.refdes}'s mark`, dist: (x, y) => segDist(s, x, y) - s.w / 2 });
  }
  return { parts: view.parts.map((p) => (marks.has(p.componentId) ? { ...p, mark: marks.get(p.componentId)! } : p)), diagnostics };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
