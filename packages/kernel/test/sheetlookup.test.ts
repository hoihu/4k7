import { describe, expect, it } from 'vitest';
import type { EditOp } from '@4k7/schema';
import type { Kernel } from '../src/index.ts';
import { twoBoards } from './fixtures.ts';

// Every op that names a sheet finds it the same way (name, any case, or id) and refuses an
// unknown one with SHEET_UNKNOWN. See docs/design/ops-api.md.

function refused(k: Kernel, op: EditOp) {
  const before = JSON.stringify(k.draftDesign());
  const r = k.transact({ summary: 'edit', ops: [op] });
  expect(r.status).toBe('rejected');
  expect(JSON.stringify(k.draftDesign())).toBe(before);
  return r.rejection!;
}

function ok(k: Kernel, op: EditOp) {
  const r = k.transact({ summary: 'edit', ops: [op] });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  return r;
}

const sheetId = (k: Kernel, name: string) => Object.values(k.draftDesign().sheets).find((s) => s.name === name)!.id;

describe('sheet lookup', () => {
  it('place_text refuses an unknown sheet with SHEET_UNKNOWN, listing the sheets', () => {
    const r = refused(twoBoards(), { op: 'place_text', sheet: 'LDE', auto: true });
    expect(r.code).toBe('SHEET_UNKNOWN');
    expect(r.message).toBe('No sheet "LDE".');
    expect(r.candidates).toEqual(expect.arrayContaining(['Main', 'LED']));
  });

  it('auto_draw refuses an unknown sheet with SHEET_UNKNOWN, listing the sheets', () => {
    const r = refused(twoBoards(), { op: 'auto_draw', sheet: 'LDE' });
    expect(r.code).toBe('SHEET_UNKNOWN');
    expect(r.message).toBe('No sheet "LDE".');
    expect(r.candidates).toEqual(expect.arrayContaining(['Main', 'LED']));
  });

  it('assign_board still refuses an unknown sheet with SHEET_UNKNOWN, message unchanged', () => {
    const r = refused(twoBoards(), { op: 'assign_board', board: 'LED board', sheets: ['LDE'] });
    expect(r.code).toBe('SHEET_UNKNOWN');
    expect(r.message).toBe('No sheet "LDE".');
    expect(r.candidates).toContain('LED');
  });

  it('place_text and auto_draw find a sheet by name in any case, and by id', () => {
    const k = twoBoards();
    const led = sheetId(k, 'LED');
    expect(ok(k, { op: 'auto_draw', sheet: 'led' }).results[0]!.ids).toEqual([led]);
    expect(ok(k, { op: 'auto_draw', sheet: led }).results[0]!.ids).toEqual([led]);
    ok(k, { op: 'place_text', sheet: 'Main', auto: true });
    ok(k, { op: 'place_text', sheet: sheetId(k, 'Main'), auto: true });
  });

  it('assign_board finds a sheet by name and by id, across boards', () => {
    const k = twoBoards();
    const led = sheetId(k, 'LED');
    ok(k, { op: 'assign_board', board: 'Main', sheets: ['led'] });
    expect(k.draftDesign().sheets[led]!.board).toBeUndefined();
    ok(k, { op: 'assign_board', board: 'LED board', sheets: [led] });
    expect(k.draftDesign().sheets[led]!.board).toBeDefined();
  });
});
