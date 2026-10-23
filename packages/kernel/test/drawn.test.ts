import { describe, expect, it } from 'vitest';
import type { BoardView, Design } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

function buck() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k;
}

const ok = (k: Kernel, ops: unknown[]) => {
  const r = k.transact({ summary: 'test', ops });
  if (r.status !== 'ok') throw new Error(JSON.stringify(r));
  return r;
};
const pad = (b: BoardView, ref: string, n: string) => b.parts.find((p) => p.refdes === ref)!.pads.find((p) => p.number === n)!;
const netId = (k: Kernel, name: string) => Object.values(k.draftDesign().nets).find((n) => n.name === name)!.id;
const openOf = (b: BoardView, id: string) => b.unrouted.filter((u) => u.netId === id);

describe('drawn copper', () => {
  it('starting empty, every connection is open and none is routed for the agent', () => {
    const k = buck();
    ok(k, [{ op: 'set_copper_mode', mode: 'drawn', keep: false }]);
    const b = k.board();
    expect(b.routing).toBe('done');
    expect(b.drawn).toEqual({ tracks: [], vias: [] });
    expect(b.tracks.filter((t) => (t as { id?: string }).id)).toEqual([]);
    expect(b.unrouted.length).toBeGreaterThan(0);
    expect(b.diagnostics.some((x) => x.code === 'DRC.UNROUTED' && x.severity === 'error' && x.message.includes('not drawn yet'))).toBe(true);
  });

  it('a track drawn pad to pad closes that connection, and its ends follow the pads when a part moves', () => {
    const k = buck();
    ok(k, [{ op: 'set_copper_mode', mode: 'drawn', keep: false }]);
    const ss = netId(k, 'SS');
    expect(openOf(k.board(), ss)).toHaveLength(1);
    const r = ok(k, [{ op: 'draw_track', from: 'U1.SS', to: 'C3.1' }]);
    expect(r.results[0]!.effect).toMatch(/^track t1: SS on F\.Cu/);
    const b = k.board();
    expect(openOf(b, ss)).toEqual([]);
    const t = b.drawn!.tracks[0]!;
    expect(t.from?.pad).toBeDefined();
    const c3 = b.parts.find((p) => p.refdes === 'C3')!;
    ok(k, [{ op: 'place', ref: 'C3', x_mm: c3.x + 1, y_mm: c3.y, lock: true }]);
    const moved = k.board();
    const p = pad(moved, 'C3', '1');
    const mt = moved.drawn!.tracks[0]!;
    expect([mt.pts.at(-2), mt.pts.at(-1)]).toEqual([Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000]);
    expect(openOf(moved, ss)).toEqual([]);
  });

  it('hard rules are errors (a track over another net\'s pad), soft ones warnings (a dangling end, off 45°)', () => {
    const k = buck();
    ok(k, [{ op: 'set_copper_mode', mode: 'drawn', keep: false }]);
    const b0 = k.board();
    const vin = pad(b0, 'U1', b0.parts.find((p) => p.refdes === 'U1')!.pads.find((q) => q.netId === netId(k, '+12V'))!.number);
    // an SS track straight across U1's +12V pad: a short
    ok(k, [{ op: 'draw_track', net: 'SS', from: [vin.x - 3, vin.y], to: [vin.x + 3, vin.y + 0.7] }]);
    const b = k.board();
    expect(b.diagnostics.some((x) => (x.code === 'DRC.SHORT' || x.code === 'DRC.CLEARANCE') && x.severity === 'error')).toBe(true);
    expect(b.diagnostics.some((x) => x.code === 'DRAW.DANGLING' && x.severity === 'warning')).toBe(true);
    expect(b.diagnostics.some((x) => x.code === 'DRAW.ANGLE' && x.severity === 'warning')).toBe(true);
    // copper too near the straight board edge is an error too (the router never goes there)
    ok(k, [{ op: 'erase_copper', all: true }, { op: 'draw_track', net: 'SS', from: [0.1, 2], to: [0.1, 6] }]);
    expect(k.board().diagnostics.some((x) => x.code === 'DRC.EDGE_CLEARANCE' && x.severity === 'error')).toBe(true);
  });

  it('the route helper lays only what it is asked for, round the drawn copper, as drawn copper', () => {
    const k = buck();
    ok(k, [{ op: 'set_copper_mode', mode: 'drawn', keep: false }, { op: 'draw_track', from: 'U1.SS', to: 'C3.1' }]);
    const before = k.board();
    const fb = netId(k, 'FB');
    expect(openOf(before, fb).length).toBeGreaterThan(0);
    const r = ok(k, [{ op: 'route', nets: ['FB'] }]);
    expect(r.results[0]!.effect).toMatch(/route helper \(FB\)/);
    const b = k.board();
    expect(openOf(b, fb)).toEqual([]);
    // the SS track is untouched; the new copper is FB's only, with ids
    expect(b.drawn!.tracks[0]).toEqual(before.drawn!.tracks[0]);
    const added = b.drawn!.tracks.slice(1);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((t) => t.netId === fb && t.id.startsWith('t'))).toBe(true);
    // other nets stay open
    expect(openOf(b, netId(k, 'COMP')).length).toBeGreaterThan(0);
    // and it can be erased again
    ok(k, [{ op: 'erase_copper', nets: ['FB'] }]);
    expect(openOf(k.board(), fb).length).toBeGreaterThan(0);
  });

  it('takes the router\'s copper over, and survives a round trip through the file', () => {
    const k = buck();
    ok(k, [{ op: 'route' }]);
    k.accept();
    const routed = k.board();
    expect(k.keepCopper(routed.newCopper!)).toBe(true);
    ok(k, [{ op: 'set_copper_mode', mode: 'drawn' }]);
    k.accept();
    const b = k.board();
    expect(b.drawn!.tracks.length).toBeGreaterThan(0);
    expect(b.unrouted).toEqual(routed.unrouted);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    const back = new Kernel(JSON.parse(k.exportDesign()) as Design).board();
    expect(back.drawn).toEqual(b.drawn);
    expect(back.unrouted).toEqual(b.unrouted);
    // back to the router: the drawn copper goes
    ok(k, [{ op: 'set_copper_mode', mode: 'router' }]);
    expect(k.board().drawn).toBeUndefined();
  });

  it('get_copper lists the drawn copper by id; draw ops refuse while the copper is the router\'s', () => {
    const k = buck();
    const r = k.transact({ summary: 'x', ops: [{ op: 'draw_track', from: 'U1.SS', to: 'C3.1' }] });
    expect(r.status).toBe('rejected');
    ok(k, [{ op: 'set_copper_mode', mode: 'drawn', keep: false }, { op: 'draw_track', from: 'U1.SS', to: 'C3.1', via: [[10, 10]] }, { op: 'draw_via', net: 'GND', at: [5, 5] }]);
    const q = k.query({ op: 'get_copper' }) as { tracks: { id: string; net: string; pts: number[][]; from?: string }[]; vias: { id: string }[] };
    expect(q.tracks.map((t) => [t.id, t.net, t.pts.length])).toEqual([['t1', 'SS', 3]]);
    expect(q.tracks[0]!.from).toBe('U1.SS'.replace('SS', q.tracks[0]!.from!.split('.')[1]!));
    expect(q.vias.map((v) => v.id)).toEqual(['v2']);
  });
});
