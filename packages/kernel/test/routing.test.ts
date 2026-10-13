import { describe, expect, it } from 'vitest';
import type { BoardPad, BoardPart, BoardRules, Design } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { route } from '../src/router.ts';
import { buckTransaction } from './fixtures.ts';

const RULES: BoardRules = { clearance: 0.2, track: 0.25, powerTrack: 0.5, viaDrill: 0.3, viaPad: 0.6, edgeClearance: 0.5 };

/** A two-pad part (pads 1 × 1 mm on F.Cu) with its pads on the given nets. */
function part(refdes: string, pads: [number, number, string][]): BoardPart {
  const ps: BoardPad[] = pads.map(([x, y, netId], i) => ({ number: String(i + 1), x, y, w: 1, h: 1, shape: 'rect', netId, layers: ['F.Cu'] }));
  const xs = ps.map((p) => p.x);
  const ys = ps.map((p) => p.y);
  return { componentId: refdes, refdes, x: 0, y: 0, rot: 0, pads: ps, courtyard: { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1, w: Math.max(...xs) - Math.min(...xs) + 2, h: Math.max(...ys) - Math.min(...ys) + 2 } } as unknown as BoardPart;
}

function buck() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k;
}

describe('routing to completion', () => {
  it('names the net in the way of a connection that cannot be made, and where', () => {
    // one layer: A must cross B, which runs from edge to edge first (it is shorter)
    // (every pad at an edge: neither can go round the other's end)
    const parts = [part('P1', [[0.5, 5, 'A']]), part('P2', [[19.5, 5, 'A']]), part('Q1', [[10, 0.5, 'B']]), part('Q2', [[10, 9.5, 'B']])];
    const passes: number[] = [];
    const r = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts, powerNets: new Set(), onProgress: (p) => passes.push(p.pass) });
    expect(r.failed).toHaveLength(1);
    const f = r.failed[0]!;
    expect(f.netId).toBe('A');
    expect(f.blockedBy).toEqual(['B']);
    expect(f.at?.layer).toBe('F.Cu');
    expect(Math.abs(f.at!.x - 10)).toBeLessThan(1);
    // it tried again (the history costs push B, which has nowhere else to go) and then gave up
    expect(r.passes).toBeGreaterThan(1);
    expect(r.timedOut).toBe(false);
    // the user saw every pass
    expect(new Set(passes).size).toBe(r.passes);
  });

  it('a pad closed in by other pads is reported as enclosed, not as blocked', () => {
    const ring: [number, number, string][] = [];
    for (const [dx, dy] of [[-1.2, -1.2], [0, -1.2], [1.2, -1.2], [-1.2, 0], [1.2, 0], [-1.2, 1.2], [0, 1.2], [1.2, 1.2]] as const) ring.push([10 + dx, 5 + dy, 'B']);
    const parts = [part('U1', [[10, 5, 'A'], ...ring]), part('P2', [[17, 5, 'A']])];
    const r = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts, powerNets: new Set() });
    const f = r.failed.find((x) => x.netId === 'A')!;
    expect(f.enclosed).toBe(true);
    expect(f.blockedBy).toBeUndefined();
  });

  it('necks a power track down to the signal width where only that fits', () => {
    // a wall of pads with a 0.8 mm gap: 0.5 mm + 2 × 0.2 mm clearance does not pass, 0.25 mm does
    const wall = (net: string, ys: number[]) => ys.map((y): [number, number, string] => [10, y, net]);
    const parts = [part('P1', [[3, 5, 'VCC']]), part('P2', [[17, 5, 'VCC']]), part('W1', wall('X', [0.5, 1.5, 2.5, 3.5])), part('W2', wall('Y', [5.3, 6.3, 7.3, 8.3, 9.3]))];
    const r = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts, powerNets: new Set(['VCC']) });
    expect(r.failed.filter((f) => f.netId === 'VCC')).toEqual([]);
    expect(r.tracks.filter((t) => t.netId === 'VCC').every((t) => t.width === RULES.track)).toBe(true);
  });
});

describe('the routed copper, kept with the design', () => {
  it('a routed design read back from its file is still routed (key order does not matter)', () => {
    const k = buck();
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    k.accept();
    const back = new Kernel(JSON.parse(k.exportDesign()) as Design);
    expect(back.boardPlacement().placementKey).toBe(k.boardPlacement().placementKey);
    expect(back.boardPlacement().routing).toBe('done');
  });

  it('routes once: the design keeps the copper, and a reload shows it without routing again', () => {
    const k = buck();
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    k.accept();
    const first = k.board();
    expect(first.newCopper).toBeDefined();
    expect(first.unrouted).toEqual([]);
    // the app keeps it: no change to review, but the committed design has it
    expect(k.keepCopper(first.newCopper!)).toBe(true);
    expect(k.hasPending()).toBe(false);
    const saved = JSON.parse(k.exportDesign()) as Design;
    expect(saved.board?.copper?.key).toBe(first.newCopper!.key);

    const again = new Kernel(saved).board();
    expect(again.newCopper).toBeUndefined();
    expect(again.tracks).toEqual(first.tracks);
    expect(again.stats).toEqual(first.stats);
    expect(again.ratsnest).toEqual([]);
    expect(again.diagnostics).toEqual(first.diagnostics);
  });

  it('is not used once the placement changes, and is not kept for another placement', () => {
    const k = buck();
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    k.accept();
    const copper = k.board().newCopper!;
    const r1 = k.board().parts.find((p) => p.refdes === 'R1')!;
    k.transact({ summary: 'move', ops: [{ op: 'place', ref: 'R1', x_mm: r1.x + 2, y_mm: r1.y }] });
    expect(k.board().routing).toBe('stale');
    expect(k.board().tracks).toEqual([]);
    // the draft no longer matches; the committed design (not moved) still takes it
    expect(k.keepCopper(copper)).toBe(true);
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.routing).toBe('done');
    expect(b.newCopper?.key).not.toBe(copper.key);
  });
});

describe('placement measures', () => {
  it('a part moved away from what it connects to makes the ratsnest longer', () => {
    const k = buck();
    const before = k.board().measures;
    expect(before.ratsnestMm).toBeGreaterThan(0);
    const b = k.board();
    const c = b.parts.find((p) => p.refdes === 'C1')!;
    k.transact({ summary: 'move', ops: [{ op: 'place', ref: 'C1', x_mm: b.outline.w - 2, y_mm: b.outline.h - 2 }] });
    expect(k.board().measures.ratsnestMm).toBeGreaterThan(before.ratsnestMm);
    expect(c).toBeDefined();
  });
});

describe('stopping the routing', () => {
  it('the best pass so far is offered from the start (nothing routed) and after every better pass', () => {
    const parts = [part('P1', [[0.5, 5, 'A']]), part('P2', [[19.5, 5, 'A']]), part('Q1', [[10, 0.5, 'B']]), part('Q2', [[10, 9.5, 'B']])];
    const best: { passes: number; open: number; tracks: number }[] = [];
    route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts, powerNets: new Set(), onBest: (r) => best.push({ passes: r.passes, open: r.failed.length, tracks: r.tracks.length }) });
    expect(best[0]).toEqual({ passes: 0, open: 2, tracks: 0 });
    expect(best[1]!.passes).toBe(1);
    expect(best[1]!.open).toBe(1);
  });

  it('keeps the stopped pass as the routing, says so, and route starts again from scratch', () => {
    const k = buck();
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    k.accept();
    // the board worker's view of it: stopped before the first pass finished
    let first: import('@4k7/schema').StoredCopper | null = null;
    new Kernel(JSON.parse(k.exportDesign()) as Design).board({ onBest: (c) => (first ??= c) });
    expect(first!.stopped).toBe(true);
    expect(first!.passes).toBe(0);
    expect(k.keepCopper(first!)).toBe(true);
    const stopped = k.board();
    expect(stopped.stopped).toBe(true);
    expect(stopped.tracks).toEqual([]);
    expect(stopped.unrouted.length).toBeGreaterThan(0);
    expect(stopped.diagnostics.some((d) => d.code === 'DRC.ROUTING_INCOMPLETE' && /stopped/.test(d.message))).toBe(true);
    // route again: the stopped copper goes, the board is routed afresh
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const again = k.board();
    expect(again.stopped).toBeUndefined();
    expect(again.unrouted).toEqual([]);
    expect(again.newCopper?.stopped).toBeUndefined();
  });
});

