import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Design, SheetView, SymbolView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';

/** The TPS40222 buck of docs/design/schematic-drawing.md §1, drawn by the auto-layout. */
function buck() {
  const k = new Kernel();
  k.load(JSON.parse(readFileSync(new URL('./tps40222.json', import.meta.url), 'utf8')) as Design);
  return k;
}

/** The buck with its sheet taken over: U1 moved down a little. */
function arranged() {
  const k = buck();
  const r = k.transact({ summary: 'arrange', ops: [{ op: 'place_symbol', ref: 'U1', page: 1, x: 4000, y: 4000 }] });
  expect(r.status).toBe('ok');
  k.accept();
  return k;
}

const sheetOf = (k: Kernel): SheetView => k.state().view.sheets[0]!;
const sym = (s: SheetView, ref: string): SymbolView | undefined => s.symbols.find((x) => x.refdes === ref);
const boxes = (s: SheetView) => new Map(s.symbols.map((x) => [x.refdes, x.bbox]));
const overlap = (a: SymbolView['bbox'], b: SymbolView['bbox']) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const sch = (k: Kernel, code: string) => k.state().diagnostics.filter((x) => x.code === code);

describe('a sheet nobody arranged', () => {
  it('has no stored drawing and is drawn afresh after every change', () => {
    const k = buck();
    expect(k.committedDesign().drawing).toBeUndefined();
    k.transact({ summary: 'add', ops: [{ op: 'add_part', part: 'generic:R', refdes: 'R99', params: { resistance: '1k' } }, { op: 'connect', pins: ['R99.1', 'U1.FB'] }, { op: 'connect', pins: ['R99.2'], net: 'GND' }] });
    expect(k.draftDesign().drawing).toBeUndefined();
    expect(sym(sheetOf(k), 'R99')).toBeDefined();
  });
});

describe('a sheet the agent arranged', () => {
  it('is drawn exactly as the layout drew it when nothing moved', () => {
    const k = buck();
    const before = sheetOf(k);
    const u1 = sym(before, 'U1')!;
    const page = before.pages[0]!.rect;
    // U1 "moved" to where it is: the sheet is taken over, nothing changes
    k.transact({ summary: 'take', ops: [{ op: 'place_symbol', ref: 'U1', page: 1, x: u1.bbox.x + u1.bbox.w / 2 - page.x, y: u1.bbox.y + u1.bbox.h / 2 - page.y }] });
    expect(k.draftDesign().drawing?.s_1).toBeDefined();
    const after = sheetOf(k);
    // (junction dots in any order)
    const plain = (v: SheetView) => JSON.parse(JSON.stringify({ ...v, junctions: [...v.junctions].sort((a, b) => a.x - b.x || a.y - b.y) }));
    expect(plain(after)).toEqual(plain(before));
  });

  it('keeps every part where it is when the circuit grows; a new part goes into free space', () => {
    const k = arranged();
    const before = boxes(sheetOf(k));
    k.transact({ summary: 'add', ops: [{ op: 'add_part', part: 'generic:R', refdes: 'R99', params: { resistance: '1k' } }, { op: 'connect', pins: ['R99.1', 'U1.FB'] }, { op: 'connect', pins: ['R99.2'], net: 'GND' }] });
    const s = sheetOf(k);
    for (const [ref, b] of before) expect(sym(s, ref)!.bbox, ref).toEqual(b);
    const r99 = sym(s, 'R99')!;
    for (const o of s.symbols) if (o !== r99) expect(overlap(o.bbox, r99.bbox), o.refdes).toBe(false);
    // its connection to FB is shown by labels: one at R99, one where FB is drawn already
    const fb = k.draftDesign().components;
    expect(Object.values(fb).find((c) => c.refdes === 'R99')!.pins['1']).toBeDefined();
    expect(s.labels.filter((l) => l.text === 'FB').length).toBeGreaterThanOrEqual(2);
    expect(sch(k, 'SCH.DANGLING')).toEqual([]);
  });

  it('lets a removed part go, cutting its wires back so no end is left loose', () => {
    const k = arranged();
    k.transact({ summary: 'remove', ops: [{ op: 'remove', ref: 'R2' }] });
    const s = sheetOf(k);
    expect(sym(s, 'R2')).toBeUndefined();
    expect(sch(k, 'SCH.DANGLING')).toEqual([]);
  });

  it('takes the wire away from a pin that leaves its net, and shows the connections that are left with labels', () => {
    const k = arranged();
    const d = k.committedDesign();
    const l1 = Object.values(d.components).find((c) => c.refdes === 'L1')!;
    const sw = d.nets[l1.pins['1']!]!.name;
    k.transact({ summary: 'cut', ops: [{ op: 'disconnect', pins: ['L1.1'] }] });
    const s = sheetOf(k);
    const pin = sym(s, 'L1')!.pins.find((p) => p.number === '1')!;
    expect(s.wires.some((w) => w.pts.some((_, i) => i % 2 === 0 && w.pts[i] === pin.x && w.pts[i + 1] === pin.y))).toBe(false);
    expect(s.labels.some((l) => l.x === pin.x && l.y === pin.y && l.text === sw)).toBe(false);
    expect(sch(k, 'SCH.DANGLING')).toEqual([]);
  });

  it('follows a net that is renamed', () => {
    const k = arranged();
    const vin = sheetOf(k).labels.filter((l) => l.text === 'VIN').length;
    expect(vin).toBeGreaterThan(0);
    k.transact({ summary: 'rename', ops: [{ op: 'set_net', net: 'VIN', rename: 'VIN_12V' }] });
    const s = sheetOf(k);
    expect(s.labels.some((l) => l.text === 'VIN')).toBe(false);
    expect(s.labels.filter((l) => l.text === 'VIN_12V')).toHaveLength(vin);
  });

  it('keeps the drawing of two nets that are joined into one: their wires and symbols take the joined net', () => {
    const k = arranged();
    const before = sheetOf(k);
    const avin = before.labels.filter((l) => l.text === 'AVIN').length;
    const vin = before.labels.filter((l) => l.text === 'VIN').length;
    // every AVIN pin goes to VIN: the AVIN net is gone
    const pins = ['U1.5', 'C5.1', 'R4.2'];
    const r = k.transact({ summary: 'join', ops: [{ op: 'disconnect', pins }, { op: 'connect', pins, net: 'VIN' }] });
    expect(r.status).toBe('ok');
    const s = sheetOf(k);
    expect(Object.values(k.draftDesign().nets).some((n) => n.name === 'AVIN')).toBe(false);
    expect(s.labels.filter((l) => l.text === 'VIN' && !l.auto).length).toBe(avin + vin);
    expect(sch(k, 'SCH.DANGLING')).toEqual([]);
  });

  it('is handed back to the auto-layout with auto_draw, or redraws some parts in free space', () => {
    const k = arranged();
    const r = k.transact({ summary: 'redraw', ops: [{ op: 'auto_draw', refs: ['R1'] }] });
    expect(r.results[0]!.effect).toMatch(/R1 drawn afresh in free space/);
    expect(k.draftDesign().drawing?.s_1).toBeDefined();
    const back = k.transact({ summary: 'back', ops: [{ op: 'auto_draw' }] });
    expect(back.results[0]!.effect).toMatch(/Main: drawn by the auto-layout again/);
    expect(k.draftDesign().drawing).toBeUndefined();
    expect(boxes(sheetOf(k))).toEqual(boxes(buck().state().view.sheets[0]!));
  });

  it('shows the arrangement as a changeset hunk of its own, and undo takes it back', () => {
    const k = buck();
    k.transact({ summary: 'arrange', ops: [{ op: 'place_symbol', ref: 'U1', page: 1, x: 4000, y: 4000 }] });
    const h = k.proposal()!.hunks;
    expect(h.map((x) => x.title)).toEqual(['schematic Main: arranged by the agent from here on']);
    k.accept();
    k.transact({ summary: 'move', ops: [{ op: 'place_symbol', ref: 'J1', page: 1, x: 1500, y: 6500 }] });
    expect(k.proposal()!.hunks[0]!.details).toEqual(['moved: J1']);
    k.accept();
    k.undo();
    k.undo();
    expect(k.committedDesign().drawing).toBeUndefined();
  });

  it('keeps a part accepted without its drawing hunk: it is drawn in free space', () => {
    const k = arranged();
    k.transact({ summary: 'add', ops: [{ op: 'add_part', part: 'generic:C', refdes: 'C99', params: { capacitance: '1uF' } }, { op: 'connect', pins: ['C99.1'], net: 'VOUT' }, { op: 'connect', pins: ['C99.2'], net: 'GND' }] });
    const hunks = k.proposal()!.hunks;
    const part = hunks.find((x) => x.kind === 'component')!;
    expect(hunks.some((x) => x.kind === 'drawing')).toBe(true);
    k.accept([part.id]);
    expect(sym(sheetOf(k), 'C99')).toBeDefined();
    expect(k.committedDesign().drawing!.s_1!.symbols.some((x) => x.comp === Object.values(k.committedDesign().components).find((c) => c.refdes === 'C99')!.id)).toBe(true);
  });

  it('sizes its pages to the paper', () => {
    const k = arranged();
    k.transact({ summary: 'paper', ops: [{ op: 'set_paper', size: 'A3' }] });
    const p = sheetOf(k).pages[0]!.rect;
    expect([p.w, p.h]).toEqual([16500, 11700]);
  });

  it('is saved with the design and drawn the same after loading', () => {
    const k = arranged();
    const view = boxes(sheetOf(k));
    const again = new Kernel();
    again.load(JSON.parse(JSON.stringify(k.committedDesign())) as Design);
    expect(boxes(again.state().view.sheets[0]!)).toEqual(view);
  });
});
