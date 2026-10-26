/**
 * The Enclosure view's cut: a plane the user moves through the box to see inside it, across x, y
 * or z (it starts in the middle). board.scad coordinates: x right and y up from the board's
 * bottom-left corner, z up from its underside. No three.js here: the toolbar uses it.
 */
import type { EnclosureFacts, EnclosurePiece } from '@4k7/fab';
import type { EnclosureViewInfo } from '@4k7/schema';

export type V3 = [number, number, number];
export type Axis = 'x' | 'y' | 'z';
export const AXES: Axis[] = ['x', 'y', 'z'];

export interface Section {
  /** The axis it is across. */
  by: Axis;
  /** The plane's normal: the axis, a unit vector. */
  normal: V3;
  /** Where it is: the plane n · p = at (mm). */
  at: number;
  /** The half the normal points to is cut away; flipped, the other. */
  flip: boolean;
}

export interface Box {
  min: V3;
  max: V3;
}

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const round = (v: number) => Math.round(v * 10) / 10 || 0;

/** How far the open view lifts each piece after the first: the box's height and 10 mm. */
export function liftStep(pieces: EnclosurePiece[]): number {
  const zs = pieces.flatMap((p) => [p.bbox.min[2], p.bbox.max[2]]);
  return zs.length ? Math.max(...zs) - Math.min(...zs) + 10 : 20;
}

/** The box round the board with its parts and the pieces; `lifted` mm higher on top (the open view's pieces). */
export function contentBox(facts: EnclosureFacts, pieces: EnclosurePiece[], lifted = 0): Box {
  const min: V3 = [0, 0, Math.min(0, facts.lowestBottom)];
  const max: V3 = [facts.size[0], facts.size[1], Math.max(facts.thickness, facts.tallestTop)];
  for (const b of [...facts.parts, ...pieces.map((p) => p.bbox)]) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, b.min[i]!);
      max[i] = Math.max(max[i]!, b.max[i]!);
    }
  }
  max[2] += lifted;
  return { min, max };
}

/** How far a plane with this normal goes through the box: its lowest and highest n · p. */
export function extent(n: readonly number[], box: Box): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 8; i++) {
    const d = dot(n, [(i & 1 ? box.max : box.min)[0], (i & 2 ? box.max : box.min)[1], (i & 4 ? box.max : box.min)[2]]);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return [lo, hi];
}

/** The cut to start with: across the box's shorter side, which shows its long profile. */
export function firstCut(box: Box): Axis {
  return box.max[0] - box.min[0] >= box.max[1] - box.min[1] ? 'y' : 'x';
}

/**
 * A new cut across an axis, through the middle of the box; the half towards `eye` (the camera,
 * board.scad) cut away, so its cut faces are what the camera sees.
 */
export function newSection(by: Axis, box: Box, eye?: V3 | null): Section {
  const normal = AXES.map((a) => (a === by ? 1 : 0)) as V3;
  const [lo, hi] = extent(normal, box);
  const at = round((lo + hi) / 2);
  return { by, normal, at, flip: eye ? dot(normal, eye) < at : false };
}

/** Where the cut is, as the toolbar shows it: "y = 31.5 mm". */
export function sectionLabel(c: Section): string {
  return `${c.by} = ${round(c.at).toFixed(1)} mm`;
}

/** The cut as the agent is told it (the <view> block): where the plane is, which half is gone. */
export function sectionView(c: Section, opened: boolean): EnclosureViewInfo {
  return { view: 'enclosure', axis: c.by, at_mm: round(c.at), removed: c.flip ? '-' : '+', opened };
}
