import { afterEach, describe, expect, it } from 'vitest';
import { getBuiltinPart, registerUserParts, unregisterUserPart } from '@4k7/parts';
import { insidePolygon, type CopperLayer, type Design } from '@4k7/schema';
import { checkDerived, Memo } from '../src/derive.ts';
import { placedOf } from '../src/board.ts';
import { viewOf } from '../src/drawing.ts';
import { workCopy } from '../src/doc.ts';
import { closePairs, shapeGap, type CopperItem } from '../src/drc.ts';
import { pointSegDist } from '../src/geom.ts';
import { Kernel } from '../src/kernel.ts';
import { islandsOf } from '../src/routegrid.ts';
import { buckTransaction } from './fixtures.ts';

const buck = () => {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k;
};
/** A design that is still being edited, its own copy. */
const copyOf = (k: Kernel): Design => k.draftDesign();
const refOf = (d: Design, ref: string) => Object.values(d.components).find((c) => c.refdes === ref)!;
const pseudoRandom = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

afterEach(() => checkDerived(!!process.env.CHECK_DERIVED));

describe('what is remembered', () => {
  it('tells a result that went stale, when asked to check', () => {
    checkDerived(false);
    const memo = new Memo<number[]>('numbers', 2);
    let n = 1;
    expect(memo.get('k', () => [n])).toEqual([1]);
    n = 2;
    // not asked: the key says it is the same
    expect(memo.get('k', () => [n])).toEqual([1]);
    checkDerived(true);
    expect(() => memo.get('k', () => [n])).toThrow(/numbers: stale result/);
  });

  it('freezes what it keeps, when asked to check, so a caller that writes into it is found', () => {
    checkDerived(true);
    const v = new Memo<{ a: number[] }>('frozen', 2).get('k', () => ({ a: [1] }));
    expect(() => v.a.push(2)).toThrow(TypeError);
  });

  it('forgets the oldest', () => {
    checkDerived(false);
    const memo = new Memo<number>('numbers', 2);
    memo.get('a', () => 1);
    memo.get('b', () => 2);
    memo.get('a', () => 1); // (now the newest)
    memo.get('c', () => 3);
    expect(memo.get('a', () => 9)).toBe(1);
    expect(memo.get('b', () => 9)).toBe(9);
  });
});

describe('the view and the placement of a design', () => {
  it('are shared while the design says the same, whichever copy asks', () => {
    const k = buck();
    const [a, b] = [copyOf(k), copyOf(k)];
    expect(placedOf(a)).toBe(placedOf(b));
    expect(viewOf(a).sheets[0]!.symbols).toBe(viewOf(b).sheets[0]!.symbols);
  });

  it('a part moved on the board draws no sheet again', () => {
    const k = buck();
    const before = copyOf(k);
    const part = placedOf(before).parts.find((p) => p.refdes === 'C1')!;
    expect(k.transact({ summary: 'x', ops: [{ op: 'place', ref: 'C1', x_mm: part.x + 1, y_mm: part.y }] }, 'user').status).toBe('ok');
    const after = copyOf(k);
    expect(viewOf(after).sheets[0]!.symbols).toBe(viewOf(before).sheets[0]!.symbols);
    expect(placedOf(after)).not.toBe(placedOf(before));
  });

  it('follow a card that changes, not only which cards there are', () => {
    const d = copyOf(buck());
    const u1 = refOf(d, 'U1');
    const was = viewOf(d).sheets[0]!.symbols.find((s) => s.refdes === 'U1')!.pins.map((p) => p.name);
    const changed: Design = structuredClone(d);
    changed.parts[u1.part]!.pins[0]!.name = 'RENAMED';
    const now = viewOf(changed).sheets[0]!.symbols.find((s) => s.refdes === 'U1')!.pins.map((p) => p.name);
    expect(now).not.toEqual(was);
    expect(now).toContain('RENAMED');
    const pad = (x: Design) => placedOf(x).parts.find((p) => p.refdes === 'U1')!.pads;
    const smaller: Design = structuredClone(d);
    smaller.components[u1.id]!.pins = {};
    expect(pad(smaller).every((p) => !p.netId)).toBe(true);
    expect(pad(d).some((p) => p.netId)).toBe(true);
  });

  it('follow a user part that changes in the library, for a design without its own copy', () => {
    const d = copyOf(buck());
    const u1 = refOf(d, 'U1');
    const id = 'test:derive-part';
    const card = structuredClone(getBuiltinPart(u1.part) ?? d.parts[u1.part]!);
    try {
      registerUserParts([{ ...card, id }]);
      const own: Design = structuredClone(d);
      delete own.parts[u1.part];
      own.parts = Object.fromEntries(Object.entries(own.parts).filter(([k]) => k !== id));
      own.components[u1.id]!.part = id;
      const names = () => viewOf(own).sheets[0]!.symbols.find((s) => s.refdes === 'U1')!.pins.map((p) => p.name);
      const was = names();
      registerUserParts([{ ...card, id, pins: card.pins.map((p, i) => (i ? p : { ...p, name: 'RENAMED' })) }]);
      expect(names()).not.toEqual(was);
      expect(names()).toContain('RENAMED');
    } finally {
      unregisterUserPart(id);
    }
  });

  it('a placement holds on to nothing of the design: an op that changes its copper in place leaves it as it was', () => {
    const k = buck();
    expect(k.transact({ summary: 'x', ops: [{ op: 'set_copper_mode', mode: 'drawn', keep: false }, { op: 'draw_via', net: 'GND', at: [5, 5] }] }, 'user').status).toBe('ok');
    const d = copyOf(k);
    d.board!.drawn!.vias[0]!.y = 6.25; // (a state not asked about before, so worked out from this copy)
    const before = placedOf(d);
    const at = before.drawn!.vias[0]!.x;
    d.board!.drawn!.vias[0]!.x = at + 1;
    expect(before.drawn!.vias[0]!.x).toBe(at);
  });
});

describe('what a placement shares with what is remembered', () => {
  it('a check of the panel waived and brought back shows again', () => {
    const k = buck();
    const ok = (ops: unknown[]) => expect(k.transact({ summary: 'x', ops } as never).status).toBe('ok');
    ok([{ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'set_panel', tabs: [{ side: 'left', at: 0.5 }] }]);
    k.accept();
    const check = () => k.boardPlacement().diagnostics.find((x) => x.code.startsWith('PANEL.'))!;
    const { code, entities } = check();
    expect(check().waivedBy).toBeUndefined();
    ok([{ op: 'add_waiver', code, entities, reason: 'for this test' }]);
    k.accept();
    const waiver = Object.keys(k.draftDesign().waivers).at(-1)!;
    expect(check().waivedBy).toBe(waiver);
    ok([{ op: 'remove_waiver', id: waiver }]);
    k.accept();
    expect(check().waivedBy).toBeUndefined();
  });

  it('a check waived on the placement stays as it is when the board is laid', () => {
    const k = buck();
    const found = k.boardPlacement().diagnostics.find((x) => x.entities.length);
    if (!found) return;
    expect(k.transact({ summary: 'x', ops: [{ op: 'add_waiver', code: found.code, entities: found.entities, reason: 'for this test' }] }).status).toBe('ok');
    k.accept();
    checkDerived(true);
    const placed = k.boardPlacement().diagnostics.find((x) => x.code === found.code);
    expect(placed?.waivedBy).toBeTruthy();
    expect(() => k.board()).not.toThrow();
  });

  it('copper taken over from the router holds on to nothing of the copper kept with the board', () => {
    const k = buck();
    expect(k.transact({ summary: 'x', ops: [{ op: 'route' }] }).status).toBe('ok');
    k.accept();
    expect(k.keepCopper(k.board().newCopper!)).toBe(true);
    const kept = () => JSON.stringify(k.committedDesign().board!.copper);
    const before = kept();
    // a dry run: an op that takes the copper over and one that moves parts without copying the board first
    const r = k.transact({ summary: 'x', dry_run: true, ops: [{ op: 'set_copper_mode', mode: 'drawn' }, { op: 'refine_placement' }] });
    expect(r.status).toBe('ok');
    expect(kept()).toBe(before);
    // what the take-over makes shares no array with what it took
    expect(k.transact({ summary: 'x', ops: [{ op: 'set_copper_mode', mode: 'drawn' }] }).status).toBe('ok');
    const d = k.draftDesign();
    expect(d.board!.drawn!.tracks.length).toBeGreaterThan(0);
    checkDerived(true);
    const work = workCopy(d);
    expect(Object.isFrozen(work.board!.copper)).toBe(true);
    expect(k.transact({ summary: 'x', ops: [{ op: 'refine_placement' }] }).status).toBe('ok');
    expect(kept()).toBe(before);
  });
});

describe('a kernel without anything pending', () => {
  it('commits, undoes and redoes what the checks found, unchanged', () => {
    const k = buck();
    const state = () => {
      const { view, diagnostics, counts, summary, ledger } = k.state();
      return JSON.stringify({ view, diagnostics, counts, summary, ledger });
    };
    const at0 = state();
    const r = k.transact({ summary: 'x', ops: [{ op: 'set_param', ref: 'R1', params: { resistance: '47k' } }] }, 'user');
    expect(r.status).toBe('ok');
    expect(k.hasPending()).toBe(true);
    k.accept(undefined, 'user', 'x');
    expect(k.hasPending()).toBe(false);
    const at1 = state();
    expect(at1).not.toBe(at0);
    k.undo();
    expect(state()).toBe(at0);
    k.redo();
    expect(state()).toBe(at1);
    // and a proposal rejected changes nothing of what is committed
    k.transact({ summary: 'y', ops: [{ op: 'set_param', ref: 'R1', params: { resistance: '10k' } }] });
    k.reject();
    expect(k.hasPending()).toBe(false);
    expect(state()).toBe(at1);
  });

  it('keeps the same results when every remembered result is worked out again', () => {
    checkDerived(true);
    const k = buck();
    const sym = () => k.state().view.sheets[0]!.symbols.find((s) => s.refdes === 'R1')!;
    const page = () => k.state().view.sheets[0]!.pages[0]!;
    const ok = (ops: unknown[]) => expect(k.transact({ summary: 'x', ops } as never, 'user').status).toBe('ok');
    ok([{ op: 'place_symbol', ref: 'R1', x: sym().bbox.x + sym().bbox.w / 2 - page().rect.x + 200, y: sym().bbox.y + sym().bbox.h / 2 - page().rect.y, rewire: true }]);
    k.accept(undefined, 'user', 'x');
    ok([{ op: 'place_text', ref: 'R1', at: 'above' }]);
    ok([{ op: 'set_param', ref: 'R1', params: { resistance: '47k' } }]);
    ok([{ op: 'set_paper', size: 'A3' }]);
    k.accept(undefined, 'user', 'x');
    const part = k.boardPlacement().parts.find((p) => p.refdes === 'C1')!;
    ok([{ op: 'place', ref: 'C1', x_mm: part.x + 0.5, y_mm: part.y }]);
    k.accept(undefined, 'user', 'x');
    k.undo();
    k.redo();
    expect(k.state().view.sheets.length).toBeGreaterThan(0);
  });
});

describe('a big outline', () => {
  /** How insidePolygon goes about it on a small polygon: edge by edge. */
  const edgeByEdge = (poly: number[], px: number, py: number) => {
    let inside = false;
    let best = Infinity;
    const n = poly.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi, xj, yj] = [poly[2 * i]!, poly[2 * i + 1]!, poly[2 * j]!, poly[2 * j + 1]!];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      best = Math.min(best, pointSegDist(px, py, xi, yi, xj, yj));
    }
    return inside ? best : -best;
  };

  it('gives what going edge by edge gives, to the last bit', () => {
    const rnd = pseudoRandom(7);
    for (const n of [31, 32, 33, 64, 500]) {
      const poly: number[] = [];
      for (let i = 0; i < n; i++) {
        const r = 20 + (i % 2 ? 8 : 0);
        const a = (2 * Math.PI * i) / n;
        poly.push(50 + r * Math.cos(a), 50 + r * Math.sin(a));
        if (i === 3) poly.push(50 + r * Math.cos(a), 50 + r * Math.sin(a)); // an edge of no length
      }
      for (let i = 0; i < 400; i++) {
        const [x, y] = [rnd() * 120 - 10, rnd() * 120 - 10];
        expect(insidePolygon(poly, x, y)).toBe(edgeByEdge(poly, x, y));
      }
      for (let i = 0; i + 1 < poly.length; i += 8) expect(insidePolygon(poly, poly[i]!, poly[i + 1]!)).toBe(edgeByEdge(poly, poly[i]!, poly[i + 1]!));
    }
  });
});

describe('the islands of a pour', () => {
  /** As a flood from each cell in turn. */
  const flood = (ok: Uint8Array, W: number, H: number) => {
    const island = new Int32Array(W * H).fill(-1);
    const sizes: number[] = [];
    for (let c0 = 0; c0 < W * H; c0++) {
      if (!ok[c0] || island[c0]! >= 0) continue;
      const stack = [c0];
      island[c0] = sizes.length;
      let n = 0;
      while (stack.length) {
        const c = stack.pop()!;
        n++;
        for (const nb of [c % W > 0 ? c - 1 : -1, c % W < W - 1 ? c + 1 : -1, c - W, c + W]) {
          if (nb < 0 || nb >= W * H || !ok[nb] || island[nb]! >= 0) continue;
          island[nb] = sizes.length;
          stack.push(nb);
        }
      }
      sizes.push(n);
    }
    return { island, sizes };
  };

  it('are numbered and counted as a flood finds them', () => {
    const rnd = pseudoRandom(11);
    for (let t = 0; t < 300; t++) {
      const [W, H] = [1 + Math.floor(rnd() * 30), 1 + Math.floor(rnd() * 30)];
      const set = rnd();
      const ok = Uint8Array.from({ length: W * H }, () => (rnd() < set ? 1 : 0));
      const [a, b] = [islandsOf(ok, W, H), flood(ok, W, H)];
      expect(a.sizes).toEqual(b.sizes);
      expect([...a.island]).toEqual([...b.island]);
    }
  });
});

describe('the clearance check', () => {
  /** Tracks, vias, pads and pours of a few nets on two layers, all over each other. */
  function tangle(seed: number): CopperItem[] {
    const rnd = pseudoRandom(seed);
    const at = () => Math.round(rnd() * 400) / 10;
    const net = () => `n${Math.floor(rnd() * 4)}`;
    const layer = (): CopperLayer => (rnd() < 0.5 ? 'F.Cu' : 'B.Cu');
    const seg = (id: string, ax: number, ay: number, bx: number, by: number, r: number): CopperItem => ({ net: net(), layer: layer(), shape: { kind: 'seg', ax, ay, bx, by, r }, bb: [Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r], what: id, id, track: true });
    const rect = (x0: number, y0: number, w: number, h: number, track: boolean, net_ = net(), layer_ = layer()): CopperItem => ({ net: net_, layer: layer_, shape: { kind: 'rect', x0, y0, x1: x0 + w, y1: y0 + h }, bb: [x0, y0, x0 + w, y0 + h], what: 'rect', track });
    return [
      ...Array.from({ length: 12 }, () => rect(at(), at(), 1, 0.6, false)),
      ...Array.from({ length: 50 }, (_, i) => seg(`t${i}`, at(), at(), at(), at(), 0.1)),
      ...Array.from({ length: 10 }, (_, i) => {
        const [x, y] = [at(), at()];
        return seg(`v${i}`, x, y, x, y, 0.3);
      }),
      ...Array.from({ length: 300 }, (_, i) => rect(at(), at(), rnd() * 6, rnd() * 2, true, i % 3 ? 'n0' : 'n1', i % 2 ? 'F.Cu' : 'B.Cu')),
    ];
  }

  /** Every pair, leftmost first, as the check has always listed them. */
  function everyPair(items: CopperItem[], c: number, focus?: Set<string>): [CopperItem, CopperItem, number][] {
    const out: [CopperItem, CopperItem, number][] = [];
    const sorted = items.map((it, i) => ({ it, i })).sort((p, q) => p.it.bb[0] - q.it.bb[0] || p.i - q.i);
    for (let m = 0; m < sorted.length; m++) {
      const A = sorted[m]!.it;
      for (let n = m + 1; n < sorted.length; n++) {
        const B = sorted[n]!.it;
        if (B.bb[0] > A.bb[2] + c) break;
        if (A.layer !== B.layer || A.net === B.net || (!A.track && !B.track)) continue;
        if (focus && !(A.id && focus.has(A.id)) && !(B.id && focus.has(B.id))) continue;
        if (B.bb[1] > A.bb[3] + c || A.bb[1] > B.bb[3] + c) continue;
        const gap = shapeGap(A.shape, B.shape);
        if (gap < c - 0.005) out.push([A, B, gap]);
      }
    }
    return out;
  }

  it('finds what going through every pair finds, in the same order', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const items = tangle(seed);
      const all = everyPair(items, 0.2);
      expect(all.length).toBeGreaterThan(50);
      expect(closePairs(items, 0.2)).toEqual(all);
      const focus = new Set(['t3', 't17', 'v2']);
      expect(closePairs(items, 0.2, focus)).toEqual(everyPair(items, 0.2, focus));
    }
  });
});
