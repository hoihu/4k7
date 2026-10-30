/**
 * Board view: deterministic placement from the netlist, the schematic and the ledger, then
 * the ratsnest and placement checks. Routing (router.ts) runs on the result.
 *
 * Placement strategy:
 *  - Start from the schematic: parts keep the relative positions of their symbols (scaled to
 *    the board), so functional groups that the schematic layout already formed stay together.
 *  - Relax: pads are pulled towards the other pads of their nets (supply and ground nets pull
 *    weakly, they are poured or routed wide anyway), decoupling capacitors are pulled to "their"
 *    supply pin (one cap per pin, nearest first), `near` constraints pull hard, and courtyards
 *    push each other apart.
 *  - Two-pin parts get the rotation with the shortest connections; everything snaps to 0.1 mm.
 *  - From a stored placement only what a change touches moves: the part moved, the parts that
 *    follow it, new parts, and the parts they push into (round by round); everything else stays
 *    exactly where it was (no re-snapping, re-aligning or re-relaxing of the whole board).
 *  - `position` constraints (the place op, dragging) pin a part; the placer never moves it.
 *  - `layer` constraints put a part on the bottom side: its footprint is mirrored (seen from the
 *    top), its SMD pads are on B.Cu, and it shares the area with the SMD parts on the top side.
 */
import {
  DEFAULT_BOARD,
  type BoardDiagnostic,
  type BoardPad,
  type BoardPart,
  type BodyCorner,
  type BoardView,
  type Component,
  type Constraint,
  type CopperLayer,
  type Design,
  type MountingHole,
  type PlaneArea,
  type PlaneStyle,
  PLANE_AREA_MARGIN,
  type PackageInfo,
  type PartCard,
  type RatsLine,
  type SchematicView,
  type StoredPlacement,
  type StoredCopper,
  type UnroutedConnection,
  type BoardCutout,
  type BoardRules,
  type DrawnCopper,
  type DrawnTrack,
  type DrawnVia,
  type PadAnchor,
  type Track,
  type Via,
  type ViaGroup,
  VIA_PITCH,
  viaCurrentFor,
  viasForCurrent,
  cutoutBounds,
  cutoutDistance,
  cutoutPolygon,
  placeKeepout,
  insideBoard,
  insidePolygon,
  placeCutout,
  placeGraphic,
  figureDepths,
  padCapsule,
  padHasPin,
  padPins,
  boardStackup,
} from '@4k7/schema';
import { footprintFor, isTwoPin, packageOf, type Footprint } from '@4k7/parts';
import { applyWaivers, cardOf, componentsSorted, isGroundNet, isPowerNet, madeBy, natCmp, valueOf } from './doc.ts';
import { copperDrc, drawnDrc, edgeDrc, planeViaDrc, splitDrc } from './drc.ts';
import { keepoutDrc } from './keepout.ts';
import { fabCopperDrc, fabPlacementDrc } from './fabdrc.ts';
import { panelView } from './panel.ts';
import { padOfPin, pin1Chamfer, placeMarks, polarityOf } from './marks.ts';
import { congestion, type Board as CongestionBoard } from './congestion.ts';
import { stableJson } from './canonical.ts';
import { route, type RouteInput, type RouteProgress } from './router.ts';
import { impedanceDrc, pourGaps, resolveImpedance } from './lines.ts';

const SPACING = 0.3; // between courtyards
/** Rounds a change from a stored placement may pull in more neighbours before the whole board is settled again. */
const STEADY_ROUNDS = 30;
/** A part's parent moved less than this (mm) and did not turn: its followers move with it as they are, no more. */
const NUDGE_MM = 3;
const GRID_MM = 0.1;

interface Item {
  comp: Component;
  card: PartCard;
  fp: Footprint;
  pkg: string;
  info: PackageInfo;
  x: number;
  y: number;
  rot: number;
  fixed: boolean;
  /** The board side it is mounted on (a `layer` constraint; top unless told otherwise). */
  side: 'top' | 'bottom';
  /** Has drilled pads: it takes its place on both sides. */
  tht: boolean;
  /** Locked without a rotation: the placer still picks the rotation. */
  freeRot?: boolean;
  /** The user's or the agent's choice for this part (a soft position constraint). */
  intent?: Constraint;
  /** Who locked it or chose its place. */
  by?: 'user' | 'agent';
  /** Courtyard size at rotation 0, centred. */
  cw: number;
  ch: number;
  /** A keep-out's stand-in: the part it belongs to may stand in it. */
  exempt?: Item;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const snap = (v: number) => Math.round(v / GRID_MM) * GRID_MM;

/** A local point rotated clockwise (y down) by a multiple of 90°. */
export function rotate(x: number, y: number, rot: number): [number, number] {
  switch (((rot % 360) + 360) % 360) {
    case 90:
      return [-y, x];
    case 180:
      return [-x, -y];
    case 270:
      return [y, -x];
    default:
      return [x, y];
  }
}

/**
 * A drop via's spot on the board, from its offset to the pad's centre in the footprint's own frame
 * (add_vias drop): mirrored on the bottom side, turned with the part.
 */
export function dropSpot(part: Pick<BoardPart, 'rot' | 'side'>, pad: Pick<BoardPad, 'x' | 'y'>, [dx, dy]: [number, number]): [number, number] {
  const [x, y] = rotate(part.side === 'bottom' ? -dx : dx, dy, part.rot);
  return [r3(pad.x + x), r3(pad.y + y)];
}

/** The offset dropSpot takes for a spot on the board, as the part stands now. */
export function dropOffset(part: Pick<BoardPart, 'rot' | 'side'>, pad: Pick<BoardPad, 'x' | 'y'>, x: number, y: number): [number, number] {
  const [dx, dy] = rotate(x - pad.x, y - pad.y, -part.rot);
  return [r3(part.side === 'bottom' ? -dx : dx) || 0, r3(dy) || 0];
}

/** The net on a pad: its pin's, or for a pad several pins share, the first of them connected. */
export function padNet(comp: Pick<Component, 'pins'>, pad: { number: string; also?: string[] }): string | undefined {
  for (const n of padPins(pad)) if (comp.pins[n]) return comp.pins[n];
  return undefined;
}

/** A footprint as it lies on the bottom side, seen from the top: flipped about its vertical axis. */
function mirrored(fp: Footprint): Footprint {
  const chamfer = fp.body.chamfer ? { ...fp.body.chamfer, corners: fp.body.chamfer.corners.map((c) => cornerAt(-CORNER[c][0], CORNER[c][1])) } : undefined;
  return { ...fp, pads: fp.pads.map((p) => ({ ...p, x: -p.x || 0 })), pin1: { x: -fp.pin1.x || 0, y: fp.pin1.y }, body: { ...fp.body, ...(chamfer ? { chamfer } : {}) } };
}

/** A body corner as a direction from the body's centre (y down), and back. */
const CORNER: Record<BodyCorner, [number, number]> = { tl: [-1, -1], tr: [1, -1], br: [1, 1], bl: [-1, 1] };
const cornerAt = (x: number, y: number): BodyCorner => (y < 0 ? (x < 0 ? 'tl' : 'tr') : x < 0 ? 'bl' : 'br');

/** Whether two parts compete for the same area: on the same side, or one of them goes through the board. */
const collide = (a: Item, b: Item) => a.exempt !== b && b.exempt !== a && (a.tht || b.tht || a.side === b.side);

const swapped = (rot: number) => rot % 180 !== 0;
const extent = (it: Item) => (swapped(it.rot) ? { w: it.ch, h: it.cw } : { w: it.cw, h: it.ch });

export function placeBoard(d: Design, sch: SchematicView): BoardView {
  const settings = d.board ?? DEFAULT_BOARD;
  const rules = settings.rules;
  const layers: CopperLayer[] = settings.layers === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu'];
  const missing: string[] = [];
  const items: Item[] = [];

  const stored = settings.placement;

  /* ---- footprints ---- */
  const onBottom = new Set(Object.values(d.ledger).filter((k) => k.kind === 'layer' && k.value === 'bottom' && k.a).map((k) => k.a!));
  for (const comp of componentsSorted(d)) {
    const card = cardOf(d, comp.part);
    if (!card) continue;
    const pkg = packageOf(card, comp.params, d.packageDefaults);
    const fp = pkg ? footprintFor(pkg, card.pins.map((p) => p.number)) : null;
    if (!pkg || !fp?.ok) {
      missing.push(comp.refdes);
      continue;
    }
    const side = onBottom.has(comp.id) ? 'bottom' : 'top';
    const foot = side === 'bottom' ? mirrored(fp.footprint) : fp.footprint;
    items.push({ comp, card, fp: foot, pkg: pkg.name, info: pkg, x: 0, y: 0, rot: 0, fixed: false, side, tht: foot.pads.some((p) => !!p.drill), cw: foot.courtyard.w, ch: foot.courtyard.h });
  }

  /* ---- start from the schematic ---- */
  const centre = new Map<string, { x: number; y: number; vertical: boolean }>();
  let sheetOffset = 0;
  for (const sheet of sch.sheets) {
    const boxes = new Map<string, { x0: number; y0: number; x1: number; y1: number; vertical: boolean }>();
    for (const s of sheet.symbols) {
      const b = boxes.get(s.componentId);
      const x0 = s.bbox.x + sheetOffset;
      const vertical = s.pins.length === 2 && s.pins[0]!.x === s.pins[1]!.x;
      boxes.set(s.componentId, b ? { x0: Math.min(b.x0, x0), y0: Math.min(b.y0, s.bbox.y), x1: Math.max(b.x1, x0 + s.bbox.w), y1: Math.max(b.y1, s.bbox.y + s.bbox.h), vertical } : { x0, y0: s.bbox.y, x1: x0 + s.bbox.w, y1: s.bbox.y + s.bbox.h, vertical });
    }
    for (const [id, b] of boxes) centre.set(id, { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, vertical: b.vertical });
    sheetOffset += sheet.bbox.w + 2000;
  }
  const pts = items.map((it) => centre.get(it.comp.id)).filter((c): c is NonNullable<typeof c> => !!c);
  const area = items.reduce((s, it) => s + (it.cw + SPACING) * (it.ch + SPACING), 0);
  const sx = pts.length ? Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)) : 1;
  const sy = pts.length ? Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)) : 1;
  const byComp = new Map(items.map((it) => [it.comp.id, it]));
  const padsOf = (it: Item) => it.fp.pads.map((p) => ({ pad: p, net: padNet(it.comp, p) }));
  const padPos = (it: Item, px: number, py: number) => {
    const [x, y] = rotate(px, py, it.rot);
    return { x: it.x + x, y: it.y + y };
  };

  /* ---- connectivity ---- */
  const nets = new Map<string, { it: Item; px: number; py: number }[]>();
  for (const it of items) {
    for (const { pad, net } of padsOf(it)) {
      if (!net) continue;
      nets.set(net, [...(nets.get(net) ?? []), { it, px: pad.x, py: pad.y }]);
    }
  }
  const weight = (netId: string, n: number) => {
    const net = d.nets[netId]!;
    const w = 1 / Math.max(1, n - 1);
    return isGroundNet(net) || isPowerNet(net) ? w * 0.25 : w;
  };

  /*
   * Which part belongs with which: the agent's word first (`belongs` entries: a parent, the pin it
   * serves, or none), the placer's guess for the rest (below).
   */
  const declared = new Map<Item, { to: Item | null; pin?: string }>();
  for (const k of Object.values(d.ledger)) {
    if (k.kind !== 'belongs' || !k.a || !byComp.has(k.a)) continue;
    const to = k.b ? byComp.get(k.b) : null;
    if (to === undefined) continue; // the parent has no footprint: the guess
    declared.set(byComp.get(k.a)!, { to, ...(k.key ? { pin: k.key } : {}) });
  }

  // decoupling caps → one supply pad each (nearest in the schematic sense: first free pad)
  const springs: { it: Item; to: Item; tx: number; ty: number; px: number; py: number; w: number; pin: string }[] = [];
  const supplyPads = new Map<string, { it: Item; px: number; py: number; used: number }[]>();
  for (const it of items) {
    if (isTwoPin(it.card)) continue;
    for (const { pad, net } of padsOf(it)) {
      const pin = it.card.pins.find((p) => p.type === 'pwr_in' && padHasPin(pad, p.number));
      if (!net || !pin || isGroundNet(d.nets[net]!)) continue;
      supplyPads.set(net, [...(supplyPads.get(net) ?? []), { it, px: pad.x, py: pad.y, used: 0 }]);
    }
  }
  // a declared parent: at the pin given, else at a pin they share (a supply pin first)
  for (const [it, { to, pin }] of declared) {
    if (!to) continue;
    const own = padsOf(it).filter((p) => p.net && !isGroundNet(d.nets[p.net]!));
    const theirs = padsOf(to).filter((q) => (pin ? padHasPin(q.pad, pin) : own.some((p) => p.net === q.net)));
    const typeOf = (n: string) => to.card.pins.find((p) => p.number === n)?.type;
    const at = theirs.find((q) => typeOf(q.pad.number) === 'pwr_in') ?? theirs[0];
    const mine = at && padsOf(it).find((p) => p.net === at.net);
    if (!at || !mine) continue;
    const target = supplyPads.get(at.net!)?.find((x) => x.it === to && x.px === at.pad.x && x.py === at.pad.y);
    if (target) target.used++;
    springs.push({ it, to, tx: at.pad.x, ty: at.pad.y, px: mine.pad.x, py: mine.pad.y, w: 3, pin: at.pad.number });
  }
  for (const it of items) {
    if (!isTwoPin(it.card) || it.card.category !== 'capacitor' || declared.has(it)) continue;
    const ns = padsOf(it).map((p) => p.net);
    const rail = ns.find((n) => n && !isGroundNet(d.nets[n]!) && supplyPads.has(n));
    if (!rail || !ns.some((n) => n && isGroundNet(d.nets[n]!))) continue;
    const target = [...supplyPads.get(rail)!].sort((a, b) => a.used - b.used)[0]!;
    target.used++;
    const own = padsOf(it).find((p) => p.net === rail)!.pad;
    const pin = target.it.fp.pads.find((q) => q.x === target.px && q.y === target.py)!.number;
    springs.push({ it, to: target.it, tx: target.px, ty: target.py, px: own.x, py: own.y, w: 3, pin });
  }
  const near = Object.values(d.ledger)
    .filter((k) => k.kind === 'near' && k.a && k.b && byComp.has(k.a) && byComp.has(k.b))
    .map((k) => ({ a: byComp.get(k.a!)!, b: byComp.get(k.b!)!, max: k.maxMm ?? 3 }));

  /*
   * Each part's parent: the part it belongs with, which it follows when that moves (and which
   * a user's choice for it is relative to). A decoupling cap: its IC; otherwise the biggest part
   * it shares a signal net with (a supply net if there is none), if that is bigger than itself.
   */
  const parent = new Map<Item, Item>();
  for (const [it, { to }] of declared) if (to) parent.set(it, to);
  /** Whether `from` belongs with `it`, directly or through other parts (a guess must not close a circle). */
  const leadsTo = (from: Item, it: Item) => {
    for (let at: Item | undefined = from, n = 0; at && n <= items.length; at = parent.get(at), n++) if (at === it) return true;
    return false;
  };
  for (const s of springs) if (!parent.has(s.it) && !leadsTo(s.to, s.it)) parent.set(s.it, s.to);
  for (const it of items) {
    if (parent.has(it) || declared.has(it)) continue;
    for (const supply of [false, true]) {
      let best: Item | undefined;
      for (const { net } of padsOf(it)) {
        if (!net || isGroundNet(d.nets[net]!) || isPowerNet(d.nets[net]!) !== supply) continue;
        for (const m of nets.get(net) ?? []) {
          const n = m.it.fp.pads.length;
          if (m.it === it || n <= it.fp.pads.length || leadsTo(m.it, it)) continue;
          if (!best || n > best.fp.pads.length || (n === best.fp.pads.length && natCmp(m.it.comp.refdes, best.comp.refdes) < 0)) best = m.it;
        }
      }
      if (best) {
        parent.set(it, best);
        break;
      }
    }
  }

  /* ---- the user's decisions: locked parts (hard) and choices (soft, maybe relative) ---- */
  const positions = Object.values(d.ledger).filter((k) => k.kind === 'position' && k.a && byComp.has(k.a));
  for (const k of positions) {
    const it = byComp.get(k.a!)!;
    it.by = madeBy(k);
    if (k.strength === 'hard') {
      it.fixed = true;
      it.freeRot = k.rot === undefined;
    } else it.intent = k;
  }
  // parents before the parts that belong with them (a choice's anchor is in place before the part
  // itself), bigger parts first
  const depth = (it: Item) => {
    let n = 0;
    for (let at = parent.get(it); at && n < items.length; at = parent.get(at)) n++;
    return n;
  };
  const bySize = [...items].sort((a, b) => depth(a) - depth(b) || b.fp.pads.length - a.fp.pads.length || natCmp(a.comp.refdes, b.comp.refdes));
  const anchorOf = (it: Item) => (it.intent?.rel ? byComp.get(it.intent.rel) : undefined);
  // a proposed board fitted round the arrangement moves it as a whole: the choices' place on it
  let offset = { x: 0, y: 0 };
  const applyLocks = () => {
    for (const k of positions) {
      if (k.strength !== 'hard') continue;
      const it = byComp.get(k.a!)!;
      it.x = k.xMm ?? it.x;
      it.y = k.yMm ?? it.y;
      if (k.rot !== undefined) it.rot = k.rot;
    }
  };
  /** Put each part with a choice where the user wants it (relative ones next to their anchor). */
  const applyIntents = (only?: Set<Item>) => {
    for (const it of bySize) {
      const k = it.intent;
      if (!k || (only && (!only.has(it) || k.rel))) continue; // (one kept relative to a part that is pushed away goes with it)
      const a = anchorOf(it);
      if (k.rel && !a) continue; // the anchor is gone: the part stays where it is
      // (`only`: back to the spot, not the turn, which the two-pin parts' flipping may have changed)
      if (a) {
        const [ox, oy] = rotate(k.xMm ?? 0, k.yMm ?? 0, a.rot);
        it.x = a.x + ox;
        it.y = a.y + oy;
        if (k.rot !== undefined && !only) it.rot = (((a.rot + k.rot) % 360) + 360) % 360;
      } else {
        if (k.xMm !== undefined) it.x = k.xMm + offset.x;
        if (k.yMm !== undefined) it.y = k.yMm + offset.y;
        if (k.rot !== undefined && !only) it.rot = k.rot;
      }
    }
  };

  /* ---- the outline: the user's size, else the stored proposal, else a new proposal ---- */
  const margin = 1.5 + rules.edgeClearance;
  // parts (with spacing) cover at most this much of a proposed board: room to route
  const DENSITY = layers.length === 4 ? 0.55 : 0.45;
  const userSize = !!(settings.width && settings.height);
  // a free-form outline: parts stay inside it (with the margin), not just inside its box
  const shape = settings.shape ?? null;
  let outline = userSize ? { w: settings.width!, h: settings.height! } : (stored?.outline ?? { w: 0, h: 0 });
  // (a proposal without the user's size relaxes freely; its outline is fitted afterwards)
  let containing = userSize || !!stored;
  /*
   * How close to the edge a part may come. The placer's own parts keep their courtyard the
   * margin inside (room to route round them); a part the user (or the agent) put somewhere may
   * go up to the edge: its copper keeps the edge clearance, its body stays on the board (a
   * connector's mouth flush with the edge). Half a grid step to spare, for the snapping.
   */
  const keepsIn = (it: Item): { x: number; y: number; need: number }[] => {
    if (!it.intent) {
      const e = extent(it);
      return ([[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [0, 0]] as const).map(([fx, fy]) => ({ x: (fx * e.w) / 2, y: (fy * e.h) / 2, need: margin }));
    }
    const slack = GRID_MM / 2;
    const box = (cx: number, cy: number, w: number, h: number, need: number) =>
      ([[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]] as const).map(([fx, fy]) => {
        const [x, y] = rotate(cx + (fx * w) / 2, cy + (fy * h) / 2, it.rot);
        return { x, y, need: need + slack };
      });
    return [...box(0, 0, it.fp.body.w, it.fp.body.h, 0), ...it.fp.pads.flatMap((p) => box(p.x, p.y, p.w, p.h, rules.edgeClearance))];
  };
  /** The room a part needs from its centre to each side of the outline (see keepsIn). */
  const reach = (it: Item) => {
    const r = { l: 0, t: 0, r: 0, b: 0 };
    for (const p of keepsIn(it)) {
      r.l = Math.max(r.l, p.need - p.x);
      r.t = Math.max(r.t, p.need - p.y);
      r.r = Math.max(r.r, p.need + p.x);
      r.b = Math.max(r.b, p.need + p.y);
    }
    return r;
  };
  const contain = (it: Item) => {
    if (it.fixed || !containing) return;
    const r = reach(it);
    it.x = Math.min(Math.max(it.x, r.l), outline.w - r.r);
    it.y = Math.min(Math.max(it.y, r.t), outline.h - r.b);
    if (shape) pushInside(it);
  };
  /** Into a free-form outline: moved inwards (up the distance field) until the part keeps its distance from the edge (keepsIn). */
  const pushInside = (it: Item) => {
    for (let k = 0; k < 16; k++) {
      let worst = { d: Infinity, x: 0, y: 0 };
      for (const p of keepsIn(it)) {
        const x = it.x + p.x;
        const y = it.y + p.y;
        const d = insidePolygon(shape!, x, y) - p.need;
        if (d < worst.d) worst = { d, x, y };
      }
      if (worst.d >= -1e-6) return;
      // the way inwards at the worst point (the distance field's gradient)
      const g = 0.05;
      let gx = insidePolygon(shape!, worst.x + g, worst.y) - insidePolygon(shape!, worst.x - g, worst.y);
      let gy = insidePolygon(shape!, worst.x, worst.y + g) - insidePolygon(shape!, worst.x, worst.y - g);
      const len = Math.hypot(gx, gy);
      if (len < 1e-9) {
        gx = outline.w / 2 - it.x;
        gy = outline.h / 2 - it.y;
      }
      const l2 = Math.hypot(gx, gy) || 1;
      const step = 0.1 - worst.d;
      it.x += (gx / l2) * step;
      it.y += (gy / l2) * step;
    }
  };

  /* ---- relax: pads towards their nets, caps to their supply pins, near constraints ---- */
  const relax = (movable: Item[], iterations: number) => {
    const moving = new Set(movable);
    for (let iter = 0; iter < iterations; iter++) {
      const step = 0.35 * (1 - iter / iterations) + 0.05;
      const force = new Map<Item, { fx: number; fy: number }>(movable.map((it) => [it, { fx: 0, fy: 0 }]));
      const add = (it: Item, fx: number, fy: number) => {
        const f = force.get(it);
        if (f) {
          f.fx += fx;
          f.fy += fy;
        }
      };
      for (const [netId, members] of nets) {
        if (members.length < 2 || !members.some((m) => moving.has(m.it))) continue;
        const w = weight(netId, members.length);
        const ps = members.map((m) => padPos(m.it, m.px, m.py));
        const cx = ps.reduce((s, p) => s + p.x, 0) / ps.length;
        const cy = ps.reduce((s, p) => s + p.y, 0) / ps.length;
        members.forEach((m, i) => add(m.it, (cx - ps[i]!.x) * w, (cy - ps[i]!.y) * w));
      }
      for (const s of springs) {
        if (!moving.has(s.it)) continue;
        const a = padPos(s.it, s.px, s.py);
        const b = capSpot(s);
        add(s.it, (b.x - a.x) * s.w, (b.y - a.y) * s.w);
      }
      for (const n of near) {
        const dx = n.b.x - n.a.x;
        const dy = n.b.y - n.a.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= n.max) continue;
        const k = (dist - n.max) / dist;
        add(n.a, dx * k * 2, dy * k * 2);
        add(n.b, -dx * k * 2, -dy * k * 2);
      }
      for (const it of movable) {
        const f = force.get(it)!;
        const len = Math.hypot(f.fx, f.fy);
        const lim = 2;
        const k = len * step > lim ? lim / len : step;
        it.x += f.fx * k;
        it.y += f.fy * k;
      }
      applyIntents();
      separate(items, 3);
      for (const it of items) contain(it);
    }
  };
  /** Where a decoupling cap's supply pad belongs: next to the IC's pin, outside the IC's body. */
  function capSpot(s: (typeof springs)[number]) {
    const pad = padPos(s.to, s.tx, s.ty);
    const e = extent(s.to);
    const own = extent(s.it);
    let dx = pad.x - s.to.x;
    let dy = pad.y - s.to.y;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) dx = 1;
    const f = Math.min(Math.abs(dx) > 1e-9 ? e.w / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? e.h / 2 / Math.abs(dy) : Infinity);
    const len = Math.hypot(dx, dy);
    const out = Math.max(own.w, own.h) / 2 + SPACING;
    return f >= 1 ? pad : { x: s.to.x + dx * f + (dx / len) * out, y: s.to.y + dy * f + (dy / len) * out };
  }

  /*
   * An IC's small parts right at their pin: just outside the IC's courtyard, on the edge nearest
   * the pin, turned so the connected pad is closest to it. Overlaps are left to the separation
   * (which slides them along the edge).
   */
  // decoupling caps first, then the IC's other small parts (bootstrap, soft-start, feedback …)
  // at the pin they connect to
  const satellites = [
    ...springs,
    ...items.flatMap((it) => {
      const ic = parent.get(it);
      if (!ic || !isTwoPin(it.card) || ic.fp.pads.length <= 3 || springs.some((s) => s.it === it)) return [];
      for (const { pad, net } of padsOf(it)) {
        if (!net || isGroundNet(d.nets[net]!)) continue;
        const pin = padsOf(ic).find((p) => p.net === net);
        if (pin) return [{ it, to: ic, tx: pin.pad.x, ty: pin.pad.y, px: pad.x, py: pad.y, w: 1, pin: pin.pad.number }];
      }
      return [];
    }),
  ];
  const hugCaps = (only?: Set<Item>) => {
    for (const s of satellites) {
      const it = s.it;
      if (it.fixed || it.intent || (only && !only.has(it))) continue;
      const ic = s.to;
      const pin = padPos(ic, s.tx, s.ty);
      const e = extent(ic);
      const edges = [
        { d: pin.x - (ic.x - e.w / 2), x: ic.x - e.w / 2, y: pin.y, nx: -1, ny: 0 },
        { d: ic.x + e.w / 2 - pin.x, x: ic.x + e.w / 2, y: pin.y, nx: 1, ny: 0 },
        { d: pin.y - (ic.y - e.h / 2), x: pin.x, y: ic.y - e.h / 2, nx: 0, ny: -1 },
        { d: ic.y + e.h / 2 - pin.y, x: pin.x, y: ic.y + e.h / 2, nx: 0, ny: 1 },
      ];
      const edge = edges.reduce((a, b) => (b.d < a.d ? b : a));
      // a pin under the body (a BGA ball): a ring of caps would wall in the tracks escaping from
      // between the balls. Only a part alone on its ball's net (a VCAP cap) goes to the edge, with
      // a channel for those tracks; the rest keep the place the relaxation found
      const under = Math.abs(s.tx) < ic.fp.body.w / 2 - 0.1 && Math.abs(s.ty) < ic.fp.body.h / 2 - 0.1;
      const net = padsOf(it).find((p) => p.pad.x === s.px && p.pad.y === s.py)?.net;
      if (under && (nets.get(net ?? '')?.length ?? 0) > 2) continue;
      const gap = SPACING + (under ? 1.2 : 0);
      let best: { x: number; y: number; rot: number; dist: number } | null = null;
      for (const rot of [0, 90, 180, 270]) {
        it.rot = rot;
        const own = extent(it);
        const cx = edge.x + edge.nx * (own.w / 2 + gap);
        const cy = edge.y + edge.ny * (own.h / 2 + gap);
        const [px, py] = rotate(s.px, s.py, rot);
        const dist = Math.hypot(cx + px - pin.x, cy + py - pin.y);
        if (!best || dist < best.dist - 1e-6) best = { x: cx, y: cy, rot, dist };
      }
      it.x = best!.x;
      it.y = best!.y;
      it.rot = best!.rot;
    }
  };

  /* ---- rotations of two-pin parts: shortest connections ---- */
  const netCentre = (netId: string, except: Item) => {
    const ms = (nets.get(netId) ?? []).filter((m) => m.it !== except);
    if (!ms.length) return null;
    const ps = ms.map((m) => padPos(m.it, m.px, m.py));
    return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
  };
  const fixedItems = items.filter((it) => it.fixed);
  const planeNets = new Set(settingsPlanes(d, layers.length as 2 | 4).filter((pl) => !pl.area).map((pl) => pl.netId));
  // nets with a dedicated inner plane: their pads drop onto it right where they are
  const innerPlaneNets = new Set(settingsPlanes(d, layers.length as 2 | 4).filter((pl) => pl.layer !== 'F.Cu' && pl.layer !== 'B.Cu' && !pl.area).map((pl) => pl.netId));
  const clashes = (it: Item) => {
    const e = extent(it);
    return fixedItems.some((o) => {
      if (o === it || !collide(o, it)) return false;
      const eo = extent(o);
      return Math.abs(o.x - it.x) < (e.w + eo.w) / 2 - 1e-6 && Math.abs(o.y - it.y) < (e.h + eo.h) / 2 - 1e-6;
    });
  };
  // locked parts without a locked rotation (only rotations that fit between the other locked
  // parts: they cannot move out of the way) serve their signals: their pads on plane nets drop
  // onto the plane right there, whichever way they face
  const orient = (list: Item[]) => {
    for (const it of list) {
      if (!isTwoPin(it.card)) continue;
      let best = it.rot;
      let bestLen = Infinity;
      for (const rot of [0, 90, 180, 270]) {
        it.rot = rot;
        if (it.fixed && clashes(it)) continue;
        let len = 0;
        for (const { pad, net } of padsOf(it)) {
          if (!net || (it.fixed && planeNets.has(net))) continue;
          const c = netCentre(net, it);
          if (!c) continue;
          const p = padPos(it, pad.x, pad.y);
          len += Math.hypot(c.x - p.x, c.y - p.y);
        }
        if (len < bestLen - 1e-6) {
          bestLen = len;
          best = rot;
        }
      }
      it.rot = best;
    }
  };

  /*
   * Two-pin parts face the way that shortens their connections: a resistor's or a diode's chosen
   * rotation is taken as its direction (lying or standing), so it may be turned round by 180°
   * (the same footprint area: nothing else moves). Pads on a net with a dedicated inner plane do
   * not count (they drop onto it where they are). Locked parts keep their rotation; an IC's small
   * parts keep the one that puts them at their pin. From a stored placement only the parts that
   * moved (`only`): the others keep the turn they were given (refine_placement weighs crossings,
   * which this does not).
   */
  const flipTwoPin = (only?: Set<Item>) => {
    const hugged = new Set(satellites.map((x) => x.it));
    const length = (it: Item) => {
      let len = 0;
      for (const { pad, net } of padsOf(it)) {
        if (!net || innerPlaneNets.has(net)) continue;
        const c = netCentre(net, it);
        if (!c) continue;
        const p = padPos(it, pad.x, pad.y);
        len += Math.hypot(c.x - p.x, c.y - p.y);
      }
      return len;
    };
    // twice: two connected parts (a resistor and its LED) each see the other's final side
    for (let pass = 0; pass < 2; pass++) {
      for (const it of items) {
        if (it.fixed || hugged.has(it) || !isTwoPin(it.card) || (only && !only.has(it))) continue;
        const was = it.rot;
        const before = length(it);
        it.rot = (was + 180) % 360;
        if (length(it) >= before - 1e-6) it.rot = was;
      }
    }
  };

  // from a stored placement, a part that has not moved is on the grid as it was left (snapping it again only nudges it)
  const rests = (it: Item) => {
    const was = stored?.parts[it.comp.id];
    return !!was && was.x === it.x && was.y === it.y;
  };
  /** Final clean-up: no overlaps, inside the outline, on the grid; a proposed outline grows if it must. */
  const settle = (grow = true) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      for (let round = 0; round < 30; round++) {
        // stuck against the outline: spread in two dimensions now and then
        if (round % 10 === 9) {
          separate(items, 10);
          for (const it of items) contain(it);
        }
        separate(items, 40, true, !!stored);
        for (const it of items) contain(it);
        for (const it of items) if (!it.fixed && !rests(it)) snapItem(it);
        // settled: the spacing holds to within a grid step (what the strict separation leaves)
        if (!overlapping(items, SPACING - GRID_MM)) return;
      }
      // the parts still in the way to the nearest spot where they fit (a pair the separation
      // cannot pull apart: a small part wedged against a main part someone placed)
      if (!grow) return; // (the caller pulls in more neighbours to push instead)
      legalize();
      if (userSize) return; // the user's size: what still overlaps shows as DRC errors
      if (!overlapping(items, SPACING - GRID_MM)) return;
      // a proposed outline grows only where that is not enough (growing moves nothing by itself)
      outline = { w: Math.ceil(outline.w * 1.1), h: Math.ceil(outline.h * 1.1) };
    }
  };
  /** Room for a part at (x, y): inside the outline as far as it must be (keepsIn), clear of every other part. */
  const within = (it: Item, x: number, y: number) => {
    const r = reach(it);
    if (x < r.l - 1e-6 || y < r.t - 1e-6 || x > outline.w - r.r + 1e-6 || y > outline.h - r.b + 1e-6) return false;
    return !shape || !keepsIn(it).some((p) => insidePolygon(shape, x + p.x, y + p.y) < p.need - 1e-6);
  };
  const fits = (it: Item, x: number, y: number) => {
    if (!within(it, x, y)) return false;
    const [ox, oy] = [it.x, it.y];
    it.x = x;
    it.y = y;
    const clash = items.some((o) => o !== it && closer(it, o, SPACING));
    it.x = ox;
    it.y = oy;
    return !clash;
  };
  /*
   * A fixed outline (the user's size, a free-form shape) where parts still overlap after
   * settling: each overlapping part moves to the nearest spot where it fits (rings round where it
   * is), smaller parts first; the outline cannot grow instead.
   */
  const legalize = () => {
    const clashing = () => items.filter((it) => !it.fixed && items.some((o) => o !== it && closer(it, o, SPACING - GRID_MM)));
    const todo = clashing().sort((a, b) => a.cw * a.ch - b.cw * b.ch || natCmp(a.comp.refdes, b.comp.refdes));
    const maxR = Math.hypot(outline.w, outline.h);
    for (const it of todo) {
      if (!items.some((o) => o !== it && closer(it, o, SPACING - GRID_MM))) continue; // freed by an earlier move
      search: for (let r = 0.5; r <= maxR; r += 0.5) {
        const n = Math.max(8, Math.round((2 * Math.PI * r) / 0.5));
        for (let k = 0; k < n; k++) {
          const a = (2 * Math.PI * k) / n;
          const x = snap(it.x + r * Math.cos(a));
          const y = snap(it.y + r * Math.sin(a));
          if (fits(it, x, y)) {
            it.x = x;
            it.y = y;
            snapItem(it);
            break search;
          }
        }
      }
    }
  };

  // from a stored placement: the parts that moved (only they are flipped, see flipTwoPin)
  let flipOnly: Set<Item> | undefined;
  /*
   * Drawn copper (BoardSettings.drawn) lies round the parts as they stand: from a stored placement
   * only what is moved on purpose moves (the part placed, and rigidly the small parts that follow
   * it), and new parts find a place; nothing else is nudged, flipped, aligned or pushed apart (an
   * overlap shows as a DRC error instead), so the copper stays where it was drawn.
   */
  const frozen = !!settings.drawn && !!stored;
  let keptStill: Item[] = [];
  if (!stored) {
    /* ---- proposal: start from the schematic, scaled into the outline ---- */
    const targetW = Math.sqrt(area * 2.8 * 1.4);
    const targetH = targetW / 1.4;
    const clampScale = (v: number) => Math.min(0.05, Math.max(0.0005, v));
    const scaleX = clampScale(targetW / Math.max(sx, 1));
    const scaleY = clampScale(targetH / Math.max(sy, 1));
    items.forEach((it, i) => {
      const c = centre.get(it.comp.id);
      it.x = c ? c.x * scaleX : i * 5;
      it.y = c ? c.y * scaleY : 0;
      it.rot = c?.vertical && isTwoPin(it.card) ? 90 : 0;
    });
    /*
     * With the user's decisions, start from the board placed without them: their coordinates
     * are board coordinates, so everything else must start in that frame too (a drag then
     * moves one part and the rest adapts around it, instead of jumping to a different frame).
     */
    if (positions.length) {
      const free: Design = { ...d, ledger: Object.fromEntries(Object.entries(d.ledger).filter(([, k]) => k.kind !== 'position')) };
      const base = placeBoard(free, sch);
      for (const it of items) {
        const p = base.parts.find((x) => x.componentId === it.comp.id);
        if (p) {
          it.x = p.x;
          it.y = p.y;
          it.rot = p.rot;
        }
      }
    } else {
      // centred in the outline
      const bb0 = bounds(items);
      const dx = outline.w / 2 - (bb0.x0 + bb0.x1) / 2;
      const dy = outline.h / 2 - (bb0.y0 + bb0.y1) / 2;
      for (const it of items) {
        it.x += dx;
        it.y += dy;
      }
    }
    applyLocks();
    applyIntents();
    relax(
      items.filter((it) => !it.fixed && !it.intent),
      160,
    );
    orient(items.filter((it) => (it.fixed && it.freeRot) || (!it.fixed && !it.intent)));
    const free = items.filter((it) => !it.fixed && !it.intent);
    if (userSize) {
      if (!positions.length) {
        // the relaxed cluster, centred in the user's outline
        const bb1 = bounds(items);
        const dx = outline.w / 2 - (bb1.x0 + bb1.x1) / 2;
        const dy = outline.h / 2 - (bb1.y0 + bb1.y1) / 2;
        for (const it of free) {
          it.x += dx;
          it.y += dy;
        }
      }
    } else if (items.length) {
      // the proposed size: the relaxed cluster, spread until the parts cover at most DENSITY. Not
      // with parts placed by someone: they stay, so spreading would only push the small parts
      // away from them (the frame they start in, the board placed without them, has that
      // density already)
      const partsArea = items.reduce((sum, it) => sum + (it.cw + SPACING) * (it.ch + SPACING), 0);
      const bb1 = bounds(items);
      const f = positions.length ? 1 : Math.sqrt(partsArea / DENSITY / Math.max((bb1.x1 - bb1.x0) * (bb1.y1 - bb1.y0), 1e-6));
      if (f > 1) {
        const cx = (bb1.x0 + bb1.x1) / 2;
        const cy = (bb1.y0 + bb1.y1) / 2;
        for (const it of free) {
          it.x = cx + (it.x - cx) * f;
          it.y = cy + (it.y - cy) * f;
        }
        applyIntents();
        separate(items, 10);
      }
      // onto the board: locked parts keep their coordinates, the rest shifts clear of the edge
      const bb2 = bounds(items);
      const shift = positions.length ? { x: Math.max(0, margin - bb2.x0), y: Math.max(0, margin - bb2.y0) } : { x: margin - bb2.x0, y: margin - bb2.y0 };
      for (const it of items) {
        if (it.fixed || (positions.length && it.intent && !it.intent.rel)) continue;
        it.x += shift.x;
        it.y += shift.y;
      }
      const bb3 = bounds(items);
      outline = { w: settings.width ?? Math.ceil(bb3.x1 + margin), h: settings.height ?? Math.ceil(bb3.y1 + margin) };
    }
    hugCaps();
    applyIntents();
    if (!userSize && items.length) {
      /*
       * The proposed board fits round the whole arrangement, the small parts at an IC's far side
       * included: what reaches past its top or left edge moves everything over (the choices too;
       * with locked parts, whose coordinates stay, the board only grows), and it grows to the
       * right and down as far as the parts reach.
       */
      const bb = bounds(items);
      const sx = Math.max(0, margin - bb.x0);
      const sy = Math.max(0, margin - bb.y0);
      if ((sx > 0 || sy > 0) && !fixedItems.length) {
        offset = { x: sx, y: sy };
        for (const it of items) {
          it.x += sx;
          it.y += sy;
        }
      }
      const bb1 = bounds(items);
      outline = { w: Math.max(outline.w, Math.ceil(bb1.x1 + margin)), h: Math.max(outline.h, Math.ceil(bb1.y1 + margin)) };
    }
    containing = true;
  } else {
    /* ---- from the stored placement: only what changed moves ---- */
    const before = new Map<Item, { x: number; y: number; rot: number }>();
    for (const it of items) {
      const p = stored.parts[it.comp.id];
      if (!p) continue;
      it.x = p.x;
      it.y = p.y;
      it.rot = p.rot;
      before.set(it, { ...p });
    }
    applyLocks();
    applyIntents();
    // parts placed automatically follow their parent when it moved or turned
    const followers: Item[] = [];
    // … those whose parent went further than a nudge, or turned, gather round it again (below)
    const gather = new Set<Item>();
    for (const it of bySize) {
      const pa = parent.get(it);
      const was = before.get(it);
      const paWas = pa && before.get(pa);
      if (!pa || !was || !paWas || it.fixed || it.intent) continue;
      const moved = pa.x !== paWas.x || pa.y !== paWas.y || pa.rot !== paWas.rot || followers.includes(pa);
      if (!moved) continue;
      const dr = (((pa.rot - paWas.rot) % 360) + 360) % 360;
      const [ox, oy] = rotate(was.x - paWas.x, was.y - paWas.y, dr);
      it.x = pa.x + ox;
      it.y = pa.y + oy;
      it.rot = (it.rot + dr) % 360;
      followers.push(it);
      if (dr || Math.hypot(pa.x - paWas.x, pa.y - paWas.y) >= NUDGE_MM || gather.has(pa)) gather.add(it);
    }
    /*
     * … and then settle in close around it again: parts pushed away earlier (something was in
     * the way) would otherwise keep that distance for good. A short relaxation towards their
     * connections, the rest staying put, and the IC's small parts back at their pins. After a
     * nudge of the parent they keep their distance (the relaxation moved them by whole
     * millimetres for it).
     */
    if (gather.size && !frozen) {
      const still = items.filter((it) => !gather.has(it) && !it.fixed);
      for (const it of still) it.fixed = true;
      relax([...gather], 60);
      hugCaps(gather);
      for (const it of still) it.fixed = false;
    }
    // new parts: next to what they connect to, then relaxed among the others (which stay put)
    const added = items.filter((it) => !before.has(it) && !it.fixed && !it.intent);
    if (added.length) {
      for (const it of added) {
        const ps: { x: number; y: number }[] = [];
        for (const { net } of padsOf(it)) for (const m of nets.get(net ?? '') ?? []) if (before.has(m.it)) ps.push(padPos(m.it, m.px, m.py));
        const c = ps.length ? { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length } : { x: outline.w / 2, y: outline.h / 2 };
        it.x = c.x;
        it.y = c.y;
      }
      const still = items.filter((it) => !added.includes(it) && !it.fixed);
      for (const it of still) it.fixed = true;
      relax(added, 80);
      orient(added);
      hugCaps(new Set(added));
      for (const it of still) it.fixed = false;
    }
    orient(items.filter((it) => it.fixed && it.freeRot && !before.has(it)));
    flipOnly = new Set(
      items.filter((it) => {
        const was = before.get(it);
        return !was || (!frozen && (was.x !== it.x || was.y !== it.y || was.rot !== it.rot));
      }),
    );
    if (frozen) {
      keptStill = items.filter((it) => before.has(it) && !it.fixed);
      for (const it of keptStill) it.fixed = true;
    }
  }
  // the two-pin parts that share a small net with a part that moved may want to face it the other way round
  if (flipOnly) {
    for (const it of [...flipOnly]) {
      for (const { net } of padsOf(it)) {
        if (!net || (nets.get(net)?.length ?? 0) > 4) continue;
        for (const m of nets.get(net)!) if (isTwoPin(m.it.card)) flipOnly.add(m.it);
      }
    }
  }
  flipTwoPin(flipOnly);
  /*
   * From a stored placement the settling and the alignment move only the parts the change touched
   * (moved, followers, new, off the board) and what they push into: a part that overlaps one of
   * them joins it, round by round, and anything else stays exactly where it was.
   */
  const active = new Set<Item>(items);
  let held: Item[] = [];
  const hold = () => {
    held = items.filter((it) => !it.fixed && !active.has(it));
    for (const it of held) it.fixed = true;
  };
  const release = () => {
    for (const it of held) it.fixed = false;
    held = [];
  };
  /** A part that moved still overlaps another (not a pair of locked ones). */
  const unresolved = () => items.some((a) => active.has(a) && items.some((o) => o !== a && !(a.fixed && o.fixed) && closer(a, o, SPACING - GRID_MM)));
  if (stored && !frozen && flipOnly) {
    active.clear();
    for (const it of flipOnly) active.add(it);
    // … and what already is off the board or in someone's way (a part turned over onto the side of another)
    for (const it of items) if (!it.fixed && (!within(it, it.x, it.y) || items.some((o) => o !== it && closer(it, o, SPACING - GRID_MM)))) active.add(it);
    const moved = new Set(active);
    /** The held parts that the given ones overlap join the active ones (to give way); whether any did. */
    const pullIn = (from: Iterable<Item>) => {
      const size = active.size;
      for (const a of [...from]) for (const o of items) if (!active.has(o) && !o.fixed && closer(a, o, SPACING - GRID_MM)) active.add(o);
      return active.size > size;
    };
    pullIn(active);
    for (let round = 0; round < STEADY_ROUNDS; round++) {
      // (a part the user placed is where they put it each round: a held part it meets joins in and gives way)
      applyIntents(moved);
      hold();
      settle(false);
      release();
      if (!unresolved() || !pullIn(active)) break;
    }
    if (unresolved()) {
      // no room that way: what is still in the way goes to the nearest free spot, and only if that fails the board is settled as a whole (it may grow)
      hold();
      legalize();
      release();
      if (unresolved() && !userSize) {
        for (const it of items) active.add(it);
        settle();
      }
    }
  } else if (!frozen) settle();
  // (drawn copper: a new part that lands on another goes to the nearest free spot; the others stay, fixed for now)
  else if (items.some((it) => !it.fixed)) legalize();
  hold();
  alignSimilar(items, contain);
  release();

  // locked parts outside a proposed outline widen it
  let w = outline.w;
  let h = outline.h;
  const locked = items.filter((it) => it.fixed && !keptStill.includes(it));
  if (!userSize && locked.length) {
    const b = bounds(locked);
    w = Math.max(w, Math.ceil((b.x1 + margin) * 2) / 2);
    h = Math.max(h, Math.ceil((b.y1 + margin) * 2) / 2);
  }
  if (!items.length) {
    w = settings.width ?? 20;
    h = settings.height ?? 20;
  }
  for (const it of items) {
    it.x = r3(it.x);
    it.y = r3(it.y);
  }
  const movable = items.filter((it) => !it.fixed);

  /* ---- mounting holes: fixed keep-outs; corner holes follow the outline ---- */
  const holes = settings.holes ?? [];
  const holeAt = (hole: MountingHole) => {
    const inset = hole.inset ?? hole.d + 0.5;
    if (!hole.corner) return { x: hole.x ?? 0, y: hole.y ?? 0 };
    return { x: hole.corner.endsWith('left') ? inset : w - inset, y: hole.corner.startsWith('top') ? inset : h - inset };
  };
  // parts keep clear of the screw head / washer: a square of 2 × diameter
  const keep = (hole: MountingHole) => 2 * hole.d;
  // cutouts (their bounding box, plus the edge clearance) and rounded corners are keep-outs too
  const cutouts = settings.cutouts ?? [];
  const cornerR = settings.cornerRadius ?? 0;
  const blocker = (id: string, x: number, y: number, cw: number, ch: number) => ({ comp: { refdes: `~${id}` }, x, y, rot: 0, fixed: true, side: 'top', tht: true, cw, ch }) as unknown as Item;
  // keep-outs that hold parts off: their box, on the sides their layers name (one attached to a part where that part stands now, the part itself exempt)
  const partKeepouts = (settings.keepouts ?? []).filter((k) => k.forbid.includes('parts'));
  const keepoutBlockers = () =>
    partKeepouts.flatMap((k) => {
      const host = k.part ? items.find((it) => it.comp.id === k.part) : undefined;
      if (k.part && !host) return [];
      const bk = placeKeepout(k, layers, host && { x: host.x, y: host.y, rot: host.rot, side: host.side, refdes: host.comp.refdes });
      const top = bk.layers.includes('F.Cu');
      const bottom = bk.layers.includes('B.Cu');
      if (!top && !bottom) return [];
      const [x0, y0, x1, y1] = bk.bounds;
      const it = blocker(k.id, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0);
      it.tht = top && bottom;
      it.side = bottom && !top ? 'bottom' : 'top';
      if (host) it.exempt = host;
      return [it];
    });
  const keepOuts = () => [
    ...keepoutBlockers(),
    ...holes.map((hole) => {
      const at = holeAt(hole);
      return blocker(hole.id, at.x, at.y, keep(hole), keep(hole));
    }),
    ...cutouts.map((c) => {
      const [x0, y0, x1, y1] = cutoutBounds(placeCutout(c, w, h));
      const e = rules.edgeClearance;
      return blocker(c.id, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0 + 2 * e, y1 - y0 + 2 * e);
    }),
    // a rounded corner takes a square of its radius out of the usable area
    ...(cornerR > margin && !shape ? [[0, 0], [w, 0], [0, h], [w, h]].map(([cx, cy], i) => blocker(`corner${i}`, cx === 0 ? cornerR / 2 : cx! - cornerR / 2, cy === 0 ? cornerR / 2 : cy! - cornerR / 2, cornerR, cornerR)) : []),
  ];
  if ((holes.length || cutouts.length || partKeepouts.length || cornerR > margin) && items.length && !frozen) {
    for (let round = 0; round < 20; round++) {
      const blockers = keepOuts();
      const all = [...items, ...blockers];
      if (!overlapping(all)) break;
      separate(all, 40, true);
      for (const it of movable) snapItem(it);
      if (userSize) {
        const inside = (it: Item) => {
          const r = reach(it);
          it.x = Math.min(Math.max(it.x, r.l), w - r.r);
          it.y = Math.min(Math.max(it.y, r.t), h - r.b);
        };
        for (const it of movable) inside(it);
      } else {
        // an auto-sized board grows (and shifts) so the parts clear the holes
        const b2 = bounds(items);
        const sx = b2.x0 < margin ? snap(margin - b2.x0) : 0;
        const sy = b2.y0 < margin ? snap(margin - b2.y0) : 0;
        for (const it of movable) {
          it.x = r3(it.x + sx);
          it.y = r3(it.y + sy);
        }
        const b3 = bounds(items);
        w = Math.ceil(Math.max(w + sx, b3.x1 + margin) * 2) / 2;
        h = Math.ceil(Math.max(h + sy, b3.y1 + margin) * 2) / 2;
        if (round >= 1) {
          // still squeezed: give the corners room (grow, parts stay centred)
          w += 1;
          h += 1;
          for (const it of movable) {
            it.x = r3(it.x + 0.5);
            it.y = r3(it.y + 0.5);
          }
        }
      }
    }
    // a fixed outline that the pushing could not clear: each part still in the way moves to the
    // nearest free spot, the keep-outs standing in as fixed parts
    if (userSize) {
      const blockers = keepOuts();
      if (overlapping([...items, ...blockers])) {
        items.push(...blockers);
        legalize();
        items.splice(items.length - blockers.length, blockers.length);
      }
    }
  }
  for (const it of keptStill) it.fixed = false;
  const holeParts: BoardPart[] = holes.map((hole) => {
    const at = holeAt(hole);
    const k = keep(hole);
    const pad = hole.plated ? hole.d + 1.2 : hole.d + 1; // annular ring, or the copper keep-out
    return {
      componentId: `hole:${hole.id}`,
      refdes: hole.id,
      value: `Ø${hole.d}`,
      part: 'board:mounting_hole',
      pkg: `MH-${hole.d}${hole.plated ? '-PTH' : ''}`,
      pkgInfo: { name: `MH-${hole.d}`, family: 'other', pins: 1 },
      x: r3(at.x),
      y: r3(at.y),
      rot: 0,
      side: 'top',
      pads: [{ number: '1', x: r3(at.x), y: r3(at.y), w: pad, h: pad, shape: 'round', drill: hole.d, ...(hole.plated ? {} : { npth: true }), ...(hole.netId ? { netId: hole.netId } : {}), layers: hole.plated ? [...layers] : [] }],
      body: { x: r3(at.x - hole.d / 2), y: r3(at.y - hole.d / 2), w: hole.d, h: hole.d },
      courtyard: { x: r3(at.x - k / 2), y: r3(at.y - k / 2), w: k, h: k },
      polarized: false,
      locked: true,
    };
  });

  /* ---- result ---- */
  const boardCutouts = cutouts.map((c) => placeCutout(c, w, h));
  const boardGraphics = (settings.graphics ?? []).map((g) => placeGraphic(g, w, h));
  const parts: BoardPart[] = [
    ...items.map((it) => {
      const pa = parent.get(it);
      const at = springs.find((x) => x.it === it && x.to === pa) ?? satellites.find((x) => x.it === it && x.to === pa);
      const said = declared.get(it);
      return {
        ...toPart(d, it, layers),
        ...(pa ? { follows: pa.comp.refdes, ...(at ? { followsPin: at.pin } : {}) } : {}),
        ...(said ? { belongsDeclared: true } : {}),
      };
    }),
    ...holeParts,
  ];
  // keep-outs where they stand now (those attached to a part follow it; one whose part is gone is inert)
  const boardKeepouts = (settings.keepouts ?? []).flatMap((k) => {
    const host = k.part ? parts.find((p) => p.componentId === k.part) : undefined;
    return k.part && !host ? [] : [placeKeepout(k, layers, host)];
  });
  const diagnostics = placementChecks(parts, w, h, rules.edgeClearance, { outline: { w, h }, cornerRadius: cornerR, shape }, boardCutouts);
  // silkscreen graphics: wholly on the board (the real outline, not its box), and clear of parts?
  const outlineOf = { outline: { w, h }, cornerRadius: cornerR, shape };
  for (const g of boardGraphics) {
    const label = `Silkscreen graphic ${g.id}${g.name ? ` (${g.name})` : ''}`;
    const pts = g.polys.flatMap((p) => p.map((_, i) => i).filter((i) => i % 2 === 0).map((i) => [p[i]!, p[i + 1]!] as const));
    const off = pts.filter(([x, y]) => insideBoard(outlineOf, x, y) < 0 || boardCutouts.some((c) => cutoutDistance(c, x, y) < 0));
    g.inside = off.length === 0;
    if (!g.inside) diagnostics.push({ code: 'DRC.SILK_OUTSIDE', severity: 'warning', message: `${label} reaches past the board outline${boardCutouts.length ? ' or into a cutout' : ''} (${Math.round((100 * off.length) / pts.length)} % of its contour); that part is not printed. Move or shrink it (edit_graphic).`, entities: [g.id] });
    const depth = figureDepths(g.polys);
    const inInk = (x: number, y: number) => g.polys.reduce((n, p, k) => n + (pointInPolygon(p, x, y) ? 1 : 0) * (depth[k]! % 2 === 0 ? 1 : -1), 0) > 0;
    g.over = parts
      .filter((p) => {
        // ink meets the parts on its own side (and the pads of through-hole parts)
        if (p.side !== g.side && !p.pads.some((q) => q.drill)) return false;
        const c = p.courtyard;
        if (c.x > g.bounds[2] || c.x + c.w < g.bounds[0] || c.y > g.bounds[3] || c.y + c.h < g.bounds[1]) return false;
        if (pts.some(([x, y]) => x > c.x && x < c.x + c.w && y > c.y && y < c.y + c.h)) return true;
        return g.mode === 'fill' && [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h], [c.x + c.w / 2, c.y + c.h / 2]].some(([x, y]) => inInk(x!, y!));
      })
      .map((p) => p.refdes);
    if (g.over.length) diagnostics.push({ code: 'DRC.SILK_OVER_PARTS', severity: 'warning', message: `${label} lies over ${g.over.join(', ')}; ink is kept off pads but covers the rest. Move it to a free spot (edit_graphic).`, entities: [g.id, ...g.over] });
  }
  // pins sharing one pad are one piece of copper: on two nets they short
  for (const it of items) {
    for (const pad of it.fp.pads) {
      if (!pad.also) continue;
      const on = padPins(pad).filter((n) => it.comp.pins[n]);
      if (new Set(on.map((n) => it.comp.pins[n])).size < 2) continue;
      const which = on.map((n) => `${n} on ${d.nets[it.comp.pins[n]!]?.name ?? '?'}`).join(', ');
      diagnostics.push({ code: 'DRC.SHARED_PAD_NETS', severity: 'error', message: `${it.comp.refdes}: pins ${padPins(pad).join(', ')} share one pad but are on different nets (${which}); that shorts them. Connect them to the same net.`, entities: [it.comp.refdes] });
    }
  }
  for (const ref of missing) {
    diagnostics.push({ code: 'DRC.NO_FOOTPRINT', severity: 'warning', message: `${ref} has no footprint (no package data); it is left off the board. Give it one from its datasheet drawing with set_footprint.`, entities: [ref] });
  }
  // a diode or LED whose pins do not say which is the cathode: the board cannot mark it
  for (const it of items) {
    if (polarityOf(it.card) !== 'unknown') continue;
    diagnostics.push({
      code: 'DRC.POLARITY_UNKNOWN',
      severity: 'warning',
      message: `${it.comp.refdes} is a${it.card.category === 'led' ? 'n LED' : ' diode'}, but the names of its pins (${it.card.pins.map((p) => `${p.number} "${p.name}"`).join(', ')}) do not say which is the cathode, so the silkscreen cannot mark it and the assembler will have to ask. Read it off the datasheet and say it with set_polarity (mark cathode, pin).`,
      entities: [it.comp.refdes],
    });
  }
  const planes = placePlanes(settingsPlanes(d, layers.length as 2 | 4), parts, w, h);
  const viaPlan = planVias(settings.vias ?? [], parts, w, h, rules, (id) => d.nets[id]?.attrs.maxCurrent);
  // the stack-up, and the impedance rules worked out for it (each layer's width and gaps)
  const stackup = boardStackup(settings);
  const impedance = resolveImpedance(d, { layers, planes, rules, ...(settings.fab ? { fab: settings.fab } : {}), stackup });
  // (keys sorted: a design read back from its file has them in another order than one just edited)
  const placementKey = hash(stableJson([w, h, cornerR, shape, boardCutouts, ...(boardKeepouts.length ? [boardKeepouts] : []), layers, rules, planes, ...(viaPlan.groups.length ? [viaPlan.fixed, viaPlan.fill, ...(viaPlan.drops ? [viaPlan.drops] : []), ...(viaPlan.along ? [viaPlan.along] : [])] : []), parts.map((p) => [p.componentId, p.x, p.y, p.rot, p.side, p.pads.map((q) => q.netId ?? '')])]));
  const drawn = settings.drawn ? drawnCopper(settings.drawn, parts) : null;
  const view: BoardView = {
    outline: { w, h },
    layers,
    rules,
    ...(settings.fab ? { fab: settings.fab } : {}),
    stackup,
    ...(impedance.length ? { impedance } : {}),
    parts,
    tracks: [...(viaPlan.stubs ?? []), ...(drawn?.tracks ?? [])],
    vias: [...viaPlan.fixed, ...(drawn?.vias ?? [])],
    zones: [],
    planes,
    viaGroups: viaPlan.groups,
    ratsnest: ratsnest(parts),
    diagnostics,
    stats: { nets: 0, routed: 0, unrouted: 0, trackLength: 0, vias: 0 },
    unrouted: [],
    measures: placementMeasures(parts, new Set(planes.filter((pl) => pl.layer !== 'F.Cu' && pl.layer !== 'B.Cu' && !pl.area).map((pl) => pl.netId)), {
      w,
      h,
      rules,
      signal: layers.filter((l) => !planes.some((pl) => pl.layer === l && l !== 'F.Cu' && l !== 'B.Cu' && !pl.area)),
    }),
    missing,
    netNames: Object.fromEntries(Object.values(d.nets).map((n) => [n.id, n.name])),
    routing: drawn ? 'done' : settings.routed ? (settings.routed === placementKey ? 'done' : 'stale') : 'none',
    ...(drawn ? { drawn } : {}),
    placementKey,
    sizeBy: userSize ? 'user' : 'proposal',
    cornerRadius: cornerR,
    shape,
    cutouts: boardCutouts,
    keepouts: boardKeepouts,
    graphics: boardGraphics,
  };
  // the polarity marks, once every pad and via is where it stays
  const marked = placeMarks(view);
  view.parts = marked.parts;
  view.diagnostics.push(...marked.diagnostics);
  if (settings.panel && parts.length) {
    const panel = panelView(view, settings.panel);
    view.panel = panel.view;
    view.diagnostics.push(...panel.diagnostics);
  }
  view.diagnostics.push(...fabPlacementDrc(view), ...keepoutDrc(view));
  applyWaivers(d, view.diagnostics);
  return view;
}

/** The placement to store (propose_placement, place, route): where every part is now. */
export function storedPlacement(b: BoardView): StoredPlacement {
  return {
    outline: { ...b.outline },
    parts: Object.fromEntries(b.parts.filter((p) => !p.componentId.startsWith('hole:')).map((p) => [p.componentId, { x: p.x, y: p.y, rot: p.rot }])),
  };
}

/** Whether a point lies inside a closed polygon (flat x, y list), even-odd. */
function pointInPolygon(p: number[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const [xi, yi, xj, yj] = [p[i]!, p[i + 1]!, p[j]!, p[j + 1]!];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** FNV-1a, as 8 hex digits. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Bump when what StoredCopper holds changes meaning: copper kept by an older version is routed again. */
const COPPER_FORMAT = 1;

/**
 * Place; route and check the copper when the route step was taken for this placement (or `route`).
 * Copper the design keeps for this placement (`board.copper`) is used as it is; otherwise the
 * board is routed (to completion if it can be: that may take a while) and the result comes back
 * as `newCopper` for the app to keep.
 */
export function layoutBoard(d: Design, sch: SchematicView, opts: { budgetMs?: number; route?: boolean; onProgress?: (p: RouteProgress) => void; onBest?: (c: StoredCopper) => void } = {}): BoardView {
  const b = placeBoard(d, sch);
  if (!b.parts.length || (b.routing !== 'done' && !opts.route)) return b;
  const { powerNets, planes, key, basis } = routeSetup(d, b);
  const pads = b.parts.flatMap((p) => p.pads);
  const kept = d.board?.copper?.key === key ? d.board.copper : null;
  // routed before for another placement on the same board: the router keeps what still holds of
  // it (incremental routing), but not the copper of a net whose width, current or planes changed
  // (drawn copper is the agent's: nothing to keep)
  const before = !kept && !b.drawn && d.board?.copper?.basis?.board === basis.board ? d.board.copper : null;
  const same = (netId: string) => before?.basis?.nets[netId] === basis.nets[netId];
  // (copper kept while the copper was drawn carries ids, anchors and the helper mark: the router's has none)
  const plain = <T extends object>(x: T): T => {
    const { id: _i, from: _f, to: _t, by: _b, ...rest } = x as T & { id?: string; from?: unknown; to?: unknown; by?: string };
    return rest as T;
  };
  const keep = before ? { tracks: before.tracks.filter((t) => same(t.netId)).map(plain), vias: before.vias.filter((v) => same(v.netId)).map(plain) } : null;
  const index = new Map(pads.map((p, i) => [p, i]));
  const toCopper = (r: ReturnType<typeof route>): StoredCopper => ({
    key,
    tracks: r.tracks,
    vias: r.vias,
    zones: r.zones,
    groups: r.groups,
    open: r.failed.map(({ netId, a, b: pb, ...why }) => ({ netId, a: index.get(a)!, b: index.get(pb)!, ...why })),
    nets: r.netsTotal,
    netsDone: r.netsDone,
    timedOut: r.timedOut,
    passes: r.passes,
    basis,
    ...(r.reused ? { reused: r.reused } : {}),
    ...(r.lines?.length ? { lines: r.lines } : {}),
  });
  const copper =
    kept ??
    toCopper(
      route(
        boardRouteInput(d, b, {
          ...(keep ? { keep } : {}),
          ...(opts.budgetMs ? { budgetMs: opts.budgetMs } : {}),
          ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
          // what a stop keeps: the best pass so far, marked as stopped
          ...(opts.onBest ? { onBest: (r: ReturnType<typeof route>) => opts.onBest!({ ...toCopper(r), stopped: true }) } : {}),
        }),
        b.drawn ? 1 : undefined,
      ),
    );
  const connected = (netId: string, a: BoardPad, pb: BoardPad) => {
    const ia = index.get(a);
    const ib = index.get(pb);
    return ia !== undefined && ib !== undefined && copper.groups[ia] === copper.groups[ib] && a.netId === netId;
  };
  const midpoint = (o: { a: number; b: number }) => ({ x: (pads[o.a]!.x + pads[o.b]!.x) / 2, y: (pads[o.a]!.y + pads[o.b]!.y) / 2 });
  const owner = b.parts.flatMap((p) => p.pads.map(() => p));
  const label = (i: number) => `${owner[i]?.refdes ?? '?'}.${pads[i]?.number ?? '?'}`;
  const unrouted: UnroutedConnection[] = copper.open.map(({ netId, a, b: pb, ...why }) => {
    const spot = why.at ?? midpoint({ a, b: pb });
    const near = b.parts
      .filter((p) => !p.componentId.startsWith('hole:'))
      .map((p) => ({ p, d: Math.hypot(Math.max(p.courtyard.x - spot.x, 0, spot.x - p.courtyard.x - p.courtyard.w), Math.max(p.courtyard.y - spot.y, 0, spot.y - p.courtyard.y - p.courtyard.h)) }))
      .filter((x) => x.d <= NEAR_MM)
      .sort((x, y) => x.d - y.d)
      .slice(0, 6)
      .map((x) => x.p.refdes);
    return { netId, from: label(a), to: label(pb), ...why, near };
  });
  const routed: BoardView = {
    ...b,
    routing: 'done',
    tracks: copper.tracks,
    vias: copper.vias,
    zones: copper.zones,
    planes,
    ratsnest: ratsnest(b.parts, connected),
    stats: {
      nets: copper.nets,
      routed: copper.netsDone,
      unrouted: copper.open.length,
      trackLength: Math.round(copper.tracks.reduce((s, t) => s + polyLength(t.pts), 0) * 10) / 10,
      vias: copper.vias.length,
    },
    unrouted,
    ...(kept ? {} : { newCopper: copper }),
    ...(copper.stopped ? { stopped: true } : {}),
    ...(copper.reused ? { reused: copper.reused } : {}),
  };
  // the polarity marks again, clear of the vias the routing put down
  const marked = placeMarks(routed);
  routed.parts = marked.parts;
  const name = (id: string) => d.nets[id]?.name ?? id;
  const diags = [...b.diagnostics.filter((x) => x.code !== 'DRC.SILK_POLARITY' && x.code !== 'DRC.KEEPOUT'), ...marked.diagnostics, ...keepoutDrc(routed), ...copperDrc(routed), ...edgeDrc(routed, !!b.drawn), ...fabCopperDrc(routed), ...splitDrc(routed, (id) => !powerNets.has(id)), ...planeViaDrc(routed), ...(b.drawn ? drawnDrc(routed) : []), ...impedanceDrc(routed, undefined, powerNets)].map((x) => (b.drawn ? softened(x) : x));
  // a pair the router could not keep together: recorded, so it is not silently two lines
  for (const l of copper.lines ?? []) {
    if (l.nets.length === 2 && l.why) diags.push({ code: 'IMP.PAIR', severity: 'info', message: `${l.nets.map(name).join('/')} (${l.id}) ${l.coupled ? 'kept together' : 'routed apart (open pair)'}: ${l.why}.`, entities: [l.id] });
  }
  const byNet = new Map<string, UnroutedConnection[]>();
  for (const u of unrouted) byNet.set(u.netId, [...(byNet.get(u.netId) ?? []), u]);
  for (const [netId, list] of byNet) {
    const u = list[0]!;
    const n = list.length;
    const why = u.enclosed
      ? `; ${u.from} is closed off by pads or the edge`
      : u.plane
        ? `; no room for a via down to the ${u.plane} plane`
        : u.blockedBy?.length
          ? `; ${u.blockedBy.map(name).join(', ')} ${u.blockedBy.length > 1 ? 'are' : 'is'} in the way${u.near.length ? ` near ${u.near.slice(0, 3).join(', ')}` : ''}`
          : '';
    diags.push({
      code: 'DRC.UNROUTED',
      severity: 'error',
      message: b.drawn
        ? `${n} connection${n > 1 ? 's' : ''} of ${name(netId)} not drawn yet (${u.from} → ${u.to}${n > 1 ? ', …' : ''})${why}.`
        : `${n} connection${n > 1 ? 's' : ''} of ${name(netId)} could not be routed (${u.from} → ${u.to}${n > 1 ? ', …' : ''})${why}.`,
      at: u.at ? { x: u.at.x, y: u.at.y } : midpoint(copper.open.find((o) => o.netId === netId)!),
      entities: [...new Set([u.from.split('.')[0]!, u.to.split('.')[0]!])],
    });
  }
  if (copper.stopped) {
    diags.unshift({
      code: 'DRC.ROUTING_INCOMPLETE',
      severity: 'warning',
      message: copper.passes
        ? `Routing was stopped after ${copper.passes} pass${copper.passes === 1 ? '' : 'es'}; the best is kept, with ${copper.open.length} connection${copper.open.length === 1 ? '' : 's'} left. Route runs it again from the start.`
        : 'Routing was stopped before its first pass finished: nothing is routed. Route runs it again.',
      entities: [],
    });
  } else if (copper.timedOut) {
    diags.unshift({
      code: 'DRC.ROUTING_INCOMPLETE',
      severity: 'warning',
      message: `Routing stopped at its time budget with ${copper.open.length} connection${copper.open.length === 1 ? '' : 's'} left. Moving or turning the parts round the open connections, a bigger board or 4 layers usually helps.`,
      entities: [],
    });
  }
  applyWaivers(d, diags);
  return { ...routed, diagnostics: diags };
}

/**
 * The router's input for the board as placed (`b`, from placeBoard): parts, outline, planes, the
 * vias placed on purpose and, with drawn copper, that copper; `extra` adds to it.
 */
export function boardRouteInput(d: Design, b: BoardView, extra: Partial<RouteInput> = {}): RouteInput {
  const { powerNets, planes, netWidths, gaps } = routeSetup(d, b);
  // the lines at a set impedance and the planes under them (the router keeps those planes whole)
  const lines: NonNullable<RouteInput['lines']> = [];
  for (const v of b.impedance ?? []) {
    for (const lay of v.layers) {
      const plane = b.planes.find((p) => p.layer === lay.over && !p.area) ?? b.planes.find((p) => p.layer === lay.over);
      if (plane) for (const netId of v.nets) lines.push({ netId, layer: lay.layer, over: lay.over, plane: plane.netId, h: lay.h });
    }
  }
  return {
    outline: b.outline,
    layers: b.layers,
    rules: b.rules,
    parts: b.parts,
    powerNets,
    netWidths,
    ...(Object.keys(gaps).length ? { pourGaps: gaps } : {}),
    ...(lines.length ? { lines } : {}),
    ...(b.impedance?.some((v) => v.layers.length) ? { controlled: b.impedance.filter((v) => v.layers.length).map((v) => ({ id: v.id, nets: v.nets, layers: v.layers.map((l) => ({ layer: l.layer, width: l.width, ...(l.gap !== undefined ? { gap: l.gap } : {}) })) })), netNames: b.netNames } : {}),
    planes: planes.map(({ netId, layer, area, style }) => ({ netId, layer, ...(area ? { area } : {}), ...(style ? { style } : {}) })),
    ...(b.viaGroups.length ? { vias: withGaps(planVias(d.board?.vias ?? [], b.parts, b.outline.w, b.outline.h, b.rules, (id) => d.nets[id]?.attrs.maxCurrent), gaps, b.rules.clearance) } : {}),
    cornerRadius: b.cornerRadius,
    ...(b.shape ? { shape: b.shape } : {}),
    cutouts: b.cutouts,
    ...(b.keepouts?.length ? { keepouts: b.keepouts } : {}),
    ...(b.drawn ? { drawn: { tracks: b.drawn.tracks, vias: b.drawn.vias } } : {}),
    ...extra,
  };
}

/** The router's via plan, a fence along a line told the line's gap to the ground (its pour gap, else the clearance). */
function withGaps(plan: ViaPlan, gaps: Record<string, number>, clearance: number): NonNullable<RouteInput['vias']> {
  const { groups: _g, along, ...rest } = plan;
  return { ...rest, ...(along?.length ? { along: along.map((a) => ({ ...a, gap: Math.max(clearance, gaps[a.line] ?? 0) })) } : {}) };
}

/**
 * The agent's drawn copper on the board as placed: a track end anchored on a pad lies on the pad's
 * centre wherever the part is now (a part moved or turned stretches the track's end piece).
 */
export function drawnCopper(dc: DrawnCopper, parts: BoardPart[]): { tracks: DrawnTrack[]; vias: DrawnVia[] } {
  const padAt = (a: PadAnchor | undefined) => (a ? parts.find((p) => p.componentId === a.componentId)?.pads.find((q) => q.number === a.pad) : undefined);
  const tracks = dc.tracks.map((t) => {
    const pts = t.pts.slice();
    const f = padAt(t.from);
    const e = padAt(t.to);
    if (f) [pts[0], pts[1]] = [f.x, f.y];
    if (e) [pts[pts.length - 2], pts[pts.length - 1]] = [e.x, e.y];
    return { ...t, pts: pts.map((v) => Math.round(v * 1000) / 1000) };
  });
  return { tracks, vias: dc.vias };
}

/**
 * Drawn copper: the hard rules stay errors (shorts, clearance, the edge, the fab's limits, open
 * connections); the rest is the agent's judgement and only warns. A via in a small part's land
 * pattern (no other net's pad under it: that is a short) is soft.
 */
export function softened(x: BoardDiagnostic): BoardDiagnostic {
  return x.code === 'DRC.VIA_IN_PAD' && x.severity === 'error' ? { ...x, severity: 'warning', message: `${x.message} (soft rule: fine where you mean it, e.g. a drop right beside a pad)` } : x;
}

/** What the router is given besides the placement, and the key copper routed with it is kept under. */
function routeSetup(d: Design, b: BoardView) {
  const powerNets = new Set(Object.values(d.nets).filter((n) => isPowerNet(n)).map((n) => n.id));
  const planes = b.planes;
  // a net's own width, or the one its impedance rule gives (on its first layer)
  const netWidths: Record<string, number> = Object.fromEntries(Object.values(d.nets).filter((n) => n.attrs.trackWidth).map((n) => [n.id, n.attrs.trackWidth!]));
  for (const v of b.impedance ?? []) if (v.layers[0]) for (const id of v.nets) netWidths[id] = v.layers[0].width;
  // how far the pours keep from a line at a set impedance
  const gaps = pourGaps(b.impedance);
  const key = hash(stableJson([COPPER_FORMAT, b.placementKey, [...powerNets].sort(), Object.entries(netWidths).sort(), ...(b.drawn ? ['drawn', b.drawn] : []), ...(Object.keys(gaps).length ? ['gaps', Object.entries(gaps).sort()] : [])]));
  // the pads dropping through vias the agent placed (add_vias drop), per net
  const drops = (d.board?.vias ?? []).filter((g) => g.kind === 'drop');
  // what copper routed now holds under (StoredCopper.basis): the board, and per net what decides its
  // copper. (Not the outline: an auto-sized board grows as parts move; the copper is checked
  // against the edge as it is now.)
  const basis = {
    board: hash(stableJson([COPPER_FORMAT, b.layers, b.rules])),
    nets: Object.fromEntries(
      Object.keys(d.nets)
        .sort()
        .map((id) => [id, hash(stableJson([powerNets.has(id), netWidths[id] ?? null, drops.filter((g) => g.netId === id).map((g) => [g.pad, g.offsets ?? g.count ?? null, g.drill ?? null, g.size ?? null]), planes.filter((pl) => pl.netId === id).map((pl) => [pl.layer, !!pl.area, pl.style ?? null]), ...(gaps[id] !== undefined ? [gaps[id]] : [])]))]),
    ),
  };
  return { powerNets, planes, netWidths, gaps, key, basis };
}

/** The key copper routed for this design's board now would be kept under (see BoardSettings.copper). */
export function copperKey(d: Design, sch: SchematicView): string {
  return routeSetup(d, placeBoard(d, sch)).key;
}

/** Parts this close (mm) to where a connection is blocked are named with it. */
const NEAR_MM = 3;

/** The ratsnest of the nets routed as tracks: its length and where lines of different nets cross. */
function placementMeasures(parts: BoardPart[], planeNets: Set<string>, board: Omit<CongestionBoard, 'pads'>): BoardView['measures'] {
  const lines = ratsnest(parts).filter((l) => !planeNets.has(l.netId));
  const len = lines.reduce((s, l) => s + Math.hypot(l.x2 - l.x1, l.y2 - l.y1), 0);
  const o = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  let crossings = 0;
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i]!;
    for (let j = i + 1; j < lines.length; j++) {
      const c = lines[j]!;
      if (c.netId === a.netId) continue;
      if (Math.max(a.x1, a.x2) < Math.min(c.x1, c.x2) || Math.max(c.x1, c.x2) < Math.min(a.x1, a.x2) || Math.max(a.y1, a.y2) < Math.min(c.y1, c.y2) || Math.max(c.y1, c.y2) < Math.min(a.y1, a.y2)) continue;
      if (o(a.x1, a.y1, a.x2, a.y2, c.x1, c.y1) * o(a.x1, a.y1, a.x2, a.y2, c.x2, c.y2) < 0 && o(c.x1, c.y1, c.x2, c.y2, a.x1, a.y1) * o(c.x1, c.y1, c.x2, c.y2, a.x2, a.y2) < 0) crossings++;
    }
  }
  return { ratsnestMm: Math.round(len * 10) / 10, crossings, congestion: congestion({ ...board, pads: parts.flatMap((p) => p.pads) }, lines) };
}

function polyLength(pts: number[]): number {
  let len = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) len += Math.hypot(pts[i + 2]! - pts[i]!, pts[i + 3]! - pts[i + 1]!);
  return len;
}

/**
 * Snap so that pad 1 lies on the grid: on fine-pitch parts every pad centre line then falls on
 * the router's grid, which is where a track fits between two neighbouring pads.
 */
function snapItem(it: Item) {
  const p = it.fp.pads[0];
  if (!p) {
    it.x = snap(it.x);
    it.y = snap(it.y);
    return;
  }
  const [px, py] = rotate(p.x, p.y, it.rot);
  it.x = r3(snap(it.x + px) - px);
  it.y = r3(snap(it.y + py) - py);
}

/** Push overlapping courtyards apart along the axis of least overlap. */
function separate(items: Item[], passes: number, strict = false, keepStill = false) {
  const sorted = [...items].sort((a, b) => natCmp(a.comp.refdes, b.comp.refdes));
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!;
      const ea = extent(a);
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j]!;
        if ((a.fixed && b.fixed) || !collide(a, b)) continue;
        const eb = extent(b);
        const ox = (ea.w + eb.w) / 2 + SPACING - Math.abs(a.x - b.x);
        const oy = (ea.h + eb.h) / 2 + SPACING - Math.abs(a.y - b.y);
        // (on the grid, spacing short by up to a step stays: snapping moves parts by half a step,
        // and a placement that is settled must stay put when laid out again)
        const tol = strict ? GRID_MM + 1e-6 : 1e-6;
        if (ox <= tol || oy <= tol) continue;
        moved = true;
        if (!strict) {
          // during relaxation: push apart along the line between the centres, so a cluster
          // spreads in two dimensions instead of stacking into a column along one axis
          let ux = b.x - a.x;
          let uy = b.y - a.y;
          let len = Math.hypot(ux, uy);
          if (len < 1e-9) {
            const ang = ((i * 7 + j * 13) % 16) * (Math.PI / 8); // deterministic direction
            ux = Math.cos(ang);
            uy = Math.sin(ang);
            len = 1;
          }
          ux /= len;
          uy /= len;
          // distance along u that removes the overlap
          const t = Math.min(Math.abs(ux) > 1e-9 ? ((ea.w + eb.w) / 2 + SPACING) / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-9 ? ((ea.h + eb.h) / 2 + SPACING) / Math.abs(uy) : Infinity);
          const need = t - (Math.abs(b.x - a.x) * Math.abs(ux) + Math.abs(b.y - a.y) * Math.abs(uy));
          if (need <= 0) continue;
          const [ka, kb] = share(a, b, ea, eb);
          a.x -= ux * need * ka;
          a.y -= uy * need * ka;
          b.x += ux * need * kb;
          b.y += uy * need * kb;
          continue;
        }
        const alongX = ox < oy;
        const amount = (alongX ? ox : oy) + (strict ? GRID_MM : 0);
        // deterministic direction when centres coincide
        const sign = alongX ? (a.x < b.x || (a.x === b.x && i < j) ? -1 : 1) : a.y < b.y || (a.y === b.y && i < j) ? -1 : 1;
        // final clean-up on the grid: equal shares (mass weighting would let a small part
        // oscillate against the outline next to a big one)
        const ma = mobility(a);
        const mb = mobility(b);
        // two of the user's choices: the part with fewer pins gives way (a cap to its IC)
        const both = ma === 1 && mb === 1;
        const pa = both ? a.fp.pads.length : 0;
        const pb = both ? b.fp.pads.length : 0;
        const [ka, kb] = ma < mb || pa > pb ? [0, 1] : mb < ma || pb > pa ? [1, 0] : [0.5, 0.5];
        if (alongX) {
          a.x += sign * amount * ka;
          b.x -= sign * amount * kb;
        } else {
          a.y += sign * amount * ka;
          b.y -= sign * amount * kb;
        }
        if (strict) {
          // (keepStill, from a stored placement: only what moved, snapping a part that stayed would nudge a user's choice off its place)
          if (!a.fixed && (ka > 0 || !keepStill)) {
            a.x = snap(a.x);
            a.y = snap(a.y);
          }
          if (!b.fixed && (kb > 0 || !keepStill)) {
            b.x = snap(b.x);
            b.y = snap(b.y);
          }
        }
      }
    }
    if (!moved) break;
  }
}

/*
 * Similar parts next to each other line up: a column of caps stacked above each other shares
 * one x, a row of resistors side by side one y. Similar: the same footprint size, turned the same
 * way; next to each other: nearly aligned already (within ALIGN_TOL) and courtyards at most
 * ALIGN_GAP apart. The line is a locked part's or a user's choice's if the group has one, else
 * the most common position. A part moves only if that overlaps nothing.
 */
const ALIGN_TOL = 1;
const ALIGN_GAP = 2;
function alignSimilar(items: Item[], contain: (it: Item) => void) {
  const key = (it: Item) => `${r3(it.cw)}x${r3(it.ch)}/${it.rot % 180}/${it.side}`;
  for (const column of [true, false]) {
    // neighbours: stacked (column) or side by side (row), nearly aligned across
    const parent = items.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    for (let i = 0; i < items.length; i++) {
      const a = items[i]!;
      const ea = extent(a);
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j]!;
        if (key(a) !== key(b)) continue;
        const across = column ? Math.abs(a.x - b.x) : Math.abs(a.y - b.y);
        const gap = column ? Math.abs(a.y - b.y) - ea.h : Math.abs(a.x - b.x) - ea.w;
        if (across <= ALIGN_TOL + 1e-9 && gap <= ALIGN_GAP && gap > -1e-6) parent[find(j)] = find(i);
      }
    }
    const groups = new Map<number, Item[]>();
    items.forEach((it, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), it]));
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const at = (it: Item) => (column ? it.x : it.y);
      const put = (it: Item, v: number) => (column ? (it.x = v) : (it.y = v));
      /** Move the group's movable parts onto `target` where that clashes with nothing; how many are on it. */
      const apply = (target: number) => {
        for (const it of group) {
          if (it.fixed || it.intent || Math.abs(at(it) - target) < 1e-9) continue;
          const was = at(it);
          put(it, target);
          const x = it.x;
          const y = it.y;
          contain(it);
          if (it.x !== x || it.y !== y || items.some((o) => o !== it && closer(it, o, SPACING - GRID_MM))) {
            put(it, was);
            contain(it);
          }
        }
        return group.filter((it) => Math.abs(at(it) - target) < 1e-9).length;
      };
      // the line: a locked part's or a user's choice's; else each position in the group is tried
      // (most common first) and the one that lines up the most parts wins
      const anchor = group.find((it) => it.fixed) ?? group.find((it) => it.intent);
      const count = new Map<number, number>();
      for (const it of group) count.set(r3(at(it)), (count.get(r3(at(it))) ?? 0) + 1);
      const mid = group.reduce((sum, it) => sum + at(it), 0) / group.length;
      const candidates = anchor ? [at(anchor)] : [...count.entries()].sort((p, q) => q[1] - p[1] || Math.abs(p[0] - mid) - Math.abs(q[0] - mid) || p[0] - q[0]).map(([v]) => v);
      const start = group.map((it) => ({ it, x: it.x, y: it.y }));
      let best = { target: candidates[0]!, n: 0 };
      for (const target of candidates) {
        const n = apply(target);
        for (const s of start) {
          s.it.x = s.x;
          s.it.y = s.y;
        }
        if (n > best.n) best = { target, n };
      }
      apply(best.target);
    }
  }
}

/** Two courtyards closer than `gap`? */
function closer(a: Item, b: Item, gap: number): boolean {
  if (!collide(a, b)) return false;
  const ea = extent(a);
  const eb = extent(b);
  return (ea.w + eb.w) / 2 + gap - Math.abs(a.x - b.x) > 1e-6 && (ea.h + eb.h) / 2 + gap - Math.abs(a.y - b.y) > 1e-6;
}

/** Who gives way in an overlap: automatic parts before the user's choices, locked parts never. */
const mobility = (it: Item) => (it.fixed ? 0 : it.intent ? 1 : 2);

/** How much of a separation each part takes: the less mobile none, otherwise the smaller part more. */
function share(a: Item, b: Item, ea: { w: number; h: number }, eb: { w: number; h: number }): [number, number] {
  const ma = mobility(a);
  const mb = mobility(b);
  if (ma < mb) return [0, 1];
  if (mb < ma) return [1, 0];
  const sa = ea.w * ea.h;
  const sb = eb.w * eb.h;
  return [sb / (sa + sb), sa / (sa + sb)];
}

/** Any two courtyards closer than `gap` (0: overlapping)? */
function overlapping(items: Item[], gap = 0): boolean {
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!;
    const ea = extent(a);
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j]!;
      if ((a.fixed && b.fixed) || !collide(a, b)) continue;
      const eb = extent(b);
      if ((ea.w + eb.w) / 2 + gap - Math.abs(a.x - b.x) > 1e-6 && (ea.h + eb.h) / 2 + gap - Math.abs(a.y - b.y) > 1e-6) return true;
    }
  }
  return false;
}

function bounds(items: Item[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const it of items) {
    const e = extent(it);
    x0 = Math.min(x0, it.x - e.w / 2);
    y0 = Math.min(y0, it.y - e.h / 2);
    x1 = Math.max(x1, it.x + e.w / 2);
    y1 = Math.max(y1, it.y + e.h / 2);
  }
  return items.length ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 };
}

function toPart(d: Design, it: Item, layers: CopperLayer[]): BoardPart {
  const pads: BoardPad[] = it.fp.pads.map((p) => {
    const [x, y] = rotate(p.x, p.y, it.rot);
    const net = padNet(it.comp, p);
    return {
      number: p.number,
      ...(p.also ? { also: p.also } : {}),
      x: r3(it.x + x),
      y: r3(it.y + y),
      w: swapped(it.rot) ? p.h : p.w,
      h: swapped(it.rot) ? p.w : p.h,
      shape: p.shape,
      ...(p.drill ? { drill: p.drill } : {}),
      ...(p.slot ? { slot: swapped(it.rot) ? { w: p.slot.h, h: p.slot.w } : p.slot } : {}),
      ...(net ? { netId: net } : {}),
      layers: p.drill ? [...layers] : [it.side === 'bottom' ? 'B.Cu' : 'F.Cu'],
    };
  });
  const rect = (w: number, h: number) => {
    const [rw, rh] = swapped(it.rot) ? [h, w] : [w, h];
    return { x: r3(it.x - rw / 2), y: r3(it.y - rh / 2), w: rw, h: rh };
  };
  // which way round it goes, and the pad its mark is for (the mark is placed once the whole board is)
  const polarity = polarityOf(it.card);
  const marked = polarity && polarity !== 'unknown' ? padOfPin(pads, polarity.pin) : undefined;
  const body = { ...rect(it.fp.body.w, it.fp.body.h), ...(it.fp.body.round ? { round: true } : {}) };
  // the footprint's own chamfered corners (an electrolytic's + side), turned with the part; else pin 1's corner
  const own = it.fp.body.chamfer && !it.fp.body.round ? { size: it.fp.body.chamfer.size, corners: it.fp.body.chamfer.corners.map((c) => cornerAt(...rotate(...CORNER[c], it.rot))) } : null;
  const chamfer = own ?? (marked && polarity !== 'unknown' && polarity?.kind === 'pin1' ? pin1Chamfer(body, marked) : null);
  return {
    componentId: it.comp.id,
    refdes: it.comp.refdes,
    value: valueOf(d, it.comp),
    part: it.card.id,
    category: it.card.category,
    ...((it.comp.params.mpn ?? it.card.mpn) ? { mpn: it.comp.params.mpn ?? it.card.mpn } : {}),
    ...(it.card.manufacturer ? { manufacturer: it.card.manufacturer } : {}),
    ...(it.comp.params.lcsc ? { lcsc: it.comp.params.lcsc } : {}),
    ...(it.comp.params.eurocircuits ? { eurocircuits: it.comp.params.eurocircuits } : {}),
    pkg: it.pkg,
    pkgInfo: it.info,
    x: r3(it.x),
    y: r3(it.y),
    rot: it.rot,
    side: it.side,
    pads,
    body: { ...body, ...(chamfer ? { chamfer } : {}) },
    courtyard: rect(it.cw, it.ch),
    polarized: polarity !== null,
    ...(marked && polarity && polarity !== 'unknown' ? { mark: { kind: polarity.kind, pad: marked.number, strokes: [], dots: [] } } : {}),
    ...(it.card.topImage ? { topImage: { src: it.card.topImage.src, rot: it.card.topImage.rot } } : {}),
    locked: it.fixed,
    ...(it.intent ? { intent: it.intent.rel ? { anchor: anchorRef(d, it.intent.rel) } : {} } : {}),
    ...(it.by && (it.fixed || it.intent) ? { by: it.by } : {}),
  };
}

const anchorRef = (d: Design, compId: string) => d.components[compId]?.refdes ?? compId;

/** Minimum spanning tree of each net's pads (Prim), as straight lines. */
export function ratsnest(parts: BoardPart[], connected?: (netId: string, a: BoardPad, b: BoardPad) => boolean): RatsLine[] {
  const byNet = new Map<string, BoardPad[]>();
  for (const part of parts) for (const p of part.pads) if (p.netId) byNet.set(p.netId, [...(byNet.get(p.netId) ?? []), p]);
  const out: RatsLine[] = [];
  for (const [netId, pads] of [...byNet.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (pads.length < 2) continue;
    const inTree = [0];
    const dist = pads.map((p) => Math.hypot(p.x - pads[0]!.x, p.y - pads[0]!.y));
    const from = pads.map(() => 0);
    const done = new Set([0]);
    while (inTree.length < pads.length) {
      let best = -1;
      for (let i = 0; i < pads.length; i++) if (!done.has(i) && (best < 0 || dist[i]! < dist[best]!)) best = i;
      done.add(best);
      inTree.push(best);
      const a = pads[from[best]!]!;
      const b = pads[best]!;
      if (!connected?.(netId, a, b)) out.push({ netId, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      for (let i = 0; i < pads.length; i++) {
        if (done.has(i)) continue;
        const dd = Math.hypot(pads[i]!.x - b.x, pads[i]!.y - b.y);
        if (dd < dist[i]!) {
          dist[i] = dd;
          from[i] = best;
        }
      }
    }
  }
  return out;
}

function placementChecks(parts: BoardPart[], w: number, h: number, edge: number, outline: { outline: { w: number; h: number }; cornerRadius: number; shape: number[] | null }, cutouts: BoardCutout[] = []): BoardDiagnostic[] {
  const shaped = outline.cornerRadius > 0 || !!outline.shape;
  const out: BoardDiagnostic[] = [];
  // a pad's corners (and centre): how far inside the outline / outside every cutout
  const padPoints = (p: BoardPad) => [[p.x - p.w / 2, p.y - p.h / 2], [p.x + p.w / 2, p.y - p.h / 2], [p.x - p.w / 2, p.y + p.h / 2], [p.x + p.w / 2, p.y + p.h / 2], [p.x, p.y]] as const;
  // through-hole parts (and holes) take their place on both sides
  const through = parts.map((p) => p.pads.some((q) => q.drill));
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i]!;
    const A = a.courtyard;
    const hole = a.componentId.startsWith('hole:');
    // on the board: the body and the pads (the courtyard may reach past the edge: a connector flush with it)
    const Y = a.body;
    const corners = [[Y.x, Y.y], [Y.x + Y.w, Y.y], [Y.x, Y.y + Y.h], [Y.x + Y.w, Y.y + Y.h]] as const;
    const x0 = Math.min(Y.x, ...a.pads.map((p) => p.x - p.w / 2));
    const y0 = Math.min(Y.y, ...a.pads.map((p) => p.y - p.h / 2));
    const x1 = Math.max(Y.x + Y.w, ...a.pads.map((p) => p.x + p.w / 2));
    const y1 = Math.max(Y.y + Y.h, ...a.pads.map((p) => p.y + p.h / 2));
    if (x0 < -1e-6 || y0 < -1e-6 || x1 > w + 1e-6 || y1 > h + 1e-6 || (outline.shape && !hole && corners.some(([x, y]) => insideBoard(outline, x, y) < -1e-6))) {
      out.push({ code: 'DRC.OFF_BOARD', severity: 'error', message: `${a.refdes} is outside the board outline.`, at: { x: a.x, y: a.y }, entities: [a.refdes] });
    } else if (a.pads.some((p) => p.x - p.w / 2 < edge || p.y - p.h / 2 < edge || p.x + p.w / 2 > w - edge || p.y + p.h / 2 > h - edge || (shaped && padPoints(p).some(([x, y]) => insideBoard(outline, x, y) < edge)))) {
      out.push({ code: 'DRC.EDGE_CLEARANCE', severity: 'error', message: `${a.refdes} has copper closer than ${edge} mm to the board edge.`, at: { x: a.x, y: a.y }, entities: [a.refdes] });
    }
    for (const c of hole ? [] : cutouts) {
      // the courtyard over the cutout, or copper within the edge clearance of it
      const cy = { x0: A.x, y0: A.y, x1: A.x + A.w, y1: A.y + A.h };
      const over = cutoutDistance(c, Math.min(Math.max(c.x, cy.x0), cy.x1), Math.min(Math.max(c.y, cy.y0), cy.y1)) < 0 || cutoutPolygon(c).some((v, k, pts) => k % 2 === 0 && v > cy.x0 && v < cy.x1 && pts[k + 1]! > cy.y0 && pts[k + 1]! < cy.y1);
      if (over) out.push({ code: 'DRC.CUTOUT_OVERLAP', severity: 'error', message: `${a.refdes} lies over cutout ${c.id}.`, at: { x: a.x, y: a.y }, entities: [a.refdes] });
      else if (a.pads.some((p) => padPoints(p).some(([x, y]) => cutoutDistance(c, x, y) < edge))) out.push({ code: 'DRC.EDGE_CLEARANCE', severity: 'error', message: `${a.refdes} has copper closer than ${edge} mm to cutout ${c.id}.`, at: { x: a.x, y: a.y }, entities: [a.refdes] });
    }
    for (let j = i + 1; j < parts.length; j++) {
      const b = parts[j]!;
      const B = b.courtyard;
      if (a.side !== b.side && !through[i] && !through[j]) continue; // SMD parts on opposite sides share the area
      if (A.x < B.x + B.w - 1e-6 && B.x < A.x + A.w - 1e-6 && A.y < B.y + B.h - 1e-6 && B.y < A.y + A.h - 1e-6) {
        out.push({ code: 'DRC.COURTYARD_OVERLAP', severity: 'error', message: `${a.refdes} and ${b.refdes} overlap (courtyards).`, at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, entities: [a.refdes, b.refdes] });
      }
    }
  }
  return out;
}


/** Parts of one supply this close (mm, courtyard to courtyard) are one group in the plane plan. */
const PLAN_GROUP_MM = 6;

/**
 * What the agent decides the planes from (get_board plane_plan): per supply and ground net, its
 * pins, the ICs drawing from it, where its parts stand (groups of parts close together), and what
 * carries it now; and which layer each outer layer's tracks run over.
 */
export function planePlan(d: Design, b: BoardView) {
  const four = b.layers.length === 4;
  const supplies = Object.values(d.nets)
    .filter((n) => isPowerNet(n))
    .map((n) => {
      const parts = b.parts.filter((p) => p.pads.some((q) => q.netId === n.id));
      const pins = parts.reduce((sum, p) => sum + p.pads.filter((q) => q.netId === n.id).length, 0);
      return { n, parts, pins };
    })
    .filter((x) => x.pins >= 2)
    .sort((x, y) => y.pins - x.pins || natCmp(x.n.name, y.n.name));
  const box = (ps: BoardPart[]) => {
    const r = (v: number) => Math.round(v * 10) / 10;
    return [r(Math.min(...ps.map((p) => p.courtyard.x))), r(Math.min(...ps.map((p) => p.courtyard.y))), r(Math.max(...ps.map((p) => p.courtyard.x + p.courtyard.w))), r(Math.max(...ps.map((p) => p.courtyard.y + p.courtyard.h)))];
  };
  const apart = (p: BoardPart, q: BoardPart) =>
    Math.max(p.courtyard.x - (q.courtyard.x + q.courtyard.w), q.courtyard.x - (p.courtyard.x + p.courtyard.w), p.courtyard.y - (q.courtyard.y + q.courtyard.h), q.courtyard.y - (p.courtyard.y + p.courtyard.h), 0);
  return {
    stackup: four
      ? 'F.Cu tracks run over In1.Cu, B.Cu tracks over In2.Cu: their return current flows in that plane, right under them. An area plane (set_plane under or rect) splits its layer; a signal track over it that crosses the area\'s edge makes its return current detour round the gap (PLANE.SPLIT_CROSSING), so the router crosses splits on the other outer layer where it can. Put an area where its net\'s pins are, with few signals leaving it on the layer over it.'
      : 'F.Cu tracks run over the B.Cu pour: it is their return path. Every track on B.Cu cuts the pour, so keep those short and few under fast signals.',
    supplies: supplies.map(({ n, parts, pins }) => {
      const feeds = parts
        .map((p) => {
          const comp = d.components[p.componentId];
          const card = comp && cardOf(d, comp.part);
          const supplyPins = card && card.pins.length > 3 ? card.pins.filter((q) => q.type === 'pwr_in' && comp.pins[q.number] === n.id).length : 0;
          return { p, supplyPins };
        })
        .filter((x) => x.supplyPins > 0)
        .sort((x, y) => y.supplyPins - x.supplyPins || natCmp(x.p.refdes, y.p.refdes))
        .map((x) => `${x.p.refdes} (${x.supplyPins} pin${x.supplyPins > 1 ? 's' : ''})`);
      // groups: parts within PLAN_GROUP_MM of each other (single linkage)
      const group = parts.map((_, i) => i);
      const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i]!)));
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (apart(parts[i]!, parts[j]!) <= PLAN_GROUP_MM) group[find(i)] = find(j);
      const byRoot = new Map<number, BoardPart[]>();
      parts.forEach((p, i) => byRoot.set(find(i), [...(byRoot.get(find(i)) ?? []), p]));
      const groups = [...byRoot.values()].sort((x, y) => y.length - x.length);
      const on = b.planes
        .filter((pl) => pl.netId === n.id)
        .map((pl) => `${pl.layer} ${pl.area ? (pl.under ? `under ${pl.under.join(', ')}` : `area ${pl.area.join(', ')}`) : pl.layer === 'F.Cu' || pl.layer === 'B.Cu' ? 'pour' : 'whole layer'}${pl.auto ? ' (automatic)' : ''}`);
      return {
        net: n.name,
        ...(n.attrs.voltage !== undefined ? { voltage: n.attrs.voltage } : {}),
        ...(isGroundNet(n) ? { ground: true } : {}),
        pins,
        ...(feeds.length ? { feeds } : {}),
        carried_by: on.length ? on : ['tracks'],
        box_mm: box(parts),
        ...(groups.length > 1 ? { groups: groups.map((g) => ({ parts: g.map((p) => p.refdes).sort(natCmp), box_mm: box(g) })) } : {}),
      };
    }),
  };
}

/**
 * Automatic planes: GND (the ground net with the most pins) on B.Cu for 2 layers; on 4 layers
 * GND on In1.Cu and the supply net with the most pins on In2.Cu (the usual stack-up).
 */
export function autoPlanes(d: Design, layers: 2 | 4): { netId: string; layer: CopperLayer; auto: boolean }[] {
  const pins = new Map<string, number>();
  for (const c of Object.values(d.components)) for (const n of Object.values(c.pins)) pins.set(n, (pins.get(n) ?? 0) + 1);
  const most = (ok: (n: Design['nets'][string]) => boolean) =>
    Object.values(d.nets)
      .filter((n) => ok(n) && (pins.get(n.id) ?? 0) >= 2)
      .sort((x, y) => (pins.get(y.id) ?? 0) - (pins.get(x.id) ?? 0) || x.name.localeCompare(y.name))[0];
  const ground = most(isGroundNet);
  const out: { netId: string; layer: CopperLayer; auto: boolean }[] = [];
  if (layers === 2) {
    if (ground) out.push({ netId: ground.id, layer: 'B.Cu', auto: true });
    return out;
  }
  if (ground) out.push({ netId: ground.id, layer: 'In1.Cu', auto: true });
  // the supply plane feeds the ICs: the rail most IC supply pins draw from (+3V3 under an MCU),
  // not the one with the most pins (an input rail with many connector pins and caps)
  const icSupply = new Map<string, number>();
  for (const c of Object.values(d.components)) {
    const card = cardOf(d, c.part);
    if (!card || card.pins.length <= 3) continue;
    for (const pin of card.pins) {
      const n = c.pins[pin.number];
      if (n && pin.type === 'pwr_in') icSupply.set(n, (icSupply.get(n) ?? 0) + 1);
    }
  }
  const supply = Object.values(d.nets)
    .filter((n) => isPowerNet(n) && !isGroundNet(n) && (pins.get(n.id) ?? 0) >= 2)
    .sort((x, y) => (icSupply.get(y.id) ?? 0) - (icSupply.get(x.id) ?? 0) || (pins.get(y.id) ?? 0) - (pins.get(x.id) ?? 0) || x.name.localeCompare(y.name))[0];
  if (supply) out.push({ netId: supply.id, layer: 'In2.Cu', auto: true });
  return out;
}

/** Planes in effect: the explicit ones from set_plane, else automatic. */
export function settingsPlanes(d: Design, layers: 2 | 4): { netId: string; layer: CopperLayer; auto: boolean; area?: PlaneArea; style?: PlaneStyle }[] {
  const explicit = d.board?.planes;
  if (!explicit) return autoPlanes(d, layers);
  const valid = new Set<CopperLayer>(layers === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu']);
  return explicit.filter((p) => valid.has(p.layer) && d.nets[p.netId]).map((p) => ({ ...p, auto: false }));
}

/**
 * Where each plane lies on the board as placed: an area plane's rectangle (under parts: their
 * courtyards' box plus the margin, so it follows them), within the board. An area under parts
 * that are all gone, or one off the board, is left out.
 */
/**
 * The vias placed on purpose, where they go now: copper from the start (fixed), or spots the
 * router fills where a via fits, in order, at most `limits` of a group (a tie: its spots round the
 * one it is centred on, more than it wants, so a blocked one is made up for).
 */
export interface ViaPlan {
  fixed: Via[];
  fill: Via[];
  limits?: Record<string, number>;
  /**
   * Pads dropping onto their plane through vias the agent placed (add_vias drop): those vias are
   * in `fixed`, `stubs` join each to its pad.
   */
  drops?: { group: string; componentId: string; number: string; vias: { x: number; y: number }[] }[];
  /** A drop via's stub: a short track from inside its pad to the via, power width (narrower where the via or the pad is). */
  stubs?: Track[];
  /** Fences along a line (a net's tracks), laid by the router along both sides of them once they are routed. */
  along?: { group: string; netId: string; line: string; pitch: number; drill: number; pad: number }[];
  groups: BoardView['viaGroups'];
}

/** Ties: never fewer vias than this (one may be bad), nor more than this many. */
const TIE_MIN = 2;
const TIE_MAX = 16;

/**
 * Where each via group's vias go on this placement (a pad group follows its part). `amps`: a
 * net's max_current, for ties without their own (and to judge a grid's).
 */
export function planVias(groups: ViaGroup[], parts: BoardPart[], w: number, h: number, rules: BoardRules, amps: (netId: string) => number | undefined = () => undefined): ViaPlan {
  const out: ViaPlan = { fixed: [], fill: [], groups: [] };
  for (const g of groups) {
    const via = (x: number, y: number, extra: Partial<Via> = {}): Via => ({ netId: g.netId, x: r3(x), y: r3(y), drill: g.drill ?? rules.viaDrill, pad: g.size ?? Math.max(rules.viaPad, (g.drill ?? rules.viaDrill) + 0.2), group: g.id, ...extra });
    const size = g.size ?? Math.max(rules.viaPad, (g.drill ?? rules.viaDrill) + 0.2);
    const pitch = g.pitch ?? VIA_PITCH[g.kind];
    // centres spread evenly across a span, as many as fit `pitch` apart
    const spread = (a: number, b: number) => {
      const n = Math.max(1, Math.floor((b - a) / pitch + 1e-6) + 1);
      const s0 = a + (b - a - (n - 1) * pitch) / 2;
      return Array.from({ length: n }, (_, i) => s0 + i * pitch);
    };
    const entry = (wanted: number, note?: string) => out.groups.push({ id: g.id, netId: g.netId, kind: g.kind, wanted, ...(note ? { note } : {}) });
    if (g.kind === 'pad') {
      const part = parts.find((p) => p.componentId === g.pad?.componentId);
      const pad = part?.pads.filter((p) => p.number === g.pad?.number).sort((a, b) => b.w * b.h - a.w * a.h)[0];
      if (!part || !pad) {
        entry(0, part ? `${part.refdes} has no pad ${g.pad?.number} any more` : 'its part is not on the board');
        continue;
      }
      if (pad.netId !== g.netId) {
        entry(0, `${part.refdes}.${pad.number} is on another net now: add the vias again`);
        continue;
      }
      const xs = spread(pad.x - pad.w / 2 + size / 2, pad.x + pad.w / 2 - size / 2);
      const ys = spread(pad.y - pad.h / 2 + size / 2, pad.y + pad.h / 2 - size / 2);
      for (const y of ys) for (const x of xs) out.fixed.push(via(x, y, { inPad: true }));
      entry(xs.length * ys.length);
    } else if (g.kind === 'points') {
      for (const [x, y] of g.points ?? []) out.fixed.push(via(x, y));
      entry(g.points?.length ?? 0);
    } else if (g.kind === 'drop') {
      const part = parts.find((p) => p.componentId === g.pad?.componentId);
      const pad = part?.pads.find((p) => p.number === g.pad?.number);
      if (!part || !pad) {
        entry(0, part ? `${part.refdes} has no pad ${g.pad?.number} any more` : 'its part is not on the board');
        continue;
      }
      const name = `${part.refdes}.${pad.number}`;
      if (!g.offsets?.length) {
        out.groups.push({ id: g.id, netId: g.netId, kind: 'drop', wanted: g.count ?? 0, pad: name, note: `the vias' spots are not given: place them with add_vias drop at (each right beside ${name})` });
        continue;
      }
      if (pad.netId !== g.netId) {
        out.groups.push({ id: g.id, netId: g.netId, kind: 'drop', wanted: 0, pad: name, note: `${name} is on another net now: add the vias again` });
        continue;
      }
      const spots = g.offsets.map((o) => dropSpot(part, pad, o));
      for (const [x, y] of spots) out.fixed.push(via(x, y));
      (out.drops ??= []).push({ group: g.id, componentId: part.componentId, number: pad.number, vias: spots.map(([x, y]) => ({ x, y })) });
      // each via's stub: from inside the pad (its round end within it) straight to the via
      const sw = r3(Math.min(rules.powerTrack, size, pad.w, pad.h));
      const layer = pad.layers[0]!;
      for (const [x, y] of spots) {
        let [ax, ay] = [x, y];
        if (pad.shape === 'round') {
          // towards the nearest point of the pad's centre line (its centre, or along an oval)
          const c = padCapsule(pad);
          const [cx, cy] = [Math.max(c.ax, Math.min(c.bx, x)), Math.max(c.ay, Math.min(c.by, y))];
          const d = Math.hypot(x - cx, y - cy);
          const r = Math.max(0, c.r - sw / 2);
          if (d > r) [ax, ay] = [cx + ((x - cx) * r) / d, cy + ((y - cy) * r) / d];
        } else {
          const [hx, hy] = [Math.max(0, pad.w / 2 - sw / 2), Math.max(0, pad.h / 2 - sw / 2)];
          [ax, ay] = [Math.max(pad.x - hx, Math.min(pad.x + hx, x)), Math.max(pad.y - hy, Math.min(pad.y + hy, y))];
        }
        (out.stubs ??= []).push({ netId: g.netId, layer, width: sw, pts: [r3(ax), r3(ay), x, y] });
      }
      const current = g.amps ?? amps(g.netId);
      const need = current ? viasForCurrent(current, g.drill ?? rules.viaDrill) : 0;
      const note = need > spots.length ? `${spots.length} for ${r3(current!)} A, which wants ${need}: place more beside the pad` : current ? `enough for ${r3(current)} A` : undefined;
      out.groups.push({ id: g.id, netId: g.netId, kind: 'drop', wanted: spots.length, pad: name, ...(note ? { note } : {}) });
    } else if (g.kind === 'tie') {
      // as many as the current wants, in a tight block round the spot (as square as can be), then
      // the spots round it in case some are blocked
      const [cx, cy] = g.points?.[0] ?? [w / 2, h / 2];
      const current = g.amps ?? amps(g.netId);
      const per = viaCurrentFor(g.drill ?? rules.viaDrill);
      const n = Math.max(TIE_MIN, Math.min(TIE_MAX, current ? Math.ceil(current / per - 1e-6) : TIE_MIN));
      const q = g.pitch || Math.ceil((size + rules.clearance) / 0.1 - 1e-6) * 0.1;
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const spots: [number, number, number][] = [];
      for (let j = -1; j <= rows; j++) {
        for (let i = -1; i <= cols; i++) {
          const x = cx + (i - (cols - 1) / 2) * q;
          const y = cy + (j - (rows - 1) / 2) * q;
          const ring = i < 0 || j < 0 || i >= cols || j >= rows ? 1 : 0;
          spots.push([x, y, ring * 1e3 + Math.hypot(x - cx, y - cy)]);
        }
      }
      spots.sort((a, b) => a[2] - b[2]);
      for (const [x, y] of spots) out.fill.push(via(Math.round(x * 10) / 10, Math.round(y * 10) / 10));
      (out.limits ??= {})[g.id] = n;
      const why = current ? `${n} for ${r3(current)} A (about ${Math.round(per * 10) / 10} A per ${g.drill ?? rules.viaDrill} mm via)` : `${n}: no current known (give amps, or the net's max_current)`;
      entry(n, why);
    } else if (g.kind === 'fence' && g.along) {
      (out.along ??= []).push({ group: g.id, netId: g.netId, line: g.along, pitch, drill: g.drill ?? rules.viaDrill, pad: size });
      out.groups.push({ id: g.id, netId: g.netId, kind: 'fence', wanted: 0, along: g.along });
    } else {
      const box = areaBox(g.area ?? {}, parts, w, h);
      if (!box) {
        entry(0, 'its parts are not on the board');
        continue;
      }
      const [x0, y0, x1, y1] = box;
      const spots: [number, number][] = [];
      // a grid stays inside the area (a via on its edge would stick out of a pour there); a fence
      // runs along the edge, in the copper round the area
      const inset = size / 2 + rules.clearance;
      if (g.kind === 'grid') for (const y of spread(y0 + inset, y1 - inset)) for (const x of spread(x0 + inset, x1 - inset)) spots.push([x, y]);
      else {
        // round the edge, corners once, no gap wider than the pitch
        const side = (ax: number, ay: number, bx: number, by: number) => {
          const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / pitch - 1e-6));
          for (let i = 0; i < n; i++) spots.push([ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n]);
        };
        side(x0, y0, x1, y0);
        side(x1, y0, x1, y1);
        side(x1, y1, x0, y1);
        side(x0, y1, x0, y0);
      }
      for (const [x, y] of spots) out.fill.push(via(x, y));
      // stitching a supply's copper: say what its vias carry against what the net draws
      const current = g.kind === 'grid' ? amps(g.netId) : undefined;
      const per = viaCurrentFor(g.drill ?? rules.viaDrill);
      const need = current ? Math.max(TIE_MIN, Math.ceil(current / per - 1e-6)) : 0;
      entry(spots.length, current && spots.length > 2 * need ? `${spots.length} spots carry about ${Math.round(spots.length * per)} A; the net draws ${current} A, which ${need} vias carry: a tie (add_vias kind tie) where the current crosses to the plane does the same with less copper drilled` : undefined);
    }
  }
  return out;
}

/** An area (under parts, with its margin, or a rectangle) on this placement, clamped to the board; null: nothing left of it. */
function areaBox(area: PlaneArea, parts: BoardPart[], w: number, h: number): [number, number, number, number] | null {
  let box: [number, number, number, number];
  if (area.rect) box = area.rect;
  else {
    const ps = parts.filter((p) => area.under?.includes(p.componentId));
    if (!ps.length) return null;
    const m = area.margin ?? PLANE_AREA_MARGIN;
    box = [Math.min(...ps.map((p) => p.courtyard.x)) - m, Math.min(...ps.map((p) => p.courtyard.y)) - m, Math.max(...ps.map((p) => p.courtyard.x + p.courtyard.w)) + m, Math.max(...ps.map((p) => p.courtyard.y + p.courtyard.h)) + m];
  }
  const r = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(w, box[2]), Math.min(h, box[3])].map(r3) as [number, number, number, number];
  return r[2] - r[0] < 1 || r[3] - r[1] < 1 ? null : r;
}

function placePlanes(planes: ReturnType<typeof settingsPlanes>, parts: BoardPart[], w: number, h: number): BoardView['planes'] {
  const out: BoardView['planes'] = [];
  for (const pl of planes) {
    const { area, ...plane } = pl;
    if (!area) {
      out.push(plane);
      continue;
    }
    const r = areaBox(area, parts, w, h);
    if (!r) continue;
    const under = area.rect ? undefined : parts.filter((p) => area.under?.includes(p.componentId)).map((p) => p.refdes);
    out.push({ ...plane, area: r, ...(under ? { under } : {}) });
  }
  return out;
}
