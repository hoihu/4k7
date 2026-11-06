import { describe, expect, it } from 'vitest';
import { Kernel } from '@4k7/kernel';
import type { BoardView } from '@4k7/schema';
import { boardNetDesign, checkFabSet, fabFiles, ipc356, ipcNetDesign, isIpc356, readFabFiles, readIpc356 } from '../src/index.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

function board(): BoardView {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  const r = k.transact({ summary: 'route', ops: [{ op: 'set_board', layers: 4 }, { op: 'route' }] });
  expect(r.status).toBe('ok');
  return k.board();
}

describe('the IPC-D-356A netlist', () => {
  const b = board();
  const text = ipc356(b, 'buck', { stamp: { version: '9.9.9', board: '0123abcd', date: '2026-11-06T22:00:00+01:00' } });
  const lines = text.split('\n').slice(0, -1);

  it('is 80 columns a record, its parameters first and 999 last', () => {
    expect(lines.every((l) => l.length === 80)).toBe(true);
    expect(lines.slice(0, 7).map((l) => l.trimEnd())).toEqual([
      'C  IPC-D-356A netlist of buck, board 0123abcd',
      'C  written by 4k7 9.9.9 on 2026-11-06T22:00:00+01:00',
      'P  JOB   buck',
      'P  CODE  00',
      'P  UNITS CUST 0',
      'P  VER   IPC-D-356A',
      'P  IMAGE PRIMARY',
    ]);
    expect(lines.at(-1)!.trimEnd()).toBe('999');
    expect(isIpc356(text)).toBe(true);
  });

  it('puts every field in its columns: a surface pad, a pad round a hole, a via', () => {
    const at = (re: RegExp) => lines.find((l) => re.test(l))!;
    const col = (l: string, from: number, to: number) => l.slice(from - 1, to);
    // C1.1 on +12V, a 1206 capacitor on the top
    const c1 = b.parts.find((p) => p.refdes === 'C1')!.pads.find((p) => p.number === '1')!;
    const smd = at(/^327\+12V {10}   C1    -1  /);
    expect([col(smd, 1, 3), col(smd, 4, 17).trim(), col(smd, 21, 26).trim(), col(smd, 27, 27), col(smd, 28, 31).trim(), col(smd, 32, 32), col(smd, 33, 38)]).toEqual(['327', '+12V', 'C1', '-', '1', ' ', '      ']);
    expect([col(smd, 39, 41), col(smd, 72, 72), col(smd, 73, 74), col(smd, 75, 80)]).toEqual(['A01', ' ', 'S2', '      ']);
    const dmil = (mm: number) => Math.round(mm / 0.00254);
    expect(Number(col(smd, 43, 49))).toBe(dmil(c1.x));
    expect(Number(col(smd, 51, 57))).toBe(dmil(b.outline.h - c1.y));
    expect([Number(col(smd, 59, 62)), Number(col(smd, 64, 67)), col(smd, 68, 71)]).toEqual([dmil(c1.w), dmil(c1.h), 'R000']);
    // J1's pins: through-hole, reached from both sides, the hole plated, no mask on either side
    const tht = at(/^317\S* +J1    -1/);
    expect([col(tht, 33, 33), col(tht, 38, 38), col(tht, 39, 41), col(tht, 73, 74)]).toEqual(['D', 'P', 'A00', 'S0']);
    // a via: a midpoint, no designator's pin, tented
    const via = at(/^317\S* +VIA {8}M/);
    expect([col(via, 21, 26).trim(), col(via, 27, 31).trim(), col(via, 32, 32), col(via, 73, 74), Number(col(via, 64, 67))]).toEqual(['VIA', '', 'M', 'S3', 0]);
    expect(Number(col(via, 34, 37))).toBe(dmil(b.vias[0]!.drill));
  });

  it('reads back as the board: every pad and via, with its net, where it is', () => {
    const read = readIpc356(text);
    expect(read.notes).toEqual([]);
    expect(read.job).toBe('buck');
    const pads = b.parts.flatMap((p) => p.pads.filter((q) => !q.npth).map((q) => ({ name: `${p.refdes}.${q.number}`, q })));
    const design = ipcNetDesign(read, b.layers);
    expect(design.pads.length).toBe(pads.length);
    expect(design.vias.length).toBe(b.vias.length);
    for (const { name, q } of pads) {
      const r = design.pads.find((p) => p.name === name)!;
      expect(r.net).toBe(q.netId ? b.netNames[q.netId] : null);
      expect(Math.abs(r.x - q.x)).toBeLessThan(0.0013);
      expect(Math.abs(r.y - (b.outline.h - q.y))).toBeLessThan(0.0013);
    }
  });

  it('gives a net with a long name, or one that only differs in case, an alias the file spells out', () => {
    const ids = Object.keys(b.netNames);
    const renamed: BoardView = { ...b, netNames: { ...b.netNames, [ids[0]!]: 'a_supply_rail_with_a_long_name', [ids[1]!]: 'vcc', [ids[2]!]: 'VCC' } };
    const t = ipc356(renamed, 'buck');
    const nn = t.split('\n').filter((l) => l.startsWith('P  NNAME'));
    expect(nn.map((l) => l.slice(14).trimEnd()).sort()).toEqual(['VCC', 'a_supply_rail_with_a_long_name', 'vcc']);
    expect(nn.every((l) => /^P {2}NNAMEN\d{4} /.test(l))).toBe(true);
    const back = new Set(readIpc356(t).points.map((p) => p.net));
    for (const n of ['a_supply_rail_with_a_long_name', 'vcc', 'VCC']) expect(back.has(n)).toBe(true);
  });

  it('holds the Gerbers it came with the same way the board does', () => {
    const files = fabFiles(b, 'buck');
    const set = readFabFiles(files);
    const layers = set.files.filter((f) => f.layer.kind === 'copper').map((f) => f.layer.id);
    const ipc = files.find((f) => f.name === 'buck-IPC356.ipc')!.content;
    const byNetlist = checkFabSet(set, ipcNetDesign(readIpc356(ipc), layers), { fresh: true })!;
    const byBoard = checkFabSet(set, boardNetDesign(b), { fresh: true })!;
    expect(byNetlist.findings.map((f) => f.kind)).toEqual(byBoard.findings.map((f) => f.kind));
    expect([byNetlist.found, byNetlist.total]).toEqual([byBoard.found, byBoard.total]);
  });
});
