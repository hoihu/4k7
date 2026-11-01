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

**A finding is not an issue** (2026-11-01). A check says how a schematic reads, not whether the
circuit is right: a wire can run any number of ways and the design stays the same. So findings on
the drawing (`drawingFinding`: `SCH.*`, and `LEDGER.PLACEMENT`, a placement that could not be kept)
stay out of the Inspector's Issues and out of the errors, warnings and infos of `DiagnosticCounts`,
which is what the top bar, a changeset and the design document show; they count as `drawing`. The
agent gets all of them as before: its context lists the issues first, then the findings, and the
turn's review and Optimize work on them. What the user made their own stays an issue: a check they
set to Must fix, a placement they fixed hard. The four `layout` checks are shipped at Must fix only
because the layout follows them by itself, so a finding there stays on the drawing's side.

On the user's 124-part design the list went from 42 entries to 2 (a package mismatch, unused I/O
pins). `SCH.JOG` looks only at a wire's shape as well, and fires on two big ICs whose pins are not
level. That now reaches only the agent, so it was left as it is.

Both are kept with the browser's settings, so they apply to every project opened there.

**Earlier versions** stored one markdown text with `### SCH.ID: title` headings and `level:` /
`param:` lines. `migrateRulesText` turns it into check settings plus notes (the prose without ids
and level lines); a copy whose prose is the old default's leaves no notes (recognised by a hash,
fixture `packages/kernel/test/old-schematic-rules.md`).
