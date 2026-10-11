/**
 * Offline demo scenarios for the ScriptedProvider. They exercise the real loop: the
 * kernel validates every op and the verification loop catches a deliberate omission.
 */
import type { Transaction } from '@4k7/schema';
import type { Block, Message } from './types.ts';
import type { Script } from './providers/scripted.ts';

const tool = (name: string, input: unknown): Block => ({ type: 'tool_use', id: '', name, input });
const text = (t: string): Block => ({ type: 'text', text: t });

function lastResult(messages: Message[], key: string): Record<string, string> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const b of messages[i]!.content) {
      if (b.type === 'tool_result' && b.content.includes(`"${key}"`)) {
        try {
          return JSON.parse(b.content) as Record<string, string>;
        } catch {
          /* not JSON */
        }
      }
    }
  }
  return undefined;
}

function lastAnswer(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const b of messages[i]!.content) {
      if (b.type === 'tool_result' && b.content.startsWith('The user answered:')) return b.content;
    }
  }
  return '';
}

const buck: Script = {
  name: 'buck',
  match: /buck|3[.,]3\s*v|3v3/i,
  steps: [
    [text('I will build a 12 V → 3.3 V buck around the TPS54331. First the part and the numbers.'), tool('design_query', { op: 'search_parts', text: 'buck converter' })],
    [
      tool('calc', { fn: 'divider', args: { vout: 3.3, vref: 0.8 } }),
      tool('calc', { fn: 'buck', args: { vin: 12, vout: 3.3, iout: 2, fsw: '570kHz' } }),
    ],
    ({ messages }) => {
      const b = lastResult(messages, 'l_suggested');
      return [
        tool('ask_user', {
          question: `The inductor needs ≥ ${b?.l_suggested ?? '10µH'} and ≥ ${b?.inductor_sat_current_min ?? '3A'} saturation. Which size?`,
          options: ['6×6 mm, 3.2 A (recommended)', '4×4 mm, 2.4 A (smaller, less margin)'],
        }),
      ];
    },
    ({ messages, userText }) => {
      const div = lastResult(messages, 'r_top');
      const b = lastResult(messages, 'l_suggested');
      const small = /4\s*[x×]\s*4/.test(lastAnswer(messages));
      const hint = /\bC1\b[^.]*\bleft\b/i.exec(userText);
      const tx: Transaction = {
        summary: '12 V → 3.3 V / 2 A buck converter',
        ops: [
          { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1', params: { mpn: 'terminal block 5.08mm' } },
          { op: 'add_part', part: 'ti:TPS54331DR', refdes: 'U1' },
          { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10uF', voltage: '25V', dielectric: 'X7R', package: '1206' } },
          { op: 'add_part', part: 'generic:C', refdes: 'C2', params: { capacitance: '47uF', voltage: '10V', dielectric: 'X5R', package: '1210' } },
          { op: 'add_part', part: 'generic:C', refdes: 'C3', params: { capacitance: '10nF', voltage: '16V', package: '0402' } },
          { op: 'add_part', part: 'generic:L', refdes: 'L1', params: { inductance: b?.l_suggested ?? '10uH', current: small ? '2.4A' : '3.2A', package: small ? '4x4mm' : '6x6mm' } },
          { op: 'add_part', part: 'generic:D', refdes: 'D1', params: { mpn: 'B340A', vr: '40V', current: '3A', package: 'SMA' } },
          { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: div?.r_top ?? '31.6k', tolerance: '1%' } },
          { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: div?.r_bottom ?? '10.2k', tolerance: '1%' } },
          { op: 'add_part', part: 'generic:R', refdes: 'R3', params: { resistance: '8.2k' } },
          { op: 'add_part', part: 'generic:C', refdes: 'C5', params: { capacitance: '6.8nF', voltage: '16V' } },
          { op: 'connect', pins: ['J1.1', 'U1.VIN', 'C1.1'], net: '+12V' },
          { op: 'set_net', net: '+12V', external: true, voltage: 12 },
          { op: 'connect', pins: ['J1.2', 'U1.GND', 'C1.2', 'C2.2', 'C3.2', 'D1.A', 'R2.2', 'C5.2'], net: 'GND' },
          { op: 'connect', pins: ['U1.PH', 'L1.1', 'D1.K'], net: 'SW' },
          { op: 'connect', pins: ['L1.2', 'C2.1', 'R1.1'], net: '+3V3' },
          { op: 'set_net', net: '+3V3', voltage: 3.3, max_current: 2 },
          { op: 'connect', pins: ['R1.2', 'R2.1', 'U1.VSNS'], net: 'FB' },
          { op: 'connect', pins: ['U1.SS', 'C3.1'], net: 'SS' },
          { op: 'connect', pins: ['U1.COMP', 'R3.1'], net: 'COMP' },
          { op: 'connect', pins: ['R3.2', 'C5.1'] },
          { op: 'no_connect', pins: ['U1.EN'] },
          ...(hint ? [{ op: 'constrain' as const, kind: 'left_of' as const, a: 'C1', b: 'U1', strength: 'soft' as const, quote: hint[0] }] : []),
        ],
      };
      return [text(`Divider ${div?.r_top}/${div?.r_bottom} gives ${div?.vout_actual} V. Adding the converter.`), tool('design_edit', tx)];
    },
    [text('The converter is in place: input cap, soft-start, compensation, inductor, catch diode and feedback divider.')],
    // after the kernel's verification message
    [
      text('The kernel is right: the datasheet requires 100 nF from BOOT to PH. Adding it.'),
      tool('design_edit', {
        summary: 'Bootstrap capacitor',
        ops: [
          { op: 'add_part', part: 'generic:C', refdes: 'C4', params: { capacitance: '100nF', voltage: '25V', package: '0402' } },
          { op: 'connect', pins: ['U1.BOOT', 'C4.1'], net: 'BOOT' },
          { op: 'connect', pins: ['C4.2'], net: 'SW' },
        ],
      }),
    ],
    [text('Done. The design is ERC-clean. U1.EN is left floating on purpose (internal pull-up); add a UVLO divider if you need a turn-on threshold.')],
  ],
};

const valueHint: Script = {
  name: 'value-hint',
  match: /\b(?:make|set)\s+[A-Z]+\d+\s+(?:to\s+)?[\d.,]+\s*[pnuµmkM]?[FHΩRV]?\b/i,
  steps: [
    ({ userText }) => {
      const m = /\b(?:make|set)\s+([A-Z]+\d+)\s+(?:to\s+)?([\d.,]+\s*[pnuµmkM]?)([FHΩRV]?)\b/i.exec(userText)!;
      const ref = m[1]!.toUpperCase();
      const unit = (m[3] ?? '').toUpperCase();
      const key = unit === 'F' || ref.startsWith('C') ? 'capacitance' : unit === 'H' || ref.startsWith('L') ? 'inductance' : 'resistance';
      const value = `${m[2]!.replace(/\s/g, '')}${unit === 'F' ? 'F' : unit === 'H' ? 'H' : ''}`;
      return [
        tool('design_edit', {
          summary: `${ref} ${key} ${value}`,
          ops: [
            { op: 'set_param', ref, params: { [key]: value } },
            { op: 'constrain', kind: 'param', a: ref, key, value, strength: 'hard', quote: m[0] },
          ],
        }),
      ];
    },
    [text('Updated and pinned in the ledger as a hard constraint.')],
  ],
};

export const DEMO_SCRIPTS: Script[] = [valueHint, buck];

export const DEMO_FALLBACK =
  'This is the offline demo: it only knows two scripted scenarios. Try “12 V to 3.3 V buck, 2 A, put C1 left of U1”, then “make C2 100uF”. ' +
  'Add your own API key in Settings to use a real model.';
