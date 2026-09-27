/**
 * Autorouter: a maze router (A*) on a fine grid across all copper layers, 8 directions (45°
 * tracks) plus vias. Clearance is built into the grid: for every track-width class a map says,
 * per cell and layer, which net may put a track centre there (computed from exact distances
 * to pads, tracks, vias and the board edge). Connections follow each net's minimum spanning
 * tree, shortest first; a connection may end on any copper already joined to its net.
 * Failed connections are routed first in the next pass (simple rip-up and retry).
 */
import type { BoardPad, BoardPart, BoardRules, CopperLayer, Track, Via, Zone } from '@tracewise/schema';

const G = 0.1; // grid pitch, mm
const MULTI = -1; // near copper of two nets: nobody may route here
const EDGE = -2; // too close to the board edge
const VIA_COST = 25; // in grid steps (2.5 mm of track)
const TURN_COST = 0.6;
const OFF_AXIS_COST = 0.15; // prefer horizontal on F.Cu, vertical on B.Cu

export interface RouteInput {
  outline: { w: number; h: number };
  layers: CopperLayer[];
  rules: BoardRules;
  parts: BoardPart[];
  /** Nets drawn with power width when their pads allow it. */
  powerNets: Set<string>;
  /**
   * Planes: an inner layer dedicated to one net (no tracks there), or a pour on an outer layer
   * filling what the tracks leave. Pads of the net drop onto their plane with a via.
   */
  planes?: { netId: string; layer: CopperLayer }[];
  /** Stop routing after this many milliseconds; what is left is reported unrouted. */
  budgetMs?: number;
}

export interface RouteResult {
  tracks: Track[];
  vias: Via[];
  zones: Zone[];
  /** Pairs of pads (by index into the flat pad list) that ended up connected. */
  connected: (netId: string, a: BoardPad, b: BoardPad) => boolean;
  failed: { netId: string; a: BoardPad; b: BoardPad }[];
  netsTotal: number;
  netsDone: number;
  /** Routing stopped at the time budget. */
  timedOut: boolean;
}

interface Conn {
  netId: string;
  a: number;
  b: number;
  len: number;
}

export function route(input: RouteInput, passes = 8): RouteResult {
  const pads: BoardPad[] = input.parts.flatMap((p) => p.pads);
  const owner = input.parts.flatMap((p) => p.pads.map(() => p));
  const conns = connections(pads);
  let best: ReturnType<typeof routeOnce> | null = null;
  // nets with a dedicated (inner) plane are connected through it, not with tracks
  const dedicated = new Set((input.planes ?? []).filter((pl) => !OUTER.has(pl.layer)).map((pl) => pl.netId));
  const planeOnly = conns.filter((c) => dedicated.has(c.netId));
  let order = conns.filter((c) => !dedicated.has(c.netId)).sort((x, y) => x.len - y.len || x.netId.localeCompare(y.netId) || x.a - y.a);
  const t0 = now();
  const deadline = t0 + (input.budgetMs ?? 15_000);
  for (let pass = 0; pass < passes; pass++) {
    const r = routeOnce(input, pads, owner, order, deadline, planeOnly);
    if (!best || r.failed.length < best.failed.length) best = r;
    if (!r.failed.length || r.timedOut) break;
    // another pass only if one fits comfortably in the budget
    if (now() + (now() - t0) / (pass + 1) > deadline) break;
    // failures first; the rest alternately in the old order and longest first (a different
    // order gives the router different room; the best pass wins)
    const failed = new Set(r.failed);
    const rest = order.filter((c) => !failed.has(c));
    order = [...order.filter((c) => failed.has(c)), ...(pass % 2 ? [...rest].sort((x, y) => y.len - x.len || x.netId.localeCompare(y.netId)) : rest)];
  }
  const r = best ?? routeOnce(input, pads, owner, order, deadline, planeOnly);
  const nets = new Set(conns.map((c) => c.netId));
  const failedNets = new Set(r.failed.map((c) => c.netId));
  return {
    tracks: r.tracks,
    vias: r.vias,
    zones: r.zones,
    connected: (netId, a, b) => {
      const ia = pads.indexOf(a);
      const ib = pads.indexOf(b);
      return ia >= 0 && ib >= 0 && r.find(ia) === r.find(ib) && pads[ia]!.netId === netId;
    },
    failed: r.failed.map((c) => ({ netId: c.netId, a: pads[c.a]!, b: pads[c.b]! })),
    netsTotal: nets.size,
    netsDone: [...nets].filter((n) => !failedNets.has(n)).length,
    timedOut: r.timedOut,
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

function routeOnce(input: RouteInput, pads: BoardPad[], owner: BoardPart[], order: Conn[], deadline: number, planeOnly: Conn[] = []) {
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

  // width classes: 0 signal track, 1 power track, 2 via
  const widths = [rules.track, rules.powerTrack, rules.viaPad];
  const maps = widths.map(() => Array.from({ length: L }, () => new Int32Array(N)));

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
      ? (x: number, y: number) => Math.hypot(x - p.x, y - p.y) - Math.min(p.w, p.h) / 2
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
  const stampVia = (net: number, x: number, y: number) => {
    for (let l = 0; l < L; l++) stamp(l, net, x, y, x, y, rules.viaPad / 2, (px, py) => Math.hypot(px - x, py - y));
    const ci = Math.round(x / G);
    const cj = Math.round(y / G);
    viaAt[cj * W + ci] = net;
    const r = Math.ceil(VIA_SPACING / G);
    for (let j = Math.max(0, cj - r); j <= Math.min(H - 1, cj + r); j++) {
      for (let i = Math.max(0, ci - r); i <= Math.min(W - 1, ci + r); i++) if (Math.hypot((i - ci) * G, (j - cj) * G) < VIA_SPACING - 1e-6) viaNear[j * W + i] = 1;
    }
  };
  /** Record a via (once per place and net). */
  const addVia = (netId: string, net: number, px: number, py: number) => {
    const x = r3(px);
    const y = r3(py);
    if (vias.some((v) => v.netId === netId && Math.abs(v.x - x) < 1e-6 && Math.abs(v.y - y) < 1e-6)) return;
    vias.push({ netId, x, y, drill: rules.viaDrill, pad: rules.viaPad });
    stampVia(net, px, py);
  };

  // board edge
  for (let k = 0; k < widths.length; k++) {
    const keep = rules.edgeClearance + widths[k]! / 2;
    for (let l = 0; l < L; l++) {
      const m = maps[k]![l]!;
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          const x = i * G;
          const y = j * G;
          if (x < keep || y < keep || x > input.outline.w - keep || y > input.outline.h - keep) m[j * W + i] = EDGE;
        }
      }
    }
  }
  pads.forEach((p, i) => stampPad(p, padNet[i]!));
  // dedicated plane layers carry no tracks (vias still pass through, with clearance)
  for (const pl of input.planes ?? []) {
    const l = layerIdx.get(pl.layer);
    if (l === undefined || OUTER.has(pl.layer)) continue;
    maps[0]![l]!.fill(EDGE);
    maps[1]![l]!.fill(EDGE);
  }

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
        if (v === 0 || v === padNet[idx]) return { state: l * N + j * W + i, p1, l, ex: i * G, ey: j * G };
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
      const inset = p.shape === 'round' ? Math.min(p.w, p.h) / 2 - Math.hypot(x - p.x, y - p.y) : Math.min(p.w / 2 - Math.abs(x - p.x), p.h / 2 - Math.abs(y - p.y));
      if (ownCopper[s] !== padNet[i] || inset > ownInset[s]!) ownInset[s] = inset;
      ownCopper[s] = padNet[i]!;
    }
  });
  escapes.forEach((e, idx) => e && padCells[idx]!.push(e.state));
  // reserve every escape stub for its net before routing, so earlier routes cannot wall it off
  escapes.forEach((e, idx) => {
    if (!e) return;
    const p = pads[idx]!;
    stampSeg(e.l, padNet[idx]!, p.x, p.y, e.p1.x, e.p1.y, rules.track);
    stampSeg(e.l, padNet[idx]!, e.p1.x, e.p1.y, e.ex, e.ey, rules.track);
    ownCopper[e.state] = padNet[idx]!;
  });

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

  // A* buffers
  const S = L * N;
  const cost = new Float32Array(S);
  const from = new Int32Array(S);
  const dirOf = new Int8Array(S);
  const goal = new Int32Array(S);
  let epoch = 0;
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
      const b = part.courtyard;
      for (let j = Math.max(0, Math.floor(b.y / G)); j <= Math.min(H - 1, Math.ceil((b.y + b.h) / G)); j++) {
        for (let i = Math.max(0, Math.floor(b.x / G)); i <= Math.min(W - 1, Math.ceil((b.x + b.w) / G)); i++) viaBlocked[j * W + i] = 1;
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

  /** A* from any start state to a goal state; returns the path (start → goal) or null. */
  const search = (net: number, k: number, starts: number[], isGoal: (s: number) => boolean, target: { x: number; y: number }, goalFits = true): number[] | null => {
    const free = freeFor(net, k);
    const viaFree = viaFreeFor(net);
    cost.fill(Infinity);
    const heap = new Heap();
    const tx = target.x / G;
    const ty = target.y / G;
    const h = (s: number) => {
      const i = s % N;
      const dx = Math.abs((i % W) - tx);
      const dy = Math.abs(Math.floor(i / W) - ty);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    // starts and goals only where this width fits (fall back to all if none does)
    const usable = (st: number) => free(Math.floor(st / N), st % N);
    const seeds = starts.filter(usable);
    for (const s of seeds.length ? seeds : starts) {
      cost[s] = 0;
      from[s] = -1;
      dirOf[s] = -1;
      heap.push(s, h(s));
    }
    let reached = -1;
    let expanded = 0;
    // bounded per connection (turn costs allow some re-expansion); the overall time budget
    // protects big boards
    const LIMIT = S * 3;
    while (heap.size) {
      const s = heap.pop();
      // outdated entry: this state was reached more cheaply since it was pushed
      if (heap.lastPrio - h(s) > cost[s]! + 1e-6) continue;
      if (isGoal(s) && (usable(s) || !goalFits)) {
        reached = s;
        break;
      }
      if (++expanded > LIMIT) break;
      if ((expanded & 4095) === 0 && now() > deadline) break;
      const l = Math.floor(s / N);
      const i = s % N;
      const x = i % W;
      const y = (i - x) / W;
      const base = cost[s]!;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d]!;
        const ny = y + DY[d]!;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        const ns = l * N + ni;
        if (!free(l, ni) && !isGoal(ns)) continue;
        // diagonal steps: both orthogonal neighbours must be clear too (no corner cutting)
        if (DX[d] !== 0 && DY[d] !== 0 && (!free(l, y * W + nx) || !free(l, ny * W + x))) continue;
        const horizontal = DY[d] === 0;
        const vertical = DX[d] === 0;
        const off = layers[l] === 'F.Cu' ? !horizontal : layers[l] === 'B.Cu' ? !vertical : false;
        const nc = base + STEP[d]! + (dirOf[s]! >= 0 && dirOf[s] !== d ? TURN_COST : 0) + (off ? OFF_AXIS_COST : 0);
        if (nc < cost[ns]!) {
          cost[ns] = nc;
          from[ns] = s;
          dirOf[ns] = d;
          heap.push(ns, nc + h(ns));
        }
      }
      if (L > 1 && viaFree(i)) {
        for (let l2 = 0; l2 < L; l2++) {
          if (l2 === l) continue;
          const ns = l2 * N + i;
          const nc = base + VIA_COST;
          if (nc < cost[ns]!) {
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

  /** Turn a path into tracks and vias, reserve its copper; pad ends start/stop at pad centres. */
  const commit = (netId: string, net: number, width: number, path: number[], startPad: number, endPad: number, endVia = false) => {
    const runs: { l: number; pts: number[] }[] = [];
    for (const s of path) {
      const l = Math.floor(s / N);
      const i = s % N;
      const px = (i % W) * G;
      const py = Math.floor(i / W) * G;
      const run = runs.at(-1);
      if (!run || run.l !== l) {
        if (run) addVia(netId, net, px, py);
        runs.push({ l, pts: [px, py] });
      } else run.pts.push(px, py);
    }
    if (startPad >= 0 && runs[0]) {
      const sp = pads[startPad]!;
      const se = escapes[startPad];
      runs[0].pts.unshift(...(se && se.state === path[0] ? [sp.x, sp.y, se.p1.x, se.p1.y] : [sp.x, sp.y]));
    }
    const last = runs.at(-1)!;
    if (endPad >= 0) {
      const ee = escapes[endPad];
      last.pts.push(...(ee && ee.state === path.at(-1) ? [ee.p1.x, ee.p1.y] : []), pads[endPad]!.x, pads[endPad]!.y);
    }
    if (endVia) {
      // a drop to a plane: the via at the end of the path
      const s = path.at(-1)!;
      const i = s % N;
      const px = (i % W) * G;
      const py = Math.floor(i / W) * G;
      addVia(netId, net, px, py);
    }
    for (const run of runs) {
      const pts = simplify(run.pts);
      if (pts.length < 4) continue;
      tracks.push({ netId, layer: layers[run.l]!, width, pts: pts.map(r3) });
      for (let q = 0; q + 3 < pts.length; q += 2) stampSeg(run.l, net, pts[q]!, pts[q + 1]!, pts[q + 2]!, pts[q + 3]!, width);
    }
  };
  const padAt = (root: number, state: number) => pads.findIndex((_, idx) => find(idx) === root && padCells[idx]!.includes(state));

  let timedOut = false;
  for (const c of order) {
    const net = numOf(c.netId);
    if (find(c.a) === find(c.b)) continue;
    if (timedOut || now() > deadline) {
      timedOut = true;
      failed.push(c);
      continue;
    }
    const pa = pads[c.a]!;
    const pb = pads[c.b]!;
    // power width only where both pads can take it
    const wide = input.powerNets.has(c.netId) && Math.min(pa.w, pa.h) >= rules.powerTrack * 0.9 && Math.min(pb.w, pb.h) >= rules.powerTrack * 0.9;
    const k = wide ? 1 : 0;
    epoch++;
    const goalStamp = epoch;
    for (const st of groupCells.get(find(c.a))!) goal[st] = goalStamp;
    const goalCells = groupCells.get(find(c.a))!;
    const fits = freeFor(net, k);
    const goalFits = goalCells.some((st) => fits(Math.floor(st / N), st % N));
    const path = search(net, k, groupCells.get(find(c.b))!, (st) => goal[st] === goalStamp, pa, goalFits);
    if (!path) {
      failed.push(c);
      continue;
    }
    // (a route may also start on copper laid earlier for this net: then it starts right there)
    commit(c.netId, net, widths[k]!, path, padAt(find(c.b), path[0]!), padAt(find(c.a), path.at(-1)!));
    union(c.a, c.b);
    groupCells.get(find(c.a))!.push(...path);
  }

  /*
   * Planes and pours. Inner planes are dedicated to their net (no tracks there); pours on outer
   * layers fill what the tracks leave. Every group of a plane net that does not reach its plane
   * drops onto it (short track + via). Order: provisional plane areas → drops for all planes →
   * final areas (now clear of every drop via of other nets) → connectivity.
   */
  const zones: Zone[] = [];
  const planes = (input.planes ?? []).filter((pl) => layerIdx.has(pl.layer) && netNum.has(pl.netId));
  const margin = G * 0.75; // a cell stands for a G × G square: keep its corners clear
  const region = (pl: { netId: string; layer: CopperLayer }) => {
    const l = layerIdx.get(pl.layer)!;
    const pnet = numOf(pl.netId);
    const ok = new Uint8Array(N);
    const keep = rules.edgeClearance + margin;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const x = i * G;
        const y = j * G;
        ok[j * W + i] = x >= keep && y >= keep && x <= input.outline.w - keep && y <= input.outline.h - keep ? 1 : 0;
      }
    }
    const clearAround = (x0: number, y0: number, x1: number, y1: number, extra: number, dist: (x: number, y: number) => number) => {
      const reach = rules.clearance + extra + margin;
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
    const gap = Math.max(rules.clearance, 0.25);
    const spoke = Math.min(0.4, Math.max(0.3, rules.track));
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
    for (const v of vias) if (v.netId === pl.netId) relief(v.x, v.y, v.pad / 2, v.pad / 2, (x, y) => Math.hypot(x - v.x, y - v.y) - v.pad / 2);
    pads.forEach((p, idx) => {
      if (padNet[idx] !== pnet || !(p.drill || p.layers.includes(pl.layer))) return;
      relief(p.x, p.y, p.w / 2, p.h / 2, padDist(p));
    });
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
    return { l, pnet, island, sizes, main, touched };
  };

  // 1. provisional areas; 2. drops of every group that does not reach its plane
  const dropVias = new Map<number, { x: number; y: number }[]>(); // pad root → drop vias
  for (const pl of planes) {
    const rg = region(pl);
    if (rg.main === undefined || rg.sizes[rg.main]! * G * G < 1) continue;
    const roots = [...new Set(pads.map((_, idx) => find(idx)).filter((r) => padNet[r] === rg.pnet))];
    for (const r of roots) {
      if (timedOut || now() > deadline) break;
      const reaches = groupCells.get(r)!.some((st) => Math.floor(st / N) === rg.l && rg.island[st % N] === rg.main);
      if (reaches) continue;
      const starts = groupCells.get(r)!.filter((st) => Math.floor(st / N) !== rg.l);
      if (!starts.length) continue;
      const path = search(rg.pnet, 0, starts, (st) => {
        // a via site well inside the main area (the via then joins the plane)
        if (Math.floor(st / N) === rg.l) return false;
        const i = st % N;
        if (viaAt[i] === rg.pnet && rg.island[i] === rg.main) return true; // join an existing via
        if (rg.island[i] !== rg.main || !viaFreeFor(rg.pnet)(i)) return false;
        const vx = (i % W) * G;
        const vy = Math.floor(i / W) * G;
        const rr = rules.viaPad / 2 + margin + rules.clearance;
        for (const [dx, dy] of [[rr, 0], [-rr, 0], [0, rr], [0, -rr]] as const) {
          const ii = Math.round((vx + dx) / G) + Math.round((vy + dy) / G) * W;
          if (rg.island[ii] !== rg.main) return false;
        }
        return true;
      }, pads[r]!);
      if (!path) continue;
      commit(pl.netId, rg.pnet, rules.track, path, padAt(r, path[0]!), -1, true);
      groupCells.get(r)!.push(...path);
      const end = path.at(-1)! % N;
      dropVias.set(r, [...(dropVias.get(r) ?? []), { x: (end % W) * G, y: Math.floor(end / W) * G }]);
    }
  }

  // 3. final areas, clear of all drops; 4. what reaches the main area is connected through it
  for (const pl of planes) {
    const rg = region(pl);
    if (rg.main === undefined || rg.sizes[rg.main]! * G * G < 1) continue;
    const roots = [...new Set(pads.map((_, idx) => find(idx)).filter((r) => padNet[r] === rg.pnet))];
    const inMain = (x: number, y: number) => rg.island[Math.round(x / G) + Math.round(y / G) * W] === rg.main;
    const joined = roots.filter(
      (r) =>
        groupCells.get(r)!.some((st) => Math.floor(st / N) === rg.l && rg.island[st % N] === rg.main) ||
        (dropVias.get(r) ?? []).some((v) => inMain(v.x, v.y)) ||
        pads.some((p, idx) => find(idx) === r && (p.drill || p.layers.includes(pl.layer)) && inMain(p.x, p.y)),
    );
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
    zones.push({ netId: pl.netId, layer: pl.layer, rects });
  }
  // connections made through a plane count as routed
  for (let q = failed.length - 1; q >= 0; q--) if (find(failed[q]!.a) === find(failed[q]!.b)) failed.splice(q, 1);
  // plane nets were not routed as tracks: their connections are open unless the plane joined them
  const planeNets = new Set(planes.filter((pl) => !OUTER.has(pl.layer)).map((pl) => pl.netId));
  for (const c of planeOnly) if (planeNets.has(c.netId) && find(c.a) !== find(c.b)) failed.push(c);
  return { tracks, vias, failed, find, zones, timedOut };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const OUTER = new Set<CopperLayer>(['F.Cu', 'B.Cu']);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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
      if (Math.abs(cross) < 1e-9 && (bx - ax) * (x - bx) + (by - ay) * (y - by) >= 0) {
        out[n - 2] = x;
        out[n - 1] = y;
        continue;
      }
    }
    out.push(x, y);
  }
  return out;
}

/** Binary min-heap of (state, priority). */
class Heap {
  private s: number[] = [];
  private p: number[] = [];
  get size() {
    return this.s.length;
  }
  push(state: number, prio: number) {
    const s = this.s;
    const p = this.p;
    s.push(state);
    p.push(prio);
    let i = s.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (p[up]! <= p[i]!) break;
      [s[up], s[i]] = [s[i]!, s[up]!];
      [p[up], p[i]] = [p[i]!, p[up]!];
      i = up;
    }
  }
  /** Priority of the entry returned by the last pop(). */
  lastPrio = 0;
  pop(): number {
    const s = this.s;
    const p = this.p;
    const top = s[0]!;
    this.lastPrio = p[0]!;
    const ls = s.pop()!;
    const lp = p.pop()!;
    if (s.length) {
      s[0] = ls;
      p[0] = lp;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < s.length && p[l]! < p[m]!) m = l;
        if (r < s.length && p[r]! < p[m]!) m = r;
        if (m === i) break;
        [s[m], s[i]] = [s[i]!, s[m]!];
        [p[m], p[i]] = [p[i]!, p[m]!];
        i = m;
      }
    }
    return top;
  }
}
