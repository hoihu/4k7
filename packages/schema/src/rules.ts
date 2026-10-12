/**
 * The schematic ruleset (docs/design/schematic-drawing.md §3): one markdown text that says how a
 * good schematic looks. Prose is guidance for the agent; a "### SCH.ID: title" heading with a
 * "level:" line is a rule the kernel checks. The default ships here as code (the server runs
 * from TS, so no .md imports); the user edits a copy in Settings.
 */
import type { Diagnostic } from './results.ts';

export type RuleLevel = 'error' | 'warning' | 'info' | 'off';

export interface SchematicRule {
  id: string;
  title: string;
  level: RuleLevel;
  /** The rule's threshold as written ("max 0"), when it has one; the checks read the number in it (paramNumber). */
  param?: string;
  /** Marked (layout): the auto-layout follows it by itself; the check guards against layout bugs. */
  layout: boolean;
}

/** The rule ids the kernel has a check for; any other SCH heading is guidance for the agent only. */
export const CHECKED_SCH_RULES = ['SCH.RAIL_UP', 'SCH.GND_DOWN', 'SCH.ORTHOGONAL', 'SCH.DANGLING', 'SCH.TEXT_OVERLAP', 'SCH.JOG', 'SCH.DETOUR', 'SCH.CROSSING'] as const;

/** The number in a rule's param ("max 0", "max: 2", "2"); undefined when it has none. */
export function paramNumber(param: string | undefined): number | undefined {
  const m = /(\d+)/.exec(param ?? '');
  return m ? Number(m[1]) : undefined;
}

const RULE_HEADING = /^###\s+(SCH\.[A-Z0-9_]+)\s*:\s*(.+?)\s*$/;
const LEVEL_LINE = /^level:\s*(error|warning|info|off)\s*$/i;
const PARAM_LINE = /^param:\s*(.+?)\s*$/i;

/**
 * Splits the ruleset into the guidance the agent reads (the markdown from its first "## " heading
 * on, without the "level:" and "param:" lines; rule headings stay, so the agent knows the ids) and
 * the rules by id. The title and the note above the first "## " heading are for whoever edits the
 * text. A heading without a "level:" line is guidance only.
 */
export function parseSchematicRules(md: string): { guidance: string; rules: Record<string, SchematicRule> } {
  const rules: Record<string, SchematicRule> = {};
  const lines: string[] = [];
  let cur: { id: string; title: string; level?: RuleLevel; param?: string; layout: boolean } | null = null;
  const close = () => {
    if (cur?.level) rules[cur.id] = { id: cur.id, title: cur.title, level: cur.level, ...(cur.param ? { param: cur.param } : {}), layout: cur.layout };
    cur = null;
  };
  const all = md.replace(/\r\n?/g, '\n').split('\n');
  let keep = !all.some((l) => /^## /.test(l));
  for (const line of all) {
    if (/^## /.test(line)) keep = true;
    const h = RULE_HEADING.exec(line);
    if (h) {
      close();
      cur = { id: h[1]!, title: h[2]!, layout: false };
      if (keep) lines.push(line);
      continue;
    }
    if (/^#/.test(line)) close();
    const lv = cur && LEVEL_LINE.exec(line);
    if (lv) {
      cur!.level = lv[1]!.toLowerCase() as RuleLevel;
      continue;
    }
    const pm = cur && PARAM_LINE.exec(line);
    if (pm) {
      cur!.param = pm[1]!;
      continue;
    }
    if (cur && /\(layout\)/i.test(line)) cur.layout = true;
    if (keep) lines.push(line);
  }
  close();
  return { guidance: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', rules };
}

/** One line for the agent on which SCH headings the kernel checks, at what level; the other headings are guidance only. */
export function checkedRulesNote(rules: Record<string, SchematicRule>): string {
  const on = CHECKED_SCH_RULES.map((id) => {
    const r = rules[id];
    const n = paramNumber(r?.param);
    return `${id} ${r?.level ?? 'off'}${n !== undefined ? ` (max ${n})` : ''}`;
  });
  return `Checked by the kernel (reported as SCH.* diagnostics): ${on.join(', ')}; the other SCH headings are guidance only.`;
}

export const SCHEMATIC_RULES = `# Schematic rules

How this ruleset works: plain text is guidance for the agent that arranges the schematic. A
"### SCH.ID: title" heading with a "level:" line is a rule the kernel checks; set the level to
"error", "warning", "info" or "off". A "param:" line sets the rule's threshold (the number in it
is what counts). Rules marked *(layout)* the auto-layout follows by itself; turning one off only
silences its check. Rule ids the kernel does not know are read by the agent only. This note and
the title stay out of what the agent reads: its text starts at the first "##" heading.

## Reading direction

A schematic is read like text: left to right, top to bottom.

- Signal flows left to right: inputs and connectors that bring signals in on the left, outputs and
  loads on the right.
- Power flows the same way: input connector and protection, then regulation, then what is supplied.
  Supply generation sits left of or above the circuits it feeds.
- Higher potential higher on the page: rails at the top, ground at the bottom. A part between a rail
  and ground stands upright, rail end on top.
- Feedback runs against the flow, so draw it visibly: a feedback path goes back above or below the
  forward path, not through it.

## Blocks

- Group parts by function (input protection, buck converter, MCU, USB, sensor interface). A block is
  drawn together and never split across pages.
- Build each block around its main part (the IC, the transistor, the connector), its small parts
  at the pins they belong to.
- Leave clear space between blocks, more than inside them, so the eye sees the blocks.
- Draw a recognised circuit the way its datasheet does (a regulator's reference design, a bridge
  rectifier as a diamond), so it is recognised at a glance.

## Supplies

### SCH.RAIL_UP: positive rails point up
level: error

*(layout)* A positive supply symbol points up, its name above the arrow. Never down, never sideways.
Negative rails (VEE, -12V) point down.

### SCH.GND_DOWN: ground points down
level: error

*(layout)* A ground symbol points down. Never up, never sideways.

- A supply symbol stands on a short lead from its pin. When it has to cross a wire of another net to
  stand upright, that is acceptable; standing upright matters more than the crossing.
- One rail symbol per group of pins on the same rail: neighbouring supply pins share a short bus
  with one symbol at its end.
- A decoupling capacitor sits next to the supply pin it decouples, rail on top, ground below, and is
  drawn as part of that IC's block. Caps on the same rail form one bank with a shared rail and ground
  line.
- Draw a supply as a symbol, not as a net label. A local rail that only links two parts may be a
  wire.

## Parts

- Use the conventional symbol for each part (resistor, capacitor, polarised capacitor, inductor,
  diode, LED, transistor), the same style throughout.
- A two-pin part between a signal and a supply or ground stands upright. A part in series in a
  signal path lies along the path.
- A part between two rails (a filter resistor from VIN to AVIN) lies flat, both rail symbols
  pointing up.
- A voltage divider is one column: rail, upper resistor, the tap, lower resistor, ground. The tap
  goes sideways to the pin it feeds.
- An IC's inputs on the left, outputs on the right, supplies at the top, ground at the bottom, as far
  as its symbol allows.

### SCH.TEXT_OVERLAP: text is readable
level: warning

Reference designators, values, pin names, net labels and supply names do not overlap each other,
a part, or a wire of another net.

## Wires

### SCH.ORTHOGONAL: wires run horizontally and vertically
level: error

*(layout)* On the grid, no diagonals.

### SCH.DANGLING: every wire ends on a pin, a junction or another wire
level: error

*(layout)*

### SCH.JUNCTION_DOT: a T has a dot, a crossing has none
level: error

*(layout)* Three or more connections at a point get a junction dot. Wires that cross without a dot
are not connected.

### SCH.FOUR_WAY: no four-way junctions
level: warning

Two T-junctions offset by a grid step, never a cross with a dot: a dot can be missed in a copy, and
then the reader cannot tell a junction from a crossing.

### SCH.JOG: parts facing each other are in line
level: warning

Two pins that face each other on one wire (the resistors of a divider, a part in series) sit on one
line, so the wire is straight.

### SCH.DETOUR: no wire turns back the way it came
level: warning

### SCH.CROSSING: few crossings
level: info
param: max 0

Rearrange before crossing; the count is per net on the sheet. A crossing between blocks is fine; a
crossing inside a block usually means a part is on the wrong side.

### SCH.WIRE_THROUGH: no wire runs through a part or its text
level: error

- Few bends. A wire that bends where it could run straight is a sign of a part out of line.
- Wires do not run along each other closer than 100 mils, and not along a part's outline.

## Net labels

- Within a block, connect with wires. Between blocks, or across pages, use net labels, so long
  wires do not cross the sheet.
- A path the reader must follow to understand the circuit (feedback, a switch node, an analog
  signal) is a wire wherever practical, even if it is longer.
- Labels show direction: an input flag points into the part, an output flag away from it.
- Name nets for what they carry ("I2C_SDA", "VBAT_SENSE", "MOTOR_PWM"), not "NET12".

### SCH.LABEL_ALONE: a net label has a partner
level: warning

A net label that appears only once on the whole design connects nothing: either a wire is missing
or the label is not needed.

## Text

- Every part shows its reference designator and value, beside the part, on the same side for parts
  of one kind.
- Values in engineering notation with units where it helps ("10k", "100nF 50V", "4.7uH"), and a
  rating when it matters for the build.
- Notes on the sheet (test points, assembly hints) only where they help the reader of the drawing.
`;

/** The ids marked (layout) in the shipped ruleset: the layout follows them by itself, so a finding is a layout bug, not something an edit of the design fixes. */
export const LAYOUT_SCH_RULES: ReadonlySet<string> = new Set(Object.values(parseSchematicRules(SCHEMATIC_RULES).rules).filter((r) => r.layout).map((r) => r.id));

/** An open error the agent has to fix or waive before it finishes: not a layout bug, which it has no lever on. */
export const mustFix = (d: Diagnostic) => d.severity === 'error' && !d.waivedBy && !LAYOUT_SCH_RULES.has(d.code);
