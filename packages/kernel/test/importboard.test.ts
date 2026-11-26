/**
 * import_board (D29 step 3): a whole board of another project copied in as a board of this design,
 * nets joined by name. The open design is the buck of the shared fixtures, with a header J2 (VLED,
 * GND) and its own LED net; the source is a small LED ring. See docs/design/ops-api.md §7.
 */
import { describe, expect, it } from 'vitest';
import { FIRST_BOARD, type Design, type EditOp, type Track, type Transaction } from '@4k7/schema';
import { Kernel, boardOf } from '../src/index.ts';
import { findBoard, focusBoard, settingsOf } from '../src/boards.ts';
import { copperKey } from '../src/board.ts';
import type { ImportSources } from '../src/importops.ts';
import { buck, twoBoards } from './fixtures.ts';

type ImportBoard = Omit<Extract<EditOp, { op: 'import_board' }>, 'op'>;

/**
 * "ring": J1 (VLED 12 V, GND), R1 → D1 on an automatic net, D1 → D2 on LED, a 30 × 30 mm board with a
 * GND hole, laid out: J1 locked at the edge (a hard pin), D1 placed with R1 attached to it (a soft pin
 * relative to D1), D2 on the bottom, R1 near D1, a room for the block, a keep-out on D1, a silkscreen
 * text and a 2 × 1 panel.
 */
function ring(extra: EditOp[] = []): Design {
  return JSON.parse(ringKernel(extra).exportDesign()) as Design;
}

/** The ring's kernel; `extra` ops after its circuit (in the same transaction). */
function ringKernel(extra: EditOp[] = []): Kernel {
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
    ...extra,
  ];
  const r = k.transact({ summary: 'ring', ops });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
  const layout = k.transact({
    summary: 'ring layout',
    ops: [
      { op: 'place', ref: 'J1', x_mm: 4, y_mm: 15, rot: 90, lock: true },
      { op: 'attach', ref: 'R1', to: 'D1' },
      { op: 'place', ref: 'D1', x_mm: 15, y_mm: 9 },
      { op: 'place', ref: 'R1', x_mm: 15, y_mm: 14, rot: 90 },
      { op: 'place', ref: 'D2', x_mm: 22, y_mm: 22, rot: 180, side: 'bottom' },
      { op: 'constrain', kind: 'near', a: 'R1', b: 'D1', max_mm: 10 },
      { op: 'constrain', kind: 'room', block: 'LED ring', rect: { x: 1, y: 1, w: 28, h: 28 } },
      { op: 'add_keepout', name: 'lens', part: 'D1', rect: { x_mm: -2, y_mm: -2, width_mm: 4, height_mm: 4 }, forbid: ['vias'] },
      { op: 'add_graphic', text: 'RING', x_mm: 15, y_mm: 26, height_mm: 2 },
      { op: 'set_panel', cols: 2, rows: 1 },
    ],
  });
  expect(layout.status, JSON.stringify(layout.rejection)).toBe('ok');
  k.accept();
  return k;
}

/** A placed part as get_board shows it. */
type Placed = { refdes: string; x: number; y: number; rot: number; side: string };
const placed = (a: unknown, rename: Record<string, string> = {}): Placed[] =>
  (a as { parts: Placed[] }).parts.map(({ refdes, x, y, rot, side }) => ({ refdes: rename[refdes] ?? refdes, x, y, rot, side })).sort((p, q) => p.refdes.localeCompare(q.refdes));

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
/** A board of the open design as get_board shows it, its stored settings and its copper key. */
const boardState = (k: Kernel, board: string) => {
  const d = design(k);
  const id = findBoard(d, board)!.id;
  return { parts: placed(k.query({ op: 'get_board', board })), settings: JSON.stringify(settingsOf(d, id) ?? null), copper: copperKey(focusBoard(d, id)) };
};
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
    expect(effect).toMatch(/placement of 4 part\(s\)/);
    // the ring was never routed: no copper to bring, the board to route
    expect(effect).toMatch(/no copper in the source: route the board/);
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

  it('keeps the footprint a generic part had in the source, on a card of its own; the parts here keep theirs (D30.6)', () => {
    // the ring's J1 and J5 on land patterns of their own; the open design's J5 on a socket, J2 and J3 on the library's header
    const header = [{ number: '1', x: -1.25, y: 0, w: 1.2, h: 1.8 }, { number: '2', x: 1.25, y: 0, w: 1.2, h: 1.8 }];
    const three = (w: number, h: number, pitch: number) => ['1', '2', '3'].map((number, i) => ({ number, x: (i - 1) * pitch, y: 0, w, h }));
    const srcK = ringKernel([
      { op: 'set_footprint', ref: 'J1', name: 'HDR-OWN', pads: header },
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J6' },
      { op: 'add_part', part: 'generic:CONN_1x3', refdes: 'J5' },
      { op: 'set_footprint', ref: 'J5', name: 'HDR3-OWN', pads: three(1.2, 1.8, 2.54) },
    ]);
    const src = JSON.parse(srcK.exportDesign()) as Design;
    const k = twoBoards();
    expect(k.transact({ summary: 'socket', ops: [{ op: 'add_part', part: 'generic:CONN_1x3', refdes: 'J5', sheet: 'LED' }, { op: 'set_footprint', ref: 'J5', name: 'SOCKET', pads: three(3, 1, 3.5) }] }).status).toBe('ok');
    k.accept();
    const parts = JSON.stringify(design(k).parts);
    const pads = (k2: Kernel, board: string | undefined, ref: string) =>
      k2.board({}, board ? findBoard(design(k2), board)!.id : undefined).parts.find((p) => p.refdes === ref)!.pads.map(({ number, x, y, w, h }) => ({ number, x, y, w, h }));
    const own = ['J2', 'J3', 'J5'].map((ref) => [ref, pads(k, ref === 'J2' ? undefined : 'LED board', ref)] as const);
    const r = importing(k, { project: 'ring', as: 'Ring' }, [], sources({ ring: src }));
    const rep = ok(r);
    const d = design(k);
    const j1 = rep.renamed.refdes.J1 ?? 'J1';
    const j5 = rep.renamed.refdes.J5 ?? 'J5';
    const j6 = rep.renamed.refdes.J6 ?? 'J6';
    // J1 and J6 shared one card there: they share the one new card here
    expect([by(d, j1).part, by(d, j6).part, by(d, j5).part]).toEqual(['generic:CONN_1x2~2', 'generic:CONN_1x2~2', 'generic:CONN_1x3~2']);
    expect(d.parts['generic:CONN_1x2~2']!.packageInfo).toEqual(src.parts['generic:CONN_1x2']!.packageInfo);
    expect(d.parts['generic:CONN_1x3~2']!.packageInfo).toEqual(src.parts['generic:CONN_1x3']!.packageInfo);
    // the cards and footprints of the parts already here are as they were
    expect(JSON.stringify(Object.fromEntries(Object.entries(d.parts).filter(([id]) => !id.includes('~'))))).toBe(parts);
    for (const [ref, was] of own) expect(pads(k, ref === 'J2' ? undefined : 'LED board', ref), ref).toEqual(was);
    // the locked J1 lands on the source's pads, where the source has them
    expect(pads(k, 'Ring', j1)).toEqual(pads(srcK, undefined, 'J1'));
    expect(rep.footprints).toEqual([{ ref: j1, card: 'generic:CONN_1x2~2' }, { ref: j5, card: 'generic:CONN_1x3~2' }, { ref: j6, card: 'generic:CONN_1x2~2' }]);
    expect(r.results[0]!.effect).toContain(`${j1} keeps its footprint from ring (card generic:CONN_1x2~2)`);
    // saved and loaded, then undone: the same
    k.accept();
    const saved = k.exportDesign();
    const again = new Kernel();
    again.load(JSON.parse(saved) as Design);
    expect(pads(again, 'Ring', j1)).toEqual(pads(srcK, undefined, 'J1'));
    k.undo();
    expect(JSON.stringify(design(k).parts)).toBe(parts);
  });

  it('brings no card and no footprint note where the footprint is the same here', () => {
    const k = twoBoards();
    const parts = JSON.stringify(design(k).parts);
    const r = importing(k, { project: 'ring', as: 'Ring' });
    expect(ok(r).footprints).toEqual([]);
    expect(r.results[0]!.effect).not.toMatch(/keeps its footprint/);
    expect(JSON.stringify(design(k).parts)).toBe(parts);
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

/**
 * D29 step 4: the board keeps the source's layout. The reference is the source as get_board { project }
 * shows it, read from the open design before the import (no hand-typed positions).
 */
describe('import_board: the placement', () => {
  const ofProject = (k: Kernel, src: ImportSources, project: string, board?: string) =>
    k.query({ op: 'get_board', project, ...(board ? { board } : {}) }, { sources: src });
  const on = (d: Design, kind: string, ref: string) => Object.values(d.ledger).filter((c) => c.kind === kind && c.a === by(d, ref).id);

  it('puts every part where the source has it, with its pins, side, keep-out, graphics and panel; the main board unchanged', () => {
    const src = sources();
    const k = main();
    const want = ofProject(k, src, 'ring');
    const before = boardState(k, 'Main');
    const r = importing(k, { project: 'ring', as: 'LED' }, [], src);
    const rep = ok(r);
    k.accept();
    const d = design(k);
    const led = findBoard(d, 'LED')!;
    // no drift: x, y, rot and side as in the source (J1 → J3, R1 → R4, D1 → D2, D2 → D3)
    expect(placed(k.query({ op: 'get_board', board: 'LED' }))).toEqual(placed(want, rep.renamed.refdes));
    expect(placed(want).find((p) => p.refdes === 'D2')!.side).toBe('bottom');
    // the hard pin is still hard, on J3; R4's pin is relative to D2 (the source's D1)
    expect(on(d, 'position', 'J3')).toEqual([expect.objectContaining({ strength: 'hard', xMm: 4, yMm: 15, rot: 90 })]);
    expect(on(d, 'position', 'R4')).toEqual([expect.objectContaining({ strength: 'soft', rel: by(d, 'D2').id })]);
    expect(on(d, 'layer', 'D3')).toEqual([expect.objectContaining({ value: 'bottom' })]);
    expect(on(d, 'near', 'R4')).toEqual([expect.objectContaining({ b: by(d, 'D2').id, maxMm: 10 })]);
    expect(on(d, 'belongs', 'R4')).toEqual([expect.objectContaining({ b: by(d, 'D2').id })]);
    expect(Object.values(d.ledger).filter((c) => c.kind === 'room')).toEqual([expect.objectContaining({ key: 'LED ring', wMm: 28 })]);
    // each constraint once: the kinds on the new board are the source's
    const ring0 = JSON.parse(src.files.ring!) as Design;
    const ids = new Set(rep.parts.map((x) => by(d, x).id));
    const kinds = (l: Design['ledger'], has: (id: string) => boolean) => Object.values(l).filter((c) => (c.a ? has(c.a) : c.kind === 'room')).map((c) => c.kind).sort();
    expect(kinds(d.ledger, (id) => ids.has(id))).toEqual(kinds(ring0.ledger, () => true));
    // the keep-out follows D2 (the source's D1) under its own id; graphics and panel as they were
    const s = settingsOf(d, led.id)!;
    expect(s.keepouts).toEqual([{ ...ring0.board!.keepouts![0]!, part: by(d, 'D2').id }]);
    expect(s.keepouts![0]!.id).toBe('KO1');
    expect(s.graphics).toEqual(ring0.board!.graphics);
    expect(s.panel).toEqual(ring0.board!.panel);
    // and stands where the source's stands, round D2
    type Kos = { keepouts: { follows: string; bounds_mm: number[] }[] };
    expect((k.query({ op: 'get_board', board: 'LED' }) as Kos).keepouts).toEqual([{ ...(want as Kos).keepouts[0]!, follows: 'D2' }]);
    // the ring has no copper: nothing stays behind
    expect(rep.left_behind).toEqual([]);
    expect(r.results[0]!.effect).toMatch(/placement of 4 part\(s\) \(1 locked\), 1 keep-out\(s\), 1 graphic\(s\), panel/);
    // the main board: placement, settings and copper key as before
    expect(boardState(k, 'Main')).toEqual(before);
  });

  it('copies one board of a two-board project, laid out, onto a design of two boards; both its boards unchanged', () => {
    const pair = twoBoards();
    const laid = pair.transact({
      summary: 'LED layout',
      ops: [
        { op: 'place', board: 'LED board', ref: 'R4', x_mm: 6, y_mm: 4, rot: 90 },
        { op: 'place', board: 'LED board', ref: 'J3', x_mm: 14, y_mm: 6, side: 'bottom', lock: true },
      ],
    });
    expect(laid.status, JSON.stringify(laid.rejection)).toBe('ok');
    pair.accept();
    const src = sources({ pair: JSON.parse(pair.exportDesign()) as Design });
    const k = twoBoards();
    const want = ofProject(k, src, 'pair', 'LED board');
    const before = [boardState(k, 'Main'), boardState(k, 'LED board')];
    const rep = ok(importing(k, { project: 'pair', board: 'LED board', as: 'Ring' }, [], src));
    k.accept();
    expect(placed(k.query({ op: 'get_board', board: 'Ring' }))).toEqual(placed(want, rep.renamed.refdes));
    expect(placed(want).find((p) => p.refdes === 'J3')).toMatchObject({ x: 14, side: 'bottom' });
    expect(on(design(k), 'position', 'J4')).toEqual([expect.objectContaining({ strength: 'hard' })]);
    expect([boardState(k, 'Main'), boardState(k, 'LED board')]).toEqual(before);
  });

  it('points a room at the block\'s new title when the title was taken', () => {
    const src = sources();
    const k = main();
    const want = ofProject(k, src, 'ring');
    ok(importing(k, { project: 'ring', as: 'LED' }, [], src));
    k.accept();
    const rep = ok(importing(k, { project: 'ring', as: 'LED 2' }, [], src));
    k.accept();
    expect(rep.blocks).toEqual(['LED ring (2)']);
    expect(Object.values(design(k).ledger).filter((c) => c.kind === 'room').map((c) => c.key)).toEqual(['LED ring', 'LED ring (2)']);
    expect(placed(k.query({ op: 'get_board', board: 'LED 2' }))).toEqual(placed(want, rep.renamed.refdes));
  });
});

/**
 * D29 step 5: the copper comes along, every id remapped. Drawn copper as it is (the board is routed at
 * once); the router's copper, where it is current for the source, as locked copper the first route
 * lays as it lies; stale copper not at all. The target is a design of two boards; the reference is the
 * source's own board view.
 */
describe('import_board: the copper', () => {
  /** The ring routed (and the copper kept with it, as the app does), then `then` on it. */
  const routedRing = (then: EditOp[] = [], reroute = false): Design => {
    const k = ringKernel();
    const route = () => {
      expect(k.transact({ summary: 'route', ops: [{ op: 'route' }] }).status).toBe('ok');
      k.keepCopper(k.board().newCopper!);
      k.accept();
    };
    route();
    if (then.length) {
      const r = k.transact({ summary: 'then', ops: then });
      expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
      k.accept();
    }
    if (reroute) route();
    return JSON.parse(k.exportDesign()) as Design;
  };
  /** The source's board view, as it routes (or draws) it. */
  const viewOf = (src: Design) => {
    const k = new Kernel();
    k.load(structuredClone(src));
    return k.board();
  };
  const geometry = (ts: Track[]) => ts.map(({ layer, width, pts }) => JSON.stringify({ layer, width, pts })).sort();
  const errors = (b: { diagnostics: { code: string; severity: string; waivedBy?: string }[] }) => b.diagnostics.filter((x) => x.code.startsWith('DRC.') && x.severity === 'error' && !x.waivedBy).map((x) => x.code);
  const boardId = (k: Kernel, name: string) => findBoard(design(k), name)!.id;

  it('brings drawn copper over with the nets and parts of this design: the board is routed at once, the other boards unchanged', () => {
    const srcDesign = routedRing([{ op: 'set_copper_mode', mode: 'drawn' }]);
    const src = viewOf(srcDesign);
    expect(src.routing).toBe('done');
    expect(src.tracks.length).toBeGreaterThan(0);
    const k = twoBoards();
    const before = [boardState(k, 'Main'), boardState(k, 'LED board')];
    const r = importing(k, { project: 'ring', as: 'Ring', nets: { VLED: '+3V3', LED: 'LED_A' } }, [], sources({ ring: srcDesign }));
    const rep = ok(r);
    k.accept();
    const d = design(k);
    const id = boardId(k, 'Ring');
    const b = k.board({}, id);
    expect(b.routing).toBe('done');
    expect(errors(b)).toEqual(errors(src));
    expect(geometry(b.tracks)).toEqual(geometry(src.tracks));
    expect(b.vias.length).toBe(src.vias.length);
    // every track on the net of this design its pads are on (+3V3 and LED_A joined under other names), its ends on the new parts
    const drawn = settingsOf(d, id)!.drawn!;
    expect(drawn.next).toBe(srcDesign.board!.drawn!.next);
    expect(drawn.tracks.map((t) => t.id)).toEqual(srcDesign.board!.drawn!.tracks.map((t) => t.id));
    const mine = new Set(rep.parts.map((x) => by(d, x).id));
    for (const t of drawn.tracks) {
      for (const end of [t.from, t.to]) {
        if (!end) continue;
        expect(mine.has(end.componentId)).toBe(true);
        expect(d.components[end.componentId]!.pins[end.pad]).toBe(t.netId);
      }
    }
    const names = new Set(drawn.tracks.map((t) => d.nets[t.netId]!.name));
    expect(names).toContain('+3V3');
    expect(names).toContain('LED_A');
    expect(drawn.vias.every((v) => d.nets[v.netId] !== undefined)).toBe(true);
    expect(rep.left_behind).toEqual([]);
    expect(r.results[0]!.effect).toMatch(/drawn copper \(\d+ tracks?, \d+ vias?\): routed as drawn/);
    expect(r.results[0]!.effect).not.toMatch(/route the board/);
    expect([boardState(k, 'Main'), boardState(k, 'LED board')]).toEqual(before);
  });

  it('turns current router copper into locked copper, which the first route lays as it lies and keeps locked', () => {
    // GND locked in the source too (its lock kept), then routed again so the copper is current
    const srcDesign = routedRing([{ op: 'lock_copper', nets: ['GND'] }], true);
    const src = viewOf(srcDesign);
    expect(src.routing).toBe('done');
    const k = twoBoards();
    const before = [boardState(k, 'Main'), boardState(k, 'LED board')];
    const r = importing(k, { project: 'ring', as: 'Ring' }, [], sources({ ring: srcDesign }));
    const rep = ok(r);
    k.accept();
    const d = design(k);
    const id = boardId(k, 'Ring');
    const s = settingsOf(d, id)!;
    // not the cache: locked copper, one entry per net, on this design's nets
    expect(s.copper).toBeUndefined();
    expect(s.routed).toBeUndefined();
    const locked = s.locked!;
    expect(new Set(locked.map((l) => l.netId)).size).toBe(locked.length);
    expect(locked.map((l) => d.nets[l.netId]!.name).sort()).toEqual(['GND', 'LED', 'VLED', netOf(d, 'R5', '2').name].sort());
    for (const l of locked) expect([...l.tracks, ...l.vias].every((x) => x.netId === l.netId)).toBe(true);
    expect(geometry(locked.flatMap((l) => l.tracks))).toEqual(geometry(src.tracks.filter((t) => !t.laid)));
    expect(rep.left_behind).toEqual([]);
    expect(r.results[0]!.effect).toMatch(/locked copper of 4 net\(s\) \(\d+ tracks, \d+ vias; from its routing, 1 locked there already\)/);
    expect(r.results[0]!.effect).toMatch(/route the board: it lays the locked copper first/);
    // the first route lays every locked track and via as it lies
    expect(k.transact({ summary: 'route', ops: [{ op: 'route', board: 'Ring' }] }).status).toBe('ok');
    const b = k.board({}, id);
    expect(b.routing).toBe('done');
    expect(b.locked!.length).toBe(locked.length);
    for (const l of b.locked!) expect([l.heldTracks, l.heldVias]).toEqual([l.tracks, l.vias]);
    expect(geometry(b.tracks)).toEqual(geometry(src.tracks));
    expect(errors(b)).toEqual([]);
    // and keeps it locked (D29 decision 4)
    k.keepCopper(b.newCopper!);
    k.accept();
    expect(settingsOf(design(k), id)!.locked).toEqual(locked);
    expect([boardState(k, 'Main'), boardState(k, 'LED board')]).toEqual(before);
  });

  it('leaves stale or stopped router copper behind: route the board', () => {
    const stale = routedRing([{ op: 'place', ref: 'D2', x_mm: 20, y_mm: 22, rot: 180, side: 'bottom' }]);
    expect(viewOf(stale).routing).toBe('stale');
    const stopped = routedRing();
    stopped.board!.copper!.stopped = true;
    for (const srcDesign of [stale, stopped]) {
      const k = twoBoards();
      const r = importing(k, { project: 'ring', as: 'Ring' }, [], sources({ ring: srcDesign }));
      const rep = ok(r);
      const s = settingsOf(design(k), boardId(k, 'Ring'))!;
      expect([s.copper, s.routed, s.locked, s.drawn]).toEqual([undefined, undefined, undefined, undefined]);
      expect(rep.left_behind).toEqual(['copper']);
      expect(r.results[0]!.effect).toMatch(/not brought over: copper \((stale|stopped)[^)]*\): route the board/);
    }
  });

  it('merges the locked copper of two source nets put on one net into one', () => {
    const srcDesign = routedRing();
    const k = twoBoards();
    ok(importing(k, { project: 'ring', as: 'Ring', nets: { LED: 'GND' } }, [], sources({ ring: srcDesign })));
    const d = design(k);
    const locked = settingsOf(d, boardId(k, 'Ring'))!.locked!;
    const gnd = locked.filter((l) => d.nets[l.netId]!.name === 'GND');
    expect(gnd).toHaveLength(1);
    const src = viewOf(srcDesign);
    const named = (n: string) => src.tracks.filter((t) => src.netNames[t.netId] === n);
    expect(gnd[0]!.tracks).toHaveLength(named('GND').length + named('LED').length);
  });

  it('remaps planes, via groups and impedance rules onto the new parts and nets', () => {
    const k0 = ringKernel();
    const r0 = k0.transact({
      summary: 'copper rules',
      ops: [
        { op: 'set_plane', layer: 'F.Cu', net: 'GND', under: ['D2'] },
        { op: 'add_vias', kind: 'grid', net: 'GND', under: ['D1'] },
        { op: 'set_impedance', nets: ['LED'], ohms: 50 },
      ],
    });
    expect(r0.status, JSON.stringify(r0.rejection)).toBe('ok');
    k0.accept();
    const srcDesign = JSON.parse(k0.exportDesign()) as Design;
    const k = twoBoards();
    ok(importing(k, { project: 'ring', as: 'Ring', nets: { LED: 'LED_A' } }, [], sources({ ring: srcDesign })));
    const d = design(k);
    const s = settingsOf(d, boardId(k, 'Ring'))!;
    const gnd = netOf(d, 'J2', '2').id;
    expect(s.planes!.find((p) => p.layer === 'F.Cu')).toMatchObject({ netId: gnd, area: { under: [by(d, 'D4').id] } });
    expect(s.vias).toEqual([expect.objectContaining({ id: 'V1', netId: gnd, area: expect.objectContaining({ under: [by(d, 'D3').id] }) })]);
    expect(s.impedance).toEqual([expect.objectContaining({ id: 'Z1', nets: [netOf(d, 'R4', '2').id], ohms: 50 })]);
  });

  it('changes nothing on a dry run, and is undone like any edit', () => {
    const src = sources({ ring: routedRing([{ op: 'set_copper_mode', mode: 'drawn' }]) });
    const k = twoBoards();
    const before = k.exportDesign();
    const was = JSON.stringify(design(k));
    expect(importing(k, { project: 'ring', as: 'Ring' }, [], src, true).dryRun).toBe(true);
    expect(JSON.stringify(design(k))).toBe(was);
    ok(importing(k, { project: 'ring', as: 'Ring' }, [], sources({ ring: routedRing() })));
    k.accept();
    k.undo();
    expect(k.exportDesign()).toBe(before);
  });
});

/**
 * D29 step 6: a source net that joins a net of this design keeps the source's track width on the new
 * board only (boardTrackWidths), never the net's own width or another board's. Martin's case: LED_A is
 * 0.4 mm here (on Main and the LED board), 0.8 mm in the ring.
 */
describe('import_board: track widths on joined nets', () => {
  /** twoBoards with R9 on Main on LED_A too, LED_A 0.4 mm. */
  const target = () => {
    const k = twoBoards();
    const r = k.transact({
      summary: 'LED_A 0.4 mm',
      ops: [
        { op: 'add_part', part: 'generic:R', refdes: 'R9', params: { resistance: '1k' } },
        { op: 'connect', pins: ['R9.1'], net: 'LED_A' },
        { op: 'set_net', net: 'LED_A', track_mm: 0.4 },
      ],
    });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    k.accept();
    return k;
  };
  /** The ring with its LED net called LED_A, `width` ops on it. */
  const ringLedA = (width: EditOp[]) => sources({ ring: ring([{ op: 'set_net', net: 'LED', rename: 'LED_A' }, ...width]) });
  const ledA = (k: Kernel) => Object.values(design(k).nets).find((n) => n.name === 'LED_A')!;
  const byBoard = (k: Kernel) =>
    Object.fromEntries((k.query({ op: 'get_net', net: 'LED_A' }) as { track: { by_board: { board: string; width_mm: number }[] } }).track.by_board.map((b) => [b.board, b.width_mm]));

  it('keeps 0.4 mm on the boards of this design and gives the new board the source\'s 0.8 mm', () => {
    const k = target();
    const r = importing(k, { project: 'ring', as: 'Ring' }, [], ringLedA([{ op: 'set_net', net: 'LED_A', track_mm: 0.8 }]));
    const rep = ok(r);
    k.accept();
    const n = ledA(k);
    expect(n.attrs.trackWidth).toBe(0.4);
    expect(n.attrs.boardTrackWidths).toEqual({ [findBoard(design(k), 'Ring')!.id]: 0.8 });
    expect(byBoard(k)).toEqual({ Main: 0.4, 'LED board': 0.4, Ring: 0.8 });
    // kept per board, so not a width to recheck
    expect(rep.nets.widths).toEqual([{ net: 'LED_A', mm: 0.8, here: 0.4, from: ['LED_A'] }]);
    expect(rep.nets.recheck.filter((x) => x.net === 'LED_A')).toEqual([]);
    expect(r.results[0]!.effect).toMatch(/track widths kept for board "Ring": LED_A 0\.8 mm \(0\.4 mm on the others\)/);
  });

  it('routes the new board at 0.8 mm and leaves the copper of the other boards as it was', () => {
    const k = target();
    const before = [boardState(k, 'Main').copper, boardState(k, 'LED board').copper];
    ok(importing(k, { project: 'ring', as: 'Ring' }, [], ringLedA([{ op: 'set_net', net: 'LED_A', track_mm: 0.8 }])));
    k.accept();
    expect(k.transact({ summary: 'route', ops: [{ op: 'route', board: 'Ring' }] }).status).toBe('ok');
    k.accept();
    expect([boardState(k, 'Main').copper, boardState(k, 'LED board').copper]).toEqual(before);
    const b = k.board({}, findBoard(design(k), 'Ring')!.id);
    // the widest track on LED_A is the new board's 0.8 mm (narrower only where it necks down at a pad)
    expect(Math.max(...b.tracks.filter((t) => b.netNames[t.netId] === 'LED_A').map((t) => t.width))).toBe(0.8);
  });

  it('writes nothing when the widths agree, or the source sets none', () => {
    for (const width of [[{ op: 'set_net', net: 'LED_A', track_mm: 0.4 }], []] as EditOp[][]) {
      const k = target();
      const rep = ok(importing(k, { project: 'ring', as: 'Ring' }, [], ringLedA(width)));
      expect(ledA(k).attrs.boardTrackWidths).toBeUndefined();
      expect(ledA(k).attrs.trackWidth).toBe(0.4);
      expect(rep.nets.widths).toEqual([]);
    }
  });

  it('takes the width the source set for its own board over the net\'s', () => {
    const k = target();
    const rep = ok(importing(k, { project: 'ring', as: 'Ring' }, [], ringLedA([
      { op: 'set_net', net: 'LED_A', track_mm: 0.3 },
      { op: 'set_net', net: 'LED_A', track_mm: 0.8, board: 'Main' },
    ])));
    expect(ledA(k).attrs.boardTrackWidths).toEqual({ [findBoard(design(k), 'Ring')!.id]: 0.8 });
    expect(byBoard(k)).toEqual({ Main: 0.4, 'LED board': 0.4, Ring: 0.8 });
    expect(rep.nets.widths).toEqual([{ net: 'LED_A', mm: 0.8, here: 0.4, from: ['LED_A'] }]);
  });

  it('gives a merged net the wider of its source nets\' widths, whichever comes first', () => {
    for (const [led, vled] of [[0.8, 0.6], [0.6, 0.8]]) {
      const k = target();
      const r = importing(k, { project: 'ring', as: 'Ring', nets: { VLED: 'LED_A' } }, [], ringLedA([
        { op: 'set_net', net: 'LED_A', track_mm: led! },
        { op: 'set_net', net: 'VLED', track_mm: vled! },
      ]));
      const rep = ok(r);
      expect(rep.nets.merged).toEqual([{ net: 'LED_A', from: ['LED_A', 'VLED'] }]);
      expect(ledA(k).attrs.boardTrackWidths).toEqual({ [findBoard(design(k), 'Ring')!.id]: 0.8 });
      expect(ledA(k).attrs.trackWidth).toBe(0.4);
      expect(rep.nets.widths).toEqual([{ net: 'LED_A', mm: 0.8, here: 0.4, from: ['LED_A', 'VLED'] }]);
      expect(r.results[0]!.effect).toMatch(/LED_A 0\.8 mm \(the wider of LED_A [\d.]+ mm, VLED [\d.]+ mm; 0\.4 mm on the others\)/);
    }
  });

  it('changes nothing on a dry run, and is undone like any edit', () => {
    const src = ringLedA([{ op: 'set_net', net: 'LED_A', track_mm: 0.8 }]);
    const k = target();
    const before = k.exportDesign();
    const was = JSON.stringify(design(k));
    expect(importing(k, { project: 'ring', as: 'Ring' }, [], src, true).dryRun).toBe(true);
    expect(JSON.stringify(design(k))).toBe(was);
    ok(importing(k, { project: 'ring', as: 'Ring' }, [], src));
    k.accept();
    expect(ledA(k).attrs.boardTrackWidths).toBeDefined();
    k.undo();
    expect(k.exportDesign()).toBe(before);
  });
});
