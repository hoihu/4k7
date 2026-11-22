import { describe, expect, it } from 'vitest';
import type { Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

/**
 * The bring-up sheet (Kernel.bringUp, for the design document): the rails in power-up order, the
 * voltage to expect, the test point to probe, the bench supply's current limit. See docs/design/layout.md §4.
 */
function build(ops: Transaction['ops']): Kernel {
  const k = new Kernel();
  const r = k.transact({ summary: 'power', ops });
  expect(r.status, JSON.stringify(r)).toBe('ok');
  return k;
}

/** 5 V in on J1, an MCP1700 to 3.3 V with 100 mA of load stated (or none). */
const ldoBoard = (opts: { load?: boolean; tps?: string[] } = {}) =>
  build([
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
    { op: 'add_part', part: 'microchip:MCP1700T-3302E/TT', refdes: 'U1' },
    { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10uF', voltage: '16V' } },
    { op: 'add_part', part: 'generic:C', refdes: 'C2', params: { capacitance: '10uF', voltage: '10V' } },
    { op: 'connect', pins: ['J1.1', 'U1.VIN', 'C1.1'], net: '+5V' },
    { op: 'connect', pins: ['J1.2', 'U1.GND', 'C1.2', 'C2.2'], net: 'GND' },
    { op: 'connect', pins: ['U1.VOUT', 'C2.1'], net: '+3V3' },
    { op: 'set_net', net: '+5V', external: true, voltage: 5 },
    { op: 'set_net', net: '+3V3', voltage: 3.3, ...(opts.load === false ? {} : { loads: [{ pin: 'C2.1', amps: 0.1 }] }) },
    ...(opts.tps ? [{ op: 'add_test_points' as const, nets: opts.tps }] : []),
  ]);

describe('bring-up sheet', () => {
  it('lists the input rail before the regulated one, with their voltages, sources and test points', () => {
    const plan = ldoBoard({ tps: ['rails'] }).bringUp();
    expect(plan.rails.map((r) => r.net)).toEqual(['+5V', '+3V3']);
    const [in5, v33] = plan.rails;
    expect(in5).toMatchObject({ voltage: 5, input: true, source: 'J1 (connector)', testPoints: [{ label: 'TP_+5V' }] });
    expect(v33).toMatchObject({ voltage: 3.3, input: false, source: 'U1 (linear regulator from +5V)', testPoints: [{ label: 'TP_+3V3' }] });
    expect(in5!.testPoints[0]!.ref).toMatch(/^TP\d+$/);
    expect(v33!.testPoints[0]!.ref).not.toBe(in5!.testPoints[0]!.ref);
    expect(in5!.probeAt).toBeUndefined();
    // the steps: the input powered first, then the regulated rail checked at its test point
    const power = plan.steps.findIndex((s) => s.startsWith('Power +5V'));
    const check = plan.steps.findIndex((s) => s.startsWith('Check +3V3'));
    expect(power).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(power);
    expect(plan.steps[check]).toContain(`${v33!.testPoints[0]!.ref} (TP_+3V3)`);
  });

  it('says where to probe a rail without a test point', () => {
    const plan = ldoBoard({ tps: ['+5V'] }).bringUp();
    const v33 = plan.rails.find((r) => r.net === '+3V3')!;
    expect(v33.testPoints).toEqual([]);
    expect(v33.probeAt).toBe('U1.VOUT');
    expect(plan.steps.join('\n')).toContain('at U1.VOUT (no test point)');
  });

  it('sets the current limit from the loads with the margin, the linear regulator passing them', () => {
    const in5 = ldoBoard().bringUp().rails[0]!;
    // 100 mA on +3V3 passes through the LDO: 1.5 × 0.1 A
    expect(in5.supply).toEqual({ draw_a: 0.1, basis: 'loads', limit_a: 0.15 });
  });

  it('says unknown when the current is not known, never a number', () => {
    const plan = ldoBoard({ load: false }).bringUp();
    expect(plan.rails[0]!.supply).toEqual({ draw_a: 'unknown', basis: 'unknown', limit_a: 'unknown' });
    expect(plan.steps.find((s) => s.startsWith('Power +5V'))).toMatch(/current limit unknown: start low/);
  });

  it('turns a switching regulator\'s output current into its input current', () => {
    const k = new Kernel();
    expect(k.transact(buckTransaction()).status).toBe('ok');
    const plan = k.bringUp();
    expect(plan.rails.map((r) => r.net)).toEqual(['+12V', '+3V3']);
    expect(plan.rails[1]!.source).toBe('U1 (switching regulator from +12V), through L1');
    // +3V3's max_current 2 A at 3.3 V from 12 V at 80 %: 0.6875 A, the limit 1.5 × that rounded up to 10 mA
    const s = plan.rails[0]!.supply!;
    expect(s).toMatchObject({ basis: 'max_current', limit_a: 1.04 });
    expect(s.draw_a).toBeCloseTo(0.6875, 2);
  });

  it('has nothing to bring up without supply rails', () => {
    const plan = build([{ op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } }]).bringUp();
    expect(plan.rails).toEqual([]);
    expect(plan.note).toMatch(/No supply rails/);
  });
});
