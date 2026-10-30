import { describe, expect, it } from 'vitest';
import type { EnclosureFacts, EnclosurePiece } from '@4k7/fab';
import { contentBox, extent, firstCut, liftStep, newSection, sectionLabel, sectionView } from '../src/lib/section.ts';

type V3 = [number, number, number];
const facts = (w: number, h: number, parts: EnclosureFacts['parts'] = []): EnclosureFacts => ({ thickness: 1.6, size: [w, h], outline: [], cutouts: [], holes: [], tallestTop: 8, lowestBottom: -2, parts });
const piece = (name: string, min: V3, max: V3) => ({ name, tris: new Float32Array(), bbox: { min, max } }) as EnclosurePiece;
/** A USB socket on the left edge, a millimetre over it. */
const usb = { ref: 'J2', kind: 'connector', min: [-1, 20, 1.6] as V3, max: [8, 29, 5] as V3, side: 'top' as const, approx: false };

describe('the enclosure cut', () => {
  const box = { min: [-3, -3, -4] as V3, max: [63, 43, 20] as V3 };

  it('goes through the board with its parts and the pieces, and as high as the open view lifts them', () => {
    const f = facts(60, 40, [usb]);
    const pieces = [piece('base', [-3, -3, -4], [63, 43, 12]), piece('lid', [-3, -3, 12], [63, 43, 20])];
    expect(contentBox(f, pieces)).toEqual(box);
    expect(liftStep(pieces)).toBe(34);
    expect(contentBox(f, pieces, 34).max[2]).toBe(54);
    // no pieces: the board and its parts (the socket over the edge)
    expect(contentBox(f, [])).toEqual({ min: [-1, 0, -2], max: [60, 40, 8] });
  });

  it('runs from the lowest to the highest point along its normal', () => {
    expect(extent([1, 0, 0], box)).toEqual([-3, 63]);
    expect(extent([0, 0, 1], box)).toEqual([-4, 20]);
    const [lo, hi] = extent([Math.SQRT1_2, Math.SQRT1_2, 0], box);
    expect(lo).toBeCloseTo(-6 * Math.SQRT1_2);
    expect(hi).toBeCloseTo(106 * Math.SQRT1_2);
  });

  it('starts in the middle, across the shorter side, the half the camera looks from cut away', () => {
    expect(firstCut(box)).toBe('y');
    expect(firstCut({ min: [0, 0, 0], max: [30, 80, 10] })).toBe('x');
    // the camera in front (−y): the front half goes
    expect(newSection('y', box, [-50, -80, 60])).toEqual({ by: 'y', normal: [0, 1, 0], at: 20, flip: true });
    // from behind: the back half
    expect(newSection('y', box, [30, 200, 60]).flip).toBe(false);
    // a level cut from above: the top half
    expect(newSection('z', box, [30, 20, 100])).toEqual({ by: 'z', normal: [0, 0, 1], at: 8, flip: false });
    expect(sectionLabel(newSection('x', box))).toBe('x = 30.0 mm');
    expect(sectionLabel({ ...newSection('x', box), at: -0.04 })).toBe('x = 0.0 mm');
  });

  it('tells the agent where the plane is and which half is gone', () => {
    const c = newSection('y', box, [-50, -80, 60]);
    expect(sectionView(c, false)).toEqual({ view: 'enclosure', axis: 'y', at_mm: 20, removed: '-', opened: false });
    expect(sectionView({ ...c, at: 27.000000001, flip: false }, true)).toEqual({ view: 'enclosure', axis: 'y', at_mm: 27, removed: '+', opened: true });
    expect(sectionView(newSection('z', box, [0, 0, 100]), false)).toEqual({ view: 'enclosure', axis: 'z', at_mm: 8, removed: '+', opened: false });
  });
});
