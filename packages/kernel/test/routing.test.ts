import { describe, expect, it } from 'vitest';
import type { BoardPad, BoardPart, BoardRules, BoardView, CopperLayer, Design } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { neckDrc } from '../src/drc.ts';
import { segDist, segmentsOf } from '../src/geom.ts';
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

  it("runs at the net's width and narrows only near the pads that cannot take it", () => {
    // a 1.2 mm net between two 0.6 mm pads, 16 mm apart: not the widest width both pads take
    // (0.5 mm) all along
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
    // cannot take the 0.5 mm power track, and none passes between its neighbours; the track must
    // not stay at the signal width all the way to the far capacitor
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
    // the neck is no warning
    expect(neckDrc({ parts, tracks: r.tracks, netNames: {} } as unknown as BoardView, (id) => (id === 'VCC' ? 0.5 : 0.25))).toEqual([]);
  });

  it('a user-set width with nowhere to go at that width is routed narrow, and warned about', () => {
    // a 1.2 mm net from a 0.6 mm pad through a 1 mm gap in a wall: only 0.5 mm passes. Its width
    // with necks finds no way; it goes at the widest width both pads take, widened where it fits
    const wall = (net: string, ys: number[]) => ys.map((y): [number, number, string] => [10, y, net]);
    const parts = [chip('U1', [pad('1', 3, 5, 0.6, 0.6, 'P')]), part('P2', [[17, 5, 'P']], 1.5), part('W1', wall('X', [0.5, 1.5, 2.5, 3.5])), part('W2', wall('Y', [5.5, 6.5, 7.5, 8.5, 9.5]))];
    const r = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts, powerNets: new Set(['P']), netWidths: { P: 1.2 } });
    expect(r.failed).toEqual([]);
    const len = lengths(r.tracks, 'P');
    expect(len.get(0.5) ?? 0).toBeGreaterThan(2);
    const view = { parts, tracks: r.tracks, netNames: { P: '+12V' } } as unknown as BoardView;
    const found = neckDrc(view, (id) => (id === 'P' ? 1.2 : 0.25));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((d) => d.code === 'DRC.NECK' && /\+12V runs at 1\.2 mm/.test(d.message) && /make room there/.test(d.message))).toBe(true);
  });
  describe('a connection the agent laid (draw_track) on a power net, to a 0.25 mm pad', () => {
    // P from a 0.25 mm pad at (2, 5) to a 1 mm pad at (18, 5): the power width is 0.5 mm
    const ends = () => [chip('U1', [pad('1', 2, 5, 0.25, 0.25, 'P')]), part('J1', [[18, 5, 'P']])];
    const laid = [{ id: 't1', netId: 'P', from: 0, to: 1, layer: 'F.Cu' as const, points: [] }];
    const wall = (net: string, ys: number[]) => ys.map((y): [number, number, string] => [10, y, net]);
    const at = (parts: BoardPart[]) => route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts, powerNets: new Set(['P']), laid });
    const widthOf = (id: string) => (id === 'P' ? RULES.powerTrack : RULES.track);

    it("is laid at the net's width, necked only in a short stretch at the small pad", () => {
      const parts = ends();
      const r = at(parts);
      expect(r.laid).toEqual([{ id: 't1', laid: true }]);
      const mine = r.tracks.filter((t) => t.laid === 't1');
      expect(mine.length).toBeGreaterThan(0);
      const len = lengths(mine, 'P');
      expect([...len.keys()].sort()).toEqual([0.25, 0.5]);
      expect(len.get(0.5)!).toBeGreaterThan(13);
      // the neck: within the neck zone round the pad (twice neckReach(0.5) = 2 mm, as DRC.NECK)
      expect(len.get(0.25)!).toBeLessThanOrEqual(2);
      for (const t of mine.filter((t) => t.width === RULES.track)) expect(Math.min(Math.hypot(t.pts[0]! - 2, t.pts[1]! - 5), Math.hypot(t.pts.at(-2)! - 2, t.pts.at(-1)! - 5))).toBeLessThan(0.2);
      expect(r.connected('P', parts[0]!.pads[0]!, parts[1]!.pads[0]!)).toBe(true);
      clearOfPads(r, parts, RULES.clearance);
      expect(neckDrc({ parts, tracks: r.tracks, netNames: {} } as unknown as BoardView, widthOf)).toEqual([]);
    });

    it('where the wide track with a neck finds no way, is laid at the width the pads take', () => {
      // a wall of pads with a 0.8 mm gap, far from the small pad: only 0.25 mm passes
      const parts = [...ends(), part('W1', wall('X', [0.5, 1.5, 2.5, 3.5])), part('W2', wall('Y', [5.3, 6.3, 7.3, 8.3, 9.3]))];
      const r = at(parts);
      expect(r.laid).toEqual([{ id: 't1', laid: true }]);
      const mine = r.tracks.filter((t) => t.laid === 't1');
      expect(mine.length).toBeGreaterThan(0);
      // at the signal width all along (a power track is not widened again), through the gap
      const len = lengths(mine, 'P');
      expect([...len.keys()]).toEqual([RULES.track]);
      expect(len.get(RULES.track)!).toBeGreaterThan(15);
      expect(mine.some((t) => segmentsOf(t.pts).some(([ax, ay, bx, by]) => segDist(ax, ay, bx, by)(10, 4.4) < 0.2))).toBe(true);
      expect(r.connected('P', parts[0]!.pads[0]!, parts[1]!.pads[0]!)).toBe(true);
      expect(r.failed.filter((f) => f.netId === 'P')).toEqual([]);
      clearOfPads(r, parts, RULES.clearance);
      // longer than a neck: DRC.NECK says so
      expect(neckDrc({ parts, tracks: r.tracks, netNames: {} } as unknown as BoardView, widthOf).map((d) => d.code)).toEqual(['DRC.NECK']);
    });

    it('with no way at either width, is not laid and says why', () => {
      // the wall from edge to edge, one layer
      const parts = [...ends(), part('W1', wall('X', [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5]))];
      const r = at(parts);
      expect(r.laid).toEqual([{ id: 't1', laid: false, why: 'no way for a 0.25 mm track from U1.1 to J1.1 on F.Cu', at: { x: 18, y: 5 } }]);
      expect(r.tracks.some((t) => t.laid)).toBe(false);
    });
  });
});

describe('copper the agent locked (lock_copper)', () => {
  // B from the top edge to the bottom edge (its pads reach the edge clearance), routed alone first
  const bOnly = [part('Q1', [[10, 1, 'B']]), part('Q2', [[10, 9, 'B']])];
  const first = () => route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts: bOnly, powerNets: new Set() });

  it('is laid exactly as it lies and never let go: the net in the way is named', () => {
    const b = first();
    // A must cross the locked B on one layer
    const parts = [part('P1', [[0.5, 5, 'A']]), part('P2', [[19.5, 5, 'A']]), ...bOnly];
    const r = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts, powerNets: new Set(), locked: { tracks: b.tracks, vias: [] } });
    expect(r.tracks.filter((t) => t.netId === 'B')).toEqual(b.tracks.map((t) => ({ ...t, locked: true })));
    expect(r.locked).toEqual([{ netId: 'B', tracks: b.tracks.length, vias: 0, heldTracks: b.tracks.length, heldVias: 0 }]);
    // (not closed off by pads or the edge: B's copper is in the way)
    expect(r.failed.map((f) => [f.netId, f.blockedBy, f.enclosed])).toEqual([['A', ['B'], undefined]]);
    expect(r.reused).toBeUndefined();
  });

  it('what a moved part broke away from is not laid; the net is routed again round the rest', () => {
    const b = first();
    const moved = [part('Q1', [[10, 1, 'B']]), part('Q2', [[14, 9, 'B']])];
    const r = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts: moved, powerNets: new Set(), locked: { tracks: b.tracks, vias: [] } });
    expect(r.locked![0]!.heldTracks).toBe(0);
    expect(r.failed).toEqual([]);
    expect(r.tracks.some((t) => t.locked)).toBe(false);
  });

  it('a connection the agent laid is not closed off either: its net is named in the way', () => {
    const parts = [part('P1', [[0.5, 5, 'A']]), part('P2', [[19.5, 5, 'A']]), ...bOnly];
    const r = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts, powerNets: new Set(), laid: [{ id: 't1', netId: 'B', from: 2, to: 3, points: [] }] });
    expect(r.laid).toEqual([{ id: 't1', laid: true }]);
    expect(r.failed.map((f) => [f.netId, f.blockedBy, f.enclosed])).toEqual([['A', ['B'], undefined]]);
  });

  it('locked copper and a connection laid on the same net: both laid first, neither let go', () => {
    // B: three pads; Q1–Q2 locked as routed alone, Q2–Q3 laid by the agent through a point
    const three = [part('Q1', [[4, 2, 'B']]), part('Q2', [[10, 2, 'B']]), part('Q3', [[16, 8, 'B']])];
    const b = route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts: three.slice(0, 2), powerNets: new Set() });
    const parts = [...three, part('P1', [[2, 6, 'A']]), part('P2', [[18, 3, 'A']])];
    const pads = parts.flatMap((p) => p.pads);
    const input = { outline: { w: 20, h: 10 }, layers: ['F.Cu', 'B.Cu'] as CopperLayer[], rules: RULES, parts, powerNets: new Set<string>(), locked: { tracks: b.tracks, vias: [] }, laid: [{ id: 't1', netId: 'B', from: 1, to: 2, points: [{ x: 10, y: 8 }] }] };
    const r = route(input);
    expect(r.laid).toEqual([{ id: 't1', laid: true }]);
    expect(r.tracks.filter((t) => t.locked)).toEqual(b.tracks.map((t) => ({ ...t, locked: true })));
    expect(r.tracks.some((t) => t.laid === 't1')).toBe(true);
    // (nothing else of B: the locked copper and the laid connection join all three pads)
    expect(r.tracks.filter((t) => t.netId === 'B' && !t.locked && !t.laid)).toEqual([]);
    expect(r.connected('B', pads[0]!, pads[2]!)).toBe(true);
    expect(r.failed).toEqual([]);
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

