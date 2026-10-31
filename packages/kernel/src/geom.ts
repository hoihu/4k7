/** Plain geometry the kernel's modules share: boxes, polylines as flat x, y lists, distances to segments. */
import type { Rect } from '@4k7/schema';

/** A segment: x0, y0, x1, y1. */
export type Seg = [number, number, number, number];

/** Rounded to a thousandth (a micrometre on the board): how coordinates are stored. */
export const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Whether two boxes share more than an edge. */
export const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A box with this much more on every side. */
export const grow = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by });

/** A flat polyline's segments. */
export function segmentsOf(pts: number[]): Seg[] {
  const out: Seg[] = [];
  for (let q = 0; q + 3 < pts.length; q += 2) out.push([pts[q]!, pts[q + 1]!, pts[q + 2]!, pts[q + 3]!]);
  return out;
}

/** A flat polyline, back to front. */
export function reversePts(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i]!, pts[i + 1]!);
  return out;
}

/** A flat polyline's length. */
export function polyLength(pts: number[]): number {
  let len = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) len += Math.hypot(pts[i + 2]! - pts[i]!, pts[i + 3]! - pts[i + 1]!);
  return len;
}

/** Whether (x, y) lies on the segment, ends included. */
export function onSegment(x: number, y: number, x1: number, y1: number, x2: number, y2: number): boolean {
  if (x < Math.min(x1, x2) || x > Math.max(x1, x2) || y < Math.min(y1, y2) || y > Math.max(y1, y2)) return false;
  return (x2 - x1) * (y - y1) === (y2 - y1) * (x - x1);
}

/** Distance from a point to the segment a–b. */
export function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The distance to the segment a–b, as a function of the point (for many points). */
export function segDist(ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  return (x: number, y: number) => {
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
  };
}

/** The shortest distance between two segments. */
export function segSegDist(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  const ccw = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = ccw(cx, cy, dx, dy, ax, ay);
  const d2 = ccw(cx, cy, dx, dy, bx, by);
  const d3 = ccw(ax, ay, bx, by, cx, cy);
  const d4 = ccw(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(pointSegDist(ax, ay, cx, cy, dx, dy), pointSegDist(bx, by, cx, cy, dx, dy), pointSegDist(cx, cy, ax, ay, bx, by), pointSegDist(dx, dy, ax, ay, bx, by));
}

/** A drawn track's or via's id (the router's copper has none). */
export const idOf = (x: object): string | undefined => (x as { id?: string }).id;
