import { describe, expect, it } from 'vitest';
import type { PartCard, SheetView, SymbolView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';

/** A plain IC: two inputs on the left, an output on the right, supply on top and bottom. */
const ic = (id: string): PartCard => ({
  id,
  mpn: id,
  description: 'ic',
  category: 'ic',
  refPrefix: 'U',
  pins: [
    { number: '1', name: 'IN1', type: 'in' },
    { number: '2', name: 'IN2', type: 'in' },
    { number: '3', name: 'OUT', type: 'out' },
    { number: '4', name: 'VCC', type: 'pwr_in' },
    { number: '5', name: 'GND', type: 'pwr_in' },
  ],
  params: {},
  provenance: { source: 'datasheet' },
});

function kernelWith(ops: object[], parts: PartCard[] = [ic('acme:IC')]) {
  const k = new Kernel();
  const d = k.committedDesign();
  for (const p of parts) d.parts[p.id] = p;
  k.load(d);
  const r = k.transact({ summary: 'circuit', ops } as never);
  expect(r.rejection).toBeUndefined();
  return k;
}

/** J1 → R1 → U1.IN1, R2 from U1.IN2 to ground, U1.OUT → J2: a small signal chain. */
const chain = [
  { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
  { op: 'add_part', part: 'acme:IC', refdes: 'U1' },
  { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J2' },
  { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
  { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '10k' } },
  { op: 'connect', pins: ['J1.1', 'R1.1'], net: 'IN' },
  { op: 'connect', pins: ['R1.2', 'U1.IN1'], net: 'IN_F' },
  { op: 'connect', pins: ['U1.IN2', 'R2.1'], net: 'BIAS' },
  { op: 'connect', pins: ['U1.OUT', 'J2.1'], net: 'OUT' },
  { op: 'connect', pins: ['J1.2', 'J2.2', 'R2.2', 'U1.GND'], net: 'GND' },
  { op: 'connect', pins: ['U1.VCC'], net: '+5V' },
  { op: 'set_net', net: '+5V', voltage: 5 },
];

const sheetOf = (k: Kernel): SheetView => k.state().view.sheets[0]!;
const sym = (s: SheetView, ref: string): SymbolView => s.symbols.find((x) => x.refdes === ref)!;
const centre = (x: SymbolView) => ({ x: x.bbox.x + x.bbox.w / 2, y: x.bbox.y + x.bbox.h / 2 });
const overlap = (a: SymbolView['bbox'], b: SymbolView['bbox']) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('the agent places parts on the schematic (place_symbol)', () => {
  it('puts an IC where it says with its small parts, and leaves the rest where it was', () => {
    const k = kernelWith(chain);
    const before = sheetOf(k);
    const r = k.transact({ summary: 'place', ops: [{ op: 'place_symbol', ref: 'U1', page: 1, x: 6000, y: 6000 }] });
    expect(r.status).toBe('ok');
    expect(r.results[0]!.effect).toMatch(/sheet Main is drawn as you arrange it from now on/);
    const s = sheetOf(k);
    const page = s.pages[0]!.rect;
    const u1 = centre(sym(s, 'U1'));
    expect(Math.abs(u1.x - page.x - 6000)).toBeLessThanOrEqual(50);
    expect(Math.abs(u1.y - page.y - 6000)).toBeLessThanOrEqual(50);
    // R2 on IN2 is still drawn at U1's pin, wired to it
    const in2 = sym(s, 'U1').pins.find((p) => p.name === 'IN2')!;
    expect(sym(s, 'R2').pins.some((p) => p.y === in2.y)).toBe(true);
    expect(s.wires.some((w) => w.pts.includes(in2.x) && w.pts.includes(in2.y))).toBe(true);
    // the connectors did not move
    for (const ref of ['J1', 'J2']) expect(sym(s, ref).bbox, ref).toEqual(sym(before, ref).bbox);
    // the drawing is stored; no ledger entry says where U1 is
    expect(Object.keys(k.draftDesign().drawing ?? {})).toEqual(['s_1']);
    expect(Object.values(k.draftDesign().ledger).some((c) => c.kind === 'sch_position')).toBe(false);
  });

  it('stands a placed two-pin part on its own, lying when asked, connected by labels', () => {
    const k = kernelWith(chain);
    k.transact({ summary: 'place', ops: [{ op: 'place_symbol', ref: 'R1', page: 1, x: 2000, y: 6000, orient: 'lying' }] });
    const s = sheetOf(k);
    const r1 = sym(s, 'R1');
    expect(r1.rotation).toBeDefined(); // lying
    expect(Math.abs(centre(r1).x - s.pages[0]!.rect.x - 2000)).toBeLessThanOrEqual(50);
    for (const p of r1.pins) expect(s.labels.some((l) => l.x === p.x && l.y === p.y), `label at R1.${p.number}`).toBe(true);
    // and stands up again when told
    k.transact({ summary: 'stand', ops: [{ op: 'place_symbol', ref: 'R1', x: 2000, y: 6000, orient: 'upright' }] });
    expect(sym(sheetOf(k), 'R1').rotation).toBeUndefined();
  });

  it('mirrors a connector when told, and keeps how it is drawn otherwise', () => {
    const k = kernelWith(chain);
    k.transact({ summary: 'place', ops: [{ op: 'place_symbol', ref: 'J2', page: 1, x: 10000, y: 3000, mirror: true }] });
    const j2 = sym(sheetOf(k), 'J2');
    expect(j2.pins.every((p) => p.x < centre(j2).x)).toBe(true); // pins face left, towards the circuit
    k.transact({ summary: 'place', ops: [{ op: 'place_symbol', ref: 'J2', page: 1, x: 9000, y: 3000 }] });
    const j2b = sym(sheetOf(k), 'J2');
    expect(j2b.pins.every((p) => p.x < centre(j2b).x)).toBe(true);
    k.transact({ summary: 'place', ops: [{ op: 'place_symbol', ref: 'J2', page: 1, x: 9000, y: 3000, mirror: false }] });
    const j2c = sym(sheetOf(k), 'J2');
    expect(j2c.pins.every((p) => p.x > centre(j2c).x)).toBe(true);
  });

  it('keeps the page when none is given, redraws the part in free space with auto, and refuses orient on an IC', () => {
    const k = kernelWith(chain);
    expect(k.transact({ summary: 'back', ops: [{ op: 'place_symbol', ref: 'U1', auto: true }] }).results[0]!.effect).toMatch(/drawn by the layout already/);
    const r = k.transact({ summary: 'place', ops: [{ op: 'place_symbol', ref: 'U1', x: 6000, y: 6000 }] });
    expect(r.results[0]!.effect).toMatch(/page 1/);
    expect(k.transact({ summary: 'back', ops: [{ op: 'place_symbol', ref: 'U1', auto: true }] }).results[0]!.effect).toMatch(/U1 drawn afresh in free space/);
    const bad = k.transact({ summary: 'x', ops: [{ op: 'place_symbol', ref: 'U1', x: 1, y: 1, orient: 'lying' }] });
    expect(bad.rejection?.code).toBe('INVALID_OP');
    const none = k.transact({ summary: 'x', ops: [{ op: 'place_symbol', ref: 'U1' }] });
    expect(none.rejection?.message).toMatch(/needs x and y/);
  });

  it('says so when a placed part lies on another one', () => {
    const k = kernelWith(chain);
    const r = k.transact({ summary: 'place', ops: [{ op: 'place_symbol', ref: 'U1', page: 1, x: 6000, y: 4000 }, { op: 'place_symbol', ref: 'J2', page: 1, x: 6000, y: 4000 }] });
    expect(r.results[1]!.effect).toMatch(/it lies on U1: move one of them/);
  });

  it('puts a part on a page the sheet does not have yet: the page is added', () => {
    const k = kernelWith(chain);
    k.transact({ summary: 'place', ops: [{ op: 'place_symbol', ref: 'J2', page: 2, x: 3000, y: 3000 }] });
    const s = sheetOf(k);
    expect(s.pages).toHaveLength(2);
    const c = centre(sym(s, 'J2'));
    const p2 = s.pages[1]!.rect;
    expect(c.x > p2.x && c.x < p2.x + p2.w && c.y > p2.y && c.y < p2.y + p2.h).toBe(true);
  });

  it('reports pages, who draws them and where every symbol stands in get_schematic', () => {
    const k = kernelWith(chain);
    type Q = { pages: { page: number; drawn: string }[]; symbols: { ref: string; page: number; x: number; y: number }[] };
    expect((k.query({ op: 'get_schematic' }) as Q).pages[0]!.drawn).toMatch(/auto-layout/);
    k.transact({ summary: 'place', ops: [{ op: 'place_symbol', ref: 'U1', page: 1, x: 6000, y: 6000 }] });
    const q = k.query({ op: 'get_schematic' }) as Q;
    expect(q.pages[0]).toMatchObject({ page: 1, drawn: 'as you arranged it' });
    const u1 = q.symbols.find((x) => x.ref === 'U1')!;
    expect(u1.page).toBe(1);
    expect(Math.abs(u1.x - 6000)).toBeLessThanOrEqual(50); // snapped to the grid
    expect(Math.abs(u1.y - 6000)).toBeLessThanOrEqual(50);
  });
});

describe('left_of / right_of / above / below move the subject', () => {
  it('keeps a connector ordered by a constraint in its place in the row, not stacked under the first connector', () => {
    const k = kernelWith(chain);
    k.transact({ summary: 'order', ops: [{ op: 'constrain', kind: 'right_of', a: 'J2', b: 'U1' }] });
    const s = sheetOf(k);
    expect(sym(s, 'J2').bbox.x).toBeGreaterThan(sym(s, 'U1').bbox.x + sym(s, 'U1').bbox.w);
    expect(Object.values(k.state().view.constraintStatus)).toEqual(['ok']);
  });

  it('with a small part as the reference, moves the subject next to the part that small part is drawn with', () => {
    const k = kernelWith(chain);
    const r2Before = centre(sym(sheetOf(k), 'R2'));
    const u1Before = centre(sym(sheetOf(k), 'U1'));
    // "J2 right of R2": R2 hangs at U1's IN2 pin, so J2 goes right of U1, and R2 stays at U1
    k.transact({ summary: 'order', ops: [{ op: 'constrain', kind: 'right_of', a: 'J2', b: 'R2' }] });
    const s = sheetOf(k);
    expect(sym(s, 'J2').bbox.x).toBeGreaterThan(sym(s, 'R2').bbox.x);
    expect(centre(sym(s, 'R2')).x - centre(sym(s, 'U1')).x).toBe(r2Before.x - u1Before.x);
  });

  it('draws a small part said to be below an IC at that IC, where they share a pin', () => {
    // R3 between IN (J1's net, where it would hang) and IN2's net BIAS: below U1 puts it at U1
    const k = kernelWith([...chain, { op: 'add_part', part: 'generic:R', refdes: 'R3', params: { resistance: '100k' } }, { op: 'connect', pins: ['R3.1', 'J1.1'] }, { op: 'connect', pins: ['R3.2', 'U1.IN2'] }]);
    const onIn2 = () => {
      const s = sheetOf(k);
      const in2 = sym(s, 'U1').pins.find((p) => p.name === 'IN2')!;
      return sym(s, 'R3').pins.some((p) => p.y === in2.y);
    };
    expect(onIn2()).toBe(false); // first come, first served: it hangs at J1
    k.transact({ summary: 'below', ops: [{ op: 'constrain', kind: 'below', a: 'R3', b: 'U1' }] });
    expect(onIn2()).toBe(true);
  });

  it('says why a side-by-side constraint failed when the row wrapped, and points to place_symbol', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ op: 'add_part', part: 'acme:IC', refdes: `U${i + 1}` }));
    const wires = Array.from({ length: 10 }, (_, i) => ({ op: 'connect', pins: [`U${i + 1}.IN1`], net: `S${i + 1}` }));
    const k = kernelWith([...many, ...wires]);
    // ten ICs do not fit on one A4 line: U1–U7 on the first, U8–U10 on the next, so U8 cannot be right of U2
    k.transact({ summary: 'order', ops: [{ op: 'constrain', kind: 'right_of', a: 'U8', b: 'U2' }] });
    const d = k.state().diagnostics.find((x) => x.code === 'LEDGER.PLACEMENT')!;
    expect(d.message).toMatch(/row is wider than the page.*U8 ended up on another line than U2/);
    expect(d.message).toMatch(/place_symbol/);
  });
});
