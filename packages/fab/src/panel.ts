/**
 * Manufacturing outputs for a panel: the board repeated at every copy's offset, as one board view
 * the size of the panel, with the panel's milled contours, mouse bites, tooling holes and
 * fiducials. Designators get the copy's number ("R1_2"), so the BOM counts the whole panel and
 * the pick-and-place lists every placement on it.
 */
import type { BoardPart, BoardView, PanelView, Zone, ZoneCut } from '@4k7/schema';
import { bom, gerbers, pickAndPlace, type FabFile } from './gerber.ts';

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const shift = (pts: number[], dx: number, dy: number) => pts.map((v, i) => r3(v + (i % 2 === 0 ? dx : dy)));

function moveCut(c: ZoneCut, dx: number, dy: number): ZoneCut {
  if (c.k === 'stroke') return { ...c, pts: shift(c.pts, dx, dy) };
  return { ...c, x: r3(c.x + dx), y: r3(c.y + dy) };
}

function moveZone(z: Zone, dx: number, dy: number): Zone {
  const rects = z.rects.map((v, i) => (i % 4 === 0 ? r3(v + dx) : i % 4 === 1 ? r3(v + dy) : v));
  if (!z.shape) return { ...z, rects };
  const [x0, y0, x1, y1] = z.shape.outline;
  return {
    ...z,
    rects,
    shape: {
      outline: [r3(x0 + dx), r3(y0 + dy), r3(x1 + dx), r3(y1 + dy)],
      ...(z.shape.clip ? { clip: shift(z.shape.clip, dx, dy) } : {}),
      cuts: z.shape.cuts.map((c) => moveCut(c, dx, dy)),
      adds: z.shape.adds.map((a) => ({ ...a, pts: shift(a.pts, dx, dy) })),
    },
  };
}

function movePart(p: BoardPart, dx: number, dy: number, n: number): BoardPart {
  const box = <T extends { x: number; y: number }>(r: T): T => ({ ...r, x: r3(r.x + dx), y: r3(r.y + dy) });
  return {
    ...p,
    componentId: `${p.componentId}#${n}`,
    refdes: `${p.refdes}_${n}`,
    x: r3(p.x + dx),
    y: r3(p.y + dy),
    pads: p.pads.map(box),
    body: box(p.body),
    courtyard: box(p.courtyard),
    pin1: box(p.pin1),
  };
}

/** A non-plated hole of the panel (mouse bite, tooling hole) as a board feature: drilled, no copper, no silkscreen, not in the BOM. */
function hole(id: string, x: number, y: number, d: number): BoardPart {
  return {
    componentId: `hole:${id}`,
    refdes: id,
    value: `Ø${d}`,
    part: 'panel:hole',
    pkg: `NPTH-${d}`,
    pkgInfo: { name: `NPTH-${d}`, family: 'other', pins: 1 },
    x,
    y,
    rot: 0,
    side: 'top',
    pads: [{ number: '1', x, y, w: d, h: d, shape: 'round', drill: d, npth: true, layers: [] }],
    body: { x: r3(x - d / 2), y: r3(y - d / 2), w: d, h: d },
    courtyard: { x: r3(x - d / 2), y: r3(y - d / 2), w: d, h: d },
    pin1: { x, y },
    polarized: false,
    locked: true,
  };
}

/** The whole panel as one board view: every copy moved into place, plus the panel's holes. */
export function panelBoard(b: BoardView, panel: PanelView): BoardView {
  const copies = panel.copies.map((c, i) => ({ ...c, n: i + 1 }));
  return {
    ...b,
    outline: { w: panel.w, h: panel.h },
    parts: [
      ...copies.flatMap(({ dx, dy, n }) => b.parts.map((p) => movePart(p, dx, dy, n))),
      ...panel.bites.map((m, i) => hole(`MB${i + 1}`, m.x, m.y, m.d)),
      ...panel.tooling.map((t, i) => hole(`TH${i + 1}`, t.x, t.y, t.d)),
    ],
    tracks: copies.flatMap(({ dx, dy }) => b.tracks.map((t) => ({ ...t, pts: shift(t.pts, dx, dy) }))),
    vias: copies.flatMap(({ dx, dy }) => b.vias.map((v) => ({ ...v, x: r3(v.x + dx), y: r3(v.y + dy) }))),
    zones: copies.flatMap(({ dx, dy }) => b.zones.map((z) => moveZone(z, dx, dy))),
    ratsnest: [],
    cutouts: copies.flatMap(({ dx, dy, n }) => b.cutouts.map((c) => ({ ...c, id: `${c.id}_${n}`, x: r3(c.x + dx), y: r3(c.y + dy) }))),
    graphics: copies.flatMap(({ dx, dy, n }) =>
      b.graphics.map((g) => ({
        ...g,
        id: `${g.id}_${n}`,
        polys: g.polys.map((p) => shift(p, dx, dy)),
        bounds: [r3(g.bounds[0] + dx), r3(g.bounds[1] + dy), r3(g.bounds[2] + dx), r3(g.bounds[3] + dy)] as [number, number, number, number],
      })),
    ),
    // the board's own shape gives way to the panel's contours (gerbers draws them)
    shape: null,
    cornerRadius: 0,
    panel: undefined,
  };
}

/** Gerbers, drill, BOM and pick-and-place of the panel ("<project>-panel-…"). */
export function panelFabFiles(b: BoardView, project: string): FabFile[] {
  if (!b.panel) throw new Error('The board has no panel (set_panel).');
  const p = panelBoard(b, b.panel);
  const name = `${project}-panel`;
  const base = name.replace(/[^\w.-]+/g, '_');
  return [...gerbers(p, name, b.panel), { name: `${base}-BOM.csv`, content: bom(p) }, { name: `${base}-PnP.csv`, content: pickAndPlace(p) }];
}
