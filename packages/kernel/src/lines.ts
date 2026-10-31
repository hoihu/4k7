/**
 * Lines at a set impedance (docs/design/impedance.md): the impedance rules worked out for the
 * board (each layer's track width, a pair's gap, a coplanar line's gap to the ground beside it,
 * from the stack-up with the field solver), and the checks that hold the copper to them (IMP.*):
 * the width on each layer, an unbroken plane under the whole line, the ground beside a coplanar
 * line, a pair kept together and matched in length, a ground via beside each via, no sharp
 * corners, other signals kept away.
 */
import {
  COPPER_ORDER,
  IMPEDANCE_TOLERANCE,
  type Diagnostic,
  type BoardRules,
  type BoardView,
  type CopperLayer,
  type Design,
  type FabProfile,
  type ImpedanceLayer,
  type ImpedanceRule,
  type ImpedanceView,
  type LineStyle,
  type PlaneStyle,
  type Stackup,
  type Track,
} from '@4k7/schema';
import { analyse, gapFor, sideGapFor, widthFor, type Section } from './impedance.ts';
import { segDist } from './segments.ts';

/** What working the rules out needs of the board. */
export interface LineBoard {
  layers: CopperLayer[];
  planes: { netId: string; layer: CopperLayer; style?: PlaneStyle }[];
  rules: BoardRules;
  fab?: FabProfile;
  stackup: Stackup;
}

/** A pair's lengths may differ this much unless its rule says otherwise (mm). */
export const DEFAULT_SKEW = 0.5;
/** A ground via within this distance of a line's via carries its return current between the planes (mm, centre to centre). */
export const RETURN_VIA_MM = 1.5;

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const OUTER = new Set<CopperLayer>(['F.Cu', 'B.Cu']);

/* ------------------------------ working it out ----------------------------- */

type Outcome = { ok: Omit<ImpedanceLayer, 'layer' | 'over' | 'h' | 'er'> } | { why: string };
const memo = new Map<string, Outcome>();

/** The rules of the design worked out for this board: per layer the geometry that gives each, or why it cannot be built there. */
export function resolveImpedance(d: Design, b: LineBoard): ImpedanceView[] {
  return (d.board?.impedance ?? []).filter((r) => r.nets.length && r.nets.every((id) => d.nets[id])).map((r) => resolveRule(r, b));
}

/** The cross-section of a track on copper layer i (top to bottom) over the dielectric `d`, without its width. */
function baseSection(s: Stackup, i: number, d: { mm: number; er: number }): Omit<Section, 'w'> {
  return { t: s.copper[i]!, below: [{ h: d.mm, er: d.er }], ...(s.mask && (i === 0 || i === s.copper.length - 1) ? { mask: { base: s.mask.overLaminate, copper: s.mask.overCopper, er: s.mask.er } } : {}) };
}

/** A line's cross-section on a layer its rule was worked out for, with another width or gap. */
export function sectionOn(b: Pick<BoardView, 'layers'> & { stackup?: Stackup }, lay: ImpedanceLayer, w = lay.width, s = lay.gap): Section | null {
  if (!b.stackup) return null;
  const i = COPPER_ORDER[b.layers.length as 2 | 4]?.indexOf(lay.layer) ?? -1;
  if (i < 0) return null;
  return { ...baseSection(b.stackup, i, { mm: lay.h, er: lay.er }), w, ...(s !== undefined ? { s } : {}), ...(lay.side !== undefined ? { g: lay.side } : {}) };
}

export function resolveRule(r: ImpedanceRule, b: LineBoard): ImpedanceView {
  const n = b.layers.length as 2 | 4;
  const style: LineStyle = r.style ?? (n === 2 ? 'coplanar' : 'microstrip');
  const pair = r.nets.length === 2;
  const order = COPPER_ORDER[n];
  const planeOn = (l: CopperLayer) => b.planes.some((p) => p.layer === l);
  const layers: ImpedanceLayer[] = [];
  const unusable: ImpedanceView['unusable'] = [];
  order.forEach((layer, i) => {
    if (!OUTER.has(layer)) return; // (inner layers are planes on these boards)
    const ref = i === 0 ? 1 : i - 1;
    const over = order[ref]!;
    if (!planeOn(over)) {
      unusable.push({ layer, why: `no plane on ${over} for it to run over` });
      return;
    }
    const diel = b.stackup.dielectric[Math.min(i, ref)]!;
    // (a pour on the layer keeps at least its own clearance from the line: a coplanar gap no smaller)
    const pourClear = Math.max(b.rules.clearance, ...b.planes.filter((p) => p.layer === layer).map((p) => p.style?.clearance ?? 0));
    const out = solveLayer(r, baseSection(b.stackup, i, diel), style, pair, b, pourClear);
    if ('why' in out) unusable.push({ layer, why: out.why });
    else layers.push({ layer, over, h: diel.mm, er: diel.er, ...out.ok });
  });
  return {
    id: r.id,
    nets: [...r.nets],
    ohms: r.ohms,
    tolerance: r.tolerance ?? IMPEDANCE_TOLERANCE,
    style,
    pair,
    layers,
    unusable,
    ...(pair ? { skew: r.skew ?? DEFAULT_SKEW } : {}),
    ...(r.maxLength !== undefined ? { maxLength: r.maxLength } : {}),
    ...(r.keep !== undefined ? { keep: r.keep } : {}),
    ...(r.label ? { label: r.label } : {}),
  };
}

/** One layer: the width (and gaps) that give the rule's impedance there, or why none does. */
function solveLayer(r: ImpedanceRule, base: Omit<Section, 'w'>, style: LineStyle, pair: boolean, b: LineBoard, pourClear: number): Outcome {
  const minTrack = b.fab?.limits.track ?? 0.1;
  const minGap = b.fab?.limits.clearance ?? 0.1;
  const key = JSON.stringify([r.ohms, r.tolerance ?? null, r.width ?? null, r.gap ?? null, r.side ?? null, style, pair, base, minTrack, minGap, b.rules.clearance, pourClear]);
  const hit = memo.get(key);
  if (hit) return hit;
  const out = solve();
  if (memo.size >= 1000) memo.delete(memo.keys().next().value!);
  memo.set(key, out);
  return out;

  function solve(): Outcome {
    const z = r.ohms;
    const kind = pair ? `${z} Ω differential` : `${z} Ω`;
    let side = style === 'coplanar' ? Math.max(r.side ?? Math.max(b.rules.clearance, 0.15), minGap, pourClear) : undefined;
    const sided = <T extends object>(sec: T) => (side !== undefined ? { ...sec, g: side } : sec);
    let w: number | null;
    let s: number | undefined;
    if (!pair) {
      if (r.width !== undefined) {
        w = r.width;
        if (style === 'coplanar' && r.side === undefined) {
          const g = sideGapFor(z, { ...base, w });
          if (g === null) return { why: `a ${w} mm line cannot make ${kind} coplanar on this stack-up (${analyse({ ...base, w }).z.toFixed(1)} Ω with no ground beside it): give another width, or leave it to the kernel` };
          side = Math.max(r3(g), minGap, pourClear);
        }
      } else {
        w = widthFor(z, sided(base));
        if (w === null) return { why: `no track width makes ${kind} on this stack-up` };
      }
    } else if (r.width !== undefined) {
      w = r.width;
      const g = gapFor(z, sided({ ...base, w }));
      if (g === null) return { why: `${w} mm tracks make ${kind} at no gap on this stack-up: give another width, or leave it to the kernel` };
      s = g;
    } else {
      s = Math.max(r.gap ?? Math.max(b.rules.clearance, 0.1), minGap);
      w = widthFor(z, sided({ ...base, s }));
      // narrower than the fab makes: a wider gap (looser coupling) lets the tracks widen
      for (let k = 0; w !== null && w < minTrack && r.gap === undefined && k < 12; k++) {
        s *= 1.25;
        w = widthFor(z, sided({ ...base, s }));
      }
      if (w === null) return { why: `no track width makes ${kind} at a ${r3(s)} mm gap on this stack-up` };
    }
    w = r3(w);
    if (s !== undefined) s = r3(s);
    if (w < minTrack - 1e-9) return { why: `it needs ${w} mm tracks, narrower than the ${minTrack} mm ${b.fab ? `${b.fab.house} makes` : 'a fab makes'}: a thicker dielectric (another stack-up)${style === 'microstrip' ? ' or a coplanar line' : ''} instead` };
    if (s !== undefined && s < minGap - 1e-9) return { why: `it needs a ${s} mm gap between the tracks, below the ${minGap} mm ${b.fab ? `${b.fab.house} makes` : 'a fab makes'}` };
    const res = analyse({ ...base, w, ...(s !== undefined ? { s } : {}), ...(side !== undefined ? { g: side } : {}) });
    // (sizes given rather than found may miss the target)
    const tol = r.tolerance ?? IMPEDANCE_TOLERANCE;
    if (Math.abs(res.z / z - 1) * 100 > tol) return { why: `${w} mm${s !== undefined ? ` at a ${s} mm gap` : ''}${side !== undefined ? ` with the ground ${r3(side)} mm beside it` : ''} gives ${res.z.toFixed(1)} Ω, more than ${tol} % off ${kind}` };
    // a microstrip: how far ground copper on its layer keeps, so it changes the impedance by under 2 %
    let pourGap: number | undefined;
    if (style === 'microstrip') {
      const g = sideGapFor(res.z * 0.98, { ...base, w, ...(s !== undefined ? { s } : {}) }, 0.02, 10);
      pourGap = Math.ceil((g ?? 10) * 20 - 1e-6) / 20;
    }
    return {
      ok: {
        width: w,
        ...(s !== undefined ? { gap: s } : {}),
        ...(side !== undefined ? { side: r3(side) } : {}),
        ohms: Math.round(res.z * 10) / 10,
        delay: Math.round(res.delay * 100) / 100,
        ...(pourGap !== undefined ? { pourGap } : {}),
      },
    };
  }
}

/** A net's width on a layer from its rule (or, for the router, its first layer's): undefined without one. */
export function ruleWidth(views: ImpedanceView[] | undefined, netId: string, layer?: CopperLayer): number | undefined {
  const v = views?.find((x) => x.nets.includes(netId));
  if (!v) return undefined;
  return (v.layers.find((l) => l.layer === layer) ?? v.layers[0])?.width;
}

/**
 * How far the pours keep from each controlled net's copper: a coplanar line's gap to the ground
 * beside it, a microstrip's pour gap (so the ground does not change it).
 */
export function pourGaps(views: ImpedanceView[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of views ?? []) {
    const gap = Math.max(0, ...v.layers.map((l) => l.side ?? l.pourGap ?? 0));
    if (gap > 0) for (const id of v.nets) out[id] = gap;
  }
  return out;
}

/* --------------------------------- words --------------------------------- */

const f2 = (v: number) => String(Math.round(v * 100) / 100);

/** A rule as the effects and get_board say it: target, then per layer the geometry and what it gives. */
export function impedanceText(v: ImpedanceView, name: (id: string) => string): string {
  const head = `${v.id} ${v.nets.map(name).join('/')}${v.label ? ` (${v.label})` : ''}: ${v.ohms} Ω${v.pair ? ' differential' : ''} ±${v.tolerance} %, ${v.style}`;
  const seen = new Map<string, CopperLayer>();
  const per = v.layers.map((l) => {
    const geo = `${l.width} mm wide${l.gap !== undefined ? `, ${l.gap} mm apart` : ''}${l.side !== undefined ? `, ${l.side} mm to the ground beside it` : ''} → ${l.ohms} Ω, ${l.delay} ps/mm${l.pourGap !== undefined ? `; ground on ${l.layer} keeps ${l.pourGap} mm away` : ''}`;
    const was = seen.get(geo);
    seen.set(geo, l.layer);
    return `${l.layer} over ${l.over} (${f2(l.h)} mm, εr ${l.er}): ${was ? `as on ${was}` : geo}`;
  });
  const not = v.unusable.map((u) => `not on ${u.layer}: ${u.why}`);
  return [head, ...per, ...not].join('; ');
}

/* ------------------------------ on the copper ------------------------------ */

const idOf = (x: object): string | undefined => (x as { id?: string }).id;

function pieces(t: { pts: number[] }): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let q = 0; q + 3 < t.pts.length; q += 2) out.push([t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!]);
  return out;
}

export const trackLength = (t: { pts: number[] }) => pieces(t).reduce((s, [ax, ay, bx, by]) => s + Math.hypot(bx - ax, by - ay), 0);

/** Points along a track every `step` mm: where, and the unit direction there. */
function samples(t: Track, step: number): { x: number; y: number; ux: number; uy: number }[] {
  const out: { x: number; y: number; ux: number; uy: number }[] = [];
  for (const [ax, ay, bx, by] of pieces(t)) {
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    const [ux, uy] = [(bx - ax) / len, (by - ay) / len];
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k <= n; k++) out.push({ x: ax + (ux * len * k) / n, y: ay + (uy * len * k) / n, ux, uy });
  }
  return out;
}

/** The length (mm) and vias of each controlled net on the copper. */
export function lineMeasures(b: Pick<BoardView, 'tracks' | 'vias'>, v: ImpedanceView): { lengths: Record<string, number>; vias: Record<string, number> } {
  const lengths: Record<string, number> = {};
  const vias: Record<string, number> = {};
  for (const id of v.nets) {
    lengths[id] = Math.round(b.tracks.filter((t) => t.netId === id).reduce((s, t) => s + trackLength(t), 0) * 100) / 100;
    vias[id] = b.vias.filter((x) => x.netId === id).length;
  }
  return { lengths, vias };
}

const G = 0.1; // the pours' grid

/** How far other signals keep from a line (edge to edge): its rule's, else twice its width, or for a coplanar line room for the ground beside it. */
export const keepOf = (v: Pick<ImpedanceView, 'keep'>, lay: Pick<ImpedanceLayer, 'width' | 'side'>) => v.keep ?? (lay.side !== undefined ? Math.max(2 * lay.side, 0.5) : 2 * lay.width);

/**
 * The IMP.* checks of the copper against the impedance rules. `focus`: only the drawn tracks and
 * vias with these ids (what an op just drew); the checks of the whole line (the plane under it,
 * the ground beside it, lengths) need the board routed, with its pours. `quiet`: nets that are no
 * aggressor beside a line (supplies; nets with a plane always count as quiet).
 */
export function impedanceDrc(b: BoardView, focus?: Set<string>, quiet: Set<string> = new Set()): Diagnostic[] {
  const views = b.impedance ?? [];
  if (!views.length) return [];
  const out: Diagnostic[] = [];
  const name = (id: string) => b.netNames[id] ?? id;
  const at = (x: number, y: number) => ({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
  const xy = (x: number, y: number) => `${f2(x)}, ${f2(y)}`;
  const planeNets = new Set(b.planes.map((p) => p.netId));
  const poured = b.zones.length > 0;
  // the pours rastered per layer: which zone's net (index into zoneNet) covers each cell
  const W = Math.ceil(b.outline.w / G) + 3;
  const H = Math.ceil(b.outline.h / G) + 3;
  const zoneNet: string[] = [];
  const maps = new Map<CopperLayer, Int32Array>();
  const mapOf = (layer: CopperLayer) => {
    let m = maps.get(layer);
    if (m) return m;
    m = new Int32Array(W * H).fill(-1);
    for (const z of b.zones) {
      if (z.layer !== layer) continue;
      const k = zoneNet.push(z.netId) - 1;
      for (let q = 0; q + 3 < z.rects.length; q += 4) {
        const [x, y, w, h] = [z.rects[q]!, z.rects[q + 1]!, z.rects[q + 2]!, z.rects[q + 3]!];
        for (let j = Math.max(0, Math.round((y + G / 2) / G)); j <= Math.min(H - 1, Math.round((y + h - G / 2) / G)); j++) {
          for (let i = Math.max(0, Math.round((x + G / 2) / G)); i <= Math.min(W - 1, Math.round((x + w - G / 2) / G)); i++) m[j * W + i] = k;
        }
      }
    }
    maps.set(layer, m);
    return m;
  };
  const netAt = (layer: CopperLayer, x: number, y: number): string | null => {
    const i = Math.round(x / G);
    const j = Math.round(y / G);
    if (i < 0 || j < 0 || i >= W || j >= H) return null;
    const k = mapOf(layer)[j * W + i]!;
    return k >= 0 ? zoneNet[k]! : null;
  };

  /** Edge-to-edge gaps from points along a track to its partner tracks (Infinity where none is near), away from the pads. */
  const gapsAlong = (t: Track, partner: Track[], skip: (x: number, y: number) => boolean) =>
    samples(t, 0.2)
      .filter((s) => !skip(s.x, s.y))
      .map((s) => Math.min(Infinity, ...partner.map((o) => Math.min(...pieces(o).map(([ax, ay, bx, by]) => segDist(ax, ay, bx, by)(s.x, s.y))) - (t.width + o.width) / 2)));
  /** The gap a pair's track keeps to its partner most of the way (the median), or undefined where it mostly has none near. */
  const usualGap = (gaps: number[], reach: number) => {
    const near = gaps.filter((g) => g < reach).sort((a, b) => a - b);
    return near.length >= Math.max(1, gaps.length / 2) ? near[Math.floor(near.length / 2)] : undefined;
  };

  for (const v of views) {
    const label = `${v.id} (${v.nets.map(name).join('/')})`;
    const mine = (x: { netId: string }) => v.nets.includes(x.netId);
    const tracks = b.tracks.filter(mine);
    const vias = b.vias.filter(mine);
    const wanted = (x: object) => !focus || focus.has(idOf(x) ?? '');
    const pads = b.parts.flatMap((p) => p.pads.filter((q) => q.netId && v.nets.includes(q.netId)));
    // near the line's own pads and vias it fans out, necks down and leaves its plane's gap: not judged there
    const nearEnd = (x: number, y: number, r: number) =>
      pads.some((q) => Math.max(Math.abs(x - q.x) - q.w / 2, Math.abs(y - q.y) - q.h / 2) <= r) || vias.some((q) => Math.hypot(x - q.x, y - q.y) <= q.pad / 2 + r);
    // nor over the parts it connects (their other pins pierce the plane round its pads)
    const ends = b.parts.filter((p) => p.pads.some((q) => q.netId && v.nets.includes(q.netId))).map((p) => p.courtyard);
    const atPart = (x: number, y: number) => ends.some((c) => x >= c.x - 0.5 && x <= c.x + c.w + 0.5 && y >= c.y - 0.5 && y <= c.y + c.h + 0.5);
    const layerOf = new Map(v.layers.map((l) => [l.layer, l]));
    const ids = (x: object) => [v.id, ...(idOf(x) ? [idOf(x)!] : [])];
    const what = (t: object, kind = 'track') => (idOf(t) ? `${kind} ${idOf(t)}` : `a ${kind}`);
    for (const t of tracks) {
      if (!wanted(t)) continue;
      const lay = layerOf.get(t.layer);
      const net = name(t.netId);
      if (!lay) {
        const why = v.unusable.find((u) => u.layer === t.layer)?.why ?? 'it is not worked out for this layer';
        out.push({ code: 'IMP.LAYER', severity: 'error', message: `${label}: ${what(t)} of ${net} runs on ${t.layer}, where the line cannot be built (${why}).${v.layers.length ? ` Run it on ${v.layers.map((l) => l.layer).join(' or ')}.` : ''}`, at: at(t.pts[0]!, t.pts[1]!), entities: ids(t) });
        continue;
      }
      // the width (a short neck into a pad aside); a pair's track with the gap it keeps to its partner
      const len = trackLength(t);
      const neck = len <= 1.5 && (nearEnd(t.pts[0]!, t.pts[1]!, 0.05) || nearEnd(t.pts.at(-2)!, t.pts.at(-1)!, 0.05));
      let gap: number | undefined;
      if (v.pair && lay.gap !== undefined) {
        const partner = tracks.filter((o) => o.netId !== t.netId && o.layer === t.layer);
        const fan = Math.max(1, 2 * (lay.width + lay.gap));
        gap = usualGap(gapsAlong(t, partner, (x, y) => nearEnd(x, y, fan)), 3 * (lay.width + lay.gap));
      }
      const gapOff = gap !== undefined && Math.abs(gap - lay.gap!) > 0.0015;
      if (!neck && (Math.abs(t.width - lay.width) > 0.0015 || gapOff)) {
        const sec = sectionOn(b, lay, t.width, gap !== undefined ? Math.max(0.01, gap) : lay.gap);
        const z = sec ? analyse(sec).z : NaN;
        if (!(Math.abs(z / v.ohms - 1) * 100 <= v.tolerance)) {
          const geo = gapOff ? `${t.width} mm wide, ${f2(gap!)} mm from its partner` : `${t.width} mm wide`;
          out.push({ code: 'IMP.WIDTH', severity: 'error', message: `${label}: ${what(t)} of ${net} is ${geo} on ${t.layer}: ${Number.isFinite(z) ? `${z.toFixed(1)} Ω` : 'off'}, not ${v.ohms} Ω ±${v.tolerance} % (${lay.width} mm${lay.gap !== undefined ? ` at ${lay.gap} mm` : ''} gives it).`, at: at(t.pts[0]!, t.pts[1]!), entities: ids(t) });
        }
      }
      // sharp corners: a line bends by 45° at a time
      const ps = pieces(t).filter(([ax, ay, bx, by]) => Math.hypot(bx - ax, by - ay) > 0.1);
      for (let q = 1; q < ps.length; q++) {
        const [a, c] = [ps[q - 1]!, ps[q]!];
        const turn = Math.abs(Math.atan2((a[2] - a[0]) * (c[3] - c[1]) - (a[3] - a[1]) * (c[2] - c[0]), (a[2] - a[0]) * (c[2] - c[0]) + (a[3] - a[1]) * (c[3] - c[1])));
        if (turn > (46 * Math.PI) / 180) {
          out.push({ code: 'IMP.CORNER', severity: 'warning', message: `${label}: ${what(t)} of ${net} turns ${Math.round((turn * 180) / Math.PI)}° at ${xy(c[0], c[1])}: a line at a set impedance bends 45° at a time (two 45° corners for a right angle; bend "diagonal_first" puts them in).`, at: at(c[0], c[1]), entities: ids(t) });
          break;
        }
      }
      if (!poured) continue;
      // the plane under it, unbroken, reaching past each edge by the height over it
      let gapAt: { x: number; y: number } | null = null;
      let changed: { x: number; y: number; from: string; to: string } | null = null;
      let last: string | null = null;
      // (a run of two samples or more without plane: one alone is a small hole at the band's edge)
      let run = { x: 0, y: 0, n: 0 };
      const reach = t.width / 2 + lay.h;
      for (const p of samples(t, 0.2)) {
        if (nearEnd(p.x, p.y, 0.5) || atPart(p.x, p.y)) {
          run = { x: 0, y: 0, n: 0 };
          continue;
        }
        const centre = netAt(lay.over, p.x, p.y);
        const under = [centre, netAt(lay.over, p.x - p.uy * reach, p.y + p.ux * reach), netAt(lay.over, p.x + p.uy * reach, p.y - p.ux * reach)];
        if (under.some((n) => n === null || !planeNets.has(n))) {
          run = run.n ? { ...run, n: run.n + 1 } : { x: p.x, y: p.y, n: 1 };
          // (right under the line: a gap at once)
          if (!gapAt && (run.n >= 2 || centre === null || !planeNets.has(centre))) gapAt = { x: run.x, y: run.y };
          continue;
        }
        run = { x: 0, y: 0, n: 0 };
        if (last && centre !== last && !changed) changed = { x: p.x, y: p.y, from: last, to: centre! };
        last = centre;
      }
      if (gapAt) out.push({ code: 'IMP.REFERENCE', severity: 'error', message: `${label}: ${what(t)} of ${net} leaves its plane at ${xy(gapAt.x, gapAt.y)}: no copper of the ${lay.over} plane under it there (a gap, a split's edge, a via's clearance, a cutout or the plane's edge). A line needs its plane unbroken under it and ${f2(lay.h)} mm past each edge: move it, or what cuts the plane (on 2 layers: tracks crossing under it on ${lay.over}).`, at: at(gapAt.x, gapAt.y), entities: ids(t) });
      else if (changed) out.push({ code: 'IMP.REFERENCE', severity: 'warning', message: `${label}: ${what(t)} of ${net} crosses from the ${name(changed.from)} plane to the ${name(changed.to)} plane on ${lay.over} at ${xy(changed.x, changed.y)}: its return current has to jump between them there. Keep it over one plane, or put a capacitor (100 nF) between the two planes right at the crossing.`, at: at(changed.x, changed.y), entities: ids(t) });
      // a coplanar line: the ground beside it on its own layer
      if (lay.side !== undefined) {
        const partner = v.pair ? tracks.filter((o) => o.netId !== t.netId && o.layer === t.layer) : [];
        let missing = 0;
        let first: { x: number; y: number } | null = null;
        for (const p of samples(t, 0.2)) {
          if (nearEnd(p.x, p.y, 0.5) || atPart(p.x, p.y)) continue;
          const off = t.width / 2 + lay.side + 0.15;
          for (const sgn of [1, -1]) {
            const [qx, qy] = [p.x - sgn * p.uy * off, p.y + sgn * p.ux * off];
            if (partner.some((o) => pieces(o).some(([ax, ay, bx, by]) => segDist(ax, ay, bx, by)(qx, qy) <= o.width / 2 + lay.side! + 0.15))) continue;
            const n = netAt(t.layer, qx, qy);
            if (n === null || !planeNets.has(n)) {
              missing += 0.2;
              first ??= { x: p.x, y: p.y };
              break;
            }
          }
        }
        if (first && missing >= 1) {
          const bare = sectionOn(b, lay);
          const z = bare ? analyse({ ...bare, g: undefined }).z : NaN;
          out.push({ code: 'IMP.COPLANAR', severity: 'warning', message: `${label}: ${what(t)} of ${net} has no ground beside it on ${t.layer} for ${f2(missing)} mm (from ${xy(first.x, first.y)}): a coplanar line wants the ground pour on its own layer ${lay.side} mm from it on both sides, joined to the plane below with a via fence; without it the line is ${Number.isFinite(z) ? `${z.toFixed(0)} Ω` : 'off'}. Pour ground there (set_plane ${t.layer} with rect or under).`, at: at(first.x, first.y), entities: ids(t) });
        }
      }
    }
    // other signals kept away (crosstalk)
    for (const t of tracks) {
      if (!wanted(t)) continue;
      const lay = layerOf.get(t.layer);
      if (!lay) continue;
      const keep = keepOf(v, lay);
      const told = new Set<string>();
      const others = b.tracks.filter((o) => o.layer === t.layer && !mine(o) && !planeNets.has(o.netId) && !quiet.has(o.netId));
      for (const p of samples(t, 0.25)) {
        if (nearEnd(p.x, p.y, 1)) continue;
        for (const o of others) {
          if (told.has(o.netId)) continue;
          const dd = Math.min(...pieces(o).map(([ax, ay, bx, by]) => segDist(ax, ay, bx, by)(p.x, p.y))) - (t.width + o.width) / 2;
          if (dd < keep - 1e-3) {
            told.add(o.netId);
            out.push({ code: 'IMP.SPACING', severity: 'warning', message: `${label}: ${name(o.netId)} runs ${f2(Math.max(0, dd))} mm from ${what(t)} of ${name(t.netId)} at ${xy(p.x, p.y)} on ${t.layer}; keep other signals ${f2(keep)} mm away from it (crosstalk), or put ground between them.`, at: at(p.x, p.y), entities: [...ids(t), `net:${name(o.netId)}`] });
          }
        }
      }
    }
    // vias: each with a ground via beside it; a pair's two with as many
    for (const x of vias) {
      if (!wanted(x)) continue;
      if (b.vias.some((g) => g !== x && planeNets.has(g.netId) && !mine(g) && Math.hypot(g.x - x.x, g.y - x.y) <= RETURN_VIA_MM)) continue;
      out.push({ code: 'IMP.VIA', severity: 'warning', message: `${label}: ${what(x, 'via')} of ${name(x.netId)} changes layer at ${xy(x.x, x.y)} with no ground via within ${RETURN_VIA_MM} mm: the return current has no way between the planes there. Put a via of the plane's net (GND) right beside it (a pair: one beside each, symmetric), or keep the line on one layer.`, at: at(x.x, x.y), entities: ids(x) });
    }
    if (focus) continue;
    const m = lineMeasures(b, v);
    if (v.pair) {
      const [p, n] = v.nets as [string, string];
      if (m.vias[p] !== m.vias[n]) out.push({ code: 'IMP.VIA', severity: 'warning', message: `${label}: ${name(p)} has ${m.vias[p]} via${m.vias[p] === 1 ? '' : 's'}, ${name(n)} ${m.vias[n]}: a pair changes layer together, with as many vias on each side.`, entities: [v.id] });
      // kept together at one gap (the one it keeps most of the way: another than the rule's is the
      // width check's business, where it misses the impedance)
      for (const t of tracks.filter((x) => x.netId === p)) {
        const lay = layerOf.get(t.layer);
        if (!lay || lay.gap === undefined) continue;
        const partner = tracks.filter((o) => o.netId === n && o.layer === t.layer);
        const fan = Math.max(1, 2 * (lay.width + lay.gap));
        const pts = samples(t, 0.2).filter((s) => !nearEnd(s.x, s.y, fan));
        const gaps = gapsAlong(t, partner, (x, y) => nearEnd(x, y, fan));
        const keeps = usualGap(gaps, 3 * (lay.width + lay.gap)) ?? lay.gap;
        let off = 0;
        let worst: { x: number; y: number; gap: number } | null = null;
        gaps.forEach((gap, q) => {
          if (Math.abs(gap - keeps) <= Math.max(0.025, 0.2 * keeps)) return;
          off += 0.2;
          if (!worst || Math.abs(gap - keeps) > Math.abs(worst.gap - keeps)) worst = { x: pts[q]!.x, y: pts[q]!.y, gap };
        });
        const total = gaps.length * 0.2;
        const w = worst as { x: number; y: number; gap: number } | null;
        if (w && off >= Math.max(1, 0.1 * total)) {
          out.push({ code: 'IMP.GAP', severity: 'warning', message: `${label}: the pair runs apart for ${f2(off)} of ${f2(total)} mm on ${t.layer} (at ${xy(w.x, w.y)}: ${Number.isFinite(w.gap) ? `${f2(Math.max(0, w.gap))} mm` : 'no partner'} instead of ${f2(keeps)} mm). Keep its two tracks together at one gap all the way (draw_pair), apart only where they leave their pads.`, at: at(w.x, w.y), entities: [v.id, ...(idOf(t) ? [idOf(t)!] : [])] });
        }
      }
      // matched in length (once both are complete)
      const open = b.unrouted.some((u) => v.nets.includes(u.netId));
      const skew = Math.abs(m.lengths[p]! - m.lengths[n]!);
      if (!open && m.lengths[p]! > 0 && m.lengths[n]! > 0 && skew > (v.skew ?? DEFAULT_SKEW) + 1e-6) {
        const [long, short] = m.lengths[p]! > m.lengths[n]! ? [p, n] : [n, p];
        const delay = v.layers[0]?.delay ?? 6;
        out.push({ code: 'IMP.SKEW', severity: 'warning', message: `${label}: ${name(long)} is ${f2(skew)} mm longer than ${name(short)} (${m.lengths[long]} against ${m.lengths[short]} mm, about ${f2(skew * delay)} ps); at most ${v.skew ?? DEFAULT_SKEW} mm. Add length to ${name(short)} close to the end where the difference arises (small bumps on its track, the pair's gap kept elsewhere), or route the two alike.`, entities: [v.id] });
      }
    }
    for (const id of v.nets) {
      if (v.maxLength !== undefined && m.lengths[id]! > v.maxLength + 1e-6) out.push({ code: 'IMP.LENGTH', severity: 'warning', message: `${label}: ${name(id)} runs ${m.lengths[id]} mm, longer than its ${v.maxLength} mm.`, entities: [v.id] });
    }
  }
  return out;
}
