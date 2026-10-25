/**
 * What an order costs at an assembly house, and how it could cost less. The estimate is the parts
 * (the pieces the house buys: the need, its losses, at least its minimum, at their price break) and
 * every fee of each of the house's services that can take the order (setup, stencil, loading, solder
 * joints, hand soldering). The cost check adds the ways to cut it: cheaper or fee-free equivalents,
 * one part number for parts that are the same, the cheaper service if the parts sat on one side,
 * soldering through-hole parts yourself; and parts for the components that have no part number yet.
 *
 * The prices and limits are the house's entry (packages/schema/src/sourcing.ts); what they leave out
 * (bare boards, shipping, taxes) the entry says.
 */
import { STOCK_MARGIN, type AssemblyHouse, type AssemblyService, type BoardPart, type PriceTier, type SupplierPart } from '@4k7/schema';
import { canReplace, checkStock, describePart, lineBuy, pool, rankParts, replacementQuery, stockText, type PartSource, type SourcedComponent, type StockLine, type StockReport } from './sourcing.ts';

/** A saving smaller than this (USD, on the whole order) is not worth a change. */
export const MIN_SAVING = 0.5;

/* -------------------------------------- the board -------------------------------------- */

/** What the house's fees depend on, read off the board: joints, sides, layers, size, chip sizes. */
export interface AssemblyFacts {
  /** Solder joints per board of the parts the house assembles: placed by machine, and soldered by hand (through-hole). */
  smtJoints: number;
  handJoints: number;
  /** The parts with joints soldered by hand, and the machine-placed parts on the bottom side. */
  handRefs: string[];
  bottomRefs: string[];
  layers: number;
  /** The board's size (mm); absent when it is made in a panel (the panel's size is what counts then). */
  size?: [number, number];
  /** The chip sizes among the assembled parts ("0402"). */
  chips: string[];
  /** The single board's size (mm) whether or not it is in a panel, and whether it is. */
  boardSize?: [number, number];
  panelled?: boolean;
  /** The smallest hole on the board (vias by the rules or placed, pad and mounting holes) and what has it. */
  smallestHole?: { mm: number; what: string };
}

/** The facts of a board for the components the house assembles (`assembled`, by designator). */
export function assemblyFacts(
  board: {
    parts: Pick<BoardPart, 'refdes' | 'side' | 'pads' | 'pkg'>[];
    layers: readonly unknown[];
    outline: { w: number; h: number };
    panel?: unknown;
    rules?: { viaDrill: number };
    vias?: readonly { drill: number }[];
  },
  assembled: Set<string>,
): AssemblyFacts {
  const f: AssemblyFacts = { smtJoints: 0, handJoints: 0, handRefs: [], bottomRefs: [], layers: board.layers.length, chips: [], boardSize: [board.outline.w, board.outline.h], panelled: !!board.panel };
  const hole = (mm: number | undefined, what: string) => {
    if (mm !== undefined && mm > 0 && (!f.smallestHole || mm < f.smallestHole.mm - 1e-9)) f.smallestHole = { mm, what };
  };
  hole(board.rules?.viaDrill, 'vias');
  for (const v of board.vias ?? []) hole(v.drill, 'vias');
  for (const p of board.parts) for (const d of p.pads) hole(d.drill, `${p.refdes}'s holes`);
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
  }
  if (!board.panel) f.size = [board.outline.w, board.outline.h];
  const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
  f.handRefs.sort(natural);
  f.bottomRefs.sort(natural);
  return f;
}

/** Chip sizes, smallest first. */
const CHIPS = ['01005', '0201', '0402', '0603', '0805', '1206', '1210', '1812', '2010', '2512'];

/** Something about the bare board that makes it cost more at the house, and what it would cost (when the house says). */
export interface BoardHint {
  what: string;
  usd?: number;
}

/** What makes this board cost more at the house: small holes, its size against the cheapest offers, a panel, a small or a large board. */
export function boardHints(facts: AssemblyFacts, house: AssemblyHouse, boards: number): BoardHint[] {
  const b = house.board;
  const size = facts.boardSize;
  if (!b) return [];
  const out: BoardHint[] = [];
  const mm = (s: readonly [number, number]) => `${s[0]} × ${s[1]} mm`;
  if (b.smallHoleBelow && facts.smallestHole && facts.smallestHole.mm < b.smallHoleBelow - 1e-9) {
    out.push({ what: `${facts.smallestHole.what} have ${facts.smallestHole.mm} mm holes: ${house.name} charges extra for holes below ${b.smallHoleBelow} mm (for vias: set_board via_drill_mm ${b.smallHoleBelow} where the layout has room)` });
  }
  if (size) {
    const fits = (max: readonly [number, number]) => !outside(size, max, 'above');
    for (const o of b.offers ?? []) {
      if (!o.layers.includes(facts.layers) || fits(o.maxSize)) continue;
      // just over the offer: worth a look at the outline
      if (Math.max(...size) <= Math.max(...o.maxSize) * 1.25 && Math.min(...size) <= Math.min(...o.maxSize) * 1.25)
        out.push({ what: `the board is ${mm(size)}, just over ${mm(o.maxSize)}: ${house.name}'s cheapest offer (${o.boards} ${o.layers[0]}–${o.layers[o.layers.length - 1]}-layer boards for $${o.usd}) ends there` });
    }
    if (facts.panelled && b.panelLosesPriceUpTo && fits(b.panelLosesPriceUpTo)) {
      out.push({ what: `in a panel, a board up to ${mm(b.panelLosesPriceUpTo)} loses ${house.name}'s single-board price: order single boards unless the assembly needs the panel` });
    }
    const small = [...(b.smallBoard ?? [])].sort((x, y) => x.below - y.below).find((x) => Math.min(...size) < x.below);
    if (small) out.push({ what: `the board is under ${small.below} mm on a side: ${house.name} adds $${small.usd} a board for deburring and rounding its corners`, usd: cents(small.usd * boards) });
    if (b.largeAbove && (size[0] * size[1]) / 100 > b.largeAbove) out.push({ what: `the board is over ${b.largeAbove} cm²: ${house.name} charges extra for every 50 cm² above` });
  }
  return out;
}

/* -------------------------------------- the estimate -------------------------------------- */

/** One service's price for the order; a service that cannot take it says why instead. */
export interface CostEstimate {
  service: string;
  unavailable?: string;
  /** USD: the parts, each fee, and the whole. */
  parts: number;
  fees: { name: string; usd: number }[];
  total: number;
  /** What it charges besides, not counted. */
  notCounted?: string;
  /** What the order needs for it that the design does not have yet ("a panel …"). */
  needs?: string;
}

/** The rate of the tier the count falls in (the last one beyond them all). */
export const tierRate = (tiers: readonly PriceTier[], n: number) => (tiers.find((t) => n <= t.upTo) ?? tiers[tiers.length - 1])?.usd ?? 0;
const rate = tierRate;
const cents = (v: number) => Math.round(v * 100) / 100;

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
 * The order at each of the house's services: the parts of the lines with a record, and the fees.
 * `oneSide` prices it as if every part sat on the top side (what moving them would save).
 */
export function estimateOrder(lines: StockLine[], facts: AssemblyFacts, boards: number, house: AssemblyHouse, opts: { oneSide?: boolean } = {}): CostEstimate[] {
  const placed = lines.filter((l) => l.part);
  let parts = 0;
  for (const l of placed) parts += lineBuy(l.part!, l.need)?.usd ?? 0;
  const f = opts.oneSide ? { ...facts, bottomRefs: [] } : facts;
  const both = f.bottomRefs.length > 0;
  return house.services.map((svc): CostEstimate => {
    const problem = serviceProblem(svc, f, boards);
    if (problem) return { service: svc.name, unavailable: problem, parts: cents(parts), fees: [], total: NaN };
    const fees: CostEstimate['fees'] = [
      { name: both ? 'setup, both sides' : 'setup', usd: both ? (svc.setupBothSides ?? svc.setup) : svc.setup },
      { name: both ? 'stencils, both sides' : 'stencil', usd: both ? (svc.stencilBothSides ?? svc.stencil) : svc.stencil },
    ];
    const loaded = svc.loading.per === 'fee' ? placed.filter((l) => l.part!.fee) : placed;
    if (loaded.length) fees.push({ name: `loading ${loaded.length} part number${loaded.length === 1 ? '' : 's'} × $${svc.loading.usd}`, usd: loaded.length * svc.loading.usd });
    const smt = f.smtJoints * boards;
    if (smt) fees.push({ name: `${smt.toLocaleString('en-US')} joints placed`, usd: smt * rate(svc.smtJoint, smt) });
    const hand = f.handJoints * boards;
    if (hand) fees.push({ name: `${hand.toLocaleString('en-US')} joints soldered by hand`, usd: hand * rate(svc.handJoint, hand) + svc.handLabor });
    const total = parts + fees.reduce((n, x) => n + x.usd, 0);
    const needs = serviceNeeds(svc, f);
    return { service: svc.name, parts: cents(parts), fees: fees.map((x) => ({ ...x, usd: cents(x.usd) })), total: cents(total), ...(svc.notCounted ? { notCounted: svc.notCounted } : {}), ...(needs ? { needs } : {}) };
  });
}

/** The cheapest and the dearest of the services that can take the order; null when none can. */
export function estimateRange(estimates: CostEstimate[]): { low: CostEstimate; high: CostEstimate } | null {
  const ok = estimates.filter((e) => !e.unavailable).sort((a, b) => a.total - b.total);
  return ok.length ? { low: ok[0]!, high: ok[ok.length - 1]! } : null;
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
  /** USD saved on the order, in the service the savings are counted for. */
  usd: number;
  /** In words, for people and the agent. */
  what: string;
}

/** Components with no part number that need the same part, and parts that could be theirs, best first. */
export interface UnsourcedGroup {
  refs: string[];
  /** What they are ("10uF 1206"). */
  what: string;
  candidates: SupplierPart[];
  /** What each candidate would add to the order (its pieces and its loading fee, USD), by part number. */
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
  /** The stock check it ran on. */
  stock: StockReport;
}

/**
 * The cost check: the stock check, the estimate at each service, and the ways to cut the cost.
 * `facts` reads the board for the components the house will assemble (the ones with a record).
 */
export async function checkCost(
  components: SourcedComponent[],
  source: PartSource,
  opts: { house: AssemblyHouse; boards: number; facts: (assembled: Set<string>) => AssemblyFacts; concurrency?: number; now?: () => Date },
): Promise<CostReport> {
  const { house, boards } = opts;
  const stock = await checkStock(components, source, { house, boards, ...(opts.concurrency ? { concurrency: opts.concurrency } : {}), ...(opts.now ? { now: opts.now } : {}) });
  const facts = opts.facts(new Set(stock.lines.filter((l) => l.part).flatMap((l) => l.refs)));
  const estimates = estimateOrder(stock.lines, facts, boards, house);
  const range = estimateRange(estimates);
  const svc = range ? house.services.find((s) => s.name === range.low.service) : undefined;
  const byRef = new Map(components.map((c) => [c.refdes, c]));
  const savings: Saving[] = [];
  const tiers = house.tiers.map((t) => t.name);

  if (svc) {
    const feeOf = (p: SupplierPart) => (svc.loading.per === 'part' || p.fee ? svc.loading.usd : 0);
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
      const old = lineBuy(l.part!, l.need);
      if (!old) return;
      // the other lines' parts are candidates too: one part number for parts that are the same.
      // A saving needs plenty of stock (STOCK_MARGIN × the need): a cheaper part about to run out is no saving.
      const others = placed.filter((o) => o !== l);
      const byNumber = new Map<string, SupplierPart>();
      for (const p of [...others.map((o) => o.part!), ...found]) if (p.sku !== l.sku && !byNumber.has(p.sku)) byNumber.set(p.sku, p);
      const candidates = [...byNumber.values()].filter((p) => p.stock !== null && p.stock >= l.need * STOCK_MARGIN && comps.every((c) => canReplace(p, c, l.part, l.need)));
      let best: { p: SupplierPart; buy: { pieces: number; usd: number }; usd: number; with?: StockLine } | null = null;
      for (const p of rankParts(candidates, tiers)) {
        const buy = lineBuy(p, l.need);
        if (!buy) continue;
        const shared = others.find((o) => o.sku === p.sku);
        const saved = old.usd + feeOf(l.part!) - (buy.usd + (shared ? 0 : feeOf(p)));
        if (!best || saved > best.usd + 1e-9) best = { p, buy, usd: saved, ...(shared ? { with: shared } : {}) };
      }
      if (!best || best.usd < MIN_SAVING) return;
      const { p, buy } = best;
      const each = `$${trim(buy.usd / buy.pieces)} a piece instead of $${trim(old.usd / old.pieces)}`;
      const passive = comps[0]!.category === 'resistor' || comps[0]!.category === 'capacitor';
      const why = best.with
        ? `the part ${best.with.refs.join(', ')} already ${best.with.refs.length === 1 ? 'has' : 'have'}: one part number less to load`
        : l.part!.fee && !p.fee
          ? `${p.tier}: no loading fee`
          : passive
            ? each
            : `${p.manufacturer ? `made by ${p.manufacturer}` : 'another listing'}, ${each}: read its datasheet first`;
      savings.push({ kind: best.with ? 'merge' : 'cheaper', refs: l.refs, from: l.sku, to: p, usd: cents(best.usd), what: `${l.refs.join(', ')}: ${p.sku} ${p.mpn} instead of ${l.sku} (${why})` });
    });
    // two lines that could share a part number: one way round is enough, the one that saves more
    const pairs = new Map<string, Saving>();
    for (const x of savings.filter((v) => v.kind === 'merge')) {
      const key = [x.from, x.to!.sku].sort().join(' ');
      const had = pairs.get(key);
      if (!had || x.usd > had.usd) pairs.set(key, x);
    }
    for (let i = savings.length - 1; i >= 0; i--) if (savings[i]!.kind === 'merge' && pairs.get([savings[i]!.from, savings[i]!.to!.sku].sort().join(' ')) !== savings[i]) savings.splice(i, 1);

    // the service a single side would allow
    if (facts.bottomRefs.length) {
      const single = estimateRange(estimateOrder(stock.lines, facts, boards, house, { oneSide: true }));
      if (single && single.low.total < range!.low.total - MIN_SAVING) {
        savings.push({
          kind: 'side',
          refs: facts.bottomRefs,
          usd: cents(range!.low.total - single.low.total),
          what: `${facts.bottomRefs.join(', ')} on the top side: every part on one side, and ${single.low.service} assembly takes the order`,
        });
      }
    }
    // soldering by hand costs labour and every joint
    if (facts.handJoints) {
      const joints = facts.handJoints * boards;
      const hand = cents(joints * rate(svc.handJoint, joints) + svc.handLabor);
      const one = facts.handRefs.length === 1;
      if (hand >= MIN_SAVING) savings.push({ kind: 'hand', refs: facts.handRefs, usd: hand, what: `${facts.handRefs.join(', ')} ${one ? 'is' : 'are'} soldered by hand: leave ${one ? 'it' : 'them'} off the order (no ${house.numberName}) and solder ${one ? 'it' : 'them'} yourself` });
    }
  }
  savings.sort((a, b) => b.usd - a.usd);

  // components with no part number yet: parts that could be theirs (what a BOM tool's matching does)
  const groups = new Map<string, SourcedComponent[]>();
  const unmatched: string[] = [];
  for (const ref of stock.unsourced) {
    const c = byRef.get(ref)!;
    const q = replacementQuery(c);
    if (!q) {
      unmatched.push(ref);
      continue;
    }
    const key = JSON.stringify([c.category, q, c.params.voltage, c.params.tolerance, c.params.dielectric, c.params.power]);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const unsourced: UnsourcedGroup[] = [];
  // what a part would add to the order: its pieces, and its loading fee unless the order already loads it
  const loadedSkus = new Set(stock.lines.filter((l) => l.part).map((l) => l.sku));
  const adds = (p: SupplierPart, need: number) => (lineBuy(p, need)?.usd ?? Infinity) + (svc && !loadedSkus.has(p.sku) && (svc.loading.per === 'part' || p.fee) ? svc.loading.usd : 0);
  await pool([...groups.values()], opts.concurrency ?? 4, async (comps) => {
    const c = comps[0]!;
    const need = comps.length * boards;
    let found: SupplierPart[] = [];
    try {
      found = await source.search(replacementQuery(c)!);
    } catch {
      /* listed without candidates */
    }
    // plenty of stock first, then what it adds to the order (a fee-free part is not cheaper when its pieces cost more
    // than the fee), in steps of 5 cents: within those the deeper stock
    const short = (p: SupplierPart) => Number(p.stock! < need * STOCK_MARGIN);
    const step = (p: SupplierPart) => Math.round(adds(p, need) * 20);
    const candidates = found
      .filter((p) => comps.every((x) => canReplace(p, x, undefined, need)))
      .sort((a, b) => short(a) - short(b) || step(a) - step(b) || b.stock! - a.stock! || Number(a.fee) - Number(b.fee))
      .slice(0, 3);
    const value = c.params.resistance ?? c.params.capacitance ?? c.params.mpn ?? c.mpn ?? '';
    unsourced.push({ refs: comps.map((x) => x.refdes), what: [value, c.pkg].filter(Boolean).join(' '), candidates, adds: Object.fromEntries(candidates.map((p) => [p.sku, cents(adds(p, need))])) });
  });
  const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
  unsourced.sort((a, b) => natural(a.refs[0]!, b.refs[0]!));

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
    stock,
  };
}

/* -------------------------------------- text -------------------------------------- */

const usd = (v: number) => `$${v.toFixed(2)}`;
const trim = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(2).replace(/0+$/, '').replace(/\.$/, ''));

/** "≈ $24–$45 for 10 boards ($2.40–$4.50 a board)", or why no service can take the order. */
export function estimateLine(estimates: CostEstimate[], boards: number): string {
  const r = estimateRange(estimates);
  if (!r) return `no service can take this order (${estimates.map((e) => `${e.service}: ${e.unavailable}`).join('; ')})`;
  const each = (v: number) => usd(v / boards);
  const range = r.low === r.high ? usd(r.low.total) : `${usd(r.low.total)}–${usd(r.high.total)}`;
  const per = r.low === r.high ? each(r.low.total) : `${each(r.low.total)}–${each(r.high.total)}`;
  return `≈ ${range} for ${boards} board${boards === 1 ? '' : 's'} (${per} a board${r.low === r.high ? `, ${r.low.service}` : `, ${r.low.service} to ${r.high.service}`})`;
}

/** One service's estimate in a line: "$24.12 = parts $3.61 + setup $8.18 + …", or why it cannot take the order. */
export function estimateText(e: CostEstimate): string {
  if (e.unavailable) return `${e.service}: cannot take this order: ${e.unavailable}`;
  return `${e.service}: ${usd(e.total)} = parts ${usd(e.parts)} + ${e.fees.map((f) => `${f.name} ${usd(f.usd)}`).join(' + ')}${e.needs ? `; it needs ${e.needs}` : ''}${e.notCounted ? ` (not counted: ${e.notCounted})` : ''}`;
}

/** The cost check for the agent: the estimate, what could make it cheaper, parts for the components without a number. */
export function costReportText(r: CostReport, house: AssemblyHouse): string {
  const out: string[] = [];
  out.push(
    `Cost of ${r.boards} board${r.boards === 1 ? '' : 's'} at ${r.house} (${r.at.slice(0, 16).replace('T', ' ')} UTC${r.live ? ', prices read just now' : `, NOT all live${r.note ? `: ${r.note}` : ''}`}): ${estimateLine(r.estimates, r.boards)}.`,
  );
  out.push(...r.estimates.map((e) => `- ${estimateText(e)}`));
  if (r.unpriced.length) out.push(`Not priced (no record or no price): ${r.unpriced.join(', ')}.`);
  out.push(`Not included: ${house.notInEstimate}. Fees as ${house.name}'s price page gave them on ${house.prices.checked} (${house.prices.url}).`);
  if (r.savings.length) {
    const side = r.savings.find((x) => x.kind === 'side');
    out.push(
      `Cheaper (counted for ${r.service}; up to ${usd(r.savings.reduce((n, s) => n + s.usd, 0))} in all, savings overlap where they touch the same parts` +
        `${side ? `; after moving parts to one side another service counts the fees, so check the cost again then` : ''}):`,
    );
    for (const s of r.savings) out.push(`- ${s.what}: saves ${usd(s.usd)}${s.to ? `. ${describePart(s.to)}` : ''}`);
  } else if (r.service) out.push('Nothing found that would make it cheaper by $0.50 or more.');
  if (r.board.length) {
    out.push(`The bare board (not in the estimate; ${house.name}'s surcharges as of ${house.board?.source.checked}):`);
    for (const h of r.board) out.push(`- ${h.what}${h.usd ? ` (≈ ${usd(h.usd)} for ${r.boards} boards)` : ''}`);
  }
  if (r.unsourced.length || r.unmatched.length) {
    out.push(`No ${house.numberName} (not on the order; ${house.name} does not assemble them from its stock):`);
    for (const g of r.unsourced) out.push(`- ${g.refs.join(', ')} (${g.what}): ${g.candidates.length ? g.candidates.map((p) => `${p.sku} ${p.mpn} (${p.tier || 'no class'}, ${stockText(p)}${g.adds[p.sku] !== undefined ? `, adds ${usd(g.adds[p.sku]!)} to the order` : ''})`).join(' | ') : 'no part found in stock'}`);
    if (r.unmatched.length) out.push(`- ${r.unmatched.join(', ')}: nothing to search by (no value and package, no part number)`);
  }
  if (r.savings.some((s) => s.to) || r.unsourced.some((g) => g.candidates.length)) out.push(`To take a part: design_edit set_param ${house.param} on the components named.`);
  return out.join('\n');
}
