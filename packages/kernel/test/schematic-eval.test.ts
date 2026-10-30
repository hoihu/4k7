import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { build, GOLDEN } from '../bench/schematic-golden.ts';
import { connectivity, score, type Score } from '../bench/schematic-eval.ts';

/**
 * The drawing eval's guard (docs/design/schematic-drawing.md, "The drawing eval"): the golden
 * circuits laid out by the auto-layout must stay complete, free of Must fix findings, and no worse
 * than the committed baseline (bench/schematic-baseline.json, written by bench/schematic-eval.ts)
 * by more than a tenth. A change that improves a number is no failure: write a new baseline with it.
 * One test per circuit, each well under a tenth of a second.
 */
const baseline = new Map((JSON.parse(readFileSync(new URL('../bench/schematic-baseline.json', import.meta.url), 'utf8')) as Score[]).map((s) => [s.id, s]));

/** The most a counter may reach: the baseline and a tenth (rounded up) more, so zero stays zero. */
const limit = (base: number) => base + Math.ceil(base / 10);

describe('the golden circuits are drawn', () => {
  it('has a baseline for exactly the golden circuits', () => {
    expect(GOLDEN.map((g) => g.id).sort()).toEqual([...baseline.keys()].sort());
    expect(new Set(GOLDEN.map((g) => g.id)).size).toBe(GOLDEN.length);
  });

  for (const g of GOLDEN) {
    it(g.id, () => {
      const base = baseline.get(g.id)!;
      const k = build(g);
      const s = score(g, k);
      // complete: every part drawn, every connection a wire or a label, nothing joined that is not
      const drawn = new Set(k.state().view.sheets.flatMap((sh) => sh.symbols.map((x) => x.refdes)));
      expect([...Object.values(k.committedDesign().components)].map((c) => c.refdes).filter((r) => !drawn.has(r))).toEqual([]);
      expect(s.unconnected).toEqual([]);
      expect(s.shorts).toEqual([]);
      // no finding at the Must fix level (the shipped levels)
      expect(s.mustFix, JSON.stringify(s.sch)).toBe(0);
      // no worse than the baseline
      for (const c of ['segments', 'crossings', 'jogs', 'detours', 'pages'] as const) expect(s[c], `${c} (baseline ${base[c]})`).toBeLessThanOrEqual(limit(base[c]));
    });
  }
});

describe('the connection check', () => {
  it('sees a pin left without a wire or a label, and a wire that touches another net', () => {
    const k = build(GOLDEN.find((g) => g.id === 'buck-tps54331')!);
    const d = k.committedDesign();
    const sheets = k.state().view.sheets;
    expect(connectivity(d, sheets)).toEqual({ unconnected: [], shorts: [] });
    // nothing drawn between the parts: every net of two pins or more falls apart
    const bare = sheets.map((s) => ({ ...s, wires: [], labels: [] }));
    expect(connectivity(d, bare).unconnected.length).toBeGreaterThan(10);
    // one wire of the first sheet moved onto a pin of another net
    const w = sheets[0]!.wires[0]!;
    const other = sheets[0]!.symbols.flatMap((s) => s.pins.map((p) => ({ p, s }))).find(({ s, p }) => d.components[s.componentId]?.pins[p.number] && d.components[s.componentId]!.pins[p.number] !== w.netId)!;
    const bad = [{ ...sheets[0]!, wires: [{ ...w, pts: [other.p.x, other.p.y, other.p.x + 100, other.p.y] }] }];
    expect(connectivity(d, bad).shorts.length).toBeGreaterThan(0);
  });
});
