import { describe, expect, it } from 'vitest';
import { boardSummary, type BoardView, type Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { resolveBoard } from '../src/boards.ts';
import { buckTransaction } from './fixtures.ts';

/**
 * draw_track while the router lays the copper: one connection laid as the agent asks, kept in the
 * design, laid first on every route (docs/design/layout.md §5.8).
 */
function buck() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  k.transact({ summary: 'route', ops: [{ op: 'route' }] });
  return k;
}

/** The track passes within 0.06 mm of (x, y). */
const passes = (pts: number[], x: number, y: number) => {
  for (let q = 0; q + 3 < pts.length; q += 2) {
    const [ax, ay, bx, by] = [pts[q]!, pts[q + 1]!, pts[q + 2]!, pts[q + 3]!];
    const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const u = l2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2)) : 0;
    if (Math.hypot(ax + u * (bx - ax) - x, ay + u * (by - ay) - y) < 0.06) return true;
  }
  return false;
};

describe('draw_track with router copper', () => {
  it('lays the switch node as asked: through its point, at its width, and the route keeps it', () => {
    const k = buck();
    const r = k.transact({ summary: 'sw', ops: [{ op: 'draw_track', from: 'U1.8', to: 'D1.1', layer: 'F.Cu', width_mm: 0.8, via: [[15.5, 7.5]] }] });
    expect(r.status).toBe('ok');
    // the board changed: routing is out of date until route runs
    expect(k.board().routing).toBe('stale');
    expect(k.board().laid).toEqual([{ id: 't1', netId: expect.any(String), from: 'U1.8', to: 'D1.1', layer: 'F.Cu', width: 0.8, through: [{ x: 15.5, y: 7.5 }] }]);
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.laid![0]!.laid).toBe(true);
    const mine = b.tracks.filter((t) => t.laid === 't1');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((t) => t.layer === 'F.Cu')).toBe(true);
    expect(mine.some((t) => t.width === 0.8)).toBe(true);
    expect(mine.some((t) => passes(t.pts, 15.5, 7.5))).toBe(true);
    expect(b.unrouted).toEqual([]);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    const s = boardSummary(b) as { laid_tracks?: { id: string; state: string }[] };
    expect(s.laid_tracks).toEqual([expect.objectContaining({ id: 't1', from: 'U1.8', to: 'D1.1', state: 'laid as asked' })]);
  });

  it('moves with the parts: the point near a part follows it, and the track is laid again there', () => {
    const k = buck();
    k.transact({ summary: 'sw', ops: [{ op: 'draw_track', from: 'U1.8', to: 'D1.1', layer: 'F.Cu', via: [[14, 8]] }] });
    const d1 = k.board().parts.find((p) => p.refdes === 'D1')!;
    k.transact({ summary: 'move', ops: [{ op: 'place', ref: 'D1', x_mm: d1.x - 1, y_mm: d1.y }] });
    const b0 = k.board();
    const pad = b0.parts.find((p) => p.refdes === 'D1')!.pads.find((p) => p.number === '1')!;
    // (14, 8) was nearer D1.1 (14, 6.9) than U1.8: it keeps its place relative to that pad
    expect(b0.laid![0]!.through).toEqual([{ x: Math.round(pad.x * 1000) / 1000, y: Math.round((pad.y + 1.1) * 1000) / 1000 }]);
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.laid![0]!.laid).toBe(true);
    expect(b.tracks.filter((t) => t.laid === 't1').some((t) => passes(t.pts, b.laid![0]!.through[0]!.x, b.laid![0]!.through[0]!.y))).toBe(true);
  });

  it('changes layer at a point given one, with a via there', () => {
    const k = buck();
    expect(k.transact({ summary: 'sw', ops: [{ op: 'draw_track', from: 'U1.8', to: 'D1.1', layer: 'F.Cu', via: [[16.5, 8.2, 'B.Cu'], [14, 8.2, 'F.Cu']] }] }).status).toBe('ok');
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.laid![0]!.laid).toBe(true);
    expect(b.vias.filter((v) => v.laid === 't1').map((v) => [v.x, v.y])).toEqual([[16.5, 8.2], [14, 8.2]]);
    expect([...new Set(b.tracks.filter((t) => t.laid === 't1').map((t) => t.layer))].sort()).toEqual(['B.Cu', 'F.Cu']);
    expect(b.unrouted).toEqual([]);
  });

  it('one that finds no way is not laid: the DRC says why, and the router routes the connection', () => {
    const k = buck();
    // through the middle of U1's GND pin (16.5, 10.37), on its layer
    expect(k.transact({ summary: 'sw', ops: [{ op: 'draw_track', from: 'U1.8', to: 'D1.1', layer: 'F.Cu', via: [[16.5, 10.37]] }] }).status).toBe('ok');
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.laid![0]!.laid).toBe(false);
    expect(b.laid![0]!.why).toBe('(16.5, 10.37) has no room for a 0.25 mm track on F.Cu: pad U1.7 (GND) overlaps it (0.2 mm needed)');
    const w = b.diagnostics.find((x) => x.code === 'DRC.TRACK_NOT_LAID')!;
    expect(w.severity).toBe('warning');
    expect(w.message).toMatch(/^t1 \(U1\.8 → D1\.1, SW\) is not laid as asked: /);
    expect(w.entities.sort()).toEqual(['D1', 'U1']);
    expect(b.tracks.some((t) => t.laid)).toBe(false);
    expect(b.unrouted).toEqual([]);
  });

  it('is replaced by a track between the same pads, and taken away by erase_copper', () => {
    const k = buck();
    k.transact({ summary: 'a', ops: [{ op: 'draw_track', from: 'U1.8', to: 'D1.1' }] });
    const r = k.transact({ summary: 'b', ops: [{ op: 'draw_track', from: 'D1.1', to: 'U1.8', layer: 'F.Cu' }] });
    expect(r.status).toBe('ok');
    expect(k.board().laid!.map((t) => [t.id, t.layer])).toEqual([['t1', 'F.Cu']]);
    k.transact({ summary: 'c', ops: [{ op: 'draw_track', from: 'L1.1', to: 'D1.1' }] });
    expect(k.board().laid!.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(k.transact({ summary: 'd', ops: [{ op: 'erase_copper', ids: ['t1'] }] }).status).toBe('ok');
    expect(k.board().laid!.map((t) => t.id)).toEqual(['t2']);
    expect(k.transact({ summary: 'e', ops: [{ op: 'erase_copper', ids: ['t1'] }] }).status).toBe('rejected');
    expect(k.transact({ summary: 'f', ops: [{ op: 'erase_copper', parts: ['L1'] }] }).status).toBe('ok');
    expect(k.board().laid).toBeUndefined();
  });

  it('switching to drawn copper takes the laid copper over and drops the request', () => {
    const k = buck();
    k.transact({ summary: 'a', ops: [{ op: 'draw_track', from: 'U1.8', to: 'D1.1', layer: 'F.Cu', via: [[15.5, 7.5]] }] });
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    // (the app keeps the routed copper with the design)
    k.keepCopper(k.board().newCopper!);
    const r = k.transact({ summary: 'mode', ops: [{ op: 'set_copper_mode', mode: 'drawn' }] });
    expect(r.status).toBe('ok');
    expect(r.results![0]!.effect).toMatch(/the 1 connection\(s\) you laid for the router with them/);
    expect(k.draftDesign().board?.laid).toBeUndefined();
    const b = k.board();
    expect(b.laid).toBeUndefined();
    // the laid copper is the agent's own now (the rest the helper's), without the router's tag
    const own = b.drawn!.tracks.filter((t) => !t.by);
    expect(own.length).toBeGreaterThan(0);
    expect(own.some((t) => passes(t.pts, 15.5, 7.5))).toBe(true);
    expect(b.drawn!.tracks.some((t) => t.laid)).toBe(false);
  });

  it('refuses pads of two nets, a layer the board has not, a point off the board, ends that are not pads', () => {
    const k = buck();
    const bad = (op: Record<string, unknown>) => k.transact({ summary: 'bad', ops: [{ op: 'draw_track', ...op } as never] });
    expect(bad({ from: 'U1.8', to: 'C1.1' }).status).toBe('rejected');
    expect(bad({ from: 'U1.8', to: 'D1.1', layer: 'In1.Cu' }).status).toBe('rejected');
    expect(bad({ from: 'U1.8', to: 'D1.1', layer: 'B.Cu' }).status).toBe('rejected'); // U1.8 is an SMD pad on F.Cu
    expect(bad({ from: 'U1.8', to: 'D1.1', via: [[99, 5]] }).status).toBe('rejected');
    expect(bad({ from: 'U1.8', to: [14, 8] }).status).toBe('rejected');
    expect(bad({ from: 'U1.8', to: 'D1.1', bend: 'diagonal_first' }).status).toBe('rejected');
    expect(k.board().laid).toBeUndefined();
  });

  it('names what blocks a stretch that finds no way: a track laid before it', () => {
    const k = buck();
    // t1 is GND from the top edge to the bottom one on F.Cu: SW on F.Cu cannot cross it
    k.transact({ summary: 'wall', ops: [{ op: 'draw_track', from: 'D1.2', to: 'C5.2', layer: 'F.Cu', via: [[14, 0.9], [12.07, 21.1]] }] });
    k.transact({ summary: 'sw', ops: [{ op: 'draw_track', from: 'C4.2', to: 'L1.1', layer: 'F.Cu' }] });
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.laid!.map((t) => t.laid)).toEqual([true, false]);
    const why = /^no way for a 0\.25 mm track from C4\.2 to L1\.1 on F\.Cu: at \([\d.]+, [\d.]+\) on F\.Cu, a GND track \(t1, laid before this one\) (overlaps it|is [\d.]+ mm from it) \(0\.2 mm needed\)$/;
    expect(b.laid![1]!.why).toMatch(why);
    expect(notLaid(b, 't2')).toContain(b.laid![1]!.why);
    expect(state(b, 't2')).toContain(b.laid![1]!.why);
    // the place it names is on the way, not at the far end
    expect(b.laid![1]!.at!.x).toBeLessThan(15);
  });

  it('names a keep-out that closes the way', () => {
    const k = buck();
    k.transact({ summary: 'ko', ops: [{ op: 'add_keepout', name: 'gap', rect: { x_mm: 12, y_mm: 0, width_mm: 0.8, height_mm: 22 }, layers: ['F.Cu'], forbid: ['tracks'] }] });
    k.transact({ summary: 'sw', ops: [{ op: 'draw_track', from: 'C4.2', to: 'L1.1', layer: 'F.Cu' }] });
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    expect(k.board().laid![0]!.why).toMatch(/^no way for a 0\.25 mm track from C4\.2 to L1\.1 on F\.Cu: at \([\d.]+, [\d.]+\) on F\.Cu, keep-out gap overlaps it$/);
  });

  it('names the pads too close to a via it asks for', () => {
    const k = buck();
    // (16.5, 11) between U1.7 and U1.6: a 0.25 mm track fits there, a 0.6 mm via does not
    k.transact({ summary: 'sw', ops: [{ op: 'draw_track', from: 'U1.8', to: 'D1.1', layer: 'F.Cu', via: [[16.5, 11, 'B.Cu'], [14, 8.2, 'F.Cu']] }] });
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.laid![0]!.why).toBe('no room for a via at (16.5, 11): pad U1.7 (GND) is 0.07 mm from it (0.2 mm needed); pad U1.6 (COMP) is 0.08 mm from it (0.2 mm needed)');
    expect(notLaid(b, 't1')).toContain('pad U1.7 (GND)');
    expect(b.unrouted).toEqual([]);
  });

  it('says so when it is laid narrower than asked, and why', () => {
    const k = buck();
    // 1.2 mm does not fit past U1.1's way out at (9.6, 8.4); 0.5 mm, the widest both pads take, does
    k.transact({ summary: 'sw', ops: [{ op: 'draw_track', from: 'U1.8', to: 'D1.1', layer: 'F.Cu', width_mm: 1.2, via: [[9.6, 8.4]] }] });
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const b = k.board();
    expect(b.laid![0]!.laid).toBe(true);
    expect(b.laid![0]!.why).toMatch(/^laid 0\.5 mm wide, not 1\.2 mm: \(9\.6, 8\.4\) has no room for a 1\.2 mm track on F\.Cu: the way out of pad U1\.1 \(BOOT\) is [\d.]+ mm from it \(0\.2 mm needed\)$/);
    expect(state(b, 't1')).toBe(`laid, but ${b.laid![0]!.why}`);
    expect(notLaid(b, 't1')).toBe('');
  });

  it('says why on the second board of a design too', () => {
    const k = buck();
    const ops: Transaction['ops'] = [
      { op: 'add_sheet', name: 'LED' },
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J3', sheet: 'LED' },
      { op: 'add_part', part: 'generic:R', refdes: 'R4', params: { resistance: '1k' }, sheet: 'LED' },
      { op: 'add_part', part: 'generic:LED', refdes: 'D2', sheet: 'LED' },
      { op: 'connect', pins: ['J3.1', 'R4.1'], net: 'LED_V' },
      { op: 'connect', pins: ['R4.2', 'D2.A'], net: 'LED_A' },
      { op: 'connect', pins: ['J3.2', 'D2.K'], net: 'LED_K' },
      { op: 'add_board', name: 'LED board', sheets: ['LED'] },
    ];
    expect(k.transact({ summary: 'LED board', ops }).status).toBe('ok');
    k.transact({ summary: 'route', ops: [{ op: 'route', board: 'LED board' }] });
    const at = (ref: string, n: string) => k.board({}, resolveBoard(k.draftDesign(), 'LED board').id).parts.find((p) => p.refdes === ref)!.pads.find((p) => p.number === n)!;
    const [k1, a2] = [at('D2', '1'), at('D2', '2')];
    // a via between D2's two pads, and the main board's laid tracks untouched
    const mid = [(k1.x + a2.x) / 2, (k1.y + a2.y) / 2] as const;
    const r = k.transact({ summary: 'led', ops: [{ op: 'draw_track', board: 'LED board', from: 'R4.2', to: `D2.${a2.number}`, layer: 'F.Cu', via: [[mid[0], mid[1], 'B.Cu'], [mid[0] + 1.2, mid[1] + 2.3, 'F.Cu']] }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    k.transact({ summary: 'route', ops: [{ op: 'route', board: 'LED board' }] });
    const b = k.board({}, resolveBoard(k.draftDesign(), 'LED board').id);
    expect(b.laid![0]!.laid).toBe(false);
    expect(b.laid![0]!.why).toMatch(/^no room for a via at \([\d.]+, [\d.]+\): .*D2's land pattern .*pad D2\.1 \(LED_K\) is [\d.]+ mm from it \(0\.2 mm needed\)/);
    expect(notLaid(b, 't1')).toContain("D2's land pattern");
    expect(k.board({}, resolveBoard(k.draftDesign(), 'Main').id).laid).toBeUndefined();
  });
});

/** The DRC.TRACK_NOT_LAID message of laid track `id`. */
const notLaid = (b: BoardView, id: string) => b.diagnostics.find((x) => x.code === 'DRC.TRACK_NOT_LAID' && x.message.startsWith(`${id} `))?.message ?? '';
/** get_board's laid_tracks state of `id`. */
const state = (b: BoardView, id: string) => (boardSummary(b) as { laid_tracks?: { id: string; state: string }[] }).laid_tracks?.find((t) => t.id === id)?.state ?? '';
