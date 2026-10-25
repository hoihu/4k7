/**
 * The agent tool surface, generated from the op catalogue: one set of tools for every engine
 * that runs a design conversation (the in-app agent, Claude Code through the local server).
 */
import { z } from 'zod';
import { DraftPin, PackageInfo } from './ingest.ts';
import { QueryOp, Transaction } from './ops.ts';
import { ASSEMBLY_HOUSE, feeFreeTiers } from './sourcing.ts';

export const CalcCall = z.object({
  fn: z
    .enum(['divider', 'buck', 'led_resistor', 'rc', 'nearest_e', 'impedance'])
    .describe(
      'divider: {vout, vref, r_bottom?, series?} → E-series R top/bottom and resulting vout. ' +
        'buck: {vin, vout, iout, fsw, ripple_ratio?, series?} → inductance, ripple current, peak current. ' +
        'led_resistor: {vsupply, vf, i, series?} → resistor and power. ' +
        'rc: {r?, c?, f?, series?} → give two, get the third (f = 1/(2πRC)). ' +
        'nearest_e: {value, kind?, series?, round?} → standard value (kind resistor/capacitor/inductor takes the design\'s series; round up/down). ' +
        'impedance: {ohms?, width?, gap?, diff?, coplanar_gap?, layer?, h?, er?, t?, mask?, f?} → a track\'s impedance from a field solver: ohms gives the width for it, width the impedance it gives; gap makes it a differential pair (ohms: its differential impedance; diff: 1 with width and ohms finds the gap), coplanar_gap puts ground beside it on its layer; f (Hz) adds the wavelength on the line. Default: the board\'s stack-up, layer F.Cu (or B.Cu) over the plane next to it, with its solder mask; h (mm to the plane) with er, t (copper mm) and mask: 0 override it. ' +
        'series: E3, E6, E12, E24, E48, E96 or E192; default: the design\'s series for that kind (set_value_series), else E96 for resistors, E12 caps, E6 inductors.',
    ),
  args: z.record(z.string(), z.union([z.number(), z.string()])),
});
export type CalcCall = z.infer<typeof CalcCall>;

const HOUSE = ASSEMBLY_HOUSE;

/** sourcing: the assembly house's parts catalogue (search, one part by number) and the stock check of the design. */
export const SourcingInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('search'),
    text: z.string().optional().describe('What the part is, as words that appear in a catalogue description or its part number: "passive buzzer", "AMS1117-3.3", "USB-C receptacle 16P", "NPN SOT-23". Not for resistors/capacitors: use kind + value.'),
    kind: z.enum(['resistor', 'capacitor']).optional().describe('Parametric search for a jellybean passive: give value (and package); text is ignored'),
    value: z.string().optional().describe('With kind: the value, e.g. "10k", "100nF"'),
    package: z.string().optional().describe(`Package filter as ${HOUSE.name} names it: "0603", "SOT-23", "SOIC-8", "LQFP-48"`),
    no_fee: z.boolean().optional().describe(`Only parts without a one-off fee (${feeFreeTiers(HOUSE)}). Default: all, fee-free first`),
    limit: z.number().int().min(1).max(25).default(8),
  }).describe('Search the catalogue: by words, or a resistor/capacitor by kind + value + package. In-stock parts only.'),
  z.object({
    action: z.literal('lookup'),
    part: z.string().min(2).describe(`The ${HOUSE.numberName}, e.g. "${HOUSE.example}"`),
  }).describe('One part by its number: maker and part number, package, stock now, price breaks, class, datasheet link'),
  z.object({
    action: z.literal('check'),
    boards: z.number().int().min(1).max(1_000_000).optional().describe('How many boards will be assembled (default: the number set in the app, else 10)'),
  }).describe(
    "The stock check before ordering: every component's part looked up now, with what is wrong (out of stock, too few for the boards, " +
      'low stock, gone from the catalogue, not matching its component, a fee) and in-stock replacements for the parts in trouble',
  ),
  z.object({
    action: z.literal('cost'),
    boards: z.number().int().min(1).max(1_000_000).optional().describe('How many boards will be assembled (default: the number set in the app, else 10)'),
  }).describe(
    `The cost check: what the order costs at each of ${HOUSE.name}'s assembly services (parts and every fee: setup, stencil, loading, joints, ` +
      'soldering by hand), and what would make it cheaper (equivalent parts, one part number for parts that are the same, every part on one side, ' +
      'soldering through-hole parts yourself), with parts for the components that have no part number yet',
  ),
  z.object({
    action: z.literal('values'),
    boards: z.number().int().min(1).max(1_000_000).optional().describe('How many boards will be assembled (default: the number set in the app, else 10)'),
  }).describe(
    'Cheaper ways to make each resistor and capacitor value (with a part number or without): the same value without a fee, the nearest values ' +
      'below and above, values already on the order, and two parts in series or parallel, from the parts without a fee in its package; each with ' +
      'how far off it is and what it saves (pieces, loading fees and extra joints counted). Whether a value may move is for you to judge by what ' +
      'the part does: read design_query get_guide topic "cost" first',
  ),
]);
export type SourcingInput = z.infer<typeof SourcingInput>;

export const AskUser = z.object({
  question: z.string().min(5),
  options: z.array(z.string()).min(2).max(5).describe('Short, mutually exclusive choices'),
});
export type AskUser = z.infer<typeof AskUser>;

export const ProposeInput = z.object({
  summary: z.string().min(3).describe('One line describing the whole changeset, shown to the user'),
  message: z.string().optional().describe('Short note to the user: assumptions, warnings left, questions'),
  open_connections: z
    .string()
    .optional()
    .describe('Only if the routed board still has open connections and you could not close them: why, and what the user could decide (e.g. 4 layers, a bigger board). Without it propose refuses a routed board that is not 100 % routed.'),
  enclosure_findings: z
    .string()
    .optional()
    .describe('Only if the enclosure script changed and its last render still has findings you could not fix: why, and what the user could decide. Without it propose refuses an enclosure that was not rendered or whose report has errors.'),
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
  find: z.string().optional().describe('Search the datasheet for this text (e.g. "pitch", "inductor", "feedback resistor", "layout"); lists the pages that contain it'),
  region: z
    .tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
    .optional()
    .describe('With page: zoom into x0, y0, x1, y1 (fractions of the page, top left 0, 0) for a sharper picture of a drawing'),
});

export const ImageInput = z.object({
  sheet: z.string().optional().describe('Sheet name; defaults to the one shown'),
  page: z.number().int().min(1).optional().describe('One page only (its number from the design summary); the layout flows each sheet onto pages of the design\'s paper (A4 unless set_paper). Default: the whole sheet'),
  area: z.boolean().optional().describe('The area in question, close up: in an Optimize run the area you work in, otherwise the area the user zoomed into (the <view> block)'),
  width: z.number().int().min(400).max(2400).default(1400),
});

export const BoardImageInput = z.object({
  area: z.boolean().optional().describe('The area the user zoomed into on the board (the <view> block) instead of the whole board'),
  region: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .optional()
    .describe('Zoom into x0, y0, x1, y1 in mm (board coordinates, top left 0, 0), e.g. around an unrouted connection'),
  width: z.number().int().min(400).max(2400).default(1400),
});

export const ENCLOSURE_VIEWS = ['front_left', 'back_right', 'open', 'sections', 'base_top', 'bottom'] as const;
export const RenderEnclosureInput = z.object({
  views: z
    .array(z.enum(ENCLOSURE_VIEWS))
    .optional()
    .describe('Pictures to get back: front_left and back_right (the closed box from above, two corners), open (the lid lifted off), sections (a cut across the wall through every opening in the brief), base_top (the base from above without the lid: posts, ribs, the board on them), bottom (from below). Default: all but bottom on the first render; ask for fewer once only details change'),
  faces: z
    .array(z.enum(['left', 'right', 'top', 'bottom', 'above', 'below']))
    .optional()
    .describe('Pictures of these faces of the closed box (as on_face names them), as a reader sees them, tilted a little so engraving shows: check that labels and logos read the right way round, are the right size and sit where they should'),
  section: z
    .object({ axis: z.enum(['x', 'y', 'z']), at_mm: z.number() })
    .optional()
    .describe('One more cut anywhere: the plane x, y or z = at_mm (board.scad coordinates), seen from the side it faces'),
  width: z.number().int().min(400).max(1600).default(900).describe('Width of each picture in pixels'),
});
export type RenderEnclosureInput = z.infer<typeof RenderEnclosureInput>;

export const AttachmentInput = z.object({
  n: z.number().int().min(1).default(1).describe('Which attachment: they are numbered through the conversation (#1, #2…)'),
  page: z.number().int().min(1).optional().describe('A PDF: the page to look at (default 1)'),
  region: z
    .tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
    .optional()
    .describe('Zoom into x0, y0, x1, y1 (fractions of the picture or page, top left 0, 0) to read small print: values, pin numbers, net labels'),
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
  tuplesAsArrays(s);
  const variants = (s.anyOf ?? s.oneOf) as Json[] | undefined;
  if (s.type === 'object' || !variants) return s;
  return flattenUnion(variants);
}

/**
 * zod emits a tuple as `prefixItems` with `items: false` (JSON Schema 2020-12). Some MCP
 * clients (VS Code's Copilot) refuse any array whose `items` is not a schema, so every tuple
 * also gets `items`: the element schema when all positions share one, else their union. The
 * length is already fixed by minItems/maxItems; zod still validates the exact shape.
 */
function tuplesAsArrays(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) tuplesAsArrays(n);
    return;
  }
  const s = node as Json;
  const prefix = s.prefixItems as Json[] | undefined;
  if (s.type === 'array' && prefix && typeof s.items !== 'object') {
    const first = JSON.stringify(prefix[0]);
    s.items = prefix.every((p) => JSON.stringify(p) === first) ? { ...prefix[0] } : { anyOf: prefix.map((p) => ({ ...p })) };
  }
  for (const v of Object.values(s)) tuplesAsArrays(v);
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
  sourcing: 'sourcing',
  importPart: 'import_part',
  pendingImport: 'pending_import',
  artwork: 'artwork',
  datasheet: 'read_datasheet',
  image: 'get_schematic_image',
  boardImage: 'get_board_image',
  renderEnclosure: 'render_enclosure',
  attachment: 'view_attachment',
  ask: 'ask_user',
  propose: 'propose',
  waitForReview: 'wait_for_review',
} as const;

/** The sourcing tool, shared by the in-app agent and the MCP server. */
export const SOURCING_TOOL: ToolDefinition = {
  name: TOOL_NAMES.sourcing,
  description:
    `Parts for assembly at ${HOUSE.name}, from its catalogue (${HOUSE.numberName}s, stock now, prices). search: by words, or a resistor/capacitor ` +
    'by kind + value + package. lookup: one part by its number (stock, price breaks, datasheet link). check: every part of the design looked up ' +
    'before ordering, for a number of boards, with replacements for the ones out of stock or short. cost: what the order costs with every fee, ' +
    'and what would make it cheaper. values: cheaper ways to make each resistor and capacitor value (other values, series or parallel pairs). ' +
    `Parts say their class (${HOUSE.tiers.map((t) => `${t.name}${t.fee ? ': a fee' : ''}`).join(', ')}). ` +
    `Record a chosen part with design_edit set_param ${HOUSE.param}: "${HOUSE.example}"; a generic resistor/capacitor stays generic.`,
  input_schema: schemaOf(SourcingInput),
};

/**
 * Who runs the conversation. app: the in-app agent on the user's API key (the design state comes
 * with each message, it asks with ask_user, the app proposes the changes after the turn). chat:
 * Claude Code answering the app's chat through the server (reads the state with get_context,
 * proposes itself; the user reviews after the turn). cli: Claude Code driving the app from a
 * terminal, which also waits for the review.
 */
export type AgentEngine = 'app' | 'chat' | 'cli';

/** The design tools, the same for every engine, plus the few that differ in how a turn starts and ends. */
export function agentTools(engine: AgentEngine): ToolDefinition[] {
  const viaClaudeCode = engine !== 'app';
  return [
    ...(viaClaudeCode
      ? [{
          name: TOOL_NAMES.context,
          description:
            'Current design state as the user sees it: components, nets, open diagnostics, ledger, what the user has ' +
            'selected on the canvas, the view and area they are looking at, and whether a changeset is waiting for review. Call this first.',
          input_schema: { type: 'object', properties: {} },
        }]
      : []),
    {
      name: TOOL_NAMES.query,
      description:
        'Read the design or the part library. Ops: get_summary, find, get_component, get_net, get_diagnostics, ' +
        'get_ledger, get_description, get_fab_profiles, get_board, try_placements (compare board arrangements), search_parts, get_part. Read-only.',
      input_schema: schemaOf(QueryOp),
    },
    {
      name: TOOL_NAMES.edit,
      description:
        'Change the design with one atomic transaction of semantic ops (coordinates only to place a part: place on the board, place_symbol on the schematic). All ops apply or none; ' +
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
        'Needs the local server.',
      input_schema: schemaOf(ImportPartInput),
    },
    SOURCING_TOOL,
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
        "Read a part's datasheet (the PDF it was imported from; a part with only a datasheet link gets it downloaded): the page index " +
        "with where its sections are (pinout, package drawing, typical application, design procedure, layout guidelines), a text search, " +
        "or one page's text with a picture of it (use region to zoom into a drawing or a schematic). For designing with the part: its " +
        'typical application circuit, how to choose the parts round it (formulas, recommended values and ratings), its layout guidelines; ' +
        'and for checking pinouts, package drawings and recommended footprints.',
      input_schema: schemaOf(DatasheetInput),
    },
    {
      name: TOOL_NAMES.image,
      description: 'PNG rendering of the current schematic (working copy, with pending changes highlighted).',
      input_schema: schemaOf(ImageInput),
    },
    {
      name: TOOL_NAMES.boardImage,
      description:
        'PNG rendering of the board (2D top view of the working copy: copper of every layer, pads, silkscreen, and the ratsnest of ' +
        'connections not routed yet). The whole board, the area the user zoomed into, or a region in mm. Routing a big board takes a while; ' +
        'the picture waits for it.',
      input_schema: schemaOf(BoardImageInput),
    },
    {
      name: TOOL_NAMES.renderEnclosure,
      description:
        "Render the enclosure script (the working copy's, set with design_edit set_enclosure_script) with the user's OpenSCAD, in 3D with the board: " +
        'the report (OpenSCAD\'s errors with line numbers, and what the checks measured: collisions with named parts, blocked openings, ' +
        'room under the lid, the board held, pieces overlapping, the size) and pictures (faces: straight at the faces with labels or logos). Fix what the report says first, then what the pictures show; render again after every change.',
      input_schema: schemaOf(RenderEnclosureInput),
    },
    ...(engine !== 'cli'
      ? [{
          name: TOOL_NAMES.attachment,
          description:
            'Look at a file the user attached to the chat (a picture or PDF of a schematic, a sketch, a screenshot): all of it, or a region ' +
            'zoomed in. To recreate a schematic from one: first read it region by region and list every part (reference, value, ' +
            'what it is), every net and what connects to it, and the blocks it is made of; then build it with design_edit ' +
            '(parts from the library, sourcing or import_part), and say what you could not read or did differently. ' +
            'Copy the circuit first; to make it look like the original, then give its IC symbols the pin sides and order it shows ' +
            '(design_edit set_symbol layout) and arrange the parts (place_symbol, wire, label).',
          input_schema: schemaOf(AttachmentInput),
        }]
      : []),
    ...(viaClaudeCode
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
