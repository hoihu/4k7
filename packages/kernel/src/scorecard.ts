/**
 * design_query get_scorecard: the design in a few numbers, the same for the same design. It counts
 * what the kernel has already worked out (the checks, the ledger's status, the power tree, each
 * board as placed or as routed for its placement) and works nothing out that the queries do not:
 * it never routes. See docs/design/scorecard.md.
 */
import { UNKNOWN_CODES, checkFamily, isHole, type BoardScore, type BoardView, type Design, type Diagnostic, type Scorecard } from '@4k7/schema';
import { linearRegulators } from './checks.ts';
import { currentCheck } from './current.ts';
import { cardOf } from './doc.ts';
import { powerTreeAnswer } from './powertree.ts';

/** One board as the scorecard reads it: its view where routed for this placement, else its placement. */
export interface ScoredBoard {
  id: string;
  name: string;
  /** The board as a design of its own (boards.ts): what its current check is worked out on. */
  design: Design;
  view: BoardView;
  /** The view carries copper routed (or drawn) for this placement. */
  routed: boolean;
}

export interface ScorecardInputs {
  /** Every finding, waived ones included, each once (Kernel.diagnostics() and the boards' own). */
  findings: Diagnostic[];
  /** The ledger's status by constraint id (SchematicView.constraintStatus). */
  constraintStatus: Record<string, string>;
  boards: ScoredBoard[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const sorted = <T>(m: Map<string, T>): Record<string, T> => Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** What get_power_tree says of each rail, as far as the scorecard reads it. */
interface RailAnswer {
  voltage: number | 'unknown';
  source: { kind: string };
  current: { budget: 'ok' | 'over' | 'unknown' };
}

export function scorecard(d: Design, inputs: ScorecardInputs): Scorecard {
  const findings = new Map<string, { errors: number; warnings: number; infos: number }>();
  const unknown = new Map<string, number>();
  let waived = 0;
  for (const x of inputs.findings) {
    if (x.waivedBy) {
      waived++;
      continue;
    }
    const fam = checkFamily(x.code);
    const f = findings.get(fam) ?? findings.set(fam, { errors: 0, warnings: 0, infos: 0 }).get(fam)!;
    if (x.severity === 'error') f.errors++;
    else if (x.severity === 'warning') f.warnings++;
    else f.infos++;
    if (UNKNOWN_CODES.has(x.code)) unknown.set(x.code, (unknown.get(x.code) ?? 0) + 1);
  }

  const constraints = Object.values(d.ledger);
  const ledger = {
    hard: constraints.filter((k) => k.strength === 'hard').length,
    soft: constraints.filter((k) => k.strength === 'soft').length,
    violated: constraints.filter((k) => inputs.constraintStatus[k.id] === 'violated').length,
  };

  const comps = Object.values(d.components);
  const padOnly = (c: (typeof comps)[number]) => !!cardOf(d, c.part)?.padOnly;
  const parts = {
    fitted: comps.filter((c) => !c.dnp && !padOnly(c)).length,
    dnp: comps.filter((c) => c.dnp && !padOnly(c)).length,
    cards: new Set(comps.map((c) => c.part)).size,
  };

  const rails = (powerTreeAnswer(d) as { rails: RailAnswer[] }).rails;
  // the hot ones, worst first by how far over their package's limit (as SEM.LDO_DISSIPATION judges them)
  const hot = linearRegulators(d)
    .filter((r) => r.status === 'warning' || r.status === 'error')
    .map((r) => ({ ref: r.component.refdes, watts: r.watts!, limit: r.limit!.maxW }))
    .sort((a, b) => b.watts / b.limit - a.watts / a.limit || (a.ref < b.ref ? -1 : 1));
  const power = {
    rails: rails.length,
    over: rails.filter((x) => x.current.budget === 'over').length,
    unknown: rails.filter((x) => x.voltage === 'unknown' || x.source.kind === 'unknown' || x.current.budget === 'unknown').length,
    hot: { count: hot.length, ...(hot[0] ? { worst: `${hot[0].ref}: ${r2(hot[0].watts)} W of ${r2(hot[0].limit)} W` } : {}) },
  };

  return { findings: sorted(findings), waived, unknown: sorted(unknown), ledger, parts, power, boards: inputs.boards.map(boardScore) };
}

function boardScore(s: ScoredBoard): BoardScore {
  const b = s.view;
  const placed = b.parts.filter((p) => !isHole(p));
  const head: BoardScore = {
    id: s.id,
    name: s.name,
    width_mm: r2(b.outline.w),
    height_mm: r2(b.outline.h),
    size_by: b.sizeBy,
    layers: b.layers.length,
    parts: { top: placed.filter((p) => p.side !== 'bottom').length, bottom: placed.filter((p) => p.side === 'bottom').length },
    // (stale: routed for an earlier placement, nothing of its copper judged; none: no copper, also
    // when routing is asked for this placement and not worked out yet)
    routing: s.routed ? 'done' : b.routing === 'stale' ? 'stale' : 'none',
  };
  if (!s.routed) return head;
  const nets = (b.current ?? currentCheck(s.design, b)).nets;
  const count = (st: string) => nets.filter((n) => n.status === st).length;
  let worst: { net: string; ratio: number } | undefined;
  for (const n of nets) if (n.worst !== undefined && (!worst || n.worst > worst.ratio)) worst = { net: n.name, ratio: n.worst };
  return {
    ...head,
    connections: { nets: b.stats.nets, routed: b.stats.routed, open: b.stats.unrouted },
    track_mm: r2(b.stats.trackLength),
    vias: b.stats.vias,
    current: { ok: count('ok'), over: count('over'), unverified: count('unverified'), unknown: count('unknown'), ...(worst ? { worst: { net: worst.net, ratio: r2(worst.ratio) } } : {}) },
  };
}
