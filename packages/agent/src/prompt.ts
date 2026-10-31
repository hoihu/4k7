/**
 * System prompt and per-turn design context. The system prompt is static (cacheable);
 * the design state travels with each user message.
 */
import { DESIGN_GUIDE, type DesignSummary, type Diagnostic, type ScopeInfo, type ViewInfo } from '@4k7/schema';
import { formatScope } from './optimize.ts';
import { formatView } from './view.ts';

export const SYSTEM_PROMPT = `You are the design agent inside 4k7, a browser-based PCB schematic and layout tool with no manual drawing tools. You design circuits by calling tools; a deterministic kernel turns your semantic operations into schematic geometry, validates every change and runs electrical and datasheet checks. The user steers with requests and hints and reviews your changes as a changeset before they are committed. Each user message comes with the current design state.

${DESIGN_GUIDE}

Asking and answering:
- If a decision has a real trade-off you cannot settle from the request or the ledger (e.g. inductor size vs. saturation current), call ask_user with 2–5 concrete options instead of guessing. Do not ask about things you can decide sensibly yourself.
- Finish with a short reply (2–5 sentences): what you changed, anything the user should know (warnings left, waivers, assumptions). The user sees the detailed diff separately, so do not list every op.`;

export function formatDesignContext(opts: {
  summary: DesignSummary;
  diagnostics: Diagnostic[];
  ledger: { id: string; text: string; strength: string }[];
  selection: string[];
  /** An Optimize run: the area the agent is restricted to. */
  scope?: ScopeInfo | null;
  /** What the user had on screen when they sent the message. */
  view?: ViewInfo | null;
  /** The user's schematic notes (Settings → Schematic): how they want the schematic drawn, in their words. */
  rules?: string;
  /** The user's layout notes (Settings → Board layout): how they want boards laid out, in their words. */
  layoutRules?: string;
  /** The user's enclosure notes (Settings → Enclosure): their printer, material, fasteners and fits, in their words. */
  enclosureRules?: string;
}): string {
  const { summary: s, diagnostics, ledger, selection, scope, view, rules, layoutRules, enclosureRules } = opts;
  const lines: string[] = ['<design_state>'];
  lines.push(`name: ${s.name}; sheets: ${s.sheets.join(', ')}; pages: ${s.pages}`);
  if (s.components.length) {
    lines.push(`components (${s.components.length}): ` + s.components.map((c) => `${c.refdes}=${c.value}[${c.part}]`).join(' '));
  } else {
    lines.push('components: none (empty design)');
  }
  if (s.nets.length) {
    lines.push(
      'nets: ' +
        s.nets.map((n) => `${n.name}(${n.pins}${n.voltage !== undefined ? `, ${n.voltage}V` : ''}${n.external ? ', ext' : ''})`).join(' '),
    );
  }
  if (s.valueSeries) lines.push('value series: ' + Object.entries(s.valueSeries).map(([k, v]) => `${k}s ${v}`).join(', '));
  const open = diagnostics.filter((d) => !d.waivedBy);
  const c = s.counts;
  lines.push(`diagnostics: ${c.errors} errors, ${c.warnings} warnings, ${c.waived} waived`);
  for (const d of open.slice(0, 15)) lines.push(`  ${d.severity.toUpperCase()} ${d.code} ${d.entities.join(',')}: ${d.message}`);
  if (open.length > 15) lines.push(`  … ${open.length - 15} more (design_query get_diagnostics)`);
  if (s.description) {
    const u = s.description.undescribed;
    lines.push(`description: ${s.description.blocks} blocks` + (u.length ? `; in no block: ${u.join(', ')}` : ''));
  }
  if (ledger.length) {
    lines.push('ledger:');
    for (const k of ledger) lines.push(`  ${k.id} ${k.text} (${k.strength})`);
  }
  lines.push('</design_state>');
  if (rules?.trim()) lines.push(`<schematic_notes>\n${rules.trim()}\n</schematic_notes>`);
  if (layoutRules?.trim()) lines.push(`<layout_notes>\n${layoutRules.trim()}\n</layout_notes>`);
  if (enclosureRules?.trim()) lines.push(`<enclosure_notes>\n${enclosureRules.trim()}\n</enclosure_notes>`);
  if (selection.length) lines.push(`<selection>${selection.join(', ')}</selection>`);
  if (view && !scope) lines.push(formatView(view));
  if (scope) lines.push(formatScope(scope));
  return lines.join('\n');
}

export function formatVerification(errors: Diagnostic[]): string {
  return [
    '[kernel verification] The working design still has errors. Fix them, or waive a diagnostic with a concrete reason only if it is intended, then finish:',
    ...errors.slice(0, 12).map((d) => `- ${d.code} ${d.entities.join(',')}: ${d.message}${d.fixHints?.length ? ` Suggested: ${JSON.stringify(d.fixHints)}` : ''}`),
  ].join('\n');
}

/** The drawing review at the end of a turn: the SCH.* warnings the turn brought, once. */
export function formatReview(found: Diagnostic[]): string {
  return [
    '[kernel review] Before you finish, look over the schematic you changed (get_schematic_image of the page, if you have it). The drawing checks found these where there were none before the turn:',
    ...found.slice(0, 12).map((d) => `- ${d.code} ${d.entities.join(',')}: ${d.message}${d.fixHints?.length ? ` Suggested: ${JSON.stringify(d.fixHints)}` : ''}`),
    'Judge how it reads, as an engineer would draw it: a pull-up stands above its wire with the rail on top, even if a wire crosses it; a pull-down hangs below. Fix what reads badly (constrain arrangement up/down for a part at a pin, place_symbol on a sheet you arranged, place_text for a name or value in the way), check the result, then finish. Leave what is right as it is and say why in one sentence; this review comes once per turn.',
  ].join('\n');
}
