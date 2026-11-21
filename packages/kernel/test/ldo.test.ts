import { describe, expect, it } from 'vitest';
import { getBuiltinPart, packageThermal } from '@4k7/parts';
import type { Diagnostic, Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { runChecks } from '../src/checks.ts';
import { buckTransaction } from './fixtures.ts';

/** 5 V in from J1, a 3.3 V linear regulator (MCP1700: SOT-23-3; AMS1117: SOT-223) with its caps. */
function ldo(opts: { part?: string; amps?: number; loads?: number } = {}): Kernel {
  const k = new Kernel();
  const tx: Transaction = {
    summary: '5V to 3.3V LDO',
    ops: [
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
      { op: 'add_part', part: opts.part ?? 'microchip:MCP1700T-3302E/TT', refdes: 'U1' },
      { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10uF', voltage: '16V' } },
      { op: 'add_part', part: 'generic:C', refdes: 'C2', params: { capacitance: '10uF', voltage: '10V' } },
      { op: 'connect', pins: ['J1.1', 'U1.VIN', 'C1.1'], net: '+5V' },
      { op: 'connect', pins: ['J1.2', 'U1.GND', 'C1.2', 'C2.2'], net: 'GND' },
      { op: 'connect', pins: ['U1.VOUT', 'C2.1'], net: '+3V3' },
      { op: 'set_net', net: '+5V', external: true, voltage: 5 },
      { op: 'set_net', net: '+3V3', voltage: 3.3, ...(opts.amps !== undefined ? { max_current: opts.amps } : {}) },
      ...(opts.loads !== undefined ? ([{ op: 'set_net', net: '+3V3', loads: [{ pin: 'C2.1', amps: opts.loads }] }] as Transaction['ops']) : []),
    ],
  };
  const r = k.transact(tx);
  expect(r.status, JSON.stringify(r)).toBe('ok');
  return k;
}

const ldoFindings = (k: Kernel): Diagnostic[] => k.state().diagnostics.filter((x) => x.code === 'SEM.LDO_DISSIPATION');

describe('SEM.LDO_DISSIPATION', () => {
  it('has a conservative limit per package, by its usual names, and none for a package it does not know', () => {
    expect(packageThermal('SOT-23')).toEqual({ name: 'SOT-23', thetaJA: 340, maxW: 0.29 });
    expect(packageThermal('SOT-23-3')?.name).toBe('SOT-23');
    expect(packageThermal('sot223')?.maxW).toBe(1.11);
    expect(packageThermal('TO-252')?.name).toBe('DPAK');
    expect(packageThermal('QFN-16')).toBeNull();
    expect(packageThermal(undefined)).toBeNull();
  });

  it('is an error for a 5 V → 3.3 V LDO in SOT-23 at 500 mA, naming what it burns and what to do', () => {
    const [f, ...more] = ldoFindings(ldo({ amps: 0.5 }));
    expect(more).toEqual([]);
    expect(f).toMatchObject({ severity: 'error', entities: ['U1', 'net:+3V3'] });
    for (const s of ['U1', 'SOT-23', '+5V', '+3V3', '5 V', '3.3 V', '0.5 A', '0.85 W', '0.29 W', 'bigger package', 'SOT-223', 'buck converter', 'less current']) expect(f!.message).toContain(s);
  });

  it('says nothing at 100 mA (0.17 W), and warns between the limit and twice it', () => {
    expect(ldoFindings(ldo({ amps: 0.1 }))).toEqual([]);
    expect(ldoFindings(ldo({ amps: 0.25 }))).toMatchObject([{ severity: 'warning' }]); // 0.43 W
  });

  it('lets a SOT-223 carry 500 mA (0.85 W of 1.11 W), and warns at 1 A', () => {
    expect(ldoFindings(ldo({ part: 'ams:AMS1117-3.3', amps: 0.5 }))).toEqual([]);
    const [f] = ldoFindings(ldo({ part: 'ams:AMS1117-3.3', amps: 1 }));
    expect(f).toMatchObject({ severity: 'warning' });
    expect(f!.message).toContain('DPAK');
    expect(f!.message).not.toContain('SOT-223 sheds about');
  });

  it('uses the loads stated on the rail when it has no max_current', () => {
    expect(ldoFindings(ldo({ loads: 0.5 }))).toMatchObject([{ severity: 'error' }]);
  });

  it('says the dissipation is unknown, not fine, when the rail has no max_current', () => {
    const [f, ...more] = ldoFindings(ldo());
    expect(more).toEqual([]);
    expect(f).toMatchObject({ severity: 'info', entities: ['U1', 'net:+3V3'] });
    expect(f!.message).toContain('unknown');
    expect(f!.message).toContain('max_current');
  });

  it('says the limit is unknown for a package the table does not know', () => {
    // a card of the same regulator in a package the table lacks (as an imported part would be)
    const d = structuredClone(ldo({ amps: 0.5 }).draftDesign());
    d.parts['my:LDO'] = { ...getBuiltinPart('microchip:MCP1700T-3302E/TT')!, id: 'my:LDO', package: 'QFN-16' };
    Object.values(d.components).find((c) => c.refdes === 'U1')!.part = 'my:LDO';
    const [f] = runChecks(d).filter((x) => x.code === 'SEM.LDO_DISSIPATION');
    expect(f).toMatchObject({ severity: 'info' });
    expect(f!.message).toContain('QFN-16');
    expect(f!.message).toContain('0.85 W');
    expect(f!.message).toContain('unknown');
  });

  it('never flags a buck converter', () => {
    const k = new Kernel();
    expect(k.transact(buckTransaction()).status).toBe('ok');
    expect(ldoFindings(k)).toEqual([]);
  });
});
