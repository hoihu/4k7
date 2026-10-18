import { describe, expect, it } from 'vitest';
import type { BoardPad, BoardPart, BoardRules, BoardView, Track } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { keptCopper } from '../src/keep.ts';
import { route, type RouteInput } from '../src/router.ts';
import { buckTransaction } from './fixtures.ts';

const RULES: BoardRules = { clearance: 0.2, track: 0.25, powerTrack: 0.5, viaDrill: 0.3, viaPad: 0.6, edgeClearance: 0.5 };

/** A part with 1 × 1 mm pads on F.Cu on the given nets. */
function part(refdes: string, pads: [number, number, string][]): BoardPart {
  const ps: BoardPad[] = pads.map(([x, y, netId], i) => ({ number: String(i + 1), x, y, w: 1, h: 1, shape: 'rect', netId, layers: ['F.Cu'] }));
  const xs = ps.map((p) => p.x);
  const ys = ps.map((p) => p.y);
  return { componentId: refdes, refdes, x: 0, y: 0, rot: 0, pads: ps, courtyard: { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1, w: Math.max(...xs) - Math.min(...xs) + 2, h: Math.max(...ys) - Math.min(...ys) + 2 } } as unknown as BoardPart;
}

const board = (parts: BoardPart[], more: Partial<RouteInput> = {}): RouteInput => ({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts, powerNets: new Set(), ...more });
const track = (netId: string, pts: number[], width = 0.25): Track => ({ netId, layer: 'F.Cu', width, pts });
const errors = (b: BoardView) => b.diagnostics.filter((x) => x.severity === 'error' && !x.waivedBy).map((x) => x.message);

/** The buck, routed, with the copper kept in the design (as the app does). */
function routedBuck() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.transact({ summary: 'route', ops: [{ op: 'route' }] });
  k.accept();
  const first = k.board();
  k.keepCopper(first.newCopper!);
  return { k, first };
}

describe('what of the routing before still holds', () => {
  it('keeps a track whose pads stay, drops one whose pad moved away', () => {
    const before = [track('A', [2, 2, 8, 2]), track('B', [2, 6, 8, 6])];
    const kept = keptCopper(board([part('P', [[2, 2, 'A'], [2, 6, 'B']]), part('Q', [[8, 2, 'A'], [12, 6, 'B']])]), { tracks: before, vias: [] });
    expect(kept.tracks).toEqual([before[0]]);
    expect(kept.pieces).toEqual([{ netId: 'A', pads: [0, 2], tracks: [0], vias: [], drops: [] }]);
  });

  it('drops a track that a moved pad of another net now comes too close to', () => {
    const before = [track('A', [2, 2, 12, 2])];
    // C's pad now comes 0.1 mm from A's track (the clearance is 0.2); 0.3 mm is fine
    const at = (y: number) => keptCopper(board([part('P', [[2, 2, 'A'], [12, 2, 'A']]), part('Q', [[7, y, 'C']])]), { tracks: before, vias: [] }).tracks;
    expect(at(2.725)).toEqual([]);
    expect(at(2.925)).toEqual(before);
  });

  it('what a dropped track leaves hanging goes with it: the via, the track on the other side', () => {
    const before = [track('A', [2, 2, 6, 2]), { ...track('A', [6, 2, 6, 8]), layer: 'B.Cu' as const }, track('A', [6, 8, 9, 8])];
    const vias = [{ netId: 'A', x: 6, y: 2, drill: 0.3, pad: 0.6 }, { netId: 'A', x: 6, y: 8, drill: 0.3, pad: 0.6 }];
    const parts = (x: number) => [part('P', [[2, 2, 'A']]), part('Q', [[x, 8, 'A']])];
    const input = (x: number) => board(parts(x), { layers: ['F.Cu', 'B.Cu'] });
    expect(keptCopper(input(9), { tracks: before, vias }).tracks).toHaveLength(3);
    // Q moved: its stub hangs, then the via before it, then the track on B.Cu, and so on back to P
    const kept = keptCopper(input(12), { tracks: before, vias });
    expect(kept.tracks).toEqual([]);
    expect(kept.vias).toEqual([]);
  });

  it('keeps a pad\'s drop to its plane (a stub and a via), and counts it as that pad\'s own', () => {
    const before = [track('GND', [2, 2, 3.5, 2])];
    const vias = [{ netId: 'GND', x: 3.5, y: 2, drill: 0.3, pad: 0.6 }];
    const input = board([part('P', [[2, 2, 'GND']])], { layers: ['F.Cu', 'B.Cu'], planes: [{ netId: 'GND', layer: 'B.Cu' }] });
    const kept = keptCopper(input, { tracks: before, vias });
    expect(kept.pieces).toEqual([{ netId: 'GND', pads: [0], tracks: [0], vias: [0], drops: [{ pad: 0, x: 3.5, y: 2 }] }]);
    // without the plane the same copper joins nothing
    expect(keptCopper({ ...input, planes: [] }, { tracks: before, vias }).tracks).toEqual([]);
  });
});

describe('the router keeps the copper that holds and routes the rest', () => {
  it('routes only what is open, around the kept copper', () => {
    const parts = [part('P', [[2, 2, 'A'], [2, 6, 'B']]), part('Q', [[18, 2, 'A'], [18, 6, 'B']])];
    const first = route(board(parts));
    expect(first.failed).toEqual([]);
    const a = first.tracks.filter((t) => t.netId === 'A');
    // B's far pad moves; A's track stays exactly as it was
    const moved = [parts[0]!, part('Q', [[18, 2, 'A'], [18, 8, 'B']])];
    const again = route(board(moved, { keep: { tracks: first.tracks, vias: first.vias } }));
    expect(again.failed).toEqual([]);
    expect(again.tracks.filter((t) => t.netId === 'A')).toEqual(a);
    expect(again.reused).toEqual({ tracks: a.length, vias: 0 });
  });

  it('kept copper in the way of an open connection is routed again', () => {
    // A's kept track runs round B's first pad in a U, its pads too close to the edge to pass: on
    // one layer B cannot get out
    const parts = [part('P', [[1.2, 2, 'A'], [10, 4, 'B']]), part('Q', [[18.8, 2, 'A'], [10, 9, 'B']])];
    const u = track('A', [1.2, 2, 1.2, 7, 18.8, 7, 18.8, 2]);
    const r = route(board(parts, { keep: { tracks: [u], vias: [] } }));
    expect(r.failed).toEqual([]);
    expect(r.tracks).not.toContainEqual(u);
    expect(r.passes).toBeGreaterThan(1);
  });
});

describe('incremental routing in the design', () => {
  it('a part moved: the nets it does not touch keep their copper, the board is routed to 100 % and clean', () => {
    const { k, first } = routedBuck();
    expect(first.newCopper!.basis).toBeDefined();
    const r3 = first.parts.find((p) => p.refdes === 'R3')!;
    const touched = new Set(r3.pads.map((p) => p.netId));
    k.transact({ summary: 'move', ops: [{ op: 'place', ref: 'R3', x_mm: r3.x + 1, y_mm: r3.y }, { op: 'route' }] });
    const b = k.board();
    expect(b.unrouted).toEqual([]);
    expect(errors(b)).toEqual([]);
    expect(b.newCopper!.reused!.tracks).toBeGreaterThan(0);
    const json = new Set(b.tracks.map((t) => JSON.stringify(t)));
    const untouched = first.tracks.filter((t) => !touched.has(t.netId));
    const stayed = untouched.filter((t) => json.has(JSON.stringify(t)));
    expect(stayed.length).toBeGreaterThan(untouched.length / 2);
  });

  it('a net whose width changed is routed again; another board (rules) is routed afresh', () => {
    const { k, first } = routedBuck();
    const r1 = first.parts.find((p) => p.refdes === 'R1')!;
    const net = first.netNames[r1.pads[0]!.netId!]!;
    k.transact({ summary: 'wider', ops: [{ op: 'set_net', net, track_mm: 0.4 }, { op: 'route' }] });
    const b = k.board();
    expect(b.unrouted).toEqual([]);
    expect(b.newCopper!.reused!.tracks).toBeGreaterThan(0);
    expect(b.tracks.filter((t) => t.netId === r1.pads[0]!.netId).every((t) => t.width === 0.4)).toBe(true);
    k.accept();
    k.keepCopper(b.newCopper!);
    k.transact({ summary: 'rules', ops: [{ op: 'set_board', clearance_mm: 0.25 }, { op: 'route' }] });
    expect(k.board().newCopper!.reused).toBeUndefined();
  });
});

describe('ties: vias where a supply\'s current crosses to another layer, as many as it needs', () => {
  it('plans a tight block round the spot, sized for the current, with spares round it', async () => {
    const { planVias } = await import('../src/board.ts');
    const plan = planVias([{ id: 'V1', netId: 'P', kind: 'tie', points: [[10, 5]], amps: 3 }], [], 20, 10, RULES);
    expect(plan.limits).toEqual({ V1: 4 }); // 3 A at about 0.9 A per 0.3 mm via
    expect(plan.groups[0]).toMatchObject({ id: 'V1', kind: 'tie', wanted: 4 });
    expect(plan.groups[0]!.note).toContain('4 for 3 A');
    // the first four: a 2 × 2 block 0.8 mm apart round the spot; then the ring round it
    expect(plan.fill.slice(0, 4).map((v) => [v.x, v.y]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)).toEqual([[9.6, 4.6], [9.6, 5.4], [10.4, 4.6], [10.4, 5.4]]);
    expect(plan.fill.length).toBe(16);
    // without a current: two, and it says why
    const two = planVias([{ id: 'V1', netId: 'P', kind: 'tie', points: [[10, 5]] }], [], 20, 10, RULES);
    expect(two.limits).toEqual({ V1: 2 });
    expect(two.groups[0]!.note).toContain('no current known');
    // the net's max_current when the tie has none
    expect(planVias([{ id: 'V1', netId: 'P', kind: 'tie', points: [[10, 5]] }], [], 20, 10, RULES, () => 5).limits).toEqual({ V1: 6 });
  });

  it('a grid over a supply\'s copper says when it is far more than the current needs', async () => {
    const { planVias } = await import('../src/board.ts');
    const plan = planVias([{ id: 'V1', netId: 'P', kind: 'grid', area: { rect: [0, 0, 20, 10] } }], [], 20, 10, RULES, () => 2);
    expect(plan.groups[0]!.note).toMatch(/^\d+ spots carry about \d+ A; the net draws 2 A, which 3 vias carry: a tie/);
    expect(planVias([{ id: 'V1', netId: 'P', kind: 'grid', area: { rect: [0, 0, 20, 10] } }], [], 20, 10, RULES).groups[0]!.note).toBeUndefined();
  });

  it('lays the vias on a wide track of the net over its plane, no more than the current wants', async () => {
    const { planVias } = await import('../src/board.ts');
    // P runs as a 2 mm track on F.Cu (kept from before) and has a pour on B.Cu
    const parts = [part('A', [[2, 5, 'P']]), part('B', [[18, 5, 'P']])];
    const wide = track('P', [2, 5, 18, 5], 2);
    const plan = planVias([{ id: 'V1', netId: 'P', kind: 'tie', points: [[10, 5]], amps: 3 }], parts, 20, 10, RULES);
    const r = route(board(parts, { layers: ['F.Cu', 'B.Cu'], planes: [{ netId: 'P', layer: 'B.Cu' }], netWidths: { P: 2 }, keep: { tracks: [wide], vias: [] }, vias: plan }));
    const tie = r.vias.filter((v) => v.group === 'V1');
    expect(tie).toHaveLength(4);
    // all on the track (wholly inside its copper), close together round the spot
    expect(tie.every((v) => Math.abs(v.y - 5) <= 1 - 0.3 && Math.abs(v.x - 10) <= 0.8)).toBe(true);
  });

  it('add_vias tie: the vias its current wants, in the effect and in get_board', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const r = k.transact({ summary: 'tie', ops: [{ op: 'set_net', net: '+12V', max_current: 2 }, { op: 'add_vias', kind: 'tie', net: '+12V', at: [{ x_mm: 5, y_mm: 5 }] }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(r.results?.[1]?.effect).toContain('V1: +12V tie at (5, 5): 3 vias for 2 A');
    expect(k.board().viaGroups).toEqual([{ id: 'V1', netId: expect.any(String), kind: 'tie', wanted: 3, note: expect.stringContaining('3 for 2 A') }]);
    expect(k.transact({ summary: 'bad', ops: [{ op: 'add_vias', kind: 'tie', net: '+12V', at: [{ x_mm: 5, y_mm: 5 }, { x_mm: 6, y_mm: 5 }] }] }).status).toBe('rejected');
  });
});
