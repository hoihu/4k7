/**
 * Schematic drawing eval: lays the golden circuits (schematic-golden.ts) out through the
 * auto-layout and measures the drawings, so a change to the layout shows in numbers.
 *
 *   node --experimental-transform-types packages/kernel/bench/schematic-eval.ts [--out file.json] [--compare baseline.json] [--only id,id]
 *
 * Prints a table (per circuit: SCH.* findings, wire segments, crossings, jogs, detours, labels
 * against wires, pages) and writes the numbers as JSON (--out, default schematic-latest.json next
 * to this file; the committed baseline is schematic-baseline.json, written with
 * `--out packages/kernel/bench/schematic-baseline.json`). With --compare the table shows the
 * change against that file. The vitest guard (test/schematic-eval.test.ts) holds the circuits to it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PAPERS, type Design, type SheetView } from '@4k7/schema';
import { segments, touches, wireCrossings, wireShape, type Seg } from '../src/scope.ts';
import { build, GOLDEN, type Golden } from './schematic-golden.ts';

export interface Score {
  id: string;
  parts: number;
  nets: number;
  /** SCH.* findings by id (all levels). */
  sch: Record<string, number>;
  /** SCH.* findings at the Must fix level. */
  mustFix: number;
  wires: number;
  segments: number;
  /** Total wire length, in 100 mil units. */
  wireLen: number;
  bends: number;
  crossings: number;
  jogs: number;
  detours: number;
  /** Net flags (not supply symbols). */
  labels: number;
  /** Supply symbols (rails and grounds). */
  supplies: number;
  /** labels / (labels + wires): how much of the drawing is told by names rather than drawn. */
  labelShare: number;
  pages: number;
  /** Area of the pages, in A4 pages. */
  area: number;
  oversized: number;
  /** Pins the drawing does not tie to the rest of their net by a wire or a label. */
  unconnected: string[];
  /** Wires or pins that join two nets. */
  shorts: string[];
  ms: number;
}

/** Counters compared with --compare and bounded by the guard (lower is better). */
export const COST = ['segments', 'crossings', 'jogs', 'detours', 'bends', 'labels', 'pages'] as const;

const A4 = PAPERS.A4.w * PAPERS.A4.h;

/**
 * Which pins the drawing leaves apart from their net, and which it joins to another one. A pin is
 * tied to its net when wires of the net join it to the rest, or a label (a flag or a supply symbol)
 * of the net stands at its wire; every drawn piece of a net with a label counts as one.
 */
export function connectivity(d: Design, sheetViews: SheetView[]): { unconnected: string[]; shorts: string[] } {
  const unconnected: string[] = [];
  const shorts: string[] = [];
  const pinsOf = new Map<string, { ref: string; sheet: SheetView; x: number; y: number }[]>();
  for (const sheet of sheetViews) {
    for (const s of sheet.symbols) {
      const comp = d.components[s.componentId];
      for (const p of s.pins) {
        const netId = comp?.pins[p.number];
        if (!netId) continue;
        const list = pinsOf.get(netId) ?? [];
        list.push({ ref: `${s.refdes}.${p.name === p.number ? p.number : p.name}`, sheet, x: p.x, y: p.y });
        pinsOf.set(netId, list);
        for (const w of sheet.wires) if (w.netId !== netId && segments(w.pts).some((g) => touches(g, p.x, p.y))) shorts.push(`${s.refdes}.${p.number} on a wire of ${d.nets[w.netId]?.name}`);
      }
    }
  }
  for (const [netId, pins] of pinsOf) {
    if (pins.length < 2) continue;
    // one union-find over the net's pins and wires, where they touch on a sheet
    const sheets = [...new Set(pins.map((p) => p.sheet))];
    const items = [
      ...pins.map((p) => ({ sheet: p.sheet, segs: [[p.x, p.y, p.x, p.y]] as Seg[] })),
      ...sheets.flatMap((sheet) => sheet.wires.filter((w) => w.netId === netId).map((w) => ({ sheet, segs: segments(w.pts) }))),
    ];
    const up = items.map((_, i) => i);
    const find = (i: number): number => (up[i] === i ? i : (up[i] = find(up[i]!)));
    const on = (it: (typeof items)[number], x: number, y: number) => it.segs.some((g) => touches(g, x, y));
    const ends = (it: (typeof items)[number]) => it.segs.flatMap((g) => [[g[0], g[1]] as const, [g[2], g[3]] as const]);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (items[i]!.sheet !== items[j]!.sheet) continue;
        if (ends(items[i]!).some(([x, y]) => on(items[j]!, x, y)) || ends(items[j]!).some(([x, y]) => on(items[i]!, x, y))) up[find(i)] = find(j);
      }
    }
    // every piece with a label (a flag or a supply symbol) of the net is one: the name joins them
    const labelled = items.map((it, i) => i).filter((i) => items[i]!.sheet.labels.some((l) => l.netId === netId && on(items[i]!, l.x, l.y)));
    for (const i of labelled.slice(1)) up[find(i)] = find(labelled[0]!);
    // the labelled piece is "the net"; without a label, the piece with the most pins
    const size = new Map<number, number>();
    pins.forEach((_, i) => size.set(find(i), (size.get(find(i)) ?? 0) + 1));
    const main = labelled.length ? find(labelled[0]!) : [...size].sort((a, b) => b[1] - a[1])[0]![0];
    pins.forEach((p, i) => {
      if (find(i) !== main) unconnected.push(`${p.ref} (${d.nets[netId]?.name})`);
    });
  }
  return { unconnected: unconnected.sort(), shorts: [...new Set(shorts)].sort() };
}

/** Lay the circuit out and measure the drawing. */
export function score(g: Golden, k = build(g)): Score {
  const t0 = performance.now();
  const state = k.state();
  const d = k.committedDesign();
  const sch: Record<string, number> = {};
  let mustFix = 0;
  for (const x of state.diagnostics) {
    if (!x.code.startsWith('SCH.')) continue;
    sch[x.code] = (sch[x.code] ?? 0) + 1;
    if (x.severity === 'error') mustFix++;
  }
  const s = { wires: 0, segments: 0, wireLen: 0, bends: 0, crossings: 0, jogs: 0, detours: 0, labels: 0, supplies: 0, pages: 0, area: 0, oversized: 0 };
  for (const sheet of state.view.sheets) {
    const nets = new Set(sheet.wires.map((w) => w.netId));
    s.wires += sheet.wires.length;
    for (const w of sheet.wires) {
      for (const [x1, y1, x2, y2] of segments(w.pts)) {
        s.segments++;
        s.wireLen += (Math.abs(x2 - x1) + Math.abs(y2 - y1)) / 100;
      }
    }
    s.crossings += wireCrossings(sheet, nets).length;
    for (const n of nets) {
      const shape = wireShape(sheet, n);
      s.bends += shape.bends;
      s.jogs += shape.jogs.length;
      s.detours += shape.detours.length;
    }
    for (const l of sheet.labels) if (l.kind === 'net') s.labels++;
    else s.supplies++;
    s.pages += sheet.pages.length;
    for (const p of sheet.pages) {
      s.area += (p.rect.w * p.rect.h) / A4;
      if (p.oversized) s.oversized++;
    }
  }
  const { unconnected, shorts } = connectivity(d, state.view.sheets);
  const ms = performance.now() - t0;
  return {
    id: g.id,
    parts: Object.keys(d.components).length,
    nets: Object.keys(d.nets).length,
    sch,
    mustFix,
    ...s,
    wireLen: Math.round(s.wireLen),
    area: Math.round(s.area * 100) / 100,
    labelShare: s.labels + s.wires ? Math.round((s.labels / (s.labels + s.wires)) * 100) / 100 : 0,
    unconnected,
    shorts,
    ms: Math.round(ms),
  };
}

/* ----------------------------------- CLI ---------------------------------- */

const pad = (v: string | number, n: number) => String(v).padStart(n);
const delta = (now: number, was: number | undefined) => (was === undefined || was === now ? '' : `${now > was ? '+' : ''}${Math.round((now - was) * 100) / 100}`);

function table(scores: Score[], base?: Map<string, Score>): string {
  const cols = [['parts', 5], ['segments', 8], ['crossings', 9], ['jogs', 4], ['detours', 7], ['bends', 5], ['labels', 6], ['supplies', 8], ['labelShare', 10], ['pages', 5], ['area', 5], ['mustFix', 7], ['ms', 4]] as const;
  const idw = Math.max(...scores.map((s) => s.id.length), 7);
  const lines = [`${'circuit'.padEnd(idw)} ${cols.map(([c, w]) => pad(c, w)).join(' ')}  SCH findings`];
  for (const s of scores) {
    const b = base?.get(s.id);
    const cell = (c: (typeof cols)[number][0], w: number) => {
      const v = s[c];
      const dv = c === 'ms' ? '' : delta(v, b?.[c]);
      return pad(dv ? `${v} (${dv})` : v, w + (dv ? dv.length + 3 : 0));
    };
    const findings = Object.entries(s.sch).sort().map(([id, n]) => `${id.slice(4)}=${n}${delta(n, b ? (b.sch[id] ?? 0) : undefined) ? `(${delta(n, b!.sch[id] ?? 0)})` : ''}`).join(' ');
    const lost = b ? Object.keys(b.sch).filter((id) => !(id in s.sch)).map((id) => `${id.slice(4)}=0(-${b.sch[id]})`) : [];
    lines.push(`${s.id.padEnd(idw)} ${cols.map(([c, w]) => cell(c, w)).join(' ')}  ${[findings, ...lost].filter(Boolean).join(' ') || '-'}`);
    if (s.unconnected.length) lines.push(`  NOT CONNECTED: ${s.unconnected.join(', ')}`);
    if (s.shorts.length) lines.push(`  SHORTS: ${s.shorts.join(', ')}`);
  }
  const sum = (c: (typeof COST)[number]) => scores.reduce((n, s) => n + s[c], 0);
  const was = (c: (typeof COST)[number]) => (base ? scores.reduce((n, s) => n + (base.get(s.id)?.[c] ?? 0), 0) : undefined);
  lines.push(`total: ${COST.map((c) => `${c} ${sum(c)}${delta(sum(c), was(c)) ? ` (${delta(sum(c), was(c))})` : ''}`).join(', ')}`);
  return lines.join('\n');
}

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const only = arg('--only')?.split(',');
  const scores = GOLDEN.filter((g) => !only || only.includes(g.id)).map((g) => score(g));
  const cmp = arg('--compare');
  const base = cmp ? new Map((JSON.parse(readFileSync(cmp, 'utf8')) as Score[]).map((s) => [s.id, s])) : undefined;
  console.log(table(scores, base));
  const out = arg('--out') ?? new URL('./schematic-latest.json', import.meta.url).pathname;
  // (without the timing, so a new baseline differs only where the drawings do)
  writeFileSync(out, JSON.stringify(scores.map(({ ms: _, ...s }) => s), null, 2) + '\n');
  console.log(`wrote ${out}`);
}
