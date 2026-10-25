/**
 * Eurocircuits' component database, the parts its assembly configurator searches (be.eurocircuits.com,
 * "Eurocircuits Components Verified Database"), as a PartSource for the sourcing in sourcing.ts.
 * Eurocircuits' own facts (the `eurocircuits` parameter, Generic / eC-stock / On Demand, its fees) are
 * its AssemblyHouse entry in packages/schema/src/sourcing.ts.
 *
 * Every part says its class: Generic (resistors and capacitors under Eurocircuits' own numbers,
 * "GPR06034K7", kept in stock and free at €0.02 or less), eC-stock (kept in stock) or On Demand
 * (bought for the order from its suppliers). The database gives no stock counts and no prices: a kept
 * part is in stock without a count, an On Demand part's supply is checked when the order is placed.
 * The search sends no CORS headers, so the local server calls it, not the browser. It is not an
 * official API: an answer in an unexpected form is an error, never an empty catalogue.
 */
import { EUROCIRCUITS_ASSEMBLY, parseQuantity, type PartQuery, type PlacementKind, type SupplierPart } from '@4k7/schema';
import { formatFarads, formatOhms, rankParts, type PartSource } from './sourcing.ts';

const TIERS = EUROCIRCUITS_ASSEMBLY.tiers.map((t) => t.name);

type Post = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The search behind the assembly configurator's part search. */
export const EUROCIRCUITS_SEARCH = '/shop/assembly/searchpart.aspx';

/** A part as the search lists it (the fields read here). */
interface EcItem {
  mpn?: string;
  manuf?: string;
  desc?: string;
  cat?: string;
  /** "1": a Generic part, "1": kept in eC-stock. */
  gpn?: string;
  ecstock?: string;
  lifecycle?: string;
  /** How it is placed: "smd", "SMD FINEPITCH", "th", "qfn", "bga" … */
  type?: string;
  /** "0603", "0603, 1608" */
  pack_type?: string | null;
  /** "10 kohm (10000.0Ohms)", "10kohm" */
  resis?: string | null;
  /** "0.1µF (0.1µF)", "0.1uF" */
  capacitance?: string | null;
  oper_volt?: string | null;
  /** "±1% (1%)", "10%", "1" */
  toler?: string | null;
  /** "100 mW (0.1Watts)", "100mW" */
  power?: string | null;
  /** Datasheet link. */
  url?: string | null;
}

/** Which classes a search asks for: the database answers one class at a time, or every class when none is asked. */
type Classes = { generic?: boolean; stock?: boolean; demand?: boolean };
const GENERIC: Classes = { generic: true };
const EC_STOCK: Classes = { stock: true };
const ON_DEMAND: Classes = { demand: true };

/**
 * Eurocircuits' component database: a part by its number (a Generic number or a manufacturer part
 * number, any case), a resistor or capacitor by value and package in each class (Generic first), words
 * of a description or a part number, and every Generic resistor or capacitor of a package (the values
 * without a fee: 167 resistors and 60 capacitors in 0603).
 */
export function eurocircuitsSource(fetchFn: Post = (u, i) => fetch(u, i), base = 'https://be.eurocircuits.com'): PartSource {
  const call = async (classes: Classes, body: unknown[], length: number): Promise<EcItem[]> => {
    const qs = new URLSearchParams({
      opencomponentsearch: 'true',
      start: '0',
      length: String(length),
      isMulti: '0',
      is_generic: classes.generic ? '1' : '0',
      is_ec_stock: classes.stock ? '1' : '0',
      is_ondemand: classes.demand ? '1' : '0',
      customer_id: '0',
    });
    const res = await fetchFn(`${base}${EUROCIRCUITS_SEARCH}?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`eurocircuits.com answered HTTP ${res.status}`);
    const out = (await res.json().catch(() => null)) as { Status?: number; Parts?: unknown } | null;
    if (out?.Status !== 1 || !Array.isArray(out.Parts)) throw new Error('eurocircuits.com: an answer this version does not read');
    return out.Parts as EcItem[];
  };
  /** The search's body: words (it needs them), and the value and package as its specs. */
  const ask = (words: string, specs: { value: string | number; spec: string; unit: string }[] = []) => [{ index: 0, descr: words, mpn: words, spn: words, specs }];

  return {
    async search(q) {
      const pkg = chipPackage(q.package);
      const passive = q.kind === 'resistor' || q.kind === 'capacitor';
      if (passive && !q.value?.trim()) return genericList(q.kind!, q.package, q);
      let body: unknown[];
      if (passive) {
        const v = q.value ? parseQuantity(q.value) : null;
        if (!v || !(v.value >= 0)) throw new Error(`Give the ${q.kind} value, e.g. ${q.kind === 'resistor' ? '"10k"' : '"100nF"'}.`);
        const spec = q.kind === 'resistor' ? ohmsSpec(v.value) : faradsSpec(v.value);
        body = ask(`${spec.value}${spec.unit}${pkg ? ` ${pkg}` : ''}`, [spec, ...(pkg ? [{ value: pkg, spec: 'pack', unit: '' }] : [])]);
      } else {
        const words = q.text?.trim();
        if (!words) throw new Error('Give text to search for, or kind + value for a resistor/capacitor.');
        body = ask(words);
      }
      const classes = q.noFee ? [GENERIC, EC_STOCK] : [GENERIC, EC_STOCK, ON_DEMAND];
      const found = (await Promise.all(classes.map((c) => call(c, body, 25)))).flat().map(fromEurocircuits);
      const seen = new Set<string>();
      let parts = found.filter((p) => {
        if (!p.sku || seen.has(p.sku)) return false;
        seen.add(p.sku);
        // a value and package also finds thermistors, networks and arrays: keep the kind asked for
        return !passive || kindOf(p) === q.kind;
      });
      if (q.noFee) parts = parts.filter((p) => !p.fee);
      return rankParts(parts, TIERS).slice(0, q.limit ?? 8);
    },

    async lookup(id) {
      const n = EUROCIRCUITS_ASSEMBLY.normalize(id);
      if (!n) return null;
      const hit = (await call({}, [{ index: 0, mpn: n }], 5)).find((c) => (c.mpn ?? '').trim().toUpperCase() === n.toUpperCase());
      return hit ? fromEurocircuits(hit) : null;
    },
  };

  /** Every Generic resistor or capacitor of a package: the values Eurocircuits assembles without the On Demand fee, free. */
  async function genericList(kind: 'resistor' | 'capacitor', pkgText: string | undefined, q: PartQuery): Promise<SupplierPart[]> {
    const pkg = chipPackage(pkgText);
    if (!q.noFee || !pkg) throw new Error(`A list of ${kind}s needs a chip package (0402, 0603 …) and no_fee; give a value to search for one.`);
    const items = await call(GENERIC, ask(pkg, [{ value: pkg, spec: 'pack', unit: '' }]), 500);
    const parts = items.map(fromEurocircuits).filter((p) => kindOf(p) === kind && p.package === pkg);
    return rankParts(parts, TIERS).slice(0, q.limit ?? 400);
  }
}

/** A chip size as the search's package spec takes it ("0603"; "603" → "0603"); undefined for anything else. */
function chipPackage(pkg: string | undefined): string | undefined {
  const m = /^(?:[RC])?(0?\d{3}|\d{4}|01005)$/i.exec((pkg ?? '').trim());
  if (!m) return undefined;
  const s = m[1]!;
  return s.length === 3 ? `0${s}` : s;
}

const sig = (n: number) => String(Number(n.toPrecision(4)));
function ohmsSpec(v: number) {
  return v >= 1e6 ? { value: sig(v / 1e6), spec: 'res', unit: 'Mohm' } : v >= 1e3 ? { value: sig(v / 1e3), spec: 'res', unit: 'kohm' } : { value: sig(v), spec: 'res', unit: 'ohm' };
}
function faradsSpec(v: number) {
  return v >= 1e-6 ? { value: sig(v * 1e6), spec: 'cap', unit: 'uF' } : v >= 1e-9 ? { value: sig(v * 1e9), spec: 'cap', unit: 'nF' } : { value: sig(v * 1e12), spec: 'cap', unit: 'pF' };
}

/** A resistor or capacitor by the database's category (chip resistors, ceramic capacitors), else null. */
function kindOf(p: SupplierPart): 'resistor' | 'capacitor' | null {
  const c = (p.category ?? '').toLowerCase();
  if (c === 'resistors') return 'resistor';
  if (/capacitor/.test(c) && !/electrolytic|tantalum|polymer|trimmer|variable|film/.test(`${c} ${p.description.toLowerCase()}`)) return 'capacitor';
  return null;
}

/** The value a field gives: its last bracket when it has one ("10 kohm (10000.0Ohms)" → "10000.0Ohms"), else the field. */
const plain = (s: string | null | undefined) => {
  const t = (s ?? '').trim();
  const m = /\(([^()]+)\)\s*$/.exec(t);
  return (m ? m[1]! : t).trim();
};

/** How the database's placement types are priced. */
const PLACEMENTS: Record<string, PlacementKind> = {
  smd: 'smd',
  'smd finepitch': 'fine',
  finepitch: 'fine',
  qfn: 'qfn',
  'qfn finepitch': 'qfnFine',
  bga: 'bga',
  'bga finepitch': 'bgaFine',
  lga: 'lga',
  th: 'th',
  th_r: 'th',
  th_cut: 'th',
  pressfit: 'th',
  mixed: 'mixed',
  'edge-mount': 'edge',
};

/** One part of the database's search. */
export function fromEurocircuits(c: EcItem): SupplierPart {
  const sku = (c.mpn ?? '').trim();
  const desc = (c.desc ?? '').trim();
  const generic = c.gpn === '1' || /^GP[RCH]/i.test(sku);
  const tier = generic ? 'Generic' : c.ecstock === '1' ? 'eC-stock' : 'On Demand';
  const attributes: Record<string, string> = {};
  if (/^resistors$/i.test(c.cat ?? '') || /^GPR/i.test(sku)) {
    const ohms = parseQuantity(plain(c.resis)) ?? parseQuantity(/([\d.]+\s*[kKM]?)\s*ohms?\b/i.exec(desc)?.[1]?.replace(/\s/g, '') ?? '');
    if (ohms && (ohms.unit === 'Ω' || ohms.unit === '')) attributes.Resistance = formatOhms(ohms.value);
  }
  const farads = parseQuantity(plain(c.capacitance)) ?? parseQuantity(/(\d+(?:\.\d+)?\s*[pnuµ]F)\b/.exec(desc)?.[1]?.replace(/\s/g, '') ?? '');
  if (farads?.unit === 'F' && /capacitor/i.test(`${c.cat ?? ''} ${desc}`)) attributes.Capacitance = formatFarads(farads.value);
  const volts = parseQuantity(plain(c.oper_volt)) ?? (attributes.Capacitance ? parseQuantity(/(\d+(?:\.\d+)?)\s*V\b/.exec(desc)?.[1] ?? '') : null);
  if (volts && volts.value > 0 && (volts.unit === 'V' || volts.unit === '')) attributes['Voltage Rated'] = `${sig(volts.value)}V`;
  const tol = /(\d*\.?\d+)\s*%?$/.exec(plain(c.toler).replace(/^±\s*/, ''));
  if (tol && c.toler) attributes.Tolerance = `±${tol[1]}%`;
  const watts = plain(c.power).replace(/watts?$/i, 'W').replace(/\s/g, '');
  if (watts && parseQuantity(watts)?.unit === 'W') attributes['Power(Watts)'] = watts;
  const dielectric = /\b(C0G|NP0|X5R|X6S|X7R|X7S|X8R|Y5V|Z5U)\b/i.exec(desc)?.[1];
  if (dielectric && attributes.Capacitance) attributes['Temperature Coefficient'] = dielectric.toUpperCase();
  const manufacturer = c.manuf?.trim();
  const url = c.url?.trim();
  const lifecycle = c.lifecycle?.trim();
  const placement = PLACEMENTS[(c.type ?? '').trim().toLowerCase()];
  return {
    sku,
    mpn: sku,
    ...(manufacturer && manufacturer !== 'Unknown' ? { manufacturer } : {}),
    package: packageOf(c, sku, desc),
    description: desc,
    stock: null,
    supply: tier === 'On Demand' ? 'order' : 'stock',
    tier,
    fee: tier === 'On Demand',
    // Generic parts are free (Eurocircuits gives away those of €0.02 or less: most); the rest have no price here
    price: generic ? [{ qty: 1, each: 0 }] : [],
    attributes,
    ...(c.cat ? { category: c.cat.trim() } : {}),
    ...(url && /^https?:\/\//i.test(url) ? { datasheet: url } : {}),
    url: EUROCIRCUITS_ASSEMBLY.partUrl!(sku),
    live: true,
    ...(lifecycle ? { lifecycle } : {}),
    ...(placement ? { placement } : {}),
  };
}

/** The package as a chip size where it is one ("0603, 1608" → "0603"), from the record, the description or a Generic number. */
function packageOf(c: EcItem, sku: string, desc: string): string {
  const listed = (c.pack_type ?? '').split(',')[0]!.trim();
  if (listed) return listed;
  const chip = /\b(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)\b/.exec(desc)?.[1] ?? /^GP[RC](\d{4})/i.exec(sku)?.[1];
  return chip ?? '';
}
