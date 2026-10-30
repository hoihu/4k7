import { describe, expect, it } from 'vitest';
import type { PartCard, SheetView } from '@4k7/schema';
import { onWire } from '../src/drawing.ts';
import { Kernel } from '../src/index.ts';

/** Moving a supply symbol (move_supply) and forcing how a net is drawn (set_net draw_as). */

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

/** J1 → R1 → U1.IN1, R2 from U1.IN2 to ground, U1.OUT → J2, C1 on +5V. */
const circuit = [
  { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
  { op: 'add_part', part: 'acme:IC', refdes: 'U1' },
  { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J2' },
  { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
  { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '10k' } },
  { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '100n' } },
  { op: 'connect', pins: ['J1.1', 'R1.1'], net: 'IN' },
  { op: 'connect', pins: ['R1.2', 'U1.IN1'], net: 'IN_F' },
  { op: 'connect', pins: ['U1.IN2', 'R2.1'], net: 'BIAS' },
  { op: 'connect', pins: ['U1.OUT', 'J2.1'], net: 'OUT' },
  { op: 'connect', pins: ['J1.2', 'J2.2', 'R2.2', 'U1.GND', 'C1.2'], net: 'GND' },
  { op: 'connect', pins: ['U1.VCC', 'C1.1'], net: '+5V' },
  { op: 'set_net', net: '+5V', voltage: 5 },
];

function kernel(...more: unknown[]) {
  const k = new Kernel();
  const d = k.committedDesign();
  d.parts[ic.id] = ic;
  k.load(d);
  const r = k.transact({ summary: 'circuit', ops: [...circuit, ...more] } as never);
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
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
const pin = (s: SheetView, ref: string, p: string) => s.symbols.find((x) => x.refdes === ref)!.pins.find((x) => x.number === p || x.name === p)!;
const labelsOf = (s: SheetView, net: string) => s.labels.filter((l) => l.text === net);
const wiresOf = (s: SheetView, netId: string) => s.wires.filter((w) => w.netId === netId);
const netId = (s: SheetView, net: string) => labelsOf(s, net)[0]?.netId;
const netOf = (k: Kernel, net: string) => Object.values(k.committedDesign().nets).find((n) => n.name === net)!;
const errors = (k: Kernel) => k.state().diagnostics.filter((x) => x.code.startsWith('SCH.') && x.severity === 'error');

/** The move of a supply symbol as the canvas sends it: from where it stands by this much. */
function move(s: SheetView, l: { x: number; y: number }, dx: number, dy: number) {
  const pg = s.pages[0]!.rect;
  return { op: 'move_supply', page: 1, x: l.x - pg.x, y: l.y - pg.y, to: { x: l.x - pg.x + dx, y: l.y - pg.y + dy } };
}

/** Where a symbol stands, as place_symbol takes it. */
const standing = (k: Kernel, ref: string) => {
  const s = sheetOf(k);
  const b = s.symbols.find((x) => x.refdes === ref)!.bbox;
  const pg = s.pages[0]!.rect;
  return { page: 1, x: b.x + b.w / 2 - pg.x, y: b.y + b.h / 2 - pg.y };
};

/** The +5V symbol, standing on U1.VCC. */
const vcc = (k: Kernel) => {
  const s = sheetOf(k);
  const p = pin(s, 'U1', 'VCC');
  return labelsOf(s, '+5V').find((l) => l.x === p.x && l.y === p.y)!;
};

describe('a supply symbol moved', () => {
  it('stands on a wire from its pin, straight on where it can, and points its own way', () => {
    const k = kernel();
    const l = vcc(k);
    const before = sheetOf(k).labels.length;
    const r = byUser(k, [move(sheetOf(k), l, 0, -300)]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(r.results[0]!.effect).toMatch(/\+5V symbol moved/);
    const s = sheetOf(k);
    const p = pin(s, 'U1', 'VCC');
    expect(s.labels.length).toBe(before);
    const moved = labelsOf(s, '+5V').find((x) => x.x === l.x && x.y === l.y - 300)!;
    expect(moved).toMatchObject({ kind: 'rail', dir: 'up' });
    expect(moved.stub).toBeUndefined();
    expect(s.wires.some((w) => w.pts.join() === [p.x, p.y, p.x, p.y - 300].join() || w.pts.join() === [p.x, p.y - 300, p.x, p.y].join())).toBe(true);
    expect(errors(k)).toEqual([]);
  });

  it('comes in from the side or below, never through the symbol', () => {
    const k = kernel();
    const l = vcc(k);
    // beside and below the pin: a wire straight down onto the rail's foot would run through its arrow
    const r = byUser(k, [move(sheetOf(k), l, -900, 300)]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const s = sheetOf(k);
    const foot = { x: l.x - 900, y: l.y + 300 };
    expect(labelsOf(s, '+5V').some((x) => x.x === foot.x && x.y === foot.y)).toBe(true);
    const w = s.wires.find((x) => onWire(foot.x, foot.y, x.pts))!;
    const pts = w.pts[0] === foot.x && w.pts[1] === foot.y ? w.pts : [...w.pts].reverse().flatMap((_, i, a) => (i % 2 ? [] : [a[i + 1]!, a[i]!]));
    expect(pts.slice(0, 2)).toEqual([foot.x, foot.y]);
    expect(pts[3]!).toBeGreaterThanOrEqual(foot.y); // from the foot not up through the symbol
  });

  it('leaves no wire behind when it is moved again, or back onto its pin', () => {
    const k = kernel();
    const l = vcc(k);
    byUser(k, [move(sheetOf(k), l, 400, -300)]);
    const once = labelsOf(sheetOf(k), '+5V').find((x) => x.x === l.x + 400)!;
    const net = once.netId;
    const wires = wiresOf(sheetOf(k), net).length;
    expect(byUser(k, [move(sheetOf(k), once, 100, -100)]).status).toBe('ok');
    expect(wiresOf(sheetOf(k), net).length).toBe(wires);
    const twice = labelsOf(sheetOf(k), '+5V').find((x) => x.x === l.x + 500)!;
    expect(byUser(k, [move(sheetOf(k), twice, -500, l.y - twice.y)]).status).toBe('ok');
    const p = pin(sheetOf(k), 'U1', 'VCC');
    expect(labelsOf(sheetOf(k), '+5V').some((x) => x.x === p.x && x.y === p.y)).toBe(true);
    expect(sheetOf(k).wires.some((w) => w.netId === net && onWire(l.x + 400, l.y - 300, w.pts))).toBe(false);
  });

  it('moves a symbol on a horizontal lead by its foot, its stub gone', () => {
    const k = kernel();
    const s = sheetOf(k);
    const stubbed = labelsOf(s, 'GND').find((l) => l.stub);
    expect(stubbed, 'a ground symbol on a stub').toBeTruthy();
    const side = stubbed!.stub === 'left' ? -1 : 1;
    const foot = stubbed!.x + side * (stubbed!.stubLen ?? 100);
    const pg = s.pages[0]!.rect;
    const r = byUser(k, [{ op: 'move_supply', page: 1, x: stubbed!.x - pg.x, y: stubbed!.y - pg.y, to: { x: foot - pg.x + side * 300, y: stubbed!.y - pg.y + 200 } }]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const now = labelsOf(sheetOf(k), 'GND').find((l) => l.x === foot + side * 300 && l.y === stubbed!.y + 200)!;
    expect(now).toMatchObject({ kind: 'ground', dir: 'down' });
    expect(now.stub).toBeUndefined();
    expect(errors(k)).toEqual([]);
  });

  it('keeps a bar whole: the symbol on it moves and a wire joins it to the bar', () => {
    const k = kernel(...[1, 2, 3].flatMap((i) => [{ op: 'add_part', part: 'generic:LED', refdes: `D${i}` }, { op: 'connect', pins: [`D${i}.1`], net: `L${i}` }, { op: 'connect', pins: [`D${i}.2`], net: 'GND' }]), { op: 'describe', blocks: [{ title: 'LEDs', refs: ['D1', 'D2', 'D3'] }] });
    const s = sheetOf(k);
    // the bar of the row: a run of the ground net with one symbol on it and no pin at the symbol
    const gnd = netOf(k, 'GND').id;
    const on = s.labels.find((l) => l.netId === gnd && !s.symbols.some((x) => x.pins.some((p) => p.x === l.x && p.y === l.y)));
    expect(on, 'a symbol on a bar').toBeTruthy();
    const wired = wiresOf(s, gnd).filter((w) => onWire(on!.x, on!.y, w.pts)).length;
    expect(wired).toBeGreaterThan(0);
    const r = byUser(k, [move(s, on!, -300, 0)]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const now = sheetOf(k);
    const moved = now.labels.find((l) => l.netId === gnd && l.x === on!.x - 300 && l.y === on!.y)!;
    expect(moved).toBeTruthy();
    // the pins of the bar still hang together, and the symbol with them
    for (const d of ['D1', 'D2', 'D3']) {
      const p = pin(now, d, '2');
      expect(now.wires.some((w) => w.netId === gnd && onWire(p.x, p.y, w.pts)), d).toBe(true);
    }
    expect(now.wires.some((w) => w.netId === gnd && onWire(moved.x, moved.y, w.pts))).toBe(true);
    expect(now.labels.filter((l) => l.auto && l.netId === gnd && now.symbols.some((x) => ['D1', 'D2', 'D3'].includes(x.refdes) && x.pins.some((p) => p.x === l.x && p.y === l.y)))).toEqual([]);
  });

  it('takes an automatic symbol too: it stands where it is put, for good', () => {
    const k = kernel();
    byUser(k, [{ op: 'erase', pins: ['U1.VCC'] }]);
    const a = vcc(k);
    expect(a.auto).toBe(true);
    const r = byUser(k, [move(sheetOf(k), a, 500, -200)]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const now = labelsOf(sheetOf(k), '+5V').find((l) => l.x === a.x + 500 && l.y === a.y - 200)!;
    expect(now.auto).toBeUndefined();
    const p = pin(sheetOf(k), 'U1', 'VCC');
    expect(sheetOf(k).wires.some((w) => w.netId === a.netId && onWire(p.x, p.y, w.pts))).toBe(true);
    expect(labelsOf(sheetOf(k), '+5V').some((l) => l.x === p.x && l.y === p.y)).toBe(false);
  });

  it('refuses a spot on a part or on another net, and a spot where no symbol stands, and changes nothing', () => {
    const k = kernel();
    const s = sheetOf(k);
    const l = vcc(k);
    const pg = s.pages[0]!.rect;
    const u = s.symbols.find((x) => x.refdes === 'U1')!.bbox;
    const on = byUser(k, [{ op: 'move_supply', page: 1, x: l.x - pg.x, y: l.y - pg.y, to: { x: u.x + u.w / 2 - pg.x, y: u.y + u.h / 2 - pg.y } }]);
    expect(on.rejection?.message).toMatch(/goes beside U1/);
    const w = s.wires.find((x) => x.netId !== l.netId && Math.abs(x.pts[0]! - x.pts[2]!) >= 200 && x.pts[1] === x.pts[3])!;
    expect(w, 'a horizontal wire of another net').toBeTruthy();
    const across = byUser(k, [{ op: 'move_supply', page: 1, x: l.x - pg.x, y: l.y - pg.y, to: { x: Math.round((w.pts[0]! + w.pts[2]!) / 2 / 100) * 100 - pg.x, y: w.pts[1]! - pg.y } }]);
    expect(across.rejection?.message).toMatch(/would look connected/);
    const none = byUser(k, [{ op: 'move_supply', page: 1, x: 7, y: 7, to: { x: 1000, y: 1000 } }]);
    expect(none.rejection?.message).toMatch(/No supply symbol stands/);
    const out = byUser(k, [{ op: 'move_supply', page: 1, x: l.x - pg.x, y: l.y - pg.y, to: { x: 20, y: 20 } }]);
    expect(out.rejection?.message).toMatch(/outside the drawing area/);
    expect(k.committedDesign().drawing).toBeUndefined();
    expect(sheetOf(k).labels).toEqual(s.labels);
  });

  it('goes with its part when the part is dragged, and is undone as one step', () => {
    const k = kernel();
    const l = vcc(k);
    byUser(k, [move(sheetOf(k), l, 400, -300)]);
    const s0 = sheetOf(k);
    const b = s0.symbols.find((x) => x.refdes === 'C1')!.bbox;
    const pg = s0.pages[0]!.rect;
    byUser(k, [{ op: 'place_symbol', ref: 'C1', page: 1, x: b.x + b.w / 2 - pg.x + 300, y: b.y + b.h / 2 - pg.y + 1200, rewire: true }]);
    expect(labelsOf(sheetOf(k), '+5V').some((x) => x.x === l.x + 400 && x.y === l.y - 300)).toBe(true);
    k.undo();
    k.undo();
    expect(sheetOf(k).labels.some((x) => x.x === l.x && x.y === l.y && x.text === '+5V')).toBe(true);
    expect(k.committedDesign().drawing).toBeUndefined();
  });

  it('goes back to its pin when its part is turned or mirrored, and no wire stays behind', () => {
    for (const look of [{ rotate: 90 }, { mirror: true }]) {
      const k = kernel();
      const l = vcc(k);
      byUser(k, [move(sheetOf(k), l, 0, -300)]);
      const r = byUser(k, [{ op: 'place_symbol', ref: 'U1', ...standing(k, 'U1'), ...look, rewire: true }]);
      expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
      const s = sheetOf(k);
      const p = pin(s, 'U1', 'VCC');
      expect(labelsOf(s, '+5V').some((x) => x.x === p.x && x.y === p.y)).toBe(true);
      expect(labelsOf(s, '+5V').some((x) => x.x === l.x && x.y === l.y - 300)).toBe(false);
      expect(s.wires.some((w) => w.netId === l.netId && onWire(l.x, l.y - 300, w.pts))).toBe(false);
      expect(errors(k)).toEqual([]);
    }
  });

  it('is replaced by label at its pin, wire and all, and listed by get_schematic', () => {
    const k = kernel();
    const l = vcc(k);
    const q0 = k.query({ op: 'get_schematic' }) as { supplies: { net: string; page: number; x: number; y: number; at?: string }[] };
    const listed = q0.supplies.find((x) => x.net === '+5V' && x.at === 'U1.VCC')!;
    const pg = sheetOf(k).pages[0]!.rect;
    expect([listed.page, listed.x, listed.y]).toEqual([1, l.x - pg.x, l.y - pg.y]);
    byUser(k, [move(sheetOf(k), l, 400, -300)]);
    expect(byUser(k, [{ op: 'label', pin: 'U1.VCC' }]).status).toBe('ok');
    const s = sheetOf(k);
    expect(labelsOf(s, '+5V').some((x) => x.x === l.x + 400)).toBe(false);
    expect(s.wires.some((w) => w.netId === l.netId && onWire(l.x + 400, l.y - 300, w.pts))).toBe(false);
  });
});

describe('a net forced to labels', () => {
  it('has no wires and a label of its own at every pin, on a sheet then kept as drawn', () => {
    const k = kernel();
    const s0 = sheetOf(k);
    const id = netOf(k, 'BIAS').id;
    expect(wiresOf(s0, id).length).toBeGreaterThan(0);
    const r = byUser(k, [{ op: 'set_net', net: 'BIAS', draw_as: 'label' }]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(r.results[0]!.effect).toMatch(/drawn by labels/);
    const s = sheetOf(k);
    expect(wiresOf(s, id)).toEqual([]);
    const pins = [pin(s, 'U1', 'IN2'), pin(s, 'R2', '1')];
    for (const p of pins) expect(s.labels.filter((l) => l.netId === id && l.x === p.x && l.y === p.y && !l.auto).length, `${p.x},${p.y}`).toBe(1);
    expect(k.committedDesign().drawing).toBeTruthy();
    expect((k.query({ op: 'get_net', net: 'BIAS' }) as { attrs: { drawAs?: string } }).attrs.drawAs).toBe('label');
    expect((k.query({ op: 'get_schematic' }) as { forced_nets?: unknown }).forced_nets).toEqual([{ net: 'BIAS', draw_as: 'label' }]);
    expect(errors(k)).toEqual([]);
  });

  it('gives each supply pin its symbol, for a rail on a bar or wires', () => {
    const k = kernel();
    byUser(k, [{ op: 'set_net', net: 'GND', draw_as: 'label' }]);
    const s = sheetOf(k);
    const id = netOf(k, 'GND').id;
    expect(wiresOf(s, id).filter((w) => w.pts.length > 4 || s.symbols.flatMap((x) => x.pins).filter((p) => onWire(p.x, p.y, w.pts)).length > 1)).toEqual([]);
    for (const [ref, p] of [['J1', '2'], ['J2', '2'], ['R2', '2'], ['U1', 'GND'], ['C1', '2']] as const) {
      const at = pin(s, ref, p);
      const shown = s.labels.some((l) => l.netId === id && (l.x === at.x && l.y === at.y)) || s.wires.some((w) => w.netId === id && onWire(at.x, at.y, w.pts) && s.labels.some((l) => l.netId === id && onWire(l.x, l.y, w.pts)));
      expect(shown, `${ref}.${p}`).toBe(true);
    }
  });

  it('steps the symbols of neighbouring pins out, clear of each other', () => {
    const k = kernel({ op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J9' }, { op: 'connect', pins: ['J9.1', 'J9.2'], net: '+5V' });
    byUser(k, [{ op: 'set_net', net: '+5V', draw_as: 'label' }]);
    const s = sheetOf(k);
    const [a, b] = [pin(s, 'J9', '1'), pin(s, 'J9', '2')];
    const feet = [a, b].map((p) => {
      const l = labelsOf(s, '+5V').find((x) => x.x === p.x && x.y === p.y)!;
      return l.x + (l.stub === 'left' ? -1 : 1) * (l.stubLen ?? 100);
    });
    expect(Math.abs(feet[0]! - feet[1]!)).toBeGreaterThanOrEqual(200);
    expect(k.state().diagnostics.filter((x) => x.code === 'SCH.TEXT_OVERLAP' && x.entities.includes('J9.1') && x.entities.includes('J9.2'))).toEqual([]);
  });

  it('stays so: a part placed on its own, a part added and a redraw of the sheet draw no wire of it', () => {
    const k = kernel();
    byUser(k, [{ op: 'set_net', net: 'IN_F', draw_as: 'label' }]);
    const id = netOf(k, 'IN_F').id;
    const s0 = sheetOf(k);
    const b = s0.symbols.find((x) => x.refdes === 'R1')!.bbox;
    const pg = s0.pages[0]!.rect;
    // where a part placed on its own is wired, as it is on the same circuit with the net not forced
    const place = { op: 'place_symbol', ref: 'R1', page: 1, x: b.x + b.w / 2 - pg.x + 200, y: b.y + b.h / 2 - pg.y };
    expect(kernel().transact({ summary: 'place', ops: [place] } as never).results[0]!.effect).toContain('R1.2 to U1.IN1');
    const placed = k.transact({ summary: 'place', ops: [place] } as never);
    expect(placed.status).toBe('ok');
    expect(placed.results[0]!.effect).not.toContain('R1.2 to');
    expect(wiresOf(sheetOf(k), id)).toEqual([]);
    // a pin that joins the net
    const added = k.transact({ summary: 'add', ops: [{ op: 'add_part', part: 'generic:C', refdes: 'C9', params: { capacitance: '1n' } }, { op: 'connect', pins: ['C9.1', 'U1.IN1'] }, { op: 'connect', pins: ['C9.2', 'U1.GND'] }] } as never);
    expect(added.status, JSON.stringify(added.rejection)).toBe('ok');
    const s1 = sheetOf(k);
    expect(wiresOf(s1, id)).toEqual([]);
    const c9 = pin(s1, 'C9', '1');
    expect(s1.labels.some((l) => l.netId === id && l.x === c9.x && l.y === c9.y)).toBe(true);
    // the layout draws the sheet again
    const redrawn = k.transact({ summary: 'tidy', ops: [{ op: 'auto_draw' }] } as never);
    expect(redrawn.status).toBe('ok');
    expect(redrawn.results[0]!.effect).toMatch(/IN_F/);
    expect(wiresOf(sheetOf(k), id)).toEqual([]);
    expect(k.draftDesign().drawing).toBeTruthy();
  });

  it('stays so when its block is drawn afresh, or a part on it is turned', () => {
    const k = kernel({ op: 'describe', blocks: [{ title: 'Front', refs: ['J1', 'R1', 'U1', 'R2', 'J2', 'C1'] }] });
    byUser(k, [{ op: 'set_net', net: 'BIAS', draw_as: 'label' }, { op: 'set_net', net: 'IN', draw_as: 'wire' }]);
    const r = k.transact({ summary: 'block', ops: [{ op: 'place_block', block: 'Front', page: 1, x: 6000, y: 4000 }] } as never);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    k.accept();
    const s = sheetOf(k);
    const bias = netOf(k, 'BIAS').id;
    expect(wiresOf(s, bias)).toEqual([]);
    for (const p of [pin(s, 'U1', 'IN2'), pin(s, 'R2', '1')]) expect(s.labels.some((l) => l.netId === bias && l.x === p.x && l.y === p.y && !l.auto)).toBe(true);
    expect(labelsOf(s, 'IN')).toEqual([]);
    // R2 turned lying: its label comes along to the pin where it is now
    const b = s.symbols.find((x) => x.refdes === 'R2')!.bbox;
    const pg = s.pages[0]!.rect;
    expect(byUser(k, [{ op: 'place_symbol', ref: 'R2', page: 1, x: b.x + b.w / 2 - pg.x, y: b.y + b.h / 2 - pg.y, orient: 'lying', rewire: true }]).status).toBe('ok');
    const t = sheetOf(k);
    const now = pin(t, 'R2', '1');
    expect(t.labels.some((l) => l.netId === bias && l.x === now.x && l.y === now.y && !l.auto)).toBe(true);
    expect(wiresOf(t, bias)).toEqual([]);
  });

  it('takes no wire by the agent, nor an erase, and says how', () => {
    const k = kernel();
    byUser(k, [{ op: 'set_net', net: 'BIAS', draw_as: 'label' }]);
    const r = k.transact({ summary: 'w', ops: [{ op: 'wire', from: 'U1.IN2', to: 'R2.1' }] } as never);
    expect(r.rejection?.message).toMatch(/BIAS is set to be drawn by labels.*draw_as: null/);
    expect(k.transact({ summary: 'e', ops: [{ op: 'erase', net: 'BIAS' }] } as never).rejection?.message).toMatch(/BIAS is set/);
    expect(k.transact({ summary: 'e', ops: [{ op: 'erase', pins: ['R2.1'] }] } as never).rejection?.message).toMatch(/BIAS is set/);
    const s = sheetOf(k);
    const l = labelsOf(s, 'BIAS')[0]!;
    const pg = s.pages[0]!.rect;
    expect(byUser(k, [{ op: 'erase', at: [{ page: 1, x: l.x - pg.x, y: l.y - pg.y, what: 'label' }] }]).rejection?.message).toMatch(/BIAS is set/);
    // a label may still be swung round its pin
    const u = pin(s, 'U1', 'IN2');
    expect(byUser(k, [{ op: 'label', pin: 'U1.IN2', dir: 'up' }]).status).toBe('ok');
    expect(wiresOf(sheetOf(k), l.netId).filter((w) => onWire(u.x, u.y, w.pts)).length).toBe(1); // the lead the label stands on
  });
});

describe('a net forced to wires', () => {
  it('joins its pins by wires and shows no label', () => {
    const k = kernel();
    const id = netOf(k, 'IN').id;
    const r = byUser(k, [{ op: 'set_net', net: 'IN', draw_as: 'label' }, { op: 'set_net', net: 'IN', draw_as: 'wire' }]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const s = sheetOf(k);
    expect(labelsOf(s, 'IN')).toEqual([]);
    const [a, b] = [pin(s, 'J1', '1'), pin(s, 'R1', '1')];
    expect(s.wires.some((w) => w.netId === id && onWire(a.x, a.y, w.pts) && onWire(b.x, b.y, w.pts))).toBe(true);
    expect(errors(k)).toEqual([]);
  });

  it('keeps the label where no wire can go: on another page', () => {
    const k = kernel();
    const r = k.transact({ summary: 'page', ops: [{ op: 'place_symbol', ref: 'R2', page: 2, x: 3000, y: 3000 }] } as never);
    expect(r.status).toBe('ok');
    k.accept();
    const f = byUser(k, [{ op: 'set_net', net: 'BIAS', draw_as: 'wire' }]);
    expect(f.results[0]!.effect).toMatch(/1 left where no wire can go/);
    const s = sheetOf(k);
    const labels = labelsOf(s, 'BIAS');
    expect(labels.length).toBe(2);
    expect(labels.every((l) => l.auto)).toBe(true);
  });

  it('wires a pin that joins the net later, and a part moved keeps its wires', () => {
    const k = kernel();
    byUser(k, [{ op: 'set_net', net: 'BIAS', draw_as: 'wire' }]);
    const id = netOf(k, 'BIAS').id;
    const added = k.transact({ summary: 'add', ops: [{ op: 'add_part', part: 'generic:C', refdes: 'C9', params: { capacitance: '1n' } }, { op: 'connect', pins: ['C9.1', 'U1.IN2'] }, { op: 'connect', pins: ['C9.2', 'U1.GND'] }] } as never);
    expect(added.status, JSON.stringify(added.rejection)).toBe('ok');
    k.accept();
    const s = sheetOf(k);
    expect(labelsOf(s, 'BIAS')).toEqual([]);
    const c9 = pin(s, 'C9', '1');
    expect(s.wires.some((w) => w.netId === id && onWire(c9.x, c9.y, w.pts))).toBe(true);
    // an agent's move of a part off to the side, far enough that it would not be wired by itself
    const b = s.symbols.find((x) => x.refdes === 'R2')!.bbox;
    const pg = s.pages[0]!.rect;
    const moved = k.transact({ summary: 'move', ops: [{ op: 'place_symbol', ref: 'R2', page: 1, x: b.x + b.w / 2 - pg.x - 4300, y: b.y + b.h / 2 - pg.y + 700 }] } as never);
    expect(moved.status).toBe('ok');
    expect(labelsOf(sheetOf(k), 'BIAS')).toEqual([]);
  });

  it('takes no label by the agent, nor an erase of a wire by the user', () => {
    const k = kernel();
    byUser(k, [{ op: 'set_net', net: 'BIAS', draw_as: 'wire' }]);
    expect(k.transact({ summary: 'l', ops: [{ op: 'label', pin: 'R2.1' }] } as never).rejection?.message).toMatch(/BIAS is set to be drawn by wires/);
    const s = sheetOf(k);
    const w = wiresOf(s, netOf(k, 'BIAS').id)[0]!;
    const pg = s.pages[0]!.rect;
    const at = { page: 1, x: (w.pts[0]! + w.pts[2]!) / 2 - pg.x, y: (w.pts[1]! + w.pts[3]!) / 2 - pg.y, what: 'wire' };
    expect(byUser(k, [{ op: 'erase', at: [at] }]).rejection?.message).toMatch(/BIAS is set/);
  });

  it('leaves a supply one symbol on each wired piece', () => {
    const k = kernel();
    const r = byUser(k, [{ op: 'set_net', net: '+5V', draw_as: 'wire' }]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const s = sheetOf(k);
    const id = netOf(k, '+5V').id;
    expect(labelsOf(s, '+5V').filter((l) => !l.auto).length).toBe(1);
    const [a, b] = [pin(s, 'U1', 'VCC'), pin(s, 'C1', '1')];
    const on = (p: { x: number; y: number }) => s.wires.some((w) => w.netId === id && onWire(p.x, p.y, w.pts));
    expect(on(a) && on(b)).toBe(true);
    // and that one can be moved
    const l = labelsOf(s, '+5V')[0]!;
    expect(byUser(k, [move(s, l, 0, -200)]).status, 'moved').toBe('ok');
    expect(labelsOf(sheetOf(k), '+5V').length).toBe(1);
  });
});

describe('a net no longer forced', () => {
  it('is drawn afresh, wired where that is clean, and may be changed again', () => {
    const k = kernel();
    byUser(k, [{ op: 'set_net', net: 'BIAS', draw_as: 'label' }]);
    const id = netOf(k, 'BIAS').id;
    expect(wiresOf(sheetOf(k), id)).toEqual([]);
    const r = byUser(k, [{ op: 'set_net', net: 'BIAS', draw_as: null }]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const s = sheetOf(k);
    expect(netOf(k, 'BIAS').attrs.drawAs).toBeUndefined();
    const [a, b] = [pin(s, 'U1', 'IN2'), pin(s, 'R2', '1')];
    expect(s.wires.some((w) => w.netId === id && onWire(a.x, a.y, w.pts) && onWire(b.x, b.y, w.pts))).toBe(true);
    expect(labelsOf(s, 'BIAS')).toEqual([]);
    expect(byUser(k, [{ op: 'erase', net: 'BIAS' }]).status).toBe('ok');
  });

  it('comes back as it was by undo, and leaves a sheet the layout draws alone', () => {
    const k = kernel();
    const s0 = sheetOf(k);
    byUser(k, [{ op: 'set_net', net: 'BIAS', draw_as: 'label' }]);
    k.undo();
    expect(k.committedDesign().drawing).toBeUndefined();
    expect(sheetOf(k).wires).toEqual(s0.wires);
    expect(byUser(k, [{ op: 'set_net', net: 'BIAS', draw_as: null }]).status).toBe('ok');
    expect(k.committedDesign().drawing).toBeUndefined();
  });
});

describe('set_net draw_as saying what is so already', () => {
  it('leaves the drawing alone: a net wired by hand and never forced is not drawn afresh', () => {
    const k = kernel();
    byUser(k, [{ op: 'label', pin: 'R2.1', dir: 'left' }]);
    const before = sheetOf(k);
    expect(byUser(k, [{ op: 'set_net', net: 'BIAS', draw_as: null }]).results[0]!.effect).not.toMatch(/drawn/);
    expect(sheetOf(k).wires).toEqual(before.wires);
    expect(sheetOf(k).labels).toEqual(before.labels);
  });
});

describe('a supply symbol in Optimize', () => {
  it('may move inside the area, not out of it', () => {
    const k = kernel();
    const s = sheetOf(k);
    const l = vcc(k);
    const u1 = s.symbols.find((x) => x.refdes === 'U1')!;
    const info = k.setScope({ view: 'schematic', sheet: s.id, rect: { x: u1.bbox.x - 1500, y: u1.bbox.y - 1500, w: u1.bbox.w + 3000, h: u1.bbox.h + 3000 } });
    expect(info && 'error' in info).toBe(false);
    expect(k.transact({ summary: 'out', ops: [move(s, l, 0, -1600)] } as never).rejection?.code).toBe('OUT_OF_SCOPE');
    const r = k.transact({ summary: 'in', ops: [move(s, l, 0, -300)] } as never);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  });
});

describe('a forced net and R or F', () => {
  it('is drawn its way again wherever the turn puts the pins', () => {
    for (const look of [{ rotate: 90 }, { rotate: 180 }, { mirror: true }]) {
      const k = kernel();
      byUser(k, [{ op: 'set_net', net: 'BIAS', draw_as: 'label' }, { op: 'set_net', net: 'IN_F', draw_as: 'wire' }]);
      const r = byUser(k, [{ op: 'place_symbol', ref: 'U1', ...standing(k, 'U1'), ...look, rewire: true }]);
      expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
      const s = sheetOf(k);
      const bias = netOf(k, 'BIAS').id;
      expect(wiresOf(s, bias)).toEqual([]);
      for (const p of [pin(s, 'U1', 'IN2'), pin(s, 'R2', '1')]) expect(s.labels.some((l) => l.netId === bias && l.x === p.x && l.y === p.y && !l.auto)).toBe(true);
      // (an automatic label would show if any pin were left out)
      expect(labelsOf(s, 'IN_F')).toEqual([]);
      expect(wiresOf(s, netOf(k, 'IN_F').id).length).toBeGreaterThan(0);
    }
  });
});

describe('a forced net and a partial accept', () => {
  it('is drawn its way when the net is taken and the drawing is not', () => {
    const k = kernel();
    k.transact({ summary: 'force', ops: [{ op: 'set_net', net: 'BIAS', draw_as: 'label' }] } as never);
    const hunks = k.state().proposal!.hunks;
    const net = hunks.find((h) => h.kind === 'net');
    expect(net).toBeTruthy();
    k.accept([net!.id]);
    expect(wiresOf(sheetOf(k), netOf(k, 'BIAS').id)).toEqual([]);
  });
});

/** Two sheets: a net that goes on to the other sheet keeps a label there. */
describe('a net on two sheets', () => {
  it('is forced on both', () => {
    const k = kernel({ op: 'add_sheet', name: 'Two' }, { op: 'move_to_sheet', refs: ['R2'], sheet: 'Two' });
    const f = byUser(k, [{ op: 'set_net', net: 'BIAS', draw_as: 'wire' }]);
    expect(f.status, JSON.stringify(f.rejection)).toBe('ok');
    const [a, b] = k.state().view.sheets;
    expect(labelsOf(a!, 'BIAS').every((l) => l.auto)).toBe(true);
    expect(labelsOf(a!, 'BIAS').length).toBe(1);
    expect(labelsOf(b!, 'BIAS').length).toBe(1);
    const g = byUser(k, [{ op: 'set_net', net: 'BIAS', draw_as: 'label' }]);
    expect(g.status).toBe('ok');
    const [a2, b2] = k.state().view.sheets;
    expect(labelsOf(a2!, 'BIAS').filter((l) => !l.auto).length).toBe(1);
    expect(labelsOf(b2!, 'BIAS').filter((l) => !l.auto).length).toBe(1);
  });
});
