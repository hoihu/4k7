import { describe, expect, it } from 'vitest';
import { describeJlcPart, fromEasyEda, normalizeEasyEdaPackage, parsePriceBreaks, rankParts, sourcingMismatch, tscircuitSource, type JlcPart } from '../src/index.ts';

/** A fetch that answers from a table of path → body (404 for the rest) and records what was asked. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    const path = url.replace('https://jlcsearch.tscircuit.com', '');
    calls.push(path);
    const hit = Object.entries(routes).find(([k]) => path.startsWith(k));
    return { ok: !!hit, status: hit ? 200 : 404, json: async () => hit?.[1] };
  };
  return { fetchFn, calls };
}

const resistors = {
  resistors: [
    { lcsc: 2906982, mfr: 'FRC0603F1002TS', package: '0603', stock: 8273747, price1: 0.0038, resistance: 10000, is_basic: false, is_preferred: false, attributes: '{"Resistance":"10kΩ","Tolerance":"±1%","Power(Watts)":"100mW"}' },
    { lcsc: 25804, mfr: '0603WAF1002T5E', package: '0603', stock: 37165617, price1: 0.0017, resistance: 10000, is_basic: true, is_preferred: false, attributes: '{"Resistance":"10kΩ","Tolerance":"±1%","Power(Watts)":"100mW"}' },
    { lcsc: 99, mfr: 'PREF', package: '0603', stock: 5, price1: 0.002, resistance: 10000, is_basic: false, is_preferred: true, attributes: 'not json' },
  ],
};

const components = {
  components: [
    { lcsc: 96256, mfr: 'QMB-09B-03', package: '插件,D=9mm', description: '2.7kHz 2V~5V 3V 85dB 9mm Electromagnetic Passive Buzzer', stock: 152815, price: '1-9:0.1,10-99:0.08,100-:0.06', category: 'Audio', subcategory: 'Buzzers', is_basic: false, is_preferred: false },
    { lcsc: 94598, mfr: 'MLT-5020', package: 'SMD,5x5mm', description: 'Electromagnetic Passive Buzzer', stock: 106656, price: '1-99:0.2', subcategory: 'Buzzers', is_basic: false, is_preferred: false },
  ],
};

const easyeda = {
  easyeda_component_details: {
    lcsc: 25804,
    easyeda_json: {
      description: '10KΩ (1002) ±1%',
      tags: ['Resistors'],
      lcsc: { number: 'C25804', stock: 8999650, price: 0.0017, url: 'https://lcsc.com/product-detail/x_C25804.html' },
      dataStr: { head: { c_para: { package: 'R0603', Manufacturer: 'UNI-ROYAL(厚声)', 'Manufacturer Part': '0603WAF1002T5E', 'Supplier Part': 'C25804', Value: '10kΩ', 'JLCPCB Part Class': 'Basic Part' } } },
      packageDetail: { dataStr: { head: { c_para: { link: 'https://www.mouser.in/datasheet/2/447/PYu_RT_1_to_0_01_RoHS_L_11-1669912.pdf' } } } },
    },
  },
};

describe('tscircuit source', () => {
  it('searches resistors parametrically in ohms and ranks Basic, Preferred, Extended', async () => {
    const { fetchFn, calls } = fakeFetch({ '/resistors/list.json': resistors });
    const parts = await tscircuitSource(fetchFn).search({ kind: 'resistor', value: '10k', package: '0603' });
    expect(calls[0]).toBe('/resistors/list.json?resistance=10000&package=0603');
    expect(parts.map((p) => p.lcsc)).toEqual(['C25804', 'C99', 'C2906982']);
    expect(parts[0]).toMatchObject({ mpn: '0603WAF1002T5E', tier: 'basic', price: [{ qty: 1, usd: 0.0017 }], attributes: { Resistance: '10kΩ', Tolerance: '±1%' }, url: 'https://jlcpcb.com/partdetail/C25804' });
    // attributes that are not JSON fall back to the numeric columns
    expect(parts[1]!.attributes).toEqual({ Resistance: '10kΩ' });
  });

  it('searches capacitors in farads and can keep only fee-free parts', async () => {
    const caps = { capacitors: [{ lcsc: 14663, mfr: 'CC0603KRX7R9BB104', package: '0603', stock: 1, price1: 0.0022, capacitance_farads: 1e-7, voltage_rating: 50, is_basic: true }, { lcsc: 1591, mfr: 'CL10B104KB8NNNC', package: '0603', stock: 2, price1: 0.0024, capacitance_farads: 1e-7, voltage_rating: 50, is_basic: false }] };
    const { fetchFn, calls } = fakeFetch({ '/capacitors/list.json': caps });
    const parts = await tscircuitSource(fetchFn).search({ kind: 'capacitor', value: '100nF', basicOnly: true });
    expect(calls[0]).toBe('/capacitors/list.json?capacitance=1.000000e-7');
    expect(parts).toHaveLength(1);
    expect(parts[0]!.attributes).toEqual({ Capacitance: '100nF', 'Voltage Rated': '50V' });
  });

  it('searches by text with price breaks and a package filter, and limits the list', async () => {
    const { fetchFn, calls } = fakeFetch({ '/components/list.json': components });
    const parts = await tscircuitSource(fetchFn).search({ text: 'passive buzzer', package: 'SMD,5x5mm', limit: 1 });
    expect(calls[0]).toBe('/components/list.json?search=passive%20buzzer&package=SMD%2C5x5mm');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ lcsc: 'C96256', price: [{ qty: 1, usd: 0.1 }, { qty: 10, usd: 0.08 }, { qty: 100, usd: 0.06 }], category: 'Buzzers' });
  });

  it('refuses a parametric search without a value, and a text search without text', async () => {
    const src = tscircuitSource(fakeFetch({}).fetchFn);
    await expect(src.search({ kind: 'resistor' })).rejects.toThrow(/value/);
    await expect(src.search({})).rejects.toThrow(/text/);
  });

  it('looks a part up by number through the EasyEDA record, with the datasheet link and live stock', async () => {
    const live = { components: [{ lcsc: 25804, mfr: '0603WAF1002T5E', package: '0603', description: '10kΩ 100mW ±1% 0603 Chip Resistor', stock: 37165617, price: '1-999:0.0038', is_basic: true }] };
    const { fetchFn, calls } = fakeFetch({ '/api/easyeda_components/C25804': easyeda, '/components/list.json': live });
    const src = tscircuitSource(fetchFn);
    const p = await src.lookup('c25804');
    expect(calls).toEqual(['/api/easyeda_components/C25804', '/components/list.json?search=0603WAF1002T5E']);
    expect(p).toMatchObject({ lcsc: 'C25804', mpn: '0603WAF1002T5E', manufacturer: 'UNI-ROYAL', package: '0603', tier: 'basic', stock: 37165617, price: [{ qty: 1, usd: 0.0038 }], description: '10kΩ 100mW ±1% 0603 Chip Resistor', datasheet: 'https://www.mouser.in/datasheet/2/447/PYu_RT_1_to_0_01_RoHS_L_11-1669912.pdf', attributes: { Value: '10kΩ' } });
    expect(await src.lookup('C1')).toBeNull();
    expect(await src.lookup('nonsense')).toBeNull();
  });

  it('keeps the record when the live search has nothing', async () => {
    const { fetchFn } = fakeFetch({ '/api/easyeda_components/C25804': easyeda });
    const p = await tscircuitSource(fetchFn).lookup('C25804');
    expect(p).toMatchObject({ stock: 8999650, price: [{ qty: 1, usd: 0.0017 }] });
  });
});

describe('mapping helpers', () => {
  it('parses price breaks and skips malformed pieces', () => {
    expect(parsePriceBreaks('500-1499:0.0135,1-499:0.0176,48000-:0.0095,junk')).toEqual([
      { qty: 1, usd: 0.0176 },
      { qty: 500, usd: 0.0135 },
      { qty: 48000, usd: 0.0095 },
    ]);
  });

  it('normalises EasyEDA chip package names only', () => {
    expect(normalizeEasyEdaPackage('R0603')).toBe('0603');
    expect(normalizeEasyEdaPackage('C0805')).toBe('0805');
    expect(normalizeEasyEdaPackage('SOT-23')).toBe('SOT-23');
  });

  it('reads the tier from the part class and tolerates a bare record', () => {
    expect(fromEasyEda({ dataStr: { head: { c_para: { 'JLCPCB Part Class': 'Extended Part' } } } }, 'C7').tier).toBe('extended');
    expect(fromEasyEda({}, 'C7')).toMatchObject({ lcsc: 'C7', mpn: '', package: '', tier: 'extended', price: [] });
  });

  it('ranks by tier, then stock', () => {
    const mk = (lcsc: string, tier: JlcPart['tier'], stock: number): JlcPart => ({ lcsc, mpn: '', package: '', description: '', stock, tier, price: [], attributes: {}, url: '' });
    expect(rankParts([mk('C1', 'extended', 9), mk('C2', 'basic', 1), mk('C3', 'basic', 5), mk('C4', 'preferred', 2)]).map((p) => p.lcsc)).toEqual(['C3', 'C2', 'C4', 'C1']);
  });

  it('describes a part in one line', () => {
    const line = describeJlcPart({ lcsc: 'C25804', mpn: '0603WAF1002T5E', package: '0603', description: '', stock: 37165617, tier: 'basic', price: [{ qty: 1, usd: 0.0017 }], attributes: { Resistance: '10kΩ', Tolerance: '±1%' }, url: '' });
    expect(line).toBe('C25804 · 0603WAF1002T5E · 0603 · Basic · stock 37,165,617 · $0.0017@1 · Resistance 10kΩ, Tolerance ±1%');
  });
});

describe('sourcing mismatch', () => {
  const part = (attributes: Record<string, string>, pkg = '0603'): JlcPart => ({ lcsc: 'C1', mpn: 'X', package: pkg, description: '', stock: 1, tier: 'basic', price: [], attributes, url: '' });

  it('accepts a matching resistor whatever the spelling', () => {
    expect(sourcingMismatch({ category: 'resistor' }, { resistance: '10k' }, '0603', part({ Resistance: '10kΩ' }))).toEqual([]);
    expect(sourcingMismatch({ category: 'resistor' }, { resistance: '4k7' }, '0603', part({ Value: '4.7kΩ' }))).toEqual([]);
  });

  it('names a wrong value, a low voltage rating and a different package', () => {
    const out = sourcingMismatch({ category: 'capacitor' }, { capacitance: '100nF', voltage: '25V' }, '0805', part({ Capacitance: '10nF', 'Voltage Rated': '16V' }));
    expect(out).toEqual(['capacitance: the part is 10nF, the component 100nF', 'voltage: the part is rated 16V, the component asks for 25V', 'package: the part is 0603, the component 0805']);
  });

  it('calls a capacitor on a resistor a mismatch even when the numbers could not be compared', () => {
    expect(sourcingMismatch({ category: 'resistor' }, { resistance: '100' }, '0603', part({ Value: '100nF' }))).toEqual(['resistance: the part is 100nF, the component 100']);
  });

  it('compares packages loosely and ignores values it cannot read', () => {
    expect(sourcingMismatch({ category: 'ic' }, { mpn: 'AMS1117' }, 'SOT-223', part({}, 'SOT223'))).toEqual([]);
    expect(sourcingMismatch({ category: 'resistor' }, { resistance: '10k' }, undefined, part({}))).toEqual([]);
  });
});
