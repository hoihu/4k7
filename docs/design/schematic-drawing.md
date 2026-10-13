# Drawing the schematic: the agent owns the drawing

> Part of the [architecture](../ARCHITECTURE.md). Status: draft. 2026-10-12: steps 1–3 of the first plan built (§6). 2026-10-13: the agent owns the whole drawing (§2a), notes and checks replace the ruleset text (§3), the stored drawing built (§6 step 2).
> Notes and checks are in `packages/schema/src/rules.ts` (see [schematic-rules.md](schematic-rules.md)).

## 1. Why

The schematic auto-layout (`packages/kernel/src/layout.ts`) draws every sheet by itself from the
netlist. It is fast and always correct, but every drawing decision is a hard-coded rule, and a rule
written for one circuit misfires on the next. Three cases from one TPS40222 buck, 2026-10-12:

- A feedback divider was drawn as two columns side by side with a jog between them. The fix was one
  more rule in the satellite code.
- The VIN and AVIN rail symbols on PVIN and AVIN stood upright across the FB and SW wires above
  them, with their names on the IC's value text. Optimize saw it and could not fix it: the agent
  has no lever on supply symbols.
- The next hard-coded fix laid those symbols sideways so they crossed nothing. The user rejected
  it: **a rail points up and ground points down, always; that matters more than a crossing.**

The third case is the point. Which of two imperfect drawings is better is a judgement, and the
judgement depends on the circuit and on the user's taste. Hard-coding it gives one answer for
everyone. The agent knows the circuit (it often built it) and can be told the user's taste.

## 2. The split

The agent decides **where parts go**. The kernel decides **where every line goes**.

| | Agent | Kernel |
|---|---|---|
| Owns | Placement: where a part stands on a page (`place_symbol`), or lighter, the order of parts (`left_of` …), orientation, which side a symbol goes, wire or label | Geometry of everything else: the parts nobody placed, wire paths, junction dots, text positions, pages |
| Says it as | Ledger entries: `sch_position` (page, centre in mils) and soft drawing hints | Deterministic layout from netlist + ledger + ruleset |
| Checked by | Diagnostics from the ruleset's checks, the measures, a picture, `get_schematic` | Tests |

First drafted as "the agent never gives coordinates". A session on 2026-10-12 showed why that was
too little: asked to make a drawing look like the original, the agent tried four relative
constraints on a connector and the layout ignored every one (a connector column overrode the
order, a constraint was read backwards, the row wrapped). The user's decision: the agent has the
authority to say where components go; the editor wires them up. So, as for the board (`place`):

- **`place_symbol`** pins a part's symbol centre on a page (mils from the paper's top-left, snapped
  to the 100-mil grid). An IC or connector takes the small parts at its pins with it, still wired;
  a two-pin part placed on its own stands apart, connected by labels until the router (§5) wires
  it. The layout flows every part nobody placed around the placed ones.
- **`get_schematic`** tells the agent each page's paper and where every symbol stands, so it can
  place by reading, not by guessing from a picture.
- **Relative constraints stay** the lighter lever, and now do what they say: the subject moves, a
  connector they order keeps its place in its row, and a violated one says why (the row wrapped,
  another page) and points to `place_symbol`.

What the kernel keeps, and why: wires (the agent places, the editor connects), and the layout of
everything not placed, so a new part still lands somewhere sensible without a model call, the same
circuit draws the same way, and a sheet is drawn without an API key.

## 2a. Decision 2026-10-13: the netlist is the truth, the drawing is the agent's

`place_symbol` was not enough. Asked to make the labels horizontal, or to draw the sense lines of a
current-sense amplifier as wires, the agent could do neither: the layout decides where a connection
becomes a net label and which way a label points, and it draws every connection between separately
placed parts as labels. Moving U2 right under J2 changed nothing. Every wish had to be phrased as a
hint the layout may ignore.

The user's decision: **the netlist is the master; the agent controls the visual side completely.**
It also controls the netlist (it builds circuits, it imports schematics). So, as for the board,
which already stores its own geometry (`board.tracks`):

- **The drawing is stored in the design** (`Design.drawing`): per sheet the pages; per symbol its
  page, position, rotation and mirroring; wires as polylines with their net; net labels and supply
  symbols with position and direction; no-connect marks. Nothing redraws it by itself.
- **The kernel checks the drawing against the netlist** instead of drawing it. A wire that touches
  two nets is an error. A connection the netlist has and the drawing does not show (R3.2 and U2.5
  both on SENSE_P, no wire or label between them) is not an error: the kernel completes it with a
  label marked automatic, and the agent may replace it with a wire. Open pins stay what they are.
- **The auto-layout becomes a tool**, not the authority: `auto_draw` (a sheet, or some parts) writes
  its result into the drawing as a starting point. Parts the netlist gains are drawn in free space
  the same way, for the agent to arrange.
- **Ops for the agent**: `place_symbol` as today; `wire { from: "R3.2", to: "U2.5", via? }`, the
  kernel finding an orthogonal path unless the agent gives the corners; `label { pin, dir }`;
  `supply_symbol { pin, side }`; removing wires and labels.
- **Import** builds the netlist and redraws the original's arrangement, wires where it had wires.
- **The checks** (§3) judge the agent's drawing, so every finding is one it can act on.
- **Hand editing** (dragging symbols and wires in the editor) is not planned yet: later, depending on
  how well the agent does.

This supersedes "the kernel decides where every line goes" in §2 and the hint-based steps of §4–5;
the router of §5 becomes the `wire` op's path finder.

## 3. Notes and checks

*2026-10-13:* the ruleset text below was replaced. It read like a config format (ids, `level:`
lines, `(layout)` marks) and its long default told the model things it knows. Now (see
[schematic-rules.md](schematic-rules.md)):

- **Notes**: the user's own words, like a CLAUDE.md, empty by default, filled when the agent draws
  something the user does not like. Sent as `<schematic_notes>`.
- **Checks**: a fixed list in Settings → Schematic drawing, each with a plain title and a level
  (Must fix, Warn, Note, Off), crossings with a limit.

The rest of this section is the 2026-10-12 design, kept for the record.

One markdown file says how a good schematic looks. The default ships with the app; the user edits it.

### 3.1 What is in it

Two kinds of content, side by side, grouped by topic (see [schematic-rules.md](schematic-rules.md)):

- **Guidance** in plain prose, for the agent: "signal flows left to right", "a feedback divider
  stacks under its rail". The agent reads it before it arranges a sheet.
- **Rules** with an id, a level and sometimes a parameter, which the kernel checks:

  ```markdown
  ### SCH.RAIL_UP: rails point up
  level: error
  ```

  A violation is a diagnostic like an ERC one (`SCH.RAIL_UP U1.PVIN`), with the same handling: the
  agent must fix errors or ask for a waiver, the user sees warnings in the list.

The kernel only knows the rules it has code for. Editing the file can change a known rule's level
(`error`, `warning`, `info`, `off`) or parameter; it cannot add a new check. A rule the kernel does
not know stays guidance for the agent (and the settings page says so). Guidance can be added freely.

### 3.2 Who obeys what

- **Layout invariants.** Some rules the layout follows by itself, whatever the hints say
  (`SCH.RAIL_UP`, `SCH.GND_DOWN`, `SCH.ORTHOGONAL`). A hint that would break one is refused with the
  rule's id, the same way the kernel refuses an op today. The check still runs, as a guard against
  layout bugs; a finding there is not held against the agent (it does not block finishing or
  propose: no edit of the design fixes a layout bug). Setting such a rule to `off` lets the layout
  break it (someone who wants sideways rails can have them): planned with step 3, the layout does
  not read the ruleset yet, so today `off` only silences the check.
- **Checks.** The rest are measured, not enforced (`SCH.TEXT_OVERLAP`, `SCH.JOG`, `SCH.CROSSING`):
  the layout tries, the diagnostic reports where it did not manage, the agent improves it with hints.
- **Guidance.** Read by the agent, checked by nobody. Judgement.

Precedence when they disagree: a hard ledger entry (the user said so) beats the ruleset, the
ruleset beats a soft hint, a soft hint beats the layout's defaults.

### 3.3 Where it lives

- The default: `SCHEMATIC_RULES` in `packages/schema/src/rules.ts`, versioned with the app. It is
  code, not an `.md` file, because the local server runs from TS directly.
- The user's copy: kept with the browser's settings (`Settings.schematicRules`), created from the
  default on first edit in Settings → Schematic rules. It applies to every project opened in that
  browser; it is not a file in the projects folder.
- Future: a project may carry its own copy in the design file (a client's drawing standard).
  Project beats user beats default.
- The agent can propose a change to it: "always draw ferrite beads lying flat" becomes an edit to
  the ruleset, shown and accepted like a changeset, instead of a hint on one part. The agent must
  not change it unasked.

The agent gets the guidance in its design context, not in the cached system prompt, because it is
per user. It is short by design (the draft is about 2 k tokens); the rules' parameters are not sent.

## 4. Drawing in three steps

The agent arranges a sheet in three steps, each one transaction of drawing hints, each one checked
before the next. It runs when the agent has built or changed a circuit, when the user asks ("tidy
this sheet"), and for an area with Optimize ([zoom-optimize.md](zoom-optimize.md)), which becomes
"the three steps for the parts inside the area".

After each step the agent gets: a picture of the sheet or area (`get_schematic_image`), the
measures, and the `SCH.*` diagnostics the step introduced and resolved. It may repeat a step (fix
budget as today) before moving on.

### Step 1: placement

What the agent decides, from the ruleset and its knowledge of the circuit:

- **Blocks**: which parts form one functional block (input protection, buck, MCU, USB), and the
  part each block is built around. The design description already has blocks for the design
  document (`describe`); the same blocks drive the drawing, so they are written once.
- **Block order**: where the blocks go relative to each other, following the signal and power flow
  (input left, output right; supply generation above or left of what it feeds).
- **Part placement inside a block**: `left_of`/`above`/… as today, and **orientation** of two-pin
  parts (standing or lying, which end where).

The kernel: places the blocks and their parts on the grid, keeps blocks whole on pages, resolves
collisions, and draws the recognised circuits (regulators, bridges) as today unless told otherwise.

### Step 2: supplies

Most of it is rules, so most of it is the layout's job: rails up, ground down, decoupling caps at
the pin they decouple, one rail symbol per bus. The agent sets only exceptions:

- the side of a pin a supply symbol stands on (when the default runs into something),
- a supply drawn as a rail symbol, as a net label, or as a wire to a neighbouring rail,
- which decoupling caps form one bank.

### Step 3: connections

What is left: signal and data nets. The router draws orthogonal wires that keep crossings, bends
and jogs low. The agent decides:

- **wire or label** per net (a wire inside a block, a label between blocks or pages; the agent
  knows which nets matter to read: a feedback path should be a wire),
- the **side or path** of a wire where it matters ("SDA and SCL along the top of U2"),
- **buses**: nets that run together (a data bus, a differential pair) and are drawn as one bundle.

### The hints this needs

All soft, all in the ledger, all removable, none changes the circuit (so Optimize may use them).
Names are proposals:

| Hint | Example | Step |
|---|---|---|
| `block` | members of a block and its centre part (from `describe`) | 1 |
| `block_order` | `["input", "buck", "mcu"]`, rows | 1 |
| `left_of` / `right_of` / `above` / `below` | as today | 1 |
| `orient` | `R4` lying, pin 1 left | 1 |
| `supply_side` | `U1.PVIN` symbol left of the pin | 2 |
| `net_style` | `AVIN` as label / symbol / wire | 2, 3 |
| `route` | `FB` above `U1` | 3 |
| `bus` | `SDA SCL` | 3 |

A hint the layout cannot honour shows as `violated` in `constraintStatus`, as today, so the agent
learns that a request did nothing.

## 5. What changes in the layout

The three steps need a layout that has the matching stages, so a hint has a place to act:

1. **Place**: blocks and parts on the grid (today: anchors in rows, satellites, decap rows, `flow.ts`
   templates, all mixed in `buildCell`).
2. **Supplies**: supply symbols, decoupling banks, rail buses.
3. **Route**: wires between what is placed, instead of wires drawn as a side effect of placement.

Today wires come out of placement (a satellite column brings its own wire), which is why there is no
lever on them. Step 3 needs a real router for schematic wires: orthogonal, on the grid, cost on
bends, crossings, running through parts or text. That is the largest piece of new work.

## 6. Build order

*2026-10-13*, after §2a; each step is useful alone:

1. **Notes and checks** (§3). *Built 2026-10-13.*
2. **The stored drawing**: `Design.drawing`, `auto_draw`, rendering from the stored drawing, the
   netlist check, automatic labels for connections not drawn. *Built 2026-10-13* (`kernel/drawing.ts`):
   - A sheet nobody arranged stores nothing and is drawn by the auto-layout afresh after every
     change, as before (so constraints keep working there, and existing designs need no migration).
     The first `place_symbol` on a sheet stores the layout's drawing of it (`ownSheet`): symbols as
     part, generator spec (`SymbolSpec`, recorded by `symbolFor`/`uprightSymbol`), origin, rotation,
     box and text positions; wires; labels without their text (the net's name is used). `auto_draw`
     without refs hands the sheet back; with refs it redraws those parts in free space.
   - `syncDrawing` runs after every transaction, partial accept and load: symbols of parts that are
     gone, moved to another sheet or drawn from another card or units leave; each group of touching
     wires takes the net of the pins it joins (so renamed and joined nets follow), a wire to a pin of
     another net goes, loose ends are cut back to the last point something joins them; labels take
     the net of what they sit on or go, and change kind when a net becomes a supply. Parts the drawing
     does not have are drawn by the layout on their own (`layoutSheetOf` with `only`), get labels for
     their connections to what is drawn, and go into the first free spot (top-left first) or a new
     page. Pages fit the paper and their content, empty trailing pages go.
   - On the way to the canvas (`schematicView`), a net drawn in pieces that no label ties together
     gets a label at a pin of each loose piece (`LabelView.auto`), at the pin where it runs into the
     least. Not a diagnostic: the drawing is complete, just not as the agent would draw it.
   - `place_symbol` moves the symbol in the stored drawing: an IC or connector takes the small parts
     the layout drew with it (`DrawnSymbol.with`) and those wired only to it, with their wires and
     labels; wires to what stays are cut back. `orient` and `mirror` make the symbol again. A part
     that ends up on another is reported in the op's result. The old `sch_position` entries are still
     honoured by the layout and removed when the part is placed again.
   - Changesets: one `drawing` hunk per sheet; accepting a part without it draws the part in free space.
   - Relative constraints only guide the layout: on an arranged sheet they wait for `auto_draw`, and a
     violated one says so.
3. **Drawing ops**: `wire`, `label`, `supply_symbol` and the path finder.
4. **Import redraws the original.**

The first plan, steps 1–3 built 2026-10-12:

1. **Supply direction as an invariant.** Rails up, ground down, everywhere, including the cases the
   layout gets wrong today (a rail at the bottom of a hanging part, a part between two rails). Take
   out the sideways supply symbols (§1). Small, and it settles the rule the rest builds on.
   *Built 2026-10-12:* rails up and ground down everywhere, rising stems (`LabelView.rise`),
   staggered names, `clearName`, `leadEnd` turns, flat parts between two rails.
2. **The ruleset file and `SCH.*` checks.** Parse the default, run the checks the measures already
   compute (overlaps, jogs, crossings, detours) and the supply-direction rules as diagnostics. Send
   the guidance to the agent. Settings → Schematic rules shows and edits it.
   *Built 2026-10-12:* `packages/schema/src/rules.ts` (`SCHEMATIC_RULES`, `parseSchematicRules`),
   the `SCH.*` checks in `packages/kernel/src/schcheck.ts` (`Kernel.setRules`), the
   `<drawing_rules>` block in the agent's design context, the editor in Settings → Schematic rules.
3. **Placement by the agent** (pulled forward, 2026-10-12): `place_symbol` and `get_schematic`
   (§2), relative constraints that do what they say, violated placements that say why.
   *Built 2026-10-12:* `sch_position` ledger entries honoured by `layoutSheet` / `paginate`
   (placed cells fixed on their page, the rest flowing past them), `orient` lying and `mirror` on
   placed parts, Optimize may use `place_symbol` on movable parts.
4. **Orientation and supply hints** (`orient` for parts the layout places, `supply_side`,
   `net_style`): small changes in the layout, big effect on readability.
5. **Blocks drive placement** (`block`, `block_order`, from `describe`). The agent's arrangement
   step after it builds a circuit.
6. **Schematic router** and the `route` / `bus` hints. The three-step run as one agent workflow.

## 7. Open questions

- **Prompt cost.** The guidance goes with every request. Keep it short, or send it only for
  drawing work (after edits that add parts, Optimize, "tidy")?
- **How much may step 1 move?** A full re-arrangement after every small edit is disorienting.
  Probably: the arrangement step runs on new parts and on request, and leaves the rest alone.
- **Ruleset in the design file.** A project's own rules make it render the same everywhere, but a
  project then disagrees with the user's rules without them noticing. Show which ruleset applies?
- **Wires to placed parts.** A two-pin part placed on its own is connected by labels; the router
  (step 6) should wire it to its neighbours instead. Until then, placing ICs and connectors (which
  keep their small parts wired) gives the cleanest drawings.
- **Pictures.** Steps need images to judge; images are the most expensive input. One per step, area
  only where possible.
- **Claude Code.** Through the local server it gets the same hints and the same ruleset
  (`get_context`). Nothing provider-specific is planned.
