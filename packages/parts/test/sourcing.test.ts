import { describe, expect, it } from 'vitest';
import { JLCPCB_ASSEMBLY, type PartQuery, type SupplierPart } from '@4k7/schema';
import { checkStock, describePart, lineBlocks, rankParts, replacementQuery, sourcingMismatch, stockLines, stockReportText, stockState, unitPrice, withFallback, type PartSource, type SourcedComponent } from '../src/index.ts';

const TIERS = ['Basic', 'Preferred', 'Extended'];
/** A catalogue part; JLCPCB-like classes, live, plenty in stock unless told. */
const part = (sku: string, o: Partial<SupplierPart> = {}): SupplierPart => ({
  sku,
  mpn: 'X',
  package: '0603',
  description: '',
  stock: 1_000_000,
  tier: 'Basic',
  fee: false,
  price: [],
  attributes: {},
  url: `https://jlcpcb.com/partdetail/${sku}`,
  live: true,
  ...o,
});
const ext = { tier: 'Extended', fee: true };

describe('ranking and stock', () => {
  it('puts fee-free parts first in the house\'s order of classes, then the deepest stock, unknown stock last', () => {
    const ranked = rankParts([part('C1', { ...ext, stock: 9e9 }), part('C2', { stock: 1 }), part('C3', { stock: null }), part('C4', { stock: 5 }), part('C5', { tier: 'Preferred', stock: 2 })], TIERS);
    expect(ranked.map((p) => p.sku)).toEqual(['C4', 'C2', 'C3', 'C5', 'C1']);
  });

  it('calls stock out, short, low (under 5 × the need) or ok, and unknown when nobody said', () => {
    expect([0, 9, 10, 49, 50].map((n) => stockState(n, 10))).toEqual(['out', 'short', 'low', 'low', 'ok']);
    expect(stockState(null, 10)).toBe('unknown');
  });

  it('prices a quantity at its break', () => {
    const p = part('C1', { price: [{ qty: 1, usd: 0.01 }, { qty: 100, usd: 0.008 }, { qty: 1000, usd: 0.005 }] });
    expect([1, 99, 100, 5000].map((q) => unitPrice(p, q))).toEqual([0.01, 0.01, 0.008, 0.005]);
    expect(unitPrice(part('C2'), 10)).toBeUndefined();
  });

  it('describes a part in one line, saying when the stock is unknown or from a mirror', () => {
    const p = part('C25804', { mpn: '0603WAF1002T5E', stock: 37165617, price: [{ qty: 1, usd: 0.0017 }], attributes: { Resistance: '10kΩ', Tolerance: '±1%' } });
    expect(describePart(p)).toBe('C25804 · 0603WAF1002T5E · 0603 · Basic · stock 37,165,617 · $0.0017@1 · Resistance 10kΩ, Tolerance ±1%');
    expect(describePart({ ...p, stock: null, live: false })).toContain('Basic · stock unknown (mirror) · $0.0017@1');
  });
});

describe('fallback', () => {
  it('asks the second source only when the first fails, and says why', async () => {
    const notes: (string | null)[] = [];
    const first: PartSource = { search: async () => [part('C1')], lookup: async () => Promise.reject(new Error('blocked')) };
    const second: PartSource = { search: async () => [part('C2', { live: false })], lookup: async () => part('C2', { live: false }) };
    const src = withFallback(first, second, (why) => notes.push(why));
    expect((await src.search({ text: 'x' }))[0]!.sku).toBe('C1');
    expect((await src.lookup('C1'))?.sku).toBe('C2');
    expect(notes).toEqual([null, 'blocked']);
  });
});

describe('sourcing mismatch', () => {
  it('accepts a matching resistor whatever the spelling', () => {
    expect(sourcingMismatch({ category: 'resistor' }, { resistance: '10k' }, '0603', part('C1', { attributes: { Resistance: '10kΩ' } }))).toEqual([]);
    expect(sourcingMismatch({ category: 'resistor' }, { resistance: '4k7' }, '0603', part('C1', { attributes: { Value: '4.7kΩ' } }))).toEqual([]);
  });

  it('names a wrong value, a low voltage rating and a different package', () => {
    const out = sourcingMismatch({ category: 'capacitor' }, { capacitance: '100nF', voltage: '25V' }, '0805', part('C1', { attributes: { Capacitance: '10nF', 'Voltage Rated': '16V' } }));
    expect(out).toEqual(['capacitance: the part is 10nF, the component 100nF', 'voltage: the part is rated 16V, the component asks for 25V', 'package: the part is 0603, the component 0805']);
  });

  it('calls a capacitor on a resistor a mismatch even when the numbers could not be compared', () => {
    expect(sourcingMismatch({ category: 'resistor' }, { resistance: '100' }, '0603', part('C1', { attributes: { Value: '100nF' } }))).toEqual(['resistance: the part is 100nF, the component 100']);
  });

  it('compares packages loosely and ignores values it cannot read', () => {
    expect(sourcingMismatch({ category: 'ic' }, { mpn: 'AMS1117' }, 'SOT-223', part('C1', { package: 'SOT223' }))).toEqual([]);
    expect(sourcingMismatch({ category: 'resistor' }, { resistance: '10k' }, undefined, part('C1'))).toEqual([]);
  });
});

/* ------------------------------------ the check ------------------------------------ */

const H = JLCPCB_ASSEMBLY;
const res = (refdes: string, lcsc: string | undefined, o: Partial<SourcedComponent> & { resistance?: string; tolerance?: string } = {}): SourcedComponent => ({
  refdes,
  category: 'resistor',
  params: { resistance: o.resistance ?? '10k', ...(o.tolerance ? { tolerance: o.tolerance } : {}), ...(lcsc ? { lcsc } : {}) },
  pkg: '0603',
  ...o,
});

/** A catalogue answering lookups from a table and searches by a function; it counts the calls. */
function catalogue(parts: Record<string, SupplierPart | Error>, search: (q: PartQuery) => SupplierPart[] = () => []) {
  const asked: string[] = [];
  const searched: PartQuery[] = [];
  const src: PartSource = {
    async lookup(sku) {
      asked.push(sku);
      const p = parts[sku];
      if (p instanceof Error) throw p;
      return p ?? null;
    },
    async search(q) {
      searched.push(q);
      return search(q);
    },
  };
  return { src, asked, searched };
}

describe('stock check', () => {
  it('groups the components by part number, counts the pieces for the boards, and lists those without one', () => {
    const { lines, unsourced } = stockLines([res('R10', 'C25804'), res('R2', 'c25804'), res('R1', 'C1'), { refdes: 'J1', params: {} }, res('R3', 'not one')], H, 5);
    expect(lines.map((l) => [l.sku, l.refs, l.need])).toEqual([
      ['C1', ['R1'], 5],
      ['C25804', ['R2', 'R10'], 10],
    ]);
    expect(unsourced).toEqual(['J1', 'R3']);
  });

  it('looks every part up once and says what stops the order, what to look at and what is fine', async () => {
    const plenty = part('C25804', { mpn: '0603WAF1002T5E', attributes: { Resistance: '10kΩ' }, price: [{ qty: 1, usd: 0.002 }] });
    const { src, asked } = catalogue({
      C25804: plenty,
      C11: part('C11', { attributes: { Resistance: '10kΩ' }, stock: 0, price: [{ qty: 1, usd: 0.01 }] }),
      C12: part('C12', { attributes: { Resistance: '10kΩ' }, stock: 15, price: [{ qty: 1, usd: 0.01 }] }),
      C13: part('C13', { attributes: { Resistance: '22kΩ' }, price: [{ qty: 1, usd: 0.01 }] }),
      C14: new Error('timeout'),
    });
    const r = await checkStock([res('R1', 'C25804'), res('R2', 'C25804'), res('R3', 'C11'), res('R4', 'C12'), res('R5', 'C13'), res('R6', 'C14'), res('R7', 'C15'), { refdes: 'J1', params: {} }], src, { house: H, boards: 10, now: () => new Date('2026-10-24T12:00:00Z') });
    expect(asked.sort()).toEqual(['C11', 'C12', 'C13', 'C14', 'C15', 'C25804']);
    const state = Object.fromEntries(r.lines.map((l) => [l.sku, l.state]));
    expect(state).toEqual({ C25804: 'ok', C11: 'out', C12: 'low', C13: 'ok', C14: 'failed', C15: 'missing' });
    expect(r.lines.find((l) => l.sku === 'C13')!.mismatch).toEqual(['resistance: the part is 22kΩ, the component 10k']);
    // not the part the design asks for stops the order like one that cannot be had
    expect(r.lines.filter(lineBlocks).map((l) => l.sku).sort()).toEqual(['C11', 'C13', 'C15']);
    expect(r.lines.find((l) => l.sku === 'C14')!.error).toBe('timeout');
    // C14 could not be looked up: not live; the cost leaves out the lines without a price
    expect(r).toMatchObject({ house: 'JLCPCB', boards: 10, at: '2026-10-24T12:00:00.000Z', unsourced: ['J1'], live: false, unpriced: ['C14', 'C15'] });
    expect(r.cost).toBe(0.04 + 0.1 + 0.1 + 0.1);
  });

  it('prices the order at the price break of the pieces needed, and is live when every part was read live', async () => {
    const { src } = catalogue({ C25804: part('C25804', { attributes: { Resistance: '10kΩ' }, price: [{ qty: 1, usd: 0.01 }, { qty: 20, usd: 0.005 }] }) });
    const r = await checkStock([res('R1', 'C25804'), res('R2', 'C25804'), res('R3', 'C404')], src, { house: H, boards: 10 });
    // a number the catalogue does not list is still a live answer
    expect(r).toMatchObject({ live: true, cost: 0.1, unpriced: ['C404'] });
    const mirrored = await checkStock([res('R1', 'C1')], catalogue({ C1: part('C1', { live: false }) }).src, { house: H, boards: 1 });
    expect(mirrored.live).toBe(false);
    expect(mirrored.cost).toBeUndefined();
  });

  it('offers a passive only replacements of the same value and package, in stock for the boards, no worse in grade', async () => {
    const was = part('C1590', { ...ext, stock: 0, attributes: { Capacitance: '100nF', 'Voltage Rated': '25V', 'Temperature Coefficient': 'X7R' } });
    const cap = (sku: string, o: Partial<SupplierPart>, a: Record<string, string> = {}) => part(sku, { ...o, attributes: { Capacitance: '100nF', 'Voltage Rated': '50V', 'Temperature Coefficient': 'X7R', ...a } });
    const found = [
      cap('C1688', {}, { 'Temperature Coefficient': 'Y5V' }), // worse dielectric
      cap('C2', {}, { 'Voltage Rated': '16V' }), // rated below the old part (and the 25 V the component asks)
      cap('C3', { stock: 15 }), // too few for 20 pieces
      cap('C4', { package: '0805' }), // another package
      cap('C5', { ...ext, stock: 5_000_000 }),
      cap('C14663', { stock: 44_170_800 }),
      cap('C6', { stock: 60 }), // enough, but under 5 × the need
    ];
    const { src, searched } = catalogue({ C1590: was }, () => found);
    const comp: SourcedComponent = { refdes: 'C1', category: 'capacitor', params: { capacitance: '100nF', voltage: '25V', lcsc: 'C1590' }, pkg: '0603' };
    const r = await checkStock([comp, { ...comp, refdes: 'C2' }], src, { house: H, boards: 10 });
    expect(searched).toEqual([{ kind: 'capacitor', value: '100nF', package: '0603', limit: 25 }]);
    const l = r.lines[0]!;
    expect(l.state).toBe('out');
    // fee-free with plenty of stock first, then fee-free but tight, then the one with a fee
    expect(l.replacements.map((p) => p.sku)).toEqual(['C14663', 'C6', 'C5']);
    expect(l.replacementBasis).toBe('same capacitance and package, dielectric and voltage rating no worse');
  });

  it("holds a resistor's replacement to the old part's tolerance, and to the component's when the old part is gone", async () => {
    const r1 = (sku: string, tol: string) => part(sku, { attributes: { Resistance: '4.7kΩ', Tolerance: tol } });
    const { src } = catalogue({}, () => [r1('C5PCT', '±5%'), r1('C1PCT', '±1%'), r1('C01PCT', '±0.1%')]);
    const r = await checkStock([res('R1', 'C404', { resistance: '4k7', tolerance: '1%' })], src, { house: H, boards: 1 });
    expect(r.lines[0]!.state).toBe('missing');
    expect(r.lines[0]!.replacements.map((p) => p.sku).sort()).toEqual(['C01PCT', 'C1PCT']);
  });

  it('offers an IC only the same part number in the same package, and a fee-free listing for one that only costs a fee', async () => {
    const ams = (sku: string, o: Partial<SupplierPart> = {}) => part(sku, { mpn: 'AMS1117-3.3', package: 'SOT-223', ...o });
    const { src, searched } = catalogue({ C347222: ams('C347222', ext) }, () => [ams('C347222', ext), ams('C6186'), ams('C1', { mpn: 'LM1117-3.3' }), ams('C2', { package: 'SOT-89' }), ams('C3', ext)]);
    const r = await checkStock([{ refdes: 'U1', category: 'ic', params: { lcsc: 'C347222' }, mpn: 'AMS1117-3.3', pkg: 'SOT-223' }], src, { house: H, boards: 10 });
    expect(searched).toEqual([{ text: 'AMS1117-3.3', package: 'SOT-223', limit: 25 }]);
    expect(r.lines[0]).toMatchObject({ state: 'ok', mismatch: [] });
    expect(r.lines[0]!.replacements.map((p) => p.sku)).toEqual(['C6186']);
    expect(r.lines[0]!.replacementBasis).toMatch(/same part number \(AMS1117-3.3\)/);
  });

  it('does not search for parts that are fine, and knows what to search by', async () => {
    const { src, searched } = catalogue({ C25804: part('C25804', { attributes: { Resistance: '10kΩ' } }) });
    await checkStock([res('R1', 'C25804')], src, { house: H, boards: 10 });
    expect(searched).toEqual([]);
    expect(replacementQuery({ refdes: 'J1', category: 'connector', params: {} })).toBeNull();
    expect(replacementQuery({ refdes: 'U1', category: 'ic', params: { mpn: 'TPS54331DR' } })).toEqual({ text: 'TPS54331DR', limit: 25 });
  });

  it('writes the report for the agent', async () => {
    const { src } = catalogue(
      {
        C25804: part('C25804', { mpn: '0603WAF1002T5E', attributes: { Resistance: '10kΩ' }, price: [{ qty: 1, usd: 0.002 }] }),
        C11: part('C11', { mpn: 'OLD', attributes: { Resistance: '10kΩ' }, stock: 0 }),
        C12: part('C12', { mpn: 'SCARCE', attributes: { Resistance: '10kΩ' }, stock: 30 }),
        C13: part('C13', { mpn: 'FEE', attributes: { Resistance: '10kΩ' }, ...ext }),
      },
      (q) => (q.kind ? [part('C99', { mpn: 'NEW', attributes: { Resistance: '10kΩ' } })] : []),
    );
    const r = await checkStock([res('R1', 'C25804'), res('R2', 'C11'), { refdes: 'U1', category: 'ic', params: { lcsc: 'C12' }, mpn: 'SCARCE' }, res('R3', 'C13'), { refdes: 'J1', params: {} }], src, { house: H, boards: 10 });
    const text = stockReportText(r, H);
    expect(text).toMatch(/^Stock check at JLCPCB for 10 boards \(.* UTC, read just now\): 4 part numbers for 4 components\./);
    expect(text).toContain('Stop the order (1):\n- R2 · C11 OLD (Basic, stock 0): out of stock (10 needed). Replacements (same resistance and package, tolerance and power no worse): C99 · NEW');
    expect(text).toContain('Look at (1):\n- U1 · C12 SCARCE (Basic, stock 30): low stock: 30 for 10 needed');
    expect(text).toContain('With a fee (1): in Economic assembly JLCPCB charges a loading fee once per unique Extended part');
    expect(text).toContain('- R3 · C13 FEE (Extended, stock 1,000,000): in stock; Extended: a fee. Replacements');
    expect(text).toContain('Scarce with no replacement (C12): suggest the user buy it ahead into their JLCPCB parts inventory');
    expect(text).toContain('Fine (stock ≥ 5 × the need, no fee): C25804 (R1).');
    expect(text).toContain('No LCSC number (JLCPCB does not assemble them from its stock; fine for parts soldered by hand): J1.');
    expect(text).toContain('To take a replacement: design_edit set_param lcsc on every component of its line.');
  });
});
