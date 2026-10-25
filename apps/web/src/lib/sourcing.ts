/**
 * Sourcing in the app: the assembly house's parts catalogue (the Inspector's search, the agent's
 * sourcing tool) and the stock check before ordering. The house's own catalogue is read by the local
 * server (the browser cannot call it); when that fails, a copy the browser can call answers instead,
 * and its parts say so (`live: false`). Answers are kept for a few minutes, so the Inspector and the
 * agent do not ask twice.
 */
import type { ToolOutcome } from '@4k7/agent';
import { ASSEMBLY_HOUSE, ASSEMBLY_HOUSES, assemblyHouse, currencySymbol, feeFreeTiers, money, SourcingInput, whose, type AssemblyHouse, type PartQuery, type PlacementKind, type SupplierPart } from '@4k7/schema';
import {
  catalogueKinds,
  checkCost,
  checkStock,
  checkValues,
  costReportText,
  describePart,
  estimateLine,
  estimateOrder,
  lineBlocks,
  lineOnOrder,
  quoteOrder,
  quoteServices,
  stockReportText,
  tscircuitSource,
  valuesReportText,
  withFallback,
  type AssemblyFacts,
  type CostReport,
  type PartSource,
  type QuoteOrder,
  type SourcedComponent,
  type StockReport,
  type ValuesReport,
} from '@4k7/parts';
import { disk } from './disk.svelte.ts';

/** The house the checks run for until the user picks another (Layout → Sourcing). */
export const house = ASSEMBLY_HOUSE;

/** Copies of a house's catalogue the browser can call itself, for when the server cannot read the house's own. */
const MIRRORS: Record<string, () => PartSource> = { jlcpcb: () => tscircuitSource() };

/** A house's catalogue in the tab: its own through the local server, a mirror when that fails, and why it failed last. */
interface HouseCatalogue {
  source: PartSource;
  /** Why the house's own catalogue could not be read the last time it was asked; null when it answered. */
  problem: string | null;
}
const catalogues = new Map<string, HouseCatalogue>();
/** Tests put a fake in for every house. */
let fake: PartSource | undefined;

function houseCatalogue(h: AssemblyHouse): HouseCatalogue {
  let c = catalogues.get(h.id);
  if (c) return c;
  const outdated = () => new Error(`this 4k7 server cannot read ${whose(h)} catalogue yet: restart the app to update it`);
  const viaServer: PartSource = {
    async search(q) {
      const parts = await disk.sourcingSearch(h.id, q);
      if (!parts) throw outdated();
      return parts;
    },
    async lookup(sku) {
      const r = await disk.sourcingLookup(h.id, sku);
      if (!r) throw outdated();
      return r.part;
    },
    async quote(order) {
      const q = await disk.sourcingQuote(h.id, order);
      if (!q) throw outdated();
      return q;
    },
  };
  // a house without a mirror says itself why it could not be read
  const mirror = MIRRORS[h.id];
  const made: HouseCatalogue = { source: fake ?? viaServer, problem: null };
  if (!fake && mirror) made.source = withFallback(viaServer, mirror(), (why) => (made.problem = why));
  catalogues.set(h.id, made);
  return made;
}

/** Why the house's own catalogue could not be read the last time it was asked; null when it answered. */
export const catalogueProblem = (h: AssemblyHouse = house) => catalogues.get(h.id)?.problem ?? null;

/** Tests swap the catalogue for a fake, or put the real one back; either way what was kept is forgotten. */
export function setCatalogue(s?: PartSource) {
  fake = s;
  catalogues.clear();
  cache.clear();
}

const cache = new Map<string, { until: number; value: Promise<unknown> }>();
const KEEP_MS = 10 * 60_000;
/** A mirror's answer stands in for a moment only: the house's own may answer again soon. */
const MIRROR_KEEP_MS = 60_000;

function memo<T>(key: string, make: () => Promise<T>, live: (v: T) => boolean): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.until) return hit.value as Promise<T>;
  const entry = { until: Date.now() + KEEP_MS, value: make() as Promise<unknown> };
  cache.set(key, entry);
  entry.value.then(
    (v) => !live(v as T) && (entry.until = Math.min(entry.until, Date.now() + MIRROR_KEEP_MS)),
    () => cache.get(key) === entry && cache.delete(key), // a failure is not worth remembering
  );
  return entry.value as Promise<T>;
}

/** A house's catalogue, memoised. */
export function catalogueOf(h: AssemblyHouse): PartSource {
  const c = () => houseCatalogue(h);
  return {
    // (nothing found is live unless the house's own catalogue just failed)
    search: (q: PartQuery) => memo(`s:${h.id}:${JSON.stringify(q)}`, () => c().source.search(q), (ps) => (ps.length ? ps.every((p) => p.live) : c().problem === null)),
    lookup: (sku: string) => memo(`l:${h.id}:${sku.trim().toUpperCase()}`, () => c().source.lookup(sku), (p) => !p || p.live),
    quote: (order: QuoteOrder) => {
      const source = c().source;
      if (!source.quote) return Promise.reject(new Error(`${h.name} has no online quote`));
      return memo(`q:${h.id}:${JSON.stringify(order)}`, () => source.quote!(order), () => true);
    },
  };
}

/** The default house's catalogue, memoised. */
export const catalogue: PartSource = catalogueOf(house);

/** The board's facts for the components the house assembles (from the placed board: joints, sides, size). */
export type BoardFacts = (assembled: Set<string>, kinds?: ReadonlyMap<string, PlacementKind>) => AssemblyFacts;

/**
 * The stock check of these components for `boards` boards at a house, with what the order would cost
 * when the board is known; saying why when the parts could not all be read live.
 */
export async function checkDesignStock(components: SourcedComponent[], boards: number, facts: BoardFacts | undefined, h: AssemblyHouse = house): Promise<StockReport> {
  const report = await checkStock(components, catalogueOf(h), { house: h, boards });
  if (facts) {
    const f = facts(new Set(report.lines.filter(lineOnOrder).flatMap((l) => l.refs)), catalogueKinds(report.lines));
    const quotes = h.services.some((x) => x.quoted) ? await quoteServices(h, catalogueOf(h), quoteOrder(report.lines, f, boards)) : undefined;
    report.estimates = estimateOrder(report.lines, f, boards, h, quotes ? { quotes } : {});
  }
  const why = catalogueProblem(h);
  if (!report.live && why) report.note = why;
  return report;
}

/** The cost check of these components for `boards` boards at a house: the estimate at each service, and what would make it cheaper. */
export async function checkDesignCost(components: SourcedComponent[], boards: number, facts: BoardFacts, h: AssemblyHouse = house): Promise<CostReport> {
  const report = await checkCost(components, catalogueOf(h), { house: h, boards, facts });
  const why = catalogueProblem(h);
  if (!report.live && why) report.note = report.stock.note = why;
  return report;
}

/** Said with parts not read from the house just now. */
const mirrorNote = (parts: SupplierPart[], h: AssemblyHouse) => {
  if (parts.every((p) => p.live)) return '';
  const why = catalogueProblem(h);
  return `\n(Not live: ${why ? `${whose(h)} own catalogue could not be read (${why}); ` : ''}these come from a mirror whose stock may be a day old or unknown. Check again before ordering.)`;
};

/** The values check of these components for `boards` boards at a house: cheaper ways to make each resistor and capacitor value. */
export function checkDesignValues(components: SourcedComponent[], boards: number, facts: BoardFacts, h: AssemblyHouse = house): Promise<ValuesReport> {
  return checkValues(components, catalogueOf(h), { house: h, boards, facts });
}

/** The checks the app runs for the tool (the stock and cost checks show in the Layout view too). */
export interface DesignChecks {
  stock(boards: number | undefined, house: AssemblyHouse): Promise<StockReport>;
  cost(boards: number | undefined, house: AssemblyHouse): Promise<CostReport>;
  values(boards: number | undefined, house: AssemblyHouse): Promise<ValuesReport>;
}

/**
 * The sourcing tool: search a house's catalogue, look one part up, or check the whole design (`check`,
 * `cost`, `values`: run by the app). The house is the one asked for, else `chosen` (the user's pick).
 */
export async function sourcingTool(input: unknown, checks: DesignChecks, chosen: AssemblyHouse = house): Promise<ToolOutcome> {
  const parsed = SourcingInput.safeParse(input);
  if (!parsed.success) return { content: `Invalid sourcing input: ${parsed.error.message}`, isError: true, label: 'sourcing', detail: 'invalid input' };
  const a = parsed.data;
  const h = a.house ? assemblyHouse(a.house) : chosen;
  if (!h) return { content: `No assembly house "${a.house}": ${ASSEMBLY_HOUSES.map((x) => x.id).join(', ')}.`, isError: true, label: 'sourcing', detail: 'unknown house' };
  const catalogue = catalogueOf(h);
  try {
    if (a.action === 'check') {
      const r = await checks.stock(a.boards, h);
      const trouble = r.lines.filter(lineBlocks).length;
      const order = r.estimates ? `\nThe order: ${estimateLine(r.estimates, r.boards, h)}, fees included (not ${h.noCatalogue ? 'the parts, ' : ''}the bare boards, shipping or taxes); sourcing cost has the breakdown and what would make it cheaper.` : '';
      const detail = h.noCatalogue
        ? `${r.lines.length} part number(s) on the BOM${r.unsourced.length ? `, ${r.unsourced.length} without what ${h.name} needs` : ''}`
        : trouble
          ? `${trouble} part(s) stop the order`
          : `${r.lines.length} part number(s) fine to order`;
      return { content: stockReportText(r, h) + order, isError: false, label: `stock check · ${h.name} · ${r.boards} boards`, detail };
    }
    if (a.action === 'values') {
      const r = await checks.values(a.boards, h);
      const most = r.lines.reduce((n, l) => n + Math.max(0, ...l.options.map((o) => o.saves ?? 0)), 0);
      return { content: valuesReportText(r, h), isError: false, label: `values check · ${h.name} · ${r.boards} boards`, detail: r.lines.length ? `${r.lines.length} value(s) cheaper, up to ${money(most, h)}` : 'none cheaper' };
    }
    if (a.action === 'cost') {
      const r = await checks.cost(a.boards, h);
      const saved = r.savings.reduce((n, x) => n + x.saves, 0);
      return { content: costReportText(r, h), isError: false, label: `cost check · ${h.name} · ${r.boards} boards`, detail: `${estimateLine(r.estimates, r.boards, h).replace(/ for \d+ boards?.*$/, '')}${saved ? `, up to ${money(saved, h)} less` : ''}` };
    }
    if ((a.action === 'lookup' || a.action === 'search') && h.noCatalogue) {
      return {
        content: `${h.noCatalogue}. Nothing to search or look up there: give each part a manufacturer part number (an imported part carries one; a generic diode, transistor or inductor takes set_param mpn; resistors and capacitors may go by value and package), and run sourcing check (what goes on the BOM) and sourcing cost (the assembly, from ${whose(h)} online quote) with house "${h.id}".`,
        isError: false,
        label: `${h.name} · no catalogue`,
        detail: 'parts bought for the order',
      };
    }
    if (a.action === 'lookup') {
      const id = a.part.trim();
      const p = await catalogue.lookup(id);
      if (!p) return { content: `${id} is not in ${whose(h)} catalogue (or the number is wrong).`, isError: true, label: `${h.name} · ${id}`, detail: 'not found' };
      const lines = [
        describePart(p, h),
        p.manufacturer ? `manufacturer: ${p.manufacturer}` : '',
        p.price.length > 1 ? `price breaks (${h.currency} per piece): ${p.price.map((b) => `${b.qty}+ ${currencySymbol(h)}${b.each}`).join(', ')}` : '',
        p.fee ? `${p.tier}: ${h.feeNote}.` : '',
        p.datasheet ? `datasheet: ${p.datasheet}` : `datasheet: not in the catalogue record; the part page links it: ${p.url}`,
        `part page: ${p.url}`,
        `Record it on a component with design_edit set_param ${h.param}.`,
      ];
      return { content: lines.filter(Boolean).join('\n') + mirrorNote([p], h), isError: false, label: `${h.name} · ${p.sku}`, detail: `${p.mpn} · ${p.package}` };
    }
    const q: PartQuery = {
      ...(a.text ? { text: a.text } : {}),
      ...(a.kind ? { kind: a.kind } : {}),
      ...(a.value ? { value: a.value } : {}),
      ...(a.package ? { package: a.package } : {}),
      ...(a.no_fee ? { noFee: true } : {}),
      limit: a.limit,
    };
    const what = a.kind ? `${a.kind} ${a.value ?? ''}${a.package ? ` ${a.package}` : ''}`.trim() : (a.text ?? '').trim();
    const parts = await catalogue.search(q);
    if (!parts.length) {
      return {
        content: `No ${h.name} parts in stock for "${what}"${a.no_fee ? ` among ${feeFreeTiers(h)} parts` : ''}. Try other words from a catalogue description, or drop the package filter.` + mirrorNote(parts, h),
        isError: false,
        label: `${h.name} · ${what}`,
        detail: 'no results',
      };
    }
    const content = [
      `${parts.length} ${h.name} part(s) for ${what} (${feeFreeTiers(h)} first, then by stock; ${h.currency} per piece at the quantity given):`,
      ...parts.map((p) => `- ${describePart(p, h)}`),
      `sourcing lookup gives a part's datasheet link and price breaks; design_edit set_param ${h.param} records the choice on a component.`,
    ].join('\n');
    return { content: content + mirrorNote(parts, h), isError: false, label: `${h.name} · ${what}`, detail: `${parts.length} result(s)` };
  } catch (e) {
    const msg = (e as Error).message;
    return { content: `${h.name} ${a.action === 'check' ? 'stock check' : 'catalogue'} failed: ${msg}`, isError: true, label: 'sourcing', detail: msg };
  }
}

export type { CostReport, StockReport, SupplierPart };
