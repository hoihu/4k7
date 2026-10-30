import { beforeAll, describe, expect, it } from 'vitest';
import type { BoardView, Track } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { boardRouteInput } from '../src/board.ts';
import { route, type RouteResult } from '../src/router.ts';
import { routeLines } from '../src/pairroute.ts';

function ok(k: Kernel, ops: unknown[]) {
  const r = k.transact({ summary: 'test', ops });
  if (r.status !== 'ok') throw new Error(JSON.stringify(r.rejection));
  return r;
}
const codes = (b: BoardView) => b.diagnostics.filter((x) => !x.waivedBy).map((x) => x.code);

const pieces = (t: Track) => Array.from({ length: t.pts.length / 2 - 1 }, (_, i) => t.pts.slice(2 * i, 2 * i + 4) as [number, number, number, number]);
const segDist = ([ax, ay, bx, by]: number[], x: number, y: number) => {
  const [dx, dy] = [bx! - ax!, by! - ay!];
  const t = Math.max(0, Math.min(1, ((x - ax!) * dx + (y - ay!) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - (ax! + t * dx), y - (ay! + t * dy));
};
/** The edge-to-edge gap between two tracks at points along the first (between x = from and to, away from the pads). */
function gaps(a: Track, b: Track, from: number, to: number) {
  const out: number[] = [];
  for (const p of pieces(a)) {
    const n = Math.max(1, Math.round(Math.hypot(p[2] - p[0], p[3] - p[1]) / 0.2));
    for (let i = 0; i <= n; i++) {
      const [x, y] = [p[0] + ((p[2] - p[0]) * i) / n, p[1] + ((p[3] - p[1]) * i) / n];
      if (x < from || x > to) continue;
      out.push(Math.min(...pieces(b).map((q) => segDist(q, x, y))) - (a.width + b.width) / 2);
    }
  }
  return out;
}

/**
 * Two pads each of D+ and D- on 0603 resistors 28 mm apart (D+ above D-), on 4 layers with a +3V3 plane
 * on In2.Cu, so that B.Cu carries the pair too. `plane: false` leaves In2.Cu free (B.Cu cannot).
 */
function smd(plane = true, len = 28, h = 20) {
  const k = new Kernel();
  ok(k, [
    ...['R1', 'R2', 'R3', 'R4', 'R5'].map((refdes) => ({ op: 'add_part', part: 'generic:R', refdes, params: { resistance: '33', package: '0603' } })),
    { op: 'connect', pins: ['R1.1', 'R3.1'], net: 'USB_DP' },
    { op: 'connect', pins: ['R2.1', 'R4.1'], net: 'USB_DN' },
    { op: 'connect', pins: ['R1.2', 'R2.2', 'R3.2', 'R4.2', 'R5.2'], net: 'GND' },
    { op: 'connect', pins: ['R5.1'], net: '+3V3' },
    { op: 'set_board', layers: 4, width_mm: len + 12, height_mm: h },
    ...(plane ? [{ op: 'set_plane', layer: 'In2.Cu', net: '+3V3' }] : []),
    { op: 'place', ref: 'R1', x_mm: 6, y_mm: h / 2 - 1.2, rot: 0, lock: true },
    { op: 'place', ref: 'R2', x_mm: 6, y_mm: h / 2 + 1.2, rot: 0, lock: true },
    { op: 'place', ref: 'R3', x_mm: 6 + len, y_mm: h / 2 - 1.2, rot: 0, lock: true },
    { op: 'place', ref: 'R4', x_mm: 6 + len, y_mm: h / 2 + 1.2, rot: 0, lock: true },
    { op: 'place', ref: 'R5', x_mm: 6 + len / 2, y_mm: 2.5, rot: 0, lock: true },
    { op: 'set_impedance', nets: ['USB_DP', 'USB_DN'], ohms: 90 },
    { op: 'set_copper_mode', mode: 'drawn', keep: false },
  ]);
  return k;
}
const drawnTracks = (k: Kernel, net: string) => {
  const b = k.board();
  const id = Object.entries(b.netNames).find(([, n]) => n === net)![0];
  return b.drawn!.tracks.filter((t) => t.netId === id);
};

describe('a pair routed together', () => {
  // (the first route of a file pays for the module's start-up: not in the first test's time)
  beforeAll(() => {
    ok(smd(), [{ op: 'route', nets: ['USB_DP', 'USB_DN'] }]);
  });

  it('goes as two tracks side by side at the rule\'s width and gap', () => {
    const k = smd();
    const r = ok(k, [{ op: 'route', nets: ['USB_DP', 'USB_DN'] }]);
    expect(r.results[0]!.effect).toMatch(/USB_DP\/USB_DN routed as a coupled pair/);
    const [p, n] = [drawnTracks(k, 'USB_DP'), drawnTracks(k, 'USB_DN')];
    expect(p).toHaveLength(1);
    expect(n).toHaveLength(1);
    const lay = k.board().impedance![0]!.layers[0]!;
    expect(p[0]!.width).toBe(lay.width);
    const gs = gaps(p[0]!, n[0]!, 8, 32).sort((a, b) => a - b);
    expect(gs[Math.floor(gs.length / 2)]).toBeCloseTo(lay.gap!, 3);
    expect(gs[0]).toBeGreaterThan(lay.gap! - 0.002);
    expect(codes(k.board()).filter((c) => c.startsWith('IMP.') || c === 'DRC.CLEARANCE')).toEqual([]);
  });

  it('goes round a track in its way with 45° bends, the gap held', () => {
    const k = smd();
    ok(k, [{ op: 'draw_track', from: [20, 4], to: [20, 11], net: 'GND', layer: 'F.Cu', width_mm: 0.3 }]);
    ok(k, [{ op: 'route', nets: ['USB_DP', 'USB_DN'] }]);
    const [p, n] = [drawnTracks(k, 'USB_DP')[0]!, drawnTracks(k, 'USB_DN')[0]!];
    expect(p.layer).toBe('F.Cu');
    expect(p.pts.length).toBeGreaterThan(8);
    const lay = k.board().impedance![0]!.layers[0]!;
    const gs = gaps(p, n, 8, 32).sort((a, b) => a - b);
    // (at a mitred corner the outer track's corner stands further off)
    expect(gs[Math.floor(gs.length / 2)]).toBeCloseTo(lay.gap!, 3);
    expect(gs[0]).toBeGreaterThan(lay.gap! - 0.002);
    // (the bends do not cancel: the pair is a little skewed, which tune_length is for)
    expect(codes(k.board()).filter((c) => (c.startsWith('IMP.') && c !== 'IMP.SKEW') || c === 'DRC.CLEARANCE')).toEqual([]);
  });

  it('leaves the skew of its bends to tune_length', () => {
    const k = smd();
    ok(k, [{ op: 'set_impedance', nets: ['USB_DP', 'USB_DN'], ohms: 90, max_skew_mm: 0.1 }, { op: 'draw_track', from: [20, 4], to: [20, 11], net: 'GND', layer: 'F.Cu', width_mm: 0.3 }, { op: 'route', nets: ['USB_DP', 'USB_DN'] }]);
    expect(codes(k.board())).toContain('IMP.SKEW');
    const [p, n] = [drawnTracks(k, 'USB_DP')[0]!, drawnTracks(k, 'USB_DN')[0]!];
    const len = (t: Track) => pieces(t).reduce((a, [x0, y0, x1, y1]) => a + Math.hypot(x1 - x0, y1 - y0), 0);
    const shorter = len(p) < len(n) ? 'USB_DP' : 'USB_DN';
    const r = ok(k, [{ op: 'tune_length', net: shorter }]);
    expect(r.results[0]!.effect).toMatch(new RegExp(`^tuned t\\d+ \\(${shorter}\\)`));
    expect(codes(k.board())).not.toContain('IMP.SKEW');
  });

  it('changes layer together: a via for each track side by side', () => {
    const k = smd();
    ok(k, [{ op: 'draw_track', from: [20, 5], to: [20, 17], net: 'GND', layer: 'F.Cu', width_mm: 0.3 }]);
    const r = ok(k, [{ op: 'route', nets: ['USB_DP', 'USB_DN'] }]);
    expect(r.results[0]!.effect).toMatch(/coupled pair/);
    const b = k.board();
    const vias = b.drawn!.vias;
    expect(vias).toHaveLength(4);
    const dp = Object.entries(b.netNames).find(([, nm]) => nm === 'USB_DP')![0];
    const pv = vias.filter((v) => v.netId === dp);
    const nv = vias.filter((v) => v.netId !== dp);
    expect(pv).toHaveLength(2);
    // each pair of vias side by side across the line, a via spacing apart
    for (const [a, c] of [[pv[0]!, nv[0]!], [pv[1]!, nv[1]!]] as const) {
      expect(Math.abs(a.x - c.x)).toBeLessThan(0.01);
      expect(Math.hypot(a.x - c.x, a.y - c.y)).toBeGreaterThanOrEqual(b.rules.viaPad + b.rules.clearance - 0.001);
    }
    const layers = new Set(b.drawn!.tracks.filter((t) => t.netId !== undefined && t.width < 0.29).map((t) => t.layer));
    expect(layers).toEqual(new Set(['F.Cu', 'B.Cu']));
    expect(codes(b).filter((c) => c === 'IMP.GAP' || c === 'IMP.WIDTH' || c === 'DRC.CLEARANCE' || c === 'IMP.CORNER')).toEqual([]);
    // (the ground vias beside them are the agent's: IMP.VIA says so)
    expect(codes(b)).toContain('IMP.VIA');
  });

  it('falls back to two nets, and says why', () => {
    // no plane on In2.Cu: B.Cu cannot carry the pair, so a wall across F.Cu leaves it no way
    const k = smd(false, 14, 14);
    ok(k, [{ op: 'draw_track', from: [13, 0.6], to: [13, 13.4], net: 'GND', layer: 'F.Cu', width_mm: 0.3 }]);
    const r = ok(k, [{ op: 'route', nets: ['USB_DP', 'USB_DN'] }]);
    expect(r.results[0]!.effect).toMatch(/USB_DP\/USB_DN routed apart, open pair: no way for the two tracks side by side/);
    // (the two nets are routed all the same)
    expect(drawnTracks(k, 'USB_DP').length).toBeGreaterThan(0);
    expect(drawnTracks(k, 'USB_DN').length).toBeGreaterThan(0);
  });

  it('records it in the board when the router lays the pair', () => {
    const k = new Kernel();
    ok(k, [
      { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J1' },
      { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J2' },
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'TP1' },
      { op: 'connect', pins: ['J1.1', 'J2.1'], net: 'VBUS' },
      { op: 'connect', pins: ['J1.2', 'J2.2', 'TP1.1'], net: 'USB_DP' },
      { op: 'connect', pins: ['J1.3', 'J2.3'], net: 'USB_DN' },
      { op: 'connect', pins: ['J1.4', 'J2.4', 'TP1.2'], net: 'GND' },
      { op: 'set_net', net: 'VBUS', voltage: 5, external: true },
      { op: 'set_board', layers: 4, width_mm: 40, height_mm: 20 },
      { op: 'place', ref: 'J1', x_mm: 6, y_mm: 10, rot: 0, lock: true },
      { op: 'place', ref: 'J2', x_mm: 34, y_mm: 10, rot: 0, lock: true },
      { op: 'place', ref: 'TP1', x_mm: 20, y_mm: 3, rot: 0, lock: true },
      { op: 'set_impedance', nets: ['USB_DP', 'USB_DN'], ohms: 90 },
      { op: 'route' },
    ]);
    const b = k.board();
    expect(b.unrouted).toEqual([]);
    expect(b.diagnostics.find((x) => x.code === 'IMP.PAIR')?.message).toMatch(/USB_DP\/USB_DN \(Z1\) routed apart \(open pair\): the pads of USB_DP and USB_DN do not pair up/);
  });

  it('in router mode too, and keeps the other nets off the plane under it', () => {
    const k = new Kernel();
    ok(k, [
      { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J1' },
      { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J2' },
      { op: 'connect', pins: ['J1.1', 'J2.1'], net: 'VBUS' },
      { op: 'connect', pins: ['J1.2', 'J2.2'], net: 'USB_DP' },
      { op: 'connect', pins: ['J1.3', 'J2.3'], net: 'USB_DN' },
      { op: 'connect', pins: ['J1.4', 'J2.4'], net: 'GND' },
      { op: 'set_net', net: 'VBUS', voltage: 5, external: true },
      { op: 'set_board', layers: 4, width_mm: 40, height_mm: 20 },
      { op: 'place', ref: 'J1', x_mm: 6, y_mm: 10, rot: 0, lock: true },
      { op: 'place', ref: 'J2', x_mm: 34, y_mm: 10, rot: 0, lock: true },
      { op: 'set_impedance', nets: ['USB_DP', 'USB_DN'], ohms: 90 },
      { op: 'route' },
    ]);
    const b = k.board();
    expect(b.unrouted).toEqual([]);
    const dp = Object.entries(b.netNames).find(([, n]) => n === 'USB_DP')![0];
    const dn = Object.entries(b.netNames).find(([, n]) => n === 'USB_DN')![0];
    const [p, n] = [b.tracks.find((t) => t.netId === dp)!, b.tracks.find((t) => t.netId === dn)!];
    expect(Math.min(...gaps(p, n, 8, 32))).toBeGreaterThan(b.impedance![0]!.layers[0]!.gap! - 0.002);
    expect(codes(b).filter((c) => c.startsWith('IMP.'))).toEqual([]);
  });
});

describe('lines routed first, and undone when they block', () => {
  it('routes a single line before the other nets, which then keep off the plane under it', () => {
    const k = new Kernel();
    ok(k, [
      ...['R1', 'R2', 'R3', 'R4', 'R5'].map((refdes) => ({ op: 'add_part', part: 'generic:R', refdes, params: { resistance: '33', package: '0603' } })),
      { op: 'connect', pins: ['R1.1', 'R2.1'], net: 'ANT' },
      { op: 'connect', pins: ['R3.1', 'R4.1'], net: 'CLK' },
      { op: 'connect', pins: ['R1.2', 'R2.2', 'R3.2', 'R4.2', 'R5.2'], net: 'GND' },
      { op: 'connect', pins: ['R5.1'], net: '+3V3' },
      { op: 'set_board', layers: 4, width_mm: 40, height_mm: 20 },
      { op: 'set_plane', layer: 'In2.Cu', net: '+3V3' },
      { op: 'place', ref: 'R1', x_mm: 6, y_mm: 10, rot: 0, lock: true },
      { op: 'place', ref: 'R2', x_mm: 34, y_mm: 10, rot: 0, lock: true },
      { op: 'place', ref: 'R3', x_mm: 20, y_mm: 4, rot: 90, lock: true },
      { op: 'place', ref: 'R4', x_mm: 20, y_mm: 16, rot: 90, lock: true },
      { op: 'place', ref: 'R5', x_mm: 30, y_mm: 3, rot: 0, lock: true },
      { op: 'set_impedance', nets: ['ANT'], ohms: 50 },
      { op: 'route' },
    ]);
    const b = k.board();
    expect(b.unrouted).toEqual([]);
    const id = (n: string) => Object.entries(b.netNames).find(([, nm]) => nm === n)![0];
    const ant = b.tracks.filter((t) => t.netId === id('ANT'));
    // straight along its pads on the top layer, no via: laid before CLK, which is the shorter connection
    expect(ant.map((t) => t.layer)).toEqual(['F.Cu']);
    expect(b.vias.filter((v) => v.netId === id('ANT'))).toEqual([]);
    const lay = b.impedance![0]!.layers[0]!;
    for (const v of b.vias.filter((x) => x.netId !== id('ANT'))) {
      const d = Math.min(...pieces(ant[0]!).map((q) => segDist(q, v.x, v.y)));
      expect(d).toBeGreaterThanOrEqual(ant[0]!.width / 2 + lay.h + v.pad / 2 - 0.01);
    }
    expect(codes(b).filter((c) => c === 'IMP.REFERENCE')).toEqual([]);
  });

  it('routes the pair again as two nets when together it leaves another net open, and says so', () => {
    const k = smd();
    const d = k.committedDesign();
    const input = boardRouteInput(d, k.board(), {});
    input.drawn = { tracks: [], vias: [], only: { nets: Object.keys(k.board().netNames) } };
    const dp = Object.entries(k.board().netNames).find(([, n]) => n === 'USB_DP')![0];
    const calls: boolean[] = [];
    // the main run: open with the pair's copper frozen, closed without it
    const run = (i: Parameters<typeof route>[0], passes?: number): RouteResult => {
      if (i.drawn?.only?.pairs) return route({ ...i, controlled: undefined }, passes);
      const frozen = i.drawn!.tracks.some((t) => t.netId === dp);
      calls.push(frozen);
      return { tracks: [], vias: [], zones: [], connected: () => false, failed: frozen ? [{ netId: 'x', a: i.parts[0]!.pads[0]!, b: i.parts[0]!.pads[1]!, blockedBy: [dp] }] : [], netsTotal: 1, netsDone: 1, timedOut: false, passes: 1, groups: [] };
    };
    const r = routeLines(input, 3, run);
    expect(calls).toEqual([true, false]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines![0]).toMatchObject({ id: 'Z1', coupled: false });
    expect(r.lines![0]!.why).toMatch(/kept together it left 1 connection open \(.* in the way\); routed apart 0 are open/);
    expect(r.failed).toEqual([]);
  });
});
