import { describe, expect, it } from 'vitest';
import { fromEasyEda, fromJlcpcb, jlcpcbSource, JLCPCB_SEARCH, normalizeEasyEdaPackage, parsePriceBreaks, tscircuitSource } from '../src/index.ts';

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

describe('tscircuit mirror', () => {
  it('searches resistors parametrically in ohms and ranks Basic, Preferred, Extended', async () => {
    const { fetchFn, calls } = fakeFetch({ '/resistors/list.json': resistors });
    const parts = await tscircuitSource(fetchFn).search({ kind: 'resistor', value: '10k', package: '0603' });
    expect(calls[0]).toBe('/resistors/list.json?resistance=10000&package=0603');
    expect(parts.map((p) => p.sku)).toEqual(['C25804', 'C99', 'C2906982']);
    expect(parts[0]).toMatchObject({ mpn: '0603WAF1002T5E', tier: 'Basic', fee: false, live: false, price: [{ qty: 1, each: 0.0017 }], attributes: { Resistance: '10kΩ', Tolerance: '±1%' }, url: 'https://jlcpcb.com/partdetail/C25804' });
    expect(parts[2]).toMatchObject({ tier: 'Extended', fee: true });
    // attributes that are not JSON fall back to the numeric columns
    expect(parts[1]!.attributes).toEqual({ Resistance: '10kΩ' });
  });

  it('says stock unknown, not none, where the mirror has no number (most resistors and capacitors)', async () => {
    const rows = { resistors: [{ lcsc: 25804, mfr: '0603WAF1002T5E', package: '0603', stock: null, price1: 0.0012, resistance: 10000, is_basic: true }] };
    const [p] = await tscircuitSource(fakeFetch({ '/resistors/list.json': rows }).fetchFn).search({ kind: 'resistor', value: '10k' });
    expect(p!.stock).toBeNull();
  });

  it('searches capacitors in farads and can keep only fee-free parts', async () => {
    const caps = { capacitors: [{ lcsc: 14663, mfr: 'CC0603KRX7R9BB104', package: '0603', stock: 1, price1: 0.0022, capacitance_farads: 1e-7, voltage_rating: 50, is_basic: true }, { lcsc: 1591, mfr: 'CL10B104KB8NNNC', package: '0603', stock: 2, price1: 0.0024, capacitance_farads: 1e-7, voltage_rating: 50, is_basic: false }] };
    const { fetchFn, calls } = fakeFetch({ '/capacitors/list.json': caps });
    const parts = await tscircuitSource(fetchFn).search({ kind: 'capacitor', value: '100nF', noFee: true });
    expect(calls[0]).toBe('/capacitors/list.json?capacitance=1.000000e-7');
    expect(parts).toHaveLength(1);
    expect(parts[0]!.attributes).toEqual({ Capacitance: '100nF', 'Voltage Rated': '50V' });
  });

  it('searches by text with price breaks and a package filter, and limits the list', async () => {
    const { fetchFn, calls } = fakeFetch({ '/components/list.json': components });
    const parts = await tscircuitSource(fetchFn).search({ text: 'passive buzzer', package: 'SMD,5x5mm', limit: 1 });
    expect(calls[0]).toBe('/components/list.json?search=passive%20buzzer&package=SMD%2C5x5mm');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ sku: 'C96256', price: [{ qty: 1, each: 0.1 }, { qty: 10, each: 0.08 }, { qty: 100, each: 0.06 }], category: 'Buzzers' });
  });

  it('refuses a parametric search without a value, and a text search without text', async () => {
    const src = tscircuitSource(fakeFetch({}).fetchFn);
    await expect(src.search({ kind: 'resistor' })).rejects.toThrow(/value/);
    await expect(src.search({})).rejects.toThrow(/text/);
  });

  it("looks a part up by number through the EasyEDA record, with the datasheet link and the mirror's stock", async () => {
    const listed = { components: [{ lcsc: 25804, mfr: '0603WAF1002T5E', package: '0603', description: '10kΩ 100mW ±1% 0603 Chip Resistor', stock: 37165617, price: '1-999:0.0038', is_basic: true }] };
    const { fetchFn, calls } = fakeFetch({ '/api/easyeda_components/C25804': easyeda, '/components/list.json': listed });
    const src = tscircuitSource(fetchFn);
    const p = await src.lookup('c25804');
    expect(calls).toEqual(['/api/easyeda_components/C25804', '/components/list.json?search=0603WAF1002T5E']);
    expect(p).toMatchObject({ sku: 'C25804', mpn: '0603WAF1002T5E', manufacturer: 'UNI-ROYAL', package: '0603', tier: 'Basic', stock: 37165617, price: [{ qty: 1, each: 0.0038 }], description: '10kΩ 100mW ±1% 0603 Chip Resistor', datasheet: 'https://www.mouser.in/datasheet/2/447/PYu_RT_1_to_0_01_RoHS_L_11-1669912.pdf', attributes: { Value: '10kΩ' }, live: false });
    expect(await src.lookup('C1')).toBeNull();
    expect(await src.lookup('nonsense')).toBeNull();
  });

  it("does not pass LCSC's stock off as JLCPCB's when the mirror's search has nothing", async () => {
    const { fetchFn } = fakeFetch({ '/api/easyeda_components/C25804': easyeda });
    const p = await tscircuitSource(fetchFn).lookup('C25804');
    expect(p).toMatchObject({ stock: null, price: [{ qty: 1, each: 0.0017 }] });
  });
});

/* ---------------------------------- jlcpcb.com ---------------------------------- */

/** One part as jlcpcb.com's search lists it (fields trimmed to the ones read; values from a real answer). */
const item = (o: Record<string, unknown> = {}) => ({
  componentCode: 'C25804',
  componentModelEn: '0603WAF1002T5E',
  componentBrandEn: 'UNI-ROYAL(Uniroyal Elec)',
  componentSpecificationEn: '0603',
  describe: '-55℃~+155℃ 100mW 10kΩ 75V Thick Film Resistor ±1% ±100ppm/℃ 0603 Chip Resistor - Surface Mount ROHS',
  stockCount: 40773871,
  componentLibraryType: 'base',
  preferredComponentFlag: false,
  componentPrices: [
    { startNumber: 1000, endNumber: 4999, productPrice: 0.0018 },
    { startNumber: 1, endNumber: 999, productPrice: 0.0022 },
  ],
  attributes: [
    { attribute_name_en: 'Resistance', attribute_value_name: '10kΩ' },
    { attribute_name_en: 'Tolerance', attribute_value_name: '±1%' },
    { attribute_name_en: 'Power(Watts)', attribute_value_name: '100mW' },
    { attribute_name_en: 'Overload Voltage (Max)', attribute_value_name: '-' },
  ],
  componentTypeEn: 'Chip Resistor - Surface Mount',
  dataManualUrl: 'https://www.lcsc.com/datasheet/lcsc_datasheet_2206010045_UNI-ROYAL-Uniroyal-Elec-0603WAF1002T5E_C25804.pdf',
  lossNumber: 10,
  leastPatchNumber: 20,
  ...o,
});
const page = (list: unknown[] | null) => ({ code: 200, data: { componentPageInfo: { total: list?.length ?? 0, list } }, message: null });

/** A POST fetch that answers each request with the next of `answers` and records the bodies. */
function fakePost(...answers: unknown[]) {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const fetchFn = async (url: string, init: { body: string }) => {
    urls.push(url);
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    const a = answers.shift();
    return typeof a === 'number' ? { ok: false, status: a, json: async () => ({}) } : { ok: true, status: 200, json: async () => a };
  };
  return { fetchFn, bodies, urls };
}

describe('jlcpcb.com', () => {
  it('reads a part: maker, package, live stock, price breaks, class, attributes under the names the checks read', () => {
    expect(fromJlcpcb(item())).toEqual({
      sku: 'C25804',
      mpn: '0603WAF1002T5E',
      manufacturer: 'UNI-ROYAL',
      package: '0603',
      description: '-55℃~+155℃ 100mW 10kΩ 75V Thick Film Resistor ±1% ±100ppm/℃ 0603 Chip Resistor - Surface Mount ROHS',
      stock: 40773871,
      tier: 'Basic',
      fee: false,
      price: [{ qty: 1, each: 0.0022 }, { qty: 1000, each: 0.0018 }],
      attributes: { Resistance: '10kΩ', Tolerance: '±1%', 'Power(Watts)': '100mW' },
      category: 'Chip Resistor - Surface Mount',
      datasheet: 'https://www.lcsc.com/datasheet/lcsc_datasheet_2206010045_UNI-ROYAL-Uniroyal-Elec-0603WAF1002T5E_C25804.pdf',
      url: 'https://jlcpcb.com/partdetail/C25804',
      live: true,
      attrition: 10,
      minQty: 20,
    });
    expect(fromJlcpcb(item({ componentLibraryType: 'expand', preferredComponentFlag: true }))).toMatchObject({ tier: 'Preferred', fee: false });
    expect(fromJlcpcb(item({ componentLibraryType: 'expand', stockCount: undefined }))).toMatchObject({ tier: 'Extended', fee: true, stock: null });
    // an IC with no losses and no minimum says neither
    expect(fromJlcpcb(item({ lossNumber: 0, leastPatchNumber: 0 }))).not.toHaveProperty('attrition');
    // a capacitor's rating goes by the name the checks read
    expect(fromJlcpcb(item({ attributes: [{ attribute_name_en: 'Voltage Rating', attribute_value_name: '50V' }] })).attributes).toEqual({ 'Voltage Rated': '50V' });
  });

  it('looks a number up and keeps only the exact match (the search also finds similar numbers)', async () => {
    const { fetchFn, bodies, urls } = fakePost(page([item({ componentCode: 'C258041' }), item()]), page([item({ componentCode: 'C1396897' })]));
    const src = jlcpcbSource(fetchFn);
    expect((await src.lookup('c25804'))?.sku).toBe('C25804');
    expect(urls[0]).toBe(`https://jlcpcb.com${JLCPCB_SEARCH}`);
    expect(bodies[0]).toEqual({ currentPage: 1, pageSize: 10, keyword: 'C25804' });
    expect(await src.lookup('C999999999')).toBeNull();
    expect(await src.lookup('not a number')).toBeNull();
  });

  it('searches a passive by its catalogue value in stock, with the package as a filter and its Basic parts asked for, and ranks Basic first', async () => {
    const ext = item({ componentCode: 'C98220', componentModelEn: 'RC0603FR-0710KL', componentLibraryType: 'expand', stockCount: 10159239 });
    const { fetchFn, bodies } = fakePost(page([ext]), page([item()]));
    const parts = await jlcpcbSource(fetchFn).search({ kind: 'resistor', value: '4k7', package: '0603' });
    expect(bodies).toEqual([
      { currentPage: 1, pageSize: 50, keyword: '4.7kΩ', stockFlag: true, componentSpecificationList: ['0603'] },
      { currentPage: 1, pageSize: 50, keyword: '4.7kΩ', stockFlag: true, componentSpecificationList: ['0603'], componentLibraryType: 'base' },
    ]);
    expect(parts.map((p) => p.sku)).toEqual(['C25804', 'C98220']);
    await expect(jlcpcbSource(fetchFn).search({ kind: 'capacitor' })).rejects.toThrow(/value/);
  });

  it("joins the package to the words when JLCPCB names it otherwise, and adds Basic parts for a fee-free search", async () => {
    const ldo = item({ componentCode: 'C6186', componentModelEn: 'AMS1117-3.3', componentSpecificationEn: 'SOT-223-3', componentLibraryType: 'base' });
    const clone = item({ componentCode: 'C347222', componentModelEn: 'AMS1117-3.3', componentSpecificationEn: 'SOT-223-3', componentLibraryType: 'expand' });
    const { fetchFn, bodies } = fakePost(page(null), page([clone]), page([ldo]));
    const parts = await jlcpcbSource(fetchFn).search({ text: 'AMS1117-3.3', package: 'SOT223-3', noFee: true });
    expect(bodies.map((b) => [b.keyword, b.componentSpecificationList, b.componentLibraryType])).toEqual([
      ['AMS1117-3.3', ['SOT223-3'], undefined],
      ['AMS1117-3.3 SOT223-3', undefined, undefined],
      ['AMS1117-3.3 SOT223-3', undefined, 'base'],
    ]);
    expect(parts.map((p) => p.sku)).toEqual(['C6186']);
  });

  it('lists every fee-free resistor or capacitor of a package, a page of 100 at a time', async () => {
    const full = Array.from({ length: 100 }, (_, i) => item({ componentCode: `C${1000 + i}` }));
    const { fetchFn, bodies } = fakePost(page(full), page([item({ componentCode: 'C2000' })]), page([item({ componentCode: 'C3000' })]));
    const src = jlcpcbSource(fetchFn);
    expect(await src.search({ kind: 'resistor', package: '0603', noFee: true, limit: 400 })).toHaveLength(101);
    expect(await src.search({ kind: 'capacitor', package: '0805', noFee: true })).toHaveLength(1);
    // the search matches whole words: "Resistor" is in every chip resistor's description, "Capacitors" in every ceramic capacitor's category
    expect(bodies.map((b) => [b.keyword, b.componentLibraryType, b.componentSpecificationList, b.currentPage, b.pageSize])).toEqual([
      ['Resistor', 'base', ['0603'], 1, 100],
      ['Resistor', 'base', ['0603'], 2, 100],
      ['Capacitors', 'base', ['0805'], 1, 100],
    ]);
    await expect(src.search({ kind: 'capacitor', package: '0603' })).rejects.toThrow(/no_fee/);
    await expect(src.search({ kind: 'resistor', noFee: true })).rejects.toThrow(/package/);
    await expect(tscircuitSource(fakeFetch({}).fetchFn).search({ kind: 'resistor', package: '0603', noFee: true })).rejects.toThrow(/cannot list/);
  });

  it('calls an answer it cannot read an error, never an empty catalogue', async () => {
    await expect(jlcpcbSource(fakePost(503).fetchFn).lookup('C1')).rejects.toThrow(/HTTP 503/);
    await expect(jlcpcbSource(fakePost({ code: 500, message: 'busy' }).fetchFn).lookup('C1')).rejects.toThrow(/busy/);
    await expect(jlcpcbSource(fakePost({ code: 200, data: { somethingElse: [] } }).fetchFn).lookup('C1')).rejects.toThrow(/does not read/);
    await expect(jlcpcbSource(fakePost(page(null)).fetchFn).search({ text: 'zzqqxx' })).resolves.toEqual([]);
  });
});

describe('mapping helpers', () => {
  it('parses price breaks and skips malformed pieces', () => {
    expect(parsePriceBreaks('500-1499:0.0135,1-499:0.0176,48000-:0.0095,junk')).toEqual([
      { qty: 1, each: 0.0176 },
      { qty: 500, each: 0.0135 },
      { qty: 48000, each: 0.0095 },
    ]);
  });

  it('normalises EasyEDA chip package names only', () => {
    expect(normalizeEasyEdaPackage('R0603')).toBe('0603');
    expect(normalizeEasyEdaPackage('C0805')).toBe('0805');
    expect(normalizeEasyEdaPackage('SOT-23')).toBe('SOT-23');
  });

  it('reads the class from the EasyEDA part class and tolerates a bare record', () => {
    expect(fromEasyEda({ dataStr: { head: { c_para: { 'JLCPCB Part Class': 'Extended Part' } } } }, 'C7')).toMatchObject({ tier: 'Extended', fee: true });
    expect(fromEasyEda({}, 'C7')).toMatchObject({ sku: 'C7', mpn: '', package: '', tier: 'Extended', price: [], stock: null });
  });
});
