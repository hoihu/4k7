import { describe, expect, it } from 'vitest';
import type { EditOp, Rect } from '@4k7/schema';
import { Kernel } from '../src/index.ts';

const R = (refdes: string): EditOp => ({ op: 'add_part', part: 'generic:R', refdes, params: { resistance: '10k' } });

function ok(k: Kernel, ...ops: EditOp[]) {
  const r = k.transact({ summary: 'edit', ops });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  return r;
}

function refused(k: Kernel, ...ops: EditOp[]) {
  const before = JSON.stringify(k.draftDesign());
  const r = k.transact({ summary: 'edit', ops });
  expect(r.status).toBe('rejected');
  expect(JSON.stringify(k.draftDesign())).toBe(before);
  return r.rejection!;
}

/** Committed: R1 and R2 on Main joined by BIAS, R3 and R4 on Two joined by SENSE, Three empty. */
function threeSheets(): Kernel {
  const k = new Kernel();
  ok(
    k,
    { op: 'add_sheet', name: 'Two' },
    { op: 'add_sheet', name: 'Three' },
    R('R1'),
    R('R2'),
    R('R3'),
    R('R4'),
    { op: 'connect', pins: ['R1.1', 'R2.1'], net: 'BIAS' },
    { op: 'connect', pins: ['R3.1', 'R4.1'], net: 'SENSE' },
    { op: 'move_to_sheet', refs: ['R3', 'R4'], sheet: 'Two' },
  );
  k.accept();
  return k;
}

const sheetNames = (k: Kernel) => k.state().view.sheets.map((s) => s.name);
const sheetId = (k: Kernel, name: string) => Object.values(k.draftDesign().sheets).find((s) => s.name === name)!.id;
const partsOf = (k: Kernel) => Object.values(k.draftDesign().components).map((c) => c.refdes).sort();

describe('remove_sheet', () => {
  it('takes an empty sheet away, its page with it', () => {
    const k = threeSheets();
    const pages = k.state().view.sheets.reduce((n, s) => n + s.pages.length, 0);
    const id = sheetId(k, 'Three');
    ok(k, { op: 'remove_sheet', sheet: 'three' });
    expect(k.proposal()!.hunks.map((h) => [h.id, h.change, h.title])).toEqual([[`sheet:${id}`, 'remove', 'sheet Three']]);
    k.accept();
    expect(sheetNames(k)).toEqual(['Main', 'Two']);
    expect(k.state().view.sheets.reduce((n, s) => n + s.pages.length, 0)).toBe(pages - 1);
  });

  it('refuses a sheet with parts and says what to do with them', () => {
    const r = refused(threeSheets(), { op: 'remove_sheet', sheet: 'Two' });
    expect(r.code).toBe('SHEET_NOT_EMPTY');
    expect(r.message).toContain('R3, R4');
    expect(r.message).toContain('move_to_sheet');
    expect(r.message).toContain('clear_sheet');
  });

  it('keeps the only sheet, empty or not', () => {
    const k = new Kernel();
    expect(refused(k, { op: 'remove_sheet', sheet: 'Main' }).code).toBe('INVALID_OP');
    ok(k, R('R1'));
    expect(refused(k, { op: 'remove_sheet', sheet: 'Main' }).message).toContain('clear_sheet');
  });

  it('names the sheets there are for an unknown one', () => {
    const r = refused(threeSheets(), { op: 'remove_sheet', sheet: 'Nope' });
    expect(r.code).toBe('SHEET_UNKNOWN');
    expect(r.message).not.toContain('add_sheet');
    expect(r.candidates).toEqual(['Main', 'Two', 'Three']);
  });

  it('goes in one transaction with the moves that empty the sheet, and move_to_sheet says it is empty', () => {
    const k = threeSheets();
    const r = ok(k, { op: 'move_to_sheet', refs: ['R3', 'R4'], sheet: 'Main' }, { op: 'remove_sheet', sheet: 'Two' });
    expect(r.results[0]!.effect).toContain('nothing left on Two');
    k.accept();
    expect(sheetNames(k)).toEqual(['Main', 'Three']);
    expect(partsOf(k)).toEqual(['R1', 'R2', 'R3', 'R4']);
    expect(k.state().view.sheets[0]!.symbols.length).toBe(4);
  });

  it('takes a stored drawing along, with no hunk of its own, and undo brings both back', () => {
    const k = threeSheets();
    // parts drawn on Two and moved away leave its drawing behind (how spiral2's MCU sheet came to be)
    ok(k, { op: 'place_symbol', ref: 'R3', x: 2000, y: 2000 }, { op: 'move_to_sheet', refs: ['R3', 'R4'], sheet: 'Main' });
    k.accept();
    const id = sheetId(k, 'Two');
    expect(k.draftDesign().drawing?.[id]).toBeDefined();
    ok(k, { op: 'remove_sheet', sheet: 'Two' });
    expect(k.draftDesign().drawing?.[id]).toBeUndefined();
    expect(k.proposal()!.hunks.map((h) => h.id)).toEqual([`sheet:${id}`]);
    k.accept();
    expect(k.undo()).not.toBeNull();
    expect(sheetNames(k)).toEqual(['Main', 'Two', 'Three']);
    expect(k.draftDesign().drawing?.[id]).toBeDefined();
  });

  it('goes with the placement of a block on it', () => {
    const k = threeSheets();
    ok(k, { op: 'describe', blocks: [{ title: 'Sense', refs: ['R3', 'R4'] }] }, { op: 'place_block', block: 'Sense', x: 3000, y: 3000 });
    k.accept();
    expect(Object.values(k.draftDesign().ledger).filter((l) => l.kind === 'sch_block').length).toBe(1);
    ok(k, { op: 'move_to_sheet', refs: ['R3', 'R4'], sheet: 'Main' }, { op: 'remove_sheet', sheet: 'Two' });
    expect(Object.values(k.draftDesign().ledger).filter((l) => l.sheet === sheetId(k, 'Two')).length).toBe(0);
  });

  it('leaves a new sheet last, after a gap in the order', () => {
    const k = threeSheets();
    ok(k, { op: 'move_to_sheet', refs: ['R3', 'R4'], sheet: 'Main' }, { op: 'remove_sheet', sheet: 'Two' }, { op: 'add_sheet', name: 'Four' });
    expect(sheetNames(k)).toEqual(['Main', 'Three', 'Four']);
    ok(k, { op: 'remove_sheet', sheet: 'Three' }, { op: 'add_sheet', name: 'Five' });
    expect(sheetNames(k)).toEqual(['Main', 'Four', 'Five']);
  });

  it('leaves a new sheet last when the first ones went', () => {
    const k = new Kernel();
    ok(k, { op: 'add_sheet', name: 'Two' }, { op: 'add_sheet', name: 'Three' });
    ok(k, { op: 'remove_sheet', sheet: 'Main' }, { op: 'remove_sheet', sheet: 'Two' }, { op: 'add_sheet', name: 'Four' });
    expect(sheetNames(k)).toEqual(['Three', 'Four']);
    ok(k, R('R1'));
    expect(k.state().view.sheets[0]!.symbols.map((s) => s.refdes)).toEqual(['R1']);
  });
});

describe('remove_sheet accepted in part', () => {
  it('keeps the sheet while a part stays on it because its removal was not accepted', () => {
    const k = threeSheets();
    const id = sheetId(k, 'Two');
    ok(k, { op: 'clear_sheet', sheet: 'Two' }, { op: 'remove_sheet', sheet: 'Two' });
    const { notes } = k.accept([`sheet:${id}`]);
    expect(notes).toContain('kept sheet Two (parts stay on it)');
    expect(sheetNames(k)).toEqual(['Main', 'Two', 'Three']);
    expect(partsOf(k)).toEqual(['R1', 'R2', 'R3', 'R4']);
    expect(k.state().view.sheets[1]!.symbols.length).toBe(2);
  });

  it('keeps the sheet while a part stays on it because its move was not accepted', () => {
    const k = threeSheets();
    const id = sheetId(k, 'Two');
    ok(k, { op: 'move_to_sheet', refs: ['R3', 'R4'], sheet: 'Main' }, { op: 'remove_sheet', sheet: 'Two' });
    const r3 = Object.values(k.draftDesign().components).find((c) => c.refdes === 'R3')!.id;
    k.accept([`sheet:${id}`, `component:${r3}`]);
    expect(sheetNames(k)).toEqual(['Main', 'Two', 'Three']);
    expect(k.state().view.sheets[0]!.symbols.map((s) => s.refdes).sort()).toEqual(['R1', 'R2', 'R3']);
    expect(k.state().view.sheets[1]!.symbols.map((s) => s.refdes)).toEqual(['R4']);
  });

  it('takes the sheet once its parts went too', () => {
    const k = threeSheets();
    ok(k, { op: 'clear_sheet', sheet: 'Two' }, { op: 'remove_sheet', sheet: 'Two' });
    k.accept(k.proposal()!.hunks.filter((h) => h.kind === 'sheet' || h.kind === 'component').map((h) => h.id));
    expect(sheetNames(k)).toEqual(['Main', 'Three']);
    expect(partsOf(k)).toEqual(['R1', 'R2']);
  });

  it('never leaves the design without a sheet', () => {
    const k = new Kernel();
    ok(k, { op: 'add_sheet', name: 'Two' });
    k.accept();
    const two = sheetId(k, 'Two');
    ok(k, { op: 'add_sheet', name: 'Three' }, { op: 'remove_sheet', sheet: 'Main' }, { op: 'remove_sheet', sheet: 'Two' });
    const { notes } = k.accept(['sheet:s_1', `sheet:${two}`]);
    expect(notes).toEqual(['kept sheet Main (a design keeps one)']);
    expect(sheetNames(k)).toEqual(['Main']);
    ok(k, R('R1'));
    expect(partsOf(k)).toEqual(['R1']);
  });

  it('keeps a stored drawing when the removal is not accepted, and drops one when it is', () => {
    const k = threeSheets();
    ok(k, { op: 'place_symbol', ref: 'R3', x: 2000, y: 2000 }, { op: 'move_to_sheet', refs: ['R3', 'R4'], sheet: 'Main' });
    k.accept();
    const id = sheetId(k, 'Two');
    ok(k, { op: 'remove_sheet', sheet: 'Two' }, { op: 'set_paper', size: 'A3' });
    k.accept(['board:paper']);
    expect(sheetNames(k)).toContain('Two');
    expect(k.draftDesign().drawing?.[id]).toBeDefined();
    ok(k, { op: 'remove_sheet', sheet: 'Two' }, { op: 'set_paper', size: 'A2' });
    k.accept([`sheet:${id}`]);
    expect(k.draftDesign().drawing?.[id]).toBeUndefined();
    expect(k.state().view.paper).toBe('A3');
  });

  it('drops a block placed on a sheet that went', () => {
    const k = threeSheets();
    ok(k, { op: 'describe', blocks: [{ title: 'Sense', refs: ['R3', 'R4'] }] }, { op: 'place_block', block: 'Sense', x: 3000, y: 3000 });
    k.accept();
    const id = sheetId(k, 'Two');
    ok(k, { op: 'move_to_sheet', refs: ['R3', 'R4'], sheet: 'Main' }, { op: 'remove_sheet', sheet: 'Two' });
    const { notes } = k.accept(k.proposal()!.hunks.filter((h) => h.kind !== 'constraint').map((h) => h.id));
    expect(notes.some((n) => n.includes('its sheet is gone'))).toBe(true);
    expect(sheetNames(k)).not.toContain('Two');
    expect(Object.values(k.draftDesign().ledger).filter((l) => l.sheet === id).length).toBe(0);
  });
});

describe('clear_sheet', () => {
  it('takes every part off a sheet, its nets with them, and keeps the sheet', () => {
    const k = threeSheets();
    const r = ok(k, { op: 'clear_sheet', sheet: 'Two' });
    expect(r.results[0]!.effect).toContain('took 2 parts off Two');
    k.accept();
    expect(sheetNames(k)).toEqual(['Main', 'Two', 'Three']);
    expect(partsOf(k)).toEqual(['R1', 'R2']);
    expect(k.state().view.sheets[1]!.symbols.length).toBe(0);
    expect(Object.values(k.draftDesign().nets).map((n) => n.name)).toEqual(['BIAS']);
  });

  it('starts a design over on its only sheet, the names free again', () => {
    const k = new Kernel();
    ok(k, R('R1'), R('R2'), { op: 'connect', pins: ['R1.1', 'R2.1'], net: 'BIAS' }, { op: 'set_net', net: 'BIAS', voltage: 5 });
    k.accept();
    ok(k, { op: 'clear_sheet', sheet: 'Main' });
    k.accept();
    expect(partsOf(k)).toEqual([]);
    expect(Object.keys(k.draftDesign().nets)).toEqual([]);
    expect(Object.keys(k.draftDesign().parts)).toEqual([]);
    expect(sheetNames(k)).toEqual(['Main']);
    ok(k, { op: 'add_part', part: 'generic:R', params: { resistance: '1k' } }, R('R2'), { op: 'connect', pins: ['R1.1', 'R2.1'], net: 'BIAS' });
    expect(partsOf(k)).toEqual(['R1', 'R2']);
    expect(Object.values(k.draftDesign().nets)[0]!.attrs.voltage).toBeUndefined();
  });

  it('keeps what keep names, with its connections', () => {
    const k = threeSheets();
    ok(k, R('R5'), { op: 'move_to_sheet', refs: ['R5'], sheet: 'Two' }, { op: 'connect', pins: ['R4.2', 'R5.1'], net: 'OUT' });
    k.accept();
    const r = ok(k, { op: 'clear_sheet', sheet: 'Two', keep: ['R3', 'R4'] });
    expect(r.results[0]!.effect).toContain('took 1 part off Two');
    expect(r.results[0]!.effect).toContain('R3, R4 stay');
    k.accept();
    expect(partsOf(k)).toEqual(['R1', 'R2', 'R3', 'R4']);
    const pins = Object.fromEntries(k.state().summary.nets.map((n) => [n.name, n.pins]));
    expect(pins).toEqual({ BIAS: 2, SENSE: 2, OUT: 1 });
  });

  it('refuses an unknown part in keep, and does not mind one on another sheet', () => {
    const k = threeSheets();
    expect(refused(k, { op: 'clear_sheet', sheet: 'Two', keep: ['R99'] }).code).toBe('REF_UNKNOWN');
    ok(k, { op: 'clear_sheet', sheet: 'Two', keep: ['R1', 'R3'] });
    expect(partsOf(k)).toEqual(['R1', 'R2', 'R3']);
  });

  it('has nothing to do on an empty sheet', () => {
    const k = threeSheets();
    const r = ok(k, { op: 'clear_sheet', sheet: 'Three' });
    expect(r.results[0]!.effect).toContain('no parts to take off');
    expect(k.proposal()).toBeNull();
  });

  it('keeps a net that goes on to another sheet, on the pins it still has', () => {
    const k = threeSheets();
    ok(k, { op: 'connect', pins: ['R1.2', 'R3.2'], net: 'LINK' });
    k.accept();
    ok(k, { op: 'clear_sheet', sheet: 'Two' });
    k.accept();
    const link = k.state().summary.nets.find((n) => n.name === 'LINK');
    expect(link?.pins).toBe(1);
  });

  it('takes the constraints on the parts along, and leaves the others', () => {
    const k = threeSheets();
    ok(k, { op: 'constrain', kind: 'left_of', a: 'R3', b: 'R4', strength: 'soft' }, { op: 'constrain', kind: 'left_of', a: 'R1', b: 'R2', strength: 'soft' }, { op: 'constrain', kind: 'note', value: 'keep it small', strength: 'soft' });
    k.accept();
    const r = ok(k, { op: 'clear_sheet', sheet: 'Two' });
    expect(r.results[0]!.effect).toContain('1 constraint');
    k.accept();
    expect(Object.values(k.draftDesign().ledger).map((l) => l.kind).sort()).toEqual(['left_of', 'note']);
  });

  it('takes the waivers on what went: a new part or net of that name inherits none', () => {
    const k = threeSheets();
    const why = 'intended for this test';
    ok(
      k,
      { op: 'add_waiver', code: 'SEM.A', entities: ['R3', 'R3.1'], reason: why },
      { op: 'add_waiver', code: 'SEM.B', entities: ['net:SENSE'], reason: why },
      { op: 'add_waiver', code: 'SEM.C', entities: ['R1'], reason: why },
      { op: 'add_waiver', code: 'SEM.D', entities: ['net:BIAS'], reason: why },
      { op: 'add_waiver', code: 'SEM.E', entities: ['R1.2', 'R4.2'], reason: why },
    );
    k.accept();
    const r = ok(k, { op: 'clear_sheet', sheet: 'Two' });
    expect(r.results[0]!.effect).toContain('2 waivers');
    const left = Object.values(k.draftDesign().waivers).map((w) => [w.code, w.entities]).sort();
    expect(left).toEqual([['SEM.C', ['R1']], ['SEM.D', ['net:BIAS']], ['SEM.E', ['R1.2']]]);
  });

  it('drops the blocks left without a part and their placements, keeps the overview and says so', () => {
    const k = threeSheets();
    ok(
      k,
      { op: 'describe', overview: 'Two dividers.', blocks: [{ title: 'Bias', refs: ['R1', 'R2'], text: 'Biases it.' }, { title: 'Sense', refs: ['R3', 'R4'], text: 'Senses it.' }] },
      { op: 'place_block', block: 'Sense', x: 3000, y: 3000 },
    );
    k.accept();
    const r = ok(k, { op: 'clear_sheet', sheet: 'Two' });
    expect(r.results[0]!.effect).toContain('1 description block');
    expect(r.results[0]!.effect).toContain('rewrite it with describe');
    const d = k.draftDesign();
    expect(d.description).toMatchObject({ overview: 'Two dividers.', blocks: [{ title: 'Bias', text: 'Biases it.' }] });
    expect(Object.values(d.ledger).filter((l) => l.kind === 'sch_block')).toEqual([]);
    expect(k.proposal()!.hunks.some((h) => h.id === 'description:description')).toBe(true);
  });

  it('takes a block part by part: the parts that stay stay in it', () => {
    const k = threeSheets();
    ok(k, { op: 'describe', blocks: [{ title: 'Sense', refs: ['R3', 'R4'] }] });
    k.accept();
    ok(k, { op: 'clear_sheet', sheet: 'Two', keep: ['R4'] });
    const d = k.draftDesign();
    const r4 = Object.values(d.components).find((c) => c.refdes === 'R4')!.id;
    expect(d.description!.blocks).toMatchObject([{ title: 'Sense', components: [r4] }]);
  });

  it('removes a description with nothing left to say', () => {
    const k = threeSheets();
    ok(k, { op: 'describe', blocks: [{ title: 'Sense', refs: ['R3', 'R4'] }] });
    k.accept();
    ok(k, { op: 'clear_sheet', sheet: 'Two' });
    expect(k.draftDesign().description).toBeUndefined();
  });

  it('hands a sheet it empties back to the auto-layout, and keeps the drawing of one that still has parts', () => {
    const k = threeSheets();
    ok(k, { op: 'place_symbol', ref: 'R3', x: 2000, y: 2000 });
    k.accept();
    const id = sheetId(k, 'Two');
    expect(k.draftDesign().drawing?.[id]).toBeDefined();
    ok(k, { op: 'clear_sheet', sheet: 'Two', keep: ['R3'] });
    const kept = k.draftDesign().drawing?.[id]?.symbols.map((s) => s.ref);
    expect(kept?.length).toBe(1);
    k.reject();
    ok(k, { op: 'clear_sheet', sheet: 'Two' });
    expect(k.draftDesign().drawing).toBeUndefined();
    k.reject();
    // what a user dragged leaves no position behind for parts that are gone
    k.transact({ summary: 'drag', ops: [{ op: 'place_symbol', ref: 'R4', x: 3000, y: 2000 }] }, 'user');
    k.accept();
    ok(k, { op: 'clear_sheet', sheet: 'Two' });
    expect(Object.values(k.draftDesign().ledger).filter((l) => l.kind === 'sch_position')).toEqual([]);
  });

  it('is one transaction with remove_sheet, and undo brings it all back', () => {
    const k = threeSheets();
    const before = JSON.stringify(k.draftDesign());
    ok(k, { op: 'clear_sheet', sheet: 'Two' }, { op: 'remove_sheet', sheet: 'Two' });
    k.accept();
    expect(sheetNames(k)).toEqual(['Main', 'Three']);
    k.undo();
    expect(JSON.stringify(k.draftDesign())).toBe(before);
  });

  describe('on the board', () => {
    /** BIAS on R1, R2 (Main), SENSE on R3, R4 (Two), GND across both; something of every kind on each. */
    function onBoard(): Kernel {
      const k = new Kernel();
      ok(
        k,
        R('R1'),
        R('R2'),
        R('R3'),
        R('R4'),
        { op: 'connect', pins: ['R1.1', 'R2.1'], net: 'BIAS' },
        { op: 'connect', pins: ['R3.1', 'R4.1'], net: 'SENSE' },
        { op: 'connect', pins: ['R2.2', 'R4.2'], net: 'GND' },
        { op: 'add_sheet', name: 'Two' },
        { op: 'move_to_sheet', refs: ['R3', 'R4'], sheet: 'Two' },
        { op: 'set_board', width_mm: 30, height_mm: 20 },
        { op: 'propose_placement' },
        { op: 'set_copper_mode', mode: 'drawn', keep: false },
        { op: 'draw_track', from: 'R1.1', to: 'R2.1' },
        { op: 'draw_track', from: 'R3.1', to: 'R4.1' },
        { op: 'draw_via', at: [2, 18], net: 'SENSE' },
        { op: 'draw_via', at: [28, 2], net: 'BIAS' },
      );
      k.accept();
      const d = k.draftDesign();
      const net = (name: string) => Object.values(d.nets).find((n) => n.name === name)!.id;
      const part = (ref: string) => Object.values(d.components).find((c) => c.refdes === ref)!.id;
      const poly = [1, 1, 3, 1, 3, 3];
      d.board = {
        ...d.board!,
        planes: [{ netId: net('GND'), layer: 'B.Cu' }, { netId: net('SENSE'), layer: 'F.Cu' }, { netId: net('GND'), layer: 'F.Cu', area: { under: [part('R3'), part('R4')] } }, { netId: net('GND'), layer: 'F.Cu', area: { under: [part('R1'), part('R3')] } }],
        vias: [
          { id: 'V1', netId: net('SENSE'), kind: 'points', points: [[5, 5]] },
          { id: 'V2', netId: net('BIAS'), kind: 'points', points: [[6, 6]] },
          { id: 'V3', netId: net('GND'), kind: 'drop', pad: { componentId: part('R4'), number: '2' }, offsets: [[0, 1]] },
          { id: 'V4', netId: net('GND'), kind: 'fence', along: net('SENSE') },
        ],
        holes: [{ id: 'MH1', d: 3, plated: true, netId: net('SENSE'), x: 4, y: 4 }, { id: 'MH2', d: 3, plated: true, netId: net('GND'), x: 26, y: 16 }],
        impedance: [{ id: 'Z1', nets: [net('SENSE')], ohms: 50 }, { id: 'Z2', nets: [net('BIAS')], ohms: 50 }],
        keepouts: [{ id: 'KO1', poly, layers: 'all', forbid: ['tracks'], part: part('R3') }, { id: 'KO2', poly, layers: 'all', forbid: ['tracks'], part: part('R1') }, { id: 'KO3', poly, layers: 'all', forbid: ['tracks'] }],
      };
      return new Kernel(d);
    }

    const netOf = (k: Kernel, id: string | undefined) => k.draftDesign().nets[id ?? '']?.name;

    it('takes what stood on the nets and parts that went, and leaves the rest', () => {
      const k = onBoard();
      const r = ok(k, { op: 'clear_sheet', sheet: 'Two' });
      for (const said of ['1 track', '1 via', '3 via groups', '2 planes', '1 impedance rule', '1 keep-out']) expect(r.results[0]!.effect).toContain(said);
      const b = k.draftDesign().board!;
      expect(b.drawn!.tracks.map((t) => netOf(k, t.netId))).toEqual(['BIAS']);
      expect(b.drawn!.vias.map((v) => netOf(k, v.netId))).toEqual(['BIAS']);
      expect(b.vias!.map((v) => v.id)).toEqual(['V2']);
      expect(b.planes!.map((p) => [netOf(k, p.netId), p.layer, p.area?.under?.length])).toEqual([['GND', 'B.Cu', undefined], ['GND', 'F.Cu', 2]]);
      expect(b.impedance!.map((x) => x.id)).toEqual(['Z2']);
      expect(b.keepouts!.map((x) => x.id)).toEqual(['KO2', 'KO3']);
      expect(b.holes!.map((h) => [h.id, netOf(k, h.netId)])).toEqual([['MH1', undefined], ['MH2', 'GND']]);
      expect(k.state().diagnostics.filter((x) => x.code === 'XCHK.BOARD_NET_UNKNOWN')).toEqual([]);
      expect(k.board().parts.filter((p) => !p.componentId.startsWith('hole:')).map((p) => p.refdes).sort()).toEqual(['R1', 'R2']);
      k.accept();
      expect(k.proposal()).toBeNull();
    });

    it('leaves the outline, the holes and the automatic planes when everything goes', () => {
      const k = onBoard();
      ok(k, { op: 'clear_sheet', sheet: 'Main' }, { op: 'clear_sheet', sheet: 'Two' }, { op: 'remove_sheet', sheet: 'Two' });
      const b = k.draftDesign().board!;
      expect([b.width, b.height]).toEqual([30, 20]);
      expect(b.planes).toBeUndefined();
      expect(b.drawn).toMatchObject({ tracks: [], vias: [] });
      expect(b.holes!.map((h) => [h.id, h.netId])).toEqual([['MH1', undefined], ['MH2', undefined]]);
      expect(k.state().counts).toMatchObject({ errors: 0, warnings: 0 });
      expect(k.board().diagnostics.filter((x) => x.severity !== 'info')).toEqual([]);
    });

    it('is one hunk for the board, which can be left out', () => {
      const k = onBoard();
      const before = k.draftDesign().board!.drawn!.tracks.length;
      ok(k, { op: 'clear_sheet', sheet: 'Two' });
      const hunks = k.proposal()!.hunks;
      expect(hunks.filter((h) => h.kind === 'board').map((h) => h.id)).toEqual(['board:board']);
      k.accept(hunks.filter((h) => h.kind !== 'board').map((h) => h.id));
      expect(partsOf(k)).toEqual(['R1', 'R2']);
      expect(k.draftDesign().board!.drawn!.tracks.length).toBe(before);
      expect(k.state().diagnostics.some((x) => x.code === 'XCHK.BOARD_NET_UNKNOWN')).toBe(true);
    });
  });
});

describe('Optimize', () => {
  it('may neither clear nor remove a sheet', () => {
    const k = threeSheets();
    const s = k.state().view.sheets[1]!;
    const rect: Rect = s.bbox;
    expect('error' in (k.setScope({ view: 'schematic', sheet: s.id, rect }) as object)).toBe(false);
    expect(refused(k, { op: 'clear_sheet', sheet: 'Two' }).code).toBe('OUT_OF_SCOPE');
    expect(refused(k, { op: 'remove_sheet', sheet: 'Three' }).code).toBe('OUT_OF_SCOPE');
    k.setScope(null);
  });
});
