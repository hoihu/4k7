/**
 * The geometry the enclosure script writes with (docs/design/enclosure.md §3): OpenSCAD's names and
 * ideas as JavaScript functions over Manifold. A solid is a Manifold, a 2D shape a CrossSection, so
 * their own methods work too (.translate, .subtract, .trimByPlane …).
 *
 * The functions forgive the order of their arguments and turn a number that is not one into an error
 * with its name: the agent writes these from memory of OpenSCAD, and it fixes what it can read.
 */
import type { CrossSection, Manifold, ManifoldToplevel, Vec2, Vec3 } from 'manifold-3d';
import type { TextOptions } from './text.ts';

export type Geometry = Manifold | CrossSection;
type Options = Record<string, unknown>;
/** A signed distance: negative inside, as usual. */
export type Sdf = (p: Vec3) => number;

/** Most triangles Minkowski takes on a solid that is not convex: about 10 ms each, and a render has 45 s. */
const MINKOWSKI_MAX_TRIANGLES = 3000;
/** Most grid points of an sdf(). */
const SDF_MAX_POINTS = 2e7;
/** What echo() keeps for the report. */
const LOG_LINES = 100;
const LOG_LINE = 400;

const isOptions = (x: unknown): x is Options => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * The engine's own failures are C++ exceptions, which reach JavaScript as a bare number with no stack.
 * Each function of the script's turns them into an error with its name, and so with the script's line.
 */
export function guarded<T extends object>(functions: T): T {
  const out = { ...functions } as Record<string, unknown>;
  for (const [name, f] of Object.entries(functions)) {
    if (typeof f !== 'function' || name === 'Manifold' || name === 'CrossSection') continue;
    out[name] = (...args: unknown[]) => {
      try {
        return (f as (...a: unknown[]) => unknown)(...args);
      } catch (e) {
        if (e instanceof Error) throw e;
        throw new Error(`${name}: the geometry engine could not do this`);
      }
    };
  }
  return out as T;
}

/** A value as an error message shows it. */
function show(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean' || v === undefined || v === null) return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'function') return 'a function';
  if (Array.isArray(v)) return `[${v.map(show).join(', ')}]`;
  return v && typeof (v as Manifold).getMesh === 'function' ? 'a solid' : v && typeof (v as CrossSection).toPolygons === 'function' ? 'a 2D shape' : 'an object';
}

function fail(fn: string, message: string): never {
  throw new Error(`${fn}: ${message}`);
}

function num(fn: string, what: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(fn, `${what} has to be a number, got ${show(v)}`);
  return v;
}

/** A vector of numbers; [x, y] and [x, y, z] take what is missing from `missing`. */
function vec3(fn: string, what: string, v: unknown, missing: number): Vec3 {
  if (!Array.isArray(v) || v.length < 2 || v.length > 3) fail(fn, `${what} has to be [x, y, z], got ${show(v)}`);
  return [num(fn, `${what}'s x`, v[0]), num(fn, `${what}'s y`, v[1]), v.length > 2 ? num(fn, `${what}'s z`, v[2]) : missing];
}

const radius = (o: Options, r: string, d: string) => (o[r] !== undefined ? (o[r] as number) : o[d] !== undefined ? (o[d] as number) / 2 : undefined);
const segments = (o: Options) => (o.fn ?? o.$fn) as number | undefined;

/** The functions and values a script finds as globals. */
export function createApi(w: ManifoldToplevel, makeText: (text: string, o: TextOptions) => [number, number][][], log: string[]) {
  const { Manifold, CrossSection, Mesh } = w;
  // round things by default: fine enough to print, plain enough to stay quick
  w.resetToCircularDefaults();
  w.setMinCircularAngle(5);
  w.setMinCircularEdgeLength(0.25);
  const isSolid = (x: unknown): x is Manifold => x instanceof Manifold;
  const isShape = (x: unknown): x is CrossSection => x instanceof CrossSection;
  const isGeometry = (x: unknown): x is Geometry => isSolid(x) || isShape(x);
  /** A solid of nothing. The other kind of nothing is as good as a shape: union() of no children does not know which it is. */
  const nothing = () => Manifold.union([]);
  const noShape = () => CrossSection.union([]);

  /** Holds geometry somewhere inside (or nothing at all), so it is children and not a vector. */
  const holdsGeometry = (x: unknown): boolean => isGeometry(x) || (Array.isArray(x) && (x.some(holdsGeometry) || x.every((e) => e === null || e === false || e === undefined)));

  /** A function among the children is a call left out, and would otherwise simply not be cut or joined. */
  function notCalled(fn: string, a: unknown) {
    if (typeof a === 'function') fail(fn, `${a.name ? `${a.name} is a function: call it, ${a.name}()` : 'a child is a function: call it'}, to get its solid`);
  }
  /** Not a child left out (that is null or false): what a function gives that forgot its return, and a cut that would silently not happen. */
  const noReturn = (fn: string) => fail(fn, 'a child is undefined: a function that forgot to return its solid? (null or false leave a child out)');

  /** The children (solids, shapes, nested lists, and false or null for one left out) and the other arguments, in any order; at least `wanted` of those, or an undefined among them is that one. */
  function split(fn: string, args: unknown[], wanted = 1): { kids: Geometry[]; rest: unknown[]; leftOut: boolean } {
    const kids: Geometry[] = [];
    const rest: unknown[] = [];
    let leftOut = false;
    let missing = false;
    const take = (a: unknown) => {
      if (a === undefined) noReturn(fn);
      if (a === null || a === false) leftOut = true;
      else if (Array.isArray(a)) {
        if (!a.length) leftOut = true;
        a.forEach(take);
      } else if (isGeometry(a)) kids.push(a);
      else {
        notCalled(fn, a);
        fail(fn, `a child has to be a solid or a 2D shape, got ${show(a)}`);
      }
    };
    for (const a of args) {
      if (a === undefined) missing = true;
      else if (a === null || a === false) leftOut = true;
      else {
        notCalled(fn, a);
        if (Array.isArray(a)) a.forEach((x) => notCalled(fn, x));
        if (holdsGeometry(a)) take(a);
        else rest.push(a);
      }
    }
    if (missing && rest.length >= wanted) noReturn(fn);
    return { kids, rest, leftOut };
  }

  const sameKind = (list: Geometry[]) => list.every(isSolid) || list.every(isShape);
  const mixed = (fn: string) => fail(fn, 'it got solids and 2D shapes together: extrude the shapes first (linear_extrude)');

  /** Several as their union; nothing of the other kind does not count. */
  function joined(fn: string, kids: Geometry[]): Geometry {
    const list = sameKind(kids) ? kids : kids.filter((k) => !k.isEmpty());
    if (!list.length) return nothing();
    if (list.every(isSolid)) return Manifold.union(list);
    return list.every(isShape) ? CrossSection.union(list) : mixed(fn);
  }

  /** The children as one. Only ones left out is nothing, and no child at all a mistake. */
  function one(fn: string, s: { kids: Geometry[]; leftOut: boolean }): Geometry {
    if (s.kids.length) return s.kids.length === 1 ? s.kids[0]! : joined(fn, s.kids);
    return s.leftOut ? nothing() : fail(fn, 'it needs something to work on: a solid or a 2D shape');
  }

  /** A lone list is the children themselves: intersection(list.map(…)). */
  const spread = (args: unknown[]) => (args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args);

  /** Each one child, for what treats its children apart: a list among them is the union of what is in it (difference([a, b], c) cuts c from both). Those left out are not there. */
  function groups(fn: string, args: unknown[]): Geometry[] {
    const out: Geometry[] = [];
    for (const a of args) {
      const { kids, rest } = split(fn, [a], 0);
      if (rest.length) fail(fn, `it takes solids or 2D shapes, and got ${show(rest[0])}`);
      if (kids.length) out.push(kids.length === 1 ? kids[0]! : joined(fn, kids));
    }
    return out;
  }

  const solidOf = (fn: string, g: unknown): Manifold => {
    notCalled(fn, g);
    if (isSolid(g)) return g;
    if (isShape(g)) return g.isEmpty() ? nothing() : fail(fn, 'it works on solids, and this is a 2D shape: extrude it first (linear_extrude)');
    return fail(fn, `it works on solids, and got ${show(g)}`);
  };
  const shapeOf = (fn: string, g: unknown): CrossSection => {
    notCalled(fn, g);
    if (isShape(g)) return g;
    if (isSolid(g)) return g.isEmpty() ? noShape() : fail(fn, 'it works on 2D shapes, and this is a solid');
    return fail(fn, `it works on 2D shapes, and got ${show(g)}`);
  };

  /* -------------------------------- solids -------------------------------- */

  // (a size of zero is nothing, a feature switched off: Manifold's own primitives make a flat solid of it, or an invalid one, which spoils all it is joined to)
  function cube(a: unknown, b?: unknown): Manifold {
    const o: Options = isOptions(a) ? a : { ...(isOptions(b) ? b : {}), size: a, ...(b === true ? { center: true } : {}) };
    const s = typeof o.size === 'number' ? ([num('cube', 'size', o.size), o.size, o.size] as Vec3) : vec3('cube', 'size', o.size, 1);
    if (s.some((v) => v < 0)) fail('cube', `its size cannot be negative, got ${show(s)}`);
    return s.includes(0) ? nothing() : Manifold.cube(s, o.center === true);
  }

  /** cylinder({ h, r | d | r1, r2 | d1, d2, center, fn }), cylinder(h, r), cylinder(h, r1, r2); r2 = 0 is a cone. */
  function cylinder(...args: unknown[]): Manifold {
    const opts = args.find(isOptions) ?? {};
    const nums = args.filter((x) => typeof x === 'number') as number[];
    const o: Options = { ...(nums[0] !== undefined ? { h: nums[0] } : {}), ...(nums[1] !== undefined ? { r1: nums[1], r2: nums[2] ?? nums[1] } : {}), ...(args.includes(true) ? { center: true } : {}), ...opts };
    const h = num('cylinder', 'h', o.h ?? o.height);
    const r1 = radius(o, 'r1', 'd1') ?? radius(o, 'r', 'd');
    const r2 = radius(o, 'r2', 'd2') ?? radius(o, 'r', 'd');
    if (r1 === undefined || r2 === undefined) fail('cylinder', `it needs a radius or diameter: r or d, or r1 and r2 (d1 and d2), got ${show(Object.keys(o))}`);
    num('cylinder', 'r1', r1);
    num('cylinder', 'r2', r2);
    if (h < 0 || r1 < 0 || r2 < 0) fail('cylinder', `h and the radii cannot be negative, got h ${h}, r1 ${r1}, r2 ${r2}`);
    const center = o.center === true;
    if (!h || (!r1 && !r2)) return nothing();
    return Manifold.cylinder(h, r1, r2, segments(o), center);
  }

  function sphere(a: unknown, b?: unknown): Manifold {
    const o: Options = { ...(isOptions(a) ? a : { r: a }), ...(isOptions(b) ? b : {}) };
    const r = num('sphere', 'r', radius(o, 'r', 'd'));
    if (r < 0) fail('sphere', `its radius cannot be negative, got ${r}`);
    return r ? Manifold.sphere(r, segments(o)) : nothing();
  }

  /** A solid from its points and faces (any winding, as long as it is the same all round). */
  function polyhedron(a: unknown, b?: unknown): Manifold {
    const o = (isOptions(a) ? a : { points: a, faces: b }) as { points: unknown; faces: unknown };
    if (!Array.isArray(o.points) || !Array.isArray(o.faces)) fail('polyhedron', 'it needs points ([[x, y, z], …]) and faces ([[0, 1, 2], …])');
    const points = (o.points as unknown[]).map((p, i) => vec3('polyhedron', `point ${i}`, p, 0));
    const tris: number[] = [];
    for (const f of o.faces as number[][]) {
      if (!Array.isArray(f) || f.length < 3) fail('polyhedron', `a face has to list at least 3 points, got ${show(f)}`);
      for (const i of f) if (!points[i]) fail('polyhedron', `face ${show(f)} names a point there is not`);
      for (let i = 1; i + 1 < f.length; i++) tris.push(f[0]!, f[i]!, f[i + 1]!);
    }
    const make = (order: number[]) => {
      const mesh = new Mesh({ numProp: 3, vertProperties: Float32Array.from(points.flat()), triVerts: Uint32Array.from(order) });
      mesh.merge();
      return new Manifold(mesh);
    };
    try {
      const s = make(tris);
      if (s.volume() >= 0) return s;
    } catch (e) {
      fail('polyhedron', `its faces do not close a solid: every edge has to be shared by two faces (${(e as Error).message})`);
    }
    // OpenSCAD lists faces the other way round
    const flipped: number[] = [];
    for (let i = 0; i < tris.length; i += 3) flipped.push(tris[i]!, tris[i + 2]!, tris[i + 1]!);
    return make(flipped);
  }

  /* ------------------------------- 2D shapes ------------------------------ */

  function square(a: unknown, b?: unknown): CrossSection {
    const o: Options = isOptions(a) ? a : { ...(isOptions(b) ? b : {}), size: a, ...(b === true ? { center: true } : {}) };
    const s = typeof o.size === 'number' ? ([num('square', 'size', o.size), o.size] as Vec2) : (vec3('square', 'size', o.size, 0).slice(0, 2) as Vec2);
    if (s.some((v) => v < 0)) fail('square', `its size cannot be negative, got ${show(s)}`);
    return s.includes(0) ? noShape() : CrossSection.square(s, o.center === true);
  }

  function circle(a: unknown, b?: unknown): CrossSection {
    const o: Options = { ...(isOptions(a) ? a : { r: a }), ...(isOptions(b) ? b : {}) };
    const r = num('circle', 'r', radius(o, 'r', 'd'));
    if (r < 0) fail('circle', `its radius cannot be negative, got ${r}`);
    return r ? CrossSection.circle(r, segments(o)) : noShape();
  }

  /** polygon(points), polygon(points, paths) or polygon([contour, contour]): filled even-odd, so a contour inside another is a hole. */
  function polygon(a: unknown, b?: unknown): CrossSection {
    const o = (isOptions(a) ? a : { points: a, paths: b }) as { points: unknown; paths?: unknown };
    if (!Array.isArray(o.points) || !o.points.length) fail('polygon', `it needs points [[x, y], …], got ${show(o.points)}`);
    const nested = Array.isArray((o.points as unknown[][])[0]?.[0]);
    const points = o.points as Vec2[];
    const contours: Vec2[][] = nested ? (o.points as Vec2[][]) : Array.isArray(o.paths) ? (o.paths as number[][]).map((path) => path.map((i) => points[i] ?? fail('polygon', `a path names point ${i}, and there are ${points.length}`))) : [points];
    for (const c of contours) for (const p of c) vec3('polygon', 'a point', p, 0);
    return CrossSection.ofPolygons(contours, 'EvenOdd');
  }

  /** Text, left on the baseline by default; size is the capitals' height. One font: Liberation Sans Bold. */
  function text(t: unknown, a?: unknown, defaults: Partial<TextOptions> = {}): CrossSection {
    if (typeof t !== 'string') fail('text', `it needs a string, got ${show(t)}`);
    const o: Options = typeof a === 'number' ? { size: a } : isOptions(a) ? a : {};
    const contours = makeText(t, {
      size: num('text', 'size', o.size ?? defaults.size ?? 5),
      halign: (o.halign ?? defaults.halign ?? 'left') as TextOptions['halign'],
      valign: (o.valign ?? defaults.valign ?? 'baseline') as TextOptions['valign'],
      spacing: num('text', 'spacing', o.spacing ?? 1),
    });
    return contours.length ? CrossSection.ofPolygons(contours, 'NonZero') : noShape();
  }

  /** offset(shape, { r }) rounds, offset(shape, { delta }) keeps corners sharp (chamfer: true cuts them); a number is r. */
  function offset(...args: unknown[]): CrossSection {
    const c = split('offset', args);
    const g = shapeOf('offset', one('offset', c));
    const rest = c.rest;
    const o: Options = typeof rest[0] === 'number' ? { r: rest[0] } : ((rest.find(isOptions) as Options) ?? {});
    if (o.r !== undefined) return g.offset(num('offset', 'r', o.r), 'Round', undefined, segments(o));
    return g.offset(num('offset', 'r or delta', o.delta), o.chamfer ? 'Square' : 'Miter');
  }

  /** The shadow of a solid on z = 0, or with { cut: true } its section there. */
  function projection(...args: unknown[]): CrossSection {
    const c = split('projection', args, 0);
    const g = solidOf('projection', one('projection', c));
    return (c.rest.find(isOptions) as Options | undefined)?.cut ? g.slice(0) : g.project();
  }

  /** linear_extrude(shape, { height, center, twist, scale, slices }), or just the height. Twist turns as OpenSCAD's: clockwise going up. */
  function linear_extrude(...args: unknown[]): Manifold {
    const c = split('linear_extrude', args);
    const g = shapeOf('linear_extrude', one('linear_extrude', c));
    const rest = c.rest;
    const o: Options = { ...(typeof rest[0] === 'number' ? { height: rest[0] } : {}), ...((rest.find(isOptions) as Options) ?? {}) };
    const h = num('linear_extrude', 'height', o.height ?? o.h);
    if (h <= 0) fail('linear_extrude', `its height has to be positive, got ${h}`);
    const twist = o.twist === undefined ? 0 : -num('linear_extrude', 'twist', o.twist);
    // always two numbers: Manifold reads a lone number as x alone, and a top of no depth is a wedge
    const top: Vec2 = typeof o.scale === 'number' ? [o.scale, o.scale] : o.scale === undefined ? [1, 1] : (vec3('linear_extrude', 'scale', o.scale, 1).slice(0, 2) as Vec2);
    return g.extrude(h, o.slices === undefined ? (twist ? Math.ceil(Math.abs(twist) / 5) : 0) : num('linear_extrude', 'slices', o.slices), twist, top, o.center === true);
  }

  /** Spins a shape in x ≥ 0 about the y axis, which becomes z. */
  function rotate_extrude(...args: unknown[]): Manifold {
    const c = split('rotate_extrude', args, 0);
    const g = shapeOf('rotate_extrude', one('rotate_extrude', c));
    const o = (c.rest.find(isOptions) as Options) ?? {};
    return g.revolve(segments(o), o.angle === undefined ? 360 : num('rotate_extrude', 'angle', o.angle));
  }

  /* ------------------------------ transforms ------------------------------ */

  function translate(...args: unknown[]): Geometry {
    const c = split('translate', args);
    const g = one('translate', c);
    const v = vec3('translate', 'the distance', c.rest[0], 0);
    return isSolid(g) ? g.translate(v) : g.translate([v[0], v[1]]);
  }

  /** rotate([x, y, z], c) in degrees, about x, then y, then z; rotate(a, c) about z; rotate(a, [x, y, z], c) about that axis. */
  function rotate(...args: unknown[]): Geometry {
    const c = split('rotate', args);
    const g = one('rotate', c);
    const angle = c.rest.find((x) => typeof x === 'number') as number | undefined;
    const v = c.rest.find(Array.isArray) as unknown[] | undefined;
    if (angle !== undefined && v) {
      const [x, y, z] = vec3('rotate', 'the axis', v, 0);
      const len = Math.hypot(x, y, z);
      if (!len) fail('rotate', 'the axis has no length');
      const [a, b, c] = [x / len, y / len, z / len];
      const rad = (num('rotate', 'the angle', angle) * Math.PI) / 180;
      const [s, k] = [Math.sin(rad), Math.cos(rad)];
      const t = 1 - k;
      return solidOf('rotate', g).transform([t * a * a + k, t * a * b + s * c, t * a * c - s * b, 0, t * a * b - s * c, t * b * b + k, t * b * c + s * a, 0, t * a * c + s * b, t * b * c - s * a, t * c * c + k, 0, 0, 0, 0, 1]);
    }
    const r: Vec3 = angle !== undefined ? [0, 0, num('rotate', 'the angle', angle)] : vec3('rotate', 'the angles', v, 0);
    if (isSolid(g)) return g.rotate(r);
    if (r[0] || r[1]) fail('rotate', `a 2D shape only turns about z, got ${show(r)}`);
    return g.rotate(r[2]);
  }

  function scale(...args: unknown[]): Geometry {
    const c = split('scale', args);
    const g = one('scale', c);
    const v = c.rest[0];
    const s: Vec3 = typeof v === 'number' ? [num('scale', 'the factor', v), v, v] : vec3('scale', 'the factors', v, 1);
    return isSolid(g) ? g.scale(s) : g.scale([s[0], s[1]]);
  }

  /** Mirrors across the plane through the origin that the vector is the normal of. */
  function mirror(...args: unknown[]): Geometry {
    const c = split('mirror', args);
    const g = one('mirror', c);
    const v = vec3('mirror', 'the normal', c.rest[0], 0);
    return isSolid(g) ? g.mirror(v) : g.mirror([v[0], v[1]]);
  }

  /** multmatrix(m, c): m is 3 or 4 rows of 4 (OpenSCAD's), or Manifold's 16 numbers by column. */
  function multmatrix(...args: unknown[]): Manifold {
    const c = split('multmatrix', args);
    const g = solidOf('multmatrix', one('multmatrix', c));
    const m = c.rest[0] as number[][] | number[];
    if (Array.isArray(m) && m.length === 16 && m.every((x) => typeof x === 'number')) return g.transform(m as never);
    if (!Array.isArray(m) || m.length < 3 || !(m as number[][]).every((row) => Array.isArray(row) && row.length === 4)) fail('multmatrix', `it needs rows of 4 numbers, got ${show(m)}`);
    const r = m as number[][];
    return g.transform([r[0]![0]!, r[1]![0]!, r[2]![0]!, 0, r[0]![1]!, r[1]![1]!, r[2]![1]!, 0, r[0]![2]!, r[1]![2]!, r[2]![2]!, 0, r[0]![3]!, r[1]![3]!, r[2]![3]!, 1]);
  }

  /** Scales to these sizes; 0 keeps that axis. */
  function resize(...args: unknown[]): Manifold {
    const c = split('resize', args);
    const g = solidOf('resize', one('resize', c));
    const v = vec3('resize', 'the size', c.rest[0], 0);
    if (g.isEmpty()) return g;
    const b = g.boundingBox();
    return g.scale(v.map((x, i) => (x ? x / (b.max[i]! - b.min[i]!) : 1)) as Vec3);
  }

  /** The script may colour things as OpenSCAD does; pieces take their colour from the view (and inlays). */
  function color(...args: unknown[]): Geometry {
    return one('color', split('color', args, 0));
  }

  /* -------------------------------- booleans ------------------------------- */

  /** A list among the children is the union of what is in it, so difference([a, b], c) cuts c from both. */
  function union(...args: unknown[]): Geometry {
    const kids = groups('union', spread(args));
    return kids.length ? (kids.length === 1 ? kids[0]! : joined('union', kids)) : nothing();
  }

  /** The first child is what is cut from: if that is left out, there is nothing. */
  function difference(...args: unknown[]): Geometry {
    if (!args.length) fail('difference', 'it needs something to cut from');
    const children = spread(args);
    const [base] = groups('difference', children.slice(0, 1));
    const cuts = groups('difference', children.slice(1));
    if (!base) return nothing();
    if (!cuts.length) return base;
    const list = sameKind([base, ...cuts]) ? cuts : cuts.filter((k) => !k.isEmpty());
    if (!list.length) return base;
    if (isSolid(base) && list.every(isSolid)) return Manifold.difference([base, ...list]);
    if (isShape(base) && list.every(isShape)) return CrossSection.difference([base, ...list]);
    return base.isEmpty() ? base : mixed('difference');
  }

  function intersection(...args: unknown[]): Geometry {
    if (!args.length) fail('intersection', 'it needs something to intersect');
    const kids = groups('intersection', spread(args));
    if (!kids.length) return nothing();
    if (kids.length === 1) return kids[0]!;
    if (kids.every(isSolid)) return Manifold.intersection(kids);
    if (kids.every(isShape)) return CrossSection.intersection(kids);
    return kids.some((k) => k.isEmpty()) ? nothing() : mixed('intersection');
  }

  /** The convex hull of solids, of shapes, or of a list of points. */
  function hull(...args: unknown[]): Geometry {
    const { kids, rest, leftOut } = split('hull', args, 0);
    const list = kids.filter((k) => !k.isEmpty());
    if (list.length) return list.every(isSolid) ? Manifold.hull(list) : list.every(isShape) ? CrossSection.hull(list) : mixed('hull');
    if (kids.length || (leftOut && !rest.length)) return nothing();
    const points = rest[0] as number[][] | undefined;
    if (!Array.isArray(points) || !points.length) fail('hull', 'it needs solids, shapes or points');
    return points[0]!.length === 2 ? CrossSection.hull([points as Vec2[]]) : Manifold.hull(points.map((p) => vec3('hull', 'a point', p, 0)));
  }

  /** Whether Minkowski with this solid is quick: it is, for a convex one, however fine. */
  function checkMinkowski(fn: string, g: Manifold) {
    const tris = g.numTri();
    if (tris <= MINKOWSKI_MAX_TRIANGLES) return;
    if (Math.abs(g.hull().volume() - g.volume()) <= 1e-6 * Math.abs(g.volume())) return;
    fail(fn, `this solid has ${tris} triangles, and on a solid that is not convex it takes about 10 ms for each (at most ${MINKOWSKI_MAX_TRIANGLES}). Round the plain outer shape first (round_extrude, round_box) and cut the cavity and openings after`);
  }

  function minkowski(...args: unknown[]): Manifold {
    const kids = groups('minkowski', spread(args));
    if (kids.length < 2) fail('minkowski', 'it needs two solids');
    return kids.map((k) => solidOf('minkowski', k)).reduce((a, b) => {
      if (a.isEmpty() || b.isEmpty()) return nothing();
      checkMinkowski('minkowski', a);
      return a.minkowskiSum(b);
    });
  }

  /* -------------------------------- rounding ------------------------------- */

  /** round_box([x, y, z], r, { center, fn }): a box with every edge rounded, from the origin up unless centred. */
  function round_box(size: unknown, a?: unknown, b?: unknown): Manifold {
    const o: Options = { ...(typeof a === 'number' ? { r: a } : isOptions(a) ? a : {}), ...(isOptions(b) ? b : {}) };
    const s = typeof size === 'number' ? ([size, size, size] as Vec3) : vec3('round_box', 'size', size, 1);
    const r = num('round_box', 'r', o.r);
    const half = Math.min(...s) / 2;
    if (r <= 0 || r > half) fail('round_box', `r has to be between 0 and half its smallest side (${half}), got ${r}`);
    const ball = Manifold.sphere(r, segments(o));
    const corners: Manifold[] = [];
    for (const x of [r, s[0] - r]) for (const y of [r, s[1] - r]) for (const z of [r, s[2] - r]) corners.push(ball.translate([x, y, z]));
    const box = Manifold.hull(corners);
    return o.center === true ? box.translate([-s[0] / 2, -s[1] / 2, -s[2] / 2]) : box;
  }

  /** round_rect([x, y], r, { center }): a rectangle with rounded corners. */
  function round_rect(size: unknown, a?: unknown, b?: unknown): CrossSection {
    const o: Options = { ...(typeof a === 'number' ? { r: a } : isOptions(a) ? a : {}), ...(isOptions(b) ? b : {}) };
    const s = typeof size === 'number' ? ([size, size] as Vec2) : (vec3('round_rect', 'size', size, 0).slice(0, 2) as Vec2);
    const r = num('round_rect', 'r', o.r);
    const half = Math.min(...s) / 2;
    if (r <= 0 || r > half) fail('round_rect', `r has to be between 0 and half its smallest side (${half}), got ${r}`);
    const rect = CrossSection.square([s[0] - 2 * r, s[1] - 2 * r], true).offset(r, 'Round', undefined, segments(o));
    return o.center === true ? rect : rect.translate([s[0] / 2, s[1] / 2]);
  }

  /**
   * round_extrude(shape, { height, r, top, bottom, fn }): any outline extruded from z = 0 with its
   * edges rounded by r: the top and bottom rims (each can be switched off) and the outline's outer
   * corners. The way to a round box: quick (a convex outline at once, any other in a second or two).
   */
  function round_extrude(...args: unknown[]): Manifold {
    const c = split('round_extrude', args);
    const g = shapeOf('round_extrude', one('round_extrude', c));
    const rest = c.rest;
    const o: Options = { ...(typeof rest[0] === 'number' ? { height: rest[0] } : {}), ...((rest.find(isOptions) as Options) ?? {}) };
    const h = num('round_extrude', 'height', o.height ?? o.h);
    const r = num('round_extrude', 'r', o.r);
    if (g.isEmpty()) return nothing();
    const top = o.top !== false;
    const bottom = o.bottom !== false;
    if (r <= 0) fail('round_extrude', `r has to be positive, got ${r}`);
    const core = h - (top ? r : 0) - (bottom ? r : 0);
    if (core <= 0) fail('round_extrude', `height ${h} is too low for r ${r} on ${top && bottom ? 'both rims' : 'its rim'}`);
    const inner = g.offset(-r, 'Round');
    if (inner.isEmpty()) fail('round_extrude', `r ${r} is more than the outline can take: it is narrower than ${2 * r} mm`);
    if (!top && !bottom) return inner.offset(r, 'Round', undefined, segments(o)).extrude(h);
    const body = inner.extrude(core).translate([0, 0, bottom ? r : 0]).minkowskiSum(Manifold.sphere(r, segments(o) ?? 24));
    if (!bottom) return body.trimByPlane([0, 0, 1], 0);
    return top ? body : body.trimByPlane([0, 0, -1], -h);
  }

  /** Rounds what stands out (the outer edges): takes it in by r and out again. Slow on anything but a plain solid: see round_extrude. */
  function rounded(s: unknown, a?: unknown, b?: unknown): Manifold {
    const g = solidOf('rounded', s);
    const o: Options = { ...(typeof a === 'number' ? { r: a } : isOptions(a) ? a : {}), ...(isOptions(b) ? b : {}) };
    const ball = Manifold.sphere(num('rounded', 'r', o.r), segments(o) ?? 12);
    if (g.isEmpty()) return g;
    checkMinkowski('rounded', g);
    return g.minkowskiDifference(ball).minkowskiSum(ball);
  }

  /** Fills what goes in (the inner edges, where a post meets a floor): takes it out by r and in again. Slow on anything but a plain solid. */
  function filleted(s: unknown, a?: unknown, b?: unknown): Manifold {
    const g = solidOf('filleted', s);
    const o: Options = { ...(typeof a === 'number' ? { r: a } : isOptions(a) ? a : {}), ...(isOptions(b) ? b : {}) };
    const ball = Manifold.sphere(num('filleted', 'r', o.r), segments(o) ?? 12);
    if (g.isEmpty()) return g;
    checkMinkowski('filleted', g);
    return g.minkowskiSum(ball).minkowskiDifference(ball);
  }

  /* ----------------------------- lights, lenses ---------------------------- */

  /** A spherical cap standing on z = 0, d across and h high. */
  function dome(d: unknown, h: unknown, o: Options = {}): Manifold {
    const dia = num('dome', 'd', d);
    const high = num('dome', 'h', h);
    if (dia <= 0 || high <= 0) fail('dome', `d and h have to be positive, got ${dia}, ${high}`);
    const r = (dia * dia) / 4 / (2 * high) + high / 2;
    return Manifold.sphere(r, segments(o) ?? 96).translate([0, 0, high - r]).trimByPlane([0, 0, 1], 0);
  }

  /**
   * lens(d, { r, r2, edge }): a lens d across on the z axis: a cylindrical edge from z = 0 up (edge
   * mm), the surface of radius r on it, and with r2 one under it as well. Flat without.
   */
  function lens(d: unknown, a: unknown, b?: unknown): Manifold {
    const dia = num('lens', 'd', d);
    const o: Options = { ...(typeof a === 'number' ? { r: a } : isOptions(a) ? a : {}), ...(isOptions(b) ? b : {}) };
    if (o.r === undefined && o.r2 === undefined) fail('lens', 'it needs r (the upper surface\'s radius), r2 (the lower\'s), or both');
    const edge = num('lens', 'edge', o.edge ?? 0.5);
    const sag = (r: number) => {
      if (r < dia / 2) fail('lens', `a surface's radius cannot be under half its diameter (${dia / 2}), got ${r}`);
      return r - Math.sqrt(r * r - (dia * dia) / 4);
    };
    const parts: Manifold[] = edge > 0 ? [Manifold.cylinder(edge, dia / 2, dia / 2, segments(o) ?? 96)] : [];
    if (o.r !== undefined) parts.push(dome(dia, sag(num('lens', 'r', o.r)), o).translate([0, 0, edge]));
    if (o.r2 !== undefined) parts.push(dome(dia, sag(num('lens', 'r2', o.r2)), o).mirror([0, 0, 1]));
    return Manifold.union(parts);
  }

  /* --------------------------- smooth forms (SDF) -------------------------- */

  const sd_sphere = (r: number, at: Vec3 = [0, 0, 0]): Sdf => (p) => Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]) - r;

  /** A box centred on `at`; r rounds its edges inside its size. */
  const sd_box = (size: Vec3, r = 0, at: Vec3 = [0, 0, 0]): Sdf => {
    const b = size.map((v) => v / 2 - r);
    return (p) => {
      const q = [Math.abs(p[0] - at[0]) - b[0]!, Math.abs(p[1] - at[1]) - b[1]!, Math.abs(p[2] - at[2]) - b[2]!];
      return Math.hypot(Math.max(q[0]!, 0), Math.max(q[1]!, 0), Math.max(q[2]!, 0)) + Math.min(Math.max(q[0]!, q[1]!, q[2]!), 0) - r;
    };
  };

  /** Upright, centred on `at`. */
  const sd_cylinder = (h: number, r: number, at: Vec3 = [0, 0, 0]): Sdf => (p) => {
    const a = Math.hypot(p[0] - at[0], p[1] - at[1]) - r;
    const b = Math.abs(p[2] - at[2]) - h / 2;
    return Math.min(Math.max(a, b), 0) + Math.hypot(Math.max(a, 0), Math.max(b, 0));
  };

  const smoothMin = (a: number, b: number, k: number) => {
    const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (b - a)) / k));
    return b * (1 - h) + a * h - k * h * (1 - h);
  };

  /** Forms that melt into each other over about k mm. */
  const smooth_union = (k: number, ...f: Sdf[]): Sdf => (p) => f.map((g) => g(p)).reduce((a, b) => smoothMin(a, b, k));
  const smooth_intersection = (k: number, ...f: Sdf[]): Sdf => (p) => -f.map((g) => -g(p)).reduce((a, b) => smoothMin(a, b, k));
  const smooth_difference = (k: number, first: Sdf, ...rest: Sdf[]): Sdf => (p) => -rest.map((g) => g(p)).reduce((a, b) => smoothMin(a, -b, k), -first(p));

  /** sdf(f, { min, max, edge }): the solid where f(p) < 0, meshed in that box, its triangles about edge mm. */
  function sdf(f: unknown, o: Options): Manifold {
    if (typeof f !== 'function') fail('sdf', `it needs a function of [x, y, z], got ${show(f)}`);
    const min = vec3('sdf', 'min', o?.min, 0);
    const max = vec3('sdf', 'max', o?.max, 0);
    const edge = num('sdf', 'edge', o?.edge ?? 1);
    if (edge <= 0) fail('sdf', `edge has to be positive, got ${edge}`);
    const points = min.reduce((n, v, i) => n * Math.ceil((max[i]! - v) / edge), 1);
    if (points > SDF_MAX_POINTS) fail('sdf', `edge ${edge} is too fine for this box: ${Math.round(points / 1e6)} million points, at most ${SDF_MAX_POINTS / 1e6} million`);
    const g = f as Sdf;
    return Manifold.levelSet((p) => -g(p), { min, max }, edge);
  }

  /* --------------------------------- angles --------------------------------- */

  // in degrees, as OpenSCAD's (Math's are in radians), and exact where they are round: cos(90) is 0
  const RAD = Math.PI / 180;
  const exact = (deg: number, fn: (x: number) => number) => (deg % 90 === 0 ? Math.round(fn(deg * RAD)) : fn(deg * RAD));
  const sin = (deg: number) => exact(deg, Math.sin);
  const cos = (deg: number) => exact(deg, Math.cos);
  const tan = (deg: number) => (deg % 180 === 0 ? 0 : Math.tan(deg * RAD));
  const asin = (x: number) => Math.asin(x) / RAD;
  const acos = (x: number) => Math.acos(x) / RAD;
  const atan = (x: number) => Math.atan(x) / RAD;
  const atan2 = (y: number, x: number) => Math.atan2(y, x) / RAD;

  /* -------------------------------- measures ------------------------------- */

  function bbox(s: unknown) {
    const b = isSolid(s) ? s.boundingBox() : isShape(s) ? { min: [s.bounds().min[0], s.bounds().min[1], 0], max: [s.bounds().max[0], s.bounds().max[1], 0] } : fail('bbox', `it needs a solid or a 2D shape, got ${show(s)}`);
    return { min: [...b.min] as Vec3, max: [...b.max] as Vec3, size: b.max.map((v, i) => v - b.min[i]!) as Vec3, center: b.max.map((v, i) => (v + b.min[i]!) / 2) as Vec3 };
  }

  const volume = (s: unknown) => solidOf('volume', s).volume();

  /** How far apart two solids are (0: they touch or meet), looking at most `within` mm. */
  const distance = (a: unknown, b: unknown, within = 20) => solidOf('distance', a).minGap(solidOf('distance', b), num('distance', 'within', within));

  /** How many segments round things get from here on: at the top for the whole script, in a piece until it ends; set_fn(0) goes back to the default. */
  let fn_now = 0;
  function set_fn(n: unknown) {
    fn_now = num('set_fn', 'n', n);
    w.setCircularSegments(fn_now);
  }

  /** Lines for the report: to measure something from the script and read it (echo(bbox(lid))). */
  function echo(...args: unknown[]) {
    if (log.length > LOG_LINES) return;
    if (log.length === LOG_LINES) {
      log.push(`(echo stops here, after ${LOG_LINES} lines)`);
      return;
    }
    log.push(args.map((a) => (typeof a === 'string' ? a : isGeometry(a) ? show(a) : JSON.stringify(a, (_k, v: unknown) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)))).join(' ').slice(0, LOG_LINE));
  }

  return guarded({
    Manifold,
    CrossSection,
    cube,
    cylinder,
    sphere,
    polyhedron,
    square,
    circle,
    polygon,
    text: (t: unknown, o?: unknown) => text(t, o),
    /** For the board's label(): text, centred. */
    centeredText: (t: unknown, o?: unknown) => text(t, o, { halign: 'center', valign: 'center' }),
    offset,
    projection,
    linear_extrude,
    rotate_extrude,
    translate,
    rotate,
    scale,
    mirror,
    multmatrix,
    resize,
    color,
    union,
    difference,
    intersection,
    hull,
    minkowski,
    round_box,
    round_rect,
    round_extrude,
    rounded,
    filleted,
    dome,
    lens,
    sdf,
    sd_sphere,
    sd_box,
    sd_cylinder,
    smooth_union,
    smooth_difference,
    smooth_intersection,
    sin,
    cos,
    tan,
    asin,
    acos,
    atan,
    atan2,
    bbox,
    volume,
    distance,
    set_fn,
    echo,
    /** For the render, which starts each piece as the script's top left things. */
    fnNow: () => fn_now,
  });
}

export type CsgApi = ReturnType<typeof createApi>;
