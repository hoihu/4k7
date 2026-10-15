/**
 * Copper design-rule check on exact geometry, independent of the router's grid: clearance
 * between tracks, vias and pads of different nets on the same layer.
 */
import { cutoutDistance, insideBoard } from '@4k7/schema';
import type { BoardDiagnostic, BoardView, CopperLayer } from '@4k7/schema';

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
  track: boolean;
}

const EPS = 0.005;

export function copperDrc(b: BoardView): BoardDiagnostic[] {
  const items: Item[] = [];
  for (const p of b.parts) {
    for (const pad of p.pads) {
      const layers = pad.drill ? b.layers : pad.layers;
      const shape: Shape =
        pad.shape === 'round'
          ? { kind: 'seg', ax: pad.x, ay: pad.y, bx: pad.x, by: pad.y, r: Math.min(pad.w, pad.h) / 2 }
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
      items.push({ net: t.netId, layer: t.layer, shape: { kind: 'seg', ax, ay, bx, by, r }, bb: [Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r], what: `track ${b.netNames[t.netId] ?? t.netId}`, track: true });
    }
  }
  for (const v of b.vias) {
    const r = v.pad / 2;
    for (const layer of b.layers) items.push({ net: v.netId, layer, shape: { kind: 'seg', ax: v.x, ay: v.y, bx: v.x, by: v.y, r }, bb: [v.x - r, v.y - r, v.x + r, v.y + r], what: `via ${b.netNames[v.netId] ?? v.netId}`, track: true });
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
      for (const part of b.parts) {
        const inPad = part.pads.some((p) => {
          const dx = Math.max(Math.abs(v.x - p.x) - p.w / 2, 0);
          const dy = Math.max(Math.abs(v.y - p.y) - p.h / 2, 0);
          return Math.hypot(dx, dy) < v.pad / 2 - 1e-6;
        });
        const cy = part.courtyard;
        const r = v.pad / 2 - 1e-6;
        const inSmall = part.pads.length <= 3 && v.x > cy.x - r && v.x < cy.x + cy.w + r && v.y > cy.y - r && v.y < cy.y + cy.h + r;
        if (inPad || inSmall) {
          viaIssues.push({ code: 'DRC.VIA_IN_PAD', severity: 'error', message: `Via (${b.netNames[v.netId] ?? v.netId}) inside the land pattern of ${part.refdes}; vias in pads are off for this board.`, at: { x: v.x, y: v.y }, entities: [part.refdes] });
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
        entities: [A.part, B.part].filter((x): x is string => !!x),
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

/** Tracks and vias closer than the edge clearance to a cutout or to the (rounded) board edge. */
export function edgeDrc(b: BoardView): BoardDiagnostic[] {
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
  const report = (what: string, x: number, y: number, r: number) => {
    const { d, what: near } = room(x, y, r);
    if (d >= e - EPS) return;
    const key = `${what}|${near}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ code: 'DRC.EDGE_CLEARANCE', severity: 'error', message: `${what} is ${Math.max(0, d).toFixed(2)} mm from ${near} (min ${e} mm).`, at: { x, y }, entities: [] });
  };
  if (!b.cutouts.length && !b.cornerRadius && !b.shape) return out; // the router keeps off straight edges
  for (const t of b.tracks) {
    const what = `track ${b.netNames[t.netId] ?? t.netId}`;
    for (let i = 0; i + 3 < t.pts.length; i += 2) {
      const [ax, ay, bx, by] = [t.pts[i]!, t.pts[i + 1]!, t.pts[i + 2]!, t.pts[i + 3]!];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.05));
      for (let k = 0; k <= n; k++) report(what, ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, t.width / 2);
    }
  }
  for (const v of b.vias) report(`via ${b.netNames[v.netId] ?? v.netId}`, v.x, v.y, v.pad / 2);
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
