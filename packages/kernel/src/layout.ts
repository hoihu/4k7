/**
 * Deterministic schematic auto-layout. The AI never positions anything; it only adds
 * constraints (left_of, above, …) that this solver respects.
 *
 * Strategy (M0):
 *  - Anchors (ICs, connectors, transistors) are placed in rows. Rows come from above/below
 *    constraints, order within a row from left_of/right_of constraints and signal flow.
 *  - Two-pin parts sharing a signal net with an anchor's left/right pin hang from that pin
 *    in columns ("satellites"). Columns are ordered bottom pin first, so wires never cross.
 *  - Regulators (power in, power out, ground) are drawn like datasheet reference designs:
 *    input rail left, switch node / inductor / output rail right, shunts to one ground line.
 *  - Other two-pin parts between two power nets (decoupling) go in a row under their anchor.
 *  - Everything else is placed in a grid below, connected by net labels / power symbols.
 *  - Connections that are not drawn as wires are shown by net labels, so the drawing is
 *    always electrically complete and correct.
 */
import type { Component, Constraint, Design, Net, PartCard, Point, Rect, SchematicView, SheetView } from '@tracewise/schema';
import { isTwoPin, symbolFor } from '@tracewise/parts';
import { cardOf, componentsSorted, isGroundNet, isPowerNet, natCmp, netMembers, type NetPin } from './doc.ts';
import { flowCell, planFlow, type FlowPlan } from './flow.ts';
import {
  deco,
  decoWidth,
  supplyDir,
  supplyStubs,
  emptyScene,
  grid,
  makeSymbol,
  mergeScene,
  satWidth,
  sceneBBox,
  translateScene,
  tw,
  type Dir,
  type Scene,
} from './scene.ts';

/** Space between separate groups (e.g. a connector and a regulator), across and between rows. */
const CELL_GAP = 400;

/* --------------------------------- model ---------------------------------- */

interface Sat {
  comp: Component;
  card: PartCard;
  anchorPin: string;
  net: string;
  /** Series parts hanging below this one (e.g. R + C of a compensation network). */
  chain: Component[];
}

interface AnchorPlan {
  comp: Component;
  card: PartCard;
  left: Sat[];
  right: Sat[];
  decaps: Component[];
  extraLeft: Component[];
  extraRight: Component[];
}

interface Ctx {
  d: Design;
  members: Map<string, NetPin[]>;
}

export function layoutSchematic(d: Design): SchematicView {
  const ctx: Ctx = { d, members: netMembers(d) };
  const sheets = Object.values(d.sheets).sort((a, b) => a.order - b.order);
  const views: SheetView[] = sheets.map((s) => layoutSheet(ctx, s.id, s.name));
  return { sheets: views, constraintStatus: evaluateConstraints(d, views) };
}

function layoutSheet(ctx: Ctx, sheetId: string, sheetName: string): SheetView {
  const { d } = ctx;
  const comps = componentsSorted(d).filter((c) => c.sheet === sheetId && cardOf(d, c.part));
  const cardFor = (c: Component) => cardOf(d, c.part)!;
  const anchors = comps.filter((c) => !isTwoPin(cardFor(c)));
  const bridges = findBridges(ctx, comps.filter((c) => isTwoPin(cardFor(c))));
  const inBridge = new Set(bridges.flatMap((b) => b.diodes.map((x) => x.comp.id)));
  // regulators are drawn like datasheet reference designs (power flow); they claim their parts
  const flows = new Map<string, FlowPlan>();
  let unclaimed = comps.filter((c) => isTwoPin(cardFor(c)) && !inBridge.has(c.id));
  for (const a of anchors) {
    const plan = planFlow(ctx, a, unclaimed);
    if (!plan) continue;
    flows.set(a.id, plan);
    unclaimed = unclaimed.filter((c) => !plan.consumed.has(c.id));
  }
  const twoPins = unclaimed;
  // other parts attach only to ICs drawn the ordinary way
  const attachable = anchors.filter((a) => !flows.has(a.id));

  const directional = Object.values(d.ledger).filter(
    (k) => k.a && k.b && (k.kind === 'left_of' || k.kind === 'right_of' || k.kind === 'above' || k.kind === 'below'),
  );

  const plans = new Map<string, AnchorPlan>(
    anchors.map((c) => [c.id, { comp: c, card: cardFor(c), left: [], right: [], decaps: [], extraLeft: [], extraRight: [] }]),
  );
  const free: Component[] = [];

  /* ---- assign two-pin parts ---- */
  const netsOf = (c: Component) => cardFor(c).pins.map((p) => (c.pins[p.number] ? d.nets[c.pins[p.number]!] : undefined));
  const rest: Component[] = [];

  // pass 1: explicit side requests relative to an anchor, and signal satellites
  for (const c of twoPins) {
    const nets = netsOf(c);
    const side = sideHint(directional, c.id, attachable);
    if (side && plans.has(side.anchor)) {
      const plan = plans.get(side.anchor)!;
      const attach = findAttach(ctx, plan, c, nets, side.side);
      if (attach) plan[side.side].push(attach);
      else if (side.side === 'left') plan.extraLeft.push(c);
      else plan.extraRight.push(c);
      continue;
    }
    if (nets.every((n) => n && isPowerNet(n))) {
      rest.push(c);
      continue;
    }
    let attached = false;
    for (const a of attachable) {
      const plan = plans.get(a.id)!;
      const at = findAttach(ctx, plan, c, nets);
      if (at) {
        (pinSideOf(plan, at.anchorPin) === 'left' ? plan.left : plan.right).push(at);
        attached = true;
        break;
      }
    }
    if (!attached) rest.push(c);
  }

  // pass 2: chain series parts below a satellite when they share a private signal net
  const sats = [...plans.values()].flatMap((p) => [...p.left, ...p.right]);
  const tipNet = (s: Sat): string | undefined => {
    const last = s.chain.at(-1) ?? s.comp;
    const upper = s.chain.length ? s.chain.at(-2) ?? s.comp : undefined;
    const lastCard = cardFor(last);
    const topNet = upper ? lastCard.pins.map((p) => last.pins[p.number]).find((n) => n && Object.values(upper.pins).includes(n)) : s.net;
    return lastCard.pins.map((p) => last.pins[p.number]).find((n) => n && n !== topNet);
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of [...rest]) {
      const nets = netsOf(c);
      if (nets.every((n) => n && isPowerNet(n))) continue;
      for (const s of sats) {
        const n = tipNet(s);
        if (!n || isPowerNet(d.nets[n]!) || !nets.some((x) => x?.id === n)) continue;
        const members = ctx.members.get(n) ?? [];
        const tip = s.chain.at(-1) ?? s.comp;
        if (members.length !== 2 || !members.some((m) => m.comp.id === tip.id)) continue;
        s.chain.push(c);
        rest.splice(rest.indexOf(c), 1);
        changed = true;
        break;
      }
    }
  }

  // pass 3: decoupling caps to the anchor that uses the rail (directly or through its satellites)
  for (const c of rest) {
    const nets = netsOf(c);
    if (!nets.every((n) => n && isPowerNet(n))) {
      free.push(c);
      continue;
    }
    const rail = nets.find((n) => n && !isGroundNet(n)) ?? nets[0];
    let owner = rail && decapOwner(d, attachable, rail.id);
    if (!owner && rail) {
      const plan = [...plans.values()].find((p) =>
        [...p.left, ...p.right].some((s) => [s.comp, ...s.chain].some((x) => Object.values(x.pins).includes(rail.id))),
      );
      owner = plan?.comp;
    }
    if (owner) plans.get(owner.id)!.decaps.push(c);
    else free.push(c);
  }

  /* ---- rows and order of anchors ---- */
  const rows = arrangeAnchors(d, anchors, directional);
  if (bridges.length && !rows.length) rows.push([]);

  const scene = emptyScene();
  let rowTop = 0;
  let maxRight = 0;
  for (let [ri, row] of rows.entries()) {
    const cells = row.map((a) => (flows.has(a.id) ? flowCell(ctx, flows.get(a.id)!) : buildCell(ctx, plans.get(a.id)!)));
    // connectors stack in one column, one below the other, where the first of them is
    const connectorIdx = row.flatMap((a, i) => (cardFor(a).category === 'connector' ? [i] : []));
    if (connectorIdx.length > 1) {
      cells.splice(connectorIdx[0]!, 1, stackCells(connectorIdx.map((i) => cells[i]!)));
      for (const i of connectorIdx.slice(1).reverse()) cells.splice(i, 1);
      row = row.filter((_, i) => !connectorIdx.slice(1).includes(i));
    }
    if (ri === 0 && bridges.length) {
      // signal flow: connector → rectifier → the rest
      const after = row.findIndex((a) => anchorRank(d, a) > 0);
      cells.splice(after < 0 ? cells.length : after, 0, ...bridges.map((b) => bridgeCell(ctx, b)));
    }
    const topExtent = Math.max(0, ...cells.map((c) => -sceneBBox(c).y));
    let x = 0;
    let rowBottom = rowTop;
    for (const cell of cells) {
      const bb = sceneBBox(cell);
      translateScene(cell, x - bb.x, rowTop + topExtent);
      x += bb.w + CELL_GAP;
      rowBottom = Math.max(rowBottom, rowTop + topExtent + bb.y + bb.h);
      mergeScene(scene, cell);
    }
    maxRight = Math.max(maxRight, x);
    rowTop = grid(rowBottom + CELL_GAP);
  }

  /* ---- free parts ---- */
  if (free.length) {
    const wrap = Math.max(maxRight, 4000);
    let x = 0;
    let y = rowTop + 300;
    for (const c of free) {
      const part = freePart(ctx, c);
      const bb = sceneBBox(part);
      if (x > 0 && x + bb.w > wrap) {
        x = 0;
        y += 900;
      }
      translateScene(part, x - bb.x, y);
      x += bb.w + 200;
      mergeScene(scene, part);
    }
  }

  const bb = sceneBBox(scene);
  const pad = 400;
  return {
    id: sheetId,
    name: sheetName,
    bbox: { x: bb.x - pad, y: bb.y - pad, w: bb.w + 2 * pad, h: bb.h + 2 * pad },
    ...scene,
  };
}

/** Stack cells vertically (their anchors share the local origin, so they line up). */
function stackCells(cells: Scene[]): Scene {
  const out = emptyScene();
  let y: number | null = null;
  for (const cell of cells) {
    const bb = sceneBBox(cell);
    const dy: number = y === null ? 0 : y - bb.y;
    translateScene(cell, 0, dy);
    y = bb.y + dy + bb.h + STACK_GAP;
    mergeScene(out, cell);
  }
  return out;
}

/** Space between stacked cells (connectors). */
const STACK_GAP = 200;

/* ------------------------------ assignment -------------------------------- */

function sideHint(ks: Constraint[], compId: string, anchors: Component[]): { anchor: string; side: 'left' | 'right' } | undefined {
  const anchorIds = new Set(anchors.map((a) => a.id));
  for (const k of ks) {
    if (k.a === compId && anchorIds.has(k.b!) && (k.kind === 'left_of' || k.kind === 'right_of')) {
      return { anchor: k.b!, side: k.kind === 'left_of' ? 'left' : 'right' };
    }
    if (k.b === compId && anchorIds.has(k.a!) && (k.kind === 'left_of' || k.kind === 'right_of')) {
      return { anchor: k.a!, side: k.kind === 'left_of' ? 'right' : 'left' };
    }
  }
  return undefined;
}

/** The anchor a decoupling cap belongs to: datasheet requirement > power input > any pin. */
function decapOwner(d: Design, anchors: Component[], railId: string): Component | undefined {
  let best: Component | undefined;
  let bestScore = -1;
  for (const a of anchors) {
    const card = cardOf(d, a.part)!;
    const pins = card.pins.filter((p) => a.pins[p.number] === railId);
    if (!pins.length) continue;
    const names = new Set(pins.map((p) => p.name));
    const score = card.requirements?.some((r) => r.kind === 'decouple' && names.has(r.pin))
      ? 2
      : pins.some((p) => p.type === 'pwr_in')
        ? 1
        : 0;
    if (score > bestScore) {
      best = a;
      bestScore = score;
    }
  }
  return best;
}

function pinSideOf(plan: AnchorPlan, pinNumber: string) {
  return symbolFor(plan.card).pins.find((p) => p.number === pinNumber)?.side;
}

/** Find an anchor left/right pin sharing a non-power net with the part. */
function findAttach(ctx: Ctx, plan: AnchorPlan, c: Component, nets: (Net | undefined)[], onlySide?: 'left' | 'right'): Sat | undefined {
  const sym = symbolFor(plan.card);
  for (const net of nets) {
    if (!net || isPowerNet(net)) continue;
    for (const p of sym.pins) {
      if (p.side !== 'left' && p.side !== 'right') continue;
      if (onlySide && p.side !== onlySide) continue;
      if (plan.comp.pins[p.number] === net.id) {
        return { comp: c, card: cardOf(ctx.d, c.part)!, anchorPin: p.number, net: net.id, chain: [] };
      }
    }
  }
  return undefined;
}

function anchorRank(d: Design, c: Component): number {
  const card = cardOf(d, c.part)!;
  if (card.category === 'connector') return 0;
  if (card.pins.some((p) => p.type === 'pwr_out')) return 1;
  return 2;
}

/** Rows via above/below, order within rows via left_of/right_of (topological, stable). */
function arrangeAnchors(d: Design, anchors: Component[], ks: Constraint[]): Component[][] {
  const ids = new Set(anchors.map((a) => a.id));
  const base = [...anchors].sort((a, b) => anchorRank(d, a) - anchorRank(d, b) || natCmp(a.refdes, b.refdes));

  const row = new Map(anchors.map((a) => [a.id, 0]));
  const vEdges: [string, string][] = [];
  const hEdges: [string, string][] = [];
  for (const k of ks) {
    if (!ids.has(k.a!) || !ids.has(k.b!)) continue;
    if (k.kind === 'above') vEdges.push([k.a!, k.b!]);
    if (k.kind === 'below') vEdges.push([k.b!, k.a!]);
    if (k.kind === 'left_of') hEdges.push([k.a!, k.b!]);
    if (k.kind === 'right_of') hEdges.push([k.b!, k.a!]);
  }
  // longest path layering (bounded iterations tolerate cycles)
  for (let it = 0; it < anchors.length; it++) {
    let changed = false;
    for (const [upper, lower] of vEdges) {
      if (row.get(lower)! <= row.get(upper)!) {
        row.set(lower, row.get(upper)! + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const nRows = Math.max(0, ...row.values()) + 1;
  const rows: Component[][] = [];
  for (let r = 0; r < nRows; r++) {
    const members = base.filter((a) => row.get(a.id) === r);
    rows.push(topoOrder(members, hEdges));
  }
  return rows.filter((r) => r.length);
}

function topoOrder(members: Component[], edges: [string, string][]): Component[] {
  const inRow = new Set(members.map((m) => m.id));
  const es = edges.filter(([a, b]) => inRow.has(a) && inRow.has(b));
  const out: Component[] = [];
  const done = new Set<string>();
  while (out.length < members.length) {
    const next =
      members.find((m) => !done.has(m.id) && !es.some(([a, b]) => b === m.id && !done.has(a))) ??
      members.find((m) => !done.has(m.id))!; // cycle: fall back to default order
    out.push(next);
    done.add(next.id);
  }
  return out;
}

/* --------------------------------- cells ---------------------------------- */

function buildCell(ctx: Ctx, plan: AnchorPlan): Scene {
  const { d, members } = ctx;
  const scene = emptyScene();
  const def = symbolFor(plan.card);
  const sym = makeSymbol(d, plan.comp, def, 0, 0);
  scene.symbols.push(sym);
  const bodyW = def.bbox.w - 400;

  const satsByPin = new Map<string, Sat[]>();
  for (const s of [...plan.left, ...plan.right]) {
    satsByPin.set(s.anchorPin, [...(satsByPin.get(s.anchorPin) ?? []), s]);
  }
  for (const list of satsByPin.values()) list.sort((a, b) => natCmp(a.comp.refdes, b.comp.refdes));

  /* pin end decorations for pins without satellites */
  let gapRight = 200;
  let gapLeft = 200;
  const stubs = supplyStubs(sym.pins, (num) => {
    const id = plan.comp.pins[num];
    return id && !satsByPin.has(num) && !plan.comp.noConnect.includes(num) ? supplyDir(d.nets[id]!) : null;
  });
  for (const p of sym.pins) {
    const netId = plan.comp.pins[p.number];
    const net = netId ? d.nets[netId] : undefined;
    if (plan.comp.noConnect.includes(p.number)) {
      scene.noConnects.push({ x: p.x, y: p.y });
      continue;
    }
    if (!net) continue;
    const sats = satsByPin.get(p.number);
    if (sats) {
      // name the wire if the net continues beyond this pin and its satellites
      const local = new Set([plan.comp.id, ...sats.map((s) => s.comp.id)]);
      const elsewhere = (members.get(net.id) ?? []).some((m) => !local.has(m.comp.id));
      if (elsewhere) {
        const w = tw(net.name) + 100;
        if (p.side === 'right') gapRight = Math.max(gapRight, w);
        else gapLeft = Math.max(gapLeft, w);
      }
      continue;
    }
    const dir: Dir = p.side === 'left' ? 'left' : p.side === 'right' ? 'right' : p.side === 'top' ? 'up' : 'down';
    const stub = stubs.get(p.number) ?? 100;
    scene.labels.push(deco(net, p.x, p.y, dir, stub));
    if (p.side === 'right') gapRight = Math.max(gapRight, decoWidth(net, stub) + 100);
    if (p.side === 'left') gapLeft = Math.max(gapLeft, decoWidth(net, stub) + 100);
  }

  /* satellite columns */
  const placeColumns = (side: 'left' | 'right') => {
    const pins = sym.pins
      .filter((p) => p.side === side && satsByPin.has(p.number))
      .sort((a, b) => b.y - a.y); // bottom pin first → nearest column, no crossings
    const pinEndX = side === 'right' ? bodyW + 200 : -200;
    let x = side === 'right' ? grid(pinEndX + gapRight) : 0;
    let first = true;
    for (const p of pins) {
      const sats = satsByPin.get(p.number)!;
      const net = d.nets[plan.comp.pins[p.number]!]!;
      const xs: number[] = [];
      for (const s of sats) {
        const otherPin = s.card.pins.find((pp) => s.comp.pins[pp.number] !== s.net) ?? s.card.pins[1]!;
        const otherNet = s.comp.pins[otherPin.number] ? d.nets[s.comp.pins[otherPin.number]!] : undefined;
        const width = Math.max(satWidth(d, s.comp, otherNet?.name), ...s.chain.map((c) => satWidth(d, c, chainBottomNet(ctx, c, s)?.name)));
        if (side === 'left') {
          if (first) x = grid(pinEndX - gapLeft - width + 100);
          else x -= width;
        }
        first = false;
        // pin attached to the anchor net goes on top
        const flip = s.card.pins[0]!.number !== s.card.pins.find((pp) => s.comp.pins[pp.number] === s.net)!.number;
        const satDef = symbolFor(s.card, flip);
        const satSym = makeSymbol(d, s.comp, satDef, x, p.y + 200);
        scene.symbols.push(satSym);
        const bottom = satSym.pins.find((pp) => pp.side === 'bottom')!;
        if (s.comp.noConnect.includes(bottom.number)) scene.noConnects.push({ x: bottom.x, y: bottom.y });
        else if (otherNet && !s.chain.length) scene.labels.push(deco(otherNet, bottom.x, bottom.y, 'down'));
        // series parts continue straight down the same column
        let upperNet = otherNet?.id;
        let y = bottom.y;
        s.chain.forEach((c, i) => {
          const card = cardOf(d, c.part)!;
          const topPin = card.pins.find((pp) => c.pins[pp.number] === upperNet) ?? card.pins[0]!;
          const sym = makeSymbol(d, c, symbolFor(card, topPin.number !== card.pins[0]!.number), x, y + 200);
          scene.symbols.push(sym);
          const b = sym.pins.find((pp) => pp.side === 'bottom')!;
          const bNet = c.pins[b.number] ? d.nets[c.pins[b.number]!] : undefined;
          if (c.noConnect.includes(b.number)) scene.noConnects.push({ x: b.x, y: b.y });
          else if (bNet && i === s.chain.length - 1) scene.labels.push(deco(bNet, b.x, b.y, 'down'));
          upperNet = bNet?.id;
          y = b.y;
        });
        xs.push(x);
        if (side === 'right') x += width;
      }
      const far = side === 'right' ? Math.max(...xs) : Math.min(...xs);
      scene.wires.push({ netId: net.id, pts: [p.x, p.y, far, p.y] });
      for (const cx of xs) if (cx !== far) scene.junctions.push({ x: cx, y: p.y });
      const local = new Set([plan.comp.id, ...sats.map((s) => s.comp.id)]);
      if ((members.get(net.id) ?? []).some((m) => !local.has(m.comp.id))) {
        const nearest = side === 'right' ? Math.min(...xs) : Math.max(...xs);
        scene.labels.push({ x: (p.x + nearest) / 2, y: p.y, text: net.name, netId: net.id, kind: 'net', dir: 'on' });
      }
    }
  };
  placeColumns('right');
  placeColumns('left');

  /* decoupling row under everything so far */
  if (plan.decaps.length) {
    const bb = sceneBBox(scene);
    let x = 0;
    const y = grid(bb.y + bb.h + 300) + 260 + 200; // room for the rail symbols above
    for (const c of plan.decaps) {
      const part = verticalPart(ctx, c, x, y);
      mergeScene(scene, part);
      x += satWidth(d, c);
    }
  }

  /* explicit side placements */
  const bb = sceneBBox(scene);
  let lx = bb.x - 200;
  for (const c of plan.extraLeft) {
    const w = satWidth(d, c);
    lx -= w;
    mergeScene(scene, verticalPart(ctx, c, grid(lx), grid(def.bbox.h / 2) - 200));
  }
  let rx = bb.x + bb.w + 300;
  for (const c of plan.extraRight) {
    mergeScene(scene, verticalPart(ctx, c, grid(rx), grid(def.bbox.h / 2) - 200));
    rx += satWidth(d, c);
  }
  return scene;
}

/** Net at the bottom of a chained part (the one not shared with the part above). */
function chainBottomNet(ctx: Ctx, c: Component, s: Sat): Net | undefined {
  const card = cardOf(ctx.d, c.part)!;
  const idx = s.chain.indexOf(c);
  const above = idx === 0 ? s.comp : s.chain[idx - 1]!;
  const shared = new Set(Object.values(above.pins));
  const pin = card.pins.find((p) => c.pins[p.number] && !shared.has(c.pins[p.number]!));
  return pin ? ctx.d.nets[c.pins[pin.number]!] : undefined;
}

/** A vertical two-pin part centred at (cx, cy) with decorations on both ends. */
function verticalPart(ctx: Ctx, c: Component, cx: number, cy: number): Scene {
  const { d } = ctx;
  const card = cardOf(d, c.part)!;
  const nets = card.pins.map((p) => (c.pins[p.number] ? d.nets[c.pins[p.number]!] : undefined));
  // higher potential on top: rail above signal above ground
  const rank = (n?: Net) => (!n ? 1 : isGroundNet(n) ? 3 : isPowerNet(n) ? 0 : 2);
  const flip = rank(nets[1]) < rank(nets[0]);
  const scene = emptyScene();
  const sym = makeSymbol(d, c, symbolFor(card, flip), cx, cy);
  scene.symbols.push(sym);
  for (const p of sym.pins) {
    const idx = card.pins.findIndex((pp) => pp.number === p.number);
    const net = nets[idx];
    if (c.noConnect.includes(p.number)) scene.noConnects.push({ x: p.x, y: p.y });
    else if (net) scene.labels.push(deco(net, p.x, p.y, p.side === 'top' ? 'up' : 'down'));
  }
  return scene;
}

function freePart(ctx: Ctx, c: Component): Scene {
  const card = cardOf(ctx.d, c.part)!;
  if (isTwoPin(card)) return verticalPart(ctx, c, 0, 0);
  return buildCell(ctx, { comp: c, card, left: [], right: [], decaps: [], extraLeft: [], extraRight: [] });
}

/* ----------------------------- bridge rectifier ---------------------------- */

interface BridgeDiode {
  comp: Component;
  /** Edge of the diamond the diode sits on: anode vertex → cathode vertex. */
  edge: 'LT' | 'RT' | 'BL' | 'BR';
}

interface BridgeRect {
  diodes: BridgeDiode[];
  plus: string;
  minus: string;
  left: string;
  right: string;
}

/**
 * Find full-bridge rectifiers made of four two-pin diodes: two cathodes share the + net, two
 * anodes share the − net, and each AC net joins one anode and one cathode. Pin 1 of a diode
 * card is the cathode. Bridges with an `arrangement = inline` constraint are left alone.
 */
function findBridges(ctx: Ctx, twoPins: Component[]): BridgeRect[] {
  const { d } = ctx;
  const inline = new Set(Object.values(d.ledger).filter((k) => k.kind === 'arrangement' && k.value === 'inline').map((k) => k.a));
  const diodes = twoPins
    .filter((c) => cardOf(d, c.part)?.category === 'diode')
    .map((c) => {
      const card = cardOf(d, c.part)!;
      return { comp: c, k: c.pins[card.pins[0]!.number], a: c.pins[card.pins[1]!.number] };
    })
    .filter((x): x is { comp: Component; k: string; a: string } => !!x.k && !!x.a && x.k !== x.a);

  const used = new Set<string>();
  const out: BridgeRect[] = [];
  const plusNets = [...new Set(diodes.map((x) => x.k))].sort();
  for (const plus of plusNets) {
    const uppers = diodes.filter((x) => x.k === plus && !used.has(x.comp.id));
    for (let i = 0; i < uppers.length; i++) {
      for (let j = i + 1; j < uppers.length; j++) {
        const u1 = uppers[i]!;
        const u2 = uppers[j]!;
        if (used.has(u1.comp.id) || used.has(u2.comp.id) || u1.a === u2.a) continue;
        const l1s = diodes.filter((x) => x.k === u1.a && !used.has(x.comp.id));
        const l2s = diodes.filter((x) => x.k === u2.a && !used.has(x.comp.id));
        const pair = l1s.flatMap((l1) => l2s.filter((l2) => l2.a === l1.a && l2.comp.id !== l1.comp.id).map((l2) => [l1, l2] as const))
          .find(([l1]) => l1.a !== plus && l1.a !== u1.a && l1.a !== u2.a);
        if (!pair) continue;
        const [l1, l2] = pair;
        const members = [u1, u2, l1, l2];
        if (members.some((m) => inline.has(m.comp.id))) continue;
        for (const m of members) used.add(m.comp.id);
        // stable left/right: AC nets in name order
        const swap = natCmp(d.nets[u1.a]!.name, d.nets[u2.a]!.name) > 0;
        const [ul, ur, ll, lr] = swap ? [u2, u1, l2, l1] : [u1, u2, l1, l2];
        out.push({
          plus,
          minus: l1.a,
          left: ul.a,
          right: ur.a,
          diodes: [
            { comp: ul.comp, edge: 'LT' },
            { comp: ur.comp, edge: 'RT' },
            { comp: ll.comp, edge: 'BL' },
            { comp: lr.comp, edge: 'BR' },
          ],
        });
      }
    }
  }
  return out;
}

/** The classic diamond: diodes on the 45° edges, AC left/right, + top, − bottom. */
function bridgeCell(ctx: Ctx, b: BridgeRect): Scene {
  const { d } = ctx;
  const S = 500; // centre → vertex
  const V = { T: { x: 0, y: -S }, R: { x: S, y: 0 }, B: { x: 0, y: S }, L: { x: -S, y: 0 } };
  const EDGES = {
    LT: { from: V.L, to: V.T, rot: 45 },
    RT: { from: V.R, to: V.T, rot: -45 },
    BL: { from: V.B, to: V.L, rot: -45 },
    BR: { from: V.B, to: V.R, rot: 45 },
  } as const;
  const scene = emptyScene();

  for (const bd of b.diodes) {
    const e = EDGES[bd.edge];
    const cx = (e.from.x + e.to.x) / 2;
    const cy = (e.from.y + e.to.y) / 2;
    const card = cardOf(d, bd.comp.part)!;
    const def = symbolFor(card);
    const rad = (e.rot * Math.PI) / 180;
    const rot = (x: number, y: number) => ({ x: Math.round(cx + x * Math.cos(rad) - y * Math.sin(rad)), y: Math.round(cy + x * Math.sin(rad) + y * Math.cos(rad)) });
    const sym = makeSymbol(d, bd.comp, def, cx, cy);
    sym.rotation = e.rot;
    sym.origin = { x: cx, y: cy };
    sym.pins = def.pins.map((p) => ({ ...p, ...rot(p.x, p.y) }));
    const half = 215;
    sym.bbox = { x: cx - half, y: cy - half, w: 2 * half, h: 2 * half };
    const leftSide = cx < 0;
    const tx = leftSide ? cx - 200 : cx + 200;
    const anchor = leftSide ? 'end' : 'start';
    sym.refPos = { x: tx, y: cy - 15, anchor };
    sym.valuePos = { x: tx, y: cy + 75, anchor };
    scene.symbols.push(sym);

    // cathode → cathode vertex, anode → anode vertex (straight continuation of the 45° line)
    const [k, a] = [sym.pins[0]!, sym.pins[1]!];
    const kNet = bd.comp.pins[card.pins[0]!.number]!;
    const aNet = bd.comp.pins[card.pins[1]!.number]!;
    scene.wires.push({ netId: kNet, pts: [k.x, k.y, e.to.x, e.to.y] });
    scene.wires.push({ netId: aNet, pts: [a.x, a.y, e.from.x, e.from.y] });
  }

  const vertex: [Point, string, Dir][] = [
    [V.T, b.plus, 'up'],
    [V.B, b.minus, 'down'],
    [V.L, b.left, 'left'],
    [V.R, b.right, 'right'],
  ];
  for (const [p, net, dir] of vertex) {
    scene.junctions.push({ ...p });
    scene.labels.push(deco(d.nets[net]!, p.x, p.y, dir));
  }
  return scene;
}

/* ------------------------------ constraints ------------------------------- */

function evaluateConstraints(d: Design, sheets: SheetView[]): SchematicView['constraintStatus'] {
  const where = new Map<string, { sheet: string; bbox: Rect }>();
  for (const s of sheets) for (const sym of s.symbols) where.set(sym.componentId, { sheet: s.id, bbox: sym.bbox });
  const status: SchematicView['constraintStatus'] = {};
  for (const k of Object.values(d.ledger)) {
    if (!['left_of', 'right_of', 'above', 'below'].includes(k.kind)) {
      if (k.kind === 'near' || k.kind === 'layer') status[k.id] = 'not_applicable';
      continue;
    }
    const a = where.get(k.a ?? '');
    const b = where.get(k.b ?? '');
    if (!a || !b || a.sheet !== b.sheet) {
      status[k.id] = 'not_applicable';
      continue;
    }
    const A = a.bbox;
    const B = b.bbox;
    const ok =
      k.kind === 'left_of' ? A.x + A.w <= B.x :
      k.kind === 'right_of' ? A.x >= B.x + B.w :
      k.kind === 'above' ? A.y + A.h <= B.y :
      A.y >= B.y + B.h;
    status[k.id] = ok ? 'ok' : 'violated';
  }
  return status;
}
