/**
 * Drawn copper on the router benchmark's board (board.ts, same parts and placement): how long the
 * board view takes with the copper drawn (pours and connectivity, nothing routed), and the route
 * helper on every open connection, against the router.
 *
 *   node --experimental-transform-types packages/kernel/bench/drawn.ts [layers 2|4] [clusters 1|2|3]
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

const time = <T>(f: () => T): [T, number] => {
  const t0 = performance.now();
  const r = f();
  return [r, performance.now() - t0];
};
const view = (kk: Kernel) => time(() => kk.board());
const line = (what: string, b: ReturnType<Kernel['board']>, ms: number) =>
  console.log(`${what}: ${ms.toFixed(0)} ms, ${b.drawn?.tracks.length ?? b.tracks.length} tracks, ${b.drawn?.vias.length ?? b.vias.length} vias, ${b.unrouted.length} open, ${b.diagnostics.filter((x) => x.severity === 'error').length} errors, ${b.diagnostics.filter((x) => x.severity === 'warning').length} warnings`);

// the router, for comparison
const routed = new Kernel(k.committedDesign());
routed.transact({ summary: 'route', ops: [{ op: 'route' }] });
const [rb, rms] = view(routed);
line('router', rb, rms);

// drawn, empty: the view routes nothing
const empty = new Kernel(k.committedDesign());
empty.transact({ summary: 'drawn', ops: [{ op: 'set_copper_mode', mode: 'drawn', keep: false }] });
const [eb, ems] = view(empty);
line('drawn, empty', eb, ems);

// the helper on every open connection, then the view of what it drew
const [res, hms] = time(() => empty.transact({ summary: 'helper', ops: [{ op: 'route' }] }));
console.log(`helper: ${hms.toFixed(0)} ms: ${res.status === 'ok' ? res.results[0]!.effect.slice(0, 300) : JSON.stringify(res)}`);
const [hb, hvms] = view(empty);
line('drawn, after the helper', hb, hvms);

// the router's copper taken over
routed.keepCopper(rb.newCopper!);
routed.accept();
routed.transact({ summary: 'take over', ops: [{ op: 'set_copper_mode', mode: 'drawn' }] });
const [tb, tms] = view(routed);
line('drawn, taken over from the router', tb, tms);
// SHOW=1: the warnings on the copper taken over
if (process.env.SHOW) for (const x of tb.diagnostics.filter((x) => x.severity === 'warning').slice(0, 8)) console.log(`  ${x.code}: ${x.message}`);

// a part moved on the copper taken over: the copper by it follows (followParts) and is checked
const u = tb.parts.find((p) => p.refdes === 'U10')!;
const [mv, mms] = time(() => routed.transact({ summary: 'move', ops: [{ op: 'place', ref: 'U10', x_mm: u.x + 0.5, y_mm: u.y + 0.5 }] }));
console.log(`move U10 by 0.5, 0.5 mm: ${mms.toFixed(0)} ms: ${mv.status === 'ok' ? mv.results[0]!.effect.slice(0, 300) : JSON.stringify(mv)}`);
const [mb, mbms] = view(routed);
line('drawn, after the move', mb, mbms);
if (process.env.SHOW) for (const x of mb.diagnostics.filter((x) => x.severity !== 'info').slice(0, 8)) console.log(`  ${x.code}: ${x.message}`);
