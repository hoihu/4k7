/**
 * Pairs and length tuning on a USB pair: two 4-pin headers 28 mm apart (90 Ω, at most 0.1 mm skew),
 * a short wall of GND on the top layer half way (x = 20, from y = 4 to y = 11). Times
 *   - the pair routed together by the route helper (one search for the centre line, the wall in its way),
 *   - the same pair drawn by hand (draw_pair) with a deliberately longer positive leg (a bump of 1 mm),
 *   - tune_length on the shorter leg (the meander to match its partner),
 * and prints what each said. With SHOW=1 also the findings on the copper after.
 *
 *   node --experimental-transform-types packages/kernel/bench/tune.ts
 */
import type { Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';

const header = (): Transaction['ops'] => [
  { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J1' },
  { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J2' },
  { op: 'connect', pins: ['J1.1', 'J2.1'], net: 'VBUS' },
  { op: 'connect', pins: ['J1.2', 'J2.2'], net: 'USB_DP' },
  { op: 'connect', pins: ['J1.3', 'J2.3'], net: 'USB_DN' },
  { op: 'connect', pins: ['J1.4', 'J2.4'], net: 'GND' },
  { op: 'set_net', net: 'VBUS', voltage: 5, external: true },
  { op: 'set_board', layers: 4, width_mm: 40, height_mm: 20 },
  { op: 'set_fab_profile', preset: 'jlcpcb' },
  { op: 'place', ref: 'J1', x_mm: 6, y_mm: 10, rot: 0, lock: true },
  { op: 'place', ref: 'J2', x_mm: 34, y_mm: 10, rot: 0, lock: true },
  { op: 'set_impedance', nets: ['USB_DP', 'USB_DN'], ohms: 90, max_skew_mm: 0.1 },
  { op: 'set_copper_mode', mode: 'drawn', keep: false },
];

const time = <T>(f: () => T): [T, number] => {
  const t0 = performance.now();
  const r = f();
  return [r, performance.now() - t0];
};
const say = (what: string, ms: number, r: ReturnType<Kernel['transact']>) =>
  console.log(`${what}: ${ms.toFixed(0)} ms: ${r.status === 'ok' ? r.results.map((x) => x.effect).join(' | ').slice(0, 420) : JSON.stringify(r.rejection)}`);
const findings = (k: Kernel) => {
  const b = k.board();
  if (process.env.SHOW) for (const x of b.diagnostics.filter((d) => d.severity !== 'info' && d.code !== 'DRC.UNROUTED').slice(0, 8)) console.log(`  ${x.code}: ${x.message.slice(0, 200)}`);
  return `${b.diagnostics.filter((d) => d.code.startsWith('IMP.')).map((d) => d.code).join(', ') || 'no IMP findings'}`;
};

// the pair routed together, round a wall of GND (the helper)
const routed = new Kernel();
routed.transact({ summary: 'board', ops: header() });
routed.transact({ summary: 'wall', ops: [{ op: 'draw_track', from: [20, 4], to: [20, 11], net: 'GND', layer: 'F.Cu', width_mm: 0.3 }] });
const [r1, ms1] = time(() => routed.transact({ summary: 'route', ops: [{ op: 'route', nets: ['USB_DP', 'USB_DN'] }] }));
say('route the pair together', ms1, r1);
console.log(`  after: ${findings(routed)}`);

// a pair drawn by hand with a longer positive leg, tuned to match
const hand = new Kernel();
hand.transact({ summary: 'board', ops: header() });
hand.transact({ summary: 'pair', ops: [{ op: 'draw_pair', from: ['J1.2', 'J1.3'], to: ['J2.2', 'J2.3'], via: [[10, 10], [30, 10]] }] });
const t1 = hand.board().drawn!.tracks.find((t) => t.id === 't1')!;
const [x0, y, x1] = [t1.pts[2]!, t1.pts[3]!, t1.pts[4]!];
hand.transact({ summary: 'longer leg', ops: [{ op: 'edit_copper', ids: ['t1'], via: [[x0, y], [12, y], [13, y - 1], [14, y - 1], [15, y], [x1, y]] }] });
console.log(`longer leg: ${findings(hand)}`);
const [r2, ms2] = time(() => hand.transact({ summary: 'tune', ops: [{ op: 'tune_length', net: 'USB_DN' }] }));
say('tune_length USB_DN to match USB_DP', ms2, r2);
console.log(`  after: ${findings(hand)}`);
