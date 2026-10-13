import { describe, expect, it } from 'vitest';
import { boardDimensions, dimPaths } from '../src/lib/dimensions.ts';

const hole = (id: string, x: number, y: number, d = 3.2, plated = false) => ({
  componentId: `hole:${id}`,
  x,
  y,
  pads: [{ drill: d, w: d + 1, ...(plated ? {} : { npth: true }) }],
});
const board = (w: number, h: number, holes: ReturnType<typeof hole>[] = []) =>
  ({ outline: { w, h }, parts: [...holes, { componentId: 'c1', x: 10, y: 10, pads: [] }] }) as unknown as Parameters<typeof boardDimensions>[0];

describe('board dimensions', () => {
  it('a board without holes: its width above and its height to the left', () => {
    const d = boardDimensions(board(50, 30));
    expect(d.dims.map((x) => [x.dir, x.text])).toEqual([['h', '50 mm'], ['v', '30 mm']]);
    const [wd, hd] = d.dims;
    expect(wd!.at).toBeLessThan(0);
    expect(wd!.tx).toBe(25);
    expect(hd!.at).toBeLessThan(0);
    expect(hd!.ty).toBe(15);
    expect(d.notes).toEqual([]);
  });

  it('four corner holes: a chain from the edges inside the overall dimensions, and their diameters', () => {
    const d = boardDimensions(board(50, 30, [hole('H1', 3.5, 3.5), hole('H2', 46.5, 3.5), hole('H3', 3.5, 26.5), hole('H4', 46.5, 26.5, 3.2, true)]));
    const along = d.dims.filter((x) => x.dir === 'h' && !x.text.endsWith('mm'));
    const down = d.dims.filter((x) => x.dir === 'v' && !x.text.endsWith('mm'));
    expect(along.map((x) => x.text)).toEqual(['3.5', '43', '3.5']);
    expect(down.map((x) => x.text)).toEqual(['3.5', '23', '3.5']);
    // the overall width runs a row further out than the chain on the same side
    expect(d.dims.find((x) => x.text === '50 mm')!.at).toBeLessThan(along[0]!.at);
    // the extension lines start at the holes nearest the chain (the upper ones), not across the board
    expect(along[1]!.y1).toBeLessThan(3.5);
    expect(along[1]!.y1).toBeGreaterThan(0);
    expect(d.notes.map((n) => n.text)).toEqual(['Ø3.2', 'Ø3.2', 'Ø3.2', 'Ø3.2 plated']);
    // a corner hole's note points into the board
    expect(d.notes[1]!.anchor).toBe('end');
    expect(d.notes[1]!.x).toBeLessThan(46.5);
    expect(d.notes[0]!.anchor).toBe('start');
  });

  it('holes along the bottom right: their chains go below and to the right', () => {
    const d = boardDimensions(board(50, 30, [hole('H1', 40, 26)]));
    expect(d.dims.find((x) => x.dir === 'h' && x.text === '40')!.at).toBeGreaterThan(30);
    expect(d.dims.find((x) => x.dir === 'v' && x.text === '26')!.at).toBeGreaterThan(50);
    expect(d.dims.find((x) => x.text === '50 mm')!.at).toBeLessThan(0);
  });

  it('a short segment: the arrows point in from outside, the text sits past it, inside the extent', () => {
    const d = boardDimensions(board(50, 30, [hole('H1', 0.8, 15, 1)]));
    const first = d.dims.find((x) => x.dir === 'h' && x.text === '0.8')!;
    expect(first.outside).toBe(true);
    expect(first.tx).toBeLessThan(0);
    expect(-first.tx).toBeLessThan(d.extent);
    const { lines, arrows } = dimPaths(first, d.arrow);
    expect(lines).toMatch(/^M/);
    expect(arrows.match(/Z/g)).toHaveLength(2);
  });
});
