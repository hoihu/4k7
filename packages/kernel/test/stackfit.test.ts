import { describe, expect, it } from 'vitest';
import type { Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buck, twoBoards } from './fixtures.ts';

/** ASM.COLLIDES: a part of one stacked board runs into the other board or its parts. See docs/design/multi-board.md §6. */
describe('parts of a stack running into the other board', () => {
  const ok = (k: Kernel, ops: Transaction['ops']) => {
    const r = k.transact({ summary: 'x', ops });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  };
  const asm = (k: Kernel) => k.diagnostics().filter((x) => x.code.startsWith('ASM.'));
  /**
   * The LED board stacked on the main board by J2 ↔ J3 (turned over, over the main board's top
   * right), and a 12 mm electrolytic C9 (Ø8) on the main board at (x, y), locked.
   */
  const stack = (at: [number, number], height?: number) => {
    const k = twoBoards();
    ok(k, [
      { op: 'add_part', part: 'generic:C', refdes: 'C9', params: { capacitance: '100uF', voltage: '25V', package: 'RADIAL-D8-P3.5-H12' } },
      { op: 'connect', pins: ['C9.1', 'J2.1'] },
      { op: 'connect', pins: ['C9.2', 'J2.2'] },
      { op: 'place', ref: 'C9', x_mm: at[0], y_mm: at[1], lock: true },
      { op: 'mate', a: 'J2', b: 'J3', kind: 'stack', ...(height !== undefined ? { height_mm: height } : {}) },
    ]);
    return k;
  };
  const UNDER: [number, number] = [19, 9];
  const CLEAR: [number, number] = [5, 20];

  it('reports a 12 mm part under a board stacked at 11 mm, naming both boards and the part', () => {
    const k = stack(UNDER, 11);
    const [led] = k.assembly().slice(1);
    expect(led!.by).toBe('stacked on J2 ↔ J3');
    const found = asm(k);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((x) => x.code === 'ASM.COLLIDES' && x.severity === 'error')).toBe(true);
    const pcb = found.find((x) => x.entities.includes('C9') && /PCB/.test(x.message))!;
    expect(pcb.message).toMatch(/Main/);
    expect(pcb.message).toMatch(/LED board/);
    // C9 stands 12 mm, the LED board's underside is at 11 mm: 1 mm into it
    expect(pcb.message).toMatch(/reaches 1\.0 mm into it/);
  });

  it('reports nothing when the stack is high enough', () => {
    expect(asm(stack(UNDER, 15))).toEqual([]);
  });

  it('reports nothing for the part outside the upper board\'s outline', () => {
    const k = stack(CLEAR, 11);
    expect(k.assembly()[1]!.by).toBe('stacked on J2 ↔ J3');
    expect(asm(k)).toEqual([]);
  });

  it('never reports the mated connectors themselves', () => {
    // at 6 mm the 8.5 mm header pair overlaps itself and runs into both boards
    const k = stack(CLEAR, 6);
    expect(k.assembly()[1]!.by).toBe('stacked on J2 ↔ J3');
    expect(asm(k).flatMap((x) => x.entities).filter((e) => e === 'J2' || e === 'J3')).toEqual([]);
  });

  it('warns, not errs, where the stack height is assumed', () => {
    const k = stack(UNDER);
    expect(k.assembly()[1]!.height_assumed).toBe(true);
    const found = asm(k);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((x) => x.code === 'ASM.COLLIDES' && x.severity === 'warning')).toBe(true);
    // the taller connector's 8.5 mm: C9 reaches 3.5 mm past the LED board's underside
    expect(found.find((x) => /PCB/.test(x.message))!.message).toMatch(/reaches 3\.5 mm into it.*assumed/);
  });

  it('reports nothing for a board beside the other (no stack)', () => {
    const k = twoBoards();
    ok(k, [
      { op: 'add_part', part: 'generic:C', refdes: 'C9', params: { capacitance: '100uF', voltage: '25V', package: 'RADIAL-D8-P3.5-H12' } },
      { op: 'place', ref: 'C9', x_mm: UNDER[0], y_mm: UNDER[1], lock: true },
      { op: 'mate', a: 'J2', b: 'J3', kind: 'cable' },
    ]);
    expect(k.assembly()[1]!.by).toMatch(/beside/);
    expect(asm(k)).toEqual([]);
  });

  it('has no ASM findings on a single board', () => {
    expect(asm(buck())).toEqual([]);
  });
});
