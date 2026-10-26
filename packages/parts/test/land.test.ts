import { describe, expect, it } from 'vitest';
import { JLCPCB_ASSEMBLY, type HouseFootprint, type SupplierPart } from '@4k7/schema';
import { canPackage, checkStock, easyedaFootprint, fitLand, footprintFor, jlcpcbSource, samePackage, standardPackage, stockReportText, tscircuitSource, type PartSource, type PlacedLand, type SourcedComponent } from '../src/index.ts';
import * as eda from './fixtures/easyeda.ts';

const fp = (raw: unknown) => easyedaFootprint(raw)!;

/** A standard package's land as the board places it: turned clockwise by `rot` (y down), with its pins' names. */
function land(pkgName: string, names: Record<string, string>, rot = 0, polarity?: PlacedLand['polarity']): PlacedLand {
  const pkg = standardPackage(pkgName)!;
  const r = footprintFor(pkg, Object.keys(names));
  if (!r.ok) throw new Error(r.reason);
  const turn = (x: number, y: number): [number, number] => (rot === 90 ? [-y, x] : rot === 180 ? [-x, -y] : rot === 270 ? [y, -x] : [x, y]);
  const swap = rot % 180 !== 0;
  return {
    name: pkg.name,
    pads: r.footprint.pads.map((p) => {
      const [x, y] = turn(p.x, p.y);
      const numbers = [p.number, ...(p.also ?? [])];
      return { numbers, names: numbers.map((n) => names[n] ?? '').filter(Boolean), x, y, w: swap ? p.h : p.w, h: swap ? p.w : p.h, ...(p.drill ? { drill: true } : {}) };
    }),
    ...(polarity ? { polarity } : {}),
  };
}

/** spiral2's C1 as JLCPCB got it: chip-style pads as tall as the can (the land before the V-chip packages). */
const chipLand: PlacedLand = {
  name: 'CAP-6.3x5.4',
  pads: [
    { numbers: ['1'], names: ['+'], x: -2.55, y: 0, w: 2.2, h: 6.8 },
    { numbers: ['2'], names: ['-'], x: 2.55, y: 0, w: 2.2, h: 6.8 },
  ],
  polarity: { kind: 'plus', pad: '1' },
};

describe('a part\'s footprint in JLCPCB\'s library (EasyEDA)', () => {
  it('reads the pads in mm from the origin, with the pins\' names from the symbol', () => {
    const cap = fp(eda.C72505);
    expect(cap.name).toBe('CAP-SMD_BD6.3-L6.6-W6.6-FD');
    expect(cap.pads).toEqual([
      { number: '1', name: '1', x: -2.67, y: 0, w: 3.5, h: 1.2 },
      { number: '2', name: '2', x: 2.67, y: 0, w: 3.5, h: 1.2 },
    ]);
    // a pad turned by 90° (its outline says how big it is), the names K and A
    const led = fp(eda.C2297);
    expect(led.pads.map((p) => [p.number, p.name, p.x])).toEqual([
      ['2', 'K', -1.05],
      ['1', 'A', 1.05],
    ]);
    // drilled shield legs
    expect(fp(eda.C165948).pads.filter((p) => p.drill).map((p) => p.name)).toEqual(['EH', 'EH', 'EH', 'EH']);
  });

  it('says null for a part EasyEDA does not know, and fails on an answer it cannot read', () => {
    expect(easyedaFootprint({ success: false, code: 404 })).toBeNull();
    expect(() => easyedaFootprint('<html>403</html>')).toThrow(/does not read/);
    expect(() => easyedaFootprint({ success: true, result: { packageDetail: { dataStr: {} } } })).toThrow(/footprint/);
  });

  it('is asked of easyeda.com by the LCSC number, and of the mirror\'s copy of the same record', async () => {
    const urls: string[] = [];
    const get = async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => eda.C3342 };
    };
    const live = await jlcpcbSource(undefined, undefined, get).footprint!('c3342');
    expect(urls).toEqual(['https://easyeda.com/api/products/C3342/components?version=6.4.19.5']);
    expect(live!.name).toBe('CAP-SMD_BD6.3-L6.6-W6.6-FD');
    const forbidden = jlcpcbSource(undefined, undefined, async () => ({ ok: false, status: 403, json: async () => null }));
    await expect(forbidden.footprint!('C3342')).rejects.toThrow('easyeda.com answered HTTP 403');
    const mirror = tscircuitSource(async () => ({ ok: true, status: 200, json: async () => ({ easyeda_component_details: { easyeda_json: eda.C3342.result } }) }));
    expect(await mirror.footprint!('C3342')).toEqual(live);
  });
});

describe('the land against the part the house buys', () => {
  it('flags the land spiral2 had: chip-style pads as tall as the can, under a 6.3 mm electrolytic', () => {
    const fit = fitLand(chipLand, fp(eda.C72505));
    expect(fit.overlap).toBeLessThan(0.2);
    expect(fit.problems).toEqual(['its pads are 3.5 × 1.2 mm, 5.34 mm apart; the pads of CAP-6.3x5.4 2.2 × 6.8 mm, 5.1 mm apart']);
  });

  it('takes the V-chip land of the part\'s own can, turned either way', () => {
    const plus = { kind: 'plus' as const, pad: '1' };
    const fit = fitLand(land('CAP-6.3x5.4', { 1: '+', 2: '-' }, 180, plus), fp(eda.C72505));
    expect(fit).toMatchObject({ problems: [], rotation: 180 });
    expect(fit.overlap).toBeGreaterThan(0.6);
    expect(fitLand(land('CAP-6.3x7.7', { 1: '+', 2: '-' }, 90, plus), fp(eda.C3342))).toMatchObject({ problems: [], rotation: 270 });
  });

  it('pairs an LED by its cathode whichever pin number the part gives it', () => {
    // generic:LED: pin 1 is the cathode; turned 180°, it is on the right
    const ours = land('0805', { 1: 'K', 2: 'A' }, 180, { kind: 'cathode', pad: '1' });
    // KT-0805G numbers its anode 1 (and names it A), NCD0805R1 its cathode 1 (named −): both lie with the cathode on the right
    expect(fitLand(ours, fp(eda.C2297))).toMatchObject({ by: 'function', rotation: 180, problems: [] });
    expect(fitLand(ours, fp(eda.C84256))).toMatchObject({ by: 'function', rotation: 180, problems: [] });
  });

  it('pairs by name where the numbers differ: a SOT-223 tab, USB-C contacts', () => {
    // our SOT-223 lands its tab as pin 2 (VOUT), JLCPCB's numbers it 4
    const reg = fitLand(land('SOT-223', { 1: 'GND', 2: 'VOUT', 3: 'VIN' }, 90), fp(eda.C6186));
    expect(reg).toMatchObject({ by: 'name', problems: [] });
    // a USB-C receptacle whose pins are named GND_A1 … against A1B12 … named GND …, shield legs by where they are
    const usb = fp(eda.C165948);
    const contact = (n: string, name: string, x: number) => ({ numbers: [n], names: [name], x, y: -3.67, w: Math.abs(x) > 2 ? 0.6 : 0.3, h: 1.14 });
    const ours: PlacedLand = {
      name: 'USB_C',
      pads: [
        contact('1', 'GND_A1', -3.2), contact('3', 'VBUS_A4', -2.4), contact('6', 'SBU2_B8', -1.75), contact('5', 'CC1_A5', -1.25), contact('7', 'DN2_B7', -0.75), contact('8', 'DP1_A6', -0.25),
        contact('9', 'DN1_A7', 0.25), contact('10', 'DP2_B6', 0.75), contact('11', 'SBU1_A8', 1.25), contact('12', 'CC2_B5', 1.75), contact('13', 'VBUS_A9', 2.4), contact('15', 'GND_A12', 3.2),
        ...[[-4.325, -3.1], [4.325, -3.1], [-4.325, 1.08], [4.325, 1.08]].map(([x, y]) => ({ numbers: ['17'], names: ['SHELL'], x: x!, y: y!, w: 1, h: 2, drill: true })),
      ],
    };
    expect(fitLand(ours, usb)).toMatchObject({ by: 'name', rotation: 0, problems: [] });
  });

  it('mirrors the house\'s land for a part on the bottom side', () => {
    const top = land('0805', { 1: 'K', 2: 'A' }, 90, { kind: 'cathode', pad: '1' });
    const bottom: PlacedLand = { ...top, bottom: true, pads: top.pads.map((p) => ({ ...p, x: -p.x })) };
    expect(fitLand(bottom, fp(eda.C2297)).problems).toEqual([]);
  });

  it('says which pins have no pad, and a pin that misses its pad', () => {
    const three: PlacedLand = { name: 'SOD-3', pads: [{ numbers: ['1'], names: ['K'], x: -1.5, y: 0, w: 1, h: 1 }, { numbers: ['2'], names: ['A'], x: 1.5, y: 0, w: 1, h: 1 }, { numbers: ['3'], names: ['NC'], x: 0, y: 1.5, w: 1, h: 1 }] };
    const fit = fitLand(three, fp(eda.C84256));
    expect(fit.problems.join(' ')).toContain('no pin of it lands on pad 3 of SOD-3');
    const wide: HouseFootprint = { name: 'wide', pads: [{ number: '1', x: -4, y: 0, w: 1, h: 1 }, { number: '2', x: 4, y: 0, w: 1, h: 1 }] };
    expect(fitLand(three, wide).problems.join(' ')).toMatch(/its pin \d lands 2\.5 mm off pad \d of SOD-3/);
  });
});

describe('the stock check holds each land against the house\'s footprint', () => {
  const cap = (sku: string, pkg: string, capacitance: string): SupplierPart => ({
    sku,
    mpn: sku,
    package: pkg,
    description: '',
    stock: 100_000,
    tier: 'Extended',
    fee: true,
    price: [],
    attributes: { Capacitance: capacitance, 'Voltage Rated': '50V' },
    url: '',
    live: true,
  });
  const catalogue = (footprint: PartSource['footprint']): PartSource => ({
    lookup: async (sku) => (sku === 'C72505' ? cap('C72505', 'SMD,D6.3xL5.4mm', '22uF') : sku === 'C3342' ? cap('C3342', 'SMD,D6.3xL7.7mm', '220uF') : null),
    search: async () => [],
    ...(footprint ? { footprint } : {}),
  });
  const footprints: PartSource['footprint'] = async (sku) => fp(sku === 'C72505' ? eda.C72505 : eda.C3342);
  const comp = (refdes: string, lcsc: string, pkg: string, capacitance: string, l?: PlacedLand): SourcedComponent => ({ refdes, category: 'capacitor', params: { capacitance, voltage: '16V', lcsc }, pkg, ...(l ? { land: l } : {}) });

  it('stops the order for spiral2\'s C1 and C11, and says which package would fit', async () => {
    const r = await checkStock([comp('C1', 'C72505', 'CAP-6.3x5.4', '22uF', chipLand), comp('C11', 'C3342', 'CAP-8x10', '220uF', land('CAP-8x10', { 1: '+', 2: '-' }, 90, { kind: 'plus', pad: '1' }))], catalogue(footprints), { house: JLCPCB_ASSEMBLY, boards: 5 });
    const c1 = r.lines.find((l) => l.sku === 'C72505')!;
    expect(c1.mismatch).toEqual(['land: C72505 does not fit footprint CAP-6.3x5.4 (the part\'s land is CAP-SMD_BD6.3-L6.6-W6.6-FD): its pads are 3.5 × 1.2 mm, 5.34 mm apart; the pads of CAP-6.3x5.4 2.2 × 6.8 mm, 5.1 mm apart; the house cannot place it there.']);
    // a 6.3 mm can lies on the 8 mm can's pads well enough, but it is not the part the footprint is for
    const c11 = r.lines.find((l) => l.sku === 'C3342')!;
    expect(c11.mismatch).toEqual(['package: the part is SMD,D6.3xL7.7mm, the component CAP-8x10 (package CAP-6.3x7.7 fits the part: set_param package, or choose a part for CAP-8x10)']);
    expect(r.lands).toEqual({ compared: 2, unread: [] });
    expect(stockReportText(r, JLCPCB_ASSEMBLY)).toContain("Lands: 2 components held against JLCPCB's own footprint for the part.");
  });

  it('passes the V-chip land, and a can of the same size by name when there is no footprint to compare', async () => {
    const ok = await checkStock([comp('C1', 'C72505', 'CAP-6.3x5.4', '22uF', land('CAP-6.3x5.4', { 1: '+', 2: '-' }, 0, { kind: 'plus', pad: '1' }))], catalogue(footprints), { house: JLCPCB_ASSEMBLY, boards: 5 });
    expect(ok.lines[0]!.mismatch).toEqual([]);
    const byName = await checkStock([comp('C1', 'C72505', 'CAP-6.3x5.4', '22uF')], catalogue(undefined), { house: JLCPCB_ASSEMBLY, boards: 5 });
    expect(byName.lines[0]!.mismatch).toEqual([]);
    expect(byName.lands).toBeUndefined();
  });

  it('says which footprints it could not read, and why, and still checks the package by name', async () => {
    const blocked: PartSource['footprint'] = async () => {
      throw new Error('easyeda.com answered HTTP 403');
    };
    const r = await checkStock([comp('C11', 'C3342', 'CAP-8x10', '220uF', land('CAP-8x10', { 1: '+', 2: '-' }))], catalogue(blocked), { house: JLCPCB_ASSEMBLY, boards: 5 });
    expect(r.lands).toEqual({ compared: 0, unread: [{ sku: 'C3342', why: 'easyeda.com answered HTTP 403' }] });
    expect(r.lines[0]!.mismatch[0]).toMatch(/^package: the part is SMD,D6\.3xL7\.7mm/);
    expect(stockReportText(r, JLCPCB_ASSEMBLY)).toContain('not compared: C3342 (easyeda.com answered HTTP 403)');
  });
});

describe('electrolytic packages', () => {
  it('read a catalogue\'s can as the package that fits it', () => {
    expect(canPackage('SMD,D6.3xL7.7mm')).toBe('CAP-6.3x7.7');
    expect(canPackage('SMD,D8xL10.5mm')).toBe('CAP-8x10');
    expect(canPackage('SMD,D6.3xL5.8mm')).toBe('CAP-6.3x5.4');
    expect(canPackage('SMD,D10xL13mm')).toBeNull();
    expect(canPackage('Plugin,D8xL10mm')).toBeNull();
    expect(canPackage('0603')).toBeNull();
    expect(samePackage('CAP-6.3x5.4', 'SMD,D6.3xL5.4mm')).toBe(true);
    expect(samePackage('CAP-8x10', 'SMD,D6.3xL7.7mm')).toBe(false);
  });

  it('land each can as its makers recommend, the base plate chamfered on the + side', () => {
    const pkg = standardPackage('CAP-6.3x7.7')!;
    expect(pkg).toMatchObject({ name: 'CAP-6.3x7.7', body_mm: [6.6, 6.6], height_mm: 7.7, body_chamfer: { corners: ['tl', 'bl'] } });
    const r = footprintFor(pkg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.footprint.pads.map((p) => [p.number, p.x, p.w, p.h])).toEqual([
      ['1', -2.7, 3.5, 1.6],
      ['2', 2.7, 3.5, 1.6],
    ]);
    expect(r.footprint.body.chamfer).toEqual({ size: 1.32, corners: ['tl', 'bl'] });
    // the old names still work
    expect(standardPackage('CAP-6.3')!.name).toBe('CAP-6.3x5.4');
  });
});
