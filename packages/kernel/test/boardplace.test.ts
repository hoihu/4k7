import { describe, expect, it } from 'vitest';
import type { Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buck, twoBoards } from './fixtures.ts';

// A board placed by hand in the assembly (set_board placement3d): a cable's board where it really goes. See docs/design/multi-board.md §6.
const ok = (k: Kernel, ops: Transaction['ops']) => {
  const r = k.transact({ summary: 'x', ops });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
};
const refused = (k: Kernel, ops: Transaction['ops']) => {
  const r = k.transact({ summary: 'x', ops });
  expect(r.status).toBe('rejected');
  k.reject();
  return r.rejection!;
};
const cabled = () => {
  const k = twoBoards();
  ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'cable' }]);
  return k;
};
const FRONT = { x: 10, y: -40, z: 5, rot: 90, flipped: false };
const asm = (k: Kernel) => k.diagnostics().filter((x) => x.code.startsWith('ASM.'));

describe('a board placed by hand in the assembly', () => {
  it('stands where set_board placement3d puts it, said to be placed by hand', () => {
    const k = cabled();
    ok(k, [{ op: 'set_board', board: 'LED board', placement3d: FRONT }]);
    const [main, led] = k.assembly();
    expect(main).toMatchObject({ x: 0, y: 0, z: 0, rot: 0, flipped: false, by: 'the first board' });
    expect(led).toMatchObject({ ...FRONT, by: 'placed (placement3d)' });
    const answer = k.query({ op: 'get_board' }) as { boards: { assembly: object }[] };
    expect(answer.boards[1]!.assembly).toEqual({ ...FRONT, by: 'placed (placement3d)' });
  });

  it('keeps the place through other settings, takes it back with null, and undo brings it back', () => {
    const k = cabled();
    const beside = k.assembly()[1]!;
    ok(k, [{ op: 'set_board', board: 'LED board', placement3d: FRONT }]);
    ok(k, [{ op: 'set_board', board: 'LED board', name: 'Front panel' }]);
    expect(k.assembly()[1]).toMatchObject({ ...FRONT, name: 'Front panel' });
    ok(k, [{ op: 'set_board', board: 'Front panel', placement3d: null }]);
    expect(k.assembly()[1]).toEqual({ ...beside, name: 'Front panel' });
    k.undo();
    expect(k.assembly()[1]).toMatchObject({ ...FRONT, by: 'placed (placement3d)' });
    k.redo();
    expect(k.assembly()[1]!.by).toMatch(/beside/);
  });

  it('takes a board stacked on it along, and refuses a place for that one', () => {
    const k = cabled();
    ok(k, [
      { op: 'add_sheet', name: 'Aux' },
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J4', sheet: 'LED' },
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J5', sheet: 'Aux' },
      { op: 'connect', pins: ['J4.1', 'J5.1', 'J3.1'] },
      { op: 'connect', pins: ['J4.2', 'J5.2', 'J3.2'] },
      { op: 'add_board', name: 'Aux board', sheets: ['Aux'] },
      { op: 'mate', a: 'J4', b: 'J5', kind: 'stack', height_mm: 11 },
    ]);
    expect(k.assembly()[2]!.by).toMatch(/beside/);
    ok(k, [{ op: 'set_board', board: 'LED board', placement3d: FRONT }]);
    const [, led, aux] = k.assembly();
    expect(aux!.by).toBe('stacked on J4 ↔ J5');
    // J5's pad 1 lands on J4's pad 1 where the LED board stands
    const pad = (p: typeof led, ref: string) => {
      const q = k.boardPlacement(p!.board).parts.find((x) => x.refdes === ref)!.pads.find((x) => x.number === '1')!;
      const [c, n] = [Math.cos((p!.rot * Math.PI) / 180), Math.sin((p!.rot * Math.PI) / 180)];
      const u = p!.flipped ? -q.x : q.x;
      return [c * u - n * q.y + p!.x, n * u + c * q.y + p!.y];
    };
    const [a, b] = [pad(led, 'J4'), pad(aux, 'J5')];
    expect(b[0]).toBeCloseTo(a[0]!, 3);
    expect(b[1]).toBeCloseTo(a[1]!, 3);
    expect(aux!.z).toBeCloseTo(FRONT.z + 11, 6);
    expect(refused(k, [{ op: 'set_board', board: 'Aux board', placement3d: FRONT }]).message).toMatch(/J4 ↔ J5.*LED board/);
  });

  it('refuses it for the first board: it is the frame', () => {
    const r = refused(cabled(), [{ op: 'set_board', board: 'Main', placement3d: FRONT }]);
    expect(r.code).toBe('INVALID_OP');
    expect(r.message).toMatch(/first board/);
  });

  it('refuses it for a board a stack mate places', () => {
    const k = twoBoards();
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'stack', height_mm: 11 }]);
    const before = k.assembly();
    const r = refused(k, [{ op: 'set_board', board: 'LED board', placement3d: FRONT }]);
    expect(r.code).toBe('INVALID_OP');
    expect(r.message).toMatch(/stack/);
    expect(r.message).toMatch(/J2 ↔ J3/);
    expect(k.assembly()).toEqual(before);
  });

  it('refuses numbers that are not finite', () => {
    const r = refused(cabled(), [{ op: 'set_board', board: 'LED board', placement3d: { ...FRONT, z: Number.POSITIVE_INFINITY } }]);
    expect(r.message).toMatch(/placement3d|finite|number/i);
  });

  it('checks the hand place for collisions (ASM.COLLIDES), and beside the others it does not', () => {
    const k = cabled();
    ok(k, [
      { op: 'add_part', part: 'generic:C', refdes: 'C9', params: { capacitance: '100uF', voltage: '25V', package: 'RADIAL-D8-P3.5-H12' } },
      { op: 'place', ref: 'C9', x_mm: 5, y_mm: 5, lock: true },
    ]);
    expect(asm(k)).toEqual([]);
    // the LED board 5 mm over the main board's top left, where the 12 mm C9 stands
    ok(k, [{ op: 'set_board', board: 'LED board', placement3d: { x: 0, y: 0, z: 5, rot: 0, flipped: false } }]);
    const found = asm(k);
    const pcb = found.find((x) => x.code === 'ASM.COLLIDES' && x.entities.includes('C9') && /PCB of LED board/.test(x.message))!;
    expect(pcb.severity).toBe('error');
    expect(pcb.message).toMatch(/placement3d/);
    // high enough: nothing
    ok(k, [{ op: 'set_board', board: 'LED board', placement3d: { x: 0, y: 0, z: 20, rot: 0, flipped: false } }]);
    expect(asm(k)).toEqual([]);
  });
});

describe('the assembly without a hand place: as before', () => {
  it('a single board', () => {
    const k = buck();
    expect(k.assembly()).toEqual([{ board: 'b_1', name: 'Main', x: 0, y: 0, z: 0, rot: 0, flipped: false, by: 'the first board' }]);
  });

  it('a board beside, and a stack', () => {
    const k = twoBoards();
    const first = { board: 'b_1', name: 'Main', x: 0, y: 0, z: 0, rot: 0, flipped: false, by: 'the first board' };
    expect(k.assembly()).toEqual([first, { board: 'b_2', name: 'LED board', x: 32, y: 0, z: 0, rot: 0, flipped: false, by: 'beside the others (no stack mate places it)' }]);
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'stack', height_mm: 11 }]);
    expect(k.assembly()).toEqual([first, { board: 'b_2', name: 'LED board', x: 15.4, y: 0, z: 11, rot: 0, flipped: true, by: 'stacked on J2 ↔ J3', height_mm: 11 }]);
  });
});
