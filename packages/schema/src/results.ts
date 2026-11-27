import type { Stackup } from './stackup.ts';
import type { EditOp } from './ops.ts';
import type { ScopeOutcome } from './scope.ts';
import type { QuarterTurn, SpecItem, SpecVerifier, ValueSeries } from './model.ts';
import { drawingFinding } from './rules.ts';

/**
 * The most a tool result should carry, in characters: the app's own agent cuts a longer one there
 * (packages/agent/src/loop.ts), and an AI over MCP cannot read much more. A query whose answer can
 * grow past it answers in parts (get_board's DRC pages, get_enclosure's parts and line ranges).
 */
export const TOOL_RESULT_CHARS = 16_000;

/* ------------------------------ diagnostics ------------------------------- */

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  /** Stable code, e.g. "ERC.PIN_UNCONNECTED", "SEM.REQUIREMENT", "LEDGER.VIOLATED". */
  code: string;
  severity: Severity;
  message: string;
  /** Entity references: "U1", "U1.BOOT", "net:+3V3", or a constraint id. */
  entities: string[];
  /** On the board: where to look (mm). */
  at?: { x: number; y: number };
  /** Ops that would resolve the problem, when the kernel can tell. */
  fixHints?: EditOp[];
  /** Datasheet / library reference backing the check. */
  source?: string;
  /** Set when a waiver covers this diagnostic. */
  waivedBy?: string;
}

export interface DiagnosticCounts {
  errors: number;
  warnings: number;
  infos: number;
  waived: number;
  /** Open findings on how the schematic is drawn (drawingFinding), which the others leave out. */
  drawing: number;
}

export function countDiagnostics(ds: Diagnostic[]): DiagnosticCounts {
  const c: DiagnosticCounts = { errors: 0, warnings: 0, infos: 0, waived: 0, drawing: 0 };
  for (const x of ds) {
    if (x.waivedBy) c.waived++;
    else if (drawingFinding(x)) c.drawing++;
    else if (x.severity === 'error') c.errors++;
    else if (x.severity === 'warning') c.warnings++;
    else c.infos++;
  }
  return c;
}

/* ------------------------------ transactions ------------------------------ */

export type RejectionCode =
  | 'INVALID_OP'
  | 'REF_UNKNOWN'
  | 'PART_UNKNOWN'
  | 'SYMBOL_STYLE'
  | 'SYMBOL_LAYOUT'
  | 'FOOTPRINT_INVALID'
  | 'BOARD_INVALID'
  | 'FAB_INVALID'
  | 'FAB_UNKNOWN'
  | 'FAB_LIMIT'
  | 'PIN_UNKNOWN'
  | 'REFDES_TAKEN'
  | 'PIN_ALREADY_CONNECTED'
  /** swap_pins outside a swap group the part card declares. */
  | 'SWAP_INVALID'
  | 'NET_MERGE_AMBIGUOUS'
  | 'NET_UNKNOWN'
  | 'NET_NAME_TAKEN'
  | 'PARAM_UNKNOWN'
  | 'PARAM_INVALID'
  | 'CONSTRAINT_CONFLICT'
  | 'CONSTRAINT_INVALID'
  | 'OUT_OF_SCOPE'
  | 'PIN_UNCONNECTED'
  | 'NET_MISMATCH'
  | 'NO_PATH'
  | 'SHEET_UNKNOWN'
  | 'SHEET_NOT_EMPTY'
  /** A board the design does not have (add_board lists them in get_summary). */
  | 'BOARD_UNKNOWN'
  /** A board op on a design of several boards that says neither the board nor a part on one. */
  | 'BOARD_AMBIGUOUS'
  | 'WAIVER_UNKNOWN'
  | 'ENCLOSURE_INVALID'
  | 'STACKUP_INVALID'
  | 'STACKUP_UNKNOWN'
  /** Drawn copper that would lie in a keep-out (draw_track, draw_via, draw_pair). */
  | 'KEEPOUT_HIT'
  /** No layer of the board can carry a line at that impedance (set_impedance). */
  | 'IMPEDANCE_IMPOSSIBLE'
  /** The route helper's results were computed for an earlier working copy (it changed meanwhile). */
  | 'STALE'
  /** import_block, import_board: a project the projects folder does not list, or one that cannot be read. */
  | 'PROJECT_UNKNOWN'
  | 'BLOCK_UNKNOWN'
  /** import_block: a boundary net of the block that is not mapped to a net of this design. */
  | 'NET_UNMAPPED';

/**
 * A query that cannot answer (design_query): the `error` in words, the `code` of an edit's rejection where
 * one applies (BOARD_UNKNOWN, BOARD_AMBIGUOUS, NET_UNKNOWN, REF_UNKNOWN, ...) and the closest valid
 * `candidates`. Some errors also carry the keys they had before (`boards`, `nets`, `projects`) for one
 * more release; read `candidates`. See docs/design/ops-api.md.
 */
export interface QueryError {
  error: string;
  code?: RejectionCode;
  candidates?: string[];
}

export interface Rejection {
  /** Index of the failing op within the transaction. */
  opIndex: number;
  code: RejectionCode;
  message: string;
  /** Closest valid alternatives for unknown references. */
  candidates?: string[];
  fixHints?: EditOp[];
}

export interface OpResult {
  op: EditOp['op'];
  /** Human-readable effect, e.g. "added C4 (generic:C)". */
  effect: string;
  /** Ids of created/affected entities. */
  ids?: string[];
  /** import_block: what came in and what to look at again (also in `effect`). */
  imported?: ImportReport;
  /** import_board: what came in, how the nets were joined, and what stayed behind (also in `effect`). */
  importedBoard?: BoardImportReport;
}

/** import_board: a board of another project copied in as a board of this design. See docs/design/ops-api.md §7. */
export interface BoardImportReport {
  project: string;
  /** The source's board, and the board of this design it became (`made`: a new one). */
  from: string;
  board: string;
  made: boolean;
  sheet: string;
  /** The new refdes of every part copied. */
  parts: string[];
  renamed: ImportReport['renamed'];
  cards: ImportReport['cards'];
  footprints: ImportReport['footprints'];
  nets: {
    /** Source nets that joined a net this design had: source name → net here. */
    joined: Record<string, string>;
    /** Nets made anew, by their name here. */
    made: string[];
    /** A net here that two or more source nets went onto: a merge. */
    merged: { net: string; from: string[] }[];
    /** Joined nets whose attributes differ here from the source's (voltage, max current …): to check. */
    recheck: { net: string; attrs: Record<string, { here: unknown; source: unknown }> }[];
    /**
     * Joined nets whose source width differs from theirs on the new board: `mm` is now set for that board
     * only (the net's own width `here`, absent: the rules'), from these source nets (several: the wider).
     */
    widths: { net: string; mm: number; here?: number; from: string[] }[];
  };
  /** The describe blocks appended, by their title here. */
  blocks: string[];
  constraints: number;
  /** What the board took over (outline, build, holes, placement, keep-outs …), and what stayed behind (copper). */
  board_settings: string[];
  left_behind: string[];
}

export interface ImportReport {
  project: string;
  block: string;
  /** Refdes and internal net names that were taken here: the source's → the new one. */
  renamed: { refdes: Record<string, string>; nets: Record<string, string> };
  /** Part ids, by where their card came from: this design or the library, or the source project's file. */
  cards: { library: string[]; project: string[] };
  /**
   * Generic parts that would have had another footprint here (the source gave the card a land pattern of
   * its own, or its package defaults differ): per part (new refdes), the `package` pinned on it, or the
   * card of its own it is on now (a copy of the source's, e.g. generic:CONN_1x2~2).
   */
  footprints: { ref: string; package?: string; card?: string }[];
  /** Values chosen for the other design: per part (new refdes), its params and why to look. */
  recheck: { ref: string; params: Record<string, string>; why: string }[];
}

export interface DiffSummary {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface TransactionResult {
  status: 'ok' | 'rejected';
  dryRun: boolean;
  results: OpResult[];
  rejection?: Rejection;
  /** Change of the working copy relative to the last committed design. */
  diff: DiffSummary;
  counts: DiagnosticCounts;
  /** Diagnostics that appeared with this transaction. */
  introduced: Diagnostic[];
  /** Diagnostics this transaction resolved. */
  resolved: Diagnostic[];
  /** While an Optimize scope is set: what the working copy looks like in and around it now. */
  scope?: ScopeOutcome;
}

/* ------------------------------- changesets ------------------------------- */

export type HunkKind = 'component' | 'part' | 'net' | 'constraint' | 'waiver' | 'mate' | 'sheet' | 'board' | 'description' | 'drawing' | 'enclosure' | 'spec';

export interface Hunk {
  /** Stable id: "<kind>:<entity id>". */
  id: string;
  kind: HunkKind;
  change: 'add' | 'remove' | 'change';
  entityId: string;
  /** Short label for review rows: "C4 100nF", "R2 10k → 10.2k". */
  title: string;
  /** Details: parameter and connection changes. */
  details: string[];
}

export interface Proposal {
  hunks: Hunk[];
  before: DiagnosticCounts;
  after: DiagnosticCounts;
}

export interface HistoryEntry {
  id: number;
  summary: string;
  by: 'user' | 'agent';
  time: string;
  hunks: number;
}

/* ------------------------------ schematic view ----------------------------- */

/** Schematic coordinates are integer mils (1/1000 inch), y grows downward, 100-mil grid. */
export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Prim =
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: boolean }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { t: 'poly'; pts: number[]; fill?: boolean; closed?: boolean }
  | { t: 'path'; d: string }
  | { t: 'circle'; x: number; y: number; r: number; fill?: boolean }
  /** A mark written on the symbol (a thermistor's θ, a varistor's U), centred on (x, y): its baseline. */
  | { t: 'text'; x: number; y: number; text: string };

export interface PinView {
  number: string;
  name: string;
  /** Connection point (end of the pin line). */
  x: number;
  y: number;
  side: 'left' | 'right' | 'top' | 'bottom';
  showName: boolean;
  showNumber: boolean;
  /** Its name runs along the pin, into the body. */
  nameAlong?: boolean;
}

export interface SymbolView {
  componentId: string;
  refdes: string;
  /** Unit letter of a split symbol ("A" → drawn as U1A). */
  unit?: string;
  value: string;
  /** The value as drawn, one entry per line (e.g. "10nF", "25V"); `valuePos` is the first line. */
  valueLines?: string[];
  bbox: Rect;
  prims: Prim[];
  pins: PinView[];
  refPos: Point & { anchor: 'start' | 'middle' | 'end' };
  valuePos: Point & { anchor: 'start' | 'middle' | 'end' };
  /**
   * Clockwise rotation in degrees (multiples of 45) applied to `prims` around `origin`.
   * `pins` and `bbox` are already given in rotated, absolute coordinates; text is never rotated.
   */
  rotation?: number;
  origin?: Point;
  /** Drawn as a two-pin part: it turns standing or lying (place_symbol orient); the others turn by quarters (place_symbol rotate). */
  twoPin?: boolean;
  /** Turned clockwise from how it is usually drawn (place_symbol rotate); `pins`, `bbox` and `prims` are already so. */
  rotated?: QuarterTurn;
  /** Drawn mirrored (place_symbol mirror): its left pins on the right; a two-pin part with pin 1 at the bottom or, lying, on the right. */
  mirrored?: boolean;
  /** The user put it where it stands (a drag or turn in the app): their decision, which the agent's redraws keep. */
  by?: 'user';
  /** The user put its name or value where they stand (a drag in the app): their decision, which place_text auto keeps. */
  textBy?: 'user';
}

export interface LabelView {
  x: number;
  y: number;
  text: string;
  netId: string;
  kind: 'net' | 'ground' | 'rail';
  /**
   * Direction the label points away from its connection point; 'on' = text sitting on a wire.
   * Supply symbols (kind rail/ground) are always vertical: 'up' or 'down'.
   */
  dir: 'left' | 'right' | 'up' | 'down' | 'on';
  /**
   * Which way the signal goes at the pin this label sits on: 'in' = into the part (the flag
   * points at the pin), 'out' = out of the part (it points away), 'io' = both. Unset = shown as 'in'.
   */
  flow?: 'in' | 'out' | 'io';
  /** Supply symbol on a horizontal lead: a stub of `stubLen` mils in this direction comes first. */
  stub?: 'left' | 'right';
  stubLen?: number;
  /** Extra stem (mils) before a supply symbol, so it clears symbols of neighbouring pins pointing the other way. */
  rise?: number;
  /** Added by the kernel: a connection the agent's drawing does not show (SheetDrawing). */
  auto?: boolean;
}

export interface WireView {
  netId: string;
  pts: number[];
  /** Added by the kernel with an automatic label (the lead to a supply symbol that must turn aside). */
  auto?: boolean;
  /** Drawn through corners the agent gave (wire via): the wire clean-up keeps its path. */
  via?: boolean;
}

/**
 * The paper sizes the layout flows onto: landscape at 1:1 (rounded to the 100 mil grid), in mils.
 * A bigger sheet takes more of the drawing per page at the same scale.
 */
export const PAPERS = {
  A4: { w: 11700, h: 8300, mm: { w: 297, h: 210 } },
  A3: { w: 16500, h: 11700, mm: { w: 420, h: 297 } },
  A2: { w: 23400, h: 16500, mm: { w: 594, h: 420 } },
} as const;
export type PaperId = keyof typeof PAPERS;
export const PAPER_IDS = Object.keys(PAPERS) as PaperId[];
export const DEFAULT_PAPER: PaperId = 'A4';

/**
 * Every page: `margin` is the border around the drawing area; `title` the height of the title
 * strip at the bottom of that area. The drawing area is therefore (w − 2·margin) × (h − 2·margin − title).
 */
export const PAGE = { margin: 300, title: 500 } as const;

/** The paper of a design (A4 unless it says otherwise). */
export const paperOf = (id?: PaperId) => PAPERS[id ?? DEFAULT_PAPER];

/**
 * One printable page of a sheet. Pages are derived by the layout from the functional blocks
 * (a regulator with its parts, an IC with its satellites…), which are never split across pages.
 */
export interface PageView {
  /** 1-based, counted across the whole design in sheet order. */
  number: number;
  /** What the page is for, e.g. "Buck converter, Connector": from the description blocks or the main parts on it. */
  name: string;
  /** The paper, in sheet coordinates. Normally the design's paper size; larger when `oversized`. */
  rect: Rect;
  /** A single block larger than the paper: the page grew to hold it, and prints scaled down. */
  oversized?: boolean;
}

/** A functional block as drawn: its frame and title (the description's block, on this sheet). */
export interface BlockView {
  title: string;
  rect: Rect;
}

export interface SheetView {
  id: string;
  name: string;
  /** Union of the pages. */
  bbox: Rect;
  pages: PageView[];
  symbols: SymbolView[];
  wires: WireView[];
  junctions: Point[];
  labels: LabelView[];
  noConnects: Point[];
  /** The functional blocks drawn on the sheet, framed (docs/design/schematic-drawing.md §2b). */
  blocks?: BlockView[];
}

export interface SchematicView {
  /** The paper the pages are cut for (set_paper). */
  paper: PaperId;
  sheets: SheetView[];
  /** Placement constraints evaluated against this layout. */
  constraintStatus: Record<string, 'ok' | 'violated' | 'not_applicable'>;
  /** Why a violated placement constraint could not be kept, where the layout can tell (a wrapped row, another page). */
  constraintWhy?: Record<string, string>;
}

/* ------------------------------- description ------------------------------ */

/** The design's description as stored, with parts by refdes (design_query get_description, the design document). */
export interface DescriptionView {
  overview: string;
  blocks: { title: string; refs: string[]; text: string }[];
  /** Parts no block covers (added since it was written). */
  undescribed: string[];
}

/* ------------------------------ query results ----------------------------- */

/** A spec item's status, worked out (docs/design/spec.md §2). */
export type SpecStatus = 'verified' | 'violated' | 'unverified' | 'waived';

/** The spec's items by status; assumed counts the items the agent wrote and the user has not confirmed, whatever their status. */
export interface SpecCounts {
  verified: number;
  violated: number;
  unverified: number;
  waived: number;
  assumed: number;
}

/** What a verifier came to: holds, fails or unknown, with one sentence why. Nets, boards and parts by name. */
export type SpecVerifierResult = SpecVerifier & { result: 'holds' | 'fails' | 'unknown'; why: string };

/** get_spec, and KernelState.spec: every item with its status and each verifier's result. */
export interface SpecAnswer {
  counts: SpecCounts;
  items: {
    id: string;
    text: string;
    source: SpecItem['source'];
    assumed: boolean;
    status: SpecStatus;
    verify: SpecVerifierResult[];
  }[];
}

export interface DesignSummary {
  name: string;
  sheets: string[];
  /** Printable pages across all sheets (derived by the layout). */
  pages: number;
  components: { refdes: string; part: string; value: string; sheet: string; board?: string }[];
  nets: { name: string; pins: number; voltage?: number; external?: boolean; boards?: string[] }[];
  /** Present when the design has several boards (add_board): each with its sheets and how many parts. */
  /** Several boards: each board with its stack-up and heating (what calc works on with board). */
  boards?: { name: string; id: string; sheets: string[]; parts: number; stackup?: DesignSummary['stackup']; currentRise?: DesignSummary['currentRise'] }[];
  /** How the boards are joined (mate): the connectors, the kind and which pin meets which ("1↔1"). */
  mates?: { id: string; a: string; b: string; kind: string; pins: string; height_mm?: number; fit?: string }[];
  counts: DiagnosticCounts;
  ledger: number;
  waivers: number;
  /** Present when the design has a spec: its items by status (get_spec lists them). */
  spec?: SpecCounts;
  /** Present when the design has a description: its blocks, and the parts none of them covers. */
  description?: { blocks: number; undescribed: string[] };
  /** Present when generic passives are held to standard-value series (set_value_series). */
  valueSeries?: ValueSeries;
  /** The board's stack-up in effect (what calc impedance works on by default). One board only: several give theirs in boards. */
  stackup?: Pick<Stackup, 'name' | 'copper' | 'dielectric' | 'mask'>;
  /** The board's allowed heating (set_board current_rise_c, °C) when not the default 10 (what calc track_current works at). One board only, as stackup. */
  currentRise?: 10 | 20 | 30;
}

/**
 * design_query get_scorecard: how good the design is right now, in a few numbers. The same design
 * gives the same text (no time, no version; keys in this order, families and codes sorted), so two
 * cards are compared as text. Nothing is routed for it. See docs/design/scorecard.md.
 */
export interface Scorecard {
  /** Open findings (not waived) by family: the code's part before the dot. Families with none are left out. */
  findings: Record<string, { errors: number; warnings: number; infos: number }>;
  waived: number;
  /** Open findings that say a check could not judge (UNKNOWN_CODES in checks.ts), by code. */
  unknown: Record<string, number>;
  // the spec's counts by status, once the design has one (docs/design/spec.md §4): not computed yet
  spec?: { verified: number; violated: number; unverified: number; waived: number; assumed: number };
  /** The ledger's constraints by strength, and how many of them are violated. */
  ledger: { hard: number; soft: number; violated: number };
  /** Parts fitted and not fitted (pad-only parts are neither), and the part cards they use. */
  parts: { fitted: number; dnp: number; cards: number };
  power: {
    rails: number;
    /** Rails whose loads and the rails they feed draw more than their max_current (the power tree's budget). */
    over: number;
    /** Rails with no voltage, no source or no budget that could be worked out. */
    unknown: number;
    /** Linear regulators above their package's limit, with the worst: "U2: 0.85 W of 0.29 W". */
    hot: { count: number; worst?: string };
  };
  boards: BoardScore[];
}

/** One board on the scorecard. Lengths in mm and ratios rounded to 0.01. */
export interface BoardScore {
  id: string;
  name: string;
  width_mm: number;
  height_mm: number;
  /** Set by the user, or what the placer proposed. */
  size_by: 'user' | 'proposal';
  layers: number;
  /** Parts on each side (mounting holes not counted). */
  parts: { top: number; bottom: number };
  /** none: never routed; stale: routed, but not for this placement (no copper to judge). The fields below are absent unless done. */
  routing: 'none' | 'stale' | 'done';
  /** Nets to route, nets routed in full, and connections left open. */
  connections?: { nets: number; routed: number; open: number };
  track_mm?: number;
  vias?: number;
  /** The copper against its nets' currents: nets by status, and the worst ratio of current to capacity. */
  current?: { ok: number; over: number; unverified: number; unknown: number; worst?: { net: string; ratio: number } };
}

/* -------------------------------- bring-up -------------------------------- */

/**
 * The bring-up sheet of the design document: the rails in the order to power them up, what each
 * should read and where to probe it, and the bench supply's current limit for the rails that come
 * in from outside. See docs/design/layout.md §4.
 */
export interface BringUpPlan {
  rails: BringUpRail[];
  /** The checks in order, as plain sentences. */
  steps: string[];
  /** Why there is nothing to bring up (no supply rails). */
  note?: string;
}

export interface BringUpRail {
  net: string;
  voltage: number | 'unknown';
  /** What makes it: "J1 (connector)", "U1 (linear regulator from +5V)", "U1 (switching regulator from +12V), through L1", or "unknown". */
  source: string;
  /** It comes in from outside (a connector or a battery): the bench supply feeds it. */
  input: boolean;
  /** On a design of several boards: the boards the rail is on, in board order (get_power_tree's `boards`). */
  boards?: string[];
  /** The mates it crosses: the board it reaches, the connectors ("J2↔J3", the source's side first), the pins that carry it, the pin to probe there. */
  crosses?: { board: string; through: string; pins: number; probeAt?: string }[];
  /** The test points on it (refdes, silkscreen label, board on several), or where to probe without one (and its board). */
  testPoints: { ref: string; label: string; board?: string }[];
  probeAt?: string;
  probeBoard?: string;
  /** Only on an input rail: what the board is expected to draw from it and the limit to set. */
  supply?: { draw_a: number | 'unknown'; basis: 'loads' | 'max_current' | 'unknown'; limit_a: number | 'unknown' };
}

/** design_query get_pinmap (packages/kernel/src/pinmap.ts, docs/design/ops-api.md §6a). */
export interface PinMap {
  mcus: PinMapMcu[];
  /** Why there is nothing to map: no MCU, or the part named is none. */
  note?: string;
}

export interface PinMapMcu {
  ref: string;
  part: string;
  /** On a design of several boards: the MCU's board. */
  board?: string;
  pins: PinMapEntry[];
  /** The GPIOs (swap group members) on no net: "PB3 (pin 2)". */
  unused: string[];
}

export interface PinMapEntry {
  /** Pin number and name. */
  pin: string;
  name: string;
  net: string;
  /** The net's needs (set_net needs), else unknown: never guessed. */
  uses: string[] | 'unknown';
  /** What the pin offers besides plain I/O, from the card's swap group (empty where the card lists none). */
  offers: string[];
  /** The other parts' pins on the net ("R5.1", "U3.SCK"), the mates' connector pins left out; on several boards with their board. */
  reaches: { pin: string; board?: string }[];
  /** On several boards: the mated pin pairs the net meets, with what is wrong where the other side is on another net or none. */
  crosses?: { mate: string; pins: string; boards: [string, string]; problem?: string }[];
  /** The problems of crosses, joined: the trace is broken there. */
  flag?: string;
  /** One line to paste: 'PB2 (pin 7) → SCK (uses SCK) → J4.1 ⇄ J5.1 → R5.1 on "LED board"'. */
  text: string;
}
