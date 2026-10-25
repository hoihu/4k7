import { describe, expect, it } from 'vitest';
import type { EnclosureFacts, EnclosurePiece } from '@4k7/fab';
import { contentBox, extent, firstCut, liftStep, newSection, sectionLabel, sectionNormal, sectionView } from '../src/lib/section.ts';

type V3 = [number, number, number];
const facts = (w: number, h: number, parts: EnclosureFacts['parts'] = []): EnclosureFacts => ({ thickness: 1.6, size: [w, h], outline: [], cutouts: [], holes: [], tallestTop: 8, lowestBottom: -2, parts });
const piece = (name: string, min: V3, max: V3) => ({ name, stl: '', bbox: { min, max } }) as EnclosurePiece;
/** A USB socket on the left edge, plugged from the left (its way runs along −x, across it u and v). */
const usb = (u: V3) => ({ ref: 'J2', kind: 'connector', min: [-1, 20, 1.6] as V3, max: [8, 29, 5] as V3, side: 'top' as const, approx: false, mating: { facing: 'left' as const, origin: [-1, 24.5, 3.3] as V3, dir: [-1, 0, 0] as V3, u, v: [0, 0, 1] as V3, size: [9, 3.4] as [number, number] } });

describe('the enclosure cut', () => {
  const box = { min: [-3, -3, -4] as V3, max: [63, 43, 20] as V3 };

  it('goes through the board with its parts and the pieces, and as high as the open view lifts them', () => {
    const f = facts(60, 40, [usb([0, 1, 0])]);
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
    const f = facts(60, 40);
    // the camera in front (−y): the front half goes
    expect(newSection('y', f, box, [-50, -80, 60])).toEqual({ by: 'y', normal: [0, 1, 0], at: 20, flip: true });
    // from behind: the back half
    expect(newSection('y', f, box, [30, 200, 60])!.flip).toBe(false);
    // a level cut from above: the top half
    expect(newSection('z', f, box, [30, 20, 100])).toEqual({ by: 'z', normal: [0, 0, 1], at: 8, flip: false });
    expect(sectionLabel(newSection('x', f, box)!, f)).toBe('x = 30.0 mm');
  });

  it('through an opening: at the part centre, across its way, the normal along the axis it is nearest', () => {
    const f = facts(60, 40, [usb([0, -1, 0])]);
    expect(sectionNormal('J2', f)).toEqual([0, 1, 0]);
    const c = newSection('J2', f, box, [-50, -80, 60])!;
    expect(c).toEqual({ by: 'J2', normal: [0, 1, 0], at: 24.5, flip: true });
    expect(sectionLabel(c, f)).toBe('y = 24.5 mm');
    // a part without a way out cannot be cut through
    const none = facts(60, 40, [{ ...usb([0, 1, 0]), mating: undefined }]);
    expect(sectionNormal('J2', none)).toBeNull();
    expect(newSection('J2', none, box)).toBeNull();
  });

  it('tells the agent where the plane is and which half is gone', () => {
    const f = facts(60, 40, [usb([0, -1, 0])]);
    const c = newSection('J2', f, box, [-50, -80, 60])!;
    expect(sectionView(c, f, false)).toEqual({ view: 'enclosure', axis: 'y', normal: [0, 1, 0], at_mm: 24.5, through: 'J2', offset_mm: 0, removed: '-', opened: false });
    expect(sectionView({ ...c, at: 27, flip: false }, f, true)).toMatchObject({ at_mm: 27, offset_mm: 2.5, removed: '+', opened: true });
    // a normal against its axis: the coordinate and the half by the axis
    expect(sectionView({ by: 'x', normal: [-1, 0, 0], at: -12, flip: false }, f, false)).toMatchObject({ axis: 'x', at_mm: 12, removed: '-' });
    expect(sectionView(newSection('z', f, box, [0, 0, 100])!, f, false)).toEqual({ view: 'enclosure', axis: 'z', normal: [0, 0, 1], at_mm: 8, removed: '+', opened: false });
  });

  it('through an opening at an angle: where it is, from the part centre', () => {
    const f = facts(60, 40, [usb([-Math.SQRT1_2, -Math.SQRT1_2, 0])]);
    const n = sectionNormal('J2', f)!;
    expect(n[0]).toBeCloseTo(Math.SQRT1_2);
    expect(n[1]).toBeCloseTo(Math.SQRT1_2);
    const c = newSection('J2', f, box)!;
    expect(sectionLabel(c, f)).toBe("through J2's centre");
    expect(sectionLabel({ ...c, at: c.at + 2 }, f)).toBe("+2.0 mm from J2's centre");
    expect(sectionLabel({ ...c, at: c.at - 1.5 }, f)).toBe("−1.5 mm from J2's centre");
  });
});
