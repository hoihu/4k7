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

  it('only draws wires between pins of the same net', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const s = sheetOf(k);
    const pinAt = new Map<string, string>();
    for (const sym of s.symbols) for (const p of sym.pins) pinAt.set(`${p.x},${p.y}`, `${sym.refdes}.${p.number}`);
    for (const w of s.wires) {
      const start = pinAt.get(`${w.pts[0]},${w.pts[1]}`);
      const end = pinAt.get(`${w.pts[w.pts.length - 2]},${w.pts[w.pts.length - 1]}`);
      expect(start, `wire ${w.pts} start`).toBeTruthy();
      expect(end, `wire ${w.pts} end`).toBeTruthy();
    }
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
    k.transact(buckTransaction());
    const find = (ref: string) => sheetOf(k).symbols.find((x) => x.refdes === ref)!;
    // C1 is an input decoupling cap: by default under U1
    expect(find('C1').bbox.x + find('C1').bbox.w).toBeGreaterThan(find('U1').bbox.x);
    k.transact({ summary: 'hint', ops: [{ op: 'constrain', kind: 'left_of', a: 'C1', b: 'U1' }] });
    expect(find('C1').bbox.x + find('C1').bbox.w).toBeLessThanOrEqual(find('U1').bbox.x);
    expect(k.state().diagnostics.some((d) => d.code === 'LEDGER.PLACEMENT')).toBe(false);
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
