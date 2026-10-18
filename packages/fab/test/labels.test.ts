import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { Kernel } from '@4k7/kernel';
import { enclosureKey, type EnclosureBrief, type EnclosureGraphic, type ScadRunResult } from '@4k7/schema';
import { boardScad, boardScadSummary, bounds, enclosureJob, enclosureReport, parseStl, printFiles, reportText, writeStl } from '../src/index.ts';
import { OpenScad, openscadCandidates } from '../../../tools/server/src/scad.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

function board() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.transact({ summary: 'holes', ops: [{ op: 'add_hole', diameter_mm: 3.2, corner: 'all' }, { op: 'set_mating', ref: 'J1', face: 'left' }] });
  return k.boardPlacement();
}

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
const SCRIPT = `include <board.scad>
wall = 2; gap = 0.5; floor_t = 2; standoff = 3; clearance = 0.3; lid_t = 2;
pieces = ["base", "lid", "lid_logo"];
inlays = [["lid_logo", "lid", "white"]];
print = [["lid", [180, 0, 0]]];
piece = "all";
floor_z = -standoff - floor_t;
split_z = pcb_thickness + 2;
lid_top = tallest_top + lid_clearance + lid_t;
j1 = part_info("J1")[6];
module shell(z0, z1) { translate([0, 0, z0]) linear_extrude(height = z1 - z0) offset(r = wall) pcb_shape(gap); }
module cavity(z0, z1) { translate([0, 0, z0]) linear_extrude(height = z1 - z0) pcb_shape(gap); }
module openings() { for (r = brief_openings) mating_path(r, grow = clearance); }
module usb_label() engrave("left", [-gap - wall, j1[1][1], floor_z + 2.5], 0.5) label("USB", size = 3.5);
module logo() engrave("above", [pcb_size[0] / 2, pcb_size[1] / 2, lid_top], 0.6) graphic("logo", width = 14);
module base() {
  difference() {
    union() { difference() { shell(floor_z, split_z); cavity(-standoff, split_z + 1); } hole_posts(-standoff); }
    openings();
    usb_label();
  }
}
module lid_body() { difference() { shell(split_z, lid_top); cavity(split_z - 1, tallest_top + lid_clearance); openings(); } }
module lid() difference() { lid_body(); logo(); }
module lid_logo() intersection() { lid_body(); logo(); }
if (piece == "base" || piece == "all") base();
if (piece == "lid" || piece == "all") lid();
if (piece == "lid_logo" || piece == "all") lid_logo();
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
  it('are rendered and checked like pieces, but not for overlapping the host they fill', () => {
    const job = enclosureJob(board(), 'buck', SCRIPT, BRIEF, [LOGO]);
    expect(job.runs.filter((r) => r.id.startsWith('overlap:')).map((r) => r.id)).toEqual(['overlap:base:lid', 'overlap:base:lid_logo']);
    expect(job.runs.filter((r) => r.mesh).map((r) => r.id)).toEqual(['piece:base', 'piece:lid', 'piece:lid_logo']);
    // the report is out of date when a graphic changes, though the script did not
    expect(job.key).toBe(enclosureKey({ script: SCRIPT, graphics: [LOGO] }));
    expect(job.key).not.toBe(enclosureKey({ script: SCRIPT, graphics: [{ ...LOGO, w: 21 }] }));
    expect(enclosureKey({ script: SCRIPT })).toBe(SCRIPT);
  });

  it('print with their host: turned alike, one object in the 3MF with a part each', () => {
    const job = enclosureJob(board(), 'buck', SCRIPT, BRIEF, [LOGO]);
    const cube = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
      const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
      const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
      return Buffer.from(writeStl(Float32Array.from(f.flatMap((t) => t.flatMap((i) => c[i]!))))).toString('base64');
    };
    const piece = (id: string, stl: string, min: [number, number, number], max: [number, number, number]): ScadRunResult => ({ id, ok: true, empty: false, ms: 1, stl, bbox: { min, max } });
    const results: ScadRunResult[] = job.runs.map((r) => ({ id: r.id, ok: true, empty: !r.id.startsWith('rest:'), ms: 1, ...(r.id.startsWith('rest:') ? { bbox: { min: [0, 0, 0], max: [1, 1, 0] } } : {}) }));
    results[0] = piece('piece:base', cube(0, 0, -5, 30, 20, 4), [0, 0, -5], [30, 20, 4]);
    results[1] = piece('piece:lid', cube(0, 0, 4, 30, 20, 14), [0, 0, 4], [30, 20, 14]);
    results[2] = piece('piece:lid_logo', cube(10, 5, 13.4, 20, 15, 14), [10, 5, 13.4], [20, 15, 14]);
    const r = enclosureReport(job, results, SCRIPT);
    // a 0.6 mm inlay is as thin as it is meant to be: no thin-wall warning for it
    expect(r.findings.filter((f) => f.message.startsWith('lid_logo'))).toEqual([]);
    const files = printFiles(r, 'buck');
    // the lid turned over with its logo: the logo on the bed, in the lid's middle
    const lid = bounds(parseStl(files.stl.find((f) => f.name === 'lid')!.data));
    const logo = bounds(parseStl(files.stl.find((f) => f.name === 'lid_logo')!.data));
    expect(lid.min[2]).toBeCloseTo(0, 4);
    expect(logo.min[2]).toBeCloseTo(0, 4);
    expect(logo.max[2]).toBeCloseTo(0.6, 4);
    expect((logo.min[0] + logo.max[0]) / 2).toBeCloseTo((lid.min[0] + lid.max[0]) / 2, 4);
    const model = new TextDecoder().decode(files.plate);
    expect(model).toMatch(/<object id="4" name="lid" type="model"><components><component objectid="2"\/><component objectid="3"\/><\/components><\/object>/);
    expect(model).toContain('<build><item objectid="1"/><item objectid="4"/></build>');
  });
});

describe('labels in OpenSCAD', () => {
  const real = openscadCandidates().find((p) => existsSync(p));

  it.skipIf(!real)('lays text on each face reading from outside, and renders a labelled box clean', async () => {
    const scad = new OpenScad({ bin: real!, save: () => {} });
    const lib = boardScad(board(), 'buck', BRIEF, [LOGO]);
    // a 4 × 2 rectangle at the origin of each face, embossed 1 mm: where it lands says how the face is laid
    const faces = ['left', 'right', 'top', 'bottom', 'above', 'below'];
    const out = await scad.render({ files: { 'board.scad': lib.content }, runs: faces.map((f) => ({ id: f, code: `include <board.scad>\nemboss("${f}", [0, 0, 0], 1) square([4, 2]);\n` })) });
    const box = Object.fromEntries(out.map((r) => [r.id, r.bbox!.min.map((v, i) => [Math.round(v * 100) / 100, Math.round(r.bbox!.max[i]! * 100) / 100])]));
    // [x, y, z] ranges: text's x runs to the reader's right, its y up, the emboss out of the face
    expect(box.left).toEqual([[-1, 0], [-4, 0], [0, 2]]);
    expect(box.right).toEqual([[0, 1], [0, 4], [0, 2]]);
    expect(box.top).toEqual([[-4, 0], [0, 1], [0, 2]]);
    expect(box.bottom).toEqual([[0, 4], [-1, 0], [0, 2]]);
    expect(box.above).toEqual([[0, 4], [0, 2], [0, 1]]);
    expect(box.below).toEqual([[0, 4], [-2, 0], [-1, 0]]);

    const job = enclosureJob(board(), 'buck', SCRIPT, BRIEF, [LOGO]);
    const r = enclosureReport(job, await scad.render(job), SCRIPT);
    expect(r.findings.filter((f) => f.severity === 'error'), reportText(r)).toEqual([]);
    expect(r.pieces.map((p) => p.name)).toEqual(['base', 'lid', 'lid_logo']);
    // the logo, 14 mm wide (20 × 10 stored), sunk 0.6 mm into the lid's top
    const logo = r.pieces.find((p) => p.name === 'lid_logo')!.bbox;
    expect(logo.max[0] - logo.min[0]).toBeCloseTo(14, 2);
    expect(logo.max[1] - logo.min[1]).toBeCloseTo(7, 2);
    expect(logo.max[2]).toBeCloseTo(r.pieces.find((p) => p.name === 'lid')!.bbox.max[2], 2);
    // a graphic the design does not have stops the render with its name
    const missing = SCRIPT.replace('graphic("logo"', 'graphic("nope"');
    const bad = enclosureJob(board(), 'buck', missing, BRIEF, [LOGO]);
    const failed = enclosureReport(bad, await scad.render({ ...bad, runs: bad.runs.slice(0, 2) }), missing);
    expect(failed.findings[0]!.code).toBe('ENC.SCRIPT');
    expect(failed.findings[0]!.message).toContain('no graphic "nope"');
  }, 120_000);
});
