/**
 * Router benchmark on a synthetic board: 90 × 60 mm, two QFP-48 (0.5 mm pitch) and 50 two-pin
 * passives, nets drawn at random (deterministic per seed), GND and VCC as supplies with their
 * default planes (a GND pour on B.Cu; with 4 layers GND on In1.Cu and VCC on In2.Cu).
 *
 *   node packages/kernel/bench/route.ts [layers 2|4]      (env SEED, default 7)
 *
 * Prints the time, nets routed, failed connections, tracks, vias, length and a hash of the
 * routes (equal hashes: identical copper).
 */
import { createHash } from 'node:crypto';
import type { BoardPad, BoardPart, CopperLayer } from '@tracewise/schema';
import { route } from '../src/router.ts';

let seed = Number(process.env.SEED ?? 7);
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const parts: BoardPart[] = [];
const pad = (number: string, x: number, y: number, w: number, h: number): BoardPad => ({ number, x, y, w, h, shape: 'rect', layers: ['F.Cu'] });
const part = (refdes: string, x: number, y: number, pads: BoardPad[], cw: number, ch: number) =>
  parts.push({ componentId: refdes, refdes, x, y, rot: 0, pads, courtyard: { x: x - cw / 2, y: y - ch / 2, w: cw, h: ch } } as unknown as BoardPart);

// two QFP-48, 12 pins a side
const icPins: BoardPad[] = [];
for (const [ref, cx, cy] of [['U1', 25, 25], ['U2', 60, 35]] as const) {
  const pads: BoardPad[] = [];
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < 12; i++) {
      const t = (i - 5.5) * 0.5;
      const n = String(s * 12 + i + 1);
      const p = s === 0 ? pad(n, cx - 4.2, cy + t, 1.4, 0.3) : s === 1 ? pad(n, cx + t, cy + 4.2, 0.3, 1.4) : s === 2 ? pad(n, cx + 4.2, cy - t, 1.4, 0.3) : pad(n, cx - t, cy - 4.2, 0.3, 1.4);
      pads.push(p);
      icPins.push(p);
    }
  }
  part(ref, cx, cy, pads, 10, 10);
}
// 50 passives (0603) on a loose grid above and below the ICs
const passives: BoardPad[] = [];
for (let k = 0; k < 50; k++) {
  const x = 6 + (k % 10) * 8 + rnd() * 2;
  const y = k < 20 ? 5 + Math.floor(k / 10) * 4 : 45 + Math.floor((k - 20) / 10) * 4;
  const a = pad('1', x - 0.8, y, 0.95, 0.9);
  const b = pad('2', x + 0.8, y, 0.95, 0.9);
  passives.push(a, b);
  part('R' + k, x, y, [a, b], 3, 1.6);
}
// nets: each IC pin on GND, VCC, a passive's pad, or its own net; then IC-to-IC links; the
// passives' other pads on the supplies
let n = 0;
const open = [...passives];
for (const p of icPins) {
  const r = rnd();
  if (r < 0.15) p.netId = 'GND';
  else if (r < 0.25) p.netId = 'VCC';
  else if (open.length && r < 0.7) {
    const q = open.splice(Math.floor(rnd() * open.length), 1)[0]!;
    p.netId = q.netId = 'N' + n++;
  } else p.netId = 'N' + n++;
}
const u1 = icPins.slice(0, 48);
const u2 = icPins.slice(48);
for (const p of u1) {
  if (!p.netId?.startsWith('N') || passives.some((q) => q.netId === p.netId)) continue;
  const q = u2.find((x) => !x.netId || (x.netId.startsWith('N') && !u1.some((y) => y !== p && y.netId === x.netId) && !passives.some((z) => z.netId === x.netId)));
  if (q) q.netId = p.netId;
}
for (const q of open) q.netId = rnd() < 0.5 ? 'GND' : 'VCC';

const layers: CopperLayer[] = process.argv[2] === '4' ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu'];
const planes = layers.length === 4 ? [{ netId: 'GND', layer: 'In1.Cu' as const }, { netId: 'VCC', layer: 'In2.Cu' as const }] : [{ netId: 'GND', layer: 'B.Cu' as const }];
const t0 = performance.now();
const r = route({ outline: { w: 90, h: 60 }, layers, rules: { clearance: 0.15, track: 0.15, powerTrack: 0.4, viaDrill: 0.3, viaPad: 0.6, edgeClearance: 0.5 }, parts, powerNets: new Set(['GND', 'VCC']), planes, budgetMs: 120_000 });
const ms = performance.now() - t0;
const len = r.tracks.reduce((sum, t) => sum + t.pts.reduce((a, _, i) => (i % 2 === 0 && i + 3 < t.pts.length ? a + Math.hypot(t.pts[i + 2]! - t.pts[i]!, t.pts[i + 3]! - t.pts[i + 1]!) : a), 0), 0);
console.log(`${layers.length}L: ${ms.toFixed(0)} ms, nets ${r.netsDone}/${r.netsTotal}, failed ${r.failed.length}, tracks ${r.tracks.length}, vias ${r.vias.length}, timedOut ${r.timedOut}, length ${len.toFixed(0)} mm`);
console.log('routes', createHash('sha1').update(JSON.stringify([r.tracks, r.vias, r.zones])).digest('hex').slice(0, 12));
