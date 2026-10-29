import { describe, expect, it } from 'vitest';
import type { BoardPad, BoardPart, BoardView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { exploreMain, refinable, refinePlacement } from '../src/refine.ts';
import { buckTransaction } from './fixtures.ts';

/** A part at (x, y) with 1 × 1 mm pads at the given offsets on the given nets (rotation 0). */
function part(refdes: string, x: number, y: number, pads: [number, number, string][], more: Partial<BoardPart> = {}): BoardPart {
  const ps: BoardPad[] = pads.map(([dx, dy, netId], i) => ({ number: String(i + 1), x: x + dx, y: y + dy, w: 1, h: 1, shape: 'rect', netId, layers: ['F.Cu'] }));
  const xs = ps.map((p) => p.x);
  const ys = ps.map((p) => p.y);
  return { componentId: refdes, refdes, x, y, rot: 0, side: 'top', pads: ps, locked: false, pkgInfo: {}, courtyard: { x: Math.min(...xs) - 0.75, y: Math.min(...ys) - 0.75, w: Math.max(...xs) - Math.min(...xs) + 1.5, h: Math.max(...ys) - Math.min(...ys) + 1.5 }, ...more } as unknown as BoardPart;
}

const board = (parts: BoardPart[]): BoardView => ({ outline: { w: 40, h: 20 }, parts, rules: { clearance: 0.2, track: 0.25, powerTrack: 0.5, viaDrill: 0.3, viaPad: 0.6, edgeClearance: 0.5 }, cornerRadius: 0, shape: null, cutouts: [], planes: [] }) as unknown as BoardView;

function buck() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k;
}

describe('refining the small parts', () => {
  it('turns a resistor whose pads face the wrong way: its ratsnest no longer crosses', () => {
    // R1 joins A (left) and B (right), but faces them the other way round: its two lines cross
    const parts = [part('U1', 10, 10, [[0, 0, 'A']], { locked: true }), part('U2', 30, 10, [[0, 0, 'B']], { locked: true }), part('R1', 20, 12, [[-1, 0, 'B'], [1, 0, 'A']])];
    const b = board(parts);
    expect(refinable(b)).toEqual(new Set(['R1']));
    const r = refinePlacement(b, refinable(b), new Set(), 2);
    expect(r.before.crossings).toBe(1);
    expect(r.after.crossings).toBe(0);
    expect(r.moves).toEqual([expect.objectContaining({ refdes: 'R1', rot: 180, was: { x: 20, y: 12, rot: 0 } })]);
  });

  it('keeps a part clear of the others: no move onto another part', () => {
    // the shortest place for R1 would be on top of U3, which sits right where its lines go
    const parts = [part('U1', 10, 10, [[0, 0, 'A']], { locked: true }), part('U2', 13, 10, [[0, 0, 'A']], { locked: true }), part('R1', 11.5, 14, [[-1, 0, 'A'], [1, 0, 'C']]), part('U3', 11.5, 11.5, [[0, 0, 'C']], { locked: true })];
    const b = board(parts);
    const r = refinePlacement(b, refinable(b), new Set(), 2);
    for (const mv of r.moves) expect(Math.abs(mv.y - 11.5) >= 2 || Math.abs(mv.x - 11.5) >= 3).toBe(true);
  });

  it('moves a main part with the small parts that belong with it, and swaps two of one package', () => {
    // U1 and U2 (one package) stand each other's way round: their nets cross; swapped, they do not
    const pkg = { pkg: 'SOIC-8' } as Partial<BoardPart>;
    const parts = [
      part('J1', 5, 5, [[0, 0, 'A']], { locked: true }),
      part('J2', 5, 15, [[0, 0, 'B']], { locked: true }),
      part('U1', 20, 15, [[0, 0, 'A'], [0, 1, 'X'], [0, 2, 'Y'], [0, 3, 'Z']], pkg),
      part('U2', 20, 5, [[0, 0, 'B'], [0, 1, 'X2'], [0, 2, 'Y2'], [0, 3, 'Z2']], pkg),
    ];
    const b = board(parts);
    const r = exploreMain(b, ['U1', 'U2'], new Set(), 2);
    expect(r.before.crossings).toBe(1);
    expect(r.after.crossings).toBe(0);
  });
});

describe('placement in the design', () => {
  it('propose_placement refines the small parts when asked (by default with the main parts given), and says so', () => {
    const plain = buck();
    const p = plain.transact({ summary: 'p', ops: [{ op: 'propose_placement' }] });
    expect(p.results?.[0]?.effect).not.toContain('refined');
    const refined = buck();
    const r = refined.transact({ summary: 'p', ops: [{ op: 'propose_placement', refine: true }] });
    const [a, b] = [plain.boardPlacement().measures, refined.boardPlacement().measures];
    expect(b.crossings * 4 + b.ratsnestMm).toBeLessThanOrEqual(a.crossings * 4 + a.ratsnestMm);
    if (b.crossings < a.crossings || b.ratsnestMm < a.ratsnestMm) expect(r.results?.[0]?.effect).toContain('the small parts refined');
  });

  it('refine_placement: what it reports is what the board then shows, and parts someone placed stay', () => {
    const k = buck();
    k.transact({ summary: 'p', ops: [{ op: 'propose_placement', refine: false }] });
    const before = k.boardPlacement();
    const r1 = before.parts.find((p) => p.refdes === 'R1')!;
    k.transact({ summary: 'mine', ops: [{ op: 'place', ref: 'R1', x_mm: r1.x, y_mm: r1.y, rot: r1.rot }] });
    const r = k.transact({ summary: 'refine', ops: [{ op: 'refine_placement' }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const after = k.boardPlacement();
    const effect = r.results![0]!.effect;
    const m = effect.match(/ratsnest ([\d.]+) → ([\d.]+) mm, crossings (\d+) → (\d+)/);
    if (m) {
      expect(Number(m[2])).toBe(after.measures.ratsnestMm);
      expect(Number(m[4])).toBe(after.measures.crossings);
      expect(after.measures.crossings * 4 + after.measures.ratsnestMm).toBeLessThan(before.measures.crossings * 4 + before.measures.ratsnestMm);
    } else expect(effect).toMatch(/^no better place found|^nothing to refine/);
    const r1now = after.parts.find((p) => p.refdes === 'R1')!;
    expect([r1now.x, r1now.y, r1now.rot]).toEqual([r1.x, r1.y, r1.rot]);
    // the layout after it keeps the refined parts as they are (a re-layout does not turn them back)
    expect(new Kernel(k.draftDesign()).boardPlacement().measures).toEqual(after.measures);
  });

  it('proposing the main parts where they are keeps the board about its size (it does not grow round a wedged part)', () => {
    const k = buck();
    k.transact({ summary: 'p', ops: [{ op: 'propose_placement' }] });
    const b = k.boardPlacement();
    const main = b.parts.filter((p) => p.pads.length > 3).map((p) => ({ ref: p.refdes, x_mm: p.x, y_mm: p.y, rot: p.rot as 0 | 90 | 180 | 270 }));
    k.transact({ summary: 'again', ops: [{ op: 'propose_placement', parts: main }] });
    const again = k.boardPlacement();
    expect(again.outline.w * again.outline.h).toBeLessThanOrEqual(b.outline.w * b.outline.h * 1.25);
  });

  it('try_placements improves on the best option itself and gives the parts to apply it', () => {
    const k = buck();
    k.transact({ summary: 'p', ops: [{ op: 'propose_placement' }] });
    const b = k.boardPlacement();
    // a poor arrangement: every main part turned round
    const main = b.parts.filter((p) => p.pads.length > 3).map((p) => ({ ref: p.refdes, x_mm: p.x, y_mm: p.y, rot: ((p.rot + 180) % 360) as 0 | 90 | 180 | 270 }));
    const r = k.query({ op: 'try_placements', candidates: [{ name: 'turned round', parts: main }] }) as { options: { option: number; ratsnest_crossings: number; ratsnest_mm: number; congestion_mm: number; routability: number; parts?: unknown[] }[]; explored?: string };
    expect(r.explored).toBeDefined();
    // nothing changed by the query itself
    expect(k.boardPlacement().placementKey).toBe(b.placementKey);
    const improved = r.options.find((o) => o.parts);
    if (improved) {
      // ranked first, and better than what it started from
      expect(r.options[0]).toBe(improved);
      const base = r.options.find((o) => o.option === 1)!;
      expect(improved.routability).toBeLessThan(base.routability);
      // (the score is 4 × crossings + ratsnest mm + 8 × congestion mm, and the options come best first)
      expect(Math.abs(improved.routability - (improved.ratsnest_crossings * 4 + improved.ratsnest_mm + improved.congestion_mm * 8))).toBeLessThan(1);
      expect(r.options.map((o) => o.routability)).toEqual([...r.options.map((o) => o.routability)].sort((x, y) => x - y));
      expect(k.transact({ summary: 'apply', ops: [{ op: 'propose_placement', parts: improved.parts as never }] }).status).toBe('ok');
    } else expect(r.explored).toMatch(/^no turn, shift or swap/);
  });
});
