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
import { PAGE, parseAs, type Component, type Constraint, type Design, type Net, type PageView, type PartCard, type Point, type Rect, type SchematicView, type SheetView, type SymbolView } from '@tracewise/schema';
import { isTwoPin, symbolFor, unitCount, uprightSymbol } from '@tracewise/parts';
import { cardOf, circuitSuppliedNets, componentsSorted, connectorRole, isGroundNet, isPowerNet, natCmp, netMembers, valueOf, type NetPin } from './doc.ts';
import { flowCell, planFlow, type FlowPlan } from './flow.ts';
import {
  addJunctions,
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
  /** Pins drawn on the opposite side (output connectors at the right edge face the circuit). */
  mirror?: boolean;
  /** Unit of a split symbol (big ICs): each unit is its own symbol with its own satellites. */
  unit?: number;
  /** A transistor's load, stacked on its drain/collector up to the rail (see planStack). */
  stack?: StackPlan;
}

/** A bit of wire between parts stacked in a column, so they do not crowd each other. */
const CHAIN_GAP = 200;

interface StackPlan {
  /** The transistor pin the stack stands on. */
  pin: string;
  /** Bottom first; parts with both ends on the same nets as a stack part sit beside it (a flyback diode). */
  items: { comp: Component; parallel: Component[] }[];
}

const anchorSymbol = (plan: AnchorPlan) => symbolFor(plan.card, false, { mirror: plan.mirror ?? false, ...(plan.unit !== undefined ? { unit: plan.unit } : {}) });

interface Ctx {
  d: Design;
  members: Map<string, NetPin[]>;
}

export function layoutSchematic(d: Design): SchematicView {
  const ctx: Ctx = { d, members: netMembers(d) };
  const sheets = Object.values(d.sheets).sort((a, b) => a.order - b.order);
  const views: SheetView[] = sheets.map((s) => layoutSheet(ctx, s.id, s.name));
  // pages are numbered through the whole design, as on a printout
  let n = 0;
  for (const v of views) for (const p of v.pages) p.number = ++n;
  return { sheets: views, constraintStatus: evaluateConstraints(d, views) };
}

function layoutSheet(ctx: Ctx, sheetId: string, sheetName: string): SheetView {
  const { d } = ctx;
  const comps = componentsSorted(d).filter((c) => c.sheet === sheetId && cardOf(d, c.part));
  const cardFor = (c: Component) => cardOf(d, c.part)!;
  let anchors = comps.filter((c) => !isTwoPin(cardFor(c)));
  const bridges = findBridges(ctx, comps.filter((c) => isTwoPin(cardFor(c))));
  const inBridge = new Set(bridges.flatMap((b) => b.diodes.map((x) => x.comp.id)));
  // supply caps belong to the IC they serve, decided before the regulators claim parts
  const owners = supplyOwners(d, anchors, comps.filter((c) => isTwoPin(cardFor(c))));
  // regulators are drawn like datasheet reference designs (power flow); they claim their parts
  const flows = new Map<string, FlowPlan>();
  let unclaimed = comps.filter((c) => isTwoPin(cardFor(c)) && !inBridge.has(c.id));
  for (const a of anchors) {
    const plan = planFlow(ctx, a, unclaimed.filter((c) => (owners.get(c.id) ?? a.id) === a.id));
    if (!plan) continue;
    flows.set(a.id, plan);
    unclaimed = unclaimed.filter((c) => !plan.consumed.has(c.id));
  }
  // a transistor switching a load: the load stacks on its drain/collector up to the rail
  const stacks = new Map<string, StackPlan>();
  for (const a of anchors) {
    if (flows.has(a.id)) continue;
    const claimable = new Set([...unclaimed, ...anchors.filter((x) => x.id !== a.id && !flows.has(x.id) && !stacks.has(x.id))].filter((x) => cardFor(x).pins.length === 2).map((x) => x.id));
    const st = planStack(ctx, a, claimable);
    if (!st) continue;
    stacks.set(a.id, st);
    const taken = new Set(st.items.flatMap((i) => [i.comp.id, ...i.parallel.map((p) => p.id)]));
    unclaimed = unclaimed.filter((c) => !taken.has(c.id));
    anchors = anchors.filter((c) => !taken.has(c.id));
  }
  const twoPins = unclaimed;
  // other parts attach only to ICs drawn the ordinary way
  const attachable = anchors.filter((a) => !flows.has(a.id));

  const directional = Object.values(d.ledger).filter(
    (k) => k.a && k.b && (k.kind === 'left_of' || k.kind === 'right_of' || k.kind === 'above' || k.kind === 'below'),
  );

  // connectors that only carry supplies the circuit produces are outputs: right edge, mirrored
  const supplied = circuitSuppliedNets(d);
  const outputConn = new Set(anchors.filter((c) => cardFor(c).category === 'connector' && connectorRole(d, c, supplied) === 'output').map((c) => c.id));
  // one plan per symbol: split ICs get one per unit
  const unitPlans = new Map<string, AnchorPlan[]>(
    anchors.map((c) => {
      const card = cardFor(c);
      const n = unitCount(card);
      const make = (unit?: number): AnchorPlan => ({ comp: c, card, left: [], right: [], decaps: [], extraLeft: [], extraRight: [], mirror: outputConn.has(c.id), ...(unit !== undefined ? { unit } : {}), ...(stacks.has(c.id) ? { stack: stacks.get(c.id)! } : {}) });
      return [c.id, n > 1 ? Array.from({ length: n }, (_, u) => make(u)) : [make()]];
    }),
  );
  const plansOf = (id: string) => unitPlans.get(id) ?? [];
  const allPlans = () => [...unitPlans.values()].flat();
  const free: Component[] = [];

  /* ---- assign two-pin parts ---- */
  const netsOf = (c: Component) => cardFor(c).pins.map((p) => (c.pins[p.number] ? d.nets[c.pins[p.number]!] : undefined));
  const rest: Component[] = [];

  // pass 1: explicit side requests relative to an anchor, and signal satellites
  for (const c of twoPins) {
    const nets = netsOf(c);
    const side = sideHint(directional, c.id, attachable);
    if (side && unitPlans.has(side.anchor)) {
      const all = plansOf(side.anchor);
      const named = side.unit ? all.filter((p) => p.unit !== undefined && p.card.units?.[p.unit]?.name === side.unit) : [];
      const candidates = named.length ? named : all;
      let done = false;
      for (const plan of candidates) {
        const attach = findAttach(ctx, plan, c, nets, side.side);
        if (attach) {
          plan[side.side].push(attach);
          done = true;
          break;
        }
      }
      if (!done) (side.side === 'left' ? candidates[0]!.extraLeft : candidates[0]!.extraRight).push(c);
      continue;
    }
    if (nets.every((n) => n && isPowerNet(n))) {
      rest.push(c);
      continue;
    }
    let attached = false;
    // a part on a transistor's control pin belongs to the transistor (its gate drive), not to
    // the IC or connector the signal comes from
    const onControl = (plan: AnchorPlan) => {
      if (plan.card.category !== 'transistor') return false;
      const g = anchorSymbol(plan).pins.find((p) => p.side === 'left');
      return !!g && nets.some((n) => n?.id === plan.comp.pins[g.number]);
    };
    const order = attachable.flatMap((a) => plansOf(a.id)).sort((a, b) => Number(onControl(b)) - Number(onControl(a)));
    for (const plan of order) {
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
  const sats = allPlans().flatMap((p) => [...p.left, ...p.right]);
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
    const decided = attachable.find((a) => a.id === owners.get(c.id));
    let owner = decided ?? (rail && decapOwner(d, attachable, rail.id));
    let target: AnchorPlan | undefined;
    if (owner && rail) {
      // the unit whose symbol has a pin on that rail (the power unit of a split IC)
      const own = plansOf(owner.id);
      target = own.find((p) => anchorSymbol(p).pins.some((pin) => owner!.pins[pin.number] === rail.id)) ?? own[0];
    } else if (rail) {
      target = allPlans().find((p) =>
        [...p.left, ...p.right].some((s) => [s.comp, ...s.chain].some((x) => Object.values(x.pins).includes(rail.id))),
      );
    }
    if (target) target.decaps.push(c);
    else free.push(c);
  }

  /* ---- rows and order of anchors ---- */
  // one layout node per symbol: split ICs contribute one node per unit
  const nodes: LayoutNode[] = anchors.flatMap((c) =>
    plansOf(c.id).map((p) => ({ key: p.unit === undefined ? c.id : `${c.id}#${p.unit}`, comp: c, plan: p })),
  );
  const rows = arrangeAnchors(d, nodes, directional);
  if (bridges.length && !rows.length) rows.push([]);

  /* ---- cells in rows; the pager flows them onto pages ---- */
  const cellRows: CellRow[] = [];
  for (let [ri, row] of rows.entries()) {
    const cells: Cell[] = row.map((n) => ({ scene: flows.has(n.comp.id) ? flowCell(ctx, flows.get(n.comp.id)!) : buildCell(ctx, n.plan), heads: [n.comp] }));
    // output connectors: one column at the right end of the row
    const outIdx = row.flatMap((n, i) => (outputConn.has(n.comp.id) ? [i] : []));
    const outColumn = outIdx.length ? stackCells(outIdx.map((i) => cells[i]!)) : null;
    for (const i of [...outIdx].reverse()) cells.splice(i, 1);
    row = row.filter((n) => !outputConn.has(n.comp.id));
    // input (and other) connectors: one column where the first of them is
    const connectorIdx = row.flatMap((n, i) => (cardFor(n.comp).category === 'connector' ? [i] : []));
    if (connectorIdx.length > 1) {
      cells.splice(connectorIdx[0]!, 1, stackCells(connectorIdx.map((i) => cells[i]!)));
      for (const i of connectorIdx.slice(1).reverse()) cells.splice(i, 1);
      row = row.filter((_, i) => !connectorIdx.slice(1).includes(i));
    }
    if (ri === 0 && bridges.length) {
      // signal flow: connector → rectifier → the rest
      const after = row.findIndex((n) => anchorRank(d, n.comp) > 0);
      cells.splice(after < 0 ? cells.length : after, 0, ...bridges.map((b) => ({ scene: bridgeCell(ctx, b), heads: b.diodes.map((x) => x.comp) })));
    }
    if (outColumn) cells.push(outColumn);
    cellRows.push({ cells, gap: CELL_GAP });
  }
  // parts attached to nothing: a row of their own, close together
  if (free.length) cellRows.push({ cells: free.map((c) => ({ scene: freePart(ctx, c), heads: isTwoPin(cardFor(c)) ? [] : [c] })), gap: 200 });

  const { scene, pages } = paginate(d, cellRows);
  addJunctions(scene);
  const bb = pagesBBox(pages);
  return { id: sheetId, name: sheetName, bbox: bb, pages, ...scene };
}

/* --------------------------------- pages ---------------------------------- */

/** A block of the drawing that is never split: a regulator with its parts, an IC with its satellites… */
interface Cell {
  scene: Scene;
  /** The parts a page is named after. */
  heads: Component[];
}

/** Cells that belong on one logical row (from above/below constraints), in order. */
interface CellRow {
  cells: Cell[];
  gap: number;
}

/** Space between pages on the canvas. */
const PAGE_GAP = 600;
/** The drawing area of a page. */
const DRAW_W = PAGE.w - 2 * PAGE.margin;
const DRAW_H = PAGE.h - 2 * PAGE.margin - PAGE.title;

/**
 * Flow the cells onto pages: each row is broken into lines that fit the page width (order
 * kept), lines are stacked until the page is full, then the next page starts. A cell wider or
 * a line taller than the paper gets a page of its own, grown to fit (`oversized`). Pages sit
 * side by side on the canvas, so the sheet still reads as one drawing. There is always at
 * least one page, so an empty sheet shows its paper.
 */
function paginate(d: Design, rows: CellRow[]): { scene: Scene; pages: PageView[] } {
  interface Line {
    scene: Scene;
    heads: Component[];
    bbox: Rect;
  }
  // cells → lines (origins of the cells in a line are level, so IC bodies line up)
  const lines: Line[] = [];
  for (const row of rows) {
    let cur: Cell[] = [];
    let w = 0;
    const flush = () => {
      if (!cur.length) return;
      const topExtent = Math.max(0, ...cur.map((c) => -sceneBBox(c.scene).y));
      const scene = emptyScene();
      let x = 0;
      for (const cell of cur) {
        const bb = sceneBBox(cell.scene);
        translateScene(cell.scene, x - bb.x, topExtent);
        x += bb.w + row.gap;
        mergeScene(scene, cell.scene);
      }
      lines.push({ scene, heads: cur.flatMap((c) => c.heads), bbox: sceneBBox(scene) });
      cur = [];
      w = 0;
    };
    for (const cell of row.cells) {
      const cw = sceneBBox(cell.scene).w;
      if (cur.length && w + row.gap + cw > DRAW_W) flush();
      w += (cur.length ? row.gap : 0) + cw;
      cur.push(cell);
    }
    flush();
  }

  // lines → pages
  const scene = emptyScene();
  const pages: PageView[] = [];
  let pageX = 0;
  let onPage: Line[] = [];
  let used = 0;
  const flushPage = () => {
    const wide = Math.max(0, ...onPage.map((l) => l.bbox.w));
    const oversized = wide > DRAW_W || used > DRAW_H;
    const rect: Rect = { x: pageX, y: 0, w: Math.max(PAGE.w, wide + 2 * PAGE.margin), h: Math.max(PAGE.h, used + 2 * PAGE.margin + PAGE.title) };
    let y = rect.y + PAGE.margin;
    for (const line of onPage) {
      translateScene(line.scene, rect.x + PAGE.margin - line.bbox.x, y - line.bbox.y);
      mergeScene(scene, line.scene);
      y = grid(y + line.bbox.h + CELL_GAP);
    }
    pages.push({ number: pages.length + 1, name: pageName(d, onPage.flatMap((l) => l.heads), onPage.flatMap((l) => l.scene.symbols)), rect, ...(oversized ? { oversized: true } : {}) });
    pageX += rect.w + PAGE_GAP;
    onPage = [];
    used = 0;
  };
  for (const line of lines) {
    const h = grid(line.bbox.h + CELL_GAP);
    if (onPage.length && used + h - CELL_GAP > DRAW_H) flushPage();
    used += h;
    onPage.push(line);
  }
  if (onPage.length) used -= CELL_GAP;
  flushPage();
  return { scene, pages };
}

/**
 * "U1 TPS54331DR, J1": the parts a page is built around, ICs first, then connectors, in refdes
 * order. A split IC whose units are not all on this page names the ones that are:
 * "U3 STM32F777NIH6 (B, G)".
 */
function pageName(d: Design, heads: Component[], symbols: SymbolView[]): string {
  const seen = new Set<string>();
  const conn = (c: Component) => Number(cardOf(d, c.part)!.category === 'connector');
  const names = heads
    .filter((c) => !seen.has(c.id) && seen.add(c.id))
    .sort((a, b) => conn(a) - conn(b) || natCmp(a.refdes, b.refdes))
    .map((c) => {
      const card = cardOf(d, c.part)!;
      const part = card.mpn ?? (card.id.startsWith('generic:') ? '' : card.id.split(':')[1] ?? '');
      const units = symbols.filter((s) => s.componentId === c.id && s.unit).map((s) => s.unit!).sort();
      const here = units.length && units.length < unitCount(card) ? ` (${unitRanges(units)})` : '';
      return `${c.refdes}${part ? ` ${part}` : ''}${here}`;
    });
  if (!names.length) return heads.length ? 'parts' : 'empty';
  return names.length > 4 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
}

/** ["A", "C", "D", "E"] → "A, C–E". */
function unitRanges(letters: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < letters.length; ) {
    let j = i;
    while (j + 1 < letters.length && letters[j + 1]!.charCodeAt(0) === letters[j]!.charCodeAt(0) + 1) j++;
    out.push(j > i + 1 ? `${letters[i]}–${letters[j]}` : letters.slice(i, j + 1).join(', '));
    i = j + 1;
  }
  return out.join(', ');
}

function pagesBBox(pages: PageView[]): Rect {
  const x0 = Math.min(...pages.map((p) => p.rect.x));
  const y0 = Math.min(...pages.map((p) => p.rect.y));
  const x1 = Math.max(...pages.map((p) => p.rect.x + p.rect.w));
  const y1 = Math.max(...pages.map((p) => p.rect.y + p.rect.h));
  const pad = 200;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

/** Stack cells vertically (their anchors share the local origin, so they line up). */
function stackCells(cells: Cell[]): Cell {
  const out = emptyScene();
  let y: number | null = null;
  for (const cell of cells) {
    const bb = sceneBBox(cell.scene);
    const dy: number = y === null ? 0 : y - bb.y;
    translateScene(cell.scene, 0, dy);
    y = bb.y + dy + bb.h + STACK_GAP;
    mergeScene(out, cell.scene);
  }
  return { scene: out, heads: cells.flatMap((c) => c.heads) };
}

/** Units of a split IC next to each other, top edges aligned (each unit's body starts at y = 0). */
function sideBySide(cells: Scene[]): Scene {
  if (cells.length === 1) return cells[0]!;
  const out = emptyScene();
  let x = 0;
  for (const cell of cells) {
    const bb = sceneBBox(cell);
    translateScene(cell, x - bb.x, 0);
    x += bb.w + CELL_GAP;
    mergeScene(out, cell);
  }
  return out;
}

/** Space between stacked cells (connectors). */
const STACK_GAP = 200;

/* ------------------------------ assignment -------------------------------- */

function sideHint(ks: Constraint[], compId: string, anchors: Component[]): { anchor: string; unit?: string; side: 'left' | 'right' } | undefined {
  const anchorIds = new Set(anchors.map((a) => a.id));
  for (const k of ks) {
    if (k.a === compId && anchorIds.has(k.b!) && (k.kind === 'left_of' || k.kind === 'right_of')) {
      return { anchor: k.b!, ...(k.bUnit ? { unit: k.bUnit } : {}), side: k.kind === 'left_of' ? 'left' : 'right' };
    }
    if (k.b === compId && anchorIds.has(k.a!) && (k.kind === 'left_of' || k.kind === 'right_of')) {
      return { anchor: k.a!, ...(k.aUnit ? { unit: k.aUnit } : {}), side: k.kind === 'left_of' ? 'right' : 'left' };
    }
  }
  return undefined;
}

/*
 * Who each supply part (a two-pin part between two supply nets, mostly decoupling caps) belongs
 * to: an IC whose datasheet asks for decoupling on that rail, else an IC with a power input on
 * it, else one with any pin on it; the regulator that produces the rail (through its inductor)
 * ranks below those, except for bulk caps (≥ 4.7 µF), which stay at the regulator's output.
 * Equal ranks (two regulators fed from the same input): the IC added most recently before the
 * part (parts are added together with their IC).
 */
function supplyOwners(d: Design, anchors: Component[], parts: Component[]): Map<string, string> {
  const owners = new Map<string, string>();
  const seq = (c: Component) => parseInt(c.id.replace(/^[a-z]+_/, ''), 36) || 0;
  const pinsOf = (c: Component) => cardOf(d, c.part)!.pins.map((p) => c.pins[p.number]);
  // what each regulator produces: its output pins' nets, and beyond an inductor on them
  const produces = new Map<string, Set<string>>();
  for (const a of anchors) {
    const card = cardOf(d, a.part)!;
    const outs = new Set(card.pins.filter((p) => p.type === 'pwr_out' && a.pins[p.number]).map((p) => a.pins[p.number]!));
    for (const n of [...outs]) {
      for (const l of parts) {
        if (cardOf(d, l.part)!.category !== 'inductor') continue;
        const [x, y] = pinsOf(l);
        const beyond = x === n ? y : y === n ? x : undefined;
        if (beyond && !isGroundNet(d.nets[beyond]!)) outs.add(beyond);
      }
    }
    if (outs.size) produces.set(a.id, outs);
  }
  for (const c of parts) {
    const nets = pinsOf(c).map((n) => (n ? d.nets[n] : undefined));
    if (!nets.every((n) => n && isPowerNet(n))) continue;
    const rail = nets.find((n) => n && !isGroundNet(n));
    if (!rail) continue;
    const bulk = (parseAs(c.params.capacitance, 'F') ?? 0) >= 4.7e-6;
    let best: { a: Component; score: number } | null = null;
    for (const a of anchors) {
      const card = cardOf(d, a.part)!;
      const pins = card.pins.filter((p) => a.pins[p.number] === rail.id);
      const names = new Set(pins.map((p) => p.name));
      let score = card.requirements?.some((r) => r.kind === 'decouple' && names.has(r.pin)) ? 4 : pins.some((p) => p.type === 'pwr_in') ? 3 : pins.length ? 2 : 0;
      if (produces.get(a.id)?.has(rail.id)) score = Math.max(score, bulk ? 5 : 1);
      if (!score) continue;
      if (!best || score > best.score) best = { a, score };
      else if (score === best.score) {
        // the IC added most recently before the part (else the first one after it)
        const s0 = seq(c);
        const key = (x: Component) => (seq(x) <= s0 ? s0 - seq(x) : 1e9 + seq(x) - s0);
        if (key(a) < key(best.a)) best = { a, score };
      }
    }
    if (best) owners.set(c.id, best.a.id);
  }
  return owners;
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
  return anchorSymbol(plan).pins.find((p) => p.number === pinNumber)?.side;
}

/** Find an anchor left/right pin sharing a non-power net with the part. */
function findAttach(ctx: Ctx, plan: AnchorPlan, c: Component, nets: (Net | undefined)[], onlySide?: 'left' | 'right'): Sat | undefined {
  const sym = anchorSymbol(plan);
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

/** A symbol to place: a component, or one unit of a split symbol. */
interface LayoutNode {
  key: string;
  comp: Component;
  plan: AnchorPlan;
}

/**
 * Rows via above/below, order within rows via left_of/right_of (topological, stable).
 * Constraints may name a single unit ("U3B"); without a unit they apply to every unit.
 */
function arrangeAnchors(d: Design, nodes: LayoutNode[], ks: Constraint[]): LayoutNode[][] {
  const unitName = (n: LayoutNode) => (n.plan.unit !== undefined ? n.plan.card.units?.[n.plan.unit]?.name : undefined);
  const keysFor = (compId: string, unit?: string): string[] => {
    const own = nodes.filter((n) => n.comp.id === compId);
    const named = unit ? own.filter((n) => unitName(n) === unit) : [];
    return (named.length ? named : own).map((n) => n.key);
  };
  const base = [...nodes].sort(
    (a, b) => anchorRank(d, a.comp) - anchorRank(d, b.comp) || natCmp(a.comp.refdes, b.comp.refdes) || (a.plan.unit ?? 0) - (b.plan.unit ?? 0),
  );

  const row = new Map(nodes.map((n) => [n.key, 0]));
  const vEdges: [string, string][] = [];
  const hEdges: [string, string][] = [];
  for (const k of ks) {
    const as = keysFor(k.a!, k.aUnit);
    const bs = keysFor(k.b!, k.bUnit);
    for (const a of as) {
      for (const b of bs) {
        if (a === b) continue;
        if (k.kind === 'above') vEdges.push([a, b]);
        if (k.kind === 'below') vEdges.push([b, a]);
        if (k.kind === 'left_of') hEdges.push([a, b]);
        if (k.kind === 'right_of') hEdges.push([b, a]);
      }
    }
  }
  // longest path layering (bounded iterations tolerate cycles)
  for (let it = 0; it < nodes.length; it++) {
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
  const rows: LayoutNode[][] = [];
  for (let r = 0; r < nRows; r++) {
    const members = base.filter((n) => row.get(n.key) === r);
    rows.push(topoOrder(members, hEdges));
  }
  return rows.filter((r) => r.length);
}

function topoOrder(members: LayoutNode[], edges: [string, string][]): LayoutNode[] {
  const inRow = new Set(members.map((m) => m.key));
  const es = edges.filter(([a, b]) => inRow.has(a) && inRow.has(b));
  const out: LayoutNode[] = [];
  const done = new Set<string>();
  while (out.length < members.length) {
    const next =
      members.find((m) => !done.has(m.key) && !es.some(([a, b]) => b === m.key && !done.has(a))) ??
      members.find((m) => !done.has(m.key))!; // cycle: fall back to default order
    out.push(next);
    done.add(next.key);
  }
  return out;
}

/* -------------------------------- stacks ---------------------------------- */

/**
 * A transistor switching a load (low side: N-MOSFET drain, NPN collector, on top of its symbol):
 * the two-pin parts from that pin up to a supply rail (or as far as the chain is private), each
 * taking the next net; parts with both ends on the same two nets as one of them (a flyback
 * diode across a buzzer or relay coil) go beside it. Stops where the net branches.
 */
function planStack(ctx: Ctx, anchor: Component, claimable: Set<string>): StackPlan | null {
  const { d, members } = ctx;
  const card = cardOf(d, anchor.part)!;
  if (card.category !== 'transistor') return null;
  const top = symbolFor(card).pins.find((p) => p.side === 'top');
  if (!top || !/^(D|DRAIN|C|COLLECTOR)$/i.test(top.name)) return null;
  const start = anchor.pins[top.number];
  if (!start || isPowerNet(d.nets[start]!)) return null;
  let net: string = start;
  const used = new Set([anchor.id]);
  const items: StackPlan['items'] = [];
  const otherNet = (c: Component, n: string) => Object.values(c.pins).find((x) => x !== n);
  for (let k = 0; k < 4; k++) {
    const here = [...new Map((members.get(net) ?? []).filter((m) => !used.has(m.comp.id)).map((m) => [m.comp.id, m.comp])).values()];
    if (!here.length) break;
    // everything else on this net must be part of the stack (else the chain is not private)
    const cands = here.filter((c) => {
      const o = otherNet(c, net);
      return claimable.has(c.id) && Object.keys(c.pins).length === 2 && o && !isGroundNet(d.nets[o]!);
    });
    if (cands.length !== here.length) break;
    const next = new Set(cands.map((c) => otherNet(c, net)!));
    if (next.size !== 1) break;
    // the load itself in the stack, diodes beside it
    const main = cands.find((c) => cardOf(d, c.part)!.category !== 'diode') ?? cands[0]!;
    items.push({ comp: main, parallel: cands.filter((c) => c !== main) });
    for (const c of cands) used.add(c.id);
    net = [...next][0]!;
    if (isPowerNet(d.nets[net]!)) break;
  }
  return items.length ? { pin: top.number, items } : null;
}

/** Draw a stack upward from (x, y), the pin of `net`; returns the top point and its net. */
function drawStack(ctx: Ctx, scene: Scene, plan: StackPlan, x: number, y: number, net: string): void {
  const { d } = ctx;
  for (const item of plan.items) {
    // a bit of wire from the pin or part below
    scene.wires.push({ netId: net, pts: [x, y, x, y - CHAIN_GAP] });
    y -= CHAIN_GAP;
    const card = cardOf(d, item.comp.part)!;
    const bottom = card.pins.find((p) => item.comp.pins[p.number] === net) ?? card.pins[0]!;
    // pin on the lower net at the bottom
    scene.symbols.push(makeSymbol(d, item.comp, uprightSymbol(card, bottom.number === card.pins[0]!.number), x, y - 200));
    const upper = Object.values(item.comp.pins).find((n) => n !== net) ?? net;
    // parts across it: to the right, clear of its name and value
    const label = Math.max(tw(item.comp.refdes), tw(valueOf(d, item.comp))) + 160;
    let px = x + grid(Math.max(400, label + 100));
    for (const par of item.parallel) {
      const pc = cardOf(d, par.part)!;
      const pb = pc.pins.find((p) => par.pins[p.number] === net) ?? pc.pins[0]!;
      scene.symbols.push(makeSymbol(d, par, uprightSymbol(pc, pb.number === pc.pins[0]!.number), px, y - 200));
      scene.wires.push({ netId: net, pts: [x, y, px, y] }, { netId: upper, pts: [x, y - 400, px, y - 400] });
      px += grid(Math.max(tw(par.refdes), tw(valueOf(d, par))) + 400);
    }
    y -= 400;
    net = upper;
  }
  // the rail (or the net the chain goes on to) on top
  scene.labels.push(deco(d.nets[net]!, x, y, 'up'));
}

/** A two-pin part lying horizontally centred on (cx, cy); `pin1Left` puts pin 1 on the left. */
function horizontalPart(d: Design, comp: Component, cx: number, cy: number, pin1Left: boolean): SymbolView {
  const card = cardOf(d, comp.part)!;
  const def = uprightSymbol(card);
  const s = makeSymbol(d, comp, def, cx, cy);
  const rot = pin1Left ? -90 : 90;
  const rad = (rot * Math.PI) / 180;
  s.rotation = rot;
  s.origin = { x: cx, y: cy };
  s.pins = def.pins.map((p) => ({ ...p, x: Math.round(cx + p.x * Math.cos(rad) - p.y * Math.sin(rad)), y: Math.round(cy + p.x * Math.sin(rad) + p.y * Math.cos(rad)) }));
  s.bbox = { x: cx - 200, y: cy - 100, w: 400, h: 200 };
  s.refPos = { x: cx, y: cy - 175, anchor: 'middle' };
  s.valuePos = { x: cx, y: cy - 90, anchor: 'middle' };
  return s;
}

/**
 * A transistor's control input drawn as a signal path to the left of its gate/base: the input
 * net's flag, the series resistor lying horizontally, and the parts to a supply (pull-down)
 * hanging from the node between it and the pin.
 */
function drawControl(ctx: Ctx, scene: Scene, pin: { x: number; y: number }, series: Sat, shunts: Sat[]): void {
  const { d } = ctx;
  const y = pin.y;
  let x = pin.x;
  for (const sh of shunts) {
    // far enough left that its name and value stay clear of what is to its right
    x -= grid(Math.max(300, Math.max(tw(sh.comp.refdes), tw(valueOf(d, sh.comp))) + 250));
    // hanging down from the gate wire, its far end's supply symbol below
    const card = cardOf(d, sh.comp.part)!;
    const topPin = card.pins.find((p) => sh.comp.pins[p.number] === sh.net) ?? card.pins[0]!;
    const sym = makeSymbol(d, sh.comp, uprightSymbol(card, topPin.number !== card.pins[0]!.number), x, y + 200);
    scene.symbols.push(sym);
    let upper = sh.net;
    let bottom = sym.pins.find((p) => p.side === 'bottom')!;
    let below = Object.values(sh.comp.pins).find((n) => n !== upper);
    for (const c of sh.chain) {
      const cc = cardOf(d, c.part)!;
      const tp = cc.pins.find((p) => c.pins[p.number] === below) ?? cc.pins[0]!;
      if (below) scene.wires.push({ netId: below, pts: [x, bottom.y, x, bottom.y + CHAIN_GAP] });
      const cs = makeSymbol(d, c, uprightSymbol(cc, tp.number !== cc.pins[0]!.number), x, bottom.y + CHAIN_GAP + 200);
      scene.symbols.push(cs);
      upper = below ?? upper;
      below = Object.values(c.pins).find((n) => n !== upper);
      bottom = cs.pins.find((p) => p.side === 'bottom')!;
    }
    if (below) scene.labels.push(deco(d.nets[below]!, bottom.x, bottom.y, 'down'));
  }
  // the series resistor: its input end to the left, the flag of the input net there
  const card = cardOf(d, series.comp.part)!;
  const input = Object.values(series.comp.pins).find((n) => n !== series.net)!;
  const right = shunts.length ? x - 300 : pin.x - 200;
  const cx = right - 200;
  scene.symbols.push(horizontalPart(d, series.comp, cx, y, series.comp.pins[card.pins[0]!.number] === input));
  scene.wires.push({ netId: series.net, pts: [right, y, pin.x, y] });
  scene.labels.push(deco(d.nets[input]!, cx - 200, y, 'left'));
}

/* --------------------------------- cells ---------------------------------- */

function buildCell(ctx: Ctx, plan: AnchorPlan): Scene {
  const { d, members } = ctx;
  const scene = emptyScene();
  const def = anchorSymbol(plan);
  const sym = makeSymbol(d, plan.comp, def, 0, 0);
  if (plan.unit !== undefined && plan.card.units?.[plan.unit]) sym.unit = plan.card.units[plan.unit]!.name;
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
  const supplyOf = (num: string) => {
    const id = plan.comp.pins[num];
    return id && !satsByPin.has(num) && !plan.comp.noConnect.includes(num) ? supplyDir(d.nets[id]!) : null;
  };
  const decorated = new Set<string>(); // stacked pins (repeated VDD) share one position
  if (plan.card.category === 'transistor') {
    // the control input as a signal path: input ▷── series R ──┬── gate, pull-downs from the node
    const g = sym.pins.find((p) => p.side === 'left');
    const list = g ? satsByPin.get(g.number) : undefined;
    const series = list?.find((x) => {
      const o = Object.values(x.comp.pins).find((n) => n !== x.net);
      return !x.chain.length && o && !isPowerNet(d.nets[o]!);
    });
    if (g && list && series) {
      satsByPin.delete(g.number);
      decorated.add(`${g.x},${g.y}`);
      drawControl(ctx, scene, g, series, list.filter((x) => x !== series));
    }
  }
  if (plan.stack) {
    // the transistor's load, stacked on its drain/collector
    const at = sym.pins.find((p) => p.number === plan.stack!.pin);
    if (at) {
      decorated.add(`${at.x},${at.y}`);
      drawStack(ctx, scene, plan.stack, at.x, at.y, plan.comp.pins[plan.stack.pin]!);
    }
  }

  /* neighbouring side pins on the same supply share one bus and one supply symbol */
  const bused = new Set<string>();
  for (const side of ['left', 'right'] as const) {
    const byPos = new Map<number, (typeof sym.pins)[number]>();
    for (const p of sym.pins.filter((x) => x.side === side).sort((a, b) => a.y - b.y)) {
      // one pin per position: the first with a connection (stacked pins share the position)
      const have = byPos.get(p.y);
      if (!have || (!plan.comp.pins[have.number] && plan.comp.pins[p.number])) byPos.set(p.y, p);
    }
    const column = [...byPos.values()];
    for (let i = 0; i < column.length; ) {
      const first = column[i]!;
      const dir = supplyOf(first.number);
      let j = i + 1;
      while (j < column.length && supplyOf(column[j]!.number) === dir && plan.comp.pins[column[j]!.number] === plan.comp.pins[first.number]) j++;
      const run = column.slice(i, j);
      i = j;
      if (!dir || run.length < 2) continue;
      const ys = run.map((p) => p.y);
      const [top, bottom] = [Math.min(...ys), Math.max(...ys)];
      // the symbol sits at the end of the bus; nothing may be in its way on this side
      const clear = column.every((p) => (dir === 'up' ? !(p.y < top && p.y >= top - 400) : !(p.y > bottom && p.y <= bottom + 400)));
      if (!clear) continue;
      const net = d.nets[plan.comp.pins[first.number]!]!;
      const busX = first.x + (side === 'left' ? -100 : 100);
      for (const p of run) {
        scene.wires.push({ netId: net.id, pts: [p.x, p.y, busX, p.y] });
        bused.add(`${p.x},${p.y}`);
        // T where a stub meets the bus; the far end is a plain corner
        if (p.y !== (dir === 'up' ? bottom : top)) scene.junctions.push({ x: busX, y: p.y });
      }
      scene.wires.push({ netId: net.id, pts: [busX, top, busX, bottom] });
      scene.labels.push(deco(net, busX, dir === 'up' ? top : bottom, dir));
      const w = 100 + Math.max(80, tw(net.name) / 2 + 20) + 100;
      if (side === 'right') gapRight = Math.max(gapRight, w);
      else gapLeft = Math.max(gapLeft, w);
    }
  }
  const rises = new Map<string, number>();
  const stubs = supplyStubs(
    sym.pins.filter((p) => !bused.has(`${p.x},${p.y}`)),
    supplyOf,
    rises,
  );
  for (const p of sym.pins) {
    const netId = plan.comp.pins[p.number];
    const net = netId ? d.nets[netId] : undefined;
    const at = `${p.x},${p.y}`;
    if (decorated.has(at) || bused.has(at)) continue;
    if (net || plan.comp.noConnect.includes(p.number)) decorated.add(at);
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
    scene.labels.push(deco(net, p.x, p.y, dir, stub, rises.get(p.number) ?? 0));
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
        // a pull-up (the far end a positive rail) stands above the wire with its rail on top,
        // where no pin above has parts whose wires would run through it
        const ends = [s.comp, ...s.chain];
        let far: string | undefined = s.net;
        for (const c of ends) far = Object.values(c.pins).find((n) => n !== far) ?? far;
        const height = ends.length * (400 + CHAIN_GAP) + 400;
        const up =
          !!far &&
          far !== s.net &&
          supplyDir(d.nets[far]!) === 'up' &&
          !sym.pins.some((q) => q.side === side && q.number !== p.number && satsByPin.has(q.number) && q.y < p.y && q.y >= p.y - height);
        if (up) {
          const attached = s.card.pins.find((pp) => s.comp.pins[pp.number] === s.net)!;
          const satSym = makeSymbol(d, s.comp, symbolFor(s.card, attached.number === s.card.pins[0]!.number), x, p.y - 200);
          scene.symbols.push(satSym);
          let top = satSym.pins.find((pp) => pp.side === 'top')!;
          let lower = s.net;
          let upper = Object.values(s.comp.pins).find((n) => n !== lower);
          for (const c of s.chain) {
            const card = cardOf(d, c.part)!;
            const bp = card.pins.find((pp) => c.pins[pp.number] === upper) ?? card.pins[0]!;
            if (upper) scene.wires.push({ netId: upper, pts: [x, top.y, x, top.y - CHAIN_GAP] });
            const cs = makeSymbol(d, c, symbolFor(card, bp.number === card.pins[0]!.number), x, top.y - CHAIN_GAP - 200);
            scene.symbols.push(cs);
            lower = upper ?? lower;
            upper = Object.values(c.pins).find((n) => n !== lower);
            top = cs.pins.find((pp) => pp.side === 'top')!;
          }
          if (upper) scene.labels.push(deco(d.nets[upper]!, top.x, top.y, 'up'));
          xs.push(x);
          if (side === 'right') x += width;
          continue;
        }
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
          if (upperNet) scene.wires.push({ netId: upperNet, pts: [x, y, x, y + CHAIN_GAP] });
          y += CHAIN_GAP;
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

  /* decoupling banks under everything so far: caps on the same rails share one wire on top and
     one below (a single rail symbol each), wrapped at the anchor's width so many caps on a big IC
     stay a block under it instead of one long row pushing the neighbours away */
  if (plan.decaps.length) {
    const bb = sceneBBox(scene);
    const rowW = Math.max(bb.x + bb.w, 2500);
    // higher potential on top, as verticalPart draws it
    const rank = (n?: Net) => (!n ? 1 : isGroundNet(n) ? 3 : isPowerNet(n) ? 0 : 2);
    const netsOf = (c: Component) => cardOf(d, c.part)!.pins.map((p) => (c.pins[p.number] ? d.nets[c.pins[p.number]!] : undefined));
    const flipped = (c: Component) => {
      const nets = netsOf(c);
      return rank(nets[1]) < rank(nets[0]);
    };
    const railsOf = (c: Component) => {
      const nets = netsOf(c);
      return flipped(c) ? [nets[1], nets[0]] : [nets[0], nets[1]];
    };
    const key = (c: Component) => railsOf(c).map((n) => n?.id ?? '').join('|');
    // same rails together, in first-seen order
    const order = [...new Set(plan.decaps.map(key))];
    const caps = [...plan.decaps].sort((a, b) => order.indexOf(key(a)) - order.indexOf(key(b)));
    let x = 0;
    let y = grid(bb.y + bb.h + 300) + 260 + 200; // room for the rail symbols above
    let bottom = y;
    let run: { key: string; rails: (Net | undefined)[]; top: Point[]; bot: Point[] } | null = null;
    const closeRun = () => {
      if (!run) return;
      [run.top, run.bot].forEach((pts, i) => {
        const net = run!.rails[i];
        if (pts.length < 2 || !net) return;
        const [a, b] = [pts[0]!, pts.at(-1)!];
        scene.wires.push({ netId: net.id, pts: [a.x, a.y, b.x, b.y] });
        for (const m of pts.slice(1, -1)) scene.junctions.push({ x: m.x, y: m.y });
      });
      run = null;
    };
    for (const c of caps) {
      const w = satWidth(d, c);
      const k = key(c);
      if (x > 0 && x + w > rowW) {
        closeRun();
        x = 0;
        y = grid(bottom + 100) + 260 + 100; // the next row's rail symbol above it
      }
      if (run && run.key !== k) closeRun();
      const card = cardOf(d, c.part)!;
      const [topNet, botNet] = railsOf(c);
      const sym = makeSymbol(d, c, symbolFor(card, flipped(c)), x, y);
      scene.symbols.push(sym);
      const tp = sym.pins.find((p) => p.side === 'top')!;
      const bp = sym.pins.find((p) => p.side === 'bottom')!;
      const first = !run;
      run ??= { key: k, rails: [topNet, botNet], top: [], bot: [] };
      for (const [p, net, dir, list] of [[tp, topNet, 'up', run.top], [bp, botNet, 'down', run.bot]] as const) {
        if (c.noConnect.includes(p.number)) scene.noConnects.push({ x: p.x, y: p.y });
        else if (net) {
          (list as Point[]).push({ x: p.x, y: p.y });
          if (first) scene.labels.push(deco(net, p.x, p.y, dir));
        }
      }
      const pb = sceneBBox(scene);
      bottom = Math.max(bottom, pb.y + pb.h);
      x += w;
    }
    closeRun();
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
  if (plan.card.category === 'transistor') {
    // a small stage reads as one circuit: its ground symbols on one level, the lowest one's
    const grounds = scene.labels.filter((l) => l.kind === 'ground' && l.dir === 'down' && !l.stub);
    const lowest = Math.max(...grounds.map((l) => l.y));
    for (const l of grounds) {
      if (l.y >= lowest) continue;
      scene.wires.push({ netId: l.netId, pts: [l.x, l.y, l.x, lowest] });
      l.y = lowest;
    }
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
  const n = unitCount(card);
  const plan = (unit?: number): AnchorPlan => ({ comp: c, card, left: [], right: [], decaps: [], extraLeft: [], extraRight: [], ...(unit !== undefined ? { unit } : {}) });
  return sideBySide(n > 1 ? Array.from({ length: n }, (_, u) => buildCell(ctx, plan(u))) : [buildCell(ctx, plan())]);
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

/**
 * Placement constraints are checked on the drawing. Parts on different pages of a sheet are
 * compared by page: the pages read left to right and top to bottom, so an earlier page counts
 * as both "left of" and "above" a later one.
 */
function evaluateConstraints(d: Design, sheets: SheetView[]): SchematicView['constraintStatus'] {
  const where = new Map<string, { sheet: string; page: number; bbox: Rect }>();
  for (const s of sheets) {
    const pageOf = (b: Rect) => {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      return s.pages.findIndex((p) => cx >= p.rect.x && cx <= p.rect.x + p.rect.w && cy >= p.rect.y && cy <= p.rect.y + p.rect.h);
    };
    for (const sym of s.symbols) {
      // a split IC occupies the union of its units
      if (sym.unit) where.set(`${sym.componentId}#${sym.unit}`, { sheet: s.id, page: pageOf(sym.bbox), bbox: sym.bbox });
      const prev = where.get(sym.componentId);
      const b = sym.bbox;
      if (!prev || prev.sheet !== s.id) where.set(sym.componentId, { sheet: s.id, page: pageOf(b), bbox: b });
      else {
        const x = Math.min(prev.bbox.x, b.x);
        const y = Math.min(prev.bbox.y, b.y);
        const r = Math.max(prev.bbox.x + prev.bbox.w, b.x + b.w);
        const bo = Math.max(prev.bbox.y + prev.bbox.h, b.y + b.h);
        prev.bbox = { x, y, w: r - x, h: bo - y };
        prev.page = Math.min(prev.page, pageOf(b));
      }
    }
  }
  const status: SchematicView['constraintStatus'] = {};
  for (const k of Object.values(d.ledger)) {
    if (!['left_of', 'right_of', 'above', 'below'].includes(k.kind)) {
      if (k.kind === 'near' || k.kind === 'layer') status[k.id] = 'not_applicable';
      continue;
    }
    const a = (k.aUnit && where.get(`${k.a}#${k.aUnit}`)) || where.get(k.a ?? '');
    const b = (k.bUnit && where.get(`${k.b}#${k.bUnit}`)) || where.get(k.b ?? '');
    if (!a || !b || a.sheet !== b.sheet) {
      status[k.id] = 'not_applicable';
      continue;
    }
    if (a.page !== b.page) {
      const before = k.kind === 'left_of' || k.kind === 'above';
      status[k.id] = (a.page < b.page) === before ? 'ok' : 'violated';
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
