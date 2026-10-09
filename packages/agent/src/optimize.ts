/**
 * Optimize: the user zoomed into an area of the schematic and asked the agent to improve how it is
 * drawn (docs/design/zoom-optimize.md). The kernel enforces the area; this tells the agent about it.
 */
import type { ScopeInfo, ScopeMeasures } from '@tracewise/schema';

const measures = (m: ScopeMeasures) => `crossings ${m.crossings}, wire ${m.wireIn} in, net labels ${m.labels}`;

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
    '1. First look at the area (get_schematic_image with area: true, if you have it) and say in one sentence what is wrong with it. If nothing is worth changing, say so and stop; changing nothing is a good answer.',
    '2. You may only change how the area is drawn: constrain (left_of, right_of, above, below; soft only), constrain arrangement, remove_constraint on placement constraints, and set_symbol on big ICs inside it. Anything else (connect, set_param, add_part, remove, set_net …) is refused: the circuit stays exactly as it is.',
    '3. Move only the movable parts. Refer to anchored parts, never move them. If the real cause is outside the area, name the part and tell me; do not work around it.',
    '4. Try each change with dry_run first. The result has a "scope" field: "measures" against "baseline" (lower is better) and "ripple", the parts outside the area whose drawing moved. Keep a change only if it improves a measure without worsening another and ripple is empty. If nothing you try improves it, change nothing and say so.',
    '5. Then apply the change for real (and call propose if you have that tool), and finish with a short reply: what was wrong, what you changed, measures before and after.',
  ].join('\n');
}
