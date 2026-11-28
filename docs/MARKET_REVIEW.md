# Market review: professional PCB layout and 3D tools, and where 4k7 fits

Read-only review on `bot/market-review` (main @ 28447ba), 2026-11-24. PR #250 (`import_board` placement, pins,
keep-outs, graphics, panel) is taken as landed; D29 step 5 (copper on import) is not proposed here. Nothing was
implemented.

**Sources.** Web search was available. The competitor facts in §1 were collected on 2026-11-24 by three research
passes; most come from search-result summaries of the linked pages, not from a full read of each page, so check a
price on the vendor's page before quoting it. Prices marked *reseller* or *third party* are not the vendor's own.
"Not found" means absent from the pages read, not proven absent. Claims about 4k7 carry a `file:line`.

Size: S ≈ < 1 day / < 300 lines, M ≈ 1–3 days, L = more. ⚖ = a decision for Martin.

## Status and roadmap ids

Added to the repository on 2026-11-28 (decision D6 of [ROADMAP.md](ROADMAP.md) §8), so that there is one plan:
[ROADMAP.md](ROADMAP.md) is that plan, and this review is one of its sources. The items of §4 map to its ids as below;
an item without an id is multi-board work outside the roadmap's tracks. The questions of §6 that the roadmap
answered: Q1 (KiCad export) by D2, Q2 (the buyer) by D1. The review below is left as it was written on 2026-11-24.

| Item of §4 | Roadmap id | State |
|---|---|---|
| 1. Current through a mate | none | done: [#251](https://github.com/hoihu/4k7/pull/251), [#269](https://github.com/hoihu/4k7/pull/269) |
| 2. Stack clearance | none | done: [#252](https://github.com/hoihu/4k7/pull/252), [#266](https://github.com/hoihu/4k7/pull/266) |
| 3. System power view | none (IR drop across a mate later touches P6, P8) | PR 1 and 2 done: [#254](https://github.com/hoihu/4k7/pull/254), [#257](https://github.com/hoihu/4k7/pull/257); PR 3 (IR drop to a load on another board) open |
| 4. Combined BOM and cable sheet (C6) | none | done: [#253](https://github.com/hoihu/4k7/pull/253), [#268](https://github.com/hoihu/4k7/pull/268), [#270](https://github.com/hoihu/4k7/pull/270), [#271](https://github.com/hoihu/4k7/pull/271), [#272](https://github.com/hoihu/4k7/pull/272); a cable bend-radius check open |
| 5. Firmware pin map (C5) | L1 | first part done: [#260](https://github.com/hoihu/4k7/pull/260), [#267](https://github.com/hoihu/4k7/pull/267); the device-tree fragment and the guide text open |
| 6. Headless `check` and `diff` | X7 | open |
| 7. Pin-out co-design across a mate (C2) | none | open |
| 8. The bench loop (C1) | close to L2 | open |
| 9. Heat budget (C3) | close to P8 | open |
| 10. Priced what-if (C4) | close to A6 | open |

## 1. Survey

### 1.1 Incumbent suites

**Altium (Designer inside Altium Develop / Agile; owned by Renesas since 2024-08)**
- Altium Designer is no longer sold alone; it comes in Develop or Agile. Develop: $995 per author plus a $995
  platform fee, so about $1,990/yr for one author ([altium.com/develop/pricing](https://www.altium.com/develop/pricing);
  the total is from [G2](https://www.g2.com/products/altium-altium-designer/pricing), third party). Agile: quote only.
- Develop includes Multi-board Assembly, Harness Design, MCAD CoDesign, requirements, a live BOM and browser review
  (same page). Multi-board: one module per board on a system schematic, an assembly editor, pin-level connection
  ECOs ([altium.com](https://www.altium.com/altium-designer/features/multi-board)).
- CoDesigner syncs board shape, holes, components and multi-board assemblies with SolidWorks, Creo, Inventor,
  Fusion, NX and Onshape ([altium.com/mcadplugins](https://altium.com/mcadplugins)). It replaced SolidWorks PCB,
  which was retired in 2021–2023 ([Altium FAQ](https://www.altium.com/documentation/altium-codesigner/moving-from-solidworks-pcb-connector-faqs?version=4.1)).
- IR drop and current density are a separately licensed add-on (Power Analyzer by Keysight, no public price).
- AI: an "AI Requirements Assistant". Official MCP servers are listed as "coming soon" (third party:
  [JLCPCB blog](https://jlcpcb.com/blog/altium-mcp-how-to-design-a-real-pcb-with-gpt-6-and-codex)).
- Workflow: hand-drawn schematic, interactive routing, rules in a constraint manager. The reference for a
  professional generalist.

**Cadence Allegro X / OrCAD X**
- No public price. Reseller figures: OrCAD X from $2,088/yr, Allegro X from $5,707/yr
  ([GoEngineer](https://www.goengineer.com/en-us/guide-to-buying-cadence-pcb-design), undated).
- In-Design Analysis runs Sigrity engines (IR drop, impedance, return path) inside the layout; Celsius does
  thermal ([Cadence blog](https://community.cadence.com/cadence_blogs_8/b/pcb/posts/using-in-design-analysis-to-cut-pcb-design-cycles-in-half)).
- System Capture is built for multi-board systems ([datasheet](https://www.cadence.com/en_US/home/resources/datasheets/allegro-system-capture-ds.html)).
- AI: Allegro X AI (placement and routing, 2023); "AuraStack" agent platform announced 2026-07, priced by
  consumption on top of the licences (secondary sources: [AAC](https://allaboutcircuits.com/news/cadence-claims-industry-first-agentic-ai-platform-for-pcb-and-advanced-packaging),
  [Futurum](https://futurumgroup.com/?p=92716)).

**Siemens Xpedition / PADS Professional**
- Quote only. PADS Pro Essentials and Xpedition Standard launched 2025-05; Essentials includes Celus-based
  schematic generation ([Siemens](https://news.siemens.com/de-de/siemens-pads-pro-xpedition-ai/)).
- Multi-board: partitioning, connector and wiring management, pin-to-pin tracking across boards
  ([Siemens](https://www.siemens.com/en-gb/products/pcb/model-based-systems-engineering/multiboard-design/)). The
  strongest inter-board connector story found.
- AI: Fuse EDA AI Agent (2026-03) drives Xpedition and HyperLynx ([Siemens](https://news.siemens.com/en-us/siemens-fuse-eda-ai-agent/)).

**Zuken CR-8000 / eCADSTAR**
- CR-8000 Design Force: native 3D multi-board with true-shape collision and clearance checks between boards and
  the enclosure ([Zuken](https://www.zuken.com/us/product/cr-8000/3d-multiboard-pcb-design/),
  [tech tip](https://www.zuken.com/en/blog/tech-tip-3d-collision-and-clearance-checks)). Quote only.
- AIPR: Zuken itself calls it ML-assisted place and route, not an AI router
  ([AAC, 2026-11-03](https://allaboutcircuits.com/news/zuken-bakes-ai-into-pcb-design-to-free-up-designer-for-creative-tasks)).
- eCADSTAR: a store page lists an Engineer tier from about €890/yr ([Zuken](https://discover.zuken.com/?p=401));
  possibly a promotion, unverified.

**KiCad** (free, GPL)
- 10.0 released 2026-03-20: design variants, PCB design blocks, a graphical DRC rule editor, time-domain tuning
  ([kicad.org](https://www.kicad.org/blog/2026/03/Version-10.0.0-Released/)).
- KiCad 11 (expected early 2027) has merged schematic/PCB diff and merge and a headless API server
  ([forum](https://forum.kicad.info/t/post-v10-new-features-and-development-news)).
- No native multi-board ([forum](https://forum.kicad.info/t/multi-board-support-for-kicad-project/71040)), no
  built-in PDN or thermal. No built-in AI; community MCP servers drive it through the IPC API
  ([KiCAD-MCP-Server](https://github.com/mixelpixx/KiCAD-MCP-Server)). A JLCPCB walkthrough of one reports
  overlapping parts and advises a git-tracked folder ([JLCPCB](https://jlcpcb.com/blog/kicad-mcp-how-to-design-a-pcb-with-claude-code)).
- 3D: STEP and other exports with copper options; StepUp for FreeCAD pulls and pushes outline and positions by hand
  ([kicad.org](https://kicad.org/external-tools/stepup/)).

**Autodesk Fusion Electronics** (EAGLE ended 2026-06-07, [Autodesk](https://autodesk.com/eagleannouncement))
- $680/yr or $85/mo with electronics included ([Autodesk FAQ](https://www.autodesk.com/solutions/autodesk-fusion-subscription-faq)).
- The one tool with ECAD and MCAD in a single product: outline from an enclosure sketch, parts moved in 3D and
  synced back ([help](https://help.autodesk.com/cloudhelp/ENU/Fusion-ECAD/files/ECD-SYNC-2D-AND-3D-TSK.htm)).
  Users report the sync not updating ([forum](https://forums.autodesk.com/t5/fusion-electronics-forum/3d-board-outline-does-not-update-after-push-to-3d/m-p/13866169)).
- No native multi-board system design and no electronics AI feature found.

**EasyEDA / EasyEDA Pro (LCEDA)**
- The editor is free, also commercially; paid plans are for services, Premium $19.9/mo
  ([easyeda.com/pricing](https://easyeda.com/pricing)). Tied to the LCSC library and JLCPCB ordering.
- "3D Shell": a simple enclosure drawn from an outline on a board layer, exported as STEP/STL, with a path to
  JLC3DP ([docs](https://prodocs.easyeda.com/en/pcb/place-3d-shell-outline/)). A user asks for clearance and
  collision warnings ([forum](https://easyeda.com/forum/topic/3D-shell-707b04aee96048eb90217c301b101368)). This is
  the closest thing to 4k7's enclosure in a mainstream tool.
- An extension API plus an "API skill" lets coding agents edit designs over a local WebSocket
  ([JLCPCB blog, 2026-11-09](https://jlcpcb.com/blog/ai-tools-for-pcb-design), vendor-affiliated).

### 1.2 Newer and AI-native players

| Tool | What it does | Price | Gaps relevant to 4k7 |
|---|---|---|---|
| **Flux.ai** | Browser EDA with an in-app agent; $37M raised 2026-02 ([Flux](https://www.flux.ai/blog/we-raised-37m-to-take-the-hard-out-of-hardware)) | Plans on [flux.ai/p/pricing](https://www.flux.ai/p/pricing) showed no numbers when fetched; a tracker gives $100–$500/mo with metered agent credits ([PricingSaaS](https://pricingsaas.com/companies/flux), unconfirmed) | Closed agent, hosted; no public MCP, multi-board or enclosure found |
| **Quilter** | Placement and routing from a finished schematic, several candidates, returned to Altium/Allegro/Xpedition/KiCad | Per project by pin count, quote only ([pricing](https://www.quilter.ai/pricing)) | No schematic. Its 843-part demo was two boards, with no inter-board check stated ([VentureBeat](https://venturebeat.com/ai/quilters-ai-just-designed-an-843-part-linux-computer-that-booted-on-the)) |
| **Celus** | Requirements to parts, reference schematic and BOM; hands over to an incumbent tool | Quote only ([celus.io](https://www.celus.io/)) | No layout |
| **JITX** | Design as Python code, run locally with "your approved AI", routing solvers | Free for open designs; proprietary is Enterprise, quote only ([pricing](https://jitx.com/pricing)) | Code-first; SI-heavy niche |
| **tscircuit** | Circuits as React/TSX, MIT, own autorouter, `tsci check` | No public price ([tscircuit.com](https://tscircuit.com/)) | Enclosures not documented |
| **atopile** | `ato` language, part picking by constraint solver; layout stays in KiCad | Open core ([GitHub](https://github.com/atopile/atopile)) | No own layout |
| **DeepPCB** | Reinforcement-learning router, cloud | $30 for 1 h of compute, up to 8 layers and 2,200 pins ([pricing](https://deeppcb.com/pricing/)) | Routing only |
| **Diode Computers** | Starlark schematic language, MIT `pcb` CLI with an MCP layer; sold as a design service | "From $10,000 per design" for Enterprise ([diode.computer](https://www.diode.computer/)) | A service, not a tool the user steers |
| **Circuit Mind** | Block diagram to schematic; agents check schematics against datasheets ([TNW](https://thenextweb.com/news/circuit-mind-25m-funding-ai-circuit-board-design)) | Quote only | Closest to 4k7's datasheet checks; no layout |
| **AllSpice.io** | Git review for hardware with a review agent | Enterprise from $34,800/yr ([llms.txt](https://www.allspice.io/llms.txt), from a search summary) | Review only, on other tools' files |

Sentiment (thin: two EEVblog threads): LLMs are useful for checklists, BOM and netlist edits, weak at spatial
layout, and "verification is the hard part" ([EEVblog](https://www.eevblog.com/forum/eda/claude-code-for-pcb-design/msg6215087/)).
That is the argument for 4k7's kernel.

### 1.3 3D and MCAD–ECAD

- **Exchange.** IDF is a full-file 2.5D handoff with no history. IDX (EDMD) sends incremental proposals with
  accept/reject and persistent ids, and is supported by Creo, CircuitWorks and Siemens
  ([Siemens](https://blogs.sw.siemens.com/electronic-systems-design/2024/10/08/development-of-the-ecad-mcad-collaboration-idx-standard/)).
  STEP is the common denominator and a dumb solid. Semantic sync exists only in the paid tiers (CoDesigner, IDX).
- **CircuitWorks** ships with SolidWorks Professional and Premium and reads IDF and IDX
  ([SolidWorks](https://help.solidworks.com/2024/English/SolidWorks/circuitworks/c_CircuitWorks_overview.htm)).
- **Box generators.** YAPP_Box (OpenSCAD) takes hand-typed parameters ([GitHub](https://github.com/mrWheel/YAPP_Box));
  TurboCase derives a case from a KiCad board ([Hackaday](https://hackaday.com/2024/06/03/turbocase-generates-a-pcb-shell-for-you)).
  No mature board-to-enclosure tool was found. Zoo's text-to-CAD has no PCB-aware feature found.
- **Thermal.** Celsius, Flotherm XT and Icepak are enterprise tools. The cheap end is KiCad plugins that estimate
  copper heating ([KiCad Copper Thermal](https://forum.kicad.info/t/new-plugin-kicad-copper-thermal/72454)).

### 1.4 What the survey says

1. Multi-board with checked connectors is an enterprise feature (Siemens, Cadence, Zuken, Altium at about
   $2k/yr). KiCad, Fusion, EasyEDA and every AI-native tool found lack it.
2. The incumbents shipped closed, metered agents in 2026. Open agent access is community MCP on KiCad or an
   extension API. None found pairs an open agent interface with a kernel that refuses a broken change.
3. Built-in current and heat analysis is an add-on or a high-end engine.
4. An enclosure made from the board, with fit checks, exists nowhere else found. EasyEDA's users ask for it.
5. Nobody found follows the board past the fab order (bring-up, test, firmware hand-off).

## 2. Gap map

### 2.1 What 4k7 has that is competitive or distinctive

| Capability | Where | Against the market |
|---|---|---|
| Several boards, mates checked pin by pin (`ERC.MATE_*`, `ERC.BOARD_CROSSING`), stack pairing from footprint geometry | `packages/kernel/src/mates.ts:81`, `:161`; `docs/design/multi-board.md` §3 | Enterprise-only elsewhere |
| Assembly position derived from the stack mate; 3D and STEP of all boards | `packages/kernel/src/assembly.ts:93`; `packages/fab/src/step.ts:334` | Altium and Zuken place boards by hand in an assembly editor |
| One scripted enclosure for all boards with collision, opening, hold, lid, print and warp checks | `packages/fab/src/csg/check.ts:55`; `docs/design/enclosure.md` §5.2; `docs/design/mechanics.md` §4.1 | Unique at this price; EasyEDA's shell has no checks |
| Current against copper, IR drop, spoke current, heat map | `packages/kernel/src/current.ts:111`, `:958`; `apps/web/src/lib/currentMap.ts` | A paid add-on in Altium; absent in KiCad |
| Power tree, LDO dissipation, GPIO current, bring-up sheet | `packages/kernel/src/powertree.ts`; `checks.ts:341`, `:439`; `bringup.ts` | Not found in any tool surveyed |
| Field-solved impedance, pairs, length tuning, `IMP.*` checks | `packages/kernel/src/impedance.ts`; `pairroute.ts`; `tune.ts` | On par with mid-range tools for simple cases |
| Production files read back and checked against the netlist; IPC-D-356A | `packages/fab/src/netcheck.ts`; `ipc356.ts` | Normally a separate CAM tool |
| Sourcing, stock and full-fee cost at three houses, per board and summed | `packages/parts/src/cost.ts:321`, `:464`; `docs/design/multi-board.md` §5 | Deeper than Octopart-style lookups; EasyEDA covers one house |
| Parts from datasheets with deterministic generators and cross-checks | `packages/parts/src/ingest.ts`; `packages/kernel/src/xcheck.ts` | Circuit Mind checks; nobody generates |
| Typed ops, transactions, dry runs, reviewable changesets with per-board hunks, any agent over MCP | `packages/schema/src/ops.ts`; `packages/kernel/src/diff.ts`; `packages/schema/src/tools.ts:383`; `README.md` (Bring your own AI) | Incumbent agents are closed and metered |
| Reuse across projects: `import_block`, `import_board` | `packages/kernel/src/importops.ts` | Like KiCad 10 design blocks, but with net joining |
| Local files, no account | `README.md` (Local-first) | Flux, Quilter, Altium 365 are cloud |

### 2.2 Missing and worth adding

Each is expanded in §3 or §4.

- **Current through a mate.** `multi-board.md:119` says a power net's current through a mate is checked against
  the connector's per-pin rating. The code does not do it: `mateChecks` (`mates.ts:161`) emits only the five
  `ERC.MATE_*`/`BOARD_CROSSING` codes, `current.ts` never mentions a mate, and a pin's `maxCurrent`
  (`packages/schema/src/part.ts:32`) is read only for output pins (`checks.ts:335`). Doc and code disagree; the
  code is the truth. Under-pinned power across a header is the second classic two-board fault after the mirrored
  header.
- **Stacked boards colliding.** Nothing checks board B's parts against board A's parts or PCB. The only collision
  check is enclosure pieces against the assembly (`csg/check.ts:55`), and it needs a script. `assembly.ts` places
  boards and checks nothing. Zuken sells this.
- **System power view.** `powertree.ts` and `bringup.ts` have no notion of boards or mates (no match for either
  word in the two files). The tree is design-wide because nets are, but it does not say which rail crosses which
  connector, and the bring-up sheet does not order the boards.
- **A combined BOM and the cable itself.** Not built (`multi-board.md:248`). A `cable` mate stores a length
  (`ops.ts:155-171`) that no output reads (no `mate` in `packages/fab/src/zip.ts` or the BOM writers).
- **A place for a cable's board and a standing `edge` board.** Not built (`multi-board.md:192`, `:196`).
- **Both boards on one panel.** Open question (`multi-board.md:260`; `panel.md:164`). The cost check already knows
  what the second setup costs (`cost.ts:464`).
- **A DC solve of pours and planes.** Not built (`layout.md:1107`): a necked pour "looks fine here".
- **Headless check and diff.** The CLI only serves the app or MCP (`tools/server/src/cli.ts:4-8`). The kernel is
  synchronous and deterministic (`kernel.ts:3`) and already diffs designs (`diff.ts`). KiCad 11 and AllSpice show
  the demand.
- **Variants.** "try a 2-layer variant" is not built (`ARCHITECTURE.md:122`); DNP is one flag
  (`assembly.md:203`). KiCad 10 has design variants.
- **Voltage-dependent clearance (creepage).** No match for "creepage" in any `packages/*/src`. Nets carry a
  voltage, so the data is there.
- **More than 4 layers.** `fab-rules.md:143`. The stated goal is 2–16+ (`ARCHITECTURE.md:14`). Worth it only when
  a real design asks.

### 2.3 Not worth chasing

- **Interactive routing, push-and-shove, a constraint-manager UI.** Twenty years of polish in every incumbent, and
  against the product shape (`ARCHITECTURE.md:20`).
- **Import of KiCad/Altium/Eagle projects.** A stated non-goal (`ARCHITECTURE.md:18`) and an endless
  compatibility job. One-way *export* is a different question (⚖ Q1).
- **IDX or CoDesigner-style live MCAD sync.** It serves teams with a mechanical engineer on a paid MCAD seat.
  4k7's user gets the box from the same tool. STEP out is enough.
- **Full SI/PI/EMC and CFD thermal** (Sigrity, HyperLynx, Celsius). Estimates that say "unknown, never fine" fit
  4k7; a solver race does not.
- **SPICE inside the product.** An MCP server the user attaches does this (`ai-loop.md:101-105`).
- **Rigid-flex, HDI, blind and buried vias, back-drilling, embedded parts.** High-end fabrication the three
  supported houses' cheap tiers do not serve.
- **Cloud workspace, PLM, requirements management, user roles.** Altium Develop's ground. A local file in git
  covers 4k7's users.
- **A hosted agent with credits.** Flux's most-cited complaint, and a non-goal (`ARCHITECTURE.md:19`).
- **A trained router** (DeepPCB, Quilter). 4k7's lever is the agent steering a deterministic router.

## 3. Creative ideas

Each works on several boards; the tests use `twoBoards()` (`packages/kernel/test/fixtures.ts:59`) unless said.

### C1. The bench loop: the tool follows the board to the bench

**What.** Two pieces. (a) A printable test jig: the enclosure engine already knows every board, hole and part
(`csg/board.ts:106`), and test points have known positions (`testpoints.ts`). A library function `probe_plate(board)`
makes a plate with locating pins in the mounting holes and a pogo-pin bore over each test point. (b) Bring-up as
a conversation: the user types what they measured ("3V3 reads 0.4 V"), and a query `diagnose { net, measured }`
answers from the netlist and the power tree: what feeds the rail, which enable pin, which parts could short it,
where to probe next, lit up on the board.

**Why here.** No tool surveyed goes past the fab order. 4k7 has the bring-up sheet, the power tree, the test
points and a CSG engine in one process. An external agent can bring its own instrument MCP server (mode C,
`README.md`), so a bench supply or multimeter can answer instead of the user.

**Several boards.** One plate per board (`pcb(board)`). Bring-up order: the board with the source alone, then
each mated board, with the expected current step when it is plugged in.

**Effort.** M for (a), M for (b). **First PR:** `probe_plate` for top-side test points in `csg/board.ts`, with a
test that every bore is over its pad on both boards of `multiboard-enclosure.test.ts`'s design. Bottom-side
test points (`layout.md:84`) come later.

### C2. Pin-out co-design across a mate

**What.** On a board-to-board connector the signal-to-pin assignment is free: nobody cares whether SDA is on pin
3 or 7, as long as both sides agree. `suggest_moves` gains a move: exchange two signal pin pairs of a mate, on
both connectors at once, scored by the ratsnest score of both boards (`refine.ts`, 4 × crossings + mm + congestion).

**Why here.** A person fixes one board's connector, then discovers the other board now crosses. The mate knows
both sides and the pin map, and `swap_pins` (`ops.ts:90`) already keeps schematic and board in step. Siemens
tracks pin-to-pin across boards; a search that optimises both boards was not found anywhere.

**Several boards.** It is a several-board feature. On one board it does nothing.

**Effort.** M. **First PR:** a pure function `matePinSwaps(d, mate)` listing the legal exchanges (signal pins
only, never power or ground, and only those with equal per-pin ratings) and each one's score on both focuses.
No op yet. Test: a fixture with two deliberately crossed signals finds the exchange that uncrosses both boards.

### C3. "Will the box run hot": a power-to-enclosure heat budget

**What.** `get_thermal`: per board the dissipation the kernel can state (LDO loss from the power tree, copper loss
from the current check, stated loads), summed for the assembly, and a lumped estimate of the air temperature rise
inside the box from its surface area and material, which the enclosure report already measures. Anything
unstated is "unknown", as everywhere else (`powertree.ts:5`). Later: a 2D spreading solve per board. The
impedance solver is already a conjugate-gradient Laplace solver on a grid (`impedance.ts:5-6`), which is the same
mathematics.

**Why here.** Enterprise tools answer this with CFD. Cheap tools do not answer it. An order-of-magnitude answer
with stated unknowns is what a first product needs, and the agent can act on it (vents in the script, a buck
instead of an LDO).

**Several boards.** The budget is per board and per box. A stacked board above a hot one is named.

**Effort.** M for the budget, L for the solve. **First PR:** dissipation per board in `get_power_tree`'s answer
(a `board` per rail and a `dissipation_w` sum per board), tested on two boards. No temperature yet.

**Risk.** A number looks more certain than it is. Give a range and the assumptions, and never an all-clear.

### C4. One board or two? A priced what-if

**What.** `try_split { sheets }` (a query, no change): the kernel prices the design as it is and with the named
sheets on a second board: both orders' fees, the connectors a split adds, each board's size from a trial
placement (`trial.ts`). The reverse for merging. The same shape answers "2 or 4 layers" and "JLCPCB or
Eurocircuits".

**Why here.** The guide tells the agent a split costs a second setup (`boards.md` §1), but the agent cannot get the
number without doing the split. The cost check is per board and summed (`cost.ts:464`), queries already run on
copies (`try_placements`), and a branch is the thing `ARCHITECTURE.md:122` says is missing. No incumbent prices an
architecture choice.

**Effort.** M–L (the catalogue lookups live in the app, not the kernel). **First PR:** a kernel helper that runs
a transaction on a copy and returns the board summaries of both, used by a `try_variant { ops }` query that
reports the diagnostics delta and board sizes only. Cost is added in a second PR. Test: adding a board in the
variant leaves the open design's format at 2.

### C5. The firmware hand-off

**What.** `get_pinmap`: for each MCU pin its net, the function in use, and what it reaches, through mates onto
other boards ("PA5 → SCK → J1.4 ⇄ J2.4 → U3.SCK on Display"). Emitted as JSON and a C header.

**Why here.** Part cards hold pin functions (`part.ts:189`), mates hold the pairs (`matePairs`, `mates.ts:81`).
Firmware people keep this table by hand in every tool surveyed. The users of tscircuit, atopile and of 4k7's
coding-agent modes write firmware in the same terminal.

**Several boards.** Tracing through the mate is the point. A signal that crosses a mismatched mate is flagged.

**Effort.** S. **First PR:** the query and its text form, tested on `twoBoards()` with a signal that crosses the
mate.

### C6. The cable as a part of the design

**What.** From `cable` and `wire` mates: a cable sheet in the design document (both ends, pin to pin with net
names and wire colours, length, the mating housings and crimps), the cables as BOM lines, and a bend check in the
enclosure (a swept tube of the cable's minimum radius between the two connectors' mating paths).

**Why here.** Altium has a separate harness editor. Here the mate already knows the pin map and the length, and
`set_mating` knows where the plug comes from (`ops.ts:287`). The cable is one more derived output.

**Effort.** S for the sheet, M with BOM lines and the bend check. **First PR:** the cable table in the design
document from `Design.mates`, with a test on a reversed FFC.

### C7. Box first

**What.** A small catalogue of bought enclosures (for example Hammond 1551/1591 sizes) as data: inner cavity,
boss positions, the lid's depth. `fit_box { box }` proposes the outline, the mounting holes and a height limit
per area, and the enclosure script becomes the bought box with its cut-outs. For several boards: which boards go
on which bosses.

**Why here.** Fusion and CoDesigner push an outline from MCAD, which needs an MCAD seat and a modelled box. Most
small products go into a bought box. 4k7 has `set_outline`, `add_hole`, keep-outs and the script engine.

**Effort.** M. **First PR:** the catalogue format with two boxes and a query that answers the outline and holes
that fit, without changing the design. ⚖ Q5: dimensions from makers' drawings are facts, but check the terms.

## 4. Ranked shortlist

Ranked by what a user with a two-board product feels first, against size. "MB test" says how several boards are
tested. Every PR carries its doc update and, where a user sees it, a CHANGELOG entry.

**1. Current through a mate (gap, S).** Depends on nothing.
- PR 1: `ERC.MATE_CURRENT`: for each power net crossing a mate, the mated pins on it times the per-pin rating
  against the net's `max_current` or the far board's stated loads; unknown when the card has no rating. Fix
  `multi-board.md:119`. MB test: a 2 A rail on one 1 A pin is an error, on three pins clean, without a rating
  "unknown".
- PR 2: the datasheet import asks for a connector's contact rating; a line in `boards.md` §4.
- Risk: ratings missing on most cards, so it must not read as an all-clear.

**2. Stack clearance (gap, S–M).** Depends on nothing.
- PR 1: `ASM.COLLIDES`: part bodies (`body3d.ts`) and PCBs of every pair of placed boards, as boxes in the
  assembly frame; the mated connectors are exempt. MB test: a 12 mm electrolytic under a board stacked at 11 mm.
- PR 2: `ASM.CLEARANCE` warning under a set gap; the 3D view marks the pair.
- Risk: boxes over-report on odd bodies. Assumed mate heights (`assembly.ts:95`) give a warning, not an error.

**3. System power view (gap, M).** Helped by 1.
- PR 1: `get_power_tree` names each rail's boards and the mate it crosses. MB test on `powertree.test.ts`.
- PR 2: the bring-up sheet orders the boards. MB test on `bringup.test.ts`.
- PR 3: IR drop to a load on another board: first a test that pins down what `currentCheck` (`current.ts:111`,
  one board view) takes as the source when the regulator is on another board, which I did not trace; then carry
  the upstream drop across.
- Risk: PR 3 touches the current check's core. Keep one-board results identical (the existing suite is the guard).

**4. Combined BOM and cable sheet (C6, S–M).** Depends on nothing.
- PR 1: a combined BOM file beside the per-board ones. MB test: a part on both boards is one line with both
  quantities.
- PR 2: the cable table in the design document. PR 3: cables and mating halves as BOM lines.
- Risk: house BOM formats differ, so the combined file is for the user, not for upload.

**5. Firmware pin map (C5, S).** One PR as in C5, then a second for the C header and device-tree fragment.
- Risk: cards without `functions` give a plain net table. Say so in the answer.

**6. Headless `check` and `diff` (gap, S–M).** Depends on nothing.
- PR 1: `4k7pcb check <file>`: ERC, schematic-board checks and a non-zero exit, from the file alone. MB test: a
  two-board file with a mate mismatch exits 1 and names the board.
- PR 2: board checks (needs placement and the kept copper). PR 3: `4k7pcb diff <a> <b>` printing the changeset
  hunks, `board:b_2` and `mate:<id>` included (`multi-board.md` §8).
- Risk: checks that today run in the app's workers (the fab read-back) need a Node path. Start without them and
  say which ran.

**7. Pin-out co-design across a mate (C2, M).** Helped by 1 for the rating rule.
- PR 1 as in C2. PR 2: `suggest_moves` offers the exchange. PR 3: an op that applies it to both connectors in one
  transaction. MB test: both boards' crossings fall, `ERC.MATE_*` stays clean.
- Risk: a swap changes the schematic, so it stays a suggestion the user reviews.

**8. The bench loop (C1, M + M).** Helped by 3.
- PR 1: `probe_plate`. PR 2: bottom-side test points. PR 3: `diagnose` for a rail that reads wrong. MB test: one
  plate per board; a dead rail on the second board names the mate pin as a suspect.
- Risk: pogo-pin tolerances on a printed plate. State the pin type and bore in the guide.

**9. Heat budget (C3, M then L).** Depends on 3 PR 1.
- PR 1 as in C3. PR 2: the box estimate in the enclosure report. PR 3 (L): the spreading solve and a map layer.
- Risk: false comfort. See C3.

**10. Priced what-if (C4, M–L).** Depends on nothing; the largest.
- PR 1 as in C4. PR 2: cost for both sides. PR 3: `try_split`. MB test: the variant has two boards, the open
  design stays untouched.
- Risk: the cost lookups are asynchronous and outside the kernel.

Next in line, not in the ten: both boards on one panel (M–L, `panel.md:164`); the DC solve of pours (M,
`layout.md:1107`); box first (C7, M); creepage by net voltage (S–M); a place for a cable's board (S,
`multi-board.md:196`).

## 5. The earlier idea list (FEATURE_IDEAS.md, 2026-11-20)

All nine have shipped in some form, so none is repeated: the power tree and LDO check (`powertree.ts`,
`checks.ts:439`), read-back in the checks (`CHANGELOG.md:127-128`), DNP (`ops.ts:67`), test points and the
bring-up sheet (`testpoints.ts`, `bringup.ts`), block reuse (`reuse.ts`, `importops.ts`), rooms (`layout.md` §15),
fab notes (`fabnotes.ts`), pin and gate swaps (`ops.ts:90`), the plan step (`CHANGELOG.md:80`). What is left of
them and still holds: one "ready to order" verdict (idea 2's second half; item 6's `check` is its headless form),
named assembly variants (idea 3's ⚖), shipped recipes (idea 5's ⚖). Items 3, 8 and 9 above build on ideas 1 and 4.

## 6. Questions for Martin

- ⚖ **Q1. One-way KiCad export.** Import stays a non-goal. But "can I finish it by hand if the agent gets stuck"
  is the first question a professional asks of an AI tool, and Quilter answers it by handing back native files.
  Is a one-way board export (L) worth reopening `ARCHITECTURE.md:18`, or is the Gerber read-back enough?
- ⚖ **Q2. Who is the buyer?** The survey points at people who build small products of one to three boards in a
  box and cannot justify $2k/yr. Items 1–5 serve them. If the aim is the professional with a 6-layer board,
  layer counts beyond 4 move up and C1 and C7 move down.
- ⚖ **Q3. `multi-board.md:119`.** Build the mate current check (item 1), or strike the sentence now and build it
  later? I recommend building it: it is small.
- ⚖ **Q4. Heat as a number.** Is an estimate with stated unknowns acceptable in the product (C3), or does a
  temperature that can be 10 °C off do more harm than no number?
- ⚖ **Q5. Shipped data.** A catalogue of bought enclosures (C7) and, as before, shipped recipes: who maintains
  them, and may the dimensions be redistributed?
- ⚖ **Q6. Headless use.** Is a `check`/`diff` CLI (item 6) wanted as a product surface, with the support that
  comes with people running it in CI, or only as a developer tool?
- ⚖ **Q7. The bench.** Does 4k7 want to go past the fab order at all (C1)? It widens the product, and it is the
  one place no competitor found is standing.
