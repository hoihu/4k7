/**
 * JLCPCB sourcing: parts of JLCPCB's assembly catalogue (LCSC part numbers) for a design.
 *
 * Nothing is imported in bulk. A resistor or capacitor stays the generic part and gets the chosen
 * LCSC number as its `lcsc` parameter; a part with pins is imported from the datasheet the catalogue
 * links to. Search and lookup go through a pluggable source so the data provider can change; the
 * default is the tscircuit jlcsearch mirror (CORS-enabled, so the browser calls it directly).
 * Stock and prices are a snapshot at the time of the call.
 */
import { normalizeLcsc, parseQuantity, type PartCard } from '@tracewise/schema';

/** Basic and Preferred parts have no loading fee at JLCPCB assembly; Extended parts cost one per unique part. */
export type JlcTier = 'basic' | 'preferred' | 'extended';

export interface JlcPart {
  /** "C25804" */
  lcsc: string;
  /** Manufacturer part number. */
  mpn: string;
  manufacturer?: string;
  /** Package as JLCPCB names it ("0603", "SOT-23", "SMD,5x5mm"). */
  package: string;
  description: string;
  stock: number;
  tier: JlcTier;
  /** Price breaks in USD per piece, smallest quantity first (may be empty). */
  price: { qty: number; usd: number }[];
  /** Catalogue attributes as listed ("Resistance": "10kΩ", "Voltage Rated": "50V"). */
  attributes: Record<string, string>;
  category?: string;
  /** Datasheet PDF link when the catalogue has one. */
  datasheet?: string;
  /** The part's page at JLCPCB. */
  url: string;
}

export interface JlcQuery {
  /** Words of the catalogue description ("passive buzzer", "AMS1117-3.3"). */
  text?: string;
  /** Parametric search for a jellybean passive (value in `value`); text is ignored. */
  kind?: 'resistor' | 'capacitor';
  value?: string;
  package?: string;
  basicOnly?: boolean;
  limit?: number;
}

export interface JlcSource {
  search(q: JlcQuery): Promise<JlcPart[]>;
  /** One part by LCSC number; null when the catalogue does not know it. */
  lookup(lcsc: string): Promise<JlcPart | null>;
}

export const JLC_PART_URL = (lcsc: string) => `https://jlcpcb.com/partdetail/${lcsc}`;

/* ------------------------------ tscircuit source ------------------------------ */

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface TsComponent {
  lcsc: number;
  mfr: string;
  package?: string;
  description?: string;
  stock?: number;
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
 * jlcsearch.tscircuit.com: an in-stock JLCPCB parts search with a JSON API (`/components/list.json`,
 * `/resistors/list.json`, `/capacitors/list.json`) and a cached copy of EasyEDA's per-part record
 * (`/api/easyeda_components/C…`), which carries the datasheet link.
 */
export function tscircuitSource(fetchFn: Fetch = (u) => fetch(u), base = 'https://jlcsearch.tscircuit.com'): JlcSource {
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchFn(`${base}${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`JLCPCB catalogue: HTTP ${res.status} for ${path}`);
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
      if (q.basicOnly) parts = parts.filter((p) => p.tier !== 'extended');
      return rankParts(parts).slice(0, q.limit ?? 8);
    },

    async lookup(id) {
      const lcsc = normalizeLcsc(id);
      if (!lcsc) return null;
      const out = (await get(`/api/easyeda_components/${lcsc}`)) as { easyeda_component_details?: { easyeda_json?: unknown } } | null;
      const json = out?.easyeda_component_details?.easyeda_json;
      if (!json) return null;
      const part = fromEasyEda(json, lcsc);
      // the EasyEDA record's stock and price lag; the live search knows the current ones
      if (part.mpn) {
        try {
          const live = (await list(`/components/list.json?search=${encodeURIComponent(part.mpn)}`, 'components')).map(fromTs).find((p) => p.lcsc === lcsc);
          if (live) Object.assign(part, { stock: live.stock, price: live.price.length ? live.price : part.price, tier: live.tier, ...(live.description ? { description: live.description } : {}), ...(live.category ? { category: live.category } : {}) });
        } catch {
          /* the record alone will do */
        }
      }
      return part;
    },
  };
}

/** Basic, then Preferred, then Extended; within a tier the deepest stock first. */
export function rankParts(parts: JlcPart[]): JlcPart[] {
  const rank: Record<JlcTier, number> = { basic: 0, preferred: 1, extended: 2 };
  return [...parts].sort((a, b) => rank[a.tier] - rank[b.tier] || b.stock - a.stock || a.lcsc.localeCompare(b.lcsc));
}

function fromTs(c: TsComponent): JlcPart {
  let attributes: Record<string, string> = {};
  if (c.attributes) {
    try {
      const a = JSON.parse(c.attributes) as Record<string, unknown>;
      attributes = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
    } catch {
      /* not JSON: ignore */
    }
  }
  if (c.resistance !== undefined && !attributes.Resistance) attributes.Resistance = formatOhms(c.resistance);
  if (c.capacitance_farads !== undefined && !attributes.Capacitance) attributes.Capacitance = formatFarads(c.capacitance_farads);
  if (c.voltage_rating !== undefined && !attributes['Voltage Rated']) attributes['Voltage Rated'] = `${c.voltage_rating}V`;
  const lcsc = `C${c.lcsc}`;
  return {
    lcsc,
    mpn: c.mfr?.trim() ?? '',
    package: c.package?.trim() ?? '',
    description: c.description?.trim() ?? '',
    stock: c.stock ?? 0,
    tier: c.is_basic ? 'basic' : c.is_preferred ? 'preferred' : 'extended',
    price: c.price ? parsePriceBreaks(c.price) : typeof c.price1 === 'number' ? [{ qty: 1, usd: c.price1 }] : [],
    attributes,
    ...(c.subcategory || c.category ? { category: c.subcategory || c.category } : {}),
    url: JLC_PART_URL(lcsc),
  };
}

/** "1-499:0.0176,500-1499:0.0135,48000-:0.0095" → breaks. Malformed pieces are skipped. */
export function parsePriceBreaks(s: string): { qty: number; usd: number }[] {
  const out: { qty: number; usd: number }[] = [];
  for (const piece of s.split(',')) {
    const m = /^\s*(\d+)\s*-\s*\d*\s*:\s*(\d*\.?\d+)\s*$/.exec(piece);
    if (m) out.push({ qty: Number(m[1]), usd: Number(m[2]) });
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

/** The EasyEDA record of a part: who makes it, its package and value, the JLCPCB part class and the datasheet link. */
export function fromEasyEda(raw: unknown, fallbackLcsc: string): JlcPart {
  const j = (raw ?? {}) as EasyEdaJson;
  const para = j.dataStr?.head?.c_para ?? {};
  const pkgPara = j.packageDetail?.dataStr?.head?.c_para ?? {};
  const lcsc = normalizeLcsc(j.lcsc?.number ?? para['Supplier Part'] ?? '') ?? fallbackLcsc;
  const cls = (para['JLCPCB Part Class'] ?? '').toLowerCase();
  const tier: JlcTier = cls.includes('basic') ? 'basic' : cls.includes('preferred') ? 'preferred' : 'extended';
  const attributes: Record<string, string> = {};
  if (para.Value) attributes.Value = para.Value;
  const link = pkgPara.link ?? para.link;
  const datasheet = link && /^https?:\/\//i.test(link) ? link : undefined;
  const manufacturer = para.Manufacturer?.replace(/\(.*\)$/, '').trim();
  return {
    lcsc,
    mpn: (para['Manufacturer Part'] ?? para.name ?? '').trim(),
    ...(manufacturer ? { manufacturer } : {}),
    package: normalizeEasyEdaPackage(para.package ?? ''),
    description: (j.description ?? '').trim(),
    stock: j.lcsc?.stock ?? 0,
    tier,
    price: typeof j.lcsc?.price === 'number' ? [{ qty: 1, usd: j.lcsc.price }] : [],
    attributes,
    ...(j.tags?.[0] ? { category: j.tags[0] } : {}),
    ...(datasheet ? { datasheet } : {}),
    url: JLC_PART_URL(lcsc),
  };
}

/** EasyEDA footprint names: "R0603" → "0603", "C0805" → "0805"; anything else as it is. */
export function normalizeEasyEdaPackage(name: string): string {
  const m = /^[RCLD](\d{4})$/i.exec(name.trim());
  return m ? m[1]! : name.trim();
}

/* ------------------------------ checks and text ------------------------------ */

/**
 * Why a catalogue part does not fit a component: value (resistance, capacitance, inductance),
 * a capacitor's voltage rating below what the design asks, or the package. Empty = it fits.
 */
export function sourcingMismatch(card: Pick<PartCard, 'category'>, params: Record<string, string>, effectivePackage: string | undefined, part: JlcPart): string[] {
  const out: string[] = [];
  const valueKey = card.category === 'resistor' ? 'resistance' : card.category === 'capacitor' ? 'capacitance' : card.category === 'inductor' ? 'inductance' : null;
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

const closeTo = (a: number, b: number) => Math.abs(a - b) <= 0.005 * Math.max(Math.abs(a), Math.abs(b));
const normPkg = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** One line per part, for the agent and for logs. */
export function describeJlcPart(p: JlcPart): string {
  const tier = p.tier === 'basic' ? 'Basic' : p.tier === 'preferred' ? 'Preferred' : 'Extended';
  const price = p.price[0] ? `$${trimNum(p.price[0].usd)}@${p.price[0].qty}` : '';
  const facts = p.description || Object.entries(p.attributes).map(([k, v]) => (k === 'Value' ? v : `${k} ${v}`)).join(', ');
  return [p.lcsc, p.mpn, p.package, tier, `stock ${p.stock.toLocaleString('en-US')}`, price, facts.slice(0, 140)].filter(Boolean).join(' · ');
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
