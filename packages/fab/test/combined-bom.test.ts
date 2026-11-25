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
