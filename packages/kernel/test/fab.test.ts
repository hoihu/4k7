import { describe, expect, it } from 'vitest';
import { eurocircuitsClass, fabPresets, findFabPreset, raiseRules, DEFAULT_RULES } from '@tracewise/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

function buck() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k;
}

const ops = (k: Kernel, ...o: unknown[]) => k.transact({ summary: 'fab', ops: o as never });
const codes = (k: Kernel) => k.board().diagnostics.map((d) => d.code);
const IMPORT = { op: 'set_fab_profile', house: 'Acme Boards', tier: 'standard', source_url: 'https://acme.example/capabilities', checked: '2026-10-09' };

describe('fab presets', () => {
  it('lists JLCPCB, PCBWay and Eurocircuits, every one with a source and date', () => {
    const all = fabPresets();
    expect(new Set(all.map((p) => p.house))).toEqual(new Set(['JLCPCB', 'PCBWay', 'Eurocircuits']));
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    for (const p of all) {
      expect(p.source.url).toMatch(/^https:\/\//);
      expect(p.source.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.limits.track).toBeGreaterThan(0);
      expect(p.limits.clearance).toBeGreaterThan(0);
    }
  });

  it('resolves a house alone by the board\'s layer count, and loose spellings', () => {
    const id = (q: string, layers: 2 | 4 = 2) => {
      const r = findFabPreset(q, layers);
      return r.ok ? r.profile.id : r.message;
    };
    expect(id('jlcpcb')).toBe('jlcpcb/2l-1oz');
    expect(id('JLC', 4)).toBe('jlcpcb/4l-1oz');
    expect(id('JLCPCB 4L 2oz')).toBe('jlcpcb/4l-2oz');
    expect(id('jlcpcb/2oz', 4)).toBe('jlcpcb/4l-2oz');
    expect(id('PCB Way', 4)).toBe('pcbway/4l-1oz');
    expect(id('eurocircuits')).toBe('eurocircuits/6C');
    expect(id('Eurocircuits 7D')).toBe('eurocircuits/7D');
    expect(id('eurocircuits/5c')).toBe('eurocircuits/5C');
    expect(id('eurocircuits/2Z')).toMatch(/pattern class 3–9/);
    expect(id('seeed')).toMatch(/No fab profile/);
    expect(id('jlcpcb/9l')).toMatch(/no tier/);
  });

  it('reads Eurocircuits classes off their classification table', () => {
    const c = eurocircuitsClass('6C')!.limits;
    expect([c.track, c.clearance, c.pthDrill, c.npthDrill]).toEqual([0.15, 0.15, 0.25, 0.35]);
    expect(c.annularRing).toBeCloseTo(0.175, 6); // OAR 0.125 from the drill tool, + 0.05 from the finished hole
    expect(c.viaPad).toBeCloseTo(0.25 + 2 * 0.175, 6);
    expect([c.copperToEdge, c.copperToEdgeInner]).toEqual([0.25, 0.4]);
    const e = eurocircuitsClass('8D')!.limits;
    expect([e.track, e.pthDrill]).toEqual([0.1, 0.15]);
    expect(eurocircuitsClass('2A')).toBeUndefined();
  });
});

describe('set_fab_profile', () => {
  it('stores a preset in the design and shows it in get_board and the changeset', () => {
    const k = buck();
    const r = ops(k, { op: 'set_fab_profile', preset: 'jlcpcb' });
    expect(r.status).toBe('ok');
    expect(k.board().fab?.id).toBe('jlcpcb/2l-1oz');
    const summary = k.query({ op: 'get_board' }) as { fab: { id: string; summary: string } };
    expect(summary.fab.id).toBe('jlcpcb/2l-1oz');
    expect(summary.fab.summary).toContain('JLCPCB');
    const board = k.proposal()!.hunks.find((h) => h.kind === 'board')!;
    expect(board.details?.join(' ')).toContain('made by JLCPCB');
    // the defaults are above JLCPCB's limits: nothing is raised, no fab diagnostics
    expect(codes(k).filter((c) => c.startsWith('DRC.FAB'))).toEqual([]);
  });

  it('raises rules that are below the limits, never lowers them', () => {
    const k = buck();
    ops(k, { op: 'set_board', clearance_mm: 0.1, track_mm: 0.12 });
    const r = ops(k, { op: 'set_fab_profile', preset: 'eurocircuits/6C' });
    expect(r.status).toBe('ok');
    const rules = k.board().rules;
    expect(rules.clearance).toBe(0.15);
    expect(rules.track).toBe(0.15);
    expect(rules.powerTrack).toBe(DEFAULT_RULES.powerTrack); // above the limit already
    expect(JSON.stringify(r)).toContain('raised to the limit');
    const up = raiseRules({ ...DEFAULT_RULES, clearance: 0.3 }, eurocircuitsClass('6C')!, 2);
    expect(up.rules.clearance).toBe(0.3);
    expect(up.raised).toEqual([]);
  });

  it('keep_rules leaves rules below the limit and the DRC reports them', () => {
    const k = buck();
    ops(k, { op: 'set_board', clearance_mm: 0.1 });
    ops(k, { op: 'set_fab_profile', preset: 'eurocircuits/6C', keep_rules: true });
    expect(k.board().rules.clearance).toBe(0.1);
    expect(codes(k)).toContain('DRC.FAB_RULES');
  });

  it('set_board and set_net refuse values below the limit', () => {
    const k = buck();
    ops(k, { op: 'set_fab_profile', preset: 'eurocircuits/6C' });
    const clear = ops(k, { op: 'set_board', clearance_mm: 0.1 });
    expect(clear.status).toBe('rejected');
    expect(JSON.stringify(clear)).toContain('FAB_LIMIT');
    expect(ops(k, { op: 'set_board', clearance_mm: 0.2, via_drill_mm: 0.2 }).status).toBe('rejected');
    expect(ops(k, { op: 'set_board', clearance_mm: 0.2, track_mm: 0.2, via_drill_mm: 0.4, via_pad_mm: 0.8 }).status).toBe('ok');
    expect(k.board().rules).toMatchObject({ clearance: 0.2, track: 0.2, viaDrill: 0.4, viaPad: 0.8 });
    expect(ops(k, { op: 'set_net', net: 'GND', track_mm: 0.1 }).status).toBe('rejected');
    expect(ops(k, { op: 'set_net', net: 'GND', track_mm: 0.2 }).status).toBe('ok');
  });

  it('moving to 4 layers raises the edge clearance to the inner-layer limit', () => {
    const k = buck();
    ops(k, { op: 'set_board', edge_clearance_mm: 0.3 });
    ops(k, { op: 'set_fab_profile', preset: 'eurocircuits/6C' });
    expect(k.board().rules.edgeClearance).toBe(0.3);
    const r = ops(k, { op: 'set_board', layers: 4 });
    expect(r.status).toBe('ok');
    expect(k.board().rules.edgeClearance).toBe(0.4);
  });

  it('removes the profile, leaving the rules', () => {
    const k = buck();
    ops(k, { op: 'set_fab_profile', preset: 'pcbway' });
    expect(ops(k, { op: 'set_fab_profile', none: true }).status).toBe('ok');
    expect(k.board().fab).toBeUndefined();
    expect(ops(k, { op: 'set_fab_profile', none: true }).status).toBe('rejected');
  });

  it('asks for exactly one of preset, none or an import, and names the choices on an unknown preset', () => {
    const k = buck();
    expect(ops(k, { op: 'set_fab_profile' }).status).toBe('rejected');
    expect(ops(k, { op: 'set_fab_profile', preset: 'jlcpcb', none: true }).status).toBe('rejected');
    const r = ops(k, { op: 'set_fab_profile', preset: 'seeed' });
    expect(r.status).toBe('rejected');
    expect(JSON.stringify(r)).toContain('jlcpcb/2l-1oz');
  });
});

describe('importing a profile (the agent read a manufacturer page)', () => {
  const limits = { track_mm: 0.127, clearance_mm: 0.127, via_drill_mm: 0.2, via_pad_mm: 0.4, copper_to_edge_mm: 0.3 };

  it('stores the limits with their source and marks them imported', () => {
    const k = buck();
    const r = ops(k, { ...IMPORT, limits, layers: [2], notes: ['1 oz only'] });
    expect(r.status).toBe('ok');
    const f = k.board().fab!;
    expect(f).toMatchObject({ id: 'acme-boards/standard', origin: 'imported', layers: [2], notes: ['1 oz only'] });
    expect(f.source).toEqual({ url: 'https://acme.example/capabilities', checked: '2026-10-09' });
    expect(f.limits).toEqual({ track: 0.127, clearance: 0.127, viaDrill: 0.2, viaPad: 0.4, copperToEdge: 0.3 });
    expect(k.board().rules.clearance).toBe(DEFAULT_RULES.clearance);
    const board = k.proposal()!.hunks.find((h) => h.kind === 'board')!;
    expect(board.details?.join(' ')).toContain('acme.example');
  });

  it('an update check of a preset keeps the preset id, with the new limits and date', () => {
    const k = buck();
    ops(k, { op: 'set_fab_profile', preset: 'jlcpcb/4l-1oz' });
    const before = k.board().fab!;
    const r = ops(k, { op: 'set_fab_profile', house: 'JLCPCB', tier: '4-layer, 1 oz copper', layers: [4], source_url: before.source.url, checked: '2027-03-01', limits: { track_mm: 0.1, clearance_mm: 0.1 } });
    expect(r.status).toBe('ok');
    const f = k.board().fab!;
    expect(f).toMatchObject({ id: 'jlcpcb/4l-1oz', origin: 'imported', source: { checked: '2027-03-01' } });
    expect(f.limits.track).toBe(0.1);
  });

  it('refuses an import without its source or limits, and unit slips', () => {
    const k = buck();
    expect(ops(k, { op: 'set_fab_profile', house: 'Acme', tier: 'x', limits }).status).toBe('rejected'); // no source
    expect(ops(k, { op: 'set_fab_profile', house: 'Acme', tier: 'x', source_url: 'https://acme.example' }).status).toBe('rejected'); // no limits
    const mil = ops(k, { ...IMPORT, limits: { ...limits, track_mm: 5, clearance_mm: 5 } }); // 5 mil entered as mm
    expect(mil.status).toBe('rejected');
    expect(JSON.stringify(mil)).toContain('mil');
    expect(ops(k, { ...IMPORT, limits: { ...limits, via_pad_mm: 0.2 } }).status).toBe('rejected'); // pad ≤ drill
    expect(ops(k, { ...IMPORT, preset: 'jlcpcb', limits }).status).toBe('rejected'); // both
  });

  it('lists the presets and the current profile for the agent', () => {
    const k = buck();
    ops(k, { ...IMPORT, limits });
    const q = k.query({ op: 'get_fab_profiles' }) as { current: { id: string; origin: string }; presets: { id: string }[]; how: string };
    expect(q.current).toMatchObject({ id: 'acme-boards/standard', origin: 'imported' });
    expect(q.presets.map((p) => p.id)).toContain('eurocircuits/6C');
    expect(q.how).toContain('never guess');
    expect((buck().query({ op: 'get_fab_profiles' }) as { current: string }).current).toBe('none');
  });
});

describe('fab DRC', () => {
  it('flags a board with a layer count the tier is not made in', () => {
    const k = buck();
    ops(k, { op: 'set_fab_profile', preset: 'jlcpcb/2l-1oz' });
    ops(k, { op: 'set_board', layers: 4 });
    expect(codes(k)).toContain('DRC.FAB_LAYERS');
    ops(k, { op: 'set_fab_profile', preset: 'jlcpcb/4l-1oz' });
    expect(codes(k)).not.toContain('DRC.FAB_LAYERS');
  });

  it('flags a board outside the fab\'s size range', () => {
    const k = buck();
    ops(k, { op: 'set_board', width_mm: 40, height_mm: 40 });
    ops(k, { ...IMPORT, limits: { track_mm: 0.1, clearance_mm: 0.1, max_board_mm: [30, 30] } });
    expect(codes(k)).toContain('DRC.FAB_BOARD_SIZE');
    ops(k, { op: 'set_board', width_mm: 25, height_mm: 25 });
    expect(codes(k)).not.toContain('DRC.FAB_BOARD_SIZE');
  });

  it('flags holes below the smallest drill, thin rings and thin walls between holes', () => {
    const k = buck();
    ops(k, { ...IMPORT, limits: { track_mm: 0.1, clearance_mm: 0.1, npth_drill_mm: 1, annular_ring_mm: 0.8, hole_to_hole_mm: 0.5 } });
    ops(k, { op: 'add_hole', diameter_mm: 0.8, x_mm: 3, y_mm: 3 });
    const hole = k.board().diagnostics.find((x) => x.code === 'DRC.FAB_HOLE');
    expect(hole?.message).toContain('non-plated hole 0.8 mm');
    expect(hole?.severity).toBe('error');
    // a plated mounting hole gets a 0.6 mm ring
    ops(k, { op: 'add_hole', diameter_mm: 3.2, x_mm: 8, y_mm: 8, plated: true });
    const ring = k.board().diagnostics.find((x) => x.code === 'DRC.FAB_RING' && x.entities.includes('MH2'));
    expect(ring?.message).toContain('MH2.1: annular ring 0.6 mm is below');
    // two 1 mm holes 0.2 mm apart (edge to edge)
    ops(k, { op: 'remove_hole', id: 'all' }, { op: 'add_hole', diameter_mm: 1, x_mm: 10, y_mm: 10 }, { op: 'add_hole', diameter_mm: 1, x_mm: 11.2, y_mm: 10 });
    const wall = k.board().diagnostics.find((x) => x.code === 'DRC.FAB_HOLE_SPACING');
    expect(wall?.message).toContain('0.2 mm of material between the holes');
    // only the real offence is reported: 1 mm holes are fine for npth_drill 1
    expect(codes(k)).not.toContain('DRC.FAB_HOLE');
  });

  it('flags tracks and vias below the limits once routed, with each size reported once', () => {
    const k = buck();
    ops(k, { op: 'set_net', net: 'GND', track_mm: 0.15 });
    // a profile that cannot make 0.15 mm tracks, applied after the net was set
    ops(k, { ...IMPORT, limits: { track_mm: 0.2, clearance_mm: 0.15, via_drill_mm: 0.4, via_pad_mm: 0.9 }, keep_rules: true });
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    const tracks = b.diagnostics.filter((x) => x.code === 'DRC.FAB_TRACK');
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.every((x) => x.message.includes('GND') || x.message.includes('0.2'))).toBe(true);
    expect(new Set(tracks.map((x) => x.message)).size).toBe(tracks.length);
    expect(b.diagnostics.some((x) => x.code === 'DRC.FAB_RULES')).toBe(true);
  });

  it('has no fab diagnostics without a profile, and none for the default rules on any preset', () => {
    const k = buck();
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    expect(codes(k).filter((c) => c.startsWith('DRC.FAB'))).toEqual([]);
    for (const p of fabPresets().filter((x) => x.layers.includes(2))) {
      const m = buck();
      ops(m, { op: 'set_fab_profile', preset: p.id });
      m.transact({ summary: 'route', ops: [{ op: 'route' }] });
      const fab = m.board().diagnostics.filter((x) => x.code.startsWith('DRC.FAB') && x.severity === 'error');
      expect(fab.map((x) => x.message), p.id).toEqual([]);
    }
  });
});
