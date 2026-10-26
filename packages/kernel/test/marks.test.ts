import { describe, expect, it } from 'vitest';
import { roundPadDist, type BoardPad, type BoardPart, type BoardView, type PartCard } from '@4k7/schema';
import { getBuiltinPart } from '@4k7/parts';
import { Kernel } from '../src/index.ts';
import { placeMarks, polarityOf } from '../src/marks.ts';
import { buckTransaction } from './fixtures.ts';

function buck() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k;
}

const card = (category: PartCard['category'], names: string[], polarity?: PartCard['polarity']): PartCard => ({
  id: `acme:${names.join('_')}`,
  description: 'test part',
  category,
  refPrefix: 'X',
  pins: names.map((name, i) => ({ number: String(i + 1), name, type: 'passive' })),
  params: {},
  provenance: { source: 'user' },
  ...(polarity ? { polarity } : {}),
});

/** The ink of a part's mark: points along its strokes and its dots, with the ink's half width. */
function ink(p: BoardPart) {
  const out = p.mark!.dots.map((d) => ({ x: d.x, y: d.y, r: d.d / 2 }));
  for (const s of p.mark!.strokes) {
    for (let i = 0; i + 3 < s.pts.length; i += 2) {
      const [x0, y0, x1, y1] = s.pts.slice(i, i + 4) as [number, number, number, number];
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.02);
      for (let j = 0; j <= n; j++) out.push({ x: x0 + ((x1 - x0) * j) / n, y: y0 + ((y1 - y0) * j) / n, r: s.w / 2 });
    }
  }
  return out;
}

const padDist = (pad: BoardPad, x: number, y: number) => (pad.shape === 'round' ? roundPadDist(pad, x, y) : Math.hypot(Math.max(Math.abs(x - pad.x) - pad.w / 2, 0), Math.max(Math.abs(y - pad.y) - pad.h / 2, 0)));

/** How far a part's mark keeps from copper on its side (pads of every part) and from vias, and whose pad it is nearest. */
function clearance(b: BoardView, p: BoardPart) {
  let copper = Infinity;
  for (const q of b.parts) for (const pad of q.pads) if (pad.drill || pad.layers.includes(p.side === 'top' ? 'F.Cu' : 'B.Cu')) for (const s of ink(p)) copper = Math.min(copper, padDist(pad, s.x, s.y) - s.r);
  for (const v of b.vias) for (const s of ink(p)) copper = Math.min(copper, Math.hypot(s.x - v.x, s.y - v.y) - v.pad / 2 - s.r);
  const pts = ink(p);
  const cx = pts.reduce((a, s) => a + s.x, 0) / pts.length;
  const cy = pts.reduce((a, s) => a + s.y, 0) / pts.length;
  let nearest = '';
  let best = Infinity;
  for (const q of b.parts) for (const pad of q.pads) if (!pad.npth && padDist(pad, cx, cy) < best) [best, nearest] = [padDist(pad, cx, cy), q.refdes];
  return { copper, nearest };
}

describe('polarity: which pin a part marks', () => {
  it('reads it off the pin names: cathode K, the plus terminal, pin 1 of the rest', () => {
    expect(polarityOf(getBuiltinPart('generic:D')!)).toEqual({ kind: 'cathode', pin: '1' });
    expect(polarityOf(getBuiltinPart('generic:LED')!)).toEqual({ kind: 'cathode', pin: '1' });
    expect(polarityOf(getBuiltinPart('generic:CP')!)).toEqual({ kind: 'plus', pin: '1' });
    for (const id of ['generic:R', 'generic:C', 'generic:L']) expect(polarityOf(getBuiltinPart(id)!), id).toBeNull();
    expect(polarityOf(getBuiltinPart('ti:TPS54331DR')!)).toEqual({ kind: 'pin1', pin: '1' });
    // an imported LED with its pins spelled out, a buzzer with + and −, a cap with only its − named
    expect(polarityOf(card('other', ['Anode', 'Cathode']))).toEqual({ kind: 'cathode', pin: '2' });
    expect(polarityOf(card('led', ['A', 'NC']))).toEqual({ kind: 'cathode', pin: '2' });
    expect(polarityOf(card('other', ['+', '-']))).toEqual({ kind: 'plus', pin: '1' });
    expect(polarityOf(card('capacitor', ['1', '−']))).toEqual({ kind: 'plus', pin: '1' });
    // "A" names the anode only on a diode or an LED (a switch has pins A and B)
    expect(polarityOf(card('other', ['A', 'B']))).toEqual({ kind: 'pin1', pin: '1' });
  });

  it('says it does not know for a diode whose pins do not name the cathode, and takes set_polarity', () => {
    expect(polarityOf(card('diode', ['1', '2']))).toBe('unknown');
    expect(polarityOf(card('diode', ['1', '2'], { mark: 'cathode', pin: '2' }))).toEqual({ kind: 'cathode', pin: '2' });
    expect(polarityOf(card('diode', ['1', '2'], { mark: 'none' }))).toBeNull();
    expect(polarityOf(card('ic', ['VDD', 'GND', 'OUT'], { mark: 'pin1' }))).toEqual({ kind: 'pin1', pin: '1' });
    // a single pin has no way round
    expect(polarityOf(card('other', ['TP']))).toBeNull();
  });
});

describe('polarity marks on the board', () => {
  it('marks the diode with a band at its cathode, the IC and the connector with a dot by pin 1; R, C and L get none', () => {
    const b = buck().board();
    const part = (r: string) => b.parts.find((p) => p.refdes === r)!;
    for (const r of ['R1', 'R2', 'R3', 'C1', 'C2', 'C3', 'C5', 'L1']) expect(part(r).mark, r).toBeUndefined();
    const d1 = part('D1');
    expect(d1.mark).toMatchObject({ kind: 'cathode', pad: '1', dots: [] });
    // one band across the body, between the pads and nearer the cathode, like the band on the part
    const [band] = d1.mark!.strokes;
    expect(d1.mark!.strokes).toHaveLength(1);
    const [k, a] = [d1.pads.find((q) => q.number === '1')!, d1.pads.find((q) => q.number === '2')!];
    const horizontal = Math.abs(k.x - a.x) > Math.abs(k.y - a.y);
    const along = (x: number, y: number) => (horizontal ? x : y);
    const at = along(band!.pts[0]!, band!.pts[1]!);
    expect(Math.abs(at - along(k.x, k.y))).toBeLessThan(Math.abs(at - along(a.x, a.y)));
    expect((at - along(k.x, k.y)) * (at - along(a.x, a.y))).toBeLessThan(0);
    const u1 = part('U1');
    expect(u1.mark).toMatchObject({ kind: 'pin1', pad: '1', strokes: [] });
    expect(u1.mark!.dots).toHaveLength(1);
    expect(u1.mark!.dots[0]!.d).toBeGreaterThanOrEqual(0.35);
    // the body's corner at pin 1 is chamfered
    expect(u1.body.chamfer?.corners).toHaveLength(1);
    expect(part('J1').mark?.dots).toHaveLength(1);
    expect(b.diagnostics.filter((x) => /POLARITY/.test(x.code))).toEqual([]);
  });

  it('keeps every mark clear of copper and vias, nearer its own pads than any other part\'s, on a routed board too', () => {
    const k = buck();
    for (const b of [k.board(), (k.transact({ summary: 'route', ops: [{ op: 'route' }] }), k.board())]) {
      for (const p of b.parts.filter((q) => q.mark)) {
        const c = clearance(b, p);
        expect(c.copper, p.refdes).toBeGreaterThanOrEqual(0.15 - 1e-6);
        expect(c.nearest, p.refdes).toBe(p.refdes);
      }
    }
  });

  it('marks a part on the bottom side clear of the bottom copper', () => {
    const k = buck();
    k.transact({ summary: 'D1 underneath', ops: [{ op: 'constrain', kind: 'layer', a: 'D1', value: 'bottom' }] });
    const b = k.board();
    const d1 = b.parts.find((p) => p.refdes === 'D1')!;
    expect(d1.side).toBe('bottom');
    expect(d1.mark?.strokes).toHaveLength(1);
    expect(clearance(b, d1).copper).toBeGreaterThanOrEqual(0.15 - 1e-6);
  });
});

describe('placing a mark where there is room', () => {
  /** An SOD-123 diode at (10, 10), cathode (pad 1) on the left, alone on a 20 × 20 board, with vias where given. */
  function board(vias: [number, number][]): BoardView {
    const pad = (number: string, x: number): BoardPad => ({ number, x, y: 10, w: 0.95, h: 0.95, shape: 'rect', layers: ['F.Cu'] });
    const d1: BoardPart = {
      componentId: 'c_d1',
      refdes: 'D1',
      value: 'B340A',
      part: 'generic:D',
      pkg: 'SOD-123',
      pkgInfo: { name: 'SOD-123', family: 'SOD', pins: 2 },
      x: 10,
      y: 10,
      rot: 0,
      side: 'top',
      pads: [pad('1', 8.35), pad('2', 11.65)],
      body: { x: 8.65, y: 9.2, w: 2.7, h: 1.6 },
      courtyard: { x: 7.5, y: 8.9, w: 5, h: 2.2 },
      polarized: true,
      locked: false,
      mark: { kind: 'cathode', pad: '1', strokes: [], dots: [] },
    };
    return { outline: { w: 20, h: 20 }, cornerRadius: 0, shape: null, cutouts: [], parts: [d1], vias: vias.map(([x, y]) => ({ netId: 'n', x, y, drill: 0.3, pad: 0.6 })) } as unknown as BoardView;
  }

  it('puts the band between the pads, against the cathode', () => {
    const { parts, diagnostics } = placeMarks(board([]));
    const [s] = parts[0]!.mark!.strokes;
    expect(diagnostics).toEqual([]);
    expect(s!.w).toBe(0.3);
    // vertical, 0.15 mm off the cathode pad's inner edge (8.825) plus half the band
    expect(s!.pts[0]).toBeCloseTo(s!.pts[2]!, 6);
    expect(s!.pts[0]).toBeCloseTo(8.825 + 0.15 + 0.15 + 0.02, 3);
  });

  it('goes beyond the cathode\'s end when a via sits between the pads', () => {
    const { parts, diagnostics } = placeMarks(board([[9.4, 10]]));
    expect(diagnostics).toEqual([]);
    const [s] = parts[0]!.mark!.strokes;
    expect(s!.pts[0]).toBeLessThan(8.35 - 0.475);
  });

  it('says so when there is no room at all', () => {
    const ring: [number, number][] = [];
    for (let x = 7; x <= 13; x += 0.6) ring.push([x, 9.1], [x, 10.9]);
    ring.push([7.3, 10], [9.4, 10], [10.6, 10], [12.7, 10]);
    const { parts, diagnostics } = placeMarks(board(ring));
    expect(parts[0]!.mark).toMatchObject({ kind: 'cathode', strokes: [], dots: [] });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: 'DRC.SILK_POLARITY', severity: 'warning', entities: ['D1'] });
    expect(diagnostics[0]!.message).toContain('the via at');
  });
});

describe('set_polarity', () => {
  /** A design with an imported diode whose pins are only numbered. */
  function withTvs() {
    const k = new Kernel();
    const d = k.committedDesign();
    d.parts['acme:SMAJ5'] = { ...card('diode', ['1', '2']), id: 'acme:SMAJ5', mpn: 'SMAJ5.0A', refPrefix: 'D', package: 'SMA' };
    k.load(d);
    k.transact({ summary: 'tvs', ops: [
      { op: 'add_part', part: 'acme:SMAJ5', refdes: 'D1' },
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
      { op: 'connect', pins: ['J1.1', 'D1.1'], net: 'VCC' },
      { op: 'connect', pins: ['J1.2', 'D1.2'], net: 'GND' },
    ] });
    return k;
  }

  it('asks for the cathode of a diode whose pins do not say it, and marks it once told', () => {
    const k = withTvs();
    let b = k.board();
    const unknown = b.diagnostics.find((x) => x.code === 'DRC.POLARITY_UNKNOWN');
    expect(unknown?.entities).toEqual(['D1']);
    expect(unknown?.message).toContain('set_polarity');
    expect(b.parts.find((p) => p.refdes === 'D1')!.mark).toBeUndefined();
    const r = k.transact({ summary: 'cathode', ops: [{ op: 'set_polarity', ref: 'D1', mark: 'cathode', pin: '1' }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    b = k.board();
    expect(b.diagnostics.some((x) => x.code === 'DRC.POLARITY_UNKNOWN')).toBe(false);
    expect(b.parts.find((p) => p.refdes === 'D1')!.mark).toMatchObject({ kind: 'cathode', pad: '1' });
    expect(b.parts.find((p) => p.refdes === 'D1')!.mark!.strokes).toHaveLength(1);
    // a bidirectional TVS fits either way round: no mark, no question
    k.transact({ summary: 'bidirectional', ops: [{ op: 'set_polarity', ref: 'D1', mark: 'none' }] });
    b = k.board();
    expect(b.parts.find((p) => p.refdes === 'D1')).toMatchObject({ polarized: false });
    expect(b.parts.find((p) => p.refdes === 'D1')!.mark).toBeUndefined();
    expect(b.diagnostics.some((x) => x.code === 'DRC.POLARITY_UNKNOWN')).toBe(false);
    // auto: back to the pins' names
    k.transact({ summary: 'auto', ops: [{ op: 'set_polarity', ref: 'D1', mark: 'auto' }] });
    expect(k.board().diagnostics.some((x) => x.code === 'DRC.POLARITY_UNKNOWN')).toBe(true);
  });

  it('refuses a pin the part does not have, and a generic part (its pin names say it for every user)', () => {
    const k = withTvs();
    expect(k.transact({ summary: 'bad pin', ops: [{ op: 'set_polarity', ref: 'D1', mark: 'cathode', pin: '3' }] }).rejection?.message).toContain('no pin "3"');
    const b = buck();
    const r = b.transact({ summary: 'generic', ops: [{ op: 'set_polarity', ref: 'D1', mark: 'none' }] });
    expect(r.status).toBe('rejected');
    expect(r.rejection?.message).toContain('generic:D');
  });
});
