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
}
