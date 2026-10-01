/**
 * Free-form board outlines: an SVG path (as a model or a drawing program writes it) or a point
 * list, turned into a closed polygon in millimetres, scaled to the size asked for.
 *
 * SVG paths: M L H V C S Q T A Z, absolute and relative; curves and arcs are sampled into
 * points. Only the first closed figure counts (the outline); more figures are rejected, cutouts
 * are separate (add_cutout).
 */

export type OutlineResult = { ok: true; pts: number[] } | { ok: false; reason: string };
export type FiguresResult = { ok: true; figs: number[][] } | { ok: false; reason: string };

/** The polygon of an SVG path's first figure (flat x, y list, in the path's own units). */
export function pathPolygon(d: string): OutlineResult {
  const r = pathFigures(d);
  if (!r.ok) return r;
  if (r.figs.length > 1) return { ok: false, reason: 'the path has more than one figure; give the outline alone (cutouts are added with add_cutout)' };
  return { ok: true, pts: r.figs[0]! };
}

/** Every figure of an SVG path as a closed polygon (flat x, y lists, in the path's own units). */
export function pathFigures(d: string): FiguresResult {
  const figs: number[][] = [];
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens?.length) return { ok: false, reason: 'the path is empty' };
  let pts: number[] = [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let cx = 0; // last control point (for S and T)
  let cy = 0;
  let prev = '';
  let closed = false;
  /** End the current figure (the closing point repeating the first is dropped). */
  const endFigure = () => {
    if (pts.length >= 4 && Math.abs(pts[0]! - pts.at(-2)!) < 1e-9 && Math.abs(pts[1]! - pts.at(-1)!) < 1e-9) pts.splice(-2);
    if (pts.length >= 6) figs.push(pts);
    pts = [];
    closed = false;
  };
  const num = () => {
    const t = tokens[i++];
    if (t === undefined || /[a-z]/i.test(t)) throw new Error(`a number is missing after "${cmd}"`);
    return Number(t);
  };
  const push = (px: number, py: number) => {
    if (closed) return;
    const n = pts.length;
    if (n >= 2 && Math.abs(pts[n - 2]! - px) < 1e-9 && Math.abs(pts[n - 1]! - py) < 1e-9) return;
    pts.push(px, py);
  };
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    for (let k = 1; k <= 24; k++) {
      const t = k / 24;
      const u = 1 - t;
      push(u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey);
    }
  };
  const quad = (x1: number, y1: number, ex: number, ey: number) => {
    for (let k = 1; k <= 16; k++) {
      const t = k / 16;
      const u = 1 - t;
      push(u * u * x + 2 * u * t * x1 + t * t * ex, u * u * y + 2 * u * t * y1 + t * t * ey);
    }
  };
  /** An elliptical arc (SVG endpoint form) to (ex, ey), sampled every few degrees. */
  const arc = (rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, ex: number, ey: number) => {
    if (rx === 0 || ry === 0) return push(ex, ey);
    const phi = (rotDeg * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (x - ex) / 2;
    const dy = (y - ey) / 2;
    const x1 = cos * dx + sin * dy;
    const y1 = -sin * dx + cos * dy;
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lambda > 1) {
      rx *= Math.sqrt(lambda);
      ry *= Math.sqrt(lambda);
    }
    const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den));
    const cxp = (co * rx * y1) / ry;
    const cyp = (-co * ry * x1) / rx;
    const ccx = cos * cxp - sin * cyp + (x + ex) / 2;
    const ccy = sin * cxp + cos * cyp + (y + ey) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
    let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 36)));
    for (let k = 1; k <= n; k++) {
      const t = t1 + (dt * k) / n;
      push(ccx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, ccy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos);
    }
  };
  try {
    while (i < tokens.length) {
      if (/[a-z]/i.test(tokens[i]!)) cmd = tokens[i++]!;
      else if (!cmd) throw new Error('the path must start with M');
      const rel = cmd === cmd.toLowerCase();
      const ox = rel ? x : 0;
      const oy = rel ? y : 0;
      switch (cmd.toUpperCase()) {
        case 'M': {
          if (pts.length) endFigure(); // a new figure: the current one ends here
          x = ox + num();
          y = oy + num();
          sx = x;
          sy = y;
          push(x, y);
          cmd = rel ? 'l' : 'L'; // further pairs are line-tos
          break;
        }
        case 'L':
          x = ox + num();
          y = oy + num();
          push(x, y);
          break;
        case 'H':
          x = ox + num();
          push(x, y);
          break;
        case 'V':
          y = oy + num();
          push(x, y);
          break;
        case 'C': {
          const [x1, y1, x2, y2, ex, ey] = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()];
          cubic(x1, y1, x2, y2, ex, ey);
          [cx, cy, x, y] = [x2, y2, ex, ey];
          break;
        }
        case 'S': {
          const [x1, y1] = /[CS]/i.test(prev) ? [2 * x - cx, 2 * y - cy] : [x, y];
          const [x2, y2, ex, ey] = [ox + num(), oy + num(), ox + num(), oy + num()];
          cubic(x1, y1, x2, y2, ex, ey);
          [cx, cy, x, y] = [x2, y2, ex, ey];
          break;
        }
        case 'Q': {
          const [x1, y1, ex, ey] = [ox + num(), oy + num(), ox + num(), oy + num()];
          quad(x1, y1, ex, ey);
          [cx, cy, x, y] = [x1, y1, ex, ey];
          break;
        }
        case 'T': {
          const [x1, y1] = /[QT]/i.test(prev) ? [2 * x - cx, 2 * y - cy] : [x, y];
          const [ex, ey] = [ox + num(), oy + num()];
          quad(x1, y1, ex, ey);
          [cx, cy, x, y] = [x1, y1, ex, ey];
          break;
        }
        case 'A': {
          const [rx, ry, rot, large, sweep] = [num(), num(), num(), num(), num()];
          const [ex, ey] = [ox + num(), oy + num()];
          arc(rx, ry, rot, large !== 0, sweep !== 0, ex, ey);
          x = ex;
          y = ey;
          break;
        }
        case 'Z':
          x = sx;
          y = sy;
          closed = true;
          break;
        default:
          throw new Error(`unknown path command "${cmd}"`);
      }
      prev = cmd;
    }
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  endFigure();
  if (!figs.length) return { ok: false, reason: 'the path has no closed figure with at least 3 points' };
  return { ok: true, figs };
}

/**
 * A usable board outline from a polygon: at least 3 points, not crossing itself, scaled so its
 * bounding box is width × height (one given: uniform scaling), moved so the box starts at 0, 0.
 */
export function boardOutline(raw: number[], width?: number, height?: number): OutlineResult {
  const pts = [...raw];
  if (pts.length < 6) return { ok: false, reason: 'an outline needs at least 3 points' };
  const xs = pts.filter((_, i) => i % 2 === 0);
  const ys = pts.filter((_, i) => i % 2 === 1);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return { ok: false, reason: 'the outline has no area' };
  const sx = width ? width / bw : height ? height / bh : 1;
  const sy = height ? height / bh : width ? width / bw : 1;
  const out = pts.map((v, i) => Math.round((i % 2 === 0 ? (v - x0) * sx : (v - y0) * sy) * 1000) / 1000);
  // a simple polygon: no two edges cross (neighbours share a point, that is fine)
  const n = out.length / 2;
  const seg = (k: number) => [out[2 * k]!, out[2 * k + 1]!, out[2 * ((k + 1) % n)]!, out[2 * ((k + 1) % n) + 1]!] as const;
  const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  for (let a = 0; a < n; a++) {
    for (let b = a + 2; b < n; b++) {
      if (a === 0 && b === n - 1) continue;
      const [p1x, p1y, p2x, p2y] = seg(a);
      const [q1x, q1y, q2x, q2y] = seg(b);
      if (cross(p1x, p1y, p2x, p2y, q1x, q1y) * cross(p1x, p1y, p2x, p2y, q2x, q2y) < 0 && cross(q1x, q1y, q2x, q2y, p1x, p1y) * cross(q1x, q1y, q2x, q2y, p2x, p2y) < 0) {
        return { ok: false, reason: `the outline crosses itself (edges ${a + 1} and ${b + 1})` };
      }
    }
  }
  return { ok: true, pts: out };
}
