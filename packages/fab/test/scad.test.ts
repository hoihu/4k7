import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '@4k7/kernel';
import { boardFacing, type EditOp } from '@4k7/schema';
import { boardScad, boardScadSummary, enclosureFacts } from '../src/index.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

function kernel(ops: EditOp[] = []) {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.transact({ summary: 'holes', ops: [{ op: 'add_hole', diameter_mm: 3.2, corner: 'all' }, ...ops] });
  return k;
}

/** OpenSCAD on this computer, if there is one (the render tests are skipped without it). */
function openscad(): string | null {
  for (const bin of [process.env.FOURK7_OPENSCAD_BIN, '/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD', '/usr/bin/openscad', '/usr/local/bin/openscad', '/opt/homebrew/bin/openscad']) {
    if (bin && existsSync(bin)) return bin;
  }
  return null;
}

const ENCLOSURE = `include <board.scad>
wall = 2; gap = 0.5; floor_t = 2; standoff = 3; clearance = 0.3; lid_t = 2;
pieces = ["base", "lid"];
piece = "all";
floor_z = -standoff - floor_t;
split_z = pcb_thickness + 2;
module shell(z0, z1) { translate([0, 0, z0]) linear_extrude(height = z1 - z0) offset(r = wall) pcb_shape(gap); }
module cavity(z0, z1) { translate([0, 0, z0]) linear_extrude(height = z1 - z0) pcb_shape(gap); }
module base() {
  difference() {
    union() { difference() { shell(floor_z, split_z); cavity(-standoff, split_z + 1); } hole_posts(-standoff); }
    for (r = brief_openings) mating_path(r, grow = clearance);
  }
}
module lid() {
  difference() { shell(split_z, tallest_top + lid_clearance + lid_t); cavity(split_z - 1, tallest_top + lid_clearance); for (r = brief_openings) mating_path(r, grow = clearance); }
}
if (piece == "base" || piece == "all") base();
if (piece == "lid" || piece == "all") lid();
`;

describe('board.scad', () => {
  it('lists the board, its holes and every part in board.scad coordinates (y up, underside at z = 0)', () => {
    const k = kernel();
    const b = k.boardPlacement();
    const f = enclosureFacts(b);
    expect(f.size).toEqual([b.outline.w, b.outline.h]);
    expect(f.holes).toHaveLength(4);
    // y flipped: a hole near the board's top edge (small y on the board) is near y = height here
    const mh = b.parts.find((p) => p.refdes === 'MH1')!;
    expect(f.holes.find((h) => h.id === 'MH1')!.y).toBeCloseTo(b.outline.h - mh.y, 3);
    expect(f.parts.map((p) => p.ref).sort()).toEqual(b.parts.filter((p) => !p.componentId.startsWith('hole:')).map((p) => p.refdes).sort());
    for (const p of f.parts) {
      const bp = b.parts.find((x) => x.refdes === p.ref)!;
      // the box is round the part's place on the board
      expect(p.min[0]).toBeLessThan(bp.x);
      expect(p.max[0]).toBeGreaterThan(bp.x);
      expect(p.min[1]).toBeLessThan(b.outline.h - bp.y);
      expect(p.max[1]).toBeGreaterThan(b.outline.h - bp.y);
      expect(p.max[2]).toBeGreaterThan(1.6);
      expect(f.tallestTop).toBeGreaterThanOrEqual(p.max[2]);
    }
    // J1, a pin header: through-hole leads below the board, plugged from above
    const j1 = f.parts.find((p) => p.ref === 'J1')!;
    expect(j1.min[2]).toBeLessThan(0);
    expect(f.lowestBottom).toBeLessThan(0);
    expect(j1.kind).toBe('connector');
    expect(j1.mating).toMatchObject({ facing: 'above', dir: [0, 0, 1] });
    expect(j1.mating!.origin[2]).toBeCloseTo(j1.max[2], 3);
  });

  it('turns a mating face with the part: the way out points where get_board says', () => {
    for (const rot of [0, 90, 180, 270] as const) {
      const k = kernel([{ op: 'set_mating', ref: 'J1', face: 'left', plug_mm: [9, 6], axis_mm: 4 }, { op: 'place', ref: 'J1', x_mm: 10, y_mm: 10, rot, lock: true }]);
      const b = k.boardPlacement();
      const part = b.parts.find((p) => p.refdes === 'J1')!;
      expect(part.rot).toBe(rot);
      const m = enclosureFacts(b).parts.find((p) => p.ref === 'J1')!.mating!;
      const facing = boardFacing('left', rot, 'top');
      expect(m.facing).toBe(facing);
      // board.scad is y up: the board's top edge (y−) is +y here
      const want = { left: [-1, 0, 0], right: [1, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0] }[facing as 'left'];
      expect(m.dir).toEqual(want);
      expect(m.size).toEqual([9, 6]);
      expect(m.origin[2]).toBeCloseTo(1.6 + 0.035 + 4, 3);
      // the face is on the part's side it points to
      const centre = [part.x, b.outline.h - part.y];
      expect((m.origin[0] - centre[0]!) * m.dir[0] + (m.origin[1] - centre[1]!) * m.dir[1]).toBeGreaterThan(0);
    }
  });

  it('puts a bottom part under the board, plugged from below', () => {
    const k = kernel([{ op: 'constrain', kind: 'layer', a: 'J1', value: 'bottom', strength: 'hard' }]);
    const j1 = enclosureFacts(k.boardPlacement()).parts.find((p) => p.ref === 'J1')!;
    expect(j1.side).toBe('bottom');
    expect(j1.min[2]).toBeLessThan(-5);
    expect(j1.mating).toMatchObject({ facing: 'below', dir: [0, 0, -1] });
  });

  it('writes the library with the brief\'s openings; the summary leaves the solids out', () => {
    const k = kernel();
    const s = boardScad(k.boardPlacement(), 'buck', { items: [{ topic: 'Closure', decision: 'screws' }], openings: ['J1'], lid_clearance_mm: 2 });
    expect(s.name).toBe('board.scad');
    expect(s.content).toContain('brief_openings = ["J1"];');
    expect(s.content).toContain('lid_clearance = 2;');
    expect(s.content).toMatch(/module part\(ref\) \{\n {2}if \(ref == "C1"\) multmatrix/);
    const summary = boardScadSummary(s.content);
    expect(summary).toContain('parts_info = [');
    expect(summary).toContain('mating_path(ref, length = 30, grow = 0)');
    expect(summary).not.toContain('multmatrix');
    expect(summary.length).toBeLessThan(s.content.length);
  });

  const bin = openscad();
  it.skipIf(!bin)('renders in OpenSCAD: the assembly, a box round it, an empty collision, a blocked plug found', () => {
    const k = kernel([{ op: 'set_mating', ref: 'J1', face: 'left' }]);
    const dir = mkdtempSync(join(tmpdir(), 'scad-'));
    try {
      writeFileSync(join(dir, 'board.scad'), boardScad(k.boardPlacement(), 'buck', { items: [{ topic: 'x', decision: 'y' }], openings: ['J1'] }).content);
      writeFileSync(join(dir, 'enclosure.scad'), ENCLOSURE);
      const run = (name: string, code: string) => {
        writeFileSync(join(dir, name), code);
        const r = spawnSync(bin!, ['--backend=manifold', '-o', join(dir, `${name}.stl`), '--export-format', 'binstl', '--summary', 'all', '--summary-file', join(dir, `${name}.json`), join(dir, name)], { encoding: 'utf8', timeout: 60_000 });
        const empty = /top level object is empty/i.test(r.stderr);
        const box = !empty && existsSync(join(dir, `${name}.json`)) ? (JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as { geometry: { bounding_box: { min: number[]; max: number[] } } }).geometry.bounding_box : null;
        return { status: r.status, empty, box, stderr: r.stderr };
      };
      const asm = run('asm.scad', 'include <board.scad>\nassembly();\n');
      expect(asm.status, asm.stderr).toBe(0);
      const base = run('base.scad', 'use <enclosure.scad>\nbase();\n');
      expect(base.status, base.stderr).toBe(0);
      expect(base.box!.min[2]).toBeCloseTo(-5, 3);
      const hit = run('hit.scad', 'use <enclosure.scad>\ninclude <board.scad>\nintersection() { union() { base(); lid(); } union() { pcb(); parts(); } }\n');
      expect(hit.empty, hit.stderr).toBe(true);
      const way = run('way.scad', 'use <enclosure.scad>\ninclude <board.scad>\nintersection() { union() { base(); lid(); } mating_path("J1"); }\n');
      expect(way.empty, way.stderr).toBe(true);
      writeFileSync(join(dir, 'closed.scad'), ENCLOSURE.replaceAll('for (r = brief_openings) mating_path(r, grow = clearance);', ''));
      const blocked = run('blocked.scad', 'use <closed.scad>\ninclude <board.scad>\nintersection() { union() { base(); lid(); } mating_path("J1"); }\n');
      expect(blocked.empty).toBe(false);
      // the wall in front of the plug: 2 mm thick, left of the board
      expect(blocked.box!.max[0]! - blocked.box!.min[0]!).toBeCloseTo(2, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
