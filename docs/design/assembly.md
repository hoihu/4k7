# Assembly: what the assembly house sees

> Part of the [architecture](../ARCHITECTURE.md). Status: polarity marks, the land check, SMD electrolytics and the pick-and-place in the house's frame 2026-10-26.

An assembly house places every part from the BOM and the pick-and-place file, and checks the result
against the board before it solders: its engineers draw their own model of each part over our pads
and compare its pin 1, cathode or plus terminal with the board's silkscreen. Where the silkscreen
does not say which way round a part goes, they stop and ask (JLCPCB's "please confirm the polarity"
mail); where it says something else than their model, the board comes back wrong.

The case that started this (spiral2 at JLCPCB, October 2026): the only mark the silkscreen had was a
0.4 mm dash beside pad 1, clipped down to 0.2–0.4 mm by the pads. It read as a minus sign, and it
sat beside the plus pad of both electrolytic capacitors and beside VDD of the 48 WS2812B LEDs, where
JLCPCB's own footprint prints a "+". JLCPCB asked about the LEDs, the MCU, the USB-PD controller and
the two indicator LEDs. The app's 2D view drew a dot there instead, so nobody saw what JLCPCB saw. And
it could not place the two electrolytics at all: their pads were chip-style strips as tall as the can
(an SMD electrolytic sits on two narrow pads under its leads), and C11's part was a 6.3 mm can on pads
made for an 8 mm one. The stock check had said so, by the packages' names, among names that differed
only in spelling.

## 1. Which way round a part goes

`polarityOf` (`packages/kernel/src/marks.ts`) reads it off the part card:

| The card | What is marked |
|---|---|
| `polarity` set on the card (`set_polarity`) | what it says: `pin1`, `cathode` or `plus` at its pin, or nothing (`none`) |
| Two pins, one named K (or Cathode), or Anode (A on a diode or LED) | the cathode |
| Two pins, one named + (or the other named −) | the plus terminal |
| A two-pin diode or LED whose pins say neither | nothing: **DRC.POLARITY_UNKNOWN** asks for `set_polarity` |
| A two-pin resistor, capacitor, inductor or crystal | nothing (it fits either way round) |
| Anything else with two pins or more | pin 1 (or the first pin, "A1" on a BGA) |

The mark goes by the pin's function, never by its number alone: LEDs number their pins both ways
(LCSC's C84256 has the cathode as pin 1, C2297 the anode), and generic:D, generic:LED and generic:CP
name their pins K/A and +/−. The datasheet importer names a polarised part's terminals the same way.
`set_polarity` refuses generic parts (their pin names already say it for every component that uses
them) and changes the design's copy of an imported part's card, like `set_mating`.

`BoardPart.polarized` stays true for every part with a way round (the 3D body's pin-1 dimple);
`BoardPart.mark` holds the mark.

## 2. The marks

| Kind | Mark | Where it goes, in order |
|---|---|---|
| `pin1` | a filled dot, Ø0.5 mm (Ø0.35 where that does not fit), and the body's outline chamfered at pin 1's corner (bodies of 2 mm and more) | beyond pin 1's pad on its outer side; off the body corner, diagonally; at the end of pin 1's row; further out; inside a big body's corner |
| `cathode` | a band across the body, 0.3 mm wide (0.2 mm) | between the pads against the cathode, where the part carries its own band; beyond the cathode's outer end |
| `plus` | a "+", 0.8 mm across (0.6 mm), 0.15 mm lines | beside the plus pad's outer half, either side; beyond its end; at its outer corners |

Never a lone dash: next to a plus pad it reads as a minus. A polarised capacitor gets a "+" and not a
bar, because a tantalum carries its band at the plus end and an aluminium can at the minus end.

`placeMarks` places them once the board is placed (`placeBoard`) and again after routing
(`layoutBoard`, clear of the routed vias), in refdes order, the bigger size first: the first spot
whose ink keeps 0.15 mm from every pad of that side (and through-hole pad and hole), via, other mark
and other part's body outline, and from the board edge and cutouts, and that is nearer the part's own
pads than any other part's (so it is not read as a neighbour's mark). No spot: **DRC.SILK_POLARITY**
(a warning) names what is in the way. It costs about a millisecond on a 130-part board.

The marks are geometry in the board view (strokes and dots, board coordinates), so every picture of
the board draws the same ink: the Gerber silkscreen (`packages/fab/src/gerber.ts`, refdes texts keep
off the marks), the 2D view, the agent's `get_board_image` and the design document (all three
`BoardCanvas.svelte`), and each copy on a panel. The chamfered outline is `bodyOutline(body)`.

## 3. The land against the part the house buys

The stock check (Layout → Sourcing, the agent's `sourcing check`, and the export, §5) asks the house
for its own footprint of each part (`PartSource.footprint`) and holds the component's land as it lies
on the board against it (`fitLand`, `packages/parts/src/land.ts`):

- The house's footprint is turned onto ours (0°, 90°, 180°, 270°; mirrored for a part on the bottom)
  and its pads are paired with ours: by function for a two-pin part that goes one way round (the
  cathode, the plus terminal: pin numbers say nothing there), else by number, else by the pins'
  names, a word of them or a contact ("CC1_A5" pairs with JLCPCB's pad A5 named CC1, a SOT-223 tab
  numbered 2 here with its pin 4), whichever pairs more pins and lines them up better. Pads left over
  (a connector's shield legs) pair by where they are. An SMD pad never pairs with a drilled one.
- It does not fit when a soldered pad has no pin, a pin has no pad, a pin lands more than 1 mm off
  its pad (a third of that for a drilled one), or a pad of the house's shares less than a fifth of its
  area with ours (spiral2's C1: 0.16; every part that fits on spiral2: 0.25 or more). The message
  says how: "its pads are 3.5 × 1.2 mm, 5.34 mm apart; the pads of CAP-6.3x5.4 2.2 × 6.8 mm,
  5.1 mm apart".
- The package's name still counts where it says a size, an electrolytic's can or a chip size: a
  6.3 mm can lies on an 8 mm can's pads well enough to pass the land check, but it is the wrong
  part. A catalogue's can ("SMD,D6.3xL7.7mm") is read as the package that fits it (`canPackage`:
  CAP-6.3x7.7), so the same can no longer reads as a mismatch, and the message names the package
  that would fit.
- A land that does not fit stops the order, like a part out of stock. The report says how many lands
  were compared, and which footprints could not be read and why.

JLCPCB's footprints are its parts library's, EasyEDA's: the server reads them from EasyEDA's
component API by LCSC number (`easyedaFootprint`, `packages/parts/src/jlc.ts`), keeps each a day in
memory and a month on disk (`~/.4k7/footprints`), and asks for them 150 ms apart (EasyEDA's CDN stops
answering an address that asks too fast). When it cannot, the tab reads the copy of the same record
on the jlcsearch mirror. A house without footprints (Eurocircuits, PCBWay) keeps the check by name.

## 4. SMD electrolytics

`CAP-4x5.4`, `CAP-5x5.4`, `CAP-6.3x5.4`, `CAP-6.3x7.7`, `CAP-8x6.5`, `CAP-8x10` and `CAP-10x10`
(`packages/parts/src/packages.ts`) are V-chip lands, a pad under each lead as the makers recommend
(Panasonic, Nichicon, Rubycon: the lands of KiCad's CP_Elec footprints), pin 1 (+) on the left. The
body is the base plate (diameter + 0.3 mm square), its corners chamfered on the + side as on the part
(`body_chamfer` in the package data, turned and mirrored with the part like pin 1), with the "+" of
§2 beside the + pad; the 3D body is the plate with the can on it. Until 2026-10-26 these packages
went through the chip generator, which drew pads as tall as the can: no SMD electrolytic fits that.

| Can | Pads | Centres |
|---|---|---|
| 4 × 5.4 | 2.6 × 1.6 | ±1.8 |
| 5 × 5.4 | 3.0 × 1.6 | ±2.2 |
| 6.3 × 5.4 | 3.5 × 1.6 | ±2.8 |
| 6.3 × 7.7 | 3.5 × 1.6 | ±2.7 |
| 8 × 6.5 | 4.0 × 2.5 | ±3.05 |
| 8 × 10 | 3.5 × 2.5 | ±3.25 |
| 10 × 10 | 4.0 × 2.5 | ±4.0 |

Choosing a part in the Inspector sets the component's package to the part's can, and so does taking
its values.

## 5. Before the order

Exporting the fab files runs the stock check first when the parts carry the house's numbers (stock,
each part against its component, each land against the house's footprint), then writes the zip and
names the parts that stop the order; the Sourcing section says why. The files are written either way:
they are what a quote is made from. The pick-and-place in the zip is in the house's frame for every
part whose land the check held against its footprint (§6), and the message says for how many.

## 6. The pick-and-place in the house's frame

A pick-and-place file says where each part goes and how far it is turned, counted from the house's
own footprint for the part at 0°, counter-clockwise seen from the top, and placed by that footprint's
origin. The board's own frame is not the house's: JLCPCB's library draws a SOIC-8, a DFN, a SOT-23 and
the WS2812B with pin 1 at the bottom where ours has it at the top left, so its engineers turned every
one of those parts on spiral2 by hand ("Corrected Part Placement") and asked about the ones they could
not check against the silkscreen.

The land check of §3 already lays the house's footprint on ours: `fitLand` returns its rotation and
where its origin lies (`at`, from the part's centre). The stock check keeps both for each component on
the top side whose land fits (`StockLine.placements`), and the export writes them (`pickAndPlace(b,
placements)`, `fabFiles`, each copy of a panel too): that part's row gets the house's rotation and
the origin's position. Every other part keeps the board's frame as before: no footprint read, a land
that does not fit (the order stops there anyway), and parts on the bottom side, where how a house
counts the rotation (seen from the bottom, mirrored) is not settled here.

On spiral2 this gives the rotations JLCPCB's engineers set: the 48 WS2812B, U6 (DFN), Q1 and U1 (SOIC)
and Q2 (SOT-23) at 270° instead of 0°, U2 (SOT-223) and U4 at 180° instead of 270°, U5 (SOT-23-5) at
0° instead of 90°; J2 (USB-C) stays at 0° but moves 1.2 mm to its footprint's origin; the rest is as
before. Counter-clockwise is how the KiCad plugins for JLCPCB count too: their tables turn KiCad's
SOIC and DFN (pin 1 at the top left, as ours) by 270°, as the fit does. Their fixed table goes by the
footprint's name; the fit goes by the part's own footprint, which differs between parts of one package
(JLCPCB's SOT-23 used to have its pins 1 and 2 along the bottom, now on the right), so it needs no
table.

