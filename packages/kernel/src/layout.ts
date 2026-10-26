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
import { DEFAULT_PAPER, PAGE, paperOf, parseAs, type Component, type Constraint, type Design, type Net, type PageView, type PartCard, type Point, type Rect, type SchematicView, type SheetView, type SymbolView } from '@4k7/schema';
import { GRID, isTwoPin, symbolFor, unitCount, uprightSymbol } from '@4k7/parts';
import { cardOf, circuitSuppliedNets, componentsSorted, connectorRole, isGroundNet, isPowerNet, natCmp, netMembers, valueOf, type NetPin } from './doc.ts';
import { drawBlock, FRAME_PAD, FRAME_TITLE, type BlockNode } from './blocks.ts';
import { flowCell, planFlow, type FlowPlan } from './flow.ts';
import { tidyWires } from './tidy.ts';
import {
  addJunctions,
  deco,
  decoWidth,
  supplyDir,
  supplyStubs,
  emptyScene,
  grid,
  labelRect,
  leadEnd,
  makeSymbol,
  mergeScene,
  rotateSymbol,
  satWidth,
  sceneBBox,
  textRect,
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
  /**
   * The functional blocks of the sheet being drawn and their parts (blockAssignment); null: the
   * sheet has none, it is drawn the classic way; undefined: work them out. `frames: false` draws
   * the blocks without frames (parts added to a stored drawing).
   */
  blocks?: SheetBlocks | null;
  frames?: boolean;
}

/** What planOf decides for a set of parts. */
interface Planned {
  comps: Component[];
  flows: Map<string, FlowPlan>;
  bridges: BridgeRect[];
  unitPlans: Map<string, AnchorPlan[]>;
  free: Component[];
  pinned: Map<string, Pin>;
  placedTwoPins: Component[];
  outputConn: Set<string>;
  nodes: LayoutNode[];
  ordering: Constraint[];
  ordered: Set<string>;
  /** The IC or connector each small part is drawn with (by component id). */
  owners: Map<string, string>;
}

/** The agent's mirror choice for an IC or connector (constrain arrangement mirrored / unmirrored). */
function mirrorAsked(d: Design, compId: string): boolean | undefined {
  const k = Object.values(d.ledger).find((x) => x.kind === 'arrangement' && x.a === compId && (x.value === 'mirrored' || x.value === 'unmirrored'));
  return k ? k.value === 'mirrored' : undefined;
}

/**
 * The auto-layout's drawing of one sheet. With `only`, of those components alone (the parts a
 * stored drawing does not have yet): their connections to the others are not drawn.
 */
export function layoutSheetOf(d: Design, sheetId: string, only?: ReadonlySet<string>): SheetView {
  let dd = d;
  // the blocks are those of the whole sheet, so parts drawn on their own stay with their block
  let blocks = blockAssignment(d, sheetId);
  if (only) {
    const components = Object.fromEntries(Object.entries(d.components).filter(([id]) => only.has(id)));
    const ledger = Object.fromEntries(Object.entries(d.ledger).filter(([, k]) => (!k.a || only.has(k.a)) && (!k.b || only.has(k.b))));
    dd = { ...d, components, ledger };
    if (blocks) {
      const kept = blocks.blocks.map((b) => ({ ...b, ids: b.ids.filter((id) => only.has(id)), guessed: b.guessed.filter((id) => only.has(id)) })).filter((b) => b.ids.length);
      blocks = { blocks: kept, loose: blocks.loose.filter((id) => only.has(id)) };
    }
  }
  return layoutSheet({ d: dd, members: netMembers(dd), blocks, ...(only ? { frames: false } : {}) }, sheetId, d.sheets[sheetId]?.name ?? '');
}

export function layoutSchematic(d: Design): SchematicView {
  const ctx: Ctx = { d, members: netMembers(d) };
  const sheets = Object.values(d.sheets).sort((a, b) => a.order - b.order);
  const views: SheetView[] = sheets.map((s) => layoutSheet(ctx, s.id, s.name));
  // pages are numbered through the whole design, as on a printout
  let n = 0;
  for (const v of views) for (const p of v.pages) p.number = ++n;
  const { status, why } = evaluateConstraints(d, views);
  return { paper: d.paper ?? DEFAULT_PAPER, sheets: views, constraintStatus: status, ...(Object.keys(why).length ? { constraintWhy: why } : {}) };
}

/**
 * How the layout draws these parts (a sheet, or one functional block of it): the ICs and
 * connectors with the small parts each takes (satellites, decoupling, a transistor's load), the
 * regulators drawn in datasheet style, the bridges, and the parts attached to nothing.
 * `opts.mirrors`: whether a symbol (node key) is drawn mirrored, over the layout's own choice;
 * `opts.unpinned`: the old sch_position entries are ignored (a block arranges its own parts).
 */
function planOf(ctx: Ctx, comps: Component[], opts: { mirrors?: ReadonlyMap<string, boolean>; unpinned?: boolean } = {}): Planned {
  const { d } = ctx;
  const cardFor = (c: Component) => cardOf(d, c.part)!;
  let anchors = comps.filter((c) => !isTwoPin(cardFor(c)));
  // where the agent put parts (place_symbol): they stand exactly there, the rest flows around them
  const pinned = opts.unpinned ? new Map<string, Pin>() : placementsOf(d, comps);
  const placedTwoPins = comps.filter((c) => isTwoPin(cardFor(c)) && pinned.has(c.id));
  const bridges = findBridges(ctx, comps.filter((c) => isTwoPin(cardFor(c)) && !pinned.has(c.id)));
  const inBridge = new Set(bridges.flatMap((b) => b.diodes.map((x) => x.comp.id)));
  // supply caps belong to the IC they serve, decided before the regulators claim parts
  const owners = supplyOwners(d, anchors, comps.filter((c) => isTwoPin(cardFor(c))));
  // regulators are drawn like datasheet reference designs (power flow); they claim their parts
  const flows = new Map<string, FlowPlan>();
  let unclaimed = comps.filter((c) => isTwoPin(cardFor(c)) && !inBridge.has(c.id) && !pinned.has(c.id));
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
      const make = (unit?: number): AnchorPlan => {
        // placed: as the agent said, else a connector in the right half of its page faces left, like an output
        const key = nodeKey(c.id, n > 1 ? unit ?? 0 : undefined);
        const at = pinned.get(key);
        const mirror = opts.mirrors?.get(key) ?? mirrorAsked(d, c.id) ?? (at ? at.mirror ?? (card.category === 'connector' && at.x > paperOf(d.paper).w / 2) : outputConn.has(c.id));
        return { comp: c, card, left: [], right: [], decaps: [], extraLeft: [], extraRight: [], mirror, ...(unit !== undefined ? { unit } : {}), ...(stacks.has(c.id) ? { stack: stacks.get(c.id)! } : {}) };
      };
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
    // above/below an anchor: drawn with that anchor, at the pin they share, if they share one
    const level = directional.find((k) => k.a === c.id && (k.kind === 'above' || k.kind === 'below') && unitPlans.has(k.b!));
    const at = level && plansOf(level.b!).map((plan) => ({ plan, sat: findAttach(ctx, plan, c, nets) })).find((x) => x.sat);
    if (at) {
      (pinSideOf(at.plan, at.sat!.anchorPin) === 'left' ? at.plan.left : at.plan.right).push(at.sat!);
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
    if (betweenSupplies(nets)) {
      free.push(c); // drawn lying flat on its own (verticalPart)
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
    plansOf(c.id).map((p) => ({ key: nodeKey(c.id, p.unit), comp: c, plan: p })),
  );
  // a constraint moves its subject (a): with an anchor as subject and a small part as reference
  // ("J2 right of R4"), the anchor goes next to the anchor that part is drawn with; with a small
  // part as subject it was a request to draw it at an anchor (pass 1), not an order of anchors
  const drawnWith = new Map<string, { id: string; unit?: string }>();
  for (const plan of allPlans()) {
    const unit = plan.unit !== undefined ? plan.card.units?.[plan.unit]?.name : undefined;
    const parts = [...plan.left, ...plan.right].flatMap((x) => [x.comp, ...x.chain]).concat(plan.decaps, plan.extraLeft, plan.extraRight);
    for (const x of parts) drawnWith.set(x.id, { id: plan.comp.id, ...(unit ? { unit } : {}) });
  }
  const isAnchor = (id?: string) => !!id && unitPlans.has(id);
  const ordering = directional.flatMap((k): Constraint[] => {
    if (!isAnchor(k.a)) return [];
    if (isAnchor(k.b)) return [k];
    const owner = drawnWith.get(k.b!);
    if (!owner || owner.id === k.a) return [];
    const { bUnit: _, ...rest } = k;
    return [{ ...rest, b: owner.id, ...(owner.unit ? { bUnit: owner.unit } : {}) }];
  });
  // connectors ordered by a constraint keep their place in the row instead of joining a column
  const ordered = new Set(ordering.filter((k) => k.kind === 'left_of' || k.kind === 'right_of').flatMap((k) => [k.a!, k.b!]));
  // who each part is drawn with: the IC or connector (satellites, decoupling, a load, a regulator's parts)
  const drawnBy = new Map<string, string>();
  for (const plan of allPlans()) {
    const parts = [...plan.left, ...plan.right].flatMap((x) => [x.comp, ...x.chain]).concat(plan.decaps, plan.extraLeft, plan.extraRight, ...(plan.stack?.items.flatMap((i) => [i.comp, ...i.parallel]) ?? []));
    for (const x of parts) drawnBy.set(x.id, plan.comp.id);
  }
  for (const [id, f] of flows) for (const x of f.consumed) if (x !== id) drawnBy.set(x, id);
  return { comps, flows, bridges, unitPlans, free, pinned, placedTwoPins, outputConn, nodes, ordering, ordered, owners: drawnBy };
}

/**
 * The classic drawing of planned parts: the ICs and connectors in rows (above/below constraints),
 * ordered by left_of/right_of and signal flow, connectors in a column, the bridges after the
 * connectors, the parts attached to nothing in a row of their own; the placed ones stand apart.
 */
function classicRows(ctx: Ctx, p: Planned): { cellRows: CellRow[]; placed: Placed[] } {
  const { d } = ctx;
  const { flows, bridges, free, pinned, placedTwoPins, outputConn, nodes, ordering, ordered } = p;
  const cardFor = (c: Component) => cardOf(d, c.part)!;

  const rows = arrangeAnchors(d, nodes.filter((n) => !pinned.has(n.key)), ordering);
  if (bridges.length && !rows.length) rows.push([]);

  /* ---- cells in rows; the pager flows them onto pages ---- */
  const cellRows: CellRow[] = [];
  for (let [ri, row] of rows.entries()) {
    const cells: Cell[] = row.map((n) => ({ scene: stamp(flows.has(n.comp.id) ? flowCell(ctx, flows.get(n.comp.id)!) : buildCell(ctx, n.plan), n.plan), heads: [n.comp] }));
    // output connectors: one column at the right end of the row
    const outIdx = row.flatMap((n, i) => (outputConn.has(n.comp.id) && !ordered.has(n.comp.id) ? [i] : []));
    const outColumn = outIdx.length ? stackCells(outIdx.map((i) => cells[i]!)) : null;
    for (const i of [...outIdx].reverse()) cells.splice(i, 1);
    row = row.filter((_, i) => !outIdx.includes(i));
    // input (and other) connectors: one column where the first of them is
    const connectorIdx = row.flatMap((n, i) => (cardFor(n.comp).category === 'connector' && !ordered.has(n.comp.id) ? [i] : []));
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

  // placed parts: an anchor with everything drawn at its pins, or a two-pin part on its own
  const placed: Placed[] = [];
  for (const n of nodes) {
    const at = pinned.get(n.key);
    if (!at) continue;
    const scene = stamp(flows.has(n.comp.id) ? flowCell(ctx, flows.get(n.comp.id)!) : buildCell(ctx, n.plan), n.plan);
    const unit = n.plan.unit !== undefined ? n.plan.card.units?.[n.plan.unit]?.name : undefined;
    placed.push({ cell: { scene, heads: [n.comp] }, at, comp: n.comp.id, ...(unit ? { unit } : {}) });
  }
  for (const c of placedTwoPins) placed.push({ cell: { scene: verticalPart(ctx, c, 0, 0, pinned.get(c.id)!.orient === 'lying'), heads: [] }, at: pinned.get(c.id)!, comp: c.id });
  return { cellRows, placed };
}

function layoutSheet(ctx: Ctx, sheetId: string, sheetName: string): SheetView {
  const { d } = ctx;
  const comps = componentsSorted(d).filter((c) => c.sheet === sheetId && cardOf(d, c.part));
  // the functional blocks on the sheet (the description's, with the parts in none put where they connect)
  const groups = ctx.blocks !== undefined ? ctx.blocks : blockAssignment(d, sheetId);
  let laid: { scene: Scene; pages: PageView[] };
  if (groups) {
    const { cellRows, placed } = blockRows(ctx, comps, groups, sheetId);
    laid = packPages(d, cellRows.flatMap((r) => r.cells), placed);
  } else {
    const { cellRows, placed } = classicRows(ctx, planOf(ctx, comps));
    laid = paginate(d, cellRows, placed);
  }
  const { scene, pages } = laid;
  tidyWires(scene);
  addJunctions(scene);
  const bb = pagesBBox(pages);
  return { id: sheetId, name: sheetName, bbox: bb, pages, ...scene };
}

/* --------------------------------- blocks ---------------------------------- */

/** The functional blocks of a sheet and their parts (component ids, in the sheet's order). */
export interface SheetBlocks {
  /** In the description's order; `ids` includes the `guessed` parts (in no block, put with this one). */
  blocks: { title: string; ids: string[]; guessed: string[] }[];
  /** Parts in no block that could not be put with one: drawn the classic way after the blocks. */
  loose: string[];
}

/**
 * Which block each part of a sheet is drawn in (docs/design/schematic-drawing.md §2b): the
 * description's blocks; a part in none goes with the IC it would be drawn with (its pull-up, its
 * decoupling), else with the block it shares the most signal connections with (supplies count a
 * little, ground not at all). Null when no block has a part on the sheet: it is drawn the classic way.
 */
export function blockAssignment(d: Design, sheetId: string): SheetBlocks | null {
  const blocks = d.description?.blocks ?? [];
  const comps = componentsSorted(d).filter((c) => c.sheet === sheetId && cardOf(d, c.part));
  const explicit = new Map<string, number>();
  blocks.forEach((b, i) => {
    for (const id of b.components) if (d.components[id]?.sheet === sheetId && cardOf(d, d.components[id]!.part)) explicit.set(id, i);
  });
  if (!explicit.size) return null;
  const guess = new Map<string, number>();
  const open = comps.filter((c) => !explicit.has(c.id));
  if (open.length) {
    const ctx: Ctx = { d, members: netMembers(d) };
    const owners = planOf(ctx, comps).owners;
    const blockOf = (id: string) => explicit.get(id) ?? guess.get(id);
    for (let changed = true; changed; ) {
      changed = false;
      for (const c of open) {
        if (guess.has(c.id)) continue;
        const o = owners.get(c.id);
        const viaOwner = o !== undefined ? blockOf(o) : undefined;
        if (viaOwner !== undefined) {
          guess.set(c.id, viaOwner);
          changed = true;
        }
      }
      for (const c of open) {
        if (guess.has(c.id) || owners.has(c.id)) continue;
        const score = new Map<number, number>();
        for (const net of Object.values(c.pins)) {
          const nn = d.nets[net];
          if (!nn || isGroundNet(nn)) continue;
          const w = isPowerNet(nn) ? 1 : 3;
          for (const m of ctx.members.get(net) ?? []) {
            const b = m.comp.id !== c.id && m.comp.sheet === sheetId ? blockOf(m.comp.id) : undefined;
            if (b !== undefined) score.set(b, (score.get(b) ?? 0) + w);
          }
        }
        const best = [...score].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
        if (best) {
          guess.set(c.id, best[0]);
          changed = true;
        }
      }
    }
  }
  const out = blocks.map((b) => ({ title: b.title, ids: [] as string[], guessed: [] as string[] }));
  const loose: string[] = [];
  for (const c of comps) {
    const i = explicit.get(c.id) ?? guess.get(c.id);
    if (i === undefined) {
      loose.push(c.id);
      continue;
    }
    out[i]!.ids.push(c.id);
    if (!explicit.has(c.id)) out[i]!.guessed.push(c.id);
  }
  return { blocks: out.filter((b) => b.ids.length), loose };
}

/** Space between blocks in a row (their frames carry their own air). */
const BLOCK_GAP = 300;

/** Where the agent put a block on a sheet (place_block), the page counted within the sheet; `seq`: the entry's number, the order the blocks were placed in. */
function blockSpot(d: Design, sheetId: string, title: string): { at: Pin; seq: number } | undefined {
  const k = Object.values(d.ledger).find((x) => x.kind === 'sch_block' && x.sheet === sheetId && x.key === title && x.x !== undefined && x.y !== undefined);
  return k ? { at: { page: k.page ?? 1, x: k.x!, y: k.y! }, seq: parseInt(k.id.slice(k.id.lastIndexOf('_') + 1), 36) || 0 } : undefined;
}

/** The width a block's drawing should keep within: the paper's drawing area, less the frame. */
const blockWidth = (d: Design) => paperOf(d.paper).w - 2 * PAGE.margin - 2 * FRAME_PAD - 200;

/** The blocks of a sheet as cells in description order (placed ones stand where the agent put them), then the parts in no block. */
function blockRows(ctx: Ctx, comps: Component[], groups: SheetBlocks, sheetId: string): { cellRows: CellRow[]; placed: Placed[] } {
  const { d } = ctx;
  const cells: Cell[] = [];
  const spots: { cell: Cell; at: Pin; seq: number }[] = [];
  for (const b of groups.blocks) {
    const ids = new Set(b.ids);
    const members = comps.filter((c) => ids.has(c.id));
    if (!members.length) continue;
    // (a block taller than a page comes in pieces: the first stands where it was put, the rest flow)
    const [first, ...more] = blockCells(ctx, members, b.title);
    const spot = blockSpot(d, sheetId, b.title);
    if (spot) spots.push({ cell: first!, ...spot });
    else cells.push(first!);
    cells.push(...more);
  }
  // in the order they were placed: a block placed later moves aside from the ones before it
  const placed: Placed[] = spots.sort((a, b) => a.seq - b.seq).map((s) => ({ cell: s.cell, at: s.at, comp: '', centre: true }));
  const cellRows: CellRow[] = cells.length ? [{ cells, gap: BLOCK_GAP }] : [];
  const loose = new Set(groups.loose);
  const rest = comps.filter((c) => loose.has(c.id));
  if (rest.length) {
    const r = classicRows(ctx, planOf(ctx, rest));
    cellRows.push(...r.cellRows);
    placed.push(...r.placed);
  }
  return { cellRows, placed };
}

/** One functional block drawn as a unit (blocks.ts): its pieces from the layout's plan, arranged and wired; a block taller than a page in page-sized cells. */
function blockCells(ctx: Ctx, members: Component[], title: string): Cell[] {
  const { d } = ctx;
  const p = planOf(ctx, members, { unpinned: true });
  const nodes: BlockNode[] = [];
  for (const n of p.nodes) {
    const flow = p.flows.get(n.comp.id);
    nodes.push({
      key: n.key,
      heads: [n.comp],
      canMirror: !flow && n.plan.card.category !== 'transistor' && !n.plan.stack,
      ...(mirrorAsked(d, n.comp.id) !== undefined ? { mirror: mirrorAsked(d, n.comp.id)! } : {}),
      build: (mirror) => {
        if (flow) return flowCell(ctx, flow);
        n.plan.mirror = mirror;
        return stamp(buildCell(ctx, n.plan), n.plan);
      },
    });
  }
  p.bridges.forEach((b, i) => nodes.push({ key: `bridge#${i}`, heads: b.diodes.map((x) => x.comp), canMirror: false, build: () => bridgeCell(ctx, b) }));
  for (const chain of chainsOf(ctx, p.free)) {
    const one = chain.parts.length === 1 && !chain.shunts.size ? chain.parts[0]! : undefined;
    nodes.push({ key: `chain#${chain.parts[0]!.id}`, heads: one && !isTwoPin(cardOf(d, one.part)!) ? [one] : [], canMirror: false, build: () => (one ? freePart(ctx, one) : chainCell(ctx, chain)) });
  }
  // the agent's left_of / right_of between two ICs or connectors of the block
  const keyOf = (id: string, unit?: string) => p.nodes.find((x) => x.comp.id === id && (!unit || (x.plan.unit !== undefined && x.plan.card.units?.[x.plan.unit]?.name === unit)))?.key;
  const order = p.ordering.flatMap((k) => {
    const a = keyOf(k.a!, k.aUnit);
    const b = keyOf(k.b!, k.bUnit);
    return a && b && (k.kind === 'left_of' || k.kind === 'right_of') ? [{ left: k.kind === 'left_of' ? a : b, right: k.kind === 'left_of' ? b : a }] : [];
  });
  const paper = paperOf(d.paper);
  const maxH = paper.h - 2 * PAGE.margin - PAGE.title - 2 * FRAME_PAD - FRAME_TITLE - 100;
  return drawBlock(d, ctx.members, nodes, { title, maxW: blockWidth(d), maxH, frame: ctx.frames !== false, order });
}

/** A chain of two-pin parts in series, top to bottom once drawn, and the caps tapped off its joints (by joint net). */
interface Chain {
  parts: Component[];
  shunts: Map<string, Component[]>;
}

/**
 * Parts attached to nothing, in series: two-pin parts joined by a signal net form a chain (an LED
 * and its resistor, a divider), as long as the net joins just the two of them besides caps to a
 * supply, which are drawn tapped off the joint (a divider's filter cap); a resistor into a cap to
 * ground is a chain of two. The net may go on beyond the block (a label names it). The rest stand
 * alone. In the sheet's order.
 */
function chainsOf(ctx: Ctx, free: Component[]): Chain[] {
  const { d, members } = ctx;
  const card = (c: Component) => cardOf(d, c.part)!;
  const two = free.filter((c) => isTwoPin(card(c)));
  const ids = new Set(two.map((c) => c.id));
  const otherNet = (c: Component, net: string) => Object.values(c.pins).find((n) => n !== net);
  const toSupply = (c: Component, net: string) => {
    const o = otherNet(c, net);
    return !!o && !!d.nets[o] && isPowerNet(d.nets[o]!);
  };
  const next = new Map<string, string[]>();
  const shuntsAt = new Map<string, Component[]>();
  const shunt = new Set<string>();
  const nets = [...new Set(two.flatMap((c) => Object.values(c.pins)))].sort(natCmp);
  for (const net of nets) {
    const nn = d.nets[net];
    if (!nn || isPowerNet(nn)) continue;
    const on = [...new Map((members.get(net) ?? []).filter((m) => ids.has(m.comp.id)).map((m) => [m.comp.id, m.comp])).values()];
    if (on.length < 2) continue;
    const caps = on.filter((c) => card(c).category === 'capacitor' && toSupply(c, net));
    let series = on.filter((c) => !caps.includes(c));
    let taps = caps;
    // a resistor into a cap to ground: the cap ends the chain
    if (series.length === 1 && caps.length) {
      series = [series[0]!, caps[0]!];
      taps = caps.slice(1);
    }
    if (series.length !== 2 || series.some((c) => shunt.has(c.id)) || taps.some((c) => next.has(c.id))) continue;
    next.set(series[0]!.id, [...(next.get(series[0]!.id) ?? []), series[1]!.id]);
    next.set(series[1]!.id, [...(next.get(series[1]!.id) ?? []), series[0]!.id]);
    if (taps.length) shuntsAt.set(net, taps);
    for (const t of taps) shunt.add(t.id);
  }
  const used = new Set<string>(shunt);
  const out: Chain[] = [];
  for (const c of free) {
    if (used.has(c.id)) continue;
    if (!ids.has(c.id)) {
      used.add(c.id);
      out.push({ parts: [c], shunts: new Map() });
      continue;
    }
    // walk to one end, then collect to the other
    let end = c.id;
    let prev: string | undefined;
    for (let guard = 0; guard < two.length; guard++) {
      const o = (next.get(end) ?? []).find((x) => x !== prev && !used.has(x));
      if (!o || o === c.id) break;
      prev = end;
      end = o;
    }
    const chain: string[] = [];
    prev = undefined;
    for (let at: string | undefined = end; at && !used.has(at); ) {
      used.add(at);
      chain.push(at);
      const o: string | undefined = (next.get(at) ?? []).find((x) => x !== prev && !used.has(x));
      prev = at;
      at = o;
    }
    const parts = chain.map((id) => d.components[id]!);
    const joints = parts.slice(1).map((p, i) => Object.values(p.pins).find((n) => Object.values(parts[i]!.pins).includes(n))!);
    out.push({ parts, shunts: new Map(joints.filter((j) => shuntsAt.has(j)).map((j) => [j, shuntsAt.get(j)!])) });
  }
  // a cap whose joint went to no chain stands alone
  for (const id of shunt) if (!out.some((ch) => [...ch.shunts.values()].flat().some((x) => x.id === id))) out.push({ parts: [d.components[id]!], shunts: new Map() });
  return out;
}

/**
 * A chain of two-pin parts standing in one column, wired: the end with the higher potential on top
 * (a rail, then a signal, then ground), its decorations at both ends, the caps tapped off a joint
 * hanging beside it on the left.
 */
function chainCell(ctx: Ctx, chain: Chain): Scene {
  const { d } = ctx;
  const netsOf = (c: Component) => cardOf(d, c.part)!.pins.map((p) => c.pins[p.number]);
  const shared = (a: Component, b: Component) => netsOf(a).find((n) => n && netsOf(b).includes(n));
  const outer = (c: Component, inner?: string) => netsOf(c).find((n) => n !== inner);
  let parts = [...chain.parts];
  const topNet = (ps: Component[]) => outer(ps[0]!, ps.length > 1 ? shared(ps[0]!, ps[1]!) : undefined);
  const bottomNet = (ps: Component[]) => outer(ps.at(-1)!, ps.length > 1 ? shared(ps.at(-1)!, ps.at(-2)!) : undefined);
  const pot = (id?: string) => potential(id ? d.nets[id] : undefined);
  if (pot(topNet(parts)) > pot(bottomNet(parts))) parts = parts.reverse();
  const scene = emptyScene();
  let upper = topNet(parts);
  let y = 0;
  parts.forEach((c, i) => {
    const card = cardOf(d, c.part)!;
    const top = card.pins.find((p) => c.pins[p.number] === upper) ?? card.pins[0]!;
    if (i > 0 && upper) {
      scene.wires.push({ netId: upper, pts: [0, y, 0, y + CHAIN_GAP] });
      // caps tapped off this joint, hanging to their supply on the left
      let x = 0;
      for (const s of chain.shunts.get(upper) ?? []) {
        x -= grid(satWidth(d, s) + 100);
        const sc = cardOf(d, s.part)!;
        const sp = sc.pins.find((p) => s.pins[p.number] === upper) ?? sc.pins[0]!;
        const tap = y + CHAIN_GAP / 2;
        scene.wires.push({ netId: upper, pts: [0, tap, x, tap] });
        const sym = makeSymbol(d, s, symbolFor(sc, sp.number !== sc.pins[0]!.number), x, tap + 200);
        scene.symbols.push(sym);
        const bp = sym.pins.find((p) => p.side === 'bottom')!;
        const far = s.pins[bp.number];
        if (s.noConnect.includes(bp.number)) scene.noConnects.push({ x: bp.x, y: bp.y });
        else if (far && d.nets[far]) endLead(scene, d.nets[far]!, bp.x, bp.y, 'down');
      }
      y += CHAIN_GAP;
    }
    const sym = makeSymbol(d, c, symbolFor(card, top.number !== card.pins[0]!.number), 0, y + 200);
    scene.symbols.push(sym);
    const tp = sym.pins.find((p) => p.side === 'top')!;
    const bp = sym.pins.find((p) => p.side === 'bottom')!;
    if (i === 0) {
      if (c.noConnect.includes(tp.number)) scene.noConnects.push({ x: tp.x, y: tp.y });
      else if (upper && d.nets[upper]) endLead(scene, d.nets[upper]!, tp.x, tp.y, 'up');
    }
    const lower = c.pins[bp.number];
    if (i === parts.length - 1) {
      if (c.noConnect.includes(bp.number)) scene.noConnects.push({ x: bp.x, y: bp.y });
      else if (lower && d.nets[lower]) endLead(scene, d.nets[lower]!, bp.x, bp.y, 'down');
    }
    upper = lower;
    y = bp.y;
  });
  return scene;
}

/** The symbol each small part was drawn with: its cell's IC or connector (drawnWith). */
const withHead = new WeakMap<SymbolView, string>();

/** The symbol a part was drawn with by the layout, as a key: the component id, with "#" and the unit letter for one unit of a split symbol. */
export const drawnWith = (s: SymbolView): string | undefined => withHead.get(s);

/** The symbol key of a component or one of its units (drawnWith). */
export const symbolKey = (comp: string, unit?: string) => (unit ? `${comp}#${unit}` : comp);

function stamp(scene: Scene, plan: AnchorPlan): Scene {
  const key = symbolKey(plan.comp.id, plan.unit !== undefined ? plan.card.units?.[plan.unit]?.name : undefined);
  for (const s of scene.symbols) if (s.componentId !== plan.comp.id) withHead.set(s, key);
  return scene;
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
export const PAGE_GAP = 600;

/** A cell whose part the agent placed: its symbol's centre goes to `at` on that page (`centre`: the cell's own centre, a block's frame). */
interface Placed {
  cell: Cell;
  at: Pin;
  comp: string;
  unit?: string;
  centre?: boolean;
}

/**
 * Flow the cells onto pages: each row is broken into lines that fit the page width (order
 * kept), lines are stacked until the page is full, then the next page starts. A cell wider or
 * a line taller than the paper gets a page of its own, grown to fit (`oversized`). Pages sit
 * in a near-square grid on the canvas (rows of ⌈√n⌉), so the sheet still reads as one drawing
 * and fits the window without a long scroll. There is always at least one page, so an empty
 * sheet shows its paper.
 *
 * Placed cells stand where the agent put them; on their page the lines start at the top-left of
 * the drawing area and go down past them instead of being centred.
 */
function paginate(d: Design, rows: CellRow[], placed: Placed[] = []): { scene: Scene; pages: PageView[] } {
  const paper = paperOf(d.paper);
  // the drawing area of a page
  const DRAW_W = paper.w - 2 * PAGE.margin;
  const DRAW_H = paper.h - 2 * PAGE.margin - PAGE.title;
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

  // placed cells: how far each moves so its part's symbol is centred where it was put, and the box
  // it then takes on its page (paper coordinates)
  const { fixed } = fixPlaced(placed, { x: PAGE.margin, y: PAGE.margin, w: DRAW_W, h: DRAW_H });
  const boxesOn = (page: number) => fixed.filter((f) => f.page === page).map((f) => f.box);

  // lines → pages
  const sets: { lines: Line[]; ys: number[]; used: number }[] = [];
  const setAt = (i: number) => (sets[i] ??= { lines: [], ys: [], used: 0 });
  let page = 0;
  for (const line of lines) {
    for (;;) {
      const set = setAt(page);
      const boxes = boxesOn(page);
      const h = line.bbox.h;
      if (!boxes.length) {
        const step = grid(h + CELL_GAP);
        if (set.lines.length && set.used + step - CELL_GAP > DRAW_H) {
          page++;
          continue;
        }
        set.ys.push(set.used);
        set.used += step;
        set.lines.push(line);
        break;
      }
      // the line at the left of the drawing area, lowered until it clears the placed cells
      const clash = (y: number) => boxes.some((b) => hits({ x: PAGE.margin - CELL_GAP / 2, y: PAGE.margin + y - CELL_GAP / 2, w: line.bbox.w + CELL_GAP, h: h + CELL_GAP }, b));
      let y = set.used;
      while (y + h <= DRAW_H && clash(y)) y += GRID;
      if (y + h > DRAW_H) {
        page++;
        continue;
      }
      set.ys.push(y);
      set.used = grid(y + h + CELL_GAP);
      set.lines.push(line);
      break;
    }
  }
  const nPages = Math.max(sets.length, ...fixed.map((f) => f.page + 1), 1);
  for (let i = 0; i < nPages; i++) setAt(i);
  for (const [i, p] of sets.entries()) if (!boxesOn(i).length && p.lines.length) p.used -= CELL_GAP;

  // pages → grid on the canvas, read left to right and top to bottom; an oversized page widens
  // its column and deepens its row, so the others stay aligned
  const sizes = sets.map((p, i) => {
    const wide = Math.max(0, ...p.lines.map((l) => l.bbox.w));
    const boxes = boxesOn(i);
    const right = Math.max(0, ...boxes.map((b) => b.x + b.w + PAGE.margin));
    const bottom = Math.max(0, ...boxes.map((b) => b.y + b.h + PAGE.margin + PAGE.title));
    const w = Math.max(paper.w, wide + 2 * PAGE.margin, right);
    const h = Math.max(paper.h, p.used + 2 * PAGE.margin + PAGE.title, bottom);
    return { w, h, oversized: w > paper.w || h > paper.h };
  });
  const at = pageGrid(sizes);

  const scene = emptyScene();
  const pages: PageView[] = [];
  sets.forEach((p, i) => {
    const { w, h, oversized } = sizes[i]!;
    const rect: Rect = { ...at[i]!, w, h };
    const mine = fixed.filter((f) => f.page === i);
    if (mine.length) {
      for (const [j, line] of p.lines.entries()) {
        translateScene(line.scene, rect.x + PAGE.margin - line.bbox.x, rect.y + PAGE.margin + p.ys[j]! - line.bbox.y);
        mergeScene(scene, line.scene);
      }
      for (const f of mine) {
        translateScene(f.cell.scene, rect.x + f.dx, rect.y + f.dy);
        mergeScene(scene, f.cell.scene);
      }
    } else {
      // the block of lines sits centred in the drawing area, on the grid (lines stay left-aligned)
      const blockW = Math.max(0, ...p.lines.map((l) => l.bbox.w));
      const x0 = rect.x + PAGE.margin + centred(rect.w - 2 * PAGE.margin, blockW);
      let y = rect.y + PAGE.margin + centred(rect.h - 2 * PAGE.margin - PAGE.title, p.used);
      for (const line of p.lines) {
        translateScene(line.scene, x0 - line.bbox.x, y - line.bbox.y);
        mergeScene(scene, line.scene);
        y = grid(y + line.bbox.h + CELL_GAP);
      }
    }
    const heads = [...p.lines.flatMap((l) => l.heads), ...mine.flatMap((f) => f.cell.heads)];
    pages.push({ number: i + 1, name: pageName(d, heads), rect, ...(oversized ? { oversized: true } : {}) });
  });
  return { scene, pages };
}

/** A placed cell where it ends up: on which page, the move that puts it there, the box it then takes (paper coordinates). */
interface Fixed {
  cell: Cell;
  page: number;
  dx: number;
  dy: number;
  box: Rect;
}

/**
 * Where placed cells go: a part's symbol centred where the agent put it, a block's frame
 * (`centre`) centred there, a block moved aside to the nearest clear spot of the drawing area
 * when it would lie on one placed before it; `flow`: the blocks that found no such spot on their
 * page (they flow with the others).
 */
function fixPlaced(placed: Placed[], area: Rect): { fixed: Fixed[]; flow: Cell[] } {
  const fixed: Fixed[] = [];
  const flow: Cell[] = [];
  for (const p of placed) {
    const bb = sceneBBox(p.cell.scene);
    const sym = p.centre ? undefined : p.cell.scene.symbols.find((s) => s.componentId === p.comp && (p.unit === undefined || s.unit === p.unit)) ?? p.cell.scene.symbols[0];
    const c = sym ? sym.bbox : p.centre ? bb : undefined;
    const cx = c ? c.x + c.w / 2 : 0;
    const cy = c ? c.y + c.h / 2 : 0;
    let dx = Math.round((p.at.x - cx) / GRID) * GRID;
    let dy = Math.round((p.at.y - cy) / GRID) * GRID;
    const page = p.at.page - 1;
    if (p.centre) {
      // a block never lies on one placed before it: it moves aside to the nearest clear spot
      // within the drawing area, or flows with the others when the page has none
      const others = fixed.filter((f) => f.page === page).map((f) => f.box);
      // (where the kernel picks the spot, it keeps the room between blocks)
      const clear = (ox: number, oy: number, gap = 0) => !others.some((o) => hits({ x: o.x - gap, y: o.y - gap, w: o.w + 2 * gap, h: o.h + 2 * gap }, { x: bb.x + ox, y: bb.y + oy, w: bb.w, h: bb.h }));
      const within = (ox: number, oy: number) => bb.x + ox >= area.x && bb.y + oy >= area.y && bb.x + ox + bb.w <= area.x + area.w && bb.y + oy + bb.h <= area.y + area.h;
      if (!clear(dx, dy)) {
        let found: [number, number] | undefined;
        const reach = Math.ceil(Math.max(area.x + area.w, area.y + area.h) / GRID);
        for (let r = 1; r <= reach && !found; r++) {
          const ring: [number, number][] = [];
          for (let k = -r; k <= r; k++) ring.push([k, -r], [k, r], [-r, k], [r, k]);
          ring.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1])) || a[1] - b[1] || a[0] - b[0]);
          found = ring.find(([i, j]) => clear(dx + i * GRID, dy + j * GRID, BLOCK_GAP) && within(dx + i * GRID, dy + j * GRID));
        }
        if (!found) {
          flow.push(p.cell);
          continue;
        }
        dx += found[0] * GRID;
        dy += found[1] * GRID;
      }
    }
    fixed.push({ cell: p.cell, page, dx, dy, box: { x: bb.x + dx, y: bb.y + dy, w: bb.w, h: bb.h } });
  }
  return { fixed, flow };
}

/** Where pages of these sizes stand on the canvas: a near-square grid read left to right, top to bottom; a big page widens its column and deepens its row. */
function pageGrid(sizes: { w: number; h: number }[]): Point[] {
  const cols = Math.ceil(Math.sqrt(sizes.length));
  const colW = Array.from({ length: cols }, (_, c) => Math.max(0, ...sizes.filter((_, i) => i % cols === c).map((z) => z.w)));
  const rowH = Array.from({ length: Math.ceil(sizes.length / cols) }, (_, r) => Math.max(0, ...sizes.slice(r * cols, (r + 1) * cols).map((z) => z.h)));
  const colX = colW.map((_, c) => colW.slice(0, c).reduce((x, w) => x + w + PAGE_GAP, 0));
  const rowY = rowH.map((_, r) => rowH.slice(0, r).reduce((y, h) => y + h + PAGE_GAP, 0));
  return sizes.map((_, i) => ({ x: colX[i % cols]!, y: rowY[Math.floor(i / cols)]! }));
}

/**
 * Pages of a sheet drawn in blocks: each block (never split) goes to the highest, then leftmost,
 * clear spot of the page's drawing area, around the blocks placed there; one that fits nowhere
 * starts the next page (blocks never go back to an earlier page, so the pages read in order), one
 * bigger than the paper gets a page of its own, grown to fit. On a page without placed blocks the
 * blocks are centred in the drawing area.
 */
function packPages(d: Design, cells: Cell[], placed: Placed[]): { scene: Scene; pages: PageView[] } {
  const paper = paperOf(d.paper);
  const area: Rect = { x: PAGE.margin, y: PAGE.margin, w: paper.w - 2 * PAGE.margin, h: paper.h - 2 * PAGE.margin - PAGE.title };
  const { fixed, flow } = fixPlaced(placed, area);
  interface Packed {
    cell: Cell;
    box: Rect;
    dx: number;
    dy: number;
  }
  const sets: { packed: Packed[]; big?: { w: number; h: number } }[] = [];
  const setAt = (i: number) => (sets[i] ??= { packed: [] });
  for (const f of fixed) setAt(f.page);
  const taken = (i: number) => [...fixed.filter((f) => f.page === i).map((f) => f.box), ...setAt(i).packed.map((p) => p.box)];
  const snapTo = (v: number) => Math.round(v / GRID) * GRID;
  let page = 0;
  // (a placed block that found no room on its page first)
  for (const cell of [...flow, ...cells]) {
    const bb = sceneBBox(cell.scene);
    const big = bb.w > area.w || bb.h > area.h;
    for (; ; page++) {
      const set = setAt(page);
      if (set.big) continue;
      const obstacles = taken(page);
      if (big) {
        if (obstacles.length) continue;
        set.big = { w: grid(bb.w) + 2 * PAGE.margin, h: grid(bb.h) + 2 * PAGE.margin + PAGE.title };
        const dx = snapTo(area.x - bb.x);
        const dy = snapTo(area.y - bb.y);
        set.packed.push({ cell, dx, dy, box: { x: bb.x + dx, y: bb.y + dy, w: bb.w, h: bb.h } });
        break;
      }
      // candidate corners: the area's, and right of / below each block already there
      const xs = [area.x, ...obstacles.map((o) => o.x + o.w + BLOCK_GAP)];
      const ys = [area.y, ...obstacles.map((o) => o.y + o.h + BLOCK_GAP)];
      const spots = ys.flatMap((y) => xs.map((x) => ({ x, y }))).sort((a, b) => a.y - b.y || a.x - b.x);
      const fits = spots.find(({ x, y }) => {
        const r = { x, y, w: bb.w, h: bb.h };
        return x + bb.w <= area.x + area.w && y + bb.h <= area.y + area.h && !obstacles.some((o) => hits({ x: o.x - BLOCK_GAP + 1, y: o.y - BLOCK_GAP + 1, w: o.w + 2 * BLOCK_GAP - 2, h: o.h + 2 * BLOCK_GAP - 2 }, r));
      });
      if (!fits) continue;
      const dx = snapTo(fits.x - bb.x);
      const dy = snapTo(fits.y - bb.y);
      set.packed.push({ cell, dx, dy, box: { x: bb.x + dx, y: bb.y + dy, w: bb.w, h: bb.h } });
      break;
    }
  }
  if (!sets.length) setAt(0);
  for (let i = 0; i < sets.length; i++) setAt(i);
  const sizes = sets.map((s, i) => {
    const boxes = fixed.filter((f) => f.page === i).map((f) => f.box);
    const right = Math.max(0, ...boxes.map((b) => b.x + b.w + PAGE.margin));
    const bottom = Math.max(0, ...boxes.map((b) => b.y + b.h + PAGE.margin + PAGE.title));
    const w = Math.max(paper.w, s.big?.w ?? 0, right);
    const h = Math.max(paper.h, s.big?.h ?? 0, bottom);
    return { w, h, oversized: w > paper.w || h > paper.h };
  });
  const at = pageGrid(sizes);
  const scene = emptyScene();
  const pages: PageView[] = [];
  sets.forEach((s, i) => {
    const { w, h, oversized } = sizes[i]!;
    const rect: Rect = { ...at[i]!, w, h };
    const mine = fixed.filter((f) => f.page === i);
    // a page of flowing blocks only: their group centred in the drawing area
    let cx = 0;
    let cy = 0;
    if (!mine.length && s.packed.length && !s.big) {
      const x0 = Math.min(...s.packed.map((p) => p.box.x));
      const y0 = Math.min(...s.packed.map((p) => p.box.y));
      const x1 = Math.max(...s.packed.map((p) => p.box.x + p.box.w));
      const y1 = Math.max(...s.packed.map((p) => p.box.y + p.box.h));
      cx = area.x + centred(area.w, x1 - x0) - x0;
      cy = area.y + centred(area.h, y1 - y0) - y0;
    }
    for (const p of s.packed) {
      translateScene(p.cell.scene, rect.x + p.dx + cx, rect.y + p.dy + cy);
      mergeScene(scene, p.cell.scene);
    }
    for (const f of mine) {
      translateScene(f.cell.scene, rect.x + f.dx, rect.y + f.dy);
      mergeScene(scene, f.cell.scene);
    }
    const heads = [...s.packed.flatMap((p) => p.cell.heads), ...mine.flatMap((f) => f.cell.heads)];
    pages.push({ number: i + 1, name: pageName(d, heads), rect, ...(oversized ? { oversized: true } : {}) });
  });
  return { scene, pages };
}

/** Offset that centres `size` in `room`, rounded down to the grid; never negative. */
const centred = (room: number, size: number) => Math.max(0, Math.floor((room - size) / 2 / GRID) * GRID);

/**
 * What the page is for, e.g. "Buck converter, Microcontroller": the title of the description
 * block a main part belongs to, else the part's own title, else the first words of its
 * description. ICs first, then connectors, each function once.
 */
export function pageName(d: Design, heads: Component[]): string {
  const seen = new Set<string>();
  const conn = (c: Component) => Number(cardOf(d, c.part)!.category === 'connector');
  const blockOf = (c: Component) => d.description?.blocks.find((b) => b.components.includes(c.id))?.title;
  // functional blocks in the description's order, then the parts in none
  const blockIndex = (c: Component) => {
    const i = d.description?.blocks.findIndex((b) => b.components.includes(c.id)) ?? -1;
    return i < 0 ? Infinity : i;
  };
  const functions = heads
    .filter((c) => !seen.has(c.id) && seen.add(c.id))
    .sort((a, b) => blockIndex(a) - blockIndex(b) || conn(a) - conn(b) || natCmp(a.refdes, b.refdes))
    .map((c) => {
      const card = cardOf(d, c.part)!;
      const generic = card.id.startsWith('generic:');
      if (generic && card.category === 'connector') return blockOf(c) ?? 'Connector';
      return blockOf(c) ?? card.title ?? card.description.split(/[,.(;]/)[0]!.trim();
    })
    .filter(Boolean);
  const names = [...new Set(functions)];
  if (!names.length) return heads.length ? 'parts' : 'empty';
  return names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(', ');
}

export function pagesBBox(pages: PageView[]): Rect {
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

/**
 * "R4 left of U2": the two-pin part, the constraint's subject, is drawn at that side of the anchor.
 * With the part as the reference instead ("J2 right of R4") it is the anchor that moves (see the
 * ordering in layoutSheet), so the part stays where it belongs.
 */
function sideHint(ks: Constraint[], compId: string, anchors: Component[]): { anchor: string; unit?: string; side: 'left' | 'right' } | undefined {
  const anchorIds = new Set(anchors.map((a) => a.id));
  for (const k of ks) {
    if (k.a === compId && anchorIds.has(k.b!) && (k.kind === 'left_of' || k.kind === 'right_of')) {
      return { anchor: k.b!, ...(k.bUnit ? { unit: k.bUnit } : {}), side: k.kind === 'left_of' ? 'left' : 'right' };
    }
  }
  return undefined;
}

/** A layout node's key: the component, or one unit of a split symbol (by index). */
const nodeKey = (compId: string, unit?: number) => (unit === undefined ? compId : `${compId}#${unit}`);

/** Where the agent placed a symbol (a sch_position ledger entry), the page counted within its sheet. */
interface Pin {
  page: number;
  x: number;
  y: number;
  orient?: 'upright' | 'lying';
  mirror?: boolean;
}

/** The placements on these components, by node key (a placement of a split symbol without a unit is its first unit's). */
function placementsOf(d: Design, comps: Component[]): Map<string, Pin> {
  const out = new Map<string, Pin>();
  const ids = new Set(comps.map((c) => c.id));
  for (const k of Object.values(d.ledger)) {
    if (k.kind !== 'sch_position' || !k.a || !ids.has(k.a) || k.x === undefined || k.y === undefined) continue;
    const card = cardOf(d, d.components[k.a]!.part)!;
    const n = unitCount(card);
    const unit = n > 1 ? Math.max(0, card.units?.findIndex((u) => u.name === k.aUnit) ?? 0) : undefined;
    out.set(nodeKey(k.a, unit), { page: k.page ?? 1, x: k.x, y: k.y, ...(k.orient ? { orient: k.orient } : {}), ...(k.mirror !== undefined ? { mirror: k.mirror } : {}) });
  }
  return out;
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
  endLead(scene, d.nets[net]!, x, y, 'up');
}

/** A two-pin part lying horizontally centred on (cx, cy); `pin1Left` puts pin 1 on the left. */
function horizontalPart(d: Design, comp: Component, cx: number, cy: number, pin1Left: boolean): SymbolView {
  const card = cardOf(d, comp.part)!;
  const def = uprightSymbol(card);
  const s = makeSymbol(d, comp, def, cx, cy);
  rotateSymbol(s, def, cx, cy, pin1Left ? -90 : 90);
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
    if (below) endLead(scene, d.nets[below]!, bottom.x, bottom.y, 'down');
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
  const busEnds: (typeof sym.pins)[number][] = []; // the bus pin nearest the pins beyond it, so they step out past the bus
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
      busEnds.push(run.find((p) => p.y === (dir === 'up' ? bottom : top))!);
      const w = 100 + Math.max(80, tw(net.name) / 2 + 20) + 100;
      if (side === 'right') gapRight = Math.max(gapRight, w);
      else gapLeft = Math.max(gapLeft, w);
    }
  }
  const rises = new Map<string, number>();
  const unbused = sym.pins.filter((p) => !bused.has(`${p.x},${p.y}`));
  const stubs = supplyStubs([...unbused, ...busEnds], supplyOf, rises);
  // A supply symbol on a side pin stands upright (rails up, ground down: never sideways) beside the
  // pins above it (rails) or below it (grounds). Where one of those pins has a lead going further
  // out (wires to its satellites, a net label), the symbol's stem crosses that lead, and its arrow
  // or bars go past the farthest such lead, so they never sit on a wire.
  const reach = (q: (typeof sym.pins)[number]): number => {
    const netId = plan.comp.pins[q.number];
    if (!netId || plan.comp.noConnect.includes(q.number) || decorated.has(`${q.x},${q.y}`)) return 0;
    if (bused.has(`${q.x},${q.y}`)) return 100;
    if (satsByPin.has(q.number)) return Infinity;
    return supplyDir(d.nets[netId]!) ? 0 : decoWidth(d.nets[netId]);
  };
  const sidePins = unbused.filter((p) => (p.side === 'left' || p.side === 'right') && !decorated.has(`${p.x},${p.y}`) && supplyOf(p.number));
  for (const p of sidePins) {
    const dir = supplyOf(p.number)!;
    const stub = stubs.get(p.number) ?? 100;
    for (let grew = true; grew; ) {
      grew = false;
      const rise = rises.get(p.number) ?? 0;
      const h = (dir === 'up' ? 400 : 260) + rise;
      const crossed = sym.pins.filter((q) => q.side === p.side && (dir === 'up' ? q.y > p.y - h && q.y < p.y : q.y < p.y + h && q.y > p.y) && reach(q) > stub - 60).map((q) => q.y);
      if (!crossed.length) break;
      // rail: the arrow's base 100 above the highest crossed lead (stem 200 + rise); ground: the bars 100 below the lowest
      const need = dir === 'up' ? p.y - Math.min(...crossed) - 100 : Math.max(...crossed) - p.y + 20;
      if (need > rise) {
        rises.set(p.number, need);
        grew = true;
      }
    }
  }
  // two rails whose arrows end at about one height would put their names side by side (or on
  // top of each other): the outer one goes up a step, and out a step if it stood in the same column
  const rails = sidePins.filter((p) => supplyOf(p.number) === 'up').sort((a, b) => (stubs.get(a.number) ?? 100) - (stubs.get(b.number) ?? 100));
  const arrowBase = (q: (typeof sym.pins)[number]) => q.y - 200 - (rises.get(q.number) ?? 0);
  const stemX = (q: (typeof sym.pins)[number]) => q.x + (q.side === 'left' ? -1 : 1) * (stubs.get(q.number) ?? 100);
  const nameHalf = (q: (typeof sym.pins)[number]) => tw(d.nets[plan.comp.pins[q.number]!]!.name) / 2 + 50;
  for (const [i, p] of rails.entries()) {
    for (const o of rails.slice(0, i)) {
      if (o.side !== p.side || Math.abs(arrowBase(o) - arrowBase(p)) >= 200 || Math.abs(stemX(o) - stemX(p)) >= nameHalf(o) + nameHalf(p)) continue;
      if (stemX(o) === stemX(p)) stubs.set(p.number, (stubs.get(p.number) ?? 100) + 200);
      rises.set(p.number, Math.max(rises.get(p.number) ?? 0, p.y - arrowBase(o)));
    }
  }
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
    scene.labels.push(deco(net, p.x, p.y, dir, stub, rises.get(p.number) ?? 0, plan.card.pins.find((cp) => cp.number === p.number)?.type));
    if (p.side === 'right') gapRight = Math.max(gapRight, decoWidth(net, stub) + 100);
    if (p.side === 'left') gapLeft = Math.max(gapLeft, decoWidth(net, stub) + 100);
  }

  /* satellite columns */
  const standing = new Map(Object.values(d.ledger).filter((k) => k.kind === 'arrangement' && k.a && (k.value === 'up' || k.value === 'down')).map((k) => [k.a!, k.value]));
  const placeColumns = (side: 'left' | 'right') => {
    const toRail = (s: Sat) => {
      let far: string | undefined = s.net;
      for (const c of [s.comp, ...s.chain]) far = Object.values(c.pins).find((n) => n !== far) ?? far;
      return !!far && far !== s.net && supplyDir(d.nets[far]!) === 'up';
    };
    const reach = (s: Sat) => (s.chain.length + 1) * (400 + CHAIN_GAP) + 400;
    // a pull-up (the far end a positive rail) stands above the wire with its rail on top, unless
    // parts hanging from a pin above reach down past its pin: one wire would then run through the
    // other's parts, whichever column is nearer
    const pinOf = new Map(sym.pins.map((p) => [p.number, p]));
    const isUp = (s: Sat) => {
      // the agent's choice (constrain arrangement up/down) over the guess
      const asked = [s.comp, ...s.chain].map((c) => standing.get(c.id)).find((v) => !!v);
      if (asked) return asked === 'up';
      if (!toRail(s)) return false;
      const p = pinOf.get(s.anchorPin)!;
      return !sym.pins.some((q) => q.side === side && q.y < p.y && (satsByPin.get(q.number) ?? []).some((o) => !toRail(o) && q.y + reach(o) > p.y));
    };
    // how far a pin's parts reach above and below it
    const span = (p: { number: string; y: number }) => {
      const sats = satsByPin.get(p.number)!;
      const up = Math.max(0, ...sats.filter(isUp).map(reach));
      const down = Math.max(0, ...sats.filter((s) => !isUp(s)).map(reach));
      return { top: p.y - up, bottom: p.y + down };
    };
    // nearest column first: each time the pin whose parts the fewest wires of the pins still to
    // come (further out) would run through, then the lowest; parts hanging down go bottom pin
    // first, pull-ups top pin first, and a crossing only where the two cannot both be clear
    const todo = sym.pins.filter((p) => p.side === side && satsByPin.has(p.number));
    const pins: typeof todo = [];
    while (todo.length) {
      const cost = (p: (typeof todo)[number]) => {
        const sp = span(p);
        return todo.filter((q) => q !== p && q.y > sp.top && q.y < sp.bottom).length;
      };
      const next = todo.reduce((a, b) => (cost(b) < cost(a) || (cost(b) === cost(a) && b.y > a.y) ? b : a));
      pins.push(next);
      todo.splice(todo.indexOf(next), 1);
    }
    const pinEndX = side === 'right' ? bodyW + 200 : -200;
    let x = side === 'right' ? grid(pinEndX + gapRight) : 0;
    let first = true;
    for (const p of pins) {
      const sats = satsByPin.get(p.number)!;
      const net = d.nets[plan.comp.pins[p.number]!]!;
      const xs: number[] = [];
      const otherNetOf = (s: Sat) => {
        const otherPin = s.card.pins.find((pp) => s.comp.pins[pp.number] !== s.net) ?? s.card.pins[1]!;
        return s.comp.pins[otherPin.number] ? d.nets[s.comp.pins[otherPin.number]!] : undefined;
      };
      const widthOf = (s: Sat) => Math.max(satWidth(d, s.comp, otherNetOf(s)), ...s.chain.map((c) => satWidth(d, c, chainBottomNet(ctx, c, s))));
      // a part going up and one going down share a column, so a divider is one straight line
      // (rail, R, node, R, ground) instead of two columns joined by a jog
      const cols: { up?: Sat; down?: Sat }[] = [];
      for (const s of sats) {
        const dir = isUp(s) ? 'up' : 'down';
        const col = cols.find((c) => !c[dir]);
        if (col) col[dir] = s;
        else cols.push({ [dir]: s });
      }
      for (const col of cols) {
        const width = Math.max(...[col.up, col.down].filter((s) => !!s).map(widthOf));
        if (side === 'left') {
          if (first) x = grid(pinEndX - gapLeft - width + 100);
          else x -= width;
        }
        first = false;
        const cx = x;
        xs.push(cx);
        if (side === 'right') x += width;
        if (col.up) {
          const s = col.up;
          const attached = s.card.pins.find((pp) => s.comp.pins[pp.number] === s.net)!;
          const satSym = makeSymbol(d, s.comp, symbolFor(s.card, attached.number === s.card.pins[0]!.number), cx, p.y - 200);
          scene.symbols.push(satSym);
          let top = satSym.pins.find((pp) => pp.side === 'top')!;
          let lower = s.net;
          let upper = Object.values(s.comp.pins).find((n) => n !== lower);
          for (const c of s.chain) {
            const card = cardOf(d, c.part)!;
            const bp = card.pins.find((pp) => c.pins[pp.number] === upper) ?? card.pins[0]!;
            if (upper) scene.wires.push({ netId: upper, pts: [cx, top.y, cx, top.y - CHAIN_GAP] });
            const cs = makeSymbol(d, c, symbolFor(card, bp.number === card.pins[0]!.number), cx, top.y - CHAIN_GAP - 200);
            scene.symbols.push(cs);
            lower = upper ?? lower;
            upper = Object.values(c.pins).find((n) => n !== lower);
            top = cs.pins.find((pp) => pp.side === 'top')!;
          }
          if (upper) endLead(scene, d.nets[upper]!, top.x, top.y, 'up');
        }
        if (!col.down) continue;
        const s = col.down;
        const otherNet = otherNetOf(s);
        // pin attached to the anchor net goes on top
        const flip = s.card.pins[0]!.number !== s.card.pins.find((pp) => s.comp.pins[pp.number] === s.net)!.number;
        const satDef = symbolFor(s.card, flip);
        const satSym = makeSymbol(d, s.comp, satDef, cx, p.y + 200);
        scene.symbols.push(satSym);
        const bottom = satSym.pins.find((pp) => pp.side === 'bottom')!;
        if (s.comp.noConnect.includes(bottom.number)) scene.noConnects.push({ x: bottom.x, y: bottom.y });
        else if (otherNet && !s.chain.length) endLead(scene, otherNet, bottom.x, bottom.y, 'down');
        // series parts continue straight down the same column
        let upperNet = otherNet?.id;
        let y = bottom.y;
        s.chain.forEach((c, i) => {
          const card = cardOf(d, c.part)!;
          const topPin = card.pins.find((pp) => c.pins[pp.number] === upperNet) ?? card.pins[0]!;
          if (upperNet) scene.wires.push({ netId: upperNet, pts: [cx, y, cx, y + CHAIN_GAP] });
          y += CHAIN_GAP;
          const sym = makeSymbol(d, c, symbolFor(card, topPin.number !== card.pins[0]!.number), cx, y + 200);
          scene.symbols.push(sym);
          const b = sym.pins.find((pp) => pp.side === 'bottom')!;
          const bNet = c.pins[b.number] ? d.nets[c.pins[b.number]!] : undefined;
          if (c.noConnect.includes(b.number)) scene.noConnects.push({ x: b.x, y: b.y });
          else if (bNet && i === s.chain.length - 1) endLead(scene, bNet, b.x, b.y, 'down');
          upperNet = bNet?.id;
          y = b.y;
        });
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
    const rank = potential;
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
  clearName(scene, sym);
  return scene;
}

const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * A part's name and value stand outside a top corner, over that side's pin leads. A rising
 * supply symbol or a neighbouring part there would run through them: then they move to the other
 * corner, above the middle (when no pin is on top), or failing that up until they are clear.
 */
function clearName(scene: Scene, sym: SymbolView): void {
  const texts = () => [textRect(sym.refPos, [sym.refdes]), textRect(sym.valuePos, sym.valueLines ?? [sym.value])];
  const clash = () => texts().some((t) => scene.labels.some((l) => hits(t, labelRect(l))) || scene.symbols.some((o) => o !== sym && hits(t, o.bbox)));
  if (!clash()) return;
  const body = { x: sym.bbox.x + 200, w: sym.bbox.w - 400 };
  const at = sym.refPos.anchor === 'end' ? 'left' : sym.refPos.anchor === 'start' ? 'right' : 'middle';
  const spots: Pick<SymbolView['refPos'], 'x' | 'anchor'>[] = [];
  if (at !== 'right') spots.push({ x: body.x + body.w + 30, anchor: 'start' });
  if (at !== 'left') spots.push({ x: body.x - 30, anchor: 'end' });
  if (at !== 'middle' && !sym.pins.some((p) => p.side === 'top')) spots.push({ x: body.x + body.w / 2, anchor: 'middle' });
  const [ref, val] = [sym.refPos, sym.valuePos];
  for (const spot of spots) {
    sym.refPos = { ...ref, ...spot };
    sym.valuePos = { ...val, ...spot };
    if (!clash()) return;
  }
  sym.refPos = ref;
  sym.valuePos = val;
  for (let n = 0; clash() && n < 20; n++) {
    sym.refPos = { ...sym.refPos, y: sym.refPos.y - 100 };
    sym.valuePos = { ...sym.valuePos, y: sym.valuePos.y - 100 };
  }
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

/** A vertical two-pin part centred at (cx, cy) with decorations on both ends (`lying`: horizontal, as asked by a placement). */
function verticalPart(ctx: Ctx, c: Component, cx: number, cy: number, lying = false): Scene {
  const { d } = ctx;
  const card = cardOf(d, c.part)!;
  const nets = card.pins.map((p) => (c.pins[p.number] ? d.nets[c.pins[p.number]!] : undefined));
  const rank = potential;
  const scene = emptyScene();
  if (lying || betweenSupplies(nets)) {
    // between two rails (a filter resistor VIN → AVIN) or two grounds: lying flat, both symbols
    // pointing their own way from its ends, the rail the power comes from on the left
    const sym = horizontalPart(d, c, cx, cy, sourceRank(ctx, nets[0]) >= sourceRank(ctx, nets[1]));
    scene.symbols.push(sym);
    for (const p of sym.pins) {
      const net = nets[card.pins.findIndex((pp) => pp.number === p.number)];
      const left = p.x < cx;
      if (c.noConnect.includes(p.number)) scene.noConnects.push({ x: p.x, y: p.y });
      else if (net) scene.labels.push(deco(net, p.x, p.y, left ? 'left' : 'right'));
    }
    return scene;
  }
  const flip = rank(nets[1]) < rank(nets[0]);
  const sym = makeSymbol(d, c, symbolFor(card, flip), cx, cy);
  scene.symbols.push(sym);
  for (const p of sym.pins) {
    const idx = card.pins.findIndex((pp) => pp.number === p.number);
    const net = nets[idx];
    if (c.noConnect.includes(p.number)) scene.noConnects.push({ x: p.x, y: p.y });
    else if (net) endLead(scene, net, p.x, p.y, p.side === 'top' ? 'up' : 'down');
  }
  return scene;
}

/** Higher potential on top: a rail pointing up above a signal above ground and rails pointing down. */
const potential = (n?: Net) => (!n ? 1 : supplyDir(n) === 'up' ? 0 : supplyDir(n) === 'down' ? 3 : 2);

/** How much a rail looks like where the power comes from: an external supply, then the higher voltage, then the one more parts use. */
function sourceRank(ctx: Ctx, n?: Net): number {
  if (!n) return 0;
  return (n.attrs.external ? 1e6 : 0) + (n.attrs.voltage ?? 0) * 1000 + (ctx.members.get(n.id)?.length ?? 0);
}

/** Both ends on supplies whose symbols point the same way: such a part cannot stand between them. */
function betweenSupplies(nets: (Net | undefined)[]): boolean {
  const dirs = nets.map((n) => (n ? supplyDir(n) : null));
  return dirs.length === 2 && !!dirs[0] && dirs[0] === dirs[1];
}

/** The supply symbol or label at the end of a vertical lead; a supply pointing against the lead turns aside first (leadEnd). */
function endLead(scene: Scene, net: Net, x: number, y: number, dir: 'up' | 'down'): void {
  const r = leadEnd(net, x, y, dir);
  scene.wires.push(...r.wires);
  scene.labels.push(r.label);
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
export function evaluateConstraints(d: Design, sheets: SheetView[]): { status: SchematicView['constraintStatus']; why: Record<string, string> } {
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
  const why: Record<string, string> = {};
  const ref = (id?: string, unit?: string) => `${d.components[id ?? '']?.refdes ?? id}${unit ?? ''}`;
  for (const k of Object.values(d.ledger)) {
    if (k.kind === 'sch_block') {
      // the centre of the block's frame within a grid step of where it was put, on that page of its sheet
      const s = sheets.find((v) => v.id === k.sheet);
      const pg = s?.pages[(k.page ?? 1) - 1];
      const frame = s?.blocks?.find((b) => b.title === k.key);
      if (!s || !pg || !frame) {
        status[k.id] = 'not_applicable';
        continue;
      }
      const dx = frame.rect.x + frame.rect.w / 2 - (pg.rect.x + (k.x ?? 0));
      const dy = frame.rect.y + frame.rect.h / 2 - (pg.rect.y + (k.y ?? 0));
      status[k.id] = Math.abs(dx) <= GRID && Math.abs(dy) <= GRID ? 'ok' : 'violated';
      if (status[k.id] === 'violated') {
        const asked = { x: pg.rect.x + (k.x ?? 0) - frame.rect.w / 2, y: pg.rect.y + (k.y ?? 0) - frame.rect.h / 2, w: frame.rect.w, h: frame.rect.h };
        const on = s.blocks!.find((b) => b !== frame && hits(b.rect, asked));
        why[k.id] = on ? `there it would lie on block "${on.title}", so it moved aside; put one of them elsewhere` : `it does not fit there`;
      }
      continue;
    }
    if (k.kind === 'sch_position') {
      // the symbol's centre within half a grid step of where it was put, on that page of its sheet
      const s = sheets.find((v) => v.id === d.components[k.a ?? '']?.sheet);
      const sym = s?.symbols.find((x) => x.componentId === k.a && (!k.aUnit || x.unit === k.aUnit));
      const pg = s?.pages[(k.page ?? 1) - 1];
      if (!s || !sym || !pg) {
        status[k.id] = s && sym ? 'violated' : 'not_applicable';
        continue;
      }
      const dx = sym.bbox.x + sym.bbox.w / 2 - (pg.rect.x + (k.x ?? 0));
      const dy = sym.bbox.y + sym.bbox.h / 2 - (pg.rect.y + (k.y ?? 0));
      status[k.id] = Math.abs(dx) <= GRID / 2 && Math.abs(dy) <= GRID / 2 ? 'ok' : 'violated';
      // there, but on top of another part (two placements in one spot, or a part placed over one the layout put first)
      const under = s.symbols.find((o) => o !== sym && hits(o.bbox, sym.bbox));
      if (under) {
        status[k.id] = 'violated';
        why[k.id] = `${ref(k.a, k.aUnit)} lies on ${under.refdes}${under.unit ?? ''}; move one of them`;
      }
      continue;
    }
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
      if (status[k.id] === 'violated') why[k.id] = `${ref(k.a, k.aUnit)} is on page ${a.page + 1} and ${ref(k.b, k.bUnit)} on page ${b.page + 1}`;
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
    // side by side asked, but the two are on different lines: the row did not fit the page's width
    const lines = A.y >= B.y + B.h || B.y >= A.y + A.h;
    if (!ok && (k.kind === 'left_of' || k.kind === 'right_of') && lines) {
      why[k.id] = `the row is wider than the page, so the layout wrapped it and ${ref(k.a, k.aUnit)} ended up on another line than ${ref(k.b, k.bUnit)}`;
    }
  }
  return { status, why };
}
