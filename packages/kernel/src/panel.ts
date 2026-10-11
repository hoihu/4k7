/**
 * A fabrication panel resolved for a board: copies in a grid, a frame around them, and the milled
 * channels between, bridged by tabs with a row of mouse-bite holes at each board edge they touch.
 *
 * The material is a solid sheet minus the milled area; the milled area is every copy's outline
 * grown by the gap, minus the copies and minus the tabs. One rule covers rectangles (the channels
 * between neighbours merge) and free-form boards (cut out of the sheet; what is left between them
 * stays as web). The material's contours are the panel's Edge_Cuts.
 */
import { differenceD, EndType, FillRule, inflatePathsD, isPositiveD, JoinType, pointInPolygonD, PointInPolygonResult, unionD, type PathD, type PathsD } from 'clipper2-ts';
import {
  boardPolygon,
  FIDUCIAL,
  PANEL_SIDES,
  RAIL_MARK_OFFSET,
  TOOLING_HOLE,
  type BoardDiagnostic,
  type PanelSettings,
  type PanelSide,
  type PanelView,
} from '@tracewise/schema';

/** Clipper's precision: decimal places (µm). */
const PREC = 3;
/** How far a tab reaches into the material it joins, and into its own board. */
const OVERLAP = 0.3;
/** Rails narrower than this hold no fiducials or tooling holes. */
const MARK_RAIL = 5;

const toPath = (pts: number[], dx = 0, dy = 0): PathD => {
  const out: PathD = [];
  for (let i = 0; i + 1 < pts.length; i += 2) out.push({ x: pts[i]! + dx, y: pts[i + 1]! + dy });
  return out;
};
const rect = (x0: number, y0: number, x1: number, y1: number): PathD => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Where the edges of these polygons cross an axis-parallel line: x = u (vertical) or y = u. */
function lineHits(polys: PathsD, vertical: boolean, u: number): number[] {
  const out: number[] = [];
  for (const p of polys) {
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const a = p[j]!;
      const b = p[i]!;
      const [au, av, bu, bv] = vertical ? [a.x, a.y, b.x, b.y] : [a.y, a.x, b.y, b.x];
      if (au > u === bu > u) continue;
      out.push(av + ((u - au) * (bv - av)) / (bu - au));
    }
  }
  return out;
}

/** Even-odd point in polygon. */
function inside(p: PathD, x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i]!;
    const b = p[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

type Outline = { outline: { w: number; h: number }; cornerRadius?: number; shape?: number[] | null };

export function panelView(board: Outline, s: PanelSettings): { view: PanelView; diagnostics: BoardDiagnostic[] } {
  const { w, h } = board.outline;
  const poly = boardPolygon(board);
  const diagnostics: BoardDiagnostic[] = [];
  const gap = s.gap;
  const lead = (side: PanelSide) => s.rails[side] + (s.rails[side] > 0 ? gap : 0);
  const W = r3(lead('left') + s.cols * w + (s.cols - 1) * gap + lead('right'));
  const H = r3(lead('top') + s.rows * h + (s.rows - 1) * gap + lead('bottom'));
  const copies: { dx: number; dy: number }[] = [];
  for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) copies.push({ dx: r3(lead('left') + c * (w + gap)), dy: r3(lead('top') + r * (h + gap)) });
  const boards = copies.map((c) => toPath(poly, c.dx, c.dy));
  const sheet = [rect(0, 0, W, H)];
  // the channels without tabs; the material they leave is what a tab must reach
  const grown = inflatePathsD(boards, gap, JoinType.Round, EndType.Polygon, 2, PREC);
  const channels = differenceD(grown, boards, FillRule.NonZero, PREC);
  const material = differenceD(sheet, channels, FillRule.NonZero, PREC);

  /* tabs */
  const tabs: PanelView['tabs'] = [];
  const bites: PanelView['bites'] = [];
  const tw = s.tab.width;
  const n = Math.max(2, Math.ceil(tw / s.tab.pitch - 1e-9) + 1);
  const bad = new Map<string, string>();
  copies.forEach((c, k) => {
    for (const [ti, t] of s.tabs.entries()) {
      const vertical = t.side === 'top' || t.side === 'bottom';
      const sign = t.side === 'top' || t.side === 'left' ? -1 : 1; // outward along v
      const len = vertical ? w : h;
      const centre = (vertical ? c.dx : c.dy) + t.at * len;
      const us = Array.from({ length: n }, (_, i) => centre - tw / 2 + (i * tw) / (n - 1));
      // per hole line: the board edge, and where the material starts beyond it (a neighbour or the frame)
      const rows = us.map((u) => {
        const own = lineHits([boards[k]!], vertical, u);
        if (!own.length) return undefined;
        const edge = sign < 0 ? Math.min(...own) : Math.max(...own);
        const beyond = lineHits(material, vertical, u).filter((v) => (v - edge) * sign > 0.05);
        if (!beyond.length) return { u, edge };
        const reach = beyond.reduce((a, v) => ((v - edge) * sign < (a - edge) * sign ? v : a));
        const [px, py] = vertical ? [u, reach + sign * 0.05] : [reach + sign * 0.05, u];
        const other = boards.findIndex((b, i) => i !== k && inside(b, px, py));
        return { u, edge, reach, other };
      });
      const where = `${t.side} ${Math.round(t.at * 100)} %`;
      if (rows.some((r) => !r)) {
        bad.set(where, `the tab on the ${t.side} side at ${Math.round(t.at * 100)} % is ${tw} mm wide and runs off the board there; move it along the side or make the tabs narrower`);
        continue;
      }
      const ok = rows as { u: number; edge: number; reach?: number; other?: number }[];
      if (ok.some((r) => r.reach === undefined)) {
        // facing a panel edge without a rail: nothing to hold on to there, as intended
        if (s.rails[t.side] === 0 && ok.every((r) => r.reach === undefined)) continue;
        bad.set(where, `the tab on the ${t.side} side at ${Math.round(t.at * 100)} % reaches no material (no frame on that side): give that side a rail or remove the tab`);
        continue;
      }
      const joins = ok.every((r) => r.other !== undefined && r.other >= 0) && ok.every((r) => r.other === ok[0]!.other);
      const inner = sign < 0 ? Math.max(...ok.map((r) => r.edge)) - sign * OVERLAP : Math.min(...ok.map((r) => r.edge)) - sign * OVERLAP;
      const outer = sign < 0 ? Math.min(...ok.map((r) => r.reach!)) + sign * OVERLAP : Math.max(...ok.map((r) => r.reach!)) + sign * OVERLAP;
      const [v0, v1] = [Math.min(inner, outer), Math.max(inner, outer)];
      const [u0, u1] = [centre - tw / 2, centre + tw / 2];
      const box = vertical ? { x: u0, y: v0, w: tw, h: v1 - v0 } : { x: v0, y: u0, w: v1 - v0, h: tw };
      // a tab joining two copies is shared: the neighbour's facing tab is the same one
      const overlap = (a: typeof box, b: typeof box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      const same = tabs.find((o) => overlap(o, box) > 0.5 * Math.min(o.w * o.h, box.w * box.h));
      if (same) {
        if (!same.src.includes(ti)) same.src.push(ti);
        continue;
      }
      tabs.push({ x: r3(box.x), y: r3(box.y), w: r3(box.w), h: r3(box.h), copy: k, side: t.side, joins, src: [ti] });
      // the holes sit just inside each board edge the tab touches, so the break stays within the outline
      for (const r of ok) {
        const at = (v: number) => (vertical ? { x: r3(r.u), y: r3(v), d: s.tab.hole } : { x: r3(v), y: r3(r.u), d: s.tab.hole });
        bites.push(at(r.edge - sign * s.tab.inset));
        if (joins) bites.push(at(r.reach! + sign * s.tab.inset));
      }
    }
  });
  // tabs on one side that run into each other become one long tab
  s.tabs.forEach((t, i) => {
    const len = t.side === 'top' || t.side === 'bottom' ? w : h;
    const j = s.tabs.findIndex((o, k) => k > i && o.side === t.side && Math.abs(o.at - t.at) * len < tw);
    if (j >= 0) bad.set(`overlap ${i}`, `two tabs on the ${t.side} side (at ${Math.round(t.at * 100)} % and ${Math.round(s.tabs[j]!.at * 100)} %) overlap; move one or remove it`);
  });
  for (const msg of bad.values()) diagnostics.push({ code: 'PANEL.TAB', severity: 'error', message: `Panel: ${msg}.`, entities: ['panel'] });
  if (copies.length > 1 || s.rails.top + s.rails.right + s.rails.bottom + s.rails.left > 0) {
    // every copy held by two tabs or more
    const held = copies.map((_, k) => tabs.filter((t) => t.copy === k || (t.joins && tabHolds(t, boards[k]!))).length);
    const loose = held.filter((x) => x < 2).length;
    if (loose) diagnostics.push({ code: 'PANEL.TABS', severity: 'error', message: `Panel: ${loose === copies.length ? 'every board' : `${loose} of the boards`} ${loose === 1 ? 'is' : 'are'} held by fewer than two tabs; add tabs on opposite sides (set_panel tab_sides).`, entities: ['panel'] });
  }

  /* the material: the sheet minus the milled channels (which the tabs bridge) */
  const tabRects = tabs.map((t) => rect(t.x, t.y, t.x + t.w, t.y + t.h));
  const milled = differenceD(grown, unionD([...boards, ...tabRects], [], FillRule.NonZero, PREC), FillRule.NonZero, PREC);
  const solid = differenceD(sheet, milled, FillRule.NonZero, PREC);
  const edges = solid.map((p) => p.flatMap((q) => [r3(q.x), r3(q.y)]));
  // one piece: every board and the frame joined by tabs (loose scrap between free-form boards is fine)
  const outer = isPositiveD(sheet[0]!);
  const pieces = solid.filter((p) => isPositiveD(p) === outer);
  const pieceOf = (pt: { x: number; y: number }) => pieces.findIndex((p) => pointInPolygonD(pt, p, PREC) !== PointInPolygonResult.IsOutside);
  const held = new Set(boards.map((b) => pieceOf(b[0]!)));
  const railed = PANEL_SIDES.filter((side) => s.rails[side] > 0);
  for (const side of railed) held.add(pieceOf(side === 'top' ? { x: W / 2, y: 0 } : side === 'bottom' ? { x: W / 2, y: H } : side === 'left' ? { x: 0, y: H / 2 } : { x: W, y: H / 2 }));
  if (held.size > 1) diagnostics.push({ code: 'PANEL.LOOSE', severity: 'error', message: `Panel: it falls apart into ${held.size} pieces: ${railed.length ? 'the boards and the frame are' : 'the boards are'} not all joined by tabs. Add tabs on the sides that face ${railed.length ? 'the frame or ' : ''}a neighbour (set_panel tab_sides).`, entities: ['panel'] });

  /* fiducials and tooling holes on the rails: top and bottom, else left and right */
  const tooling: PanelView['tooling'] = [];
  const fiducials: PanelView['fiducials'] = [];
  if (s.fiducials || s.toolingHoles) {
    const o = RAIL_MARK_OFFSET;
    const tb = s.rails.top >= MARK_RAIL && s.rails.bottom >= MARK_RAIL;
    const lr = s.rails.left >= MARK_RAIL && s.rails.right >= MARK_RAIL;
    if (tb || lr) {
      // corners for the tooling holes; three fiducials, asymmetric so the panel cannot be loaded turned
      const along = (a: number, b: number) => (tb ? { x: a, y: b } : { x: b, y: a });
      const [L, D] = tb ? [W, H] : [H, W];
      const fid = 10;
      if (s.toolingHoles) for (const [a, b] of [[o, o], [L - o, o], [o, D - o], [L - o, D - o]] as const) tooling.push({ ...along(r3(a), r3(b)), d: TOOLING_HOLE });
      if (s.fiducials) for (const [a, b] of [[fid, o], [L - fid, o], [fid, D - o]] as const) fiducials.push({ ...along(r3(a), r3(b)), d: FIDUCIAL.copper, mask: FIDUCIAL.mask });
    } else diagnostics.push({ code: 'PANEL.RAILS', severity: 'warning', message: `Panel: fiducials and tooling holes need ${MARK_RAIL} mm rails on two opposite sides (top and bottom, or left and right); there are none, so the panel has no marks for assembly.`, entities: ['panel'] });
  }

  return { view: { settings: s, w: W, h: H, copies, edges, tabs, bites, tooling, fiducials }, diagnostics };
}

/** Whether a shared tab touches this copy (its rectangle overlaps the board). */
function tabHolds(t: { x: number; y: number; w: number; h: number }, board: PathD): boolean {
  const pts = [
    [t.x + t.w / 2, t.y + 0.1],
    [t.x + t.w / 2, t.y + t.h - 0.1],
    [t.x + 0.1, t.y + t.h / 2],
    [t.x + t.w - 0.1, t.y + t.h / 2],
  ];
  return pts.some(([x, y]) => inside(board, x!, y!));
}
