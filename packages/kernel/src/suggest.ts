/**
 * suggest_moves: placement and copper hand in hand, as people lay out a board. The outline of the
 * blocks (the main parts, what the user placed) stays; the small parts stay open while the copper
 * goes in. Where the copper leaves a connection open (or round a spot or parts the agent names),
 * the small parts there are tried turned, swapped with an identical part close by and shifted a
 * little. Every try is screened on the ratsnest model (refine.ts: it must fit, and it should not
 * tangle the ratsnest); the most promising are routed: a local rip-up round the moved parts (router
 * copper: their copper and what they now overlap is taken up; drawn copper follows the part, see
 * followParts) and the nets they touch routed again round the rest, which stays. Measured against
 * the same rip-up without the change, the tries that close connections come back best first, as
 * place ops to apply. Nothing in the design changes.
 */
import { matingOf, userPlaced, type BoardPart, type BoardView, type Design, type EditOp, type SchematicView } from '@4k7/schema';
import { applyOp } from './apply.ts';
import { boardRouteInput, placeBoard } from './board.ts';
import { checkCopper, followParts } from './copperops.ts';
import { RejectError, clone, resolveComponent } from './doc.ts';
import { padPointDist, padSegDist } from './keep.ts';
import { screenMoves } from './refine.ts';
import { route } from './router.ts';

/** Shifts tried (mm), each way along x and y. */
const SHIFTS = [0.5, 1];
const TURNS = [90, 180, 270];
/** An identical part this close (mm, centre to centre) is tried swapped. */
const TWIN_MM = 6;
/** Parts this close (mm) to a spot the agent names are tried. */
const NEAR_MM = 3;
/** Router copper this close round a moved part (mm) is taken up for a try and laid again. */
const RIP_MM = 1;
/** Each trial routing: passes and time (it routes a few connections, not the board). */
const PASSES = 3;
const TRY_MS = 800;
/** Tries routed (the best screened), and all of it together (ms). */
const ROUTED = 12;
const TOTAL_MS = 15_000;
/** A try may tangle the ratsnest this much (screen cost: crossings × 4 + mm) and still be routed: room for a path can cost a little. */
const WORSE = 6;
/** Open connections whose parts are tried when none are named. */
const SPOTS = 4;
/** Placement findings a try must not add (parts overlapping, off the board). */
const PLACEMENT_CODES = new Set(['DRC.COURTYARD_OVERLAP', 'DRC.OFF_BOARD', 'DRC.EDGE_CLEARANCE', 'DRC.CUTOUT_OVERLAP']);

type Place = Extract<EditOp, { op: 'place' }>;

export interface SuggestQuery {
  parts?: string[];
  at?: [number, number];
  radius_mm?: number;
  max?: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** How far a point is from a part's courtyard (0 inside). */
const fromPart = (p: BoardPart, x: number, y: number) => Math.hypot(Math.max(p.courtyard.x - x, 0, x - p.courtyard.x - p.courtyard.w), Math.max(p.courtyard.y - y, 0, y - p.courtyard.y - p.courtyard.h));

const mmOf = (pts: number[]) => pts.reduce((a, _, i) => (i >= 2 && i % 2 === 0 ? a + Math.hypot(pts[i]! - pts[i - 2]!, pts[i + 1]! - pts[i - 1]!) : a), 0);

export function suggestMoves(d: Design, sch: SchematicView, cur: BoardView, q: SuggestQuery) {
  if (!cur.parts.length) return { error: 'The board has no parts.' };
  if (cur.routing !== 'done') return { error: 'Route first: a suggestion is measured by how the board routes with and without it.' };
  const t0 = Date.now();
  const drawn = !!cur.drawn;
  const user = new Set(userPlaced(cur));
  // the small parts (two or three pads, no connector), not locked and not the user's
  const movable = (p: BoardPart) => !p.componentId.startsWith('hole:') && !p.locked && !user.has(p.refdes) && p.pads.length >= 2 && p.pads.length <= 3 && !matingOf(p.pkgInfo);
  const byRef = new Map(cur.parts.map((p) => [p.refdes, p]));
  const name = (id: string) => cur.netNames[id] ?? id;

  // where to try: the parts named, those round a spot, or those at the open connections
  let refs: string[];
  if (q.parts?.length) {
    const ref = (r: string) => {
      try {
        return resolveComponent(d, r).refdes;
      } catch {
        return null;
      }
    };
    const unknown = q.parts.filter((r) => !byRef.has(ref(r) ?? ''));
    if (unknown.length) return { error: `Not on the board: ${unknown.join(', ')}.` };
    refs = q.parts.map((r) => ref(r)!);
  } else if (q.at) {
    const [x, y] = q.at;
    refs = cur.parts.filter((p) => fromPart(p, x, y) <= (q.radius_mm ?? NEAR_MM)).sort((a, b) => fromPart(a, x, y) - fromPart(b, x, y)).map((p) => p.refdes);
  } else {
    if (!cur.unrouted.length) return { open_now: 0, suggestions: [], note: 'No connection is open. Name parts (parts) or a spot (at) to try anyway.' };
    refs = cur.unrouted.slice(0, SPOTS).flatMap((u) => [u.from.split('.')[0]!, u.to.split('.')[0]!, ...u.near]);
  }
  const named = [...new Set(refs)];
  const parts = named.map((r) => byRef.get(r)).filter((p): p is BoardPart => !!p && movable(p));
  const skipped = named.filter((r) => byRef.has(r) && !movable(byRef.get(r)!));
  const why = 'main parts, connectors, locked parts and what the user placed stay';
  if (!parts.length) return { open_now: cur.unrouted.length, suggestions: [], ...(skipped.length ? { not_moved: skipped } : {}), note: `No small part here that the placement may change (${why}). Move a main part on purpose, or compare arrangements with try_placements.` };

  // the tries: turned, swapped with a twin, shifted
  const at = (p: BoardPart, x: number, y: number, rot: number): Place => ({ op: 'place', ref: p.refdes, x_mm: r3(x), y_mm: r3(y), rot: (((rot % 360) + 360) % 360) as 0 | 90 | 180 | 270 });
  const tries: { change: string; ops: Place[]; cost: number }[] = [];
  for (const p of parts) {
    for (const t of TURNS) tries.push({ change: `${p.refdes} turned to ${(p.rot + t) % 360}°`, ops: [at(p, p.x, p.y, p.rot + t)], cost: 0 });
    for (const o of cur.parts) {
      if (o === p || !movable(o) || o.part !== p.part || o.value !== p.value || o.pkg !== p.pkg || Math.hypot(o.x - p.x, o.y - p.y) > TWIN_MM) continue;
      if (tries.some((t) => t.change === `${o.refdes} and ${p.refdes} swapped`)) continue;
      tries.push({ change: `${p.refdes} and ${o.refdes} swapped`, ops: [at(p, o.x, o.y, o.rot), at(o, p.x, p.y, p.rot)], cost: 0 });
    }
    for (const s of SHIFTS) {
      for (const [dx, dy, way] of [[-s, 0, 'left'], [s, 0, 'right'], [0, -s, 'up'], [0, s, 'down']] as const) tries.push({ change: `${p.refdes} ${s} mm ${way}`, ops: [at(p, p.x + dx, p.y + dy, p.rot)], cost: 0 });
    }
  }
  // screened on the ratsnest model: it must fit; the least tangling are routed
  const base = placeBoard(d, sch);
  const planeNets = new Set(base.planes.filter((pl) => pl.layer !== 'F.Cu' && pl.layer !== 'B.Cu' && !pl.area).map((pl) => pl.netId));
  const costs = screenMoves(base, planeNets, 1.5 + base.rules.edgeClearance, tries.map((t) => t.ops.map((o) => ({ refdes: o.ref, x: o.x_mm, y: o.y_mm, rot: o.rot! }))));
  const screened = tries.flatMap((t, i) => (costs[i] === null || costs[i]! > WORSE ? [] : [{ ...t, cost: costs[i]! }])).sort((a, b) => a.cost - b.cost);

  const problems = (b: BoardView) => b.diagnostics.filter((x) => !x.waivedBy && PLACEMENT_CODES.has(x.code)).length;
  const problemsNow = problems(base);
  const clearance = cur.rules.clearance;
  const stubs = new Set(base.tracks.map((t) => JSON.stringify(t)));

  /**
   * A local rip-up on board `b` of design `w`: the nets of the parts `around` (as they stood) and of
   * the copper in `over` routed round the rest. Router copper by those parts (within RIP_MM) and in
   * `over` is taken up first; drawn copper stays (it followed the parts). Open connections of the
   * whole board after it, and the copper laid.
   */
  const trial = (w: Design, b: BoardView, around: BoardPart[], over: Set<object>) => {
    const nets = new Set(around.flatMap((p) => p.pads.flatMap((x) => (x.netId ? [x.netId] : []))));
    for (const x of over) nets.add((x as { netId: string }).netId);
    const boxes = around.map((p) => [p.courtyard.x - RIP_MM, p.courtyard.y - RIP_MM, p.courtyard.x + p.courtyard.w + RIP_MM, p.courtyard.y + p.courtyard.h + RIP_MM] as const);
    const by = (x: number, y: number) => boxes.some(([x0, y0, x1, y1]) => x >= x0 && y >= y0 && x <= x1 && y <= y1);
    const input = boardRouteInput(w, b, { budgetMs: TRY_MS });
    if (drawn) input.drawn = { ...input.drawn!, only: { nets: [...nets] } };
    else {
      const up = (t: { netId: string; pts: number[] }) => over.has(t) || (nets.has(t.netId) && t.pts.some((v, i) => i % 2 === 0 && by(v, t.pts[i + 1]!)));
      input.drawn = {
        tracks: cur.tracks.filter((t) => !stubs.has(JSON.stringify(t)) && !up(t)),
        vias: cur.vias.filter((v) => !v.group && !over.has(v) && !(nets.has(v.netId) && by(v.x, v.y))),
        only: { nets: [...nets] },
      };
    }
    const kept = new Set<object>([...input.drawn!.tracks, ...input.drawn!.vias]);
    const r = route(input, PASSES);
    const laid = r.tracks.filter((t) => !kept.has(t) && nets.has(t.netId));
    return { open: r.failed.length, nets, mm: laid.reduce((s, t) => s + mmOf(t.pts), 0), vias: r.vias.filter((v) => !kept.has(v) && !v.group && nets.has(v.netId)).length };
  };
  // the same rip-up without the change: what a try is measured against (one per set of parts)
  const baselines = new Map<string, ReturnType<typeof trial>>();
  const baseline = (around: BoardPart[]) => {
    const key = around.map((p) => p.refdes).sort().join(' ');
    let r = baselines.get(key);
    if (!r) baselines.set(key, (r = trial(d, base, around, new Set())));
    return r;
  };

  const found: { change: string; apply: Place[]; closes: number; open: number; errors: number; moved: string[]; nets: string[]; mm: number; vias: number }[] = [];
  let tried = 0;
  for (const t of screened) {
    if (tried >= ROUTED || Date.now() - t0 > TOTAL_MS) break;
    const w = clone(d);
    const followed: string[] = [];
    try {
      for (const op of t.ops) {
        const before = drawn ? placeBoard(w, sch) : null;
        applyOp(w, op, 'agent');
        if (before) followed.push(...(followParts(w, before)?.ids ?? []));
      }
    } catch (e) {
      if (e instanceof RejectError) continue;
      throw e;
    }
    const b = placeBoard(w, sch);
    if (problems(b) > problemsNow) continue; // overlaps a part, or off the board, as the placer places it
    // the parts the change moved (the placer may nudge one more)
    const moved = b.parts.filter((p) => {
      const o = byRef.get(p.refdes);
      return !o || o.x !== p.x || o.y !== p.y || o.rot !== p.rot;
    });
    if (!moved.length) continue;
    tried++;
    // router copper of other nets that the moved pads now meet: taken up and routed again too (as route would)
    const over = new Set<object>();
    if (!drawn) {
      const pads = moved.flatMap((p) => p.pads.filter((x) => x.netId));
      for (const tr of cur.tracks) {
        for (let i = 0; i + 3 < tr.pts.length; i += 2) {
          if (pads.some((x) => x.netId !== tr.netId && (x.drill || x.layers.includes(tr.layer)) && padSegDist(x, tr.pts[i]!, tr.pts[i + 1]!, tr.pts[i + 2]!, tr.pts[i + 3]!) < tr.width / 2 + clearance)) {
            over.add(tr);
            break;
          }
        }
      }
      for (const v of cur.vias) if (pads.some((x) => x.netId !== v.netId && padPointDist(x, v.x, v.y) < v.pad / 2 + clearance)) over.add(v);
    }
    // (the rip-up round where the parts stood, as the baseline takes it up)
    const was = moved.map((p) => byRef.get(p.refdes) ?? p);
    const r = trial(w, b, was, over);
    const r0 = baseline(was);
    // drawn copper: errors the change makes where copper followed or now lies under a part
    const errors = drawn ? checkCopper(w, new Set(followed)).filter((x) => x.severity === 'error').length - checkCopper(d, new Set(followed)).filter((x) => x.severity === 'error').length : 0;
    const closes = r0.open - r.open;
    if (closes - Math.max(0, errors) <= 0) continue;
    found.push({ change: t.change, apply: t.ops, closes, open: r.open, errors, moved: moved.map((p) => p.refdes).filter((x) => !t.ops.some((o) => o.ref === x)), nets: [...r.nets].map(name), mm: Math.round(r.mm * 10) / 10, vias: r.vias });
  }
  found.sort((a, b) => b.closes - Math.max(0, b.errors) - (a.closes - Math.max(0, a.errors)) || a.moved.length - b.moved.length || a.vias - b.vias || a.mm - b.mm);
  // routing alone (no change) closes some: then route first
  const alone = Math.max(0, ...[...baselines.values()].map((r) => cur.unrouted.length - r.open));
  return {
    open_now: cur.unrouted.length,
    tried,
    screened: `${screened.length} of ${tries.length} tries fit and do not tangle the ratsnest; the best ${tried} routed`,
    parts_tried: parts.map((p) => p.refdes),
    ...(skipped.length ? { not_moved: skipped, why_not: why } : {}),
    ...(alone ? { routing_alone: `routing these nets again, with no change, closes ${alone} connection(s): ${drawn ? 'route them (the helper) or draw them' : 'route again'} first` } : {}),
    suggestions: found.slice(0, q.max ?? 5).map((f) => ({
      change: f.change,
      apply: f.apply,
      closes: f.closes,
      open_after: f.open,
      ...(f.errors > 0 ? { new_errors: f.errors } : {}),
      ...(f.moved.length ? { also_moves: f.moved } : {}),
      routed: `${f.nets.join(', ')}: ${f.mm} mm, ${f.vias} via(s)`,
      ...(drawn ? { then: { op: 'route', nets: f.nets } } : {}),
    })),
    note: found.length
      ? `Each was routed for the nets it touches round the rest of the copper and measured against those nets routed again without it. Apply one with design_edit (its apply ops${drawn ? '; the copper by the part follows it, then route the nets in then, or draw them' : ', then route'}) and look at the spot again.`
      : `No small change here closes a connection (${tried} routed). Move a main part on purpose (try_placements compares arrangements), give the area more room, or ${drawn ? 'draw round it on the other layer' : 'try 4 layers'}.`,
  };
}
