import { describe, expect, it } from 'vitest';
import type { BoardPad, BoardPart, BoardRules, CopperLayer, Design } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { route } from '../src/router.ts';
import { buckTransaction } from './fixtures.ts';

const RULES: BoardRules = { clearance: 0.2, track: 0.25, powerTrack: 0.5, viaDrill: 0.3, viaPad: 0.6, edgeClearance: 0.5 };

/** A part with pads (1 × 1 mm on F.Cu, or h high) on the given nets. */
function part(refdes: string, pads: [number, number, string][], h = 1): BoardPart {
  const ps: BoardPad[] = pads.map(([x, y, netId], i) => ({ number: String(i + 1), x, y, w: 1, h, shape: 'rect', netId, layers: ['F.Cu'] }));
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
  it('when the tidy passes get stuck, routes on the grid (top horizontal, bottom vertical) to the last connection', () => {
    // two columns of pads, the right one in reverse order: every connection crosses every other
    const n = 12;
    const left = part('A', Array.from({ length: n }, (_, i) => [2, 2 + i, `N${i}`] as [number, number, string]), 0.6);
    const right = part('B', Array.from({ length: n }, (_, i) => [12, 2 + (n - 1 - i), `N${i}`] as [number, number, string]), 0.6);
    const last = new Map<number, { grid: boolean; open: number }>();
    const r = route({ outline: { w: 14, h: n + 3 }, layers: ['F.Cu', 'B.Cu'], rules: RULES, parts: [left, right], powerNets: new Set(), onProgress: (p) => last.set(p.pass, { grid: p.grid, open: p.connections - p.done }) });
    const passes = [...last.values()];
    expect(passes.some((p) => !p.grid && p.open > 0)).toBe(true);
    expect(passes.some((p) => p.grid)).toBe(true);
    expect(r.failed).toEqual([]);
  });

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

describe('connections the agent laid (draw_track with router copper)', () => {
  /** The track passes within 0.06 mm of (x, y) (on a corner or along a piece). */
  const passes = (tracks: { pts: number[] }[], x: number, y: number) =>
    tracks.some((t) => {
      for (let q = 0; q + 3 < t.pts.length; q += 2) {
        const [ax, ay, bx, by] = [t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!];
        const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
        const u = l2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2)) : 0;
        if (Math.hypot(ax + u * (bx - ax) - x, ay + u * (by - ay) - y) < 0.06) return true;
      }
      return false;
    });

  it('lays a connection through the points given, and routes the rest round it', () => {
    // A1 → A2 straight across; the agent sends it round the bottom, through (10, 7)
    const parts = [part('P1', [[3, 3, 'A']]), part('P2', [[17, 3, 'A']]), part('Q1', [[10, 1, 'B']]), part('Q2', [[10, 9.2, 'B']])];
    const pads = parts.flatMap((p) => p.pads);
    const input = { outline: { w: 20, h: 10.5 }, layers: ['F.Cu', 'B.Cu'] as CopperLayer[], rules: RULES, parts, powerNets: new Set<string>(), laid: [{ id: 't1', netId: 'A', from: 0, to: 1, layer: 'F.Cu' as const, points: [{ x: 10, y: 7 }] }] };
    const r = route(input);
    expect(r.laid).toEqual([{ id: 't1', laid: true }]);
    const mine = r.tracks.filter((t) => t.laid === 't1');
    expect(mine.length).toBe(1);
    expect(mine.every((t) => t.layer === 'F.Cu' && t.width === RULES.track)).toBe(true);
    expect(passes(mine, 10, 7)).toBe(true);
    expect(r.connected('A', pads[0]!, pads[1]!)).toBe(true);
    // B, from top to bottom, had to cross A: on the other layer
    expect(r.failed).toEqual([]);
    expect(r.tracks.filter((t) => t.netId === 'B').some((t) => t.layer === 'B.Cu')).toBe(true);
    // the same way every pass: the connection laid does not change when the router tries again
    const again = route(input, 1);
    expect(again.tracks.filter((t) => t.laid === 't1')).toEqual(mine);
  });

  it('changes layer at a point given a layer, with a via there', () => {
    const parts = [part('P1', [[3, 5, 'A']]), part('P2', [[17, 5, 'A']])];
    parts[1]!.pads[0]!.layers = ['B.Cu'];
    const r = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu', 'B.Cu'], rules: RULES, parts, powerNets: new Set(), laid: [{ id: 't1', netId: 'A', from: 0, to: 1, layer: 'F.Cu', points: [{ x: 8, y: 5, layer: 'B.Cu' }] }] });
    expect(r.laid).toEqual([{ id: 't1', laid: true }]);
    expect(r.vias.filter((v) => v.laid === 't1').map((v) => [v.x, v.y])).toEqual([[8, 5]]);
    expect(r.tracks.filter((t) => t.laid === 't1').map((t) => t.layer).sort()).toEqual(['B.Cu', 'F.Cu']);
  });

  it('one that finds no way is not laid: says why and where, and the router makes the connection', () => {
    // the point lies on a pad of another net
    const parts = [part('P1', [[3, 5, 'A']]), part('P2', [[17, 5, 'A']]), part('Q1', [[10, 8, 'B']]), part('Q2', [[15, 8, 'B']])];
    const pads = parts.flatMap((p) => p.pads);
    const r = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts, powerNets: new Set(), laid: [{ id: 't1', netId: 'A', from: 0, to: 1, points: [{ x: 10, y: 8 }] }] });
    expect(r.laid).toEqual([{ id: 't1', laid: false, why: '(10, 8) has no room for a 0.25 mm track: other copper is too close', at: { x: 10, y: 8 }, blockedBy: 'B' }]);
    expect(r.tracks.some((t) => t.laid)).toBe(false);
    expect(r.connected('A', pads[0]!, pads[1]!)).toBe(true);
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

