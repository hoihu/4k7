import type { PackageInfo } from './ingest.ts';
import type { PartCategory } from './part.ts';
import { fabSummary, type FabProfile } from './fab.ts';
import type { PanelSettings, PanelView } from './panel.ts';
import { boardFacing, matingOf, type BoardFacing } from './enclosure.ts';

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
  /** The manufacturer the board is made by: its limits, checked by the DRC (set_fab_profile). Absent = none chosen. */
  fab?: FabProfile;
  /**
   * Copper planes: inner layers are dedicated planes, outer layers get a pour. One net fills a
   * layer; on an inner layer, planes with an area cover only that part of it (+3V3 under the MCU)
   * and the layer's full plane goes round them. Absent = automatic (2 layers: GND on B.Cu;
   * 4 layers: GND on In1.Cu, the main supply on In2.Cu).
   */
  planes?: { netId: string; layer: CopperLayer; area?: PlaneArea; style?: PlaneStyle }[];
  /** Mounting holes (board features, not parts). */
  holes?: MountingHole[];
  /** Vias placed on purpose (add_vias): thermal vias in a pad, stitching over an area, a fence round one, given spots. */
  vias?: ViaGroup[];
  /** Connections laid by the agent (the track op): the router lays them first, as asked, and never rips them up. */
  tracks?: DrawnTrack[];
  /**
   * Copper the agent locked (lock_copper): a net's routed tracks and vias as they lay, kept as
   * they are. The router lays what still holds on the board as it is (nothing a moved part broke
   * away from) before anything else, and never rips it up.
   */
  locked?: LockedCopper[];
  /** Areas the router keeps its copper out of (add_keepout), but for the nets let through. */
  keepouts?: Keepout[];
  /** Rounded board corners: the radius (mm); absent or 0 = square corners. */
  cornerRadius?: number;
  /**
   * A free-form outline (set_outline): a closed polygon, flat x, y list in mm, its bounding box
   * starting at 0, 0 and as big as width × height. Absent: the (rounded) rectangle.
   */
  shape?: number[];
  /** Milled cutouts inside the board (openings, slots). */
  cutouts?: Cutout[];
  /** Graphics on the silkscreen (logos, clipart, decoration). */
  graphics?: SilkGraphic[];
  /** The fabrication panel the board is made in (set_panel). Absent: single boards. */
  panel?: PanelSettings;
  /**
   * The placement as last proposed or adjusted (propose_placement, place, route store it). Later
   * layouts start from it, so a change moves only what it has to. Absent: proposed afresh.
   */
  placement?: StoredPlacement;
  /** The route step: the placement key the board was routed for; routing shows while it matches. */
  routed?: string;
  /**
   * The router's result for the placement it was routed for, kept so a board is routed once, not
   * every time it is shown (routing a big board to completion takes a while). A cache, not a
   * change of its own: it is written when routing finishes and ignored once the key differs.
   */
  copper?: StoredCopper;
}

/**
 * The part of an inner layer a plane covers (set_plane under / rect): under some parts (their
 * courtyards' box plus a margin, so it follows them when they move), or a rectangle in mm.
 */
export interface PlaneArea {
  /** Component ids. */
  under?: string[];
  /** Around the parts, mm (default PLANE_AREA_MARGIN). */
  margin?: number;
  /** x0, y0, x1, y1 in mm. */
  rect?: [number, number, number, number];
}
export const PLANE_AREA_MARGIN = 1.5;

/**
 * How a plane (or pour) is shaped (set_plane_style), where it differs from the defaults. Distances
 * in mm; never below the board's own clearance and edge clearance.
 */
export interface PlaneStyle {
  /** An area plane: the gap to the plane round it (default: the board's clearance). */
  gap?: number;
  /** From other nets' pads, tracks and vias (default: the board's clearance). */
  clearance?: number;
  /** Pulled back from the board edge and cutouts (default: the board's edge clearance). */
  edge?: number;
  /** Thermal reliefs round the net's own pads and vias (default true); false: joined solid. */
  thermal?: boolean;
  /** Width of the relief spokes. */
  spoke?: number;
}

/** Why a connection stayed open (the router's probe: what its way would have to cross). */
export interface RouteBlockage {
  /** Nets (ids) whose copper lies across its way. */
  blockedBy?: string[];
  /** Where it first runs into that copper (mm), and on which layer. */
  at?: { x: number; y: number; layer: CopperLayer };
  /** No way even with every track and via taken away: pads, keep-outs or the board edge close it off. */
  enclosed?: boolean;
  /** The net is joined through a plane on this layer, and a pad found no room for its via down to it. */
  plane?: CopperLayer;
}

/** A routed board as stored (see BoardSettings.copper). Pads are counted through all parts' pads in board order. */
export interface StoredCopper {
  /** The placement, rules and net widths it was routed for. */
  key: string;
  tracks: Track[];
  vias: Via[];
  zones: Zone[];
  /** Per pad: the group of pads its copper joins (equal numbers: connected). */
  groups: number[];
  /** Connections left open (pad indices), with what blocks them. */
  open: ({ netId: string; a: number; b: number } & RouteBlockage)[];
  nets: number;
  netsDone: number;
  timedOut: boolean;
  /** Routing passes it took. */
  passes: number;
  /** The user stopped the routing: this is the best pass it had finished (or nothing routed). */
  stopped?: boolean;
  /**
   * What it was routed under, so the next route keeps what still holds (incremental routing): the
   * board's hash (outline, layers, rules) and one per net (its width, current and planes). A net
   * whose hash differs is routed again; another board hash routes everything again.
   */
  basis?: { board: string; nets: Record<string, string> };
  /** Copper taken over from the routing before it (incremental routing), as it lies in this one. */
  reused?: { tracks: number; vias: number };
  /** The tracks the agent laid (BoardSettings.tracks): laid as asked, or why not. */
  drawn?: DrawnStatus[];
  /** Per net with locked copper (BoardSettings.locked): its tracks and vias, and how many of them still hold. */
  locked?: LockedStatus[];
}

/** How much of a net's locked copper still holds on the board (RouteResult.locked). */
export interface LockedStatus {
  netId: string;
  tracks: number;
  vias: number;
  heldTracks: number;
  heldVias: number;
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

/**
 * A graphic on the silkscreen, from an SVG path: filled (inner figures cut holes, even-odd, as in a
 * logo) or drawn as outlines. Its figures are stored in mm centred on 0, 0; it is placed like a
 * cutout (centre from an anchor point, turned by `angle`).
 */
export interface SilkGraphic {
  /** "G1", "G2" … */
  id: string;
  name?: string;
  side: 'top' | 'bottom';
  mode: 'fill' | 'outline';
  /** outline: the line width (mm). */
  line?: number;
  /** Text drawn in the stroke font (outline figures, each stroke out and back; mirrored on the bottom). */
  text?: string;
  /** Closed figures, flat x, y lists in mm around 0, 0 (y down), not yet turned. */
  polys: number[][];
  /** Size of the figures' bounding box (mm). */
  w: number;
  h: number;
  /** Centre, mm from the anchor point. */
  x: number;
  y: number;
  anchor?: CutoutAnchor;
  /** Rotation, degrees clockwise. */
  angle?: number;
}

/** Saved artwork (artwork library): a graphic's figures, centred, in mm at its saved size. */
export interface Artwork {
  /** Stable key, e.g. "snowflake-fern". */
  id: string;
  name: string;
  mode: 'fill' | 'outline';
  line?: number;
  polys: number[][];
  w: number;
  h: number;
  /** Where it came from: "board G3", "logo.svg". */
  source?: string;
  /** A traced picture: the picture (a data URL, scaled down) and the settings, so it can be adjusted later. */
  raster?: { src: string; widthMm: number; dotMm: number; threshold: number; invert: boolean; dither: boolean };
}

/** A silkscreen graphic placed on the board: absolute figures. */
export interface BoardGraphic {
  id: string;
  name?: string;
  side: 'top' | 'bottom';
  mode: 'fill' | 'outline';
  line: number;
  /** A text graphic's text. */
  text?: string;
  polys: number[][];
  /** x0, y0, x1, y1 */
  bounds: [number, number, number, number];
  /** Whether it lies wholly on the board (inside the outline, outside every cutout). */
  inside?: boolean;
  /** Parts it lies over (their courtyards); ink is kept off pads but covers the rest. */
  over?: string[];
}

/**
 * The bounding box (x0, y0, x1, y1) of flat x, y point lists. A loop, not Math.min(...xs): a
 * picture or a detailed outline has more points than a call can take arguments.
 */
export function pointBounds(lists: number[][]): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of lists) {
    for (let i = 0; i + 1 < p.length; i += 2) {
      const [x, y] = [p[i]!, p[i + 1]!];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return [x0, y0, x1, y1];
}

/** The absolute graphic for a board of w × h. */
export function placeGraphic(g: SilkGraphic, w: number, h: number): BoardGraphic {
  const a = g.anchor ?? 'top_left';
  const cx = (a.endsWith('left') ? 0 : a.endsWith('right') ? w : w / 2) + g.x;
  const cy = (a.startsWith('top') ? 0 : a.startsWith('bottom') ? h : h / 2) + g.y;
  const t = ((g.angle ?? 0) * Math.PI) / 180;
  const [c, s] = [Math.cos(t), Math.sin(t)];
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const polys = g.polys.map((p) => p.map((v, i) => (i % 2 === 0 ? r3(cx + v * c - p[i + 1]! * s) : r3(cy + p[i - 1]! * s + v * c))));
  return {
    id: g.id,
    ...(g.name ? { name: g.name } : {}),
    side: g.side,
    mode: g.mode,
    line: g.line ?? 0.2,
    ...(g.text ? { text: g.text } : {}),
    polys,
    bounds: pointBounds(polys),
  };
}

/** How deeply each figure is nested in the others (0 = outermost): even = ink, odd = a hole, when filled. */
export function figureDepths(polys: number[][]): number[] {
  const inside = (x: number, y: number, p: number[]) => {
    let hit = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const [xi, yi, xj, yj] = [p[i]!, p[i + 1]!, p[j]!, p[j + 1]!];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  // a point just inside each figure (off its first edge's middle), so figures touching at a corner
  // (traced pixel art) are told apart reliably
  const probe = (p: number[]): [number, number] => {
    const [x0, y0, x1, y1] = [p[0]!, p[1]!, p[2]!, p[3]!];
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const e = len * 1e-3;
    const [mx, my, nx, ny] = [(x0 + x1) / 2, (y0 + y1) / 2, -(y1 - y0) / len, (x1 - x0) / len];
    return inside(mx + nx * e, my + ny * e, p) ? [mx + nx * e, my + ny * e] : [mx - nx * e, my - ny * e];
  };
  // only figures whose box holds the probe can contain it: a coarse grid of boxes keeps traced
  // pictures (thousands of dots) fast
  const boxes = polys.map((p) => {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 1 < p.length; i += 2) {
      x0 = Math.min(x0, p[i]!);
      x1 = Math.max(x1, p[i]!);
      y0 = Math.min(y0, p[i + 1]!);
      y1 = Math.max(y1, p[i + 1]!);
    }
    return [x0, y0, x1, y1] as const;
  });
  const gx0 = Math.min(...boxes.map((b) => b[0]));
  const gy0 = Math.min(...boxes.map((b) => b[1]));
  const span = Math.max(Math.max(...boxes.map((b) => b[2])) - gx0, Math.max(...boxes.map((b) => b[3])) - gy0, 1e-9);
  const n = Math.max(1, Math.min(64, Math.round(Math.sqrt(polys.length))));
  const cell = (v: number, o: number) => Math.min(n - 1, Math.max(0, Math.floor(((v - o) / span) * n)));
  const grid = new Map<number, number[]>();
  boxes.forEach((b, i) => {
    for (let cx = cell(b[0], gx0); cx <= cell(b[2], gx0); cx++) {
      for (let cy = cell(b[1], gy0); cy <= cell(b[3], gy0); cy++) {
        const k = cy * n + cx;
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      }
    }
  });
  return polys.map((p, k) => {
    const [x, y] = probe(p);
    let depth = 0;
    for (const m of grid.get(cell(y, gy0) * n + cell(x, gx0)) ?? []) {
      const b = boxes[m]!;
      if (m !== k && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && inside(x, y, polys[m]!)) depth++;
    }
    return depth;
  });
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

/** Signed distance from a point to a polygon's edge: positive inside, negative outside. */
export function insidePolygon(poly: number[], px: number, py: number): number {
  let inside = false;
  let best = Infinity;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi, xj, yj] = [poly[2 * i]!, poly[2 * i + 1]!, poly[2 * j]!, poly[2 * j + 1]!];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    const dx = xj - xi;
    const dy = yj - yi;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - xi) * dx + (py - yi) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(px - (xi + t * dx), py - (yi + t * dy)));
  }
  return inside ? best : -best;
}

/** The board outline as a polygon: the free-form shape, else the (rounded) rectangle. */
export function boardPolygon(b: { outline: { w: number; h: number }; cornerRadius?: number; shape?: number[] | null }): number[] {
  return b.shape ?? outlinePolygon(b.outline.w, b.outline.h, b.cornerRadius ?? 0);
}

/** How far a point lies inside the board outline (negative outside). */
export function insideBoard(b: { outline: { w: number; h: number }; cornerRadius?: number; shape?: number[] | null }, px: number, py: number): number {
  return b.shape ? insidePolygon(b.shape, px, py) : insideOutline(b.outline.w, b.outline.h, b.cornerRadius ?? 0, px, py);
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

/**
 * Vias the agent places on purpose, of one net (add_vias). `pad`: a grid filling a pad (thermal
 * vias under an exposed pad; they move with the part and may sit in the pad). `points`: at those
 * spots. Both are copper before the routing. `grid`: stitching, a grid over an area; `fence`: a row
 * round an area's edge (RF shielding): laid after the routing wherever a via fits and joins the
 * net's planes on two layers or more.
 */
export interface ViaGroup {
  /** "V1", "V2" … */
  id: string;
  netId: string;
  kind: ViaKind;
  /** pad, drop: the component and pad number. */
  pad?: { componentId: string; number: string };
  /** grid, fence: the area, as for an area plane (under parts, or a rectangle). */
  area?: PlaneArea;
  /** points: centres, mm; tie: the spot (one point). */
  points?: [number, number][];
  /**
   * drop: the vias' centres relative to the pad's centre, mm, in the footprint's own frame (as
   * on the top side, not turned), so they move and turn with the part.
   */
  offsets?: [number, number][];
  /** tie: the current it carries (A), default the net's max_current, sets how many vias; drop: checked against the vias given. */
  amps?: number;
  /** drop, before the agent placed each via (older designs): how many. Nothing is laid for it now. */
  count?: number;
  /** Centre to centre, mm (pad, grid, fence). */
  pitch?: number;
  /** Drill and pad diameter, mm; default: the board's via. */
  drill?: number;
  size?: number;
}
export type ViaKind = 'pad' | 'points' | 'grid' | 'fence' | 'tie' | 'drop';

/**
 * A connection laid by the agent (the track op): pad to pad through the given points, at the
 * width given (else the net's), on the layers given (else the router's choice). The router finds
 * the exact way between the points, keeping the clearances, before anything else is routed.
 */
export interface DrawnTrack {
  /** "T1", "T2" … */
  id: string;
  netId: string;
  from: { componentId: string; number: string };
  to: { componentId: string; number: string };
  /** The layer it runs on from its start (absent: the router's choice, with vias where it likes). */
  layer?: CopperLayer;
  /** mm; absent: the net's width (its own, else the power or signal width). */
  width?: number;
  /**
   * The points it goes through, in order: each relative to the end pad it was nearer when laid
   * (mm from that pad's centre, not turned with the part), so it moves with that part; `layer`:
   * the layer it goes on from there (a via at the point where it changes).
   */
  through?: { end: 'from' | 'to'; dx: number; dy: number; layer?: CopperLayer }[];
}

/**
 * An area the router keeps copper out of (add_keepout): no tracks, vias or pours, on `layers` (all
 * when absent), but for the nets in `except`; one under parts also lets their own nets through
 * (they must reach their pads).
 */
export interface Keepout {
  /** "K1", "K2" … */
  id: string;
  area: PlaneArea;
  layers?: CopperLayer[];
  /** Net ids that may still run there. */
  except?: string[];
}

/** One net's locked copper (BoardSettings.locked): its tracks and vias as they lay when locked. */
export interface LockedCopper {
  netId: string;
  tracks: Track[];
  vias: Via[];
}

/** Whether a drawn track could be laid as asked, and if not why and where (RouteResult.drawn). */
export interface DrawnStatus {
  id: string;
  laid: boolean;
  why?: string;
  at?: { x: number; y: number };
  /** The net (id) whose copper is in the way, where one is. */
  blockedBy?: string;
}
/** Default pitch per kind, mm (tie, drop: 0, as close as vias may stand). */
export const VIA_PITCH: Record<ViaKind, number> = { pad: 1, points: 0, grid: 3, fence: 2, tie: 0, drop: 0 };

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
  /** Drill diameter; a slot's width (its narrow side). */
  drill?: number;
  /** A slotted (oval) hole: its extent after rotation, round-ended along the longer side. */
  slot?: { w: number; h: number };
  /** Further pins on this pad (pins the part lands on one pad, a USB-C GND pad is A1 and B12). */
  also?: string[];
  /** Not plated (a mounting hole): no copper, only a keep-out of this pad's size. */
  npth?: boolean;
  netId?: string;
  /** Copper layers the pad is on (through-hole: all). */
  layers: CopperLayer[];
}

/**
 * A round pad as the capsule it is: the centre line along its longer side and the radius (a circle
 * when w = h; an oval pad, as round a slotted hole, when not).
 */
export function padCapsule(p: { x: number; y: number; w: number; h: number }): { ax: number; ay: number; bx: number; by: number; r: number } {
  const r = Math.min(p.w, p.h) / 2;
  const [hx, hy] = [p.w / 2 - r, p.h / 2 - r];
  return { ax: p.x - hx, ay: p.y - hy, bx: p.x + hx, by: p.y + hy, r };
}

/** Distance from a point to a round pad's edge (its capsule), negative inside. */
export function roundPadDist(p: { x: number; y: number; w: number; h: number }, x: number, y: number): number {
  const r = Math.min(p.w, p.h) / 2;
  return Math.hypot(Math.max(Math.abs(x - p.x) - (p.w / 2 - r), 0), Math.max(Math.abs(y - p.y) - (p.h / 2 - r), 0)) - r;
}

/** The pins a pad carries: its number, then the pins sharing it. */
export function padPins(p: { number: string; also?: string[] }): string[] {
  return p.also?.length ? [p.number, ...p.also] : [p.number];
}

/** Does the pad carry this pin (number, any case)? */
export function padHasPin(p: { number: string; also?: string[] }, pin: string): boolean {
  const n = pin.toUpperCase();
  return padPins(p).some((x) => x.toUpperCase() === n);
}

export interface BoardPart {
  componentId: string;
  refdes: string;
  value: string;
  /** Part Card id, and orderable part number when known (BOM). */
  part: string;
  /** What kind of part it is (its card's category); absent for mounting holes. */
  category?: PartCategory;
  mpn?: string;
  manufacturer?: string;
  /** LCSC / JLCPCB part number chosen for assembly (the component's lcsc parameter). */
  lcsc?: string;
  /** Package name ("0603", "SOIC-8", "LQFP100"). */
  pkg: string;
  /** Package data the footprint was built from (3D bodies come from the same). */
  pkgInfo: PackageInfo;
  x: number;
  y: number;
  /** Clockwise, degrees (0/90/180/270). */
  rot: number;
  /** The side it is mounted on (a `layer` constraint). On the bottom its footprint is mirrored: the board is viewed from the top. */
  side: 'top' | 'bottom';
  pads: BoardPad[];
  /** Body outline and courtyard, absolute axis-aligned rectangles; a round body is the circle in its box. */
  body: { x: number; y: number; w: number; h: number; round?: boolean };
  courtyard: { x: number; y: number; w: number; h: number };
  pin1: { x: number; y: number };
  /** Its orientation matters (diodes, polarized caps, ICs, connectors): pin 1 is marked. */
  polarized: boolean;
  /** A picture of the part from the top (from its part card), for the 3D view. */
  topImage?: { src: string; rot: 0 | 90 | 180 | 270 };
  /** Locked (a hard position constraint); the placer does not move it. */
  locked: boolean;
  /** Placed where someone put it (a soft position constraint), relative to this part if set. */
  intent?: { anchor?: string };
  /** Who placed or locked it: the user (a drag, the lock button, their words) or the agent on its own. */
  by?: 'user' | 'agent';
  /** The part it belongs with (refdes): it follows that part, and a choice for it is relative to it. */
  follows?: string;
  /** The pin of that part it sits at (number), when it serves one (a decoupling cap at its supply pin). */
  followsPin?: string;
  /** Who it belongs with is the agent's word (attach), not the placer's guess; without `follows`: it stands on its own. */
  belongsDeclared?: boolean;
}

export interface Track {
  netId: string;
  layer: CopperLayer;
  width: number;
  /** Polyline x0,y0,x1,y1,… */
  pts: number[];
  /** Laid as the agent asked (BoardSettings.tracks): that track's id. */
  drawn?: string;
  /** Locked copper (BoardSettings.locked), laid as it was. */
  locked?: boolean;
}

export interface Via {
  netId: string;
  x: number;
  y: number;
  drill: number;
  pad: number;
  /** Placed on purpose (add_vias): the group's id. Joined to its planes solid, without reliefs. */
  group?: string;
  /** A thermal via in a pad (add_vias pad): allowed there whatever via_in_pad says. */
  inPad?: boolean;
  /** Laid as the agent asked (BoardSettings.tracks): that track's id. */
  drawn?: string;
  /** Locked copper (BoardSettings.locked), laid as it was. */
  locked?: boolean;
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
  /** Filled only inside this polygon (a free-form or rounded board outline). */
  clip?: number[];
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

export interface UnroutedConnection extends RouteBlockage {
  netId: string;
  from: string;
  to: string;
  /** Parts within a few millimetres of where it is blocked (candidates to move or turn). */
  near: string[];
}

export interface BoardDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** Where to look. */
  at?: { x: number; y: number };
  entities: string[];
  /** Set when a waiver covers this check (the user or agent marked it intended). */
  waivedBy?: string;
}

export interface BoardView {
  outline: { w: number; h: number };
  layers: CopperLayer[];
  rules: BoardRules;
  /** The fab profile the board is checked against, if one is chosen. */
  fab?: FabProfile;
  parts: BoardPart[];
  tracks: Track[];
  vias: Via[];
  zones: Zone[];
  /** Planes in effect (net, layer; automatic or set with set_plane), an area plane with its rectangle (x0, y0, x1, y1, mm) and the parts it lies under. */
  planes: { netId: string; layer: CopperLayer; auto: boolean; area?: [number, number, number, number]; under?: string[]; style?: PlaneStyle }[];
  /** The vias placed on purpose (add_vias), per group: how many it asks for (grid, fence: the spots it may use; tie: the vias its current wants). */
  viaGroups: { id: string; netId: string; kind: ViaKind; wanted: number; note?: string; pad?: string }[];
  /**
   * The tracks the agent laid (BoardSettings.tracks), as they stand on this placement: ends as
   * "U1.3", points in board mm; after routing, whether each could be laid as asked.
   */
  /** Keep-out areas (BoardSettings.keepouts) on this placement: the rectangle (x0, y0, x1, y1, mm), the layers, the nets let through (ids). */
  keepouts: { id: string; rect: [number, number, number, number]; layers: CopperLayer[]; allow: string[]; under?: string[] }[];
  /** Nets with locked copper (BoardSettings.locked): how much; after routing, how much of it still holds. */
  locked: { netId: string; tracks: number; vias: number; heldTracks?: number; heldVias?: number }[];
  drawn: { id: string; netId: string; from: string; to: string; layer?: CopperLayer; width?: number; through: { x: number; y: number; layer?: CopperLayer }[]; laid?: boolean; why?: string; at?: { x: number; y: number } }[];
  /** Connections not (yet) made by copper. */
  ratsnest: RatsLine[];
  diagnostics: BoardDiagnostic[];
  stats: { nets: number; routed: number; unrouted: number; trackLength: number; vias: number };
  /** Connections the router left open, pad to pad (e.g. "U1.3" → "C2.1"), with what is in the way. */
  unrouted: UnroutedConnection[];
  /**
   * How well the placement lends itself to routing (lower is better): the ratsnest of the nets
   * routed as tracks (not those on a dedicated plane), its length and where its lines cross.
   */
  measures: { ratsnestMm: number; crossings: number };
  /** Copper just routed, for the app to keep in the design (absent when it came from the design). */
  newCopper?: StoredCopper;
  /** The user stopped the routing; the copper is the best pass it had finished. */
  stopped?: boolean;
  /** Copper kept from the routing before (incremental routing): tracks and vias, of how many. */
  reused?: { tracks: number; vias: number };
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
  /** A free-form outline (closed polygon, flat x, y list), else null: the (rounded) rectangle. */
  shape: number[] | null;
  /** Milled cutouts, placed on this outline. */
  cutouts: BoardCutout[];
  /** Silkscreen graphics, placed on this outline. */
  graphics: BoardGraphic[];
  /** The fabrication panel, resolved for this outline (absent: none set). */
  panel?: PanelView;
}

/** How get_board says where a part is plugged from (top view). */
const PLUGGED_FROM: Record<BoardFacing, string> = {
  left: 'the left (x−)',
  right: 'the right (x+)',
  top: 'the top edge side (y−)',
  bottom: 'the bottom edge side (y+)',
  above: 'above',
  below: 'below the board',
};

/** What to do about open connections: the agent is expected to get the board to 100 %. */
const OPEN_NEXT =
  'A board with an open connection does not work: get it to 100 %. Fix the placement first, not the copper: look at each spot (get_board_image region round at_mm), then refine_placement near the parts named there (the small parts moved and turned to untangle the ratsnest), and move or turn the main parts near it (place with rot, or try_placements with the arrangement as it is: the kernel improves on it and gives the parts to apply), so pads face the parts they connect to and the ratsnest lines stop crossing; give a crowded area more space (set_board size); route again (it keeps what holds and takes seconds). On a 2-layer board, 4 layers (set_board layers) only as the last resort, it costs more. Enclosed: pads or the edge close the pad off, move the part. Plane: no room for the via down to the plane next to the pad, move the part or what crowds it.';

function openSummary(b: BoardView, u: UnroutedConnection) {
  const name = (id: string) => b.netNames[id] ?? id;
  return {
    net: name(u.netId),
    from: u.from,
    to: u.to,
    ...(u.at ? { at_mm: [u.at.x, u.at.y], layer: u.at.layer } : {}),
    ...(u.blockedBy?.length ? { blocked_by: u.blockedBy.map((id) => `${name(id)}${b.locked.some((l) => l.netId === id) ? ' (locked)' : b.drawn.some((t) => t.netId === id && t.laid) ? ' (your track)' : ''}`) } : {}),
    ...(u.enclosed ? { enclosed: true } : {}),
    ...(u.plane ? { plane: u.plane } : {}),
    ...(u.near.length ? { near: u.near } : {}),
  };
}

/** A plane's style in words: "gap 1 mm, clearance 0.5 mm, solid". */
export function planeStyleText(s: PlaneStyle): string {
  return [
    s.gap !== undefined ? `gap ${s.gap} mm` : '',
    s.clearance !== undefined ? `clearance ${s.clearance} mm` : '',
    s.edge !== undefined ? `edge ${s.edge} mm` : '',
    s.thermal === false ? 'solid' : '',
    s.spoke !== undefined ? `spokes ${s.spoke} mm` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** The planes on a layer as a legend names them: "+5V, +3V3 under U1". */
export function planeNames(b: Pick<BoardView, 'planes' | 'netNames'>, layer: CopperLayer): string {
  return b.planes
    .filter((p) => p.layer === layer)
    .map((p) => `${b.netNames[p.netId] ?? p.netId}${p.area ? (p.under ? ` under ${p.under.join(', ')}` : ' (area)') : ''}`)
    .join(', ');
}

/** How a part got where it is, for the agent: "auto", "agent", "user (relative to U1)", "locked by the user". */
function placedLabel(p: BoardPart): string {
  if (p.locked) return p.by ? `locked by the ${p.by}` : 'locked';
  if (!p.intent) return 'auto';
  return `${p.by ?? 'user'}${p.intent.anchor ? ` (relative to ${p.intent.anchor})` : ''}`;
}

/** Who a part belongs with, for the agent: "U1.12" (declared with attach), "U1.12 (guessed)", "none" (declared). */
function belongsLabel(p: BoardPart): { belongs_to?: string } {
  if (p.follows) return { belongs_to: `${p.follows}${p.followsPin ? `.${p.followsPin}` : ''}${p.belongsDeclared ? '' : ' (guessed)'}` };
  return p.belongsDeclared ? { belongs_to: 'none' } : {};
}

/** The parts the user put or locked somewhere themselves (their drag, the lock button, their words). */
export const userPlaced = (b: Pick<BoardView, 'parts'>) => b.parts.filter((p) => !p.componentId.startsWith('hole:') && p.by === 'user' && (p.locked || p.intent)).map((p) => p.refdes);

const USER_PLACED_NOTE =
  'The user put these parts where they are: their decisions. Arrange, plan the planes and route round them; propose_placement and try_placements refuse them. Move one only where routing cannot do without it (place, a small step), and tell the user which and why.';

/** Compact board description for agents (design_query get_board). */
export function boardSummary(b: BoardView, routed = true) {
  return {
    outline_mm: b.outline,
    layers: b.layers.length,
    rules: b.rules,
    fab: b.fab
      ? { id: b.fab.id, summary: fabSummary(b.fab), limits: b.fab.limits, source: b.fab.source, ...(b.fab.notes?.length ? { notes: b.fab.notes } : {}) }
      : 'none chosen: set_fab_profile (a preset such as "jlcpcb" or "eurocircuits/6C", or limits read from the manufacturer\'s page) makes the DRC check the board against the manufacturer\'s limits',
    outline_by: b.sizeBy,
    parts: b.parts.map((p) => {
      const m = matingOf(p.pkgInfo);
      return {
        refdes: p.refdes,
        package: p.pkg,
        x: p.x,
        y: p.y,
        rot: p.rot,
        side: p.side,
        placed: placedLabel(p),
        ...belongsLabel(p),
        ...(m ? { plugged_from: PLUGGED_FROM[boardFacing(m.face, p.rot, p.side)] } : {}),
      };
    }),
    ...(userPlaced(b).length ? { user_placed: { parts: userPlaced(b), note: USER_PLACED_NOTE } } : {}),
    routing: !routed
      ? 'not computed here (see the Layout view)'
      : b.routing === 'done'
        ? {
            nets: b.stats.nets,
            routed: b.stats.routed,
            unrouted_connections: b.stats.unrouted,
            vias: b.stats.vias,
            track_mm: b.stats.trackLength,
            ...(b.stopped ? { stopped: 'The user stopped the routing: this is the best pass it had finished. route runs it again from the start.' } : {}),
            ...(b.reused ? { incremental: `${b.reused.tracks} of ${b.tracks.length} tracks and ${b.reused.vias} vias kept from the routing before; only what the change touched was routed again` } : {}),
            ...(b.unrouted.length ? { open: b.unrouted.slice(0, 20).map((u) => openSummary(b, u)), next: OPEN_NEXT } : {}),
          }
        : b.routing === 'stale'
          ? 'out of date: the placement changed since the route step (route again when the placement is final)'
          : 'not routed yet (the route op, once the placement is final)',
    placement_measures: { ratsnest_mm: b.measures.ratsnestMm, ratsnest_crossings: b.measures.crossings },
    planes: b.planes.map((p) => ({ net: b.netNames[p.netId] ?? p.netId, layer: p.layer, dedicated: p.layer !== 'F.Cu' && p.layer !== 'B.Cu', automatic: p.auto, ...(p.area ? { area_mm: p.area, ...(p.under ? { under: p.under } : {}) } : {}), ...(p.style ? { style_mm: p.style } : {}) })),
    ...(b.viaGroups.length
      ? {
          via_groups: b.viaGroups.map((g) => {
            const placed = b.vias.filter((v) => v.group === g.id).length;
            const filled = g.kind === 'grid' || g.kind === 'fence' || g.kind === 'tie';
            const later = filled && b.routing !== 'done';
            const vias = later
              ? `${g.kind === 'tie' || g.kind === 'drop' ? '' : 'up to '}${g.wanted}, laid by the route step where they fit`
              : g.kind === 'drop'
                ? `${placed} beside ${g.pad}, each on its own stub from the pad`
              : g.kind === 'tie'
                ? `${placed} of the ${g.wanted} its current wants${placed < g.wanted ? ' (no room for the rest round the spot, or it misses the net\'s copper on a second layer)' : ''}`
                : filled
                  ? `${placed} of ${g.wanted} spots (the others are blocked or miss the net's planes)`
                  : placed;
            // (a drop's vias where they stand, to check against the board image)
            const at = g.kind === 'drop' ? { at_mm: b.vias.filter((v) => v.group === g.id).map((v) => [v.x, v.y]) } : {};
            return { id: g.id, net: b.netNames[g.netId] ?? g.netId, kind: g.kind, vias, ...at, ...(g.note ? { note: g.note } : {}) };
          }),
        }
      : {}),
    ...(b.drawn.length
      ? {
          laid_tracks: b.drawn.map((t) => ({
            id: t.id,
            net: b.netNames[t.netId] ?? t.netId,
            from: t.from,
            to: t.to,
            ...(t.layer ? { layer: t.layer } : {}),
            ...(t.width ? { width_mm: t.width } : {}),
            ...(t.through.length ? { through_mm: t.through.map((p) => (p.layer ? [p.x, p.y, p.layer] : [p.x, p.y])) } : {}),
            state: t.laid === undefined ? 'laid by the route step' : t.laid ? 'laid as asked' : `not laid: ${t.why}; the router routed this connection its own way`,
          })),
        }
      : {}),
    ...(b.keepouts.length
      ? {
          keepouts: b.keepouts.map((k) => ({
            id: k.id,
            rect_mm: k.rect,
            ...(k.under ? { under: k.under } : {}),
            layers: k.layers,
            ...(k.allow.length ? { nets_let_through: k.allow.map((id) => b.netNames[id] ?? id) } : {}),
          })),
        }
      : {}),
    ...(b.locked.length
      ? {
          locked_copper: b.locked.map((l) => ({
            net: b.netNames[l.netId] ?? l.netId,
            tracks: l.tracks,
            vias: l.vias,
            state:
              l.heldTracks === undefined
                ? 'laid by the route step, as locked'
                : l.heldTracks === l.tracks && l.heldVias === l.vias
                  ? 'laid as locked'
                  : `${l.heldTracks} of ${l.tracks} tracks and ${l.heldVias} of ${l.vias} vias still fit the board as it is (a part moved off the rest, or something new comes too close); the router routed round them. Kept as locked: they come back if the part does`,
          })),
        }
      : {}),
    mounting_holes: b.parts.filter((p) => p.componentId.startsWith('hole:')).map((p) => ({ id: p.refdes, x: p.x, y: p.y, diameter: p.pads[0]?.drill, plated: !p.pads[0]?.npth })),
    corner_radius_mm: b.cornerRadius,
    cutouts: b.cutouts.map((c) => ({ id: c.id, shape: c.shape, x: c.x, y: c.y, ...(c.shape === 'circle' ? { diameter: c.w } : { w: c.w, h: c.h }), ...(c.r ? { corner_radius: c.r } : {}), ...(c.angle ? { angle: c.angle } : {}) })),
    silkscreen_graphics: b.graphics.map((g) => ({
      id: g.id,
      ...(g.name ? { name: g.name } : {}),
      side: g.side,
      ...(g.text ? { text: g.text } : { mode: g.mode, figures: g.polys.length }),
      bounds_mm: g.bounds,
      centre_mm: [Math.round(((g.bounds[0] + g.bounds[2]) / 2) * 100) / 100, Math.round(((g.bounds[1] + g.bounds[3]) / 2) * 100) / 100],
      inside_board: g.inside ?? true,
      ...(g.over?.length ? { over_parts: g.over } : {}),
    })),
    ...(b.panel
      ? {
          panel: {
            copies: `${b.panel.settings.cols} × ${b.panel.settings.rows}`,
            size_mm: [b.panel.w, b.panel.h],
            gap_mm: b.panel.settings.gap,
            rails_mm: b.panel.settings.rails,
            tabs_per_board: b.panel.settings.tabs,
            tab: { width_mm: b.panel.settings.tab.width, hole_mm: b.panel.settings.tab.hole, pitch_mm: b.panel.settings.tab.pitch },
            tabs: b.panel.tabs.length,
            mouse_bites: b.panel.bites.length,
            fiducials: b.panel.fiducials.length,
            tooling_holes: b.panel.tooling.length,
          },
        }
      : {}),
    drc: b.diagnostics.filter((x) => !x.waivedBy).map((x) => `${x.severity}: ${x.message}`),
    missing_footprints: b.missing,
    note: 'Workflow: decide the main parts\' places and rotations (try_placements compares arrangements, propose_placement parts applies one; the placer puts the small parts round them), then fine-tune (place = a choice for a part, kept relative to its parent part, rot turns it; lock: true pins it exactly; set_board for the size; placement_measures say how the arrangement routes: shorter, fewer crossing ratsnest lines are better), then route as the last step, to 100 %. Later changes keep the placement and move only what they must; routing then shows as out of date until route runs again. Keep parts together with constrain near, put a part on the bottom side with constrain layer (value "bottom"; SMD parts on opposite sides may overlap), choose planes with set_plane (inner layers are dedicated planes, outer layers get a pour).',
  };
}
