/**
 * Autorouter: a maze router (A*) on a fine grid across all copper layers, 8 directions (45°
 * tracks) plus vias. Clearance is built into the grid: for every track-width class a map says,
 * per cell and layer, which net may put a track centre there (computed from exact distances
 * to pads, tracks, vias and the board edge). Connections follow each net's minimum spanning
 * tree, shortest first; a connection may end on any copper already joined to its net.
 * Routing aims at every connection: a pass that leaves some open is followed by another
 * (negotiated congestion, as in PathFinder). Each open connection is probed with the other nets'
 * tracks passable at a price; where its way would run, the copper of other nets gets dearer for
 * every later pass (a history cost that only grows), so the nets in its way learn to go round,
 * and it is routed first. The probe also says what blocks it. When those passes stop gaining,
 * grid passes follow (horizontal on F.Cu, vertical on B.Cu, vias cheap; see Style): a board
 * routed to the last connection matters more than tidy tracks or few vias. The best pass wins.
 */
import { boardPolygon, cutoutBounds, cutoutDistance, insideBoard, padCapsule, roundPadDist, type DrawnStatus, type LockedStatus, type PlaneStyle, type BoardCutout, type BoardPad, type BoardPart, type BoardRules, type CopperLayer, type Track, type Via, type Zone, type ZoneShape, type RouteBlockage } from '@4k7/schema';
import { keptCopper, type KeptCopper } from './keep.ts';
import { segDist, segSegDist } from './segments.ts';

const G = 0.1; // grid pitch, mm
const MULTI = -1; // near copper of two nets: nobody may route here
const EDGE = -2; // too close to the board edge
const TURN_COST = 0.6;
/**
 * How a pass routes. free: 45° tracks anywhere, vias dear (2.5 mm of track each), a light
 * preference for horizontal on F.Cu and vertical on B.Cu: a tidy board. grid: each outer layer
 * keeps to its direction and vias are cheap, the classic two-layer autorouter way; it is not
 * pretty, but it gets nearly anything through. Free passes first; when they stop gaining with
 * connections still open, grid passes follow, and the pass with the fewest open wins.
 */
interface Style {
  via: number; // in grid steps
  offAxis: number; // per step against the layer's direction
}
const FREE: Style = { via: 25, offAxis: 0.15 };
const GRID: Style = { via: 3, offAxis: 1 };
/** Free passes without a gain (or this share of the budget) before the grid passes take over. */
const FREE_STALE = 2;
const FREE_SHARE = 0.4;
const CENTRE_COST = 0.5; // per step and grid step off the middle of the gap between two IC pins
const NECK_COST = 2; // a step where the track narrows to a neck (see neckAt), in grid steps
const NECK_MIN = 5; // shortest stretch at the full width between two necks, in grid steps
const NECK_REACH = 1; // a neck zone: this far round a pad (mm), or twice the track's width if more
const CLIP_COST = 3; // a step whose copper runs half over one of the net's own pads, off its centre line
const SPLIT_COST = 8; // per step on the band along a split plane's edge (signal nets), in grid steps
const SPLIT_BAND = 0.3; // the band: this far either side of the gap, mm
const COARSE = 5; // coarse routing grid, in grid steps (0.5 mm)
const CORRIDOR = 4; // coarse cells either side of the coarse way (2 mm)
const MAX_STUB = 30; // longest drop stub reserved for a pour, in grid steps (3 mm)
const PROBE_PENALTY = 12; // probe: entering another net's copper, in grid steps
const HISTORY_STEP = 2; // history cost added where an open connection's probe runs, per pass
const STALE_PASSES = 8; // passes in a row without an improvement before the router gives up
const PROBE_BUDGET_MS = 1500; // probes of one pass, in total
const KEEP_ROUNDS = 1; // incremental routing: passes that let go of kept nets in the way, before routing from scratch

export interface RouteInput {
  outline: { w: number; h: number };
  layers: CopperLayer[];
  rules: BoardRules;
  parts: BoardPart[];
  /** Nets drawn with power width when their pads allow it. */
  powerNets: Set<string>;
  /** Track width per net (the user's choice, mm), where its pads allow it; else the class width. */
  netWidths?: Record<string, number>;
  /**
   * Planes: an inner layer dedicated to one net (no tracks there), or a pour on an outer layer
   * filling what the tracks leave. Pads of the net drop onto their plane with a via. An inner
   * plane with an area (x0, y0, x1, y1) covers only that part of its layer, and the layer's full
   * plane goes round it: the net's pads inside the area drop onto it, the others get tracks.
   */
  planes?: Plane[];
  /**
   * Vias placed on purpose (add_vias): `fixed` are copper from the start (thermal vias in a pad,
   * vias at given spots), `fill` are spots for stitching vias and ties, laid after the routing in
   * order where a via fits and joins its net's copper on two layers or more (planes; for a tie also
   * a track or pad of the net the via lies on), at most `limits` of a group. `drops`: pads that
   * drop onto their plane through vias the agent placed (add_vias drop; among `fixed`), each
   * joined to its pad by one of `stubs` (every other pad gets one via of the router's).
   */
  vias?: { fixed: Via[]; fill: Via[]; limits?: Record<string, number>; drops?: { group: string; componentId: string; number: string; vias: { x: number; y: number }[] }[]; stubs?: Track[] };
  /**
   * Copper of the routing before (incremental routing): what still holds for this board (see
   * keep.ts) is kept as it lies, and only the connections it leaves open are routed. Where it is
   * in the way of one of those, the nets in the way are routed again, and failing that the whole
   * board.
   */
  keep?: { tracks: Track[]; vias: Via[] };
  /**
   * Copper the agent locked (lock_copper): what still holds for this board (as for `keep`, see
   * keep.ts) is laid as it lies before anything else, and no rip-up clears it.
   */
  locked?: { tracks: Track[]; vias: Via[] };
  /**
   * Connections laid as the agent asked (the track op), before anything else is routed: pad
   * `from` to pad `to` (indices into all parts' pads in order) through `points`, at `width` (else
   * the net's), on `layer` from the start and on a point's layer from that point (a via there);
   * no layer: the router's choice. Copper no rip-up clears. One that finds no way is not laid
   * (RouteResult.drawn says why) and its connection is routed as any other.
   */
  drawn?: { id: string; netId: string; from: number; to: number; width?: number; layer?: CopperLayer; points: { x: number; y: number; layer?: CopperLayer }[] }[];
  /** Stop routing after this many milliseconds; what is left is reported unrouted. Default 90 s. */
  budgetMs?: number;
  /** Called while routing: the copper laid so far in the current pass, a few times a second. */
  onProgress?: (p: RouteProgress) => void;
  /**
   * Called with the best result so far: nothing routed before the first pass, then after every
   * pass that improves on it. What a user who stops the routing keeps.
   */
  onBest?: (r: RouteResult) => void;
  /** Rounded board corners (radius) and milled cutouts: no copper within the edge clearance. */
  cornerRadius?: number;
  cutouts?: BoardCutout[];
  /** A free-form outline (closed polygon): no copper outside it or within the edge clearance. */
  shape?: number[];
}

export interface RouteResult {
  tracks: Track[];
  vias: Via[];
  zones: Zone[];
  /** Pairs of pads (by index into the flat pad list) that ended up connected. */
  connected: (netId: string, a: BoardPad, b: BoardPad) => boolean;
  failed: ({ netId: string; a: BoardPad; b: BoardPad } & Blockage)[];
  netsTotal: number;
  netsDone: number;
  /** Routing stopped at the time budget. */
  timedOut: boolean;
  /** Passes run (each routes the whole board again). */
  passes: number;
  /** Per pad (all parts' pads in order): the group of pads its copper joins (equal: connected). */
  groups: number[];
  /** Copper taken over from RouteInput.keep, as it lies in the result. */
  reused?: { tracks: number; vias: number };
  /** Per RouteInput.drawn: laid as asked, or why not. */
  drawn?: DrawnStatus[];
  /** Per net with RouteInput.locked copper: how much of it still holds (and is laid). */
  locked?: LockedStatus[];
}

/** Why a connection stayed open: what its way would have to cross (see probe in routeOnce). */
type Blockage = RouteBlockage;

export interface RouteProgress {
  /** 1-based. */
  pass: number;
  /** Copper of the pass so far. */
  tracks: Track[];
  vias: Via[];
  /** Connections to route (minimum spanning tree edges of all nets) and how many this pass has done. */
  connections: number;
  done: number;
  /** Fewest connections left open by a finished pass so far (null in the first pass). */
  bestOpen: number | null;
  elapsedMs: number;
  /** The pass routes on the grid (see Style): each outer layer one direction, vias cheap. */
  grid: boolean;
}

type Plane = { netId: string; layer: CopperLayer; area?: [number, number, number, number]; style?: PlaneStyle };

/** A pad's centre inside an area plane's rectangle. */
const inArea = (pl: Plane, p: BoardPad) => !!pl.area && p.x >= pl.area[0] && p.x <= pl.area[2] && p.y >= pl.area[1] && p.y <= pl.area[3];

interface Conn {
  netId: string;
  a: number;
  b: number;
  len: number;
}


export function route(input: RouteInput, passes = 40): RouteResult {
  const pads: BoardPad[] = input.parts.flatMap((p) => p.pads);
  const owner = input.parts.flatMap((p) => p.pads.map(() => p));
  const conns = connections(pads);
  let best: ReturnType<typeof routeOnce> | null = null;
  // nets with a dedicated (inner) plane are connected through it, not with tracks; so are two
  // pads of a net inside the same area plane of it (its other pads get tracks)
  const dedicated = new Set((input.planes ?? []).filter((pl) => !OUTER.has(pl.layer) && !pl.area).map((pl) => pl.netId));
  const areas = (input.planes ?? []).filter((pl) => !OUTER.has(pl.layer) && pl.area);
  const viaArea = (c: Conn) => areas.some((pl) => pl.netId === c.netId && inArea(pl, pads[c.a]!) && inArea(pl, pads[c.b]!));
  const planeOnly = conns.filter((c) => dedicated.has(c.netId) || viaArea(c));
  const throughPlane = new Set(planeOnly);
  const firstOrder = conns.filter((c) => !throughPlane.has(c)).sort((x, y) => x.len - y.len || x.netId.localeCompare(y.netId) || x.a - y.a);
  let order = firstOrder;
  const t0 = now();
  const deadline = t0 + (input.budgetMs ?? 90_000);
  // the history cost (see routeOnce), kept from pass to pass
  const history = new Float32Array(input.layers.length * (Math.ceil(input.outline.w / G) + 1) * (Math.ceil(input.outline.h / G) + 1));
  let stale = 0;
  let ran = 0;
  let style = FREE;
  // nets poured on an outer layer and without an inner plane (see routeOnce): on a tie, the pass
  // that leaves fewer of their connections open wins (one open pad of a pour is the worse defect)
  const pourNets = new Set((input.planes ?? []).filter((pl) => OUTER.has(pl.layer) && !pl.area && !dedicated.has(pl.netId)).map((pl) => pl.netId));
  const pourOpen = (x: { failed: Conn[] }) => x.failed.filter((c) => pourNets.has(c.netId)).length;
  // the connections that failed in the pass before (a pour's net routes them with the signals)
  let early = new Set<Conn>();
  /*
   * Incremental routing: the copper of the routing before that still holds is kept, except that
   * of the nets let go. A pass that leaves connections open lets go of the kept nets in their way
   * (the probe names them), once; after that, or when none is named, the board is routed
   * from scratch (letting go net by net can go on for many passes, each naming the next).
   */
  const keep = input.keep ? keptCopper(input, input.keep) : null;
  // the copper the agent locked, as far as it still holds (never let go)
  const locked = input.locked ? keptCopper(input, input.locked) : null;
  const keptNets = new Set(keep?.pieces.map((pc) => pc.netId));
  const letGo = new Set<string>();
  let keeping = keptNets.size > 0;
  let rounds = 0;
  // fewest open since routing from scratch began (the kept passes' best does not count against it)
  let phaseBest: number | null = null;
  const keptNow = (): KeptCopper | null => (keep && keeping ? { ...keep, pieces: keep.pieces.filter((pc) => !letGo.has(pc.netId)) } : null);
  // before the first pass the best there is: nothing routed
  input.onBest?.(result({ tracks: [], vias: [], zones: [], failed: [...order, ...planeOnly], roots: Int32Array.from(pads, (_, i) => i), timedOut: false, blockage: new Map(), reused: undefined, drawn: [] }, 0));
  for (let pass = 0; pass < passes; pass++) {
    const bestOpen = best ? best.failed.length : null;
    const progress = input.onProgress ? (tracks: Track[], vias: Via[], done: number) => input.onProgress!({ pass: pass + 1, tracks, vias, connections: conns.length, done, bestOpen, elapsedMs: now() - t0, grid: style === GRID }) : undefined;
    const r = routeOnce(input, pads, owner, order, deadline, planeOnly, early, history, style, keptNow(), locked, progress);
    ran++;
    // each pass's copper, so even a quick pass shows (the next one starts from nothing)
    progress?.(r.tracks, r.vias, conns.length - r.failed.length);
    // (a pass that lays more of the agent's tracks as asked is better whatever else it leaves open)
    const missing = (x: { drawn: DrawnStatus[] }) => x.drawn.filter((t) => !t.laid).length;
    const improved = !best || missing(r) < missing(best) || (missing(r) === missing(best) && (r.failed.length < best.failed.length || (r.failed.length === best.failed.length && pourOpen(r) < pourOpen(best))));
    if (improved) {
      best = r;
      if (r.failed.length) input.onBest?.(result(r, ran));
    }
    if (keeping && missing(r) && !r.timedOut) {
      // a track the agent laid that found no way round the kept copper: route from scratch
      keeping = false;
      stale = 0;
      phaseBest = null;
      history.fill(0);
      order = firstOrder;
      early = new Set();
      continue;
    }
    if (!r.failed.length || r.timedOut) break;
    // every open connection closed off by pads, keep-outs or the edge alone: no pass can help
    if (r.failed.every((c) => r.blockage.get(c)?.enclosed)) break;
    // passes without an improvement: the history costs grow with each, so the nets in the way
    // are pushed harder every time; after a few, more will not help
    const gained = phaseBest === null || r.failed.length < phaseBest;
    if (gained) phaseBest = r.failed.length;
    stale = improved || gained ? 0 : stale + 1;
    let afresh = false;
    if (keeping) {
      // the kept nets in the way of an open connection are routed again with it
      const inWay = new Set(r.failed.flatMap((c) => r.blockage.get(c)?.blockedBy ?? []).filter((n) => keptNets.has(n) && !letGo.has(n)));
      if (inWay.size && rounds < KEEP_ROUNDS) {
        for (const n of inWay) letGo.add(n);
        rounds++;
        stale = 0;
      } else {
        // route the whole board, as if nothing had been routed before (what the kept passes
        // taught about congestion was learnt round copper that is gone now)
        keeping = false;
        stale = 0;
        phaseBest = null;
        history.fill(0);
        afresh = true;
      }
    } else if (style === FREE && (stale >= FREE_STALE || now() - t0 > FREE_SHARE * (deadline - t0)) && input.layers.length > 1) {
      // the tidy way is stuck: route on the grid, from a clean slate (what the free passes taught
      // about congestion does not hold for tracks that run another way)
      style = GRID;
      stale = 0;
      history.fill(0);
    } else if (stale >= STALE_PASSES) break;
    // another pass only if one fits in the budget
    if (now() + (now() - t0) / (pass + 1) > deadline) break;
    if (afresh) {
      order = firstOrder;
      early = new Set();
      continue;
    }
    // failures first, the rest in the order they had (the history costs, not a shuffled order,
    // make the room: a new order every pass undoes what the costs taught)
    const failed = new Set(r.failed);
    early = failed;
    order = [...order.filter((c) => failed.has(c)), ...order.filter((c) => !failed.has(c))];
  }
  return result(best ?? routeOnce(input, pads, owner, order, deadline, planeOnly, new Set(), history, style, keptNow(), locked), ran);

  /** Per net with locked copper: how much there is, and how much of it holds. */
  function lockedStatus(): LockedStatus[] {
    const nets = [...new Set([...input.locked!.tracks, ...input.locked!.vias].map((x) => x.netId))].sort();
    const held = locked!.pieces;
    return nets.map((netId) => ({
      netId,
      tracks: input.locked!.tracks.filter((t) => t.netId === netId).length,
      vias: input.locked!.vias.filter((v) => v.netId === netId).length,
      heldTracks: held.filter((pc) => pc.netId === netId).reduce((n, pc) => n + pc.tracks.length, 0),
      heldVias: held.filter((pc) => pc.netId === netId).reduce((n, pc) => n + pc.vias.length, 0),
    }));
  }

  /** A pass's result as the caller sees it. */
  function result(r: ReturnType<typeof routeOnce>, ran: number): RouteResult {
    const nets = new Set(conns.map((c) => c.netId));
    const failedNets = new Set(r.failed.map((c) => c.netId));
    return {
      tracks: r.tracks,
      vias: r.vias,
      zones: r.zones,
      connected: (netId, a, b) => {
        const ia = pads.indexOf(a);
        const ib = pads.indexOf(b);
        return ia >= 0 && ib >= 0 && r.roots[ia] === r.roots[ib] && pads[ia]!.netId === netId;
      },
      failed: r.failed.map((c) => ({ netId: c.netId, a: pads[c.a]!, b: pads[c.b]!, ...r.blockage.get(c) })),
      netsTotal: nets.size,
      netsDone: [...nets].filter((n) => !failedNets.has(n)).length,
      timedOut: r.timedOut,
      passes: ran,
      groups: Array.from(r.roots),
      ...(r.reused ? { reused: r.reused } : {}),
      ...(r.drawn.length ? { drawn: r.drawn } : {}),
      ...(input.locked ? { locked: lockedStatus() } : {}),
    };
  }
}

/** Minimum spanning tree edges per net (by pad centre distance). */
function connections(pads: BoardPad[]): Conn[] {
  const byNet = new Map<string, number[]>();
  pads.forEach((p, i) => p.netId && byNet.set(p.netId, [...(byNet.get(p.netId) ?? []), i]));
  const out: Conn[] = [];
  for (const [netId, idx] of byNet) {
    if (idx.length < 2) continue;
    const done = new Set([idx[0]!]);
    const dist = new Map(idx.map((i) => [i, Math.hypot(pads[i]!.x - pads[idx[0]!]!.x, pads[i]!.y - pads[idx[0]!]!.y)]));
    const from = new Map(idx.map((i) => [i, idx[0]!]));
    while (done.size < idx.length) {
      let best = -1;
      for (const i of idx) if (!done.has(i) && (best < 0 || dist.get(i)! < dist.get(best)!)) best = i;
      done.add(best);
      out.push({ netId, a: from.get(best)!, b: best, len: dist.get(best)! });
      for (const i of idx) {
        if (done.has(i)) continue;
        const d = Math.hypot(pads[i]!.x - pads[best]!.x, pads[i]!.y - pads[best]!.y);
        if (d < dist.get(i)!) {
          dist.set(i, d);
          from.set(i, best);
        }
      }
    }
  }
  return out;
}

function routeOnce(
  input: RouteInput,
  pads: BoardPad[],
  owner: BoardPart[],
  order: Conn[],
  deadline: number,
  planeOnly: Conn[],
  early: Set<Conn>,
  /** Cost of entering each state (layer × grid point), grown where open connections wanted to go. */
  history: Float32Array,
  style: Style,
  /** Copper kept from the routing before (see RouteInput.keep), there from the start. */
  kept: KeptCopper | null,
  /** Copper the agent locked that still holds (see RouteInput.locked): there from the start, never cleared. */
  locked: KeptCopper | null,
  progress?: (tracks: Track[], vias: Via[], done: number) => void,
) {
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
  for (const w of [...Object.values(input.netWidths ?? {}), ...(input.drawn ?? []).map((t) => t.width ?? 0)]) if (w > 0 && trackClass(w) < 0) widths.push(w);
  const maps = widths.map(() => Array.from({ length: L }, () => new Int32Array(N)));

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
    for (let k = 0; k < widths.length; k++) {
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
  const segDist = (ax: number, ay: number, bx: number, by: number) => (x: number, y: number) => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
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
  for (let k = 0; k < widths.length; k++) {
    const keep = rules.edgeClearance + widths[k]! / 2;
    for (let l = 0; l < L; l++) {
      const m = maps[k]![l]!;
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          const x = i * G;
          const y = j * G;
          if (x < keep || y < keep || x > input.outline.w - keep || y > input.outline.h - keep) m[j * W + i] = EDGE;
          else if (shaped && inside(x, y) < keep) m[j * W + i] = EDGE;
        }
      }
      for (const c of input.cutouts ?? []) {
        const [x0, y0, x1, y1] = cutoutBounds(c);
        for (let j = Math.max(0, Math.floor((y0 - keep) / G)); j <= Math.min(H - 1, Math.ceil((y1 + keep) / G)); j++) {
          for (let i = Math.max(0, Math.floor((x0 - keep) / G)); i <= Math.min(W - 1, Math.ceil((x1 + keep) / G)); i++) if (cutoutDistance(c, i * G, j * G) < keep) m[j * W + i] = EDGE;
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
    for (let k = 0; k < widths.length; k++) if (k !== 2) maps[k]![l]!.fill(EDGE);
  }
  // the signal map with pads, keep-outs and the edge only: what no rip-up can clear (for the probe)
  const fixedMap = maps[0]!.map((m) => m.slice());
  // the copper the agent locked: there in every pass and never let go, but after fixedMap, so the
  // probe names its net as in the way (not a pad or the edge)
  const lockedTracks = locked ? locked.pieces.flatMap((pc) => pc.tracks.map((i) => locked.tracks[i]!)) : [];
  const lockedVias = locked ? locked.pieces.flatMap((pc) => pc.vias.map((i) => locked.vias[i]!)) : [];
  for (const t of lockedTracks) {
    const l = layerIdx.get(t.layer)!;
    for (let q = 0; q + 3 < t.pts.length; q += 2) stampSeg(l, numOf(t.netId), t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!, t.width);
  }
  for (const v of lockedVias) stampVia(numOf(v.netId), v.x, v.y, v.pad);
  // the copper kept from the routing before: after fixedMap (a later pass may route its nets
  // again), before the escapes (they keep clear of it)
  const keptTracks = kept ? kept.pieces.flatMap((pc) => pc.tracks.map((i) => kept.tracks[i]!)) : [];
  const keptVias = kept ? kept.pieces.flatMap((pc) => pc.vias.map((i) => kept.vias[i]!)) : [];
  for (const t of keptTracks) {
    const l = layerIdx.get(t.layer)!;
    for (let q = 0; q + 3 < t.pts.length; q += 2) stampSeg(l, numOf(t.netId), t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!, t.width);
  }
  for (const v of keptVias) stampVia(numOf(v.netId), v.x, v.y, v.pad);
  /** Segments of a net (width w, on layer l) keep the clearance from the kept and locked copper of other nets. */
  const heldTracks = [...lockedTracks, ...keptTracks];
  const heldVias = [...lockedVias, ...keptVias];
  const clearOfKept = (netId: string, l: number, w: number, segs: [number, number, number, number][]) =>
    segs.every(([ax, ay, bx, by]) =>
      heldTracks.every((t) => t.netId === netId || t.layer !== layers[l] || pieceList(t.pts).every(([cx, cy, dx, dy]) => segSegDist(ax, ay, bx, by, cx, cy, dx, dy) >= rules.clearance + (w + t.width) / 2 - 1e-3)) &&
      heldVias.every((v) => v.netId === netId || segDist(ax, ay, bx, by)(v.x, v.y) >= rules.clearance + (w + v.pad) / 2 - 1e-3),
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
  const touch = [0, 1].map((k) => {
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
  for (const part of input.parts) {
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

  // the locked and the kept copper: its tracks and vias, each piece joining its pads (as copper just routed does)
  for (const [held, tag] of [[locked, true], [kept, false]] as const) {
    for (const pc of held?.pieces ?? []) {
      for (let q = 1; q < pc.pads.length; q++) union(pc.pads[0]!, pc.pads[q]!);
      const cells = groupCells.get(find(pc.pads[0]!))!;
      for (const i of pc.tracks) {
        const t = held!.tracks[i]!;
        tracks.push(tag ? { ...t, locked: true } : t);
        cells.push(...copperCells(layerIdx.get(t.layer)!, t.pts, t.width));
      }
      for (const i of pc.vias) {
        const v = held!.vias[i]!;
        vias.push(tag ? { ...v, locked: true } : v);
        const c = Math.min(W - 1, Math.max(0, Math.round(v.x / G))) + Math.min(H - 1, Math.max(0, Math.round(v.y / G))) * W;
        for (let l = 0; l < L; l++) cells.push(l * N + c);
      }
    }
  }

  // where searches stop: the deadline (with a pour, the signals stop a little earlier)
  let until = deadline;
  // A* buffers
  const S = L * N;
  const cost = new Float32Array(S);
  const from = new Int32Array(S);
  const dirOf = new Int8Array(S);
  const goal = new Int32Array(S);
  let epoch = 0;
  // cost[s] is valid only where seenAt[s] is the current search (no clearing of S cells per search)
  const seenAt = new Int32Array(S);
  let searchNo = 0;
  // the reachability flood (see search); its buffers only once a search needs one
  let floodAt: Int32Array | null = null;
  let floodQueue: Int32Array | null = null;
  // the corridors (coarse cells) searches keep to, by number (see widen)
  const corridorAt = new Int32Array(CN);
  let corridorNo = 0;
  // a search this long without a way found floods first (a flood costs about as much as S / 8
  // expansions of the search; most routable connections are found well before)
  const FLOOD_AFTER = Math.max(1 << 16, S >> 3);
  // 1 F.Cu (prefers horizontal steps), 2 B.Cu (vertical), 0 inner
  const layerKind = layers.map((l) => (l === 'F.Cu' ? 1 : l === 'B.Cu' ? 2 : 0));
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DY = [0, 1, 1, 1, 0, -1, -1, -1];
  const STEP = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

  const freeFor = (net: number, k: number) => (l: number, i: number) => {
    const v = maps[k]![l]![i]!;
    if (v === 0 || v === net) return true;
    // inside the net's own pad: only where the track stays on the pad (no copper sticking out)
    const st = l * N + i;
    return ownCopper[st] === net && ownInset[st]! >= widths[k]! / 2 - 0.01;
  };
  /*
   * Necks: a track wider than a pad it starts or ends on runs at its width and narrows only near
   * that pad. While a connection is routed (see routeConn), the grid points within reach of such
   * a pad are its neck zone (neckAt[i] === neckRun), each with the width class it may narrow to
   * there (neckK: the widest the pad takes). Where the track's own width does not fit, a neck
   * cell takes the narrow one; so does one where the wide copper would reach onto the pad
   * (neckOn: it would stick out of the pad). neckRun 0: no zone (every other search).
   */
  const neckAt = new Int32Array(N);
  const neckK = new Int8Array(N);
  const neckOn = new Uint8Array(N);
  let neckRun = 0;
  let neckNo = 0;
  // laying a track the agent asked for (see layDrawn): searches ignore the history costs
  let drawing = false;
  let noHistory: Float32Array | null = null;
  /** freeFor(net, k), or a neck cell where its narrow width fits. */
  const freeNeck = (net: number, k: number) => {
    const wide = freeFor(net, k);
    if (!neckRun) return wide;
    const r = neckRun;
    return (l: number, i: number) => wide(l, i) || (neckAt[i] === r && freeFor(net, neckK[i]!)(l, i));
  };
  /** The width class a track of class k takes at state st: its own, or the neck's where it does not fit. */
  const classAt = (net: number, k: number, st: number) => {
    const i = st % N;
    return neckRun && neckAt[i] === neckRun && (neckOn[i] || !freeFor(net, k)(Math.floor(st / N), i)) ? neckK[i]! : k;
  };
  /*
   * Via keep-out: no via overlapping any pad (its own net's included) or within the land pattern
   * of a small part (between a resistor's pads), unless the board allows vias in pads.
   */
  const viaBlocked = new Uint8Array(N);
  if (!rules.viaInPad) {
    const reach = rules.viaPad / 2 + rules.clearance;
    pads.forEach((p) => {
      const d = padDist(p);
      for (let j = Math.max(0, Math.floor((p.y - p.h / 2 - reach) / G)); j <= Math.min(H - 1, Math.ceil((p.y + p.h / 2 + reach) / G)); j++) {
        for (let i = Math.max(0, Math.floor((p.x - p.w / 2 - reach) / G)); i <= Math.min(W - 1, Math.ceil((p.x + p.w / 2 + reach) / G)); i++) if (d(i * G, j * G) < reach) viaBlocked[j * W + i] = 1;
      }
    });
    for (const part of input.parts) {
      if (part.pads.length > 3) continue; // under ICs vias are fine (and needed to fan out BGAs)
      // the whole via stays out of the land pattern (its ring too, not just its centre)
      const r = rules.viaPad / 2;
      const b = part.courtyard;
      for (let j = Math.max(0, Math.floor((b.y - r) / G)); j <= Math.min(H - 1, Math.ceil((b.y + b.h + r) / G)); j++) {
        for (let i = Math.max(0, Math.floor((b.x - r) / G)); i <= Math.min(W - 1, Math.ceil((b.x + b.w + r) / G)); i++) viaBlocked[j * W + i] = 1;
      }
    }
  }
  const viaFreeFor = (net: number) => (i: number) => {
    if (viaAt[i] === net) return true; // reuse an existing via of this net
    if (viaBlocked[i] || viaNear[i]) return false;
    for (let l = 0; l < L; l++) {
      const v = maps[2]![l]![i]!;
      if (v !== 0 && v !== net) return false;
    }
    return true;
  };

  /** Of a group's cells, those deepest inside their pad (within half a grid step). */
  const deepestCells = (cells: number[]) => {
    let m = -Infinity;
    for (const st of cells) m = Math.max(m, ownInset[st]!);
    return cells.filter((st) => ownInset[st]! >= m - G / 2 - 1e-6);
  };

  /**
   * A* from any start state to a goal state; returns the path (start → goal) or null. `corr`: only
   * within that corridor (a number from widen; 0: anywhere). `floodFirst`: check that a goal can
   * be reached at all before searching (for a connection that is probably impossible).
   * `within`: no way dearer than that.
   */
  /*
   * The estimate of the way left (A*): the distance to the target: a point, or the box round all
   * goal cells. With a group of copper as the goal, a point (one pad of it) would overestimate
   * the way to the group's nearer parts, and the search would run past them to that pad.
   */
  const search = (net: number, k: number, starts: number[], isGoal: (s: number) => boolean, target: { x: number; y: number } | { x0: number; y0: number; x1: number; y1: number }, accept?: (s: number) => boolean, corr = 0, floodFirst = false, within = Infinity, oneLayer = false): number[] | null => {
    // no new search once the time is up (its reachability flood alone can take a while)
    if (now() > until) return null;
    const free = freeNeck(net, k);
    // a track the agent laid: the same way every pass (no history costs, the free style)
    const hist = drawing ? (noHistory ??= new Float32Array(S)) : history;
    const sty = drawing ? FREE : style;
    const changes = L > 1 && !oneLayer; // may change layer (a via)
    const viaFree = viaFreeFor(net);
    const run = ++searchNo;
    const inPad = widths[k]! / 2 - 0.01;
    // a neck cell where the track's own width does not fit: the narrow width there (see neckAt)
    const nr = neckRun;
    const neckOk = (l: number, c: number) => nr !== 0 && neckAt[c] === nr && freeFor(net, neckK[c]!)(l, c);
    // a track wider than a via pad may not fit where a via does (its clearance reaches farther):
    // only then must a via's landing be checked for the track as well
    const wide = widths[k]! > rules.viaPad;
    const costOf = (st: number) => (seenAt[st] === run ? cost[st]! : Infinity);
    const split = splitCost && pays(net) ? splitCost : null;
    const heap = new Heap();
    const [bx0, by0, bx1, by1] = 'x0' in target ? [target.x0, target.y0, target.x1, target.y1] : [target.x / G, target.y / G, target.x / G, target.y / G];
    const h = (s: number) => {
      const i = s % N;
      const x = i % W;
      const y = Math.floor(i / W);
      const dx = Math.max(bx0 - x, 0, x - bx1);
      const dy = Math.max(by0 - y, 0, y - by1);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    // starts and goals only where this width fits; if none does (a track wider than its pad),
    // the cells deepest inside the pad: on its centre line, not at a corner
    const usable = (st: number) => free(Math.floor(st / N), st % N);
    const centred = (st: number) => usable(st) && !offCentre(net, classAt(net, k, st), st);
    const seeds = starts.filter(centred);
    if (!seeds.length) seeds.push(...starts.filter(usable));
    const from0 = seeds.length ? seeds : deepestCells(starts);
    const goalOk = (st: number) => isGoal(st) && (accept ? accept(st) : usable(st));
    /*
     * Can any goal be reached at all? A plain flood over the same steps as the search (it reaches
     * exactly what the search would, given time), far cheaper per cell than the search.
     * An unroutable connection would otherwise expand all the copper it can reach.
     */
    const reachable = () => {
      floodAt ??= new Int32Array(S);
      floodQueue ??= new Int32Array(S);
      const seen = floodAt;
      const queue = floodQueue;
      let head = 0;
      let tail = 0;
      for (const st of from0) {
        if (seen[st] === run) continue;
        seen[st] = run;
        queue[tail++] = st;
      }
      while (head < tail) {
        const st = queue[head++]!;
        if (goalOk(st)) return true;
        const l = Math.floor(st / N);
        const i = st - l * N;
        const x = i % W;
        const y = (i - x) / W;
        const m = maps[k]![l]!;
        const lo = l * N;
        const ok = (c: number) => {
          const v = m[c]!;
          return v === 0 || v === net || (ownCopper[lo + c] === net && ownInset[lo + c]! >= inPad) || neckOk(l, c);
        };
        for (let d = 0; d < 8; d++) {
          const dx = DX[d]!;
          const dy = DY[d]!;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = ny * W + nx;
          const ns = lo + ni;
          if (seen[ns] === run || (!ok(ni) && !isGoal(ns))) continue;
          if (dx !== 0 && dy !== 0 && (!ok(y * W + nx) || !ok(ny * W + x))) continue;
          seen[ns] = run;
          queue[tail++] = ns;
        }
        if (changes && viaFree(i)) {
          for (let l2 = 0; l2 < L; l2++) {
            const ns = l2 * N + i;
            if (seen[ns] === run || (wide && !free(l2, i) && !isGoal(ns))) continue;
            seen[ns] = run;
            queue[tail++] = ns;
          }
        }
      }
      return false;
    };
    // a start on a pad pays for the piece from the pad centre, so tracks leave near the centre
    for (const s of from0) {
      seenAt[s] = run;
      cost[s] = toCentre(s);
      from[s] = -1;
      dirOf[s] = -1;
      heap.push(s, cost[s]! + h(s));
    }
    let reached = -1;
    let best = Infinity; // the cheapest arrival so far, including the piece on to the pad centre
    let expanded = 0;
    // bounded per connection (turn costs allow some re-expansion); the overall time budget
    // protects big boards
    const LIMIT = S * 3;
    while (heap.size) {
      const s = heap.pop();
      if (heap.lastPrio >= best - 1e-6 || heap.lastPrio > within) break;
      // outdated entry: this state was reached more cheaply since it was pushed. (Costs are kept
      // as 32-bit floats and the priorities as 64-bit numbers: at a cost of a few hundred the
      // rounding alone is ~1e-4, so the tolerance must be above that; real differences are ≥ 0.05.)
      if (heap.lastPrio - h(s) > cost[s]! + 0.01) continue;
      if (goalOk(s) && cost[s]! + toCentre(s) < best) {
        best = cost[s]! + toCentre(s);
        reached = s;
      }
      if (++expanded > LIMIT) break;
      // a long search with no way found yet: give up if there is none
      // (in a corridor the search is small anyway, and the flood would cover the whole board)
      if (expanded === (floodFirst ? 1 : FLOOD_AFTER) && reached < 0 && !corr && !reachable()) break;
      if ((expanded & 4095) === 0 && now() > until) break;
      const l = Math.floor(s / N);
      const i = s % N;
      // copper of the net where this width does not fit (a goal: thinner copper, e.g. a drop to a
      // pour): a way may end there, not run on along it (its copper would reach beyond the thin one)
      if (from[s]! >= 0 && ownCopper[s] !== net && maps[k]![l]![i] !== 0 && maps[k]![l]![i] !== net && !neckOk(l, i)) continue;
      const x = i % W;
      const y = (i - x) / W;
      const base = cost[s]!;
      const dir = dirOf[s]!;
      // free(l, ·) for this layer, inlined (the hottest test of the search)
      const m = maps[k]![l]!;
      const lo = l * N;
      const wideOk = (c: number) => {
        const v = m[c]!;
        return v === 0 || v === net || (ownCopper[lo + c] === net && ownInset[lo + c]! >= inPad);
      };
      const ok = (c: number) => wideOk(c) || neckOk(l, c);
      const kind = layerKind[l]!;
      const tch = k < 2 ? touch[k]! : null;
      for (let d = 0; d < 8; d++) {
        const dx = DX[d]!;
        const dy = DY[d]!;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (corr && corridorAt[crow[ny]! + ccol[nx]!] !== corr) continue;
        const ns = lo + ni;
        if (!ok(ni) && !isGoal(ns)) continue;
        // diagonal steps: both orthogonal neighbours must be clear too (no corner cutting)
        if (dx !== 0 && dy !== 0 && (!ok(y * W + nx) || !ok(ny * W + x))) continue;
        const off = kind === 1 ? dy !== 0 : kind === 2 ? dx !== 0 : false;
        const nc = base + STEP[d]! + (nr !== 0 && !wideOk(ni) ? NECK_COST : 0) + (dir >= 0 && dir !== d ? TURN_COST : 0) + (off ? sty.offAxis : 0) + (tch !== null && tch[ns] !== 0 && clips(net, k, l, ni, dx, dy) ? CLIP_COST : 0) + offMiddle[ns]! + (split !== null ? split[ns]! : 0) + hist[ns]!;
        if (nc < costOf(ns)) {
          seenAt[ns] = run;
          cost[ns] = nc;
          from[ns] = s;
          dirOf[ns] = d;
          heap.push(ns, nc + h(ns));
        }
      }
      if (changes && viaFree(i)) {
        for (let l2 = 0; l2 < L; l2++) {
          if (l2 === l) continue;
          const ns = l2 * N + i;
          // the track goes on from the via: it must fit there too (see wide)
          if (wide && !free(l2, i) && !isGoal(ns)) continue;
          const nc = base + sty.via + hist[ns]!;
          if (nc < costOf(ns)) {
            seenAt[ns] = run;
            cost[ns] = nc;
            from[ns] = s;
            dirOf[ns] = -1;
            heap.push(ns, nc + h(ns));
          }
        }
      }
    }
    if (reached < 0) {
      return null;
    }
    const path: number[] = [];
    for (let s = reached; s >= 0; s = from[s]!) path.push(s);
    return path.reverse();
  };

  /*
   * Coarse routing (global routing): an A* over coarse cells finds roughly where a connection can
   * go, and the fine search then keeps within a corridor round that way (left to itself, most of
   * its work goes into states far from where the track ends up). A step between two coarse cells
   * is open where a track can cross their boundary: grid points on both sides of it open for the
   * net (free, or a start or goal), side by side; the fewer such lanes, the dearer. A diagonal
   * step is open where one of its two detours through a neighbour is. A via fits in a cell where
   * it fits on any of its grid points. Every fine path crossing a boundary needs such a lane (a
   * diagonal step needs both its orthogonal neighbours free), so with no coarse way there is no
   * fine one either. Like the fine search, the way pays for the piece from a pad cell to the pad
   * centre at both ends (else it would aim at pad corners and escape ends). The starts are marked
   * in goal[] with the negated stamp. Returns the way (coarse cells), or null if there is none
   * (or the time is up).
   */
  const ccost = new Float64Array(L * CN);
  const cfrom = new Int32Array(L * CN);
  const cseen = new Int32Array(L * CN);
  const cgoal = new Int32Array(L * CN);
  const cend = new Float64Array(L * CN); // the cheapest piece on to a pad centre, per goal state
  const viaSeen = new Int32Array(CN);
  const viaFits = new Uint8Array(CN);
  let coarseNo = 0;
  const corridor = (net: number, k: number, starts: number[], goals: number[], goalStamp: number): number[] | null => {
    const run = ++coarseNo;
    for (const st of starts) if (goal[st] !== goalStamp) goal[st] = -goalStamp;
    const mk = maps[k]!;
    const inPad = widths[k]! / 2 - 0.01;
    /** freeFor(net, k), or a start or goal. */
    const open = (l: number, i: number) => {
      const v = mk[l]![i]!;
      if (v === 0 || v === net) return true;
      const st = l * N + i;
      return (ownCopper[st] === net && ownInset[st]! >= inPad) || goal[st] === goalStamp || goal[st] === -goalStamp || (neckRun !== 0 && neckAt[i] === neckRun && freeFor(net, neckK[i]!)(l, i));
    };
    const viaFree = viaFreeFor(net);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const st of goals) {
      const c = coarseOf(st % N);
      const cs = Math.floor(st / N) * CN + c;
      const e = toCentre(st);
      if (cgoal[cs] !== run || e < cend[cs]!) cend[cs] = e;
      cgoal[cs] = run;
      const x = c % CW;
      const y = (c - x) / CW;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    /** Lanes across the boundary between cell (x, y) and its neighbour (x + dx, y + dy), dx or dy 0. */
    const lanes = (l: number, x: number, y: number, dx: number, dy: number) => {
      let n = 0;
      // the last grid points of this cell and the first of the next, side by side
      if (dx) {
        const ia = dx > 0 ? x * COARSE + COARSE - 1 : x * COARSE;
        const ib = ia + dx; // (on the board: the neighbour cell is)
        for (let ja = y * COARSE; ja < Math.min(H, y * COARSE + COARSE); ja++) if (open(l, ja * W + ia) && open(l, ja * W + ib)) n++;
      } else {
        const ja = dy > 0 ? y * COARSE + COARSE - 1 : y * COARSE;
        const jb = ja + dy;
        for (let ia = x * COARSE; ia < Math.min(W, x * COARSE + COARSE); ia++) if (open(l, ja * W + ia) && open(l, jb * W + ia)) n++;
      }
      return n;
    };
    const viaIn = (c: number) => {
      if (viaSeen[c] !== run) {
        viaSeen[c] = run;
        viaFits[c] = 0;
        const x = c % CW;
        const y = (c - x) / CW;
        for (let j = y * COARSE; j < Math.min(H, y * COARSE + COARSE) && !viaFits[c]; j++) {
          for (let i = x * COARSE; i < Math.min(W, x * COARSE + COARSE); i++) {
            if (viaFree(j * W + i)) {
              viaFits[c] = 1;
              break;
            }
          }
        }
      }
      return viaFits[c] === 1;
    };
    // (the distance to the box round the goal cells)
    const h = (c: number) => {
      const x = c % CW;
      const y = (c - x) / CW;
      const dx = Math.max(x0 - x, 0, x - x1);
      const dy = Math.max(y0 - y, 0, y - y1);
      return COARSE * (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy));
    };
    const heap = new Heap();
    for (const st of starts) {
      const cs = Math.floor(st / N) * CN + coarseOf(st % N);
      const c0 = toCentre(st);
      if (cseen[cs] === run && ccost[cs]! <= c0) continue;
      cseen[cs] = run;
      ccost[cs] = c0;
      cfrom[cs] = -1;
      heap.push(cs, c0 + h(cs % CN));
    }
    let reached = -1;
    let best = Infinity; // the cheapest arrival so far, including the piece on to the pad centre
    let pops = 0;
    while (heap.size) {
      const s = heap.pop();
      if (heap.lastPrio >= best) break;
      if ((++pops & 4095) === 0 && now() > until) return null;
      const l = Math.floor(s / CN);
      const c = s - l * CN;
      if (heap.lastPrio - h(c) > ccost[s]! + 1e-9) continue;
      if (cgoal[s] === run && ccost[s]! + cend[s]! < best) {
        best = ccost[s]! + cend[s]!;
        reached = s;
      }
      const x = c % CW;
      const y = (c - x) / CW;
      const kind = layerKind[l]!;
      for (let d = 0; d < 8; d++) {
        const dx = DX[d]!;
        const dy = DY[d]!;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= CW || ny >= CH) continue;
        const ncell = ny * CW + nx;
        const ns = l * CN + ncell;
        // (a step costs at least COARSE: no use counting lanes into a cell already that cheap)
        if (cseen[ns] === run && ccost[ns]! <= ccost[s]! + COARSE) continue;
        const n = dx && dy ? Math.max(Math.min(lanes(l, x, y, dx, 0), lanes(l, nx, y, 0, dy)), Math.min(lanes(l, x, y, 0, dy), lanes(l, x, ny, dx, 0))) : lanes(l, x, y, dx, dy);
        if (!n) continue;
        const off = kind === 1 ? dy !== 0 : kind === 2 ? dx !== 0 : false;
        const ncost = ccost[s]! + COARSE * (STEP[d]! * (2 - n / COARSE) + (off ? style.offAxis : 0));
        if (cseen[ns] !== run || ncost < ccost[ns]!) {
          cseen[ns] = run;
          ccost[ns] = ncost;
          cfrom[ns] = s;
          heap.push(ns, ncost + h(ncell));
        }
      }
      if (L < 2) continue;
      let gain = false; // (a via only where it can make another layer cheaper)
      for (let l2 = 0; l2 < L && !gain; l2++) if (l2 !== l && (cseen[l2 * CN + c] !== run || ccost[s]! + style.via < ccost[l2 * CN + c]!)) gain = true;
      if (!gain || !viaIn(c)) continue;
      for (let l2 = 0; l2 < L; l2++) {
        if (l2 === l) continue;
        const ns = l2 * CN + c;
        const ncost = ccost[s]! + style.via;
        if (cseen[ns] !== run || ncost < ccost[ns]!) {
          cseen[ns] = run;
          ccost[ns] = ncost;
          cfrom[ns] = s;
          heap.push(ns, ncost + h(c));
        }
      }
    }
    if (reached < 0) return null;
    const way: number[] = [];
    for (let s = reached; s >= 0; s = cfrom[s]!) way.push(s % CN);
    return way;
  };
  /** Mark a corridor: the coarse cells within r of the way. Returns its number (for search). */
  const widen = (way: number[], r: number): number => {
    const no = ++corridorNo;
    for (const c of way) {
      const x = c % CW;
      const y = (c - x) / CW;
      for (let j = Math.max(0, y - r); j <= Math.min(CH - 1, y + r); j++) for (let i = Math.max(0, x - r); i <= Math.min(CW - 1, x + r); i++) corridorAt[j * CW + i] = no;
    }
    return no;
  };

  /** Turn a path into tracks and vias, reserve its copper; pad ends start/stop at pad centres. */
  /**
   * Straighten a run of grid cells on one layer into long 0/45/90° pieces (the maze path zigzags
   * when the direction is not octilinear): from each vertex, jump to the farthest cell that one
   * straight piece plus one diagonal piece (either order) reaches through free cells. Returns the
   * vertices and every cell the straightened track covers.
   */
  const straighten = (l: number, cells: number[], free: (l: number, i: number) => boolean, clip: (l: number, i: number, dx: number, dy: number) => boolean) => {
    // in the gaps between IC pins the pieces keep to the maze path (it found the gap's middle)
    const onPath = new Set(cells);
    const walk = (a: number, b: number, out: number[]): boolean => {
      let x = a % W;
      let y = (a - x) / W;
      const bx = b % W;
      const by = (b - bx) / W;
      const sx = Math.sign(bx - x);
      const sy = Math.sign(by - y);
      while (x !== bx || y !== by) {
        const nx = x + sx;
        const ny = y + sy;
        if (!free(l, ny * W + nx) || clip(l, ny * W + nx, sx, sy) || (offMiddle[l * N + ny * W + nx]! > 0.05 && !onPath.has(ny * W + nx))) return false;
        if (sx && sy && (!free(l, y * W + nx) || !free(l, ny * W + x))) return false;
        x = nx;
        y = ny;
        out.push(y * W + x);
      }
      return true;
    };
    const octo = (a: number, b: number): { corner: number; cells: number[] } | null => {
      const ax = a % W;
      const ay = (a - ax) / W;
      const dx = (b % W) - ax;
      const dy = (b - (b % W)) / W - ay;
      const m = Math.min(Math.abs(dx), Math.abs(dy));
      const diagFirst = (ay + Math.sign(dy) * m) * W + ax + Math.sign(dx) * m;
      const straightFirst = (ay + dy - Math.sign(dy) * m) * W + ax + dx - Math.sign(dx) * m;
      for (const corner of [diagFirst, straightFirst]) {
        const out: number[] = [];
        if (walk(a, corner, out) && walk(corner, b, out)) return { corner, cells: out };
      }
      return null;
    };
    const verts = [cells[0]!];
    const covered = [cells[0]!];
    for (let i = 0; i < cells.length - 1; ) {
      let next = i + 1;
      let piece: { corner: number; cells: number[] } | null = null;
      for (let j = Math.min(cells.length - 1, i + 250); j > i + 1; j--) {
        piece = octo(cells[i]!, cells[j]!);
        if (piece) {
          next = j;
          break;
        }
      }
      if (piece) {
        if (piece.corner !== cells[i] && piece.corner !== cells[next]) verts.push(piece.corner);
        covered.push(...piece.cells);
      } else covered.push(cells[next]!); // the maze step itself (it was legal when found)
      verts.push(cells[next]!);
      i = next;
    }
    if (!recentre(l, verts, free, clip)) return { verts, covered };
    // pieces moved: the copper they cover now
    const moved = [verts[0]!];
    for (let q = 0; q + 1 < verts.length; q++) {
      let x = verts[q]! % W;
      let y = (verts[q]! - x) / W;
      const bx = verts[q + 1]! % W;
      const by = (verts[q + 1]! - bx) / W;
      while (x !== bx || y !== by) {
        x += Math.sign(bx - x);
        y += Math.sign(by - y);
        moved.push(y * W + x);
      }
    }
    return { verts, covered: moved };
  };

  /*
   * A piece running through the gap between two IC pins moves onto the gap's middle row (or
   * column), if the copper fits there. Its neighbours keep their directions: they get longer or
   * shorter along their own line, so everything stays 0/45/90°.
   */
  const recentre = (l: number, verts: number[], free: (l: number, i: number) => boolean, clip: (l: number, i: number, dx: number, dy: number) => boolean) => {
    let changed = false;
    const xy = (c: number) => [c % W, (c - (c % W)) / W] as const;
    for (let q = 1; q + 2 < verts.length; q++) {
      const [ax, ay] = xy(verts[q]!);
      const [bx, by] = xy(verts[q + 1]!);
      const horizontal = ay === by;
      if (!horizontal && ax !== bx) continue;
      const gap = gaps.find((g) => {
        if (g.vertical !== horizontal || !g.layers.includes(l)) return false;
        const across = (horizontal ? ay : ax) * G;
        const [lo, hi] = horizontal ? [g.y0, g.y1] : [g.x0, g.x1];
        const [s0, s1] = horizontal ? [Math.min(ax, bx) * G, Math.max(ax, bx) * G] : [Math.min(ay, by) * G, Math.max(ay, by) * G];
        const [r0, r1] = horizontal ? [g.x0, g.x1] : [g.y0, g.y1];
        return across > lo && across < hi && Math.min(s1, r1) - Math.max(s0, r0) >= 0.2;
      });
      if (!gap) continue;
      const shift = Math.round(gap.mid / G) - (horizontal ? ay : ax);
      if (!shift) continue;
      // each end slides along its other piece onto the new row / column
      const slide = (c: number, other: number): number | null => {
        const [cx, cy] = xy(c);
        const [ox, oy] = xy(other);
        const dx = Math.sign(cx - ox);
        const dy = Math.sign(cy - oy);
        const along = horizontal ? dy : dx; // how the other piece advances across the gap
        if (!along) return null;
        const t = shift / along; // steps to move along the other piece (negative: shorten it)
        const nx = cx + dx * t;
        const ny = cy + dy * t;
        // the other piece must keep a positive length
        if ((nx - ox) * dx + (ny - oy) * dy <= 0 && (dx || dy)) return null;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) return null;
        return ny * W + nx;
      };
      const na = slide(verts[q]!, verts[q - 1]!);
      const nb = slide(verts[q + 1]!, verts[q + 2]!);
      if (na === null || nb === null) continue;
      // the three new pieces must be clear
      const ok = (a: number, b: number) => {
        let [x, y] = xy(a);
        const [tx, ty] = xy(b);
        const sx = Math.sign(tx - x);
        const sy = Math.sign(ty - y);
        while (x !== tx || y !== ty) {
          const nx = x + sx;
          const ny = y + sy;
          if (!free(l, ny * W + nx) || clip(l, ny * W + nx, sx, sy)) return false;
          if (sx && sy && (!free(l, y * W + nx) || !free(l, ny * W + x))) return false;
          x = nx;
          y = ny;
        }
        return true;
      };
      if (!ok(verts[q - 1]!, na) || !ok(na, nb) || !ok(nb, verts[q + 2]!)) continue;
      verts[q] = na;
      verts[q + 1] = nb;
      changed = true;
    }
    return changed;
  };

  /**
   * Turn a path into tracks and vias, reserve its copper; returns the cells the copper covers.
   * The path is laid in runs, one per layer and width: a neck (see neckAt) is a run of its own,
   * meeting the wider run beside it on that run's last grid point (the narrow track fits wherever
   * the wide one does). `pins`: grid points the track must turn at as they are (the points of a
   * track the agent laid): a run ends there and the next begins, so straightening cannot cut them.
   */
  const commit = (netId: string, net: number, k: number, path: number[], startPad: number, endPad: number, endVia = false, pins?: Set<number>): number[] => {
    const runs: { l: number; k: number; cells: number[] }[] = [];
    for (const s of path) {
      const l = Math.floor(s / N);
      const ks = classAt(net, k, s);
      const run = runs.at(-1);
      if (!run || run.l !== l || run.k !== ks) runs.push({ l, k: ks, cells: [s % N] });
      else run.cells.push(s % N);
    }
    // a short stretch at the full width between two necks on one layer: narrow too (no stubs of
    // wide track a few grid steps long)
    for (let ri = 1; ri + 1 < runs.length; ri++) {
      const [a, b, c] = [runs[ri - 1]!, runs[ri]!, runs[ri + 1]!];
      if (b.k === k && a.k !== k && a.k === c.k && a.l === b.l && c.l === b.l && b.cells.length < NECK_MIN) {
        a.cells.push(...b.cells, ...c.cells);
        runs.splice(ri, 2);
        ri--;
      }
    }
    if (pins?.size) {
      for (let ri = 0; ri < runs.length; ri++) {
        const run = runs[ri]!;
        const at = run.cells.findIndex((c, q) => q > 0 && pins.has(c));
        if (at < 0) continue;
        runs.splice(ri + 1, 0, { l: run.l, k: run.k, cells: run.cells.slice(at) });
        run.cells = run.cells.slice(0, at);
      }
    }
    // runs of one layer meet: the narrower one goes on to the wider one's grid point beside it
    // (at a pin, of one width, the first goes on to the pin)
    for (let ri = 1; ri < runs.length; ri++) {
      const [a, b] = [runs[ri - 1]!, runs[ri]!];
      if (a.l !== b.l) continue;
      if (widths[b.k]! < widths[a.k]!) b.cells.unshift(a.cells.at(-1)!);
      else a.cells.push(b.cells[0]!);
    }
    // a path starting or ending inside a pad runs on to (from) the pad's centre cell, so the
    // straightening can aim its last piece at the pad centre (not at some cell off to the side)
    const toward = (from: number, to: number) => {
      const out: number[] = [];
      let x = from % W;
      let y = (from - x) / W;
      const tx = to % W;
      const ty = (to - tx) / W;
      while (x !== tx || y !== ty) {
        x += Math.sign(tx - x);
        y += Math.sign(ty - y);
        out.push(y * W + x);
      }
      return out;
    };
    const centreCell = (p: BoardPad) => Math.round(p.y / G) * W + Math.round(p.x / G);
    const startsInPad = startPad >= 0 && !(escapes[startPad]?.state === path[0]) && padCells[startPad]!.includes(path[0]!);
    const endsInPad = endPad >= 0 && !(escapes[endPad]?.state === path.at(-1)) && padCells[endPad]!.includes(path.at(-1)!);
    if (startsInPad && runs[0]) runs[0].cells = [...toward(runs[0].cells[0]!, centreCell(pads[startPad]!)).reverse(), runs[0].cells[0]!, ...runs[0].cells.slice(1)].filter((c, i, a) => i === 0 || c !== a[i - 1]);
    if (endsInPad && runs.at(-1)) {
      const run = runs.at(-1)!;
      run.cells = [...run.cells, ...toward(run.cells.at(-1)!, centreCell(pads[endPad]!))];
    }
    if (startsInPad && runs[0]) {
      // (the cells toward the centre were listed from the path outwards: put the centre first)
      const c0 = centreCell(pads[startPad]!);
      const i0 = runs[0].cells.indexOf(c0);
      if (i0 > 0) runs[0].cells = [...runs[0].cells.slice(0, i0 + 1).reverse(), ...runs[0].cells.slice(i0 + 1)];
    }
    const covered: number[] = [];
    const lines = runs.map((run, ri) => {
      const free = freeFor(net, run.k);
      const clip = (l: number, i: number, dx: number, dy: number) => clips(net, run.k, l, i, dx, dy);
      let { verts, covered: cov } = straighten(run.l, run.cells, free, clip);
      // again on the result, until it stops improving: a spike in the maze path (up and back
      // down) is cut off once the pieces before and after it can see each other
      for (let again = 0; again < 3; again++) {
        const next = straighten(run.l, cov, free, clip);
        if (next.verts.length >= verts.length) break;
        ({ verts, covered: cov } = next);
      }
      for (const c of cov) covered.push(run.l * N + c);
      const pts = verts.flatMap((c) => [(c % W) * G, Math.floor(c / W) * G]);
      if (ri > 0 && runs[ri - 1]!.l !== run.l) addVia(netId, net, pts[0]!, pts[1]!);
      // (ends meeting the run before or after on this layer: those stay where they are)
      return { l: run.l, width: widths[run.k]!, pts, joinsBefore: ri > 0 && runs[ri - 1]!.l === run.l, joinsAfter: ri + 1 < runs.length && runs[ri + 1]!.l === run.l };
    });
    /** pts adjusted at one end, unless that moved an end where the line meets the next run on its layer. */
    const keepJoins = (line: (typeof lines)[number], pts: number[]) => {
      const same = (q: number, r: number) => Math.abs(pts[q]! - line.pts[r]!) < 1e-9 && Math.abs(pts[q + 1]! - line.pts[r + 1]!) < 1e-9;
      return (!line.joinsBefore || same(0, 0)) && (!line.joinsAfter || same(pts.length - 2, line.pts.length - 2)) ? pts : line.pts;
    };
    if (startPad >= 0 && lines[0]) {
      const sp = pads[startPad]!;
      const se = escapes[startPad];
      const pts = lines[0].pts;
      pts.unshift(...(se && se.state === path[0] ? [sp.x, sp.y, se.p1.x, se.p1.y] : [sp.x, sp.y, ...entryBend(pts[0]!, pts[1]!, sp, lines[0].width)]));
    }
    const last = lines.at(-1)!;
    if (endPad >= 0) {
      const ep = pads[endPad]!;
      const ee = escapes[endPad];
      const pts = last.pts;
      pts.push(...(ee && ee.state === path.at(-1) ? [ee.p1.x, ee.p1.y] : entryBend(pts.at(-2)!, pts.at(-1)!, ep, last.width)), ep.x, ep.y);
    }
    let dropVia: Via | undefined;
    if (endVia) {
      // a drop to a plane: the via at the end of the path
      const i = path.at(-1)! % N;
      const before = vias.length;
      addVia(netId, net, (i % W) * G, Math.floor(i / W) * G);
      if (vias.length > before) dropVia = vias.at(-1);
    }
    // exactly onto the pads' centre lines (the grid only gets within half a step)
    for (const line of lines) line.pts = simplify(line.pts);
    const first = lines[0];
    if (startPad >= 0 && first) first.pts = keepJoins(first, reversePts(alignEnd(reversePts(first.pts), pads[startPad]!, first.l, net, first.width, lines.length === 1 ? dropVia : undefined)));
    if (endPad >= 0) last.pts = keepJoins(last, alignEnd(last.pts, pads[endPad]!, last.l, net, last.width));
    // an end on a track of the net (a join): exactly onto that track's centre line
    if (startPad < 0 && first && !(lines.length === 1 && endVia)) first.pts = keepJoins(first, reversePts(joinTrack(reversePts(first.pts), first.l, net, first.width)));
    if (endPad < 0 && !endVia) last.pts = keepJoins(last, joinTrack(last.pts, last.l, net, last.width));
    for (const line of lines) line.pts = dejog(simplify(line.pts), line.l, net, line.width);
    // lines meeting on one layer at one width (at a pin) are one track
    for (let li = lines.length - 1; li > 0; li--) {
      const [a, b] = [lines[li - 1]!, lines[li]!];
      if (!a.joinsAfter || a.width !== b.width) continue;
      a.pts = [...a.pts, ...b.pts.slice(2)];
      a.joinsAfter = b.joinsAfter;
      lines.splice(li, 1);
    }
    // the copper as it finally lies (aligned ends moved it): the cells later routes may join
    const onCopper = new Set<number>();
    for (const line of lines) {
      const pts = simplify(line.pts);
      if (pts.length < 4) continue;
      tracks.push({ netId, layer: layers[line.l]!, width: line.width, pts: pts.map(r3) });
      for (let q = 0; q + 3 < pts.length; q += 2) stampSeg(line.l, net, pts[q]!, pts[q + 1]!, pts[q + 2]!, pts[q + 3]!, line.width);
      for (const st of copperCells(line.l, pts, line.width)) onCopper.add(st);
    }
    return onCopper.size ? [...onCopper] : covered;
  };
  /*
   * The run into a pad (pts ends at the pad centre), moved so that its line goes exactly through
   * the pad centre: grid rows rarely hit a pad's centre line, so a track would run in slightly
   * off-centre (or a diagonal aim past the centre). The run keeps its direction; the piece before
   * it slides along its own direction to meet it (angles stay). If the run starts at a via made
   * for this track (a drop to a plane), the via moves with it. Made only if the copper keeps its
   * clearance from everything of other nets (checked exactly).
   */
  const alignEnd = (pts: number[], p: BoardPad, l: number, net: number, width: number, via?: Via): number[] => {
    const n = pts.length / 2;
    const px = pts[2 * n - 2]!;
    const py = pts[2 * n - 1]!;
    const outside = (x: number, y: number) => Math.abs(x - p.x) > p.w / 2 + 1e-9 || Math.abs(y - p.y) > p.h / 2 + 1e-9;
    for (let j = n - 2; j >= 1; j--) {
      // the run [A, B] = points j-1, j: the last one starting outside the pad
      const ax = pts[2 * j - 2]!;
      const ay = pts[2 * j - 1]!;
      const bx = pts[2 * j]!;
      const by = pts[2 * j + 1]!;
      if (!outside(ax, ay)) continue;
      const ux = sgn(bx - ax);
      const uy = sgn(by - ay);
      if (ux === 0 && uy === 0) return pts;
      // across a pad's long side it may meet the pad anywhere: nothing to align
      if ((uy === 0 && p.h > p.w * 1.2) || (ux === 0 && p.w > p.h * 1.2)) return pts;
      const ul = Math.hypot(ux, uy);
      const off = ((px - ax) * uy - (py - ay) * ux) / ul; // signed distance of the centre from the run's line
      if (Math.abs(off) > 0.3 || (px - ax) * ux + (py - ay) * uy <= 0) return pts;
      if (Math.abs(off) < 1e-6) return [...pts.slice(0, 2 * j), px, py]; // on the line: straight in
      let nax: number;
      let nay: number;
      if (j >= 2) {
        // slide A along [Z, A] onto the line through the centre (direction u); an escape stub's
        // sub-grid jog before A is dropped: then A slides along the stub itself
        let zi = j - 2;
        let zx = pts[2 * zi]!;
        let zy = pts[2 * zi + 1]!;
        const octilinear = (dx: number, dy: number) => Math.abs(dx) < 1e-9 || Math.abs(dy) < 1e-9 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-9;
        let vx = ax - zx;
        let vy = ay - zy;
        if (!octilinear(vx, vy) && zi >= 1) {
          const yx = pts[2 * zi - 2]!;
          const yy = pts[2 * zi - 1]!;
          vx = zx - yx;
          vy = zy - yy;
          zi--;
          zx = yx;
          zy = yy;
        }
        vx = sgn(vx);
        vy = sgn(vy);
        const det = uy * vx - ux * vy;
        if (Math.abs(det) < 1e-9) return pts; // [Z, A] parallel to the run
        const t = ((px - zx) * uy - (py - zy) * ux) / det;
        if (t <= 1e-6) return pts; // [Z, A] would turn back
        nax = zx + vx * t;
        nay = zy + vy * t;
        // the corner must not end up half over the pad's edge (the piece before turns off there),
        // nor on or next to another pad of the net (the turn would leave that pad across its edge)
        if (padDist(p)(nax, nay) < width / 2 - 0.08) return pts;
        const layer0 = layers[l]!;
        if (pads.some((o, q) => o !== p && padNet[q] === net && (o.drill || o.layers.includes(layer0)) && padDist(o)(nax, nay) < width / 2 + 0.05)) return pts;
        if (!clearOf(net, l, width, [[zx, zy, nax, nay], [nax, nay, px, py]])) return pts;
        return [...pts.slice(0, 2 * zi + 2), nax, nay, px, py];
      }
      // A is the track's other end. On a pad of the net (its centre): a short step inside that
      // pad onto the line through this pad's centre, then straight in
      const layer = layers[l]!;
      const q = pads.findIndex((o, qi) => padNet[qi] === net && o !== p && Math.abs(o.x - ax) < 1e-6 && Math.abs(o.y - ay) < 1e-6 && (o.drill || o.layers.includes(layer)));
      if (q >= 0) {
        const o = pads[q]!;
        // only where the track may meet that pad anywhere (across its long side): its own entry
        // must not suffer
        if (!((uy === 0 && o.h > o.w * 1.2) || (ux === 0 && o.w > o.h * 1.2))) return pts;
        nax = ax + (off * uy) / ul;
        nay = ay - (off * ux) / ul;
        if (Math.abs(nax - o.x) <= o.w / 2 - width / 2 + 1e-6 && Math.abs(nay - o.y) <= o.h / 2 - width / 2 + 1e-6 && clearOf(net, l, width, [[nax, nay, px, py]])) return [ax, ay, nax, nay, px, py];
        return pts;
      }
      // on a via of the net: a step hidden under the via's ring onto the line, then straight in
      const atVia = vias.find((v) => numOf(v.netId) === net && Math.abs(v.x - ax) < 1e-6 && Math.abs(v.y - ay) < 1e-6);
      if (atVia && Math.abs(off) <= atVia.pad / 2 - width / 2) {
        nax = ax + (off * uy) / ul;
        nay = ay - (off * ux) / ul;
        if (clearOf(net, l, width, [[nax, nay, px, py]])) return [ax, ay, nax, nay, px, py];
      }
      // where it joins a track of the net, it slides along that track
      for (const t of tracks) {
        if (t.layer !== layer || numOf(t.netId) !== net) continue;
        for (let q = 0; q + 3 < t.pts.length; q += 2) {
          const [cx, cy, dx, dy] = [t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!];
          if (segDist(cx, cy, dx, dy)(ax, ay) > 1e-6) continue;
          const vx = sgn(dx - cx);
          const vy = sgn(dy - cy);
          const det = uy * vx - ux * vy;
          if (Math.abs(det) < 1e-9) continue;
          const s2 = ((px - ax) * uy - (py - ay) * ux) / det;
          nax = ax + vx * s2;
          nay = ay + vy * s2;
          // still on that piece of track
          if (segDist(cx, cy, dx, dy)(nax, nay) > 1e-6) continue;
          if (!clearOf(net, l, width, [[nax, nay, px, py]])) continue;
          return [nax, nay, px, py];
        }
      }
      // or it is this track's own new via (a drop to a plane): the via moves with it
      if (!via || Math.abs(via.x - ax) > 1e-6 || Math.abs(via.y - ay) > 1e-6) return pts;
      // (the foot of A on the line through the centre)
      nax = ax + (off * uy) / ul;
      nay = ay - (off * ux) / ul;
      if (!clearOf(net, l, width, [[nax, nay, px, py]])) return pts;
      for (let vl = 0; vl < L; vl++) if (!clearOf(net, vl, via.pad, [[nax, nay, nax, nay]])) return pts;
      via.x = r3(nax);
      via.y = r3(nay);
      stampVia(net, nax, nay);
      return [nax, nay, px, py];
    }
    return pts;
  };
  /*
   * A path that ends on a track of its net joins it somewhere inside its copper, which on a wide
   * track can be off its centre line: the last run slides on along its direction onto the centre
   * line (or, running alongside it, a short step across). Only with exact clearance, for the
   * copper that moves: this track's, at its width.
   */
  const joinTrack = (pts: number[], l: number, net: number, width: number): number[] => {
    const n = pts.length / 2;
    if (n < 2) return pts;
    const [px, py] = [pts[2 * n - 2]!, pts[2 * n - 1]!];
    const [ax, ay] = [pts[2 * n - 4]!, pts[2 * n - 3]!];
    const layer = layers[l]!;
    let best: { d: number; cx: number; cy: number; dx: number; dy: number; w: number } | null = null;
    for (const t of tracks) {
      if (t.layer !== layer || numOf(t.netId) !== net) continue;
      for (let q = 0; q + 3 < t.pts.length; q += 2) {
        const [cx, cy, ex, ey] = [t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!];
        const d = segDist(cx, cy, ex, ey)(px, py);
        if (d <= t.width / 2 + 1e-6 && (!best || d < best.d)) best = { d, cx, cy, dx: ex - cx, dy: ey - cy, w: t.width };
      }
    }
    if (!best || best.d < 1e-6) return pts; // not on a track, or already on its centre line
    const { cx, cy, dx, dy } = best;
    const ux = px - ax;
    const uy = py - ay;
    // where the run's line meets the track's centre line (t along the run beyond P, s on the track)
    const det = ux * dy - uy * dx;
    let q: [number, number] | null = null;
    if (Math.abs(det) > 1e-9) {
      const t = ((cx - px) * dy - (cy - py) * dx) / det;
      const s2 = ((cx - px) * uy - (cy - py) * ux) / det;
      if (t > -1e-9 && t * Math.hypot(ux, uy) <= best.w && s2 >= -1e-9 && s2 <= 1 + 1e-9) q = [px + ux * t, py + uy * t];
    }
    if (!q) {
      // alongside: the foot on the centre line
      const l2 = dx * dx + dy * dy;
      const s2 = l2 ? Math.max(0, Math.min(1, ((px - cx) * dx + (py - cy) * dy) / l2)) : 0;
      q = [cx + dx * s2, cy + dy * s2];
      if (!clearOf(net, l, width, [[px, py, q[0], q[1]]])) return pts;
      return [...pts, q[0], q[1]];
    }
    if (!clearOf(net, l, width, [[ax, ay, q[0], q[1]]])) return pts;
    return [...pts.slice(0, 2 * n - 2), q[0], q[1]];
  };

  /*
   * Small jogs: two parallel runs joined by a short step (under 0.3 mm), e.g. where the maze
   * lined a diagonal up with a pad centre. The corner before the first run slides along its own
   * direction until that run is on the line of the second, and the step is gone (angles stay).
   * Only with exact clearance; ends of the track stay where they are.
   */
  const dejog = (pts: number[], l: number, net: number, width: number): number[] => {
    let out = pts;
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      const n = out.length / 2;
      for (let i = 1; i + 2 < n; i++) {
        // runs: Z→A (before), A→B (first), B→C (the step), C→D (second)
        if (i < 2) continue;
        const P = (k: number) => [out[2 * k]!, out[2 * k + 1]!] as const;
        const [zx, zy] = P(i - 2);
        const [ax, ay] = P(i - 1);
        const [bx, by] = P(i);
        const [cx, cy] = P(i + 1);
        const [dx, dy] = P(i + 2);
        if (Math.hypot(cx - bx, cy - by) > 0.3) continue;
        const u = [sgn(bx - ax), sgn(by - ay)];
        const v = [sgn(dx - cx), sgn(dy - cy)];
        if (u[0] !== v[0] || u[1] !== v[1]) continue; // not parallel, same way
        // slide A along Z→A onto the line through C with direction u
        const w = [sgn(ax - zx), sgn(ay - zy)];
        const det = w[0]! * u[1]! - w[1]! * u[0]!;
        if (Math.abs(det) < 1e-9) continue;
        const t = ((cx - zx) * u[1]! - (cy - zy) * u[0]!) / det;
        const nx = zx + w[0]! * t;
        const ny = zy + w[1]! * t;
        // A' must stay on the Z side of D (the run A'→D keeps its direction)
        if (t <= 1e-6 || (dx - nx) * u[0]! + (dy - ny) * u[1]! <= 1e-6) continue;
        if (!clearOf(net, l, width, [[zx, zy, nx, ny], [nx, ny, dx, dy]])) continue;
        // nor half over a pad of the net (the step may have been there to line up with one)
        const layer = layers[l]!;
        const overPad = pads.some((p, q) => {
          if (padNet[q] !== net || (!p.drill && !p.layers.includes(layer))) return false;
          const d = padDist(p);
          for (let k = 0; k <= 10; k++) {
            const x = zx + ((nx - zx) * k) / 10;
            const y = zy + ((ny - zy) * k) / 10;
            const e = d(x, y);
            if (e > 0 && e < width / 2 - 0.02) return true; // touching from outside, not on it
          }
          // and the new corner not on or next to one (the turn would leave the pad across its edge)
          return d(nx, ny) < width / 2 + 0.05;
        });
        if (overPad) continue;
        out = [...out.slice(0, 2 * (i - 1)), nx, ny, ...out.slice(2 * (i + 2))];
        changed = true;
        break;
      }
      if (!changed) break;
    }
    return out;
  };

  /** The segments (of the given width, on layer l) keep the clearance from all copper of other nets. */
  // drop sites reserved for pours (see reserveDrops): pad → its drop path (pad → via site) and
  // width class, and the copper held for them (a via's on every layer: l = -1)
  const reserved = new Map<number, { path: number[]; k: number }>();
  const held: { net: number; l: number; ax: number; ay: number; bx: number; by: number; w: number }[] = [];
  const clearOf = (net: number, l: number, width: number, segs: [number, number, number, number][]) => {
    const need = rules.clearance + width / 2 - 1e-3;
    const layer = layers[l]!;
    for (const [ax, ay, bx, by] of segs) {
      const len = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(len / 0.01));
      const near = segDist(ax, ay, bx, by);
      for (let q = 0; q < pads.length; q++) {
        const p = pads[q]!;
        if (padNet[q] === net || (!p.drill && !p.layers.includes(layer))) continue;
        if (Math.abs(p.x - (ax + bx) / 2) > len / 2 + Math.max(p.w, p.h) + 1 || Math.abs(p.y - (ay + by) / 2) > len / 2 + Math.max(p.w, p.h) + 1) continue;
        const d = padDist(p);
        for (let i = 0; i <= steps; i++) if (d(ax + ((bx - ax) * i) / steps, ay + ((by - ay) * i) / steps) < need) return false;
        // a reserved escape stub of another net
        const e = escapes[q];
        if (e && e.l === l) {
          const stub = rules.clearance + (width + rules.track) / 2 - 1e-3;
          for (const [cx, cy, dx, dy] of [[p.x, p.y, e.p1.x, e.p1.y], [e.p1.x, e.p1.y, e.ex, e.ey]] as const) {
            if (segSegDist(ax, ay, bx, by, cx, cy, dx, dy) < stub) return false;
          }
        }
      }
      for (const t of tracks) {
        if (t.layer !== layer || numOf(t.netId) === net) continue;
        const gap = rules.clearance + (width + t.width) / 2 - 1e-3;
        for (let q = 0; q + 3 < t.pts.length; q += 2) if (segSegDist(ax, ay, bx, by, t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!) < gap) return false;
      }
      for (const v of vias) if (numOf(v.netId) !== net && near(v.x, v.y) < rules.clearance + (width + v.pad) / 2 - 1e-3) return false;
      for (const c of held) if (c.net !== net && (c.l < 0 || c.l === l) && segSegDist(ax, ay, bx, by, c.ax, c.ay, c.bx, c.by) < rules.clearance + (width + c.w) / 2 - 1e-3) return false;
    }
    return true;
  };
  const padAt = (root: number, state: number) => pads.findIndex((_, idx) => find(idx) === root && padCells[idx]!.includes(state));

  /*
   * Planes and pours. Inner planes are dedicated to their net (no tracks there); pours on outer
   * layers fill what the tracks leave. Every group of a plane net that does not reach its plane
   * drops onto it (short track + via). Order: inner-plane drops → pour drop sites reserved →
   * signal routing → outer-pour drops → the pour net's remaining tracks → final areas (clear of
   * every via of other nets) → connectivity.
   */
  const zones: Zone[] = [];
  const planes = (input.planes ?? []).filter((pl) => layerIdx.has(pl.layer) && netNum.has(pl.netId));
  const margin = G * 0.75; // a cell stands for a G × G square: keep its corners clear
  /** A plane's distances as set_plane_style shaped it (never below the board's own). */
  const planeLook = (pl: Plane) => {
    const st = pl.style ?? {};
    const clear = Math.max(rules.clearance, st.clearance ?? 0);
    return {
      clear,
      edge: Math.max(rules.edgeClearance, st.edge ?? 0),
      thermal: st.thermal !== false,
      ring: Math.max(clear, 0.25),
      spoke: st.spoke ?? Math.min(0.4, Math.max(0.3, rules.track)),
    };
  };
  /** The gap round an area plane, to the plane it lies in. */
  const areaGap = (q: Plane) => Math.max(rules.clearance, q.style?.gap ?? 0);
  /**
   * Whether `pl` goes round the area plane `q` on its layer: a full plane goes round every area;
   * of two areas the smaller lies on top (a +5V patch inside a local GND pour), the later one
   * when they are as big.
   */
  const areaSize = (a: [number, number, number, number]) => (a[2] - a[0]) * (a[3] - a[1]);
  const goesRound = (pl: Plane, q: Plane) => {
    if (q === pl || q.layer !== pl.layer || !q.area) return false;
    if (!pl.area) return true;
    const d = areaSize(q.area) - areaSize(pl.area);
    return Math.abs(d) > 1e-6 ? d < 0 : planes.indexOf(q) > planes.indexOf(pl);
  };
  const region = (pl: Plane) => {
    const l = layerIdx.get(pl.layer)!;
    const pnet = numOf(pl.netId);
    const ok = new Uint8Array(N);
    const look = planeLook(pl);
    const keep = look.edge + margin;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const x = i * G;
        const y = j * G;
        ok[j * W + i] = x >= keep && y >= keep && x <= input.outline.w - keep && y <= input.outline.h - keep && (!shaped || inside(x, y) >= keep) ? 1 : 0;
      }
    }
    for (const c of input.cutouts ?? []) {
      const [x0, y0, x1, y1] = cutoutBounds(c);
      for (let j = Math.max(0, Math.floor((y0 - keep) / G)); j <= Math.min(H - 1, Math.ceil((y1 + keep) / G)); j++) {
        for (let i = Math.max(0, Math.floor((x0 - keep) / G)); i <= Math.min(W - 1, Math.ceil((x1 + keep) / G)); i++) if (cutoutDistance(c, i * G, j * G) < keep) ok[j * W + i] = 0;
      }
    }
    // split planes: an area plane only inside its rectangle; the layer's other planes round each
    // area on it, with the clearance
    for (const q of planes) {
      if (q !== pl && !goesRound(pl, q)) continue;
      if (q.layer !== pl.layer || !q.area) continue;
      const [a0, b0, a1, b1] = q.area;
      const grow = q === pl ? -margin : areaGap(q) + margin;
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          const within = i * G >= a0 - grow && i * G <= a1 + grow && j * G >= b0 - grow && j * G <= b1 + grow;
          if (within !== (q === pl)) ok[j * W + i] = 0;
        }
      }
    }
    const clearAround = (x0: number, y0: number, x1: number, y1: number, extra: number, dist: (x: number, y: number) => number) => {
      const reach = look.clear + extra + margin;
      for (let j = Math.max(0, Math.floor((y0 - reach) / G)); j <= Math.min(H - 1, Math.ceil((y1 + reach) / G)); j++) {
        for (let i = Math.max(0, Math.floor((x0 - reach) / G)); i <= Math.min(W - 1, Math.ceil((x1 + reach) / G)); i++) if (dist(i * G, j * G) < reach) ok[j * W + i] = 0;
      }
    };
    pads.forEach((p, idx) => {
      if (padNet[idx] === pnet) return;
      if (!p.drill && !p.layers.includes(pl.layer)) return;
      clearAround(p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2, 0, padDist(p));
    });
    for (const t of tracks) {
      if (t.netId === pl.netId || t.layer !== pl.layer) continue;
      for (let q = 0; q + 3 < t.pts.length; q += 2) {
        const [ax, ay, bx, by] = [t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!];
        clearAround(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), t.width / 2, segDist(ax, ay, bx, by));
      }
    }
    for (const v of vias) if (v.netId !== pl.netId) clearAround(v.x, v.y, v.x, v.y, v.pad / 2, (x, y) => Math.hypot(x - v.x, y - v.y));
    /*
     * Thermal reliefs where the plane meets its own vias and pins: a clearance ring with four
     * spokes (easier to solder and to rework than a solid connection).
     */
    const okOthers = ok.slice(); // before the reliefs: where other nets allow copper
    const gap = look.ring;
    const spoke = look.spoke;
    const relief = (cx: number, cy: number, halfW: number, halfH: number, dist: (x: number, y: number) => number) => {
      const outer = gap + margin;
      for (let j = Math.max(0, Math.floor((cy - halfH - outer) / G)); j <= Math.min(H - 1, Math.ceil((cy + halfH + outer) / G)); j++) {
        for (let i = Math.max(0, Math.floor((cx - halfW - outer) / G)); i <= Math.min(W - 1, Math.ceil((cx + halfW + outer) / G)); i++) {
          const x = i * G;
          const y = j * G;
          const d = dist(x, y);
          if (d <= 0 || d >= outer) continue; // the pad itself stays; beyond the ring is plane
          if (Math.abs(x - cx) <= spoke / 2 || Math.abs(y - cy) <= spoke / 2) continue; // spokes
          ok[j * W + i] = 0;
        }
      }
    };
    // (joined solid: no reliefs)
    if (look.thermal) {
      for (const v of vias) if (v.netId === pl.netId && !v.group) relief(v.x, v.y, v.pad / 2, v.pad / 2, (x, y) => Math.hypot(x - v.x, y - v.y) - v.pad / 2);
      pads.forEach((p, idx) => {
        if (padNet[idx] !== pnet || solidPads.has(idx) || !(p.drill || p.layers.includes(pl.layer))) return;
        relief(p.x, p.y, p.w / 2, p.h / 2, padDist(p));
      });
    }
    // islands (4-connected)
    const island = new Int32Array(N).fill(-1);
    const sizes: number[] = [];
    for (let c0 = 0; c0 < N; c0++) {
      if (!ok[c0] || island[c0]! >= 0) continue;
      const id = sizes.length;
      let n = 0;
      const stack = [c0];
      island[c0] = id;
      while (stack.length) {
        const c = stack.pop()!;
        n++;
        const x = c % W;
        for (const nb of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c - W, c + W]) {
          if (nb < 0 || nb >= N || !ok[nb] || island[nb]! >= 0) continue;
          island[nb] = id;
          stack.push(nb);
        }
      }
      sizes.push(n);
    }
    // islands touched by the net's copper on this layer (pads, tracks) and by its vias
    const touched = new Set<number>();
    for (const [r, cells] of groupCells) {
      if (padNet[r] !== pnet) continue;
      for (const st of cells) if (Math.floor(st / N) === l && island[st % N]! >= 0) touched.add(island[st % N]!);
    }
    pads.forEach((p, idx) => {
      if (padNet[idx] !== pnet || !(p.drill || p.layers.includes(pl.layer))) return;
      const c = Math.round(p.x / G) + Math.round(p.y / G) * W;
      if (island[c]! >= 0) touched.add(island[c]!);
    });
    for (const v of vias) {
      if (v.netId !== pl.netId) continue;
      const c = Math.round(v.x / G) + Math.round(v.y / G) * W;
      if (island[c]! >= 0) touched.add(island[c]!);
    }
    const candidates = [...(touched.size ? touched : sizes.keys())];
    const main = candidates.sort((x, y) => sizes[y]! - sizes[x]! || x - y)[0];
    return { l, pnet, island, sizes, main, touched, okOthers };
  };

  /** Exact plane geometry: outline minus clearances, relief rings and dead islands, plus spokes. */
  const planeShape = (pl: Plane, rg: ReturnType<typeof region>, alive: Set<number>): ZoneShape => {
    const look = planeLook(pl);
    const c = look.clear;
    const e = look.edge;
    const cuts: ZoneShape['cuts'] = [];
    // split planes: the layer's other planes go round each area on it, with its gap
    for (const q of planes) {
      if (!goesRound(pl, q) || !q.area) continue;
      const g = areaGap(q);
      cuts.push({ k: 'rect', x: r3(q.area[0] - g), y: r3(q.area[1] - g), w: r3(q.area[2] - q.area[0] + 2 * g), h: r3(q.area[3] - q.area[1] + 2 * g) });
    }
    const adds: ZoneShape['adds'] = [];
    pads.forEach((p, idx) => {
      if (padNet[idx] === rg.pnet || !(p.drill || p.layers.includes(pl.layer))) return;
      if (p.shape === 'round') cuts.push({ k: 'circle', x: p.x, y: p.y, d: r3(Math.min(p.w, p.h) + 2 * c) });
      else cuts.push({ k: 'rect', x: r3(p.x - p.w / 2 - c), y: r3(p.y - p.h / 2 - c), w: r3(p.w + 2 * c), h: r3(p.h + 2 * c) });
    });
    for (const t of tracks) if (t.netId !== pl.netId && t.layer === pl.layer) cuts.push({ k: 'stroke', pts: t.pts, w: r3(t.width + 2 * c) });
    for (const v of vias) if (v.netId !== pl.netId) cuts.push({ k: 'circle', x: v.x, y: v.y, d: r3(v.pad + 2 * c) });
    // thermal reliefs: a ring cut, spokes back where no other net is in the way
    const gap = look.ring;
    const spokeW = look.spoke;
    const spokesOf = (x: number, y: number, hx: number, hy: number) => {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const x1 = x + dx * (hx + gap + G);
        const y1 = y + dy * (hy + gap + G);
        let clear = true;
        for (let t = 0; t <= 1.0001 && clear; t += 0.1) {
          const i = Math.round((x + (x1 - x) * t) / G);
          const j = Math.round((y + (y1 - y) * t) / G);
          if (Math.hypot((x1 - x) * t, (y1 - y) * t) <= Math.min(hx, hy)) continue; // on the pad itself
          if (i < 0 || j < 0 || i >= W || j >= H || !rg.okOthers[j * W + i]) clear = false;
        }
        if (clear) adds.push({ pts: [r3(x), r3(y), r3(x1), r3(y1)], w: spokeW });
      }
    };
    for (const v of vias) {
      if (v.netId !== pl.netId || !look.thermal || v.group) continue;
      cuts.push({ k: 'circle', x: v.x, y: v.y, d: r3(v.pad + 2 * gap) });
      spokesOf(v.x, v.y, v.pad / 2, v.pad / 2);
    }
    pads.forEach((p, idx) => {
      if (padNet[idx] !== rg.pnet || !(p.drill || p.layers.includes(pl.layer)) || !look.thermal || solidPads.has(idx)) return;
      if (p.shape === 'round' && p.w === p.h) cuts.push({ k: 'circle', x: p.x, y: p.y, d: r3(p.w + 2 * gap) });
      else if (p.shape === 'round') {
        const c = padCapsule(p); // an oval pad
        cuts.push({ k: 'stroke', pts: [r3(c.ax), r3(c.ay), r3(c.bx), r3(c.by)], w: r3(2 * c.r + 2 * gap) });
      } else cuts.push({ k: 'rect', x: r3(p.x - p.w / 2 - gap), y: r3(p.y - p.h / 2 - gap), w: r3(p.w + 2 * gap), h: r3(p.h + 2 * gap) });
      spokesOf(p.x, p.y, p.w / 2, p.h / 2);
    });
    // milled cutouts and rounded board corners, with the edge clearance around them
    for (const co of input.cutouts ?? []) {
      const a = (co.angle * Math.PI) / 180;
      const along = (d: number) => [r3(co.x - (d / 2) * Math.cos(a)), r3(co.y - (d / 2) * Math.sin(a)), r3(co.x + (d / 2) * Math.cos(a)), r3(co.y + (d / 2) * Math.sin(a))];
      if (co.shape === 'circle') cuts.push({ k: 'circle', x: co.x, y: co.y, d: r3(co.w + 2 * e) });
      else if (co.shape === 'slot') cuts.push({ k: 'stroke', pts: along(Math.max(0, co.w - co.h)), w: r3(co.h + 2 * e) });
      else if (co.angle % 90 === 0) {
        const [cw, ch] = co.angle % 180 === 0 ? [co.w, co.h] : [co.h, co.w];
        cuts.push({ k: 'rect', x: r3(co.x - cw / 2 - e), y: r3(co.y - ch / 2 - e), w: r3(cw + 2 * e), h: r3(ch + 2 * e) });
      } else cuts.push({ k: 'stroke', pts: along(co.w), w: r3(co.h + 2 * e) }); // turned: a covering oblong
    }
    // a rounded or free-form outline: the pour is clipped to it, and a band of the edge
    // clearance along it is cut
    let clip: number[] | undefined;
    if (shaped) {
      clip = boardPolygon({ outline: input.outline, cornerRadius: cornerR, shape: input.shape ?? null }).map(r3);
      cuts.push({ k: 'stroke', pts: [...clip, clip[0]!, clip[1]!], w: r3(2 * e) });
    }
    // islands that are not kept (no connection to the net): cut them out, grown into the
    // clearance around them (always at least one grid cell wide)
    for (let j = 0; j < H; j++) {
      let start = -1;
      for (let i = 0; i <= W; i++) {
        const isl = i < W ? rg.island[j * W + i]! : -1;
        const dead = isl >= 0 && !alive.has(isl);
        if (dead && start < 0) start = i;
        if (!dead && start >= 0) {
          cuts.push({ k: 'rect', x: r3(start * G - G), y: r3(j * G - G), w: r3((i - start + 1) * G), h: r3(2 * G) });
          start = -1;
        }
      }
    }
    const box: [number, number, number, number] = [e, e, r3(input.outline.w - e), r3(input.outline.h - e)];
    const outline: [number, number, number, number] = pl.area ? [r3(Math.max(box[0], pl.area[0])), r3(Math.max(box[1], pl.area[1])), r3(Math.min(box[2], pl.area[2])), r3(Math.min(box[3], pl.area[3]))] : box;
    if (pl.area && clip) {
      // a shaped board fills its clip polygon, not the outline rectangle: cut what lies outside the area
      const [x0, y0, x1, y1] = outline;
      const [W0, H0] = [input.outline.w, input.outline.h];
      for (const [x, y, w, h] of [[0, 0, W0, y0], [0, y1, W0, H0 - y1], [0, y0, x0, y1 - y0], [x1, y0, W0 - x1, y1 - y0]] as const) if (w > 0 && h > 0) cuts.push({ k: 'rect', x: r3(x), y: r3(y), w: r3(w), h: r3(h) });
    }
    return { outline, ...(clip ? { clip } : {}), cuts, adds };
  };

  // 1. provisional areas; 2. drops of every group that does not reach its plane
  const dropVias = new Map<number, { x: number; y: number }[]>(); // pad root (when it dropped) → drop vias
  let timedOut = false;
  /** The groups of a plane's net that reach its main area (they are connected through it). */
  const reachMain = (pl: (typeof planes)[number], rg: ReturnType<typeof region>) => {
    const roots = [...new Set(pads.map((_, idx) => find(idx)).filter((r) => padNet[r] === rg.pnet))];
    const inMain = (x: number, y: number) => rg.island[Math.round(x / G) + Math.round(y / G) * W] === rg.main;
    // (drop vias are listed under the root their group had when it dropped)
    const dropped = new Set([...dropVias].filter(([, vs]) => vs.some((v) => inMain(v.x, v.y))).map(([r]) => find(r)));
    return roots.filter(
      (r) =>
        groupCells.get(r)!.some((st) => Math.floor(st / N) === rg.l && rg.island[st % N] === rg.main) ||
        dropped.has(r) ||
        pads.some((p, idx) => find(idx) === r && (p.drill || p.layers.includes(pl.layer)) && inMain(p.x, p.y)),
    );
  };
  /**
   * A drop's width: the net's own where all the pads it starts from can take it; else, on a power
   * net, the power width where they can take that; else the signal width.
   */
  const dropClass = (netId: string, from: number[]) => {
    const takes = (w: number) => from.every((idx) => Math.min(pads[idx]!.w, pads[idx]!.h) >= w * 0.9);
    const own = input.netWidths?.[netId];
    if (own) return own <= rules.track || takes(own) ? trackClass(own) : 0;
    return input.powerNets.has(netId) && takes(rules.powerTrack) ? 1 : 0;
  };
  const groupPads = (root: number) => pads.flatMap((_, idx) => (find(idx) === root ? [idx] : []));
  /*
   * Drop sites for outer pours, reserved before the signals: every SMD pad of the pour's net off
   * the pour layer gets the nearest via site with a short stub (on its own layer, within
   * MAX_STUB), and that copper is kept clear of other nets (as the escape stubs are). It is laid
   * only after the signals, where the pad still needs it: routed among the signals, the pour
   * net's many tracks would wall them off; routed after them, its pads could be shut off from
   * every via site. (A reservation that is not laid stays marked in the clearance maps: harmless,
   * as only the pour's own net routes after the drops.)
   */
  const reserveDrops = (list: typeof planes) => {
    for (const pl of list) {
      const l = layerIdx.get(pl.layer)!;
      const pnet = numOf(pl.netId);
      const viaFree = viaFreeFor(pnet);
      const rr = rules.viaPad / 2 + margin + rules.clearance;
      pads.forEach((p, idx) => {
        if (padNet[idx] !== pnet || p.drill || p.layers.includes(pl.layer) || now() > until) return;
        // its copper already reaches the pour's layer (a kept drop, thermal vias)
        if (groupCells.get(find(idx))!.some((st) => Math.floor(st / N) === l)) return;
        const siteAt = (k: number) => {
          const free = freeFor(pnet, k);
          const path = search(pnet, k, padCells[idx]!, (st) => {
            if (Math.floor(st / N) === l) return false;
            const i = st % N;
            if (viaAt[i] === pnet) return true; // another pad's site
            if (!viaFree(i)) return false;
            // room for the pour round the via
            const vx = (i % W) * G;
            const vy = Math.floor(i / W) * G;
            for (const [dx, dy] of [[rr, 0], [-rr, 0], [0, rr], [0, -rr]] as const) {
              const ii = Math.round((vx + dx) / G) + Math.round((vy + dy) / G) * W;
              if (ii < 0 || ii >= N || !free(l, ii)) return false;
            }
            return true;
          }, p, undefined, 0, false, 2 * MAX_STUB);
          // (a long way to a via site, or one over other layers, would block more than it saves)
          return path && path.length <= MAX_STUB && path.every((st) => Math.floor(st / N) === Math.floor(path[0]! / N)) ? path : null;
        };
        // (a power-width stub that finds no site is tried again at the signal width)
        let k = dropClass(pl.netId, [idx]);
        let path = siteAt(k);
        if (!path && k) path = siteAt((k = 0));
        if (!path) return;
        const l0 = Math.floor(path[0]! / N);
        const e = escapes[idx];
        const pts = simplify([...(e && e.state === path[0] ? [p.x, p.y, e.p1.x, e.p1.y] : [p.x, p.y]), ...path.flatMap((st) => [((st % N) % W) * G, Math.floor((st % N) / W) * G])]);
        for (let q = 0; q + 3 < pts.length; q += 2) {
          const [ax, ay, bx, by] = [pts[q]!, pts[q + 1]!, pts[q + 2]!, pts[q + 3]!];
          stampSeg(l0, pnet, ax, ay, bx, by, widths[k]!);
          held.push({ net: pnet, l: l0, ax, ay, bx, by, w: widths[k]! });
        }
        const [vx, vy] = [pts.at(-2)!, pts.at(-1)!];
        if (viaAt[Math.round(vy / G) * W + Math.round(vx / G)] !== pnet) {
          stampVia(pnet, vx, vy);
          held.push({ net: pnet, l: -1, ax: vx, ay: vy, bx: vx, by: vy, w: rules.viaPad });
        }
        reserved.set(idx, { path, k });
      });
    }
  };
  const dropOnto = (list: typeof planes) => {
  for (const pl of list) {
    const rg = region(pl);
    if (rg.main === undefined || rg.sizes[rg.main]! * G * G < 1) continue;
    const rr = rules.viaPad / 2 + margin + rules.clearance;
    /** A new via site well inside the main area (the via then joins the plane). */
    const siteOk = (i: number) => {
      if (rg.island[i] !== rg.main || !viaFreeFor(rg.pnet)(i)) return false;
      const vx = (i % W) * G;
      const vy = Math.floor(i / W) * G;
      for (const [dx, dy] of [[rr, 0], [-rr, 0], [0, rr], [0, -rr]] as const) {
        const ii = Math.round((vx + dx) / G) + Math.round((vy + dy) / G) * W;
        if (rg.island[ii] !== rg.main) return false;
      }
      return true;
    };
    // (an area plane: only the groups with a pad inside the area; the others are joined by tracks)
    const roots = [...new Set(pads.map((_, idx) => find(idx)).filter((r) => padNet[r] === rg.pnet))].filter((r) => !pl.area || pads.some((p, idx) => find(idx) === r && inArea(pl, p)));
    // copper of the drops so far → the via it leads down to: a later drop may simply join it
    const dropCopper = new Map<number, { x: number; y: number }>();
    for (const r of roots) {
      const reaches = groupCells.get(r)!.some((st) => Math.floor(st / N) === rg.l && rg.island[st % N] === rg.main);
      if (reaches) continue;
      // a site reserved before the signals that lies in the main area: laid as it is (no search,
      // so even once the time is up)
      const site = pads.findIndex((_, idx) => find(idx) === r && reserved.has(idx) && rg.island[reserved.get(idx)!.path.at(-1)! % N] === rg.main);
      if (site >= 0) {
        const { path, k: ks } = reserved.get(site)!;
        const joins = dropCopper.get(path.at(-1)!);
        const copper = commit(pl.netId, rg.pnet, ks, path, site, -1, !joins);
        groupCells.get(r)!.push(...copper);
        const end = path.at(-1)! % N;
        const via = joins ?? { x: (end % W) * G, y: Math.floor(end / W) * G };
        for (const st of copper) dropCopper.set(st, via);
        dropVias.set(r, [...(dropVias.get(r) ?? []), via]);
        continue;
      }
      if (now() > deadline) continue;
      const starts = groupCells.get(r)!.filter((st) => Math.floor(st / N) !== rg.l);
      if (!starts.length) continue;
      const wayAt = (k: number) =>
        search(rg.pnet, k, starts, (st) => {
          if (Math.floor(st / N) === rg.l) return false;
          if (dropCopper.has(st)) return true; // join an earlier drop
          const i = st % N;
          if (viaAt[i] === rg.pnet && rg.island[i] === rg.main) return true; // join an existing via
          return siteOk(i);
        }, pads[r]!);
      // (a power-width drop that finds no way is tried again at the signal width)
      let k = dropClass(pl.netId, groupPads(r));
      let path = wayAt(k);
      if (!path && k && now() <= deadline) path = wayAt((k = 0));
      if (!path) continue;
      const joins = dropCopper.get(path.at(-1)!);
      // a way that changed layer itself already has a via: not another one right next to it
      const end = path.at(-1)! % N;
      const crowded = (q: number) => {
        if (q === 0 || Math.floor(path[q]! / N) === Math.floor(path[q - 1]! / N)) return false;
        const d = Math.hypot(((path[q]! % N) % W) - (end % W), Math.floor((path[q]! % N) / W) - Math.floor(end / W)) * G;
        return d > 1e-9 && d < VIA_SPACING;
      };
      if (!joins && path.some((_, q) => crowded(q) && q < path.length - 1)) continue;
      const from = padAt(r, path[0]!);
      const copper = commit(pl.netId, rg.pnet, k, path, from, -1, !joins);
      groupCells.get(r)!.push(...copper);
      const via = joins ?? { x: (end % W) * G, y: Math.floor(end / W) * G };
      for (const st of copper) dropCopper.set(st, via);
      dropVias.set(r, [...(dropVias.get(r) ?? []), via]);
    }
  }
  };
  /** The neck zone (see neckAt) for a track of width class k from or to these pads: round each that cannot take it. */
  const setNecks = (k: number, padIdx: number[]) => {
    neckRun = 0;
    const w = widths[k]!;
    if (w <= rules.track) return;
    const reach = Math.max(NECK_REACH, 2 * w);
    const r = ++neckNo;
    for (const idx of padIdx) {
      const p = pads[idx]!;
      const size = Math.min(p.w, p.h);
      if (size >= w * 0.9) continue;
      // the widest width below this one that the pad takes (never below the signal width)
      const nk = widths.reduce((best, x, i) => (i !== 2 && x < w && size >= x * 0.9 && x > widths[best]! ? i : best), 0);
      const d = padDist(p);
      for (let j = Math.max(0, Math.floor((p.y - p.h / 2 - reach) / G)); j <= Math.min(H - 1, Math.ceil((p.y + p.h / 2 + reach) / G)); j++) {
        for (let i = Math.max(0, Math.floor((p.x - p.w / 2 - reach) / G)); i <= Math.min(W - 1, Math.ceil((p.x + p.w / 2 + reach) / G)); i++) {
          const dist = d(i * G, j * G);
          if (dist > reach) continue;
          const at = j * W + i;
          const on = dist < w / 2 ? 1 : 0;
          if (neckAt[at] !== r) {
            neckAt[at] = r;
            neckK[at] = nk;
            neckOn[at] = on;
          } else {
            if (widths[nk]! < widths[neckK[at]!]!) neckK[at] = nk;
            if (on) neckOn[at] = 1;
          }
        }
      }
      neckRun = r;
    }
  };
  /**
   * A track of class k may start or end on state st: an escape stub is reserved at the signal
   * width, so a wider track may run along it only where it keeps its clearance at that width.
   */
  const escapeFits = (net: number, k: number, st: number) => {
    const idx = escapeOf.get(st);
    const w = widths[classAt(net, k, st)]!;
    if (idx === undefined || w <= rules.track) return true;
    const e = escapes[idx]!;
    const p = pads[idx]!;
    return clearOf(net, e.l, w, [[p.x, p.y, e.p1.x, e.p1.y], [e.p1.x, e.p1.y, e.ex, e.ey]]);
  };
  /*
   * The tracks the agent laid (RouteInput.drawn), before anything else: each stretch from point
   * to point a search of its own (the same way every pass: see drawing), held to its layer where
   * one is given, the whole laid by commit turning at the points. One that finds no way is not
   * laid, and its connection is routed as any other. What is laid is there in every pass (as the
   * locked copper: the probe names its net where it is in the way).
   */
  const drawnStatus: DrawnStatus[] = [];
  if (input.drawn?.length) {
    drawing = true;
    for (const t of input.drawn) drawnStatus.push(layDrawn(t));
    drawing = false;
    neckRun = 0;
  }
  function layDrawn(t: NonNullable<RouteInput['drawn']>[number]): DrawnStatus {
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const fail = (why: string, x: number, y: number, blockedBy?: number): DrawnStatus => {
      const id = blockedBy !== undefined ? [...netNum].find(([, n]) => n === blockedBy)?.[0] : undefined;
      return { id: t.id, laid: false, why, at: { x: r2(x), y: r2(y) }, ...(id ? { blockedBy: id } : {}) };
    };
    const [a, b] = [t.from, t.to];
    const [pa, pb] = [pads[a], pads[b]];
    if (!pa || !pb || pa.netId !== t.netId || pb.netId !== t.netId) return { id: t.id, laid: false, why: 'its pads are not on its net' };
    const net = numOf(t.netId);
    const own = input.netWidths?.[t.netId];
    const k = t.width ? trackClass(t.width) : own ? trackClass(own) : input.powerNets.has(t.netId) ? 1 : 0;
    const w = widths[k]!;
    setNecks(k, [a, b]);
    const free = freeNeck(net, k);
    const label = (idx: number) => `${owner[idx]!.refdes}.${pads[idx]!.number}`;
    const on = (l: number | null) => (l === null ? '' : ` on ${layers[l]}`);
    let cur: number | null = null;
    if (t.layer) {
      const l = layerIdx.get(t.layer);
      if (l === undefined) return fail(`the board has no ${t.layer}`, pa.x, pa.y);
      cur = l;
    }
    const onCur = (st: number) => cur === null || Math.floor(st / N) === cur;
    let starts = padCells[a]!.filter((st) => onCur(st) && escapeFits(net, k, st));
    if (!starts.length) return fail(`${label(a)} is not${on(cur)}`, pa.x, pa.y);
    const full: number[] = [];
    const pins = new Set<number>();
    let from = label(a);
    for (const stop of [...t.points.map((p) => ({ ...p, pad: false })), { x: pb.x, y: pb.y, layer: undefined, pad: true }]) {
      const here = stop.pad ? label(b) : `(${r2(stop.x)}, ${r2(stop.y)})`;
      epoch++;
      const stamp = epoch;
      let goals: number[];
      let accept: ((st: number) => boolean) | undefined;
      if (stop.pad) {
        goals = padCells[b]!.filter((st) => onCur(st) && escapeFits(net, k, st));
        if (!goals.length) return fail(`${here} is not${on(cur)}`, stop.x, stop.y);
        // (as for a routed connection: on the pad's centre line where the track fits there)
        const fits = (st: number) => free(Math.floor(st / N), st % N);
        const centred = (st: number) => fits(st) && !offCentre(net, classAt(net, k, st), st);
        const deepest = new Set(deepestCells(goals));
        accept = goals.some(centred) ? centred : goals.some(fits) ? fits : (st: number) => deepest.has(st);
      } else {
        const i = Math.round(stop.x / G);
        const j = Math.round(stop.y / G);
        if (i < 0 || j < 0 || i >= W || j >= H) return fail(`${here} is off the board`, stop.x, stop.y);
        const c = j * W + i;
        const ls = cur === null ? layers.map((_, l) => l) : [cur];
        goals = ls.filter((l) => free(l, c)).map((l) => l * N + c);
        if (!goals.length) {
          const v = maps[k]![ls[0]!]![c]!;
          const what = v === EDGE ? 'the board edge (or a plane layer) is' : v === MULTI ? 'copper of other nets is' : 'other copper is';
          return fail(`${here} has no room for a ${w} mm track${on(cur)}: ${what} too close`, stop.x, stop.y, v > 0 ? v : undefined);
        }
      }
      for (const st of goals) goal[st] = stamp;
      const isGoal = (st: number) => goal[st] === stamp;
      let [gx0, gy0, gx1, gy1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const st of goals) {
        const x = (st % N) % W;
        const y = Math.floor((st % N) / W);
        [gx0, gy0, gx1, gy1] = [Math.min(gx0, x), Math.min(gy0, y), Math.max(gx1, x), Math.max(gy1, y)];
      }
      const target = { x0: gx0, y0: gy0, x1: gx1, y1: gy1 };
      const way = corridor(net, k, starts, goals, stamp);
      let path: number[] | null = null;
      if (way) {
        for (const r of [CORRIDOR, 3 * CORRIDOR]) if (!path) path = search(net, k, starts, isGoal, target, accept, widen(way, r), false, Infinity, cur !== null);
        path ??= search(net, k, starts, isGoal, target, accept, 0, true, Infinity, cur !== null);
      }
      if (!path) return fail(`no way for a ${w} mm track from ${from} to ${here}${on(cur)}`, stop.x, stop.y);
      full.push(...(full.length && full.at(-1) === path[0] ? path.slice(1) : path));
      if (stop.pad) break;
      // a point: the track turns there as it is; a layer given goes on from there (a via)
      const end = path.at(-1)!;
      const c = end % N;
      pins.add(c);
      starts = [end];
      if (stop.layer) {
        const next = layerIdx.get(stop.layer);
        if (next === undefined) return fail(`the board has no ${stop.layer}`, stop.x, stop.y);
        if (next !== Math.floor(end / N)) {
          if (!viaFreeFor(net)(c) || !free(next, c)) return fail(`no room for a via at ${here}`, stop.x, stop.y);
          starts = [next * N + c];
          full.push(starts[0]!);
        }
        cur = next;
      }
      from = here;
    }
    const [t0, v0] = [tracks.length, vias.length];
    const copper = commit(t.netId, net, k, full, padCells[a]!.includes(full[0]!) ? a : -1, padCells[b]!.includes(full.at(-1)!) ? b : -1, false, pins);
    for (let q = t0; q < tracks.length; q++) tracks[q]!.drawn = t.id;
    for (let q = v0; q < vias.length; q++) vias[q]!.drawn = t.id;
    union(a, b);
    groupCells.get(find(a))!.push(...copper);
    return { id: t.id, laid: true };
  }

  /*
   * Fan-out first: pads on a net with a dedicated inner plane drop onto it before the signals are
   * routed (the signals then go round the drop vias; routed first, a signal can shut a pad off
   * from every via site). Outer pours come last: they fill what the tracks leave; their drop
   * sites are reserved now (see reserveDrops).
   */
  dropOnto(planes.filter((pl) => !OUTER.has(pl.layer)));
  // pours of nets without an inner plane (GND on B.Cu of a 2-layer board); a local pour (an area
  // on an outer layer) only joins what reaches it, as an area plane does
  const pours = planes.filter((pl) => OUTER.has(pl.layer) && !pl.area && !planes.some((q) => q.netId === pl.netId && !OUTER.has(q.layer)));
  reserveDrops(pours);
  /*
   * A pour's net is joined through its pour, so a connection between two pads that can each
   * reach the pour without a track (a reserved drop site, or a through-hole pad) waits until
   * the signals are routed and the drops laid; then it is routed only if the pour will not join
   * it. Except: pads closer than two via spacings (neighbouring pins) are simply joined first
   * (two drops would crowd each other), and so are connections that failed in the pass before.
   */
  const poured = new Set(pours.map((pl) => pl.netId));
  const reachesPour = (idx: number) => reserved.has(idx) || !!pads[idx]!.drill;
  const later = (c: Conn) => poured.has(c.netId) && c.len >= 2 * VIA_SPACING && !early.has(c) && reachesPour(c.a) && reachesPour(c.b);
  // connections left to the pour: open unless the final areas join them
  const leftToPour: Conn[] = [];
  const routeConn = (c: Conn) => {
    const net = numOf(c.netId);
    if (find(c.a) === find(c.b)) return;
    if (now() > until) {
      timedOut = true;
      failed.push(c);
      return;
    }
    // the net's own width, else on a power net the power width; near a pad too small for it the
    // track narrows to the widest width that pad takes (a neck, see neckAt), and runs at its
    // width again clear of it
    const own = input.netWidths?.[c.netId];
    const chosen = own ? trackClass(own) : input.powerNets.has(c.netId) ? 1 : 0;
    // a power track that finds no way is necked down to the signal width all along (a width the
    // user set for the net is not: that one is a requirement)
    let k = chosen;
    let path = attempt(chosen);
    if (!path && chosen === 1 && !own && now() <= deadline) path = attempt((k = 0));
    if (!path) {
      neckRun = 0;
      failed.push(c);
      return;
    }
    function attempt(k: number): number[] | null {
      setNecks(k, [...groupPads(find(c.a)), ...groupPads(find(c.b))]);
      const escapeOk = (st: number) => escapeFits(net, k, st);
      epoch++;
      const goalStamp = epoch;
      const goalCells = groupCells.get(find(c.a))!.filter(escapeOk);
      for (const st of goalCells) goal[st] = goalStamp;
      // end where the track fits, on its pad's centre line; failing that where it fits; failing
      // that deepest inside the pad
      const fits = (st: number) => freeNeck(net, k)(Math.floor(st / N), st % N);
      const centred = (st: number) => fits(st) && !offCentre(net, classAt(net, k, st), st);
      const deepest = new Set(deepestCells(goalCells));
      const accept = goalCells.some(centred) ? centred : goalCells.some(fits) ? fits : (st: number) => deepest.has(st);
      // (the estimate: the box round the whole goal group, not just pad a)
      let [gx0, gy0, gx1, gy1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const st of goalCells) {
        const i = st % N;
        const x = i % W;
        const y = (i - x) / W;
        if (x < gx0) gx0 = x;
        if (x > gx1) gx1 = x;
        if (y < gy0) gy0 = y;
        if (y > gy1) gy1 = y;
      }
      const starts = groupCells.get(find(c.b))!.filter(escapeOk);
      const isGoal = (st: number) => goal[st] === goalStamp;
      const target = { x0: gx0, y0: gy0, x1: gx1, y1: gy1 };
      // within the corridor of the coarse way first, then a wider one; failing that, anywhere (a
      // connection that hard is likely impossible: check that first). No coarse way: no way at all.
      // (No new attempt once the time is up.)
      const way = corridor(net, k, starts, goalCells, goalStamp);
      let path: number[] | null = null;
      if (way) {
        for (const r of [CORRIDOR, 3 * CORRIDOR]) {
          if (path || now() > deadline) break;
          path = search(net, k, starts, isGoal, target, accept, widen(way, r));
        }
        if (!path && now() <= deadline) path = search(net, k, starts, isGoal, target, accept, 0, true);
      }
      return path;
    }
    // (a route may also start on copper laid earlier for this net: then it starts right there)
    const copper = commit(c.netId, net, k, path, padAt(find(c.b), path[0]!), padAt(find(c.a), path.at(-1)!));
    neckRun = 0;
    union(c.a, c.b);
    groupCells.get(find(c.a))!.push(...copper);
    routedNow++;
    if (progress && now() - shown > PROGRESS_MS) {
      shown = now();
      progress(tracks.slice(), vias.slice(), routedNow);
    }
  };
  // (connections the kept copper or a track the agent laid already makes count as done)
  let routedNow = order.filter((c) => find(c.a) === find(c.b)).length;
  let shown = now();
  // with a pour, the signals leave a tenth of the time left to its drops and tracks (they take
  // far less than the signals, and without them the pour's pads stay apart)
  if (pours.length) until = deadline - (deadline - now()) / 10;
  for (const c of order) if (!later(c)) routeConn(c);
  until = deadline;
  dropOnto(planes.filter((pl) => OUTER.has(pl.layer)));
  /*
   * The waiting connections of the pours' nets: routed unless both ends already reach the main
   * area of their pour. That is an estimate (tracks routed after it, of another pour's net, may
   * still cut the pour), so nothing is joined here: the final areas decide, and a connection the
   * pour fails to join counts as open.
   */
  if (order.some(later)) {
    const viaPour = new Set<number>();
    for (const pl of pours) {
      const rg = region(pl);
      if (rg.main === undefined || rg.sizes[rg.main]! * G * G < 1) continue;
      for (const r of reachMain(pl, rg)) pads.forEach((_, idx) => find(idx) === r && viaPour.add(idx));
    }
    for (const c of order) {
      if (!later(c)) continue;
      if (viaPour.has(c.a) && viaPour.has(c.b)) leftToPour.push(c);
      else routeConn(c);
    }
  }

  /*
   * Stitching vias (add_vias over an area or round one): each spot that takes a via clear of other
   * nets and of pads, inside the net's planes on two layers or more (else it would join nothing).
   */
  if (input.vias?.fill.length) {
    const regions = new Map<string, ReturnType<typeof region>[]>();
    const laid = new Map<string, number>();
    const limits = input.vias.limits ?? {};
    for (const v of input.vias.fill) {
      if (v.group && limits[v.group] !== undefined && (laid.get(v.group) ?? 0) >= limits[v.group]!) continue;
      const net = numOf(v.netId);
      const i = Math.round(v.x / G);
      const j = Math.round(v.y / G);
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      const c = j * W + i;
      if (viaAt[c] === net || !viaFreeFor(net)(c)) continue;
      // a via wider than the board's: room for the rest of it too
      const extra = Math.ceil(Math.max(0, (v.pad - rules.viaPad) / 2) / G - 1e-6);
      let room = true;
      for (let dj = -extra; dj <= extra && room; dj++) {
        for (let di = -extra; di <= extra && room; di++) {
          if (Math.hypot(di, dj) > extra || i + di < 0 || j + dj < 0 || i + di >= W || j + dj >= H) continue;
          for (let l = 0; l < L && room; l++) {
            const m = maps[2]![l]![c + di + dj * W]!;
            if (m !== 0 && m !== net) room = false;
          }
        }
      }
      if (!room) continue;
      let rgs = regions.get(v.netId);
      if (!rgs) regions.set(v.netId, (rgs = planes.filter((pl) => pl.netId === v.netId).map(region)));
      // the via inside one piece of the net's copper on each layer it joins (a piece cut off
      // from the rest by a track is fine: the via is what connects it), one of them connected
      const r = Math.ceil(v.pad / 2 / G);
      const pieceAt = (rg: ReturnType<typeof region>) => {
        const at = rg.island[c]!;
        return at >= 0 && [[r, 0], [-r, 0], [0, r], [0, -r]].every(([di, dj]) => i + di! >= 0 && i + di! < W && rg.island[c + di! + dj! * W] === at) ? at : -1;
      };
      const pieces = rgs.map((rg) => ({ rg, at: pieceAt(rg) })).filter((x) => x.at >= 0);
      // a tie also joins the net's copper where the via lies wholly on a track or pad of the net
      // (a wide track on top, over the inner plane); that copper is joined to the net
      const tie = !!v.group && limits[v.group] !== undefined;
      const r0 = v.pad / 2 - 0.01;
      const onPad = (p: BoardPad) => (p.shape === 'round' ? roundPadDist(p, v.x, v.y) <= -r0 : Math.abs(v.x - p.x) <= p.w / 2 - r0 && Math.abs(v.y - p.y) <= p.h / 2 - r0);
      const onCopper = tie
        ? layers.filter((layer, l) => !pieces.some(({ rg }) => rg.l === l) && (tracks.some((t) => t.netId === v.netId && t.layer === layer && pieceList(t.pts).some(([ax, ay, bx, by]) => segDist(ax, ay, bx, by)(v.x, v.y) <= t.width / 2 - r0)) || pads.some((p, q) => padNet[q] === net && (p.drill || p.layers.includes(layer)) && onPad(p)))).length
        : 0;
      if (pieces.length + onCopper < 2 || !(onCopper || pieces.some(({ rg, at }) => at === rg.main || rg.touched.has(at)))) continue;
      stampVia(net, v.x, v.y, v.pad);
      vias.push(v);
      if (v.group) laid.set(v.group, (laid.get(v.group) ?? 0) + 1);
      // the copper it lies on reaches every layer through it (the planes then join that group)
      if (onCopper) {
        for (const [, cells] of groupCells) {
          if (!cells.some((st) => st % N === c)) continue;
          for (let l = 0; l < L; l++) cells.push(l * N + c);
          break;
        }
      }
    }
  }

  // 3. final areas, clear of all drops; 4. what reaches the main area is connected through it
  for (const pl of planes) {
    const rg = region(pl);
    if (rg.main === undefined || rg.sizes[rg.main]! * G * G < 1) continue;
    const joined = reachMain(pl, rg);
    for (let q = 1; q < joined.length; q++) union(joined[0]!, joined[q]!);
    // keep areas touched by the net's copper; the rest would be dead copper
    const alive = new Set<number>([rg.main, ...rg.touched]);
    const rects: number[] = [];
    let open = new Map<string, { i0: number; i1: number; j0: number }>();
    const close = (o: { i0: number; i1: number; j0: number }, j: number) => rects.push(r3(o.i0 * G - G / 2), r3(o.j0 * G - G / 2), r3((o.i1 - o.i0) * G), r3((j - o.j0) * G));
    for (let j = 0; j <= H; j++) {
      const next = new Map<string, { i0: number; i1: number; j0: number }>();
      if (j < H) {
        let start = -1;
        for (let i = 0; i <= W; i++) {
          const on = i < W && rg.island[j * W + i]! >= 0 && alive.has(rg.island[j * W + i]!);
          if (on && start < 0) start = i;
          if (!on && start >= 0) {
            const key = `${start}:${i}`;
            next.set(key, open.get(key) ?? { i0: start, i1: i, j0: j });
            start = -1;
          }
        }
      }
      for (const [key, o] of open) if (!next.has(key)) close(o, j);
      open = next;
    }
    zones.push({ netId: pl.netId, layer: pl.layer, rects, shape: planeShape(pl, rg, alive) });
  }
  // connections made through a plane count as routed; those left to a pour it did not join, open
  for (let q = failed.length - 1; q >= 0; q--) if (find(failed[q]!.a) === find(failed[q]!.b)) failed.splice(q, 1);
  for (const c of leftToPour) if (find(c.a) !== find(c.b)) failed.push(c);
  // plane nets were not routed as tracks: their connections are open unless the plane joined them
  const planeNets = new Set(planes.filter((pl) => !OUTER.has(pl.layer)).map((pl) => pl.netId));
  for (const c of planeOnly) if (planeNets.has(c.netId) && find(c.a) !== find(c.b)) failed.push(c);
  // plain data only: a closure from here would keep this pass's grid buffers (hundreds of MB on
  // a big board) alive while the next pass allocates its own
  const roots = Int32Array.from(pads, (_, i) => find(i));
  const blockage = probeFailed();
  const reused = kept ? { tracks: keptTracks.length, vias: keptVias.length } : undefined;
  return { tracks, vias, failed, roots, zones, timedOut, blockage, reused, drawn: drawnStatus };

  /**
   * Each open connection, again with the other nets' tracks and vias passable at a price (pads,
   * keep-outs and the edge still close the way): the cheapest way says what blocks it, and the
   * history cost grows along it, on the cells whose copper would block it, for every later pass.
   */
  function probeFailed(): Map<Conn, Blockage> {
    const out = new Map<Conn, Blockage>();
    if (!failed.length) return out;
    const idOf = new Map([...netNum].map(([id, n]) => [n, id]));
    const stop = now() + PROBE_BUDGET_MS;
    const reach = Math.ceil((rules.track + rules.clearance) / G);
    // a cell on the way gets about HISTORY_STEP in all (the disks of the path cells near it overlap)
    const inc = HISTORY_STEP / (2 * reach + 1);
    const disk: number[] = [];
    for (let dj = -reach; dj <= reach; dj++) for (let di = -reach; di <= reach; di++) if (di * di + dj * dj <= reach * reach) disk.push(di, dj);
    const seen = new Set<string>();
    for (const c of failed) {
      if (now() > stop) break;
      // one probe per pair of copper groups (a net's connections often share their blockage)
      const key = `${find(c.a)}:${find(c.b)}`;
      if (seen.has(key) || find(c.a) === find(c.b)) continue;
      seen.add(key);
      // a net on a dedicated plane has no tracks: its pads found no room for their vias
      const plane = planeOnly.includes(c) ? planes.find((pl) => pl.netId === c.netId && !OUTER.has(pl.layer) && (!pl.area || (inArea(pl, pads[c.a]!) && inArea(pl, pads[c.b]!)))) : undefined;
      if (plane) {
        out.set(c, { plane: plane.layer });
        continue;
      }
      const net = numOf(c.netId);
      const path = probe(net, groupCells.get(find(c.b))!, groupCells.get(find(c.a))!, stop);
      if (path === undefined) continue; // out of time
      if (!path) {
        out.set(c, { enclosed: true });
        continue;
      }
      const b: Blockage = {};
      const by = new Set<string>();
      for (const st of path) {
        const l = Math.floor(st / N);
        const i = st % N;
        const v = maps[0]![l]![i]!;
        if (v === 0 || v === net || ownCopper[st] === net) continue;
        if (v > 0 && idOf.has(v)) by.add(idOf.get(v)!);
        b.at ??= { x: r3((i % W) * G), y: r3(Math.floor(i / W) * G), layer: layers[l]! };
        const x = i % W;
        const y = (i - x) / W;
        for (let q = 0; q < disk.length; q += 2) {
          const xx = x + disk[q]!;
          const yy = y + disk[q + 1]!;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H) history[l * N + yy * W + xx]! += inc;
        }
      }
      if (by.size) b.blockedBy = [...by].sort();
      out.set(c, b);
    }
    return out;
  }

  /** The probe's search (see probeFailed): the path, null if there is none at all, undefined when out of time. */
  function probe(net: number, starts: number[], goals: number[], stop: number): number[] | null | undefined {
    epoch++;
    const gs = epoch;
    for (const st of goals) goal[st] = gs;
    let [gx0, gy0, gx1, gy1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const st of goals) {
      const i = st % N;
      gx0 = Math.min(gx0, i % W);
      gx1 = Math.max(gx1, i % W);
      gy0 = Math.min(gy0, Math.floor(i / W));
      gy1 = Math.max(gy1, Math.floor(i / W));
    }
    const h = (st: number) => {
      const i = st % N;
      const dx = Math.max(gx0 - (i % W), 0, (i % W) - gx1);
      const dy = Math.max(gy0 - Math.floor(i / W), 0, Math.floor(i / W) - gy1);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    const passable = (l: number, i: number) => {
      const v = fixedMap[l]![i]!;
      const st = l * N + i;
      return v === 0 || v === net || goal[st] === gs || ownCopper[st] === net;
    };
    const blocked = (l: number, i: number) => {
      const v = maps[0]![l]![i]!;
      const st = l * N + i;
      return v !== 0 && v !== net && goal[st] !== gs && ownCopper[st] !== net;
    };
    const run = ++searchNo;
    const heap = new Heap();
    for (const st of starts) {
      seenAt[st] = run;
      cost[st] = 0;
      from[st] = -1;
      heap.push(st, h(st));
    }
    let n = 0;
    while (heap.size) {
      const s = heap.pop();
      if (heap.lastPrio - h(s) > cost[s]! + 0.01) continue;
      if (goal[s] === gs) {
        const path: number[] = [];
        for (let q = s; q >= 0; q = from[q]!) path.push(q);
        return path.reverse();
      }
      if ((++n & 4095) === 0 && now() > stop) return undefined;
      const l = Math.floor(s / N);
      const i = s % N;
      const x = i % W;
      const y = (i - x) / W;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d]!;
        const ny = y + DY[d]!;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (!passable(l, ni)) continue;
        const ns = l * N + ni;
        const nc = cost[s]! + STEP[d]! + (blocked(l, ni) ? PROBE_PENALTY : 0);
        if (seenAt[ns] !== run || nc < cost[ns]!) {
          seenAt[ns] = run;
          cost[ns] = nc;
          from[ns] = s;
          heap.push(ns, nc + h(ns));
        }
      }
      if (L > 1 && !viaBlocked[i]) {
        let fits = true;
        for (let l2 = 0; l2 < L && fits; l2++) {
          const v = fixedMap[l2]![i]!;
          if (v !== 0 && v !== net && v !== EDGE) fits = false;
          if (v === EDGE && OUTER.has(layers[l2]!)) fits = false;
        }
        if (!fits) continue;
        const dear = viaNear[i] && viaAt[i] !== net ? PROBE_PENALTY : 0;
        for (let l2 = 0; l2 < L; l2++) {
          if (l2 === l || !passable(l2, i)) continue;
          const ns = l2 * N + i;
          const nc = cost[s]! + style.via + dear;
          if (seenAt[ns] !== run || nc < cost[ns]!) {
            seenAt[ns] = run;
            cost[ns] = nc;
            from[ns] = s;
            heap.push(ns, nc + h(ns));
          }
        }
      }
    }
    return null;
  }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const PROGRESS_MS = 200;
const OUTER = new Set<CopperLayer>(['F.Cu', 'B.Cu']);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * The bend (if any) between a grid point on a pad and the pad centre, so the entry is 0/45/90°
 * instead of one piece at an arbitrary angle. Preferably a straight piece (continuing the track)
 * then a diagonal one deep inside the pad into its centre; but if that straight piece would run
 * off the pad's centre band (half over its edge), the diagonal first and the straight piece on
 * the centre line. The bend lies in the box spanned by the two points: on a rectangular pad it
 * stays on the pad.
 */
function entryBend(x: number, y: number, p: BoardPad, width: number): number[] {
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
const sgn = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Math.sign(v));

/**
 * Distance of every grid point inside the outline (negative outside), cached per route input.
 * Only distances up to FIELD_BAND matter (the edge clearance plus the widest copper), so: inside
 * or out per row from where the row crosses the outline, and exact distances only in a band
 * along each edge; everything farther away is ±FIELD_FAR. (A curvy outline has hundreds of
 * edges: measuring every point to every edge would take longer than the whole routing.)
 */
const fields = new WeakMap<RouteInput, Float32Array>();
const FIELD_BAND = 2;
const FIELD_FAR = 1000;
function insideField(input: RouteInput, W: number, H: number): Float32Array {
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

/** The pieces (segments) of a flat polyline: x0, y0, x1, y1 each. */
function pieceList(pts: number[]): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let q = 0; q + 3 < pts.length; q += 2) out.push([pts[q]!, pts[q + 1]!, pts[q + 2]!, pts[q + 3]!]);
  return out;
}

/** A flat polyline, back to front. */
function reversePts(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i]!, pts[i + 1]!);
  return out;
}

/** Drop collinear points and duplicates from a flat polyline. */
function simplify(pts: number[]): number[] {
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

/** Binary min-heap of (state, priority), in typed arrays that grow as needed. */
class Heap {
  private s = new Int32Array(1024);
  private p = new Float64Array(1024);
  size = 0;
  push(state: number, prio: number) {
    if (this.size === this.s.length) {
      const s = new Int32Array(this.s.length * 2);
      s.set(this.s);
      this.s = s;
      const p = new Float64Array(this.p.length * 2);
      p.set(this.p);
      this.p = p;
    }
    const s = this.s;
    const p = this.p;
    // move the hole up rather than swapping entries
    let i = this.size++;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (p[up]! <= prio) break;
      s[i] = s[up]!;
      p[i] = p[up]!;
      i = up;
    }
    s[i] = state;
    p[i] = prio;
  }
  /** Priority of the entry returned by the last pop(). */
  lastPrio = 0;
  pop(): number {
    const s = this.s;
    const p = this.p;
    const top = s[0]!;
    this.lastPrio = p[0]!;
    const n = --this.size;
    if (n > 0) {
      // the last entry sinks from the top, the hole moving down
      const ls = s[n]!;
      const lp = p[n]!;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && p[c + 1]! < p[c]!) c++;
        if (p[c]! >= lp) break;
        s[i] = s[c]!;
        p[i] = p[c]!;
        i = c;
      }
      s[i] = ls;
      p[i] = lp;
    }
    return top;
  }
}
