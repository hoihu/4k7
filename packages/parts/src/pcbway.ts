/**
 * PCBWay's online assembly quote (the form at pcbway.com/quotesmt.aspx), as the `quote` of a PartSource.
 * PCBWay publishes no assembly fees and keeps no parts catalogue the app can read (its entry in
 * packages/schema/src/sourcing.ts says so): the quote is all the app can ask it. It prices turnkey
 * assembly by the boards, the sides, the unique parts and, per board, the parts placed by machine,
 * the large ICs among them (BGA, QFP: "more than 16 pins") and the through-hole parts; the price is
 * the assembly alone, its $29 offer applied when the order qualifies.
 *
 * It sends no CORS headers, so the local server calls it, not the browser. Not an official API: an
 * answer in an unexpected form is an error.
 */
import { PCBWAY_ASSEMBLY, type SupplierPart } from '@4k7/schema';
import type { AssemblyQuote, QuoteOrder } from './cost.ts';
import type { PartSource } from './sourcing.ts';

type Post = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The request behind the quote form's price. */
export const PCBWAY_QUOTE = '/Quote/GetDeliveryDays/';

interface PcbwayPrice {
  /** What it charges for the quantity asked, its offer applied; and before the offer. */
  Price?: string;
  PriceOriginal?: string;
  /** Its lead time: "5-6 days". */
  Data?: string;
  CurrencySymbol?: string;
  /** The quantity asked, then 20, 50 and 200 (Price1 … Price3). */
  ListQty?: number[];
}

/** The quote form's fields for an order (turnkey: every part bought by PCBWay; single boards). */
export function pcbwayQuoteForm(o: QuoteOrder): URLSearchParams {
  return new URLSearchParams({
    pagetype: '3',
    partVias: '1',
    boardType: '1',
    hidAssemblySide: o.sides === 2 ? '5' : '3',
    txtBoardNum: String(o.boards),
    txtICType: String(o.uniqueParts),
    txtPadsNum: String(o.smdParts),
    txtBGA: String(o.largeParts),
    txtHolesNum: String(o.thParts),
  });
}

/** PCBWay: no catalogue (search and lookup say why), and its assembly quote. */
export function pcbwaySource(fetchFn: Post = (u, i) => fetch(u, i), base = 'https://www.pcbway.com'): PartSource {
  const none = (): Promise<never> => Promise.reject(new Error(PCBWAY_ASSEMBLY.noCatalogue));
  return {
    search: none as () => Promise<SupplierPart[]>,
    lookup: none as () => Promise<SupplierPart | null>,
    async quote(order) {
      const res = await fetchFn(`${base}${PCBWAY_QUOTE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
        body: pcbwayQuoteForm(order).toString(),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`pcbway.com answered HTTP ${res.status}`);
      return quoteOf((await res.json().catch(() => null)) as unknown);
    },
  };
}

/** The quote's answer: [{ Price, PriceOriginal, Data, CurrencySymbol … }]. */
export function quoteOf(raw: unknown): AssemblyQuote {
  const q = (Array.isArray(raw) ? raw[0] : null) as PcbwayPrice | null;
  const price = Number(q?.Price);
  if (!q || !Number.isFinite(price) || price <= 0 || q.CurrencySymbol !== '$') throw new Error('pcbway.com: an answer this version does not read');
  const list = Number(q.PriceOriginal);
  return { price, ...(Number.isFinite(list) && list > price ? { list } : {}), ...(q.Data ? { days: q.Data } : {}) };
}
