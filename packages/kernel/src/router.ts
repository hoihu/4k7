/**
 * Autorouter: a maze router (A*) on a fine grid across all copper layers, 8 directions (45°
 * tracks) plus vias. Clearance is built into the grid: for every track-width class a map says,
 * per cell and layer, which net may put a track centre there (computed from exact distances
 * to pads, tracks, vias and the board edge). Connections follow each net's minimum spanning
 * tree, shortest first; a connection may end on any copper already joined to its net.
 * Failed connections are routed first in the next pass (simple rip-up and retry).
 */
import { boardPolygon, cutoutBounds, cutoutDistance, insideBoard, type BoardCutout, type BoardPad, type BoardPart, type BoardRules, type CopperLayer, type Track, type Via, type Zone, type ZoneShape } from '@4k7/schema';

const G = 0.1; // grid pitch, mm
const MULTI = -1; // near copper of two nets: nobody may route here
const EDGE = -2; // too close to the board edge
const VIA_COST = 25; // in grid steps (2.5 mm of track)
const TURN_COST = 0.6;
const OFF_AXIS_COST = 0.15; // prefer horizontal on F.Cu, vertical on B.Cu
const CENTRE_COST = 0.5; // per step and grid step off the middle of the gap between two IC pins
const CLIP_COST = 3; // a step whose copper runs half over one of the net's own pads, off its centre line

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
   * filling what the tracks leave. Pads of the net drop onto their plane with a via.
   */
  planes?: { netId: string; layer: CopperLayer }[];
  /** Stop routing after this many milliseconds; what is left is reported unrouted. */
  budgetMs?: number;
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
    const improved = !best || r.failed.length < best.failed.length;
    if (improved) best = r;
    if (!r.failed.length || r.timedOut) break;
    // a pass without an improvement: more orders will not help (the same connections are
    // blocked), and each pass costs as much as the first (seconds on a big board)
    if (!improved) break;
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

  // width classes: 0 signal track, 1 power track, 2 via, then the widths chosen for single nets
  const widths = [rules.track, rules.powerTrack, rules.viaPad];
  for (const w of Object.values(input.netWidths ?? {})) if (w > 0 && !widths.includes(w)) widths.push(w);
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
  // dedicated plane layers carry no tracks (vias still pass through, with clearance)
  for (const pl of input.planes ?? []) {
    const l = layerIdx.get(pl.layer);
    if (l === undefined || OUTER.has(pl.layer)) continue;
    for (let k = 0; k < widths.length; k++) if (k !== 2) maps[k]![l]!.fill(EDGE);
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

  /** A* from any start state to a goal state; returns the path (start → goal) or null. */
  /*
   * The estimate of the way left (A*): the distance to the target: a point, or the box round all
   * goal cells. With a group of copper as the goal, a point (one pad of it) would overestimate
   * the way to the group's nearer parts, and the search would run past them to that pad.
   */
  const search = (net: number, k: number, starts: number[], isGoal: (s: number) => boolean, target: { x: number; y: number } | { x0: number; y0: number; x1: number; y1: number }, accept?: (s: number) => boolean): number[] | null => {
    const free = freeFor(net, k);
    const viaFree = viaFreeFor(net);
    const run = ++searchNo;
    const inPad = widths[k]! / 2 - 0.01;
    const costOf = (st: number) => (seenAt[st] === run ? cost[st]! : Infinity);
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
    const centred = (st: number) => usable(st) && !offCentre(net, k, st);
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
          return v === 0 || v === net || (ownCopper[lo + c] === net && ownInset[lo + c]! >= inPad);
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
        if (L > 1 && viaFree(i)) {
          for (let l2 = 0; l2 < L; l2++) {
            const ns = l2 * N + i;
            if (seen[ns] === run) continue;
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
      if (heap.lastPrio >= best - 1e-6) break;
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
      if (expanded === FLOOD_AFTER && reached < 0 && !reachable()) break;
      if ((expanded & 4095) === 0 && now() > deadline) break;
      const l = Math.floor(s / N);
      const i = s % N;
      const x = i % W;
      const y = (i - x) / W;
      const base = cost[s]!;
      const dir = dirOf[s]!;
      // free(l, ·) for this layer, inlined (the hottest test of the search)
      const m = maps[k]![l]!;
      const lo = l * N;
      const ok = (c: number) => {
        const v = m[c]!;
        return v === 0 || v === net || (ownCopper[lo + c] === net && ownInset[lo + c]! >= inPad);
      };
      const kind = layerKind[l]!;
      const tch = k < 2 ? touch[k]! : null;
      for (let d = 0; d < 8; d++) {
        const dx = DX[d]!;
        const dy = DY[d]!;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        const ns = lo + ni;
        if (!ok(ni) && !isGoal(ns)) continue;
        // diagonal steps: both orthogonal neighbours must be clear too (no corner cutting)
        if (dx !== 0 && dy !== 0 && (!ok(y * W + nx) || !ok(ny * W + x))) continue;
        const off = kind === 1 ? dy !== 0 : kind === 2 ? dx !== 0 : false;
        const nc = base + STEP[d]! + (dir >= 0 && dir !== d ? TURN_COST : 0) + (off ? OFF_AXIS_COST : 0) + (tch !== null && tch[ns] !== 0 && clips(net, k, l, ni, dx, dy) ? CLIP_COST : 0) + offMiddle[ns]!;
        if (nc < costOf(ns)) {
          seenAt[ns] = run;
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

  /** Turn a path into tracks and vias, reserve its copper; returns the cells the copper covers. */
  const commit = (netId: string, net: number, k: number, path: number[], startPad: number, endPad: number, endVia = false): number[] => {
    const width = widths[k]!;
    const free = freeFor(net, k);
    const runs: { l: number; cells: number[] }[] = [];
    for (const s of path) {
      const l = Math.floor(s / N);
      const run = runs.at(-1);
      if (!run || run.l !== l) runs.push({ l, cells: [s % N] });
      else run.cells.push(s % N);
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
      const clip = (l: number, i: number, dx: number, dy: number) => clips(net, k, l, i, dx, dy);
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
      if (ri > 0) addVia(netId, net, pts[0]!, pts[1]!);
      return { l: run.l, pts };
    });
    if (startPad >= 0 && lines[0]) {
      const sp = pads[startPad]!;
      const se = escapes[startPad];
      const pts = lines[0].pts;
      pts.unshift(...(se && se.state === path[0] ? [sp.x, sp.y, se.p1.x, se.p1.y] : [sp.x, sp.y, ...entryBend(pts[0]!, pts[1]!, sp, width)]));
    }
    const last = lines.at(-1)!;
    if (endPad >= 0) {
      const ep = pads[endPad]!;
      const ee = escapes[endPad];
      const pts = last.pts;
      pts.push(...(ee && ee.state === path.at(-1) ? [ee.p1.x, ee.p1.y] : entryBend(pts.at(-2)!, pts.at(-1)!, ep, width)), ep.x, ep.y);
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
    if (startPad >= 0 && lines[0]) lines[0].pts = reversePts(alignEnd(reversePts(simplify(lines[0].pts)), pads[startPad]!, lines[0].l, net, width, lines.length === 1 ? dropVia : undefined));
    if (endPad >= 0) last.pts = alignEnd(simplify(last.pts), pads[endPad]!, last.l, net, width);
    // an end on a track of the net (a join): exactly onto that track's centre line
    if (startPad < 0 && lines[0] && !(lines.length === 1 && endVia)) lines[0].pts = reversePts(joinTrack(reversePts(simplify(lines[0].pts)), lines[0].l, net));
    if (endPad < 0 && !endVia) last.pts = joinTrack(simplify(last.pts), last.l, net);
    for (const line of lines) line.pts = dejog(simplify(line.pts), line.l, net, width);
    // the copper as it finally lies (aligned ends moved it): the cells later routes may join
    const onCopper = new Set<number>();
    for (const line of lines) {
      const pts = simplify(line.pts);
      if (pts.length < 4) continue;
      tracks.push({ netId, layer: layers[line.l]!, width, pts: pts.map(r3) });
      for (let q = 0; q + 3 < pts.length; q += 2) {
        const [ax, ay, bx, by] = [pts[q]!, pts[q + 1]!, pts[q + 2]!, pts[q + 3]!];
        stampSeg(line.l, net, ax, ay, bx, by, width);
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (G / 4)));
        for (let i = 0; i <= steps; i++) {
          const x = ax + ((bx - ax) * i) / steps;
          const y = ay + ((by - ay) * i) / steps;
          const ci = Math.round(x / G);
          const cj = Math.round(y / G);
          if (ci < 0 || cj < 0 || ci >= W || cj >= H) continue;
          // a cell whose centre lies on the copper (within the track, not just near it)
          if (segDist(ax, ay, bx, by)(ci * G, cj * G) <= width / 2 - 1e-6) onCopper.add(line.l * N + cj * W + ci);
        }
      }
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
   * line (or, running alongside it, a short step across). Only with exact clearance.
   */
  const joinTrack = (pts: number[], l: number, net: number): number[] => {
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
      if (!clearOf(net, l, best.w, [[px, py, q[0], q[1]]])) return pts;
      return [...pts, q[0], q[1]];
    }
    if (!clearOf(net, l, best.w, [[ax, ay, q[0], q[1]]])) return pts;
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
    }
    return true;
  };
  const padAt = (root: number, state: number) => pads.findIndex((_, idx) => find(idx) === root && padCells[idx]!.includes(state));

  /*
   * Planes and pours. Inner planes are dedicated to their net (no tracks there); pours on outer
   * layers fill what the tracks leave. Every group of a plane net that does not reach its plane
   * drops onto it (short track + via). Order: inner-plane drops → signal routing → outer-pour
   * drops → final areas (clear of every via of other nets) → connectivity.
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
        ok[j * W + i] = x >= keep && y >= keep && x <= input.outline.w - keep && y <= input.outline.h - keep && (!shaped || inside(x, y) >= keep) ? 1 : 0;
      }
    }
    for (const c of input.cutouts ?? []) {
      const [x0, y0, x1, y1] = cutoutBounds(c);
      for (let j = Math.max(0, Math.floor((y0 - keep) / G)); j <= Math.min(H - 1, Math.ceil((y1 + keep) / G)); j++) {
        for (let i = Math.max(0, Math.floor((x0 - keep) / G)); i <= Math.min(W - 1, Math.ceil((x1 + keep) / G)); i++) if (cutoutDistance(c, i * G, j * G) < keep) ok[j * W + i] = 0;
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
    const okOthers = ok.slice(); // before the reliefs: where other nets allow copper
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
    return { l, pnet, island, sizes, main, touched, okOthers };
  };

  /** Exact plane geometry: outline minus clearances, relief rings and dead islands, plus spokes. */
  const planeShape = (pl: { netId: string; layer: CopperLayer }, rg: ReturnType<typeof region>, alive: Set<number>): ZoneShape => {
    const c = rules.clearance;
    const e = rules.edgeClearance;
    const cuts: ZoneShape['cuts'] = [];
    const adds: ZoneShape['adds'] = [];
    pads.forEach((p, idx) => {
      if (padNet[idx] === rg.pnet || !(p.drill || p.layers.includes(pl.layer))) return;
      if (p.shape === 'round') cuts.push({ k: 'circle', x: p.x, y: p.y, d: r3(Math.min(p.w, p.h) + 2 * c) });
      else cuts.push({ k: 'rect', x: r3(p.x - p.w / 2 - c), y: r3(p.y - p.h / 2 - c), w: r3(p.w + 2 * c), h: r3(p.h + 2 * c) });
    });
    for (const t of tracks) if (t.netId !== pl.netId && t.layer === pl.layer) cuts.push({ k: 'stroke', pts: t.pts, w: r3(t.width + 2 * c) });
    for (const v of vias) if (v.netId !== pl.netId) cuts.push({ k: 'circle', x: v.x, y: v.y, d: r3(v.pad + 2 * c) });
    // thermal reliefs: a ring cut, spokes back where no other net is in the way
    const gap = Math.max(c, 0.25);
    const spokeW = Math.min(0.4, Math.max(0.3, rules.track));
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
      if (v.netId !== pl.netId) continue;
      cuts.push({ k: 'circle', x: v.x, y: v.y, d: r3(v.pad + 2 * gap) });
      spokesOf(v.x, v.y, v.pad / 2, v.pad / 2);
    }
    pads.forEach((p, idx) => {
      if (padNet[idx] !== rg.pnet || !(p.drill || p.layers.includes(pl.layer))) return;
      if (p.shape === 'round') cuts.push({ k: 'circle', x: p.x, y: p.y, d: r3(Math.min(p.w, p.h) + 2 * gap) });
      else cuts.push({ k: 'rect', x: r3(p.x - p.w / 2 - gap), y: r3(p.y - p.h / 2 - gap), w: r3(p.w + 2 * gap), h: r3(p.h + 2 * gap) });
      spokesOf(p.x, p.y, p.shape === 'round' ? Math.min(p.w, p.h) / 2 : p.w / 2, p.shape === 'round' ? Math.min(p.w, p.h) / 2 : p.h / 2);
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
    return { outline: [e, e, r3(input.outline.w - e), r3(input.outline.h - e)], ...(clip ? { clip } : {}), cuts, adds };
  };

  // 1. provisional areas; 2. drops of every group that does not reach its plane
  const dropVias = new Map<number, { x: number; y: number }[]>(); // pad root → drop vias
  let timedOut = false;
  const dropOnto = (list: typeof planes) => {
  for (const pl of list) {
    const rg = region(pl);
    if (rg.main === undefined || rg.sizes[rg.main]! * G * G < 1) continue;
    const roots = [...new Set(pads.map((_, idx) => find(idx)).filter((r) => padNet[r] === rg.pnet))];
    // copper of the drops so far → the via it leads down to: a later drop may simply join it
    const dropCopper = new Map<number, { x: number; y: number }>();
    for (const r of roots) {
      if (timedOut || now() > deadline) break;
      const reaches = groupCells.get(r)!.some((st) => Math.floor(st / N) === rg.l && rg.island[st % N] === rg.main);
      if (reaches) continue;
      const starts = groupCells.get(r)!.filter((st) => Math.floor(st / N) !== rg.l);
      if (!starts.length) continue;
      const path = search(rg.pnet, 0, starts, (st) => {
        // a via site well inside the main area (the via then joins the plane)
        if (Math.floor(st / N) === rg.l) return false;
        if (dropCopper.has(st)) return true; // join an earlier drop
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
      const joins = dropCopper.get(path.at(-1)!);
      const copper = commit(pl.netId, rg.pnet, 0, path, padAt(r, path[0]!), -1, !joins);
      groupCells.get(r)!.push(...copper);
      const end = path.at(-1)! % N;
      const via = joins ?? { x: (end % W) * G, y: Math.floor(end / W) * G };
      for (const st of copper) dropCopper.set(st, via);
      dropVias.set(r, [...(dropVias.get(r) ?? []), via]);
    }
  }
  };
  /*
   * Fan-out first: pads on a net with a dedicated inner plane drop onto it before the signals are
   * routed (the signals then go round the drop vias; routed first, a signal can shut a pad off
   * from every via site). Outer pours come last: they fill what the tracks leave.
   */
  dropOnto(planes.filter((pl) => !OUTER.has(pl.layer)));
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
    // the net's own width, else power width, each only where both pads can take it
    const takes = (w: number) => Math.min(pa.w, pa.h) >= w * 0.9 && Math.min(pb.w, pb.h) >= w * 0.9;
    const own = input.netWidths?.[c.netId];
    const wide = input.powerNets.has(c.netId) && takes(rules.powerTrack);
    // too wide for a pad: the widest class that still fits (never below the signal width)
    const fitting = (w: number) => widths.reduce((best, x, i) => (i !== 2 && x <= w && takes(x) && x > widths[best]! ? i : best), 0);
    const k = own ? (own <= rules.track || takes(own) ? widths.indexOf(own) : fitting(own)) : wide ? 1 : 0;
    epoch++;
    const goalStamp = epoch;
    for (const st of groupCells.get(find(c.a))!) goal[st] = goalStamp;
    const goalCells = groupCells.get(find(c.a))!;
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
    const path = search(net, k, groupCells.get(find(c.b))!, (st) => goal[st] === goalStamp, { x0: gx0, y0: gy0, x1: gx1, y1: gy1 }, accept);
    if (!path) {
      failed.push(c);
      continue;
    }
    // (a route may also start on copper laid earlier for this net: then it starts right there)
    const copper = commit(c.netId, net, k, path, padAt(find(c.b), path[0]!), padAt(find(c.a), path.at(-1)!));
    union(c.a, c.b);
    groupCells.get(find(c.a))!.push(...copper);
  }

  dropOnto(planes.filter((pl) => OUTER.has(pl.layer)));

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
    zones.push({ netId: pl.netId, layer: pl.layer, rects, shape: planeShape(pl, rg, alive) });
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

/** Distance from a point to the segment a–b. */
function segDist(ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  return (x: number, y: number) => {
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
  };
}

/** A flat polyline, back to front. */
function reversePts(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i]!, pts[i + 1]!);
  return out;
}

/** The shortest distance between two segments. */
function segSegDist(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
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
