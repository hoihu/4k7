import { beforeAll, describe, expect, it } from 'vitest';
import type { BoardView, DrawnTrack } from '@4k7/schema';
import { Kernel } from '../src/index.ts';

function ok(k: Kernel, ops: unknown[]) {
  const r = k.transact({ summary: 'test', ops });
  if (r.status !== 'ok') throw new Error(JSON.stringify(r.rejection));
  return r;
}
const refused = (k: Kernel, ops: unknown[]) => {
  const r = k.transact({ summary: 'test', ops });
  expect(r.status).toBe('rejected');
  return r.rejection!;
};
const codes = (b: BoardView) => b.diagnostics.filter((x) => !x.waivedBy).map((x) => x.code);
const len = (t: { pts: number[] }) => t.pts.reduce((s, _, i) => (i >= 2 && i % 2 === 0 ? s + Math.hypot(t.pts[i]! - t.pts[i - 2]!, t.pts[i + 1]! - t.pts[i - 1]!) : s), 0);
const track = (k: Kernel, id: string) => k.board().drawn!.tracks.find((t) => t.id === id)!;
const segSeg = (a: number[], b: number[]) => {
  // the shortest distance between two segments (x0, y0, x1, y1)
  const pt = (px: number, py: number, s: number[]) => {
    const [dx, dy] = [s[2]! - s[0]!, s[3]! - s[1]!];
    const t = Math.max(0, Math.min(1, ((px - s[0]!) * dx + (py - s[1]!) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(px - (s[0]! + t * dx), py - (s[1]! + t * dy));
  };
  return Math.min(pt(a[0]!, a[1]!, b), pt(a[2]!, a[3]!, b), pt(b[0]!, b[1]!, a), pt(b[2]!, b[3]!, a));
};
const segs = (t: DrawnTrack) => Array.from({ length: t.pts.length / 2 - 1 }, (_, i) => t.pts.slice(2 * i, 2 * i + 4));

/** Two 4-pin headers 28 mm apart joined by a USB pair (90 Ω, at most 0.1 mm skew), VBUS and GND, the copper drawn. */
function usb() {
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
    { op: 'set_fab_profile', preset: 'jlcpcb' },
    { op: 'place', ref: 'J1', x_mm: 6, y_mm: 10, rot: 0, lock: true },
    { op: 'place', ref: 'J2', x_mm: 34, y_mm: 10, rot: 0, lock: true },
    { op: 'set_impedance', nets: ['USB_DP', 'USB_DN'], ohms: 90, max_skew_mm: 0.1 },
    { op: 'set_copper_mode', mode: 'drawn', keep: false },
  ]);
  return k;
}

/** The pair drawn with a deliberately longer positive leg: a trapezoid bump out of its track, 0.83 mm of extra length. */
function skewed() {
  const k = usb();
  ok(k, [{ op: 'draw_pair', from: ['J1.2', 'J1.3'], to: ['J2.2', 'J2.3'], via: [[10, 10], [30, 10]] }]);
  const [x0, y, x1] = [track(k, 't1').pts[2]!, track(k, 't1').pts[3]!, track(k, 't1').pts[4]!];
  ok(k, [{ op: 'edit_copper', ids: ['t1'], via: [[x0, y], [12, y], [13, y - 1], [14, y - 1], [15, y], [x1, y]] }]);
  return k;
}

describe('tune_length', () => {
  beforeAll(() => {
    ok(skewed(), [{ op: 'tune_length', net: 'USB_DN' }]);
  });

  it('lengthens the short leg of a pair until the skew is within the rule', () => {
    const k = skewed();
    expect(codes(k.board())).toContain('IMP.SKEW');
    const was = len(track(k, 't2'));
    const r = ok(k, [{ op: 'tune_length', net: 'USB_DN' }]);
    const e = r.results[0]!.effect;
    expect(e).toMatch(/^tuned t2 \(USB_DN\) on F\.Cu: \+\d\.\d+ mm with \d+ bumps? \(.* mm high, legs [\d.]+ mm apart.*\) near .*; USB_DN is now [\d.]+ mm against USB_DP, [\d.]+ mm( \(0\.0\d mm off, within 0\.1\))?, pair skew 0\.0\d mm \(limit 0\.1 mm\); check: /);
    const dn = track(k, 't2');
    const dp = track(k, 't1');
    expect(Math.abs(len(dn) - len(dp))).toBeLessThan(0.1);
    expect(len(dn) - was).toBeGreaterThan(0.7);
    const b = k.board();
    expect(codes(b)).not.toContain('IMP.SKEW');
    expect(codes(b).filter((c) => c.startsWith('DRC.') && c !== 'DRC.UNROUTED')).toEqual([]);
    // the bumps go away from the partner (down, the partner is above) and are small: at most twice the pair's gap
    const gap = b.impedance![0]!.layers[0]!.gap!;
    const ys = dn.pts.filter((_, i) => i % 2 === 1 && dn.pts[i - 1]! > 8 && dn.pts[i - 1]! < 32);
    expect(Math.min(...ys)).toBeGreaterThan(10.236 - 0.001);
    expect(Math.max(...ys)).toBeLessThanOrEqual(10.236 + 2 * gap + 0.001);
    // the ends stay on their pads
    expect(dn.pts.slice(0, 2)).toEqual([6, 11.27]);
    expect(dn.pts.slice(-2)).toEqual([34, 11.27]);
    expect(dn.from).toBeDefined();
  });

  it('keeps the legs 3 widths apart and 45° corners, on a single line to a length', () => {
    const k = usb();
    ok(k, [{ op: 'draw_track', from: 'J1.1', to: 'J2.1', via: [[8, 6], [32, 6]], bend: 'diagonal_first' }]);
    const was = len(track(k, 't1'));
    const r = ok(k, [{ op: 'tune_length', track: 't1', target_mm: was + 6 }]);
    expect(r.results[0]!.effect).toMatch(/tuned t1 \(VBUS\)/);
    const t = track(k, 't1');
    expect(Math.abs(len(t) - (was + 6))).toBeLessThanOrEqual(0.1);
    // legs at least three widths apart (edge to edge) wherever two pieces are not neighbours
    const ss = segs(t);
    let near = Infinity;
    // (pieces less than a leg spacing apart along the track are bends of one leg)
    const along = (i: number, j: number) => ss.slice(i + 1, j).reduce((a, q) => a + Math.hypot(q[2]! - q[0]!, q[3]! - q[1]!), 0);
    for (let i = 0; i < ss.length; i++) for (let j = i + 2; j < ss.length; j++) if (along(i, j) >= 4 * t.width) near = Math.min(near, segSeg(ss[i]!, ss[j]!) - t.width);
    expect(near).toBeGreaterThanOrEqual(3 * t.width - 0.01);
    // every piece runs horizontal, vertical or at 45°
    for (const s of ss) {
      const [dx, dy] = [Math.abs(s[2]! - s[0]!), Math.abs(s[3]! - s[1]!)];
      expect(Math.min(dx, dy) < 0.003 || Math.abs(dx - dy) < 0.003).toBe(true);
    }
    expect(k.board().diagnostics.filter((x) => x.severity === 'error' && x.code !== 'DRC.UNROUTED')).toEqual([]);
    expect(codes(k.board())).not.toContain('IMP.CORNER');
  });

  it('matches the longest of a group, near the end asked for', () => {
    const k = usb();
    ok(k, [
      { op: 'draw_track', from: 'J1.1', to: 'J2.1', via: [[8, 2], [32, 2]], bend: 'diagonal_first' },
      { op: 'draw_track', from: 'J1.4', to: 'J2.4', via: [[8, 15], [32, 15]], bend: 'diagonal_first' },
    ]);
    const long = len(track(k, 't1'));
    const r = ok(k, [{ op: 'tune_length', net: 'GND', match: ['VBUS'], near: 'start', tolerance_mm: 0.05 }]);
    expect(r.results[0]!.effect).toMatch(/GND is now [\d.]+ mm against VBUS/);
    const t = track(k, 't2');
    expect(Math.abs(len(t) - long)).toBeLessThanOrEqual(0.05);
    // (the meander is in the first half of the track)
    const xs = t.pts.filter((_, i) => i % 2 === 0);
    const bumps = t.pts.filter((_, i) => i % 2 === 1).map((y, i) => [xs[i]!, y] as const).filter(([, y]) => Math.abs(y - 15) > 0.2 && y > 14.5 && y < 17);
    expect(bumps.length).toBeGreaterThan(0);
    expect(Math.max(...bumps.map(([x]) => x))).toBeLessThan(20);
  });

  it('keeps clear of other copper, and says where it found no room', () => {
    const k = usb();
    ok(k, [
      { op: 'draw_track', from: 'J1.1', to: 'J2.1', via: [[8, 5], [32, 5]], bend: 'diagonal_first' },
      // a track of another net 0.9 mm below it, along the whole stretch
      { op: 'draw_track', from: [8, 5.9], to: [32, 5.9], net: 'GND', layer: 'F.Cu', width_mm: 0.3 },
    ]);
    const was = len(track(k, 't1'));
    // (the bumps go up, away from it)
    ok(k, [{ op: 'tune_length', track: 't1', target_mm: was + 3 }]);
    expect(codes(k.board()).filter((c) => c.startsWith('DRC.') && c !== 'DRC.UNROUTED')).toEqual([]);
    const up = track(k, 't1').pts.filter((_, i) => i % 2 === 1);
    expect(Math.min(...up)).toBeLessThan(5 - 0.5);
    // forced down, between the two, there is none
    const k2 = usb();
    ok(k2, [
      { op: 'draw_track', from: 'J1.1', to: 'J2.1', via: [[8, 5], [32, 5]], bend: 'diagonal_first' },
      { op: 'draw_track', from: [8, 5.9], to: [32, 5.9], net: 'GND', layer: 'F.Cu', width_mm: 0.3 },
    ]);
    const m = refused(k2, [{ op: 'tune_length', track: 't1', target_mm: was + 3, side: 'right' }]).message;
    expect(m).toMatch(/t1 has no room for it/);
    expect(m).toMatch(/no bump of [\d.]+ mm on the right of the stretch at 8, 5/);
    expect(m).toMatch(/Fix: move what is in the way/);
  });

  it('refuses what cannot be meant, with a hint', () => {
    const k = usb();
    ok(k, [{ op: 'draw_track', from: 'J1.1', to: 'J2.1', via: [[8, 5], [32, 5]], bend: 'diagonal_first' }]);
    expect(refused(k, [{ op: 'tune_length', target_mm: 40 }]).message).toMatch(/the track \(its id\) or the net/);
    expect(refused(k, [{ op: 'tune_length', net: 'VBUS' }]).message).toMatch(/is in no pair: say the length/);
    expect(refused(k, [{ op: 'tune_length', net: 'USB_DN' }]).message).toMatch(/has no drawn track to put a meander in/);
    expect(refused(k, [{ op: 'tune_length', track: 't9', target_mm: 40 }]).code).toBe('REF_UNKNOWN');
    expect(refused(k, [{ op: 'tune_length', net: 'VBUS', target_mm: 10 }]).message).toMatch(/already .* mm longer than 10 mm/);
    const gap = refused(k, [{ op: 'tune_length', net: 'VBUS', target_mm: 40, gap_mm: 0.2 }]);
    expect(gap.message).toMatch(/at least 1\.5 mm \(3 widths\)/);
    expect(gap.fixHints?.[0]).toMatchObject({ op: 'tune_length', gap_mm: 1.5 });
    // far more than the board has room for
    expect(refused(k, [{ op: 'tune_length', net: 'VBUS', target_mm: 400 }]).message).toMatch(/mm fit, [\d.]+ mm short|none fits/);
    // a track that is on target already is left alone
    const was = len(track(k, 't1'));
    expect(ok(k, [{ op: 'tune_length', net: 'VBUS', target_mm: was + 0.05 }]).results[0]!.effect).toMatch(/nothing to add/);
  });
});
