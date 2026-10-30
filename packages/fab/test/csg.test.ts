import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold } from 'manifold-3d';
import { createApi, guarded, type CsgApi } from '../src/csg/api.ts';
import { textMaker } from '../src/csg/text.ts';
import { csg } from './csg-setup.ts';

let A: CsgApi;
let log: string[];

beforeAll(async () => {
  const engine = await csg();
  log = [];
  A = createApi(engine.w, textMaker(engine.font), log);
});

const size = (s: unknown) => A.bbox(s).size.map((v) => Math.round(v * 1000) / 1000);
const solid = (s: unknown) => s as Manifold;

describe("the script's solids and shapes", () => {
  it('take OpenSCAD\'s arguments in JavaScript, in any order', () => {
    expect(size(A.cube(2))).toEqual([2, 2, 2]);
    expect(A.bbox(A.cube([1, 2, 3], true)).min).toEqual([-0.5, -1, -1.5]);
    expect(A.bbox(A.cube({ size: [1, 2, 3], center: true })).max).toEqual([0.5, 1, 1.5]);
    expect(size(A.cylinder({ h: 5, d: 4 }))).toEqual([4, 4, 5]);
    expect(size(A.cylinder(5, 2))).toEqual([4, 4, 5]);
    expect(size(A.cylinder(5, 3, 1))).toEqual([6, 6, 5]);
    // standing on its point
    const cone = A.cylinder({ h: 5, r1: 0, r2: 3, fn: 64 });
    expect(A.bbox(cone).min[2]).toBeCloseTo(0, 6);
    expect(cone.volume()).toBeCloseTo((Math.PI * 9 * 5) / 3, 0);
    // the children first or last, lists, and null for one left out
    for (const moved of [A.translate([1, 2, 3], A.cube(1)), A.translate(A.cube(1), [1, 2, 3]), A.translate([1, 2, 3], [A.cube(1), null])]) expect(A.bbox(moved).min).toEqual([1, 2, 3]);
    expect(size(A.linear_extrude(A.square(2), 3))).toEqual([2, 2, 3]);
    expect(size(A.linear_extrude({ height: 3 }, A.square(2)))).toEqual([2, 2, 3]);
    expect(solid(A.difference(A.cube(3), [A.cube(1), false, [A.translate([2, 2, 2], A.cube(1))]])).volume()).toBeCloseTo(25, 6);
    expect(solid(A.union()).isEmpty()).toBe(true);
    // a size of nothing is nothing, and does not spoil what it is joined to
    for (const none of [A.cube(0), A.cube([1, 0, 1]), A.cylinder({ h: 0, r: 1 }), A.cylinder({ h: 1, r: 0 }), A.sphere(0)]) {
      expect(none.isEmpty()).toBe(true);
      const joined = solid(A.union(A.cube(1), none));
      expect(joined.status()).toBe('NoError');
      expect(joined.volume()).toBe(1);
    }
    expect(A.square(0).isEmpty()).toBe(true);
    expect(A.circle(0).isEmpty()).toBe(true);
    // a transform leaves the original where it was
    const c = A.cube(1);
    A.translate([5, 5, 5], c);
    expect(A.bbox(c).min).toEqual([0, 0, 0]);
  });

  it('extrude what they are given, whole: a scale of one number is both axes', () => {
    // (Manifold reads a lone number as x alone, and makes a wedge)
    expect(A.linear_extrude(A.square(10), { height: 10 }).volume()).toBeCloseTo(1000, 6);
    expect(size(A.linear_extrude(A.square(2, true), { height: 2, scale: 3 }))).toEqual([6, 6, 2]);
    expect(size(A.linear_extrude(A.square(2, true), { height: 2, scale: [3, 0.5] }))).toEqual([6, 2, 2]);
    // twist turns clockwise going up, as OpenSCAD's: from +x to −y
    const twisted = A.bbox(A.linear_extrude(A.translate([2, 0], A.square([1, 0.5])), { height: 5, twist: 90, slices: 20 }));
    expect(twisted.min[1]).toBeCloseTo(-3, 3);
    expect(twisted.max[1]).toBeCloseTo(0.5, 3);
  });

  it('keep corners sharp or round them, as asked', () => {
    expect(A.offset(A.square(10), { delta: 1 }).area()).toBeCloseTo(144, 6);
    expect(A.offset(A.square(10), { r: 1, fn: 128 }).area()).toBeCloseTo(100 + 40 + Math.PI, 1);
    expect(A.offset(A.square(10), 1).area()).toBeCloseTo(100 + 40 + Math.PI, 0);
    // a contour inside another is a hole, whichever way round it runs
    expect(A.polygon([[[0, 0], [10, 0], [10, 10], [0, 10]], [[2, 2], [8, 2], [8, 8], [2, 8]]]).area()).toBeCloseTo(64, 6);
    expect(A.polygon([[10, 10], [10, 0], [0, 0]]).area()).toBeCloseTo(50, 6);
    expect(size(A.rotate_extrude(A.translate([3, 0], A.square([1, 2]))))).toEqual([8, 8, 2]);
    expect(A.polyhedron([[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2]], [[0, 1, 2], [0, 3, 1], [1, 3, 2], [0, 2, 3]]).volume()).toBeCloseTo(8 / 6, 6);
  });

  it('turn about the axes in OpenSCAD\'s order, or about any axis', () => {
    expect(A.bbox(A.rotate([90, 0, 0], A.cube([1, 2, 3]))).size[1]).toBeCloseTo(3, 6);
    expect(A.bbox(A.rotate(90, A.cube([1, 2, 3]))).size[0]).toBeCloseTo(2, 6);
    expect(A.bbox(A.rotate(90, [0, 0, 1], A.cube([1, 2, 3]))).size[0]).toBeCloseTo(2, 6);
    expect(A.bbox(A.rotate(90, A.square([1, 2]))).size[0]).toBeCloseTo(2, 6);
    expect(() => A.rotate([90, 0, 0], A.square(1))).toThrow('a 2D shape only turns about z');
    expect(solid(A.mirror([1, 0, 0], A.cube([1, 2, 3]))).volume()).toBeCloseTo(6, 6);
    expect(A.bbox(A.multmatrix([[1, 0, 0, 5], [0, 1, 0, 0], [0, 0, 1, 0]], A.cube(1))).min[0]).toBe(5);
    expect(size(A.resize([4, 0, 6], A.cube([1, 2, 3])))).toEqual([4, 2, 6]);
  });

  it('say what is wrong in words the script can act on', () => {
    // a value that went missing is not a default size
    expect(() => A.cube(undefined)).toThrow('cube: size has to be [x, y, z], got undefined');
    expect(() => A.cube({ size: 'x' })).toThrow('cube: size has to be [x, y, z], got "x"');
    expect(() => A.sphere(undefined)).toThrow('sphere: r has to be a number, got undefined');
    expect(() => A.circle(undefined)).toThrow('circle: r has to be a number, got undefined');
    expect(() => A.square(undefined)).toThrow('square: size has to be [x, y, z], got undefined');
    expect(() => A.cube([1, 2, -3])).toThrow('its size cannot be negative');
    expect(() => A.translate([1, NaN, 3], A.cube(1))).toThrow("translate: the distance's y has to be a number, got NaN");
    expect(() => A.translate([1, 2, 3])).toThrow('translate: it needs something to work on');
    expect(() => A.cylinder({ h: 3 })).toThrow('cylinder: it needs a radius or diameter');
    expect(() => A.cylinder({ d: 3 })).toThrow('cylinder: h has to be a number, got undefined');
    expect(() => A.linear_extrude(A.square(1), { height: -2 })).toThrow('its height has to be positive, got -2');
    expect(() => A.linear_extrude(A.cube(1), 2)).toThrow('it works on 2D shapes, and this is a solid');
    expect(() => A.union(A.cube(1), A.square(1))).toThrow('extrude the shapes first');
    expect(() => A.difference(A.cube(1), A.square(1))).toThrow('extrude the shapes first');
    expect(() => A.minkowski(A.cube(1))).toThrow('it needs two solids');
    // a call left out would otherwise just not be cut
    const cavity = () => A.cube(1);
    expect(() => A.difference(A.cube(2), cavity)).toThrow('cavity is a function: call it, cavity()');
    expect(() => A.difference(A.cube(2), [cavity])).toThrow('cavity is a function: call it, cavity()');
    expect(() => A.union(A.cube(2), [A.cube(1), cavity])).toThrow('cavity is a function: call it, cavity()');
    expect(() => A.translate([1, 2, 3], cavity)).toThrow('cavity is a function');
    expect(() => A.linear_extrude(cavity, 2)).toThrow('cavity is a function');
    expect(() => A.rounded(cavity, 1)).toThrow('cavity is a function');
    // nor is anything else that is not geometry a child
    expect(() => A.difference(A.cube(2), 5)).toThrow('difference: it takes solids or 2D shapes, and got 5');
    expect(() => A.difference(A.cube(2), [A.cube(1), 5])).toThrow('a child has to be a solid or a 2D shape, got 5');
    expect(() => A.rounded(undefined, 1)).toThrow('rounded: it works on solids, and got undefined');
  });
});

describe('children', () => {
  const a = () => A.cube(2);
  const b = () => solid(A.translate([1, 0, 0], A.cube(2)));
  const c = () => solid(A.translate([0, 1, 0], A.cube(2)));
  const vol = (s: unknown) => solid(s).volume();

  it('a list is one child, the union of what is in it, everywhere', () => {
    // 8 + 4 − the 4 of c that overlaps them
    expect(vol(A.difference([a(), b()], c()))).toBeCloseTo(a().add(b()).subtract(c()).volume(), 6);
    expect(vol(A.difference([a(), b()], c()))).toBeCloseTo(8, 6);
    expect(vol(A.difference(a(), [b(), c()]))).toBeCloseTo(a().subtract(b()).subtract(c()).volume(), 6);
    expect(vol(A.intersection(a(), [b(), c()]))).toBeCloseTo(a().intersect(b().add(c())).volume(), 6);
    expect(vol(A.intersection(a(), [b(), c()]))).toBeCloseTo(6, 6);
    expect(vol(A.union([a(), [b()]], c()))).toBeCloseTo(a().add(b()).add(c()).volume(), 6);
    // a lone list is the children themselves, as from a map()
    expect(vol(A.intersection([a(), b()]))).toBeCloseTo(a().intersect(b()).volume(), 6);
    expect(vol(A.intersection([a(), b(), c()].map((x) => x)))).toBeCloseTo(a().intersect(b()).intersect(c()).volume(), 6);
    expect(vol(A.difference([a(), b(), c()]))).toBeCloseTo(a().subtract(b()).subtract(c()).volume(), 6);
    expect(vol(A.union([a(), b()]))).toBeCloseTo(a().add(b()).volume(), 6);
    expect(A.bbox(A.minkowski([A.cube(1), A.cube(1)])).size).toEqual([2, 2, 2]);
    expect(vol(A.intersection([a(), [b(), c()]]))).toBeCloseTo(a().intersect(b().add(c())).volume(), 6);
    expect(solid(A.difference([])).isEmpty()).toBe(true);
    expect(solid(A.intersection([])).isEmpty()).toBe(true);
    expect(A.bbox(A.minkowski([A.cube(1), A.translate([3, 0, 0], A.cube(1))], A.cube(1))).size).toEqual([5, 2, 2]);
    expect(vol(A.translate([1, 1, 1], [a(), b()]))).toBeCloseTo(12, 6);
    expect(vol(A.hull([A.cube(1)], A.translate([3, 0, 0], A.cube(1))))).toBeCloseTo(4, 6);
    expect(A.linear_extrude([A.square(1), A.translate([2, 0], A.square(1))], 1).volume()).toBeCloseTo(2, 6);
  });

  it('null or false leaves one out; only those give nothing, of either kind', () => {
    expect(vol(A.difference(a(), null, false, [null]))).toBe(8);
    expect(vol(A.union(a(), null))).toBe(8);
    expect(vol(A.intersection(a(), false))).toBe(8);
    expect(solid(A.translate([1, 2, 3], null)).isEmpty()).toBe(true);
    expect(solid(A.rotate(45, false)).isEmpty()).toBe(true);
    expect(solid(A.translate([1, 2, 3], [])).isEmpty()).toBe(true);
    expect(A.linear_extrude(null, 2).isEmpty()).toBe(true);
    expect(A.offset(null, { r: 1 }).isEmpty()).toBe(true);
    expect(A.round_extrude(null, { height: 3, r: 1 }).isEmpty()).toBe(true);
    expect(solid(A.union(null, false)).isEmpty()).toBe(true);
    // the first child of a difference is what is cut from: there is nothing to cut, and not the next child
    expect(solid(A.difference(null, a())).isEmpty()).toBe(true);
    expect(solid(A.difference([], a())).isEmpty()).toBe(true);
    // a transform of nothing joins what it is joined to
    expect(vol(A.union(a(), A.translate([1, 2, 3], null)))).toBe(8);
    // nothing of the other kind does not count: union() of no children is not a solid in particular
    const none = A.union();
    expect(A.offset(none, { delta: 1 }).isEmpty()).toBe(true);
    expect(A.linear_extrude(none, 2).isEmpty()).toBe(true);
    expect((A.difference(A.square(2), none) as ReturnType<CsgApi['square']>).area()).toBe(4);
    expect((A.union(A.square(2), none) as ReturnType<CsgApi['square']>).area()).toBe(4);
    expect(vol(A.difference(a(), A.square(0)))).toBe(8);
    expect(vol(A.union(a(), A.square(0)))).toBe(8);
    expect(solid(A.intersection(a(), A.square(0))).isEmpty()).toBe(true);
    expect(solid(A.rounded(A.square(0), 1)).isEmpty()).toBe(true);
    // no child at all is still a mistake
    expect(() => A.translate([1, 2, 3])).toThrow('it needs something to work on');
    expect(() => A.difference()).toThrow('it needs something to cut from');
    expect(() => A.intersection()).toThrow('it needs something to intersect');
  });

  it('undefined is an error: what a function gives that forgot its return, a cut that would silently not happen', () => {
    const forgot = (): undefined => {
      A.cube(1);
    };
    expect(() => A.difference(a(), forgot())).toThrow('difference: a child is undefined: a function that forgot to return its solid?');
    expect(() => A.difference(a(), [b(), forgot()])).toThrow('a child is undefined');
    expect(() => A.difference(forgot(), a())).toThrow('a child is undefined');
    expect(() => A.union(a(), forgot())).toThrow('a child is undefined');
    expect(() => A.intersection(a(), forgot())).toThrow('a child is undefined');
    expect(() => A.hull(a(), forgot())).toThrow('a child is undefined');
    expect(() => A.translate([1, 2, 3], forgot())).toThrow('translate: a child is undefined');
    expect(() => A.linear_extrude(forgot(), 2)).toThrow('a child is undefined');
    expect(() => A.offset(forgot(), { r: 1 })).toThrow('a child is undefined');
    expect(() => A.color('red', forgot())).toThrow('a child is undefined');
    expect(() => A.union([1, 2, 3].map(() => forgot()))).toThrow('a child is undefined');
    // when it is the other argument that is missing, that is what is said
    expect(() => A.translate(forgot(), a())).toThrow('translate: the distance has to be [x, y, z], got undefined');
    expect(() => A.linear_extrude(A.square(1), forgot())).toThrow('linear_extrude: height has to be a number, got undefined');
  });

  it('of nothing makes nothing, and does not make something up', () => {
    const none = A.union();
    expect(solid(A.rounded(none, 1)).isEmpty()).toBe(true);
    expect(solid(A.filleted(none, 1)).isEmpty()).toBe(true);
    expect(A.minkowski(none, a()).isEmpty()).toBe(true);
    expect(A.minkowski(a(), none).isEmpty()).toBe(true);
    expect(A.round_extrude(A.square(0), { height: 5, r: 1 }).isEmpty()).toBe(true);
    expect(solid(A.hull(none, A.square(0))).isEmpty()).toBe(true);
    expect(solid(A.hull(null)).isEmpty()).toBe(true);
    expect(A.resize([1, 1, 1], none).isEmpty()).toBe(true);
  });
});

describe('when the engine itself fails', () => {
  it('its bare C++ exception becomes an error with a name, and with that a stack through the script', () => {
    const f = guarded({
      boom: () => {
        throw 96771864;
      },
      said: () => {
        throw new TypeError('as it was');
      },
      fine: (x: number) => x + 1,
      value: 3,
    });
    expect(() => f.boom()).toThrow('boom: the geometry engine could not do this');
    expect(() => f.said()).toThrow(TypeError);
    expect(f.fine(1)).toBe(2);
    expect(f.value).toBe(3);
    let stack = '';
    try {
      f.boom();
    } catch (e) {
      stack = (e as Error).stack!;
    }
    expect(stack).toContain('csg.test.ts');
  });
});

describe('angles', () => {
  it('are degrees, as OpenSCAD\'s, and exact where they are round', () => {
    expect(A.sin(30)).toBeCloseTo(0.5, 12);
    expect(A.cos(60)).toBeCloseTo(0.5, 12);
    expect(A.tan(45)).toBeCloseTo(1, 12);
    expect(A.cos(90)).toBe(0);
    expect(A.sin(180)).toBe(0);
    expect(A.cos(180)).toBe(-1);
    expect(A.sin(-90)).toBe(-1);
    expect(A.cos(450)).toBe(0);
    expect(A.tan(180)).toBe(0);
    expect(A.asin(1)).toBeCloseTo(90, 12);
    expect(A.acos(0)).toBeCloseTo(90, 12);
    expect(A.atan(1)).toBeCloseTo(45, 12);
    expect(A.atan2(1, 1)).toBeCloseTo(45, 12);
  });
});

describe('round edges', () => {
  it('round_box: all edges, to the size asked', () => {
    const b = A.round_box([10, 8, 6], 2);
    expect(size(b)).toEqual([10, 8, 6]);
    expect(A.bbox(b).min).toEqual([0, 0, 0]);
    // less than the box by the corners and edges, more than the box inside the rounding
    expect(b.volume()).toBeLessThan(480);
    expect(b.volume()).toBeGreaterThan(6 * 4 * 2 + 200);
    expect(A.bbox(A.round_box([10, 8, 6], 2, { center: true })).min).toEqual([-5, -4, -3]);
    expect(() => A.round_box([10, 8, 2], 2)).toThrow('half its smallest side');
  });

  it('round_rect: 2D, for an outline', () => {
    const r = A.round_rect([10, 6], 1, { fn: 128 });
    expect(A.bbox(r).size.slice(0, 2)).toEqual([10, 6]);
    expect(A.bbox(r).min.slice(0, 2)).toEqual([0, 0]);
    expect(r.area()).toBeCloseTo(60 - 4 + Math.PI, 1);
  });

  it('round_extrude: any outline, both rims or one', () => {
    const outline = A.square([20, 10]);
    const both = A.round_extrude(outline, { height: 6, r: 2 });
    expect(size(both)).toEqual([20, 10, 6]);
    expect(A.bbox(both).min[2]).toBeCloseTo(0, 6);
    expect(both.volume()).toBeLessThan(1200);
    const top = A.round_extrude(outline, { height: 6, r: 2, bottom: false });
    expect(size(top)).toEqual([20, 10, 6]);
    expect(A.bbox(top).min[2]).toBeCloseTo(0, 6);
    expect(top.volume()).toBeGreaterThan(both.volume());
    // the flat rim sits on the plane it was cut at: the section just over it has the whole outline, corners rounded
    expect(top.slice(0.001).area()).toBeCloseTo(200 - (4 - Math.PI) * 4, 0);
    expect(both.slice(0.001).area()).toBeLessThan(200 - 16 * 2);
    const under = A.round_extrude(outline, { height: 6, r: 2, top: false });
    expect(size(under)).toEqual([20, 10, 6]);
    expect(under.slice(5.999).area()).toBeCloseTo(200 - (4 - Math.PI) * 4, 0);
    const walls = A.round_extrude(outline, { height: 6, r: 2, top: false, bottom: false });
    expect(walls.volume()).toBeCloseTo((200 - (4 - Math.PI) * 4) * 6, 0);
    expect(() => A.round_extrude(outline, { height: 3, r: 2 })).toThrow('too low');
    expect(() => A.round_extrude(A.square([3, 10]), { height: 6, r: 2 })).toThrow('narrower than 4 mm');
  });

  it('rounded and filleted: on a plain solid; a large one is refused with what to do instead', () => {
    const block = A.cube([6, 6, 6]);
    const round = A.rounded(block, 1, { fn: 8 });
    expect(round.volume()).toBeLessThan(216);
    expect(round.volume()).toBeGreaterThan(190);
    expect(size(round)).toEqual([6, 6, 6]);
    // a post on a plate: the fill where they meet makes it bigger, not taller or wider
    const post = A.union(A.cube([8, 8, 1]), A.translate([3, 3, 1], A.cube([2, 2, 3]))) as Manifold;
    const filled = A.filleted(post, 0.5, { fn: 4 });
    expect(filled.volume()).toBeGreaterThan(post.volume());
    expect(size(filled)).toEqual([8, 8, 4]);
    const many = A.difference(A.sphere({ r: 10, fn: 64 }), A.sphere({ r: 9, fn: 64 }));
    expect(() => A.rounded(many, 1)).toThrow(/triangles.*round_extrude, round_box/);
    expect(() => A.minkowski(many, A.cube(1))).toThrow(/triangles/);
    // a convex solid is quick however fine it is
    expect(A.minkowski(A.sphere({ r: 10, fn: 64 }), A.cube(1)).isEmpty()).toBe(false);
  });
});

describe('lights and lenses', () => {
  it('dome: a cap on z = 0, of the size asked', () => {
    const d = A.dome(10, 3);
    const b = A.bbox(d);
    expect(b.size[0]).toBeCloseTo(10, 1);
    expect(b.min[2]).toBeCloseTo(0, 6);
    expect(b.max[2]).toBeCloseTo(3, 3);
    // a spherical cap's volume
    expect(d.volume() / (((Math.PI * 3) / 6) * (3 * 25 + 9))).toBeCloseTo(1, 2);
  });

  it('lens: flat, or curved on both sides', () => {
    const flat = A.lens(10, { r: 8, edge: 1 });
    const sag = 8 - Math.sqrt(64 - 25);
    expect(A.bbox(flat).min[2]).toBeCloseTo(0, 6);
    expect(A.bbox(flat).max[2]).toBeCloseTo(1 + sag, 3);
    const both = A.lens(10, { r: 8, r2: 12, edge: 1 });
    expect(A.bbox(both).min[2]).toBeCloseTo(-(12 - Math.sqrt(144 - 25)), 3);
    expect(both.volume()).toBeGreaterThan(flat.volume());
    expect(() => A.lens(10, { r: 3 })).toThrow('under half its diameter');
    expect(() => A.lens(10, {})).toThrow('it needs r');
  });

  it('smooth forms melt together, negative inside', () => {
    const edge = 0.5;
    const ball = A.sdf(A.sd_sphere(5), { min: [-6, -6, -6], max: [6, 6, 6], edge });
    expect(ball.volume()).toBeCloseTo((4 / 3) * Math.PI * 125, -1.5);
    const box = A.sdf(A.sd_box([8, 8, 8], 1), { min: [-6, -6, -6], max: [6, 6, 6], edge });
    expect(A.bbox(box).size[0]).toBeCloseTo(8, 0);
    const melted = A.sdf(A.smooth_union(3, A.sd_sphere(3, [-3, 0, 0]), A.sd_sphere(3, [3, 0, 0])), { min: [-8, -6, -6], max: [8, 6, 6], edge });
    // waist: where two balls only touch, the melted form has a neck, and there is one solid
    expect(melted.slice(0).area()).toBeGreaterThan(A.sdf(A.sd_sphere(3, [-3, 0, 0]), { min: [-8, -6, -6], max: [8, 6, 6], edge }).slice(0).area() * 1.5);
    expect(melted.decompose()).toHaveLength(1);
    const bitten = A.sdf(A.smooth_difference(0.5, A.sd_sphere(5), A.sd_sphere(3, [5, 0, 0])), { min: [-6, -6, -6], max: [6, 6, 6], edge });
    expect(bitten.volume()).toBeLessThan(ball.volume());
    expect(A.sdf(A.smooth_intersection(0.5, A.sd_sphere(5), A.sd_sphere(5, [3, 0, 0])), { min: [-6, -6, -6], max: [6, 6, 6], edge }).volume()).toBeLessThan(ball.volume());
    expect(() => A.sdf(A.sd_sphere(5), { min: [0, 0, 0], max: [1000, 1000, 1000], edge: 0.1 })).toThrow('too fine');
  });
});

describe('text', () => {
  it('has capitals as tall as asked, on the baseline, left to right', () => {
    const h = A.text('H', { size: 4 });
    const b = A.bbox(h);
    expect(b.max[1]).toBeCloseTo(4, 2);
    expect(b.min[1]).toBeCloseTo(0, 2);
    expect(b.min[0]).toBeGreaterThan(0);
    expect(A.bbox(A.text('HH', { size: 4 })).size[0]).toBeGreaterThan(b.size[0] * 2);
    // wider apart with spacing
    expect(A.bbox(A.text('HH', { size: 4, spacing: 1.5 })).size[0]).toBeGreaterThan(A.bbox(A.text('HH', { size: 4 })).size[0]);
  });

  it('keeps the holes in its letters', () => {
    const o = A.text('O', { size: 10 });
    const solidO = A.hull(o) as ReturnType<CsgApi['square']>;
    expect(o.area()).toBeLessThan(solidO.area() * 0.7);
    expect(o.numContour()).toBe(2);
    // two letters that do not touch stay apart
    expect(A.text('II', { size: 10 }).decompose()).toHaveLength(2);
  });

  it('aligns on the origin as asked', () => {
    const c = A.bbox(A.text('H', { size: 4, halign: 'center', valign: 'center' }));
    expect(c.center[0]).toBeCloseTo(0, 0);
    expect(c.center[1]).toBeCloseTo(0, 2);
    expect(A.bbox(A.text('H', { size: 4, valign: 'top' })).max[1]).toBeCloseTo(0, 2);
    expect(A.bbox(A.text('H', { size: 4, valign: 'bottom' })).min[1]).toBeCloseTo(0, 2);
    expect(A.bbox(A.text('H', { size: 4, halign: 'right' })).max[0]).toBeLessThan(0);
    // nothing to draw is an empty shape, and it is said plainly when it is not text at all
    expect(A.text(' ', { size: 4 }).isEmpty()).toBe(true);
    expect(() => A.text(5 as never)).toThrow('it needs a string, got 5');
  });
});

describe('what a script can measure', () => {
  it('bbox, volume and gap, read in the report through echo', () => {
    const a = A.cube(2);
    const b = A.translate([5, 0, 0], A.cube(2));
    expect(A.bbox(a)).toEqual({ min: [0, 0, 0], max: [2, 2, 2], size: [2, 2, 2], center: [1, 1, 1] });
    expect(A.volume(a)).toBe(8);
    expect(A.distance(a, b)).toBeCloseTo(3, 6);
    // looks only as far as it is told
    expect(A.distance(a, b, 1)).toBeCloseTo(1, 6);
    expect(A.distance(a, a)).toBe(0);
    log.length = 0;
    A.echo('lid', 1.23456, { a: [0.00049, 2] });
    A.echo(a);
    expect(log).toEqual(['lid 1.235 {"a":[0,2]}', 'a solid']);
    for (let i = 0; i < 200; i++) A.echo('x');
    // it says when it stops
    expect(log).toHaveLength(101);
    expect(log[100]).toBe('(echo stops here, after 100 lines)');
  });

  it('set_fn sets the detail of what follows', async () => {
    const { w } = await csg();
    A.set_fn(8);
    expect(A.cylinder({ h: 1, r: 5 }).numVert()).toBe(16);
    A.set_fn(0);
    w.resetToCircularDefaults();
    expect(A.cylinder({ h: 1, r: 5, fn: 6 }).numVert()).toBe(12);
  });
});
