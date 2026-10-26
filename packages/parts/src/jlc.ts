/**
 * JLCPCB's catalogue of assembly parts (LCSC part numbers), as PartSources for the sourcing in
 * sourcing.ts. JLCPCB's own facts (the `lcsc` parameter, Basic/Preferred/Extended, the loading fee)
 * are its AssemblyHouse entry in packages/schema/src/sourcing.ts.
 *
 * - `jlcpcbSource`: jlcpcb.com itself, the search its parts library runs (live stock, price breaks,
 *   class, datasheet link). It sends no CORS headers, so the local server calls it, not the browser.
 * - `tscircuitSource`: the jlcsearch.tscircuit.com mirror (CORS-enabled), when jlcpcb.com cannot be
 *   reached. It lags, and has no stock for most resistors and capacitors.
 *
 * Neither is an official API: an answer in an unexpected form is an error, never an empty catalogue.
 */
import { JLCPCB_ASSEMBLY, normalizeLcsc, parseQuantity, type HouseFootprint, type PartQuery, type SupplierPart } from '@4k7/schema';
import { formatFarads, formatOhms, rankParts, type PartSource } from './sourcing.ts';

const TIERS = JLCPCB_ASSEMBLY.tiers.map((t) => t.name);
const partUrl = (sku: string) => JLCPCB_ASSEMBLY.partUrl!(sku);
const tierOf = (basic: boolean | undefined, preferred: boolean | undefined) => (basic ? 'Basic' : preferred ? 'Preferred' : 'Extended');
const feeOf = (tier: string) => JLCPCB_ASSEMBLY.tiers.find((t) => t.name === tier)?.fee ?? true;

/** A parametric search's value as the catalogue writes it ("10kΩ", "100nF"); throws when it is not one. */
function passiveWords(q: PartQuery): string {
  const v = q.value ? parseQuantity(q.value) : null;
  if (!v) throw new Error(`Give the ${q.kind} value, e.g. ${q.kind === 'resistor' ? '"10k"' : '"100nF"'}.`);
  return q.kind === 'resistor' ? formatOhms(v.value) : formatFarads(v.value);
}

/* ------------------------------ jlcpcb.com (live) ------------------------------ */

type Post = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The search behind jlcpcb.com/parts (a C-number finds that part among similar ones). */
export const JLCPCB_SEARCH = '/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList';

interface JlcpcbItem {
  componentCode?: string;
  componentModelEn?: string;
  componentBrandEn?: string;
  componentSpecificationEn?: string;
  describe?: string;
  stockCount?: number;
  /** "base" (Basic) or "expand" (Extended) */
  componentLibraryType?: string;
  preferredComponentFlag?: boolean;
  componentPrices?: { startNumber?: number; productPrice?: number }[];
  attributes?: { attribute_name_en?: string; attribute_value_name?: string }[];
  componentTypeEn?: string;
  dataManualUrl?: string;
  /** Pieces added for losses in assembly ("loss"), and the fewest it places ("least patch": SMT placement) */
  lossNumber?: number;
  leastPatchNumber?: number;
}

/** JLCPCB's names for what the checks read under other names (see SupplierPart.attributes). */
const ATTRIBUTE_NAMES: Record<string, string> = { 'Voltage Rating': 'Voltage Rated' };

/**
 * jlcpcb.com's own parts search: what its parts library shows, stock as of the call. A search asks
 * for 50 in-stock parts (a page and a half of the parts library) and ranks them here (Basic,
 * Preferred, Extended, then stock); a lookup searches for the number and keeps the exact match.
 */
export function jlcpcbSource(fetchFn: Post = (u, i) => fetch(u, i), base = 'https://jlcpcb.com', getFn: Get = (u, i) => fetch(u, i)): PartSource {
  const call = async (body: Record<string, unknown>): Promise<JlcpcbItem[]> => {
    const res = await fetchFn(`${base}${JLCPCB_SEARCH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ currentPage: 1, pageSize: 50, ...body }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`jlcpcb.com answered HTTP ${res.status}`);
    const out = (await res.json().catch(() => null)) as { code?: number; message?: string; data?: { componentPageInfo?: { list?: unknown } } } | null;
    if (out?.code !== 200) throw new Error(`jlcpcb.com: ${out?.message || 'an answer this version does not read'}`);
    const page = out.data?.componentPageInfo;
    // a search that finds nothing has a page with list: null
    if (page && typeof page === 'object' && page.list === null) return [];
    if (!page || !Array.isArray(page.list)) throw new Error('jlcpcb.com: an answer this version does not read');
    return page.list as JlcpcbItem[];
  };

  return {
    async search(q) {
      const pkg = q.package?.trim();
      if ((q.kind === 'resistor' || q.kind === 'capacitor') && !q.value?.trim()) return feeFreeList(q.kind, pkg, q);
      const words = q.kind === 'resistor' || q.kind === 'capacitor' ? passiveWords(q) : q.text?.trim();
      if (!words) throw new Error('Give text to search for, or kind + value for a resistor/capacitor.');
      let ask: Record<string, unknown> = { keyword: words, stockFlag: true, ...(pkg ? { componentSpecificationList: [pkg] } : {}) };
      let items = await call(ask);
      // JLCPCB names a package several ways ("SOT-223", "SOT-223-3"): with none under the exact name, it joins the words
      if (!items.length && pkg && !q.kind) items = await call((ask = { keyword: `${words} ${pkg}`, stockFlag: true }));
      // Basic parts can sit beyond the first page of a popular search: a fee-free or a passive's search asks for them too
      if (q.noFee || q.kind) items = [...(await call({ ...ask, componentLibraryType: 'base' })), ...items];
      const seen = new Set<string>();
      let parts = items.map(fromJlcpcb).filter((p) => {
        if (!p.sku || seen.has(p.sku)) return false;
        seen.add(p.sku);
        return true;
      });
      if (q.noFee) parts = parts.filter((p) => !p.fee);
      return rankParts(parts, TIERS).slice(0, q.limit ?? 8);
    },

    async lookup(id) {
      const sku = normalizeLcsc(id);
      if (!sku) return null;
      const hit = (await call({ keyword: sku, pageSize: 10 })).find((c) => c.componentCode === sku);
      return hit ? fromJlcpcb(hit) : null;
    },

    /** The part's footprint in JLCPCB's parts library (EasyEDA's, the one its placement uses). */
    async footprint(id) {
      const sku = normalizeLcsc(id);
      if (!sku) return null;
      const res = await getFn(easyedaComponentUrl(sku), { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`easyeda.com answered HTTP ${res.status}`);
      return easyedaFootprint(await res.json().catch(() => null));
    },
  };

  /**
   * Every Basic resistor or capacitor of a package in stock (80 resistors and 33 capacitors in 0603):
   * the values that cost no loading fee. The search matches whole words: "Resistor" is in every chip
   * resistor's description, "Capacitors" in every ceramic capacitor's category.
   */
  async function feeFreeList(kind: 'resistor' | 'capacitor', pkg: string | undefined, q: PartQuery): Promise<SupplierPart[]> {
    if (!q.noFee || !pkg) throw new Error(`A list of ${kind}s needs a package and no_fee; give a value to search for one.`);
    const items: JlcpcbItem[] = [];
    for (let page = 1; page <= 4; page++) {
      const got = await call({ keyword: kind === 'resistor' ? 'Resistor' : 'Capacitors', stockFlag: true, componentLibraryType: 'base', componentSpecificationList: [pkg], currentPage: page, pageSize: 100 });
      items.push(...got);
      if (got.length < 100) break;
    }
    return rankParts(items.map(fromJlcpcb), TIERS).slice(0, q.limit ?? 400);
  }
}

/* ------------------------------ footprints (EasyEDA) ------------------------------ */

type Get = (url: string, init: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Where JLCPCB's parts library keeps an LCSC part's symbol and footprint: EasyEDA's component API. */
export const easyedaComponentUrl = (lcsc: string) => `https://easyeda.com/api/products/${encodeURIComponent(lcsc)}/components?version=6.4.19.5`;

/** EasyEDA's canvas unit, 10 mil, in mm. */
const EASYEDA_UNIT = 0.254;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * A part's footprint from EasyEDA's component API: every pad with its number, its size and where it
 * is from the footprint's origin (top view, y down, mm), and each pin's name from the symbol. Null
 * when EasyEDA does not know the part; an error for an answer in a form this version does not read.
 */
export function easyedaFootprint(raw: unknown): HouseFootprint | null {
  if (!raw || typeof raw !== 'object') throw new Error('easyeda.com: an answer this version does not read');
  const r = raw as { success?: boolean; result?: { dataStr?: { shape?: unknown }; packageDetail?: { title?: string; dataStr?: { head?: { x?: unknown; y?: unknown }; shape?: unknown } } } | null };
  if (r.success === false || !r.result) return null;
  const pkg = r.result.packageDetail;
  const shapes = pkg?.dataStr?.shape;
  if (!pkg || !Array.isArray(shapes)) throw new Error('easyeda.com: a part without a footprint this version can read');
  const ox = Number(pkg.dataStr?.head?.x ?? 0);
  const oy = Number(pkg.dataStr?.head?.y ?? 0);
  // the pins' names, from the symbol's pins ("P~show~type~number~x~y…^^…^^…^^…~name~…")
  const names = new Map<string, string>();
  const sym = r.result.dataStr?.shape;
  for (const s of Array.isArray(sym) ? sym : []) {
    if (typeof s !== 'string' || !s.startsWith('P~')) continue;
    const seg = s.split('^^');
    const num = seg[0]!.split('~')[3];
    const name = seg[3]?.split('~')[4]?.trim();
    if (num && name) names.set(num, name);
  }
  // the pads: "PAD~shape~x~y~width~height~layer~net~number~hole radius~outline points~rotation~…"
  const pads: HouseFootprint['pads'] = [];
  for (const s of shapes) {
    if (typeof s !== 'string' || !s.startsWith('PAD~')) continue;
    const f = s.split('~');
    const [x, y, w, h] = [f[2], f[3], f[4], f[5]].map(Number);
    const number = (f[8] ?? '').trim();
    const pts = (f[10] ?? '').trim().split(/\s+/).filter(Boolean).map(Number);
    let [pw, ph] = [w!, h!];
    if (pts.length >= 6 && pts.every(Number.isFinite)) {
      // its outline: the pad's extent whatever it is turned by
      const xs = pts.filter((_, i) => i % 2 === 0);
      const ys = pts.filter((_, i) => i % 2 === 1);
      [pw, ph] = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    } else if (Math.round(Number(f[11] ?? 0) / 90) % 2 !== 0) [pw, ph] = [h!, w!];
    if (![x, y, pw, ph].every((v) => Number.isFinite(v)) || !number) throw new Error('easyeda.com: a pad this version does not read');
    const name = names.get(number);
    pads.push({ number, ...(name ? { name } : {}), x: r3((x! - ox) * EASYEDA_UNIT), y: r3((y! - oy) * EASYEDA_UNIT), w: r3(pw * EASYEDA_UNIT), h: r3(ph * EASYEDA_UNIT), ...(Number(f[9]) > 0 ? { drill: true } : {}) });
  }
  if (!pads.length) throw new Error('easyeda.com: a footprint without pads');
  return { name: pkg.title ?? '', pads };
}

/** One part of jlcpcb.com's search. */
export function fromJlcpcb(c: JlcpcbItem): SupplierPart {
  const sku = normalizeLcsc(c.componentCode ?? '') ?? '';
  const tier = tierOf(c.componentLibraryType === 'base', c.preferredComponentFlag);
  const attributes: Record<string, string> = {};
  for (const a of c.attributes ?? []) {
    const name = a.attribute_name_en?.trim();
    const value = a.attribute_value_name?.trim();
    if (name && value && value !== '-') attributes[ATTRIBUTE_NAMES[name] ?? name] = value;
  }
  const price = (c.componentPrices ?? [])
    .filter((b) => typeof b.startNumber === 'number' && typeof b.productPrice === 'number')
    .map((b) => ({ qty: b.startNumber!, each: b.productPrice! }))
    .sort((a, b) => a.qty - b.qty);
  const manufacturer = c.componentBrandEn?.replace(/\(.*\)$/, '').trim();
  const datasheet = c.dataManualUrl && /^https?:\/\//i.test(c.dataManualUrl) ? c.dataManualUrl : undefined;
  return {
    sku,
    mpn: c.componentModelEn?.trim() ?? '',
    ...(manufacturer ? { manufacturer } : {}),
    package: c.componentSpecificationEn?.trim() ?? '',
    description: c.describe?.trim() ?? '',
    stock: typeof c.stockCount === 'number' ? c.stockCount : null,
    tier,
    fee: feeOf(tier),
    price,
    attributes,
    ...(c.componentTypeEn ? { category: c.componentTypeEn } : {}),
    ...(datasheet ? { datasheet } : {}),
    url: partUrl(sku),
    live: true,
    ...(typeof c.lossNumber === 'number' && c.lossNumber > 0 ? { attrition: c.lossNumber } : {}),
    ...(typeof c.leastPatchNumber === 'number' && c.leastPatchNumber > 0 ? { minQty: c.leastPatchNumber } : {}),
  };
}

/* ------------------------------ tscircuit mirror ------------------------------ */

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface TsComponent {
  lcsc: number;
  mfr: string;
  package?: string;
  description?: string;
  /** null on most resistor and capacitor rows */
  stock?: number | null;
  /** components endpoint: "1-499:0.0176,500-1499:0.0135,48000-:0.0095" */
  price?: string;
  /** category endpoints: price at quantity 1 */
  price1?: number;
  category?: string;
  subcategory?: string;
  is_basic?: boolean;
  is_preferred?: boolean;
  /** category endpoints: JSON text of the catalogue attributes */
  attributes?: string;
  resistance?: number;
  capacitance_farads?: number;
  voltage_rating?: number;
}

/**
 * jlcsearch.tscircuit.com: a copy of JLCPCB's catalogue with a JSON API (`/components/list.json`,
 * `/resistors/list.json`, `/capacitors/list.json`) and a cached copy of EasyEDA's per-part record
 * (`/api/easyeda_components/C…`), which carries the datasheet link. Its parts are not `live`.
 */
export function tscircuitSource(fetchFn: Fetch = (u) => fetch(u), base = 'https://jlcsearch.tscircuit.com'): PartSource {
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchFn(`${base}${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`JLCPCB catalogue mirror: HTTP ${res.status} for ${path}`);
    return res.json();
  };
  const list = async (path: string, key: string): Promise<TsComponent[]> => {
    const out = (await get(path)) as Record<string, unknown> | null;
    const items = out?.[key];
    return Array.isArray(items) ? (items as TsComponent[]) : [];
  };

  return {
    async search(q) {
      const pkg = q.package?.trim() ? `&package=${encodeURIComponent(q.package.trim())}` : '';
      let items: TsComponent[];
      if ((q.kind === 'resistor' || q.kind === 'capacitor') && !q.value?.trim() && q.noFee && q.package) throw new Error(`the catalogue mirror cannot list every ${q.kind} of a package`);
      if (q.kind === 'resistor' || q.kind === 'capacitor') {
        const v = q.value ? parseQuantity(q.value) : null;
        if (!v) throw new Error(`Give the ${q.kind} value, e.g. ${q.kind === 'resistor' ? '"10k"' : '"100nF"'}.`);
        items =
          q.kind === 'resistor'
            ? await list(`/resistors/list.json?resistance=${encodeURIComponent(String(v.value))}${pkg}`, 'resistors')
            : await list(`/capacitors/list.json?capacitance=${encodeURIComponent(v.value.toExponential(6))}${pkg}`, 'capacitors');
      } else {
        const text = q.text?.trim();
        if (!text) throw new Error('Give text to search for, or kind + value for a resistor/capacitor.');
        items = await list(`/components/list.json?search=${encodeURIComponent(text)}${pkg}`, 'components');
      }
      let parts = items.map(fromTs);
      if (q.noFee) parts = parts.filter((p) => !p.fee);
      return rankParts(parts, TIERS).slice(0, q.limit ?? 8);
    },

    async lookup(id) {
      const lcsc = normalizeLcsc(id);
      if (!lcsc) return null;
      const out = (await get(`/api/easyeda_components/${lcsc}`)) as { easyeda_component_details?: { easyeda_json?: unknown } } | null;
      const json = out?.easyeda_component_details?.easyeda_json;
      if (!json) return null;
      const part = fromEasyEda(json, lcsc);
      // the record's stock is LCSC's, not JLCPCB's: the mirror's search has JLCPCB's (when it has any)
      if (part.mpn) {
        try {
          const listed = (await list(`/components/list.json?search=${encodeURIComponent(part.mpn)}`, 'components')).map(fromTs).find((p) => p.sku === lcsc);
          if (listed) Object.assign(part, { stock: listed.stock, price: listed.price.length ? listed.price : part.price, tier: listed.tier, fee: listed.fee, ...(listed.description ? { description: listed.description } : {}), ...(listed.category ? { category: listed.category } : {}) });
        } catch {
          /* the record alone will do */
        }
      }
      return part;
    },

    /** The part's footprint from the mirror's copy of its EasyEDA record (the same library JLCPCB places from). */
    async footprint(id) {
      const lcsc = normalizeLcsc(id);
      if (!lcsc) return null;
      const out = (await get(`/api/easyeda_components/${lcsc}`)) as { easyeda_component_details?: { easyeda_json?: unknown } } | null;
      const json = out?.easyeda_component_details?.easyeda_json;
      return json ? easyedaFootprint({ success: true, result: json }) : null;
    },
  };
}

function fromTs(c: TsComponent): SupplierPart {
  let attributes: Record<string, string> = {};
  if (c.attributes) {
    try {
      const a = JSON.parse(c.attributes) as Record<string, unknown>;
      attributes = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [ATTRIBUTE_NAMES[k] ?? k, String(v)]));
    } catch {
      /* not JSON: ignore */
    }
  }
  if (c.resistance !== undefined && !attributes.Resistance) attributes.Resistance = formatOhms(c.resistance);
  if (c.capacitance_farads !== undefined && !attributes.Capacitance) attributes.Capacitance = formatFarads(c.capacitance_farads);
  if (c.voltage_rating !== undefined && !attributes['Voltage Rated']) attributes['Voltage Rated'] = `${c.voltage_rating}V`;
  const sku = `C${c.lcsc}`;
  const tier = tierOf(c.is_basic, c.is_preferred);
  return {
    sku,
    mpn: c.mfr?.trim() ?? '',
    package: c.package?.trim() ?? '',
    description: c.description?.trim() ?? '',
    stock: typeof c.stock === 'number' ? c.stock : null,
    tier,
    fee: feeOf(tier),
    price: c.price ? parsePriceBreaks(c.price) : typeof c.price1 === 'number' ? [{ qty: 1, each: c.price1 }] : [],
    attributes,
    ...(c.subcategory || c.category ? { category: c.subcategory || c.category } : {}),
    url: partUrl(sku),
    live: false,
  };
}

/** "1-499:0.0176,500-1499:0.0135,48000-:0.0095" → breaks. Malformed pieces are skipped. */
export function parsePriceBreaks(s: string): { qty: number; each: number }[] {
  const out: { qty: number; each: number }[] = [];
  for (const piece of s.split(',')) {
    const m = /^\s*(\d+)\s*-\s*\d*\s*:\s*(\d*\.?\d+)\s*$/.exec(piece);
    if (m) out.push({ qty: Number(m[1]), each: Number(m[2]) });
  }
  return out.sort((a, b) => a.qty - b.qty);
}

interface EasyEdaJson {
  description?: string;
  tags?: string[];
  lcsc?: { number?: string; stock?: number; price?: number; url?: string };
  dataStr?: { head?: { c_para?: Record<string, string> } };
  packageDetail?: { dataStr?: { head?: { c_para?: Record<string, string> } } };
}

/**
 * The EasyEDA record of a part: who makes it, its package and value, the JLCPCB part class and the
 * datasheet link. Its stock is LCSC's (another warehouse), so the part's stock is unknown.
 */
export function fromEasyEda(raw: unknown, fallbackLcsc: string): SupplierPart {
  const j = (raw ?? {}) as EasyEdaJson;
  const para = j.dataStr?.head?.c_para ?? {};
  const pkgPara = j.packageDetail?.dataStr?.head?.c_para ?? {};
  const sku = normalizeLcsc(j.lcsc?.number ?? para['Supplier Part'] ?? '') ?? fallbackLcsc;
  const cls = (para['JLCPCB Part Class'] ?? '').toLowerCase();
  const tier = tierOf(cls.includes('basic'), cls.includes('preferred'));
  const attributes: Record<string, string> = {};
  if (para.Value) attributes.Value = para.Value;
  const link = pkgPara.link ?? para.link;
  const datasheet = link && /^https?:\/\//i.test(link) ? link : undefined;
  const manufacturer = para.Manufacturer?.replace(/\(.*\)$/, '').trim();
  return {
    sku,
    mpn: (para['Manufacturer Part'] ?? para.name ?? '').trim(),
    ...(manufacturer ? { manufacturer } : {}),
    package: normalizeEasyEdaPackage(para.package ?? ''),
    description: (j.description ?? '').trim(),
    stock: null,
    tier,
    fee: feeOf(tier),
    price: typeof j.lcsc?.price === 'number' ? [{ qty: 1, each: j.lcsc.price }] : [],
    attributes,
    ...(j.tags?.[0] ? { category: j.tags[0] } : {}),
    ...(datasheet ? { datasheet } : {}),
    url: partUrl(sku),
    live: false,
  };
}

/** EasyEDA footprint names: "R0603" → "0603", "C0805" → "0805"; anything else as it is. */
export function normalizeEasyEdaPackage(name: string): string {
  const m = /^[RCLD](\d{4})$/i.exec(name.trim());
  return m ? m[1]! : name.trim();
}
