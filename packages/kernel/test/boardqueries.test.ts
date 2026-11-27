import { describe, expect, it } from 'vitest';
import { buck, twoBoards } from './fixtures.ts';

// A board query without board infers its board as an edit does (boardFor): from the parts it names,
// else the nets it names when they are on one board only; else BOARD_AMBIGUOUS. get_board without
// board answers for every board and infers nothing. See docs/design/multi-board.md.
type QErr = { error?: string; code?: string; candidates?: string[]; boards?: unknown[] };
// the router's copper is counted (tracks, vias), not listed
type Copper = { tracks: number; vias: number };

// try_placements says how long it took (`seconds`), so two runs of the same query differ there
const timeless = (answer: unknown) => {
  const { seconds: _, ...rest } = answer as Record<string, unknown>;
  return rest;
};

function routedLed() {
  const k = twoBoards();
  const r = k.transact({ summary: 'route', ops: [{ op: 'route', board: 'LED board' }] });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  return k;
}

describe('board queries infer their board', () => {
  it('get_copper naming a net on one board answers for that board', () => {
    const k = routedLed();
    const out = k.query({ op: 'get_copper', nets: ['LED_A'] }) as QErr & Copper;
    expect(out.error).toBeUndefined();
    expect(out.tracks).toBeGreaterThan(0);
    expect(out).toEqual(k.query({ op: 'get_copper', board: 'LED board', nets: ['LED_A'] }));
    // not the first board's answer, where LED_A has no copper
    expect((k.query({ op: 'get_copper', board: 'Main', nets: ['LED_A'] }) as Copper).tracks).toBe(0);
  });

  it('get_current_map naming a net on one board answers for that board', () => {
    const k = routedLed();
    const out = k.query({ op: 'get_current_map', nets: ['LED_A'] }) as QErr;
    expect(out.error).toBeUndefined();
    expect(out).toEqual(k.query({ op: 'get_current_map', board: 'LED board', nets: ['LED_A'] }));
  });

  it('suggest_moves naming a part answers for the board of that part', () => {
    const k = routedLed();
    const out = k.query({ op: 'suggest_moves', parts: ['R4'] }) as QErr;
    expect(out.error).toBeUndefined();
    expect(out).toEqual(k.query({ op: 'suggest_moves', board: 'LED board', parts: ['R4'] }));
  });

  it('try_placements naming a part answers for the board of that part', () => {
    const k = twoBoards();
    const q = { op: 'try_placements', candidates: [{ parts: [{ ref: 'J3', x_mm: 5, y_mm: 5 }] }], explore: false };
    const out = k.query(q) as QErr;
    expect(out.error).toBeUndefined();
    expect(timeless(out)).toEqual(timeless(k.query({ ...q, board: 'LED board' })));
    expect(timeless(out)).not.toEqual(timeless(k.query({ ...q, board: 'Main' })));
  });

  it('nothing that settles the board: BOARD_AMBIGUOUS, candidates and boards kept', () => {
    const k = twoBoards();
    const none = k.query({ op: 'get_copper' }) as QErr;
    expect(none).toMatchObject({ error: 'The design has 2 boards: say which with board.', code: 'BOARD_AMBIGUOUS', candidates: ['Main', 'LED board'], boards: ['Main', 'LED board'] });
    // GND and +3V3 run on both boards
    const both = k.query({ op: 'get_copper', nets: ['GND'] }) as QErr;
    expect(both).toMatchObject({ code: 'BOARD_AMBIGUOUS', candidates: ['Main', 'LED board'], boards: ['Main', 'LED board'] });
    expect(both.error).toMatch(/names nets on several boards/);
    // parts of both boards in one query
    const parts = k.query({ op: 'try_placements', candidates: [{ parts: [{ ref: 'U1', x_mm: 5, y_mm: 5 }, { ref: 'J3', x_mm: 9, y_mm: 5 }] }] }) as QErr;
    expect(parts).toMatchObject({ code: 'BOARD_AMBIGUOUS', candidates: ['Main', 'LED board'], boards: ['Main', 'LED board'] });
    expect(parts.error).toMatch(/names parts on several boards/);
  });

  it('an unknown board is still BOARD_UNKNOWN, boards kept', () => {
    const out = twoBoards().query({ op: 'suggest_moves', board: 'LED bord', parts: ['R4'] }) as QErr;
    expect(out).toMatchObject({ error: 'No board "LED bord".', code: 'BOARD_UNKNOWN', candidates: ['LED board', 'Main'], boards: ['Main', 'LED board'] });
  });

  it('a named board is not second-guessed by the parts named', () => {
    const k = routedLed();
    // U1 is on Main: as before, the query's own check, not a board inferred from U1
    expect(k.query({ op: 'suggest_moves', board: 'LED board', parts: ['U1'] })).toMatchObject({ code: 'REF_UNKNOWN' });
  });

  it('get_board without board still answers for every board, even naming a part', () => {
    const k = twoBoards();
    for (const q of [{ op: 'get_board' }, { op: 'get_board', drc: { ref: 'R4' } }, { op: 'get_board', drc: { net: 'LED_A' } }]) {
      const out = k.query(q) as { error?: string; boards: { board: string }[] };
      expect(out.error).toBeUndefined();
      expect(out.boards.map((b) => b.board)).toEqual(['Main', 'LED board']);
    }
  });

  it('a design of one board answers without board', () => {
    const k = buck();
    expect((k.query({ op: 'get_copper' }) as QErr).error).toBeUndefined();
    expect((k.query({ op: 'get_current_map' }) as QErr).error).toBeUndefined();
    expect((k.query({ op: 'get_board' }) as { error?: string; outline?: unknown }).error).toBeUndefined();
  });
});
