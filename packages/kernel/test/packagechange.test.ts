import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@4k7/schema';
import { Kernel } from '../src/index.ts';

/** Copper findings, as get_diagnostics gives them. */
const copper = (k: Kernel) => k.diagnostics().filter((x) => x.code === 'DRC.SHORT' || x.code === 'DRC.CLEARANCE');
const plain = (ds: Diagnostic[]) => ds.map(({ code, severity, message, entities }) => ({ code, severity, message, entities }));

/**
 * A 100 nF 16 V cap in 0603 on a routed board, a via of another net 0.3 mm off its land; the copper
 * kept with the design, as the app does.
 */
function routedCap() {
  const k = new Kernel();
  const r = k.transact({
    summary: 'cap and via',
    ops: [
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
      { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '100nF', voltage: '16V' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } },
      { op: 'connect', pins: ['J1.1', 'C1.1', 'R1.1'], net: 'VIN' },
      { op: 'connect', pins: ['J1.2', 'C1.2'], net: 'GND' },
      { op: 'connect', pins: ['R1.2'], net: 'X' },
      { op: 'set_board', width_mm: 30, height_mm: 20 },
      { op: 'place', ref: 'C1', x_mm: 15, y_mm: 10, rot: 0 },
      { op: 'place', ref: 'J1', x_mm: 4, y_mm: 10, rot: 0 },
      { op: 'place', ref: 'R1', x_mm: 24, y_mm: 10, rot: 0 },
      { op: 'add_vias', kind: 'points', net: 'X', at: [{ x_mm: 15.9, y_mm: 11.05 }] },
    ],
  });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.transact({ summary: 'route', ops: [{ op: 'route' }] });
  k.accept();
  k.keepCopper(k.board().newCopper!);
  return k;
}

describe('a value that changes a part\'s package', () => {
  it('says so in the set_param result, with the copper its bigger land now meets', () => {
    const k = routedCap();
    expect(k.board().routing).toBe('done');
    expect(copper(k)).toEqual([]);
    const r = k.transact({ summary: 'rating', ops: [{ op: 'set_param', ref: 'C1', params: { voltage: '50V' } }] });
    expect(r.status).toBe('ok');
    expect(r.results?.[0]?.effect).toBe('C1: voltage=50V; package 0603 → 0805 (50V rating): its footprint on the board changes with it');
    // the 0805 land reaches to 0.03 mm of the via: the result says it, not only the next look at the board
    const land = r.introduced.filter((x) => x.code === 'DRC.CLEARANCE');
    expect(land).toEqual([expect.objectContaining({ severity: 'error', entities: expect.arrayContaining(['C1']), message: expect.stringContaining('via X') })]);
    // a dry run says the same and leaves the design as it was
    k.transact({ summary: 'back', ops: [{ op: 'set_param', ref: 'C1', params: { voltage: '16V' } }] });
    const dry = k.transact({ summary: 'rating', dry_run: true, ops: [{ op: 'set_param', ref: 'C1', params: { voltage: '50V' } }] });
    expect(plain(dry.introduced.filter((x) => x.code === 'DRC.CLEARANCE'))).toEqual(plain(land));
    expect(copper(k)).toEqual([]);
  });

  it('the checks in the same session find what a fresh load of the design finds', () => {
    const k = routedCap();
    k.transact({ summary: 'rating', ops: [{ op: 'set_param', ref: 'C1', params: { voltage: '50V' } }] });
    const same = copper(k);
    const sameBoard = k.board().diagnostics.filter((x) => x.severity === 'error');
    expect(same.some((x) => x.code === 'DRC.CLEARANCE' && x.message.includes('via X'))).toBe(true);
    k.accept();
    const fresh = new Kernel(JSON.parse(k.exportDesign()));
    expect(plain(copper(fresh))).toEqual(plain(same));
    expect(plain(fresh.board().diagnostics.filter((x) => x.severity === 'error'))).toEqual(plain(sameBoard));
  });

  it('says nothing more when the package stays', () => {
    const k = routedCap();
    const r = k.transact({ summary: 'rating', ops: [{ op: 'set_param', ref: 'C1', params: { voltage: '25V' } }] });
    expect(r.results?.[0]?.effect).toBe('C1: voltage=25V');
    expect(r.introduced).toEqual([]);
  });
});
