import { afterAll, describe, expect, it } from 'vitest';
import { draftToCard, registerUserParts, unregisterUserPart } from '@4k7/parts';
import { Kernel } from '../src/index.ts';

const codes = (k: Kernel) => k.state().diagnostics.filter((d) => !d.waivedBy).map((d) => `${d.code} ${d.entities.join(',')}`);

/**
 * A 32 V LDO whose EN pin is rated far lower than its input, as imported from its datasheet
 * (the TPS709 of the dynamo bike lamp: IN 32 V, EN 6.5 V).
 */
const { card } = draftToCard({
  mpn: 'LDO32-TEST',
  manufacturer: 'Test Semi',
  description: 'LDO regulator, 32 V in, 3.3 V out, SOT-23-5',
  package: { name: 'SOT-23-5', family: 'SOT', pins: 5, pitch_mm: 0.95, body_mm: [1.6, 2.9], span_mm: [2.8, 2.9], lead_length_mm: 0.45, lead_width_mm: 0.4 },
  pins: [
    { number: '1', name: 'IN', type: 'pwr_in', page: 3 },
    { number: '2', name: 'GND', type: 'pwr_in', page: 3 },
    { number: '3', name: 'EN', type: 'in', max_v: 6.5, page: 3 },
    { number: '4', name: 'NC', type: 'nc', page: 3 },
    { number: '5', name: 'OUT', type: 'pwr_out', page: 3 },
  ],
  supply_max_v: 32,
});
registerUserParts([card!]);
afterAll(() => unregisterUserPart(card!.id));

describe('pin voltage limits of imported parts', () => {
  it('flags a regulator EN pin tied straight to a rail above its own limit', () => {
    const k = new Kernel();
    const r = k.transact({
      summary: 'ldo',
      ops: [
        { op: 'add_part', part: card!.id, refdes: 'U2' },
        { op: 'connect', pins: ['U2.IN', 'U2.EN'], net: 'VDC' },
        { op: 'connect', pins: ['U2.GND'], net: 'GND' },
        { op: 'connect', pins: ['U2.OUT'], net: '+3V3' },
        { op: 'set_net', net: 'VDC', external: true, voltage: 12 },
      ],
    } as never);
    expect(r.status).toBe('ok');
    expect(codes(k)).toContain('SEM.ABS_MAX U2.EN');
    expect(codes(k)).not.toContain('SEM.ABS_MAX U2.IN');
  });

  it('gives the supply limit to supply pins and the pin\'s own limit where the datasheet states one', () => {
    const max = Object.fromEntries(card!.pins.map((p) => [p.name, p.maxVoltage]));
    expect(max).toEqual({ IN: 32, GND: undefined, EN: 6.5, NC: undefined, OUT: undefined });
  });
});
