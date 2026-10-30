# Mechanics: a guide for the agent designing an enclosure

> Part of [enclosure.md](enclosure.md). Status: draft, 2026-10-15. Written to the agent: this text is
> what it reads (`get_guide mechanics`) before it writes a brief or a script. The user's enclosure
> notes win over it.

Numbers below are typical starting values for an FDM printer with a 0.4 mm nozzle. A datasheet, the
user's notes or the user's answer always win. When a number matters and you are guessing, say so
in the brief.

## 1. Before you draw: the brief

Read the board first: `get_board`, `get_enclosure`'s `board_api` (`parts_info`, `holes`,
`tallest_top`, `lowest_bottom`), and the datasheets of the connectors. Then write the brief. Decide what the
request, the board or a sensible default settles, with the reason. Ask what only the user knows.

**Always ask** (unless the request or the notes already say it):

- Which connectors are used **with the box closed**. A programming header, a debug UART or a
  battery JST is usually inside. A USB-C on the edge is usually outside. Ask about anything you
  cannot tell.
- How the box **closes**: screws (the sturdy default), snap fit (no tools, a few openings only),
  a slide-in lid, a friction lid.
- What the box **stands on or hangs from**: a desk (rubber feet), a wall (keyholes or tabs), a
  DIN rail, in the hand, inside another device.
- **Size limits**, if the box has to fit somewhere.
- **Who prints it**: the user's own printer (and which material) or a service (JLC3DP, PCBWay and
  others: SLA resin, MJF or SLS nylon, FDM). A service decides the orientation and the supports, and
  checks the files for warping and for names and logos (§5.1, §6.1).

**Ask when it applies**:

- Buttons: a plunger through the lid, a flexure button in the lid, or the switch reaching through
  a hole. Ask which way the user wants to press it.
- LEDs: a hole, a light pipe, or shining through a thin lid.
- Displays: a window, and whether the display may touch the lid.
- Cables that leave as wires (terminal blocks, soldered leads): through a slot, a gland or a
  grommet, and whether they need strain relief.
- Batteries: which cell or pack, and whether the user needs to reach it without tools.
- Heat (a linear regulator dropping volts, a power stage), outdoor use, water, dust.
- Fasteners and process when the notes do not say: M2.5 or M3, heat-set inserts or self-tapping
  screws, the material (PLA indoors, PETG for warm or sturdier, ASA outdoors).
- Labels and a logo, when the user wants them or the box has several ports that look alike: which
  ports to name and with what words, a logo (from their artwork, §6) and where it goes, engraved or
  in a second colour (an inlay needs a multi-material printer or a filament change).

**Decide yourself** (say so, do not ask): wall thickness, clearances, post sizes, the split
between base and lid (the lid on top, the board in the base), print orientation, corner radius
(2 mm), and openings for connectors that are obviously used from outside.

Ask everything in one brief, with your pick first in each question. Do not ask one question at a
time.

## 2. Connectors and what they need

The plug is bigger than the receptacle. An opening is sized for the **plug's overmold** (the
plastic body of the cable end) plus clearance, not for the metal receptacle. The plug's metal shell
must reach its full depth. Keep the receptacle's front face within about 1 mm of the wall's
outside face, or recess the wall around the opening so the overmold sits in a pocket.

| Part | Faces | Usually | What the box needs |
|---|---|---|---|
| USB-C receptacle | edge | outside | An opening for the overmold, typically around 12–13 × 6.5–7 mm with rounded ends. Overmolds vary: ask if the user has a particular cable. Support the board right behind it (§4). |
| Micro-USB, USB-A | edge | outside | The same, sized for that plug's overmold. |
| Barrel jack (5.5/2.1, 5.5/2.5) | edge | outside | A round opening for the plug, typically 8–10 mm across the strain relief. A panel-mount jack with a nut instead is a different part. |
| RJ45 | edge | outside | The jack's front plus clearance, and room to press the plug's latch. The jack's LEDs show through the opening. |
| 3.5 mm audio jack | edge | outside | A round hole for the plug's body, typically 6–8 mm. |
| SMA, u.FL | edge or top | outside / inside | An edge SMA needs a hole and room for a wrench. Bulkhead SMAs are panel-mount and fixed with their nut. u.FL is inside, with a pigtail to a panel connector. |
| Screw terminal block | wire side and top | outside | A slot for the wires on the wire side, and the screws reachable: either an opening in the lid over them or "open the lid to wire it". Ask. Strain relief for the wires. |
| Pin header, IDC | top | inside | Nothing, unless used with the box closed. Then a slot for the mating housing, not the pins. |
| JST PH/XH, other wire-to-board | top or side | inside | Nothing, but room for the housing and the wires' bend radius inside the box (≥ 5 mm over the housing). |
| microSD / SD slot | edge | outside | A slot for the card plus a finger notch below it, so the card can be pushed and pulled. |
| Tactile switch (6 × 6, 12 × 12) | top | outside | A plunger over the actuator (§3), or a hole when the actuator reaches above the lid. |
| Slide / toggle switch | edge or top | outside | A slot for the actuator plus its full travel and 0.5 mm. |
| Potentiometer, encoder | top or edge | outside | A hole for the shaft or bushing, an anti-rotation tab if it has one, room for the knob outside. |
| LED | top | outside | A hole over it (2–3 mm), a light pipe, or a lid ≤ 1 mm thick in white or clear plastic over it. |
| Display | top | outside | A window the size of the active area, a bezel over the edges, and the display held from behind, not pressed by the lid. |
| PCB antenna (ESP32 module, chip antenna) | – | inside | No metal near it: no screws, inserts or metal box within ~10 mm. Keep the plastic a few mm away from the antenna area. |
| Buzzer, speaker, microphone | top | inside | Sound holes over it; a microphone sealed to its hole with a gasket. |
| Sensors (temperature, humidity, light, gas) | top | inside | A vent or window next to it, and away from warm parts. |
| Battery holder, cells | – | inside | Its volume and its wires; an access door when the user changes it. |

When a connector's face in `parts_info` looks wrong (a USB-C facing into the board), say so before
you build around it. The user can fix the footprint's `mating`.

**Board-mount or panel-mount.** A board-mount connector takes the plug's force through its solder
joints into the board. A panel-mount connector (nut, flange, screws) takes it into the wall and is
wired to the board. For connectors that are plugged often, or with heavy cables, suggest
panel-mount in the brief. For board-mount, support the board (§4).

## 3. Buttons, lights, windows

- **Plunger**: a separate pin through a hole in the lid, with a flange inside so it cannot fall
  out. Leave 0.3 mm clearance round it, its bottom 0.2 mm above the actuator, and its top 1–2 mm
  above the lid. It prints standing up.
- **Flexure button**: a tongue cut into the lid (a U-shaped slot about 1 mm wide) with a nub under
  it over the actuator. It needs PETG or another tough material. PLA tongues crack after a while.
- **Light**: a hole lets light out but also dust in. A thin wall (two layers of white PLA, about
  0.4–0.6 mm) glows over a bright LED. A light pipe (clear, separate) carries the light to the
  surface.
- **Window**: an opening and a separate clear part, or a pocket for a cut acrylic sheet glued in.
- **Lens**: a bought lens gives a beam you can count on, and a printed one does not: FDM prints
  are cloudy and ribbed, and even clear resin wants sanding and a coat of lacquer. So a controlled
  beam means a bought part, with a seat in the box for it (a pocket 0.1–0.2 mm over its diameter
  and a lip to hold it). Print a dome or lens to spread and soften light, say so in the brief, and
  say which process: clear resin, or clear PETG with thick walls and slow printing.
  `dome(d, h)` and `lens(d, { r, r2, edge })` make the shapes; a sphere's sag over the diameter d is
  r − √(r² − d²/4), and an LED under a surface of radius r in clear plastic is near focus at about
  2–3 r. A small lens is a piece of its own, printed on its flat side.
- **Light pipe**: a clear piece of its own, 3–5 mm across, from 0.2–0.5 mm over the LED's top
  (`part_info(ref).max[2]`) up through the lid, in a hole 0.2 mm wider, with a collar under the lid
  so it cannot fall out. Straight is best; a bend under ~3 × its diameter loses most of the light.
- **Diffuser**: a thin plate or a dome of white or clear plastic over the LEDs, at least the LEDs'
  spacing away from them so they blend into one glow. It is thin on purpose (§5.1).

## 4. Holding the board

The board must not move when a plug goes in or a button is pressed.

- **Screws through its mounting holes onto posts** (the default when it has holes). Use
  `holes` (or `hole_posts`). The post's top is at z = 0 (the board's underside). Its diameter is
  about twice the hole, and at least the hole plus 2.5 mm. Its height is at least
  −`lowest_bottom` + 1 mm, so THT leads and bottom parts clear the floor.
  - Self-tapping into plastic: a pilot hole ~0.3–0.5 mm under the screw's thread diameter
    (M3: ~2.5–2.7 mm, M2.5: ~2.1 mm).
  - Heat-set insert: the insert maker's hole diameter, a post wall ≥ 1.5 mm round it.
- **Clamped**: posts under the board and ribs on the lid over the same spots, with 0.1–0.2 mm
  clearance so the lid presses it lightly. Good for boards without holes.
- **Slots / rails**: the board slides into grooves in two opposite walls, 0.3–0.4 mm wider than
  the board is thick (1.6 mm boards vary ±10 %) and 1–1.5 mm deep.
- **Clips**: cantilever hooks that snap over the board's edge. Use them where parts keep ≥ 1.5 mm
  from the edge.
- **Locating pins**: a post through a hole, 0.1–0.2 mm under the hole's diameter, held down by the
  lid. Do not rely on a press fit (interference) to hold a board. Printed interference fits are
  unpredictable and crack.

**Support behind connectors.** Put a post, rib or the clamp within ~10 mm of every board-mount
connector that is plugged from outside, under the board, so plugging does not bend it. The opening
round the plug must not touch the receptacle's shell: keep 0.2–0.3 mm round it.

## 5. Fits, walls and printing

| | Typical |
|---|---|
| Wall | 1.6–2.4 mm (4–6 perimeters); 2 mm by default |
| Floor and lid | 1.6–2 mm; thinner only where light should pass |
| Board to inner wall | 0.5 mm all round (board outlines are ±0.1–0.2 mm) |
| Lid's inside over the tallest part | ≥ 1 mm over `tallest_top`; more under a display or a cable bend |
| Parts that slide or must go together (lid lip, plunger) | 0.2–0.3 mm per side |
| Friction lid lip | 0–0.1 mm per side: tell the user it may need sanding or a test print |
| Holes printed vertically | ~0.2 mm under size; add 0.2 mm, or drill them out |
| Holes printed horizontally (in a wall) | the top bridges; above ~8 mm use a teardrop or flat-topped shape |
| Overhangs | ≤ 45° from vertical without supports |
| Bridges | ≤ ~20 mm (the top edge of a wall opening is a bridge) |
| First-layer edge | chamfer 0.4–0.5 mm so the slight squash ("elephant's foot") does not show |
| Snap-fit hook | PETG/ABS/ASA rather than PLA, the arm ≥ 5× as long as the hook is deep, printed along its length |

### 5.1 Stiffness and warping

Long, flat or frame-like pieces bow and twist as they cool (FDM) or cure (resin) and sinter (MJF,
SLS). Thin edges and large openings shrink towards the middle and pull the piece out of flat along
its diagonals. A box with a floor and walls is stiff; a lid, a plate, a diffuser, a frame round a
window or a long bar is not. Design every piece longer than about 50 mm against it:

- **Stiffen, do not just thicken.** A plate's stiffness grows with the cube of its depth, so a rib
  or a rim adds far more than the same plastic spread over the plate. Ribs on the inside: 2–3 × the
  plate high, 0.6–0.8 × its thickness (thicker ribs leave sink marks on the outside face), at most
  ~30 mm apart, joined to the rim. Ribs one way stiffen that way only: use a cross or a grid.
- **A rim all round.** A lid's lip or a skirt 4–6 mm deep turns a plate into a shallow tray. A rim
  round a large window or cut-out keeps the frame from twisting.
- **Even walls.** Thick and thin next to each other shrink differently: core out thick spots, keep
  ribs thinner than the wall, add a fillet (about half the wall) where a wall meets a plate.
- **Slenderness.** The report's ENC.WARP measures each piece as a beam: its length over the
  thickness of a solid plate as stiff as its sections. Keep it under about 50 for PLA and PETG on a
  heated bed, 35 for ABS, ASA and sintered nylon, 30 for resin; a frame (a quarter or more of its
  outline open) 20 % lower. A 100 × 60 mm lid of 2 mm is 50; with a 5 mm lip all round it is 22.
- **The process.** SLA resin is the most prone: cure shrinkage, peel forces and post-curing bend
  thin flat parts, so keep resin walls ≥ 1.5–2 mm for parts around 100 mm and stiffen every large
  flat piece. A service may warn about warping and ask whether to go on: say in the brief which
  pieces carry the risk and how the script meets it. FDM: rounded corners on the bed (2 mm or more)
  and a brim for ABS and ASA.
- **Light parts.** A diffuser or a light window is thin on purpose: let its frame or the lid hold
  it flat (clamped in a pocket, ribs over its cell walls), and say so.

**Print orientation.** The base prints open side up. The lid prints outside face down (a smooth
face; text engraved there reads right way round from outside). Plungers print standing. Design so
neither piece needs supports: openings in the walls of the base are fine (bridges), posts rise from
the floor, and nothing hangs from the lid's inside except ribs and lips.

**Lid joint.** A lip (half the wall thick, 2–3 mm tall) on the lid inside the base's wall keeps it
aligned and closes the gap. Screws into the base's corner posts, from below (heads hidden under
the box) or through the lid (countersunk).

**Heat.** PLA softens around 55–60 °C, PETG around 75–80 °C. A closed box with a few hundred mW
inside stays warm but fine. Above about 1 W add vents low on one side and high on the other, and say
so in the brief. Keep warm parts away from the walls.

**Water and dust.** A sealed box (a gasket groove, glands) is beyond what you should promise.
Say so when the user asks for outdoor use: the printed box keeps rain off, it is not sealed.

## 6. Labels and logos

Port names ("USB", "12 V", "IN", "OUT"), a product name, a logo, arrows and icons go on the
outside of the box. The script has the helpers. Never rotate text by hand: mirrored and upside-down
labels are the usual mistake.

- `label('USB', { size: 4 })` is 2D text, centred, in the font that comes with the app (Liberation
  Sans Bold). `size` is the height of the capitals.
- `graphic('logo', { width: 20 })` is a graphic from the design, 2D and centred. The user's logos are
  in their artwork library (the artwork tool lists them; they import SVGs and trace pictures in
  Parts → Artwork). Put one in the design first with `design_edit set_enclosure_graphic name: "logo"
  artwork: "<its name>"`. For a simple icon (the USB trident, a power symbol, an arrow), write the
  SVG path yourself (`svg_path`). Do not trace text into a graphic: use `label`.
- `on_face(face, at, solid)` lays a solid on a face of the box, reading the right way from outside:
  its x to the reader's right, its y up, its z out of the box. `at` is a point on the face's
  outside: you know where your walls are. Faces are named as `parts_info`'s plugged-from: `left`,
  `right`, `top`, `bottom` (the walls along the board's edges seen from above), `above` (the lid,
  read from above with the board's top edge away from the reader) and `below` (the floor, read with
  the box tipped towards you).
- `engrave(face, at, shape, depth = 0.6)` is a 2D shape sunk into the face: subtract it from the
  piece. `emboss(face, at, shape, height = 0.6)` is a 2D shape raised out of the face: union it
  with the piece.

```js
const j1 = part_info('J1').mating;             // J1's mating: { facing, origin (the face's centre), … }
const usb_label = () => engrave('left', [-gap - wall, j1.origin[1], j1.origin[2] - 6], label('USB', { size: 4 }), 0.5);
function base() { return difference(base_body(), usb_label()); }
```

**Which way.** Engrave by default. It prints well on every face and nothing sticks out. Raised
text on a vertical wall prints fine too. Raised text on the lid's outside face does not: the lid
prints that face down, so engrave there. On the bed face, an engraving's floor is a short bridge.
That is fine for letters; keep a filled logo under ~10 mm across, or make it an inlay.

**Size.** Strokes at least 0.8 mm wide (two perimeters) and gaps between them at least 0.5 mm. With
Liberation Sans Bold that means capitals ≥ 4 mm on walls; ≥ 3 mm prints on the bed face. Depth or
height 0.4–0.6 mm, and at least 1 mm of wall left behind an engraving. The thin-wall warning
(ENC.THIN) catches strokes and ridges too fine to print. Make the text bigger, bolder or shorter.

**Where.** Name a port next to its opening, on the same face, centred on it (its mating face centre
in `parts_info`). Put the name below the opening or beside it, at least 1.5 mm from the opening's
edge and from the wall's edges. A logo goes on the lid or the largest wall, centred.

**Two colours (inlay).** A label or logo in another filament. It is a piece of its own that fills
the engraving exactly: the engraving cut from the host, and the same shape cut out of the host's
body.

```js
const pieces = ['base', 'lid', 'lid_logo'];    // list inlays after their hosts
const inlays = { lid_logo: { host: 'lid', colour: 'white' } };   // the colour it is shown in
const logo = () => engrave('above', [cx, cy, lid_top], graphic('logo', { width: 24 }), 0.6);
function lid() { return difference(lid_body(), logo()); }
function lid_logo() { return intersection(lid_body(), logo()); }
```

An inlay prints with its host: turned the same way, in the same 3MF object as a part of its own, so
the slicer gives it its own filament. The pieces-apart check leaves an inlay and its host alone,
and the thin-wall and overhang checks skip inlays. On the bed face, 0.4–0.6 mm deep (two or three
layers) is enough; it needs a multi-material printer or a filament change. Say which in the brief.

### 6.1 Names and logos at a print service

Print and PCB services (JLC3DP, PCBWay and others) check uploads for names and logos and stop an
order whose text looks like a company name or trademark until the user sends an authorization
(a trademark licence, a manufacturing authorization), or takes it off. That happens for the user's
own name when a brand has it too.

- When the box carries a name or logo and a service prints it, say so in the brief: ask whether it
  is the user's own mark (or one they may use), and whether to keep it off the service's files.
- Put every name and logo behind one parameter at the top, `const brand = true;`, and draw them
  only when it is on (`brand && logo()` among difference's children). The user turns it off for the upload (and adds a sticker or engraves it later)
  without losing it.
- Generic port labels ("USB", "12 V", "IN") and icons are never a problem.

**Check it.** `render_enclosure faces: ["left", "above"]` takes pictures of those faces as a
reader sees them. Look at every label there: does it read the right way round, is it the right
size, and is it in the right place?

## 7. Writing the script

The script is JavaScript on the Manifold geometry engine. `get_enclosure`'s
`board_api` lists everything it can call, and it reads like OpenSCAD with the children as arguments:
`translate([x, y, z], c)`, `difference(a, b, c)`, `linear_extrude(shape, { height })`. Nothing else
is there but JavaScript itself: no import or export, nothing from outside. `sin`, `cos` and the rest
are in degrees, as OpenSCAD's; `Math.sin` and the rest of `Math` are in radians.

```js
// parameters at the top
const wall = 2, gap = 0.5, floor_t = 2, standoff = 3, clearance = 0.3, lid_t = 2;
const pieces = ['base', 'lid'];
const print = { lid: [180, 0, 0] };

const floor_z = -standoff - floor_t;
const split_z = pcb_thickness + 2;
const lid_top = tallest_top + lid_clearance + lid_t;

const outline = () => offset(pcb_shape(gap), { r: wall });
const cavity = (z0, z1) => translate([0, 0, z0], linear_extrude(pcb_shape(gap), { height: z1 - z0 }));
const openings = () => brief_openings.map((ref) => mating_path(ref, { grow: clearance }));

function base() {
  const shell = translate([0, 0, floor_z], linear_extrude(outline(), { height: split_z - floor_z }));
  return difference(union(difference(shell, cavity(-standoff, split_z + 1)), hole_posts(-standoff)), openings());
}

function lid() {
  const shell = translate([0, 0, split_z], linear_extrude(outline(), { height: lid_top - split_z }));
  return difference(shell, cavity(split_z - 1, tallest_top + lid_clearance), openings());
}
```

- Take every position and size from the board's globals (`holes`, `parts_info`, `pcb_outline`,
  `tallest_top`). Never type a coordinate the board already has.
- Put every choice in a named parameter at the top. The user changes them, and so do you between
  renders.
- One function per piece, named in `const pieces = ['base', 'lid'];`, each returning a solid built
  in assembled position (the lid on the base). `const print = { lid: [180, 0, 0] };` says how a
  piece is turned for printing (the angles of `rotate`; a piece not named prints as built). The
  print files (STL, one 3MF plate) and the overhang checks use it. `pieces`, `print` and `inlays`
  are read without running the script, so write them out plainly: names and numbers, no variables.
- Openings from `mating_path(ref, { grow: clearance })`, so an opening follows its connector when
  the board changes.
- Everything returns a new shape and changes nothing in place: `translate(v, a)` is a new solid,
  `a` stays. A lone list is the children (`intersection(list.map(…))` is what they all share). Among
  other children a list is the union of what is in it, so `difference([a, b], c)` cuts `c` from
  both. `null` or `false` leaves a child out (`brand && logo()`), and `undefined` is an
  error: a helper that forgot its `return` would otherwise simply not cut.
- Round things are fine for printing by default: leave them, or give one a `fn` (`fn: 96` for a lens).
- `echo(bbox(lid()).size)` prints to the report: measure what you are not sure of instead of
  working it out. `distance(a, b)` is how far apart two solids are.

**Rounding.** Round the plain outer shape first, then cut the cavity and the openings out of it:

- `round_extrude(shape, { height, r })` is the way to a round box: any outline, its rims and its
  outer corners rounded, at once for a convex outline and in a second or two for any other.
  `top: false` or `bottom: false` leaves that rim sharp, both off rounds only the corners:
  `round_extrude(outline(), { height: 12, r: 1.5, bottom: false })` from z = 0.
- `round_box([x, y, z], r)` is a rounded block. `round_rect([x, y], r)` is a 2D outline to offset
  or extrude.
- `rounded(solid, r)` and `filleted(solid, r)` work on any solid, rounding what stands out or filling
  what goes in (where a post meets a floor). They take about 10 ms per triangle, and refuse a solid
  of more than 3000: use them on a small plain piece, or a single post before you join it.
- **The rim on the bed.** Rounding the face that lies on the bed is an overhang (ENC.OVERHANG) and
  it lifts the first layer. Leave the bed's rim sharp (`bottom: false` for a base printed open side
  up; `top: false` for a lid printed on its top), and keep the rounding for the rims that end up
  on top. A print service in resin or nylon does not care, so round all of it there.

**Smooth forms.** A shape with no straight edges (a dome that melts into a body, a hand-held form) is
a signed distance: `sdf(smooth_union(3, sd_box([40, 30, 20], 4), sd_sphere(12, [15, 0, 8])), { min: [-30, -25, -15], max: [30, 25, 25], edge: 1 })`.
The surface comes out within about `edge` of the true one, so cut anything that must fit (the
cavity, the openings, the screw holes) out of it afterwards with the exact solids. `edge: 1` while
you work, `0.5` at the end: each halving takes eight times as long. `f` may be any function of
`[x, y, z]`, negative inside.

## 8. Judging your render

Work through the report first: it is exact. Then look at the pictures:

- **Sections through openings**: does the plug's path stay clear? Is the receptacle's front close
  to the outside face? Is the wall round the opening at least 1 mm?
- **The opened box**: does the board sit on every post? Is there room for the cables and housings
  inside? Is anything floating (a post not touching the floor, a rib not joined to the lid)?
- **The angled views**: does every brief item show (opening, plunger, label, feet)? Would it print
  without supports?
- **Each long piece** (ENC.WARP): is it a tray, ribbed or framed, or a bare plate that will bow?
- **The faces with labels** (`faces`): does every label read the right way round, sit where it
  should, and stay clear of openings and edges?

Fix one thing at a time when a change is risky. Fix several when they are independent. Stop when
the report is clean and every brief item is seen. Then say in the proposal what you assumed and
what to check after the first print (a fit you could not measure, a friction lid, the plug
clearance for an unusual cable).
