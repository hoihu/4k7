/**
 * Does the congestion estimate predict what the router makes of a placement? Takes the bench board
 * (bench/benchboard.ts), places it many ways (the main parts shifted and turned at random, deterministic
 * per seed, the placer putting the small parts round them), routes each, and prints how well each
 * placement measure (ratsnest length, crossings, congestion) goes with what routing then gave: vias,
 * track length, passes and open connections (Pearson r and Spearman rho over the placements).
 *
 *   node --experimental-transform-types packages/kernel/bench/congest.ts [layers 2|4] [clusters 1|2|3] [placements, default 24] [budget s per placement, default 20]
 *
 * (env SQUEEZE, e.g. 0.8: the board fixed at that share of the proposed width and height, a tighter board where routing is the problem)
 *
 */
import { ratsnest } from '../src/board.ts';
import { CONGESTION_WEIGHT, CROSSING_MM, CELL_MM, FREE_SHARE, congestion, type Board, type Line } from '../src/congestion.ts';
import { writeFileSync } from 'node:fs';
import { Kernel } from '../src/index.ts';
import { benchKernel } from './benchboard.ts';

const layers = process.argv[2] === '4' ? 4 : 2;
const clusters = Number(process.argv[3] ?? 1);
const count = Number(process.argv[4] ?? 24);
const budget = Number(process.argv[5] ?? 20);
// a tighter board than the placer proposes (share of its width and height), where routing is the problem
const squeeze = Number(process.env.SQUEEZE ?? 1);

const base = benchKernel(layers, clusters);
base.transact({ summary: 'propose', ops: [{ op: 'propose_placement' }] });
const start = base.boardPlacement();
if (squeeze < 1) base.transact({ summary: 'size', ops: [{ op: 'set_board', width_mm: Math.round(start.outline.w * squeeze), height_mm: Math.round(start.outline.h * squeeze) }] });
const mains = start.parts.filter((p) => p.pads.length > 3 && !p.componentId.startsWith('hole:'));

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

interface Row {
  name: string;
  ratsnest: number;
  crossings: number;
  overflow: number;
  peak: number;
  hot: number;
  vias: number;
  track: number;
  passes: number;
  open: number;
  ms: number;
  board: Board;
  lines: Line[];
}
const rows: Row[] = [];
for (let v = 0; v < count; v++) {
  const k = new Kernel(base.draftDesign());
  // 0: the placer's own proposal; then the main parts moved further and further
  const spread = v === 0 ? 0 : 1 + (v % 6);
  const parts = mains.map((p) => {
    const turn = v > 0 && rnd() < 0.15 + 0.05 * spread ? [90, 180, 270][Math.floor(rnd() * 3)]! : 0;
    return { ref: p.refdes, x_mm: Math.max(2, p.x + (rnd() - 0.5) * 2 * spread), y_mm: Math.max(2, p.y + (rnd() - 0.5) * 2 * spread), rot: ((p.rot + turn) % 360) as 0 | 90 | 180 | 270 };
  });
  if (v === 0) k.transact({ summary: 'propose', ops: [{ op: 'propose_placement' }] });
  else if (k.transact({ summary: 'propose', ops: [{ op: 'propose_placement', parts }] }).status !== 'ok') continue;
  const placed = k.boardPlacement();
  const t = performance.now();
  k.transact({ summary: 'route', ops: [{ op: 'route' }] });
  const b = k.board();
  const ms = performance.now() - t;
  const m = placed.measures;
  const planeNets = new Set(placed.planes.filter((pl) => pl.layer !== 'F.Cu' && pl.layer !== 'B.Cu' && !pl.area).map((pl) => pl.netId));
  const board: Board = { w: placed.outline.w, h: placed.outline.h, rules: placed.rules, signal: placed.layers.filter((l) => !placed.planes.some((pl) => pl.layer === l && l !== 'F.Cu' && l !== 'B.Cu' && !pl.area)), pads: placed.parts.flatMap((p) => p.pads) };
  const lines = ratsnest(placed.parts).filter((l) => !planeNets.has(l.netId));
  rows.push({ name: `#${v}`, ratsnest: m.ratsnestMm, crossings: m.crossings, overflow: m.congestion.overflowMm, peak: m.congestion.peak, hot: m.congestion.hot, vias: b.stats.vias, track: Math.round(b.stats.trackLength), passes: b.newCopper?.passes ?? 0, open: b.stats.unrouted, ms, board, lines });
  console.log(`${rows.at(-1)!.name}: board ${placed.outline.w}x${placed.outline.h}, ratsnest ${m.ratsnestMm} mm, ${m.crossings} crossings, congestion ${m.congestion.overflowMm} mm (peak ${m.congestion.peak}, ${m.congestion.hot} cells) -> ${b.stats.vias} vias, ${Math.round(b.stats.trackLength)} mm, ${rows.at(-1)!.passes} passes, ${b.stats.unrouted} open, ${(ms / 1000).toFixed(1)} s`);
  if (rows.reduce((s, r) => s + r.ms, 0) > budget * 1000 * count) break;
}

if (process.env.SAVE) writeFileSync(process.env.SAVE, JSON.stringify(rows));

const pearson = (a: number[], b: number[]) => {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    ab += (a[i]! - ma) * (b[i]! - mb);
    aa += (a[i]! - ma) ** 2;
    bb += (b[i]! - mb) ** 2;
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
};
const ranks = (a: number[]) => {
  const order = a.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
  const r = new Array<number>(a.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    for (let k2 = i; k2 <= j; k2++) r[order[k2]![1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
};
const spearman = (a: number[], b: number[]) => pearson(ranks(a), ranks(b));

console.log(`\n${rows.length} placements; correlation with what routing gave (Pearson / Spearman):`);
const measures: [string, (r: Row) => number][] = [
  ['crossings', (r) => r.crossings],
  ['ratsnest mm', (r) => r.ratsnest],
  ['congestion mm', (r) => r.overflow],
  ['congestion peak', (r) => r.peak],
  ['congested cells', (r) => r.hot],
  ['4 × crossings + ratsnest (the old score)', (r) => CROSSING_MM * r.crossings + r.ratsnest],
  ['… + 8 × congestion mm (routability)', (r) => CROSSING_MM * r.crossings + r.ratsnest + CONGESTION_WEIGHT * r.overflow],
];
const outcomes: [string, (r: Row) => number][] = [
  ['vias', (r) => r.vias],
  ['track mm', (r) => r.track],
  ['passes', (r) => r.passes],
  ['open', (r) => r.open],
];
console.log(['measure'.padEnd(42), ...outcomes.map(([n]) => n.padStart(14))].join(' '));
for (const [name, f] of measures) {
  const x = rows.map(f);
  console.log([name.padEnd(42), ...outcomes.map(([, g]) => `${pearson(x, rows.map(g)).toFixed(2)}/${spearman(x, rows.map(g)).toFixed(2)}`.padStart(14))].join(' '));
}

// does congestion add to what crossings and ratsnest length already say? Leave-one-out R² of a
// straight-line fit of each outcome on the first set of measures, and on those plus congestion
const solve = (a: number[][], b: number[]) => {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    if (Math.abs(m[c]![c]!) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => (Math.abs(row[i]!) < 1e-12 ? 0 : row[n]! / row[i]!));
};
const looR2 = (xs: number[][], y: number[]) => {
  const n = y.length;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let press = 0;
  let tot = 0;
  for (let i = 0; i < n; i++) {
    const idx = [...Array(n).keys()].filter((j) => j !== i);
    // standardise on the rest, ridge a little to keep it stable
    const cols = xs[0]!.map((_, c) => idx.map((j) => xs[j]![c]!));
    const mean = cols.map((col) => col.reduce((s, v) => s + v, 0) / col.length);
    const sd = cols.map((col, c) => Math.sqrt(col.reduce((s, v) => s + (v - mean[c]!) ** 2, 0) / col.length) || 1);
    const z = (j: number) => [1, ...xs[j]!.map((v, c) => (v - mean[c]!) / sd[c]!)];
    const d = z(0).length;
    const ata = Array.from({ length: d }, (_, r) => Array.from({ length: d }, (_, c) => idx.reduce((s, j) => s + z(j)[r]! * z(j)[c]!, 0) + (r === c && r > 0 ? 0.5 : 0)));
    const atb = Array.from({ length: d }, (_, r) => idx.reduce((s, j) => s + z(j)[r]! * y[j]!, 0));
    const w = solve(ata, atb);
    press += (y[i]! - z(i).reduce((s, v, k) => s + v * w[k]!, 0)) ** 2;
    tot += (y[i]! - my) ** 2;
  }
  return 1 - press / tot;
};
console.log('\nleave-one-out R² of a straight-line fit (higher: predicts better):');
console.log(['fit on'.padEnd(42), ...outcomes.map(([n]) => n.padStart(14))].join(' '));
for (const [name, f] of [
  ['crossings', (r: Row) => [r.crossings]],
  ['crossings, ratsnest', (r: Row) => [r.crossings, r.ratsnest]],
  ['congestion', (r: Row) => [r.overflow]],
  ['crossings, ratsnest, congestion', (r: Row) => [r.crossings, r.ratsnest, r.overflow]],
] as const) {
  console.log([name.padEnd(42), ...outcomes.map(([, g]) => looR2(rows.map(f), rows.map(g)).toFixed(2).padStart(14))].join(' '));
}

// other cell sizes and free shares of capacity
console.log(`\ncongestion mm for other settings (the default: ${CELL_MM} mm cells, free share ${FREE_SHARE}); Pearson with vias / track mm / passes / open, Spearman in brackets:`);
for (const cell of [1, 2, 3, 4]) {
  for (const free of [0.2, 0.3, 0.4, 0.5]) {
    const x = rows.map((r) => congestion(r.board, r.lines, cell, free).overflowMm);
    const cols = outcomes.map(([, g]) => `${pearson(x, rows.map(g)).toFixed(2)} (${spearman(x, rows.map(g)).toFixed(2)})`);
    console.log(`cell ${cell} mm, free ${free}: ${cols.join('   ')}`);
  }
}
