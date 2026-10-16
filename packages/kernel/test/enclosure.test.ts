import { describe, expect, it } from 'vitest';
import { boardFacing, boardSummary, scriptPieces, scriptProblems, type EnclosureBrief } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

function kernel() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k;
}

const SCRIPT = `include <board.scad>
wall = 2;
pieces = ["base", "lid"];
piece = "all";
module base() { cube([10, 10, 5]); }
module lid() { translate([0, 0, 6]) cube([10, 10, 1]); }
if (piece == "base" || piece == "all") base();
if (piece == "lid" || piece == "all") lid();
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
    expect(scriptProblems('cube(1);').join(' ')).toMatch(/include <board.scad>.*pieces/);
    expect(scriptProblems(SCRIPT.replace('module lid()', 'module cover()')).join(' ')).toContain('no module lid()');
    expect(scriptProblems(`${SCRIPT}\nimport("/etc/passwd");`).join(' ')).toContain('import()');
    expect(scriptProblems(`${SCRIPT}\ninclude <../secrets.scad>`).join(' ')).toContain('only board.scad');
    // commented out, it does not count
    expect(scriptProblems(`${SCRIPT}\n// import("x.stl");`)).toEqual([]);
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
