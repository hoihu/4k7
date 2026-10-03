/**
 * Executes edit ops on a (cloned) design. Every op either applies fully or throws a
 * RejectError with an actionable reason. Transactions are handled by the Kernel.
 */
import {
  approxEqual,
  normalizeLcsc,
  paramSpecs,
  parseQuantity,
  type Component,
  type Constraint,
  type Design,
  type EditOp,
  type OpResult,
  type PartCard,
  type PackageInfo,
  type BoardSettings,
  type CopperLayer,
  type HoleCorner,
  type MountingHole,
  type Cutout,
  type SilkGraphic,
  type DescriptionView,
  DEFAULT_BOARD,
} from '@tracewise/schema';
import { autoPlanes, placeBoard, storedPlacement } from './board.ts';
import { layoutSchematic } from './layout.ts';
import { boardOutline, pathFigures, pathPolygon } from './outline.ts';
import { findArtwork, listArtwork } from './artwork.ts';
import { footprintFor, isTwoPin, packageOptions, planUnits, searchParts, standardPackage } from '@tracewise/parts';
import {
  allocRefdes,
  cardOf,
  closest,
  createNet,
  findComponent,
  findNet,
  isAutoNet,
  mergeNet,
  natCmp,
  nextId,
  pinLabel,
  reject,
  requireCard,
  resolveComponent,
  resolvePins,
  type PinHandle,
} from './doc.ts';

export function applyOp(d: Design, op: EditOp): OpResult {
  switch (op.op) {
    case 'add_part':
      return addPart(d, op);
    case 'remove':
      return remove(d, op.ref);
    case 'set_param':
      return setParam(d, op.ref, op.params);
    case 'rename':
      return rename(d, op.ref, op.refdes);
    case 'connect':
      return connect(d, op.pins, op.net);
    case 'disconnect':
      return disconnect(d, op.pins);
    case 'no_connect':
      return noConnect(d, op.pins);
    case 'set_net':
      return setNet(d, op);
    case 'add_sheet':
      return addSheet(d, op.name);
    case 'move_to_sheet':
      return moveToSheet(d, op.refs, op.sheet);
    case 'constrain':
      return constrain(d, op);
    case 'remove_constraint': {
      if (!d.ledger[op.id]) reject({ code: 'REF_UNKNOWN', message: `No constraint ${op.id}.`, candidates: Object.keys(d.ledger) });
      delete d.ledger[op.id];
      return { op: op.op, effect: `removed constraint ${op.id}`, ids: [op.id] };
    }
    case 'add_waiver': {
      const id = nextId(d, 'w');
      d.waivers[id] = { id, code: op.code, entities: [...op.entities], reason: op.reason, by: 'agent' };
      return { op: op.op, effect: `waived ${op.code} for ${op.entities.join(', ')}`, ids: [id] };
    }
    case 'set_symbol':
      return setSymbol(d, op.ref, op.style);
    case 'set_footprint':
      return setFootprint(d, op);
    case 'rename_part':
      return renamePart(d, op);
    case 'describe':
      return describe(d, op);
    case 'set_package_defaults':
      return setPackageDefaults(d, op);
    case 'set_board':
      return setBoard(d, op);
    case 'place':
      return place(d, op);
    case 'propose_layout':
      return proposeLayout(d, op.keep_choices ?? true);
    case 'route':
      return routeStep(d);
    case 'set_plane':
      return setPlane(d, op);
    case 'add_hole':
      return addHole(d, op);
    case 'add_cutout':
      return addCutout(d, op);
    case 'set_outline':
      return setOutline(d, op);
    case 'add_graphic':
      return addGraphic(d, op);
    case 'edit_graphic':
      return editGraphic(d, op);
    case 'remove_graphic': {
      const b: BoardSettings = structuredClone(d.board ?? DEFAULT_BOARD);
      const before = b.graphics ?? [];
      const keep = op.id.toLowerCase() === 'all' ? [] : before.filter((g) => g.id.toUpperCase() !== op.id.toUpperCase());
      if (keep.length === before.length) reject({ code: 'REF_UNKNOWN', message: `No silkscreen graphic "${op.id}".`, candidates: before.map((g) => g.id) });
      if (keep.length) b.graphics = keep;
      else delete b.graphics;
      d.board = b;
      return { op: 'remove_graphic', effect: `removed ${before.length - keep.length} silkscreen graphic(s)`, ids: ['board'] };
    }
    case 'remove_cutout': {
      const b: BoardSettings = structuredClone(d.board ?? DEFAULT_BOARD);
      const before = b.cutouts ?? [];
      const keep = op.id.toLowerCase() === 'all' ? [] : before.filter((c) => c.id.toUpperCase() !== op.id.toUpperCase());
      if (keep.length === before.length) reject({ code: 'REF_UNKNOWN', message: `No cutout "${op.id}".`, candidates: before.map((c) => c.id) });
      if (keep.length) b.cutouts = keep;
      else delete b.cutouts;
      d.board = b;
      return { op: 'remove_cutout', effect: `removed ${before.length - keep.length} cutout(s)`, ids: ['board'] };
    }
    case 'remove_hole': {
      const b: BoardSettings = structuredClone(d.board ?? DEFAULT_BOARD);
      const before = b.holes ?? [];
      const keep = op.id.toLowerCase() === 'all' ? [] : before.filter((h) => h.id.toUpperCase() !== op.id.toUpperCase());
      if (keep.length === before.length) reject({ code: 'REF_UNKNOWN', message: `No mounting hole "${op.id}".`, candidates: before.map((h) => h.id) });
      b.holes = keep;
      d.board = b;
      return { op: 'remove_hole', effect: `removed ${before.length - keep.length} mounting hole(s)`, ids: ['board'] };
    }
    case 'remove_waiver': {
      if (!d.waivers[op.id]) reject({ code: 'WAIVER_UNKNOWN', message: `No waiver ${op.id}.`, candidates: Object.keys(d.waivers) });
      delete d.waivers[op.id];
      return { op: op.op, effect: `removed waiver ${op.id}`, ids: [op.id] };
    }
  }
}

/* --------------------------------- parts ---------------------------------- */

/* --------------------------------- board ---------------------------------- */

function setBoard(d: Design, op: Extract<EditOp, { op: 'set_board' }>): OpResult {
  const b: BoardSettings = structuredClone(d.board ?? DEFAULT_BOARD);
  const out: string[] = [];
  const size = (key: 'width' | 'height', v: number | null | undefined) => {
    if (v === undefined) return;
    if (v === null) delete b[key];
    else {
      if (v < 5 || v > 500) reject({ code: 'BOARD_INVALID', message: `Board ${key} ${v} mm is outside 5–500 mm.` });
      b[key] = v;
    }
    out.push(`${key} ${v === null ? 'fit to parts' : `${v} mm`}`);
  };
  if (b.shape && (op.width_mm !== undefined || op.height_mm !== undefined)) {
    // a free-form outline is scaled to the new size (one side given: proportionally)
    if (op.width_mm === null || op.height_mm === null) reject({ code: 'BOARD_INVALID', message: 'The board has a free-form outline, so its size is fixed; set_outline rectangle: true first.' });
    const r = boardOutline(b.shape, op.width_mm ?? undefined, op.height_mm ?? undefined);
    if (r.ok) {
      b.shape = r.pts;
      b.width = Math.max(...r.pts.filter((_, i) => i % 2 === 0));
      b.height = Math.max(...r.pts.filter((_, i) => i % 2 === 1));
      out.push(`outline scaled to ${b.width} × ${b.height} mm`);
    }
  } else {
    size('width', op.width_mm);
    size('height', op.height_mm);
  }
  if (op.layers) {
    b.layers = op.layers;
    out.push(`${op.layers} layers`);
  }
  const rule = (key: 'clearance' | 'track' | 'powerTrack', v: number | undefined, label: string) => {
    if (v === undefined) return;
    if (v < 0.075 || v > 5) reject({ code: 'BOARD_INVALID', message: `${label} ${v} mm is not manufacturable (0.075–5 mm).` });
    b.rules[key] = v;
    out.push(`${label} ${v} mm`);
  };
  rule('clearance', op.clearance_mm, 'clearance');
  rule('track', op.track_mm, 'track');
  rule('powerTrack', op.power_track_mm, 'power track');
  if (op.corner_radius_mm !== undefined) {
    if (op.corner_radius_mm > 50) reject({ code: 'BOARD_INVALID', message: `A ${op.corner_radius_mm} mm corner radius is too big.` });
    if (op.corner_radius_mm > 0) b.cornerRadius = op.corner_radius_mm;
    else delete b.cornerRadius;
    out.push(op.corner_radius_mm > 0 ? `corners rounded, r ${op.corner_radius_mm} mm` : 'square corners');
  }
  if (op.via_in_pad !== undefined) {
    if (op.via_in_pad) b.rules.viaInPad = true;
    else delete b.rules.viaInPad;
    out.push(op.via_in_pad ? 'vias in pads allowed' : 'no vias in pads');
  }
  if (!out.length) reject({ code: 'BOARD_INVALID', message: 'set_board needs at least one setting.' });
  d.board = b;
  return { op: 'set_board', effect: `board: ${out.join(', ')}`, ids: ['board'] };
}

/** Choose the net of a copper plane (or pour) per layer, or go back to automatic planes. */
function setPlane(d: Design, op: Extract<EditOp, { op: 'set_plane' }>): OpResult {
  const b: BoardSettings = structuredClone(d.board ?? DEFAULT_BOARD);
  if (op.auto) {
    delete b.planes;
    d.board = b;
    return { op: 'set_plane', effect: 'planes: automatic', ids: ['board'] };
  }
  if (!op.layer) reject({ code: 'BOARD_INVALID', message: 'set_plane needs a layer (or auto: true).' });
  const layers = b.layers === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu'];
  if (!layers.includes(op.layer!)) {
    reject({ code: 'BOARD_INVALID', message: `${op.layer} does not exist on a ${b.layers}-layer board; use set_board layers: 4 for inner planes.`, candidates: layers });
  }
  // explicit from now on: start from the automatic planes currently in effect
  const planes = b.planes ?? autoPlanes(d, b.layers).map(({ netId, layer }) => ({ netId, layer }));
  const rest = planes.filter((p) => p.layer !== op.layer);
  if (op.net === null || op.net === undefined) {
    b.planes = rest;
    d.board = b;
    return { op: 'set_plane', effect: `no plane on ${op.layer}`, ids: ['board'] };
  }
  const net = findNet(d, op.net);
  if (!net) reject({ code: 'NET_UNKNOWN', message: `No net "${op.net}".`, candidates: Object.values(d.nets).map((n) => n.name) });
  b.planes = [...rest, { netId: net!.id, layer: op.layer! as CopperLayer }];
  d.board = b;
  return { op: 'set_plane', effect: `${net!.name} plane on ${op.layer}${op.layer === 'F.Cu' || op.layer === 'B.Cu' ? ' (pour)' : ' (dedicated)'}`, ids: ['board'] };
}

/** A free-form board outline (an SVG path or points, scaled to the size asked for), or back to a rectangle. */
function setOutline(d: Design, op: Extract<EditOp, { op: 'set_outline' }>): OpResult {
  const b: BoardSettings = structuredClone(d.board ?? DEFAULT_BOARD);
  d.board = b;
  if (op.rectangle) {
    delete b.shape;
    return { op: 'set_outline', effect: `rectangular board${b.width && b.height ? ` ${b.width} × ${b.height} mm` : ''}`, ids: ['board'] };
  }
  let raw: number[];
  if (op.svg_path) {
    const r = pathPolygon(op.svg_path);
    if (!r.ok) reject({ code: 'BOARD_INVALID', message: `The outline path: ${r.reason}.` });
    raw = (r as { pts: number[] }).pts;
  } else if (op.points) raw = op.points.flat();
  else reject({ code: 'BOARD_INVALID', message: 'set_outline needs svg_path or points (or rectangle: true).' });
  if (!op.width_mm && !op.height_mm) reject({ code: 'BOARD_INVALID', message: 'Give the outline a size: width_mm or height_mm (or both).' });
  const r = boardOutline(raw!, op.width_mm, op.height_mm);
  if (!r.ok) reject({ code: 'BOARD_INVALID', message: `The outline: ${r.reason}.` });
  const pts = (r as { pts: number[] }).pts;
  const w = Math.max(...pts.filter((_, i) => i % 2 === 0));
  const h = Math.max(...pts.filter((_, i) => i % 2 === 1));
  if (w < 5 || h < 5 || w > 500 || h > 500) reject({ code: 'BOARD_INVALID', message: `The outline would be ${w} × ${h} mm; boards are 5–500 mm.` });
  b.shape = pts;
  b.width = w;
  b.height = h;
  return { op: 'set_outline', effect: `free-form outline, ${pts.length / 2} points, ${w} × ${h} mm`, ids: ['board'] };
}

/** A milled cutout: a rectangle, circle or slot, positioned from an anchor point. */
function addCutout(d: Design, op: Extract<EditOp, { op: 'add_cutout' }>): OpResult {
  const b: BoardSettings = structuredClone(d.board ?? DEFAULT_BOARD);
  const cutouts = [...(b.cutouts ?? [])];
  let id = '';
  for (let i = 1; ; i++) if (!cutouts.some((c) => c.id === `CO${i}`)) {
    id = `CO${i}`;
    break;
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  let c: Cutout;
  if (op.shape === 'circle') {
    const dia = op.diameter_mm ?? op.width_mm;
    if (!dia) reject({ code: 'BOARD_INVALID', message: 'A circular cutout needs diameter_mm.' });
    c = { id, shape: 'circle', x: r3(op.x_mm), y: r3(op.y_mm), w: dia! };
  } else {
    if (!op.width_mm || !op.height_mm) reject({ code: 'BOARD_INVALID', message: `A ${op.shape} cutout needs width_mm and height_mm${op.shape === 'slot' ? ' (length and width)' : ''}.` });
    if (op.shape === 'slot' && op.height_mm! > op.width_mm!) reject({ code: 'BOARD_INVALID', message: 'A slot is longer than it is wide: width_mm is its length, height_mm its width (use angle_deg to turn it).' });
    c = { id, shape: op.shape, x: r3(op.x_mm), y: r3(op.y_mm), w: op.width_mm!, h: op.height_mm!, ...(op.shape === 'rect' && op.corner_radius_mm ? { r: op.corner_radius_mm } : {}), ...(op.angle_deg ? { angle: op.angle_deg } : {}) };
  }
  if (op.anchor && op.anchor !== 'top_left') c.anchor = op.anchor;
  if (Math.max(c.w, c.h ?? 0) < 0.3) reject({ code: 'BOARD_INVALID', message: 'A cutout smaller than 0.3 mm cannot be milled.' });
  cutouts.push(c);
  b.cutouts = cutouts;
  d.board = b;
  const size = c.shape === 'circle' ? `Ø${c.w} mm` : `${c.w} × ${c.h} mm`;
  return { op: 'add_cutout', effect: `cutout ${id}: ${c.shape} ${size} at (${c.x}, ${c.y}) mm from ${c.anchor ?? 'top_left'}`.replace('_', ' '), ids: ['board'] };
}

/** A silkscreen graphic from an SVG path: scaled to its size, centred, placed from an anchor. */
function addGraphic(d: Design, op: Extract<EditOp, { op: 'add_graphic' }>): OpResult {
  let figs: number[][];
  const art = op.artwork ? findArtwork(op.artwork) : undefined;
  if (op.artwork) {
    if (!art) reject({ code: 'REF_UNKNOWN', message: `No saved artwork "${op.artwork}".`, candidates: listArtwork().map((a) => a.name) });
    figs = art!.polys;
  } else {
    if (!op.svg_path) reject({ code: 'BOARD_INVALID', message: 'add_graphic needs svg_path or artwork.' });
    const parsed = pathFigures(op.svg_path!);
    if (!parsed.ok) reject({ code: 'BOARD_INVALID', message: `The graphic's path: ${parsed.reason}.` });
    figs = parsed.figs;
  }
  const xs = figs.flatMap((p) => p.filter((_, i) => i % 2 === 0));
  const ys = figs.flatMap((p) => p.filter((_, i) => i % 2 === 1));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const [bw, bh] = [x1 - x0, y1 - y0];
  if (!(bw > 0) || !(bh > 0)) reject({ code: 'BOARD_INVALID', message: 'The graphic has no area.' });
  const sx = op.width_mm ? op.width_mm / bw : op.height_mm ? op.height_mm / bh : 1;
  const sy = op.height_mm ? op.height_mm / bh : op.width_mm ? op.width_mm / bw : 1;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const polys = figs.map((p) => p.map((v, i) => (i % 2 === 0 ? r3((v - (x0 + x1) / 2) * sx) : r3((v - (y0 + y1) / 2) * sy))));
  const [w, h] = [r3(bw * sx), r3(bh * sy)];
  if (Math.max(w, h) < 0.5) reject({ code: 'BOARD_INVALID', message: `The graphic would be ${w} × ${h} mm; silkscreen needs at least about 1 mm to be readable (give width_mm or height_mm).` });
  const b: BoardSettings = structuredClone(d.board ?? DEFAULT_BOARD);
  const graphics = [...(b.graphics ?? [])];
  let id = '';
  for (let i = 1; ; i++) if (!graphics.some((g) => g.id === `G${i}`)) {
    id = `G${i}`;
    break;
  }
  const mode = op.mode ?? art?.mode ?? 'fill';
  const name = op.name ?? art?.name;
  const g: SilkGraphic = {
    id,
    ...(name ? { name } : {}),
    side: op.side ?? 'top',
    mode,
    ...(mode === 'outline' ? { line: op.line_mm ?? art?.line ?? 0.2 } : {}),
    polys,
    w,
    h,
    x: r3(op.x_mm),
    y: r3(op.y_mm),
    ...(op.anchor && op.anchor !== 'top_left' ? { anchor: op.anchor } : {}),
    ...(op.angle_deg ? { angle: op.angle_deg } : {}),
  };
  graphics.push(g);
  b.graphics = graphics;
  d.board = b;
  const points = polys.reduce((n, p) => n + p.length / 2, 0);
  return {
    op: 'add_graphic',
    effect: `silkscreen graphic ${id}${g.name ? ` (${g.name})` : ''}: ${g.mode === 'fill' ? 'filled' : `outlines ${g.line} mm`}, ${polys.length} figure(s), ${points} points, ${w} × ${h} mm on the ${g.side} side at (${g.x}, ${g.y}) mm from ${(g.anchor ?? 'top_left').replace('_', ' ')}`,
    ids: ['board'],
  };
}

/** Move, resize, turn or restyle a silkscreen graphic (a drag in the layout view moves it by dx/dy). */
function editGraphic(d: Design, op: Extract<EditOp, { op: 'edit_graphic' }>): OpResult {
  const b: BoardSettings = structuredClone(d.board ?? DEFAULT_BOARD);
  const graphics = b.graphics ?? [];
  const g = graphics.find((x) => x.id.toUpperCase() === op.id.toUpperCase());
  if (!g) reject({ code: 'REF_UNKNOWN', message: `No silkscreen graphic "${op.id}".`, candidates: graphics.map((x) => x.id) });
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const changes: string[] = [];
  if (op.anchor && op.anchor !== (g.anchor ?? 'top_left')) {
    // keep its place unless a new x/y is given: re-measure the centre from the new anchor
    const { w, h } = placedNow(d).outline;
    const at = (a: string) => [a.endsWith('left') ? 0 : a.endsWith('right') ? w : w / 2, a.startsWith('top') ? 0 : a.startsWith('bottom') ? h : h / 2];
    const [ox, oy] = at(g.anchor ?? 'top_left');
    const [nx, ny] = at(op.anchor);
    g.x = r3(g.x + ox! - nx!);
    g.y = r3(g.y + oy! - ny!);
    if (op.anchor === 'top_left') delete g.anchor;
    else g.anchor = op.anchor;
    changes.push(`from ${op.anchor.replace('_', ' ')}`);
  }
  if (op.x_mm !== undefined) g.x = r3(op.x_mm);
  if (op.y_mm !== undefined) g.y = r3(op.y_mm);
  if (op.dx_mm) g.x = r3(g.x + op.dx_mm);
  if (op.dy_mm) g.y = r3(g.y + op.dy_mm);
  if (op.x_mm !== undefined || op.y_mm !== undefined || op.dx_mm || op.dy_mm) changes.push(`at (${g.x}, ${g.y}) mm`);
  if (op.angle_deg !== undefined) {
    if (op.angle_deg % 360) g.angle = op.angle_deg % 360;
    else delete g.angle;
    changes.push(`turned ${op.angle_deg}°`);
  }
  if (op.width_mm || op.height_mm) {
    const sx = op.width_mm ? op.width_mm / g.w : op.height_mm! / g.h;
    const sy = op.height_mm ? op.height_mm / g.h : sx;
    g.polys = g.polys.map((p) => p.map((v, i) => r3(v * (i % 2 === 0 ? sx : sy))));
    g.w = r3(g.w * sx);
    g.h = r3(g.h * sy);
    if (Math.max(g.w, g.h) < 0.5) reject({ code: 'BOARD_INVALID', message: 'That would make the graphic smaller than 0.5 mm.' });
    changes.push(`${g.w} × ${g.h} mm`);
  }
  if (op.mode) {
    g.mode = op.mode;
    changes.push(op.mode === 'fill' ? 'filled' : 'outlines');
  }
  if (op.line_mm) g.line = op.line_mm;
  if (g.mode === 'outline') g.line ??= 0.2;
  else delete g.line;
  if (op.side) {
    g.side = op.side;
    changes.push(`${op.side} side`);
  }
  if (op.name !== undefined) {
    if (op.name) g.name = op.name;
    else delete g.name;
  }
  d.board = b;
  return { op: 'edit_graphic', effect: `silkscreen graphic ${g.id}${g.name ? ` (${g.name})` : ''}: ${changes.join(', ') || 'unchanged'}`, ids: ['board'] };
}

/** Mounting holes: at fixed positions or anchored to corners (they follow the board size). */
function addHole(d: Design, op: Extract<EditOp, { op: 'add_hole' }>): OpResult {
  const b: BoardSettings = structuredClone(d.board ?? DEFAULT_BOARD);
  if (op.diameter_mm < 0.5 || op.diameter_mm > 10) reject({ code: 'BOARD_INVALID', message: `A ${op.diameter_mm} mm hole is outside 0.5–10 mm.` });
  const hasXY = op.x_mm !== undefined && op.y_mm !== undefined;
  if (!op.corner && !hasXY) reject({ code: 'BOARD_INVALID', message: 'add_hole needs a corner or x_mm and y_mm.' });
  let netId: string | undefined;
  if (op.net) {
    if (!op.plated) reject({ code: 'BOARD_INVALID', message: 'Only a plated hole can be on a net; add plated: true.' });
    const net = findNet(d, op.net);
    if (!net) reject({ code: 'NET_UNKNOWN', message: `No net "${op.net}".`, candidates: Object.values(d.nets).map((n) => n.name) });
    netId = net!.id;
  }
  const holes = [...(b.holes ?? [])];
  const nextId = () => {
    for (let i = 1; ; i++) if (!holes.some((h) => h.id === `MH${i}`)) return `MH${i}`;
  };
  const corners: HoleCorner[] = op.corner === 'all' ? ['top_left', 'top_right', 'bottom_left', 'bottom_right'] : op.corner ? [op.corner] : [];
  const added: string[] = [];
  const base = { d: op.diameter_mm, plated: !!op.plated, ...(netId ? { netId } : {}) };
  if (corners.length) {
    for (const corner of corners) {
      // one hole per corner: re-adding replaces it
      const i = holes.findIndex((h) => h.corner === corner);
      const hole: MountingHole = { id: i >= 0 ? holes[i]!.id : nextId(), ...base, corner, inset: op.inset_mm ?? Math.round((op.diameter_mm + 0.5) * 10) / 10 };
      if (i >= 0) holes[i] = hole;
      else holes.push(hole);
      added.push(`${hole.id} ${corner.replace('_', ' ')}`);
    }
  } else {
    const hole: MountingHole = { id: nextId(), ...base, x: op.x_mm!, y: op.y_mm! };
    holes.push(hole);
    added.push(`${hole.id} at (${op.x_mm}, ${op.y_mm}) mm`);
  }
  b.holes = holes;
  d.board = b;
  return { op: 'add_hole', effect: `mounting hole${added.length > 1 ? 's' : ''} Ø${op.diameter_mm} mm${op.plated ? ' plated' : ''}: ${added.join(', ')}`, ids: ['board'] };
}

/** The board as placed now (for ops that record where parts are). */
function placedNow(d: Design) {
  return placeBoard(d, layoutSchematic(d));
}

/** Store the current placement, so later layouts start from it. */
function keepPlacement(d: Design) {
  const b: BoardSettings = structuredClone(d.board ?? DEFAULT_BOARD);
  d.board = b;
  b.placement = storedPlacement(placedNow(d));
}

/**
 * Place a part: the user's choice (a soft position constraint, relative to the part's parent so
 * it follows when that moves), or with `lock` exactly there (hard). One per part; placing again
 * replaces it, keeping a rotation chosen before unless a new one is given.
 */
function place(d: Design, op: Extract<EditOp, { op: 'place' }>): OpResult {
  const comp = resolveComponent(d, op.ref);
  if (!d.board?.placement) keepPlacement(d); // start from what the user sees
  const now = placedNow(d);
  let rot: number | undefined = op.rot;
  let prevRel: string | undefined;
  for (const k of Object.values(d.ledger)) {
    if (k.kind !== 'position' || k.a !== comp.id) continue;
    if (rot === undefined && k.rot !== undefined) {
      // a rotation relative to an anchor: back to the board frame
      const anchor = k.rel ? now.parts.find((p) => p.componentId === k.rel) : undefined;
      rot = anchor ? (anchor.rot + k.rot) % 360 : k.rot;
    }
    prevRel = k.rel;
    delete d.ledger[k.id];
  }
  const id = nextId(d, 'k');
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const part = now.parts.find((p) => p.componentId === comp.id);
  const anchorRef = part?.follows ?? (prevRel ? d.components[prevRel]?.refdes : undefined);
  const anchor = !op.lock && anchorRef ? now.parts.find((p) => p.refdes === anchorRef) : undefined;
  if (anchor) {
    // offset and rotation in the anchor's frame
    const dx = op.x_mm - anchor.x;
    const dy = op.y_mm - anchor.y;
    const back = (360 - anchor.rot) % 360;
    const [ox, oy] = back === 90 ? [-dy, dx] : back === 180 ? [-dx, -dy] : back === 270 ? [dy, -dx] : [dx, dy];
    d.ledger[id] = {
      id,
      kind: 'position',
      a: comp.id,
      rel: anchor.componentId,
      xMm: r(ox),
      yMm: r(oy),
      ...(rot !== undefined && { rot: (((rot - anchor.rot) % 360) + 360) % 360 }),
      domain: 'placement',
      strength: 'soft',
      source: { type: 'user' },
    };
  } else {
    d.ledger[id] = {
      id,
      kind: 'position',
      a: comp.id,
      xMm: r(op.x_mm),
      yMm: r(op.y_mm),
      ...(rot !== undefined && { rot }),
      domain: 'placement',
      strength: op.lock ? 'hard' : 'soft',
      source: { type: 'user' },
    };
  }
  keepPlacement(d);
  const at = `(${r(op.x_mm)}, ${r(op.y_mm)}) mm${rot !== undefined ? `, ${rot}°` : ''}`;
  return { op: 'place', effect: op.lock ? `${comp.refdes} locked at ${at}` : `${comp.refdes} placed at ${at}${anchor ? ` (kept relative to ${anchor.refdes})` : ''}`, ids: [id] };
}

/** A fresh proposal: board size (unless set) and placement, keeping locked parts (and choices). */
function proposeLayout(d: Design, keepChoices: boolean): OpResult {
  let forgot = 0;
  if (!keepChoices) {
    for (const k of Object.values(d.ledger)) {
      if (k.kind === 'position' && k.strength === 'soft') {
        delete d.ledger[k.id];
        forgot++;
      }
    }
  }
  const b: BoardSettings = structuredClone(d.board ?? DEFAULT_BOARD);
  delete b.placement;
  delete b.routed;
  d.board = b;
  const now = placedNow(d);
  b.placement = storedPlacement(now);
  return { op: 'propose_layout', effect: `layout proposed: ${now.outline.w} × ${now.outline.h} mm${now.sizeBy === 'user' ? ' (your size)' : ''}, ${now.parts.filter((p) => !p.componentId.startsWith('hole:')).length} parts${forgot ? `, ${forgot} placement choice(s) forgotten` : ''}`, ids: ['board'] };
}

/** The route step: route the board as placed now (the board view routes while this placement stays). */
function routeStep(d: Design): OpResult {
  if (!d.board?.placement) keepPlacement(d);
  const now = placedNow(d);
  if (!now.parts.length) reject({ code: 'BOARD_INVALID', message: 'Nothing to route: the board has no parts.' });
  d.board!.routed = now.placementKey;
  return { op: 'route', effect: 'board routed as placed', ids: ['board'] };
}

/** Draw a part as one symbol or as units. Changes the design's copy of the part card only. */
function setSymbol(d: Design, ref: string, style: 'single' | 'units'): OpResult {
  const comp = resolveComponent(d, ref);
  const card = cardOf(d, comp.part)!;
  if (style === 'units' && (isTwoPin(card) || card.pins.length < 12)) {
    reject({ code: 'SYMBOL_STYLE', message: `${comp.refdes} (${card.id}) has ${card.pins.length} pins; only large ICs can be split into units.` });
  }
  const users = Object.values(d.components).filter((c) => c.part === card.id).map((c) => c.refdes).sort(natCmp);
  const copy: PartCard = structuredClone(card);
  if (style === 'units') copy.units = planUnits(copy.pins);
  else delete copy.units;
  d.parts[card.id] = copy;
  const what = style === 'units' ? `${copy.units!.length} units (${copy.units!.map((u) => `${u.name}: ${u.title}`).join('; ')})` : 'one symbol';
  return { op: 'set_symbol', effect: `${users.join(', ')} drawn as ${what}`, ids: [card.id] };
}

/**
 * Give a part an explicit land pattern (read off its datasheet drawing). Changes the design's copy
 * of the part card, so every component of that part gets it; a library part shared by components
 * that differ (generic resistors, caps …) is refused.
 */
function setFootprint(d: Design, op: Extract<EditOp, { op: 'set_footprint' }>): OpResult {
  const comp = resolveComponent(d, op.ref);
  const card = cardOf(d, comp.part)!;
  const users = Object.values(d.components).filter((c) => c.part === card.id).map((c) => c.refdes).sort(natCmp);
  if (card.id.startsWith('generic:') && users.length > 1) {
    reject({ code: 'FOOTPRINT_INVALID', message: `${card.id} is a generic part used by ${users.join(', ')}; its footprint follows each component's package parameter (set_param package).` });
  }
  const pkg: PackageInfo = {
    name: op.name,
    family: 'other',
    pins: card.pins.length,
    pads: op.pads,
    ...(op.body_mm ? { body_mm: op.body_mm } : {}),
    ...(op.round ? { body_shape: 'round' as const } : {}),
    ...(op.height_mm ? { height_mm: op.height_mm } : {}),
    ...(op.page ? { page: op.page } : {}),
  };
  const fp = footprintFor(pkg, card.pins.map((p) => p.number));
  if (!fp.ok) reject({ code: 'FOOTPRINT_INVALID', message: `${op.name} for ${comp.refdes}: ${fp.reason}.`, candidates: card.pins.map((p) => `${p.number} ${p.name}`) });
  const copy: PartCard = structuredClone(card);
  copy.packageInfo = pkg;
  copy.package = op.name;
  d.parts[card.id] = copy;
  const f = fp.footprint;
  return { op: 'set_footprint', effect: `${users.join(', ')}: footprint ${op.name}, ${f.pads.length} pads, ${f.courtyard.w} × ${f.courtyard.h} mm courtyard`, ids: [card.id] };
}

/** Packages for generic parts without their own: per kind, and automatic sizing. */
function setPackageDefaults(d: Design, op: Extract<EditOp, { op: 'set_package_defaults' }>): OpResult {
  const next = { ...(d.packageDefaults ?? {}) };
  const slots = ['resistor', 'capacitor', 'electrolytic', 'inductor', 'diode', 'led'] as const;
  const given: Partial<Record<(typeof slots)[number], string | null>> = {};
  if (op.passives) Object.assign(given, { resistor: op.passives, capacitor: op.passives, led: op.passives });
  for (const s of slots) if (op[s] !== undefined) given[s] = op[s];
  const changes: string[] = [];
  for (const [slot, name] of Object.entries(given) as [(typeof slots)[number], string | null][]) {
    if (name === null || name === '') {
      delete next[slot];
      changes.push(`${slot}: library default`);
      continue;
    }
    const pkg = standardPackage(name);
    if (!pkg) reject({ code: 'PARAM_INVALID', message: `Unknown package "${name}" for ${slot}s. Known e.g.: 0402, 0603, 0805, 1206, 2512, AXIAL-0.4, RADIAL-D8, CAP-8x10, IND-6x6, SOD-123, SMA, DO-41, LED-5mm.` });
    next[slot] = pkg.name;
    changes.push(`${slot}: ${pkg.name}`);
  }
  if (op.auto_size !== undefined) {
    if (op.auto_size) delete next.autoSize;
    else next.autoSize = false;
    changes.push(`automatic sizing ${op.auto_size ? 'on' : 'off'}`);
  }
  if (Object.keys(next).length) d.packageDefaults = next;
  else delete d.packageDefaults;
  return { op: 'set_package_defaults', effect: `package defaults: ${changes.join(', ') || 'unchanged'}`, ids: ['packages'] };
}

/** The design description: the overview, the functional blocks, or both. Blocks share no part. */
function describe(d: Design, op: Extract<EditOp, { op: 'describe' }>): OpResult {
  if (op.overview === undefined && !op.blocks) reject({ code: 'INVALID_OP', message: 'describe needs an overview, blocks, or both.' });
  const taken = new Map<string, string>();
  const blocks = op.blocks?.map((b) => {
    const components = [...new Set(b.refs.map((r) => resolveComponent(d, r).id))];
    for (const id of components) {
      const other = taken.get(id);
      if (other) reject({ code: 'INVALID_OP', message: `${d.components[id]!.refdes} is in two blocks ("${other}" and "${b.title}"); every part belongs to one block.` });
      taken.set(id, b.title);
    }
    return { title: b.title.trim(), components, text: b.text.trim() };
  });
  d.description = { overview: op.overview?.trim() ?? d.description?.overview ?? '', blocks: blocks ?? d.description?.blocks ?? [] };
  const left = descriptionView(d)!.undescribed;
  return {
    op: 'describe',
    effect:
      `description: ${[op.overview !== undefined && 'overview', blocks && `${blocks.length} block${blocks.length === 1 ? '' : 's'}`].filter(Boolean).join(', ')}` +
      (left.length ? `; in no block yet: ${left.join(', ')}` : ''),
    ids: ['description'],
  };
}

/** The description with its parts by refdes; parts removed since it was written drop out. */
export function descriptionView(d: Design): DescriptionView | null {
  if (!d.description) return null;
  const covered = new Set<string>();
  const blocks = d.description.blocks.map((b) => {
    const parts = b.components.flatMap((id) => (d.components[id] ? [d.components[id]!] : []));
    for (const c of parts) covered.add(c.id);
    return { title: b.title, refs: parts.map((c) => c.refdes).sort(natCmp), text: b.text };
  });
  const undescribed = Object.values(d.components).filter((c) => !covered.has(c.id)).map((c) => c.refdes).sort(natCmp);
  return { overview: d.description.overview, blocks, undescribed };
}

/** A part's shown name (part number); its id, which components refer to, stays. Changes the design's copy. */
function renamePart(d: Design, op: Extract<EditOp, { op: 'rename_part' }>): OpResult {
  const byRef = findComponent(d, op.part);
  const card = cardOf(d, byRef?.part ?? op.part);
  if (!card) reject({ code: 'PART_UNKNOWN', message: `No part or component "${op.part}".`, candidates: Object.keys(d.parts).slice(0, 8) });
  if (card.id.startsWith('generic:')) reject({ code: 'PART_UNKNOWN', message: `${card.id} is a generic part; give a component its part number with set_param mpn instead.` });
  if (op.mpn === undefined && op.title === undefined) reject({ code: 'PART_UNKNOWN', message: 'rename_part needs mpn or title.' });
  const copy: PartCard = structuredClone(card);
  const changes: string[] = [];
  if (op.mpn !== undefined && op.mpn.trim()) {
    changes.push(`${card.mpn ?? card.id} → ${op.mpn.trim()}`);
    copy.mpn = op.mpn.trim();
  }
  if (op.title !== undefined) {
    changes.push(`title "${op.title.trim()}"`);
    if (op.title.trim()) copy.title = op.title.trim();
    else delete copy.title;
  }
  d.parts[card.id] = copy;
  const users = Object.values(d.components).filter((c) => c.part === card.id).map((c) => c.refdes).sort(natCmp);
  return { op: 'rename_part', effect: `${card.id}: ${changes.join(', ')}${users.length ? ` (${users.join(', ')})` : ''}`, ids: [card.id] };
}

function lookupCard(d: Design, id: string): PartCard {
  const card = cardOf(d, id);
  if (!card) {
    const hits = searchParts(id.replace(/^[a-z]+:/i, ''), Object.values(d.parts)).slice(0, 5);
    reject({
      code: 'PART_UNKNOWN',
      message: `No part "${id}" in the library. Use design_query search_parts to find one.`,
      candidates: hits.map((p) => p.id),
    });
  }
  return card;
}

function validateParams(card: PartCard, params: Record<string, string | null>, refdes: string): void {
  const specs = paramSpecs(card);
  for (const [key, value] of Object.entries(params)) {
    const spec = specs[key];
    if (!spec) {
      reject({
        code: 'PARAM_UNKNOWN',
        message: `${refdes} (${card.id}) has no parameter "${key}". Allowed: ${Object.keys(specs).join(', ')}.`,
        candidates: Object.keys(specs),
      });
    }
    if (key === 'lcsc' && value !== null) {
      const n = normalizeLcsc(value);
      if (!n) reject({ code: 'PARAM_INVALID', message: `${refdes}.lcsc = "${value}" is not an LCSC part number (a C followed by digits, e.g. C25804).` });
      params[key] = n;
    }
    if (key === 'package' && value && !card.packageInfo && !standardPackage(value, card.pins.length)) {
      const opts = packageOptions(card);
      reject({
        code: 'PARAM_INVALID',
        message: `${refdes}: unknown package "${value}".${opts.length ? ` Known for this part: ${opts.join(', ')} (and KiCad names like R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm, CP_Radial_D8.0mm_P3.50mm).` : ''}`,
        candidates: opts,
      });
    }
    if (value === null || !spec.unit) continue;
    const q = parseQuantity(value);
    const range = PLAUSIBLE[spec.unit];
    if (!q || (q.unit !== '' && q.unit !== spec.unit) || !(q.value > 0) || (range && (q.value < range[0] || q.value > range[1]))) {
      reject({
        code: 'PARAM_INVALID',
        message: `${refdes}.${key} = "${value}" is not a valid value in ${spec.unit} (examples: ${example(spec.unit)}).`,
      });
    }
  }
}

/** Plausible magnitude per unit; catches "10k" typed for a capacitance. */
const PLAUSIBLE: Record<string, [number, number]> = {
  F: [1e-14, 10],
  H: [1e-10, 100],
  'Ω': [1e-4, 1e10],
  V: [1e-3, 1e5],
  A: [1e-9, 1e4],
  W: [1e-4, 1e4],
};

function example(unit: string): string {
  return ({ F: '100nF, 4.7uF', 'Ω': '10k, 4k7, 100R', H: '10uH', V: '25V', A: '2A', W: '0.25W' } as Record<string, string>)[unit] ?? `1${unit}`;
}

function addPart(d: Design, op: Extract<EditOp, { op: 'add_part' }>): OpResult {
  const card = lookupCard(d, op.part);
  if (op.refdes && findComponent(d, op.refdes)) {
    reject({ code: 'REFDES_TAKEN', message: `${op.refdes} already exists.`, candidates: [allocRefdes(d, card.refPrefix)] });
  }
  const refdes = op.refdes ?? allocRefdes(d, card.refPrefix);
  const params = op.params ?? {};
  validateParams(card, params, refdes);
  const missing = Object.entries(card.params)
    .filter(([k, s]) => s.required && params[k] === undefined)
    .map(([k]) => k);
  if (missing.length) {
    reject({
      code: 'PARAM_INVALID',
      message: `${card.id} requires ${missing.join(', ')}; pass them in params.`,
    });
  }
  const sheet = op.sheet ? sheetByName(d, op.sheet) : firstSheet(d);
  const id = nextId(d, 'c');
  if (!d.parts[card.id]) d.parts[card.id] = structuredClone(card);
  const comp: Component = { id, refdes, part: card.id, sheet, params: { ...params }, pins: {}, noConnect: [] };
  d.components[id] = comp;
  return { op: 'add_part', effect: `added ${refdes} (${card.id})`, ids: [id] };
}

function remove(d: Design, ref: string): OpResult {
  const c = resolveComponent(d, ref);
  delete d.components[c.id];
  const dropped: string[] = [];
  for (const k of Object.values(d.ledger)) {
    if (k.a === c.id || k.b === c.id) {
      delete d.ledger[k.id];
      dropped.push(k.id);
    }
  }
  return {
    op: 'remove',
    effect: `removed ${c.refdes}` + (dropped.length ? ` and ${dropped.length} constraint(s) on it` : ''),
    ids: [c.id, ...dropped],
  };
}

function setParam(d: Design, ref: string, params: Record<string, string | null>): OpResult {
  const c = resolveComponent(d, ref);
  const card = requireCard(d, c);
  validateParams(card, params, c.refdes);
  for (const [key, value] of Object.entries(params)) {
    for (const k of hardParamConstraints(d, c.id, key)) {
      if (value === null || !sameValue(value, k.value ?? '')) {
        reject({
          code: 'CONSTRAINT_CONFLICT',
          message: `${c.refdes}.${key} is fixed to ${k.value} by hard constraint ${k.id}` +
            (k.source.quote ? ` ("${k.source.quote}")` : '') + '. Ask the user before changing it.',
        });
      }
    }
    if (value === null) delete c.params[key];
    else c.params[key] = value;
  }
  return { op: 'set_param', effect: `${c.refdes}: ${Object.entries(params).map(([k, v]) => `${k}=${v ?? '∅'}`).join(', ')}`, ids: [c.id] };
}

function hardParamConstraints(d: Design, compId: string, key: string): Constraint[] {
  return Object.values(d.ledger).filter((k) => k.kind === 'param' && k.strength === 'hard' && k.a === compId && k.key === key);
}

export function sameValue(a: string, b: string): boolean {
  const qa = parseQuantity(a);
  const qb = parseQuantity(b);
  if (qa && qb) return approxEqual(qa.value, qb.value, 1e-3) && (qa.unit === qb.unit || qa.unit === '' || qb.unit === '');
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function rename(d: Design, ref: string, refdes: string): OpResult {
  const c = resolveComponent(d, ref);
  const other = findComponent(d, refdes);
  if (other && other.id !== c.id) reject({ code: 'REFDES_TAKEN', message: `${refdes} already exists.` });
  const old = c.refdes;
  c.refdes = refdes;
  return { op: 'rename', effect: `renamed ${old} → ${refdes}`, ids: [c.id] };
}

/* ------------------------------- connectivity ----------------------------- */

function flatPins(d: Design, refs: string[]): PinHandle[] {
  const out: PinHandle[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    for (const h of resolvePins(d, r)) {
      const key = `${h.comp.id}.${h.pin.number}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(h);
      }
    }
  }
  return out;
}

function connect(d: Design, refs: string[], netName?: string): OpResult {
  const pins = flatPins(d, refs);
  let target = netName ? findNet(d, netName) : undefined;

  const current = [...new Set(pins.map((h) => h.comp.pins[h.pin.number]).filter((n): n is string => !!n))].map((id) => d.nets[id]!);

  if (!target) {
    if (netName) {
      target = createNet(d, netName);
    } else {
      const named = current.filter((n) => !isAutoNet(n));
      if (named.length > 1) {
        reject({
          code: 'NET_MERGE_AMBIGUOUS',
          message: `These pins are on different nets (${named.map((n) => n.name).join(', ')}). Name the target net explicitly, or disconnect first.`,
        });
      }
      target = named[0] ?? current[0] ?? createNet(d);
    }
  }

  const merged: string[] = [];
  for (const h of pins) {
    const curId = h.comp.pins[h.pin.number];
    if (curId === target.id) continue;
    if (curId) {
      const cur = d.nets[curId]!;
      if (isAutoNet(cur)) {
        mergeNet(d, cur, target);
        merged.push(cur.name);
        continue;
      }
      reject({
        code: 'PIN_ALREADY_CONNECTED',
        message: `${pinLabel(h)} is already on net ${cur.name}. Disconnect it first, or connect to ${cur.name} instead.`,
        fixHints: [{ op: 'disconnect', pins: [pinLabel(h)] }],
      });
    }
    h.comp.pins[h.pin.number] = target.id;
    h.comp.noConnect = h.comp.noConnect.filter((n) => n !== h.pin.number);
  }
  return {
    op: 'connect',
    effect: `${pins.map(pinLabel).join(', ')} → ${target.name}` + (merged.length ? ` (merged ${merged.join(', ')})` : ''),
    ids: [target.id],
  };
}

function disconnect(d: Design, refs: string[]): OpResult {
  const pins = flatPins(d, refs);
  for (const h of pins) delete h.comp.pins[h.pin.number];
  return { op: 'disconnect', effect: `disconnected ${pins.map(pinLabel).join(', ')}` };
}

function noConnect(d: Design, refs: string[]): OpResult {
  const pins = flatPins(d, refs);
  for (const h of pins) {
    const cur = h.comp.pins[h.pin.number];
    if (cur) {
      reject({
        code: 'PIN_ALREADY_CONNECTED',
        message: `${pinLabel(h)} is connected to ${d.nets[cur]!.name}; disconnect it before marking it no-connect.`,
        fixHints: [{ op: 'disconnect', pins: [pinLabel(h)] }],
      });
    }
    if (!h.comp.noConnect.includes(h.pin.number)) h.comp.noConnect.push(h.pin.number);
  }
  return { op: 'no_connect', effect: `no-connect ${pins.map(pinLabel).join(', ')}` };
}

function setNet(d: Design, op: Extract<EditOp, { op: 'set_net' }>): OpResult {
  let net = findNet(d, op.net) ?? createNet(d, op.net);
  const changes: string[] = [];
  if (op.rename && op.rename !== net.name) {
    const other = findNet(d, op.rename);
    if (other && other.id !== net.id) {
      if (!isAutoNet(net)) {
        reject({ code: 'NET_NAME_TAKEN', message: `Net ${op.rename} already exists. Connect the pins to it instead of renaming.` });
      }
      mergeNet(d, net, other);
      changes.push(`merged into ${other.name}`);
      net = other;
    } else {
      changes.push(`renamed ${net.name} → ${op.rename}`);
      net.name = op.rename;
    }
  }
  const a = net.attrs;
  if (op.voltage !== undefined) {
    if (op.voltage === null) delete a.voltage;
    else a.voltage = op.voltage;
    changes.push(`voltage=${op.voltage ?? '∅'}`);
  }
  if (op.external !== undefined) {
    if (op.external) a.external = true;
    else delete a.external;
    changes.push(`external=${op.external}`);
  }
  if (op.power !== undefined) {
    if (op.power) a.power = true;
    else delete a.power;
    changes.push(`power=${op.power}`);
  }
  if (op.max_current !== undefined) {
    if (op.max_current === null) delete a.maxCurrent;
    else a.maxCurrent = op.max_current;
    changes.push(`max_current=${op.max_current ?? '∅'}`);
  }
  if (op.track_mm !== undefined) {
    if (op.track_mm === null) delete a.trackWidth;
    else {
      if (op.track_mm < 0.1 || op.track_mm > 10) reject({ code: 'PARAM_INVALID', message: `A track of ${op.track_mm} mm cannot be made; give 0.1–10 mm.` });
      a.trackWidth = Math.round(op.track_mm * 1000) / 1000;
    }
    changes.push(`track ${op.track_mm === null ? 'default' : `${a.trackWidth} mm`}`);
  }
  return { op: 'set_net', effect: `net ${net.name}: ${changes.join(', ') || 'no change'}`, ids: [net.id] };
}

/* --------------------------------- sheets --------------------------------- */

function firstSheet(d: Design): string {
  return Object.values(d.sheets).sort((a, b) => a.order - b.order)[0]!.id;
}

function sheetByName(d: Design, name: string): string {
  const s = Object.values(d.sheets).find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name);
  if (!s) reject({ code: 'SHEET_UNKNOWN', message: `No sheet "${name}". Add it with add_sheet first.`, candidates: Object.values(d.sheets).map((x) => x.name) });
  return s.id;
}

function addSheet(d: Design, name: string): OpResult {
  if (Object.values(d.sheets).some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    return { op: 'add_sheet', effect: `sheet ${name} already exists` };
  }
  const id = nextId(d, 's');
  d.sheets[id] = { id, name, order: Object.keys(d.sheets).length };
  return { op: 'add_sheet', effect: `added sheet ${name}`, ids: [id] };
}

function moveToSheet(d: Design, refs: string[], sheet: string): OpResult {
  const sid = sheetByName(d, sheet);
  const cs = refs.map((r) => resolveComponent(d, r));
  for (const c of cs) c.sheet = sid;
  return { op: 'move_to_sheet', effect: `moved ${cs.map((c) => c.refdes).join(', ')} to ${d.sheets[sid]!.name}` };
}

/* ------------------------------- constraints ------------------------------ */

const DIRECTIONAL = new Set(['left_of', 'right_of', 'above', 'below']);
const OPPOSITE: Record<string, string> = { left_of: 'right_of', right_of: 'left_of', above: 'below', below: 'above' };
const axis = (kind: string) => (kind === 'left_of' || kind === 'right_of' ? 'h' : 'v');

function constrain(d: Design, op: Extract<EditOp, { op: 'constrain' }>): OpResult {
  const need = (v: unknown, what: string): void => {
    if (v === undefined || v === '') reject({ code: 'CONSTRAINT_INVALID', message: `${op.kind} needs ${what}.` });
  };
  const k: Omit<Constraint, 'id'> = {
    kind: op.kind,
    domain: 'placement',
    strength: op.strength ?? 'soft',
    source: { type: 'user', ...(op.quote ? { quote: op.quote } : {}) },
  };

  if (DIRECTIONAL.has(op.kind) || op.kind === 'near') {
    need(op.a, '"a"');
    need(op.b, '"b"');
    // placement on the schematic may address single units of a split symbol ("U3B")
    const units = DIRECTIONAL.has(op.kind);
    const a = units ? resolveUnitRef(d, op.a!) : { comp: resolveComponent(d, op.a!) };
    const b = units ? resolveUnitRef(d, op.b!) : { comp: resolveComponent(d, op.b!) };
    if (a.comp.id === b.comp.id && (!a.unit || !b.unit || a.unit === b.unit)) {
      reject({ code: 'CONSTRAINT_INVALID', message: `${op.kind}: a and b are the same ${a.unit && a.unit === b.unit ? 'unit' : 'component'}.` });
    }
    k.a = a.comp.id;
    k.b = b.comp.id;
    if (a.unit) k.aUnit = a.unit;
    if (b.unit) k.bUnit = b.unit;
    if (op.kind === 'near') {
      k.maxMm = op.max_mm ?? 3;
    }
  } else if (op.kind === 'param') {
    need(op.a, '"a"');
    need(op.key, '"key"');
    need(op.value, '"value"');
    const a = resolveComponent(d, op.a!);
    const card = requireCard(d, a);
    validateParams(card, { [op.key!]: op.value! }, a.refdes);
    k.a = a.id;
    k.key = op.key!;
    k.value = op.value!;
    k.domain = 'param';
  } else if (op.kind === 'arrangement') {
    need(op.a, '"a" (one of the parts of the sub-circuit)');
    const a = resolveComponent(d, op.a!);
    const category = requireCard(d, a).category;
    const allowed = category === 'diode' ? ['diamond', 'inline'] : category === 'ic' ? ['power_flow', 'compact'] : [];
    if (!allowed.length) {
      reject({ code: 'CONSTRAINT_INVALID', message: `arrangement applies to diode bridges and regulator ICs; ${a.refdes} is neither.` });
    }
    if (!allowed.includes(op.value ?? '')) {
      reject({ code: 'CONSTRAINT_INVALID', message: `arrangement for ${a.refdes}: value must be ${allowed.map((v) => `"${v}"`).join(' or ')}.` });
    }
    k.a = a.id;
    k.value = op.value;
    k.domain = 'schematic';
  } else if (op.kind === 'layer') {
    need(op.a, '"a"');
    if (op.value !== 'top' && op.value !== 'bottom') reject({ code: 'CONSTRAINT_INVALID', message: 'layer: value must be "top" or "bottom".' });
    k.a = resolveComponent(d, op.a!).id;
    k.value = op.value;
  } else {
    need(op.value, '"value" (the note text)');
    if (op.a) k.a = resolveComponent(d, op.a).id;
    k.value = op.value!;
    k.domain = 'schematic';
  }

  // Replace an older constraint on the same subject instead of stacking contradictions.
  const replaced: string[] = [];
  for (const old of Object.values(d.ledger)) {
    const samePair = old.a !== undefined && k.b !== undefined && ((old.a === k.a && old.b === k.b) || (old.a === k.b && old.b === k.a));
    const clash =
      (DIRECTIONAL.has(k.kind) && DIRECTIONAL.has(old.kind) && samePair && axis(k.kind) === axis(old.kind)) ||
      (k.kind === 'near' && old.kind === 'near' && samePair) ||
      (k.kind === 'param' && old.kind === 'param' && old.a === k.a && old.key === k.key) ||
      (k.kind === 'layer' && old.kind === 'layer' && old.a === k.a) ||
      (k.kind === 'arrangement' && old.kind === 'arrangement' && old.a === k.a);
    if (!clash) continue;
    const contradicts =
      DIRECTIONAL.has(k.kind) &&
      !((old.a === k.a && old.kind === k.kind) || (old.a === k.b && old.kind === OPPOSITE[k.kind]));
    const valueChange = (k.kind === 'param' || k.kind === 'layer' || k.kind === 'arrangement') && !sameValue(old.value ?? '', k.value ?? '');
    if (old.strength === 'hard' && (contradicts || valueChange)) {
      reject({
        code: 'CONSTRAINT_CONFLICT',
        message: `Conflicts with hard constraint ${old.id} (${describeConstraint(d, old)}). Ask the user, then remove_constraint ${old.id} first.`,
        fixHints: [{ op: 'remove_constraint', id: old.id }],
      });
    }
    delete d.ledger[old.id];
    replaced.push(old.id);
  }

  const id = nextId(d, 'k');
  d.ledger[id] = { id, ...k };
  return {
    op: 'constrain',
    effect: `${describeConstraint(d, d.ledger[id]!)}` + (replaced.length ? ` (replaces ${replaced.join(', ')})` : ''),
    ids: [id],
  };
}

/** "U3" or one unit of a split symbol, "U3B". */
function resolveUnitRef(d: Design, ref: string): { comp: Component; unit?: string } {
  const direct = findComponent(d, ref);
  if (direct) return { comp: direct };
  const m = /^(.*\d)([A-Z])$/i.exec(ref.trim());
  const comp = m ? findComponent(d, m[1]!) : undefined;
  const units = comp ? cardOf(d, comp.part)?.units ?? [] : [];
  const unit = m ? units.find((u) => u.name === m[2]!.toUpperCase()) : undefined;
  if (comp && unit) return { comp, unit: unit.name };
  if (comp) {
    reject({
      code: 'REF_UNKNOWN',
      message: units.length ? `${comp.refdes} has units ${units.map((u) => u.name).join(', ')}, not "${m![2]}".` : `${comp.refdes} is drawn as one symbol; split it first (set_symbol style "units") to place units separately.`,
      candidates: units.map((u) => `${comp.refdes}${u.name}`),
    });
  }
  return { comp: resolveComponent(d, ref) };
}

export function describeConstraint(d: Design, k: Constraint): string {
  const ref = (id?: string) => (id ? d.components[id]?.refdes ?? id : '?');
  const n = ref;
  switch (k.kind) {
    case 'param':
      return `${n(k.a)}.${k.key} = ${k.value}`;
    case 'near':
      return `near(${n(k.a)}, ${n(k.b)}, ≤${k.maxMm}mm)`;
    case 'layer':
      return `layer(${n(k.a)}) = ${k.value}`;
    case 'arrangement':
      return `arrangement(${n(k.a)}) = ${k.value}`;
    case 'position':
      return `position(${n(k.a)}) = (${k.xMm}, ${k.yMm}) mm${k.rel ? ` from ${n(k.rel)}` : ''}${k.rot !== undefined ? ` ${k.rot}°` : ''}${k.strength === 'hard' ? ', locked' : ''}`;
    case 'note':
      return `note${k.a ? `(${n(k.a)})` : ''}: ${k.value}`;
    default:
      return `${k.kind}(${ref(k.a)}${k.aUnit ?? ''}, ${ref(k.b)}${k.bUnit ?? ''})`;
  }
}

export { closest };
