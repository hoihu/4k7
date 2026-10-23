/**
 * Drawn copper (docs/design/layout.md §9): the agent lays the board's copper itself. Tracks and
 * vias are design data (BoardSettings.drawn), drawn exactly as given; the ops refuse only what
 * cannot be meant. What an op drew, edited or moved is checked once its transaction is applied
 * (annotateChecks: other copper too close, the edge, the fab's limits as errors; loose ends and
 * pieces off 45° as warnings, in the op's effect), and the DRC judges the whole board. Copper next
 * to a part that moves goes with it (followParts). The router stays as a helper the agent calls on
 * named connections (route nets / from, to): what it finds is added as drawn copper, round what is
 * drawn already. The app runs that search in a worker and hands the transaction its result
 * (RouteHelperResult), so the kernel stays responsive and the user can watch and stop it.
 */
import { DEFAULT_BOARD, padHasPin, type BoardDiagnostic, type BoardPad, type BoardPart, type BoardSettings, type BoardView, type Design, type DrawnCopper, type DrawnTrack, type DrawnVia, type EditOp, type OpResult, type PadAnchor, type RouteHelperResult, type Track, type Via } from '@4k7/schema';
import { boardRouteInput, copperKey, placeBoard, rotate, softened, storedPlacement } from './board.ts';
import { findNet, isPowerNet, reject, resolveComponent, resolvePins } from './doc.ts';
import { schematicView } from './drawing.ts';
import { copperDrc, drawnDrc, edgeDrc } from './drc.ts';
import { padPointDist } from './keep.ts';
import { route, type RouteProgress, type RouteResult } from './router.ts';

/** How long the route helper may search, ms (the user would rather wait than get less). */
const HELPER_BUDGET_MS = 30_000;
/** How far round a moved part's courtyard its copper goes with it (its fanout), mm. */
const FOLLOW_MM = 1;
/** Findings of the check named in an op's effect (the rest: get_board). */
const CHECK_SHOWN = 4;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

const placed = (d: Design) => placeBoard(d, schematicView(d));

/** The board settings to change (a copy), with the placement stored so the parts stay where they are. */
function boardOf(d: Design): BoardSettings {
  const b: BoardSettings = structuredClone(d.board ?? DEFAULT_BOARD);
  if (!b.placement) {
    d.board = b;
    b.placement = storedPlacement(placed(d));
  }
  d.board = b;
  return b;
}

function drawnOf(d: Design): { b: BoardSettings; dc: DrawnCopper } {
  if (!d.board?.drawn) reject({ code: 'BOARD_INVALID', message: 'The copper is the router\'s. Draw it yourself after set_copper_mode mode "drawn".', fixHints: [{ op: 'set_copper_mode', mode: 'drawn' }] });
  const b = boardOf(d);
  return { b, dc: b.drawn! };
}

const nextId = (dc: DrawnCopper, kind: 't' | 'v') => `${kind}${dc.next++}`;

/** A pad on the board by pin reference ("U1.3", "U1.VIN"): the pad, its anchor, its net. */
function padOf(d: Design, board: BoardView, ref: string): { pad: BoardPad; anchor: PadAnchor } {
  const dot = ref.lastIndexOf('.');
  if (dot <= 0) reject({ code: 'PIN_UNKNOWN', message: `"${ref}" is not a pad reference; use "<refdes>.<pad>", e.g. "U1.3" (or a via of yours, "v4").` });
  const comp = resolveComponent(d, ref.slice(0, dot));
  const part = board.parts.find((p) => p.componentId === comp.id);
  if (!part) reject({ code: 'BOARD_INVALID', message: `${comp.refdes} is not on the board.` });
  const key = ref.slice(dot + 1).toUpperCase();
  let pad = part!.pads.find((p) => p.number.toUpperCase() === key) ?? part!.pads.find((p) => padHasPin(p, key));
  if (!pad) {
    const pins = resolvePins(d, ref).map((h) => h.pin.number);
    pad = part!.pads.find((p) => pins.some((n) => padHasPin(p, n)));
  }
  if (!pad) reject({ code: 'PIN_UNKNOWN', message: `${comp.refdes} has no pad "${ref.slice(dot + 1)}".`, candidates: [...new Set(part!.pads.map((p) => `${comp.refdes}.${p.number}`))] });
  return { pad: pad!, anchor: { componentId: comp.id, pad: pad!.number } };
}

/** A track end as given: a pad (anchored), one of the drawn vias, or a point. */
interface End {
  x: number;
  y: number;
  ref?: string;
  pad?: BoardPad;
  anchor?: PadAnchor;
  via?: DrawnVia;
}

function endOf(d: Design, board: BoardView, dc: DrawnCopper, e: string | [number, number]): End {
  if (typeof e !== 'string') return { x: e[0], y: e[1] };
  if (/^v\d+$/i.test(e)) {
    const via = dc.vias.find((v) => v.id === e.toLowerCase());
    if (!via) reject({ code: 'REF_UNKNOWN', message: `No via ${e} is drawn.`, candidates: dc.vias.map((v) => v.id).slice(0, 40) });
    return { x: via!.x, y: via!.y, ref: via!.id, via: via! };
  }
  const { pad, anchor } = padOf(d, board, e);
  return { x: pad.x, y: pad.y, ref: e, pad, anchor };
}

const netName = (d: Design, id: string) => d.nets[id]?.name ?? id;

/** The width a net's track gets unless given: its own, power width for a supply, else the signal width. */
function defaultWidth(d: Design, netId: string): number {
  const rules = (d.board ?? DEFAULT_BOARD).rules;
  const net = d.nets[netId];
  return net?.attrs.trackWidth ?? (net && isPowerNet(net) ? rules.powerTrack : rules.track);
}

/** Inner layers with a plane take no tracks (the router closes them, the plane fills them). */
function planeLayer(board: BoardView, layer: string): string | undefined {
  if (layer === 'F.Cu' || layer === 'B.Cu') return undefined;
  const pl = board.planes.find((p) => p.layer === layer);
  return pl ? (board.netNames[pl.netId] ?? pl.netId) : undefined;
}

/** Refuses a layer the board does not have, or one that is a plane. */
function trackLayer(board: BoardView, layer: string) {
  if (!board.layers.includes(layer as BoardView['layers'][number])) reject({ code: 'BOARD_INVALID', message: `${layer} does not exist on a ${board.layers.length}-layer board.`, candidates: board.layers });
  const plane = planeLayer(board, layer);
  if (plane) reject({ code: 'BOARD_INVALID', message: `${layer} is the ${plane} plane: tracks run on the outer layers (a via reaches the plane).` });
}

/* ------------------------------- 45° corners ------------------------------ */

type Bend = 'diagonal_first' | 'straight_first';
const EPS_45 = 0.002;

/** Whether a step runs horizontal, vertical or at 45° (to the 0.001 mm the points are kept at). */
const octilinear = (dx: number, dy: number) => Math.abs(dx) < EPS_45 || Math.abs(dy) < EPS_45 || Math.abs(Math.abs(dx) - Math.abs(dy)) < EPS_45;

/** The corner between two points not on a 45° line: one diagonal and one straight piece. */
function dogleg(ax: number, ay: number, bx: number, by: number, bend: Bend): [number, number] | null {
  const dx = bx - ax;
  const dy = by - ay;
  if (octilinear(dx, dy)) return null;
  const m = Math.min(Math.abs(dx), Math.abs(dy));
  const [ex, ey] = [Math.sign(dx) * m, Math.sign(dy) * m];
  return bend === 'diagonal_first' ? [r3(ax + ex), r3(ay + ey)] : [r3(bx - ex), r3(by - ey)];
}

/** A track's points (flat) through the given ones, without repeats; with `bend`, a 45° corner wherever two in a row need one. */
function polyline(points: { x: number; y: number }[], bend?: Bend): number[] {
  const pts: number[] = [];
  const add = (x: number, y: number) => {
    if (pts.length && Math.abs(pts.at(-2)! - x) < 1e-6 && Math.abs(pts.at(-1)! - y) < 1e-6) return;
    pts.push(r3(x), r3(y));
  };
  for (const { x, y } of points) {
    if (bend && pts.length) {
      const k = dogleg(pts.at(-2)!, pts.at(-1)!, x, y, bend);
      if (k) add(k[0], k[1]);
    }
    add(x, y);
  }
  return pts;
}

const pointsOf = (pts: number[]) => Array.from({ length: pts.length / 2 }, (_, i) => ({ x: pts[2 * i]!, y: pts[2 * i + 1]! }));

/** A track's points without repeats and without corners where it runs straight on (after a move bent it). */
function simplify(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const [x, y] = [pts[i]!, pts[i + 1]!];
    if (out.length >= 2 && Math.abs(out.at(-2)! - x) < 1e-6 && Math.abs(out.at(-1)! - y) < 1e-6) continue;
    if (out.length >= 4) {
      const [ax, ay, bx, by] = [out.at(-4)!, out.at(-3)!, out.at(-2)!, out.at(-1)!];
      const cross = (bx - ax) * (y - by) - (by - ay) * (x - bx);
      const dot = (bx - ax) * (x - bx) + (by - ay) * (y - by);
      if (dot >= 0 && Math.abs(cross) <= 0.0015 * Math.hypot(bx - ax, by - ay)) {
        out[out.length - 2] = x;
        out[out.length - 1] = y;
        continue;
      }
    }
    out.push(x, y);
  }
  return out;
}

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([x, y]) => [x! / Math.SQRT2, y! / Math.SQRT2] as [number, number])];

/**
 * A piece stretched by a move, from its end that stayed (f) to the end that moved (from o to m):
 * the corner that keeps the piece's old direction at f and reaches m at 45° or 90°, or null where
 * the piece still runs at 45° or was off 45° already.
 */
function rebend(fx: number, fy: number, ox: number, oy: number, mx: number, my: number): [number, number] | null {
  const len = Math.hypot(ox - fx, oy - fy);
  if (len < 0.05 || !octilinear(ox - fx, oy - fy) || octilinear(mx - fx, my - fy)) return null;
  const [dx, dy] = [(ox - fx) / len, (oy - fy) / len];
  let best: { cost: number; k: [number, number] } | null = null;
  for (const [ex, ey] of DIRS) {
    const det = dx * ey - dy * ex;
    if (Math.abs(det) < 1e-9) continue;
    if (dx * ex + dy * ey < -1e-6) continue; // a turn sharper than 90°
    // f + s·d + u·e = m
    const [rx, ry] = [mx - fx, my - fy];
    const s = (rx * ey - ry * ex) / det;
    const u = (dx * ry - dy * rx) / det;
    if (s < 0 || u < 0) continue;
    const cost = s + u + (Math.abs(dx * ex + dy * ey) < 1e-6 ? 0.01 : 0); // 45° before 90° when equal
    if (!best || cost < best.cost) best = { cost, k: [r3(fx + s * dx), r3(fy + s * dy)] };
  }
  return best?.k ?? dogleg(fx, fy, mx, my, 'diagonal_first');
}

/**
 * After a track's points moved (`group`: per point, which move took it, -1 for none; `old`: the
 * points before): each piece between points of different groups is bent back to 45° where it ran
 * at 45° before. The corner goes by the point that moved least, keeping its piece's direction.
 * Returns the new points and how many pieces were bent.
 */
function rebendSeams(pts: number[], old: number[], group: number[]): { pts: number[]; bent: number } {
  const n = pts.length / 2;
  const out: number[] = [];
  const moved = (i: number) => Math.hypot(pts[2 * i]! - old[2 * i]!, pts[2 * i + 1]! - old[2 * i + 1]!);
  let bent = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && group[i] !== group[i - 1]) {
      const [f, m] = group[i - 1]! < 0 || (group[i]! >= 0 && moved(i - 1) <= moved(i)) ? [i - 1, i] : [i, i - 1];
      // where the moved point would be had it moved with the other one: the piece's old direction
      const [ox, oy] = [pts[2 * f]! + old[2 * m]! - old[2 * f]!, pts[2 * f + 1]! + old[2 * m + 1]! - old[2 * f + 1]!];
      const k = rebend(pts[2 * f]!, pts[2 * f + 1]!, ox, oy, pts[2 * m]!, pts[2 * m + 1]!);
      if (k) {
        out.push(k[0], k[1]);
        bent++;
      }
    }
    out.push(pts[2 * i]!, pts[2 * i + 1]!);
  }
  return { pts: out, bent };
}

/** Per point of a track: 0 where it moved, -1 where it stayed (rebendSeams). */
const movedGroups = (n: number, moved: Set<number>) => Array.from({ length: n }, (_, i) => (moved.has(i) ? 0 : -1));

/* --------------------------------- the ops -------------------------------- */

export function setCopperMode(d: Design, op: Extract<EditOp, { op: 'set_copper_mode' }>): OpResult {
  if (op.mode === 'router') {
    if (!d.board?.drawn) return { op: op.op, effect: 'the copper is the router\'s already', ids: [] };
    const b = boardOf(d);
    const n = b.drawn!.tracks.length + b.drawn!.vias.length;
    delete b.drawn;
    return { op: op.op, effect: `copper back to the router (${n} drawn tracks and vias dropped); route lays it`, ids: ['board'] };
  }
  if (d.board?.drawn) return { op: op.op, effect: 'the copper is drawn already', ids: [] };
  const sch = schematicView(d);
  const before = placeBoard(d, sch);
  const copper = d.board?.copper;
  // the router's copper, if it is for the board as it is now (else nothing to start from)
  const current = op.keep !== false && copper && !copper.stopped && before.routing === 'done' && copperKey(d, sch) === copper.key ? copper : null;
  const b = boardOf(d);
  // the parts stay exactly where they are shown now (from here on the placement only changes on purpose)
  b.placement = storedPlacement(before);
  const dc: DrawnCopper = { tracks: [], vias: [], next: 1 };
  if (current) {
    // (the stubs and vias of add_vias groups stay theirs: the groups lay them)
    const stubs = new Set(before.tracks.map((t) => JSON.stringify(t)));
    // (the router's copper counts as the helper's: route fresh may lay it again)
    for (const t of current.tracks) if (!stubs.has(JSON.stringify(t))) dc.tracks.push(anchored(before, { ...t, id: nextId(dc, 't'), by: 'helper' }));
    for (const v of current.vias) if (!v.group) dc.vias.push({ ...v, id: nextId(dc, 'v'), by: 'helper' });
  }
  b.drawn = dc;
  return {
    op: op.op,
    effect: current
      ? `the copper is yours now: the router's ${dc.tracks.length} tracks and ${dc.vias.length} vias taken over as drawn copper (get_copper lists them by id)`
      : `the copper is yours now, nothing drawn yet${op.keep !== false && copper ? ' (the router\'s copper was not for this placement)' : ''}: draw_track, draw_via, or route nets for a first path`,
    ids: ['board'],
  };
}

/** A track whose ends lie on pad centres of its net: anchored there (the ends follow the pads). */
function anchored(board: BoardView, t: DrawnTrack): DrawnTrack {
  const at = (x: number, y: number): PadAnchor | undefined => {
    for (const p of board.parts) {
      const pad = p.pads.find((q) => q.netId === t.netId && Math.abs(q.x - x) < 0.005 && Math.abs(q.y - y) < 0.005);
      if (pad) return { componentId: p.componentId, pad: pad.number };
    }
    return undefined;
  };
  const from = at(t.pts[0]!, t.pts[1]!);
  const to = at(t.pts.at(-2)!, t.pts.at(-1)!);
  return { ...t, ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

const trackLength = (pts: number[]) => pts.reduce((s, _, i) => (i >= 2 && i % 2 === 0 ? s + Math.hypot(pts[i]! - pts[i - 2]!, pts[i + 1]! - pts[i - 1]!) : s), 0);

export function drawTrack(d: Design, op: Extract<EditOp, { op: 'draw_track' }>): OpResult {
  const { b, dc } = drawnOf(d);
  const board = placed(d);
  const ends = [op.from, op.to].map((e) => endOf(d, board, dc, e));
  const padNets = ends.flatMap((e) => (e.pad ? [{ ref: e.ref!, net: e.pad.netId }] : []));
  for (const p of padNets) if (!p.net) reject({ code: 'PIN_UNCONNECTED', message: `${p.ref} is not connected in the netlist; a track there would join nothing.` });
  const fixed = [...padNets, ...ends.flatMap((e) => (e.via ? [{ ref: e.ref!, net: e.via.netId }] : []))];
  let netId = op.net ? findNet(d, op.net)?.id : fixed[0]?.net;
  if (op.net && !netId) reject({ code: 'NET_UNKNOWN', message: `No net "${op.net}".`, candidates: Object.values(d.nets).map((n) => n.name) });
  if (!netId) reject({ code: 'INVALID_OP', message: 'A track between two points needs its net (net).' });
  const other = fixed.find((p) => p.net !== netId);
  if (other) reject({ code: 'NET_MISMATCH', message: `${other.ref} is on ${netName(d, other.net!)}, the track on ${netName(d, netId!)}: that would be a short.` });
  const smd = ends.flatMap((e) => (e.pad && !e.pad.drill ? e.pad.layers : []));
  const layer = op.layer ?? smd[0] ?? 'F.Cu';
  trackLayer(board, layer);
  const pts = polyline([ends[0]!, ...(op.via ?? []).map(([x, y]) => ({ x, y })), ends[1]!], op.bend);
  if (pts.length < 4) reject({ code: 'INVALID_OP', message: 'The track starts and ends at the same point.' });
  const width = op.width_mm ?? defaultWidth(d, netId!);
  const [f, t] = ends.map((e) => e.anchor);
  const track: DrawnTrack = { id: nextId(dc, 't'), netId: netId!, layer, width, pts, ...(f ? { from: f } : {}), ...(t ? { to: t } : {}) };
  dc.tracks.push(track);
  d.board = b;
  return { op: op.op, effect: `track ${track.id}: ${netName(d, netId!)} on ${layer}, ${width} mm, ${pts.length / 2 - 1} piece(s), ${r3(trackLength(pts))} mm`, ids: ['board', track.id] };
}

export function drawVia(d: Design, op: Extract<EditOp, { op: 'draw_via' }>): OpResult {
  const { b, dc } = drawnOf(d);
  const net = findNet(d, op.net);
  if (!net) reject({ code: 'NET_UNKNOWN', message: `No net "${op.net}".`, candidates: Object.values(d.nets).map((n) => n.name) });
  const drill = op.drill_mm ?? b.rules.viaDrill;
  const size = op.size_mm ?? Math.max(b.rules.viaPad, drill + 0.2);
  viaSize(drill, size);
  const via: DrawnVia = { id: nextId(dc, 'v'), netId: net!.id, x: r3(op.at[0]), y: r3(op.at[1]), drill, pad: size };
  dc.vias.push(via);
  return { op: op.op, effect: `via ${via.id}: ${net!.name} at ${via.x}, ${via.y} (${drill}/${size} mm)`, ids: ['board', via.id] };
}

function viaSize(drill: number, size: number) {
  if (size < drill + 0.1) reject({ code: 'BOARD_INVALID', message: `A ${size} mm via pad round a ${drill} mm drill leaves no copper ring; give size_mm at least ${r3(drill + 0.1)} mm.` });
}

/** Whether a track's end (point index 0 or the last) lies on a pad of its net (it stays there when the track is shifted). */
function onPad(board: BoardView, t: DrawnTrack, i: number): boolean {
  if ((i === 0 && t.from) || (i > 0 && t.to)) return true;
  const [x, y] = [t.pts[2 * i]!, t.pts[2 * i + 1]!];
  return board.parts.some((p) => p.pads.some((q) => q.netId === t.netId && (!!q.drill || q.layers.includes(t.layer)) && padPointDist(q, x, y) <= 1e-3));
}

const onVia = (v: Via, x: number, y: number) => Math.hypot(v.x - x, v.y - y) <= v.pad / 2 + 1e-3;

export function editCopper(d: Design, op: Extract<EditOp, { op: 'edit_copper' }>): OpResult {
  const { b, dc } = drawnOf(d);
  const ids = [...new Set(op.ids.map((x) => x.toLowerCase()))];
  const unknown = ids.filter((id) => !dc.tracks.some((t) => t.id === id) && !dc.vias.some((v) => v.id === id));
  if (unknown.length) reject({ code: 'REF_UNKNOWN', message: `No drawn copper ${unknown.join(', ')}.`, candidates: [...dc.tracks.map((t) => t.id), ...dc.vias.map((v) => v.id)].slice(0, 40) });
  const tracks = dc.tracks.filter((t) => ids.includes(t.id));
  const vias = dc.vias.filter((v) => ids.includes(v.id));
  const forTracks = op.via !== undefined || op.bend !== undefined || op.width_mm !== undefined || op.layer !== undefined;
  const forVias = op.drill_mm !== undefined || op.size_mm !== undefined;
  if (!op.move && !forTracks && !forVias) reject({ code: 'INVALID_OP', message: 'edit_copper needs move, via, bend, width_mm, layer, drill_mm or size_mm.' });
  if (forTracks && !tracks.length) reject({ code: 'INVALID_OP', message: 'via, bend, width_mm and layer change tracks; ids names only vias.' });
  if (forVias && !vias.length) reject({ code: 'INVALID_OP', message: 'drill_mm and size_mm change vias; ids names only tracks.' });
  if (op.via && tracks.length !== 1) reject({ code: 'INVALID_OP', message: 'New corners (via) are for one track at a time.' });
  const board = placed(d);
  if (op.layer) trackLayer(board, op.layer);
  const did: string[] = [];
  const along: string[] = [];
  if (op.move) {
    const [dx, dy] = op.move;
    const shift = (x: number, y: number): [number, number] => [r3(x + dx), r3(y + dy)];
    const moving = new Set(vias);
    // the tracks: every point but an end on a pad or on a via that stays (the piece next to it stretches)
    for (const t of tracks) {
      const old = t.pts.slice();
      const n = t.pts.length / 2;
      const moved = new Set<number>();
      for (let i = 0; i < n; i++) {
        const end = i === 0 || i === n - 1;
        if (end && (onPad(board, t, i) || dc.vias.some((v) => !moving.has(v) && v.netId === t.netId && onVia(v, old[2 * i]!, old[2 * i + 1]!)))) continue;
        [t.pts[2 * i], t.pts[2 * i + 1]] = shift(old[2 * i]!, old[2 * i + 1]!);
        moved.add(i);
      }
      if (op.bend && moved.size < n) t.pts = simplify(rebendSeams(t.pts, old, movedGroups(n, moved)).pts);
    }
    // the vias, and the ends of the other tracks on them
    for (const v of vias) {
      const [ox, oy] = [v.x, v.y];
      [v.x, v.y] = shift(ox, oy);
      for (const t of dc.tracks) {
        if (tracks.includes(t) || t.netId !== v.netId) continue;
        const n = t.pts.length / 2;
        for (const i of [0, n - 1]) {
          if (onPad(board, t, i) || Math.hypot(t.pts[2 * i]! - ox, t.pts[2 * i + 1]! - oy) > v.pad / 2 + 1e-3) continue;
          const old = t.pts.slice();
          [t.pts[2 * i], t.pts[2 * i + 1]] = shift(old[2 * i]!, old[2 * i + 1]!);
          if (op.bend) t.pts = simplify(rebendSeams(t.pts, old, movedGroups(n, new Set([i]))).pts);
          along.push(t.id);
        }
      }
    }
    did.push(`moved by ${r3(dx)}, ${r3(dy)} mm`);
  }
  if (op.via) {
    const t = tracks[0]!;
    t.pts = polyline([{ x: t.pts[0]!, y: t.pts[1]! }, ...op.via.map(([x, y]) => ({ x, y })), { x: t.pts.at(-2)!, y: t.pts.at(-1)! }], op.bend);
    if (t.pts.length < 4) reject({ code: 'INVALID_OP', message: `${t.id} would start and end at the same point.` });
    did.push(`${t.id} redrawn through ${op.via.length} corner(s)`);
  } else if (op.bend && !op.move) {
    for (const t of tracks) t.pts = polyline(pointsOf(t.pts), op.bend);
    did.push('45° corners set');
  }
  if (op.width_mm !== undefined) {
    for (const t of tracks) t.width = op.width_mm;
    did.push(`width ${op.width_mm} mm`);
  }
  if (op.layer) {
    for (const t of tracks) t.layer = op.layer;
    did.push(`on ${op.layer}`);
  }
  if (forVias) {
    for (const v of vias) {
      const drill = op.drill_mm ?? v.drill;
      const size = op.size_mm ?? Math.max(v.pad, drill + 0.2);
      viaSize(drill, size);
      Object.assign(v, { drill, pad: size });
    }
    did.push(`vias ${op.drill_mm ?? '…'}/${op.size_mm ?? '…'} mm`);
  }
  // (edited, it is yours: route fresh leaves it alone)
  for (const x of [...tracks, ...vias]) delete x.by;
  d.board = b;
  const extra = [...new Set(along)];
  return { op: op.op, effect: `edited ${ids.join(', ')}: ${did.join(', ')}${extra.length ? `; ${extra.join(', ')} went along at the moved via${vias.length > 1 ? 's' : ''}` : ''}`, ids: ['board', ...ids, ...extra] };
}

export function eraseCopper(d: Design, op: Extract<EditOp, { op: 'erase_copper' }>): OpResult {
  const { dc } = drawnOf(d);
  if (!op.all && !op.ids?.length && !op.nets?.length && !op.parts?.length && !op.rect) reject({ code: 'INVALID_OP', message: 'erase_copper needs ids, nets, parts, rect or all.' });
  const known = new Set([...dc.tracks.map((t) => t.id), ...dc.vias.map((v) => v.id)]);
  const unknown = (op.ids ?? []).filter((id) => !known.has(id.toLowerCase()));
  if (unknown.length) reject({ code: 'REF_UNKNOWN', message: `No drawn copper ${unknown.join(', ')}.`, candidates: [...known].slice(0, 40) });
  const nets = new Set((op.nets ?? []).map((n) => {
    const net = findNet(d, n);
    if (!net) reject({ code: 'NET_UNKNOWN', message: `No net "${n}".`, candidates: Object.values(d.nets).map((x) => x.name) });
    return net!.id;
  }));
  const parts = new Set((op.parts ?? []).map((r) => resolveComponent(d, r).id));
  const ids = new Set((op.ids ?? []).map((id) => id.toLowerCase()));
  const inRect = (x: number, y: number) => !!op.rect && x >= op.rect.x_mm && y >= op.rect.y_mm && x <= op.rect.x_mm + op.rect.width_mm && y <= op.rect.y_mm + op.rect.height_mm;
  const goes = (it: Track & { id: string; from?: PadAnchor; to?: PadAnchor }) =>
    op.all || ids.has(it.id) || nets.has(it.netId) || (!!it.from && parts.has(it.from.componentId)) || (!!it.to && parts.has(it.to.componentId)) || it.pts.some((v, i) => i % 2 === 0 && inRect(v, it.pts[i + 1]!));
  const viaGoes = (v: Via & { id: string }) => op.all || ids.has(v.id) || nets.has(v.netId) || inRect(v.x, v.y);
  const gone = [...dc.tracks.filter(goes).map((t) => t.id), ...dc.vias.filter(viaGoes).map((v) => v.id)];
  dc.tracks = dc.tracks.filter((t) => !goes(t));
  dc.vias = dc.vias.filter((v) => !viaGoes(v));
  return { op: op.op, effect: gone.length ? `erased ${gone.length}: ${gone.join(', ')}` : 'nothing matched', ids: gone.length ? ['board'] : [] };
}

/* ------------------------------ the route helper --------------------------- */

/**
 * The route helper of a transaction, run elsewhere or followed while it runs (Kernel.transact):
 * the app routes in a worker (onProgress shows the copper laid so far, onBest is what a stop
 * keeps, onDone the result), then applies the transaction in the kernel with the `results`.
 */
export interface HelperHooks {
  /** Results computed elsewhere, by the route op's index in the transaction: used instead of routing. */
  results?: Record<number, RouteHelperResult>;
  onProgress?: (opIndex: number, p: RouteProgress) => void;
  onBest?: (opIndex: number, r: RouteHelperResult) => void;
  onDone?: (opIndex: number, r: RouteHelperResult) => void;
}

/** Where an op sits in its transaction, for the route helper. */
export interface OpContext {
  index: number;
  helper?: HelperHooks;
}

/** The route helper on drawn copper: paths for the named open connections, added as drawn copper. */
export function routeDrawn(d: Design, op: Extract<EditOp, { op: 'route' }>, ctx: OpContext = { index: 0 }): OpResult {
  const { b, dc } = drawnOf(d);
  let board = placed(d);
  if (!board.parts.length) reject({ code: 'BOARD_INVALID', message: 'Nothing to route: the board has no parts.' });
  if (!!op.from !== !!op.to) reject({ code: 'INVALID_OP', message: 'route from needs to, and to needs from.' });
  const only: { nets?: string[]; pairs?: [BoardPad, BoardPad][] } = {};
  let what: string;
  if (op.from) {
    const a = padOf(d, board, op.from!).pad;
    const z = padOf(d, board, op.to!).pad;
    if (!a.netId || a.netId !== z.netId) reject({ code: 'NET_MISMATCH', message: `${op.from} and ${op.to} are not on one net.` });
    only.pairs = [[a, z]];
    what = `${op.from} → ${op.to}`;
  } else {
    only.nets = op.nets
      ? op.nets.map((n) => {
          const net = findNet(d, n);
          if (!net) reject({ code: 'NET_UNKNOWN', message: `No net "${n}".`, candidates: Object.values(d.nets).map((x) => x.name) });
          return net!.id;
        })
      : [...new Set(board.parts.flatMap((p) => p.pads.flatMap((q) => (q.netId ? [q.netId] : []))))];
    what = op.nets ? op.nets.join(', ') : 'every open connection';
  }
  const scoped = only.nets ?? [only.pairs![0]![0].netId!];
  // fresh: the helper's own copper of these nets goes first (yours stays), so it is laid again round yours
  let takenUp = 0;
  if (op.fresh) {
    const mine = (x: { netId: string; by?: 'helper' }) => x.by === 'helper' && (!op.nets && !op.from ? true : scoped.includes(x.netId));
    takenUp = dc.tracks.filter(mine).length + dc.vias.filter(mine).length;
    dc.tracks = dc.tracks.filter((t) => !mine(t));
    dc.vias = dc.vias.filter((v) => !mine(v));
    board = placed(d);
    if (op.from) only.pairs = [[padOf(d, board, op.from).pad, padOf(d, board, op.to!).pad]];
  }
  const hooks = ctx.helper;
  let res = hooks?.results?.[ctx.index];
  if (!res) {
    const input = boardRouteInput(d, board, { budgetMs: HELPER_BUDGET_MS });
    input.drawn = { ...input.drawn!, only };
    if (op.width_mm) input.netWidths = { ...input.netWidths, ...Object.fromEntries(scoped.map((n) => [n, op.width_mm!])) };
    // what the router laid: not the drawn copper (it has ids), nor the stubs and vias of add_vias groups
    const given = new Set<object>([...(input.vias?.stubs ?? []), ...(input.vias?.fixed ?? [])]);
    const inScope = new Set(scoped);
    const label = (p: BoardPad) => `${board.parts.find((q) => q.pads.includes(p))?.refdes ?? '?'}.${p.number}`;
    const helperResult = (r: RouteResult): RouteHelperResult => ({
      tracks: r.tracks.filter((t) => !(t as { id?: string }).id && !given.has(t)).map((t) => ({ ...t, pts: t.pts.map(r3) })),
      vias: r.vias.filter((v) => !(v as { id?: string }).id && !v.group && !given.has(v)).map((v) => ({ ...v, x: r3(v.x), y: r3(v.y) })),
      open: r.failed.filter((f) => inScope.has(f.netId)).map((f) => ({ netId: f.netId, from: label(f.a), to: label(f.b), ...(f.blockedBy?.length ? { blockedBy: f.blockedBy } : {}), ...(f.enclosed ? { enclosed: true } : {}) })),
      passes: r.passes,
      ...(r.timedOut ? { timedOut: true } : {}),
    });
    if (hooks?.onProgress) input.onProgress = (p) => hooks.onProgress!(ctx.index, p);
    if (hooks?.onBest) input.onBest = (r) => hooks.onBest!(ctx.index, helperResult(r));
    res = helperResult(route(input));
    hooks?.onDone?.(ctx.index, res);
  }
  const ids: string[] = [];
  for (const t of res.tracks) {
    const track = anchored(board, { ...t, id: nextId(dc, 't'), by: 'helper' });
    dc.tracks.push(track);
    ids.push(track.id);
  }
  for (const v of res.vias) {
    const via: DrawnVia = { ...v, id: nextId(dc, 'v'), by: 'helper' };
    dc.vias.push(via);
    ids.push(via.id);
  }
  d.board = b;
  const open = res.open;
  const openText = open.length
    ? `; ${open.length} still open: ${open.slice(0, 8).map((f) => `${netName(d, f.netId)} ${f.from} → ${f.to}${f.blockedBy?.length ? ` (in the way: ${f.blockedBy.map((n) => netName(d, n)).join(', ')})` : f.enclosed ? ' (closed off)' : ''}`).join('; ')}${open.length > 8 ? '; …' : ''}`
    : '';
  const how = res.stopped ? (res.passes ? `, stopped by the user after ${res.passes} pass${res.passes === 1 ? '' : 'es'}: the best found by then` : ', stopped by the user before its first pass ended') : res.timedOut ? ', stopped at its time budget' : '';
  return {
    op: op.op,
    effect: `route helper (${what}${op.fresh ? `, fresh: ${takenUp} of its own tracks and vias taken up first` : ''}): ${res.tracks.length} track(s) and ${res.vias.length} via(s) laid as drawn copper${ids.length ? ` (${ids[0]}–${ids.at(-1)})` : ''}${how}${openText}`,
    ids: ['board', ...ids],
  };
}

/* --------------------------- copper that follows -------------------------- */

/** Ops that never move a part: the copper needs no following after them. */
const STILL = new Set(['route', 'set_copper_mode', 'draw_track', 'draw_via', 'edit_copper', 'erase_copper', 'add_waiver', 'remove_waiver', 'set_mating', 'set_enclosure_brief', 'set_enclosure_script', 'set_enclosure_graphic', 'set_value_series', 'set_paper', 'add_graphic', 'edit_graphic', 'remove_graphic', 'set_panel', 'place_symbol', 'wire', 'label', 'erase', 'auto_draw', 'describe', 'set_plane', 'set_plane_style', 'add_vias', 'remove_vias', 'rename', 'set_net']);

/** Whether an op may move parts (then drawn copper follows them, see followParts). */
export const movesParts = (op: EditOp) => !STILL.has(op.op);

/** The placement, for following parts that an op moves (with drawn copper only). */
export const placementOf = placed;

interface Move {
  part: BoardPart;
  map: (x: number, y: number) => [number, number];
  /** The old courtyard, FOLLOW_MM larger: copper in it goes with the part. */
  region: [number, number, number, number];
}

/** Where a point by a part goes when the part moves from `a` to `b` (moved and turned, rigidly). */
function poseMap(a: BoardPart, b: BoardPart): (x: number, y: number) => [number, number] {
  return (x, y) => {
    const [lx, ly] = rotate(x - a.x, y - a.y, -a.rot);
    const [rx, ry] = rotate(lx, ly, b.rot);
    return [r3(b.x + rx), r3(b.y + ry)];
  };
}

/** Two parts moved alike (a part and the small parts that follow it): their copper moves as one. */
const alike = (m: Move, n: Move) => m === n || [[0, 0], [10, 7]].every(([x, y]) => {
  const [p, q] = [m.map(x!, y!), n.map(x!, y!)];
  return Math.abs(p[0] - q[0]) < 1e-3 && Math.abs(p[1] - q[1]) < 1e-3;
});

const inBox = (r: [number, number, number, number], x: number, y: number) => x >= r[0] && y >= r[1] && x <= r[2] && y <= r[3];

/**
 * Drawn copper follows the parts an op moved or turned (Kernel.transact; `before`: the placement
 * before the op). What lies next to a moved part goes with it: each track ending on one of its pads,
 * as far as it stays within FOLLOW_MM of the part's courtyard, and a via such a track ends on, with
 * the tracks ending on that via in turn (a pad's drop, a fanout). The piece beyond stretches, bent
 * back to 45° where it ran at 45°. A track whose two ends go with parts moved alike (a part and the
 * small parts that follow it) moves whole. A part turned over to the other side takes nothing (its
 * tracks would be on the wrong layer): the note says so. Returns a note for the op's effect and the
 * ids moved (to check them), or null when no drawn copper had to follow.
 */
export function followParts(d: Design, before: BoardView): { note: string; ids: string[] } | null {
  const dc = d.board?.drawn;
  if (!dc || (!dc.tracks.length && !dc.vias.length)) return null;
  const after = placed(d);
  const now = new Map(after.parts.map((p) => [p.componentId, p]));
  const moves = new Map<string, Move>();
  const flipped: BoardPart[] = [];
  for (const p of before.parts) {
    const q = now.get(p.componentId);
    if (!q || (p.x === q.x && p.y === q.y && p.rot === q.rot && p.side === q.side)) continue;
    if (p.side !== q.side) {
      flipped.push(q);
      continue;
    }
    const c = p.courtyard;
    moves.set(p.componentId, { part: p, map: poseMap(p, q), region: [c.x - FOLLOW_MM, c.y - FOLLOW_MM, c.x + c.w + FOLLOW_MM, c.y + c.h + FOLLOW_MM] });
  }
  if (!moves.size && !flipped.length) return null;
  const stillParts = before.parts.filter((p) => !moves.has(p.componentId));
  // the points of the tracks touched, as they were, and which of them moved
  const olds = new Map<DrawnTrack, { pts: number[]; moved: Map<number, Move> }>();
  const old = (t: DrawnTrack) => olds.get(t)?.pts ?? t.pts;
  const wasMoved = (t: DrawnTrack, i: number) => !!olds.get(t)?.moved.has(i);
  const onPadOf = (parts: BoardPart[], t: DrawnTrack, x: number, y: number) => parts.some((p) => p.pads.some((q) => q.netId === t.netId && (!!q.drill || q.layers.includes(t.layer)) && padPointDist(q, x, y) <= 1e-3));
  /** The moved part a track's end (point index i) lies on: by its anchor, or on one of its pads. */
  const endMove = (t: DrawnTrack, i: number): Move | undefined => {
    const a = i === 0 ? t.from : t.to;
    if (a) return moves.get(a.componentId);
    const [x, y] = [t.pts[2 * i]!, t.pts[2 * i + 1]!];
    for (const m of moves.values()) if (inBox(m.region, x, y) && onPadOf([m.part], t, x, y)) return m;
    return undefined;
  };
  /** An end that stays where it is: on a part that does not move this way. */
  const pinned = (t: DrawnTrack, i: number, m: Move): boolean => {
    const n = t.pts.length / 2;
    if (i !== 0 && i !== n - 1) return false;
    const a = i === 0 ? t.from : t.to;
    if (a) {
      const am = moves.get(a.componentId);
      return !am || !alike(am, m);
    }
    return onPadOf(stillParts, t, old(t)[2 * i]!, old(t)[2 * i + 1]!);
  };
  const used = new Set<Move>();
  const movedVias = new Set<DrawnVia>();
  const queue: { v: DrawnVia; m: Move }[] = [];
  const move = (t: DrawnTrack, i: number, m: Move) => {
    let s = olds.get(t);
    if (!s) olds.set(t, (s = { pts: t.pts.slice(), moved: new Map() }));
    // (an end anchored on a pad lands on the pad's centre, wherever it was kept before)
    const a = i === 0 ? t.from : i === t.pts.length / 2 - 1 ? t.to : undefined;
    const pad = a && now.get(a.componentId)?.pads.find((q) => q.number === a.pad);
    [t.pts[2 * i], t.pts[2 * i + 1]] = pad ? [pad.x, pad.y] : m.map(s.pts[2 * i]!, s.pts[2 * i + 1]!);
    s.moved.set(i, m);
    used.add(m);
    // a via this end lay on goes along
    if (i !== 0 && i !== t.pts.length / 2 - 1) return;
    for (const v of dc.vias) if (!movedVias.has(v) && v.netId === t.netId && onVia(v, s.pts[2 * i]!, s.pts[2 * i + 1]!)) queue.push({ v, m });
  };
  /** From an end inwards, while the points stay by the part (the end itself always goes, unless pinned). */
  const walk = (t: DrawnTrack, from: 0 | 1, m: Move) => {
    const n = t.pts.length / 2;
    for (let k = 0; k < n; k++) {
      const i = from === 0 ? k : n - 1 - k;
      if (wasMoved(t, i) || pinned(t, i, m)) break;
      const pts = old(t);
      if (k > 0 && !inBox(m.region, pts[2 * i]!, pts[2 * i + 1]!)) break;
      move(t, i, m);
    }
  };
  for (const t of dc.tracks) {
    const n = t.pts.length / 2;
    const [e0, e1] = [endMove(t, 0), endMove(t, n - 1)];
    if (e0 && e1 && alike(e0, e1)) {
      for (let i = 0; i < n; i++) move(t, i, e0);
    } else {
      if (e0) walk(t, 0, e0);
      if (e1) walk(t, 1, e1);
    }
  }
  // the vias that went along, and the tracks ending on them in turn
  while (queue.length) {
    const { v, m } = queue.shift()!;
    if (movedVias.has(v)) continue;
    movedVias.add(v);
    const [ox, oy] = [v.x, v.y];
    [v.x, v.y] = m.map(ox, oy);
    used.add(m);
    for (const t of dc.tracks) {
      if (t.netId !== v.netId) continue;
      const n = t.pts.length / 2;
      if (!wasMoved(t, 0) && Math.hypot(old(t)[0]! - ox, old(t)[1]! - oy) <= v.pad / 2 + 1e-3) walk(t, 0, m);
      if (!wasMoved(t, n - 1) && Math.hypot(old(t)[2 * n - 2]! - ox, old(t)[2 * n - 1]! - oy) <= v.pad / 2 + 1e-3) walk(t, 1, m);
    }
  }
  const offAngle = (pts: number[]) => {
    let n = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) if (!octilinear(pts[i + 2]! - pts[i]!, pts[i + 3]! - pts[i + 1]!) && Math.hypot(pts[i + 2]! - pts[i]!, pts[i + 3]! - pts[i + 1]!) > 0.25) n++;
    return n;
  };
  // moves alike are one group (their copper keeps its shape between them)
  const reps: Move[] = [];
  const groupOf = (m: Move | undefined) => {
    if (!m) return -1;
    let g = reps.findIndex((r) => alike(r, m));
    if (g < 0) g = reps.push(m) - 1;
    return g;
  };
  let bent = 0;
  let stretched = 0;
  for (const [t, s] of olds) {
    const group = Array.from({ length: t.pts.length / 2 }, (_, i) => groupOf(s.moved.get(i)));
    if (group.every((g) => g === group[0])) continue;
    const r = rebendSeams(t.pts, s.pts, group);
    t.pts = simplify(r.pts);
    bent += r.bent;
    stretched += Math.max(0, offAngle(t.pts) - offAngle(s.pts));
  }
  const flippedTracks = flipped.map((p) => ({ p, n: dc.tracks.filter((t) => t.from?.componentId === p.componentId || t.to?.componentId === p.componentId).length })).filter((x) => x.n);
  if (!olds.size && !movedVias.size && !flippedTracks.length) return null;
  const notes: string[] = [];
  if (olds.size || movedVias.size) {
    const refs = [...used].map((m) => m.part.refdes);
    notes.push(
      `drawn copper followed ${refs.slice(0, 6).join(', ')}${refs.length > 6 ? ', …' : ''}: ${olds.size} track(s)${movedVias.size ? ` and ${movedVias.size} via(s)` : ''} moved with ${refs.length === 1 ? 'it' : 'them'}` +
        (bent ? `, ${bent} stretched piece(s) bent back to 45°` : '') +
        (stretched ? `, ${stretched} piece(s) now off 45°` : ''),
    );
  }
  for (const { p, n } of flippedTracks) notes.push(`${p.refdes} turned over to the ${p.side} side: its ${n} track(s) stay where they were (redraw them on its side)`);
  return { note: notes.join('; '), ids: [...[...olds.keys()].map((t) => t.id), ...[...movedVias].map((v) => v.id)] };
}

/* ----------------------------- checked at once ----------------------------- */

/** Ops whose copper is checked when their transaction is applied (the helper's copper keeps the rules by construction). */
export const DRAWING_OPS = new Set(['draw_track', 'draw_via', 'edit_copper']);

/**
 * The rules on the drawn copper with these ids, on the board as it is now (placement only: pours
 * fill round the copper later, so they never clash): other nets' copper too close or touching, the
 * edge, the fab's limits (errors), loose ends and pieces off 45°, a via in a small part's land
 * pattern (warnings).
 */
export function checkCopper(d: Design, ids: Set<string>): BoardDiagnostic[] {
  if (!d.board?.drawn || !ids.size) return [];
  const b = placed(d);
  const out = [...copperDrc(b, ids), ...edgeDrc(b, true, ids), ...drawnDrc(b, ids)];
  const fab = b.fab?.limits;
  if (fab) {
    for (const t of b.drawn?.tracks ?? []) if (ids.has(t.id) && t.width < fab.track - 0.005) out.push({ code: 'DRC.FAB_TRACK', severity: 'error', message: `Track ${t.id} is ${t.width} mm wide; ${b.fab!.house} makes ${fab.track} mm at the narrowest.`, at: { x: t.pts[0]!, y: t.pts[1]! }, entities: [t.id] });
    for (const v of b.drawn?.vias ?? []) {
      if (ids.has(v.id) && ((fab.viaDrill !== undefined && v.drill < fab.viaDrill - 0.005) || (fab.viaPad !== undefined && v.pad < fab.viaPad - 0.005))) out.push({ code: 'DRC.FAB_VIA', severity: 'error', message: `Via ${v.id} (${v.drill}/${v.pad} mm) is below ${b.fab!.house}'s smallest (${fab.viaDrill ?? '–'}/${fab.viaPad ?? '–'} mm).`, at: { x: v.x, y: v.y }, entities: [v.id] });
    }
  }
  return out.map(softened);
}

/**
 * Adds to the effect of each op that drew, edited or moved drawn copper (`byOp`: op index → ids)
 * what the check found on that copper, once the transaction is applied (a track drawn now and the
 * via it ends on later in the same transaction are judged together).
 */
export function annotateChecks(d: Design, results: OpResult[], byOp: Map<number, string[]>) {
  const dc = d.board?.drawn;
  const there = new Set([...(dc?.tracks ?? []), ...(dc?.vias ?? [])].map((x) => x.id));
  const all = new Set([...byOp.values()].flat().filter((id) => there.has(id)));
  if (!all.size) return;
  const found = checkCopper(d, all);
  for (const [i, ids] of byOp) {
    const r = results[i];
    const mine = new Set(ids.filter((id) => all.has(id)));
    if (!r || !mine.size) continue;
    const hits = found.filter((x) => x.entities.some((e) => mine.has(e)));
    if (!hits.length) {
      r.effect += '; check: clear';
      continue;
    }
    const errors = hits.filter((x) => x.severity === 'error').length;
    const shown = hits.slice(0, CHECK_SHOWN).map((x) => `${x.severity} ${x.code}: ${x.message}`);
    r.effect += `; check: ${errors ? `${errors} error(s)` : 'no errors'}${hits.length - errors ? `, ${hits.length - errors} warning(s)` : ''}: ${shown.join(' ')}${hits.length > CHECK_SHOWN ? ` (+${hits.length - CHECK_SHOWN} more: get_board)` : ''}`;
  }
}
