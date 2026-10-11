/**
 * Router benchmark on a saved design (a .twd.json file): times its route step.
 *
 *   node --experimental-transform-types packages/kernel/bench/design.ts <file.twd.json> [layers 2|4]
 *
 * Prints the time, the board stats, the unrouted nets and a hash of the routes.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Kernel } from '../src/index.ts';

const k = new Kernel(JSON.parse(readFileSync(process.argv[2]!, 'utf8')));
if (process.argv[3]) k.transact({ summary: 'layers', ops: [{ op: 'set_board', layers: Number(process.argv[3]) as 2 | 4 }] });
const t0 = performance.now();
k.transact({ summary: 'route', ops: [{ op: 'route' }] });
const b = k.board();
const ms = performance.now() - t0;
console.log(`${b.layers.length}L ${b.outline.w}x${b.outline.h} mm, ${b.parts.length} parts, ${b.parts.reduce((n, p) => n + p.pads.length, 0)} pads: ${ms.toFixed(0)} ms, ${JSON.stringify(b.stats)}, planes ${b.planes.map((p) => b.netNames[p.netId] + '@' + p.layer).join(' ')}`);
console.log('unrouted:', b.diagnostics.filter((d) => d.code === 'DRC.UNROUTED').map((d) => d.message).join(' | '));
console.log('routes', createHash('sha1').update(JSON.stringify([b.tracks, b.vias, b.zones])).digest('hex').slice(0, 12));
