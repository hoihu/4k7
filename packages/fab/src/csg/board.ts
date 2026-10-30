/**
 * The board as the enclosure script sees it (docs/design/enclosure.md §3): its facts as plain data and
 * its outline, parts and plug paths as solids, all as globals of the script. Millimetres; x right and
 * y up from the board's bottom-left corner, z up, the board's underside at z = 0.
 */
import { DEFAULT_LID_CLEARANCE, FACE_FRAMES, MATING_PATH_LENGTH, type BoardFacing, type EnclosureBrief, type EnclosureGraphic } from '@4k7/schema';
import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import type { EnclosureFacts, PartSolid, PartSolids } from '../scad.ts';
import { guarded, type CsgApi } from './api.ts';

type Options = Record<string, unknown>;
const isOptions = (x: unknown): x is Options => !!x && typeof x === 'object' && !Array.isArray(x);

/** Segments round a part's cylinder: only for the checks, so plain. */
const PART_SEGMENTS = 32;

export function createBoardLib(w: ManifoldToplevel, api: CsgApi, facts: EnclosureFacts & { solids: PartSolids }, brief?: EnclosureBrief, graphics: EnclosureGraphic[] = []) {
  const { Manifold, CrossSection } = w;

  const parts_info = facts.parts.map((p) => ({ ref: p.ref, kind: p.kind, min: p.min, max: p.max, side: p.side, approx: p.approx, mating: p.mating ? { facing: p.mating.facing, origin: p.mating.origin, dir: p.mating.dir, u: p.mating.u, v: p.mating.v, size: p.mating.size } : null }));
  const brief_openings = brief?.openings ?? [];
  const known = () => (parts_info.length ? `the parts are ${parts_info.map((p) => p.ref).join(', ')}` : 'the board has no parts');

  function part_info(ref: unknown) {
    const p = parts_info.find((x) => x.ref === ref);
    if (!p) throw new Error(`part_info: no part ${JSON.stringify(ref)}: ${known()}`);
    return p;
  }

  function hole_info(id: unknown) {
    const h = facts.holes.find((x) => x.id === id);
    if (!h) throw new Error(`hole_info: no hole ${JSON.stringify(id)}: the holes are ${facts.holes.map((x) => x.id).join(', ') || 'none'}`);
    return h;
  }

  /** 2D: the outline grown by delta (negative shrinks), with the cutouts. */
  function pcb_shape(delta: unknown = 0): CrossSection {
    const d = typeof delta === 'number' ? delta : isOptions(delta) ? ((delta.delta ?? 0) as number) : NaN;
    if (!Number.isFinite(d)) throw new Error(`pcb_shape: delta has to be a number, got ${String(delta)}`);
    let shape = CrossSection.ofPolygons([facts.outline], 'EvenOdd');
    if (facts.cutouts.length) shape = shape.subtract(CrossSection.ofPolygons(facts.cutouts, 'EvenOdd'));
    return d ? shape.offset(d, 'Miter') : shape;
  }

  let pcbSolid: Manifold | null = null;
  function pcb(): Manifold {
    if (pcbSolid) return pcbSolid;
    const holes = facts.holes.map((h) => CrossSection.circle(h.d / 2, 32).translate([h.x, h.y]));
    const shape = holes.length ? CrossSection.difference([pcb_shape(), ...holes]) : pcb_shape();
    pcbSolid = shape.extrude(facts.thickness);
    return pcbSolid;
  }

  /** One solid of a part, in its body's coordinates with y flipped (up). */
  function partSolid(s: PartSolid): Manifold {
    if (s.box) {
      const { min, max } = s.box;
      return Manifold.cube([max[0] - min[0], max[1] - min[1], max[2] - min[2]]).translate([min[0], -max[1], min[2]]);
    }
    const c = s.cyl!;
    if (c.lying) return Manifold.cylinder(c.lying, c.r, c.r, PART_SEGMENTS, true).rotate([0, 90, 0]).translate([c.x, -c.y, c.z0]);
    return Manifold.cylinder(c.z1 - c.z0, c.r, c.r, PART_SEGMENTS).translate([c.x, -c.y, c.z0]);
  }

  const partSolids = new Map<string, Manifold>();
  function part(ref: unknown): Manifold {
    const name = String(ref);
    const have = partSolids.get(name);
    if (have) return have;
    const s = facts.solids.get(name);
    if (!s) throw new Error(`part: no part ${JSON.stringify(ref)}: ${known()}`);
    const r = s.rows;
    const solid = Manifold.union(s.solids.map(partSolid)).transform([r[0]![0]!, r[1]![0]!, r[2]![0]!, 0, r[0]![1]!, r[1]![1]!, r[2]![1]!, 0, r[0]![2]!, r[1]![2]!, r[2]![2]!, 0, r[0]![3]!, r[1]![3]!, r[2]![3]!, 1]);
    partSolids.set(name, solid);
    return solid;
  }

  let partsSolid: Manifold | null = null;
  const parts = (): Manifold => (partsSolid ??= Manifold.union(parts_info.map((p) => part(p.ref))));
  const assembly = (): Manifold => pcb().add(parts());

  /** The box round a part, grown by grow. */
  function part_box(ref: unknown, a?: unknown): Manifold {
    const p = part_info(ref);
    const grow = typeof a === 'number' ? a : isOptions(a) ? ((a.grow ?? 0) as number) : 0;
    return Manifold.cube([p.max[0] - p.min[0] + 2 * grow, p.max[1] - p.min[1] + 2 * grow, p.max[2] - p.min[2] + 2 * grow]).translate([p.min[0] - grow, p.min[1] - grow, p.min[2] - grow]);
  }

  /** mating_path(ref, { length, grow }): the way a part's plug needs, from its mating face outwards. */
  function mating_path(ref: unknown, a?: unknown, b?: unknown): Manifold {
    const m = part_info(ref).mating;
    if (!m) throw new Error(`mating_path: where ${String(ref)} is plugged from is unknown: set_mating (face and plug size from its datasheet)`);
    const o: Options = isOptions(a) ? a : { ...(typeof a === 'number' ? { length: a } : {}), ...(typeof b === 'number' ? { grow: b } : {}) };
    const length = (o.length ?? MATING_PATH_LENGTH) as number;
    const grow = (o.grow ?? 0) as number;
    const [s0, s1] = m.size;
    return Manifold.cube([s0 + 2 * grow, s1 + 2 * grow, length])
      .translate([-s0 / 2 - grow, -s1 / 2 - grow, 0])
      .transform([m.u[0], m.u[1], m.u[2], 0, m.v[0], m.v[1], m.v[2], 0, m.dir[0], m.dir[1], m.dir[2], 0, m.origin[0], m.origin[1], m.origin[2], 1]);
  }

  /** keepouts(refs = brief_openings, { grow }): the parts and the mating paths of refs, where the box must not be. */
  function keepouts(a?: unknown, b?: unknown): Manifold {
    const refs = (Array.isArray(a) ? a : brief_openings) as string[];
    const o = (isOptions(a) ? a : isOptions(b) ? b : {}) as { grow?: number };
    const paths = refs.filter((r) => part_info(r).mating).map((r) => mating_path(r, { grow: o.grow ?? 0 }));
    return Manifold.union([parts(), ...paths]);
  }

  /** hole_posts(from, { d }): a post under each mounting hole, from z = from up to the board's underside. */
  function hole_posts(from: unknown, a?: unknown): Manifold {
    const z = from as number;
    if (typeof z !== 'number' || !Number.isFinite(z) || z >= 0) throw new Error(`hole_posts: from is where the posts start, under the board (z < 0), got ${String(from)}`);
    const d = (typeof a === 'number' ? a : isOptions(a) ? (a.d ?? 6) : 6) as number;
    return Manifold.union(facts.holes.map((h) => Manifold.cylinder(-z, d / 2, d / 2, 48).translate([h.x, h.y, z])));
  }

  /** label(text, { size, halign, valign, spacing }): 2D text, centred on the origin; size is the capitals' height. */
  const label = (t: unknown, o?: unknown): CrossSection => api.centeredText(t, o);

  const stored = new Map<string, CrossSection>();
  /** A graphic's figures at their stored size (y up). */
  function graphicShape(g: EnclosureGraphic): CrossSection {
    const have = stored.get(g.name);
    if (have) return have;
    const loops = g.polys.filter((p) => p.length >= 6).map((p) => {
      const pts: [number, number][] = [];
      for (let i = 0; i + 1 < p.length; i += 2) pts.push([p[i]!, -p[i + 1]!]);
      return pts;
    });
    const shape = g.mode === 'fill'
      ? CrossSection.ofPolygons(loops, 'EvenOdd')
      : CrossSection.union(loops.map((pts) => {
          const half = (g.line ?? 0.2) / 2;
          const figure = CrossSection.ofPolygons([pts], 'EvenOdd');
          return figure.offset(half, 'Miter').subtract(figure.offset(-half, 'Miter'));
        }));
    stored.set(g.name, shape);
    return shape;
  }

  /** graphic(name, { width, height }): 2D, centred; scaled to width or height (the other in proportion), both: stretched, neither: as stored. */
  function graphic(name: unknown, a?: unknown): CrossSection {
    const g = graphics.find((x) => x.name === name);
    if (!g) throw new Error(`graphic: no graphic ${JSON.stringify(name)}: add it with design_edit set_enclosure_graphic`);
    const o = (isOptions(a) ? a : typeof a === 'number' ? { width: a } : {}) as { width?: number; height?: number };
    const sx = o.width ? o.width / g.w : o.height ? o.height / g.h : 1;
    const sy = o.height ? o.height / g.h : sx;
    return graphicShape(g).scale([sx, sy]);
  }

  function face_frame(face: unknown) {
    const f = FACE_FRAMES[face as BoardFacing];
    if (!f) throw new Error(`on_face: no face ${JSON.stringify(face)} (left, right, top, bottom, above, below)`);
    return f;
  }

  /** on_face(face, at, solid): a solid laid on a face: its x to the reader's right, y up, z out of the box, its origin at the point `at`. */
  function on_face(face: unknown, at: unknown, ...children: unknown[]): Manifold {
    const [r, u, out] = face_frame(face);
    const a = at as number[];
    if (!Array.isArray(a) || a.length !== 3 || !a.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error(`on_face: at is a point on the face's outside, [x, y, z], got ${JSON.stringify(at) ?? String(at)}`);
    const joined = api.union(...children);
    if (joined instanceof CrossSection && !joined.isEmpty()) throw new Error('on_face: it lays solids on a face: to raise or sink a 2D shape use emboss or engrave');
    const solid = joined instanceof Manifold ? joined : Manifold.union([]);
    return solid.transform([r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, out[0], out[1], out[2], 0, a[0]!, a[1]!, a[2]!, 1]);
  }

  /**
   * The shape and how high or deep, of emboss and engrave: a number or { height } / { depth }, default
   * 0.6, in either order (in OpenSCAD the depth comes first).
   */
  function shapeAndAmount(fn: string, key: string, x: unknown, y: unknown): [unknown, number] {
    const first = x instanceof CrossSection || !(typeof x === 'number' || isOptions(x));
    const [shape, a] = first ? [x, y] : [y, x];
    const v = (typeof a === 'number' ? a : isOptions(a) ? (a[key] ?? 0.6) : 0.6) as number;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${fn}: ${key} has to be positive, got ${String(v)}`);
    return [shape, v];
  }

  /** emboss(face, at, shape, height = 0.6): the shape raised out of the face: union it with the piece. */
  function emboss(face: unknown, at: unknown, x: unknown, y?: unknown): Manifold {
    const [shape, height] = shapeAndAmount('emboss', 'height', x, y);
    return on_face(face, at, api.linear_extrude(shape, { height }));
  }

  /** engrave(face, at, shape, depth = 0.6): the shape sunk into the face, 0.01 proud of it for a clean cut: subtract it from the piece; intersected with the piece it is an inlay that fills it. */
  function engrave(face: unknown, at: unknown, x: unknown, y?: unknown): Manifold {
    const [shape, depth] = shapeAndAmount('engrave', 'depth', x, y);
    return on_face(face, at, api.linear_extrude(shape, { height: depth + 0.01 }).translate([0, 0, -depth]));
  }

  return guarded({
    pcb_thickness: facts.thickness,
    pcb_size: facts.size,
    pcb_outline: facts.outline,
    pcb_cutouts: facts.cutouts,
    holes: facts.holes,
    tallest_top: facts.tallestTop,
    lowest_bottom: facts.lowestBottom,
    parts_info,
    brief_openings,
    lid_clearance: brief?.lid_clearance_mm ?? DEFAULT_LID_CLEARANCE,
    graphics: graphics.map((g) => ({ name: g.name, w: g.w, h: g.h })),
    part_info,
    hole_info,
    face_frame,
    pcb_shape,
    pcb,
    part,
    parts,
    assembly,
    part_box,
    mating_path,
    keepouts,
    hole_posts,
    label,
    graphic,
    on_face,
    emboss,
    engrave,
  });
}

export type BoardLib = ReturnType<typeof createBoardLib>;
