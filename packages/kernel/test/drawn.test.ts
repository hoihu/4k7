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

const octilinear = (pts: number[]) => {
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const [dx, dy] = [Math.abs(pts[i + 2]! - pts[i]!), Math.abs(pts[i + 3]! - pts[i + 1]!)];
    if (dx > 0.002 && dy > 0.002 && Math.abs(dx - dy) > 0.002) return false;
  }
  return true;
};
const drawnBuck = () => {
  const k = buck();
  ok(k, [{ op: 'set_copper_mode', mode: 'drawn', keep: false }]);
  return k;
};
const part = (b: BoardView, ref: string) => b.parts.find((p) => p.refdes === ref)!;
const trackOf = (b: BoardView, id: string) => b.drawn!.tracks.find((t) => t.id === id)!;

describe('drawn copper follows the parts', () => {
  it('a moved part takes the copper by it along; the piece beyond is bent back to 45°', () => {
    const k = drawnBuck();
    // C5.1 (N$1) out to the right, 45° up and up to R3.2: the first corner lies by C5
    const b0 = k.board();
    const [p, q] = [pad(b0, 'C5', '1'), pad(b0, 'R3', '2')];
    const d = q.x - (p.x + 1);
    ok(k, [{ op: 'draw_track', from: 'C5.1', to: 'R3.2', via: [[p.x + 1, p.y], [q.x, p.y - d]] }]);
    const before = trackOf(k.board(), 't1').pts;
    const c5 = part(b0, 'C5');
    const r = ok(k, [{ op: 'place', ref: 'C5', x_mm: c5.x - 1, y_mm: c5.y }]);
    expect(r.results[0]!.effect).toMatch(/drawn copper followed C5: 1 track\(s\) moved with it, 1 stretched piece\(s\) bent back to 45°/);
    const b = k.board();
    const t = trackOf(b, 't1');
    const np = pad(b, 'C5', '1');
    expect([t.pts[0], t.pts[1]]).toEqual([np.x, np.y]);
    // the far end and the corner away from C5 stay; every piece runs at 45°
    expect(t.pts.slice(-4)).toEqual(before.slice(-4));
    expect(octilinear(t.pts)).toBe(true);
    expect(b.diagnostics.filter((x) => x.code === 'DRAW.ANGLE' || x.code === 'DRAW.DANGLING')).toEqual([]);
    expect(openOf(b, netId(k, 'N$1'))).toEqual([]);
  });

  it('a pad\'s drop (a via by it and the stub) goes with the part, turned with it', () => {
    const k = drawnBuck();
    const b0 = k.board();
    const g = pad(b0, 'C2', '2');
    ok(k, [{ op: 'draw_via', net: 'GND', at: [g.x, g.y + 1.3] }, { op: 'draw_track', from: 'C2.2', to: 'v1' }]);
    const c2 = part(b0, 'C2');
    const r = ok(k, [{ op: 'place', ref: 'C2', x_mm: c2.x - 1, y_mm: c2.y - 1, rot: 0 }]);
    expect(r.results[0]!.effect).toMatch(/1 track\(s\) and 1 via\(s\) moved with it/);
    const b = k.board();
    const now = part(b, 'C2');
    const ng = pad(b, 'C2', '2');
    const v = b.drawn!.vias[0]!;
    // the via kept its place relative to the part: 1.3 mm beyond the pad, turned with it
    expect(Math.hypot(v.x - ng.x, v.y - ng.y)).toBeCloseTo(1.3, 3);
    expect(Math.hypot(v.x - now.x, v.y - now.y)).toBeCloseTo(Math.hypot(g.x + 0 - c2.x, g.y + 1.3 - c2.y), 3);
    const t = trackOf(b, 't2');
    expect(t.pts).toEqual([ng.x, ng.y, v.x, v.y]);
  });

  it('only what is moved on purpose moves: the part, its small parts rigidly (their track whole), nothing else', () => {
    const k = drawnBuck();
    const b0 = k.board();
    const ss = pad(b0, 'U1', '4');
    const c31 = pad(b0, 'C3', '1');
    // round to the left of both pads
    ok(k, [{ op: 'draw_track', from: 'U1.SS', to: 'C3.1', via: [[ss.x - 1, ss.y], [ss.x - 1, c31.y]] }]);
    const t0 = trackOf(k.board(), 't1').pts;
    const u1 = part(b0, 'U1');
    const r = ok(k, [{ op: 'place', ref: 'U1', x_mm: u1.x + 1, y_mm: u1.y }]);
    expect(r.results[0]!.effect).toMatch(/drawn copper followed U1: 1 track\(s\) moved with it; check: clear$/);
    const b = k.board();
    const followers = b0.parts.filter((p) => p.follows === 'U1').map((p) => p.refdes);
    expect(followers).toContain('C3');
    for (const p of b0.parts) {
      const q = part(b, p.refdes);
      const d = p.refdes === 'U1' || followers.includes(p.refdes) ? 1 : 0;
      expect([q.x, q.y, q.rot], p.refdes).toEqual([Math.round((p.x + d) * 1000) / 1000, p.y, p.rot]);
    }
    expect(trackOf(b, 't1').pts).toEqual(t0.map((v, i) => (i % 2 === 0 ? Math.round((v + 1) * 1000) / 1000 : v)));
    expect(openOf(b, netId(k, 'SS'))).toEqual([]);
  });
});

describe('drawing with fewer coordinates', () => {
  it('bend puts the 45° corners in', () => {
    const k = drawnBuck();
    const r = ok(k, [{ op: 'draw_track', from: 'C5.1', to: 'R3.2', bend: 'diagonal_first' }]);
    expect(r.results[0]!.effect).toMatch(/track t1: N\$1 on F\.Cu, .* 2 piece\(s\)/);
    const t = trackOf(k.board(), 't1');
    expect(t.pts).toHaveLength(6);
    expect(octilinear(t.pts)).toBe(true);
    // diagonal first: the corner is where the diagonal from C5.1 meets R3.2's column
    const b = k.board();
    expect(t.pts[2]).toBeCloseTo(pad(b, 'R3', '2').x, 3);
    ok(k, [{ op: 'draw_track', net: 'N$1', from: [3, 3], to: [6, 4], bend: 'straight_first' }]);
    expect(trackOf(k.board(), 't2').pts).toEqual([3, 3, 5, 3, 6, 4]);
  });

  it('a track can end on a via by its id, and takes its net', () => {
    const k = drawnBuck();
    const r = ok(k, [{ op: 'draw_via', net: 'GND', at: [5, 18] }, { op: 'draw_track', from: 'C5.2', to: 'v1', bend: 'straight_first' }]);
    expect(r.results[1]!.effect).toMatch(/^track t2: GND/);
    const t = trackOf(k.board(), 't2');
    expect(t.pts.slice(-2)).toEqual([5, 18]);
    expect(k.transact({ summary: 'x', ops: [{ op: 'draw_track', from: 'C5.1', to: 'v1' }] }).rejection?.code).toBe('NET_MISMATCH');
    expect(k.transact({ summary: 'x', ops: [{ op: 'draw_track', from: 'C5.1', to: 'v9' }] }).rejection?.code).toBe('REF_UNKNOWN');
  });
});

describe('edit_copper', () => {
  it('moves a via with the track ends on it, and changes width and layer in place', () => {
    const k = drawnBuck();
    ok(k, [{ op: 'draw_via', net: 'GND', at: [5, 18] }, { op: 'draw_track', from: 'C5.2', to: 'v1', via: [[5, 18.9]] }]);
    const r = ok(k, [{ op: 'edit_copper', ids: ['v1'], move: [0.5, 0] }]);
    expect(r.results[0]!.effect).toMatch(/edited v1: moved by 0.5, 0 mm; t2 went along at the moved via/);
    let b = k.board();
    expect([b.drawn!.vias[0]!.x, b.drawn!.vias[0]!.y]).toEqual([5.5, 18]);
    expect(trackOf(b, 't2').pts.slice(-2)).toEqual([5.5, 18]);
    // ids stay; the pad end stays on its pad when the track is shifted
    const c52 = pad(b, 'C5', '2');
    ok(k, [{ op: 'edit_copper', ids: ['t2'], width_mm: 0.4 }, { op: 'edit_copper', ids: ['t2'], move: [0, -0.2] }]);
    b = k.board();
    const t = trackOf(b, 't2');
    expect(t.width).toBe(0.4);
    expect([t.pts[0], t.pts[1]]).toEqual([c52.x, c52.y]);
    expect(t.pts[3]).toBeCloseTo(18.7, 3);
    // the end on the via stays on it (the via did not move)
    expect(t.pts.slice(-2)).toEqual([5.5, 18]);
    ok(k, [{ op: 'edit_copper', ids: ['t2'], via: [[6, 18.9]], bend: 'diagonal_first' }]);
    expect(octilinear(trackOf(k.board(), 't2').pts)).toBe(true);
    expect(k.transact({ summary: 'x', ops: [{ op: 'edit_copper', ids: ['t2', 'v1'], via: [[1, 1]] }] }).status).toBe('ok');
    expect(k.transact({ summary: 'x', ops: [{ op: 'edit_copper', ids: ['v1'], width_mm: 1 }] }).rejection?.code).toBe('INVALID_OP');
  });
});

describe('drawn copper is checked at once', () => {
  it('the effect says what the new copper breaks, or that it is clear', () => {
    const k = drawnBuck();
    const clean = ok(k, [{ op: 'draw_track', from: 'U1.SS', to: 'C3.1', via: [[10.6, 12.91]] }]);
    expect(clean.results[0]!.effect).toMatch(/; check: clear$/);
    const b0 = k.board();
    const vin = pad(b0, 'U1', '2');
    const bad = ok(k, [{ op: 'draw_track', net: 'SS', from: [vin.x - 3, vin.y], to: [vin.x + 3, vin.y] }]);
    expect(bad.results[0]!.effect).toMatch(/check: \d+ error\(s\), \d+ warning\(s\): error DRC\.SHORT: track t2 \(SS\) touches [A-Z]+\d\.\d/);
    // the board's own checks name the track by id, as entities too (soft ones can be waived by it)
    const b = k.board();
    const angle = ok(k, [{ op: 'draw_track', net: 'SS', from: [3, 18], to: [4, 20.5] }]);
    expect(angle.results[0]!.effect).toMatch(/warning DRAW\.ANGLE: Track t3/);
    expect(b.diagnostics.some((x) => x.code === 'DRC.SHORT' && x.entities.includes('t2'))).toBe(true);
    ok(k, [{ op: 'add_waiver', code: 'DRAW.ANGLE', entities: ['t3'], reason: 'a test of waiving a soft rule' }]);
    expect(k.board().diagnostics.find((x) => x.code === 'DRAW.ANGLE' && x.entities.includes('t3'))?.waivedBy).toBeDefined();
  });

  it('a track and the via it ends on, drawn in one transaction, are judged together', () => {
    const k = drawnBuck();
    const r = ok(k, [{ op: 'draw_track', from: 'C5.2', to: [5, 18.9] }, { op: 'draw_via', net: 'GND', at: [5, 18.9] }]);
    expect(r.results[0]!.effect).toMatch(/; check: clear$/);
    expect(r.results[1]!.effect).toMatch(/; check: clear$/);
  });

  it('the changeset says what changed in the drawn copper', () => {
    const k = drawnBuck();
    k.accept();
    ok(k, [{ op: 'draw_track', from: 'C5.2', to: [5, 18.9] }, { op: 'draw_via', net: 'GND', at: [5, 18.9] }]);
    const hunk = k.proposal()!.hunks.find((h) => h.id === 'board:board')!;
    expect(hunk.details).toContain('copper drawn by the agent: 1 track, 1 via (2 new)');
  });
});

describe('the route helper run elsewhere', () => {
  it('a transaction given the helper\'s result lays the same copper, without routing', () => {
    const a = drawnBuck();
    const done: Record<number, import('@4k7/schema').RouteHelperResult> = {};
    let progress = 0;
    const r1 = a.transact({ summary: 'x', ops: [{ op: 'draw_track', from: 'U1.SS', to: 'C3.1' }, { op: 'route', nets: ['FB'] }] }, 'agent', { onDone: (i, r) => (done[i] = r), onProgress: () => progress++ });
    expect(r1.status).toBe('ok');
    expect(Object.keys(done)).toEqual(['1']);
    expect(progress).toBeGreaterThan(0);
    const b = drawnBuck();
    const r2 = b.transact({ summary: 'x', ops: [{ op: 'draw_track', from: 'U1.SS', to: 'C3.1' }, { op: 'route', nets: ['FB'] }] }, 'agent', { results: done });
    expect(r2.results[1]!.effect).toBe(r1.results[1]!.effect);
    expect(b.board().drawn).toEqual(a.board().drawn);
    // stopped by the user: the effect says what was kept
    const c = drawnBuck();
    const r3 = c.transact({ summary: 'x', ops: [{ op: 'route' }] }, 'agent', { results: { 0: { tracks: [], vias: [], open: [], passes: 0, stopped: true } } });
    expect(r3.results[0]!.effect).toMatch(/stopped by the user before its first pass ended/);
  });
});

describe('the helper\'s copper', () => {
  it('route fresh lays the helper\'s own copper again round the agent\'s, which stays', () => {
    const k = drawnBuck();
    ok(k, [{ op: 'route', nets: ['FB'] }]);
    const laid = k.board().drawn!.tracks;
    expect(laid.length).toBeGreaterThan(1);
    expect(laid.every((t) => t.by === 'helper')).toBe(true);
    const [mine, ...theirs] = laid.map((t) => t.id);
    // edited, a helper track is the agent's; a track the agent draws is its own
    ok(k, [{ op: 'edit_copper', ids: [mine!], width_mm: 0.3 }, { op: 'draw_track', from: 'U1.SS', to: 'C3.1' }]);
    const r = ok(k, [{ op: 'route', nets: ['FB'], fresh: true }]);
    expect(r.results[0]!.effect).toMatch(new RegExp(`fresh: ${theirs.length} of its own tracks and vias taken up first`));
    const b = k.board();
    expect(b.drawn!.tracks.find((t) => t.id === mine)!.by).toBeUndefined();
    expect(theirs.every((id) => !b.drawn!.tracks.some((t) => t.id === id))).toBe(true);
    expect(b.drawn!.tracks.filter((t) => t.netId === netId(k, 'SS')).map((t) => t.by)).toEqual([undefined]);
    expect(openOf(b, netId(k, 'FB'))).toEqual([]);
    expect((k.query({ op: 'get_copper', nets: ['FB'] }) as { tracks: { by?: string }[] }).tracks.some((t) => t.by === 'helper')).toBe(true);
  });

  it('the router\'s copper taken over is the helper\'s', () => {
    const k = buck();
    ok(k, [{ op: 'route' }]);
    k.accept();
    expect(k.keepCopper(k.board().newCopper!)).toBe(true);
    ok(k, [{ op: 'set_copper_mode', mode: 'drawn' }]);
    const d = k.board().drawn!;
    expect([...d.tracks, ...d.vias].every((x) => x.by === 'helper')).toBe(true);
  });
});
