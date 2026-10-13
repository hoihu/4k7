import type { EditOp } from './ops.ts';
import type { ScopeOutcome } from './scope.ts';
import type { ValueSeries } from './model.ts';

/* ------------------------------ diagnostics ------------------------------- */

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  /** Stable code, e.g. "ERC.PIN_UNCONNECTED", "SEM.REQUIREMENT", "LEDGER.VIOLATED". */
  code: string;
  severity: Severity;
  message: string;
  /** Entity references: "U1", "U1.BOOT", "net:+3V3", or a constraint id. */
  entities: string[];
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
}

/* ------------------------------ transactions ------------------------------ */

export type RejectionCode =
  | 'INVALID_OP'
  | 'REF_UNKNOWN'
  | 'PART_UNKNOWN'
  | 'SYMBOL_STYLE'
  | 'FOOTPRINT_INVALID'
  | 'BOARD_INVALID'
  | 'FAB_INVALID'
  | 'FAB_UNKNOWN'
  | 'FAB_LIMIT'
  | 'PIN_UNKNOWN'
  | 'REFDES_TAKEN'
  | 'PIN_ALREADY_CONNECTED'
  | 'NET_MERGE_AMBIGUOUS'
  | 'NET_UNKNOWN'
  | 'NET_NAME_TAKEN'
  | 'PARAM_UNKNOWN'
  | 'PARAM_INVALID'
  | 'CONSTRAINT_CONFLICT'
  | 'CONSTRAINT_INVALID'
  | 'OUT_OF_SCOPE'
  | 'SHEET_UNKNOWN'
  | 'WAIVER_UNKNOWN';

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

export type HunkKind = 'component' | 'part' | 'net' | 'constraint' | 'waiver' | 'sheet' | 'board' | 'description' | 'drawing';

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
  | { t: 'circle'; x: number; y: number; r: number; fill?: boolean };

export interface PinView {
  number: string;
  name: string;
  /** Connection point (end of the pin line). */
  x: number;
  y: number;
  side: 'left' | 'right' | 'top' | 'bottom';
  showName: boolean;
  showNumber: boolean;
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

export interface DesignSummary {
  name: string;
  sheets: string[];
  /** Printable pages across all sheets (derived by the layout). */
  pages: number;
  components: { refdes: string; part: string; value: string; sheet: string }[];
  nets: { name: string; pins: number; voltage?: number; external?: boolean }[];
  counts: DiagnosticCounts;
  ledger: number;
  waivers: number;
  /** Present when the design has a description: its blocks, and the parts none of them covers. */
  description?: { blocks: number; undescribed: string[] };
  /** Present when generic passives are held to standard-value series (set_value_series). */
  valueSeries?: ValueSeries;
}
