# Production files checked against the design

Built 2026-11-06, after a post-mortem: spiral2's boards were ordered with two faults that only the
files had, and nothing ever read the files back. Every check looked at the board model, so a fault in
the model (a plane cut round J2's slotted shield pads as a circle) or in the writer (a later plane's
clearances erasing an earlier plane's spokes) passed the board view, the DRC and the tests alike. The
tests checked the files' form (headers, apertures, coordinates in range, counts), not their copper.

## The netlist check (`packages/fab/src/netcheck.ts`)

It holds the files against the design the way a fab house's netlist test does, from the files alone:

1. Each copper layer is read back (`readGerber`) and drawn on a grid of 20 µm (coarser on a board
   too big for 40 M cells a layer), its objects in order: dark ones add, clear ones erase what the
   file drew before them. Its copper becomes runs of cells per row, joined into islands (4-connected).
2. The plated holes (`readExcellon`, slots along their length) join the islands their walls touch on
   every layer: samples round the wall, 25 µm outside it (drill tolerance and plating).
3. The design's pads (`NetDesign`, `netdesign.ts` from a board view; `ipcNetDesign` from an
   IPC-D-356 file) are looked up by a flash centred where the board has them on an outer layer. A pad
   the files lack is left out and named (a part moved since files were made); in files just made from
   the design it is a finding.
4. Findings: pads of two nets on one piece of copper (a **short**); a net on pieces of copper not
   joined, beyond the connections the design leaves unrouted itself (an **open**; those it leaves are
   counted, not reported); a pad with no copper on a layer it is on (something drawn after it cleared it);
   copper of 2 mm² and more joined to no pad (**floating**, named after the design's plane or pour
   there); a plated hole's pad whose layers no hole joins (a hole missing from the drill file).

Where a short is: on each island holding sources of two nets (pads, and the walls of holes the design
has), the copper is split among the sources by distance along it (breadth first from all at once, cells
of up to 40 µm so two never span a gap between copper), and every pair of sources of different nets
whose parts touch is a meeting. Two nets joined only through a third's copper do not meet: the third
meets each of them. The spot is the meeting itself where the two sources touch (two pads overlapping),
else the source whose net has fewer sources on that island (the shield pad in a plane). The finding
says which pad touches which net's copper on which layer; at most three spots per pair of nets.

spiral2 (110 × 150 mm, four layers, 455 pads, 348 plated holes) takes about 0.4 s. The app runs it in a
worker (`apps/web/src/lib/netcheck.worker.ts`): on every export (the flash says what it found), in the
Gerber viewer beside the files (each finding picks its layer, the holes and the outline, and rings the
spot), and for the agent in `view_gerbers` and in `<view>` (with the finding the user picked).

Files opened in the viewer are held against the IPC-D-356 netlist among them, if there is one (as the
house does), else against the board; when fewer than half the board's pads are where the files have
pads, they are another board's files (or in other coordinates) and are not held against it.

Its blind spot is the reader, shared with the viewer. `packages/fab/test/oracle.test.ts` reads the same
files with tracespace's gerber-parser and gerber-plotter (MIT, development only) and asks for the same
copper per layer (area to 0.1 %, the same number of pieces) and the same findings.

## The netlist file (`packages/fab/src/ipc356.ts`)

`fabFiles` and `panelFabFiles` put `<project>-IPC356.ipc` in the zip: IPC-D-356A, 80 fixed columns, units
of 0.0001 inch (`P  UNITS CUST 0`), every pad (327 on the surface with its side, 317 round a plated hole)
and via (317, a midpoint, tented) with its net, position in the Gerbers' frame, size, hole and mask. A
net's name of more than 14 characters, or one that only differs from another in case, goes by an alias
`N0001` spelled out by a `P  NNAME` record. A panel's netlist has each copy's nets apart (`GND_2`).
It is written from the format; `readIpc356` reads ours and other programs' files back.

The house compares it with the netlist it extracts from the Gerbers before it builds anything, so a
fault only the files have stops the order. Whether a house uses it on every order is its own business
(JLCPCB's blog recommends sending one; the electrical test of the bare boards checks them against the
Gerbers, so without it a wrong Gerber gives boards that pass).

## The stamp

Every file says which version wrote it (`%TF.GenerationSoftware,4k7,4k7,0.6.1*%`; it said 0.1 for every
version until 0.6.1), when (`%TF.CreationDate`), and from which board: `G04 spiral2, board f40fdf10*`, a
hash of what the copper is made of (`boardFingerprint`: outline, layers, pads and nets, tracks, vias,
planes), the same for the same board on every export. The drill files and the netlist carry the same
lines as comments. A build not released says `-dev` after the version.

## The faults it found, and what changed with them

- **A plane round a slotted pad of another net** (`routepours.ts`, `planeShape`) was cut as a circle of
  the pad's narrow side, so both ends of the slot stayed in the plane: spiral2's USB-C shield (GND) on
  In2.Cu's +3V3 area, since slotted pads came in (0.4.0). It is cut as the pad's capsule now, as the
  thermal reliefs already were. A design keeps its planes' shapes with its copper, so `capsuleCuts`
  mends such a cut in kept copper when the board is built: no routing again.
- **Pads of two nets that touch** (C13's ground pad 25 µm over U2's +3V3 tab) were reported only as
  courtyards overlapping and a mask web. `padShorts` (drc.ts) calls it `DRC.SHORT`, an error, from the
  placement on.
- **A plane its net never reaches** (an area under parts with none of its pins, a local pour away from
  its pads) was kept as copper joined to nothing, without a word: the router keeps the biggest island
  when none is touched. `Zone.floating` marks it and `DRC.FLOATING_PLANE` warns.

## Tests

`netcheck.test.ts`: the check on hand-written Gerbers (a short and its spot, overlapping pads, an open and
the design's own opens, layers joined only through holes, a stray hole, a slot's end in a plane, a pad
cleared, floating copper, moved parts); the files 4k7 writes for a split-plane board, a USB-C board at
0° and 90° (and its plane as 0.6.0 cut it: the short is found, and mended), a design routed before the
fix, and a panel; a pad short in the DRC. `ipc356.test.ts`: the columns of each field, the read-back,
aliases, the same check through the netlist as through the board. `oracle.test.ts`: six generated
boards (2 and 4 layers, planes, areas set twice, pours, keep-outs, cutouts, round corners, the USB-C
turned every quarter, panels), each held against its netlist, and three read by tracespace. With the
0.6.0 circle cut put back, all six fail on the shield pads.

Not done: a check that runs on every change of the board (the viewer and the export run it; the
Issues list does not have it), and making the Issues list carry the files' findings. The check knows
nothing of the mask, paste and silkscreen files.
