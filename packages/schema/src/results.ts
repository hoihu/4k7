import type { EditOp } from './ops.ts';

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
}

/* ------------------------------- changesets ------------------------------- */

export type HunkKind = 'component' | 'net' | 'constraint' | 'waiver' | 'sheet';

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
  /** Supply symbol on a horizontal lead: a stub of `stubLen` mils in this direction comes first. */
  stub?: 'left' | 'right';
  stubLen?: number;
}

export interface WireView {
  netId: string;
  pts: number[];
}

export interface SheetView {
  id: string;
  name: string;
  bbox: Rect;
  symbols: SymbolView[];
  wires: WireView[];
  junctions: Point[];
  labels: LabelView[];
  noConnects: Point[];
}

export interface SchematicView {
  sheets: SheetView[];
  /** Placement constraints evaluated against this layout. */
  constraintStatus: Record<string, 'ok' | 'violated' | 'not_applicable'>;
}

/* ------------------------------ query results ----------------------------- */

export interface DesignSummary {
  name: string;
  sheets: string[];
  components: { refdes: string; part: string; value: string; sheet: string }[];
  nets: { name: string; pins: number; voltage?: number; external?: boolean }[];
  counts: DiagnosticCounts;
  ledger: number;
  waivers: number;
}
