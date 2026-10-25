# Cost: a guide for the agent making a design cheaper to make

> Part of [sourcing.md](sourcing.md). Status: 2026-10-25; Eurocircuits and PCBWay 2026-10-25. Written to
> the agent: this text is what it reads (`get_guide cost`) before it changes a design to make it cheaper. What
> the user asks wins over it.

The aim is the same circuit for less money. A change that alters what the circuit does is no saving
unless the user agrees to it. The numbers (fees, which parts cost one, what the board's surcharges
are) come from the tools, for the house the design is made at (the one the user chose; the sourcing
tool's house names another); this guide says how to use them.

## 1. Measure first

- Ask how many boards will be made, unless the user said it: the setup and loading fees are per
  order, so the price per board falls a lot with the number.
- `sourcing cost` with that number: the order at each assembly service, what is not included, the
  savings it found (each with a one-click way the user can take it), and the bare board's surcharges.
- `sourcing values`: cheaper ways to make each resistor's and capacitor's value.
- Note the total. You report before and after at the end.

## 2. What costs money, the most first (small runs)

1. **The service, and the second side.** A cheaper service may take only boards with every part on
   one side, a number of boards, some layer counts (the cost check says why a service cannot take the
   order); a house that has one service charges the second side (Eurocircuits €55). Moving the few
   parts on the bottom to the top is often the biggest saving of all (tens of dollars at JLCPCB).
   Only when the top has room, and the user did not put them there on purpose: ask.
2. **Fees per unique part number.** At JLCPCB, Economic assembly charges a loading fee for every
   unique Extended part and Standard for every unique part. At Eurocircuits every part number costs
   a BOM line and a part fee (€5.78), an On Demand part €1.65 more than a Generic or eC-stock one.
   So: parts without a fee, and fewer part numbers (§4).
3. **Hand soldering.** Through-hole parts cost labour per order and per joint (JLCPCB), or a placement
   per board and a fee for the kind (Eurocircuits). An SMD equivalent avoids it, or the user solders
   them: their time, so ask.
4. **The parts.** They matter on large orders; the cost check finds cheaper equivalents. Eurocircuits'
   Generic resistors and capacitors are free.
5. **The bare board** (not in the estimate): its size against the cheapest offers, its layers, holes
   below a size, fine tracks, a panel. The cost check lists what applies (§5).

At PCBWay its online quote prices the assembly as a whole, by the boards, the sides, the unique
parts and the parts per board (large ICs and through-hole parts apart), with a special price for
small orders (up to 20 boards, 100 kinds of part, no BGA or QFP part …): fewer part numbers, one
side and fewer through-hole parts still count, and keeping an order within the special price most of
all. The cost check asks the quote for the variants it can (one side, no through-hole parts).

## 3. Parts: how far each may move

Read what a part does before you change it: its nets, the pins it connects to, the datasheet's typical
application and design procedure (read_datasheet). The table is where to start; the datasheet wins.

| What it does | How far its value may move | Usually |
|---|---|---|
| Pull-up or pull-down on a GPIO, a reset, an enable, a jumper | Wide: 4.7 kΩ to 100 kΩ on a GPIO; a reset or enable as its datasheet says | A value already on the order (often 10 kΩ), or the nearest without a fee |
| I²C pull-ups | By bus speed and capacitance: up to 10 kΩ at 100 kHz, 2.2–4.7 kΩ at 400 kHz; the pull-ups of one bus together | A value on the order or without a fee, in that range |
| An LED's series resistor | ±20 % (the brightness changes with it; keep the current under the LED's rating) | The nearest without a fee |
| A series resistor on a signal (22–100 Ω), a gate resistor | ±30 % | The nearest without a fee |
| A feedback divider, a voltage-sense divider, a reference | Its ratio sets a voltage: keep the voltage within the regulator's tolerance (calc divider) | A pair that keeps the value within 1 %, or both resistors scaled together to values without a fee |
| A current-sense shunt, a gain or filter resistor, an RC timer, a crystal's load capacitors | Keep the value within its tolerance | A pair, or leave it |
| Decoupling capacitors at IC pins (100 nF, 1 µF) | More is fine within what the datasheet allows; keep the dielectric (X5R, X7R) and a voltage rating of 1.5–2 × the rail (ceramics lose capacitance with DC bias) | One value for every decoupling capacitor, without a fee |
| A regulator's input, output and bulk capacitors | The datasheet's range: some regulators need a minimum, some a maximum, some an ESR (an LDO's stability depends on it) | A value in range without a fee, or two in parallel |
| A soft-start, compensation or timing capacitor | Keep the value: it sets a time or the loop's stability | A pair, or leave it |
| An inductor (buck, boost, filter) | The datasheet's range; the current and saturation ratings above the peak current; a DCR no higher | Another inductor without a fee that meets all of it. Never two inductors in series or parallel in a power path |
| A ferrite bead | Its impedance at the frequency within ±25 %, its current rating | One without a fee |
| An IC, a transistor, a diode | The same part number from another maker (the cost check offers them): read its datasheet first. Another part is a redesign: only when the user asks | — |
| A connector | The same footprint and pinout | The user decides: it is the product's interface |

## 4. Values: one part, or two

`sourcing values` lists for each resistor and capacitor:

- The same value without a fee: take it, nothing in the circuit changes.
- The nearest values without a fee below and above, and the values already on the order: only where
  the part may move that far (§3).
- Two parts in series or in parallel that make the value within 1 % (resistors) or 10 % (capacitors),
  from parts without a fee or already on the order.

A pair:

- In series: two parts between the same two nets, with a new net between them (add_part for the
  second, then connect: the first between the old net and the new one, the second between the new
  one and the other old net). In parallel: the second part across the same two nets.
- Two parts take more room and two more joints each (the saving counts the joints). Place them
  together, where the one was.
- Two 1 % resistors in series or parallel stay within 1 %, and the power splits between them.
  Capacitors in parallel add up: keep both of the same dielectric and voltage rating.
- It pays only where it removes a fee: a value with no part without a fee, or a pair whose parts are
  on the order already. At Eurocircuits a second part costs a BOM line and a part fee, more than the
  On Demand fee it saves: there a pair pays only with parts on the order already, and a Generic part
  of a nearby value (where the part may move) saves the On Demand part's price too.

Fewer part numbers: where several values may move (pull-ups, LED resistors, decoupling capacitors),
bring them to one value. Where one value comes in several packages, one package for all where the
footprints have room.

## 5. The board

- Every part on one side (§2.1).
- The size: a board just over the cheapest offer's size may fit under it with a tighter placement.
  Ask before you change the user's outline.
- Layers: 2 cost less than 4, at every house. Only where the routing fits on 2: ask, it changes the
  layout.
- Holes: vias and drills at or above the size where the extra charge starts (the cost check says
  which); `set_board via_drill_mm`. Tracks and gaps likewise where the house charges for fine ones
  (Eurocircuits below 0.125 mm); `set_board track_mm clearance_mm`, where the routing has room.
- A panel only where the assembly needs one: single boards keep their special price.
- At order time, not in the design (say so): the standard thickness (1.6 mm), finish (HASL), colour
  (green) and copper (1 oz) cost the least.

## 6. Making the changes

- One changeset with every change (design_edit), a reason each: the ledger keeps them.
- Ask first where a change alters what the user may care about: a brightness, a time, a bus speed, a
  part they placed, the board's size or layers, a connector.
- Then check again: `sourcing cost` (the new total), `sourcing check` (the stock), no ERC or DRC errors.
- Report the total before and after; each change with what it saves and why the circuit still does
  what it did; and what you left as it was, and why.

## 7. Other houses

The checks price one house at a time: its fees, its parts without a fee, its board surcharges. The
app knows JLCPCB, Eurocircuits and PCBWay; give the sourcing tool's house to price another than the
user's (`sourcing cost house "eurocircuits"`). To compare, run the cost check for each with the same
number of boards and compare the totals, saying what each leaves out: the bare boards at JLCPCB and
Eurocircuits, the parts at PCBWay (it prices them after the BOM upload), and that Eurocircuits' are
in euros without VAT. Part numbers belong to a house: a design sourced at one needs the numbers of
the other (Eurocircuits orders by MPN where it has no number; PCBWay always does). For a house the
app does not know, say what would differ, not a price.
