import { describe, expect, it } from 'vitest';
import type { BoardKeepout, BoardPad, BoardPart, BoardRules, BoardView, Zone } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { boxInKeepout } from '../src/keepgeo.ts';
import { keptCopper } from '../src/keep.ts';
import { route, type RouteInput } from '../src/router.ts';

/** Two resistors on two nets, on a 20 × 12 mm board: the smallest design with a placement and copper. */
function pair(more: unknown[] = []) {
  const k = new Kernel();
  const r = k.transact({
    summary: 'pair',
    ops: [
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '1k' } },
      { op: 'connect', pins: ['R1.2', 'R2.1'], net: 'A' },
      { op: 'connect', pins: ['R1.1', 'R2.2'], net: 'GND' },
      { op: 'set_board', width_mm: 20, height_mm: 12 },
      ...more,
    ],
  });
  if (r.status !== 'ok') throw new Error(JSON.stringify(r.rejection));
  k.accept();
  return k;
}
const run = (k: Kernel, ops: unknown[]) => k.transact({ summary: 'test', ops });
const must = (k: Kernel, ops: unknown[]) => {
  const r = run(k, ops);
  if (r.status !== 'ok') throw new Error(JSON.stringify(r.rejection));
  return r;
};
const rect = (x_mm: number, y_mm: number, width_mm: number, height_mm: number) => ({ x_mm, y_mm, width_mm, height_mm });
const pad = (b: BoardView, ref: string, n: string) => b.parts.find((p) => p.refdes === ref)!.pads.find((p) => p.number === n)!;
const drc = (b: BoardView) => b.diagnostics.filter((x) => x.code === 'DRC.KEEPOUT');

describe('keep-out ops', () => {
  it('stores a keep-out with its defaults and lists it in get_board', () => {
    const k = pair();
    const r = must(k, [{ op: 'add_keepout', name: 'antenna', rect: rect(10, 0, 10, 6) }]);
    expect(r.results[0]!.effect).toMatch(/^keep-out KO1 "antenna": 10 × 6 mm at \(10, 0\), no tracks, vias, pours on all 2 layers/);
    k.accept();
    const b = k.board();
    expect(b.keepouts).toEqual([{ id: 'KO1', name: 'antenna', poly: [10, 0, 20, 0, 20, 6, 10, 6], layers: ['F.Cu', 'B.Cu'], forbid: ['tracks', 'vias', 'pours'], bounds: [10, 0, 20, 6] }]);
    // (a copy of the polygon only when it is not the plain rectangle the bounds already say)
    const listed = (k.query({ op: 'get_board' }) as { keepouts: Record<string, unknown>[] }).keepouts;
    expect(listed).toEqual([{ id: 'KO1', name: 'antenna', forbids: ['tracks', 'vias', 'pours'], layers: ['F.Cu', 'B.Cu'], bounds_mm: [10, 0, 20, 6] }]);
    must(k, [{ op: 'edit_keepout', id: 'KO1', forbid: ['parts'], layers: ['F.Cu'], name: null }]);
    expect(k.draftDesign().board!.keepouts).toEqual([{ id: 'KO1', poly: [10, 0, 20, 0, 20, 6, 10, 6], layers: ['F.Cu'], forbid: ['parts'] }]);
    expect(must(k, [{ op: 'remove_keepout', id: 'all' }]).results[0]!.effect).toBe('removed 1 keep-out(s)');
    expect(k.draftDesign().board!.keepouts).toBeUndefined();
  });

  it('refuses what cannot be a keep-out, with the way out', () => {
    const k = pair([{ op: 'add_keepout', rect: rect(1, 1, 2, 2) }]);
    const why = (op: unknown) => {
      const r = run(k, [op]);
      expect(r.status).toBe('rejected');
      return r.rejection!;
    };
    expect(why({ op: 'add_keepout' }).message).toMatch(/needs its area: rect/);
    expect(why({ op: 'add_keepout', rect: rect(0, 0, 1, 1), polygon: [{ x_mm: 0, y_mm: 0 }, { x_mm: 1, y_mm: 0 }, { x_mm: 1, y_mm: 1 }] }).message).toMatch(/rect or polygon, not both/);
    expect(why({ op: 'add_keepout', polygon: [{ x_mm: 0, y_mm: 0 }, { x_mm: 1, y_mm: 0 }] }).message).toMatch(/Too small/);
    expect(why({ op: 'add_keepout', polygon: [{ x_mm: 0, y_mm: 0 }, { x_mm: 1, y_mm: 1 }, { x_mm: 2, y_mm: 2 }] }).message).toMatch(/no area/);
    expect(why({ op: 'add_keepout', polygon: [{ x_mm: 0, y_mm: 0 }, { x_mm: 5, y_mm: 0 }, { x_mm: 0, y_mm: 2 }, { x_mm: 4, y_mm: 3 }] }).message).toMatch(/crosses itself/);
    expect(why({ op: 'add_keepout', rect: rect(0, 0, 0, 1) }).code).toBeDefined();
    const inner = why({ op: 'add_keepout', rect: rect(0, 0, 3, 3), layers: ['In1.Cu'] });
    expect(inner.message).toMatch(/In1\.Cu does not exist on a 2-layer board/);
    expect(inner.candidates).toEqual(['F.Cu', 'B.Cu']);
    expect(why({ op: 'add_keepout', rect: rect(0, 0, 3, 3), forbid: [] }).code).toBeDefined();
    expect(why({ op: 'add_keepout', rect: rect(0, 0, 3, 3), part: 'U9' }).code).toBe('REF_UNKNOWN');
    expect(why({ op: 'edit_keepout', id: 'KO7', name: 'x' }).candidates).toEqual(['KO1']);
    expect(why({ op: 'remove_keepout', id: 'KO7' }).code).toBe('REF_UNKNOWN');
    // the frame changes with the part: the area has to be given again
    expect(why({ op: 'edit_keepout', id: 'KO1', part: 'R1' }).message).toMatch(/give the area again/);
  });
});

describe('keep-outs on the placed board', () => {
  it('a keep-out attached to a part moves and turns with it, and the part itself may stand in it', () => {
    const k = pair([{ op: 'place', ref: 'R1', x_mm: 6, y_mm: 6, rot: 0, lock: true }, { op: 'add_keepout', part: 'R1', rect: rect(1, -2, 4, 4), forbid: ['parts', 'tracks'] }]);
    expect(k.board().keepouts[0]!.bounds).toEqual([7, 4, 11, 8]);
    must(k, [{ op: 'place', ref: 'R1', x_mm: 6, y_mm: 6, rot: 90, lock: true }]);
    // (the part's frame turned clockwise a quarter: x right, y down becomes y down, x left)
    expect(k.board().keepouts[0]!.bounds).toEqual([4, 7, 8, 11]);
    must(k, [{ op: 'place', ref: 'R1', x_mm: 6, y_mm: 6, rot: 0, lock: true }, { op: 'place', ref: 'R1', x_mm: 12, y_mm: 6, lock: true }]);
    const b = k.board();
    expect(b.keepouts[0]!.bounds).toEqual([13, 4, 17, 8]);
    expect(b.keepouts[0]!.part).toBe('R1');
    expect(drc(b)).toEqual([]);
    // gone with its part: inert
    must(k, [{ op: 'remove', ref: 'R1' }]);
    expect(k.board().keepouts).toEqual([]);
  });

  it('the placer keeps parts out of a keep-out that holds them off, courtyards included', () => {
    // the pair stands in the middle of the board; a keep-out over the middle moves it aside
    const free = pair().board();
    const mid = rect(5, 0, 10, 12);
    const box = (b: BoardView) => b.parts.map((p) => [p.courtyard.x, p.courtyard.y, p.courtyard.x + p.courtyard.w, p.courtyard.y + p.courtyard.h] as const);
    const ko = { poly: [5, 0, 15, 0, 15, 12, 5, 12], bounds: [5, 0, 15, 12] } as BoardKeepout;
    expect(box(free).some(([a, b2, c, d]) => boxInKeepout(ko, a, b2, c, d))).toBe(true);
    const k = pair([{ op: 'add_keepout', rect: mid, forbid: ['parts'] }]);
    const b = k.board();
    expect(box(b).some(([a, b2, c, d]) => boxInKeepout(ko, a, b2, c, d))).toBe(false);
    expect(drc(b)).toEqual([]);
    expect(b.parts.every((p) => p.courtyard.x >= 0 && p.courtyard.x + p.courtyard.w <= 20)).toBe(true);
  });

  it('a keep-out on the bottom side does not hold off parts that are on top', () => {
    const k = pair([{ op: 'add_keepout', rect: rect(5, 0, 10, 12), forbid: ['parts'], layers: ['B.Cu'] }]);
    // the resistors are on top: the bottom's keep-out leaves them where they are
    expect(drc(k.board())).toEqual([]);
    expect(k.board().parts.some((p) => p.courtyard.x < 15 && p.courtyard.x + p.courtyard.w > 5)).toBe(true);
  });

  it('DRC.KEEPOUT finds a locked part, drawn copper and a via that lie in one', () => {
    const k = pair([{ op: 'place', ref: 'R1', x_mm: 6, y_mm: 6, rot: 0, lock: true }, { op: 'place', ref: 'R2', x_mm: 14, y_mm: 6, rot: 0, lock: true }, { op: 'set_copper_mode', mode: 'drawn', keep: false }]);
    must(k, [
      { op: 'draw_track', from: 'R1.2', to: 'R2.1' },
      { op: 'draw_via', net: 'GND', at: [10, 3] },
    ]);
    expect(drc(k.board())).toEqual([]);
    // a keep-out laid over the track, the via and R2 afterwards: the copper and the part are found
    must(k, [{ op: 'add_keepout', name: 'coil', rect: rect(9, 2, 7, 8), forbid: ['tracks', 'vias', 'parts'] }]);
    const found = drc(k.board());
    expect(found.map((x) => x.entities[0]).sort()).toEqual(['R2', 't1', 'v2']);
    expect(found.every((x) => x.severity === 'error' && /keep-out KO1 \(coil\)/.test(x.message))).toBe(true);
    expect(found.find((x) => x.entities[0] === 't1')!.message).toMatch(/holds tracks off/);
    // pours alone forbidden: copper and parts may stand there
    must(k, [{ op: 'edit_keepout', id: 'KO1', forbid: ['pours'] }]);
    expect(drc(k.board())).toEqual([]);
  });
});

describe('drawn copper and keep-outs', () => {
  it('draw_track and draw_via refuse to enter one, saying where and how to go on', () => {
    const k = pair([{ op: 'place', ref: 'R1', x_mm: 6, y_mm: 6, rot: 0, lock: true }, { op: 'place', ref: 'R2', x_mm: 14, y_mm: 6, rot: 0, lock: true }, { op: 'set_copper_mode', mode: 'drawn', keep: false }]);
    const b = k.board();
    expect(pad(b, 'R1', '2').x).toBeLessThan(8.5);
    must(k, [{ op: 'add_keepout', name: 'antenna', rect: rect(8.5, 4, 3, 4), layers: ['F.Cu'] }]);
    const straight = run(k, [{ op: 'draw_track', from: 'R1.2', to: 'R2.1' }]);
    expect(straight.status).toBe('rejected');
    expect(straight.rejection!.code).toBe('KEEPOUT_HIT');
    expect(straight.rejection!.message).toMatch(/would enter keep-out KO1 \(antenna\) at \(/);
    expect(straight.rejection!.message).toMatch(/holds tracks off on F\.Cu/);
    expect(straight.rejection!.fixHints).toEqual([{ op: 'edit_keepout', id: 'KO1', forbid: ['vias', 'pours'] }]);
    // round it: a waypoint clear of the zone, or the other layer
    must(k, [{ op: 'draw_track', from: 'R1.2', to: 'R2.1', via: [[7.5, 2], [12.5, 2]] }]);
    const via = run(k, [{ op: 'draw_via', net: 'A', at: [10, 6] }]);
    expect(via.rejection!.code).toBe('KEEPOUT_HIT');
    expect(via.rejection!.message).toMatch(/A via at \(10, 6\) would lie in keep-out KO1 \(antenna\), which holds vias off/);
    // a keep-out that holds no tracks off on the layer lets the track in
    must(k, [{ op: 'erase_copper', all: true }, { op: 'edit_keepout', id: 'KO1', layers: ['B.Cu'] }, { op: 'draw_track', from: 'R1.2', to: 'R2.1' }]);
  });

  it('a pad of the part a keep-out is attached to may be reached through it', () => {
    const k = pair([{ op: 'place', ref: 'R1', x_mm: 6, y_mm: 6, rot: 0, lock: true }, { op: 'place', ref: 'R2', x_mm: 14, y_mm: 6, rot: 0, lock: true }, { op: 'set_copper_mode', mode: 'drawn', keep: false }]);
    const p = pad(k.board(), 'R2', '1');
    // a box on R2's pad 1, in R2's frame: the track to that pad is no harm; the same box on the board is
    const box = rect(p.x - 14 - p.w / 2, p.y - 6 - p.h / 2, p.w, p.h);
    must(k, [{ op: 'add_keepout', part: 'R2', rect: box, forbid: ['tracks'] }, { op: 'draw_track', from: 'R1.2', to: 'R2.1' }]);
    expect(drc(k.board())).toEqual([]);
    must(k, [{ op: 'erase_copper', all: true }, { op: 'edit_keepout', id: 'KO1', part: null, rect: rect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h) }]);
    expect(run(k, [{ op: 'draw_track', from: 'R1.2', to: 'R2.1' }]).rejection!.code).toBe('KEEPOUT_HIT');
  });
});

/* ---- the router, on a hand-made board ---- */

const RULES: BoardRules = { clearance: 0.2, track: 0.25, powerTrack: 0.5, viaDrill: 0.3, viaPad: 0.6, edgeClearance: 0.5 };
const smd = (refdes: string, x: number, y: number, netId: string, layer: 'F.Cu' | 'B.Cu' = 'F.Cu'): BoardPart => {
  const p: BoardPad = { number: '1', x, y, w: 1, h: 1, shape: 'rect', netId, layers: [layer] };
  return { componentId: refdes, refdes, x, y, rot: 0, pads: [p], courtyard: { x: x - 1, y: y - 1, w: 2, h: 2 } } as unknown as BoardPart;
};
const keepout = (x0: number, y0: number, x1: number, y1: number, forbid: BoardKeepout['forbid'], layers: BoardKeepout['layers'] = ['F.Cu', 'B.Cu']): BoardKeepout => ({ id: 'KO1', poly: [x0, y0, x1, y0, x1, y1, x0, y1], layers, forbid, bounds: [x0, y0, x1, y1] });
const input = (parts: BoardPart[], more: Partial<RouteInput>): RouteInput => ({ outline: { w: 20, h: 10 }, layers: ['F.Cu', 'B.Cu'], rules: RULES, parts, powerNets: new Set(), ...more });
const inside = (k: BoardKeepout, t: { pts: number[]; width: number }) => {
  const [x0, y0, x1, y1] = k.bounds;
  for (let i = 0; i + 3 < t.pts.length; i += 2) {
    for (let s = 0; s <= 20; s++) {
      const x = t.pts[i]! + ((t.pts[i + 2]! - t.pts[i]!) * s) / 20;
      const y = t.pts[i + 1]! + ((t.pts[i + 3]! - t.pts[i + 1]!) * s) / 20;
      if (x > x0 - t.width / 2 + 1e-3 && x < x1 + t.width / 2 - 1e-3 && y > y0 - t.width / 2 + 1e-3 && y < y1 + t.width / 2 - 1e-3) return true;
    }
  }
  return false;
};

describe('the router and the keep-outs', () => {
  it('goes round a keep-out that holds tracks off', () => {
    const ko = keepout(8, 0, 12, 7, ['tracks'], ['F.Cu']);
    const parts = [smd('P', 2, 4, 'A'), smd('Q', 18, 4, 'A')];
    const r = route(input(parts, { layers: ['F.Cu'], keepouts: [ko] }));
    expect(r.failed).toEqual([]);
    expect(r.tracks.length).toBeGreaterThan(0);
    expect(r.tracks.some((t) => inside(ko, t))).toBe(false);
    // the same board without it routes straight across
    expect(route(input(parts, { layers: ['F.Cu'] })).tracks.some((t) => inside(ko, t))).toBe(true);
  });

  it('is shut out by a keep-out across the whole board, and uses the other layer where the keep-out is only on this one', () => {
    const wall = keepout(8, 0, 12, 10, ['tracks'], ['F.Cu']);
    const parts = [smd('P', 2, 4, 'A'), smd('Q', 18, 4, 'A')];
    expect(route(input(parts, { layers: ['F.Cu'], keepouts: [wall] })).failed).toHaveLength(1);
    const r = route(input(parts, { keepouts: [wall] }));
    expect(r.failed).toEqual([]);
    expect(r.tracks.filter((t) => t.layer === 'F.Cu').some((t) => inside(wall, t))).toBe(false);
    expect(r.tracks.some((t) => t.layer === 'B.Cu' && inside(wall, t))).toBe(true);
    expect(r.vias.length).toBeGreaterThanOrEqual(2);
  });

  it('puts no via where vias are held off', () => {
    const ko = keepout(4, 0, 16, 10, ['vias']);
    const parts = [smd('P', 2, 4, 'A'), smd('Q', 18, 4, 'A', 'B.Cu')];
    const r = route(input(parts, { keepouts: [ko] }));
    expect(r.failed).toEqual([]);
    expect(r.vias).toHaveLength(1);
    expect(r.vias[0]!.x < 4 - 0.3 || r.vias[0]!.x > 16 + 0.3).toBe(true);
  });

  it('clears the pour in a keep-out that holds pours off, on the layers it names only', () => {
    const ko = keepout(8, 2, 14, 8, ['pours'], ['B.Cu']);
    const parts = [smd('P', 2, 4, 'G'), smd('Q', 18, 4, 'G')];
    const base = input(parts, { planes: [{ netId: 'G', layer: 'B.Cu' }, { netId: 'G', layer: 'F.Cu' }] });
    const covered = (z: Zone, x: number, y: number) => {
      for (let i = 0; i + 3 < z.rects.length; i += 4) if (x >= z.rects[i]! && x <= z.rects[i]! + z.rects[i + 2]! && y >= z.rects[i + 1]! && y <= z.rects[i + 1]! + z.rects[i + 3]!) return true;
      return false;
    };
    const r = route({ ...base, keepouts: [ko] });
    const [front, back] = [r.zones.find((z) => z.layer === 'F.Cu')!, r.zones.find((z) => z.layer === 'B.Cu')!];
    expect(covered(back, 5, 5)).toBe(true);
    expect(covered(back, 11, 5)).toBe(false);
    expect(covered(back, 9, 7.5)).toBe(false);
    expect(covered(front, 11, 5)).toBe(true);
    // the exact shape carries the cut; the other layer's has none
    expect(back.shape!.cuts).toContainEqual({ k: 'poly', pts: ko.poly });
    expect(front.shape!.cuts.some((c) => c.k === 'poly')).toBe(false);
    expect(covered(route(base).zones.find((z) => z.layer === 'B.Cu')!, 11, 5)).toBe(true);
  });

  it('does not keep routed copper a keep-out now lies over (incremental routing)', () => {
    const parts = [smd('P', 2, 4, 'A'), smd('Q', 18, 4, 'A')];
    const before = { tracks: [{ netId: 'A', layer: 'F.Cu' as const, width: 0.25, pts: [2, 4, 18, 4] }], vias: [] };
    expect(keptCopper(input(parts, {}), before).tracks).toHaveLength(1);
    expect(keptCopper(input(parts, { keepouts: [keepout(8, 3, 12, 5, ['tracks'], ['F.Cu'])] }), before).tracks).toHaveLength(0);
    // another layer, or another thing held off: it stays
    expect(keptCopper(input(parts, { keepouts: [keepout(8, 3, 12, 5, ['tracks'], ['B.Cu']), keepout(8, 3, 12, 5, ['vias', 'pours'])] }), before).tracks).toHaveLength(1);
  });
});
