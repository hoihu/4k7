# Sourcing: parts from JLCPCB's assembly catalogue

> Part of the [architecture](../ARCHITECTURE.md). Status: first slice implemented (2026-10-02).

JLCPCB assembles boards from its own stock, identified by **LCSC part numbers** (`C25804`). The
catalogue has hundreds of thousands of parts, so Tracewise never imports it. Parts are fetched
**on demand**, and two kinds of parts are treated differently:

| Kind | What happens | Why |
|---|---|---|
| Resistor, capacitor (jellybean) | The component keeps its generic part (`generic:R`). The chosen LCSC number is its `lcsc` parameter. | Nothing to verify: no pins, and the value and package already describe the part. |
| Anything with pins (IC, module, buzzer, connector) | The catalogue record gives the datasheet link; the part is imported through the [datasheet import](part-ingest.md). The component then gets its `lcsc` parameter. | Pins and footprint must be checked; the import pipeline does that. |

## The `lcsc` parameter

Every component may carry `lcsc` (see `UNIVERSAL_PARAMS` in `packages/schema/src/part.ts`): the
kernel accepts it on any card, normalises `c25804` to `C25804` and rejects anything that is not a
C-number. It is an ordinary parameter, so the agent (`set_param`), the Inspector and the ledger
treat it like a value. The board view carries it to the BOM, whose last column is `LCSC Part #`,
the column JLCPCB's assembly upload reads.

Stock and prices are **snapshots**, shown when a part is picked and never stored in the design.
When the BOM export lands in an order flow, a sourcing block (fetched-at, price breaks, tier) can
be added next to the parameter; until then the number is all a reproducible design needs.

## Tiers

JLCPCB charges a loading fee per unique **Extended** part; **Basic** and **Preferred** parts have
none. Search results are ranked Basic, Preferred, Extended, then by stock, and the `basic_only`
filter keeps the fee-free ones.

## Where the data comes from

`packages/parts/src/jlc.ts` defines a small `JlcSource` interface (`search`, `lookup`) so the
provider can be swapped. The current source is [jlcsearch.tscircuit.com](https://jlcsearch.tscircuit.com),
an open-source in-stock search over JLCPCB's catalogue with a JSON API and CORS headers, so the
**browser calls it directly** (no bridge needed, works in the hosted app):

- `/components/list.json?search=…&package=…`: text search over catalogue descriptions.
- `/resistors/list.json?resistance=<ohms>`, `/capacitors/list.json?capacitance=<farads>`: parametric.
- `/api/easyeda_components/C…`: EasyEDA's record of one part, with the datasheet link when it has one.

The app's Content Security Policy (`apps/web/index.html`, `connect-src`) allows that host; a new
source needs its host added there. A lookup by number merges the live search's stock and price into
the EasyEDA record, which lags.

There is no official public LCSC or JLCPCB API. If this mirror goes away, the adapter is the only
thing to replace; the JLCPCB part page (`https://jlcpcb.com/partdetail/C…`) is always given as the
human fallback.

## Agent and user

- The agent has one tool, `jlc_search` (in-app agent and MCP bridge alike): text or parametric
  search, or a lookup by number. Its prompt tells it to source only when asked, to keep passives
  generic, to prefer Basic parts and to offer two or three candidates when the user wants something
  cheap or available.
- The Inspector's Selection tab edits every parameter directly (no agent needed) and has a
  **Sourcing** section: type an LCSC number, or **Find on JLCPCB** with the component's value and
  package prefilled; picking a result sets `lcsc` (and the package when it differs). A typed number
  is looked up and checked against the component: value, voltage rating and package mismatches are
  shown, with one click to take the part's values.
