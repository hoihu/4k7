import { describe, expect, it } from 'vitest';
import { bom, bomLines, gerbers, pickAndPlace } from '@4k7/fab';
import { Kernel } from '../src/index.ts';
import { buck } from './fixtures.ts';

/**
 * add_test_points: one test point per net, on that net, at the part that drives it, named TP<n>
 * with TP_<net> on the silkscreen (docs/design/layout.md §4).
 */

const tps = (k: Kernel) => Object.values(k.draftDesign().components).filter((c) => c.refdes.startsWith('TP'));
const netOf = (k: Kernel, c: { pins: Record<string, string> }) => k.draftDesign().nets[c.pins['1']!]?.name;

describe('add_test_points', () => {
  it('adds one test point per named net, connected to that net, named TP<n>', () => {
    const k = buck();
    const r = k.transact({ summary: 'tp', ops: [{ op: 'add_test_points', nets: ['+3V3', 'FB'] }] });
    expect(r.status).toBe('ok');
    const added = tps(k);
    expect(added.map((c) => c.refdes).sort()).toEqual(['TP1', 'TP2']);
    expect(added.map((c) => netOf(k, c)).sort()).toEqual(['+3V3', 'FB']);
  });

  it('"rails" gives every supply rail one, not ground or signals', () => {
    const k = buck();
    expect(k.transact({ summary: 'tp', ops: [{ op: 'add_test_points', nets: ['rails'] }] }).status).toBe('ok');
    expect(tps(k).map((c) => netOf(k, c)).sort()).toEqual(['+12V', '+3V3']);
  });

  it('adds none to a net that already has one', () => {
    const k = buck();
    k.transact({ summary: 'tp', ops: [{ op: 'add_test_points', nets: ['+3V3'] }] });
    const again = k.transact({ summary: 'tp', ops: [{ op: 'add_test_points', nets: ['rails', '+3V3'] }] });
    expect(again.status).toBe('ok');
    expect(tps(k).map((c) => netOf(k, c)).sort()).toEqual(['+12V', '+3V3']);
    const once = k.transact({ summary: 'tp', ops: [{ op: 'add_test_points', nets: ['rails'] }] });
    expect(once.status).toBe('ok');
    expect(tps(k)).toHaveLength(2);
  });

  it('refuses an unknown net, naming it', () => {
    const k = buck();
    const r = k.transact({ summary: 'tp', ops: [{ op: 'add_test_points', nets: ['+5V'] }] });
    expect(r.status).toBe('rejected');
    expect(r.rejection?.message).toMatch(/^No net "\+5V"/);
    expect(r.rejection?.candidates).toContain('+3V3');
    expect(tps(k)).toHaveLength(0);
  });

  it('puts each test point at the part that drives its net', () => {
    const k = buck();
    k.transact({ summary: 'tp', ops: [{ op: 'add_test_points', nets: ['rails'] }] });
    const b = k.boardPlacement();
    const at = (ref: string) => b.parts.find((p) => p.refdes === ref)!;
    const tpOn = (net: string) => at(tps(k).find((c) => netOf(k, c) === net)!.refdes);
    const dist = (a: { x: number; y: number }, c: { x: number; y: number }) => Math.hypot(a.x - c.x, a.y - c.y);
    // +12V comes in on J1, +3V3 out of L1
    expect(dist(tpOn('+12V'), at('J1'))).toBeLessThan(10);
    expect(dist(tpOn('+3V3'), at('L1'))).toBeLessThan(10);
  });

  it('keeps a small board DRC-clean, placed and routed', () => {
    const k = buck();
    expect(k.transact({ summary: 'tp', ops: [{ op: 'add_test_points', nets: ['rails'] }] }).status).toBe('ok');
    expect(tps(k)).toHaveLength(2);
    expect(k.state().diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(k.boardPlacement().diagnostics).toEqual([]);
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.routing).toBe('done');
    // The router sizes nothing for a net's current, so the buck's rails get the current check's
    // findings with or without test points; left out as in board.test.ts (current.test.ts tests them).
    const CURRENT = ['DRC.CURRENT_UNVERIFIED', 'DRC.VIA_CURRENT', 'DRC.CURRENT_UNKNOWN'];
    expect(b.diagnostics.filter((x) => !CURRENT.includes(x.code))).toEqual([]);
  });

  it('a pad test point is no part to buy or place; its silkscreen names the net', () => {
    const k = buck();
    k.transact({ summary: 'tp', ops: [{ op: 'add_test_points', nets: ['+3V3'] }] });
    const b = k.boardPlacement();
    const tp = b.parts.find((p) => p.refdes === 'TP1')!;
    expect(tp.pads).toHaveLength(1);
    expect(tp.pads[0]).toMatchObject({ shape: 'round', w: 1.5, h: 1.5 });
    expect(tp.pads[0]!.drill).toBeUndefined();
    expect(bomLines(b).flatMap((l) => l.refs)).not.toContain('TP1');
    expect(bom(b)).not.toMatch(/TP1/);
    expect(pickAndPlace(b)).not.toMatch(/TP1/);
    // the silkscreen says TP_+3V3 by the pad, not TP1
    expect(tp.silk).toBe('TP_+3V3');
    const silk = (v: typeof b) => gerbers(v, 'tp').find((f) => f.name.endsWith('F_Silkscreen.gbr'))!.content;
    const asRefdes = { ...b, parts: b.parts.map((p) => (p === tp ? { ...p, silk: undefined } : p)) };
    expect(silk(b)).not.toBe(silk(asRefdes));
  });

  it('a through-hole loop test point is a real part in the BOM', () => {
    const k = buck();
    k.transact({ summary: 'loop', ops: [{ op: 'add_part', part: 'generic:TP_LOOP', refdes: 'TP1' }, { op: 'connect', pins: ['TP1.1'], net: 'GND' }] });
    const b = k.boardPlacement();
    const tp = b.parts.find((p) => p.refdes === 'TP1')!;
    expect(tp.pads).toHaveLength(1);
    expect(tp.pads[0]!.drill).toBeGreaterThan(0.9);
    expect(bomLines(b).flatMap((l) => l.refs)).toContain('TP1');
    // and counts as GND's test point
    k.transact({ summary: 'tp', ops: [{ op: 'add_test_points', nets: ['GND'] }] });
    expect(tps(k)).toHaveLength(1);
  });
});
