import { describe, expect, it } from 'vitest';
import type { CopperCheck } from '@4k7/fab';
import type { BoardView } from '@4k7/schema';
import { FabWatch } from '../src/lib/fabFindings.ts';

/** A routed board of one part whose copper is told apart by `x` (where its track ends). */
const board = (x: number, routing: BoardView['routing'] = 'done') =>
  ({
    outline: { x: 0, y: 0, w: 20, h: 10 },
    layers: ['F.Cu', 'B.Cu'],
    parts: [{ refdes: 'J1', pads: [{ number: '1', x: 2, y: 3, w: 1, h: 1, shape: 'rect', netId: 'n1' }] }],
    tracks: [{ layer: 'F.Cu', width: 0.25, pts: [2, 3, x, 3], netId: 'n1' }],
    vias: [],
    zones: [],
    netNames: { n1: 'GND' },
    routing,
  }) as unknown as BoardView;

/** What the files of a board show: a short at (5, 7) in the files' coordinates (y up). */
const short: CopperCheck = {
  findings: [{ kind: 'short', nets: ['+5V', 'GND'], text: 'GND and +5V are joined in the files: J1.1 (GND) touches copper of +5V on In2.Cu', layer: 'In2.Cu', at: { x: 5, y: 7 }, area: [4, 6, 6, 8], pads: ['J1.1'] }],
  found: 1, total: 1, notFound: [], openInDesign: 0, copper: {}, nets: 2, layers: ['F.Cu', 'B.Cu'], holes: 0, resolution: 0.02, ms: 1,
};

function watch() {
  const checked: BoardView[] = [];
  const w = new FabWatch(async (b) => (checked.push(b), short), () => {}, 0);
  return { w, checked };
}

describe('the production files\' findings of the routed board', () => {
  it('shows a short of the files as FAB.SHORT, an error where the board has it', async () => {
    const { w } = watch();
    w.update(board(10), true);
    const ds = await w.settled();
    expect(ds).toEqual([expect.objectContaining({ code: 'FAB.SHORT', severity: 'error', at: { x: 5, y: 3 }, entities: ['J1.1', 'net:+5V', 'net:GND'] })]);
    expect(ds[0]!.message).toMatch(/^Production files: GND and \+5V/);
  });

  it('checks once for edits in a row: the last board', async () => {
    const { w, checked } = watch();
    w.update(board(10), true);
    w.update(board(11), true);
    w.update(board(12), true);
    await w.settled();
    expect(checked.map((b) => b.tracks[0]!.pts[2])).toEqual([12]);
  });

  it('drops the findings when the copper changes, and has them again at once when it comes back', async () => {
    const { w, checked } = watch();
    const a = board(10);
    w.update(a, true);
    expect(await w.settled()).toHaveLength(1);
    // laid again, not routed yet: nothing to show
    w.update(board(11), false);
    expect(w.current()).toEqual([]);
    // routed with other copper: not the first board's findings
    w.update(board(11), true);
    expect(w.current()).toEqual([]);
    expect(await w.settled()).toHaveLength(1);
    // the first copper again (undo): its findings without a new check
    w.update(board(10), true);
    expect(w.current()).toHaveLength(1);
    expect(checked).toHaveLength(2);
  });

  it('does not check a board whose routing is not done, or a board without parts', async () => {
    const { w, checked } = watch();
    w.update(board(10, 'stale'), true);
    w.update({ ...board(10), parts: [] }, true);
    expect(await w.settled()).toEqual([]);
    expect(checked).toEqual([]);
  });

  it('shows nothing when the check fails', async () => {
    const w = new FabWatch(() => Promise.reject(new Error('replaced by a newer check')), () => {}, 0);
    w.update(board(10), true);
    expect(await w.settled()).toEqual([]);
  });
});
