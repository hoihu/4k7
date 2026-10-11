/**
 * The agent tool surface, generated from the op catalogue: one set of tools for every engine
 * that runs a design conversation (the in-app agent, Claude Code through the local bridge).
 */
import { z } from 'zod';
import { DraftPin, PackageInfo } from './ingest.ts';
import { QueryOp, Transaction } from './ops.ts';

export const CalcCall = z.object({
  fn: z
    .enum(['divider', 'buck', 'led_resistor', 'rc', 'nearest_e'])
    .describe(
      'divider: {vout, vref, r_bottom?, series?} → E-series R top/bottom and resulting vout. ' +
        'buck: {vin, vout, iout, fsw, ripple_ratio?, series?} → inductance, ripple current, peak current. ' +
        'led_resistor: {vsupply, vf, i, series?} → resistor and power. ' +
        'rc: {r?, c?, f?, series?} → give two, get the third (f = 1/(2πRC)). ' +
        'nearest_e: {value, kind?, series?, round?} → standard value (kind resistor/capacitor/inductor takes the design\'s series; round up/down). ' +
        'series: E3, E6, E12, E24, E48, E96 or E192; default: the design\'s series for that kind (set_value_series), else E96 for resistors, E12 caps, E6 inductors.',
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

export const ProposeInput = z.object({
  summary: z.string().min(3).describe('One line describing the whole changeset, shown to the user'),
  message: z.string().optional().describe('Short note to the user: assumptions, warnings left, questions'),
});

export const WaitForReviewInput = z.object({
  timeout_s: z.number().int().min(5).max(600).default(120).describe('How long to wait before returning "still pending"'),
});

export const ImportPartInput = z.object({
  mpn: z.string().min(2).describe('Full ordering code; it picks the package, e.g. "ADIN2111BCPZ"'),
  datasheet_url: z.string().url().describe("The manufacturer's datasheet PDF link"),
  notes: z.string().optional().describe('Hints for the extraction, e.g. which package table to use'),
  timeout_s: z.number().int().min(30).max(900).default(420).describe('How long to wait for the import (it takes a few minutes); if it is still running, call again with the same mpn to keep waiting'),
});

export const PendingImportInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get') }).describe('The import waiting for review: pins, package, the passes\' disagreements and the issues'),
  z.object({
    action: z.literal('pick'),
    picks: z.array(z.object({ key: z.string().describe('Disagreement key, e.g. "pin:41" or "package:pitch_mm"'), pass: z.union([z.literal(1), z.literal(2)]) })).min(1),
  }).describe('Settle disagreements: take pass 1\'s or pass 2\'s value'),
  z.object({ action: z.literal('set_pins'), pins: z.array(DraftPin).min(1) }).describe('Add pins or correct them (matched by number), e.g. a missing exposed pad "49" GND pwr_in'),
  z.object({ action: z.literal('remove_pins'), numbers: z.array(z.string()).min(1) }),
  z.object({ action: z.literal('set_package'), package: PackageInfo.partial() }).describe('Correct package facts (pitch, body, exposed pad …)'),
  z.object({ action: z.literal('rename'), mpn: z.string().min(2).optional(), title: z.string().optional() }).describe('Correct the part number (the exact ordering code; the part id follows it) and/or the title people know it by'),
  z.object({ action: z.literal('save') }).describe('Save the reviewed part to the library (refused while errors remain)'),
  z.object({ action: z.literal('discard') }),
]);

export const ArtworkInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).describe('The saved artwork: names, sizes, filled or outlines'),
  z.object({ action: z.literal('save'), graphic: z.string().describe('A silkscreen graphic on the board, e.g. "G3"'), name: z.string().min(1).describe('What to call it, e.g. "Snowflake fern"') }).describe('Save a board graphic to the artwork library (kept in this browser, for every project)'),
  z.object({ action: z.literal('rename'), name: z.string().min(1), to: z.string().min(1) }),
  z.object({ action: z.literal('delete'), name: z.string().min(1) }).describe('Delete a saved artwork (boards that use it keep their copy)'),
]);

export type ArtworkInput = z.infer<typeof ArtworkInput>;

export const DatasheetInput = z.object({
  part: z.string().min(1).describe('A component using the part ("BZ1") or the part id'),
  page: z.number().int().positive().optional().describe('Page to read: its text and a picture of it (drawings, dimension figures). Leave out for the page index.'),
  find: z.string().optional().describe('Search the datasheet for this text (e.g. "pitch", "dimensions"); lists the pages that contain it'),
  region: z
    .tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
    .optional()
    .describe('With page: zoom into x0, y0, x1, y1 (fractions of the page, top left 0, 0) for a sharper picture of a drawing'),
});

export const ImageInput = z.object({
  sheet: z.string().optional().describe('Sheet name; defaults to the one shown'),
  page: z.number().int().min(1).optional().describe('One page only (its number from the design summary); the layout flows each sheet onto pages of the design\'s paper (A4 unless set_paper). Default: the whole sheet'),
  area: z.boolean().optional().describe('Optimize runs only: the area you are asked to work in, close up, instead of the whole sheet'),
  width: z.number().int().min(400).max(2400).default(1400),
});

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
  plainTuples(s);
  const variants = (s.anyOf ?? s.oneOf) as Json[] | undefined;
  if (s.type === 'object' || !variants) return s;
  return flattenUnion(variants);
}

/** Some MCP clients (VS Code) reject `prefixItems` with `items: false`; a tuple becomes an array with fixed length. */
function plainTuples(n: unknown): void {
  if (Array.isArray(n)) return n.forEach(plainTuples);
  if (!n || typeof n !== 'object') return;
  const o = n as Json;
  if (Array.isArray(o.prefixItems)) {
    const items = o.prefixItems as Json[];
    const same = items.every((x) => JSON.stringify(x) === JSON.stringify(items[0]));
    o.items = same ? items[0] : { anyOf: items };
    delete o.prefixItems;
  }
  for (const v of Object.values(o)) plainTuples(v);
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
  context: 'get_context',
  query: 'design_query',
  edit: 'design_edit',
  calc: 'calc',
  jlc: 'jlc_search',
  importPart: 'import_part',
  pendingImport: 'pending_import',
  artwork: 'artwork',
  datasheet: 'read_datasheet',
  image: 'get_schematic_image',
  ask: 'ask_user',
  propose: 'propose',
  waitForReview: 'wait_for_review',
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

/**
 * Who runs the conversation. app: the in-app agent on the user's API key (the design state comes
 * with each message, it asks with ask_user, the app proposes the changes after the turn). chat:
 * Claude Code answering the app's chat through the bridge (reads the state with get_context,
 * proposes itself; the user reviews after the turn). cli: Claude Code driving the app from a
 * terminal, which also waits for the review.
 */
export type AgentEngine = 'app' | 'chat' | 'cli';

/** The design tools, the same for every engine, plus the few that differ in how a turn starts and ends. */
export function agentTools(engine: AgentEngine): ToolDefinition[] {
  const viaBridge = engine !== 'app';
  return [
    ...(viaBridge
      ? [{
          name: TOOL_NAMES.context,
          description:
            'Current design state as the user sees it: components, nets, open diagnostics, ledger, what the user has ' +
            'selected on the canvas, and whether a changeset is waiting for review. Call this first.',
          input_schema: { type: 'object', properties: {} },
        }]
      : []),
    {
      name: TOOL_NAMES.query,
      description:
        'Read the design or the part library. Ops: get_summary, find, get_component, get_net, get_diagnostics, ' +
        'get_ledger, get_description, get_fab_profiles, get_board, search_parts, get_part. Read-only.',
      input_schema: schemaOf(QueryOp),
    },
    {
      name: TOOL_NAMES.edit,
      description:
        'Change the design with one atomic transaction of semantic ops (never coordinates). All ops apply or none; ' +
        'a rejection explains why and often suggests fix ops. The result lists diagnostics introduced/resolved. ' +
        'Changes go to a working copy the user reviews; set dry_run to preview.',
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
      name: TOOL_NAMES.importPart,
      description:
        "Import a part into the user's library from its datasheet PDF (the app's datasheet import: pins, package, footprint, " +
        'decoupling, checked and cross-checked by a second independent pass). Takes a few minutes; the part is then in the library for add_part. ' +
        'Needs the local bridge.',
      input_schema: schemaOf(ImportPartInput),
    },
    JLC_TOOL,
    {
      name: TOOL_NAMES.pendingImport,
      description:
        'Work on the datasheet import waiting for review (the same one the user sees in Parts): read it, settle the two passes\' ' +
        'disagreements, add or correct pins and package facts from the datasheet, then save it to the library. Check values with read_datasheet.',
      input_schema: schemaOf(PendingImportInput),
    },
    {
      name: TOOL_NAMES.artwork,
      description:
        'The artwork library: silkscreen graphics (logos, clipart) saved in the browser for every project. list, save a board graphic ' +
        'under a name, rename, delete. Place a saved one with design_edit add_graphic artwork: "<name>" (same shape every time).',
      input_schema: schemaOf(ArtworkInput),
    },
    {
      name: TOOL_NAMES.datasheet,
      description:
        "Read the datasheet stored with an imported part: the page index, a text search, or one page's text with a picture of it " +
        '(use region to zoom into a drawing). For checking pinouts, package drawings and recommended footprints.',
      input_schema: schemaOf(DatasheetInput),
    },
    {
      name: TOOL_NAMES.image,
      description: 'PNG rendering of the current schematic (working copy, with pending changes highlighted).',
      input_schema: schemaOf(ImageInput),
    },
    ...(viaBridge
      ? [{
          name: TOOL_NAMES.propose,
          description:
            'Hand the working copy to the user for review (or commit it in Auto mode). Refused while the design has open ' +
            'errors: fix them or waive with a reason first. Call once per coherent change' + (engine === 'cli' ? ', then wait_for_review.' : '.'),
          input_schema: schemaOf(ProposeInput),
        }]
      : [{
          name: TOOL_NAMES.ask,
          description:
            'Ask the user one concrete question with 2–5 options when a decision has a real trade-off ' +
            'you cannot settle from the request or the ledger. Ends your turn.',
          input_schema: schemaOf(AskUser),
        }]),
    ...(engine === 'cli'
      ? [{
          name: TOOL_NAMES.waitForReview,
          description: 'Block until the user accepts or rejects the proposed changeset (or the timeout passes).',
          input_schema: schemaOf(WaitForReviewInput),
        }]
      : []),
  ];
}
