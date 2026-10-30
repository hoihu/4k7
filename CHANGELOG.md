# Changelog

What changed in each release of 4k7, newest first. Also at [4k7.dev/changelog](https://4k7.dev/changelog); the downloads
and every pull request of a release are on its [GitHub release](https://github.com/hoihu/4k7/releases).

## Unreleased

### Board

- **Parts on the bottom side, end to end**: `place` (and the parts of `propose_placement` and `try_placements`) take `side: "bottom"` or `"top"` beside `constrain layer`; nothing flips a part by itself, the agent decides. A bottom part is mirrored about its vertical axis, its SMD pads are on B.Cu, its mask, paste, silkscreen and polarity marks are the bottom ones, and its courtyard collides only with parts on the same side (through-hole parts take both). `get_board` lists the parts on the bottom (`bottom_side`). The pick-and-place now writes a bottom part in JLCPCB's way: the position as on the board, the rotation as 180° minus the counter-clockwise one, and, where the stock check held the land against the house's footprint, that footprint's own rotation and origin (mirrored); until now bottom parts kept the board's frame. The Layout view's copper checkboxes carry each side's parts (pads, silkscreen, courtyards), and the bottom copper's label counts the parts on the bottom. The agent's guide says when the bottom side pays (dense boards, a quiet side, connectors below) and what it costs (a second side at the assembly house).
- **A steadier placer**: moving or locking one part now moves only what the move needs. The parts that follow it go along, the parts it pushes into give way (a chain, each by what it must), and everything else stays exactly where it was. Before, a 1.5 mm nudge of one part moved dozens of others (on the 130-part bench, six nudged small parts moved 69 others, six main parts 326; now 6 and 26). A part the placer had to nudge clear of a neighbour is remembered where it stands, so the next move does not push it again. Incremental routing keeps more of its copper after a move (197 of 201 tracks instead of 168 of 207 on one bench move).
- **Congestion as a placement measure**: beside the ratsnest length and the crossings, `get_board` and `try_placements` now report where the ratsnest wants more track than the layers carry (`congestion_mm`, `congestion_peak`), estimated in milliseconds from the nets' boxes and the room the pads leave. On the bench it follows how many passes the router needs and how many connections it leaves open better than crossings do (rank correlation 0.5 against 0.35 for open connections); it does not predict vias, and the ratsnest stays the better guide to track length.
- **The searches use it**: `try_placements` ranks and explores by one routability score (4 × crossings + ratsnest mm + 8 × congestion mm) after open connections and placement problems, and so do `refine_placement`, `propose_placement`'s refinement and `suggest_moves`' screening. On the 2-layer, 2-cluster bench board the refined placement routes with 124 vias instead of 131, and `try_placements` finds an improvement it missed (115 vias, 1006 mm of track against 131, 1063).
- **Copper keep-outs**: an area of the board where tracks, vias, pours or parts are not allowed, on all layers or the ones named (`add_keepout`, `edit_keepout`, `remove_keepout`; no buttons, the agent sets them). For an antenna's clearance, the plane cleared under a wide pad or a coil, a no-via zone, a no-track or a no-part zone. A rectangle or a polygon, and it can be attached to a part, so the antenna's clearance moves and turns with the antenna.
- **Everything keeps out of it**: pours and planes (inner ones too) are cut round it and the Gerber copper file shows the cleared zone; the router and the placer keep out; `draw_track`, `draw_pair` and `draw_via` refuse to enter one and say where; `DRC.KEEPOUT` finds copper or a part that is in one anyway. It is not exported as artwork.
- **Seen on the board**: hatched and translucent in the 2D view with its label, listed by `get_board` and in the design document. The layout guides for antennas and RF connectors now tell the agent to use it.

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
