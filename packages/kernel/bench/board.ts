/**
 * Router benchmark on a board built through the kernel (real parts, auto-placement, default
 * planes): the 12 V buck plus clusters of ATtiny85 with LEDs and decoupling, LM358 stages and a
 * 555, on a 10-pin header. Times the route step (routing, pours, copper checks).
 *
 *   node --experimental-transform-types packages/kernel/bench/board.ts [layers 2|4] [clusters 1|2|3] [moves | place]
 *
 * Prints the time, the board stats, the unrouted nets and a hash of the routes. With moves (a
 * number), then moves that many parts in turn, one step each, and routes again after each move,
 * incrementally (keeping the copper that still holds) and from scratch, for comparison. With
 * place: the placement instead, as proposed (small parts refined or not), then try_placements on
 * the main parts as they stand (the kernel improves on them), each routed.
 */
import { createHash } from 'node:crypto';
import type { Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from '../test/fixtures.ts';

const clusters = Number(process.argv[3] ?? 1);
const k = new Kernel();
k.transact(buckTransaction());
const ops: Transaction['ops'] = [];
const conns: Record<string, string[]> = { '+3V3': [], GND: [], SDA: ['J2.1'], SCL: ['J2.2'] };
const add = (net: string, pin: string) => (conns[net] ??= []).push(pin);
const R = (refdes: string, resistance: string) => ops.push({ op: 'add_part', part: 'generic:R', refdes, params: { resistance } });
const C = (refdes: string, capacitance: string, more: Record<string, string> = {}) => ops.push({ op: 'add_part', part: 'generic:C', refdes, params: { capacitance, voltage: '16V', ...more } });

ops.push({ op: 'add_part', part: 'generic:CONN_1x10', refdes: 'J2' });
R('R90', '4.7k');
R('R91', '4.7k');
add('+3V3', 'R90.1');
add('SDA', 'R90.2');
add('+3V3', 'R91.1');
add('SCL', 'R91.2');
add('+3V3', 'J2.9');
add('GND', 'J2.10');
// ATtiny85s on the I2C bus, two LEDs each
for (let u = 0; u < 4 * clusters; u++) {
  const U = `U${10 + u}`;
  ops.push({ op: 'add_part', part: 'microchip:ATTINY85-20SU', refdes: U });
  C(`C${50 + u}`, '100nF', { package: '0402' });
  add('+3V3', `${U}.VCC`);
  add('GND', `${U}.GND`);
  add('+3V3', `C${50 + u}.1`);
  add('GND', `C${50 + u}.2`);
  add('SDA', `${U}.PB0`);
  add('SCL', `${U}.PB2`);
  add(`RST${u}`, `${U}.PB5/RESET`);
  if (u < 4) add(`RST${u}`, `J2.${3 + u}`);
  for (const [i, pin] of ['PB1', 'PB4'].entries()) {
    const n = 100 + u * 2 + i;
    ops.push({ op: 'add_part', part: 'generic:LED', refdes: `D${n}` });
    R(`R${n}`, '330');
    add(`LED${n}`, `${U}.${pin}`);
    add(`LED${n}`, `R${n}.1`);
    add(`LEDA${n}`, `R${n}.2`);
    add(`LEDA${n}`, `D${n}.A`);
    add('GND', `D${n}.K`);
  }
}
// LM358 followers of a divider, each output to an ATtiny
for (let a = 0; a < 2 * clusters; a++) {
  const U = `U${200 + a}`;
  ops.push({ op: 'add_part', part: 'ti:LM358DR', refdes: U });
  C(`C${300 + a}`, '100nF', { package: '0402' });
  add('+3V3', `${U}.V+`);
  add('GND', `${U}.GND`);
  add('+3V3', `C${300 + a}.1`);
  add('GND', `C${300 + a}.2`);
  for (const [s, [o, m, p]] of [['OUTA', 'INA-', 'INA+'], ['OUTB', 'INB-', 'INB+']].entries()) {
    const n = 500 + a * 4 + s * 2;
    R(`R${n}`, '10k');
    R(`R${n + 1}`, '10k');
    add(`FB${n}`, `${U}.${m}`);
    add(`FB${n}`, `${U}.${o}`);
    add(`IN${n}`, `${U}.${p}`);
    add(`IN${n}`, `R${n}.2`);
    add('+3V3', `R${n}.1`);
    add(`IN${n}`, `R${n + 1}.1`);
    add('GND', `R${n + 1}.2`);
    add(`FB${n}`, `U${10 + a * 2 + s}.PB3`);
  }
}
// a 555 clock
ops.push({ op: 'add_part', part: 'ti:NE555DR', refdes: 'U30' });
C('C40', '10uF');
C('C41', '10nF');
R('R70', '10k');
R('R71', '47k');
for (const [net, pin] of [['+3V3', 'U30.VCC'], ['+3V3', 'U30.RESET'], ['GND', 'U30.GND'], ['GND', 'C41.2'], ['CV', 'U30.CONT'], ['CV', 'C41.1'], ['+3V3', 'R70.1'], ['DIS', 'R70.2'], ['DIS', 'U30.DISCH'], ['DIS', 'R71.1'], ['TH', 'R71.2'], ['TH', 'U30.THRES'], ['TH', 'U30.TRIG'], ['TH', 'C40.1'], ['GND', 'C40.2'], ['CLK', 'U30.OUT'], ['CLK', 'J2.7']] as const) add(net, pin);
for (const [net, pins] of Object.entries(conns)) ops.push({ op: 'connect', pins, net });
k.transact({ summary: 'bench board', ops });
if (process.argv[2] === '4') k.transact({ summary: 'layers', ops: [{ op: 'set_board', layers: 4 }] });
k.accept();

if (process.argv[4] === 'place') {
  const routed = (kk: Kernel) => {
    kk.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const t = performance.now();
    const b = kk.board();
    return `routed in ${((performance.now() - t) / 1000).toFixed(1)} s: ${b.stats.unrouted} open, ${Math.round(b.stats.trackLength)} mm of track, ${b.stats.vias} vias, ${b.diagnostics.filter((x) => x.severity === 'error').length} errors`;
  };
  const line = (name: string, kk: Kernel) => {
    const m = kk.boardPlacement();
    console.log(`${name}: ${m.outline.w} × ${m.outline.h} mm, ratsnest ${m.measures.ratsnestMm} mm, ${m.measures.crossings} crossings; ${routed(kk)}`);
  };
  for (const refine of [false, true]) {
    const kk = new Kernel(k.draftDesign());
    kk.transact({ summary: 'propose', ops: [{ op: 'propose_placement', refine }] });
    line(refine ? 'proposed, small parts refined' : 'proposed', kk);
  }
  k.transact({ summary: 'propose', ops: [{ op: 'propose_placement' }] });
  const main = k.boardPlacement().parts.filter((p) => p.pads.length > 3 && !p.componentId.startsWith('hole:')).map((p) => ({ ref: p.refdes, x_mm: p.x, y_mm: p.y, rot: p.rot as 0 | 90 | 180 | 270 }));
  const t = performance.now();
  const r = k.query({ op: 'try_placements', candidates: [{ name: 'as proposed', parts: main }] }) as { options: { parts?: typeof main }[]; explored?: string };
  console.log(`try_placements: ${((performance.now() - t) / 1000).toFixed(1)} s; ${r.explored}`);
  const best = r.options.find((o) => o.parts);
  if (best) {
    const kk = new Kernel(k.draftDesign());
    kk.transact({ summary: 'apply', ops: [{ op: 'propose_placement', parts: best.parts }] });
    line('improved by try_placements', kk);
  }
  process.exit(0);
}

const t0 = performance.now();
k.transact({ summary: 'route', ops: [{ op: 'route' }] });
const b = k.board();
const ms = performance.now() - t0;
console.log(`${b.layers.length}L ${b.outline.w}x${b.outline.h} mm, ${b.parts.length} parts: ${ms.toFixed(0)} ms, ${JSON.stringify(b.stats)}, planes ${b.planes.map((p) => b.netNames[p.netId] + '@' + p.layer).join(' ')}`);
console.log('unrouted:', b.diagnostics.filter((d) => d.code === 'DRC.UNROUTED').map((d) => d.message).join(' | '));
console.log('routes', createHash('sha1').update(JSON.stringify([b.tracks, b.vias, b.zones])).digest('hex').slice(0, 12));

const moves = Number(process.argv[4] ?? 0);
if (moves) {
  k.keepCopper(b.newCopper!);
  // small parts spread over the board, each moved 1.5 mm to the right (or left near the edge)
  const small = b.parts.filter((p) => p.pads.length === 2 && !p.locked);
  for (let m = 0; m < moves; m++) {
    const now = k.board();
    const p = now.parts.find((q) => q.refdes === small[Math.floor(((m + 0.5) * small.length) / moves)]!.refdes)!;
    const dx = p.x + 3 < now.outline.w ? 1.5 : -1.5;
    k.transact({ summary: 'move', ops: [{ op: 'place', ref: p.refdes, x_mm: p.x + dx, y_mm: p.y }, { op: 'route' }] });
    const t1 = performance.now();
    const inc = k.board();
    const incMs = performance.now() - t1;
    // the same placement from scratch: the design without the copper routed before
    const fresh = k.draftDesign();
    delete fresh.board!.copper;
    const t2 = performance.now();
    const full = new Kernel(fresh).board();
    const fullMs = performance.now() - t2;
    const errs = (x: typeof inc) => x.diagnostics.filter((d) => d.severity === 'error' && d.code !== 'DRC.UNROUTED').length;
    console.log(`move ${p.refdes} ${dx > 0 ? '+' : ''}${dx} mm: incremental ${incMs.toFixed(0)} ms (${inc.newCopper!.passes} passes, kept ${inc.newCopper!.reused?.tracks ?? 0} of ${inc.tracks.length} tracks, ${inc.newCopper!.reused?.vias ?? 0} vias), ${inc.stats.unrouted} open, ${errs(inc)} errors | from scratch ${fullMs.toFixed(0)} ms (${full.newCopper!.passes} passes), ${full.stats.unrouted} open, ${errs(full)} errors`);
    for (const d of inc.diagnostics.filter((x) => x.severity === 'error' && x.code !== 'DRC.UNROUTED')) console.log('  ', d.code, d.message, JSON.stringify(d.at));
    k.accept();
    k.keepCopper(inc.newCopper!);
  }
}
