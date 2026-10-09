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
