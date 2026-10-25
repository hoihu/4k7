/**
 * The Enclosure view's cut: a plane the user moves through the box to see inside it. Across x, y
 * or z (it starts in the middle), or across the wall through an opening (it starts at the part's
 * centre, along its plug's way). board.scad coordinates: x right and y up from the board's
 * bottom-left corner, z up from its underside. No three.js here: the toolbar uses it.
 */
import type { EnclosureFacts, EnclosurePiece } from '@4k7/fab';
import type { EnclosureViewInfo } from '@4k7/schema';

export type V3 = [number, number, number];
export type Axis = 'x' | 'y' | 'z';
export const AXES: Axis[] = ['x', 'y', 'z'];

export interface Section {
  /** 'x', 'y' or 'z' (across that axis), or a part's ref (across the wall through its opening). */
  by: string;
  /** The plane's normal, a unit vector: the axis, or across the plug's way (the mating's u). */
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

/**
 * The normal of a cut by an axis or through a part's opening (null: the part is not plugged from
 * anywhere). An opening's points the way of the axis it is nearest, so the slider and the
 * coordinate it shows run the same way.
 */
export function sectionNormal(by: string, facts: EnclosureFacts): V3 | null {
  const axis = AXES.indexOf(by as Axis);
  if (axis >= 0) return [0, 1, 2].map((i) => (i === axis ? 1 : 0)) as V3;
  const u = facts.parts.find((p) => p.ref === by)?.mating?.u;
  const len = u ? Math.hypot(...u) : 0;
  if (!u || len < 1e-9) return null;
  const big = u.reduce((m, v, i) => (Math.abs(v) > Math.abs(u[m]!) + 1e-9 ? i : m), 0);
  const s = u[big]! < 0 ? -1 : 1;
  return u.map((v) => (s * v) / len || 0) as V3;
}

/** The cut to start with: across the box's shorter side, which shows its long profile. */
export function firstCut(box: Box): Axis {
  return box.max[0] - box.min[0] >= box.max[1] - box.min[1] ? 'y' : 'x';
}

/**
 * A new cut: through the middle of the box, or through the centre of a part's opening; the half
 * towards `eye` (the camera, board.scad) cut away, so its cut faces are what the camera sees.
 */
export function newSection(by: string, facts: EnclosureFacts, box: Box, eye?: V3 | null): Section | null {
  const normal = sectionNormal(by, facts);
  if (!normal) return null;
  const [lo, hi] = extent(normal, box);
  const m = facts.parts.find((p) => p.ref === by)?.mating;
  const at = round(m ? dot(normal, m.origin) : (lo + hi) / 2);
  return { by, normal, at, flip: eye ? dot(normal, eye) < at : false };
}

/** The axis a normal lies along, with its sign (null: it lies along none). */
function alongAxis(n: V3): { axis: Axis; sign: 1 | -1 } | null {
  const i = n.findIndex((v) => Math.abs(Math.abs(v) - 1) < 1e-6);
  return i >= 0 ? { axis: AXES[i]!, sign: n[i]! > 0 ? 1 : -1 } : null;
}

/** Where the cut is, as the toolbar shows it: "y = 31.5 mm", or (an opening's way askew) "2.0 mm from J2's centre". */
export function sectionLabel(c: Section, facts: EnclosureFacts): string {
  const a = alongAxis(c.normal);
  if (a) return `${a.axis} = ${round(a.sign * c.at).toFixed(1)} mm`;
  const m = facts.parts.find((p) => p.ref === c.by)?.mating;
  const off = m ? round(c.at - dot(c.normal, m.origin)) : null;
  return off === null ? `${c.at.toFixed(1)} mm` : off === 0 ? `through ${c.by}'s centre` : `${off > 0 ? '+' : '−'}${Math.abs(off).toFixed(1)} mm from ${c.by}'s centre`;
}

/** The cut as the agent is told it (the <view> block): where the plane is, which half is gone. */
export function sectionView(c: Section, facts: EnclosureFacts, opened: boolean): EnclosureViewInfo {
  const a = alongAxis(c.normal);
  const m = facts.parts.find((p) => p.ref === c.by)?.mating;
  // which half is gone, told by the axis's way when the normal runs against it
  const plus = !c.flip === (!a || a.sign > 0);
  return {
    view: 'enclosure',
    ...(a ? { axis: a.axis } : {}),
    normal: c.normal.map((v) => Math.round(v * 1000) / 1000 || 0) as V3,
    at_mm: round(a ? a.sign * c.at : c.at),
    ...(m ? { through: c.by, offset_mm: round(c.at - dot(c.normal, m.origin)) } : {}),
    removed: plus ? '+' : '-',
    opened,
  };
}
