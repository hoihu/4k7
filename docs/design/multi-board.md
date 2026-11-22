# Several boards in one design

> Part of the [architecture](../ARCHITECTURE.md). Status: step 1 built (2026-11-22): boards in the model, per-board layout and production files, the board picker (§9). Mates (§3) and the system outputs are not built yet.

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

| Intent | Op (sketch) |
|---|---|
| Add a board | `add_board { name, sheets? }` → `b_2` |
| Rename one, take one away | `set_board { board, name }`, `remove_board { board }` (its parts go back to the first board) |
| Put a sheet's parts on it | `assign_board { sheet, board }` (a sheet belongs to one board) |
| Move one part to another board | `assign_board { components, board }` (overrides its sheet) |
| Join two connectors | `mate { a: "J1", b: "J2", kind, map?, … }` |
| Everything else | the board ops and queries as now, with an optional `board` |

A component's board is its own `board`, else its sheet's, else the first board. Sheets are how
people already split such a schematic ("Main", "Display"), so in practice the agent assigns
sheets and hardly ever single parts.

`board` may be left out wherever there is only one board. With two, a board op without it works
on the board of the parts it names (`place R4`), and one that names none is refused
(`BOARD_AMBIGUOUS`) with the boards as candidates; one that names a part of another board is
refused too (`BOARD_INVALID`). The app's own edits (a drag, the panel's tabs) are for the board
shown. Queries: `get_board` without `board` answers for every board; `get_copper`,
`get_current_map`, `try_placements` and `suggest_moves` need it. `get_summary` lists the boards
(name, sheets, parts), each part's board, and the boards a net spans. `get_board_image` and
`view_gerbers` take `board` and show that board in the app.

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
| `cable` | JST, ribbon/IDC, FFC/FPC, harness | no | by kind: `straight` (1→1), `ribbon` (IDC, as the cable mirrors), `fpc_same_side` / `fpc_opposite` |
| `edge` | card edge into a slot | yes | contact to contact |
| `wire` | solder pads and loose wires | no | pairs, explicit |

`map` overrides the default with explicit pairs `[["1","2"],…]`, for anything odd. A mate
stores the two component ids, the kind, the map and, for `cable`, a length (for the enclosure
and the BOM).

### 3.1 Nets across boards

Nets stay logical. The agent connects the MCU's `SDA` to the display's `SDA` as now, and puts
`J1.3` and `J2.3` on the net too. The kernel then splits each net by board and checks:

- **`ERC.BOARD_CROSSING`** (error): a net with pins on two boards whose parts on each board are
  not joined through a mated pin pair. This is "forgot to bring it out on the header".
- **`ERC.MATE_MISMATCH`** (error): two mated pins on different nets. This is the mirrored or
  shifted header.
- **`ERC.MATE_OPEN`** (warning): a mated pin with a net on one side and nothing on the other.
- Current: a power net's current through a mate is checked against the connector's per-pin
  rating, when the card has one (the existing current check, [layout](layout.md) §14).

The router, the placer and the DRC each see one board: the part of each net on that board,
ending at its connector pin. Nothing in them needs to know other boards exist.

## 4. Per board, and for the whole system

| Per board | For the system |
|---|---|
| outline, layers, stack-up, rules | the fab house (one profile for the design, §5) |
| placement, routing, copper, DRC | the ERC and the mate checks |
| panel | the enclosure and the 3D assembly |
| Gerber, drill, pick-and-place, fab check: one zip per board (`<design>-<board>.zip`) | the BOM: per board and combined; the cost and the order |

## 5. Same fab house

One fab profile for every board: `set_fab_profile` sets it on each (built: stored per board, as
the profile was, so the DRC of each board reads it where it always did; a new board starts with
the first board's layers, rules and profile). Each board still has its own layer count, thickness
and stack-up, checked against that one profile. The cost and the order
put both boards in one order with their own line items, and the parts' sourcing counts the
combined quantities, so a part used on both boards is bought once.

A board that has to go to another house is not in scope: then it is two designs. A per-board
override could come later if it is asked for.

## 6. One enclosure, one assembly

Each board has a place in the assembly: `{ x, y, z, rotation, flipped }` in mm against the first
board. A `stack` or `edge` mate derives it: the second board sits where the connector puts it,
at the mated height. The agent does not compute stacking heights, the kernel does, and when the
footprints cannot mate (wrong pitch, pins that do not land) that is the error. A `cable` leaves
the place to the agent (`set_board placement3d`) or the enclosure script.

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
   board picker. The enclosure, the 3D view and the design document show the board shown; the
   cost estimate of a design of several boards counts its parts only (the boards' making and
   assembly need step 3).
2. **Mates.** The op, the kinds and their pin maps, the three checks, the assembly position from
   `stack`/`edge` mates, 3D assembly view and STEP.
3. **System outputs.** Shared fab profile, combined BOM, cost and order, the enclosure library
   with every board.
4. **Agent guide.** A section in the layout guide: when to split a design, which mate kind to
   choose, how to change from header to cable.

## 10. Open questions

- One schematic connector drawn twice (a header and its socket as one symbol spanning two
  sheets), or always two parts? Two parts is simpler and matches the BOM; proposed.
- Should a `stack` mate choose the second connector for the agent (the socket that fits the
  header)? Useful, but a sourcing question; later.
- Panels with both boards on one panel, to save a second panel fee: possible once both share a
  house, not in the first slice.
