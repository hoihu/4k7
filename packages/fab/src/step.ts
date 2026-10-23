/**
 * The assembled board as a STEP file (ISO 10303-21, AP214) for mechanical CAD: the board with its
 * cutouts and drilled holes, and every part body, as exact solids (planes and cylinders). An
 * assembly: the PCB and one component per part, named by its designator. Coloured like the 3D
 * view.
 *
 * Millimetres; x right and y up from the board's bottom-left corner (as the fab files), z up,
 * the board's underside at z = 0. Copper, mask and silkscreen are not included; BGA balls are
 * cylinders and a module's top picture is left out.
 */
import { boardBodies, type Body3D } from '@4k7/parts';
import { boardPolygon, cutoutPolygon, insidePolygon, type BoardView } from '@4k7/schema';
import type { FabFile } from './gerber.ts';

/** Board thickness and copper (the 3D view's): parts sit on the copper. */
const THICKNESS = 1.6;
const CU = 0.035;

type V3 = [number, number, number];
type Mat = 'board' | 'body' | 'lead' | 'mark' | 'pcb';

const COLOURS: Record<Mat, V3> = {
  board: [0.114, 0.353, 0.2],
  body: [0.18, 0.192, 0.216],
  lead: [0.788, 0.8, 0.824],
  mark: [0.541, 0.557, 0.588],
  pcb: [0.122, 0.42, 0.235],
};

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => mul(a, 1 / len(a));

/** A real as STEP writes it: always with a decimal point. */
function num(v: number): string {
  const r = Math.round(v * 1e6) / 1e6 || 0;
  const s = String(r);
  return s.includes('.') ? s : `${s}.`;
}

/** A string: quotes doubled, anything beyond ASCII as \X2\ hex. */
function str(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "'") out += "''";
    else if (ch === '\\') out += '\\\\';
    else if (c >= 0x20 && c < 0x7f) out += ch;
    else {
      let hex = '';
      for (let i = 0; i < ch.length; i++) hex += ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
      out += `\\X2\\${hex}\\X0\\`;
    }
  }
  return `'${out}'`;
}

/** A closed profile loop: a polygon (x, y pairs) or a circle. */
type Loop = { k: 'poly'; pts: [number, number][] } | { k: 'circle'; c: [number, number]; r: number };

/**
 * A prism: a profile (outer loop, holes) in the plane through `o` spanned by `u` and `v`,
 * extruded by `w`. Boxes, upright and lying cylinders and the boards are all prisms.
 */
interface Prism {
  o: V3;
  u: V3;
  v: V3;
  w: V3;
  outer: Loop;
  holes: Loop[];
}

/** Drops repeated and collinear points; null when nothing with an area is left. */
function cleanPoly(pts: [number, number][]): [number, number][] | null {
  let p = pts.filter((a, i) => {
    const b = pts[(i + 1) % pts.length]!;
    return Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-5;
  });
  for (let changed = true; changed && p.length >= 3; ) {
    changed = false;
    for (let i = 0; i < p.length; i++) {
      const a = p[(i + p.length - 1) % p.length]!;
      const b = p[i]!;
      const c = p[(i + 1) % p.length]!;
      const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-9 * Math.max(1, ab)) {
        p = p.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return p.length >= 3 ? p : null;
}

const area2 = (p: [number, number][]) => p.reduce((s, a, i) => s + a[0] * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * a[1], 0);

class StepWriter {
  private out: string[] = [];
  private n = 0;
  private styles = new Map<Mat, number>();
  private styled: number[] = [];

  add(entity: string): number {
    this.out.push(`#${++this.n}=${entity};`);
    return this.n;
  }
  point(p: V3) {
    return this.add(`CARTESIAN_POINT('',(${num(p[0])},${num(p[1])},${num(p[2])}))`);
  }
  dir(d: V3) {
    const u = unit(d);
    return this.add(`DIRECTION('',(${num(u[0])},${num(u[1])},${num(u[2])}))`);
  }
  axis(o: V3, z: V3, x: V3) {
    return this.add(`AXIS2_PLACEMENT_3D('',#${this.point(o)},#${this.dir(z)},#${this.dir(x)})`);
  }
  vertex(p: V3) {
    return this.add(`VERTEX_POINT('',#${this.point(p)})`);
  }
  lineEdge(a: { v: number; p: V3 }, b: { v: number; p: V3 }) {
    const d = sub(b.p, a.p);
    const vec = this.add(`VECTOR('',#${this.dir(d)},${num(len(d))})`);
    const line = this.add(`LINE('',#${this.point(a.p)},#${vec})`);
    return this.add(`EDGE_CURVE('',#${a.v},#${b.v},#${line},.T.)`);
  }
  oriented(edge: number, forward: boolean) {
    return `#${this.add(`ORIENTED_EDGE('',*,*,#${edge},${forward ? '.T.' : '.F.'})`)}`;
  }
  loop(edges: string[]) {
    return this.add(`EDGE_LOOP('',(${edges.join(',')}))`);
  }
  face(bounds: number[], surface: number, sameSense = true) {
    const b = bounds.map((l, i) => `#${this.add(`${i ? 'FACE_BOUND' : 'FACE_OUTER_BOUND'}('',#${l},.T.)`)}`);
    return this.add(`ADVANCED_FACE('',(${b.join(',')}),#${surface},${sameSense ? '.T.' : '.F.'})`);
  }

  /** A prism as a closed B-rep solid, its faces pointing out. */
  prism(pr: Prism, name: string): number {
    const sp = (x: number, y: number): V3 => add(pr.o, add(mul(pr.u, x), mul(pr.v, y)));
    const W = unit(pr.w);
    const U = unit(pr.u);
    // the profile counter-clockwise seen from +w (the top), holes clockwise
    const rightHanded = dot(cross(pr.u, pr.v), pr.w) > 0;
    const ccw = (p: [number, number][]) => (area2(p) > 0) === rightHanded;
    const bottomBounds: number[] = [];
    const topBounds: number[] = [];
    const faces: number[] = [];
    const loops = [{ l: pr.outer, hole: false }, ...pr.holes.map((l) => ({ l, hole: true }))];
    for (const { l, hole } of loops) {
      if (l.k === 'circle') {
        const c0 = sp(l.c[0], l.c[1]);
        const c1 = add(c0, pr.w);
        const vb = { v: this.vertex(add(c0, mul(U, l.r))), p: add(c0, mul(U, l.r)) };
        const vt = { v: this.vertex(add(c1, mul(U, l.r))), p: add(c1, mul(U, l.r)) };
        // circles run counter-clockwise about +w; a hole runs them backwards
        const cb = this.add(`EDGE_CURVE('',#${vb.v},#${vb.v},#${this.add(`CIRCLE('',#${this.axis(c0, W, U)},${num(l.r)})`)},.T.)`);
        const ct = this.add(`EDGE_CURVE('',#${vt.v},#${vt.v},#${this.add(`CIRCLE('',#${this.axis(c1, W, U)},${num(l.r)})`)},.T.)`);
        const seam = this.lineEdge(vb, vt);
        topBounds.push(this.loop([this.oriented(ct, !hole)]));
        bottomBounds.push(this.loop([this.oriented(cb, hole)]));
        const cyl = this.add(`CYLINDRICAL_SURFACE('',#${this.axis(c0, W, U)},${num(l.r)})`);
        const wall = hole
          ? [this.oriented(cb, false), this.oriented(seam, true), this.oriented(ct, true), this.oriented(seam, false)]
          : [this.oriented(cb, true), this.oriented(seam, true), this.oriented(ct, false), this.oriented(seam, false)];
        faces.push(this.face([this.loop(wall)], cyl, !hole));
        continue;
      }
      const pts = ccw(l.pts) === !hole ? l.pts : [...l.pts].reverse();
      const n = pts.length;
      const bot = pts.map(([x, y]) => {
        const p = sp(x, y);
        return { v: this.vertex(p), p };
      });
      const top = bot.map(({ p }) => {
        const q = add(p, pr.w);
        return { v: this.vertex(q), p: q };
      });
      const eb = bot.map((a, i) => this.lineEdge(a, bot[(i + 1) % n]!));
      const et = top.map((a, i) => this.lineEdge(a, top[(i + 1) % n]!));
      const up = bot.map((a, i) => this.lineEdge(a, top[i]!));
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const along = sub(bot[j]!.p, bot[i]!.p);
        const plane = this.add(`PLANE('',#${this.axis(bot[i]!.p, cross(along, W), along)})`);
        faces.push(this.face([this.loop([this.oriented(eb[i]!, true), this.oriented(up[j]!, true), this.oriented(et[i]!, false), this.oriented(up[i]!, false)])], plane));
      }
      topBounds.push(this.loop(et.map((e) => this.oriented(e, true))));
      bottomBounds.push(this.loop([...eb].reverse().map((e) => this.oriented(e, false))));
    }
    faces.push(this.face(topBounds, this.add(`PLANE('',#${this.axis(add(pr.o, pr.w), W, U)})`)));
    faces.push(this.face(bottomBounds, this.add(`PLANE('',#${this.axis(pr.o, mul(W, -1), U)})`)));
    const shell = this.add(`CLOSED_SHELL('',(${faces.map((f) => `#${f}`).join(',')}))`);
    return this.add(`MANIFOLD_SOLID_BREP(${str(name)},#${shell})`);
  }

  /** Give a solid its colour (one style per colour, shared). */
  colour(solid: number, mat: Mat) {
    let psa = this.styles.get(mat);
    if (psa === undefined) {
      const [r, g, b] = COLOURS[mat];
      const rgb = this.add(`COLOUR_RGB('',${num(r)},${num(g)},${num(b)})`);
      const fill = this.add(`FILL_AREA_STYLE('',(#${this.add(`FILL_AREA_STYLE_COLOUR('',#${rgb})`)}))`);
      const side = this.add(`SURFACE_SIDE_STYLE('',(#${this.add(`SURFACE_STYLE_FILL_AREA(#${fill})`)}))`);
      psa = this.add(`PRESENTATION_STYLE_ASSIGNMENT((#${this.add(`SURFACE_STYLE_USAGE(.BOTH.,#${side})`)}))`);
      this.styles.set(mat, psa);
    }
    this.styled.push(this.add(`STYLED_ITEM('color',(#${psa}),#${solid})`));
  }
  /** The colours, once every solid is written. */
  presentation(ctx: number) {
    if (this.styled.length) this.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${this.styled.map((s) => `#${s}`).join(',')}),#${ctx})`);
  }
  get data() {
    return this.out.join('\n');
  }
}

/** Box from min to max (Body3D coordinates, y down), in STEP coordinates (y up). */
function boxPrism(min: V3, max: V3): Prism {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return { o: [0, 0, z0], u: [1, 0, 0], v: [0, 1, 0], w: [0, 0, z1 - z0], outer: { k: 'poly', pts: [[x0, -y1], [x1, -y1], [x1, -y0], [x0, -y0]] }, holes: [] };
}

/** The solids of one package body, in its own coordinates (origin at its centre, y up, on z = 0). */
function bodySolids(body: Body3D, mark: boolean): { prism: Prism; mat: Mat; name: string }[] {
  const out: { prism: Prism; mat: Mat; name: string }[] = [];
  const ok = (a: number, b: number) => Math.abs(b - a) > 1e-4;
  for (const b of body.boxes) {
    if (ok(b.min[0], b.max[0]) && ok(b.min[1], b.max[1]) && ok(b.min[2], b.max[2])) out.push({ prism: boxPrism(b.min, b.max), mat: b.mat, name: b.mat });
  }
  for (const c of body.cylinders ?? []) {
    if (c.r <= 1e-4) continue;
    if (c.lying) out.push({ prism: { o: [c.x - c.lying / 2, -c.y, c.z0], u: [0, 1, 0], v: [0, 0, 1], w: [c.lying, 0, 0], outer: { k: 'circle', c: [0, 0], r: c.r }, holes: [] }, mat: c.mat, name: c.mat });
    else if (ok(c.z0, c.z1)) out.push({ prism: { o: [c.x, -c.y, c.z0], u: [1, 0, 0], v: [0, 1, 0], w: [0, 0, c.z1 - c.z0], outer: { k: 'circle', c: [0, 0], r: c.r }, holes: [] }, mat: c.mat, name: c.mat });
  }
  // BGA balls: a cylinder as wide as the ball, from the pad up to the body
  for (const b of body.balls) {
    const z0 = Math.max(0, b.c[2] - b.r);
    out.push({ prism: { o: [b.c[0], -b.c[1], z0], u: [1, 0, 0], v: [0, 1, 0], w: [0, 0, b.c[2] + b.r - z0], outer: { k: 'circle', c: [0, 0], r: b.r }, holes: [] }, mat: 'lead', name: 'ball' });
  }
  if (body.board) {
    const { w, h, t, holes } = body.board;
    out.push({
      prism: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], w: [0, 0, t], outer: { k: 'poly', pts: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] }, holes: holes.map((o) => ({ k: 'circle', c: [o.x, -o.y], r: o.d / 2 })) },
      mat: 'pcb',
      name: 'carrier board',
    });
  }
  if (mark && body.pin1.r > 1e-3) {
    // the pin-1 dot, a hair proud of the top
    const p = body.pin1;
    out.push({ prism: { o: [p.x, -p.y, p.z], u: [1, 0, 0], v: [0, 1, 0], w: [0, 0, 0.01], outer: { k: 'circle', c: [0, 0], r: p.r }, holes: [] }, mat: 'mark', name: 'pin 1' });
  }
  return out;
}

/**
 * The board solid: the outline with the cutouts and every drilled hole through it. A hole that
 * would cut the outline or another hole is left out (it would not make a valid solid).
 */
function boardPrism(b: BoardView): Prism {
  const H = b.outline.h;
  const flip = (poly: number[]): [number, number][] => {
    const pts: [number, number][] = [];
    for (let i = 0; i + 1 < poly.length; i += 2) pts.push([poly[i]!, H - poly[i + 1]!]);
    return pts;
  };
  const ring = boardPolygon(b);
  const holes: Loop[] = [];
  const taken: { x: number; y: number; r: number; poly?: number[] }[] = [];
  const clear = (x: number, y: number, r: number) =>
    insidePolygon(ring, x, y) > r + 0.01 && taken.every((t) => (t.poly ? -insidePolygon(t.poly, x, y) > r + 0.01 : Math.hypot(t.x - x, t.y - y) > t.r + r + 0.01));
  for (const c of b.cutouts ?? []) {
    if (c.shape === 'circle') {
      if (!clear(c.x, c.y, c.w / 2)) continue;
      holes.push({ k: 'circle', c: [c.x, H - c.y], r: c.w / 2 });
      taken.push({ x: c.x, y: c.y, r: c.w / 2 });
      continue;
    }
    const poly = cutoutPolygon(c);
    const pts = cleanPoly(flip(poly));
    if (!pts) continue;
    let fits = true;
    for (let i = 0; i + 1 < poly.length && fits; i += 2) fits = clear(poly[i]!, poly[i + 1]!, 0);
    if (!fits) continue;
    holes.push({ k: 'poly', pts });
    taken.push({ x: 0, y: 0, r: 0, poly });
  }
  for (const part of b.parts) {
    for (const p of part.pads) {
      if (p.drill && p.slot) {
        // a slotted hole: an oblong along its longer side
        const long = Math.max(p.slot.w, p.slot.h);
        const poly = cutoutPolygon({ id: '', shape: 'slot', x: p.x, y: p.y, w: long, h: p.drill, r: 0, angle: p.slot.h > p.slot.w ? 90 : 0 });
        const pts = cleanPoly(flip(poly));
        if (!pts || !clear(p.x, p.y, long / 2)) continue;
        holes.push({ k: 'poly', pts });
        taken.push({ x: 0, y: 0, r: 0, poly });
        continue;
      }
      if (!p.drill || !clear(p.x, p.y, p.drill / 2)) continue;
      holes.push({ k: 'circle', c: [p.x, H - p.y], r: p.drill / 2 });
      taken.push({ x: p.x, y: p.y, r: p.drill / 2 });
    }
  }
  const outer = cleanPoly(flip(ring)) ?? [[0, 0], [b.outline.w, 0], [b.outline.w, H], [0, H]];
  return { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], w: [0, 0, THICKNESS], outer: { k: 'poly', pts: outer }, holes };
}

export interface StepExport extends FabFile {
  /** Parts with a body in the file. */
  parts: number;
  /** Parts without a 3D body (refdes): not in the file. */
  without: string[];
}

/** The board and its parts as a STEP assembly (see the top of this file). */
export function boardStep(b: BoardView, project: string, date = new Date()): StepExport {
  const base = project.replace(/[^\w.-]+/g, '_') || 'board';
  const title = project || 'board';
  const s = new StepWriter();
  const app = s.add(`APPLICATION_CONTEXT('core data for automotive mechanical design processes')`);
  s.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${app})`);
  const pctx = s.add(`PRODUCT_CONTEXT('',#${app},'mechanical')`);
  const pdctx = s.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`);
  const mm = s.add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const rad = s.add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const sr = s.add('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const tol = s.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#${mm},'distance_accuracy_value','confusion accuracy')`);
  const ctx = s.add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${tol}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${mm},#${rad},#${sr}))REPRESENTATION_CONTEXT('','3D'))`);

  /** A product with its definition; returns the definition and its shape. */
  const product = (id: string, name: string, desc = '') => {
    const p = s.add(`PRODUCT(${str(id)},${str(name)},${str(desc)},(#${pctx}))`);
    s.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${p}))`);
    const pd = s.add(`PRODUCT_DEFINITION('design','',#${s.add(`PRODUCT_DEFINITION_FORMATION('','',#${p})`)},#${pdctx})`);
    return { pd, pds: s.add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`) };
  };
  /** A part product: its solids and their colours. */
  const leaf = (id: string, name: string, desc: string, solids: { prism: Prism; mat: Mat; name: string }[]) => {
    const { pd, pds } = product(id, name, desc);
    const origin = s.axis([0, 0, 0], [0, 0, 1], [1, 0, 0]);
    const ids = solids.map((x) => {
      const solid = s.prism(x.prism, x.name);
      s.colour(solid, x.mat);
      return solid;
    });
    const rep = s.add(`ADVANCED_BREP_SHAPE_REPRESENTATION(${str(name)},(#${origin},${ids.map((i) => `#${i}`).join(',')}),#${ctx})`);
    s.add(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);
    return { pd, rep, origin };
  };

  const top = product(title, title);
  const topOrigin = s.axis([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const placements: number[] = [topOrigin];
  const uses: { child: ReturnType<typeof leaf>; placement: number; id: string; name: string; desc: string }[] = [];

  const pcb = leaf(`${title} PCB`, 'PCB', '', [{ prism: boardPrism(b), mat: 'board', name: 'PCB' }]);
  const pcbAt = s.axis([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  placements.push(pcbAt);
  uses.push({ child: pcb, placement: pcbAt, id: 'PCB', name: 'PCB', desc: '' });

  const bodies = boardBodies(b);
  const without: string[] = [];
  let parts = 0;
  for (const part of b.parts) {
    const hole = part.componentId.startsWith('hole:');
    const body = bodies.get(part.componentId);
    const solids = body ? bodySolids(body, part.polarized) : [];
    if (!solids.length) {
      if (!hole) without.push(part.refdes);
      continue;
    }
    // its own product, named by the designator (CAD programs show product names)
    const child = leaf(part.refdes, part.refdes, [part.value, part.pkg].filter(Boolean).join(' '), solids);
    // on the copper, turned clockwise as seen from the top; on the bottom, flipped over about its y axis first
    const a = (-part.rot * Math.PI) / 180;
    const bottom = part.side === 'bottom';
    const xAxis: V3 = mul([Math.cos(a), Math.sin(a), 0], bottom ? -1 : 1);
    const at = s.axis([part.x, b.outline.h - part.y, bottom ? -CU : THICKNESS + CU], [0, 0, bottom ? -1 : 1], xAxis);
    placements.push(at);
    uses.push({ child, placement: at, id: part.refdes, name: part.refdes, desc: part.value });
    if (!hole) parts++;
  }

  const topRep = s.add(`SHAPE_REPRESENTATION(${str(title)},(${placements.map((p) => `#${p}`).join(',')}),#${ctx})`);
  s.add(`SHAPE_DEFINITION_REPRESENTATION(#${top.pds},#${topRep})`);
  for (const u of uses) {
    const nauo = s.add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE(${str(u.id)},${str(u.name)},${str(u.desc)},#${top.pd},#${u.child.pd},$)`);
    const idt = s.add(`ITEM_DEFINED_TRANSFORMATION('','',#${u.child.origin},#${u.placement})`);
    const rel = s.add(`(REPRESENTATION_RELATIONSHIP('','',#${u.child.rep},#${topRep})REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${idt})SHAPE_REPRESENTATION_RELATIONSHIP())`);
    s.add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${rel},#${s.add(`PRODUCT_DEFINITION_SHAPE('','',#${nauo})`)})`);
  }
  s.presentation(ctx);

  const name = `${base}.step`;
  const stamp = date.toISOString().slice(0, 19);
  const content = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION((${str(`${title}: board and parts`)}),'2;1');`,
    `FILE_NAME(${str(name)},'${stamp}',(''),(''),'4k7','4k7','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    s.data,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
  return { name, content, parts, without };
}
