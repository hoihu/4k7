/**
 * Incremental routing: what of the routing before still holds for the board as it is now. A
 * placement change moves pads (and may grow the board): a track whose end no longer lands on copper
 * of its net, or that now comes too close to a pad of another net, a via placed on purpose or the
 * board edge, goes, and so does what
 * that leaves hanging (a via joined to nothing, a stub to where a pad was). What stays is kept by
 * the router as it lies (RouteInput.keep), which then routes only the connections left open.
 */
import { cutoutDistance, insideBoard, padCapsule, roundPadDist, type BoardPad, type CopperLayer, type Track, type Via } from '@4k7/schema';
import type { RouteInput } from './router.ts';
import { segDist, segSegDist } from './segments.ts';

/**
 * Kept copper of one net that joins pads: the pads (indices into all parts' pads in order), its
 * tracks and vias (indices into KeptCopper's lists).
 */
export interface KeptPiece {
  netId: string;
  pads: number[];
  tracks: number[];
  vias: number[];
}

export interface KeptCopper {
  tracks: Track[];
  vias: Via[];
  pieces: KeptPiece[];
}

const EPS = 1e-3;
/** Bucket size of the pad index, mm. */
const BUCKET = 2;

/** Distance from a point to a pad's copper (0 inside). */
export function padPointDist(p: BoardPad, x: number, y: number): number {
  if (p.shape === 'round') return Math.max(0, roundPadDist(p, x, y));
  return Math.hypot(Math.max(Math.abs(x - p.x) - p.w / 2, 0), Math.max(Math.abs(y - p.y) - p.h / 2, 0));
}

/** Distance from a segment to a pad's copper (0 where they meet). */
export function padSegDist(p: BoardPad, ax: number, ay: number, bx: number, by: number): number {
  if (p.shape === 'round') {
    const c = padCapsule(p);
    return Math.max(0, segSegDist(ax, ay, bx, by, c.ax, c.ay, c.bx, c.by) - c.r);
  }
  if (padPointDist(p, ax, ay) === 0 || padPointDist(p, bx, by) === 0) return 0;
  const [x0, y0, x1, y1] = [p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2];
  return Math.min(segSegDist(ax, ay, bx, by, x0, y0, x1, y0), segSegDist(ax, ay, bx, by, x1, y0, x1, y1), segSegDist(ax, ay, bx, by, x1, y1, x0, y1), segSegDist(ax, ay, bx, by, x0, y1, x0, y0));
}

/** Each piece (segment) of a track: x0, y0, x1, y1. */
function pieces(t: Track): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let q = 0; q + 3 < t.pts.length; q += 2) out.push([t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!]);
  return out;
}


/**
 * The copper of `before` that still holds on the board `input` describes (its parts, planes,
 * rules and vias placed on purpose), grouped by the pads it joins. Vias of a group (add_vias) and
 * the copper of tracks the agent laid or locked (track, lock_copper) are not taken over: the router lays
 * them afresh.
 */
export function keptCopper(input: RouteInput, before: { tracks: Track[]; vias: Via[] }): KeptCopper {
  const { rules } = input;
  const pads = input.parts.flatMap((p) => p.pads);
  const planes = input.planes ?? [];
  const outer = (l: CopperLayer) => l === 'F.Cu' || l === 'B.Cu';
  // an inner layer with a plane takes no tracks (the router closes it to them)
  const closed = new Set(planes.filter((pl) => !outer(pl.layer)).map((pl) => pl.layer));
  const nets = new Set(pads.flatMap((p) => (p.netId ? [p.netId] : [])));
  const fixed = input.vias?.fixed ?? [];
  const onLayer = (p: BoardPad, layer: CopperLayer) => !!p.drill || p.layers.includes(layer);

  // pads by bucket, for the clearance checks
  const buckets = new Map<string, number[]>();
  pads.forEach((p, i) => {
    for (let bx = Math.floor((p.x - p.w / 2) / BUCKET); bx <= Math.floor((p.x + p.w / 2) / BUCKET); bx++) {
      for (let by = Math.floor((p.y - p.h / 2) / BUCKET); by <= Math.floor((p.y + p.h / 2) / BUCKET); by++) {
        const key = `${bx}:${by}`;
        buckets.set(key, [...(buckets.get(key) ?? []), i]);
      }
    }
  });
  const padsNear = (x0: number, y0: number, x1: number, y1: number) => {
    const out = new Set<number>();
    for (let bx = Math.floor(x0 / BUCKET); bx <= Math.floor(x1 / BUCKET); bx++) for (let by = Math.floor(y0 / BUCKET); by <= Math.floor(y1 / BUCKET); by++) for (const i of buckets.get(`${bx}:${by}`) ?? []) out.add(i);
    return out;
  };

  /*
   * The board edge (a rounded or free-form outline too) and milled cutouts: copper of half-width r
   * at (x, y) stays the edge clearance away, as the router keeps it.
   */
  const { w, h } = input.outline;
  const corner = input.cornerRadius ?? 0;
  const shaped = corner > 0 || !!input.shape;
  const outline = { outline: input.outline, cornerRadius: corner, shape: input.shape ?? null };
  const cutouts = input.cutouts ?? [];
  const edgeOk = (x: number, y: number, r: number) => {
    const keep = rules.edgeClearance + r - EPS;
    if (x < keep || y < keep || x > w - keep || y > h - keep) return false;
    // (a rounded corner only matters near the corners; a free-form outline everywhere)
    if (shaped && (input.shape || Math.min(x, w - x) < corner + keep || Math.min(y, h - y) < corner + keep) && insideBoard(outline, x, y) < keep) return false;
    return cutouts.every((c) => cutoutDistance(c, x, y) >= keep);
  };
  const segEdgeOk = (ax: number, ay: number, bx: number, by: number, r: number) => {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.05));
    for (let i = 0; i <= n; i++) if (!edgeOk(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n, r)) return false;
    return true;
  };

  /** A track keeps its clearance from other nets' pads, from vias placed on purpose and from the edge. */
  const trackClear = (t: Track) => {
    const need = rules.clearance + t.width / 2 - EPS;
    for (const [ax, ay, bx, by] of pieces(t)) {
      if (!segEdgeOk(ax, ay, bx, by, t.width / 2)) return false;
      for (const i of padsNear(Math.min(ax, bx) - need, Math.min(ay, by) - need, Math.max(ax, bx) + need, Math.max(ay, by) + need)) {
        const p = pads[i]!;
        if (p.netId === t.netId || !onLayer(p, t.layer)) continue;
        if (padSegDist(p, ax, ay, bx, by) < need) return false;
      }
      for (const v of fixed) if (v.netId !== t.netId && segDist(ax, ay, bx, by)(v.x, v.y) < rules.clearance + (t.width + v.pad) / 2 - EPS) return false;
    }
    return true;
  };
  /**
   * A via keeps its clearance from other nets' pads on every layer, stays off pads and out of small
   * parts' land patterns (unless the board allows vias in pads), and keeps its spacing from the
   * vias placed on purpose: the router's rules for a new via.
   */
  const viaClear = (v: Via) => {
    if (!edgeOk(v.x, v.y, v.pad / 2)) return false;
    const reach = v.pad / 2 + rules.clearance;
    for (const i of padsNear(v.x - reach, v.y - reach, v.x + reach, v.y + reach)) {
      const p = pads[i]!;
      if ((p.netId !== v.netId || !rules.viaInPad) && padPointDist(p, v.x, v.y) < reach - EPS) return false;
    }
    if (!rules.viaInPad) {
      for (const part of input.parts) {
        if (part.pads.length > 3) continue;
        const c = part.courtyard;
        const r = rules.viaPad / 2;
        if (v.x > c.x - r + EPS && v.x < c.x + c.w + r - EPS && v.y > c.y - r + EPS && v.y < c.y + c.h + r - EPS) return false;
      }
    }
    return !fixed.some((f) => Math.hypot(f.x - v.x, f.y - v.y) < (f.pad + v.pad) / 2 + rules.clearance - EPS);
  };

  // (a drop via's stub is laid afresh with its via, a track the agent laid afresh as asked)
  const stubs = new Set((input.vias?.stubs ?? []).map((t) => `${t.netId} ${t.layer} ${t.pts.join(' ')}`));
  let tracks = before.tracks.filter((t) => !t.drawn && !t.locked && nets.has(t.netId) && input.layers.includes(t.layer) && !closed.has(t.layer) && t.pts.length >= 4 && !stubs.has(`${t.netId} ${t.layer} ${t.pts.join(' ')}`) && trackClear(t));
  // (vias of a group the router lays afresh are not taken over: placed on purpose or stitching)
  const afresh = new Set([...fixed, ...(input.vias?.fill ?? [])].map((v) => v.group));
  let vias = before.vias.filter((v) => !v.drawn && !v.locked && (!v.group || !afresh.has(v.group)) && nets.has(v.netId) && viaClear(v));

  // a net with a plane: a via joined to one pad may be its drop (inside the plane's area, if it has one)
  const dropOk = (v: Via) => {
    const own = planes.filter((pl) => pl.netId === v.netId);
    return own.some((pl) => !pl.area || (v.x >= pl.area[0] && v.x <= pl.area[2] && v.y >= pl.area[1] && v.y <= pl.area[3]));
  };
  const padsOf = new Map<string, number[]>();
  pads.forEach((p, i) => p.netId && padsOf.set(p.netId, [...(padsOf.get(p.netId) ?? []), i]));

  /*
   * Hanging copper goes, until nothing more does: a track end must land on (its copper meet) a pad
   * of its net on its layer, a via of its net, or another track of its net on its layer; a via
   * must join two things (a drop to a plane: one).
   */
  for (;;) {
    const n = tracks.length + vias.length;
    const tracksOf = new Map<string, Track[]>();
    for (const t of tracks) tracksOf.set(t.netId, [...(tracksOf.get(t.netId) ?? []), t]);
    const viasOf = new Map<string, Via[]>();
    for (const v of [...vias, ...fixed]) viasOf.set(v.netId, [...(viasOf.get(v.netId) ?? []), v]);
    const lands = (t: Track, x: number, y: number) =>
      (padsOf.get(t.netId) ?? []).some((i) => onLayer(pads[i]!, t.layer) && padPointDist(pads[i]!, x, y) <= t.width / 2) ||
      (viasOf.get(t.netId) ?? []).some((v) => Math.hypot(v.x - x, v.y - y) <= (v.pad + t.width) / 2) ||
      (tracksOf.get(t.netId) ?? []).some((o) => o !== t && o.layer === t.layer && pieces(o).some(([ax, ay, bx, by]) => segDist(ax, ay, bx, by)(x, y) <= o.width / 2 + EPS));
    tracks = tracks.filter((t) => lands(t, t.pts[0]!, t.pts[1]!) && lands(t, t.pts.at(-2)!, t.pts.at(-1)!));
    vias = vias.filter((v) => {
      const joined =
        (tracksOf.get(v.netId) ?? []).filter((t) => tracks.includes(t) && pieces(t).some(([ax, ay, bx, by]) => segDist(ax, ay, bx, by)(v.x, v.y) <= (v.pad + t.width) / 2)).length +
        (padsOf.get(v.netId) ?? []).filter((i) => padPointDist(pads[i]!, v.x, v.y) <= v.pad / 2).length;
      return joined >= (dropOk(v) ? 1 : 2);
    });
    if (tracks.length + vias.length === n) break;
  }

  /*
   * The pieces: per net, pads, tracks and vias (the kept ones and those placed on purpose) joined
   * where their copper meets. A piece that joins no pad goes; so does one that joins a single pad,
   * unless it is that pad's drop to a plane (it has a via).
   */
  const kept: KeptCopper = { tracks: [], vias: [], pieces: [] };
  for (const [netId, padIdx] of padsOf) {
    const ts = tracks.filter((t) => t.netId === netId);
    const vs = vias.filter((v) => v.netId === netId);
    if (!ts.length && !vs.length) continue;
    const fs = fixed.filter((v) => v.netId === netId);
    // nodes: pads, tracks, kept vias, vias placed on purpose
    const P = padIdx.length;
    const T = ts.length;
    const V = vs.length;
    const parent = Array.from({ length: P + T + V + fs.length }, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    const join = (a: number, b: number) => (parent[find(b)] = find(a));
    const allVias = [...vs, ...fs];
    const box = (t: Track) => {
      const xs = t.pts.filter((_, i) => i % 2 === 0);
      const ys = t.pts.filter((_, i) => i % 2 === 1);
      return [Math.min(...xs) - t.width / 2, Math.min(...ys) - t.width / 2, Math.max(...xs) + t.width / 2, Math.max(...ys) + t.width / 2] as const;
    };
    const boxes = ts.map(box);
    ts.forEach((t, ti) => {
      const segs = pieces(t);
      padIdx.forEach((pi, k) => {
        const p = pads[pi]!;
        if (onLayer(p, t.layer) && segs.some(([ax, ay, bx, by]) => padSegDist(p, ax, ay, bx, by) <= t.width / 2)) join(k, P + ti);
      });
      for (let tj = ti + 1; tj < T; tj++) {
        const o = ts[tj]!;
        const [a, b] = [boxes[ti]!, boxes[tj]!];
        if (o.layer !== t.layer || a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]) continue;
        const gap = (t.width + o.width) / 2;
        if (segs.some(([ax, ay, bx, by]) => pieces(o).some(([cx, cy, dx, dy]) => segSegDist(ax, ay, bx, by, cx, cy, dx, dy) <= gap))) join(P + ti, P + tj);
      }
      allVias.forEach((v, vi) => {
        if (segs.some(([ax, ay, bx, by]) => segDist(ax, ay, bx, by)(v.x, v.y) <= (v.pad + t.width) / 2)) join(P + ti, P + T + vi);
      });
    });
    allVias.forEach((v, vi) => padIdx.forEach((pi, k) => padPointDist(pads[pi]!, v.x, v.y) <= v.pad / 2 && join(k, P + T + vi)));

    const groups = new Map<number, number[]>();
    for (let i = 0; i < parent.length; i++) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
    for (const members of groups.values()) {
      const gp = members.filter((i) => i < P).map((i) => padIdx[i]!);
      const gt = members.filter((i) => i >= P && i < P + T).map((i) => i - P);
      const gv = members.filter((i) => i >= P + T && i < P + T + V).map((i) => i - P - T);
      const hasVia = members.some((i) => i >= P + T);
      if (!gt.length && !gv.length) continue;
      if (!gp.length || (gp.length === 1 && !(hasVia && planes.some((pl) => pl.netId === netId)))) continue;
      const t0 = kept.tracks.length;
      const v0 = kept.vias.length;
      kept.tracks.push(...gt.map((i) => ts[i]!));
      kept.vias.push(...gv.map((i) => vs[i]!));
      kept.pieces.push({ netId, pads: gp, tracks: gt.map((_, k) => t0 + k), vias: gv.map((_, k) => v0 + k) });
    }
  }
  return kept;
}
