import { describe, expect, it } from 'vitest';
import type { BoardView, SheetView } from '@4k7/schema';
import { boardViewInfo, formatDesignContext, formatView, schematicViewInfo } from '../src/index.ts';

const sym = (refdes: string, x: number, y: number, unit?: string) => ({ refdes, componentId: refdes, ...(unit ? { unit } : {}), bbox: { x, y, w: 400, h: 300 } });
// two pages side by side, 11000 × 8000 mils each
const sheet = {
  name: 'Power',
  bbox: { x: 0, y: 0, w: 22000, h: 8000 },
  pages: [
    { number: 2, rect: { x: 0, y: 0, w: 11000, h: 8000 } },
    { number: 3, rect: { x: 11000, y: 0, w: 11000, h: 8000 } },
  ],
  symbols: [sym('U1', 1000, 1000), sym('C2', 1600, 1000), sym('R10', 3000, 3000), sym('U3', 10800, 1000, 'B'), sym('R2', 1700, 1000)],
} as unknown as SheetView;

const base = {
  summary: { name: 'x', sheets: ['Power'], pages: 2, components: [], nets: [], counts: { errors: 0, warnings: 0, infos: 0, waived: 0 }, ledger: 0, waivers: 0 },
  diagnostics: [],
  ledger: [],
  selection: [],
};

describe('the user\'s view', () => {
  it('lists the parts in a zoomed schematic area and gives it in page coordinates', () => {
    const v = schematicViewInfo(sheet, { x: 500, y: 500, w: 11000, h: 2000 });
    expect(v.whole).toBe(false);
    expect(v.parts).toEqual(['C2', 'R2', 'U1', 'U3B']);
    expect(v.partly).toEqual([]);
    expect(v.pages).toEqual([
      { number: 2, rect: { x: 500, y: 500, w: 10500, h: 2000 } },
      { number: 3, rect: { x: 0, y: 500, w: 500, h: 2000 } },
    ]);
    const t = formatView(v);
    expect(t).toContain('<view kind="schematic" sheet="Power" zoomed="yes">');
    expect(t).toContain('page 2 x 500–11000, y 500–2500; page 3 x 0–500, y 500–2500');
    expect(t).toContain('parts in view: C2 R2 U1 U3B');
    expect(t).toContain('get_schematic_image with area: true');
  });

  it('names the parts the edge cuts', () => {
    const v = schematicViewInfo(sheet, { x: 1300, y: 900, w: 500, h: 500 });
    expect(v.parts).toEqual([]);
    expect(v.partly).toEqual(['C2', 'R2', 'U1']);
    expect(formatView(v)).toContain('no whole part in view');
  });

  it('says so when the whole sheet is shown, without listing every part', () => {
    const t = formatView(schematicViewInfo(sheet, { x: -100, y: -500, w: 22200, h: 9000 }));
    expect(t).toContain('zoomed="no"');
    expect(t).toContain('the whole sheet (pages 2, 3)');
    expect(t).not.toContain('parts in view');
  });

  it('gives a zoomed board area in mm with the parts in it', () => {
    const part = (refdes: string, x: number, y: number) => ({ refdes, componentId: refdes, courtyard: { x, y, w: 2, h: 1 } });
    const board = { outline: { w: 50, h: 40 }, parts: [part('U1', 10, 10), part('C1', 13, 10), part('J1', 40, 30), { ...part('H1', 11, 11), componentId: 'hole:1' }] } as unknown as BoardView;
    const v = boardViewInfo(board, { x: 8.04, y: 8, w: 9.5, h: 6.33 });
    expect(v.parts).toEqual(['C1', 'U1']);
    const t = formatView(v);
    expect(t).toContain('<view kind="board" zoomed="yes">');
    expect(t).toContain('x 8–17.5, y 8–14.3 mm');
    expect(t).toContain('get_board_image with area: true');
    expect(boardViewInfo(board, { x: -3, y: -3, w: 56, h: 46 }).whole).toBe(true);
  });

  it('gives the cut through the box the user looks at, and the render that shows it', () => {
    const t = formatView({ view: 'enclosure', axis: 'y', normal: [0, 1, 0], at_mm: 13.7, through: 'J1', offset_mm: 0, removed: '-', opened: false });
    expect(t).toContain('<view kind="enclosure">');
    expect(t).toContain("the plane y = 13.7 mm (board.scad), through J1's centre; the −y half cut away");
    expect(t).toContain('render_enclosure section: { axis: "y", at_mm: 13.7 } shows this plane');
    const moved = formatView({ view: 'enclosure', axis: 'x', normal: [1, 0, 0], at_mm: 4, removed: '+', opened: true });
    expect(moved).toContain('the plane x = 4 mm (board.scad); the +x half cut away; the pieces lifted apart');
    // askew, through a turned part's opening: no section reproduces it, the opening's picture does
    const askew = formatView({ view: 'enclosure', normal: [0.707, 0.707, 0], at_mm: 12, through: 'J2', offset_mm: -2, removed: '+', opened: false });
    expect(askew).toContain("across the wall along J2's plug's way, 2 mm off J2's centre: the plane n · p = 12 mm, n = (0.707, 0.707, 0)");
    expect(askew).toContain('views: ["sections"]');
  });

  it('travels in the design context after the selection; an Optimize scope replaces it', () => {
    const view = schematicViewInfo(sheet, { x: 500, y: 500, w: 3000, h: 2000 });
    const t = formatDesignContext({ ...base, selection: ['R10'], view });
    expect(t.indexOf('<selection>')).toBeLessThan(t.indexOf('<view'));
    expect(formatDesignContext({ ...base, view: null })).not.toContain('<view');
  });
});
