/** Distances between points and segments (flat x, y), for checks on exact copper geometry. */

/** Distance from a point to the segment a–b. */
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
  const pt = (px: number, py: number, sx: number, sy: number, ex: number, ey: number) => {
    const vx = ex - sx;
    const vy = ey - sy;
    const l2 = vx * vx + vy * vy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - sx) * vx + (py - sy) * vy) / l2)) : 0;
    return Math.hypot(px - (sx + t * vx), py - (sy + t * vy));
  };
  return Math.min(pt(ax, ay, cx, cy, dx, dy), pt(bx, by, cx, cy, dx, dy), pt(cx, cy, ax, ay, bx, by), pt(dx, dy, ax, ay, bx, by));
}
