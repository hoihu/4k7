# Drawing the schematic: the agent owns the drawing

> Part of the [architecture](../ARCHITECTURE.md). Status: draft. 2026-10-12: steps 1–3 of the first plan built (§6). 2026-10-13: the agent owns the whole drawing (§2a), notes and checks replace the ruleset text (§3), the stored drawing and the drawing ops built (§6 steps 2 and 3). 2026-10-25: functional blocks, the board's split (§2b), built 2026-10-26; 2026-10-29: a part placed on its own is wired to its neighbours (§2c); 2026-10-30: a wire joins a pin from any side, and a wire a part is put down on goes round it (§6 step 3); the agent's guide is [schematic.md](schematic.md).
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
  a two-pin part placed on its own stands apart, wired to its neighbours where that draws cleanly
  and connected by labels where not (§2c). The layout flows every part nobody placed around the placed ones.
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
  kernel finding an orthogonal path unless the agent gives the corners; `label { pin, dir }` (a net
  label, or a supply symbol for a rail or ground: one op, the net decides); `erase { pins | net }`.
- **Import** builds the netlist and redraws the original's arrangement, wires where it had wires.
- **The checks** (§3) judge the agent's drawing, so every finding is one it can act on.
- **Hand editing** is minimal and stays inside this model (2026-10-29, §2c): gestures on the canvas
  that issue the agent's own ops. There is no pencil, wire or trace tool, and no toolbar button.

This supersedes "the kernel decides where every line goes" in §2 and the hint-based steps of §4–5;
the router of §5 becomes the `wire` op's path finder.

## 2b. Decision 2026-10-25: functional blocks, the board's split

A user's design (USB-C in, a buck, an RP2040, 48 addressable LEDs, three sheets) drew with 97 net
labels on the LED sheet and 57 on the MCU sheet: every part an island of labels, spread over the
pages, the big picture gone. The connections were right; the drawing hid them. The agent had taken
the MCU sheet over (§2a) and placed every part by hand, and it read worse than the auto-layout:
exact positions are too fine a lever to draw a good schematic with, and the auto-layout's rows of
cells know nothing of what belongs together.

The user's decision: **the same split as on the board.** The agent says what belongs together and
roughly where it goes, as it places the main parts on the board; the kernel draws the inside, as the
placer puts the small parts round them.

- **Blocks** are the description's blocks (`describe`; the text is optional, so the drawing can be
  grouped before the document is written, and a block given again without one keeps its text). Each
  is drawn as one framed unit with its title (`SheetView.blocks`). A part in no block goes with the
  block of the IC the layout would draw it with (its pull-up, its decoupling), else with the block it
  shares the most signal connections with (supplies count a little, ground not at all); the rest are
  drawn the classic way after the blocks. `get_schematic` lists the blocks with page, frame centre
  and size, their parts, the `guessed` ones and those `not_in_a_block`. A sheet with no part in a
  block is drawn as before.
- **Inside a block** (`kernel/blocks.ts`) the layout's pieces (an IC or connector with the small parts
  at its pins, a regulator in its datasheet style, a bridge, a chain of two-pin parts in series such
  as an LED and its resistor or a divider with its filter cap tapped off the joint) are arranged out
  from the most connected one: each goes to the side of its neighbour where the neighbour's pins for
  it are, mirrored when that turns its own pins toward the neighbour, level with the pin it connects
  to (a straight wire); columns wider than the page wrap into rows. Pieces are spaced without the
  flags of the nets about to become wires. The connections between them are drawn by the `wire`
  op's path finder; one that would cross more than three wires, wander (longer than three times
  the gap plus 2500 mils) or go round a part and turn back (a U with a leg of 500 mils or more, as
  SCH.DETOUR sees it; a shallow step to enter a pin stays a wire) stays a pair of labels. A piece is
  set level with its neighbour on the shift that puts the most of their nets in line. A net keeps one label per drawn piece only where it
  leaves the block. Supply symbols standing on a row of pins of one net become one bar with one symbol.
- **Pages**: blocks flow in the description's order, each to the highest, then leftmost, free spot
  (never back to an earlier page, so the pages read in order). A block is never split unless it is
  taller than a page: then it is cut between its rows, the nets across the cut labelled on both
  sides, the pieces after the first framed "(continued)".
- **`place_block`** (page, centre of the frame) on a sheet the layout draws stores a `sch_block`
  ledger entry; the other blocks flow round it. A block placed onto one placed earlier moves aside
  to the nearest clear spot within the page, or flows with the others when the page has none; the
  result says where it went. `auto: true` lets it flow again, and a block that leaves the
  description takes its entry with it. On a sheet the agent arranged (§2a) it draws the block afresh
  where it is put, together and wired, and says what it runs into; frames are drawn round the blocks
  whose parts stand together, and parts added later go next to their block.
- **Levers inside a block**: `left_of` / `right_of` between two of its ICs or connectors,
  `arrangement` `mirrored` / `unmirrored` on an IC or connector (kept beside a regulator's
  `power_flow` / `compact`), `up` / `down` on a small part at a pin, `set_symbol layout` to order an
  IC's pins like those they connect to.

On a copy of that design, grouped into 11 blocks (against the plain auto-layout of it): LEDs 97 → 3
net labels (the chain wired, a bar per row), MCU 36 → 31 (57 as the agent had arranged it), Main
12 → 8; 15 drawing warnings against 14 (text overlaps 11 → 5; new: four jogs on the QSPI lines and
two shallow steps); about 300 ms for the transaction and the view. Left as labels: the QSPI
flash's DI and CLK, whose pins run in another order than the MCU's (`set_symbol layout` on the flash
wires them; the path finder does not reorder pins). The flash also stands below the crystal in its
column, so its other lines jog.

## 2c. Decision 2026-10-29: a part placed on its own is wired to its neighbours

Only ICs and connectors kept their small parts wired; a resistor or capacitor the agent placed with
`place_symbol` stood apart and was tied to its neighbours by labels, so the cleanest drawings came
only from placing the big parts and leaving the rest to the layout. Now `place_symbol` of a two-pin
part runs one more step (`kernel/autowire.ts`), once, as the part is placed:

- **Each signal pin** (not a rail or ground: those keep the symbol that came along) is wired to the
  nearest other piece of its net on the page, by the `wire` op's path finder: its pins, or a T onto
  a wire of it. The nearest three pieces are tried in turn.
- **Clean or not at all.** The path is drawn only if it crosses no wire of another net, runs through
  no label or name, has at most three corners and no U-turn (the block wiring's test), is no longer
  than the direct way plus 800 mils, spans no more than 4000 mils, and adds no jog or detour the net
  did not have (`wireShape`, what SCH.JOG and SCH.DETOUR measure). Otherwise nothing is drawn, the
  result says why for each pin ("R3.2 (LED_B: a wire would cross another)"), and the connection
  shows as the automatic labels the drawing completes itself with (§2a), so none is left out.
- **Labels make way**: the net labels (and their leads) at the two ends of a new wire go, as for
  `wire`; the net's other pieces keep or get theirs.
- **Automatic means replaceable.** The wires are ordinary stored wires and nothing re-runs the step:
  `erase` at a pin takes the wire away and the label that appears in its place stays; `label`
  after an `erase` puts the agent's own; `wire` draws it with `via` corners. Moving the part again
  cuts the old wires back and wires it afresh where the new place allows.
- Not done: an IC or connector placed after the small parts around it does not wire them (place it
  first, as `get_schematic` and the guide say), and a two-pin part has no flip (pin 1 is the left or
  top end), so a part is wired most cleanly when its pin 1 faces the neighbour on that net.

Two synthetic placements (every IC and connector placed, then each small part one inch from the
first pin of its net it can face, as an agent reading `get_schematic` would; the 10-part sensor
front-end and the TPS54331 buck, `place_symbol` per part): net labels 16 → 11 and 15 → 11 (the
automatic ones 12 → 7 and 14 → 9), wires 2 → 5 and 2 → 7, SCH findings 2 → 0 and 0 → 0. The rest
stays labels: a pin whose neighbour lies on another row (a jog), across a wire, or whose wire
would go round a part.

## 2d. Hand editing, 2026-10-29

The user can fix a small thing by hand without asking the agent. Every gesture is one of the agent's
ops, sent by the app as the user's own transaction: validated like any op, one undo step, shown in
the history as the user's. No gesture draws anything new; the netlist never changes except by Delete
on a part.

| Gesture | Op |
|---|---|
| Drag a symbol (snaps to the 100-mil grid; may cross to another page) | `place_symbol x y page rewire` |
| `R` on a selected two-pin part: standing / lying, which end is which stays | `place_symbol orient mirror rewire` |
| `R` on any other selected symbol: a quarter turn clockwise | `place_symbol rotate rewire` |
| `F` on a selected symbol: mirror (a two-pin part's ends swap, where it stands) | `place_symbol mirror rewire` |
| Drag a net label round its pin: it points where the pointer is | `label pin dir` |
| Click a wire or label (it is picked and its net selected), `Delete` / `Backspace` | `erase at` |
| `Delete` / `Backspace` on selected parts, after a confirmation | `remove` |

- **Wires follow.** `place_symbol` has `rewire: true`: the pins hung together by wire before the move
  are joined again after it, by the `wire` op's path finder (`kernel/drawops.ts rewire`), shortest
  gap first. A connection with no clear path (or on another page) is left to the automatic label,
  as after any move, and the result says so. Without `rewire` nothing changes for the agent.
- **Wires make way.** A wire the symbol is put down on goes round it, for the agent's `place_symbol` too
  (§6 step 3, *Wires behind a part*). One with a pin of its own under the symbol stays until the symbol
  moves on, and the result says so. A wire a pin of the symbol lands on goes, as a wire to another net
  always does: the drag wires it again, and for the agent labels show the connection.
- **`erase at`** names one wire (the drawn wires through a point; a wire runs between two joints, so
  the canvas sends the middle of the clicked segment) or one label (at its point), by page
  coordinates. A label that was the only sign of a connection comes back as an automatic one.
- **The user's decision.** A symbol moved or turned by the user carries `DrawnSymbol.by: "user"`
  (`SymbolView.by`; `get_schematic` says `user_placed`). The kernel keeps it: `place_block` draws
  the rest of the block afresh round it, `auto_draw` of the whole sheet turns it into a `sch_position`
  entry (source user) the layout stands it at, and Optimize may not move it. The agent may still
  move it with `place_symbol` when asked or when it must; the result says "it was the user's
  placement; now yours", as on the board. Wires and labels carry no mark.
- **Keys.** The canvas takes focus on a click (`tabindex`), so R, F and Delete act on it only, never
  while the chat box is focused, and never with ⌘, Ctrl or Alt held (⌘R, ⌘F and the like are the
  browser's). The canvas does not take edits while the agent works or a changeset waits for review.
- **Limits.** The drag preview moves the symbol alone: the wires are drawn once it lands, and an IC's
  small parts follow then. A turned or mirrored symbol stays where it stands, so a tall IC turned may
  lie on its neighbours (the result says so), and its wires can go the long way round; Undo is one
  step. A part dragged with its `rewire` on a crowded sheet may leave some connections as labels.

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
- **Checks.** The rest are measured, not enforced (`SCH.TEXT_OVERLAP`, `SCH.JOG`, `SCH.CROSSING`, `SCH.RAIL_SIDE`):
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
   - `mirror` says how the symbol ends up, not "swap it" (the ledger and the app's `F` need it that
     way), so `get_schematic` marks the symbols that are `mirrored` now and the result says when a
     `mirror` changed nothing. What it does depends on the symbol: a box or a part lying between two
     terminals (crystal, switch, fuse, choke) swaps its pins' sides, a transistor, optocoupler,
     relay, shunt reference or bridge is drawn turned over (`turnedOver`, `SymbolSpec.over`), a part
     drawn as a two-pin one swaps its ends (`SymbolSpec.flip`: mirrored is pin 1 at the bottom or,
     lying, on the right). `orient` without `mirror` puts pin 1 on top or on the left, as the agent's
     guide says; the app's `R` sends `mirror` along so that turning twice gives back what was there.
     The layout mirrors a part only to swap its pins (`canMirror`), never to turn one over. `F` works
     in the symbol's own frame: a crystal standing swaps its terminals, top for bottom.
   - `rotate` turns any symbol but one drawn as a two-pin part by quarters clockwise from how it is
     usually drawn, after any mirror (`SymbolSpec.rotated`). The def itself is turned (`turned`, as
     `turnedOver` mirrors), not the picture as `DrawnSymbol.rot` does for a lying two-pin part, so the
     pins, the box, stored drawings, `set_symbol` and the layout all take it as any other symbol. It
     turns about the middle of its box on the grid and keeps its origin, so four turns bring it back
     to the mil, and the pins stay on the grid. Text stays upright: the name and value go on a side
     without pins (`nameBeside`), and the names of a box's close-pitched pins on top and at the bottom
     run along them (the canvas). `place_block` keeps a turned symbol the user placed, and a sheet
     without blocks back with the layout keeps the turn (`sch_position.rotated`), except for a
     regulator drawn in power flow. On a sheet with blocks `auto_draw` arranges each block afresh and
     the turn goes, as a mirror and the place do.
   - Drawings stored before 2026-10-30 may say `mirror` on a part that turns over, from a layout or
     an `F` that had no effect then. It stays as it was drawn (`specMirrors`): opening a design moves
     nothing, and `F` then mirrors it for real.
   - Changesets: one `drawing` hunk per sheet; accepting a part without it draws the part in free space.
   - Relative constraints only guide the layout: on an arranged sheet they wait for `auto_draw`, and a
     violated one says so.
3. **Drawing ops**: `wire`, `label`, `erase` and the path finder. *Built 2026-10-13*
   (`kernel/drawops.ts`, `kernel/schroute.ts`):
   - `wire` joins two pins that are on one net in the netlist (`NET_MISMATCH` otherwise: a wire
     shows a connection, it never makes one), on one page. The path finder (A* on the 100-mil grids
     through both pins) joins a pin from any side but the part's own (*Any side of a pin*, below),
     never runs through a part, along a wire of another net or onto another net's pin or wire end, crosses other wires only straight across,
     and pays for bends (300), crossings (400) and running through labels or names (600); it turns on
     the target's grid so the wire does not end in a short jog. `via` forces corners. Net labels at
     the two pins are taken away. `NO_PATH` asks for corners or a move.
   - `label` replaces what labels a pin (its labels, and a lead that only ends in a label) by a net
     label pointing `dir`, or by a supply symbol, which always points its own way. A net label across
     the pin's direction stands on a 200-mil lead, so a label at a top or bottom pin can be horizontal.
     One pointing back into the part is refused.
   - `erase` takes out wires and labels at pins, or everything of a net; the connections show as
     automatic labels until drawn again.
   - `get_schematic` lists the net labels with the pin they sit on, `auto` for the kernel's own.
   - *Tidy wires, 2026-10-13.* Optimize runs left nets in knots: loops, runs drawn twice, little
     humps beside lying parts. Three causes, three fixes. (1) A rotated symbol's pins kept the side
     of the standing symbol (a lying C's right pin said `bottom`), so every wire from it first went
     down and back up; `rotateSymbol` now turns the side with the pins. (2) `wire` routed pin to pin
     and ignored the net's other wires; the router now runs from anywhere on the wires joined to the
     one pin to anywhere on those joined to the other (a T onto a wire), never along any wire, and a
     `wire` between pins already joined draws nothing. (3) After every sync each net is cleaned
     (`kernel/wireclean.ts`): split at every joint (pins, labels, a wire end on a wire), put back as
     a tree with the shortest pieces (Kruskal), dead ends pruned, U-turns and steps shifted out where
     the new piece is clear and cheaper by the router's costs; a piece with a U-turn left (or loops)
     is also drawn afresh pin by pin onto what is drawn, and the cheaper drawing kept. A plain
     crossing is never a joint, a moved piece touches nothing new, so connections never change; a
     wire given `via` corners (`WireView.via`) keeps its path; a net that needs nothing keeps its wires.
   - *Any side of a pin, 2026-10-30.* The path finder only left and entered a pin outwards, and the
     clean-up refused anything else. So a wire from a crystal to the top pin of the load cap beside it,
     on one level, had to hop over the pin and come down onto it (`SCH.DETOUR`). The agent saw the bump
     and could not take it out in seven tries: a `via` on the pin came in from above too, one on what was
     drawn already looped out and back (10 corners), a wire past a pin of its own net went round it, and
     the clean-up could not straighten any of it. No schematic program has this rule: a pin end takes a
     wire from any direction. (1) A pin is joined from any side but the part's own. The side costs a
     corner, which is what it draws with the lead, so a wire still goes straight out where that is no
     longer. (2) Corners on what is drawn at either end of a wire need no drawing. (3) `wire` runs through
     a pin of its own net in its way, which joins it. (4) The clean-up takes the same freedom, so a hop in
     a stored wire comes out by itself; a wire given `via` keeps its path and takes an `erase` and a new
     `wire`, which `SCH.DETOUR` then says. (5) A run of `RETURN_LEG` or more (a chain's return from one row to the next, no hump to
     `SCH.DETOUR`) counts the side twice, in the path finder and the clean-up: without that it drew down
     the pin column into the part's name, on sheets redrawn after every change too. A part placed on its
     own gets wired more often for the same reason. The golden circuits draw as before. On the user's
     124-part design: opening it changes 5 nets of its drawing (`SCH.DETOUR` 8 → 4);
     each of its 89 signal nets erased and wired again, pin by pin: corners 131 → 88, detours 15 → 4,
     crossings 50 → 36, no path found 5 → 4 (one net gets two more crossings).
   - *Wires behind a part, 2026-10-30.* A move takes along the wires of what it moves and leaves all
     others where they are, so a part put down on a wire hid it for good: on the user's design, after a
     few drags, RUN ran down the outline of U4's body and SWDIO in at its top and out at its bottom, and
     nothing looked at them again. The path finder never draws through a box, so a run through one comes
     from a part put down on it (or the layout: three of its wires on that design run across a small part).
     (1) The clean-up takes such a run (`behindPart`; a box, like the path finder, so a wire across a lead
     counts and one in the air of an IC's box moves too; a slanted lead is the part's own). It keeps what
     it has up to the box at either end, on its grid, and the path finder joins that and the rest of the
     piece again (`goRound`): the wire keeps its course and only what stood behind the part moves. The usual
     tidying follows and takes the hump's U-turn out where a plainer drawing is cheaper. Being the clean-up,
     it runs for every op and as a stored drawing opens. (2) A wire given `via` gives way too and no longer
     keeps those corners: they were for a drawing that has changed. (3) Where it cannot get round (a pin of
     its own under the part, which then lies on another) it stays, the result says "still run behind it",
     and the next move that leaves a way clears it. (4) A pin between the lattice's lines (a part off the
     wire's grid) did not stop the path finder: its wire ran over the pin, the sync took it out as a wire to
     another net, and the connection fell to labels. Such a pin now blocks the run over it. A wire along a
     box's edge stays: that is the path finder's own lane, and a box has air round its body. The golden
     circuits, the 45° bridge and the user's other designs draw as before. On the 124-part design: opening it
     moves RUN and SWDIO only, runs through a part 3 → 0, the SCH counts unchanged. U4 dragged in the app
     (WebKit) onto SWCLK and SWDIO and back: 3 → 0 at each stop. Each of its parts turned, mirrored and dragged
     twice, from the opened design (496 gestures): one ends with a wire through a box in 24 where it did in 493,
     and but for one these are as before (a pin of the wire under a part, or the lead of a supply symbol that
     a mirrored part's end now sends into its neighbour); labels never more, the SCH counts within 2%, about
     6% slower (some 30 ms of a small part's 550).
   - Optimize may use them at pins of parts in (or anchored to) its area, not `erase` of a net.
4. **Import redraws the original.**
   - *Symbol pins, built 2026-10-13.* A drawing cannot look like a reference whose IC has its pins
     elsewhere (an imported 21-pin buck came out with every pin down one side, alphabetical, and the
     agent had no way to change it). `set_symbol layout` gives each side's pins in drawing order
     (names or numbers; a shared name stacks those pins, an array stacks numbers, `null` is a gap),
     stored as the card's `symbolLayout` with `customSymbol` set. Every pin exactly once, only pins of
     one name (or NC pins) stacked, box symbols only (not two-pin parts, transistors or bridges);
     `SYMBOL_LAYOUT` lists what is wrong. `layout: null` restores the generated arrangement
     (`generatedLayout`). On a stored drawing the symbol is made again centred where it stood
     (`remakeSymbols`) and the sync cuts back wires to pins that moved, so those connections show as
     labels. Like `set_footprint`, a committed custom layout goes back to the library part
     (`adoptParts` in the web app), so later designs draw the part the same way.

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
   step after it builds a circuit. *Built 2026-10-26 as §2b:* the description's blocks and
   `place_block` instead of hints.
6. **Schematic router** and the `route` / `bus` hints. The three-step run as one agent workflow.

## 7. Open questions

- **Prompt cost.** The guidance goes with every request. Keep it short, or send it only for
  drawing work (after edits that add parts, Optimize, "tidy")?
- **How much may step 1 move?** A full re-arrangement after every small edit is disorienting.
  Probably: the arrangement step runs on new parts and on request, and leaves the rest alone.
- **Ruleset in the design file.** A project's own rules make it render the same everywhere, but a
  project then disagrees with the user's rules without them noticing. Show which ruleset applies?
- **Wires to placed parts.** *Resolved 2026-10-29 (§2c):* a two-pin part placed on its own is wired
  to its neighbours when that is clean. Still open: wiring the small parts that were placed before
  the IC they serve, and a flip for two-pin parts, so pin 1 need not face the neighbour.
- **Pictures.** Steps need images to judge; images are the most expensive input. One per step, area
  only where possible.
- **Claude Code.** Through the local server it gets the same hints and the same ruleset
  (`get_context`). Nothing provider-specific is planned.

## 8. The drawing eval

*2026-10-29.* The auto-layout and the blocks draw every sheet, so a change to either needs a measure
of the drawings, not only tests of single cases. `packages/kernel/bench/schematic-golden.ts` builds
twelve circuits through the kernel's ops (the two bucks, USB-C with ESD and CC resistors, an MCU
with decoupling, crystal and SWD header, an MCU with a QSPI flash, an H-bridge, an op-amp stage, a
bridge of four diodes and one in a package, a 555, and a 29-part board drawn plain and as five
blocks). `schematic-eval.ts` lays each out as the app does and prints, per circuit, the `SCH.*`
findings by id, wire segments, bends, crossings, jogs, detours, net flags against wires, supply
symbols, pages, and the pins the drawing leaves apart from their net or joins to another one:

```sh
node --experimental-transform-types packages/kernel/bench/schematic-eval.ts [--only id,id] [--compare packages/kernel/bench/schematic-baseline.json]
```

It writes the numbers to `schematic-latest.json` (ignored by git; `--out` picks another file) and
`--compare` shows each change against a baseline in the table. When a change to the layout is meant
(fewer crossings for more labels, say), run it with `--out packages/kernel/bench/schematic-baseline.json`
and commit the new baseline with the change, so the diff of that file is the effect on the drawings.

`test/schematic-eval.test.ts` is the guard, one test per circuit (about 20 ms each): every part is
drawn, every connection is a wire or a label and no wire touches another net's pin, no `SCH.*`
finding is at the Must fix level, and segments, crossings, jogs, detours and pages are at most a tenth
(rounded up) above the baseline, so a count of zero stays zero. Better numbers never fail it.

### Known weaknesses

What the first baseline shows (the circuits are small, so each is a pattern, not an accident):

- **Buses and fast interfaces become labels.** The four QSPI data lines between MCU and flash, the
  USB D+/D- through the ESD array and the gate lines of the H-bridge are all labels (net flags are
  60 to 75 % of the drawing in these three); the QSPI labels also run into the series resistor
  that stands between the two parts.
- **Crystal away from its MCU.** In the MCU circuit the crystal stands to the right of the
  MCU and its LED, joined to it by labels, while its load caps and the resistor are wired on the left.
- **Dividers and pull-ups drawn upside down.** The bias divider of the op-amp stage and the 555's
  timing resistor stand with the supply at the bottom (`SCH.RAIL_SIDE`); the divider is drawn as two
  columns side by side, the case of §1.
- **Blocks run over the page.** The 29-part board grouped into blocks needs two pages (one when drawn
  plain) and has the only crossings of the set: I2C against each other, the feedback divider across
  +3V3 and SW, and an I2C wire that doubles back.
- **Switch node jog.** The inductor of a buck is not level with the regulator's switch pin
  (`SCH.JOG` in both TPS54331 drawings).
- **H-bridge** (all of it): the MOSFETs stand in one row at the top, the drivers in another far below,
  and the boot lines run into the gate-drive labels (`SCH.TEXT_OVERLAP`, 7).
