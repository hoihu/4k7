import { describe, expect, it } from 'vitest';
import type { PackageInfo, PartDraft } from '@4k7/schema';
import { bgaRowName, compareDrafts, draftToCard, footprintFor, planUnits, symbolFor, unitOfPin } from '../src/index.ts';

const lqfp100: PackageInfo = { name: 'LQFP100', family: 'QFP', pins: 100, pitch_mm: 0.5, body_mm: [14, 14], span_mm: [16, 16], lead_length_mm: 0.6, lead_width_mm: 0.22 };

/** A plausible 100-pin MCU draft: 5 ports of 16 + supplies, grounds and system pins. */
function mcuDraft(overrides: Partial<PartDraft> = {}): PartDraft {
  const pins: PartDraft['pins'] = [];
  const special: Record<number, [string, PartDraft['pins'][number]['type']]> = {
    6: ['VBAT', 'pwr_in'], 10: ['VSS', 'pwr_in'], 11: ['VDD', 'pwr_in'], 14: ['NRST', 'in'], 19: ['VSSA', 'pwr_in'], 20: ['VREF+', 'pwr_in'],
    21: ['VDDA', 'pwr_in'], 27: ['VSS', 'pwr_in'], 28: ['VDD', 'pwr_in'], 49: ['VCAP1', 'passive'], 50: ['VDD', 'pwr_in'], 73: ['VCAP2', 'passive'],
    74: ['VSS', 'pwr_in'], 75: ['VDD', 'pwr_in'], 94: ['BOOT0', 'in'], 99: ['VSS', 'pwr_in'], 100: ['VDD', 'pwr_in'],
  };
  const ports = ['A', 'B', 'C', 'D', 'E'];
  let io = 0;
  for (let n = 1; n <= 100; n++) {
    const s = special[n];
    if (s) pins.push({ number: String(n), name: s[0], type: s[1] });
    else {
      pins.push({ number: String(n), name: `P${ports[Math.floor(io / 17) % 5]}${io % 17}`, type: 'bidir' });
      io++;
    }
  }
  return { mpn: 'TESTMCU100', manufacturer: 'Test Semi', description: 'Test MCU, LQFP100', category: 'ic', package: lqfp100, pins, ...overrides };
}

describe('footprints', () => {
  it('numbers an LQFP100 counter-clockwise from the top of the left side', () => {
    const r = footprintFor(lqfp100);
    if (!r.ok) throw new Error(r.reason);
    const pad = (n: number) => r.footprint.pads.find((p) => p.number === String(n))!;
    expect(r.footprint.pads).toHaveLength(100);
    expect(pad(1).x).toBeLessThan(0); // left side
    expect(pad(1).y).toBeLessThan(pad(25).y); // top → bottom
    expect(pad(26).y).toBeGreaterThan(0); // bottom side
    expect(pad(26).x).toBeLessThan(pad(50).x); // left → right
    expect(pad(51).x).toBeGreaterThan(0); // right side, bottom → top
    expect(pad(76).y).toBeLessThan(0); // top side
    expect(pad(76).x).toBeGreaterThan(pad(100).x); // right → left
    // pitch and a pad that sits across the lead foot
    expect(Math.abs(pad(2).y - pad(1).y)).toBeCloseTo(0.5, 6);
    expect(pad(1).x - pad(1).w / 2).toBeLessThan(-8); // reaches past the lead tips (span 16)
    expect(pad(1).x + pad(1).w / 2).toBeGreaterThan(-7.5); // and in under the foot
  });

  it('builds SOIC-8 and a QFN with its exposed pad', () => {
    const so = footprintFor({ name: 'SOIC-8', family: 'SOIC', pins: 8, pitch_mm: 1.27, body_mm: [3.9, 4.9], span_mm: [6, 4.9] });
    expect(so.ok && so.footprint.pads.map((p) => p.number)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    const qfn = footprintFor({ name: 'UFQFPN48', family: 'QFN', pins: 48, pitch_mm: 0.5, body_mm: [7, 7], exposed_pad_mm: [5.6, 5.6] }, [...Array.from({ length: 48 }, (_, i) => String(i + 1)), '49']);
    expect(qfn.ok && qfn.footprint.pads).toHaveLength(49);
    expect(qfn.ok && qfn.footprint.pads.at(-1)).toMatchObject({ number: '49', x: 0, y: 0, w: 5.6 });
  });

  it('names BGA rows the JEDEC way and only places listed balls', () => {
    // A B C D E F G H J K L M N P R T U V W Y, then AA …
    expect([0, 7, 8, 11, 12, 13, 19, 20].map(bgaRowName)).toEqual(['A', 'H', 'J', 'M', 'N', 'P', 'Y', 'AA']);
    const r = footprintFor({ name: 'TFBGA100', family: 'BGA', pins: 3, pitch_mm: 0.8, grid: { rows: 10, cols: 10 } }, ['A1', 'J10', 'K5']);
    expect(r.ok && r.footprint.pads.map((p) => p.number)).toEqual(['A1', 'J10', 'K5']);
  });

  it('explains what is missing', () => {
    const r = footprintFor({ name: 'LQFP64', family: 'QFP', pins: 64 });
    expect(r).toEqual({ ok: false, reason: 'needs pitch_mm, body_mm from the package drawing' });
  });
});

describe('draft → part card', () => {
  it('refuses a family the package name contradicts (a TSSOP read as QFP gets four-sided pads)', () => {
    const tssop: PackageInfo = { name: 'TSSOP-24 (PW0024A)', family: 'QFP', pins: 24, pitch_mm: 0.65, body_mm: [4.4, 7.8], span_mm: [6.4, 7.8], lead_length_mm: 0.6, lead_width_mm: 0.25 };
    const pins: PartDraft['pins'] = Array.from({ length: 24 }, (_, i) => ({ number: String(i + 1), name: i === 11 ? 'GND' : i === 23 ? 'VCC' : `IO${i}`, type: i === 11 || i === 23 ? 'pwr_in' : 'bidir' }));
    const draft = { mpn: 'TCA9548APWR', manufacturer: 'TI', description: 'I2C switch', category: 'ic' as const, package: tssop, pins };
    const bad = draftToCard(draft);
    expect(bad.card).toBeNull();
    expect(bad.issues.map((i) => i.message)).toContain('Package family QFP does not fit "TSSOP-24 (PW0024A)"; use SOIC or SSOP or TSSOP or MSOP.');
    expect(draftToCard({ ...draft, package: { ...tssop, family: 'TSSOP' } }).card).not.toBeNull();
  });

  it('compares only the span the footprint uses', () => {
    const base = { mpn: 'X', manufacturer: 'TI', description: 'I2C switch', category: 'ic' as const, pins: [{ number: '1', name: 'A', type: 'in' as const }] };
    const tssop = (span: [number, number]): PartDraft => ({ ...base, package: { name: 'TSSOP-24', family: 'TSSOP', pins: 24, pitch_mm: 0.65, body_mm: [4.4, 7.8], span_mm: span } });
    // the second value of a two-row package's span (the body length) shapes nothing
    expect(compareDrafts(tssop([6.4, 7.8]), tssop([6.4, 6.4]))).toEqual([]);
    expect(compareDrafts(tssop([6.4, 7.8]), tssop([6.2, 7.8])).map((d) => d.key)).toEqual(['package:span_mm']);
    const qfn = (span?: [number, number]): PartDraft => ({ ...base, package: { name: 'VQFN-16', family: 'QFN', pins: 16, pitch_mm: 0.5, body_mm: [3, 3], ...(span ? { span_mm: span } : {}) } });
    expect(compareDrafts(qfn([3, 3]), qfn())).toEqual([]);
  });

  it('counts analog, power and digital grounds (AGND, PGND, DVSS) as grounds, and not as supplies', () => {
    const qfn: PackageInfo = { name: 'VQFN-16', family: 'QFN', pins: 16, pitch_mm: 0.5, body_mm: [3, 3], exposed_pad_mm: [1.68, 1.68], lead_length_mm: 0.4, lead_width_mm: 0.24 };
    const names = ['SW', 'SW', 'SW', 'PG', 'FB', 'DVSS', 'FSW', 'DEF', 'SS/TR', 'AVIN', 'PVIN', 'PVIN', 'EN', 'VOS', 'PGND', 'PGND'];
    const pins: PartDraft['pins'] = names.map((name, i) => ({ number: String(i + 1), name, type: /GND|VIN/.test(name) ? 'pwr_in' : 'passive' }));
    const { card, issues } = draftToCard({ mpn: 'TPS62130RGTR', manufacturer: 'TI', description: 'Step-down converter', category: 'ic', package: qfn, pins: [...pins, { number: 'EP', name: 'PGND', type: 'pwr_in' }] });
    expect(card).not.toBeNull();
    expect(issues.map((i) => i.message).filter((m) => /ground|supply/i.test(m))).toEqual([]);
  });

  it('accepts a consistent draft and lays out the symbol like an MCU', () => {
    const { card, issues } = draftToCard(mcuDraft());
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(card?.id).toBe('test:TESTMCU100');
    const layout = card!.symbolLayout!;
    // repeated supplies are stacked into one position each
    expect(layout.top).toEqual([]); // supplies on the side keep the body narrow
    expect(layout.left[0]).toEqual(['6']); // VBAT first
    expect(layout.left.find((s) => s && s.length === 5)).toBeTruthy(); // VDD ×5
    expect(layout.bottom.find((s) => s && s.length === 4)).toBeTruthy(); // VSS ×4
    const sym = symbolFor(card!);
    expect(sym.pins).toHaveLength(100); // every pin exists, stacked ones share a position
    const vdd = sym.pins.filter((p) => p.name === 'VDD');
    expect(new Set(vdd.map((p) => `${p.x},${p.y}`)).size).toBe(1);
    expect(vdd.filter((p) => p.showName)).toHaveLength(1);
    // ports grouped, with gaps between groups on a side
    expect(layout.left.includes(null) || layout.right.includes(null)).toBe(true);
    expect(card!.packageInfo?.name).toBe('LQFP100');
  });

  it('keeps the MCU body narrow: no pins on top, the width comes from the side names', () => {
    const { card } = draftToCard(mcuDraft());
    const sym = symbolFor(card!);
    expect(sym.pins.some((p) => p.side === 'top')).toBe(false);
    expect(sym.bbox.w - 400).toBeLessThanOrEqual(700); // body; was 2100 with the supplies on top
  });

  it('splits a big IC into units that cover every pin once', () => {
    const { card } = draftToCard(mcuDraft());
    const units = planUnits(card!.pins);
    expect(units.map((u) => u.title)).toEqual(['Power, system', 'PA, PB', 'PC, PD', 'PE']);
    const split = { ...card!, units };
    const all = units.flatMap((_, i) => symbolFor(split, false, { unit: i }).pins.map((p) => p.number));
    expect(all.sort()).toEqual(card!.pins.map((p) => p.number).sort());
    expect(new Set(all).size).toBe(100);
    const pa0 = card!.pins.find((p) => p.name === 'PA0')!.number;
    expect(unitOfPin(split, pa0)).toBe(1);
    expect(unitOfPin(split, '11')).toBe(0); // VDD
    const power = symbolFor(split, false, { unit: 0 });
    expect(power.pins.filter((p) => p.side === 'bottom').every((p) => /VSS/.test(p.name))).toBe(true);
  });

  it('reports missing and duplicate pins instead of producing a card', () => {
    const d = mcuDraft();
    d.pins = d.pins.filter((p) => p.number !== '37' && p.number !== '38');
    d.pins.push({ number: '5', name: 'PX1', type: 'bidir' });
    const { card, issues } = draftToCard(d);
    expect(card).toBeNull();
    const text = issues.map((i) => i.message).join('\n');
    expect(text).toContain('Duplicate pin numbers: 5');
    expect(text).toContain('Missing pin numbers: 37–38');
    expect(text).toContain('has 100 pins but the draft lists 99');
  });

  it('rejects impossible BGA ball names', () => {
    const d = mcuDraft({ package: { name: 'TFBGA100', family: 'BGA', pins: 100, pitch_mm: 0.8, grid: { rows: 10, cols: 10 } } });
    d.pins = d.pins.map((p, i) => ({ ...p, number: `${'ABCDEFGHJK'[Math.floor(i / 10)]}${(i % 10) + 1}` }));
    d.pins[0] = { ...d.pins[0]!, number: 'I1' };
    const { issues } = draftToCard(d);
    expect(issues.find((i) => i.message.includes('Ball names not valid'))?.message).toContain('I1');
  });

  it('turns schema problems into readable issues', () => {
    const { card, issues } = draftToCard({ mpn: 'X', pins: [] });
    expect(card).toBeNull();
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('two-pass reconciliation', () => {
  it('finds pin and package disagreements and merges the chosen values', async () => {
    const { compareDrafts, mergeDrafts } = await import('../src/index.ts');
    const a = mcuDraft();
    const b = structuredClone(a);
    b.pins[14] = { ...b.pins[14]!, name: 'PC1' }; // pin 15 read differently
    b.pins[1] = { ...b.pins[1]!, name: b.pins[1]!.name.toLowerCase() }; // same name, other case: agrees
    b.package = { ...b.package, pitch_mm: 0.5004, lead_width_mm: 0.27 };
    b.pins[2] = { ...b.pins[2]!, name: `${b.pins[2]!.name}-OSC_IN` }; // same pin, longer name: agrees
    const diff = compareDrafts(a, b);
    expect(diff.map((d) => d.key)).toEqual(['pin:15', 'package:lead_width_mm']);
    expect(diff[0]).toMatchObject({ a: `${a.pins[14]!.name} (bidir)`, b: 'PC1 (bidir)' });
    const merged = mergeDrafts(a, b, new Set(['pin:15']));
    expect(merged.pins[14]!.name).toBe('PC1');
    expect(merged.package.lead_width_mm).toBe(0.22);
    expect(compareDrafts(merged, b).map((d) => d.key)).toEqual(['package:lead_width_mm']);
  });
});

describe('3D bodies', () => {
  it('builds an LQFP100 with 100 gull-wing leads reaching the lead span', async () => {
    const { body3dFor } = await import('../src/index.ts');
    const r = body3dFor({ ...lqfp100, height_mm: 1.6 });
    if (!r.ok) throw new Error(r.reason);
    const leads = r.body.boxes.filter((b) => b.mat === 'lead');
    expect(leads).toHaveLength(300); // shoulder, bend, foot per lead
    const maxX = Math.max(...leads.map((b) => b.max[0]));
    expect(maxX).toBeCloseTo(8, 3); // span 16 mm
    expect(Math.min(...leads.map((b) => b.min[2]))).toBe(0); // feet on the board
    expect(r.body.height).toBe(1.6);
  });

  it('puts BGA balls only where the pin list has them', async () => {
    const { body3dFor } = await import('../src/index.ts');
    const r = body3dFor({ name: 'TFBGA100', family: 'BGA', pins: 3, pitch_mm: 0.8, grid: { rows: 10, cols: 10 }, ball_mm: 0.4 }, ['A1', 'K10', 'E5']);
    expect(r.ok && r.body.balls).toHaveLength(3);
    expect(body3dFor({ name: 'X', family: 'QFP', pins: 64 })).toEqual({ ok: false, reason: 'needs pitch_mm, body_mm from the package drawing' });
  });
});
