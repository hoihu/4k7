import type { PackageInfo, SymbolLayout } from './ingest.ts';

/**
 * Part Cards: the library format. A card describes a part logically (pins, parameters,
 * datasheet requirements). Geometry (symbol, later footprint) is generated from it.
 */

export type PinType =
  | 'in'
  | 'out'
  | 'bidir'
  | 'tri'
  | 'pwr_in'
  | 'pwr_out'
  | 'passive'
  | 'oc' // open collector / open drain
  | 'nc'; // not internally connected

export type PinSide = 'left' | 'right' | 'top' | 'bottom';

export interface PartPin {
  /** Physical pin number as printed in the datasheet ("1", "A3", "EP"). */
  number: string;
  /** Pin name ("VIN", "PB0"). Several pins may share a name (e.g. multiple GND). */
  name: string;
  type: PinType;
  /** Preferred side on the generated symbol. The generator picks one if absent. */
  side?: PinSide;
  /** Absolute maximum voltage relative to ground, used by semantic ERC. */
  maxVoltage?: number;
  description?: string;
  /** Datasheet page this pin was read from (imported parts). */
  page?: number;
}

export type PartCategory =
  | 'resistor'
  | 'capacitor'
  | 'inductor'
  | 'diode'
  | 'led'
  | 'ic'
  | 'connector'
  | 'transistor'
  | 'crystal'
  | 'other';

export interface ParamSpec {
  /** SI unit symbol for engineering values ("F", "Ω", "V", "A", "H"); absent for free text. */
  unit?: string;
  required?: boolean;
  description?: string;
  /** A choice: the values it may take (an inductor's core: ferrite, iron, air). */
  values?: string[];
}

/**
 * Parameters every component has, whatever its card: sourcing, one per assembly house with its own
 * numbers (the `param` of its entry in sourcing.ts). `lcsc` is the LCSC / JLCPCB part number
 * ("C25804") of the exact part to assemble; `eurocircuits` the part Eurocircuits assembles, its
 * generic number ("GPR06034K7") or a manufacturer part number from its database. For a generic
 * resistor or capacitor it is the whole sourcing decision (the symbol stays generic), for an imported
 * IC it names the stocked variant.
 */
export const UNIVERSAL_PARAMS: Record<string, ParamSpec> = {
  lcsc: { description: 'LCSC / JLCPCB part number of the exact part to assemble, e.g. "C25804" (the sourcing tool finds one)' },
  eurocircuits: { description: 'Eurocircuits part to assemble: its generic number, e.g. "GPR06034K7", or a manufacturer part number (the sourcing tool finds one; without it Eurocircuits orders the MPN)' },
};

/** The parameters a component of this card may carry: the card's own plus the universal ones. */
export function paramSpecs(card: Pick<PartCard, 'params'>): Record<string, ParamSpec> {
  return { ...card.params, ...UNIVERSAL_PARAMS };
}

/** "c25804" → "C25804"; null when it is not an LCSC number. */
export function normalizeLcsc(s: string): string | null {
  const m = /^\s*[cC]?\s*(\d{1,10})\s*$/.exec(s);
  return m ? `C${m[1]}` : null;
}

/** Where a fact came from. M0 seeds carry `builtin`; ingested parts carry page + bbox. */
export interface Provenance {
  source: 'builtin' | 'datasheet' | 'user';
  document?: string;
  page?: number;
  bbox?: [number, number, number, number];
  note?: string;
}

export type PartRequirement =
  | {
      kind: 'cap_between';
      pins: [string, string];
      /** Nominal value, e.g. "100nF". */
      value: string;
      note?: string;
      src?: Provenance;
    }
  | {
      kind: 'decouple';
      /** Pin name whose net must be decoupled to ground. */
      pin: string;
      /** Minimum total capacitance to ground on that net, e.g. "10uF". */
      min: string;
      note?: string;
      src?: Provenance;
    }
  | {
      kind: 'pull';
      pin: string;
      direction: 'up' | 'down';
      note?: string;
      src?: Provenance;
    };

export interface PartCard {
  /** Library id, "<namespace>:<name>", e.g. "ti:TPS54331DR" or "generic:C". */
  id: string;
  mpn?: string;
  /** What a person calls the part ("Raspberry Pi Pico", "Buzzer 12 mm"); the list shows it before the part number. */
  title?: string;
  manufacturer?: string;
  description: string;
  category: PartCategory;
  /** Reference designator prefix: U, C, R, L, D, J, Q, Y. */
  refPrefix: string;
  package?: string;
  pins: PartPin[];
  params: Record<string, ParamSpec>;
  requirements?: PartRequirement[];
  datasheet?: string;
  provenance: Provenance;
  /** Short hints that help the agent use the part correctly. */
  notes?: string[];
  /** Where the datasheet's sections are (PDF pages), for reading it while designing with the part. */
  datasheetPages?: DatasheetPages;
  /** Mechanical package data (from the datasheet); footprints are generated from it. */
  packageInfo?: PackageInfo;
  /** Explicit symbol arrangement (generated for large ICs such as MCUs, or given with set_symbol layout). */
  symbolLayout?: SymbolLayout;
  /** `symbolLayout` was arranged on purpose (set_symbol layout, e.g. like a reference drawing), not generated; it goes back to the library part. */
  customSymbol?: boolean;
  /** Pin descriptions were given on purpose (set_pin_descriptions), not read at import; they go back to the library part. */
  customPinText?: boolean;
  /**
   * Split symbol for big ICs: each unit is drawn as its own symbol (U1A, U1B …) with the
   * pins of its layout. Every pin belongs to exactly one unit. Overrides `symbolLayout`.
   */
  units?: SymbolUnit[];
  /** A picture of the part seen from the top (cropped from its datasheet), shown on its 3D body. */
  topImage?: TopImage;
  /**
   * Which way round the part goes, where its pins' names do not say it (set_polarity): the board
   * marks pin 1, the cathode or the plus terminal (`pin`, by number), or nothing for a part that
   * fits either way round. Without it the pins' names decide (K and A, + and −; pin 1 for the rest).
   */
  polarity?: { mark: 'pin1' | 'cathode' | 'plus' | 'none'; pin?: string };
}

/** PDF pages of a datasheet's sections, as the importer found them. */
export interface DatasheetPages {
  pinout?: number[];
  package?: number[];
  /** Typical application circuits, reference schematics. */
  application?: number[];
  /** Design procedure, component selection, formulas. */
  design?: number[];
  /** Layout guidelines and examples. */
  layout?: number[];
}

export interface TopImage {
  /** The picture: a data URL (JPEG). */
  src: string;
  /** Datasheet page it was cropped from. */
  page: number;
  /** Clockwise quarter turns to match the footprint (pin 1 top left). */
  rot: 0 | 90 | 180 | 270;
}

export interface SymbolUnit {
  /** Unit letter, "A", "B" … */
  name: string;
  /** What the unit holds, e.g. "Power", "PA, PB". */
  title: string;
  layout: SymbolLayout;
}
