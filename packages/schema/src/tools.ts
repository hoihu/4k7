/**
 * Agent tool surface, generated from the op catalogue. The same definitions will back
 * the MCP server in tools/bridge (M4).
 */
import { z } from 'zod';
import { QueryOp, Transaction } from './ops.ts';

export const CalcCall = z.object({
  fn: z
    .enum(['divider', 'buck', 'led_resistor', 'rc', 'nearest_e'])
    .describe(
      'divider: {vout, vref, r_bottom?, series?} → E-series R top/bottom and resulting vout. ' +
        'buck: {vin, vout, iout, fsw, ripple_ratio?} → inductance, ripple current, peak current. ' +
        'led_resistor: {vsupply, vf, i} → resistor and power. ' +
        'rc: {r?, c?, f?} → give two, get the third (f = 1/(2πRC)). ' +
        'nearest_e: {value, series} → nearest standard value.',
    ),
  args: z.record(z.string(), z.union([z.number(), z.string()])),
});
export type CalcCall = z.infer<typeof CalcCall>;

export const AskUser = z.object({
  question: z.string().min(5),
  options: z.array(z.string()).min(2).max(5).describe('Short, mutually exclusive choices'),
});
export type AskUser = z.infer<typeof AskUser>;

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function schemaOf(t: z.ZodType): Record<string, unknown> {
  const s = z.toJSONSchema(t, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

export const TOOL_NAMES = {
  query: 'design_query',
  edit: 'design_edit',
  calc: 'calc',
  ask: 'ask_user',
} as const;

export function toolDefinitions(): ToolDefinition[] {
  return [
    {
      name: TOOL_NAMES.query,
      description:
        'Read the design or the part library. Ops: get_summary, find, get_component, get_net, ' +
        'get_diagnostics, get_ledger, search_parts, get_part. Read-only.',
      input_schema: schemaOf(QueryOp),
    },
    {
      name: TOOL_NAMES.edit,
      description:
        'Change the design with one atomic transaction of semantic ops (never coordinates). ' +
        'All ops apply or none. A rejected transaction explains why and often suggests fix ops. ' +
        'The result lists diagnostics the change introduced or resolved. Set dry_run to preview.',
      input_schema: schemaOf(Transaction),
    },
    {
      name: TOOL_NAMES.calc,
      description:
        'Deterministic engineering calculators. Use these instead of doing arithmetic yourself; ' +
        'results snap to standard E-series values where relevant.',
      input_schema: schemaOf(CalcCall),
    },
    {
      name: TOOL_NAMES.ask,
      description:
        'Ask the user one concrete question with 2–5 options when a decision has a real trade-off ' +
        'you cannot settle from the request or the ledger. Ends your turn.',
      input_schema: schemaOf(AskUser),
    },
  ];
}
