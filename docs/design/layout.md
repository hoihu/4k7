# Board layout: the agent arranges and routes

> Part of the [architecture](../ARCHITECTURE.md). Status: draft, 2026-10-13. Steps 1–4 of §7 built the same day.
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

## 6. What the agent cannot do yet

- Draw or remove a track itself, or route one net, or keep the copper that a change did not touch.
  Every `route` routes the whole board from nothing.
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
5. **Incremental routing.** Copper kept per net: a placement change removes only the copper of the
   nets whose pads moved (and copper that now clashes with a moved part); `route` routes what is open
   with the rest as fixed obstacles. The router takes existing copper as input (stamped into the
   grid, its pads joined). Makes the arrange–route loop seconds instead of a minute on a big board,
   and is the base for step 6.
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
  and keep the best pass). Once routing is incremental (step 5), a long first route matters less.
- Should open connections block `propose` for the in-app agent too? Today the rule is in the
  Claude Code path (`propose` is its tool); the in-app agent's turn ends with the changeset whatever
  the board says.
- History costs only grow. On boards that need hundreds of passes PathFinder also uses a present-
  congestion cost (sharing allowed, priced). Our passes forbid sharing, which keeps every pass a
  legal routing (the best pass is always usable) at the price of slower convergence.
