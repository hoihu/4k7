import { describe, expect, it } from 'vitest';
import { boardSummary } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

/**
 * draw_track while the router lays the copper: one connection laid as the agent asks, kept in the
 * design, laid first on every route (docs/design/layout.md §5.8).
 */
function buck() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  k.transact({ summary: 'route', ops: [{ op: 'route' }] });
  return k;
}

/** The track passes within 0.06 mm of (x, y). */
const passes = (pts: number[], x: number, y: number) => {
  for (let q = 0; q + 3 < pts.length; q += 2) {
    const [ax, ay, bx, by] = [pts[q]!, pts[q + 1]!, pts[q + 2]!, pts[q + 3]!];
    const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const u = l2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2)) : 0;
    if (Math.hypot(ax + u * (bx - ax) - x, ay + u * (by - ay) - y) < 0.06) return true;
  }
  return false;
};

describe('draw_track with router copper', () => {
  it('lays the switch node as asked: through its point, at its width, and the route keeps it', () => {
    const k = buck();
    const r = k.transact({ summary: 'sw', ops: [{ op: 'draw_track', from: 'U1.8', to: 'D1.1', layer: 'F.Cu', width_mm: 0.8, via: [[15.5, 7.5]] }] });
    expect(r.status).toBe('ok');
    // the board changed: routing is out of date until route runs
    expect(k.board().routing).toBe('stale');
    expect(k.board().laid).toEqual([{ id: 't1', netId: expect.any(String), from: 'U1.8', to: 'D1.1', layer: 'F.Cu', width: 0.8, through: [{ x: 15.5, y: 7.5 }] }]);
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.laid![0]!.laid).toBe(true);
    const mine = b.tracks.filter((t) => t.laid === 't1');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((t) => t.layer === 'F.Cu')).toBe(true);
    expect(mine.some((t) => t.width === 0.8)).toBe(true);
    expect(mine.some((t) => passes(t.pts, 15.5, 7.5))).toBe(true);
    expect(b.unrouted).toEqual([]);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    const s = boardSummary(b) as { laid_tracks?: { id: string; state: string }[] };
    expect(s.laid_tracks).toEqual([expect.objectContaining({ id: 't1', from: 'U1.8', to: 'D1.1', state: 'laid as asked' })]);
  });

  it('moves with the parts: the point near a part follows it, and the track is laid again there', () => {
    const k = buck();
    k.transact({ summary: 'sw', ops: [{ op: 'draw_track', from: 'U1.8', to: 'D1.1', layer: 'F.Cu', via: [[14, 8]] }] });
    const d1 = k.board().parts.find((p) => p.refdes === 'D1')!;
    k.transact({ summary: 'move', ops: [{ op: 'place', ref: 'D1', x_mm: d1.x - 1, y_mm: d1.y }] });
    const b0 = k.board();
    const pad = b0.parts.find((p) => p.refdes === 'D1')!.pads.find((p) => p.number === '1')!;
    // (14, 8) was nearer D1.1 (14, 6.9) than U1.8: it keeps its place relative to that pad
    expect(b0.laid![0]!.through).toEqual([{ x: Math.round(pad.x * 1000) / 1000, y: Math.round((pad.y + 1.1) * 1000) / 1000 }]);
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.laid![0]!.laid).toBe(true);
    expect(b.tracks.filter((t) => t.laid === 't1').some((t) => passes(t.pts, b.laid![0]!.through[0]!.x, b.laid![0]!.through[0]!.y))).toBe(true);
  });

  it('changes layer at a point given one, with a via there', () => {
    const k = buck();
    expect(k.transact({ summary: 'sw', ops: [{ op: 'draw_track', from: 'U1.8', to: 'D1.1', layer: 'F.Cu', via: [[16.5, 8.2, 'B.Cu'], [14, 8.2, 'F.Cu']] }] }).status).toBe('ok');
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.laid![0]!.laid).toBe(true);
    expect(b.vias.filter((v) => v.laid === 't1').map((v) => [v.x, v.y])).toEqual([[16.5, 8.2], [14, 8.2]]);
    expect([...new Set(b.tracks.filter((t) => t.laid === 't1').map((t) => t.layer))].sort()).toEqual(['B.Cu', 'F.Cu']);
    expect(b.unrouted).toEqual([]);
  });

  it('one that finds no way is not laid: the DRC says why, and the router routes the connection', () => {
    const k = buck();
    // through the middle of U1's GND pin (16.5, 10.37), on its layer
    expect(k.transact({ summary: 'sw', ops: [{ op: 'draw_track', from: 'U1.8', to: 'D1.1', layer: 'F.Cu', via: [[16.5, 10.37]] }] }).status).toBe('ok');
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.laid![0]!.laid).toBe(false);
    expect(b.laid![0]!.why).toMatch(/^\(16\.5, 10\.37\) has no room for a 0\.25 mm track on F\.Cu: .* too close \(GND is in the way\)$/);
    const w = b.diagnostics.find((x) => x.code === 'DRC.TRACK_NOT_LAID')!;
    expect(w.severity).toBe('warning');
    expect(w.message).toMatch(/^t1 \(U1\.8 → D1\.1, SW\) is not laid as asked: /);
    expect(w.entities.sort()).toEqual(['D1', 'U1']);
    expect(b.tracks.some((t) => t.laid)).toBe(false);
    expect(b.unrouted).toEqual([]);
  });

  it('is replaced by a track between the same pads, and taken away by erase_copper', () => {
    const k = buck();
    k.transact({ summary: 'a', ops: [{ op: 'draw_track', from: 'U1.8', to: 'D1.1' }] });
    const r = k.transact({ summary: 'b', ops: [{ op: 'draw_track', from: 'D1.1', to: 'U1.8', layer: 'F.Cu' }] });
    expect(r.status).toBe('ok');
    expect(k.board().laid!.map((t) => [t.id, t.layer])).toEqual([['t1', 'F.Cu']]);
    k.transact({ summary: 'c', ops: [{ op: 'draw_track', from: 'L1.1', to: 'D1.1' }] });
    expect(k.board().laid!.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(k.transact({ summary: 'd', ops: [{ op: 'erase_copper', ids: ['t1'] }] }).status).toBe('ok');
    expect(k.board().laid!.map((t) => t.id)).toEqual(['t2']);
    expect(k.transact({ summary: 'e', ops: [{ op: 'erase_copper', ids: ['t1'] }] }).status).toBe('rejected');
    expect(k.transact({ summary: 'f', ops: [{ op: 'erase_copper', parts: ['L1'] }] }).status).toBe('ok');
    expect(k.board().laid).toBeUndefined();
  });

  it('switching to drawn copper takes the laid copper over and drops the request', () => {
    const k = buck();
    k.transact({ summary: 'a', ops: [{ op: 'draw_track', from: 'U1.8', to: 'D1.1', layer: 'F.Cu', via: [[15.5, 7.5]] }] });
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    // (the app keeps the routed copper with the design)
    k.keepCopper(k.board().newCopper!);
    const r = k.transact({ summary: 'mode', ops: [{ op: 'set_copper_mode', mode: 'drawn' }] });
    expect(r.status).toBe('ok');
    expect(r.results![0]!.effect).toMatch(/the 1 connection\(s\) you laid for the router with them/);
    expect(k.draftDesign().board?.laid).toBeUndefined();
    const b = k.board();
    expect(b.laid).toBeUndefined();
    // the laid copper is the agent's own now (the rest the helper's), without the router's tag
    const own = b.drawn!.tracks.filter((t) => !t.by);
    expect(own.length).toBeGreaterThan(0);
    expect(own.some((t) => passes(t.pts, 15.5, 7.5))).toBe(true);
    expect(b.drawn!.tracks.some((t) => t.laid)).toBe(false);
  });

  it('refuses pads of two nets, a layer the board has not, a point off the board, ends that are not pads', () => {
    const k = buck();
    const bad = (op: Record<string, unknown>) => k.transact({ summary: 'bad', ops: [{ op: 'draw_track', ...op } as never] });
    expect(bad({ from: 'U1.8', to: 'C1.1' }).status).toBe('rejected');
    expect(bad({ from: 'U1.8', to: 'D1.1', layer: 'In1.Cu' }).status).toBe('rejected');
    expect(bad({ from: 'U1.8', to: 'D1.1', layer: 'B.Cu' }).status).toBe('rejected'); // U1.8 is an SMD pad on F.Cu
    expect(bad({ from: 'U1.8', to: 'D1.1', via: [[99, 5]] }).status).toBe('rejected');
    expect(bad({ from: 'U1.8', to: [14, 8] }).status).toBe('rejected');
    expect(bad({ from: 'U1.8', to: 'D1.1', bend: 'diagonal_first' }).status).toBe('rejected');
    expect(k.board().laid).toBeUndefined();
  });
});
