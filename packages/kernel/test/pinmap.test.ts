import { describe, expect, it } from 'vitest';
import type { PartCard } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buck, twoBoards } from './fixtures.ts';

// design_query get_pinmap: which MCU pin does what, traced through mates. See docs/design/ops-api.md §6a.
type Reach = { pin: string; board?: string };
type Crossing = { mate: string; pins: string; boards: [string, string]; problem?: string };
type Entry = { pin: string; name: string; net: string; uses: string[] | 'unknown'; offers: string[]; reaches: Reach[]; crosses?: Crossing[]; flag?: string; text: string };
type Mcu = { ref: string; part: string; board?: string; pins: Entry[]; unused: string[]; header?: string };
type Answer = { mcus: Mcu[]; note?: string; error?: string; code?: string };

const ok = (k: Kernel, ops: unknown[]) => {
  const r = k.transact({ summary: 'test', ops } as never);
  expect(r.status, JSON.stringify(r.status === 'rejected' && r.rejection)).toBe('ok');
};
const pinmap = (k: Kernel, ref?: string, format?: 'json' | 'c') => k.query({ op: 'get_pinmap', ...(ref ? { ref } : {}), ...(format ? { format } : {}) }) as Answer;
const header = (k: Kernel) => pinmap(k, undefined, 'c').mcus[0]!.header!.split('\n');
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

/** An MCU card with RP2040-style pin names (GPIO5, GP7, IO9) and a RUN pin that names no GPIO. */
const rp: PartCard = {
  id: 'acme:RPMCU',
  mpn: 'RPMCU',
  description: 'mcu',
  category: 'ic',
  refPrefix: 'U',
  pins: [
    { number: '1', name: 'IOVDD', type: 'pwr_in' },
    { number: '2', name: 'GND', type: 'pwr_in' },
    { number: '3', name: 'RUN', type: 'in' },
    { number: '7', name: 'GPIO5', type: 'bidir' },
    { number: '9', name: 'GP7', type: 'bidir' },
    { number: '11', name: 'IO9/ADC1', type: 'bidir' },
    { number: '12', name: 'GPIO26_ADC0', type: 'bidir' },
    { number: '13', name: 'GPIO27', type: 'bidir' },
  ],
  params: {},
  provenance: { source: 'datasheet' },
  swapGroups: [{ name: 'GPIOs', members: [['7'], ['9'], ['11'], ['12'], ['13']], functions: { '7': ['SPI0_CSn'], '9': ['UART1_RX'], '11': ['ADC1'], '12': ['ADC0'], '13': [] } }],
};

function rpDesign() {
  const k = new Kernel();
  const d = k.committedDesign();
  d.parts[rp.id] = rp;
  k.load(d);
  ok(k, [
    { op: 'add_part', part: rp.id, refdes: 'U1' },
    { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J1' },
    { op: 'connect', pins: ['U1.1'], net: '+3V3' },
    { op: 'connect', pins: ['U1.2'], net: 'GND' },
    { op: 'connect', pins: ['U1.3', 'J1.1'], net: 'nRESET' },
    { op: 'connect', pins: ['U1.7', 'J1.2'], net: 'led-1' },
    { op: 'connect', pins: ['U1.9', 'J1.3'], net: 'LED_1' },
    { op: 'connect', pins: ['U1.11', 'J1.4'], net: '3v3 sense' },
    { op: 'set_net', net: 'led-1', needs: ['SPI0_CSn'] },
  ]);
  return k;
}

describe('get_pinmap format c: a header for the firmware', () => {
  it('gives the guard and one define per signal pin, with its port on an AVR', () => {
    const k = mcuOnTwoBoards('SCK', ['SCK']);
    const h = header(k);
    const name = k.draftDesign().name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    expect(h).toContain(`#ifndef PINMAP_${name}_U2_H`);
    expect(h).toContain(`#define PINMAP_${name}_U2_H`);
    expect(h.at(-1)).toBe(`#endif /* PINMAP_${name}_U2_H */`);
    expect(h[0]).toContain('U2 (microchip:ATTINY85-20SU)');
    expect(h.join('\n')).toMatch(/generated by 4k7/i);
    expect(h).toContain('#define PIN_SCK 2  /* PB2, pin 7, uses SCK */');
    expect(h).toContain('#define PIN_SCK_PORT B');
    expect(h).toContain('/* Unused GPIOs: PB3 (pin 2), PB4 (pin 3), PB0 (pin 5), PB1 (pin 6) */');
    expect(h.some((l) => l.includes('WARNING'))).toBe(false);
  });

  it('takes the GPIO number from the pin name, and makes the net names valid, unique identifiers', () => {
    const h = header(rpDesign());
    expect(h).toContain('#define PIN_LED_1 5  /* GPIO5, pin 7, uses SPI0_CSn */');
    expect(h).toContain('#define PIN_LED_1_2 7  /* GP7, pin 9, function unknown */');
    expect(h).toContain('#define PIN_3V3_SENSE 9  /* IO9/ADC1, pin 11, function unknown */');
    expect(h).toContain('/* Unused GPIOs: GPIO26_ADC0 (pin 12), GPIO27 (pin 13) */');
    const defines = h.filter((l) => l.startsWith('#define PIN_')).map((l) => l.split(' ')[1]!);
    expect(new Set(defines).size).toBe(defines.length);
    expect(defines.every((x) => /^[A-Z_][A-Z0-9_]*$/.test(x))).toBe(true);
    expect(h.some((l) => l.includes('_PORT'))).toBe(false);
  });

  it('comments the define out where the pin name gives no number, never inventing one', () => {
    const h = header(rpDesign());
    const run = h.filter((l) => l.includes('PIN_NRESET'));
    expect(run).toEqual(['/* #define PIN_NRESET  -- RUN, pin 3, function unknown: the pin name gives no GPIO number */']);
  });

  it('warns above a pin whose trace through the mate is broken, and names the board', () => {
    const h = header(mcuOnTwoBoards('SCK_LED'));
    expect(h[0]).toContain('on board "Main"');
    const i = h.indexOf('#define PIN_SCK 2  /* PB2, pin 7, function unknown */');
    expect(h[i - 1]).toBe('/* WARNING: J4.1 (SCK) meets J5.1 (SCK_LED): two nets joined */');
  });

  it('leaves the answer unchanged without format c', () => {
    const k = mcuOnTwoBoards();
    const plain = pinmap(k);
    expect(plain.mcus[0]!.header).toBeUndefined();
    expect(pinmap(k, undefined, 'json')).toEqual(plain);
    const { header: h, ...rest } = pinmap(k, undefined, 'c').mcus[0]!;
    expect(h).toBeTruthy();
    expect(rest).toEqual(plain.mcus[0]);
    const one = rpDesign();
    expect(pinmap(one, undefined, 'c').mcus[0]!.header).not.toContain('board');
  });
});
