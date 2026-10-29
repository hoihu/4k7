import { describe, expect, it } from 'vitest';
import { Kernel } from '@4k7/kernel';
import { fabFiles } from '../src/index.ts';

/** Two resistors on two nets, routed on a 20 × 12 mm board (GND poured on the bottom), with a keep-out or without. */
function files(keepout: boolean) {
  const k = new Kernel();
  const r = k.transact({
    summary: 'pair',
    ops: [
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '1k' } },
      { op: 'connect', pins: ['R1.2', 'R2.1'], net: 'A' },
      { op: 'connect', pins: ['R1.1', 'R2.2'], net: 'GND' },
      { op: 'set_board', width_mm: 20, height_mm: 12 },
      ...(keepout ? [{ op: 'add_keepout', name: 'antenna', rect: { x_mm: 14, y_mm: 6, width_mm: 5, height_mm: 5 }, forbid: ['pours', 'tracks'], layers: ['B.Cu'] }] : []),
      { op: 'route' },
    ],
  });
  if (r.status !== 'ok') throw new Error(JSON.stringify(r.rejection));
  k.accept();
  return Object.fromEntries(fabFiles(k.board(), 'pair').map((f) => [f.name.replace('pair-', ''), f.content]));
}

describe('keep-outs in the fab files', () => {
  it('cut the pour in the copper Gerber and appear in no other file as artwork', () => {
    const [free, kept] = [files(false), files(true)];
    // the pour round the corner of the board is cut: one clear-polarity region, the keep-out's corners (y flipped, 1e-6 mm)
    const regions = (g: string) => g.split('\n').filter((l) => l === 'G36*').length;
    expect(regions(kept['B_Cu.gbr']!)).toBe(regions(free['B_Cu.gbr']!) + 1);
    const cut = kept['B_Cu.gbr']!.split('%LPC*%\n')[1]!;
    expect(cut).toContain('X14000000Y6000000D02*');
    expect(cut).toContain('X19000000Y6000000D01*');
    // (the corners of the area, y flipped about the board's 12 mm)
    expect(cut).toContain('X14000000Y1000000D01*');
    // nothing else of the board changes: the keep-out is no artwork
    for (const name of Object.keys(free)) {
      if (name === 'B_Cu.gbr') continue;
      expect(kept[name], name).toEqual(free[name]);
    }
  });
});
