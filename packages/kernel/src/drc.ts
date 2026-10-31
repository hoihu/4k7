/**
 * Copper design-rule check on exact geometry, independent of the router's grid: clearance
 * between tracks, vias and pads of different nets on the same layer.
 */
import { cutoutDistance, insideBoard, padCapsule, roundPadDist } from '@4k7/schema';
import type { BoardDiagnostic, BoardPad, BoardPart, BoardView, CopperLayer, Track } from '@4k7/schema';
import { segDist } from './segments.ts';
import { padPointDist, padSegDist } from './keep.ts';

type Shape =
  | { kind: 'seg'; ax: number; ay: number; bx: number; by: number; r: number }
  | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number };

interface Item {
  net: string;
  layer: CopperLayer;
  shape: Shape;
  /** Bounding box for the broad phase. */
  bb: [number, number, number, number];
  what: string;
  /** Pads of one part are not checked against each other (footprint spacing is by design). */
  part?: string;
  /** Drawn copper's id (t3, v1). */
  id?: string;
  track: boolean;
}

const EPS = 0.005;

/** A drawn track's or via's id (router copper has none). */
const idOf = (x: object): string | undefined => (x as { id?: string }).id;

/** How a track or via is named in a finding: by its id where it is drawn copper. */
export const copperName = (b: Pick<BoardView, 'netNames'>, kind: 'track' | 'via', x: { netId: string }) => {
  const net = b.netNames[x.netId] ?? x.netId;
  const id = idOf(x);
  return id ? `${kind} ${id} (${net})` : `${kind} ${net}`;
};

/**
 * Clearance between the copper of different nets on each layer. `focus`: only findings that
 * involve these drawn tracks and vias (by id), e.g. what an op just drew.
 */
export function copperDrc(b: BoardView, focus?: Set<string>): BoardDiagnostic[] {
  const items: Item[] = [];
  for (const p of b.parts) {
    for (const pad of p.pads) {
      const layers = pad.drill ? b.layers : pad.layers;
      const shape = padShape(pad);
      for (const layer of layers) {
        items.push({ net: pad.netId ?? `nc:${p.refdes}.${pad.number}`, layer, shape, bb: [pad.x - pad.w / 2, pad.y - pad.h / 2, pad.x + pad.w / 2, pad.y + pad.h / 2], what: `${p.refdes}.${pad.number}`, part: p.refdes, track: false });
      }
    }
  }
  for (const t of b.tracks) {
    for (let i = 0; i + 3 < t.pts.length; i += 2) {
      const [ax, ay, bx, by] = [t.pts[i]!, t.pts[i + 1]!, t.pts[i + 2]!, t.pts[i + 3]!];
      const r = t.width / 2;
      items.push({ net: t.netId, layer: t.layer, shape: { kind: 'seg', ax, ay, bx, by, r }, bb: [Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r], what: copperName(b, 'track', t), ...(idOf(t) ? { id: idOf(t) } : {}), track: true });
    }
  }
  for (const v of b.vias) {
    const r = v.pad / 2;
    for (const layer of b.layers) items.push({ net: v.netId, layer, shape: { kind: 'seg', ax: v.x, ay: v.y, bx: v.x, by: v.y, r }, bb: [v.x - r, v.y - r, v.x + r, v.y + r], what: copperName(b, 'via', v), ...(idOf(v) ? { id: idOf(v) } : {}), track: true });
  }

  for (const z of b.zones) {
    for (let i = 0; i + 3 < z.rects.length; i += 4) {
      const [x, y, w, h] = [z.rects[i]!, z.rects[i + 1]!, z.rects[i + 2]!, z.rects[i + 3]!];
      items.push({ net: z.netId, layer: z.layer, shape: { kind: 'rect', x0: x, y0: y, x1: x + w, y1: y + h }, bb: [x, y, x + w, y + h], what: `${b.netNames[z.netId] ?? z.netId} pour`, track: true });
    }
  }
  const c = b.rules.clearance;
  const viaIssues: BoardDiagnostic[] = [];
  if (!b.rules.viaInPad) {
    for (const v of b.vias) {
      if (v.inPad) continue; // thermal vias, placed in their pad on purpose (add_vias)
      if (focus && !focus.has(idOf(v) ?? '')) continue;
      for (const part of b.parts) {
        const inPad = part.pads.some((p) => {
          // (a round pad as the circle or oval it is, not its box)
          if (p.shape === 'round') return roundPadDist(p, v.x, v.y) < v.pad / 2 - 1e-6;
          const dx = Math.max(Math.abs(v.x - p.x) - p.w / 2, 0);
          const dy = Math.max(Math.abs(v.y - p.y) - p.h / 2, 0);
          return Math.hypot(dx, dy) < v.pad / 2 - 1e-6;
        });
        const cy = part.courtyard;
        const r = v.pad / 2 - 1e-6;
        // (a via placed on purpose, e.g. a drop beside a capacitor's pad, may stand in the
        // courtyard's margin: only not under the body, between the pads)
        const inSmall = part.pads.length <= 3 && (v.group ? underBody(part, v.x, v.y, r) : v.x > cy.x - r && v.x < cy.x + cy.w + r && v.y > cy.y - r && v.y < cy.y + cy.h + r);
        if (inPad || inSmall) {
          const id = idOf(v);
          viaIssues.push({ code: 'DRC.VIA_IN_PAD', severity: 'error', message: `Via ${id ? `${id} ` : ''}(${b.netNames[v.netId] ?? v.netId}) inside the land pattern of ${part.refdes}; vias in pads are off for this board.`, at: { x: v.x, y: v.y }, entities: [part.refdes, ...(id ? [id] : [])] });
          break;
        }
      }
    }
  }
  // what is close enough to look at: leftmost first, as the findings are listed
  const out: BoardDiagnostic[] = [];
  const seen = new Set<string>();
  for (const [A, B, gap] of closePairs(items, c, focus)) {
    const nets = [A.net, B.net].sort().join('|');
    const at = centre(A.shape);
    const key = `${nets}@${Math.round(at.x)},${Math.round(at.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      code: gap <= 0 ? 'DRC.SHORT' : 'DRC.CLEARANCE',
      severity: 'error',
      message: gap <= 0 ? `${A.what} touches ${B.what} on ${A.layer} (short).` : `${A.what} is ${gap.toFixed(2)} mm from ${B.what} on ${A.layer} (min ${c} mm).`,
      at,
      entities: [A.part, B.part, A.id, B.id].filter((x): x is string => !!x),
    });
  }
  return [...viaIssues, ...out];
}

/** Rows of the broad phase, mm. */
const ROW_MM = 1;

/**
 * The pairs of items of different nets on one layer that are closer than `c`, with their gap, the
 * leftmost first (each pair as leftmost, other). A pour is thousands of rectangles of one net, so
 * per layer the items are listed by row of the board, and only what is not a pour's rectangle goes
 * looking for its neighbours; rectangles only look for those of another net's pour. `focus`: only
 * from these drawn tracks and vias (by id). Pad-to-pad spacing is the footprint's and the placer's
 * business.
 */
function closePairs(items: Item[], c: number, focus?: Set<string>): [Item, Item, number][] {
  const before = (a: number, b: number) => items[a]!.bb[0] < items[b]!.bb[0] || (items[a]!.bb[0] === items[b]!.bb[0] && a < b);
  const pour = (it: Item) => it.shape.kind === 'rect' && it.track;
  const asks = (it: Item, pours: Set<string>) => (focus ? !!it.id && focus.has(it.id) : !pour(it) || pours.size > 1);
  const hits: [number, number, number][] = [];
  const byLayer = new Map<CopperLayer, number[]>();
  items.forEach((it, i) => {
    const list = byLayer.get(it.layer);
    if (list) list.push(i);
    else byLayer.set(it.layer, [i]);
  });
  const lastAsker = new Int32Array(items.length).fill(-1);
  for (const list of byLayer.values()) {
    const pours = new Set(list.filter((i) => pour(items[i]!)).map((i) => items[i]!.net));
    let [y0, y1] = [Infinity, -Infinity];
    for (const i of list) {
      y0 = Math.min(y0, items[i]!.bb[1]);
      y1 = Math.max(y1, items[i]!.bb[3]);
    }
    const rowOf = (y: number) => Math.floor((y - y0) / ROW_MM);
    const rows: number[][] = Array.from({ length: rowOf(y1) + 1 }, () => []);
    for (const i of list) for (let r = rowOf(items[i]!.bb[1]); r <= rowOf(items[i]!.bb[3]); r++) rows[r]!.push(i);
    for (const a of list) {
      const A = items[a]!;
      if (!asks(A, pours)) continue;
      const [from, to] = [Math.max(0, rowOf(A.bb[1] - c)), Math.min(rows.length - 1, rowOf(A.bb[3] + c))];
      for (let r = from; r <= to; r++) {
        for (const b of rows[r]!) {
          if (lastAsker[b] === a || b === a) continue;
          lastAsker[b] = a;
          const B = items[b]!;
          if (A.net === B.net || (!A.track && !B.track)) continue;
          // (two that both ask: the one further left takes it)
          if (asks(B, pours) && before(b, a)) continue;
          const [l, m] = before(a, b) ? [A, B] : [B, A];
          if (m.bb[0] > l.bb[2] + c || m.bb[1] > l.bb[3] + c || l.bb[1] > m.bb[3] + c) continue;
          const gap = distance(l.shape, m.shape);
          if (gap < c - EPS) hits.push(before(a, b) ? [a, b, gap] : [b, a, gap]);
        }
      }
    }
  }
  hits.sort((p, q) => (p[0] === q[0] ? (before(p[1], q[1]) ? -1 : 1) : before(p[0], q[0]) ? -1 : 1));
  return hits.map(([l, m, gap]) => [items[l]!, items[m]!, gap]);
}

const padShape = (pad: BoardPad): Shape =>
  pad.shape === 'round' ? { kind: 'seg', ...padCapsule(pad) } : { kind: 'rect', x0: pad.x - pad.w / 2, y0: pad.y - pad.h / 2, x1: pad.x + pad.w / 2, y1: pad.y + pad.h / 2 };

/** The gap between the copper of two pads (0 where they touch). */
export const padGap = (a: BoardPad, b: BoardPad) => Math.max(0, distance(padShape(a), padShape(b)));

function centre(s: Shape) {
  return s.kind === 'seg' ? { x: (s.ax + s.bx) / 2, y: (s.ay + s.by) / 2 } : { x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2 };
}

/** Gap between two shapes (negative/zero when they touch). */
function distance(a: Shape, b: Shape): number {
  if (a.kind === 'seg' && b.kind === 'seg') return segSeg(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by) - a.r - b.r;
  if (a.kind === 'rect' && b.kind === 'rect') {
    const dx = Math.max(a.x0 - b.x1, b.x0 - a.x1, 0);
    const dy = Math.max(a.y0 - b.y1, b.y0 - a.y1, 0);
    return Math.hypot(dx, dy);
  }
  const [s, r] = a.kind === 'seg' ? [a, b as Extract<Shape, { kind: 'rect' }>] : [b as Extract<Shape, { kind: 'seg' }>, a];
  return segRect(s.ax, s.ay, s.bx, s.by, r) - s.r;
}

function pointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function segsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return o(ax, ay, bx, by, cx, cy) * o(ax, ay, bx, by, dx, dy) < 0 && o(cx, cy, dx, dy, ax, ay) * o(cx, cy, dx, dy, bx, by) < 0;
}

function segSeg(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  if (segsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(pointSeg(ax, ay, cx, cy, dx, dy), pointSeg(bx, by, cx, cy, dx, dy), pointSeg(cx, cy, ax, ay, bx, by), pointSeg(dx, dy, ax, ay, bx, by));
}

export function segRect(ax: number, ay: number, bx: number, by: number, r: { x0: number; y0: number; x1: number; y1: number }): number {
  const inside = (x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
  if (inside(ax, ay) || inside(bx, by)) return 0;
  const edges: [number, number, number, number][] = [
    [r.x0, r.y0, r.x1, r.y0],
    [r.x1, r.y0, r.x1, r.y1],
    [r.x1, r.y1, r.x0, r.y1],
    [r.x0, r.y1, r.x0, r.y0],
  ];
  let best = Infinity;
  for (const [cx, cy, dx, dy] of edges) best = Math.min(best, segSeg(ax, ay, bx, by, cx, cy, dx, dy));
  return best;
}

/**
 * Tracks and vias closer than the edge clearance to a cutout or to the (rounded) board edge.
 * `straight`: the straight edges too (drawn copper; the router keeps off them). `focus`: only these
 * drawn tracks and vias (by id).
 */
export function edgeDrc(b: BoardView, straight = false, focus?: Set<string>): BoardDiagnostic[] {
  const e = b.rules.edgeClearance;
  const out: BoardDiagnostic[] = [];
  const seen = new Set<string>();
  // how close a disc of radius r at (x, y) comes to the outline or a cutout (negative: over it)
  const room = (x: number, y: number, r: number) => {
    let best = { d: insideBoard(b, x, y) - r, what: 'the board edge' };
    for (const c of b.cutouts) {
      const d = cutoutDistance(c, x, y) - r;
      if (d < best.d) best = { d, what: `cutout ${c.id}` };
    }
    return best;
  };
  const report = (what: string, x: number, y: number, r: number, id?: string) => {
    const { d, what: near } = room(x, y, r);
    if (d >= e - EPS) return;
    const key = `${what}|${near}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ code: 'DRC.EDGE_CLEARANCE', severity: 'error', message: `${what} is ${Math.max(0, d).toFixed(2)} mm from ${near} (min ${e} mm).`, at: { x, y }, entities: id ? [id] : [] });
  };
  const inFocus = (x: object) => !focus || focus.has(idOf(x) ?? '');
  if (!straight && !b.cutouts.length && !b.cornerRadius && !b.shape) return out; // the router keeps off straight edges
  for (const t of b.tracks) {
    if (!inFocus(t)) continue;
    const what = copperName(b, 'track', t);
    for (let i = 0; i + 3 < t.pts.length; i += 2) {
      const [ax, ay, bx, by] = [t.pts[i]!, t.pts[i + 1]!, t.pts[i + 2]!, t.pts[i + 3]!];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.05));
      for (let k = 0; k <= n; k++) report(what, ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, t.width / 2, idOf(t));
    }
  }
  for (const v of b.vias) if (inFocus(v)) report(copperName(b, 'via', v), v.x, v.y, v.pad / 2, idOf(v));
  return out;
}

/**
 * Signal tracks crossing a split plane. A track on an outer layer has its return current in the
 * inner layer next to it (F.Cu over In1.Cu, B.Cu over In2.Cu); where an area plane splits that
 * layer, a track crossing the area's edge makes the return current detour round the gap: noise
 * and emissions on fast signals. One finding per net and area, at the first crossing. `signal`
 * says which nets count (supplies and ground do not).
 */
export function splitDrc(b: BoardView, signal: (netId: string) => boolean): BoardDiagnostic[] {
  if (b.layers.length !== 4) return [];
  const over: Partial<Record<CopperLayer, CopperLayer>> = { 'F.Cu': 'In1.Cu', 'B.Cu': 'In2.Cu' };
  const out: BoardDiagnostic[] = [];
  for (const pl of b.planes) {
    if (!pl.area) continue;
    const [x0, y0, x1, y1] = pl.area;
    const area = `${b.netNames[pl.netId] ?? pl.netId} ${pl.under ? `under ${pl.under.join(', ')}` : 'area'} on ${pl.layer}`;
    const found = new Map<string, { layer: CopperLayer; at: { x: number; y: number }; n: number }>();
    for (const t of b.tracks) {
      if (over[t.layer] !== pl.layer || !signal(t.netId)) continue;
      const hits = edgeCrossings(t.pts, x0, y0, x1, y1);
      if (!hits.length) continue;
      const f = found.get(t.netId);
      if (f) f.n += hits.length;
      else found.set(t.netId, { layer: t.layer, at: hits[0]!, n: hits.length });
    }
    for (const [netId, f] of found) {
      const net = b.netNames[netId] ?? netId;
      const other = f.layer === 'F.Cu' ? 'B.Cu' : 'F.Cu';
      out.push({
        code: 'PLANE.SPLIT_CROSSING',
        severity: 'warning',
        message: `${net} crosses the edge of the ${area}${f.n > 1 ? ` ${f.n} times` : ''} on ${f.layer}, the layer over it: its return current detours round the gap. Cross on ${other} (over ${over[other]}) or move the area's edge; waive it for a slow signal.`,
        at: { x: Math.round(f.at.x * 100) / 100, y: Math.round(f.at.y * 100) / 100 },
        entities: [`net:${net}`],
      });
    }
  }
  return out;
}

/** Whether a via of radius r at (x, y) reaches into the box round a part's pads (under its body). */
export function underBody(part: Pick<BoardPart, 'pads'>, x: number, y: number, r: number): boolean {
  const xs = part.pads.flatMap((p) => [p.x - p.w / 2, p.x + p.w / 2]);
  const ys = part.pads.flatMap((p) => [p.y - p.h / 2, p.y + p.h / 2]);
  return x > Math.min(...xs) - r && x < Math.max(...xs) + r && y > Math.min(...ys) - r && y < Math.max(...ys) + r;
}

/**
 * Pads that asked for several vias down to their plane (add_vias drop) and reach it through
 * fewer: the pad's own vias (in it, or at the end of a track of the net that starts in it, 3 mm
 * at most), counted on the copper as it lies. A pad in its net's
 * pour on its own layer is left alone (the pour spreads the current).
 */
export function planeViaDrc(b: BoardView): BoardDiagnostic[] {
  const out: BoardDiagnostic[] = [];
  const near = (x: number, y: number, pad: BoardView['parts'][number]['pads'][number], grow: number) => Math.max(Math.abs(x - pad.x) - pad.w / 2, Math.abs(y - pad.y) - pad.h / 2) <= grow;
  for (const g of b.viaGroups) {
    if (g.kind !== 'drop' || !g.pad || g.wanted < 2) continue;
    const [ref, num] = [g.pad.slice(0, g.pad.lastIndexOf('.')), g.pad.slice(g.pad.lastIndexOf('.') + 1)];
    const part = b.parts.find((p) => p.refdes === ref);
    const pad = part?.pads.find((p) => p.number === num);
    if (!part || !pad) continue;
    {
      const id = g.netId;
      const plane = b.planes.find((pl) => pl.netId === id && !pad.layers.includes(pl.layer) && (!pl.area || (pad.x >= pl.area[0] && pad.x <= pl.area[2] && pad.y >= pl.area[1] && pad.y <= pl.area[3])));
      if (!plane) continue;
      const want = g.wanted;
      // in its own net's pour on its layer
      const poured = b.zones.some((z) => {
        if (z.netId !== id || !pad.layers.includes(z.layer)) return false;
        for (let i = 0; i + 3 < z.rects.length; i += 4) {
          const [x, y, w, h] = [z.rects[i]!, z.rects[i + 1]!, z.rects[i + 2]!, z.rects[i + 3]!];
          if (x < pad.x + pad.w / 2 + 0.5 && x + w > pad.x - pad.w / 2 - 0.5 && y < pad.y + pad.h / 2 + 0.5 && y + h > pad.y - pad.h / 2 - 0.5) return true;
        }
        return false;
      });
      if (poured) continue;
      const own = b.vias.filter((v) => v.netId === id);
      const reached = new Set(own.filter((v) => near(v.x, v.y, pad, v.pad / 2)));
      for (const t of b.tracks) {
        if (t.netId !== id || !pad.layers.includes(t.layer) || t.pts.length < 4) continue;
        let len = 0;
        for (let i = 0; i + 3 < t.pts.length; i += 2) len += Math.hypot(t.pts[i + 2]! - t.pts[i]!, t.pts[i + 3]! - t.pts[i + 1]!);
        if (len > 3) continue;
        const ends = [[t.pts[0]!, t.pts[1]!], [t.pts.at(-2)!, t.pts.at(-1)!]] as const;
        for (const [[ax, ay], [bx, by]] of [[ends[0], ends[1]], [ends[1], ends[0]]] as const) {
          if (!near(ax, ay, pad, 0.01)) continue;
          for (const v of own) if (Math.hypot(v.x - bx, v.y - by) <= v.pad / 2) reached.add(v);
        }
      }
      if (reached.size >= want) continue;
      const name = b.netNames[id] ?? id;
      out.push({
        code: 'DRC.PLANE_VIAS',
        severity: 'warning',
        message: `${part.refdes}.${pad.number} (${name}) reaches the ${plane.layer} plane through ${reached.size || 'no'} via${reached.size === 1 ? '' : 's'} of its own; ${g.id} asks for ${want}${g.note ? ` (${g.note})` : ''}. Place them where they fit with add_vias drop at (right beside the pad, clear of other nets), or move what crowds the pad.`,
        at: { x: Math.round(pad.x * 100) / 100, y: Math.round(pad.y * 100) / 100 },
        entities: [part.refdes],
      });
    }
  }
  return out;
}

/**
 * Where a polyline (x0, y0, x1, y1, …) crosses the outline of a rectangle: each change from
 * outside to inside or back (a point on the outline belongs to the side it came from), and a
 * segment that runs through the rectangle with both ends outside (twice).
 */
export function edgeCrossings(pts: number[], x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
  const side = (x: number, y: number) => (x > x0 + EPS && x < x1 - EPS && y > y0 + EPS && y < y1 - EPS ? 1 : x < x0 - EPS || x > x1 + EPS || y < y0 - EPS || y > y1 + EPS ? -1 : 0);
  /** Segment a–b clipped to the rectangle (Liang–Barsky): where it enters and leaves, or null. */
  const clip = (ax: number, ay: number, bx: number, by: number) => {
    let t0 = 0;
    let t1 = 1;
    const dx = bx - ax;
    const dy = by - ay;
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]] as const) {
      if (Math.abs(p) < 1e-12) {
        if (q < 0) return null;
        continue;
      }
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
    return t0 <= t1 ? { a: { x: ax + dx * t0, y: ay + dy * t0 }, b: { x: ax + dx * t1, y: ay + dy * t1 } } : null;
  };
  const out: { x: number; y: number }[] = [];
  let was = 0;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const [x, y] = [pts[i]!, pts[i + 1]!];
    const now = side(x, y);
    if (i > 0) {
      const [px, py] = [pts[i - 2]!, pts[i - 1]!];
      const c = clip(px, py, x, y);
      if (now !== 0 && was !== 0 && now !== was && c) out.push(was < 0 ? c.a : c.b);
      else if (now < 0 && side(px, py) < 0 && c && side((c.a.x + c.b.x) / 2, (c.a.y + c.b.y) / 2) > 0) out.push(c.a, c.b);
    }
    if (now !== 0) was = now;
  }
  return out;
}

/**
 * Soft checks of drawn copper (warnings: the agent may mean it, and may waive one by its id). A
 * track end that lands on no copper of its net (a pad on its layer, a via, another of its tracks on
 * its layer) is dangling; a piece that is not a multiple of 45° is off the usual directions.
 * `focus`: only these tracks (by id).
 */
export function drawnDrc(b: BoardView, focus?: Set<string>): BoardDiagnostic[] {
  const out: BoardDiagnostic[] = [];
  const name = (id: string) => b.netNames[id] ?? id;
  const pads = b.parts.flatMap((p) => p.pads.map((pad) => ({ p, pad })));
  for (const t of b.drawn?.tracks ?? []) {
    const id = t.id;
    if (focus && !focus.has(id)) continue;
    const lands = (x: number, y: number) =>
      pads.some(({ pad }) => pad.netId === t.netId && (pad.drill || pad.layers.includes(t.layer)) && padPointDist(pad, x, y) <= t.width / 2 + EPS) ||
      b.vias.some((v) => v.netId === t.netId && Math.hypot(v.x - x, v.y - y) <= (v.pad + t.width) / 2 + EPS) ||
      b.tracks.some((o) => (o as { id?: string }).id !== id && o.netId === t.netId && o.layer === t.layer && pieces(o).some(([ax, ay, bx, by]) => segDist(ax, ay, bx, by)(x, y) <= (o.width + t.width) / 2 + EPS)) ||
      // (a pour: as filled, or where it will fill when only the placement is known, as for the check of an op)
      (b.zones.length ? b.zones.some((z) => z.netId === t.netId && z.layer === t.layer && inRects(z.rects, x, y)) : b.planes.some((pl) => pl.netId === t.netId && pl.layer === t.layer && (!pl.area || (x >= pl.area[0] && y >= pl.area[1] && x <= pl.area[2] && y <= pl.area[3]))));
    for (const [x, y, which] of [[t.pts[0]!, t.pts[1]!, 'start'], [t.pts.at(-2)!, t.pts.at(-1)!, 'end']] as const) {
      if (!lands(x, y)) out.push({ code: 'DRAW.DANGLING', severity: 'warning', message: `Track ${id} (${name(t.netId)}, ${t.layer}): its ${which} at ${x.toFixed(2)}, ${y.toFixed(2)} meets no copper of its net.`, at: { x, y }, entities: [id] });
    }
    const odd = pieces(t).find(([ax, ay, bx, by]) => {
      const a = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
      const r = Math.abs(a / 45 - Math.round(a / 45)) * 45;
      return Math.hypot(bx - ax, by - ay) > 0.25 && r > 0.5; // (not the short jog onto a pad)
    });
    if (odd) out.push({ code: 'DRAW.ANGLE', severity: 'warning', message: `Track ${id} (${name(t.netId)}) has a piece off the 45° directions (${odd.map((v) => v.toFixed(2)).join(', ')}); edit_copper with bend sets 45° corners.`, at: { x: (odd[0] + odd[2]) / 2, y: (odd[1] + odd[3]) / 2 }, entities: [id] });
  }
  return out;
}

function pieces(t: { pts: number[] }): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let q = 0; q + 3 < t.pts.length; q += 2) out.push([t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!]);
  return out;
}

const inRects = (rects: number[], x: number, y: number) => {
  for (let i = 0; i + 3 < rects.length; i += 4) if (x >= rects[i]! && y >= rects[i + 1]! && x <= rects[i]! + rects[i + 2]! && y <= rects[i + 1]! + rects[i + 3]!) return true;
  return false;
};

/** The angle (degrees, 0–180) between two directions. */
const angleBetween = (a: [number, number], b: [number, number]) => (Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b))))) * 180) / Math.PI;

/**
 * Acid traps: two tracks of one net that meet at less than 90° (at a bend, a junction, or where
 * one ends on the side of another) with nothing of the net filling the wedge between them. Etchant
 * pools in a narrow copper-free wedge and goes on eating after the board is rinsed. A wedge that a
 * pad, a via, a pour or another track of the net fills is not one, and neither is a junction inside
 * a pad or a via. `focus`: only junctions of these drawn tracks (by id).
 */
export function acidDrc(b: BoardView, focus?: Set<string>): BoardDiagnostic[] {
  type Arm = { dx: number; dy: number; w: number; id?: string };
  const nodes = new Map<string, { x: number; y: number; netId: string; layer: CopperLayer; arms: Arm[] }>();
  const at = (t: { netId: string; layer: CopperLayer }, x: number, y: number) => {
    const key = `${t.layer}|${t.netId}|${Math.round(x * 100)},${Math.round(y * 100)}`;
    let n = nodes.get(key);
    if (!n) nodes.set(key, (n = { x, y, netId: t.netId, layer: t.layer, arms: [] }));
    return n;
  };
  const all: { t: Track; a: [number, number]; b: [number, number] }[] = [];
  for (const t of b.tracks) {
    for (const [ax, ay, bx, by] of pieces(t)) {
      if (Math.hypot(bx - ax, by - ay) < 1e-6) continue;
      all.push({ t, a: [ax, ay], b: [bx, by] });
      at(t, ax, ay).arms.push({ dx: bx - ax, dy: by - ay, w: t.width, id: idOf(t) });
      at(t, bx, by).arms.push({ dx: ax - bx, dy: ay - by, w: t.width, id: idOf(t) });
    }
  }
  // a track ending on the side of another of its net: that one's two directions leave from there
  for (const t of b.tracks) {
    if (t.pts.length < 4) continue;
    for (const [x, y] of [[t.pts[0]!, t.pts[1]!], [t.pts.at(-2)!, t.pts.at(-1)!]] as const) {
      for (const o of all) {
        if (o.t === t || o.t.netId !== t.netId || o.t.layer !== t.layer) continue;
        if (segDist(o.a[0], o.a[1], o.b[0], o.b[1])(x, y) > 0.01 || Math.hypot(x - o.a[0], y - o.a[1]) < 0.01 || Math.hypot(x - o.b[0], y - o.b[1]) < 0.01) continue;
        at(t, x, y).arms.push({ dx: o.a[0] - x, dy: o.a[1] - y, w: o.t.width, id: idOf(o.t) }, { dx: o.b[0] - x, dy: o.b[1] - y, w: o.t.width, id: idOf(o.t) });
      }
    }
  }
  const out: BoardDiagnostic[] = [];
  const pads = b.parts.flatMap((p) => p.pads);
  for (const n of nodes.values()) {
    if (n.arms.length < 2) continue;
    if (focus && !n.arms.some((a) => a.id && focus.has(a.id))) continue;
    // inside a pad or a via of the net: the copper there is whole
    if (pads.some((p) => p.netId === n.netId && (p.drill || p.layers.includes(n.layer)) && padPointDist(p, n.x, n.y) < EPS) || b.vias.some((v) => v.netId === n.netId && Math.hypot(v.x - n.x, v.y - n.y) < v.pad / 2)) continue;
    let worst: number | undefined;
    for (let i = 0; i < n.arms.length; i++) {
      for (let j = i + 1; j < n.arms.length; j++) {
        const [p, q] = [n.arms[i]!, n.arms[j]!];
        const deg = angleBetween([p.dx, p.dy], [q.dx, q.dy]);
        if (deg < 1 || deg > 90 - 0.5 || (worst !== undefined && deg >= worst)) continue;
        const [lp, lq] = [Math.hypot(p.dx, p.dy), Math.hypot(q.dx, q.dy)];
        const [mx, my] = [p.dx / lp + q.dx / lq, p.dy / lp + q.dy / lq];
        // along the bisector the two tracks' edges meet at (w / 2) / sin(angle / 2); the wedge opens beyond that
        const reach = Math.max(p.w, q.w) / 2 / Math.sin((deg * Math.PI) / 360) + 0.1;
        const [px, py] = [n.x + (mx / Math.hypot(mx, my)) * reach, n.y + (my / Math.hypot(mx, my)) * reach];
        const filled =
          pads.some((pd) => pd.netId === n.netId && (pd.drill || pd.layers.includes(n.layer)) && padPointDist(pd, px, py) < EPS) ||
          b.vias.some((v) => v.netId === n.netId && Math.hypot(v.x - px, v.y - py) < v.pad / 2) ||
          b.zones.some((z) => z.netId === n.netId && z.layer === n.layer && inRects(z.rects, px, py)) ||
          all.some((o) => o.t.netId === n.netId && o.t.layer === n.layer && segDist(o.a[0], o.a[1], o.b[0], o.b[1])(px, py) < o.t.width / 2);
        if (!filled) worst = deg;
      }
    }
    if (worst === undefined) continue;
    const net = b.netNames[n.netId] ?? n.netId;
    const ids = [...new Set(n.arms.flatMap((a) => (a.id ? [a.id] : [])))];
    out.push({
      code: 'DRC.ACID_TRAP',
      severity: 'warning',
      message: `${net} on ${n.layer}: tracks meet at ${Math.round(worst)}° at ${n.x.toFixed(2)}, ${n.y.toFixed(2)} with nothing of the net filling the wedge between them (an acid trap: etchant pools there). Bend them 90° or wider${ids.length ? ` (edit_copper with bend on ${ids.join(', ')})` : ''}, or make the join in a pad or via.`,
      at: { x: Math.round(n.x * 100) / 100, y: Math.round(n.y * 100) / 100 },
      entities: ids.length ? ids : [`net:${net}`],
    });
  }
  return out;
}

/**
 * Necks: a track narrower than the width its net runs at (`widthOf`: set_net, its impedance rule,
 * else the power or signal width). Copper that thin carries less than the net was sized for and
 * heats first. A track that starts or ends on a pad too small to take the net's width (an escape
 * from a fine-pitch pad) is the pad's doing and is let be. One finding per net and width where the
 * copper is routed; `focus`: only these drawn tracks (by id).
 */
export function neckDrc(b: BoardView, widthOf: (netId: string, layer: CopperLayer) => number, focus?: Set<string>): BoardDiagnostic[] {
  const out: BoardDiagnostic[] = [];
  const seen = new Set<string>();
  const pads = b.parts.flatMap((p) => p.pads);
  for (const t of b.tracks) {
    const want = widthOf(t.netId, t.layer);
    if (t.width >= want - 0.005 || t.pts.length < 4) continue;
    const id = idOf(t);
    if (focus && !(id && focus.has(id))) continue;
    const ends = [[t.pts[0]!, t.pts[1]!], [t.pts.at(-2)!, t.pts.at(-1)!]] as const;
    if (ends.some(([x, y]) => pads.some((p) => p.netId === t.netId && (p.drill || p.layers.includes(t.layer)) && padPointDist(p, x, y) < EPS && Math.min(p.w, p.h) < want - 0.005))) continue;
    const net = b.netNames[t.netId] ?? t.netId;
    const key = id ?? `${net}|${t.width}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      code: 'DRC.NECK',
      severity: 'warning',
      message: `${id ? `Track ${id}` : 'A track'} (${net}, ${t.layer}) is ${t.width} mm wide where ${net} runs at ${want} mm: a neck in the net's copper. Widen it${id ? ' (edit_copper width)' : ''}, or set the net's width (set_net) to what it can take.`,
      at: { x: t.pts[0]!, y: t.pts[1]! },
      entities: id ? [id] : [`net:${net}`],
    });
  }
  return out;
}

/**
 * Pads joined to their pour through thermal reliefs (a ring cut round the pad, spokes drawn back
 * where no other net is in the way): with fewer than two spokes the joint is weak, and a pad left
 * with none is cut off from the pour (an error for a surface pad that no track of its net reaches
 * either). A pad of a plane styled `thermal: false`, or with thermal vias, is joined solid and not
 * counted; a pad a track of the net joins on the layer is let be.
 */
export function thermalDrc(b: BoardView): BoardDiagnostic[] {
  const out: BoardDiagnostic[] = [];
  for (const z of b.zones) {
    if (!z.shape) continue;
    if (b.planes.find((pl) => pl.netId === z.netId && pl.layer === z.layer)?.style?.thermal === false) continue;
    const net = b.netNames[z.netId] ?? z.netId;
    for (const part of b.parts) {
      for (const pad of part.pads) {
        if (pad.netId !== z.netId || pad.npth || !(pad.drill || pad.layers.includes(z.layer))) continue;
        if (b.vias.some((v) => v.inPad && v.netId === z.netId && padPointDist(pad, v.x, v.y) < EPS)) continue;
        // (a pad the pour does not reach has no ring: no pour a little way out from it)
        if (![[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => inRects(z.rects, pad.x + dx! * (pad.w / 2 + 0.5), pad.y + dy! * (pad.h / 2 + 0.5)))) continue;
        const spokes = z.shape.adds.filter((a) => Math.abs(a.pts[0]! - pad.x) < 0.002 && Math.abs(a.pts[1]! - pad.y) < 0.002).length;
        if (spokes >= 2 || b.tracks.some((t) => t.netId === z.netId && t.layer === z.layer && pieces(t).some(([ax, ay, bx, by]) => padSegDist(pad, ax, ay, bx, by) < EPS))) continue;
        const cut = spokes === 0 && !pad.drill;
        out.push({
          code: 'DRC.THERMAL_SPOKES',
          severity: cut ? 'error' : 'warning',
          message: `${part.refdes}.${pad.number} (${net}) joins its pour on ${z.layer} through ${spokes || 'no'} thermal spoke${spokes === 1 ? '' : 's'}${cut ? ': the pad is cut off from the pour' : ': a weak joint'}. Open room round it (move what crowds the pad, set_plane_style clearance_mm), or join it solid (set_plane_style thermal: false).`,
          at: { x: Math.round(pad.x * 100) / 100, y: Math.round(pad.y * 100) / 100 },
          entities: [part.refdes],
        });
      }
    }
  }
  return out;
}

/** A note on each pour that lost islands: pieces the fill left out because they touched no copper of the net (dead copper). */
export function deadCopperDrc(b: BoardView): BoardDiagnostic[] {
  const out: BoardDiagnostic[] = [];
  for (const z of b.zones) {
    if (!z.removed) continue;
    const net = b.netNames[z.netId] ?? z.netId;
    const n = z.removed.islands;
    out.push({
      code: 'DRC.DEAD_COPPER',
      severity: 'info',
      message: `${n} island${n === 1 ? '' : 's'} of the ${net} pour on ${z.layer} (${z.removed.area} mm², the biggest near ${z.removed.at.x}, ${z.removed.at.y}) touched no ${net} copper and ${n === 1 ? 'was' : 'were'} left out of the fill: no floating copper reaches the fab. Tracks or pads of other nets split the pour there.`,
      at: z.removed.at,
      entities: [`net:${net}`],
    });
  }
  return out;
}
