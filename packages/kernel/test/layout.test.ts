import { describe, expect, it } from 'vitest';
import { parseQuantity, formatQuantity, type Rect, type SheetView } from '@tracewise/schema';
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
