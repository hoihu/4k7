import { describe, expect, it } from 'vitest';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

function buck() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k;
}

describe('board placement', () => {
  it('places every part on the board without overlapping courtyards', () => {
    const b = buck().board();
    expect(b.parts).toHaveLength(12);
    expect(b.missing).toEqual([]);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    for (const p of b.parts) {
      expect(p.courtyard.x).toBeGreaterThanOrEqual(0);
      expect(p.courtyard.y + p.courtyard.h).toBeLessThanOrEqual(b.outline.h);
    }
    // a compact board: well under 30 × 30 mm for this buck
    expect(b.outline.w * b.outline.h).toBeLessThan(900);
    expect(b.ratsnest.length).toBeGreaterThan(10);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buck().board())).toBe(JSON.stringify(buck().board()));
  });

  it('keeps the bootstrap and input caps close to the regulator', () => {
    const b = buck().board();
    const u1 = b.parts.find((p) => p.refdes === 'U1')!;
    const dist = (ref: string) => {
      const p = b.parts.find((x) => x.refdes === ref)!;
      return Math.hypot(p.x - u1.x, p.y - u1.y);
    };
    expect(dist('C4')).toBeLessThan(6);
    expect(dist('C1')).toBeLessThan(8);
  });

  it('honours pinned positions and board settings', () => {
    const k = buck();
    k.transact({ summary: 'board', ops: [
      { op: 'set_board', width_mm: 40, height_mm: 30 },
      { op: 'place', ref: 'J1', x_mm: 3, y_mm: 15, rot: 90 },
    ] });
    const b = k.board();
    expect(b.outline).toEqual({ w: 40, h: 30 });
    const j1 = b.parts.find((p) => p.refdes === 'J1')!;
    expect([j1.x, j1.y, j1.rot, j1.locked]).toEqual([3, 15, 90, true]);
    expect(b.diagnostics.filter((x) => x.code === 'DRC.COURTYARD_OVERLAP')).toEqual([]);
    const hunks = k.proposal()!.hunks.map((h) => h.kind);
    expect(hunks).toContain('board');
    expect(hunks).toContain('constraint');
  });
});
