import { describe, expect, it } from 'vitest';
import type { Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { canonicalJson } from '../src/canonical.ts';
import { focusBoard } from '../src/boards.ts';
import { buckTransaction } from './fixtures.ts';

/**
 * The buck on the main board, an LED board joined by a 2-pin header pair: J2 on the main board
 * (its +3V3 and GND), J3 on the LED board feeding D2 through R4. See docs/design/multi-board.md.
 */
function twoBoards(): Kernel {
  const k = new Kernel();
  expect(k.transact(buckTransaction()).status).toBe('ok');
  const ops: Transaction['ops'] = [
    { op: 'add_sheet', name: 'LED' },
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J2' },
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J3', sheet: 'LED' },
    { op: 'add_part', part: 'generic:R', refdes: 'R4', params: { resistance: '1k' }, sheet: 'LED' },
    { op: 'add_part', part: 'generic:LED', refdes: 'D2', sheet: 'LED' },
    { op: 'connect', pins: ['J2.1', 'J3.1', 'R4.1'], net: '+3V3' },
    { op: 'connect', pins: ['R4.2', 'D2.A'], net: 'LED_A' },
    { op: 'connect', pins: ['J2.2', 'J3.2', 'D2.K'], net: 'GND' },
    { op: 'add_board', name: 'LED board', sheets: ['LED'] },
  ];
  const r = k.transact({ summary: 'LED board', ops });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
  return k;
}

const refs = (k: Kernel, board: string) => k.boardPlacement(k.boardId(board)).parts.map((p) => p.refdes).sort();

describe('several boards in one design', () => {
  it('puts each sheet\'s parts on its board', () => {
    const k = twoBoards();
    expect(k.boardList().map((b) => b.name)).toEqual(['Main', 'LED board']);
    expect(refs(k, 'LED board')).toEqual(['D2', 'J3', 'R4']);
    expect(refs(k, 'Main')).not.toContain('R4');
    expect(refs(k, 'Main')).toContain('J2');
    expect(k.committedDesign().format).toBe(3);
  });

  it('routes each board on its own', () => {
    const k = twoBoards();
    for (const name of ['Main', 'LED board']) {
      const r = k.transact({ summary: 'route', ops: [{ op: 'route', board: name }] });
      expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    }
    const led = k.board({}, k.boardId('LED board'));
    expect(led.routing).toBe('done');
    expect(led.parts).toHaveLength(3);
    // the +3V3 on the LED board runs from J3 to R4 only: nothing of the buck
    expect(led.tracks.length).toBeGreaterThan(0);
    const main = k.board({}, k.boardId('Main'));
    expect(main.parts.map((p) => p.refdes)).not.toContain('D2');
  });

  it('takes the board from the part an op names, and asks when nothing says', () => {
    const k = twoBoards();
    expect(k.transact({ summary: 'place', ops: [{ op: 'place', ref: 'R4', x_mm: 5, y_mm: 5 }] }).status).toBe('ok');
    const amb = k.transact({ summary: 'size', ops: [{ op: 'set_board', width_mm: 30 }] });
    expect(amb.rejection?.code).toBe('BOARD_AMBIGUOUS');
    expect(amb.rejection?.candidates).toEqual(['Main', 'LED board']);
    const wrong = k.transact({ summary: 'place', ops: [{ op: 'place', board: 'Main', ref: 'R4', x_mm: 5, y_mm: 5 }] });
    expect(wrong.rejection?.code).toBe('BOARD_INVALID');
    expect(k.transact({ summary: 'size', ops: [{ op: 'set_board', board: 'LED board', width_mm: 30, height_mm: 20 }] }).status).toBe('ok');
    expect(k.boardPlacement(k.boardId('LED board')).outline.w).toBe(30);
    expect(k.boardPlacement(k.boardId('Main')).outline.w).not.toBe(30);
  });

  it('shares the fab house between the boards', () => {
    const k = twoBoards();
    expect(k.transact({ summary: 'fab', ops: [{ op: 'set_fab_profile', preset: 'jlcpcb' }] }).status).toBe('ok');
    const d = k.draftDesign();
    expect(d.board?.fab?.house).toBe('JLCPCB');
    expect(d.boards?.b_2?.settings?.fab?.house).toBe('JLCPCB');
  });

  it('answers get_board per board, and for all of them', () => {
    const k = twoBoards();
    const all = k.query({ op: 'get_board' }) as { boards: { board: string }[] };
    expect(all.boards.map((b) => b.board)).toEqual(['Main', 'LED board']);
    const one = k.query({ op: 'get_board', board: 'LED board' }) as { parts: unknown[] };
    expect(one.parts).toHaveLength(3);
    expect((k.query({ op: 'get_copper' }) as { error?: string }).error).toMatch(/2 boards/);
  });

  it('moves single parts and whole sheets, and back to one board', () => {
    const k = twoBoards();
    expect(k.transact({ summary: 'move', ops: [{ op: 'assign_board', board: 'LED board', refs: ['J2'] }] }).status).toBe('ok');
    expect(refs(k, 'LED board')).toEqual(['D2', 'J2', 'J3', 'R4']);
    expect(k.transact({ summary: 'gone', ops: [{ op: 'remove_board', board: 'LED board' }] }).status).toBe('ok');
    k.accept();
    expect(k.boardList()).toHaveLength(1);
    const d = k.committedDesign();
    expect(d.format).toBe(2);
    expect(d.boards).toBeUndefined();
    expect(Object.values(d.components).some((c) => c.board)).toBe(false);
    expect(refs(k, 'Main')).toContain('D2');
  });

  it('leaves a design of one board as it was', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    const before = k.exportDesign();
    expect(k.transact({ summary: 'route', ops: [{ op: 'route' }] }).status).toBe('ok');
    expect(k.boardList()).toEqual([{ id: 'b_1', name: 'Main' }]);
    expect(JSON.parse(before).boards).toBeUndefined();
  });

  it('keeps each board\'s routed copper with it, saved and loaded again', () => {
    const k = twoBoards();
    expect(k.transact({ summary: 'route', ops: [{ op: 'route', board: 'LED board' }] }).status).toBe('ok');
    k.accept();
    const led = k.boardId('LED board');
    const b = k.board({}, led);
    expect(b.routing).toBe('done');
    expect(k.keepCopper(b.newCopper!)).toBe(true);
    const text = k.exportDesign();
    const d = JSON.parse(text);
    expect(d.format).toBe(3);
    expect(d.boards.b_2.settings.copper.key).toBe(b.newCopper!.key);
    expect(d.board?.copper).toBeUndefined();
    // the copper on one line, as the first board's is
    expect(text.split('\n').some((l) => l.includes('"copper": {') && l.includes('"key"'))).toBe(true);
    expect(canonicalJson(JSON.parse(text))).toBe(text);
    const again = new Kernel(d);
    const b2 = again.board({}, again.boardId('LED board'));
    expect(b2.newCopper).toBeUndefined();
    expect(b2.tracks).toEqual(b.tracks);
  });

  it('draws copper on the second board, and its copper follows a part moved there', () => {
    const k = twoBoards();
    const ok = (ops: Transaction['ops']) => {
      const r = k.transact({ summary: 'x', ops });
      expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
      return r;
    };
    ok([{ op: 'set_copper_mode', board: 'LED board', mode: 'drawn', keep: false }]);
    const r = ok([{ op: 'draw_track', from: 'R4.2', to: 'D2.A' }]);
    expect(r.results[0]!.effect).toMatch(/check/);
    const led = k.boardId('LED board');
    expect(k.board({}, led).drawn!.tracks).toHaveLength(1);
    expect(k.board({}, k.boardId('Main')).drawn).toBeUndefined();
    const t = k.board({}, led).drawn!.tracks[0]!;
    const r4 = k.board({}, led).parts.find((p) => p.refdes === 'R4')!;
    ok([{ op: 'place', ref: 'R4', x_mm: r4.x + 2, y_mm: r4.y }]);
    const t2 = k.board({}, led).drawn!.tracks[0]!;
    expect(t2.pts).not.toEqual(t.pts);
  });

  it('accepts part of a change: a board not accepted takes its parts back to the first', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    const r = k.transact({
      summary: 'LED board',
      ops: [
        { op: 'add_sheet', name: 'LED' },
        { op: 'add_part', part: 'generic:R', refdes: 'R4', params: { resistance: '1k' }, sheet: 'LED' },
        { op: 'add_board', name: 'LED board', sheets: ['LED'] },
      ],
    });
    expect(r.status).toBe('ok');
    const hunks = k.state().proposal!.hunks;
    expect(hunks.map((h) => h.id)).toContain('board:b_2');
    k.accept(hunks.filter((h) => h.id !== 'board:b_2').map((h) => h.id));
    const d = k.committedDesign();
    expect(d.boards).toBeUndefined();
    expect(d.format).toBe(2);
    expect(Object.values(d.sheets).some((s) => s.board)).toBe(false);
    expect(k.boardList()).toHaveLength(1);
  });

  it('undoes adding a board', () => {
    const k = twoBoards();
    expect(k.boardList()).toHaveLength(2);
    k.undo();
    expect(k.boardList()).toHaveLength(1);
    k.redo();
    expect(k.boardList()).toHaveLength(2);
  });

  it('turns a part over on its own board', () => {
    const k = twoBoards();
    const r = k.transact({ summary: 'bottom', ops: [{ op: 'constrain', kind: 'layer', a: 'R4', value: 'bottom' }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const d = k.draftDesign();
    // the placement kept is the LED board's, of its own parts
    expect(Object.keys(d.boards!.b_2!.settings!.placement?.parts ?? {}).map((id) => d.components[id]!.refdes).sort()).toEqual(['D2', 'J3', 'R4']);
    expect(d.board?.placement).toBeUndefined();
    expect(k.boardPlacement(k.boardId('LED board')).parts.find((p) => p.refdes === 'R4')!.side).toBe('bottom');
  });

  it('lists the boards in the summary, with the nets that cross between them', () => {
    const k = twoBoards();
    const s = k.summary();
    expect(s.boards).toEqual([
      { name: 'Main', id: 'b_1', sheets: ['Main'], parts: 13 },
      { name: 'LED board', id: 'b_2', sheets: ['LED'], parts: 3 },
    ]);
    expect(s.nets.find((n) => n.name === '+3V3')!.boards).toEqual(['Main', 'LED board']);
    expect(s.nets.find((n) => n.name === 'LED_A')!.boards).toBeUndefined();
    expect(s.components.find((c) => c.refdes === 'J3')!.board).toBe('LED board');
  });

  it('reads part names only where an op names parts', () => {
    const k = twoBoards();
    // text that looks like a refdes (R4 is on the LED board) is no part
    const g = k.transact({ summary: 'label', ops: [{ op: 'add_graphic', board: 'Main', text: 'R4', x_mm: 2, y_mm: 2 }] });
    expect(g.status, JSON.stringify(g.rejection)).toBe('ok');
    // a net on one board only says the board
    const n = k.transact({ summary: 'tp', ops: [{ op: 'add_test_points', nets: ['LED_A'] }] });
    expect(n.status, JSON.stringify(n.rejection)).toBe('ok');
    // a net on both boards does not
    expect(k.transact({ summary: 'tp', ops: [{ op: 'add_test_points', nets: ['+3V3'] }] }).rejection?.code).toBe('BOARD_AMBIGUOUS');
  });

  it('numbers test points across the boards, and puts them on the board asked for', () => {
    const k = twoBoards();
    const ok = (ops: Transaction['ops']) => {
      const r = k.transact({ summary: 'x', ops });
      expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    };
    ok([{ op: 'add_test_points', board: 'Main', nets: ['+3V3'] }]);
    ok([{ op: 'add_test_points', board: 'LED board', nets: ['+3V3'] }]);
    const d = k.draftDesign();
    const tps = Object.values(d.components).filter((c) => c.refdes.startsWith('TP'));
    expect(new Set(tps.map((c) => c.refdes)).size).toBe(tps.length);
    expect(refs(k, 'LED board').filter((r) => r.startsWith('TP'))).toHaveLength(1);
    const led = tps.find((c) => refs(k, 'LED board').includes(c.refdes))!;
    expect(d.sheets[led.sheet]!.name).toBe('LED');
  });

  it('names the first board Main, with one board or several', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    expect(k.transact({ summary: 'x', ops: [{ op: 'add_board', name: 'main' }] }).rejection?.code).toBe('INVALID_OP');
    expect(k.transact({ summary: 'x', ops: [{ op: 'set_board', board: 'Main', width_mm: 40, height_mm: 30 }] }).status).toBe('ok');
    expect(k.transact({ summary: 'x', ops: [{ op: 'add_board', name: 'Board' }] }).status).toBe('ok');
    expect(k.boardList().map((b) => b.name)).toEqual(['Main', 'Board']);
  });

  it('drops what a part had on the board it left, also when its board is taken away', () => {
    const k = twoBoards();
    const ok = (ops: Transaction['ops']) => {
      const r = k.transact({ summary: 'x', ops });
      expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    };
    ok([{ op: 'place', ref: 'R4', x_mm: 60, y_mm: 60, lock: true }]);
    const r4 = Object.values(k.draftDesign().components).find((c) => c.refdes === 'R4')!.id;
    const positions = () => Object.values(k.draftDesign().ledger).filter((x) => x.kind === 'position' && x.a === r4);
    expect(positions()).toHaveLength(1);
    ok([{ op: 'remove_board', board: 'LED board' }]);
    expect(positions()).toHaveLength(0);
    ok([{ op: 'add_board', name: 'LED board', sheets: ['LED'] }]);
    ok([{ op: 'place', ref: 'R4', x_mm: 4, y_mm: 4, lock: true }]);
    ok([{ op: 'move_to_sheet', refs: ['R4'], sheet: 'Main' }]);
    expect(positions()).toHaveLength(0);
    expect(k.draftDesign().boards!.b_2!.settings?.placement?.parts[r4]).toBeUndefined();
  });

  it('waives a board finding on its own board', () => {
    const k = twoBoards();
    const r = k.transact({ summary: 'w', ops: [{ op: 'add_waiver', board: 'LED board', code: 'DRC.X', entities: ['net:+3V3'], reason: 'checked by hand' }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const w = Object.values(k.draftDesign().waivers)[0]!;
    expect(w.board).toBe('b_2');
        expect(Object.keys(focusBoard(k.draftDesign(), 'b_1').waivers)).toHaveLength(0);
    expect(Object.keys(focusBoard(k.draftDesign(), 'b_2').waivers)).toHaveLength(1);
  });
});
