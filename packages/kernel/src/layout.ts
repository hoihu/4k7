/**
 * Deterministic schematic auto-layout. The AI never positions anything; it only adds
 * constraints (left_of, above, …) that this solver respects.
 *
 * Strategy (M0):
 *  - Anchors (ICs, connectors, transistors) are placed in rows. Rows come from above/below
 *    constraints, order within a row from left_of/right_of constraints and signal flow.
 *  - Two-pin parts sharing a signal net with an anchor's left/right pin hang from that pin
 *    in columns ("satellites"). Columns are ordered bottom pin first, so wires never cross.
 *  - Two-pin parts between two power nets (decoupling) go in a row under their anchor.
 *  - Everything else is placed in a grid below, connected by net labels / power symbols.
 *  - Connections that are not drawn as wires are shown by net labels, so the drawing is
 *    always electrically complete and correct.
 */
import type {
  Component,
  Constraint,
  Design,
  LabelView,
  Net,
  PartCard,
  PinView,
  Point,
  Prim,
  Rect,
  SchematicView,
  SheetView,
  SymbolView,
  WireView,
} from '@tracewise/schema';
import { CHAR_W, GRID, isTwoPin, symbolFor, type SymbolDef } from '@tracewise/parts';
import { cardOf, componentsSorted, isGroundNet, isPowerNet, natCmp, netMembers, valueOf, type NetPin } from './doc.ts';

/* --------------------------------- scene ---------------------------------- */

interface Scene {
  symbols: SymbolView[];
  wires: WireView[];
  junctions: Point[];
  labels: LabelView[];
  noConnects: Point[];
}

const emptyScene = (): Scene => ({ symbols: [], wires: [], junctions: [], labels: [], noConnects: [] });
const grid = (v: number) => Math.ceil(v / GRID) * GRID;
const tw = (s: string) => s.length * CHAR_W;

function translatePrim(p: Prim, dx: number, dy: number): Prim {
  switch (p.t) {
    case 'rect':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'line':
      return { ...p, x1: p.x1 + dx, y1: p.y1 + dy, x2: p.x2 + dx, y2: p.y2 + dy };
    case 'poly':
      return { ...p, pts: p.pts.map((v, i) => v + (i % 2 ? dy : dx)) };
    case 'circle':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'path':
      return {
        ...p,
        d: p.d.replace(/^M(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/, (_, x, y) => `M${Number(x) + dx},${Number(y) + dy}`)
          .replace(/ Q(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/, (_, a, b, c, e) =>
            ` Q${Number(a) + dx},${Number(b) + dy} ${Number(c) + dx},${Number(e) + dy}`),
      };
  }
}

function translateScene(s: Scene, dx: number, dy: number): void {
  for (const sym of s.symbols) {
    sym.bbox = { ...sym.bbox, x: sym.bbox.x + dx, y: sym.bbox.y + dy };
    sym.prims = sym.prims.map((p) => translatePrim(p, dx, dy));
    sym.pins = sym.pins.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
    sym.refPos = { ...sym.refPos, x: sym.refPos.x + dx, y: sym.refPos.y + dy };
    sym.valuePos = { ...sym.valuePos, x: sym.valuePos.x + dx, y: sym.valuePos.y + dy };
    if (sym.origin) sym.origin = { x: sym.origin.x + dx, y: sym.origin.y + dy };
  }
  for (const w of s.wires) w.pts = w.pts.map((v, i) => v + (i % 2 ? dy : dx));
  for (const j of s.junctions) {
    j.x += dx;
    j.y += dy;
  }
  for (const l of s.labels) {
    l.x += dx;
    l.y += dy;
  }
  for (const n of s.noConnects) {
    n.x += dx;
    n.y += dy;
  }
}

function mergeScene(into: Scene, s: Scene): void {
  into.symbols.push(...s.symbols);
  into.wires.push(...s.wires);
  into.junctions.push(...s.junctions);
  into.labels.push(...s.labels);
  into.noConnects.push(...s.noConnects);
}

/** Rough extent of a label decoration, for spacing and bounding boxes. */
function labelRect(l: LabelView): Rect {
  const w = tw(l.text) + 80;
  if (l.kind === 'ground') {
    const ox = l.dir === 'left' ? -100 : l.dir === 'right' ? 100 : 0;
    return { x: l.x + ox - 80, y: l.y, w: 160, h: 260 };
  }
  switch (l.dir) {
    case 'right':
      return { x: l.x, y: l.y - 60, w: w + (l.kind === 'rail' ? 100 : 0), h: 120 + (l.kind === 'rail' ? 200 : 0) };
    case 'left':
      return { x: l.x - w - (l.kind === 'rail' ? 100 : 0), y: l.y - 60, w: w + (l.kind === 'rail' ? 100 : 0), h: 120 + (l.kind === 'rail' ? 200 : 0) };
    case 'up':
      return { x: l.x - w / 2, y: l.y - 260, w, h: 260 };
    case 'down':
      return { x: l.x - w / 2, y: l.y, w, h: 260 };
    case 'on':
      return { x: l.x - w / 2, y: l.y - 110, w, h: 110 };
  }
}

function sceneBBox(s: Scene): Rect {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const add = (r: Rect) => {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  };
  const textRect = (p: SymbolView['refPos'], text: string): Rect => {
    const w = tw(text) + 20;
    return { x: p.anchor === 'end' ? p.x - w : p.anchor === 'middle' ? p.x - w / 2 : p.x, y: p.y - 80, w, h: 100 };
  };
  for (const sym of s.symbols) {
    add(sym.bbox);
    add(textRect(sym.refPos, sym.refdes));
    add(textRect(sym.valuePos, sym.value));
  }
  for (const l of s.labels) add(labelRect(l));
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* -------------------------------- symbols --------------------------------- */

function makeSymbol(d: Design, c: Component, def: SymbolDef, ox: number, oy: number): SymbolView {
  const sym: SymbolView = {
    componentId: c.id,
    refdes: c.refdes,
    value: valueOf(d, c),
    bbox: { ...def.bbox },
    prims: def.prims.map((p) => ({ ...p })) as Prim[],
    pins: def.pins.map((p) => ({ ...p })) as PinView[],
    refPos: { ...def.refPos },
    valuePos: { ...def.valuePos },
  };
  const s = emptyScene();
  s.symbols.push(sym);
  translateScene(s, ox, oy);
  return sym;
}

/** Width a vertical two-pin satellite needs for its body and text. */
function satWidth(d: Design, c: Component, bottomLabel?: string): number {
  const text = Math.max(tw(c.refdes), tw(valueOf(d, c)));
  const below = bottomLabel ? tw(bottomLabel) / 2 + 80 : 0;
  return Math.max(300, grid(Math.max(140 + text + 140, below + 100))); // own text + the next part's plate
}

/* ------------------------------- decorations ------------------------------ */

type Dir = LabelView['dir'];

function deco(net: Net, x: number, y: number, dir: Dir): LabelView {
  const kind: LabelView['kind'] = isGroundNet(net) ? 'ground' : isPowerNet(net) ? 'rail' : 'net';
  return { x, y, text: net.name, netId: net.id, kind, dir };
}

/** Horizontal room a decoration at a left/right pin end needs. */
function decoWidth(net: Net | undefined): number {
  if (!net) return 0;
  if (isGroundNet(net)) return 200;
  return tw(net.name) + 80 + (isPowerNet(net) ? 100 : 0);
}

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
  const twoPins = comps.filter((c) => isTwoPin(cardFor(c)) && !inBridge.has(c.id));

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
    const side = sideHint(directional, c.id, anchors);
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
    for (const a of anchors) {
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
    let owner = rail && decapOwner(d, anchors, rail.id);
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
  for (const [ri, row] of rows.entries()) {
    const cells = row.map((a) => buildCell(ctx, plans.get(a.id)!));
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
      x += bb.w + 600;
      rowBottom = Math.max(rowBottom, rowTop + topExtent + bb.y + bb.h);
      mergeScene(scene, cell);
    }
    maxRight = Math.max(maxRight, x);
    rowTop = grid(rowBottom + 600);
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
    scene.labels.push(deco(net, p.x, p.y, dir));
    if (p.side === 'right') gapRight = Math.max(gapRight, decoWidth(net) + 100);
    if (p.side === 'left') gapLeft = Math.max(gapLeft, decoWidth(net) + 100);
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
