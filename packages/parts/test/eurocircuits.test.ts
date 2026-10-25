import { describe, expect, it } from 'vitest';
import { EUROCIRCUITS_SEARCH, eurocircuitsSource, fromEurocircuits } from '../src/index.ts';

/** Records as Eurocircuits' search lists them (read 2026-10-25). */
const GENERIC_10K = { mpn: 'GPR060310K', manuf: 'Unknown', desc: 'SMD Chip Resistor, 10 kohm, ± 1%, 100 mW, 0603 [1608 Metric], Thick Film, General Purpose 75V', cat: 'Resistors', gpn: '1', ecstock: '0', type: 'smd', pack_type: '0603', resis: '10 kohm (10000.0Ohms)', oper_volt: '75V (75.0V)', toler: '± 1% (1%)', power: '100 mW (0.1Watts)', lifecycle: '' };
const ON_DEMAND_10K = { mpn: 'RC0603FR-0710KL', manuf: 'Yageo', desc: '10 kOhms ±1% 0.1W, 1/10W Chip Resistor 0603 (1608 Metric) Moisture Resistant Thick Film', cat: 'Resistors', gpn: '0', ecstock: '0', type: 'smd', pack_type: '0603', resis: '10 kOhms (10000.0Ohms)', toler: '±1% (1%)', power: '0.1W (0.1Watts)', lifecycle: 'active', url: 'https://www.yageo.com/upload/media/product/productsearch/datasheet/rchip/PYu-RC_Group_51_RoHS_L_12.pdf' };
const THERMISTOR = { mpn: 'NTCG163JF103FT1S', manuf: 'TDK', desc: 'NTC THERMISTOR 10K OHM 1% 0603', cat: 'Thermistors', gpn: '0', ecstock: '1', type: 'smd', pack_type: '0603', resis: '10K OHM (10000.0Ohms)', toler: '1% (1%)' };
const OBSOLETE_CAP = { mpn: 'GRM188R71H104KA93D', manuf: 'Murata', desc: '0.1µF ±10% 50V Ceramic Capacitor X7R 0603 (1608 Metric)', cat: 'Ceramic Capacitors', gpn: '0', ecstock: '0', type: 'smd', pack_type: '0603, 1608', capacitance: '0.1µF (0.1µF)', oper_volt: '50V (50.0V)', toler: '±10% (10%)', lifecycle: 'obsolete', url: 'https://search.murata.co.jp/Ceramy/image/img/A01X/G101/ENG/GRM188R71H104KA93-01.pdf' };
/** A Generic capacitor in a package listing: the search fills no value fields, the description and the number say it all. */
const BARE_CAP = { mpn: 'GPC0603225-10-X7R', manuf: 'Unknown', desc: '2.2 µF ±10% 10V Ceramic Capacitor X7R 0603 (1608 Metric)', cat: 'Ceramic Capacitors', gpn: '1', ecstock: '0', type: 'smd', pack_type: null };

/** A fetch answering the search by the classes and words asked; it records each request. */
function fakeSearch(answer: (classes: string, body: { mpn?: string; descr?: string; specs?: { spec: string; value: string | number; unit: string }[] }[]) => unknown[] | unknown) {
  const asked: { classes: string; length: string; body: unknown }[] = [];
  const fetchFn = async (url: string, init: { body: string }) => {
    const u = new URL(url);
    expect(u.pathname).toBe(EUROCIRCUITS_SEARCH);
    const classes = ['is_generic', 'is_ec_stock', 'is_ondemand'].map((k) => u.searchParams.get(k)).join('');
    const body = JSON.parse(init.body) as Parameters<typeof answer>[1];
    asked.push({ classes, length: u.searchParams.get('length')!, body });
    const parts = answer(classes, body);
    return { ok: true, status: 200, json: async () => (Array.isArray(parts) ? { Status: 1, Parts: parts, total: parts.length } : parts) };
  };
  return { fetchFn, asked };
}

describe('Eurocircuits parts', () => {
  it('reads a Generic resistor: its value and grade, kept in stock, free, no fee', () => {
    expect(fromEurocircuits(GENERIC_10K)).toMatchObject({
      sku: 'GPR060310K',
      mpn: 'GPR060310K',
      package: '0603',
      stock: null,
      supply: 'stock',
      tier: 'Generic',
      fee: false,
      price: [{ qty: 1, each: 0 }],
      attributes: { Resistance: '10kΩ', Tolerance: '±1%', 'Power(Watts)': '0.1W' },
      url: 'https://be.eurocircuits.com/shop/assembly/partdetail.aspx?mpn=GPR060310K',
      live: true,
      placement: 'smd',
    });
    expect(fromEurocircuits(GENERIC_10K).manufacturer).toBeUndefined();
  });

  it('reads an On Demand part: bought for the order, a fee, no price; its maker, lifecycle and datasheet', () => {
    const p = fromEurocircuits(OBSOLETE_CAP);
    expect(p).toMatchObject({ tier: 'On Demand', fee: true, supply: 'order', price: [], manufacturer: 'Murata', package: '0603', lifecycle: 'obsolete', datasheet: OBSOLETE_CAP.url });
    expect(p.attributes).toEqual({ Capacitance: '100nF', 'Voltage Rated': '50V', Tolerance: '±10%', 'Temperature Coefficient': 'X7R' });
  });

  it('takes the value, voltage, dielectric and package from the description where the fields are empty', () => {
    expect(fromEurocircuits(BARE_CAP)).toMatchObject({ package: '0603', attributes: { Capacitance: '2.2uF', 'Voltage Rated': '10V', 'Temperature Coefficient': 'X7R' } });
  });
});

describe('Eurocircuits search', () => {
  it('looks a part up by its number, any case, and keeps the exact match', async () => {
    const { fetchFn, asked } = fakeSearch((_c, body) => (body[0]!.mpn === 'GPR060310K' ? [GENERIC_10K] : []));
    const src = eurocircuitsSource(fetchFn);
    expect((await src.lookup('gpr060310k'))?.sku).toBe('GPR060310K');
    expect(asked[0]).toMatchObject({ classes: '000', body: [{ index: 0, mpn: 'GPR060310K' }] });
    expect(await src.lookup('NOPE-1')).toBeNull();
    expect(await src.lookup(' ')).toBeNull();
  });

  it('searches a resistor by value and package in each class, Generic first, without thermistors', async () => {
    const { fetchFn, asked } = fakeSearch((classes) => (classes === '100' ? [GENERIC_10K] : classes === '010' ? [THERMISTOR] : [ON_DEMAND_10K]));
    const parts = await eurocircuitsSource(fetchFn).search({ kind: 'resistor', value: '10k', package: '0603' });
    expect(parts.map((p) => p.sku)).toEqual(['GPR060310K', 'RC0603FR-0710KL']);
    expect(asked.map((a) => a.classes).sort()).toEqual(['001', '010', '100']);
    // its search needs words with the specs
    expect(asked[0]!.body).toEqual([{ index: 0, descr: '10kohm 0603', mpn: '10kohm 0603', spn: '10kohm 0603', specs: [{ value: '10', spec: 'res', unit: 'kohm' }, { value: '0603', spec: 'pack', unit: '' }] }]);
  });

  it('asks only the classes without a fee for no_fee, and states capacitors in its units', async () => {
    const { fetchFn, asked } = fakeSearch(() => []);
    await eurocircuitsSource(fetchFn).search({ kind: 'capacitor', value: '4.7uF', package: '805', noFee: true });
    expect(asked.map((a) => a.classes).sort()).toEqual(['010', '100']);
    expect((asked[0]!.body as { specs: unknown[] }[])[0]!.specs).toEqual([{ value: '4.7', spec: 'cap', unit: 'uF' }, { value: '0805', spec: 'pack', unit: '' }]);
  });

  it('lists every Generic resistor of a chip package, the values without a fee', async () => {
    const r1k = { ...GENERIC_10K, mpn: 'GPR06031K', resis: '1kohm' };
    const { fetchFn, asked } = fakeSearch(() => [GENERIC_10K, r1k, BARE_CAP, { ...GENERIC_10K, mpn: 'GPR040210K', pack_type: '0402' }]);
    const parts = await eurocircuitsSource(fetchFn).search({ kind: 'resistor', package: '0603', noFee: true, limit: 400 });
    expect(parts.map((p) => [p.sku, p.attributes.Resistance])).toEqual([
      ['GPR060310K', '10kΩ'],
      ['GPR06031K', '1kΩ'],
    ]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ classes: '100', length: '500' });
    await expect(eurocircuitsSource(fetchFn).search({ kind: 'resistor', package: 'SOT-23', noFee: true })).rejects.toThrow(/chip package/);
  });

  it('searches words as they are, and fails loudly on an answer it does not read', async () => {
    const { fetchFn, asked } = fakeSearch(() => [{ mpn: 'KPEG130', manuf: 'Kingstate', desc: 'Passive Buzzer', cat: 'Buzzer', gpn: '0', ecstock: '0', type: 'th_cut' }]);
    const [buzzer] = await eurocircuitsSource(fetchFn).search({ text: 'passive buzzer' });
    expect(buzzer).toMatchObject({ sku: 'KPEG130', placement: 'th', tier: 'On Demand' });
    expect(asked[0]!.body).toEqual([{ index: 0, descr: 'passive buzzer', mpn: 'passive buzzer', spn: 'passive buzzer', specs: [] }]);
    await expect(eurocircuitsSource(fakeSearch(() => ({ Status: 0, Message: 'no' })).fetchFn).search({ text: 'x' })).rejects.toThrow(/does not read/);
    const down = async () => ({ ok: false, status: 503, json: async () => null });
    await expect(eurocircuitsSource(down).lookup('GPR060310K')).rejects.toThrow('eurocircuits.com answered HTTP 503');
  });
});
