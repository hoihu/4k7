# High-speed and RF lines: a guide for the agent

> Part of [impedance.md](impedance.md). Status: 2026-10-25. Written to the agent: this text is what it
> reads (`get_guide high_speed`) before it lays out fast interfaces or RF lines. The user's layout
> notes and the parts' datasheets win over it.

A line at a set impedance is a track and the plane under it, together: the signal runs along the
track and its return current along the plane right below it. The impedance comes from the track's
width, the dielectric between it and the plane, the copper and the solder mask; it holds only where
all of that stays the same. The kernel does the arithmetic and the checking (the stack-up, a field
solver, the IMP.* checks); you decide which lines need it, plan the board for them, and draw them.

## 1. Which lines need it

A line matters as a transmission line once it is long against the signal's edges: longer than about
50 mm per nanosecond of rise time (its delay more than a third of the edge; Eric Bogatin's rule of
thumb), so 25 mm with 0.5 ns edges. An RF line matters once it is longer than a tenth of the
wavelength on it (calc impedance with f gives the wavelength: about 70 mm at 2.4 GHz on FR-4, so
7 mm). Shorter lines act as a small capacitor: no rule needed, short and direct is enough.

Where to start; the interface's specification or the part's datasheet decides:

| Interface | Impedance | Pair skew | Notes |
|---|---|---|---|
| USB 2.0 Full Speed (12 Mbit/s) | not needed | | Edges of 4–20 ns: keep the pair together and short |
| USB 2.0 High Speed (480 Mbit/s) | 90 Ω differential (±10 % TI, ±15 % USB) | 1.25 mm (50 mil) | At most 4 vias per track; no stubs, no test points |
| USB 3.x, PCIe, SATA, HDMI, SGMII | USB 3: 90 Ω; PCIe: 85–100 Ω; SATA, HDMI: 100 Ω | 0.13 mm (5 mil) | Vias: at most 2 (USB 3), none if you can; AC caps 0402, symmetric |
| Ethernet (PHY to magnetics), LVDS, MIPI CSI/DSI | 100 Ω differential | as the PHY's or receiver's datasheet says | |
| RF to an antenna or an RF connector (Wi-Fi, BLE, LoRa, GNSS …) | 50 Ω | | Coplanar, with a via fence (§5) |
| Fast single-ended lines (a clock, RGMII, a DDR address line) | 40–60 Ω, as the datasheet says | | Matched in length as a group where the datasheet asks |

## 2. The board for them

**The stack-up.** The width for an impedance comes from the dielectric between the line and its
plane. Set the stack-up the board will be ordered with (set_stackup) before you work out lines;
get_board stackup shows the one in effect and the others. JLCPCB's standard 4 layers
(JLC04161H-7628) put F.Cu 0.21 mm over In1.Cu: 50 Ω is about 0.35 mm, a 90 Ω pair about 0.28 mm at
a 0.2 mm gap. A thinner prepreg (JLC04161H-3313, -2116, -1080) gives narrower lines that suit
fine-pitch pads. JLCPCB controls impedance from 4 layers up, ordered with that stack-up selected.
For another manufacturer read its stack-up page and import it (house, name, copper_mm, dielectric,
source_url); never fill a number from memory.

**4 layers** are the board for fast lines: F.Cu over the In1.Cu ground plane. Run the lines on F.Cu.
B.Cu runs over In2.Cu, the supply plane: fine for USB 2.0, not for RF or the fastest links (TI does
not recommend referencing power planes). Keep In1.Cu one unbroken ground (no split).

**2 layers**: the plane is 1.5 mm away, so a 50 Ω microstrip would be about 2.8 mm wide. Lines are
coplanar there (the default on 2 layers): ground copper on the line's own layer beside it at a small
gap (0.15–0.3 mm), the B.Cu ground below, and a via fence joining the two. Pour GND on F.Cu round
the line too (set_plane F.Cu GND, the whole layer or an area round the line; the B.Cu ground
stays), and keep every B.Cu track out from under it: a track crossing under it cuts its plane
(IMP.REFERENCE). The fab does not control impedance on 2 layers: the line comes out within about
±15 %.

**Placement first.** The parts a line joins close together and facing each other: the shortest line
needs the least care. The line's pads in line with its run (an RF chip's pin facing its connector
or antenna). Parts on the line (AC coupling caps, ESD arrays, common-mode chokes, a matching
network) in its path, so it flows through them without stubs: choose ESD parts that allow
flow-through routing. Lines away from switching regulators, inductors, crystals, oscillators,
mounting holes and the board edge (TI: 2.3 mm, 90 mil, from the plane's edge).

## 3. The rule

`set_impedance` with the nets (a pair positive first), ohms, and what the interface asks: tolerance,
max_skew_mm, keep_mm, a label. Its effect gives each layer's width (and a pair's gap, a coplanar
line's gap to the ground) with the impedance it gives and the delay; get_board impedance lists the
same, and once routed the lengths, vias and skew. From then on the router and draw_track take that
width, the pours keep the line's gap, and the IMP.* checks judge the copper.

- **A pair's gap**: the board's clearance unless you give gap_mm. Tighter coupling (a smaller gap)
  makes narrower tracks and a pair that keeps together against noise; give width_mm instead when the
  tracks should match a pad, and the kernel finds the gap. Where the width comes out below what the
  fab makes, the kernel widens the gap. A gap below the board's clearance is refused (the two tracks
  are two nets): lower the clearance first (set_board clearance_mm, down to the fab's).
- **Coplanar**: coplanar_gap_mm sets the gap to the ground beside it (default the clearance, at
  least 0.15 mm; not below the clearance, as for a pair); the pour keeps exactly that gap from the
  net, or its own clearance where set_plane_style makes that larger (the effect says the gap used).
  A microstrip's pour keeps further off (pour_keeps_mm), so the ground does not change it.
- **calc impedance** answers "what if" without changing anything: a width, a gap, another layer,
  another dielectric (h, er), a wavelength (f).

## 4. Drawing them

The router routes a line at its width (necked down only into a pad too small for it) and lays
these lines first, before the other nets, so nothing else cuts the plane under them. A pair it
routes together: one search for the pair's centre line, the two tracks drawn either side of it at
the rule's gap with their 45° jogs in from the pads, and where it must change layer, a via for each
track side by side. It keeps the two nets together even where other nets find it hard (it routes
the pair apart only if together it leaves another connection open, and then says so), and when it
cannot (no room for the fat pair, pads that do not pair up two to four each, a via where the line
turns, copper in the way) it routes the two nets apart and the effect says why ("routed apart, open
pair: …"; get_board IMP.PAIR): then draw the pair yourself. It knows nothing of stubs or skew, and a
route through parts in the line (an ESD array, a choke) is only as good as the pads allow. For the
lines that matter most, or where the router gives up, take the copper yourself (set_copper_mode
drawn; keep: true takes over what the router laid), draw these lines first, then let route find
the rest: the helper routes round your lines and keeps its tracks and vias off the plane under them.

- **Pairs**: route nets with both nets of the pair gives a coupled pair when it can (above);
  draw_pair from the two pads at one end to the two at the other, positive first, with the
  centre line's corners in via. Start the centre line straight out between the two pads, across the
  line joining them, and leave room at both ends for the tracks to come together at 45° (a few times
  the pads' pitch; the op says when it is not enough). Bend 45° at a time (bend "diagonal_first").
  The two tracks of a pair run side by side all the way, on one layer, apart only at their pads.
- **Single lines**: draw_track (its width is the rule's), straight where it can be, 45° corners, no
  vias.
- **Lengths**: get_board impedance gives a pair's skew. The tracks differ in length where they bend
  (the outer one is longer) and at their pads: bends to the left and to the right cancel out, so
  route a pair with both. Where a difference remains, make it up close to where it arises (TI: as
  close to the mismatched end as possible), with small bumps on the shorter track. tune_length does
  it: tune_length net <the shorter one> alone matches a pair member to its partner (match names
  other nets for a group; target_mm a length; near start | end | [x, y] where along the track;
  tolerance_mm). It puts square bumps with 45° corners into a straight stretch of the track, on the
  side away from the partner, no higher than twice the pair's gap (height_mm for a single line,
  4 mm), the legs at least three widths apart, a few small ones rather than one big one, clear of
  all other copper; the effect gives the length reached and the skew. If there is no room it says
  where and why (move what is in the way, a longer straight stretch with edit_copper via, or tune
  the other nets). Big bumps change the impedance. Tune after the pair is drawn and its vias are
  in: a via adds length to both tracks alike.
- **Vias**: a layer change takes the line to another plane, and its return current needs a way
  between the planes there: a ground via right beside each signal via (the check wants one within
  1.5 mm; TI allows 5 mm, closer is better), a pair's two vias side by side with one ground via each,
  as many on both tracks. Better none: change layers only where the line cannot do without.
- **Stubs and test points**: none on the line. A second part on a net (an ESD diode) goes on the
  line's path, through its pad, not on a branch out and back.
- **Parts on the line**: 0402 or smaller (TI: 0603 at most), a pair's two placed symmetrically, the
  track meeting the pad at its width (a neck into a narrower pad, under 1.5 mm long, is fine).
- **Other signals** keep away: twice the line's width edge to edge by default (the 3W rule; a
  coplanar line: twice its gap, room for the ground beside it). Fast links want more (TI: 0.76 mm,
  30 mil, from any other signal, 1.27 mm from clocks, five widths between pairs): set keep_mm.
  Ground copper and supplies beside a line are no aggressors.
- **Corners**: 45° at a time; a right angle is two 45° corners.

Every draw_pair, draw_track and edit_copper is checked at once: the effect names an IMP.WIDTH, a
corner, a via without its ground via. The checks of the whole line (the plane under it unbroken,
the ground beside a coplanar line, the pair's gap along its length, the skew) come with get_board
after the pours are laid. Look at it too: get_board_image region round the line.

## 5. RF lines and antennas

The radio chip's datasheet and the antenna's datasheet decide. Their reference layout (the matching
network and its values, the feed line, the antenna's keep-out area and ground clearance, where it
sits on the board) holds only when it is copied closely: read both (read_datasheet: the layout
guidelines and the reference board, with their pictures) and follow them; say where you depart.

- **The feed line**: 50 Ω, coplanar with ground on both sides, on the top layer, as short and
  straight as it can be, no vias. Fence it: add_vias kind fence along the net, net GND, pitch under a
  twentieth of the wavelength at the highest frequency (calc impedance with f: at 2.4 GHz under
  3.5 mm, 1.5–2 mm is usual; at 5–6 GHz under 1.5 mm). Ground pads of the RF parts go straight to
  ground vias.
- **The matching network** (often a pi: a shunt part, a series part, a shunt part; 0402 or 0201)
  sits where the datasheet puts it, at the chip's RF pin or at the antenna's feed point, its pads in
  the line's path, so the line runs through it.
- **The antenna** goes where its datasheet puts it, usually at a board edge or corner, with its
  keep-out area free of copper on every layer: no pour, no tracks, no vias, no parts. Lay that
  area down with add_keepout (see section 7): attached to the antenna part (`part`, the rectangle
  in the part's frame, so it follows when the part moves), layers "all", forbid tracks, vias, pours
  and parts. The area is the datasheet's drawing: its size from the antenna's body, often reaching
  past the board edge or the module's end; a ground plane clearance under a chip antenna is the
  same thing on the inner layers. Check it with get_board_image (the area shows hatched, with its
  label) and DRC.KEEPOUT in drc.
- **An RF connector** (u.FL, SMA): its datasheet's footprint, its ground pads to the plane with
  several vias right at them. A pad much wider than the line (an edge SMA's centre pin) lowers the
  impedance there; datasheets often clear the plane under it: add_keepout under the pad, forbid
  pours only, on the layer(s) the plane is on (section 7). Keep that stretch short; the line
  crossing the cleared plane reports IMP.REFERENCE, which you waive with the reason.

## 6. Before you propose

- get_board: impedance (each line's geometry, lengths, skew) and drc. IMP.WIDTH, IMP.LAYER and
  IMP.REFERENCE are errors: fix them. IMP.GAP, IMP.SKEW, IMP.VIA, IMP.CORNER, IMP.SPACING,
  IMP.COPLANAR and IMP.LENGTH are warnings: fix them, or keep one where you mean it and say why
  (add_waiver with the code and the entities get_board lists with it).
- Tell the user what to order: the stack-up by its name, and at JLCPCB impedance control with that
  stack-up selected; the lines with their impedance and widths. On 2 layers say that the fab does
  not control impedance, and the line comes out within about ±15 %.
- Say what you departed from in the datasheet's layout and why, and which keep-outs you set
  (get_board lists them).

## 7. Keep-outs

add_keepout marks an area where some things may not be, on some layers. It is how an antenna's
clearance, the plane cleared under a wide pad or a coil, a no-via zone and a no-part zone are said.

- `rect` (x_mm, y_mm, width_mm, height_mm, top-left corner) or `polygon` (corners in order), in
  millimetres on the board; with `part` they are in that part's own frame (origin at the part, the
  footprint as drawn, x right, y down, the part at rotation 0 on top; it is mirrored and turned
  with the part). The part may stand in it; everything else follows it.
- `layers`: "all" (default) or a list ("F.Cu", "In1.Cu" …). A via or a through-hole part goes
  through every layer.
- `forbid`: tracks, vias, pours (the copper fill of pours and planes, inner planes too: the plane
  is cut there), parts (courtyards, on the sides the layers name). Default: tracks, vias, pours.
- Examples: antenna `part: "ANT1"`, rect round its radiating end, layers all, forbid all four. A
  coil or a wide RF pad: `rect` under it, layers the plane's layer, forbid ["pours"]. A quiet node:
  forbid ["vias"] near it. A mechanical no-part zone (a screw head, a connector's plug): forbid
  ["parts"] on the side that matters.
- The router and the placer keep out of it, draw_track / draw_pair / draw_via refuse to enter it
  (KEEPOUT_HIT, with where), pours are cut round it, and DRC.KEEPOUT finds copper or a part that
  is in one anyway. edit_keepout changes it, remove_keepout removes it.

