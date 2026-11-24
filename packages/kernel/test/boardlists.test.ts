import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EditOp, QueryOp, SetBoardOp, type Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { BOARD_OPS } from '../src/apply.ts';
import { buckTransaction } from './fixtures.ts';

/**
 * Which ops work on one board is kept in three places by hand: the schema (the ops with a `board`
 * field), BOARD_OPS in apply.ts (the edit ops opBoard focuses on one board) and the `onBoard` test in
 * Kernel.query (kernel.ts). An op left out of the kernel's lists silently works on the first board,
 * so they are compared here. See docs/design/multi-board.md.
 */

// boardRef is one schema instance shared by every per-board op; set_board's field is that instance
const boardRef = SetBoardOp.shape.board;

type Shape = { op: { value: string }; board?: unknown };
const shapes = (u: { options: readonly unknown[] }) => u.options.map((o) => (o as { shape: Shape }).shape);
const withBoardRef = (u: { options: readonly unknown[] }) => shapes(u).filter((s) => s.board === boardRef).map((s) => s.op.value).sort();
const withOtherBoard = (u: { options: readonly unknown[] }) => shapes(u).filter((s) => s.board !== undefined && s.board !== boardRef).map((s) => s.op.value).sort();

/**
 * Edit ops that name a board for an action on the whole design (take the board away, assign sheets
 * or parts to it, waive a finding on it, set its fab house/tier), not for work on one board's copper
 * or placement. They have their own `board` field, not boardRef, and are not in BOARD_OPS.
 */
const DESIGN_WIDE_EDITS_NAMING_A_BOARD = ['add_waiver', 'assign_board', 'remove_board', 'set_fab_profile'];

/** The query ops Kernel.query reads on one board (its `onBoard` test). */
const BOARD_QUERIES = ['get_board', 'get_copper', 'get_current_map', 'suggest_moves', 'try_placements'];

/** The least each board query needs to parse, so the kernel gets as far as resolving its board. */
const QUERY_ARGS: Record<string, Record<string, unknown>> = {
  get_board: {},
  get_copper: {},
  get_current_map: {},
  suggest_moves: {},
  try_placements: { candidates: [{ parts: [{ ref: 'U1', x_mm: 10, y_mm: 10 }] }] },
};

/** The buck on the main board and a second board with an LED (as multiboard.test.ts). */
function twoBoards(): Kernel {
  const k = new Kernel();
  expect(k.transact(buckTransaction()).status).toBe('ok');
  const ops: Transaction['ops'] = [
    { op: 'add_sheet', name: 'LED' },
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J3', sheet: 'LED' },
    { op: 'add_part', part: 'generic:R', refdes: 'R4', params: { resistance: '1k' }, sheet: 'LED' },
    { op: 'add_part', part: 'generic:LED', refdes: 'D2', sheet: 'LED' },
    { op: 'connect', pins: ['J3.1', 'R4.1'], net: 'LED_V' },
    { op: 'connect', pins: ['R4.2', 'D2.A'], net: 'LED_A' },
    { op: 'connect', pins: ['J3.2', 'D2.K'], net: 'LED_GND' },
    { op: 'add_board', name: 'LED board', sheets: ['LED'] },
  ];
  const r = k.transact({ summary: 'LED board', ops });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
  return k;
}

describe('the per-board op lists agree', () => {
  it('BOARD_OPS is exactly the edit ops whose board field is boardRef', () => {
    expect([...BOARD_OPS].sort()).toEqual(withBoardRef(EditOp));
  });

  it('the other edit ops with a board field are the known design-wide ones', () => {
    // a new op here: give it boardRef and put it in BOARD_OPS if it works on one board's layout,
    // or add it to the list above if it only names a board for a design-wide action
    expect(withOtherBoard(EditOp)).toEqual(DESIGN_WIDE_EDITS_NAMING_A_BOARD);
    for (const op of DESIGN_WIDE_EDITS_NAMING_A_BOARD) expect(BOARD_OPS.has(op as EditOp['op'])).toBe(false);
  });

  it('the board queries are exactly the query ops whose board field is boardRef', () => {
    expect(withBoardRef(QueryOp)).toEqual(BOARD_QUERIES);
    expect(withOtherBoard(QueryOp)).toEqual([]);
  });

  it('Kernel.query\'s onBoard test names exactly the board queries', () => {
    const src = readFileSync(new URL('../src/kernel.ts', import.meta.url), 'utf8');
    const line = src.match(/const onBoard = (.*);/);
    expect(line, 'kernel.ts: the onBoard test in query moved or changed shape; update this test').not.toBeNull();
    const ops = [...line![1]!.matchAll(/q\.op === '([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(ops).toEqual(BOARD_QUERIES);
  });

  it('on a design of two boards, every board query resolves the board it names', () => {
    const k = twoBoards();
    for (const op of withBoardRef(QueryOp)) {
      const args = QUERY_ARGS[op];
      expect(args, `add the least arguments of ${op} to QUERY_ARGS`).toBeDefined();
      const bad = k.query({ op, ...args, board: 'No such board' }) as { error?: string; boards?: string[] };
      expect(bad.error, op).toBe('No board "No such board".');
      expect(bad.boards, op).toEqual(['Main', 'LED board']);
      if (op === 'get_board') continue;
      // and asks which board when none is named, rather than reading the first
      const none = k.query({ op, ...args }) as { error?: string };
      expect(none.error, op).toMatch(/has 2 boards: say which with board/);
    }
  });

  it('on a design of two boards, every per-board edit op resolves the board it names', () => {
    const k = twoBoards();
    // set_board with only a board is valid; it stands for BOARD_OPS here, whose ops all go through opBoard
    const r = k.transact({ summary: 'bad board', ops: [{ op: 'set_board', board: 'No such board' }] });
    expect(r.status).toBe('rejected');
    expect(JSON.stringify(r.rejection)).toMatch(/No such board/);
    const ok = k.transact({ summary: 'size', ops: [{ op: 'set_board', board: 'LED board', width_mm: 20, height_mm: 15 }] });
    expect(ok.status, JSON.stringify(ok.rejection)).toBe('ok');
  });
});
