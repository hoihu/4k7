import { describe, expect, it } from 'vitest';
import { cutoutDistance } from '@tracewise/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

function buck() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k;
}

/** The route step (the last one), then the board. */
function routed(k: Kernel) {
  k.transact({ summary: 'route', ops: [{ op: 'route' }] });
  return k.board();
}

describe('board placement', () => {
  it('places every part on the board without overlapping courtyards', () => {
    const b = routed(buck());
    expect(b.parts).toHaveLength(12);
    expect(b.missing).toEqual([]);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    for (const p of b.parts) {
      expect(p.courtyard.x).toBeGreaterThanOrEqual(0);
      expect(p.courtyard.y + p.courtyard.h).toBeLessThanOrEqual(b.outline.h);
    }
    // a compact board: well under 30 × 30 mm for this buck
    expect(b.outline.w * b.outline.h).toBeLessThan(900);
    expect(b.tracks.length).toBeGreaterThan(10);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buck().board())).toBe(JSON.stringify(buck().board()));
  });

  it('keeps the bootstrap and input caps close to the regulator', () => {
    const b = buck().board();
    const u1 = b.parts.find((p) => p.refdes === 'U1')!;
    const dist = (ref: string) => {
      const p = b.parts.find((x) => x.refdes === ref)!;
      return Math.hypot(p.x - u1.x, p.y - u1.y);
    };
    expect(dist('C4')).toBeLessThan(6);
    expect(dist('C1')).toBeLessThan(8);
  });

  it('lines up similar parts next to each other (a column shares its x, a row its y)', () => {
    const b = buck().board();
    const misses: string[] = [];
    for (const a of b.parts) {
      for (const c of b.parts) {
        if (a.refdes >= c.refdes || a.courtyard.w !== c.courtyard.w || a.courtyard.h !== c.courtyard.h || a.rot % 180 !== c.rot % 180) continue;
        for (const column of [true, false]) {
          const across = column ? Math.abs(a.x - c.x) : Math.abs(a.y - c.y);
          const gap = column ? Math.abs(a.y - c.y) - a.courtyard.h : Math.abs(a.x - c.x) - a.courtyard.w;
          if (across > 1e-6 && across <= 1 && gap >= 0 && gap <= 2) misses.push(`${a.refdes}/${c.refdes} ${across.toFixed(3)} off`);
        }
      }
    }
    expect(misses).toEqual([]);
  });

  it('marks pin 1 only where the orientation matters', () => {
    const b = buck().board();
    const marked = Object.fromEntries(b.parts.map((p) => [p.refdes, p.polarized]));
    // resistors, ceramic caps and the inductor: no mark; the diode, the IC and the connector: marked
    for (const r of ['R1', 'R2', 'R3', 'C1', 'C2', 'C3', 'C4', 'C5', 'L1']) expect(marked[r], r).toBe(false);
    for (const r of ['D1', 'U1', 'J1']) expect(marked[r], r).toBe(true);
  });

  it('honours pinned positions and board settings', () => {
    const k = buck();
    k.transact({ summary: 'board', ops: [
      { op: 'set_board', width_mm: 40, height_mm: 30 },
      { op: 'place', ref: 'J1', x_mm: 3, y_mm: 15, rot: 90, lock: true },
    ] });
    const b = k.board();
    expect(b.outline).toEqual({ w: 40, h: 30 });
    const j1 = b.parts.find((p) => p.refdes === 'J1')!;
    expect([j1.x, j1.y, j1.rot, j1.locked]).toEqual([3, 15, 90, true]);
    expect(b.diagnostics.filter((x) => x.code === 'DRC.COURTYARD_OVERLAP')).toEqual([]);
    const hunks = k.proposal()!.hunks.map((h) => h.kind);
    expect(hunks).toContain('board');
    expect(hunks).toContain('constraint');
  });
});

/** Nets that are not one connected piece of copper, judged from geometry only. */
function brokenNets(b: ReturnType<Kernel['board']>): string[] {
  type Node = { net: string; layer: string; x0: number; y0: number; x1: number; y1: number; seg?: number[]; r?: number; zone?: boolean };
  const nodes: Node[] = [];
  for (const p of b.parts) for (const pad of p.pads) if (pad.netId) for (const layer of pad.drill ? b.layers : pad.layers) nodes.push({ net: pad.netId, layer, x0: pad.x - pad.w / 2, y0: pad.y - pad.h / 2, x1: pad.x + pad.w / 2, y1: pad.y + pad.h / 2 });
  for (const t of b.tracks) for (let i = 0; i + 3 < t.pts.length; i += 2) nodes.push({ net: t.netId, layer: t.layer, x0: 0, y0: 0, x1: 0, y1: 0, seg: t.pts.slice(i, i + 4), r: t.width / 2 });
  for (const v of b.vias) for (const layer of b.layers) nodes.push({ net: v.netId, layer, x0: v.x - v.pad / 2, y0: v.y - v.pad / 2, x1: v.x + v.pad / 2, y1: v.y + v.pad / 2 });
  for (const z of b.zones) for (let i = 0; i + 3 < z.rects.length; i += 4) nodes.push({ net: z.netId, layer: z.layer, x0: z.rects[i]!, y0: z.rects[i + 1]!, x1: z.rects[i]! + z.rects[i + 2]!, y1: z.rects[i + 1]! + z.rects[i + 3]!, zone: true });
  const inRect = (n: Node, x: number, y: number) => x >= n.x0 - 1e-6 && x <= n.x1 + 1e-6 && y >= n.y0 - 1e-6 && y <= n.y1 + 1e-6;
  const ends = (n: Node) => (n.seg ? [[n.seg[0]!, n.seg[1]!], [n.seg[2]!, n.seg[3]!]] : [[(n.x0 + n.x1) / 2, (n.y0 + n.y1) / 2]]);
  const touch = (a: Node, c: Node) => {
    if (a.net !== c.net) return false;
    // vias join layers
    if (a.layer !== c.layer && !(a.x1 - a.x0 > 0 && a.x0 === c.x0 && a.y0 === c.y0)) return false;
    // pour rectangles: adjacent rows touch; anything overlapping a rectangle touches it
    if (a.zone || c.zone) {
      const [z, o] = a.zone ? [a, c] : [c, a];
      if (o.seg) return ends(o).some(([x, y]) => inRect(z, x!, y!));
      return o.x0 <= z.x1 + 1e-6 && z.x0 <= o.x1 + 1e-6 && o.y0 <= z.y1 + 1e-6 && z.y0 <= o.y1 + 1e-6;
    }
    if (!a.seg && !c.seg) return a.x0 <= c.x1 && c.x0 <= a.x1 && a.y0 <= c.y1 && c.y0 <= a.y1;
    // a track end on another track (joins may be anywhere along it) or inside a pad
    const onSeg = (x: number, y: number, n: Node) => {
      const [ax, ay, bx, by] = n.seg!;
      const dx = bx! - ax!;
      const dy = by! - ay!;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax!) * dx + (y - ay!) * dy) / l2)) : 0;
      return Math.hypot(x - (ax! + t * dx), y - (ay! + t * dy)) < 1e-6;
    };
    const endTouches = (e: Node, o: Node) => ends(e).some(([x, y]) => (o.seg ? onSeg(x!, y!, o) : inRect(o, x!, y!)));
    return (!!a.seg && endTouches(a, c)) || (!!c.seg && endTouches(c, a));
  };
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (touch(nodes[i]!, nodes[j]!)) parent[find(i)] = find(j);
  const roots = new Map<string, Set<number>>();
  nodes.forEach((n, i) => roots.set(n.net, (roots.get(n.net) ?? new Set()).add(find(i))));
  // pads of a net on different layers of one THT pad count once: compare pad roots only
  const padRoots = new Map<string, Set<number>>();
  nodes.forEach((n, i) => !n.seg && !n.zone && roots.has(n.net) && padRoots.set(n.net, (padRoots.get(n.net) ?? new Set()).add(find(i))));
  return [...padRoots.entries()].filter(([, s]) => s.size > 1).map(([net]) => b.netNames[net] ?? net);
}

describe('dragging a part (place)', () => {
  it('moves just that part, as the user\'s choice; the board keeps its frame and size', () => {
    const k = buck();
    const before = k.board();
    const c4 = before.parts.find((p) => p.refdes === 'C4')!;
    k.transact({ summary: 'drag', ops: [{ op: 'place', ref: 'C4', x_mm: c4.x - 1, y_mm: c4.y }] });
    k.accept(undefined, 'user');
    const after = k.board();
    const moved = after.parts.find((p) => p.refdes === 'C4')!;
    expect([moved.x, moved.y, moved.locked, moved.intent]).toEqual([c4.x - 1, c4.y, false, { anchor: 'U1' }]);
    expect(after.outline).toEqual(before.outline);
    // parts that did not have to give way stay exactly where they were
    const same = before.parts.filter((p) => {
      const q = after.parts.find((x) => x.refdes === p.refdes)!;
      return q.x === p.x && q.y === p.y && q.rot === p.rot;
    });
    expect(same.length).toBeGreaterThanOrEqual(before.parts.length - 3);
    expect(after.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
  });
});

describe('the user\'s placement choices', () => {
  const at = (k: Kernel, ref: string) => k.board().parts.find((p) => p.refdes === ref)!;

  it('a choice is kept relative to the parent part; moving the parent brings its parts along', () => {
    const k = buck();
    const c4 = at(k, 'C4');
    const c1 = at(k, 'C1');
    const u1 = at(k, 'U1');
    // the user puts C4 somewhere else next to U1, then moves U1
    k.transact({ summary: 'c4', ops: [{ op: 'place', ref: 'C4', x_mm: c4.x - 1, y_mm: c4.y }] });
    k.transact({ summary: 'u1', ops: [{ op: 'place', ref: 'U1', x_mm: u1.x + 1, y_mm: u1.y + 1 }] });
    const c4b = at(k, 'C4');
    const u1b = at(k, 'U1');
    expect([u1b.x, u1b.y]).toEqual([u1.x + 1, u1.y + 1]);
    // C4 (the user's choice, relative to U1) and C1 (placed automatically, U1's) follow U1
    expect([c4b.x - u1b.x, c4b.y - u1b.y].map((v) => Math.round(v * 1000) / 1000)).toEqual([c4.x - 1 - u1.x, c4.y - u1.y].map((v) => Math.round(v * 1000) / 1000));
    const c1b = at(k, 'C1');
    expect(Math.hypot(c1b.x - u1b.x - (c1.x - u1.x), c1b.y - u1b.y - (c1.y - u1.y))).toBeLessThan(0.6);
    expect(k.board().diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('parts pushed away from their parent close in again when the parent moves to free space', () => {
    const k = buck();
    k.transact({ summary: 'room', ops: [{ op: 'set_board', width_mm: 60, height_mm: 40 }, { op: 'propose_layout' }] });
    const kids = k.board().parts.filter((p) => p.follows === 'U1').map((p) => p.refdes);
    const spread = () => {
      const u = at(k, 'U1');
      return kids.reduce((sum, r) => sum + Math.hypot(at(k, r).x - u.x, at(k, r).y - u.y), 0) / kids.length;
    };
    const start = spread();
    // a big hole right next to U1 pushes its parts away (and a move keeps that placement) …
    const u = at(k, 'U1');
    k.transact({ summary: 'hole', ops: [{ op: 'add_hole', diameter_mm: 5, x_mm: u.x + 7, y_mm: u.y }] });
    k.transact({ summary: 'keep', ops: [{ op: 'place', ref: 'U1', x_mm: u.x, y_mm: u.y }] });
    expect(spread()).toBeGreaterThan(start + 0.2);
    // … U1 moved to free space: they gather round it again
    k.transact({ summary: 'away', ops: [{ op: 'place', ref: 'U1', x_mm: 48, y_mm: 30 }] });
    expect(spread()).toBeLessThanOrEqual(start + 0.1);
    expect(k.board().diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('a new part is placed next to what it connects to; the others stay put', () => {
    const k = buck();
    k.transact({ summary: 'keep', ops: [{ op: 'propose_layout' }] });
    const before = k.board();
    k.transact({ summary: 'add', ops: [{ op: 'add_part', part: 'generic:C', refdes: 'C9', params: { capacitance: '100nF', voltage: '16V', package: '0402' } }, { op: 'connect', pins: ['C9.1'], net: '+3V3' }, { op: 'connect', pins: ['C9.2'], net: 'GND' }] });
    const after = k.board();
    expect(after.parts.some((p) => p.refdes === 'C9')).toBe(true);
    const moved = before.parts.filter((p) => {
      const q = after.parts.find((x) => x.refdes === p.refdes)!;
      return q.x !== p.x || q.y !== p.y || q.rot !== p.rot;
    });
    expect(moved.length).toBeLessThanOrEqual(2);
    expect(after.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('routing is the last step: done, out of date after a change, done again', () => {
    const k = buck();
    expect(k.board().routing).toBe('none');
    expect(k.board().tracks).toEqual([]);
    const r = routed(k);
    expect(r.routing).toBe('done');
    expect(r.stats.unrouted).toBe(0);
    const c4 = at(k, 'C4');
    k.transact({ summary: 'move', ops: [{ op: 'place', ref: 'C4', x_mm: c4.x - 1, y_mm: c4.y }] });
    expect(k.board().routing).toBe('stale');
    expect(k.board().tracks).toEqual([]);
    expect(routed(k).routing).toBe('done');
  });

  it('propose_layout starts over; it keeps locked parts, and the choices unless told not to', () => {
    const k = buck();
    const c4 = at(k, 'C4');
    k.transact({ summary: 'c', ops: [{ op: 'place', ref: 'C4', x_mm: c4.x - 1, y_mm: c4.y }, { op: 'place', ref: 'J1', x_mm: 4, y_mm: 8, lock: true }] });
    k.transact({ summary: 'again', ops: [{ op: 'propose_layout' }] });
    expect(at(k, 'C4').intent).toEqual({ anchor: 'U1' });
    expect(at(k, 'J1').locked).toBe(true);
    k.transact({ summary: 'fresh', ops: [{ op: 'propose_layout', keep_choices: false }] });
    expect(at(k, 'C4').intent).toBeUndefined();
    expect([at(k, 'J1').x, at(k, 'J1').y, at(k, 'J1').locked]).toEqual([4, 8, true]);
  });

  it('two-pin parts face each other where they connect (a chosen rotation may turn round 180°)', () => {
    const k = buck();
    const r3 = at(k, 'R3');
    // C5 and R3 share N$1 (C5.1–R3.2); placed side by side, both turned so those pads face away
    k.transact({ summary: 'away', ops: [{ op: 'place', ref: 'R3', x_mm: r3.x, y_mm: r3.y, rot: 0 }, { op: 'place', ref: 'C5', x_mm: r3.x - 3, y_mm: r3.y, rot: 0 }] });
    const b = k.board();
    const c5 = b.parts.find((p) => p.refdes === 'C5')!;
    const r = b.parts.find((p) => p.refdes === 'R3')!;
    const d = (a: { x: number; y: number }, c: { x: number; y: number }) => Math.hypot(a.x - c.x, a.y - c.y);
    const shared = d(c5.pads.find((q) => q.number === '1')!, r.pads.find((q) => q.number === '2')!);
    // the connected pads are now the nearest pair of the two parts
    for (const p of c5.pads) for (const q of r.pads) expect(shared).toBeLessThanOrEqual(d(p, q) + 1e-6);
    // each kept its direction (lying), at most turned round
    expect([c5.rot % 180, r.rot % 180]).toEqual([0, 0]);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('older designs: their pinned parts become the user\'s choices (soft)', () => {
    const k = buck();
    k.transact({ summary: 'pin', ops: [{ op: 'place', ref: 'J1', x_mm: 4, y_mm: 8, lock: true }] });
    k.accept();
    const old = { ...JSON.parse(k.exportDesign()), format: 1 };
    const k2 = new Kernel(old);
    expect(k2.board().parts.find((p) => p.refdes === 'J1')!.locked).toBe(false);
    expect(k2.board().parts.find((p) => p.refdes === 'J1')!.intent).toEqual({});
  });
});

describe('fixed outline with a pinned part', () => {
  it('keeps every other part inside the board', () => {
    const k = buck();
    k.transact({ summary: 'board', ops: [
      { op: 'set_board', width_mm: 30, height_mm: 20 },
      { op: 'place', ref: 'J1', x_mm: 3, y_mm: 10, rot: 0, lock: true },
    ] });
    const b = k.board();
    expect(b.outline).toEqual({ w: 30, h: 20 });
    expect(b.parts.filter((p) => p.locked).map((p) => p.refdes)).toEqual(['J1']);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(b.stats.unrouted).toBe(0);
  });
});

describe('pinned parts and rotation', () => {
  it('a part pinned without a rotation still gets the best rotation; an explicit one stays', () => {
    const k = buck();
    const free = k.board().parts.find((p) => p.refdes === 'R1')!;
    expect(free.rot).not.toBe(0);
    const rotOf = () => k.board().parts.find((p) => p.refdes === 'R1')!.rot;
    k.transact({ summary: 'pin', ops: [{ op: 'place', ref: 'R1', x_mm: free.x, y_mm: free.y }] });
    expect(rotOf()).toBe(free.rot);
    k.transact({ summary: 'rotate', ops: [{ op: 'place', ref: 'R1', x_mm: free.x, y_mm: free.y, rot: 0 }] });
    expect(rotOf()).toBe(0);
    // a drag (no rotation) keeps the rotation pinned before
    k.transact({ summary: 'drag', ops: [{ op: 'place', ref: 'R1', x_mm: free.x + 0.5, y_mm: free.y }] });
    expect(rotOf()).toBe(0);
  });
});

describe('routing', () => {
  it('routes the buck completely, DRC-clean, and every net is one piece of copper', () => {
    const b = routed(buck());
    expect(b.stats.unrouted).toBe(0);
    expect(b.stats.routed).toBe(b.stats.nets);
    expect(b.ratsnest).toEqual([]);
    expect(b.diagnostics).toEqual([]);
    expect(brokenNets(b)).toEqual([]);
    // supply nets get the wide track where the pads allow it
    const sw = b.tracks.filter((t) => b.netNames[t.netId] === '+12V');
    expect(sw.some((t) => t.width === b.rules.powerTrack)).toBe(true);
  });

  it('draws tracks as straight 0/45/90° pieces, not zigzags', () => {
    const k = buck();
    k.transact({ summary: 'holes', ops: [{ op: 'add_hole', diameter_mm: 3.5, corner: 'all' }] });
    const b = routed(k);
    const pads = b.parts.flatMap((p) => p.pads);
    const nearPad = (x: number, y: number) => pads.some((p) => Math.hypot(p.x - x, p.y - y) < Math.max(p.w, p.h) / 2 + 1.4); // pad entries and escape stubs
    let tiny = 0;
    for (const t of b.tracks) {
      for (let i = 2; i + 5 < t.pts.length; i += 2) {
        const [ax, ay, bx, by] = [t.pts[i]!, t.pts[i + 1]!, t.pts[i + 2]!, t.pts[i + 3]!];
        // octilinear everywhere away from the pad entries
        if (!nearPad(ax, ay) && !nearPad(bx, by)) {
          const dx = Math.abs(bx - ax);
          const dy = Math.abs(by - ay);
          expect(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6, `segment ${ax},${ay} → ${bx},${by}`).toBe(true);
          if (Math.hypot(dx, dy) < 0.25) tiny++;
        }
      }
    }
    expect(tiny).toBe(0);
  });

  it('enters pads at 0/45/90° too', () => {
    const b = routed(buck());
    const odd: string[] = [];
    for (const t of b.tracks) {
      for (let i = 0; i + 3 < t.pts.length; i += 2) {
        const [ax, ay, bx, by] = [t.pts[i]!, t.pts[i + 1]!, t.pts[i + 2]!, t.pts[i + 3]!];
        const dx = Math.abs(bx - ax);
        const dy = Math.abs(by - ay);
        // (escape stubs end in a sub-grid jog onto the grid)
        if (dx > 1e-3 && dy > 1e-3 && Math.abs(dx - dy) > 1e-3 && Math.min(dx, dy) > 0.051) odd.push(`${ax},${ay} → ${bx},${by}`);
      }
    }
    expect(odd).toEqual([]);
  });

  it('runs onto a pad along its centre line, not half over its edge', () => {
    const k = buck();
    k.transact({ summary: 'holes', ops: [{ op: 'add_hole', diameter_mm: 3.5, corner: 'all' }] });
    const b = routed(k);
    const pads = b.parts.flatMap((p) => p.pads).filter((p) => p.shape !== 'round');
    const odd = new Set<string>();
    for (const t of b.tracks) {
      for (let i = 0; i + 3 < t.pts.length; i += 2) {
        const [ax, ay, bx, by] = [t.pts[i]!, t.pts[i + 1]!, t.pts[i + 2]!, t.pts[i + 3]!];
        if (Math.hypot(bx - ax, by - ay) < 0.11) continue; // the sub-grid jog onto the pad centre
        const len = Math.hypot(bx - ax, by - ay);
        const n = Math.max(1, Math.ceil(len / 0.02));
        for (let q = 0; q <= n; q++) {
          // the round joint at a bend belongs to both pieces: skip what lies within half a track
          // width of a bend (the other piece is judged on its own)
          const nearStart = (q * len) / n < t.width / 2;
          const nearEnd = ((n - q) * len) / n < t.width / 2;
          if ((nearStart && i > 0) || (nearEnd && i + 5 < t.pts.length)) continue;
          const x = ax + ((bx - ax) * q) / n;
          const y = ay + ((by - ay) * q) / n;
          for (const p of pads) {
            if (p.netId !== t.netId || !(p.drill || p.layers.includes(t.layer))) continue;
            const ox = Math.abs(x - p.x) - p.w / 2;
            const oy = Math.abs(y - p.y) - p.h / 2;
            const dist = Math.hypot(Math.max(ox, 0), Math.max(oy, 0)) + Math.min(Math.max(ox, oy), 0);
            // apart, wholly on the pad, or only grazing its edge
            if (dist >= t.width / 2 - 0.08 || dist <= -t.width / 2 + 0.08) continue;
            // touching the pad: the track's line runs through the pad centre (within what the pad's width allows)
            const dx = bx - ax;
            const dy = by - ay;
            const across = Math.abs(dy) < 1e-9 ? p.h : Math.abs(dx) < 1e-9 ? p.w : Math.min(p.w, p.h);
            const off = Math.abs((p.x - ax) * dy - (p.y - ay) * dx) / Math.hypot(dx, dy);
            if (off <= Math.max(0, across / 2 - t.width / 2) + 0.09) continue;
            odd.add(`${b.netNames[t.netId]} ${t.width} at ${x.toFixed(2)},${y.toFixed(2)}`);
          }
        }
      }
    }
    expect([...odd]).toEqual([]);
  });

  it('runs straight into a pad exactly on its centre line (or aims a diagonal at its centre)', () => {
    const b = routed(buck());
    const pads = b.parts.flatMap((p) => p.pads.map((q) => ({ ...q, ref: p.refdes })));
    const padAt = (netId: string, x: number, y: number) => pads.find((q) => q.netId === netId && Math.abs(q.x - x) < 1e-6 && Math.abs(q.y - y) < 1e-6);
    const off: string[] = [];
    for (const t of b.tracks) {
      const n = t.pts.length / 2;
      // pad to pad, two pads whose centre lines differ: one straight run cannot meet both
      const bothPads = !!padAt(t.netId, t.pts[0]!, t.pts[1]!) && !!padAt(t.netId, t.pts[2 * n - 2]!, t.pts[2 * n - 1]!);
      for (const fromEnd of [true, false]) {
        const pts = fromEnd ? t.pts : t.pts.flatMap((_, i) => (i % 2 ? [] : [t.pts[t.pts.length - 2 - i]!, t.pts[t.pts.length - 1 - i]!]));
        const p = padAt(t.netId, pts[2 * n - 2]!, pts[2 * n - 1]!);
        if (!p || bothPads) continue;
        for (let j = n - 2; j >= 0; j--) {
          const [ax, ay, bx, by] = [pts[2 * j]!, pts[2 * j + 1]!, pts[2 * j + 2]!, pts[2 * j + 3]!];
          if (Math.abs(ax - p.x) <= p.w / 2 && Math.abs(ay - p.y) <= p.h / 2) continue; // inside: look further back
          const horizontal = Math.abs(ay - by) < 1e-9;
          const vertical = Math.abs(ax - bx) < 1e-9;
          const alongSide = (horizontal && p.h > p.w * 1.2) || (vertical && p.w > p.h * 1.2);
          const d = Math.abs((p.x - ax) * (by - ay) - (p.y - ay) * (bx - ax)) / Math.hypot(bx - ax, by - ay);
          if (!alongSide && d > 1e-3) off.push(`${b.netNames[t.netId]} into ${p.ref}.${p.number}: ${d.toFixed(3)} off`);
          break;
        }
      }
    }
    expect(off).toEqual([]);
  });

  it('has no spikes: no two diagonals meeting in a point, no doubling back (outside pads and vias)', () => {
    const b = routed(buck());
    const pads = b.parts.flatMap((p) => p.pads);
    const hidden = (x: number, y: number) => pads.some((q) => Math.abs(x - q.x) <= q.w / 2 && Math.abs(y - q.y) <= q.h / 2) || b.vias.some((v) => Math.hypot(x - v.x, y - v.y) <= v.pad / 2);
    const diag = (x: number, y: number) => Math.abs(x) > 1e-6 && Math.abs(Math.abs(x) - Math.abs(y)) < 1e-6;
    const spikes: string[] = [];
    for (const t of b.tracks) {
      for (let i = 2; i + 3 < t.pts.length; i += 2) {
        const [ux, uy] = [t.pts[i]! - t.pts[i - 2]!, t.pts[i + 1]! - t.pts[i - 1]!];
        const [vx, vy] = [t.pts[i + 2]! - t.pts[i]!, t.pts[i + 3]! - t.pts[i + 1]!];
        const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
        if (((diag(ux, uy) && diag(vx, vy) && cos < 0.5) || cos < -0.1) && !hidden(t.pts[i]!, t.pts[i + 1]!)) spikes.push(`${b.netNames[t.netId]} at ${t.pts[i]},${t.pts[i + 1]}`);
      }
    }
    expect(spikes).toEqual([]);
  });

  it('the copper DRC catches a short', async () => {
    const { copperDrc } = await import('../src/drc.ts');
    const b = structuredClone(routed(buck()));
    const pad = b.parts.find((p) => p.refdes === 'U1')!.pads[0]!;
    const other = Object.keys(b.netNames).find((n) => n !== pad.netId)!;
    b.tracks.push({ netId: other, layer: 'F.Cu', width: 0.25, pts: [pad.x - 1, pad.y, pad.x + 1, pad.y] });
    const d = copperDrc(b);
    // (reported against the pad, or against the pad's own track the short crosses first)
    expect(d.some((x) => x.code === 'DRC.SHORT' && (x.message.includes('U1.1') || x.message.includes(b.netNames[pad.netId!]!)))).toBe(true);
  });
});

describe('planes', () => {
  it('uses GND and the main supply as inner planes on 4 layers, connected through vias', () => {
    const k = buck();
    k.transact({ summary: '4 layers', ops: [{ op: 'set_board', layers: 4 }] });
    const b = routed(k);
    expect(b.planes.map((p) => [b.netNames[p.netId], p.layer, p.auto])).toEqual([['GND', 'In1.Cu', true], ['+12V', 'In2.Cu', true]]);
    // no tracks on dedicated planes, and none for the plane nets
    expect(b.tracks.filter((t) => t.layer === 'In1.Cu' || t.layer === 'In2.Cu')).toEqual([]);
    expect(b.zones.map((z) => [b.netNames[z.netId], z.layer])).toEqual([['GND', 'In1.Cu'], ['+12V', 'In2.Cu']]);
    expect(b.stats.unrouted).toBe(0);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(brokenNets(b)).toEqual([]);
  });

  it('lets the agent choose planes per layer and refuses layers the board does not have', () => {
    const k = buck();
    const r2 = k.transact({ summary: 'x', ops: [{ op: 'set_plane', layer: 'In1.Cu', net: 'GND' }] });
    expect(JSON.stringify(r2)).toContain('does not exist on a 2-layer board');
    k.transact({ summary: 'planes', ops: [{ op: 'set_board', layers: 4 }, { op: 'set_plane', layer: 'In2.Cu', net: '+3V3' }] });
    const b = routed(k);
    expect(b.planes.map((p) => [b.netNames[p.netId], p.layer, p.auto])).toEqual([['GND', 'In1.Cu', false], ['+3V3', 'In2.Cu', false]]);
    expect(b.stats.unrouted).toBe(0);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(brokenNets(b)).toEqual([]);
    k.transact({ summary: 'no plane', ops: [{ op: 'set_plane', layer: 'In2.Cu', net: null }] });
    expect(k.board().planes.map((p) => p.layer)).toEqual(['In1.Cu']);
    k.transact({ summary: 'auto', ops: [{ op: 'set_plane', auto: true }] });
    expect(k.board().planes.every((p) => p.auto)).toBe(true);
  });
});

describe('vias', () => {
  const viaInPad = (b: ReturnType<Kernel['board']>) =>
    b.vias.filter((v) =>
      b.parts.some(
        (part) =>
          part.pads.some((p) => Math.hypot(Math.max(Math.abs(v.x - p.x) - p.w / 2, 0), Math.max(Math.abs(v.y - p.y) - p.h / 2, 0)) < v.pad / 2) ||
          (part.pads.length <= 3 && v.x > part.courtyard.x && v.x < part.courtyard.x + part.courtyard.w && v.y > part.courtyard.y && v.y < part.courtyard.y + part.courtyard.h),
      ),
    );

  it('never places a via in a pad or a small part’s land pattern', () => {
    const k = buck();
    k.transact({ summary: 'planes', ops: [{ op: 'set_board', layers: 4 }] });
    const b = routed(k);
    expect(b.vias.length).toBeGreaterThan(3); // plane drops
    expect(viaInPad(b)).toEqual([]);
    expect(b.stats.unrouted).toBe(0);
  });

  it('keeps vias apart and connects plane vias through thermal reliefs', () => {
    const k = buck();
    k.transact({ summary: 'planes', ops: [{ op: 'set_board', layers: 4 }] });
    const b = routed(k);
    for (let i = 0; i < b.vias.length; i++) {
      for (let j = i + 1; j < b.vias.length; j++) {
        const d = Math.hypot(b.vias[i]!.x - b.vias[j]!.x, b.vias[i]!.y - b.vias[j]!.y);
        expect(d, `vias ${i} and ${j}`).toBeGreaterThanOrEqual(b.rules.viaPad + b.rules.clearance - 1e-6);
      }
    }
    const inZone = (z: (typeof b.zones)[number], x: number, y: number) => {
      for (let i = 0; i < z.rects.length; i += 4) if (x >= z.rects[i]! && x <= z.rects[i]! + z.rects[i + 2]! && y >= z.rects[i + 1]! && y <= z.rects[i + 1]! + z.rects[i + 3]!) return true;
      return false;
    };
    let reliefs = 0;
    for (const z of b.zones) {
      for (const v of b.vias.filter((x) => x.netId === z.netId)) {
        const r = v.pad / 2 + 0.15;
        // the ring between the spokes is clear, the spokes carry copper
        for (const a of [45, 135, 225, 315]) expect(inZone(z, v.x + r * Math.cos((a * Math.PI) / 180), v.y + r * Math.sin((a * Math.PI) / 180))).toBe(false);
        if ([0, 90, 180, 270].some((a) => inZone(z, v.x + r * Math.cos((a * Math.PI) / 180), v.y + r * Math.sin((a * Math.PI) / 180)))) reliefs++;
      }
    }
    expect(reliefs).toBeGreaterThan(3);
    expect(brokenNets(b)).toEqual([]);
  });

  it('allows vias in pads only when asked, and the DRC reports them otherwise', async () => {
    const k = buck();
    k.transact({ summary: 'planes', ops: [{ op: 'set_board', layers: 4, via_in_pad: true }] });
    const b = routed(k);
    expect(b.rules.viaInPad).toBe(true);
    expect(b.diagnostics.filter((x) => x.code === 'DRC.VIA_IN_PAD')).toEqual([]);
    const { copperDrc } = await import('../src/drc.ts');
    const pad = b.parts.find((p) => p.refdes === 'C1')!.pads[0]!;
    const strict = { ...b, rules: { ...b.rules, viaInPad: false }, vias: [...b.vias, { netId: pad.netId!, x: pad.x, y: pad.y, drill: 0.3, pad: 0.6 }] };
    expect(copperDrc(strict).some((x) => x.code === 'DRC.VIA_IN_PAD' && x.entities.includes('C1'))).toBe(true);
  });
});

describe('mounting holes', () => {
  it('puts holes in the corners, keeps parts and copper clear, and grows an auto-sized board', () => {
    const k = buck();
    const before = k.board();
    k.transact({ summary: 'holes', ops: [{ op: 'add_hole', diameter_mm: 3.5, corner: 'all' }] });
    const b = routed(k);
    const holes = b.parts.filter((p) => p.componentId.startsWith('hole:'));
    expect(holes.map((h) => h.refdes)).toEqual(['MH1', 'MH2', 'MH3', 'MH4']);
    expect(holes.map((h) => [h.x, h.y])).toEqual([[4, 4], [b.outline.w - 4, 4], [4, b.outline.h - 4], [b.outline.w - 4, b.outline.h - 4]]);
    expect(holes.every((h) => h.pads[0]!.npth && h.pads[0]!.drill === 3.5)).toBe(true);
    expect(b.outline.w * b.outline.h).toBeGreaterThanOrEqual(before.outline.w * before.outline.h);
    // no part in a hole's keep-out, everything routed, nothing too close to a hole
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(b.stats.unrouted).toBe(0);
  });

  it('writes non-plated holes to their own drill file and keeps them out of the BOM', async () => {
    const { fabFiles } = await import('@tracewise/fab');
    const k = buck();
    k.transact({ summary: 'holes', ops: [{ op: 'add_hole', diameter_mm: 3.5, corner: 'all' }] });
    const files = fabFiles(routed(k), 'h');
    const npth = files.find((f) => f.name === 'h-NPTH.drl')!.content;
    expect(npth.split('\n').filter((l) => /^X/.test(l))).toHaveLength(4);
    expect(npth).toContain('C3.500');
    expect(files.find((f) => f.name === 'h-PTH.drl')!.content).not.toContain('C3.500');
    expect(files.find((f) => f.name === 'h-BOM.csv')!.content).not.toContain('MH1');
    // no copper flashed for them
    expect(files.find((f) => f.name === 'h-F_Cu.gbr')!.content).not.toContain('C,4.500000');
  });

  it('can plate a hole onto a net and remove holes again', () => {
    const k = buck();
    k.transact({ summary: 'hole', ops: [{ op: 'add_hole', diameter_mm: 3.2, x_mm: 5, y_mm: 5, plated: true, net: 'GND' }] });
    let b = routed(k);
    const mh = b.parts.find((p) => p.refdes === 'MH1')!;
    expect(mh.pads[0]!.npth).toBeUndefined();
    expect(b.netNames[mh.pads[0]!.netId!]).toBe('GND');
    expect(b.stats.unrouted).toBe(0);
    expect(JSON.stringify(k.transact({ summary: 'x', ops: [{ op: 'add_hole', diameter_mm: 3, x_mm: 1, y_mm: 1, net: 'GND' }] }))).toContain('Only a plated hole');
    k.transact({ summary: 'rm', ops: [{ op: 'remove_hole', id: 'all' }] });
    b = k.board();
    expect(b.parts.some((p) => p.componentId.startsWith('hole:'))).toBe(false);
  });
});

describe('milling: rounded corners and cutouts', () => {
  const inCutout = (b: ReturnType<Kernel['board']>, keep: number) => {
    const bad: string[] = [];
    for (const c of b.cutouts) {
      for (const t of b.tracks) for (let i = 0; i + 3 < t.pts.length; i += 2) {
        for (let k = 0; k <= 20; k++) {
          const x = t.pts[i]! + ((t.pts[i + 2]! - t.pts[i]!) * k) / 20;
          const y = t.pts[i + 1]! + ((t.pts[i + 3]! - t.pts[i + 1]!) * k) / 20;
          if (cutoutDistance(c, x, y) - t.width / 2 < keep - 1e-3) bad.push(`${b.netNames[t.netId]} at ${x.toFixed(2)},${y.toFixed(2)}`);
        }
      }
      for (const p of b.parts) for (const q of p.pads) if (cutoutDistance(c, q.x, q.y) < 0) bad.push(`${p.refdes}.${q.number}`);
    }
    return bad;
  };

  it('keeps parts and copper clear of a cutout; the outline file carries it', async () => {
    const k = buck();
    k.transact({ summary: 'mill', ops: [{ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'add_cutout', shape: 'rect', x_mm: 0, y_mm: 0, anchor: 'center', width_mm: 8, height_mm: 6, corner_radius_mm: 1 }, { op: 'propose_layout' }] });
    const b = routed(k);
    expect(b.cutouts.map((c) => [c.id, c.x, c.y, c.w, c.h])).toEqual([['CO1', 20, 15, 8, 6]]);
    expect(b.stats.unrouted).toBe(0);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(inCutout(b, b.rules.edgeClearance)).toEqual([]);
    // no part's courtyard over it
    for (const p of b.parts) {
      const cy = p.courtyard;
      expect(cy.x + cy.w <= 16 || cy.x >= 24 || cy.y + cy.h <= 12 || cy.y >= 18, p.refdes).toBe(true);
    }
    const { fabFiles } = await import('@tracewise/fab');
    const edge = fabFiles(b, 'm').find((f) => f.name === 'm-Edge_Cuts.gbr')!.content;
    // two contours: the outline and the cutout (each starts with a move D02)
    expect(edge.split('\n').filter((l) => l.endsWith('D02*')).length).toBe(2);
  });

  it('an anchored cutout follows the board size; rounded corners keep copper off them', () => {
    const k = buck();
    k.transact({ summary: 'mill', ops: [{ op: 'set_board', width_mm: 40, height_mm: 30, corner_radius_mm: 4 }, { op: 'add_cutout', shape: 'slot', x_mm: -6, y_mm: 0, anchor: 'right', width_mm: 8, height_mm: 1.5 }, { op: 'propose_layout' }] });
    let b = routed(k);
    expect([b.cutouts[0]!.x, b.cutouts[0]!.y]).toEqual([34, 15]);
    expect(b.cornerRadius).toBe(4);
    expect(b.stats.unrouted).toBe(0);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(inCutout(b, b.rules.edgeClearance)).toEqual([]);
    k.transact({ summary: 'wider', ops: [{ op: 'set_board', width_mm: 50 }] });
    b = k.board();
    expect([b.cutouts[0]!.x, b.cutouts[0]!.y]).toEqual([44, 15]);
    k.transact({ summary: 'rm', ops: [{ op: 'remove_cutout', id: 'CO1' }] });
    expect(k.board().cutouts).toEqual([]);
  });
});

describe('free-form outline (set_outline)', () => {
  // a Christmas tree: three tiers and a trunk, drawn in its own units
  const tree = 'M 50 0 L 70 25 L 60 25 L 80 50 L 68 50 L 90 75 L 55 75 L 55 90 L 45 90 L 45 75 L 10 75 L 32 50 L 20 50 L 40 25 L 30 25 Z';

  it('an SVG path becomes the outline, scaled to the size asked for; parts and copper stay inside', async () => {
    const k = buck();
    k.transact({ summary: 'tree', ops: [{ op: 'set_outline', svg_path: tree, height_mm: 100 }, { op: 'propose_layout' }] });
    const b = routed(k);
    expect(b.outline.h).toBe(100);
    expect(b.outline.w).toBeCloseTo(88.889, 2);
    expect(b.shape).toHaveLength(30);
    expect(b.stats.unrouted).toBe(0);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    const { insideBoard } = await import('@tracewise/schema');
    for (const p of b.parts) {
      const c = p.courtyard;
      for (const [x, y] of [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]] as const) expect(insideBoard(b, x, y), p.refdes).toBeGreaterThan(0);
    }
    for (const t of b.tracks) for (let i = 0; i < t.pts.length; i += 2) expect(insideBoard(b, t.pts[i]!, t.pts[i + 1]!) - t.width / 2).toBeGreaterThanOrEqual(b.rules.edgeClearance - 1e-3);
    const { fabFiles } = await import('@tracewise/fab');
    const edge = fabFiles(b, 't').find((f) => f.name === 't-Edge_Cuts.gbr')!.content;
    expect(edge.split('\n').filter((l) => l.endsWith('D01*')).length).toBe(15);
  });

  it('curves and arcs are sampled; a crossing outline is refused; back to a rectangle', () => {
    const k = buck();
    // a circle from two arcs, 60 mm across
    k.transact({ summary: 'round', ops: [{ op: 'set_outline', svg_path: 'M 0 50 A 50 50 0 0 1 100 50 A 50 50 0 0 1 0 50 Z', width_mm: 60 }] });
    let b = k.board();
    expect([b.outline.w, b.outline.h]).toEqual([60, 60]);
    expect(b.shape!.length / 2).toBeGreaterThan(40);
    const bad = k.transact({ summary: 'bow', ops: [{ op: 'set_outline', points: [[0, 0], [10, 10], [10, 0], [0, 10]], width_mm: 30 }] });
    expect(JSON.stringify(bad)).toContain('crosses itself');
    k.transact({ summary: 'rect', ops: [{ op: 'set_outline', rectangle: true }] });
    b = k.board();
    expect(b.shape).toBeNull();
    expect([b.outline.w, b.outline.h]).toEqual([60, 60]);
  });
});

describe('router: direct tracks', () => {
  it('goes straight where it can: no spike up and back down before a pad', async () => {
    const { route } = await import('../src/router.ts');
    type Pad = import('@tracewise/schema').BoardPad;
    type Part = import('@tracewise/schema').BoardPart;
    // a buck's output corner (from a real board): L2 → C16 on +1V1 passes C14 and D3
    const data: [string, [number, number, number, number, string | undefined][]][] = [
      ['C12', [[31.9, 27, 0.95, 0.628, undefined], [31.9, 25.572, 0.95, 0.628, undefined]]],
      ['C13', [[35.4, 34.8, 0.95, 0.628, undefined], [35.4, 36.228, 0.95, 0.628, undefined]]],
      ['C14', [[38.6, 25.3, 0.95, 0.628, 'COMP_RC2'], [38.6, 23.872, 0.95, 0.628, undefined]]],
      ['C15', [[42.8, 30.7, 0.628, 0.95, undefined], [44.228, 30.7, 0.628, 0.95, undefined]]],
      ['C16', [[44.2, 24.2, 1.8, 0.9, '+1V1'], [44.2, 27.2, 1.8, 0.9, undefined]]],
      ['C17', [[36.8, 38.3, 0.9, 1.8, '+1V1'], [33.8, 38.3, 0.9, 1.8, undefined]]],
      ['D3', [[41.3, 26.8, 1.75, 1.45, undefined], [41.3, 22.5, 1.75, 1.45, undefined]]],
      ['L2', [[35.3, 26.7, 4.2, 1.6, undefined], [35.3, 23.6, 4.2, 1.6, '+1V1']]],
      ['R5', [[39.7, 36.2, 0.95, 0.628, '+1V1'], [39.7, 34.772, 0.95, 0.628, undefined]]],
      ['R6', [[41.6, 34.8, 0.95, 0.628, undefined], [41.6, 36.228, 0.95, 0.628, undefined]]],
      ['R7', [[42.8, 32.6, 0.628, 0.95, undefined], [44.228, 32.6, 0.628, 0.95, 'COMP_RC2']]],
      ['U2', [[35.4, 29.1, 1.4, 0.52, undefined], [35.4, 30.37, 1.4, 0.52, undefined], [35.4, 31.64, 1.4, 0.52, undefined], [35.4, 32.91, 1.4, 0.52, undefined], [40.7, 32.91, 1.4, 0.52, undefined], [40.7, 31.64, 1.4, 0.52, undefined], [40.7, 30.37, 1.4, 0.52, undefined], [40.7, 29.1, 1.4, 0.52, undefined]]],
    ];
    const parts = data.map(([refdes, ps]) => {
      const pads: Pad[] = ps.map(([x, y, w, h, netId], i) => ({ number: String(i + 1), x, y, w, h, shape: 'rect', ...(netId ? { netId } : {}), layers: ['F.Cu'] }));
      const x0 = Math.min(...pads.map((p) => p.x - p.w / 2)) - 0.25;
      const y0 = Math.min(...pads.map((p) => p.y - p.h / 2)) - 0.25;
      const x1 = Math.max(...pads.map((p) => p.x + p.w / 2)) + 0.25;
      const y1 = Math.max(...pads.map((p) => p.y + p.h / 2)) + 0.25;
      return { componentId: refdes, refdes, x: (x0 + x1) / 2, y: (y0 + y1) / 2, rot: 0, pads, courtyard: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } } as unknown as Part;
    });
    const r = route({ outline: { w: 66, h: 50 }, layers: ['F.Cu', 'B.Cu'], rules: { clearance: 0.15, track: 0.15, powerTrack: 0.5, viaDrill: 0.3, viaPad: 0.6, edgeClearance: 0.5 }, parts, powerNets: new Set(['+1V1']) });
    expect(r.failed).toEqual([]);
    const l2c16 = r.tracks.find((t) => t.netId === '+1V1' && t.pts[0] === 35.3 && t.pts[1] === 23.6 && t.pts.at(-2) === 44.2 && t.pts.at(-1) === 24.2)!;
    expect(l2c16).toBeDefined();
    // after clearing C14 and D3 it runs straight into C16 on its centre line: never above it again
    const ys = l2c16.pts.filter((_, i) => i % 2 === 1);
    const lowest = ys.indexOf(Math.min(...ys));
    expect(ys.slice(lowest).every((y, i, a) => i === 0 || y >= a[i - 1]! - 1e-9)).toBe(true);
    expect(l2c16.pts.slice(-4)).toEqual([expect.any(Number), 24.2, 44.2, 24.2]);
  });
});

describe('router: long connections on a big board', () => {
  it('finds the shortest way (no detours, no vias) when the costs run into the thousands', async () => {
    const { route } = await import('../src/router.ts');
    type Pad = import('@tracewise/schema').BoardPad;
    type Part = import('@tracewise/schema').BoardPart;
    const pad = (x: number, y: number): Pad => ({ number: '1', x, y, w: 1, h: 1, shape: 'rect', netId: 'X', layers: ['F.Cu'] });
    const part = (refdes: string, p: Pad) => ({ componentId: refdes, refdes, x: p.x, y: p.y, rot: 0, pads: [p], courtyard: { x: p.x - 1, y: p.y - 1, w: 2, h: 2 } }) as unknown as Part;
    const r = route({
      outline: { w: 200, h: 120 },
      layers: ['F.Cu', 'B.Cu'],
      rules: { clearance: 0.15, track: 0.15, powerTrack: 0.5, viaDrill: 0.3, viaPad: 0.6, edgeClearance: 0.5 },
      parts: [part('A', pad(10, 30)), part('B', pad(185, 95))],
      powerNets: new Set(),
    });
    expect(r.failed).toEqual([]);
    expect(r.vias).toEqual([]);
    const len = r.tracks.reduce((sum, t) => sum + t.pts.reduce((a, _, i) => (i % 2 === 0 && i + 3 < t.pts.length ? a + Math.hypot(t.pts[i + 2]! - t.pts[i]!, t.pts[i + 3]! - t.pts[i + 1]!) : a), 0), 0);
    // the shortest 0/45/90° way: 65 mm diagonal plus 110 mm straight
    expect(len).toBeCloseTo(65 * Math.SQRT2 + 110, 1);
  });
});

describe('router: between IC pins', () => {
  it('takes the middle of the gap between two pins', async () => {
    const { route } = await import('../src/router.ts');
    type Pad = import('@tracewise/schema').BoardPad;
    type Part = import('@tracewise/schema').BoardPart;
    const pad = (number: string, x: number, y: number, w: number, h: number, netId?: string): Pad => ({ number, x, y, w, h, shape: 'rect', netId, layers: ['F.Cu'] });
    const part = (refdes: string, x: number, y: number, pads: Pad[]) =>
      ({ componentId: refdes, refdes, x, y, rot: 0, pads, courtyard: { x: x - 1, y: y - 1, w: 2, h: 2 }, body: { x, y, w: 0, h: 0 }, pin1: { x, y } }) as unknown as Part;
    // a column of eight pins, each on its own net; the net X has to cross it. (1.2 mm pitch: the
    // gaps' middles lie on the routing grid, 9.2 is one; the lane there is three grid rows wide)
    const pins = Array.from({ length: 8 }, (_, i) => pad(String(i + 1), 10, 5 + i * 1.2, 1.4, 0.52, `p${i}`));
    const ic = part('U1', 12, 9.2, pins);
    const r1 = part('R1', 5, 9.45, [pad('1', 5, 9.45, 0.8, 0.9, 'X')]);
    const r2 = part('R2', 15, 9.45, [pad('1', 15, 9.45, 0.8, 0.9, 'X')]);
    const res = route({
      outline: { w: 20, h: 20 },
      layers: ['F.Cu'],
      rules: { clearance: 0.15, track: 0.15, powerTrack: 0.5, viaDrill: 0.3, viaPad: 0.6, edgeClearance: 0.5 },
      parts: [ic, r1, r2],
      powerNets: new Set(),
    });
    expect(res.failed).toEqual([]);
    const x = res.tracks.filter((t) => t.netId === 'X');
    // where the track passes the pin column, it runs down the gap's middle
    const crossing = x.flatMap((t) => t.pts.flatMap((_, i) => (i % 2 === 0 && i + 3 < t.pts.length && t.pts[i + 1] === t.pts[i + 3] && Math.min(t.pts[i]!, t.pts[i + 2]!) <= 9.5 && Math.max(t.pts[i]!, t.pts[i + 2]!) >= 10.5 ? [t.pts[i + 1]!] : [])));
    expect(crossing).toHaveLength(1);
    expect(crossing[0]).toBeCloseTo(9.2, 6);
  });
});

describe('set_footprint (a land pattern from the datasheet drawing)', () => {
  /** A design with an imported buzzer whose package no generator knows. */
  function withBuzzer() {
    const k = new Kernel();
    const d = k.committedDesign();
    d.parts['acme:BUZ12'] = {
      id: 'acme:BUZ12',
      mpn: 'BUZ12',
      manufacturer: 'Acme',
      description: '12 mm magnetic buzzer',
      category: 'other',
      refPrefix: 'BZ',
      package: 'BUZ12',
      pins: [
        { number: '1', name: '+', type: 'passive' },
        { number: '2', name: '-', type: 'passive' },
      ],
      params: {},
      provenance: { source: 'datasheet' },
      packageInfo: { name: 'BUZ12', family: 'other', pins: 2, body_mm: [12, 12] },
    };
    k.load(d);
    k.transact({ summary: 'buzzer', ops: [
      { op: 'add_part', part: 'acme:BUZ12', refdes: 'BZ1' },
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
      { op: 'connect', pins: ['J1.1', 'BZ1.1'], net: 'VCC' },
      { op: 'connect', pins: ['J1.2', 'BZ1.2'], net: 'GND' },
    ] });
    return k;
  }
  const pads = [
    { number: '1', x: -3.8, y: 0, w: 1.6, drill: 0.9, shape: 'rect' as const },
    { number: '2', x: 3.8, y: 0, w: 1.6, drill: 0.9 },
  ];

  it('puts a part without a footprint on the board', () => {
    const k = withBuzzer();
    expect(k.board().missing).toEqual(['BZ1']);
    const r = k.transact({ summary: 'footprint from the drawing', ops: [{ op: 'set_footprint', ref: 'BZ1', name: 'Buzzer_12x9.5RM7.6', pads, body_mm: [12, 12], round: true, height_mm: 9.5 }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const b = k.board();
    expect(b.missing).toEqual([]);
    const bz = b.parts.find((p) => p.refdes === 'BZ1')!;
    expect(bz.pads.map((p) => p.number).sort()).toEqual(['1', '2']);
    expect(bz.body).toMatchObject({ w: 12, h: 12, round: true });
    expect(Math.hypot(bz.pads[0]!.x - bz.pads[1]!.x, bz.pads[0]!.y - bz.pads[1]!.y)).toBeCloseTo(7.6, 3);
  });

  it('refuses a land pattern that misses a pin', () => {
    const k = withBuzzer();
    const r = k.transact({ summary: 'bad', ops: [{ op: 'set_footprint', ref: 'BZ1', name: 'BUZ', pads: [pads[0]!] }] });
    expect(r.status).toBe('rejected');
    expect(r.rejection?.message).toContain('pins without a pad: 2');
  });
});

describe('set_footprint review', () => {
  it('shows up as a change to accept, and accepting commits it', () => {
    const k = new Kernel();
    const d = k.committedDesign();
    d.parts['acme:BUZ12'] = {
      id: 'acme:BUZ12', mpn: 'BUZ12', manufacturer: 'Acme', description: '12 mm buzzer', category: 'other', refPrefix: 'BZ', package: 'BUZ12',
      pins: [{ number: '1', name: '+', type: 'passive' }, { number: '2', name: '-', type: 'passive' }],
      params: {}, provenance: { source: 'datasheet' }, packageInfo: { name: 'BUZ12', family: 'other', pins: 2 },
    };
    k.load(d);
    k.transact({ summary: 'buzzer', ops: [{ op: 'add_part', part: 'acme:BUZ12', refdes: 'BZ1' }] });
    k.accept();
    k.transact({ summary: 'footprint', ops: [{ op: 'set_footprint', ref: 'BZ1', name: 'Buzzer_12x9.5RM7.6', round: true, body_mm: [12, 12], pads: [
      { number: '1', x: -3.8, y: 0, w: 1.6, drill: 0.9 },
      { number: '2', x: 3.8, y: 0, w: 1.6, drill: 0.9 },
    ] }] });
    const hunk = k.proposal()?.hunks.find((h) => h.id === 'part:acme:BUZ12');
    expect(hunk?.title).toContain('footprint: BUZ12 → Buzzer_12x9.5RM7.6');
    k.accept();
    expect(k.committedDesign().parts['acme:BUZ12']!.packageInfo?.pads).toHaveLength(2);
  });
});

describe('rename_part', () => {
  it('renames the part number shown everywhere; the id stays and the review shows it', () => {
    const k = new Kernel();
    const d = k.committedDesign();
    d.parts['acme:BUZ12'] = {
      id: 'acme:BUZ12', mpn: 'BUZ12', manufacturer: 'Acme', description: '12 mm buzzer', category: 'other', refPrefix: 'BZ', package: 'BUZ12',
      pins: [{ number: '1', name: '+', type: 'passive' }, { number: '2', name: '-', type: 'passive' }],
      params: {}, provenance: { source: 'datasheet' },
    };
    k.load(d);
    k.transact({ summary: 'buzzer', ops: [{ op: 'add_part', part: 'acme:BUZ12', refdes: 'BZ1' }] });
    k.accept();
    const r = k.transact({ summary: 'rename', ops: [{ op: 'rename_part', part: 'BZ1', mpn: 'BUZ12-RC' }] });
    expect(r.status).toBe('ok');
    expect(k.proposal()?.hunks.find((h) => h.id === 'part:acme:BUZ12')?.title).toContain('name: BUZ12 → BUZ12-RC');
    k.accept();
    expect(k.committedDesign().components[Object.keys(k.committedDesign().components)[0]!]!.part).toBe('acme:BUZ12');
    expect(k.state().view.sheets[0]!.symbols.find((s) => s.refdes === 'BZ1')!.value).toBe('BUZ12-RC');
    expect(k.transact({ summary: 'generic', ops: [{ op: 'rename_part', part: 'generic:R', mpn: 'X' }] }).status).toBe('rejected');
  });
});

describe('silkscreen graphics', () => {
  // a ring: an outer circle and an inner one (a hole when filled), 10 units across
  const ring = 'M 0 5 A 5 5 0 1 1 10 5 A 5 5 0 1 1 0 5 Z M 2.5 5 A 2.5 2.5 0 1 0 7.5 5 A 2.5 2.5 0 1 0 2.5 5 Z';

  it('places a filled graphic from an SVG path, holes and all, and writes it to the silkscreen Gerber', async () => {
    const k = buck();
    const r = k.transact({ summary: 'logo', ops: [{ op: 'add_graphic', svg_path: ring, width_mm: 6, x_mm: -5, y_mm: -5, anchor: 'bottom_right', name: 'logo' }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    k.accept();
    const b = k.board();
    expect(b.graphics).toHaveLength(1);
    const g = b.graphics[0]!;
    expect(g.polys).toHaveLength(2);
    expect(g.bounds[2] - g.bounds[0]).toBeCloseTo(6, 1);
    // centred 5 mm in from the bottom-right corner
    expect((g.bounds[0] + g.bounds[2]) / 2).toBeCloseTo(b.outline.w - 5, 1);
    expect((g.bounds[1] + g.bounds[3]) / 2).toBeCloseTo(b.outline.h - 5, 1);
    const { gerbers } = await import('@tracewise/fab');
    const silk = gerbers(b, 't').find((f) => f.name.endsWith('F_Silkscreen.gbr'))!.content;
    // the outer figure filled, the inner one cleared
    expect(silk.match(/G36\*/g)!.length).toBeGreaterThanOrEqual(2);
    expect(silk).toContain('%LPC*%');
  });

  it('knows whether a graphic is on the board and clear of parts, and moves it with edit_graphic', () => {
    const k = buck();
    const b0 = k.board();
    // half off the board's right edge
    k.transact({ summary: 'off', ops: [{ op: 'add_graphic', svg_path: ring, width_mm: 6, x_mm: 0, y_mm: 0, anchor: 'right' }] });
    let g = k.board().graphics[0]!;
    expect(g.inside).toBe(false);
    expect(k.board().diagnostics.some((x) => x.code === 'DRC.SILK_OUTSIDE')).toBe(true);
    k.transact({ summary: 'in', ops: [{ op: 'edit_graphic', id: 'G1', dx_mm: -4, width_mm: 3 }] });
    g = k.board().graphics[0]!;
    expect(g.inside).toBe(true);
    expect(g.bounds[2] - g.bounds[0]).toBeCloseTo(3, 1);
    // right over a part
    const u1 = b0.parts.find((p) => p.refdes === 'U1')!;
    k.transact({ summary: 'over', ops: [{ op: 'edit_graphic', id: 'G1', anchor: 'top_left', x_mm: u1.x, y_mm: u1.y }] });
    expect(k.board().graphics[0]!.over).toContain('U1');
    expect(k.board().diagnostics.some((x) => x.code === 'DRC.SILK_OVER_PARTS')).toBe(true);
  });

  it('places saved artwork by name, at its saved size unless told otherwise', async () => {
    const { registerArtwork, unregisterArtwork } = await import('../src/index.ts');
    registerArtwork([{ id: 'dot', name: 'Dot', mode: 'fill', polys: [[-2, -2, 2, -2, 2, 2, -2, 2]], w: 4, h: 4 }]);
    try {
      const k = buck();
      expect(k.transact({ summary: 'art', ops: [{ op: 'add_graphic', artwork: 'dot', x_mm: 8, y_mm: 8 }] }).status).toBe('ok');
      expect(k.transact({ summary: 'art2', ops: [{ op: 'add_graphic', artwork: 'DOT', width_mm: 2, x_mm: 3, y_mm: 3 }] }).status).toBe('ok');
      const [a, b] = k.board().graphics;
      expect(a!.bounds[2] - a!.bounds[0]).toBeCloseTo(4, 3);
      expect(b!.bounds[2] - b!.bounds[0]).toBeCloseTo(2, 3);
      expect(a!.name).toBe('Dot');
      expect(k.transact({ summary: 'none', ops: [{ op: 'add_graphic', artwork: 'nope', x_mm: 1, y_mm: 1 }] }).rejection?.candidates).toContain('Dot');
    } finally {
      unregisterArtwork('dot');
    }
  });

  it('removes graphics, and rejects paths without a closed figure', () => {
    const k = buck();
    k.transact({ summary: 'logo', ops: [{ op: 'add_graphic', svg_path: ring, mode: 'outline', width_mm: 8, x_mm: 10, y_mm: 10 }] });
    expect(k.board().graphics[0]!.mode).toBe('outline');
    k.transact({ summary: 'gone', ops: [{ op: 'remove_graphic', id: 'G1' }] });
    expect(k.board().graphics).toEqual([]);
    expect(k.transact({ summary: 'bad', ops: [{ op: 'add_graphic', svg_path: 'M 0 0 L 5 5', x_mm: 1, y_mm: 1 }] }).status).toBe('rejected');
  });
});

describe('package defaults', () => {
  it('a design default changes every generic part without its own package; the review carries it', () => {
    const k = buck();
    const before = k.board().parts.find((p) => p.refdes === 'R1')!.pkg;
    expect(before).toBe('0603');
    const r = k.transact({ summary: 'hand solder', ops: [{ op: 'set_package_defaults', passives: '0805' }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(k.proposal()?.hunks.some((h) => h.id === 'board:packages')).toBe(true);
    k.accept();
    expect(k.committedDesign().packageDefaults).toMatchObject({ resistor: '0805', capacitor: '0805', led: '0805' });
    expect(k.board().parts.find((p) => p.refdes === 'R1')!.pkg).toBe('0805');
    // explicit packages stay
    expect(k.board().parts.find((p) => p.refdes === 'C1')!.pkg).toBe('1206');
    expect(k.query({ op: 'get_component', ref: 'R1' })).toMatchObject({ package: { name: '0805', why: 'default' } });
  });

  it('rejects unknown package names with the known ones', () => {
    const k = buck();
    const r = k.transact({ summary: 'bad', ops: [{ op: 'set_param', ref: 'R1', params: { package: '0607' } }] });
    expect(r.status).toBe('rejected');
    expect(r.rejection?.candidates).toContain('AXIAL-0.4');
    expect(k.transact({ summary: 'tht', ops: [{ op: 'set_param', ref: 'R1', params: { package: 'AXIAL-0.4' } }] }).status).toBe('ok');
    expect(k.board().parts.find((p) => p.refdes === 'R1')!.pads.every((p) => !!p.drill)).toBe(true);
  });
});

describe('track width per net', () => {
  it('routes a net at its own width where the pads take it, and get_net suggests a width from the current', () => {
    const k = buck();
    expect(k.transact({ summary: 'wide', ops: [{ op: 'set_net', net: '+12V', max_current: 2, track_mm: 0.8 }] }).status).toBe('ok');
    k.accept();
    const info = k.query({ op: 'get_net', net: '+12V' }) as { track: { width_mm: number; suggested_mm: number; why: string } };
    expect(info.track.width_mm).toBe(0.8);
    expect(info.track.why).toBe('set for this net');
    expect(info.track.suggested_mm).toBeGreaterThanOrEqual(0.7);
    const b = routed(k);
    const nid = Object.entries(b.netNames).find(([, n]) => n === '+12V')![0];
    const widths = new Set(b.tracks.filter((t) => t.netId === nid).map((t) => t.width));
    expect([...widths].some((w) => w > b.rules.track)).toBe(true);
    expect(Math.max(...widths)).toBeLessThanOrEqual(0.8);
    expect(k.transact({ summary: 'bad', ops: [{ op: 'set_net', net: '+12V', track_mm: 20 }] }).status).toBe('rejected');
  });
});

describe('trackWidthFor', () => {
  it('follows IPC-2221 for 1 oz outer copper at 10 °C rise', async () => {
    const { trackWidthFor } = await import('@tracewise/schema');
    expect(trackWidthFor(0.1)).toBe(0.15); // floor
    expect(trackWidthFor(1)).toBeCloseTo(0.3, 2);
    expect(trackWidthFor(2)).toBeCloseTo(0.8, 2);
    expect(trackWidthFor(3)).toBeGreaterThan(1.2);
  });
});
