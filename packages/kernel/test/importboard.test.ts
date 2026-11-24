/**
 * import_board (D29 step 3): a whole board of another project copied in as a board of this design,
 * nets joined by name. The open design is the buck of the shared fixtures, with a header J2 (VLED,
 * GND) and its own LED net; the source is a small LED ring. See docs/design/ops-api.md §7.
 */
import { describe, expect, it } from 'vitest';
import type { Design, EditOp, Transaction } from '@4k7/schema';
import { Kernel, boardOf } from '../src/index.ts';
import { findBoard, settingsOf } from '../src/boards.ts';
import type { ImportSources } from '../src/importops.ts';
import { buck, twoBoards } from './fixtures.ts';

type ImportBoard = Omit<Extract<EditOp, { op: 'import_board' }>, 'op'>;

/** "ring": J1 (VLED 12 V, GND), R1 → D1 on an automatic net, D1 → D2 on LED, a 30 × 30 mm board with a GND hole. */
function ring(): Design {
  const k = new Kernel();
  const ops: EditOp[] = [
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
    { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '100' } },
    { op: 'add_part', part: 'generic:LED', refdes: 'D1' },
    { op: 'add_part', part: 'generic:LED', refdes: 'D2' },
    { op: 'connect', pins: ['J1.1', 'R1.1'], net: 'VLED' },
    { op: 'set_net', net: 'VLED', voltage: 12 },
    { op: 'connect', pins: ['R1.2', 'D1.A'] },
    { op: 'connect', pins: ['D1.K', 'D2.A'], net: 'LED' },
    { op: 'connect', pins: ['D2.K', 'J1.2'], net: 'GND' },
    { op: 'constrain', kind: 'left_of', a: 'R1', b: 'D1', strength: 'soft' },
    { op: 'describe', blocks: [{ title: 'LED ring', refs: ['J1', 'R1', 'D1', 'D2'], text: 'Two LEDs from VLED.' }] },
    { op: 'set_board', width_mm: 30, height_mm: 30 },
    { op: 'add_hole', diameter_mm: 3.2, x_mm: 5, y_mm: 5, plated: true, net: 'GND' },
  ];
  const r = k.transact({ summary: 'ring', ops });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
  return JSON.parse(k.exportDesign()) as Design;
}

const sources = (files: Record<string, Design> = { ring: ring() }): ImportSources => ({
  projects: ['main', ...Object.keys(files)],
  files: Object.fromEntries(Object.entries(files).map(([id, d]) => [id, JSON.stringify(d)])),
});

/** The open design: the buck, a header J2 on VLED (5 V) and GND, and R9 on a net of its own called LED. */
function main(extra: Transaction['ops'] = []): Kernel {
  const k = buck();
  const r = k.transact({
    summary: 'main',
    ops: [
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J2' },
      { op: 'add_part', part: 'generic:R', refdes: 'R9', params: { resistance: '1k' } },
      { op: 'connect', pins: ['J2.1'], net: 'VLED' },
      { op: 'set_net', net: 'VLED', voltage: 5 },
      { op: 'connect', pins: ['J2.2'], net: 'GND' },
      { op: 'connect', pins: ['R9.1'], net: '+3V3' },
      { op: 'connect', pins: ['R9.2'], net: 'LED' },
      ...extra,
    ],
  });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
  return k;
}

const importing = (k: Kernel, op: ImportBoard, more: EditOp[] = [], src: ImportSources | null = sources(), dry = false) =>
  k.transact({ summary: 'import', ops: [{ op: 'import_board', ...op }, ...more], ...(dry ? { dry_run: true } : {}) }, 'agent', undefined, src ?? undefined);

const ok = (r: ReturnType<typeof importing>) => {
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  return r.results[0]!.importedBoard!;
};

const design = (k: Kernel) => k.draftSnapshot().design;
const by = (d: Design, ref: string) => Object.values(d.components).find((c) => c.refdes === ref)!;
const netOf = (d: Design, ref: string, pin: string) => d.nets[by(d, ref).pins[pin]!]!;
const crossing = (k: Kernel) => k.state().diagnostics.filter((x) => x.code === 'ERC.BOARD_CROSSING').map((x) => x.entities[0]).sort();

describe('import_board', () => {
  it('copies every part onto a new board with its sheet, outline and hole, nets joined by name', () => {
    const k = main();
    const rep = ok(importing(k, { project: 'ring', as: 'LED' }));
    const d = design(k);
    const led = findBoard(d, 'LED')!;
    expect(led).toBeDefined();
    expect(rep).toMatchObject({ project: 'ring', from: 'Main', board: 'LED', made: true, sheet: 'LED' });
    // J1, R1, D1 and D2 are taken by the buck and the header: next free numbers, listed
    expect(rep.renamed.refdes).toEqual({ J1: 'J3', R1: 'R4', D1: 'D2', D2: 'D3' });
    expect(rep.parts).toEqual(['D2', 'D3', 'J3', 'R4']);
    for (const ref of rep.parts) {
      expect(boardOf(d, by(d, ref)), ref).toBe(led.id);
      expect(d.sheets[by(d, ref).sheet]!.name).toBe('LED');
    }
    expect(by(d, 'R4').params).toEqual({ resistance: '100' });
    // the board as the source has it; nothing placed
    const s = settingsOf(d, led.id)!;
    expect([s.width, s.height]).toEqual([30, 30]);
    expect(s.holes).toEqual([expect.objectContaining({ d: 3.2, plated: true, netId: netOf(d, 'J2', '2').id })]);
    expect(s.placement).toBeUndefined();
    // GND and VLED joined by name, the LED clash too (no override), the automatic net new
    expect(netOf(d, 'J3', '1').id).toBe(netOf(d, 'J2', '1').id);
    expect(netOf(d, 'J3', '2').id).toBe(netOf(d, 'J2', '2').id);
    expect(netOf(d, 'D2', '1').id).toBe(netOf(d, 'R9', '2').id);
    expect(rep.nets.joined).toEqual({ GND: 'GND', LED: 'LED', VLED: 'VLED' });
    expect(rep.nets.made).toEqual([netOf(d, 'R4', '2').name]);
    expect(netOf(d, 'R4', '2').name).toMatch(/^N\$\d+$/);
    expect(Object.values(d.nets).filter((n) => n.name === 'GND')).toHaveLength(1);
    // VLED is 5 V here, 12 V on the ring: to recheck
    expect(rep.nets.recheck).toEqual([{ net: 'VLED', attrs: { voltage: { here: 5, source: 12 } } }]);
    // the describe block (in its reading order) and the left_of between R1 and D1 came along
    expect(rep.blocks).toEqual(['LED ring']);
    expect(d.description!.blocks.at(-1)).toEqual({ title: 'LED ring', components: ['J3', 'R4', 'D2', 'D3'].map((x) => by(d, x).id), text: 'Two LEDs from VLED.' });
    expect(Object.values(d.ledger).some((c) => c.kind === 'left_of' && c.a === by(d, 'R4').id && c.b === by(d, 'D2').id)).toBe(true);
    const effect = k.transact({ summary: 'noop', ops: [{ op: 'import_board', project: 'ring', as: 'LED 2' }], dry_run: true }, 'agent', undefined, sources()).results[0]!.effect;
    expect(effect).toMatch(/unplaced/);
    expect(effect).toMatch(/ERC\.BOARD_CROSSING/);
    // the nets that now cross between the boards are flagged until a mate carries them
    expect(crossing(k)).toEqual(['net:GND', 'net:LED', 'net:VLED']);
  });

  it('keeps a "fresh" net apart, maps an override, puts the prefix before nets made anew', () => {
    const k = main();
    const rep = ok(importing(k, { project: 'ring', as: 'LED', nets: { LED: 'fresh', VLED: '+12V' }, prefix: 'RING_' }));
    const d = design(k);
    expect(netOf(d, 'D2', '1').name).toBe('RING_LED');
    expect(netOf(d, 'D2', '1').id).not.toBe(netOf(d, 'R9', '2').id);
    expect(netOf(d, 'J3', '1').name).toBe('+12V');
    expect(netOf(d, 'R4', '2').name).toMatch(/^RING_N\$\d+$/);
    expect(rep.nets.joined).toEqual({ GND: 'GND', VLED: '+12V' });
    expect(rep.renamed.nets).toMatchObject({ LED: 'RING_LED' });
    // +12V is 12 V here too: nothing to recheck
    expect(rep.nets.recheck).toEqual([]);
  });

  it('makes a "fresh" net under a free name without a prefix', () => {
    const k = main();
    const rep = ok(importing(k, { project: 'ring', as: 'LED', nets: { LED: 'fresh' } }));
    expect(netOf(design(k), 'D2', '1').name).toBe('LED_2');
    expect(rep.renamed.nets).toEqual({ LED: 'LED_2' });
  });

  it('reports two source nets put on one net as a merge', () => {
    const k = main();
    const r = importing(k, { project: 'ring', as: 'LED', nets: { LED: 'GND' } });
    const rep = ok(r);
    expect(rep.nets.merged).toEqual([{ net: 'GND', from: ['GND', 'LED'] }]);
    expect(r.results[0]!.effect).toMatch(/MERGED .*GND \+ LED → GND/);
  });

  it('is mated in the same transaction: no BOARD_CROSSING after the mate', () => {
    const k = main();
    const r = importing(k, { project: 'ring', as: 'LED', nets: { LED: 'fresh' } }, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'cable' }]);
    ok(r);
    expect(crossing(k)).toEqual([]);
    const without = main();
    ok(importing(without, { project: 'ring', as: 'LED', nets: { LED: 'fresh' } }));
    expect(crossing(without)).toEqual(['net:GND', 'net:VLED']);
  });

  it('changes nothing on a dry run', () => {
    const k = main();
    const before = JSON.stringify(design(k));
    const r = importing(k, { project: 'ring', as: 'LED' }, [], sources(), true);
    expect(r.dryRun).toBe(true);
    expect(r.results[0]!.importedBoard!.parts).toHaveLength(4);
    expect(JSON.stringify(design(k))).toBe(before);
  });

  it('imports into an existing board with no parts', () => {
    const k = main([{ op: 'add_board', name: 'LED' }]);
    const id = findBoard(design(k), 'LED')!.id;
    const rep = ok(importing(k, { project: 'ring', as: 'led' }));
    const d = design(k);
    expect(rep).toMatchObject({ board: 'LED', made: false });
    expect(Object.keys(d.boards!)).toHaveLength(2);
    expect(boardOf(d, by(d, 'R4'))).toBe(id);
    expect(settingsOf(d, id)!.width).toBe(30);
  });

  it('copies one board of a project of several, onto a design of two boards', () => {
    const src = JSON.parse(twoBoards().exportDesign()) as Design;
    const k = twoBoards();
    const rep = ok(importing(k, { project: 'pair', board: 'led BOARD', as: 'Ring' }, [], sources({ pair: src })));
    expect(rep.from).toBe('LED board');
    expect(rep.renamed.refdes).toEqual({ J3: 'J4', R4: 'R5', D2: 'D3' });
    const d = design(k);
    expect(Object.keys(d.boards!)).toHaveLength(3);
    expect(rep.nets.joined).toEqual({ '+3V3': '+3V3', GND: 'GND', LED_A: 'LED_A' });
  });

  it('refuses, changing nothing: unknown project or board, a board with parts, an unknown net, a card that differs', () => {
    const k = main();
    const before = JSON.stringify(design(k));
    const refused = (op: ImportBoard, src: ImportSources | null = sources()) => importing(k, op, [], src).rejection;
    expect(refused({ project: 'nope', as: 'LED' })).toMatchObject({ code: 'PROJECT_UNKNOWN', candidates: ['main', 'ring'] });
    expect(refused({ project: 'ring', as: 'LED' }, null)?.code).toBe('PROJECT_UNKNOWN');
    expect(refused({ project: 'ring', board: 'Ring', as: 'LED' })).toMatchObject({ code: 'BOARD_UNKNOWN', candidates: expect.any(Array) });
    expect(refused({ project: 'ring', as: 'main' })).toMatchObject({ code: 'BOARD_INVALID', message: expect.stringMatching(/has parts/) });
    expect(refused({ project: 'ring', as: 'LED', nets: { VCC: 'fresh' } })).toMatchObject({ code: 'NET_UNKNOWN', candidates: expect.arrayContaining(['GND', 'LED', 'VLED']) });
    const odd = ring();
    const r1 = Object.values(odd.components).find((c) => c.refdes === 'R1')!;
    r1.pins['9'] = r1.pins['1']!;
    expect(refused({ project: 'ring', as: 'LED' }, sources({ ring: odd }))).toMatchObject({ code: 'PART_UNKNOWN', message: expect.stringMatching(/no pin 9/) });
    expect(JSON.stringify(design(k))).toBe(before);
    // a board of a design of two that has parts
    const two = twoBoards();
    const was = JSON.stringify(design(two));
    expect(importing(two, { project: 'ring', as: 'LED board' }).rejection?.code).toBe('BOARD_INVALID');
    expect(JSON.stringify(design(two))).toBe(was);
  });

  it('is undone like any edit', () => {
    const k = main();
    const before = k.exportDesign();
    ok(importing(k, { project: 'ring', as: 'LED' }));
    k.accept();
    k.undo();
    expect(k.exportDesign()).toBe(before);
  });
});
