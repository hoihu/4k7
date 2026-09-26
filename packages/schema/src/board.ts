import type { PackageInfo } from './ingest.ts';

/**
 * The board: settings stored in the design, and the derived board view (placement, routing,
 * DRC) the kernel computes from the netlist and the constraint ledger. Millimetres, origin at
 * the board's top-left corner, y down, viewed from the top.
 */

export interface BoardRules {
  /** Copper-to-copper clearance. */
  clearance: number;
  /** Default signal track width. */
  track: number;
  /** Track width for supply and ground nets. */
  powerTrack: number;
  viaDrill: number;
  viaPad: number;
  /** Keep copper this far from the board edge. */
  edgeClearance: number;
}

export interface BoardSettings {
  /** Fixed outline; absent = sized to fit the placement. */
  width?: number;
  height?: number;
  layers: 2 | 4;
  rules: BoardRules;
}

export const DEFAULT_RULES: BoardRules = { clearance: 0.2, track: 0.25, powerTrack: 0.5, viaDrill: 0.3, viaPad: 0.6, edgeClearance: 0.5 };
export const DEFAULT_BOARD: BoardSettings = { layers: 2, rules: DEFAULT_RULES };

export type CopperLayer = 'F.Cu' | 'In1.Cu' | 'In2.Cu' | 'B.Cu';

export interface BoardPad {
  number: string;
  /** Centre, absolute. */
  x: number;
  y: number;
  /** Size after rotation. */
  w: number;
  h: number;
  shape: 'rect' | 'round';
  drill?: number;
  netId?: string;
  /** Copper layers the pad is on (through-hole: all). */
  layers: CopperLayer[];
}

export interface BoardPart {
  componentId: string;
  refdes: string;
  value: string;
  /** Part Card id, and orderable part number when known (BOM). */
  part: string;
  mpn?: string;
  manufacturer?: string;
  /** Package name ("0603", "SOIC-8", "LQFP100"). */
  pkg: string;
  /** Package data the footprint was built from (3D bodies come from the same). */
  pkgInfo: PackageInfo;
  x: number;
  y: number;
  /** Clockwise, degrees (0/90/180/270). */
  rot: number;
  side: 'top' | 'bottom';
  pads: BoardPad[];
  /** Body outline and courtyard, absolute axis-aligned rectangles. */
  body: { x: number; y: number; w: number; h: number };
  courtyard: { x: number; y: number; w: number; h: number };
  pin1: { x: number; y: number };
  /** Pinned by the user (a position constraint); the placer does not move it. */
  locked: boolean;
}

export interface Track {
  netId: string;
  layer: CopperLayer;
  width: number;
  /** Polyline x0,y0,x1,y1,… */
  pts: number[];
}

export interface Via {
  netId: string;
  x: number;
  y: number;
  drill: number;
  pad: number;
}

export interface RatsLine {
  netId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface BoardDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** Where to look. */
  at?: { x: number; y: number };
  entities: string[];
}

export interface BoardView {
  outline: { w: number; h: number };
  layers: CopperLayer[];
  rules: BoardRules;
  parts: BoardPart[];
  tracks: Track[];
  vias: Via[];
  /** Connections not (yet) made by copper. */
  ratsnest: RatsLine[];
  diagnostics: BoardDiagnostic[];
  stats: { nets: number; routed: number; unrouted: number; trackLength: number; vias: number };
  /** Components without a footprint (no package data). */
  missing: string[];
  /** Net id → name. */
  netNames: Record<string, string>;
}
