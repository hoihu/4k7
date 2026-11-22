import { describe, expect, it } from 'vitest';
import type { PartCard } from '@4k7/schema';
import { getBuiltinPart } from '@4k7/parts';
import { Kernel } from '../src/index.ts';

type Swaps = { swaps?: { change: string; apply: { op: string; a: string; b: string }[]; schematic_change: true; crossings: [number, number]; ratsnest_mm: [number, number] }[]; swaps_tried?: string };

const ok = (k: Kernel, ops: unknown[]) => {
  const r = k.transact({ summary: 'test', ops } as never);
  expect(r.status, JSON.stringify(r.status === 'rejected' && r.rejection)).toBe('ok');
};

/**
 * Two followers on a dual op-amp (`amp`), each channel wired to the connector on the far side:
 * channel A's pins (1–3, left) to J1 on the right, channel B's (5–7, right) to J2 on the left.
 */
function crossed(amp = 'ti:LM358DR', cards: PartCard[] = []) {
  const k = new Kernel();
  if (cards.length) {
    const d = k.committedDesign();
    for (const c of cards) d.parts[c.id] = c;
    k.load(d);
  }
  ok(k, [
    { op: 'add_part', part: amp, refdes: 'U1' },
    { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J1' },
    { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J2' },
    { op: 'connect', pins: ['J1.1', 'U1.3'], net: 'SIGA' },
    { op: 'connect', pins: ['J1.2', 'U1.1', 'U1.2'], net: 'OUTA' },
    { op: 'connect', pins: ['J2.1', 'U1.5'], net: 'SIGB' },
    { op: 'connect', pins: ['J2.2', 'U1.7', 'U1.6'], net: 'OUTB' },
    { op: 'connect', pins: ['J1.3', 'J2.3', 'U1.8'], net: '+5V' },
    { op: 'connect', pins: ['J1.4', 'J2.4', 'U1.4'], net: 'GND' },
    { op: 'set_board', width_mm: 40, height_mm: 20 },
  ]);
  k.accept();
  ok(k, [
    { op: 'place', ref: 'U1', x_mm: 20, y_mm: 10, rot: 0 },
    { op: 'place', ref: 'J1', x_mm: 33, y_mm: 10, rot: 0 },
    { op: 'place', ref: 'J2', x_mm: 7, y_mm: 10, rot: 0 },
    { op: 'route' },
  ]);
  expect(k.board().routing).toBe('done');
  return k;
}

describe('suggest_moves: pin and gate swaps', () => {
  it('proposes swapping the channels of a dual op-amp wired across, and applying it shortens the ratsnest as claimed', () => {
    const k = crossed();
    const before = k.board().measures;
    const s = k.query({ op: 'suggest_moves', parts: ['U1'] }) as Swaps;
    const best = s.swaps?.[0];
    expect(best, JSON.stringify(s)).toBeDefined();
    expect(best!.change).toBe('U1 op-amp channels INA+/INA-/OUTA and INB+/INB-/OUTB swapped');
    expect(best!.apply).toEqual([{ op: 'swap_pins', a: 'U1.3', b: 'U1.5' }]);
    expect(best!.schematic_change).toBe(true);
    expect(best!.ratsnest_mm[0]).toBe(before.ratsnestMm);
    expect(best!.ratsnest_mm[1]).toBeLessThan(best!.ratsnest_mm[0]);
    ok(k, best!.apply);
    const after = k.board().measures;
    expect([after.ratsnestMm, after.crossings]).toEqual([best!.ratsnest_mm[1], best!.crossings[1]]);
    // routed again, swapping back is no better: nothing more to suggest
    ok(k, [{ op: 'route' }]);
    expect((k.query({ op: 'suggest_moves', parts: ['U1'] }) as Swaps).swaps).toEqual([]);
  });

  it('offers them with no part named too, and the turns and shifts stay as they were', () => {
    const s = crossed().query({ op: 'suggest_moves' }) as Swaps & { suggestions: unknown[] };
    expect(s.suggestions).toEqual([]);
    expect(s.swaps?.[0]?.apply).toEqual([{ op: 'swap_pins', a: 'U1.3', b: 'U1.5' }]);
  });

  it('proposes no swap for parts whose card declares none', () => {
    const k = crossed();
    const s = k.query({ op: 'suggest_moves', parts: ['J1', 'J2'] }) as Swaps;
    expect([s.swaps, s.swaps_tried]).toEqual([undefined, undefined]);
  });

  it('never proposes a swap swap_pins refuses', () => {
    // a malformed card: its two channels have different shapes, so swap_pins refuses every swap
    const bad: PartCard = { ...structuredClone(getBuiltinPart('ti:LM358DR')!), id: 'test:BADAMP', swapGroups: [{ name: 'channels', members: [['3', '2', '1'], ['5', '6']] }] };
    const s = crossed('test:BADAMP', [bad]).query({ op: 'suggest_moves', parts: ['U1'] }) as Swaps;
    expect(s.swaps_tried).toMatch(/^1 swap/);
    expect(s.swaps).toEqual([]);
  });
});

describe('the resistor array card', () => {
  it('loads with an 8-pad 0603×4 land, and every swap its groups declare passes swap_pins', () => {
    const card = getBuiltinPart('generic:R_ARRAY_4')!;
    const k = new Kernel();
    ok(k, [
      { op: 'add_part', part: 'generic:R_ARRAY_4', refdes: 'RN1', params: { resistance: '10k' } },
      ...['1', '2', '3', '4', '5', '6', '7', '8'].map((n) => ({ op: 'connect', pins: [`RN1.${n}`], net: `N${n}` })),
    ]);
    k.accept();
    const rn = k.boardPlacement().parts.find((p) => p.refdes === 'RN1')!;
    expect([rn.pkg, rn.pads.length]).toEqual(['0603x4', 8]);
    for (const g of card.swapGroups!) {
      for (const o of g.members.slice(1)) {
        const r = k.transact({ summary: 'swap', ops: [{ op: 'swap_pins', a: `RN1.${g.members[0]![0]}`, b: `RN1.${o[0]}` }] });
        expect(r.status, `${g.name}: ${g.members[0]} ↔ ${o}`).toBe('ok');
        k.reject();
      }
    }
    // a whole resistor moves: R1 (1–8) and R2 (2–7) change places
    ok(k, [{ op: 'swap_pins', a: 'RN1.1', b: 'RN1.2' }]);
    const net = (n: string) => k.draftDesign().nets[Object.values(k.draftDesign().components)[0]!.pins[n]!]!.name;
    expect(['1', '8', '2', '7'].map(net)).toEqual(['N2', 'N7', 'N1', 'N8']);
    // the ends of two resistors do not mix
    expect(k.transact({ summary: 'swap', ops: [{ op: 'swap_pins', a: 'RN1.1', b: 'RN1.7' }] }).status).toBe('rejected');
  });
});
