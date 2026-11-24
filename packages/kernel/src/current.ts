/**
 * The copper as laid against its net's current (tier 3a of the current check, `bound` basis): every
 * track of a net with max_current is checked for the whole of it on its layer's copper, and the
 * vias where a net's copper changes layer are checked where they are the only way across (a cut of
 * the net's copper graph). A power net without max_current is unknown, never fine. See
 * docs/design/layout.md §14.
 */
import { COPPER_ORDER, IR_BUDGET, padPins, trackCurrentFor, trackRiseFor, trackWidthFor, viaCurrentFor } from '@4k7/schema';
import type { BoardPad, BoardPart, BoardRules, BoardView, CopperLayer, CurrentBasis, CurrentJoint, CurrentStatus, CurrentTrack, CurrentView, CurrentVias, Design, Diagnostic, DropPiece, IrDrop, EditOp, NetLoad, QueryOp, Track } from '@4k7/schema';
import { cardOf, isGroundNet, isPowerNet } from './doc.ts';
import { powerSources } from './power.ts';
import { idOf, pointSegDist, r3, segmentsOf, segSegDist } from './geom.ts';
import { padPointDist, padSegDist } from './keep.ts';

/** Via plating assumed for a via's barrel (µm, IPC-6012 class 3). */
export const VIA_PLATING_UM = 25;
/** Vias of a net this close, edge to edge (mm), are counted together, as one group. */
const GROUP_GAP = 1;
/** A track piece this short (mm) is not counted: its ends hold its heat (a neck into a pad). */
const SHORT_MM = 1;
/** How far a pour may stand off a pad or via of its own net and still join it (a relief's ring), mm. */
const ZONE_REACH = 0.5;
const EPS = 0.01;

export type { CurrentJoint, CurrentNet, CurrentStatus, CurrentTrack, CurrentVias } from '@4k7/schema';
/** The current check of a board (BoardView.current). */
export type CurrentCheck = CurrentView;

/** The allowed heating of the copper (set_board current_rise_c), °C. */
export const currentRise = (rules: Pick<BoardRules, 'currentRise'>): number => rules.currentRise ?? 10;

/** Each copper layer's thickness (µm) from the stack-up in effect, top to bottom. */
export function layerCopper(b: Pick<BoardView, 'layers' | 'stackup'>): Partial<Record<CopperLayer, number>> {
  const out: Partial<Record<CopperLayer, number>> = {};
  const order = b.stackup ? COPPER_ORDER[b.stackup.copper.length as 2 | 4] : undefined;
  for (const l of b.layers) {
    const i = order?.indexOf(l) ?? -1;
    out[l] = i >= 0 ? Math.round(b.stackup!.copper[i]! * 1000 * 10) / 10 : 35;
  }
  return out;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Distance from a segment to a rectangle (x, y, w, h), 0 where they meet. */
function segRectDist(ax: number, ay: number, bx: number, by: number, x: number, y: number, w: number, h: number): number {
  const inside = (px: number, py: number) => px >= x && px <= x + w && py >= y && py <= y + h;
  if (inside(ax, ay) || inside(bx, by)) return 0;
  return Math.min(segSegDist(ax, ay, bx, by, x, y, x + w, y), segSegDist(ax, ay, bx, by, x + w, y, x + w, y + h), segSegDist(ax, ay, bx, by, x + w, y + h, x, y + h), segSegDist(ax, ay, bx, by, x, y + h, x, y));
}

/** The rectangles of a zone in 2 mm buckets, and which island (connected piece) each belongs to. */
function zoneIndex(rects: number[]) {
  const B = 2;
  const n = rects.length / 4;
  const cells = new Map<string, number[]>();
  const box = (i: number) => [rects[4 * i]!, rects[4 * i + 1]!, rects[4 * i + 2]!, rects[4 * i + 3]!] as const;
  const keys = (x0: number, y0: number, x1: number, y1: number) => {
    const out: string[] = [];
    for (let i = Math.floor(x0 / B); i <= Math.floor(x1 / B); i++) for (let j = Math.floor(y0 / B); j <= Math.floor(y1 / B); j++) out.push(`${i},${j}`);
    return out;
  };
  for (let i = 0; i < n; i++) {
    const [x, y, w, h] = box(i);
    for (const k of keys(x, y, x + w, y + h)) (cells.get(k) ?? cells.set(k, []).get(k)!).push(i);
  }
  const near = (x0: number, y0: number, x1: number, y1: number) => new Set(keys(x0, y0, x1, y1).flatMap((k) => cells.get(k) ?? []));
  // islands: rectangles that overlap or share an edge
  const island = new Int32Array(n).fill(-1);
  let count = 0;
  const t = 1e-6;
  for (let s = 0; s < n; s++) {
    if (island[s]! >= 0) continue;
    island[s] = count;
    const stack = [s];
    while (stack.length) {
      const i = stack.pop()!;
      const [x, y, w, h] = box(i);
      for (const j of near(x - t, y - t, x + w + t, y + h + t)) {
        if (island[j]! >= 0) continue;
        const [x2, y2, w2, h2] = box(j);
        const ox = Math.min(x + w, x2 + w2) - Math.max(x, x2);
        const oy = Math.min(y + h, y2 + h2) - Math.max(y, y2);
        if ((ox > t && oy > -t) || (oy > t && ox > -t)) {
          island[j] = count;
          stack.push(j);
        }
      }
    }
    count++;
  }
  return { count, island, box, near };
}

/** A pad counts as where current comes in: a pwr_out pin, a connector's pin, or an inductor's (a series element). */
function sourcePads(d: Design): (part: BoardPart, pad: BoardPad) => boolean {
  return (part, pad) => {
    if (part.category === 'connector' || part.category === 'inductor') return true;
    const c = d.components[part.componentId];
    const card = c ? cardOf(d, c.part) : undefined;
    const pins = padPins(pad).map((n) => n.toUpperCase());
    return !!card?.pins.some((p) => pins.includes(p.number.toUpperCase()) && p.type === 'pwr_out');
  };
}

/** The current a piece is checked for, and what follows: its status against its capacity. */
type Share = { amps: number; basis: CurrentBasis; split?: number; dropMv?: number };
const statusOf = (s: Share, capacity: number): CurrentStatus => ((s.split ?? (s.basis === 'split' ? s.amps : 0)) > capacity ? 'over' : s.amps > capacity ? 'unverified' : 'ok');

/** The current check of the board's copper against its nets' max_current and loads (BoardView.current of a routed board: layoutBoard works it out once). */
export function currentCheck(d: Design, b: BoardView): CurrentCheck {
  const riseC = currentRise(b.rules);
  const copperUm = layerCopper(b);
  const out: CurrentCheck = { riseC, copperUm, nets: [], tracks: [], vias: [], joints: [] };
  if (!b.tracks.length && !b.vias.length && !b.zones.length) return out;
  const isSource = sourcePads(d);
  const sources = powerSources(d);
  const has = new Set<string>([...b.tracks.map((t) => t.netId), ...b.vias.map((v) => v.netId), ...b.zones.filter((z) => !z.floating).map((z) => z.netId)]);
  // GND without a max_current of its own: the sum of the rails', when every rail with copper has one
  const rails = Object.values(d.nets).filter((n) => isPowerNet(n) && !isGroundNet(n));
  const railSum = rails.some((n) => has.has(n.id)) && rails.every((n) => !has.has(n.id) || (n.attrs.maxCurrent ?? 0) > 0) ? rails.reduce((s, n) => s + (n.attrs.maxCurrent ?? 0), 0) : undefined;
  for (const n of Object.values(d.nets)) {
    if (!has.has(n.id)) continue;
    const own = n.attrs.maxCurrent && n.attrs.maxCurrent > 0 ? n.attrs.maxCurrent : undefined;
    const fromRails = !own && isGroundNet(n) && railSum ? railSum : undefined;
    const stated = netLoads(d, b, n.id);
    const statedSum = stated.reduce((s, l) => s + l.amps, 0);
    const amps = own ?? fromRails ?? (statedSum > 0 ? statedSum : undefined);
    if (!amps) {
      if (isPowerNet(n)) out.nets.push({ netId: n.id, name: n.name, basis: 'unknown', status: 'unknown' });
      continue;
    }
    const cu = netCopper(b, n.id);
    // the split, where the loads are stated and the current comes in at one place
    let split: ReturnType<typeof solveSplit> | undefined;
    let why: string | undefined;
    let loadPads: { pads: number[]; amps: number }[] = [];
    let srcPads: number[] = [];
    if (stated.length) {
      const src = sources.get(n.id) ?? [];
      const at = src.length === 1 ? cu.pads.flatMap(({ part, pad }, i) => (part.componentId === src[0]!.componentId && padPins(pad).some((x) => src[0]!.pins.includes(x)) ? [i] : [])) : [];
      if (src.length > 1) why = `it has ${src.length} sources (${src.map((s) => d.components[s.componentId]?.refdes ?? s.componentId).join(', ')}) and how its current divides between them is not known`;
      else if (!src.length) why = 'no source found (a pwr_out pin, a connector on an external net, or an inductor, ferrite, fuse or diode from a rail nearer the supply)';
      else if (!at.length) why = 'its source is not on the board';
      else {
        loadPads = stated.map((l) => ({ pads: cu.pads.flatMap(({ part, pad }, i) => (part.componentId === l.componentId && padPins(pad).some((x) => l.pins.includes(x.toUpperCase()) || l.pins.includes(x)) ? [i] : [])), amps: l.amps }));
        srcPads = at;
        split = solveSplit(b, cu, copperUm, at, loadPads);
      }
    }
    // what no stated load the copper reaches places: it may flow anywhere
    const rest = split ? Math.max(0, amps - split.placed) : 0;
    const share = (s: number, dropMv?: number): Share => ({ amps: s + rest, basis: 'split', ...(rest > 1e-9 ? { split: s } : {}), ...(dropMv !== undefined ? { dropMv } : {}) });
    const tracks = netTracks(b, n.id, riseC, copperUm, (ti) => (split ? share(split.trackAmps[cu.trackIndex.indexOf(ti)]!, split.trackDrop[cu.trackIndex.indexOf(ti)]) : { amps, basis: 'bound' }));
    const vias: CurrentVias[] = [];
    for (const g of netVias(cu, isSource)) {
      const crossing = split ? g.vias.reduce((s, v) => s + split!.viaAmps[v]!, 0) : 0;
      // bound: only a cut; split: a cut for its share and the rest, another group for its share alone
      if (!g.cut && (!split || crossing < 1e-6)) continue;
      const sh: Share = !split ? { amps, basis: 'bound' } : g.cut ? share(crossing) : { amps: crossing, basis: 'split' };
      const per = viaCurrentFor(g.drill, riseC, VIA_PLATING_UM);
      const capacity = g.vias.length * per;
      vias.push({
        netId: n.id,
        at: g.at,
        vias: g.vias.length,
        drill: g.drill,
        ids: g.ids,
        layers: g.layers,
        amps: sh.amps,
        basis: sh.basis,
        ...(sh.split !== undefined ? { split: sh.split } : {}),
        status: statusOf(sh, capacity),
        ...(g.cut ? {} : { shared: true }),
        capacity,
        ratio: sh.amps / capacity,
        needs: Math.max(1, Math.ceil(sh.amps / per - 1e-6)),
      });
    }
    // the relief joints on the current's way: a cut for the bound (or its split share and the rest), else the share that crosses
    const joints: CurrentJoint[] = [];
    for (const j of netJoints(b, cu, isSource, riseC, copperUm)) {
      let sh: Share;
      if (!split) {
        if (!j.cut) continue;
        sh = { amps, basis: 'bound' };
      } else {
        // what crosses the joint: what the loads on its side draw, less what the source there gives
        const drawn = loadPads.reduce((s, l, li) => {
          const on = l.pads.filter((p) => cu.padItems[p]!.length);
          return split!.reached[li] && on.length ? s + (l.amps * on.filter((p) => j.side.has(p)).length) / on.length : s;
        }, 0);
        const crossing = Math.abs(drawn - (srcPads.some((p) => j.side.has(p)) ? split.placed : 0));
        if (!j.cut && crossing < 1e-6) continue;
        sh = j.cut ? share(crossing) : { amps: crossing, basis: 'split' };
      }
      joints.push({
        netId: n.id,
        kind: j.kind,
        ...(j.ref ? { ref: j.ref } : {}),
        at: j.at,
        layers: j.layers,
        spokes: j.spokes,
        spokeWidth: j.spokeWidth,
        amps: sh.amps,
        basis: sh.basis,
        ...(sh.split !== undefined ? { split: sh.split } : {}),
        status: statusOf(sh, j.capacity),
        capacity: j.capacity,
        ratio: sh.amps / j.capacity,
        needs: trackWidthFor(sh.amps / j.spokes, riseC, j.copperUm),
      });
    }
    out.tracks.push(...tracks);
    out.vias.push(...vias);
    out.joints.push(...joints);
    const all = [...tracks, ...vias, ...joints];
    const worst = Math.max(0, ...all.map((t) => t.ratio));
    const status: CurrentStatus = all.some((t) => t.status === 'over') ? 'over' : all.some((t) => t.status === 'unverified') ? 'unverified' : 'ok';
    out.nets.push({
      netId: n.id,
      name: n.name,
      amps,
      ...(fromRails ? { fromRails: true } : {}),
      basis: split ? 'split' : 'bound',
      status,
      ...(worst > 0 ? { worst: r2(worst) } : {}),
      ...(split ? { loads: r3(split.placed), ...(rest > 1e-9 ? { unplaced: r3(rest) } : {}), dropMv: r2(split.dropMv), ...(split.worst ? { irDrop: irDropOf(cu, split, n.attrs.voltage) } : {}) } : {}),
      ...(why ? { why } : {}),
    });
  }
  return out;
}


/** A split net's drop to its worst load against IR_BUDGET of the rail's voltage (the net's voltage attribute), with the pieces that drop the most on the way. */
function irDropOf(cu: NetCopper, split: ReturnType<typeof solveSplit>, voltage: number | undefined): IrDrop {
  const w = split.worst!;
  const { part, pad } = cu.pads[w.pad]!;
  const pieces: DropPiece[] = [
    ...[...split.pathTracks].map(([ti, mv]): DropPiece => {
      const t = cu.tracks[ti]!;
      const id = idOf(t);
      return { kind: 'track', index: cu.trackIndex[ti]!, ...(id ? { id } : {}), layer: t.layer, width: t.width, amps: r3(split.trackAmps[ti]!), dropMv: r2(mv), at: { x: r2(t.pts[0]!), y: r2(t.pts[1]!) } };
    }),
    ...[...split.pathVias].map(([vi, mv]): DropPiece => {
      const v = cu.vias[vi]!;
      const id = idOf(v);
      return { kind: 'via', ...(id ? { id } : {}), drill: v.drill, amps: r3(split.viaAmps[vi]!), dropMv: r2(mv), at: { x: r2(v.x), y: r2(v.y) } };
    }),
  ].sort((a, b) => b.dropMv - a.dropMv);
  const railV = voltage && voltage > 0 ? voltage : undefined;
  return {
    load: `${part.refdes}.${pad.number}`,
    mv: r2(w.mv),
    ...(railV ? { railV, budgetMv: r2(railV * IR_BUDGET * 1000), pct: r2(w.mv / (railV * 10)) } : {}),
    worst: pieces.slice(0, 3),
  };
}

/** The loads set_net loads states on a net, less those of a part or pin no longer on it (the schematic's part of netLoads: SEM.LDO_DISSIPATION uses it too). */
export function statedLoads(d: Design, netId: string): NetLoad[] {
  const out: NetLoad[] = [];
  for (const l of d.nets[netId]?.attrs.loads ?? []) {
    const c = d.components[l.componentId];
    const pins = c ? l.pins.filter((p) => c.pins[p] === netId) : [];
    if (pins.length) out.push({ ...l, pins });
  }
  return out;
}

/**
 * The loads stated on a net: set_net loads, and each pad with add_vias drop amps (its current
 * through the pad) that no stated load names already (the stated one wins). Loads of a part or pin
 * no longer on the net are left out.
 */
function netLoads(d: Design, b: BoardView, netId: string): NetLoad[] {
  const out = statedLoads(d, netId);
  for (const g of d.board?.vias ?? []) {
    if (g.kind !== 'drop' || g.netId !== netId || !g.amps || !g.pad) continue;
    const part = b.parts.find((p) => p.componentId === g.pad!.componentId);
    const pad = part?.pads.find((p) => p.number === g.pad!.number);
    const pins = pad ? padPins(pad) : [g.pad.number];
    if (out.some((l) => l.componentId === g.pad!.componentId && l.pins.some((p) => pins.includes(p)))) continue;
    out.push({ componentId: g.pad.componentId, pins, amps: g.amps });
  }
  return out;
}

/** The tracks of a net checked for their current; a piece inside the net's own pour on its layer, or a short one, is left out. */
function netTracks(b: BoardView, netId: string, riseC: number, copperUm: Partial<Record<CopperLayer, number>>, shareOf: (index: number) => Share): CurrentTrack[] {
  const out: CurrentTrack[] = [];
  const zones = b.zones.filter((z) => z.netId === netId);
  const pads = b.parts.flatMap((p) => p.pads.filter((q) => q.netId === netId).map((q) => ({ ref: `${p.refdes}.${q.number}`, pad: q })));
  b.tracks.forEach((t, index) => {
    if (t.netId !== netId || t.pts.length < 4) return;
    const segs = segmentsOf(t.pts);
    const length = segs.reduce((s, [ax, ay, bx, by]) => s + Math.hypot(bx - ax, by - ay), 0);
    if (length <= SHORT_MM) return;
    if (inOwnPour(t, zones)) return;
    const cu = copperUm[t.layer] ?? 35;
    const capacity = trackCurrentFor(t.width, cu, riseC);
    const end = (x: number, y: number) => pads.find(({ pad }) => (pad.drill || pad.layers.includes(t.layer)) && padPointDist(pad, x, y) <= EPS)?.ref;
    const [from, to] = [end(t.pts[0]!, t.pts[1]!), end(t.pts.at(-2)!, t.pts.at(-1)!)];
    const id = idOf(t);
    const sh = shareOf(index);
    const amps = sh.amps;
    out.push({
      netId,
      index,
      ...(id ? { id } : {}),
      layer: t.layer,
      width: t.width,
      length: r2(length),
      copperUm: cu,
      amps,
      basis: sh.basis,
      ...(sh.split !== undefined ? { split: sh.split } : {}),
      status: statusOf(sh, capacity),
      capacity,
      ratio: amps / capacity,
      ...(sh.dropMv !== undefined ? { dropMv: r2(sh.dropMv) } : {}),
      rise: trackRiseFor(amps, t.width, cu),
      needs: trackWidthFor(amps, riseC, cu),
      at: { x: r2(t.pts[0]!), y: r2(t.pts[1]!) },
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
  });
  return out;
}

/** Does the net's pour on the track's layer cover all of the track (points every 0.5 mm along it)? */
function inOwnPour(t: Track, zones: BoardView['zones']): boolean {
  const z = zones.filter((x) => x.layer === t.layer);
  if (!z.length) return false;
  const inside = (x: number, y: number) =>
    z.some((zz) => {
      for (let i = 0; i + 3 < zz.rects.length; i += 4) if (x >= zz.rects[i]! && x <= zz.rects[i]! + zz.rects[i + 2]! && y >= zz.rects[i + 1]! && y <= zz.rects[i + 1]! + zz.rects[i + 3]!) return true;
      return false;
    });
  for (const [ax, ay, bx, by] of segmentsOf(t.pts)) {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.5));
    for (let i = 0; i <= n; i++) if (!inside(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n)) return false;
  }
  return true;
}

/** Where two segments come closest: the parameter (0–1) along each. */
function closestParams(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): [number, number] {
  const proj = (px: number, py: number, x0: number, y0: number, x1: number, y1: number) => {
    const [ex, ey] = [x1 - x0, y1 - y0];
    const l2 = ex * ex + ey * ey;
    return l2 ? Math.max(0, Math.min(1, ((px - x0) * ex + (py - y0) * ey) / l2)) : 0;
  };
  const at = (t: number, u: number) => Math.hypot(ax + (bx - ax) * t - (cx + (dx - cx) * u), ay + (by - ay) * t - (cy + (dy - cy) * u));
  const cands: [number, number][] = [
    [0, proj(ax, ay, cx, cy, dx, dy)],
    [1, proj(bx, by, cx, cy, dx, dy)],
    [proj(cx, cy, ax, ay, bx, by), 0],
    [proj(dx, dy, ax, ay, bx, by), 1],
  ];
  // crossing
  const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(den) > 1e-12) {
    const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
    const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) cands.push([t, u]);
  }
  return cands.reduce((m, c) => (at(c[0], c[1]) < at(m[0], m[1]) ? c : m));
}

/** The part of a segment inside a rectangle grown by `g` (Liang–Barsky): its parameters, or null. */
function clipSeg(ax: number, ay: number, bx: number, by: number, x: number, y: number, w: number, h: number, g: number): [number, number] | null {
  let [t0, t1] = [0, 1];
  const [dx, dy] = [bx - ax, by - ay];
  const edges: [number, number][] = [
    [-dx, ax - (x - g)],
    [dx, x + w + g - ax],
    [-dy, ay - (y - g)],
    [dy, y + h + g - ay],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

/** Arc length (mm) along a track's polyline at segment `k`, parameter `t`. */
function arcAt(t: Track, k: number, u: number): number {
  let s = 0;
  segmentsOf(t.pts).forEach(([ax, ay, bx, by], i) => {
    const l = Math.hypot(bx - ax, by - ay);
    if (i < k) s += l;
    else if (i === k) s += l * u;
  });
  return s;
}

/** One element of a net's copper on one layer. */
type Item = { layer: CopperLayer; box: [number, number, number, number]; kind: 'track' | 'pad' | 'via' | 'zone'; ref: number };
/** Two items that touch; `sa`/`sb`: where along a track (mm) when that side is one. */
type Contact = { a: number; b: number; sa?: number; sb?: number };

/**
 * The net's copper as a graph: on each layer its tracks, pads, vias and each connected piece of its
 * pours (items), and where they touch (contacts: for a track, where along it). A through-hole pad's
 * items are its layers; a via's, one per layer, joined by its barrel. The cut test and the split
 * both read this one graph.
 */
function netCopper(b: BoardView, netId: string) {
  const layers = b.layers;
  const items: Item[] = [];
  const add = (it: Item) => (items.push(it), items.length - 1);
  const contacts: Contact[] = [];
  const tracks = b.tracks.filter((t) => t.netId === netId);
  const trackIndex = b.tracks.flatMap((t, i) => (t.netId === netId ? [i] : []));
  const trackItem = tracks.map((t, i) => {
    const xs = t.pts.filter((_, k) => k % 2 === 0);
    const ys = t.pts.filter((_, k) => k % 2 === 1);
    const r = t.width / 2;
    return add({ layer: t.layer, box: [Math.min(...xs) - r, Math.min(...ys) - r, Math.max(...xs) + r, Math.max(...ys) + r], kind: 'track', ref: i });
  });
  const pads: { part: BoardPart; pad: BoardPad }[] = [];
  for (const part of b.parts) for (const pad of part.pads) if (pad.netId === netId && !pad.npth) pads.push({ part, pad });
  const padItems: number[][] = pads.map(({ pad }, i) => {
    const on = pad.drill ? layers : pad.layers.filter((l) => layers.includes(l));
    return on.map((layer) => add({ layer, box: [pad.x - pad.w / 2, pad.y - pad.h / 2, pad.x + pad.w / 2, pad.y + pad.h / 2], kind: 'pad', ref: i }));
  });
  const vias = b.vias.filter((v) => v.netId === netId);
  const viaItems: number[][] = vias.map((v, i) => layers.map((layer) => add({ layer, box: [v.x - v.pad / 2, v.y - v.pad / 2, v.x + v.pad / 2, v.y + v.pad / 2], kind: 'via', ref: i })));
  // the pours' islands
  const zoneParts: { layer: CopperLayer; zone: BoardView['zones'][number]; index: ReturnType<typeof zoneIndex>; items: number[] }[] = [];
  for (const z of b.zones) {
    if (z.netId !== netId || !layers.includes(z.layer)) continue;
    const index = zoneIndex(z.rects);
    const its: number[] = [];
    for (let k = 0; k < index.count; k++) its.push(add({ layer: z.layer, box: [0, 0, 0, 0], kind: 'zone', ref: zoneParts.length }));
    zoneParts.push({ layer: z.layer, zone: z, index, items: its });
  }
  // where a track meets a pad or a via: an end on it, else the point nearest the other's centre
  const onTrack = (t: Track, x: number, y: number, hit: (ax: number, ay: number, bx: number, by: number) => boolean, endOn: (x: number, y: number) => boolean): number | undefined => {
    const segs = segmentsOf(t.pts);
    if (endOn(t.pts[0]!, t.pts[1]!)) return 0;
    if (endOn(t.pts.at(-2)!, t.pts.at(-1)!)) return arcAt(t, segs.length - 1, 1);
    const k = segs.findIndex(([ax, ay, bx, by]) => hit(ax, ay, bx, by));
    if (k < 0) return undefined;
    const [ax, ay, bx, by] = segs[k]!;
    const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
    return arcAt(t, k, l2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2)) : 0);
  };
  // what touches on each layer
  const overlap = (a: Item['box'], c: Item['box'], g = 0) => a[0] - g <= c[2] && c[0] - g <= a[2] && a[1] - g <= c[3] && c[1] - g <= a[3];
  const touch = (i: number, j: number): void => {
    const [a, c] = [items[i]!, items[j]!];
    if (!overlap(a.box, c.box, EPS)) return;
    if (a.kind === 'track' && c.kind === 'track') {
      const [t, u] = [tracks[a.ref]!, tracks[c.ref]!];
      const reach = Math.min(t.width, u.width) / 2;
      segmentsOf(t.pts).forEach(([ax, ay, bx, by], k) =>
        segmentsOf(u.pts).forEach(([cx, cy, dx, dy], m) => {
          if (segSegDist(ax, ay, bx, by, cx, cy, dx, dy) > reach) return;
          const [p, q] = closestParams(ax, ay, bx, by, cx, cy, dx, dy);
          contacts.push({ a: i, b: j, sa: arcAt(t, k, p), sb: arcAt(u, m, q) });
        }),
      );
      return;
    }
    if (a.kind === 'track' || c.kind === 'track') {
      const [ti, oi] = a.kind === 'track' ? [i, j] : [j, i];
      const [t, o] = [tracks[items[ti]!.ref]!, items[oi]!];
      let s: number | undefined;
      if (o.kind === 'pad') {
        const p = pads[o.ref]!.pad;
        s = onTrack(t, p.x, p.y, (ax, ay, bx, by) => padSegDist(p, ax, ay, bx, by) <= EPS, (x, y) => padPointDist(p, x, y) <= EPS);
      } else {
        const v = vias[o.ref]!;
        s = onTrack(t, v.x, v.y, (ax, ay, bx, by) => pointSegDist(v.x, v.y, ax, ay, bx, by) <= v.pad / 2, (x, y) => Math.hypot(x - v.x, y - v.y) <= v.pad / 2);
      }
      if (s !== undefined) contacts.push({ a: ti, b: oi, sa: s });
      return;
    }
    const [pi, vi] = a.kind === 'pad' && c.kind === 'via' ? [a.ref, c.ref] : a.kind === 'via' && c.kind === 'pad' ? [c.ref, a.ref] : [-1, -1];
    if (pi >= 0 && padPointDist(pads[pi]!.pad, vias[vi]!.x, vias[vi]!.y) <= vias[vi]!.pad / 2) contacts.push({ a: i, b: j });
  };
  for (const layer of layers) {
    const on = items.map((it, i) => (it.layer === layer && it.kind !== 'zone' ? i : -1)).filter((i) => i >= 0);
    for (let x = 0; x < on.length; x++) for (let y = x + 1; y < on.length; y++) touch(on[x]!, on[y]!);
    // the pours: an element joins the islands it reaches (a track where it enters and leaves each)
    for (const zp of zoneParts) {
      if (zp.layer !== layer) continue;
      for (const i of on) {
        const it = items[i]!;
        const g = it.kind === 'track' ? 0.1 : ZONE_REACH;
        const [x0, y0, x1, y1] = it.box;
        const reached = new Map<number, [number, number]>();
        for (const k of zp.index.near(x0 - g, y0 - g, x1 + g, y1 + g)) {
          const isl = zp.index.island[k]!;
          const [rx, ry, rw, rh] = zp.index.box(k);
          if (!overlap(it.box, [rx, ry, rx + rw, ry + rh], g)) continue;
          if (it.kind !== 'track') {
            reached.set(isl, [0, 0]);
            continue;
          }
          const t = tracks[it.ref]!;
          segmentsOf(t.pts).forEach(([ax, ay, bx, by], m) => {
            if (segRectDist(ax, ay, bx, by, rx, ry, rw, rh) > t.width / 2 + 0.1) return;
            const c = clipSeg(ax, ay, bx, by, rx, ry, rw, rh, t.width / 2 + 0.1) ?? [0, 0];
            const [s0, s1] = [arcAt(t, m, c[0]), arcAt(t, m, c[1])];
            const had = reached.get(isl);
            reached.set(isl, had ? [Math.min(had[0], s0), Math.max(had[1], s1)] : [s0, s1]);
          });
        }
        for (const [isl, [s0, s1]] of reached) {
          if (it.kind !== 'track') contacts.push({ a: i, b: zp.items[isl]! });
          else contacts.push({ a: i, b: zp.items[isl]!, sa: s0 }, { a: i, b: zp.items[isl]!, sa: s1 });
        }
      }
    }
  }
  return { layers, items, contacts, tracks, trackIndex, trackItem, pads, padItems, vias, viaItems, zoneParts };
}
type NetCopper = ReturnType<typeof netCopper>;

/** A via group of the net that joins copper on two or more layers: `cut` when it is the only way across. */
interface ViaGroup {
  vias: number[];
  cut: boolean;
  drill: number;
  layers: CopperLayer[];
  ids: string[];
  at: { x: number; y: number };
}

/**
 * The via groups of a net's copper (vias within GROUP_GAP of each other, edge to edge) that join
 * copper on different layers. A group whose removal leaves copper with current on both sides (a
 * pour, two pads or a pad where current comes in) is the only way across (`cut`): the whole current
 * may pass it.
 */
function netVias(cu: NetCopper, isSource: (part: BoardPart, pad: BoardPad) => boolean): ViaGroup[] {
  const { items, vias, viaItems, pads, padItems, zoneParts, layers } = cu;
  if (!vias.length) return [];
  const parent = items.map((_, i) => i);
  const findRoot = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const union = (a: number, c: number) => {
    const [x, y] = [findRoot(a), findRoot(c)];
    if (x !== y) parent[x] = y;
  };
  for (const its of padItems) for (const it of its.slice(1)) union(its[0]!, it);
  for (const c of cu.contacts) union(c.a, c.b);
  // via groups: vias of the net within GROUP_GAP of each other, edge to edge
  const groupOf = vias.map((_, i) => i);
  const gRoot = (i: number): number => (groupOf[i] === i ? i : (groupOf[i] = gRoot(groupOf[i]!)));
  for (let i = 0; i < vias.length; i++) {
    for (let j = i + 1; j < vias.length; j++) {
      const [v, w] = [vias[i]!, vias[j]!];
      if (Math.hypot(v.x - w.x, v.y - w.y) - (v.pad + w.pad) / 2 <= GROUP_GAP) groupOf[gRoot(i)] = gRoot(j);
    }
  }
  const groups = new Map<number, number[]>();
  vias.forEach((_, i) => (groups.get(gRoot(i)) ?? groups.set(gRoot(i), []).get(gRoot(i))!).push(i));
  const list = [...groups.values()];
  // regions (roots) and what they hold
  const size = new Map<number, number>();
  for (let i = 0; i < items.length; i++) size.set(findRoot(i), (size.get(findRoot(i)) ?? 0) + 1);
  const regionPads = new Map<number, Set<number>>();
  const regionSource = new Set<number>();
  const regionZone = new Set<number>();
  pads.forEach((p, i) => {
    if (!padItems[i]!.length) return;
    const r = findRoot(padItems[i]![0]!);
    (regionPads.get(r) ?? regionPads.set(r, new Set()).get(r)!).add(i);
    if (isSource(p.part, p.pad)) regionSource.add(r);
  });
  for (const zp of zoneParts) for (const it of zp.items) regionZone.add(findRoot(it));
  const groupRoots = list.map((g) => new Set(g.flatMap((v) => viaItems[v]!.map(findRoot))));
  const byRegion = new Map<number, number[]>();
  groupRoots.forEach((rs, gi) => {
    for (const r of rs) (byRegion.get(r) ?? byRegion.set(r, []).get(r)!).push(gi);
  });
  const out: ViaGroup[] = [];
  list.forEach((g, gi) => {
    const roots = groupRoots[gi]!;
    if (roots.size < 2) return;
    // the copper on each side once this group is gone
    const seen = new Set<number>();
    const sides: { pads: number; source: boolean; zone: boolean }[] = [];
    for (const start of roots) {
      if (seen.has(start)) continue;
      const side = { pads: 0, source: false, zone: false };
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const r = stack.pop()!;
        side.pads += regionPads.get(r)?.size ?? 0;
        if (regionSource.has(r)) side.source = true;
        if (regionZone.has(r)) side.zone = true;
        for (const other of byRegion.get(r) ?? []) {
          if (other === gi) continue;
          for (const r2_ of groupRoots[other]!) if (!seen.has(r2_)) (seen.add(r2_), stack.push(r2_));
        }
      }
      sides.push(side);
    }
    const carry = sides.filter((s) => s.pads > 0 && (s.zone || s.pads >= 2 || s.source));
    // the layers where the group meets other copper of the net
    const joined = layers.filter((l, li) => g.some((v) => (size.get(findRoot(viaItems[v]![li]!)) ?? 0) > g.length));
    out.push({
      vias: g,
      cut: carry.length >= 2,
      drill: Math.min(...g.map((v) => vias[v]!.drill)),
      layers: joined,
      ids: g.map((v) => idOf(vias[v]!)).filter((x): x is string => !!x),
      at: { x: r2(g.reduce((s, v) => s + vias[v]!.x, 0) / g.length), y: r2(g.reduce((s, v) => s + vias[v]!.y, 0) / g.length) },
    });
  });
  return out;
}

/** A pad or via joined to its net's pour only through thermal-relief spokes, and what lies on its side of them. */
interface Joint {
  kind: 'pad' | 'via';
  ref?: string;
  at: { x: number; y: number };
  layers: CopperLayer[];
  spokes: number;
  spokeWidth: number;
  /** The thinnest copper its spokes are on (µm), for the width they need. */
  copperUm: number;
  capacity: number;
  /** Its spokes are the only way between copper that carries current on both sides (as a via group's cut). */
  cut: boolean;
  /** The net's pads (into NetCopper.pads) on its side of the spokes. */
  side: Set<number>;
}

/**
 * The relief joints of a net (DRC.SPOKE_CURRENT): each pad or via whose contacts with the net's
 * pours are thermal reliefs (not a plane joined solid, a pad with vias in it, or a grouped via:
 * those join solid, layout.md §7 item 9), with the spokes that connect (the zone's added copper
 * starting at its centre) and their capacity. Only a joint whose spokes are the only way from the
 * element to those pours is kept: where other copper joins them too (a drop's stub to its grouped
 * vias, a track into the pour), the joint is not the bottleneck. `cut` as for a via group: both
 * sides carry current (the element's side has a pour, two pads or a pad where current comes in;
 * the pour's side a pad).
 */
function netJoints(b: BoardView, cu: NetCopper, isSource: (part: BoardPart, pad: BoardPad) => boolean, riseC: number, copperUm: Partial<Record<CopperLayer, number>>): Joint[] {
  const { items, pads, padItems, vias, viaItems, zoneParts, contacts } = cu;
  if (!zoneParts.length) return [];
  const solidPlane = (z: BoardView['zones'][number]) => b.planes.find((pl) => pl.netId === z.netId && pl.layer === z.layer)?.style?.thermal === false;
  const elements: { kind: 'pad' | 'via'; index: number; x: number; y: number; items: number[] }[] = [
    ...pads.flatMap(({ pad }, i) => (b.vias.some((v) => v.inPad && v.netId === pad.netId && padPointDist(pad, v.x, v.y) < EPS) ? [] : [{ kind: 'pad' as const, index: i, x: pad.x, y: pad.y, items: padItems[i]! }])),
    ...vias.flatMap((v, i) => (v.group ? [] : [{ kind: 'via' as const, index: i, x: v.x, y: v.y, items: viaItems[i]! }])),
  ];
  // each item's contacts with a pour
  const withZone = new Map<number, number[]>();
  contacts.forEach((c, ci) => {
    for (const [e, o] of [[c.a, c.b], [c.b, c.a]] as const) if (items[o]!.kind === 'zone' && items[e]!.kind !== 'zone') (withZone.get(e) ?? withZone.set(e, []).get(e)!).push(ci);
  });
  const out: Joint[] = [];
  for (const el of elements) {
    const mine = new Set(el.items);
    // its contacts with the pours, each a relief with the spokes that start at its centre
    const reliefs: { contact: number; zone: number; layer: CopperLayer; spokes: number; width: number }[] = [];
    el.items.flatMap((it) => withZone.get(it) ?? []).forEach((ci) => {
      const c = contacts[ci]!;
      const o = mine.has(c.a) ? c.b : c.a;
      const z = zoneParts[items[o]!.ref]!.zone;
      if (!z.shape || solidPlane(z)) return;
      const adds = z.shape.adds.filter((a) => Math.abs(a.pts[0]! - el.x) < 0.002 && Math.abs(a.pts[1]! - el.y) < 0.002);
      reliefs.push({ contact: ci, zone: o, layer: z.layer, spokes: adds.length, width: Math.min(...adds.map((a) => a.w)) });
    });
    const spokes = reliefs.reduce((s, r) => s + r.spokes, 0);
    // (no spokes at all: cut off, DRC.THERMAL_SPOKES says so)
    if (!spokes) continue;
    // the copper without its spokes: a pad's layers and a via's barrel joined, every other contact
    const cut = new Set(reliefs.map((r) => r.contact));
    const parent = items.map((_, i) => i);
    const root = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
      return i;
    };
    const union = (a: number, c: number) => {
      const [x, y] = [root(a), root(c)];
      if (x !== y) parent[x] = y;
    };
    for (const its of [...padItems, ...viaItems]) for (const it of its.slice(1)) union(its[0]!, it);
    contacts.forEach((c, ci) => cut.has(ci) || union(c.a, c.b));
    const here = root(el.items[0]!);
    if (reliefs.some((r) => root(r.zone) === here)) continue; // joined another way too
    const side = new Set<number>();
    let source = false;
    const beyond = new Map<number, number>();
    pads.forEach((p, i) => {
      if (!padItems[i]!.length) return;
      const r = root(padItems[i]![0]!);
      if (r === here) {
        side.add(i);
        if (isSource(p.part, p.pad)) source = true;
      } else beyond.set(r, (beyond.get(r) ?? 0) + 1);
    });
    const zoneHere = zoneParts.some((zp) => zp.items.some((it) => root(it) === here));
    const carries = side.size > 0 && (zoneHere || side.size >= 2 || source);
    const fed = reliefs.some((r) => (beyond.get(root(r.zone)) ?? 0) > 0);
    const counted = reliefs.filter((r) => r.spokes);
    const capacity = counted.reduce((s, r) => s + r.spokes * trackCurrentFor(r.width, copperUm[r.layer] ?? 35, riseC), 0);
    const p = el.kind === 'pad' ? pads[el.index]! : undefined;
    const id = el.kind === 'via' ? idOf(vias[el.index]!) : undefined;
    out.push({
      kind: el.kind,
      ...(p ? { ref: `${p.part.refdes}.${p.pad.number}` } : id ? { ref: id } : {}),
      at: { x: r2(el.x), y: r2(el.y) },
      layers: [...new Set(counted.map((r) => r.layer))],
      spokes,
      spokeWidth: Math.min(...counted.map((r) => r.width)),
      copperUm: Math.min(...counted.map((r) => copperUm[r.layer] ?? 35)),
      capacity,
      cut: carries && fed,
      side,
    });
  }
  return out;
}

/** Copper's resistivity (Ω·m, 20 °C). */
const RHO = 1.72e-8;
/** Pieces of a track shorter than this (mm) join their ends without resistance. */
const JOIN_MM = 0.001;

/** The board's thickness (mm), what a via's barrel spans: the stack-up's, else 1.6. */
function boardThickness(b: Pick<BoardView, 'stackup'>): number {
  const s = b.stackup;
  return s ? s.copper.reduce((x, c) => x + c, 0) + s.dielectric.reduce((x, c) => x + c.mm, 0) : 1.6;
}

/**
 * The split (§14): the net's copper as a resistor network (each track piece between the points where
 * something meets it w·t/(ρ·L), each via's barrel, pads and pours one node each), the source held at
 * 0 V and each load drawing its current from its pads; solved by conjugate gradients on the network's
 * Laplacian (a tree solves exactly as well). Gives each track's current (its largest piece's) and the
 * drop along it, each via's current, each load's drop, and which loads the copper reaches at all.
 */
function solveSplit(b: BoardView, cu: NetCopper, copperUm: Partial<Record<CopperLayer, number>>, source: number[], loads: { pads: number[]; amps: number }[]) {
  const { items, tracks, padItems, vias, viaItems } = cu;
  const parent: number[] = items.map((_, i) => i);
  const node = () => (parent.push(parent.length), parent.length - 1);
  const findRoot = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const union = (a: number, c: number) => {
    const [x, y] = [findRoot(a), findRoot(c)];
    if (x !== y) parent[x] = y;
  };
  for (const its of padItems) for (const it of its.slice(1)) union(its[0]!, it);
  // the source's pads are one point: the part joins them
  for (const p of source.slice(1)) if (padItems[p]!.length && padItems[source[0]!]!.length) union(padItems[p]![0]!, padItems[source[0]!]![0]!);
  // the points along each track where something meets it
  const along: { s: number; n: number }[][] = tracks.map((t) => [
    { s: 0, n: node() },
    { s: segmentsOf(t.pts).reduce((x, [ax, ay, bx, by]) => x + Math.hypot(bx - ax, by - ay), 0), n: node() },
  ]);
  const at = (item: number, s: number) => {
    const n = node();
    along[items[item]!.ref]!.push({ s, n });
    return n;
  };
  for (const c of cu.contacts) {
    const a = c.sa !== undefined ? at(c.a, c.sa) : c.a;
    const o = c.sb !== undefined ? at(c.b, c.sb) : c.b;
    union(a, o);
  }
  type Edge = { a: number; b: number; g: number; track?: number; via?: number };
  const edges: Edge[] = [];
  along.forEach((pts, ti) => {
    const t = tracks[ti]!;
    pts.sort((x, y) => x.s - y.s);
    const area = t.width * 1e-3 * (copperUm[t.layer] ?? 35) * 1e-6;
    for (let k = 1; k < pts.length; k++) {
      const len = pts[k]!.s - pts[k - 1]!.s;
      if (len < JOIN_MM) union(pts[k - 1]!.n, pts[k]!.n);
      else edges.push({ a: pts[k - 1]!.n, b: pts[k]!.n, g: area / (RHO * len * 1e-3), track: ti });
    }
  });
  // a via: its barrel from each layer to the middle, half its length each (plated VIA_PLATING_UM)
  const h = boardThickness(b) * 1e-3;
  vias.forEach((v, vi) => {
    const mid = node();
    const g = (2 * Math.PI * v.drill * 1e-3 * VIA_PLATING_UM * 1e-6) / (RHO * h);
    for (const it of viaItems[vi]!) edges.push({ a: mid, b: it, g, via: vi });
  });
  // the network on its roots, from the source
  const root = (i: number) => findRoot(i);
  const src = source.length && padItems[source[0]!]!.length ? root(padItems[source[0]!]![0]!) : -1;
  const adj = new Map<number, { o: number; g: number; track?: number; via?: number }[]>();
  for (const e of edges) {
    const [x, y] = [root(e.a), root(e.b)];
    if (x === y) continue;
    (adj.get(x) ?? adj.set(x, []).get(x)!).push({ o: y, g: e.g, track: e.track, via: e.via });
    (adj.get(y) ?? adj.set(y, []).get(y)!).push({ o: x, g: e.g, track: e.track, via: e.via });
  }
  const reach = new Set<number>(src >= 0 ? [src] : []);
  const stack = [...reach];
  while (stack.length) for (const { o } of adj.get(stack.pop()!) ?? []) if (!reach.has(o)) (reach.add(o), stack.push(o));
  // the loads drawn where the copper reaches them (each shared over its pads)
  const inject = new Map<number, number>();
  let placed = 0;
  const reached = loads.map((l) => {
    const ns = l.pads.filter((p) => padItems[p]!.length).map((p) => root(padItems[p]![0]!));
    if (!ns.length || !ns.every((n) => reach.has(n))) return false;
    for (const n of ns) inject.set(n, (inject.get(n) ?? 0) - l.amps / ns.length);
    placed += l.amps;
    return true;
  });
  // G v = i, v = 0 at the source (conjugate gradients, Jacobi preconditioned)
  const unknown = [...reach].filter((n) => n !== src);
  const idx = new Map(unknown.map((n, i) => [n, i]));
  const N = unknown.length;
  const diag = new Float64Array(N);
  unknown.forEach((n, i) => (diag[i] = (adj.get(n) ?? []).reduce((s, e) => s + e.g, 0)));
  const mul = (x: Float64Array, out: Float64Array) => {
    unknown.forEach((n, i) => {
      let s = diag[i]! * x[i]!;
      for (const e of adj.get(n) ?? []) {
        const j = idx.get(e.o);
        if (j !== undefined) s -= e.g * x[j]!;
      }
      out[i] = s;
    });
  };
  const rhs = new Float64Array(N);
  unknown.forEach((n, i) => (rhs[i] = inject.get(n) ?? 0));
  const v = new Float64Array(N);
  const r = Float64Array.from(rhs);
  const z = r.map((x, i) => x / diag[i]!);
  const p = Float64Array.from(z);
  const ap = new Float64Array(N);
  const dot = (x: Float64Array, y: Float64Array) => x.reduce((s, xi, i) => s + xi * y[i]!, 0);
  const norm0 = Math.sqrt(dot(rhs, rhs));
  let rz = dot(r, z);
  for (let it = 0; norm0 > 0 && it < 20 * N + 100; it++) {
    mul(p, ap);
    const alpha = rz / dot(p, ap);
    for (let i = 0; i < N; i++) {
      v[i] = v[i]! + alpha * p[i]!;
      r[i] = r[i]! - alpha * ap[i]!;
    }
    if (Math.sqrt(dot(r, r)) <= 1e-13 * norm0) break;
    for (let i = 0; i < N; i++) z[i] = r[i]! / diag[i]!;
    const rz2 = dot(r, z);
    for (let i = 0; i < N; i++) p[i] = z[i]! + (rz2 / rz) * p[i]!;
    rz = rz2;
  }
  const volt = (n: number) => {
    const i = idx.get(root(n));
    return i === undefined ? 0 : v[i]!;
  };
  // each track: its largest piece's current and the drop along it; each via: what crosses it
  const trackAmps = tracks.map(() => 0);
  const viaAmps = vias.map(() => 0);
  for (const e of edges) {
    const i = Math.abs(e.g * (volt(e.a) - volt(e.b)));
    if (e.track !== undefined) trackAmps[e.track] = Math.max(trackAmps[e.track]!, i);
    if (e.via !== undefined) viaAmps[e.via]! += i / 2;
  }
  const trackDrop = along.map((pts) => {
    const vs = pts.map((x) => volt(x.n));
    return (Math.max(...vs) - Math.min(...vs)) * 1000;
  });
  // the load pad furthest down, and the way its current comes: back from it towards the source,
  // each step along the piece that brings it the most current (a tree: its only way)
  let worst: { load: number; pad: number; mv: number } | undefined;
  loads.forEach((l, li) => {
    if (reached[li]) for (const q of l.pads) if (padItems[q]!.length && (!worst || -volt(padItems[q]![0]!) * 1000 > worst.mv)) worst = { load: li, pad: q, mv: -volt(padItems[q]![0]!) * 1000 };
  });
  const pathTracks = new Map<number, number>();
  const pathVias = new Map<number, number>();
  if (worst) {
    const seen = new Set<number>();
    for (let n = root(padItems[worst.pad]![0]!); n !== src && !seen.has(n); ) {
      seen.add(n);
      let best: { o: number; i: number; dv: number; track?: number; via?: number } | undefined;
      for (const e of adj.get(n) ?? []) {
        const dv = volt(e.o) - volt(n);
        if (dv > 0 && (!best || e.g * dv > best.i)) best = { ...e, i: e.g * dv, dv };
      }
      if (!best) break;
      if (best.track !== undefined) pathTracks.set(best.track, (pathTracks.get(best.track) ?? 0) + best.dv * 1000);
      if (best.via !== undefined) pathVias.set(best.via, (pathVias.get(best.via) ?? 0) + best.dv * 1000);
      n = best.o;
    }
  }
  return { placed, reached, trackAmps, trackDrop, viaAmps, dropMv: worst?.mv ?? 0, worst, pathTracks, pathVias };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmt = (v: number) => `${Math.round(v * 100) / 100}`;

/** The track's fix: its width (drawn copper), or the net's width (router copper). */
export function trackFix(b: BoardView, t: CurrentTrack): EditOp[] {
  const net = b.netNames[t.netId] ?? t.netId;
  return t.id ? [{ op: 'edit_copper', ids: [t.id], width_mm: t.needs }] : [{ op: 'set_net', net, track_mm: t.needs }];
}

/** The vias' fix: a tie at the spot for the current. */
export function viaFix(b: BoardView, v: CurrentVias): EditOp[] {
  return [{ op: 'add_vias', kind: 'tie', net: b.netNames[v.netId] ?? v.netId, at: [{ x_mm: v.at.x, y_mm: v.at.y }], amps: v.amps }];
}

/**
 * A relief joint's fix: a pad drops onto its pour with grouped vias beside it (one per spoke that
 * connects, on the spoke's side: there the pour reaches it), a via gets a tie at its spot; and
 * wider spokes on its pours where 2 mm or less carries it.
 */
export function jointFix(b: BoardView, j: CurrentJoint): EditOp[] {
  const net = b.netNames[j.netId] ?? j.netId;
  const out: EditOp[] = [];
  const amps = r2(j.amps);
  if (j.kind === 'pad' && j.ref) {
    const dot = j.ref.lastIndexOf('.');
    const [refdes, number] = [j.ref.slice(0, dot), j.ref.slice(dot + 1)];
    const part = b.parts.find((p) => p.refdes === refdes);
    const pad = part?.pads.find((p) => p.number === number);
    const size = b.rules.viaPad;
    const at = (pad ? spokeDirs(b, j) : []).map(([dx, dy]) => ({ x_mm: r2(pad!.x + dx * (pad!.w / 2 + size / 2 + b.rules.clearance + 0.05)), y_mm: r2(pad!.y + dy * (pad!.h / 2 + size / 2 + b.rules.clearance + 0.05)) }));
    if (at.length) out.push({ op: 'add_vias', kind: 'drop', ref: refdes, pad: number, at, amps });
  } else if (j.kind === 'via') out.push({ op: 'add_vias', kind: 'tie', net, at: [{ x_mm: j.at.x, y_mm: j.at.y }], amps });
  if (j.needs <= 2) for (const layer of j.layers) out.push({ op: 'set_plane_style', layer, net, spoke_mm: j.needs });
  return out;
}

/** The directions (unit steps) of a joint's spokes that connect. */
function spokeDirs(b: BoardView, j: CurrentJoint): [number, number][] {
  const out: [number, number][] = [];
  for (const z of b.zones) {
    if (z.netId !== j.netId || !j.layers.includes(z.layer)) continue;
    for (const a of z.shape?.adds ?? []) {
      if (Math.abs(a.pts[0]! - j.at.x) > 0.006 || Math.abs(a.pts[1]! - j.at.y) > 0.006) continue;
      const d: [number, number] = [Math.sign(Math.round((a.pts[2]! - a.pts[0]!) * 1000)), Math.sign(Math.round((a.pts[3]! - a.pts[1]!) * 1000))];
      if (!out.some((o) => o[0] === d[0] && o[1] === d[1])) out.push(d);
    }
  }
  return out;
}

/** The findings: DRC.TRACK_CURRENT (split: one per net), DRC.CURRENT_UNVERIFIED (one per net), DRC.VIA_CURRENT (per via group), DRC.SPOKE_CURRENT (per relief joint), DRC.CURRENT_UNKNOWN (one per power net without max_current). */
export function currentDrc(b: BoardView, c: CurrentCheck): Diagnostic[] {
  const out: Diagnostic[] = [];
  const severity = (ratio: number) => (ratio > 2 ? 'error' : 'warning');
  // drawn copper: one edit per width needed; router copper: the net's width
  const widen = (name: string, bad: CurrentTrack[]) => {
    const drawn = bad.every((t) => t.id);
    const hints: EditOp[] = drawn
      ? [...new Set(bad.map((t) => t.needs))].map((w) => ({ op: 'edit_copper', ids: bad.filter((t) => t.needs === w).map((t) => t.id!), width_mm: w }))
      : [{ op: 'set_net', net: name, track_mm: Math.max(...bad.map((t) => t.needs)) }];
    const fix = drawn
      ? `Widen them (edit_copper width_mm), or give the current a way round them.`
      : `Widen the net (set_net track_mm) and route again; where the router narrowed a track to get through, make room there and route again (do not lower the net's width).`;
    return { hints, fix };
  };
  for (const n of c.nets) {
    if (n.status === 'unknown') {
      const t = b.tracks.find((x) => x.netId === n.netId);
      const v = b.vias.find((x) => x.netId === n.netId);
      const at = t ? { x: r2(t.pts[0]!), y: r2(t.pts[1]!) } : v ? { x: r2(v.x), y: r2(v.y) } : undefined;
      out.push({
        code: 'DRC.CURRENT_UNKNOWN',
        severity: 'info',
        message: `${n.name} has copper on the board but no max_current, so whether its tracks and vias carry its current is unknown (not checked, not fine). Set it from what the net feeds (set_net max_current: the DC or RMS current, not a switching peak).`,
        ...(at ? { at } : {}),
        entities: [`net:${n.name}`],
      });
      continue;
    }
    const amps = n.amps!;
    const tracks = c.tracks.filter((t) => t.netId === n.netId);
    // too small for the current the stated loads draw through it
    const over = tracks.filter((t) => t.status === 'over').sort((x, y) => y.ratio - x.ratio);
    if (over.length) {
      const worst = over[0]!;
      const len = over.reduce((s, t) => s + t.length, 0);
      const pieces = over.slice(0, 4).map((t) => `${t.id ? `${t.id} ` : ''}${t.width} mm on ${t.layer} (${t.copperUm} µm) carries ${fmt(t.split ?? t.amps)} A and needs ${t.needs} mm, about +${Math.round(t.rise)} °C`);
      const { hints, fix } = widen(n.name, over);
      out.push({
        code: 'DRC.TRACK_CURRENT',
        severity: severity((worst.split ?? worst.amps) / worst.capacity),
        message: `${n.name}: ${plural(over.length, 'track piece')} (${fmt(len)} mm) ${over.length === 1 ? 'is' : 'are'} too narrow for the current the loads stated on it draw through ${over.length === 1 ? 'it' : 'them'} at ${c.riseC} °C: ${pieces.join('; ')}${over.length > 4 ? `; ${over.length - 4} more` : ''}. ${fix} get_current_map lists the pieces.`,
        at: worst.at,
        entities: [`net:${n.name}`, ...over.filter((t) => t.id).map((t) => t.id!)],
        fixHints: hints,
      });
    }
    const bad = tracks.filter((t) => t.status === 'unverified').sort((x, y) => y.ratio - x.ratio);
    if (bad.length) {
      const worst = bad[0]!;
      const narrowest = bad.reduce((m, t) => (t.width < m.width ? t : m));
      const len = bad.reduce((s, t) => s + t.length, 0);
      const needs = [...new Map(bad.map((t) => [t.layer, t])).values()].map((t) => `${t.needs} mm on ${t.layer} (${t.copperUm} µm)`);
      const { hints, fix } = widen(n.name, bad);
      const what =
        n.basis === 'split'
          ? `narrower than its share of the stated loads plus the ${fmt(n.unplaced ?? 0)} A of max_current no load places needs at ${c.riseC} °C`
          : `narrower than ${n.fromRails ? `the rails' ${amps} A (GND has no max_current: the sum of the rails' is its bound)` : `its max_current of ${amps} A`} needs at ${c.riseC} °C`;
      const known =
        n.basis === 'split'
          ? `The loads stated place ${fmt(n.loads ?? 0)} of ${amps} A; whether the rest flows there is not known: widen them, or state the rest (set_net loads).`
          : `Whether ${amps} A flows there is not known (${n.fromRails ? 'the bound is every rail\'s current' : 'max_current is the whole net\'s current'}; a branch to a part that draws little carries less): widen them, or ${n.fromRails ? `give ${n.name} its own max_current (set_net max_current) where it returns less` : 'say what the pins draw (set_net loads)'}${n.why ? `, though the loads stated are not split: ${n.why}` : ''}.`;
      out.push({
        code: 'DRC.CURRENT_UNVERIFIED',
        severity: severity(worst.ratio),
        message: `${n.name}: ${plural(bad.length, 'track piece')} (${fmt(len)} mm, narrowest ${narrowest.width} mm on ${narrowest.layer}) ${bad.length === 1 ? 'is' : 'are'} ${what}: ${needs.join(', ')}; the worst carries ${fmt(worst.capacity)} A and would heat about ${Math.round(worst.rise)} °C. ${known} ${fix} get_current_map lists the pieces.`,
        at: worst.at,
        entities: [`net:${n.name}`, ...bad.filter((t) => t.id).map((t) => t.id!)],
        fixHints: hints,
      });
    }
    for (const v of c.vias.filter((x) => x.netId === n.netId && x.status !== 'ok')) {
      const where = v.layers.length >= 2 ? ` between ${v.layers.join(' and ')}` : '';
      const carry = `${v.vias === 1 ? 'it carries' : 'together they carry'} about ${fmt(v.capacity)} A at ${c.riseC} °C`;
      const why = v.shared
        ? `carry ${fmt(v.amps)} A of ${n.name}'s stated loads${where} (with the other ways across): ${carry} (${v.needs} vias)`
        : `${v.vias === 1 ? 'is' : 'are'} the only way ${n.name}'s copper crosses${where}: ${carry}, and ${v.basis === 'split' ? `${fmt(v.split ?? v.amps)} A of the stated loads crosses here${v.split !== undefined ? ` (${fmt(v.amps)} A with what no load places)` : ''}` : `${n.name}'s max_current is ${amps} A`} (${v.needs} vias)`;
      out.push({
        code: 'DRC.VIA_CURRENT',
        severity: severity((v.status === 'over' ? (v.split ?? v.amps) : v.amps) / v.capacity),
        message: `${plural(v.vias, 'via')} (${v.drill} mm drill) at (${v.at.x}, ${v.at.y}) ${why}. Add vias there (add_vias kind tie at that spot with amps), or join the copper on those layers another way.`,
        at: v.at,
        entities: [`net:${n.name}`, ...v.ids],
        fixHints: viaFix(b, v),
      });
    }
    for (const j of c.joints.filter((x) => x.netId === n.netId && x.status !== 'ok')) {
      const what = j.kind === 'pad' ? (j.ref ?? 'A pad') : `The via${j.ref ? ` ${j.ref}` : ''}`;
      const flows = j.basis === 'split' ? `${fmt(j.split ?? j.amps)} A of the stated loads flows through it${j.split !== undefined ? ` (${fmt(j.amps)} A with what no load places)` : ''}` : `they are the only way ${n.name}'s current comes ${j.kind === 'pad' ? 'from the pad' : 'from the via'} into the pour, and its max_current is ${amps} A (whether that much flows here is not known: set_net loads says)`;
      const cure = j.kind === 'pad' ? `Drop the pad onto the pour with add_vias kind drop (ref, pad, at: right beside it, amps): grouped vias join their pours solid` : `Put a tie there (add_vias kind tie at the via with amps): grouped vias join their pours solid`;
      out.push({
        code: 'DRC.SPOKE_CURRENT',
        severity: severity((j.status === 'over' ? (j.split ?? j.amps) : j.amps) / j.capacity),
        message: `${what} at (${j.at.x}, ${j.at.y}) joins the ${n.name} pour on ${j.layers.join(' and ')} through ${j.spokes} thermal spoke${j.spokes === 1 ? '' : 's'} of ${j.spokeWidth} mm: together about ${fmt(j.capacity)} A at ${c.riseC} °C, and ${flows}. ${cure}; or widen the spokes (set_plane_style spoke_mm ${j.needs <= 2 ? j.needs : 2}${j.needs > 2 ? ', not enough by itself' : ''}).`,
        at: j.at,
        entities: [`net:${n.name}`, ...(j.ref ? [j.ref] : [])],
        fixHints: jointFix(b, j),
      });
    }
    const ir = n.irDrop;
    if (ir?.budgetMv !== undefined && ir.mv > ir.budgetMv) {
      const at = ir.worst[0]?.at;
      const pieces = ir.worst.map((p) => (p.kind === 'track' ? `${p.id ? `${p.id} ` : ''}${p.width} mm on ${p.layer} at (${p.at.x}, ${p.at.y}) drops ${fmt(p.dropMv)} mV at ${fmt(p.amps)} A` : `the via${p.id ? ` ${p.id}` : ''} (${p.drill} mm drill) at (${p.at.x}, ${p.at.y}) drops ${fmt(p.dropMv)} mV at ${fmt(p.amps)} A`));
      const unplaced = n.unplaced ? ` Only the stated loads are counted (${fmt(n.loads ?? 0)} of ${fmt(amps)} A): the real drop can be higher.` : '';
      out.push({
        code: 'DRC.IR_DROP',
        severity: ir.mv > 2 * ir.budgetMv ? 'error' : 'warning',
        message: `${n.name} drops ${fmt(ir.mv)} mV (${fmt(ir.pct!)} % of ${ir.railV} V) from its source to ${ir.load}, over the budget of 3 % (${fmt(ir.budgetMv)} mV).${pieces.length ? ` The most on the way: ${pieces.join('; ')}.` : ''} Widen the path (edit_copper width_mm, or set_net track_mm and route again for router copper; add_vias kind tie where a via drops much), or shorten it.${unplaced} get_current_map lists the drop per piece.`,
        ...(at ? { at } : {}),
        entities: [`net:${n.name}`, ir.load, ...ir.worst.flatMap((p) => (p.id ? [p.id] : []))],
        fixHints: irFix(b, n.netId, ir),
      });
    }
  }
  return out;
}

/**
 * DRC.IR_DROP's fix: the pieces that drop the most, widened (or tied with more vias) until the drop
 * they shed brings the net under 90 % of its budget; each at most four times what it is.
 */
function irFix(b: BoardView, netId: string, ir: IrDrop): EditOp[] {
  const net = b.netNames[netId] ?? netId;
  let excess = ir.mv - 0.9 * ir.budgetMv!;
  const out: EditOp[] = [];
  let routerWidth = 0;
  for (const p of ir.worst) {
    if (excess <= 0 || p.dropMv <= 0) break;
    const k = p.dropMv * 0.75 >= excess ? p.dropMv / (p.dropMv - excess) : 4;
    excess -= p.dropMv * (1 - 1 / k);
    if (p.kind === 'via') out.push({ op: 'add_vias', kind: 'tie', net, at: [{ x_mm: p.at.x, y_mm: p.at.y }], amps: r2(p.amps * k) });
    else {
      const width = Math.ceil(p.width * k * 20 - 1e-6) / 20;
      if (p.id) out.push({ op: 'edit_copper', ids: [p.id], width_mm: width });
      else routerWidth = Math.max(routerWidth, width);
    }
  }
  if (routerWidth) out.push({ op: 'set_net', net, track_mm: routerWidth });
  return out;
}

const trackCode = (t: { status: CurrentStatus }) => (t.status === 'over' ? 'DRC.TRACK_CURRENT' : t.status === 'unverified' ? 'DRC.CURRENT_UNVERIFIED' : undefined);

/** design_query get_current_map: the nets with their status and the hotspots, worst first. */
export function currentMapAnswer(d: Design, b: BoardView, q: Extract<QueryOp, { op: 'get_current_map' }>): unknown {
  // (the routed board's own check: what the DRC and the heat map read)
  const c = b.current ?? currentCheck(d, b);
  const wanted = q.nets ? new Set(q.nets.map((n) => Object.values(d.nets).find((x) => x.name.toUpperCase() === n.toUpperCase() || x.id === n)?.id ?? n)) : null;
  const r = q.rect;
  const inRect = (p: { x: number; y: number }) => !r || (p.x >= r.x_mm && p.y >= r.y_mm && p.x <= r.x_mm + r.width_mm && p.y <= r.y_mm + r.height_mm);
  const keep = (x: { netId: string; status: CurrentStatus; at: { x: number; y: number } }) => (!wanted || wanted.has(x.netId)) && (q.include_ok || x.status !== 'ok') && inRect(x.at);
  const name = (id: string) => b.netNames[id] ?? id;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  // over first (what certainly flows), then by ratio
  const rank = (s: { status: CurrentStatus; ratio: number }) => (s.status === 'over' ? 1000 : 0) + s.ratio;
  const spots = [
    ...c.tracks.filter(keep).map((t) => ({
      rank: rank(t),
      spot: {
        kind: 'track',
        net: name(t.netId),
        layer: t.layer,
        ...(t.id ? { id: t.id } : {}),
        ...(t.from ? { from: t.from } : {}),
        ...(t.to ? { to: t.to } : {}),
        at: { x_mm: t.at.x, y_mm: t.at.y },
        width_mm: t.width,
        length_mm: t.length,
        copper_um: t.copperUm,
        amps: r3(t.amps),
        basis: t.basis,
        ...(t.split !== undefined ? { split_a: r3(t.split) } : {}),
        status: t.status,
        capacity_a: r2(t.capacity),
        ratio: r2(t.ratio),
        rise_c: r1(t.rise),
        ...(t.dropMv !== undefined ? { drop_mv: t.dropMv } : {}),
        needs_width_mm: t.needs,
        ...(trackCode(t) ? { code: trackCode(t), fix: trackFix(b, t) } : {}),
      },
    })),
    ...c.joints.filter(keep).map((j) => ({
      rank: rank(j),
      spot: {
        kind: 'relief',
        net: name(j.netId),
        element: j.kind,
        ...(j.ref ? { ref: j.ref } : {}),
        layers: j.layers,
        at: { x_mm: j.at.x, y_mm: j.at.y },
        spokes: j.spokes,
        spoke_mm: j.spokeWidth,
        amps: r3(j.amps),
        basis: j.basis,
        ...(j.split !== undefined ? { split_a: r3(j.split) } : {}),
        status: j.status,
        capacity_a: r2(j.capacity),
        ratio: r2(j.ratio),
        needs_spoke_mm: j.needs,
        ...(j.status !== 'ok' ? { code: 'DRC.SPOKE_CURRENT', fix: jointFix(b, j) } : {}),
      },
    })),
    ...c.vias.filter(keep).map((v) => ({
      rank: rank(v),
      spot: {
        kind: 'via_group',
        net: name(v.netId),
        layers: v.layers,
        vias: v.vias,
        ...(v.ids.length ? { ids: v.ids } : {}),
        drill_mm: v.drill,
        at: { x_mm: v.at.x, y_mm: v.at.y },
        amps: r3(v.amps),
        basis: v.basis,
        ...(v.split !== undefined ? { split_a: r3(v.split) } : {}),
        status: v.status,
        capacity_a: r2(v.capacity),
        ratio: r2(v.ratio),
        only_path: !v.shared,
        needs_vias: v.needs,
        ...(v.status !== 'ok' ? { code: 'DRC.VIA_CURRENT', fix: viaFix(b, v) } : {}),
      },
    })),
  ].sort((x, y) => y.rank - x.rank);
  return {
    basis: { rise_c: c.riseC, curve: 'IPC-2221 external, all layers', copper_um: c.copperUm, via_plating_um: VIA_PLATING_UM },
    // every net with a current, and every power net without one (unknown): never cut
    nets: c.nets
      .filter((n) => !wanted || wanted.has(n.netId))
      .map((n) =>
        n.status === 'unknown'
          ? { net: n.name, basis: 'unknown', status: 'unknown', why: 'no max_current and no loads: set it (set_net max_current) from what the net feeds' }
          : {
              net: n.name,
              max_current_a: n.amps,
              basis: n.basis,
              status: n.status,
              ...(n.worst !== undefined ? { worst_ratio: n.worst } : {}),
              ...(n.loads !== undefined ? { loads_a: n.loads } : {}),
              ...(n.unplaced !== undefined ? { unplaced_a: n.unplaced, placed: `${fmt(n.loads ?? 0)} of ${fmt(n.amps!)} A placed: the rest may flow anywhere` } : {}),
              ...(n.irDrop
                ? {
                    ir_drop_mv: n.irDrop.mv,
                    ir_load: n.irDrop.load,
                    ...(n.irDrop.budgetMv !== undefined
                      ? { ir_drop_pct: n.irDrop.pct, ir_budget_mv: n.irDrop.budgetMv, ir_status: n.irDrop.mv > n.irDrop.budgetMv ? 'over' : 'ok' }
                      : { ir_budget: 'unknown', ir_why: `${n.name} has no voltage: set it (set_net voltage) to check the drop against 3 % of it` }),
                    ...(n.irDrop.worst.length ? { ir_worst: n.irDrop.worst.map((p) => ({ kind: p.kind, ...(p.id ? { id: p.id } : {}), ...(p.kind === 'track' ? { layer: p.layer, width_mm: p.width } : { drill_mm: p.drill }), at: { x_mm: p.at.x, y_mm: p.at.y }, amps: p.amps, drop_mv: p.dropMv })) } : {}),
                    ...(n.unplaced !== undefined ? { ir_note: 'only the stated loads are counted: the real drop can be higher' } : {}),
                  }
                : n.dropMv !== undefined
                  ? { ir_drop_mv: n.dropMv }
                  : {}),
              ...(n.fromRails ? { why: "no max_current of its own: the sum of the rails' max_current bounds it (each rail's current returns on it)" } : {}),
              ...(n.why ? { why: `loads stated but not split: ${n.why}` } : {}),
            },
      ),
    hotspots: spots.slice(0, q.worst ?? 20).map((s) => s.spot),
    ...(spots.length > (q.worst ?? 20) ? { more: spots.length - (q.worst ?? 20) } : {}),
    note: "split: the current the net's stated loads (set_net loads, add_vias drop amps) draw through each piece, solved over the copper from where the current comes in (with what of max_current no load places added: it may flow anywhere); over = too small for that. bound: each track and each via group that is the only way between two layers is checked for all of the net's max_current (a branch that carries less shows as unverified, not over). ir_drop_mv: the drop from the source to the load pin furthest down (ir_load) the stated loads cause, checked against 3 % of the net's voltage (ir_budget_mv, DRC.IR_DROP; unknown without set_net voltage); ir_worst: the pieces on that way that drop the most; drop_mv per piece. A pour or plane counts as one piece of copper: its necks are not checked, and it drops nothing. Tracks inside their own pour and pieces up to 1 mm long are not counted. relief: a pad or via joined to its pour only through thermal spokes, where the current comes through them (spokes that connect × one spoke's capacity; DRC.SPOKE_CURRENT); a joint whose current is unknown is not listed, and not fine.",
  };
}
