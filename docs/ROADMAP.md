# Roadmap

> Status: proposal, 2026-11-26, written against `main` at 5ac8cdc (0.7.0 plus Unreleased: designs of
> several boards). [ARCHITECTURE.md §7](ARCHITECTURE.md#7-roadmap) says what is built; this says what comes
> next, in which order, and when each piece counts as done. The agent side is worked out in
> [design/agent-workflows.md](design/agent-workflows.md). Section 8 lists what the owner still has to decide.
> Designs written so far: [spec](design/spec.md) (A1, A2), [scorecard](design/scorecard.md) (Q1),
> [kicad-export](design/kicad-export.md) (X1, X2).

## 1. The goal, made checkable

"The best, feature-complete PCB tool on the market" cannot be reached feature by feature. Altium, Cadence
and KiCad carry thirty years of manual editing, and 4k7 has no manual tools on purpose: copying their menus
would spend the project on its weakest side. So the goal is set on an outcome and on a segment.

**Outcome.** A board designed in 4k7 works at first power-up, and before it is ordered 4k7 shows, for each
thing the user asked for, how it was checked, or says that it was not.

**Segment** (decided, D1). One engineer or a small team. Boards up to about 300 parts on 2 to 8 layers
with through vias. Microcontroller and module designs with USB 2.0, 100 Mbit Ethernet, CAN, RS-485, SPI
flash; power up to some tens of amps; RF as 50 Ω feeds to modules and antennas. Made and assembled at
JLCPCB, PCBWay or Eurocircuits. Outside it: DDR memory buses, multi-gigabit serial links, HDI with blind and
buried vias, rigid-flex, and safety certification for mains.

**Feature-complete** then means: no stage of this user's way from an idea to a working second revision
sends them to another tool, and they can take their design elsewhere at any time. Section 3 lists the stages.

Four numbers say how far it is, tracked per release (track Q):

1. Golden briefs that end with every item of their spec verified (not merely with clean checks).
2. Fabricated boards that powered up without rework, out of the boards fabricated.
3. User interventions, turns and tokens per golden brief.
4. Connections routed on the benchmark boards.

## 2. The market in November 2026

| Tool | What it is | Ahead of 4k7 | 4k7 ahead |
|---|---|---|---|
| Flux | Browser editor with an agent, in the cloud, metered in credits | SPICE the agent can call, real-time collaboration, a large shared library, templates, manual editing as the fallback | Local files, any model with no metering, checks that reach the production files, order cost at three houses, enclosure, several boards. A competitor's comparison reports no KiCad project export from Flux |
| Quilter | Layout only: schematic and outline in, several placed and routed candidates out | Dense boards (BGA fan-out since July 2026), a physics report per candidate, candidates to choose from, native files back to Altium, Cadence, Xpedition and KiCad | The whole way from the request, nothing uploaded, no per-project price |
| KiCad 10 (March 2026) | The free manual editor; community MCP servers drive it | Everything manual, thousands of library parts, any layer count, design variants, design blocks, tuning by delay, importers for Altium, Eagle, Allegro and PADS, ngspice built in | Ops at the level of intent and a kernel that refuses a wrong edit (the MCP servers move KiCad's geometry, and its API has no live schematic editing yet), datasheet checks, sourcing and cost |
| tscircuit, atopile, Diode's Zener, JITX | The design as code, written by a coding agent | Version control, packages and CI as in software; tscircuit's MIT autorouter in TypeScript has a fan-out stage; Zener compiles to KiCad | Nothing to learn or read as code, review on a drawing, checks |
| Cadence AuraStack, Siemens, Zuken, Altium | Enterprise suites with agents on top (AuraStack announced July 2026) | Multiphysics analysis (signal, power, thermal) the agent runs across the flow | Not this segment. It shows the direction: agents that run analysis, not only edits |

What follows:

1. **An agent that edits the design is no longer a difference.** Every tool has one. What is left to 4k7
   is the kernel that refuses, local files with the user's own model, and how far the checks reach. The
   roadmap spends most on the last, and on what the agent does besides editing.
2. **"Physics" is what the layout specialists sell.** 4k7 already checks current, voltage drop, impedance
   and return paths on the copper. It does not simulate the circuit, and it estimates no temperatures.
3. **Getting a design in and out is weak across the AI tools**, and it is the cheapest trust to earn for a
   tool in alpha with a file format of its own.
4. **Candidates beat one answer.** A deterministic kernel that runs without a browser can compare variants
   on the user's own computer.

## 3. Where 4k7 stands, along the user's way

| # | Stage | Built | Missing | Packages |
|---|---|---|---|---|
| 1 | Say what is wanted | Chat, hints, the constraint ledger, a plan step for terminal agents | No record of what the product must do. A brief that is not met passes when the checks are clean (a USB-C connector asked for, a pin header delivered) | A1, A2, A7 |
| 2 | Choose the architecture | Power tree, calculators, cost compared across houses | One answer instead of alternatives side by side | A6 |
| 3 | Parts | Datasheet import with two passes, generic parts with standard packages, 17 seed parts, the houses' catalogues | Breadth without an import each time; no simulation models | X3, X4, P2, P5 |
| 4 | Schematic | Netlist ops, functional blocks, pages that lay themselves out, electrical and datasheet checks | No simulation, no tolerance analysis; a channel repeated n times is built n times | P1–P4, S4 |
| 5 | Review | Changesets, waivers | The author checks its own work; nobody reads the datasheet a second time | A3–A5, A8 |
| 6 | Placement | Placer, rooms, attach, compared arrangements | Regular patterns (a ring of LEDs); a datasheet's layout advice is not carried onto the board | S5, A4 |
| 7 | Routing | Maze router with negotiated congestion, pairs, length tuning, planes, 2 or 4 layers | 6 layers and up, BGA escape, dense boards | S1–S3 |
| 8 | Physical checks | DRC, impedance, current per track and via, voltage drop, spokes, heat map | Pours count as lossless; no temperatures; no clearance by voltage; no loop area | P6–P8 |
| 9 | Mechanics | STEP out, enclosure script, stack collisions | Mechanics that are given: a DXF outline, a housing as STEP | X6 |
| 10 | Production files | Gerber X2, drill, IPC-D-356A, BOM, pick-and-place, panels, fab notes, read-back check | Assembly variants; V-scoring; IPC-2581 | X8, X10 |
| 11 | Sourcing and cost | Three houses: catalogue, stock, cost, cheaper equivalents | Other distributors (through the user's MCP servers) | (none) |
| 12 | Hand-off | Design document, bring-up sheet, STEP | The design in another tool's format; the pin map for firmware | X1, X2, L1 |
| 13 | Bring-up | A sheet to print | No record of what was measured, no diagnosis | L2 |
| 14 | Revision | Undo, files that diff in git | Revisions, a readable diff, errata that start rev B | X7, L3 |
| 15 | Reuse | Blocks and boards copied from other projects | Which blocks are proven on a real board; search across projects | L4 |

## 4. The four questions that started this

**A SPICE simulator?** Yes, but as checks, not as a workbench. A waveform viewer the user drives would be
a copied feature and a manual tool. What fits 4k7: the agent writes a test bench for a block (sources,
loads, an analysis, and what must hold: "3.3 V ±2 % from 0 to 500 mA", "phase margin over 45°", "reset
released after 10 ms"), the bench is stored with the design, bound to an item of the spec, and run again whenever
the block changes. A failed bench is a finding like any other (`SIM.*`); a block with a part that has no
model says that it was not simulated, never that it is fine. ngspice compiled to WebAssembly runs in a
worker, as the router does, so nothing leaves the computer. The work is in the models, not the engine:
see P2 and P5. Tolerance analysis (P1) needs no simulator and comes first, because wrong dividers and
resistor values are the commonest numeric mistakes.

**High-frequency lines?** Largely built ([impedance](design/impedance.md), [high-speed](design/high-speed.md)):
stack-ups, a 2D field solver, pairs, length tuning, via fences, the `IMP.*` checks. Missing inside the
segment: striplines on inner signal layers (the solver has them; the board stops at 4 layers), pairs that
branch or change layer, an estimate of crosstalk. A 3D field solver is not planned; an export for one is
cheap once X1 exists.

**Export to KiCad and other formats?** Yes, early. It reverses a non-goal of ARCHITECTURE.md §1 (decided, D2), for
three reasons. A user will not put a real design into an alpha tool they cannot leave. 4k7 has no manual
tools, so KiCad becomes the place for the last change the agent cannot be talked into. And the other
direction, reading KiCad libraries and projects, opens thousands of parts and lets 4k7 check a board
that was not designed in it, which is a way in for users who are not ready to switch. Altium, Eagle and
the rest come through KiCad's own importers.

**Comfort?** The ones worth building are those that remove a reason to leave: assembly variants (X8), a
readable diff between two versions (X7), a part by its LCSC number (X4), patterns such as rings and grids
(S5), a sketched route or area as a hint (A9), a hand-assembly page (X9).

## 5. Packages

Sizes: **S** one pull request of the usual size, **M** two to five, **L** more, and a design doc first.
State: `open`, `in flight (#n)`, `done`. "Needs" names packages that must be merged first.

### Q. Measure

| Id | What | Done when | Size | Needs | State |
|---|---|---|---|---|---|
| Q1 | **Scorecard.** Design: [scorecard](design/scorecard.md). `design_query get_scorecard`: one deterministic summary of a design: findings by family and severity, what is unknown or unverified, open connections, board area and layers, fitted parts, the power tree's budgets, the hottest copper (the production files' findings, BOM lines and order cost follow as Q1b, since the kernel does not have them); the spec by status once A1 is in | The eval score, the design document and A6 read it instead of counting themselves | S | | open |
| Q2 | **Golden briefs.** Twelve briefs across the segment (LED on USB-C, 12 V buck, ESP32-C3 sensor with antenna, STM32 with USB and SWD, op-amp front end, 5 A H-bridge, Li-ion charger with boost, isolated RS-485, RP2040 with QSPI flash, a two-board stack, a 6-layer board for S1, a rev B from errata for L3), each with its spec and a scripted solution like today's golden tasks | `npm test` proves each can be met without a model | M | A1 for the specs | open |
| Q3 | **Model table.** The briefs run by hand through `eval:mcp` for each agent and model; spec items verified, errors, turns, tokens and cost in a table on the site | The table exists for the four coding agents and is rerun for a release | M | Q2 | open |
| Q4 | **Router benchmark.** Fixed, placed boards (the project's own and public ones); connections routed, vias, length, time. The same inputs through tscircuit's autorouter as a reference | A number per release in `packages/kernel/bench`, and the comparison S3 is decided on | M | | open |
| Q5 | **Board log.** `docs/boards.md`: every fabricated board, the version it came from, what went wrong, and the check that catches it now. spiral2 is the first entry | The file exists and number 2 of §1 is read from it | S | | open |
| Q6 | **Seeded faults.** Twenty designs with one planted fault each (a strapping pin loaded at boot, a pull-up missing, a capacitor under-rated, a mirrored connector, a regulator outside its input range) | A score per release: found by a check, found by a reviewer, missed; and how many findings on the clean originals were wrong | M | | open |

### A. Agent ([agent-workflows](design/agent-workflows.md))

| Id | What | Done when | Size | Needs | State |
|---|---|---|---|---|---|
| A1 | **The spec.** What the product must do, in the user's words, each item with how the kernel can tell: a part that must be there, a measured value, a check that finds nothing, or the user's own tick (calculations and simulations later). `SPEC.*` findings; `propose` is refused while an item is violated unless the agent names it and why. Design: [spec](design/spec.md) | A brief that asks for USB-C and gets a pin header cannot be proposed as if it were met | M | | open |
| A2 | **The agent writes it.** Spec items are drawn from the brief in the first transaction and reviewed in the changeset; what the agent assumed is marked as assumed. The eval holds each brief's own spec against the result | The golden briefs score on their spec | S | A1 | open |
| A3 | **Reviewer runs.** A second, read-only run with a narrow task reports findings (`REV.*`) with evidence the kernel can look up; findings are kept per block and go stale when the block changes. First reviewer: the brief against the design | Q6 shows faults found that no check finds, at a known cost in tokens | L | A1 | open |
| A4 | **Datasheet reviewer.** Each IC's datasheet read again against the circuit as built; its layout advice becomes ledger constraints with the page they came from | "Input capacitor within 3 mm of VIN" from a datasheet is a checked constraint on the board | M | A3 | open |
| A5 | **Risk and bench reviewers.** What kills the board (reverse supply, hot plug, pin states at reset, ESD at connectors) and whether it can be brought up (test points, programming access, a way to power rails one at a time) | Both run at the schematic gate on the golden briefs | M | A3 | open |
| A6 | **Explorations.** Variants as lists of ops, each applied to a copy of the design in a worker, placed, routed within a budget and compared by scorecard; the chosen one becomes an ordinary changeset | "LDO or buck?" and "2 or 4 layers?" are answered with a table of numbers and two pictures | L | Q1 | open |
| A7 | **Gates and a decision queue.** The plan step for the in-app agent too; steps tracked and each proposal linked to its step; a summary at five gates (architecture, schematic, placement, routing, files); questions that do not block wait with their default, marked as assumptions | A golden brief runs from request to files with stops only at the gates | M | A1 | open |
| A8 | **Explain.** `design_query explain`: where a part, a value, a net's attribute or a constraint comes from (spec item, datasheet page, calculation, message) | Clicking a part shows why it is there | M | A1 | open |
| A9 | **Hints on the canvas.** A sketched stroke becomes the points of a laid track, a drawn rectangle a room or keep-out, a pinned note a task for the agent | Each gesture arrives as ops in a changeset | M | | open |
| A10 | **Background runs.** `4k7pcb run <job> --project <id>`: stock and lifecycle watch over a project's BOM, all checks again after an upgrade of 4k7; the result waits as a proposal when the project is opened next | A part gone out of stock is waiting as a proposed replacement | M | Q1 | open |

### X. Exchange

| Id | What | Done when | Size | Needs | State |
|---|---|---|---|---|---|
| X1 | **KiCad board out.** Design: [kicad-export](design/kicad-export.md). `.kicad_pcb` in KiCad 10's format: outline, stack-up, footprints, tracks, vias, zones, nets, rules | The golden boards open in KiCad 10 and its own DRC reports no short and nothing unconnected (a test that runs where `kicad-cli` is installed) | M | | in flight |
| X2 | **KiCad schematic and project out.** Design: [kicad-export](design/kicad-export.md) §4. `.kicad_sch` as drawn (wires, labels, pages), a symbol library, `.kicad_pro` | The netlist KiCad exports from it equals 4k7's | L | X1 | open |
| X3 | **KiCad libraries in.** `.kicad_sym` and `.kicad_mod` read into part cards from the user's KiCad installation or a file, cross-checked like a datasheet import | "Use KiCad's footprint for this part" works and a pad that disagrees with the datasheet is flagged | M | | open |
| X4 | **A part by its LCSC number.** Pins and footprint from the EasyEDA component the stock check already reads, marked as the house's, checked against the datasheet where there is one | "Add C2040" gives a placed part without a PDF | M | | open |
| X5 | **KiCad project in.** First read-only: netlist, parts matched to cards, placement as fixed positions, copper as locked copper, every check run ("check my KiCad board"). Then editable | A KiCad 10 demo board loads and its findings are listed | L | X3 | open |
| X6 | **Mechanics in.** A DXF outline through `set_outline`; a housing as STEP that the enclosure script and the collision checks see | A board is fitted to a bought housing | M | | open |
| X7 | **Diff.** Two versions of a design compared in words (parts, values, nets, constraints, spec) and as an overlay; `4k7pcb diff a b` for git | A git diff of a project reads as a list of changes | M | | open |
| X8 | **Assembly variants.** Named variants with fitted or not and a value per part; BOM, pick-and-place and cost per variant | A 3.3 V and a 5 V build from one design | M | | open |
| X9 | **Hand-assembly page.** A BOM in the design document where a clicked line lights up its parts on the board | The page is in the downloaded document | S | | open |
| X10 | **IPC-2581 out** | A user's manufacturer asks for it | M | | open |

### P. Physics

| Id | What | Done when | Size | Needs | State |
|---|---|---|---|---|---|
| P1 | **Tolerances.** Worst case and RSS for dividers, RC times, LED currents and regulator outputs from the parts' tolerances; a finding when a spec item's band is left | A feedback divider of 5 % resistors against a ±2 % spec item is flagged | M | A1 | open |
| P2 | **Netlist and models.** A SPICE netlist of a block; a model slot on the part card with where the model came from; generic parts modelled from their parameters (ESR, DCR, tolerance) | A block of generic parts exports a netlist ngspice accepts | M | | open |
| P3 | **Simulator.** ngspice in a worker; a `simulate` tool (operating point, transient, AC, measurements) that returns numbers and a plot the agent and the user see | The agent answers "what is the ripple?" with a number | M | P2 | open |
| P4 | **Benches as checks.** A stored bench bound to a spec item, run again when its block changes; `SIM.FAIL`, and `SIM.UNMODELLED` where a part has no model | A changed inductor value turns a spec item red without anyone asking | M | P3, A1 | open |
| P5 | **Model work.** Vendor models fetched and tried against one figure of the datasheet before they are trusted; behavioural models for regulators and op-amps made from datasheet numbers and labelled as such | The golden briefs' ICs have models with provenance | L | P3 | open |
| P6 | **Copper areas solved.** Voltage drop and current density through pours and planes, which count as lossless today | A rail fed through a narrow neck of a pour is flagged | L | | open |
| P7 | **Clearance by voltage and loop area.** `DRC.CREEPAGE` from the nets' voltages and a chosen table; a `loop_area` constraint and check for switching loops. An aid, never a statement of compliance | A 230 V net 0.5 mm from a logic net is an error | M | | open |
| P8 | **Temperatures.** A steady-state map from the parts' losses and the copper, replacing the typical package limits where it knows better | The linear regulator check uses the board's copper | L | P6 | open |
| P9 | **Coupling.** A crosstalk estimate for long parallel runs; tuning by delay | When a design in the segment needs it | M | S1 | open |

### S. Scale

| Id | What | Done when | Size | Needs | State |
|---|---|---|---|---|---|
| S1 | **6 and 8 layers.** The houses' stack-ups, signal layers inside, striplines in the router and the `IMP.*` checks | The 6-layer golden brief routes and exports | L | Q4 | open |
| S2 | **Fine-pitch escape.** A fan-out stage for BGAs down to 0.65 mm with through vias; tented, plugged and capped vias as options of the fab profile and the fab notes | A 0.8 mm BGA of 100 balls escapes on 4 layers | L | S1 | open |
| S3 | **Dense boards.** Decided on Q4's numbers: push-and-shove in the present router, or a second engine behind the same `route` op | Routed connections on the benchmark rise to the reference's | L | Q4 | open |
| S4 | **Replicated blocks.** `replicate` a block n times with the same placement and copper (what `import_board` carries over, inside one design) | Eight identical channels are laid out once | M | | open |
| S5 | **Patterns.** `arrange` parts on a ring, grid or line | A ring of 24 LEDs is one op | S | | open |
| S6 | **300 to 500 parts.** Benches at that size; fix what they show (ARCHITECTURE.md §4 names SVG and TypeScript as what to revisit) | An edit stays under a second at 500 parts | M | | open |

### L. Life after the files

| Id | What | Done when | Size | Needs | State |
|---|---|---|---|---|---|
| L1 | **Firmware hand-off.** The pin map as a query, then as a C header and a devicetree overlay; a guide for terminal agents that keep a firmware repository in step with pin swaps | A swap accepted in 4k7 changes `pins.h` in the same agent turn | M | | in flight (#260) |
| L2 | **Bring-up session.** Measured values, typed or photographed, held against what the power tree and the benches expect; a diagnosis; errata stored in the design | A rail that reads low is recorded with its cause and its fix | M | | open |
| L3 | **Revisions.** A design marked as ordered (rev A, its fingerprint frozen); rev B starts from the open errata; the document lists what changed since | The rev B golden brief passes | M | X7, L2 | open |
| L4 | **Proven blocks.** An index of the blocks of all projects with whether their board was built and brought up; the agent searches every project and prefers a proven block | "A 3.3 V buck" returns the user's own block that worked on rev A of another board | M | L2 | open |
| L5 | **House rules from corrections.** When the user corrects the same thing a second time, the app offers to add it to their notes | The offer appears and the note is in the next turn's context | S | | open |

## 6. Order

The tracks do not depend on each other except where "Needs" says so, and one package per track can be in
flight at once. Where one thing must be chosen, this is the order, each milestone with what it proves:

| Milestone | Packages | It is reached when |
|---|---|---|
| **1. Says what it built** | Q1, A1, A2, Q2, Q3, Q5; L1 finishing | No golden brief ends as done with a spec item unmet and unreported |
| **2. A second pair of eyes** | Q6, A3, A4, A7, A8 | Reviewers find seeded faults no check finds, and their wrong findings are counted |
| **3. You can leave, and bring things** | X1, X2, X3, X4, X7 | A golden design opens in KiCad 10 with the same netlist, and a KiCad library part is used in 4k7 |
| **4. Proved before built** | P1, P2, P3, P4, A5; P5 begins | A spec item on a voltage or a time is verified by a bench that reruns by itself |
| **5. Choices** | A6, X8, S4, S5, A9 | An architecture question is answered with compared variants |
| **6. Bigger boards** | Q4, S1, S2, S3, S6 | The 6-layer brief with a BGA routes and exports |
| **7. Past the Gerber** | L2, L3, L4, L5, A10, X5, X6, P6, P7, P8 | A rev B is made from the errata of a board that was on the bench |

Milestones 1 and 2 come first because every later package is judged with what they build: a simulator
without a spec has nothing to assert, and explorations without a scorecard have nothing to compare.

## 7. Not planned, and why

- **Manual drawing and routing tools.** The canvas stays for pointing and hinting (ARCHITECTURE.md §3.4).
  KiCad export is the manual mode.
- **Buses and hierarchical sheet symbols.** They help a person draw. Blocks, `replicate` and labels do
  their work here.
- **A simulator the user drives**: schematic probes, a waveform workbench. The agent's benches and a plot
  per answer instead.
- **3D field solvers** for signal integrity and EMC. Export to one where needed.
- **Blind and buried vias, microvias, rigid-flex.** Until a design in the segment needs them.
- **Importers for Altium, Eagle, OrCAD.** Through KiCad, which has them.
- **Hosted editing and real-time collaboration** (the old M5). Files, git, the diff (X7) and the design
  document instead. To be looked at again when two people ask for it.
- **A parts database of our own.** The houses' catalogues, the datasheets and KiCad's libraries.
- **A hosted model or metered credits.** Unchanged from ARCHITECTURE.md §1.

## 8. Decisions for the owner

| # | Decision | Proposed | State |
|---|---|---|---|
| D1 | The segment of §1 | As written | decided 2026-11-27: as written |
| D2 | KiCad export and import, against the non-goal in ARCHITECTURE.md §1 | Yes; the non-goal is rewritten in X1's last pull request | decided 2026-11-27: yes |
| D3 | Simulation in the core (an ngspice build in the download) instead of only through a user's MCP server | In the core, loaded on first use. The licences of what the WebAssembly build bundles are checked in P3 | open |
| D4 | What a violated spec item does to `propose` | It is refused unless the item is waived or the agent names it and the reason in `spec_open`, as for open connections ([spec](design/spec.md) §5) | open |
| D5 | When reviewers run, since they cost tokens | At gates and on request, not on every change; cost shown per run | open |
| D6 | Pull request #260 cites a `MARKET_REVIEW.md` with items such as C5 that is not in the repository | Add it, and map its items to the ids here, so there is one plan | open |
| D7 | The order of §6 | As written; milestone 3 can move first if leaving matters more to early users than reviewing | open |

## 9. Working this plan

- Take the first `open` package of the current milestone whose "Needs" are done. One package, one branch,
  one or a few pull requests, as CLAUDE.md describes.
- An **L** package, and any package that adds a field to the design file, starts with its design doc in
  `docs/design/` as a pull request of its own.
- A package is done when its "Done when" holds and the change carries tests, the doc and the CHANGELOG
  entry. The same pull request sets its State here, and moves what is now built into ARCHITECTURE.md §7.
- When a package turns out to be wrong or too large, change this file in a pull request of its own
  rather than working round it. Split ids with a letter (A3a, A3b).
- New ideas go into the table of their track with a State of `open`, or into §7 with the reason.

## Sources

Read on 2026-11-26. Vendor pages describe their own products and those of competitors as the vendor sees them.

- KiCad 10: [release note](https://www.kicad.org/blog/2026/03/Version-10.0.0-Released/),
  [CNX Software's summary](https://www.cnx-software.com/2026/03/22/kicad-10-release-dark-mode-graphical-drc-rule-editor-new-file-importers-and-more/),
  [AISLER on design blocks, variants and via protection](https://community.aisler.net/t/kicad-10-is-live-and-100-supported-by-aisler/5567),
  [kicad-buddy on the IPC API's missing schematic commands](https://pypi.org/project/kicad-buddy/).
- Flux: [February 2026 agent update](https://www.flux.ai/p/blog/10x-faster-self-correcting-feb-2026-update),
  [Copilot overview with the simulator tool](https://www.flux.ai/docs/copilot/overview),
  [ProtoFlow's comparison of free AI tools](https://www.protoflow.ai/compare/free-ai-pcb-design-tools) (a competitor's page; the KiCad export remark is theirs).
- Quilter: [product page](https://www.quilter.ai/product),
  [BGA fan-out announcement](https://www.accessnewswire.com/newsroom/en/electronics-and-engineering/automated-bga-fanout-headlines-quilters-2026-releases-that-expand-the-c-1188028),
  [SemiWiki interview](https://semiwiki.com/eda/quilter/376102-ceo-interview-with-sergiy-nesterenko-of-quilter-on-ai-pcb-layout/).
- Code-first: [tscircuit autorouter](https://github.com/tscircuit/tscircuit-autorouter/wiki),
  [its fan-out stage](https://github.com/tscircuit/core/pull/2889),
  [Diode on Zener](https://blog.diode.computer/anthropic-partnership).
- Enterprise: [Cadence AuraStack](https://www.cadence.com/en_US/home/tools/pcb-design-and-analysis/aurastack-ai-super-agent.html).
- Simulation in the browser: [EEcircuit](https://github.com/eelab-dev/EEcircuit) and its `eecircuit-engine` package (ngspice as WebAssembly).
