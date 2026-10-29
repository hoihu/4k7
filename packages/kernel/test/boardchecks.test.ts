import { describe, expect, it } from 'vitest';
import { findFabPreset, type BoardPad, type BoardPart, type BoardRules, type BoardView, type Track, type Zone } from '@4k7/schema';
import { acidDrc, deadCopperDrc, neckDrc, thermalDrc } from '../src/drc.ts';
import { fabCopperDrc, fabPlacementDrc } from '../src/fabdrc.ts';
import { route } from '../src/router.ts';

const RULES: BoardRules = { clearance: 0.2, track: 0.25, powerTrack: 0.5, viaDrill: 0.3, viaPad: 0.6, edgeClearance: 0.5 };
const jlc = (() => {
  const r = findFabPreset('jlcpcb', 2);
  if (!r.ok) throw new Error(r.message);
  return r.profile;
})();

const pad = (number: string, x: number, y: number, w: number, h: number, netId?: string, more: Partial<BoardPad> = {}): BoardPad => ({ number, x, y, w, h, shape: 'rect', layers: ['F.Cu'], ...(netId ? { netId } : {}), ...more });
const part = (refdes: string, pads: BoardPad[]): BoardPart => ({ componentId: refdes, refdes, pads, body: { x: 0, y: 0, w: 1, h: 1 }, courtyard: { x: 0, y: 0, w: 1, h: 1 } }) as unknown as BoardPart;
const view = (more: Partial<BoardView>): BoardView =>
  ({ outline: { w: 20, h: 10 }, layers: ['F.Cu', 'B.Cu'], rules: RULES, fab: jlc, parts: [], tracks: [], vias: [], zones: [], planes: [], graphics: [], netNames: { A: 'A', B: 'B', GND: 'GND' }, ...more }) as unknown as BoardView;
const track = (netId: string, pts: number[], width = 0.25): Track => ({ netId, layer: 'F.Cu', width, pts });
const codes = (d: { code: string }[]) => d.map((x) => x.code);

describe('solder-mask webs', () => {
  // JLCPCB holds 0.1 mm of web; the mask opens 0.05 mm past each pad, so pads need 0.2 mm between them
  it('warns between the pads of one part when the web is too thin, and errors between two parts', () => {
    const fine = view({ parts: [part('U1', [pad('1', 2, 2, 0.25, 0.6, 'A'), pad('2', 2.4, 2, 0.25, 0.6, 'B'), pad('3', 2.9, 2, 0.25, 0.6, 'GND')])] });
    const same = fabPlacementDrc(fine).filter((d) => d.code === 'DRC.FAB_MASK_WEB');
    // 1–2: 0.15 mm of copper gap, 0.05 mm of web; 2–3: 0.25 gap, 0.15 web
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ severity: 'warning', entities: ['U1'] });
    expect(same[0]!.message).toContain('U1.1 and U1.2');
    const apart = view({ parts: [part('R1', [pad('1', 2, 2, 1, 1, 'A')]), part('R2', [pad('1', 3.15, 2, 1, 1, 'B')])] });
    expect(fabPlacementDrc(apart).filter((d) => d.code === 'DRC.FAB_MASK_WEB')).toMatchObject([{ severity: 'error', entities: ['R1', 'R2'] }]);
  });

  it('lets pads of one net, pads at the limit, pads on opposite sides and houses without the limit be', () => {
    const at = (gap: number, extra: Partial<BoardPad> = {}, net = 'B') => view({ parts: [part('R1', [pad('1', 2, 2, 1, 1, 'A')]), part('R2', [pad('1', 3 + gap, 2, 1, 1, net, extra)])] });
    const web = (b: BoardView) => fabPlacementDrc(b).filter((d) => d.code === 'DRC.FAB_MASK_WEB');
    expect(web(at(0.2))).toEqual([]); // exactly the 0.1 mm web
    expect(web(at(0.15))).toHaveLength(1);
    expect(web(at(0.15, {}, 'A'))).toEqual([]); // joined anyway
    expect(web(at(0.15, { layers: ['B.Cu'] }))).toEqual([]);
    // Eurocircuits publishes no mask web: nothing to check against
    const ec = findFabPreset('eurocircuits/6C', 2);
    expect(ec.ok && ec.profile.limits.maskBridge).toBeFalsy();
    expect(web({ ...at(0.15), fab: ec.ok ? ec.profile : undefined })).toEqual([]);
  });
});

describe('silkscreen text', () => {
  it('warns about text smaller than the fab prints', () => {
    const g = (h: number) => ({ id: 'G1', side: 'top', mode: 'outline', line: 0.15, text: 'REV A', polys: [], bounds: [1, 1, 5, 1 + h] });
    const d = (h: number) => fabPlacementDrc(view({ graphics: [g(h)] as never })).filter((x) => x.code === 'DRC.FAB_SILK_TEXT');
    expect(d(0.7)).toMatchObject([{ severity: 'warning', entities: ['G1'] }]);
    expect(d(1)).toEqual([]);
  });
});

describe('thermal-relief spokes', () => {
  const zone = (adds: NonNullable<Zone['shape']>['adds'], netId = 'GND'): Zone => ({ netId, layer: 'F.Cu', rects: [0.5, 0.5, 19, 9], shape: { outline: [0.5, 0.5, 19.5, 9.5], cuts: [], adds } });
  const gnd = (more: Partial<BoardView>) => view({ parts: [part('C1', [pad('1', 5, 5, 1, 1, 'GND')])], planes: [{ netId: 'GND', layer: 'F.Cu', auto: false }], ...more });
  const spoke = (dx: number, dy: number) => ({ pts: [5, 5, 5 + dx, 5 + dy], w: 0.3 });

  it('flags a pad joined by one spoke, and a surface pad left with none, but not one with two', () => {
    expect(thermalDrc(gnd({ zones: [zone([spoke(1.5, 0), spoke(-1.5, 0)])] }))).toEqual([]);
    expect(thermalDrc(gnd({ zones: [zone([spoke(1.5, 0)])] }))).toMatchObject([{ code: 'DRC.THERMAL_SPOKES', severity: 'warning' }]);
    const none = thermalDrc(gnd({ zones: [zone([])] }));
    expect(none).toMatchObject([{ code: 'DRC.THERMAL_SPOKES', severity: 'error', entities: ['C1'] }]);
    expect(none[0]!.message).toContain('cut off from the pour');
  });

  it('lets be a pad joined solid, a pad with a track of its net, and a pad the pour does not reach', () => {
    const z = zone([]);
    expect(thermalDrc(gnd({ zones: [z], planes: [{ netId: 'GND', layer: 'F.Cu', auto: false, style: { thermal: false } }] }))).toEqual([]);
    expect(thermalDrc(gnd({ zones: [z], tracks: [track('GND', [5, 5, 8, 5])] }))).toEqual([]);
    expect(thermalDrc(gnd({ zones: [{ ...z, rects: [10, 0.5, 9, 9] }] }))).toEqual([]);
  });

  it('flags spokes thinner than the fab makes', () => {
    const thin = view({ zones: [zone([{ pts: [5, 5, 7, 5], w: 0.08 }])] });
    expect(fabCopperDrc(thin)).toMatchObject([{ code: 'DRC.FAB_SPOKE', severity: 'error' }]);
    expect(fabCopperDrc(view({ zones: [zone([spoke(2, 0)])] }))).toEqual([]);
  });
});

describe('acid traps', () => {
  const trap = (b: Partial<BoardView>) => acidDrc(view({ netNames: { A: 'A' }, ...b }));

  it('flags two tracks of a net meeting at less than 90° with an empty wedge', () => {
    const d = trap({ tracks: [track('A', [5, 5, 10, 5]), track('A', [5, 5, 10, 10])] });
    expect(d).toMatchObject([{ code: 'DRC.ACID_TRAP', severity: 'warning', at: { x: 5, y: 5 } }]);
    expect(d[0]!.message).toContain('45°');
    // a bend of the same track, too
    expect(trap({ tracks: [track('A', [10, 5, 5, 5, 10, 10])] })).toHaveLength(1);
  });

  it('lets be square and wider joints, a wedge something fills, and a junction in a pad', () => {
    expect(trap({ tracks: [track('A', [5, 5, 10, 5]), track('A', [5, 5, 5, 9])] })).toEqual([]); // 90°
    expect(trap({ tracks: [track('A', [5, 5, 10, 5]), track('A', [5, 5, 1, 9])] })).toEqual([]); // 135°
    const two = [track('A', [5, 5, 10, 5]), track('A', [5, 5, 10, 10])];
    expect(trap({ tracks: two, parts: [part('J2', [pad('1', 5.6, 5.25, 0.6, 0.6, 'A')])] })).toEqual([]); // a pad in the wedge
    expect(trap({ tracks: two, zones: [{ netId: 'A', layer: 'F.Cu', rects: [5.2, 5.1, 3, 3] }] })).toEqual([]);
    expect(trap({ tracks: two, parts: [part('J1', [pad('1', 5, 5, 1, 1, 'A')])] })).toEqual([]);
    // another net's tracks, or the other layer, are no wedge of this net
    expect(trap({ tracks: [track('A', [5, 5, 10, 5]), { ...track('A', [5, 5, 10, 10]), layer: 'B.Cu' }] })).toEqual([]);
  });

  it('finds the wedge where a track ends on the side of another', () => {
    expect(trap({ tracks: [track('A', [2, 5, 12, 5]), track('A', [6, 5, 9, 8])] })).toHaveLength(1);
    expect(trap({ tracks: [track('A', [2, 5, 12, 5]), track('A', [6, 5, 6, 8])] })).toEqual([]);
  });
});

describe('necks', () => {
  const widthOf = () => 0.5;
  const neck = (b: Partial<BoardView>) => neckDrc(view({ netNames: { A: 'A' }, ...b }), widthOf);

  it('flags a track narrower than its net\'s width', () => {
    expect(neck({ tracks: [track('A', [3, 5, 10, 5], 0.25)] })).toMatchObject([{ code: 'DRC.NECK', severity: 'warning', at: { x: 3, y: 5 } }]);
    expect(neck({ tracks: [track('A', [3, 5, 10, 5], 0.5)] })).toEqual([]);
  });

  it('lets be an escape from a pad too small for the width', () => {
    const small = part('U1', [pad('1', 3, 5, 0.3, 0.8, 'A')]);
    expect(neck({ parts: [small], tracks: [track('A', [3, 5, 10, 5], 0.25)] })).toEqual([]);
    const wide = part('U1', [pad('1', 3, 5, 1, 1, 'A')]);
    expect(neck({ parts: [wide], tracks: [track('A', [3, 5, 10, 5], 0.25)] })).toHaveLength(1);
  });
});

describe('dead copper', () => {
  // GND is poured on F.Cu; A's pads and a track between them wall the board off at x 14
  const part2 = (refdes: string, pads: [number, number, string][]) =>
    ({ componentId: refdes, refdes, x: 0, y: 0, rot: 0, pads: pads.map(([x, y, netId], i) => pad(String(i + 1), x, y, 1, 1, netId)), courtyard: { x: 0, y: 0, w: 1, h: 1 } }) as unknown as BoardPart;
  const wall = (walled = true) =>
    route({ outline: { w: 20, h: 10 }, layers: ['F.Cu'], rules: RULES, parts: [...(walled ? [part2('P', [[14, 0.5, 'A'], [14, 9.5, 'A']])] : []), part2('G', [[4, 5, 'GND']])], powerNets: new Set(), planes: [{ netId: 'GND', layer: 'F.Cu' }], ...(walled ? { keep: { tracks: [track('A', [14, 0.5, 14, 9.5])], vias: [] } } : {}) });
  const covers = (z: Zone, x: number, y: number) => z.rects.some((_, i) => i % 4 === 0 && x >= z.rects[i]! && x <= z.rects[i]! + z.rects[i + 2]! && y >= z.rects[i + 1]! && y <= z.rects[i + 1]! + z.rects[i + 3]!);

  it('leaves out the pour island that touches no copper of its net, and says so', () => {
    const r = wall();
    const z = r.zones.find((x) => x.netId === 'GND')!;
    expect(covers(z, 8, 3)).toBe(true);
    expect(covers(z, 17, 5)).toBe(false);
    expect(z.removed).toMatchObject({ islands: 1 });
    expect(z.removed!.area).toBeGreaterThan(20);
    expect(z.removed!.at.x).toBeGreaterThan(15);
    const d = deadCopperDrc(view({ zones: [z], netNames: { GND: 'GND' } }));
    expect(d).toMatchObject([{ code: 'DRC.DEAD_COPPER', severity: 'info' }]);
    expect(d[0]!.message).toContain('left out of the fill');
  });

  it('has nothing to leave out where the pour is whole', () => {
    const z = wall(false).zones.find((x) => x.netId === 'GND')!;
    expect(covers(z, 17, 5)).toBe(true);
    expect(z.removed).toBeUndefined();
  });
});

describe('the checks stay quiet on clean copper', () => {
  it('reports nothing for tidy copper on a board with a fab profile', () => {
    const b = view({ parts: [part('R1', [pad('1', 2, 2, 1, 1, 'A')]), part('R2', [pad('1', 6, 2, 1, 1, 'A')])], tracks: [track('A', [2, 2, 6, 2])] });
    expect(codes([...fabPlacementDrc(b), ...fabCopperDrc(b), ...acidDrc(b), ...neckDrc(b, () => 0.25), ...thermalDrc(b), ...deadCopperDrc(b)])).toEqual([]);
  });
});
