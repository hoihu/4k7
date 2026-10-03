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

/** jlc_search: JLCPCB's assembly catalogue (LCSC part numbers), by text, by value or by number. */
export const JlcSearchInput = z.object({
  text: z.string().optional().describe('What the part is, as words that appear in a catalogue description: "passive buzzer", "AMS1117-3.3", "USB-C receptacle 16P", "NPN SOT-23". Not for resistors/capacitors: use kind + value.'),
  kind: z.enum(['resistor', 'capacitor']).optional().describe('Parametric search for a jellybean passive: give value (and package); text is ignored'),
  value: z.string().optional().describe('With kind: the value, e.g. "10k", "100nF"'),
  package: z.string().optional().describe('Package filter as JLCPCB names it: "0603", "SOT-23", "SOIC-8", "LQFP-48"'),
  lcsc: z.string().optional().describe('Look one part up by its LCSC number ("C25804"): manufacturer part, package, value, stock, price and the datasheet link'),
  basic_only: z.boolean().optional().describe('Only Basic and Preferred parts (no extended-part fee per unique part at JLCPCB assembly). Default: all, Basic first'),
  limit: z.number().int().min(1).max(25).default(8),
});
export type JlcSearchInput = z.infer<typeof JlcSearchInput>;

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

type Json = Record<string, unknown>;

/**
 * JSON Schema for a tool input. Tool APIs (Anthropic, MCP) require a plain top-level
 * `{"type": "object"}`; a top-level union (e.g. the query ops) is flattened into one object
 * whose discriminator becomes an enum. The kernel still validates inputs exactly with zod.
 */
export function schemaOf(t: z.ZodType): Json {
  const s = z.toJSONSchema(t, { io: 'input', unrepresentable: 'any' }) as Json;
  delete s.$schema;
  const variants = (s.anyOf ?? s.oneOf) as Json[] | undefined;
  if (s.type === 'object' || !variants) return s;
  return flattenUnion(variants);
}

function flattenUnion(variants: Json[]): Json {
  const properties: Record<string, Json> = {};
  const discriminators = new Map<string, unknown[]>();
  const requiredEverywhere = new Set<string>((variants[0]?.required as string[] | undefined) ?? []);
  for (const v of variants) {
    const req = new Set((v.required as string[] | undefined) ?? []);
    for (const k of [...requiredEverywhere]) if (!req.has(k)) requiredEverywhere.delete(k);
    for (const [k, p] of Object.entries((v.properties as Record<string, Json>) ?? {})) {
      if ('const' in p) {
        discriminators.set(k, [...(discriminators.get(k) ?? []), p.const]);
        continue;
      }
      const prev = properties[k];
      if (!prev) properties[k] = { ...p };
      else if (p.description && prev.description && !String(prev.description).includes(String(p.description))) {
        prev.description = `${prev.description} | ${p.description}`;
      }
    }
  }
  for (const [k, values] of discriminators) properties[k] = { type: 'string', enum: values };
  return { type: 'object', properties, required: [...requiredEverywhere], additionalProperties: false };
}

export const TOOL_NAMES = {
  query: 'design_query',
  edit: 'design_edit',
  calc: 'calc',
  jlc: 'jlc_search',
  ask: 'ask_user',
} as const;

/** The jlc_search tool, shared by the in-app agent and the MCP bridge. */
export const JLC_TOOL: ToolDefinition = {
  name: TOOL_NAMES.jlc,
  description:
    "JLCPCB's assembly parts catalogue (LCSC part numbers): search by text, parametrically for resistors/capacitors (kind + value + package), " +
    'or look a part up by its LCSC number (details, stock, price, datasheet link). Results say Basic/Preferred (no loading fee) or Extended. ' +
    'Record the chosen part on a component with design_edit set_param lcsc: "C25804"; a generic resistor/capacitor stays generic.',
  input_schema: schemaOf(JlcSearchInput),
};

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
    JLC_TOOL,
    {
      name: TOOL_NAMES.ask,
      description:
        'Ask the user one concrete question with 2–5 options when a decision has a real trade-off ' +
        'you cannot settle from the request or the ledger. Ends your turn.',
      input_schema: schemaOf(AskUser),
    },
  ];
}
