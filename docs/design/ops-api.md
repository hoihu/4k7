# Operation API (ops catalogue)

> Part of the [architecture](../ARCHITECTURE.md). Status: draft.

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

| Group | Ops (selection) |
|---|---|
| Query | `get_summary`, `find` (parts/nets/pins by filter), `get_component`, `get_net`, `get_diagnostics`, `get_ledger`, `explain(entity)`, `render_snapshot(view, region)` (image for vision models) |
| Library | `search_parts`, `ingest_datasheet`, `get_part_card`, `generate_footprint(params)`, `generate_symbol(params)` |
| Schematic | `add_part`, `remove`, `set_param`, `connect`, `disconnect`, `rename_net`, `set_net_class`, `create_sheet`, `move_to_sheet`, `add_port`, `annotate` |
| Constraints | `constrain`, `update_constraint`, `disable_constraint`, `remove_constraint` |
| Board | `set_outline`, `set_stackup` (implemented, see [impedance](impedance.md)), `set_fab_profile` (implemented, see [fab-rules](fab-rules.md)), `add_mounting_hole`, `add_keepout` |
| Solvers | `layout_schematic(scope)`, `place(scope, strategy)`, `route(scope, strategy)`, `pour(zone)`, `tune_length(group)` |
| Rules | `set_rule`, `add_net_class`, `set_impedance` (nets and differential pairs at a set impedance; implemented, see [impedance](impedance.md)), `define_length_group` |
| Verify | `run_checks(scope, kinds)`, `add_waiver`, `remove_waiver` |
| Output | `export_fab(profile)`, `export_bom`, `export_pdf`, `export_native` |
| History | `begin_changeset`, `commit_changeset`, `revert`, `branch`, `compare(branch_a, branch_b)` |

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
