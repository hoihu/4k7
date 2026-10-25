import { describe, expect, it } from 'vitest';
import type { BoardView, Track } from '@4k7/schema';
import { Kernel, analyseLine, microstripHJ, widthForLine, gapForLine } from '../src/index.ts';

const ETA0 = 376.730313668;
/** The complete elliptic integral of the first kind, by the arithmetic–geometric mean. */
function K(k: number) {
  let [a, b] = [1, Math.sqrt(1 - k * k)];
  for (let i = 0; i < 40; i++) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  return Math.PI / (2 * a);
}
const off = (got: number, want: number) => Math.abs(got / want - 1);

describe('the impedance field solver', () => {
  it('matches the exact stripline (conformal mapping, copper of no thickness)', () => {
    for (const [w, b, er] of [[0.2, 0.5, 1], [0.5, 1, 4.3]] as const) {
      const k = 1 / Math.cosh((Math.PI * w) / (2 * b));
      const exact = (ETA0 / (4 * Math.sqrt(er))) * (K(k) / K(Math.tanh((Math.PI * w) / (2 * b))));
      const r = analyseLine({ t: 0, w, below: [{ h: b / 2, er }], above: [{ h: b / 2, er }] });
      expect(off(r.z, exact)).toBeLessThan(0.003);
      expect(r.eeff).toBeCloseTo(er, 6);
    }
  });

  it('matches the exact coplanar waveguide, and its εeff on a thick substrate is (εr + 1) / 2', () => {
    const [w, g] = [0.5, 0.2];
    const k = w / (w + 2 * g);
    const exact = (ETA0 / 4) * (K(Math.sqrt(1 - k * k)) / K(k));
    const below = (er: number) => [{ h: 100 * (w + 2 * g), er }];
    expect(off(analyseLine({ t: 0, w, g, below: below(1) }).z, exact)).toBeLessThan(0.003);
    expect(analyseLine({ t: 0, w, g, below: below(4) }).eeff).toBeCloseTo(2.5, 2);
  });

  it('agrees with Hammerstad and Jensen\'s microstrip, with and without copper thickness', () => {
    for (const [w, h, er] of [[0.1, 0.2, 4.4], [0.35, 0.21, 4.4], [3, 1.5, 4.5]] as const) {
      expect(off(analyseLine({ t: 0, w, below: [{ h, er }] }).z, microstripHJ(w, h, er).z)).toBeLessThan(0.003);
      expect(off(analyseLine({ t: 0.035, w, below: [{ h, er }] }).z, microstripHJ(w, h, er, 0.035).z)).toBeLessThan(0.005);
    }
  });

  it('finds the width (or a pair\'s gap) that gives a target, and the mask lowers a line', () => {
    const below = [{ h: 0.2104, er: 4.4 }];
    const mask = { base: 0.0305, copper: 0.0152, er: 3.8 };
    const w = widthForLine(50, { t: 0.035, below, mask })!;
    expect(off(analyseLine({ t: 0.035, w, below, mask }).z, 50)).toBeLessThan(0.001);
    expect(analyseLine({ t: 0.035, w, below }).z).toBeGreaterThan(51);
    const s = gapForLine(90, { t: 0.035, w: 0.2, below, mask })!;
    expect(off(analyseLine({ t: 0.035, w: 0.2, s, below, mask }).z, 90)).toBeLessThan(0.001);
  });

  it('gives a pair twice a single line\'s impedance when its tracks are far apart, less when coupled', () => {
    const below = [{ h: 0.2104, er: 4.4 }];
    const single = analyseLine({ t: 0.035, w: 0.2, below }).z;
    expect(off(analyseLine({ t: 0.035, w: 0.2, s: 8, below }).z, 2 * single)).toBeLessThan(0.01);
    const tight = analyseLine({ t: 0.035, w: 0.2, s: 0.1, below });
    expect(tight.z).toBeLessThan(2 * single * 0.92);
    expect(tight.even).toBeGreaterThan(tight.odd!);
  });

  it('agrees with JLCPCB\'s impedance calculator on its own stack-up', () => {
    const mask = { base: 0.0305, copper: 0.0152, er: 3.8 };
    // coplanar on L1 over L3 (L2 cut away): 42.39 mil wide, 10 mil gap → 50 Ω in their calculator
    const l3 = [{ h: 1.065, er: 4.6 }, { h: 0.0152, er: 4.4 }, { h: 0.2104, er: 4.4 }];
    expect(off(analyseLine({ t: 0.035, w: 1.0767, g: 0.254, below: l3, mask }).z, 50)).toBeLessThan(0.03);
    // a pair over 7628: 8.09 mil wide, 4 mil apart → 85 Ω
    expect(off(analyseLine({ t: 0.035, w: 0.2055, s: 0.1016, below: [{ h: 0.2104, er: 4.4 }], mask }).z, 85)).toBeLessThan(0.03);
  });
});

/* ---------------------------------- boards --------------------------------- */

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

/** Two 4-pin headers 28 mm apart joined by a USB pair, VBUS and GND. */
function usb(layers: 2 | 4 = 4) {
  const k = new Kernel();
  ok(k, [
    { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J1' },
    { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J2' },
    { op: 'connect', pins: ['J1.1', 'J2.1'], net: 'VBUS' },
    { op: 'connect', pins: ['J1.2', 'J2.2'], net: 'USB_DP' },
    { op: 'connect', pins: ['J1.3', 'J2.3'], net: 'USB_DN' },
    { op: 'connect', pins: ['J1.4', 'J2.4'], net: 'GND' },
    { op: 'set_net', net: 'VBUS', voltage: 5, external: true },
    { op: 'set_board', layers, width_mm: 40, height_mm: 20 },
    { op: 'set_fab_profile', preset: 'jlcpcb' },
    { op: 'place', ref: 'J1', x_mm: 6, y_mm: 10, rot: 0, lock: true },
    { op: 'place', ref: 'J2', x_mm: 34, y_mm: 10, rot: 0, lock: true },
  ]);
  return k;
}

const pieces = (t: Track) => Array.from({ length: t.pts.length / 2 - 1 }, (_, i) => t.pts.slice(2 * i, 2 * i + 4) as [number, number, number, number]);
const segDist = ([ax, ay, bx, by]: number[], x: number, y: number) => {
  const [dx, dy] = [bx! - ax!, by! - ay!];
  const t = Math.max(0, Math.min(1, ((x - ax!) * dx + (y - ay!) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - (ax! + t * dx), y - (ay! + t * dy));
};
/** The edge-to-edge gap between two tracks at points along the first (its middle stretch, away from the pads). */
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

describe('impedance rules', () => {
  it('works a rule out for every layer it can run on, and says so', () => {
    const k = usb();
    const r = ok(k, [{ op: 'set_impedance', nets: ['USB_DP', 'USB_DN'], ohms: 90, label: 'USB 2.0' }]);
    expect(r.results[0]!.effect).toMatch(/Z1 USB_DP\/USB_DN \(USB 2\.0\): 90 Ω differential ±10 %, microstrip; F\.Cu over In1\.Cu \(0\.21 mm, εr 4\.4\): 0\.\d+ mm wide, 0\.2 mm apart → (89|9\d)/);
    const v = k.boardPlacement().impedance![0]!;
    expect(v.layers.map((l) => l.layer)).toEqual(['F.Cu', 'B.Cu']);
    expect(v.layers[0]!.gap).toBe(0.2);
    expect(Math.abs(v.layers[0]!.ohms - 90)).toBeLessThan(1);
    // the stack-up in effect is JLCPCB's standard 4 layers, and get_board says it
    const q = k.query({ op: 'get_board' }) as { stackup: { name: string }; impedance: { id: string; layers: { width_mm: number }[] }[] };
    expect(q.stackup.name).toBe('JLC04161H-7628');
    expect(q.impedance[0]!.layers[0]!.width_mm).toBe(v.layers[0]!.width);
    expect((k.query({ op: 'get_net', net: 'USB_DN' }) as { impedance: string }).impedance).toMatch(/^Z1 USB_DP\/USB_DN/);
  });

  it('builds lines on 2 layers coplanar, and refuses what cannot be meant', () => {
    const k = usb(2);
    ok(k, [{ op: 'set_impedance', nets: ['USB_DP'], ohms: 50 }]);
    const v = k.boardPlacement().impedance![0]!;
    expect(v.style).toBe('coplanar');
    expect(v.layers[0]!.side).toBe(0.2);
    // (a microstrip over 1.5 mm of FR-4 would be nearly 3 mm wide)
    expect(v.layers[0]!.width).toBeLessThan(1.2);
    expect(refused(k, [{ op: 'set_impedance', nets: ['GND'], ohms: 50 }]).message).toMatch(/ground/);
    expect(refused(k, [{ op: 'set_impedance', nets: ['USB_DP'], ohms: 50, gap_mm: 0.2 }]).message).toMatch(/pair/);
    expect(refused(k, [{ op: 'set_impedance', nets: ['USB_DP', 'USB_DN'], ohms: 90, width_mm: 0.2, gap_mm: 0.2 }]).message).toMatch(/not both/);
    expect(refused(k, [{ op: 'set_impedance', nets: ['USB_DP', 'USB_DN'], ohms: 90, gap_mm: 0.05 }]).code).toBe('FAB_LIMIT');
    expect(refused(k, [{ op: 'set_impedance', nets: ['USB_D'], ohms: 90 }]).candidates).toContain('USB_DP');
  });

  it('takes the stack-up from a preset or an import, and drops it with another layer count', () => {
    const k = usb();
    ok(k, [{ op: 'set_impedance', nets: ['USB_DP'], ohms: 50 }]);
    const w7628 = k.boardPlacement().impedance![0]!.layers[0]!.width;
    const r = ok(k, [{ op: 'set_stackup', preset: 'JLC04161H-3313' }]);
    expect(r.results[0]!.effect).toMatch(/stack-up JLC04161H-3313: F\.Cu 35 µm \| 0\.0994 mm 3313 prepreg εr 4\.1/);
    // (thinner prepreg: a narrower line for the same impedance)
    expect(k.boardPlacement().impedance![0]!.layers[0]!.width).toBeLessThan(w7628 * 0.6);
    expect(refused(k, [{ op: 'set_stackup', house: 'Acme', name: 'X', copper_mm: [0.035, 0.035], dielectric: [{ mm: 1.5, er: 4.5 }], source_url: 'https://acme.example/stackup' }]).message).toMatch(/2 copper layers; the board has 4/);
    expect(refused(k, [{ op: 'set_stackup', house: 'Acme', name: 'X', copper_mm: [0.035, 0.0152, 0.0152, 0.035], dielectric: [{ mm: 8, er: 4.4 }, { mm: 1, er: 4.6 }, { mm: 0.2, er: 4.4 }], source_url: 'https://acme.example/stackup' }]).message).toMatch(/dielectric is out of range/);
    ok(k, [{ op: 'set_stackup', house: 'Acme', name: 'Acme 4L', copper_mm: [0.035, 0.0175, 0.0175, 0.035], dielectric: [{ mm: 0.11, er: 4.2 }, { mm: 1.2, er: 4.5 }, { mm: 0.11, er: 4.2 }], source_url: 'https://acme.example/stackup' }]);
    expect(k.boardPlacement().stackup).toMatchObject({ id: 'acme/acme-4l', origin: 'imported', source: { url: 'https://acme.example/stackup' } });
    const back = ok(k, [{ op: 'set_board', layers: 2 }]);
    expect(back.results[0]!.effect).toMatch(/stack-up Acme 4L dropped/);
    expect(k.boardPlacement().stackup!.id).toBe('jlcpcb/2l-1.6');
    ok(k, [{ op: 'remove_impedance', id: 'Z1' }]);
    expect(k.boardPlacement().impedance).toBeUndefined();
  });

  it('gives the router the rule\'s width, and the pours its gap; a fence runs along the line', () => {
    const k = usb(2);
    ok(k, [
      { op: 'set_plane', layer: 'B.Cu', net: 'GND' },
      { op: 'set_plane', layer: 'F.Cu', net: 'GND' },
      { op: 'set_impedance', nets: ['USB_DP'], ohms: 50, coplanar_gap_mm: 0.3 },
      { op: 'add_vias', kind: 'fence', net: 'GND', along: 'USB_DP', pitch_mm: 1.5 },
      { op: 'route' },
    ]);
    const b = k.board();
    const dp = Object.entries(b.netNames).find(([, n]) => n === 'USB_DP')![0];
    const w = b.impedance![0]!.layers[0]!.width;
    const line = b.tracks.filter((t) => t.netId === dp);
    expect(line.length).toBeGreaterThan(0);
    for (const t of line) expect(t.width).toBe(w);
    const cut = b.zones.find((z) => z.layer === line[0]!.layer)!.shape!.cuts.find((c) => c.k === 'stroke' && c.pts === line[0]!.pts) as { w: number };
    expect(cut.w).toBeCloseTo(w + 0.6, 3);
    expect(b.vias.filter((v) => v.group === 'V1').length).toBeGreaterThan(4);
    expect((k.query({ op: 'get_board' }) as { via_groups: { vias: string }[] }).via_groups[0]!.vias).toMatch(/along both sides of USB_DP/);
  });
});

describe('lines on the copper', () => {
  const drawnUsb = () => {
    const k = usb();
    ok(k, [{ op: 'set_impedance', nets: ['USB_DP', 'USB_DN'], ohms: 90 }, { op: 'set_copper_mode', mode: 'drawn', keep: false }]);
    return k;
  };

  it('draws a pair: each track on its pad\'s side, the gap held round 45° bends', () => {
    const k = drawnUsb();
    const r = ok(k, [{ op: 'draw_pair', from: ['J1.2', 'J1.3'], to: ['J2.2', 'J2.3'], via: [[10, 10], [13, 13], [27, 13], [30, 10]] }]);
    expect(r.results[0]!.effect).toMatch(/^pair USB_DP\/USB_DN on F\.Cu: t1 [\d.]+ mm, t2 [\d.]+ mm .*\(Z1: (89|9\d)[.\d]* Ω\); check: (clear|no errors)/);
    const b = k.board();
    const lay = b.impedance![0]!.layers[0]!;
    const [p, n] = b.drawn!.tracks;
    expect(p!.width).toBe(lay.width);
    // the positive track starts at J1.2, above the centre line, and stays above it
    expect(p!.pts[1]).toBeLessThan(n!.pts[1]!);
    // (at a mitred 45° corner the outer track's corner stands 8 % further off: the gap opens a little there)
    const gs = gaps(p!, n!, 9, 31).sort((a, b) => a - b);
    expect(gs[Math.floor(gs.length / 2)]).toBeCloseTo(lay.gap!, 3);
    expect(gs[0]).toBeGreaterThan(lay.gap! - 0.002);
    expect(gs.at(-1)).toBeLessThan(lay.gap! + 0.045);
    expect(codes(b).filter((c) => c.startsWith('IMP.') || c === 'DRC.CLEARANCE')).toEqual([]);
  });

  it('refuses a pair whose tracks would cross, and one with no room to come together', () => {
    const k = drawnUsb();
    expect(refused(k, [{ op: 'draw_pair', from: ['J1.2', 'J1.3'], to: ['J2.3', 'J2.2'] }]).message).toMatch(/positive first|on USB_DN/);
    expect(refused(k, [{ op: 'draw_pair', from: ['J1.2', 'J1.3'], to: ['J2.2', 'J2.3'], via: [[6.5, 10], [30, 10]] }]).message).toMatch(/come together/);
  });

  it('holds the copper to the rule: width, corners, lengths, the gap, vias, other signals', () => {
    const k = drawnUsb();
    ok(k, [{ op: 'draw_pair', from: ['J1.2', 'J1.3'], to: ['J2.2', 'J2.3'], via: [[10, 10], [30, 10]] }]);
    expect(codes(k.board()).filter((c) => c.startsWith('IMP.'))).toEqual([]);
    // the default width of a track of a controlled net is its rule's
    const t = ok(k, [{ op: 'erase_copper', ids: ['t2'] }, { op: 'draw_track', from: 'J1.3', to: 'J2.3', via: [[8, 12], [32, 12]] }]);
    expect(t.results[1]!.effect).toMatch(new RegExp(`USB_DN on F\\.Cu, ${k.boardPlacement().impedance![0]!.layers[0]!.width} mm`));
    expect(t.results[1]!.effect).toMatch(/; check: /);
    let b = k.board();
    expect(codes(b)).toContain('IMP.GAP');
    // too narrow: an error; a sharp corner: a warning
    const e = ok(k, [{ op: 'edit_copper', ids: ['t3'], width_mm: 0.15 }]);
    expect(e.results[0]!.effect).toMatch(/error IMP\.WIDTH/);
    ok(k, [{ op: 'erase_copper', ids: ['t3'] }, { op: 'draw_track', from: 'J1.3', to: 'J2.3', via: [[8, 11.27], [8, 14], [32, 14], [32, 11.27]] }]);
    b = k.board();
    expect(codes(b)).toEqual(expect.arrayContaining(['IMP.CORNER', 'IMP.SKEW']));
    // a via of the line with no ground via beside it
    ok(k, [{ op: 'erase_copper', nets: ['USB_DN'] }, { op: 'draw_pair', from: ['J1.2', 'J1.3'], to: ['J2.2', 'J2.3'], via: [[10, 10], [30, 10]] }]);
    ok(k, [{ op: 'draw_via', at: [20, 4], net: 'USB_DP' }]);
    expect(codes(k.board())).toContain('IMP.VIA');
    ok(k, [{ op: 'draw_via', at: [21, 4], net: 'GND' }]);
    expect(codes(k.board()).filter((c) => c === 'IMP.VIA').length).toBeLessThanOrEqual(1);
    // another signal close by (a supply is quiet: VBUS is the In2.Cu plane's net here, and not counted)
    ok(k, [
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '33' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '33' } },
      { op: 'connect', pins: ['R1.1', 'R2.1'], net: 'CLK' },
      { op: 'connect', pins: ['R1.2', 'R2.2'], net: 'GND' },
      { op: 'place', ref: 'R1', x_mm: 12, y_mm: 3, rot: 0, lock: true },
      { op: 'place', ref: 'R2', x_mm: 28, y_mm: 3, rot: 0, lock: true },
      { op: 'draw_track', from: 'R1.1', to: 'R2.1', via: [[13, 9.2], [27, 9.2]], bend: 'diagonal_first' },
    ]);
    expect(codes(k.board())).toContain('IMP.SPACING');
  });

  it('wants the plane under a line unbroken: a track crossing under it on 2 layers is an error', () => {
    const k = usb(2);
    ok(k, [
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } },
      { op: 'connect', pins: ['R1.1'], net: 'VBUS' },
      { op: 'connect', pins: ['R1.2', 'J1.1'], net: 'VBUS' },
      { op: 'place', ref: 'R1', x_mm: 20, y_mm: 16, rot: 90, lock: true },
      { op: 'set_impedance', nets: ['USB_DP'], ohms: 50 },
      { op: 'set_copper_mode', mode: 'drawn', keep: false },
      { op: 'draw_track', from: 'J1.2', to: 'J2.2', via: [[8, 10.73], [32, 10.73]], bend: 'diagonal_first' },
    ]);
    expect(codes(k.board()).filter((c) => c === 'IMP.REFERENCE')).toEqual([]);
    ok(k, [{ op: 'draw_track', from: [20, 4], to: [20, 15], net: 'VBUS', layer: 'B.Cu' }]);
    const found = k.board().diagnostics.find((x) => x.code === 'IMP.REFERENCE');
    expect(found?.severity).toBe('error');
    expect(found?.message).toMatch(/leaves its plane/);
  });

  it('keeps the route helper\'s tracks out from under a drawn line', () => {
    const k = usb(2);
    ok(k, [
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '10k' } },
      { op: 'connect', pins: ['R1.1', 'R2.1'], net: 'SIG' },
      { op: 'connect', pins: ['R1.2', 'R2.2'], net: 'GND' },
      { op: 'place', ref: 'R1', x_mm: 20, y_mm: 4, rot: 0, lock: true },
      { op: 'place', ref: 'R2', x_mm: 20, y_mm: 16, rot: 0, lock: true },
      { op: 'set_impedance', nets: ['USB_DP'], ohms: 50 },
      { op: 'set_copper_mode', mode: 'drawn', keep: false },
      { op: 'draw_track', from: 'J1.2', to: 'J2.2', via: [[8, 10.73], [32, 10.73]], bend: 'diagonal_first' },
      { op: 'route', nets: ['SIG'] },
    ]);
    const b = k.board();
    const sig = Object.entries(b.netNames).find(([, n]) => n === 'SIG')![0];
    const line = b.drawn!.tracks.find((t) => b.netNames[t.netId] === 'USB_DP')!;
    const band = line.width / 2 + b.impedance![0]!.layers[0]!.h;
    for (const t of b.tracks.filter((x) => x.netId === sig && x.layer === 'B.Cu')) {
      for (const p of pieces(t)) for (const q of pieces(line)) for (const [x, y] of [[p[0], p[1]], [p[2], p[3]], [(p[0] + p[2]) / 2, (p[1] + p[3]) / 2]]) expect(segDist(q, x!, y!)).toBeGreaterThan(band);
    }
    expect(codes(b).filter((c) => c === 'IMP.REFERENCE')).toEqual([]);
  });
});

describe('lines at a set impedance, the corner cases', () => {
  it('routes a line at its width and necks it only into a pad too small for it', () => {
    const k = new Kernel();
    ok(k, [
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
      { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10pF', package: '0402' } },
      { op: 'connect', pins: ['J1.1', 'C1.1'], net: 'RF' },
      { op: 'connect', pins: ['J1.2', 'C1.2'], net: 'GND' },
      { op: 'set_board', layers: 2, width_mm: 40, height_mm: 20 },
      { op: 'set_fab_profile', preset: 'jlcpcb' },
      { op: 'place', ref: 'J1', x_mm: 6, y_mm: 10, rot: 0, lock: true },
      { op: 'place', ref: 'C1', x_mm: 32, y_mm: 10, rot: 0, lock: true },
      { op: 'set_plane', layer: 'F.Cu', net: 'GND' },
      { op: 'set_impedance', nets: ['RF'], ohms: 50 },
      { op: 'route' },
    ]);
    const b = k.board();
    const w = b.impedance![0]!.layers[0]!.width;
    const rf = b.tracks.filter((t) => b.netNames[t.netId] === 'RF');
    const len = (t: Track) => pieces(t).reduce((s, p) => s + Math.hypot(p[2] - p[0], p[3] - p[1]), 0);
    expect(rf.filter((t) => t.width === w).reduce((s, t) => s + len(t), 0)).toBeGreaterThan(20);
    for (const t of rf.filter((x) => x.width < w)) expect(len(t)).toBeLessThan(1.5);
    expect(codes(b).filter((c) => c.startsWith('IMP.'))).toEqual([]);
  });

  it('keeps the pour gap on the line\'s own layer: the plane under it is not cut wider round its via', () => {
    const k = usb();
    ok(k, [
      { op: 'set_impedance', nets: ['USB_DP'], ohms: 50 },
      { op: 'set_plane', layer: 'F.Cu', net: 'GND' },
      { op: 'set_copper_mode', mode: 'drawn', keep: false },
      { op: 'draw_via', at: [20, 8.73], net: 'USB_DP' },
      { op: 'draw_track', from: 'J1.2', to: 'v1' },
      { op: 'draw_track', from: 'v1', to: 'J2.2', layer: 'B.Cu' },
    ]);
    const b = k.board();
    const gap = b.impedance![0]!.layers[0]!.pourGap!;
    expect(gap).toBeGreaterThan(b.rules.clearance);
    const hole = (layer: string) => b.zones.find((z) => z.layer === layer)!.shape!.cuts.find((c) => c.k === 'circle' && Math.hypot(c.x - 20, c.y - 8.73) < 0.01) as { d: number };
    expect(hole('In1.Cu').d).toBeCloseTo(0.6 + 2 * b.rules.clearance, 3);
    expect(hole('F.Cu').d).toBeCloseTo(0.6 + 2 * gap, 3);
  });

  it('routes again when a fence along a line is added', () => {
    const k = usb(2);
    ok(k, [{ op: 'set_plane', layer: 'F.Cu', net: 'GND' }, { op: 'set_impedance', nets: ['USB_DP'], ohms: 50 }, { op: 'route' }]);
    expect(k.board().routing).toBe('done');
    ok(k, [{ op: 'add_vias', kind: 'fence', net: 'GND', along: 'USB_DP', pitch_mm: 1.5 }]);
    expect(k.board().routing).toBe('stale');
    ok(k, [{ op: 'route' }]);
    expect(k.board().vias.filter((v) => v.group === 'V1').length).toBeGreaterThan(4);
  });

  it('takes the tolerance into account, and a coplanar gap asks for a coplanar line', () => {
    const k = usb();
    ok(k, [{ op: 'set_impedance', nets: ['USB_DP'], ohms: 50, width_mm: 0.3 }]);
    expect(refused(k, [{ op: 'set_impedance', nets: ['USB_DP'], ohms: 50, width_mm: 0.3, tolerance_pct: 2 }]).code).toBe('IMPEDANCE_IMPOSSIBLE');
    // (below the board's clearance a pour cannot come: lower the clearance first)
    expect(refused(k, [{ op: 'set_impedance', nets: ['USB_DN'], ohms: 50, coplanar_gap_mm: 0.15 }]).message).toMatch(/below the board's clearance \(0\.2 mm\)/);
    ok(k, [{ op: 'set_board', clearance_mm: 0.15 }, { op: 'set_impedance', nets: ['USB_DN'], ohms: 50, coplanar_gap_mm: 0.15 }]);
    const v = k.boardPlacement().impedance!.find((x) => x.id === 'Z2')!;
    expect(v.style).toBe('coplanar');
    expect(v.layers[0]!.side).toBe(0.15);
    // a pour that keeps further off than asked: the line is worked out for the gap the pour leaves
    ok(k, [{ op: 'set_plane', layer: 'F.Cu', net: 'GND' }, { op: 'set_plane_style', layer: 'F.Cu', net: 'GND', clearance_mm: 0.3 }]);
    expect(k.boardPlacement().impedance!.find((x) => x.id === 'Z2')!.layers[0]!.side).toBe(0.3);
  });

  it('refuses a pair whose corners leave no room to turn', () => {
    const k = usb();
    ok(k, [{ op: 'set_impedance', nets: ['USB_DP', 'USB_DN'], ohms: 90 }, { op: 'set_copper_mode', mode: 'drawn', keep: false }]);
    // the first piece holds the tracks coming together but not the turn after it
    expect(refused(k, [{ op: 'draw_pair', from: ['J1.2', 'J1.3'], to: ['J2.2', 'J2.3'], via: [[7.079, 10], [7.079, 16], [30, 16]] }]).message).toMatch(/first piece/);
    // two right angles closer than the pair is wide
    expect(refused(k, [{ op: 'draw_pair', from: ['J1.2', 'J1.3'], to: ['J2.2', 'J2.3'], via: [[12, 10], [12, 13], [12.3, 13], [12.3, 10], [30, 10]] }]).message).toMatch(/to turn at both of its corners/);
  });

  it('judges a pair drawn at another width and gap by what they give together', () => {
    const k = usb();
    ok(k, [{ op: 'set_impedance', nets: ['USB_DP', 'USB_DN'], ohms: 90, gap_mm: 0.25 }, { op: 'set_copper_mode', mode: 'drawn', keep: false }]);
    const lay = k.boardPlacement().impedance![0]!.layers[0]!;
    // the same impedance from a narrower track at a tighter gap
    const s = 0.2;
    const w = widthForLine(90, { ...{ t: 0.035, below: [{ h: lay.h, er: lay.er }], mask: { base: 0.0305, copper: 0.0152, er: 3.8 } }, s })!;
    const r = ok(k, [{ op: 'draw_pair', from: ['J1.2', 'J1.3'], to: ['J2.2', 'J2.3'], via: [[10, 10], [30, 10]], width_mm: Math.round(w * 1000) / 1000, gap_mm: s }]);
    expect(r.results[0]!.effect).not.toMatch(/IMP\./);
    expect(codes(k.board()).filter((c) => c === 'IMP.WIDTH' || c === 'IMP.GAP')).toEqual([]);
    // too wide for that gap: the width check says so, with the gap it measured
    ok(k, [{ op: 'edit_copper', ids: ['t1', 't2'], width_mm: 0.4 }]);
    expect(k.board().diagnostics.find((x) => x.code === 'IMP.WIDTH')?.message).toMatch(/mm from its partner/);
  });
});
