/**
 * Power-flow layout for regulators, the way reference designs are drawn in datasheets:
 *
 *   VIN ──┬──┬──[ IC ]──SW──┬────┬──L──┬────┬──── VOUT
 *         C  C    │ │ │     D    │     C    R1
 *         │  │   GND SS COMP│    Cboot │    ├─ FB
 *   ──────┴──┴────┴──┴──┴───┴──────────┴────R2──  (common ground line)
 *
 * Input rail to the left, switch node → inductor → output rail to the right, every shunt part
 * dropping to one ground line underneath, pin-to-rail parts (bootstrap cap) bridging from their
 * pin up to the rail, pin-to-ground networks (soft-start, compensation) dropping from their pin.
 * Columns are ordered so that no wires cross. Detection is generic: an IC with a power input,
 * a power output and a ground pin (buck converters with an inductor, LDOs without).
 */
import type { Component, Design, Net, PartCard, PinView } from '@tracewise/schema';
import { isTwoPin, pinSide, symbolFor } from '@tracewise/parts';
import { cardOf, isGroundNet, isPowerNet, natCmp, type NetPin } from './doc.ts';
import { deco, decoWidth, emptyScene, grid, isNegativeRail, makeSymbol, satWidth, supplyDir, supplyStubs, tw, type Scene } from './scene.ts';

/** Wire between a tap on a column and its net label, so the label never sits on a part. */
const TAP_STUB = 200;

interface Ctx {
  d: Design;
  members: Map<string, NetPin[]>;
}

type Side = 'left' | 'right';

/** A column of two-pin parts stacked vertically. */
interface Column {
  parts: Component[];
  /** Net at the top of the first part. */
  top: string;
}

interface PinColumn extends Column {
  pin: string;
  side: Side;
  /** 'rail': the part bridges from the pin up to the rail; 'ground': the chain drops to ground. */
  kind: 'rail' | 'ground';
}

export interface FlowPlan {
  comp: Component;
  card: PartCard;
  inPin: string;
  outPin: string;
  inNet: string;
  swNet: string;
  outNet: string;
  gnd: string;
  inductor: Component | null;
  inShunts: Column[];
  swShunts: Column[];
  outShunts: Column[];
  pinCols: PinColumn[];
  consumed: Set<string>;
}

const two = (d: Design, c: Component) => cardOf(d, c.part)!.pins.map((p) => c.pins[p.number]);
const other = (d: Design, c: Component, net: string) => {
  const [a, b] = two(d, c);
  return a === net ? b : b === net ? a : undefined;
};

/**
 * Recognise a regulator around `anchor` and claim the two-pin parts that belong to its
 * reference drawing. Returns null when the IC is not a regulator or an arrangement
 * constraint asks for the compact drawing.
 */
export function planFlow(ctx: Ctx, anchor: Component, available: Component[]): FlowPlan | null {
  const { d } = ctx;
  const card = cardOf(d, anchor.part)!;
  if (card.category !== 'ic' || card.symbolLayout || card.units?.length) return null; // regulators, not MCUs
  if (Object.values(d.ledger).some((k) => k.kind === 'arrangement' && k.a === anchor.id && k.value === 'compact')) return null;

  const netOf = (num: string) => anchor.pins[num];
  const ground = card.pins.find((p) => netOf(p.number) && isGroundNet(d.nets[netOf(p.number)!]!));
  const input = card.pins.find((p) => p.type === 'pwr_in' && netOf(p.number) && !isGroundNet(d.nets[netOf(p.number)!]!) && pinSide(p) === 'left');
  const output = card.pins.find((p) => p.type === 'pwr_out' && netOf(p.number) && pinSide(p) === 'right');
  if (!ground || !input || !output) return null;
  const gnd = netOf(ground.number)!;
  const inNet = netOf(input.number)!;
  const swNet = netOf(output.number)!;
  if (inNet === swNet) return null;

  const pool = new Map(available.filter((c) => isTwoPin(cardOf(d, c.part)!)).map((c) => [c.id, c]));
  const consumed = new Set<string>();
  const take = (c: Component) => {
    pool.delete(c.id);
    consumed.add(c.id);
  };

  // series inductor: switch node → output rail
  const inductor =
    [...pool.values()].find((c) => {
      if (cardOf(d, c.part)!.category !== 'inductor') return false;
      const o = other(d, c, swNet);
      return !!o && o !== inNet && !isGroundNet(d.nets[o]!);
    }) ?? null;
  const outNet = inductor ? other(d, inductor, swNet)! : swNet;
  if (inductor) take(inductor);
  const rails = new Set([inNet, swNet, outNet]);

  /** Follow a chain of two-pin parts from `net` down to ground (max 3 parts). */
  const chainToGround = (first: Component, net: string): Component[] | null => {
    const chain = [first];
    let at = other(d, first, net);
    let prev = first;
    while (at && !isGroundNet(d.nets[at]!)) {
      if (chain.length >= 3 || rails.has(at)) return null;
      const here: string = at;
      const next = [...pool.values()].filter((c) => c !== prev && !chain.includes(c) && two(d, c).includes(here) && other(d, c, here) !== here);
      if (next.length !== 1) return null;
      chain.push(next[0]!);
      prev = next[0]!;
      at = other(d, prev, here);
    }
    return at ? chain : null;
  };

  // shunts hanging from each rail down to ground (claimed first: a feedback divider is a
  // shunt on the output rail, not a part of the VSNS pin)
  const shunts = (net: string): Column[] => {
    const out: Column[] = [];
    for (const c of [...pool.values()].sort((a, b) => shuntOrder(d, a) - shuntOrder(d, b) || natCmp(a.refdes, b.refdes))) {
      if (!pool.has(c.id) || !two(d, c).includes(net)) continue;
      const chain = chainToGround(c, net);
      if (chain) {
        out.push({ parts: chain, top: net });
        chain.forEach(take);
      }
    }
    return out;
  };
  const inShunts = shunts(inNet);
  const swShunts = inductor ? shunts(swNet) : [];
  const outShunts = shunts(outNet);

  // pin columns: parts hanging from signal pins (next to the IC)
  const pinCols: PinColumn[] = [];
  const sym = symbolFor(card, false, { first: [input.number, output.number] });
  const pinsBySide = (side: Side) => sym.pins.filter((p) => p.side === side && p.number !== input.number && p.number !== output.number);
  for (const side of ['left', 'right'] as Side[]) {
    // a pin-to-rail part lands on the rail segment right next to the IC
    const sideRails = side === 'left' ? [inNet] : [swNet];
    for (const p of pinsBySide(side)) {
      const net = netOf(p.number);
      if (!net || isPowerNet(d.nets[net]!)) continue;
      for (const c of [...pool.values()].sort((a, b) => natCmp(a.refdes, b.refdes))) {
        if (!pool.has(c.id) || !two(d, c).includes(net)) continue;
        const o = other(d, c, net);
        if (!o) continue;
        if (sideRails.includes(o)) {
          pinCols.push({ pin: p.number, side, kind: 'rail', parts: [c], top: o });
          take(c);
          continue;
        }
        const chain = chainToGround(c, net);
        if (chain) {
          pinCols.push({ pin: p.number, side, kind: 'ground', parts: chain, top: net });
          chain.forEach(take);
        }
      }
    }
  }
  // a bridge-to-rail column is only crossing-free if no drop-to-ground pin sits above it
  for (const col of pinCols.filter((c) => c.kind === 'rail')) {
    const y = sym.pins.find((p) => p.number === col.pin)!.y;
    const blocked = pinCols.some((g) => g.kind === 'ground' && g.side === col.side && sym.pins.find((p) => p.number === g.pin)!.y < y);
    if (blocked) {
      pinCols.splice(pinCols.indexOf(col), 1);
      for (const c of col.parts) {
        consumed.delete(c.id);
        pool.set(c.id, c);
      }
    }
  }

  return { comp: anchor, card, inPin: input.number, outPin: output.number, inNet, swNet, outNet, gnd, inductor, inShunts, swShunts, outShunts, pinCols, consumed };
}

/** Along a rail: single capacitors first (closest to the pin), then diodes, then networks (dividers). */
function shuntOrder(d: Design, c: Component): number {
  const cat = cardOf(d, c.part)!.category;
  return cat === 'capacitor' ? 0 : cat === 'diode' ? 1 : 2;
}

/* ---------------------------------- draw ----------------------------------- */

/** The end of a regulator rail is a supply by construction: an upright symbol (down if negative). */
function railEnd(n: Net, x: number, y: number) {
  return { x, y, text: n.name, netId: n.id, kind: 'rail' as const, dir: isNegativeRail(n) ? ('down' as const) : ('up' as const) };
}

const RISE = 400; // a vertical two-pin part spans 400 mils pin to pin
/** A bit of wire between stacked parts (less crowded); dropped where a column must fit a tight space. */
const GAP = 200;
/** Height of a column of `n` parts, pin to pin. */
const colH = (n: number, gap = GAP) => RISE * n + gap * Math.max(0, n - 1);

export function flowCell(ctx: Ctx, plan: FlowPlan): Scene {
  const { d, members } = ctx;
  const scene = emptyScene();
  const def = symbolFor(plan.card, false, { first: [plan.inPin, plan.outPin] });
  const ic = makeSymbol(d, plan.comp, def, 0, 0);
  scene.symbols.push(ic);
  const bodyW = def.bbox.w - 400;
  const pinAt = (num: string) => ic.pins.find((p) => p.number === num)!;
  const inP = pinAt(plan.inPin);
  const outP = pinAt(plan.outPin);
  const net = (id: string): Net => d.nets[id]!;
  const drops: { x: number; y: number }[] = []; // points to connect to the ground line

  /* ----- IC pins that are not part of the flow ----- */
  const colPins = new Set(plan.pinCols.map((c) => c.pin));
  let gapR = 200;
  let gapL = 200;
  const rises = new Map<string, number>();
  const stubs = supplyStubs(ic.pins, (num) => {
    const id = plan.comp.pins[num];
    const skip = num === plan.inPin || num === plan.outPin || colPins.has(num) || plan.comp.noConnect.includes(num);
    return id && !skip ? supplyDir(d.nets[id]!) : null;
  }, rises);
  for (const p of ic.pins) {
    if (p.number === plan.inPin || p.number === plan.outPin || colPins.has(p.number)) continue;
    if (plan.comp.noConnect.includes(p.number)) {
      scene.noConnects.push({ x: p.x, y: p.y });
      continue;
    }
    const id = plan.comp.pins[p.number];
    if (!id) continue;
    if (id === plan.gnd && p.side === 'bottom') {
      drops.push({ x: p.x, y: p.y });
      continue;
    }
    const dir = p.side === 'left' ? 'left' : p.side === 'right' ? 'right' : p.side === 'top' ? 'up' : 'down';
    const stub = stubs.get(p.number) ?? 100;
    scene.labels.push(deco(net(id), p.x, p.y, dir, stub, rises.get(p.number) ?? 0));
    if (p.side === 'right') gapR = Math.max(gapR, decoWidth(net(id), stub) + 100);
    if (p.side === 'left') gapL = Math.max(gapL, decoWidth(net(id), stub) + 100);
  }

  /** Draw a vertical stack of parts starting with its top pin at (x, y); returns the bottom pin. */
  const stack = (col: Column, x: number, y: number, labelTaps = true, gap = GAP): PinView => {
    let upper = col.top;
    let bottom: PinView | null = null;
    col.parts.forEach((c, i) => {
      if (i > 0 && gap) {
        // a bit of wire from the part above
        scene.wires.push({ netId: upper, pts: [x, y, x, y + gap] });
        y += gap;
      }
      const card = cardOf(d, c.part)!;
      const topPin = card.pins.find((pp) => c.pins[pp.number] === upper) ?? card.pins[0]!;
      const s = makeSymbol(d, c, symbolFor(card, topPin.number !== card.pins[0]!.number), x, y + RISE / 2);
      scene.symbols.push(s);
      bottom = s.pins.find((pp) => pp.side === 'bottom')!;
      const bNet = c.pins[bottom.number];
      // a tap between two parts that is also used elsewhere (the FB node) gets a label, on the
      // wire between them
      if (labelTaps && bNet && i < col.parts.length - 1 && tapUsedElsewhere(col, bNet)) {
        const ty = bottom.y + gap / 2;
        scene.junctions.push({ x: bottom.x, y: ty });
        scene.wires.push({ netId: bNet, pts: [bottom.x, ty, bottom.x + TAP_STUB, ty] });
        scene.labels.push(deco(net(bNet), bottom.x + TAP_STUB, ty, 'right'));
      }
      upper = bNet ?? '';
      y += RISE;
    });
    return bottom!;
  };
  /** A net between two parts of a column that is also used elsewhere gets a label (the FB node). */
  const tapUsedElsewhere = (col: Column, netId: string) => {
    const inColumn = new Set(col.parts.map((x) => x.id));
    return (members.get(netId) ?? []).some((m) => !inColumn.has(m.comp.id));
  };
  const colWidth = (col: Column) => {
    let w = Math.max(...col.parts.map((c) => satWidth(d, c)));
    let upper = col.top;
    for (const [i, c] of col.parts.entries()) {
      const lower = two(d, c).find((n) => n !== upper);
      if (lower && i < col.parts.length - 1 && tapUsedElsewhere(col, lower)) w = Math.max(w, grid(TAP_STUB + decoWidth(net(lower)) + 120));
      upper = lower ?? '';
    }
    return w;
  };
  const floorGrid = (v: number) => Math.max(0, Math.floor(v / 100) * 100);

  /**
   * Columns that end on the ground line are drawn once the line's height is known, so each
   * part can sit in the middle between its top connection and ground (no long tail wire).
   * `lead` is the wire that reaches the column top (from a pin), extended down to the part.
   */
  const toGround: { col: Column; x: number; y0: number; lead?: { net: string; pts: number[] } }[] = [];

  /** A part bridging from a pin up to the rail: centred between the two. */
  const bridge = (col: Column, x: number, yRail: number, p: PinView) => {
    // the gap only where it fits between the pin and the rail
    const gap = p.y - yRail >= colH(col.parts.length) ? GAP : 0;
    const off = floorGrid((p.y - yRail - colH(col.parts.length, gap)) / 2);
    if (off > 0) scene.wires.push({ netId: col.top, pts: [x, yRail, x, yRail + off] });
    const bottom = stack(col, x, yRail + off, true, gap);
    scene.wires.push({ netId: plan.comp.pins[(col as PinColumn).pin]!, pts: [p.x, p.y, x, p.y, x, bottom.y] });
  };

  /* ----- right side: pin columns, switch node, inductor, output rail ----- */
  const rightPins = plan.pinCols.filter((c) => c.side === 'right');
  const railCols = rightPins.filter((c) => c.kind === 'rail').sort((a, b) => pinAt(a.pin).y - pinAt(b.pin).y); // top first
  const gndCols = rightPins.filter((c) => c.kind === 'ground').sort((a, b) => pinAt(b.pin).y - pinAt(a.pin).y); // bottom first
  const yR = Math.min(outP.y, ...railCols.map((c) => pinAt(c.pin).y - RISE));
  const railPts: number[] = [outP.x, outP.y];
  let x = grid(outP.x + gapR);
  if (yR < outP.y) railPts.push(outP.x + 100, outP.y, outP.x + 100, yR);
  const taps: number[] = [];

  for (const col of railCols) {
    bridge(col, x, yR, pinAt(col.pin));
    taps.push(x);
    x += colWidth(col);
  }
  for (const col of gndCols) {
    const p = pinAt(col.pin);
    toGround.push({ col, x, y0: p.y, lead: { net: col.top, pts: [p.x, p.y, x, p.y] } });
    x += colWidth(col);
  }
  for (const col of plan.swShunts) {
    toGround.push({ col, x, y0: yR });
    taps.push(x);
    x += colWidth(col);
  }
  if (plan.inductor) {
    // horizontal on the rail: pin on the switch node to the left
    const card = cardOf(d, plan.inductor.part)!;
    const leftIsPin1 = plan.inductor.pins[card.pins[0]!.number] === plan.swNet;
    const def = symbolFor(card);
    const cx = x + 100; // its leads run along the rail, above the previous part's text
    const s = makeSymbol(d, plan.inductor, def, cx, yR);
    const rot = leftIsPin1 ? -90 : 90;
    const rad = (rot * Math.PI) / 180;
    s.rotation = rot;
    s.origin = { x: cx, y: yR };
    s.pins = def.pins.map((p) => ({ ...p, x: Math.round(cx + p.x * Math.cos(rad) - p.y * Math.sin(rad)), y: Math.round(yR + p.x * Math.sin(rad) + p.y * Math.cos(rad)) }));
    s.bbox = { x: cx - 200, y: yR - 100, w: 400, h: 200 };
    s.refPos = { x: cx, y: yR - 175, anchor: 'middle' };
    s.valuePos = { x: cx, y: yR - 90, anchor: 'middle' };
    scene.symbols.push(s);
    railPts.push(cx - 200, yR);
    scene.wires.push({ netId: plan.swNet, pts: railPts.splice(0) });
    railPts.push(cx + 200, yR);
    x = cx + 200 + Math.max(100, tw(s.value) / 2 - 100);
    x = grid(x);
  }
  for (const col of plan.outShunts) {
    toGround.push({ col, x, y0: yR });
    taps.push(x);
    x += colWidth(col);
  }
  const outEnd = x - 100; // the last column's margin is only needed for another part
  railPts.push(outEnd, yR);
  scene.wires.push({ netId: plan.outNet, pts: railPts });
  scene.labels.push(railEnd(net(plan.outNet), outEnd, yR));
  for (const tx of taps) scene.junctions.push({ x: tx, y: yR });

  /* ----- left side: pin columns and input rail ----- */
  const leftPins = plan.pinCols.filter((c) => c.side === 'left');
  const lRailCols = leftPins.filter((c) => c.kind === 'rail').sort((a, b) => pinAt(a.pin).y - pinAt(b.pin).y);
  const lGndCols = leftPins.filter((c) => c.kind === 'ground').sort((a, b) => pinAt(b.pin).y - pinAt(a.pin).y);
  const yL = Math.min(inP.y, ...lRailCols.map((c) => pinAt(c.pin).y - RISE));
  const inPts: number[] = [inP.x, inP.y];
  if (yL < inP.y) inPts.push(inP.x - 100, inP.y, inP.x - 100, yL);
  let lx = inP.x - gapL;
  let first = true;
  const place = (col: Column) => {
    const w = colWidth(col);
    lx = first ? grid(lx - w + 100) : lx - w; // text sits right of each part, towards the IC
    first = false;
    return lx;
  };
  const lTaps: number[] = [];
  for (const col of lRailCols) {
    const cx = place(col);
    bridge(col, cx, yL, pinAt(col.pin));
    lTaps.push(cx);
  }
  for (const col of lGndCols) {
    const p = pinAt(col.pin);
    const cx = place(col);
    toGround.push({ col, x: cx, y0: p.y, lead: { net: col.top, pts: [p.x, p.y, cx, p.y] } });
  }
  for (const col of plan.inShunts) {
    const cx = place(col);
    toGround.push({ col, x: cx, y0: yL });
    lTaps.push(cx);
  }
  const inEnd = Math.min(lx, inP.x - 200) - 100;
  inPts.push(inEnd, yL);
  scene.wires.push({ netId: plan.inNet, pts: inPts });
  scene.labels.push(railEnd(net(plan.inNet), inEnd, yL));
  for (const tx of lTaps) scene.junctions.push({ x: tx, y: yL });

  /* ----- the common ground line ----- */
  const deepest = Math.max(def.bbox.y + def.bbox.h, ...drops.map((p) => p.y), ...toGround.map((g) => g.y0 + colH(g.col.parts.length)));
  const yG = grid(deepest + 200);
  for (const g of toGround) {
    // centre the column between its top connection and the ground line
    const off = floorGrid((yG - g.y0 - colH(g.col.parts.length)) / 2);
    const lead = g.lead ? [...g.lead.pts] : [g.x, g.y0];
    if (off > 0) lead.push(g.x, g.y0 + off);
    if (lead.length >= 4) scene.wires.push({ netId: g.lead?.net ?? g.col.top, pts: lead });
    drops.push(stack(g.col, g.x, g.y0 + off));
  }
  if (drops.length) {
    const xs = [...new Set(drops.map((p) => p.x))].sort((a, b) => a - b);
    for (const p of drops) if (p.y < yG) scene.wires.push({ netId: plan.gnd, pts: [p.x, p.y, p.x, yG] });
    if (xs.length > 1) scene.wires.push({ netId: plan.gnd, pts: [xs[0]!, yG, xs[xs.length - 1]!, yG] });
    for (const gx of xs.slice(1, -1)) scene.junctions.push({ x: gx, y: yG });
    // one ground symbol, under the IC's ground pin
    const icGnd = drops.find((p) => Math.abs(p.x - bodyW / 2) <= bodyW / 2 + 200) ?? drops[0]!;
    scene.labels.push(deco(net(plan.gnd), icGnd.x, yG, 'down'));
  }
  return scene;
}
