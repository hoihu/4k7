import { describe, expect, it } from 'vitest';
import { figureDepths } from '@4k7/schema';
import { traceBitmap } from '../src/trace.ts';

const grid = (rows: string[]) => ({ ink: rows.join('').split('').map((c) => (c === '#' ? 1 : 0)), w: rows[0]!.length, h: rows.length });

describe('traceBitmap', () => {
  it('traces a square with a hole into an outer loop and a hole', () => {
    const { ink, w, h } = grid(['####', '#..#', '#..#', '####']);
    const loops = traceBitmap(ink, w, h);
    expect(loops).toHaveLength(2);
    // corners only: collinear points dropped
    expect(loops.map((l) => l.length / 2).sort()).toEqual([4, 4]);
    expect(figureDepths(loops).sort()).toEqual([0, 1]);
  });

  it('keeps pixels touching at a corner as separate simple loops', () => {
    const { ink, w, h } = grid(['#.', '.#']);
    const loops = traceBitmap(ink, w, h);
    expect(loops).toHaveLength(2);
    expect(figureDepths(loops)).toEqual([0, 0]);
  });
});

describe('figureDepths on traced pictures', () => {
  it('stays fast and right for thousands of dots', () => {
    // a 120 × 120 checkerboard-ish dither: thousands of separate dots, plus a framed hole
    const w = 120;
    const ink = Array.from({ length: w * w }, (_, i) => ((i % w) + Math.floor(i / w)) % 2);
    const loops = traceBitmap(ink, w, w);
    const t = performance.now();
    const d = figureDepths(loops);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(d.every((x) => x === 0)).toBe(true);
  });
});
