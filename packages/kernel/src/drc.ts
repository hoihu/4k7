/**
 * Copper design-rule check on exact geometry, independent of the router's grid: clearance
 * between tracks, vias and pads of different nets on the same layer.
 */
import { cutoutDistance, insideBoard, padCapsule, roundPadDist } from '@4k7/schema';
import type { BoardDiagnostic, BoardPart, BoardView, CopperLayer } from '@4k7/schema';
import { segDist } from './segments.ts';
import { padPointDist } from './keep.ts';

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
      const shape: Shape =
        pad.shape === 'round'
          ? { kind: 'seg', ...padCapsule(pad) }
          : { kind: 'rect', x0: pad.x - pad.w / 2, y0: pad.y - pad.h / 2, x1: pad.x + pad.w / 2, y1: pad.y + pad.h / 2 };
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
  const out: BoardDiagnostic[] = [];
  const seen = new Set<string>();
  const sorted = items.map((it, i) => ({ it, i })).sort((p, q) => p.it.bb[0] - q.it.bb[0]);
  for (let m = 0; m < sorted.length; m++) {
    const A = sorted[m]!.it;
    for (let n = m + 1; n < sorted.length; n++) {
      const B = sorted[n]!.it;
      if (B.bb[0] > A.bb[2] + c) break; // sweep on x
      if (A.layer !== B.layer || A.net === B.net) continue;
      if (!A.track && !B.track) continue; // pad-to-pad spacing is the footprint's and the placer's business
      if (focus && !(A.id && focus.has(A.id)) && !(B.id && focus.has(B.id))) continue;
      if (B.bb[1] > A.bb[3] + c || A.bb[1] > B.bb[3] + c) continue;
      const gap = distance(A.shape, B.shape);
      if (gap >= c - EPS) continue;
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
  }
  return [...viaIssues, ...out];
}

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

function segRect(ax: number, ay: number, bx: number, by: number, r: { x0: number; y0: number; x1: number; y1: number }): number {
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
