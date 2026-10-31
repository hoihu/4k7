import { describe, expect, it } from 'vitest';
import type { BoardPart, BoardView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { describeConstraint } from '../src/netops.ts';
import { Grid } from '../src/congestion.ts';
import { buckTransaction } from './fixtures.ts';

function buck() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k;
}

const ok = (k: Kernel, ops: unknown[]) => {
  const r = k.transact({ summary: 'test', ops });
  if (r.status !== 'ok') throw new Error(JSON.stringify(r));
  return r;
};
const part = (b: BoardView, ref: string) => b.parts.find((p) => p.refdes === ref)!;
const sideOf = (k: Kernel, ref: string) => part(k.board(), ref).side;
const smd2 = (k: Kernel) => k.board().parts.filter((p) => p.pads.length === 2 && p.pads.every((q) => !q.drill));
const ledgerOf = (k: Kernel) => Object.values(k.draftDesign().ledger).map((x) => describeConstraint(k.draftDesign(), x));
const overlaps = (b: BoardView) => b.diagnostics.filter((x) => x.code === 'DRC.COURTYARD_OVERLAP');

describe('a part\'s side (place side, constrain layer)', () => {
  it('place takes a side; no side keeps the one it has; top is the default and leaves no constraint', () => {
    const k = buck();
    const c = smd2(k)[0]!;
    const r = ok(k, [{ op: 'place', ref: c.refdes, x_mm: c.x, y_mm: c.y, side: 'bottom' }]);
    expect(r.results[0]!.effect).toMatch(/on the bottom side$/);
    expect(sideOf(k, c.refdes)).toBe('bottom');
    expect(ledgerOf(k).filter((x) => x === `layer(${c.refdes}) = bottom`)).toHaveLength(1);
    // moved without a side: it stays where it is on the other side
    ok(k, [{ op: 'place', ref: c.refdes, x_mm: c.x + 1, y_mm: c.y }]);
    expect(sideOf(k, c.refdes)).toBe('bottom');
    // and back: the constraint is gone, nothing is left saying "top"
    ok(k, [{ op: 'place', ref: c.refdes, x_mm: c.x + 1, y_mm: c.y, side: 'top' }]);
    expect(sideOf(k, c.refdes)).toBe('top');
    expect(ledgerOf(k).filter((x) => x.startsWith(`layer(${c.refdes})`))).toEqual([]);
  });

  it('constrain layer and place side are one thing; a hard layer constraint is not overridden', () => {
    const k = buck();
    const [a, b] = smd2(k);
    ok(k, [{ op: 'constrain', kind: 'layer', a: a!.refdes, value: 'bottom', strength: 'hard' }]);
    const r = k.transact({ summary: 'no', ops: [{ op: 'place', ref: a!.refdes, x_mm: a!.x, y_mm: a!.y, side: 'top' }] });
    expect(r.status).toBe('rejected');
    expect(sideOf(k, a!.refdes)).toBe('bottom');
    ok(k, [{ op: 'place', ref: b!.refdes, x_mm: b!.x, y_mm: b!.y, side: 'bottom' }]);
    expect(smd2(k).filter((p) => p.side === 'bottom').map((p) => p.refdes).sort()).toEqual([a!.refdes, b!.refdes].sort());
  });

  it('propose_placement and try_placements take the side of a main part', () => {
    const k = buck();
    const parts = [{ ref: 'U1', x_mm: 14, y_mm: 11 }, { ref: 'C3', x_mm: 14, y_mm: 11, side: 'bottom' }] as const;
    // the trial changes nothing but measures the option with D1 under U1
    const t = k.query({ op: 'try_placements', explore: false, candidates: [{ parts }] }) as { options: { error?: string; overlaps?: number }[] };
    expect(t.options[0]!.error).toBeUndefined();
    expect(sideOf(k, 'C3')).toBe('top');
    ok(k, [{ op: 'propose_placement', parts }]);
    const b = k.board();
    // (the board is fitted round the arrangement, so both may have moved over by a grid step)
    expect(part(b, 'C3').side).toBe('bottom');
    expect(Math.hypot(part(b, 'C3').x - part(b, 'U1').x, part(b, 'C3').y - part(b, 'U1').y)).toBeLessThan(0.2);
    expect(part(b, 'U1').side).toBe('top');
    expect(overlaps(b)).toEqual([]);
  });

  it('get_board lists the parts on the bottom, and each part\'s side', () => {
    const k = buck();
    const sum = (k.query({ op: 'get_board' }) as { bottom_side?: unknown; parts: { refdes: string; side: string }[] });
    expect(sum.bottom_side).toBeUndefined();
    const c = smd2(k)[0]!;
    ok(k, [{ op: 'place', ref: c.refdes, x_mm: c.x, y_mm: c.y, side: 'bottom' }]);
    const after = k.query({ op: 'get_board' }) as { bottom_side: { parts: string[] }; parts: { refdes: string; side: string }[] };
    expect(after.bottom_side.parts).toEqual([c.refdes]);
    expect(after.parts.find((p) => p.refdes === c.refdes)!.side).toBe('bottom');
  });
});

describe('the footprint on the bottom', () => {
  it('is mirrored about the part\'s vertical axis, pin numbers kept, pads on B.Cu', () => {
    const k = buck();
    ok(k, [{ op: 'place', ref: 'U1', x_mm: 14, y_mm: 11, rot: 0, lock: true }]);
    const top = part(k.board(), 'U1');
    ok(k, [{ op: 'place', ref: 'U1', x_mm: 14, y_mm: 11, side: 'bottom' }]);
    const bot = part(k.board(), 'U1');
    expect(bot.rot).toBe(0);
    // a SOIC-8: pin 1 at the top left on the top side, at the top right seen through the board
    const p1 = (p: BoardPart) => p.pads.find((q) => q.number === '1')!;
    expect([p1(top).x, p1(top).y]).toEqual([11.35, 9.095]);
    expect([p1(bot).x, p1(bot).y]).toEqual([16.65, 9.095]);
    for (const q of top.pads) {
      const m = bot.pads.find((o) => o.number === q.number)!;
      expect([m.x, m.y, m.w, m.h]).toEqual([Math.round((28 - q.x) * 1000) / 1000, q.y, q.w, q.h]);
      expect(m.layers).toEqual(['B.Cu']);
      expect(q.layers).toEqual(['F.Cu']);
    }
    // the courtyard and body are centred, so they stay; the pin-1 corner mark moved to the right with the pad
    expect(bot.courtyard).toEqual(top.courtyard);
    expect(bot.body.chamfer?.corners ?? []).not.toEqual(top.body.chamfer?.corners ?? []);
    expect(bot.mark?.kind).toBe('pin1');
  });

  it('turns with the part: mirrored first, then rotated clockwise by rot', () => {
    const k = buck();
    ok(k, [{ op: 'place', ref: 'U1', x_mm: 14, y_mm: 11, rot: 90, lock: true }]);
    const top = part(k.board(), 'U1');
    ok(k, [{ op: 'place', ref: 'U1', x_mm: 14, y_mm: 11, side: 'bottom' }]);
    const bot = part(k.board(), 'U1');
    // a part turned by 90° stands with its pin rows across: the mirror flips y now
    for (const q of top.pads) {
      const m = bot.pads.find((o) => o.number === q.number)!;
      expect([m.x, m.y]).toEqual([q.x, Math.round((22 - q.y) * 1000) / 1000]);
    }
  });

  it('a through-hole part keeps its pads on every layer', () => {
    const k = buck();
    ok(k, [{ op: 'place', ref: 'J1', x_mm: 5, y_mm: 8, side: 'bottom' }]);
    const j1 = part(k.board(), 'J1');
    expect(j1.side).toBe('bottom');
    expect(j1.pads.every((q) => q.layers.length === 2)).toBe(true);
  });
});

describe('courtyards per side', () => {
  it('an SMD part under an SMD part on the other side is no overlap; on the same side it is; a through-hole part takes both', () => {
    const k = buck();
    ok(k, [{ op: 'place', ref: 'U1', x_mm: 14, y_mm: 11, lock: true }]);
    const cap = smd2(k).find((p) => p.refdes !== 'U1')!;
    ok(k, [{ op: 'place', ref: cap.refdes, x_mm: 14, y_mm: 11, side: 'bottom', lock: true }]);
    expect(overlaps(k.board())).toEqual([]);
    // a through-hole part on either side over it: its leads and body are on both
    ok(k, [{ op: 'place', ref: 'J1', x_mm: 14, y_mm: 11, lock: true }]);
    const b = k.board();
    expect(overlaps(b).length).toBeGreaterThan(0);
    expect(overlaps(b).every((x) => x.entities.includes('J1'))).toBe(true);
    // the other SMD part on the bottom, not on the cap: no further overlap with U1 on top
    expect(overlaps(b).some((x) => x.entities.includes('U1') && x.entities.includes(cap.refdes))).toBe(false);
  });

  it('the placer keeps same-side parts apart and lets the sides share the room', () => {
    const k = buck();
    const caps = smd2(k).slice(0, 4);
    for (const c of caps) ok(k, [{ op: 'place', ref: c.refdes, x_mm: c.x, y_mm: c.y, side: 'bottom' }]);
    ok(k, [{ op: 'propose_placement' }]);
    const b = k.board();
    expect(overlaps(b)).toEqual([]);
    expect(caps.every((c) => part(b, c.refdes).side === 'bottom')).toBe(true);
    // a board with a quarter of the parts on the other side is smaller than the one-sided one
    const one = buck();
    ok(one, [{ op: 'propose_placement' }]);
    const area = (v: BoardView) => v.outline.w * v.outline.h;
    expect(area(b)).toBeLessThanOrEqual(area(one.board()));
  });
});

describe('congestion by side', () => {
  it('a pad takes the room of its own layer only; a through-hole pad of both', () => {
    const rules = { track: 0.2, clearance: 0.2 };
    const pad = (layers: string[], drill?: number) => ({ x: 4.5, y: 4.5, w: 3, h: 3, layers: layers as never, ...(drill ? { drill } : {}) });
    const cap = (pads: ReturnType<typeof pad>[]) => new Grid({ w: 9, h: 9, rules, signal: ['F.Cu', 'B.Cu'], pads }).cap[4]!;
    const empty = cap([]);
    const top = cap([pad(['F.Cu'])]);
    const bottom = cap([pad(['B.Cu'])]);
    const both = cap([pad(['F.Cu']), pad(['B.Cu'])]);
    expect(top).toBeLessThan(empty);
    expect(bottom).toBeCloseTo(top, 6);
    expect(both).toBeCloseTo(empty - 2 * (empty - top), 6);
    expect(cap([pad(['F.Cu', 'B.Cu'], 1)])).toBeCloseTo(both, 6);
  });
});

describe('copper to a bottom part', () => {
  it('the router connects its pads and every net is whole', () => {
    const k = buck();
    for (const c of smd2(k).slice(0, 3)) ok(k, [{ op: 'place', ref: c.refdes, x_mm: c.x, y_mm: c.y, side: 'bottom' }]);
    ok(k, [{ op: 'route' }]);
    const b = k.board();
    expect(b.ratsnest).toEqual([]);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    // each bottom pad has copper of its net on B.Cu (a track, a pour or a via beside it) or a via at it
    for (const p of b.parts.filter((q) => q.side === 'bottom')) {
      for (const pad of p.pads.filter((q) => q.netId)) {
        const near = (x: number, y: number, r: number) => Math.hypot(x - pad.x, y - pad.y) <= r + 1e-6;
        const track = b.tracks.some((t) => t.netId === pad.netId && t.layer === 'B.Cu' && near(t.pts[0]!, t.pts[1]!, 0.01) || (t.netId === pad.netId && t.layer === 'B.Cu' && near(t.pts.at(-2)!, t.pts.at(-1)!, 0.01)));
        const zone = b.zones.some((z) => z.netId === pad.netId && z.layer === 'B.Cu');
        expect(track || zone, `${p.refdes}.${pad.number}`).toBe(true);
      }
    }
  });

  it('drawn copper starts on a bottom pad on B.Cu, and a via takes it to the top', () => {
    const k = buck();
    ok(k, [{ op: 'set_copper_mode', mode: 'drawn', keep: false }]);
    ok(k, [{ op: 'place', ref: 'C3', x_mm: part(k.board(), 'C3').x, y_mm: part(k.board(), 'C3').y, side: 'bottom' }]);
    const b0 = k.board();
    const c3 = part(b0, 'C3');
    expect(c3.pads.every((q) => q.layers.join() === 'B.Cu')).toBe(true);
    // beyond pad 1, away from pad 2
    const [a, o] = [c3.pads[0]!, c3.pads[1]!];
    const len = Math.hypot(a.x - o.x, a.y - o.y);
    const [px, py] = [a.x + ((a.x - o.x) / len) * 1.5, a.y + ((a.y - o.y) / len) * 1.5];
    const r = ok(k, [
      { op: 'draw_track', from: 'C3.1', to: [px, py] }, // t1: from the bottom pad, on B.Cu
      { op: 'draw_via', net: 'SS', at: [px, py] }, // v2
      { op: 'draw_track', from: 'v2', to: 'U1.SS', layer: 'F.Cu' }, // t3: on the top to U1
    ]);
    expect(r.results[0]!.effect).toMatch(/^track t1: SS on B\.Cu/);
    const b = k.board();
    expect(b.drawn!.vias).toHaveLength(1);
    expect(b.unrouted.filter((u) => u.netId === c3.pads[0]!.netId)).toEqual([]);
    expect(b.diagnostics.filter((x) => x.severity === 'error' && !x.code.startsWith('DRC.UNROUTED'))).toEqual([]);
  });
});

describe('turning a part over', () => {
  it('moves only that part; the rest of the board stays where it was', () => {
    const k = buck();
    ok(k, [{ op: 'propose_placement' }]);
    const before = k.board();
    const c = smd2(k)[0]!;
    ok(k, [{ op: 'place', ref: c.refdes, x_mm: c.x, y_mm: c.y, side: 'bottom' }]);
    const after = k.board();
    for (const p of before.parts.filter((q) => q.refdes !== c.refdes)) expect([part(after, p.refdes).x, part(after, p.refdes).y, part(after, p.refdes).side]).toEqual([p.x, p.y, p.side]);
    expect(after.parts.filter((p) => p.side === 'bottom').map((p) => p.refdes)).toEqual([c.refdes]);
  });
});
