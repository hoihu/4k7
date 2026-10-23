/**
 * Drawn copper (docs/design/layout.md §9): the agent lays the board's copper itself. Tracks and
 * vias are design data (BoardSettings.drawn), drawn exactly as given; nothing here checks
 * clearances (the DRC judges the copper afterwards, hard rules as errors, the rest as warnings).
 * The router stays as a helper the agent calls on named connections (route nets / from, to): what
 * it finds is added as drawn copper, round what is drawn already.
 */
import { DEFAULT_BOARD, padHasPin, type BoardPad, type BoardSettings, type BoardView, type Design, type DrawnCopper, type DrawnTrack, type DrawnVia, type EditOp, type OpResult, type PadAnchor, type Track, type Via } from '@4k7/schema';
import { boardRouteInput, copperKey, placeBoard, storedPlacement } from './board.ts';
import { findNet, isPowerNet, reject, resolveComponent, resolvePins } from './doc.ts';
import { schematicView } from './drawing.ts';
import { route } from './router.ts';

/** How long the route helper may search, ms (the user would rather wait than get less). */
const HELPER_BUDGET_MS = 30_000;
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
  if (dot <= 0) reject({ code: 'PIN_UNKNOWN', message: `"${ref}" is not a pad reference; use "<refdes>.<pad>", e.g. "U1.3".` });
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
  const dc: DrawnCopper = { tracks: [], vias: [], next: 1 };
  if (current) {
    // (the stubs and vias of add_vias groups stay theirs: the groups lay them)
    const stubs = new Set(before.tracks.map((t) => JSON.stringify(t)));
    for (const t of current.tracks) if (!stubs.has(JSON.stringify(t))) dc.tracks.push(anchored(before, { ...t, id: nextId(dc, 't') }));
    for (const v of current.vias) if (!v.group) dc.vias.push({ ...v, id: nextId(dc, 'v') });
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

export function drawTrack(d: Design, op: Extract<EditOp, { op: 'draw_track' }>): OpResult {
  const { b, dc } = drawnOf(d);
  const board = placed(d);
  const ends = [op.from, op.to].map((e) => (typeof e === 'string' ? { ...padOf(d, board, e), ref: e } : { x: e[0], y: e[1] }));
  const padNets = ends.flatMap((e) => ('pad' in e ? [{ ref: e.ref, net: e.pad.netId }] : []));
  for (const p of padNets) if (!p.net) reject({ code: 'PIN_UNCONNECTED', message: `${p.ref} is not connected in the netlist; a track there would join nothing.` });
  let netId = op.net ? findNet(d, op.net)?.id : padNets[0]?.net;
  if (op.net && !netId) reject({ code: 'NET_UNKNOWN', message: `No net "${op.net}".`, candidates: Object.values(d.nets).map((n) => n.name) });
  if (!netId) reject({ code: 'INVALID_OP', message: 'A track between two points needs its net (net).' });
  const other = padNets.find((p) => p.net !== netId);
  if (other) reject({ code: 'NET_MISMATCH', message: `${other.ref} is on ${netName(d, other.net!)}, the track on ${netName(d, netId!)}: that would be a short.` });
  const smd = ends.flatMap((e) => ('pad' in e && !e.pad.drill ? e.pad.layers : []));
  const layer = op.layer ?? smd[0] ?? 'F.Cu';
  if (!board.layers.includes(layer)) reject({ code: 'BOARD_INVALID', message: `${layer} does not exist on a ${board.layers.length}-layer board.`, candidates: board.layers });
  const plane = planeLayer(board, layer);
  if (plane) reject({ code: 'BOARD_INVALID', message: `${layer} is the ${plane} plane: tracks run on the outer layers (a via reaches the plane).` });
  const pts: number[] = [];
  for (const [x, y] of [ends[0]!, ...(op.via ?? []).map(([x, y]) => ({ x, y })), ends[1]!].map((e) => ('pad' in e ? [e.pad.x, e.pad.y] : [e.x, e.y]) as [number, number])) {
    if (pts.length && Math.abs(pts.at(-2)! - x) < 1e-6 && Math.abs(pts.at(-1)! - y) < 1e-6) continue;
    pts.push(r3(x), r3(y));
  }
  if (pts.length < 4) reject({ code: 'INVALID_OP', message: 'The track starts and ends at the same point.' });
  const width = op.width_mm ?? defaultWidth(d, netId!);
  const [f, t] = ends.map((e) => ('anchor' in e ? e.anchor : undefined));
  const track: DrawnTrack = { id: nextId(dc, 't'), netId: netId!, layer, width, pts, ...(f ? { from: f } : {}), ...(t ? { to: t } : {}) };
  dc.tracks.push(track);
  d.board = b;
  const len = pts.reduce((s, _, i) => (i >= 2 && i % 2 === 0 ? s + Math.hypot(pts[i]! - pts[i - 2]!, pts[i + 1]! - pts[i - 1]!) : s), 0);
  return { op: op.op, effect: `track ${track.id}: ${netName(d, netId!)} on ${layer}, ${width} mm, ${pts.length / 2 - 1} piece(s), ${r3(len)} mm`, ids: ['board', track.id] };
}

export function drawVia(d: Design, op: Extract<EditOp, { op: 'draw_via' }>): OpResult {
  const { b, dc } = drawnOf(d);
  const net = findNet(d, op.net);
  if (!net) reject({ code: 'NET_UNKNOWN', message: `No net "${op.net}".`, candidates: Object.values(d.nets).map((n) => n.name) });
  const drill = op.drill_mm ?? b.rules.viaDrill;
  const size = op.size_mm ?? Math.max(b.rules.viaPad, drill + 0.2);
  if (size < drill + 0.1) reject({ code: 'BOARD_INVALID', message: `A ${size} mm via pad round a ${drill} mm drill leaves no copper ring; give size_mm at least ${r3(drill + 0.1)} mm.` });
  const via: DrawnVia = { id: nextId(dc, 'v'), netId: net!.id, x: r3(op.at[0]), y: r3(op.at[1]), drill, pad: size };
  dc.vias.push(via);
  return { op: op.op, effect: `via ${via.id}: ${net!.name} at ${via.x}, ${via.y} (${drill}/${size} mm)`, ids: ['board', via.id] };
}

export function eraseCopper(d: Design, op: Extract<EditOp, { op: 'erase_copper' }>): OpResult {
  const { dc } = drawnOf(d);
  if (!op.all && !op.ids?.length && !op.nets?.length && !op.parts?.length && !op.rect) reject({ code: 'INVALID_OP', message: 'erase_copper needs ids, nets, parts, rect or all.' });
  const known = new Set([...dc.tracks.map((t) => t.id), ...dc.vias.map((v) => v.id)]);
  const unknown = (op.ids ?? []).filter((id) => !known.has(id));
  if (unknown.length) reject({ code: 'REF_UNKNOWN', message: `No drawn copper ${unknown.join(', ')}.`, candidates: [...known].slice(0, 40) });
  const nets = new Set((op.nets ?? []).map((n) => {
    const net = findNet(d, n);
    if (!net) reject({ code: 'NET_UNKNOWN', message: `No net "${n}".`, candidates: Object.values(d.nets).map((x) => x.name) });
    return net!.id;
  }));
  const parts = new Set((op.parts ?? []).map((r) => resolveComponent(d, r).id));
  const ids = new Set(op.ids ?? []);
  const inRect = (x: number, y: number) => !!op.rect && x >= op.rect.x_mm && y >= op.rect.y_mm && x <= op.rect.x_mm + op.rect.width_mm && y <= op.rect.y_mm + op.rect.height_mm;
  const goes = (it: Track & { id: string; from?: PadAnchor; to?: PadAnchor }) =>
    op.all || ids.has(it.id) || nets.has(it.netId) || (!!it.from && parts.has(it.from.componentId)) || (!!it.to && parts.has(it.to.componentId)) || it.pts.some((v, i) => i % 2 === 0 && inRect(v, it.pts[i + 1]!));
  const viaGoes = (v: Via & { id: string }) => op.all || ids.has(v.id) || nets.has(v.netId) || inRect(v.x, v.y);
  const gone = [...dc.tracks.filter(goes).map((t) => t.id), ...dc.vias.filter(viaGoes).map((v) => v.id)];
  dc.tracks = dc.tracks.filter((t) => !goes(t));
  dc.vias = dc.vias.filter((v) => !viaGoes(v));
  return { op: op.op, effect: gone.length ? `erased ${gone.length}: ${gone.join(', ')}` : 'nothing matched', ids: gone.length ? ['board'] : [] };
}

/** The route helper on drawn copper: paths for the named open connections, added as drawn copper. */
export function routeDrawn(d: Design, op: Extract<EditOp, { op: 'route' }>): OpResult {
  const { b, dc } = drawnOf(d);
  const board = placed(d);
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
  const input = boardRouteInput(d, board, { budgetMs: HELPER_BUDGET_MS });
  input.drawn = { ...input.drawn!, only };
  const scoped = only.nets ?? [only.pairs![0]![0].netId!];
  if (op.width_mm) input.netWidths = { ...input.netWidths, ...Object.fromEntries(scoped.map((n) => [n, op.width_mm!])) };
  const r = route(input);
  // what the router laid: not the drawn copper (it has ids), nor the stubs and vias of add_vias groups
  const given = new Set<object>([...(input.vias?.stubs ?? []), ...(input.vias?.fixed ?? [])]);
  const newTracks = r.tracks.filter((t) => !(t as { id?: string }).id && !given.has(t));
  const newVias = r.vias.filter((v) => !(v as { id?: string }).id && !v.group && !given.has(v));
  const ids: string[] = [];
  for (const t of newTracks) {
    const track = anchored(board, { ...t, pts: t.pts.map(r3), id: nextId(dc, 't') });
    dc.tracks.push(track);
    ids.push(track.id);
  }
  for (const v of newVias) {
    const via: DrawnVia = { ...v, x: r3(v.x), y: r3(v.y), id: nextId(dc, 'v') };
    dc.vias.push(via);
    ids.push(via.id);
  }
  d.board = b;
  const inScope = new Set(scoped);
  const open = r.failed.filter((f) => inScope.has(f.netId));
  const label = (p: BoardPad) => {
    const part = board.parts.find((q) => q.pads.includes(p));
    return `${part?.refdes ?? '?'}.${p.number}`;
  };
  const openText = open.length
    ? `; ${open.length} still open: ${open.slice(0, 8).map((f) => `${netName(d, f.netId)} ${label(f.a)} → ${label(f.b)}${f.blockedBy?.length ? ` (in the way: ${f.blockedBy.map((n) => netName(d, n)).join(', ')})` : f.enclosed ? ' (closed off)' : ''}`).join('; ')}${open.length > 8 ? '; …' : ''}`
    : '';
  return {
    op: op.op,
    effect: `route helper (${what}): ${newTracks.length} track(s) and ${newVias.length} via(s) laid as drawn copper${ids.length ? ` (${ids[0]}–${ids.at(-1)})` : ''}${r.timedOut ? ', stopped at its time budget' : ''}${openText}`,
    ids: ['board', ...ids],
  };
}
