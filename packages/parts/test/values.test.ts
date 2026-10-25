import { describe, expect, it } from 'vitest';
import { EUROCIRCUITS_ASSEMBLY, JLCPCB_ASSEMBLY, PCBWAY_ASSEMBLY, type PartQuery, type SupplierPart } from '@4k7/schema';
import { checkValues, optionText, valuesReportText, type AssemblyFacts, type PartSource, type SourcedComponent } from '../src/index.ts';

const H = JLCPCB_ASSEMBLY;
const part = (sku: string, o: Partial<SupplierPart> = {}): SupplierPart => ({ sku, mpn: sku, package: '0603', description: '', stock: 1_000_000, tier: 'Basic', fee: false, price: [{ qty: 1, each: 0.002 }], attributes: {}, url: '', live: true, ...o });
const ext = { tier: 'Extended', fee: true };
const r = (sku: string, value: string, o: Partial<SupplierPart> = {}) => part(sku, { attributes: { Resistance: value, Tolerance: '±1%' }, ...o });
const c = (sku: string, value: string, o: Partial<SupplierPart> = {}, a: Record<string, string> = {}) => part(sku, { attributes: { Capacitance: value, 'Voltage Rated': '25V', 'Temperature Coefficient': 'X5R', ...a }, ...o });
const facts = (o: Partial<AssemblyFacts> = {}): AssemblyFacts => ({ smtJoints: 20, handJoints: 0, handRefs: [], bottomRefs: [], layers: 2, size: [80, 80], chips: ['0603'], ...o });
const res = (refdes: string, value: string, lcsc?: string, o: Partial<SourcedComponent> = {}): SourcedComponent => ({ refdes, category: 'resistor', params: { resistance: value, ...(lcsc ? { lcsc } : {}) }, pkg: '0603', ...o });

/** Basic 0603 resistors as JLCPCB lists them (a slice of its 80). */
const BASIC_R = [r('C25804', '10kΩ'), r('C23162', '4.7kΩ'), r('C22984', '30kΩ'), r('C4216', '33kΩ'), r('C22843', '1.5kΩ'), r('C23234', '7.5kΩ'), r('C23352', '24kΩ'), r('C23186', '5.1kΩ'), r('C22977', '2Ω'), r('C21189', '0Ω')];

/** A catalogue: the fee-free lists by kind and package, the parts by number, and same-value searches. */
function catalogue(lists: Record<string, SupplierPart[]>, parts: SupplierPart[] = [], same: (q: PartQuery) => SupplierPart[] = () => []): PartSource {
  return {
    lookup: async (sku) => parts.find((p) => p.sku === sku) ?? null,
    search: async (q) => (q.kind && !q.value ? (lists[`${q.kind} ${q.package}`] ?? []) : same(q)),
  };
}
const run = (comps: SourcedComponent[], src: PartSource, f = facts(), boards = 10) => checkValues(comps, src, { house: H, boards, facts: () => f });

describe('values check', () => {
  it('makes an odd value from two parts without a fee, within 1 %, and lists the nearest single values after them', async () => {
    const odd = r('C25967', '31.6kΩ', { ...ext });
    const v = await run([res('R1', '31.6k', 'C25967')], catalogue({ 'resistor 0603': BASIC_R }, [odd]));
    const l = v.lines[0]!;
    expect(l).toMatchObject({ refs: ['R1'], sku: 'C25967', kind: 'resistor', what: '31.6kΩ 0603' });
    expect(l.options.map((o) => optionText(o, 'resistor').replace(/: saves .*$/, ''))).toEqual([
      '1.5kΩ + 30kΩ in series = 31.5kΩ (−0.3%): C22843 + C22984, Basic',
      '7.5kΩ + 24kΩ in series = 31.5kΩ (−0.3%): C23234 + C23352, Basic',
      'one 33kΩ (+4.4%): C4216, Basic',
      'one 30kΩ (−5.1%): C22984, Basic',
    ]);
    // the Extended part's $3.07 loading fee goes; the pair adds 10 pieces each and 20 joints
    const pair = l.options[0]!;
    expect(pair.saves).toBe(Math.round((10 * 0.002 + 3.07 - (10 * 0.002 + 10 * 0.002 + 20 * 0.0016)) * 100) / 100);
  });

  it('takes the same value without a fee before any other, and drops other values that do not save $0.50 more', async () => {
    const v = await run([res('R5', '4.7k', 'C99782')], catalogue({ 'resistor 0603': BASIC_R }, [r('C99782', '4.7kΩ', { ...ext })]));
    // no "2 Ω + 4.7 kΩ": a part close enough alone makes no pair
    expect(v.lines[0]!.options.map((o) => optionText(o, 'resistor').replace(/: saves .*$/, ''))).toEqual(['one 4.7kΩ (exact): C23162, Basic']);
  });

  it('puts capacitors in parallel only, held to the voltage and dielectric, and prices components that have no number yet', async () => {
    const list = [c('C15850', '10uF', { attrition: 10, minQty: 20, price: [{ qty: 1, each: 0.0426 }] }), c('C45783', '22uF', { attrition: 4, minQty: 2, price: [{ qty: 1, each: 0.1912 }] }), c('C16', '10uF', {}, { 'Voltage Rated': '6.3V' }), c('C17', '10uF', {}, { 'Temperature Coefficient': 'Y5V' })];
    const comp: SourcedComponent = { refdes: 'C6', category: 'capacitor', params: { capacitance: '22uF', voltage: '10V', dielectric: 'X5R' }, pkg: '0805' };
    const v = await run([comp], catalogue({ 'capacitor 0805': list.map((p) => ({ ...p, package: '0805' })) }, [], (q) => (q.value === '22uF' ? [{ ...list[1]!, package: '0805' }] : [])));
    const l = v.lines[0]!;
    // the 22 µF itself is what it would add ($2.68 = 14 pieces × $0.1912)
    expect(l).toMatchObject({ refs: ['C6'], now: 2.68 });
    expect(l.options.map((o) => [o.how, o.parts.map((p) => p.sku), o.saves])).toEqual([
      // 30 pieces (20 + 10 losses) × $0.0426 + 20 joints: saves $1.37
      ['parallel', ['C15850', 'C15850'], 1.37],
      // 20 pieces (its minimum) × $0.0426, against $2.6768 unrounded
      ['single', ['C15850'], 1.82],
    ]);
  });

  it('brings a part onto a value already on the order where every part number costs a fee (Standard)', async () => {
    const other = r('C2', '10kΩ', { price: [{ qty: 1, each: 0.003 }] });
    const v = await run([res('R6', '10k', 'C25804'), res('R7', '10k', 'C2')], catalogue({ 'resistor 0603': [] }, [r('C25804', '10kΩ'), other]), facts({ bottomRefs: ['R7'] }));
    expect(v.service).toBe('Standard');
    const l = v.lines.find((x) => x.sku === 'C2')!;
    expect(l.options[0]).toMatchObject({ how: 'single', onOrder: true, saves: Math.round((10 * 0.003 + 1.53 - 10 * 0.002) * 100) / 100 });
    expect(v.onOrder).toEqual([{ kind: 'resistor', pkg: '0603', parts: [{ part: expect.objectContaining({ sku: 'C25804' }), refs: ['R6'] }, { part: expect.objectContaining({ sku: 'C2' }), refs: ['R7'] }] }]);
  });

  it('says nothing for a part that is already the cheapest way, and works without the list', async () => {
    const v = await run([res('R4', '10k', 'C25804')], catalogue({ 'resistor 0603': BASIC_R }, [r('C25804', '10kΩ')]));
    expect(v.lines).toEqual([]);
    const failing: PartSource = { lookup: async () => r('C25967', '31.6kΩ', { ...ext }), search: async () => Promise.reject(new Error('offline')) };
    expect((await run([res('R1', '31.6k', 'C25967')], failing)).lines).toEqual([]);
  });

  it('writes the report for the agent', async () => {
    const v = await run([res('R1', '31.6k', 'C25967'), res('R4', '10k', 'C25804')], catalogue({ 'resistor 0603': BASIC_R }, [r('C25967', '31.6kΩ', { ...ext }), r('C25804', '10kΩ')]));
    const text = valuesReportText(v, H);
    expect(text).toMatch(/^Cheaper ways to make the resistor and capacitor values, at JLCPCB for 10 boards \(counted for Economic/);
    expect(text).toContain('- R1 31.6kΩ 0603 (C25967, $3.09 on the order now):\n    · 1.5kΩ + 30kΩ in series = 31.5kΩ (−0.3%): C22843 + C22984, Basic: saves $');
    expect(text).toContain('- 0603 resistors: 31.6kΩ (R1, C25967, Extended), 10kΩ (R4, C25804)');
    expect(text).toContain('A pair is two parts where one was');
    expect(text).toContain('design_query get_guide topic "cost"');
  });
});

describe('values check at Eurocircuits', () => {
  const EC = EUROCIRCUITS_ASSEMBLY;
  const generic = (sku: string, value: string) => r(sku, value, { mpn: sku, tier: 'Generic', stock: null, supply: 'stock', price: [{ qty: 1, each: 0 }] });
  const GENERIC_R = [generic('GPR060330K', '30kΩ'), generic('GPR060333K', '33kΩ'), generic('GPR06031K6', '1.6kΩ'), generic('GPR060310K', '10kΩ')];

  it('offers Generic values for an On Demand part, saving its fee and its own price; a pair adds a line and is no saving there', async () => {
    const odd = r('CR0603-FX-3162ELF', '31.6kΩ', { mpn: 'CR0603-FX-3162ELF', tier: 'On Demand', fee: true, stock: null, supply: 'order', price: [] });
    const v = await checkValues([res('R3', '31.6k', undefined, { params: { resistance: '31.6k', eurocircuits: 'CR0603-FX-3162ELF' } })], catalogue({ 'resistor 0603': GENERIC_R }, [odd]), { house: EC, boards: 10, facts: () => facts({ placements: { smd: 1 } }) });
    const l = v.lines[0]!;
    // the line's fees now: €1.925 + €3.85 + €1.65 On Demand
    expect(l).toMatchObject({ sku: 'CR0603-FX-3162ELF', now: 7.43, feesOnly: true });
    expect(l.options.map((o) => optionText(o, 'resistor', EC, l.feesOnly))).toEqual([
      "one 33kΩ (+4.4%): GPR060333K, Generic: saves €1.65 and the part's own price",
      "one 30kΩ (−5.1%): GPR060330K, Generic: saves €1.65 and the part's own price",
    ]);
    expect(valuesReportText(v, EC)).toContain('- R3 31.6kΩ 0603 (CR0603-FX-3162ELF, €7.43 in fees on the order now, and its price):');
  });

  it('has nothing to say at a house without a catalogue', async () => {
    const quoting: PartSource = { lookup: async () => null, search: async () => [], quote: async () => ({ price: 100 }) };
    const v = await checkValues([res('R1', '10k')], quoting, { house: PCBWAY_ASSEMBLY, boards: 10, facts: () => facts() });
    expect(v.lines).toEqual([]);
    expect(valuesReportText(v, PCBWAY_ASSEMBLY)).toMatch(/^No values check at PCBWay: PCBWay keeps no parts catalogue/);
  });
});
