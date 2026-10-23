import { describe, expect, it } from 'vitest';
import type { BoardPad, BoardPart, BoardRules, BoardView, Design } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { narrowTrackDrc } from '../src/drc.ts';
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

describe('a net wider than its pads', () => {
  const pad = (number: string, x: number, y: number, w: number, h: number, netId: string): BoardPad => ({ number, x, y, w, h, shape: 'rect', netId, layers: ['F.Cu'] });
  const chip = (refdes: string, pads: BoardPad[]) => {
    const xs = pads.map((p) => p.x);
    const ys = pads.map((p) => p.y);
    return { componentId: refdes, refdes, x: 0, y: 0, rot: 0, pads, courtyard: { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1, w: Math.max(...xs) - Math.min(...xs) + 2, h: Math.max(...ys) - Math.min(...ys) + 2 } } as unknown as BoardPart;
  };
  /** Length of the net's track per width (mm), rounded to 0.01 mm widths. */
  const lengths = (tracks: { netId: string; width: number; pts: number[] }[], net: string) => {
    const out = new Map<number, number>();
    for (const t of tracks) {
      if (t.netId !== net) continue;
      let len = 0;
      for (let q = 0; q + 3 < t.pts.length; q += 2) len += Math.hypot(t.pts[q + 2]! - t.pts[q]!, t.pts[q + 3]! - t.pts[q + 1]!);
      const w = Math.round(t.width * 100) / 100;
      out.set(w, (out.get(w) ?? 0) + len);
    }
    return out;
  };
  /** Every track keeps the clearance from every pad of another net (checked along its pieces). */
  const clearOfPads = (r: { tracks: { netId: string; width: number; layer: string; pts: number[] }[] }, parts: BoardPart[], clearance: number) => {
    for (const t of r.tracks) {
      for (const p of parts.flatMap((x) => x.pads)) {
        if (p.netId === t.netId || !p.layers.includes(t.layer as 'F.Cu')) continue;
        for (let q = 0; q + 3 < t.pts.length; q += 2) {
          for (let s = 0; s <= 200; s++) {
            const x = t.pts[q]! + ((t.pts[q + 2]! - t.pts[q]!) * s) / 200;
            const y = t.pts[q + 1]! + ((t.pts[q + 3]! - t.pts[q + 1]!) * s) / 200;
            const gap = Math.hypot(Math.max(Math.abs(x - p.x) - p.w / 2, 0), Math.max(Math.abs(y - p.y) - p.h / 2, 0)) - t.width / 2;
            expect(gap).toBeGreaterThanOrEqual(clearance - 1e-3);
          }
        }
      }
    }
  };

  it('runs at the net\'s width and narrows only near the pads that cannot take it', () => {
    // a 1.2 mm net between two 0.6 mm pads, 16 mm apart: before, the whole track came out at the
    // widest width both pads take (0.5 mm)
    const parts = [chip('U1', [pad('1', 2, 5, 0.6, 0.6, 'P')]), chip('U2', [pad('1', 18, 5, 0.6, 0.6, 'P')])];
    const r = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts, powerNets: new Set(['P']), netWidths: { P: 1.2 } });
    expect(r.failed).toEqual([]);
    const len = lengths(r.tracks, 'P');
    expect(len.get(1.2) ?? 0).toBeGreaterThan(12);
    // the necks: short, at the widest width the pads take
    expect([...len.keys()].sort()).toEqual([0.5, 1.2]);
    expect(len.get(0.5)!).toBeLessThan(4);
    // the pieces meet: one connected track from pad to pad
    expect(r.connected('P', parts[0]!.pads[0]!, parts[1]!.pads[0]!)).toBe(true);
    clearOfPads(r, parts, RULES.clearance);
  });

  it('a power net leaves a fine-pitch pin narrow, between its neighbours, and widens clear of them', () => {
    // a QFN-like row (0.25 × 0.8 mm pads, 0.5 mm pitch), the middle pin on the power net: its pad
    // cannot take the 0.5 mm power track, and none passes between its neighbours (before: the
    // whole track at the signal width)
    const row = chip('U1', [8.5, 9, 9.5, 10, 10.5, 11, 11.5].map((x, i) => pad(String(i + 1), x, 5, 0.25, 0.8, x === 10 ? 'VCC' : `S${i}`)));
    const far = chip('C1', [pad('1', 10, 16, 1, 1, 'VCC')]);
    const parts = [row, far];
    const r = route({ outline: { w: 20, h: 20 }, layers: ['F.Cu'], rules: RULES, parts, powerNets: new Set(['VCC']) });
    expect(r.failed.filter((f) => f.netId === 'VCC')).toEqual([]);
    const len = lengths(r.tracks, 'VCC');
    expect(len.get(0.5) ?? 0).toBeGreaterThan(8);
    expect(len.get(0.25) ?? 0).toBeLessThan(3);
    expect(r.connected('VCC', row.pads[3]!, far.pads[0]!)).toBe(true);
    clearOfPads(r, parts, RULES.clearance);
  });

  it('warns where a track runs narrower than its net for more than a neck', () => {
    // the wall of the neck-down test: the power track goes through it at the signal width
    const wall = (net: string, ys: number[]) => ys.map((y): [number, number, string] => [10, y, net]);
    const parts = [part('P1', [[3, 5, 'VCC']]), part('P2', [[17, 5, 'VCC']]), part('W1', wall('X', [0.5, 1.5, 2.5, 3.5])), part('W2', wall('Y', [5.3, 6.3, 7.3, 8.3, 9.3]))];
    const r = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts, powerNets: new Set(['VCC']) });
    const view = { parts, tracks: r.tracks, netNames: { VCC: '+5V' } } as unknown as BoardView;
    const want = (id: string) => (id === 'VCC' ? { width: 0.5, why: 'the power width' } : undefined);
    const [w, ...more] = narrowTrackDrc(view, want);
    expect(more).toEqual([]);
    expect(w!.code).toBe('DRC.NARROW_TRACK');
    expect(w!.message).toMatch(/of \+5V runs at 0\.25 mm, below its 0\.5 mm \(the power width\) \(P[12]\.1 → P[12]\.1\)/);
    expect(w!.entities.sort()).toEqual(['P1', 'P2']);
    // a neck into a pad is no warning
    const necked = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts: [chip('U1', [pad('1', 2, 5, 0.6, 0.6, 'P')]), chip('U2', [pad('1', 18, 5, 0.6, 0.6, 'P')])], powerNets: new Set(['P']), netWidths: { P: 1.2 } });
    expect(narrowTrackDrc({ parts: [], tracks: necked.tracks, netNames: {} } as unknown as BoardView, () => ({ width: 1.2, why: 'set for the net' }))).toEqual([]);
  });
});

describe('tracks the agent laid', () => {
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
    // A1 → A2 straight across; the agent sends it round the bottom, through (10, 8)
    const parts = [part('P1', [[3, 3, 'A']]), part('P2', [[17, 3, 'A']]), part('Q1', [[10, 1, 'B']]), part('Q2', [[10, 9.2, 'B']])];
    const pads = parts.flatMap((p) => p.pads);
    const r = route({ outline: { w: 20, h: 10.5 }, layers: ['F.Cu', 'B.Cu'], rules: RULES, parts, powerNets: new Set(), drawn: [{ id: 'T1', netId: 'A', from: 0, to: 1, layer: 'F.Cu', points: [{ x: 10, y: 7 }] }] });
    expect(r.drawn).toEqual([{ id: 'T1', laid: true }]);
    const mine = r.tracks.filter((t) => t.drawn === 'T1');
    expect(mine.length).toBe(1);
    expect(mine.every((t) => t.layer === 'F.Cu' && t.width === RULES.track)).toBe(true);
    expect(passes(mine, 10, 7)).toBe(true);
    expect(r.connected('A', pads[0]!, pads[1]!)).toBe(true);
    // B, from top to bottom, had to cross A: on the other layer
    expect(r.failed).toEqual([]);
    expect(r.tracks.filter((t) => t.netId === 'B').some((t) => t.layer === 'B.Cu')).toBe(true);
    // the same way every pass: the tracks laid by hand do not change when the router tries again
    const again = route({ outline: { w: 20, h: 10.5 }, layers: ['F.Cu', 'B.Cu'], rules: RULES, parts, powerNets: new Set(), drawn: [{ id: 'T1', netId: 'A', from: 0, to: 1, layer: 'F.Cu', points: [{ x: 10, y: 7 }] }] }, 1);
    expect(again.tracks.filter((t) => t.drawn === 'T1')).toEqual(mine);
  });

  it('changes layer at a point given a layer, with a via there', () => {
    const parts = [part('P1', [[3, 5, 'A']]), part('P2', [[17, 5, 'A']])];
    parts[1]!.pads[0]!.layers = ['B.Cu'];
    const r = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu', 'B.Cu'], rules: RULES, parts, powerNets: new Set(), drawn: [{ id: 'T1', netId: 'A', from: 0, to: 1, layer: 'F.Cu', points: [{ x: 8, y: 5, layer: 'B.Cu' }] }] });
    expect(r.drawn).toEqual([{ id: 'T1', laid: true }]);
    expect(r.vias.filter((v) => v.drawn === 'T1').map((v) => [v.x, v.y])).toEqual([[8, 5]]);
    expect(r.tracks.filter((t) => t.drawn === 'T1').map((t) => t.layer).sort()).toEqual(['B.Cu', 'F.Cu']);
  });

  it('one that finds no way is not laid: says why and where, and the router makes the connection', () => {
    // the point lies on a pad of another net
    const parts = [part('P1', [[3, 5, 'A']]), part('P2', [[17, 5, 'A']]), part('Q1', [[10, 8, 'B']]), part('Q2', [[15, 8, 'B']])];
    const pads = parts.flatMap((p) => p.pads);
    const r = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts, powerNets: new Set(), drawn: [{ id: 'T1', netId: 'A', from: 0, to: 1, points: [{ x: 10, y: 8 }] }] });
    expect(r.drawn).toEqual([{ id: 'T1', laid: false, why: '(10, 8) has no room for a 0.25 mm track: other copper is too close', at: { x: 10, y: 8 }, blockedBy: 'B' }]);
    expect(r.tracks.some((t) => t.drawn)).toBe(false);
    expect(r.connected('A', pads[0]!, pads[1]!)).toBe(true);
  });
});

describe('copper the agent locked', () => {
  it('is laid as it lies and never let go: the net in the way is named', () => {
    // B from the top edge to the bottom edge (its pads reach the edge clearance), routed alone, then
    // locked; A must cross it on one layer
    const bOnly = [part('Q1', [[10, 1, 'B']]), part('Q2', [[10, 9, 'B']])];
    const first = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts: bOnly, powerNets: new Set() });
    const parts = [part('P1', [[0.5, 5, 'A']]), part('P2', [[19.5, 5, 'A']]), ...bOnly];
    const r = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts, powerNets: new Set(), locked: { tracks: first.tracks, vias: [] } });
    expect(r.tracks.filter((t) => t.netId === 'B')).toEqual(first.tracks.map((t) => ({ ...t, locked: true })));
    expect(r.locked).toEqual([{ netId: 'B', tracks: first.tracks.length, vias: 0, heldTracks: first.tracks.length, heldVias: 0 }]);
    expect(r.failed.map((f) => [f.netId, f.blockedBy, f.enclosed])).toEqual([['A', ['B'], undefined]]);
  });

  it('what a moved part broke away from is not laid; the net is routed again round the rest', () => {
    const bOnly = [part('Q1', [[10, 1, 'B']]), part('Q2', [[10, 9, 'B']])];
    const first = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts: bOnly, powerNets: new Set() });
    const moved = [part('Q1', [[10, 1, 'B']]), part('Q2', [[14, 9, 'B']])];
    const r = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts: moved, powerNets: new Set(), locked: { tracks: first.tracks, vias: [] } });
    expect(r.locked![0]!.heldTracks).toBe(0);
    expect(r.failed).toEqual([]);
    expect(r.tracks.some((t) => t.locked)).toBe(false);
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

