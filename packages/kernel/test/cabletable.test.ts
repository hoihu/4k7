import { describe, expect, it } from 'vitest';
import { Kernel } from '../src/index.ts';
import { buck, twoBoards } from './fixtures.ts';

// The design document's cable table: both ends of each cable or wire mate, pin to pin with the nets. See docs/design/multi-board.md §4.
const ok = (k: Kernel, ops: unknown[]) => {
  const r = k.transact({ summary: 'test', ops } as never);
  expect(r.status, JSON.stringify(r.status === 'rejected' && r.rejection)).toBe('ok');
};
const pins = (k: Kernel) => k.cableTable()[0]!.rows.map((r) => `${r.a.number}↔${r.b.number}`);

describe('cable table: the sheet for whoever makes or buys the cable', () => {
  it('lists a straight cable with both ends, their boards, the nets pin to pin and the length', () => {
    const k = twoBoards();
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'cable', length_mm: 150 }]);
    const t = k.cableTable();
    expect(t).toHaveLength(1);
    const c = t[0]!;
    expect(c).toMatchObject({ kind: 'cable', cable: 'straight', length_mm: 150 });
    expect(c.a).toMatchObject({ refdes: 'J2', part: 'generic:CONN_1x2', board: 'Main' });
    expect(c.b).toMatchObject({ refdes: 'J3', part: 'generic:CONN_1x2', board: 'LED board' });
    expect(pins(k)).toEqual(['1↔1', '2↔2']);
    expect(c.rows.map((r) => r.net)).toEqual(['+3V3', 'GND']);
    expect(c.rows.some((r) => r.mismatch)).toBe(false);
  });

  it('turns a reversed FFC over and reports the nets it joins, not hiding them', () => {
    const k = twoBoards();
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'cable', cable: 'reversed' }]);
    const c = k.cableTable()[0]!;
    expect(c.cable).toBe('reversed');
    expect(c.length_mm).toBeUndefined();
    expect(pins(k)).toEqual(['1↔2', '2↔1']);
    expect(c.rows[0]).toMatchObject({ net: '+3V3', mismatch: { net: 'GND' } });
    expect(c.rows[1]).toMatchObject({ net: 'GND', mismatch: { net: '+3V3' } });
  });

  it('says where the far pin is on no net', () => {
    const k = twoBoards();
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'cable' }, { op: 'disconnect', pins: ['J3.2'] }]);
    expect(k.cableTable()[0]!.rows[1]).toMatchObject({ net: 'GND', mismatch: { net: null } });
  });

  it('includes wires, in the order of A\'s pins', () => {
    const k = twoBoards();
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'wire', map: [['2', '2'], ['1', '1']] }]);
    const c = k.cableTable()[0]!;
    expect(c.kind).toBe('wire');
    expect(c.cable).toBeUndefined();
    expect(pins(k)).toEqual(['1↔1', '2↔2']);
  });

  it('leaves stacked boards out, and is empty without mates', () => {
    const k = twoBoards();
    expect(k.cableTable()).toEqual([]);
    ok(k, [{ op: 'mate', a: 'J2', b: 'J3', kind: 'stack' }]);
    expect(k.cableTable()).toEqual([]);
    expect(buck().cableTable()).toEqual([]);
  });
});
