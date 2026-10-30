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

describe('which way round a symbol is drawn', () => {
  const crystal: PartCard = { ...ic, id: 'acme:XTAL', mpn: 'acme:XTAL', description: '12 MHz crystal', category: 'crystal', refPrefix: 'Y', pins: [{ number: '1', name: 'XTAL1', type: 'passive' }, { number: '2', name: 'GND', type: 'passive' }, { number: '3', name: 'XTAL2', type: 'passive' }, { number: '4', name: 'GND', type: 'passive' }] };
  const nmos: PartCard = { ...ic, id: 'acme:NMOS', mpn: 'acme:NMOS', description: 'N-channel MOSFET', category: 'transistor', refPrefix: 'Q', pins: [{ number: '1', name: 'G', type: 'in' }, { number: '2', name: 'S', type: 'passive' }, { number: '3', name: 'D', type: 'passive' }] };
  const buzzer: PartCard = { ...ic, id: 'acme:BUZZER', mpn: 'acme:BUZZER', description: 'Passive buzzer', category: 'other', refPrefix: 'BZ', pins: [{ number: '1', name: '+', type: 'passive' }, { number: '2', name: '-', type: 'passive' }] };

  function design(ops: unknown[]) {
    const k = new Kernel();
    const d = k.committedDesign();
    for (const card of [ic, crystal, nmos, buzzer]) d.parts[card.id] = card;
    k.load(d);
    const r = k.transact({ summary: 'circuit', ops } as never);
    expect(r.status, JSON.stringify(r).slice(0, 400)).toBe('ok');
    k.accept();
    return k;
  }
  const spot = (k: Kernel, ref: string) => {
    const s = sheetOf(k);
    const c = centre(s, ref);
    return { page: 1, x: c.x - s.pages[0]!.rect.x, y: c.y - s.pages[0]!.rect.y };
  };
  /** The app's F and R, as SchematicCanvas sends them. */
  const pressF = (k: Kernel, ref: string) => byUser(k, [{ op: 'place_symbol', ref, ...spot(k, ref), mirror: !sym(sheetOf(k), ref).mirrored, rewire: true }]);
  const pressR = (k: Kernel, ref: string) => {
    const s = sym(sheetOf(k), ref);
    return byUser(k, [{ op: 'place_symbol', ref, ...spot(k, ref), ...(s.twoPin ? { orient: s.rotation ? 'upright' : 'lying', mirror: !!s.mirrored } : { rotate: ((s.rotated ?? 0) + 90) % 360 }), rewire: true }]);
  };
  const ends = (k: Kernel, ref: string) => {
    const s = sym(sheetOf(k), ref);
    const c = centre(sheetOf(k), ref);
    return s.pins.map((p) => `${p.name}:${p.x - c.x},${p.y - c.y},${p.side}`);
  };
  const xtalCircuit = [
    { op: 'add_part', part: 'acme:IC', refdes: 'U1' },
    { op: 'add_part', part: 'acme:XTAL', refdes: 'Y1' },
    { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '18pF', voltage: '50V' } },
    { op: 'add_part', part: 'generic:C', refdes: 'C2', params: { capacitance: '18pF', voltage: '50V' } },
    { op: 'connect', pins: ['Y1.XTAL1', 'C1.1', 'U1.IN1'], net: 'XIN' },
    { op: 'connect', pins: ['Y1.XTAL2', 'C2.1', 'U1.IN2'], net: 'XOUT' },
    { op: 'connect', pins: ['Y1.GND', 'C1.2', 'C2.2', 'U1.GND'], net: 'GND' },
  ];
  const leftTerminal = (k: Kernel) => sym(sheetOf(k), 'Y1').pins.find((p) => p.side === 'left')!.name;

  it('says what stands now and what a mirror did, so asking for what is already so does not pass for a flip', () => {
    const k = design(xtalCircuit);
    const y = spot(k, 'Y1');
    const first = k.transact({ summary: 'swap', ops: [{ op: 'place_symbol', ref: 'Y1', ...y, mirror: true }] } as never);
    expect(first.results[0]!.effect).toMatch(/; now mirrored; pins: left XTAL2, right XTAL1, bottom GND$/);
    expect(leftTerminal(k)).toBe('XTAL2');
    k.accept();
    const q = k.query({ op: 'get_schematic' }) as { symbols: { ref: string; mirrored?: boolean }[]; symbols_note: string };
    expect(q.symbols.find((x) => x.ref === 'Y1')!.mirrored).toBe(true);
    expect(q.symbols.find((x) => x.ref === 'U1')!.mirrored).toBeUndefined();
    expect(q.symbols_note).toMatch(/opposite/);
    // what the agent did in the chat: mirror true on a symbol mirrored already
    const again = k.transact({ summary: 'swap', ops: [{ op: 'place_symbol', ref: 'Y1', ...y, mirror: true }] } as never);
    expect(again.results[0]!.effect).toMatch(/it is mirrored already, so that changed nothing: mirror false draws it the other way round/);
    expect(leftTerminal(k)).toBe('XTAL2');
    k.accept();
    const back = k.transact({ summary: 'swap', ops: [{ op: 'place_symbol', ref: 'Y1', ...y, mirror: false }] } as never);
    expect(back.results[0]!.effect).toMatch(/; now not mirrored; pins: left XTAL1, right XTAL2, bottom GND$/);
    expect(leftTerminal(k)).toBe('XTAL1');
    expect(sym(sheetOf(k), 'Y1').mirrored).toBeUndefined();
  });

  it('F mirrors a crystal and back, its wires drawn again', () => {
    const k = design(xtalCircuit);
    const was = ends(k, 'Y1');
    expect(pressF(k, 'Y1').status).toBe('ok');
    expect(leftTerminal(k)).toBe('XTAL2');
    expect(pressF(k, 'Y1').status).toBe('ok');
    expect(ends(k, 'Y1')).toEqual(was);
  });

  it('turns over the symbols that have no sides of their own to swap: a transistor gets its gate on the right', () => {
    const k = design([
      { op: 'add_part', part: 'acme:NMOS', refdes: 'Q1' },
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } },
      { op: 'connect', pins: ['Q1.G', 'R1.1'], net: 'GATE' },
      { op: 'connect', pins: ['Q1.S', 'R1.2'], net: 'GND' },
      { op: 'connect', pins: ['Q1.D'], net: 'LOAD' },
    ]);
    const was = ends(k, 'Q1');
    expect(was.find((e) => e.startsWith('G:'))).toMatch(/,left$/);
    const r = pressF(k, 'Q1');
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(ends(k, 'Q1').find((e) => e.startsWith('G:'))).toMatch(/,right$/);
    expect(sym(sheetOf(k), 'Q1').mirrored).toBe(true);
    expect(k.state().diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    // the layout draws it as it was left when the sheet goes back to it
    expect(k.transact({ summary: 'tidy', ops: [{ op: 'auto_draw' }] } as never).status).toBe('ok');
    expect(ends(k, 'Q1').find((e) => e.startsWith('G:'))).toMatch(/,right$/);
    expect(sym(sheetOf(k), 'Q1').mirrored).toBe(true);
  });

  it('leaves a transistor as it was drawn when a drawing from before says mirror, and F then really mirrors it', () => {
    const circuit = [
      { op: 'add_part', part: 'acme:NMOS', refdes: 'Q1' },
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } },
      { op: 'connect', pins: ['Q1.G', 'R1.1'], net: 'GATE' },
      { op: 'connect', pins: ['Q1.S', 'R1.2'], net: 'GND' },
      { op: 'connect', pins: ['Q1.D'], net: 'LOAD' },
    ];
    const k = design(circuit);
    byUser(k, [{ op: 'place_symbol', ref: 'Q1', ...spot(k, 'Q1') }]);
    const d = k.committedDesign();
    const sheet = Object.values(d.drawing!)[0]!;
    // as F left it before: `mirror` stored, nothing drawn differently
    sheet.symbols.find((s) => s.part === 'acme:NMOS')!.spec = { mirror: true };
    const old = new Kernel();
    old.load(d);
    const was = sheetOf(old);
    expect(ends(old, 'Q1')).toEqual(ends(k, 'Q1'));
    expect(sym(was, 'Q1').mirrored).toBeUndefined();
    expect(was.wires).toEqual(sheetOf(k).wires);
    const r = pressF(old, 'Q1');
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(ends(old, 'Q1').find((e) => e.startsWith('G:'))).toMatch(/,right$/);
    // and it stays so through a save
    const again = new Kernel();
    again.load(old.committedDesign());
    expect(ends(again, 'Q1')).toEqual(ends(old, 'Q1'));
    expect(sym(sheetOf(again), 'Q1').mirrored).toBe(true);
  });

  it('the layout mirrors what swaps its pins toward its neighbour, never what would turn over', () => {
    const relay: PartCard = { ...ic, id: 'acme:RELAY', mpn: 'acme:RELAY', description: 'Signal relay', category: 'other', refPrefix: 'K', pins: [{ number: '1', name: 'COIL+', type: 'passive' }, { number: '2', name: 'COIL-', type: 'passive' }, { number: '3', name: 'COM', type: 'passive' }, { number: '4', name: 'NO', type: 'passive' }, { number: '5', name: 'NC', type: 'passive' }] };
    const k = new Kernel();
    const d = k.committedDesign();
    d.parts[ic.id] = ic;
    d.parts[relay.id] = relay;
    k.load(d);
    const r = k.transact({ summary: 'c', ops: [
      { op: 'add_part', part: 'acme:RELAY', refdes: 'K1' },
      { op: 'add_part', part: 'acme:IC', refdes: 'U1' },
      { op: 'connect', pins: ['U1.IN1', 'K1.COM'], net: 'A' },
      { op: 'connect', pins: ['U1.OUT', 'K1.NO'], net: 'B' },
      { op: 'connect', pins: ['K1.COIL+'], net: 'C' },
      { op: 'describe', blocks: [{ title: 'Switch', refs: ['K1', 'U1'] }] },
    ] } as never);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(sym(sheetOf(k), 'K1').mirrored).toBeUndefined();
    const coil = sym(sheetOf(k), 'K1').pins.find((p) => p.name === 'COIL+')!;
    const com = sym(sheetOf(k), 'K1').pins.find((p) => p.name === 'COM')!;
    expect(coil.x).toBeLessThan(com.x); // the coil on the left, as a relay is drawn
  });

  it('R turns a crystal by quarters, wired as it goes, and four presses bring it back to the mil', () => {
    const k = design(xtalCircuit);
    const place = () => {
      const s = sym(sheetOf(k), 'Y1');
      return { bbox: s.bbox, pins: s.pins.map((p) => `${p.name}:${p.x},${p.y},${p.side}`) };
    };
    const side = (name: string) => sym(sheetOf(k), 'Y1').pins.find((p) => p.name === name)!.side;
    const sides = () => [side('XTAL1'), side('XTAL2'), side('GND')];
    expect(sym(sheetOf(k), 'Y1').twoPin).toBeUndefined();
    expect(sides()).toEqual(['left', 'right', 'bottom']);
    const turns = [
      [90, ['top', 'bottom', 'left']],
      [180, ['right', 'left', 'top']],
      [270, ['bottom', 'top', 'right']],
      [undefined, ['left', 'right', 'bottom']],
    ] as const;
    for (const [rotated, want] of turns) {
      const r = pressR(k, 'Y1');
      expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
      expect(r.results[0]!.effect).toMatch(/pins: /);
      expect(sym(sheetOf(k), 'Y1').rotated).toBe(rotated);
      expect(sides()).toEqual(want);
    }
    // the first turn may bring it onto the grid; from there every round ends on the same spot
    const start = place();
    for (const p of start.pins) {
      const [, xy] = p.split(':');
      const [x, y] = xy!.split(',').map(Number);
      expect(x! % 100).toBe(0);
      expect(y! % 100).toBe(0);
    }
    const seen: unknown[] = [];
    for (let i = 0; i < 8; i++) {
      pressR(k, 'Y1');
      seen.push(place());
    }
    expect(seen[3]).toEqual(start);
    expect(seen[7]).toEqual(start);
    expect(seen[0]).toEqual(seen[4]);
    expect(k.state().diagnostics.filter((x) => x.code.startsWith('SCH.') && x.severity === 'error')).toEqual([]);
  });

  it('the agent says how a symbol ends up with rotate, sees it in get_schematic, and is told when it changed nothing', () => {
    const k = design(xtalCircuit);
    const y = spot(k, 'Y1');
    const r = k.transact({ summary: 'stand', ops: [{ op: 'place_symbol', ref: 'Y1', ...y, rotate: 90 }] } as never);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(r.results[0]!.effect).toMatch(/; now rotated 90°; pins: left GND, top XTAL1, bottom XTAL2/);
    k.accept();
    const row = (ref: string) => (k.query({ op: 'get_schematic' }) as { symbols: { ref: string; rotated?: number; w: number; h: number }[] }).symbols.find((x) => x.ref === ref)!;
    expect(row('Y1')).toMatchObject({ rotated: 90, w: 300, h: 400 });
    expect((k.query({ op: 'get_schematic' }) as { symbols_note: string }).symbols_note).toMatch(/rotated: degrees clockwise/);
    const same = k.transact({ summary: 'stand', ops: [{ op: 'place_symbol', ref: 'Y1', ...spot(k, 'Y1'), rotate: 90 }] } as never);
    expect(same.results[0]!.effect).toMatch(/it is rotated 90° already, so that changed nothing/);
    k.accept();
    // both at once: mirrored first, then turned; and back to how it is usually drawn
    const both = k.transact({ summary: 'stand', ops: [{ op: 'place_symbol', ref: 'Y1', ...spot(k, 'Y1'), rotate: 270, mirror: true }] } as never);
    expect(both.results[0]!.effect).toMatch(/now mirrored and rotated 270°; pins: right GND, top XTAL1, bottom XTAL2/);
    k.accept();
    expect(k.transact({ summary: 'lie', ops: [{ op: 'place_symbol', ref: 'Y1', ...spot(k, 'Y1'), rotate: 0, mirror: false }] } as never).status).toBe('ok');
    expect(row('Y1').rotated).toBeUndefined();
    // each its own lever: orient for what stands or lies, rotate for the rest
    const orient = k.transact({ summary: 'x', ops: [{ op: 'place_symbol', ref: 'Y1', ...spot(k, 'Y1'), orient: 'upright' }] } as never);
    expect(orient.rejection?.message).toMatch(/give it rotate/);
    const rotate = k.transact({ summary: 'x', ops: [{ op: 'place_symbol', ref: 'C1', ...spot(k, 'C1'), rotate: 90 }] } as never);
    expect(rotate.rejection?.message).toMatch(/give it orient/);
    // a move and a turn together: the new centre goes there
    const moved = k.transact({ summary: 'move', ops: [{ op: 'place_symbol', ref: 'Y1', page: 1, x: 6000, y: 6000, rotate: 90 }] } as never);
    expect(moved.status).toBe('ok');
    const { x, y: yy } = row('Y1') as unknown as { x: number; y: number };
    expect(Math.abs(x - 6000)).toBeLessThanOrEqual(50);
    expect(Math.abs(yy - 6000)).toBeLessThanOrEqual(50);
  });

  it('R turns a transistor too, F swaps its sides in its own frame, and both stay through a save', () => {
    const k = design([
      { op: 'add_part', part: 'acme:NMOS', refdes: 'Q1' },
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } },
      { op: 'connect', pins: ['Q1.G', 'R1.1'], net: 'GATE' },
      { op: 'connect', pins: ['Q1.S', 'R1.2'], net: 'GND' },
      { op: 'connect', pins: ['Q1.D'], net: 'LOAD' },
    ]);
    const side = (kk: Kernel, name: string) => sym(sheetOf(kk), 'Q1').pins.find((p) => p.name === name)!.side;
    expect(pressR(k, 'Q1').status).toBe('ok');
    expect([side(k, 'G'), side(k, 'D'), side(k, 'S')]).toEqual(['top', 'right', 'left']);
    expect(pressF(k, 'Q1').status).toBe('ok');
    expect([side(k, 'G'), side(k, 'D'), side(k, 'S')]).toEqual(['bottom', 'right', 'left']);
    const again = new Kernel();
    again.load(k.committedDesign());
    expect(ends(again, 'Q1')).toEqual(ends(k, 'Q1'));
    expect(sym(sheetOf(again), 'Q1')).toMatchObject({ rotated: 90, mirrored: true });
    expect(sheetOf(again).wires).toEqual(sheetOf(k).wires);
    expect(again.state().diagnostics.filter((x) => x.code.startsWith('SCH.') && x.severity === 'error')).toEqual([]);
  });

  it('turns an IC with its pins, keeps it through a new pin layout, and the layout stands it so when the sheet goes back to it', () => {
    const k = design(chain);
    const was = ends(k, 'U1');
    const r = pressR(k, 'U1');
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const left = (e: string[]) => e.filter((x) => x.endsWith(',left')).map((x) => x.split(':')[0]);
    const top = (e: string[]) => e.filter((x) => x.endsWith(',top')).map((x) => x.split(':')[0]);
    expect(top(ends(k, 'U1'))).toEqual(left(was));
    expect(sym(sheetOf(k), 'U1').rotated).toBe(90);
    for (const s of sym(sheetOf(k), 'U1').pins) expect(s.y % 100).toBe(sym(sheetOf(k), 'U1').pins[0]!.y % 100);
    // a new arrangement of its pins keeps the turn
    const l = k.transact({ summary: 'layout', ops: [{ op: 'set_symbol', ref: 'U1', layout: { left: ['IN2', 'IN1'], right: ['OUT'], top: ['VCC'], bottom: ['GND'] } }] } as never);
    expect(l.status, JSON.stringify(l.rejection)).toBe('ok');
    k.accept();
    expect(sym(sheetOf(k), 'U1').rotated).toBe(90);
    expect(top(ends(k, 'U1'))).toEqual(['IN2', 'IN1']);
    // the sheet back to the layout: where the user left it, as they left it
    const c = centre(sheetOf(k), 'U1');
    expect(k.transact({ summary: 'tidy', ops: [{ op: 'auto_draw' }] } as never).status).toBe('ok');
    expect(Object.values(k.draftDesign().ledger).find((x) => x.kind === 'sch_position' && x.a === sym(sheetOf(k), 'U1').componentId)).toMatchObject({ rotated: 90 });
    expect(sym(sheetOf(k), 'U1').rotated).toBe(90);
    expect(Math.abs(centre(sheetOf(k), 'U1').x - c.x)).toBeLessThanOrEqual(100);
    expect(k.state().diagnostics.filter((x) => x.code.startsWith('SCH.') && x.severity === 'error')).toEqual([]);
  });

  it('says where the pins went on a small symbol, not on one with many', () => {
    const big: PartCard = { ...ic, id: 'acme:BIG', mpn: 'acme:BIG', pins: Array.from({ length: 8 }, (_, i) => ({ number: `${i + 1}`, name: `P${i + 1}`, type: 'bidir' as const })) };
    const k = new Kernel();
    const d = k.committedDesign();
    d.parts[big.id] = big;
    k.load(d);
    expect(k.transact({ summary: 'c', ops: [{ op: 'add_part', part: 'acme:BIG', refdes: 'U1' }, { op: 'connect', pins: ['U1.P1'], net: 'A' }] } as never).status).toBe('ok');
    k.accept();
    const r = k.transact({ summary: 'turn', ops: [{ op: 'place_symbol', ref: 'U1', ...spot(k, 'U1'), rotate: 90 }] } as never);
    expect(r.results[0]!.effect).toMatch(/now rotated 90°/);
    expect(r.results[0]!.effect).not.toMatch(/pins:/);
    const stay = k.transact({ summary: 'move', ops: [{ op: 'place_symbol', ref: 'U1', ...spot(k, 'U1') }] } as never);
    expect(stay.results[0]!.effect).not.toMatch(/pins:|now /);
  });

  it('turns a connector, each pin leaving the way it now faces', () => {
    const k = design(chain);
    const was = sym(sheetOf(k), 'J1').pins[0]!.side;
    const r = pressR(k, 'J1');
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const s = sym(sheetOf(k), 'J1');
    expect(s.rotated).toBe(90);
    expect(new Set(s.pins.map((p) => p.side)).size).toBe(1);
    expect(s.pins[0]!.side).toBe({ left: 'top', top: 'right', right: 'bottom', bottom: 'left' }[was]);
    expect(s.pins[0]!.y).toBe(s.pins[0]!.side === 'top' ? s.bbox.y : s.bbox.y + s.bbox.h);
  });

  it('turns one unit of a split IC and leaves the others', () => {
    const big: PartCard = { ...ic, id: 'acme:MCU', mpn: 'acme:MCU', pins: [{ number: '1', name: 'VDD', type: 'pwr_in' }, { number: '2', name: 'VSS', type: 'pwr_in' }, ...Array.from({ length: 12 }, (_, i) => ({ number: `${i + 3}`, name: `PA${i}`, type: 'bidir' as const }))] };
    const k = new Kernel();
    const d = k.committedDesign();
    d.parts[big.id] = big;
    k.load(d);
    const made = k.transact({ summary: 'c', ops: [{ op: 'add_part', part: 'acme:MCU', refdes: 'U1' }, { op: 'connect', pins: ['U1.PA0'], net: 'A' }, { op: 'set_symbol', ref: 'U1', style: 'units' }] } as never);
    expect(made.status, JSON.stringify(made.rejection)).toBe('ok');
    k.accept();
    const units = sheetOf(k).symbols.filter((x) => x.refdes === 'U1');
    expect(units.length).toBeGreaterThan(1);
    const [a, b] = [units[0]!, units[1]!];
    const pg = sheetOf(k).pages[0]!.rect;
    const r = byUser(k, [{ op: 'place_symbol', ref: `U1${b.unit}`, page: 1, x: b.bbox.x + b.bbox.w / 2 - pg.x, y: b.bbox.y + b.bbox.h / 2 - pg.y, rotate: 90 }]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const now = sheetOf(k).symbols.filter((x) => x.refdes === 'U1');
    expect(now.find((x) => x.unit === b.unit)!.rotated).toBe(90);
    expect(now.find((x) => x.unit === a.unit)!.rotated).toBeUndefined();
    expect(now.find((x) => x.unit === b.unit)!.pins.map((p) => p.number).sort()).toEqual(b.pins.map((p) => p.number).sort());
  });

  it('draws a turned transistor with its load and gate parts when the sheet goes back to the layout', () => {
    const k = design([
      { op: 'add_part', part: 'acme:NMOS', refdes: 'Q1' },
      { op: 'add_part', part: 'acme:BUZZER', refdes: 'BZ1' },
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '100' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '10k' } },
      { op: 'connect', pins: ['Q1.D', 'BZ1.-'], net: 'SW' },
      { op: 'connect', pins: ['BZ1.+'], net: '+5V' },
      { op: 'connect', pins: ['Q1.G', 'R1.1', 'R2.1'], net: 'GATE' },
      { op: 'connect', pins: ['R1.2'], net: 'DRIVE' },
      { op: 'connect', pins: ['Q1.S', 'R2.2'], net: 'GND' },
      { op: 'set_net', net: '+5V', voltage: 5 },
    ]);
    expect(pressR(k, 'Q1').status).toBe('ok');
    const turned = ends(k, 'Q1');
    expect(k.transact({ summary: 'tidy', ops: [{ op: 'auto_draw' }] } as never).status).toBe('ok');
    expect(sym(sheetOf(k), 'Q1').rotated).toBe(90);
    expect(ends(k, 'Q1')).toEqual(turned);
    const drawn = sheetOf(k).symbols.map((x) => x.refdes).sort();
    expect(drawn).toEqual(['BZ1', 'Q1', 'R1', 'R2']);
    expect(k.state().diagnostics.filter((x) => x.code.startsWith('SCH.') && x.severity === 'error')).toEqual([]);
  });

  it('R stands or lays a load drawn standing on a transistor, as a two-pin part', () => {
    const k = design([
      { op: 'add_part', part: 'acme:NMOS', refdes: 'Q1' },
      { op: 'add_part', part: 'acme:BUZZER', refdes: 'BZ1' },
      { op: 'connect', pins: ['Q1.D', 'BZ1.-'], net: 'SW' },
      { op: 'connect', pins: ['BZ1.+'], net: '+5V' },
      { op: 'connect', pins: ['Q1.G'], net: 'DRIVE' },
      { op: 'connect', pins: ['Q1.S'], net: 'GND' },
      { op: 'set_net', net: '+5V', voltage: 5 },
    ]);
    const stood = ends(k, 'BZ1');
    expect(sym(sheetOf(k), 'BZ1').twoPin).toBe(true);
    const r = pressR(k, 'BZ1');
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(sym(sheetOf(k), 'BZ1').rotation).toBe(90);
    expect(ends(k, 'BZ1')).toEqual(['+:-200,0,left', '-:200,0,right']);
    expect(pressR(k, 'BZ1').status).toBe('ok');
    expect(ends(k, 'BZ1')).toEqual(stood);
  });

  it('F swaps the ends of a two-pin part where it stands, standing or lying; R brings back what was there', () => {
    const k = design([
      { op: 'add_part', part: 'acme:IC', refdes: 'U1' },
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } },
      { op: 'connect', pins: ['U1.IN2', 'R1.1'], net: 'PULLED' },
      { op: 'connect', pins: ['U1.VCC', 'R1.2'], net: '+3V3' },
      { op: 'set_net', net: '+3V3', voltage: 3.3 },
    ]);
    // the layout draws this pull-up with its rail on top, so its pin 1 at the bottom
    expect(ends(k, 'R1')).toEqual(['1:0,200,bottom', '2:0,-200,top']);
    expect(sym(sheetOf(k), 'R1').mirrored).toBe(true);
    const { bbox } = sym(sheetOf(k), 'R1');
    expect(pressF(k, 'R1').status).toBe('ok');
    expect(ends(k, 'R1')).toEqual(['1:0,-200,top', '2:0,200,bottom']);
    expect(sym(sheetOf(k), 'R1').bbox).toEqual(bbox); // it stays where it is
    expect(sym(sheetOf(k), 'R1').mirrored).toBeUndefined();
    expect(pressF(k, 'R1').status).toBe('ok');
    expect(ends(k, 'R1')).toEqual(['1:0,200,bottom', '2:0,-200,top']);
    // turned and turned back, pin 1 is where it was: turning alone used to put it on top
    expect(pressR(k, 'R1').status).toBe('ok');
    expect(ends(k, 'R1')).toEqual(['1:200,0,right', '2:-200,0,left']);
    expect(sym(sheetOf(k), 'R1').mirrored).toBe(true);
    expect(pressF(k, 'R1').status).toBe('ok');
    expect(ends(k, 'R1')).toEqual(['1:-200,0,left', '2:200,0,right']);
    expect(sym(sheetOf(k), 'R1').rotation).toBe(90);
    expect(pressF(k, 'R1').status).toBe('ok');
    expect(pressR(k, 'R1').status).toBe('ok');
    expect(ends(k, 'R1')).toEqual(['1:0,200,bottom', '2:0,-200,top']);
    // its nets stay on its pins: only the drawing changed
    expect(k.committedDesign().components[sym(sheetOf(k), 'R1').componentId]!.pins['2']).toBe(Object.values(k.committedDesign().nets).find((n) => n.name === '+3V3')!.id);
  });

  it('an agent turning a two-pin part gets pin 1 on the left or on top, as before, unless it says otherwise', () => {
    const k = design([
      { op: 'add_part', part: 'acme:IC', refdes: 'U1' },
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } },
      { op: 'connect', pins: ['U1.IN2', 'R1.1'], net: 'PULLED' },
      { op: 'connect', pins: ['U1.VCC', 'R1.2'], net: '+3V3' },
      { op: 'set_net', net: '+3V3', voltage: 3.3 },
    ]);
    expect(sym(sheetOf(k), 'R1').mirrored).toBe(true);
    k.transact({ summary: 'turn', ops: [{ op: 'place_symbol', ref: 'R1', ...spot(k, 'R1'), orient: 'lying' }] } as never);
    expect(ends(k, 'R1')).toEqual(['1:-200,0,left', '2:200,0,right']);
    k.transact({ summary: 'turn', ops: [{ op: 'place_symbol', ref: 'R1', ...spot(k, 'R1'), orient: 'upright' }] } as never);
    expect(ends(k, 'R1')).toEqual(['1:0,-200,top', '2:0,200,bottom']);
    const r = k.transact({ summary: 'turn', ops: [{ op: 'place_symbol', ref: 'R1', ...spot(k, 'R1'), orient: 'lying', mirror: true }] } as never);
    expect(r.results[0]!.effect).not.toMatch(/already/);
    expect(ends(k, 'R1')).toEqual(['1:200,0,right', '2:-200,0,left']);
  });

  it('F on a load drawn standing on a transistor swaps its ends and leaves it standing', () => {
    const k = design([
      { op: 'add_part', part: 'acme:NMOS', refdes: 'Q1' },
      { op: 'add_part', part: 'acme:BUZZER', refdes: 'BZ1' },
      { op: 'connect', pins: ['Q1.D', 'BZ1.-'], net: 'SW' },
      { op: 'connect', pins: ['BZ1.+'], net: '+5V' },
      { op: 'connect', pins: ['Q1.G'], net: 'DRIVE' },
      { op: 'connect', pins: ['Q1.S'], net: 'GND' },
      { op: 'set_net', net: '+5V', voltage: 5 },
    ]);
    const stood = ends(k, 'BZ1');
    expect(stood).toEqual(expect.arrayContaining([expect.stringMatching(/^\+:.*,top$/), expect.stringMatching(/^-:.*,bottom$/)]));
    const { bbox } = sym(sheetOf(k), 'BZ1');
    const r = pressF(k, 'BZ1');
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(ends(k, 'BZ1')).toEqual(expect.arrayContaining([expect.stringMatching(/^\+:.*,bottom$/), expect.stringMatching(/^-:.*,top$/)]));
    expect(sym(sheetOf(k), 'BZ1').bbox).toEqual(bbox);
    expect(sym(sheetOf(k), 'BZ1').mirrored).toBe(true);
    expect(pressF(k, 'BZ1').status).toBe('ok');
    expect(ends(k, 'BZ1')).toEqual(stood);
    expect(sym(sheetOf(k), 'BZ1').mirrored).toBeUndefined();
  });

  it('keeps which end of a two-pin part the user turned over when the sheet goes back to the layout', () => {
    const k = design([
      { op: 'add_part', part: 'acme:IC', refdes: 'U1' },
      { op: 'add_part', part: 'generic:D', refdes: 'D1' },
      { op: 'connect', pins: ['U1.OUT', 'D1.A'], net: 'A' },
      { op: 'connect', pins: ['D1.K'], net: 'K' },
    ]);
    const was = ends(k, 'D1');
    expect(pressF(k, 'D1').status).toBe('ok');
    const turned = ends(k, 'D1');
    expect(turned).not.toEqual(was);
    expect(k.transact({ summary: 'tidy', ops: [{ op: 'auto_draw' }] } as never).status).toBe('ok');
    expect(ends(k, 'D1')).toEqual(turned);
    expect(Object.values(k.draftDesign().ledger).find((l) => l.kind === 'sch_position')).toMatchObject({ orient: 'upright' });
  });

  it('points a refused pin layout at what does swap the sides', () => {
    const k = design(xtalCircuit);
    const r = k.transact({ summary: 'x', ops: [{ op: 'set_symbol', ref: 'Y1', layout: { left: ['1'], right: ['3'], bottom: [['2', '4']] } }] } as never);
    expect(r.rejection?.code).toBe('SYMBOL_STYLE');
    expect(r.rejection?.message).toMatch(/place_symbol mirror/);
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
