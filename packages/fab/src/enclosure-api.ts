/**
 * What the agent reads about the enclosure script (get_enclosure): the board's facts as the script
 * finds them, and the geometry. It lives apart from csg/, which loads the WASM.
 */
import { MATING_PATH_LENGTH, type EnclosureBrief, type EnclosureGraphic } from '@4k7/schema';
import type { EnclosureFacts } from './scad.ts';

/** The script's shape and what it can call. */
export const ENCLOSURE_API = `// The script is JavaScript on the Manifold geometry engine: a function per piece, each returning a solid built in assembled position. Declare what you assign.
//   const wall = 2, gap = 0.5;                    parameters at the top
//   const pieces = ['base', 'lid'];               required: plain names, each a function of that name
//   const print = { lid: [180, 0, 0] };           how a piece is turned for printing (rotate's angles); plain numbers; a piece not named prints as built
//   const inlays = { lid_logo: { host: 'lid', colour: 'white' } };   pieces printed in another filament with their host; plain text
//   function base() { return difference(shell(), cavity(), mating_path('J1', { grow: 0.3 })); }
// No import or export, and nothing from outside: everything below is a global, and JavaScript's own (Math is in radians). Your own names shadow them. A solid's own methods work too (.translate, .subtract, .trimByPlane …).
//
// solids
// cube(size | [x, y, z], { center })
// cylinder({ h, r | d | r1, r2 | d1, d2, center, fn }), cylinder(h, r), cylinder(h, r1, r2)    r2: 0 is a cone
// sphere(r | { r | d, fn })
// polyhedron(points, faces)
// linear_extrude(shape, { height, center, twist, scale, slices }), linear_extrude(shape, height)
// rotate_extrude(shape, { angle, fn })            spins a shape in x ≥ 0 about the y axis, which becomes z
// 2D shapes
// square(size | [x, y], { center }), circle(r | { r | d, fn }), polygon(points, paths?)        polygon fills even-odd: a contour inside another is a hole
// text(string, { size, halign, valign, spacing })  left on the baseline; size is the capitals' height; one font, Liberation Sans Bold
// offset(shape, { r }) rounds, offset(shape, { delta }) keeps corners sharp, { delta, chamfer: true } cuts them
// projection(solid), projection(solid, { cut: true })    its shadow on z = 0, or its section there
// both (arguments in any order)
// A lone list is the children: intersection(list.map(…)) is what all of them share. Among other children a list is one child, the union of what is in it: difference([a, b], c) cuts c from both. null or false leaves one out, and what works only on that gives nothing: translate(v, brand && logo()). undefined is an error: it is what a function gives that forgot its return.
// union(…), difference(first, …), intersection(…), hull(…), minkowski(a, b)    minkowski: quick when a is convex, whatever its size, about 10 ms per triangle when not: do convex parts one by one and union them
// translate([x, y, z], c), rotate([x, y, z], c), rotate(angle, c), rotate(angle, axis, c), scale(f | [x, y, z], c), mirror(normal, c), multmatrix(m, c), resize([x, y, z], c)
// color(any, c) changes nothing: a piece's colour comes from the view, an inlay's from inlays
// rotate is degrees, about x, then y, then z, as OpenSCAD's. All return a new shape: nothing changes in place.
// sin(a), cos(a), tan(a), asin(x), acos(x), atan(x), atan2(y, x)    in degrees, as OpenSCAD's
// fn sets the segments of one round thing, set_fn(n) of all that follow (at the top for the whole script, in a piece until it ends). The default is fine for printing: about one per 0.25 mm of the circle, at most 72. A sphere reaches r exactly.
//
// round edges (quick ones first; round the plain outer shape, then cut the cavity and the openings out of it)
// round_extrude(shape, { height, r, top, bottom, fn })    any outline from z = 0 up, its rims (each can be off: top: false) and outer corners rounded by r. A convex outline at once, any other in a second or two
// round_box([x, y, z], r, { center, fn })         every edge rounded
// round_rect([x, y], r, { center })               2D, for an outline
// rounded(solid, r, { fn }), filleted(solid, r, { fn })    round what stands out, or fill what goes in (where a post meets a floor), on any solid. About 10 ms per triangle: for small plain solids, refused over 3000 triangles
// lights and lenses
// dome(d, h, { fn })                              a spherical cap on z = 0, d across, h high
// lens(d, { r, r2, edge, fn })                    a lens on the z axis: a cylindrical edge from z = 0, the surface of radius r on it, r2 under it; flat without
// smooth forms: signed distances (negative inside), melted together, then meshed; about edge mm from the true surface: cut exact fits out of them afterwards
// sdf(f, { min: [x, y, z], max: [x, y, z], edge })    the solid where f(p) < 0; edge 1 while you work, 0.5 at the end; f is any function of [x, y, z]
// sd_sphere(r, at), sd_box([x, y, z], r, at), sd_cylinder(h, r, at)    centred on at; r rounds the box inside its size
// smooth_union(k, a, b, …), smooth_difference(k, a, b, …), smooth_intersection(k, a, b, …)     melted over about k mm
// measuring (read them in the report with echo)
// bbox(s) → { min, max, size, center }, volume(s), distance(a, b, within = 20)    how far apart, at most within
// echo(…)                                         prints to the report, up to 100 lines: echo('lid', bbox(lid()).size)
//
// the board
// pcb_shape(delta = 0)                            2D: the outline grown by delta (negative shrinks), with the cutouts; offset it for walls
// pcb()                                           the board: outline, cutouts and mounting holes, 0 ≤ z ≤ pcb_thickness
// part(ref), parts(), assembly()                  one part's body and leads where it sits, every part, pcb() and parts()
// part_box(ref, grow = 0)                         the box round a part, grown by grow, for keep-outs
// part_info(ref), hole_info(id)                   its entry in parts_info, holes
// mating_path(ref, { length = ${MATING_PATH_LENGTH}, grow = 0 })     the way a part's plug (card, finger) needs, from its mating face outwards, grown across it: subtract it (grow: clearance) to cut the part's opening
// keepouts(refs = brief_openings, { grow = 0 })   parts() and the mating paths of refs: where the box must not be
// hole_posts(from, { d = 6 })                     a post under each mounting hole, from z = from (the floor) up to the board's underside (z = 0)
// labels and logos on the box's outside (2D shapes laid on a face, reading the right way from outside)
// label(string, { size = 5, halign, valign, spacing })    text(), centred on the origin
// graphic(name, { width, height })                2D: a graphic from graphics (set_enclosure_graphic), centred; scaled to width or height (the other in proportion), both: stretched, neither: as stored
// on_face(face, at, solid)                        lays a solid on a face: its x to the reader's right, y up, z out of the box, its origin at the point at (on the face's outside). face: 'left', 'right', 'top', 'bottom' (the walls along the board's edges as seen from above, as mating's facing), 'above' (the lid, read from above, y towards the top edge), 'below' (the floor, read from below with the box tipped towards you, y towards the bottom edge)
// emboss(face, at, shape, height = 0.6)           the shape raised out of the face: union it with the piece
// engrave(face, at, shape, depth = 0.6)           the shape sunk into the face (0.01 proud of it, for a clean cut): subtract it from the piece; intersection of the same with the piece is an inlay that fills it`;

const json = (v: unknown) => JSON.stringify(v).replace(/"(\w+)":/g, '$1: ').replace(/,(?=\S)/g, ', ');

/** The board as the agent reads it (get_enclosure): the script's globals with their values, and the API. */
export function enclosureApiSummary(facts: EnclosureFacts, brief?: EnclosureBrief, graphics?: EnclosureGraphic[]): string {
  const L: string[] = [];
  L.push("// the board, as globals of the script. Millimetres; x right, y up from the board's bottom-left corner, z up, the board's underside at z = 0.");
  L.push(`pcb_thickness = ${facts.thickness}`);
  L.push(`pcb_size = ${json(facts.size)}    // the outline's bounding box`);
  L.push(`pcb_outline = ${json(facts.outline)}`);
  L.push(`pcb_cutouts = ${json(facts.cutouts)}`);
  L.push(`holes = ${json(facts.holes)}    // mounting holes; d: diameter`);
  L.push(`tallest_top = ${facts.tallestTop}    // highest point of any part (absolute z)`);
  L.push(`lowest_bottom = ${facts.lowestBottom}    // lowest point of any part: through-hole leads and bottom parts (absolute z, ≤ 0)`);
  L.push('// every part. min, max: the box round it; approx: no 3D body, the box is its footprint at the package height');
  L.push("// mating: null when it is not plugged, else facing: where it is plugged from (left, right, top, bottom = the board's edges as seen from above; above; below), origin: the face's centre, dir: the way out, u, v: across it, size: along u and v");
  L.push('parts_info = [');
  for (const p of facts.parts) L.push(`  ${json({ ref: p.ref, kind: p.kind, min: p.min, max: p.max, side: p.side, approx: p.approx, mating: p.mating ?? null })},`);
  L.push(']');
  L.push(`brief_openings = ${json(brief?.openings ?? [])}    // from the brief: the parts used from outside`);
  L.push(`lid_clearance = ${brief?.lid_clearance_mm ?? 1}    // from the brief: the room over the tallest part`);
  L.push(`graphics = ${json((graphics ?? []).map((g) => ({ name: g.name, w: g.w, h: g.h })))}    // set_enclosure_graphic; draw one with graphic(name)`);
  L.push('');
  L.push(ENCLOSURE_API);
  return L.join('\n');
}
