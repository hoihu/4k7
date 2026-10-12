/**
 * Optimize: the user zoomed into an area of the schematic and asked the agent to improve how it is
 * drawn (docs/design/zoom-optimize.md). The kernel enforces the area; this tells the agent about it.
 */
import type { ScopeInfo, ScopeMeasures } from '@4k7/schema';

/** The measures in the order they are reported, with how each reads. */
const MEASURES: { key: keyof ScopeMeasures; name: string; unit?: string }[] = [
  { key: 'crossings', name: 'crossings' },
  { key: 'bends', name: 'bends' },
  { key: 'jogs', name: 'jogs' },
  { key: 'detours', name: 'detours' },
  { key: 'overlaps', name: 'overlaps' },
  { key: 'wireIn', name: 'wire', unit: ' in' },
  { key: 'labels', name: 'net labels' },
];

const measures = (m: ScopeMeasures) => MEASURES.map((x) => `${x.name} ${m[x.key]}${x.unit ?? ''}`).join(', ');

/** The measures a change moved, "crossings 2→0, bends 5→3" (empty if none moved). */
export function measureDelta(before: ScopeMeasures, after: ScopeMeasures): string {
  return MEASURES.filter((x) => before[x.key] !== after[x.key])
    .map((x) => `${x.name} ${before[x.key]}→${after[x.key]}${x.unit ?? ''}`)
    .join(', ');
}

/** The <scope> block of the design context while an Optimize run is on. */
export function formatScope(s: ScopeInfo): string {
  const lines = [`<scope view="schematic" sheet="${s.sheetName}">`];
  if (s.widened) lines.push('the view held no whole parts to work on, so the area was widened to the parts its wires lead to');
  lines.push(`movable (inside the area): ${s.free.join(' ')}`);
  if (s.anchored.length) lines.push(`anchored (refer to them, never move them): ${s.anchored.map((a) => `${a.ref} (${a.why})`).join('; ')}`);
  lines.push(`outside the area: ${s.context} more part${s.context === 1 ? '' : 's'}, read-only`);
  if (s.boundaryNets.length) lines.push(`nets that leave the area: ${s.boundaryNets.join(' ')}`);
  lines.push(`measures now (lower is better): ${measures(s.measures)}`);
  if (s.scope.goal) lines.push(`the user's goal: ${s.scope.goal}`);
  lines.push('</scope>');
  return lines.join('\n');
}

/** The message that starts an Optimize run (the same for the in-app agent and Claude Code). */
export function optimizePrompt(s: ScopeInfo): string {
  const goal = s.scope.goal ? [`What bothers me: ${s.scope.goal}`] : [];
  return [
    `Optimize the area I zoomed into on sheet ${s.sheetName}: look at it and improve how it is drawn. The <scope> block lists what you may move.`,
    ...goal,
    '',
    'Rules for this run:',
    '1. First look at the area (get_schematic_image with area: true, if you have it) and say in one sentence what is wrong with it. Judge how it reads, not only whether it is correct: a wire that bends, jogs or doubles back where it could run straight is worth fixing. The measures help: bends are wire corners, jogs are pins that face each other on one wire but are not in line (two resistors of a divider side by side instead of stacked), detours are wires that turn back the way they came, overlaps are supply symbols and labels that run into a wire of another net, another label or a part. The SCH.* diagnostics inside the area are the first things to fix: each names the rule the drawing breaks and where. If nothing is worth changing, say so and stop; changing nothing is a good answer.',
    '2. You may only change how the area is drawn: constrain (left_of, right_of, above, below; soft only), constrain arrangement, place_symbol to put a movable part exactly where it belongs (design_query get_schematic gives the page and coordinates), remove_constraint on placement constraints, and set_symbol on big ICs inside it. Anything else (connect, set_param, add_part, remove, set_net …) is refused: the circuit stays exactly as it is.',
    '3. Move only the movable parts. Refer to anchored parts, never move them. If the real cause is outside the area, name the part and tell me; do not work around it.',
    '4. Try each change with dry_run first. The result has a "scope" field: "measures" against "baseline" (lower is better) and "ripple", the parts outside the area whose drawing moved. Keep a change only if it improves a measure without worsening another and ripple is empty. If nothing you try improves it, change nothing and say so.',
    '5. Then apply the change for real (and call propose if you have that tool), and finish with a short reply: what was wrong, what you changed, measures before and after.',
  ].join('\n');
}
