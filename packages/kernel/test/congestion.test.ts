import { describe, expect, it } from 'vitest';
import { Grid, congestion, type Board, type Line } from '../src/congestion.ts';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

const board: Board = { w: 20, h: 20, rules: { track: 0.25, clearance: 0.2 }, signal: ['F.Cu', 'B.Cu'], pads: [] };
/** `n` horizontal lines one above the other across a band of the board. */
const bundle = (n: number, y0: number, y1: number): Line[] => Array.from({ length: n }, (_, i) => ({ x1: 2, y1: y0 + ((y1 - y0) * i) / Math.max(1, n - 1), x2: 18, y2: y0 + ((y1 - y0) * i) / Math.max(1, n - 1) }));

describe('congestion estimate', () => {
  it('a few lines fit; the same lines packed into a narrow band do not', () => {
    const few = congestion(board, bundle(6, 2, 18));
    expect(few.overflowMm).toBe(0);
    const packed = congestion(board, bundle(60, 9, 11));
    const spread = congestion(board, bundle(60, 2, 18));
    expect(packed.overflowMm).toBeGreaterThan(spread.overflowMm + 50);
    expect(packed.hot).toBeGreaterThan(0);
  });

  it('pads take room from the tracks, on their own layer', () => {
    const lines = bundle(40, 8, 12);
    const free = congestion(board, lines);
    const pads = Array.from({ length: 12 }, (_, i) => ({ x: 3 + i * 1.2, y: 10, w: 1, h: 1, layers: ['F.Cu' as const] }));
    const walled = congestion({ ...board, pads }, lines);
    expect(walled.overflowMm).toBeGreaterThan(free.overflowMm);
    // a plane layer carries no signal: less room again
    expect(congestion({ ...board, signal: ['F.Cu'] }, lines).overflowMm).toBeGreaterThan(free.overflowMm);
  });

  it('delta is what taking lines out and putting others in changes', () => {
    const g = new Grid(board);
    const lines = bundle(50, 8, 12);
    for (const l of lines) g.add(l);
    const before = g.measure().overflowMm;
    const gone = lines.slice(0, 10);
    const come: Line[] = bundle(10, 2, 4);
    const d = g.delta(gone, come);
    for (const l of gone) g.add(l, -1);
    for (const l of come) g.add(l);
    expect(Math.round((before + d) * 10) / 10).toBeCloseTo(g.measure().overflowMm, 1);
    expect(d).toBeLessThan(0);
  });

  it('is on every board view and in get_board, and a crowded board scores higher than a roomy one', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    const roomy = k.board().measures;
    expect(roomy.congestion.overflowMm).toBeGreaterThanOrEqual(0);
    expect(k.query({ op: 'get_board' })).toMatchObject({ placement_measures: { congestion_mm: roomy.congestion.overflowMm, congestion_peak: roomy.congestion.peak } });
    // the same parts on a board two thirds the size
    k.transact({ summary: 'tight', ops: [{ op: 'set_board', width_mm: 16, height_mm: 15 }, { op: 'propose_placement' }] });
    const tight = k.board().measures;
    expect(tight.congestion.overflowMm).toBeGreaterThan(roomy.congestion.overflowMm);
  });
});
