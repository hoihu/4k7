import { describe, expect, it } from 'vitest';
import type { PartCard, SheetView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';

/** The ops the schematic canvas issues for a drag, a turn and a delete, as the user's own edits. */

const ic: PartCard = {
  id: 'acme:IC',
  mpn: 'acme:IC',
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
};

const chain = [
  { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
  { op: 'add_part', part: 'acme:IC', refdes: 'U1' },
  { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J2' },
  { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
  { op: 'connect', pins: ['J1.1', 'R1.1'], net: 'IN' },
  { op: 'connect', pins: ['R1.2', 'U1.IN1'], net: 'IN_F' },
  { op: 'connect', pins: ['U1.OUT', 'J2.1'], net: 'OUT' },
  { op: 'connect', pins: ['J1.2', 'J2.2', 'U1.GND'], net: 'GND' },
];

function kernel() {
  const k = new Kernel();
  const d = k.committedDesign();
  d.parts[ic.id] = ic;
  k.load(d);
  expect(k.transact({ summary: 'circuit', ops: chain } as never).status).toBe('ok');
  k.accept();
  return k;
}

/** What the app does for a user edit: a transaction by the user, accepted. */
function byUser(k: Kernel, ops: unknown[]) {
  const r = k.transact({ summary: 'user edit', ops } as never, 'user');
  if (r.status === 'ok') k.accept(undefined, 'user', 'user edit');
  return r;
}

const sheetOf = (k: Kernel): SheetView => k.state().view.sheets[0]!;
const sym = (s: SheetView, ref: string) => s.symbols.find((x) => x.refdes === ref)!;
const centre = (s: SheetView, ref: string) => {
  const b = sym(s, ref).bbox;
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
};
const pin = (s: SheetView, ref: string, p: string) => sym(s, ref).pins.find((x) => x.number === p || x.name === p)!;
const wireAt = (s: SheetView, p: { x: number; y: number }) => s.wires.filter((w) => (w.pts[0] === p.x && w.pts[1] === p.y) || (w.pts.at(-2) === p.x && w.pts.at(-1) === p.y));

describe('a symbol dragged by the user', () => {
  it('moves on the grid, is marked as the user\'s, and its wires follow through the path finder', () => {
    const k = kernel();
    expect(byUser(k, [{ op: 'wire', from: 'R1.2', to: 'U1.IN1' }]).status).toBe('ok');
    const s0 = sheetOf(k);
    expect(wireAt(s0, pin(s0, 'R1', '2')).length).toBeGreaterThan(0);
    const c = centre(s0, 'R1');
    const page = s0.pages[0]!;
    const r = byUser(k, [{ op: 'place_symbol', ref: 'R1', page: 1, x: c.x - page.rect.x + 400, y: c.y - page.rect.y + 700, rewire: true }]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(r.results[0]!.effect).toMatch(/2 wires drawn again/); // both ends were wired by the layout
    const s = sheetOf(k);
    expect(centre(s, 'R1')).toEqual({ x: c.x + 400, y: c.y + 700 });
    expect(sym(s, 'R1').by).toBe('user');
    // R1.2 is wired to U1.IN1 again, from the new place
    expect(wireAt(s, pin(s, 'R1', '2')).length).toBeGreaterThan(0);
    expect(wireAt(s, pin(s, 'R1', '1')).length).toBeGreaterThan(0);
    expect(s.labels.filter((l) => l.auto && l.text === 'IN_F')).toEqual([]);
    expect(k.state().diagnostics.filter((x) => x.code.startsWith('SCH.') && x.severity === 'error')).toEqual([]);
  });

  it('without rewire the cut connection shows as automatic labels', () => {
    const k = kernel();
    byUser(k, [{ op: 'wire', from: 'R1.2', to: 'U1.IN1' }]);
    const s0 = sheetOf(k);
    const c = centre(s0, 'R1');
    // (too far from U1 for the step that wires a part placed on its own)
    byUser(k, [{ op: 'place_symbol', ref: 'R1', page: 1, x: c.x - s0.pages[0]!.rect.x - 4300, y: c.y - s0.pages[0]!.rect.y + 700 }]);
    expect(sheetOf(k).labels.filter((l) => l.auto && l.text === 'IN_F').length).toBe(2);
  });

  it('wires a part dragged below its neighbour from the side of its pin, not by labels', () => {
    const k = kernel();
    byUser(k, [{ op: 'wire', from: 'R1.2', to: 'U1.IN1' }]);
    const s0 = sheetOf(k);
    const c = centre(s0, 'R1');
    const r = byUser(k, [{ op: 'place_symbol', ref: 'R1', page: 1, x: c.x - s0.pages[0]!.rect.x + 400, y: c.y - s0.pages[0]!.rect.y + 700 }]);
    expect(r.results[0]!.effect).toContain('R1.2 to U1.IN1');
    const s = sheetOf(k);
    expect(s.labels.filter((l) => l.auto && l.text === 'IN_F')).toEqual([]);
    const [low, ic] = [pin(s, 'R1', '2'), pin(s, 'U1', 'IN1')];
    const w = wireAt(s, low)[0]!;
    expect(w.pts[1]).toBe(low.y); // along the level of the bottom pin: going down first would have to turn back
    expect(w.pts.slice(-2)).toEqual([ic.x, ic.y]);
  });

  it('leaves a connection to labels where no wire can reach (another page)', () => {
    const k = kernel();
    byUser(k, [{ op: 'wire', from: 'R1.2', to: 'U1.IN1' }]);
    const r = byUser(k, [{ op: 'place_symbol', ref: 'R1', page: 2, x: 3000, y: 3000, rewire: true }]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(r.results[0]!.effect).toMatch(/2 connections left to labels/);
    expect(sheetOf(k).labels.filter((l) => l.auto && l.text === 'IN_F').length).toBe(2);
  });

  it('is turned lying and mirrored by the same op, keeping its wires', () => {
    const k = kernel();
    byUser(k, [{ op: 'wire', from: 'R1.2', to: 'U1.IN1' }]);
    const s0 = sheetOf(k);
    const ox = s0.pages[0]!.rect.x;
    const oy = s0.pages[0]!.rect.y;
    const c = centre(s0, 'R1');
    const r = byUser(k, [{ op: 'place_symbol', ref: 'R1', orient: 'lying', page: 1, x: c.x - ox, y: c.y - oy, rewire: true }]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(sym(sheetOf(k), 'R1').rotation).toBeTruthy();
    expect(sym(sheetOf(k), 'R1').by).toBe('user');
    const u = centre(sheetOf(k), 'U1');
    const m = byUser(k, [{ op: 'place_symbol', ref: 'U1', mirror: true, page: 1, x: u.x - ox, y: u.y - oy, rewire: true }]);
    expect(m.status, JSON.stringify(m.rejection)).toBe('ok');
    expect(sym(sheetOf(k), 'U1').mirrored).toBe(true);
  });

  it('is undone as one step, and shows as the user\'s change in the history', () => {
    const k = kernel();
    const s0 = sheetOf(k);
    const c = centre(s0, 'J2');
    byUser(k, [{ op: 'place_symbol', ref: 'J2', page: 1, x: c.x - s0.pages[0]!.rect.x + 300, y: c.y - s0.pages[0]!.rect.y, rewire: true }]);
    expect(k.state().history[0]!.by).toBe('user');
    k.undo();
    expect(centre(sheetOf(k), 'J2')).toEqual(c);
  });
});

describe('the user\'s placement and the agent', () => {
  it('is kept by place_block, which draws the rest of the block afresh', () => {
    const k = kernel();
    k.transact({ summary: 'group', ops: [{ op: 'describe', blocks: [{ title: 'Front', refs: ['J1', 'R1', 'U1', 'J2'] }] }] } as never);
    const s0 = sheetOf(k);
    const c = centre(s0, 'R1');
    byUser(k, [{ op: 'place_symbol', ref: 'R1', page: 1, x: c.x - s0.pages[0]!.rect.x, y: c.y - s0.pages[0]!.rect.y + 1000 }]);
    const mine = centre(sheetOf(k), 'R1');
    const r = k.transact({ summary: 'block', ops: [{ op: 'place_block', block: 'Front', page: 1, x: 6000, y: 4000 }] } as never);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(centre(sheetOf(k), 'R1')).toEqual(mine);
    expect(sym(sheetOf(k), 'R1').by).toBe('user');
  });

  it('is kept by auto_draw of the sheet as the layout\'s fixed place for it', () => {
    const k = kernel();
    const s0 = sheetOf(k);
    const c = centre(s0, 'J2');
    const x = Math.round(c.x - s0.pages[0]!.rect.x + 1500);
    const y = Math.round(c.y - s0.pages[0]!.rect.y);
    byUser(k, [{ op: 'place_symbol', ref: 'J2', page: 1, x, y }]);
    expect(k.transact({ summary: 'tidy', ops: [{ op: 'auto_draw' }] } as never).status).toBe('ok');
    const d = k.draftDesign();
    expect(d.drawing).toBeUndefined();
    const keep = Object.values(d.ledger).find((l) => l.kind === 'sch_position');
    expect(keep).toMatchObject({ page: 1, source: { type: 'user' } });
    const s = sheetOf(k);
    expect(Math.abs(centre(s, 'J2').x - s.pages[0]!.rect.x - x)).toBeLessThanOrEqual(100);
  });

  it('may be moved by the agent, which says so', () => {
    const k = kernel();
    const s0 = sheetOf(k);
    const c = centre(s0, 'J2');
    byUser(k, [{ op: 'place_symbol', ref: 'J2', page: 1, x: c.x - s0.pages[0]!.rect.x + 500, y: c.y - s0.pages[0]!.rect.y }]);
    const q = k.query({ op: 'get_schematic' }) as { symbols: { ref: string; user_placed?: boolean }[] };
    expect(q.symbols.find((x) => x.ref === 'J2')!.user_placed).toBe(true);
    const r = k.transact({ summary: 'agent move', ops: [{ op: 'place_symbol', ref: 'J2', page: 1, x: 6000, y: 3000 }] } as never);
    expect(r.results[0]!.effect).toMatch(/it was the user's placement; now yours/);
    expect(sym(sheetOf(k), 'J2').by).toBeUndefined();
  });
});

describe('erase at a point', () => {
  it('takes away the one wire there and nothing else', () => {
    const k = kernel();
    byUser(k, [{ op: 'wire', from: 'R1.2', to: 'U1.IN1' }, { op: 'wire', from: 'J1.1', to: 'R1.1' }]);
    const s0 = sheetOf(k);
    const w = s0.wires[0]!;
    const pg = s0.pages[0]!.rect;
    // the middle of the wire's first segment
    const mx = (w.pts[0]! + w.pts[2]!) / 2;
    const my = (w.pts[1]! + w.pts[3]!) / 2;
    const before = s0.wires.length;
    const r = byUser(k, [{ op: 'erase', at: [{ page: 1, x: mx - pg.x, y: my - pg.y, what: 'wire' }] }]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(r.results[0]!.effect).toMatch(/erased 1 wire/);
    expect(sheetOf(k).wires.length).toBeLessThan(before);
    expect(sheetOf(k).wires.length).toBeGreaterThan(0);
  });

  it('takes away one net label by its place, and refuses a spot with nothing', () => {
    const k = kernel();
    byUser(k, [{ op: 'wire', from: 'R1.2', to: 'U1.IN1' }]);
    const s0 = sheetOf(k);
    const l = s0.labels.find((x) => x.kind === 'net' && !x.auto)!;
    const pg = s0.pages[0]!.rect;
    const r = byUser(k, [{ op: 'erase', at: [{ page: 1, x: l.x - pg.x, y: l.y - pg.y, what: 'label' }] }]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(sheetOf(k).labels.some((x) => x.x === l.x && x.y === l.y && !x.auto)).toBe(false);
    const none = byUser(k, [{ op: 'erase', at: [{ page: 1, x: 5, y: 5, what: 'wire' }] }]);
    expect(none.rejection?.code).toBe('INVALID_OP');
  });
});
