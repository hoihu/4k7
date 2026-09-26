/**
 * The operation catalogue: the only way to read or change a design.
 * Defined once with zod; JSON Schemas for agent tools / MCP are generated from it.
 * See docs/design/ops-api.md.
 */
import { z } from 'zod';

/* ---------------------------------- refs ---------------------------------- */

const componentRef = z
  .string()
  .min(1)
  .describe('Component reference: refdes ("U1") or component id');
const pinRef = z
  .string()
  .min(3)
  .describe('Pin reference "<refdes>.<pin name or number>", e.g. "U1.VIN" or "U1.2". A name shared by several pins (e.g. GND) addresses all of them.');
const netName = z.string().min(1).describe('Net name, e.g. "+3V3", "GND", "SW"');

/* ------------------------------- edit ops --------------------------------- */

export const AddPartOp = z.object({
  op: z.literal('add_part'),
  part: z.string().describe('Part Card id from search_parts, e.g. "generic:C" or "ti:TPS54331DR"'),
  refdes: z.string().regex(/^[A-Z]+[0-9]+$/).optional().describe('Reference designator; auto-assigned if omitted. Give one when later ops in the same transaction refer to the part.'),
  params: z.record(z.string(), z.string()).optional().describe('Engineering parameters, e.g. {"capacitance":"100nF","voltage":"25V","package":"0402"}'),
  sheet: z.string().optional().describe('Sheet name; defaults to the first sheet'),
});

export const RemoveOp = z.object({
  op: z.literal('remove'),
  ref: componentRef,
});

export const SetParamOp = z.object({
  op: z.literal('set_param'),
  ref: componentRef,
  params: z.record(z.string(), z.string().nullable()).describe('Parameters to set; null removes a parameter'),
});

export const RenameOp = z.object({
  op: z.literal('rename'),
  ref: componentRef,
  refdes: z.string().regex(/^[A-Z]+[0-9]+$/),
});

export const ConnectOp = z.object({
  op: z.literal('connect'),
  pins: z.array(pinRef).min(1),
  net: netName.optional().describe('Target net. If omitted, the pins join the net one of them is already on, or a new unnamed net.'),
});

export const DisconnectOp = z.object({
  op: z.literal('disconnect'),
  pins: z.array(pinRef).min(1),
});

export const NoConnectOp = z.object({
  op: z.literal('no_connect'),
  pins: z.array(pinRef).min(1).describe('Pins deliberately left unconnected'),
});

export const SetNetOp = z.object({
  op: z.literal('set_net'),
  net: netName,
  rename: netName.optional(),
  voltage: z.number().nullable().optional().describe('Nominal DC voltage in volts'),
  external: z.boolean().optional().describe('True for nets driven from outside the design (e.g. supply input on a connector)'),
  power: z.boolean().optional().describe('Draw as a power rail'),
  max_current: z.number().nullable().optional().describe('Expected maximum current in amps'),
});

export const AddSheetOp = z.object({
  op: z.literal('add_sheet'),
  name: z.string().min(1),
});

export const MoveToSheetOp = z.object({
  op: z.literal('move_to_sheet'),
  refs: z.array(componentRef).min(1),
  sheet: z.string(),
});

export const ConstrainOp = z.object({
  op: z.literal('constrain'),
  kind: z
    .enum(['left_of', 'right_of', 'above', 'below', 'near', 'param', 'layer', 'arrangement', 'note'])
    .describe('arrangement: how a recognised sub-circuit is drawn; a = one of its parts. Bridge rectifier diode: "diamond" (default) | "inline". Regulator IC: "power_flow" (default, datasheet style) | "compact"'),
  a: componentRef.optional().describe('Subject component; for left_of/right_of/above/below also one unit of a split symbol, e.g. "U3B"'),
  b: componentRef.optional().describe('Reference component (left_of/right_of/above/below/near), or a unit such as "U3A"'),
  key: z.string().optional().describe('param: parameter name; layer: omit'),
  value: z.string().optional().describe('param: required value; layer: "top"|"bottom"; arrangement: see kind; note: free text'),
  max_mm: z.number().positive().optional().describe('near: maximum distance on the board in mm'),
  strength: z.enum(['hard', 'soft']).default('soft'),
  quote: z.string().optional().describe("The user's words this constraint comes from"),
});

export const RemoveConstraintOp = z.object({
  op: z.literal('remove_constraint'),
  id: z.string(),
});

export const AddWaiverOp = z.object({
  op: z.literal('add_waiver'),
  code: z.string().describe('Diagnostic code to waive, e.g. "SEM.EN_FLOATING"'),
  entities: z.array(z.string()).min(1).describe('Entities exactly as listed in the diagnostic'),
  reason: z.string().min(8),
});

export const RemoveWaiverOp = z.object({
  op: z.literal('remove_waiver'),
  id: z.string(),
});

export const SetSymbolOp = z.object({
  op: z.literal('set_symbol'),
  ref: componentRef.describe('A component using the part, e.g. "U3"'),
  style: z
    .enum(['single', 'units'])
    .describe('units: draw a big IC as several symbols (U1A power/system, U1B… two GPIO ports each); single: one symbol. Pins, nets and refdes stay the same; applies to every component of that part.'),
});

export const SetBoardOp = z.object({
  op: z.literal('set_board'),
  width_mm: z.number().positive().nullable().optional().describe('Board width; null = size to fit the parts'),
  height_mm: z.number().positive().nullable().optional().describe('Board height; null = size to fit the parts'),
  layers: z.union([z.literal(2), z.literal(4)]).optional(),
  clearance_mm: z.number().positive().optional().describe('Copper clearance (default 0.2)'),
  track_mm: z.number().positive().optional().describe('Signal track width (default 0.25)'),
  power_track_mm: z.number().positive().optional().describe('Supply/ground track width (default 0.5)'),
});

export const PlaceOp = z.object({
  op: z.literal('place'),
  ref: componentRef,
  x_mm: z.number().describe('Centre x on the board, from the left edge'),
  y_mm: z.number().describe('Centre y on the board, from the top edge'),
  rot: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional().describe('Clockwise rotation'),
});

export const EditOp = z.discriminatedUnion('op', [
  AddPartOp,
  RemoveOp,
  SetParamOp,
  RenameOp,
  ConnectOp,
  DisconnectOp,
  NoConnectOp,
  SetNetOp,
  AddSheetOp,
  MoveToSheetOp,
  ConstrainOp,
  RemoveConstraintOp,
  AddWaiverOp,
  RemoveWaiverOp,
  SetSymbolOp,
  SetBoardOp,
  PlaceOp,
]);
export type EditOp = z.infer<typeof EditOp>;
export type EditOpName = EditOp['op'];

export const Transaction = z.object({
  summary: z.string().min(1).describe('One line describing the intent of this change'),
  ops: z.array(EditOp).min(1),
  dry_run: z.boolean().optional().describe('Validate and report diff + diagnostics without applying'),
});
export type Transaction = z.infer<typeof Transaction>;

/* ------------------------------- query ops -------------------------------- */

export const QueryOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('get_summary') }),
  z.object({
    op: z.literal('find'),
    text: z.string().optional().describe('Substring of refdes, part id, value or net name'),
    category: z.string().optional(),
  }),
  z.object({ op: z.literal('get_component'), ref: componentRef }),
  z.object({ op: z.literal('get_net'), net: netName }),
  z.object({ op: z.literal('get_diagnostics') }),
  z.object({ op: z.literal('get_ledger') }),
  z.object({
    op: z.literal('search_parts'),
    text: z.string().describe('Search text: function, MPN, category ("buck", "capacitor", "555")'),
  }),
  z.object({ op: z.literal('get_part'), id: z.string() }),
]);
export type QueryOp = z.infer<typeof QueryOp>;
