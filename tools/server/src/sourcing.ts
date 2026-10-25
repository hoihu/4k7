/**
 * Assembly houses' parts catalogues, read by the server for the tab (/api/sourcing/<house>/…): a
 * house's own catalogue sends no CORS headers, so the browser cannot call it, the server can.
 * Answers are kept for a few minutes and only a few requests run at a time, so the stock check of a
 * whole design is no more load on the house than a person looking the parts up.
 */
import { eurocircuitsSource, jlcpcbSource, pcbwaySource, type AssemblyQuote, type PartSource, type QuoteOrder } from '@4k7/parts';
import type { PartQuery, SupplierPart } from '@4k7/schema';

/** Like the datasheet downloads: a browser's agent, with the app's name. */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) 4k7';
const KEEP_MS = 10 * 60_000;
const MAX_KEPT = 1000;
const AT_ONCE = 3;

export interface Sourcing {
  /** The houses with a catalogue here ("jlcpcb", "eurocircuits"). */
  houses: string[];
  search(house: string, q: PartQuery): Promise<SupplierPart[]>;
  lookup(house: string, sku: string): Promise<SupplierPart | null>;
  /** The house's online quote for assembling an order (a house that publishes no fees: PCBWay). */
  quote(house: string, order: QuoteOrder): Promise<AssemblyQuote>;
}

/** An error with the HTTP status the route answers with. */
const failure = (status: number, message: string) => Object.assign(new Error(message), { status });

export function sourcing(opts: { sources?: Record<string, PartSource>; log?: (msg: string) => void } = {}): Sourcing {
  const post = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }) => fetch(url, { ...init, headers: { ...init.headers, 'user-agent': USER_AGENT } });
  const sources: Record<string, PartSource> = opts.sources ?? {
    jlcpcb: jlcpcbSource(post),
    eurocircuits: eurocircuitsSource(post),
    pcbway: pcbwaySource(post),
  };
  const kept = new Map<string, { at: number; value: Promise<unknown> }>();
  let running = 0;
  const waiting: (() => void)[] = [];

  async function slot<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= AT_ONCE) await new Promise<void>((go) => waiting.push(go));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      waiting.shift()?.();
    }
  }

  function keep<T>(key: string, make: () => Promise<T>): Promise<T> {
    const hit = kept.get(key);
    if (hit && Date.now() - hit.at < KEEP_MS) return hit.value as Promise<T>;
    const value = slot(make).catch((e: Error) => {
      kept.delete(key); // a failure is not worth remembering
      opts.log?.(`sourcing ${key}: ${e.message}`);
      throw failure(502, e.message);
    });
    kept.set(key, { at: Date.now(), value });
    if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
    return value;
  }

  const source = (house: string) => {
    const s = sources[house];
    if (!s) throw failure(404, `no parts catalogue for "${house}"`);
    return s;
  };

  return {
    houses: Object.keys(sources),
    search: (house, q) => {
      const s = source(house);
      return keep(`${house} search ${JSON.stringify(q)}`, () => s.search(q));
    },
    lookup: (house, sku) => {
      const s = source(house);
      return keep(`${house} part ${sku.trim().toUpperCase()}`, () => s.lookup(sku));
    },
    quote: (house, order) => {
      const s = source(house);
      if (!s.quote) throw failure(404, `no assembly quote for "${house}"`);
      return keep(`${house} quote ${JSON.stringify(order)}`, () => s.quote!(order));
    },
  };
}

/** An order to quote as the tab sends it, checked field by field (400 for anything else). */
export function quoteRequest(raw: unknown): QuoteOrder {
  const bad = (why: string) => failure(400, `quote: ${why}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('a JSON object is needed');
  const r = raw as Record<string, unknown>;
  const count = (key: string, min: number, max: number) => {
    const v = r[key];
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw bad(`${key} is a whole number from ${min} to ${max.toLocaleString('en-US')}`);
    return v as number;
  };
  if (r.sides !== 1 && r.sides !== 2) throw bad('sides is 1 or 2');
  return { boards: count('boards', 1, 1_000_000), sides: r.sides, uniqueParts: count('uniqueParts', 0, 10_000), smdParts: count('smdParts', 0, 100_000), largeParts: count('largeParts', 0, 100_000), thParts: count('thParts', 0, 100_000) };
}

/** A search as the tab sends it, checked field by field (400 for anything else). */
export function partQuery(raw: unknown): PartQuery {
  const bad = (why: string) => failure(400, `search: ${why}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('a JSON object is needed');
  const r = raw as Record<string, unknown>;
  const q: PartQuery = {};
  for (const [key, max] of [['text', 200], ['value', 40], ['package', 60]] as const) {
    const v = r[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > max) throw bad(`${key} must be text of up to ${max} characters`);
    q[key] = v;
  }
  if (r.kind !== undefined) {
    if (r.kind !== 'resistor' && r.kind !== 'capacitor') throw bad('kind is resistor or capacitor');
    q.kind = r.kind;
  }
  if (r.noFee !== undefined) {
    if (typeof r.noFee !== 'boolean') throw bad('noFee is true or false');
    q.noFee = r.noFee;
  }
  if (r.limit !== undefined) {
    if (!Number.isInteger(r.limit) || (r.limit as number) < 1 || (r.limit as number) > 400) throw bad('limit is a whole number from 1 to 400');
    q.limit = r.limit as number;
  }
  return q;
}
