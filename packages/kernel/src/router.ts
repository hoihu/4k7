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
  /** Pour this net over the free area of this layer (ground plane) and drop its pads onto it. */
  pour?: { netId: string; layer: CopperLayer };
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
}

interface Conn {
  netId: string;
  a: number;
  b: number;
  len: number;
}

export function route(input: RouteInput, passes = 5): RouteResult {
  const pads: BoardPad[] = input.parts.flatMap((p) => p.pads);
  const owner = input.parts.flatMap((p) => p.pads.map(() => p));
  const conns = connections(pads);
  let best: ReturnType<typeof routeOnce> | null = null;
  let order = [...conns].sort((x, y) => x.len - y.len || x.netId.localeCompare(y.netId) || x.a - y.a);
  for (let pass = 0; pass < passes; pass++) {
    const r = routeOnce(input, pads, owner, order);
    if (!best || r.failed.length < best.failed.length) best = r;
    if (!r.failed.length) break;
    // failures first, then the rest in the old order
    const failed = new Set(r.failed);
    order = [...order.filter((c) => failed.has(c)), ...order.filter((c) => !failed.has(c))];
  }
  const r = best ?? routeOnce(input, pads, owner, order);
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

function routeOnce(input: RouteInput, pads: BoardPad[], owner: BoardPart[], order: Conn[]) {
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
  const stampVia = (net: number, x: number, y: number) => {
    for (let l = 0; l < L; l++) stamp(l, net, x, y, x, y, rules.viaPad / 2, (px, py) => Math.hypot(px - x, py - y));
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
    const p1 = alongX ? { x: p.x + dir * (half + reach + (long ? 0.5 : 0)), y: p.y } : { x: p.x, y: p.y + dir * (half + reach + (long ? 0.5 : 0)) };
    for (let extra = 0.1; extra <= 0.45; extra += 0.1) {
      const ex = alongX ? p1.x + dir * extra : p1.x;
      const ey = alongX ? p1.y : p1.y + dir * extra;
      const i = Math.round(ex / G);
      const j = Math.round(ey / G);
      if (i < 0 || j < 0 || i >= W || j >= H) return null;
      const v = maps[0]![l]![j * W + i]!;
      if (v === 0 || v === padNet[idx]) return { state: l * N + j * W + i, p1, l, ex: i * G, ey: j * G };
    }
    return null;
  });
  // copper that is already a net's own (inside its pads): always usable by that net
  const ownCopper = new Int32Array(L * N);
  padCells.forEach((cells, i) => {
    for (const s of cells) ownCopper[s] = padNet[i]!;
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
    return v === 0 || v === net || ownCopper[l * N + i] === net;
  };
  const viaFreeFor = (net: number) => (i: number) => {
    for (let l = 0; l < L; l++) {
      const v = maps[2]![l]![i]!;
      if (v !== 0 && v !== net) return false;
    }
    return true;
  };

  /** A* from any start state to a goal state; returns the path (start → goal) or null. */
  const search = (net: number, k: number, starts: number[], isGoal: (s: number) => boolean, target: { x: number; y: number }): number[] | null => {
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
    for (const s of starts) {
      cost[s] = 0;
      from[s] = -1;
      dirOf[s] = -1;
      heap.push(s, h(s));
    }
    let reached = -1;
    let expanded = 0;
    const LIMIT = S * 4;
    while (heap.size) {
      const s = heap.pop();
      if (isGoal(s)) {
        reached = s;
        break;
      }
      if (++expanded > LIMIT) break;
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
    if (reached < 0) return null;
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
        if (run) {
          vias.push({ netId, x: r3(px), y: r3(py), drill: rules.viaDrill, pad: rules.viaPad });
          stampVia(net, px, py);
        }
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
      vias.push({ netId, x: r3(px), y: r3(py), drill: rules.viaDrill, pad: rules.viaPad });
      stampVia(net, px, py);
    }
    for (const run of runs) {
      const pts = simplify(run.pts);
      if (pts.length < 4) continue;
      tracks.push({ netId, layer: layers[run.l]!, width, pts: pts.map(r3) });
      for (let q = 0; q + 3 < pts.length; q += 2) stampSeg(run.l, net, pts[q]!, pts[q + 1]!, pts[q + 2]!, pts[q + 3]!, width);
    }
  };
  const padAt = (root: number, state: number) => pads.findIndex((_, idx) => find(idx) === root && padCells[idx]!.includes(state));

  for (const c of order) {
    const net = numOf(c.netId);
    if (find(c.a) === find(c.b)) continue;
    const pa = pads[c.a]!;
    const pb = pads[c.b]!;
    // power width only where both pads can take it
    const wide = input.powerNets.has(c.netId) && Math.min(pa.w, pa.h) >= rules.powerTrack * 0.9 && Math.min(pb.w, pb.h) >= rules.powerTrack * 0.9;
    const k = wide ? 1 : 0;
    epoch++;
    const goalStamp = epoch;
    for (const st of groupCells.get(find(c.a))!) goal[st] = goalStamp;
    const path = search(net, k, groupCells.get(find(c.b))!, (st) => goal[st] === goalStamp, pa);
    if (!path) {
      failed.push(c);
      continue;
    }
    // (a route may also start on copper laid earlier for this net: then it starts right there)
    commit(c.netId, net, widths[k]!, path, padAt(find(c.b), path[0]!), padAt(find(c.a), path.at(-1)!));
    union(c.a, c.b);
    groupCells.get(find(c.a))!.push(...path);
  }

  /* ---- copper pour (ground plane) ---- */
  const zones: Zone[] = [];
  const pour = input.pour;
  const pl = pour ? layerIdx.get(pour.layer) : undefined;
  if (pour && pl !== undefined && netNum.has(pour.netId)) {
    const pnet = numOf(pour.netId);
    const ok = new Uint8Array(N);
    const margin = G * 0.75; // a cell stands for a G × G square: keep its corners clear
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const x = i * G;
        const y = j * G;
        const keep = rules.edgeClearance + margin;
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
      if (!p.drill && !p.layers.includes(pour.layer)) return;
      clearAround(p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2, 0, padDist(p));
    });
    for (const t of tracks) {
      if (t.netId === pour.netId || t.layer !== pour.layer) continue;
      for (let q = 0; q + 3 < t.pts.length; q += 2) {
        const [ax, ay, bx, by] = [t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!];
        clearAround(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), t.width / 2, segDist(ax, ay, bx, by));
      }
    }
    const clearVia = (v: Via) => clearAround(v.x, v.y, v.x, v.y, v.pad / 2, (x, y) => Math.hypot(x - v.x, y - v.y));
    for (const v of vias) if (v.netId !== pour.netId) clearVia(v);

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
    // which islands the net's copper on the pour layer touches
    const touchedBy = (root: number | null) => {
      const hit = new Set<number>();
      for (const [r, cells] of groupCells) {
        if (padNet[r] !== pnet || (root !== null && r !== root)) continue;
        for (const st of cells) if (Math.floor(st / N) === pl && island[st % N]! >= 0) hit.add(island[st % N]!);
      }
      return hit;
    };
    const touched = touchedBy(null);
    const candidates = [...(touched.size ? touched : sizes.keys())];
    const main = candidates.sort((x, y) => sizes[y]! - sizes[x]! || x - y)[0];
    if (main !== undefined && sizes[main]! * G * G >= 1) {
      // drop every ground group that does not reach the main island onto it (track + via)
      const joined = new Set<number>();
      const roots = [...new Set(pads.map((_, idx) => find(idx)).filter((r) => padNet[r] === pnet))];
      for (const r of roots) {
        const reach = touchedBy(r);
        if (reach.has(main)) {
          joined.add(r);
          continue;
        }
        const starts = groupCells.get(r)!.filter((st) => Math.floor(st / N) !== pl);
        const pad0 = pads[r]!;
        const path = starts.length
          ? search(pnet, 0, starts, (st) => {
              // a via site in the main island (the via then joins the plane)
              if (Math.floor(st / N) === pl) return false;
              const i = st % N;
              if (island[i] !== main || !viaFreeFor(pnet)(i)) return false;
              const vx = (i % W) * G;
              const vy = Math.floor(i / W) * G;
              const rr = rules.viaPad / 2 + margin;
              for (const [dx, dy] of [[rr, 0], [-rr, 0], [0, rr], [0, -rr]] as const) {
                const ii = Math.round((vx + dx) / G) + Math.round((vy + dy) / G) * W;
                if (island[ii] !== main) return false;
              }
              return true;
            }, pad0)
          : null;
        if (!path) continue;
        commit(pour.netId, pnet, rules.track, path, padAt(r, path[0]!), -1, true);
        groupCells.get(r)!.push(...path);
        joined.add(r);
      }
      // everything that reaches the plane is one piece of copper
      const js = [...joined];
      for (let q = 1; q < js.length; q++) union(js[0]!, js[q]!);
      // keep islands that touch the net's copper (pads, tracks, vias); the rest would be dead copper
      const alive = new Set<number>([main, ...touchedBy(null)]);
      for (const v of vias) {
        if (v.netId !== pour.netId) continue;
        const i = Math.round(v.x / G) + Math.round(v.y / G) * W;
        if (island[i]! >= 0) alive.add(island[i]!);
      }
      // row runs, merged with identical runs of the rows below into taller rectangles
      const rects: number[] = [];
      let open = new Map<string, { i0: number; i1: number; j0: number }>();
      const close = (o: { i0: number; i1: number; j0: number }, j: number) => rects.push(r3(o.i0 * G - G / 2), r3(o.j0 * G - G / 2), r3((o.i1 - o.i0) * G), r3((j - o.j0) * G));
      for (let j = 0; j <= H; j++) {
        const next = new Map<string, { i0: number; i1: number; j0: number }>();
        if (j < H) {
          let start = -1;
          for (let i = 0; i <= W; i++) {
            const on = i < W && island[j * W + i]! >= 0 && alive.has(island[j * W + i]!);
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
      zones.push({ netId: pour.netId, layer: pour.layer, rects });
      // connections of the poured net are made through the plane where both ends reach it
      for (let q = failed.length - 1; q >= 0; q--) if (find(failed[q]!.a) === find(failed[q]!.b)) failed.splice(q, 1);
    }
  }
  return { tracks, vias, failed, find, zones };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

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
  pop(): number {
    const s = this.s;
    const p = this.p;
    const top = s[0]!;
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
