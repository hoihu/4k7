import { describe, expect, it } from 'vitest';
import { Kernel } from '../src/index.ts';
import { buck, twoBoards } from './fixtures.ts';

// design_query get_pinmap: which MCU pin does what, traced through mates. See docs/design/ops-api.md §6a.
type Reach = { pin: string; board?: string };
type Crossing = { mate: string; pins: string; boards: [string, string]; problem?: string };
type Entry = { pin: string; name: string; net: string; uses: string[] | 'unknown'; offers: string[]; reaches: Reach[]; crosses?: Crossing[]; flag?: string; text: string };
type Mcu = { ref: string; part: string; board?: string; pins: Entry[]; unused: string[] };
type Answer = { mcus: Mcu[]; note?: string; error?: string; code?: string };

const ok = (k: Kernel, ops: unknown[]) => {
  const r = k.transact({ summary: 'test', ops } as never);
  expect(r.status, JSON.stringify(r.status === 'rejected' && r.rejection)).toBe('ok');
};
const pinmap = (k: Kernel, ref?: string) => k.query({ op: 'get_pinmap', ...(ref ? { ref } : {}) }) as Answer;
const entry = (a: Answer, name: string) => a.mcus[0]!.pins.find((p) => p.name === name)!;

/** twoBoards plus an ATtiny85 (U2) on Main whose PB2 goes through J4 ⇄ J5 to R5 on the LED board; `far`: the net on the LED side. */
function mcuOnTwoBoards(far = 'SCK', needs?: string[]) {
  const k = twoBoards();
  ok(k, [
    { op: 'add_part', part: 'microchip:ATTINY85-20SU', refdes: 'U2' },
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J4' },
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J5', sheet: 'LED' },
    { op: 'add_part', part: 'generic:R', refdes: 'R5', params: { resistance: '10k' }, sheet: 'LED' },
    { op: 'connect', pins: ['U2.VCC'], net: '+3V3' },
    { op: 'connect', pins: ['U2.GND', 'J4.2', 'J5.2'], net: 'GND' },
    { op: 'connect', pins: ['U2.PB2', 'J4.1'], net: 'SCK' },
    { op: 'connect', pins: ['J5.1', 'R5.1'], net: far },
    { op: 'connect', pins: ['R5.2'], net: '+3V3' },
    { op: 'mate', a: 'J4', b: 'J5', kind: 'cable' },
    ...(needs ? [{ op: 'set_net', net: 'SCK', needs }] : []),
  ]);
  k.accept();
  return k;
}

describe('get_pinmap on two boards', () => {
  it('traces an MCU pin through the mate to the part on the other board', () => {
    const k = mcuOnTwoBoards();
    const a = pinmap(k);
    const mate = Object.values(k.draftDesign().mates!)[0]!;
    expect(a.mcus.map((m) => [m.ref, m.board])).toEqual([['U2', 'Main']]);
    const e = entry(a, 'PB2');
    expect(e).toMatchObject({
      pin: '7',
      net: 'SCK',
      offers: expect.arrayContaining(['SCK', 'ADC1']),
      reaches: [{ pin: 'R5.1', board: 'LED board' }],
      crosses: [{ mate: mate.id, pins: 'J4.1 ⇄ J5.1', boards: ['Main', 'LED board'] }],
    });
    expect(e.flag).toBeUndefined();
    expect(e.text).toBe('PB2 (pin 7) → SCK (function unknown) → J4.1 ⇄ J5.1 → R5.1 on "LED board"');
    // power and ground pins are left out; the GPIOs on no net are listed as unused
    expect(a.mcus[0]!.pins.map((p) => p.name)).toEqual(['PB2']);
    expect(a.mcus[0]!.unused).toEqual(['PB3 (pin 2)', 'PB4 (pin 3)', 'PB0 (pin 5)', 'PB1 (pin 6)']);
  });

  it('gives the function the net needs, and unknown where no needs are recorded', () => {
    expect(entry(pinmap(mcuOnTwoBoards()), 'PB2').uses).toBe('unknown');
    const e = entry(pinmap(mcuOnTwoBoards('SCK', ['SCK'])), 'PB2');
    expect(e.uses).toEqual(['SCK']);
    expect(e.text).toContain('→ SCK (uses SCK) →');
  });

  it('flags a mate whose far side is on another net', () => {
    const e = entry(pinmap(mcuOnTwoBoards('SCK_LED')), 'PB2');
    expect(e.crosses![0]!.problem).toBe('J4.1 (SCK) meets J5.1 (SCK_LED): two nets joined');
    expect(e.flag).toContain('two nets joined');
    expect(e.reaches).toEqual([]);
    expect(e.text).toContain('⚠');
  });

  it('flags a mate whose far side is on no net', () => {
    const k = mcuOnTwoBoards();
    ok(k, [{ op: 'disconnect', pins: ['J5.1'] }]);
    expect(entry(pinmap(k), 'PB2').crosses![0]!.problem).toBe('J5.1 is on no net: SCK ends at J4.1');
  });

  it('leaves the design untouched', () => {
    const k = mcuOnTwoBoards();
    const before = JSON.stringify(k.draftDesign());
    const history = k.state().history.length;
    pinmap(k);
    pinmap(k, 'U2');
    expect(JSON.stringify(k.draftDesign())).toBe(before);
    expect(k.state().history.length).toBe(history);
    expect(k.state().canUndo).toBe(true);
    expect(k.undo()?.summary).toBe('test');
  });
});

describe('get_pinmap on one board', () => {
  it('answers without board or mate fields', () => {
    const k = buck({ accept: false });
    ok(k, [
      { op: 'add_part', part: 'microchip:ATTINY85-20SU', refdes: 'U2' },
      { op: 'connect', pins: ['U2.VCC'], net: '+3V3' },
      { op: 'connect', pins: ['U2.GND'], net: 'GND' },
      { op: 'add_part', part: 'generic:R', refdes: 'R9', params: { resistance: '10k' } },
      { op: 'connect', pins: ['U2.PB4', 'R9.1'], net: 'SENSE' },
      { op: 'connect', pins: ['R9.2'], net: 'GND' },
      { op: 'set_net', net: 'SENSE', needs: ['ADC2'] },
    ]);
    const a = pinmap(k, 'U2');
    expect(a.mcus[0]!.board).toBeUndefined();
    const e = entry(a, 'PB4');
    expect(e).toMatchObject({ pin: '3', net: 'SENSE', uses: ['ADC2'] });
    expect(e.crosses).toBeUndefined();
    expect(e.reaches.every((r) => r.board === undefined)).toBe(true);
    expect(e.text).toMatch(/^PB4 \(pin 3\) → SENSE \(uses ADC2\) → R9\.1$/);
  });

  it('rejects a ref that is no part, and notes a part that is no MCU or a design without one', () => {
    const k = buck();
    expect(pinmap(k, 'U9')).toMatchObject({ code: 'REF_UNKNOWN' });
    expect(pinmap(k, 'R1')).toMatchObject({ mcus: [], note: expect.stringContaining('R1') });
    expect(pinmap(k)).toMatchObject({ mcus: [], note: expect.stringContaining('No MCU') });
  });
});
