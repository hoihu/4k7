import { describe, expect, it } from 'vitest';
import { Kernel } from '@4k7/kernel';
import type { EnclosureBrief, ScadRunResult } from '@4k7/schema';
import { enclosureJob, enclosureReport, reportText } from '../src/index.ts';
import { OpenScad, openscadCandidates } from '../../../tools/server/src/scad.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';
import { existsSync } from 'node:fs';

function board() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.transact({ summary: 'holes', ops: [{ op: 'add_hole', diameter_mm: 3.2, corner: 'all' }, { op: 'set_mating', ref: 'J1', face: 'left' }] });
  return k.boardPlacement();
}

const BRIEF: EnclosureBrief = { items: [{ topic: 'Closure', decision: 'screws' }], openings: ['J1'] };

const script = (o: { standoff?: number; cut?: boolean } = {}) => `include <board.scad>
wall = 2; gap = 0.5; floor_t = 2; standoff = ${o.standoff ?? 3}; clearance = 0.3; lid_t = 2;
pieces = ["base", "lid"];
piece = "all";
floor_z = -standoff - floor_t;
split_z = pcb_thickness + 2;
module shell(z0, z1) { translate([0, 0, z0]) linear_extrude(height = z1 - z0) offset(r = wall) pcb_shape(gap); }
module cavity(z0, z1) { translate([0, 0, z0]) linear_extrude(height = z1 - z0) pcb_shape(gap); }
module openings() { ${o.cut === false ? '' : 'for (r = brief_openings) mating_path(r, grow = clearance);'} }
module base() {
  difference() {
    union() { difference() { shell(floor_z, split_z); cavity(-standoff, split_z + 1); } hole_posts(-standoff); }
    openings();
  }
}
module lid() { difference() { shell(split_z, tallest_top + lid_clearance + lid_t); cavity(split_z - 1, tallest_top + lid_clearance); openings(); } }
if (piece == "base" || piece == "all") base();
if (piece == "lid" || piece == "all") lid();
`;

describe('enclosure job', () => {
  it('renders each piece and runs one intersection per check', () => {
    const job = enclosureJob(board(), 'buck', script(), BRIEF);
    expect(job.pieces).toEqual(['base', 'lid']);
    expect(Object.keys(job.files)).toEqual(['board.scad', 'enclosure.scad']);
    expect(job.runs.map((r) => r.id)).toEqual([
      'piece:base',
      'piece:lid',
      'collide:base',
      'collide:lid',
      'way:J1',
      'lid',
      'rest:MH1',
      'rest:MH2',
      'rest:MH3',
      'rest:MH4',
      'overlap:base:lid',
    ]);
    expect(job.runs.filter((r) => r.mesh).map((r) => r.id)).toEqual(['piece:base', 'piece:lid']);
    expect(job.runs.find((r) => r.id === 'way:J1')!.code).toContain('intersection() { union() { base(); lid(); } mating_path("J1"); }');
  });

  it('reads the results into findings the agent can act on', () => {
    const job = enclosureJob(board(), 'buck', script(), { ...BRIEF, max_size_mm: [20, 20, 20] });
    const ok = (id: string, extra: Partial<ScadRunResult> = {}): ScadRunResult => ({ id, ok: true, empty: true, ms: 10, ...extra });
    const box = (min: [number, number, number], max: [number, number, number]) => ({ min, max });
    const j1 = job.facts.parts.find((p) => p.ref === 'J1')!;
    const results: ScadRunResult[] = [
      ok('piece:base', { empty: false, stl: 'AAAA', bbox: box([-2.5, -2.5, -5], [26.5, 24.5, 3.6]) }),
      ok('piece:lid', { empty: false, stl: 'AAAA', bbox: box([-2.5, -2.5, 3.6], [26.5, 24.5, 13.1]) }),
      ok('collide:base', { empty: false, bbox: box([j1.min[0] + 0.1, j1.min[1] + 0.1, -1.36], [j1.min[0] + 0.5, j1.min[1] + 1, -1]) }),
      ok('collide:lid'),
      ok('way:J1', { empty: false, bbox: box([-2.5, 9.4, 1.6], [-0.5, 14.5, 3.6]) }),
      ok('lid'),
      ok('rest:MH1', { empty: false, bbox: box([0, 0, -0.25], [1, 1, 0]) }),
      ok('rest:MH2', { empty: false, bbox: box([0, 0, -0.25], [1, 1, 0]) }),
      ok('rest:MH3'),
      ok('rest:MH4', { empty: false, bbox: box([0, 0, -0.25], [1, 1, 0]) }),
      ok('overlap:base:lid'),
    ];
    const r = enclosureReport(job, results, 'the script');
    expect(r.pieces.map((p) => p.name)).toEqual(['base', 'lid']);
    expect(r.size).toEqual([29, 27, 18.1]);
    const codes = r.findings.map((f) => `${f.severity} ${f.code}`);
    expect(codes).toEqual(['error ENC.COLLIDES', 'error ENC.BLOCKED', 'warning ENC.LOOSE', 'error ENC.SIZE']);
    expect(r.findings[0]!.message).toMatch(/^base runs into J1: /);
    expect(r.findings[1]!.message).toMatch(/^J1's way out \(plugged from left, 5.08 × 8.5 mm\) is blocked: 2 × 5.1 × 2 mm/);
    expect(r.findings[2]!.message).toContain('rests on 3 of 4 mounting holes');
    expect(r.findings[2]!.message).toContain('MH3');
    const text = reportText(r, job.facts);
    expect(text).toMatch(/^Box: 29 × 27 × 18.1 mm/);
    expect(text).toContain('3 finding(s) to fix:');
  });

  it('a script OpenSCAD cannot render is reported with its errors only', () => {
    const job = enclosureJob(board(), 'buck', script(), BRIEF);
    const results: ScadRunResult[] = job.runs.map((x) => ({ id: x.id, ok: false, empty: false, ms: 5, errors: ['ERROR: Parser error in file "enclosure.scad", line 7: syntax error'] }));
    const r = enclosureReport(job, results, 'x');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ code: 'ENC.SCRIPT', severity: 'error' });
    expect(r.findings[0]!.message).toContain('line 7');
  });

  it('asks for a mating face when an opening part has none', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.transact({ summary: 'no face', ops: [{ op: 'set_footprint', ref: 'J1', name: 'TB_1x2', pads: [{ number: '1', x: -2.5, y: 0, w: 2, drill: 1.1 }, { number: '2', x: 2.5, y: 0, w: 2, drill: 1.1 }], body_mm: [10, 8], height_mm: 10 }] });
    const job = enclosureJob(k.boardPlacement(), 'buck', script(), BRIEF);
    expect(job.runs.some((r) => r.id === 'way:J1')).toBe(false);
    const r = enclosureReport(job, job.runs.map((x) => ({ id: x.id, ok: true, empty: !x.id.startsWith('piece:') && !x.id.startsWith('rest:'), ms: 1, ...(x.id.startsWith('piece:') || x.id.startsWith('rest:') ? { stl: 'AA', bbox: { min: [0, 0, 0], max: [1, 1, 1] } } : {}) })), 'x');
    expect(r.findings.map((f) => f.code)).toEqual(['ENC.NO_MATING']);
  });

  const real = openscadCandidates().find((p) => existsSync(p));
  it.skipIf(!real)('measures real renders: clean, collides, blocked', async () => {
    const scad = new OpenScad({ bin: real!, save: () => {} });
    const run = async (s: string) => {
      const job = enclosureJob(board(), 'buck', s, BRIEF);
      return enclosureReport(job, await scad.render(job), s);
    };
    const clean = await run(script());
    expect(clean.findings.filter((f) => f.severity === 'error'), reportText(clean)).toEqual([]);
    expect(clean.pieces).toHaveLength(2);
    expect(clean.size![2]).toBeGreaterThan(14);
    const low = await run(script({ standoff: 1 }));
    expect(low.findings.find((f) => f.code === 'ENC.COLLIDES')?.parts).toEqual(['J1']); // its leads poke through the floor
    const closed = await run(script({ cut: false }));
    expect(closed.findings.map((f) => f.code)).toContain('ENC.BLOCKED');
    const broken = await run(script().replace('module base() {', 'module base() { cube(;'));
    expect(broken.findings[0]!.code).toBe('ENC.SCRIPT');
    expect(broken.findings[0]!.message).toMatch(/enclosure\.scad.*line 1[0-9]/);
  });
});
