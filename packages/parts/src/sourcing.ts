/**
 * Sourcing for any assembly house: ranking catalogue results, checking a part against the component
 * it is for, and the stock check of a whole design before it is ordered (every part looked up now,
 * replacements for the ones in trouble). What is particular to a house comes from its AssemblyHouse
 * entry (packages/schema/src/sourcing.ts) and its catalogue, a PartSource (JLCPCB: jlc.ts).
 */
import { parseQuantity, STOCK_MARGIN, type AssemblyHouse, type PartCard, type PartCategory, type PartQuery, type SupplierPart } from '@4k7/schema';
import type { CostEstimate } from './cost.ts';

/** A house's catalogue. */
export interface PartSource {
  search(q: PartQuery): Promise<SupplierPart[]>;
  /** One part by the house's number; null when the catalogue does not know it. */
  lookup(sku: string): Promise<SupplierPart | null>;
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
export function lineBuy(p: SupplierPart, need: number): { pieces: number; usd: number } | null {
  const pieces = Math.max(need + (p.attrition ?? 0), p.minQty ?? 0);
  const unit = unitPrice(p, pieces);
  return unit === undefined ? null : { pieces, usd: unit * pieces };
}

/** The price per piece when buying `qty` (the break for that quantity; below the first break, its price). */
export function unitPrice(p: SupplierPart, qty: number): number | undefined {
  let usd: number | undefined;
  for (const b of p.price) if (usd === undefined || b.qty <= qty) usd = b.usd;
  return usd;
}

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
  if (effectivePackage && part.package && normPkg(effectivePackage) !== normPkg(part.package)) out.push(`package: the part is ${part.package}, the component ${effectivePackage}`);
  return out;
}

const passiveValueKey = (c: PartCategory | undefined) => (c === 'resistor' ? 'resistance' : c === 'capacitor' ? 'capacitance' : c === 'inductor' ? 'inductance' : null);
const closeTo = (a: number, b: number) => Math.abs(a - b) <= 0.005 * Math.max(Math.abs(a), Math.abs(b));
const normPkg = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
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

/** How a part stands against what the boards need: `low` is enough now but under STOCK_MARGIN × the need. */
export type StockState = 'ok' | 'low' | 'short' | 'out' | 'unknown';

export function stockState(stock: number | null, need: number): StockState {
  if (stock === null) return 'unknown';
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
  /** The parts for all the boards at today's prices (USD, without fees: the pieces the house buys, see lineBuy), of the lines with a price; absent when none has one. */
  cost?: number;
  /** The part numbers the cost leaves out: no price (or no record). */
  unpriced: string[];
  /** The order at each of the house's services, when the board was known (see cost.ts). */
  estimates?: CostEstimate[];
}

/** Lines that need a look: anything but plenty in stock, fitting, fee-free. */
export const lineNeedsAttention = (l: StockLine) => l.state !== 'ok' || l.mismatch.length > 0 || !!l.part?.fee;
/** Lines that stop an order as they are: the part cannot be had, or it is not the part the design asks for (the house assembles what the number says). */
export const lineBlocks = (l: StockLine) => l.state === 'out' || l.state === 'short' || l.state === 'missing' || l.mismatch.length > 0;

/** Group the components by the house's part number; those without one are `unsourced`. */
export function stockLines(components: SourcedComponent[], house: AssemblyHouse, boards: number): { lines: StockLine[]; unsourced: string[] } {
  const by = new Map<string, StockLine>();
  const unsourced: string[] = [];
  for (const c of components) {
    const sku = house.normalize(c.params[house.param] ?? '');
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
  await pool(lines, opts.concurrency ?? 4, async (l) => {
    try {
      l.part = await source.lookup(l.sku);
    } catch (e) {
      l.error = (e as Error).message;
    }
    settle(l, l.refs.map((r) => byRef.get(r)!));
  });
  await pool(lines.filter(wantsReplacement), opts.concurrency ?? 4, (l) => findReplacements(l, byRef.get(l.refs[0]!)!, source, house, opts.replacements ?? 3));
  let cost = 0;
  const unpriced: string[] = [];
  for (const l of lines) {
    const buy = l.part ? lineBuy(l.part, l.need) : null;
    if (!buy) unpriced.push(l.sku);
    else cost += buy.usd;
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

/** The line's state and mismatches once its part was looked up. */
function settle(l: StockLine, comps: SourcedComponent[]) {
  if (l.error !== undefined) l.state = 'failed';
  else if (!l.part) l.state = 'missing';
  else l.state = stockState(l.part.stock, l.need);
  if (!l.part) return;
  const found = new Map<string, string[]>();
  for (const c of comps) for (const m of sourcingMismatch({ category: c.category ?? 'other' }, c.params, c.pkg, l.part)) found.set(m, [...(found.get(m) ?? []), c.refdes]);
  l.mismatch = [...found].map(([m, refs]) => (refs.length === comps.length ? m : `${refs.join(', ')}: ${m}`));
}

const isPassive = (c: SourcedComponent) => c.category === 'resistor' || c.category === 'capacitor';

const wantsReplacement = (l: StockLine) => lineBlocks(l) || l.state === 'low' || !!l.part?.fee;

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
  const onlyFee = l.state === 'ok' && !l.mismatch.length;
  const better = (p: SupplierPart) => (onlyFee ? !p.fee : l.state === 'low' ? p.stock! > (l.part?.stock ?? 0) : true);
  // plenty of stock (STOCK_MARGIN × the need) before the house's class: a part that will still be there when the order goes in
  const short = (p: SupplierPart) => Number(p.stock! < l.need * STOCK_MARGIN);
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
export function canReplace(p: SupplierPart, c: SourcedComponent, was: SupplierPart | null | undefined, need: number): boolean {
  if (p.stock === null || p.stock < need) return false;
  if (isPassive(c)) return sourcingMismatch({ category: c.category! }, c.params, c.pkg, p).length === 0 && noWorse(p, was, c);
  const mpn = normMpn(c.params.mpn ?? c.mpn ?? '');
  return !!mpn && normMpn(p.mpn) === mpn && (!c.pkg || !p.package || normPkg(p.package) === normPkg(c.pkg));
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

/** One line per part, for the agent and for logs. */
export function describePart(p: SupplierPart): string {
  const price = p.price[0] ? `$${trimNum(p.price[0].usd)}@${p.price[0].qty}` : '';
  const facts = p.description || Object.entries(p.attributes).map(([k, v]) => (k === 'Value' ? v : `${k} ${v}`)).join(', ');
  return [p.sku, p.mpn, p.package, p.tier, stockText(p), price, facts.slice(0, 140)].filter(Boolean).join(' · ');
}

/** "stock 1,234", "stock unknown", with "(mirror)" when it was not read from the house just now. */
export function stockText(p: Pick<SupplierPart, 'stock' | 'live'>): string {
  return `${p.stock === null ? 'stock unknown' : `stock ${p.stock.toLocaleString('en-US')}`}${p.live ? '' : ' (mirror)'}`;
}

const STATE_TEXT: Record<StockLine['state'], string> = {
  ok: 'in stock',
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
    ...(l.state !== 'ok' || !l.mismatch.length ? [lineProblem(l)] : []),
    ...(l.part?.fee ? [`${l.part.tier}: a fee`] : []),
  ];
}

/** The report for the agent: what stops the order, what to look at, what is fine, with replacements. */
export function stockReportText(r: StockReport, house: AssemblyHouse): string {
  const out: string[] = [];
  const parts = r.lines.reduce((n, l) => n + l.refs.length, 0);
  out.push(
    `Stock check at ${r.house} for ${r.boards} board${r.boards === 1 ? '' : 's'} (${r.at.slice(0, 16).replace('T', ' ')} UTC${r.live ? ', read just now' : `, NOT all live${r.note ? `: ${r.note}` : ''}; mirror stock may be a day old or unknown`}): ` +
      `${r.lines.length} part number${r.lines.length === 1 ? '' : 's'} for ${parts} component${parts === 1 ? '' : 's'}.`,
  );
  const line = (l: StockLine) => {
    const what = l.part ? `${l.sku} ${l.part.mpn} (${l.part.tier || 'no class'}, ${stockText(l.part)})` : l.sku;
    const bits = [`- ${l.refs.join(', ')} · ${what}: ${lineIssues(l).join('; ')}`];
    if (l.replacements.length) bits.push(`. Replacements (${l.replacementBasis}): ${l.replacements.map(describePart).join(' | ')}`);
    else if (lineBlocks(l)) bits.push('. No like-for-like replacement found: search for another part (sourcing search) or import one (import_part)');
    return bits.join('');
  };
  const blocking = r.lines.filter(lineBlocks);
  const warn = r.lines.filter((l) => !lineBlocks(l) && l.state !== 'ok');
  const fees = r.lines.filter((l) => !lineBlocks(l) && l.state === 'ok' && l.part?.fee);
  const fine = r.lines.filter((l) => !lineNeedsAttention(l));
  if (blocking.length) out.push(`Stop the order (${blocking.length}):`, ...blocking.map(line));
  if (warn.length) out.push(`Look at (${warn.length}):`, ...warn.map(line));
  if (fees.length) out.push(`With a fee (${fees.length}): ${house.feeNote}.`, ...fees.map(line));
  const scarce = r.lines.filter((l) => (l.state === 'low' || l.state === 'short') && !l.replacements.length);
  if (scarce.length) out.push(`Scarce with no replacement (${scarce.map((l) => l.sku).join(', ')}): suggest the user ${house.reserveNote}.`);
  if (fine.length) out.push(`Fine (stock ≥ ${STOCK_MARGIN} × the need, no fee): ${fine.map((l) => `${l.sku} (${l.refs.join(', ')})`).join(', ')}.`);
  if (r.unsourced.length) out.push(`No ${house.numberName} (${house.name} does not assemble them from its stock; fine for parts soldered by hand): ${r.unsourced.join(', ')}.`);
  if (r.cost !== undefined) out.push(`Parts ≈ $${r.cost.toFixed(2)} for ${r.boards} board${r.boards === 1 ? '' : 's'} at today's prices, without fees${r.unpriced.length ? ` (no price for ${r.unpriced.join(', ')})` : ''}.`);
  if (r.lines.some((l) => l.replacements.length)) out.push(`To take a replacement: design_edit set_param ${house.param} on every component of its line.`);
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
