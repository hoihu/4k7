import { describe, expect, it } from 'vitest';
import type { PartCard, PartPin, Prim } from '@4k7/schema';
import { coreOf, diodeKind, draftToCard, getBuiltinPart, isBoxSymbol, seriesPaths, symbolFor, symbolFromSpec, textOffset, turnsOver } from '../src/index.ts';

const pin = (number: string, name: string, type: PartPin['type'] = 'passive', description?: string): PartPin => ({ number, name, type, ...(description ? { description } : {}) });
const card = (over: Partial<PartCard> & Pick<PartCard, 'category' | 'pins'>): PartCard => ({
  id: 'test:PART',
  description: 'test part',
  refPrefix: 'U',
  params: {},
  provenance: { source: 'datasheet' },
  ...over,
});
const generic = (id: string) => getBuiltinPart(id)!;
const lines = (prims: Prim[]) => prims.filter((p): p is Extract<Prim, { t: 'line' }> => p.t === 'line');
const solids = (prims: Prim[]) => prims.filter((p) => p.t === 'poly' && p.closed && p.fill);
const at = (def: ReturnType<typeof symbolFor>, name: string) => def.pins.filter((p) => p.name === name).map((p) => `${p.x},${p.y},${p.side}`);

describe('capacitors', () => {
  it('draws a polarised capacitor with a hollow plus plate, a solid minus plate and a + by the plus pin', () => {
    const def = symbolFor(generic('generic:CP'));
    const plate = def.prims.find((p) => p.t === 'rect')!;
    expect(plate).toMatchObject({ y: -50, h: 30 }); // the plus plate, towards pin 1 (+)
    expect(plate.t === 'rect' && plate.fill).toBeFalsy();
    expect(solids(def.prims)).toHaveLength(1);
    expect(lines(def.prims).some((l) => l.x1 === -60 && l.x2 === -60 && Math.max(l.y1, l.y2) < -50)).toBe(true); // the + stands above
  });

  it('puts the plus plate at the pin named + wherever it is', () => {
    const def = symbolFor(card({ category: 'capacitor', pins: [pin('1', '-'), pin('2', '+')] }));
    expect(def.prims.find((p) => p.t === 'rect')).toMatchObject({ y: 20, h: 30 }); // towards pin 2
  });

  it('knows a polarised capacitor by its own card, not by the words of the generic one', () => {
    expect(solids(symbolFor(card({ category: 'capacitor', description: 'Aluminium electrolytic capacitor 100 µF 25 V', pins: [pin('1', '1'), pin('2', '2')] })).prims)).toHaveLength(1);
    expect(solids(symbolFor(card({ category: 'capacitor', description: 'Capacitor, non-polarized', pins: [pin('1', '1'), pin('2', '2')] })).prims)).toHaveLength(0);
    const plain = symbolFor(generic('generic:C'));
    expect(solids(plain.prims)).toHaveLength(0);
    expect(lines(plain.prims).filter((l) => l.y1 === l.y2)).toHaveLength(2);
  });
});

describe('inductors', () => {
  const L = generic('generic:L');

  it('gives a power inductor a ferrite core and an RF one none, unless the core is set', () => {
    expect(coreOf(L, { inductance: '10uH' })).toBe('ferrite');
    expect(coreOf(L, { inductance: '470nH', current: '6A' })).toBe('ferrite');
    expect(coreOf(L, { inductance: '10nH' })).toBe('air');
    expect(coreOf(L, { inductance: '10uH', core: 'air' })).toBe('air');
    expect(coreOf(L, { inductance: '10nH', core: 'Iron' })).toBe('iron');
  });

  it('reads the core off an imported card', () => {
    const own = (description: string) => card({ category: 'inductor', description, pins: [pin('1', '1'), pin('2', '2')] });
    expect(coreOf(own('10uH wire wound SMD power inductor, 5.4A'))).toBe('ferrite');
    expect(coreOf(own('Multilayer ferrite chip inductor 1uH'))).toBe('ferrite');
    expect(coreOf(own('Multilayer RF chip inductor 3.3nH'))).toBe('air');
    expect(coreOf(own('Laminated iron core choke'))).toBe('iron');
  });

  it('draws the core beside the turns: dashed for ferrite, solid for iron', () => {
    const core = (params: Record<string, string>) => lines(symbolFor(L, false, { params }).prims).filter((l) => l.x1 > 25 && l.x1 === l.x2);
    expect(core({ inductance: '10uH' })).toHaveLength(8); // two lines of four dashes
    expect(core({ inductance: '10uH', core: 'iron' }).map((l) => Math.abs(l.y2 - l.y1))).toEqual([200, 200]);
    expect(core({ inductance: '10nH' })).toEqual([]);
  });

  it('keeps the parameters out of the stored spec', () => {
    expect(symbolFor(L, true, { params: { inductance: '10uH' } }).spec).toEqual({ flip: true });
  });
});

describe('diodes', () => {
  const D = generic('generic:D');

  it('tells the kind from the type, else the part number family', () => {
    expect(diodeKind(D, { mpn: 'SS56' })).toBe('schottky');
    expect(diodeKind(D, { mpn: 'B340A-13-F' })).toBe('schottky');
    expect(diodeKind(D, { mpn: 'BAT54' })).toBe('schottky');
    expect(diodeKind(D, { mpn: 'BZX84C3V3' })).toBe('zener');
    expect(diodeKind(D, { mpn: '1N4733A' })).toBe('zener');
    expect(diodeKind(D, { mpn: 'SMBJ5.0A' })).toBe('tvs');
    expect(diodeKind(D, { mpn: 'SMAJ15CA' })).toBe('tvs_bidirectional');
    expect(diodeKind(D, { mpn: 'SM6T6V8CA' })).toBe('tvs_bidirectional');
    expect(diodeKind(D, { mpn: '1N4148W' })).toBe('standard');
    expect(diodeKind(D, { mpn: '1N4007' })).toBe('standard');
    expect(diodeKind(D, {})).toBe('standard'); // not "Schottky" from the generic card's description
    expect(diodeKind(D, { mpn: '1N4148W', type: 'zener' })).toBe('zener');
    expect(diodeKind(card({ category: 'diode', description: '40V 3A Schottky barrier rectifier', pins: [pin('1', 'K'), pin('2', 'A')] }))).toBe('schottky');
    expect(diodeKind(card({ category: 'diode', description: 'Bidirectional TVS diode, 5V', pins: [pin('1', 'K'), pin('2', 'A')] }))).toBe('tvs_bidirectional');
  });

  it('draws each kind with its own cathode bar, the pins where they were', () => {
    const shapes = new Set<string>();
    for (const type of ['standard', 'schottky', 'zener', 'tvs', 'tvs_bidirectional']) {
      const def = symbolFor(D, false, { params: { type } });
      expect(def.pins.map((p) => `${p.name}:${p.x},${p.y}`)).toEqual(['K:0,-200', 'A:0,200']);
      expect(def.bbox).toEqual({ x: -100, y: -200, w: 200, h: 400 });
      shapes.add(JSON.stringify(def.prims));
    }
    expect(shapes.size).toBe(5);
    expect(solids(symbolFor(D, false, { params: { type: 'tvs_bidirectional' } }).prims)).toHaveLength(2); // two diodes tip to tip
  });

  it('gives an LED arrows with heads and its text room beside them', () => {
    const led = generic('generic:LED');
    const def = symbolFor(led);
    expect(solids(def.prims)).toHaveLength(3); // the diode and two arrowheads
    expect(textOffset(led)).toBe(175);
    expect(def.refPos.x).toBe(175);
    expect(Math.max(...lines(def.prims).flatMap((l) => [l.x1, l.x2]))).toBeLessThan(textOffset(led) - 30);
    expect(textOffset(generic('generic:R'))).toBe(100);
  });
});

describe('mirrored', () => {
  const nmos = card({ category: 'transistor', description: 'N-channel MOSFET', pins: [pin('1', 'G', 'in'), pin('2', 'S'), pin('3', 'D')] });
  const glyphs: [string, PartCard][] = [
    ['transistor', nmos],
    ['shunt reference', card({ category: 'ic', pins: [pin('1', 'K'), pin('2', 'A'), pin('3', 'R')] })],
    ['optocoupler', card({ category: 'ic', pins: [pin('1', 'A'), pin('2', 'K'), pin('3', 'E'), pin('4', 'C')] })],
    ['relay', card({ category: 'other', description: 'Signal relay', pins: [pin('1', 'COIL+'), pin('2', 'COIL-'), pin('3', 'COM'), pin('4', 'NO'), pin('5', 'NC')] })],
    ['bridge', card({ category: 'diode', pins: [{ ...pin('1', '+'), side: 'top' }, { ...pin('2', '-'), side: 'bottom' }, { ...pin('3', 'AC1'), side: 'left' }, { ...pin('4', 'AC2'), side: 'right' }] })],
  ];

  it.each(glyphs)('turns a %s over: pins, strokes, box and text, on the grid', (_, part) => {
    const plain = symbolFor(part);
    const over = symbolFor(part, false, { mirror: true });
    expect(over.spec).toEqual({ mirror: true, over: true });
    expect(turnsOver(part)).toBe(true);
    expect(over.kind).toBe(plain.kind);
    const side = { left: 'right', right: 'left', top: 'top', bottom: 'bottom' } as const;
    expect(over.pins).toEqual(plain.pins.map((p) => ({ ...p, x: -p.x, side: side[p.side] })));
    for (const p of over.pins) {
      expect(Math.abs(p.x) % 100).toBe(0);
      expect(p.x).toBeGreaterThanOrEqual(over.bbox.x);
      expect(p.x).toBeLessThanOrEqual(over.bbox.x + over.bbox.w);
    }
    // what stood left of its symbol's middle stands right of it now, and its text grows away from the symbol
    const middle = (def: typeof plain) => def.bbox.x + def.bbox.w / 2;
    expect(over.refPos.x - middle(over) + plain.refPos.x - middle(plain)).toBe(0);
    expect(over.refPos.anchor).toBe({ start: 'end', end: 'start', middle: 'middle' }[plain.refPos.anchor]);
    expect(JSON.stringify(over.prims)).not.toBe(JSON.stringify(plain.prims));
    expect(symbolFor(part, false, { mirror: false }).pins).toEqual(plain.pins);
    // as stored: turned over when it says so, and as it always was when a drawing from before it says only `mirror`
    expect(symbolFromSpec(part, over.spec!).pins).toEqual(over.pins);
    expect(symbolFromSpec(part, { mirror: true }).pins).toEqual(plain.pins);
  });

  it('leaves `mirror` alone on what swaps its pins: a box, a crystal, a switch', () => {
    const box = card({ category: 'ic', pins: [pin('1', 'IN', 'in'), pin('2', 'OUT', 'out')] });
    const xtal = card({ category: 'crystal', pins: [pin('1', 'XTAL1'), pin('2', 'GND'), pin('3', 'XTAL2'), pin('4', 'GND')] });
    for (const part of [box, xtal]) {
      expect(turnsOver(part)).toBe(false);
      expect(symbolFor(part, false, { mirror: true }).spec).toEqual({ mirror: true });
      expect(symbolFromSpec(part, { mirror: true }).pins).toEqual(symbolFor(part, false, { mirror: true }).pins);
    }
    expect(turnsOver(generic('generic:D'))).toBe(false);
  });

  it('draws a transistor with its gate on the right, the drain and source still top and bottom', () => {
    const over = symbolFor(nmos, false, { mirror: true });
    expect(at(over, 'G')).toEqual(['100,400,right']);
    expect(at(over, 'D')).toEqual(['-200,0,top']);
    expect(at(over, 'S')).toEqual(['-200,600,bottom']);
    expect(over.prims.filter((p) => p.t === 'line').every((p) => p.t === 'line' && p.x1 <= 100 && p.x2 <= 100)).toBe(true);
  });
});

describe('rotated', () => {
  const box = card({ category: 'ic', pins: [pin('1', 'IN', 'in'), pin('2', 'OUT', 'out'), pin('3', 'EN', 'in')] });
  const powered = card({ category: 'ic', pins: [pin('1', 'IN', 'in'), pin('2', 'OUT', 'out'), pin('3', 'VCC', 'pwr_in'), pin('4', 'GND', 'pwr_in')] });
  const xtal = card({ category: 'crystal', pins: [pin('1', 'XTAL1'), pin('2', 'GND'), pin('3', 'XTAL2'), pin('4', 'GND')] });
  const kinds: [string, PartCard][] = [
    ['crystal', xtal],
    ['two-pin crystal', card({ category: 'crystal', pins: [pin('1', '1'), pin('2', '2')] })],
    ['button', card({ category: 'other', description: 'SMD tactile switch', pins: [pin('1', 'A'), pin('2', 'B')] })],
    ['fuse', card({ category: 'other', description: 'Fuse 2 A', pins: [pin('1', '1'), pin('2', '2')] })],
    ['thermistor', card({ category: 'other', description: 'NTC thermistor', pins: [pin('1', '1'), pin('2', '2')] })],
    ['gas discharge tube', card({ category: 'other', description: 'Gas discharge tube, 3 electrodes', pins: [pin('1', '1'), pin('2', '2'), pin('3', '3')] })],
    ['choke', card({ category: 'other', description: 'Common mode choke', pins: [pin('1', '1A'), pin('2', '2A'), pin('3', '2B'), pin('4', '1B')] })],
    ['transistor', card({ category: 'transistor', description: 'N-channel MOSFET', pins: [pin('1', 'G', 'in'), pin('2', 'S'), pin('3', 'D')] })],
    ['shunt reference', card({ category: 'ic', pins: [pin('1', 'K'), pin('2', 'A'), pin('3', 'R')] })],
    ['optocoupler', card({ category: 'ic', pins: [pin('1', 'A'), pin('2', 'K'), pin('3', 'E'), pin('4', 'C')] })],
    ['relay', card({ category: 'other', description: 'Signal relay', pins: [pin('1', 'COIL+'), pin('2', 'COIL-'), pin('3', 'COM'), pin('4', 'NO'), pin('5', 'NC')] })],
    ['bridge', card({ category: 'diode', pins: [{ ...pin('1', '+'), side: 'top' }, { ...pin('2', '-'), side: 'bottom' }, { ...pin('3', 'AC1'), side: 'left' }, { ...pin('4', 'AC2'), side: 'right' }] })],
    ['box', box],
    ['box with supplies', powered],
    ['connector', generic('generic:CONN_1x2')],
  ];
  const TURNS = [90, 180, 270] as const;
  const NEXT = { left: 'top', top: 'right', right: 'bottom', bottom: 'left' } as const;
  // what the drawing covers, without its text
  const extent = (prims: Prim[]) => {
    const pts = prims.flatMap((p): number[][] => (p.t === 'line' ? [[p.x1, p.y1], [p.x2, p.y2]] : p.t === 'rect' ? [[p.x, p.y], [p.x + p.w, p.y + p.h]] : p.t === 'poly' ? p.pts.flatMap((v, i) => (i % 2 ? [] : [[v, p.pts[i + 1]!]])) : p.t === 'circle' ? [[p.x - p.r, p.y - p.r], [p.x + p.r, p.y + p.r]] : []));
    const [xs, ys] = [pts.map((q) => q[0]!), pts.map((q) => q[1]!)];
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  };
  const turnOf = (x: number, y: number, by: number, px: number, py: number) => (by === 90 ? [px - (y - py), py + (x - px)] : by === 180 ? [2 * px - x, 2 * py - y] : [px + (y - py), py - (x - px)]);

  it.each(kinds)('turns a %s by quarters about one point: pins on the grid, their sides with them, the box round them', (_, part) => {
    const plain = symbolFor(part);
    const q = symbolFor(part, false, { rotated: 90 });
    // the pivot: the one point a quarter turn leaves where it was
    const first = plain.pins[0]!;
    const firstQ = q.pins[0]!;
    const px = (firstQ.x - firstQ.y + first.x + first.y) / 2;
    const py = (firstQ.x + firstQ.y - first.x + first.y) / 2;
    for (const by of TURNS) {
      const def = symbolFor(part, false, { rotated: by });
      expect(def.spec).toEqual({ rotated: by });
      def.pins.forEach((p, i) => {
        const o = plain.pins[i]!;
        expect(p.number).toBe(o.number);
        expect([p.x, p.y]).toEqual(turnOf(o.x, o.y, by, px, py));
        expect(Math.abs(p.x) % 100).toBe(0);
        expect(Math.abs(p.y) % 100).toBe(0);
        expect(p.side).toBe(by === 90 ? NEXT[o.side] : by === 180 ? NEXT[NEXT[o.side]] : NEXT[NEXT[NEXT[o.side]]]);
        expect(p.x).toBeGreaterThanOrEqual(def.bbox.x);
        expect(p.x).toBeLessThanOrEqual(def.bbox.x + def.bbox.w);
        expect(p.y).toBeGreaterThanOrEqual(def.bbox.y);
        expect(p.y).toBeLessThanOrEqual(def.bbox.y + def.bbox.h);
      });
      expect(by === 180 ? [def.bbox.w, def.bbox.h] : [def.bbox.h, def.bbox.w]).toEqual([plain.bbox.w, plain.bbox.h]);
      // as a stored drawing makes it again
      expect(symbolFromSpec(part, def.spec!).pins).toEqual(def.pins);
      expect(symbolFromSpec(part, def.spec!).prims).toEqual(def.prims);
      // the name above the value, beside the drawing, or at the corner of a symbol with pins all round
      expect(def.refPos.anchor).toBe(def.valuePos.anchor);
      expect(def.refPos.x).toBe(def.valuePos.x);
      expect(def.refPos.y).toBeLessThan(def.valuePos.y);
      const e = extent(def.prims);
      const sides = new Set(def.pins.map((p) => p.side));
      if (sides.size < 4) {
        const { x, y, anchor } = def.refPos;
        expect(anchor === 'start' ? x > e.right : anchor === 'end' ? x < e.left : y < e.top || y > e.bottom).toBe(true);
        const free = anchor === 'start' ? 'right' : anchor === 'end' ? 'left' : y < e.top ? 'top' : 'bottom';
        expect(sides.has(free)).toBe(false);
      }
    }
  });

  it('stands a crystal up about its terminals\' middle, its case to one side, its name on the free one', () => {
    const q = symbolFor(xtal, false, { rotated: 90 });
    expect(at(q, 'XTAL1')).toEqual(['0,-200,top']);
    expect(at(q, 'XTAL2')).toEqual(['0,200,bottom']);
    expect(at(q, 'GND')).toEqual(['-200,0,left', '-200,0,left']);
    expect(q.refPos).toMatchObject({ anchor: 'start' });
    const half = symbolFor(xtal, false, { rotated: 180 });
    expect(at(half, 'XTAL1')).toEqual(['200,0,right']);
    expect(at(half, 'GND')).toEqual(['0,-200,top', '0,-200,top']);
    expect(half.refPos).toMatchObject({ anchor: 'middle' });
    expect(half.refPos.y).toBeGreaterThan(100);
    const three = symbolFor(xtal, false, { rotated: 270 });
    expect(at(three, 'XTAL1')).toEqual(['0,200,bottom']);
    expect(at(three, 'GND')).toEqual(['200,0,right', '200,0,right']);
    expect(three.refPos).toMatchObject({ anchor: 'end' });
    // mirrored first, then turned
    expect(at(symbolFor(xtal, false, { mirror: true, rotated: 90 }), 'XTAL2')).toEqual(['0,-200,top']);
  });

  it('turns the curves of a path too, keeping the path translatable', () => {
    const choke = kinds.find(([k]) => k === 'choke')![1];
    const path = (d: ReturnType<typeof symbolFor>) => d.prims.filter((p) => p.t === 'path').map((p) => (p.t === 'path' ? p.d : ''));
    expect(path(symbolFor(choke))[0]).toBe('M-100,-100 a25,25 0 0 0 50,0 a25,25 0 0 0 50,0 a25,25 0 0 0 50,0 a25,25 0 0 0 50,0');
    expect(path(symbolFor(choke, false, { rotated: 90 }))[0]).toBe('M100,-100 a25,25 0 0 0 0,50 a25,25 0 0 0 0,50 a25,25 0 0 0 0,50 a25,25 0 0 0 0,50');
    expect(path(symbolFor(choke, false, { rotated: 180 }))[0]).toBe('M100,100 a25,25 0 0 0 -50,0 a25,25 0 0 0 -50,0 a25,25 0 0 0 -50,0 a25,25 0 0 0 -50,0');
  });

  it('leaves a mark on the symbol upright, moving with the drawing', () => {
    const ntc = kinds.find(([k]) => k === 'thermistor')![1];
    const mark = (d: ReturnType<typeof symbolFor>) => d.prims.find((p) => p.t === 'text');
    expect(mark(symbolFor(ntc))).toMatchObject({ x: -185, y: 95 });
    expect(mark(symbolFor(ntc, false, { rotated: 90 }))).toMatchObject({ x: -95, y: -185 });
  });

  it('has a box\'s pins on all sides keep its name at the corner, and one with pins on two sides put it beside them', () => {
    const q = symbolFor(powered, false, { rotated: 90 });
    expect(new Set(q.pins.map((p) => p.side)).size).toBe(4);
    expect(q.refPos.anchor).toBe('end');
    const two = symbolFor(box, false, { rotated: 90 });
    expect(new Set(two.pins.map((p) => p.side))).toEqual(new Set(['top', 'bottom']));
    expect(two.refPos.anchor).toBe('start');
    expect(two.refPos.x).toBeGreaterThan(Math.max(...two.prims.map((p) => (p.t === 'rect' ? p.x : -Infinity))));
  });
});

describe('crystals', () => {
  const xtal4 = card({
    category: 'crystal',
    description: '12 MHz SMD3225 crystal',
    pins: [pin('1', 'XTAL1'), pin('2', 'GND'), pin('3', 'XTAL2'), pin('4', 'GND')],
    symbolLayout: { left: [['1']], right: [['3']], top: [], bottom: [['2', '4']] },
  });

  it('draws a crystal lying, terminals left and right, its case pins stacked at the bottom', () => {
    const def = symbolFor(xtal4);
    expect(at(def, 'XTAL1')).toEqual(['-200,0,left']);
    expect(at(def, 'XTAL2')).toEqual(['200,0,right']);
    expect(at(def, 'GND')).toEqual(['0,200,bottom', '0,200,bottom']);
    expect(def.prims.some((p) => p.t === 'rect' && p.w === 70 && !p.fill)).toBe(true); // the quartz
    expect(isBoxSymbol(xtal4)).toBe(false);
    expect(at(symbolFor(xtal4, false, { mirror: true }), 'XTAL1')).toEqual(['200,0,right']);
  });

  it('draws two-pin crystals and resonators, and leaves an oscillator a box', () => {
    const two = symbolFor(card({ category: 'crystal', pins: [pin('1', '1'), pin('2', '2')] }));
    expect(two.pins.map((p) => p.side)).toEqual(['left', 'right']);
    expect(two.bbox.h).toBe(200);
    const res = symbolFor(card({ category: 'crystal', description: '16 MHz ceramic resonator', pins: [pin('1', 'IN'), pin('2', 'GND'), pin('3', 'OUT')] }));
    expect(res.pins.map((p) => `${p.name}:${p.x},${p.y}`)).toEqual(['IN:-300,0', 'OUT:300,0', 'GND:0,200']);
    const osc = card({ category: 'crystal', description: '25 MHz oscillator', pins: [pin('1', 'EN', 'in'), pin('2', 'GND', 'pwr_in'), pin('3', 'OUT', 'out'), pin('4', 'VDD', 'pwr_in')] });
    expect(isBoxSymbol(osc)).toBe(true);
  });
});

describe('switches and fuses', () => {
  const tact = card({
    category: 'other',
    description: '5.1x5.1mm SMD tactile switch, 4 pads',
    pins: [
      pin('1', 'A', 'passive', 'Contact A, internally connected to B (pad 2)'),
      pin('2', 'B', 'passive', 'Contact B, internally connected to A (pad 1)'),
      pin('3', 'C', 'passive', 'Contact C, internally connected to D (pad 4)'),
      pin('4', 'D', 'passive', 'Contact D, internally connected to C (pad 3)'),
    ],
  });

  it('draws a tactile switch as a push button, the pins joined inside stacked on one terminal', () => {
    const def = symbolFor(tact);
    expect(def.pins.map((p) => `${p.name}:${p.x},${p.y}`)).toEqual(['A:-200,0', 'B:-200,0', 'C:200,0', 'D:200,0']);
    expect(def.prims.filter((p) => p.t === 'circle')).toHaveLength(2); // the contacts
    expect(isBoxSymbol(tact)).toBe(false);
  });

  it('finds the pairs by shared names too, and leaves a switch whose pairs nobody knows a box', () => {
    const named = card({ category: 'other', description: 'Tactile switch', pins: [pin('1', '1'), pin('2', '2'), pin('3', '1'), pin('4', '2')] });
    expect(symbolFor(named).pins.map((p) => `${p.number}:${p.x}`)).toEqual(['1:-200', '3:-200', '2:200', '4:200']);
    expect(isBoxSymbol(card({ category: 'other', description: 'Tactile switch', pins: [pin('1', 'A'), pin('2', 'B'), pin('3', 'C'), pin('4', 'D')] }))).toBe(true);
    expect(isBoxSymbol(card({ category: 'other', description: 'Slide switch SPDT', pins: [pin('1', '1'), pin('2', '2')] }))).toBe(true);
  });

  it('draws fuses, a resettable one with the PTC line', () => {
    const fuse = symbolFor(card({ category: 'other', description: 'Fuse 2 A fast, 1206', pins: [pin('1', '1'), pin('2', '2')] }));
    expect(fuse.pins.map((p) => p.side)).toEqual(['left', 'right']);
    expect(lines(fuse.prims).some((l) => l.x1 === -200 && l.x2 === 200)).toBe(true); // the wire through the body
    const ptc = symbolFor(card({ category: 'other', description: 'Resettable PPTC fuse 0.5 A', pins: [pin('1', '1'), pin('2', '2')] }));
    expect(ptc.prims.some((p) => p.t === 'poly' && !p.closed)).toBe(true);
  });
});

describe('transistors and references', () => {
  it('draws a MOSFET in a power package as a MOSFET, its repeated pins stacked', () => {
    const q = card({
      category: 'transistor',
      description: '30V P-channel MOSFET, SOIC-8',
      pins: [pin('1', 'S'), pin('2', 'S'), pin('3', 'S'), pin('4', 'G', 'in'), pin('5', 'D'), pin('6', 'D'), pin('7', 'D'), pin('8', 'D')],
    });
    const def = symbolFor(q);
    expect(new Set(at(def, 'S'))).toEqual(new Set(['200,0,top'])); // P-channel: source on top
    expect(at(def, 'D')).toHaveLength(4);
    expect(new Set(at(def, 'D'))).toEqual(new Set(['200,600,bottom']));
    expect(at(def, 'G')).toEqual(['-100,400,left']);
    // an IC whose pins happen to be named so is still a box
    expect(isBoxSymbol(card({ category: 'ic', pins: [pin('1', 'G'), pin('2', 'S'), pin('3', 'S'), pin('4', 'D')] }))).toBe(true);
  });

  it('draws a shunt reference (TL431) as its diode with the reference from the side', () => {
    const def = symbolFor(card({ category: 'ic', description: 'Adjustable shunt regulator', pins: [pin('1', 'CATHODE'), pin('2', 'REF', 'in'), pin('3', 'ANODE')] }));
    expect(def.pins.map((p) => `${p.name}:${p.side}`)).toEqual(['CATHODE:top', 'ANODE:bottom', 'REF:left']);
  });

  it('draws a bridge rectifier as an outline, the diodes visible inside', () => {
    const body = symbolFor(generic('generic:BRIDGE')).prims[0]!;
    expect(body.t === 'poly' && body.closed && !body.fill).toBe(true);
  });
});

describe('import', () => {
  it('imports a power inductor as an inductor, drawn as one', () => {
    const { card: c } = draftToCard({
      mpn: 'SWRB1207S-100MT',
      manufacturer: 'Sunlord',
      description: '10uH wire wound SMD power inductor, 5.4A',
      category: 'inductor',
      package: { name: 'SWRB1207S', family: 'other', pins: 2, body_mm: [12.5, 12.5], pads: [{ number: '1', x: -4.95, y: 0, w: 2.9, h: 5.4 }, { number: '2', x: 4.95, y: 0, w: 2.9, h: 5.4 }] },
      pins: [{ number: '1', name: '1', type: 'passive', page: 1 }, { number: '2', name: '2', type: 'passive', page: 1 }],
    });
    expect(c?.refPrefix).toBe('L');
    expect(symbolFor(c!).kind).toBe('two_pin');
    expect(coreOf(c!)).toBe('ferrite');
  });
});

describe('relays and optocouplers', () => {
  it('draws a relay: the coil standing, each pole\'s contacts beside it (common at the bottom, NC and NO at the top)', () => {
    const spdt = card({ category: 'other', description: 'Relay SPDT 5 V coil', pins: [pin('1', 'COIL1'), pin('2', 'COIL2'), pin('3', 'COM'), pin('4', 'NC'), pin('5', 'NO')] });
    const def = symbolFor(spdt);
    expect(def.pins.map((p) => `${p.name}:${p.x},${p.y},${p.side}`)).toEqual(['COIL1:0,-300,top', 'COIL2:0,300,bottom', 'COM:400,300,bottom', 'NC:300,-300,top', 'NO:500,-300,top']);
    expect(lines(def.prims).filter((l) => l.y1 === 10 && l.y2 === 10).length).toBeGreaterThan(2); // the armature, dashed
    // IEC contact numbers and two poles; the coil's + end on top
    const dpdt = symbolFor(card({ category: 'other', description: 'Signal relay DPDT', pins: [pin('1', 'A2'), pin('8', 'A1'), pin('2', '11'), pin('3', '12'), pin('4', '14'), pin('5', '21'), pin('6', '22'), pin('7', '24')] }));
    expect(at(dpdt, 'A1')).toEqual(['0,-300,top']);
    expect(at(dpdt, '21')).toEqual(['800,300,bottom']);
    expect(at(dpdt, '24')).toEqual(['900,-300,top']);
    // a relay without a coil, or one whose contacts are not known, is a box
    expect(isBoxSymbol(card({ category: 'other', description: 'Solid state relay', pins: [pin('1', 'A'), pin('2', 'K'), pin('3', 'D'), pin('4', 'D')] }))).toBe(true);
    expect(isBoxSymbol(card({ category: 'other', description: 'Relay', pins: [pin('1', 'COIL1'), pin('2', 'COIL2'), pin('3', 'X'), pin('4', 'Y')] }))).toBe(true);
  });

  it('draws an optocoupler: the LED left, its phototransistor or photo-triac right, NC pins below', () => {
    const pc817 = symbolFor(card({ category: 'ic', description: 'Optocoupler', pins: [pin('1', 'A'), pin('2', 'K'), pin('3', 'E'), pin('4', 'C')] }));
    expect(pc817.pins.map((p) => `${p.name}:${p.x},${p.y}`)).toEqual(['A:-500,-100', 'K:-500,100', 'C:500,-100', 'E:500,100']);
    const n4n25 = symbolFor(card({ category: 'ic', pins: [pin('1', 'ANODE'), pin('2', 'CATHODE'), pin('3', 'NC', 'nc'), pin('4', 'EMITTER'), pin('5', 'COLLECTOR'), pin('6', 'BASE')] }));
    expect(at(n4n25, 'BASE')).toEqual(['500,0,right']);
    expect(at(n4n25, 'NC')).toEqual(['0,400,bottom']);
    const moc = symbolFor(card({ category: 'ic', pins: [pin('1', 'A'), pin('2', 'K'), pin('3', 'NC', 'nc'), pin('4', 'MT2'), pin('5', 'NC', 'nc'), pin('6', 'MT1')] }));
    expect(at(moc, 'MT2')).toEqual(['500,-100,right']);
    expect(at(moc, 'NC')).toEqual(['0,400,bottom', '0,400,bottom']);
  });
});

describe('protection and EMC parts', () => {
  const two = (description: string, category: PartCard['category'] = 'other') => card({ category, description, pins: [pin('1', '1'), pin('2', '2')] });
  const marks = (c: PartCard) => symbolFor(c).prims.flatMap((p) => (p.t === 'text' ? [p.text] : []));

  it('marks thermistors and varistors on the slanted line across their body', () => {
    expect(marks(two('NTC thermistor 10k B3380'))).toEqual(['−θ']);
    expect(marks(two('PTC thermistor, overtemperature'))).toEqual(['+θ']);
    expect(marks(two('Metal oxide varistor 275 VAC'))).toEqual(['U']);
    expect(marks(two('PPTC resettable fuse 0.5 A'))).toEqual([]); // a resettable fuse, not a thermistor
    expect(isBoxSymbol(two('Varistor'))).toBe(false);
  });

  it('draws a ferrite bead on its wire, lying or upright, and a gas discharge tube with its ground electrode', () => {
    const lying = symbolFor(two('Ferrite bead 220 ohm at 100 MHz'));
    expect(lying.pins.map((p) => p.side)).toEqual(['left', 'right']);
    expect(lying.prims.some((p) => p.t === 'poly' && p.closed && p.pts.length === 8)).toBe(true);
    const upright = symbolFor(two('Chip ferrite bead 600 ohm', 'inductor'));
    expect(upright.kind).toBe('two_pin');
    expect(upright.prims.some((p) => p.t === 'path')).toBe(false); // no turns
    const gdt3 = symbolFor(card({ category: 'other', description: 'Gas discharge tube, 3 electrodes', pins: [pin('1', '1'), pin('2', '2'), pin('3', '3')] }));
    expect(at(gdt3, '2')).toEqual(['0,200,bottom']);
    expect(symbolFor(two('Gas discharge tube 90 V')).prims[0]).toMatchObject({ t: 'circle' });
  });

  it('draws a common-mode choke from the windings its pins name, else a box', () => {
    const cmc = card({ category: 'other', description: 'Common mode choke', pins: [pin('1', '1A'), pin('2', '2A'), pin('3', '2B'), pin('4', '1B')] });
    const def = symbolFor(cmc);
    expect(def.pins.map((p) => `${p.name}:${p.x},${p.y}`)).toEqual(['1A:-300,-100', '1B:300,-100', '2A:-300,100', '2B:300,100']);
    expect(isBoxSymbol(card({ category: 'other', description: 'Common mode choke', pins: [pin('1', '1'), pin('2', '2'), pin('3', '3'), pin('4', '4')] }))).toBe(true);
  });

  it('counts a transzorb as a TVS', () => {
    expect(diodeKind(card({ category: 'diode', description: 'Transzorb 1500 W', pins: [pin('1', 'K'), pin('2', 'A')] }))).toBe('tvs');
  });

  it('carries a supply through fuses, beads, thermistors and a choke\'s windings, not across a varistor', () => {
    expect(seriesPaths(two('Fuse 2 A fast'))).toEqual([['1', '2']]);
    expect(seriesPaths(two('Ferrite bead 600 ohm'))).toEqual([['1', '2']]);
    expect(seriesPaths(two('NTC thermistor inrush limiter'))).toEqual([['1', '2']]);
    expect(seriesPaths(two('Varistor 275 VAC'))).toEqual([]);
    expect(seriesPaths(two('Buzzer'))).toEqual([]);
    expect(seriesPaths(generic('generic:R'))).toEqual([['1', '2']]);
    expect(seriesPaths(generic('generic:C'))).toEqual([]);
    expect(seriesPaths(card({ category: 'other', description: 'Common mode choke', pins: [pin('1', '1A'), pin('2', '2A'), pin('3', '2B'), pin('4', '1B')] }))).toEqual([['1', '4'], ['2', '3']]);
  });
});
