/**
 * Cheaper ways to make a resistor's or capacitor's value: another single value close to it, or two
 * parts in series or in parallel, from the parts without a fee in its package and the parts already
 * on the order. Each way says how far off it is and what it saves, with the fees, the pieces and the
 * extra joints counted. Whether a value may move is the circuit's call (a pull-up's, not a feedback
 * divider's): the agent decides, with the cost guide (docs/design/cost.md).
 */
import { parseQuantity, STOCK_MARGIN, type AssemblyHouse, type SupplierPart } from '@4k7/schema';
import { estimateOrder, estimateRange, MIN_SAVING, tierRate, type AssemblyFacts } from './cost.ts';
import { canReplace, checkStock, formatFarads, formatOhms, gradeFits, lineBuy, partValue, pool, replacementQuery, type PartSource, type SourcedComponent } from './sourcing.ts';

type Kind = 'resistor' | 'capacitor';

/** One way to make a value: the parts (one, or two in series or parallel), the value they make and how far off it is. */
export interface ValueOption {
  how: 'single' | 'series' | 'parallel';
  parts: SupplierPart[];
  /** Ω or F. */
  value: number;
  /** (value − wanted) / wanted. */
  deviation: number;
  /** What it costs the order: the pieces, any new loading fee, the extra joints (USD). */
  cost: number;
  /** What it saves against the line as it is (USD; absent when there is nothing to compare with). */
  usd?: number;
  /** Every part of it is on the order already: no new part number. */
  onOrder: boolean;
}

/** A resistor or capacitor line (or components without a part number) and the cheaper ways to make its value. */
export interface ValueLine {
  refs: string[];
  /** The part number it has; absent for components without one. */
  sku?: string;
  kind: Kind;
  /** The value the components ask for (Ω, F), and in words with the package ("31.6kΩ 0603"). */
  wanted: number;
  what: string;
  /** What the line costs the order now (or, without a number, what its cheapest same-value part would add); absent when nothing has the value. */
  now?: number;
  options: ValueOption[];
}

export interface ValuesReport {
  house: string;
  boards: number;
  at: string;
  /** The service the costs are counted for: the cheapest that takes the order. */
  service?: string;
  lines: ValueLine[];
  /** The values on the order already, by kind and package: using one adds no part number. */
  onOrder: { kind: Kind; pkg: string; parts: { part: SupplierPart; refs: string[] }[] }[];
  live: boolean;
}

/** How far a pair may be off: a resistor's within 1 % (precision is kept), a capacitor's within 10 %. */
const PAIR_OFF: Record<Kind, number> = { resistor: 0.01, capacitor: 0.1 };
/** A single other value is listed up to this factor away (a pull-up's value may move that far; the agent decides). */
const SINGLE_FACTOR = 2.2;
/** Within this, a value is the same (0.1 %). */
const EXACT = 0.001;

/**
 * The values check: for every resistor and capacitor of the design (with a part number or without),
 * the cheaper ways to make its value, best saving first. `facts` reads the board as for the cost check.
 */
export async function checkValues(
  components: SourcedComponent[],
  source: PartSource,
  opts: { house: AssemblyHouse; boards: number; facts: (assembled: Set<string>) => AssemblyFacts; concurrency?: number; now?: () => Date },
): Promise<ValuesReport> {
  const { house, boards } = opts;
  const stock = await checkStock(components, source, { house, boards, ...(opts.now ? { now: opts.now } : {}) });
  const facts = opts.facts(new Set(stock.lines.filter((l) => l.part).flatMap((l) => l.refs)));
  const range = estimateRange(estimateOrder(stock.lines, facts, boards, house));
  const svc = house.services.find((s) => s.name === range?.low.service) ?? house.services[0]!;
  const byRef = new Map(components.map((c) => [c.refdes, c]));
  const kindOf = (c: SourcedComponent | undefined): Kind | null => (c?.category === 'resistor' || c?.category === 'capacitor' ? c.category : null);
  const wantedOf = (c: SourcedComponent): number | null => {
    const q = parseQuantity(c.params[c.category === 'resistor' ? 'resistance' : 'capacitance'] ?? '');
    return q && q.value > 0 ? q.value : null;
  };

  // the jobs: the resistor and capacitor lines, and the ones without a number grouped like the cost check does
  interface Job {
    refs: string[];
    comps: SourcedComponent[];
    kind: Kind;
    wanted: number;
    pkg: string;
    part?: SupplierPart;
    sku?: string;
  }
  const jobs: Job[] = [];
  for (const l of stock.lines) {
    const comps = l.refs.map((r) => byRef.get(r)!);
    const kind = kindOf(comps[0]);
    const wanted = kind ? wantedOf(comps[0]!) : null;
    if (!kind || !wanted || !comps[0]!.pkg || !l.part) continue;
    jobs.push({ refs: l.refs, comps, kind, wanted, pkg: comps[0]!.pkg, part: l.part, sku: l.sku });
  }
  const loose = new Map<string, Job>();
  for (const ref of stock.unsourced) {
    const c = byRef.get(ref)!;
    const kind = kindOf(c);
    const wanted = kind ? wantedOf(c) : null;
    if (!kind || !wanted || !c.pkg) continue;
    const key = JSON.stringify([kind, wanted, c.pkg, c.params.voltage, c.params.tolerance, c.params.dielectric, c.params.power]);
    const j = loose.get(key) ?? { refs: [], comps: [], kind, wanted, pkg: c.pkg };
    j.refs.push(ref);
    j.comps.push(c);
    loose.set(key, j);
  }
  jobs.push(...loose.values());

  // the parts on the order, and the fee-free ones, per kind and package
  const key = (kind: Kind, pkg: string) => `${kind} ${pkg.toUpperCase()}`;
  const onOrder = new Map<string, { part: SupplierPart; refs: string[] }[]>();
  for (const j of jobs) if (j.part) onOrder.set(key(j.kind, j.pkg), [...(onOrder.get(key(j.kind, j.pkg)) ?? []), { part: j.part, refs: j.refs }]);
  const loaded = new Set(stock.lines.filter((l) => l.part).map((l) => l.sku));
  const lists = new Map<string, SupplierPart[]>();
  const kinds = new Map(jobs.map((j) => [key(j.kind, j.pkg), { kind: j.kind, pkg: j.pkg }]));
  await pool([...kinds], opts.concurrency ?? 4, async ([k, { kind, pkg }]) => {
    try {
      lists.set(k, await source.search({ kind, package: pkg, noFee: true, limit: 400 }));
    } catch {
      lists.set(k, []); // no list: the parts on the order still count
    }
  });

  const feeOf = (p: SupplierPart) => (loaded.has(p.sku) ? 0 : svc.loading.per === 'part' || p.fee ? svc.loading.usd : 0);
  const jointRate = tierRate(svc.smtJoint, facts.smtJoints * boards);
  const lines: ValueLine[] = [];
  await pool(jobs, opts.concurrency ?? 4, async (j) => {
    const need = j.refs.length * boards;
    // what the line costs now; without a number, what its cheapest same-value part would add
    let now: number | undefined;
    if (j.part) {
      const buy = lineBuy(j.part, need);
      if (buy) now = buy.usd + (svc.loading.per === 'part' || j.part.fee ? svc.loading.usd : 0);
    } else {
      const q = replacementQuery(j.comps[0]!);
      const same = q ? await source.search(q).catch(() => [] as SupplierPart[]) : [];
      const adds = same.filter((p) => j.comps.every((c) => canReplace(p, c, undefined, need))).map((p) => (lineBuy(p, need)?.usd ?? Infinity) + feeOf(p));
      if (adds.length) now = Math.min(...adds);
    }

    // the parts that may stand in, one per value (the cheapest for the order), without the line's own
    const mine = j.sku;
    const candidates = [...(onOrder.get(key(j.kind, j.pkg)) ?? []).map((o) => o.part), ...(lists.get(key(j.kind, j.pkg)) ?? [])].filter(
      (p) => p.sku !== mine && p.stock !== null && j.comps.every((c) => gradeFits(p, c, j.part)),
    );
    const byValue = new Map<number, { p: SupplierPart; v: number; cost: number }>();
    for (const p of candidates) {
      const v = partValue(p, j.kind);
      if (!v) continue; // a 0 Ω jumper makes no value
      const cost = (lineBuy(p, need)?.usd ?? Infinity) + feeOf(p);
      const had = byValue.get(v);
      if (!had || cost < had.cost) byValue.set(v, { p, v, cost });
    }
    const pool2 = [...byValue.values()].sort((a, b) => a.v - b.v);

    const cost = (parts: SupplierPart[]) => {
      const pieces = new Map<string, { p: SupplierPart; n: number }>();
      for (const p of parts) pieces.set(p.sku, { p, n: (pieces.get(p.sku)?.n ?? 0) + 1 });
      let usd = 0;
      for (const { p, n } of pieces.values()) {
        // a part about to run out is no saving: plenty of stock, as for the cost check's savings
        if (p.stock! < n * need * STOCK_MARGIN) return Infinity;
        usd += (lineBuy(p, n * need)?.usd ?? Infinity) + feeOf(p);
      }
      return usd + (parts.length - 1) * 2 * need * jointRate; // each further part: two more joints a component
    };
    const option = (how: ValueOption['how'], parts: SupplierPart[], value: number): ValueOption => {
      const c = cost(parts);
      return { how, parts, value, deviation: value / j.wanted - 1, cost: round(c), ...(now !== undefined ? { usd: round(now - c) } : {}), onOrder: parts.every((p) => loaded.has(p.sku)) };
    };

    const options: ValueOption[] = [];
    const off = (v: number) => Math.abs(v / j.wanted - 1);
    // single values: the same value, the nearest below and above, and the ones on the order within reach
    const below = [...pool2].reverse().find((x) => x.v < j.wanted * 0.999);
    const above = pool2.find((x) => x.v > j.wanted * 1.001);
    const exact = pool2.find((x) => off(x.v) <= EXACT);
    const singles = [exact, below, above, ...pool2.filter((x) => loaded.has(x.p.sku))].filter((x): x is NonNullable<typeof x> => !!x && x.v / j.wanted <= SINGLE_FACTOR && j.wanted / x.v <= SINGLE_FACTOR);
    const seen = new Set<number>();
    for (const x of singles) {
      if (seen.has(x.v)) continue;
      seen.add(x.v);
      options.push(option('single', [x.p], x.v));
    }
    // pairs: resistors in series or parallel, capacitors in parallel, within PAIR_OFF of the value; not with a
    // part that is close enough alone (a 2 Ω in series with the 4.7 kΩ itself adds a part and nothing else)
    const alone = (v: number) => off(v) <= PAIR_OFF[j.kind];
    const pairs: ValueOption[] = [];
    for (let a = 0; a < pool2.length; a++) {
      for (let b = a; b < pool2.length; b++) {
        const x = pool2[a]!;
        const y = pool2[b]!;
        if (alone(x.v) || alone(y.v)) continue;
        const made: [ValueOption['how'], number][] = j.kind === 'resistor' ? [['series', x.v + y.v], ['parallel', (x.v * y.v) / (x.v + y.v)]] : [['parallel', x.v + y.v]];
        for (const [how, v] of made) if (off(v) <= PAIR_OFF[j.kind]) pairs.push(option(how, [x.p, y.p], v));
      }
    }
    // the closest pairs (in steps of 0.1 %), the cheaper of equals
    const step = (o: ValueOption) => Math.round(Math.abs(o.deviation) * 1000);
    pairs.sort((p, q) => step(p) - step(q) || p.cost - q.cost);
    options.push(...pairs.slice(0, 3));

    let worth = options.filter((o) => Number.isFinite(o.cost) && (o.usd === undefined || o.usd >= MIN_SAVING));
    // a value that moves must earn it: next to one part of the same value, only what saves $0.50 more
    // (next to a pair of the same value a single other value stays: one part is simpler)
    const same = worth.find((o) => o.how === 'single' && Math.abs(o.deviation) <= EXACT);
    if (same) worth = worth.filter((o) => o === same || (o.usd !== undefined && same.usd !== undefined && o.usd >= same.usd + MIN_SAVING));
    if (!worth.length) return;
    // the closest first, then the biggest saving (or, with nothing to compare with, the cheapest)
    worth.sort((p, q) => step(p) - step(q) || (p.usd !== undefined && q.usd !== undefined ? q.usd - p.usd : p.cost - q.cost));
    lines.push({ refs: j.refs, ...(j.sku ? { sku: j.sku } : {}), kind: j.kind, wanted: j.wanted, what: `${valueText(j.kind, j.wanted)} ${j.pkg}`, ...(now !== undefined ? { now: round(now) } : {}), options: worth });
  });
  const best = (l: ValueLine) => Math.max(...l.options.map((o) => o.usd ?? 0));
  lines.sort((a, b) => best(b) - best(a));

  return {
    house: house.name,
    boards,
    at: stock.at,
    service: svc.name,
    lines,
    onOrder: [...onOrder].map(([k, parts]) => ({ ...kinds.get(k)!, parts })),
    live: stock.live,
  };
}

const round = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
const valueText = (kind: Kind, v: number) => (kind === 'resistor' ? formatOhms(v) : formatFarads(v));
const pct = (d: number) => (Math.abs(d) < 0.0005 ? 'exact' : `${d > 0 ? '+' : '−'}${(Math.abs(d) * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}%`);

/** One way in words: "30kΩ + 1.5kΩ in series = 31.5kΩ (−0.3%), C22984 + C22843, Basic: saves $3.01". */
export function optionText(o: ValueOption, kind: Kind): string {
  const v = (x: number) => valueText(kind, x);
  const vals = o.parts.map((p) => v(partValue(p, kind)!));
  const made = o.how === 'single' ? `one ${vals[0]}` : `${vals.join(o.how === 'series' ? ' + ' : ' ∥ ')} in ${o.how} = ${v(o.value)}`;
  const tiers = [...new Set(o.parts.map((p) => p.tier).filter(Boolean))].join('/');
  const money = o.usd !== undefined ? `saves $${o.usd.toFixed(2)}` : `adds $${o.cost.toFixed(2)}`;
  return `${made} (${pct(o.deviation)}): ${o.parts.map((p) => p.sku).join(' + ')}${tiers ? `, ${tiers}` : ''}${o.onOrder ? ', on the order already' : ''}: ${money}`;
}

/** The values check for the agent. */
export function valuesReportText(r: ValuesReport, house: AssemblyHouse): string {
  const out: string[] = [];
  out.push(`Cheaper ways to make the resistor and capacitor values, at ${r.house} for ${r.boards} board${r.boards === 1 ? '' : 's'} (counted for ${r.service}; the costs count the pieces, any new loading fee and the extra joints):`);
  if (!r.lines.length) out.push('- None that saves $0.50 or more.');
  for (const l of r.lines) {
    const has = l.sku ? `${l.sku}, $${l.now?.toFixed(2)} on the order now` : l.now !== undefined ? `no ${house.numberName}; the same value would add $${l.now.toFixed(2)}` : `no ${house.numberName}, and no part with this value in stock`;
    out.push(`- ${l.refs.join(', ')} ${l.what} (${has}):`, ...l.options.slice(0, 5).map((o) => `    · ${optionText(o, l.kind)}`));
  }
  const on = r.onOrder.filter((g) => g.parts.length);
  if (on.length) {
    out.push('On the order already (a value that may move can take one of these and add no part number):');
    for (const g of on) out.push(`- ${g.pkg} ${g.kind}s: ${g.parts.map(({ part, refs }) => `${valueText(g.kind, partValue(part, g.kind) ?? 0)} (${refs.join(' ')}, ${part.sku}${part.fee ? `, ${part.tier}` : ''})`).join(', ')}`);
  }
  out.push(
    `A pair is two parts where one was: in series, between the same two nets with a new net between them; in parallel, across the same two nets. Two 1 % parts stay within 1 %. A single other value changes what the part does by its deviation: whether that is fine is the circuit's call (design_query get_guide topic "cost"). Set the value with set_param and the part with set_param ${house.param}; the stock and cost checks after the change confirm what it saved.`,
  );
  return out.join('\n');
}
