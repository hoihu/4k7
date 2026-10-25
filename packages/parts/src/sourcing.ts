/**
 * Sourcing for any assembly house: ranking catalogue results, checking a part against the component
 * it is for, and the stock check of a whole design before it is ordered (every part looked up now,
 * replacements for the ones in trouble). What is particular to a house comes from its AssemblyHouse
 * entry (packages/schema/src/sourcing.ts) and its catalogue, a PartSource (JLCPCB: jlc.ts).
 */
import { currencySymbol, money, parseQuantity, STOCK_MARGIN, type AssemblyHouse, type PartCard, type PartCategory, type PartQuery, type SupplierPart } from '@4k7/schema';
import type { AssemblyQuote, CostEstimate, QuoteOrder } from './cost.ts';

/** A house's catalogue. */
export interface PartSource {
  search(q: PartQuery): Promise<SupplierPart[]>;
  /** One part by the house's number; null when the catalogue does not know it. */
  lookup(sku: string): Promise<SupplierPart | null>;
  /** The house's online quote for assembling an order, at a house that publishes no fees (PCBWay). */
  quote?(order: QuoteOrder): Promise<AssemblyQuote>;
}

/**
 * The first source, and the second when the first fails (it cannot be reached, or answers in a form
 * this version does not read). `note` hears why the first failed, and null when it answered.
 */
export function withFallback(first: PartSource, second: PartSource, note?: (why: string | null) => void): PartSource {
  const run = async <T>(a: () => Promise<T>, b: () => Promise<T>): Promise<T> => {
    let r: T;
    try {
      r = await a();
    } catch (e) {
      note?.((e as Error).message);
      return b();
    }
    note?.(null);
    return r;
  };
  return {
    search: (q) => run(() => first.search(q), () => second.search(q)),
    lookup: (sku) => run(() => first.lookup(sku), () => second.lookup(sku)),
    ...(first.quote ? { quote: first.quote.bind(first) } : {}),
  };
}

/** Fee-free first, in the house's order of classes, then the deepest stock; unknown stock after known. */
export function rankParts(parts: SupplierPart[], tiers: readonly string[] = []): SupplierPart[] {
  const rank = (p: SupplierPart) => (tiers.includes(p.tier) ? tiers.indexOf(p.tier) : tiers.length);
  return [...parts].sort((a, b) => Number(a.fee) - Number(b.fee) || rank(a) - rank(b) || (b.stock ?? -1) - (a.stock ?? -1) || a.sku.localeCompare(b.sku));
}

/**
 * The pieces the house buys for `need` (the need and its losses in assembly, at least the fewest it
 * assembles from) and what they cost at their price break; null without a price.
 */
export function lineBuy(p: SupplierPart, need: number): { pieces: number; cost: number } | null {
  const pieces = Math.max(need + (p.attrition ?? 0), p.minQty ?? 0);
  const unit = unitPrice(p, pieces);
  return unit === undefined ? null : { pieces, cost: unit * pieces };
}

/** The price per piece when buying `qty` (the break for that quantity; below the first break, its price). */
export function unitPrice(p: SupplierPart, qty: number): number | undefined {
  let each: number | undefined;
  for (const b of p.price) if (each === undefined || b.qty <= qty) each = b.each;
  return each;
}

/** The house has `need` pieces for the order: counted in stock, or kept in its own stock (no count published). */
export const hasFor = (p: SupplierPart, need: number) => (p.stock !== null ? p.stock >= need : p.supply === 'stock');
/** … with room to spare: STOCK_MARGIN × the need, or kept in stock. */
export const plentyFor = (p: SupplierPart, need: number) => (p.stock !== null ? p.stock >= need * STOCK_MARGIN : p.supply === 'stock');

/* ------------------------------ part against component ------------------------------ */

/**
 * Why a catalogue part does not fit a component: value (resistance, capacitance, inductance),
 * a capacitor's voltage rating below what the design asks, or the package. Empty = it fits.
 */
export function sourcingMismatch(card: Pick<PartCard, 'category'>, params: Record<string, string>, effectivePackage: string | undefined, part: SupplierPart): string[] {
  const out: string[] = [];
  const valueKey = passiveValueKey(card.category);
  const attrKey = valueKey === 'resistance' ? 'Resistance' : valueKey === 'capacitance' ? 'Capacitance' : 'Inductance';
  if (valueKey && params[valueKey]) {
    const want = parseQuantity(params[valueKey]);
    const haveText = part.attributes[attrKey] ?? part.attributes.Value;
    const have = haveText ? parseQuantity(haveText) : null;
    const unitsDiffer = !!(want?.unit && have?.unit && want.unit !== have.unit);
    if (want && have && (unitsDiffer || !closeTo(want.value, have.value))) out.push(`${valueKey}: the part is ${haveText}, the component ${params[valueKey]}`);
  }
  if (card.category === 'capacitor' && params.voltage && part.attributes['Voltage Rated']) {
    const want = parseQuantity(params.voltage);
    const have = parseQuantity(part.attributes['Voltage Rated']);
    if (want && have && have.value < want.value * 0.999) out.push(`voltage: the part is rated ${part.attributes['Voltage Rated']}, the component asks for ${params.voltage}`);
  }
  if (effectivePackage && part.package && !samePackage(effectivePackage, part.package)) out.push(`package: the part is ${part.package}, the component ${effectivePackage}`);
  return out;
}

const passiveValueKey = (c: PartCategory | undefined) => (c === 'resistor' ? 'resistance' : c === 'capacitor' ? 'capacitance' : c === 'inductor' ? 'inductance' : null);
const closeTo = (a: number, b: number) => Math.abs(a - b) <= 0.005 * Math.max(Math.abs(a), Math.abs(b));
const normPkg = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
/**
 * Two names for the same package: the same letters and digits, or a family named alone ("SOIC", as
 * Eurocircuits lists many parts) and a name of that family ("SOIC-8"). "SOT-23" and "SOT-23-5" differ.
 */
export function samePackage(a: string, b: string): boolean {
  const [x, y] = [normPkg(a), normPkg(b)];
  const family = (s: string) => /^[A-Z]+$/.test(s);
  return x === y || (family(x) && y.startsWith(x)) || (family(y) && x.startsWith(y));
}
const normMpn = (s: string) => s.toUpperCase().replace(/\s+/g, '');

/* ----------------------------------- the stock check ----------------------------------- */

/** A component as the stock check sees it. */
export interface SourcedComponent {
  refdes: string;
  category?: PartCategory;
  params: Record<string, string>;
  /** The package it has (a generic part's pick or default, else its card's). */
  pkg?: string;
  mpn?: string;
}

/**
 * How a part stands against what the boards need: `low` is enough now but under STOCK_MARGIN × the
 * need; `ordered`, the house buys it for the order (it checks the supply then); a part the house keeps
 * in its own stock without a count is `ok`.
 */
export type StockState = 'ok' | 'low' | 'short' | 'out' | 'unknown' | 'ordered';

export function stockState(stock: number | null, need: number, supply?: SupplierPart['supply']): StockState {
  if (stock === null) return supply === 'stock' ? 'ok' : supply === 'order' ? 'ordered' : 'unknown';
  if (stock <= 0) return 'out';
  if (stock < need) return 'short';
  return stock < need * STOCK_MARGIN ? 'low' : 'ok';
}

/** The components that share one part number, and how that part stands. */
export interface StockLine {
  sku: string;
  refs: string[];
  /** Pieces for all the boards. */
  need: number;
  /** The catalogue's record now; null when the catalogue does not list the number; absent when it could not be read (`error`). */
  part?: SupplierPart | null;
  error?: string;
  /** `missing`: not in the catalogue; `failed`: could not be looked up. */
  state: StockState | 'missing' | 'failed';
  /** Why the part does not fit its components (value, voltage, package), with the refs when only some. */
  mismatch: string[];
  /** What else wants a look: the maker has made the part obsolete, or no longer recommends it. */
  warnings?: string[];
  /** In-stock parts that could take its place, best first. */
  replacements: SupplierPart[];
  /** What the replacements have in common with the part ("same resistance and package"). */
  replacementBasis?: string;
}

export interface StockReport {
  house: string;
  boards: number;
  /** When the parts were looked up (ISO). */
  at: string;
  lines: StockLine[];
  /** Components without a part number: the house does not assemble them from its stock. */
  unsourced: string[];
  /** Every part was read from the house's own catalogue just now (none failed, none came from a mirror). */
  live: boolean;
  /** Why the house's own catalogue could not be read, when it could not (the app fills it in). */
  note?: string;
  /** The parts for all the boards at today's prices (in the house's currency, without fees: the pieces the house buys, see lineBuy), of the lines with a price; absent when none has one. */
  cost?: number;
  /** The part numbers the cost leaves out: no price (or no record). */
  unpriced: string[];
  /** The order at each of the house's services, when the board was known (see cost.ts). */
  estimates?: CostEstimate[];
}

/** Lines that need a look: anything but plenty in stock (or bought for the order), fitting, fee-free, current. */
export const lineNeedsAttention = (l: StockLine) => (l.state !== 'ok' && l.state !== 'ordered') || l.mismatch.length > 0 || !!l.part?.fee || !!l.warnings?.length;
/** Lines that go on the house's order: a part it lists, or one it buys for the order without a record (an MPN outside Eurocircuits' database, any part at PCBWay). */
export const lineOnOrder = (l: StockLine) => !!l.part || l.state === 'ordered';
/** Lines that stop an order as they are: the part cannot be had, or it is not the part the design asks for (the house assembles what the number says). */
export const lineBlocks = (l: StockLine) => l.state === 'out' || l.state === 'short' || l.state === 'missing' || l.mismatch.length > 0;

/**
 * The number the house orders a component by: its own (the house's parameter), else, at a house that
 * buys by the maker's number, the component's manufacturer part number, else, at a house that buys
 * resistors and capacitors by value, the value with its grade and package ("10k 1% 0603"); null when
 * there is none of these.
 */
export function houseNumber(c: SourcedComponent, house: AssemblyHouse): string | null {
  const own = house.param ? house.normalize(c.params[house.param] ?? '') : null;
  if (own || !house.byMpn) return own;
  const mpn = (c.params.mpn ?? c.mpn ?? '').trim();
  if (mpn) return house.normalize(mpn);
  const value = c.category === 'resistor' ? c.params.resistance : c.category === 'capacitor' ? c.params.capacitance : undefined;
  if (!house.byValue || !value || !c.pkg) return null;
  return house.normalize([value, c.params.tolerance, c.params.voltage, c.params.dielectric, c.params.power, c.pkg].filter(Boolean).join(' '));
}

/** Group the components by the house's part number; those without one are `unsourced`. */
export function stockLines(components: SourcedComponent[], house: AssemblyHouse, boards: number): { lines: StockLine[]; unsourced: string[] } {
  const by = new Map<string, StockLine>();
  const unsourced: string[] = [];
  for (const c of components) {
    const sku = houseNumber(c, house);
    if (!sku) {
      unsourced.push(c.refdes);
      continue;
    }
    const l = by.get(sku) ?? { sku, refs: [], need: 0, state: 'unknown' as const, mismatch: [], replacements: [] };
    l.refs.push(c.refdes);
    l.need += boards;
    by.set(sku, l);
  }
  const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
  const lines = [...by.values()];
  for (const l of lines) l.refs.sort(natural);
  return { lines: lines.sort((a, b) => natural(a.refs[0]!, b.refs[0]!)), unsourced: unsourced.sort(natural) };
}

/**
 * The stock check: every part number of the design looked up now (a few at a time), how it stands
 * against `boards` boards, and replacements for the parts that stop the order, are low, or carry a
 * fee a fee-free part would avoid.
 */
export async function checkStock(
  components: SourcedComponent[],
  source: PartSource,
  opts: { house: AssemblyHouse; boards: number; concurrency?: number; replacements?: number; now?: () => Date },
): Promise<StockReport> {
  const { house, boards } = opts;
  const { lines, unsourced } = stockLines(components, house, boards);
  const byRef = new Map(components.map((c) => [c.refdes, c]));
  // a house without a catalogue the app can read buys every part for the order: nothing to look up
  if (house.noCatalogue) for (const l of lines) l.state = 'ordered';
  else
    await pool(lines, opts.concurrency ?? 4, async (l) => {
      try {
        l.part = await source.lookup(l.sku);
      } catch (e) {
        l.error = (e as Error).message;
      }
      settle(l, l.refs.map((r) => byRef.get(r)!), house);
    });
  await pool(lines.filter(wantsReplacement), opts.concurrency ?? 4, (l) => findReplacements(l, byRef.get(l.refs[0]!)!, source, house, opts.replacements ?? 3));
  let cost = 0;
  const unpriced: string[] = [];
  for (const l of lines) {
    const buy = l.part ? lineBuy(l.part, l.need) : null;
    if (!buy) unpriced.push(l.sku);
    else cost += buy.cost;
  }
  return {
    house: house.name,
    boards,
    at: (opts.now?.() ?? new Date()).toISOString(),
    lines,
    unsourced,
    live: lines.every((l) => l.state !== 'failed' && (!l.part || l.part.live)),
    ...(unpriced.length < lines.length ? { cost: Math.round(cost * 100) / 100 } : {}),
    unpriced,
  };
}

/** The line's state, mismatches and warnings once its part was looked up. */
function settle(l: StockLine, comps: SourcedComponent[], house: AssemblyHouse) {
  const unlisted = l.part === null ? house.unlisted?.(l.sku) : null;
  if (l.error !== undefined) l.state = 'failed';
  else if (unlisted) {
    // the house looks for it when the order goes in
    l.state = 'ordered';
    l.warnings = [unlisted];
  } else if (!l.part) l.state = 'missing';
  else l.state = stockState(l.part.stock, l.need, l.part.supply);
  if (!l.part) return;
  const life = lifecycleWarning(l.part.lifecycle);
  if (life) l.warnings = [life];
  const found = new Map<string, string[]>();
  for (const c of comps) {
    // the component's own MPN is the same part, whatever the catalogue calls its package
    const own = !!l.part.mpn && normMpn(l.part.mpn) === normMpn(c.params.mpn ?? c.mpn ?? '');
    for (const m of sourcingMismatch({ category: c.category ?? 'other' }, c.params, own ? undefined : c.pkg, l.part)) found.set(m, [...(found.get(m) ?? []), c.refdes]);
  }
  l.mismatch = [...found].map(([m, refs]) => (refs.length === comps.length ? m : `${refs.join(', ')}: ${m}`));
}

const isPassive = (c: SourcedComponent) => c.category === 'resistor' || c.category === 'capacitor';

const wantsReplacement = (l: StockLine) => lineBlocks(l) || l.state === 'low' || !!l.part?.fee || !!l.warnings?.length;

/**
 * What a like-for-like replacement is searched by: a resistor or capacitor by its value and package,
 * anything else by its part number (the same part from another maker or listing); null when neither is known.
 */
export function replacementQuery(c: SourcedComponent): PartQuery | null {
  const key = c.category === 'resistor' ? 'resistance' : c.category === 'capacitor' ? 'capacitance' : null;
  if (key && c.params[key]) return { kind: c.category as 'resistor' | 'capacitor', value: c.params[key]!, ...(c.pkg ? { package: c.pkg } : {}), limit: 25 };
  const mpn = c.params.mpn ?? c.mpn;
  return mpn ? { text: mpn, ...(c.pkg ? { package: c.pkg } : {}), limit: 25 } : null;
}

async function findReplacements(l: StockLine, c: SourcedComponent, source: PartSource, house: AssemblyHouse, n: number) {
  const q = replacementQuery(c);
  if (!q) return;
  let found: SupplierPart[];
  try {
    found = await source.search(q);
  } catch {
    return; // the line says what is wrong; there are just no replacements to offer
  }
  const passive = isPassive(c);
  const fits = (p: SupplierPart) => p.sku !== l.sku && canReplace(p, c, l.part, l.need);
  // better than the part it replaces in what is wrong with it: no fee where only the fee is, more stock where it is low
  const onlyFee = (l.state === 'ok' || l.state === 'ordered') && !l.mismatch.length && !l.warnings?.length;
  const better = (p: SupplierPart) => (onlyFee ? !p.fee : l.state === 'low' ? (p.stock === null ? p.supply === 'stock' : p.stock > (l.part?.stock ?? 0)) : true);
  // plenty of stock (STOCK_MARGIN × the need) before the house's class: a part that will still be there when the order goes in
  const short = (p: SupplierPart) => Number(!plentyFor(p, l.need));
  l.replacements = rankParts(found.filter((p) => fits(p) && better(p)), house.tiers.map((t) => t.name))
    .sort((a, b) => Number(a.fee) - Number(b.fee) || short(a) - short(b))
    .slice(0, n);
  if (!l.replacements.length) return;
  l.replacementBasis =
    c.category === 'resistor'
      ? 'same resistance and package, tolerance and power no worse'
      : c.category === 'capacitor'
        ? 'same capacitance and package, dielectric and voltage rating no worse'
        : `same part number (${c.params.mpn ?? c.mpn}), another maker or listing: read its datasheet before switching`;
}

/**
 * Whether a catalogue part can take the place of `was` (absent: there is none, or it is gone) on a
 * component, for `need` pieces: in stock for them, and for a resistor or capacitor the same value
 * and package, fitting the component and no worse in grade; for anything else the same part number
 * in the same package (another maker or listing).
 */
export function canReplace(p: SupplierPart, c: SourcedComponent, was: SupplierPart | null | undefined, need: number, opts: { ordered?: boolean } = {}): boolean {
  // (`ordered`: a part the house buys for the order counts too, for a component that has no part yet)
  if (!(hasFor(p, need) || (opts.ordered && p.supply === 'order')) || lifecycleWarning(p.lifecycle)) return false;
  if (isPassive(c)) return sourcingMismatch({ category: c.category! }, c.params, c.pkg, p).length === 0 && noWorse(p, was, c);
  const mpn = normMpn(c.params.mpn ?? c.mpn ?? '');
  return !!mpn && normMpn(p.mpn) === mpn && (!c.pkg || !p.package || samePackage(p.package, c.pkg));
}

/**
 * A part is good enough for a resistor or capacitor whatever its value: the same package, a
 * capacitor's voltage rating at least what the component asks, and no worse in grade than `was` (or
 * than the component asks when there is none): tolerance and power, dielectric and voltage rating.
 */
export function gradeFits(p: SupplierPart, c: SourcedComponent, was: SupplierPart | null | undefined): boolean {
  if (c.pkg && p.package && !samePackage(p.package, c.pkg)) return false;
  if (c.category === 'capacitor' && c.params.voltage) {
    const want = parseQuantity(c.params.voltage);
    const have = p.attributes['Voltage Rated'] ? parseQuantity(p.attributes['Voltage Rated']) : null;
    if (want && (!have || have.value < want.value * 0.999)) return false;
  }
  return noWorse(p, was, c);
}

/** A resistor's or capacitor's value as the catalogue lists it (Ω, F); null when it is not given. */
export function partValue(p: SupplierPart, kind: 'resistor' | 'capacitor'): number | null {
  const text = p.attributes[kind === 'resistor' ? 'Resistance' : 'Capacitance'] ?? p.attributes.Value;
  const q = text ? parseQuantity(text) : null;
  return q && (q.unit === '' || q.unit === (kind === 'resistor' ? 'Ω' : 'F')) ? q.value : null;
}

/**
 * A passive replacement is no worse than the part it replaces (or, when that is gone, than the
 * component asks): a resistor's tolerance and power, a capacitor's dielectric and voltage rating.
 * Where the old part states a grade the new one does not, it does not qualify.
 */
function noWorse(p: SupplierPart, was: SupplierPart | null | undefined, c: SourcedComponent): boolean {
  const pct = (s?: string) => {
    const m = s ? /(\d*\.?\d+)\s*%/.exec(s) : null;
    return m ? Number(m[1]) : undefined;
  };
  const num = (s?: string) => (s ? parseQuantity(s)?.value : undefined);
  const below = (have: number | undefined, want: number | undefined) => want !== undefined && (have === undefined || have < want * 0.999);
  if (c.category === 'resistor') {
    const tol = pct(was?.attributes.Tolerance) ?? pct(c.params.tolerance);
    const have = pct(p.attributes.Tolerance);
    if (tol !== undefined && (have === undefined || have > tol * 1.001)) return false;
    return !below(num(p.attributes['Power(Watts)']), num(was?.attributes['Power(Watts)']) ?? num(c.params.power));
  }
  if (c.category === 'capacitor') {
    const dielectric = (s?: string) => s?.toUpperCase().replace('NP0', 'C0G').trim();
    const want = dielectric(was?.attributes['Temperature Coefficient'] ?? c.params.dielectric);
    if (want && dielectric(p.attributes['Temperature Coefficient']) !== want) return false;
    return !below(num(p.attributes['Voltage Rated']), num(was?.attributes['Voltage Rated']));
  }
  return true;
}

/** Run `fn` over the items, `n` at a time. */
export async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/* -------------------------------------- text -------------------------------------- */

/** One line per part, for the agent and for logs (prices in the house's currency). */
export function describePart(p: SupplierPart, house: Pick<AssemblyHouse, 'currency'> = { currency: 'USD' }): string {
  const price = p.price[0] ? (p.price.every((b) => b.each === 0) ? 'free' : `${currencySymbol(house)}${trimNum(p.price[0].each)}@${p.price[0].qty}`) : '';
  const facts = p.description || Object.entries(p.attributes).map(([k, v]) => (k === 'Value' ? v : `${k} ${v}`)).join(', ');
  return [p.sku, p.mpn !== p.sku ? p.mpn : '', p.package, p.tier, stockText(p), lifecycleWarning(p.lifecycle) ?? '', price, facts.slice(0, 140)].filter(Boolean).join(' · ');
}

/** "stock 1,234", "kept in stock", "bought for the order", "stock unknown", with "(mirror)" when it was not read from the house just now. */
export function stockText(p: Pick<SupplierPart, 'stock' | 'live' | 'supply'>): string {
  const what = p.stock !== null ? `stock ${p.stock.toLocaleString('en-US')}` : p.supply === 'stock' ? 'kept in stock' : p.supply === 'order' ? 'bought for the order' : 'stock unknown';
  return `${what}${p.live ? '' : ' (mirror)'}`;
}

/** What a part's lifecycle says to look at ("obsolete at the maker"); null when nothing. */
export function lifecycleWarning(lifecycle: string | undefined): string | null {
  const l = (lifecycle ?? '').toLowerCase();
  if (/obsolete|discontinued|end of life|^eol$/.test(l)) return 'obsolete at the maker';
  if (/nrnd|not recommended/.test(l)) return 'not recommended for new designs';
  if (/last time buy|^ltb$/.test(l)) return 'last time buy at the maker';
  return null;
}

const STATE_TEXT: Record<StockLine['state'], string> = {
  ok: 'in stock',
  ordered: 'bought for the order',
  low: 'low stock',
  short: 'too few in stock',
  out: 'out of stock',
  unknown: 'stock unknown',
  missing: 'not in the catalogue (gone, or a wrong number)',
  failed: 'could not be looked up',
};

/** What is wrong with a line, in a few words ("out of stock: 0 for 40 needed"). */
export function lineProblem(l: StockLine): string {
  const stock = l.part?.stock;
  const amounts = l.state === 'short' || l.state === 'low' ? `: ${stock!.toLocaleString('en-US')} for ${l.need.toLocaleString('en-US')} needed` : l.state === 'out' ? ` (${l.need.toLocaleString('en-US')} needed)` : '';
  return `${STATE_TEXT[l.state]}${amounts}${l.state === 'failed' && l.error ? `: ${l.error}` : ''}`;
}

/** What is wrong with a line: not the part the design asks for, its stock, its fee. */
export function lineIssues(l: StockLine): string[] {
  return [
    ...(l.mismatch.length ? [`not the part the design asks for (${l.mismatch.join('; ')})`] : []),
    // (bought for the order is no problem: the part says so, and its fee follows)
    ...(l.state === 'ordered' ? (l.mismatch.length || l.warnings?.length || l.part?.fee ? [] : [lineProblem(l)]) : l.state !== 'ok' || !l.mismatch.length ? [lineProblem(l)] : []),
    ...(l.warnings ?? []),
    ...(l.part?.fee ? [`${l.part.tier}: a fee`] : []),
  ];
}

/** The report for the agent: what stops the order, what to look at, what is fine, with replacements. */
export function stockReportText(r: StockReport, house: AssemblyHouse): string {
  const out: string[] = [];
  const parts = r.lines.reduce((n, l) => n + l.refs.length, 0);
  if (house.noCatalogue) {
    // nothing to look up: what goes on the BOM, and what the house needs to buy the rest
    out.push(
      `Parts at ${r.house} for ${r.boards} board${r.boards === 1 ? '' : 's'}: ${house.noCatalogue}. So there is no stock to check here: ` +
        `${r.lines.length} part number${r.lines.length === 1 ? '' : 's'} for ${parts} component${parts === 1 ? '' : 's'} go on the BOM.`,
    );
    out.push(...r.lines.map((l) => `- ${l.refs.join(', ')} · ${l.sku}`));
    if (r.unsourced.length) out.push(`Without what ${house.name} needs to buy them (a manufacturer part number; resistors and capacitors may go by value and package): ${r.unsourced.join(', ')}. An imported part carries its MPN; a generic diode, transistor or inductor takes set_param mpn.`);
    return out.join('\n');
  }
  out.push(
    `Stock check at ${r.house} for ${r.boards} board${r.boards === 1 ? '' : 's'} (${r.at.slice(0, 16).replace('T', ' ')} UTC${r.live ? ', read just now' : `, NOT all live${r.note ? `: ${r.note}` : ''}; mirror stock may be a day old or unknown`}): ` +
      `${r.lines.length} part number${r.lines.length === 1 ? '' : 's'} for ${parts} component${parts === 1 ? '' : 's'}.`,
  );
  const line = (l: StockLine) => {
    const what = l.part ? `${l.sku}${l.part.mpn !== l.sku ? ` ${l.part.mpn}` : ''} (${l.part.tier || 'no class'}, ${stockText(l.part)})` : l.sku;
    const bits = [`- ${l.refs.join(', ')} · ${what}: ${lineIssues(l).join('; ')}`];
    if (l.replacements.length) bits.push(`. Replacements (${l.replacementBasis}): ${l.replacements.map((p) => describePart(p, house)).join(' | ')}`);
    else if (lineBlocks(l) || l.warnings?.length) bits.push('. No like-for-like replacement found: search for another part (sourcing search) or import one (import_part)');
    return bits.join('');
  };
  const settled = (l: StockLine) => l.state === 'ok' || l.state === 'ordered';
  const blocking = r.lines.filter(lineBlocks);
  const warn = r.lines.filter((l) => !lineBlocks(l) && (!settled(l) || !!l.warnings?.length));
  const fees = r.lines.filter((l) => !lineBlocks(l) && settled(l) && !l.warnings?.length && l.part?.fee);
  const fine = r.lines.filter((l) => !lineNeedsAttention(l));
  if (blocking.length) out.push(`Stop the order (${blocking.length}):`, ...blocking.map(line));
  if (warn.length) out.push(`Look at (${warn.length}):`, ...warn.map(line));
  if (fees.length) out.push(`With a fee (${fees.length}): ${house.feeNote}.`, ...fees.map(line));
  const scarce = r.lines.filter((l) => (l.state === 'low' || l.state === 'short') && !l.replacements.length);
  if (scarce.length) out.push(`Scarce with no replacement (${scarce.map((l) => l.sku).join(', ')}): suggest the user ${house.reserveNote}.`);
  const kept = fine.some((l) => l.part?.stock === null);
  if (fine.length) out.push(`Fine (${kept ? `kept in stock by ${house.name}, or ` : ''}stock ≥ ${STOCK_MARGIN} × the need, no fee): ${fine.map((l) => `${l.sku} (${l.refs.join(', ')})`).join(', ')}.`);
  if (r.unsourced.length) {
    const none = house.byMpn && house.param ? `No ${house.numberName} and no manufacturer part number` : `No ${house.numberName}`;
    out.push(`${none} (${house.name} does not assemble them${house.byMpn ? '' : ' from its stock'}; fine for parts soldered by hand): ${r.unsourced.join(', ')}.`);
  }
  if (r.cost !== undefined) out.push(`Parts ≈ ${money(r.cost, house)} for ${r.boards} board${r.boards === 1 ? '' : 's'} at today's prices, without fees${r.unpriced.length ? ` (no price for ${r.unpriced.join(', ')})` : ''}.`);
  if (house.param && r.lines.some((l) => l.replacements.length)) out.push(`To take a replacement: design_edit set_param ${house.param} on every component of its line.`);
  return out.join('\n');
}

/** Prices: cents need the digits ("$0.0017"), dollars two decimals. */
const trimNum = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(3).replace(/0+$/, '').replace(/\.$/, ''));
/** Engineering values: four significant digits at most, no trailing zeros ("4.7", "10", "100"). */
const sig = (n: number) => String(Number(n.toPrecision(4)));

export function formatOhms(v: number): string {
  return v >= 1e6 ? `${sig(v / 1e6)}MΩ` : v >= 1e3 ? `${sig(v / 1e3)}kΩ` : `${sig(v)}Ω`;
}

export function formatFarads(v: number): string {
  return v >= 1e-3 ? `${sig(v * 1e3)}mF` : v >= 1e-6 ? `${sig(v * 1e6)}uF` : v >= 1e-9 ? `${sig(v * 1e9)}nF` : `${sig(v * 1e12)}pF`;
}
