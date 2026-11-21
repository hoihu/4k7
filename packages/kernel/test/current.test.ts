import { describe, expect, it } from 'vitest';
import { trackCurrentFor, trackRiseFor, trackWidthFor, type BoardView, type Diagnostic } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

/** The buck (+3V3 at max_current 2 A) with the copper drawn by hand, starting empty. */
function drawnBuck(ops: unknown[] = []) {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  ok(k, [{ op: 'set_copper_mode', mode: 'drawn', keep: false }, ...ops]);
  return k;
}

const ok = (k: Kernel, ops: unknown[]) => {
  const r = k.transact({ summary: 'test', ops });
  if (r.status !== 'ok') throw new Error(JSON.stringify(r));
  return r;
};
const find = (b: BoardView, code: string): Diagnostic[] => b.diagnostics.filter((x) => x.code === code);
type Map = { basis: { rise_c: number; copper_um: Record<string, number> }; nets: { net: string; status: string; worst_ratio?: number; max_current_a?: number }[]; hotspots: { kind: string; net: string; ratio: number; code: string; fix?: unknown[] }[] };
const currentMap = (k: Kernel, q: object = {}) => k.query({ op: 'get_current_map', ...q }) as Map;

/** IPC-2221 worked by hand: I = k ΔT^0.44 A^0.725, A in mil². */
const ipc = (wMm: number, um: number, dt: number) => 0.048 * dt ** 0.44 * ((wMm / 0.0254) * (um / 25.4)) ** 0.725;

describe('track capacity (IPC-2221 external curve)', () => {
  it('matches the formula worked by hand', () => {
    // 1 mm × 35 µm = 39.37 mil × 1.378 mil = 54.25 mil²; 0.048 · 10^0.44 · 54.25^0.725 = 0.1322 · 18.09 = 2.39 A
    expect(trackCurrentFor(1, 35, 10)).toBeCloseTo(2.39, 2);
    expect(trackCurrentFor(1, 35, 10)).toBeCloseTo(ipc(1, 35, 10), 9);
    expect(trackCurrentFor(0.25, 35, 10)).toBeCloseTo(0.875, 2);
    expect(trackCurrentFor(0.8, 15.2, 10)).toBeCloseTo(ipc(0.8, 15.2, 10), 9);
    expect(trackCurrentFor(0.5, 70, 30)).toBeCloseTo(ipc(0.5, 70, 30), 9);
    // the rise is the same curve solved for ΔT
    expect(trackRiseFor(trackCurrentFor(0.4, 35, 20), 0.4, 35)).toBeCloseTo(20, 6);
    expect(trackRiseFor(2, 0.25, 35)).toBeCloseTo(10 * (2 / 0.875) ** (1 / 0.44), -1);
    // the width it suggests carries the current (its copper too)
    expect(trackCurrentFor(trackWidthFor(2, 10, 15.2), 15.2, 10)).toBeGreaterThanOrEqual(2);
    expect(trackWidthFor(2, 10, 15.2)).toBeGreaterThan(2 * trackWidthFor(2));
  });
});

describe('current check on tracks', () => {
  it('a 0.25 mm track on a 2 A net is not verified (an error: over twice what it carries); 0.8 mm is fine', () => {
    const k = drawnBuck([{ op: 'draw_track', from: 'L1.2', to: 'C2.1', width_mm: 0.25 }]);
    const [f] = find(k.board(), 'DRC.CURRENT_UNVERIFIED');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.message).toMatch(/\+3V3/);
    expect(f!.message).toMatch(/0\.25 mm/);
    expect(f!.entities).toContain('t1');
    expect(f!.at).toBeDefined();
    expect(f!.fixHints?.[0]).toMatchObject({ op: 'edit_copper', ids: ['t1'], width_mm: 0.8 });
    ok(k, [{ op: 'edit_copper', ids: ['t1'], width_mm: 0.8 }]);
    expect(find(k.board(), 'DRC.CURRENT_UNVERIFIED')).toEqual([]);
    expect(currentMap(k).nets.find((n) => n.net === '+3V3')).toMatchObject({ status: 'ok', max_current_a: 2 });
  });

  it('between once and twice its capacity it is a warning', () => {
    // 0.5 mm carries about 1.45 A at 10 °C: 2 A is 1.4 times that
    const k = drawnBuck([{ op: 'draw_track', from: 'L1.2', to: 'C2.1', width_mm: 0.5 }]);
    const [f] = find(k.board(), 'DRC.CURRENT_UNVERIFIED');
    expect(f?.severity).toBe('warning');
    const m = currentMap(k);
    expect(m.nets.find((n) => n.net === '+3V3')).toMatchObject({ status: 'unverified' });
    expect(m.hotspots[0]).toMatchObject({ kind: 'track', net: '+3V3', code: 'DRC.CURRENT_UNVERIFIED' });
    expect(m.hotspots[0]!.ratio).toBeCloseTo(2 / trackCurrentFor(0.5), 1);
  });

  it('an inner layer with thinner copper needs a wider track: In1.Cu at 15.2 µm fails where F.Cu passes', () => {
    const on = (layer: string) => {
      const k = drawnBuck([
        { op: 'set_board', layers: 4 },
        { op: 'set_stackup', preset: 'JLC04161H-7628' },
        { op: 'set_plane', layer: 'In1.Cu', net: null },
        { op: 'draw_track', net: '+3V3', from: [17, 19], to: [23, 19], layer, width_mm: 0.8 },
      ]);
      return k;
    };
    const inner = on('In1.Cu');
    expect(find(inner.board(), 'DRC.CURRENT_UNVERIFIED')).toHaveLength(1);
    expect(currentMap(inner).basis.copper_um).toMatchObject({ 'F.Cu': 35, 'In1.Cu': 15.2 });
    expect(find(on('F.Cu').board(), 'DRC.CURRENT_UNVERIFIED')).toEqual([]);
    // get_net suggests a width per layer
    const net = inner.query({ op: 'get_net', net: '+3V3' }) as { track: { suggested_mm: Record<string, number> }; current: { status: string } };
    expect(net.track.suggested_mm['F.Cu']).toBe(0.8);
    expect(net.track.suggested_mm['In1.Cu']).toBeGreaterThan(1.5);
    expect(net.current.status).toBe('unverified');
  });

  it('a higher allowed rise relaxes the check; only 10, 20 and 30 °C are taken', () => {
    const k = drawnBuck([{ op: 'draw_track', from: 'L1.2', to: 'C2.1', width_mm: 0.5 }]);
    expect(find(k.board(), 'DRC.CURRENT_UNVERIFIED')).toHaveLength(1);
    const copper = k.draftDesign().board!.routed;
    ok(k, [{ op: 'set_board', current_rise_c: 30 }]);
    expect(find(k.board(), 'DRC.CURRENT_UNVERIFIED')).toEqual([]);
    expect(currentMap(k).basis.rise_c).toBe(30);
    expect(k.draftDesign().board!.routed).toBe(copper);
    expect(k.transact({ summary: 'x', ops: [{ op: 'set_board', current_rise_c: 15 }] }).status).not.toBe('ok');
  });
});

describe('current check on vias between layers', () => {
  // the +3V3 pour on F.Cu round L1.2 (its only pad there), +3V3 on all of B.Cu, C2.1 and R1.1 each
  // dropping to B.Cu through a via of their own: the via at (21.5, 3) is the only way between them
  const twoZones = (more: unknown[] = []) =>
    drawnBuck([
      { op: 'set_plane', layer: 'B.Cu', net: '+3V3' },
      { op: 'set_plane', layer: 'F.Cu', net: '+3V3', rect: { x_mm: 15.2, y_mm: 0.6, width_mm: 8.2, height_mm: 4.6 } },
      { op: 'draw_via', at: [21.8, 3], net: '+3V3' },
      { op: 'draw_via', at: [21.8, 12.9], net: '+3V3' },
      { op: 'draw_track', from: 'C2.1', to: [21.8, 12.9] },
      { op: 'draw_via', at: [15, 17.6], net: '+3V3' },
      { op: 'draw_track', from: 'R1.1', to: [15, 17.6] },
      ...more,
    ]);

  it('one via joining two pours of a 2 A net is too few', () => {
    const k = twoZones();
    const fs = find(k.board(), 'DRC.VIA_CURRENT');
    expect(fs).toHaveLength(1);
    expect(fs[0]!.severity).toBe('error'); // one 0.3 mm via carries about 0.9 A: 2 A is over twice that
    expect(fs[0]!.at).toEqual({ x: 21.8, y: 3 });
    expect(fs[0]!.fixHints?.[0]).toMatchObject({ op: 'add_vias', kind: 'tie', net: '+3V3', amps: 2 });
    const spot = currentMap(k).hotspots.find((h) => h.kind === 'via_group');
    expect(spot).toMatchObject({ code: 'DRC.VIA_CURRENT', net: '+3V3' });
  });

  it('enough vias there clear it (more drawn beside it, or a tie)', () => {
    const k = twoZones([
      { op: 'draw_via', at: [22.6, 3], net: '+3V3' },
      { op: 'draw_via', at: [21.8, 3.8], net: '+3V3' },
    ]);
    expect(find(k.board(), 'DRC.VIA_CURRENT')).toEqual([]);
    const t = twoZones([{ op: 'add_vias', kind: 'tie', net: '+3V3', at: [{ x_mm: 21.5, y_mm: 2.2 }], amps: 2 }]);
    expect(find(t.board(), 'DRC.VIA_CURRENT')).toEqual([]);
  });

  it('a second way between the layers means the via is not the only path: no finding', () => {
    const k = twoZones([{ op: 'draw_via', at: [16, 1.4], net: '+3V3' }]);
    expect(find(k.board(), 'DRC.VIA_CURRENT')).toEqual([]);
  });
});

describe('unknown current', () => {
  it('a power net with copper and no max_current is unknown, never ok', () => {
    const k = drawnBuck([{ op: 'draw_track', from: 'J1.1', to: 'C1.1', width_mm: 2 }]);
    const f = find(k.board(), 'DRC.CURRENT_UNKNOWN').filter((x) => x.entities.includes('net:+12V'));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('info');
    const m = currentMap(k, { worst: 0 });
    expect(m.nets.find((n) => n.net === '+12V')).toMatchObject({ status: 'unknown' });
    expect(m.nets.every((n) => n.status !== 'ok' || n.max_current_a)).toBe(true);
  });
});

describe('routed copper', () => {
  it('max_current set after routing is checked on the copper as it is, without routing again', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    ok(k, [{ op: 'set_net', net: '+3V3', max_current: null }, { op: 'route' }]);
    k.accept();
    k.keepCopper(k.board().newCopper!);
    const key = k.draftDesign().board!.copper!.key;
    expect(find(k.board(), 'DRC.CURRENT_UNKNOWN').some((x) => x.entities.includes('net:+3V3'))).toBe(true);
    ok(k, [{ op: 'set_net', net: '+3V3', max_current: 6 }]);
    const b = k.board();
    expect(b.newCopper).toBeUndefined();
    expect(k.draftDesign().board!.copper!.key).toBe(key);
    expect(find(b, 'DRC.CURRENT_UNKNOWN').some((x) => x.entities.includes('net:+3V3'))).toBe(false);
    expect(find(b, 'DRC.CURRENT_UNVERIFIED').some((x) => x.entities.includes('net:+3V3'))).toBe(true);
  });
});

describe('BoardView.current (what the heat map draws)', () => {
  type Spot = { kind: string; net: string; ratio: number; rise_c?: number; width_mm?: number; basis: string; vias?: number };
  const spots = (k: Kernel) => (k.query({ op: 'get_current_map', include_ok: true, worst: 200 }) as { hotspots: Spot[] }).hotspots;

  it('carries the same numbers per track and via group as get_current_map', () => {
    const k = drawnBuck([
      { op: 'set_plane', layer: 'B.Cu', net: '+3V3' },
      { op: 'set_plane', layer: 'F.Cu', net: '+3V3', rect: { x_mm: 15.2, y_mm: 0.6, width_mm: 8.2, height_mm: 4.6 } },
      { op: 'draw_via', at: [21.8, 3], net: '+3V3' },
      { op: 'draw_via', at: [21.8, 12.9], net: '+3V3' },
      { op: 'draw_track', from: 'C2.1', to: [21.8, 12.9], width_mm: 0.25 },
      { op: 'draw_via', at: [15, 17.6], net: '+3V3' },
      { op: 'draw_track', from: 'R1.1', to: [15, 17.6], width_mm: 0.5 },
    ]);
    const b = k.board();
    const c = b.current!;
    expect(c.riseC).toBe(10);
    expect(c.tracks.length).toBeGreaterThan(0);
    expect(c.vias.length).toBe(1);
    const map = spots(k);
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    for (const t of c.tracks) {
      // the index points at the track it describes
      expect(b.tracks[t.index]!.netId).toBe(t.netId);
      expect(b.tracks[t.index]!.width).toBe(t.width);
      expect(t.basis).toBe('bound');
      expect(map.some((s) => s.kind === 'track' && s.width_mm === t.width && s.ratio === r2(t.ratio) && s.rise_c === r1(t.rise) && s.basis === t.basis)).toBe(true);
    }
    const [v] = c.vias;
    expect(map.find((s) => s.kind === 'via_group')).toMatchObject({ ratio: r2(v!.ratio), vias: v!.vias, basis: 'bound' });
  });

  it('a power net without max_current carries basis unknown', () => {
    const k = drawnBuck([{ op: 'draw_track', from: 'J1.1', to: 'C1.1', width_mm: 2 }]);
    const n = k.board().current!.nets.find((x) => x.name === '+12V');
    expect(n).toMatchObject({ basis: 'unknown', status: 'unknown' });
    expect(n!.amps).toBeUndefined();
  });

  it('follows max_current and current_rise_c on the copper as it is (no routing again)', () => {
    const k = drawnBuck([{ op: 'draw_track', from: 'L1.2', to: 'C2.1', width_mm: 0.5 }]);
    const copper = k.draftDesign().board!.routed;
    const at = (b: BoardView) => b.current!.tracks.find((t) => b.netNames[t.netId] === '+3V3')!;
    const before = at(k.board());
    expect(before.amps).toBe(2);
    ok(k, [{ op: 'set_net', net: '+3V3', max_current: 1 }]);
    const lower = at(k.board());
    expect(lower.amps).toBe(1);
    expect(lower.rise).toBeLessThan(before.rise);
    ok(k, [{ op: 'set_board', current_rise_c: 20 }]);
    const relaxed = k.board();
    expect(relaxed.current!.riseC).toBe(20);
    expect(at(relaxed).ratio).toBeLessThan(lower.ratio);
    expect(at(relaxed).rise).toBeCloseTo(lower.rise, 9);
    expect(k.draftDesign().board!.routed).toBe(copper);
  });

  it('is absent until the board is routed', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    expect(k.board().current).toBeUndefined();
  });
});

describe('loads and the split (set_net loads)', () => {
  type Track = { kind: string; net: string; id?: string; width_mm: number; length_mm: number; copper_um: number; amps: number; basis: string; status: string; ratio: number; drop_mv?: number; code?: string; fix?: unknown[] };
  type NetRow = { net: string; basis: string; status: string; max_current_a?: number; loads_a?: number; unplaced_a?: number; ir_drop_mv?: number; ir_drop_pct?: number; ir_budget_mv?: number; ir_budget?: string; ir_load?: string; ir_status?: string; why?: string };
  const map = (k: Kernel) => k.query({ op: 'get_current_map', include_ok: true, worst: 200 }) as { nets: NetRow[]; hotspots: Track[] };
  const track = (k: Kernel, id: string) => map(k).hotspots.find((h) => h.kind === 'track' && h.id === id)!;
  const net = (k: Kernel, name = '+3V3') => map(k).nets.find((n) => n.net === name)!;
  // L1.2 (where +3V3 comes in: the inductor from SW) at (17.8, 3.6), C2.1 at (20.1, 12.9), R1.1 at (15, 16.2)
  const mainAndStub = (more: unknown[] = []) =>
    drawnBuck([
      { op: 'draw_track', from: 'L1.2', to: 'C2.1', width_mm: 1 },
      { op: 'draw_track', from: 'C2.1', to: 'R1.1', width_mm: 0.25 },
      ...more,
    ]);

  it('a stub to a part that draws little passes once the loads are stated (split); without loads it stays unverified', () => {
    const bare = mainAndStub();
    expect(find(bare.board(), 'DRC.CURRENT_UNVERIFIED')).toHaveLength(1);
    expect(track(bare, 't2')).toMatchObject({ basis: 'bound', status: 'unverified' });
    const k = mainAndStub([{ op: 'set_net', net: '+3V3', loads: [{ pin: 'C2.1', amps: 1.8 }, { pin: 'R1.1', amps: 0.001 }] }]);
    const b = k.board();
    expect(find(b, 'DRC.CURRENT_UNVERIFIED')).toEqual([]);
    expect(find(b, 'DRC.TRACK_CURRENT')).toEqual([]);
    expect(track(k, 't2')).toMatchObject({ basis: 'split', status: 'ok' });
    expect(track(k, 't1')).toMatchObject({ basis: 'split', status: 'ok' });
    expect(net(k)).toMatchObject({ basis: 'split', status: 'ok', loads_a: 1.801 });
  });

  it('a track too narrow for its split current: DRC.TRACK_CURRENT, a warning to twice its capacity, an error over; the hinted width clears it', () => {
    const at = (w: number) => drawnBuck([{ op: 'draw_track', from: 'L1.2', to: 'C2.1', width_mm: w }, { op: 'set_net', net: '+3V3', loads: [{ pin: 'C2.1', amps: 2 }] }]);
    const warn = at(0.5);
    const [w] = find(warn.board(), 'DRC.TRACK_CURRENT');
    expect(w?.severity).toBe('warning');
    expect(find(warn.board(), 'DRC.CURRENT_UNVERIFIED')).toEqual([]);
    const k = at(0.25);
    const [f] = find(k.board(), 'DRC.TRACK_CURRENT');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.message).toMatch(/\+3V3/);
    expect(f!.message).toMatch(/0\.25 mm/);
    expect(f!.message).toMatch(/F\.Cu/);
    expect(f!.message).toMatch(/35 µm/);
    expect(f!.message).toMatch(/2 A/);
    expect(f!.message).toMatch(/0\.8 mm/);
    expect(f!.message).toMatch(/°C/);
    expect(f!.entities).toContain('t1');
    expect(f!.fixHints?.[0]).toMatchObject({ op: 'edit_copper', ids: ['t1'], width_mm: 0.8 });
    expect(track(k, 't1')).toMatchObject({ basis: 'split', status: 'over', code: 'DRC.TRACK_CURRENT' });
    expect(net(k)).toMatchObject({ basis: 'split', status: 'over' });
    ok(k, [f!.fixHints![0]!]);
    expect(find(k.board(), 'DRC.TRACK_CURRENT')).toEqual([]);
  });

  it('a tree: each branch carries its own load, the trunk the sum', () => {
    const k = drawnBuck([
      { op: 'draw_track', from: 'L1.2', to: [17.8, 14], width_mm: 1 },
      { op: 'draw_track', net: '+3V3', from: [17.8, 14], to: 'C2.1', width_mm: 0.6 },
      { op: 'draw_track', net: '+3V3', from: [17.8, 14], to: 'R1.1', via: [[17.8, 17.2]], width_mm: 0.4 },
      { op: 'set_net', net: '+3V3', loads: [{ pin: 'C2.1', amps: 1.2 }, { pin: 'R1.1', amps: 0.8 }] },
    ]);
    expect(track(k, 't1').amps).toBeCloseTo(2, 6);
    expect(track(k, 't2').amps).toBeCloseTo(1.2, 6);
    expect(track(k, 't3').amps).toBeCloseTo(0.8, 6);
    expect(track(k, 't3')).toMatchObject({ basis: 'split', status: 'ok' });
  });

  it('a loop: two tracks side by side split the current by conductance, the wider carrying more', () => {
    const k = drawnBuck([
      { op: 'draw_track', from: 'L1.2', to: 'C2.1', width_mm: 1 },
      { op: 'draw_track', from: 'L1.2', to: 'C2.1', via: [[22.5, 3.6], [22.5, 12.9]], width_mm: 0.5 },
      { op: 'set_net', net: '+3V3', loads: [{ pin: 'C2.1', amps: 2 }] },
    ]);
    const [a, b] = [track(k, 't1'), track(k, 't2')];
    expect(a.amps + b.amps).toBeCloseTo(2, 6);
    // conductance w / L each (the same copper)
    const ga = 1 / a.length_mm;
    const gb = 0.5 / b.length_mm;
    expect(a.amps).toBeCloseTo((2 * ga) / (ga + gb), 2);
    expect(a.amps).toBeGreaterThan(b.amps);
  });

  it('add_vias drop amps on a pad states its load; naming it in loads as well does not count it twice', () => {
    const drop = { op: 'add_vias', kind: 'drop', ref: 'C2', pad: '1', at: [{ x_mm: 22.1, y_mm: 12.9 }], amps: 1.8 };
    const k = mainAndStub([drop, { op: 'set_net', net: '+3V3', loads: [{ pin: 'R1.1', amps: 0.001 }] }]);
    expect(net(k).loads_a).toBeCloseTo(1.801, 6);
    expect(track(k, 't1').amps).toBeCloseTo(1.801 + 0.199, 6);
    const both = mainAndStub([drop, { op: 'set_net', net: '+3V3', loads: [{ pin: 'C2.1', amps: 1.5 }, { pin: 'R1.1', amps: 0.001 }] }]);
    // the explicit load wins
    expect(net(both).loads_a).toBeCloseTo(1.501, 6);
  });

  it('two sources and no ratio: the net falls back to bound', () => {
    const k = mainAndStub([
      { op: 'add_part', part: 'generic:L', refdes: 'L2', params: { inductance: '10uH', current: '3.2A', package: 'IND-4x4' } },
      { op: 'connect', pins: ['L2.1'], net: 'SW' },
      { op: 'connect', pins: ['L2.2'], net: '+3V3' },
      { op: 'set_net', net: '+3V3', loads: [{ pin: 'C2.1', amps: 1.8 }, { pin: 'R1.1', amps: 0.001 }] },
    ]);
    expect(net(k)).toMatchObject({ basis: 'bound' });
    expect(net(k).why).toMatch(/source/);
    expect(track(k, 't2')).toMatchObject({ basis: 'bound', status: 'unverified' });
    expect(find(k.board(), 'DRC.CURRENT_UNVERIFIED')).toHaveLength(1);
  });

  it('loads that place less than max_current: the rest is reported, and copper the rest could flow through is not ok', () => {
    const k = mainAndStub([{ op: 'set_net', net: '+3V3', loads: [{ pin: 'C2.1', amps: 0.5 }] }]);
    expect(net(k)).toMatchObject({ basis: 'split', loads_a: 0.5, unplaced_a: 1.5, max_current_a: 2 });
    expect(net(k).status).not.toBe('ok');
    // the stub draws nothing of the stated loads, but 1.5 A may still flow there
    expect(track(k, 't2')).toMatchObject({ basis: 'split', status: 'unverified' });
    expect(find(k.board(), 'DRC.CURRENT_UNVERIFIED')).toHaveLength(1);
    expect(find(k.board(), 'DRC.TRACK_CURRENT')).toEqual([]);
  });

  it('set_net loads is checked: an unknown pin, a pin on another net and amps ≤ 0 are refused; null clears', () => {
    const k = mainAndStub();
    const no = (loads: unknown) => k.transact({ summary: 'x', ops: [{ op: 'set_net', net: '+3V3', loads }] }).status;
    expect(no([{ pin: 'U9.1', amps: 1 }])).not.toBe('ok');
    expect(no([{ pin: 'C2.2', amps: 1 }])).not.toBe('ok');
    expect(no([{ pin: 'C2.1', amps: 0 }])).not.toBe('ok');
    expect(no([{ pin: 'C2.1', amps: -1 }])).not.toBe('ok');
    ok(k, [{ op: 'set_net', net: '+3V3', loads: [{ pin: 'C2.1', amps: 2 }] }]);
    expect(k.draftDesign().nets[Object.values(k.draftDesign().nets).find((n) => n.name === '+3V3')!.id]!.attrs.loads).toHaveLength(1);
    expect(net(k).basis).toBe('split');
    ok(k, [{ op: 'set_net', net: '+3V3', loads: null }]);
    expect(Object.values(k.draftDesign().nets).find((n) => n.name === '+3V3')!.attrs.loads).toBeUndefined();
    expect(net(k).basis).toBe('bound');
  });

  it('changing the loads checks again without routing; the drop along the copper is worked out (V = I · ρL / (w · t))', () => {
    const k = drawnBuck([{ op: 'draw_track', from: 'L1.2', to: 'C2.1', width_mm: 1 }]);
    const copper = k.draftDesign().board!.routed;
    ok(k, [{ op: 'set_net', net: '+3V3', loads: [{ pin: 'C2.1', amps: 2 }] }]);
    expect(k.draftDesign().board!.routed).toBe(copper);
    const t = track(k, 't1');
    const ohms = (1.72e-8 * t.length_mm * 1e-3) / (1e-3 * t.copper_um * 1e-6);
    expect(t.drop_mv).toBeCloseTo(2 * ohms * 1000, 1);
    expect(net(k).ir_drop_mv).toBeCloseTo(2 * ohms * 1000, 1);
    expect(k.board().current!.nets.find((n) => n.name === '+3V3')!.dropMv).toBeCloseTo(2 * ohms * 1000, 1);
    ok(k, [{ op: 'set_net', net: '+3V3', loads: [{ pin: 'C2.1', amps: 1 }] }]);
    expect(track(k, 't1').amps).toBeCloseTo(1 + 1, 6); // 1 A placed, 1 A of max_current not
    expect(k.draftDesign().board!.routed).toBe(copper);
  });

  it('loads set after routing check the router copper again without routing (the copper key holds)', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    ok(k, [{ op: 'route' }]);
    k.accept();
    k.keepCopper(k.board().newCopper!);
    const key = k.draftDesign().board!.copper!.key;
    ok(k, [{ op: 'set_net', net: '+3V3', loads: [{ pin: 'C2.1', amps: 1.9 }, { pin: 'R1.1', amps: 0.0003 }] }]);
    const b = k.board();
    expect(b.newCopper).toBeUndefined();
    expect(k.draftDesign().board!.copper!.key).toBe(key);
    expect(b.current!.nets.find((n) => n.name === '+3V3')!.basis).toBe('split');
  });

  it('GND without max_current is bound by the sum of the rails when every rail with copper has one', () => {
    const k = drawnBuck([
      { op: 'draw_track', from: 'J1.1', to: 'C1.1', width_mm: 2 },
      { op: 'draw_track', from: 'J1.2', to: 'C1.2', width_mm: 0.25 },
    ]);
    expect(net(k, 'GND')).toMatchObject({ basis: 'unknown' });
    ok(k, [{ op: 'set_net', net: '+12V', max_current: 1 }]);
    // +12V 1 A and +3V3 2 A
    expect(net(k, 'GND')).toMatchObject({ basis: 'bound', max_current_a: 3 });
    expect(net(k, 'GND').why).toMatch(/rails/);
  });
});

describe('IR drop against 3 % of the rail (DRC.IR_DROP)', () => {
  type NetRow = { net: string; basis: string; ir_drop_mv?: number; ir_drop_pct?: number; ir_budget_mv?: number; ir_budget?: string; ir_why?: string; ir_load?: string; ir_status?: string; ir_worst?: { kind: string; id?: string; drop_mv: number }[] };
  type Spot = { kind: string; id?: string; length_mm: number; copper_um: number; width_mm: number };
  const map = (k: Kernel) => k.query({ op: 'get_current_map', include_ok: true, worst: 200 }) as { nets: NetRow[]; hotspots: Spot[] };
  const row = (k: Kernel, name = '+3V3') => map(k).nets.find((n) => n.net === name)!;
  // +3V3 (3.3 V: a budget of 99 mV) from L1.2 the long way round to C2.1
  const longWay = (width: number, loads: unknown, more: unknown[] = []) =>
    drawnBuck([
      { op: 'draw_track', from: 'L1.2', to: 'C2.1', via: [[17.8, -8], [40, -8], [40, 12.9]], width_mm: width },
      ...(loads ? [{ op: 'set_net', net: '+3V3', loads }] : []),
      ...more,
    ]);

  it('a 1.5 A load at the end of a long thin track drops more than 99 mV: a warning naming the load and the track; widening clears it', () => {
    const k = longWay(0.3, [{ pin: 'C2.1', amps: 1.5 }]);
    const t = map(k).hotspots.find((h) => h.kind === 'track' && h.id === 't1')!;
    // R = ρL / (w · t)
    const mv = 1.5 * ((1.72e-8 * t.length_mm * 1e-3) / (0.3e-3 * t.copper_um * 1e-6)) * 1000;
    expect(mv).toBeGreaterThan(99);
    expect(mv).toBeLessThan(198);
    const r = row(k);
    expect(r.ir_drop_mv).toBeCloseTo(mv, 0);
    expect(r).toMatchObject({ ir_budget_mv: 99, ir_load: 'C2.1', ir_status: 'over' });
    expect(r.ir_drop_pct).toBeCloseTo(mv / 33, 1);
    expect(r.ir_worst?.[0]).toMatchObject({ kind: 'track', id: 't1' });
    const [f] = find(k.board(), 'DRC.IR_DROP');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.message).toMatch(/\+3V3/);
    expect(f!.message).toMatch(/C2\.1/);
    expect(f!.message).toMatch(/99 mV/);
    expect(f!.message).toMatch(/t1/);
    expect(f!.entities).toEqual(expect.arrayContaining(['net:+3V3', 'C2.1', 't1']));
    expect(f!.fixHints?.[0]).toMatchObject({ op: 'edit_copper', ids: ['t1'] });
    ok(k, f!.fixHints!);
    expect(find(k.board(), 'DRC.IR_DROP')).toEqual([]);
    expect(row(k).ir_status).toBe('ok');
  });

  it('over 6 % of the rail it is an error', () => {
    const [f] = find(longWay(0.15, [{ pin: 'C2.1', amps: 1.5 }]).board(), 'DRC.IR_DROP');
    expect(f?.severity).toBe('error');
  });

  it('two loads: the finding names the one furthest down', () => {
    // R1.1 on a short stub near the source, C2.1 at the end of the long way
    const k = longWay(0.3, [{ pin: 'C2.1', amps: 1.5 }, { pin: 'R1.1', amps: 0.1 }], [{ op: 'draw_track', from: 'L1.2', to: 'R1.1', width_mm: 0.3 }]);
    expect(row(k).ir_load).toBe('C2.1');
    expect(find(k.board(), 'DRC.IR_DROP')[0]!.message).toMatch(/to C2\.1/);
  });

  it('no loads: no IR drop is judged (bound); changing the loads checks again without routing', () => {
    const k = longWay(0.3, null);
    expect(find(k.board(), 'DRC.IR_DROP')).toEqual([]);
    expect(row(k).basis).toBe('bound');
    expect(row(k).ir_drop_mv).toBeUndefined();
    const copper = k.draftDesign().board!.routed;
    ok(k, [{ op: 'set_net', net: '+3V3', loads: [{ pin: 'C2.1', amps: 1.5 }] }]);
    expect(find(k.board(), 'DRC.IR_DROP')).toHaveLength(1);
    ok(k, [{ op: 'set_net', net: '+3V3', loads: [{ pin: 'C2.1', amps: 0.5 }] }]);
    expect(find(k.board(), 'DRC.IR_DROP')).toEqual([]);
    expect(k.draftDesign().board!.routed).toBe(copper);
  });

  it('a rail without a voltage: no finding, and the budget is unknown (never fine)', () => {
    const k = longWay(0.3, [{ pin: 'C2.1', amps: 1.5 }], [{ op: 'set_net', net: '+3V3', voltage: null }]);
    expect(find(k.board(), 'DRC.IR_DROP')).toEqual([]);
    const r = row(k);
    expect(r.ir_budget).toBe('unknown');
    expect(r.ir_why).toMatch(/voltage/);
    expect(r.ir_status).toBeUndefined();
    expect(r.ir_drop_mv).toBeGreaterThan(99);
  });
});

describe('thermal-relief joints against their current (DRC.SPOKE_CURRENT)', () => {
  type Relief = { kind: string; net: string; ref?: string; spokes: number; spoke_mm: number; amps: number; basis: string; status: string; capacity_a: number; code?: string; fix?: unknown[] };
  const reliefs = (k: Kernel) => (k.query({ op: 'get_current_map', include_ok: true, worst: 200 }) as { hotspots: Relief[] }).hotspots.filter((h) => h.kind === 'relief');
  // a +3V3 pour on F.Cu round L1.2 (where +3V3 comes in: the inductor), C2.1 and R1.1, every pad
  // joined to it through four 0.25 mm spokes and nothing else
  const pour = (more: unknown[] = []) =>
    drawnBuck([
      { op: 'set_plane', layer: 'F.Cu', net: '+3V3', rect: { x_mm: 13, y_mm: 0.6, width_mm: 11, height_mm: 17 } },
      { op: 'set_plane_style', layer: 'F.Cu', net: '+3V3', spoke_mm: 0.25 },
      ...more,
    ]);
  // one 0.25 mm spoke on 35 µm: 9.84 mil × 1.378 mil = 13.56 mil²; 0.048 · 10^0.44 · 13.56^0.725 =
  // 0.1322 · 6.62 = 0.875 A, so four carry 3.5 A at 10 °C: a 2 A pad passes (with 1 oz copper a 2 A
  // pad needs fewer spokes or thinner copper to fail), 5 A is 1.43 times that, 8 A over twice
  const four = 4 * trackCurrentFor(0.25, 35, 10);

  it('the pad where the current comes in, through 4 × 0.25 mm spokes at 5 A: a warning; 2 A passes, 8 A is an error', () => {
    expect(four).toBeCloseTo(3.5, 1);
    const k = pour([{ op: 'set_net', net: '+3V3', max_current: 5 }]);
    const fs = find(k.board(), 'DRC.SPOKE_CURRENT');
    expect(fs).toHaveLength(1);
    const [f] = fs;
    expect(f!.severity).toBe('warning');
    expect(f!.at).toEqual({ x: 17.8, y: 3.6 });
    expect(f!.entities).toEqual(['net:+3V3', 'L1.2']);
    expect(f!.message).toMatch(/L1\.2 .*4 thermal spokes of 0\.25 mm: together about 3\.5 A at 10 °C.*5 A/);
    expect(f!.message).toMatch(/add_vias kind drop/);
    expect(f!.message).not.toMatch(/max_current lower|lower the/);
    expect(f!.fixHints).toContainEqual(expect.objectContaining({ op: 'add_vias', kind: 'drop', ref: 'L1', pad: '2', amps: 5 }));
    expect(f!.fixHints).toContainEqual({ op: 'set_plane_style', layer: 'F.Cu', net: '+3V3', spoke_mm: 0.45 });
    const [r] = reliefs(k);
    expect(r).toMatchObject({ ref: 'L1.2', spokes: 4, spoke_mm: 0.25, amps: 5, basis: 'bound', status: 'unverified', code: 'DRC.SPOKE_CURRENT' });
    expect(r!.capacity_a).toBeCloseTo(four, 2);
    // the 2 A of the fixture fits; 8 A is over twice
    expect(find(pour().board(), 'DRC.SPOKE_CURRENT')).toEqual([]);
    expect(find(pour([{ op: 'set_net', net: '+3V3', max_current: 8 }]).board(), 'DRC.SPOKE_CURRENT')[0]?.severity).toBe('error');
  });

  it('thicker copper or a higher allowed rise carries more: 2 oz and 30 °C each clear 5 A', () => {
    // 70 µm: 3.5 · 2^0.725 = 5.79 A; 30 °C: 3.5 · 3^0.44 = 5.67 A
    expect(4 * trackCurrentFor(0.25, 70, 10)).toBeGreaterThan(5);
    expect(4 * trackCurrentFor(0.25, 35, 30)).toBeGreaterThan(5);
    const thick = pour([{ op: 'set_fab_profile', preset: 'jlcpcb/2l-2oz' }, { op: 'set_net', net: '+3V3', max_current: 5 }]);
    expect(thick.board().current!.copperUm['F.Cu']).toBe(70);
    expect(find(thick.board(), 'DRC.SPOKE_CURRENT')).toEqual([]);
    expect(reliefs(thick).find((r) => r.ref === 'L1.2')).toMatchObject({ status: 'ok' });
    const warm = pour([{ op: 'set_board', current_rise_c: 30 }, { op: 'set_net', net: '+3V3', max_current: 5 }]);
    expect(find(warm.board(), 'DRC.SPOKE_CURRENT')).toEqual([]);
  });

  it('the same pad dropped onto the pour with grouped vias joins solid: no finding', () => {
    const k = pour([
      { op: 'set_net', net: '+3V3', max_current: 5 },
      { op: 'add_vias', kind: 'drop', ref: 'L1', pad: '2', at: [{ x_mm: 20.45, y_mm: 3.6 }, { x_mm: 15.15, y_mm: 3.6 }, { x_mm: 17.8, y_mm: 2.25 }], amps: 5 },
    ]);
    expect(find(k.board(), 'DRC.SPOKE_CURRENT')).toEqual([]);
    expect(reliefs(k).find((r) => r.ref === 'L1.2')).toBeUndefined();
  });

  it('with the loads stated: a pad drawing 4 A is over, a pull-up drawing 1 mA passes, and the lone pads are not checked for the bound', () => {
    const bound = pour([{ op: 'set_net', net: '+3V3', max_current: 5 }]);
    // (C2.1 and R1.1 alone on the pour: whether 5 A flows through them is not known, so not flagged)
    expect(reliefs(bound).map((r) => r.ref)).toEqual(['L1.2']);
    const k = pour([{ op: 'set_net', net: '+3V3', max_current: 5, loads: [{ pin: 'C2.1', amps: 4 }, { pin: 'R1.1', amps: 0.001 }] }]);
    const fs = find(k.board(), 'DRC.SPOKE_CURRENT');
    // (L1.2 too: all 5 A comes in through its spokes, 4 A of it placed)
    expect(fs.map((f) => f.entities[1]).sort()).toEqual(['C2.1', 'L1.2']);
    expect(fs.find((f) => f.entities[1] === 'C2.1')!.message).toMatch(/4 A of the stated loads/);
    expect(reliefs(k).find((r) => r.ref === 'C2.1')).toMatchObject({ basis: 'split', status: 'over', amps: 4 });
    expect(reliefs(k).find((r) => r.ref === 'R1.1')).toMatchObject({ basis: 'split', status: 'ok', amps: 0.001 });
  });

  it('a net whose current is unknown: no finding, and no joint reported as fine', () => {
    const k = drawnBuck([
      { op: 'set_plane', layer: 'F.Cu', net: '+12V', rect: { x_mm: 0.6, y_mm: 4, width_mm: 12, height_mm: 8 } },
      { op: 'set_plane_style', layer: 'F.Cu', net: '+12V', spoke_mm: 0.15 },
    ]);
    const b = k.board();
    expect(find(b, 'DRC.SPOKE_CURRENT')).toEqual([]);
    expect(b.current!.joints.filter((j) => b.netNames[j.netId] === '+12V')).toEqual([]);
    expect(reliefs(k).filter((r) => r.net === '+12V')).toEqual([]);
    expect(currentMap(k).nets.find((n) => n.net === '+12V')).toMatchObject({ status: 'unknown' });
  });
});
