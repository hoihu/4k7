import { describe, expect, it } from 'vitest';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

function buck() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k;
}

describe('board placement', () => {
  it('places every part on the board without overlapping courtyards', () => {
    const b = buck().board();
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

  it('honours pinned positions and board settings', () => {
    const k = buck();
    k.transact({ summary: 'board', ops: [
      { op: 'set_board', width_mm: 40, height_mm: 30 },
      { op: 'place', ref: 'J1', x_mm: 3, y_mm: 15, rot: 90 },
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
  type Node = { net: string; layer: string; x0: number; y0: number; x1: number; y1: number; seg?: number[]; r?: number };
  const nodes: Node[] = [];
  for (const p of b.parts) for (const pad of p.pads) if (pad.netId) for (const layer of pad.drill ? b.layers : pad.layers) nodes.push({ net: pad.netId, layer, x0: pad.x - pad.w / 2, y0: pad.y - pad.h / 2, x1: pad.x + pad.w / 2, y1: pad.y + pad.h / 2 });
  for (const t of b.tracks) for (let i = 0; i + 3 < t.pts.length; i += 2) nodes.push({ net: t.netId, layer: t.layer, x0: 0, y0: 0, x1: 0, y1: 0, seg: t.pts.slice(i, i + 4), r: t.width / 2 });
  for (const v of b.vias) for (const layer of b.layers) nodes.push({ net: v.netId, layer, x0: v.x - v.pad / 2, y0: v.y - v.pad / 2, x1: v.x + v.pad / 2, y1: v.y + v.pad / 2 });
  const inRect = (n: Node, x: number, y: number) => x >= n.x0 - 1e-6 && x <= n.x1 + 1e-6 && y >= n.y0 - 1e-6 && y <= n.y1 + 1e-6;
  const ends = (n: Node) => (n.seg ? [[n.seg[0]!, n.seg[1]!], [n.seg[2]!, n.seg[3]!]] : [[(n.x0 + n.x1) / 2, (n.y0 + n.y1) / 2]]);
  const touch = (a: Node, c: Node) => {
    if (a.net !== c.net) return false;
    // vias join layers
    if (a.layer !== c.layer && !(a.x1 - a.x0 > 0 && a.x0 === c.x0 && a.y0 === c.y0)) return false;
    if (!a.seg && !c.seg) return a.x0 <= c.x1 && c.x0 <= a.x1 && a.y0 <= c.y1 && c.y0 <= a.y1;
    return ends(a).some(([x, y]) => (c.seg ? ends(c).some(([u, v]) => Math.hypot(u! - x!, v! - y!) < 1e-6) : inRect(c, x!, y!))) || ends(c).some(([x, y]) => !a.seg && inRect(a, x!, y!));
  };
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (touch(nodes[i]!, nodes[j]!)) parent[find(i)] = find(j);
  const roots = new Map<string, Set<number>>();
  nodes.forEach((n, i) => roots.set(n.net, (roots.get(n.net) ?? new Set()).add(find(i))));
  // pads of a net on different layers of one THT pad count once: compare pad roots only
  const padRoots = new Map<string, Set<number>>();
  nodes.forEach((n, i) => !n.seg && roots.has(n.net) && padRoots.set(n.net, (padRoots.get(n.net) ?? new Set()).add(find(i))));
  return [...padRoots.entries()].filter(([, s]) => s.size > 1).map(([net]) => b.netNames[net] ?? net);
}

describe('dragging a part (place)', () => {
  it('moves just that part; the board keeps its frame and size', () => {
    const k = buck();
    const before = k.board();
    const c2 = before.parts.find((p) => p.refdes === 'C2')!;
    k.transact({ summary: 'drag', ops: [{ op: 'place', ref: 'C2', x_mm: c2.x + 1.5, y_mm: c2.y + 1, rot: c2.rot }] });
    k.accept(undefined, 'user');
    const after = k.board();
    const moved = after.parts.find((p) => p.refdes === 'C2')!;
    expect([moved.x, moved.y, moved.locked]).toEqual([c2.x + 1.5, c2.y + 1, true]);
    expect(Math.abs(after.outline.w - before.outline.w)).toBeLessThanOrEqual(4);
    expect(Math.abs(after.outline.h - before.outline.h)).toBeLessThanOrEqual(4);
    // the other parts stay roughly where they were
    const u1a = before.parts.find((p) => p.refdes === 'U1')!;
    const u1b = after.parts.find((p) => p.refdes === 'U1')!;
    expect(Math.hypot(u1a.x - u1b.x, u1a.y - u1b.y)).toBeLessThan(3);
    expect(after.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
  });
});

describe('routing', () => {
  it('routes the buck completely, DRC-clean, and every net is one piece of copper', () => {
    const b = buck().board();
    expect(b.stats.unrouted).toBe(0);
    expect(b.stats.routed).toBe(b.stats.nets);
    expect(b.ratsnest).toEqual([]);
    expect(b.diagnostics).toEqual([]);
    expect(brokenNets(b)).toEqual([]);
    // supply nets get the wide track where the pads allow it
    const sw = b.tracks.filter((t) => b.netNames[t.netId] === '+12V');
    expect(sw.some((t) => t.width === b.rules.powerTrack)).toBe(true);
  });

  it('the copper DRC catches a short', async () => {
    const { copperDrc } = await import('../src/drc.ts');
    const b = structuredClone(buck().board());
    const pad = b.parts.find((p) => p.refdes === 'U1')!.pads[0]!;
    const other = Object.keys(b.netNames).find((n) => n !== pad.netId)!;
    b.tracks.push({ netId: other, layer: 'F.Cu', width: 0.25, pts: [pad.x - 1, pad.y, pad.x + 1, pad.y] });
    const d = copperDrc(b);
    expect(d.some((x) => x.code === 'DRC.SHORT' && x.message.includes('U1.1'))).toBe(true);
  });
});
