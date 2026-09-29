/**
 * The design document. Logical data (components, pins, nets) is the source of truth;
 * schematic and board geometry are derived views plus constraints.
 * See docs/design/data-model.md.
 */
import type { BoardSettings } from './board.ts';
import type { PartCard } from './part.ts';

export const DESIGN_FORMAT_VERSION = 2;

export interface Design {
  format: typeof DESIGN_FORMAT_VERSION;
  name: string;
  /** Monotonic counter for deterministic entity ids. */
  seq: number;
  /** Part Cards used by this design, embedded so the project is self-contained. */
  parts: Record<string, PartCard>;
  components: Record<string, Component>;
  nets: Record<string, Net>;
  sheets: Record<string, Sheet>;
  ledger: Record<string, Constraint>;
  waivers: Record<string, Waiver>;
  /** Board settings (outline, layers, rules); absent = defaults, outline sized to fit. */
  board?: BoardSettings;
}

export interface Component {
  id: string;
  refdes: string;
  /** Part Card id. */
  part: string;
  sheet: string;
  /** Engineering parameters as entered ("100nF", "25V", "0805"). */
  params: Record<string, string>;
  /** Pin number → net id. Unconnected pins are absent. */
  pins: Record<string, string>;
  /** Pin numbers deliberately left unconnected. */
  noConnect: string[];
  dnp?: boolean;
}

export interface NetAttrs {
  /** Nominal DC voltage of the net, used by semantic ERC. */
  voltage?: number;
  /** Driven from outside the design (connector input). Counts as a power source. */
  external?: boolean;
  /** Treat as a power rail (drawn with power symbols). */
  power?: boolean;
  /** Expected maximum current in amps. */
  maxCurrent?: number;
}

export interface Net {
  id: string;
  name: string;
  attrs: NetAttrs;
}

export interface Sheet {
  id: string;
  name: string;
  order: number;
}

export type ConstraintKind =
  | 'left_of'
  | 'right_of'
  | 'above'
  | 'below'
  | 'near'
  | 'param'
  | 'layer'
  | 'arrangement'
  | 'position'
  | 'note';

export type ConstraintDomain = 'schematic' | 'placement' | 'routing' | 'electrical' | 'param';

export interface Constraint {
  id: string;
  kind: ConstraintKind;
  /** Component ids for `a`/`b`; see ops.ts for the per-kind argument shapes. */
  a?: string;
  b?: string;
  /** Unit letters when a/b address one unit of a split symbol ("U3B" → a = U3, aUnit = "B"). */
  aUnit?: string;
  bUnit?: string;
  /** For `param`: the parameter name; for `layer`: "top" | "bottom". */
  key?: string;
  value?: string;
  /** For `near`: maximum distance in mm (board). */
  maxMm?: number;
  /**
   * For `position`: board position of `a` (centre, mm) and clockwise rotation (absent: the
   * placer picks it). Hard = locked there; soft = the user's choice, which the placer keeps but
   * may nudge. With `rel`, soft positions are relative to that component: offset and rotation in
   * its frame, so the part follows when it moves or turns.
   */
  xMm?: number;
  yMm?: number;
  rot?: number;
  rel?: string;
  domain: ConstraintDomain;
  strength: 'hard' | 'soft';
  source: ConstraintSource;
  text?: string;
}

export interface ConstraintSource {
  type: 'user' | 'agent' | 'drag' | 'recipe';
  /** The words that produced this entry, for traceability. */
  quote?: string;
}

export interface Waiver {
  id: string;
  code: string;
  /** Entity references the waiver covers (refdes, "U1.EN", "net:+3V3"). */
  entities: string[];
  reason: string;
  by: 'user' | 'agent';
}

export function emptyDesign(name = 'untitled'): Design {
  return {
    format: DESIGN_FORMAT_VERSION,
    name,
    seq: 2,
    parts: {},
    components: {},
    nets: {},
    sheets: { s_1: { id: 's_1', name: 'Main', order: 0 } },
    ledger: {},
    waivers: {},
  };
}
