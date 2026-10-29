# Board layout: the agent arranges and routes

> Part of the [architecture](../ARCHITECTURE.md). Status: draft, 2026-10-13. Steps 1–4 of §7 built the same day, step 5 (incremental routing) 2026-10-17.
> The schematic counterpart is [schematic-drawing.md](schematic-drawing.md); the zoom-and-optimize button is [zoom-optimize.md](zoom-optimize.md).

## 1. Why

Three things from one session, 2026-10-13:

- **"Improve the zoomed-in area" got a question back.** The user had zoomed into a corner of the
  board and asked the agent to improve it. The agent could not tell which area: a chat message
  carried the selection but not the view. It offered four guesses (the MCU area, the buck, the USB
  corner, a schematic page). A tool that cannot see what the user is looking at makes the user
  describe it.
- **Routing stopped short of done.** The router ran up to 8 passes, gave up after the first pass
  that brought no improvement, and called the board routed with connections still open (8 of 230 on
  a 128-part, 2-layer board; 2 on 4 layers), well inside its 15 s budget. A board with one open
  connection does not work, so "88 of 91 nets" is not a result. The user's call: **the goal of
  routing is 100 %. It may take longer, but then show the user something while it works.**
- **The agent had levers on placement and none on routing.** Like the schematic before
  [schematic-drawing.md §2a](schematic-drawing.md), the agent should have the authority over the
  board that a layout engineer has: where parts go, how they are turned, how the copper runs. The
  user added: *the agent can rearrange and turn components while it optimizes the layout.*

## 2. The split

| | Agent | Kernel |
|---|---|---|
| Owns | The arrangement: where each part stands and how it is turned (`place`, `lock`), board size and layers, planes, which nets are wide, when to route, and what to change when routing leaves something open | The placer for parts nobody placed, the router, pours, DRC, the measures |
| Says it as | `place` (position constraint in the ledger), `set_board`, `set_plane`, `set_net track_mm`, `constrain near/layer`, `route` | `BoardView`: parts, copper, ratsnest, open connections with their blockers, placement measures, diagnostics |
| Checked by | The measures, the open connections, a picture (`get_board_image`), the DRC | Tests, benches (`packages/kernel/bench/`) |

Placement was already the agent's: a `position` constraint pins a part and the placer never moves
it (`board.ts`, header). What changes is how it is told to use it (§4), what it can see (§3), and
that routing becomes a job the agent finishes, not a step it triggers (§5). Copper the agent draws
itself (tracks, rip-up of a net) is the next step (§7, steps 5–6).

## 3. Seeing what the user sees

Every chat message carries a `<view>` block (`packages/agent/src/view.ts`, `ViewInfo` in
`schema/scope.ts`): which view is open, and when the user has zoomed in, the area and the parts in
it.

```
<view kind="board" zoomed="yes">
zoomed in: x 12.3–31.8, y 4–19.5 mm (board coordinates, as place counts); get_board_image with area: true shows it
parts in view: C3 C4 R2 U1
cut by the edge: J1
</view>
```

The schematic gives the area per page in the coordinates `get_schematic` and `place_symbol` use
(mils from the paper's top-left corner). "This area", "here" and "what I see" refer to it; a
selection is more specific and wins. The view is captured when the message is sent, because the
agent may switch views while it works (`get_schematic_image` opens the schematic). Claude Code
driving the app from a terminal gets the live view from `get_context`.

`get_board_image` renders the 2D board as the user sees it (copper of every layer, pads, silkscreen,
the ratsnest of what is still open): the whole board, the user's area (`area: true`) or a region in
mm, e.g. round an open connection. It waits for routing.

## 4. Arranging

The guide tells the agent the arrangement is its own, and what a good one is for routing: an IC's
small parts at the pins they serve, pads facing what they connect to, signal chains in order,
ratsnest lines not crossing where they need not. Two numbers on every board, before any routing
(`BoardView.measures`, `get_board` `placement_measures`):

- **ratsnest length** (mm) of the nets routed as tracks (nets on a dedicated inner plane left out),
- **ratsnest crossings**: pairs of ratsnest lines of different nets that cross.

Lower is better. Moving or turning a part and reading the numbers again tells the agent whether it
helped, before it spends a routing run on it. A move makes the routing out of date, so the board
worker only places (fast) until the next `route`.

## 5. Routing to completion

### 5.1 The router

`router.ts` keeps its structure (coarse corridor A*, fine A* on a 0.1 mm grid, 8 directions and vias,
pours last). What changed:

- **Negotiated congestion.** After a pass that leaves connections open, each open one is probed: the
  same search, with the other nets' tracks and vias passable at a price (pads, keep-outs and the
  edge still close the way). Along the probe's path, where it crosses copper of another net, every
  later pass pays a history cost (it only grows, as in PathFinder). The nets in the way learn to go
  round; the open connection is routed first next time. The best pass wins.
- **More passes.** Up to 40, stopping when one routes everything, when 8 in a row bring no
  improvement, or at the budget (90 s, was 15 s). The pass order no longer alternates with "longest
  first": a new order every pass undid what the history costs taught.
- **Neck-down.** A power net is drawn wide where its pads allow it; a wide track that finds no way is
  tried again at the signal width. A width the user set for a net (`set_net track_mm`) is a
  requirement and never necked down.
- **Why it is open.** Each open connection says what blocks it (`RouteBlockage`): the nets whose
  copper lies across its way and where it first meets them, `enclosed` if no way exists even with all
  copper gone (pads or the edge close the pad off), or `plane` if a pad found no room for its via
  down to a dedicated plane. `BoardView.unrouted` adds the pad names and the parts within 3 mm of the
  spot: the candidates to move or turn. The diagnostic reads, from the 4-layer bench:
  `1 connection of IN510 could not be routed (U202.5 → R511.1); FB504 is in the way near R511, R105, C300.`

Benches (`packages/kernel/bench/board.ts`, 128 real parts; before → after):

| | open connections | time |
|---|---|---|
| 2 layers | 8 → **0** | 2.5 s → 2.6 s (3 passes) |
| 4 layers | 2 → 1 | 2.6 s → 15 s |

On the synthetic two-QFP bench (`bench/route.ts`, random nets) it closes 3 of 11 (2 layers) and 4 of 7
(4 layers) in about 35 s. What is left there needs a different placement, which is the agent's
part.

### 5.2 The loop

1. Arrange (§4), then `route`.
2. `get_board` waits for the router and lists every open connection: net, pads, blocking nets, the
   spot, the parts near it, and what to do next.
3. Look (`get_board_image region`), make room (move or turn the parts near the spot, move the
   blocking net's parts, more board, as a last resort 4 layers), `route` again.
4. `propose` refuses a routed board with an open connection, listing them, unless the agent gives
   `open_connections`: why it could not close them and what the user could decide. The user sees
   that text with the changeset.

### 5.3 Watching it route

The router reports the copper of the pass so far a few times a second and once at the end of each
pass (`RouteInput.onProgress`). The board worker posts it, and the Layout view draws it over the placed
board with a card: pass, connections done, elapsed time, and "best pass so far left n open; trying
again". Elsewhere in the app a header chip shows "routing 62 %" and opens the layout.

**Stop** (on the card) keeps the best pass so far. A running route cannot be told to stop (it is
one synchronous call in the board worker), so the router hands over its best result as it goes
(`RouteInput.onBest`: nothing routed before the first pass, then every pass that improves on it), the
worker posts it, and Stop ends the worker and keeps that result as the board's copper, marked
`stopped`. The board then shows it with its open connections and "Routing stopped"; the agent's
`get_board` says the user stopped it; **Route again** (the `route` op drops stopped copper) starts from
the beginning.

### 5.4 The copper is kept

The router's result is stored in the design (`BoardSettings.copper`, `StoredCopper`): tracks, vias,
pours, which pads each pad's copper joins, and the open connections with their blockers, under a key
of the placement, rules, planes and net widths. A board is routed once, not every time it is shown,
and a project opens routed. It is a cache, not a change: written by the app when the board worker
finishes (`Kernel.keepCopper`, to the working copy and to the committed design if its board is the
same), left out of the changeset diff, ignored once the key differs, and written to the file on one
line (`canonicalJson`) so it does not dominate the file or its git diffs. The buck: 13 KB → 20 KB.

Found on the way: the placement key hashed the board rules in their key order, and a design read back
from its file has them sorted, so every routed project opened as "routing out of date". Keys are now
hashed from sorted JSON (`stableJson`), which leaves the keys of designs already saved unchanged.

### 5.5 Routing incrementally

A `route` after a change keeps the copper the change did not touch and routes only what is open.
The copper kept with the design (§5.4) records what it was routed under (`StoredCopper.basis`): a
hash of the board's layers and rules, and one per net of its width, power class, current and
planes. A route for another placement hands the router that copper, less the nets whose hash
changed (`RouteInput.keep`); another board hash routes everything again. The outline is not in the
hash: an auto-sized board grows when a part moves (39 × 55 → 43 × 61 mm for a 1.5 mm move on the
bench), so the copper is checked against the edge as it is instead.

`keep.ts` decides what still holds, on exact geometry, against the board as it is now:

- a track goes where it comes too close to a pad of another net (a moved part), to a via placed on
  purpose or to the edge, a cutout or a rounded corner; a via also where it now stands in a pad or
  a small part's land pattern (the router's rules for a new via);
- then what that leaves hanging, until nothing more does: a track end must meet copper of its net
  (a pad on its layer, a via, another track on its layer), a via must join two things (a drop to
  a plane: one);
- the rest is grouped by the pads it joins; a group joining no pad goes, and one joining a single
  pad unless it is that pad's drop to its plane.

The router stamps the kept copper before anything else is routed (not into the map the probe uses:
a kept net can still be let go), joins its pads, counts its drops for the pads they serve (so
`moreDrops` does not add more), and routes the connections still open. A pass that leaves one
open lets go of the kept nets its probe names as in the way, once; if that does not close it, the
board is routed from scratch (connection order, history costs and staleness reset, as a fresh
route). Letting go net by net could run for a dozen passes, each naming the next.

Bench (`bench/board.ts 2|4 3 6`: route, then move six small parts across the board 1.5 mm each,
routing after each move, incrementally and from scratch for comparison):

| | incremental | from scratch |
|---|---|---|
| 2 layers | 0.5–1.5 s for 4 of 6 moves (1–2 passes, 385–500 of ~510 tracks kept); 3.9 s and 12.6 s for two that fell back to scratch | 2–10 s |
| 4 layers | 0.3–0.4 s for 4 of 6 moves; 2.1 s and 11.7 s for two that fell back | 1.7–10 s |

No DRC errors; one move leaves a connection open either way (the placement's, not the kept
copper's). Routing a board for the first time was unchanged (the benches' route hashes the same
before and after). `get_board` says how much was kept (`routing.incremental`).
Found on the way: `DRC.VIA_IN_PAD` measured a round pad as its square, so a via the router put
legally beside a header pin was an error.

### 5.6 Placement first

The user, after incremental routing: *the agent does not move or turn parts into better places
when the layout runs into trouble, and the trials of other arrangements show no real improvement;
placement and orientation should come first, before the agent fights with vias; resistors could
be moved a little or turned.* Three things were in the way:

- **Trials on another board.** `propose_placement` with the main parts given (what
  `try_placements` does for each option) proposed a board 1.7 times the size: when a few small
  parts stayed wedged against a main part, `settle` grew the outline by 10 %, six times, which
  moves nothing. The same main parts where they stood came back on 127 × 111 mm instead of
  74 × 69. Every option was measured on that, against the current placement on the real one.
  `settle` now moves the parts still in the way to the nearest free spot (`legalize`, as for the
  user's size) and grows the outline only if that is not enough. (The plain proposal on the
  128-part bench shrank from 74 × 69 to 67 × 62 mm; its one wedged pair had grown it too.)
- **Nobody searched.** The agent varied the main parts by hand, a few options at a time.
  `try_placements` now improves on the best option itself (`explore`, trial.ts, on by default):
  `exploreMain` (refine.ts) turns each main part by 90°, 180° and 270° round its centre, shifts it
  1 and 3 mm, and swaps two of one package or within 25 mm, each with the parts that follow it,
  keeping every change that lowers 4 × crossings + ratsnest mm; only main parts, locked parts and
  holes count as obstacles (the placer puts the small parts round them again). The changes are
  tried on a model of the ratsnest (the nets a change touches drawn again, only the lines that
  change counted against all others: thousands a second), then placed by the placer and measured
  for real, and explored again from there while that improves. The result is one more option,
  named by its changes, with its `parts` to apply.
- **Small parts stayed where the placer guessed.** `refinePlacement` (refine.ts) moves each small
  part the placer put down (2–3 pads, no connector, nobody's choice) by up to 2 mm and turns it,
  keeping the move that lowers the same cost most, a decoupling cap's distance to its pin weighed
  3 times. `propose_placement` does it with the main parts given (`refine`), `refine_placement`
  on its own (`parts`, or `near` some parts: the ones round an open connection), kept only if the
  placement as the placer then makes it measures better. From a stored placement the placer no
  longer flips two-pin parts that did not move (`flipTwoPin`), which turned refined parts back.

Six bench boards (2 and 4 layers, 1–3 clusters, 56–128 parts), each routed after placing; totals:

| | crossings | open | vias | track | routing |
|---|---|---|---|---|---|
| the placer's proposal | 1074 | 0 | 1039 | 7137 mm | 7.7 s |
| … small parts refined | 823 | 0 | 1237 | 7187 mm | 17.0 s |
| `try_placements` explored, small parts refined | 590 | 0 | 987 | 6092 mm | 5.2 s |

Refining the placer's own proposal lowers the crossings but routed no better (more vias on the
big boards: the ratsnest crossings are a weak measure of routability at that scale), so
`propose_placement` without parts does not refine by default. Explored and refined, the track is
15 % shorter and routing faster; on the 4-layer 128-part board 1539 → 1210 mm of track and 249 →
221 vias. The guide now puts placement first: the crossings are the number to get down before
planes, vias and routing, and an open connection is fixed by placement (`refine_placement near`,
a part turned or moved, `try_placements`) before anything is done to the copper.

    node --experimental-transform-types packages/kernel/bench/board.ts 4 3 place

## 6. What the agent cannot do yet

- Draw or remove a track itself, or route one net (§7 step 6).
- Optimize a zoomed area of the board with the scope guard the schematic has (`zoom-optimize.md`
  steps 3–4).
- Be told the user's taste for layouts (the schematic has notes in Settings).

## 7. Build order

Each step is useful alone.

1. **The view and the board picture** (§3). *Built 2026-10-13.*
2. **Routing to completion** (§5.1): history costs, more passes, neck-down, blockers. *Built 2026-10-13.*
3. **Open connections for the agent, the loop and the propose rule** (§4, §5.2): `BoardView.unrouted`,
   placement measures, guide text, `propose open_connections`. *Built 2026-10-13.*
4. **Progress and kept copper** (§5.3, §5.4). *Built 2026-10-13.*
5. **Incremental routing** (built 2026-10-17, §5.5). A placement change removes only the copper
   that no longer holds; `route` routes what is open with the rest in place. The arrange–route loop
   takes about a second on the 128-part bench, and it is the base for step 6.
6. **Copper ops for the agent**, as `wire`/`label`/`erase` on the schematic:
   - `route { nets?, region? }`: route only those (the rest stays as it is);
   - `unroute { nets? | parts? | region? }`: rip up;
   - `track { net, from: "U1.3", to: "C4.1", layer?, via? }`: one connection, the kernel finding the
     path through the given corners;
   - `lock_copper { nets }`: copper the router never rips up (a switching loop drawn by hand).
   The DRC and the netlist check judge the result, as on the schematic.
7. **Layout Optimize**: the ✦ Optimize button on the board ([zoom-optimize.md](zoom-optimize.md) §6
   steps 3–4): the zoomed area as a scope, `place` (move, turn) only inside it, measures before and
   after (ratsnest length and crossings, open connections, decoupling distance), then
   `route { region }` with the crossing points at the area's edge fixed.
8. **Layout notes** (built 2026-10-13): the user's words on how they want boards laid out
   (Settings → Board layout, `Settings.layoutNotes`), sent as a `<layout_notes>` block after
   `<schematic_notes>`; the guide says they win over the agent's judgement and the automatic
   choices. Notes asking for what no op can do yet are met as closely as the ops allow, and the
   agent says what is missing.
9. **Split planes** (built 2026-10-13): `set_plane` with `under` (parts: their courtyards' box
   plus `margin_mm`, default 1.5 mm, kept as component ids so it follows them) or `rect` gives a
   net a plane on part of an inner layer (`PlaneArea` in `BoardSettings.planes`, resolved to a
   rectangle in `BoardView.planes`). The layer's full plane goes round each area with the
   clearance. In the router, two pads of the net inside the area are joined through it (like a
   dedicated plane), groups with a pad inside drop onto it, and the net's other connections are
   routed as tracks. On an outer layer (2026-10-17) the same gives a local pour: it replaces the
   net's pour over that layer (F.Cu GND only round a switching regulator, as TI's layout guidelines
   ask), joins what reaches it, and gets no drop sites reserved (those are for whole-layer pours).
   `set_plane_style` (2026-10-15) shapes any plane or pour (`PlaneStyle` on its entry): `gap` round
   an area plane, the plane's own `clearance` to other nets' copper, `edge` pull-back, `thermal`
   reliefs or solid joints, `spoke` width; never below the board's own clearances. The router's
   `planeLook` reads them for the raster area and the exact shape alike.

    **Vias placed on purpose** (2026-10-17): `add_vias` / `remove_vias`, kept as `ViaGroup`s in
    `BoardSettings.vias` and resolved per placement by `planVias` (board.ts). `pad`: thermal vias,
    a grid filling one pad at the pitch (default 1 mm), on the pad's net, marked `inPad` (the
    `DRC.VIA_IN_PAD` rule passes them, whatever `via_in_pad` says) and moving with the part;
    `points`: vias at given spots. Both are copper from the start (in the board view before routing,
    in the router before anything is routed, part of the pad they lie in, so a thermal pad reaches
    every layer through them). `grid` (stitching, default 3 mm) and `fence` (round an area's edge,
    default 2 mm) are spots the router fills after the routing, where a via fits (clear of other
    nets and pads, the via spacing kept) and lies inside its net's planes or pours on two layers
    or more (any piece of that copper: a piece cut off by a track is what the via connects, as
    long as one layer's piece is connected). Grid spots stay inside the area by half a via and the
    clearance; fence spots lie on its edge. Two areas on one layer overlap like this: the smaller
    lies on top and the bigger goes round it (the later one when they are as big), so a +5V patch
    inside a local GND pour is a hole in the GND, not the other way round. Vias of a group join their planes solid (no reliefs), and so does a pad with thermal
    vias. They are vias, not footprint pads, on purpose: a drilled pad would make the part
    through-hole for the placer, the 3D view, pick-and-place and the fab hole rules. `get_board`
    `via_groups` lists each group with how many vias it got.

    **Drops sized for the current** (2026-10-17). A drop used to be one signal-width stub to one
    via per copper group, so a bulk capacitor's ground pad hung off its plane by 0.25 mm and a
    0.3 mm via. Now `padViasFor` (schema) says how many vias a pad wants: enough for the net's
    `max_current` (`viaCurrentFor`: the plated barrel as an IPC-2221 inner conductor, about 0.9 A
    for a 0.3 mm drill; the whole net's current, an upper bound for one pad), and on a supply 2
    from 2 mm² of pad, 3 from 5 mm²; never more than fit in a row along the pad's long side. The
    stubs of a supply's drops are power width where the pads take it (signal width when that finds
    no site, as a power track is necked down). After a plane's first drops, `moreDrops` gives each
    pad the rest: a straight stub out of a side of the pad (shortest, long side first, from its
    middle out, so the vias line up beside the pad), else the shortest way within 2 mm; a via of
    the net that no pad counts yet (one placed with `add_vias points` beside the pad) is joined
    rather than a new one added. `DRC.PLANE_VIAS` (drc.ts `planeViaDrc`) counts each pad's own
    vias on the copper as it lies (in the pad, or at the end of a track of its net that starts in
    it, 3 mm at most) and warns where they fall short; a pad in its net's pour on its own layer is
    left alone. The current goes into the copper key only where a net has one.

    **Asked for, not guessed** (2026-10-18). The size rule above put two vias on a bar beside
    every big supply pad: a tactile switch's GND pads and an IC's exposed pad got them, the
    latter squeezed between the pad and the pins (the user: *only stitch several vias where it is
    necessary, for higher currents*). And a net's `max_current` sized every pad of the net as if
    the whole current flowed through it, a button's GND pad included. Which pads a current flows
    through is the circuit's, not the netlist's: the agent knows it (the schematic, the datasheet),
    the kernel does not. So every pad now drops with one via, and `add_vias kind: "drop"` (`ref`,
    `pad`, `count` or `amps`, else the net's `max_current`) asks for more on one pad: the router
    lays them on a bar beside it (below; since 2026-10-23 the agent places each one, on its own
    stub), tags them with the request's group (counted in
    `via_groups`, joined to the planes solid, kept by incremental routing), and `DRC.PLANE_VIAS`
    names a pad that got fewer than asked. `get_net` lists the pads' vias and the count for the
    net's current; the guide has the agent trace the high-current paths (supply in, regulator,
    switch node and inductor, bulk and output caps, out to the loads, each ground return) and ask
    on those pads only. A bar never reaches under its part's body. Net currents no longer go into
    the router or the copper key; the drop requests do.

    **Placed by the agent, each on its own stub** (2026-10-23). The bar was the wrong reading of
    *the vias could go on a wider track*: the user (a bulk capacitor's pad with six vias on a bar
    the width of the pad, out past the courtyard): *the vias are placed on a separate thick track
    which is not necessary … the agent should place every via explicitly*. The bar was that
    thick because a via had to stay out of a small part's whole courtyard (router keep-out and
    `DRC.VIA_IN_PAD`), so the vias stood beyond its margin and the bar reached back to the pad.
    Now `add_vias kind: "drop"` takes `at`, each via's centre as the part stands, and `count`
    goes: the agent places every one. `apply` checks them against the board placed now (at
    least half a via plus the clearance off the pad's edge, so the mask stays between them; within
    2 mm of it; clear of other pads; not under a small part's body, the box round its pads; a via
    plus the clearance apart) and stores them as `offsets` from the pad's centre in the
    footprint's frame (`dropOffset`), so they move and turn with the part (`dropSpot`; mirrored
    on the bottom). `amps` (else the net's `max_current`) only checks them: the effect and
    `via_groups` say when the current wants more. `planVias` puts them in `fixed` (copper from
    the start) with one stub each (`ViaPlan.stubs`): a straight track from inside the pad (its
    round end in it) to the via, power width or narrower where the via or the pad is. The router
    stamps the stubs with the fixed vias and counts them as the pad's copper (it reaches every
    layer through them, so it gets no via of the router's); `barDrop` and `moreDrops` are gone,
    and so is joining a `points` via beside the pad. `keep.ts` takes no stub over (it is laid
    afresh). `DRC.VIA_IN_PAD` applies the courtyard rule to vias placed on purpose as the box
    round the pads, so a drop may stand in the courtyard's margin. `via_groups` lists a drop's
    vias (`at_mm`), and the guide has the agent look at each pad it gave vias with
    `get_board_image region` after routing. A drop group of an older design (a count, no spots)
    lays nothing and says to place them. What follows describes the bar it replaced.

    **On a bar, and ties** (2026-10-17). The user: *the vias could go on a smaller copper rectangle
    or a wider track rather than stitching a very large rectangle, which adds nothing; the current
    counts.* A pad that wants two or more vias (since 2026-10-18: asked for with `add_vias drop`) gets them on one bar (`barDrop`, router.ts),
    before the single drops: the vias in a row along a side of the pad (long sides first; more rows
    outwards if they do not fit along it), as close as a via may stand (out of the pad and the
    part's land pattern), and a short wide track over them that overlaps the pad's edge, along the
    whole side where that fits. A neck from the pad's centre onto the bar joins them as tracks join
    pads. Where no bar fits, the stubs of before. A via placed with `add_vias points` beside the
    pad counts towards the pad's vias and is joined as before. `DRC.PLANE_VIAS` and `keep.ts` count
    a via on a short track over the pad's edge as the pad's own.
    `add_vias kind: "tie"` carries a current across layers at one spot: `at` (one point) and
    `amps` (else the net's `max_current`; at least 2 vias, at most 16), resolved by `planVias` into
    a tight block round the spot at the closest pitch (0.8 mm for 0.6 mm vias), squarest first,
    with a ring of spare spots round it. The router lays them like grid vias but at most the
    block's count (`RouteInput.vias.limits`), and a tie also counts a layer where the via lies
    wholly on a track or pad of its net (vias on a wide track over the plane), joining that copper's
    group to the plane. A grid over a supply's copper gets a note in `via_groups` when its spots
    carry more than twice what the net draws: a tie where the current crosses does the same. The
    guide no longer suggests a grid over a regulator's output pour: the output caps' drops sized by
    `max_current` carry the current to the plane, a tie where it leaves the pour elsewhere.

10. **Who placed what, and the handoff** (built 2026-10-15). The workflow the user wants, like the
    schematic's: the agent places everything, the user moves the parts that matter to them roughly,
    the agent takes over again (planes first, then routing). For that the board has to know whose
    a placement is. `transact(tx, by)`: the app's own edits (drags, Lock, the buttons) are the
    user's, the agent's tool calls its own; `place` with `quote` (the user asked for it in chat)
    is the user's too. `BoardPart.by`, `get_board` `placed` (auto / agent / user / locked by …) and
    `user_placed` say it. The user's placements are decisions: `propose_placement` and
    `try_placements` refuse them in `parts`, `keep_choices: false` forgets only the agent's, and an
    agent `place` over one says so in its effect. In the Layout view the agent's choices are drawn
    dashed with a ring, the user's solid; **Continue layout ✦** (shown once the user placed
    something) hands the board back: keep my parts, arrange the rest, decide the planes (split or
    not, and why), route. The guide's step 3 now starts with the planes; GND stays one plane unless
    there is a reason (isolation). Placements made before this are all the user's (they cannot be
    told apart).
11. **Planning the planes** (built 2026-10-15). `get_board` `plane_plan` (`planePlan`, board.ts):
    which plane each outer layer's tracks run over (4 layers: F.Cu over In1.Cu, B.Cu over In2.Cu;
    2 layers: F.Cu over the B.Cu pour), and per supply and ground net its pins, the ICs it feeds
    (supply pins each), what carries it now (a whole layer, an area under parts, a pour, tracks),
    its box and its groups (parts within 6 mm of each other, single linkage): a rail whose parts
    form a group of their own is a candidate for an area plane under it. The guide's step 3 reads
    it before routing; GND stays whole unless there is a reason.
    A split's edge in the router: on the outer layer over an inner layer with an area plane, the
    cells along the area's edge (the gap plus 0.3 mm either side) cost signal nets 8 grid steps
    each, about two vias to cross, so a signal leaving the area changes to the other outer layer
    (over an unbroken plane) where it can. Supplies and ground do not pay. The check
    `PLANE.SPLIT_CROSSING` (warning, one per net and area, `splitDrc` in drc.ts) names the signals
    that still cross on the layer over the split; a slow one (an LED, a button) is waived.
12. **Which part belongs with which** (built 2026-10-15). The placer guessed each part's parent
    (a decoupling cap: the IC whose supply pin it takes; else the biggest part sharing a signal
    net) and the agent could not say otherwise: a connector followed the regulator it feeds, a
    bulk cap went to an IC pin. Now `attach { ref, to, pin? }` (a `belongs` ledger entry) declares
    it: at that pin (it must share a net with it; a name shared by several pins needs the number),
    or `to: null` for a part that stands on its own. The placer takes the declarations first
    (a spring to the pin, so the part is hugged there; that pin counts as taken for the guessed
    caps) and guesses the rest, never closing a circle; parents are placed before their parts
    (by depth, then size). `get_board` `belongs_to` shows `U1.12`, `U1.12 (guessed)` or `none`.
    A part the agent or the placer put somewhere goes to its new parent; one the user placed stays,
    kept relative to the new parent. `remove_constraint` goes back to the guess. The relation stays
    a mechanism (a dragged IC takes its parts along), but the agent decides it. Benches unchanged
    (2 and 4 layers: same board, tracks and vias).
13. **Next.** (a) The placer's guesses softened one by one, judged on the benches: the board
    density, the alignment snapping, the margin to the edge, satellites always at the courtyard.
    (b) Planes in try_placements (compare split or not by trial routing).

## 8. Open questions

- The budget. 90 s covers the benches; a real 300-part board may need more (the user can stop it
  and keep the best pass). With incremental routing (§5.5) a long first route matters less.
- The placer moves parts a move did not touch: a 1.5 mm move of one part on the bench nudged up
  to 20 others by 0.1–1.4 mm (the outline grew, snapping, small parts placed again). Incremental
  routing copes (a pad that moved within its own copper keeps its tracks), but a steadier placer
  would keep more copper and surprise the user less (§7 step 13a).
- A stopped routing is still routed again from scratch (`route` drops it); it could be kept as the
  start of an incremental route instead.
- A better measure of routability than crossing ratsnest lines: the router's result swings with a
  small move (one board: 211 vias placed one way, 318 refined), so a congestion estimate (where the
  nets' boxes overlap more than the board's two layers carry) may judge small-part moves better.
- Should open connections block `propose` for the in-app agent too? Today the rule is in the
  Claude Code path (`propose` is its tool); the in-app agent's turn ends with the changeset whatever
  the board says.
- History costs only grow. On boards that need hundreds of passes PathFinder also uses a present-
  congestion cost (sharing allowed, priced). Our passes forbid sharing, which keeps every pass a
  legal routing (the best pass is always usable) at the price of slower convergence.

## 9. Drawn copper (spike, 2026-10-23; follow-up the same day)

The user, after the via work of §7 step 9: *the rules are too strict and the agent cannot shape
the copper as it means to; what if the agent takes control of everything, with only the rules and
the layout notes it is given?* Time is not the constraint (30 s for a better board is fine), tokens
neither. This spike lets the two ways run side by side on one design, so they can be compared.

**The mode.** `set_copper_mode drawn` makes the copper the agent's: `BoardSettings.drawn`
(`DrawnCopper`: tracks and vias with ids `t1`, `v2`, …) is design data, in the changeset diff,
undo and the file like everything else. `keep` (default) starts from the router's copper when it
is for the placement as it is; `router` drops the drawn copper and goes back. With drawn copper
the board is always `routing: 'done'` and `BoardView.drawn` carries it. Ids go on past any a
waiver names, so a waiver of copper that is gone never covers new copper; the router's copper keeps
none of them (nor the anchors and the helper mark) when the board goes back to the router.

**The ops** (`copperops.ts`):

- `draw_track { from, to, via?, bend?, layer?, net?, width_mm? }`: one polyline, exactly as
  given. An end given as a pad (`"U1.3"`) lies on the pad's centre and is anchored (`PadAnchor`);
  an end given as a via id (`"v4"`) lies on that via and takes its net. `bend` (`diagonal_first`,
  `straight_first`) puts a 45° corner between two points that are not on one horizontal, vertical
  or 45° line, so the agent gives waypoints, not corners. Refused only for what cannot be meant: an
  unknown pad, via or net, a pad or via of another net (a short by construction), an inner layer
  that is a plane.
- `draw_via { at, net, drill_mm?, size_mm? }`: a through via.
- `edit_copper { ids, move?, via?, bend?, width_mm?, layer?, drill_mm?, size_mm? }`: changes in
  place, keeping the ids. A move shifts the tracks and vias named; the ends of other tracks on a
  moved via go along, a track end on a pad (or on a via that stays) stays and the piece next to it
  stretches.
- `erase_copper { ids? | nets? | parts? | rect? | all? }`.
- `route { nets? | from, to, width_mm?, fresh? }`: the router as a helper. It routes only those
  connections (nothing given: every open one), round the drawn copper, which it never moves; what
  it lays is added as drawn copper with ids, marked as the helper's (`by: 'helper'`, as is the
  router's copper taken over), for the agent to keep, edit (then it is the agent's) or erase.
  `fresh` first takes up the helper's copper of those nets (nothing given: all of it; for one
  connection, its whole net) and lays it again round the agent's own: for when the helper's copper
  is in the way, or should adapt to a path the agent redrew. A fresh run the user stops changes
  nothing (its best pass so far is no better than what it would take up).
- `design_query get_copper { nets?, rect? }` lists the drawn copper by id (and `by`).

**Checked at once.** What `draw_track`, `draw_via` and `edit_copper` laid, and what a move dragged
along, is checked when the transaction is applied (`annotateChecks`: the copper DRC, edge, fab
limits and the soft checks, focused on those ids, on the placement as it is; pours fill round the
copper later and never clash). The op's effect ends in `check: clear` or names the findings, so the
agent fixes a short in the next call instead of finding it in `get_board`. A track and the via it
ends on drawn in one transaction are judged together. The board's own findings name drawn copper
by id (`track t7 (SS)`) and carry the ids as entities: a soft rule can be waived per track.

**Parts and copper.** With drawn copper the placement is frozen: from the stored placement only
what is moved on purpose moves (the part placed, and rigidly the small parts that follow it); the
placer's clean-up passes (nudging followers back, flipping two-pin parts, settling overlaps,
aligning rows) do not run, so an overlap shows as a DRC error instead of moving a neighbour that
has copper on it. Switching to drawn stores the placement as shown (the stored one is not quite a
fixed point of those passes; without this the router's copper taken over came out with 2 errors).
After an op that moves parts, `followParts` moves the copper by each moved part with it: the
tracks ending on its pads, from that end as far as their points stay within 1 mm of its old
courtyard, the vias such a track ends on and, in turn, the tracks ending on those (a pad's drop, a
fanout). A track whose two ends go with parts moved alike moves whole. Where a piece runs between a
point that moved and one that did not (or moved otherwise), a corner is put back next to the point
that moved least, keeping its piece's direction, so a piece that ran at 45° does again. Joints
are kept: before the move every place where copper of one net touches is noted (a track end on
another track, as the router joins copper; a via on a track, where it changes layer mid-track; a
track end on a via), and after it what lost its contact goes back onto what it touched (a via onto
the nearest point of its track, a track end onto its via or track, the piece to it bent to 45°
where it can be). Without that, 25 random moves on the router's copper broke a signal net; with
it none (the GND pour still loses pads on that test, where the moves pile parts onto each other).
After it, a corner where a track now turns back on itself is cut and the pieces joined at 45°
(`unspike`: on the 56-part bench, 448 moves and turns leave no sharp corner, spike or self-crossing),
and a track whose ends met (a via landing on the pad it was joined to) is gone. A new part goes to
the nearest free spot (`legalize`), the others staying. A part turned over to the other side takes
nothing along (its tracks would be on the wrong layer; their ends on its pads follow the pads).
The move's effect says what followed, and the copper where a moved, turned or new part now stands
is checked with it (a part put onto a track: the op says so).

**The helper off the kernel.** A transaction with a `route` op on drawn copper is run first in a
worker of its own (`helper.worker.ts`, a copy of the working design): the kernel stays responsive
(a query answered in 9 ms while the helper searched the bench board), the Layout view shows the
copper laid so far with a Stop, and the result per route op (`RouteHelperResult`) is then handed to
the kernel's transaction (`HelperHooks.results`), which lays the same copper without routing again.
Stop hands over the best the running op had found (`stopped`, the effect says so). The results
are laid only on the working copy they were found for: the kernel counts its revisions
(`draftSnapshot`), and a transaction given results for an earlier one is refused (`STALE`); the
app then searches again on the design as it is (a drag or an undo during the search), three times
at most, then the kernel routes itself. Route requests run one after the other. The route ops of
one transaction share 40 s, well inside the server's minute for a tool call. The agent's
`design_edit` and the app's buttons both go this way (`transactEdit` in the app).

**In the Layout view.** The side panel's Copper section switches modes (the agent draws, from the
routing as it is or from scratch; back to the router after a confirm), asks the agent to draw
(✦), and lays the helper's copper again (route fresh). Its Route becomes Route open (the helper on
every open connection). Hovering a drawn track or via shows its id.

**The router as a fixed engine.** `RouteInput.drawn` hands the router the copper verbatim
(`keptCopper(…, asDrawn)`: nothing checked or dropped, pieces joining no pad included, stamped as
obstacles) and the scope it may lay copper for (`only`: nets, or pairs of pads). Out of scope it
lays nothing: no connections, no drops to planes (`mayDrop`), so the board view of drawn copper
is one pass that only fills the pours and works out connectivity. Open connections are counted
between the pieces each net's copper is in (`openBetween`), not the router's spanning tree, so a
net drawn in another order than the tree's is not reported open.

**Hard and soft rules.** Errors are hard and refuse `propose` (the app's propose checks the routed
board's errors with drawn copper; before, copper DRC errors did not block it at all): `DRC.SHORT`,
`DRC.CLEARANCE`, `DRC.EDGE_CLEARANCE` (now on straight edges too: the router never went near them,
the agent may), the fab's limits, parts off the board or overlapping, `DRC.UNROUTED` ("not drawn
yet", unless `propose open_connections` says why). Warnings are soft, the agent's judgement:
`DRAW.DANGLING` (a track end meeting no copper of its net), `DRAW.ANGLE` (a piece off 45°, the
short jog onto a pad aside), `DRC.VIA_IN_PAD` in a small part's land pattern (a via over another
net's pad is a short anyway), `DRC.PLANE_VIAS`, `PLANE.SPLIT_CROSSING`, silkscreen.

Bench (`bench/drawn.ts`, the 128-part board of `bench/board.ts`, 3 clusters):

| | router | drawn, empty | helper on everything | view after it | taken over from the router | U10 moved 0.5, 0.5 mm |
|---|---|---|---|---|---|---|
| 2 layers | 7.9 s | 0.1 s, 282 open | 8.2 s, 0 open | 0.2 s | 0.2 s, 0 errors, 0 warnings | 0.2 s: 30 tracks, 14 vias followed |
| 4 layers | 1.8 s | 0.2 s, 282 open | 1.9 s, 0 open | 0.3 s | 0.3 s, 0 errors, 0 warnings | 0.2 s: 15 tracks, 6 vias followed |

The move puts U10 and the parts that follow it into their neighbours on this dense board: the
errors after it are those overlaps and what the copper meets there, for the agent to settle.
Before the placement was frozen, the same move nudged dozens of parts and broke 250 tracks.

What to find out with it: how many tool calls and tokens a board takes when the agent draws the
critical paths and leaves the rest to the helper; whether its boards are better where the user
cares (switching loops, drops, returns); and so whether the router's machinery (§5.1–§5.5,
incremental routing, the copper cache, progress and stop) can go. Not done yet: the user cannot
draw or drag copper in the view (only the agent draws; the user moves parts), a track's middle is
not pushed aside by a part moved onto it (it is only reported), and turned-over parts leave their
copper behind.

    node --experimental-transform-types packages/kernel/bench/drawn.ts 2 3

## 10. Placement and copper hand in hand (suggest_moves, 2026-10-23)

The user: *people place and route in parallel and iterate; the rough outline (which block goes
where) stays, but single parts change while the layout goes on. The agent treats the placement as
fixed, so the simple fixes while routing are not considered.* Three reasons it did: the guide
told the story as a waterfall (placement, planes, then route as the last step, once the
arrangement is final); a placement change meant working out coordinates without seeing the
effect; and each attempt cost a routing round trip.

**Two levels.** The floorplan (the main parts: ICs, connectors, regulators; where each block sits)
is settled first and changes on purpose (try_placements compares arrangements). The detail (the
small parts round them) stays open until the copper is done. The guide now says so, in router and
drawn mode.

**The kernel finds the simple fixes** (`suggest.ts`, `design_query suggest_moves { parts? | at?,
radius_mm?, max? }`; nothing given: the parts at the first open connections). The small parts
there (two or three pads, not connectors, not locked, not the user's) are tried turned (90°, 180°,
270°), swapped with an identical part within 6 mm, and shifted 0.5 and 1 mm each way. Each try is
screened on refine.ts's ratsnest model (`screenMoves`: it must fit, and it may tangle the ratsnest
only a little: room for a path can cost some), and the best twelve are routed: a local rip-up round
the moved parts (router copper within 1 mm of where they stood, and copper of other nets their
pads now meet, taken up; drawn copper follows the part instead) and their nets routed again round
everything else, three passes. Each is measured against the same rip-up without the change (one
per set of parts), so a try counts only for what the change itself closes; with drawn copper, the
errors the moved copper makes count against it. What closes connections comes back best first,
each with the place ops to apply (and with drawn copper the route to run after). When routing
alone closes them, it says so. The app runs it in the trial worker, as try_placements.

On the 128-part bench routed for only 1.5 s (8 open connections), it tries 12 changes in 8 s and
finds "R104 0.5 mm right"; applied and routed again with the same 1.5 s, the board is complete.

Next steps, not done: offer the suggestions unasked (get_board's open connections could carry the
best one, computed in the board worker after routing); let the router try them itself when it is
stuck (with the user's parts out of bounds, reported in the effect); pin and gate swaps (two
channels of an op-amp, equivalent MCU pins), which change the schematic and need the user's say;
and blocks as areas the parts keep to (rooms).

## 11. Copper keep-outs (add_keepout, 2026-10-29)

An antenna wants nothing under or round it, a wide pad or a coil wants the plane cleared below it,
a sensitive node wants no via near. These are one thing: an area on some layers where some kinds of
things may not be. Before, the guide made do with area pours that left the zone free, and said so.

**The data** (`BoardSettings.keepouts`, `Keepout`): an id (`KO1`…), a polygon (a rectangle is four
corners; flat x, y in mm), `layers` (a list or `'all'`), `forbid` (any of `tracks`, `vias`,
`pours`, `parts`; default tracks, vias and pours) and a name for the label. With `part` the polygon
is in that part's own frame (origin at the part, the footprint as drawn, mirrored on the bottom and
turned with the part), so an antenna's clearance moves and turns with the antenna; the part itself,
and its pads, may stand in it. A keep-out whose part is gone is inert. The placement turns them into
`BoardKeepout`s on the `BoardView` (absolute corners, the layers that exist, bounds); the placement
key includes them, so a change makes the routing out of date.

**Ops** (`keepout.ts`): `add_keepout` (rect or polygon, layers, forbid, part, name), `edit_keepout`
(only the fields given; attaching or detaching changes the frame, so the area is given again),
`remove_keepout` (id or `all`). Refused with the reason: no area, both rect and polygon, fewer than
three corners, a polygon with no area or crossing itself, a layer the board does not have, an
unknown part. No buttons: the user asks, the agent adds it.

**Who honours it**

| What | How |
|---|---|
| Pours and planes (also inner planes) | `region` clears the cells in it, `planeShape` cuts the exact polygon (`ZoneCut` `poly`); islands the cut leaves are dropped as always. The Gerber writes the cut as a clear-polarity region in that layer's copper file; the keep-out itself is not artwork. |
| The router | Tracks: cells within half a track width of it are closed on its layers (the attached part's own pads stay reachable). Vias: `viaBlocked` (a via goes through every layer). Kept copper that lies in a new keep-out is not taken over (`keep.ts`). |
| Drawn copper | `draw_track`, `draw_pair` and `draw_via` are refused (`KEEPOUT_HIT`) with where and a fix hint; `edit_copper` is judged after the move (the effect's check). |
| The placer | A keep-out that holds parts off is a blocker like a cutout's box, on the sides its layers name (both outer layers: a through-hole part counts on either); the attached part is exempt; `refine_placement` and `try_placements` keep out of it too. |
| DRC.KEEPOUT (`keepoutDrc`) | Error: a track on a layer that forbids tracks, a via where vias are forbidden, a part whose courtyard lies in a zone that forbids parts. Finds kept, imported and drawn copper and locked parts; the router never makes one. |

**2D view**: hatched, translucent, dashed outline and a label (id and name, what it forbids and on
which layers), shown with the copper layers it holds on. The hatch is plain lines clipped to the area:
a pattern fill is lost in the PNG the agent looks at. The design document's board table lists them.

**Limits**: inner-layer-only keep-outs hold no parts; a polygon's bounding box is what the placer
keeps parts out of (the check is exact); the router keeps its grid's distance, not the exact one.
