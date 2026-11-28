# The spec: what the board is for

> Packages A1 and A2 of the [roadmap](../ROADMAP.md). Status: design, 2026-11-27. Built: the kernel part
> (§11 item 1: the data, the ops, the status, the findings, `get_spec`); the gate in `propose`, the agent's
> part and the app follow.
> The idea and where it leads are in [agent-workflows](agent-workflows.md) §2; this is what to build first.

## 1. Why

A turn may not end with open errors, but nothing in the design says what the board is for. A brief asked
for a USB-C connector, the agent fitted a pin header, every check was green and the changeset was proposed
as done. The ledger does not help: it holds how the design is to be made ("C1 left of U1", "C1 = 100 µF"),
not what it must achieve.

The spec is that record: a list of things the product must do, each with how the kernel can tell.

**The name.** "Requirement" is taken. A part card's `requirements` are what a part needs from its circuit
(a decoupling capacitor, a pull-up), checked by `SEM.REQUIREMENT`. What the product must do is the **spec**,
its entries are **spec items**, and the code, the ops and the findings say `spec` throughout.

## 2. Data

`Design.spec?: Record<string, SpecItem>`, by id, beside `ledger` and `waivers`. Absent: no spec; removing
the last item removes the field, so a design without a spec is the same as before. No change of format
number: the field is optional and an older design simply has none. A build without this field keeps it
when it saves: the kernel works on copies of the whole design and the server writes it as it gets it
(`tools/server/src/storage.ts`), so an older build carries the items along unchanged.

```ts
// packages/schema/src/model.ts
export interface SpecItem {
  /** nextId(d, 'q'): "q_1a". */
  id: string;
  /** What the product must do, one testable statement, in the user's words where they said it. */
  text: string;
  /**
   * Who said it, as a ledger entry's source: the user (with the words of their message, where the agent
   * wrote it down for them), or the agent, which decided it because the user left it open (the input is
   * 5 V from USB). An agent's item is an assumption until the user confirms it.
   */
  source: { type: 'user' | 'agent'; quote?: string };
  /** How it is verified. None: unverified. */
  verify: SpecVerifier[];
}

export type SpecVerifier =
  | { kind: 'part'; category?: PartCategory; pins?: string[]; text?: string[]; min?: number; max?: number; board?: string }
  | { kind: 'measure'; of: SpecMeasure; net?: string; board?: string; min?: number; max?: number }
  | { kind: 'check'; code: string; entities?: string[] }
  | { kind: 'manual'; done?: true; note?: string };

export type SpecMeasure =
  | 'board.width_mm' | 'board.height_mm' | 'board.layers' | 'board.open_connections'
  | 'parts.fitted'
  | 'net.voltage' | 'net.max_current';
```

The source is set as `place` sets a position's (`boardops.ts`): an op of the user's is the user's; an op
of the agent's that carries the user's words in `quote` is the user's too; any other op of the agent's is
the agent's. An item is **assumed** while its source is the agent.

### Verifiers

Each verifier evaluates to **holds**, **fails** or **unknown**, with one sentence saying why.

**`part`**: a part that must be there (or must not). It counts the fitted components (not `dnp`, not
`padOnly`), on `board` if given, whose card matches everything stated:

- `category`: the card's category;
- `pins`: every name is the name of a pin of the card, or a word of one (any case: a pin `CC1_A5` counts as
  `CC1`). A USB-C receptacle is `{ category: 'connector', pins: ['CC1', 'CC2'] }`, which no pin header matches;
- `text`: one of the strings occurs in the card's id, MPN, title, description or package, or in the part's
  own `mpn` parameter (a generic diode with `mpn: B340A`), any case.

It holds when the count is between `min` (default 1) and `max` (default: no limit), and fails otherwise.
`{ max: 0, min: 0 }` says "none of these" (no electrolytic capacitors). At least one of `category`, `pins`
and `text` is required.

**`measure`**: a value inside a range. At least one of `min` and `max` is required.

| `of` | Value | Unknown when |
|---|---|---|
| `board.width_mm`, `board.height_mm` | The outline of the placed board (`BoardView.outline`) | never |
| `board.layers` | `BoardSettings.layers` | never |
| `board.open_connections` | `BoardView.unrouted.length` | the board is not routed for this placement (see below) |
| `parts.fitted` | Components that are not `dnp` and not `padOnly` | never |
| `net.voltage` | `NetAttrs.voltage` of `net` | it is not set |
| `net.max_current` | `NetAttrs.maxCurrent` of `net` | it is not set |

On a design of several boards a board measure without `board` is taken on every board and all must hold.
Nets and boards are named in the op and stored by id, as the ledger stores components, so a rename does not
break a verifier; when the net or board is removed the verifier is unknown and says so.
A `measure` of a net takes `net` and no `board`; the others take no `net`.
The net measures read what was declared, not what flows; their use is to tie a rail's declared numbers to
the user's words, so that the checks that work from them (`SEM.ABS_MAX`, the current checks, the power
tree) work from the right ones.

**`check`**: a named check finds nothing. It holds when no open (not waived) finding with exactly this
code names one of `entities` (without `entities`: anywhere). A finding names an entity when it lists it,
or a pin of it (`U1.EN` for `U1`). The entities are stored by id too (a part as its id, a net as
`net:<id>`), so a renamed part or net keeps the verifier working; one that is gone makes it unknown. Two
things keep "no finding" from being read as "checked":

- The code must be known. `packages/schema` gets a list of every check code (§6); a verifier naming a code
  that is not in it is rejected.
- A code of the board (`DRC.*`, `IMP.*`, `DRAW.*`, `PLANE.*`: the board DRC's) is unknown while that board is
  not routed for its placement: the boards of the parts and nets in `entities`, or every board. And
  where the list names a check's companion that says "could not judge" (`DRC.CURRENT_UNKNOWN` and
  `DRC.CURRENT_UNVERIFIED` for `DRC.TRACK_CURRENT` and `DRC.VIA_CURRENT`), the verifier is unknown while the
  companion is open on the same entities.

`FAB.*` and `PANEL.*` are not accepted: the app works them out from the production files, outside the
kernel, and `propose` refuses their errors already. `ENC.*` is not accepted either: the enclosure's
findings come from its render (`packages/fab`, in the app), which the kernel never sees, so a verifier on
them would hold whatever the enclosure does. `SPEC.*` is not accepted.

"Routed for its placement" is what the copper findings of `get_diagnostics` use (`routedNow` in
`kernel.ts`): the board as routed for this design in the session, or laid from the agent's drawn copper or
the copper stored for this placement (which routes nothing). The app stores the board worker's copper
with the design; after an edit that keeps the placement the stored copper still counts.

**`manual`**: the user's own tick. It holds when `done`. The user sets it in the app's Spec tab; the agent
can only pass on what the user said, with their words (§4).

### Status

Worked out, never stored:

| Status | When |
|---|---|
| `violated` | a verifier fails |
| `unverified` | no verifier fails, and there is none or one is unknown (a manual verifier not ticked is unknown) |
| `verified` | every verifier holds |
| `waived` | violated, and a waiver for `SPEC.VIOLATED` names the item |

Assumed is shown beside the status, whatever it is.

The status is a function of the design: the board's facts come from its placement and from the copper
stored for it, as the copper findings of `get_diagnostics` do today (`copperShorts` in `kernel.ts`). It is
remembered through `derive.ts` like every other result, and `npm run test:derived` covers it: `spec.ts`
first takes from the design and the kernel's results only what the verifiers read (`specFacts`: the
fitted parts, the outlines and open connections of the boards they measure, the findings with the codes
they name), and the status is worked out from the items, the waivers and those facts alone, remembered by
them. The spec is not an input of the drawing or the placement (`drawingInputs`, `boardInputs`): an item
changes neither.

## 3. Findings

| Code | Severity | Entities | Message |
|---|---|---|---|
| `SPEC.VIOLATED` | error | the item's id, then what the failing verifier names | the item's text, then why: `"USB-C connector": no fitted connector has pins CC1 and CC2` |
| `SPEC.UNVERIFIED` | info | the item's id | the text, then what is missing: `nothing verifies it`, or the unknown verifier's reason |
| `SPEC.ASSUMED` | info | the item's id | the text, then `assumed, not confirmed by the user` |

They are in the one list: `state().diagnostics`, `diagnostics()`, `get_diagnostics`, the Issues tab, the
counts, and a transaction's `introduced` and `resolved`. `add_waiver` waives `SPEC.VIOLATED` with a reason
like any other finding; a waiver for a `SPEC.*` code covers the item when its entities include the item's
id (the entities after the id are what the verifier found, and change with the design). A check verifier
reads the other findings only, never the spec's own.

`mustFix` (`packages/schema/src/rules.ts`) leaves `SPEC.*` out, as it leaves out the schematic's layout rules. A
violated item does not make the design wrong in itself: a design built in steps violates most of its spec
until the last step. What it must never do is pass unsaid, which is §5's job.

## 4. Ops and queries

Two ops and one query, defined in `packages/schema/src/ops.ts` like the rest, applied in a new
`packages/kernel/src/specops.ts`, listed in [ops-api](ops-api.md) §2 under a new group "Spec" in the same
pull request (the test `ops-doc.test.ts` fails otherwise).

```ts
export const SpecifyOp = z.object({
  op: z.literal('specify'),
  id: z.string().optional().describe('An existing item to change (only the fields given); without it a new item'),
  text: z.string().min(3).optional().describe('What the product must do: one statement that can be true or false. Required for a new item'),
  quote: z.string().optional().describe("The user's words it comes from. Without it the item is yours: an assumption the user is asked to confirm"),
  verify: z.array(SpecVerifier).optional().describe('How the kernel can tell; replaces the item\'s verifiers'),
  done: z.boolean().optional().describe('The item\'s manual verifier: the user says it holds (true) or no longer does (false). From you only with the user\'s words in quote'),
});

export const RemoveSpecOp = z.object({
  op: z.literal('remove_spec'),
  id: z.string(),
  quote: z.string().optional().describe("The user's words that drop it; required from you for an item of the user's"),
});
```

- `specify` without `id` adds an item and answers with its id and its status as it stands (worked out
  after the whole transaction, in the effect: `now violated: …`); with `id` it changes the item. Rejections: an unknown id (`REF_UNKNOWN`, with the ids there are), an unknown net or
  board in a verifier (`NET_UNKNOWN`, `REF_UNKNOWN`), a part in a check's `entities` that is not there
  (`REF_UNKNOWN`), an unknown or unaccepted code, a `measure` with no bound, or with `min` above `max`, a
  `part` with nothing to match, `done` on an item without a manual verifier (all `INVALID_OP`, the message
  saying what to do).
- Confirming an assumed item is `specify` with its id: from the user (the Spec tab) it becomes theirs; from
  the agent only with `quote`, the user's words that confirm it. The same holds for `done`: the agent's
  `specify … done` without `quote` is rejected, and so is a manual verifier with `done` in its `verify`
  that the item did not have. The agent may change its own assumptions freely; they stay assumed.
- A user's item is the user's to change. Without `quote` the agent may only add verifiers to it (the new
  list holds every verifier it had, unchanged); a changed text, or a verifier changed or dropped, is
  rejected with the message to ask the user. The app sends the user's own edits through the same ops, as
  it does for every other edit.
- `remove_spec` removes the item and the waivers that name it. From the agent, an item of the user's goes
  only with `quote`; its own assumptions it may drop.
- A changeset shows spec items as hunks of a new kind `spec` (`HunkKind` in `results.ts`), titled "spec:
  USB-C connector" with the change (add, change, remove) beside it as for every hunk, the verifiers in
  words as details, then the user's quote or "assumed". The user accepts or rejects them one by one as
  any hunk.

```ts
// design_query get_spec
z.object({ op: z.literal('get_spec') })

interface SpecAnswer {
  counts: { verified: number; violated: number; unverified: number; waived: number; assumed: number };
  items: {
    id: string; text: string; source: SpecItem['source']; assumed: boolean;
    status: 'verified' | 'violated' | 'unverified' | 'waived';
    verify: (SpecVerifier & { result: 'holds' | 'fails' | 'unknown'; why: string })[];
  }[];
}
```

`get_summary` gets the same `counts` as `spec` when the design has one. `state()` carries the answer for
the app (`spec`, null without one). The verifiers in the answer name nets, boards and parts by their names
now. `get_spec` on a design without a spec answers empty counts and items, with a hint to write one.

## 5. `propose`

`propose` is answered by the app (`apps/web/src/lib/app.svelte.ts`) and by the eval's headless server
(`packages/agent/eval/headless.ts`). Both get the same new gate, after the open errors and before the
board's:

- `ProposeInput` gets `spec_open`: "Only if spec items are still violated: which, and why (this changeset
  is one step of the plan and they come later, or you could not meet them and what the user could decide).
  Without it propose refuses while a spec item is violated."
- With a violated item and no `spec_open`, `propose` is refused with the list, as it is for open
  connections without `open_connections`.
- The changeset card shows the spec line whenever the design has a spec: `Spec: 7 of 9 verified · 1
  violated · 1 unverified · 2 assumed`, the violated ones by name, and the agent's `spec_open` text under it.

So a brief that is not met can still be proposed, but not as if it were met. In Auto mode a changeset with
`spec_open` commits as today and the line stays in the conversation.

This refines decision D4 of the roadmap: a violated item blocks `propose` unless it is waived or the agent
says so in `spec_open`.

## 6. The list of checks

New, in `packages/schema/src/rules.ts` (or a file beside it): every check code the kernel and `packages/fab`
can report, with its family and, where it has one, the companion that says the check could not judge.

```ts
export const CHECKS: Record<string, { unknownWhen?: string[] }> = {
  'DRC.TRACK_CURRENT': { unknownWhen: ['DRC.CURRENT_UNKNOWN', 'DRC.CURRENT_UNVERIFIED'] },
  'DRC.VIA_CURRENT':   { unknownWhen: ['DRC.CURRENT_UNKNOWN', 'DRC.CURRENT_UNVERIFIED'] },
  'SEM.ABS_MAX': {},
  // … every code
};
```

A test in the manner of `ops-doc.test.ts` reads the code literals out of the sources of `packages/kernel`,
`packages/schema` and `packages/fab` (`'ERC.…'`, `'SEM.…'`, `'XCHK.…'`, `'SCH.…'`, `'LEDGER.…'`, `'DRC.…'`,
`'IMP.…'`, `'FAB.…'`, `'PANEL.…'`, `'ASM.…'`, `'SPEC.…'`) and fails when a code is reported that the list
does not have, or listed that nothing reports. The [scorecard](scorecard.md) uses the same list.

## 7. The app

- **A Spec tab** in the inspector beside Issues · Ledger · History · Selection ([ui](ui.md)): one row per
  item with its status, its text and "assumed" where it is. A row opens to the verifiers, each with its
  result and why. The user adds an item (text only: it starts unverified, and the agent gives it verifiers
  on its next turn), edits the text, ticks a manual verifier, confirms an assumption, removes an item.
- **The changeset card**: §5.
- **The design document**: a table after the description: item, status, how it was verified (the check or
  measure in words). Unverified and assumed items are printed as such.
- **The agent's context** (`formatDesignContext` in `packages/agent/src/prompt.ts`): after the diagnostics, a
  line `spec: 9 items, 7 verified, 1 violated, 1 unverified, 2 assumed` (with `1 waived` before `assumed`
  when there are waived items) and one line per item that is not verified: its id, text and why. The
  `SPEC.*` findings are then left out of the diagnostics listed above it, which say the same.

## 8. The agent (A2)

Added to `DESIGN_GUIDE` (`packages/schema/src/guide.ts`), written to the agent as that file is:

```text
The spec:
- What the product must do goes into the spec; how the user wants it made goes into the ledger. "A USB-C
  input", "3.3 V at 500 mA for the radio", "no larger than 40 × 30 mm", "two layers" are spec items
  (design_edit specify). "Put J1 on the left edge" and "make C1 100 µF" are hints (constrain).
- When a message says what to build, write its spec items before you design, in the first transaction: one
  item per statement that can be true or false, the user's words in quote. Do not merge two statements
  into one item and do not leave one out because it is obvious.
- Give each item the verifiers the kernel can evaluate (part, measure, check). Write the verifier from the
  user's words, before you choose the part: a USB-C input is a connector with pins CC1 and CC2, whatever
  you fit later. An item nothing can verify yet (a ripple, a cost, how it feels) gets no verifier and
  stays unverified: that is honest, a verifier that cannot fail is not.
- Where the message leaves open something you have to decide to go on (the supply voltage, the current a
  rail must give), decide, write it as an item without quote (it is then marked as assumed), and say so in
  your message. Do not ask for each one. When the user confirms it, specify it again with their words.
- Never remove or weaken an item the user stated, and never change its verifiers so that it passes, without
  asking: the kernel refuses such a change unless it carries the user's words. If an item cannot be met,
  say why and what they could decide.
- Before propose, design_query get_spec. A violated item is either fixed, or named in spec_open with the
  reason (a later step of the plan; cannot be met because …).
```

Built so far without the last bullet's `spec_open`: it waits for decision D4 (what a violated item does to
`propose`), and until then the guide says "Before propose, design_query get_spec. A violated item is either
fixed or named in your message with the reason."

## 9. The eval

`EvalTask.expect` gets `spec?: { text: string; verify: SpecVerifier[] }[]`: the brief's own items, written
by whoever wrote the task and evaluated on the design the run left, whatever the agent wrote into the
design's spec. `Score` gets `spec_failures` (the items that do not hold, into `failures`) and
`spec_written` (how many items the agent wrote, and how many of those are verified), so a run cannot pass
by writing a weak spec, and how well agents write specs can be read off the [model table](../ROADMAP.md) (Q3).

Two tasks come with A2: the LED board that asks for USB-C (scripted once with the pin header, which must
fail, and once right), and a brief that leaves the input voltage open (the run must leave an assumed item). A third, scripted,
tries to weaken a user's item without a quote and must be rejected.

## 10. Not in this step

| Later | With |
|---|---|
| `calc` verifiers: a divider's output with its tolerances | P1 |
| `sim` verifiers: a stored bench | P4 |
| Order cost and BOM lines as measures: they need the stock check's result, which the kernel does not have | the scorecard's second step |
| A reviewer that holds the conversation against the spec | A3 |
| Items scoped to a functional block, and `explain` from a part to the item it serves | A8 |

## 11. Pull requests

1. **Kernel.** `SpecItem` and the verifiers in the schema, `CHECKS` with its test, `specify` and
   `remove_spec`, the status, the three findings, `get_spec`, the counts in `get_summary`, the `spec` hunk,
   `ops-api.md` and `data-model.md`. Tests: each verifier's three results; a waiver; several boards; a
   design without a spec is untouched; `test:derived`.
2. **Agent.** The `spec_open` gate in the app and in the headless server, the context lines, the guide
   text, `EvalTask.expect.spec` and the two tasks. `ai-loop.md`.
3. **App.** The Spec tab, the changeset line, the table in the design document, the user's own edits.
   `ui.md`, CHANGELOG.
