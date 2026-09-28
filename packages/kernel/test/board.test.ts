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

describe('fixed outline with a pinned part', () => {
  it('keeps every other part inside the board', () => {
    const k = buck();
    k.transact({ summary: 'board', ops: [
      { op: 'set_board', width_mm: 30, height_mm: 20 },
      { op: 'place', ref: 'J1', x_mm: 3, y_mm: 10, rot: 0 },
    ] });
    const b = k.board();
    expect(b.outline).toEqual({ w: 30, h: 20 });
    expect(b.parts.filter((p) => p.locked).map((p) => p.refdes)).toEqual(['J1']);
    expect(b.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(b.stats.unrouted).toBe(0);
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

  it('draws tracks as straight 0/45/90° pieces, not zigzags', () => {
    const k = buck();
    k.transact({ summary: 'holes', ops: [{ op: 'add_hole', diameter_mm: 3.5, corner: 'all' }] });
    const b = k.board();
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

describe('planes', () => {
  it('uses GND and the main supply as inner planes on 4 layers, connected through vias', () => {
    const k = buck();
    k.transact({ summary: '4 layers', ops: [{ op: 'set_board', layers: 4 }] });
    const b = k.board();
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
    const b = k.board();
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
    const b = k.board();
    expect(b.vias.length).toBeGreaterThan(3); // plane drops
    expect(viaInPad(b)).toEqual([]);
    expect(b.stats.unrouted).toBe(0);
  });

  it('keeps vias apart and connects plane vias through thermal reliefs', () => {
    const k = buck();
    k.transact({ summary: 'planes', ops: [{ op: 'set_board', layers: 4 }] });
    const b = k.board();
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
    const b = k.board();
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
    const b = k.board();
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
    const files = fabFiles(k.board(), 'h');
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
    let b = k.board();
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
