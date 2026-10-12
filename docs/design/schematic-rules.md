# Schematic rules

> Part of [schematic-drawing.md](schematic-drawing.md) §3. Built 2026-10-12.

The default ruleset lives in code: `packages/schema/src/rules.ts` exports `SCHEMATIC_RULES`, the
markdown text, and `parseSchematicRules`, which splits it into guidance for the agent and the rules
the kernel checks. That file is the authoritative copy; edit the ruleset there. (It is a template
literal rather than an `.md` file because the local server runs from TS directly.)

How the text works: prose is guidance for the agent, sent as a `<drawing_rules>` block with its
design context. A `### SCH.ID: title` heading with a `level:` line is a rule the kernel checks
(`error`, `warning`, `info` or `off`; a `param:` line sets a threshold), reported as an `SCH.*`
diagnostic with that level. Rules marked *(layout)* the auto-layout follows by itself. The ids the
kernel has a check for are listed in `CHECKED_SCH_RULES`; any other heading is guidance only.

A user edits their own copy in Settings → Schematic rules: the editor shows the default until it is
changed, "Reset to default" goes back, and the copy is kept with the browser's settings, so it
applies to every project opened there.
