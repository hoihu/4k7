import { describe, expect, it } from 'vitest';
import { EditOp, OPTIMIZE_OPS, type LabelView, type OptimizeScope, type ScopeInfo, type SheetView, type SymbolView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { circuitSignature, guardOp, measure, resolveScope } from '../src/scope.ts';
import { wireShape } from '../src/sheetmeasures.ts';
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

  it('lets through no op but those the prompt names', () => {
    const { k, info } = setup();
    const d = k.draftDesign();
    const sc = resolveScope(d, k.state().view, info.scope);
    if ('error' in sc) throw new Error(sc.error);
    for (const name of EditOp.options.map((o) => o.shape.op.value)) {
      if ((OPTIMIZE_OPS as readonly string[]).includes(name)) continue;
      expect(() => guardOp(d, { op: name } as never, sc), name).toThrow(/changes more than how this area is drawn/);
    }
  });

  it('lets place_symbol put a movable part exactly, and refuses it for a part outside the area', () => {
    const { k } = setup();
    expect(k.transact({ summary: 'place', dry_run: true, ops: [{ op: 'place_symbol', ref: 'D1', x: 7000, y: 3500 }] }).status).toBe('ok');
    const r = k.transact({ summary: 'place', dry_run: true, ops: [{ op: 'place_symbol', ref: 'J1', x: 7000, y: 3500 }] });
    expect(r.rejection).toMatchObject({ code: 'OUT_OF_SCOPE' });
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

describe('optimize measures: how the wires are drawn', () => {
  /** A vertical two-pin part with its pins at (x, top) and (x, top + 400). */
  const vertical = (ref: string, x: number, top: number) =>
    ({ componentId: ref, refdes: ref, value: '', bbox: { x: x - 100, y: top, w: 200, h: 400 }, prims: [], pins: [{ number: '1', name: '1', x, y: top, side: 'top', showName: false, showNumber: false }, { number: '2', name: '2', x, y: top + 400, side: 'bottom', showName: false, showNumber: false }], refPos: { x, y: top, anchor: 'start' }, valuePos: { x, y: top, anchor: 'start' } }) as SymbolView;
  const sheet = (wires: number[][], symbols: SymbolView[] = []) => ({ id: 's', name: 'Main', symbols, wires: wires.map((pts) => ({ netId: 'n', pts })), labels: [], junctions: [], noConnects: [], pages: [] }) as unknown as SheetView;
  const m = (s: SheetView) => measure(s, new Set(['n']));

  it('counts a corner as a bend, not a straight run or a T', () => {
    expect(m(sheet([[0, 0, 1000, 0]])).bends).toBe(0);
    expect(m(sheet([[0, 0, 1000, 0, 1000, 500]])).bends).toBe(1);
    expect(m(sheet([[0, 0, 1000, 0], [1000, 0, 1000, 500]])).bends).toBe(1); // two wires meeting at a corner
    expect(m(sheet([[0, 0, 1000, 0], [500, 0, 500, 500]])).bends).toBe(0); // a T
  });

  it('tells a wire that doubles back (a U) from one that steps across (a Z)', () => {
    const u = m(sheet([[0, 0, 0, -300, 500, -300, 500, 0]]));
    expect(u).toMatchObject({ bends: 2, detours: 1 });
    const z = m(sheet([[0, 0, 0, -300, 500, -300, 500, -600]]));
    expect(z).toMatchObject({ bends: 2, detours: 0 });
    // a U with a tap on its sideways run is a bus
    expect(m(sheet([[0, 0, 0, -300, 500, -300, 500, 0], [250, -300, 250, -600]])).detours).toBe(0);
  });

  it('takes a U with something on its straight way for how the wire gets past it, not for a detour', () => {
    // from a connector to an IC on one level (CC1 on a USB-C input), over what stands between them
    const over = [6000, 1900, 4700, 1900, 4700, 1100, 2600, 1100, 2600, 1900, 2500, 1900];
    expect(m(sheet([over]))).toMatchObject({ bends: 4, detours: 1 });
    const also = (s: Partial<SheetView>) => m({ ...sheet([over]), ...s });
    // a part
    expect(m(sheet([over], [vertical('R16', 3800, 1700)]))).toMatchObject({ bends: 4, detours: 0 });
    // a wire of another net, across the way or ending on it
    const other = (pts: number[]) => ({ wires: [{ netId: 'n', pts: over }, { netId: 'o', pts }] });
    expect(also(other([3000, 1500, 3000, 2500])).detours).toBe(0);
    expect(also(other([3000, 1900, 3000, 2500])).detours).toBe(0);
    expect(also(other([3000, 2000, 3000, 2500])).detours).toBe(1);
    // a pin this net's wires do not reach
    expect(m(sheet([over], [vertical('R16', 3800, 1900)])).detours).toBe(0);
    // a label of another net, not one of its own
    const flag = (netId: string): LabelView => ({ x: 3000, y: 1800, text: 'X', netId, kind: 'net', dir: 'down' });
    expect(also({ labels: [flag('o')] }).detours).toBe(0);
    expect(also({ labels: [flag('n')] }).detours).toBe(1);
    // a part beside the way, or under the top of the U and clear of the way
    expect(m(sheet([over], [vertical('R16', 3800, 2000)])).detours).toBe(1);
    expect(m(sheet([over], [vertical('R16', 3800, 1300)])).detours).toBe(1);
  });

  it('slides a U back only as far as its shorter leg, and the wire may end on its own pin there', () => {
    // from the left, round a load cap and down onto its top pin: round the cap it has to go, the hop onto the pin it has not
    const s = sheet([[10500, 5400, 9600, 5400, 9600, 4700, 9900, 4700, 9900, 4800]], [vertical('C27', 9900, 4800)]);
    expect(wireShape(s, 'n')).toMatchObject({ uTurns: [[9600, 5400, 9600, 4700], [9600, 4700, 9900, 4700]], detours: [[9600, 4700, 9900, 4700]] });
  });

  it('overlaps: a supply head on a wire, a stem along one, names touching, text; not a stem merely crossing', () => {
    // a rail on a left pin at (1000, 300), standing up after a 100 stub: stem 900 x 100..300, arrow and name above 100
    const rail = (l: Partial<LabelView> = {}): LabelView => ({ x: 1000, y: 300, text: 'VIN', netId: 'n', kind: 'rail', dir: 'up', stub: 'left', stubLen: 100, ...l });
    const withWire = (pts: number[], labels: LabelView[] = [rail()]): SheetView => ({ ...sheet([]), wires: [{ netId: 'sig', pts }], labels });
    expect(m(withWire([1000, 200, 0, 200])).overlaps).toBe(0); // crosses the stem: acceptable, the symbol stands upright
    expect(m(withWire([1000, 50, 0, 50])).overlaps).toBe(1); // under the arrow
    expect(m(withWire([900, 400, 900, 0])).overlaps).toBe(1); // along the stem: reads as connected
    const gnd = rail({ y: 500, text: 'GND', kind: 'ground', dir: 'down' });
    expect(m(withWire([1000, 620, 0, 620], [gnd])).overlaps).toBe(1); // through the ground bars
    // two rails whose names stand side by side without air
    const neighbour = rail({ x: 1000, y: 400, text: 'AVIN', stubLen: 300, rise: 100 });
    expect(m(withWire([5000, 5000, 5000, 5001], [rail(), neighbour])).overlaps).toBe(2);
    expect(m(withWire([5000, 5000, 5000, 5001], [rail(), { ...neighbour, rise: 300 }])).overlaps).toBe(0); // staggered
    // the name running into a part's text
    const part = { ...vertical('U1', 3000, 3000), refPos: { x: 900, y: 0, anchor: 'start' as const } };
    expect(m({ ...withWire([5000, 5000, 5000, 5001]), symbols: [part] }).overlaps).toBe(1);
  });

  it('judges each drawing of a net on its own: no jog between pins on wires that do not meet', () => {
    // C8 and R5 on one VOUT wire at the bottom of the sheet; L1 hanging on its own VOUT lead far away
    const apart = sheet([[0, 0, 500, 0], [3000, -1000, 3000, -600]], [vertical('C8', 0, 0), vertical('R5', 500, 0), vertical('L1', 3000, -1400)]);
    expect(m(apart).jogs).toBe(0);
    const joined = sheet([[0, 0, 500, 0], [3000, -1000, 3000, 0, 500, 0]], [vertical('C8', 0, 0), vertical('R5', 500, 0), vertical('L1', 3000, -1400)]);
    expect(m(joined).jogs).toBe(1);
  });

  it('takes a supply symbol at a wire end as an attachment: a two-pin bus with its symbol at the corner is no detour', () => {
    const s: SheetView = { ...sheet([[100, 0, 0, 0], [100, 100, 0, 100], [0, 0, 0, 100]]), labels: [{ x: 0, y: 0, text: 'VDDA', netId: 'n', kind: 'rail', dir: 'up' }] };
    expect(m(s)).toMatchObject({ bends: 1, detours: 0 });
  });

  it('counts a divider drawn side by side as a jog, and none when it is stacked', () => {
    // R1 from 3500 to 3900 at x 5300, R2 hanging from the same node wire at x 4900
    expect(m(sheet([[5800, 3900, 4900, 3900]], [vertical('R1', 5300, 3500), vertical('R2', 4900, 3900)])).jogs).toBe(1);
    expect(m(sheet([[5800, 3900, 5300, 3900]], [vertical('R1', 5300, 3500), vertical('R2', 5300, 3900)])).jogs).toBe(0);
  });

  it('scores the buck the layout draws: no detour or overlap, and the switch node step as a jog', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    const sheet = k.state().view.sheets[0]!;
    const info = k.setScope({ view: 'schematic', sheet: sheet.id, rect: OUTPUT_SIDE }) as ScopeInfo;
    // the ground bus under the parts turns up at both ends, but its taps make it a bus, not a detour
    expect(info.measures.detours).toBe(0);
    // the one jog is real: U1's SW pin is lower than L1, so the switch node steps up to it
    expect(info.measures.jogs).toBe(1);
    expect(info.measures.overlaps).toBe(0);
  });
});
