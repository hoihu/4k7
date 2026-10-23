import { describe, expect, it } from 'vitest';
import { boardSummary } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

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

describe('the track op', () => {
  it('lays the switch node as asked: through its point, at its width, and the route keeps it', () => {
    const k = buck();
    const r = k.transact({ summary: 'sw', ops: [{ op: 'track', from: 'U1.8', to: 'D1.1', layer: 'F.Cu', width_mm: 0.8, through: [{ x_mm: 15.5, y_mm: 7.5 }] }] });
    expect(r.status).toBe('ok');
    // the board changed: routing is out of date until route runs
    expect(k.board().routing).toBe('stale');
    expect(k.board().drawn).toEqual([{ id: 'T1', netId: expect.any(String), from: 'U1.8', to: 'D1.1', layer: 'F.Cu', width: 0.8, through: [{ x: 15.5, y: 7.5 }] }]);
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.drawn[0]!.laid).toBe(true);
    const mine = b.tracks.filter((t) => t.drawn === 'T1');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((t) => t.layer === 'F.Cu')).toBe(true);
    expect(mine.some((t) => t.width === 0.8)).toBe(true);
    expect(mine.some((t) => passes(t.pts, 15.5, 7.5))).toBe(true);
    expect(b.unrouted).toEqual([]);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    const s = boardSummary(b) as { laid_tracks?: { id: string; state: string }[] };
    expect(s.laid_tracks).toEqual([expect.objectContaining({ id: 'T1', from: 'U1.8', to: 'D1.1', state: 'laid as asked' })]);
  });

  it('moves with the parts: the point near a part follows it, and the track is laid again there', () => {
    const k = buck();
    k.transact({ summary: 'sw', ops: [{ op: 'track', from: 'U1.8', to: 'D1.1', layer: 'F.Cu', through: [{ x_mm: 14, y_mm: 8 }] }] });
    const d1 = k.board().parts.find((p) => p.refdes === 'D1')!;
    k.transact({ summary: 'move', ops: [{ op: 'place', ref: 'D1', x_mm: d1.x - 1, y_mm: d1.y }] });
    const b0 = k.board();
    const pad = b0.parts.find((p) => p.refdes === 'D1')!.pads.find((p) => p.number === '1')!;
    // (14, 8) was nearer D1.1 (14, 6.9) than U1.8: it keeps its place relative to that pad
    expect(b0.drawn[0]!.through).toEqual([{ x: Math.round((pad.x + 0) * 1000) / 1000, y: Math.round((pad.y + 1.1) * 1000) / 1000 }]);
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.drawn[0]!.laid).toBe(true);
    expect(b.tracks.filter((t) => t.drawn === 'T1').some((t) => passes(t.pts, b.drawn[0]!.through[0]!.x, b.drawn[0]!.through[0]!.y))).toBe(true);
  });

  it('one that finds no way is not laid: the DRC says why, and the router routes the connection', () => {
    const k = buck();
    // through the middle of U1's GND pin (16.5, 10.37), on its layer (without a layer the router
    // passes it on B.Cu)
    expect(k.transact({ summary: 'sw', ops: [{ op: 'track', from: 'U1.8', to: 'D1.1', layer: 'F.Cu', through: [{ x_mm: 16.5, y_mm: 10.37 }] }] }).status).toBe('ok');
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.drawn[0]!.laid).toBe(false);
    expect(b.drawn[0]!.why).toMatch(/^\(16\.5, 10\.37\) has no room for a 0\.25 mm track on F\.Cu: .* too close \(GND is in the way\)$/);
    const w = b.diagnostics.find((x) => x.code === 'DRC.TRACK_NOT_LAID')!;
    expect(w.message).toMatch(/^T1 \(U1\.8 → D1\.1, SW\) is not laid as asked: /);
    expect(w.entities.sort()).toEqual(['D1', 'U1']);
    expect(b.tracks.some((t) => t.drawn)).toBe(false);
    expect(b.unrouted).toEqual([]);
  });

  it('is replaced by a track between the same pads, and taken away by erase_track', () => {
    const k = buck();
    k.transact({ summary: 'a', ops: [{ op: 'track', from: 'U1.8', to: 'D1.1' }] });
    const r = k.transact({ summary: 'b', ops: [{ op: 'track', from: 'D1.1', to: 'U1.8', layer: 'F.Cu' }] });
    expect(r.status).toBe('ok');
    expect(k.board().drawn.map((t) => [t.id, t.layer])).toEqual([['T1', 'F.Cu']]);
    expect(k.transact({ summary: 'c', ops: [{ op: 'erase_track', id: 'T1' }] }).status).toBe('ok');
    expect(k.board().drawn).toEqual([]);
    expect(k.transact({ summary: 'd', ops: [{ op: 'erase_track', id: 'T1' }] }).status).toBe('rejected');
  });

  it('refuses pads of two nets, a layer the board has not, a point off the board', () => {
    const k = buck();
    const bad = (op: Record<string, unknown>) => k.transact({ summary: 'bad', ops: [{ op: 'track', ...op } as never] });
    expect(bad({ from: 'U1.8', to: 'C1.1' }).status).toBe('rejected');
    expect(bad({ from: 'U1.8', to: 'D1.1', layer: 'In1.Cu' }).status).toBe('rejected');
    expect(bad({ from: 'U1.8', to: 'D1.1', layer: 'B.Cu' }).status).toBe('rejected'); // U1.8 is an SMD pad on F.Cu
    expect(bad({ from: 'U1.8', to: 'D1.1', through: [{ x_mm: 99, y_mm: 5 }] }).status).toBe('rejected');
  });
});
