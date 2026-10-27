# Sourcing: parts from the assembly houses' catalogues

> Part of the [architecture](../ARCHITECTURE.md). Status: first slice 2026-10-02; live catalogue, stock check, the
> house-neutral layer, the order's cost and the cost check 2026-10-24; the values check, the board's surcharges and the
> agent's cost guide 2026-10-25; Eurocircuits and PCBWay beside JLCPCB, the house picker and each house's BOM
> 2026-10-25.

An assembly house assembles boards from parts it gets itself and knows by a number. The houses differ in where the
parts come from and what the app can read about them:

| | JLCPCB | Eurocircuits | PCBWay |
|---|---|---|---|
| Parts from | its own stock (the LCSC catalogue) | its stock (Generic and eC-stock parts) or bought for the order (On Demand) | bought for the order from distributors (Digi-Key, Mouser, Farnell, Arrow …) |
| Number on a component | `lcsc` ("C25804") | `eurocircuits` ("GPR06034K7", or an MPN); without it the component's MPN | the component's MPN; resistors and capacitors may go by value and package |
| Its catalogue gives | stock now, price breaks, class, losses and minimum | class (kept in stock or bought for the order), lifecycle, how it is placed; no counts, no prices | nothing: it keeps no catalogue the app can read |
| Assembly prices | its price page | the price table its online calculator runs on | its online quote, asked for each order |
| Currency | USD | EUR, without VAT | USD |

The catalogues have hundreds of thousands of parts, so 4k7 never imports one. Parts are fetched **on demand**, and two
kinds of parts are treated differently:

| Kind | What happens | Why |
|---|---|---|
| Resistor, capacitor (jellybean) | The component keeps its generic part (`generic:R`). The chosen part's number is the house's parameter (`lcsc`, `eurocircuits`). | Nothing to verify: no pins, and the value and package already describe the part. |
| Anything with pins (IC, module, buzzer, connector) | The catalogue record gives the datasheet link; the part is imported through the [datasheet import](part-ingest.md). The component then gets the house's number where the house has its own. | Pins and footprint must be checked; the import pipeline does that. |

## What is particular to a house

What is particular to a house lives in two places; everything else works for any house.

| Where | What |
|---|---|
| Its `AssemblyHouse` entry (`packages/schema/src/sourcing.ts`) | Name and currency; the component parameter that holds its number, if it has its own, and whether it orders by the maker's number (`byMpn`) or a resistor's value (`byValue`); its classes of parts and which cost a fee; the fee, how to keep a scarce part for an order and how sourcing works there, in words for the user and the agent; why the app cannot read its catalogue, where it cannot; its assembly services with their fees (or that they are quoted) and limits, where they were read and when, and what an estimate leaves out; its board surcharges; its special price for small orders; the part page; the number format |
| Its catalogue adapter, a `PartSource` (`search`, `lookup`, and `quote` where it prices by quote) | `packages/parts/src/jlc.ts` for JLCPCB (its own catalogue and a mirror), `eurocircuits.ts`, `pcbway.ts` |

House-neutral: the part as a catalogue lists it (`SupplierPart`), the ranking, the check of a part against its
component, the stock check with its replacements (`packages/parts/src/sourcing.ts`), the order's cost and the cost
check (`packages/parts/src/cost.ts`), the values check (`values.ts`), the agent's `sourcing` tool, the Inspector's
Sourcing section and the Layout view's checks. Another house needs its entry, its adapter, its source on the server
(`tools/server/src/sourcing.ts`), a mirror if it has one (`apps/web/src/lib/sourcing.ts`), its parameter in
`UNIVERSAL_PARAMS` if it has its own numbers, and its BOM form (`packages/fab/src/gerber.ts`).

**Which house**: the user picks it in Layout → Sourcing (kept in the settings; until they pick one, the board's
manufacturer when it assembles, else JLCPCB). The checks, the Inspector's Sourcing section and the fab files' BOM follow
it. The agent's `sourcing` tool runs for it too, unless it names another `house` (to compare houses, or when the user
names one); a check for another house answers in the chat and leaves the Layout view's reports alone.

## The part number parameters

Every component may carry `lcsc` and `eurocircuits` (see `UNIVERSAL_PARAMS` in `packages/schema/src/part.ts`): the
kernel accepts them on any card and checks each in its house's form: `lcsc` normalises `c25804` to `C25804` and rejects
anything that is not a C-number; `eurocircuits` takes a Generic number (in capitals, `GPR06034K7`) or a manufacturer
part number. They are ordinary parameters, so the agent (`set_param`), the Inspector and the ledger treat them like a
value. The board view carries them to the BOM.

At Eurocircuits a component without its `eurocircuits` number is ordered by its manufacturer part number (its part's,
or its `mpn` parameter), as Eurocircuits' BOM upload reads it: an imported IC needs nothing more. A generic resistor or
capacitor has no MPN, so it needs its Generic number (or an MPN) there. PCBWay has no numbers of its own: it buys every
part by its MPN, and a resistor or capacitor by its value, grade and package ("10k 1% 0603").

Stock and prices are **snapshots**, shown when a part is looked up and never stored in the design.

## Classes and fees

A part says its class (`tier`) and whether it costs a fee (`fee`). Results are ranked fee-free first, in the house's
order of classes, then by stock, deepest first; a part whose stock is unknown comes after the ones with a number. The
`no_fee` filter keeps the fee-free ones.

- **JLCPCB** charges a loading fee per unique **Extended** part in an order; **Basic** and **Preferred** parts have none.
- **Eurocircuits** charges €1.93 per BOM line and €3.85 per unique part, €5.50 for an **On Demand** part (bought for
  the order) instead of a **Generic** or **eC-stock** one (kept in stock): the €1.65 between them is its fee. Generic
  parts, its own resistors and capacitors under its own numbers, are free when they cost €0.02 or less, which most do
  ([generic parts](https://www.eurocircuits.com/electronic-manufacturing-technology/the-power-of-generic-parts/));
  the app prices them at nothing and says the few dearer ones are not counted.
- **PCBWay** has no classes and publishes no fees: its quote prices the order as a whole.

## Where the data comes from

The local server reads each house (none sends CORS headers, so the browser cannot): under `/api/sourcing/<house>/search`
(POST a `PartQuery`), `/api/sourcing/<house>/part/<number>` and `/api/sourcing/<house>/quote` (POST a `QuoteOrder`),
with the access key like the project files. It keeps answers for 10 minutes and runs three requests at a time, with the
browser-like user agent of the datasheet downloads: a stock check of a whole design is no more load than a person
looking the parts up. None of these is an official API or a contract: an answer in a form the adapter does not read is
an error, never an empty catalogue, and the house's part page is given as the human fallback where it has one.

1. **JLCPCB: its own catalogue.** The search behind jlcpcb.com/parts (a JSON endpoint): stock as of the call, price
   breaks, class, attributes, the datasheet link. A search asks for 100 parts in stock and ranks them; a package filter
   uses JLCPCB's package names and, when nothing has that exact name, joins the package to the words ("SOT-223" and
   "SOT-223-3"). A lookup searches for the number and keeps the exact match (the search also finds similar numbers).
   JLCPCB's [own API](https://api.jlcpcb.com/help/article/jlcpcb-online-api-available-now) is given to companies on
   application, after a review of their orders, so it is no use to an open-source app's users.
2. **JLCPCB: a mirror, when the server cannot read it** (not running, older than this, jlcpcb.com down or answering in
   another form): the browser asks [jlcsearch.tscircuit.com](https://jlcsearch.tscircuit.com) itself (its host is in
   the app's Content Security Policy, `apps/web/index.html`). Its parts say `live: false` and are shown "(mirror)".
   Its stock lags by up to a day, and most of its resistor and capacitor rows have none at all: that is **stock
   unknown**, never 0. Its copy of EasyEDA's record of a part gives the maker and the datasheet link; the stock in
   that record is LCSC's (another warehouse) and is not used. The tab keeps live answers for 10 minutes and a mirror's
   for one, so the house's own answer is back as soon as it can be read.
3. **Eurocircuits: its component database**, the search its assembly configurator runs
   (`be.eurocircuits.com/shop/assembly/searchpart.aspx`). It answers one class at a time (Generic, eC-stock, On Demand)
   or all of them; a part says its class, its maker, its lifecycle ("obsolete"), how it is placed ("smd", "SMD
   FINEPITCH", "qfn", "th"), its value fields and the supplier Eurocircuits buys it from, but no stock count and no
   price. A resistor or capacitor is searched by value and chip package as its configurator does (its value as
   "10kohm" and its package as specs, words beside them); the search also finds thermistors and arrays, so only chip
   resistors and ceramic capacitors are kept. A lookup takes a Generic number or an MPN in any case and keeps the exact
   match. The Generic parts of a package come in one request (167 resistors and 60 capacitors in 0603, E24 resistors
   at 1 %). The part page is `be.eurocircuits.com/shop/assembly/partdetail.aspx?mpn=…`.
4. **PCBWay: its online quote**, the request behind its assembly quote form (`www.pcbway.com/Quote/GetDeliveryDays/`):
   the boards, one side or both, the unique parts and, per board, the parts placed by machine, the large ICs among them
   (more than 16 joints) and the through-hole parts, for turnkey assembly of single boards. It answers the assembly's
   price for those boards, the price before its special price for small orders, and the lead time. PCBWay keeps no
   parts catalogue the app can read: it buys the parts for the order and prices them after the BOM is uploaded,
   usually within a business day; its [partner API](https://www.pcbway.com/api_cooperation.html) is given on approval.

Why not let an agent browse the sites instead: the facts are at a known address, and a plain request gets them
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
| `ok` | At least 5 × the need, or kept in the house's own stock without a count (Eurocircuits' Generic and eC-stock parts) |
| `ordered` | Bought for the order (Eurocircuits' On Demand parts): the house checks the supply when the order goes in |
| `unknown` | The source gave no number |
| `missing` | The catalogue does not list the number (gone, or a wrong number) |
| `failed` | It could not be looked up |

A part that is not what its component asks for (value, a capacitor's voltage rating, the package: the check the
Inspector makes) **stops the order** like one that cannot be had: the house assembles what the number says. So does a
part whose **land** does not fit it: where the house has a footprint for the part in its own library (JLCPCB: the
part's EasyEDA footprint), the check holds the component's pads as they lie on the board against it, and a part the
house cannot place there stops the order ([assembly](assembly.md) §3). The package's name still counts where it says
a size (an electrolytic's can, a chip size); an electrolytic's can as the catalogue lists it ("SMD,D6.3xL7.7mm") is
read as the package that fits it (CAP-6.3x7.7). So do
`out`, `short` and `missing`; `low`, `unknown` and `failed` want a look, and so does a part the maker made obsolete or
no longer recommends (Eurocircuits says so); a part with a fee is listed with the fee. Components without a number are
listed too (fine for parts soldered by hand), and what the parts cost at today's prices, without fees.

**Replacements** are searched for the lines in trouble, for obsolete parts, and for parts with a fee (to avoid it):

- A resistor or capacitor: the same value and package, there for the boards (in stock for them, or kept in stock),
  fitting the component, current, and no worse than the part it replaces: a resistor's tolerance and power, a
  capacitor's dielectric and voltage rating. When the old part is gone, the component's own tolerance and dielectric
  stand in.
- Anything else: the same part number in the same package, from another maker or listing; the agent reads its
  datasheet before switching. Where nothing like that exists, the Layout view asks the agent to find a part.

They are ranked fee-free first, then those with 5 × the need in stock (or kept in stock), then by class and stock.
**Use** sets the number on every component of the line and checks again; the agent does the same with `set_param` and
the house's parameter. Exporting the fab files runs the check first when the parts carry the house's numbers, and the
export's message names the parts that stop the order (the Sourcing section says why); where the check laid the house's
footprint on a land, the pick-and-place gives that part in the house's frame ([assembly](assembly.md) §6).

At PCBWay there is nothing to look up: the check (**Check BOM**) lists what goes on its BOM, by MPN or by value, and the
components it could not buy (no MPN, and not a resistor or capacitor).

## What the order costs

The stock check prices the order, and the **cost check** (Layout → Sourcing → Check cost, or the agent's `sourcing`
`cost`) shows how and what would make it cheaper. Both come as a range over the house's services that can take the
order, in the house's currency; each entry says where and when its prices and limits were read (they change, like a fab
profile's).

- **Parts**: the pieces the house buys for each line, at their price break: what the boards need, the pieces it adds
  for losses in assembly, at least the fewest it assembles from (JLCPCB's search gives both per part: C25804 adds 10
  and starts at 20). Eurocircuits' Generic parts are free; its other parts and all of PCBWay's are priced by the house
  when the BOM is uploaded, so they are listed as not priced.
- **JLCPCB** ([price page](https://jlcpcb.com/help/article/pcb-assembly-price), [capabilities](https://jlcpcb.com/capabilities/pcb-assembly-capabilities),
  read 2026-10-24): setup and stencil (on both sides where the service does that), loading (Economic: once per unique
  Extended part, $3.07; Standard: once per unique part, Basic too, $1.53), the solder joints placed by machine (by the
  order's joint count) and those soldered by hand (through-hole pads), plus the hand-soldering labour. Economic
  assembles one side only, 2 to 50 boards, 2, 4 or 6 layers, chips down to 0402; Standard both sides, up to 80,000
  boards, chips down to 01005, single boards from 70 × 70 mm (a smaller one is priced, with the note that it needs a
  panel). Not included: the bare boards (5 two-layer boards up to 100 × 100 mm are $2), shipping, taxes and duties; for
  Standard also packing, fixtures and its per-board minimum on bulk orders.
- **Eurocircuits** publishes no price list. Its fees are the price table its [online calculator](https://be.eurocircuits.com/shop/assembly/configurator.aspx)
  runs on (version 261001_1, read 2026-10-25), each value × its assembly factor 1.1: €55 per SMD side, €1.925 per BOM
  line, €3.85 per unique part (€5.50 On Demand), per placement and board €0.11 (SMD), €0.55 (fine pitch, BGA), €0.88
  (QFN), €1.10 (fine-pitch BGA and QFN, LGA), €0.6875 (through-hole), €22 for each kind of placement the order has,
  €0.275 per board, and €27.50 + €0.55 a board when the boards come as single boards rather than in a panel. Placement
  prices fall with the order's placements (× 0.95 above 1000, × 0.9 above 2500 …). How a part is placed is its
  database's word where it has one, else the package's (chips of 0201 and smaller and leads at 0.5 mm or less are fine
  pitch). Checked against the calculator's own quotes (20 On Demand parts, 100 placements a board, 5, 10 and 50 boards,
  and 5 with 10 through-hole parts): the same within a few cents (it rounds the price per board), less the assembly
  panel it adds (€12.70 for 5 boards of 100 × 80 mm, €25.10 for 10, which the estimate names as not counted). It assembles 1 to 50 boards ("prototypes
  and small series"), both sides, chips down to 0201, boards from 5 × 5 to 340 × 440 mm, up to 25,000 SMD and 800
  through-hole placements an order ([capabilities](https://www.eurocircuits.com/services/pcb-assembly-capabilities/));
  above 200 BOM lines or 1000 placements it prices by hand. Not included: the bare boards (its calculator prices them
  by size, layers, class and service), parts other than Generic ones, a shorter lead time than the standard one, VAT
  and shipping.
- **PCBWay** publishes no fees: its online quote is asked for the order (and for the variants the savings need: one
  side, no through-hole parts). It takes its special price off small orders ($29 for up to 20 boards with up to 200
  parts a board and 600 in the order, 100 kinds of part, 100 through-hole joints and no BGA or QFP part; a higher one,
  $88 seen, for some orders past these; [terms](https://www.pcbway.com/blog/PCB_Assembly/How_to_Get_29_PCB_Assembly_and_Meet_the_Requirements_e334dbde.html)),
  which the estimate shows with the price without it: a customer may use it once or twice a month. It assembles both
  sides, chips down to 01005, boards up to 250 × 500 mm (below 50 × 100 mm in a panel). Not included: the parts, the
  bare boards (10 two-layer boards up to 100 × 100 mm from $5, with leaded HASL), shipping, taxes and duties.

The joints, placements and sides are read off the placed board (`assemblyFacts`): plated pads with a drill are soldered
by hand, a machine-placed part on the bottom needs both sides. A service that cannot take the order says why.

The cost check then lists what would make the order cheaper, each with what it saves (counted for the cheapest service
that takes the order; savings that touch the same parts overlap):

| Saving | What it is | One click |
|---|---|---|
| cheaper | An equivalent part (the replacement rules above, with plenty of stock) costs less with its fees: a fee-free part for an Extended one at JLCPCB, a Generic one for an On Demand one at Eurocircuits (its fee, and the part free), or fewer cents a piece on a large order | Use |
| merge | The part another line already has: one part number less to load | Use |
| side | Every part on the top side: a one-sided service (JLCPCB Economic) takes the order, or the second side's fees go (Eurocircuits €55, PCBWay its quote) | Move to top |
| hand | Through-hole parts soldered by hand: leave them off the order and solder them yourself | Leave off (at JLCPCB; at a house that orders by MPN, leave them out of the BOM you upload) |

Components with no part number are matched to parts too (what JLCPCB's [BOM tool](https://jlcpcb.com/parts/bom-tool)
does for an uploaded BOM): a resistor or capacitor by its value and package, anything else by its part number, ranked
by what each would add to the order (its pieces where it has a price, and its loading or line fees: a fee-free part is
not the cheaper one when its pieces cost more than the fee). The BOM tool itself is JLCPCB's way to buy a whole BOM
ahead into a parts inventory; it needs an account and has no API, so 4k7 points to it (for scarce parts) instead of
calling it. Eurocircuits' Parts Pre-Order (PPO) does the same there.

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
  (JLCPCB has 80 Basic resistors and 33 Basic capacitors in 0603, Eurocircuits 167 Generic resistors and 60 Generic
  capacitors, one request each); a pair is not made with a part that is close enough alone, and a value that moves
  must save 0.50 more than the same value without a fee. Each way is priced for the cheapest service: its pieces, any
  new loading or line fee, two more joints or one more placement per extra part. Example at JLCPCB: a 31.6 kΩ
  Extended part as 30 kΩ + 1.5 kΩ in series (−0.3 %), both Basic, saves its $3.07 loading fee less 2 cents of
  joints; a 10.2 kΩ is 5.1 kΩ + 5.1 kΩ exactly. At Eurocircuits a second part costs a BOM line and a part fee
  (€5.78), more than the On Demand fee it saves, so a pair pays only where its parts are on the order already; a
  Generic value saves the On Demand fee and the part's own price (which the app does not know). PCBWay has no list:
  no values check there.
- **The stock check** after the changes.

Whether a value may move is the circuit's: a pull-up has a wide range, a feedback divider keeps its ratio, a decoupling
capacitor may grow, a soft-start capacitor sets a time, an inductor is never split in a power path. The guide's table
says how far each kind of part may go; the datasheet wins. The agent asks before a change the user may care about
(a brightness, a bus speed, the board's size or layers), makes the rest in one changeset and reports the total before
and after.

**The bare board** is not in the estimate, but the cost check names what makes it cost more at the house (its
`board` rules): at JLCPCB ([surcharges](https://jlcpcb.com/help/article/In-what-cases-will-there-be-charged-extra),
read 2026-10-25) holes below 0.3 mm (vias by the rules or placed, pad holes), a board just over the size where the
cheapest offer ends (5 two-layer boards up to 100 × 100 mm, 5 4- to 8-layer boards up to 50 × 50 mm, $2), a panel that
costs a board up to 102 × 102 mm its single-board price, the deburring fee of boards under 30 mm ($0.02 a board; under
15 mm, $0.05), boards over 650 cm²; at Eurocircuits ([classification](https://www.eurocircuits.com/technical-guidelines/pcb-design-guidelines/classification/))
plated holes below 0.15 mm (drill class E) and tracks or gaps below 0.125 mm (pattern classes 8 and 9); at PCBWay
([capabilities](https://www.pcbway.com/capabilities.html)) holes below 0.2 mm or above 6 mm, and a board just over its
cheapest offer (10 two-layer boards up to 100 × 100 mm, $5). The rest of the board's price (thickness, finish, colour,
copper) is chosen at order time: the guide says the standard ones cost the least.

**Comparing houses**: every house has its entry and adapter, so the agent runs the cost check for each (`house`) and
compares the totals, saying what each leaves out (JLCPCB's and Eurocircuits' bare boards, PCBWay's parts) and that
Eurocircuits' are in euros without VAT.

## The BOM

The fab files' BOM is in the form the chosen house's upload reads (`bom(board, house)` in `packages/fab/src/gerber.ts`):

| House | Columns |
|---|---|
| JLCPCB | Comment, Designator, Footprint, Quantity, MPN, Manufacturer, **LCSC Part #** |
| Eurocircuits | Reference Designators, Quantity, **MPN** (the `eurocircuits` number, Generic numbers too, else the MPN), Manufacturer, Description, Value, Package |
| PCBWay | Item #, Designator, Qty, Manufacturer, **Mfg Part #**, Description / Value, Package/Footprint, Type (SMD or Thru-hole) |

The design document's BOM has a column for each house's numbers the design has.

## Agent and user

- The agent has one tool, `sourcing` (in-app agent and Claude Code alike), for any house (`house`, default the
  user's): `search` (by words, or a resistor/capacitor by kind + value + package; parts the house can supply),
  `lookup` (one part by number: stock or how the house gets it, price breaks, lifecycle, datasheet link), `check` (the
  stock check above, with the number of boards; at PCBWay what goes on its BOM), `cost` (the cost check) and `values`
  (the values check). Results read from a mirror say so; at PCBWay search and lookup say why there is nothing to search.
  Its prompt tells it how each house works, to source only when asked, to keep passives generic, to prefer fee-free
  parts and stock of at least 5 × the need (or kept in stock), to suggest reserving a scarce part, that unknown stock
  is not none, to compare houses with `house`, and to run the check before the user orders.
- The Inspector's Selection tab edits every parameter directly (no agent needed) and has a **Sourcing** section for
  the chosen house: type its number, or **Find…** in its catalogue with the component's value and package prefilled (parts the
  house can supply, a "few left" tag where the stock is under 5 × the boards); picking a result sets the house's
  parameter (and the package when it differs). At Eurocircuits a component without a number shows that its MPN is
  ordered; at PCBWay the section says how PCBWay buys it. The chosen part is looked up and checked against the
  component: out of stock or too few for the boards, obsolete at the maker, and value, voltage rating and package
  mismatches are shown, with one click to take the part's values. Another house's number shows as a plain parameter.
- The Layout view's **Sourcing** section picks the house and runs the stock check (Check BOM at PCBWay) and shows its
  report (E: stops the order, W: wants a look, I: a fee) with the replacements and the order's estimate; and the cost
  check, with the estimate at each service, the special price where the house's quote took one, the savings, the bare
  board's surcharges, parts for the components without a number, and **Optimize cost with the agent ✦**.
