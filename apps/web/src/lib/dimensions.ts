import type { BoardView } from '@4k7/schema';

/**
 * The board's dimensions, as on a mechanical drawing (mm, board coordinates): the overall width
 * above the board and height to its left, and with mounting holes a chain of their positions from
 * the edges (on the side they are nearer, inside the overall dimension) and their diameters. Drawn by the Layout view's Dimensions
 * layer and the design document's mechanical drawing.
 */

/** One linear dimension: what it measures, where its line runs, and its text. */
export interface Dim {
  /** h: measures along x (from x1 to x2); v: measures along y (from y1 to y2). */
  dir: 'h' | 'v';
  /** The measured points: where the extension lines start (the feature, a little off it). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The dimension line's position: y for h, x for v. */
  at: number;
  text: string;
  /** The text's centre (read along the line; turned for v). */
  tx: number;
  ty: number;
  /** Too short for the arrows between the extension lines: they point in from outside. */
  outside: boolean;
}

/** A hole's diameter, written next to it (text-anchor start or end). */
export interface HoleNote {
  x: number;
  y: number;
  anchor: 'start' | 'end';
  text: string;
}

export interface Dimensions {
  dims: Dim[];
  notes: HoleNote[];
  /** Text height (mm); arrows and gaps scale with it. */
  font: number;
  arrow: number;
  /** How far the drawing reaches beyond the outline on any side (mm). */
  extent: number;
}

const isHole = (p: { componentId: string }) => p.componentId.startsWith('hole:');
/** A length as written on the drawing: up to two decimals, no trailing zeros. */
export const mm = (v: number) => String(Math.round(v * 100) / 100);

export function boardDimensions(b: Pick<BoardView, 'outline' | 'parts'>): Dimensions {
  const { w, h } = b.outline;
  const font = Math.min(2.5, Math.max(0.7, Math.max(w, h) * 0.03));
  const arrow = font * 0.8;
  const gap = font * 0.3;
  const row = font * 2.4;
  const textW = (t: string) => t.length * font * 0.62;
  const holes = b.parts.filter(isHole).map((p) => ({ x: p.x, y: p.y, d: p.pads[0]?.drill ?? 0, ring: p.pads[0]?.w ?? 0, plated: !p.pads[0]?.npth }));
  const dims: Dim[] = [];

  /**
   * A chain of dimensions along x (dir h) or y (dir v) between successive stops, its line at `at`,
   * the text on the side away from the board (`out`). A stop's `from` is where its extension line starts.
   */
  const chain = (dir: 'h' | 'v', stops: { v: number; from: number }[], at: number, out: 1 | -1, unit = '') => {
    for (let i = 0; i + 1 < stops.length; i++) {
      const a = stops[i]!;
      const z = stops[i + 1]!;
      const len = z.v - a.v;
      const text = mm(len) + unit;
      // the text over its segment; past the chain's end only when wider than it (the first: before it; the others: after it)
      const along = textW(text) <= len ? (a.v + z.v) / 2 : i === 0 && stops.length > 2 ? a.v - arrow - gap - textW(text) / 2 : z.v + arrow + gap + textW(text) / 2;
      const off = at + out * (gap + font / 2);
      const outside = len < 2.5 * arrow;
      if (dir === 'h') dims.push({ dir, x1: a.v, y1: a.from, x2: z.v, y2: z.from, at, text, tx: along, ty: off, outside });
      else dims.push({ dir, x1: a.from, y1: a.v, x2: z.from, y2: z.v, at, text, tx: off, ty: along, outside });
    }
  };

  // the holes' positions from the edges, on the side the holes are nearer (along x: below or above
  // the board; along y: right or left), each extension line from the hole nearest that side
  const mean = (k: 'x' | 'y') => holes.reduce((s, p) => s + p[k], 0) / holes.length;
  const below = holes.length > 0 && mean('y') > h / 2;
  const right = holes.length > 0 && mean('x') > w / 2;
  const stopsOf = (key: 'x' | 'y', far: boolean) => {
    const across = key === 'x' ? 'y' : 'x';
    const size = key === 'x' ? w : h;
    const edge = far ? (key === 'x' ? h : w) + gap : -gap;
    const out: { v: number; from: number }[] = [{ v: 0, from: edge }];
    for (const hole of [...holes].sort((p, q) => p[key] - q[key])) {
      const last = out[out.length - 1]!;
      const from = far ? hole[across] + hole.d / 2 + gap : hole[across] - hole.d / 2 - gap;
      if (Math.abs(hole[key] - last.v) < 0.05) last.from = far ? Math.max(last.from, from) : Math.min(last.from, from);
      else out.push({ v: hole[key], from });
    }
    if (size - out[out.length - 1]!.v < 0.05) out.pop();
    out.push({ v: size, from: edge });
    return out;
  };

  // the overall size above and to the left, outside a hole chain there
  const topRow = holes.length && !below ? 2 * row : row;
  const leftRow = holes.length && !right ? 2 * row : row;
  chain('h', [{ v: 0, from: -gap }, { v: w, from: -gap }], -topRow, -1, ' mm');
  chain('v', [{ v: 0, from: -gap }, { v: h, from: -gap }], -leftRow, -1, ' mm');
  if (holes.length) {
    chain('h', stopsOf('x', below), below ? h + row : -row, below ? 1 : -1);
    chain('v', stopsOf('y', right), right ? w + row : -row, right ? 1 : -1);
  }

  // the diameters: one note per hole, toward the board's middle (a corner hole's text stays on the board)
  const notes = holes.map((p) => {
    const left = p.x > w / 2;
    const above = p.y > h / 2;
    const r = Math.max(p.d, p.ring) / 2 + gap; // clear of its ring (plated) or keep-out
    return { x: left ? p.x - r : p.x + r, y: above ? p.y - r - font * 0.2 : p.y + r + font * 0.8, anchor: left ? 'end' : 'start', text: `Ø${mm(p.d)}${p.plated ? ' plated' : ''}` } satisfies HoleNote;
  });

  // the furthest any text goes past the outline (a chain's text placed beyond its end, the rows' texts)
  let extent = Math.max(topRow, leftRow) + gap + font * 1.2;
  for (const d of dims) {
    const along = d.dir === 'h' ? d.tx : d.ty;
    const size = d.dir === 'h' ? w : h;
    const half = textW(d.text) / 2;
    extent = Math.max(extent, -(along - half), along + half - size);
  }
  return { dims, notes, font, arrow, extent };
}

const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** A dimension as SVG path data: the extension and dimension lines (stroked), and the arrowheads (filled). */
export function dimPaths(d: Dim, arrow: number): { lines: string; arrows: string } {
  // in the dimension's own frame: u along the line, the line at `at`; back to x, y at the end
  const pt = (u: number, v: number) => (d.dir === 'h' ? `${n(u)},${n(v)}` : `${n(v)},${n(u)}`);
  const [u1, u2] = d.dir === 'h' ? [d.x1, d.x2] : [d.y1, d.y2];
  const [s1, s2] = d.dir === 'h' ? [d.y1, d.y2] : [d.x1, d.x2];
  const over = arrow * 0.5;
  const past = (s: number) => d.at + Math.sign(d.at - s) * over;
  const run = d.outside ? [u1 - 2 * arrow, u2 + 2 * arrow] : [u1, u2];
  const lines = `M${pt(u1, s1)}L${pt(u1, past(s1))}M${pt(u2, s2)}L${pt(u2, past(s2))}M${pt(run[0]!, d.at)}L${pt(run[1]!, d.at)}`;
  const head = (tip: number, dir: 1 | -1) => `M${pt(tip, d.at)}L${pt(tip - dir * arrow, d.at - arrow * 0.3)}L${pt(tip - dir * arrow, d.at + arrow * 0.3)}Z`;
  const arrows = d.outside ? head(u1, 1) + head(u2, -1) : head(u1, -1) + head(u2, 1);
  return { lines, arrows };
}
