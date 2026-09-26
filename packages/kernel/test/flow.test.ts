import { describe, expect, it } from 'vitest';
import type { SheetView } from '@tracewise/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

const sheetOf = (k: Kernel): SheetView => k.state().view.sheets[0]!;
const sym = (k: Kernel, r: string) => sheetOf(k).symbols.find((s) => s.refdes === r)!;
const cx = (k: Kernel, r: string) => sym(k, r).bbox.x + sym(k, r).bbox.w / 2;
const cy = (k: Kernel, r: string) => sym(k, r).bbox.y + sym(k, r).bbox.h / 2;

/** Horizontal and vertical wire segments of different nets must not cross. */
function crossings(s: SheetView): string[] {
  const segs = s.wires.flatMap((w) => {
    const out: { net: string; x1: number; y1: number; x2: number; y2: number }[] = [];
    for (let i = 0; i + 3 < w.pts.length; i += 2) out.push({ net: w.netId, x1: w.pts[i]!, y1: w.pts[i + 1]!, x2: w.pts[i + 2]!, y2: w.pts[i + 3]! });
    return out;
  });
  const hs = segs.filter((g) => g.y1 === g.y2 && g.x1 !== g.x2);
  const vs = segs.filter((g) => g.x1 === g.x2 && g.y1 !== g.y2);
  const bad: string[] = [];
  for (const h of hs) {
    for (const v of vs) {
      if (h.net === v.net) continue;
      const inX = v.x1 > Math.min(h.x1, h.x2) && v.x1 < Math.max(h.x1, h.x2);
      const inY = h.y1 > Math.min(v.y1, v.y2) && h.y1 < Math.max(v.y1, v.y2);
      if (inX && inY) bad.push(`${h.net}×${v.net} at ${v.x1},${h.y1}`);
    }
  }
  return bad;
}

describe('power-flow layout (datasheet reference style)', () => {
  it('draws the buck converter like a reference schematic', () => {
    const k = new Kernel();
    expect(k.transact(buckTransaction()).status).toBe('ok');
    const u1 = sym(k, 'U1').bbox;

    // input capacitor on the input rail, left of the IC
    expect(cx(k, 'C1')).toBeLessThan(u1.x);
    // switch node → inductor → output, all to the right; the inductor lies horizontally on the rail
    for (const r of ['C4', 'D1', 'L1', 'C2', 'R1', 'R2']) expect(cx(k, r), r).toBeGreaterThan(u1.x + u1.w);
    expect(Math.abs(sym(k, 'L1').rotation ?? 0)).toBe(90);
    expect(cx(k, 'D1')).toBeLessThan(cx(k, 'L1')); // catch diode on the switch node, before the inductor
    expect(cx(k, 'C2')).toBeGreaterThan(cx(k, 'L1')); // output cap after it
    expect(cx(k, 'R1')).toBeGreaterThan(cx(k, 'L1')); // feedback divider on the output
    expect(cy(k, 'R2')).toBeGreaterThan(cy(k, 'R1')); // divider stacked: R1 over R2
    // bootstrap cap between BOOT and the switch node, next to the IC
    expect(cx(k, 'C4')).toBeLessThan(cx(k, 'D1'));
    // soft-start and compensation hang from their pins: R3 over C5
    expect(cy(k, 'C5')).toBeGreaterThan(cy(k, 'R3'));
  });

  it('uses one common ground line with a single ground symbol', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const s = sheetOf(k);
    const grounds = s.labels.filter((l) => l.kind === 'ground');
    // one for the regulator's ground line, one on the connector cell
    expect(grounds).toHaveLength(2);
    const gndNet = grounds[0]!.netId;
    const longest = s.wires.filter((w) => w.netId === gndNet && w.pts.length === 4 && w.pts[1] === w.pts[3]).sort((a, b) => Math.abs(b.pts[2]! - b.pts[0]!) - Math.abs(a.pts[2]! - a.pts[0]!))[0]!;
    const span = Math.abs(longest.pts[2]! - longest.pts[0]!);
    expect(span).toBeGreaterThan(sym(k, 'U1').bbox.w * 2);
  });

  it('centres parts between their supply connection and the ground line', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const s = sheetOf(k);
    /** Length of the vertical wire that ends at a pin (0 if the pin touches its connection directly). */
    const lead = (x: number, y: number) => {
      const w = s.wires.find((w) => {
        const n = w.pts.length;
        return (w.pts[n - 2] === x && w.pts[n - 1] === y && w.pts[n - 4] === x) || (w.pts[0] === x && w.pts[1] === y && w.pts[2] === x);
      });
      if (!w) return 0;
      const n = w.pts.length;
      return w.pts[0] === x && w.pts[1] === y ? Math.abs(w.pts[3]! - y) : Math.abs(w.pts[n - 3]! - y);
    };
    for (const r of ['C1', 'C2', 'C3', 'D1']) {
      const pins = [...sym(k, r).pins].sort((a, b) => a.y - b.y);
      const above = lead(pins[0]!.x, pins[0]!.y);
      const below = lead(pins[1]!.x, pins[1]!.y);
      expect(Math.abs(above - below), `${r}: ${above} above vs ${below} below`).toBeLessThanOrEqual(100);
    }
  });

  it('has no crossing wires', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    expect(crossings(sheetOf(k))).toEqual([]);
  });

  it('shows the feedback node by name at the divider and at VSNS', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    expect(sheetOf(k).labels.filter((l) => l.text === 'FB')).toHaveLength(2);
  });

  it('draws an LDO the same way (no inductor)', () => {
    const k = new Kernel();
    k.transact({
      summary: 'ldo',
      ops: [
        { op: 'add_part', part: 'ams:AMS1117-3.3', refdes: 'U1' },
        { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10uF', voltage: '16V' } },
        { op: 'add_part', part: 'generic:C', refdes: 'C2', params: { capacitance: '22uF', voltage: '10V' } },
        { op: 'connect', pins: ['U1.VIN', 'C1.1'], net: '+5V' },
        { op: 'set_net', net: '+5V', external: true, voltage: 5 },
        { op: 'connect', pins: ['U1.VOUT', 'C2.1'], net: '+3V3' },
        { op: 'connect', pins: ['U1.GND', 'C1.2', 'C2.2'], net: 'GND' },
      ],
    });
    expect(k.state().counts.errors).toBe(0);
    const u1 = sym(k, 'U1').bbox;
    expect(cx(k, 'C1')).toBeLessThan(u1.x);
    expect(cx(k, 'C2')).toBeGreaterThan(u1.x + u1.w);
    expect(crossings(sheetOf(k))).toEqual([]);
  });

  it('can be switched back to the compact drawing', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const r = k.transact({ summary: 'compact', ops: [{ op: 'constrain', kind: 'arrangement', a: 'U1', value: 'compact' }] });
    expect(r.status).toBe('ok');
    expect(sym(k, 'L1').rotation).toBeUndefined();
  });
});
