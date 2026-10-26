# Schematic: a guide for the agent arranging a schematic

> Part of [schematic-drawing.md](schematic-drawing.md) §2b. Status: 2026-10-25. Written to the agent:
> this text is what it reads (`get_guide schematic`) before it groups, rearranges or tidies a sheet.
> The user's schematic notes and what the user asks win over it.

A schematic reads well when the eye finds the big picture first: a few framed blocks, each one
function, in the order the power and the signals flow, and inside each block a circuit drawn with
wires that can be followed. Net labels are for the connections between blocks and across pages; a
page full of labels (every part an island) hides the circuit. You decide what belongs together and
roughly where it goes; the kernel draws the rest, as on the board where you place the main parts
and the placer puts the small ones round them.

## 1. Blocks first

`describe blocks`: a title and the parts of each block, in reading order. Every part in exactly
one block (`get_schematic` lists parts in none, and the ones the layout put with a block: `guessed`).
The texts can wait for the design document; a block keeps its text when you give it again without one.

What makes a good block:

- **One function**, named as an engineer would: "USB-C input and protection", "5 V buck converter",
  "RP2040 with crystal and flash", "Status LEDs", "LED chain".
- **What is read together is in one block.** A wire runs only inside a block; between blocks the
  kernel draws net labels. A regulator with its input and output caps, its divider and its
  compensation; an MCU with its crystal, flash, decoupling and reset parts; a connector with its
  series resistors and ESD parts; a driver with the chain it drives.
- **Not too big.** A block never splits across pages unless it is taller than one (a long chain):
  then it continues on the next page, cut between its rows. A block wider than a page cannot be
  drawn well: split it by function.
- **Small parts go with the pin they serve**: a pull-up with the IC whose pin it pulls, a divider
  with the input it feeds (it then stands at that pin, wired), unless the user wants it elsewhere.
- **Order**: power in, protection, regulators, then the processor, then the interfaces and outputs,
  as a reader follows the energy and the signals. The blocks flow onto the pages in this order:
  left to right, top to bottom, each to the highest free spot on its page.

## 2. Look, then place

After grouping, look at each page (`get_schematic_image page: n`) and at `get_schematic` (blocks
with page, frame centre and size, labels). Then move what reads badly:

- `place_block block page x y` puts the centre of a block's frame there (page mils, on the grid);
  the other blocks flow round it. A block that would lie on one placed before it moves aside to the
  nearest clear spot on its page, or flows with the others when the page has none: the result says
  where it went. `auto: true` lets it flow again.
- Inputs left, outputs right; supplies above or left of what they feed; a block next to the blocks
  it has the most labels to.
- Fewer, fuller pages read better than many empty ones; `set_paper A3` when the blocks of a sheet do
  not fit A4.

## 3. Inside a block

The kernel arranges a block's parts so the pins that connect face each other: a part goes to the
side of the IC where its pins for it are, mirrored when that turns its own pins toward the IC; a
chain wraps into rows; a row of parts on one supply gets one bar with one supply symbol. Where a
connection would cross several wires, wander far or run round a part and back, it is drawn as a
pair of labels instead. Your levers:

- `constrain left_of / right_of` between two ICs or connectors of a block.
- `constrain arrangement` on an IC or connector: `mirrored` / `unmirrored`; on a small part at an
  IC's pin: `up` (standing above the pin's wire, its far end on top) / `down` (hanging below).
- `set_symbol layout` to order an IC's pins like the pins they connect to (a QSPI flash next to an
  MCU: same order on both, and the six wires run straight instead of crossing into labels).
- Move a part to another block (`describe`) when it is drawn with the wrong one.

## 4. Check before you finish

- Labels between blocks only: a label pair inside one block is a wire that did not fit (reorder
  pins, mirror a part, or split the block).
- No part guessed into the wrong block, no part in none.
- The drawing warnings (SCH.*): text running into something, a jog, a pull-up hanging.
- Say in your reply what you grouped and what you moved, in a sentence or two.

## 5. Drawing a sheet exactly

When the user wants a sheet to look like a reference, a sketch or an earlier drawing, take it over:
`place_symbol` moves a part to exact page coordinates, `wire` / `label` / `erase` decide each
connection. From the first move the sheet stays as you leave it: it is no longer redrawn after a
change, parts added later are drawn next to their block, and connections the drawing does not show
appear as labels. `place_block` on such a sheet draws a block afresh, together and wired, where you
put it (the result says what it runs into). `auto_draw` hands the sheet back to the layout. Use this only when the user asks for it:
the drawing then no longer keeps itself tidy.
