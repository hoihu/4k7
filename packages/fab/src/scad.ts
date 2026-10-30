/**
 * The board as an OpenSCAD library (board.scad) for the enclosure script the agent writes
 * (docs/design/enclosure.md §3): the outline, holes and cutouts, every part's body, where each
 * part is plugged from and the way its plug needs, as data and as modules.
 *
 * Coordinates as the STEP export's: millimetres, x right and y up from the board's bottom-left
 * corner, z up, the board's underside at z = 0 (its top at pcb_thickness).
 */
import { boardBodies, type Body3D } from '@4k7/parts';
import { boardFacing, boardPolygon, cutoutPolygon, FACE_FRAMES, MATING_PATH_LENGTH as PATH_LENGTH, matingOf, type BoardFacing, type BoardPart, type BoardView, type EnclosureBrief, type EnclosureGraphic, type Mating } from '@4k7/schema';
import type { FabFile } from './gerber.ts';

/** Board thickness and copper (as the 3D view and the STEP export: parts sit on the copper). */
export const PCB_THICKNESS = 1.6;
const CU = 0.035;

export type V3 = [number, number, number];

/** A part as the enclosure sees it, in board coordinates. */
export interface ScadPart {
  ref: string;
  /** Its card's category ("connector", "ic" …), or "part". */
  kind: string;
  /** Box round everything of it (body and leads). */
  min: V3;
  max: V3;
  side: 'top' | 'bottom';
  /** No 3D body: its box is the footprint's body outline at the package height (or 1 mm). */
  approx: boolean;
  /** Where it is plugged from, and the way the plug needs. */
  mating?: MatingPath;
}

/**
 * The space a plug, card or finger needs in front of a part: a box `size` (across the way in: u × v)
 * from the face's centre `origin` outwards along `dir`.
 */
export interface MatingPath {
  facing: BoardFacing;
  origin: V3;
  dir: V3;
  u: V3;
  v: V3;
  size: [number, number];
}

export interface EnclosureFacts {
  thickness: number;
  /** The outline's bounding box (x, y). */
  size: [number, number];
  /** The outline (y up). */
  outline: [number, number][];
  cutouts: [number, number][][];
  holes: { id: string; x: number; y: number; d: number; plated: boolean }[];
  /** Highest and lowest point of any part (absolute z; lowest ≤ 0: THT leads and bottom parts below the underside). */
  tallestTop: number;
  lowestBottom: number;
  parts: ScadPart[];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000 || 0;
const n = (v: number) => String(r3(v));
const vec = (v: readonly number[]) => `[${v.map(n).join(', ')}]`;
const str = (s: string) => `"${s.replace(/["\\]/g, '')}"`;

/** A part's frame on the board: body coordinates (x right, y down as the footprint, z up) → board.scad's. */
function frame(part: BoardPart, boardH: number) {
  const a = (-part.rot * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const bottom = part.side === 'bottom';
  // on the copper, turned clockwise as seen from the top; on the bottom, turned over about its y axis
  const X: V3 = bottom ? [-c, -s, 0] : [c, s, 0];
  const Y: V3 = [-s, c, 0];
  const Z: V3 = [0, 0, bottom ? -1 : 1];
  const O: V3 = [part.x, boardH - part.y, bottom ? -CU : PCB_THICKNESS + CU];
  /** A body point (y down) in board.scad coordinates. */
  const point = (x: number, y: number, z: number): V3 => [O[0] + X[0] * x - Y[0] * y + Z[0] * z, O[1] + X[1] * x - Y[1] * y + Z[1] * z, O[2] + X[2] * x - Y[2] * y + Z[2] * z];
  /** A body direction (y down). */
  const dir = (x: number, y: number, z: number): V3 => {
    const p = [X[0] * x - Y[0] * y + Z[0] * z, X[1] * x - Y[1] * y + Z[1] * z, X[2] * x - Y[2] * y + Z[2] * z] as V3;
    return p.map((v) => Math.round(v * 1e9) / 1e9 || 0) as V3;
  };
  // the matrix for body coordinates with y already flipped (y up): columns X, Y, Z, O
  const rows = [0, 1, 2].map((i) => [r3(X[i]!), r3(Y[i]!), r3(Z[i]!), r3(O[i]!)]);
  const matrix = `[${[...rows, [0, 0, 0, 1]].map(vec).join(', ')}]`;
  return { point, dir, rows, matrix };
}

/** Local solids of a body for the enclosure: the body itself, leads above the board as one box, leads below as one. */
export interface PartSolid {
  /** Box (y down, body coordinates). */
  box?: { min: V3; max: V3 };
  /** Upright cylinder, or lying along x. */
  cyl?: { x: number; y: number; z0: number; z1: number; r: number; lying?: number };
}

function bodySolids(body: Body3D): PartSolid[] {
  const out: PartSolid[] = [];
  const above: { min: V3; max: V3 }[] = [];
  const below: { min: V3; max: V3 }[] = [];
  const lead = (min: V3, max: V3) => {
    if (max[2] > 0) above.push({ min: [min[0], min[1], Math.max(0, min[2])], max });
    if (min[2] < 0) below.push({ min, max: [max[0], max[1], Math.min(0, max[2])] });
  };
  for (const b of body.boxes) {
    if (b.mat === 'mark') continue;
    if (b.mat === 'lead') lead(b.min, b.max);
    else out.push({ box: { min: b.min, max: b.max } });
  }
  for (const c of body.cylinders ?? []) {
    if (c.mat === 'mark') continue;
    if (c.mat === 'lead') {
      const min: V3 = c.lying ? [c.x - c.lying / 2, c.y - c.r, c.z0 - c.r] : [c.x - c.r, c.y - c.r, c.z0];
      const max: V3 = c.lying ? [c.x + c.lying / 2, c.y + c.r, c.z0 + c.r] : [c.x + c.r, c.y + c.r, c.z1];
      lead(min, max);
    } else out.push({ cyl: { x: c.x, y: c.y, z0: c.z0, z1: c.z1, r: c.r, ...(c.lying ? { lying: c.lying } : {}) } });
  }
  if (body.board) out.push({ box: { min: [-body.board.w / 2, -body.board.h / 2, 0], max: [body.board.w / 2, body.board.h / 2, body.board.t] } });
  for (const group of [above, below]) {
    if (!group.length) continue;
    const min: V3 = [Math.min(...group.map((g) => g.min[0])), Math.min(...group.map((g) => g.min[1])), Math.min(...group.map((g) => g.min[2]))];
    const max: V3 = [Math.max(...group.map((g) => g.max[0])), Math.max(...group.map((g) => g.max[1])), Math.max(...group.map((g) => g.max[2]))];
    if (max[0] - min[0] > 1e-3 && max[1] - min[1] > 1e-3 && max[2] - min[2] > 1e-3) out.push({ box: { min, max } });
  }
  return out;
}

/** The solids of a part without a 3D body: its body outline (footprint, axis-aligned on the board) at the package height. */
function fallbackSolids(part: BoardPart): PartSolid[] {
  const swapped = part.rot % 180 !== 0;
  const w = swapped ? part.body.h : part.body.w;
  const h = swapped ? part.body.w : part.body.h;
  return [{ box: { min: [-w / 2, -h / 2, 0], max: [w / 2, h / 2, part.pkgInfo.height_mm ?? 1] } }];
}

/** Bounding box of solids in their own (body) coordinates; `above`: only what is above the board. */
function localBounds(solids: PartSolid[], above = false): { min: V3; max: V3 } | null {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const s of solids) {
    const [a, b]: [V3, V3] = s.box
      ? [s.box.min, s.box.max]
      : s.cyl!.lying
        ? [[s.cyl!.x - s.cyl!.lying / 2, s.cyl!.y - s.cyl!.r, s.cyl!.z0 - s.cyl!.r], [s.cyl!.x + s.cyl!.lying / 2, s.cyl!.y + s.cyl!.r, s.cyl!.z0 + s.cyl!.r]]
        : [[s.cyl!.x - s.cyl!.r, s.cyl!.y - s.cyl!.r, s.cyl!.z0], [s.cyl!.x + s.cyl!.r, s.cyl!.y + s.cyl!.r, s.cyl!.z1]];
    if (above && b[2] <= 0) continue;
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, i === 2 && above ? Math.max(0, a[i]!) : a[i]!);
      max[i] = Math.max(max[i]!, b[i]!);
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/** The way in front of a part's mating face (body coordinates first, then on the board). */
function matingPath(m: Mating, part: BoardPart, local: { min: V3; max: V3 }, f: ReturnType<typeof frame>): MatingPath {
  const [x0, y0, z0] = local.min;
  const [x1, y1, z1] = local.max;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const zc = m.axis_mm ?? (Math.max(0, z0) + z1) / 2;
  const along = m.along_mm ?? 0;
  let at: V3, d: V3, u: V3, v: V3, size: [number, number];
  switch (m.face) {
    case 'left':
      [at, d, u, v, size] = [[x0, cy + along, zc], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [y1 - y0, z1 - Math.max(0, z0)]];
      break;
    case 'right':
      [at, d, u, v, size] = [[x1, cy + along, zc], [1, 0, 0], [0, 1, 0], [0, 0, 1], [y1 - y0, z1 - Math.max(0, z0)]];
      break;
    case 'top':
      [at, d, u, v, size] = [[cx + along, y0, zc], [0, -1, 0], [1, 0, 0], [0, 0, 1], [x1 - x0, z1 - Math.max(0, z0)]];
      break;
    case 'bottom':
      [at, d, u, v, size] = [[cx + along, y1, zc], [0, 1, 0], [1, 0, 0], [0, 0, 1], [x1 - x0, z1 - Math.max(0, z0)]];
      break;
    case 'up':
      [at, d, u, v, size] = [[cx, cy, z1], [0, 0, 1], [1, 0, 0], [0, 1, 0], [x1 - x0, y1 - y0]];
      break;
  }
  return {
    facing: boardFacing(m.face, part.rot, part.side),
    origin: f.point(...at).map(r3) as V3,
    dir: f.dir(...d),
    u: f.dir(...u),
    v: f.dir(...v),
    size: (m.plug_mm ?? size).map(r3) as [number, number],
  };
}

const isHole = (p: BoardPart) => p.componentId.startsWith('hole:');

/** Each part's solids and where they go: rows (3 × 4) take body coordinates with y flipped to the board's. */
export type PartSolids = Map<string, { matrix: string; rows: number[][]; solids: PartSolid[] }>;

/** The board's facts for the enclosure (the script's library, board.scad, get_enclosure). */
export function enclosureFacts(b: BoardView): EnclosureFacts & { solids: PartSolids } {
  const H = b.outline.h;
  const flip = (poly: number[]): [number, number][] => {
    const pts: [number, number][] = [];
    for (let i = 0; i + 1 < poly.length; i += 2) pts.push([r3(poly[i]!), r3(H - poly[i + 1]!)]);
    return pts;
  };
  const bodies = boardBodies(b);
  const parts: ScadPart[] = [];
  const solids: PartSolids = new Map();
  let top = PCB_THICKNESS;
  let bottom = 0;
  for (const part of b.parts) {
    if (isHole(part)) continue;
    const body = bodies.get(part.componentId);
    const local = body ? bodySolids(body) : fallbackSolids(part);
    const bounds = localBounds(local);
    if (!bounds) continue;
    const f = frame(part, H);
    // the world box: the local box's corners on the board
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => f.point(i & 1 ? bounds.max[0] : bounds.min[0], i & 2 ? bounds.max[1] : bounds.min[1], i & 4 ? bounds.max[2] : bounds.min[2]));
    const min = [0, 1, 2].map((i) => r3(Math.min(...corners.map((c) => c[i]!)))) as V3;
    const max = [0, 1, 2].map((i) => r3(Math.max(...corners.map((c) => c[i]!)))) as V3;
    top = Math.max(top, max[2]);
    bottom = Math.min(bottom, min[2]);
    const m = matingOf(part.pkgInfo);
    const above = localBounds(local, true) ?? bounds;
    parts.push({
      ref: part.refdes,
      kind: part.category ?? 'part',
      min,
      max,
      side: part.side,
      approx: !body,
      ...(m ? { mating: matingPath(m, part, above, f) } : {}),
    });
    solids.set(part.refdes, { matrix: f.matrix, rows: f.rows, solids: local });
  }
  return {
    thickness: PCB_THICKNESS,
    size: [r3(b.outline.w), r3(b.outline.h)],
    outline: flip(boardPolygon(b)),
    cutouts: (b.cutouts ?? []).map((c) => flip(cutoutPolygon(c))),
    holes: b.parts.filter(isHole).map((p) => ({ id: p.refdes, x: r3(p.x), y: r3(H - p.y), d: p.pads[0]?.drill ?? 3, plated: !p.pads[0]?.npth })),
    tallestTop: r3(top),
    lowestBottom: r3(bottom),
    parts,
    solids,
  };
}

/** One solid in OpenSCAD, body coordinates with y flipped (inside the part's multmatrix). */
function solidScad(s: PartSolid): string {
  if (s.box) {
    const { min, max } = s.box;
    return `translate(${vec([min[0], -max[1], min[2]])}) cube(${vec([max[0] - min[0], max[1] - min[1], max[2] - min[2]])});`;
  }
  const c = s.cyl!;
  if (c.lying) return `translate(${vec([c.x, -c.y, c.z0])}) rotate([0, 90, 0]) cylinder(h = ${n(c.lying)}, r = ${n(c.r)}, center = true);`;
  return `translate(${vec([c.x, -c.y, c.z0])}) cylinder(h = ${n(c.z1 - c.z0)}, r = ${n(c.r)});`;
}

const vec3s = (f: readonly V3[]) => `[${f.map(vec).join(', ')}]`;

/** A graphic's figures in OpenSCAD (y up): one even-odd polygon, or each figure's outline as a band `line` wide. */
function graphicScad(g: EnclosureGraphic): string {
  const loops = g.polys.filter((p) => p.length >= 6).map((p) => {
    const pts: string[] = [];
    for (let i = 0; i + 1 < p.length; i += 2) pts.push(`[${n(p[i]!)},${n(-p[i + 1]!)}]`);
    return pts;
  });
  if (g.mode === 'outline') {
    const half = n((g.line ?? 0.2) / 2);
    return `{\n${loops.map((pts) => `    difference() { offset(delta = ${half}) polygon([${pts.join(',')}]); offset(delta = -${half}) polygon([${pts.join(',')}]); }`).join('\n')}\n  }`;
  }
  let k = 0;
  const paths = loops.map((pts) => `[${pts.map(() => k++).join(',')}]`);
  return `polygon(points = [${loops.flat().join(',')}], paths = [${paths.join(',')}]);`;
}

/** The modules' signatures and what they do: shown to the agent (get_enclosure) without the parts' solids. */
export const BOARD_SCAD_API = `// modules (board.scad)
// pcb_shape(delta = 0)            2D: the outline grown by delta (mm, negative shrinks), with the cutouts; offset it for walls
// pcb()                           the board: outline, cutouts and mounting holes, 0 ≤ z ≤ pcb_thickness
// part(ref)                       one part's body (and its leads) where it sits, e.g. part("J1")
// parts()                         every part
// assembly()                      pcb() and parts()
// part_box(ref, grow = 0)         the box round a part (parts_info min/max) grown by grow, for keep-outs
// mating_path(ref, length = ${PATH_LENGTH}, grow = 0)
//                                 the way a part's plug (card, finger) needs, from its mating face outwards, grown by grow
//                                 across it: subtract it (grow = clearance) to cut the part's opening
// keepouts(refs = brief_openings, grow = 0)
//                                 parts() and the mating paths of refs: where the box must not be
// hole_posts(from, d = 6)        a post under each mounting hole, diameter d, from z = from (the floor) up to the board's underside (z = 0)
// functions: part_info(ref) → [ref, kind, min, max, side, approx, mating]; hole_info(id)
//
// labels and logos on the box's outside (2D shapes laid on a face, reading the right way from outside)
// label(t, size = 5, font = label_font, halign = "center", valign = "center")
//                                 2D text, centred on the origin; size is the capitals' height (mm)
// graphic(name, width = 0, height = 0)
//                                 2D: a graphic from graphics (set_enclosure_graphic), centred; scaled to width or height
//                                 (the other in proportion), both: stretched, neither: its stored size
// on_face(face, at)               lays 2D children on a face: their x to the reader's right, y up, z out of the box,
//                                 the origin at the point at (on the face's outside). face: "left", "right", "top",
//                                 "bottom" (the walls along the board's edges as seen from above, as mating's plugged
//                                 from), "above" (the lid, read from above, y towards the top edge), "below" (the floor,
//                                 read from below with the box tipped towards you, y towards the bottom edge)
// emboss(face, at, height = 0.6)  the 2D children raised out of the face: union() it with the piece
// engrave(face, at, depth = 0.6)  the 2D children sunk into the face (0.01 proud of it, for a clean cut): difference() it
//                                 from the piece; intersection() of the same with the piece is an inlay that fills it`;

/** board.scad for the enclosure script. */
export function boardScad(b: BoardView, project: string, brief?: EnclosureBrief, graphics?: EnclosureGraphic[]): FabFile & { facts: EnclosureFacts } {
  const f = enclosureFacts(b);
  const { solids, ...facts } = f;
  const L: string[] = [];
  L.push(`// board.scad: ${project || 'the board'} as an OpenSCAD library, written by 4k7. Do not edit: it is written again from the board.`);
  L.push('// Millimetres; x right, y up from the board\'s bottom-left corner, z up, the board\'s underside at z = 0.');
  L.push('');
  L.push(`pcb_thickness = ${n(f.thickness)};`);
  L.push(`pcb_size = ${vec(f.size)};             // the outline's bounding box`);
  L.push(`pcb_outline = [${f.outline.map(vec).join(', ')}];`);
  L.push(`pcb_cutouts = [${f.cutouts.map((c) => `[${c.map(vec).join(', ')}]`).join(', ')}];`);
  L.push('// mounting holes: [id, x, y, diameter, plated]');
  L.push(`holes = [${f.holes.map((h) => `[${str(h.id)}, ${n(h.x)}, ${n(h.y)}, ${n(h.d)}, ${h.plated}]`).join(', ')}];`);
  L.push(`tallest_top = ${n(f.tallestTop)};       // highest point of any part (absolute z)`);
  L.push(`lowest_bottom = ${n(f.lowestBottom)};    // lowest point of any part: through-hole leads and bottom parts (absolute z, ≤ 0)`);
  L.push('');
  L.push('// every part: [ref, kind, min, max, side, approx, mating]');
  L.push('//   min, max: the box round it; approx: no 3D body, the box is its footprint at the package height');
  L.push('//   mating: [plugged from (left, right, top, bottom = the board\'s edges as seen from above; above; below),');
  L.push('//            face centre, direction out, across u, across v, [size along u, size along v]], or [] when it is not plugged');
  L.push('parts_info = [');
  for (const p of f.parts) {
    const m = p.mating ? `[${str(p.mating.facing)}, ${vec(p.mating.origin)}, ${vec(p.mating.dir)}, ${vec(p.mating.u)}, ${vec(p.mating.v)}, ${vec(p.mating.size)}]` : '[]';
    L.push(`  [${str(p.ref)}, ${str(p.kind)}, ${vec(p.min)}, ${vec(p.max)}, ${str(p.side)}, ${p.approx}, ${m}],`);
  }
  L.push('];');
  L.push('');
  L.push('// from the enclosure brief: the parts used from outside, and the room over the tallest part');
  L.push(`brief_openings = [${(brief?.openings ?? []).map(str).join(', ')}];`);
  L.push(`lid_clearance = ${n(brief?.lid_clearance_mm ?? 1)};`);
  L.push('');
  L.push('// graphics for the box (set_enclosure_graphic): [name, [width, height] as stored]; draw one with graphic(name)');
  L.push(`graphics = [${(graphics ?? []).map((g) => `[${str(g.name)}, ${vec([g.w, g.h])}]`).join(', ')}];`);
  L.push('label_font = "Liberation Sans:style=Bold";   // comes with OpenSCAD: the same on every computer');
  L.push('');
  L.push(BOARD_SCAD_API);
  L.push('');
  L.push(`function part_info(ref) = [for (p = parts_info) if (p[0] == ref) p][0];`);
  L.push(`function hole_info(id) = [for (h = holes) if (h[0] == id) h][0];`);
  L.push('');
  L.push('module pcb_shape(delta = 0) {');
  L.push('  offset(delta = delta) difference() {');
  L.push('    polygon(pcb_outline);');
  L.push('    for (c = pcb_cutouts) polygon(c);');
  L.push('  }');
  L.push('}');
  L.push('');
  L.push('module pcb() {');
  L.push('  color("#1f6b3c") linear_extrude(height = pcb_thickness) difference() {');
  L.push('    pcb_shape();');
  L.push('    for (h = holes) translate([h[1], h[2]]) circle(d = h[3], $fn = 32);');
  L.push('  }');
  L.push('}');
  L.push('');
  L.push('module part(ref) {');
  for (const p of f.parts) {
    const s = solids.get(p.ref)!;
    L.push(`  if (ref == ${str(p.ref)}) multmatrix(${s.matrix}) {`);
    for (const x of s.solids) L.push(`    ${solidScad(x)}`);
    L.push('  }');
  }
  L.push('}');
  L.push('');
  L.push('module parts() { color("#2e3137") for (p = parts_info) part(p[0]); }');
  L.push('');
  L.push('module assembly() { pcb(); parts(); }');
  L.push('');
  L.push('module part_box(ref, grow = 0) {');
  L.push('  p = part_info(ref);');
  L.push('  if (p != undef) translate(p[2] - [grow, grow, grow]) cube(p[3] - p[2] + [2 * grow, 2 * grow, 2 * grow]);');
  L.push('}');
  L.push('');
  L.push(`module mating_path(ref, length = ${PATH_LENGTH}, grow = 0) {`);
  L.push('  p = part_info(ref);');
  L.push('  m = p == undef ? [] : p[6];');
  L.push('  if (len(m) > 0) {');
  L.push('    o = m[1]; d = m[2]; u = m[3]; v = m[4]; s = m[5];');
  L.push('    multmatrix([[u[0], v[0], d[0], o[0]], [u[1], v[1], d[1], o[1]], [u[2], v[2], d[2], o[2]], [0, 0, 0, 1]])');
  L.push('      translate([-s[0] / 2 - grow, -s[1] / 2 - grow, 0]) cube([s[0] + 2 * grow, s[1] + 2 * grow, length]);');
  L.push('  }');
  L.push('}');
  L.push('');
  L.push('module keepouts(refs = brief_openings, grow = 0) {');
  L.push('  parts();');
  L.push('  for (r = refs) mating_path(r, grow = grow);');
  L.push('}');
  L.push('');
  L.push('module hole_posts(from, d = 6) {');
  L.push('  for (x = holes) translate([x[1], x[2], from]) cylinder(h = -from, d = d, $fn = 48);');
  L.push('}');
  L.push('');
  L.push('module label(t, size = 5, font = label_font, halign = "center", valign = "center", spacing = 1) {');
  L.push('  text(t, size = size, font = font, halign = halign, valign = valign, spacing = spacing, $fn = 24);');
  L.push('}');
  L.push('');
  L.push('// a face\'s frame: [the reader\'s right, up, out of the box]');
  L.push('function face_frame(face) =');
  for (const [face, f] of Object.entries(FACE_FRAMES)) L.push(`  face == ${str(face)} ? ${vec3s(f)} :`);
  L.push('  assert(false, str("on_face: no face \\"", face, "\\" (left, right, top, bottom, above, below)")) undef;');
  L.push('');
  L.push('module on_face(face, at) {');
  L.push('  f = face_frame(face);');
  L.push('  multmatrix([[f[0][0], f[1][0], f[2][0], at[0]], [f[0][1], f[1][1], f[2][1], at[1]], [f[0][2], f[1][2], f[2][2], at[2]], [0, 0, 0, 1]]) children();');
  L.push('}');
  L.push('');
  L.push('module emboss(face, at, height = 0.6) { on_face(face, at) linear_extrude(height = height) children(); }');
  L.push('');
  L.push('module engrave(face, at, depth = 0.6) { on_face(face, at) translate([0, 0, -depth]) linear_extrude(height = depth + 0.01) children(); }');
  L.push('');
  L.push('module graphic(name, width = 0, height = 0) {');
  L.push('  g = [for (x = graphics) if (x[0] == name) x][0];');
  L.push('  assert(g != undef, str("no graphic \\"", name, "\\": add it with design_edit set_enclosure_graphic"));');
  L.push('  sx = width > 0 ? width / g[1][0] : height > 0 ? height / g[1][1] : 1;');
  L.push('  sy = height > 0 ? height / g[1][1] : sx;');
  L.push('  scale([sx, sy]) graphic_shape(name);');
  L.push('}');
  L.push('');
  L.push('// the graphics\' figures (y up), at their stored size');
  L.push('module graphic_shape(name) {');
  for (const g of graphics ?? []) L.push(`  if (name == ${str(g.name)}) ${graphicScad(g)}`);
  L.push('}');
  L.push('');
  return { name: 'board.scad', content: L.join('\n'), facts };
}

/** board.scad as the agent reads it (get_enclosure): the data and the modules' signatures, without the parts' solids. */
export function boardScadSummary(content: string): string {
  const end = content.indexOf('function part_info');
  return (end > 0 ? content.slice(0, end) : content).trimEnd();
}
