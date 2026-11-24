# Operation API (ops catalogue)

> Part of the [architecture](../ARCHITECTURE.md). Status: draft; §2 matches the shipped ops as of 2026-11-20.

The ops catalogue is the **only** way to read or change a design. The in-app agent, external
agents (through MCP), scripts, tests and the UI all use it.

## 1. Design rules for the catalogue

1. **Semantic, not geometric.** `connect(pins, net)`, not `add_wire(x1,y1,x2,y2)`.
2. **Reference by name or ID.** `"U1.VIN"`, `"U1.4"`, a net by its name (`"+3V3"`), a sheet or board by name or id. The kernel resolves names and returns the IDs it used.
3. **Batchable.** A `transaction` holds many ops and applies all or nothing.
4. **Dry-run first.** `dry_run: true` returns diff + diagnostics without committing.
5. **Explain refusals.** Every rejection has a `code`, a human `message`, the `entities` involved, and machine-readable `fix_hints` (ops that would resolve it).
6. **Small, queryable context.** Query ops let the agent ask for exactly what it needs, instead of receiving the whole design in the prompt.

## 2. Op groups

Every op the kernel accepts, as defined in `packages/schema/src/ops.ts` (edit ops in the EditOp union, applied in a
transaction; query ops in the QueryOp union, read-only). The field-level docs live in the schema; a test
(`packages/schema/test/ops-doc.test.ts`) fails when this list and the schema drift apart.

### Query

- `get_summary`: overview of the design.
- `find`: parts and nets by a substring of refdes, part id, value or net name, or by category.
- `get_component`: one component: part, parameters, package, pins with their nets, constraints.
- `get_net`: one net: its pins, track width (the width its current needs, per layer), how its copper carries its current, vias for its current, impedance rule.
- `get_diagnostics`: the design's current diagnostics (check results: the schematic's, `XCHK.*`, and the copper shorts of every board), errors first, then warnings and infos, the waived ones (marked with *waivedBy*) last. The answer is `{ diagnostics, found? }`. It lists at most 20 (*limit*, up to 200, from *offset*), narrowed to one *code* (exact, no prefix) or *severity* if those are given. When not all are listed, *found* counts them the way get_board's *drc_found* does (total, open, waived, matching, by code with the nets and parts each names most). It also says the call for the next page, e.g. `get_diagnostics { offset: 20, code: "ERC.PIN_UNCONNECTED" }`. Diagnostics carry no board, so there is no board filter. Code that needs the whole list (the app, which adds the production files' `FAB.*` findings before paging, and the eval) takes it from the kernel's `diagnostics()`. get_board and get_diagnostics share one paging helper (`packages/schema/src/board.ts`).
- `get_ledger`: the constraint ledger: every constraint with its strength and the user's words.
- `get_description`: the design description: overview, functional blocks with their parts, parts no block covers yet.
- `get_fab_profiles`: the built-in manufacturer profiles and the one this board uses. On several boards it takes *board*: the named board's profile and layers, or, with none named, every board's (*boards*), the presets once.
- `get_schematic`: the schematic drawing: pages, blocks, where each symbol and net label stands.
- `get_copper`: drawn tracks and vias with their ids, optionally by net or area.
- `get_board`: board outline, part positions, routing stats and DRC results; on a design of several boards, every board's, or the one named with its board argument (as `get_copper`, `get_current_map`, `try_placements` and `suggest_moves` take it). With *project* it reads another stored project's board as stored instead (§7). The open DRC findings come first in the answer, errors first, at most 20 of them; when there are more, *drc_found* counts them all by code (with the nets, or net pairs, and the parts each code names most) and says how many are not listed. The *drc* parameter pages them (*offset*, *limit* up to 200) and narrows them to one *code*, *net* or *ref* (a part, track or via), so every finding can be read however many there are; with several boards and none named, it applies to each board's list.
- `get_current_map`: the routed copper against each net's current: per net ok, unverified or unknown (and, with loads stated, the drop to the furthest load against 3 % of the rail), and the tracks and vias that do not carry it, worst first, with their fixes (see [layout](layout.md) §14).
- `get_power_tree`: what feeds what: per power rail its source, the series parts it is fed through, the rails it feeds, its loads, current budget and a linear regulator's dissipation (shape in §6).
- `try_placements`: compare arrangements of the main parts without changing the design.
- `suggest_moves`: small-part moves (turn, swap, shift) that close open connections, without applying them; and, under *swaps*, the pin and gate swaps the part cards declare that make the ratsnest shorter or cross less, each with its `swap_pins` op, the crossings and ratsnest mm before and after, and `schematic_change: true` (`layout.md` §10).
- `list_blocks`: the functional blocks of another stored project, to reuse one: parts, internal and boundary nets (shape in §7).
- `get_enclosure`: the enclosure brief, script, board API and last render report; on a large design an overview, with each part read on its own (part) and a long one in line ranges (lines) (`enclosure.md` §3).
- `get_guide`: an agent guide (schematic, cost, mechanics, high_speed, boards).

### Library

- `search_parts`: search the library by function, MPN or category.
- `get_part`: one part card.
- `set_symbol`: how a part's symbol is drawn (one symbol or units, and which pin goes where).
- `set_footprint`: a part's footprint from its datasheet (pads, body, height); applies to every component of that part.
- `set_pin_descriptions`: what a part's pins do, from the datasheet's pin table; goes back to the library part.
- `set_polarity`: which way round a part goes, marked on the silkscreen.
- `set_mating`: the face a connector, card slot or switch is used from and the plug's size.
- `rename_part`: a part's MPN shown on the symbol and in the BOM, and its human name.
- `set_package_defaults`: default packages for generic resistors, capacitors, inductors, diodes and LEDs.
- `set_value_series`: the E-series ranges of generic resistors, capacitors and inductors.

### Schematic (netlist)

- `add_part`: add a component from a part card, with parameters and sheet.
- `remove`: remove a component.
- `set_param`: set or remove a component's parameters. When a value changes the part's package (a generic part sized up for its capacitance, voltage, power or current), the effect says so, and on a routed board the copper its new land meets is among the introduced findings (layout.md).
- `set_dnp`: mark components do-not-populate, or fit them again (out of the BOM, the pick-and-place and the cost; still on the board).
- `rename`: change a component's reference designator.
- `connect`: put pins on a net.
- `disconnect`: take pins off their net.
- `swap_pins`: swap two pins, or two gates, of one component (`a: "U1.INA+", b: "U1.INB+"`): their nets, no-connect marks and net loads change places. Only inside a swap group the part card declares (`swapGroups`, `data-model.md` §2); a gate swap moves every pin of the gate (an op-amp channel's IN+, IN− and OUT), and the two pins named must sit at the same place in their gates. Refused (`SWAP_INVALID`) for pins of two components, a pin in no group, pins in different groups, two pins of one gate, a name on several pins, and gates of different lengths. In a group of MCU GPIOs (with *functions*), also when a net would move to a pin lacking a function its `set_net needs` names ("SCL needs SCL, which U1.PB0 does not offer (MOSI, DI, SDA, …)"), or, for a net without *needs*, to a pin offering other functions than its own (the message asks for `set_net needs` first). It changes the netlist, so the schematic, the board and drawn copper follow as for `connect`; Optimize refuses it.
- `no_connect`: mark pins as deliberately unconnected.
- `set_net`: rename a net and set its voltage, external/power flags, max current, the loads its pins draw (`loads: [{ pin: "U3.VDD", amps: 0.35 }]`, null clears; each pin must be on the net and draw more than 0 A; the current check splits the net's current over its copper from them, `layout.md` §14), track width (with *board*: its width on that board only, over the net's there; null with *board* clears it; an unknown board is refused with `BOARD_UNKNOWN`, *board* without *track_mm* with `INVALID_OP`; `multi-board.md` §4), how it is drawn, and on the board whether the router routes it first and the layer its tracks keep to (a cost, not a ban). *needs* (null clears): the MCU pin functions the net uses, named as in the card's swap group (`"GPIO"`, `"SCL"`, `"ADC*"` for any channel), which `swap_pins` checks.
- `describe`: the functional blocks (which group and order the schematic) and the design document text.
- `import_block`: copy one functional block of another stored project into this design, with every boundary net mapped to a net here (§7). Optional sheet and board fields put its parts straight onto that sheet and board. Refused (`NET_UNMAPPED`, `BLOCK_UNKNOWN`, `PROJECT_UNKNOWN`, `PART_UNKNOWN`, `SHEET_UNKNOWN`, `BOARD_UNKNOWN`) with nothing changed; the effect lists the renames and the values to recheck.

- `import_board`: copy a whole board of another stored project in as a board of this design (as: a new board, or an existing one with no parts), nets joined by name (§7). Refused (`PROJECT_UNKNOWN`, `BOARD_UNKNOWN`, `BOARD_INVALID`, `NET_UNKNOWN`, `PART_UNKNOWN`) with nothing changed; the effect lists joined, new and merged nets, renames, and joined nets whose attributes differ.

### Sheets and drawing

- `add_sheet`: add a schematic sheet.
- `move_to_sheet`: move components to another sheet.
- `remove_sheet`: remove a sheet.
- `clear_sheet`: take all parts off a sheet, with their connections and constraints.
- `set_paper`: paper size of the schematic pages (A4, A3, A2).
- `place_symbol`: move a symbol on the schematic (the sheet's drawing becomes hand-arranged).
- `place_block`: put a functional block roughly where it belongs on its page.
- `auto_draw`: let the auto-layout redraw a sheet, or just some parts.
- `wire`: draw a wire between two pins already on one net.
- `label`: show a pin's net by a net label or supply symbol.
- `erase`: take wires and labels out of the drawing (the netlist does not change).
- `move_supply`: move one supply symbol to another spot on its page.
- `place_text`: put a part's name and value where they read best.

### Constraints

- `constrain`: add a placement, parameter, layer, arrangement, room (a functional block keeps its parts inside a rectangle of the board) or note constraint (soft or hard).
- `remove_constraint`: remove a constraint (also takes back an `attach`).

### Board

- `add_board`: another board in the design (a product of several boards), with the sheets whose parts go on it ([multi-board](multi-board.md)).
- `remove_board`: take a board away; its sheets and parts go back to the first board.
- `assign_board`: put whole sheets, or single parts, on a board.
- `mate`: join two boards through a connector on each (stack, cable, edge, wire, or an explicit pin map); the checks then hold the nets to which pin meets which.
- `remove_mate`: take a mate away (by its id or a connector).
- `set_board`: board size, layers and design rules (clearance, track and power-track width, via drill and pad, edge clearance, vias in pads, corner radius, and current_rise_c: how much copper may heat with its net's current, 10, 20 or 30 °C, default 10, which sets what the current check asks of tracks and vias, not the copper), and the board's name. On a design of several boards every board op takes a board argument (name or id); without it the op works on the board of the parts it names, else on the board of the nets it names if they are on one board, and is refused (`BOARD_AMBIGUOUS`) when it says neither.
- `set_outline`: a free-form board outline.
- `add_cutout`: a rectangular, round or slot cutout.
- `remove_cutout`: remove a cutout.
- `add_hole`: a mounting hole, at a corner or a position, plated or not.
- `remove_hole`: remove a hole.
- `add_keepout`: an area where tracks, vias, pours or parts are not allowed on some layers.
- `edit_keepout`: change a keep-out.
- `remove_keepout`: remove a keep-out.
- `add_graphic`: silkscreen graphic or text.
- `edit_graphic`: move, scale or restyle a graphic.
- `remove_graphic`: remove a graphic.
- `set_panel`: make the board in a fabrication panel (see [panel](panel.md)).

### Rules

- `set_fab_profile`: the manufacturer and its limits (see [fab-rules](fab-rules.md)); on several boards, every board or one named board (a tier of the same house).
- `set_stackup`: the layer build-up (see [impedance](impedance.md)).
- `set_impedance`: route a net or differential pair at a set impedance (see [impedance](impedance.md)).
- `remove_impedance`: remove an impedance rule.

### Placement

- `place`: put a component at a position, rotation and side on the board, optionally locked.
- `attach`: say which part a small part belongs with on the board.
- `add_test_points`: a test point pad on each named net (or every supply rail), at the part that drives it, labelled TP_<net>.
- `propose_placement`: place the board afresh, with the main parts where given.
- `refine_placement`: move and turn the placer's small parts to untangle the ratsnest.

### Copper

- `route`: router copper for the board as placed, or for given nets.
- `set_copper_mode`: who lays the copper: the router, or you (drawn mode).
- `draw_track`: draw one track of one net on one layer; with router copper, lay one connection pad to pad through given points, laid first on every route.
- `draw_pair`: draw a differential pair along a centre line.
- `draw_via`: a through via of one net at a spot.
- `edit_copper`: change drawn tracks and vias in place, keeping their ids.
- `tune_length`: add a meander to a drawn track to reach a length or match other nets.
- `erase_copper`: take tracks and vias away, or the connections you laid for the router.
- `lock_copper`: keep a net's routed copper exactly as it lies; route lays it first and never rips it up.
- `unlock_copper`: let go of locked copper; the router routes those nets its own way again.
- `set_plane`: a net's copper plane on a layer, whole or in an area.
- `set_plane_style`: a plane's gaps, clearance, edge pull-back and thermal reliefs.
- `add_vias`: thermal, stitching, fence or placed vias of one net.
- `remove_vias`: remove a via group.

### Verify

- `add_waiver`: waive a check result for given entities, with a reason; on a design of several boards, a board check's result on one board with its board argument.
- `remove_waiver`: remove a waiver.

### Enclosure

- `set_enclosure_brief`: what the box must do, decisions and questions for the user (see [enclosure](enclosure.md)).
- `set_enclosure_script`: the enclosure as a script.
- `set_enclosure_graphic`: a logo or icon the enclosure script can emboss, engrave or inlay.

### Names from earlier drafts that did not ship

- *rename_net*: `set_net` with rename. *create_sheet*: `add_sheet`. *add_mounting_hole*: `add_hole`.
- *get_part_card*: `get_part`. *generate_symbol*, *generate_footprint*: `set_symbol`, `set_footprint` from the datasheet.
- *layout_schematic*: `auto_draw`. *pour*: `set_plane`.
- *set_rule*: `set_board`. *set_net_class*, *add_net_class*: per net with `set_net`. *define_length_group*: `tune_length` with match.
- *update_constraint*, *disable_constraint*: `remove_constraint`, then `constrain`.
- *run_checks*: checks run with every transaction; read them with `get_diagnostics`.
- *explain*, *render_snapshot*, *ingest_datasheet*, *add_port*, *annotate*, the *export_…* ops and the history ops
  (*begin_changeset*, *commit_changeset*, *revert*, *branch*, *compare*) are not ops. Images, part import and
  production files are agent tools or app features (see [ai-loop](ai-loop.md)); undo and redo are the app's.

## 3. Transactions and results

A `Transaction` (`packages/schema/src/ops.ts`) is a one-line `summary`, a list of edit `ops`, and
`dry_run`; it applies all or nothing:

```jsonc
{
  "summary": "Add input capacitor to the buck",
  "ops": [
    { "op": "add_part", "part": "generic:C", "refdes": "C1", "params": { "value": "22uF", "voltage": "25V", "package": "0805" } },
    { "op": "connect", "pins": ["U1.VIN", "C1.1"], "net": "+12V" },
    { "op": "connect", "pins": ["C1.2", "U1.GND"], "net": "GND" },
    { "op": "constrain", "kind": "left_of", "a": "C1", "b": "U1" }
  ]
}
```

The kernel answers with a `TransactionResult` (`packages/schema/src/results.ts`): `status` (`ok` or
`rejected`), `dryRun`, per op an `effect` in words and the ids it touched, the `diff` (ids added,
removed, changed), the diagnostic `counts`, and the diagnostics the transaction `introduced` and
`resolved`. A refused transaction changes nothing and carries one `rejection`: the index of the op,
a `code` (`RejectionCode`: `REF_UNKNOWN`, `PIN_UNKNOWN`, `SWAP_INVALID`, `CONSTRAINT_CONFLICT`,
`BOARD_AMBIGUOUS`, …), the `message`, the closest `candidates` for an unknown name, and `fixHints`
(ops) where the kernel can tell. Every op that names a sheet finds it by name (any case) or id, and
refuses one that is neither with `SHEET_UNKNOWN`, every sheet name as candidates. On a design of several boards, a board op names its `board` or a
part on one; one that says neither is refused with `BOARD_AMBIGUOUS` ([multi-board](multi-board.md)).

A query that cannot answer returns a `QueryError` (`packages/schema/src/results.ts`): `{ error, code?,
candidates? }`, with the codes of a rejection where one applies: `BOARD_UNKNOWN` (a `board` the design does
not have), `BOARD_AMBIGUOUS` (a board query on a design of several that names no board and no part or net that
settles one, as for an op; the boards as candidates), `NET_UNKNOWN`, `REF_UNKNOWN` (also `suggest_moves` on parts not on the board), `PART_UNKNOWN`,
`PROJECT_UNKNOWN` (`list_blocks`). The keys these errors had before (`boards`, `nets`, `projects`) are kept
beside `candidates` for one release and then dropped. A successful answer's `boards` or `nets` (`get_board`
of every board, `get_net` of a net that crosses boards) is no error and stays.

The in-app agent and external agents (MCP, through the server's relay to the open tab) reach the
catalogue through the same tools: `design_edit` (a transaction) and `design_query` (one query op),
next to `get_context`, `propose` and the rest ([ai-loop](ai-loop.md)). The UI's own edits are
transactions of the same ops.

## 6. The power tree (`get_power_tree`)

`design_query get_power_tree` answers "what feeds what, and will it run hot?" from the schematic alone
(`packages/kernel/src/powertree.ts`). It reads the same power walk as the power and current checks
(`packages/kernel/src/power.ts`) and the dissipation SEM.LDO_DISSIPATION computes (`linearRegulators` in
`packages/kernel/src/checks.ts`), so its numbers are the check's. Unknown is said, never 0 or fine.

```jsonc
{ "rails": [                                      // every power net but ground, by name; [] with a note when there are none
  { "net": "+3V3A", "voltage": 3.3,                // or "unknown"
    "source": { "kind": "regulator",               // regulator | connector | battery | unknown: the nearest upstream
                "ref": "U1", "regulator": "linear", // linear | switching, left out when neither is clear
                "from": "+5V" },                   // the regulator's input rail
    "through": [{ "ref": "R1", "category": "resistor", "from": "+3V3" }], // series parts from the source down to this rail
    "feeds": ["+1V8"],                             // the rails fed from this one (through a regulator or series parts)
    "supplies": ["U2"],                            // parts with a power input on it
    "loads": [{ "pin": "U2.3", "a": 0.1 }],        // set_net loads
    "current": { "max_a": 0.5,                     // max_current, else the loads' sum, else "unknown"
                 "basis": "max_current",           // max_current | loads | unknown
                 "loads_a": 0.1, "feeds_a": 0.05,  // feeds_a: the fed rails' current where it passes unchanged; "unknown" behind a switcher
                 "budget": "ok" },                 // ok | over | unknown: max_current against loads_a + feeds_a
    "dissipation": { "ref": "U1", "package": "SOT-23", "watts": 0.85, "limit_w": 0.29,
                     "status": "error",            // ok | warning | error | unknown, as SEM.LDO_DISSIPATION
                     "missing": "current" } } ] }  // with unknown: voltage | current | package
```

A source is a part's power output pin (a regulator; `from` is its power input's rail), a connector's pin
on an external net, or a battery's pins (a part whose card says battery or cell, or refdes BT). Current
then flows through series parts (inductors, ferrite beads, fuses, diodes, a choke's windings; a resistor
only between two power nets, as elsewhere it is a pull-up or a divider), away from the sources; a rail with
neither is `unknown`. `dissipation` is on the rail a linear regulator drives directly; a switcher's rail
has none. The budget is `unknown` without max_current, and where a switcher is fed (its input current
depends on its efficiency).

## 7. Blocks of another project (`list_blocks`, `import_block`)

`design_query list_blocks { project }` reads another project in the projects folder, by its id (the file
name without `.twd.json`), and lists its functional blocks (its `describe` blocks), so the agent can reuse a
proven one. The app reads the file through the server only when the server lists that id (the server
refuses ids with path characters) and hands it to the kernel with the query (`Kernel.query`'s `sources`,
as for `transact`); the kernel answers with `blocksOfProject` (`packages/kernel/src/reuse.ts`), and says
there is no projects folder when it got none. Neither project changes. `get_guide` works the same way:
the app hands the guides (the design docs) to the kernel with the query, and the kernel answers.

```jsonc
{ "project": "usb-lamp",
  "blocks": [
    { "block": 1, "title": "5 V in and 3.3 V LDO", "text": "…",   // describe order, from 1; text may be ""
      "parts": [{ "ref": "C1", "part": "generic:C", "params": { "capacitance": "10uF" } }], // dnp: true where set
      "internal_nets": ["FB"],                                     // only this block's parts are on them
      "boundary_nets": [
        { "net": "+3V3", "why": "parts outside", "pins": ["C2.1", "U1.VOUT"], "outside": ["R1"] },
        { "net": "+5V", "why": "supply", "pins": ["C1.1", "J1.1", "U1.VIN"] } ] } ], // why: parts outside | off-board | supply
  "not_in_a_block": ["R9"],                                        // left out when every part is in a block
  "note": "…" }
```

A boundary net leaves the block: a part outside the block is on it, it is marked external (off the board),
or it is a supply or ground, which the importing design has its own of even where only this block uses it.
A project without blocks answers `blocks: []` with a note; an unknown or unreadable project answers
`{ "error", "projects" }` (the ids the folder has).

`design_query get_board { project, board? }` reads a board of another stored project the same way, to see a
laid-out board before bringing it over: `board` names one of that project's boards (name or id; default its
first), placed from its stored placement, nothing routed (`boardOfProject`, `reuse.ts`). The answer is
get_board's, with `project`, `board` and, for a project of several boards, `boards`. Copper is reported only
where the stored copper is current for that placement (drawn, or kept for it); otherwise `routing` says "not
routed as stored". A board the project does not have answers `BOARD_UNKNOWN` with its board names; without
a projects folder the kernel refuses it, never answering about the open design. The open design is unchanged.

`design_edit import_block { project, block, nets, prefix?, sheet?, board? }` copies one block in. `block` is its number or
title, `nets` maps every boundary net to a net of this design (`{ "+5V": "VBUS", "GND": "GND" }`; a name that
does not exist here is made, with the source net's attributes). `nets` may also map an internal net
(`{ "NTC": "NTC" }`): it is not made anew, and its pins join that net the same way, for a block whose internal net
this design already has (a sensor line both boards carry). It is refused, and nothing changes, when a
boundary net is not mapped (`NET_UNMAPPED`, the missing ones as candidates), a mapped name is no net of the block
(`NET_UNKNOWN`, its boundary and internal nets as candidates), the block or project is unknown, a part cannot be resolved (`PART_UNKNOWN`), or `sheet` or `board` names none
of this design (`SHEET_UNKNOWN`, `BOARD_UNKNOWN`, as for `move_to_sheet` and `assign_board`).

- `sheet` (name or id) is the sheet the parts are drawn on, else the first sheet. `board` (name or id) is the
  board they go on, as `assign_board { board, refs }` would put them, else their sheet's board. On a design of
  several boards this brings another board's circuit in where it belongs, with no `move_to_sheet` or
  `assign_board` per part afterwards. The effect says where they went (`on sheet LED, board "LED"`).

- Parts are resolved by id in this design and the library first; a part neither has comes with the card the
  source project stores (a project embeds the cards it uses). A card here that lacks a pin the block connects
  is refused. Params, no-connect marks and DNP are copied.
- A refdes taken here gets the next free number of its letters (R1 → R2 when R1 is used here); internal nets that `nets` does not map are made anew,
  `prefix` put before their names, `_2`, `_3` … where the name is taken. Net loads on the block's pins come along.
- The block's `describe` entry (title, text; ` (2)` after a title that is taken) is appended, with the
  constraints between its parts that say how it is drawn (`left_of`, `right_of`, `above`, `below`,
  `arrangement`) and its notes. Positions, rooms and param constraints stay behind.
- The result's `imported` (and the effect) gives the refdes and net renames, which cards came from the
  source file, and the values to recheck: each part with params, marked `sets U1.FB` where it is on a net
  with an IC pin such as FB, ILIM, RT, SS or EN, else chosen for the other project.

`design_edit import_board { project, board?, as, sheet?, nets?, prefix? }` copies a whole board of another
project in as a board of this design (D29; `importBoard`, `importops.ts`). It shares the part, card and net copy
with `import_block` (`copyParts`).

- `board` is the source's board (name or id; default its first). On a source of several boards only that board's
  parts, the nets on them and the constraints between them are read (its focus, `multi-board.md`).
- `as` is the board here: made when the design has none of that name, else an existing board that has no parts
  yet (one made with `add_board`). A board with parts is refused (`BOARD_INVALID`): `import_board` never
  replaces parts; remove them first. `sheet` (name or id) is where the parts are drawn, made when there is none
  of that name; default a sheet named as the board. A sheet with no parts yet is put on the board.
- Every part is copied with its params, no-connects, DNP and card, as for `import_block`. A refdes taken here
  gets the next free number (R1 → R4); the effect says to export that board's files again. (Per-board refdes
  blocks, R101…, are D30.2.)
- Nets by name: a named source net joins the net of the same name here, or is made with the source's
  attributes where there is none; an automatic `N$` net is always made anew. `nets` overrides one net: another
  name (`{ "VLED": "+5V_LED" }`, made if missing) or `"fresh"` (kept apart, `LED_2` where `LED` is taken: an
  accidental clash). `prefix` goes before the names of nets made anew (`RING_LED`, `RING_N$3`). A `nets` key the
  source board does not have is refused (`NET_UNKNOWN`). Two source nets onto one net here is done but reported
  as a merge. Joined nets whose voltage, max current, external, power or track width differ are listed to
  recheck. A width the source set for its own board (`boardTrackWidths`) becomes this board's on a net made anew.
- The source's describe blocks (their parts on this board, titles ` (2)` where taken), the drawing constraints
  and notes between copied parts (as `import_block`), and the board's outline (`width`, `height`, corner radius,
  `shape`, cutouts), layers, rules, stack-up and mounting holes (net remapped) come along. The fab profile
  comes along when it is of this design's house (or the design has none); otherwise the board keeps this
  design's house and the effect says so (one house per design, `multi-board.md` §5).
- Not yet (later D29 steps): the stored placement, positions, sides, keep-outs, graphics, panel and copper.
  The parts arrive unplaced, and the effect and `importedBoard.left_behind` say so.
- Joined nets now have pins on two boards: `ERC.BOARD_CROSSING` flags each until a mated connector pair carries
  it. Add the `mate` in the same transaction (the effect gives the new refdes; a `dry_run` shows them first).
- The result's `importedBoard` gives the source and target board (`made`), the sheet, the new refdes, renames,
  cards, `nets` (`joined`, `made`, `merged`, `recheck`), blocks, constraints, what the board took over and what
  stayed behind.

The app reads the source file the same way as for `list_blocks` (only an id the server lists) before the
transaction and hands it to `Kernel.transact` beside the ops (`sources`, `packages/kernel/src/importops.ts`),
so the op is an ordinary edit: dry run, review, accept and undo work as for any other.
