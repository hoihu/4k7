/**
 * How the user wants schematics drawn (docs/design/schematic-drawing.md §3), in two parts:
 *
 * - **Notes**: the user's own words to the agent, like a CLAUDE.md. Empty by default: the model
 *   knows how a schematic is drawn; the user writes down what it gets wrong or what they like
 *   differently ("labels always horizontal").
 * - **Checks**: the drawing rules the kernel can measure, each with a level the user picks in
 *   Settings. A finding is an `SCH.*` diagnostic at that level.
 */
import type { Diagnostic } from './results.ts';

export type RuleLevel = 'error' | 'warning' | 'info' | 'off';

/** One check, as the kernel runs it: the shipped check with the user's level and limit. */
export interface SchematicRule {
  id: string;
  title: string;
  level: RuleLevel;
  /** The most findings allowed before it is reported (crossings per net), for a check that counts. */
  max?: number;
  /** The auto-layout draws it this way by itself; a finding is a layout bug, not the agent's. */
  layout: boolean;
}

/** A check the kernel has, in the words the Settings page shows. */
export interface SchematicCheck extends SchematicRule {
  /** One sentence for the user on what it looks at. */
  text: string;
}

export const SCHEMATIC_CHECKS: readonly SchematicCheck[] = [
  { id: 'SCH.RAIL_UP', title: 'Power symbols point up', text: 'A supply arrow points up (a negative rail down), never sideways, even when that means crossing a wire.', level: 'error', layout: true },
  { id: 'SCH.GND_DOWN', title: 'Ground symbols point down', text: 'Never up, never sideways.', level: 'error', layout: true },
  { id: 'SCH.RAIL_SIDE', title: 'Pull-ups up, pull-downs down', text: 'A resistor between a signal and a positive rail has the rail end on top (a pull-up stands above its wire), one to ground the ground end at the bottom.', level: 'warning', layout: false },
  { id: 'SCH.ORTHOGONAL', title: 'Wires run straight', text: 'Across or up and down, never slanted.', level: 'error', layout: true },
  { id: 'SCH.DANGLING', title: 'No loose wire ends', text: 'Every wire ends at a pin, a junction or another wire.', level: 'error', layout: true },
  { id: 'SCH.TEXT_OVERLAP', title: 'Text stays readable', text: 'Names, values and labels do not run into each other, a part or a wire.', level: 'warning', layout: false },
  { id: 'SCH.JOG', title: 'Parts in line', text: 'Two parts joined by a wire (a divider, parts in series) sit on one line, so the wire runs straight.', level: 'warning', layout: false },
  { id: 'SCH.DETOUR', title: 'No wire doubles back', text: 'A wire does not turn back the way it came.', level: 'warning', layout: false },
  { id: 'SCH.CROSSING', title: 'Few wire crossings', text: 'Counted per net; more than the limit is reported.', level: 'info', max: 0, layout: false },
];

/** The check ids the kernel has. */
export const CHECKED_SCH_RULES: readonly string[] = SCHEMATIC_CHECKS.map((c) => c.id);

/** The user's changes to the checks, by id; what is not here keeps the shipped level and limit. */
export type CheckSettings = Record<string, { level?: RuleLevel; max?: number }>;

const LEVELS: readonly RuleLevel[] = ['error', 'warning', 'info', 'off'];

/** The checks as the kernel runs them: the shipped ones with the user's levels and limits (an unknown level or a bad limit is ignored). */
export function resolveChecks(user?: CheckSettings | null): Record<string, SchematicRule> {
  const out: Record<string, SchematicRule> = {};
  for (const { text: _, ...c } of SCHEMATIC_CHECKS) {
    const u = user?.[c.id];
    const level = u?.level && LEVELS.includes(u.level) ? u.level : c.level;
    const max = c.max !== undefined && Number.isInteger(u?.max) && u!.max! >= 0 ? u!.max : c.max;
    out[c.id] = { ...c, level, ...(max !== undefined ? { max } : {}) };
  }
  return out;
}

/** Only what differs from the shipped checks, so a reset is an empty object and a later default change still reaches the user. */
export function changedChecks(user: CheckSettings): CheckSettings {
  const shipped = resolveChecks();
  const now = resolveChecks(user);
  const out: CheckSettings = {};
  for (const id of CHECKED_SCH_RULES) {
    const s = shipped[id]!;
    const n = now[id]!;
    const c = { ...(n.level !== s.level ? { level: n.level } : {}), ...(n.max !== s.max ? { max: n.max } : {}) };
    if (Object.keys(c).length) out[id] = c;
  }
  return out;
}

/** What the notes box shows while it is empty. */
export const SCHEMATIC_NOTES_PLACEHOLDER = `Nothing here yet, and that is fine: the agent knows how a schematic is drawn.

Write down what it gets wrong, or what you like differently, the way you would tell a colleague. For example:

Labels are always horizontal.
Draw the feedback divider as wires, not labels.
Connectors go on the left edge of the page.`;

export const LAYOUT_NOTES_PLACEHOLDER = `Nothing here yet: the agent places, chooses planes and routes as it sees fit.

Write down your rules and what it gets wrong, the way you would tell a colleague. For example:

Under each IC, the plane on the layer next to it carries the IC's supply (+3V3 under the MCU), not the input rail.
Connectors go on the board edge, facing out.
Crystals right at the MCU, nothing routed under them.
Keep the switching loop of a buck converter small: input cap, switch and diode close together.`;

export const ENCLOSURE_NOTES_PLACEHOLDER = `Nothing here yet: the agent uses the guide's defaults (FDM, 0.4 mm nozzle, PLA indoors, 0.2–0.3 mm clearance for parts that fit together).

Write down your printer, material and what fits for you. For example:

I print PETG on a Prusa MK4 with a 0.4 mm nozzle; 0.25 mm per side fits, 0.15 is a press fit.
M3 heat-set inserts (hole 4.0 mm, 5.7 mm long) for every screw.
Lids snap on; no screws I can see from outside.
Rounded corners, 3 mm radius, and my logo engraved on the lid.`;

/**
 * The notes and check levels from the ruleset text of earlier versions ("### SCH.ID: title"
 * headings with "level:" and "param:" lines). The levels become check settings; the text keeps
 * its prose from the first "## " heading on (the editor's note above it was never sent), with
 * the ids, level lines and "(layout)" marks taken out; nothing when that prose is the old default's.
 */
export function migrateRulesText(md: string): { notes: string; checks: CheckSettings } {
  const checks: CheckSettings = {};
  const all = md.replace(/\r\n?/g, '\n').split('\n');
  let keep = !all.some((l) => /^## /.test(l));
  let cur: string | null = null;
  const lines: string[] = [];
  for (const line of all) {
    if (/^## /.test(line)) keep = true;
    const h = /^###\s+(SCH\.[A-Z0-9_]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (h) {
      cur = h[1]!;
      if (keep) lines.push(`### ${h[2]![0]!.toUpperCase()}${h[2]!.slice(1)}`);
      continue;
    }
    if (/^#/.test(line)) cur = null;
    const lv = /^level:\s*(error|warning|info|off)\s*$/i.exec(line);
    const pm = /^param:\s*(.+?)\s*$/i.exec(line);
    if (cur && (lv || pm)) {
      const n = pm && /(\d+)/.exec(pm[1]!);
      if (CHECKED_SCH_RULES.includes(cur)) checks[cur] = { ...checks[cur], ...(lv ? { level: lv[1]!.toLowerCase() as RuleLevel } : {}), ...(n ? { max: Number(n[1]) } : {}) };
      continue;
    }
    if (keep) lines.push(line.replace(/\*\(layout\)\*\s*/gi, ''));
  }
  const prose = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const notes = prose ? `${prose}\n` : '';
  // a copy whose prose is the old default's (only levels changed) leaves no notes: the agent knows all that
  return { notes: fnv1a(notes) === OLD_DEFAULT_PROSE ? '' : notes, checks: changedChecks(checks) };
}

/** FNV-1a of the prose migrateRulesText makes of the ruleset shipped until 2026-10-13. */
const OLD_DEFAULT_PROSE = 0x2e558644;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** The checks the auto-layout follows by itself: a finding there is a layout bug, not something an edit of the design fixes. */
export const LAYOUT_SCH_RULES: ReadonlySet<string> = new Set(SCHEMATIC_CHECKS.filter((c) => c.layout).map((c) => c.id));

/** An open error the agent has to fix or waive before it finishes: not a layout bug, which it has no lever on. */
export const mustFix = (d: Diagnostic) => d.severity === 'error' && !d.waivedBy && !LAYOUT_SCH_RULES.has(d.code);
