# KiCad export

> Packages X1 (the board) and X2 (the schematic and the project) of the [roadmap](../ROADMAP.md). Status:
> design, 2026-11-27. Built: steps 1 and 2 of §8 (the board file and the footprint library,
> `packages/fab/src/kicad/`), not yet reachable from the app, and not yet opened in KiCad (§9). Decision D2
> is taken: export to KiCad is wanted, which rewrites the non-goal in [ARCHITECTURE](../ARCHITECTURE.md) §1
> in X1's last pull request.

## 1. What it is, and what it is not

A download, "KiCad project (.zip)", beside "Fab files" and "STEP" in the layout view: the design as a
project KiCad 10 opens, with the board as it stands and (X2) the schematic as drawn.

It is there for three things. A user can leave with their design. A change the agent cannot be talked into
is made by hand in KiCad. And a colleague or a contract manufacturer who asks for "the KiCad files" gets them.

It is one way. What is changed in KiCad does not come back; exporting again writes the project afresh from
the design in 4k7. (Reading KiCad projects is package X5 and a separate design.) The zip says so in a
`README.txt`, together with what did not carry over (§6).

## 2. The files

```text
lamp-kicad/
  lamp.kicad_pro          project: board rules, net classes                       X1
  lamp.kicad_pcb          the board                                               X1
  4k7.pretty/*.kicad_mod  one footprint per package, as on the board              X1
  fp-lib-table            names 4k7.pretty as library "4k7"                       X1
  lamp.kicad_sch          root sheet: one sheet symbol per page                   X2
  lamp-<page>.kicad_sch   one file per schematic page                             X2
  4k7.kicad_sym           the symbols, as drawn                                   X2
  sym-lib-table           names 4k7.kicad_sym as library "4k7"                    X2
  README.txt
```

A KiCad project has one board. A design of several boards is exported as one project folder per board in
the same zip, each from that board's focus (`focusBoard` in `packages/kernel/src/boards.ts`: the design seen
as if that board were its only one), so each schematic holds the parts of its board. The mates between
boards are named in the README and nowhere else.

**The format.** The files are written in the format of KiCad 10.0. The version tokens (`(version …)` of
each file type) are not taken from memory. They come from KiCad's source at tag `10.0.0` of
[KiCad/kicad-source-mirror](https://github.com/KiCad/kicad-source-mirror) (read 2026-11-27): the board and
footprint version `SEXPR_BOARD_FILE_VERSION` = 20260206 in `pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h`
(the `10.0` branch had the same value), the writer `pcb_io_kicad_sexpr.cpp` for the tokens, their order
and what is written in the footprint's frame, the reader `pcb_io_kicad_sexpr_parser.cpp` for how angles
and nets are read back, `common/io/kicad/kicad_io_utils.cpp` for the layout of the text,
`libs/kimath/src/trigo.cpp` and `pcbnew/footprint.cpp` for the senses of rotation and flipping,
`common/libraries/library_table.cpp` for `fp-lib-table` (version 7). The layer table and the order of the
top-level sections are those of a board saved by KiCad 10.0, `demos/pic_programmer/pic_programmer.kicad_pcb`
at that tag: an excerpt of it is kept in `packages/fab/test/kicad/reference/` (CC BY-SA 4.0, as KiCad's
demos are) and the tests hold the writer against it. The text is laid out as KiCad lays it out (one tab
per level, a list without inner lists on one line), so a file KiCad saves again differs little. KiCad
opens files older than itself and refuses newer ones, so the tokens stay those of 10.0 while later KiCad
releases come out. Every file carries `(generator "4k7")` and `(generator_version "<4k7's version>")`.

**The same design gives the same bytes.** No time and no random ids. KiCad wants a UUID on nearly
everything; they are derived (UUID version 5) from the design's name and the entity's id (`c_12`, a track's
index on its net and layer, a page's number), so a second export differs only where the design does, and a
footprint keeps its link to its symbol.

## 3. The board (X1)

4k7's board is already close to KiCad's: millimetres, y down, the copper layers under KiCad's own names
(`F.Cu`, `In1.Cu`, `In2.Cu`, `B.Cu`). The export reads a `BoardView` (routed or drawn) as the Gerber export
does, and the `Design` for what the view does not carry.

| 4k7 | KiCad | Notes |
|---|---|---|
| Board coordinates, top-left of the outline at 0, 0 | The same, shifted by a fixed offset (the outline's top-left at 100, 100 mm) so the board lies on KiCad's page; the auxiliary origin set to that point | The sheet is the smallest ISO size from A4 that holds the board there |
| `BoardView.shape`, `cornerRadius`, outline | `gr_line`, `gr_arc`, `gr_poly` on `Edge.Cuts` | The rectangle as four `gr_line` and, with rounded corners, four exact `gr_arc` (start, mid, end); a free-form `shape` as one `gr_poly` of `boardPolygon`'s points |
| `cutouts` | The same, on `Edge.Cuts` | A circle as `gr_circle`; a rectangle (rounded, turned) and a slot as lines and arcs, turned as `cutoutPolygon` turns them |
| `Stackup` (copper, dielectric with thickness and εr, mask) | `(setup (stackup …))` and the board thickness | Layers as the stack-up lists them; the default stack-up where none is set |
| `BoardPart` | `(footprint "4k7:<pkg>" … (at x y rot))` on `F.Cu` or `B.Cu`, the footprint's contents inline | 4k7 turns clockwise as seen from the top; KiCad's orientation is counter-clockwise on screen (its `RotatePoint`). A top part is at −rot; KiCad flips a footprint to the bottom about its horizontal axis and turns it 180° (`FOOTPRINT::Flip`), which is 4k7's mirror left to right and turn by rot when the orientation is 180° − rot. Written in (−180°, 180°] as KiCad keeps them (270° is −90). The contents of a bottom footprint are already flipped in the file (B. layers, y mirrored in its frame), as KiCad saves them. `locked` parts carry `(locked yes)` |
| `BoardPad` | `(pad "<number>" smd|thru_hole|np_thru_hole rect|oval|circle …)` in the footprint's own frame | Pads are absolute and already turned in the view: the part's position and rotation are taken out again (KiCad's writer: the offset from the footprint turned back by its orientation). The pad's angle in the file is absolute, the footprint's orientation (KiCad reads it so: `PAD::SetOrientation`), its size in its own frame. `round` with w ≠ h is `oval`. `slot` is an oval drill (`(drill oval w h)` in the pad's frame). `npth` is `np_thru_hole` with the size of its drill: KiCad's hole has no copper, where 4k7's pad there is the copper kept clear round it. SMD pads are on `F.Cu F.Mask F.Paste` (or `B.`), through-hole pads on `*.Cu *.Mask` |
| A pad's further pins (`also`: USB-C's A1 and B12 on one pad) | One more pad of the same shape on the same spot per further pin | So every pin of the symbol has a pad of its number |
| The part's body outline, polarity mark, courtyard | Footprint graphics on `F.SilkS`, `F.CrtYd`, `F.Fab` (or the `B.` layers) | The body (`bodyOutline`, or a circle) as `fp_poly` on `F.Fab` and on `F.SilkS`, whole: the Gerber export cuts the silkscreen outline off pads, KiCad does not, so its DRC may report silkscreen over pads. The courtyard as `fp_rect` on `F.CrtYd`; the `PolarityMark`'s strokes as `fp_line` and its dots as filled `fp_circle` on `F.SilkS`. Polygons are written in one order (clockwise from the top-left corner) so a package turned is the same footprint |
| The refdes, or `silk` text | The footprint's `Reference` property on the silkscreen, at the place and height the Gerber export prints it (`silkTexts` in `gerber.ts`) | KiCad draws it in its own font; the place can differ by a little. Its angle is 0: KiCad reads a footprint text's angle as absolute. Where there was no room it is hidden. A test point's `TP_<net>` is a `fp_text user` there, and the `Reference` hidden |
| Value, MPN, LCSC and Eurocircuits numbers, `dnp`, `padOnly` | `Value` and further properties; the `dnp` and `exclude_from_bom` attributes | `Value` on `F.Fab`; `Manufacturer`, `MPN`, `LCSC`, `Eurocircuits` as hidden properties. `smd` or `through_hole`; a `dnp` part `exclude_from_pos_files exclude_from_bom dnp`, a bare pad `exclude_from_pos_files exclude_from_bom`, as 4k7's BOM and pick-and-place leave them out |
| Mounting holes | A footprint with one `np_thru_hole` pad | `4k7:MH-<d>` (`MH-<d>-PTH` plated, a `thru_hole` pad with its net), its pad numbered "1" as in 4k7, its courtyard, no silkscreen, `exclude_from_pos_files exclude_from_bom` |
| `Track` (a polyline) | One `(segment …)` per piece, with layer, width and net | `locked` tracks carry KiCad's `locked`. A piece of length 0 (a point repeated) is left out |
| `Via` | `(via (at …) (size pad) (drill …) (layers "F.Cu" "B.Cu") (net …))` | Every via goes through: its layers are the board's first and last copper layer |
| A plane or pour (`BoardView.planes`, `Zone`) | A `(zone …)` with the net, the layer and its outline: the board's outline, or the area's rectangle with a higher priority | See below |
| `PlaneStyle` (clearance, thermal reliefs or solid, spoke width) | The zone's `connect_pads`, clearance, thermal gap and spoke width | |
| `Keepout` | A rule area: a zone with `(keepout …)` for what it forbids | |
| `SilkGraphic` | Filled `gr_poly` on the silkscreen | |
| `BoardRules` (clearance, track, power track, via, edge clearance) and the fab profile's limits | The board's constraints and the net classes in `.kicad_pro`: `Default`, `Power`, and one class per further track width set on a net | |
| `ImpedanceRule` | A net class per rule with its width and, for a pair, its gap | |
| Nets | By name, as KiCad 10 writes them: there is no net table, every pad, segment and via says `(net "GND")` (board version 20251028 stopped writing net codes; the reader makes a net of each name it meets) | Names as in 4k7. A pad on no net has no `net` |

**Pours are KiCad's to fill.** A zone is written with its outline and its settings and without a fill:
KiCad fills it when the board is opened and refilled (the README says to press B). KiCad's fill is not
4k7's: thermal reliefs, islands and the gap round an area plane come out a little differently. What 4k7
checked on its own fill (spoke currents, a floating pour, a split under a line) is therefore not checked
for KiCad's. Writing 4k7's fill as KiCad's filled polygons would need the fill as polygons with holes, which
the kernel does not have (it has an outline, cuts and added strokes); it can follow if users ask.

**Not on the board file:** the panel, the fab notes, the ledger, the waivers, the spec.

### The footprint library

`4k7.pretty` holds one `.kicad_mod` per package in use, the same pads and package graphics (body,
courtyard) as inline on the board, turned to rotation 0 on the top side, without nets and without the
footprint's own uuid and position (as KiCad writes a library footprint, `CTL_FOR_LIBRARY`). What belongs to
the part on this board stays on the board: its polarity mark (placed round its neighbours) and its texts;
the library has a `Reference` of `REF**` above the courtyard and the footprint's name as `Value` below it,
as KiCad's own libraries do. A package drawn in two ways (the same name, other pads) gets a second name,
`<pkg>_2`. Characters a file name or KiCad's library id cannot hold are replaced by `_`. KiCad does not
need the library to open the board; it needs it when the user updates the board from the schematic or swaps
a footprint. `fp-lib-table` names the folder as library "4k7" (`${KIPRJMOD}/4k7.pretty`).

## 4. The schematic (X2)

The export reads the `SchematicView` (what the app draws: `kernel.state().view`), so the schematic in KiCad
is the one on screen, drawn by the layout or arranged by the agent.

- **Units.** The view is in mils on a 100 mil grid; KiCad's file is in mm (× 0.0254), and 100 mil is on
  KiCad's 50 mil grid, so every pin and wire end stays on grid.
- **Pages.** A 4k7 sheet flows onto pages; a KiCad sheet is one page. Each page becomes a `.kicad_sch` file,
  and the root sheet holds a sheet symbol for each, in order, and nothing else. Paper as `PAPERS`.
- **Nets across pages.** A net in 4k7 is one net by name wherever it appears. In KiCad a local label joins
  only within its sheet. So every net label is written as a **global label** (its shape from the label's
  `flow`: input, output, bidirectional), and supply symbols as **power symbols**, which are global too.
- **Symbols.** KiCad places a library symbol turned by quarter turns and mirrored; 4k7 draws symbols with
  their graphics already turned (by 45° steps for some) and their pins already placed. So the library gets
  one symbol per distinct drawing: per part card and per way it is drawn (`SymbolSpec`, the unit), with the
  view's `prims` as they are (rectangle, polyline, circle; a `path` flattened to polylines; text), and it is
  placed without rotation or mirror. A split symbol (U1A, U1B) is one KiCad symbol with units.
- **Pins.** A pin's place is `PinView.x, y` (the end of the pin's line), its direction from `side`, its
  electrical type from the card's `PinType`:

  | 4k7 | KiCad |
  |---|---|
  | `in`, `out`, `bidir`, `tri` | `input`, `output`, `bidirectional`, `tri_state` |
  | `pwr_in`, `pwr_out` | `power_in`, `power_out` |
  | `passive`, `oc`, `nc` | `passive`, `open_collector`, `no_connect` |

  In the view the pin's line is one of the `prims` (`PIN_LEN`, 200 mil, in `packages/parts/src/symbolgen.ts`)
  and its name and number are drawn by the app. Where a pin's line is a straight stroke of that length from
  its connection point, the KiCad pin gets that length, the stroke is left out of the graphics, and KiCad
  draws name and number (hidden where `showName` or `showNumber` say so). Any other pin is written with
  length 0, with its name and number as text where the app draws them.
- **Wires, junctions, no-connects.** `WireView.pts` as `wire` pieces, `junctions` as `junction`,
  `noConnects` as `no_connect`.
- **Blocks.** A block's frame (`BlockView`) is a rectangle with its title as text. The description's text
  stays in the design document.
- **The link to the board.** Each placed symbol has its derived UUID, a `Footprint` of `4k7:<pkg>`, and the
  fields the footprint carries (value, MPN, LCSC). Each footprint on the board has the `path` of its symbol
  (the page's and the symbol's UUID). KiCad matches the two by that path, so "Update PCB from schematic"
  finds every footprint instead of adding a second set.

**Net names.** A net the user or the agent named has a label and keeps its name. A net with a name the
kernel made up (`N$12`, `isAutoNet`) that is drawn as wires only has no label, and KiCad names it after one
of its pins. The board file is therefore written with KiCad's name for such nets, worked out the same way
from the exported schematic, once X2 is in; until then (X1 alone) with 4k7's.

## 5. Tests

In `npm test`, with nothing installed:

- **A writer and a reader for s-expressions** (`sexpr.ts`): numbers with at most six decimals and no
  trailing zeros, strings always quoted, the same input the same text; what is written parses back.
- **Counts and nets.** For the golden designs the exported board is read back and compared with the
  `BoardView`: a footprint per part with its pads, a segment per piece of track, every via, every pad's net.
- **Pad geometry.** A part on the top and on the bottom side, at 0, 90, 180 and 270°, with a pad off centre:
  each exported pad, put through the footprint's position, rotation and side again, lands where the view has it.
- **Snapshots** of a small design's files, so a change of output is seen in review.
- **X2: the netlist.** The exported schematic is read back and its nets rebuilt from wires, pins and global
  labels alone; the sets of pins per net equal the design's.

Where `kicad-cli` (KiCad 10) is on the path, and skipped with a note where it is not:

- `kicad-cli pcb drc --refill-zones --format json`: the report has no short and no unconnected item. KiCad
  reports other things 4k7 judges differently (silkscreen, courtyards); the test lists them and does not fail
  on them.
- `kicad-cli pcb export gerbers` on the exported board, and those Gerbers through 4k7's own read-back
  (`packages/fab/src/fabread.ts`, `netcheck.ts`) against the design's netlist: the copper KiCad makes from the
  export joins what the design joins.
- X2: `kicad-cli sch export netlist`, and its nets against the design's by their pins.

CI does not install KiCad at first. The checks with `kicad-cli` are run by hand before a release, like
`check:codex` ([distribution](../distribution.md)), and move into CI if they prove stable.

## 6. What does not carry over

Written into the README of every export:

- Pours are filled by KiCad, and 4k7's checks on its own fill do not apply to that fill (§3).
- 4k7's checks, waivers, constraints and spec. KiCad's ERC and DRC judge by their own rules and will report
  things 4k7 does not, and the other way round.
- The enclosure, the panel, sourcing and cost.
- 3D models: KiCad shows the board without parts. (The STEP download has them.)
- Silkscreen text is in KiCad's font.

## 7. Where the code goes

`packages/fab/src/kicad/`: `sexpr.ts` (writer, and the reader the tests use), `uuid.ts`, `footprint.ts`,
`board.ts`, `project.ts`, then `symbol.ts` and `schematic.ts`. One entry point,
`kicadProject(design, boards, view, stamp): FabFile[]`, zipped by the existing `zip.ts`. Until `project.ts`
is there (step 3) the board's part is `kicadBoardFiles(view, project, stamp): FabFile[]` in `board.ts`
(`<project>.kicad_pcb`, `fp-lib-table`, `4k7.pretty/*.kicad_mod`), exported from `packages/fab`; the
UUIDs are derived from `project`. The button is in
`apps/web/src/lib/components/LayoutView.svelte` beside the two downloads there. No op and no agent tool:
it is a download the user asks for, like the fab files.

## 8. Pull requests

X1:

1. `sexpr.ts`, `uuid.ts`, `footprint.ts` with the footprint library; the fixture from KiCad 10; the pad
   geometry test.
2. `board.ts`: outline, parts, tracks, vias, nets; the counts-and-nets test on the golden designs.
3. Zones, keep-outs, stack-up, silkscreen graphics; `project.ts` with rules and net classes.
4. The button, the README, several boards, the `kicad-cli` checks as a script (`scripts/check-kicad.mjs`);
   ARCHITECTURE §1 (the non-goal becomes "no round trip; import is X5") and §7; CHANGELOG.

X2:

5. `symbol.ts`: the library from the view, pins, units.
6. `schematic.ts`: pages, the root sheet, wires, labels, power symbols, blocks; the netlist test.
7. The link between symbols and footprints, the library tables, KiCad's names for unlabelled nets, the
   `kicad-cli` netlist check; CHANGELOG.

## 9. Open points

- **Nobody has opened the output in KiCad yet.** KiCad could not be installed where steps 1 and 2 were
  built: the format was taken from KiCad 10.0's source and one board it saved (§2), and the tests read the
  files back with 4k7's own reader. The first thing to do with steps 1 and 2 is to open an exported board
  (and its library) in KiCad 10 and run the `kicad-cli` checks of §5 on it; what KiCad says goes into the
  writer and this design.
- The reference is an excerpt of a demo board saved by KiCad 10.0, not a small project saved for 4k7: it
  holds the header, the layer table, a segment and a via, but no footprint of the 10.0 format (the
  footprint's tokens come from the writer's source). A footprint and a `.kicad_mod` saved by KiCad 10 could
  be added when KiCad is at hand.
- The pick-and-place file (`pickAndPlace` in `gerber.ts`) writes a bottom part's rotation as rot − 180°;
  the orientation KiCad gives the same part (§3, from `FOOTPRINT::Flip`) is 180° − rot. The two agree at
  0° and 180° and differ by 180° at 90° and 270°. Which convention the house reads is the pick-and-place's
  question ([assembly](assembly.md)); a KiCad position file of the export would show KiCad's.
- Whether KiCad's name for an unlabelled net can be reproduced exactly in every case; if not, such nets get
  a small global label in the export and the README says so.
- Text sizes: the app's pin names and numbers against KiCad's defaults, for symbols with many pins.
- Whether the footprint library should also be offered alone, for users who only want 4k7's footprints.
