# Schematic notes and checks

> Part of [schematic-drawing.md](schematic-drawing.md) §3. Built 2026-10-12 as one ruleset text; split into notes and checks 2026-10-13.

`packages/schema/src/rules.ts` holds both halves.

**Notes** (`Settings.schematicNotes`): the user's own words on how they want schematics drawn,
like a CLAUDE.md. Empty by default: the model knows how a schematic is drawn, and the user writes
down only what it gets wrong or what they like differently ("labels are always horizontal"). The
agent gets them as a `<schematic_notes>` block in its design context, and the guide says they win
over its own judgement. The box shows `SCHEMATIC_NOTES_PLACEHOLDER` while empty.

**Checks** (`Settings.schematicChecks`): the drawing rules the kernel measures, listed in
`SCHEMATIC_CHECKS` with a plain title and sentence for the Settings page, a shipped level and, for
crossings, a limit. The user picks a level per check (Must fix = `error`, Warn, Note, Off) and the
limit; only differences from the shipped values are stored (`changedChecks`), so a later default
change still reaches them. `resolveChecks` merges the two for the kernel (`Kernel.setChecks`), and
a finding is an `SCH.*` diagnostic at that level. Checks marked `layout` are drawn that way by the
auto-layout itself; their findings do not hold the agent back (`mustFix`).

Both are kept with the browser's settings, so they apply to every project opened there.

**Earlier versions** stored one markdown text with `### SCH.ID: title` headings and `level:` /
`param:` lines. `migrateRulesText` turns it into check settings plus notes (the prose without ids
and level lines); a copy whose prose is the old default's leaves no notes (recognised by a hash,
fixture `packages/kernel/test/old-schematic-rules.md`).
