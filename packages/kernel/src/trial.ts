/**
 * try_placements: the agent's arrangements of the main parts, compared without changing the
 * design. Each option is placed exactly as propose_placement would place it (the small parts
 * round the main ones, refined) and measured; with `route` it is also routed for a few seconds, a
 * trial of how many connections that arrangement closes. Then the kernel improves on the best
 * (explore): it turns the main parts, swaps two, shifts one, and keeps what untangles the
 * ratsnest and eases the congestion; that arrangement is one more option, with its parts. The
 * agent applies the winner.
 */
import type { BoardView, Design, PartPlacement, SchematicView } from '@4k7/schema';
import { proposePlacement } from './boardops.ts';
import { layoutBoard, placeBoard } from './board.ts';
import { routability } from './congestion.ts';
import { exploreMain } from './refine.ts';
import { RejectError, clone } from './doc.ts';

export interface TrialCandidate {
  name?: string;
  parts: PartPlacement[];
  width_mm?: number;
  height_mm?: number;
}

/** All options together are routed for at most this long; each gets its share, up to TRIAL_MAX_MS. */
const TRIAL_TOTAL_MS = 40_000;
const TRIAL_MAX_MS = 8_000;
/** Exploring round the best option: at most this long. */
const EXPLORE_MS = 8_000;
/** In the explore score (routability: 4 × crossings + ratsnest mm + 8 × congestion mm), a placement problem weighs far more. */
const PROBLEM_SCORE = 1e5;
/** Placement findings: parts overlapping, off the board or too close to its edge. */
const PLACEMENT_CODES = new Set(['DRC.COURTYARD_OVERLAP', 'DRC.OFF_BOARD', 'DRC.EDGE_CLEARANCE', 'DRC.CUTOUT_OVERLAP']);

function measures(b: BoardView) {
  const problems = b.diagnostics.filter((x) => !x.waivedBy && PLACEMENT_CODES.has(x.code));
  return {
    board_mm: [b.outline.w, b.outline.h],
    ratsnest_mm: b.measures.ratsnestMm,
    ratsnest_crossings: b.measures.crossings,
    congestion_mm: b.measures.congestion.overflowMm,
    routability: Math.round(routability(b.measures)),
    placement_problems: problems.length,
    ...(problems.length ? { problems: problems.slice(0, 4).map((x) => x.message) } : {}),
  };
}

function routing(b: BoardView) {
  return {
    open_connections: b.stats.unrouted,
    nets_routed: `${b.stats.routed}/${b.stats.nets}`,
  };
}

/**
 * Improve on an arrangement of the main parts: placed as propose_placement places it, then the
 * main parts turned, shifted and swapped with their small parts (refine.ts exploreMain), kept
 * where that untangles the ratsnest; then placed again by the placer (which puts the small parts
 * round them afresh) and explored again from there, while that makes the placement better. The
 * parts it ends with, or null.
 */
function explore(d: Design, sch: SchematicView, base: TrialCandidate, until: number): PartPlacement[] | null {
  const placed = (parts: PartPlacement[]) => {
    const work = clone(d);
    try {
      proposePlacement(work, { op: 'propose_placement', parts, ...(base.width_mm !== undefined ? { width_mm: base.width_mm, height_mm: base.height_mm } : {}) });
    } catch (e) {
      if (e instanceof RejectError) return null;
      throw e;
    }
    return placeBoard(work, sch);
  };
  const score = (b: BoardView) => {
    return measures(b).placement_problems * PROBLEM_SCORE + routability(b.measures);
  };
  let parts = base.parts.map((p) => ({ ...p }));
  let b = placed(parts);
  if (!b) return null;
  let best = score(b);
  let changed = false;
  const planeNets = new Set(b.planes.filter((pl) => pl.layer !== 'F.Cu' && pl.layer !== 'B.Cu' && !pl.area).map((pl) => pl.netId));
  for (let round = 0; round < 4 && Date.now() < until; round++) {
    const r = exploreMain(b, parts.map((p) => b!.parts.find((q) => q.refdes.toUpperCase() === p.ref.toUpperCase())?.refdes ?? p.ref), planeNets, 1.5 + b.rules.edgeClearance, Math.max(0, until - Date.now()));
    if (!r.moves.length) break;
    const next = parts.map((p) => {
      const mv = r.moves.find((x) => x.refdes.toUpperCase() === p.ref.toUpperCase());
      return mv ? { ...p, x_mm: mv.x, y_mm: mv.y, rot: mv.rot as 0 | 90 | 180 | 270 } : p;
    });
    const nb = placed(next);
    if (!nb || score(nb) >= best - 0.5) break;
    parts = next;
    b = nb;
    best = score(nb);
    changed = true;
  }
  return changed ? parts : null;
}

/** What changed from one arrangement to another, in words: "U1 turned 90°, J1 to (3, 20)". */
function changes(from: PartPlacement[], to: PartPlacement[]): string {
  return to
    .flatMap((p, j) => {
      const was = from[j]!;
      const turn = ((((p.rot ?? 0) - (was.rot ?? 0)) % 360) + 360) % 360;
      const moved = Math.hypot(p.x_mm - was.x_mm, p.y_mm - was.y_mm) > 1e-6;
      const what = [turn ? `turned ${turn}°` : '', moved ? `to (${Math.round(p.x_mm * 10) / 10}, ${Math.round(p.y_mm * 10) / 10})` : ''].filter(Boolean).join(' and ');
      return what ? [`${p.ref} ${what}`] : [];
    })
    .join(', ');
}

export function tryPlacements(d: Design, sch: SchematicView, candidates: TrialCandidate[], route: boolean, routedNow?: BoardView, exploring = true) {
  const budgetMs = Math.min(TRIAL_MAX_MS, Math.floor(TRIAL_TOTAL_MS / candidates.length));
  const now = placeBoard(d, sch);
  const current = {
    ...measures(now),
    ...(routedNow?.routing === 'done' && routedNow.placementKey === now.placementKey ? { routing: routing(routedNow) } : {}),
  };
  const t0 = Date.now();
  const trial = (c: TrialCandidate, i: number) => {
    const name = c.name ?? `option ${i + 1}`;
    const work = clone(d);
    try {
      proposePlacement(work, { op: 'propose_placement', parts: c.parts, ...(c.width_mm !== undefined ? { width_mm: c.width_mm } : {}), ...(c.height_mm !== undefined ? { height_mm: c.height_mm } : {}) });
    } catch (e) {
      if (e instanceof RejectError) return { option: i + 1, name, error: e.rejection.message };
      throw e;
    }
    const placed = placeBoard(work, sch);
    const b = route ? layoutBoard(work, placed, { route: true, budgetMs }) : placed;
    // the board fitted round the arrangement may move it over as a whole; beyond that, the main
    // parts the placer had to move away from where they were asked to go (an overlap, the edge)
    const at = c.parts.flatMap((p) => {
      const q = b.parts.find((x) => x.refdes.toUpperCase() === p.ref.toUpperCase());
      return q ? [{ q, dx: q.x - p.x_mm, dy: q.y - p.y_mm }] : [];
    });
    const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
    const shift = { x: median(at.map((a) => a.dx)), y: median(at.map((a) => a.dy)) };
    const nudged = at.filter((a) => Math.hypot(a.dx - shift.x, a.dy - shift.y) >= 0.5).map((a) => `${a.q.refdes} to (${a.q.x}, ${a.q.y})`);
    const shifted = Math.hypot(shift.x, shift.y) >= 0.3 ? { shifted_mm: [Math.round(shift.x * 10) / 10, Math.round(shift.y * 10) / 10] } : {};
    return { option: i + 1, name, ...measures(b), ...shifted, ...(nudged.length ? { nudged } : {}), ...(route ? { routing: routing(b) } : {}) };
  };
  const options: (ReturnType<typeof trial> & { parts?: PartPlacement[] })[] = candidates.map(trial);
  const score = (o: (typeof options)[number]) =>
    'error' in o ? [Infinity] : [o.routing?.open_connections ?? 0, o.placement_problems, o.routability];
  const rank = (list: typeof options) =>
    [...list].sort((a, b) => {
      const [sa, sb] = [score(a), score(b)];
      for (let k = 0; k < Math.max(sa.length, sb.length); k++) if ((sa[k] ?? 0) !== (sb[k] ?? 0)) return (sa[k] ?? 0) - (sb[k] ?? 0);
      return a.option - b.option;
    });
  let ranked = rank(options);
  // improve on the best: one more option, with the parts to apply it
  let explored: string | null = null;
  const top = ranked[0];
  if (exploring && top && !('error' in top)) {
    const base = candidates[top.option - 1]!;
    const parts = explore(d, sch, base, Date.now() + EXPLORE_MS);
    if (parts) {
      const o = trial({ ...base, name: `${top.name}, improved: ${changes(base.parts, parts)}`, parts }, candidates.length);
      if (!('error' in o)) {
        ranked = rank([...options, { ...o, parts }]);
        explored = `option ${o.option} is option ${top.option} improved by the kernel (${changes(base.parts, parts)}); its parts are listed to apply it`;
      }
    } else explored = `no turn, shift or swap of the main parts improves option ${top.option}`;
  }
  return {
    current,
    options: ranked,
    ...(explored ? { explored } : {}),
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    note:
      'Best first: fewest open connections' +
      (route ? ` (each routed for up to ${Math.round(budgetMs / 100) / 10} s; the route step runs longer and closes more)` : '') +
      ', then fewest placement problems, then the lowest routability score (4 × crossing ratsnest lines + ratsnest mm + 8 × congestion mm: where the ratsnest wants more track than the layers carry). shifted_mm: the board was fitted round the arrangement, which moved it over as a whole; nudged: main parts the placer moved away from where you put them (to clear an overlap or the edge). Nothing changed: apply the one you choose with design_edit propose_placement and the same parts, or vary the best further.',
  };
}
