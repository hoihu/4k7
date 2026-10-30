import { describe, expect, it } from 'vitest';
import type { PartCard, SheetView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';

/** A plain IC: two inputs on the left, an output on the right, supply on top and bottom. */
const ic: PartCard = {
  id: 'acme:IC',
  mpn: 'acme:IC',
  description: 'ic',
  category: 'ic',
  refPrefix: 'U',
  pins: [
    { number: '1', name: 'IN1', type: 'in' },
    { number: '2', name: 'IN2', type: 'in' },
    { number: '3', name: 'OUT', type: 'out' },
    { number: '4', name: 'VCC', type: 'pwr_in' },
    { number: '5', name: 'GND', type: 'pwr_in' },
  ],
  params: {},
  provenance: { source: 'datasheet' },
};

/** J1.1 → R1 → U1.IN1; R2 pulls U1.IN2 down; U1.OUT → J2.1. Nothing is placed: the layout draws the sheet until the first place_symbol. */
const circuit = [
  { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
  { op: 'add_part', part: 'acme:IC', refdes: 'U1' },
  { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J2' },
  { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
  { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '10k' } },
  { op: 'connect', pins: ['J1.1', 'R1.1'], net: 'IN' },
  { op: 'connect', pins: ['R1.2', 'U1.IN1'], net: 'IN_F' },
  { op: 'connect', pins: ['U1.IN2', 'R2.1'], net: 'BIAS' },
  { op: 'connect', pins: ['U1.OUT', 'J2.1'], net: 'OUT' },
  { op: 'connect', pins: ['J2.2', 'R2.2', 'U1.GND'], net: 'GND' },
  { op: 'connect', pins: ['U1.VCC'], net: '+5V' },
  { op: 'set_net', net: '+5V', voltage: 5 },
];

/** More parts, added after the circuit (a pull-up R3 on BIAS, R4 from J1.2 to +5V: net RET). */
const pullUp = [
  { op: 'add_part', part: 'generic:R', refdes: 'R3', params: { resistance: '4k7' } },
  { op: 'connect', pins: ['R3.1', 'U1.VCC'], net: '+5V' },
  { op: 'connect', pins: ['R3.2', 'U1.IN2'], net: 'BIAS' },
];
const returnPath = [
  { op: 'add_part', part: 'generic:R', refdes: 'R4', params: { resistance: '100' } },
  { op: 'connect', pins: ['R4.1', 'U1.VCC'], net: '+5V' },
  { op: 'connect', pins: ['J1.2', 'R4.2'], net: 'RET' },
];

function kernel(more: object[] = []) {
  const k = new Kernel();
  const d = k.committedDesign();
  d.parts[ic.id] = ic;
  k.load(d);
  expect(k.transact({ summary: 'circuit', ops: [...circuit, ...more] } as never).status).toBe('ok');
  return k;
}

const place = (k: Kernel, ref: string, x: number, y: number, extra: object = {}) => {
  const r = k.transact({ summary: `place ${ref}`, ops: [{ op: 'place_symbol', ref, page: 1, x, y, ...extra }] } as never);
  expect(r.status).toBe('ok');
  return r.results[0]!.effect;
};
const sheetOf = (k: Kernel): SheetView => k.state().view.sheets[0]!;
const sch = (k: Kernel) => k.state().diagnostics.filter((x) => x.code.startsWith('SCH.') && x.severity === 'error');
const wiresOf = (k: Kernel, net: string) => {
  const id = Object.values(k.draftDesign().nets).find((n) => n.name === net)!.id;
  return sheetOf(k).wires.filter((w) => w.netId === id);
};
const labelsOf = (k: Kernel, net: string) => sheetOf(k).labels.filter((l) => l.text === net);
const pin = (k: Kernel, ref: string, n: string) => sheetOf(k).symbols.find((s) => s.refdes === ref)!.pins.find((p) => p.number === n || p.name === n)!;

/** Whether the pins of a net hang together in the drawing: by wires that touch, or by a label of the net at each piece. */
function joined(k: Kernel, net: string, refs: string[]): boolean {
  const s = sheetOf(k);
  const ws = wiresOf(k, net);
  const on = (x: number, y: number, pts: number[]) => {
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const [x1, y1, x2, y2] = [pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!];
      if (x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2)) return true;
    }
    return false;
  };
  const nodes = [...refs.map((r) => ({ x: pin(k, ...(r.split('.') as [string, string])).x, y: pin(k, ...(r.split('.') as [string, string])).y })), ...ws.map((w) => ({ pts: w.pts }))] as { x?: number; y?: number; pts?: number[] }[];
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const touch = (a: (typeof nodes)[number], b: (typeof nodes)[number]) => {
    const ends = (n: typeof a) => (n.pts ? [[n.pts[0]!, n.pts[1]!], [n.pts.at(-2)!, n.pts.at(-1)!]] : [[n.x!, n.y!]]) as [number, number][];
    const hit = (p: [number, number], n: typeof a) => (n.pts ? on(p[0], p[1], n.pts) : n.x === p[0] && n.y === p[1]);
    return ends(a).some((p) => hit(p, b)) || ends(b).some((p) => hit(p, a));
  };
  nodes.forEach((a, i) => nodes.forEach((b, j) => j > i && touch(a, b) && (parent[find(i)] = find(j))));
  // a label of the net ties what it sits on to every other label of it
  const tied = labelsOf(k, net).map((l) => nodes.findIndex((n) => touch(n, { x: l.x, y: l.y }))).filter((i) => i >= 0);
  for (const i of tied) parent[find(i)] = find(tied[0]!);
  return new Set(refs.map((_, i) => find(i))).size === 1;
}

/** J1 and U1 placed; R1 lying between them. */
function placed(more: object[] = []) {
  const k = kernel(more);
  place(k, 'J1', 2000, 2500);
  place(k, 'U1', 6000, 2500);
  return k;
}

describe('a two-pin part placed on its own', () => {
  it('between two placed parts is wired to both', () => {
    const k = placed();
    const effect = place(k, 'R1', 4000, 2500, { orient: 'lying' });
    expect(effect).toMatch(/wired R1\.1 to J1\.1, R1\.2 to U1\.IN1/);
    for (const [net, refs] of [['IN', ['J1.1', 'R1.1']], ['IN_F', ['R1.2', 'U1.IN1']]] as const) {
      expect(wiresOf(k, net)).toHaveLength(1);
      expect(labelsOf(k, net)).toEqual([]); // no label, not even an automatic one
      expect(joined(k, net, [...refs])).toBe(true);
    }
    const w = wiresOf(k, 'IN')[0]!;
    expect([w.pts.slice(0, 2), w.pts.slice(-2)]).toEqual(expect.arrayContaining([[pin(k, 'R1', '1').x, pin(k, 'R1', '1').y], [pin(k, 'J1', '1').x, pin(k, 'J1', '1').y]]));
    expect(sch(k)).toEqual([]);
  });

  it('beside an IC pin, a pull-up is wired to the pin and the parts on it, and its supply stays a symbol', () => {
    const k = placed(pullUp);
    expect(wiresOf(k, 'BIAS').length).toBeGreaterThan(0); // R2 hangs from the pin already
    const effect = place(k, 'R3', 4800, 2200, { orient: 'upright' });
    expect(effect).toMatch(/wired R3\.2 to /);
    expect(labelsOf(k, 'BIAS')).toEqual([]);
    expect(joined(k, 'BIAS', ['U1.IN2', 'R3.2'])).toBe(true);
    expect(labelsOf(k, '+5V').some((l) => l.kind === 'rail' && l.x === pin(k, 'R3', '1').x && l.y === pin(k, 'R3', '1').y)).toBe(true);
    expect(sch(k)).toEqual([]);
  });

  it('is left to labels where a wire would cross another net, and nothing is left out', () => {
    const k = placed(returnPath);
    place(k, 'R1', 4000, 2500, { orient: 'lying' }); // IN runs along y = 2500 from J1
    // J1.2 is under that wire, R4 above it: any wire from R4 to J1.2 crosses IN or goes round J1
    const effect = place(k, 'R4', 3000, 1500, { orient: 'upright' });
    expect(effect).toMatch(/connected by labels: R4\.2 \(RET: /);
    expect(wiresOf(k, 'RET')).toEqual([]);
    const l = labelsOf(k, 'RET');
    expect(l.length).toBeGreaterThanOrEqual(2);
    expect(l.every((x) => x.auto)).toBe(true); // automatic: the agent's own label or wire replaces them
    expect(joined(k, 'RET', ['J1.2', 'R4.2'])).toBe(true);
    expect(sch(k)).toEqual([]);
  });

  it('moved again, takes its wires along and the drawing still shows every connection', () => {
    const k = placed();
    place(k, 'R1', 4000, 2500, { orient: 'lying' });
    // along the line: wired again, the wires follow the pins
    expect(place(k, 'R1', 3400, 2500, { orient: 'lying' })).toMatch(/wired R1\.1 to J1\.1, R1\.2 to U1\.IN1/);
    expect(wiresOf(k, 'IN')).toHaveLength(1);
    expect(wiresOf(k, 'IN_F')).toHaveLength(1);
    expect(labelsOf(k, 'IN')).toEqual([]);
    // off the line, the wire would jog: labels connect it, and no wire is left at the old place of the pin
    const from = pin(k, 'R1', '1');
    place(k, 'R1', 4000, 3500, { orient: 'lying' });
    const to = pin(k, 'R1', '1');
    expect(to.y).not.toBe(from.y);
    for (const net of ['IN', 'IN_F']) for (const w of wiresOf(k, net)) expect(w.pts.some((v, i) => i % 2 === 0 && v === from.x && w.pts[i + 1] === from.y)).toBe(false);
    expect(joined(k, 'IN', ['J1.1', 'R1.1'])).toBe(true);
    expect(joined(k, 'IN_F', ['R1.2', 'U1.IN1'])).toBe(true);
    expect(sch(k)).toEqual([]);
    // and away from both, where nothing clean fits, labels connect it
    const far = place(k, 'R1', 6000, 9000, { orient: 'lying' });
    expect(far).toMatch(/connected by labels/);
    expect(joined(k, 'IN', ['J1.1', 'R1.1'])).toBe(true);
    expect(joined(k, 'IN_F', ['R1.2', 'U1.IN1'])).toBe(true);
  });

  it('is replaced by the agent: erase brings automatic labels, which stay; a wire or a label op takes over', () => {
    const k = placed();
    place(k, 'R1', 4000, 2500, { orient: 'lying' });
    const erase = k.transact({ summary: 'erase', ops: [{ op: 'erase', pins: ['R1.1'] }] });
    expect(erase.status).toBe('ok');
    expect(wiresOf(k, 'IN')).toEqual([]);
    expect(labelsOf(k, 'IN').length).toBe(2);
    expect(labelsOf(k, 'IN').every((l) => l.auto)).toBe(true);
    // placing another part does not wire it again behind the agent's back
    place(k, 'R2', 5000, 3500, { orient: 'upright' });
    expect(wiresOf(k, 'IN')).toEqual([]);
    const wire = k.transact({ summary: 'wire', ops: [{ op: 'wire', from: 'R1.1', to: 'J1.1' }] });
    expect(wire.status).toBe('ok');
    expect(labelsOf(k, 'IN')).toEqual([]);
    expect(joined(k, 'IN', ['J1.1', 'R1.1'])).toBe(true);
    // a label where the agent wants one
    k.transact({ summary: 'erase', ops: [{ op: 'erase', pins: ['R1.2'] }] });
    const label = k.transact({ summary: 'label', ops: [{ op: 'label', pin: 'R1.2', dir: 'right' }, { op: 'label', pin: 'U1.IN1', dir: 'left' }] });
    expect(label.status).toBe('ok');
    expect(wiresOf(k, 'IN_F')).toEqual([]);
    expect(labelsOf(k, 'IN_F').some((l) => !l.auto)).toBe(true);
    expect(sch(k)).toEqual([]);
  });
});
