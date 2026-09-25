import type { Transaction } from '@tracewise/schema';

/**
 * 12 V → 3.3 V / 2 A buck with TPS54331. `withBootCap: false` reproduces the classic
 * mistake the semantic checks must catch.
 */
export function buckTransaction(opts: { withBootCap?: boolean } = {}): Transaction {
  const withBoot = opts.withBootCap ?? true;
  return {
    summary: '12V to 3.3V buck converter',
    ops: [
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
      { op: 'add_part', part: 'ti:TPS54331DR', refdes: 'U1' },
      { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10uF', voltage: '25V', package: '1206' } },
      { op: 'add_part', part: 'generic:C', refdes: 'C2', params: { capacitance: '47uF', voltage: '10V', package: '1210' } },
      { op: 'add_part', part: 'generic:C', refdes: 'C3', params: { capacitance: '10nF', voltage: '16V' } },
      { op: 'add_part', part: 'generic:L', refdes: 'L1', params: { inductance: '10uH', current: '3.2A' } },
      { op: 'add_part', part: 'generic:D', refdes: 'D1', params: { mpn: 'B340A', vr: '40V', current: '3A' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '31.6k' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '10.2k' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R3', params: { resistance: '8.2k' } },
      { op: 'add_part', part: 'generic:C', refdes: 'C5', params: { capacitance: '6.8nF', voltage: '16V' } },
      { op: 'connect', pins: ['J1.1', 'U1.VIN', 'C1.1'], net: '+12V' },
      { op: 'connect', pins: ['J1.2', 'U1.GND', 'C1.2', 'C2.2', 'C3.2', 'D1.A', 'R2.2', 'C5.2'], net: 'GND' },
      { op: 'set_net', net: '+12V', external: true, voltage: 12 },
      { op: 'connect', pins: ['U1.PH', 'L1.1', 'D1.K'], net: 'SW' },
      { op: 'connect', pins: ['L1.2', 'C2.1', 'R1.1'], net: '+3V3' },
      { op: 'set_net', net: '+3V3', voltage: 3.3, max_current: 2 },
      { op: 'connect', pins: ['R1.2', 'R2.1', 'U1.VSNS'], net: 'FB' },
      { op: 'connect', pins: ['U1.SS', 'C3.1'], net: 'SS' },
      { op: 'connect', pins: ['U1.COMP', 'R3.1'], net: 'COMP' },
      { op: 'connect', pins: ['R3.2', 'C5.1'] },
      { op: 'no_connect', pins: ['U1.EN'] },
      ...(withBoot
        ? ([
            { op: 'add_part', part: 'generic:C', refdes: 'C4', params: { capacitance: '100nF', voltage: '25V', package: '0402' } },
            { op: 'connect', pins: ['U1.BOOT', 'C4.1'], net: 'BOOT' },
            { op: 'connect', pins: ['C4.2'], net: 'SW' },
          ] as Transaction['ops'])
        : []),
    ],
  };
}
