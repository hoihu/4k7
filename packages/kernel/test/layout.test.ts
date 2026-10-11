import { describe, expect, it } from 'vitest';
import { parseQuantity, formatQuantity, type Rect, type SheetView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Body boxes without the pin stubs, so touching pins do not count as overlap. */
function body(sym: SheetView['symbols'][number]): Rect {
  const r = sym.prims.find((p) => p.t === 'rect' && p.fill);
  if (r && r.t === 'rect') return { x: r.x, y: r.y, w: r.w, h: r.h };
  return { x: sym.bbox.x + 60, y: sym.bbox.y + 100, w: sym.bbox.w - 120, h: sym.bbox.h - 200 };
}

function sheetOf(k: Kernel): SheetView {
  return k.state().view.sheets[0]!;
}

describe('schematic layout', () => {
  it('places every component without overlapping bodies', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const s = sheetOf(k);
    expect(s.symbols).toHaveLength(12);
    for (let i = 0; i < s.symbols.length; i++) {
      for (let j = i + 1; j < s.symbols.length; j++) {
        const a = s.symbols[i]!;
        const b = s.symbols[j]!;
        expect(overlaps(body(a), body(b)), `${a.refdes} overlaps ${b.refdes}`).toBe(false);
      }
    }
  });

  it('never leaves a wire end dangling', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const s = sheetOf(k);
    const points = new Set<string>();
    for (const sym of s.symbols) for (const p of sym.pins) points.add(`${p.x},${p.y}`);
    for (const l of s.labels) points.add(`${l.x},${l.y}`);
    for (const j of s.junctions) points.add(`${j.x},${j.y}`);
    const onSegment = (x: number, y: number, self: number) =>
      s.wires.some((w, i) => {
        if (i === self) return false;
        for (let k = 0; k + 3 < w.pts.length; k += 2) {
          const [x1, y1, x2, y2] = [w.pts[k]!, w.pts[k + 1]!, w.pts[k + 2]!, w.pts[k + 3]!];
          if (x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2) && (x1 === x2 || y1 === y2)) return true;
        }
        return false;
      });
    s.wires.forEach((w, i) => {
      for (const [x, y] of [[w.pts[0]!, w.pts[1]!], [w.pts.at(-2)!, w.pts.at(-1)!]] as const) {
        expect(points.has(`${x},${y}`) || onSegment(x, y, i), `wire ${w.pts} end ${x},${y} is dangling`).toBe(true);
      }
    });
  });

  it('shows every connected pin either wired or labelled with its net', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const s = sheetOf(k);
    const labelled = new Set(s.labels.map((l) => `${l.x},${l.y}`));
    const wired = new Set(s.wires.flatMap((w) => [`${w.pts[0]},${w.pts[1]}`, `${w.pts.at(-2)},${w.pts.at(-1)}`]));
    for (const j of s.junctions) wired.add(`${j.x},${j.y}`);
    // pins that touch another pin directly (series parts stacked in a column)
    const pinCount = new Map<string, number>();
    for (const sym of s.symbols) for (const p of sym.pins) pinCount.set(`${p.x},${p.y}`, (pinCount.get(`${p.x},${p.y}`) ?? 0) + 1);
    for (const [k, n] of pinCount) if (n > 1) wired.add(k);
    const nc = new Set(s.noConnects.map((p) => `${p.x},${p.y}`));
    for (const sym of s.symbols) {
      for (const p of sym.pins) {
        const key = `${p.x},${p.y}`;
        expect(labelled.has(key) || wired.has(key) || nc.has(key), `${sym.refdes}.${p.number} not shown as connected`).toBe(true);
      }
    }
  });

  it('marks every T (a wire ending on the middle of another) with a junction dot', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    // a small cap beside the RC on the compensation pin (as in many reference designs)
    k.transact({ summary: 'comp cap', ops: [
      { op: 'add_part', part: 'generic:C', refdes: 'C9', params: { capacitance: '47pF', voltage: '25V' } },
      { op: 'connect', pins: ['U1.COMP', 'C9.1'] },
      { op: 'connect', pins: ['C9.2'], net: 'GND' },
    ] });
    const s = sheetOf(k);
    const dots = new Set(s.junctions.map((j) => `${j.x},${j.y}`));
    const segs = s.wires.flatMap((w) => Array.from({ length: w.pts.length / 2 - 1 }, (_, i) => ({ net: w.netId, x1: w.pts[2 * i]!, y1: w.pts[2 * i + 1]!, x2: w.pts[2 * i + 2]!, y2: w.pts[2 * i + 3]! })));
    const inside = (g: (typeof segs)[number], x: number, y: number) =>
      (g.x1 === g.x2 && x === g.x1 && y > Math.min(g.y1, g.y2) && y < Math.max(g.y1, g.y2)) || (g.y1 === g.y2 && y === g.y1 && x > Math.min(g.x1, g.x2) && x < Math.max(g.x1, g.x2));
    let tees = 0;
    for (const g of segs) {
      for (const [x, y] of [[g.x1, g.y1], [g.x2, g.y2]] as const) {
        if (!segs.some((o) => o.net === g.net && inside(o, x, y))) continue;
        tees++;
        expect(dots.has(`${x},${y}`), `T at ${x},${y} on ${g.net}`).toBe(true);
      }
    }
    expect(tees).toBeGreaterThan(0);
  });

  it('honours left_of hints for parts that would sit elsewhere by default', () => {
    const k = new Kernel();
    k.transact({ summary: '555 with decoupling', ops: [
      { op: 'add_part', part: 'ti:NE555DR', refdes: 'U1' },
      { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '100nF', voltage: '25V' } },
      { op: 'connect', pins: ['U1.VCC', 'C1.1'], net: '+9V' },
      { op: 'connect', pins: ['U1.GND', 'C1.2'], net: 'GND' },
    ] });
    const find = (ref: string) => sheetOf(k).symbols.find((x) => x.refdes === ref)!;
    // a decoupling cap goes under its IC by default
    expect(find('C1').bbox.x + find('C1').bbox.w).toBeGreaterThan(find('U1').bbox.x);
    k.transact({ summary: 'hint', ops: [{ op: 'constrain', kind: 'left_of', a: 'C1', b: 'U1' }] });
    expect(find('C1').bbox.x + find('C1').bbox.w).toBeLessThanOrEqual(find('U1').bbox.x);
    expect(k.state().diagnostics.some((d) => d.code === 'LEDGER.PLACEMENT')).toBe(false);
  });

  it('draws decoupling caps under the IC they feed, not in the regulator that makes the rail', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const caps = Array.from({ length: 6 }, (_, i) => `C${10 + i}`);
    k.transact({ summary: 'a 555 on the 3V3 rail', ops: [
      { op: 'add_part', part: 'ti:NE555DR', refdes: 'U2' },
      { op: 'connect', pins: ['U2.VCC'], net: '+3V3' },
      { op: 'connect', pins: ['U2.GND'], net: 'GND' },
      ...caps.flatMap((c) => [
        { op: 'add_part' as const, part: 'generic:C', refdes: c, params: { capacitance: '100nF', voltage: '16V' } },
        { op: 'connect' as const, pins: [`${c}.1`], net: '+3V3' },
        { op: 'connect' as const, pins: [`${c}.2`], net: 'GND' },
      ]),
    ] });
    const s = sheetOf(k);
    const find = (ref: string) => s.symbols.find((x) => x.refdes === ref)!.bbox;
    const u1 = find('U1');
    const u2 = find('U2');
    for (const c of caps) {
      const b = find(c);
      expect(b.y, `${c} below U2`).toBeGreaterThan(u2.y + u2.h);
      expect(Math.abs(b.x - u2.x), `${c} near U2`).toBeLessThan(3000);
    }
    // the bulk output cap stays with the regulator
    expect(Math.abs(find('C2').y - u1.y)).toBeLessThan(1500);
    // drawn as a bank: one shared wire per rail, one supply symbol per rail
    const capBox = caps.map(find);
    const inBank = (y: number) => capBox.some((b) => Math.abs(y - b.y) < 600);
    const labels = s.labels.filter((l) => l.x >= Math.min(...capBox.map((b) => b.x)) - 100 && l.x <= Math.max(...capBox.map((b) => b.x + b.w)) && inBank(l.y));
    expect(labels.length).toBeLessThanOrEqual(2 * Math.ceil(caps.length / 4));
  });

  it('orders anchors by left_of between ICs', () => {
    const k = new Kernel();
    k.transact({ summary: 'two ICs', ops: [
      { op: 'add_part', part: 'ti:NE555DR', refdes: 'U1' },
      { op: 'add_part', part: 'ti:LM358DR', refdes: 'U2' },
    ] });
    const x = (r: string) => sheetOf(k).symbols.find((s) => s.refdes === r)!.bbox.x;
    expect(x('U1')).toBeLessThan(x('U2'));
    k.transact({ summary: 'order', ops: [{ op: 'constrain', kind: 'left_of', a: 'U2', b: 'U1' }] });
    expect(x('U2')).toBeLessThan(x('U1'));
  });
});

describe('units', () => {
  it.each([
    ['100nF', 100e-9, 'F'],
    ['4k7', 4700, ''],
    ['1R5', 1.5, 'Ω'],
    ['2u2', 2.2e-6, ''],
    ['22µF', 22e-6, 'F'],
    ['10.2k', 10200, ''],
    ['25V', 25, 'V'],
    ['3.2A', 3.2, 'A'],
    ['100R', 100, 'Ω'],
    ['10 kΩ', 10000, 'Ω'],
  ])('parses %s', (s, value, unit) => {
    const q = parseQuantity(s)!;
    expect(q.value).toBeCloseTo(value, 15);
    expect(q.unit).toBe(unit);
  });

  it('formats with SI prefixes', () => {
    expect(formatQuantity(0.0001, 'F')).toBe('100µF');
    expect(formatQuantity(4700, 'Ω')).toBe('4.7kΩ');
    expect(formatQuantity(1.5e-8, 'F')).toBe('15nF');
  });
});

describe('supply symbols on neighbouring pins', () => {
  it('lifts a rail symbol above ground pins over it and drops those below, in separate columns', async () => {
    const { supplyStubs } = await import('../src/scene.ts');
    // right side, top to bottom: L5 → GND, J1 → signal, E5 → +3V3 (as on an STM32's BYPASS_REG / PDR_ON)
    const pins = [
      { number: 'L5', y: 100, side: 'right' },
      { number: 'J1', y: 200, side: 'right' },
      { number: 'E5', y: 300, side: 'right' },
    ];
    const rises = new Map<string, number>();
    const stubs = supplyStubs(pins, (n) => (n === 'L5' ? 'down' : n === 'E5' ? 'up' : null), rises);
    expect(stubs.get('L5')!).toBeGreaterThan(stubs.get('E5')!);
    // the rail's symbol starts above L5, the ground's below E5
    expect(300 - rises.get('E5')!).toBeLessThan(100);
    expect(100 + rises.get('L5')!).toBeGreaterThan(300);
    // a rail above a ground pin needs nothing
    const r2 = new Map<string, number>();
    supplyStubs([{ number: 'a', y: 100, side: 'left' }, { number: 'b', y: 200, side: 'left' }], (n) => (n === 'a' ? 'up' : 'down'), r2);
    expect(r2.size).toBe(0);
  });
});

describe('junction dots', () => {
  it('pins stacked at one spot (repeated VDD) count once: no dot where only a wire meets them', async () => {
    const { addJunctions, emptyScene } = await import('../src/scene.ts');
    const scene = emptyScene();
    const pin = (n: string) => ({ number: n, name: 'VDD', x: 0, y: 0, side: 'left' as const, showName: true, showNumber: false });
    scene.symbols.push({ componentId: 'u', refdes: 'U1', value: '', bbox: { x: 0, y: -100, w: 400, h: 200 }, prims: [], pins: [pin('1'), pin('2'), pin('3')], refPos: { x: 0, y: 0, anchor: 'start' }, valuePos: { x: 0, y: 0, anchor: 'start' } });
    scene.wires.push({ netId: 'n', pts: [-300, 0, 0, 0] });
    addJunctions(scene);
    expect(scene.junctions).toEqual([]);
  });
});

describe('a transistor switching a load', () => {
  function buzzer() {
    const k = new Kernel();
    const d = k.committedDesign();
    d.parts['acme:BUZ'] = { id: 'acme:BUZ', mpn: 'BUZ', description: 'Buzzer, 12 V', category: 'other', refPrefix: 'LS', pins: [{ number: '1', name: '+', type: 'pwr_in' }, { number: '2', name: '-', type: 'pwr_in' }], params: {}, provenance: { source: 'datasheet' } };
    k.load(d);
    k.transact({ summary: 'buzzer', ops: [
      { op: 'add_part', part: 'generic:CONN_1x3', refdes: 'J1' },
      { op: 'add_part', part: 'acme:BUZ', refdes: 'LS1' },
      { op: 'add_part', part: 'generic:NMOS', refdes: 'Q1', params: { mpn: 'AO3400A' } },
      { op: 'add_part', part: 'generic:D', refdes: 'D6' },
      { op: 'add_part', part: 'generic:R', refdes: 'R13', params: { resistance: '220' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R11', params: { resistance: '100' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R12', params: { resistance: '100k' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R14', params: { resistance: '10k' } },
      { op: 'connect', pins: ['J1.1', 'R13.1'], net: 'VIN_12V' },
      { op: 'set_net', net: 'VIN_12V', external: true, voltage: 12 },
      { op: 'connect', pins: ['J1.3', 'Q1.S', 'R12.2'], net: 'GND' },
      { op: 'connect', pins: ['R13.2', 'LS1.1', 'D6.K'], net: 'BUZ_P' },
      { op: 'connect', pins: ['LS1.2', 'D6.A', 'Q1.D'], net: 'BUZZER_D' },
      { op: 'connect', pins: ['J1.2', 'R11.1', 'R14.1'], net: 'BUZZER' },
      { op: 'connect', pins: ['R14.2'], net: '+3V3' },
      { op: 'set_net', net: '+3V3', voltage: 3.3 },
      { op: 'connect', pins: ['R11.2', 'R12.1', 'Q1.G'], net: 'GATE' },
    ] });
    return sheetOf(k);
  }
  const at = (s: SheetView, ref: string) => s.symbols.find((x) => x.refdes === ref)!;
  const mid = (s: SheetView, ref: string) => { const b = at(s, ref).bbox; return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; };

  it('draws the MOSFET as a MOSFET, its load stacked on the drain up to the rail, the diode beside it', () => {
    const s = buzzer();
    const q = at(s, 'Q1');
    expect(q.prims.some((p) => p.t === 'poly')).toBe(true); // the body arrow, not a box
    const drain = q.pins.find((p) => p.name === 'D')!;
    expect(drain.side).toBe('top');
    // LS1 then R13 straight above the drain, VIN_12V pointing up at the top
    expect(at(s, 'LS1').pins.every((p) => p.x === drain.x)).toBe(true);
    expect(at(s, 'R13').pins.every((p) => p.x === drain.x)).toBe(true);
    expect(mid(s, 'LS1').y).toBeLessThan(drain.y);
    expect(mid(s, 'R13').y).toBeLessThan(mid(s, 'LS1').y);
    const vin = s.labels.find((l) => l.text === 'VIN_12V' && l.x === drain.x)!;
    expect(vin.dir).toBe('up');
    expect(mid(s, 'D6').x).toBeGreaterThan(drain.x);
    expect(Math.abs(mid(s, 'D6').y - mid(s, 'LS1').y)).toBeLessThan(50);
  });

  it('draws the gate drive as a path from the left: input flag, series R lying down, pull-down from the node', () => {
    const s = buzzer();
    const gate = at(s, 'Q1').pins.find((p) => p.name === 'G')!;
    const r11 = at(s, 'R11');
    expect(r11.rotation).toBeDefined();
    expect(Math.abs(mid(s, 'R11').y - gate.y)).toBeLessThan(50);
    expect(mid(s, 'R11').x).toBeLessThan(gate.x);
    expect(mid(s, 'R12').y).toBeGreaterThan(gate.y);
    expect(mid(s, 'R12').x).toBeGreaterThan(mid(s, 'R11').x);
    expect(s.labels.some((l) => l.text === 'BUZZER' && l.dir === 'left' && l.y === gate.y)).toBe(true);
  });

  it('stands a pull-up above its wire with the rail on top', () => {
    const s = buzzer();
    const plus = s.labels.find((l) => l.text === '+3V3')!;
    expect(plus.dir).toBe('up');
    expect(plus.y).toBeLessThan(mid(s, 'R14').y);
  });
});
