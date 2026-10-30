import { describe, expect, it } from 'vitest';
import { Kernel } from '@4k7/kernel';
import { enclosureKey, type EnclosureBrief, type EnclosureGraphic } from '@4k7/schema';
import type { Manifold } from 'manifold-3d';
import { boardScad, boardScadSummary, bounds, enclosureFacts, parseStl, printFiles, reportText } from '../src/index.ts';
import { createApi } from '../src/csg/api.ts';
import { createBoardLib } from '../src/csg/board.ts';
import { textMaker } from '../src/csg/text.ts';
import { csg, render } from './csg-setup.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

// the same board for all (nothing here changes it)
const placed = (() => {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.transact({ summary: 'holes', ops: [{ op: 'add_hole', diameter_mm: 3.2, corner: 'all' }, { op: 'set_mating', ref: 'J1', face: 'left' }] });
  return k.boardPlacement();
})();
const board = () => placed;

const BRIEF: EnclosureBrief = { items: [{ topic: 'Closure', decision: 'screws' }], openings: ['J1'] };

/** A frame with a square hole and a triangle pointing right, 20 × 10, centred, y down. */
const LOGO: EnclosureGraphic = {
  name: 'logo',
  mode: 'fill',
  polys: [
    [-10, -5, 10, -5, 10, 5, -10, 5],
    [-7, -2, -2, -2, -2, 2, -7, 2],
    [2, -3, 8, 0, 2, 3],
  ],
  w: 20,
  h: 10,
  source: 'SVG path',
};

/** A box with "USB" engraved under J1's opening and the logo inlaid in the lid, printed upside down. */
const SCRIPT = `const wall = 2, gap = 0.5, floor_t = 2, standoff = 3, clearance = 0.3, lid_t = 2;
const pieces = ['base', 'lid', 'lid_logo'];
const inlays = { lid_logo: { host: 'lid', colour: 'white' } };
const print = { lid: [180, 0, 0] };
const floor_z = -standoff - floor_t;
const split_z = pcb_thickness + 2;
const lid_top = tallest_top + lid_clearance + lid_t;
const j1 = part_info('J1').mating;
const shell = (z0, z1) => translate([0, 0, z0], linear_extrude(offset(pcb_shape(gap), { r: wall }), { height: z1 - z0 }));
const cavity = (z0, z1) => translate([0, 0, z0], linear_extrude(pcb_shape(gap), { height: z1 - z0 }));
const openings = () => brief_openings.map((r) => mating_path(r, { grow: clearance }));
const usb_label = () => engrave('left', [-gap - wall, j1.origin[1], floor_z + 2.5], label('USB', { size: 3.5 }), 0.5);
const logo = () => engrave('above', [pcb_size[0] / 2, pcb_size[1] / 2, lid_top], graphic('logo', { width: 14 }), 0.6);
function base() {
  return difference(union(difference(shell(floor_z, split_z), cavity(-standoff, split_z + 1)), hole_posts(-standoff)), openings(), usb_label());
}
const lid_body = () => difference(shell(split_z, lid_top), cavity(split_z - 1, tallest_top + lid_clearance), openings());
function lid() { return difference(lid_body(), logo()); }
function lid_logo() { return intersection(lid_body(), logo()); }
`;

describe('labels and graphics in board.scad', () => {
  it('has the label helpers, and the graphics: their list for the agent, their figures (y up) below', () => {
    const lib = boardScad(board(), 'buck', BRIEF, [LOGO]);
    expect(lib.content).toContain('graphics = [["logo", [20, 10]]];');
    expect(lib.content).toContain('label_font = "Liberation Sans:style=Bold";');
    for (const m of ['module label(t', 'function face_frame(face)', 'module on_face(face, at)', 'module emboss(face, at', 'module engrave(face, at', 'module graphic(name', 'module graphic_shape(name)']) expect(lib.content).toContain(m);
    // one even-odd polygon, y flipped: the triangle's tip stays at the right, its top (y down -3) becomes y 3
    const shape = lib.content.split('\n').find((l) => l.includes('if (name == "logo")'))!;
    expect(shape).toContain('polygon(points = [[-10,5],[10,5],[10,-5],[-10,-5],[-7,2],');
    expect(shape).toContain('paths = [[0,1,2,3],[4,5,6,7],[8,9,10]]');
    // the agent reads the list and the helpers, not the figures
    const summary = boardScadSummary(lib.content);
    expect(summary).toContain('graphics = [["logo", [20, 10]]];');
    expect(summary).toContain('engrave(face, at, depth = 0.6)');
    expect(summary).not.toContain('polygon(points');
  });

  it('draws outline graphics as bands round each figure', () => {
    const lib = boardScad(board(), 'buck', BRIEF, [{ ...LOGO, mode: 'outline', line: 0.4 }]);
    const shape = lib.content.slice(lib.content.indexOf('if (name == "logo")'));
    expect(shape).toMatch(/difference\(\) \{ offset\(delta = 0.2\) polygon\(\[\[-10,5\],.*\]\); offset\(delta = -0.2\) polygon/);
    expect(shape.match(/difference\(\)/g)?.length).toBe(3);
  });
});

describe('inlays', () => {
  it('print with their host: turned alike, one object in the 3MF with a part each', async () => {
    const r = await render(board(), SCRIPT, BRIEF, [LOGO]);
    expect(r.findings.filter((f) => f.severity === 'error'), reportText(r)).toEqual([]);
    expect(r.pieces.map((p) => p.name)).toEqual(['base', 'lid', 'lid_logo']);
    // an inlay is not checked for overlapping the host it fills, nor for being as thin as it is meant to be
    expect(r.findings.filter((f) => f.message.startsWith('lid_logo') || f.code === 'ENC.PIECES_OVERLAP')).toEqual([]);
    // the report is out of date when a graphic changes, though the script did not
    expect(r.key).toBe(enclosureKey({ script: SCRIPT, graphics: [LOGO] }));
    expect(r.key).not.toBe(enclosureKey({ script: SCRIPT, graphics: [{ ...LOGO, w: 21 }] }));
    expect(enclosureKey({ script: SCRIPT })).toBe(SCRIPT);

    const files = printFiles(r, 'buck');
    // the lid turned over with its logo: the logo on the bed, in the lid's middle
    const lid = bounds(parseStl(files.stl.find((f) => f.name === 'lid')!.data));
    const logo = bounds(parseStl(files.stl.find((f) => f.name === 'lid_logo')!.data));
    expect(lid.min[2]).toBeCloseTo(0, 4);
    expect(logo.min[2]).toBeCloseTo(0, 4);
    expect(logo.max[2]).toBeCloseTo(0.6, 2);
    expect((logo.min[0] + logo.max[0]) / 2).toBeCloseTo((lid.min[0] + lid.max[0]) / 2, 2);
    const model = new TextDecoder().decode(files.plate);
    expect(model).toMatch(/<object id="4" name="lid" type="model"><components><component objectid="2"\/><component objectid="3"\/><\/components><\/object>/);
    expect(model).toContain('<build><item objectid="1"/><item objectid="4"/></build>');
  });
});

describe('labels in the script', () => {
  it('lays a shape on each face reading from outside', async () => {
    const { w, font } = await csg();
    const api = createApi(w, textMaker(font), []);
    const lib = createBoardLib(w, api, enclosureFacts(board()));
    const box = (s: Manifold) => {
      const b = s.boundingBox();
      return [0, 1, 2].map((i) => [Math.round(b.min[i]! * 100) / 100 || 0, Math.round(b.max[i]! * 100) / 100 || 0]);
    };
    // a 4 × 2 rectangle at the origin of each face, embossed 1 mm: where it lands says how the face is laid
    const emboss = (f: string) => box(lib.emboss(f, [0, 0, 0], api.square([4, 2]), 1));
    // [x, y, z] ranges: text's x runs to the reader's right, its y up, the emboss out of the face
    expect(emboss('left')).toEqual([[-1, 0], [-4, 0], [0, 2]]);
    expect(emboss('right')).toEqual([[0, 1], [0, 4], [0, 2]]);
    expect(emboss('top')).toEqual([[-4, 0], [0, 1], [0, 2]]);
    expect(emboss('bottom')).toEqual([[0, 4], [-1, 0], [0, 2]]);
    expect(emboss('above')).toEqual([[0, 4], [0, 2], [0, 1]]);
    expect(emboss('below')).toEqual([[0, 4], [-2, 0], [-1, 0]]);
    // sunk into the face, a hair proud of it for a clean cut; a number, or { depth }
    expect(box(lib.engrave('above', [0, 0, 5], api.square(2), 0.6))[2]).toEqual([4.4, 5.01]);
    expect(box(lib.engrave('above', [0, 0, 5], api.square(2), { depth: 1 }))[2]).toEqual([4, 5.01]);
    expect(box(lib.emboss('above', [0, 0, 5], api.square(2)))[2]).toEqual([5, 5.6]);
    // the depth first, as in OpenSCAD, comes to the same
    expect(box(lib.engrave('above', [0, 0, 5], 0.6, api.square(2)))[2]).toEqual([4.4, 5.01]);
    expect(box(lib.emboss('above', [0, 0, 5], { height: 2 }, api.square(2)))[2]).toEqual([5, 7]);
    // a label left out is nothing to cut
    expect(lib.engrave('above', [0, 0, 5], null).isEmpty()).toBe(true);
    expect(lib.engrave('above', [0, 0, 5], false, 0.6).isEmpty()).toBe(true);
    expect(() => lib.engrave('above', [0, 0, 5], api.square(2), -1)).toThrow('engrave: depth has to be positive, got -1');
    expect(() => lib.on_face('front', [0, 0, 0], api.cube(1))).toThrow('on_face: no face "front" (left, right, top, bottom, above, below)');
    expect(() => lib.on_face('left', [0, 0], api.cube(1))).toThrow('at is a point on the face');
    expect(() => lib.on_face('left', [0, 0, 0], api.square(1))).toThrow('use emboss or engrave');
  });

  it('draws graphics scaled and centred, filled or as outlines; one it does not have stops the piece, by name', async () => {
    const { w, font } = await csg();
    const api = createApi(w, textMaker(font), []);
    const lib = createBoardLib(w, api, enclosureFacts(board()), BRIEF, [LOGO, { ...LOGO, name: 'ring', mode: 'outline', line: 0.4, polys: [[-5, -5, 5, -5, 5, 5, -5, 5]], w: 10, h: 10 }]);
    expect(lib.graphics).toEqual([{ name: 'logo', w: 20, h: 10 }, { name: 'ring', w: 10, h: 10 }]);
    const size = (s: { bounds(): { min: number[]; max: number[] } }) => [s.bounds().max[0]! - s.bounds().min[0]!, s.bounds().max[1]! - s.bounds().min[1]!];
    expect(size(lib.graphic('logo'))).toEqual([20, 10]);
    expect(size(lib.graphic('logo', { width: 14 }))).toEqual([14, 7]);
    expect(size(lib.graphic('logo', { height: 5 }))).toEqual([10, 5]);
    expect(size(lib.graphic('logo', { width: 14, height: 3 }))).toEqual([14, 3]);
    // filled even-odd: the frame less its square hole and the triangle in it
    expect(lib.graphic('logo').area()).toBeCloseTo(200 - 20 - 18, 6);
    // y up: the triangle's tip keeps pointing right
    expect(lib.graphic('ring').area()).toBeCloseTo(10.4 * 10.4 - 9.6 * 9.6, 6);
    const r = await render(board(), SCRIPT.replace("graphic('logo'", "graphic('nope'"), BRIEF, [LOGO]);
    expect(r.findings[0]!.code).toBe('ENC.SCRIPT');
    expect(r.findings[0]!.message).toContain('graphic: no graphic "nope": add it with design_edit set_enclosure_graphic');
  });

  it('fits the logo to size in the box, sunk into the lid; the label reads as text', async () => {
    const r = await render(board(), SCRIPT, BRIEF, [LOGO]);
    // the logo, 14 mm wide (20 × 10 stored), sunk 0.6 mm into the lid's top
    const logo = r.pieces.find((p) => p.name === 'lid_logo')!.bbox;
    expect(logo.max[0] - logo.min[0]).toBeCloseTo(14, 2);
    expect(logo.max[1] - logo.min[1]).toBeCloseTo(7, 2);
    expect(logo.max[2]).toBeCloseTo(r.pieces.find((p) => p.name === 'lid')!.bbox.max[2], 2);
    // the engraved label took something out of the base's left wall
    const plain = await render(board(), SCRIPT.replace('openings(), usb_label())', 'openings())'), BRIEF, [LOGO]);
    const faces = (name: string, rep: typeof r) => rep.pieces.find((p) => p.name === name)!.tris.length;
    expect(faces('base', r)).toBeGreaterThan(faces('base', plain) + 9 * 50);
    const { w, font } = await csg();
    const api = createApi(w, textMaker(font), []);
    const lib = createBoardLib(w, api, enclosureFacts(board()));
    // centred on the origin, the capitals as tall as asked
    const b = lib.label('H', { size: 4 }).bounds();
    expect(b.max[1]).toBeCloseTo(2, 2);
    expect(b.min[1]).toBeCloseTo(-2, 2);
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(0, 1);
    expect(lib.label('H', 6).bounds().max[1]).toBeCloseTo(3, 2);
  });
});
