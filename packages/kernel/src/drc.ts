/**
 * Copper design-rule check on exact geometry, independent of the router's grid: clearance
 * between tracks, vias and pads of different nets on the same layer.
 */
import { cutoutDistance, insideOutline } from '@tracewise/schema';
import type { BoardDiagnostic, BoardView, CopperLayer } from '@tracewise/schema';

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
    let best = { d: insideOutline(b.outline.w, b.outline.h, b.cornerRadius, x, y) - r, what: 'the board edge' };
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
  if (!b.cutouts.length && !b.cornerRadius) return out; // the router keeps off straight edges
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
