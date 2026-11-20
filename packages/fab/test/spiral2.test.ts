/**
 * spiral2, the October 2026 JLCPCB order, as a regression golden: its parts on a board, held against JLCPCB's
 * own footprints (EasyEDA records read 2026-10-26), their polarity marks and the pick-and-place in the house's
 * frame, and the order going to Standard assembly. See docs/design/assembly.md and docs/design/sourcing.md.
 * Offline: the catalogue and the footprints are stubs over the records in packages/parts/test/fixtures.
 */
import { describe, expect, it } from 'vitest';
import { JLCPCB_ASSEMBLY, type BoardPart, type BoardView, type SupplierPart } from '@4k7/schema';
import { Kernel } from '@4k7/kernel';
import { assemblyFacts, checkStock, easyedaFootprint, estimateOrder, fitLand, placedLand, type PartSource, type SourcedComponent } from '@4k7/parts';
import { pickAndPlace } from '../src/index.ts';
import * as eda from '../../parts/test/fixtures/easyeda.ts';
import { spiral2Cards, spiral2Parts } from '../../parts/test/fixtures/spiral2.ts';

const H = JLCPCB_ASSEMBLY;

/** spiral2's parts on a 110 × 150 mm four-layer board, 25 mm apart, turned as on spiral2. */
function spiral2() {
  const k = new Kernel();
  const d = k.committedDesign();
  for (const c of spiral2Cards) d.parts[c.id] = c;
  k.load(d);
  const r = k.transact({
    summary: 'spiral2',
    ops: [
      { op: 'set_board', width_mm: 110, height_mm: 150, layers: 4 },
      ...spiral2Parts.map((p) => ({ op: 'add_part' as const, part: p.part, refdes: p.refdes, params: { ...p.params, lcsc: p.sku } })),
      ...spiral2Parts.map((p, i) => ({ op: 'place' as const, ref: p.refdes, x_mm: 15 + (i % 4) * 25, y_mm: 15 + Math.floor(i / 4) * 25, rot: p.rot })),
    ],
  });
  if (r.status !== 'ok') throw new Error(JSON.stringify(r.rejection));
  k.accept();
  const design = k.committedDesign();
  const board = k.board();
  const comps: SourcedComponent[] = board.parts.map((p) => {
    const c = Object.values(design.components).find((x) => x.refdes === p.refdes)!;
    const card = design.parts[c.part]!;
    return { refdes: p.refdes, category: card.category, params: c.params, pkg: p.pkg, land: placedLand(p, (pin) => card.pins.find((x) => x.number === pin)?.name) };
  });
  return { board, comps };
}

const records = eda as Record<string, unknown>;
const footprint = (sku: string) => easyedaFootprint(records[sku])!;

/** JLCPCB's catalogue as a stub: every part in stock; the WS2812B and C1's electrolytic Standard only, as on spiral2. */
const standardOnly = new Set(['C2843785', 'C72505']);
const catalogue: PartSource = {
  lookup: async (sku) =>
    sku in records
      ? ({
          sku,
          mpn: sku,
          package: '',
          description: '',
          stock: 100_000,
          tier: 'Extended',
          fee: true,
          price: [{ qty: 1, each: 0.1 }],
          attributes: {},
          url: '',
          live: true,
          ...(standardOnly.has(sku) ? { services: ['Standard'] } : {}),
        } satisfies SupplierPart)
      : null,
  search: async () => [],
  footprint: async (sku) => footprint(sku),
};

describe('spiral2 golden: the pick-and-place in JLCPCB\'s frame (assembly.md §6)', () => {
  it('lays JLCPCB\'s own footprint of each part on its land at the rotation its engineers set by hand', async () => {
    const { board, comps } = spiral2();
    const r = await checkStock(comps, catalogue, { house: H, boards: 2 });
    expect(r.lands).toEqual({ compared: spiral2Parts.length, unread: [] });
    const placements = Object.assign({}, ...r.lines.map((l) => l.placements ?? {}));
    for (const s of spiral2Parts) {
      const line = r.lines.find((l) => l.sku === s.sku)!;
      expect(line.mismatch, s.refdes).toEqual([]);
      expect(placements[s.refdes]?.rotation, s.refdes).toBe(s.house);
      // where the house's origin lies: the part's centre, except J2's (and Q2's and U2's within 0.1 mm)
      const [ax, ay] = s.at ?? [0, 0];
      const off = Math.hypot(placements[s.refdes].at[0] - ax, placements[s.refdes].at[1] - ay);
      expect(off, s.refdes).toBeLessThan(s.at ? 0.001 : 0.1);
    }

    // the file the house gets: the house's rotation, and J2 moved 1.2 mm to its footprint's origin (y up in the file)
    const rows = new Map(pickAndPlace(board, placements).trim().split(/\r?\n/).slice(1).map((l) => l.split(',')).map((c) => [c[0]!, c]));
    const part = (refdes: string) => board.parts.find((p) => p.refdes === refdes)!;
    for (const s of spiral2Parts) expect(rows.get(s.refdes)?.[5], s.refdes).toBe(String(s.house));
    const j2 = part('J2');
    expect(rows.get('J2')!.slice(3, 5)).toEqual([j2.x.toFixed(3), (board.outline.h - j2.y + 1.196).toFixed(3)]);
    // without the house's footprints it is the board's own frame, as JLCPCB got spiral2: U2 at 270°, the rest at 0°
    const own = new Map(pickAndPlace(board).trim().split(/\r?\n/).slice(1).map((l) => l.split(',')).map((c) => [c[0]!, c[5]]));
    expect(own.get('U2')).toBe('270');
    for (const r of ['D3', 'U6', 'Q1', 'Q2']) expect(own.get(r), r).toBe('0');
  });

  it('pairs the two indicator LEDs by their cathode, whichever pin number the part gives it', () => {
    const { comps } = spiral2();
    const land = (r: string) => comps.find((c) => c.refdes === r)!.land!;
    expect(fitLand(land('D1'), footprint('C2297'))).toMatchObject({ by: 'function', rotation: 180, problems: [] });
    expect(fitLand(land('D2'), footprint('C84256'))).toMatchObject({ by: 'function', rotation: 0, problems: [] });
  });
});

describe('spiral2 golden: polarity marks (assembly.md §§1–2)', () => {
  const pad = (p: BoardPart, n: string) => p.pads.find((q) => q.number === n)!;
  const mid = (pts: number[]) => [(pts[0]! + pts[2]!) / 2, (pts[1]! + pts[3]!) / 2] as const;
  const dist = (a: readonly [number, number], q: { x: number; y: number }) => Math.hypot(a[0] - q.x, a[1] - q.y);
  /** The pad of the part nearest a point of its mark. */
  const nearest = (p: BoardPart, at: readonly [number, number]) => p.pads.reduce((a, q) => (dist(at, q) < dist(at, a) ? q : a)).number;

  it('prints a "+" at each electrolytic\'s plus pad, never a lone dash that reads as minus', () => {
    const { board } = spiral2();
    for (const r of ['C1', 'C11']) {
      const c = board.parts.find((p) => p.refdes === r)!;
      expect(c.mark, r).toMatchObject({ kind: 'plus', pad: '1', dots: [] });
      const [a, b] = c.mark!.strokes;
      expect(c.mark!.strokes, r).toHaveLength(2);
      // two strokes of one length crossing at their middles, one across the other: a "+"
      const [ma, mb] = [mid(a!.pts), mid(b!.pts)];
      expect(dist(ma, { x: mb[0], y: mb[1] }), r).toBeLessThan(1e-6);
      const len = (s: number[]) => Math.hypot(s[2]! - s[0]!, s[3]! - s[1]!);
      expect(len(a!.pts)).toBeCloseTo(len(b!.pts), 6);
      expect((a!.pts[2]! - a!.pts[0]!) * (b!.pts[2]! - b!.pts[0]!) + (a!.pts[3]! - a!.pts[1]!) * (b!.pts[3]! - b!.pts[1]!)).toBeCloseTo(0, 6);
      expect(dist(ma, pad(c, '1')), r).toBeLessThan(dist(ma, pad(c, '2')));
    }
  });

  it('marks the WS2812B at VDD (pin 1) and each indicator LED at its own cathode', () => {
    const { board, comps } = spiral2();
    const p = (r: string) => board.parts.find((q) => q.refdes === r)!;
    const d3 = p('D3');
    expect(d3.mark).toMatchObject({ kind: 'pin1', pad: '1', strokes: [] });
    expect(comps.find((c) => c.refdes === 'D3')!.land!.pads.find((q) => q.numbers.includes('1'))!.names).toEqual(['VDD']);
    const [dot] = d3.mark!.dots;
    expect(nearest(d3, [dot!.x, dot!.y])).toBe('1');
    // KT-0805G's cathode is pin 2, NCD0805R1's pin 1: a band against each
    for (const [r, k] of [['D1', '2'], ['D2', '1']] as const) {
      const d = p(r);
      expect(d.mark, r).toMatchObject({ kind: 'cathode', pad: k, dots: [] });
      expect(d.mark!.strokes, r).toHaveLength(1);
      expect(nearest(d, mid(d.mark!.strokes[0]!.pts)), r).toBe(k);
    }
    // every polarised part has its mark, with room for it
    for (const q of board.parts) expect(q.mark, q.refdes).toBeDefined();
    expect(board.diagnostics.filter((x) => /POLARITY/.test(x.code))).toEqual([]);
  });
});

describe('spiral2 golden: the order goes to Standard assembly (sourcing.md)', () => {
  // spiral2's 2 boards were estimated at $80.05 (Economic) and $133.05 (Standard) and billed $132.83: a
  // WS2812-type LED and an electrolytic were Standard only. Those totals need the whole BOM and the prices of
  // the day, which are not here; this pins the behaviour, not the dollars.
  it('cannot go to Economic with the Standard-only WS2812B and electrolytic, and still prices Standard', async () => {
    const { board, comps } = spiral2();
    const r = await checkStock(comps, catalogue, { house: H, boards: 2 });
    const facts = assemblyFacts(board as unknown as BoardView, new Set(spiral2Parts.map((p) => p.refdes)));
    expect(facts).toMatchObject({ layers: 4, boardSize: [110, 150], bottomRefs: [] });
    const [eco, std] = estimateOrder(r.lines, facts, 2, H);
    expect(eco).toMatchObject({ service: 'Economic' });
    expect(eco!.unavailable).toMatch(/in Standard assembly only/);
    expect(eco!.unavailable).toContain('C2843785');
    expect(std).toMatchObject({ service: 'Standard' });
    expect(std!.unavailable).toBeUndefined();
    expect(std!.total).toBeGreaterThan(0);
    // and without them Economic takes the order
    const every = r.lines.map((l) => ({ ...l, part: l.part && { ...l.part, services: undefined } }));
    expect(estimateOrder(every, facts, 2, H)[0]!.unavailable).toBeUndefined();
  });
});
