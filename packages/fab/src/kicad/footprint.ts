/**
 * A part on the board as a KiCad footprint: inline in the board file, and as a `.kicad_mod` file of the
 * `4k7.pretty` library. See docs/design/kicad-export.md §3.
 *
 * The board view holds every pad absolute, already turned and (on the bottom) mirrored. KiCad keeps a
 * footprint's contents in its own frame: the file stores each item's offset from the footprint's
 * position turned back by the footprint's orientation (`formatInternalUnits( coord, parentFP )` in
 * KiCad 10's pcb_io_kicad_sexpr.cpp), and a bottom footprint's contents are already flipped. So the
 * part's position and rotation are taken out of the pads again (`toFrame`), and the side stays in.
 *
 * Senses of rotation (checked against KiCad 10's RotatePoint, libs/kimath/src/trigo.cpp, and
 * FOOTPRINT::Flip, pcbnew/footprint.cpp): 4k7's `rot` turns clockwise as seen from the top (y down);
 * KiCad's orientation turns counter-clockwise on screen, so a top part is at −rot. KiCad flips a
 * footprint to the bottom about its horizontal axis and turns it 180° (orientation 180° − θ); 4k7
 * mirrors it left to right and then turns it by rot, which is the same placement with θ = rot, so a
 * bottom part is at 180° − rot. Orientations are written in (−180°, 180°] as KiCad keeps them.
 */
import { bodyOutline, type BoardPart, refdesHeight } from '@4k7/schema';
import type { SilkText } from '../gerber.ts';
import { type SList, sym, yn } from './sexpr.ts';

/** The board and footprint file version of KiCad 10.0 (SEXPR_BOARD_FILE_VERSION in pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h, tag 10.0.0). */
export const KICAD_FILE_VERSION = 20260206;

/** Line widths of the footprint graphics (mm): silkscreen as the Gerber export prints it, fabrication and courtyard as KiCad's library draws them. */
const SILK = 0.15;
const FAB = 0.1;
const CRTYD = 0.05;

const r6 = (v: number) => Math.round(v * 1e6) / 1e6 || 0;
const norm360 = (a: number) => ((a % 360) + 360) % 360;

/** KiCad's orientation (degrees, counter-clockwise, in (−180, 180]) of a part turned `rot` clockwise on a side. */
export function kicadAngle(rot: number, side: 'top' | 'bottom'): number {
  const a = norm360(side === 'bottom' ? 180 - rot : -rot);
  return (a > 180 ? a - 360 : a) || 0;
}

/** KiCad's RotatePoint: a point turned about the origin by an angle (degrees, counter-clockwise on screen, y down). */
export function rotatePoint(x: number, y: number, angle: number): [number, number] {
  switch (norm360(angle)) {
    case 0:
      return [x, y];
    case 90:
      return [y, -x];
    case 180:
      return [-x, -y];
    case 270:
      return [-y, x];
    default: {
      const t = (angle * Math.PI) / 180;
      return [y * Math.sin(t) + x * Math.cos(t), y * Math.cos(t) - x * Math.sin(t)];
    }
  }
}

/** Where a footprint stands: its position (board coordinates), KiCad's orientation and its side. */
export interface Frame {
  x: number;
  y: number;
  angle: number;
  side: 'top' | 'bottom';
}

export const frameOf = (p: Pick<BoardPart, 'x' | 'y' | 'rot' | 'side'>): Frame => ({ x: p.x, y: p.y, angle: kicadAngle(p.rot, p.side), side: p.side });

/** A board point in the footprint's frame, as KiCad writes it. */
export function toFrame(f: Frame, x: number, y: number): [number, number] {
  const [rx, ry] = rotatePoint(x - f.x, y - f.y, -f.angle);
  return [r6(rx), r6(ry)];
}

/** A point of the footprint's frame on the board, as KiCad reads it. */
export function fromFrame(f: Frame, rx: number, ry: number): [number, number] {
  const [dx, dy] = rotatePoint(rx, ry, f.angle);
  return [r6(f.x + dx), r6(f.y + dy)];
}

/**
 * A closed polygon (flat x, y list) in one order whatever way it was turned or mirrored: clockwise on
 * screen (y down), from its corner with the least y, then the least x. So a package drawn at another
 * rotation is the same footprint.
 */
export function canonicalPolygon(pts: number[]): number[] {
  const n = pts.length / 2;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[2 * i]! * pts[2 * j + 1]! - pts[2 * j]! * pts[2 * i + 1]!;
  }
  let corners = Array.from({ length: n }, (_, i): [number, number] => [pts[2 * i]!, pts[2 * i + 1]!]);
  if (area < 0) corners = corners.reverse();
  let start = 0;
  corners.forEach(([x, y], i) => {
    const [sx, sy] = corners[start]!;
    if (y < sy - 1e-9 || (Math.abs(y - sy) <= 1e-9 && x < sx)) start = i;
  });
  return [...corners.slice(start), ...corners.slice(0, start)].flat();
}

/** Whether an angle (multiple of 90°) swaps a pad's width and height. */
const quarter = (angle: number) => norm360(angle) % 180 !== 0;

/* ---- the footprint, side-neutral ---- */

type Kind = 'SilkS' | 'Fab' | 'CrtYd';

interface FpPad {
  number: string;
  type: 'smd' | 'thru_hole' | 'np_thru_hole';
  shape: 'rect' | 'circle' | 'oval';
  x: number;
  y: number;
  /** Size in the pad's own frame (as the footprint stands at orientation 0). */
  w: number;
  h: number;
  drill?: number;
  /** An oval (slotted) hole: its size in the pad's frame. */
  slot?: [number, number];
  net?: string;
  /** The uuid's id within the footprint. */
  id: string;
}

type FpShape =
  | { k: 'poly'; pts: number[]; layer: Kind; width: number; fill: boolean; id: string }
  | { k: 'circle'; x: number; y: number; r: number; layer: Kind; width: number; fill: boolean; id: string }
  | { k: 'rect'; x0: number; y0: number; x1: number; y1: number; layer: Kind; width: number; id: string }
  | { k: 'line'; x0: number; y0: number; x1: number; y1: number; layer: Kind; width: number; id: string };

interface FpText {
  /** A property's name ("Reference"), or null for a text of the footprint's own (fp_text user). */
  property: string | null;
  text: string;
  x: number;
  y: number;
  h: number;
  layer: Kind;
  hide: boolean;
  id: string;
}

/** A part's footprint in its frame, split into what its package has (the library's) and what this part has on this board. */
export interface PartFootprint {
  frame: Frame;
  /** The pads and the package's graphics (body, courtyard): the same for every part of the package. */
  pads: FpPad[];
  shapes: FpShape[];
  /** This part's own graphics (its polarity mark, placed on this board) and texts. */
  marks: FpShape[];
  texts: FpText[];
  /** The attributes on the board, and in the library (where `dnp` and what follows from it are left out: they are the part's, not the package's). */
  attrs: string[];
  libAttrs: string[];
  hole: boolean;
}

const isHole = (p: Pick<BoardPart, 'componentId'>) => p.componentId.startsWith('hole:');

/** The attributes a footprint carries (KiCad's order): smd or through_hole, then left out of the position file and the BOM, then dnp. */
function attributes(p: BoardPart, withDnp: boolean): string[] {
  const plated = p.pads.filter((q) => !q.npth);
  const out: string[] = [];
  if (!isHole(p) && plated.length) out.push(plated.some((q) => q.drill) ? 'through_hole' : 'smd');
  const dnp = withDnp && !!p.dnp;
  // as 4k7's BOM and pick-and-place leave them out: mounting holes, bare pads and parts not fitted
  if (isHole(p) || p.padOnly || dnp) out.push('exclude_from_pos_files', 'exclude_from_bom');
  if (dnp) out.push('dnp');
  return out;
}

/**
 * A part as a footprint in its frame. `silk` is where its refdes is printed (silkTexts in gerber.ts;
 * null: nowhere, the Reference is then hidden); `netName` names a pad's net.
 */
export function partFootprint(p: BoardPart, silk: SilkText | null, netName: (netId: string) => string): PartFootprint {
  const frame = frameOf(p);
  const at = (x: number, y: number) => toFrame(frame, x, y);
  const turned = quarter(frame.angle);
  const pads: FpPad[] = [];
  p.pads.forEach((q, i) => {
    const [x, y] = at(q.x, q.y);
    const [w, h] = turned ? [q.h, q.w] : [q.w, q.h];
    const type = q.npth ? 'np_thru_hole' : q.drill ? 'thru_hole' : 'smd';
    // KiCad's hole without copper is as big as its drill; 4k7's pad there is the copper kept clear round it
    const [pw, ph] = q.npth ? [q.drill!, q.drill!] : [w, h];
    const shape = q.shape === 'rect' ? 'rect' : Math.abs(pw - ph) < 1e-9 ? 'circle' : 'oval';
    const slot = q.slot ? ((turned ? [q.slot.h, q.slot.w] : [q.slot.w, q.slot.h]) as [number, number]) : undefined;
    const pad = { type, shape, x, y, w: pw, h: ph, ...(q.drill ? { drill: q.drill } : {}), ...(slot && Math.abs(slot[0] - slot[1]) > 1e-9 ? { slot } : {}), ...(q.netId ? { net: netName(q.netId) } : {}) } as const;
    // a pad's further pins are pads of their own on the same spot, so every pin has a pad of its number
    pads.push({ ...pad, number: q.number, id: `pad/${i}` });
    for (const pin of q.also ?? []) pads.push({ ...pad, number: pin, id: `pad/${i}/${pin}` });
  });

  const shapes: FpShape[] = [];
  const b = p.body;
  if (!isHole(p)) {
    for (const [layer, width] of [['Fab', FAB], ['SilkS', SILK]] as const) {
      if (b.round) {
        const [x, y] = at(b.x + b.w / 2, b.y + b.h / 2);
        shapes.push({ k: 'circle', x, y, r: b.w / 2, layer, width, fill: false, id: `body/${layer}` });
      } else {
        const o = bodyOutline(b);
        const pts: number[] = [];
        for (let i = 0; i < o.length; i += 2) pts.push(...at(o[i]!, o[i + 1]!));
        shapes.push({ k: 'poly', pts: canonicalPolygon(pts), layer, width, fill: false, id: `body/${layer}` });
      }
    }
  }
  const c = p.courtyard;
  const [cx0, cy0] = at(c.x, c.y);
  const [cx1, cy1] = at(c.x + c.w, c.y + c.h);
  shapes.push({ k: 'rect', x0: Math.min(cx0, cx1), y0: Math.min(cy0, cy1), x1: Math.max(cx0, cx1), y1: Math.max(cy0, cy1), layer: 'CrtYd', width: CRTYD, id: 'courtyard' });

  const marks: FpShape[] = [];
  (p.mark?.strokes ?? []).forEach((s, i) => {
    for (let j = 0; j + 3 < s.pts.length; j += 2) {
      const [x0, y0] = at(s.pts[j]!, s.pts[j + 1]!);
      const [x1, y1] = at(s.pts[j + 2]!, s.pts[j + 3]!);
      marks.push({ k: 'line', x0, y0, x1, y1, layer: 'SilkS', width: s.w, id: `mark/${i}/${j / 2}` });
    }
  });
  (p.mark?.dots ?? []).forEach((d, i) => {
    const [x, y] = at(d.x, d.y);
    marks.push({ k: 'circle', x, y, r: d.d / 2, layer: 'SilkS', width: 0, fill: true, id: `dot/${i}` });
  });

  // the refdes where the Gerber export prints it; a test point's TP_<net> printed in its place
  const th = refdesHeight(b);
  const [rx, ry] = silk ? at(silk.x, silk.y) : [0, 0];
  const texts: FpText[] = [
    { property: 'Reference', text: p.refdes, x: rx, y: ry, h: silk?.h ?? th, layer: 'SilkS', hide: !silk || silk.text !== p.refdes || isHole(p), id: 'reference' },
    { property: 'Value', text: p.value, x: 0, y: 0, h: th, layer: 'Fab', hide: isHole(p), id: 'value' },
  ];
  for (const [name, v] of [['Manufacturer', p.manufacturer], ['MPN', p.mpn], ['LCSC', p.lcsc], ['Eurocircuits', p.eurocircuits]] as const) {
    if (v) texts.push({ property: name, text: v, x: 0, y: 0, h: th, layer: 'Fab', hide: true, id: `property/${name}` });
  }
  if (silk && silk.text !== p.refdes) texts.push({ property: null, text: silk.text, x: rx, y: ry, h: silk.h, layer: 'SilkS', hide: false, id: 'silk' });
  return { frame, pads, shapes, marks, texts, attrs: attributes(p, true), libAttrs: attributes(p, false), hole: isHole(p) };
}

/* ---- the library's footprint: turned to orientation 0 on the top side ---- */

/** The package's part of a footprint as the library holds it: on the top side, the bottom's flip taken out (y mirrored). */
export function libraryContents(fp: PartFootprint): { pads: FpPad[]; shapes: FpShape[] } {
  if (fp.frame.side === 'top') return { pads: fp.pads.map(({ net: _n, ...q }) => q), shapes: fp.shapes };
  const my = (v: number) => -v || 0;
  return {
    pads: fp.pads.map(({ net: _n, ...q }) => ({ ...q, y: my(q.y) })),
    shapes: fp.shapes.map((s) => {
      if (s.k === 'poly') return { ...s, pts: canonicalPolygon(s.pts.map((v, i) => (i % 2 ? my(v) : v))) };
      if (s.k === 'circle') return { ...s, y: my(s.y) };
      return { ...s, y0: Math.min(my(s.y0), my(s.y1)), y1: Math.max(my(s.y0), my(s.y1)) };
    }),
  };
}

/** What makes two footprints of a package the same: their pads and graphics, uuids left out. */
export function libraryKey(fp: PartFootprint): string {
  const { pads, shapes } = libraryContents(fp);
  return JSON.stringify([pads.map(({ id: _i, ...q }) => q), shapes.map(({ id: _i, ...s }) => s), fp.libAttrs]);
}

/** A footprint's name in the library: the package's, with what a file name or KiCad's library id cannot hold replaced. */
export const footprintName = (pkg: string) => pkg.replace(/[\\/:*?"<>|\s]+/g, '_') || 'footprint';

/* ---- s-expressions ---- */

const layerName = (kind: Kind | 'Cu', side: 'top' | 'bottom') => `${side === 'top' ? 'F' : 'B'}.${kind}`;
const stroke = (width: number): SList => ['stroke', ['width', width], ['type', sym('solid')]];

function shapeNode(s: FpShape, side: 'top' | 'bottom', uuid: string): SList {
  const tail: SList = [['layer', layerName(s.layer, side)], ['uuid', uuid]];
  switch (s.k) {
    case 'poly':
      return ['fp_poly', ['pts', ...Array.from({ length: s.pts.length / 2 }, (_, i): SList => ['xy', s.pts[2 * i]!, s.pts[2 * i + 1]!])], stroke(s.width), ['fill', yn(s.fill)], ...tail];
    case 'circle':
      return ['fp_circle', ['center', s.x, s.y], ['end', s.x + s.r, s.y], stroke(s.width), ['fill', yn(s.fill)], ...tail];
    case 'rect':
      return ['fp_rect', ['start', s.x0, s.y0], ['end', s.x1, s.y1], stroke(s.width), ['fill', yn(false)], ...tail];
    case 'line':
      return ['fp_line', ['start', s.x0, s.y0], ['end', s.x1, s.y1], stroke(s.width), ...tail];
  }
}

function padNode(q: FpPad, side: 'top' | 'bottom', angle: number, uuid: string, nets: boolean): SList {
  const drill: SList | null = q.slot ? ['drill', sym('oval'), q.slot[0], q.slot[1]] : q.drill ? ['drill', q.drill] : null;
  const layers = q.type === 'smd' ? ['Cu', 'Mask', 'Paste'].map((k) => layerName(k as Kind, side)) : ['*.Cu', '*.Mask'];
  return [
    'pad',
    q.number,
    sym(q.type),
    sym(q.shape),
    angle ? ['at', q.x, q.y, angle] : ['at', q.x, q.y],
    ['size', q.w, q.h],
    ...(drill ? [drill] : []),
    ['layers', ...layers],
    ...(q.type === 'thru_hole' ? [['remove_unused_layers', yn(false)] as SList] : []),
    ...(nets && q.net !== undefined ? [['net', q.net] as SList] : []),
    ['uuid', uuid],
  ];
}

function textNode(t: FpText, side: 'top' | 'bottom', uuid: string): SList {
  const effects: SList = ['effects', ['font', ['size', t.h, t.h], ['thickness', SILK]], ...(side === 'bottom' ? [['justify', sym('mirror')] as SList] : [])];
  const body: SList = [['at', t.x, t.y, 0], ['layer', layerName(t.layer, side)], ...(t.hide ? [['hide', yn(true)] as SList] : []), ['uuid', uuid], effects];
  return t.property === null ? ['fp_text', sym('user'), t.text, ...body] : ['property', t.property, t.text, ...body];
}

const attrNode = (attrs: string[]): SList[] => (attrs.length ? [['attr', ...attrs.map(sym)]] : []);

/** The footprint inline in the board file: placed, with its nets, its own graphics and texts. `uuid` gives the uuid of an id within it. */
export function boardFootprint(fp: PartFootprint, part: BoardPart, libId: string, at: { x: number; y: number }, uuid: (id: string) => string): SList {
  const { side, angle } = fp.frame;
  return [
    'footprint',
    libId,
    ...(part.locked ? [['locked', yn(true)] as SList] : []),
    ['layer', layerName('Cu', side)],
    ['uuid', uuid('')],
    angle ? ['at', at.x, at.y, angle] : ['at', at.x, at.y],
    ['descr', `${part.pkg} (4k7)`],
    ...fp.texts.filter((t) => t.property !== null).map((t) => textNode(t, side, uuid(t.id))),
    ...attrNode(fp.attrs),
    ['duplicate_pad_numbers_are_jumpers', yn(false)],
    ...fp.shapes.map((s) => shapeNode(s, side, uuid(s.id))),
    ...fp.marks.map((s) => shapeNode(s, side, uuid(s.id))),
    ...fp.texts.filter((t) => t.property === null).map((t) => textNode(t, side, uuid(t.id))),
    ...fp.pads.map((q) => padNode(q, side, angle, uuid(q.id), true)),
    ['embedded_fonts', yn(false)],
  ];
}

/**
 * The footprint as a `.kicad_mod` file of the library: the package's pads and graphics at orientation 0
 * on the top side, no nets, a Reference of `REF**` and the footprint's name as its Value (as KiCad's
 * own libraries have them). The part's polarity mark and texts are the board's, not the package's.
 */
export function libraryFootprint(fp: PartFootprint, part: BoardPart, name: string, generator: string, uuid: (id: string) => string): SList {
  const { pads, shapes } = libraryContents(fp);
  const crt = shapes.find((s) => s.k === 'rect');
  const top = crt && crt.k === 'rect' ? crt.y0 : 0;
  const bottom = crt && crt.k === 'rect' ? crt.y1 : 0;
  const h = refdesHeight(part.body);
  const texts: FpText[] = [
    { property: 'Reference', text: 'REF**', x: 0, y: r6(top - h / 2 - 0.2), h, layer: 'SilkS', hide: fp.hole, id: 'reference' },
    { property: 'Value', text: name, x: 0, y: r6(bottom + h / 2 + 0.2), h, layer: 'Fab', hide: fp.hole, id: 'value' },
  ];
  return [
    'footprint',
    name,
    ['version', KICAD_FILE_VERSION],
    ['generator', '4k7'],
    ['generator_version', generator],
    ['layer', 'F.Cu'],
    ['descr', `${part.pkg} (4k7)`],
    ...texts.map((t) => textNode(t, 'top', uuid(t.id))),
    ...attrNode(fp.libAttrs),
    ['duplicate_pad_numbers_are_jumpers', yn(false)],
    ...shapes.map((s) => shapeNode(s, 'top', uuid(s.id))),
    ...pads.map((q) => padNode(q, 'top', 0, uuid(q.id), false)),
    ['embedded_fonts', yn(false)],
  ];
}
