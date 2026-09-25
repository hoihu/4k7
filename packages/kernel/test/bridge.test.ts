import { describe, expect, it } from 'vitest';
import type { SheetView, Transaction } from '@tracewise/schema';
import { Kernel } from '../src/index.ts';

/** Transformer secondary on J1 → 4-diode bridge → smoothing cap. */
function rectifier(extra: Transaction['ops'] = []): Transaction {
  return {
    summary: 'bridge rectifier',
    ops: [
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
      ...(['D1', 'D2', 'D3', 'D4'] as const).map((r) => ({ op: 'add_part' as const, part: 'generic:D', refdes: r, params: { mpn: '1N4007' } })),
      { op: 'add_part', part: 'generic:CP', refdes: 'C1', params: { capacitance: '1000uF', voltage: '25V' } },
      { op: 'connect', pins: ['J1.1', 'D1.A', 'D3.K'], net: 'AC1' },
      { op: 'connect', pins: ['J1.2', 'D2.A', 'D4.K'], net: 'AC2' },
      { op: 'connect', pins: ['D1.K', 'D2.K', 'C1.+'], net: 'VDC' },
      { op: 'connect', pins: ['D3.A', 'D4.A', 'C1.-'], net: 'GND' },
      { op: 'set_net', net: 'VDC', voltage: 16 },
      ...extra,
    ],
  };
}

const sheet = (k: Kernel): SheetView => k.state().view.sheets[0]!;
const sym = (k: Kernel, ref: string) => sheet(k).symbols.find((s) => s.refdes === ref)!;

describe('bridge rectifier', () => {
  it('is recognised and drawn as the classic 45° diamond', () => {
    const k = new Kernel();
    expect(k.transact(rectifier()).status).toBe('ok');
    expect(k.state().counts.errors).toBe(0);

    const rots = ['D1', 'D2', 'D3', 'D4'].map((r) => sym(k, r).rotation);
    expect(rots.every((r) => r === 45 || r === -45)).toBe(true);

    // + on top (cathodes D1/D2), − at the bottom (anodes D3/D4)
    expect(sym(k, 'D1').bbox.y).toBeLessThan(sym(k, 'D3').bbox.y);
    expect(sym(k, 'D2').bbox.y).toBeLessThan(sym(k, 'D4').bbox.y);
    const up = sheet(k).labels.find((l) => l.text === 'VDC' && l.dir === 'up');
    const down = sheet(k).labels.find((l) => l.text === 'GND' && l.dir === 'down');
    expect(up && down && up.y < down.y).toBe(true);
    // AC on the side vertices: one points left, one right (J1's own pin labels also point right)
    const ac = sheet(k).labels.filter((l) => l.text.startsWith('AC'));
    expect(ac.filter((l) => l.dir === 'left')).toHaveLength(1);
    const left = ac.find((l) => l.dir === 'left')!;
    expect(ac.some((l) => l.dir === 'right' && l.y === left.y && l.x > left.x)).toBe(true);
  });

  it('wires the diodes along 45° lines into the vertices', () => {
    const k = new Kernel();
    k.transact(rectifier());
    const ids = new Set(['D1', 'D2', 'D3', 'D4'].map((r) => sym(k, r).componentId));
    const pinPts = new Set(sheet(k).symbols.filter((s) => ids.has(s.componentId)).flatMap((s) => s.pins.map((p) => `${p.x},${p.y}`)));
    const bridgeWires = sheet(k).wires.filter((w) => pinPts.has(`${w.pts[0]},${w.pts[1]}`));
    expect(bridgeWires).toHaveLength(8);
    for (const w of bridgeWires) {
      const dx = Math.abs(w.pts[2]! - w.pts[0]!);
      const dy = Math.abs(w.pts[3]! - w.pts[1]!);
      expect(Math.abs(dx - dy), `wire ${w.pts} is not diagonal`).toBeLessThanOrEqual(1);
    }
    // every diode pin is wired
    for (const r of ['D1', 'D2', 'D3', 'D4']) {
      for (const p of sym(k, r).pins) {
        expect(bridgeWires.some((w) => w.pts[0] === p.x && w.pts[1] === p.y), `${r}.${p.number}`).toBe(true);
      }
    }
  });

  it('can be switched to an inline drawing with an arrangement constraint', () => {
    const k = new Kernel();
    k.transact(rectifier([{ op: 'constrain', kind: 'arrangement', a: 'D1', value: 'inline', strength: 'soft', quote: 'draw the bridge flat' }]));
    expect(['D1', 'D2', 'D3', 'D4'].map((r) => sym(k, r).rotation ?? 0)).toEqual([0, 0, 0, 0]);
    expect(k.state().ledger.map((l) => l.text)).toEqual(['arrangement(D1) = inline']);
  });

  it('rejects arrangement on parts that are not diodes', () => {
    const k = new Kernel();
    k.transact(rectifier());
    const r = k.transact({ summary: 'x', ops: [{ op: 'constrain', kind: 'arrangement', a: 'C1', value: 'diamond' }] });
    expect(r.rejection?.code).toBe('CONSTRAINT_INVALID');
  });

  it('does not mistake other diode groups for a bridge', () => {
    const k = new Kernel();
    k.transact({
      summary: 'two parallel diodes',
      ops: [
        ...(['D1', 'D2', 'D3', 'D4'] as const).map((r) => ({ op: 'add_part' as const, part: 'generic:D', refdes: r })),
        { op: 'connect', pins: ['D1.K', 'D2.K', 'D3.K', 'D4.K'], net: 'OUT' },
        { op: 'connect', pins: ['D1.A', 'D2.A', 'D3.A', 'D4.A'], net: 'IN' },
      ],
    });
    expect(['D1', 'D2', 'D3', 'D4'].every((r) => !sym(k, r).rotation)).toBe(true);
  });

  it('draws the single-package bridge as a diamond with pins on the vertices', () => {
    const k = new Kernel();
    const r = k.transact({
      summary: 'packaged bridge',
      ops: [
        { op: 'add_part', part: 'generic:BRIDGE', refdes: 'D1', params: { mpn: 'MB6S' } },
        { op: 'connect', pins: ['D1.+'], net: 'VDC' },
        { op: 'connect', pins: ['D1.-'], net: 'GND' },
        { op: 'connect', pins: ['D1.AC1'], net: 'AC1' },
        { op: 'connect', pins: ['D1.AC2'], net: 'AC2' },
      ],
    });
    expect(r.status).toBe('ok');
    const s = sym(k, 'D1');
    const body = s.prims[0]!;
    expect(body.t).toBe('poly');
    const side = Object.fromEntries(s.pins.map((p) => [p.name, p.side]));
    expect(side).toEqual({ '+': 'top', AC1: 'left', AC2: 'right', '-': 'bottom' });
  });
});
