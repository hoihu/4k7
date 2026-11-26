# Agent workflows: from operator to engineering team

> Part of the [roadmap](../ROADMAP.md) (track A, and the agent's part of tracks P and L). Status: proposal,
> 2026-11-26; nothing here is built unless it says so. [ai-loop](ai-loop.md) describes the loop as it is.

## 1. What the agent is today, and where that ends

Today the agent is an **operator**. The user asks, the agent calls ops, the kernel refuses what is wrong,
the checks run, the user reviews a changeset. That loop is sound and stays. Five things limit what the
user gets out of it:

1. **The agent knows the rules, not the purpose.** A turn may not end with open errors, but nothing holds
   what the board is for. A design that is clean and is not what was asked passes. (A brief asked for a
   USB-C connector, the agent fitted a pin header, every check was green.)
2. **The author checks its own work.** The model that misread a datasheet reads it the same way when it
   reviews.
3. **One answer.** The user sees the design the agent happened to arrive at, not the two it passed over.
4. **It stops at the files.** What happens on the bench never comes back into the design.
5. **The user steers op by op.** Either every changeset is reviewed or none is. There is nothing between.

The sections below take these in turn. What does not change:

- **The kernel is the truth.** Everything new is ops, queries and findings in the one catalogue
  ([ops-api](ops-api.md)); the app, the in-app agent and MCP get it together.
- **Unknown is said, never fine.** A requirement nobody verified, a block nobody could simulate and a
  review that did not run are shown as such.
- **Everything the agent changes is a changeset** the user can review and undo.
- **Any model, at the user's cost.** A feature must work with a middling model, say what it spends, and be
  switched off without breaking the rest.

## 2. Requirements: what the board is for (A1, A2)

A requirement is one thing the product must do, in the user's words, with how it is verified. Requirements
live in the design (`Design.requirements`) beside the ledger. The ledger says how the design is to be made
("C1 left of U1"); a requirement says what it must achieve.

```jsonc
{ "id": "rq_3",
  "text": "3.3 V for the radio, 500 mA, less than 30 mV ripple",   // the user's words
  "source": { "type": "user", "message": "m_12" },              // or "agent": assumed, see below
  "scope": { "nets": ["+3V3"] },                                // nets, parts, a block, a board, or the design
  "verify": [
    { "kind": "measure", "of": "net.max_current", "net": "+3V3", "min": 0.5 },
    { "kind": "check",   "code": "DRC.IR_DROP", "nets": ["+3V3"] },   // holds while that check has no open finding there
    { "kind": "sim",     "bench": "tb_3v3_ripple" }                   // P4
  ] }
```

| Verifier | Holds when | Example |
|---|---|---|
| `part` | A fitted part of a category with given parameters exists | "USB-C": a connector whose card says USB-C receptacle |
| `measure` | A value of the scorecard or of a query is inside a range | board at most 40 × 30 mm; order cost under 8 CHF at 100 pieces; 2 layers |
| `check` | A named check has no open finding in the scope | no `SEM.ABS_MAX` on the input stage |
| `calc` | A calculator's result on the design's values is inside a range | the divider gives 3.3 V ±2 % with its tolerances (P1) |
| `sim` | A stored bench passes | ripple, start-up time, phase margin (P4) |
| `manual` | The user ticked it | "the button feels right in the housing" |

The status is worked out, not stored (through `derive.ts`, like every other result): `verified` when every
verifier holds, `violated` when one fails, `unverified` when there is no verifier or one cannot be evaluated
(no current set, no model). Stored are only a manual tick and whether an assumed requirement was confirmed.

- **The agent writes them down first.** At the start of a turn it turns the brief into requirements with
  `require`, as it turns hints into ledger entries, and the user sees them as chips to accept, edit or drop.
- **Assumptions are marked.** Where the brief is silent and the agent decides (the input is 5 V from USB),
  the requirement's source is `agent`. It is listed as assumed until the user confirms it.
- **`propose` knows them.** A violated requirement refuses the proposal as an open error does, unless it is
  waived with a reason. Unverified ones do not block; the changeset card lists them ("3 of 9 not verified").
- **Findings.** `REQ.VIOLATED` (error) and `REQ.UNVERIFIED` (info) appear in the Issues list with the
  requirement's text.
- **The design document** gets a table: each requirement, how it was verified, by which check or bench.

This is where simulation, tolerance analysis, cost and size meet: each is a way to verify a requirement,
and the table says how much of the product's purpose has been checked by something other than the model's
own opinion.

## 3. Reviewers: a second pair of eyes (A3–A5)

A reviewer is a second run of an agent: a fresh context, a narrow task, read-only tools, and one tool to
report with. It does not edit. What it reports are findings in the same list as the kernel's.

```jsonc
// report_finding
{ "code": "REV.DATASHEET", "severity": "warning",
  "entities": ["U1.9", "D2", "R7"],
  "message": "GPIO9 is a strapping pin read at reset; D2 and R7 pull it low, so the module starts in download mode.",
  "evidence": [ { "kind": "datasheet", "part": "espressif:ESP32-C3-MINI-1", "page": 9 },
                { "kind": "query", "query": { "op": "get_net", "net": "LED" } } ],
  "fix_hints": [ { "op": "swap_pins", "a": "U1.GPIO9", "b": "U1.GPIO5" } ] }
```

- **Grounded or refused.** The kernel refuses a finding that names an entity the design does not have or
  that carries no evidence. Evidence is a datasheet page of a part in the design, a query the app can run
  again, a calculator result, or a picture the reviewer was shown. The user can open each.
- **Kept per block.** A finding is stored with the fingerprint of the functional block it is about (the
  block's parts, values and nets in canonical form). When the block changes the finding is stale and is
  dropped; the reviewer runs again for that block only. An unchanged block is never reviewed twice, which
  keeps the cost in hand.
- **Waived like anything else**, with a reason, by `add_waiver`.
- **A scout for checks.** A reviewer finding that recurs and can be decided from the design's data becomes
  a kernel check (`SEM.*`, `XCHK.*`), which costs nothing and is never forgotten. Strapping pins are a
  candidate: a field on the part card and a check.

| Reviewer | Reads | Asks | Package |
|---|---|---|---|
| Brief | The requirements, the conversation, the design by queries | Was what was asked for built? What was dropped or swapped on the way? | A3 |
| Datasheet | One IC's datasheet and its block | Is every pin used as the datasheet allows? Does the circuit follow the application circuit, and where it does not, why? What does the layout section ask for? | A4 |
| Risk | Connectors, supplies, reset and boot | What happens with the supply reversed, a cable plugged in live, inputs floating at reset, a discharge into a connector? | A5 |
| Bench | Power tree, test points, programming access | Can each rail be measured and powered on its own? Can the MCU be programmed and reset on the bare board? | A5 |
| Assembly | The production files as pictures, the stock check | Would an assembler ask a question about this board? | later |

**Layout advice becomes constraints.** The datasheet reviewer's second job: a layout section says "place
the input capacitor as close as possible to VIN and GND" or "keep the feedback trace away from the
inductor". Each becomes a ledger entry (`near`, a room, a keep-out, `route_first`) whose source is the
datasheet page. From then on the placer honours it and the checks hold it, on every later layout.

**Who runs it.** With a coding agent behind the app's chat, the local server starts the reviewer as another
headless run with the read-only tools; the harness that does this for the chat and for the eval exists. With
an API key, the tab runs a second loop. An external agent over MCP is handed the reviewer's task and scope
by a `review` tool and runs it as a subagent if it has them; findings come back through `report_finding`
either way. Where the user has two models, the reviewer should not be the author's.

**When.** At gates (§5) and on request, not after every change. Each run says what it cost.

## 4. Explorations: variants instead of one answer (A6)

The kernel is deterministic and runs without a browser; `try_placements` already places and trial-routes
arrangements on a copy of the design in a worker. An exploration extends that from placements to any ops:

```jsonc
// design_query explore: read-only, nothing is committed
{ "variants": [
    { "name": "LDO",  "ops": [ /* add_part, connect, … */ ] },
    { "name": "Buck", "ops": [ /* … */ ] } ],
  "upto": "routed", "budget_s": 60 }
```

Each variant is the open design plus a list of ops, applied to a copy in a worker, placed, and routed
within the budget. The answer is a scorecard per variant (Q1) with the status of every requirement, and a
picture of each board. The agent writes a variant as ops, which is cheap in tokens; the work is done on the
user's computer.

The user sees a card with a column per variant:

| | LDO | Buck |
|---|---|---|
| Requirements verified | 7 of 9 (heat violated) | 9 of 9 |
| Order cost, 10 boards | 41 $ | 47 $ |
| Board | 30 × 20 mm, 2 layers | 34 × 22 mm, 2 layers |
| Hottest part | U2: 0.85 W of 0.29 W | none |
| BOM lines | 11 | 15 |

Choosing a column makes its ops an ordinary transaction: dry run, changeset, review, undo. The others are
dropped, or kept as files beside the project (`lamp~ldo.twd.json`) that the diff (X7) can compare. There is
no branch model beyond that: a branch is a file.

What it is for: regulator topology, 2 or 4 layers, one board or two, connector on which edge, which house,
which of three microcontrollers. The agent is told (in its guide) to explore whenever it would otherwise
ask the user a question whose answer depends on numbers it can work out.

## 5. Gates and the decision queue (A7)

Between "review every changeset" and "autopilot" there is the way engineers work with each other: agree the
plan, meet at milestones, decide what was left open.

- **The plan is kept.** The plan step exists for terminal agents. It comes to the in-app agent too, its
  steps are tracked through the run, and each proposal is linked to the step it carries out.
- **Five gates**: architecture (blocks, power tree, main parts), schematic, placement, routing, files. At a
  gate the agent stops and posts one card: the scorecard and what changed since the last gate, every
  requirement's status, the reviewers' findings, the assumptions it made, the questions waiting.
- **A third mode, Gates**, beside Review and Auto: changesets commit as they pass the checks, and the run
  stops at each gate. Auto runs through all gates and never exports or orders by itself.
- **Questions that do not block.** `ask_user` stops the run today. A question may instead carry a default:
  the agent goes on with the default, records it as an assumed requirement (§2), and the question waits in
  a queue. Answered differently later, the requirement changes, its status turns, and the ordinary loop
  repairs the design. A question with no sensible default still blocks.
- **A budget.** A run has a limit in time and tokens, shown as it is used; at the limit it stops at the
  next gate with what it has.

With this a board can be started in the evening and stand at the placement gate in the morning, with three
questions and a comparison waiting, instead of a finished board built on a wrong guess.

## 6. Explain (A8)

`design_query explain { ref }` answers "why is this here, and why this value?" for a part, a value, a net's
attribute or a constraint, from what the design already records and what §2 and §3 add: the requirement it
serves, the datasheet page a value was taken from (part cards carry provenance), the calculator call that
gave it (to be recorded with the op), the ledger entry and its message, the reviewer finding that led to it.
In the Inspector it is a "Why" section. Where nothing is recorded it says so. It makes the review of a
changeset quicker and is the thing a user learns from.

## 7. Hints beyond chat (A9)

The canvas is for pointing and hinting ([ARCHITECTURE](../ARCHITECTURE.md) §3.4). Three more gestures, each
ending in ops the kernel checks, none of them a drawing tool:

- **A sketched stroke** on the board, started at a pad: the points of a `draw_track` laid for the router,
  which lays it properly or says what is in the way.
- **A drawn rectangle** with a word: a room for a block ("analogue here") or a keep-out.
- **A pinned note** on the schematic or the board: a task for the agent, with the place as its reference.
  Notes are worked through as a list and ticked off in the changeset that deals with them.

## 8. After the files: bench, revisions, firmware (L1–L5)

The design is not finished when the Gerbers are written, and the agent should not be either.

- **Firmware (L1).** The pin map (pull request #260) becomes a C header and a devicetree overlay. A coding
  agent that drives 4k7 over MCP often has the firmware repository open as well, which no other PCB tool's
  agent has. Its guide tells it to read how the firmware uses a pin before it proposes a swap (and to set
  the net's `needs`), and to regenerate the header in the turn in which the swap is accepted. It can write a
  bring-up sketch from the pin map: toggle each output, scan each bus.
- **Bring-up session (L2).** The bring-up sheet becomes a session in the app. The user types what they
  measure, or attaches a photo of the meter or the scope. The agent holds each value against what the power
  tree, the current check and the benches expect, and where it is off works through the causes with the
  user. The outcome is an erratum in the design: what was seen, the cause, the rework on this board, the
  change for the next.
- **Revisions (L3).** Ordering marks the design as a revision with its fingerprint. Rev B is a run that
  starts from the open errata, and the document lists what changed since rev A.
- **Proven blocks (L4).** `import_block` reuses a block of another project. With L2 a block also knows
  whether its board was built and worked. The agent searches the blocks of all projects and prefers a proven
  one over a new design from the datasheet. This is how recipes come about: from the user's own boards.
- **House rules (L5).** The user's notes (schematic, layout, enclosure) already travel with every message.
  When the user corrects the same kind of thing a second time, the app offers the note.

## 9. Runs while the user is away (A10)

The eval's headless server answers the agent's tools from a kernel without a browser tab. The same serves
jobs started from the command line or a scheduler, each on one project file, each ending in a proposal that
waits until the project is opened:

- the stock check again, with replacements proposed for what went out of stock or obsolete;
- every check again after 4k7 was updated, with what is new (which also tells the project where a release
  changed behaviour);
- a cost or size pass with a budget.

Nothing a background run produces is committed without the user.

## 10. A design with all of it

A dynamo bicycle lamp, as an example. The user describes it in a paragraph. The agent answers with nine
requirements, two of them assumed (the dynamo's open-circuit voltage, the standlight time), and a plan. At
the architecture gate it shows two explored variants for the LED driver with cost, size and heat, and a
question about the standlight that it has answered provisionally. The user picks the buck, corrects the
standlight to four minutes; the supercapacitor requirement turns red and the agent resizes it. At the
schematic gate the datasheet reviewer has turned the driver's layout section into four constraints and
found the dimming input left floating, which the datasheet forbids; the risk reviewer asks what happens when the dynamo runs with the LED
unplugged. Two benches verify the LED current over the dynamo's range. Placement and routing run through;
the files gate shows nine of nine requirements, one by the user's tick. Three weeks later the board is on
the bench: the standlight lasts three minutes, the session finds the capacitor's tolerance, and the erratum
starts rev B. The driver block is now marked as proven for the next lamp.

## 11. Open questions

- Requirements against ledger: is a `param` constraint ("make C1 100 µF") a requirement or a hint? Proposed:
  it stays in the ledger; a requirement is about behaviour.
- How a `part` verifier names what it wants without a taxonomy of parts. Proposed: the card's category plus
  parameters the datasheet import already fills (connector type, interface).
- Whether a reviewer in an external agent's own session is independent enough to be called a review.
- How many gates a small board needs. Proposed: the agent merges gates for designs under about 20 parts.
- What an exploration costs on a large board, and whether variants should share a routed base.
- Where errata and measurements live: in the design file, so they travel with it. Photos count towards the
  conversation's size limit.
