# Changelog

What changed in each release of 4k7, newest first. Also at [4k7.dev/changelog](https://4k7.dev/changelog); the downloads
and every pull request of a release are on its [GitHub release](https://github.com/hoihu/4k7/releases).

## Unreleased

### Schematic

- **A wire going round a part is not a detour**: the agent was told a wire "turns back on itself" wherever it formed a U, even with parts between its ends that it had to go round, and spent its time on them. It now hears only of a hump with nothing in the way, one that could run straight.
- **Remove an empty sheet**: a sheet with nothing on it has an **×** on its tab, so it no longer has to stay as a blank page in the printout. **Undo** brings it back.
- **Power symbols on neighbouring pins no longer pile up**: where a drawing leaves a part's power pins without their symbols, after a new pin layout for example, neighbouring pins on one rail now share one symbol on a short wire along the pins, as the layout draws them, and a symbol steps clear of what else stands there. On an RP2040, six symbols on one column, with a +1V1 stem along a +3V3 one that read like a short, become one of each. It shows as soon as the design opens, and nothing in the file changes until you draw something there yourself: drag the symbol, or have the agent wire the pins.
- **Optimize can fix power symbols**: the agent used to report overlapping power symbols on a part you placed as something it was not allowed to touch. It was told it could only move parts, though the kernel let it do more. It now knows that it may wire, label and erase at any pin in the area, and move power symbols.
- **A connector shows its pins' names**: an imported connector such as a USB-C receptacle now draws each pin's name in its symbol, next to the number, as an IC does. A plain numbered header or a single test point stays as it was. Names on the top or bottom run along the pins, and those pins move aside to make room; in a drawing you already have, the wires that hang only on those pins go with them, so a bar joining the grounds stays one bar.
- **A part's name and value keep off the wires**: where a sheet is drawn by the layout they now step aside by themselves when they would run into a wire, a part or a label, going side by side where a stack does not fit between two wires. **Text stays readable** now reports names and values too, so a drawing that has this shows it in the list; on a sheet you or the agent arranged nothing moves until you ask.
- **Drag a name or value to move it**: only that text moves, in steps of 25 mils, and with **Shift** its partner goes along. A click on it still selects the part.
- **The agent can fine-tune them**: `place_text` puts a part's name and value on any side, stacked or side by side, at exact spots, or with `auto` moves only what runs into something. It does this as the last step on a sheet it arranged, and it leaves the text you dragged alone.
- **A wire joins a pin from any side**: a wire along the top of a standing part now ends on its top pin, or runs on through it with a dot, instead of hopping over the pin to come down onto it. The agent can draw these straight, and a part you drag or place is wired in more places where it used to fall back to labels. Hops already in a drawing come out when it opens, unless the agent drew that wire through corners of its own: ask it to draw the wire again.
- **F mirrors every symbol**: a transistor, optocoupler, relay, TL431 or bridge is drawn turned over, where **F** used to do nothing but mark it as yours. A resistor, capacitor or diode swaps its ends where it stands, and a load drawn on a transistor swaps its ends too, where it used to slide down the page on each press. A design you pressed **F** in stays as it is drawn when you open it.
- **R turns every symbol**: a crystal, transistor, relay, IC or connector goes round by quarter turns with its pins, and four presses bring it back to exactly where it stood. A turned IC's pin names run along its pins.
- **R keeps which end of a two-pin part is which**: turning it twice gives back what was there. It used to come back with pin 1 on top, its wires drawn round to the other end.
- **Turning, mirroring and dragging are about three times faster** on a big sheet: about half a second for a small part on a design of 120 parts, about five seconds for an RP2040.
- **The agent can turn symbols and sees which way round they are**: `place_symbol rotate` does what **R** does, `get_schematic` shows `mirrored` and `rotated`, and the result says where a small symbol's pins went or that nothing changed. Asking for a crystal mirrored when it already was changed nothing and said nothing, so the agent went round it with a worse drawing. A `set_symbol` layout refused for a crystal or transistor now points at `mirror`.
- **A wire no longer stays hidden behind a part**: put a part down on a wire, by dragging it or through the agent, and the wire goes round it. Only the stretch behind the part moves, and what it connects stays connected. Wires already behind a part come out when the drawing opens. One that cannot get round, because a pin of its own lies under the part, stays until you move the part off it.
- **A wire no longer turns into labels by running over a pin** of a part drawn off the wire's grid: it now goes round that pin.
- **Move a power symbol**: drag a rail or ground symbol to another spot on its page. It stands there on a wire from the pin or wire it stood on, still pointing its own way, so you can clear it off a wire or a name. A click still selects its net. A spot on a part or on another net is refused. The agent can do the same (`move_supply`).
- **Editing a big schematic is faster still**: on a design of 120 parts, a symbol dragged is redrawn in about two thirds of the time, and **R** and **F** in about 60 %.
- **Label or wire, per net**: select a net, and its panel has a **label** row. *label · no wires* puts a label or power symbol at every pin and takes the wires away. *no label · wires* joins the pins by wires, keeping a label only where no wire can go (another page or sheet, no clear path), and a power net keeps one symbol. *automatic* draws the net afresh, wired where that is clean. The choice holds when parts move or a block is redrawn, and the agent keeps to it. As with any hand edit, the sheet then stays as drawn instead of being redrawn after every change.

### Layout

- **A part dragged is settled in a third of the time**: the board is ready again about half a second after the drop on a design of 120 parts with drawn copper, where it took a second and a half.
- **A click selects, whatever the zoom**: a hand that wobbled by one pixel on a click could move the part and add a step to undo when the board was zoomed out. Now a press only becomes a drag after a few pixels, as on the schematic.
- **⌘R reloads the page again** with a part selected, where it turned the part; **⌘L** no longer locks it either.
- **A drag that is refused goes back at once**, where it stayed where it was dropped for five seconds. The same for a silkscreen graphic and a panel's tab.
- **The errors and warnings in the header count the board's checks too**, once the board is laid. A click there opens the list they are in.

### Coding agents

- **The agent can start a design over**: ask it to, with or without some parts, and `clear_sheet` takes a sheet's parts off in one step, with their connections and constraints and what stood on them on the board; `keep` names what stays. `remove_sheet` takes an empty sheet away, and the agent now does so itself when it moves the last parts off a sheet. As with any change, you review it first, and **Undo** brings it all back.
- **The agent can describe a part's pins**: ask it to fill in or correct what the pins of a part in your design do, and it writes them on the part with `set_pin_descriptions`, no new import needed. You review them with the rest of the change; once accepted they are in the Parts view and in your library for later designs. An imported MCU's alternate functions stay. Generic parts such as a pin header take none, because one card serves all of them.
- **Chat through the Codex CLI**: OpenAI's Codex can answer the app's chat on your ChatGPT plan or API key, next to Claude Code, GitHub Copilot CLI and OpenCode. Pick it with the model button under the chat box. It gets only the 4k7 tools, like the others: no shell, no files, and your own MCP servers stay out of it. It needs Codex 0.158 or newer, and shows its answers a whole message at a time. It can also drive the app from its own chat (see the README).

## 0.4.0 — 2026-10-30

4k7 runs on Windows now: a download with Node inside, and your coding agent found and started from it. A cut through the enclosure now shows everything it goes through as solid.

### Windows

- **A Windows download**: `4k7-windows-x64.zip`, a folder with Node inside. Unpack it and double-click `4k7.cmd`: a console window shows for a moment, the app opens in your browser, and it stops when you close the tab. It is not signed yet, so Windows may warn the first time (More info → Run anyway). `npx github:hoihu/4k7` runs on Windows too.
- **Coding agents on Windows**: Claude Code and GitHub Copilot CLI are found and started whether they came from npm or as a program, with no console windows, and stopping a run stops all of it. A batch file of your own around an agent is refused, and Settings says why.
- **It is new, so tell us how it goes** on [GitHub](https://github.com/hoihu/4k7/issues): so far it has run on GitHub's Windows test machines, not on a desktop PC, and no agent has answered a real chat there. Windows on Arm has no download of its own; the x64 zip should run under emulation, untested.

### Chat and agents

- **On every system** the chat now gives your agent its rules in a file and your message on stdin, because a Windows command line has no room for them. Nothing looks different, but a script of your own around `claude` or `copilot` sees other arguments.
- **OpenCode 2 does not work yet**, on any system, as in 0.3.0: a run stops with `Agent not found`. Until that is fixed, use Claude Code, Copilot CLI or an API key.

### Enclosure

- **A cut shows everything it goes through solid**: the box, the board and the parts used to be hollow, with tracks, pads and the far side of the walls showing through. Now each is a flat face: a shade of orange per piece, so pieces that touch stay apart, tan for the board, grey for a part. Thin copper gets no face of its own. The agent's section pictures show the same.
- **A cut exactly on a face stays clean**: where the plane lay on a wall or on the board's top, at a round number on the slider, that face broke up into noise. Exactly on the board's top, pads still leave faint specks.
- **No more orange flecks on the box**: uncut, its inside glinted through at shallow angles and round the holes.

### Settings

- **The command for the Claude Code CLI** shows where the downloaded app really is. On Linux it used to show the Mac's path.

## 0.3.0 — 2026-10-30

The enclosure needs nothing installed now: the agent writes it as a script that the app runs itself. Schematics are drawn as framed functional blocks with the proper symbol for each part, and you can fix a drawing by hand. The board gets copper keep-outs, pairs routed together, length tuning and more of the checks a fab makes, and what goes to the assembly house says more: polarity marks on the silkscreen, each land held against the part the house buys, and the pick-and-place in the house's own frame.

### Opening a design from 0.2

- **Enclosures** keep their OpenSCAD script as text, and the render says it needs rewriting: ask the agent to do it.
- **SMD electrolytic capacitors** get new pads, because the old ones fit no real part. Check the copper drawn or routed to them.
- **A symbol that is drawn differently now**, such as a crystal that was a box, is made again where it stood on a sheet the agent arranged. Its connections show as labels until it is wired again or its block is redrawn. A part in your library gets its new symbol only if its card already says what it is; otherwise import it again.

### Schematic

- **Functional blocks**: the agent says which parts belong together and roughly where each block goes (`describe blocks`, `place_block`), and each block is drawn as one framed unit. The pins that connect face each other, the connections inside are wired, and only the nets that leave the block get net labels (the three sheets of one real board: 145 net labels down to 42). A block taller than a page continues on the next, and the frames show on the canvas, in the print and in the design document. A sheet without blocks is drawn as before.
- **The standard symbol for each kind of part**, not a box: crystals, polarised capacitors, inductors with their core, ferrite beads, Schottky, Zener and TVS diodes, push buttons, relays, optocouplers, fuses, thermistors, varistors, gas discharge tubes and common-mode chokes. The symbol is picked from the part's card, and `set_param` sets an inductor's `core` or a diode's `type`. Multi-line ESD arrays, solid-state relays and logic-output optocouplers stay boxes for now.
- **Fix a drawing by hand**: drag a symbol to move it (on the grid, its wires drawn again; what cannot be wired shows as labels), drag a net label round its pin, press **R** to turn a selected two-pin part or **F** to mirror an IC or connector, and **Delete** to take a clicked wire or label (or the selected parts, after asking) away. No new tools or buttons: each gesture is one of the agent's own operations, one undo step, and a part you placed stays where you put it when the agent redraws. Mirroring a connected IC can send its wires the long way round.
- **A small part placed on its own is wired, not labelled**: a resistor, capacitor, LED or other two-pin part placed with `place_symbol` is wired to the nearest pin of each of its nets when the wire is clean (no crossing, no jog, no detour, short), and connected by net labels otherwise; the result says which pins got wires and why the others did not. Two example circuits placed part by part: 16 net labels down to 11 and 15 to 11.

### Board

- **Copper keep-outs**: an area of the board where tracks, vias, pours or parts are not allowed, on all layers or the ones named: an antenna's clearance, the plane cleared under a wide pad or a coil, a no-via zone. A rectangle or a polygon, and it can be attached to a part, so the clearance moves and turns with the antenna. There are no buttons: the agent sets them (`add_keepout`, `edit_keepout`, `remove_keepout`), and its layout guides for antennas and RF connectors tell it when.
- **Everything keeps out of it**: pours and planes (inner ones too) are cut round it and the Gerber copper file shows the cleared zone; the router and the placer keep out; `draw_track`, `draw_pair` and `draw_via` refuse to enter one and say where; `DRC.KEEPOUT` finds copper or a part that is in one anyway. It is hatched in the 2D view, and listed by `get_board` and in the design document.
- **Pairs routed together**: with a differential pair's impedance rule set, the router lays the pair as two tracks side by side at the rule's width and gap, and changes layer with a via for each track. Where it cannot keep them together it routes the two nets apart and says so (the route effect, or an `IMP.PAIR` note on the board). Lines at a set impedance are routed before the other nets, which keep off the plane under them. So far this has been tried on small boards (40 × 20 mm).
- **Length tuning**: the new `tune_length` op adds a meander to a drawn track to reach a length or to match the other member of a pair (or the longest of a group): square bumps with 45° corners on the track's own layer, clear of other copper. It says the length and skew reached, and where there is no room when there is none.
- **Parts on the bottom side, end to end**: `place` (and the parts of `propose_placement` and `try_placements`) take `side: "bottom"`; nothing flips a part by itself, the agent decides. A bottom part is mirrored, its SMD pads, mask, paste, silkscreen and polarity marks are on the bottom, and its courtyard collides only with parts on the same side (through-hole parts take both). The Layout view's copper checkboxes carry each side's parts, and the agent's guide says when the bottom side pays and what it costs. The pick-and-place writes a bottom part's rotation as KiBot's notes describe JLCPCB's, not from anything JLCPCB publishes: check those parts in the order preview before your first bottom-side order.
- **A steadier placer**: moving or locking one part now moves only what the move needs. The parts that follow it go along, the parts it pushes into give way, and everything else stays exactly where it was (on the 130-part bench, six nudged small parts moved 69 others, six main parts 326; now 6 and 26). Incremental routing keeps more of its copper after a move (197 of 201 tracks instead of 168 of 207 on one bench move).
- **Congestion as a placement measure**: `get_board` and `try_placements` also report where the ratsnest wants more track than the layers carry (`congestion_mm`, `congestion_peak`). `try_placements`, `refine_placement`, the refinement in `propose_placement` and the screening in `suggest_moves` now rank by a routability score that includes it. On a 2-layer bench board the refined placement routes with 124 vias instead of 131.

### Checks

- **The schematic, the board and the BOM are checked against each other** (`XCHK.*`, in `get_diagnostics` and the Inspector): a symbol pin with no pad in the footprint, a pad no pin is on, a pin that matches its pad only in upper/lower case (the board would not connect it), a net left short of pads on the board, a `package` parameter the footprint does not follow, a part with no footprint that is then in neither the BOM nor the pick-and-place, and a mounting hole, plane, via group or drawn copper on a net the schematic no longer has. Each says what to change.
- **Panel tab zone** (`PANEL.TAB_ZONE`, `PANEL.TAB_OVERHANG`): parts, pads, tracks and vias within 1.5 mm of a tab are flagged (JLCPCB: ceramic capacitors crack where the board is snapped out), and a part over a board edge that has a tab is an error.
- **Solder-mask webs** (`DRC.FAB_MASK_WEB`) between pads of different nets that fall below the fab profile's mask bridge (JLCPCB and PCBWay: 0.1 mm), and silkscreen text lower than the fab prints (`DRC.FAB_SILK_TEXT`).
- **Etching checks**, as rules of thumb: acid traps (`DRC.ACID_TRAP`, tracks of a net meeting below 90° with an empty wedge) and necks (`DRC.NECK`, a track narrower than its net's width).
- **Thermal reliefs** are checked: `DRC.THERMAL_SPOKES` for a pad with fewer than two spokes to its pour (an error when it is cut off), `DRC.FAB_SPOKE` for spokes thinner than the fab's tracks.
- **Dead copper** was already left out of the pours; `DRC.DEAD_COPPER` (a note) now says where it was.

### Enclosure

- **Nothing to install**: the box no longer needs OpenSCAD. The agent writes it as a script that the app runs itself, in a sandbox of its own, on Manifold (the geometry engine of OpenSCAD 2025). A small box renders and is checked in a fraction of a second.
- **Round boxes, lights and lenses**: `round_extrude` rounds any outline before the cavity is cut, `dome` and `lens` make lights and lenses, and `sdf` with `smooth_union` makes forms with no straight edge.
- **What the agent is told**: a syntax error is refused when the script is set, every error gives its line, `echo` prints measures to the report, and a new warning (`ENC.NEAR`) finds a wall under 0.2 mm from a part. Mistakes that used to pass in silence stop the render, such as a helper that forgot its `return`.
- Label capitals are now exactly the size asked (they came about 4.5 % small).
- The Enclosure view downloads the script as `.js`; `board.scad` stays, for a box of your own in OpenSCAD.
- The cut goes across x, y or z. The buttons for a cut through one opening ("at J2") are gone; the agent's own pictures through each opening stay.

### Sourcing and assembly

- **Polarity marks the assembler can read**: every part that goes one way round is marked on the silkscreen by what it does: a dot by pin 1 (and a chamfered corner on bodies of 2 mm and up), a band at the cathode, a "+" at the plus terminal. The Gerbers, the 2D view and the design document show the same marks, and the old dash beside pad 1 is gone. `set_polarity` says which way round an imported part goes when its pin names do not, `DRC.POLARITY_UNKNOWN` finds a diode or LED whose pins say nothing, and `DRC.SILK_POLARITY` says what is in the way when no mark fits.
- **Each land held against the part the house buys**: the stock check lays JLCPCB's own footprint for the part on the component's land and pairs them pin by pin. A land that does not fit stops the order, with the reason in words. Eurocircuits and PCBWay keep the check by package name.
- **SMD electrolytics** (`CAP-4x5.4` to `CAP-10x10`) get V-chip lands, a pad under each lead as the makers recommend, with the outline chamfered on the + side and a 3D body of base plate and can.
- **The pick-and-place in the house's own frame**: JLCPCB counts a part's rotation from its own library's footprint, which differs from ours for many packages, and its engineers turned those parts by hand. Where the stock check has laid that footprint on the part's land, the row now gives the house's own rotation and origin; every other part keeps the board's frame.
- **Fab files check first**: exporting runs the stock check when the parts carry the house's numbers, still writes the zip, and its message names the parts that stop the order.

### Parts and datasheets

- The importer knows inductors, diodes and LEDs as categories of their own, names a polar part's terminals K/A or +/−, and is told how to name the pins of relays, optocouplers, switches and chokes.

### Licenses

- **Third-party notices ship with the app**: `THIRD-PARTY-NOTICES.txt` in the app's folder has the license of every package and font built into it, such as pdf.js, Manifold and Liberation Sans. The downloads also carry Node's own license (`LICENSE-node`, beside the Node binary).

### Fixes

- An imported fuse, ferrite bead, thermistor or choke in a supply line left the net behind it "power not driven": power now passes through them, though not across varistors or gas discharge tubes.
- Picking a part in the Inspector, or taking its values, sent JLCPCB's spelling of an electrolytic's package, which the kernel refused; it now sets the part's can.

## 0.2.0 — 2026-10-25

The chat runs on the coding agent you already use, projects are files on your computer, and the agent now takes a board from placement to the last routed connection, designs an enclosure for it, checks stock and cost at three assembly houses and lays lines at a set impedance.

### Chat and agents

- **Chat through your coding agent**: Claude Code, GitHub Copilot CLI or OpenCode, run by the local server on your own plan or company login, with only the 4k7 tools. Each of them can also import datasheets.
- **API keys for more services**: OpenAI, OpenRouter, Google Gemini, a local model (Ollama, LM Studio) or any OpenAI- or Anthropic-compatible address, beside Anthropic; one key per service (Settings → API keys).
- **The model button** under the chat box picks the agent or service and its model, with favourites (★), the effort level and web lookups. Switch in the middle of a conversation: the design stays.
- **Settings → Coding agents** shows the program each agent runs and its version, takes the path of another one, and **Look again** finds an agent installed after the server started.
- **Rebuild a schematic from a picture**: drop, paste or attach a picture or PDF of a schematic, and the agent reads it, zooming in on values and pin numbers, and rebuilds the circuit.
- **The agent sees your view**: each message says which sheet or board you are looking at and, zoomed in, the area and the parts in it, so "improve this area" needs no coordinates.
- **Keep the conversation in the project file** (opt-in, Settings → General → Conversation): every message, tool call and decision, with the attached pictures and PDFs. Earlier sessions show read-only at the top of the chat.
- Drag the edge of the chat or of the side panel to resize it.
- The chat box starts five lines tall, an empty chat just asks "What do you want to build today?", and the suggestion chips are gone.
- The offline demo is gone; a new chat starts on Claude Code.

### Projects and settings

- **Projects are files on your computer**: one `<name>.twd.json` per project in `~/Documents/4k7` (or the folder set as `"projectsDir"` in `~/.4k7/server.json`), saved as you work; imported parts, artwork and datasheets go to `~/.4k7`. What 0.1 kept in the browser becomes files the first time each browser opens this version. Without the server the header says "not saved", and the changes are written once it is back.
- **Settings shows one section at a time.** General holds the project (its file, Show folder, Save copy as…), Open… and New.
- **Notes for the agent** in your own words, sent with every request: for the schematic drawing, the board layout and the enclosure (in Settings).
- The resistor logo in the app, and browsers now show its icon.

### Schematic

- **The agent places parts and draws the sheet**: it puts symbols where it wants them (`place_symbol`), chooses a wire or a net label for each connection (`wire`, `label`, `erase`), or hands a sheet back to the automatic layout (`auto_draw`). Once it arranges a sheet, the drawing is kept and follows the netlist: removed parts leave, renamed nets follow, new parts go to a free spot, and a connection the drawing does not show gets a label, so none is ever left out.
- **The agent arranges a symbol's pins** as the datasheet draws them (`set_symbol`), and the arrangement goes back to the library part.
- Supplies point up and ground points down, always; a divider on an IC pin is one column; pull-ups stand and pull-downs hang.
- Wires stay tidy as the agent draws: no loops, no runs drawn twice, no humps beside lying parts (a 21-part buck: 144 wire segments down to 87).
- **Drawing checks** (`SCH.*`: crossings, jogs, detours, overlapping text, dangling wires…), each set to Must fix, Warn, Note or Off in Settings → Schematic drawing. ✦ Optimize judges how a drawing reads, and the agent looks once more at the drawing warnings its change brought before it finishes.

### Board

- **The agent places the board**: it decides where the main parts go and the placer arranges the small parts round them (Propose placement). `try_placements` measures 2–8 arrangements against each other (ratsnest length, crossings, board size, a trial routing) without changing the design and explores round the best one; `refine_placement` untangles the small parts.
- **Who placed what**: the parts you place are your decisions and stay where you put them; the agent's choices show dashed, yours solid. **Continue layout ✦** hands the board back to the agent.
- **Routing to completion**: the router keeps going until nothing is open (a 128-part, 2-layer board: 8 open connections down to 0), and every open connection says why (the nets in the way, the parts nearby). The agent does not hand over a board with open connections without saying why. Routing is drawn live, **Stop** keeps the best pass so far, and a routed board is saved with the project, so it opens routed.
- **Incremental routing**: after a change the copper that still holds stays, and only what is open is routed again (most small moves in 0.3–1.5 s instead of 2–7 s).
- **Drawn copper** (opt-in per project, Layout → Copper): the agent lays the tracks and vias itself, each checked as it is drawn, and a part that moves takes its tracks along. The router becomes a helper that routes the connections the agent names around its copper, and `suggest_moves` finds small part moves that close open connections.
- **Planes and vias**: split planes on inner layers (+5V across a layer, +3V3 under the MCU), local pours on the outer layers (GND only round a regulator), plane styles (gaps, thermal reliefs or solid joints), and vias placed on purpose: thermal vias in an exposed pad, stitching grids and fences, and drop vias for high-current pads, each on its own stub.
- **Lines at a set impedance**: a stack-up per board (JLCPCB and PCBWay presets, or imported from your fab's page) and impedance rules per net or differential pair; a 2D field solver works out each layer's track width and gap. The agent draws pairs side by side and fences RF lines with ground vias, and the `IMP.*` checks hold the copper to it: width, an unbroken reference plane, pair gap and skew, a ground via beside each signal via. It follows a guide for fast interfaces and RF lines.
- **STEP export** (Layout → Files): the assembled board for your mechanical CAD, with its outline, holes and the part bodies as solids, each part a component named by its designator.
- Silkscreen text from a stroke font, mirrored on the bottom side so it reads from below.
- Slotted holes and pads with several pins, in the Gerbers, the drill file, the 3D view and the STEP model.
- A part you or the agent place may go right up to the board edge, such as a USB-C connector flush with it.
- A **Dimensions** layer: the board's size and the mounting holes' positions and diameters, also drawn in the design document.
- Pads and planes follow their copper layer's colour and checkbox.
- Smooth zoom and pan in Safari (zooming a 252-part board: about 130 ms a frame down to 17 ms).
- The board actions moved from the tool bar to the side panel (Placement, Copper, Files); click a check to read its whole message.

### Enclosure (new)

- **A box for the board**, a new step after Layout: the agent agrees a brief with you, writes the box as an OpenSCAD script around the board, renders it with the OpenSCAD on your computer and fixes what the checks find (a part in the way, a blocked opening, no room under the lid, the board not held on its holes) until it is clean. Connectors know which way they are plugged from.
- **Ready to print**: one 3MF plate with every piece turned onto the bed, or an STL per piece; warnings for steep overhangs, wide ceilings, thin walls and pieces that may warp.
- **Labels and logos** on the box: engraved, raised or inlaid in a second colour, from your artwork library.
- **A cut you move through the box**, along x, y or z or across an opening, with the slider or by dragging it. The agent knows where the cut is, so "this wall is too thin" needs no coordinates.
- Enclosure notes for your printer, material and fasteners (Settings → Enclosure); hide the board to see how the box holds it; plug paths in the Layout's 3D view.

### Sourcing and cost

- **Pick the assembly house** (Layout → Sourcing): JLCPCB, Eurocircuits or PCBWay. The checks, the Inspector, the agent and the BOM in the fab files follow it.
- **Live stock from JLCPCB** itself, read by the local server; stock that is not known shows as unknown, never as 0.
- **Check stock** for the number of boards you build: what stops the order (out of stock, too few, gone, not the part the design asks for), what wants a look, the fees, and in-stock replacements one click away. At PCBWay, which buys every part for the order, **Check BOM** says what it could not buy.
- **Check cost**: the order with every assembly fee (JLCPCB's Economic and Standard assembly as a range, Eurocircuits' fees from the price table its calculator runs on, PCBWay's live quote) and the bare board's surcharges, with savings one click away.
- **Values check**: cheaper ways to make each resistor and capacitor value, such as 31.6 kΩ as 30 kΩ + 1.5 kΩ in series, both Basic parts at JLCPCB.
- **Optimize cost with the agent ✦** goes through the design part by part, following a cost guide, and asks before a change you may care about.

### Parts and datasheets

- **Design with the datasheet**: an import notes the pages with the typical application, the design procedure and the layout guidelines. The agent starts from them and cites the page each choice comes from; the Parts view links to them.
- A part with only a link to its datasheet gets the PDF downloaded on the first read.
- Imports catch a package family that contradicts the package name, and AGND, PGND, AVSS and DVSS count as grounds.

### Fixes

- GitHub Copilot in VS Code left out the `design_edit` and `read_datasheet` tools.
- Saving an imported part failed with "The object can not be cloned" once a second-pass value was picked.
- Accept and Reject could end up under the layout's tool bar.
- Datasheet text could not be read in Safari (search, page text, the pin-row highlight).
- Pours were drawn wrong: only their thermal spokes showed on free-form outlines, and on rectangular boards the clearances round tracks were filled in.
- A graphic made of many dots failed with "Maximum call stack size exceeded".
- The chat box was clipped and showed a scrollbar.

## 0.1.0 — 2026-10-11

The first release you can download: a Mac app and Linux archives from 4k7.dev, with Node inside, so there is nothing else to install.

- Describe the circuit in the chat and the agent designs it through a typed operation API; every change is a checked changeset to accept or reject, with Undo and Redo.
- The schematic draws itself onto A4, A3 or A2 pages, never splitting a functional block, with net labels that show the signal's direction and a standard title block.
- The board is placed and routed from the schematic, with a ground pour, parts on both sides, DRC, 2D and 3D views and fabrication panels with mouse bites, and exported as Gerber, drill, BOM and pick-and-place.
- Manufacturer limits for JLCPCB, PCBWay and Eurocircuits; parts from JLCPCB's catalogue with their LCSC numbers in the BOM.
- Parts from datasheet PDFs: the symbol and footprint are generated from the pin table and package the agent reads.
- A design document from the design: the functional blocks, the board in 3D, an assembly drawing, the BOM and the schematic pages.
- Chat in the app through Claude Code or with an Anthropic API key, or drive 4k7 from your agent over MCP.
