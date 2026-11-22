import { describe, expect, it } from 'vitest';
import type { PartCard } from '@4k7/schema';
import { getBuiltinPart } from '@4k7/parts';
import { Kernel } from '../src/index.ts';

/** A 2 × 10 k resistor array (R1 = pins 1–4, R2 = pins 2–3): the ends of each resistor swap, the two resistors do not mix. */
const array: PartCard = {
  id: 'test:RN2',
  description: '2 × resistor array, isolated, SIP-4',
  category: 'resistor',
  refPrefix: 'RN',
  package: 'HDR-1x4',
  pins: ['1', '2', '3', '4'].map((number) => ({ number, name: number, type: 'passive' as const })),
  params: {},
  provenance: { source: 'builtin' },
  swapGroups: [
    { name: 'R1 ends', members: [['1'], ['4']] },
    { name: 'R2 ends', members: [['2'], ['3']] },
  ],
};

/** A design with these cards in its library (and nothing using them yet, so add a part in the same transaction). */
function withCards(k: Kernel, cards: PartCard[]) {
  const d = k.committedDesign();
  for (const c of cards) d.parts[c.id] = c;
  k.load(d);
}

/** Two non-inverting stages on an LM358, an array on their inputs, on a small board. */
function circuit() {
  const k = new Kernel();
  withCards(k, [array]);
  const r = k.transact({
    summary: 'two stages',
    ops: [
      { op: 'add_part', part: 'ti:LM358DR', refdes: 'U1' },
      { op: 'add_part', part: 'test:RN2', refdes: 'RN1' },
      { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J1' },
      { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '100nF', voltage: '16V' } },
      ...['R1', 'R2', 'R3', 'R4'].map((refdes) => ({ op: 'add_part', part: 'generic:R', refdes, params: { resistance: '10k' } })),
      { op: 'connect', pins: ['J1.1', 'U1.V+', 'C1.1'], net: '+5V' },
      { op: 'connect', pins: ['J1.2', 'U1.GND', 'C1.2', 'R2.2', 'R4.2'], net: 'GND' },
      { op: 'set_net', net: '+5V', external: true, voltage: 5 },
      { op: 'connect', pins: ['J1.3', 'RN1.1'], net: 'IN1' },
      { op: 'connect', pins: ['J1.4', 'RN1.2'], net: 'IN2' },
      { op: 'connect', pins: ['RN1.4', 'U1.INA+'], net: 'SIGA' },
      { op: 'connect', pins: ['RN1.3', 'U1.INB+'], net: 'SIGB' },
      { op: 'connect', pins: ['U1.INA-', 'R1.2', 'R2.1'], net: 'FBA' },
      { op: 'connect', pins: ['U1.OUTA', 'R1.1'], net: 'OUTA' },
      { op: 'connect', pins: ['U1.INB-', 'R3.2', 'R4.1'], net: 'FBB' },
      { op: 'connect', pins: ['U1.OUTB', 'R3.1'], net: 'OUTB' },
      { op: 'set_board', width_mm: 30, height_mm: 20 },
    ],
  } as never);
  expect(r.status, JSON.stringify(r.status === 'rejected' && r.rejection)).toBe('ok');
  k.accept();
  return k;
}

const netOf = (k: Kernel, pin: string) => {
  const d = k.draftDesign();
  const [ref, n] = pin.split('.');
  const c = Object.values(d.components).find((x) => x.refdes === ref)!;
  const id = c.pins[n!];
  return id ? d.nets[id]!.name : undefined;
};
const swap = (k: Kernel, a: string, b: string) => k.transact({ summary: 'swap', ops: [{ op: 'swap_pins', a, b }] });
const refusal = (k: Kernel, a: string, b: string) => {
  const r = swap(k, a, b);
  expect(r.status).toBe('rejected');
  return r.status === 'rejected' ? r.rejection : undefined;
};
const codes = (xs: { code: string; waivedBy?: string }[]) => xs.filter((x) => !x.waivedBy).map((x) => x.code).sort();

describe('swap_pins', () => {
  it('swaps the two ends of one resistor of an array', () => {
    const k = circuit();
    expect(swap(k, 'RN1.1', 'RN1.4').status).toBe('ok');
    expect([netOf(k, 'RN1.1'), netOf(k, 'RN1.4')]).toEqual(['SIGA', 'IN1']);
    expect(netOf(k, 'RN1.2')).toBe('IN2');
  });

  it('swaps the channels of a dual op-amp: its three nets move together', () => {
    const k = circuit();
    const r = swap(k, 'U1.INA+', 'U1.INB+');
    expect(r.status).toBe('ok');
    expect(['U1.3', 'U1.2', 'U1.1'].map((p) => netOf(k, p))).toEqual(['SIGB', 'FBB', 'OUTB']);
    expect(['U1.5', 'U1.6', 'U1.7'].map((p) => netOf(k, p))).toEqual(['SIGA', 'FBA', 'OUTA']);
    expect([netOf(k, 'U1.8'), netOf(k, 'U1.4')]).toEqual(['+5V', 'GND']);
  });

  it('leaves the ERC and DRC findings as they were, and the drawing and board follow', () => {
    const k = circuit();
    const erc = codes(k.state().diagnostics);
    const routed = () => {
      expect(k.transact({ summary: 'route', ops: [{ op: 'route' }] }).status).toBe('ok');
      const b = k.board();
      expect([b.routing, b.tracks.length > 0]).toEqual(['done', true]);
      return b;
    };
    const drc = codes(routed().diagnostics);
    expect(swap(k, 'U1.OUTA', 'U1.OUTB').status).toBe('ok');
    expect(codes(k.state().diagnostics)).toEqual(erc);
    expect(codes(routed().diagnostics)).toEqual(drc);
    const u1 = k.boardPlacement().parts.find((p) => p.refdes === 'U1')!;
    const d = k.draftDesign();
    expect(d.nets[u1.pads.find((p) => p.number === '1')!.netId!]!.name).toBe('OUTB');
    // the schematic draws each output pin on its new net (a wire end or a label at the pin), nothing of the old one
    const sheet = k.state().view.sheets[0]!;
    const at = (n: string) => {
      const p = sheet.symbols.find((x) => x.refdes === 'U1')!.pins.find((x) => x.number === n)!;
      const ids = [...sheet.wires.filter((w) => w.pts.some((v, i) => i % 2 === 0 && v === p.x && w.pts[i + 1] === p.y)).map((w) => w.netId), ...sheet.labels.filter((l) => l.x === p.x && l.y === p.y).map((l) => l.netId)];
      return [...new Set(ids.map((id) => d.nets[id]!.name))];
    };
    expect([at('1'), at('7')]).toEqual([['OUTB'], ['OUTA']]);
  });

  it('refuses pins of different groups', () => {
    expect(refusal(circuit(), 'RN1.1', 'RN1.2')).toMatchObject({ code: 'SWAP_INVALID', message: expect.stringMatching(/different swap groups/) });
  });

  it('refuses a pin in no group, and a part without groups', () => {
    expect(refusal(circuit(), 'U1.INA+', 'U1.V+')!.message).toMatch(/U1\.V\+ is in no swap group/);
    expect(refusal(circuit(), 'R1.1', 'R1.2')!.message).toMatch(/declares no swappable pins/);
  });

  it('refuses pins of two components', () => {
    expect(refusal(circuit(), 'U1.INA+', 'RN1.1')!.message).toMatch(/different components/);
  });

  it('refuses pins at different places of two gates, pins of one gate, and gates of different shapes', () => {
    expect(refusal(circuit(), 'U1.INA+', 'U1.INB-')!.message).toMatch(/different places/);
    expect(refusal(circuit(), 'U1.INA+', 'U1.INA-')!.message).toMatch(/same gate/);
    const bad: PartCard = { ...structuredClone(getBuiltinPart('ti:LM358DR')!), id: 'test:BADAMP', swapGroups: [{ name: 'channels', members: [['3', '2', '1'], ['5', '6']] }] };
    const k = circuit();
    withCards(k, [bad]);
    expect(k.transact({ summary: 'amp', ops: [{ op: 'add_part', part: 'test:BADAMP', refdes: 'U2' }] }).status).toBe('ok');
    expect(refusal(k, 'U2.3', 'U2.5')!.message).toMatch(/different shapes/);
  });
});
