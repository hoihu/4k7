/**
 * The design document. Logical data (components, pins, nets) is the source of truth;
 * schematic and board geometry are derived views plus constraints.
 * See docs/design/data-model.md.
 */
import type { BoardSettings } from './board.ts';
import type { PartCard } from './part.ts';
import type { LabelView, PaperId, Point, Rect, WireView } from './results.ts';
import type { ESeries } from './units.ts';

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
  /** Packages of generic parts without their own package parameter (set_package_defaults). */
  packageDefaults?: PackageDefaults;
  /** Standard-value series generic passives are chosen from (set_value_series); absent = any value. */
  valueSeries?: ValueSeries;
  /** Paper size of the schematic pages (set_paper); absent = A4. */
  paper?: PaperId;
  /** What the design does, in words (describe): the text of the design document. */
  description?: Description;
  /**
   * The schematic drawing of the sheets the agent has taken over, by sheet id (see SheetDrawing).
   * A sheet without one is drawn by the auto-layout, afresh after every change.
   */
  drawing?: Record<string, SheetDrawing>;
}

/**
 * A sheet's schematic as the agent arranged it (docs/design/schematic-drawing.md §2a): the netlist
 * stays the truth, this is how it is drawn. Created from the auto-layout's drawing the first time
 * the agent changes the arrangement, then kept: nothing redraws it by itself. The kernel keeps it in
 * step with the netlist (parts that are gone leave, new parts are drawn in free space, wires follow
 * their pins' nets) and shows a connection the drawing does not by a net label of its own.
 * Coordinates are sheet coordinates in mils, as in the SheetView.
 */
export interface SheetDrawing {
  /** The pages, in sheet coordinates. */
  pages: Rect[];
  symbols: DrawnSymbol[];
  wires: WireView[];
  /** Net labels and supply symbols; their text is the net's name. */
  labels: Omit<LabelView, 'text' | 'auto'>[];
}

/** How a symbol is generated from its part card (@4k7/parts symbolFromSpec). */
export interface SymbolSpec {
  /** uprightSymbol instead of symbolFor (a two-pin part stacked in a column). */
  upright?: boolean;
  /** Pin 2 on top (two-pin parts). */
  flip?: boolean;
  /** Left and right pins swapped (ICs and connectors). */
  mirror?: boolean;
  /** Pin numbers drawn first on their side (a regulator's power path). */
  first?: string[];
  /** Unit index of a split symbol. */
  unit?: number;
}

export interface DrawnSymbol {
  comp: string;
  /** Unit letter of a split symbol. */
  unit?: string;
  /** The part card it was drawn from; a different card is drawn afresh. */
  part: string;
  /** A small part drawn at an IC's or connector's pins: that symbol (component id, "#unit" for a unit). It moves with it. */
  with?: string;
  spec: SymbolSpec;
  /** Where the symbol's own origin is. */
  x: number;
  y: number;
  /** Clockwise rotation in degrees (90 or -90 for a two-pin part lying down). */
  rot?: number;
  bbox: Rect;
  ref: Point & { anchor: 'start' | 'middle' | 'end' };
  value: Point & { anchor: 'start' | 'middle' | 'end' };
}

/**
 * The design in words: an overview and the functional blocks it is made of (a supply, an MCU
 * with its support parts, an interface…). Written by the agent, printed in the design document
 * next to each block's schematic and its place on the board. Text is Markdown.
 */
export interface Description {
  overview: string;
  blocks: DescriptionBlock[];
}

export interface DescriptionBlock {
  title: string;
  /** Component ids of the block's parts. */
  components: string[];
  text: string;
}

/**
 * Packages for generic parts that do not name one: per kind, and whether sizes go up
 * automatically where the value demands it (large or high-voltage capacitors, resistor power,
 * inductor and diode current). Absent: the library's (0603, IND-4x4, SOD-123 …), sizing on.
 */
export interface PackageDefaults {
  resistor?: string;
  capacitor?: string;
  electrolytic?: string;
  inductor?: string;
  diode?: string;
  led?: string;
  /** Size up where the value demands it (default true). */
  autoSize?: boolean;
}

/** The E-series values of generic resistors, capacitors and inductors are picked from, per kind. */
export interface ValueSeries {
  resistor?: ESeries;
  capacitor?: ESeries;
  inductor?: ESeries;
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
  /** Track width on the board (mm), the user's choice; absent: the signal or power width of the rules. */
  trackWidth?: number;
}

/**
 * Track width (mm) an outer-layer track needs to carry `amps` with about `riseC` °C of heating
 * (IPC-2221, 1 oz / 35 µm copper), rounded up to 0.05 mm, at least 0.15 mm.
 */
export function trackWidthFor(amps: number, riseC = 10, copperUm = 35): number {
  const areaMil2 = Math.pow(amps / (0.048 * Math.pow(riseC, 0.44)), 1 / 0.725);
  const widthMm = (areaMil2 / (copperUm / 25.4)) * 0.0254;
  return Math.max(0.15, Math.ceil(widthMm * 20 - 0.02) / 20); // (a hair over a step does not round up)
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
  | 'sch_position'
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
  /**
   * For `sch_position`: where `a` (or its unit `aUnit`) stands on the schematic: the page of its
   * sheet (1 = the sheet's first page) and the centre of its symbol, in mils from the paper's
   * top-left corner. The layout puts it there and places the rest around it.
   */
  page?: number;
  x?: number;
  y?: number;
  /** For `sch_position` of a two-pin part: standing (the layout's default) or lying. */
  orient?: 'upright' | 'lying';
  /** For `sch_position` of an IC or connector: drawn mirrored, the left side's pins on the right. */
  mirror?: boolean;
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
