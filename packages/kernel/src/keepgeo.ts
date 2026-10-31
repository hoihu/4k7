/**
 * Keep-out geometry (keepout.ts has the ops and the check): how close tracks, vias and parts come
 * to a keep-out's area, on exact geometry. Apart from keepout.ts so keep.ts and the router can use
 * it without a cycle.
 */
import { keepoutDistance, roundPadDist, type BoardKeepout, type BoardPad, type BoardPart, type CopperLayer, type KeepoutForbid } from '@4k7/schema';
import { r3, segSegDist } from './geom.ts';

const EPS = 0.005;
const outer = (l: CopperLayer) => l === 'F.Cu' || l === 'B.Cu';

/** Distance from a point to a pad's copper (0 inside). */
const padDist = (p: BoardPad, x: number, y: number) => (p.shape === 'round' ? Math.max(0, roundPadDist(p, x, y)) : Math.hypot(Math.max(Math.abs(x - p.x) - p.w / 2, 0), Math.max(Math.abs(y - p.y) - p.h / 2, 0)));

/** How close a segment comes to a keep-out's area: 0 when it touches or lies in it. */
export function segKeepoutDist(k: Pick<BoardKeepout, 'poly'>, ax: number, ay: number, bx: number, by: number): number {
  if (keepoutDistance(k, ax, ay) <= 0 || keepoutDistance(k, bx, by) <= 0) return 0;
  const p = k.poly;
  let best = Infinity;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) best = Math.min(best, segSegDist(ax, ay, bx, by, p[j]!, p[j + 1]!, p[i]!, p[i + 1]!));
  return best;
}

/** Whether an axis-aligned box (x0, y0, x1, y1) overlaps a keep-out's area. */
export function boxInKeepout(k: Pick<BoardKeepout, 'poly' | 'bounds'>, x0: number, y0: number, x1: number, y1: number): boolean {
  const [a0, b0, a1, b1] = k.bounds;
  if (x1 <= a0 + EPS || x0 >= a1 - EPS || y1 <= b0 + EPS || y0 >= b1 - EPS) return false;
  if ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]].some(([x, y]) => keepoutDistance(k, x!, y!) < -EPS)) return true;
  const p = k.poly;
  if (p.length >= 2 && p.some((_, i) => i % 2 === 0 && p[i]! > x0 + EPS && p[i]! < x1 - EPS && p[i + 1]! > y0 + EPS && p[i + 1]! < y1 - EPS)) return true;
  const edges = [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]] as const;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    // (crossing properly: an edge that only grazes the box does not count)
    for (const [cx, cy, dx, dy] of edges) if (properCross(p[j]!, p[j + 1]!, p[i]!, p[i + 1]!, cx, cy, dx, dy)) return true;
  }
  return false;
}

export function properCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const ccw = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = ccw(cx, cy, dx, dy, ax, ay);
  const d2 = ccw(cx, cy, dx, dy, bx, by);
  const d3 = ccw(ax, ay, bx, by, cx, cy);
  const d4 = ccw(ax, ay, bx, by, dx, dy);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

/** Whether a keep-out forbids this on that layer (a via and a drilled part go through every layer). */
const forbids = (k: BoardKeepout, what: KeepoutForbid, layer?: CopperLayer) => k.forbid.includes(what) && (layer ? k.layers.includes(layer) : k.layers.length > 0);

/** The pads of the part a keep-out is attached to: its own copper may stand in it. */
export function hostPads(parts: BoardPart[], k: BoardKeepout): BoardPad[] {
  return k.partId ? (parts.find((p) => p.componentId === k.partId)?.pads ?? []) : [];
}

/** Where a track of this width on this layer enters a keep-out that forbids tracks there (the first spot), else null. */
export function trackInKeepout(keepouts: BoardKeepout[], parts: BoardPart[], layer: CopperLayer, pts: number[], width: number): { keepout: BoardKeepout; x: number; y: number } | null {
  for (const k of keepouts) {
    if (!forbids(k, 'tracks', layer)) continue;
    const own = hostPads(parts, k);
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const [ax, ay, bx, by] = [pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!];
      if (segKeepoutDist(k, ax, ay, bx, by) >= width / 2 - EPS) continue;
      if (!own.length) return { keepout: k, x: r3(ax), y: r3(ay) };
      // (the part's own pads stand in its keep-out: the track's end on one is no harm)
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.05));
      for (let q = 0; q <= n; q++) {
        const x = ax + ((bx - ax) * q) / n;
        const y = ay + ((by - ay) * q) / n;
        if (keepoutDistance(k, x, y) < width / 2 - EPS && !own.some((p) => padDist(p, x, y) < width / 2 + 0.05)) return { keepout: k, x: r3(x), y: r3(y) };
      }
    }
  }
  return null;
}

/** The keep-out that forbids a via of this pad size at (x, y), else null. */
export function viaInKeepout(keepouts: BoardKeepout[], x: number, y: number, pad: number): BoardKeepout | null {
  return keepouts.find((k) => forbids(k, 'vias') && keepoutDistance(k, x, y) < pad / 2 - EPS) ?? null;
}

/** Whether a keep-out holds a part's courtyard off on its side (a drilled part: on either side). */
export function partForbidden(k: BoardKeepout, p: Pick<BoardPart, 'side' | 'pads'>): boolean {
  if (!k.forbid.includes('parts')) return false;
  if (p.pads.some((q) => q.drill)) return k.layers.some(outer);
  return k.layers.includes(p.side === 'bottom' ? 'B.Cu' : 'F.Cu');
}
