/**
 * One pass of the router, its grid (router.ts): what every stage of the pass reads. Nets as small
 * integers, the clearance maps per width class with everything there from the start stamped in, each
 * pad's cells and escape, what the search's costs are made of, and the copper joined so far.
 */
import { type BoardPad, type BoardPart, boardPolygon, type CopperLayer, cutoutBounds, cutoutDistance, keepoutDistance, type PlaneStyle, roundPadDist, type Track, type Via } from '@4k7/schema';
import { r3, segDist, segmentsOf, segSegDist } from './geom.ts';
import { type KeptCopper } from './keep.ts';
import { type RouteInput } from './router.ts';

export const G = 0.1; // grid pitch, mm
export const MULTI = -1; // near copper of two nets: nobody may route here
export const EDGE = -2; // too close to the board edge
export const TURN_COST = 0.6;

/**
 * How a pass routes. free: 45° tracks anywhere, vias dear (2.5 mm of track each), a light
 * preference for horizontal on F.Cu and vertical on B.Cu: a tidy board. grid: each outer layer
 * keeps to its direction and vias are cheap, the classic two-layer autorouter way; it is not
 * pretty, but it gets nearly anything through. Free passes first; when they stop gaining with
 * connections still open, grid passes follow, and the pass with the fewest open wins.
 */
export interface Style {
  via: number; // in grid steps
  offAxis: number; // per step against the layer's direction
}

export const CENTRE_COST = 0.5; // per step and grid step off the middle of the gap between two IC pins
export const CLIP_COST = 3; // a step whose copper runs half over one of the net's own pads, off its centre line
export const SPLIT_COST = 8; // per step on the band along a split plane's edge (signal nets), in grid steps
export const SPLIT_BAND = 0.3; // the band: this far either side of the gap, mm
export const COARSE = 5; // coarse routing grid, in grid steps (0.5 mm)
export const CORRIDOR = 4; // coarse cells either side of the coarse way (2 mm)
export const MAX_STUB = 30; // longest drop stub reserved for a pour, in grid steps (3 mm)
export const PROBE_PENALTY = 12; // probe: entering another net's copper, in grid steps
export const HISTORY_STEP = 2; // history cost added where an open connection's probe runs, per pass
export type Plane = { netId: string; layer: CopperLayer; area?: [number, number, number, number]; style?: PlaneStyle };

/** A pad's centre inside an area plane's rectangle. */
export const inArea = (pl: Plane, p: BoardPad) => !!pl.area && p.x >= pl.area[0] && p.x <= pl.area[2] && p.y >= pl.area[1] && p.y <= pl.area[3];

export interface Conn {
  netId: string;
  a: number;
  b: number;
  len: number;
}

/**
 * The 4-connected islands of the cells that are set, numbered as a scan from the top left meets
 * them, and their sizes. By runs along the rows, joined from row to row.
 */
export function islandsOf(ok: Uint8Array, W: number, H: number): { island: Int32Array; sizes: number[] } {
  const island = new Int32Array(W * H).fill(-1);
  const runs: number[] = []; // start cell and end cell (past it) of each run
  const parent: number[] = [];
  const find = (r: number): number => {
    let root = r;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[r] !== root) [parent[r], r] = [root, parent[r]!];
    return root;
  };
  let above = 0; // the first run of the row above
  for (let j = 0; j < H; j++) {
    const row = j * W;
    const first = runs.length / 2;
    let a = above;
    for (let i = 0; i < W; ) {
      if (!ok[row + i]) {
        i++;
        continue;
      }
      const start = i;
      while (i < W && ok[row + i]) i++;
      const r = runs.length / 2;
      runs.push(row + start, row + i);
      parent.push(r);
      // the runs above that it touches
      while (a < first && runs[2 * a + 1]! - (row - W) <= start) a++;
      for (let b = a; b < first && runs[2 * b]! - (row - W) < i; b++) {
        parent[find(r)] = find(b);
      }
    }
    above = first;
  }
  const idOf = new Map<number, number>();
  const sizes: number[] = [];
  for (let r = 0; r < runs.length / 2; r++) {
    const root = find(r);
    let id = idOf.get(root);
    if (id === undefined) {
      id = sizes.length;
      idOf.set(root, id);
      sizes.push(0);
    }
    island.fill(id, runs[2 * r]!, runs[2 * r + 1]!);
    sizes[id]! += runs[2 * r + 1]! - runs[2 * r]!;
  }
  return { island, sizes };
}

/** The part of a polyline (flat x, y list) between distances d0 and d1 along it. */
export function cutPts(pts: number[], d0: number, d1: number): number[] {
  const out: number[] = [];
  let s = 0;
  for (let q = 0; q + 3 < pts.length; q += 2) {
    const [ax, ay, bx, by] = [pts[q]!, pts[q + 1]!, pts[q + 2]!, pts[q + 3]!];
    const len = Math.hypot(bx - ax, by - ay);
    const at = (d: number) => [ax + ((bx - ax) * (d - s)) / (len || 1), ay + ((by - ay) * (d - s)) / (len || 1)] as const;
    if (s + len >= d0 && s <= d1) {
      if (!out.length) out.push(...at(Math.max(d0, s)));
      out.push(...at(Math.min(d1, s + len)));
    }
    s += len;
  }
  return out;
}

export const PROGRESS_MS = 200;
export const OUTER = new Set<CopperLayer>(['F.Cu', 'B.Cu']);
export const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * The bend (if any) between a grid point on a pad and the pad centre, so the entry is 0/45/90°
 * instead of one piece at an arbitrary angle. Preferably a straight piece (continuing the track)
 * then a diagonal one deep inside the pad into its centre; but if that straight piece would run
 * off the pad's centre band (half over its edge), the diagonal first and the straight piece on
 * the centre line. The bend lies in the box spanned by the two points: on a rectangular pad it
 * stays on the pad.
 */
export function entryBend(x: number, y: number, p: BoardPad, width: number): number[] {
  const dx = p.x - x;
  const dy = p.y - y;
  const m = Math.min(Math.abs(dx), Math.abs(dy));
  if (m < 1e-6 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-6) return [];
  // the straight piece runs along the bigger delta, m off the centre line
  const across = Math.abs(dy) > Math.abs(dx) ? p.w : p.h;
  if (m <= Math.max(0, across / 2 - width / 2) + 0.08) return [p.x - Math.sign(dx) * m, p.y - Math.sign(dy) * m];
  return [x + Math.sign(dx) * m, y + Math.sign(dy) * m];
}

/** The sign, with coordinates equal within float noise counting as equal. */
export const sgn = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Math.sign(v));

/**
 * Distance of every grid point inside the outline (negative outside), cached per route input.
 * Only distances up to FIELD_BAND matter (the edge clearance plus the widest copper), so: inside
 * or out per row from where the row crosses the outline, and exact distances only in a band
 * along each edge; everything farther away is ±FIELD_FAR. (A curvy outline has hundreds of
 * edges: measuring every point to every edge would take longer than the whole routing.)
 */
export const fields = new WeakMap<RouteInput, Float32Array>();

export const FIELD_BAND = 2;
export const FIELD_FAR = 1000;

export function insideField(input: RouteInput, W: number, H: number): Float32Array {
  let f = fields.get(input);
  if (f) return f;
  f = new Float32Array(W * H);
  const poly = boardPolygon({ outline: input.outline, cornerRadius: input.cornerRadius ?? 0, shape: input.shape ?? null });
  const n = poly.length / 2;
  // inside or out: the crossings of each row with the outline, filled pairwise
  for (let j = 0; j < H; j++) {
    const y = j * G;
    const xs: number[] = [];
    for (let a = 0, b = n - 1; a < n; b = a++) {
      const [ax, ay, bx, by] = [poly[2 * a]!, poly[2 * a + 1]!, poly[2 * b]!, poly[2 * b + 1]!];
      if (ay > y !== by > y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((p, q) => p - q);
    f.fill(-FIELD_FAR, j * W, j * W + W);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k]! / G));
      const i1 = Math.min(W - 1, Math.floor(xs[k + 1]! / G));
      if (i1 >= i0) f.fill(FIELD_FAR, j * W + i0, j * W + i1 + 1);
    }
  }
  // exact distances near the edges
  const near = new Float32Array(W * H).fill(FIELD_FAR);
  for (let a = 0, b = n - 1; a < n; b = a++) {
    const [ax, ay, bx, by] = [poly[2 * a]!, poly[2 * a + 1]!, poly[2 * b]!, poly[2 * b + 1]!];
    const d = segDist(ax, ay, bx, by);
    for (let j = Math.max(0, Math.floor((Math.min(ay, by) - FIELD_BAND) / G)); j <= Math.min(H - 1, Math.ceil((Math.max(ay, by) + FIELD_BAND) / G)); j++) {
      for (let i = Math.max(0, Math.floor((Math.min(ax, bx) - FIELD_BAND) / G)); i <= Math.min(W - 1, Math.ceil((Math.max(ax, bx) + FIELD_BAND) / G)); i++) {
        const v = d(i * G, j * G);
        if (v < near[j * W + i]!) near[j * W + i] = v;
      }
    }
  }
  for (let c = 0; c < W * H; c++) if (near[c]! < FIELD_FAR) f[c] = f[c]! > 0 ? near[c]! : -near[c]!;
  fields.set(input, f);
  return f;
}

/** Drop collinear points and duplicates from a flat polyline. */
export function simplify(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i]!;
    const y = pts[i + 1]!;
    const n = out.length;
    if (n >= 2 && Math.abs(out[n - 2]! - x) < 1e-9 && Math.abs(out[n - 1]! - y) < 1e-9) continue;
    if (n >= 4) {
      const ax = out[n - 4]!;
      const ay = out[n - 3]!;
      const bx = out[n - 2]!;
      const by = out[n - 1]!;
      const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      // on one line, going on (or only stepping back by a sub-grid bit, e.g. from a pad centre
      // to the grid point next to it): the middle point goes
      const forward = (bx - ax) * (x - bx) + (by - ay) * (y - by) >= 0;
      if (Math.abs(cross) < 1e-9 && (forward || Math.hypot(bx - ax, by - ay) < G / 2 || Math.hypot(x - bx, y - by) < G / 2)) {
        out[n - 2] = x;
        out[n - 1] = y;
        continue;
      }
    }
    out.push(x, y);
  }
  return out;
}

/** What a pass is asked to do. */
export interface PassArgs {
  input: RouteInput;
  pads: BoardPad[];
  owner: BoardPart[];
  order: Conn[];
  deadline: number;
  planeOnly: Conn[];
  early: Set<Conn>;
  /** Cost of entering each state (layer × grid point), grown where open connections wanted to go. */
  history: Float32Array;
  style: Style;
  /** Copper kept from the routing before (see RouteInput.keep), there from the start. */
  kept: KeptCopper | null;
  progress?: ((tracks: Track[], vias: Via[], done: number) => void) | undefined;
}

export function passGrid({ input, pads, owner, order, deadline, planeOnly, early, history, style, kept, progress }: PassArgs) {
  const { rules, layers } = input;
  const W = Math.ceil(input.outline.w / G) + 1;
  const H = Math.ceil(input.outline.h / G) + 1;
  const N = W * H;
  const L = layers.length;
  const layerIdx = new Map(layers.map((l, i) => [l, i]));

  // net ids as small integers (0 = free)
  const netNum = new Map<string, number>();
  const numOf = (id: string) => {
    let n = netNum.get(id);
    if (!n) netNum.set(id, (n = netNum.size + 1));
    return n;
  };
  // pads without a net still block everyone else
  let lonely = 1_000_000;
  const padNet = pads.map((p) => (p.netId ? numOf(p.netId) : lonely++));

  // width classes: 0 signal track, 1 power track, 2 via, then the widths chosen for single nets.
  // A track never uses class 2, even at the via's width: vias may pass dedicated plane layers,
  // tracks may not
  const widths = [rules.track, rules.powerTrack, rules.viaPad];
  const trackClass = (w: number) => widths.findIndex((x, i) => i !== 2 && x === w);
  for (const w of Object.values(input.netWidths ?? {})) if (w > 0 && trackClass(w) < 0) widths.push(w);
  /*
   * Drawn copper with nothing asked of the router: no search runs, what is wanted is the pours and
   * what the copper joins. The clearance maps and the costs are all for the search, but for the
   * signal width's, which says where a pad's escape ends (its cell counts as the pad's copper), and
   * the via's when stitching vias look for their spots.
   */
  const searching = !input.drawn || !!input.drawn.only?.nets?.length || !!input.drawn.only?.pairs?.length || order.length > 0 || planeOnly.length > 0;
  const stitching = !!input.vias?.fill?.length || !!input.vias?.along?.length;
  const CLASSES = searching ? widths.map((_, k) => k) : stitching ? [0, 2] : [0];
  const maps = widths.map((_, k) => (CLASSES.includes(k) ? Array.from({ length: L }, () => new Int32Array(N)) : []));

  // the coarse grid (see corridor): the coarse cell of grid point (i, j) is crow[j] + ccol[i]
  const CW = Math.ceil(W / COARSE);
  const CH = Math.ceil(H / COARSE);
  const CN = CW * CH;
  const crow = Int32Array.from({ length: H }, (_, j) => Math.floor(j / COARSE) * CW);
  const ccol = Int32Array.from({ length: W }, (_, i) => Math.floor(i / COARSE));
  const coarseOf = (i: number) => crow[(i / W) | 0]! + ccol[i % W]!;
  const mark = (k: number, l: number, i: number, net: number) => {
    const m = maps[k]![l]!;
    const v = m[i]!;
    if (v === 0) m[i] = net;
    else if (v !== net) m[i] = MULTI;
  };
  /** Mark cells within `reach(k)` of a shape; dist(x, y) is the distance from a point to it. */
  const stamp = (l: number, net: number, x0: number, y0: number, x1: number, y1: number, extra: number, dist: (x: number, y: number) => number) => {
    for (const k of CLASSES) {
      const reach = rules.clearance + extra + widths[k]! / 2 + G * 0.1;
      const i0 = Math.max(0, Math.floor((x0 - reach) / G));
      const i1 = Math.min(W - 1, Math.ceil((x1 + reach) / G));
      const j0 = Math.max(0, Math.floor((y0 - reach) / G));
      const j1 = Math.min(H - 1, Math.ceil((y1 + reach) / G));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (dist(i * G, j * G) < reach) mark(k, l, j * W + i, net);
    }
  };
  const padDist = (p: BoardPad) =>
    p.shape === 'round'
      ? (x: number, y: number) => roundPadDist(p, x, y)
      : (x: number, y: number) => Math.hypot(Math.max(Math.abs(x - p.x) - p.w / 2, 0), Math.max(Math.abs(y - p.y) - p.h / 2, 0));
  const stampPad = (p: BoardPad, net: number) => {
    for (const lay of p.layers) {
      const l = layerIdx.get(lay);
      if (l !== undefined) stamp(l, net, p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2, 0, padDist(p));
    }
    // a drilled hole is copper on every layer
    if (p.drill && p.layers.length < L) for (let l = 0; l < L; l++) stamp(l, net, p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2, 0, padDist(p));
  };
  const stampSeg = (l: number, net: number, ax: number, ay: number, bx: number, by: number, width: number) =>
    stamp(l, net, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), width / 2, segDist(ax, ay, bx, by));
  // vias keep a minimum spacing from every other via (same net too: drills must not crowd);
  // a path may pass an existing via of its own net exactly (no new via is added there)
  const viaAt = new Int32Array(W * H);
  const viaNear = new Uint8Array(W * H);
  const VIA_SPACING = rules.viaPad + rules.clearance;
  /** A via `size` wide (default the board's): copper on every layer, and no other via too close. */
  const stampVia = (net: number, x: number, y: number, size = rules.viaPad) => {
    for (let l = 0; l < L; l++) stamp(l, net, x, y, x, y, size / 2, (px, py) => Math.hypot(px - x, py - y));
    const ci = Math.min(W - 1, Math.max(0, Math.round(x / G)));
    const cj = Math.min(H - 1, Math.max(0, Math.round(y / G)));
    viaAt[cj * W + ci] = net;
    const spacing = (size + rules.viaPad) / 2 + rules.clearance;
    const r = Math.ceil(spacing / G);
    for (let j = Math.max(0, cj - r); j <= Math.min(H - 1, cj + r); j++) {
      for (let i = Math.max(0, ci - r); i <= Math.min(W - 1, ci + r); i++) if (Math.hypot((i - ci) * G, (j - cj) * G) < spacing - 1e-6) viaNear[j * W + i] = 1;
    }
  };
  /** The cells of layer l whose centre lies on a track's copper (within it, not just near it): where later routes may join it. */
  const copperCells = (l: number, pts: number[], width: number): number[] => {
    const out = new Set<number>();
    for (let q = 0; q + 3 < pts.length; q += 2) {
      const [ax, ay, bx, by] = [pts[q]!, pts[q + 1]!, pts[q + 2]!, pts[q + 3]!];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (G / 4)));
      for (let i = 0; i <= steps; i++) {
        const ci = Math.round((ax + ((bx - ax) * i) / steps) / G);
        const cj = Math.round((ay + ((by - ay) * i) / steps) / G);
        if (ci < 0 || cj < 0 || ci >= W || cj >= H) continue;
        if (segDist(ax, ay, bx, by)(ci * G, cj * G) <= width / 2 - 1e-6) out.add(l * N + cj * W + ci);
      }
    }
    return [...out];
  };
  /** Record a via (once per place and net). */
  const addVia = (netId: string, net: number, px: number, py: number) => {
    const x = r3(px);
    const y = r3(py);
    if (vias.some((v) => v.netId === netId && Math.abs(v.x - x) < 1e-6 && Math.abs(v.y - y) < 1e-6)) return;
    vias.push({ netId, x, y, drill: rules.viaDrill, pad: rules.viaPad });
    stampVia(net, px, py);
  };

  // board edge (rounded corners too) and milled cutouts
  const cornerR = input.cornerRadius ?? 0;
  const shaped = cornerR > 0 || !!input.shape;
  // how far each grid point lies inside a rounded or free-form outline: computed once per route
  // (every pass, width class, layer and plane reads it)
  const edgeField = shaped ? insideField(input, W, H) : null;
  const inside = (x: number, y: number) => edgeField![Math.round(y / G) * W + Math.round(x / G)]!;
  for (const k of CLASSES) {
    const keep = rules.edgeClearance + widths[k]! / 2;
    // (alike on every layer: worked out on the first)
    const edge = maps[k]![0]!;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const x = i * G;
        const y = j * G;
        if (x < keep || y < keep || x > input.outline.w - keep || y > input.outline.h - keep) edge[j * W + i] = EDGE;
        else if (shaped && inside(x, y) < keep) edge[j * W + i] = EDGE;
      }
    }
    for (const c of input.cutouts ?? []) {
      const [x0, y0, x1, y1] = cutoutBounds(c);
      for (let j = Math.max(0, Math.floor((y0 - keep) / G)); j <= Math.min(H - 1, Math.ceil((y1 + keep) / G)); j++) {
        for (let i = Math.max(0, Math.floor((x0 - keep) / G)); i <= Math.min(W - 1, Math.ceil((x1 + keep) / G)); i++) if (cutoutDistance(c, i * G, j * G) < keep) edge[j * W + i] = EDGE;
      }
    }
    for (let l = 1; l < L; l++) maps[k]![l]!.set(edge);
    for (let l = 0; l < L; l++) {
      const m = maps[k]![l]!;
      // keep-outs that hold tracks off on this layer (a via class passes: vias have their own)
      if (k === 2) continue;
      for (const ko of input.keepouts ?? []) {
        if (!ko.forbid.includes('tracks') || !ko.layers.includes(layers[l]!)) continue;
        const own = input.parts.find((p) => p.componentId === ko.partId)?.pads.map((p) => padDist(p)) ?? [];
        const reach = widths[k]! / 2 + G * 0.35;
        const [x0, y0, x1, y1] = ko.bounds;
        for (let j = Math.max(0, Math.floor((y0 - reach) / G)); j <= Math.min(H - 1, Math.ceil((y1 + reach) / G)); j++) {
          for (let i = Math.max(0, Math.floor((x0 - reach) / G)); i <= Math.min(W - 1, Math.ceil((x1 + reach) / G)); i++) {
            // (the attached part's own pads stand in it: its tracks start there)
            if (keepoutDistance(ko, i * G, j * G) < reach && !own.some((dist) => dist(i * G, j * G) < reach + rules.clearance + G)) m[j * W + i] = EDGE;
          }
        }
      }
    }
  }
  pads.forEach((p, i) => stampPad(p, padNet[i]!));
  // the vias placed on purpose that are there from the start (see RouteInput.vias)
  for (const v of input.vias?.fixed ?? []) stampVia(numOf(v.netId), v.x, v.y, v.pad);
  // and the stubs joining a pad's drop vias to it
  for (const t of input.vias?.stubs ?? []) {
    const l = layerIdx.get(t.layer);
    if (l !== undefined) stampSeg(l, numOf(t.netId), t.pts[0]!, t.pts[1]!, t.pts[2]!, t.pts[3]!, t.width);
  }
  // dedicated plane layers carry no tracks (vias still pass through, with clearance)
  for (const pl of input.planes ?? []) {
    const l = layerIdx.get(pl.layer);
    if (l === undefined || OUTER.has(pl.layer)) continue;
    for (const k of CLASSES) if (k !== 2) maps[k]![l]!.fill(EDGE);
  }
  // the signal map with pads, keep-outs and the edge only: what no rip-up can clear (for the probe)
  const fixedMap = searching ? maps[0]!.map((m) => m.slice()) : [];
  // the copper kept from the routing before: after fixedMap (a later pass may route its nets
  // again), before the escapes (they keep clear of it)
  const keptTracks = kept ? kept.pieces.flatMap((pc) => pc.tracks.map((i) => kept.tracks[i]!)) : [];
  const keptVias = kept ? kept.pieces.flatMap((pc) => pc.vias.map((i) => kept.vias[i]!)) : [];
  for (const t of keptTracks) {
    const l = layerIdx.get(t.layer)!;
    for (let q = 0; q + 3 < t.pts.length; q += 2) stampSeg(l, numOf(t.netId), t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!, t.width);
  }
  for (const v of keptVias) stampVia(numOf(v.netId), v.x, v.y, v.pad);
  // the plane under a line at a set impedance stays whole: under its tracks laid before (drawn or
  // kept), only the plane's net. (On a dedicated plane layer only vias matter: tracks never go there.)
  const planeLayers = new Set((input.planes ?? []).filter((pl) => !OUTER.has(pl.layer)).map((pl) => layerIdx.get(pl.layer)));
  for (const t of keptTracks) {
    const ln = input.lines?.find((x) => x.netId === t.netId && x.layer === t.layer);
    const l = ln && layerIdx.get(ln.over);
    if (!ln || l === undefined) continue;
    const net = numOf(ln.plane);
    for (let q = 0; q + 3 < t.pts.length; q += 2) {
      const [ax, ay, bx, by] = [t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!];
      const dist = segDist(ax, ay, bx, by);
      for (const k of CLASSES) {
        if (planeLayers.has(l) && k !== 2) continue;
        const reach = rules.clearance + t.width / 2 + ln.h + widths[k]! / 2 + G * 0.1;
        const m = maps[k]![l]!;
        for (let j = Math.max(0, Math.floor((Math.min(ay, by) - reach) / G)); j <= Math.min(H - 1, Math.ceil((Math.max(ay, by) + reach) / G)); j++) {
          for (let i = Math.max(0, Math.floor((Math.min(ax, bx) - reach) / G)); i <= Math.min(W - 1, Math.ceil((Math.max(ax, bx) + reach) / G)); i++) {
            const c = j * W + i;
            const v = m[c]!;
            if (v === EDGE || dist(i * G, j * G) >= reach) continue;
            if (v === 0) m[c] = net;
            else if (v !== net) m[c] = MULTI;
          }
        }
      }
    }
  }
  /** Segments of a net (width w, on layer l) keep the clearance from the kept copper of other nets. */
  const clearOfKept = (netId: string, l: number, w: number, segs: [number, number, number, number][]) =>
    segs.every(([ax, ay, bx, by]) =>
      keptTracks.every((t) => t.netId === netId || t.layer !== layers[l] || segmentsOf(t.pts).every(([cx, cy, dx, dy]) => segSegDist(ax, ay, bx, by, cx, cy, dx, dy) >= rules.clearance + (w + t.width) / 2 - 1e-3)) &&
      keptVias.every((v) => v.netId === netId || segDist(ax, ay, bx, by)(v.x, v.y) >= rules.clearance + (w + v.pad) / 2 - 1e-3),
    );

  // copper cells per pad (inside the pad), for starts and goals
  const padCells = pads.map((p) => {
    const cells: number[] = [];
    const d = padDist(p);
    const i0 = Math.max(0, Math.floor((p.x - p.w / 2) / G));
    const i1 = Math.min(W - 1, Math.ceil((p.x + p.w / 2) / G));
    const j0 = Math.max(0, Math.floor((p.y - p.h / 2) / G));
    const j1 = Math.min(H - 1, Math.ceil((p.y + p.h / 2) / G));
    const onLayers = p.drill ? layers.map((_, l) => l) : p.layers.map((l) => layerIdx.get(l)!).filter((l) => l !== undefined);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (d(i * G, j * G) <= 0) for (const l of onLayers) cells.push(l * N + j * W + i);
    if (!cells.length) {
      // tiny pad: the nearest grid point
      const i = Math.min(W - 1, Math.max(0, Math.round(p.x / G)));
      const j = Math.min(H - 1, Math.max(0, Math.round(p.y / G)));
      for (const l of onLayers) cells.push(l * N + j * W + i);
    }
    return cells;
  });

  /*
   * Escapes for fine-pitch SMD pads: between neighbours the only clear lane is the pad's exact
   * centre line, which the grid rarely hits. So each such pad also offers a grid point just
   * beyond its outer end, reached by a straight stub along its axis (then a short jog).
   */
  const escapes = pads.map((p, idx) => {
    if (p.drill || !p.netId) return null;
    const part = owner[idx]!;
    const alongX = p.w > p.h * 1.3;
    const alongY = p.h > p.w * 1.3;
    if (!alongX && !alongY) return null;
    const dir = alongX ? Math.sign(p.x - part.x) : Math.sign(p.y - part.y);
    if (!dir) return null;
    const half = (alongX ? p.w : p.h) / 2;
    const l = layerIdx.get(p.layers[0]!);
    if (l === undefined) return null;
    const reach = rules.clearance + rules.track / 2;
    // neighbours alternate short and long stubs, so their jogs onto the grid never face each other
    const long = Number.parseInt(p.number.replace(/\D/g, '') || '0', 10) % 2 === 0;
    // the preferred length first; if something sits there (a cap close to the chip), the other
    for (const stub of long ? [0.5, 0] : [0, 0.5]) {
      const p1 = alongX ? { x: p.x + dir * (half + reach + stub), y: p.y } : { x: p.x, y: p.y + dir * (half + reach + stub) };
      for (let extra = 0.1; extra <= 0.45; extra += 0.1) {
        const ex = alongX ? p1.x + dir * extra : p1.x;
        const ey = alongX ? p1.y : p1.y + dir * extra;
        const i = Math.round(ex / G);
        const j = Math.round(ey / G);
        if (i < 0 || j < 0 || i >= W || j >= H) break;
        const v = maps[0]![l]![j * W + i]!;
        if ((v === 0 || v === padNet[idx]) && (!keptTracks.length || clearOfKept(p.netId, l, rules.track, [[p.x, p.y, p1.x, p1.y], [p1.x, p1.y, i * G, j * G]]))) return { state: l * N + j * W + i, p1, l, ex: i * G, ey: j * G };
      }
    }
    return null;
  });
  // copper that is already a net's own (inside its pads): always usable by that net
  // how deep inside its pad a cell lies: a track centred there stays on the pad if width/2 ≤ inset
  const ownCopper = new Int32Array(L * N);
  const ownInset = new Float32Array(L * N);
  padCells.forEach((cells, i) => {
    const p = pads[i]!;
    for (const s of cells) {
      const c = s % N;
      const x = (c % W) * G;
      const y = Math.floor(c / W) * G;
      const inset = p.shape === 'round' ? -roundPadDist(p, x, y) : Math.min(p.w / 2 - Math.abs(x - p.x), p.h / 2 - Math.abs(y - p.y));
      if (ownCopper[s] !== padNet[i] || inset > ownInset[s]!) ownInset[s] = inset;
      ownCopper[s] = padNet[i]!;
    }
  });
  // which pad each pad cell belongs to (index + 1)
  const padOf = new Int32Array(L * N);
  padCells.forEach((cells, i) => {
    for (const s of cells) padOf[s] = i + 1;
  });
  // an escape's end: the length of its stub (grid steps)
  const stubCost = new Map<number, number>();
  escapes.forEach((e, idx) => {
    if (!e) return;
    const p = pads[idx]!;
    stubCost.set(e.state, (Math.hypot(e.p1.x - p.x, e.p1.y - p.y) + Math.hypot(e.ex - e.p1.x, e.ey - e.p1.y)) / G);
  });
  /** The cost (grid steps) of the piece from a pad cell (or escape end) to its pad centre that commit adds. */
  const toCentre = (st: number) => {
    const stub = stubCost.get(st);
    if (stub !== undefined) return stub;
    const t = padOf[st]!;
    if (!t) return 0;
    const p = pads[t - 1]!;
    const i = st % N;
    const dx = Math.abs((i % W) * G - p.x) / G;
    const dy = Math.abs(Math.floor(i / W) * G - p.y) / G;
    const m = Math.min(dx, dy);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * m + (m > 1e-6 && Math.abs(dx - dy) > 1e-6 ? TURN_COST : 0);
  };
  escapes.forEach((e, idx) => e && padCells[idx]!.push(e.state));
  const escapeOf = new Map(escapes.flatMap((e, idx) => (e ? [[e.state, idx] as const] : [])));
  // reserve every escape stub for its net before routing, so earlier routes cannot wall it off
  escapes.forEach((e, idx) => {
    if (!e) return;
    const p = pads[idx]!;
    stampSeg(e.l, padNet[idx]!, p.x, p.y, e.p1.x, e.p1.y, rules.track);
    stampSeg(e.l, padNet[idx]!, e.p1.x, e.p1.y, e.ex, e.ey, rules.track);
    ownCopper[e.state] = padNet[idx]!;
  });

  /*
   * Where a track's copper would touch one of its net's own pads without lying wholly on it: the
   * pad that it touches. A track there should run through the pad centre (straight along the pad
   * or diagonally at it), not half over the pad's edge.
   */
  const touch = (searching ? [0, 1] : []).map((k) => {
    const out = new Int32Array(L * N);
    const r = widths[k]! / 2;
    pads.forEach((p, idx) => {
      if (!p.netId) return;
      const d = padDist(p);
      const onLayers = p.drill ? layers.map((_, l) => l) : p.layers.map((l) => layerIdx.get(l)!).filter((l) => l !== undefined);
      for (let j = Math.max(0, Math.floor((p.y - p.h / 2 - r) / G)); j <= Math.min(H - 1, Math.ceil((p.y + p.h / 2 + r) / G)); j++) {
        for (let i = Math.max(0, Math.floor((p.x - p.w / 2 - r) / G)); i <= Math.min(W - 1, Math.ceil((p.x + p.w / 2 + r) / G)); i++) {
          const dist = d(i * G, j * G);
          if (dist > -r && dist < r) for (const l of onLayers) out[l * N + j * W + i] = idx + 1;
        }
      }
    });
    return out;
  });
  /*
   * Between neighbouring pins of an IC a track runs down the middle of the gap: cells in the gap
   * cost more the farther they are off its middle line.
   */
  const offMiddle = new Float32Array(L * N);
  // the gaps (vertical: pins stacked along y, so the gap runs along x), for recentring in straighten
  const gaps: { vertical: boolean; mid: number; x0: number; x1: number; y0: number; y1: number; layers: number[] }[] = [];
  for (const part of searching ? input.parts : []) {
    if (part.pads.length <= 3) continue;
    for (const a of part.pads) {
      for (const vertical of [false, true]) {
        // a's nearest neighbour after it in its row (along x) or column (along y)
        let c: BoardPad | undefined;
        for (const q of part.pads) {
          if (q.w !== a.w || q.h !== a.h || Math.abs(vertical ? q.x - a.x : q.y - a.y) > 1e-6) continue;
          const d = vertical ? q.y - a.y : q.x - a.x;
          if (d > 1e-6 && (!c || d < (vertical ? c.y - a.y : c.x - a.x))) c = q;
        }
        if (!c) continue;
        const size = vertical ? a.h : a.w;
        const gap = (vertical ? c.y - a.y : c.x - a.x) - size;
        if (gap <= 0 || gap > 2) continue;
        const mid = vertical ? (a.y + c.y) / 2 : (a.x + c.x) / 2;
        // the gap: between the two pads, as long as the pads are
        const [x0, x1, y0, y1] = vertical ? [a.x - a.w / 2, a.x + a.w / 2, a.y + a.h / 2, c.y - c.h / 2] : [a.x + a.w / 2, c.x - c.w / 2, a.y - a.h / 2, a.y + a.h / 2];
        const onLayers = a.drill ? layers.map((_, l) => l) : a.layers.map((l) => layerIdx.get(l)!).filter((l) => l !== undefined);
        gaps.push({ vertical, mid, x0, x1, y0, y1, layers: onLayers });
        for (let j = Math.max(0, Math.ceil(y0 / G)); j <= Math.min(H - 1, Math.floor(y1 / G)); j++) {
          for (let i = Math.max(0, Math.ceil(x0 / G)); i <= Math.min(W - 1, Math.floor(x1 / G)); i++) {
            const v = (CENTRE_COST * Math.abs((vertical ? j : i) * G - mid)) / G;
            for (const l of onLayers) offMiddle[l * N + j * W + i] = Math.max(offMiddle[l * N + j * W + i]!, v);
          }
        }
      }
    }
  }

  /*
   * Split planes. A signal track on an outer layer runs over the inner layer next to it (F.Cu over
   * In1.Cu, B.Cu over In2.Cu), its return current in that plane right under it. Where an area
   * plane's edge splits that layer, a track crossing it makes the return current detour round the
   * gap: steps along the edge cost signal nets more (crossing it about as much as two vias), so
   * they cross on the other side of the board, over an unbroken plane, where they can.
   */
  const splitCost = L === 4 && (input.planes ?? []).some((pl) => pl.area) ? new Float32Array(L * N) : null;
  if (splitCost) {
    for (const [l, ref] of [[0, 1], [3, 2]] as const) {
      for (const pl of input.planes ?? []) {
        if (!pl.area || pl.layer !== layers[ref]) continue;
        const [x0, y0, x1, y1] = pl.area;
        const band = Math.max(pl.style?.gap ?? rules.clearance, rules.clearance) / 2 + SPLIT_BAND;
        for (let j = Math.max(0, Math.floor((y0 - band) / G)); j <= Math.min(H - 1, Math.ceil((y1 + band) / G)); j++) {
          for (let i = Math.max(0, Math.floor((x0 - band) / G)); i <= Math.min(W - 1, Math.ceil((x1 + band) / G)); i++) {
            const [px, py] = [i * G, j * G];
            const inside = px > x0 && px < x1 && py > y0 && py < y1;
            const d = inside ? Math.min(px - x0, x1 - px, py - y0, y1 - py) : Math.hypot(Math.max(x0 - px, 0, px - x1), Math.max(y0 - py, 0, py - y1));
            if (d <= band) splitCost[l * N + j * W + i] = SPLIT_COST;
          }
        }
      }
    }
  }
  /** Nets that pay for crossing a split: signals (supplies and ground are DC, drawn wide). */
  let signalNums: Set<number> | null = null;
  const pays = (net: number) => (signalNums ??= new Set([...netNum].filter(([id]) => !input.powerNets.has(id)).map(([, n]) => n))).has(net);

  /** A step in direction (dx, dy) onto cell i of layer l runs half over an own pad, off its centre line. */
  const clips = (net: number, k: number, l: number, i: number, dx: number, dy: number) => {
    const t = k < 2 ? touch[k]![l * N + i]! : 0;
    if (!t || padNet[t - 1] !== net) return false;
    const p = pads[t - 1]!;
    const off = Math.abs((p.x - (i % W) * G) * dy - (p.y - Math.floor(i / W) * G) * dx) / Math.hypot(dx, dy);
    // across a pad's long side a track may meet it anywhere along it; along the pad (or into a
    // squarish one, or diagonally) only on its centre line (within the grid's rounding)
    const r = widths[k]! / 2;
    const alongSide = (dy === 0 && p.h > p.w * 1.2) || (dx === 0 && p.w > p.h * 1.2);
    const slack = alongSide ? Math.max(p.w, p.h) / 2 - r + 0.08 : dx !== 0 && dy !== 0 ? 0.1 : 0.08;
    return off > slack;
  };
  /**
   * A track end on this state would sit off its pad's centre line (at a corner or along an edge):
   * it is fine wholly on the pad, or on the long centre line of an elongated pad (either centre
   * line of a squarish one).
   */
  const offCentre = (net: number, k: number, st: number) => {
    const t = k < 2 ? touch[k]![st]! : 0;
    if (!t || padNet[t - 1] !== net) return false;
    const p = pads[t - 1]!;
    const i = st % N;
    const r = widths[k]! / 2;
    const dx = Math.abs((i % W) * G - p.x);
    const dy = Math.abs(Math.floor(i / W) * G - p.y);
    if (p.shape !== 'round' && Math.min(p.w / 2 - dx, p.h / 2 - dy) >= r - 0.01) return false;
    const onVertical = dx <= Math.max(0, p.w / 2 - r) + 0.08;
    const onHorizontal = dy <= Math.max(0, p.h / 2 - r) + 0.08;
    return !(p.h > p.w * 1.2 ? onVertical : p.w > p.h * 1.2 ? onHorizontal : onVertical || onHorizontal);
  };

  // union-find over pads
  const parent = pads.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  // copper of each connected group (pad cells + track cells), keyed by root
  const groupCells = new Map<number, number[]>();
  pads.forEach((_, i) => groupCells.set(i, [...padCells[i]!]));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    parent[rb] = ra;
    groupCells.set(ra, [...groupCells.get(ra)!, ...groupCells.get(rb)!]);
    groupCells.delete(rb);
  };

  const tracks: Track[] = [];
  const vias: Via[] = [];
  const failed: Conn[] = [];
  /*
   * The fixed vias placed on purpose belong to the pad they lie in (thermal vias: the exposed pad
   * reaches every layer through them, and tracks may start there); such a pad and its vias are
   * joined to the planes solid, without reliefs (they are there to carry heat or current).
   */
  const solidPads = new Set<number>();
  for (const v of input.vias?.fixed ?? []) {
    vias.push(v);
    const net = numOf(v.netId);
    const c = Math.min(W - 1, Math.max(0, Math.round(v.x / G))) + Math.min(H - 1, Math.max(0, Math.round(v.y / G))) * W;
    pads.forEach((p, idx) => {
      if (padNet[idx] !== net || padDist(p)(v.x, v.y) > 1e-6) return;
      for (let l = 0; l < L; l++) groupCells.get(find(idx))!.push(l * N + c);
      if (v.inPad) solidPads.add(idx);
    });
  }
  // a pad's drop vias and their stubs (add_vias drop) are its copper: it reaches every layer through them
  for (const r of input.vias?.drops ?? []) {
    const idx = pads.findIndex((p, q) => owner[q]!.componentId === r.componentId && p.number === r.number);
    if (idx < 0) continue;
    const cells = groupCells.get(find(idx))!;
    for (const v of r.vias) {
      const c = Math.min(W - 1, Math.max(0, Math.round(v.x / G))) + Math.min(H - 1, Math.max(0, Math.round(v.y / G))) * W;
      for (let l = 0; l < L; l++) cells.push(l * N + c);
      const t = (input.vias?.stubs ?? []).find((t) => t.netId === pads[idx]!.netId && t.pts[2] === v.x && t.pts[3] === v.y);
      const l = t && layerIdx.get(t.layer);
      if (!t || l === undefined) continue;
      tracks.push(t);
      cells.push(...copperCells(l, t.pts, t.width));
    }
  }

  // the kept copper: its tracks and vias, each piece joining its pads (as copper just routed does)
  // (drawn copper joining no pad is only in the way)
  for (const pc of kept?.pieces ?? []) {
    if (!pc.pads.length) {
      for (const i of pc.tracks) tracks.push(kept!.tracks[i]!);
      for (const i of pc.vias) vias.push(kept!.vias[i]!);
      continue;
    }
    for (let q = 1; q < pc.pads.length; q++) union(pc.pads[0]!, pc.pads[q]!);
    const cells = groupCells.get(find(pc.pads[0]!))!;
    for (const i of pc.tracks) {
      const t = kept!.tracks[i]!;
      tracks.push(t);
      cells.push(...copperCells(layerIdx.get(t.layer)!, t.pts, t.width));
    }
    for (const i of pc.vias) {
      const v = kept!.vias[i]!;
      vias.push(v);
      const c = Math.min(W - 1, Math.max(0, Math.round(v.x / G))) + Math.min(H - 1, Math.max(0, Math.round(v.y / G))) * W;
      for (let l = 0; l < L; l++) cells.push(l * N + c);
    }
  }

  return { input, pads, order, deadline, planeOnly, early, history, style, kept, progress, rules, layers, W, H, N, L, layerIdx, netNum, numOf, padNet, widths, trackClass, searching, stitching, maps, CW, CH, CN, crow, ccol, coarseOf, padDist, stampSeg, viaAt, viaNear, VIA_SPACING, stampVia, copperCells, addVia, cornerR, shaped, inside, fixedMap, keptTracks, keptVias, padCells, escapes, ownCopper, ownInset, toCentre, escapeOf, touch, offMiddle, gaps, splitCost, pays, clips, offCentre, find, groupCells, union, tracks, vias, failed, solidPads };
}

export type PassGrid = ReturnType<typeof passGrid>;
