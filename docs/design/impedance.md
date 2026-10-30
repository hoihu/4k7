# Lines at a set impedance

> Part of the [architecture](../ARCHITECTURE.md). Status: first slice implemented (2026-10-25); pair routing and length tuning added (2026-10-29).
> The agent's guide is [high-speed.md](high-speed.md) (`get_guide high_speed`).

## 1. Why

The user, 2026-10-25: *more advanced functions for the layout editor, starting with impedance
matching of traces for high-speed lines and antennas: find out how such traces are laid out, build
it and give it to the agent, without more buttons.* And: *the agent can be very close in the loop
on high-speed lines, so much of it can be a .md telling it how such traces are laid out.*

That sets the split. The guide tells the agent how (which lines need it, the stack-up, planes and
return paths, pairs, vias, antennas), from the sources in §8. The kernel does what an agent cannot
do reliably: the field arithmetic for widths and gaps, the geometry of a pair at its gap, and
checking the copper against the rule.

## 2. The split

| | Agent | Kernel |
|---|---|---|
| Owns | Which lines need a set impedance (the interface's spec, the datasheet), the stack-up the board is ordered with, where the lines run, drawing them | The widths and gaps (a field solver), a pair drawn at its gap, keeping other copper off a line's plane and away from it, the checks |
| Says it as | `set_stackup`, `set_impedance`, `draw_pair`, `draw_track`, `add_vias fence along`, `calc impedance` | Each op's effect, `get_board` `stackup` and `impedance`, the IMP.* findings |

## 3. The stack-up

`BoardSettings.stackup` (`Stackup`, `schema/stackup.ts`): finished copper per layer, the dielectric
between each two layers (thickness, εr, what it is), the solder mask (over laminate, over copper,
εr), where the numbers come from, and its origin. A full copy, like the fab profile, so a design
stays reproducible when a preset changes. Without one the board uses the default for its fab and
layer count (`defaultStackup`): JLCPCB's JLC04161H-7628 on 4 layers and 1.6 mm FR-4 (εr 4.5) on 2;
PCBWay's 4-layer build; otherwise a generic FR-4 board, which says so. 2 oz outer copper follows the
fab tier.

Presets, read 2026-10-25: JLC04161H-7628, -3313, -2116 and -1080 (JLCPCB's impedance page: prepreg
thickness and εr, core 4.6, 0.5 oz inner copper, its coating of 1.2 mil over laminate and 0.6 mil
over copper, εr 3.8); `jlcpcb/2l-1.6` (its capabilities page: εr 4.5; impedance control from 4
layers only); `pcbway/4l-1.6` (its laminated-structure page: 7628 RC 46 %, εr 4.74, as laminated
over planes; no mask stated, so none); `generic/2l-1.6` and `generic/4l-1.6`. Eurocircuits shows a
build-up only in its configurator, so it has no preset: import it.

`set_stackup` takes a preset, `none` (back to the default), or an import (house, name, copper_mm,
dielectric, mask, source_url, checked): copper 0.005–0.21 mm, dielectric 0.02–3.2 mm, εr 1.5–12,
one dielectric fewer than copper layers, and the board's layer count. `set_board layers` drops a
stack-up for another count. The effect lists the build-up and the rules worked out again for it.

## 4. The field solver

`kernel/impedance.ts`. Closed forms (Hammerstad and Jensen for a microstrip) are excellent for a bare
line, but a pair's field crowds into its gap where the solder mask fills it (2–8 % on a tight pair),
thick copper beside a narrow coplanar gap matters, and coupled coplanar lines have no closed form as
good. One solver handles all of them; the closed forms check it.

- The cross-section: the plane at y = 0, dielectric slabs, the copper with its thickness, the ground
  beside a coplanar line, the mask (a coat over the laminate and over the copper's top and sides),
  a second plane above for a stripline. Only half of it: a single line and the even mode of a pair
  are symmetric about the middle (no flux across it), the odd mode antisymmetric (0 V there).
- Laplace's equation by finite volumes on a rectangular grid, its lines through every edge and
  interface: cells an eighth of the smallest feature at the copper's edges, growing by 1.3, in its
  near field a quarter of the line's size at most (and no more than about 60 across the near field,
  so a narrow line far from its neighbours stays cheap), out to 40 times its size. Conjugate gradients with an
  incomplete Cholesky preconditioner solve it (the air solve starts from the dielectric one).
- The capacitance per length from the field's energy, with the dielectrics (C) and in air (C0):
  Z0 = η0 / √(C · C0) with C in units of ε0, εeff = C / C0, a pair's Zdiff = 2 · Zodd and
  Zcommon = Zeven / 2. The energy overestimates C, first order in the cell size, so each line is
  solved on the grid and on one twice as fine and extrapolated (Richardson).
- The inverse (the width, a pair's gap, a coplanar gap for a target) searches in log–log space on a
  coarse grid, then corrects the coarse grid by its bias at the answer and checks on the fine one:
  usually two fine solves. Every result is cached per cross-section.

Held in the tests:

| Case | Reference | Off by |
|---|---|---|
| Stripline, copper of no thickness | Exact (conformal mapping) | 0.02–0.06 % |
| Coplanar waveguide in air | Exact | 0.1 % |
| Coplanar waveguide on a thick substrate | εeff = (εr + 1) / 2 | under 0.001 |
| Microstrip, no thickness | Hammerstad–Jensen (0.01 % of exact) | ≤ 0.26 % |
| Microstrip, 35 µm | Hammerstad–Jensen with its thickness correction | ≤ 0.15 % |
| Coplanar L1 over L3 on JLC04161H-7628, 42.39 mil wide, 10 mil gap, mask | JLCPCB's calculator: 50 Ω | 49.5 Ω |
| Pair over 7628, 8.09 mil wide, 4 mil apart, mask | JLCPCB's calculator: 85 Ω | 84.2 Ω |

Time: one line 10–60 ms on 4 layers; a width search 50–150 ms on 4 layers and 0.1–0.9 s on 2 (a
thick dielectric, a coplanar pair the slowest). Quasi-static: no dispersion or losses, fine on FR-4
to a few GHz.

## 5. The rules

`BoardSettings.impedance` (`ImpedanceRule[]`): Z1, Z2 …; one net or a pair's two (positive first);
ohms (a line's Z0, a pair's differential impedance); tolerance (±10 %); style; a fixed width, gap or
coplanar gap; max skew, max length, keep (other signals' distance); a label. A net belongs to one
rule: `set_impedance` for it again replaces the rule.

`resolveImpedance` (`kernel/lines.ts`) works each rule out for the board, per outer layer: the plane
next to it (4 layers: In1.Cu under F.Cu, In2.Cu under B.Cu; 2 layers: the other side, where it has
a plane), the dielectric between, the copper and the mask, and the geometry that gives the target.
Defaults: microstrip on 4 layers, coplanar on 2 (a 50 Ω microstrip over 1.5 mm of FR-4 is 2.8 mm
wide; a coplanar gap given makes it coplanar); a pair's gap the board's clearance, widened when the
width would come out below the fab's track; a coplanar gap the clearance, at least 0.15 mm, and no
less than a pour on that layer keeps (set_plane_style clearance); a microstrip's pour gap where ground
beside it would lower it by 2 %. Gaps below the board's clearance are refused: a pour keeps at least
the clearance, and a pair's two tracks are two nets. Given sizes that miss the target by more than the tolerance, and widths or gaps
below the fab's limits, make a layer unusable with the reason; a rule no layer can carry is refused
(`IMPEDANCE_IMPOSSIBLE`). `BoardView.impedance` carries the result; `get_board` gives it with each
net's length and vias and a pair's skew; `get_net` gives the rule of a net.

## 6. On the copper

- **The router**: the rule's width is the net's width (`netWidths`). Where a pad at an end is too
  small for it (an 0402 pad, a fine-pitch pin), the connection is routed at the widest width the pad
  takes, then widened back to the rule's except a neck into that pad, where the wide copper keeps its
  clearance (on the grid's map and exactly). The pours keep the line's gap from its copper on the
  layers it runs on (`RouteInput.pourGaps`: the coplanar gap, or a microstrip's pour gap; the plane
  under it keeps its own clearance round the line's vias). Under the line's tracks that are there
  before routing (drawn, or kept from the routing before, once the router has decided what still
  holds) a band on the plane's layer, half the width plus the height either side, takes only the
  plane's net (`RouteInput.lines`), so the route helper's tracks and vias do not cut the plane under
  a line. Widths, gaps and fences are in the copper and placement keys.
- **Fences along a line** (`add_vias kind fence along`, `ViaGroup.along`): the router puts spots on
  both sides of the line's tracks once routed, every pitch, its gap to the ground plus half a via off
  its edge, and lays them like other fence vias, where they fit and join the ground on two layers. A
  strip of pour cut off between the line and another track is what they connect.
- **draw_track** takes the rule's width. **draw_pair**: the centre line from the midpoint of the two
  starts through the corners given to the midpoint of the ends, the tracks (width + gap) / 2 either
  side with mitred corners (the gap holds on the straight runs; at a 45° corner the outer corner
  stands 8 % further off), each track coming in from its pad by a 45° jog and both joining the pair
  at one point, the positive track on its pad's side at both ends (refused where they would cross,
  or where a piece of the centre line is too short for what its ends need: the tracks coming
  together, or the inner track's corner standing back by half the pitch × tan(half the turn)).
- **A pair routed together** (`pairroute.ts`, `RouteInput.controlled`): the maze router knows one
  net at a time, so a pair with a gap goes as one fat track along its centre line. The two nets'
  pads are joined in a stand-in net (the real pads relabelled to it), a virtual pad sits between
  each two, and the search runs from one virtual pad to the other for a track `2 × width + gap` wide
  (an outer layer or a plane layer the rule cannot be built on is shut to it). The two tracks are
  then drawn either side of the centre line it found, as draw_pair does (mitred corners, the 45° jog
  in from each pad, a 90° corner of the line cut into two 45° ones), and where the line changes
  layer the pair changes together: a via for each track side by side across the line (a via pitch
  apart; the line must run straight through the via, and the via slides along it to make room for
  the jogs). The tracks and vias are then checked exactly against all other copper and the edge; if
  anything fails (no way for the fat track, a short piece at a pad, copper in the way, a turn at a
  via, pads that do not pair up two to four each) the pair is routed as two nets after all, and why
  is recorded: `RouteResult.lines` → the route helper's effect ("USB_DP/USB_DN routed apart, open
  pair: …") or, for the router's board, an `IMP.PAIR` info finding. The coupled copper then goes to
  the main run as drawn copper, which also keeps the other nets off the plane under it (the `lines`
  band above). If it leaves another net's connection open (the blockage names the pair's net), the
  lines are routed once more with everything else and the better of the two is kept; the line's
  entry says so. Single lines (one net) are routed before the rest the same way, so the plane under
  them stays whole. Not in an incremental route that keeps copper (`keep`), not for one connection
  (`route from, to`), and not for suggest_moves' trials.
- **tune_length** (`tune.ts`): adds length to a drawn track with a meander, until its net reaches
  `target_mm`, or `match` (the longest of the nets named; for a pair member, its partner), within
  `tolerance_mm` (default 0.1 mm, or the pair's max skew if smaller). The meander is a row of square
  bumps in a straight stretch of the track (horizontal, vertical or at 45°), on the track's own
  layer, to one side: away from the partner for a pair member, else the side with more room, or
  `side`; near `near` (the first or last end or a point), else in the longest stretch. Every corner
  is two 45° corners (cut by one width, or half a width for a pair member; smaller bumps cut less).
  The legs are `gap` apart edge to edge: 3 widths at least (a smaller `gap_mm` is refused), more
  where the rule's `keep` is larger. The bumps are as tall as the room allows up to `height_mm`
  (default 4 mm; for a pair member twice the pair's gap, TI's advice for bumps near the mismatch),
  then as many as the missing length needs, with the height that gives exactly that. They are
  checked exactly before they are put in: clear of all copper of other nets (pads, tracks, vias),
  the edge and cutouts, and their own legs 3 widths from the rest of the track. Where one stretch
  has no room for all of it the next stretch takes the rest (up to six); where nothing has, the op
  is refused saying how much fits, where the bumps would go and what stops them, with the fixes:
  move what is in the way, taller bumps, a smaller gap, a longer straight stretch (edit_copper via),
  or the length on the other nets. The effect gives the length reached and, for a pair, the skew
  against the rule's limit (IMP.SKEW; IMP.LENGTH for a maximum length); the new copper is checked
  at once like any drawn copper.
- **The checks** (`impedanceDrc`). Width, corners, vias and spacing are checked when a drawing op
  applies (its effect); the rest needs the pours, so `get_board` gives it.

| Code | Severity | When |
|---|---|---|
| IMP.LAYER | error | A track on a layer the rule cannot be built on |
| IMP.WIDTH | error | A track whose width (a pair's: with the gap it keeps to its partner most of the way) gives an impedance outside the tolerance (a neck under 1.5 mm into a pad aside) |
| IMP.REFERENCE | error | The plane under the line broken: under it, or half its width plus its height either side, for 0.4 mm or more, away from its pads and the parts it joins. Warning: it crosses from one plane's net to another's |
| IMP.COPLANAR | warning | A coplanar line without its ground beside it for 1 mm or more |
| IMP.GAP | warning | A pair away from the gap it keeps most of the way for more than 1 mm and a tenth of its length |
| IMP.SKEW | warning | A pair's lengths differ by more than its skew (0.5 mm unless set) |
| IMP.VIA | warning | A via of the line with no ground via within 1.5 mm; a pair's tracks with different via counts |
| IMP.CORNER | warning | A turn sharper than 45° |
| IMP.SPACING | warning | Another signal (not a supply, not a plane's net) closer than keep: twice the width, a coplanar line twice its gap (at least 0.5 mm), unless set |
| IMP.LENGTH | warning | Longer than its max length |
| IMP.PAIR | info | The router routed a pair as two nets, or kept it together although that left a connection open; says why (not a check of the copper) |

- **calc impedance**: the solver on the board's stack-up (`DesignSummary.stackup`), F.Cu or B.Cu with
  its mask, or on a dielectric given (h, er, t); a width, a pair's width or gap, a coplanar gap, the
  wavelength.

## 7. Surfaces

| Surface | What it does |
|---|---|
| `set_stackup` | A preset, the default again, or an import with its source |
| `set_impedance`, `remove_impedance` | A rule for a net or a pair; its effect gives each layer's geometry |
| `draw_pair` | A pair at its gap along a centre line (drawn copper) |
| `draw_track` | A controlled net's track at its rule's width |
| `add_vias kind fence along` | A via fence along both sides of a line |
| `add_keepout`, `edit_keepout`, `remove_keepout` | An antenna's clearance, the plane cleared under a wide pad (pours off on that layer), a no-via or no-track zone; attachable to a part |
| `calc impedance` | What-ifs, without changing the design |
| `design_query get_board` | `stackup` (build-up, source, the other presets), `impedance` (geometry, lengths, vias, skew), IMP.* in drc |
| `design_query get_net` | The net's rule |
| `design_query get_guide topic high_speed` | The guide |
| Changeset | The stack-up and the rules in the board's details |

No buttons: the user asks in words; the Layout view shows the copper as before.

## 8. Sources

- Texas Instruments, *High-Speed Interface Layout Guidelines*, SPRAAR7J (2023): reference planes,
  voids (1.5 W), plane-edge distance (90 mil), stitching vias (200 mil), the 5W rule and keep-outs
  (30 and 50 mil), symmetry, length matching at the mismatched end, via counts and stubs, AC caps,
  bends (≥ 135°), the interface tables (USB 2.0 90 Ω, skew 50 mil; USB 3, PCIe, SATA, HDMI).
- Eric Bogatin, *The Critical Length of a Transmission Line* (2004): length in inches above twice the
  rise time in ns.
- JLCPCB, impedance stack-ups (jlcpcb.com/impedance) and capabilities; PCBWay, multilayer laminated
  structure.
- E. Hammerstad and Ø. Jensen, *Accurate Models for Microstrip Computer-Aided Design* (1980), as in
  the QUCS and KiCad transmission-line calculators.
- RF practice: via fences under a twentieth of the wavelength; Espressif's hardware design guidelines
  (50 Ω feed, the matching network close to the pin); antenna datasheets for keep-outs and ground
  clearance.

## 9. Not yet

- A copper keep-out exists now (`add_keepout`, layout.md §13: an antenna's clearance, the plane
  cleared under a wide pad). What it does not do: IMP.REFERENCE does not know a void is meant, so a
  line that crosses a plane cleared on purpose is reported (keep that stretch short, say why, and
  add_waiver); the cut is a clean polygon, not tuned to a pad's size or the line's gap.
- Pair routing beyond one chain of pad pairs: a pair that branches (a pad pair joined to two others),
  a via where the centre line turns (the pair then goes apart, with a note), ground vias beside the
  pair's vias (the IMP.VIA warning asks the agent for them), pairs in an incremental route that
  keeps copper. Tuning a net's length across several tracks at once (each
  track is tuned alone, longest first), and meanders on a pair as a whole (a trombone of both
  tracks); serpentines that alternate sides.
- Striplines on inner signal layers (6 layers and up; the solver has them), dispersion and losses,
  trapezoidal etching (about 1 Ω).
- The stack-up and an impedance table in the design document and the fab outputs.
