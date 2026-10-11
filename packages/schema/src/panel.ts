/**
 * Fabrication panels: copies of the board in a grid inside a frame, milled apart except at tabs
 * perforated with mouse bites (a row of small non-plated holes) so the boards break out cleanly.
 * The board stays the unit of design; the panel is how it is made (stored as `board.panel`,
 * resolved into a `PanelView` with the board view). Millimetres, y down, the panel's top-left
 * corner at 0, 0.
 *
 * Defaults follow JLCPCB's mouse-bite panel rules and fit Eurocircuits' customer panels (see
 * docs/design/panel.md for the sources).
 */

export type PanelSide = 'top' | 'right' | 'bottom' | 'left';
export const PANEL_SIDES: PanelSide[] = ['top', 'right', 'bottom', 'left'];

/**
 * A tab on one side of the board's bounding box, `at` the fraction along it (left to right, top
 * to bottom). It sits where that side first meets the real outline, so it fits free-form boards
 * and follows the board when it is resized.
 */
export interface PanelTab {
  side: PanelSide;
  at: number;
}

export interface PanelSettings {
  cols: number;
  rows: number;
  /** Milled channel between boards and to the frame: the router's width. */
  gap: number;
  /** Frame (rail) width per side; 0 = no rail, the boards reach the panel edge there. */
  rails: Record<PanelSide, number>;
  tabs: PanelTab[];
  /** Tab width along the edge; mouse-bite hole diameter, centre pitch, and how far the hole centres sit inside the board edge. */
  tab: { width: number; hole: number; pitch: number; inset: number };
  /** Three fiducials (1 mm copper, 2 mm mask opening) and four Ø2 mm tooling holes on the rails. */
  fiducials: boolean;
  toolingHoles: boolean;
}

export const DEFAULT_PANEL: Omit<PanelSettings, 'tabs'> = {
  cols: 2,
  rows: 2,
  gap: 2,
  rails: { top: 5, right: 5, bottom: 5, left: 5 },
  tab: { width: 5, hole: 0.5, pitch: 0.75, inset: 0.25 },
  fiducials: true,
  toolingHoles: true,
};

/** JLCPCB SMT assembly: fiducial and tooling-hole centres 3.85 mm from the panel edge. */
export const RAIL_MARK_OFFSET = 3.85;
export const FIDUCIAL = { copper: 1, mask: 2 };
export const TOOLING_HOLE = 2;

/** Tabs spread over the chosen sides of a w × h board: one on a side up to 30 mm, then one per 50 mm (at least two). */
export function autoTabs(sides: PanelSide[], w: number, h: number, perSide?: number): PanelTab[] {
  return sides.flatMap((side) => {
    const len = side === 'top' || side === 'bottom' ? w : h;
    const n = perSide ?? (len <= 30 ? 1 : Math.max(2, Math.round(len / 50)));
    return Array.from({ length: n }, (_, i) => ({ side, at: Math.round(((i + 0.5) / n) * 1000) / 1000 }));
  });
}

/** A panel resolved for a board: where the copies go and what is milled and drilled. */
export interface PanelView {
  settings: PanelSettings;
  /** Panel size. */
  w: number;
  h: number;
  /** Offset of each copy's top-left corner, row by row from the top left; copy n is the n-th (1-based). */
  copies: { dx: number; dy: number }[];
  /** The milled contours (Edge_Cuts): the material's outer edge and every opening, closed polygons (first point not repeated). The copies' own cutouts are not included. */
  edges: number[][];
  /**
   * Each tab, in panel coordinates: its rectangle x, y, w, h, the copy it belongs to (index),
   * whether it joins two copies, and the settings' tabs it stands for (indexes into
   * `settings.tabs`: a shared tab is a side's tab and the facing side's).
   */
  tabs: { x: number; y: number; w: number; h: number; copy: number; side: PanelSide; joins: boolean; src: number[] }[];
  /** Mouse-bite holes (non-plated). */
  bites: { x: number; y: number; d: number }[];
  tooling: { x: number; y: number; d: number }[];
  fiducials: { x: number; y: number; d: number; mask: number }[];
}
