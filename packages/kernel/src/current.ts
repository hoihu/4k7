/**
 * The copper as laid against its net's current (tier 3a of the current check, `bound` basis): every
 * track of a net with max_current is checked for the whole of it on its layer's copper, and the
 * vias where a net's copper changes layer are checked where they are the only way across (a cut of
 * the net's copper graph). A power net without max_current is unknown, never fine. See
 * docs/design/layout.md §14.
 */
import { COPPER_ORDER, padPins, trackCurrentFor, trackRiseFor, trackWidthFor, viaCurrentFor } from '@4k7/schema';
import type { BoardPad, BoardPart, BoardRules, BoardView, CopperLayer, Design, Diagnostic, EditOp, QueryOp, Track } from '@4k7/schema';
import { cardOf, isPowerNet } from './doc.ts';
import { idOf, pointSegDist, segmentsOf, segSegDist } from './geom.ts';
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

export type CurrentStatus = 'ok' | 'unverified' | 'unknown';

export interface CurrentTrack {
  netId: string;
  /** Index into BoardView.tracks. */
  index: number;
  /** Drawn copper: the track's id. */
  id?: string;
  layer: CopperLayer;
  width: number;
  length: number;
  copperUm: number;
  amps: number;
  capacity: number;
  ratio: number;
  /** Its estimated heating (°C) at `amps`. */
  rise: number;
  /** The width that carries `amps` on its layer. */
  needs: number;
  at: { x: number; y: number };
  /** The pads its ends lie on. */
  from?: string;
  to?: string;
}

export interface CurrentVias {
  netId: string;
  at: { x: number; y: number };
  vias: number;
  drill: number;
  /** Drawn copper: the vias' ids. */
  ids: string[];
  /** The layers whose copper they join. */
  layers: CopperLayer[];
  amps: number;
  capacity: number;
  ratio: number;
  /** Vias of that drill that carry `amps`. */
  needs: number;
}

export interface CurrentNet {
  netId: string;
  name: string;
  amps?: number;
  status: CurrentStatus;
  /** The worst ratio of current to capacity among the copper checked. */
  worst?: number;
}

export interface CurrentCheck {
  riseC: number;
  copperUm: Partial<Record<CopperLayer, number>>;
  nets: CurrentNet[];
  /** Every track counted of a net with a current. */
  tracks: CurrentTrack[];
  /** The via groups that are the only way across between two layers' copper (cuts), of a net with a current. */
  vias: CurrentVias[];
}

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

/** The current check of the board's copper against its nets' max_current. */
export function currentCheck(d: Design, b: BoardView): CurrentCheck {
  const riseC = currentRise(b.rules);
  const copperUm = layerCopper(b);
  const out: CurrentCheck = { riseC, copperUm, nets: [], tracks: [], vias: [] };
  if (!b.tracks.length && !b.vias.length && !b.zones.length) return out;
  const isSource = sourcePads(d);
  const has = new Set<string>([...b.tracks.map((t) => t.netId), ...b.vias.map((v) => v.netId), ...b.zones.filter((z) => !z.floating).map((z) => z.netId)]);
  for (const n of Object.values(d.nets)) {
    if (!has.has(n.id)) continue;
    const amps = n.attrs.maxCurrent && n.attrs.maxCurrent > 0 ? n.attrs.maxCurrent : undefined;
    if (!amps) {
      if (isPowerNet(n)) out.nets.push({ netId: n.id, name: n.name, status: 'unknown' });
      continue;
    }
    const tracks = netTracks(b, n.id, amps, riseC, copperUm);
    const vias = netVias(b, n.id, amps, riseC, isSource);
    out.tracks.push(...tracks);
    out.vias.push(...vias);
    const worst = Math.max(0, ...tracks.map((t) => t.ratio), ...vias.map((v) => v.ratio));
    out.nets.push({ netId: n.id, name: n.name, amps, status: worst > 1 ? 'unverified' : 'ok', ...(worst > 0 ? { worst: r2(worst) } : {}) });
  }
  return out;
}

/** The tracks of a net checked for its whole current; a piece inside the net's own pour on its layer, or a short one, is left out. */
function netTracks(b: BoardView, netId: string, amps: number, riseC: number, copperUm: Partial<Record<CopperLayer, number>>): CurrentTrack[] {
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
    out.push({
      netId,
      index,
      ...(id ? { id } : {}),
      layer: t.layer,
      width: t.width,
      length: r2(length),
      copperUm: cu,
      amps,
      capacity,
      ratio: amps / capacity,
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

/**
 * The net's copper as a graph: on each layer its tracks, pads, vias and each connected piece of its
 * pours joined where they touch (a through-hole pad joins its layers), the via groups between the
 * layers. A via group whose removal leaves copper with current on both sides (a pour, two pads or a
 * pad where current comes in) is the only way across: the whole current may pass it.
 */
function netVias(b: BoardView, netId: string, amps: number, riseC: number, isSource: (part: BoardPart, pad: BoardPad) => boolean): CurrentVias[] {
  const vias = b.vias.filter((v) => v.netId === netId);
  if (!vias.length) return [];
  const layers = b.layers;
  // items: one per element and layer
  type Item = { layer: CopperLayer; box: [number, number, number, number]; kind: 'track' | 'pad' | 'via' | 'zone'; ref: number };
  const items: Item[] = [];
  const parent: number[] = [];
  const add = (it: Item) => (items.push(it), parent.push(parent.length), items.length - 1);
  const findRoot = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const union = (a: number, c: number) => {
    const [x, y] = [findRoot(a), findRoot(c)];
    if (x !== y) parent[x] = y;
  };
  const tracks = b.tracks.filter((t) => t.netId === netId);
  tracks.forEach((t, i) => {
    const xs = t.pts.filter((_, k) => k % 2 === 0);
    const ys = t.pts.filter((_, k) => k % 2 === 1);
    const r = t.width / 2;
    add({ layer: t.layer, box: [Math.min(...xs) - r, Math.min(...ys) - r, Math.max(...xs) + r, Math.max(...ys) + r], kind: 'track', ref: i });
  });
  const pads: { part: BoardPart; pad: BoardPad }[] = [];
  for (const part of b.parts) for (const pad of part.pads) if (pad.netId === netId && !pad.npth) pads.push({ part, pad });
  const padItems: number[][] = pads.map(({ pad }, i) => {
    const on = pad.drill ? layers : pad.layers.filter((l) => layers.includes(l));
    const its = on.map((layer) => add({ layer, box: [pad.x - pad.w / 2, pad.y - pad.h / 2, pad.x + pad.w / 2, pad.y + pad.h / 2], kind: 'pad', ref: i }));
    for (const it of its.slice(1)) union(its[0]!, it);
    return its;
  });
  const viaItems: number[][] = vias.map((v, i) => layers.map((layer) => add({ layer, box: [v.x - v.pad / 2, v.y - v.pad / 2, v.x + v.pad / 2, v.y + v.pad / 2], kind: 'via', ref: i })));
  // the pours' islands
  const zoneParts: { layer: CopperLayer; index: ReturnType<typeof zoneIndex>; items: number[] }[] = [];
  for (const z of b.zones) {
    if (z.netId !== netId || !layers.includes(z.layer)) continue;
    const index = zoneIndex(z.rects);
    const its: number[] = [];
    for (let k = 0; k < index.count; k++) its.push(add({ layer: z.layer, box: [0, 0, 0, 0], kind: 'zone', ref: zoneParts.length }));
    zoneParts.push({ layer: z.layer, index, items: its });
  }
  // what touches on each layer
  const overlap = (a: Item['box'], c: Item['box'], g = 0) => a[0] - g <= c[2] && c[0] - g <= a[2] && a[1] - g <= c[3] && c[1] - g <= a[3];
  const touch = (i: number, j: number): boolean => {
    const [a, c] = [items[i]!, items[j]!];
    if (a.kind === 'zone' || c.kind === 'zone') return false;
    if (!overlap(a.box, c.box, EPS)) return false;
    if (a.kind === 'track' && c.kind === 'track') {
      const [t, u] = [tracks[a.ref]!, tracks[c.ref]!];
      const reach = Math.min(t.width, u.width) / 2;
      return segmentsOf(t.pts).some(([ax, ay, bx, by]) => segmentsOf(u.pts).some(([cx, cy, dx, dy]) => segSegDist(ax, ay, bx, by, cx, cy, dx, dy) <= reach));
    }
    if (a.kind === 'track' || c.kind === 'track') {
      const [t, o] = a.kind === 'track' ? [tracks[a.ref]!, c] : [tracks[c.ref]!, a];
      if (o.kind === 'pad') return segmentsOf(t.pts).some(([ax, ay, bx, by]) => padSegDist(pads[o.ref]!.pad, ax, ay, bx, by) <= EPS);
      const v = vias[o.ref]!;
      return segmentsOf(t.pts).some(([ax, ay, bx, by]) => pointSegDist(v.x, v.y, ax, ay, bx, by) <= v.pad / 2);
    }
    if (a.kind === 'pad' && c.kind === 'via') return padPointDist(pads[a.ref]!.pad, vias[c.ref]!.x, vias[c.ref]!.y) <= vias[c.ref]!.pad / 2;
    if (a.kind === 'via' && c.kind === 'pad') return padPointDist(pads[c.ref]!.pad, vias[a.ref]!.x, vias[a.ref]!.y) <= vias[a.ref]!.pad / 2;
    return false;
  };
  for (const layer of layers) {
    const on = items.map((it, i) => (it.layer === layer && it.kind !== 'zone' ? i : -1)).filter((i) => i >= 0);
    for (let x = 0; x < on.length; x++) for (let y = x + 1; y < on.length; y++) if (touch(on[x]!, on[y]!)) union(on[x]!, on[y]!);
    // the pours: an element joins the islands it reaches
    for (const zp of zoneParts) {
      if (zp.layer !== layer) continue;
      for (const i of on) {
        const it = items[i]!;
        const g = it.kind === 'track' ? 0.1 : ZONE_REACH;
        const [x0, y0, x1, y1] = it.box;
        for (const k of zp.index.near(x0 - g, y0 - g, x1 + g, y1 + g)) {
          const isl = zp.index.island[k]!;
          if (findRoot(zp.items[isl]!) === findRoot(i)) continue;
          const [rx, ry, rw, rh] = zp.index.box(k);
          if (!overlap(it.box, [rx, ry, rx + rw, ry + rh], g)) continue;
          if (it.kind === 'track') {
            const t = tracks[it.ref]!;
            if (!segmentsOf(t.pts).some(([ax, ay, bx, by]) => segRectDist(ax, ay, bx, by, rx, ry, rw, rh) <= t.width / 2 + 0.1)) continue;
          }
          union(i, zp.items[isl]!);
        }
      }
    }
  }
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
  const out: CurrentVias[] = [];
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
    if (carry.length < 2) return;
    const drill = Math.min(...g.map((v) => vias[v]!.drill));
    const per = viaCurrentFor(drill, riseC, VIA_PLATING_UM);
    const capacity = g.length * per;
    // the layers where the group meets other copper of the net
    const joined = layers.filter((l, li) => g.some((v) => (size.get(findRoot(viaItems[v]![li]!)) ?? 0) > g.length));
    const ids = g.map((v) => idOf(vias[v]!)).filter((x): x is string => !!x);
    out.push({
      netId,
      at: { x: r2(g.reduce((s, v) => s + vias[v]!.x, 0) / g.length), y: r2(g.reduce((s, v) => s + vias[v]!.y, 0) / g.length) },
      vias: g.length,
      drill,
      ids,
      layers: joined,
      amps,
      capacity,
      ratio: amps / capacity,
      needs: Math.max(1, Math.ceil(amps / per - 1e-6)),
    });
  });
  return out;
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

/** The findings: DRC.CURRENT_UNVERIFIED (one per net), DRC.VIA_CURRENT (per cut via group), DRC.CURRENT_UNKNOWN (one per power net without max_current). */
export function currentDrc(b: BoardView, c: CurrentCheck): Diagnostic[] {
  const out: Diagnostic[] = [];
  const severity = (ratio: number) => (ratio > 2 ? 'error' : 'warning');
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
    const bad = c.tracks.filter((t) => t.netId === n.netId && t.ratio > 1).sort((x, y) => y.ratio - x.ratio);
    if (bad.length) {
      const worst = bad[0]!;
      const narrowest = bad.reduce((m, t) => (t.width < m.width ? t : m));
      const len = bad.reduce((s, t) => s + t.length, 0);
      const needs = [...new Map(bad.map((t) => [t.layer, t])).values()].map((t) => `${t.needs} mm on ${t.layer} (${t.copperUm} µm)`);
      const drawn = bad.every((t) => t.id);
      const fix = drawn
        ? `Widen them (edit_copper width_mm), or give the current a way round them.`
        : `Widen the net (set_net track_mm) and route again; where the router narrowed a track to get through, make room there and route again (do not lower the net's width).`;
      // drawn copper: one edit per width needed; router copper: the net's width
      const hints: EditOp[] = drawn
        ? [...new Set(bad.map((t) => t.needs))].map((w) => ({ op: 'edit_copper', ids: bad.filter((t) => t.needs === w).map((t) => t.id!), width_mm: w }))
        : [{ op: 'set_net', net: n.name, track_mm: Math.max(...bad.map((t) => t.needs)) }];
      out.push({
        code: 'DRC.CURRENT_UNVERIFIED',
        severity: severity(worst.ratio),
        message: `${n.name}: ${plural(bad.length, 'track piece')} (${fmt(len)} mm, narrowest ${narrowest.width} mm on ${narrowest.layer}) ${bad.length === 1 ? 'is' : 'are'} narrower than its max_current of ${amps} A needs at ${c.riseC} °C: ${needs.join(', ')}; the worst carries ${fmt(worst.capacity)} A and would heat about ${Math.round(worst.rise)} °C. Whether ${amps} A flows there is not known (max_current is the whole net's current; a branch to a part that draws little carries less). ${fix} get_current_map lists the pieces.`,
        at: worst.at,
        entities: [`net:${n.name}`, ...bad.filter((t) => t.id).map((t) => t.id!)],
        fixHints: hints,
      });
    }
    for (const v of c.vias.filter((x) => x.netId === n.netId && x.ratio > 1)) {
      const where = v.layers.length >= 2 ? ` between ${v.layers.join(' and ')}` : '';
      out.push({
        code: 'DRC.VIA_CURRENT',
        severity: severity(v.ratio),
        message: `${plural(v.vias, 'via')} (${v.drill} mm drill) at (${v.at.x}, ${v.at.y}) ${v.vias === 1 ? 'is' : 'are'} the only way ${n.name}'s copper crosses${where}: ${v.vias === 1 ? 'it carries' : 'together they carry'} about ${fmt(v.capacity)} A at ${c.riseC} °C, and ${n.name}'s max_current is ${amps} A (${v.needs} vias). Add vias there (add_vias kind tie at that spot with amps), or join the copper on those layers another way.`,
        at: v.at,
        entities: [`net:${n.name}`, ...v.ids],
        fixHints: viaFix(b, v),
      });
    }
  }
  return out;
}

/** design_query get_current_map: the nets with their status and the hotspots, worst first. */
export function currentMapAnswer(d: Design, b: BoardView, q: Extract<QueryOp, { op: 'get_current_map' }>): unknown {
  const c = currentCheck(d, b);
  const wanted = q.nets ? new Set(q.nets.map((n) => Object.values(d.nets).find((x) => x.name.toUpperCase() === n.toUpperCase() || x.id === n)?.id ?? n)) : null;
  const r = q.rect;
  const inRect = (p: { x: number; y: number }) => !r || (p.x >= r.x_mm && p.y >= r.y_mm && p.x <= r.x_mm + r.width_mm && p.y <= r.y_mm + r.height_mm);
  const keep = (x: { netId: string; ratio: number; at: { x: number; y: number } }) => (!wanted || wanted.has(x.netId)) && (q.include_ok || x.ratio > 1) && inRect(x.at);
  const name = (id: string) => b.netNames[id] ?? id;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const spots = [
    ...c.tracks.filter(keep).map((t) => ({
      ratio: t.ratio,
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
        amps: t.amps,
        basis: 'bound',
        capacity_a: r2(t.capacity),
        ratio: r2(t.ratio),
        rise_c: r1(t.rise),
        needs_width_mm: t.needs,
        ...(t.ratio > 1 ? { code: 'DRC.CURRENT_UNVERIFIED', fix: trackFix(b, t) } : {}),
      },
    })),
    ...c.vias.filter(keep).map((v) => ({
      ratio: v.ratio,
      spot: {
        kind: 'via_group',
        net: name(v.netId),
        layers: v.layers,
        vias: v.vias,
        ...(v.ids.length ? { ids: v.ids } : {}),
        drill_mm: v.drill,
        at: { x_mm: v.at.x, y_mm: v.at.y },
        amps: v.amps,
        basis: 'bound',
        capacity_a: r2(v.capacity),
        ratio: r2(v.ratio),
        only_path: true,
        needs_vias: v.needs,
        ...(v.ratio > 1 ? { code: 'DRC.VIA_CURRENT', fix: viaFix(b, v) } : {}),
      },
    })),
  ].sort((x, y) => y.ratio - x.ratio);
  return {
    basis: { rise_c: c.riseC, curve: 'IPC-2221 external, all layers', copper_um: c.copperUm, via_plating_um: VIA_PLATING_UM },
    // every net with a current, and every power net without one (unknown): never cut
    nets: c.nets
      .filter((n) => !wanted || wanted.has(n.netId))
      .map((n) =>
        n.status === 'unknown'
          ? { net: n.name, basis: 'unknown', status: 'unknown', why: 'no max_current: set it (set_net max_current) from what the net feeds' }
          : { net: n.name, max_current_a: n.amps, basis: 'bound', status: n.status, ...(n.worst !== undefined ? { worst_ratio: n.worst } : {}) },
      ),
    hotspots: spots.slice(0, q.worst ?? 20).map((s) => s.spot),
    ...(spots.length > (q.worst ?? 20) ? { more: spots.length - (q.worst ?? 20) } : {}),
    note: 'bound: each track and each via group that is the only way between two layers is checked for all of the net\'s max_current (a branch that carries less shows as unverified, not over). A pour or plane counts as one piece of copper: its necks are not checked. Tracks inside their own pour and pieces up to 1 mm long are not counted.',
  };
}
