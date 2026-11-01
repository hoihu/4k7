import { describe, expect, it } from 'vitest';
import { PAGE, type Design, type LabelView, type PartCard, type PinView, type ScopeInfo, type SheetView } from '@4k7/schema';
import { connectivity } from '../bench/schematic-eval.ts';
import { onWire } from '../src/drawing.ts';
import { Kernel } from '../src/index.ts';

/** The symbols the kernel draws for supply pins a stored drawing leaves loose (autoLabels). */

/** A column of supply pins as on an RP2040: four on one rail (the first two stacked), two on another, then signals. */
const mcu: PartCard = {
  id: 'acme:MCU',
  mpn: 'acme:MCU',
  description: 'mcu',
  category: 'ic',
  refPrefix: 'U',
  pins: [
    { number: '1', name: 'IOVDD', type: 'pwr_in' },
    { number: '2', name: 'IOVDD', type: 'pwr_in' },
    { number: '3', name: 'USB_VDD', type: 'pwr_in' },
    { number: '4', name: 'ADC_AVDD', type: 'pwr_in' },
    { number: '5', name: 'VIN', type: 'pwr_in' },
    { number: '6', name: 'VOUT', type: 'pwr_out' },
    { number: '7', name: 'DVDD', type: 'pwr_in' },
    { number: '8', name: 'GPIO0', type: 'bidir' },
    { number: '9', name: 'GPIO1', type: 'bidir' },
    { number: '10', name: 'GPIO2', type: 'bidir' },
    { number: '11', name: 'AGND', type: 'pwr_in' },
    { number: '12', name: 'DGND', type: 'pwr_in' },
  ],
  symbolLayout: { left: [['1', '2'], ['3'], ['4'], ['5'], ['6'], ['7'], null, ['8'], ['9']], right: [['10'], null, ['11'], ['12']], top: [], bottom: [] },
  params: {},
  provenance: { source: 'datasheet' },
};

const circuit = [
  { op: 'add_part', part: 'acme:MCU', refdes: 'U1' },
  { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '100n' } },
  { op: 'add_part', part: 'generic:C', refdes: 'C2', params: { capacitance: '100n' } },
  { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
  { op: 'connect', pins: ['U1.1', 'U1.2', 'U1.3', 'U1.4', 'U1.5', 'C1.1'], net: '+3V3' },
  { op: 'connect', pins: ['U1.6', 'U1.7', 'C2.1'], net: '+1V1' },
  { op: 'connect', pins: ['U1.11', 'U1.12', 'C1.2', 'C2.2'], net: 'GND' },
  { op: 'connect', pins: ['U1.8', 'J1.1'], net: 'SDA' },
  { op: 'connect', pins: ['U1.9', 'J1.2'], net: 'SCL' },
  { op: 'set_net', net: '+3V3', voltage: 3.3 },
  { op: 'set_net', net: '+1V1', voltage: 1.1 },
];

/** The circuit, with `more` in the same transaction, on a stored drawing with nothing drawn of the supplies. */
function kernel(card: PartCard = mcu, more: unknown[] = [], supplies = ['+3V3', '+1V1', 'GND']) {
  const k = new Kernel();
  const d = k.committedDesign();
  d.parts[card.id] = card;
  k.load(d);
  const r = k.transact({ summary: 'circuit', ops: [...circuit, ...more] } as never);
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
  expect(byUser(k, supplies.map((net) => ({ op: 'erase', net }))).status).toBe('ok');
  return k;
}

function byUser(k: Kernel, ops: unknown[]) {
  const r = k.transact({ summary: 'user edit', ops } as never, 'user');
  if (r.status === 'ok') k.accept(undefined, 'user', 'user edit');
  return r;
}

const sheetOf = (k: Kernel): SheetView => k.state().view.sheets[0]!;
const u1 = (s: SheetView) => s.symbols.find((x) => x.refdes === 'U1')!;
const pin = (s: SheetView, name: string) => u1(s).pins.find((p) => p.number === name || p.name === name)!;
/** The net's symbols at U1's pins (not those of its capacitor, which stand on their own). */
const atU1 = (s: SheetView, net: string) => s.labels.filter((l) => l.text === net && s.symbols.every((x) => x.refdes === 'U1' || !x.pins.some((p) => p.x === l.x && p.y === l.y)));
const overlaps = (k: Kernel) => k.state().diagnostics.filter((x) => x.code === 'SCH.TEXT_OVERLAP' && x.entities.some((e) => e.startsWith('net:')));
const stored = (k: Kernel) => k.committedDesign().drawing![sheetOf(k).id]!;
const stemX = (l: LabelView) => l.x + (l.stub === 'left' ? -1 : l.stub === 'right' ? 1 : 0) * (l.stubLen ?? 100);
const pageOf = (s: SheetView) => s.pages[0]!.rect;

/** A card like `mcu` with these pins on its left side instead. */
const withLeft = (left: (string[] | null)[], extra: PartCard['pins'] = []): PartCard => ({ ...mcu, pins: [...mcu.pins, ...extra], symbolLayout: { left, right: [['10'], null, ['11'], ['12']], top: [], bottom: [] } });

describe('neighbouring pins on one supply', () => {
  it('share one symbol per rail, on a wire along their ends, with nothing overlapping', () => {
    const k = kernel();
    const s = sheetOf(k);
    const three = atU1(s, '+3V3');
    const one = atU1(s, '+1V1');
    expect(three).toHaveLength(1);
    expect(one).toHaveLength(1);
    for (const [from, to] of [['IOVDD', 'USB_VDD'], ['USB_VDD', 'ADC_AVDD'], ['ADC_AVDD', 'VIN'], ['VOUT', 'DVDD']] as const) {
      const [a, b] = [pin(s, from), pin(s, to)];
      expect(s.wires.some((w) => w.auto && w.pts.join() === [a.x, a.y, b.x, b.y].join()), `${from} to ${to}`).toBe(true);
    }
    expect(overlaps(k)).toEqual([]);
    const c = connectivity(k.committedDesign(), k.state().view.sheets);
    expect(c.unconnected).toEqual([]);
    expect(c.shorts).toEqual([]);
  });

  it('stand the symbol at the end of the run it points to, the two rails on stems that do not run along each other', () => {
    const k = kernel();
    const s = sheetOf(k);
    const [three, one] = [atU1(s, '+3V3')[0]!, atU1(s, '+1V1')[0]!];
    expect([three.x, three.y]).toEqual([pin(s, 'IOVDD').x, pin(s, 'IOVDD').y]);
    expect([one.x, one.y]).toEqual([pin(s, 'VOUT').x, pin(s, 'VOUT').y]);
    expect(stemX(one)).not.toBe(stemX(three));
    // a ground points down: its symbol at the lower end of its run
    const g = s.labels.filter((l) => l.text === 'GND' && u1(s).pins.some((p) => p.x === l.x && p.y === l.y));
    expect(g).toHaveLength(1);
    expect(g[0]!.y).toBe(pin(s, 'DGND').y);
  });

  it('do not join at a spot shared with a pin of another net', () => {
    const k = kernel(withLeft([['1', '2'], ['3'], ['4', '8'], ['5'], ['6'], ['7'], null, ['9']]));
    const s = sheetOf(k);
    const shared = pin(s, 'ADC_AVDD');
    expect(s.wires.filter((w) => w.auto && onWire(shared.x, shared.y, w.pts))).toEqual([]);
    // (IOVDD and USB_VDD do)
    expect(s.wires.some((w) => w.auto && w.pts.join() === [pin(s, 'IOVDD').x, pin(s, 'IOVDD').y, pin(s, 'USB_VDD').x, pin(s, 'USB_VDD').y].join())).toBe(true);
  });

  it('keep the symbols stored at them, which the agent or the user put there', () => {
    const k = kernel();
    expect(byUser(k, [{ op: 'label', pin: 'U1.IOVDD' }, { op: 'label', pin: 'U1.USB_VDD' }]).status).toBe('ok');
    const s = sheetOf(k);
    const [a, b] = [pin(s, 'IOVDD'), pin(s, 'USB_VDD')];
    expect(atU1(s, '+3V3').filter((l) => !l.auto).map((l) => l.y).sort((p, q) => p - q)).toEqual([a.y, b.y]);
    expect(s.wires.filter((w) => w.auto && onWire(a.x, a.y, w.pts) && onWire(b.x, b.y, w.pts))).toEqual([]);
  });

  describe('do not join with something else on the way', () => {
    /** The stored drawing of a kernel like `kernel()`, edited as a drawing that has this already, and U1's two pins that would join. */
    function edited(edit: (d: Design, sheet: SheetView, a: PinView, b: PinView) => void) {
      const k = kernel();
      const s = sheetOf(k);
      const [a, b] = [pin(s, 'ADC_AVDD'), pin(s, 'VIN')];
      const d = k.committedDesign();
      edit(d, s, a, b);
      k.load(d);
      const now = sheetOf(k);
      const joined = now.wires.some((w) => w.auto && w.pts.join() === [a.x, a.y, b.x, b.y].join());
      return { joined, others: now.wires.some((w) => w.auto && w.pts.join() === [pin(now, 'IOVDD').x, pin(now, 'IOVDD').y, pin(now, 'USB_VDD').x, pin(now, 'USB_VDD').y].join()) };
    }

    it('(as they do with nothing there)', () => {
      expect(edited(() => {})).toEqual({ joined: true, others: true });
    });

    it('a wire of another net', () => {
      const r = edited((d, s, a, b) => {
        // from GPIO0 round to a label of its own, on the way between the two pins
        const sda = Object.values(d.nets).find((n) => n.name === 'SDA')!;
        const g = pin(s, 'GPIO0');
        const sd = d.drawing![s.id]!;
        sd.wires = sd.wires.filter((w) => w.netId !== sda.id);
        sd.wires.push({ netId: sda.id, pts: [g.x, g.y, g.x - 300, g.y, g.x - 300, (a.y + b.y) / 2, a.x, (a.y + b.y) / 2], via: true });
        sd.labels.push({ x: a.x, y: (a.y + b.y) / 2, netId: sda.id, kind: 'net', dir: 'left' });
      });
      expect(r).toEqual({ joined: false, others: true });
    });

    it('a pin of another part', () => {
      const r = edited((d, s, a, b) => {
        // C2 lying with its far pin on the way, its body clear of it
        const c2 = Object.values(d.components).find((c) => c.refdes === 'C2')!;
        const sym = d.drawing![s.id]!.symbols.find((x) => x.comp === c2.id)!;
        const [x, y] = [a.x - 200, (a.y + b.y) / 2];
        Object.assign(sym, { x, y, rot: 90, bbox: { x: x - 200, y: y - 100, w: 400, h: 200 } });
      });
      expect(r).toEqual({ joined: false, others: true });
    });

    it('another part', () => {
      const r = edited((d, s, a, b) => {
        const c2 = Object.values(d.components).find((c) => c.refdes === 'C2')!;
        const sym = d.drawing![s.id]!.symbols.find((x) => x.comp === c2.id)!;
        const [x, y] = [a.x, b.y - 10];
        Object.assign(sym, { x: x + 700, y: y + 700, rot: 90, bbox: { x: x - 50, y: y - 50, w: 100, h: 100 } });
      });
      expect(r).toEqual({ joined: false, others: true });
    });
  });

  it('are shown so, not stored: a move of the part takes them along, and the file holds no wire for them', () => {
    const k = kernel();
    expect(stored(k).wires.filter((w) => w.pts.length)).toEqual([]);
    expect(stored(k).labels.filter((l) => atU1(sheetOf(k), '+3V3').some((x) => x.x === l.x && x.y === l.y))).toEqual([]);
    const b = u1(sheetOf(k)).bbox;
    const pg = pageOf(sheetOf(k));
    expect(byUser(k, [{ op: 'place_symbol', ref: 'U1', page: 1, x: b.x + b.w / 2 - pg.x + 500, y: b.y + b.h / 2 - pg.y + 400 }]).status).toBe('ok');
    const s = sheetOf(k);
    expect(atU1(s, '+3V3')[0]).toMatchObject({ x: pin(s, 'IOVDD').x, y: pin(s, 'IOVDD').y, auto: true });
    expect(s.wires.some((w) => w.auto && onWire(pin(s, 'USB_VDD').x, pin(s, 'USB_VDD').y, w.pts))).toBe(true);
    expect(overlaps(k)).toEqual([]);
  });

  it('stay readable on a part added to a drawn sheet, with what it stores connected', () => {
    const k = kernel();
    expect(byUser(k, [{ op: 'add_part', part: 'acme:MCU', refdes: 'U2' }, { op: 'connect', pins: ['U2.1', 'U2.2', 'U2.3', 'U2.4', 'U2.5', 'U1.1'], net: '+3V3' }]).status).toBe('ok');
    const s = sheetOf(k);
    const u2 = s.symbols.find((x) => x.refdes === 'U2')!;
    const at = u2.pins.filter((p) => p.side === 'left' && ['IOVDD', 'USB_VDD', 'ADC_AVDD', 'VIN'].includes(p.name));
    // (the layout draws this part: its bus stands a step off the pins)
    const [x, ys] = [at[0]!.x, at.map((p) => p.y)];
    const symbols = s.labels.filter((l) => l.text === '+3V3' && Math.abs(l.x - x) <= 100 && l.y >= Math.min(...ys) && l.y <= Math.max(...ys));
    expect(symbols).toHaveLength(1);
    expect(overlaps(k).filter((x) => x.entities.some((e) => e.startsWith('U2')))).toEqual([]);
    expect(connectivity(k.committedDesign(), k.state().view.sheets).shorts).toEqual([]);
  });

  it('come from what a new pin layout leaves loose, as it did on the RP2040 that showed this', () => {
    const k = kernel(withLeft([['8'], ['9'], null, ['1', '2'], ['3'], ['4'], ['5'], ['6'], ['7']]));
    const r = byUser(k, [{ op: 'set_symbol', ref: 'U1', layout: mcu.symbolLayout }]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const s = sheetOf(k);
    expect(atU1(s, '+3V3')).toHaveLength(1);
    expect(atU1(s, '+1V1')).toHaveLength(1);
    expect(overlaps(k)).toEqual([]);
  });

  it('do not join across a pin of another net, or an unconnected one', () => {
    const k = kernel(withLeft([['1', '2'], ['8'], ['3'], ['9'], ['4'], ['5'], ['6'], ['7']]));
    const s = sheetOf(k);
    expect(s.wires.filter((w) => w.auto && (onWire(pin(s, 'GPIO0').x, pin(s, 'GPIO0').y, w.pts) || onWire(pin(s, 'GPIO1').x, pin(s, 'GPIO1').y, w.pts)))).toEqual([]);
    const c = connectivity(k.committedDesign(), k.state().view.sheets);
    expect(c.shorts).toEqual([]);
    // (ADC_AVDD and VIN are neighbours: those two join)
    expect(s.wires.some((w) => w.auto && w.pts.join() === [pin(s, 'ADC_AVDD').x, pin(s, 'ADC_AVDD').y, pin(s, 'VIN').x, pin(s, 'VIN').y].join())).toBe(true);
  });

  it('keep a symbol each when they stand so far apart that the symbols do not meet', () => {
    const gap = [null, null, null] as null[];
    const k = kernel(withLeft([['1', '2'], ...gap, ['3'], ...gap, ['4'], ...gap, ['5'], ...gap, ['6'], ...gap, ['7']]));
    const s = sheetOf(k);
    expect(atU1(s, '+3V3')).toHaveLength(4);
    expect(atU1(s, '+1V1')).toHaveLength(2);
    expect(s.wires.filter((w) => w.auto && w.netId !== s.labels.find((l) => l.text === 'GND')!.netId)).toEqual([]);
  });

  it('join a stored symbol at one of them, with no second symbol', () => {
    const k = kernel();
    expect(byUser(k, [{ op: 'label', pin: 'U1.USB_VDD' }]).status).toBe('ok');
    const s = sheetOf(k);
    const mine = atU1(s, '+3V3');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ x: pin(s, 'USB_VDD').x, y: pin(s, 'USB_VDD').y });
    expect(mine[0]!.auto).toBeUndefined();
    expect(s.wires.some((w) => w.auto && onWire(pin(s, 'IOVDD').x, pin(s, 'IOVDD').y, w.pts))).toBe(true);
  });

  it('stay one per pin on a net forced to labels, where no wire is asked for', () => {
    const k = kernel();
    expect(byUser(k, [{ op: 'set_net', net: '+3V3', draw_as: 'label' }]).status).toBe('ok');
    const s = sheetOf(k);
    const id = atU1(s, '+3V3')[0]!.netId;
    expect(atU1(s, '+3V3')).toHaveLength(4);
    expect(s.wires.filter((w) => w.netId === id && w.auto)).toEqual([]);
  });

  it('leave a sheet whose wires are stored as it was', () => {
    const k = kernel(mcu, [], ['+1V1', 'GND']);
    const s = sheetOf(k);
    const id = s.wires.find((w) => w.netId && atU1(s, '+1V1')[0]!.netId !== w.netId && k.committedDesign().nets[w.netId]?.name === '+3V3')?.netId;
    expect(id).toBeDefined();
    expect(s.wires.filter((w) => w.netId === id && w.auto)).toEqual([]);
  });
});

describe('an automatic supply symbol', () => {
  it('moves by move_supply with the wire along the pins staying, and no second symbol', () => {
    const k = kernel();
    const s = sheetOf(k);
    const l = atU1(s, '+3V3')[0]!;
    const pg = pageOf(s);
    const r = byUser(k, [{ op: 'move_supply', page: 1, x: l.x - pg.x, y: l.y - pg.y, to: { x: l.x - pg.x - 500, y: l.y - pg.y } }]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const now = sheetOf(k);
    const mine = atU1(now, '+3V3');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ x: l.x - 500, y: l.y });
    expect(mine[0]!.auto).toBeUndefined();
    for (const name of ['USB_VDD', 'ADC_AVDD', 'VIN']) expect(now.wires.some((w) => w.auto && onWire(pin(now, name).x, pin(now, name).y, w.pts)), name).toBe(true);
    const c = connectivity(k.committedDesign(), k.state().view.sheets);
    expect(c.unconnected).toEqual([]);
    expect(c.shorts).toEqual([]);
    expect(overlaps(k)).toEqual([]);
  });

  it('gives way to the wires the agent draws between the pins, which then stay', () => {
    const k = kernel();
    const r = byUser(k, [
      { op: 'wire', from: 'U1.IOVDD', to: 'U1.USB_VDD' },
      { op: 'wire', from: 'U1.USB_VDD', to: 'U1.ADC_AVDD' },
    ]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const s = sheetOf(k);
    expect(atU1(s, '+3V3')).toHaveLength(1);
    const [a, b] = [pin(s, 'IOVDD'), pin(s, 'USB_VDD')];
    expect(s.wires.filter((w) => w.auto && onWire(a.x, a.y, w.pts) && onWire(b.x, b.y, w.pts))).toEqual([]);
    expect(stored(k).wires.length).toBe(2);
  });

  it('cannot be erased by a click, and says what can be done', () => {
    const k = kernel();
    const s = sheetOf(k);
    const pg = pageOf(s);
    const [a, b] = [pin(s, 'USB_VDD'), pin(s, 'ADC_AVDD')];
    const wire = byUser(k, [{ op: 'erase', at: [{ page: 1, x: a.x - pg.x, y: (a.y + b.y) / 2 - pg.y, what: 'wire' }] }]);
    expect(wire.rejection?.message).toMatch(/drawn automatically.*\(wire, label\)/);
    const l = atU1(s, '+3V3')[0]!;
    const label = byUser(k, [{ op: 'erase', at: [{ page: 1, x: l.x - pg.x, y: l.y - pg.y, what: 'label' }] }]);
    expect(label.rejection?.message).toMatch(/drawn automatically.*move_supply/);
    const none = byUser(k, [{ op: 'erase', at: [{ page: 1, x: 37, y: 37, what: 'wire' }] }]);
    expect(none.rejection?.message).toMatch(/^No wire is drawn/);
  });

  it('is told apart in get_schematic, which says what auto means there', () => {
    const k = kernel();
    const q = k.query({ op: 'get_schematic' }) as { supplies_note: string; supplies: { net: string; at?: string; auto?: boolean }[] };
    expect(q.supplies_note).toMatch(/one for neighbouring pins on one supply/);
    expect(q.supplies.find((x) => x.net === '+3V3' && x.at === 'U1.IOVDD')).toMatchObject({ auto: true });
    expect(q.supplies.find((x) => x.net === '+3V3' && x.at === 'U1.USB_VDD')).toBeUndefined();
  });

  it('takes a short step for air beside its name', () => {
    // a rail's stem one step off the pins would have its name right against the other rail's wire
    const k = kernel();
    const s = sheetOf(k);
    const one = atU1(s, '+1V1')[0]!;
    expect(one.stubLen).toBe(300);
    expect(overlaps(k)).toEqual([]);
  });

  it('stays close to its pin where only a long lead across a wire would give it air', () => {
    const k = kernel();
    const s = sheetOf(k);
    const pg = pageOf(s);
    const [gpio, top, j] = [pin(s, 'GPIO0'), pin(s, 'IOVDD'), s.symbols.find((x) => x.refdes === 'J1')!.pins.find((p) => p.number === '1')!];
    // (a wire takes corners on a 50-mil grid)
    const column = Math.round((gpio.x - 200) / 50) * 50;
    const via = [{ x: column - pg.x, y: gpio.y - pg.y }, { x: column - pg.x, y: top.y - 700 - pg.y }, { x: j.x - pg.x, y: top.y - 700 - pg.y }];
    const r = byUser(k, [{ op: 'wire', from: 'U1.GPIO0', to: 'J1.1', via }]);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const now = sheetOf(k);
    expect(now.wires.some((w) => !w.auto && w.pts.includes(column))).toBe(true);
    const one = atU1(now, '+1V1')[0]!;
    expect(one.stubLen).toBe(100);
    expect(overlaps(k)).toEqual([]);
  });

  it('steps clear of a rail that would meet it, each on a stem of its own', () => {
    // one pin of each rail side by side: nothing to join, and the lower stem would run along the upper
    const k = kernel(withLeft([['5'], ['6'], null, null, null, null, ['1', '2'], null, null, null, null, ['3'], null, null, null, null, ['4'], null, null, null, null, ['7'], null, ['8'], ['9']]));
    const s = sheetOf(k);
    const [vin, vout] = [pin(s, 'VIN'), pin(s, 'VOUT')];
    const upper = s.labels.find((l) => l.x === vin.x && l.y === vin.y)!;
    const lower = s.labels.find((l) => l.x === vout.x && l.y === vout.y)!;
    expect(upper.text).toBe('+3V3');
    expect(lower.text).toBe('+1V1');
    expect(stemX(upper)).not.toBe(stemX(lower));
    expect(overlaps(k)).toEqual([]);
  });

  it('steps off a side pin when its name would run into its own part', () => {
    // (the +1V1 pins stand well below the top of the part, so a long name beside them reaches it)
    const k = kernel(mcu, [{ op: 'set_net', net: '+1V1', rename: '+1V1_CORE_SUPPLY_RAIL' }], ['+3V3', '+1V1_CORE_SUPPLY_RAIL', 'GND']);
    const s = sheetOf(k);
    const l = atU1(s, '+1V1_CORE_SUPPLY_RAIL')[0]!;
    expect(l.stubLen).toBeGreaterThan(100);
    expect(overlaps(k).filter((x) => x.entities.some((e) => e.startsWith('U1')))).toEqual([]);
  });

  it('stays on the page when it steps clear: at the left edge it stands where it always would', () => {
    const k = kernel(mcu, [{ op: 'set_net', net: '+1V1', rename: '+1V1_CORE_SUPPLY_RAIL' }], ['+3V3', '+1V1_CORE_SUPPLY_RAIL', 'GND']);
    const b = u1(sheetOf(k)).bbox;
    const pg = pageOf(sheetOf(k));
    // its pins just inside the drawing area: no step to the left fits
    expect(byUser(k, [{ op: 'place_symbol', ref: 'U1', page: 1, x: PAGE.margin + 150 + b.w / 2, y: b.y + b.h / 2 - pg.y + 1000 }]).status).toBe('ok');
    const s = sheetOf(k);
    expect(pin(s, 'VOUT').x - pg.x).toBeLessThan(PAGE.margin + 200);
    expect(atU1(s, '+1V1_CORE_SUPPLY_RAIL')[0]!.stubLen).toBe(100);
  });

  it('keeps clear of a net label on a pin above it, whatever the order of the nets', () => {
    // GPIO0's flag points left on the row above IOVDD: a stem one step off the pin would run through it
    const k = kernel(withLeft([['8'], ['1', '2'], ['3'], ['4'], ['5'], ['6'], ['7'], null, ['9']]), [], ['+3V3', '+1V1', 'GND', 'SDA']);
    const s = sheetOf(k);
    expect(s.labels.find((l) => l.text === 'SDA' && l.x === pin(s, 'GPIO0').x && l.y === pin(s, 'GPIO0').y)).toMatchObject({ auto: true });
    expect(atU1(s, '+3V3')[0]!.stubLen).toBeGreaterThan(100);
    expect(overlaps(k)).toEqual([]);
  });
});

describe('supply symbols in an Optimize run', () => {
  /** Stored symbols at every pin of a rail on a part the user placed, overlapping, with the whole sheet in scope. */
  function scoped() {
    const k = kernel();
    const before = u1(sheetOf(k)).bbox;
    const pg = pageOf(sheetOf(k));
    expect(byUser(k, [{ op: 'place_symbol', ref: 'U1', page: 1, x: before.x + before.w / 2 - pg.x, y: before.y + before.h / 2 - pg.y + 100 }]).status).toBe('ok');
    expect(byUser(k, ['U1.IOVDD', 'U1.USB_VDD', 'U1.ADC_AVDD', 'U1.VIN', 'U1.VOUT', 'U1.DVDD'].map((p) => ({ op: 'label', pin: p }))).status).toBe('ok');
    const s = sheetOf(k);
    expect(overlaps(k).length).toBeGreaterThan(0);
    const info = k.setScope({ view: 'schematic', sheet: s.id, rect: { x: pg.x, y: pg.y, w: pg.w, h: pg.h } }) as ScopeInfo;
    expect(info.measures.overlaps).toBeGreaterThan(0);
    return { k, info, s };
  }

  it('clear by erasing at the pins of a part the user placed: one symbol per rail, measured', () => {
    const { k, info } = scoped();
    const r = k.transact({ summary: 'one symbol per rail', ops: [{ op: 'erase', pins: ['U1.IOVDD', 'U1.USB_VDD', 'U1.ADC_AVDD', 'U1.VIN', 'U1.VOUT', 'U1.DVDD'] }] } as never);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(r.scope!.measures.overlaps).toBeLessThan(info.measures.overlaps);
    expect(r.scope!.ripple).toEqual([]);
    const s = sheetOf(k);
    expect(atU1(s, '+3V3')).toHaveLength(1);
    expect(atU1(s, '+1V1')).toHaveLength(1);
    expect(overlaps(k)).toEqual([]);
  });

  it('move by move_supply, which the prompt offers and the guard lets through', () => {
    const { k, s } = scoped();
    const pg = pageOf(s);
    const l = atU1(s, '+1V1').find((x) => x.y === pin(s, 'DVDD').y)!;
    const r = k.transact({ summary: 'clear it', dry_run: true, ops: [{ op: 'move_supply', page: 1, x: l.x - pg.x, y: l.y - pg.y, to: { x: l.x - pg.x - 900, y: l.y - pg.y } }] } as never);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  });

  it('can be wired together, a part it may not move or not', () => {
    const { k } = scoped();
    const r = k.transact({ summary: 'bus', dry_run: true, ops: [{ op: 'wire', from: 'U1.IOVDD', to: 'U1.USB_VDD' }] } as never);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  });
});
