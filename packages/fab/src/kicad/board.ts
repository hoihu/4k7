/**
 * The board as a KiCad 10 board file (`.kicad_pcb`) and its footprints as the `4k7.pretty` library,
 * from a BoardView as the Gerber export reads it. See docs/design/kicad-export.md §§2–3.
 *
 * The tokens, the layer table and the order of the top-level sections follow KiCad 10.0's own writer
 * (PCB_IO_KICAD_SEXPR::format in pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.cpp, tag 10.0.0 of
 * KiCad/kicad-source-mirror) and a board saved by it (demos/pic_programmer, kept in part as
 * packages/fab/test/kicad/reference/). In 10.0 a board has no net table: every pad, track and via names
 * its net (`(net "GND")`).
 *
 * In this first part: the outline and cutouts, the copper layers, the footprints, the tracks, the vias
 * and the nets. Not yet: pours and planes, keep-outs, the stack-up, silkscreen graphics, the project
 * file with its rules (§8, steps 3 and 4).
 */
import { boardPolygon, boardStackup, type BoardCutout, type BoardView, type CopperLayer, MASK_MARGIN } from '@4k7/schema';
import { type FabFile, type FabStamp, silkTexts, type SilkText } from '../gerber.ts';
import { boardFootprint, footprintName, KICAD_FILE_VERSION, libraryFootprint, libraryKey, partFootprint } from './footprint.ts';
import { type SList, sym, write, yn } from './sexpr.ts';
import { uuidsFor } from './uuid.ts';

/** Where the outline's top-left corner goes on KiCad's page (mm): so the board lies on the sheet. The auxiliary origin is set there. */
export const KICAD_ORIGIN = 100;

/** KiCad's ids of the copper layers (layer_ids.h of KiCad 10: F.Cu 0, B.Cu 2, inner layers 4, 6, …). */
const COPPER_ID: Record<CopperLayer, number> = { 'F.Cu': 0, 'In1.Cu': 4, 'In2.Cu': 6, 'B.Cu': 2 };

/** The other layers a board has, as KiCad 10 lists them in a board it saved (id, name, user name). */
const OTHER_LAYERS: [number, string, string?][] = [
  [9, 'F.Adhes', 'F.Adhesive'],
  [11, 'B.Adhes', 'B.Adhesive'],
  [13, 'F.Paste'],
  [15, 'B.Paste'],
  [5, 'F.SilkS', 'F.Silkscreen'],
  [7, 'B.SilkS', 'B.Silkscreen'],
  [1, 'F.Mask'],
  [3, 'B.Mask'],
  [17, 'Dwgs.User', 'User.Drawings'],
  [19, 'Cmts.User', 'User.Comments'],
  [21, 'Eco1.User', 'User.Eco1'],
  [23, 'Eco2.User', 'User.Eco2'],
  [25, 'Edge.Cuts'],
  [27, 'Margin'],
  [31, 'F.CrtYd', 'F.Courtyard'],
  [29, 'B.CrtYd', 'B.Courtyard'],
  [35, 'F.Fab'],
  [33, 'B.Fab'],
];

/** Edge.Cuts' line width (mm), as the Gerber export draws the outline. */
const EDGE = 0.1;

const r6 = (v: number) => Math.round(v * 1e6) / 1e6 || 0;

/** The smallest ISO sheet that holds the board at the origin, with a margin. */
function paper(w: number, h: number): string {
  const sheets: [string, number, number][] = [['A4', 297, 210], ['A3', 420, 297], ['A2', 594, 420], ['A1', 841, 594], ['A0', 1189, 841]];
  const fit = sheets.find(([, sw, sh]) => KICAD_ORIGIN + w + 10 <= sw && KICAD_ORIGIN + h + 10 <= sh);
  return fit?.[0] ?? 'A0';
}

type Edge = { line: [number, number, number, number] } | { arc: [number, number, number, number, number, number] };

/**
 * A rounded rectangle's contour as lines and arcs (start, mid, end), centred at cx, cy with half sizes
 * hx, hy, corner radius r, turned by `angle` degrees as cutoutPolygon turns it (schema board.ts).
 */
function roundedBoxEdges(cx: number, cy: number, hx: number, hy: number, r: number, angle: number): Edge[] {
  const a = (angle * Math.PI) / 180;
  const p = (x: number, y: number): [number, number] => [r6(cx + x * Math.cos(a) - y * Math.sin(a)), r6(cy + x * Math.sin(a) + y * Math.cos(a))];
  const corners: [number, number, number][] = [
    [hx - r, -(hy - r), -90],
    [hx - r, hy - r, 0],
    [-(hx - r), hy - r, 90],
    [-(hx - r), -(hy - r), 180],
  ];
  const at = ([ox, oy]: [number, number, number], deg: number) => p(ox + r * Math.cos((deg * Math.PI) / 180), oy + r * Math.sin((deg * Math.PI) / 180));
  const out: Edge[] = [];
  corners.forEach((c, i) => {
    if (r > 1e-9) out.push({ arc: [...at(c, c[2]), ...at(c, c[2] + 45), ...at(c, c[2] + 90)] });
    const next = corners[(i + 1) % 4]!;
    const [x0, y0] = r > 1e-9 ? at(c, c[2] + 90) : p(c[0], c[1]);
    const [x1, y1] = r > 1e-9 ? at(next, next[2]) : p(next[0], next[1]);
    if (Math.hypot(x1 - x0, y1 - y0) > 1e-9) out.push({ line: [x0, y0, x1, y1] });
  });
  return out;
}

/** A cutout's contour: a circle, or lines and arcs. */
function cutoutEdges(c: BoardCutout): Edge[] | { circle: [number, number, number] } {
  if (c.shape === 'circle' || (c.shape === 'slot' && Math.abs(c.w - c.h) < 1e-9)) return { circle: [c.x, c.y, c.w / 2] };
  if (c.shape === 'slot') return roundedBoxEdges(c.x, c.y, c.w / 2, c.h / 2, Math.min(c.w, c.h) / 2, c.angle);
  return roundedBoxEdges(c.x, c.y, c.w / 2, c.h / 2, c.r, c.angle);
}

/** The files of a board in KiCad's form: what `kicadBoardFiles` returns, with the board's text apart. */
export interface KicadBoard {
  /** The `.kicad_pcb` file's text. */
  pcb: string;
  /** The `4k7.pretty` library: one `.kicad_mod` per package in use (file name in the folder, text). */
  library: FabFile[];
}

/**
 * The board as KiCad's board file and footprint library. `project` names the design: the files' names
 * come from it, and every UUID is derived from it and the entity's id (uuid.ts), so the same design
 * gives the same bytes. `stamp.version` is written as the generator's version.
 */
export function kicadBoard(b: BoardView, project: string, stamp?: FabStamp): KicadBoard {
  const uuid = uuidsFor(project);
  const generator = stamp?.version ?? 'unknown';
  const O = KICAD_ORIGIN;
  const net = (id: string) => b.netNames[id] ?? id;

  /* footprints, and the library's one per package (a second drawing of a package gets a name of its own) */
  const silk = new Map<string, SilkText | null>();
  for (const side of ['top', 'bottom'] as const) {
    const parts = b.parts.filter((p) => p.side === side && !p.componentId.startsWith('hole:'));
    silkTexts(b, side, parts).forEach((t, i) => silk.set(parts[i]!.componentId, t));
  }
  const byKey = new Map<string, string>();
  const taken = new Set<string>();
  const library: FabFile[] = [];
  const footprints: SList[] = b.parts.map((part) => {
    const fp = partFootprint(part, silk.get(part.componentId) ?? null, net);
    const key = libraryKey(fp);
    let name = byKey.get(key);
    if (!name) {
      const base = footprintName(part.pkg);
      name = base;
      for (let k = 2; taken.has(name); k++) name = `${base}_${k}`;
      taken.add(name);
      byKey.set(key, name);
      const lib = uuidsFor(`${project}/4k7.pretty/${name}`);
      library.push({ name: `${name}.kicad_mod`, content: write(libraryFootprint(fp, part, name, generator, lib)) });
    }
    const id = (x: string) => uuid(x ? `${part.componentId}/${x}` : part.componentId);
    return boardFootprint(fp, part, `4k7:${name}`, { x: r6(part.x + O), y: r6(part.y + O) }, id);
  });
  library.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));

  /* the outline and the cutouts on Edge.Cuts */
  const edgeStroke: SList = ['stroke', ['width', EDGE], ['type', sym('solid')]];
  const edge = (id: string): SList => [['layer', 'Edge.Cuts'], ['uuid', uuid(id)]];
  const shift = (v: number) => r6(v + O);
  const drawEdges = (edges: Edge[], id: string): SList[] =>
    edges.map((e, i) =>
      'line' in e
        ? ['gr_line', ['start', shift(e.line[0]), shift(e.line[1])], ['end', shift(e.line[2]), shift(e.line[3])], edgeStroke, ...edge(`${id}/${i}`)]
        : ['gr_arc', ['start', shift(e.arc[0]), shift(e.arc[1])], ['mid', shift(e.arc[2]), shift(e.arc[3])], ['end', shift(e.arc[4]), shift(e.arc[5])], edgeStroke, ...edge(`${id}/${i}`)],
    );
  const drawings: SList[] = [];
  if (b.shape) {
    const poly = boardPolygon(b);
    drawings.push(['gr_poly', ['pts', ...Array.from({ length: poly.length / 2 }, (_, i): SList => ['xy', shift(poly[2 * i]!), shift(poly[2 * i + 1]!)])], edgeStroke, ['fill', yn(false)], ...edge('outline')]);
  } else {
    const { w, h } = b.outline;
    drawings.push(...drawEdges(roundedBoxEdges(w / 2, h / 2, w / 2, h / 2, Math.min(b.cornerRadius ?? 0, Math.min(w, h) / 2), 0), 'outline'));
  }
  for (const c of b.cutouts ?? []) {
    const e = cutoutEdges(c);
    if ('circle' in e) drawings.push(['gr_circle', ['center', shift(e.circle[0]), shift(e.circle[1])], ['end', shift(e.circle[0] + e.circle[2]), shift(e.circle[1])], edgeStroke, ['fill', yn(false)], ...edge(`cutout/${c.id}`)]);
    else drawings.push(...drawEdges(e, `cutout/${c.id}`));
  }

  /* tracks as segments, one per piece; vias; each named by its net, its index on its net (and layer) */
  const count = new Map<string, number>();
  const next = (k: string) => {
    const n = count.get(k) ?? 0;
    count.set(k, n + 1);
    return n;
  };
  const tracks: SList[] = [];
  for (const t of b.tracks) {
    const k = next(`track/${net(t.netId)}/${t.layer}`);
    for (let j = 0; j + 3 < t.pts.length; j += 2) {
      const [x0, y0, x1, y1] = [t.pts[j]!, t.pts[j + 1]!, t.pts[j + 2]!, t.pts[j + 3]!];
      if (Math.hypot(x1 - x0, y1 - y0) < 1e-9) continue; // a point repeated is no piece of track
      tracks.push(['segment', ['start', shift(x0), shift(y0)], ['end', shift(x1), shift(y1)], ['width', t.width], ...(t.locked ? [['locked', yn(true)] as SList] : []), ['layer', t.layer], ['net', net(t.netId)], ['uuid', uuid(`track/${net(t.netId)}/${t.layer}/${k}/${j / 2}`)]]);
    }
  }
  // every via goes through
  const [first, last] = [b.layers[0] ?? 'F.Cu', b.layers.at(-1) ?? 'B.Cu'];
  for (const v of b.vias) {
    const k = next(`via/${net(v.netId)}`);
    tracks.push(['via', ['at', shift(v.x), shift(v.y)], ['size', v.pad], ['drill', v.drill], ['layers', first, last], ...(v.locked ? [['locked', yn(true)] as SList] : []), ['net', net(v.netId)], ['uuid', uuid(`via/${net(v.netId)}/${k}`)]]);
  }

  const stack = boardStackup({ layers: b.layers.length === 4 ? 4 : 2, ...(b.stackup ? { stackup: b.stackup } : {}), ...(b.fab ? { fab: b.fab } : {}) });
  const thickness = r6([...stack.copper, ...stack.dielectric.map((d) => d.mm)].reduce((s, v) => s + v, 0));
  const pcb: SList = [
    'kicad_pcb',
    ['version', KICAD_FILE_VERSION],
    ['generator', '4k7'],
    ['generator_version', generator],
    ['general', ['thickness', thickness], ['legacy_teardrops', yn(false)]],
    ['paper', paper(b.outline.w, b.outline.h)],
    ['title_block', ['title', project]],
    ['layers', ...b.layers.map((l): SList => [COPPER_ID[l], l, sym('signal')]), ...OTHER_LAYERS.map(([id, name, user]): SList => [id, name, sym('user'), ...(user ? [user] : [])])],
    [
      'setup',
      // 4k7's mask opening round each pad; vias are tented (gerber.ts)
      ['pad_to_mask_clearance', MASK_MARGIN],
      ['allow_soldermask_bridges_in_footprints', yn(false)],
      ['tenting', ['front', yn(true)], ['back', yn(true)]],
      ['aux_axis_origin', O, O],
    ],
    ...footprints,
    ...drawings,
    ...tracks,
    ['embedded_fonts', yn(false)],
  ];
  return { pcb: write(pcb), library };
}

/** The library table naming the footprint folder as library "4k7" (KiCad 10's fp-lib-table, LIBRARY_TABLE::Format: version 7). */
export function fpLibTable(): string {
  return write(['fp_lib_table', ['version', 7], ['lib', ['name', '4k7'], ['type', 'KiCad'], ['uri', '${KIPRJMOD}/4k7.pretty'], ['options', ''], ['descr', 'Footprints of the 4k7 design']]]);
}

/**
 * The board in KiCad 10's form: `<project>.kicad_pcb`, `fp-lib-table` and `4k7.pretty/<package>.kicad_mod`,
 * for the zip (zip.ts). Nobody has yet opened these in KiCad: see docs/design/kicad-export.md §9.
 */
export function kicadBoardFiles(b: BoardView, project: string, stamp?: FabStamp): FabFile[] {
  const base = project.replace(/[^\w.-]+/g, '_') || 'board';
  const { pcb, library } = kicadBoard(b, project, stamp);
  return [{ name: `${base}.kicad_pcb`, content: pcb }, { name: 'fp-lib-table', content: fpLibTable() }, ...library.map((f) => ({ name: `4k7.pretty/${f.name}`, content: f.content }))];
}
