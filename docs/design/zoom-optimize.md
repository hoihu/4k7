# Zoom & Optimize

> Part of the [architecture](../ARCHITECTURE.md). Status: steps 1 and 2 (schematic) built, 2026-10-09; layout (3, 4) not started.

The user zooms into a problem area of the schematic or the board and presses **Optimize**. The
agent looks at that area only, names what is wrong with it, and proposes a fix as a normal
changeset. The zoomed rectangle is the agent's scope.

## 1. What the agent can change, per view

The kernel owns all geometry (see [ops-api.md](ops-api.md): ops are semantic, the agent never gives
coordinates for the schematic). That decides what "optimize" can mean.

| View | Levers the agent has today | Not a lever |
|---|---|---|
| **Schematic** | `constrain` left_of / right_of / above / below / near, `constrain arrangement` (diamond vs inline bridge, power_flow vs compact regulator), `set_symbol` single / units, `move_to_sheet`, `add_sheet` | Wires. They are derived by the layout from the netlist, so "re-wire" is not a drawing operation. Changing a connection (`connect`, `disconnect`) changes the circuit, which Optimize must never do |
| **Layout (board)** | `place` (x, y, rot, lock), `constrain near`, `constrain layer`, `set_board` (track widths, layers), `set_plane` | `route` is global: no scope, no per-net or per-region rip-up |

So the two views are different features behind one button:

- **Schematic Optimize** is cheap to scope and safe, but has a thin set of levers. It improves
  readability by steering the auto-layout (put the feedback divider below the IC, move a bridge
  rectifier to inline, give a crowded block a sheet of its own). It cannot hand-tidy a wire.
- **Layout Optimize** has real freedom (placement) and real value (loop areas, decoupling distance,
  routability), but it needs a scoped router before "route it differently" means anything.

## 2. The scope object

The canvas turns the visible rectangle into a scope. The kernel, not the model, resolves it.

```ts
interface OptimizeScope {
  view: 'schematic' | 'layout';
  /** Schematic: sheet id, rectangle in mils. Layout: rectangle in mm. */
  sheet?: string;
  rect: Rect;
  /** What the user asked for, if anything ("tighten this up", "too many crossings"). */
  goal?: string;
}
```

`resolveScope(view, scope)` classifies every entity:

| Class | Rule | Agent may |
|---|---|---|
| **free** | Part whose bounding box lies fully inside the rectangle (schematic: `SymbolView.bbox`; layout: `BoardPart.courtyard`) | Move it (constraint / `place`) |
| **anchored** | Part that overlaps the rectangle edge, or any part with a hard ledger constraint or a lock | Be referenced (`b` of a constraint), never moved |
| **context** | Everything else | Be read |
| **boundary nets** | Nets with pads both inside and outside the rectangle | Not be re-wired. In layout, their tracks cross the edge: the crossing points are fixed |

The agent receives this as a `<scope>` block next to `<design_state>` and `<selection>` (the same
mechanism: `formatDesignContext`, and `get_context` for Claude Code), plus a rendered picture of the
rectangle (`get_schematic_image` gains a `region`, like `read_datasheet` already has).

## 3. Enforcement (the kernel, not the prompt)

A scope is a restriction on `Kernel.transact`, set by the app for the length of one Optimize run and
cleared afterwards. Rules, checked per op before it is applied:

1. **Allowlist of ops** per view (section 1, left column). Anything else is rejected with a new
   code `OUT_OF_SCOPE` and a message naming the op. `connect`, `disconnect`, `add_part`, `remove`,
   `set_param`, `set_net`, `rename*`, `add_waiver` are never allowed.
2. **Subject must be free.** `constrain.a`, `place.ref`, `set_symbol.ref` must resolve to a free
   part. The reference `b` may be free or anchored. Rejection lists the free parts as `candidates`,
   the same way `REF_UNKNOWN` does.
3. **Netlist unchanged.** After the transaction, the nets and pin assignments of the working copy
   must equal those at the start of the run. This is a cheap structural check and the real safety
   net: whatever the model does, the circuit stays the circuit.
4. **Ripple report, not a hard stop.** The schematic flows blocks onto pages, so moving one part can
   push a later block to another page. After each transaction the kernel counts the parts *outside*
   the rectangle whose position changed and returns `ripple: n` (with the refdes list) in the result.
   The agent is told to get it to 0 and to say so if it cannot; the review card shows it.

Layout needs one more rule: `place` outside the rectangle's free parts is rejected, and a part may not
be moved so that its courtyard leaves the rectangle (otherwise "optimize" quietly rearranges the
neighbourhood).

## 4. Loop and prompt

The existing propose / verify / commit loop is unchanged ([ai-loop.md](ai-loop.md)). What is new:

- **Entry point.** A button on the canvas (and ⌘⇧O) next to the zoom indicator. It sends one chat turn
  with a fixed instruction plus the scope; the optional text field next to it fills `goal`.
- **Diagnose first.** The prompt asks for one short line before any edit: what is wrong in this
  area, or "nothing worth changing". "Nothing to improve" is a valid and cheap outcome, so a second
  press on a good area does not invent a change.
- **Measure.** The kernel computes a few numbers for the scope before and after, and the agent sees
  both: schematic: wire crossings, total wire length, labels used instead of wires, parts placed
  against signal flow; layout: ratsnest length, parts farther than the datasheet distance from the
  pin they decouple, DRC items. The review card shows the same deltas, as numbers (UI rule 6). If a
  change does not improve at least one number and worsen none, the run reports "no improvement".
- **Review.** Proposed through the normal changeset card. Nothing outside the scope is in the diff
  (section 3).
- **Providers.** Works with both the in-app agent and Claude Code through the local server, because the
  scope travels in the same context channel as the selection, and enforcement is in the kernel.

## 5. Edge cases

| Case | Behaviour |
|---|---|
| Zoom contains no free part (fully zoomed into one big IC) | Button disabled: "Zoom out to include more than one part" |
| Track leaves the rectangle (layout) | Endpoint at the edge stays; only the part inside the rectangle may be re-routed |
| The cause is outside the rectangle (a connector placed badly) | The agent answers with the diagnosis and the refdes outside the area. No edit. The user widens the zoom |
| Hard ledger constraint inside the area | The part is anchored. The agent is told why, and may suggest removing the constraint in its reply |
| Pending changeset exists | Optimize builds on it, like any new chat message, and replaces its card |
| Two presses | The second sees the committed result, and normally answers "nothing to improve" |
| Sheet with several pages | The scope is within one page's rectangle, or crosses a page boundary: allowed, but ripple is checked on both |

## 6. Build order

1. **Scope plumbing (shared).** `OptimizeScope` in `schema`, `resolveScope` and the `transact`
   guard in `kernel` with the netlist-unchanged check and ripple count, tests in
   `packages/kernel/test/scope.test.ts`.
2. **Schematic Optimize.** Visible-rectangle readout in `SchematicCanvas` (it already tracks `vb`),
   the button, scope into `formatDesignContext` / `get_context`, `region` on `get_schematic_image`,
   the measures, prompt text.
3. **Layout Optimize (placement).** The same button in `BoardCanvas`; `place` in scope. Measures are
   ratsnest length and decoupling distance.
4. **Scoped routing.** `route({ region })` in `router.ts`: keep tracks outside the region, rip up and
   re-route those inside, with the crossing points as fixed terminals. This is the only step that
   needs new solver work, and it is what makes "route it differently" real.

## 7. As built (schematic)

- `packages/schema/src/scope.ts`: `OptimizeScope`, `ScopeInfo`, `ScopeMeasures`, `ScopeOutcome`; rejection code `OUT_OF_SCOPE`; `TransactionResult.scope`.
- `packages/kernel/src/scope.ts`: `resolveScope`, `guardOp`, `circuitSignature`, `measure`, `ripple`. `Kernel.setScope` turns the guard on until `setScope(null)`.
- Measures are taken over the nets that touch the area's movable parts (not over the rectangle), so they stay meaningful after parts move: wire crossings, bends, jogs, detours, overlaps, wire length, net labels.
- The shape measures (2026-10-12) are there because a correct drawing can still read badly, and without them the agent saw nothing to do. A divider drawn as two columns side by side had no crossings and short wires. **Bends** are corners where two wires meet at a right angle (no pin, no T). **Jogs** are pins facing down (or right) at pins facing them on the same wire with none in line, so the wire steps across. **Detours** are U-turns whose sideways run has nothing attached (a ground bus turning up at both ends is not one). Which way a pin faces comes from the edge of the symbol's box it sits on, because rotated parts keep their unrotated `side`.
- **Overlaps** counts supply symbols and labels of the area's nets that run into a wire of another net, another label or a part's body. They are measured with the shapes the canvas draws (stub, stem, arrow and name), not the room the layout keeps for them. A zoom onto a TPS40222 showed why: the VIN and AVIN rail symbols on PVIN and AVIN stood upright across the FB and SW wires above them. Every other measure was 0, and the agent could see the problem but not fix it, because those symbols are drawn as part of a label, not as wires. The layout keeps such a symbol upright (rails up, ground down, always: [schematic-rules.md](schematic-rules.md) SCH.RAIL_UP) and lengthens its stem (`LabelView.rise`) so the arrow or the bars clear the farthest lead it crosses; the crossing itself is accepted, and a stem merely crossing a wire does not count as an overlap (a stem *along* a wire does). Two rails whose arrows would end at one height are staggered so their names do not touch, and the IC's name moves to a clear corner when a symbol would run through it (`clearName`). A rail at the bottom of a hanging part (or a ground at the top) goes on past the part and turns aside before the symbol (`leadEnd`), and a part between two rails lies flat with both arrows up.
- `SCH.*` diagnostics (2026-10-12, `packages/kernel/src/schcheck.ts`) report the measures' findings as diagnostics with the ruleset's levels ([schematic-rules.md](schematic-rules.md)): the jog's two parts, the detour's segment, the overlapping label and what it hits, crossings per net; Optimize fixes those inside the area first.
- Ripple ignores a page that shifted as a whole (the layout centres each page's drawing): per baseline page, the most common displacement among outside parts counts as the shift.
- `packages/agent/src/optimize.ts`: the `<scope>` block and the run's prompt. The prompt is the user turn, so the cached system prompt only gained one line. Works for the in-app agent and Claude Code (via `get_context`; `get_schematic_image` takes `area: true`).
- UI: `✦ Optimize` in the sheet toolbar, a dashed frame on the canvas while the agent works, and text in the chat box is used as the goal.
- Known limit: a regulator block is drawn from a datasheet template, so placement constraints on its satellites change nothing (the measures show it). The agent is told to report "nothing to improve" then. More `arrangement` kinds in `layout.ts` would give it more to work with.

## 8. Wire tidy (the layout's own drawing)

The agent has no lever on wires: the layout draws them. A zoom onto a rail showed it: the regulator
input bus ran 100 mils past the last capacitor and ended in the supply symbol, so the rail went
along, turned, and up. `packages/kernel/src/tidy.ts` (`tidyWires`, run before `addJunctions`) moves
a supply symbol standing on such a stub onto the last junction or pin of its wire, and drops a
junction dot that stops being a T. It never moves a symbol that ends a real corner (another wire
attached), or one whose new place is taken by a part or another supply symbol. Connections do not
change. On the 74-part example project it moves 4 of 31 supply symbols.

Next candidates for the same pass, each needing its own rule: detours (a wire that leaves and
returns to the same side), dead-end stubs, buses whose topology is longer than a tree needs. For
choices the pass cannot make (net label or wire, where a rail symbol belongs) the agent would set
soft drawing hints that the layout honours, the same way it sets placement constraints.

## 9. Open questions

- The wider plan for the agent's levers on the drawing (an editable ruleset, drawing hints, placement / supplies / connections as three steps) is in [schematic-drawing.md](schematic-drawing.md). Optimize becomes those steps for the parts inside the area.

- Is the schematic's lever set (constraints only) enough to make the button worth pressing there? If
  the layout often ignores a constraint because it cannot satisfy it, the answer is more
  arrangement kinds in `layout.ts`, not a smarter agent.
- Should Optimize in the schematic be allowed to `move_to_sheet`? It changes the document structure,
  so I would keep it out until asked for.
- Show the scope rectangle on the canvas while the agent works (a dashed frame, like `selbox`)?
  Probably yes: it makes the restriction visible.
