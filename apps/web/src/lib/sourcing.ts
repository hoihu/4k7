/**
 * Sourcing in the app: the assembly house's parts catalogue (the Inspector's search, the agent's
 * sourcing tool) and the stock check before ordering. The house's own catalogue is read by the local
 * server (the browser cannot call it); when that fails, a copy the browser can call answers instead,
 * and its parts say so (`live: false`). Answers are kept for a few minutes, so the Inspector and the
 * agent do not ask twice.
 */
import type { ToolOutcome } from '@4k7/agent';
import { ASSEMBLY_HOUSE, feeFreeTiers, SourcingInput, type PartQuery, type SupplierPart } from '@4k7/schema';
import {
  checkCost,
  checkStock,
  costReportText,
  describePart,
  estimateLine,
  estimateOrder,
  lineBlocks,
  stockReportText,
  tscircuitSource,
  withFallback,
  type AssemblyFacts,
  type CostReport,
  type PartSource,
  type SourcedComponent,
  type StockReport,
} from '@4k7/parts';
import { disk } from './disk.svelte.ts';

/** The house the design is sourced for (and whose parameter holds the part number). */
export const house = ASSEMBLY_HOUSE;

/** Copies of a house's catalogue the browser can call itself, for when the server cannot read the house's own. */
const MIRRORS: Record<string, () => PartSource> = { jlcpcb: () => tscircuitSource() };

const outdated = () => new Error(`this 4k7 server cannot read ${house.name}'s catalogue yet: restart the app to update it`);
/** The house's own catalogue, through the local server. */
const viaServer: PartSource = {
  async search(q) {
    const parts = await disk.sourcingSearch(house.id, q);
    if (!parts) throw outdated();
    return parts;
  },
  async lookup(sku) {
    const r = await disk.sourcingLookup(house.id, sku);
    if (!r) throw outdated();
    return r.part;
  },
};
const noMirror: PartSource = {
  search: () => Promise.reject(new Error(`${house.name}'s catalogue could not be read`)),
  lookup: () => Promise.reject(new Error(`${house.name}'s catalogue could not be read`)),
};

/** Why the house's own catalogue could not be read the last time it was asked; null when it answered. */
let problem: string | null = null;
const houseFirst = () => withFallback(viaServer, MIRRORS[house.id]?.() ?? noMirror, (why) => (problem = why));
let source: PartSource = houseFirst();
export const catalogueProblem = () => problem;

/** Tests swap the catalogue for a fake, or put the real one back; either way what was kept is forgotten. */
export function setCatalogue(s?: PartSource) {
  source = s ?? houseFirst();
  problem = null;
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

/** The catalogue, memoised. */
export const catalogue: PartSource = {
  // (nothing found is live unless the house's own catalogue just failed)
  search: (q: PartQuery) => memo(`s:${house.id}:${JSON.stringify(q)}`, () => source.search(q), (ps) => (ps.length ? ps.every((p) => p.live) : problem === null)),
  lookup: (sku: string) => memo(`l:${house.id}:${sku.trim().toUpperCase()}`, () => source.lookup(sku), (p) => !p || p.live),
};

/** The board's facts for the components the house assembles (from the placed board: joints, sides, size). */
export type BoardFacts = (assembled: Set<string>) => AssemblyFacts;

/**
 * The stock check of these components for `boards` boards, with what the order would cost when the
 * board is known; saying why when the parts could not all be read live.
 */
export async function checkDesignStock(components: SourcedComponent[], boards: number, facts?: BoardFacts): Promise<StockReport> {
  const report = await checkStock(components, catalogue, { house, boards });
  if (facts) report.estimates = estimateOrder(report.lines, facts(new Set(report.lines.filter((l) => l.part).flatMap((l) => l.refs))), boards, house);
  const why = catalogueProblem();
  if (!report.live && why) report.note = why;
  return report;
}

/** The cost check of these components for `boards` boards: the estimate at each service, and what would make it cheaper. */
export async function checkDesignCost(components: SourcedComponent[], boards: number, facts: BoardFacts): Promise<CostReport> {
  const report = await checkCost(components, catalogue, { house, boards, facts });
  const why = catalogueProblem();
  if (!report.live && why) report.note = report.stock.note = why;
  return report;
}

/** Said with parts not read from the house just now. */
const mirrorNote = (parts: SupplierPart[]) => {
  if (parts.every((p) => p.live)) return '';
  const why = catalogueProblem();
  return `\n(Not live: ${why ? `${house.name}'s own catalogue could not be read (${why}); ` : ''}these come from a mirror whose stock may be a day old or unknown. Check again before ordering.)`;
};

/** The checks the app runs for the tool (they show in the Layout view too). */
export interface DesignChecks {
  stock(boards?: number): Promise<StockReport>;
  cost(boards?: number): Promise<CostReport>;
}

/** The sourcing tool: search the catalogue, look one part up, or check the whole design (`check`, `cost`: run by the app). */
export async function sourcingTool(input: unknown, checks: DesignChecks): Promise<ToolOutcome> {
  const parsed = SourcingInput.safeParse(input);
  if (!parsed.success) return { content: `Invalid sourcing input: ${parsed.error.message}`, isError: true, label: 'sourcing', detail: 'invalid input' };
  const a = parsed.data;
  try {
    if (a.action === 'check') {
      const r = await checks.stock(a.boards);
      const trouble = r.lines.filter(lineBlocks).length;
      const order = r.estimates ? `\nThe order: ${estimateLine(r.estimates, r.boards)}, fees included (not the bare boards, shipping or taxes); sourcing cost has the breakdown and what would make it cheaper.` : '';
      return { content: stockReportText(r, house) + order, isError: false, label: `stock check · ${r.boards} boards`, detail: trouble ? `${trouble} part(s) stop the order` : `${r.lines.length} part number(s) fine to order` };
    }
    if (a.action === 'cost') {
      const r = await checks.cost(a.boards);
      const saved = r.savings.reduce((n, x) => n + x.usd, 0);
      return { content: costReportText(r, house), isError: false, label: `cost check · ${r.boards} boards`, detail: `${estimateLine(r.estimates, r.boards).replace(/ for \d+ boards?.*$/, '')}${saved ? `, up to $${saved.toFixed(2)} less` : ''}` };
    }
    if (a.action === 'lookup') {
      const id = a.part.trim();
      const p = await catalogue.lookup(id);
      if (!p) return { content: `${id} is not in ${house.name}'s catalogue (or the number is wrong).`, isError: true, label: `${house.name} · ${id}`, detail: 'not found' };
      const lines = [
        describePart(p),
        p.manufacturer ? `manufacturer: ${p.manufacturer}` : '',
        p.price.length > 1 ? `price breaks (USD per piece): ${p.price.map((b) => `${b.qty}+ $${b.usd}`).join(', ')}` : '',
        p.fee ? `${p.tier}: ${house.feeNote}.` : '',
        p.datasheet ? `datasheet: ${p.datasheet}` : `datasheet: not in the catalogue record; the part page links it: ${p.url}`,
        `part page: ${p.url}`,
        `Record it on a component with design_edit set_param ${house.param}.`,
      ];
      return { content: lines.filter(Boolean).join('\n') + mirrorNote([p]), isError: false, label: `${house.name} · ${p.sku}`, detail: `${p.mpn} · ${p.package}` };
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
        content: `No ${house.name} parts in stock for "${what}"${a.no_fee ? ` among ${feeFreeTiers(house)} parts` : ''}. Try other words from a catalogue description, or drop the package filter.` + mirrorNote(parts),
        isError: false,
        label: `${house.name} · ${what}`,
        detail: 'no results',
      };
    }
    const content = [
      `${parts.length} ${house.name} part(s) for ${what} (${feeFreeTiers(house)} first, then by stock; USD per piece at the quantity given):`,
      ...parts.map((p) => `- ${describePart(p)}`),
      `sourcing lookup gives a part's datasheet link and price breaks; design_edit set_param ${house.param} records the choice on a component.`,
    ].join('\n');
    return { content: content + mirrorNote(parts), isError: false, label: `${house.name} · ${what}`, detail: `${parts.length} result(s)` };
  } catch (e) {
    const msg = (e as Error).message;
    return { content: `${house.name} ${a.action === 'check' ? 'stock check' : 'catalogue'} failed: ${msg}`, isError: true, label: 'sourcing', detail: msg };
  }
}

export type { CostReport, StockReport, SupplierPart };
