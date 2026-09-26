import { describe, expect, it } from 'vitest';
import { Kernel } from '../src/index.ts';

const sym = (k: Kernel, r: string) => k.state().view.sheets[0]!.symbols.find((s) => s.refdes === r)!;

describe('connectors', () => {
  it('stack in one column, one below the other, in refdes order', () => {
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
    // same column
    expect(j2!.x).toBe(j1!.x);
    expect(j3!.x).toBe(j1!.x);
    // below each other, without overlapping
    expect(j2!.y).toBeGreaterThanOrEqual(j1!.y + j1!.h);
    expect(j3!.y).toBeGreaterThanOrEqual(j2!.y + j2!.h);
    // the rest of the circuit continues to the right of the column
    expect(u1!.x).toBeGreaterThan(j1!.x + j1!.w);
  });
});
