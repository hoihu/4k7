# The scorecard

> Package Q1 of the [roadmap](../ROADMAP.md). Status: design, 2026-11-27; nothing here is built.

## 1. What it is for

Several things ask the same question, "how good is this design right now, in a few numbers", and each
counts for itself today: the eval's `scoreRun` counts errors and violated constraints, `get_summary` has the
finding counts, the changeset card has before and after counts. More are coming that need the same answer:
explorations compare variants by it (A6), a gate shows what changed since the last one (A7), the model table
reports it per run (Q3), a background run says what an upgrade changed (A10).

The scorecard is that one answer: small, the same for the same design, and with everything that could not
be judged said as such.

It is not a list of findings (`get_diagnostics` and `get_board` page those) and not a grade. It holds no
single number that sums the others up: which of cost, size and heat matters is the user's call.

## 2. The answer

```ts
// design_query get_scorecard — packages/schema/src/results.ts
export interface Scorecard {
  /** Open findings (not waived) by family: the code's part before the dot. Families with none are left out. */
  findings: Record<string, { errors: number; warnings: number; infos: number }>;
  waived: number;
  /** Open findings that say a check could not judge (the companions in CHECKS, spec.md §6), by code. */
  unknown: Record<string, number>;
  /** The spec's counts, when the design has one (spec.md §4). */
  spec?: { verified: number; violated: number; unverified: number; waived: number; assumed: number };
  ledger: { hard: number; soft: number; violated: number };
  parts: { fitted: number; dnp: number; cards: number };
  power: {
    rails: number;
    /** Rails whose loads and the rails they feed draw more than their max_current (the power tree's budget). */
    over: number;
    /** Rails with no voltage, no source or no budget that could be worked out. */
    unknown: number;
    /** Linear regulators above their package's limit, with the worst: "U2: 0.85 W of 0.29 W". */
    hot: { count: number; worst?: string };
  };
  boards: BoardScore[];
}

export interface BoardScore {
  id: string;
  name: string;
  width_mm: number;
  height_mm: number;
  /** Set by the user, or what the placer proposed. */
  size_by: 'user' | 'proposal';
  layers: number;
  parts: { top: number; bottom: number };
  /** none: never routed; stale: routed for an earlier placement. The fields below are absent unless done. */
  routing: 'none' | 'stale' | 'done';
  connections?: { total: number; open: number };
  track_mm?: number;
  vias?: number;
  /** The copper against its nets' currents: nets by status, and the worst ratio of current to capacity. */
  current?: { ok: number; over: number; unverified: number; unknown: number; worst?: { net: string; ratio: number } };
}
```

Where each field comes from, all of it existing:

| Field | From |
|---|---|
| `findings`, `waived` | `Kernel.diagnostics()` plus each routed board's `BoardView.diagnostics`, the two findings they share (`DRC.SHORT`, `DRC.CLEARANCE`) counted once |
| `unknown` | The same findings, those whose code is some check's `unknownWhen` in `CHECKS` |
| `spec` | `get_spec` |
| `ledger` | `Design.ledger` and `SchematicView.constraintStatus` |
| `parts` | `Design.components` (`dnp`; `padOnly` cards are neither fitted nor dnp) and the cards in use |
| `power` | `powerTreeAnswer` (`packages/kernel/src/powertree.ts`): `current.budget` and `dissipation.status` per rail |
| `boards[].width_mm … size_by` | `BoardView.outline`, `sizeBy`, `BoardSettings.layers` |
| `boards[].routing … vias` | `BoardView.routing`, `stats`, `unrouted` |
| `boards[].current` | `BoardView.current.nets` (`CurrentNet.status`, `worst`) |

A board that is not routed for its placement has no copper to judge. Its score says `routing` and stops;
nothing is filled in from an older routing. The scorecard never routes: like `get_diagnostics` it reads the
copper stored for the placement (`routedNow` in `kernel.ts`) and otherwise the placement.

**Rules for the answer.** Lengths in mm rounded to 0.01, ratios to 0.01. Keys in the order above, boards in
board order, families and codes sorted. No time, no version, nothing that differs between two runs on the
same design: two scorecards are compared as text. Remembered through `derive.ts`; `npm run test:derived`
recomputes it.

## 3. What the kernel cannot know

Two things belong on a scorecard and are worked out outside the kernel:

- **The production files' findings** (`FAB.*`): `packages/fab` reads the files back, in the app.
- **BOM lines and the order's cost**: `bomLines` is in `packages/fab`, and a cost needs the stock check's
  answer from a house (`packages/parts/src/cost.ts`), which is fetched.

So the scorecard has a second step, **Q1b**, when A6 needs it: `packages/fab` adds `files: { errors,
warnings }` and `bom_lines` per board from the board it is given (a function `withFiles(card, boards)`, so
the app, the eval and a background run add them the same way), and the app adds `order: { house, boards,
total, currency, checked }` from the last stock check when that check was made for this BOM, and nothing
otherwise. Both are optional fields of the same `Scorecard` type. A scorecard without them is complete for
what the kernel knows; it does not say the files are clean or the board is free.

## 4. Who reads it

- **The eval.** `scoreRun` (`packages/agent/eval/run.ts`) takes its error counts and constraint failures
  from the scorecard instead of counting, and `Score` carries the whole card, so the model table (Q3) can
  show board size, open connections and unknowns per run without new code.
- **The design document.** Its first page gets the card as a short table: findings, what could not be
  judged, each board's size, layers and routing.
- **Later, without changes here:** `explore` returns one per variant (A6), a gate shows the difference to
  the last gate's (A7), `4k7pcb run` stores one with each proposal (A10), the diff lists what moved (X7).

It is not added to the context of every turn: `get_summary` already gives the counts there, and the agent
asks for the card when it compares or reports.

## 5. Pull request

One, of the usual size:

- `Scorecard` and `BoardScore` in the schema, `get_scorecard` in `QueryOp` and in [ops-api](ops-api.md) §2
  (the `ops-doc` test), the answer in a new `packages/kernel/src/scorecard.ts`.
- `CHECKS` (spec.md §6) if A1 has not landed it yet: the scorecard needs only its `unknownWhen`, so whichever
  of the two packages comes first brings the list and its test.
- `scoreRun` reads it. The design document's table.
- Tests: an empty design; a design with a spec, a waiver and a violated constraint; a board not routed,
  stale and routed; two boards; the same design twice gives the same text.
- CHANGELOG: one entry, for the table in the design document.
