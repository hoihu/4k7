import { describe, expect, it } from 'vitest';
import type { Kernel } from '@4k7/kernel';
import { bom, combinedBom } from '../src/index.ts';
import { buck, twoBoards } from '../../kernel/test/fixtures.ts';

/** Every board of the design with its name, as the app hands them to combinedBom. */
const boards = (k: Kernel) => k.boardList().map((b) => ({ name: b.name, b: k.boardPlacement(b.id) }));
const rows = (csv: string) => csv.trim().split('\n').slice(1);
const line = (csv: string, ref: string) => rows(csv).find((r) => new RegExp(`(^|[,"])${ref}([,"]|$)`).test(r));

/** twoBoards with a 1k resistor on the main board too (R5, the same part as R4 on the LED board) and C3 not fitted. See docs/design/multi-board.md §4. */
function design() {
  const k = twoBoards();
  const r = k.transact({
    summary: 'a 1k on the main board, C3 not fitted',
    ops: [
      { op: 'add_part', part: 'generic:R', refdes: 'R5', params: { resistance: '1k' } },
      { op: 'connect', pins: ['R5.1', 'R5.2'], net: '+3V3' },
      { op: 'set_dnp', refs: ['C3'], dnp: true },
    ],
  });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  return k;
}

describe('the combined BOM of a design of several boards', () => {
  const k = design();
  const csv = combinedBom(boards(k), 'design')!.content;

  it('is named after the design and has the per-board BOM columns and a Boards column', () => {
    const file = combinedBom(boards(k), 'my lamp')!;
    expect(file.name).toBe('my_lamp-combined-bom.csv');
    expect(csv.split('\n')[0]).toBe('Comment,Designator,Footprint,Quantity,MPN,Manufacturer,LCSC Part #,Boards');
  });

  it('a part on both boards is one line: the total and each board’s quantity', () => {
    expect(line(csv, 'R4')).toBe(line(csv, 'R5'));
    expect(line(csv, 'R4')).toMatch(/^1k,"R4,R5",[^,]*,2,.*,"Main×1, LED board×1"$/);
  });

  it('a part on one board names that board only', () => {
    expect(line(csv, 'L1')).toMatch(/,Main×1$/);
    expect(line(csv, 'D2')).toMatch(/,LED board×1$/);
    // the two headers J1, J2 on the main board, J3 on the LED board: one line
    expect(line(csv, 'J1')).toMatch(/"J1,J2,J3",[^,]*,3,.*"Main×2, LED board×1"$/);
  });

  it('leaves out a part not fitted, as the per-board BOM does', () => {
    expect(csv).not.toMatch(/\bC3\b/);
    expect(bom(k.boardPlacement(k.boardList()[0]!.id))).not.toMatch(/\bC3\b/);
  });

  it('lists every fitted part of every board once', () => {
    const refs = (s: string) => rows(s).flatMap((r) => (r.match(/^[^,]*,("[^"]*"|[^,]*)/)![1]!.replace(/"/g, '').split(',')));
    const each = boards(k).flatMap((x) => refs(bom(x.b)));
    expect(refs(csv).sort()).toEqual(each.sort());
  });

  it('is not made for a design of one board', () => {
    const one = buck();
    expect(combinedBom(boards(one), 'buck')).toBeNull();
  });
});

/** twoBoards joined J2↔J3 by the mate op given (cable, wire or stack). See docs/design/multi-board.md §4. */
function mated(mate: Record<string, unknown>) {
  const k = twoBoards();
  const r = k.transact({ summary: 'join the boards', ops: [{ op: 'mate', a: 'J2', b: 'J3', ...mate }] } as never);
  expect(r.status, JSON.stringify(r.status === 'rejected' && r.rejection)).toBe('ok');
  return k;
}
const last = (csv: string) => rows(csv).at(-1)!;

describe('cables in the combined BOM', () => {
  it('a straight cable is one line after the parts, which are unchanged', () => {
    const k = mated({ kind: 'cable', length_mm: 150 });
    const without = combinedBom(boards(k), 'design')!.content;
    const csv = combinedBom(boards(k), 'design', 'jlcpcb', k.cableTable())!.content;
    expect(rows(csv).slice(0, -1)).toEqual(rows(without));
    expect(rows(csv)).toHaveLength(rows(without).length + 1);
    expect(last(csv)).toBe('"Cable, 2 wires, 150 mm",J2–J3,,1,,,,J2 (Main) ↔ J3 (LED board)');
  });

  it('a reversed cable without a length says so', () => {
    const k = mated({ kind: 'cable', cable: 'reversed' });
    expect(last(combinedBom(boards(k), 'design', 'jlcpcb', k.cableTable())!.content)).toMatch(/^"Cable, reversed, 2 wires, length not set",J2–J3,/);
  });

  it('wires are described as wires', () => {
    const k = mated({ kind: 'wire', map: [['1', '1'], ['2', '2']], length_mm: 80 });
    expect(last(combinedBom(boards(k), 'design', 'jlcpcb', k.cableTable())!.content)).toMatch(/^"Wire, 2 wires, 80 mm",J2–J3,/);
  });

  it('stacked boards, no cables and an empty list: the BOM as before', () => {
    const k = mated({ kind: 'stack' });
    const before = combinedBom(boards(k), 'design')!.content;
    expect(k.cableTable()).toEqual([]);
    expect(combinedBom(boards(k), 'design', 'jlcpcb', k.cableTable())!.content).toBe(before);
    expect(combinedBom(boards(k), 'design', 'jlcpcb', [])!.content).toBe(before);
    expect(combinedBom(boards(k), 'design', 'jlcpcb', undefined)!.content).toBe(before);
  });

  it('each house has the cable line in its own columns', () => {
    const k = mated({ kind: 'cable', length_mm: 150 });
    const ec = combinedBom(boards(k), 'design', 'eurocircuits', k.cableTable())!.content;
    expect(ec.split('\n')[0]).toBe('Reference Designators,Quantity,MPN,Manufacturer,Description,Value,Package,Boards');
    expect(last(ec)).toBe('J2–J3,1,,,"Cable, 2 wires, 150 mm",,,J2 (Main) ↔ J3 (LED board)');
    const pw = combinedBom(boards(k), 'design', 'pcbway', k.cableTable())!.content;
    const n = rows(combinedBom(boards(k), 'design', 'pcbway')!.content).length;
    expect(last(pw)).toBe(`${n + 1},J2–J3,1,,,"Cable, 2 wires, 150 mm",,,J2 (Main) ↔ J3 (LED board)`);
  });

  it('a design of one board still has none', () => {
    expect(combinedBom(boards(buck()), 'buck', 'jlcpcb', [])).toBeNull();
  });
});
