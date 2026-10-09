# UI concept

> Part of the [architecture](../ARCHITECTURE.md). Status: decided direction, 2026-09-25.
> Prototype: [`docs/ui/prototype.html`](../ui/prototype.html) · Earlier exploration: [`docs/ui/proposals.html`](../ui/proposals.html)

## 1. Decisions

| Workspace | Based on | Why |
|---|---|---|
| **Schematic** | Proposal **A** (conversation-first) **+ C** (review cockpit) merged | Schematic work is conversation-heavy, and every AI change must be reviewable. The review happens inline, not in a separate screen |
| **Layout** | Proposal **B** (canvas-first + command bar) | Board work needs the whole screen. Hints are given where the user is looking |
| **Parts** | Ingest review | Library list, datasheet with source highlights, and extracted fields side by side |
| **Settings** | — | Providers, model roles, MCP servers, relay, budget |

All workspaces share the same top bar, the same issues/ledger/history data, and the same changeset
model. Only the arrangement differs.

## 2. Density rules

Screen space belongs to the design. Chrome has to earn its pixels.

1. **One-line rows.** Issues, ledger entries, history and changeset items are single rows of ~28 px
   (`--row`). Details (codes, fix hints, actions) expand on click. Nothing shows a paragraph by default.
2. **No fixed review panel.** A pending changeset shows (a) as a compact card inside the chat
   message that produced it, and (b) as a slim floating bar on the canvas. When there's nothing to
   review, it takes zero space.
3. **One inspector, tabbed.** Issues · Ledger · History · Selection share one 280 px column in the
   schematic, and one closable drawer in layout.
4. **Floating over docked.** Layout controls (layers, activity, DRC chip, hint popover, command bar,
   minimap) float on the canvas instead of taking columns.
5. **Collapsible chat.** The chat column collapses to a button, giving a full-width canvas.
6. **Counts, not cards.** The top bar shows `● 0 ● 2` (errors, warnings) instead of a diagnostics panel.
   Changesets show `−1 +1` deltas as numbers.
7. **Tool calls are collapsed** into one summary line ("9 tool calls · 1 refused, fixed").
8. **Base font 13 px, UI chrome 11–12 px, monospace for design identifiers** (refdes, nets, constraints).
9. **Phones:** the schematic's three panes become bottom tabs (Agent · Canvas · Issues). Layout
   drops the minimap, layer list and popover and keeps the command bar.

## 3. Schematic workspace (A + C)

```
┌ top bar: project · Schematic | Layout | Parts | Settings ········· ●0 ●2 · Auto|Review|Step · model $ · ◐ ┐
├──────────── chat 300 ───────────┬──────────────── canvas ─────────────────┬── inspector 280 ──┤
│ user / agent messages           │ [Power|MCU|USB +]   [#7 pending ✓ ✕]    │ Issues|Ledger|…   │
│ plan (checklist)                │                                         │ W C2 ripple…    › │
│ ▸ 9 tool calls                  │          schematic + ghost diff         │ W EN floating   › │
│ ┌ #7 Complete 3V3 buck  −1 +1 ┐ │                                         │                   │
│ │ + C4 100nF BOOT–PH     ✓ ✕  │ │   hover a change row → highlighted here │                   │
│ │ ~ R2 10k→10.2k         ✓ ✕  │ │                                         │                   │
│ └ [Accept 5] [Reject]  {}ops  ┘ │                                         │                   │
│ @C2 · [ask or hint…]  ↵         │ status: click=ref · lasso · drag=hint   │                   │
└─────────────────────────────────┴─────────────────────────────────────────┴───────────────────┘
```

- **Referencing:** click/lasso on the canvas adds `@C2`-style chips to the composer.
- **Hints:** suggestions under the composer and in the Selection tab become ledger entries after
  confirmation (shown as dashed chips in the chat).
- **Review:** ✓/✕ per change, and hovering highlights the change on the canvas. Accept/Reject in the
  card or in the canvas bar. The diff overlay can be toggled.
- **Questions** from the agent come as option buttons, not free text.

## 4. Layout workspace (B)

- Full-bleed board. Floating: layer list (top-left), agent activity (top-center), DRC chip (top-right,
  opens the inspector drawer), hint popover next to the selection, minimap, and the command bar (bottom).
- The **command bar is the chat** for layout. Above it, a slim strip shows the pending changeset.
  Below it, the parser preview shows the constraints the text will create before sending.
- **Drag = hint.** Dragging a part doesn't move it for good. It produces a `place(C2) ≈ Δ(x, y) · soft`
  constraint that shows up in the preview and goes into the ledger when sent.
- The full chat history for layout is still available (activity ≡ log), but hidden by default.

## 5. Open UI questions

- Keyboard model: ⌘K everywhere, plus `a`/`r` for accept/reject and `j`/`k` to walk change rows?
- Multi-sheet navigation for large designs (100+ parts): a block diagram above the sheets? (Pages are derived: the layout flows each sheet onto pages of the design's paper size (A4, A3 or A2), drawn in a grid on the canvas and printed with ⌘P. Sheets remain the user's manual grouping on top of that.)
- 3D view: a third canvas mode in Layout, or a separate workspace?
- How to show a *running* agent turn on the canvas without flicker (preview the dry-run diff progressively vs. show it once).
