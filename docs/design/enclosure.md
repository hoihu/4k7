# Enclosure: the agent designs the box as a script

> Part of the [architecture](../ARCHITECTURE.md). Status: draft, 2026-10-15. Steps 1–5 of §7 built the same day; step 6 mostly on 2026-10-16; the engine changed from OpenSCAD to Manifold on 2026-10-30 (step 9).
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
- **The agent writes the box as a script**, renders it, looks at it, measures it, and writes it
  again until it is right. Code is what models write well, for boxes, posts and openings, and
  anything the user can describe the agent can try.

The user's call: **trust the agent with the script, and give it the means to judge its own work.**
That means two things the kernel still owns, as on the board: the facts the script is built on (the
board as a library, §3) and the measures it is judged by (§5). Pictures alone are not
enough: a model looking at a render sees "a box with a hole where the USB is", not a 0.4 mm
collision with a capacitor or a lid 1 mm too low.

And before any script, **the agent asks.** Whether a header is used with the box closed, how the
lid closes, what the box stands on: the board does not say. The agent drafts a brief with its
assumptions and the questions it cannot settle, the user answers it like a plan (§4), and the
script is built against the brief.

**The engine (2026-10-30).** The script was OpenSCAD at first, run by the user's own OpenSCAD through
the local server. That meant an install of a GPL program we could not ship, a server in the way of
every render, one process per check, and OpenSCAD's language as the limit of the geometry (the
reason it changed: rounded boxes, lights and lenses). Manifold is the engine OpenSCAD itself uses
for this, under Apache-2.0, and small enough to ship as WASM. So the script is now JavaScript on
Manifold in a worker of the app (§5.1, §8), and it reads like OpenSCAD with the children as
arguments, since that is what models know: `difference(a, b)`, `translate(v, c)`. Scripts in designs
saved before that are kept as text, and the render says they need rewriting; the agent can do it.

## 2. The split

| | Agent | Kernel and app |
|---|---|---|
| Owns | The brief (with the user), the script: shape, walls, openings, posts, lid, closure | The board's library (its facts), rendering, the measures, the views, the exports |
| Says it as | `set_enclosure_brief`, `set_enclosure_script` | `render_enclosure`: pictures, a report of collisions, blocked openings and loose boards |
| Checked by | The report, the pictures, the user's review of the brief and the changeset | Tests (golden boards → the library, scripts → reports) |

## 3. The board as a library

`fab/csg/board.ts` gives the script the `BoardView` as globals, in the STEP export's coordinates
(millimetres, x right and y up from the board's bottom-left corner, z up, the board's underside at
z = 0). The script never copies a number out of it. `fab/csg/api.ts` gives it the geometry:
OpenSCAD's names as functions, over Manifold's own objects, so their methods work too. The agent
reads all of it, with the values, in `get_enclosure`'s `board_api` (`enclosureApiSummary`).

```js
pcb_thickness = 1.6
pcb_size = [24, 22]                  // the outline's bounding box
pcb_outline = [[24, 22], [24, 0], [0, 0], [0, 22]]
pcb_cutouts = []
holes = [{id: "MH1", x: 3.7, y: 18.3, d: 3.2, plated: false}, …]
tallest_top = 10.135                 // highest point of any part (absolute z)
lowest_bottom = -1.365               // lowest point: through-hole leads, bottom parts (absolute z, ≤ 0)
// mating: null, or facing (where it is plugged from), origin (the face's centre), dir, u, v, size
parts_info = [
  {ref: "J1", kind: "connector", min: [2.23, 9.39, -1.365], max: [4.77, 14.47, 10.135], side: "top", approx: false, mating: {facing: "left", origin: [2.23, 11.93, 5.885], dir: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1], size: [7, 7]}}, …
]
brief_openings = ["J1"]              // from the brief
lid_clearance = 1
graphics = [{name: "logo", w: 24, h: 10}]

pcb_shape(delta = 0)                 // 2D: the outline grown by delta, with the cutouts (offset it for walls)
pcb(), part(ref), parts(), assembly()    // the board with its cutouts and mounting holes; the parts where they sit
part_box(ref, grow = 0)              // the box round a part
mating_path(ref, { length = 30, grow = 0 })    // the way a plug needs, from its face outwards
keepouts(refs = brief_openings, { grow = 0 })
hole_posts(from, { d = 6 })          // a post under each mounting hole, from z = from up to the board
label(t, { size = 5, … })            // 2D text in Liberation Sans Bold (ships with the app)
graphic(name, { width, height })     // 2D: a graphic, centred, scaled
on_face(face, at, solid)             // a solid laid on a face, reading the right way from outside
engrave(face, at, shape, depth = 0.6), emboss(face, at, shape, height = 0.6)
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

`fab/scad.ts` still writes the same board as an OpenSCAD library, `board.scad`: the Enclosure view
downloads it, for users who write their own box in OpenSCAD. A test holds the two together, in both
engines where OpenSCAD is installed.

### 3.1 Labels and logos

Port names, a product name and a logo on the box (2026-10-17). Text is the script's `text()`; the
box needs no new kind of geometry. What the agent needs is a way to get it on the right face the
right way round, and a way to get the user's logo into a script that may not read files.

- **Faces.** `on_face(face, at)` maps 2D x, y onto a face of the box: x to the reader's right, y
  up, z out. The faces are named like a connector's plugged-from (`left`, `right`, `top`,
  `bottom`, `above`, `below`), so a port's name goes on `part_info(ref)[6][0]`. `engrave` and
  `emboss` extrude along it, so the agent never writes a rotation for a label.
- **Graphics.** A script reads nothing from outside (§8). A logo is copied into the design instead
  (`design_edit set_enclosure_graphic`: a saved artwork by name, or an SVG path the agent writes for
  an icon). It is stored like a silkscreen graphic: figures in mm, filled even-odd or outlines.
  The library draws it as a shape behind `graphic(name)`; the agent reads only its name and size. The design keeps its own copy, so the box renders the same on another computer. The
  artwork library (Parts → Artwork: SVG import, pictures traced into dots) serves the board and the
  box alike, and the Enclosure view adds an artwork to the box in one click. The graphics are a
  hunk of their own; a render is out of date when they change (`enclosureKey`).
- **Two colours.** `const inlays = { lid_logo: { host: 'lid', colour: 'white' } };` names pieces that
  fill an engraving in another filament. An inlay is printed with its host: turned the same way, and in the 3MF one
  object of components, which the slicers open as one object with a part each. The 3D view draws
  it in its colour and lifts it with the host. It is not checked against its host for overlap
  (the two meet face to face), nor for thin walls or overhangs.
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

The app runs the script itself (`enclosureClient.ts`), with nothing to install and no server in the
way: a new worker per render, its own script being the enclosure script wrapped in a function
(`scriptSource`), which then loads `enclosure.worker.ts`, the engine (`fab/csg`, its own entry so only
that worker loads the WASM: 540 KB, and a Liberation Sans Bold of 354 KB, read when text is first
drawn). The page fetches both and hands them over. A render is about 50 ms for a small box, and
ends after 45 s at the latest, when the worker is stopped (§8): under the minute the server and the
MCP clients wait for a tool, so the agent hears why. In the tests the same code runs in
Node, on the real engine, so the whole path is tested in CI.

Before that, the script is read without running it (`scriptProblems`, with `acorn`): when it is set,
and again before a render. A syntax error is refused there with its line, in every browser: from a
worker that cannot parse its script, only Chromium says where. Runtime errors come back with their
line in the script, taken from the stack, whichever library call they died in; the script is not run
in strict mode for that reason, since Safari makes a strict `return difference(…)` a tail call, which
takes the piece off the stack (the parser holds it to strict syntax, and to declaring what it
assigns). Every piece's error is reported at once. `echo()` prints to the report, so the script can measure what it is not sure of.

### 5.2 The report

Each check is an intersection on the engine (`fab/csg/check.ts`), which is empty when the check passes:

| Check | Run | Fails as |
|---|---|---|
| Collision | a piece ∩ the board and its parts, per piece | `ENC.COLLIDES base with C3, U1 near (12.1, 8.4, 3.0)`: the parts whose bodies meet the result's bounding box |
| Blocked opening | the pieces ∩ `mating_path(ref)`, per part the brief opens | `ENC.BLOCKED J1's way out … is blocked: 2 × 5.1 × 8.5 mm of the box` |
| No mating face | a part the brief opens has none | `ENC.NO_MATING J1 should have an opening, but where it is plugged from is unknown` |
| Board held | the pieces against a 0.25 mm slab under each mounting hole (Ø + 3 mm), or under the whole board without holes | `ENC.LOOSE the board rests on 3 of 4 mounting holes` (an error when on none) |
| Lid over parts | the pieces against the space `lid_clearance` high over every top-side part | `ENC.LOW_LID less than 1 mm over U2, C3` |
| Pieces apart | a ∩ b for every pair, in assembled position | `ENC.PIECES_OVERLAP` (a lip with no clearance) |
| Script | a script that does not parse, stops or never ends, a piece that draws nothing or is not a solid | `ENC.SCRIPT` with the error and its line |
| Size | the assembly's bounding box against the brief's limit | `ENC.SIZE 62 × 41 × 24 mm, the limit is 60 × 40` |
| Near a part (warning) | the distance from each piece to each part that is not one of the brief's openings: under 0.2 mm (the first print can close that) | `ENC.NEAR base is only 0.1 mm from U1` |
| Overhang (warning) | each piece's triangles, turned as the script's `print` says: faces steeper than 45° that are not on the bed | `ENC.OVERHANG lid, printed turned 180, 0, 0: 120 mm² hangs over steeper than 45°` |
| Bridge (warning) | flat faces looking down: their narrow side (the box's, or 4 × area / outline) over 20 mm | `ENC.BRIDGE lid, printed as built: a ceiling 23 mm across with nothing under it` |
| Warping (warning) | each piece longer than 50 mm voxelized: every section across it as a beam, its equivalent thickness √(12 I / A); the length over the median against a limit by the brief's process (PLA/PETG 50, ABS/ASA/nylon 35, resin 30; frames 20 % lower) | `ENC.WARP lid may warp: 156 mm along y, but only as stiff as a 3.5 mm plate (slenderness 44; keep it under 24 for resin (SLA)). 35 % of its outline is open …` |
| Thin wall (warning) | from each face a 0.8 mm ray into the material; where it comes out sooner | `ENC.THIN base: walls down to 0.6 mm over 34 mm²` |

For the buck test board all of it is about 50 ms. Warping (2026-10-23, after a print service flagged a resin lid and diffuser as long, flat and frame-like)
is measured from the shape alone, not simulated; the guide (mechanics.md §5.1) gives the ways to stiffen
a piece.

### 5.3 The pictures

The app loads the STL into the 3D view with the board (`Board3DView`'s scene) and renders, for the
agent:

- two angled views (front-left-top and back-right-top),
- the box opened: the lid lifted by its height plus 10 mm,
- a section through every opening the brief asks for, cut across the wall at the part's centre
  (three.js clipping planes), which shows a plug's path, the wall's thickness and the fit,
- the base from above without the lid, which shows posts, ribs and the board on them.

`views` picks a subset; `section` cuts anywhere (`{ axis: "x", at: 21 }`). Collisions are drawn
red in the pictures, blocked paths orange, printing warnings (overhangs, bridges, thin walls) amber.

### 5.4 The loop

1. Read the board (`get_board`, `get_enclosure`) and the guide; write the brief; wait for the answers.
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
- **The cut** (2026-10-24): Cut opens the box along a plane through its middle, across its shorter
  side; x, y or z turn it. The slider, or the frame round the cut dragged in the view, moves it
  through the box; the half the camera looks from is cut away, Flip shows the other. A message
  sent while it is open tells the agent where (`<view kind="enclosure">`: the plane in board
  coordinates and the `render_enclosure section` that shows it), so "this wall" needs no
  coordinates.
- **Exports**: one 3MF plate with every piece turned for printing (the script's `print`), STL per
  piece the same way, the script as `<project>-enclosure.js`, and `board.scad` for a box of one's own.
  Manifold has meshes, not surfaces, so there is no STEP of the box; mechanical CAD imports the STL.
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
8. **The cut the user moves** (§6), instead of a fixed section per opening. *Built 2026-10-24.*
9. **Manifold instead of OpenSCAD** (§1, §5.1, §8): the script in JavaScript, in a worker of the
   app; `round_extrude` and the other rounding, `dome`, `lens`, `sdf`; `echo`, `ENC.NEAR`; the checks
   in-process and tested in CI. The server's `/api/scad` and the OpenSCAD settings are gone. *Built
   2026-10-30.*

## 8. Open questions

- **How mechanics.md reaches the agent.** Decided: `design_query get_guide topic: "mechanics"`,
  which the guide tells the agent to read before its first brief; the app ships the file as it is
  (a `?raw` import, without its header for people). The design guide keeps one paragraph on the
  workflow.
- **Trusting the script.** Decided (2026-10-30). A script may come with a design from someone else,
  or be written after reading a page that told the agent to, and it runs by itself when the
  Enclosure view opens. So it runs as a worker started from a blob of its own source. A blob's worker
  takes the page's Content-Security-Policy (checked in Chromium, WebKit and Firefox), which means no
  eval, no `new Function`, no import from anywhere but the app's own files, and no connection but
  those the page may make; that is the boundary, and the browser holds it whatever the script does.
  The page's policy gains `'wasm-unsafe-eval'` for the engine, and nothing else: it still runs no
  script it did not load itself. (That takes manifold-3d 3.5.4 or later: the bindings of earlier
  ones call `Function()`, and fail here in all three browsers.) Before the script's first line, on the same line, the worker removes
  what connects and what stores (`fetch`, `XMLHttpRequest`, `WebSocket`, `indexedDB`, `Worker` …), so
  the connections the policy allows are closed too, and its address is a blob's, without the
  access key. The engine and the font come from the page. The static checks (`scriptProblems`) only
  say early what would not work, and are not part of the boundary. What is left: a script can burn a
  minute of a core and the worker's memory, and then it is stopped; and it can lie about its own
  report, since it runs in the same worker as the checks. What comes back is read as data and goes
  to the view and the agent as text and triangles, and the agent reads the script anyway.
- **Images per turn.** Five or six pictures per render, up to eight renders: about 40 images in a
  long turn. Sections only for openings that changed may be enough after the first render.
