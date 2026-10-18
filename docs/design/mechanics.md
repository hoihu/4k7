# Mechanics: a guide for the agent designing an enclosure

> Part of [enclosure.md](enclosure.md). Status: draft, 2026-10-15. Written to the agent: this text is
> what it reads (`get_guide mechanics`) before it writes a brief or a script. The user's enclosure
> notes win over it.

Numbers below are typical starting values for an FDM printer with a 0.4 mm nozzle. A datasheet, the
user's notes or the user's answer always win. When a number matters and you are guessing, say so
in the brief.

## 1. Before you draw: the brief

Read the board first: `get_board`, `board.scad` (`parts_info`, `holes`, `tallest_top`,
`lowest_bottom`), and the datasheets of the connectors. Then write the brief. Decide what the
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

## 4. Holding the board

The board must not move when a plug goes in or a button is pressed.

- **Screws through its mounting holes onto posts** (the default when it has holes). Use
  `holes` in `board.scad`. The post's top is at z = 0 (the board's underside). Its diameter is
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
outside of the box. board.scad has the helpers. Never rotate text by hand: mirrored and upside-down
labels are the usual mistake.

- `label("USB", size = 4)` is 2D text, centred, in the font that comes with OpenSCAD (Liberation
  Sans Bold). `size` is the height of the capitals.
- `graphic("logo", width = 20)` is a graphic from the design, 2D and centred. The user's logos are
  in their artwork library (the artwork tool lists them; they import SVGs and trace pictures in
  Parts → Artwork). Put one in the design first with `design_edit set_enclosure_graphic name: "logo"
  artwork: "<its name>"`. For a simple icon (the USB trident, a power symbol, an arrow), write the
  SVG path yourself (`svg_path`). Do not trace text into a graphic: use `label`.
- `on_face(face, at)` lays 2D children on a face of the box, reading the right way from outside:
  their x to the reader's right, their y up, their z out of the box. `at` is a point on the face's
  outside: you know where your walls are. Faces are named as `parts_info`'s plugged-from: `left`,
  `right`, `top`, `bottom` (the walls along the board's edges seen from above), `above` (the lid,
  read from above with the board's top edge away from the reader) and `below` (the floor, read with
  the box tipped towards you).
- `engrave(face, at, depth = 0.6)` is the 2D children sunk into the face: `difference()` it from
  the piece. `emboss(face, at, height = 0.6)` is the 2D children raised out of the face: `union()`
  it with the piece.

```scad
j1 = part_info("J1")[6];                       // J1's mating: [from, face centre, …]
module usb_label() engrave("left", [-gap - wall, j1[1][1], j1[1][2] - 6], 0.5) label("USB", size = 4);
module base() difference() { base_body(); usb_label(); }
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

```scad
pieces = ["base", "lid", "lid_logo"];
inlays = [["lid_logo", "lid", "white"]];       // [inlay, host, colour shown]; list inlays after their hosts
module logo() engrave("above", [cx, cy, lid_top], 0.6) graphic("logo", width = 24);
module lid() difference() { lid_body(); logo(); }
module lid_logo() intersection() { lid_body(); logo(); }
```

An inlay prints with its host: turned the same way, in the same 3MF object as a part of its own, so
the slicer gives it its own filament. The pieces-apart check leaves an inlay and its host alone,
and the thin-wall and overhang checks skip inlays. On the bed face, 0.4–0.6 mm deep (two or three
layers) is enough; it needs a multi-material printer or a filament change. Say which in the brief.

**Check it.** `render_enclosure faces: ["left", "above"]` takes pictures of those faces as a
reader sees them. Look at every label there: does it read the right way round, is it the right
size, and is it in the right place?

## 7. Writing the script

- Start with `include <board.scad>`. Take every position and size from it (`holes`,
  `parts_info`, `pcb_outline`, `tallest_top`). Never type a coordinate the board already has.
- Put every choice in a named parameter at the top (`wall = 2;`, `clearance = 0.25;`,
  `lid_gap = 1;`). The user changes them, and so do you between renders.
- One module per piece (`base()`, `lid()`, `plunger()`), chosen by `piece`. Build each piece in
  assembled position (the lid on the base), and say how each is turned for printing:
  `print = [["lid", [180, 0, 0]]];` (OpenSCAD rotate angles; a piece not named prints as built).
  The print files (STL, one 3MF plate) and the overhang checks use it.
- Openings from `mating_path(ref)` grown by the clearance (`minkowski` or `offset` on its
  profile), so an opening follows its connector when the board changes.
- Round outer edges (`hull` of spheres, or `offset(r)` on the outline before `linear_extrude`).
  Leave sharp inside corners where printing needs them.
- `$fn = 48` for holes and posts, lower for big rounds while iterating.

## 8. Judging your render

Work through the report first: it is exact. Then look at the pictures:

- **Sections through openings**: does the plug's path stay clear? Is the receptacle's front close
  to the outside face? Is the wall round the opening at least 1 mm?
- **The opened box**: does the board sit on every post? Is there room for the cables and housings
  inside? Is anything floating (a post not touching the floor, a rib not joined to the lid)?
- **The angled views**: does every brief item show (opening, plunger, label, feet)? Would it print
  without supports?
- **The faces with labels** (`faces`): does every label read the right way round, sit where it
  should, and stay clear of openings and edges?

Fix one thing at a time when a change is risky. Fix several when they are independent. Stop when
the report is clean and every brief item is seen. Then say in the proposal what you assumed and
what to check after the first print (a fit you could not measure, a friction lid, the plug
clearance for an unusual cable).
