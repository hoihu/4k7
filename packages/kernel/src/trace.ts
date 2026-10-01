/**
 * A black-and-white bitmap traced into closed outlines along the pixel edges: every boundary
 * between ink and blank becomes part of exactly one loop, so filling the loops even-odd gives the
 * bitmap back (outer shapes and their holes). Collinear points are dropped.
 */

/** `ink[y * w + x]` = 1 for ink. Loops in pixel units (x right, y down), flat x, y lists. */
export function traceBitmap(ink: Uint8Array | number[], w: number, h: number): number[][] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && ink[y * w + x] === 1;
  // directed edges around ink, clockwise on screen (ink on the right of travel): start vertex → ends
  const key = (x: number, y: number) => y * (w + 1) + x;
  const out = new Map<number, number[]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = key(x0, y0);
    const list = out.get(k);
    if (list) list.push(key(x1, y1));
    else out.set(k, [key(x1, y1)]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const xy = (k: number) => [k % (w + 1), Math.floor(k / (w + 1))] as const;
  const loops: number[][] = [];
  for (const [start, ends] of out) {
    while (ends.length) {
      const loop: number[] = [start];
      let prev = start;
      let cur = ends.pop()!;
      while (cur !== start) {
        loop.push(cur);
        const next = out.get(cur)!;
        // two ways on (pixels touching at a corner): turn right, keeping each loop simple
        let pick = 0;
        if (next.length > 1) {
          const [px, py] = xy(prev);
          const [cx, cy] = xy(cur);
          const [dx, dy] = [cx - px, cy - py];
          pick = next.findIndex((n) => {
            const [nx, ny] = xy(n);
            return (nx - cx) * dy - (ny - cy) * dx < 0; // a right turn on screen (y down)
          });
          if (pick < 0) pick = 0;
        }
        prev = cur;
        cur = next.splice(pick, 1)[0]!;
      }
      loops.push(simplify(loop.flatMap((k) => xy(k))));
    }
  }
  return loops.filter((l) => l.length >= 6);
}

/** Drop points on a straight line between their neighbours. */
function simplify(p: number[]): number[] {
  const n = p.length / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = [p[((i - 1 + n) % n) * 2]!, p[((i - 1 + n) % n) * 2 + 1]!];
    const [bx, by] = [p[i * 2]!, p[i * 2 + 1]!];
    const [cx, cy] = [p[((i + 1) % n) * 2]!, p[((i + 1) % n) * 2 + 1]!];
    if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) !== 0) out.push(bx, by);
  }
  return out;
}
