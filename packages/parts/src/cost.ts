/**
 * What an order costs at an assembly house, and how it could cost less. The estimate is the parts
 * (the pieces the house buys: the need, its losses, at least its minimum, at their price break) and
 * every fee of each of the house's services that can take the order (setup, stencil, loading or BOM
 * lines, solder joints or placements, hand soldering); a house that publishes no fees prices the
 * order through its online quote instead (PCBWay). The cost check adds the ways to cut it: cheaper or
 * fee-free equivalents, one part number for parts that are the same, the cheaper service or fewer
 * fees if the parts sat on one side, soldering through-hole parts yourself; and parts for the
 * components that have no part number yet.
 *
 * The prices and limits are the house's entry (packages/schema/src/sourcing.ts), in its currency;
 * what they leave out (bare boards, shipping, taxes) the entry says.
 */
import {
  currencySymbol,
  feeName,
  money,
  PLACEMENT_NAMES,
  type AssemblyHouse,
  type AssemblyService,
  type BoardPart,
  type PlacementKind,
  type PriceTier,
  type SupplierPart,
  whose,
} from '@4k7/schema';
import { canReplace, checkStock, describePart, lineBuy, lineOnOrder, plentyFor, pool, rankParts, replacementQuery, stockText, type PartSource, type SourcedComponent, type StockLine, type StockReport } from './sourcing.ts';

/** A saving smaller than this (in the house's currency, on the whole order) is not worth a change. */
export const MIN_SAVING = 0.5;

/* -------------------------------------- the board -------------------------------------- */

/** What the house's fees depend on, read off the board: joints, placements, sides, layers, size, chip sizes. */
export interface AssemblyFacts {
  /** Solder joints per board of the parts the house assembles: placed by machine, and soldered by hand (through-hole). */
  smtJoints: number;
  handJoints: number;
  /** The parts with joints soldered by hand, and the machine-placed parts on the bottom side. */
  handRefs: string[];
  bottomRefs: string[];
  /** The parts the house assembles per board, by how each is placed; and those with more than 16 joints placed by machine (large ICs). */
  placements?: Partial<Record<PlacementKind, number>>;
  largeParts?: number;
  layers: number;
  /** The board's size (mm); absent when it is made in a panel (the panel's size is what counts then). */
  size?: [number, number];
  /** The chip sizes among the assembled parts ("0402"). */
  chips: string[];
  /** The single board's size (mm) whether or not it is in a panel, and whether it is. */
  boardSize?: [number, number];
  panelled?: boolean;
  /** The smallest and the largest hole on the board (vias by the rules or placed, pad and mounting holes) and what has them. */
  smallestHole?: { mm: number; what: string };
  largestHole?: { mm: number; what: string };
  /** The narrowest track or gap the design rules allow (mm), and which. */
  finest?: { mm: number; what: string };
}

/** A part as the board has it: its pads, package and side. */
type FactPart = Pick<BoardPart, 'refdes' | 'side' | 'pads' | 'pkg'> & { pkgInfo?: Pick<BoardPart['pkgInfo'], 'family' | 'pitch_mm'> };

/**
 * The facts of a board for the components the house assembles (`assembled`, by designator). `kinds`:
 * how the house's catalogue says each part is placed, where it says; the others by their package.
 */
export function assemblyFacts(
  board: {
    parts: FactPart[];
    layers: readonly unknown[];
    outline: { w: number; h: number };
    panel?: unknown;
    rules?: { viaDrill: number; track?: number; clearance?: number };
    vias?: readonly { drill: number }[];
  },
  assembled: Set<string>,
  kinds?: ReadonlyMap<string, PlacementKind>,
): AssemblyFacts {
  const f: AssemblyFacts = { smtJoints: 0, handJoints: 0, handRefs: [], bottomRefs: [], placements: {}, largeParts: 0, layers: board.layers.length, chips: [], boardSize: [board.outline.w, board.outline.h], panelled: !!board.panel };
  const hole = (mm: number | undefined, what: string) => {
    if (mm === undefined || !(mm > 0)) return;
    if (!f.smallestHole || mm < f.smallestHole.mm - 1e-9) f.smallestHole = { mm, what };
    if (!f.largestHole || mm > f.largestHole.mm + 1e-9) f.largestHole = { mm, what };
  };
  hole(board.rules?.viaDrill, 'vias');
  for (const v of board.vias ?? []) hole(v.drill, 'vias');
  for (const p of board.parts) for (const d of p.pads) hole(d.drill, `${p.refdes}'s holes`);
  for (const [mm, what] of [[board.rules?.track, 'tracks'], [board.rules?.clearance, 'gaps']] as const) if (mm !== undefined && (!f.finest || mm < f.finest.mm - 1e-9)) f.finest = { mm, what };
  for (const p of board.parts) {
    if (!assembled.has(p.refdes)) continue;
    const plated = p.pads.filter((d) => !d.npth);
    const hand = plated.filter((d) => d.drill !== undefined).length;
    const smt = plated.length - hand;
    f.smtJoints += smt;
    f.handJoints += hand;
    if (hand) f.handRefs.push(p.refdes);
    if (smt && p.side === 'bottom') f.bottomRefs.push(p.refdes);
    if (CHIPS.includes(p.pkg) && !f.chips.includes(p.pkg)) f.chips.push(p.pkg);
    const kind = kinds?.get(p.refdes) ?? placementKind(p);
    f.placements![kind] = (f.placements![kind] ?? 0) + 1;
    if (smt > 16 && !hand) f.largeParts!++;
  }
  if (!board.panel) f.size = [board.outline.w, board.outline.h];
  const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
  f.handRefs.sort(natural);
  f.bottomRefs.sort(natural);
  return f;
}

/** Chip sizes, smallest first. */
const CHIPS = ['01005', '0201', '0402', '0603', '0805', '1206', '1210', '1812', '2010', '2512'];

/**
 * How a part is placed, by its pads and package: through-hole (all its plated pads drilled), mixed,
 * BGA and QFN (fine pitch: 0.5 mm and 0.4 mm or less), fine-pitch SMD (chips of 0201 and smaller,
 * leads at 0.5 mm or less), else SMD.
 */
export function placementKind(p: Pick<FactPart, 'pads' | 'pkg' | 'pkgInfo'>): PlacementKind {
  const plated = p.pads.filter((d) => !d.npth);
  const drilled = plated.filter((d) => d.drill !== undefined).length;
  if (drilled) return drilled < plated.length ? 'mixed' : 'th';
  const family = p.pkgInfo?.family;
  const pitch = p.pkgInfo?.pitch_mm;
  if (family === 'BGA' || family === 'CSP') return pitch !== undefined && pitch <= 0.5 ? 'bgaFine' : 'bga';
  if (family === 'QFN' || family === 'DFN') return pitch !== undefined && pitch <= 0.4 ? 'qfnFine' : 'qfn';
  const chip = CHIPS.indexOf(p.pkg);
  if ((chip >= 0 && chip <= CHIPS.indexOf('0201')) || (pitch !== undefined && pitch <= 0.5)) return 'fine';
  return 'smd';
}

/** Something about the bare board that makes it cost more at the house, and what it would cost (when the house says). */
export interface BoardHint {
  what: string;
  amount?: number;
}

/** What makes this board cost more at the house: small or large holes, fine tracks, its size against the cheapest offers, a panel, a small or a large board. */
export function boardHints(facts: AssemblyFacts, house: AssemblyHouse, boards: number): BoardHint[] {
  const b = house.board;
  const size = facts.boardSize;
  if (!b) return [];
  const out: BoardHint[] = [];
  const mm = (s: readonly [number, number]) => `${s[0]} × ${s[1]} mm`;
  const sym = currencySymbol(house);
  if (b.smallHoleBelow && facts.smallestHole && facts.smallestHole.mm < b.smallHoleBelow - 1e-9) {
    out.push({ what: `${facts.smallestHole.what} have ${facts.smallestHole.mm} mm holes: ${house.name} charges extra for holes below ${b.smallHoleBelow} mm (for vias: set_board via_drill_mm ${b.smallHoleBelow} where the layout has room)` });
  }
  if (b.largeHoleAbove && facts.largestHole && facts.largestHole.mm > b.largeHoleAbove + 1e-9) {
    out.push({ what: `${facts.largestHole.what} have ${facts.largestHole.mm} mm holes: ${house.name} charges extra for holes above ${b.largeHoleAbove} mm (a slot or a milled cutout may do instead)` });
  }
  if (b.fineTrackBelow && facts.finest && facts.finest.mm < b.fineTrackBelow - 1e-9) {
    out.push({ what: `the design rules allow ${facts.finest.mm} mm ${facts.finest.what}: ${house.name} charges extra below ${b.fineTrackBelow} mm (set_board track_mm and clearance_mm ${b.fineTrackBelow} where the routing has room)` });
  }
  if (size) {
    const fits = (max: readonly [number, number]) => !outside(size, max, 'above');
    for (const o of b.offers ?? []) {
      if (!o.layers.includes(facts.layers) || fits(o.maxSize)) continue;
      // just over the offer: worth a look at the outline
      if (Math.max(...size) <= Math.max(...o.maxSize) * 1.25 && Math.min(...size) <= Math.min(...o.maxSize) * 1.25)
        out.push({ what: `the board is ${mm(size)}, just over ${mm(o.maxSize)}: ${whose(house)} cheapest offer (${o.boards} ${o.layers[0]}–${o.layers[o.layers.length - 1]}-layer boards for ${sym}${o.price}) ends there` });
    }
    if (facts.panelled && b.panelLosesPriceUpTo && fits(b.panelLosesPriceUpTo)) {
      out.push({ what: `in a panel, a board up to ${mm(b.panelLosesPriceUpTo)} loses ${whose(house)} single-board price: order single boards unless the assembly needs the panel` });
    }
    const small = [...(b.smallBoard ?? [])].sort((x, y) => x.below - y.below).find((x) => Math.min(...size) < x.below);
    if (small) out.push({ what: `the board is under ${small.below} mm on a side: ${house.name} adds ${sym}${small.fee} a board for deburring and rounding its corners`, amount: cents(small.fee * boards) });
    if (b.largeAbove && (size[0] * size[1]) / 100 > b.largeAbove) out.push({ what: `the board is over ${b.largeAbove} cm²: ${house.name} charges extra for every 50 cm² above` });
  }
  return out;
}

/* -------------------------------------- the estimate -------------------------------------- */

/** One service's price for the order; a service that cannot take it says why instead. Amounts in the house's currency. */
export interface CostEstimate {
  service: string;
  unavailable?: string;
  /** The parts, each fee, and the whole. */
  parts: number;
  fees: { name: string; amount: number }[];
  total: number;
  /** What it charges besides, not counted. */
  notCounted?: string;
  /** What the order needs for it that the design does not have yet ("a panel …"). */
  needs?: string;
  /** Priced by the house's online quote, not from its price list; with its offer for small orders. */
  quoted?: boolean;
  offer?: boolean;
}

/** What a house that prices by quote (PCBWay) is asked: the order as its quote form has it. */
export interface QuoteOrder {
  boards: number;
  sides: 1 | 2;
  /** Part numbers on the order. */
  uniqueParts: number;
  /** Per board: parts placed by machine, those of them with more than 16 joints, and parts soldered by hand. */
  smdParts: number;
  largeParts: number;
  thParts: number;
}

/** What the house's quote said: the assembly as it charges it (its offer applied), and without the offer. */
export interface AssemblyQuote {
  price: number;
  /** Without the offer, when one applied. */
  list?: number;
  /** Its lead time, as it says it ("5-6 days"). */
  days?: string;
}

/** The order a quote is asked for, from the board's facts. */
export function quoteOrder(lines: StockLine[], facts: AssemblyFacts, boards: number): QuoteOrder {
  const p = facts.placements ?? {};
  const th = (p.th ?? 0) + (p.mixed ?? 0);
  const all = Object.values(p).reduce((n, x) => n + (x ?? 0), 0);
  return { boards, sides: facts.bottomRefs.length ? 2 : 1, uniqueParts: lines.filter(lineOnOrder).length, smdParts: all - th, largeParts: facts.largeParts ?? 0, thParts: th };
}

/** The rate of the tier the count falls in (the last one beyond them all). */
export const tierRate = (tiers: readonly PriceTier[], n: number) => (tiers.find((t) => n <= t.upTo) ?? tiers[tiers.length - 1])?.each ?? 0;
const rate = tierRate;
const cents = (v: number) => Math.round(v * 100) / 100;

/** What a service charges for one part number on the order: its loading or BOM-line fees (those for a part with a fee too, when it has one). */
export function lineFees(svc: AssemblyService, p: Pick<SupplierPart, 'fee'>): number {
  return svc.loading.reduce((n, x) => n + (x.only === 'fee' && !p.fee ? 0 : x.each), 0);
}

/** What placing one more part costs a board at a service (its placement price, after any volume factor, and its joints). */
export function placementCost(svc: AssemblyService, facts: AssemblyFacts, boards: number, kind: PlacementKind, joints: number): number {
  const placed = Object.values(facts.placements ?? {}).reduce((n, x) => n + (x ?? 0), 0) * boards;
  const each = (svc.placement?.each[kind] ?? 0) * volumeFactor(svc, placed);
  return each + joints * rate(svc.smtJoint, facts.smtJoints * boards);
}

/** The placement prices' factor for an order of so many placements (1 below the first step). */
function volumeFactor(svc: AssemblyService, placed: number): number {
  const v = svc.placement?.volume;
  if (!v?.length) return 1;
  return (v.find((s) => placed <= s.upTo) ?? v[v.length - 1]!).factor;
}

/** Why a service cannot take the order, or null when it can (perhaps with what it needs: serviceNeeds). */
export function serviceProblem(svc: AssemblyService, facts: AssemblyFacts, boards: number): string | null {
  const l = svc.limits;
  if (l.sides === 1 && facts.bottomRefs.length) return `it assembles one side only (on the bottom: ${facts.bottomRefs.join(', ')})`;
  if (boards < l.boards[0] || boards > l.boards[1]) return `it takes ${l.boards[0]} to ${l.boards[1].toLocaleString('en-US')} boards an order`;
  if (l.layers && !l.layers.includes(facts.layers)) return `it assembles boards of ${l.layers.join(', ')} layers`;
  if (l.smallestChip) {
    const small = facts.chips.filter((c) => CHIPS.indexOf(c) < CHIPS.indexOf(l.smallestChip!));
    if (small.length) return `its smallest chip is ${l.smallestChip} (the board has ${small.join(', ')})`;
  }
  if (l.boardSize && facts.size && outside(facts.size, l.boardSize.max, 'above')) return `it takes boards up to ${l.boardSize.max.join(' × ')} mm (this one is ${facts.size.join(' × ')} mm)`;
  if (l.placements && facts.placements) {
    const th = ((facts.placements.th ?? 0) + (facts.placements.mixed ?? 0)) * boards;
    const smd = Object.values(facts.placements).reduce((n, x) => n + (x ?? 0), 0) * boards - th;
    if (l.placements.smd !== undefined && smd > l.placements.smd) return `it places up to ${l.placements.smd.toLocaleString('en-US')} SMD parts an order (this one has ${smd.toLocaleString('en-US')})`;
    if (l.placements.th !== undefined && th > l.placements.th) return `it places up to ${l.placements.th.toLocaleString('en-US')} through-hole parts an order (this one has ${th.toLocaleString('en-US')})`;
  }
  return null;
}

/** What a service needs for the order that the design does not have yet: a panel, for a board below its smallest single board. */
export function serviceNeeds(svc: AssemblyService, facts: AssemblyFacts): string | null {
  const b = svc.limits.boardSize;
  return b && facts.size && outside(facts.size, b.min, 'below') ? `a panel (as a single board it takes ${b.min.join(' × ')} mm and more; this one is ${facts.size.join(' × ')} mm)` : null;
}

/** A size beyond a limit, either way round: below it or above it on its long or its short side. */
function outside(size: readonly [number, number], limit: readonly [number, number], way: 'below' | 'above'): boolean {
  const [w, h] = [Math.max(...size), Math.min(...size)];
  const [lw, lh] = [Math.max(...limit), Math.min(...limit)];
  return way === 'below' ? w < lw || h < lh : w > lw || h > lh;
}

/**
 * The order at each of the house's services: the parts of the lines with a record, and the fees, in
 * cents (the whole is rounded once, as a house's calculator does). `oneSide` prices it as if every
 * part sat on the top side (what moving them would save); `quotes` are what a house that prices by
 * quote answered, by service.
 */
export function estimateOrder(
  lines: StockLine[],
  facts: AssemblyFacts,
  boards: number,
  house: AssemblyHouse,
  opts: { oneSide?: boolean; quotes?: Record<string, AssemblyQuote | Error> } = {},
): CostEstimate[] {
  return estimateExact(lines, facts, boards, house, opts).map((e) => ({ ...e, parts: cents(e.parts), fees: e.fees.map((x) => ({ ...x, amount: cents(x.amount) })), total: cents(e.total) }));
}

/** estimateOrder without the rounding: savings are the difference of two of these. */
function estimateExact(lines: StockLine[], facts: AssemblyFacts, boards: number, house: AssemblyHouse, opts: { oneSide?: boolean; quotes?: Record<string, AssemblyQuote | Error> } = {}): CostEstimate[] {
  // (a line without a record that the house buys for the order counts with a fee: On Demand)
  const placed = lines.filter(lineOnOrder);
  let parts = 0;
  for (const l of placed) parts += (l.part && lineBuy(l.part, l.need)?.cost) || 0;
  const f = opts.oneSide ? { ...facts, bottomRefs: [] } : facts;
  const both = f.bottomRefs.length > 0;
  const m = (v: number) => money(v, house);
  return house.services.map((svc): CostEstimate => {
    const problem = serviceProblem(svc, f, boards);
    if (problem) return { service: svc.name, unavailable: problem, parts, fees: [], total: NaN };
    const needs = serviceNeeds(svc, f);
    const extra = { ...(svc.notCounted ? { notCounted: svc.notCounted } : {}), ...(needs ? { needs } : {}) };
    if (svc.quoted) {
      const q = opts.quotes?.[svc.name];
      if (!q || q instanceof Error) return { service: svc.name, unavailable: `${house.name} prices it only through its online quote, which could not be read${q ? ` (${q.message})` : ''}`, parts, fees: [], total: NaN };
      const offer = q.list !== undefined && q.list > q.price;
      const name = offer ? `assembly at ${whose(house)} ${house.offer?.name ?? 'special price'} (${m(q.list!)} without it)` : `assembly, as ${whose(house)} online quote has it${q.days ? ` (${q.days})` : ''}`;
      return { service: svc.name, parts, fees: [{ name, amount: q.price }], total: parts + q.price, quoted: true, ...(offer ? { offer: true } : {}), ...extra };
    }
    const fees: CostEstimate['fees'] = [{ name: both ? 'setup, both sides' : 'setup', amount: both ? (svc.setupBothSides ?? svc.setup) : svc.setup }];
    const stencil = both ? (svc.stencilBothSides ?? svc.stencil) : svc.stencil;
    if (stencil) fees.push({ name: both ? 'stencils, both sides' : 'stencil', amount: stencil });
    for (const x of svc.loading) {
      const n = x.only === 'fee' ? placed.filter((l) => l.part?.fee ?? true).length : placed.length;
      if (n) fees.push({ name: `${feeName(x.name, n)} × ${m(x.each)}`, amount: n * x.each });
    }
    const smt = f.smtJoints * boards;
    if (smt && svc.smtJoint.length) fees.push({ name: `${smt.toLocaleString('en-US')} joints placed`, amount: smt * rate(svc.smtJoint, smt) });
    const hand = f.handJoints * boards;
    if (hand && svc.handJoint.length) fees.push({ name: `${hand.toLocaleString('en-US')} joints soldered by hand`, amount: hand * rate(svc.handJoint, hand) + svc.handLabor });
    if (svc.placement) {
      const kinds = (Object.entries(f.placements ?? {}) as [PlacementKind, number][]).filter(([, n]) => n > 0);
      const all = kinds.reduce((n, [, x]) => n + x, 0) * boards;
      const factor = volumeFactor(svc, all);
      for (const [kind, n] of kinds) {
        const each = svc.placement.each[kind] ?? 0;
        if (each) fees.push({ name: `${(n * boards).toLocaleString('en-US')} ${PLACEMENT_NAMES[kind]} placement${n * boards === 1 ? '' : 's'} × ${m(each)}${factor !== 1 ? ` × ${factor}` : ''}`, amount: n * boards * each * factor });
      }
      if (svc.placement.kind && kinds.length) fees.push({ name: `${kinds.length} kind${kinds.length === 1 ? '' : 's'} of placement (${kinds.map(([k]) => PLACEMENT_NAMES[k]).join(', ')}) × ${m(svc.placement.kind)}`, amount: kinds.length * svc.placement.kind });
    }
    if (svc.perBoard) fees.push({ name: `${boards} board${boards === 1 ? '' : 's'} × ${m(svc.perBoard)}`, amount: boards * svc.perBoard });
    if (svc.singleBoards && !f.panelled) fees.push({ name: `delivered as single boards (${m(svc.singleBoards.order)} + ${m(svc.singleBoards.board)} a board)`, amount: svc.singleBoards.order + boards * svc.singleBoards.board });
    return { service: svc.name, parts, fees, total: parts + fees.reduce((n, x) => n + x.amount, 0), ...extra };
  });
}

/** The cheapest and the dearest of the services that can take the order; null when none can. */
export function estimateRange(estimates: CostEstimate[]): { low: CostEstimate; high: CostEstimate } | null {
  const ok = estimates.filter((e) => !e.unavailable).sort((a, b) => a.total - b.total);
  return ok.length ? { low: ok[0]!, high: ok[ok.length - 1]! } : null;
}

/** The board's facts without the parts soldered by hand: what leaving them off the order changes. */
function withoutHand(f: AssemblyFacts): AssemblyFacts {
  return { ...f, handJoints: 0, handRefs: [], placements: { ...f.placements, th: 0, mixed: 0 } };
}

/** Ask the house's quote for each service it prices that way (a failed quote is kept as its error). */
export async function quoteServices(house: AssemblyHouse, source: PartSource, order: QuoteOrder): Promise<Record<string, AssemblyQuote | Error>> {
  const out: Record<string, AssemblyQuote | Error> = {};
  for (const svc of house.services.filter((s) => s.quoted)) {
    try {
      if (!source.quote) throw new Error(`no quote for ${house.name} in this version`);
      out[svc.name] = await source.quote(order);
    } catch (e) {
      out[svc.name] = e as Error;
    }
  }
  return out;
}

/* ------------------------------------- the cost check ------------------------------------- */

/** A way to make the order cheaper: a part to take on some components, or a change to the design. */
export interface Saving {
  /** cheaper: an equivalent part costs less (with its fees); merge: a part number already on the order; side: every part on one side; hand: solder through-hole parts yourself. */
  kind: 'cheaper' | 'merge' | 'side' | 'hand';
  refs: string[];
  /** The part number the components have now, and the part to take instead (none for a change to the design). */
  from?: string;
  to?: SupplierPart;
  /** What it saves on the order, in the service the savings are counted for (the house's currency). */
  saves: number;
  /** In words, for people and the agent. */
  what: string;
}

/** Components with no part number that need the same part, and parts that could be theirs, best first. */
export interface UnsourcedGroup {
  refs: string[];
  /** What they are ("10uF 1206"). */
  what: string;
  candidates: SupplierPart[];
  /** What each candidate would add to the order (its pieces and its loading or line fees), by part number; without its pieces where it has no price. */
  adds: Record<string, number>;
}

export interface CostReport {
  house: string;
  boards: number;
  at: string;
  live: boolean;
  note?: string;
  estimates: CostEstimate[];
  /** The service the savings are counted for: the cheapest that takes the order. */
  service?: string;
  savings: Saving[];
  unsourced: UnsourcedGroup[];
  /** Components without a part number and without what a search needs (a value and package, or a part number). */
  unmatched: string[];
  /** Part numbers left out of the estimate: no record (or no price). */
  unpriced: string[];
  /** What makes the bare board cost more (not in the estimate either). */
  board: BoardHint[];
  /** The house's offer for small orders took the order (its price is the estimate). */
  offer?: boolean;
  /** The stock check it ran on. */
  stock: StockReport;
}

/** Placement kinds by designator, where the house's catalogue says how it places a part. */
export function catalogueKinds(lines: StockLine[]): Map<string, PlacementKind> {
  const out = new Map<string, PlacementKind>();
  for (const l of lines) if (l.part?.placement) for (const r of l.refs) out.set(r, l.part.placement);
  return out;
}

/** A part the house gives away (its price breaks are all 0: Eurocircuits' Generic parts). */
const free = (p: SupplierPart) => p.price.length > 0 && p.price.every((b) => b.each === 0);

/**
 * The cost check: the stock check, the estimate at each service, and the ways to cut the cost.
 * `facts` reads the board for the components the house will assemble (the ones with a record), with
 * how the house's catalogue says it places them.
 */
export async function checkCost(
  components: SourcedComponent[],
  source: PartSource,
  opts: { house: AssemblyHouse; boards: number; facts: (assembled: Set<string>, kinds: ReadonlyMap<string, PlacementKind>) => AssemblyFacts; concurrency?: number; now?: () => Date },
): Promise<CostReport> {
  const { house, boards } = opts;
  const stock = await checkStock(components, source, { house, boards, ...(opts.concurrency ? { concurrency: opts.concurrency } : {}), ...(opts.now ? { now: opts.now } : {}) });
  const assembled = new Set(stock.lines.filter(lineOnOrder).flatMap((l) => l.refs));
  const facts = opts.facts(assembled, catalogueKinds(stock.lines));
  const quoted = house.services.some((s) => s.quoted);
  const quotes = quoted ? await quoteServices(house, source, quoteOrder(stock.lines, facts, boards)) : undefined;
  const exact = estimateExact(stock.lines, facts, boards, house, quotes ? { quotes } : {});
  const estimates = estimateOrder(stock.lines, facts, boards, house, quotes ? { quotes } : {});
  const range = estimateRange(exact);
  const svc = range ? house.services.find((s) => s.name === range.low.service) : undefined;
  const byRef = new Map(components.map((c) => [c.refdes, c]));
  const savings: Saving[] = [];
  const tiers = house.tiers.map((t) => t.name);

  if (svc && !svc.quoted) {
    const feeOf = (p: SupplierPart) => lineFees(svc, p);
    const placed = stock.lines.filter((l) => l.part);
    await pool(placed, opts.concurrency ?? 4, async (l) => {
      const comps = l.refs.map((r) => byRef.get(r)!);
      const q = replacementQuery(comps[0]!);
      if (!q) return;
      let found: SupplierPart[] = [];
      try {
        found = await source.search(q);
      } catch {
        return; // nothing to offer for this line
      }
      // the parts as they are; without a price (bought for the order at a house that prices it later) only the fees count, and a free part saves its price too
      const old = lineBuy(l.part!, l.need);
      // the other lines' parts are candidates too: one part number for parts that are the same.
      // A saving needs plenty of stock (STOCK_MARGIN × the need): a cheaper part about to run out is no saving.
      const others = placed.filter((o) => o !== l);
      const byNumber = new Map<string, SupplierPart>();
      for (const p of [...others.map((o) => o.part!), ...found]) if (p.sku !== l.sku && !byNumber.has(p.sku)) byNumber.set(p.sku, p);
      const candidates = [...byNumber.values()].filter((p) => plentyFor(p, l.need) && comps.every((c) => canReplace(p, c, l.part, l.need)));
      let best: { p: SupplierPart; buy: { pieces: number; cost: number }; saves: number; with?: StockLine } | null = null;
      for (const p of rankParts(candidates, tiers)) {
        const buy = lineBuy(p, l.need);
        if (!buy || (!old && !free(p))) continue;
        const shared = others.find((o) => o.sku === p.sku);
        const saved = (old ? old.cost - buy.cost : 0) + feeOf(l.part!) - (shared ? 0 : feeOf(p));
        if (!best || saved > best.saves + 1e-9) best = { p, buy, saves: saved, ...(shared ? { with: shared } : {}) };
      }
      if (!best || best.saves < MIN_SAVING) return;
      const { p, buy } = best;
      const each = old ? `${moneyEachText(buy.cost / buy.pieces, house)} a piece instead of ${moneyEachText(old.cost / old.pieces, house)}` : `free instead of ${l.part!.tier || 'its'} price`;
      const passive = comps[0]!.category === 'resistor' || comps[0]!.category === 'capacitor';
      const why = best.with
        ? `the part ${best.with.refs.join(', ')} already ${best.with.refs.length === 1 ? 'has' : 'have'}: one part number less to load`
        : l.part!.fee && !p.fee
          ? `${p.tier}: no ${old ? 'loading fee' : `${l.part!.tier} fee`}${old ? '' : `, and the part is ${free(p) ? 'free' : 'cheaper'}`}`
          : passive
            ? each
            : `${p.manufacturer ? `made by ${p.manufacturer}` : 'another listing'}, ${each}: read its datasheet first`;
      savings.push({ kind: best.with ? 'merge' : 'cheaper', refs: l.refs, from: l.sku, to: p, saves: cents(best.saves), what: `${l.refs.join(', ')}: ${p.sku}${p.mpn !== p.sku ? ` ${p.mpn}` : ''} instead of ${l.sku} (${why})` });
    });
    // two lines that could share a part number: one way round is enough, the one that saves more
    const pairs = new Map<string, Saving>();
    for (const x of savings.filter((v) => v.kind === 'merge')) {
      const key = [x.from, x.to!.sku].sort().join(' ');
      const had = pairs.get(key);
      if (!had || x.saves > had.saves) pairs.set(key, x);
    }
    for (let i = savings.length - 1; i >= 0; i--) if (savings[i]!.kind === 'merge' && pairs.get([savings[i]!.from, savings[i]!.to!.sku].sort().join(' ')) !== savings[i]) savings.splice(i, 1);
  }
  if (svc && range) {
    // every part on one side: another service takes the order, or the second side's fees go
    if (facts.bottomRefs.length) {
      const oneQuotes = quoted ? await quoteServices(house, source, { ...quoteOrder(stock.lines, facts, boards), sides: 1 }) : undefined;
      const single = estimateRange(estimateExact(stock.lines, facts, boards, house, { oneSide: true, ...(oneQuotes ? { quotes: oneQuotes } : {}) }));
      if (single && single.low.total < range.low.total - MIN_SAVING) {
        const other = single.low.service !== range.low.service;
        savings.push({
          kind: 'side',
          refs: facts.bottomRefs,
          saves: cents(range.low.total - single.low.total),
          what: `${facts.bottomRefs.join(', ')} on the top side: every part on one side, and ${other ? `${single.low.service} assembly takes the order` : `no second side to set up`}`,
        });
      }
    }
    // soldering by hand costs labour and every joint, or every through-hole placement
    if (facts.handRefs.length) {
      const handQuotes = quoted ? await quoteServices(house, source, { ...quoteOrder(stock.lines, facts, boards), thParts: 0 }) : undefined;
      const without = estimateExact(stock.lines, withoutHand(facts), boards, house, handQuotes ? { quotes: handQuotes } : {}).find((e) => e.service === range.low.service);
      const hand = without && !without.unavailable ? cents(range.low.total - without.total) : 0;
      const one = facts.handRefs.length === 1;
      if (hand >= MIN_SAVING) {
        // a house that orders by the maker's number places what the BOM lists: leaving a part off is the BOM's
        const how = house.param && !house.byMpn ? `off the order (no ${house.numberName})` : 'out of the BOM and the placement file you upload';
        savings.push({ kind: 'hand', refs: facts.handRefs, saves: hand, what: `${facts.handRefs.join(', ')} ${one ? 'is' : 'are'} soldered by hand: leave ${one ? 'it' : 'them'} ${how} and solder ${one ? 'it' : 'them'} yourself` });
      }
    }
  }
  savings.sort((a, b) => b.saves - a.saves);

  // components with no part number yet: parts that could be theirs (what a BOM tool's matching does)
  const groups = new Map<string, SourcedComponent[]>();
  const unmatched: string[] = [];
  for (const ref of stock.unsourced) {
    const c = byRef.get(ref)!;
    const q = replacementQuery(c);
    if (!q || house.noCatalogue) {
      unmatched.push(ref);
      continue;
    }
    const key = JSON.stringify([c.category, q, c.params.voltage, c.params.tolerance, c.params.dielectric, c.params.power]);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const unsourced: UnsourcedGroup[] = [];
  // what a part would add to the order: its pieces (when it has a price), and its line fees unless the order already loads it
  const loadedSkus = new Set(stock.lines.filter(lineOnOrder).map((l) => l.sku));
  const adds = (p: SupplierPart, need: number) => (lineBuy(p, need)?.cost ?? 0) + (svc && !svc.quoted && !loadedSkus.has(p.sku) ? lineFees(svc, p) : 0);
  await pool([...groups.values()], opts.concurrency ?? 4, async (comps) => {
    const c = comps[0]!;
    const need = comps.length * boards;
    let found: SupplierPart[] = [];
    try {
      found = await source.search(replacementQuery(c)!);
    } catch {
      /* listed without candidates */
    }
    // plenty of stock first, then a price known, then what it adds to the order (a fee-free part is not cheaper when its pieces
    // cost more than the fee), in steps of 5 cents: within those the deeper stock
    const short = (p: SupplierPart) => Number(!plentyFor(p, need));
    const unpriced = (p: SupplierPart) => Number(!lineBuy(p, need));
    const step = (p: SupplierPart) => Math.round(adds(p, need) * 20);
    const candidates = found
      .filter((p) => comps.every((x) => canReplace(p, x, undefined, need, { ordered: true })))
      .sort((a, b) => short(a) - short(b) || unpriced(a) - unpriced(b) || step(a) - step(b) || (b.stock ?? -1) - (a.stock ?? -1) || Number(a.fee) - Number(b.fee))
      .slice(0, 3);
    const value = c.params.resistance ?? c.params.capacitance ?? c.params.mpn ?? c.mpn ?? '';
    unsourced.push({ refs: comps.map((x) => x.refdes), what: [value, c.pkg].filter(Boolean).join(' '), candidates, adds: Object.fromEntries(candidates.map((p) => [p.sku, cents(adds(p, need))])) });
  });
  const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
  unsourced.sort((a, b) => natural(a.refs[0]!, b.refs[0]!));
  const offer = !!range?.low.offer;

  return {
    house: stock.house,
    boards,
    at: stock.at,
    live: stock.live,
    estimates,
    ...(svc ? { service: svc.name } : {}),
    savings,
    unsourced,
    unmatched,
    unpriced: stock.unpriced,
    board: boardHints(facts, house, boards),
    ...(offer ? { offer: true } : {}),
    stock,
  };
}

/* -------------------------------------- text -------------------------------------- */

const trim = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(2).replace(/0+$/, '').replace(/\.$/, ''));
/** A per-piece price with the digits small ones need: "$0.0017". */
const moneyEachText = (v: number, house: Pick<AssemblyHouse, 'currency'>) => `${currencySymbol(house)}${trim(v)}`;

/** "≈ $24–$45 for 10 boards ($2.40–$4.50 a board)", or why no service can take the order. */
export function estimateLine(estimates: CostEstimate[], boards: number, house: Pick<AssemblyHouse, 'currency'> = { currency: 'USD' }): string {
  const r = estimateRange(estimates);
  if (!r) return `no service can take this order (${estimates.map((e) => `${e.service}: ${e.unavailable}`).join('; ')})`;
  const m = (v: number) => money(v, house);
  const each = (v: number) => m(v / boards);
  const range = r.low === r.high ? m(r.low.total) : `${m(r.low.total)}–${m(r.high.total)}`;
  const per = r.low === r.high ? each(r.low.total) : `${each(r.low.total)}–${each(r.high.total)}`;
  return `≈ ${range} for ${boards} board${boards === 1 ? '' : 's'} (${per} a board${r.low === r.high ? `, ${r.low.service}` : `, ${r.low.service} to ${r.high.service}`})`;
}

/** One service's estimate in a line: "$24.12 = parts $3.61 + setup $8.18 + …", or why it cannot take the order. */
export function estimateText(e: CostEstimate, house: Pick<AssemblyHouse, 'currency'> = { currency: 'USD' }): string {
  if (e.unavailable) return `${e.service}: cannot take this order: ${e.unavailable}`;
  const m = (v: number) => money(v, house);
  return `${e.service}: ${m(e.total)} = parts ${m(e.parts)} + ${e.fees.map((f) => `${f.name} ${m(f.amount)}`).join(' + ')}${e.needs ? `; it needs ${e.needs}` : ''}${e.notCounted ? ` (not counted: ${e.notCounted})` : ''}`;
}

/** The cost check for the agent: the estimate, what could make it cheaper, parts for the components without a number. */
export function costReportText(r: CostReport, house: AssemblyHouse): string {
  const out: string[] = [];
  const m = (v: number) => money(v, house);
  out.push(
    `Cost of ${r.boards} board${r.boards === 1 ? '' : 's'} at ${r.house} (${r.at.slice(0, 16).replace('T', ' ')} UTC${r.live ? ', prices read just now' : `, NOT all live${r.note ? `: ${r.note}` : ''}`}): ${estimateLine(r.estimates, r.boards, house)}.`,
  );
  out.push(...r.estimates.map((e) => `- ${estimateText(e, house)}`));
  if (r.offer && house.offer) out.push(`The ${house.offer.name}: ${house.offer.terms} (${house.offer.url}).`);
  if (r.unpriced.length && !house.noCatalogue) out.push(`Not priced (no record or no price): ${r.unpriced.join(', ')}.`);
  out.push(`Not included: ${house.notInEstimate}. Fees as ${whose(house)} ${house.prices.name ?? 'price page'} gave them ${house.services.some((s) => s.quoted) ? 'just now' : `on ${house.prices.checked}`} (${house.prices.url}).`);
  if (r.savings.length) {
    const side = r.savings.find((x) => x.kind === 'side');
    out.push(
      `Cheaper (counted for ${r.service}; up to ${m(r.savings.reduce((n, s) => n + s.saves, 0))} in all, savings overlap where they touch the same parts` +
        `${side ? `; after moving parts to one side another service may count the fees, so check the cost again then` : ''}):`,
    );
    for (const s of r.savings) out.push(`- ${s.what}: saves ${m(s.saves)}${s.to ? `. ${describePart(s.to, house)}` : ''}`);
  } else if (r.service) out.push(`Nothing found that would make it cheaper by ${m(MIN_SAVING)} or more.`);
  if (r.board.length) {
    out.push(`The bare board (not in the estimate; ${whose(house)} surcharges as of ${house.board?.source.checked}):`);
    for (const h of r.board) out.push(`- ${h.what}${h.amount ? ` (≈ ${m(h.amount)} for ${r.boards} boards)` : ''}`);
  }
  if (r.unsourced.length || r.unmatched.length) {
    const none = house.byMpn && house.param ? `No ${house.numberName} and no manufacturer part number` : `No ${house.numberName}`;
    out.push(`${none} (not on the order; ${house.name} does not assemble them${house.byMpn ? '' : ' from its stock'}):`);
    for (const g of r.unsourced) {
      const each = (p: SupplierPart) => `${p.sku}${p.mpn !== p.sku ? ` ${p.mpn}` : ''} (${p.tier || 'no class'}, ${stockText(p)}${g.adds[p.sku] !== undefined ? `, adds ${m(g.adds[p.sku]!)}${lineBuy(p, 1) ? '' : ' and its price'} to the order` : ''})`;
      out.push(`- ${g.refs.join(', ')} (${g.what}): ${g.candidates.length ? g.candidates.map(each).join(' | ') : 'no part found in stock'}`);
    }
    if (r.unmatched.length) out.push(`- ${r.unmatched.join(', ')}: nothing to search by (no value and package, no part number)`);
  }
  if (house.param && (r.savings.some((s) => s.to) || r.unsourced.some((g) => g.candidates.length))) out.push(`To take a part: design_edit set_param ${house.param} on the components named.`);
  return out.join('\n');
}
