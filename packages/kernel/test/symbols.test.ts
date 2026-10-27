import { afterAll, describe, expect, it } from 'vitest';
import { getBuiltinPart, registerUserParts, symbolFor, unregisterUserPart } from '@4k7/parts';
import type { Design, PartCard, PartPin, SheetView, SymbolView, Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';

const pin = (number: string, name: string, type: PartPin['type'] = 'passive', description?: string): PartPin => ({ number, name, type, ...(description ? { description } : {}) });
const own = (id: string, over: Partial<PartCard> & Pick<PartCard, 'category' | 'pins'>): PartCard => ({ id, mpn: id.split(':')[1], description: id, refPrefix: 'U', params: {}, provenance: { source: 'datasheet' }, ...over });

const SWITCH = own('test:TACT4', {
  description: 'SMD tactile switch, 4 pads',
  category: 'other',
  refPrefix: 'SW',
  pins: [
    pin('1', 'A', 'passive', 'internally connected to B'),
    pin('2', 'B', 'passive', 'internally connected to A'),
    pin('3', 'C', 'passive', 'internally connected to D'),
    pin('4', 'D', 'passive', 'internally connected to C'),
  ],
});
const CRYSTAL = own('test:XTAL4', { description: '12 MHz crystal', category: 'crystal', refPrefix: 'Y', pins: [pin('1', 'XTAL1'), pin('2', 'GND'), pin('3', 'XTAL2'), pin('4', 'GND')] });
const PFET = own('test:PFET8', {
  description: '30V P-channel MOSFET, SOIC-8',
  category: 'transistor',
  refPrefix: 'Q',
  pins: [pin('1', 'S'), pin('2', 'S'), pin('3', 'S'), pin('4', 'G', 'in'), pin('5', 'D'), pin('6', 'D'), pin('7', 'D'), pin('8', 'D')],
});
const INDUCTOR = own('test:IND12', { description: '10uH wire wound SMD power inductor, 5.4A', category: 'inductor', refPrefix: 'L', pins: [pin('1', '1'), pin('2', '2')] });
const FUSE = own('test:FUSE2A', { description: 'Fuse 2 A fast acting, 1206', category: 'other', refPrefix: 'F', pins: [pin('1', '1'), pin('2', '2')] });
registerUserParts([SWITCH, CRYSTAL, PFET, INDUCTOR, FUSE]);
afterAll(() => [SWITCH, CRYSTAL, PFET, INDUCTOR, FUSE].forEach((c) => unregisterUserPart(c.id)));

const sheetOf = (k: Kernel): SheetView => k.state().view.sheets[0]!;
const sym = (k: Kernel, ref: string): SymbolView => sheetOf(k).symbols.find((s) => s.refdes === ref)!;
const lines = (s: SymbolView) => s.prims.filter((p) => p.t === 'line');

function design(ops: Transaction['ops']): Kernel {
  const k = new Kernel();
  const r = k.transact({ summary: 'circuit', ops });
  expect(r.status, JSON.stringify(r).slice(0, 500)).toBe('ok');
  k.accept();
  return k;
}

describe('what a part is shows in its symbol', () => {
  it('takes an inductor\'s core and a diode\'s type from the component, checked against their choices', () => {
    const k = design([
      { op: 'add_part', part: 'generic:L', refdes: 'L1', params: { inductance: '10uH', core: 'iron' } },
      { op: 'add_part', part: 'generic:D', refdes: 'D1', params: { mpn: 'SS34' } },
      { op: 'connect', pins: ['L1.1'], net: 'SW' },
      { op: 'connect', pins: ['L1.2', 'D1.K'], net: 'OUT' },
      { op: 'connect', pins: ['D1.A'], net: 'GND' },
    ]);
    const core = (s: SymbolView) => lines(s).filter((l) => l.t === 'line' && l.x1 === l.x2 && l.x1 - (s.origin?.x ?? s.pins[0]!.x) > 25);
    expect(core(sym(k, 'L1')).length).toBeGreaterThan(0);
    const schottky = JSON.stringify(sym(k, 'D1').prims);
    const r = k.transact({ summary: 'plain', ops: [{ op: 'set_param', ref: 'D1', params: { type: 'standard' } }, { op: 'set_param', ref: 'L1', params: { core: 'air' } }] });
    expect(r.status).toBe('ok');
    expect(JSON.stringify(sym(k, 'D1').prims)).not.toBe(schottky);
    expect(core(sym(k, 'L1'))).toEqual([]);
    const bad = k.transact({ summary: 'bad', ops: [{ op: 'set_param', ref: 'L1', params: { core: 'steel' } }] });
    expect(bad.status).toBe('rejected');
    expect(JSON.stringify(bad)).toContain('is not one of ferrite, iron, air');
  });

  it('accepts the new parameters on a generic card an older design copied', () => {
    const k = design([{ op: 'add_part', part: 'generic:L', refdes: 'L1', params: { inductance: '10uH' } }]);
    const d = k.committedDesign();
    const old = structuredClone(getBuiltinPart('generic:L')!);
    delete old.params.core;
    d.parts['generic:L'] = old;
    const k2 = new Kernel();
    k2.load(d as Design);
    expect(k2.transact({ summary: 'core', ops: [{ op: 'set_param', ref: 'L1', params: { core: 'ferrite' } }] }).status).toBe('ok');
    expect(k2.query({ op: 'get_component', ref: 'L1' })).toMatchObject({ specs: { core: { values: ['ferrite', 'iron', 'air'] } } });
  });

  it('lets an imported inductor\'s core be set too, though its card has no parameters', () => {
    const k = design([{ op: 'add_part', part: INDUCTOR.id, refdes: 'L1' }, { op: 'connect', pins: ['L1.1'], net: 'SW' }, { op: 'connect', pins: ['L1.2'], net: 'OUT' }]);
    const dashes = () => lines(sym(k, 'L1')).filter((l) => l.t === 'line' && Math.abs(l.y2 - l.y1) === 20).length;
    expect(dashes()).toBe(8); // ferrite, from its description
    expect(k.transact({ summary: 'air', ops: [{ op: 'set_param', ref: 'L1', params: { core: 'air' } }] }).status).toBe('ok');
    expect(dashes()).toBe(0);
  });

  it('lays a part down with what it has beside it (the core) below it, clear of its text above', () => {
    // an inductor between two rails lies flat
    const k = design([
      { op: 'add_part', part: 'generic:L', refdes: 'L1', params: { inductance: '10uH' } },
      { op: 'connect', pins: ['L1.1'], net: '+5V' },
      { op: 'connect', pins: ['L1.2'], net: '+5V_F' },
      { op: 'set_net', net: '+5V', voltage: 5 },
      { op: 'set_net', net: '+5V_F', voltage: 5 },
    ]);
    const l1 = sym(k, 'L1');
    expect(l1.rotation).toBe(90);
    const o = l1.origin!;
    // rotate(90) turns the symbol's +x (the core's side) to +y: below
    const coreYs = lines(l1).flatMap((l) => (l.t === 'line' && l.x1 === l.x2 && l.x1 - o.x > 25 ? [l.x1 - o.x] : []));
    expect(coreYs.length).toBeGreaterThan(0);
    expect(l1.refPos.y).toBeLessThan(o.y);
    expect(l1.pins.find((p) => p.number === '1')!.x).toBeLessThan(o.x); // pin 1 on the rail it comes from, as before
  });

  it('turns a rail on a P-MOSFET\'s drain below it aside, pointing up', () => {
    const k = design([
      { op: 'add_part', part: PFET.id, refdes: 'Q1' },
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '100k' } },
      { op: 'connect', pins: ['Q1.S'], net: 'VBUS' },
      { op: 'connect', pins: ['Q1.D'], net: '+5V' },
      { op: 'connect', pins: ['Q1.G', 'R1.1'], net: 'GATE' },
      { op: 'connect', pins: ['R1.2'], net: 'GND' },
      { op: 'set_net', net: 'VBUS', voltage: 5, external: true },
      { op: 'set_net', net: '+5V', voltage: 5 },
    ]);
    const q1 = sym(k, 'Q1');
    expect(q1.prims.some((p) => p.t === 'poly')).toBe(true); // a MOSFET, not a box
    expect(new Set(q1.pins.filter((p) => p.name === 'D').map((p) => p.side))).toEqual(new Set(['bottom']));
    const rail = sheetOf(k).labels.find((l) => l.text === '+5V')!;
    expect(rail.dir).toBe('up');
    expect(k.state().diagnostics.filter((x) => x.code === 'SCH.RAIL_UP')).toEqual([]);
  });
});

describe('power through protection parts', () => {
  it('follows a supply through a fuse, as through a resistor', () => {
    const k = design([
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
      { op: 'add_part', part: FUSE.id, refdes: 'F1' },
      { op: 'add_part', part: 'ams:AMS1117-3.3', refdes: 'U1' },
      { op: 'connect', pins: ['J1.1', 'F1.1'], net: 'VIN' },
      { op: 'connect', pins: ['F1.2', 'U1.VIN'], net: 'VIN_F' },
      { op: 'connect', pins: ['J1.2', 'U1.GND'], net: 'GND' },
      { op: 'connect', pins: ['U1.VOUT'], net: '+3V3' },
      { op: 'set_net', net: 'VIN', external: true, voltage: 5 },
    ]);
    expect(k.state().diagnostics.filter((x) => x.code === 'ERC.POWER_UNDRIVEN')).toEqual([]);
    expect(sym(k, 'F1').pins.map((p) => p.side)).toEqual(['left', 'right']); // drawn as a fuse, lying
  });
});

describe('a sheet the agent arranged', () => {
  /** A pulled-up button and a crystal with its load caps, the sheet taken over. */
  function arranged(): Kernel {
    const k = design([
      { op: 'add_part', part: SWITCH.id, refdes: 'SW1' },
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } },
      { op: 'connect', pins: ['R1.1'], net: '+3V3' },
      { op: 'connect', pins: ['R1.2', 'SW1.A'], net: 'BTN' },
      { op: 'connect', pins: ['SW1.C'], net: 'GND' },
      { op: 'set_net', net: '+3V3', voltage: 3.3 },
      { op: 'add_part', part: CRYSTAL.id, refdes: 'Y1' },
      { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '18pF', voltage: '50V' } },
      { op: 'add_part', part: 'generic:C', refdes: 'C2', params: { capacitance: '18pF', voltage: '50V' } },
      { op: 'connect', pins: ['Y1.XTAL1', 'C1.1'], net: 'XIN' },
      { op: 'connect', pins: ['Y1.XTAL2', 'C2.1'], net: 'XOUT' },
      { op: 'connect', pins: ['Y1.GND', 'C1.2', 'C2.2'], net: 'GND' },
    ]);
    const y1 = sym(k, 'Y1');
    const page = sheetOf(k).pages[0]!.rect;
    const r = k.transact({ summary: 'take over', ops: [{ op: 'place_symbol', ref: 'Y1', page: 1, x: y1.bbox.x + y1.bbox.w / 2 - page.x, y: y1.bbox.y + y1.bbox.h / 2 - page.y }] });
    expect(r.status).toBe('ok');
    k.accept();
    expect(k.committedDesign().drawing).toBeDefined();
    return k;
  }

  it('keeps the wire to a switch terminal whose joined pin is left unconnected', () => {
    const k = arranged();
    const sw1 = sym(k, 'SW1');
    const a = sw1.pins.find((p) => p.name === 'A')!;
    expect(sw1.pins.find((p) => p.name === 'B')).toMatchObject({ x: a.x, y: a.y }); // the pair on one terminal
    const s = sheetOf(k);
    const endsAt = (pts: number[], x: number, y: number) => (pts[0] === x && pts[1] === y) || (pts.at(-2) === x && pts.at(-1) === y);
    expect(s.wires.some((w) => endsAt(w.pts, a.x, a.y))).toBe(true);
    expect(s.labels.filter((l) => l.auto && l.text === 'BTN')).toEqual([]);
  });

  it('makes a symbol drawn differently since it was stored again where it stood (a crystal that was a box)', () => {
    const k = arranged();
    const d = k.committedDesign();
    const stored = Object.values(d.drawing!)[0]!.symbols.find((s) => s.part === CRYSTAL.id)!;
    // as an earlier version stored it: a box from its origin
    stored.bbox = { x: stored.x - 200, y: stored.y - 200, w: 1000, h: 700 };
    const k2 = new Kernel();
    k2.load(d);
    const now = Object.values(k2.committedDesign().drawing!)[0]!.symbols.find((s) => s.part === CRYSTAL.id)!;
    const def = symbolFor(CRYSTAL);
    expect({ x: now.bbox.x - now.x, y: now.bbox.y - now.y, w: now.bbox.w, h: now.bbox.h }).toEqual(def.bbox);
    const old = { x: stored.bbox.x + stored.bbox.w / 2, y: stored.bbox.y + stored.bbox.h / 2 };
    expect(Math.abs(now.bbox.x + now.bbox.w / 2 - old.x)).toBeLessThanOrEqual(100);
    expect(Math.abs(now.bbox.y + now.bbox.h / 2 - old.y)).toBeLessThanOrEqual(100);
    expect(k2.state().diagnostics.filter((x) => x.code === 'SCH.DANGLING')).toEqual([]);
  });
});
