import { afterAll, describe, expect, it } from 'vitest';
import { draftToCard, planUnits, registerUserParts, unregisterUserPart } from '@tracewise/parts';
import type { PartCard, PartDraft } from '@tracewise/schema';
import { Kernel } from '../src/index.ts';

/** A 48-pin MCU: 3 ports of ~12 plus supplies, as imported from a datasheet. */
function mcu(split: boolean): PartCard {
  const special: Record<number, [string, PartDraft['pins'][number]['type']]> = {
    1: ['VBAT', 'pwr_in'], 7: ['NRST', 'in'], 8: ['VSSA', 'pwr_in'], 9: ['VDDA', 'pwr_in'], 23: ['VSS', 'pwr_in'], 24: ['VDD', 'pwr_in'],
    35: ['VSS', 'pwr_in'], 36: ['VDD', 'pwr_in'], 44: ['BOOT0', 'in'], 47: ['VSS', 'pwr_in'], 48: ['VDD', 'pwr_in'],
  };
  const pins: PartDraft['pins'] = [];
  let io = 0;
  for (let n = 1; n <= 48; n++) {
    const s = special[n];
    if (s) pins.push({ number: String(n), name: s[0], type: s[1] });
    else pins.push({ number: String(n), name: `P${'ABC'[Math.floor(io / 13)]}${io++ % 13}`, type: 'bidir' });
  }
  const { card } = draftToCard({
    mpn: split ? 'SPLITMCU48' : 'MCU48',
    manufacturer: 'Test',
    description: 'test MCU',
    package: { name: 'LQFP48', family: 'QFP', pins: 48, pitch_mm: 0.5, body_mm: [7, 7] },
    pins,
  });
  return split ? { ...card!, units: planUnits(card!.pins) } : card!;
}

const split = mcu(true);
const single = mcu(false);
registerUserParts([split, single]);
afterAll(() => {
  unregisterUserPart(split.id);
  unregisterUserPart(single.id);
});

describe('split symbols', () => {
  it('draws each unit as its own symbol and attaches parts to the unit that has the pin', () => {
    const k = new Kernel();
    const pa0 = split.pins.find((p) => p.name === 'PA0')!.number;
    const r = k.transact({
      summary: 'mcu',
      ops: [
        { op: 'add_part', part: split.id, refdes: 'U1' },
        { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } },
        { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '100nF', voltage: '16V' } },
        { op: 'connect', pins: [`U1.${pa0}`, 'R1.1'], net: 'LED' },
        { op: 'connect', pins: ['R1.2', 'U1.23', 'U1.35', 'U1.47', 'U1.8', 'C1.2'], net: 'GND' },
        { op: 'connect', pins: ['U1.24', 'U1.36', 'U1.48', 'U1.9', 'U1.1', 'C1.1'], net: '+3V3' },
        { op: 'set_net', net: '+3V3', voltage: 3.3 },
      ],
    });
    expect(r, JSON.stringify(r).slice(0, 400)).toMatchObject({ status: expect.stringMatching(/ok|applied|pending/) });
    const sheet = k.state().view.sheets[0]!;
    const units = sheet.symbols.filter((s) => s.refdes === 'U1');
    expect(units.map((s) => s.unit)).toEqual(['A', 'B', 'C']);
    // every pin exists exactly once over all units
    expect(units.flatMap((s) => s.pins.map((p) => p.number)).sort()).toEqual(split.pins.map((p) => p.number).sort());
    // units side by side, not overlapping
    const [a, b] = [units[0]!.bbox, units[1]!.bbox];
    expect(b.x).toBeGreaterThan(a.x + a.w);
    // R1 hangs off PA0 on unit B: its column is next to unit B, not unit A
    const r1 = sheet.symbols.find((s) => s.refdes === 'R1')!;
    const unitB = units[1]!;
    expect(Math.abs(r1.bbox.x - unitB.bbox.x)).toBeLessThan(Math.abs(r1.bbox.x - units[0]!.bbox.x));
    // the decap sits under the power unit (A)
    const c1 = sheet.symbols.find((s) => s.refdes === 'C1')!;
    expect(c1.bbox.x).toBeLessThan(unitB.bbox.x);
    // VBAT, VDD, VDDA on +3V3 are neighbours: one bus with one supply symbol, not three
    const unitA = units[0]!;
    const rails = sheet.labels.filter((l) => l.text === '+3V3' && l.kind === 'rail' && l.x < unitA.bbox.x + unitA.bbox.w && l.y < unitA.bbox.y + 400);
    expect(rails).toHaveLength(1);
    const busX = rails[0]!.x;
    const vertical = sheet.wires.find((w) => w.pts[0] === busX && w.pts[2] === busX && w.pts[1] !== w.pts[3]);
    expect(vertical).toBeTruthy();
    expect(sheet.junctions.filter((j) => j.x === busX)).toHaveLength(2); // T joints; the bottom is a corner
  });

  it('switches a placed, wired part to units and back without touching its wiring (set_symbol)', () => {
    const k = new Kernel();
    const pa0 = single.pins.find((p) => p.name === 'PA0')!.number;
    k.transact({
      summary: 'mcu',
      ops: [
        { op: 'add_part', part: single.id, refdes: 'U3' },
        { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } },
        { op: 'connect', pins: [`U3.${pa0}`, 'R1.1'], net: 'LED' },
        { op: 'connect', pins: ['R1.2', 'U3.23', 'U3.35', 'U3.47', 'U3.8'], net: 'GND' },
        { op: 'connect', pins: ['U3.24', 'U3.36', 'U3.48', 'U3.9', 'U3.1'], net: '+3V3' },
      ],
    });
    k.accept();
    const before = k.exportDesign();
    const pinsOf = (json: string) => JSON.stringify(Object.values(JSON.parse(json).components as Record<string, { refdes: string; pins: unknown }>).map((c) => [c.refdes, c.pins]));

    k.transact({ summary: 'split U3', ops: [{ op: 'set_symbol', ref: 'U3', style: 'units' }] });
    const p = k.proposal()!;
    expect(p.hunks.map((h) => [h.kind, h.title])).toEqual([['part', 'U3 symbol: single → 3 units']]);
    k.accept([p.hunks[0]!.id], 'user');
    const units = k.state().view.sheets[0]!.symbols.filter((s) => s.refdes === 'U3');
    expect(units.map((s) => s.unit)).toEqual(['A', 'B', 'C']);
    expect(pinsOf(k.exportDesign())).toBe(pinsOf(before)); // same components, same connections

    k.transact({ summary: 'single again', ops: [{ op: 'set_symbol', ref: 'U3', style: 'single' }] });
    k.accept();
    expect(k.state().view.sheets[0]!.symbols.filter((s) => s.refdes === 'U3')).toHaveLength(1);

    const r = k.transact({ summary: 'split a resistor', ops: [{ op: 'set_symbol', ref: 'R1', style: 'units' }] });
    expect(JSON.stringify(r)).toContain('SYMBOL_STYLE');
  });
});
