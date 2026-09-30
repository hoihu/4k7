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
 *  - `position` constraints (the place op, dragging) pin a part; the placer never moves it.
 */
import {
  DEFAULT_BOARD,
  type BoardDiagnostic,
  type BoardPad,
  type BoardPart,
  type BoardView,
  type Component,
  type Constraint,
  type CopperLayer,
  type Design,
  type MountingHole,
  type PackageInfo,
  type PartCard,
  type RatsLine,
  type SchematicView,
  type StoredPlacement,
  type BoardCutout,
  cutoutBounds,
  cutoutDistance,
  cutoutPolygon,
  insideBoard,
  insidePolygon,
  placeCutout,
} from '@tracewise/schema';
import { footprintFor, isTwoPin, packageOf, type Footprint } from '@tracewise/parts';
import { cardOf, componentsSorted, isGroundNet, isPowerNet, natCmp, valueOf } from './doc.ts';
import { copperDrc, edgeDrc } from './drc.ts';
import { route } from './router.ts';

const SPACING = 0.3; // between courtyards
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
  /** Locked without a rotation: the placer still picks the rotation. */
  freeRot?: boolean;
  /** The user's choice for this part (a soft position constraint). */
  intent?: Constraint;
  /** Courtyard size at rotation 0, centred. */
  cw: number;
  ch: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const snap = (v: number) => Math.round(v / GRID_MM) * GRID_MM;

/** A local point rotated clockwise (y down) by a multiple of 90°. */
function rotate(x: number, y: number, rot: number): [number, number] {
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
  for (const comp of componentsSorted(d)) {
    const card = cardOf(d, comp.part);
    if (!card) continue;
    const pkg = packageOf(card, comp.params);
    const fp = pkg ? footprintFor(pkg, card.pins.map((p) => p.number)) : null;
    if (!pkg || !fp?.ok) {
      missing.push(comp.refdes);
      continue;
    }
    items.push({ comp, card, fp: fp.footprint, pkg: pkg.name, info: pkg, x: 0, y: 0, rot: 0, fixed: false, cw: fp.footprint.courtyard.w, ch: fp.footprint.courtyard.h });
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
  const padsOf = (it: Item) => it.fp.pads.map((p) => ({ pad: p, net: it.comp.pins[p.number] }));
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

  // decoupling caps → one supply pad each (nearest in the schematic sense: first free pad)
  const springs: { it: Item; to: Item; tx: number; ty: number; px: number; py: number; w: number }[] = [];
  const supplyPads = new Map<string, { it: Item; px: number; py: number; used: number }[]>();
  for (const it of items) {
    if (isTwoPin(it.card)) continue;
    for (const { pad, net } of padsOf(it)) {
      const pin = it.card.pins.find((p) => p.number === pad.number);
      if (!net || !pin || pin.type !== 'pwr_in' || isGroundNet(d.nets[net]!)) continue;
      supplyPads.set(net, [...(supplyPads.get(net) ?? []), { it, px: pad.x, py: pad.y, used: 0 }]);
    }
  }
  for (const it of items) {
    if (!isTwoPin(it.card) || it.card.category !== 'capacitor') continue;
    const ns = padsOf(it).map((p) => p.net);
    const rail = ns.find((n) => n && !isGroundNet(d.nets[n]!) && supplyPads.has(n));
    if (!rail || !ns.some((n) => n && isGroundNet(d.nets[n]!))) continue;
    const target = [...supplyPads.get(rail)!].sort((a, b) => a.used - b.used)[0]!;
    target.used++;
    const own = padsOf(it).find((p) => p.net === rail)!.pad;
    springs.push({ it, to: target.it, tx: target.px, ty: target.py, px: own.x, py: own.y, w: 3 });
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
  for (const s of springs) parent.set(s.it, s.to);
  for (const it of items) {
    if (parent.has(it)) continue;
    for (const supply of [false, true]) {
      let best: Item | undefined;
      for (const { net } of padsOf(it)) {
        if (!net || isGroundNet(d.nets[net]!) || isPowerNet(d.nets[net]!) !== supply) continue;
        for (const m of nets.get(net) ?? []) {
          const n = m.it.fp.pads.length;
          if (m.it === it || n <= it.fp.pads.length) continue;
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
    if (k.strength === 'hard') {
      it.fixed = true;
      it.freeRot = k.rot === undefined;
    } else it.intent = k;
  }
  // bigger parts first: a choice's anchor (always bigger) is in place before the part itself
  const bySize = [...items].sort((a, b) => b.fp.pads.length - a.fp.pads.length || natCmp(a.comp.refdes, b.comp.refdes));
  const anchorOf = (it: Item) => (it.intent?.rel ? byComp.get(it.intent.rel) : undefined);
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
  const applyIntents = () => {
    for (const it of bySize) {
      const k = it.intent;
      if (!k) continue;
      const a = anchorOf(it);
      if (k.rel && !a) continue; // the anchor is gone: the part stays where it is
      if (a) {
        const [ox, oy] = rotate(k.xMm ?? 0, k.yMm ?? 0, a.rot);
        it.x = a.x + ox;
        it.y = a.y + oy;
        if (k.rot !== undefined) it.rot = (((a.rot + k.rot) % 360) + 360) % 360;
      } else {
        it.x = k.xMm ?? it.x;
        it.y = k.yMm ?? it.y;
        if (k.rot !== undefined) it.rot = k.rot;
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
  const contain = (it: Item) => {
    if (it.fixed || !containing) return;
    const e = extent(it);
    it.x = Math.min(Math.max(it.x, margin + e.w / 2), outline.w - margin - e.w / 2);
    it.y = Math.min(Math.max(it.y, margin + e.h / 2), outline.h - margin - e.h / 2);
    if (shape) pushInside(it);
  };
  /** Into a free-form outline: moved inwards (up the distance field) until the courtyard is inside with the margin. */
  const pushInside = (it: Item) => {
    for (let k = 0; k < 16; k++) {
      const e = extent(it);
      let worst = { d: Infinity, x: 0, y: 0 };
      for (const [fx, fy] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [0, 0]] as const) {
        const x = it.x + (fx * e.w) / 2;
        const y = it.y + (fy * e.h) / 2;
        const d = insidePolygon(shape!, x, y);
        if (d < worst.d) worst = { d, x, y };
      }
      if (worst.d >= margin - 1e-6) return;
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
      const step = margin - worst.d + 0.1;
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
        if (pin) return [{ it, to: ic, tx: pin.pad.x, ty: pin.pad.y, px: pad.x, py: pad.y, w: 1 }];
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
  const planeNets = new Set(settingsPlanes(d, layers.length as 2 | 4).map((pl) => pl.netId));
  const clashes = (it: Item) => {
    const e = extent(it);
    return fixedItems.some((o) => {
      if (o === it) return false;
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

  /** Final clean-up: no overlaps, inside the outline, on the grid; a proposed outline grows if it must. */
  const settle = () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      for (let round = 0; round < 30; round++) {
        // stuck against the outline: spread in two dimensions now and then
        if (round % 10 === 9) {
          separate(items, 10);
          for (const it of items) contain(it);
        }
        separate(items, 40, true);
        for (const it of items) contain(it);
        for (const it of items) if (!it.fixed) snapItem(it);
        // settled: the spacing holds to within a grid step (what the strict separation leaves)
        if (!overlapping(items, SPACING - GRID_MM)) return;
      }
      if (userSize) return; // the user's size: overlaps show as DRC errors
      outline = { w: Math.ceil(outline.w * 1.1), h: Math.ceil(outline.h * 1.1) };
    }
  };

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
      // the proposed size: the relaxed cluster, spread until the parts cover at most DENSITY
      const partsArea = items.reduce((sum, it) => sum + (it.cw + SPACING) * (it.ch + SPACING), 0);
      const bb1 = bounds(items);
      const f = Math.sqrt(partsArea / DENSITY / Math.max((bb1.x1 - bb1.x0) * (bb1.y1 - bb1.y0), 1e-6));
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
    containing = true;
    applyIntents();
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
    }
    /*
     * … and then settle in close around it again: parts pushed away earlier (something was in
     * the way) would otherwise keep that distance for good. A short relaxation towards their
     * connections, the rest staying put, and the IC's small parts back at their pins.
     */
    if (followers.length) {
      const still = items.filter((it) => !followers.includes(it) && !it.fixed);
      for (const it of still) it.fixed = true;
      relax(followers, 60);
      hugCaps(new Set(followers));
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
  }
  settle();
  alignSimilar(items, contain);

  // locked parts outside a proposed outline widen it
  let w = outline.w;
  let h = outline.h;
  if (!userSize && items.some((it) => it.fixed)) {
    const b = bounds(items.filter((it) => it.fixed));
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
  const blocker = (id: string, x: number, y: number, cw: number, ch: number) => ({ comp: { refdes: `~${id}` }, x, y, rot: 0, fixed: true, cw, ch }) as unknown as Item;
  const keepOuts = () => [
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
  if ((holes.length || cutouts.length || cornerR > margin) && items.length) {
    for (let round = 0; round < 20; round++) {
      const blockers = keepOuts();
      const all = [...items, ...blockers];
      if (!overlapping(all)) break;
      separate(all, 40, true);
      for (const it of movable) snapItem(it);
      if (userSize) {
        const inside = (it: Item) => {
          const e = extent(it);
          it.x = Math.min(Math.max(it.x, margin + e.w / 2), w - margin - e.w / 2);
          it.y = Math.min(Math.max(it.y, margin + e.h / 2), h - margin - e.h / 2);
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
  }
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
      pin1: { x: r3(at.x), y: r3(at.y) },
      polarized: false,
      locked: true,
    };
  });

  /* ---- result ---- */
  const boardCutouts = cutouts.map((c) => placeCutout(c, w, h));
  const parts: BoardPart[] = [
    ...items.map((it) => {
      const pa = parent.get(it);
      return { ...toPart(d, it, layers), ...(pa ? { follows: pa.comp.refdes } : {}) };
    }),
    ...holeParts,
  ];
  const diagnostics = placementChecks(parts, w, h, rules.edgeClearance, { outline: { w, h }, cornerRadius: cornerR, shape }, boardCutouts);
  for (const ref of missing) {
    diagnostics.push({ code: 'DRC.NO_FOOTPRINT', severity: 'warning', message: `${ref} has no footprint (no package data); it is left off the board.`, entities: [ref] });
  }
  const planes = settingsPlanes(d, layers.length as 2 | 4);
  const placementKey = hash(JSON.stringify([w, h, cornerR, shape, boardCutouts, layers, rules, planes, parts.map((p) => [p.componentId, p.x, p.y, p.rot, p.pads.map((q) => q.netId ?? '')])]));
  return {
    outline: { w, h },
    layers,
    rules,
    parts,
    tracks: [],
    vias: [],
    zones: [],
    planes,
    ratsnest: ratsnest(parts),
    diagnostics,
    stats: { nets: 0, routed: 0, unrouted: 0, trackLength: 0, vias: 0 },
    missing,
    netNames: Object.fromEntries(Object.values(d.nets).map((n) => [n.id, n.name])),
    routing: settings.routed ? (settings.routed === placementKey ? 'done' : 'stale') : 'none',
    placementKey,
    sizeBy: userSize ? 'user' : 'proposal',
    cornerRadius: cornerR,
    shape,
    cutouts: boardCutouts,
  };
}

/** The placement to store (propose_layout, place, route): where every part is now. */
export function storedPlacement(b: BoardView): StoredPlacement {
  return {
    outline: { ...b.outline },
    parts: Object.fromEntries(b.parts.filter((p) => !p.componentId.startsWith('hole:')).map((p) => [p.componentId, { x: p.x, y: p.y, rot: p.rot }])),
  };
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

/** Place; route and check the copper when the route step was taken for this placement (or `route`). */
export function layoutBoard(d: Design, sch: SchematicView, opts: { budgetMs?: number; route?: boolean } = {}): BoardView {
  const b = placeBoard(d, sch);
  if (!b.parts.length || (b.routing !== 'done' && !opts.route)) return b;
  const powerNets = new Set(Object.values(d.nets).filter((n) => isPowerNet(n)).map((n) => n.id));
  const planes = settingsPlanes(d, b.layers.length as 2 | 4);
  const r = route({ outline: b.outline, layers: b.layers, rules: b.rules, parts: b.parts, powerNets, planes: planes.map(({ netId, layer }) => ({ netId, layer })), cornerRadius: b.cornerRadius, ...(b.shape ? { shape: b.shape } : {}), cutouts: b.cutouts, ...(opts.budgetMs ? { budgetMs: opts.budgetMs } : {}) });
  const routed: BoardView = {
    ...b,
    routing: 'done',
    tracks: r.tracks,
    vias: r.vias,
    zones: r.zones,
    planes,
    ratsnest: ratsnest(b.parts, r.connected),
    stats: {
      nets: r.netsTotal,
      routed: r.netsDone,
      unrouted: r.failed.length,
      trackLength: Math.round(r.tracks.reduce((s, t) => s + polyLength(t.pts), 0) * 10) / 10,
      vias: r.vias.length,
    },
  };
  const unrouted = new Map<string, number>();
  for (const f of r.failed) unrouted.set(f.netId, (unrouted.get(f.netId) ?? 0) + 1);
  const diags = [...b.diagnostics, ...copperDrc(routed), ...edgeDrc(routed)];
  for (const [netId, n] of unrouted) {
    const f = r.failed.find((x) => x.netId === netId)!;
    diags.push({
      code: 'DRC.UNROUTED',
      severity: 'error',
      message: `${n} connection${n > 1 ? 's' : ''} of ${d.nets[netId]?.name ?? netId} could not be routed.`,
      at: { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 },
      entities: [],
    });
  }
  if (r.timedOut) {
    diags.unshift({
      code: 'DRC.ROUTING_INCOMPLETE',
      severity: 'warning',
      message: `Routing stopped at its time budget with ${r.failed.length} connection${r.failed.length === 1 ? '' : 's'} left. A bigger board, 4 layers or pinning the main parts usually helps.`,
      entities: [],
    });
  }
  return { ...routed, diagnostics: diags };
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
function separate(items: Item[], passes: number, strict = false) {
  const sorted = [...items].sort((a, b) => natCmp(a.comp.refdes, b.comp.refdes));
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!;
      const ea = extent(a);
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j]!;
        if (a.fixed && b.fixed) continue;
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
          if (!a.fixed) {
            a.x = snap(a.x);
            a.y = snap(a.y);
          }
          if (!b.fixed) {
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
  const key = (it: Item) => `${r3(it.cw)}x${r3(it.ch)}/${it.rot % 180}`;
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
      if (a.fixed && b.fixed) continue;
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
    const net = it.comp.pins[p.number];
    return {
      number: p.number,
      x: r3(it.x + x),
      y: r3(it.y + y),
      w: swapped(it.rot) ? p.h : p.w,
      h: swapped(it.rot) ? p.w : p.h,
      shape: p.shape,
      ...(p.drill ? { drill: p.drill } : {}),
      ...(net ? { netId: net } : {}),
      layers: p.drill ? [...layers] : ['F.Cu'],
    };
  });
  const rect = (w: number, h: number) => {
    const [rw, rh] = swapped(it.rot) ? [h, w] : [w, h];
    return { x: r3(it.x - rw / 2), y: r3(it.y - rh / 2), w: rw, h: rh };
  };
  const [p1x, p1y] = rotate(it.fp.pin1.x, it.fp.pin1.y, it.rot);
  return {
    componentId: it.comp.id,
    refdes: it.comp.refdes,
    value: valueOf(d, it.comp),
    part: it.card.id,
    ...((it.comp.params.mpn ?? it.card.mpn) ? { mpn: it.comp.params.mpn ?? it.card.mpn } : {}),
    ...(it.card.manufacturer ? { manufacturer: it.card.manufacturer } : {}),
    pkg: it.pkg,
    pkgInfo: it.info,
    x: r3(it.x),
    y: r3(it.y),
    rot: it.rot,
    side: 'top',
    pads,
    body: rect(it.fp.body.w, it.fp.body.h),
    courtyard: rect(it.cw, it.ch),
    pin1: { x: r3(it.x + p1x), y: r3(it.y + p1y) },
    polarized: polarized(it.card),
    ...(it.card.topImage ? { topImage: { src: it.card.topImage.src, rot: it.card.topImage.rot } } : {}),
    locked: it.fixed,
    ...(it.intent ? { intent: it.intent.rel ? { anchor: anchorRef(d, it.intent.rel) } : {} } : {}),
  };
}

/**
 * Whether a part's orientation matters, so pin 1 is marked: not for two-pin resistors, capacitors,
 * inductors and crystals whose pins carry no polarity (+/−, anode/cathode); for everything else.
 */
function polarized(card: PartCard): boolean {
  if (card.pins.length !== 2 || !['resistor', 'capacitor', 'inductor', 'crystal'].includes(card.category)) return true;
  return card.pins.some((p) => /^([+−-]|a|k|anode|cathode)$/i.test(p.name));
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
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i]!;
    const A = a.courtyard;
    const hole = a.componentId.startsWith('hole:');
    const corners = [[A.x, A.y], [A.x + A.w, A.y], [A.x, A.y + A.h], [A.x + A.w, A.y + A.h]] as const;
    if (A.x < 0 || A.y < 0 || A.x + A.w > w || A.y + A.h > h || (outline.shape && !hole && corners.some(([x, y]) => insideBoard(outline, x, y) < 0))) {
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
      if (A.x < B.x + B.w - 1e-6 && B.x < A.x + A.w - 1e-6 && A.y < B.y + B.h - 1e-6 && B.y < A.y + A.h - 1e-6) {
        out.push({ code: 'DRC.COURTYARD_OVERLAP', severity: 'error', message: `${a.refdes} and ${b.refdes} overlap (courtyards).`, at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, entities: [a.refdes, b.refdes] });
      }
    }
  }
  return out;
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
  const supply = most((n) => isPowerNet(n) && !isGroundNet(n));
  if (supply) out.push({ netId: supply.id, layer: 'In2.Cu', auto: true });
  return out;
}

/** Planes in effect: the explicit ones from set_plane, else automatic. */
function settingsPlanes(d: Design, layers: 2 | 4): { netId: string; layer: CopperLayer; auto: boolean }[] {
  const explicit = d.board?.planes;
  if (!explicit) return autoPlanes(d, layers);
  const valid = new Set<CopperLayer>(layers === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu']);
  return explicit.filter((p) => valid.has(p.layer) && d.nets[p.netId]).map((p) => ({ ...p, auto: false }));
}
