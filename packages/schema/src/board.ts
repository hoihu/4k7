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
  /** Allow vias in pads (off by default: vias keep clear of every pad and of small parts' land patterns). */
  viaInPad?: boolean;
}

export interface BoardSettings {
  /** Fixed outline; absent = sized to fit the placement. */
  width?: number;
  height?: number;
  layers: 2 | 4;
  rules: BoardRules;
  /**
   * Copper planes, one net per layer: inner layers are dedicated planes, outer layers get a
   * pour. Absent = automatic (2 layers: GND on B.Cu; 4 layers: GND on In1.Cu, the main supply
   * on In2.Cu).
   */
  planes?: { netId: string; layer: CopperLayer }[];
  /** Mounting holes (board features, not parts). */
  holes?: MountingHole[];
  /** Rounded board corners: the radius (mm); absent or 0 = square corners. */
  cornerRadius?: number;
  /** Milled cutouts inside the board (openings, slots). */
  cutouts?: Cutout[];
  /**
   * The placement as last proposed or adjusted (propose_layout, place, route store it). Later
   * layouts start from it, so a change moves only what it has to. Absent: proposed afresh.
   */
  placement?: StoredPlacement;
  /** The route step: the placement key the board was routed for; routing shows while it matches. */
  routed?: string;
}

export interface StoredPlacement {
  /** The proposed outline (a size set with set_board wins). */
  outline: { w: number; h: number };
  /** Component id → centre (mm) and clockwise rotation. */
  parts: Record<string, { x: number; y: number; rot: number }>;
}

export type HoleCorner = 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';

/** Where a cutout is measured from: a board corner, the middle of an edge, or the centre. */
export type CutoutAnchor = 'top_left' | 'top' | 'top_right' | 'left' | 'center' | 'right' | 'bottom_left' | 'bottom' | 'bottom_right';

/**
 * A milled cutout (not plated): a rectangle (optionally with rounded corners), a circle, or a
 * slot (a rounded-end oblong). Its centre is given from an anchor point (default the top-left
 * corner), so a cutout anchored to an edge or corner follows the board size.
 */
export interface Cutout {
  /** "CO1", "CO2" … */
  id: string;
  shape: 'rect' | 'circle' | 'slot';
  /** Centre, mm from the anchor point (x right, y down). */
  x: number;
  y: number;
  anchor?: CutoutAnchor;
  /** rect: width; circle: diameter; slot: length, end to end. */
  w: number;
  /** rect: height; slot: width. */
  h?: number;
  /** rect: corner radius. */
  r?: number;
  /** rect, slot: rotation, degrees clockwise. */
  angle?: number;
}

/** A cutout placed on the board: absolute centre, all sizes filled in. */
export interface BoardCutout {
  id: string;
  shape: 'rect' | 'circle' | 'slot';
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  angle: number;
}

/** The absolute cutout for a board of w × h. */
export function placeCutout(c: Cutout, w: number, h: number): BoardCutout {
  const a = c.anchor ?? 'top_left';
  const ax = a.endsWith('left') ? 0 : a.endsWith('right') ? w : w / 2;
  const ay = a.startsWith('top') ? 0 : a.startsWith('bottom') ? h : h / 2;
  const hh = c.shape === 'circle' ? c.w : (c.h ?? c.w);
  return { id: c.id, shape: c.shape, x: ax + c.x, y: ay + c.y, w: c.w, h: hh, r: c.shape === 'rect' ? Math.min(c.r ?? 0, Math.min(c.w, hh) / 2) : 0, angle: c.angle ?? 0 };
}

/** Signed distance from a point to a cutout: negative inside, positive outside. */
export function cutoutDistance(c: BoardCutout, px: number, py: number): number {
  const a = (-c.angle * Math.PI) / 180;
  const dx = px - c.x;
  const dy = py - c.y;
  const x = dx * Math.cos(a) - dy * Math.sin(a);
  const y = dx * Math.sin(a) + dy * Math.cos(a);
  if (c.shape === 'circle') return Math.hypot(x, y) - c.w / 2;
  if (c.shape === 'slot') {
    const half = Math.max(0, c.w / 2 - c.h / 2);
    return Math.hypot(Math.max(Math.abs(x) - half, 0), y) - c.h / 2;
  }
  return roundedBoxDistance(x, y, c.w / 2, c.h / 2, c.r);
}

/** Signed distance to a rounded rectangle centred at the origin (half sizes hx, hy, radius r). */
function roundedBoxDistance(x: number, y: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(x) - (hx - r);
  const qy = Math.abs(y) - (hy - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** How far a point lies inside the board outline (w × h, corner radius r); negative outside. */
export function insideOutline(w: number, h: number, r: number, px: number, py: number): number {
  return -roundedBoxDistance(px - w / 2, py - h / 2, w / 2, h / 2, Math.min(r, Math.min(w, h) / 2));
}

/** A rounded rectangle as a closed polygon (flat x, y list), `seg` points per quarter circle. */
function roundedBox(cx: number, cy: number, hx: number, hy: number, r: number, angle: number, seg = 8): number[] {
  const pts: number[] = [];
  const corners: [number, number, number][] = [
    [hx - r, -(hy - r), -90],
    [hx - r, hy - r, 0],
    [-(hx - r), hy - r, 90],
    [-(hx - r), -(hy - r), 180],
  ];
  for (const [ox, oy, a0] of corners) {
    const n = r > 1e-9 ? seg : 1;
    for (let i = 0; i < n; i++) {
      const t = ((a0 + (90 * i) / Math.max(1, n - 1)) * Math.PI) / 180;
      pts.push(ox + r * Math.cos(t), oy + r * Math.sin(t));
    }
  }
  const a = (angle * Math.PI) / 180;
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) out.push(cx + pts[i]! * Math.cos(a) - pts[i + 1]! * Math.sin(a), cy + pts[i]! * Math.sin(a) + pts[i + 1]! * Math.cos(a));
  return out;
}

/** A cutout's contour as a closed polygon (flat x, y list, first point not repeated). */
export function cutoutPolygon(c: BoardCutout): number[] {
  if (c.shape === 'circle') return roundedBox(c.x, c.y, c.w / 2, c.w / 2, c.w / 2, 0, 12);
  if (c.shape === 'slot') return roundedBox(c.x, c.y, c.w / 2, c.h / 2, c.h / 2, c.angle, 12);
  return roundedBox(c.x, c.y, c.w / 2, c.h / 2, c.r, c.angle, 8);
}

/** The board outline (w × h, corner radius r) as a closed polygon. */
export function outlinePolygon(w: number, h: number, r: number): number[] {
  return roundedBox(w / 2, h / 2, w / 2, h / 2, Math.min(r, Math.min(w, h) / 2), 0, 10);
}

/** A cutout's bounding box: x0, y0, x1, y1. */
export function cutoutBounds(c: BoardCutout): [number, number, number, number] {
  const p = cutoutPolygon(c);
  const xs = p.filter((_, i) => i % 2 === 0);
  const ys = p.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export interface MountingHole {
  /** "MH1", "MH2" … */
  id: string;
  /** Drill diameter, mm. */
  d: number;
  /** Plated (with an annular ring, optionally on a net, e.g. GND) or not plated (NPTH). */
  plated: boolean;
  netId?: string;
  /** Fixed position (centre, mm from the top-left corner) … */
  x?: number;
  y?: number;
  /** … or anchored to a corner, the centre `inset` mm from both edges (follows the board size). */
  corner?: HoleCorner;
  inset?: number;
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
  /** Not plated (a mounting hole): no copper, only a keep-out of this pad's size. */
  npth?: boolean;
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
  /** Its orientation matters (diodes, polarized caps, ICs, connectors): pin 1 is marked. */
  polarized: boolean;
  /** A picture of the part from the top (from its part card), for the 3D view. */
  topImage?: { src: string; rot: 0 | 90 | 180 | 270 };
  /** Locked by the user (a hard position constraint); the placer does not move it. */
  locked: boolean;
  /** Placed where the user put it (a soft position constraint), relative to this part if set. */
  intent?: { anchor?: string };
  /** The part it belongs with (refdes): it follows that part, and a choice for it is relative to it. */
  follows?: string;
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

/**
 * Copper pour or plane of one net on one layer.
 * `shape` is the exact geometry: the outline filled, minus the cutouts (clearances to other
 * nets, thermal-relief rings, removed islands), plus the relief spokes. `rects` is the same
 * area on the router's grid (x, y, w, h flattened), used for checks and the 3D view.
 */
export interface Zone {
  netId: string;
  layer: CopperLayer;
  rects: number[];
  shape?: ZoneShape;
}

export type ZoneCut =
  | { k: 'circle'; x: number; y: number; d: number }
  | { k: 'rect'; x: number; y: number; w: number; h: number }
  | { k: 'stroke'; pts: number[]; w: number };

export interface ZoneShape {
  /** Filled rectangle x0, y0, x1, y1. */
  outline: [number, number, number, number];
  cuts: ZoneCut[];
  /** Copper drawn back after the cuts (thermal-relief spokes). */
  adds: { pts: number[]; w: number }[];
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
  zones: Zone[];
  /** Planes in effect (net, layer; automatic or set with set_plane). */
  planes: { netId: string; layer: CopperLayer; auto: boolean }[];
  /** Connections not (yet) made by copper. */
  ratsnest: RatsLine[];
  diagnostics: BoardDiagnostic[];
  stats: { nets: number; routed: number; unrouted: number; trackLength: number; vias: number };
  /** Components without a footprint (no package data). */
  missing: string[];
  /** Net id → name. */
  netNames: Record<string, string>;
  /** Routing: not done yet, done for an earlier placement (out of date), or done for this one. */
  routing: 'none' | 'stale' | 'done';
  /** Identifies this placement (parts, nets, outline, rules); the route step records it. */
  placementKey: string;
  /** The outline: proposed by the placer, or set by the user. */
  sizeBy: 'proposal' | 'user';
  /** Rounded board corners (radius, mm; 0 = square). */
  cornerRadius: number;
  /** Milled cutouts, placed on this outline. */
  cutouts: BoardCutout[];
}

/** Compact board description for agents (design_query get_board). */
export function boardSummary(b: BoardView, routed = true) {
  return {
    outline_mm: b.outline,
    layers: b.layers.length,
    rules: b.rules,
    outline_by: b.sizeBy,
    parts: b.parts.map((p) => ({ refdes: p.refdes, package: p.pkg, x: p.x, y: p.y, rot: p.rot, placed: p.locked ? 'locked' : p.intent ? `user${p.intent.anchor ? ` (relative to ${p.intent.anchor})` : ''}` : 'auto' })),
    routing: !routed
      ? 'not computed here (see the Layout view)'
      : b.routing === 'done'
        ? { nets: b.stats.nets, routed: b.stats.routed, unrouted_connections: b.stats.unrouted, vias: b.stats.vias, track_mm: b.stats.trackLength }
        : b.routing === 'stale'
          ? 'out of date: the placement changed since the route step (route again when the placement is final)'
          : 'not routed yet (the route op, once the placement is final)',
    planes: b.planes.map((p) => ({ net: b.netNames[p.netId] ?? p.netId, layer: p.layer, dedicated: p.layer !== 'F.Cu' && p.layer !== 'B.Cu', automatic: p.auto })),
    mounting_holes: b.parts.filter((p) => p.componentId.startsWith('hole:')).map((p) => ({ id: p.refdes, x: p.x, y: p.y, diameter: p.pads[0]?.drill, plated: !p.pads[0]?.npth })),
    corner_radius_mm: b.cornerRadius,
    cutouts: b.cutouts.map((c) => ({ id: c.id, shape: c.shape, x: c.x, y: c.y, ...(c.shape === 'circle' ? { diameter: c.w } : { w: c.w, h: c.h }), ...(c.r ? { corner_radius: c.r } : {}), ...(c.angle ? { angle: c.angle } : {}) })),
    drc: b.diagnostics.map((x) => `${x.severity}: ${x.message}`),
    missing_footprints: b.missing,
    note: 'Workflow: propose_layout (board size and placement), then adjustments (place = the user\'s choice for a part, kept relative to its parent part; lock: true pins it exactly; set_board for the size), then route as the last step. Later changes keep the placement and move only what they must; routing then shows as out of date until route runs again. Keep parts together with constrain near, choose planes with set_plane (inner layers are dedicated planes, outer layers get a pour).',
  };
}
