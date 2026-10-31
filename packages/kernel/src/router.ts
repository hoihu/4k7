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
import { type BoardCutout, type BoardKeepout, type BoardPad, type BoardPart, type BoardRules, type CopperLayer, roundPadDist, type RouteBlockage, type RoutedLine, type Track, type Via, type Zone } from '@4k7/schema';
import { r3, segDist, segmentsOf } from './geom.ts';
import { Heap } from './heap.ts';
import { keptCopper, type KeptCopper } from './keep.ts';
import { routeLines } from './pairroute.ts';
import { passDrops } from './routedrops.ts';
import { type Conn, CORRIDOR, EDGE, G, HISTORY_STEP, inArea, now, OUTER, passGrid, type Plane, PROBE_PENALTY, PROGRESS_MS, type Style } from './routegrid.ts';
import { passPours } from './routepours.ts';
import { passSearch } from './routesearch.ts';
import { passTracks } from './routetracks.ts';

const FREE: Style = { via: 25, offAxis: 0.15 };

const GRID: Style = { via: 3, offAxis: 1 };

/** Free passes without a gain (or this share of the budget) before the grid passes take over. */
const FREE_STALE = 2;

const FREE_SHARE = 0.4;

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
   * How far the pours keep from a net's copper, where it is more than their own clearance: a line
   * at a set impedance (a coplanar line's gap to the ground beside it, or a microstrip's distance
   * so the ground does not change it).
   */
  pourGaps?: Record<string, number>;
  /**
   * Lines at a set impedance: on a layer, the plane under them (`over`, its net `plane`, `h` below).
   * Under their tracks that are there before the routing (drawn, or kept from the routing before),
   * a band on the plane's layer, half the track's width plus `h` either side of it, takes only the
   * plane's net, so other tracks and vias do not cut the plane under a line (its return path).
   */
  lines?: { netId: string; layer: CopperLayer; over: CopperLayer; plane: string; h: number }[];
  /**
   * Lines at a set impedance (pairroute.ts): routed first, and frozen as drawn copper for the rest of
   * the nets. A pair with a gap goes as one coupled track along a centre line, at the rule's width
   * and gap, its via transitions together; a single line before the others, so they keep off the
   * plane under it. A pair that cannot be coupled is routed as two nets, with the reason in
   * RouteResult.lines.
   */
  controlled?: { id: string; nets: string[]; layers: { layer: CopperLayer; width: number; gap?: number }[] }[];
  /** Net names by id, for what the router says about lines at a set impedance. */
  netNames?: Record<string, string>;
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
  vias?: {
    fixed: Via[];
    fill: Via[];
    limits?: Record<string, number>;
    drops?: { group: string; componentId: string; number: string; vias: { x: number; y: number }[] }[];
    stubs?: Track[];
    /** Fences along a line: spots on both sides of the `line` net's tracks once routed, every `pitch`, `gap` (its gap to the ground; default the clearance) plus half a via off each track's edge. */
    along?: { group: string; netId: string; line: string; pitch: number; drill: number; pad: number; gap?: number }[];
  };
  /**
   * Copper of the routing before (incremental routing): what still holds for this board (see
   * keep.ts) is kept as it lies, and only the connections it leaves open are routed. Where it is
   * in the way of one of those, the nets in the way are routed again, and failing that the whole
   * board.
   */
  keep?: { tracks: Track[]; vias: Via[] };
  /**
   * Drawn copper (the agent's own, BoardSettings.drawn): there from the start exactly as it lies,
   * never ripped up nor checked here (the DRC judges it). With it the router lays copper only for
   * `only`: the open connections of those nets (their pads' drops to a plane too), or those pairs
   * of pads; without `only`, nothing (it just fills the pours and says what is connected). Open
   * connections are then counted between the pieces of copper each net is in, whatever the
   * connections the drawn copper made.
   */
  drawn?: { tracks: Track[]; vias: Via[]; only?: { nets?: string[]; pairs?: [BoardPad, BoardPad][] } };
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
  /**
   * Keep-outs: no tracks of the layers named where they forbid tracks (but near the pads of the
   * part one is attached to), no vias where they forbid vias, the pours cleared where they forbid pours.
   */
  keepouts?: BoardKeepout[];
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
  /** What was done with the lines at a set impedance routed first (RouteInput.controlled). */
  lines?: RoutedLine[];
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

export function route(input: RouteInput, passes = 40): RouteResult {
  return input.controlled?.length ? routeLines(input, passes, routeNets) : routeNets(input, passes);
}

function routeNets(input: RouteInput, passes = 40): RouteResult {
  const pads: BoardPad[] = input.parts.flatMap((p) => p.pads);
  const owner = input.parts.flatMap((p) => p.pads.map(() => p));
  const conns = connections(pads);
  let best: ReturnType<typeof routeOnce> | null = null;
  // nets with a dedicated (inner) plane are connected through it, not with tracks; so are two
  // pads of a net inside the same area plane of it (its other pads get tracks)
  const dedicated = new Set((input.planes ?? []).filter((pl) => !OUTER.has(pl.layer) && !pl.area).map((pl) => pl.netId));
  const areas = (input.planes ?? []).filter((pl) => !OUTER.has(pl.layer) && pl.area);
  const viaArea = (c: Conn) => areas.some((pl) => pl.netId === c.netId && inArea(pl, pads[c.a]!) && inArea(pl, pads[c.b]!));
  // drawn copper: only the connections asked for are routed (see RouteInput.drawn)
  const scope = input.drawn ? new Set(input.drawn.only?.nets ?? []) : null;
  const inScope = (c: Conn) => !scope || scope.has(c.netId);
  const planeOnly = conns.filter((c) => (dedicated.has(c.netId) || viaArea(c)) && inScope(c));
  const throughPlane = new Set(planeOnly);
  const pairs: Conn[] = (input.drawn?.only?.pairs ?? []).map(([a, b]) => ({ netId: a.netId!, a: pads.indexOf(a), b: pads.indexOf(b), len: Math.hypot(a.x - b.x, a.y - b.y) }));
  const firstOrder = [...pairs, ...conns.filter((c) => !throughPlane.has(c) && inScope(c) && !dedicated.has(c.netId) && !viaArea(c))].sort((x, y) => x.len - y.len || x.netId.localeCompare(y.netId) || x.a - y.a);
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
  const keptNets = new Set(keep?.pieces.map((pc) => pc.netId));
  const letGo = new Set<string>();
  let keeping = keptNets.size > 0;
  let rounds = 0;
  // fewest open since routing from scratch began (the kept passes' best does not count against it)
  let phaseBest: number | null = null;
  const drawn = input.drawn ? keptCopper(input, input.drawn, true) : null;
  const keptNow = (): KeptCopper | null => joinKept(keep && keeping ? { ...keep, pieces: keep.pieces.filter((pc) => !letGo.has(pc.netId)) } : null, drawn);
  // before the first pass the best there is: nothing routed
  input.onBest?.(result({ tracks: [], vias: [], zones: [], failed: [...order, ...planeOnly], roots: Int32Array.from(pads, (_, i) => i), timedOut: false, blockage: new Map(), reused: undefined }, 0));
  for (let pass = 0; pass < passes; pass++) {
    const bestOpen = best ? best.failed.length : null;
    const progress = input.onProgress ? (tracks: Track[], vias: Via[], done: number) => input.onProgress!({ pass: pass + 1, tracks, vias, connections: conns.length, done, bestOpen, elapsedMs: now() - t0, grid: style === GRID }) : undefined;
    const r = routeOnce(input, pads, owner, order, deadline, planeOnly, early, history, style, keptNow(), progress);
    ran++;
    // each pass's copper, so even a quick pass shows (the next one starts from nothing)
    progress?.(r.tracks, r.vias, conns.length - r.failed.length);
    const improved = !best || r.failed.length < best.failed.length || (r.failed.length === best.failed.length && pourOpen(r) < pourOpen(best));
    if (improved) {
      best = r;
      if (r.failed.length) input.onBest?.(result(r, ran));
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
  return result(best ?? routeOnce(input, pads, owner, order, deadline, planeOnly, new Set(), history, style, keptNow()), ran);

  /** A pass's result as the caller sees it. */
  function result(r: ReturnType<typeof routeOnce>, ran: number): RouteResult {
    const nets = new Set(conns.map((c) => c.netId));
    if (input.drawn) r = { ...r, failed: openBetween(r.roots, r.failed) };
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
    };
  }

  /**
   * Drawn copper: the connections still open, one per pair of pieces a net's copper is in (the
   * shortest), whatever connections the copper made; one the router tried keeps its blockage.
   */
  function openBetween(roots: Int32Array, tried: Conn[]): Conn[] {
    const key = (a: number, b: number) => (roots[a]! < roots[b]! ? `${roots[a]}:${roots[b]}` : `${roots[b]}:${roots[a]}`);
    const triedAt = new Map(tried.map((t) => [key(t.a, t.b), t]));
    const group = new Map<number, number>();
    const find = (g: number): number => {
      const p = group.get(g) ?? g;
      if (p === g) return g;
      const r = find(p);
      group.set(g, r);
      return r;
    };
    const open: Conn[] = [];
    for (const c of [...conns].sort((x, y) => x.len - y.len)) {
      const ga = find(roots[c.a]!);
      const gb = find(roots[c.b]!);
      if (ga === gb) continue;
      group.set(gb, ga);
      open.push(triedAt.get(key(c.a, c.b)) ?? c);
    }
    return open;
  }
}

/** Two sets of kept copper as one (the pad lists stay; track and via indices shift). */
function joinKept(a: KeptCopper | null, b: KeptCopper | null): KeptCopper | null {
  if (!a || !b) return a ?? b;
  const t = a.tracks.length;
  const v = a.vias.length;
  return {
    tracks: [...a.tracks, ...b.tracks],
    vias: [...a.vias, ...b.vias],
    pieces: [...a.pieces, ...b.pieces.map((pc) => ({ ...pc, tracks: pc.tracks.map((i) => i + t), vias: pc.vias.map((i) => i + v) }))],
  };
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
  progress?: (tracks: Track[], vias: Via[], done: number) => void,
) {
  const grid = passGrid({ input, pads, owner, order, deadline, planeOnly, early, history, style, kept, progress });
  const finder = passSearch(grid);
  const lay = passTracks(grid, finder);
  const pouring = passPours(grid, finder, lay);
  const dropper = passDrops(grid, finder, lay, pouring);
  const { rules, layers, W, H, N, L, netNum, numOf, padNet, widths, trackClass, maps, viaAt, viaNear, VIA_SPACING, stampVia, fixedMap, keptTracks, keptVias, escapes, ownCopper, escapeOf, offCentre, find, groupCells, union, tracks, vias, failed } = grid;
  const { clock, cost, from, goal, seenAt, DX, DY, STEP, freeFor, viaBlocked, viaFreeFor, deepestCells, search, corridor, widen } = finder;
  const { commit, reserved, clearOf, padAt } = lay;
  const { zones, planes, region, planeShape } = pouring;
  const { reachMain, reserveDrops, dropOnto } = dropper;
  let epoch = 0;
  let timedOut = false;
  /*
   * Fan-out first: pads on a net with a dedicated inner plane drop onto it before the signals are
   * routed (the signals then go round the drop vias; routed first, a signal can shut a pad off
   * from every via site). Outer pours come last: they fill what the tracks leave; their drop
   * sites are reserved now (see reserveDrops).
   */
  // (drawn copper: only the nets asked for drop onto their planes; the others' drops are drawn)
  const mayDrop = (pl: Plane) => !input.drawn || !!input.drawn.only?.nets?.includes(pl.netId);
  dropOnto(planes.filter((pl) => !OUTER.has(pl.layer) && mayDrop(pl)));
  // pours of nets without an inner plane (GND on B.Cu of a 2-layer board); a local pour (an area
  // on an outer layer) only joins what reaches it, as an area plane does
  const pours = planes.filter((pl) => OUTER.has(pl.layer) && !pl.area && !planes.some((q) => q.netId === pl.netId && !OUTER.has(q.layer)));
  reserveDrops(pours.filter(mayDrop));
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
    if (now() > clock.until) {
      timedOut = true;
      failed.push(c);
      return;
    }
    const pa = pads[c.a]!;
    const pb = pads[c.b]!;
    // the net's own width, else power width, each only where both pads can take it
    const takes = (w: number) => Math.min(pa.w, pa.h) >= w * 0.9 && Math.min(pb.w, pb.h) >= w * 0.9;
    const own = input.netWidths?.[c.netId];
    const wide = input.powerNets.has(c.netId) && takes(rules.powerTrack);
    // too wide for a pad: the widest class that still fits (never below the signal width)
    const fitting = (w: number) => widths.reduce((best, x, i) => (i !== 2 && x <= w && takes(x) && x > widths[best]! ? i : best), 0);
    const chosen = own ? (own <= rules.track || takes(own) ? trackClass(own) : fitting(own)) : wide ? 1 : 0;
    // a power track that finds no way is necked down to the signal width (a width the user set
    // for the net is not: that one is a requirement)
    let k = chosen;
    let path = attempt(chosen);
    if (!path && chosen === 1 && !own && now() <= deadline) path = attempt((k = 0));
    if (!path) {
      failed.push(c);
      return;
    }
    function attempt(k: number): number[] | null {
      // an escape stub is reserved at the signal width: a wider track may run along it only where
      // it keeps its clearance at that width
      const escapeOk = (st: number) => {
        const idx = escapeOf.get(st);
        if (idx === undefined || widths[k]! <= rules.track) return true;
        const e = escapes[idx]!;
        const p = pads[idx]!;
        return clearOf(net, e.l, widths[k]!, [[p.x, p.y, e.p1.x, e.p1.y], [e.p1.x, e.p1.y, e.ex, e.ey]]);
      };
      epoch++;
      const goalStamp = epoch;
      const goalCells = groupCells.get(find(c.a))!.filter(escapeOk);
      for (const st of goalCells) goal[st] = goalStamp;
      // end where the track fits, on its pad's centre line; failing that where it fits; failing
      // that deepest inside the pad
      const fits = (st: number) => freeFor(net, k)(Math.floor(st / N), st % N);
      const centred = (st: number) => fits(st) && !offCentre(net, k, st);
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
    union(c.a, c.b);
    groupCells.get(find(c.a))!.push(...copper);
    routedNow++;
    if (progress && now() - shown > PROGRESS_MS) {
      shown = now();
      progress(tracks.slice(), vias.slice(), routedNow);
    }
  };
  // (connections the kept copper already makes count as done)
  let routedNow = kept ? order.filter((c) => find(c.a) === find(c.b)).length : 0;
  let shown = now();
  // with a pour, the signals leave a tenth of the time left to its drops and tracks (they take
  // far less than the signals, and without them the pour's pads stay apart)
  if (pours.length) clock.until = deadline - (deadline - now()) / 10;
  for (const c of order) if (!later(c)) routeConn(c);
  clock.until = deadline;
  dropOnto(planes.filter((pl) => OUTER.has(pl.layer) && mayDrop(pl)));
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
  // fences along a line: spots beside its tracks as they are now routed, both sides, every pitch
  const alongSpots: Via[] = [];
  for (const a of input.vias?.along ?? []) {
    for (const t of tracks) {
      if (t.netId !== a.line) continue;
      // (just inside the pour beside the line: its edge, the grid's margin round it, and a little)
      const off = t.width / 2 + Math.max(rules.clearance, a.gap ?? 0) + a.pad / 2 + 0.15;
      // (the distance along the track to the next spot, and to where the piece starts)
      let next = 0;
      let at = 0;
      for (const [ax, ay, bx, by] of segmentsOf(t.pts)) {
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1e-6) continue;
        const [ux, uy] = [(bx - ax) / len, (by - ay) / len];
        for (; next <= at + len + 1e-9; next += a.pitch) {
          const [x, y] = [ax + ux * (next - at), ay + uy * (next - at)];
          for (const sgn of [1, -1]) alongSpots.push({ netId: a.netId, x: r3(x - sgn * uy * off), y: r3(y + sgn * ux * off), drill: a.drill, pad: a.pad, group: a.group });
        }
        at += len;
      }
    }
  }
  const fillSpots = [...(input.vias?.fill ?? []), ...alongSpots];
  if (fillSpots.length) {
    const regions = new Map<string, ReturnType<typeof region>[]>();
    const laid = new Map<string, number>();
    const limits = input.vias?.limits ?? {};
    for (const v of fillSpots) {
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
        ? layers.filter((layer, l) => !pieces.some(({ rg }) => rg.l === l) && (tracks.some((t) => t.netId === v.netId && t.layer === layer && segmentsOf(t.pts).some(([ax, ay, bx, by]) => segDist(ax, ay, bx, by)(v.x, v.y) <= t.width / 2 - r0)) || pads.some((p, q) => padNet[q] === net && (p.drill || p.layers.includes(layer)) && onPad(p)))).length
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
    // what was left out (dead copper): the islands that touch nothing of the net, those of 1 mm² and more counted
    const lost = new Map<number, { n: number; sx: number; sy: number }>();
    for (let c = 0; c < N; c++) {
      const isl = rg.island[c]!;
      if (isl < 0 || alive.has(isl)) continue;
      const e = lost.get(isl) ?? { n: 0, sx: 0, sy: 0 };
      e.n++;
      e.sx += (c % W) * G;
      e.sy += Math.floor(c / W) * G;
      lost.set(isl, e);
    }
    const dead = [...lost.values()].filter((e) => e.n * G * G >= 1).sort((x, y) => y.n - x.n);
    const removed = dead.length ? { islands: dead.length, area: Math.round(dead.reduce((s, e) => s + e.n, 0) * G * G * 10) / 10, at: { x: r3(dead[0]!.sx / dead[0]!.n), y: r3(dead[0]!.sy / dead[0]!.n) } } : undefined;
    zones.push({ netId: pl.netId, layer: pl.layer, rects, shape: planeShape(pl, rg, alive), ...(removed ? { removed } : {}) });
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
  return { tracks, vias, failed, roots, zones, timedOut, blockage, reused };

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
    const run = ++clock.searches;
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
