import { describe, expect, it } from 'vitest';
import type { OptimizeScope, ScopeInfo } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { circuitSignature } from '../src/scope.ts';
import { buckTransaction } from './fixtures.ts';

/** The buck's output side: inductor, diode, output cap, feedback divider, compensation and boot parts. */
const OUTPUT_SIDE = { x: 6200, y: 2800, w: 2800, h: 2000 };

function setup(rect = OUTPUT_SIDE) {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  const sheet = k.state().view.sheets[0]!;
  const scope: OptimizeScope = { view: 'schematic', sheet: sheet.id, rect };
  const info = k.setScope(scope) as ScopeInfo;
  return { k, info, scope };
}

describe('optimize scope', () => {
  it('splits the sheet into movable parts, anchored parts and the rest', () => {
    const { info } = setup();
    expect(info.free).toEqual(['C2', 'C4', 'C5', 'D1', 'L1', 'R1', 'R2', 'R3']);
    expect(info.context).toBe(4);
    expect(info.boundaryNets).toContain('SW');
    expect(info.boundaryNets).toContain('GND');
    expect(info.measures.crossings).toBeGreaterThanOrEqual(0);
  });

  it('anchors a part the edge cuts through', () => {
    const { info } = setup({ ...OUTPUT_SIDE, x: 5900, w: 3100 }); // cuts U1 (5080..6080)
    expect(info.anchored.map((a) => a.ref)).toContain('U1');
    expect(info.free).not.toContain('U1');
  });

  it('anchors a part a hard constraint fixes', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.transact({ summary: 'fix', ops: [{ op: 'constrain', kind: 'right_of', a: 'L1', b: 'C4', strength: 'hard' }] });
    const info = k.setScope({ view: 'schematic', sheet: k.state().view.sheets[0]!.id, rect: OUTPUT_SIDE }) as ScopeInfo;
    expect(info.anchored.find((a) => a.ref === 'L1')?.why).toMatch(/hard constraint/);
    expect(info.free).not.toContain('L1');
  });

  it('widens a view that holds a wire but no whole parts to the parts the wire leads to', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    const sheet = k.state().view.sheets[0]!;
    const net = k.draftDesign().nets;
    const id = Object.values(net).find((n) => n.name === '+12V')!.id;
    const pts = sheet.wires.find((w) => w.netId === id)!.pts;
    const rect = { x: Math.round((pts[0]! + pts[2]!) / 2) - 20, y: Math.round((pts[1]! + pts[3]!) / 2) - 20, w: 40, h: 40 };
    const info = k.setScope({ view: 'schematic', sheet: sheet.id, rect }) as ScopeInfo;
    expect(info.widened?.asked).toEqual(rect);
    expect(info.free).toEqual(expect.arrayContaining(['J1', 'U1', 'C1']));
    const r = info.scope.rect;
    expect(r.x).toBeLessThanOrEqual(rect.x);
    expect(r.x + r.w).toBeGreaterThanOrEqual(rect.x + rect.w);
    expect(r.w).toBeGreaterThan(rect.w);
  });

  it('does not widen a view that holds an area with nothing in it', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const r = k.setScope({ view: 'schematic', sheet: k.state().view.sheets[0]!.id, rect: { x: 100, y: 100, w: 300, h: 300 } });
    expect(r).toMatchObject({ error: expect.stringMatching(/no parts or connections/) });
  });

  it('allows a soft placement of a free part and reports measures and ripple', () => {
    const { k, info } = setup();
    const r = k.transact({ summary: 'move', dry_run: true, ops: [{ op: 'constrain', kind: 'above', a: 'D1', b: 'L1' }] });
    expect(r.status).toBe('ok');
    expect(r.scope?.baseline).toEqual(info.measures);
    expect(Array.isArray(r.scope?.ripple)).toBe(true);
    expect(r.scope?.ripple.every((ref) => !info.free.includes(ref))).toBe(true);
  });

  it('refuses to move a part outside the area, and lists the ones it may move', () => {
    const { k } = setup();
    const r = k.transact({ summary: 'move', ops: [{ op: 'constrain', kind: 'left_of', a: 'J1', b: 'L1' }] });
    expect(r.status).toBe('rejected');
    expect(r.rejection).toMatchObject({ code: 'OUT_OF_SCOPE' });
    expect(r.rejection?.candidates).toContain('L1');
    expect(k.hasPending()).toBe(false);
  });

  it('lets a free part be placed relative to a part outside the area only when that part is anchored', () => {
    const { k } = setup();
    const r = k.transact({ summary: 'move', ops: [{ op: 'constrain', kind: 'right_of', a: 'L1', b: 'U1' }] });
    expect(r.rejection).toMatchObject({ code: 'OUT_OF_SCOPE', message: expect.stringMatching(/U1 is outside the area/) });
  });

  it('refuses anything that changes the circuit or the design', () => {
    const { k } = setup();
    for (const op of [
      { op: 'connect', pins: ['R1.1', 'R3.1'], net: 'X' },
      { op: 'set_param', ref: 'R1', params: { resistance: '1k' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R9' },
      { op: 'remove', ref: 'C4' },
    ] as const) {
      const r = k.transact({ summary: 'x', ops: [op as never] });
      expect(r.rejection?.code, op.op).toBe('OUT_OF_SCOPE');
    }
  });

  it('adds soft constraints only', () => {
    const { k } = setup();
    const r = k.transact({ summary: 'x', ops: [{ op: 'constrain', kind: 'above', a: 'D1', b: 'L1', strength: 'hard' }] });
    expect(r.rejection).toMatchObject({ code: 'OUT_OF_SCOPE', message: expect.stringMatching(/soft/) });
  });

  it('lifts the restriction again', () => {
    const { k } = setup();
    k.setScope(null);
    const r = k.transact({ summary: 'x', dry_run: true, ops: [{ op: 'constrain', kind: 'left_of', a: 'J1', b: 'L1' }] });
    expect(r.status).toBe('ok');
    expect(r.scope).toBeUndefined();
  });

  it('knows the circuit by its parts, values and connections only', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const a = k.draftDesign();
    const sig = circuitSignature(a);
    k.transact({ summary: 'place', ops: [{ op: 'constrain', kind: 'above', a: 'D1', b: 'L1' }] });
    expect(circuitSignature(k.draftDesign())).toBe(sig);
    k.transact({ summary: 'value', ops: [{ op: 'set_param', ref: 'R1', params: { resistance: '33k' } }] });
    expect(circuitSignature(k.draftDesign())).not.toBe(sig);
  });
});
