/**
 * Keep-outs (docs/design/layout.md §11): areas where tracks, vias, pours or parts are not allowed
 * on some layers (add_keepout, edit_keepout, remove_keepout). The ops store them in the board
 * settings; the placement turns them into BoardKeepouts (those attached to a part where the part
 * stands). The pours are cut round them, the router, the placer and the drawn copper keep out of
 * them, and DRC.KEEPOUT finds what is in one anyway.
 */
import {
  KEEPOUT_FORBID,
  type BoardDiagnostic,
  type BoardKeepout,
  type BoardSettings,
  type BoardView,
  type CopperLayer,
  type Design,
  type EditOp,
  type Keepout,
  type KeepoutForbid,
  type OpResult,
} from '@4k7/schema';
import { copperName } from './drc.ts';
import { boardCopy, reject, resolveComponent } from './doc.ts';
import { boxInKeepout, partForbidden, properCross, trackInKeepout, viaInKeepout } from './keepgeo.ts';

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Default for a keep-out that does not say what it forbids: the copper. */
const COPPER_FORBID: KeepoutForbid[] = ['tracks', 'vias', 'pours'];

/** The layers a keep-out can name on a board with this many copper layers. */
const boardLayers = (n: number): CopperLayer[] => (n === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu']);

/* ----------------------------------- checks ----------------------------------- */

/**
 * DRC.KEEPOUT: tracks, vias and parts inside a keep-out that forbids them (copper the router did
 * not lay: kept or drawn). The pours are cut round keep-outs, so they never are. `focus`: only
 * these drawn tracks and vias (by id).
 */
export function keepoutDrc(b: BoardView, focus?: Set<string>): BoardDiagnostic[] {
  const out: BoardDiagnostic[] = [];
  if (!b.keepouts?.length) return out;
  const idOf = (x: object) => (x as { id?: string }).id;
  const inFocus = (x: object) => !focus || focus.has(idOf(x) ?? '');
  const label = (k: BoardKeepout) => `keep-out ${k.id}${k.name ? ` (${k.name})` : ''}`;
  const seen = new Set<string>();
  const add = (key: string, d: BoardDiagnostic) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };
  for (const t of b.tracks) {
    if (!inFocus(t)) continue;
    const hit = trackInKeepout(b.keepouts, b.parts, t.layer, t.pts, t.width);
    if (!hit) continue;
    const what = copperName(b, 'track', t);
    add(`${what}|${hit.keepout.id}`, {
      code: 'DRC.KEEPOUT',
      severity: 'error',
      message: `${what} on ${t.layer} enters ${label(hit.keepout)} at (${hit.x}, ${hit.y}), which holds tracks off. Route it round (edit_copper move, or erase_copper and draw it again), or change the keep-out (edit_keepout, remove_keepout).`,
      at: { x: hit.x, y: hit.y },
      entities: idOf(t) ? [idOf(t)!] : [],
    });
  }
  if (!focus || b.vias.some(inFocus)) {
    for (const v of b.vias) {
      if (!inFocus(v)) continue;
      const k = viaInKeepout(b.keepouts, v.x, v.y, v.pad);
      if (!k) continue;
      const what = copperName(b, 'via', v);
      add(`${what}|${k.id}|${v.x}|${v.y}`, {
        code: 'DRC.KEEPOUT',
        severity: 'error',
        message: `${what} at (${v.x}, ${v.y}) lies in ${label(k)}, which holds vias off. Move it (edit_copper move) or change the keep-out.`,
        at: { x: v.x, y: v.y },
        entities: idOf(v) ? [idOf(v)!] : [],
      });
    }
  }
  if (focus) return out;
  for (const k of b.keepouts) {
    if (!k.forbid.includes('parts')) continue;
    for (const p of b.parts) {
      if (p.componentId === k.partId || !partForbidden(k, p)) continue;
      const c = p.courtyard;
      if (!boxInKeepout(k, c.x, c.y, c.x + c.w, c.y + c.h)) continue;
      add(`${p.refdes}|${k.id}`, {
        code: 'DRC.KEEPOUT',
        severity: 'error',
        message: `${p.refdes} lies in ${label(k)}, which holds parts off. Move it out (place with x_mm, y_mm) or change the keep-out.`,
        at: { x: r3(c.x + c.w / 2), y: r3(c.y + c.h / 2) },
        entities: [p.refdes],
      });
    }
  }
  return out;
}

/* ------------------------------ drawn copper checks ------------------------------ */

/** The op that lets a keep-out allow one thing it forbids (the last one: removes it). */
const relax = (k: BoardKeepout, what: KeepoutForbid): EditOp => {
  const rest = k.forbid.filter((f) => f !== what);
  return rest.length ? { op: 'edit_keepout', id: k.id, forbid: rest } : { op: 'remove_keepout', id: k.id };
};

/** A track about to be drawn would lie in a keep-out: say so, with the way out. */
export function rejectTrackInKeepout(board: BoardView, layer: CopperLayer, pts: number[], width: number, what = 'The track') {
  const hit = trackInKeepout(board.keepouts, board.parts, layer, pts, width);
  if (!hit) return;
  const k = hit.keepout;
  reject({
    code: 'KEEPOUT_HIT',
    message: `${what} on ${layer} would enter keep-out ${k.id}${k.name ? ` (${k.name})` : ''} at (${hit.x}, ${hit.y}); it holds tracks off${k.layers.length < board.layers.length ? ` on ${k.layers.join(', ')}` : ''}. Route round it (waypoints in via, or another layer), or change the keep-out.`,
    fixHints: [relax(k, 'tracks')],
  });
}

/** A via about to be drawn would lie in a keep-out. */
export function rejectViaInKeepout(board: BoardView, x: number, y: number, pad: number) {
  const k = viaInKeepout(board.keepouts, x, y, pad);
  if (!k) return;
  reject({
    code: 'KEEPOUT_HIT',
    message: `A via at (${x}, ${y}) would lie in keep-out ${k.id}${k.name ? ` (${k.name})` : ''}, which holds vias off. Put it outside (a layer change next to the zone), or change the keep-out.`,
    fixHints: [relax(k, 'vias')],
  });
}

/* --------------------------------------- ops --------------------------------------- */

/** The corners an op gives, flat (rect: four corners clockwise), or null when it gives none. */
function cornersOf(op: { rect?: { x_mm: number; y_mm: number; width_mm: number; height_mm: number } | undefined; polygon?: { x_mm: number; y_mm: number }[] | undefined }): number[] | null {
  if (op.rect && op.polygon) reject({ code: 'BOARD_INVALID', message: 'Give the area as rect or polygon, not both.' });
  if (op.rect) {
    const { x_mm: x, y_mm: y, width_mm: w, height_mm: h } = op.rect;
    return [x, y, x + w, y, x + w, y + h, x, y + h].map(r3);
  }
  if (!op.polygon) return null;
  const pts = op.polygon.flatMap((p) => [r3(p.x_mm), r3(p.y_mm)]);
  // a polygon with no area, or crossing itself, has no inside to keep
  let area = 0;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) area += pts[j]! * pts[i + 1]! - pts[i]! * pts[j + 1]!;
  if (Math.abs(area) / 2 < 0.01) reject({ code: 'BOARD_INVALID', message: 'The polygon has no area (its corners lie on a line). Give at least three corners that enclose something.' });
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (properCross(pts[2 * i]!, pts[2 * i + 1]!, pts[2 * i + 2]!, pts[2 * i + 3]!, pts[2 * j]!, pts[2 * j + 1]!, pts[2 * ((j + 1) % n)]!, pts[2 * ((j + 1) % n) + 1]!)) {
        reject({ code: 'BOARD_INVALID', message: `The polygon crosses itself (its sides ${i + 1} and ${j + 1}); list the corners in order round the area.` });
      }
    }
  }
  return pts;
}

function layersOf(layers: CopperLayer[] | 'all' | undefined, nLayers: number): CopperLayer[] | 'all' {
  if (layers === undefined || layers === 'all') return 'all';
  const has = boardLayers(nLayers);
  const bad = layers.filter((l) => !has.includes(l));
  if (bad.length) reject({ code: 'BOARD_INVALID', message: `${bad.join(', ')} ${bad.length > 1 ? 'do' : 'does'} not exist on a ${nLayers}-layer board.`, candidates: has });
  return [...new Set(layers)];
}

function forbidOf(forbid: KeepoutForbid[] | undefined): KeepoutForbid[] {
  const f = forbid ?? COPPER_FORBID;
  return KEEPOUT_FORBID.filter((x) => f.includes(x));
}

/** What a keep-out says of itself, for an op's effect. */
function describe(k: Keepout, b: BoardSettings, d: Design): string {
  const xs = k.poly.filter((_, i) => i % 2 === 0);
  const ys = k.poly.filter((_, i) => i % 2 === 1);
  const host = k.part ? d.components[k.part]?.refdes : undefined;
  const box = `${r3(Math.max(...xs) - Math.min(...xs))} × ${r3(Math.max(...ys) - Math.min(...ys))} mm`;
  return `keep-out ${k.id}${k.name ? ` "${k.name}"` : ''}: ${box} ${host ? `in the frame of ${host}` : `at (${r3(Math.min(...xs))}, ${r3(Math.min(...ys))})`}, no ${k.forbid.join(', ')} on ${k.layers === 'all' ? `all ${b.layers} layers` : k.layers.join(', ')}`;
}

export function addKeepout(d: Design, op: Extract<EditOp, { op: 'add_keepout' }>): OpResult {
  const b = boardCopy(d);
  const poly = cornersOf(op);
  if (!poly) reject({ code: 'BOARD_INVALID', message: 'A keep-out needs its area: rect (x_mm, y_mm, width_mm, height_mm) or polygon (corners).' });
  const list = [...(b.keepouts ?? [])];
  let id = '';
  for (let i = 1; ; i++) if (!list.some((k) => k.id === `KO${i}`)) {
    id = `KO${i}`;
    break;
  }
  const part = op.part ? resolveComponent(d, op.part) : undefined;
  if (part && part.id.startsWith('hole:')) reject({ code: 'BOARD_INVALID', message: `${part.refdes} is a mounting hole; attach the keep-out to a part.` });
  const k: Keepout = { id, ...(op.name ? { name: op.name } : {}), poly: poly!, layers: layersOf(op.layers, b.layers), forbid: forbidOf(op.forbid), ...(part ? { part: part.id } : {}) };
  list.push(k);
  b.keepouts = list;
  d.board = b;
  return { op: 'add_keepout', effect: describe(k, b, d), ids: ['board'] };
}

export function editKeepout(d: Design, op: Extract<EditOp, { op: 'edit_keepout' }>): OpResult {
  const b = boardCopy(d);
  const list = [...(b.keepouts ?? [])];
  const i = list.findIndex((k) => k.id.toUpperCase() === op.id.toUpperCase());
  if (i < 0) reject({ code: 'REF_UNKNOWN', message: `No keep-out "${op.id}".`, candidates: list.map((k) => k.id) });
  const k: Keepout = { ...list[i]! };
  const poly = cornersOf(op);
  if (poly) k.poly = poly;
  if (op.part !== undefined) {
    if (op.part === null) delete k.part;
    else {
      const part = resolveComponent(d, op.part);
      if (part.id.startsWith('hole:')) reject({ code: 'BOARD_INVALID', message: `${part.refdes} is a mounting hole; attach the keep-out to a part.` });
      k.part = part.id;
    }
    if (!poly) reject({ code: 'BOARD_INVALID', message: 'Attaching or detaching a keep-out changes the frame its area is in: give the area again (rect or polygon) in the new frame.' });
  }
  if (op.name !== undefined) {
    if (op.name === null) delete k.name;
    else k.name = op.name;
  }
  if (op.layers !== undefined) k.layers = layersOf(op.layers, b.layers);
  if (op.forbid !== undefined) k.forbid = forbidOf(op.forbid);
  list[i] = k;
  b.keepouts = list;
  d.board = b;
  return { op: 'edit_keepout', effect: describe(k, b, d), ids: ['board'] };
}

export function removeKeepout(d: Design, op: Extract<EditOp, { op: 'remove_keepout' }>): OpResult {
  const b = boardCopy(d);
  const before = b.keepouts ?? [];
  const keep = op.id.toLowerCase() === 'all' ? [] : before.filter((k) => k.id.toUpperCase() !== op.id.toUpperCase());
  if (keep.length === before.length) reject({ code: 'REF_UNKNOWN', message: `No keep-out "${op.id}".`, candidates: before.map((k) => k.id) });
  if (keep.length) b.keepouts = keep;
  else delete b.keepouts;
  d.board = b;
  return { op: 'remove_keepout', effect: `removed ${before.length - keep.length} keep-out(s)`, ids: ['board'] };
}
