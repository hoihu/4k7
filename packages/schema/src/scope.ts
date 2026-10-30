/**
 * Optimize scope: the area the user zoomed into when pressing Optimize. The kernel turns it into
 * the parts the agent may move, the parts it may only refer to, and the nets it must leave alone
 * (see docs/design/zoom-optimize.md).
 */
import type { Rect } from './results.ts';

export interface OptimizeScope {
  view: 'schematic';
  /** Sheet id. */
  sheet: string;
  /** The area, in sheet coordinates (mils). */
  rect: Rect;
  /** What the user wants improved, in their words (optional). */
  goal?: string;
}

/** Numbers the agent and the user can compare before and after a change. Lower is better. */
export interface ScopeMeasures {
  /** Crossings between wires of different nets, among the nets that touch the area's parts. */
  crossings: number;
  /** Wire corners. A wire that runs straight is easier to follow. */
  bends: number;
  /** Pins that face each other on one wire but are not in line, so the wire steps across (a divider drawn side by side). */
  jogs: number;
  /** Wires that turn, step sideways and turn back the way they came. */
  detours: number;
  /** Supply symbols and labels that run into a wire of another net, another label or a part. */
  overlaps: number;
  /** Length of those nets' wires, in inches. */
  wireIn: number;
  /** Net labels standing in for wires (a connection not drawn is a connection harder to follow). */
  labels: number;
}

/** What the agent is told about the scope when a run starts. */
export interface ScopeInfo {
  scope: OptimizeScope;
  sheetName: string;
  /** Refdes (units as "U3B") the agent may move. */
  free: string[];
  /** Refdes the agent may refer to but not move, with the reason. */
  anchored: { ref: string; why: string }[];
  /** The view held fewer than two whole parts, so the area was widened to the parts its wires lead to (`scope.rect` is the widened one). */
  widened?: { asked: Rect };
  /** Parts on the sheet outside the area (read-only context). */
  context: number;
  /** Nets with pins both inside and outside the area. */
  boundaryNets: string[];
  measures: ScopeMeasures;
}

/** Reported with every transaction result while a scope is set. */
export interface ScopeOutcome {
  /** Parts outside the area whose drawing moved (a block shifting as a whole does not count). */
  ripple: string[];
  measures: ScopeMeasures;
  /** Measures when the run started. */
  baseline: ScopeMeasures;
}

/**
 * What the user has on screen when they send a message (any message, not only Optimize): the view
 * that is open and the area of it they zoomed into, so "this area", "here" and "what I see" can be
 * resolved. Read-only: unlike a scope it restricts nothing.
 */
export type ViewInfo = AreaViewInfo | EnclosureViewInfo;

/** The schematic sheet or the 2D board, and the area of it on screen. */
export interface AreaViewInfo {
  view: 'schematic' | 'board';
  /** Schematic: the sheet shown. */
  sheetName?: string;
  /** The area on screen: schematic in mils from the sheet's origin, board in mm. */
  rect: Rect;
  /** The whole sheet or board is in view (not zoomed in). */
  whole: boolean;
  /** Schematic: the pages the area shows (numbered through the design), each with the part of it in view in mils from the paper's top-left corner (as get_schematic and place_symbol count). */
  pages?: { number: number; rect: Rect }[];
  /** Parts wholly in view (units as "U3B"). */
  parts: string[];
  /** Parts cut by the edge of the view. */
  partly: string[];
}

/** The Enclosure view with the box cut open: the plane the user looks at (board coordinates, mm). */
export interface EnclosureViewInfo {
  view: 'enclosure';
  /** The plane is across this axis, at `at_mm` along it. */
  axis: 'x' | 'y' | 'z';
  at_mm: number;
  /** The half cut away: the one the axis points to, or the other. */
  removed: '+' | '-';
  /** The pieces lifted apart (the open view). */
  opened: boolean;
}
