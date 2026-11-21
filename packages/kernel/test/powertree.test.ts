import { describe, expect, it } from 'vitest';
import type { Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

interface Rail {
  net: string;
  voltage: number | 'unknown';
  source: { kind: string; ref?: string; regulator?: string; from?: string };
  through?: { ref: string; category: string; from: string }[];
  feeds?: string[];
  supplies?: string[];
  loads?: { pin: string; a: number }[];
  current: { max_a: number | 'unknown'; basis: string; loads_a?: number; feeds_a?: number | 'unknown'; budget: string };
  dissipation?: { ref: string; watts?: number; limit_w?: number; package?: string; status: string; missing?: string };
}
const tree = (k: Kernel) => k.query({ op: 'get_power_tree' }) as { rails: Rail[]; note?: string };
const rail = (k: Kernel, net: string) => tree(k).rails.find((r) => r.net === net)!;

function build(ops: Transaction['ops']): Kernel {
  const k = new Kernel();
  const r = k.transact({ summary: 'power', ops });
  expect(r.status, JSON.stringify(r)).toBe('ok');
  return k;
}

/** 5 V in from J1, an MCP1700 (SOT-23) to 3.3 V, a 3.3 V load (U2's supply pin) and R1 from +3V3 to +3V3A. */
const ldoBoard = (opts: { amps?: number } = {}) =>
  build([
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
    { op: 'add_part', part: 'microchip:MCP1700T-3302E/TT', refdes: 'U1' },
    { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10uF', voltage: '16V' } },
    { op: 'add_part', part: 'generic:C', refdes: 'C2', params: { capacitance: '10uF', voltage: '10V' } },
    { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10' } },
    { op: 'add_part', part: 'generic:C', refdes: 'C3', params: { capacitance: '1uF', voltage: '10V' } },
    { op: 'connect', pins: ['J1.1', 'U1.VIN', 'C1.1'], net: '+5V' },
    { op: 'connect', pins: ['J1.2', 'U1.GND', 'C1.2', 'C2.2', 'C3.2'], net: 'GND' },
    { op: 'connect', pins: ['U1.VOUT', 'C2.1', 'R1.1'], net: '+3V3' },
    { op: 'connect', pins: ['R1.2', 'C3.1'], net: '+3V3A' },
    { op: 'set_net', net: '+5V', external: true, voltage: 5 },
    { op: 'set_net', net: '+3V3', voltage: 3.3, ...(opts.amps !== undefined ? { max_current: opts.amps } : {}), loads: [{ pin: 'C2.1', amps: 0.1 }] },
    { op: 'set_net', net: '+3V3A', voltage: 3.3 },
  ]);

describe('get_power_tree', () => {
  it('shows the connector feeding 5 V, the LDO feeding 3.3 V with its load and its dissipation against the package', () => {
    const k = ldoBoard({ amps: 0.5 });
    const in5 = rail(k, '+5V');
    expect(in5).toMatchObject({ voltage: 5, source: { kind: 'connector', ref: 'J1' }, feeds: ['+3V3'] });
    const v33 = rail(k, '+3V3');
    expect(v33).toMatchObject({
      voltage: 3.3,
      source: { kind: 'regulator', ref: 'U1', regulator: 'linear', from: '+5V' },
      loads: [{ pin: 'C2.1', a: 0.1 }],
      current: { max_a: 0.5, basis: 'max_current', loads_a: 0.1 },
      dissipation: { ref: 'U1', watts: 0.85, limit_w: 0.29, package: 'SOT-23', status: 'error' },
    });
    // the same numbers SEM.LDO_DISSIPATION reports
    const f = k.state().diagnostics.find((x) => x.code === 'SEM.LDO_DISSIPATION')!;
    expect(f.severity).toBe('error');
    expect(f.message).toContain('0.85 W');
    expect(tree(k).rails.map((r) => r.net)).not.toContain('GND');
  });

  it('shows a series part between two rails, and the rail behind it as fed through it', () => {
    const k = ldoBoard({ amps: 0.5 });
    expect(rail(k, '+3V3').feeds).toContain('+3V3A');
    expect(rail(k, '+3V3A')).toMatchObject({
      source: { kind: 'regulator', ref: 'U1' },
      through: [{ ref: 'R1', category: 'resistor', from: '+3V3' }],
    });
    expect(rail(k, '+3V3A').dissipation).toBeUndefined();
  });

  it('says unknown for a rail without max_current or loads, never 0 or fine', () => {
    const k = ldoBoard();
    const a = rail(k, '+3V3A');
    expect(a.current).toMatchObject({ max_a: 'unknown', basis: 'unknown', budget: 'unknown' });
    // +3V3 has only its loads: their sum is its current, the budget is not known without max_current
    expect(rail(k, '+3V3').current).toMatchObject({ max_a: 0.1, basis: 'loads', budget: 'unknown' });
    expect(rail(k, '+5V').current).toMatchObject({ max_a: 'unknown', budget: 'unknown' });
  });

  it('gives a buck-fed rail its regulator through the inductor, and no dissipation entry', () => {
    const k = new Kernel();
    expect(k.transact(buckTransaction()).status).toBe('ok');
    const r = rail(k, '+3V3');
    expect(r).toMatchObject({ source: { kind: 'regulator', ref: 'U1', regulator: 'switching', from: '+12V' }, through: [{ ref: 'L1', category: 'inductor', from: 'SW' }] });
    expect(r.dissipation).toBeUndefined();
    expect(rail(k, '+12V')).toMatchObject({ source: { kind: 'connector', ref: 'J1' }, current: { feeds_a: 'unknown' } });
  });

  it('returns an empty tree for a board with no power nets', () => {
    const k = build([
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '1k' } },
      { op: 'connect', pins: ['R1.2', 'R2.1'], net: 'MID' },
    ]);
    expect(tree(k).rails).toEqual([]);
    expect(tree(new Kernel()).rails).toEqual([]);
  });

  it('adds what the rails it feeds draw through linear parts to the budget', () => {
    const k = ldoBoard({ amps: 0.5 });
    k.transact({ summary: 'in', ops: [{ op: 'set_net', net: '+5V', max_current: 0.4 }, { op: 'set_net', net: '+3V3A', max_current: 0.05 }] });
    // +5V feeds the LDO's 0.5 A, over its 0.4 A
    expect(rail(k, '+5V').current).toMatchObject({ max_a: 0.4, feeds_a: 0.5, budget: 'over' });
    // +3V3: 0.1 A of loads + 0.05 A through R1, within 0.5 A
    expect(rail(k, '+3V3').current).toMatchObject({ loads_a: 0.1, feeds_a: 0.05, budget: 'ok' });
  });
});
