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
  for (const sym of s.symbols) {
    add(sym.bbox);
    add({ x: sym.valuePos.x, y: sym.valuePos.y - 80, w: tw(sym.value) + 20, h: 100 });
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
  return Math.max(300, grid(Math.max(110 + text + 60, below + 100)));
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
  const twoPins = comps.filter((c) => isTwoPin(cardFor(c)));

  const directional = Object.values(d.ledger).filter(
    (k) => k.a && k.b && (k.kind === 'left_of' || k.kind === 'right_of' || k.kind === 'above' || k.kind === 'below'),
  );

  const plans = new Map<string, AnchorPlan>(
    anchors.map((c) => [c.id, { comp: c, card: cardFor(c), left: [], right: [], decaps: [], extraLeft: [], extraRight: [] }]),
  );
  const free: Component[] = [];

  /* ---- assign two-pin parts ---- */
  for (const c of twoPins) {
    const card = cardFor(c);
    const nets = card.pins.map((p) => c.pins[p.number]).map((id) => (id ? d.nets[id] : undefined));
    const side = sideHint(directional, c.id, anchors);

    // explicit side request relative to an anchor
    if (side && plans.has(side.anchor)) {
      const plan = plans.get(side.anchor)!;
      const attach = findAttach(ctx, plan, c, nets, side.side);
      if (attach) {
        plan[side.side].push(attach);
      } else if (side.side === 'left') plan.extraLeft.push(c);
      else plan.extraRight.push(c);
      continue;
    }

    const bothPower = nets.every((n) => n && isPowerNet(n));
    if (bothPower) {
      const rail = nets.find((n) => n && !isGroundNet(n)) ?? nets[0];
      const owner = rail && decapOwner(d, anchors, rail.id);
      if (owner) plans.get(owner.id)!.decaps.push(c);
      else free.push(c);
      continue;
    }

    let attached = false;
    for (const a of anchors) {
      const plan = plans.get(a.id)!;
      const at = findAttach(ctx, plan, c, nets);
      if (at) {
        const pinSide = pinSideOf(plan, at.anchorPin);
        (pinSide === 'left' ? plan.left : plan.right).push(at);
        attached = true;
        break;
      }
    }
    if (!attached) free.push(c);
  }

  /* ---- rows and order of anchors ---- */
  const rows = arrangeAnchors(d, anchors, directional);

  const scene = emptyScene();
  let rowTop = 0;
  let maxRight = 0;
  for (const row of rows) {
    const cells = row.map((a) => buildCell(ctx, plans.get(a.id)!));
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
        return { comp: c, card: cardOf(ctx.d, c.part)!, anchorPin: p.number, net: net.id };
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
        const width = satWidth(d, s.comp, otherNet?.name);
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
        else if (otherNet) scene.labels.push(deco(otherNet, bottom.x, bottom.y, 'down'));
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
