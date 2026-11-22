# Operation API (ops catalogue)

> Part of the [architecture](../ARCHITECTURE.md). Status: draft; §2 matches the shipped ops as of 2026-11-20.

The ops catalogue is the **only** way to read or change a design. The in-app agent, external
agents (through MCP), scripts, tests and the UI all use it.

## 1. Design rules for the catalogue

1. **Semantic, not geometric.** `connect(pins, net)`, not `add_wire(x1,y1,x2,y2)`.
2. **Reference by name or ID.** `"U1.VIN"`, `"U1.4"`, `"net:+3V3"`, `"class:PWR"`, `"sheet:Power"`. The kernel resolves names and returns the IDs it used.
3. **Batchable.** A `transaction` holds many ops and applies all or nothing.
4. **Dry-run first.** `dry_run: true` returns diff + diagnostics without committing.
5. **Explain refusals.** Every rejection has a `code`, a human `message`, the `entities` involved, and machine-readable `fix_hints` (ops that would resolve it).
6. **Small, queryable context.** Query ops let the agent ask for exactly what it needs, instead of receiving the whole design in the prompt.
7. **Versioned.** Ops carry a catalogue version. Old ops are migrated or refused.

## 2. Op groups

Every op the kernel accepts, as defined in `packages/schema/src/ops.ts` (edit ops in the EditOp union, applied in a
transaction; query ops in the QueryOp union, read-only). The field-level docs live in the schema; a test
(`packages/schema/test/ops-doc.test.ts`) fails when this list and the schema drift apart.

### Query

- `get_summary`: overview of the design.
- `find`: parts and nets by a substring of refdes, part id, value or net name, or by category.
- `get_component`: one component: part, parameters, package, pins with their nets, constraints.
- `get_net`: one net: its pins, track width (the width its current needs, per layer), how its copper carries its current, vias for its current, impedance rule.
- `get_diagnostics`: the design's current diagnostics (check results).
- `get_ledger`: the constraint ledger: every constraint with its strength and the user's words.
- `get_description`: the design description: overview, functional blocks with their parts, parts no block covers yet.
- `get_fab_profiles`: the built-in manufacturer profiles and the one this board uses.
- `get_schematic`: the schematic drawing: pages, blocks, where each symbol and net label stands.
- `get_copper`: drawn tracks and vias with their ids, optionally by net or area.
- `get_board`: board outline, part positions, routing stats and DRC results.
- `get_current_map`: the routed copper against each net's current: per net ok, unverified or unknown (and, with loads stated, the drop to the furthest load against 3 % of the rail), and the tracks and vias that do not carry it, worst first, with their fixes (see [layout](layout.md) §14).
- `get_power_tree`: what feeds what: per power rail its source, the series parts it is fed through, the rails it feeds, its loads, current budget and a linear regulator's dissipation (shape in §6).
- `try_placements`: compare arrangements of the main parts without changing the design.
- `suggest_moves`: small-part moves (turn, swap, shift) that close open connections, without applying them.
- `get_enclosure`: the enclosure brief, script, board API and last render report.
- `get_guide`: an agent guide (schematic, cost, mechanics, high_speed).

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
- `no_connect`: mark pins as deliberately unconnected.
- `set_net`: rename a net and set its voltage, external/power flags, max current, the loads its pins draw (`loads: [{ pin: "U3.VDD", amps: 0.35 }]`, null clears; each pin must be on the net and draw more than 0 A; the current check splits the net's current over its copper from them, `layout.md` §14), track width, how it is drawn, and on the board whether the router routes it first and the layer its tracks keep to (a cost, not a ban).
- `describe`: the functional blocks (which group and order the schematic) and the design document text.

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

- `set_board`: board size, layers and design rules (clearance, track and power-track width, via drill and pad, edge clearance, vias in pads, corner radius, and current_rise_c: how much copper may heat with its net's current, 10, 20 or 30 °C, default 10, which sets what the current check asks of tracks and vias, not the copper).
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

- `set_fab_profile`: the manufacturer and its limits (see [fab-rules](fab-rules.md)).
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

- `add_waiver`: waive a check result for given entities, with a reason.
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

## 3. Envelope

```jsonc
// request
{
  "catalogue": "0.1",
  "transaction": {
    "summary": "Add 3V3 buck converter",
    "dry_run": true,
    "ops": [
      { "op": "add_part", "part": "ti:TPS54331DR", "refdes": "U1", "sheet": "Power" },
      { "op": "add_part", "part": "generic:C_0805", "refdes": "C1",
        "params": { "capacitance": "22uF", "voltage": "25V", "dielectric": "X5R" } },
      { "op": "connect", "pins": ["U1.VIN", "C1.1"], "net": "+12V" },
      { "op": "connect", "pins": ["C1.2", "U1.GND"], "net": "GND" },
      { "op": "constrain", "kind": "left_of", "a": "C1", "b": "U1", "domain": "placement",
        "source": { "type": "chat", "message": "msg_42" } }
    ]
  }
}
```

```jsonc
// response
{
  "status": "ok",                       // ok | rejected | partial (never partial in a transaction)
  "resolved": { "U1": "cmp_01J9A…", "+12V": "net_01J9B…" },
  "diff": { "added": 4, "changed": 1, "removed": 0, "entities": ["cmp_…", "net_…"] },
  "diagnostics": {
    "delta": { "errors": 1, "warnings": 0 },
    "items": [{
      "code": "ERC.PIN_UNCONNECTED",
      "severity": "error",
      "entities": ["U1.BOOT"],
      "message": "U1.BOOT (pin 1) is unconnected. The datasheet (p.13) requires 0.1 µF from BOOT to PH.",
      "fix_hints": [
        { "op": "add_part", "part": "generic:C_0402", "params": { "capacitance": "100nF" } },
        { "op": "connect", "pins": ["$new.1", "U1.BOOT"] }
      ],
      "provenance": { "part_card": "sha256:…", "page": 13 }
    }]
  },
  "changeset": "cs_01J9C…"
}
```

## 4. Rejection codes (examples)

| Code | When |
|---|---|
| `REF_UNKNOWN` | name doesn't resolve; response lists the closest matches |
| `PIN_TYPE_CONFLICT` | e.g. two `pwr_out` pins on one net |
| `PARAM_OUT_OF_RANGE` | value outside the part card's allowed range |
| `CONSTRAINT_CONFLICT` | new hard constraint contradicts an existing one; both are returned |
| `CURRENT_CAPACITY` | net class width can't carry the net's declared current |
| `FAB_LIMIT` | rule below the selected fab profile |
| `LOCKED` | entity is locked by the user or an authored constraint |
| `PERMISSION` | op not allowed in the current autonomy mode / tool trust level |

## 5. Mapping to front-ends

- **In-app agent**: ops become tools. Large groups are exposed through a two-level scheme
  (`design.query`, `design.edit`, `design.solve`…, each with an `op` discriminator), so small
  models get a short tool list and strong models get full schemas.
- **MCP (through the relay)**: the same tools plus MCP *resources* (`twd://project/summary`,
  `twd://diagnostics`, `twd://ledger`) and *prompts* (recipes).
- **UI**: accept/reject, drag-hint, ledger edits and settings all emit ops, so user and AI
  actions show up the same way in history.
- **Scripts/tests**: generated TS and Rust clients. The evals drive the kernel natively without a browser.

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
