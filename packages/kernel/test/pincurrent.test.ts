import { afterAll, describe, expect, it } from 'vitest';
import { draftToCard, registerUserParts, unregisterUserPart } from '@4k7/parts';
import type { Diagnostic, Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';

/** An MCU whose GPIO PA0 is rated 12 mA by its datasheet and whose PA1 has no stated limit. */
const { card } = draftToCard({
  mpn: 'MCU12MA-TEST',
  manufacturer: 'Test Semi',
  description: 'Small MCU, 3.3 V, SOT-23-5',
  package: { name: 'SOT-23-5', family: 'SOT', pins: 5, pitch_mm: 0.95, body_mm: [1.6, 2.9], span_mm: [2.8, 2.9], lead_length_mm: 0.45, lead_width_mm: 0.4 },
  pins: [
    { number: '1', name: 'VDD', type: 'pwr_in' },
    { number: '2', name: 'GND', type: 'pwr_in' },
    { number: '3', name: 'PA0', type: 'bidir', max_ma: 12 },
    { number: '4', name: 'PA1', type: 'bidir' },
    { number: '5', name: 'NC', type: 'nc' },
  ],
});
registerUserParts([card!]);
afterAll(() => unregisterUserPart(card!.id));

/** U1's pin drives an LED through R1; the LED's current is stated as R1.1's load. */
function led(amps: number, pin = 'PA0', rail = false): Diagnostic[] {
  const k = new Kernel();
  const tx: Transaction = {
    summary: 'GPIO LED',
    ops: [
      { op: 'add_part', part: card!.id, refdes: 'U1' },
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '100' } },
      { op: 'add_part', part: 'generic:LED', refdes: 'D1' },
      { op: 'connect', pins: ['U1.VDD'], net: '+3V3' },
      { op: 'connect', pins: ['U1.GND', 'D1.K'], net: 'GND' },
      { op: 'connect', pins: [`U1.${pin}`, 'R1.1'], net: 'LED_DRV' },
      { op: 'connect', pins: ['R1.2', 'D1.A'], net: 'LED_A' },
      { op: 'set_net', net: '+3V3', voltage: 3.3, loads: [{ pin: 'U1.VDD', amps: 0.05 }] },
      { op: 'set_net', net: 'LED_DRV', loads: [{ pin: 'R1.1', amps }], ...(rail ? { power: true, voltage: 3.3 } : {}) },
    ],
  };
  const r = k.transact(tx);
  expect(r.status, JSON.stringify(r)).toBe('ok');
  return k.state().diagnostics.filter((x) => x.code === 'SEM.PIN_CURRENT');
}

describe('SEM.PIN_CURRENT', () => {
  it('carries the datasheet limit onto the card in amps', () => {
    expect(card!.pins.find((p) => p.name === 'PA0')?.maxCurrent).toBe(0.012);
    expect(card!.pins.find((p) => p.name === 'PA1')?.maxCurrent).toBeUndefined();
  });

  it('is an error for a 12 mA GPIO driving a 30 mA LED, naming part, pin, current, limit and the fix', () => {
    const [f, ...more] = led(0.03);
    expect(more).toEqual([]);
    expect(f).toMatchObject({ severity: 'error', entities: ['U1.PA0', 'net:LED_DRV'] });
    for (const s of ['U1', 'PA0', '30 mA', '12 mA', 'transistor']) expect(f!.message).toContain(s);
  });

  it('says nothing at 10 mA, warns between the limit and twice it, and is an error over twice it', () => {
    expect(led(0.01)).toEqual([]);
    expect(led(0.015)).toMatchObject([{ severity: 'warning' }]);
    expect(led(0.025)).toMatchObject([{ severity: 'error' }]);
  });

  it('says nothing for a pin without a stated limit', () => {
    expect(led(0.03, 'PA1')).toEqual([]);
  });

  it('leaves power rails to the current checks: a supply pin with loads gives no finding', () => {
    expect(led(0.03, 'PA0', true)).toEqual([]);
  });
});
