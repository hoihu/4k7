import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Kernel } from '@4k7/kernel';
import { enclosureKey, scriptProblems, type EnclosureBrief } from '@4k7/schema';
import { enclosureApiSummary, enclosureFacts, failedReport, reportText, scriptLine, scriptSource, SCRIPT_GLOBAL } from '../src/index.ts';
import { render } from './csg-setup.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

function kernel() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.transact({ summary: 'holes', ops: [{ op: 'add_hole', diameter_mm: 3.2, corner: 'all' }, { op: 'set_mating', ref: 'J1', face: 'left' }] });
  return k;
}
// the same board for all (the checks only read it)
const board = kernel().boardPlacement();

const BRIEF: EnclosureBrief = { items: [{ topic: 'Closure', decision: 'screws' }], openings: ['J1'] };

const script = (o: { standoff?: number; cut?: boolean; posts?: string; lid?: string } = {}) => `const wall = 2, gap = 0.5, floor_t = 2, standoff = ${o.standoff ?? 3}, clearance = 0.3, lid_t = 2;
const pieces = ['base', 'lid'];
const print = { lid: [180, 0, 0] };
const floor_z = -standoff - floor_t;
const split_z = pcb_thickness + 2;
const shell = (z0, z1) => translate([0, 0, z0], linear_extrude(offset(pcb_shape(gap), { r: wall }), { height: z1 - z0 }));
const cavity = (z0, z1) => translate([0, 0, z0], linear_extrude(pcb_shape(gap), { height: z1 - z0 }));
const openings = () => ${o.cut === false ? '[]' : 'brief_openings.map((r) => mating_path(r, { grow: clearance }))'};
function base() {
  return difference(
    union(difference(shell(floor_z, split_z), cavity(-standoff, split_z + 1)), ${o.posts ?? 'hole_posts(-standoff)'}),
    openings(),
  );
}
function lid() {
  return difference(shell(${o.lid ?? 'split_z'}, tallest_top + lid_clearance + lid_t), cavity(split_z - 1, tallest_top + lid_clearance), openings());
}
`;

const codes = (r: { findings: { code: string; severity: string }[] }, severity = 'error') => r.findings.filter((f) => f.severity === severity).map((f) => f.code);

describe('rendering a script', () => {
  it('makes the pieces and finds nothing wrong with a good box', async () => {
    const r = await render(board, script(), BRIEF);
    expect(r.findings, reportText(r)).toEqual([]);
    expect(r.pieces.map((p) => p.name)).toEqual(['base', 'lid']);
    const base = r.pieces[0]!;
    expect(base.tris.length % 9).toBe(0);
    expect(base.tris.length).toBeGreaterThan(9 * 100);
    expect(base.bbox.min[2]).toBeCloseTo(-5, 6);
    // the box round the board: 2 mm of wall and 0.5 mm of gap on each side
    expect(r.size![0]).toBeCloseTo(board.outline.w + 5, 2);
    expect(r.size![1]).toBeCloseTo(board.outline.h + 5, 2);
    expect(r.size![2]).toBeGreaterThan(14);
    expect(r.key).toBe(enclosureKey({ script: script() }));
    expect(reportText(r)).toContain('The report is clean');
  });

  it('finds a part in the way, by name, and where', async () => {
    const r = await render(board, script({ standoff: 1 }), BRIEF);
    const hit = r.findings.find((f) => f.code === 'ENC.COLLIDES')!;
    // its leads poke through the floor
    expect(hit.parts).toEqual(['J1']);
    expect(hit.message).toMatch(/^base runs into J1: /);
    expect(hit.box!.min[2]).toBeLessThan(0);
  });

  it('finds a plug that cannot get out, and what to do', async () => {
    const r = await render(board, script({ cut: false }), BRIEF);
    expect(codes(r)).toEqual(['ENC.BLOCKED']);
    const f = r.findings[0]!;
    expect(f.parts).toEqual(['J1']);
    expect(f.message).toMatch(/^J1's way out \(plugged from left, 5.08 × 8.5 mm\) is blocked: 2 × 5.08 × 8.5 mm/);
    expect(f.message).toContain("mating_path('J1', { grow: clearance })");
  });

  it('finds a lid too low, and names the part under it', async () => {
    const r = await render(board, script().replace('tallest_top + lid_clearance + lid_t), cavity(split_z - 1, tallest_top + lid_clearance)', 'tallest_top + lid_t), cavity(split_z - 1, tallest_top + 0.5)'), BRIEF);
    expect(codes(r)).toEqual(['ENC.LOW_LID']);
    expect(r.findings[0]!.message).toMatch(/^Less than 1 mm \(the brief's lid clearance\) over J1/);
    expect(r.findings[0]!.parts).toEqual(['J1']);
  });

  it('finds a board that rests on too little: some holes a warning, none an error', async () => {
    const some = await render(board, script({ posts: 'translate([0, 0, 0], difference(hole_posts(-standoff), translate([holes[0].x - 4, holes[0].y - 4, -standoff - 1], cube([8, 8, standoff + 2]))))' }), BRIEF);
    const f = some.findings.find((x) => x.code === 'ENC.LOOSE')!;
    expect(f.severity).toBe('warning');
    expect(f.message).toContain('rests on 3 of 4 mounting holes');
    expect(f.message).toContain(enclosureFacts(board).holes[0]!.id);
    const none = await render(board, script({ posts: 'cube(0)' }), BRIEF);
    expect(none.findings.find((x) => x.code === 'ENC.LOOSE')!.severity).toBe('error');
    // no holes: anything under the board will do
    const plain = new Kernel();
    plain.transact(buckTransaction());
    const bare = await render(plain.boardPlacement(), 'const pieces = [\'tray\'];\nfunction tray() { return translate([0, 0, -8], cube([pcb_size[0], pcb_size[1], 2])); }');
    expect(bare.findings.find((x) => x.code === 'ENC.LOOSE')!.message).toContain('Nothing holds the board from below');
  });

  it('finds pieces that overlap, a box over the limit, and a wall nearly on a part', async () => {
    const overlap = await render(board, script({ lid: 'split_z - 1' }), BRIEF);
    expect(codes(overlap)).toEqual(['ENC.PIECES_OVERLAP']);
    expect(overlap.findings.find((f) => f.code === 'ENC.PIECES_OVERLAP')!.message).toMatch(/^base and lid overlap where they meet/);
    const big = await render(board, script(), { ...BRIEF, max_size_mm: [20, 20, 20] });
    expect(codes(big)).toEqual(['ENC.SIZE']);
    expect(big.findings[0]!.message).toMatch(/^The box is 29 × 27 × 18.13 mm; the brief allows 20 × 20 × 20 mm\.$/);
    // a block 0.1 mm over a part that is not one of the openings
    const u1 = enclosureFacts(board).parts.find((p) => p.ref === 'L1')!;
    const near = await render(board, `const pieces = ['block'];\nfunction block() { return union(hole_posts(-3), translate([${u1.min[0]}, ${u1.min[1]}, ${u1.max[2] + 0.1 + 1}], cube([2, 2, 2]))); }`, { ...BRIEF, openings: [], lid_clearance_mm: 0 });
    expect(codes(near, 'warning')).not.toContain('ENC.NEAR');
    const touching = await render(board, `const pieces = ['block'];\nfunction block() { return union(hole_posts(-3), translate([${u1.min[0]}, ${u1.min[1]}, ${u1.max[2] + 0.1}], cube([2, 2, 2]))); }`, { ...BRIEF, openings: [], lid_clearance_mm: 0 });
    expect(touching.findings.find((f) => f.code === 'ENC.NEAR')!.message).toMatch(/^block is only 0\.1 mm from L1/);
  });

  it('asks for a mating face when an opening part has none', async () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.transact({ summary: 'no face', ops: [{ op: 'set_footprint', ref: 'J1', name: 'TB_1x2', pads: [{ number: '1', x: -2.5, y: 0, w: 2, drill: 1.1 }, { number: '2', x: 2.5, y: 0, w: 2, drill: 1.1 }], body_mm: [10, 8], height_mm: 10 }] });
    const b = k.boardPlacement();
    const box = await render(b, script({ cut: false, posts: 'translate([0, 0, -standoff], cube([3, 3, standoff]))' }), BRIEF);
    expect(codes(box)).toEqual(['ENC.NO_MATING']);
    expect(box.findings.find((f) => f.code === 'ENC.NO_MATING')!.message).toContain('set_mating');
    // a script that cuts for it anyway stops there, saying the same
    const cut = await render(b, script(), BRIEF);
    expect(cut.findings[0]!.message).toContain('mating_path: where J1 is plugged from is unknown: set_mating');
  });
});

describe('a script that does not work', () => {
  const lines = (s: string) => s.split('\n');

  it('stops at its first error at the top, with the line', async () => {
    const s = `const pieces = ['base'];\nconst wall = 2;\nconst oops = nothing + 1;\nfunction base() { return cube(1); }`;
    const r = await render(board, s);
    expect(r.pieces).toEqual([]);
    expect(r.size).toBeNull();
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ code: 'ENC.SCRIPT', severity: 'error' });
    expect(r.findings[0]!.message).toBe('The script stopped: line 3: ReferenceError: nothing is not defined');
  });

  it('says every piece that fails, and the line in the script, not in the library', async () => {
    const s = `const pieces = ['a', 'b', 'c', 'd', 'e'];
function a() {
  return cylinder({ h: 3 });
}
function b() {
  return translate([1, undefined, 3], cube(1));
}
function c() { return square(2); }
function d() { return 7; }
function e() { return difference(cube(1), cube(2)); }
`;
    const r = await render(board, s);
    expect(r.findings.map((f) => f.message)).toEqual([
      'The piece a() stopped: line 3: cylinder: it needs a radius or diameter: r or d, or r1 and r2 (d1 and d2), got ["h"]',
      "The piece b() stopped: line 6: translate: the distance's y has to be a number, got undefined",
      'The piece c() stopped: it returned a 2D shape: extrude it (linear_extrude)',
      'The piece d() stopped: it has to return a solid, and it returned number',
      'The piece e() is empty: it draws nothing.',
    ]);
    expect(lines(s)[2]).toContain('cylinder');
    expect(lines(s)[5]).toContain('translate');
  });

  it('is told about a name assigned without a declaration, before it runs', () => {
    expect(scriptProblems(`const pieces = ['a'];\nwall = 2;\nfunction a() { return cube(wall); }`)).toEqual(['Line 2: wall is assigned but not declared: const wall = …;']);
    expect(scriptProblems(`const pieces = ['a'];\nfunction a() {\n  for (i = 0; i < 3; i++) {}\n  return cube(1);\n}`)[0]).toBe('Line 3: i is assigned but not declared: const i = …;');
    // its own names, wherever they are declared, and an object's properties
    const fine = `const pieces = ['a'];\nlet w = 1;\nconst o = {};\nfunction a(p, { q }, [r]) {\n  w = 2; p = 3; q = 4; r = 5; o.x = 6; let t; t = 7; t++;\n  for (const v of []) {}\n  try {} catch (e) { e = 1; }\n  return cube(w);\n}`;
    expect(scriptProblems(fine)).toEqual([]);
  });

  it('a piece may return a list, which is their union; its own names shadow the library\'s', async () => {
    const r = await render(board, `const pieces = ['a'];\nconst holes = 2;\nfunction translate() { return 'mine'; }\nfunction a() { return [hole_posts(-3), cube(holes)]; }`);
    expect(r.pieces).toHaveLength(1);
    expect(r.findings.some((f) => f.code === 'ENC.SCRIPT')).toBe(false);
  });

  it('is told about a helper that forgot its return: the cut would silently not happen', async () => {
    const r = await render(board, `const pieces = ['a'];\nfunction cavity() { cube(1); }\nfunction a() {\n  return difference(cube(2), cavity());\n}`);
    expect(r.findings[0]!.message).toBe('The piece a() stopped: line 4: difference: a child is undefined: a function that forgot to return its solid? (null or false leave a child out)');
  });

  it('a set_fn at the top holds for every piece, one inside a piece only there', async () => {
    const pieces = "const pieces = ['a', 'b', 'c'];\n";
    const a = "function a() { set_fn(6); echo('a', cylinder({ h: 1, r: 5 }).numVert()); return hole_posts(-3); }\n";
    const rest = "function b() { echo('b', cylinder({ h: 1, r: 5 }).numVert()); return translate([0, 0, -20], cube(1)); }\nfunction c() { set_fn(0); echo('c', cylinder({ h: 1, r: 5 }).numVert()); return translate([0, 0, -30], cube(1)); }\n";
    const inPiece = await render(board, pieces + a + rest);
    expect(inPiece.log).toEqual(['a 12', 'b 144', 'c 144']);
    const atTop = await render(board, `set_fn(8);\n${pieces}function a() { echo('a', cylinder({ h: 1, r: 5 }).numVert()); return hole_posts(-3); }\nfunction b() { set_fn(6); echo('b', cylinder({ h: 1, r: 5 }).numVert()); return translate([0, 0, -20], cube(1)); }\nfunction c() { echo('c', cylinder({ h: 1, r: 5 }).numVert()); return translate([0, 0, -30], cube(1)); }\n`);
    expect(atTop.log).toEqual(['a 16', 'b 12', 'c 16']);
  });

  it('what it says with echo comes back in the report', async () => {
    const r = await render(board, `const pieces = ['a'];\nfunction a() { const c = cube(2); echo('size', bbox(c).size); return c; }`);
    expect(r.log).toEqual(['size [2,2,2]']);
    expect(reportText(r)).toContain('The script said (echo):\n  size [2,2,2]');
    // also when it then fails
    const bad = await render(board, `const pieces = ['a'];\nfunction a() { echo('here'); return nothing; }`);
    expect(bad.log).toEqual(['here']);
  });

  it('a report with nothing else to say', () => {
    const r = failedReport('x', 'k', 'The script did not end in 60 s');
    expect(r).toEqual({ script: 'x', key: 'k', pieces: [], findings: [{ code: 'ENC.SCRIPT', severity: 'error', message: 'The script did not end in 60 s' }], size: null, ms: 0 });
    expect(reportText(r)).toContain('1 finding(s) to fix:');
  });
});

describe('how a script is wrapped', () => {
  it('keeps its lines one down, and finds them in a stack', () => {
    const src = scriptSource('const pieces = [\'a\'];\nfunction a() {}', ['a']);
    expect(src.split('\n')[1]).toBe("const pieces = ['a'];");
    expect(src.split('\n')[0]).toContain(SCRIPT_GLOBAL);
    // not in strict mode: in Safari a strict `return difference(…)` is a tail call, which takes the piece and its line off the stack
    expect(src).not.toContain('use strict');
    // Chromium, Node; Safari; Firefox
    expect(scriptLine({ stack: 'Error: x\n    at lib (http://a/assets/w.js:1:9)\n    at base (blob:http://a/u-1:12:3)\n    at blob:http://a/u-1:40:2' }, 'blob:http://a/u-1')).toBe(11);
    expect(scriptLine({ stack: 'lib@http://a/assets/w.js:1:9\nbase@blob:http://a/u-1:4:14\nglobal code@blob:http://a/u-1:7:22' }, 'blob:http://a/u-1')).toBe(3);
    expect(scriptLine({ stack: 'nothing here' }, 'blob:http://a/u-1')).toBeNull();
    expect(scriptLine(7, 'x')).toBeNull();
  });
});

describe('what the agent reads', () => {
  it('the guide\'s example box runs on the engine, and is clean', async () => {
    const guide = readFileSync(new URL('../../../docs/design/mechanics.md', import.meta.url), 'utf8');
    const example = /## 7\. Writing the script[\s\S]*?```js\n([\s\S]*?)```/.exec(guide)![1]!;
    expect(scriptProblems(example)).toEqual([]);
    const r = await render(board, example, BRIEF);
    expect(r.findings, reportText(r)).toEqual([]);
    expect(r.pieces.map((p) => p.name)).toEqual(['base', 'lid']);
  });

  it('has the board as the script finds it, and everything it can call', () => {
    const facts = enclosureFacts(board);
    const s = enclosureApiSummary(facts, { ...BRIEF, lid_clearance_mm: 2 }, [{ name: 'logo', mode: 'fill', polys: [], w: 20, h: 10 }]);
    expect(s).toContain(`pcb_size = [${facts.size.join(', ')}]`);
    expect(s).toContain('brief_openings = ["J1"]');
    expect(s).toContain('lid_clearance = 2');
    expect(s).toContain('graphics = [{name: "logo", w: 20, h: 10}]');
    expect(s).toMatch(/\{ref: "J1", kind: "connector", min: \[.*mating: \{facing: "left", origin: \[/);
    for (const name of ['cube(', 'difference(', 'linear_extrude(', 'round_extrude(', 'round_box(', 'rounded(', 'filleted(', 'dome(', 'lens(', 'sdf(', 'smooth_union(', 'bbox(', 'distance(', 'echo(', 'cos(', 'atan2(', 'mating_path(', 'hole_posts(', 'on_face(', 'engrave(', 'emboss(', 'label(', 'graphic(', 'part_box(', 'keepouts(']) expect(s, name).toContain(name);
    expect(s).not.toContain('OpenSCAD script');
  });

  it('every global the reference names is there, and the fixture box in this file passes its own checks', async () => {
    expect(scriptProblems(script())).toEqual([]);
    const names = ['cube', 'cylinder', 'sphere', 'polyhedron', 'linear_extrude', 'rotate_extrude', 'square', 'circle', 'polygon', 'text', 'offset', 'projection', 'union', 'difference', 'intersection', 'hull', 'minkowski', 'translate', 'rotate', 'scale', 'mirror', 'multmatrix', 'resize', 'color', 'set_fn', 'round_extrude', 'round_box', 'round_rect', 'rounded', 'filleted', 'dome', 'lens', 'sdf', 'sd_sphere', 'sd_box', 'sd_cylinder', 'smooth_union', 'smooth_difference', 'smooth_intersection', 'bbox', 'volume', 'distance', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'echo', 'pcb_shape', 'pcb', 'part', 'parts', 'assembly', 'part_box', 'part_info', 'hole_info', 'mating_path', 'keepouts', 'hole_posts', 'label', 'graphic', 'on_face', 'emboss', 'engrave', 'pcb_thickness', 'pcb_size', 'pcb_outline', 'pcb_cutouts', 'holes', 'tallest_top', 'lowest_bottom', 'parts_info', 'brief_openings', 'lid_clearance', 'graphics'];
    const r = await render(board, `const pieces = ['a'];\nfunction a() {\n  for (const n of ${JSON.stringify(names)}) if (typeof globalThis[n] === 'undefined') throw new Error('no ' + n);\n  return cube(1);\n}`);
    expect(r.findings.filter((f) => f.code === 'ENC.SCRIPT')).toEqual([]);
    // and what the render keeps to itself is not among them
    const inner = await render(board, `const pieces = ['a'];\nfunction a() {\n  for (const n of ['centeredText', 'fnNow']) if (typeof globalThis[n] !== 'undefined') throw new Error('has ' + n);\n  return cube(1);\n}`);
    expect(inner.findings.filter((f) => f.code === 'ENC.SCRIPT')).toEqual([]);
  });
});
