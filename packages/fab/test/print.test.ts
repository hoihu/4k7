import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { Kernel } from '@4k7/kernel';
import { scriptPrintRotations, type EnclosureBrief } from '@4k7/schema';
import { bounds, enclosureJob, enclosureReport, orient, parseStl, plate, printFiles, printIssues, thinWalls, threeMf, warpLimit, warping, writeStl, type Tris } from '../src/index.ts';
import { OpenScad, openscadCandidates } from '../../../tools/server/src/scad.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

/** A closed prism: a polygon in the x–z plane (counter-clockwise seen from −y), `depth` along y. */
function prism(pts: [number, number][], depth: number): Tris {
  const out: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => out.push(...a, ...b, ...c);
  const n = pts.length;
  const front = pts.map(([x, z]) => [x, 0, z]);
  const back = pts.map(([x, z]) => [x, depth, z]);
  for (let i = 1; i + 1 < n; i++) {
    tri(front[0]!, front[i + 1]!, front[i]!); // facing −y
    tri(back[0]!, back[i]!, back[i + 1]!); // facing +y
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(front[i]!, front[j]!, back[j]!);
    tri(front[i]!, back[j]!, back[i]!);
  }
  // faces outward: a positive signed volume, else every triangle turned round
  let vol = 0;
  for (let i = 0; i < out.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = out.slice(i, i + 9) as [number, number, number, number, number, number, number, number, number];
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  if (vol < 0) for (let i = 0; i < out.length; i += 9) for (let k = 0; k < 3; k++) [out[i + 3 + k], out[i + 6 + k]] = [out[i + 6 + k]!, out[i + 3 + k]!];
  return Float32Array.from(out);
}
const box = (x0: number, z0: number, x1: number, z1: number, d: number, y0 = 0) => {
  const t = prism([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], d);
  for (let i = 1; i < t.length; i += 3) t[i] = t[i]! + y0;
  return t;
};
const join = (...ts: Tris[]) => Float32Array.from(ts.flatMap((t) => [...t]));

describe('printing the pieces', () => {
  it('reads and writes binary STL', () => {
    const t = box(0, 0, 10, 5, 3);
    const back = parseStl(writeStl(t, 'base'));
    expect(back.length).toBe(t.length);
    expect([...back]).toEqual([...t]);
  });

  it('turns a piece as OpenSCAD rotate does and sets it on the bed', () => {
    const lid = box(0, 10, 20, 12, 15); // a plate 10 mm up
    const flipped = orient(lid, [180, 0, 0]);
    const b = bounds(flipped);
    expect(b.min[2]).toBeCloseTo(0, 5);
    expect(b.max[2]).toBeCloseTo(2, 5);
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(0, 5);
    expect((b.min[1] + b.max[1]) / 2).toBeCloseTo(0, 5);
    // about z by 90: x and y swap sizes
    const turned = bounds(orient(box(0, 0, 20, 2, 5), [0, 0, 90]));
    expect(turned.max[0] - turned.min[0]).toBeCloseTo(5, 4);
    expect(turned.max[1] - turned.min[1]).toBeCloseTo(20, 4);
  });

  it('lays the pieces out on one 3MF plate', () => {
    const pieces = plate([{ name: 'base', tris: orient(box(0, 0, 30, 10, 20)) }, { name: 'lid', tris: orient(box(0, 0, 30, 2, 20)) }]);
    const [a, b] = pieces.map((p) => bounds(p.tris));
    expect(b!.min[0] - a!.max[0]).toBeCloseTo(8, 4);
    const bytes = threeMf(pieces, 'buck');
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('[Content_Types].xml');
    expect(text).toContain('<model unit="millimeter"');
    expect(text).toContain('<object id="1" name="base" type="model">');
    expect(text).toContain('<object id="2" name="lid" type="model">');
    // a box: 8 corners shared by its 12 triangles
    const first = /<object id="1"[\s\S]*?<\/object>/.exec(text)![0];
    expect(first.match(/<vertex /g)).toHaveLength(8);
    expect(first.match(/<triangle /g)).toHaveLength(12);
  });

  it('finds overhangs steeper than 45° and ceilings too wide to bridge, but not what lies on the bed', () => {
    // a wedge whose left side leans out 56° from vertical
    const wedge = prism([[0, 0], [20, 0], [20, 10], [-15, 10]], 10);
    const over = printIssues(wedge, orient(wedge));
    expect(over.map((x) => x.kind)).toEqual(['overhang']);
    expect(over[0]!.area).toBeGreaterThan(100);
    // a 30 mm slab held 5 mm up on two narrow legs: its underside bridges 30 mm
    const table = join(box(0, 0, 3, 5, 30), box(27, 0, 30, 5, 30), box(0, 5, 30, 7, 30));
    const kinds = printIssues(table, orient(table)).map((x) => `${x.kind} ${x.size ?? ''}`);
    expect(kinds).toContain('bridge 30');
    // turned over, the slab lies on the bed and the legs stand up: nothing to support
    expect(printIssues(table, orient(table, [180, 0, 0]))).toEqual([]);
    // a plain block on the bed
    const block = box(0, 0, 10, 10, 10);
    expect(printIssues(block, orient(block))).toEqual([]);
  });

  it('finds walls thinner than two perimeters', () => {
    const thin = thinWalls(box(0, 0, 20, 0.5, 20));
    expect(thin).toHaveLength(1);
    expect(thin[0]!.size).toBeCloseTo(0.5, 2);
    expect(thinWalls(box(0, 0, 20, 2, 20))).toEqual([]);
  });

  it('finds pieces that may warp: long thin plates and frames, not ribbed plates or boxes', () => {
    // box(x0, z0, x1, z1, depth along y): a 100 × 60 × 2 mm plate bends like a 2 mm plate over 100 mm
    const plateOnly = box(0, 0, 100, 2, 60);
    const bare = warping(plateOnly)!;
    expect(bare).toMatchObject({ along: 'x', across: 'z', open: 0 });
    expect(bare.thickness).toBeCloseTo(2, 0);
    expect(bare.slenderness).toBeGreaterThan(40);
    // ribs one way, 6 mm high and 1.5 mm thick, stiffen it that way only: across them it is a bare plate 60 mm wide
    const ribs = [10, 29, 48].map((y) => box(0, 2, 100, 8, 1.5, y));
    expect(warping(join(plateOnly, ...ribs))).toMatchObject({ along: 'y', slenderness: 30 });
    // a grid of them stiffens it both ways
    const grid = warping(join(plateOnly, ...ribs, ...[25, 50, 75].map((x) => box(x, 2, x + 1.5, 8, 60))))!;
    expect(grid.slenderness).toBeLessThan(bare.slenderness / 2);
    // an open box (floor and walls) is stiff
    const tray = join(box(0, 0, 100, 2, 60), box(0, 2, 2, 20, 60), box(98, 2, 100, 20, 60), box(2, 2, 98, 20, 2), box(2, 2, 98, 20, 2, 58));
    expect(warping(tray)!.slenderness).toBeLessThan(15);
    // a frame round a window: open inside its outline
    const frame = join(box(0, 0, 100, 2, 10), box(0, 0, 100, 2, 10, 50), box(0, 0, 10, 2, 40, 10), box(90, 0, 100, 2, 40, 10));
    expect(warping(frame)!.open).toBeCloseTo(0.53, 1);
    // too small to warp
    expect(warping(box(0, 0, 40, 1, 30))).toBeNull();
  });

  it('allows less slenderness for resin, powder and ABS than for PLA', () => {
    const brief = (decision: string): EnclosureBrief => ({ items: [{ topic: 'Process and material', decision }] });
    expect(warpLimit(brief('SLA resin at JLC3DP')).slenderness).toBe(30);
    expect(warpLimit(brief('MJF nylon PA12')).slenderness).toBe(35);
    expect(warpLimit(brief('FDM, ASA')).slenderness).toBe(35);
    expect(warpLimit(brief('FDM, PLA on a 0.4 mm nozzle')).slenderness).toBe(50);
    expect(warpLimit().slenderness).toBe(50);
  });

  it('reads the print orientation from the script', () => {
    expect(scriptPrintRotations('pieces = ["base", "lid"];\nprint = [["lid", [180, 0, 0]], ["clip", [0, -90, 45.5]]];')).toEqual({ lid: [180, 0, 0], clip: [0, -90, 45.5] });
    expect(scriptPrintRotations('// print = [["lid", [180, 0, 0]]];\npieces = ["lid"];')).toEqual({});
  });

  const real = openscadCandidates().find((p) => existsSync(p));
  it.skipIf(!real)('flags the lid\'s ceiling until the script turns it over for printing', async () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.transact({ summary: 'holes', ops: [{ op: 'add_hole', diameter_mm: 3.2, corner: 'all' }, { op: 'set_mating', ref: 'J1', face: 'left' }] });
    const brief: EnclosureBrief = { items: [{ topic: 'Closure', decision: 'screws' }], openings: ['J1'] };
    const script = (print: string) => `include <board.scad>
wall = 2; gap = 0.5; standoff = 3; clearance = 0.3;
pieces = ["base", "lid"];
piece = "all";
${print}
module shell(z0, z1) { translate([0, 0, z0]) linear_extrude(height = z1 - z0) offset(r = wall) pcb_shape(gap); }
module cavity(z0, z1) { translate([0, 0, z0]) linear_extrude(height = z1 - z0) pcb_shape(gap); }
module base() { difference() { union() { difference() { shell(-standoff - 2, pcb_thickness + 2); cavity(-standoff, 20); } hole_posts(-standoff); } for (r = brief_openings) mating_path(r, grow = clearance); } }
module lid() { difference() { shell(pcb_thickness + 2, tallest_top + 3); cavity(0, tallest_top + 1); for (r = brief_openings) mating_path(r, grow = clearance); } }
if (piece == "base" || piece == "all") base();
if (piece == "lid" || piece == "all") lid();
`;
    const scad = new OpenScad({ bin: real!, save: () => {} });
    const run = async (s: string) => {
      const job = enclosureJob(k.boardPlacement(), 'buck', s, brief);
      return enclosureReport(job, await scad.render(job), s);
    };
    const asBuilt = await run(script(''));
    const bridge = asBuilt.findings.find((f) => f.code === 'ENC.BRIDGE');
    expect(bridge?.message).toMatch(/^lid, printed as built/);
    expect(asBuilt.findings.filter((f) => f.severity === 'error')).toEqual([]);
    const turned = await run(script('print = [["lid", [180, 0, 0]]];'));
    expect(turned.findings.filter((f) => f.code === 'ENC.BRIDGE' || f.code === 'ENC.OVERHANG')).toEqual([]);
    const files = printFiles(turned, 'buck');
    expect(files.stl.map((f) => f.name)).toEqual(['base', 'lid']);
    // the lid lies on its top: its flat outside face at z = 0
    const lid = parseStl(files.stl[1]!.data);
    expect(bounds(lid).min[2]).toBeCloseTo(0, 4);
    expect(new TextDecoder().decode(files.plate)).toContain('name="lid"');
  }, 60_000);
});
