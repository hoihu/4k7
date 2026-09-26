import { describe, expect, it } from 'vitest';
import { Kernel } from '../src/index.ts';

const sym = (k: Kernel, r: string) => k.state().view.sheets[0]!.symbols.find((s) => s.refdes === r)!;

describe('connectors', () => {
  it('input connectors stack on the left, output connectors go right', () => {
    const k = new Kernel();
    k.transact({ summary: 'three connectors and an LDO', ops: [
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
      { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J2' },
      { op: 'add_part', part: 'generic:CONN_1x3', refdes: 'J3' },
      { op: 'add_part', part: 'ams:AMS1117-3.3', refdes: 'U1' },
      { op: 'connect', pins: ['J1.1', 'U1.VIN'], net: '+5V' },
      { op: 'connect', pins: ['J1.2', 'J2.4', 'J3.3', 'U1.GND'], net: 'GND' },
      { op: 'connect', pins: ['J2.1', 'U1.VOUT'], net: '+3V3' },
      { op: 'connect', pins: ['J2.2'], net: 'SDA' },
      { op: 'connect', pins: ['J2.3'], net: 'SCL' },
      { op: 'connect', pins: ['J3.1'], net: 'SDA' },
      { op: 'connect', pins: ['J3.2'], net: 'SCL' },
    ] });
    const [j1, j2, j3, u1] = ['J1', 'J2', 'J3', 'U1'].map((r) => sym(k, r).bbox);
    // J1 (brings +5V in) and J3 (signals only) share the left column, J1 on top
    expect(j3!.x).toBe(j1!.x);
    expect(j3!.y).toBeGreaterThanOrEqual(j1!.y + j1!.h);
    expect(u1!.x).toBeGreaterThan(j1!.x + j1!.w);
    // J2 carries +3V3 made by U1: an output, in a column at the right edge
    expect(j2!.x).toBeGreaterThan(u1!.x + u1!.w);
  });

  it('draws output connectors mirrored, pins facing the circuit', () => {
    const k = new Kernel();
    k.transact({ summary: 'in and out', ops: [
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J2' },
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J3' },
      { op: 'add_part', part: 'ams:AMS1117-3.3', refdes: 'U1' },
      { op: 'connect', pins: ['J1.1', 'U1.VIN'], net: '+5V' },
      { op: 'connect', pins: ['J2.1', 'J3.1', 'U1.VOUT'], net: '+3V3' },
      { op: 'connect', pins: ['J1.2', 'J2.2', 'J3.2', 'U1.GND'], net: 'GND' },
    ] });
    const pinsOf = (r: string) => sym(k, r).pins.map((p) => p.side);
    expect(pinsOf('J1')).toEqual(['right', 'right']);
    expect(pinsOf('J2')).toEqual(['left', 'left']);
    // its name sits on the free right side, away from the supply symbols on its pins
    expect(sym(k, 'J2').refPos.anchor).toBe('start');
    expect(sym(k, 'J2').refPos.x).toBeGreaterThan(sym(k, 'J2').pins[0]!.x);
    // several outputs stack in the right column
    expect(sym(k, 'J3').bbox.x).toBe(sym(k, 'J2').bbox.x);
    expect(sym(k, 'J3').bbox.y).toBeGreaterThan(sym(k, 'J2').bbox.y);
  });
});
