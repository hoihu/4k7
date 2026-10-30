# Fabrication panels: tabs and mouse bites

> Part of the [architecture](../ARCHITECTURE.md). Status: implemented (2026-10-11): model, geometry, checks, panel export, agent op, the Panel view with tab editing.

Small boards are made and assembled in **panels**: copies of the board in a grid inside a
frame, milled apart except at **tabs**. The tabs are perforated with a row of small non-plated
holes (**mouse bites**) so the boards snap out after assembly.

The board stays what you design. The panel is how it is made, stored next to it
(`board.panel`) and resolved with the board view (`BoardView.panel`).

```
 ┌──────────────────────────────────────────┐  frame (rails), 5 mm
 │  ○ tooling   ● fiducial                  │
 │   ┌──────────┐ ░ ┌──────────┐            │  ░ milled channel (the gap, 2 mm)
 │   │          │═╪═│          │            │  ═╪═ tab with a row of holes at
 │   │  board   │ ░ │  board   │            │      each board edge it touches
 │   └────╥─────┘ ░ └────╥─────┘            │
```

## Model

`packages/schema/src/panel.ts`.

| Field | Default | |
|---|---|---|
| `cols`, `rows` | 2 × 2 | copies, row by row from the top left |
| `gap` | 2 mm | milled channel between the boards and to the frame: the router width |
| `rails` | 5 mm on every side | frame width per side; 0 = no frame, the boards reach the panel edge there |
| `tabs` | on every side | `{ side, at }`: a side of the board's bounding box, and a fraction along it |
| `tab.width` | 5 mm | along the edge |
| `tab.hole`, `tab.pitch` | Ø0.5 mm, ≤ 0.75 mm | mouse-bite holes; the pitch is a maximum, so a row ends exactly at the tab's edges |
| `tab.inset` | 0.25 mm | hole centres inside the edge, so the break stays within the outline |
| `tab.frameSide` | on | a row on the frame's end of a tab too, so the whole tab breaks out |
| `fiducials`, `toolingHoles` | on | three 1 mm fiducials (2 mm mask opening), placed asymmetrically, and four Ø2 mm tooling holes, centred 3.85 mm from the panel edge on the top and bottom rails (else on the left and right) |

A tab sits where its side of the bounding box first meets the real outline, so the same
definition fits rectangles, rounded corners and free-form outlines, and follows the board when
it is resized. `set_panel tab_sides` spreads tabs over the chosen sides: one on a side up to
30 mm, then one per 50 mm, at least two. Sides without tabs are milled through.

## Geometry

`packages/kernel/src/panel.ts`, with [Clipper2](https://www.angusj.com/clipper2/) (`clipper2-ts`)
for offsetting and polygon booleans:

1. The copies at their offsets, inside a sheet the size of the panel.
2. **Milled** = every copy's outline grown by the gap (round joins: the router's path) minus the
   copies, minus the tabs.
3. **Material** = sheet − milled. Its contours are the panel's `Edge_Cuts`.

One rule covers every board shape. Between rectangles the channels merge into one slot.
Free-form boards are cut out of the sheet, and what is left between them stays as web (pieces
that come loose are scrap).

A tab runs from the board edge outward until it reaches material, either the frame or a
neighbouring board. A tab that joins two copies is shared: the neighbour's facing tab is the same
tab, and it gets a row of holes at both board edges. A tab to the frame gets a row at the board
edge and, unless `frameSide` is off, one just inside the frame, so the whole tab breaks out and
nothing stays stuck to the frame (the common pattern; the board's edge is clean either way). A row
of holes follows the outline, one hole per line across the tab.

## Checks

| Code | |
|---|---|
| `PANEL.TAB` | a tab runs off the board (its side is shorter or curved away there), reaches no material, or overlaps another tab on its side |
| `PANEL.TABS` | a board held by fewer than two tabs |
| `PANEL.LOOSE` | the panel falls apart: the boards and the frame are not all joined by tabs |
| `PANEL.MARKS` | mouse bites run into a fiducial or tooling hole on the rail (warning) |
| `PANEL.RAILS` | fiducials or tooling holes asked for, but no 5 mm rails on two opposite sides (warning) |
| `PANEL.SIZE` | the panel is larger than the fab profile's largest board |
| `PANEL.HOLE` | mouse-bite holes smaller than the profile's smallest non-plated hole |
| `PANEL.TAB_ZONE` | parts, pads, tracks or vias within 1.5 mm of a tab (warning, one per tab) |
| `PANEL.TAB_OVERHANG` | a part reaches over a board edge that has a tab |

A tab facing a panel edge that has no rail is left out, as intended, and not reported.

**The tab zone** (`panelTabDrc`, panel.ts; 2026-10-29) is JLCPCB's 1.5 mm between a tab's edge and the
nearest part or pad: the board flexes there when it is snapped out and ceramic capacitors crack.
A part is its body and its pads. The tab is its rectangle on the side of the board's bounding box,
so on a free-form outline that starts deeper the check is on the generous side of the truth. Tracks and
vias count once the board is routed (or drawn); pours do not (they run to the edge clearance
everywhere). A part over an edge that has a tab is an error: it would stand in the milled channel or on the
tab. Edges without a tab are the edge clearance's business.

## Output

`panelFabFiles` (`packages/fab/src/panel.ts`) moves every copy into place as one board view the
size of the panel and writes the same set as for one board, named `<project>-panel-…`:

- Copper, mask, paste and silkscreen for every copy; the fiducials on both outer copper layers
  with their mask openings.
- `Edge_Cuts`: the panel's contours and each copy's cutouts.
- `NPTH.drl`: the mouse bites, the tooling holes and the copies' own non-plated holes.
- BOM and pick-and-place: **one entry per placement on the panel**. Designators get the copy's
  number (`R1_1` … `R1_4`), so the BOM counts the whole panel.

The Layout view's side panel has a **Panel files ⤓** button beside **Fab files ⤓** (under Files)
once a panel is set.

## The Panel view

**Panel** beside 2D and 3D in the Layout view (`PanelCanvas.svelte`) shows:
- the material, with the milled channels hatched;
- every copy (pours, tracks, pads, part outlines);
- the tabs with their mouse bites, the fiducials and the tooling holes.

Tabs are edited there. The same tabs apply to every copy:
- **Hover** just outside a board edge to see where a tab would go; **click** to add it.
- **Drag** a tab along its side. It stops short of the next tab on that side.
- **Click** a tab to remove it. A tab shared by two boards is a side's tab and the facing side's
  (`PanelView.tabs[].src`), so both are moved or removed together.

The side panel (`PanelSetup.svelte`) holds:
- copies, gap and rails (all sides, or per side);
- the sides with tabs (toggling one keeps the others' tabs as they are), tabs per side, and tab
  width;
- hole size and pitch, fiducials and tooling holes;
- **Panel files ⤓** and **Remove panel**.

Without a panel there is a **Make a 2 × 2 panel** button.

## The manufacturers (read 2026-10-11)

**JLCPCB** ([capabilities](https://jlcpcb.com/capabilities/pcb-capabilities),
[mouse-bite guide](https://jlcpcb.com/blog/pcb-mouse-bites)) takes panels made by the customer,
with mouse bites:

- Board spacing 1.6 or 2 mm.
- Recommended mouse-bite holes 0.5–0.8 mm, 0.2–0.3 mm apart. The guide says 0.5–0.6 mm at
  0.7–0.8 mm centre to centre.
- Tabs at least 5 mm wide with mouse bites (4 mm without).
- Copper at least 0.2 mm from edges without mouse bites.
- For SMT assembly at JLCPCB: 5 mm tooling edges, 2 mm tooling holes, 1 mm fiducials centred
  3.85 mm from the panel edges.
- The guide also asks for 1.5 mm between a tab edge and the nearest part or pad.

The defaults are these numbers. With 0.75 mm pitch, a 5 mm tab gets 8 holes (0.71 mm apart,
leaving 0.21 mm of material between holes).

**Eurocircuits** ([customer panel basics](https://www.eurocircuits.com/technical-guidelines/panel-guidelines/customer-panel-basics/),
[customer panel](https://www.eurocircuits.com/panel-guidelines/customer-panel-by-eurocircuits/)):

- Break routing with a 2 mm tool; at least 2 mm between boards.
- A panel border of at least 5 mm, plus the 2 mm for routing, so at least 7 mm from a board to the
  panel edge.
- Panels from 50 × 50 to 420 × 580 mm (36 × 46 to 326 × 426 mm for assembly). The defaults meet
  all of this.
- Their engineers place the tabs, drilled to break inside the board profile. They publish no hole
  size or pitch.
- The usual order is single-board Gerbers plus a panel drawing, built by them ("Customer panel by
  Eurocircuits"). A "Customer panel by customer" option exists in their configurator.

So for Eurocircuits the panel export is a drawing of intent, and they may redo the tabs. The agent
guide says so.

**Not in the fab profile yet**: panel limits (board spacing, rail width, smallest and largest
panel, hole size) are in the presets' notes and this page, not in `FabLimits`. Only the largest
board and the smallest non-plated hole are checked against the profile.

## Not yet

- V-scoring (straight cuts, rectangular boards), mixed panels, copies turned by 180°.
- Panel limits as fields of the fab profile.
