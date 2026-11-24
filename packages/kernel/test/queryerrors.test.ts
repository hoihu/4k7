import { describe, expect, it } from 'vitest';
import { buck, twoBoards } from './fixtures.ts';

// A query's error shares one shape, { error, code?, candidates? }, with the codes of edits. The keys
// errors had before (boards, nets, projects) stay for one release. See docs/design/ops-api.md §3.
type QErr = { error: string; code?: string; candidates?: string[]; boards?: string[]; nets?: string[]; projects?: string[] };
const q = (k: ReturnType<typeof buck>, op: unknown, ctx?: Parameters<ReturnType<typeof buck>['query']>[1]) => k.query(op, ctx) as QErr;

describe('query errors', () => {
  it('an unknown board, with several: BOARD_UNKNOWN, the boards as candidates, boards kept', () => {
    const out = q(twoBoards(), { op: 'get_board', board: 'LED bord' });
    expect(out.error).toBe('No board "LED bord".');
    expect(out.code).toBe('BOARD_UNKNOWN');
    expect(out.candidates).toEqual(['LED board', 'Main']);
    expect(out.boards).toEqual(['Main', 'LED board']);
    // every board query takes the same check
    expect(q(twoBoards(), { op: 'get_copper', board: 'Nope' })).toMatchObject({ code: 'BOARD_UNKNOWN', boards: ['Main', 'LED board'] });
  });

  it('an unknown board on a design of one board', () => {
    const out = q(buck(), { op: 'get_board', board: 'Other' });
    expect(out).toMatchObject({ code: 'BOARD_UNKNOWN', candidates: ['Main'], boards: ['Main'] });
  });

  it('a board query that names no board, with several: BOARD_AMBIGUOUS, boards kept', () => {
    const out = q(twoBoards(), { op: 'get_copper' });
    expect(out.error).toBe('The design has 2 boards: say which with board.');
    expect(out.code).toBe('BOARD_AMBIGUOUS');
    expect(out.candidates).toEqual(['Main', 'LED board']);
    expect(out.boards).toEqual(['Main', 'LED board']);
    // get_board without board answers every board: no error
    expect((q(twoBoards(), { op: 'get_board' }) as { error?: string }).error).toBeUndefined();
  });

  it('an unknown net: NET_UNKNOWN, the closest nets as candidates, nets kept', () => {
    const k = twoBoards();
    const out = q(k, { op: 'get_net', net: 'LED_B' });
    expect(out.error).toBe('No net LED_B');
    expect(out.code).toBe('NET_UNKNOWN');
    expect(out.candidates![0]).toBe('LED_A'); // a net of the second board
    expect(out.candidates!.length).toBeLessThanOrEqual(5);
    expect(out.nets).toContain('LED_A');
    expect(out.nets).toContain('+12V');
    // a net that is there still answers, and its boards field is an answer, not an error
    expect(q(k, { op: 'get_net', net: '+3V3' })).toMatchObject({ boards: ['Main', 'LED board'] });
  });

  it('an unknown component: REF_UNKNOWN with the closest refdes', () => {
    const out = q(twoBoards(), { op: 'get_component', ref: 'D3' });
    expect(out.error).toBe('No component D3');
    expect(out.code).toBe('REF_UNKNOWN');
    expect(out.candidates).toContain('D2'); // on the LED board
    expect(out.candidates!.length).toBeLessThanOrEqual(5);
  });

  it('an unknown part: PART_UNKNOWN, candidates as before', () => {
    const out = q(buck(), { op: 'get_part', id: 'generic:Rx' });
    expect(out.code).toBe('PART_UNKNOWN');
    expect(Array.isArray(out.candidates)).toBe(true);
  });

  it('suggest_moves on a part not on the board: REF_UNKNOWN with the board\'s parts', () => {
    const k = twoBoards();
    expect(k.transact({ summary: 'route', ops: [{ op: 'route', board: 'LED board' }] }).status).toBe('ok');
    const out = q(k, { op: 'suggest_moves', board: 'LED board', parts: ['R9', 'U1'] }); // U1 is on Main
    expect(out.error).toBe('Not on the board: R9, U1.');
    expect(out.code).toBe('REF_UNKNOWN');
    expect(out.candidates!.length).toBeGreaterThan(0);
    expect(out.candidates!.every((r) => ['J3', 'R4', 'D2'].includes(r))).toBe(true);
  });

  it('list_blocks of an unknown project: PROJECT_UNKNOWN, projects kept', () => {
    const k = buck();
    const out = q(k, { op: 'list_blocks', project: 'lamq' }, { sources: { projects: ['lamp', 'buck'], files: { lamp: k.exportDesign(), buck: k.exportDesign() } } });
    expect(out.code).toBe('PROJECT_UNKNOWN');
    expect(out.candidates![0]).toBe('lamp');
    expect(out.projects).toEqual(['buck', 'lamp']);
  });
});
