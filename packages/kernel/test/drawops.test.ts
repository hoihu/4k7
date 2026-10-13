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

/** J1 → R1 → U1.IN1, R2 from U1.IN2 to ground, U1.OUT → J2. */
const chain = [
  { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
  { op: 'add_part', part: 'acme:IC', refdes: 'U1' },
  { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J2' },
  { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
  { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '10k' } },
  { op: 'connect', pins: ['J1.1', 'R1.1'], net: 'IN' },
  { op: 'connect', pins: ['R1.2', 'U1.IN1'], net: 'IN_F' },
  { op: 'connect', pins: ['U1.IN2', 'R2.1'], net: 'BIAS' },
  { op: 'connect', pins: ['U1.OUT', 'J2.1'], net: 'OUT' },
  { op: 'connect', pins: ['J1.2', 'J2.2', 'R2.2', 'U1.GND'], net: 'GND' },
  { op: 'connect', pins: ['U1.VCC'], net: '+5V' },
  { op: 'set_net', net: '+5V', voltage: 5 },
];

function kernel() {
  const k = new Kernel();
  const d = k.committedDesign();
  d.parts[ic.id] = ic;
  k.load(d);
  expect(k.transact({ summary: 'circuit', ops: chain } as never).status).toBe('ok');
  return k;
}

const sheetOf = (k: Kernel): SheetView => k.state().view.sheets[0]!;
const pinOf = (s: SheetView, ref: string, pin: string) => s.symbols.find((x) => x.refdes === ref)!.pins.find((p) => p.name === pin || p.number === pin)!;
const labelsOf = (s: SheetView, net: string) => s.labels.filter((l) => l.text === net);
const sch = (k: Kernel) => k.state().diagnostics.filter((x) => x.code.startsWith('SCH.') && x.severity === 'error');

describe('wire', () => {
  it('draws an orthogonal wire between two pins of a net, leaving each outwards, and takes the labels at them away', () => {
    const k = kernel();
    k.transact({ summary: 'move', ops: [{ op: 'place_symbol', ref: 'J2', page: 1, x: 9000, y: 2500, mirror: true }] });
    expect(labelsOf(sheetOf(k), 'OUT').length).toBeGreaterThan(0);
    const r = k.transact({ summary: 'wire', ops: [{ op: 'wire', from: 'U1.OUT', to: 'J2.1' }] });
    expect(r.status).toBe('ok');
    expect(r.results[0]!.effect).toMatch(/wire U1\.OUT → J2\.1 \(OUT\), 2 corners/);
    const s = sheetOf(k);
    expect(labelsOf(s, 'OUT')).toEqual([]);
    const out = pinOf(s, 'U1', 'OUT');
    const j = pinOf(s, 'J2', '1');
    const w = s.wires.find((x) => x.pts[0] === out.x && x.pts[1] === out.y)!;
    expect(w.pts.slice(-2)).toEqual([j.x, j.y]);
    for (let i = 0; i + 3 < w.pts.length; i += 2) expect(w.pts[i] === w.pts[i + 2] || w.pts[i + 1] === w.pts[i + 3]).toBe(true);
    expect(w.pts[2]).toBeGreaterThan(out.x); // out of U1's right side
    expect(w.pts.at(-4)).toBeLessThan(j.x); // into J2 from the left, the side its pins face
    expect(sch(k)).toEqual([]);
  });

  it('only shows a connection the netlist has', () => {
    const k = kernel();
    const r = k.transact({ summary: 'wire', ops: [{ op: 'wire', from: 'U1.OUT', to: 'J2.2' }] });
    expect(r.rejection?.code).toBe('NET_MISMATCH');
    expect(r.rejection?.message).toMatch(/connect them first/);
    expect(k.transact({ summary: 'wire', ops: [{ op: 'wire', from: 'J1.1', to: 'U1.VCC' }] }).rejection?.code).toBe('NET_MISMATCH');
  });

  it('passes the corners it is given', () => {
    const k = kernel();
    k.transact({ summary: 'move', ops: [{ op: 'place_symbol', ref: 'J2', page: 1, x: 9000, y: 2500, mirror: true }] });
    const page = sheetOf(k).pages[0]!.rect;
    const out = pinOf(sheetOf(k), 'U1', 'OUT');
    const vx = out.x - page.x + 400;
    const r = k.transact({ summary: 'wire', ops: [{ op: 'wire', from: 'U1.OUT', to: 'J2.1', via: [{ x: vx, y: 1500 }] }] });
    expect(r.status).toBe('ok');
    const w = sheetOf(k).wires.find((x) => x.pts[0] === out.x && x.pts[1] === out.y)!;
    const pts = Array.from({ length: w.pts.length / 2 }, (_, i) => [w.pts[2 * i]! - page.x, w.pts[2 * i + 1]! - page.y]);
    expect(pts.some(([x, y]) => Math.abs(x! - vx) <= 50 && Math.abs(y! - 1500) <= 50)).toBe(true);
  });
});

describe('label', () => {
  it('puts a horizontal label on a lead at a top pin when asked to point right', () => {
    const k = kernel();
    // R2 hangs from U1.IN2: its pin 1 is on top
    const top = pinOf(sheetOf(k), 'R2', '1');
    expect(top.side).toBe('top');
    const r = k.transact({ summary: 'label', ops: [{ op: 'label', pin: 'R2.1', dir: 'right' }] });
    expect(r.results[0]!.effect).toBe('label BIAS pointing right (horizontal) at R2.1');
    const s = sheetOf(k);
    const l = labelsOf(s, 'BIAS').find((x) => x.dir === 'right')!;
    expect([l.x, l.y]).toEqual([top.x, top.y - 200]);
    expect(s.wires.some((w) => w.pts.join() === [top.x, top.y, top.x, top.y - 200].join())).toBe(true);
    expect(sch(k)).toEqual([]);
  });

  it('draws a supply symbol pointing its own way, and refuses a label lying on the part', () => {
    const k = kernel();
    k.transact({ summary: 'label', ops: [{ op: 'label', pin: 'U1.VCC' }] });
    const vcc = labelsOf(sheetOf(k), '+5V');
    expect(vcc.length).toBeGreaterThan(0);
    expect(vcc.every((l) => l.kind === 'rail' && l.dir === 'up')).toBe(true);
    expect(k.transact({ summary: 'label', ops: [{ op: 'label', pin: 'U1.OUT', dir: 'left' }] }).rejection?.message).toMatch(/would lie on the part/);
  });
});

describe('erase', () => {
  it('takes wires and labels at pins away; the connections show as automatic labels', () => {
    const k = kernel();
    const r = k.transact({ summary: 'erase', ops: [{ op: 'erase', pins: ['U1.IN2'] }] });
    expect(r.results[0]!.effect).toMatch(/erased 1 wire/);
    const s = sheetOf(k);
    const auto = labelsOf(s, 'BIAS').filter((l) => l.auto);
    expect(auto).toHaveLength(2);
    expect(sch(k)).toEqual([]);
    // and the labels are listed for the agent, marked auto, at their pins
    const q = k.query({ op: 'get_schematic' }) as { labels: { net: string; at: string; auto?: boolean }[] };
    expect(q.labels.filter((l) => l.net === 'BIAS').map((l) => [l.at, l.auto])).toEqual(expect.arrayContaining([['U1.IN2', true], ['R2.1', true]]));
  });

  it('erases everything drawn of a net', () => {
    const k = kernel();
    k.transact({ summary: 'erase', ops: [{ op: 'erase', net: 'IN_F' }] });
    expect(labelsOf(sheetOf(k), 'IN_F').every((l) => l.auto)).toBe(true);
  });
});

describe('the drawing ops in Optimize', () => {
  it('are allowed at pins of parts in the area', () => {
    const k = kernel();
    const s = sheetOf(k);
    const u1 = s.symbols.find((x) => x.refdes === 'U1')!;
    const info = k.setScope({ view: 'schematic', sheet: s.id, rect: { x: u1.bbox.x - 1500, y: u1.bbox.y - 1500, w: u1.bbox.w + 3000, h: u1.bbox.h + 3000 } });
    expect(info && 'error' in info).toBe(false);
    expect(k.transact({ summary: 'l', ops: [{ op: 'label', pin: 'U1.IN2', dir: 'left' }] }).status).toBe('ok');
    expect(k.transact({ summary: 'e', ops: [{ op: 'erase', net: 'GND' }] }).rejection?.code).toBe('OUT_OF_SCOPE');
  });
});
