import { describe, expect, it } from 'vitest';
import type { PartCard, SheetView, SymbolView } from '@4k7/schema';
import { onWire } from '../src/drawing.ts';
import { Kernel } from '../src/index.ts';
import { routeWire } from '../src/schroute.ts';

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
  it('draws an orthogonal wire between two pins of a net, straight out of each where it can, and takes the labels at them away', () => {
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

/**
 * The net at a crystal's load cap, in a row at one level: R2 lying with its right pin facing C1,
 * C1 standing with its top pin on that level, R1 lying with its left pin facing C1. Nothing wired.
 */
function row(connect: { pins: string[]; net: string }[] = [{ pins: ['R2.2', 'C1.1', 'R1.1'], net: 'XT' }]) {
  const k = new Kernel();
  const ops = [
    { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '1k' } },
    { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '33p' } },
    { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
    ...connect.map((c) => ({ op: 'connect', ...c })),
    { op: 'connect', pins: ['R2.1', 'C1.2', 'R1.2'], net: 'GND' },
    // (turned there and back: a part the layout set off the grid comes back on it)
    { op: 'place_symbol', ref: 'C1', page: 1, x: 5000, y: 3000, orient: 'lying' },
    { op: 'place_symbol', ref: 'C1', page: 1, x: 5000, y: 3000, orient: 'upright' },
    { op: 'place_symbol', ref: 'R1', page: 1, x: 5600, y: 2800, orient: 'lying' },
    { op: 'place_symbol', ref: 'R2', page: 1, x: 4400, y: 2800, orient: 'lying' },
    { op: 'erase', net: 'XT' },
  ];
  const r = k.transact({ summary: 'row', ops } as never);
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  const s = sheetOf(k);
  const [left, cap, right] = [pinOf(s, 'R2', '2'), pinOf(s, 'C1', '1'), pinOf(s, 'R1', '1')];
  expect([left.side, cap.side, right.side]).toEqual(['right', 'top', 'left']);
  expect([left.y, right.y]).toEqual([cap.y, cap.y]);
  const page = s.pages[0]!.rect;
  return { k, left, cap, right, on: (p: { x: number; y: number }) => ({ x: p.x - page.x, y: p.y - page.y }) };
}
const isRun = (pts: number[], a: { x: number; y: number }, b: { x: number; y: number }) => [[a.x, a.y, b.x, b.y].join(), [b.x, b.y, a.x, a.y].join()].includes(pts.join());
const hasRun = (k: Kernel, a: { x: number; y: number }, b: { x: number; y: number }) => sheetOf(k).wires.some((w) => isRun(w.pts, a, b));
const detours = (k: Kernel) => k.state().diagnostics.filter((x) => x.code === 'SCH.DETOUR');

describe('wire at a pin', () => {
  it('joins a top pin from the side, straight, with no hop over it to come in from above', () => {
    const { k, cap, right } = row();
    const r = k.transact({ summary: 'wire', ops: [{ op: 'wire', from: 'R1.1', to: 'C1.1' }] });
    expect(r.results[0]!.effect).toMatch(/R1\.1 → C1\.1 \(XT\), straight/);
    expect(hasRun(k, right, cap)).toBe(true);
    expect(detours(k)).toEqual([]);
  });

  it('leaves it that way too, and a wire from the other side makes one straight run across the pin', () => {
    const { k, left, cap, right } = row();
    const r = k.transact({ summary: 'wire', ops: [{ op: 'wire', from: 'C1.1', to: 'R1.1' }, { op: 'wire', from: 'C1.1', to: 'R2.2' }] });
    expect(r.results.map((x) => x.effect)).toEqual([expect.stringMatching(/straight/), expect.stringMatching(/straight/)]);
    expect(hasRun(k, cap, right)).toBe(true);
    expect(hasRun(k, left, cap)).toBe(true);
    expect(detours(k)).toEqual([]);
  });

  it('takes a corner given on a pin it starts or ends at without going round to it, in any order', () => {
    for (const [from, to] of [['R1.1', 'C1.1'], ['C1.1', 'R1.1']] as const) {
      for (const via of ['cap', 'right', 'cap right', 'right cap', 'cap cap']) {
        const { k, cap, right, on } = row();
        const r = k.transact({ summary: 'wire', ops: [{ op: 'wire', from, to, via: via.split(' ').map((v) => on(v === 'cap' ? cap : right)) }] });
        expect(r.results[0]!.effect, `${from} via ${via}`).toMatch(/straight/);
        expect(hasRun(k, cap, right), `${from} via ${via}`).toBe(true);
      }
    }
  });

  it('needs no drawing for corners on what is drawn already', () => {
    const { k, left, cap, right, on } = row();
    expect(k.transact({ summary: 'wire', ops: [{ op: 'wire', from: 'C1.1', to: 'R2.2' }] }).status).toBe('ok');
    // the way traced along the wire that is there: from R2.2 past C1.1, and on to R1.1
    const r = k.transact({ summary: 'wire', ops: [{ op: 'wire', from: 'R2.2', to: 'R1.1', via: [on(left), on(cap), on(right)] }] });
    expect(r.results[0]!.effect).toMatch(/straight/);
    expect(hasRun(k, cap, right)).toBe(true);
    expect(detours(k)).toEqual([]);
  });

  it('runs through a pin of its own net in the way, which joins it, rather than hop over', () => {
    const { k, left, right } = row();
    const r = k.transact({ summary: 'wire', ops: [{ op: 'wire', from: 'R1.1', to: 'R2.2' }] });
    expect(r.results[0]!.effect).toMatch(/straight/);
    // (the clean-up keeps the run in two pieces, split at the pin it joins)
    const xs = sheetOf(k).wires.flatMap((w) => (w.pts.every((v, i) => i % 2 === 0 || v === left.y) ? w.pts.filter((_, i) => i % 2 === 0) : []));
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([left.x, right.x]);
    expect(sheetOf(k).labels.filter((l) => l.text === 'XT')).toEqual([]);
    expect(k.transact({ summary: 'again', ops: [{ op: 'wire', from: 'C1.1', to: 'R1.1' }] }).results[0]!.effect).toContain('already joined');
    expect(detours(k)).toEqual([]);
  });

  it('keeps a hump drawn through corners it was given, and says how to have it drawn plainly', () => {
    const { k, cap, on } = row();
    const via = [{ x: on(cap).x + 200, y: on(cap).y - 100 }, { x: on(cap).x, y: on(cap).y - 100 }];
    expect(k.transact({ summary: 'wire', ops: [{ op: 'wire', from: 'R1.1', to: 'C1.1', via }] }).results[0]!.effect).toMatch(/3 corners/);
    expect(detours(k).map((x) => x.message)).toEqual([expect.stringMatching(/turns back on itself .*erase it and wire it again without them/)]);
    const r = k.transact({ summary: 'again', ops: [{ op: 'erase', net: 'XT' }, { op: 'wire', from: 'R1.1', to: 'C1.1' }] });
    expect(r.results[1]!.effect).toMatch(/straight/);
    expect(detours(k)).toEqual([]);
  });

  it('tells the agent of a hump, and leaves it out of the issues, on a changeset too', () => {
    const { k, cap, on } = row();
    const was = k.state().counts;
    const via = [{ x: on(cap).x + 200, y: on(cap).y - 100 }, { x: on(cap).x, y: on(cap).y - 100 }];
    const r = k.transact({ summary: 'wire', ops: [{ op: 'wire', from: 'R1.1', to: 'C1.1', via }] });
    expect(r.introduced.map((x) => x.code)).toContain('SCH.DETOUR');
    expect(r.counts).toMatchObject({ errors: was.errors, warnings: was.warnings });
    expect(r.counts.drawing).toBeGreaterThan(was.drawing);
    const s = k.state();
    expect(s.counts).toEqual(r.counts);
    expect(s.proposal!.after).toEqual(r.counts);
    expect(s.summary.counts).toEqual(r.counts);
  });

  it('goes round a pin of another net in the way', () => {
    const { k, left, cap, right } = row([{ pins: ['R2.2', 'R1.1'], net: 'XT' }, { pins: ['C1.1'], net: 'CAP' }]);
    const r = k.transact({ summary: 'wire', ops: [{ op: 'wire', from: 'R1.1', to: 'R2.2' }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(hasRun(k, left, right)).toBe(false);
    expect(sheetOf(k).wires.filter((w) => onWire(cap.x, cap.y, w.pts))).toEqual([]);
    expect(sch(k)).toEqual([]);
    // (that is how it gets past: no detour)
    expect(detours(k)).toEqual([]);
  });

  it('leaves that hop to the wire op: a part placed on its own draws no U', () => {
    const { k } = row([{ pins: ['R2.2', 'R1.1'], net: 'XT' }, { pins: ['C1.1'], net: 'CAP' }]);
    const r = k.transact({ summary: 'place', ops: [{ op: 'place_symbol', ref: 'R1', page: 1, x: 5700, y: 2800, orient: 'lying' }] } as never);
    expect(r.results[0]!.effect).toMatch(/R1\.1 \(XT: the wire would jog\)/);
  });

  it('does not run over a pin off its grid', () => {
    // a box's edge is a lane for a wire, and the wire's grid has no line through the pin on it
    const part = (x: number, y: number, side: 'top' | 'left', bbox: SymbolView['bbox']): SymbolView => ({ componentId: 'P', refdes: 'P', value: '', bbox, prims: [], pins: [{ number: '1', name: '1', x, y, side, showName: false, showNumber: false }], refPos: { x: -5000, y: -5000, anchor: 'start' }, valuePos: { x: -5000, y: -5000, anchor: 'start' } });
    const route = (x: number, y: number, s: SymbolView, through?: { x: number; y: number }[]) => routeWire({ from: [{ x: 0, y: 0 }], fromWires: [], to: [{ x, y }], toWires: [], via: [], wires: [], symbols: [s], soft: [], bounds: { x: -1000, y: -1000, w: 3000, h: 3000 }, ...(through ? { through } : {}) })!;
    const over = (pts: number[], x: number, y: number) => {
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const [x1, y1, x2, y2] = [pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!];
        if (x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2)) return true;
      }
      return false;
    };
    const top = part(480, 0, 'top', { x: 430, y: 0, w: 100, h: 200 });
    const left = part(0, 480, 'left', { x: 0, y: 430, w: 200, h: 100 });
    expect(over(route(1000, 0, top), 480, 0)).toBe(false);
    expect(over(route(0, 1000, left), 0, 480)).toBe(false);
    // a pin of the wire's own net it may run through, which joins it
    expect(route(1000, 0, top, [{ x: 480, y: 0 }])).toEqual([0, 0, 1000, 0]);
    expect(route(0, 1000, left, [{ x: 0, y: 480 }])).toEqual([0, 0, 0, 1000]);
  });

  it('leaves a spot no way it may not reach it: a rail symbol is not run through from either end', () => {
    const route = (from: { x: number; y: number }, to: { x: number; y: number }, fromWires: number[][] = []) => routeWire({ from: [from], fromWires, to: [to], toWires: [], via: [], wires: [], symbols: [], soft: [], bounds: { x: -2000, y: -2000, w: 4000, h: 4000 }, forbid: new Map([['0,0', [0, 1]]]) });
    const [foot, above] = [{ x: 0, y: 0 }, { x: 0, y: -500 }];
    // not down onto the foot, and so not up off it
    expect(route(above, foot)).not.toEqual([0, -500, 0, 0]);
    const off = route(foot, above)!;
    expect(off.slice(0, 2)).toEqual([0, 0]);
    expect(off[3]!).toBeGreaterThanOrEqual(0);
    // nor from the end of a wire it stands on
    const on = route({ x: 500, y: 0 }, above, [[0, 0, 500, 0]])!;
    expect(on.slice(0, 2).join()).not.toBe('0,0');
  });

  it('never runs through a part: to a pin on its far side it goes round', () => {
    const { k } = row();
    // C1's bottom pin to R1's far end, up on the level of C1's top pin
    expect(k.transact({ summary: 'wire', ops: [{ op: 'wire', from: 'C1.2', to: 'R1.2' }] }).status).toBe('ok');
    const s = sheetOf(k);
    const [low, far] = [pinOf(s, 'C1', '2'), pinOf(s, 'R1', '2')];
    const w = s.wires.find((x) => onWire(low.x, low.y, x.pts) && onWire(far.x, far.y, x.pts))!;
    for (const ref of ['C1', 'R1']) {
      const b = s.symbols.find((x) => x.refdes === ref)!.bbox;
      for (let i = 0; i + 3 < w.pts.length; i += 2) {
        const [x1, y1, x2, y2] = [w.pts[i]!, w.pts[i + 1]!, w.pts[i + 2]!, w.pts[i + 3]!];
        const inX = Math.max(x1, x2) > b.x && Math.min(x1, x2) < b.x + b.w;
        const inY = Math.max(y1, y2) > b.y && Math.min(y1, y2) < b.y + b.h;
        expect(inX && inY, `${ref}: ${w.pts}`).toBe(false);
      }
    }
  });

  it('goes straight out of its pins on a run as long as a row, with no wire down the pin column', () => {
    // the return from the end of one row of a chain to the start of the next
    const k = new Kernel();
    const ops = [
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '1k' } },
      { op: 'connect', pins: ['R1.2', 'R2.1'], net: 'CHAIN' },
      { op: 'connect', pins: ['R1.1'], net: 'A' },
      { op: 'connect', pins: ['R2.2'], net: 'B' },
      { op: 'place_symbol', ref: 'R1', page: 1, x: 7000, y: 2000, orient: 'lying' },
      { op: 'place_symbol', ref: 'R2', page: 1, x: 2000, y: 3000, orient: 'lying' },
      { op: 'erase', net: 'CHAIN' },
      { op: 'wire', from: 'R1.2', to: 'R2.1' },
    ];
    const r = k.transact({ summary: 'row', ops } as never);
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const s = sheetOf(k);
    const [end, begin] = [pinOf(s, 'R1', '2'), pinOf(s, 'R2', '1')];
    const w = s.wires.find((x) => x.pts.join().includes(`${end.x},${end.y}`) && x.pts.join().includes(`${begin.x},${begin.y}`))!;
    const pts = w.pts[0] === end.x ? w.pts : w.pts.flatMap((_, i, a) => (i % 2 ? [] : [a[a.length - 2 - i]!, a[a.length - 1 - i]!]));
    expect([pts[2]! > end.x, pts[3]]).toEqual([true, end.y]); // out of R1 to the right
    expect([pts.at(-4)! < begin.x, pts.at(-3)]).toEqual([true, begin.y]); // into R2 from the left
  });

  it('goes straight out of a pin when going to the side saves nothing', () => {
    const { k, cap, on } = row();
    // to a corner above the pin and off to the right, then R1: up first and across, not across and up
    const r = k.transact({ summary: 'wire', ops: [{ op: 'wire', from: 'C1.1', to: 'R1.1', via: [{ x: on(cap).x + 200, y: on(cap).y - 600 }] }] });
    expect(r.status).toBe('ok');
    const w = sheetOf(k).wires.find((x) => x.pts.slice(0, 2).join() === `${cap.x},${cap.y}` || x.pts.slice(-2).join() === `${cap.x},${cap.y}`)!;
    const next = w.pts.slice(0, 2).join() === `${cap.x},${cap.y}` ? w.pts.slice(2, 4) : w.pts.slice(-4, -2);
    expect(next[0]).toBe(cap.x);
    expect(next[1]).toBeLessThan(cap.y);
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

  it('keeps a wire to another pin, whatever stands on that pin', () => {
    const k = kernel();
    const r = k.transact({ summary: 'label', ops: [{ op: 'label', pin: 'R2.1' }, { op: 'label', pin: 'U1.IN2' }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const s = sheetOf(k);
    const [a, b] = [pinOf(s, 'U1', 'IN2'), pinOf(s, 'R2', '1')];
    expect(s.wires.some((w) => onWire(a.x, a.y, w.pts) && onWire(b.x, b.y, w.pts))).toBe(true);
    for (const p of [a, b]) expect(labelsOf(s, 'BIAS').some((l) => l.x === p.x && l.y === p.y && !l.auto)).toBe(true);
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
