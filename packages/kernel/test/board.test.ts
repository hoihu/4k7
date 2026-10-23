import { afterAll, describe, expect, it } from 'vitest';
import { boardSummary, cutoutDistance, type Track } from '@4k7/schema';
import { draftToCard, registerUserParts, unregisterUserPart } from '@4k7/parts';
import { Kernel } from '../src/index.ts';
import { edgeCrossings, splitDrc } from '../src/drc.ts';
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

describe('parts on the bottom side (constrain layer)', () => {
  const flip = (k: Kernel, ref: string, value = 'bottom') => k.transact({ summary: 'side', ops: [{ op: 'constrain', kind: 'layer', a: ref, value }] });

  it('mirrors the footprint onto B.Cu; back on top it is as before', () => {
    const k = buck();
    const top = k.board().parts.find((p) => p.refdes === 'U1')!;
    expect(top.side).toBe('top');
    expect(flip(k, 'U1').status).toBe('ok');
    const bot = k.board().parts.find((p) => p.refdes === 'U1')!;
    expect(bot.side).toBe('bottom');
    expect([bot.x, bot.y, bot.rot]).toEqual([top.x, top.y, top.rot]);
    expect(bot.pads.every((p) => !!p.drill || p.layers.join() === 'B.Cu')).toBe(true);
    // each pad lies mirrored about the part's axis (which one depends on the rotation)
    const flipsX = top.rot % 180 === 0;
    for (const pad of top.pads) {
      const m = bot.pads.find((q) => q.number === pad.number)!;
      expect(m.x).toBeCloseTo(flipsX ? 2 * top.x - pad.x : pad.x, 3);
      expect(m.y).toBeCloseTo(flipsX ? pad.y : 2 * top.y - pad.y, 3);
    }
    expect((k.query({ op: 'get_component', ref: 'U1' }) as { side: string }).side).toBe('bottom');
    flip(k, 'U1', 'top');
    expect(k.board().parts.find((p) => p.refdes === 'U1')!.pads).toEqual(top.pads);
  });

  it('an SMD part may sit under an SMD part on the other side; on the same side they are kept apart', () => {
    const k = buck();
    k.transact({ summary: 'route', ops: [{ op: 'propose_placement' }] });
    const u1 = k.board().parts.find((p) => p.refdes === 'U1')!;
    const cap = k.board().parts.find((p) => p.follows === 'U1' && p.pads.length === 2 && p.pads.every((q) => !q.drill))!;
    flip(k, cap.refdes);
    k.transact({ summary: 'under', ops: [{ op: 'place', ref: cap.refdes, x_mm: u1.x, y_mm: u1.y, lock: true }] });
    const b = k.board();
    const under = b.parts.find((p) => p.refdes === cap.refdes)!;
    expect([under.x, under.y, under.side]).toEqual([u1.x, u1.y, 'bottom']);
    expect(b.parts.find((p) => p.refdes === 'U1')).toMatchObject({ x: u1.x, y: u1.y });
    expect(b.diagnostics.filter((x) => x.code === 'DRC.COURTYARD_OVERLAP')).toEqual([]);
    // back on the same side they compete for the area again: the placer moves U1 off the locked cap
    flip(k, cap.refdes, 'top');
    const again = k.board();
    expect(again.parts.find((p) => p.refdes === 'U1')).not.toMatchObject({ x: u1.x, y: u1.y });
    expect(again.diagnostics.filter((x) => x.code === 'DRC.COURTYARD_OVERLAP')).toEqual([]);
  });

  it('routes to bottom-side parts, DRC-clean and every net in one piece', () => {
    const k = buck();
    const caps = k.board().parts.filter((p) => p.pads.length === 2 && p.pads.every((q) => !q.drill)).slice(0, 3);
    for (const c of caps) flip(k, c.refdes);
    const b = routed(k);
    expect(b.parts.filter((p) => p.side === 'bottom').map((p) => p.refdes)).toEqual(caps.map((c) => c.refdes));
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(b.ratsnest).toEqual([]);
    expect(brokenNets(b)).toEqual([]);
  });
});

/** Nets that are not one connected piece of copper, judged from geometry only. */
/** Distance from a point to a segment (x0, y0, x1, y1). */
function segPoint([ax, ay, bx, by]: number[], x: number, y: number): number {
  const dx = bx! - ax!;
  const dy = by! - ay!;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - ax!) * dx + (y - ay!) * dy) / l2)) : 0;
  return Math.hypot(x - (ax! + t * dx), y - (ay! + t * dy));
}

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
    // a via whose centre lies on a track's copper (a row of vias on a bar beside a pad)
    const viaOn = (e: Node, o: Node) => !o.seg && o.x1 - o.x0 > 0 && Math.abs(o.x1 - o.x0 - (o.y1 - o.y0)) < 1e-9 && b.vias.some((v) => v.x === (o.x0 + o.x1) / 2 && v.y === (o.y0 + o.y1) / 2 && v.netId === o.net) && segPoint(e.seg!, (o.x0 + o.x1) / 2, (o.y0 + o.y1) / 2) <= e.r!;
    return (!!a.seg && (endTouches(a, c) || viaOn(a, c))) || (!!c.seg && (endTouches(c, a) || viaOn(c, a)));
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
    k.transact({ summary: 'room', ops: [{ op: 'set_board', width_mm: 60, height_mm: 40 }, { op: 'propose_placement' }] });
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
    k.transact({ summary: 'keep', ops: [{ op: 'propose_placement' }] });
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

  it('propose_placement starts over; it keeps locked parts, and the choices unless told not to', () => {
    const k = buck();
    const c4 = at(k, 'C4');
    k.transact({ summary: 'c', ops: [{ op: 'place', ref: 'C4', x_mm: c4.x - 1, y_mm: c4.y }, { op: 'place', ref: 'J1', x_mm: 4, y_mm: 8, lock: true }] });
    k.transact({ summary: 'again', ops: [{ op: 'propose_placement' }] });
    expect(at(k, 'C4').intent).toEqual({ anchor: 'U1' });
    expect(at(k, 'J1').locked).toBe(true);
    k.transact({ summary: 'fresh', ops: [{ op: 'propose_placement', keep_choices: false }] });
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

describe('the agent decides the main parts (propose_placement parts, try_placements)', () => {
  const at = (k: Kernel, ref: string) => k.board().parts.find((p) => p.refdes === ref)!;
  const errors = (k: Kernel) => k.board().diagnostics.filter((x) => x.severity === 'error');

  it('puts the main parts where the agent decides, turned as it says, and the small parts round them', () => {
    const k = buck();
    const r = k.transact({ summary: 'arrange', ops: [{ op: 'propose_placement', parts: [{ ref: 'U1', x_mm: 14, y_mm: 10, rot: 90 }, { ref: 'J1', x_mm: 4, y_mm: 10, rot: 90 }] }] });
    expect(r.status).toBe('ok');
    const u1 = at(k, 'U1');
    expect(u1.rot).toBe(90);
    expect(at(k, 'J1').rot).toBe(90);
    // the arrangement kept as given (the board fitted round it may move it over as a whole)
    expect(Math.abs(u1.x - at(k, 'J1').x - 10)).toBeLessThan(0.5);
    expect(u1.intent).toBeDefined();
    // U1's input and bootstrap caps at its pins, turned with it
    for (const ref of ['C1', 'C4']) expect(Math.hypot(at(k, ref).x - u1.x, at(k, ref).y - u1.y)).toBeLessThan(7);
    expect(errors(k)).toEqual([]);
    // a compact board: the small parts at an IC's far side do not jam against the edge
    expect(k.board().outline.w * k.board().outline.h).toBeLessThan(900);
  });

  it('the placement stays as proposed when laid out again', () => {
    const k = buck();
    k.transact({ summary: 'arrange', ops: [{ op: 'propose_placement', parts: [{ ref: 'U1', x_mm: 6, y_mm: 6, rot: 270 }] }] });
    const before = k.board();
    k.transact({ summary: 'size', ops: [{ op: 'set_net', net: '+3V3', voltage: 3.3 }] });
    const after = k.board();
    expect(after.parts.map((p) => [p.refdes, p.x, p.y, p.rot])).toEqual(before.parts.map((p) => [p.refdes, p.x, p.y, p.rot]));
  });

  it('given again, a part\'s place is replaced; a locked part is refused', () => {
    const k = buck();
    k.transact({ summary: 'a', ops: [{ op: 'propose_placement', parts: [{ ref: 'U1', x_mm: 14, y_mm: 10 }] }] });
    k.transact({ summary: 'b', ops: [{ op: 'propose_placement', parts: [{ ref: 'U1', x_mm: 14, y_mm: 10, rot: 180 }] }] });
    expect(at(k, 'U1').rot).toBe(180);
    expect(k.query({ op: 'get_ledger' })).toHaveLength(1);
    k.transact({ summary: 'lock', ops: [{ op: 'place', ref: 'J1', x_mm: 4, y_mm: 8, lock: true }] });
    const r = k.transact({ summary: 'c', ops: [{ op: 'propose_placement', parts: [{ ref: 'J1', x_mm: 4, y_mm: 12 }] }] });
    expect(r.status).toBe('rejected');
    expect(r.rejection?.fixHints?.[0]?.op).toBe('remove_constraint');
  });

  it('try_placements measures each option as propose_placement would place it, without changing the design', () => {
    const k = buck();
    k.transact({ summary: 'start', ops: [{ op: 'propose_placement' }] });
    const design = JSON.stringify(k.draftDesign());
    const parts = [{ ref: 'U1', x_mm: 14, y_mm: 10, rot: 90 as const }, { ref: 'J1', x_mm: 4, y_mm: 10, rot: 90 as const }];
    const out = k.query({
      op: 'try_placements',
      route: true,
      candidates: [
        { name: 'turned', parts },
        { name: 'as drawn', parts: [{ ref: 'U1', x_mm: 14, y_mm: 10 }] },
        { name: 'locked?', parts: [{ ref: 'U1', x_mm: 14, y_mm: 10 }, { ref: 'U1', x_mm: 4, y_mm: 4 }] },
      ],
    }) as { current: { ratsnest_mm: number }; options: { name: string; error?: string; ratsnest_mm?: number; ratsnest_crossings?: number; routing?: { open_connections: number } }[] };
    expect(JSON.stringify(k.draftDesign())).toBe(design);
    expect(out.current.ratsnest_mm).toBeGreaterThan(0);
    expect(out.options).toHaveLength(3);
    // a broken option is reported, last
    expect(out.options.at(-1)).toMatchObject({ name: 'locked?', error: expect.stringContaining('twice') });
    const turned = out.options.find((o) => o.name === 'turned')!;
    expect(turned.routing?.open_connections).toBe(0);
    // what was tried is what propose_placement gives
    k.transact({ summary: 'apply', ops: [{ op: 'propose_placement', parts }] });
    const b = k.boardPlacement();
    expect([b.measures.ratsnestMm, b.measures.crossings]).toEqual([turned.ratsnest_mm, turned.ratsnest_crossings]);
  });
});

describe('who placed a part: the user\'s placement and the agent\'s', () => {
  const at = (k: Kernel, ref: string) => k.board().parts.find((p) => p.refdes === ref)!;
  /** The user's own edit, as the app makes it (a drag, the lock button). */
  const byUser = (k: Kernel, ops: unknown[]) => {
    expect(k.transact({ summary: 'user', ops }, 'user').status).toBe('ok');
    k.accept(undefined, 'user');
  };

  it('a drag is the user\'s, the agent\'s place is its own unless it quotes the user', () => {
    const k = buck();
    const c4 = at(k, 'C4');
    byUser(k, [{ op: 'place', ref: 'C4', x_mm: c4.x - 1, y_mm: c4.y }, { op: 'place', ref: 'J1', x_mm: 4, y_mm: 8, lock: true }]);
    k.transact({ summary: 'agent', ops: [{ op: 'place', ref: 'R3', x_mm: at(k, 'R3').x, y_mm: at(k, 'R3').y }, { op: 'place', ref: 'C5', x_mm: at(k, 'C5').x, y_mm: at(k, 'C5').y, quote: 'put C5 there' }] });
    expect(['C4', 'J1', 'R3', 'C5'].map((r) => at(k, r).by)).toEqual(['user', 'user', 'agent', 'user']);
    expect(at(k, 'U1').by).toBeUndefined();
    const s = boardSummary(k.board(), false);
    expect(s.parts.find((p) => p.refdes === 'C4')!.placed).toBe('user (relative to U1)');
    expect(s.parts.find((p) => p.refdes === 'J1')!.placed).toBe('locked by the user');
    expect(s.parts.find((p) => p.refdes === 'R3')!.placed).toMatch(/^agent/);
    expect(s.user_placed!.parts).toEqual(['C4', 'C5', 'J1']);
  });

  it('the agent moving a part of the user\'s says so; the user moving the agent\'s makes it theirs', () => {
    const k = buck();
    byUser(k, [{ op: 'place', ref: 'C4', x_mm: at(k, 'C4').x - 1, y_mm: at(k, 'C4').y }]);
    const r = k.transact({ summary: 'agent', ops: [{ op: 'place', ref: 'C4', x_mm: at(k, 'C4').x + 0.5, y_mm: at(k, 'C4').y }] });
    expect(r.results[0]!.effect).toMatch(/was the user's placement/);
    expect(at(k, 'C4').by).toBe('agent');
    k.accept();
    byUser(k, [{ op: 'place', ref: 'C4', x_mm: at(k, 'C4').x, y_mm: at(k, 'C4').y + 0.5 }]);
    expect(at(k, 'C4').by).toBe('user');
  });

  it('propose_placement and try_placements refuse the user\'s parts; keep_choices false forgets only the agent\'s', () => {
    const k = buck();
    byUser(k, [{ op: 'place', ref: 'U1', x_mm: 14, y_mm: 10, rot: 90 }]);
    const r = k.transact({ summary: 'arrange', ops: [{ op: 'propose_placement', parts: [{ ref: 'U1', x_mm: 8, y_mm: 8 }] }] });
    expect(r.status).toBe('rejected');
    expect(r.rejection!.message).toMatch(/U1 was placed by the user/);
    const t = k.query({ op: 'try_placements', candidates: [{ parts: [{ ref: 'U1', x_mm: 8, y_mm: 8 }] }, { parts: [{ ref: 'J1', x_mm: 3, y_mm: 10, rot: 90 }] }] }) as { options: { option: number; error?: string }[] };
    expect(t.options.find((o) => o.option === 1)!.error).toMatch(/placed by the user/);
    expect(t.options.find((o) => o.option === 2)!.error).toBeUndefined();
    // the agent arranges round it; starting over forgets its own choices, never the user's
    expect(k.transact({ summary: 'arrange', ops: [{ op: 'propose_placement', parts: [{ ref: 'J1', x_mm: 3, y_mm: 10, rot: 90 }] }] }).status).toBe('ok');
    expect([at(k, 'U1').by, at(k, 'J1').by]).toEqual(['user', 'agent']);
    expect(k.transact({ summary: 'fresh', ops: [{ op: 'propose_placement', keep_choices: false }] }).status).toBe('ok');
    expect([at(k, 'U1').by, at(k, 'U1').rot, at(k, 'J1').intent]).toEqual(['user', 90, undefined]);
  });

  it('a waiver the user adds from the app is theirs', () => {
    const k = buck();
    byUser(k, [{ op: 'add_waiver', code: 'X.TEST', entities: ['U1'], reason: 'intended' }]);
    expect(Object.values(JSON.parse(k.exportDesign()).waivers as Record<string, { by: string }>).map((w) => w.by)).toEqual(['user']);
  });
});

describe('which part belongs with which (attach)', () => {
  const at = (k: Kernel, ref: string) => k.board().parts.find((p) => p.refdes === ref)!;
  const belongs = (k: Kernel) => Object.fromEntries((k.query({ op: 'get_board' }) as { parts: { refdes: string; belongs_to?: string }[] }).parts.map((p) => [p.refdes, p.belongs_to ?? '-']));
  const pad = (k: Kernel, ref: string, n: string) => at(k, ref).pads.find((q) => q.number === n)!;
  const gap = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

  it('get_board shows the placer\'s guesses, marked as such', () => {
    const b = belongs(buck());
    expect(b.C4).toBe('U1.1 (guessed)');
    expect(b.J1).toBe('U1 (guessed)');
    expect(b.C2).toBe('-');
  });

  it('a declared parent and pin: the part goes to that pin and follows its new parent', () => {
    const k = buck();
    const r = k.transact({ summary: 'input cap at the connector', ops: [{ op: 'attach', ref: 'C1', to: 'J1', pin: '1' }] });
    expect(r.status).toBe('ok');
    expect(r.results[0]!.effect).toBe('C1 belongs with J1 at J1.1');
    expect(belongs(k).C1).toBe('J1.1');
    expect(gap(pad(k, 'C1', '1'), pad(k, 'J1', '1'))).toBeLessThan(4);
    // J1 moved: C1 comes along
    const j1 = at(k, 'J1');
    const c1 = at(k, 'C1');
    k.transact({ summary: 'drag', ops: [{ op: 'place', ref: 'J1', x_mm: j1.x, y_mm: j1.y + 3 }] }, 'user');
    expect(at(k, 'C1').y).toBeCloseTo(c1.y + 3, 0); // and settles at the pin again
    expect(k.board().diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('none: the part no longer follows a part it was guessed to belong with', () => {
    const k = buck();
    k.transact({ summary: 'J1 stands alone', ops: [{ op: 'attach', ref: 'J1', to: null }] });
    expect(belongs(k).J1).toBe('none');
    const j1 = at(k, 'J1');
    const u1 = at(k, 'U1');
    k.transact({ summary: 'drag', ops: [{ op: 'place', ref: 'U1', x_mm: u1.x + 4, y_mm: u1.y }] }, 'user');
    expect([at(k, 'J1').x, at(k, 'J1').y]).toEqual([j1.x, j1.y]);
    // without the declaration J1 went along with U1
    const g = buck();
    const gj = at(g, 'J1');
    g.transact({ summary: 'drag', ops: [{ op: 'place', ref: 'U1', x_mm: at(g, 'U1').x + 4, y_mm: at(g, 'U1').y }] }, 'user');
    expect(at(g, 'J1').x).not.toBe(gj.x);
  });

  it('a part the user placed stays where it is, now kept relative to its new parent', () => {
    const k = buck();
    const c1 = at(k, 'C1');
    k.transact({ summary: 'drag', ops: [{ op: 'place', ref: 'C1', x_mm: c1.x, y_mm: c1.y + 1 }] }, 'user');
    k.accept(undefined, 'user');
    const placed = at(k, 'C1');
    const r = k.transact({ summary: 'at J1', ops: [{ op: 'attach', ref: 'C1', to: 'J1' }] });
    expect(r.results[0]!.effect).toMatch(/the user's placement: it stays where it is/);
    expect([at(k, 'C1').x, at(k, 'C1').y, at(k, 'C1').intent]).toEqual([placed.x, placed.y, { anchor: 'J1' }]);
  });

  it('refuses a circle, a pin it is not connected to, and a pin without a part', () => {
    const k = buck();
    expect(k.transact({ summary: 'a', ops: [{ op: 'attach', ref: 'C4', to: 'U1', pin: 'BOOT' }] }).status).toBe('ok');
    const circle = k.transact({ summary: 'b', ops: [{ op: 'attach', ref: 'U1', to: 'C4' }] });
    expect(circle.rejection!.message).toMatch(/C4 belongs with U1/);
    expect(k.transact({ summary: 'c', ops: [{ op: 'attach', ref: 'C1', to: 'U1', pin: 'BOOT' }] }).rejection!.message).toMatch(/C1 is not connected to U1.BOOT/);
    expect(k.transact({ summary: 'd', ops: [{ op: 'attach', ref: 'C1', to: null, pin: '1' }] }).status).toBe('rejected');
    // remove_constraint goes back to the guess
    const id = (k.query({ op: 'get_ledger' }) as { id: string; text: string }[]).find((x) => x.text.startsWith('belongs(C4'))!.id;
    k.transact({ summary: 'e', ops: [{ op: 'remove_constraint', id }] });
    expect(belongs(k).C4).toBe('U1.1 (guessed)');
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

describe('a part the user puts at the edge', () => {
  /** How far inside each side of the board the part's copper (with the edge clearance) and body come. */
  const room = (b: ReturnType<Kernel['board']>, ref: string) => {
    const p = b.parts.find((x) => x.refdes === ref)!;
    const e = b.rules.edgeClearance;
    const B = p.body;
    return {
      left: Math.min(B.x, ...p.pads.map((q) => q.x - q.w / 2 - e)),
      top: Math.min(B.y, ...p.pads.map((q) => q.y - q.h / 2 - e)),
      right: b.outline.w - Math.max(B.x + B.w, ...p.pads.map((q) => q.x + q.w / 2 + e)),
      bottom: b.outline.h - Math.max(B.y + B.h, ...p.pads.map((q) => q.y + q.h / 2 + e)),
    };
  };

  it('goes right up to it, any part, turned any way: copper keeps the edge clearance, the body stays on the board', () => {
    for (const [ref, rot] of [['J1', 0], ['J1', 90], ['C3', 270], ['U1', 180]] as const) {
      const k = buck();
      k.transact({ summary: 'board', ops: [{ op: 'set_board', width_mm: 40, height_mm: 30 }] });
      // dropped past the bottom-right corner: it stops at the edge, not the placer's margin away
      k.transact({ summary: 'drag', ops: [{ op: 'place', ref, x_mm: 45, y_mm: 35, rot }] });
      const b = k.board();
      const r = room(b, ref);
      expect(r.right, `${ref} ${rot}°`).toBeGreaterThanOrEqual(-1e-6);
      expect(r.right, `${ref} ${rot}°`).toBeLessThanOrEqual(0.1 + 1e-6);
      expect(r.bottom, `${ref} ${rot}°`).toBeGreaterThanOrEqual(-1e-6);
      expect(r.bottom, `${ref} ${rot}°`).toBeLessThanOrEqual(0.1 + 1e-6);
      expect(b.diagnostics.filter((x) => x.severity === 'error' && x.entities?.includes(ref))).toEqual([]);
    }
  });

  it('the placer\'s own parts still keep their margin from the edge', () => {
    const k = buck();
    k.transact({ summary: 'board', ops: [{ op: 'set_board', width_mm: 40, height_mm: 30 }] });
    k.transact({ summary: 'drag', ops: [{ op: 'place', ref: 'J1', x_mm: 0, y_mm: 15, rot: 90 }] });
    const b = k.board();
    for (const p of b.parts) {
      if (p.intent || p.locked) continue;
      const c = p.courtyard;
      expect(Math.min(c.x, c.y, b.outline.w - c.x - c.w, b.outline.h - c.y - c.h), p.refdes).toBeGreaterThanOrEqual(1.5 + b.rules.edgeClearance - 0.06);
    }
    expect(room(b, 'J1').left).toBeLessThanOrEqual(0.1 + 1e-6);
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

  it('puts the rail the ICs draw from on the supply plane, not the one with the most pins', () => {
    const k = buck();
    // +12V gets more pins (bulk caps), +3V3 feeds more IC supply pins (two op-amps)
    k.transact({
      summary: 'loads',
      ops: [
        { op: 'add_part', part: 'ti:LM358DR', refdes: 'U2' },
        { op: 'add_part', part: 'ti:LM358DR', refdes: 'U3' },
        ...['C10', 'C11', 'C12'].map((refdes) => ({ op: 'add_part' as const, part: 'generic:C', refdes, params: { capacitance: '10uF', voltage: '25V' } })),
        { op: 'connect', pins: ['U2.V+', 'U3.V+'], net: '+3V3' },
        { op: 'connect', pins: ['U2.GND', 'U3.GND', 'C10.2', 'C11.2', 'C12.2'], net: 'GND' },
        { op: 'connect', pins: ['C10.1', 'C11.1', 'C12.1'], net: '+12V' },
        { op: 'set_board', layers: 4 },
      ],
    });
    const b = k.board();
    expect(b.planes.map((p) => [b.netNames[p.netId], p.layer])).toEqual([['GND', 'In1.Cu'], ['+3V3', 'In2.Cu']]);
  });

  it('splits a plane layer: +12V fills In2.Cu, +3V3 only under the op-amp, each pad on its own plane', () => {
    const k = buck();
    const r = k.transact({
      summary: 'split',
      ops: [
        { op: 'add_part', part: 'ti:LM358DR', refdes: 'U2' },
        { op: 'add_part', part: 'generic:C', refdes: 'C10', params: { capacitance: '100nF', voltage: '16V' } },
        { op: 'connect', pins: ['U2.V+', 'C10.1'], net: '+3V3' },
        { op: 'connect', pins: ['U2.GND', 'C10.2'], net: 'GND' },
        { op: 'connect', pins: ['U2.INA+', 'U2.OUTA', 'U2.INA-'], net: 'BUF' },
        { op: 'connect', pins: ['U2.INB+', 'U2.OUTB', 'U2.INB-'], net: 'BUF2' },
        { op: 'set_board', layers: 4 },
        { op: 'set_plane', layer: 'In2.Cu', net: '+12V' },
        { op: 'set_plane', layer: 'In2.Cu', net: '+3V3', under: ['U2'] },
      ],
    });
    expect(r.status).toBe('ok');
    const b = routed(k);
    const u2 = b.parts.find((p) => p.refdes === 'U2')!.courtyard;
    const area = b.planes.find((p) => b.netNames[p.netId] === '+3V3')!;
    expect(area).toMatchObject({ layer: 'In2.Cu', under: ['U2'] });
    // the area: U2's courtyard with the margin round it (within the board)
    expect(area.area![0]).toBeLessThanOrEqual(u2.x);
    expect(area.area![2]).toBeCloseTo(u2.x + u2.w + 1.5, 3);
    const zone = (net: string) => b.zones.find((z) => b.netNames[z.netId] === net && z.layer === 'In2.Cu')!;
    expect(zone('+3V3').shape!.outline).toEqual([Math.max(0.5, area.area![0]), area.area![1], area.area![2], area.area![3]]);
    // the full plane goes round the area with the clearance
    expect(zone('+12V').shape!.cuts).toContainEqual({ k: 'rect', x: expect.closeTo(area.area![0] - 0.2, 3), y: expect.closeTo(area.area![1] - 0.2, 3), w: expect.closeTo(area.area![2] - area.area![0] + 0.4, 3), h: expect.closeTo(area.area![3] - area.area![1] + 0.4, 3) });
    expect(b.tracks.filter((t) => t.layer === 'In2.Cu')).toEqual([]);
    expect(b.stats.unrouted).toBe(0);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(brokenNets(b)).toEqual([]);
    // the area follows U2
    const at = b.parts.find((p) => p.refdes === 'U2')!;
    k.transact({ summary: 'move', ops: [{ op: 'place', ref: 'U2', x_mm: at.x + 3, y_mm: at.y }] });
    expect(k.board().planes.find((p) => p.area)!.area![2]).toBeCloseTo(area.area![2] + 3, 1);
  });

  it('set_plane_style shapes a plane: a wider gap round an area, more clearance, pulled back from the edge, joined solid', () => {
    const k = buck();
    k.transact({
      summary: 'split',
      ops: [
        { op: 'set_board', layers: 4 },
        { op: 'set_plane', layer: 'In2.Cu', net: '+12V' },
        { op: 'set_plane', layer: 'In2.Cu', net: '+3V3', rect: { x_mm: 4, y_mm: 4, width_mm: 8, height_mm: 6 } },
      ],
    });
    const zone = (b: ReturnType<Kernel['board']>, net: string) => b.zones.find((z) => b.netNames[z.netId] === net && z.layer === 'In2.Cu')!.shape!;
    const before = routed(k);
    const cut = (b: ReturnType<Kernel['board']>) => zone(b, '+12V').cuts.find((c) => c.k === 'rect' && c.w > 8 && c.h > 6) as { x: number; w: number };
    expect(cut(before)).toMatchObject({ x: 3.8, w: 8.4 });
    const r = k.transact({
      summary: 'style',
      ops: [
        { op: 'set_plane_style', layer: 'In2.Cu', net: '+3V3', gap_mm: 1 },
        { op: 'set_plane_style', layer: 'In2.Cu', net: '+12V', clearance_mm: 0.5, edge_mm: 1.5 },
        { op: 'set_plane_style', layer: 'In1.Cu', net: 'GND', thermal: false },
      ],
    });
    expect(r.status).toBe('ok');
    expect(k.board().routing).toBe('stale');
    const b = routed(k);
    // the gap: the area plus 1 mm all round is cut from +12V
    expect(cut(b)).toMatchObject({ x: 3, w: 10 });
    // +12V pulled back 1.5 mm from the edge, and 0.5 mm clear of other nets' vias
    expect(zone(b, '+12V').outline.slice(0, 2)).toEqual([1.5, 1.5]);
    const foreign = b.vias.find((v) => b.netNames[v.netId] !== '+12V')!;
    expect(zone(b, '+12V').cuts).toContainEqual({ k: 'circle', x: foreign.x, y: foreign.y, d: expect.closeTo(foreign.pad + 1, 3) });
    // GND joined solid: no relief rings or spokes round its own vias
    const gnd = b.zones.find((z) => z.layer === 'In1.Cu')!.shape!;
    expect(gnd.adds).toEqual([]);
    const own = b.vias.find((v) => b.netNames[v.netId] === 'GND')!;
    expect(gnd.cuts.some((c) => c.k === 'circle' && c.x === own.x && c.y === own.y)).toBe(false);
    expect(b.stats.unrouted).toBe(0);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(brokenNets(b)).toEqual([]);
    // the style stays when the area is set again; null goes back to the default
    k.transact({ summary: 'move', ops: [{ op: 'set_plane', layer: 'In2.Cu', net: '+3V3', rect: { x_mm: 5, y_mm: 4, width_mm: 8, height_mm: 6 } }] });
    expect(k.board().planes.find((p) => p.area)!.style).toEqual({ gap: 1 });
    k.transact({ summary: 'reset', ops: [{ op: 'set_plane_style', layer: 'In2.Cu', net: '+3V3', gap_mm: null }] });
    expect(k.board().planes.find((p) => p.area)!.style).toBeUndefined();
  });

  it('set_plane_style refuses less than the board\'s clearances, a gap on a full plane, and a plane that is not there', () => {
    const k = buck();
    k.transact({ summary: '4', ops: [{ op: 'set_board', layers: 4 }] });
    const refused = (op: Record<string, unknown>) => k.transact({ summary: 'x', ops: [op as never] }).status === 'rejected';
    expect(refused({ op: 'set_plane_style', layer: 'In1.Cu', net: 'GND', clearance_mm: 0.05 })).toBe(true);
    expect(refused({ op: 'set_plane_style', layer: 'In1.Cu', net: 'GND', gap_mm: 1 })).toBe(true);
    expect(refused({ op: 'set_plane_style', layer: 'In1.Cu', net: '+3V3', thermal: false })).toBe(true);
    expect(refused({ op: 'set_plane_style', layer: 'In1.Cu', net: 'GND' })).toBe(true);
    expect(refused({ op: 'set_plane_style', layer: 'In1.Cu', net: 'GND', spoke_mm: 0.5 })).toBe(false);
  });

  it('refuses an inner area of the net that fills the layer, and an area without a net', () => {
    const k = buck();
    k.transact({ summary: '4', ops: [{ op: 'set_board', layers: 4 }] });
    const refused = (op: Record<string, unknown>) => k.transact({ summary: 'x', ops: [op as never] }).status === 'rejected';
    expect(refused({ op: 'set_plane', layer: 'In1.Cu', net: 'GND', under: ['U1'] })).toBe(true);
    expect(refused({ op: 'set_plane', layer: 'In2.Cu', net: null, under: ['U1'] })).toBe(true);
    expect(refused({ op: 'set_plane', layer: 'In2.Cu', net: '+3V3', rect: { x_mm: 1, y_mm: 1, width_mm: 8, height_mm: 6 } })).toBe(false);
    // net null clears the layer, area planes too
    k.transact({ summary: 'clear', ops: [{ op: 'set_plane', layer: 'In2.Cu', net: null }] });
    expect(k.board().planes.map((p) => p.layer)).toEqual(['In1.Cu']);
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

describe('planning the planes (plane_plan, split crossings)', () => {
  it('edgeCrossings: in and out through the edge, through it with both ends outside, a point on the edge, not along it', () => {
    const r = [0, 0, 10, 10] as const;
    expect(edgeCrossings([-5, 5, 5, 5], ...r)).toEqual([{ x: 0, y: 5 }]);
    expect(edgeCrossings([5, 5, 15, 5], ...r)).toEqual([{ x: 10, y: 5 }]);
    expect(edgeCrossings([-5, 5, 15, 5], ...r)).toEqual([{ x: 0, y: 5 }, { x: 10, y: 5 }]);
    // a vertex right on the edge: one crossing, not two or none
    expect(edgeCrossings([-5, 5, 0, 5, 5, 5], ...r)).toHaveLength(1);
    // onto the edge and back out, along the edge, or outside: none
    expect(edgeCrossings([-5, 5, 0, 5, -5, 6], ...r)).toEqual([]);
    expect(edgeCrossings([0, -2, 0, 12], ...r)).toEqual([]);
    expect(edgeCrossings([-5, -5, -1, 20], ...r)).toEqual([]);
    expect(edgeCrossings([2, 2, 8, 8], ...r)).toEqual([]);
  });

  /** The buck on 4 layers, an op-amp with a +3V3 area under it, and one of its outputs to a resistor away from it. */
  function split(layer: 'In1.Cu' | 'In2.Cu') {
    const k = buck();
    k.transact({
      summary: 'split',
      ops: [
        { op: 'add_part', part: 'ti:LM358DR', refdes: 'U2' },
        { op: 'add_part', part: 'generic:C', refdes: 'C10', params: { capacitance: '100nF', voltage: '16V' } },
        { op: 'add_part', part: 'generic:R', refdes: 'R10', params: { resistance: '10k' } },
        { op: 'connect', pins: ['U2.V+', 'C10.1'], net: '+3V3' },
        { op: 'connect', pins: ['U2.GND', 'C10.2', 'R10.2'], net: 'GND' },
        { op: 'connect', pins: ['U2.OUTA', 'U2.INA-', 'R10.1'], net: 'SIG' },
        { op: 'connect', pins: ['U2.INB+', 'U2.OUTB', 'U2.INB-'], net: 'BUF2' },
        { op: 'set_board', layers: 4, width_mm: 40, height_mm: 30 },
        { op: 'set_plane', layer: 'In1.Cu', net: 'GND' },
        { op: 'set_plane', layer: 'In2.Cu', net: '+12V' },
        { op: 'set_plane', layer, net: '+3V3', under: ['U2'] },
        { op: 'place', ref: 'U2', x_mm: 30, y_mm: 8, lock: true },
        { op: 'place', ref: 'R10', x_mm: 30, y_mm: 24, rot: 90, lock: true },
      ],
    });
    return k;
  }

  it('the router crosses a split on the other outer layer, so no signal crosses it on the layer over it', () => {
    for (const layer of ['In1.Cu', 'In2.Cu'] as const) {
      const b = routed(split(layer));
      expect(b.stats.unrouted).toBe(0);
      const area = b.planes.find((p) => p.area)!.area!;
      const over = layer === 'In1.Cu' ? 'F.Cu' : 'B.Cu';
      const sig = b.tracks.filter((t) => b.netNames[t.netId] === 'SIG');
      expect(sig.filter((t) => t.layer === over).flatMap((t) => edgeCrossings(t.pts, ...area))).toEqual([]);
      expect(b.diagnostics.filter((x) => x.code === 'PLANE.SPLIT_CROSSING')).toEqual([]);
      expect(brokenNets(b)).toEqual([]);
    }
  });

  it('a signal that still crosses a split on the layer over it is reported (once per net), supplies are not', () => {
    const b = routed(split('In2.Cu'));
    const area = b.planes.find((p) => p.area)!;
    const sig = Object.keys(b.netNames).find((id) => b.netNames[id] === 'SIG')!;
    const gnd = Object.keys(b.netNames).find((id) => b.netNames[id] === 'GND')!;
    const [x0, y0, x1, y1] = area.area!;
    const across = (netId: string) => ({ netId, layer: 'B.Cu' as const, width: 0.25, pts: [(x0 + x1) / 2, y1 - 1, (x0 + x1) / 2, y1 + 3, (x0 + x1) / 2 + 1, y1 + 3, (x0 + x1) / 2 + 1, y1 - 1] });
    const found = splitDrc({ ...b, tracks: [across(sig), across(gnd)] }, (id) => id !== gnd);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: 'PLANE.SPLIT_CROSSING', severity: 'warning', entities: ['net:SIG'] });
    expect(found[0]!.message).toMatch(/SIG crosses the edge of the \+3V3 under U2 on In2\.Cu 2 times on B\.Cu/);
    // F.Cu runs over In1.Cu (unbroken GND): the same track there is fine
    expect(splitDrc({ ...b, tracks: [{ ...across(sig), layer: 'F.Cu' }] }, () => true)).toEqual([]);
  });

  it('get_board plane_plan: each supply with its pins, the ICs it feeds, its groups and what carries it', () => {
    const k = split('In2.Cu');
    const plan = (k.query({ op: 'get_board' }) as { plane_plan: { stackup: string; supplies: { net: string; pins: number; ground?: boolean; feeds?: string[]; carried_by: string[]; box_mm: number[]; groups?: { parts: string[] }[] }[] } }).plane_plan;
    expect(plan.stackup).toMatch(/F\.Cu tracks run over In1\.Cu, B\.Cu tracks over In2\.Cu/);
    const net = (n: string) => plan.supplies.find((x) => x.net === n)!;
    expect(plan.supplies[0]!.net).toBe('GND');
    expect(net('GND')).toMatchObject({ ground: true, carried_by: ['In1.Cu whole layer'] });
    // +3V3: the buck's output (its caps, the divider) and the op-amp with its cap, apart: two groups
    expect(net('+3V3')).toMatchObject({ pins: 5, feeds: ['U2 (1 pin)'], carried_by: ['In2.Cu under U2'] });
    expect(net('+3V3').groups!.some((g) => g.parts.includes('U2') && g.parts.includes('C10') && !g.parts.includes('U1'))).toBe(true);
    expect(net('+12V').carried_by).toEqual(['In2.Cu whole layer']);
    expect(net('GND').groups!.some((g) => g.parts.includes('U2') && !g.parts.includes('U1'))).toBe(true);
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

/** A buck regulator with an exposed pad on GND (pin 9), as imported, for thermal vias. */
const { card: padBuck } = draftToCard({
  mpn: 'BUCK8EPVIAS',
  manufacturer: 'Test',
  description: 'test buck regulator with a thermal pad',
  package: { name: 'SOIC-8-EP', family: 'SOIC', pins: 8, pitch_mm: 1.27, body_mm: [3.9, 4.9], span_mm: [6, 4.9], exposed_pad_mm: [2.4, 3.1] },
  pins: [['BOOT', 'passive'], ['VIN', 'pwr_in'], ['EN', 'in'], ['RT', 'in'], ['FB', 'in'], ['COMP', 'out'], ['GND', 'pwr_in'], ['SW', 'pwr_out'], ['PAD', 'pwr_in']].map(([name, type], i) => ({ number: String(i + 1), name: name!, type: type as 'in' })),
});
registerUserParts([padBuck!]);
afterAll(() => unregisterUserPart(padBuck!.id));

function padRegulator() {
  const k = new Kernel();
  const r = k.transact({
    summary: 'regulator',
    ops: [
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
      { op: 'add_part', part: padBuck!.id, refdes: 'U1' },
      { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10uF', voltage: '25V', package: '1206' } },
      { op: 'add_part', part: 'generic:C', refdes: 'C2', params: { capacitance: '100nF', voltage: '25V' } },
      { op: 'add_part', part: 'generic:L', refdes: 'L1', params: { inductance: '10uH', current: '3A', package: 'IND-4x4' } },
      { op: 'add_part', part: 'generic:C', refdes: 'C3', params: { capacitance: '47uF', voltage: '10V', package: '1210' } },
      { op: 'connect', pins: ['J1.1', 'U1.VIN', 'C1.1', 'U1.EN'], net: 'VIN' },
      { op: 'connect', pins: ['J1.2', 'U1.GND', 'U1.PAD', 'C1.2', 'C3.2', 'U1.RT', 'U1.COMP'], net: 'GND' },
      { op: 'connect', pins: ['U1.BOOT', 'C2.1'], net: 'BOOT' },
      { op: 'connect', pins: ['U1.SW', 'C2.2', 'L1.1'], net: 'SW' },
      { op: 'connect', pins: ['L1.2', 'C3.1', 'U1.FB'], net: 'VOUT' },
    ],
  });
  expect(r.status, JSON.stringify(r).slice(0, 400)).toBe('ok');
  k.accept();
  return k;
}

describe('vias placed on purpose (add_vias)', () => {
  const ok = (k: Kernel, ops: unknown[]) => {
    const r = k.transact({ summary: 'x', ops: ops as never });
    expect(r.status, JSON.stringify(r).slice(0, 500)).toBe('ok');
    k.accept();
    return r;
  };

  it('fills a thermal pad with vias that move with the part, are allowed there and join the plane solid', () => {
    const k = padRegulator();
    const r = ok(k, [{ op: 'add_vias', kind: 'pad', ref: 'U1', pad: '9' }]);
    expect(r.status === 'ok' && r.results[0]!.effect).toContain('2 × 3 thermal vias in U1.9 (GND), 1 mm apart');
    const placed = k.board();
    const ep = placed.parts.find((p) => p.refdes === 'U1')!.pads.find((p) => p.number === '9')!;
    const mine = placed.vias.filter((v) => v.group === 'V1');
    expect(mine).toHaveLength(6); // there before the routing
    for (const v of mine) {
      expect(v.inPad).toBe(true);
      expect(v.netId).toBe(ep.netId);
      expect(Math.abs(v.x - ep.x) + v.pad / 2).toBeLessThanOrEqual(ep.w / 2 + 1e-6);
      expect(Math.abs(v.y - ep.y) + v.pad / 2).toBeLessThanOrEqual(ep.h / 2 + 1e-6);
    }
    const b = routed(k);
    expect(b.vias.filter((v) => v.group === 'V1')).toHaveLength(6);
    expect(b.diagnostics.filter((x) => x.code === 'DRC.VIA_IN_PAD' || x.code === 'DRC.SHORT' || x.code === 'DRC.CLEARANCE')).toEqual([]);
    expect(brokenNets(b)).toEqual([]);
    // the B.Cu GND pour takes them solid: no relief ring round them
    const pour = b.zones.find((z) => z.layer === 'B.Cu' && z.netId === ep.netId)!;
    const ringAt = (x: number, y: number) => pour.shape!.cuts.some((c) => c.k === 'circle' && Math.hypot(c.x - x, c.y - y) < 1e-6);
    expect(mine.some((v) => ringAt(v.x, v.y))).toBe(false);
    // moved with the part
    ok(k, [{ op: 'place', ref: 'U1', x_mm: ep.x + 3, y_mm: ep.y + 2 }]);
    const moved = k.board();
    const ep2 = moved.parts.find((p) => p.refdes === 'U1')!.pads.find((p) => p.number === '9')!;
    const v2 = moved.vias.filter((v) => v.group === 'V1');
    expect(v2).toHaveLength(6);
    expect(Math.hypot(v2[0]!.x - ep2.x, v2[0]!.y - ep2.y)).toBeCloseTo(Math.hypot(mine[0]!.x - ep.x, mine[0]!.y - ep.y), 3);
    expect(boardSummary(moved).via_groups).toEqual([{ id: 'V1', net: 'GND', kind: 'pad', vias: 6 }]);
  });

  it('refuses thermal vias in a pad that is too small, on another net or crowded, and replaces a pad\'s group', () => {
    const k = padRegulator();
    const refused = (op: Record<string, unknown>) => k.transact({ summary: 'x', ops: [op as never] }).status === 'rejected';
    expect(refused({ op: 'add_vias', kind: 'pad', ref: 'U1', pad: '9', net: 'VIN' })).toBe(true);
    expect(refused({ op: 'add_vias', kind: 'pad', ref: 'U1', pad: '3' })).toBe(false); // EN is on VIN: fine
    k.reject();
    expect(refused({ op: 'add_vias', kind: 'pad', ref: 'U1', pad: '9', size_mm: 4 })).toBe(true);
    expect(refused({ op: 'add_vias', kind: 'pad', ref: 'U1', pad: '9', pitch_mm: 0.5 })).toBe(true);
    expect(refused({ op: 'add_vias', kind: 'pad', ref: 'U1', pad: '42' })).toBe(true);
    expect(refused({ op: 'add_vias', kind: 'grid', net: 'GND' })).toBe(true);
    ok(k, [{ op: 'add_vias', kind: 'pad', ref: 'U1', pad: '9' }]);
    ok(k, [{ op: 'add_vias', kind: 'pad', ref: 'U1', pad: '9', pitch_mm: 1.2, drill_mm: 0.25, size_mm: 0.5 }]);
    expect(k.board().vias.filter((v) => v.group === 'V1').map((v) => [v.drill, v.pad])).toEqual(Array(6).fill([0.25, 0.5])); // 2 × 3 at 1.2 mm
    ok(k, [{ op: 'remove_vias', id: 'V1' }]);
    expect(k.board().vias).toEqual([]);
  });

  it('pours an outer layer only round some parts', () => {
    const k = padRegulator();
    const r = ok(k, [
      { op: 'set_plane', layer: 'F.Cu', net: 'GND' },
      { op: 'set_plane', layer: 'F.Cu', net: 'GND', under: ['U1', 'C1', 'C3'] },
    ]);
    expect(r.status === 'ok' && r.results[1]!.effect).toContain('GND pour on F.Cu, under U1, C1, C3; it no longer pours the whole layer');
    const b = routed(k);
    const top = b.planes.find((p) => p.layer === 'F.Cu')!;
    expect(top.under?.sort()).toEqual(['C1', 'C3', 'U1']);
    const zone = b.zones.find((z) => z.layer === 'F.Cu')!;
    expect(zone.shape!.outline).toEqual(top.area);
    expect(top.area![2] - top.area![0]).toBeLessThan(b.outline.w);
    expect(b.zones.some((z) => z.layer === 'B.Cu')).toBe(true); // the automatic GND pour stays
    expect(brokenNets(b)).toEqual([]);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('stitches two pours with a grid of vias where they fit, and fences an area', () => {
    const k = padRegulator();
    ok(k, [{ op: 'set_plane', layer: 'F.Cu', net: 'GND' }]);
    const before = routed(k);
    const { w, h } = before.outline;
    ok(k, [
      { op: 'add_vias', kind: 'grid', net: 'GND', rect: { x_mm: 0, y_mm: 0, width_mm: w, height_mm: h }, pitch_mm: 2 },
      { op: 'add_vias', kind: 'fence', net: 'GND', under: ['J1'], margin_mm: 1 },
    ]);
    expect(boardSummary(k.board()).via_groups![0]!.vias).toMatch(/^up to \d+, laid by the route step/);
    const b = routed(k);
    const grid = b.vias.filter((v) => v.group === 'V1');
    const fence = b.vias.filter((v) => v.group === 'V2');
    const wanted = b.viaGroups.find((g) => g.id === 'V1')!.wanted;
    expect(grid.length).toBeGreaterThan(0);
    expect(grid.length).toBeLessThan(wanted); // not where other nets or pads are
    expect(fence.length).toBeGreaterThan(0);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(brokenNets(b)).toEqual([]);
    expect(boardSummary(b).via_groups![0]!.vias).toBe(`${grid.length} of ${wanted} spots (the others are blocked or miss the net's planes)`);
    // without copper of the net on a second layer there, a stitching via joins nothing: none
    ok(k, [{ op: 'set_plane', layer: 'F.Cu', net: null }]);
    expect(routed(k).vias.filter((v) => v.group === 'V1')).toEqual([]);
  });
});

describe('a local pour inside another, stitched to an inner plane', () => {
  it('lays the smaller area over the bigger one and stitches it to the plane of its net', () => {
    const k = buck();
    const ok = (ops: unknown[]) => {
      const r = k.transact({ summary: 'x', ops: ops as never });
      expect(r.status, JSON.stringify(r).slice(0, 500)).toBe('ok');
      k.accept();
    };
    ok([
      { op: 'set_board', layers: 4 },
      { op: 'set_plane', layer: 'In2.Cu', net: '+3V3' },
      { op: 'set_plane', layer: 'F.Cu', net: 'GND', under: ['U1', 'C1', 'C2', 'C3', 'C4', 'C5', 'L1', 'D1', 'R1', 'R2', 'R3'] },
    ]);
    // the output's top copper round L1 and C2, inside the GND pour, and vias down to In2.Cu
    ok([
      { op: 'set_plane', layer: 'F.Cu', net: '+3V3', under: ['C2', 'L1'], margin_mm: 2.5 },
      { op: 'add_vias', kind: 'grid', net: '+3V3', under: ['C2', 'L1'], margin_mm: 2.5, pitch_mm: 1.2 },
    ]);
    const b = routed(k);
    const top = (net: string) => b.zones.find((z) => z.layer === 'F.Cu' && b.netNames[z.netId] === net)!;
    const area = b.planes.find((p) => p.layer === 'F.Cu' && b.netNames[p.netId] === '+3V3')!.area!;
    expect(top('+3V3').rects.length).toBeGreaterThan(20);
    // the GND pour goes round it (its gap), not the other way round
    expect(top('GND').shape!.cuts.some((c) => c.k === 'rect' && Math.abs(c.x - (area[0] - 0.2)) < 1e-6 && Math.abs(c.y - (area[1] - 0.2)) < 1e-6)).toBe(true);
    const stitched = b.vias.filter((v) => v.group === 'V1');
    expect(stitched.length).toBeGreaterThan(5);
    for (const v of stitched) {
      expect(v.x - v.pad / 2).toBeGreaterThanOrEqual(area[0] - 1e-6);
      expect(v.x + v.pad / 2).toBeLessThanOrEqual(area[2] + 1e-6);
    }
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(brokenNets(b)).toEqual([]);
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
    const { fabFiles } = await import('@4k7/fab');
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
    k.transact({ summary: 'mill', ops: [{ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'add_cutout', shape: 'rect', x_mm: 0, y_mm: 0, anchor: 'center', width_mm: 8, height_mm: 6, corner_radius_mm: 1 }, { op: 'propose_placement' }] });
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
    const { fabFiles } = await import('@4k7/fab');
    const edge = fabFiles(b, 'm').find((f) => f.name === 'm-Edge_Cuts.gbr')!.content;
    // two contours: the outline and the cutout (each starts with a move D02)
    expect(edge.split('\n').filter((l) => l.endsWith('D02*')).length).toBe(2);
  });

  it('an anchored cutout follows the board size; rounded corners keep copper off them', () => {
    const k = buck();
    k.transact({ summary: 'mill', ops: [{ op: 'set_board', width_mm: 40, height_mm: 30, corner_radius_mm: 4 }, { op: 'add_cutout', shape: 'slot', x_mm: -6, y_mm: 0, anchor: 'right', width_mm: 8, height_mm: 1.5 }, { op: 'propose_placement' }] });
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
    k.transact({ summary: 'tree', ops: [{ op: 'set_outline', svg_path: tree, height_mm: 100 }, { op: 'propose_placement' }] });
    const b = routed(k);
    expect(b.outline.h).toBe(100);
    expect(b.outline.w).toBeCloseTo(88.889, 2);
    expect(b.shape).toHaveLength(30);
    expect(b.stats.unrouted).toBe(0);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    const { insideBoard } = await import('@4k7/schema');
    for (const p of b.parts) {
      const c = p.courtyard;
      for (const [x, y] of [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]] as const) expect(insideBoard(b, x, y), p.refdes).toBeGreaterThan(0);
    }
    for (const t of b.tracks) for (let i = 0; i < t.pts.length; i += 2) expect(insideBoard(b, t.pts[i]!, t.pts[i + 1]!) - t.width / 2).toBeGreaterThanOrEqual(b.rules.edgeClearance - 1e-3);
    const { fabFiles } = await import('@4k7/fab');
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
    type Pad = import('@4k7/schema').BoardPad;
    type Part = import('@4k7/schema').BoardPart;
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
    type Pad = import('@4k7/schema').BoardPad;
    type Part = import('@4k7/schema').BoardPart;
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

describe('router: tracks wider than a via', () => {
  it('changes layer only where the track fits on the other layer too', async () => {
    const { route } = await import('../src/router.ts');
    type Pad = import('@4k7/schema').BoardPad;
    type Part = import('@4k7/schema').BoardPart;
    const pad = (x: number, y: number, w: number, h: number, netId: string, layer: 'F.Cu' | 'B.Cu'): Pad => ({ number: '1', x, y, w, h, shape: 'rect', netId, layers: [layer] });
    const part = (refdes: string, p: Pad) => ({ componentId: refdes, refdes, x: p.x, y: p.y, rot: 0, pads: [p], courtyard: { x: p.x - p.w / 2, y: p.y - p.h / 2, w: p.w, h: p.h } }) as unknown as Part;
    // a 1 mm net from F.Cu on the left to B.Cu on the right, past a wall on each layer: it must
    // change layer between the walls, where the via fits but the 1 mm track does not
    const walls = [pad(21.3, 10, 0.4, 22, 'WF', 'F.Cu'), pad(19.6, 10, 0.4, 22, 'WB', 'B.Cu')];
    const clearance = 0.15;
    const r = route({
      outline: { w: 40, h: 20 },
      layers: ['F.Cu', 'B.Cu'],
      rules: { clearance, track: 0.15, powerTrack: 0.4, viaDrill: 0.3, viaPad: 0.6, edgeClearance: 0.5 },
      parts: [...walls.map((w, i) => part(`W${i}`, w)), part('S', pad(10, 10, 1.2, 1.2, 'P', 'F.Cu')), part('T', pad(30, 10, 1.2, 1.2, 'P', 'B.Cu'))],
      powerNets: new Set(),
      netWidths: { P: 1 },
    });
    // no copper of P within the clearance of a wall on its layer (an unrouted connection is fine)
    for (const t of r.tracks) {
      for (const w of walls.filter((x) => x.layers[0] === t.layer)) {
        for (let q = 0; q + 3 < t.pts.length; q += 2) {
          for (let s = 0; s <= 100; s++) {
            const x = t.pts[q]! + ((t.pts[q + 2]! - t.pts[q]!) * s) / 100;
            const y = t.pts[q + 1]! + ((t.pts[q + 3]! - t.pts[q + 1]!) * s) / 100;
            const gap = Math.hypot(Math.max(Math.abs(x - w.x) - w.w / 2, 0), Math.max(Math.abs(y - w.y) - w.h / 2, 0)) - t.width / 2;
            expect(gap).toBeGreaterThanOrEqual(clearance - 1e-6);
          }
        }
      }
    }
  });

  it('keeps a track as wide as a via off the dedicated plane layers', async () => {
    const { route } = await import('../src/router.ts');
    type Pad = import('@4k7/schema').BoardPad;
    type Part = import('@4k7/schema').BoardPart;
    const pad = (x: number, y: number, w: number, h: number, netId: string, layer: 'F.Cu' | 'B.Cu'): Pad => ({ number: '1', x, y, w, h, shape: 'rect', netId, layers: [layer] });
    const part = (refdes: string, p: Pad) => ({ componentId: refdes, refdes, x: p.x, y: p.y, rot: 0, pads: [p], courtyard: { x: p.x - p.w / 2, y: p.y - p.h / 2, w: p.w, h: p.h } }) as unknown as Part;
    // walls across both outer layers: the only way across would be on the inner (plane) layers
    const r = route({
      outline: { w: 40, h: 20 },
      layers: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'],
      rules: { clearance: 0.15, track: 0.15, powerTrack: 0.4, viaDrill: 0.3, viaPad: 0.6, edgeClearance: 0.5 },
      parts: [part('WF', pad(20, 10, 0.4, 22, 'WF', 'F.Cu')), part('WB', pad(20, 10, 0.4, 22, 'WB', 'B.Cu')), part('S', pad(10, 10, 1.2, 1.2, 'P', 'F.Cu')), part('T', pad(30, 10, 1.2, 1.2, 'P', 'F.Cu'))],
      powerNets: new Set(),
      netWidths: { P: 0.6 },
      planes: [
        { netId: 'WF', layer: 'In1.Cu' },
        { netId: 'WB', layer: 'In2.Cu' },
      ],
    });
    expect(r.tracks.filter((t) => t.layer === 'In1.Cu' || t.layer === 'In2.Cu')).toEqual([]);
    // closed off by the walls alone: the router says so and stops after one pass
    expect(r.failed.map((f) => f.enclosed)).toEqual([true]);
    expect(r.passes).toBe(1);
  });

  it('drops onto a plane with the net\'s own track width', async () => {
    const { route } = await import('../src/router.ts');
    type Pad = import('@4k7/schema').BoardPad;
    type Part = import('@4k7/schema').BoardPart;
    const pad = (x: number): Pad => ({ number: '1', x, y: 5, w: 1.2, h: 1.2, shape: 'rect', netId: 'GND', layers: ['F.Cu'] });
    const part = (refdes: string, p: Pad) => ({ componentId: refdes, refdes, x: p.x, y: p.y, rot: 0, pads: [p], courtyard: { x: p.x - 1, y: p.y - 1, w: 2, h: 2 } }) as unknown as Part;
    const r = route({
      outline: { w: 20, h: 10 },
      layers: ['F.Cu', 'B.Cu'],
      rules: { clearance: 0.15, track: 0.15, powerTrack: 0.4, viaDrill: 0.3, viaPad: 0.6, edgeClearance: 0.5 },
      parts: [part('C1', pad(5))],
      powerNets: new Set(['GND']),
      netWidths: { GND: 0.5 },
      planes: [{ netId: 'GND', layer: 'B.Cu' }],
    });
    // the SMD pad's stub down to the pour
    expect(r.vias).toHaveLength(1);
    expect(r.tracks.length).toBeGreaterThan(0);
    expect(r.tracks.every((t) => t.width === 0.5)).toBe(true);
  });

  it('runs a power track along a pin escape only where it keeps its clearance at that width', async () => {
    const { route } = await import('../src/router.ts');
    type Pad = import('@4k7/schema').BoardPad;
    type Part = import('@4k7/schema').BoardPart;
    const pad = (number: string, x: number, y: number, w: number, h: number, netId?: string): Pad => ({ number, x, y, w, h, shape: 'rect', ...(netId ? { netId } : {}), layers: ['F.Cu'] });
    const part = (refdes: string, x: number, y: number, pads: Pad[]) => ({ componentId: refdes, refdes, x, y, rot: 0, pads, courtyard: { x: x - 1, y: y - 1, w: 2, h: 2 } }) as unknown as Part;
    // a SOIC-like pin on the power net P: its escape stub runs left between pads of Q and R, each
    // 0.3 mm from the stub's centre line (room for a 0.15 mm track, not for a 0.5 mm one)
    const pins = [pad('1', 7.5, 8.73, 1.5, 0.6), pad('2', 7.5, 10, 1.5, 0.6, 'P'), pad('3', 7.5, 11.27, 1.5, 0.6), pad('4', 12.5, 10, 1.5, 0.6)];
    const others = [pad('1', 6.35, 10.45, 0.3, 0.3, 'Q'), pad('1', 6.35, 9.55, 0.3, 0.3, 'R')];
    const clearance = 0.15;
    const r = route({
      outline: { w: 16, h: 20 },
      layers: ['F.Cu', 'B.Cu'],
      rules: { clearance, track: 0.15, powerTrack: 0.5, viaDrill: 0.3, viaPad: 0.6, edgeClearance: 0.5 },
      parts: [part('U1', 10, 10, pins), ...others.map((o, i) => part(`Q${i}`, o.x, o.y, [o])), part('J1', 2, 10, [pad('1', 2, 10, 1.5, 1.5, 'P')])],
      powerNets: new Set(['P']),
    });
    for (const t of r.tracks.filter((x) => x.layer === 'F.Cu')) {
      for (let k = 0; k + 3 < t.pts.length; k += 2) {
        for (let s = 0; s <= 100; s++) {
          const x = t.pts[k]! + ((t.pts[k + 2]! - t.pts[k]!) * s) / 100;
          const y = t.pts[k + 1]! + ((t.pts[k + 3]! - t.pts[k + 1]!) * s) / 100;
          for (const q of others) {
            const gap = Math.hypot(Math.max(Math.abs(x - q.x) - q.w / 2, 0), Math.max(Math.abs(y - q.y) - q.h / 2, 0)) - t.width / 2;
            expect(gap).toBeGreaterThanOrEqual(clearance - 1e-6);
          }
        }
      }
    }
  });
});

describe('router: between IC pins', () => {
  it('takes the middle of the gap between two pins', async () => {
    const { route } = await import('../src/router.ts');
    type Pad = import('@4k7/schema').BoardPad;
    type Part = import('@4k7/schema').BoardPart;
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
    const { gerbers } = await import('@4k7/fab');
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

  it('a waived board check stays listed but is marked', () => {
    const k = buck();
    const u1 = k.board().parts.find((p) => p.refdes === 'U1')!;
    k.transact({ summary: 'over', ops: [{ op: 'add_graphic', svg_path: ring, width_mm: 3, anchor: 'top_left', x_mm: u1.x, y_mm: u1.y }] });
    const over = () => k.board().diagnostics.find((x) => x.code === 'DRC.SILK_OVER_PARTS')!;
    expect(over().waivedBy).toBeUndefined();
    const { code, entities } = over();
    k.transact({ summary: 'ok', ops: [{ op: 'add_waiver', code, entities, reason: 'intended: logo over the IC' }] });
    expect(over().waivedBy).toBeDefined();
    expect(boardSummary(k.board()).drc.some((x) => x.includes('lies over'))).toBe(false);
  });

  it('takes a picture of thousands of dots (more points than a call takes arguments)', () => {
    const k = buck();
    // 2500 round dots, sampled into some 200 000 coordinates
    let dots = '';
    for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) dots += `M ${x * 2 + 0.8} ${y * 2} A 0.8 0.8 0 1 0 ${x * 2 - 0.8} ${y * 2} A 0.8 0.8 0 1 0 ${x * 2 + 0.8} ${y * 2} Z `;
    const r = k.transact({ summary: 'picture', ops: [{ op: 'add_graphic', svg_path: dots, width_mm: 20, x_mm: 0, y_mm: 0, anchor: 'center' }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const g = k.board().graphics[0]!;
    expect(g.polys).toHaveLength(2500);
    expect(g.bounds[2] - g.bounds[0]).toBeCloseTo(20, 1);
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

  it('writes text in the stroke font: letter height, lines, mirrored on the bottom, stroked in the Gerber', async () => {
    const k = buck();
    const r = k.transact({ summary: 'labels', ops: [{ op: 'add_graphic', text: 'Boot', height_mm: 2.5, x_mm: 10, y_mm: 10, name: 'SW1' }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    let g = k.board().graphics[0]!;
    expect(g).toMatchObject({ mode: 'outline', text: 'Boot' });
    expect(g.line).toBeGreaterThanOrEqual(0.15);
    expect(g.bounds[3] - g.bounds[1]).toBeCloseTo(2.5, 2);
    // four letters at 5.5/6 of the height apart, the last 4/6 wide
    expect(g.bounds[2] - g.bounds[0]).toBeCloseTo((3 * 5.5 + 4) * (2.5 / 6), 2);
    expect((g.bounds[0] + g.bounds[2]) / 2).toBeCloseTo(10, 2);
    const left = g.bounds[0];
    // the B's upright is on the left; on the bottom side it is on the right
    k.transact({ summary: 'flip', ops: [{ op: 'edit_graphic', id: 'G1', side: 'bottom' }] });
    g = k.board().graphics[0]!;
    expect(g.bounds[0]).toBeCloseTo(left, 2);
    const upright = (gr: typeof g) => gr.polys[0]!.filter((_, i) => i % 2 === 0);
    expect(Math.max(...upright(g))).toBeCloseTo(g.bounds[2], 2);
    expect(k.transact({ summary: 'fill', ops: [{ op: 'edit_graphic', id: 'G1', mode: 'fill' }] }).status).toBe('rejected');
    // two lines, one below the other
    k.transact({ summary: 'pins', ops: [{ op: 'add_graphic', text: 'CLK\\nGND', height_mm: 2, x_mm: 20, y_mm: 10 }] });
    const two = k.board().graphics[1]!;
    expect(two.text).toBe('CLK\nGND');
    expect(two.bounds[3] - two.bounds[1]).toBeCloseTo(2 * 1.6 + 2, 2);
    expect(k.transact({ summary: 'bad', ops: [{ op: 'add_graphic', text: 'Ω', x_mm: 1, y_mm: 1 }] }).rejection?.message).toContain('"Ω"');
    k.accept();
    const { gerbers } = await import('@4k7/fab');
    const silk = gerbers(k.board(), 't').find((f) => f.name.endsWith('F_Silkscreen.gbr'))!.content;
    expect(silk).not.toMatch(/G36\*/);
    expect(silk.match(/D01\*/g)!.length).toBeGreaterThan(20);
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

describe('power pads down to their plane (several vias)', () => {
  /** The buck on 4 layers with a 1812 bulk cap C9 on +3V3 / GND (GND on In1.Cu). */
  const bulk = (ops: unknown[] = []) => {
    const k = buck();
    const r = k.transact({ summary: 'bulk', ops: [{ op: 'set_board', layers: 4 }, { op: 'add_part', part: 'generic:C', refdes: 'C9', params: { capacitance: '100uF', voltage: '25V', package: '1812' } }, { op: 'connect', pins: ['C9.1'], net: '+3V3' }, { op: 'connect', pins: ['C9.2'], net: 'GND' }, ...ops] as never });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    return k;
  };
  /** The pad's own vias: at the end of its stubs (tracks of its net that start in it). */
  const padVias = (b: ReturnType<Kernel['board']>, ref: string, num: string) => {
    const pad = b.parts.find((p) => p.refdes === ref)!.pads.find((q) => q.number === num)!;
    const inPad = (x: number, y: number) => Math.abs(x - pad.x) <= pad.w / 2 + 0.01 && Math.abs(y - pad.y) <= pad.h / 2 + 0.01;
    const stubs = b.tracks.filter((t) => t.netId === pad.netId && t.layer === 'F.Cu' && inPad(t.pts[0]!, t.pts[1]!));
    const vias = b.vias.filter((v) => v.netId === pad.netId && stubs.some((t) => Math.hypot(t.pts.at(-2)! - v.x, t.pts.at(-1)! - v.y) < 0.05));
    return { pad, stubs: stubs.filter((t) => vias.some((v) => Math.hypot(t.pts.at(-2)! - v.x, t.pts.at(-1)! - v.y) < 0.05)), vias };
  };
  /**
   * n spots in a row beside a pad, on the side facing away from its part's centre, half a via
   * plus the clearance (and a little) off the edge, a via plus the clearance (and a little) apart.
   */
  const beside = (k: Kernel, ref: string, num: string, n: number) => {
    const b = k.board();
    const part = b.parts.find((p) => p.refdes === ref)!;
    const pad = part.pads.find((q) => q.number === num)!;
    const off = b.rules.viaPad / 2 + b.rules.clearance + 0.05;
    const q = b.rules.viaPad + b.rules.clearance + 0.1;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return Array.from({ length: n }, (_, i) => {
      const along = (i - (n - 1) / 2) * q;
      return pad.w > pad.h
        ? { x_mm: r2(pad.x + along), y_mm: r2(pad.y + Math.sign(pad.y - part.y) * (pad.h / 2 + off)) }
        : { x_mm: r2(pad.x + Math.sign(pad.x - part.x) * (pad.w / 2 + off)), y_mm: r2(pad.y + along) };
    });
  };

  it('one via per pad, however big, unless the agent places more where a current flows', async () => {
    const { viaCurrentFor, viasForCurrent } = await import('@4k7/schema');
    expect(viaCurrentFor(0.3)).toBeCloseTo(0.9, 1);
    expect(viasForCurrent(3, 0.3)).toBe(4);
    expect(viasForCurrent(0.2, 0.3)).toBe(1);
    // a 100 µF 1812 and a GND net with a current: still one via each
    const b = routed(bulk([{ op: 'set_net', net: 'GND', max_current: 3 }]));
    expect(b.stats.unrouted).toBe(0);
    for (const [ref, num] of [['C9', '2'], ['C2', '2']] as const) expect(padVias(b, ref, num).vias, `${ref}.${num}`).toHaveLength(1);
    expect(b.diagnostics.filter((d) => d.code === 'DRC.PLANE_VIAS')).toEqual([]);
  });

  it('add_vias drop: the vias where the agent puts them, each on its own stub from the pad, no wider copper', () => {
    const k = bulk();
    const at = beside(k, 'C9', '2', 3);
    const r = k.transact({ summary: 'drop', ops: [{ op: 'add_vias', kind: 'drop', ref: 'C9', pad: '2', at }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    // there before routing, with their stubs
    const before = k.board();
    expect(before.vias.filter((v) => v.group === 'V1')).toHaveLength(3);
    expect(before.tracks).toHaveLength(3);
    const b = routed(k);
    expect(b.stats.unrouted).toBe(0);
    const { pad, vias, stubs } = padVias(b, 'C9', '2');
    for (const p of at) expect(vias.some((v) => v.group === 'V1' && Math.hypot(v.x - p.x_mm, v.y - p.y_mm) < 1e-6), JSON.stringify(p)).toBe(true);
    // one short stub per via, no wider than the via, straight out of the pad
    expect(stubs).toHaveLength(3);
    for (const t of stubs) {
      expect(t.pts).toHaveLength(4);
      expect(t.width).toBeLessThanOrEqual(b.rules.viaPad);
      expect(Math.hypot(t.pts[2]! - t.pts[0]!, t.pts[3]! - t.pts[1]!)).toBeLessThan(1.5);
    }
    // nothing wider than a power track beside the pad (no bar)
    const near = (t: Track) => t.pts.some((v, i) => (i % 2 ? Math.abs(v - pad.y) : Math.abs(v - pad.x)) < 3);
    expect(b.tracks.filter((t) => t.netId === pad.netId && near(t) && t.width > b.rules.powerTrack)).toEqual([]);
    // no extra via of the router's for that pad
    expect(vias).toHaveLength(3);
    // get_board lists them where they stand
    expect(boardSummary(b).via_groups).toContainEqual(expect.objectContaining({ kind: 'drop', vias: '3 beside C9.2, each on its own stub from the pad', at_mm: at.map((p) => [p.x_mm, p.y_mm]) }));
    expect(b.diagnostics.filter((d) => d.code === 'DRC.PLANE_VIAS' || d.code === 'DRC.VIA_IN_PAD' || d.code === 'DRC.CLEARANCE')).toEqual([]);
    expect(brokenNets(b)).toEqual([]);
    // routed again unchanged: the stubs are laid once, not kept and laid again
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    expect(padVias(k.board(), 'C9', '2').stubs).toHaveLength(3);
  });

  it('add_vias drop: the vias move and turn with the part', async () => {
    const { dropSpot } = await import('../src/board.ts');
    const k = bulk();
    const at = beside(k, 'C9', '2', 2);
    k.transact({ summary: 'drop', ops: [{ op: 'add_vias', kind: 'drop', ref: 'C9', pad: '2', at }] });
    const b0 = k.board();
    const p0 = b0.parts.find((p) => p.refdes === 'C9')!;
    const pad0 = p0.pads.find((q) => q.number === '2')!;
    const rel0 = b0.vias.filter((v) => v.group === 'V1').map((v) => [v.x - pad0.x, v.y - pad0.y]);
    const r = k.transact({ summary: 'turn', ops: [{ op: 'place', ref: 'C9', x_mm: p0.x, y_mm: p0.y + 2, rot: ((p0.rot + 90) % 360) as 0 | 90 | 180 | 270 }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const b1 = k.board();
    const p1 = b1.parts.find((p) => p.refdes === 'C9')!;
    const pad1 = p1.pads.find((q) => q.number === '2')!;
    expect(p1.rot).not.toBe(p0.rot);
    // turned with the pad: clockwise (y down) by the part's turn
    const turn = (dx: number, dy: number, rot: number): [number, number] => (rot === 90 ? [-dy, dx] : rot === 180 ? [-dx, -dy] : rot === 270 ? [dy, -dx] : [dx, dy]);
    const r3 = (v: number) => Math.round(v * 1000) / 1000 || 0;
    const rel1 = b1.vias.filter((v) => v.group === 'V1').map((v) => [r3(v.x - pad1.x), r3(v.y - pad1.y)]);
    expect(rel1).toEqual(rel0.map(([dx, dy]) => turn(dx!, dy!, (p1.rot - p0.rot + 360) % 360).map(r3)));
    // and dropSpot does the same for a part on the bottom (mirrored)
    expect(dropSpot({ rot: 0, side: 'bottom' }, { x: 10, y: 10 }, [1, 2])).toEqual([9, 12]);
  });

  it('add_vias drop: rejects spots on the pad, far from it, under the body or on each other; says when the current wants more', () => {
    const k = bulk([{ op: 'set_net', net: 'GND', max_current: 3 }]);
    const b = k.board();
    const pad = b.parts.find((p) => p.refdes === 'C9')!.pads.find((q) => q.number === '2')!;
    const drop = (at: { x_mm: number; y_mm: number }[]) => k.transact({ summary: 'drop', ops: [{ op: 'add_vias', kind: 'drop', ref: 'C9', pad: '2', at }] });
    const no = (at: { x_mm: number; y_mm: number }[], says: string | RegExp) => {
      const r = drop(at);
      expect(r.status).toBe('rejected');
      expect(r.rejection?.message).toMatch(says);
    };
    expect(k.transact({ summary: 'drop', ops: [{ op: 'add_vias', kind: 'drop', ref: 'C9', pad: '2' }] }).status).toBe('rejected');
    no([{ x_mm: pad.x, y_mm: pad.y }], 'off the pad\'s edge');
    const [ok] = beside(k, 'C9', '2', 1);
    const out = { x: Math.sign(ok!.x_mm - pad.x), y: Math.sign(ok!.y_mm - pad.y) };
    no([{ x_mm: ok!.x_mm + out.x * 3, y_mm: ok!.y_mm + out.y * 3 }], 'within 2 mm');
    // towards the other pad: between the pads
    no([{ x_mm: 2 * pad.x - ok!.x_mm, y_mm: 2 * pad.y - ok!.y_mm }], /under C9|too close to C9\.1/);
    no([ok!, { x_mm: ok!.x_mm + 0.3 * Math.abs(out.y), y_mm: ok!.y_mm + 0.3 * Math.abs(out.x) }], 'closer than');
    const r = drop(beside(k, 'C9', '2', 2));
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(r.status === 'ok' && r.results[0]!.effect).toContain('3 A wants 4');
    expect(boardSummary(k.board()).via_groups).toContainEqual(expect.objectContaining({ kind: 'drop', note: '2 for 3 A, which wants 4: place more beside the pad' }));
  });

  it('DRC.PLANE_VIAS: a pad with fewer vias than it was given, on the copper as it lies', async () => {
    const { planeViaDrc } = await import('../src/drc.ts');
    const k = bulk();
    k.transact({ summary: 'drop', ops: [{ op: 'add_vias', kind: 'drop', ref: 'C9', pad: '2', at: beside(k, 'C9', '2', 4), amps: 3 }] });
    const b = routed(k);
    expect(planeViaDrc(b)).toEqual([]);
    // all but one of C9.2's vias gone
    const { vias } = padVias(b, 'C9', '2');
    expect(vias).toHaveLength(4);
    const found = planeViaDrc({ ...b, vias: b.vias.filter((v) => !vias.slice(1).includes(v)) });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: 'DRC.PLANE_VIAS', severity: 'warning', entities: ['C9'] });
    expect(found[0]!.message).toContain('C9.2 (GND) reaches the In1.Cu plane through 1 via of its own; V1 asks for 4 (enough for 3 A)');
    // in a pour of its net on its own layer: the pour spreads the current
    const pad = vias[0]!;
    expect(planeViaDrc({ ...b, vias: b.vias.filter((v) => !vias.slice(1).includes(v)), zones: [...b.zones, { netId: vias[0]!.netId, layer: 'F.Cu', rects: [pad.x - 3, pad.y - 3, 6, 6] }] })).toEqual([]);
  });
});

describe('trackWidthFor', () => {
  it('follows IPC-2221 for 1 oz outer copper at 10 °C rise', async () => {
    const { trackWidthFor } = await import('@4k7/schema');
    expect(trackWidthFor(0.1)).toBe(0.15); // floor
    expect(trackWidthFor(1)).toBeCloseTo(0.3, 2);
    expect(trackWidthFor(2)).toBeCloseTo(0.8, 2);
    expect(trackWidthFor(3)).toBeGreaterThan(1.2);
  });
});

describe('value series', () => {
  it('flags generic passives outside the design series with the nearest value as the fix; the review carries it', () => {
    const k = buck();
    const series = (ref: string) => k.state().diagnostics.find((d) => d.code === 'SEM.VALUE_SERIES' && d.entities[0] === ref);
    expect(series('R1')).toBeUndefined();
    const r = k.transact({ summary: 'E12 resistors, E6 caps', ops: [{ op: 'set_value_series', resistors: 'E12', capacitors: 'E6' }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(k.proposal()?.hunks.find((h) => h.id === 'board:series')?.title).toBe('value series: resistors E12, capacitors E6');
    expect(k.summary().valueSeries).toEqual({ resistor: 'E12', capacitor: 'E6' });
    expect(series('R1')).toMatchObject({ severity: 'warning', fixHints: [{ op: 'set_param', ref: 'R1', params: { resistance: '33kΩ' } }] });
    expect(series('R1')!.message).toContain('27kΩ or 33kΩ');
    expect(series('R2')?.fixHints).toEqual([{ op: 'set_param', ref: 'R2', params: { resistance: '10kΩ' } }]);
    expect(series('R3')).toBeUndefined(); // 8.2k is E12
    expect(k.state().diagnostics.filter((d) => d.code === 'SEM.VALUE_SERIES' && d.entities[0]!.startsWith('C'))).toEqual([]);
    k.accept();
    expect(k.committedDesign().valueSeries).toEqual({ resistor: 'E12', capacitor: 'E6' });

    // a value the user fixed in the ledger is theirs
    k.transact({ summary: 'keep R2', ops: [{ op: 'constrain', kind: 'param', a: 'R2', key: 'resistance', value: '10.2k', strength: 'hard', quote: 'R2 stays 10.2k' }] });
    expect(series('R2')).toBeUndefined();

    // null clears a kind, all sets every kind
    k.transact({ summary: 'any', ops: [{ op: 'set_value_series', resistors: null }] });
    expect(k.summary().valueSeries).toEqual({ capacitor: 'E6' });
    expect(series('R1')).toBeUndefined();
    k.transact({ summary: 'E24', ops: [{ op: 'set_value_series', all: 'E24' }] });
    expect(k.summary().valueSeries).toEqual({ resistor: 'E24', capacitor: 'E24', inductor: 'E24' });
    expect(series('R1')?.fixHints).toEqual([{ op: 'set_param', ref: 'R1', params: { resistance: '33kΩ' } }]); // 31.6k: 33k is nearer than 30k on a log scale
  });
});
