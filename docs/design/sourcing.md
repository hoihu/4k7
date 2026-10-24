# Sourcing: parts from the assembly house's catalogue

> Part of the [architecture](../ARCHITECTURE.md). Status: first slice 2026-10-02; live catalogue, stock check, the
> house-neutral layer, the order's cost and the cost check 2026-10-24; the values check, the board's surcharges and the
> agent's cost guide 2026-10-25.

The assembly house (JLCPCB so far) assembles boards from its own stock, identified by its own part numbers (at JLCPCB,
**LCSC part numbers**: `C25804`). The catalogue has hundreds of thousands of parts, so 4k7 never imports it. Parts
are fetched **on demand**, and two kinds of parts are treated differently:

| Kind | What happens | Why |
|---|---|---|
| Resistor, capacitor (jellybean) | The component keeps its generic part (`generic:R`). The chosen LCSC number is its `lcsc` parameter. | Nothing to verify: no pins, and the value and package already describe the part. |
| Anything with pins (IC, module, buzzer, connector) | The catalogue record gives the datasheet link; the part is imported through the [datasheet import](part-ingest.md). The component then gets its `lcsc` parameter. | Pins and footprint must be checked; the import pipeline does that. |

## One house now, others later

What is particular to a house lives in two places; everything else works for any house.

| Where | What |
|---|---|
| Its `AssemblyHouse` entry (`packages/schema/src/sourcing.ts`) | Name; the component parameter that holds its part number (`lcsc`) and what the numbers are called; its classes of parts and which cost a fee; the fee and how to keep a scarce part for an order, in words for the user and the agent; its assembly services with their fees and limits, where they were read and when, and what an estimate leaves out; the part page; the number format |
| Its catalogue adapter, a `PartSource` (`search`, `lookup`) | `packages/parts/src/jlc.ts` for JLCPCB: its own catalogue and a mirror |

House-neutral: the part as a catalogue lists it (`SupplierPart`), the ranking, the check of a part against its
component, the stock check with its replacements (`packages/parts/src/sourcing.ts`), the order's cost and the cost
check (`packages/parts/src/cost.ts`), the agent's `sourcing` tool, the Inspector's Sourcing section and the Layout
view's checks. `ASSEMBLY_HOUSE` is the one house the app sources
for. Another house needs its entry, its adapter, its source on the server (`tools/server/src/sourcing.ts`), a
mirror if it has one (`apps/web/src/lib/sourcing.ts`) and its BOM columns: the BOM's `LCSC Part #` column is
JLCPCB's.

## The `lcsc` parameter

Every component may carry `lcsc` (see `UNIVERSAL_PARAMS` in `packages/schema/src/part.ts`): the
kernel accepts it on any card, normalises `c25804` to `C25804` and rejects anything that is not a
C-number. It is an ordinary parameter, so the agent (`set_param`), the Inspector and the ledger
treat it like a value. The board view carries it to the BOM, whose last column is `LCSC Part #`,
the column JLCPCB's assembly upload reads.

Stock and prices are **snapshots**, shown when a part is looked up and never stored in the design.

## Classes and fees

JLCPCB charges a loading fee per unique **Extended** part in an order; **Basic** and **Preferred** parts have none.
A part says its class (`tier`) and whether it costs a fee (`fee`). Results are ranked fee-free first, in the house's
order of classes (Basic, Preferred, Extended), then by stock, deepest first; a part whose stock is unknown comes after
the ones with a number. The `no_fee` filter keeps the fee-free ones.

## Where the data comes from

1. **The house's own catalogue, read by the local server.** For JLCPCB that is the search behind jlcpcb.com/parts (a
   JSON endpoint): stock as of the call, price breaks, class, attributes, the datasheet link. A search asks for 100
   parts in stock and ranks them; a package filter uses JLCPCB's package names and, when nothing has that exact name,
   joins the package to the words ("SOT-223" and "SOT-223-3"). A lookup searches for the number and keeps the exact
   match (the search also finds similar numbers). jlcpcb.com sends no CORS headers, so the browser cannot call it;
   the server can, under `/api/sourcing/<house>/search` (POST a `PartQuery`) and `/api/sourcing/<house>/part/<number>`,
   with the access key like the project files. It keeps answers for 10 minutes and runs three requests at a time,
   with the browser-like user agent of the datasheet downloads: a stock check of a whole design is no more load than a
   person looking the parts up.
2. **A mirror, when the server cannot read it** (not running, older than this, jlcpcb.com down or answering in
   another form): the browser asks [jlcsearch.tscircuit.com](https://jlcsearch.tscircuit.com) itself (its host is in
   the app's Content Security Policy, `apps/web/index.html`). Its parts say `live: false` and are shown "(mirror)".
   Its stock lags by up to a day, and most of its resistor and capacitor rows have none at all: that is **stock
   unknown**, never 0. Its copy of EasyEDA's record of a part gives the maker and the datasheet link; the stock in
   that record is LCSC's (another warehouse) and is not used.

The tab keeps live answers for 10 minutes and a mirror's for one, so the house's own answer is back as soon as it can
be read. There is no official public API: JLCPCB's [own API](https://api.jlcpcb.com/help/article/jlcpcb-online-api-available-now)
is given to companies on application, after a review of their orders, so it is no use to an open-source app's users.
Neither source is a contract either: an answer in a form the adapter does not read is an error, never an empty
catalogue, and the JLCPCB part page (`https://jlcpcb.com/partdetail/C…`) is always given as the human fallback.

Why not let an agent browse the site instead: the facts are at a known address, and a plain request gets them
exactly, in a fraction of a second, at no cost. A model reading pages is slow, costs tokens per part and can misread
or make up a number, which a stock check cannot afford; and the stock on JLCPCB's part page sits in its script
data, which a web-fetch tool's page-to-text step drops. The agent's judgment goes where it helps: which part to take,
what an acceptable replacement is, what the datasheet says.

## The stock check

Every component's part number looked up now, for a number of boards (Layout → Sourcing, where the number of boards is
kept in the settings, or the agent's `sourcing` `check`). The components that share a number are one line; the pieces
it needs are its components × the boards.

| A line is | When |
|---|---|
| `out` / `short` | No stock / fewer than the pieces needed |
| `low` | Enough, but under 5 × the need (`STOCK_MARGIN`): it may be gone by the time the order goes in |
| `ok` | At least 5 × the need |
| `unknown` | The source gave no number |
| `missing` | The catalogue does not list the number (gone, or a wrong number) |
| `failed` | It could not be looked up |

A part that is not what its component asks for (value, a capacitor's voltage rating, the package: the check the
Inspector makes) **stops the order** like one that cannot be had: the house assembles what the number says. So do
`out`, `short` and `missing`; `low`, `unknown` and `failed` want a look; a part with a fee is listed with the fee.
Components without a number are listed too (fine for parts soldered by hand), and what the parts cost at today's
prices, without fees.

**Replacements** are searched for the lines in trouble, and for parts with a fee (to avoid it):

- A resistor or capacitor: the same value and package, in stock for the boards, fitting the component, and no worse
  than the part it replaces: a resistor's tolerance and power, a capacitor's dielectric and voltage rating. When the
  old part is gone, the component's own tolerance and dielectric stand in.
- Anything else: the same part number in the same package, from another maker or listing; the agent reads its
  datasheet before switching. Where nothing like that exists, the Layout view asks the agent to find a part.

They are ranked fee-free first, then those with 5 × the need in stock, then by class and stock. **Use** sets the
number on every component of the line and checks again; the agent does the same with `set_param lcsc`. Exporting the
fab files says when the stock was not checked, or when the last check found parts that stop the order.

## What the order costs

The stock check prices the order, and the **cost check** (Layout → Sourcing → Check cost, or the agent's `sourcing`
`cost`) shows how and what would make it cheaper. Both come as a range over the house's services that can take the
order; JLCPCB's prices are its [price page](https://jlcpcb.com/help/article/pcb-assembly-price) and its limits its
[capabilities page](https://jlcpcb.com/capabilities/pcb-assembly-capabilities), read 2026-10-24 (they change; the entry
says when they were read, like a fab profile).

- **Parts**: the pieces the house buys for each line, at their price break: what the boards need, the pieces it adds
  for losses in assembly, at least the fewest it assembles from (JLCPCB's search gives both per part: C25804 adds 10
  and starts at 20).
- **Fees**, per service: setup and stencil (on both sides where the service does that), loading (JLCPCB Economic: once
  per unique Extended part, $3.07; Standard: once per unique part, Basic too, $1.53), the solder joints placed by
  machine (by the order's joint count) and those soldered by hand (through-hole pads), plus the hand-soldering labour.
  The joints and the sides are read off the placed board (`assemblyFacts`): plated pads with a drill are soldered by
  hand, a machine-placed part on the bottom needs both sides.
- **Which service takes it**: JLCPCB Economic assembles one side only, 2 to 50 boards, 2, 4 or 6 layers, chips down to
  0402; Standard both sides, up to 80,000 boards, chips down to 01005, single boards from 70 × 70 mm (a smaller one is
  priced, with the note that it needs a panel). A service that cannot take the order says why.
- **Not included**: the bare boards (JLCPCB quotes them by size, layers and options and publishes no formula; 5 two-layer
  boards up to 100 × 100 mm are $2), shipping, taxes and duties; for Standard also packing, fixtures and its per-board
  minimum on bulk orders.

The cost check then lists what would make the order cheaper, each with what it saves (counted for the cheapest service
that takes the order; savings that touch the same parts overlap):

| Saving | What it is | One click |
|---|---|---|
| cheaper | An equivalent part (the replacement rules above, with plenty of stock) costs less with its fees: a fee-free part for an Extended one, or fewer cents a piece on a large order | Use |
| merge | The part another line already has: one part number less to load | Use |
| side | Every part on the top side: a one-sided service (Economic) takes the order | Move to top |
| hand | Through-hole parts soldered by hand: leave them off the order and solder them yourself | Leave off |

Components with no part number are matched to parts too (what JLCPCB's [BOM tool](https://jlcpcb.com/parts/bom-tool)
does for an uploaded BOM): a resistor or capacitor by its value and package, anything else by its part number, ranked
by what each would add to the order (its pieces and its loading fee: a fee-free part is not the cheaper one when its
pieces cost more than the fee). The BOM tool itself is JLCPCB's way to buy a whole BOM ahead into a parts inventory;
it needs an account and has no API, so 4k7 points to it (for scarce parts) instead of calling it.

## Making it cheaper

The cost check takes what it can decide alone (a fee-free part of the same value, one part number for parts that are the
same). The rest needs to know what each part does, so it is the agent's: **Optimize cost with the agent ✦** (the cost
check's view), or asking it. The agent reads the cost guide (`design_query get_guide topic cost`,
[cost.md](cost.md)) and works with three checks:

- **The cost check** (`sourcing cost`): the order at each service, the savings, and the bare board's surcharges.
- **The values check** (`sourcing values`): for every resistor and capacitor, with a part number or without, cheaper
  ways to make its value: the same value without a fee; the nearest values without a fee below and above, and the
  values already on the order (for parts whose value may move); two parts in series or in parallel (resistors within
  1 %, capacitors in parallel within 10 %). The parts without a fee come from the house's own list for the package
  (JLCPCB has 80 Basic resistors and 33 Basic capacitors in 0603, one request each); a pair is not made with a part
  that is close enough alone, and a value that moves must save $0.50 more than the same value without a fee. Each way
  is priced for the cheapest service: its pieces, any new loading fee, two more joints per extra part. Example: a
  31.6 kΩ Extended part as 30 kΩ + 1.5 kΩ in series (−0.3 %), both Basic, saves its $3.07 loading fee less 2 cents
  of joints; a 10.2 kΩ is 5.1 kΩ + 5.1 kΩ exactly.
- **The stock check** after the changes.

Whether a value may move is the circuit's: a pull-up has a wide range, a feedback divider keeps its ratio, a decoupling
capacitor may grow, a soft-start capacitor sets a time, an inductor is never split in a power path. The guide's table
says how far each kind of part may go; the datasheet wins. The agent asks before a change the user may care about
(a brightness, a bus speed, the board's size or layers), makes the rest in one changeset and reports the total before
and after.

**The bare board** is not in the estimate, but the cost check names what makes it cost more at the house (its
`board` rules: JLCPCB's [surcharges](https://jlcpcb.com/help/article/In-what-cases-will-there-be-charged-extra), read
2026-10-25): holes below 0.3 mm (vias by the rules or placed, pad holes), a board just over the size where the
cheapest offer ends (5 two-layer boards up to 100 × 100 mm, 5 4- to 8-layer boards up to 50 × 50 mm, $2), a panel that
costs a board up to 102 × 102 mm its single-board price, the deburring fee of boards under 30 mm ($0.02 a board; under
15 mm, $0.05), boards over 650 cm². Slots and milling cost extra only past a slot density no ordinary board reaches.
The rest of the board's price (thickness, finish, colour, copper) is chosen at order time: the guide says the standard
ones cost the least.

**Other houses** later: every house has its entry and adapter, so the checks can run per house and the cost of an order
be compared. One house so far; the guide tells the agent to say what would differ, not to quote.

## Agent and user

- The agent has one tool, `sourcing` (in-app agent and Claude Code alike): `search` (by words, or a
  resistor/capacitor by kind + value + package; in-stock parts only), `lookup` (one part by number: stock, price
  breaks, datasheet link), `check` (the stock check above, with the number of boards), `cost` (the cost check) and
  `values` (the values check). Results read from a mirror
  say so. Its prompt tells it to source only when asked, to keep passives generic, to prefer fee-free parts and stock
  of at least 5 × the need, to suggest buying a scarce part ahead into the user's JLCPCB parts inventory, that unknown
  stock is not none, and to run the check before the user orders.
- The Inspector's Selection tab edits every parameter directly (no agent needed) and has a **Sourcing** section:
  type an LCSC number, or **Find on JLCPCB** with the component's value and package prefilled (in-stock parts, a "few
  left" tag where the stock is under 5 × the boards); picking a result sets `lcsc` (and the package when it differs).
  The chosen part is looked up and checked against the component: out of stock or too few for the boards, and value,
  voltage rating and package mismatches are shown, with one click to take the part's values.
- The Layout view's **Sourcing** section runs the stock check and shows its report (E: stops the order, W: wants a
  look, I: a fee) with the replacements and the order's estimate; and the cost check, with the estimate at each
  service, the savings, the bare board's surcharges, parts for the components without a number, and **Optimize cost
  with the agent ✦**.
