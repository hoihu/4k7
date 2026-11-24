import { describe, expect, it } from 'vitest';
import type { Design, EditOp } from '@4k7/schema';
import { getBuiltinPart } from '@4k7/parts';
import { Kernel, boardOf } from '../src/index.ts';
import type { ImportSources } from '../src/importops.ts';
import { twoBoards } from './fixtures.ts';

/** A regulator card the library does not have: only the project's file stores it (its VOUT pin named FB). */
function regCard() {
  const card = structuredClone(getBuiltinPart('microchip:MCP1700T-3302E/TT')!);
  card.id = 'acme:REG';
  for (const p of card.pins) if (p.name === 'VOUT') p.name = 'FB';
  return card;
}

/** "lamp": a supply block (J1, U1 on its own card, C1, R2 on FB) and a power LED block (R1, D1) with a note and an order. */
function lamp(): Design {
  const k = new Kernel();
  const empty = JSON.parse(k.exportDesign()) as Design;
  k.load({ ...empty, parts: { 'acme:REG': regCard() } });
  const ops: EditOp[] = [
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
    { op: 'add_part', part: 'acme:REG', refdes: 'U1' },
    { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10uF' } },
    { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '100k' } },
    { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
    { op: 'add_part', part: 'generic:LED', refdes: 'D1' },
    { op: 'connect', pins: ['J1.1', 'C1.1', 'U1.VIN', 'R1.1'], net: '+5V' },
    { op: 'connect', pins: ['J1.2', 'C1.2', 'U1.GND', 'R2.2', 'D1.K'], net: 'GND' },
    { op: 'connect', pins: ['U1.FB', 'R2.1'], net: 'FB' },
    { op: 'connect', pins: ['R1.2', 'D1.A'], net: 'LED_A' },
    { op: 'constrain', kind: 'note', a: 'R1', value: 'sets the LED to 3 mA', strength: 'soft' },
    { op: 'constrain', kind: 'left_of', a: 'R1', b: 'D1', strength: 'soft' },
    { op: 'describe', blocks: [{ title: 'Supply', refs: ['J1', 'U1', 'C1', 'R2'], text: 'USB 5 V in.' }, { title: 'Power LED', refs: ['R1', 'D1'] }] },
  ];
  const r = k.transact({ summary: 'lamp', ops });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
  return JSON.parse(k.exportDesign()) as Design;
}

const sources = (file: Design = lamp()): ImportSources => ({ projects: ['lamp', 'other'], files: { lamp: JSON.stringify(file) } });

/** The open design: an LED of its own already (R1, D1 on LED_A) on +3V3. */
function target(): Kernel {
  const k = new Kernel();
  const r = k.transact({
    summary: 'own',
    ops: [
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '470' } },
      { op: 'add_part', part: 'generic:LED', refdes: 'D1' },
      { op: 'connect', pins: ['R1.1'], net: '+3V3' },
      { op: 'connect', pins: ['R1.2', 'D1.A'], net: 'LED_A' },
      { op: 'connect', pins: ['D1.K'], net: 'GND' },
    ],
  });
  expect(r.status).toBe('ok');
  k.accept();
  return k;
}

const importing = (k: Kernel, op: Omit<Extract<EditOp, { op: 'import_block' }>, 'op'>, src: ImportSources | null = sources()) =>
  k.transact({ summary: 'import', ops: [{ op: 'import_block', ...op }] }, 'agent', undefined, src ?? undefined);

/** "led": one block, a thermistor TH1 and its header J1 on NTC, an internal net, and GND. */
function ledFile(): Design {
  const k = new Kernel();
  const r = k.transact({
    summary: 'led',
    ops: [
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
      { op: 'add_part', part: 'generic:R', refdes: 'TH1', params: { resistance: '10k' } },
      { op: 'connect', pins: ['J1.1', 'TH1.1'], net: 'NTC' },
      { op: 'connect', pins: ['J1.2', 'TH1.2'], net: 'GND' },
      { op: 'describe', blocks: [{ title: 'NTC', refs: ['J1', 'TH1'] }] },
    ],
  });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
  return JSON.parse(k.exportDesign()) as Design;
}
const ntcSources = (): ImportSources => ({ projects: ['led'], files: { led: JSON.stringify(ledFile()) } });

/** The main board: J1 and R9 on its own NTC net; with `boards`, R9 sits on an LED board of its own. */
function ntcTarget(boards = false): Kernel {
  const k = new Kernel();
  const r = k.transact({
    summary: 'main',
    ops: [
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
      ...(boards ? [{ op: 'add_sheet', name: 'LED' } as const] : []),
      { op: 'add_part', part: 'generic:R', refdes: 'R9', params: { resistance: '10k' }, ...(boards ? { sheet: 'LED' } : {}) },
      { op: 'connect', pins: ['J1.1', 'R9.1'], net: 'NTC' },
      { op: 'connect', pins: ['J1.2', 'R9.2'], net: 'GND' },
      ...(boards ? [{ op: 'add_board', name: 'LED board', sheets: ['LED'] } as const] : []),
    ],
  });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
  return k;
}

describe('import_block', () => {
  it('copies the parts, nets and describe block, and lists the values to recheck', () => {
    const k = target();
    const r = importing(k, { project: 'lamp', block: 'Supply', nets: { '+5V': 'VBUS', GND: 'GND' } });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const d = k.draftSnapshot().design;
    const by = (ref: string) => Object.values(d.components).find((c) => c.refdes === ref)!;
    const net = (ref: string, pin: string) => d.nets[by(ref).pins[pin]!]!.name;
    expect(['J1', 'U1', 'C1', 'R2'].map((x) => by(x).part)).toEqual(['generic:CONN_1x2', 'acme:REG', 'generic:C', 'generic:R']);
    expect(by('C1').params).toEqual({ capacitance: '10uF' });
    expect(net('J1', '1')).toBe('VBUS');
    expect(net('J1', '2')).toBe('GND');
    expect(Object.values(d.nets).filter((n) => n.name === 'GND')).toHaveLength(1); // joined to this design's GND
    expect(net('R2', '1')).toBe('FB');
    expect(d.description?.blocks).toEqual([{ title: 'Supply', components: ['J1', 'U1', 'C1', 'R2'].map((x) => by(x).id), text: 'USB 5 V in.' }]);
    const rep = r.results[0]!.imported!;
    expect(rep.cards).toEqual({ library: ['generic:CONN_1x2', 'generic:C', 'generic:R'], project: ['acme:REG'] });
    expect(rep.renamed).toEqual({ refdes: {}, nets: {} });
    expect(rep.recheck).toEqual([
      { ref: 'C1', params: { capacitance: '10uF' }, why: 'chosen for lamp' },
      { ref: 'R2', params: { resistance: '100k' }, why: 'sets U1.FB' },
    ]);
    expect(r.results[0]!.effect).toMatch(/values to recheck .*R2 100k \(sets U1\.FB\)/);
  });

  it('renames refdes and internal nets that are taken, and brings the note and the order along', () => {
    const k = target();
    const r = importing(k, { project: 'lamp', block: 2, nets: { '+5V': '+3V3', GND: 'GND' } });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const rep = r.results[0]!.imported!;
    expect(rep.renamed).toEqual({ refdes: { R1: 'R2', D1: 'D2' }, nets: { LED_A: 'LED_A_2' } });
    const d = k.draftSnapshot().design;
    const by = (ref: string) => Object.values(d.components).find((c) => c.refdes === ref)!;
    expect(by('R2').params).toEqual({ resistance: '1k' });
    expect(by('R2').pins['1']).toBe(by('R1').pins['1']); // both on +3V3
    expect(d.nets[by('R2').pins['2']!]!.name).toBe('LED_A_2');
    const kinds = Object.values(d.ledger).map((x) => [x.kind, x.a, x.b, x.value]);
    expect(kinds).toEqual([['note', by('R2').id, undefined, 'sets the LED to 3 mA'], ['left_of', by('R2').id, by('D2').id, undefined]]);
    // with a prefix, the internal net takes it instead
    const k2 = target();
    const r2 = importing(k2, { project: 'lamp', block: 'power led', nets: { '+5V': '+3V3', GND: 'GND' }, prefix: 'CH2_' });
    expect(r2.results[0]!.imported!.renamed.nets).toEqual({ LED_A: 'CH2_LED_A' });
  });

  it('refuses and changes nothing when a boundary net is not mapped, or a net is not a boundary net', () => {
    const k = target();
    const before = JSON.stringify(k.draftSnapshot().design);
    const r = importing(k, { project: 'lamp', block: 'Power LED', nets: { GND: 'GND' } });
    expect(r.rejection).toMatchObject({ code: 'NET_UNMAPPED', candidates: ['+5V'] });
    expect(importing(k, { project: 'lamp', block: 'Power LED', nets: { GND: 'GND', '+5V': '+3V3', FB: 'X' } }).rejection).toMatchObject({ code: 'NET_UNKNOWN', candidates: ['+5V', 'GND', 'LED_A'] });
    expect(JSON.stringify(k.draftSnapshot().design)).toBe(before);
  });

  it('joins an internal net the agent maps onto the net of that name here instead of making NTC_2', () => {
    const plain = ntcTarget();
    const r0 = importing(plain, { project: 'led', block: 'NTC', nets: { GND: 'GND' } }, ntcSources());
    expect(r0.status, JSON.stringify(r0.rejection)).toBe('ok');
    expect(r0.results[0]!.imported!.renamed.nets).toEqual({ NTC: 'NTC_2' }); // unmapped: made anew as before

    const k = ntcTarget();
    const r = importing(k, { project: 'led', block: 'NTC', nets: { GND: 'GND', NTC: 'NTC' } }, ntcSources());
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(r.results[0]!.imported!.renamed).toEqual({ refdes: { J1: 'J2' }, nets: {} });
    expect(r.results[0]!.effect).toMatch(/NTC → NTC/);
    const d = k.draftSnapshot().design;
    const by = (ref: string) => Object.values(d.components).find((c) => c.refdes === ref)!;
    expect(Object.values(d.nets).map((n) => n.name).filter((n) => n.startsWith('NTC'))).toEqual(['NTC']);
    expect(by('J2').pins['1']).toBe(by('R9').pins['1']);
    expect(by('TH1').pins['1']).toBe(by('R9').pins['1']);
  });

  it('makes the net an internal net is mapped to where this design has none', () => {
    const k = ntcTarget();
    const r = importing(k, { project: 'led', block: 'NTC', nets: { GND: 'GND', NTC: 'TEMP' } }, ntcSources());
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const d = k.draftSnapshot().design;
    const th = Object.values(d.components).find((c) => c.refdes === 'TH1')!;
    expect(d.nets[th.pins['1']!]!.name).toBe('TEMP');
    expect(Object.values(d.nets).filter((n) => n.name === 'NTC')).toHaveLength(1);
  });

  it('joins a mapped internal net on a design of two boards, and its parts can go on either board', () => {
    const k = ntcTarget(true);
    const r = importing(k, { project: 'led', block: 'NTC', nets: { GND: 'GND', NTC: 'NTC' } }, ntcSources());
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    k.accept();
    const a = k.transact({ summary: 'to the LED board', ops: [{ op: 'assign_board', board: 'LED board', refs: ['TH1'] }] });
    expect(a.status, JSON.stringify(a.rejection)).toBe('ok');
    k.accept();
    expect(k.boardPlacement(k.boardId('LED board')).parts.map((p) => p.refdes).sort()).toEqual(['R9', 'TH1']);
    expect(k.boardPlacement(k.boardId('Main')).parts.map((p) => p.refdes)).toContain('J2');
    const d = k.committedDesign();
    const by = (ref: string) => Object.values(d.components).find((c) => c.refdes === ref)!;
    expect(by('TH1').pins['1']).toBe(by('R9').pins['1']); // one NTC across both boards
    expect(by('J2').pins['1']).toBe(by('R9').pins['1']);
    expect(Object.values(d.nets).filter((n) => n.name.startsWith('NTC'))).toHaveLength(1);
  });

  it('puts the parts on the sheet and the board it is given, and moves nothing else', () => {
    const k = ntcTarget(true);
    const r0 = k.transact({ summary: 'a third sheet', ops: [{ op: 'add_sheet', name: 'Spare' }] });
    expect(r0.status, JSON.stringify(r0.rejection)).toBe('ok');
    k.accept();
    const where = (d: Design) => Object.fromEntries(Object.values(d.components).map((c) => [c.refdes, [d.sheets[c.sheet]!.name, d.boards?.[boardOf(d, c)]?.name ?? 'Main']]));
    const before = where(k.committedDesign());
    // the sheet of the LED board, and the LED board
    const r = importing(k, { project: 'led', block: 'NTC', nets: { GND: 'GND', NTC: 'NTC' }, sheet: 'LED', board: 'LED board' }, ntcSources());
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(r.results[0]!.effect).toMatch(/on sheet LED, board "LED board"/);
    const after = where(k.draftSnapshot().design);
    expect(after).toEqual({ ...before, J2: ['LED', 'LED board'], TH1: ['LED', 'LED board'] });
    k.accept();
    expect(k.boardPlacement(k.boardId('LED board')).parts.map((p) => p.refdes).sort()).toEqual(['J2', 'R9', 'TH1']);
    // a sheet of the first board, the parts on the LED board all the same
    const k2 = ntcTarget(true);
    const r2 = importing(k2, { project: 'led', block: 'NTC', nets: { GND: 'GND', NTC: 'NTC' }, sheet: 'Main', board: 'LED board' }, ntcSources());
    expect(r2.status, JSON.stringify(r2.rejection)).toBe('ok');
    const d2 = k2.draftSnapshot().design;
    expect(where(d2)).toMatchObject({ J1: ['Main', 'Main'], R9: ['LED', 'LED board'], J2: ['Main', 'LED board'], TH1: ['Main', 'LED board'] });
  });

  it('without sheet and board, imports exactly as before', () => {
    const a = ntcTarget(true);
    const b = ntcTarget(true);
    const ra = importing(a, { project: 'led', block: 'NTC', nets: { GND: 'GND' } }, ntcSources());
    const rb = importing(b, { project: 'led', block: 'NTC', nets: { GND: 'GND' }, sheet: 'main', board: 'Main' }, ntcSources());
    expect(ra.status, JSON.stringify(ra.rejection)).toBe('ok');
    expect(rb.status, JSON.stringify(rb.rejection)).toBe('ok');
    const da = a.draftSnapshot().design;
    expect(JSON.stringify(da)).toBe(JSON.stringify(b.draftSnapshot().design));
    for (const c of Object.values(da.components).filter((x) => ['J2', 'TH1'].includes(x.refdes))) {
      expect(c.sheet).toBe('s_1');
      expect(c.board).toBeUndefined();
    }
    expect(ra.results[0]!.effect).not.toMatch(/on sheet|board "/);
  });

  it('imports onto the LED board of twoBoards(): every part, net, card and rename as pinned here', () => {
    const k = twoBoards();
    const r = importing(k, { project: 'lamp', block: 'Supply', nets: { '+5V': '+3V3', GND: 'GND' }, sheet: 'LED', board: 'LED board' });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const d = k.draftSnapshot().design;
    const parts = Object.fromEntries(Object.values(d.components).map((c) => [c.refdes, [c.part, d.sheets[c.sheet]!.name, d.boards?.[boardOf(d, c)]?.name ?? 'Main', Object.fromEntries(Object.entries(c.pins).map(([p, n]) => [p, d.nets[n]!.name]))]]));
    const before = Object.fromEntries(Object.entries(parts).filter(([ref]) => !['J4', 'U2', 'C6', 'R5'].includes(ref)));
    expect(Object.keys(before).sort()).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'D1', 'D2', 'J1', 'J2', 'J3', 'L1', 'R1', 'R2', 'R3', 'R4', 'U1']);
    expect(parts).toMatchObject({
      J3: ['generic:CONN_1x2', 'LED', 'LED board', { 1: '+3V3', 2: 'GND' }],
      R4: ['generic:R', 'LED', 'LED board', { 1: '+3V3', 2: 'LED_A' }],
      R1: ['generic:R', 'Main', 'Main', { 1: '+3V3', 2: 'FB' }],
      R2: ['generic:R', 'Main', 'Main', { 1: 'FB', 2: 'GND' }],
    });
    expect(Object.fromEntries(['J4', 'U2', 'C6', 'R5'].map((x) => [x, parts[x]]))).toEqual({
      J4: ['generic:CONN_1x2', 'LED', 'LED board', { 1: '+3V3', 2: 'GND' }],
      U2: ['acme:REG', 'LED', 'LED board', { 1: 'GND', 2: 'FB_2', 3: '+3V3' }],
      C6: ['generic:C', 'LED', 'LED board', { 1: '+3V3', 2: 'GND' }],
      R5: ['generic:R', 'LED', 'LED board', { 1: 'FB_2', 2: 'GND' }],
    });
    expect(Object.values(d.nets).map((n) => n.name)).toEqual(['+12V', 'GND', 'SW', '+3V3', 'FB', 'SS', 'COMP', 'N$1', 'BOOT', 'LED_A', 'FB_2']);
    const by = (ref: string) => Object.values(d.components).find((c) => c.refdes === ref)!.id;
    expect(d.description).toEqual({ overview: '', blocks: [{ title: 'Supply', components: ['J4', 'U2', 'C6', 'R5'].map(by), text: 'USB 5 V in.' }] });
    expect(d.parts['acme:REG']).toEqual(regCard());
    const res = r.results[0]!;
    expect(res.ids).toEqual([...['J4', 'U2', 'C6', 'R5'].map(by), ...['+3V3', 'GND', 'FB_2'].map((n) => Object.values(d.nets).find((x) => x.name === n)!.id)]);
    expect(res.imported).toEqual({
      project: 'lamp',
      block: 'Supply',
      renamed: { refdes: { J1: 'J4', U1: 'U2', C1: 'C6', R2: 'R5' }, nets: { FB: 'FB_2' } },
      cards: { library: ['generic:CONN_1x2', 'generic:C', 'generic:R'], project: ['acme:REG'] },
      recheck: [
        { ref: 'C6', params: { capacitance: '10uF' }, why: 'chosen for lamp' },
        { ref: 'R5', params: { resistance: '100k' }, why: 'sets U2.FB' },
      ],
    });
    expect(res.effect).toBe(
      'imported "Supply" from lamp: 4 part(s) (C6, J4, R5, U2) on sheet LED, board "LED board", boundary +5V → +3V3, GND → GND; ' +
        'renamed J1 → J4, U1 → U2, C1 → C6, R2 → R5; nets renamed FB → FB_2; not in the library, card taken from lamp: acme:REG; ' +
        'values to recheck (chosen for lamp): C6 10uF, R5 100k (sets U2.FB)',
    );
    k.accept();
    expect(k.boardPlacement(k.boardId('LED board')).parts.map((p) => p.refdes).sort()).toEqual(['C6', 'D2', 'J3', 'J4', 'R4', 'R5', 'U2']);
  });

  it('refuses an unknown sheet or board and imports nothing', () => {
    const k = ntcTarget(true);
    const before = JSON.stringify(k.draftSnapshot().design);
    const s = importing(k, { project: 'led', block: 'NTC', nets: { GND: 'GND' }, sheet: 'Lamp' }, ntcSources());
    expect(s.rejection).toMatchObject({ code: 'SHEET_UNKNOWN' });
    expect(s.rejection!.candidates).toContain('LED');
    const b = importing(k, { project: 'led', block: 'NTC', nets: { GND: 'GND' }, board: 'Lamp board' }, ntcSources());
    expect(b.rejection).toMatchObject({ code: 'BOARD_UNKNOWN' });
    expect(JSON.stringify(k.draftSnapshot().design)).toBe(before);
  });

  it('takes the board by name or id on a design of one board', () => {
    for (const board of ['Main', 'b_1']) {
      const k = ntcTarget();
      const r = importing(k, { project: 'led', block: 'NTC', nets: { GND: 'GND' }, board }, ntcSources());
      expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
      expect(r.results[0]!.effect).toMatch(/board "Main"/);
      const d = k.draftSnapshot().design;
      expect(d.boards).toBeUndefined();
      expect(Object.values(d.components).every((c) => c.board === undefined)).toBe(true);
    }
  });

  it('refuses an unknown block or project, and without the projects folder', () => {
    const k = target();
    expect(importing(k, { project: 'lamp', block: 'Charger', nets: {} }).rejection).toMatchObject({ code: 'BLOCK_UNKNOWN', candidates: ['Supply', 'Power LED'] });
    expect(importing(k, { project: 'lamp', block: 3, nets: {} }).rejection?.code).toBe('BLOCK_UNKNOWN');
    expect(importing(k, { project: '../lamp', block: 1, nets: {} }).rejection).toMatchObject({ code: 'PROJECT_UNKNOWN', candidates: ['lamp', 'other'] });
    expect(importing(k, { project: 'lamp', block: 1, nets: {} }, null).rejection?.code).toBe('PROJECT_UNKNOWN');
  });

  it('refuses a part neither the library nor the project file has', () => {
    const file = lamp();
    delete file.parts['acme:REG'];
    const k = target();
    const r = importing(k, { project: 'lamp', block: 'Supply', nets: { '+5V': 'VBUS', GND: 'GND' } }, sources(file));
    expect(r.rejection).toMatchObject({ code: 'PART_UNKNOWN', message: expect.stringMatching(/acme:REG/) });
  });

  it('is undone like any edit', () => {
    const k = target();
    const before = k.exportDesign();
    expect(importing(k, { project: 'lamp', block: 'Supply', nets: { '+5V': 'VBUS', GND: 'GND' } }).status).toBe('ok');
    k.accept();
    expect(k.exportDesign()).not.toBe(before);
    k.undo();
    expect(k.exportDesign()).toBe(before);
  });
});
