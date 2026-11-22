import { describe, expect, it } from 'vitest';
import { getBuiltinPart } from '@4k7/parts';
import { Kernel } from '../src/index.ts';

type Swaps = { swaps?: { change: string; apply: { op: string; a: string; b: string }[] }[]; swaps_tried?: string };

const ok = (k: Kernel, ops: unknown[]) => {
  const r = k.transact({ summary: 'test', ops } as never);
  expect(r.status, JSON.stringify(r.status === 'rejected' && r.rejection)).toBe('ok');
};
const netOf = (k: Kernel, pin: string) => {
  const d = k.draftDesign();
  const c = Object.values(d.components).find((x) => x.refdes === 'U1')!;
  const n = getBuiltinPart('microchip:ATTINY85-20SU')!.pins.find((p) => p.name === pin.slice(3))!.number;
  return c.pins[n] ? d.nets[c.pins[n]!]!.name : undefined;
};
const refusal = (k: Kernel, a: string, b: string) => {
  const r = k.transact({ summary: 'swap', ops: [{ op: 'swap_pins', a, b }] });
  expect(r.status).toBe('rejected');
  return r.status === 'rejected' ? (r.rejection?.message ?? '') : '';
};

/**
 * An ATtiny85 wired across: its left pins (PB3, PB4) to J1 on the right, its right pins (PB0, PB1)
 * to J2 on the left, PB2 as I²C clock to J2. `needs`: set_net needs of nets by name.
 */
function crossed(needs: Record<string, string[]> = {}) {
  const k = new Kernel();
  ok(k, [
    { op: 'add_part', part: 'microchip:ATTINY85-20SU', refdes: 'U1' },
    { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J1' },
    { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J2' },
    { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '100nF', voltage: '16V' } },
    { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } },
    { op: 'connect', pins: ['J1.1', 'U1.PB3'], net: 'LED' },
    { op: 'connect', pins: ['J1.2', 'U1.PB4'], net: 'SENSE' },
    { op: 'connect', pins: ['J2.1', 'U1.PB0'], net: 'BTN' },
    { op: 'connect', pins: ['J2.2', 'U1.PB1'], net: 'BUZZ' },
    { op: 'connect', pins: ['J2.3', 'U1.PB2'], net: 'SCL' },
    { op: 'connect', pins: ['J1.3', 'J2.4', 'U1.VCC', 'C1.1', 'R1.1'], net: '+5V' },
    { op: 'connect', pins: ['J1.4', 'U1.GND', 'C1.2'], net: 'GND' },
    { op: 'connect', pins: ['R1.2', 'U1.PB5/RESET'], net: 'RESET' },
    { op: 'set_net', net: '+5V', external: true, voltage: 5 },
    ...Object.entries(needs).map(([net, n]) => ({ op: 'set_net', net, needs: n })),
    { op: 'set_board', width_mm: 40, height_mm: 20 },
  ]);
  k.accept();
  return k;
}

describe('swap_pins on MCU GPIOs (ATtiny85)', () => {
  it('swaps two GPIOs once the nets say they need plain digital I/O, or a function both pins offer', () => {
    const k = crossed({ LED: ['GPIO'], SENSE: ['ADC*'], BTN: ['GPIO', 'PCINT*'] });
    // SENSE (an ADC input on PB4's ADC2) goes to PB3's ADC3; LED (plain I/O) to PB4
    ok(k, [{ op: 'swap_pins', a: 'U1.PB3', b: 'U1.PB4' }]);
    expect([netOf(k, 'U1.PB3'), netOf(k, 'U1.PB4')]).toEqual(['SENSE', 'LED']);
    k.reject();
    // BTN (pin-change interrupt) to PB3, LED to PB0
    ok(k, [{ op: 'swap_pins', a: 'U1.PB3', b: 'U1.PB0' }]);
    expect([netOf(k, 'U1.PB3'), netOf(k, 'U1.PB0')]).toEqual(['BTN', 'LED']);
  });

  it('refuses moving a net to a pin without a function it needs, and says which', () => {
    const k = crossed({ LED: ['GPIO'], SENSE: ['ADC*'], BTN: ['GPIO'], BUZZ: ['OC0B'], SCL: ['SCL'] });
    expect(refusal(k, 'U1.PB2', 'U1.PB0')).toMatch(/SCL needs SCL, which U1\.PB0 does not offer \(MOSI, DI, SDA/);
    expect(refusal(k, 'U1.PB4', 'U1.PB0')).toMatch(/SENSE needs ADC\*, which U1\.PB0 does not offer/);
    // OC0B is the timer output of PB1 only: OC0A (PB0) is another output
    expect(refusal(k, 'U1.PB1', 'U1.PB0')).toMatch(/BUZZ needs OC0B/);
    // it checks both ways: LED may go to PB2, but SCL may not come to PB3
    expect(refusal(k, 'U1.PB3', 'U1.PB2')).toMatch(/SCL needs SCL, which U1\.PB3/);
  });

  it('moves a net whose needs are not recorded only between pins offering the same functions (on the ATtiny85: none)', () => {
    const k = crossed({ LED: ['GPIO'] });
    expect(refusal(k, 'U1.PB3', 'U1.PB4')).toMatch(/SENSE would move from U1\.PB4 \(XTAL2, CLKO, OC1B, ADC2, PCINT4\) to U1\.PB3 .*set_net needs/);
    // an unconnected destination: nothing moves back, the net still needs its functions there
    ok(k, [{ op: 'disconnect', pins: ['U1.PB4'] }, { op: 'swap_pins', a: 'U1.PB3', b: 'U1.PB4' }]);
    expect([netOf(k, 'U1.PB3'), netOf(k, 'U1.PB4')]).toEqual([undefined, 'LED']);
  });

  it('keeps reset, power and supply pins out of every group', () => {
    const card = getBuiltinPart('microchip:ATTINY85-20SU')!;
    const members = card.swapGroups!.flatMap((g) => g.members.flat());
    expect(members.sort()).toEqual(['2', '3', '5', '6', '7']);
    expect(Object.keys(card.swapGroups![0]!.functions!).sort()).toEqual(['2', '3', '5', '6', '7']);
    const k = crossed({ LED: ['GPIO'], RESET: ['GPIO'] });
    expect(refusal(k, 'U1.PB5/RESET', 'U1.PB3')).toMatch(/U1\.PB5\/RESET is in no swap group/);
    expect(refusal(k, 'U1.VCC', 'U1.PB3')).toMatch(/in no swap group/);
  });

  it('set_net needs is recorded, shown on the net, and cleared with null', () => {
    const k = crossed({ SENSE: ['ADC*', 'ADC*'] });
    expect(k.committedDesign().nets[Object.values(k.committedDesign().nets).find((n) => n.name === 'SENSE')!.id]!.attrs.needs).toEqual(['ADC*']);
    ok(k, [{ op: 'set_net', net: 'SENSE', needs: null }]);
    expect(Object.values(k.draftDesign().nets).find((n) => n.name === 'SENSE')!.attrs.needs).toBeUndefined();
  });
});

describe('suggest_moves: MCU GPIO swaps', () => {
  const placed = (needs: Record<string, string[]>) => {
    const k = crossed(needs);
    ok(k, [
      { op: 'place', ref: 'U1', x_mm: 20, y_mm: 10, rot: 0 },
      { op: 'place', ref: 'J1', x_mm: 34, y_mm: 10, rot: 0 },
      { op: 'place', ref: 'J2', x_mm: 6, y_mm: 10, rot: 0 },
      { op: 'route' },
    ]);
    k.accept();
    return k;
  };

  it('offers only swaps swap_pins allows: none while the nets record no needs', () => {
    const s = placed({}).query({ op: 'suggest_moves', parts: ['U1'] }) as Swaps;
    expect(s.swaps_tried, JSON.stringify(s)).toMatch(/swap/);
    expect(s.swaps).toEqual([]);
  });

  it('offers the crossed GPIOs swapped once their needs say they may, never the ADC input to a pin without an ADC', () => {
    const k = placed({ LED: ['GPIO'], SENSE: ['ADC*'], BTN: ['GPIO'], BUZZ: ['GPIO'], SCL: ['SCL'] });
    const s = k.query({ op: 'suggest_moves', parts: ['U1'] }) as Swaps;
    expect(s.swaps?.length, JSON.stringify(s)).toBeGreaterThan(0);
    for (const sw of s.swaps!) {
      ok(k, sw.apply);
      expect(['U1.PB3', 'U1.PB4']).toContain(['U1.PB0', 'U1.PB1', 'U1.PB2', 'U1.PB3', 'U1.PB4'].find((p) => netOf(k, p) === 'SENSE'));
      expect(netOf(k, 'U1.PB2')).toBe('SCL');
      k.reject();
    }
  });
});
