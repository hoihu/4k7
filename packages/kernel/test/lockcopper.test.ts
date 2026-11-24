import { describe, expect, it } from 'vitest';
import { boardSummary, type Track } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buck } from './fixtures.ts';

/**
 * lock_copper / unlock_copper: a net's routed copper kept exactly as it lies, laid first on every
 * route and never ripped up (docs/design/layout.md §5.9).
 */
/** The buck routed, its copper kept with the design (as the app does when routing finishes). */
function routed() {
  const k = buck();
  k.transact({ summary: 'route', ops: [{ op: 'route' }] });
  k.keepCopper(k.board().newCopper!);
  return k;
}

/** Route as the app does: the route step, then the copper kept with the design. */
function reroute(k: Kernel) {
  k.transact({ summary: 'route', ops: [{ op: 'route' }] });
  const c = k.board().newCopper;
  if (c) k.keepCopper(c);
  return k.board();
}

const geometry = (ts: Track[]) => ts.map(({ netId, layer, width, pts }) => ({ netId, layer, width, pts }));
const sw = (k: Kernel) => k.board().tracks.filter((t) => k.board().netNames[t.netId] === 'SW');

describe('lock_copper', () => {
  it('needs the board routed as it stands', () => {
    const k = buck();
    const r = k.transact({ summary: 'lock', ops: [{ op: 'lock_copper', nets: ['SW'] }] });
    expect(r.status).toBe('rejected');
    expect(JSON.stringify(r)).toMatch(/route first/);
  });

  it('refuses a net it does not know, and one with no routed tracks', () => {
    const k = routed();
    expect(k.transact({ summary: 'lock', ops: [{ op: 'lock_copper', nets: ['NOPE'] }] }).status).toBe('rejected');
    // a net on one pin: nothing to route
    k.transact({ summary: 'en', ops: [{ op: 'connect', pins: ['U1.3'], net: 'EN' }] });
    reroute(k);
    const r = k.transact({ summary: 'lock', ops: [{ op: 'lock_copper', nets: ['EN'] }] });
    expect(r.status).toBe('rejected');
    expect(JSON.stringify(r)).toMatch(/EN has no routed tracks to lock/);
  });

  it('keeps a net\'s copper exactly as it lies, without making the routing out of date', () => {
    const k = routed();
    const before = geometry(sw(k));
    expect(before.length).toBeGreaterThan(0);
    const r = k.transact({ summary: 'lock', ops: [{ op: 'lock_copper', nets: ['SW'] }] });
    expect(r.status).toBe('ok');
    expect(r.results![0]!.effect).toMatch(/^locked the copper of SW \(3 tracks, 0 vias\)/);
    const b = k.board();
    expect(b.routing).toBe('done');
    expect(geometry(sw(k).filter((t) => t.locked))).toEqual(before);
    expect(sw(k).every((t) => t.locked)).toBe(true);
    expect(b.locked).toEqual([{ netId: expect.any(String), tracks: before.length, vias: 0, heldTracks: before.length, heldVias: 0 }]);
    expect(b.unrouted).toEqual([]);
    expect(b.diagnostics.filter((x) => x.code === 'DRC.LOCKED_BROKEN')).toEqual([]);
    const s = boardSummary(b) as { locked_copper?: { net: string; state: string }[] };
    expect(s.locked_copper).toEqual([expect.objectContaining({ net: 'SW', tracks: 3, vias: 0, state: 'laid as locked' })]);
    // (kept with the design as it lay)
    k.accept();
    const saved = JSON.parse(k.exportDesign()) as { board: { locked: { tracks: Track[] }[] } };
    expect(geometry(saved.board.locked[0]!.tracks)).toEqual(before);
    expect(saved.board.locked[0]!.tracks.some((t) => t.locked)).toBe(false);
  });

  it('a route after an unrelated change does not rip it up', () => {
    const k = routed();
    k.transact({ summary: 'lock', ops: [{ op: 'lock_copper', nets: ['SW'] }] });
    k.keepCopper(k.board().newCopper!);
    const before = geometry(sw(k));
    // C5 is far from the switch node; FB's width changes the copper too
    const c5 = k.board().parts.find((p) => p.refdes === 'C5')!;
    k.transact({ summary: 'move', ops: [{ op: 'place', ref: 'C5', x_mm: c5.x - 1, y_mm: c5.y }, { op: 'set_net', net: 'FB', track_mm: 0.4 }] });
    expect(k.board().routing).toBe('stale');
    const b = reroute(k);
    expect(b.routing).toBe('done');
    expect(geometry(sw(k))).toEqual(before);
    expect(b.locked![0]!.heldTracks).toBe(before.length);
    expect(b.unrouted).toEqual([]);
  });

  it('a part moved off it breaks what it touched: said so, and still kept as locked', () => {
    const k = routed();
    k.transact({ summary: 'lock', ops: [{ op: 'lock_copper', nets: ['SW'] }] });
    k.keepCopper(k.board().newCopper!);
    const d1 = k.board().parts.find((p) => p.refdes === 'D1')!;
    const c4 = k.board().parts.find((p) => p.refdes === 'C4')!;
    // 2 mm to the left: its SW pad comes down on the locked track that ran from it to C4
    k.transact({ summary: 'move', ops: [{ op: 'place', ref: 'D1', x_mm: d1.x - 2, y_mm: d1.y }] });
    const b = reroute(k);
    expect(b.locked).toEqual([{ netId: expect.any(String), tracks: 3, vias: 0, heldTracks: 1, heldVias: 0 }]);
    expect(b.diagnostics.find((x) => x.code === 'DRC.LOCKED_BROKEN')!.message).toMatch(/^Only 1 of 3 locked tracks and 0 of 0 vias of SW still fit the board as it is/);
    const s = boardSummary(b) as { locked_copper?: { net: string; state: string }[] };
    expect(s.locked_copper![0]!.state).toMatch(/^1 of 3 tracks and 0 of 0 vias still fit the board as it is/);
    expect(b.unrouted).toEqual([]);
    // (not dropped: a part put back where it was gets it back)
    k.accept();
    const saved = JSON.parse(k.exportDesign()) as { board: { locked: { tracks: unknown[] }[] } };
    expect(saved.board.locked[0]!.tracks).toHaveLength(3);
    // (the placer moved C4 out of D1's way: both go back)
    k.transact({ summary: 'back', ops: [{ op: 'place', ref: 'D1', x_mm: d1.x, y_mm: d1.y }, { op: 'place', ref: 'C4', x_mm: c4.x, y_mm: c4.y }] });
    const back = reroute(k);
    expect(back.locked![0]!.heldTracks).toBe(3);
    expect(back.diagnostics.filter((x) => x.code === 'DRC.LOCKED_BROKEN')).toEqual([]);
  });

  it('unlock_copper lets it go: the router may route it its own way again', () => {
    const k = routed();
    k.transact({ summary: 'lock', ops: [{ op: 'lock_copper', nets: ['SW', 'BOOT'] }] });
    k.keepCopper(k.board().newCopper!);
    expect(k.transact({ summary: 'unlock', ops: [{ op: 'unlock_copper', nets: ['SW'] }] }).status).toBe('ok');
    expect(k.board().routing).toBe('done');
    expect(k.board().locked!.map((l) => k.board().netNames[l.netId])).toEqual(['BOOT']);
    expect(sw(k).some((t) => t.locked)).toBe(false);
    expect(sw(k).length).toBeGreaterThan(0);
    expect(k.transact({ summary: 'unlock', ops: [{ op: 'unlock_copper', nets: ['all'] }] }).status).toBe('ok');
    expect(k.board().locked).toBeUndefined();
    expect(k.board().tracks.some((t) => t.locked)).toBe(false);
    expect(k.transact({ summary: 'unlock', ops: [{ op: 'unlock_copper', nets: ['SW'] }] }).status).toBe('rejected');
  });

  it('switching to drawn copper takes the locked copper over as the agent\'s own and drops the lock', () => {
    const k = routed();
    k.transact({ summary: 'lock', ops: [{ op: 'lock_copper', nets: ['SW'] }] });
    k.keepCopper(k.board().newCopper!);
    const before = geometry(sw(k));
    const r = k.transact({ summary: 'mode', ops: [{ op: 'set_copper_mode', mode: 'drawn' }] });
    expect(r.status).toBe('ok');
    expect(r.results![0]!.effect).toMatch(/the locked copper of 1 net\(s\) with them/);
    expect(k.draftDesign().board?.locked).toBeUndefined();
    const b = k.board();
    expect(b.locked).toBeUndefined();
    const mine = b.drawn!.tracks.filter((t) => b.netNames[t.netId] === 'SW');
    expect(geometry(mine)).toEqual(before);
    // the agent's own (not the helper's), without the router's mark
    expect(mine.every((t) => !t.by)).toBe(true);
    expect(b.drawn!.tracks.some((t) => t.locked)).toBe(false);
    // nothing to lock in drawn copper: it is all the agent's already
    expect(k.transact({ summary: 'lock', ops: [{ op: 'lock_copper', nets: ['SW'] }] }).status).toBe('rejected');
  });
});
