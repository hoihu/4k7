import { describe, expect, it } from 'vitest';
import { boardFacing, boardSummary, scriptGraphics, scriptInlays, scriptPieces, scriptPrintRotations, scriptProblems, type EnclosureBrief } from '@4k7/schema';
import { Kernel, registerArtwork, unregisterArtwork } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

function kernel() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k;
}

const SCRIPT = `const wall = 2;
const pieces = ['base', 'lid'];
function base() { return cube([10, 10, 5]); }
const lid = () => translate([0, 0, 6], cube([10, 10, 1]));
`;

const BRIEF: EnclosureBrief = {
  items: [
    { topic: 'Closure', decision: 'M3 screws into the base', why: 'default' },
    { topic: 'J1 power input', refs: ['J1'], question: 'Is J1 wired with the box closed?', options: ['Yes, an opening for the plug', 'No, inside'] },
  ],
  openings: ['J1'],
};

describe('mating faces', () => {
  it('turns a footprint face with the part, mirrored on the bottom', () => {
    expect(boardFacing('left', 0, 'top')).toBe('left');
    expect(boardFacing('left', 90, 'top')).toBe('top');
    expect(boardFacing('top', 90, 'top')).toBe('right');
    expect(boardFacing('bottom', 270, 'top')).toBe('right');
    expect(boardFacing('left', 0, 'bottom')).toBe('right');
    expect(boardFacing('top', 0, 'bottom')).toBe('top');
    expect(boardFacing('up', 180, 'top')).toBe('above');
    expect(boardFacing('up', 0, 'bottom')).toBe('below');
  });

  it('pin headers are plugged from above; set_mating says otherwise and get_board shows it', () => {
    const k = kernel();
    const j1 = () => (boardSummary(k.boardPlacement(), false).parts.find((p) => p.refdes === 'J1') as { plugged_from?: string; rot: number });
    expect(j1().plugged_from).toBe('above');
    const r = k.transact({ summary: 'J1 is a side-entry jack', ops: [{ op: 'set_mating', ref: 'J1', face: 'left', plug_mm: [9, 9], axis_mm: 5.5 }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const card = k.draftDesign().parts['generic:CONN_1x2']!;
    expect(card.packageInfo?.mating).toEqual({ face: 'left', plug_mm: [9, 9], axis_mm: 5.5 });
    expect(card.packageInfo?.family).toBe('HEADER'); // the footprint stays
    expect(j1().plugged_from).toMatch(/^the (left|right|top edge side|bottom edge side)/);
    const hunk = k.proposal()!.hunks.find((h) => h.id === 'part:generic:CONN_1x2');
    expect(hunk).toBeTruthy();
    // null forgets it: back to what the family implies
    expect(k.transact({ summary: 'not plugged', ops: [{ op: 'set_mating', ref: 'J1', face: null }] }).status).toBe('ok');
    expect(k.draftDesign().parts['generic:CONN_1x2']!.packageInfo?.mating).toBeUndefined();
    expect(j1().plugged_from).toBe('above');
  });

  it('set_footprint keeps a mating face given before, or takes a new one', () => {
    const k = kernel();
    k.transact({ summary: 'side entry', ops: [{ op: 'set_mating', ref: 'J1', face: 'right' }] });
    const pads = [
      { number: '1', x: -2.5, y: 0, w: 2, drill: 1.1 },
      { number: '2', x: 2.5, y: 0, w: 2, drill: 1.1 },
    ];
    expect(k.transact({ summary: 'terminal block', ops: [{ op: 'set_footprint', ref: 'J1', name: 'TB_1x2_P5.0', pads, body_mm: [10, 8], height_mm: 10 }] }).status).toBe('ok');
    expect(k.draftDesign().parts['generic:CONN_1x2']!.packageInfo?.mating?.face).toBe('right');
    expect(k.transact({ summary: 'terminal block', ops: [{ op: 'set_footprint', ref: 'J1', name: 'TB_1x2_P5.0', pads, body_mm: [10, 8], height_mm: 10, mating: { face: 'top' } }] }).status).toBe('ok');
    expect(k.draftDesign().parts['generic:CONN_1x2']!.packageInfo?.mating?.face).toBe('top');
  });
});

describe('enclosure brief', () => {
  it('is stored with its questions and becomes a hunk of its own', () => {
    const k = kernel();
    const r = k.transact({ summary: 'brief', ops: [{ op: 'set_enclosure_brief', brief: BRIEF }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(r.results[0]!.effect).toContain('1 question(s) for the user');
    expect(k.draftDesign().enclosure?.brief).toEqual(BRIEF);
    const h = k.proposal()!.hunks.find((x) => x.id === 'enclosure:brief')!;
    expect(h).toMatchObject({ kind: 'enclosure', change: 'add', title: 'enclosure brief: 2 items, 1 question open' });
    expect(h.details).toEqual(['Closure: M3 screws into the base', 'J1 power input: ? Is J1 wired with the box closed?']);
  });

  it('refuses unknown parts, items without a decision or question, and questions without options', () => {
    const k = kernel();
    const bad = (brief: EnclosureBrief) => k.transact({ summary: 'brief', ops: [{ op: 'set_enclosure_brief', brief }] });
    expect(bad({ items: [{ topic: 'J9', decision: 'x' }], openings: ['J9'] })).toMatchObject({ status: 'rejected', rejection: { code: 'REF_UNKNOWN' } });
    expect(bad({ items: [{ topic: 'Closure' }] })).toMatchObject({ status: 'rejected', rejection: { code: 'ENCLOSURE_INVALID' } });
    expect(bad({ items: [{ topic: 'Closure', question: 'Screws or snaps?' }] })).toMatchObject({ status: 'rejected', rejection: { code: 'ENCLOSURE_INVALID' } });
  });
});

describe('enclosure script', () => {
  it('names its pieces and is checked before it is stored', () => {
    expect(scriptPieces(SCRIPT)).toEqual(['base', 'lid']);
    expect(scriptProblems(SCRIPT)).toEqual([]);
    expect(scriptProblems('cube(1);').join(' ')).toContain('Name the pieces: const pieces');
    expect(scriptProblems(SCRIPT.replace('const lid =', 'const cover =')).join(' ')).toContain('pieces names "lid" but there is no function lid()');
    // plain names only: it is read without running the script
    expect(scriptProblems(SCRIPT.replace("['base', 'lid']", "['base', name]")).join(' ')).toContain('Name the pieces');
    expect(scriptProblems(SCRIPT.replace("['base', 'lid']", "['base lid']")).join(' ')).toContain('Name the pieces');
  });

  it('says where a syntax error is, in any browser', () => {
    const [problem] = scriptProblems(`const wall = 2;\nconst pieces = ['base'];\nfunction base() {\n  return cube([1, 2, 3);\n}`);
    expect(problem).toMatch(/^Line 4, column 23: Unexpected token\.$/);
    expect(scriptPieces('const pieces = [')).toBeNull();
    expect(scriptProblems(`const pieces = ['base'];\nconst pieces = ['lid'];\nfunction base() {}`)[0]).toMatch(/^Line 2, column 7: Identifier 'pieces' has already been declared/);
    // its syntax is held to strict mode's
    expect(scriptProblems(`const pieces = ['a'];\nfunction a() { with (x) {} }`)[0]).toMatch(/^Line 2/);
    // a stray return or await would not reach the end of the script
    expect(scriptProblems(`const pieces = ['a'];\nfunction a() {}\nreturn 3;`)[0]).toMatch(/^Line 3/);
    expect(scriptProblems(`const pieces = ['a'];\nfunction a() {}\nawait 3;`)[0]).toMatch(/^Line 3/);
  });

  it('does not reach outside; said while it can still be fixed, with the line', () => {
    const one = (extra: string) => scriptProblems(`${SCRIPT}${extra}`).join(' ');
    expect(one('fetch("https://example.com");')).toContain('Line 5: fetch is not there');
    expect(one('const x = new XMLHttpRequest();')).toContain('XMLHttpRequest is not there');
    expect(one('eval("1");')).toContain('eval is not there');
    expect(one('const f = Function("return 1");')).toContain('Function is not there');
    expect(one('import("./x.js");')).toContain('Line 5: no import()');
    expect(one('import x from "./x.js";')).toContain('Line 5: no import or export');
    expect(one('export { base };')).toContain('no import or export');
    expect(one('export function other() {}')).toContain('no import or export');
    // not when it is only text, a comment, a key or its own
    expect(one('// fetch("x"); import("y");')).toBe('');
    expect(one('const label = "fetch";')).toBe('');
    expect(one('const o = { fetch: 1, eval: 2 }; const z = o.fetch + o.eval;')).toBe('');
    expect(one('function fetch() { return 1; } fetch();')).toBe('');
    // a window is a thing a box has
    expect(one('const window = cube(1); const document = 2;')).toBe('');
  });

  it('recognises an OpenSCAD script, and says what to do with it', () => {
    const old = `include <board.scad>\nwall = 2;\npieces = ["base"];\npiece = "all";\nmodule base() { cube(1); }\nbase();\n`;
    expect(scriptProblems(old)).toHaveLength(1);
    expect(scriptProblems(old)[0]).toMatch(/^This is an OpenSCAD script.*rewrite it/);
    expect(scriptPieces(old)).toBeNull();
    expect(scriptProblems('module base() { cube(1); }\npieces = ["base"];')[0]).toMatch(/^This is an OpenSCAD script/);
    // only if it is not JavaScript: a comment may well mention it
    expect(scriptProblems(`// from include <board.scad>\n${SCRIPT}`)).toEqual([]);
  });

  it('reads print and inlays without running it: plain values only', () => {
    expect(scriptPrintRotations(`${SCRIPT}const print = { lid: [180, 0, -90.5] };`)).toEqual({ lid: [180, 0, -90.5] });
    expect(scriptPrintRotations(SCRIPT)).toEqual({});
    expect(scriptProblems(`${SCRIPT}const a = 180; const print = { lid: [a, 0, 0] };`).join(' ')).toContain('print is plain numbers');
    expect(scriptProblems(`${SCRIPT}const print = [['lid', [180, 0, 0]]];`).join(' ')).toContain('print is plain numbers');
    expect(scriptProblems(`${SCRIPT}const print = { cover: [180, 0, 0] };`).join(' ')).toContain('print names "cover", which is not in pieces');
  });

  it('knows the graphics it draws, written any way', () => {
    expect(scriptGraphics(`${SCRIPT}const a = graphic('logo', { width: 3 }); const b = graphic("icon"); const c = graphic(\`mark\`); // graphic('no')`)).toEqual(['logo', 'icon', 'mark']);
    // a name it works out itself shows at render time
    expect(scriptGraphics(`${SCRIPT}const n = 'x'; const a = graphic(n);`)).toEqual([]);
  });

  it('is stored, diffed and merged apart from the brief', () => {
    const k = kernel();
    expect(k.transact({ summary: 'box', ops: [{ op: 'set_enclosure_brief', brief: BRIEF }, { op: 'set_enclosure_script', script: SCRIPT }] }).status).toBe('ok');
    const ids = k.proposal()!.hunks.filter((h) => h.kind === 'enclosure').map((h) => h.id);
    expect(ids.sort()).toEqual(['enclosure:brief', 'enclosure:script']);
    // accept the brief only: the script is left out (the working copy starts again from what was accepted)
    k.accept(['enclosure:brief'], 'user');
    expect(k.committedDesign().enclosure).toEqual({ brief: BRIEF });
    expect(k.transact({ summary: 'box', ops: [{ op: 'set_enclosure_script', script: SCRIPT }] }).status).toBe('ok');
    expect(k.proposal()!.hunks.map((h) => h.id)).toEqual(['enclosure:script']);
    k.accept(undefined, 'user');
    expect(k.committedDesign().enclosure).toEqual({ brief: BRIEF, script: SCRIPT });
    // removing both removes the enclosure
    expect(k.transact({ summary: 'no box', ops: [{ op: 'set_enclosure_script', script: null }, { op: 'set_enclosure_brief', brief: null }] }).status).toBe('ok');
    expect(k.draftDesign().enclosure).toBeUndefined();
  });

  it('refuses a script it could not render', () => {
    const k = kernel();
    const r = k.transact({ summary: 'box', ops: [{ op: 'set_enclosure_script', script: 'cube([10, 10, 10]); // a box' }] });
    expect(r).toMatchObject({ status: 'rejected', rejection: { code: 'ENCLOSURE_INVALID' } });
  });
});

describe('enclosure graphics', () => {
  const LOGO_PATH = 'M0 0 H20 V10 H0 Z M3 3 H8 V7 H3 Z';
  const drawn = SCRIPT.replace('translate([0, 0, 6], cube([10, 10, 1]))', "translate([0, 0, 6], linear_extrude(graphic('logo', { width: 8 }), 1))");

  it('are kept in the design, centred, and become a hunk of their own', () => {
    const k = kernel();
    const r = k.transact({ summary: 'logo', ops: [{ op: 'set_enclosure_graphic', name: 'logo', svg_path: LOGO_PATH }] });
    expect(r.status).toBe('ok');
    const g = k.draftDesign().enclosure!.graphics![0]!;
    expect(g).toMatchObject({ name: 'logo', mode: 'fill', w: 20, h: 10, source: 'SVG path' });
    expect(g.polys[0]).toEqual([-10, -5, 10, -5, 10, 5, -10, 5]);
    expect(k.proposal()!.hunks.map((h) => h.id)).toEqual(['enclosure:graphics']);
    expect((k.query({ op: 'get_enclosure' }) as { graphics: unknown[] }).graphics).toEqual([{ name: 'logo', size_mm: [20, 10], mode: 'filled', figures: 2, source: 'SVG path' }]);
    // the script may draw it now; accepting the script alone leaves the graphic out
    expect(k.transact({ summary: 'box', ops: [{ op: 'set_enclosure_script', script: drawn }] }).status).toBe('ok');
    k.accept(['enclosure:graphics'], 'user');
    expect(k.committedDesign().enclosure).toEqual({ graphics: [g] });
    // removing it removes the enclosure that was only it
    expect(k.transact({ summary: 'no logo', ops: [{ op: 'set_enclosure_graphic', name: 'logo', remove: true }] }).status).toBe('ok');
    expect(k.draftDesign().enclosure).toBeUndefined();
  });

  it('come from the artwork library by name, outlines and all', () => {
    registerArtwork([{ id: 'acme', name: 'Acme logo', mode: 'outline', line: 0.3, polys: [[-2, -1, 2, -1, 2, 1, -2, 1]], w: 4, h: 2 }]);
    try {
      const k = kernel();
      expect(k.transact({ summary: 'logo', ops: [{ op: 'set_enclosure_graphic', name: 'acme', artwork: 'acme logo' }] }).status).toBe('ok');
      expect(k.draftDesign().enclosure!.graphics![0]).toMatchObject({ name: 'acme', mode: 'outline', line: 0.3, w: 4, h: 2, source: 'artwork Acme logo' });
      const r = k.transact({ summary: 'logo', ops: [{ op: 'set_enclosure_graphic', name: 'other', artwork: 'Nope' }] });
      expect(r).toMatchObject({ status: 'rejected', rejection: { code: 'REF_UNKNOWN', candidates: ['Acme logo'] } });
    } finally {
      unregisterArtwork('acme');
    }
  });

  it('a script cannot draw a graphic the design does not have', () => {
    const k = kernel();
    const r = k.transact({ summary: 'box', ops: [{ op: 'set_enclosure_script', script: drawn }] });
    expect(r).toMatchObject({ status: 'rejected', rejection: { code: 'ENCLOSURE_INVALID' } });
    expect(JSON.stringify(r)).toContain("graphic('logo'): there is no such graphic");
    // in one transaction: the graphic first, then the script
    expect(k.transact({ summary: 'box', ops: [{ op: 'set_enclosure_graphic', name: 'logo', svg_path: LOGO_PATH }, { op: 'set_enclosure_script', script: drawn }] }).status).toBe('ok');
    // neither both nor none of artwork and svg_path
    expect(k.transact({ summary: 'x', ops: [{ op: 'set_enclosure_graphic', name: 'x' }] })).toMatchObject({ status: 'rejected' });
  });

  it('inlays name their host among the pieces', () => {
    const inlaid = `${SCRIPT.replace("['base', 'lid']", "['base', 'lid', 'lid_text']")}function lid_text() { return cube(1); }\nconst inlays = { lid_text: { host: 'lid', colour: '#ffffff' } };\n`;
    expect(scriptInlays(inlaid)).toEqual({ lid_text: { host: 'lid', colour: '#ffffff' } });
    expect(scriptInlays(SCRIPT)).toEqual({});
    expect(scriptProblems(inlaid)).toEqual([]);
    expect(scriptProblems(inlaid.replace("{ host: 'lid', colour: '#ffffff' }", "{ host: 'cover' }")).join(' ')).toContain('"cover", which is not in pieces');
    expect(scriptProblems(inlaid.replace("lid_text: { host: 'lid', colour: '#ffffff' }", "lid_text: { host: 'lid' }, lid: { host: 'base' }")).join(' ')).toContain('itself an inlay');
    expect(scriptProblems(inlaid.replace("{ host: 'lid', colour: '#ffffff' }", '"lid"')).join(' ')).toContain('inlays is plain text');
  });
});
