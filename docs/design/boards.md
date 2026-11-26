# Several boards: a guide for the agent

> Part of [multi-board.md](multi-board.md). Status: 2026-11-23. Written to the agent: this text is
> what it reads (`get_guide boards`) before it splits a design over several boards or joins them.
> What the user says about their product wins over it.

A product of several boards is one design: one schematic, one netlist, one fab house, one box. Each
part is on one board. The boards are joined by a connector on each, and you say how with a
**mate**. The kernel then checks the connection pin by pin. The placer, router, DRC and production
files work on one board at a time.

## 1. When to split a design

Split only when the product needs it, and when the user says so or agrees. Two boards cost more
than one: a second setup and stencil at the assembly house, two connectors, and one more thing to
go wrong. Good reasons:

- **The mechanics ask for it.** A display, buttons or LEDs on the front panel and the electronics
  behind it. A sensor that has to sit somewhere else (on a probe, at the far end of a box). A board
  that has to fit an enclosure the user already has.
- **One part of the circuit is changed or reused alone.** A sensor board in two variants, a main
  board that takes several front boards.
- **Very different boards.** A small RF or high-density part on 4 layers and a large simple part on
  2. Each board has its own layers, stack-up, rules and size.

Not a reason: the board is crowded. Make it bigger, use the bottom side or 4 layers first. Ask the
user before you split a design they did not ask to split.

## 2. Setting it up

1. **One sheet per board** is the usual way: the schematic is already split that way ("Main",
   "Display"). `add_sheet`, then `move_to_sheet` the parts.
2. `add_board { name, sheets }`: the new board takes those sheets' parts. It starts with the first
   board's layers, rules and fab profile. Single parts go elsewhere with
   `assign_board { board, refs }`.
3. **A connector on each board**, as two parts in the schematic: the header on one board's sheet,
   the socket or the other end on the other's. Put the pins of both on the nets that cross:
   `connect` J1.3, J2.3 and the parts they serve to SDA. A net stays one net across the boards.
4. **`mate { a, b, kind }`** says how the two connectors are joined (§3).
5. **Lay out each board.** Board ops take `board` (a name or id). Without it they work on the board
   of the parts they name (`place R4`), else on the board of the nets they name when those are on
   one board. An op that says neither is refused (`BOARD_AMBIGUOUS`). `get_board` without `board`
   answers for every board, as does `get_fab_profiles` (each board's layers and profile);
   `get_copper` and the other board queries take the board of the parts or nets they name, as the
   ops do, and are refused when they say neither. `calc` `impedance` and `track_current` work
   on one board's stack-up and `current_rise_c`: give `board` when the boards differ. The production files
   are per board: `view_gerbers` and `get_board_image` take `board`.

**A board laid out in another project** (the user's LED ring in a project of its own): look at it
first with `design_query get_board { project }`, then `design_edit import_board { project, as: "LED" }`
with `dry_run` to see which nets join by name. Keep a net that only shares a name apart with
`nets: { "LED": "fresh" }`; map one onto another name with `nets: { "VLED": "+5V" }`. Recheck the
joined nets the effect lists as differing (a voltage). A joined net whose width differs keeps its
own width on the boards here and the source's on the new board (the effect lists it under "track widths
kept"; two source nets on one net: the wider): nothing to set. Then apply it with the `mate` of the two
connectors in the same transaction (the effect gives their new refdes). The parts arrive on their own footprints (a generic
part the source gave its own land pattern on a card of its own, `generic:…~2`: the effect says "keeps its
footprint"; the parts here keep theirs) and where the
source has them (its placement, pins, sides, keep-outs, graphics and panel), with its planes, via
groups and impedance rules. Drawn copper comes as drawn: the board is routed. The router's copper
comes as locked copper when it was routed as it stands: route the board (step 5 above), which lays
it as it lies and routes the rest; it stays locked (`unlock_copper` lets it go). When the effect says
the copper was stale or stopped, it did not come: route the board.

## 3. Which kind of mate

| `kind` | Use it for | How the pins pair |
|---|---|---|
| `stack` | One board plugged onto the other: a pin header into a socket, a mezzanine or board-to-board connector | From the two footprints facing each other: each pin meets the pin it lands on |
| `cable` | A JST or other wire-to-board cable, a ribbon with IDC connectors, an FFC/FPC | `cable: straight` pin n to pin n (default), `reversed` pin n to pin N+1−n |
| `edge` | A card edge into a slot | Contact to contact, by number |
| `wire` | Solder pads and loose wires | `map`, which you give |

- **stack**: give `height_mm`, the distance between the boards when mated: the stacking height from
  the header's and the socket's datasheets (a 2.54 mm header in a standard socket is usually
  11 mm). The kernel places the second board from it (`get_board` lists where each board stands)
  for the 3D view, the STEP file and the enclosure. Without it, the taller connector's body height
  is assumed, which is rarely right. Put the socket on the other board's underside
  (`constrain` kind `layer`, value `bottom`): then the second board sits the right way up above the first.
  With both connectors on top, the second board is turned over to face the first.
- **cable**: which way round the pins run depends on the cable, not on you. A JST cable made up 1:1
  is straight. An FFC with contacts on the same side at both ends, between two connectors facing
  the same way, usually reverses. Read the cable's datasheet and ask the user if it is not known.
  Give `length_mm` when it is known.
- **map** overrides the kind's pairs (`[["1","2"], …]`, pin names or numbers) for anything odd.
- A connector mates once. `mate` on the same pair again changes it; `remove_mate` takes it away.

## 4. The checks, and what to do about them

- **`ERC.BOARD_CROSSING`**: a net has pins on two boards but no mated pin carries it across. Usually
  a signal not brought out on the connector: put a free pin of each connector on it. Or the mate is
  missing.
- **`ERC.MATE_MISMATCH`**: two mated pins are on different nets. One pin wrong: fix that pin's net.
  Many pins wrong (the message says so) means the connector is mirrored, turned or one pin off.
  Two identical 2×N header footprints facing each other swap their rows: pin 1 meets pin 2. Check
  the socket's datasheet: a socket made for that header numbers its pins so that they meet. Give
  it that footprint (`set_footprint`, from its drawing), or put the nets on the pins that meet. Never
  "fix" a mismatch with `map` unless the cable or connector really pairs the pins that way.
- **`ERC.MATE_OPEN`** (warning): a signal ends at the connector, its mate's pin is on no net. Connect
  it, or `no_connect` both pins if the pin is spare.
- **`ERC.MATE_FIT`**: the connectors do not plug into each other (another pitch, another count). Pick
  connectors that mate.
- **`ERC.MATE_CURRENT`**: the net's current (its `max_current`, else its stated loads) is more
  than its mated pins are rated for (the connector card's per-pin `maxCurrent`, added over the pins
  that carry it). Put the net on more pin pairs (the message says how many), or pick a connector
  rated for more. **`ERC.MATE_CURRENT_UNKNOWN`** (info): the connector's card has no pin rating, so
  the check could not run; it is not fine. Read the contact rating from the datasheet.
- **Power across the connector**: count the pins. A header pin carries about 1–3 A (its datasheet
  says). Put the supply and ground on enough pins for the current, and ground on several pins
  spread along the connector, so every signal has a return path near it.

## 5. From a header to a cable, and back

The nets do not change, only the parts and the mate:

1. Swap the connector parts (`remove` and `add_part`, or `set_param` / `set_footprint`), keeping
   the refdes and pins on the same nets.
2. `mate` again with the new kind (and `cable` or `height_mm`).
3. Read the checks: a cable that reverses the pins shows here as `ERC.MATE_MISMATCH` on every pin.
   Then fix the nets on one connector, not the mate.
4. The board positions change: a cable's board stands beside the others, so the enclosure needs a
   place for it (`get_guide mechanics`, §4.1).

## 6. The rest of the design

- **The fab house** is shared: `set_fab_profile` sets it on every board. Each board keeps its own
  layers, size and rules. A board whose layer count the tier is not made in shows `DRC.FAB_LAYERS`
  naming that board: give it the same house's tier for its layers with `set_fab_profile board:
  "<board>"` (e.g. `jlcpcb/2l-1oz` for a 2-layer board beside a 4-layer one). Another house on one
  board is refused.
- **Cost**: the sourcing cost check prices each board as its own assembly order at the house (its
  own setup and stencil), added up. A second board adds those fees: say so when the user weighs a
  split.
- **The enclosure** is one box for all boards: `get_guide mechanics`, §4.1.
- **Back to one board**: `remove_board` puts its sheets and parts on the first board and drops the
  mates.
