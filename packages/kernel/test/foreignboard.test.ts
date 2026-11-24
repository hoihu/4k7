import { describe, expect, it } from 'vitest';
import type { EditOp } from '@4k7/schema';
import type { ImportSources, Kernel } from '../src/index.ts';
import { buck, twoBoards } from './fixtures.ts';

/**
 * get_board { project, board? }: another stored project's board as stored, read-only, answered by the
 * kernel from the projects the app read (Kernel.query's sources). See docs/design/ops-api.md §7.
 */

type Part = { refdes: string; x: number; y: number; rot: number; side: string; placed: string };
type Answer = { error?: string; code?: string; boards?: string[]; candidates?: string[]; project?: string; board?: string; outline_mm?: unknown; parts?: Part[]; routing?: unknown };

const sources = (files: Record<string, string>): ImportSources => ({ projects: Object.keys(files), files });
const ok = (k: Kernel, ops: EditOp[]) => {
  const r = k.transact({ summary: 'fixture', ops });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
};

/** The two-board fixture with R4 placed by hand on the LED board and J3 on its bottom. */
function source(): Kernel {
  const k = twoBoards();
  ok(k, [
    { op: 'place', board: 'LED board', ref: 'R4', x_mm: 6, y_mm: 4, rot: 90 },
    { op: 'place', board: 'LED board', ref: 'J3', x_mm: 14, y_mm: 6, side: 'bottom' },
  ]);
  return k;
}

const ask = (k: Kernel, files: Record<string, string>, q: object) => k.query({ op: 'get_board', ...q }, { sources: sources(files) }) as Answer;
const placement = (a: Answer) => ({ outline: a.outline_mm, parts: a.parts!.map(({ refdes, x, y, rot, side, placed }) => ({ refdes, x, y, rot, side, placed })) });

describe('get_board of another project', () => {
  it('reads a named board of a two-board project as that project shows it, into a two-board design', () => {
    const src = source();
    const target = twoBoards();
    const out = ask(target, { leds: src.exportDesign() }, { project: 'leds', board: 'LED board' });
    expect(out).toMatchObject({ project: 'leds', board: 'LED board', boards: ['Main', 'LED board'] });
    expect(placement(out)).toEqual(placement(src.query({ op: 'get_board', board: 'LED board' }) as Answer));
    expect(out.parts!.map((p) => p.refdes).sort()).toEqual(['D2', 'J3', 'R4']);
    expect(out.parts!.find((p) => p.refdes === 'R4')).toMatchObject({ x: 6, rot: 90, placed: 'agent' });
    expect(out.parts!.find((p) => p.refdes === 'J3')?.side).toBe('bottom');
    // by id too
    expect(placement(ask(target, { leds: src.exportDesign() }, { project: 'leds', board: src.boardId('LED board') }))).toEqual(placement(out));
  });

  it('reads the only board of a one-board project when no board is named', () => {
    const src = buck();
    const out = ask(twoBoards(), { buck: src.exportDesign() }, { project: 'buck' });
    expect(out).toMatchObject({ project: 'buck', board: 'Main' });
    expect(out.boards).toBeUndefined();
    expect(placement(out)).toEqual(placement(src.query({ op: 'get_board' }) as Answer));
  });

  it('names the source\'s boards for a board it does not have', () => {
    const out = ask(buck(), { leds: source().exportDesign() }, { project: 'leds', board: 'LED bord' });
    expect(out).toMatchObject({ code: 'BOARD_UNKNOWN', boards: ['Main', 'LED board'] });
    expect(out.error).toMatch(/No board "LED bord" in leds/);
    expect(out.candidates).toContain('LED board');
  });

  it('refuses a project the folder does not list, and says so without a projects folder', () => {
    const k = twoBoards();
    expect(ask(k, { leds: source().exportDesign() }, { project: 'nope' })).toMatchObject({ error: expect.stringMatching(/No project "nope"/), projects: ['leds'] });
    const alone = k.query({ op: 'get_board', project: 'leds', board: 'LED board' }) as Answer;
    expect(alone.error).toMatch(/projects folder/);
    expect(alone.parts).toBeUndefined();
  });

  it('leaves the open design as it was: no draft, no undo entry', () => {
    const k = twoBoards();
    const before = k.exportDesign();
    ask(k, { leds: source().exportDesign() }, { project: 'leds', board: 'LED board' });
    expect(k.exportDesign()).toBe(before);
    expect(k.hasPending()).toBe(false);
    // the last undo entry is still the fixture's own
    expect(k.undo()?.summary).toMatch(/LED board$/);
  });

  it('reports copper only where the stored copper is current for the board', () => {
    const src = source();
    const files = () => ({ leds: src.exportDesign() });
    const target = buck();
    const routing = () => ask(target, files(), { project: 'leds', board: 'LED board' }).routing;
    // never routed
    expect(routing()).toMatch(/not routed as stored/);
    // routed and its copper kept: the stored copper
    ok(src, [{ op: 'route', board: 'LED board' }]);
    const led = src.boardId('LED board');
    expect(src.keepCopper(src.board({}, led).newCopper!)).toBe(true);
    expect(routing()).toMatchObject({ nets: expect.any(Number), routed: expect.any(Number) });
    // a part moved since: the copper is stale, not shown
    ok(src, [{ op: 'place', board: 'LED board', ref: 'R4', x_mm: 9, y_mm: 4 }]);
    expect(routing()).toMatch(/not routed as stored/);
  });
});
