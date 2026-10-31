/**
 * Exact clearance of new copper (tracks and vias of one net) against what is on the board: the
 * pads, tracks and vias of other nets on its layer, the board edge and the cutouts. For copper laid
 * outside the router's grid and checked before it is kept: the meanders of tune_length, the pairs
 * the router derives from a centre line (pairroute.ts).
 */
import { cutoutDistance, insideBoard, type BoardCutout, type BoardPart, type CopperLayer, type Track, type Via } from '@4k7/schema';
import { padPointDist, padSegDist } from './keep.ts';
import { segDist, segSegDist } from './geom.ts';

/** The board's shape and rules, as the router and the board view both carry them. */
export interface Geometry {
  outline: { w: number; h: number };
  cornerRadius?: number;
  shape?: number[] | null;
  cutouts?: BoardCutout[];
  layers: CopperLayer[];
  rules: { clearance: number; edgeClearance: number };
}

/** What is there already. */
export interface Existing {
  parts: Pick<BoardPart, 'pads'>[];
  tracks: Track[];
  vias: Via[];
}

export interface Clash {
  x: number;
  y: number;
  /** What it is too close to ("track t3 (CLK)", "pad U1.4", "the board edge"). */
  what: string;
  /** The gap found (negative where they overlap), mm. */
  gap: number;
}

const EPS = 0.005;

/** Pads, tracks and vias of the board that lie within `margin` of a box (x0, y0, x1, y1): all that matters for copper in it. */
export function nearBox(e: Existing, box: [number, number, number, number], margin: number): Existing {
  const [x0, y0, x1, y1] = [box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin];
  const hit = (a: number, b: number, c: number, d: number) => c >= x0 && a <= x1 && d >= y0 && b <= y1;
  return {
    parts: e.parts.map((p) => ({ pads: p.pads.filter((q) => hit(q.x - q.w / 2, q.y - q.h / 2, q.x + q.w / 2, q.y + q.h / 2)) })),
    tracks: e.tracks.filter((t) => {
      let [a, b, c, d] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i + 1 < t.pts.length; i += 2) [a, b, c, d] = [Math.min(a, t.pts[i]!), Math.min(b, t.pts[i + 1]!), Math.max(c, t.pts[i]!), Math.max(d, t.pts[i + 1]!)];
      return hit(a - t.width / 2, b - t.width / 2, c + t.width / 2, d + t.width / 2);
    }),
    vias: e.vias.filter((v) => hit(v.x - v.pad / 2, v.y - v.pad / 2, v.x + v.pad / 2, v.y + v.pad / 2)),
  };
}

/**
 * The first place where `mine` (copper of net `netId`) comes closer than `clearance` (default the
 * board's) to copper of another net, or closer than the edge clearance to the board edge or a cutout.
 * `skip` leaves out tracks and vias (the copper being replaced).
 */
export function firstClash(
  g: Geometry,
  e: Existing,
  netId: string,
  mine: { tracks: Pick<Track, 'layer' | 'width' | 'pts'>[]; vias?: Pick<Via, 'x' | 'y' | 'pad'>[] },
  opts: { clearance?: number; skip?: (x: Track | Via) => boolean; name?: (netId: string) => string } = {},
): Clash | null {
  const c = opts.clearance ?? g.rules.clearance;
  const name = opts.name ?? ((id: string) => id);
  const padsOn = (layer: CopperLayer) => e.parts.flatMap((p) => p.pads).filter((q) => q.netId !== netId && (q.drill || q.layers.includes(layer)));
  const others = (layer: CopperLayer) => e.tracks.filter((o) => o.netId !== netId && o.layer === layer && !opts.skip?.(o));
  const vias = e.vias.filter((v) => v.netId !== netId && !opts.skip?.(v));
  const label = (o: object, kind: string, id: string) => `${kind}${(o as { id?: string }).id ? ` ${(o as { id?: string }).id}` : ''} (${name(id)})`;
  const room = (x: number, y: number, r: number): { d: number; what: string } => {
    let best = { d: insideBoard(g, x, y) - r, what: 'the board edge' };
    for (const cut of g.cutouts ?? []) {
      const d = cutoutDistance(cut, x, y) - r;
      if (d < best.d) best = { d, what: `cutout ${cut.id}` };
    }
    return best;
  };
  const edge = (x: number, y: number, r: number): Clash | null => {
    const { d, what } = room(x, y, r);
    return d < g.rules.edgeClearance - EPS ? { x, y, what, gap: d } : null;
  };
  for (const t of mine.tracks) {
    const r = t.width / 2;
    const pads = padsOn(t.layer);
    const tracks = others(t.layer);
    for (let i = 0; i + 3 < t.pts.length; i += 2) {
      const [ax, ay, bx, by] = [t.pts[i]!, t.pts[i + 1]!, t.pts[i + 2]!, t.pts[i + 3]!];
      const reach = r + c + 0.5;
      const [x0, y0, x1, y1] = [Math.min(ax, bx) - reach, Math.min(ay, by) - reach, Math.max(ax, bx) + reach, Math.max(ay, by) + reach];
      for (const p of pads) {
        if (p.x + p.w / 2 < x0 || p.x - p.w / 2 > x1 || p.y + p.h / 2 < y0 || p.y - p.h / 2 > y1) continue;
        const gap = padSegDist(p, ax, ay, bx, by) - r;
        if (gap < c - EPS) return { x: p.x, y: p.y, what: `pad ${p.number}${p.netId ? ` (${name(p.netId)})` : ''}`, gap };
      }
      for (const o of tracks) {
        for (let q = 0; q + 3 < o.pts.length; q += 2) {
          const [cx, cy, dx, dy] = [o.pts[q]!, o.pts[q + 1]!, o.pts[q + 2]!, o.pts[q + 3]!];
          if (Math.min(cx, dx) - o.width / 2 > x1 || Math.max(cx, dx) + o.width / 2 < x0 || Math.min(cy, dy) - o.width / 2 > y1 || Math.max(cy, dy) + o.width / 2 < y0) continue;
          const gap = segSegDist(ax, ay, bx, by, cx, cy, dx, dy) - r - o.width / 2;
          if (gap < c - EPS) return { x: (cx + dx) / 2, y: (cy + dy) / 2, what: label(o, 'track', o.netId), gap };
        }
      }
      for (const v of vias) {
        const gap = segDist(ax, ay, bx, by)(v.x, v.y) - r - v.pad / 2;
        if (gap < c - EPS) return { x: v.x, y: v.y, what: label(v, 'via', v.netId), gap };
      }
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.1));
      for (let k = 0; k <= n; k++) {
        const hit = edge(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, r);
        if (hit) return hit;
      }
    }
  }
  for (const v of mine.vias ?? []) {
    const r = v.pad / 2;
    for (const p of e.parts.flatMap((q) => q.pads)) {
      if (p.netId === netId) continue;
      const gap = padPointDist(p, v.x, v.y) - r;
      if (gap < c - EPS) return { x: p.x, y: p.y, what: `pad ${p.number}${p.netId ? ` (${name(p.netId)})` : ''}`, gap };
    }
    for (const o of e.tracks) {
      if (o.netId === netId || opts.skip?.(o)) continue;
      for (let q = 0; q + 3 < o.pts.length; q += 2) {
        const gap = segDist(o.pts[q]!, o.pts[q + 1]!, o.pts[q + 2]!, o.pts[q + 3]!)(v.x, v.y) - r - o.width / 2;
        if (gap < c - EPS) return { x: v.x, y: v.y, what: label(o, 'track', o.netId), gap };
      }
    }
    for (const o of vias) {
      const gap = Math.hypot(o.x - v.x, o.y - v.y) - r - o.pad / 2;
      if (gap < c - EPS) return { x: o.x, y: o.y, what: label(o, 'via', o.netId), gap };
    }
    const hit = edge(v.x, v.y, r);
    if (hit) return hit;
  }
  return null;
}
