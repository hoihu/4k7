import { describe, expect, it } from 'vitest';
import type { Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buck, twoBoards } from './fixtures.ts';

// ASM.CABLE_SHORT: a cable or wire mate's length_mm against how far apart its connectors stand in the assembly. See docs/design/multi-board.md §6.
const ok = (k: Kernel, ops: Transaction['ops']) => {
  const r = k.transact({ summary: 'x', ops });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
};
const short = (k: Kernel) => k.diagnostics().filter((x) => x.code === 'ASM.CABLE_SHORT');
const FAR = { x: 120, y: 0, z: 0, rot: 0, flipped: false };
/** The LED board on a J2 ↔ J3 mate (`kind`, `length_mm`), placed at `at` or left beside the others. */
const cabled = (length_mm?: number, at: typeof FAR | null = FAR, kind: 'cable' | 'wire' = 'cable') => {
  const k = twoBoards();
  ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind, ...(kind === 'wire' ? { map: [['1', '1'], ['2', '2']] } : {}), ...(length_mm ? { length_mm } : {}) }]);
  if (at) ok(k, [{ op: 'set_board', board: 'LED board', placement3d: at }]);
  return k;
};

describe('a cable too short for where its boards stand', () => {
  it('reports a 50 mm cable between boards placed 120 mm apart, with the distance in whole mm', () => {
    const found = short(cabled(50));
    expect(found).toHaveLength(1);
    const [d] = found;
    expect(d!.severity).toBe('error');
    expect(d!.entities).toEqual(['J2', 'J3']);
    expect(d!.at).toBeDefined();
    const m = /^Cable J2–J3 is 50 mm but its connectors stand (\d+) mm apart in the assembly: make it at least \1 mm \(mate length_mm\) or move "LED board" \(set_board placement3d\)\.$/.exec(d!.message);
    expect(m, d!.message).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(50);
    // further away, further apart
    const further = short(cabled(50, { ...FAR, x: 200 }))[0]!.message.match(/stand (\d+) mm/)![1];
    expect(Number(further)).toBe(Number(m![1]) + 80);
  });

  it('is quiet for a cable long enough', () => {
    expect(short(cabled(200))).toEqual([]);
  });

  it('is quiet without a length, or with the board beside the others', () => {
    expect(short(cabled(undefined))).toEqual([]);
    expect(short(cabled(50, null))).toEqual([]);
  });

  it('is quiet for a stack mate and for a single board', () => {
    const k = twoBoards();
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'stack' }]);
    expect(short(k)).toEqual([]);
    expect(short(buck())).toEqual([]);
  });

  it('checks a wire mate like a cable', () => {
    const [d] = short(cabled(50, FAR, 'wire'));
    expect(d!.message).toMatch(/^Wires J2–J3 are 50 mm but their connectors stand \d+ mm apart/);
    expect(short(cabled(200, FAR, 'wire'))).toEqual([]);
  });
});
