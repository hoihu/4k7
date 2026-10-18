# Enclosure: the agent designs the box in OpenSCAD

> Part of the [architecture](../ARCHITECTURE.md). Status: draft, 2026-10-15. Steps 1–5 of §7 built the same day; step 6 mostly on 2026-10-16.
> The agent's mechanical guide is [mechanics.md](mechanics.md); the board side is [layout.md](layout.md).

## 1. Why

A finished board still has to go into something. Today the path ends at the fab zip and the STEP
model (`fab/step.ts`): the user takes the STEP into a mechanical CAD and draws the box by hand. For
the boards 4k7 is made for (small, one or two connectors, a button, an LED) that box is routine
work, and it is work the agent can do: it knows every part, where it sits and how tall it is.

Two ways were weighed (2026-10-15):

- **A box the kernel builds from parameters** (`set_enclosure wall_mm …`, CSG in TypeScript with
  manifold-3d), checked like the board. Deterministic, but every new feature (a snap hook, a
  light pipe, a DIN clip) is code in 4k7, and boxes vary far more than boards do.
- **The agent writes the box as an OpenSCAD script**, renders it, looks at it, measures it, and
  writes it again until it is right. OpenSCAD is code, models write it well for boxes, posts and
  openings, and anything the user can describe the agent can try.

The user's call: **trust the agent with the script, and give it the means to judge its own work.**
That means two things the kernel still owns, as on the board: the facts the script is built on (the
board as an OpenSCAD library, §3) and the measures it is judged by (§5). Pictures alone are not
enough: a model looking at a render sees "a box with a hole where the USB is", not a 0.4 mm
collision with a capacitor or a lid 1 mm too low.

And before any script, **the agent asks.** Whether a header is used with the box closed, how the
lid closes, what the box stands on: the board does not say. The agent drafts a brief with its
assumptions and the questions it cannot settle, the user answers it like a plan (§4), and the
script is built against the brief.

## 2. The split

| | Agent | Kernel and app |
|---|---|---|
| Owns | The brief (with the user), the script: shape, walls, openings, posts, lid, closure | `board.scad` (the board's facts), rendering, the measures, the views, the exports |
| Says it as | `set_enclosure_brief`, `set_enclosure_script` | `render_enclosure`: pictures, a report of collisions, blocked openings and loose boards |
| Checked by | The report, the pictures, the user's review of the brief and the changeset | Tests (golden boards → `board.scad`, scripts → reports) |

## 3. The board as an OpenSCAD library

`fab/scad.ts` writes `board.scad` from the `BoardView`, in the STEP export's coordinates
(millimetres, x right and y up from the board's bottom-left corner, z up, the board's underside at
z = 0). The agent's script starts with `include <board.scad>` and never copies a number out of it.

```scad
// board.scad: <project> as an OpenSCAD library, written by 4k7. Do not edit: it is written again from the board.
pcb_thickness = 1.6;
pcb_size = [24, 22];                 // the outline's bounding box
pcb_outline = [[24, 22], [24, 0], [0, 0], [0, 22]];
pcb_cutouts = [];
holes = [["MH1", 3.7, 18.3, 3.2, false], …];     // id, x, y, diameter, plated
tallest_top = 10.135;                // highest point of any part (absolute z)
lowest_bottom = -1.365;              // lowest point: through-hole leads, bottom parts (absolute z, ≤ 0)
// [ref, kind, min, max, side, approx, mating]; mating: [plugged from, face centre, direction out,
//  across u, across v, [size along u, size along v]], or [] when it is not plugged
parts_info = [
  ["J1", "connector", [2.23, 9.39, -1.365], [4.77, 14.47, 10.135], "top", false, ["left", [2.23, 11.93, 5.885], [-1, 0, 0], [0, -1, 0], [0, 0, 1], [7, 7]]], …
];
brief_openings = ["J1"];             // from the brief
lid_clearance = 1;

module pcb_shape(delta = 0);         // 2D: the outline grown by delta, with the cutouts (offset it for walls)
module pcb();                        // the board with its cutouts and mounting holes
module part(ref); module parts(); module assembly();
module part_box(ref, grow = 0);      // the box round a part
module mating_path(ref, length = 30, grow = 0);  // the way a plug needs, from its face outwards
module keepouts(refs = brief_openings, grow = 0);
module hole_posts(from, d = 6);      // a post under each mounting hole, from z = from up to the board
graphics = [["logo", [24, 10]]];    // the design's graphics for the box (§3.1)
module label(t, size = 5, …);        // 2D text in Liberation Sans Bold (comes with OpenSCAD)
module graphic(name, width = 0, height = 0);  // 2D: a graphic, centred, scaled
module on_face(face, at);            // 2D children laid on a face, reading the right way from outside
module engrave(face, at, depth = 0.6); module emboss(face, at, height = 0.6);
```

A part's solids are its body (boxes, cylinders) plus one box round its leads above the board and
one round those below; parts without a 3D body (`body3dFor` fails) are their footprint's body
outline at the package height, marked `approx`. The agent reads all of it except the solids
(`design_query get_enclosure`, `boardScadSummary`).

**Where connectors face** was the one fact the board did not have. `PackageInfo.mating` gives the
footprint face a plug comes in through (`left`, `right`, `top`, `bottom` of the drawing, or `up`:
from above), the plug's size across its way in (the overmold of a cable plug), its height and its
offset along the face. Pin headers are plugged from above by default; everything else needs it from
the datasheet: `set_mating`, `set_footprint mating`, or the datasheet import. `get_board` says where
each part is plugged from on the board (`plugged_from`), turned with the part and mirrored on the
bottom (`boardFacing`).

`board.scad` is useful alone: the Enclosure view downloads it, for users who write their own box.

### 3.1 Labels and logos

Port names, a product name and a logo on the box (2026-10-17). Text is OpenSCAD's `text()`; the
box needs no new kind of geometry. What the agent needs is a way to get it on the right face the
right way round, and a way to get the user's logo into a script that may not read files.

- **Faces.** `on_face(face, at)` maps 2D x, y onto a face of the box: x to the reader's right, y
  up, z out. The faces are named like a connector's plugged-from (`left`, `right`, `top`,
  `bottom`, `above`, `below`), so a port's name goes on `part_info(ref)[6][0]`. `engrave` and
  `emboss` extrude along it, so the agent never writes a rotation for a label.
- **Graphics.** `import()` stays forbidden (§8). A logo is copied into the design instead
  (`design_edit set_enclosure_graphic`: a saved artwork by name, or an SVG path the agent writes for
  an icon). It is stored like a silkscreen graphic: figures in mm, filled even-odd or outlines.
  `board.scad` writes it out as a polygon behind `graphic(name)`; the agent reads only its name and
  size. The design keeps its own copy, so the box renders the same on another computer. The
  artwork library (Parts → Artwork: SVG import, pictures traced into dots) serves the board and the
  box alike, and the Enclosure view adds an artwork to the box in one click. The graphics are a
  hunk of their own; a render is out of date when they change (`enclosureKey`).
- **Two colours.** `inlays = [["lid_logo", "lid", "white"]];` names pieces that fill an engraving
  in another filament. An inlay is printed with its host: turned the same way, and in the 3MF one
  object of components, which the slicers open as one object with a part each. The 3D view draws
  it in its colour and lifts it with the host. It is not checked against its host for overlap
  (the two meet face to face, and OpenSCAD can leave a zero-volume sliver there), nor for thin walls
  or overhangs.
- **Checks.** ENC.THIN already finds strokes and ridges too fine to print. `render_enclosure faces`
  takes pictures of chosen faces, tilted about 20° so an engraving shows (straight on, its floor
  shades like the face). The guide (mechanics.md §6) gives sizes, depths and where labels go.

## 4. The brief

Like a plan before programming: the agent reads the board and [mechanics.md](mechanics.md), and
writes down what the box must do before it draws anything. `design_edit set_enclosure_brief`
stores it in the design (`Design.enclosure.brief`):

- **Process and material**: FDM print (default) or resin; PLA, PETG, ASA.
- **Pieces and closure**: base and lid (default), screws (with heat-set inserts or self-tapping),
  snap fit, slide-in lid, friction lid.
- **How the board is held**: screws through its mounting holes onto posts (default when it has
  holes), clamped between posts and lid ribs, slots, clips over the edge.
- **Each part that matters**, with what it needs: `J1 USB-C: opening in the left wall for the
  plug`, `J3 programming header: inside, no opening`, `SW1: a plunger through the lid`,
  `D1: a 2 mm hole over it`.
- **Cables, mounting, environment, size limit, looks**: wires out through a slot with strain relief,
  rubber feet or wall keyholes or a DIN clip, indoor and dry, at most 60 × 40 × 25 mm, 2 mm corner
  radius, a label on the lid.

Every item is either **decided** (from the request, the board, or a sensible default; the reason
is kept) or a **question**: 2–4 options, the agent's pick first. The user sees the brief as a card
(a form: every question at once, the defaults preselected, free text for "other"), changes what
they like and presses **Build it**, which sends the answers as the next message. That works the
same for every engine: the in-app agent, Claude Code in the chat, and Claude Code from a terminal
(where `get_context` shows the brief waiting). `ask_user` (one question, ends the turn) stays for
single questions; the brief is for the many a box raises at once.

The brief stays in the design. A later change to the board (a new connector) makes the agent add
the new part to the brief, and ask if it must; "make the lid snap on" edits the brief and then the
script.

## 5. Render, look, measure, rewrite

`set_enclosure_script` stores the script (`Design.enclosure.script`, text, its pieces named by a
`piece` variable: `piece = "base"` renders the base). `render_enclosure` renders it and answers with
pictures and a report.

### 5.1 Rendering

The local server runs the user's OpenSCAD (2025 or later, `--backend=manifold`: seconds for a
box), found like the coding agents (PATH, the usual app locations, a path in Settings, "Look
again"). The GPL program is never shipped with the app. Without OpenSCAD the enclosure step says
so and links the download.

The server writes `board.scad` and the script into a scratch directory per project, runs one
OpenSCAD per piece and per check (in parallel), and returns STL and the `--summary-file` JSON
(bounding box, warnings, errors with line numbers). A script error comes back as the error and
its line, without pictures.

### 5.2 The report

Each check is one OpenSCAD run of an intersection, which is empty when the check passes:

| Check | Run | Fails as |
|---|---|---|
| Collision | `intersection() { piece(); parts(); }` per piece | `ENC.COLLIDES base with C3, U1 near (12.1, 8.4, 3.0)`: the parts whose bodies meet the result's bounding box |
| Blocked opening | `intersection() { pieces(); mating_path(ref); }` per part the brief opens | `ENC.BLOCKED J1: the wall covers 2.1 mm of the plug's path` |
| No mating face | a part the brief opens has none | `ENC.NO_MATING J1 should have an opening, but where it is plugged from is unknown` |
| Board held | the pieces against a 0.25 mm slab under each mounting hole (Ø + 3 mm), or under the whole board without holes | `ENC.LOOSE the board rests on 3 of 4 mounting holes` (an error when on none) |
| Lid over parts | the pieces against the space `lid_clearance` high over every top-side part | `ENC.LOW_LID less than 1 mm over U2, C3` |
| Pieces apart | `intersection() { a(); b(); }` for every pair, in assembled position | `ENC.PIECES_OVERLAP` (a lip with no clearance) |
| Script | a run that fails, a piece that draws nothing | `ENC.SCRIPT` with OpenSCAD's errors and line numbers |
| Size | the assembly's bounding box against the brief's limit | `ENC.SIZE 62 × 41 × 24 mm, the limit is 60 × 40` |
| Overhang (warning) | each piece's triangles, turned as the script's `print` says: faces steeper than 45° that are not on the bed | `ENC.OVERHANG lid, printed turned 180, 0, 0: 120 mm² hangs over steeper than 45°` |
| Bridge (warning) | flat faces looking down: their narrow side (the box's, or 4 × area / outline) over 20 mm | `ENC.BRIDGE lid, printed as built: a ceiling 23 mm across with nothing under it` |
| Thin wall (warning) | from each face a 0.8 mm ray into the material; where it comes out sooner | `ENC.THIN base: walls down to 0.6 mm over 34 mm²` |

For the buck test board a job is 11 runs, about 0.6 s of OpenSCAD in all (a few at a time). Wall thickness and overhangs are not measured yet (§8); the guide gives the rules and the
pictures show the worst of it.

### 5.3 The pictures

The app loads the STL into the 3D view with the board (`Board3DView`'s scene) and renders, for the
agent:

- two angled views (front-left-top and back-right-top),
- the box opened: the lid lifted by its height plus 10 mm,
- a section through every opening the brief asks for, cut across the wall at the part's centre
  (three.js clipping planes), which shows a plug's path, the wall's thickness and the fit,
- the base from above without the lid, which shows posts, ribs and the board on them.

`views` picks a subset; `section` cuts anywhere (`{ axis: "x", at: 21 }`). Collisions are drawn
red in the pictures, blocked paths orange.

### 5.4 The loop

1. Read the board (`get_board`, `board.scad`) and the guide; write the brief; wait for the answers.
2. Write the script, `render_enclosure`.
3. Fix what the report says first (it is exact), then what the pictures show.
4. Again, until the report is clean and every brief item is seen in a picture. At most 8 renders
   per turn; after that, propose what there is and say what is left.
5. `propose`. Like `open_connections` on the board, `propose` refuses an enclosure with report
   findings unless the agent says why (`enclosure_findings`). The user reviews the changeset with
   the 3D view of the box.

## 6. The user's side

- **Enclosure view** (after Layout): the 3D view with the box, the pieces toggled and exploded, the
  brief, the report, the script in an editor. The user can edit the script; the edit is a changeset
  like any other and the agent sees the diff.
- **Exports**: one 3MF plate with every piece turned for printing (the script's `print`), STL per
  piece the same way, `<project>-enclosure.scad` with `board.scad` inlined, and `board.scad`.
  OpenSCAD cannot write STEP; mechanical CAD imports the STL or the .scad.
- **Notes**: Settings → Enclosure notes, like the layout notes: "I print PETG on a 0.4 mm nozzle,
  M3 heat-set inserts, 0.25 mm clearance fits me". Sent as `<enclosure_notes>`; they win over the
  guide's defaults.

## 7. Build order

Each step is useful alone.

1. **Mating faces.** `mating` on packages, `set_mating`, `set_footprint mating`, the datasheet
   import, `plugged_from` in `get_board`. *Built 2026-10-15.*
2. **`board.scad`** (`fab/scad.ts`). *Built 2026-10-15*, tested against the real OpenSCAD where it
   is installed.
3. **The renderer**: `tools/server/src/scad.ts` (FOURK7_OPENSCAD_BIN, the path set in the app, the
   PATH, the usual places), `/api/scad`, the job and the report (`fab/enclosure.ts`),
   `render_enclosure`, the propose rule. *Built 2026-10-15*, tested with a stand-in OpenSCAD and
   the real one.
4. **The brief**: `set_enclosure_brief`, its questions answered in the Enclosure view,
   `get_guide mechanics`, the guide's workflow. *Built 2026-10-15.*
5. **The pictures and the Enclosure view** (§5.3, §6), the script stored and editable, the
   exports. *Built 2026-10-15.*
6. **Follow-ups** (2026-10-16): the board hidden in the Enclosure view (PCB), enclosure notes,
   print orientation in the script and a 3MF plate, plug paths in the Layout's 3D view, overhang,
   bridge and thin-wall warnings. *Built.*
7. **Labels and logos** (§3.1): `label`, `graphic`, `on_face`, `engrave`, `emboss` in
   `board.scad`, `set_enclosure_graphic`, inlays in the print files, face pictures. *Built
   2026-10-17.*

## 8. Open questions

- **How mechanics.md reaches the agent.** Decided: `design_query get_guide topic: "mechanics"`,
  which the guide tells the agent to read before its first brief; the app ships the file as it is
  (a `?raw` import, without its header for people). The design guide keeps one paragraph on the
  workflow.
- **Trusting the script.** OpenSCAD scripts can `import()` files and `include` others; the server
  runs them in the scratch directory with only `board.scad` next to them, and refuses paths that
  leave it. Rendering time is capped (60 s per run).
- **Images per turn.** Five or six pictures per render, up to eight renders: about 40 images in a
  long turn. Sections only for openings that changed may be enough after the first render.
