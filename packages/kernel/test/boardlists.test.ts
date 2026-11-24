import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EditOp, QueryOp, SetBoardOp } from '@4k7/schema';
import { BOARD_OPS } from '../src/apply.ts';
import { twoBoards } from './fixtures.ts';

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
const DESIGN_WIDE_EDITS_NAMING_A_BOARD = [
  'add_waiver',
  'assign_board',
  // optional board the copied parts go on (default: the sheet's board); the copy itself is design-wide
  'import_block',
  'remove_board',
  'set_fab_profile',
  // optional board for track_mm, this net's width on that one board; the net itself is design-wide
  'set_net',
];

/** The query ops Kernel.query reads on one board (its `onBoard` test). */
const BOARD_QUERIES = ['get_board', 'get_copper', 'get_current_map', 'get_fab_profiles', 'suggest_moves', 'try_placements'];

/**
 * The board queries that, without board, answer for every board (boards: one entry each) rather
 * than inferring one. The others infer their board as edits do (boardFor): from the parts they
 * name, else from nets on one board only; else BOARD_AMBIGUOUS.
 */
const EVERY_BOARD_WHEN_UNNAMED = ['get_board', 'get_fab_profiles'];

/**
 * The least each board query needs to parse, so the kernel gets as far as resolving its board. They
 * name nothing that settles the board (X9 is no part), so without board they must be refused.
 */
const QUERY_ARGS: Record<string, Record<string, unknown>> = {
  get_board: {},
  get_copper: {},
  get_current_map: {},
  get_fab_profiles: {},
  suggest_moves: {},
  try_placements: { candidates: [{ parts: [{ ref: 'X9', x_mm: 10, y_mm: 10 }] }], explore: false },
};

/** Arguments that name something only on the second board (LED board), from which the board is inferred. */
const ON_SECOND_BOARD: Record<string, Record<string, unknown>> = {
  get_board: { drc: { ref: 'R4' } },
  get_copper: { nets: ['LED_A'] },
  get_current_map: { nets: ['LED_A'] },
  get_fab_profiles: {},
  suggest_moves: { parts: ['R4'] },
  try_placements: { candidates: [{ parts: [{ ref: 'J3', x_mm: 5, y_mm: 5 }] }], explore: false },
};

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
      const none = k.query({ op, ...args }) as { error?: string; boards?: { board: string }[] };
      if (EVERY_BOARD_WHEN_UNNAMED.includes(op)) {
        // answers for each board when none is named, rather than reading the first
        expect(none.error, op).toBeUndefined();
        expect(none.boards?.map((b) => b.board), op).toEqual(['Main', 'LED board']);
        continue;
      }
      // and asks which board when nothing settles it, rather than reading the first
      expect(none.error, op).toMatch(/has 2 boards: say which with board/);
    }
  });

  it('on a design of two boards, a board query without board infers it from what it names, not the first board', () => {
    const k = twoBoards();
    // copper on the second board only, so its answers differ from the first board's
    expect(k.transact({ summary: 'route', ops: [{ op: 'route', board: 'LED board' }] }).status).toBe('ok');
    for (const op of withBoardRef(QueryOp)) {
      const args = ON_SECOND_BOARD[op];
      expect(args, `add arguments of ${op} naming something on the LED board to ON_SECOND_BOARD`).toBeDefined();
      const inferred = k.query({ op, ...args }) as { error?: string; boards?: unknown[] };
      expect(inferred.error, op).toBeUndefined();
      if (EVERY_BOARD_WHEN_UNNAMED.includes(op)) {
        expect(inferred.boards, op).toHaveLength(2);
        continue;
      }
      expect(inferred, op).toEqual(k.query({ op, ...args, board: 'LED board' }));
      expect(inferred, op).not.toEqual(k.query({ op, ...args, board: 'Main' }));
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
