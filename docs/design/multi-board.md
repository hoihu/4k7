# Several boards in one design

> Part of the [architecture](../ARCHITECTURE.md). Status: step 1 built (2026-11-22): boards in the model, per-board layout and production files, the board picker (§9). Mates (§3): the op and the checks built (2026-11-22); the assembly they place, the 3D view of every board and the STEP file of them all built (2026-11-23, §6). The cost and stock checks of every board built (2026-11-23, §5), the enclosure script with every board (2026-11-23, §6); a combined BOM file is not built yet.

## 1. Why

Many small products are two boards: a main board and a display or button board, joined by a
header or a cable, in one box. Today a design has exactly one board (`Design.board`), so such a
product is two projects, and then:

- nothing checks that the two halves of the connection agree. A header mirrored on one side, or a
  signal one pin off, is a dead pair of boards, and it is the commonest mistake of the kind;
- the enclosure holds one board, so the box cannot be made for both;
- each board is ordered, costed and sourced alone, though they go to the same fab house;
- the agent sees half the system.

The aim: one design, any number of boards, joined by **mates** the kernel checks. A design with
one board looks and behaves exactly as it does now: no new steps, no new arguments.

## 2. What the user and the agent say

| Intent | Op |
|---|---|
| Add a board | `add_board { name, sheets? }` → `b_2` |
| Rename one, take one away | `set_board { board, name }`, `remove_board { board }` (its parts go back to the first board) |
| Put a sheet's parts on it | `assign_board { board, sheets }` (a sheet belongs to one board) |
| Move one part to another board | `assign_board { board, refs }` (overrides its sheet) |
| Join two connectors | `mate { a: "J1", b: "J2", kind, map?, … }` |
| Bring in a board laid out in another project | `import_board { project, board?, as, sheet?, nets?, prefix? }` ([ops-api](ops-api.md) §7) |
| Everything else | the board ops and queries as now, with an optional `board` |

A component's board is its own `board`, else its sheet's, else the first board. Sheets are how
people already split such a schematic ("Main", "Display"), so in practice the agent assigns
sheets and hardly ever single parts.

`board` may be left out wherever there is only one board. With two, a board op without it works
on the board of the parts it names (`place R4`), else of the nets it names when they are on one
board only (`add_test_points LED_A`); one that says neither is refused (`BOARD_AMBIGUOUS`) with
the boards as candidates, and one that names a part of another board is refused too
(`BOARD_INVALID`). A board query (`get_copper`, `get_current_map`, `try_placements`, `suggest_moves`)
without `board` infers it by the same rules (`boardFor`): the board of the parts it names, else of its
nets on one board only; one that says neither answers with the same code and candidates (a query
error, [ops-api](ops-api.md) §3). `get_board` without `board` infers nothing: it answers for every board. Parts are read only from the fields that name parts and pins (`ref`, `refs`,
`parts`, `near`, `under`, `part`, a track's `from`/`to`), so a net, a copper or graphic id or a
silkscreen text that looks like a refdes is none. The first board is called Main until renamed,
with one board or several. A part that moves to another board (`assign_board`, `remove_board`,
`move_to_sheet` to a sheet of another board, a changeset accepted in part) leaves its placement
and its fixed position behind. Test points are numbered across the boards and go on the sheet of
the part they are at. A waiver can name its board (`add_waiver board`): a board check finds the
same on each board, the same net or the same copper id, and a waiver without it holds on every
board. A `board` that is not one of the design's is refused (`BOARD_UNKNOWN`), with one
board as with several. `constrain near` between parts of two boards is refused (`BOARD_INVALID`):
each board's focus keeps only the constraints between its own parts. The app's own edits (a drag, the panel's tabs) are for the board
shown. Queries: `get_board` and `get_fab_profiles` without `board` answer for every board (`boards`:
one entry each; `get_fab_profiles` gives each board's layers and profile, and the presets once);
`get_copper`, `get_current_map`, `try_placements` and `suggest_moves` need it. `get_summary` lists
the boards (name, sheets, parts, and each board's stack-up and `currentRise`, which on several
boards replace the design-wide `stackup`), each part's board, and the boards a net spans. `calc`
`impedance` and `track_current` take `board` for that board's stack-up and heating; without it on
boards that differ they ask which, unless the arguments give the stack-up (`h` and `er`;
`copper_um` and `rise_c`). `get_board_image` and
`view_gerbers` take `board` and show that board in the app.

**A board of another project** (`import_board`, D29): every part of that project's board comes in onto a
new board (or one with no parts yet) and a sheet of its own, nets joined by name (`nets` overrides; automatic
nets made anew), with its blocks, outline, layers, rules, stack-up, fab tier and holes, and its layout: the
stored placement, the pins (`position`, `rel` too), sides, `near`/`belongs`/`room`, keep-outs, graphics and
panel, ids remapped. The joined nets cross between the boards, so `ERC.BOARD_CROSSING` stands until the `mate`
that goes in the same transaction. Copper is a later step; the board is routed afresh for now.

**How it is built** (`kernel/src/boards.ts`): a *focus* is the design as if one board were its
only one: that board's settings as `board`, only its parts, the nets with pins on them, and the
constraints between them (a room: its block's). The placer, router, DRC, current check and
production files read a focus and know nothing of other boards. A board op is applied to a focus
and written back (`commitFocus`); an op on the whole design that touches the board (taking parts
off, merging nets, a layer or room constraint) does so on every board, or on the board of its
part. A design of one board is its own focus, so nothing changes for it.

## 3. Mates: one model for header, cable, card edge

The connection between the boards is kept apart from the connector parts, so it can change from
a stacking header to a cable later without touching the nets: swap the parts, change the mate's
`kind`, and the checks say what no longer fits.

| `kind` | What it is | Fixes the boards' relative position | Default pin map |
|---|---|---|---|
| `stack` | board-to-board: pin header into socket, mezzanine connector | yes: from the two footprints and the mated height | each pin to the pin it lands on (from the footprint geometry, so a mirrored footprint shows) |
| `cable` | JST, ribbon/IDC, FFC/FPC, harness | no | `cable: straight` (pin n to n, default) or `reversed` (n to N+1−n: an end that turns over); the cable's datasheet says which |
| `edge` | card edge into a slot | yes | contact to contact, by number |
| `wire` | solder pads and loose wires | no | pairs, explicit |

`map` overrides the default with explicit pairs `[["1","2"],…]` (pin names or numbers), for
anything odd. A mate (`Design.mates`, `kernel/src/mates.ts`) stores the two component ids, the
kind, the map and, for `cable`, a length (for the enclosure and the BOM). A connector mates once;
mating the same pair again changes the mate. It goes with either connector, and with the second
board (`remove_board`); in a changeset it is a hunk of its own (`mate:<id>`).

**How a stack pairs its pins** (built): the two footprints face each other, so the second is
seen mirrored, and the boards may stand at any quarter turn to each other. The pairs are those of
the turn at which every pad lands on a pad (within 0.2 mm), pin 1 on pin 1 where a turn gives
that, else the first turn that fits. So two identical 2×N headers face to face swap their rows
(pin 1 meets pin 2: `ERC.MATE_MISMATCH` on every pin, with the hint that a footprint is
mirrored), a socket whose footprint is drawn mirrored meets pin for pin, and another pitch or
count does not fit (`ERC.MATE_FIT`). The placement does not enter: where the boards stand is the
assembly's (§6, built 2026-11-23).

### 3.1 Nets across boards

Nets stay logical. The agent connects the MCU's `SDA` to the display's `SDA` as now, and puts
`J1.3` and `J2.3` on the net too. The kernel then splits each net by board and checks:

- **`ERC.BOARD_CROSSING`** (error): a net with pins on two boards whose parts on each board are
  not joined through a mated pin pair. This is "forgot to bring it out on the header".
- **`ERC.MATE_MISMATCH`** (error): two mated pins on different nets. This is the mirrored or
  shifted header.
- **`ERC.MATE_OPEN`** (warning): a mated pin with a net on one side and nothing on the other.
- **`ERC.MATE_FIT`** (error): the two connectors do not plug into each other (a stack's pads do
  not land, or the pin counts differ without a map). **`ERC.MATE_SAME_BOARD`** (warning): both
  connectors ended up on one board.
- Current: a power net's current through a mate is checked against the connector's per-pin
  rating, when the card has one (the existing current check, [layout](layout.md) §14).

The router, the placer and the DRC each see one board: the part of each net on that board,
ending at its connector pin. Nothing in them needs to know other boards exist.

## 4. Per board, and for the whole system

| Per board | For the system |
|---|---|
| outline, layers, stack-up, rules, the fab tier (§5) | the fab house (one for the design, §5) |
| placement, routing, copper, DRC | the ERC and the mate checks |
| panel | the enclosure and the 3D assembly |
| Gerber, drill, pick-and-place, fab check: one zip per board (`<design>-<board>.zip`) | the BOM: per board and combined; the cost and the order |

A net is the system's, its settings too, except its track width: `set_net track_mm` with `board`
sets the net's width on that board only (built 2026-11-24, after the bike lamp's merge: LED_A and
LED_K want 0.4 mm on the main board and 0.8 mm on the LED board, and the agent set 0.8 mm on each
LED-board track by hand). Stored as `NetAttrs.boardTrackWidths` by board id, over the net's own
`trackWidth` on that board; null with `board` clears it (the net's width again). On a board the
order is: the impedance rule's width, the board's, the net's, the rules' signal or power width
(`ownTrackWidth` in `kernel/src/boards.ts`, read by the router setup, drawn tracks and `get_net`,
whose `track.by_board` gives each board's width and why). The route key of a board holds its own
widths, so a change on one board re-routes that board only. `remove_board` drops its widths.
The fab limit is checked against the board it is for: with `board` that board's, without it every
board the net has pins on (a width any of them cannot make is refused, `FAB_LIMIT`).

## 5. Same fab house

One fab house for every board. `set_fab_profile` without `board` sets the profile on each (built:
stored per board, as the profile was, so the DRC of each board reads it where it always did; a new
board starts with the first board's layers, rules and profile). With `board` it sets that board's
only, so a 4-layer main board and a 2-layer LED board each get the house's tier for their layer
count (built 2026-11-23, after the bike lamp's boards were merged into one design: JLCPCB's 4-layer
tier on both left the 2-layer board with a `DRC.FAB_LAYERS` that could not be fixed or waived). A
board's profile must be of the house the other boards have (`FAB_INVALID` otherwise): the cost
check prices every board at one house. A board for a different house is not supported.
The Layout view's Manufacturer list sends `set_fab_profile` without `board`, so it sets every
board whichever board is shown; the view's other edits are for the board shown.

`DRC.FAB_LAYERS` names its board: the entity is the board's name, and the message says
`set_fab_profile board: "<name>"`. Choosing the right tier is the fix; a board the user means to
make that way is waived with `add_waiver` for that entity, which matches no other board's finding.

**The cost and the stock** (built): each board is an assembly order of its own at the one house,
as a house takes it (its own setup, stencil, losses and minimums, so a part used on both boards is
bought for each). The cost check runs per board (its parts, its placed board's joints, sides and
size) and adds the estimates up service by service (`combineEstimates`, `combineCosts` in
`parts/src/cost.ts`); a service that cannot take one board's order cannot take the whole. The
report names each board's fees, savings and bare-board hints, and says what each board's order
costs (`perBoard`). The stock check looks the parts up for every board together (the combined
need, which is what the stock must cover), with the order estimate added up the same way. The
values check compares parts with the boards' facts as one.

A board that has to go to another house is not in scope: then it is two designs. A per-board
override could come later if it is asked for.

## 6. One enclosure, one assembly

Each board has a place in the assembly: `{ x, y, z, rot, flipped }` in mm against the first
board. A `stack` or `edge` mate derives it: the second board sits where the connector puts it,
at the mated height. The agent does not compute stacking heights, the kernel does, and when the
footprints cannot mate (wrong pitch, pins that do not land) that is the error. A `cable` leaves
the place to the agent (`set_board placement3d`) or the enclosure script.

**Built** (`kernel/src/assembly.ts`, `BoardPlace`): the frame is the first board's board view (x
right, y down from its top-left corner, z up from its top surface). A `stack` mate places the
board it reaches from a placed one: the pads of the mated pairs, as each board's placement has
them, are fitted onto each other (a turn of any angle, snapped to a quarter turn where it is
one). Connectors on opposite sides of their boards (a header on top, a socket underneath) leave
the second board the right way up; on the same side, it is turned over about its own y axis.
The height between the boards is the mate's `height_mm` (the connectors' stacking height from
their datasheets), else the taller connector's body height, marked as assumed. Pads that do not
land after the fit (over 0.3 mm), an `edge` mate (the card standing in its slot: not yet) and a
board no stack reaches leave the board beside the others, 10 mm apart, with the reason in `by`.
`get_board` without a board gives each board's `assembly`. The Layout view's 3D view shows every
board where it stands, and the STEP export writes them all (each board a sub-assembly of its PCB
and parts, named after it, placed by the same transform). Not yet: `set_board placement3d` for
a cable's board.

The enclosure library (built, [enclosure](enclosure.md) §3): as sketched below, but `at` is the
point of the script's frame where a board's own origin is, with `rot` and `flipped`; `parts_info`
covers every board's parts where they stand; `pcbs()` is every board; `hole_posts(from, { board })`
stands posts under another board's holes from z = from (the board below's top: standoffs).

The enclosure library ([enclosure](enclosure.md) §3) keeps its single-board globals as the first
board, so existing scripts run unchanged, and gains:

```js
boards = [{id: "b_1", name: "Main", at: [0, 0, 0], …}, {id: "b_2", name: "Display", at: [0, 0, 12.6], …}]
pcb(board)                         // that board, placed in the assembly
parts_info[i].board                // which board a part is on
hole_posts(from, { board, d })     // posts under one board's holes; standoffs between boards
mates = [{a: "J1", b: "J2", kind: "stack", height: 11}]
```

The STEP export writes the assembly with every board; each board's own STEP stays available.

## 7. UI

Agent-first, as elsewhere: no new buttons. The board tab shows a board picker once there is a
second board (like the Gerber viewer's tool list), and the 3D view shows the assembly. The
schematic marks a mated connector with where it goes ("→ J2, Display").

## 8. Format and migration

Built differently from the first plan, so that a design of one board is stored exactly as before
and needs no migration: the first board (`b_1`) keeps its settings in `Design.board`; the others
are entries of `Design.boards` (`{ id, name, order, settings }`, with an entry for the first
board's name). `Sheet.board` and `Component.board` say where parts go. A design of several boards
is format 3 (`MULTI_BOARD_FORMAT`), so a 4k7 that knows one board refuses it instead of putting
every part on one board; with one board again (`remove_board`) it is format 2. Each board's
routed copper is written on one line, as the first board's always was. The test suite on
one-board designs is the guard: their views, checks and production files come out the same.

Changesets: a board of several is a hunk of its own (`board:b_2`); accepting a change without
the hunk that added a board leaves its sheets and parts on the first board.

## 9. Build order

1. **Boards in the model** (built 2026-11-22). `boards`, sheet and part assignment, `board` on the
   board ops and queries, per-board placement, routing, DRC, panel and production files, the
   board picker. The enclosure and the design document show the board shown (the 3D view and
   the cost: steps 2 and 3).
2. **Mates.** The op, the kinds and their pin maps, the checks (built 2026-11-22; `get_summary`
   lists the mates with their pin pairs). The assembly position from `stack` mates, the 3D view of
   every board and the STEP file of them all (built 2026-11-23). Still to come: an `edge` mate's
   board standing in its slot, a place for a cable's board.
3. **System outputs.** Shared fab profile (built), the cost and stock checks of every board
   (built 2026-11-23), the enclosure library with every board (built 2026-11-23); still to come:
   a combined BOM file.
4. **Agent guide** (built 2026-11-23): [boards.md](boards.md), `get_guide boards`, and a line in
   the agent's instructions pointing to it: when to split a design, setting the boards up, which
   mate kind to choose, the checks, how to change from header to cable.

## 10. Open questions

- One schematic connector drawn twice (a header and its socket as one symbol spanning two
  sheets), or always two parts? Two parts is simpler and matches the BOM; proposed.
- Should a `stack` mate choose the second connector for the agent (the socket that fits the
  header)? Useful, but a sourcing question; later.
- Panels with both boards on one panel, to save a second panel fee: possible once both share a
  house, not in the first slice.
