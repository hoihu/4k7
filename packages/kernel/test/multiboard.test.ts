import { describe, expect, it } from 'vitest';
import type { Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { canonicalJson } from '../src/canonical.ts';
import { focusBoard } from '../src/boards.ts';
import { copperKey } from '../src/board.ts';
import { buckTransaction, twoBoards } from './fixtures.ts';

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

  describe('a fab tier per board', () => {
    const layersOn = (k: Kernel, board: string) => k.board({}, k.boardId(board)).diagnostics.filter((x) => x.code === 'DRC.FAB_LAYERS');
    const ok = (k: Kernel, ops: Transaction['ops']) => {
      const r = k.transact({ summary: 'x', ops });
      expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
      return r;
    };
    /** A 4-layer main board and the 2-layer LED board, JLCPCB's 4-layer tier set on both. */
    const fourAndTwo = () => {
      const k = twoBoards();
      ok(k, [{ op: 'set_board', board: 'Main', layers: 4 }, { op: 'set_fab_profile', preset: 'jlcpcb/4l-1oz' }]);
      return k;
    };

    it('finds the tier on the board it does not fit, and names the board', () => {
      const k = fourAndTwo();
      expect(layersOn(k, 'Main')).toEqual([]);
      const [x] = layersOn(k, 'LED board');
      expect(x).toMatchObject({ severity: 'error', entities: ['LED board'] });
      expect(x!.message).toMatch(/LED board/);
      expect(x!.message).toMatch(/board: "LED board"/);
    });

    it('sets the profile of one board only, when board is given', () => {
      const k = fourAndTwo();
      const r = ok(k, [{ op: 'set_fab_profile', board: 'LED board', preset: 'jlcpcb/2l-1oz' }]);
      expect(r.results[0]!.effect).toMatch(/LED board/);
      const d = k.draftDesign();
      expect(d.boards!.b_2!.settings!.fab!.id).toBe('jlcpcb/2l-1oz');
      expect(d.board!.fab!.id).toBe('jlcpcb/4l-1oz');
      expect(layersOn(k, 'LED board')).toEqual([]);
      expect(layersOn(k, 'Main')).toEqual([]);
      // without board: every board again
      ok(k, [{ op: 'set_fab_profile', preset: 'jlcpcb/2l-2oz' }]);
      const e = k.draftDesign();
      expect([e.board!.fab!.id, e.boards!.b_2!.settings!.fab!.id]).toEqual(['jlcpcb/2l-2oz', 'jlcpcb/2l-2oz']);
      expect(layersOn(k, 'Main')).toMatchObject([{ entities: ['Main'] }]);
    });

    it('refuses a board it does not know, and another house on one board', () => {
      const k = fourAndTwo();
      expect(k.transact({ summary: 'x', ops: [{ op: 'set_fab_profile', board: 'Lamp', preset: 'jlcpcb/2l-1oz' }] }).rejection?.code).toBe('BOARD_UNKNOWN');
      expect(k.transact({ summary: 'x', ops: [{ op: 'set_fab_profile', board: 'LED board', preset: 'pcbway' }] }).rejection?.code).toBe('FAB_INVALID');
    });

    it('waives the finding on the board it names only', () => {
      const k = fourAndTwo();
      ok(k, [{ op: 'add_waiver', code: 'DRC.FAB_LAYERS', entities: ['LED board'], reason: 'made as 4 layers on purpose' }]);
      expect(layersOn(k, 'LED board')[0]!.waivedBy).toBeDefined();
      // the 2-layer tier on both: the main board's finding is not waived by the LED board's waiver
      ok(k, [{ op: 'set_fab_profile', preset: 'jlcpcb/2l-1oz', keep_rules: true }]);
      const [m] = layersOn(k, 'Main');
      expect(m).toMatchObject({ entities: ['Main'] });
      expect(m!.waivedBy).toBeUndefined();
    });
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

describe('mates: the boards joined through a connector on each', () => {
  const codes = (k: Kernel, code: string) => k.state().diagnostics.filter((x) => x.code === code && !x.waivedBy);
  const ok = (k: Kernel, ops: Transaction['ops']) => {
    const r = k.transact({ summary: 'x', ops });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    return r;
  };

  it('says a net crosses to another board through nothing, until the connectors are mated', () => {
    const k = twoBoards();
    expect(codes(k, 'ERC.BOARD_CROSSING').map((x) => x.entities[0])).toEqual(expect.arrayContaining(['net:+3V3', 'net:GND']));
    const r = ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'stack' }]);
    expect(r.results[0]!.effect).toMatch(/1↔1, 2↔2/);
    expect(codes(k, 'ERC.BOARD_CROSSING')).toEqual([]);
    expect(codes(k, 'ERC.MATE_MISMATCH')).toEqual([]);
    expect(k.summary().mates).toEqual([{ id: expect.any(String), a: 'J2', b: 'J3', kind: 'stack', pins: '1↔1, 2↔2' }]);
  });

  it('finds two nets joined at a reversed cable, and a signal that ends at the connector', () => {
    const k = twoBoards();
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'cable', cable: 'reversed' }]);
    expect(codes(k, 'ERC.MATE_MISMATCH').map((x) => x.entities)).toEqual(expect.arrayContaining([['J2.1', 'J3.2'], ['J2.2', 'J3.1']]));
    expect(codes(k, 'ERC.MATE_MISMATCH').at(-1)!.message).toMatch(/mirrored, turned or one pin off/);
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'cable' }, { op: 'disconnect', pins: ['J3.2'] }]);
    expect(codes(k, 'ERC.MATE_MISMATCH')).toEqual([]);
    expect(codes(k, 'ERC.MATE_OPEN').map((x) => x.entities)).toEqual([['J3.2']]);
    expect(k.summary().mates).toHaveLength(1);
  });

  it('pairs the pins of a stack from the footprints facing each other, so a mirrored layout shows', () => {
    const k = twoBoards();
    const d = k.committedDesign();
    const card = (id: string) => ({
      id,
      mpn: id,
      manufacturer: 'Acme',
      description: '2×3 header',
      category: 'connector' as const,
      refPrefix: 'J',
      package: id,
      pins: [1, 2, 3, 4, 5, 6].map((n) => ({ number: String(n), name: String(n), type: 'passive' as const })),
      params: {},
      provenance: { source: 'datasheet' as const },
    });
    d.parts['acme:HDR'] = card('acme:HDR');
    d.parts['acme:SKT'] = card('acme:SKT');
    k.load(d);
    // a 2×3 header on each board, the same footprint: face to face its rows swap
    const pads = [1, 2, 3, 4, 5, 6].map((n) => ({ number: String(n), x: n % 2 ? -1.27 : 1.27, y: (Math.ceil(n / 2) - 2) * 2.54, w: 1.7, drill: 1 }));
    ok(k, [
      { op: 'add_part', part: 'acme:HDR', refdes: 'J4' },
      { op: 'add_part', part: 'acme:SKT', refdes: 'J5', sheet: 'LED' },
      { op: 'set_footprint', ref: 'J4', name: 'HDR_2x3', pads },
      { op: 'set_footprint', ref: 'J5', name: 'HDR_2x3', pads },
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ op: 'connect' as const, pins: [`J4.${n}`, `J5.${n}`], net: `S${n}` })),
      { op: 'mate', a: 'J4', b: 'J5', kind: 'stack' },
    ]);
    const pinsOf = () => k.summary().mates!.find((x) => x.a === 'J4')!.pins;
    expect(pinsOf()).toBe('1↔2, 2↔1, 3↔4, 4↔3, 5↔6, 6↔5');
    expect(codes(k, 'ERC.MATE_MISMATCH')).toHaveLength(6);
    expect(codes(k, 'ERC.MATE_MISMATCH').at(-1)!.message).toMatch(/mirrored/);
    // the socket's footprint drawn mirrored, as a socket's is: each pin meets its own
    ok(k, [{ op: 'set_footprint', ref: 'J5', name: 'SKT_2x3', pads: pads.map((p) => ({ ...p, x: -p.x })) }]);
    expect(pinsOf()).toBe('1↔1, 2↔2, 3↔3, 4↔4, 5↔5, 6↔6');
    expect(codes(k, 'ERC.MATE_MISMATCH')).toEqual([]);
    // another pitch does not plug in
    ok(k, [{ op: 'set_footprint', ref: 'J5', name: 'SKT_2x3_2mm', pads: pads.map((p) => ({ ...p, x: -p.x * 0.787, y: p.y * 0.787 })) }]);
    expect(codes(k, 'ERC.MATE_FIT').map((x) => x.entities)).toEqual([['J4', 'J5']]);
  });

  it('refuses a mate on one board, or a connector mated twice', () => {
    const k = twoBoards();
    expect(k.transact({ summary: 'x', ops: [{ op: 'mate', a: 'J2', b: 'U1', kind: 'stack' }] }).rejection?.code).toBe('BOARD_INVALID');
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'stack' }]);
    expect(k.transact({ summary: 'x', ops: [{ op: 'mate', a: 'R4', b: 'J2', kind: 'wire', map: [['1', '1']] }] }).rejection?.code).toBe('INVALID_OP');
    expect(k.transact({ summary: 'x', ops: [{ op: 'mate', a: 'J2', b: 'R4', kind: 'wire' }] }).rejection?.code).toBe('INVALID_OP');
  });

  it('takes a mate away with its connector, or with the second board', () => {
    const k = twoBoards();
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'stack' }]);
    ok(k, [{ op: 'remove', ref: 'J3' }]);
    expect(k.draftDesign().mates).toBeUndefined();
    ok(k, [{ op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J3', sheet: 'LED' }, { op: 'mate', a: 'J2', b: 'J3', kind: 'stack' }, { op: 'remove_board', board: 'LED board' }]);
    expect(k.draftDesign().mates).toBeUndefined();
  });

  it('accepts a mate as a hunk of its own', () => {
    const k = twoBoards();
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'stack' }]);
    const hunks = k.state().proposal!.hunks;
    expect(hunks.map((h) => h.kind)).toContain('mate');
    k.accept(hunks.filter((h) => h.kind !== 'mate').map((h) => h.id));
    expect(k.committedDesign().mates).toBeUndefined();
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'stack' }]);
    k.accept();
    expect(Object.keys(k.committedDesign().mates!)).toHaveLength(1);
    expect(canonicalJson(JSON.parse(k.exportDesign()))).toBe(k.exportDesign());
  });
});

describe('the assembly: where the boards stand', () => {
  const ok = (k: Kernel, ops: Transaction['ops']) => {
    const r = k.transact({ summary: 'x', ops });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  };
  /** A pad of the board's connector where the assembly puts it, in the first board's frame. */
  const placed = (k: Kernel, board: string, ref: string, pin: string) => {
    const p = k.assembly().find((x) => x.name === board)!;
    const q = k.boardPlacement(p.board).parts.find((x) => x.refdes === ref)!.pads.find((x) => x.number === pin)!;
    const [c, n] = [Math.cos((p.rot * Math.PI) / 180), Math.sin((p.rot * Math.PI) / 180)];
    const u = p.flipped ? -q.x : q.x;
    return [c * u - n * q.y + p.x, n * u + c * q.y + p.y];
  };

  it('stacks the second board where its connector meets the first one\'s', () => {
    const k = twoBoards();
    expect(k.assembly()[1]!.by).toMatch(/beside/);
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'stack', height_mm: 11 }]);
    const [, led] = k.assembly();
    expect(led!.by).toBe('stacked on J2 ↔ J3');
    // both connectors on top of their boards: the LED board is turned over, its top 11 mm above the main board's
    expect(led!.flipped).toBe(true);
    expect(led!.z).toBe(11);
    for (const pin of ['1', '2']) {
      const [x, y] = placed(k, 'LED board', 'J3', pin);
      const q = k.boardPlacement('b_1').parts.find((p) => p.refdes === 'J2')!.pads.find((p) => p.number === pin)!;
      expect(x).toBeCloseTo(q.x, 3);
      expect(y).toBeCloseTo(q.y, 3);
    }
    // the socket on the LED board's underside: the board the right way up, its underside 11 mm up
    ok(k, [{ op: 'constrain', kind: 'layer', a: 'J3', value: 'bottom', strength: 'hard' }]);
    const [, up] = k.assembly();
    expect(up!.flipped).toBe(false);
    expect(up!.z).toBeCloseTo(12.6, 6);
    const q = k.boardPlacement('b_1').parts.find((p) => p.refdes === 'J2')!.pads.find((p) => p.number === '1')!;
    const [x, y] = placed(k, 'LED board', 'J3', '1');
    expect(x).toBeCloseTo(q.x, 3);
    expect(y).toBeCloseTo(q.y, 3);
    expect((k.query({ op: 'get_board' }) as { boards: { assembly: { by: string } }[] }).boards[1]!.assembly.by).toBe('stacked on J2 ↔ J3');
  });

  it('puts a board joined by a cable beside the others', () => {
    const k = twoBoards();
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'cable' }]);
    const [main, led] = k.assembly();
    expect(led!.x).toBeGreaterThan(k.boardPlacement(main!.board).outline.w);
    expect(led!.z).toBe(0);
  });
});

describe('a net\'s track width per board', () => {
  const route = (k: Kernel, board: string) => {
    const r = k.transact({ summary: 'route', ops: [{ op: 'route', board }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    return k.board({}, k.boardId(board));
  };
  const widths = (k: Kernel, board: string, net: string) => {
    const b = k.board({}, k.boardId(board));
    const id = Object.entries(b.netNames).find(([, n]) => n === net)![0];
    return [...new Set(b.tracks.filter((t) => t.netId === id).map((t) => t.width))];
  };
  type NetInfo = { track: { width_mm: number; why: string; by_board?: { board: string; width_mm: number; why: string }[] } };
  const info = (k: Kernel, net: string) => k.query({ op: 'get_net', net }) as NetInfo;

  it('routes and lays a net at its own width on each board, and get_net says why', () => {
    const k = twoBoards();
    const r = k.transact({ summary: 'widths', ops: [{ op: 'set_net', net: '+3V3', track_mm: 0.4 }, { op: 'set_net', net: '+3V3', board: 'LED board', track_mm: 0.8 }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    k.accept();
    const a = k.committedDesign().nets;
    const net = Object.values(a).find((n) => n.name === '+3V3')!;
    expect(net.attrs.trackWidth).toBe(0.4);
    expect(net.attrs.boardTrackWidths).toEqual({ b_2: 0.8 });
    route(k, 'LED board');
    route(k, 'Main');
    // (narrower only in necks into pads too small for the width)
    expect(Math.max(...widths(k, 'LED board', '+3V3'))).toBe(0.8);
    expect(Math.max(...widths(k, 'Main', '+3V3'))).toBe(0.4);
    const t = info(k, '+3V3').track;
    expect(t.by_board).toEqual([
      { board: 'Main', width_mm: 0.4, why: 'set for this net' },
      { board: 'LED board', width_mm: 0.8, why: 'set for this net on LED board' },
    ]);
    // a connection laid by hand on the LED board is routed at its width there
    const laid = k.transact({ summary: 'lay', ops: [{ op: 'draw_track', board: 'LED board', from: 'J3.1', to: 'R4.1', layer: 'F.Cu' }] });
    expect(laid.status, JSON.stringify(laid.rejection)).toBe('ok');
    route(k, 'LED board');
    expect(Math.max(...k.board({}, k.boardId('LED board')).tracks.filter((t) => t.laid).map((t) => t.width))).toBe(0.8);
    // and a track drawn by hand (drawn copper) takes it too, on each board
    for (const [board, from, to, mm] of [['LED board', 'J3.1', 'R4.1', 0.8], ['Main', 'C2.1', 'R1.1', 0.4]] as const) {
      const r = k.transact({ summary: 'draw', ops: [{ op: 'set_copper_mode', board, mode: 'drawn', keep: false }] });
      expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
      const d = k.transact({ summary: 'draw', ops: [{ op: 'draw_track', board, from, to, layer: 'F.Cu' }] });
      expect(d.status, JSON.stringify(d.rejection)).toBe('ok');
      expect(k.board({}, k.boardId(board)).tracks.map((t) => t.width)).toEqual([mm]);
    }
  });

  it('changes the route key of that board only', () => {
    const k = twoBoards();
    const keys = () => ['Main', 'LED board'].map((b) => copperKey(focusBoard(k.draftDesign(), k.boardId(b))));
    const [main, led] = keys();
    expect(k.transact({ summary: 'w', ops: [{ op: 'set_net', net: '+3V3', board: 'LED board', track_mm: 0.8 }] }).status).toBe('ok');
    const [main2, led2] = keys();
    expect(main2).toBe(main);
    expect(led2).not.toBe(led);
    // the net's own width changes both
    expect(k.transact({ summary: 'w', ops: [{ op: 'set_net', net: '+3V3', track_mm: 0.5 }] }).status).toBe('ok');
    const [main3, led3] = keys();
    expect(main3).not.toBe(main2);
    // ... but not the LED board's, which has its own
    expect(led3).toBe(led2);
  });

  it('falls back to the net\'s width when the board\'s is cleared', () => {
    const k = twoBoards();
    k.transact({ summary: 'w', ops: [{ op: 'set_net', net: '+3V3', track_mm: 0.4 }, { op: 'set_net', net: '+3V3', board: 'LED board', track_mm: 0.8 }] });
    const r = k.transact({ summary: 'clear', ops: [{ op: 'set_net', net: '+3V3', board: 'LED board', track_mm: null }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const net = Object.values(k.draftDesign().nets).find((n) => n.name === '+3V3')!;
    expect(net.attrs.boardTrackWidths).toBeUndefined();
    expect(info(k, '+3V3').track.by_board?.map((b) => [b.board, b.width_mm, b.why])).toEqual([
      ['Main', 0.4, 'set for this net'],
      ['LED board', 0.4, 'set for this net'],
    ]);
    route(k, 'LED board');
    expect(Math.max(...widths(k, 'LED board', '+3V3'))).toBe(0.4);
  });

  it('refuses a board the design does not have, changing nothing', () => {
    const k = twoBoards();
    const before = canonicalJson(k.draftDesign());
    const r = k.transact({ summary: 'w', ops: [{ op: 'set_net', net: '+3V3', board: 'Nope', track_mm: 0.8 }] });
    expect(r.status).toBe('rejected');
    expect(r.rejection?.code).toBe('BOARD_UNKNOWN');
    expect(canonicalJson(k.draftDesign())).toBe(before);
    // board without track_mm: nothing to set on it
    expect(k.transact({ summary: 'w', ops: [{ op: 'set_net', net: '+3V3', board: 'LED board', voltage: 3.3 }] }).rejection?.code).toBe('INVALID_OP');
  });

  it('forgets a board\'s widths with the board', () => {
    const k = twoBoards();
    k.transact({ summary: 'w', ops: [{ op: 'set_net', net: '+3V3', board: 'LED board', track_mm: 0.8 }] });
    expect(k.transact({ summary: 'rm', ops: [{ op: 'remove_board', board: 'LED board' }] }).status).toBe('ok');
    const net = Object.values(k.draftDesign().nets).find((n) => n.name === '+3V3')!;
    expect(net.attrs.boardTrackWidths).toBeUndefined();
  });

  it('takes the only board by name on a design of one board', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    const r = k.transact({ summary: 'w', ops: [{ op: 'set_net', net: '+3V3', board: 'Main', track_mm: 0.6 }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const t = info(k, '+3V3').track;
    expect(t.width_mm).toBe(0.6);
    expect(t.why).toBe('set for this net on Main');
    expect(t.by_board).toBeUndefined();
  });
});
