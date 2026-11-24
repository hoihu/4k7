import { describe, expect, it } from 'vitest';
import { Kernel } from '@4k7/kernel';
import type { Transaction } from '@4k7/schema';
import { onShownBoard } from '../src/lib/shownBoard.ts';

/** Two boards, a part on each, both at JLCPCB's 2-layer tier. */
function twoBoards(): Kernel {
  const k = new Kernel();
  const ops: Transaction['ops'] = [
    { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
    { op: 'add_sheet', name: 'LED' },
    { op: 'add_part', part: 'generic:LED', refdes: 'D1', sheet: 'LED' },
    { op: 'add_board', name: 'LED board', sheets: ['LED'] },
    { op: 'set_fab_profile', preset: 'jlcpcb/2l-1oz' },
  ];
  const r = k.transact({ summary: 'two boards', ops });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
  return k;
}

const fabIds = (k: Kernel) => {
  const d = k.draftDesign();
  return [d.board?.fab?.id, d.boards?.b_2?.settings?.fab?.id];
};

/** What the manufacturer picker sends, through the same mapping as the app's userEdit, with board b_1 shown. */
const pick = (k: Kernel, ops: unknown[]) => k.transact({ summary: 'Manufacturer', ops: onShownBoard(ops, k.boardList().length, 'b_1') as Transaction['ops'] });

describe('the shown board on a design of several boards', () => {
  it('adds the shown board to a board edit without one, and leaves one board alone', () => {
    const drag = { op: 'place', ref: 'R1', x_mm: 5, y_mm: 5 };
    const rule = { op: 'set_board', width_mm: 30 };
    expect(onShownBoard([drag, rule], 2, 'b_2')).toEqual([{ ...drag, board: 'b_2' }, { ...rule, board: 'b_2' }]);
    expect(onShownBoard([{ ...rule, board: 'b_1' }], 2, 'b_2')).toEqual([{ ...rule, board: 'b_1' }]);
    expect(onShownBoard([drag, rule], 1, 'b_1')).toEqual([drag, rule]);
  });

  it('leaves set_fab_profile without board, so the picker sets every board', () => {
    expect(onShownBoard([{ op: 'set_fab_profile', preset: 'pcbway' }], 2, 'b_1')).toEqual([{ op: 'set_fab_profile', preset: 'pcbway' }]);
    expect(onShownBoard([{ op: 'set_fab_profile', none: true }], 2, 'b_1')).toEqual([{ op: 'set_fab_profile', none: true }]);
  });

  it('changes the house of every board from the picker', () => {
    const k = twoBoards();
    const r = pick(k, [{ op: 'set_fab_profile', preset: 'pcbway' }]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const d = k.draftDesign();
    expect([d.board?.fab?.house, d.boards?.b_2?.settings?.fab?.house]).toEqual(['PCBWay', 'PCBWay']);
  });

  it('sets another tier of the house on every board from the picker, and a board its own tier after', () => {
    const k = twoBoards();
    expect(pick(k, [{ op: 'set_fab_profile', preset: 'jlcpcb/2l-2oz' }]).status).toBe('ok');
    expect(fabIds(k)).toEqual(['jlcpcb/2l-2oz', 'jlcpcb/2l-2oz']);
    const one = pick(k, [{ op: 'set_fab_profile', board: 'LED board', preset: 'jlcpcb/2l-1oz' }]);
    expect(one.status, JSON.stringify(one.rejection)).toBe('ok');
    expect(fabIds(k)).toEqual(['jlcpcb/2l-2oz', 'jlcpcb/2l-1oz']);
  });
});
