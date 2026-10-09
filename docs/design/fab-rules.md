# Manufacturer limits: fab profiles

> Part of the [architecture](../ARCHITECTURE.md). Status: first slice implemented (2026-10-09).

A board is made by someone, and every manufacturer has a floor: the narrowest track, the smallest
drill, the thinnest ring. Tracewise keeps that floor apart from the **design rules** the board is
routed with:

| | What it is | Who sets it | Where |
|---|---|---|---|
| **Design rules** (`BoardRules`) | what this board is routed and checked with: clearance, track widths, via size, edge distance | you or the agent (`set_board`) | `board.rules` |
| **Fab profile** (`FabProfile`) | what the manufacturer can make: a hard floor | a preset, or limits imported from a source (`set_fab_profile`) | `board.fab` |

The rules are always at or above the limits. The profile is what makes that true and what checks
the parts of a design the rules cannot guarantee (a footprint's hole, a net's own width, the
board size).

## The profile

`packages/schema/src/fab.ts`. A profile is a **house** and a **tier** (JLCPCB "2-layer, 1 oz
copper"; Eurocircuits "class 6C"), the layer counts the tier is made in, its limits, and where
they came from (`source.url`, `source.checked`). It is stored in the design as a **full copy**, so
a design stays reproducible when a preset is revised later.

Limits (all optional except track and clearance; an absent limit is simply not checked):

| Limit | Checked as |
|---|---|
| `track`, `clearance` | rule floors; `DRC.FAB_TRACK` for a track narrower than `track` (per-net widths) |
| `viaDrill`, `viaPad` | rule floors; `DRC.FAB_VIA` |
| `annularRing` | `DRC.FAB_RING` on plated component and mounting holes, (pad − drill) / 2 |
| `pthDrill`, `npthDrill` | `DRC.FAB_HOLE` |
| `holeToHole`, `padHoleToHole` | `DRC.FAB_HOLE_SPACING`: wall between holes; the second applies when a component or mounting hole is involved |
| `copperToEdge`, `copperToEdgeInner` | the edge-clearance rule floor (the inner value applies to 4-layer boards) |
| `silkWidth` | `DRC.FAB_SILK` (outline graphics); `silkHeight` and `maskBridge` are informational |
| `minBoard`, `maxBoard` | `DRC.FAB_BOARD_SIZE`, either orientation |
| the profile's `layers` | `DRC.FAB_LAYERS` |
| rules kept below a limit (`keep_rules`) | `DRC.FAB_RULES` |

All fab diagnostics are errors, so `propose` is refused while one is open, except spacing between
two pads of one footprint, which is a warning: the footprint decides that, not the layout.

## Applying a profile

`set_fab_profile` (agent, or the Manufacturer picker in the Layout panel):

1. Stores the profile.
2. **Raises** every rule that is below a limit, up to the limit. It never lowers a rule, so
   choosing a more capable fab does not silently tighten a conservative design. The result names
   what was raised. With `keep_rules: true` the rules stay and the DRC reports each one as a
   violation instead.
3. From then on `set_board` and `set_net` **refuse** a value below a limit (`FAB_LIMIT`), and
   moving to 4 layers raises the edge clearance to the inner-layer limit where that is larger.
4. `none: true` removes the profile and leaves the rules as they are.

`set_board` also gained `via_drill_mm`, `via_pad_mm` and `edge_clearance_mm`; those three rules
were fixed defaults before.

## Where the limits come from

Two routes, both ending in the same `FabProfile`:

**1. Presets** ship with the app (`fabPresets()`): JLCPCB (2 and 4 layers, 1 and 2 oz),
PCBWay (2 and 4 layers, 1 oz) and Eurocircuits. Each says which capabilities page it was read
from and on which date, and carries the caveats the page gives (conditions, derived values).

Eurocircuits does not publish one set of numbers but a **classification**: a pattern class
(3–9: track, gap, annular ring) combined with a drill class (A–E: smallest hole). Its two tables
are in the preset code, so any combination resolves ("eurocircuits/5C"); 3A, 4B, 5B, 6C, 7D, 8D and
9E are listed. Their annular ring is measured from the drill tool (finished plated hole +
0.10 mm), so the preset adds 0.05 mm to measure it from the finished hole, which is how the DRC
measures; the via pad is derived from that. The preset notes say so.

**2. Import by the agent**, for another manufacturer or newer numbers:

```
design_query get_fab_profiles          → presets, current profile, how to import
set_fab_profile { house, tier, source_url, checked, limits: { track_mm, clearance_mm, … } }
```

The agent reads the manufacturer's capabilities page (the Web setting adds WebFetch; otherwise
the user pastes the numbers) and enters the limits in mm. The kernel does not trust them
blindly: `source_url` is required, `track_mm` and `clearance_mm` are required, every number must
lie between 0.02 and 3 mm (a mil value typed as mm, or µm as mm, is refused with a hint), and a
via pad must exceed its drill. The agent's prompt says to **never fill a number from memory**, to
leave out what the page does not state and to say which values it could not find. The import
arrives as a changeset like any other change, with the source URL in its details, so the user
sees where the numbers came from before accepting.

**Refreshing** is on demand, by the user. The profile in the design is a snapshot and never updates
itself. The Manufacturer panel's **Update check** button asks the agent to read the
profile's `source_url` again, compare it with the stored limits, and import the result with
today's date (`fabRefreshPrompt` in `apps/web/src/lib/fabRefresh.ts`). It says which limits
changed, or that none did (the date is still brought up to date), and if it cannot read the page
it changes nothing. The result is an ordinary changeset to review. A refreshed built-in preset
keeps its id (same house and tier), so the picker still shows it; its origin becomes "imported" and the
Details show the new check date. Pages that are images or need a login
(Eurocircuits' classification table is an image) may not be readable; the agent then says so.

Presets are data, not code: refreshing one is editing numbers and the `checked` date in
`packages/schema/src/fab.ts`. Pages move and numbers change, so a profile always carries its
source and date, and the Manufacturer panel shows them.

## Presets and what they are not

- A preset is a **capability floor** for the standard service, not a quote: surcharges for tighter
  tiers, impedance control, special finishes and thicker copper are not modelled. Notes mention
  the common ones.
- Only what the DRC can check is checked. Solder-mask web and silkscreen text height are stored
  for the record: there is no mask or silk text model to check them against.
- 2 oz and heavier copper for PCBWay is not a preset (the page defers to a separate table); import
  it.

## Surfaces

| Surface | What it does |
|---|---|
| `set_fab_profile` op | choose a preset, import limits, or remove the profile |
| `set_board` | refuses rules below the limits; new `via_drill_mm`, `via_pad_mm`, `edge_clearance_mm` |
| `design_query get_fab_profiles` | presets (id, house, tier, limits, source, date), the current profile, how to import |
| `design_query get_board` | `fab` with limits, source and notes; the DRC list includes `DRC.FAB_*` |
| Layout panel | Manufacturer picker (house and tier); under **Details**: source link, **Update check**, limits and notes, editable design rules with each limit beside its field |
| Changeset | "made by JLCPCB, 2-layer, 1 oz copper" (imported: with its source) |
| Design document | a Manufacturer row in the Layout section |

## Not yet

- Per-net-class rules (a profile only sets the floor; per-net widths still come from `set_net`).
- Impedance and stack-up from a profile; layer counts beyond 2 and 4.
- Checking mask web and silk text height.
- Import from KiCad `.kicad_dru` or manufacturers' rule files.
- Per-house naming and packaging of the fab export, and price or lead-time tiers.
