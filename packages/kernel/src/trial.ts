/**
 * try_placements: the agent's arrangements of the main parts, compared without changing the
 * design. Each option is placed exactly as propose_placement would place it (the small parts
 * round the main ones) and measured; with `route` it is also routed for a few seconds, a trial
 * of how many connections that arrangement closes. The agent iterates on the best and applies it.
 */
import type { BoardView, Design, PartPlacement, SchematicView } from '@4k7/schema';
import { proposePlacement } from './apply.ts';
import { layoutBoard, placeBoard } from './board.ts';
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
/** Placement findings: parts overlapping, off the board or too close to its edge. */
const PLACEMENT_CODES = new Set(['DRC.COURTYARD_OVERLAP', 'DRC.OFF_BOARD', 'DRC.EDGE_CLEARANCE', 'DRC.CUTOUT_OVERLAP']);

function measures(b: BoardView) {
  const problems = b.diagnostics.filter((x) => !x.waivedBy && PLACEMENT_CODES.has(x.code));
  return {
    board_mm: [b.outline.w, b.outline.h],
    ratsnest_mm: b.measures.ratsnestMm,
    ratsnest_crossings: b.measures.crossings,
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

export function tryPlacements(d: Design, sch: SchematicView, candidates: TrialCandidate[], route: boolean, routedNow?: BoardView) {
  const budgetMs = Math.min(TRIAL_MAX_MS, Math.floor(TRIAL_TOTAL_MS / candidates.length));
  const now = placeBoard(d, sch);
  const current = {
    ...measures(now),
    ...(routedNow?.routing === 'done' && routedNow.placementKey === now.placementKey ? { routing: routing(routedNow) } : {}),
  };
  const options = candidates.map((c, i) => {
    const name = c.name ?? `option ${i + 1}`;
    const work = clone(d);
    try {
      proposePlacement(work, { op: 'propose_placement', parts: c.parts, ...(c.width_mm !== undefined ? { width_mm: c.width_mm } : {}), ...(c.height_mm !== undefined ? { height_mm: c.height_mm } : {}) });
    } catch (e) {
      if (e instanceof RejectError) return { option: i + 1, name, error: e.rejection.message };
      throw e;
    }
    const b = route ? layoutBoard(work, sch, { route: true, budgetMs }) : placeBoard(work, sch);
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
  });
  const score = (o: (typeof options)[number]) =>
    'error' in o ? [Infinity] : [o.routing?.open_connections ?? 0, o.placement_problems, o.ratsnest_crossings, o.ratsnest_mm];
  const ranked = [...options].sort((a, b) => {
    const [sa, sb] = [score(a), score(b)];
    for (let k = 0; k < Math.max(sa.length, sb.length); k++) if ((sa[k] ?? 0) !== (sb[k] ?? 0)) return (sa[k] ?? 0) - (sb[k] ?? 0);
    return a.option - b.option;
  });
  return {
    current,
    options: ranked,
    note:
      'Best first: fewest open connections' +
      (route ? ` (each routed for up to ${Math.round(budgetMs / 100) / 10} s; the route step runs longer and closes more)` : '') +
      ', then fewest placement problems, crossing ratsnest lines, shortest ratsnest. shifted_mm: the board was fitted round the arrangement, which moved it over as a whole; nudged: main parts the placer moved away from where you put them (to clear an overlap or the edge). Nothing changed: apply the one you choose with design_edit propose_placement and the same parts, or vary the best further.',
  };
}
