# 4k7

> **Alpha.** 4k7 is in alpha (0.x). The schematic side works end to end; board placement, routing and
> fabrication output work for small boards. Expect rough edges, missing parts and breaking changes to the
> project file. See the [changelog](CHANGELOG.md) and the [roadmap](docs/ARCHITECTURE.md#7-roadmap).

An **AI-first, browser-based PCB schematic and layout tool**. It has no pencil, wire or trace tools.
You describe what you want, give hints ("put V1 on the left", "make C1 100 µF"), and an AI you
choose does the design through a typed operation API. A deterministic kernel turns that intent into
geometry and checks every change.

- **Bring your own AI**: chat in the app through the coding agent you already have (Claude Code, GitHub Copilot CLI or OpenCode, on your existing plan or company login), or with an API key (Anthropic, OpenAI, OpenRouter, Gemini, a local model, any OpenAI- or Anthropic-compatible gateway). Or let your agent drive 4k7 from its own chat through the MCP server.
- **Bring your own tools**: attach any MCP server (distributor stock, company part DB, simulation…).
- **Parts from datasheets**: drop a manufacturer PDF (Parts → Import from datasheet); your agent extracts the pin table and package, the app checks it, and deterministic generators build the symbol and footprint.
- **Sourcing at JLCPCB, Eurocircuits or PCBWay** (Layout → Sourcing): parts are looked up on demand in the house's catalogue, by you in the Inspector or by the agent ("a cheap buzzer from JLC"): JLCPCB's assembly catalogue (LCSC numbers, stock as of now, price, Basic/Extended), Eurocircuits' component database (its free Generic resistors and capacitors, eC-stock and On Demand parts, obsolete parts flagged). Before you order, **Check stock** looks every part up for the number of boards you build: out of stock, too few, low stock, gone from the catalogue, obsolete, not the part the design asks for, a part that does not fit its pads (held against the house's own footprint for it), fees; with in-stock replacements one click away; exporting the fab files runs it too (at PCBWay, which buys every part for the order, **Check BOM** says what it could not buy). **Check cost** prices the order with every assembly fee: JLCPCB's Economic and Standard assembly as a range, Eurocircuits' fees from the price table its calculator runs on (in euros), PCBWay's own online quote with its special price for small orders; and lists what would make it cheaper: fee-free or cheaper equivalents (a free Generic part for an On Demand one), one part number for parts that are the same, every part on one side, the bare board's surcharges. **Optimize cost with the agent ✦** goes further, part by part by what each does: other values where a part may move, two common parts in series or parallel for an odd value (31.6 kΩ as 30 kΩ + 1.5 kΩ, both Basic), one value for parts that do the same job; the agent can compare the houses. The fab files' BOM is in the chosen house's form (JLCPCB's LCSC column, Eurocircuits' MPN column with its Generic numbers, PCBWay's template).
- **Schematic to manufacturing files**: the board is placed and routed automatically from the schematic (with a ground pour), checked by DRC, shown in 2D and 3D, and exported as Gerber, drill, BOM and pick-and-place (every part that goes one way round marked on the silkscreen: a dot by pin 1, a band at the cathode, a "+" at the plus terminal; at JLCPCB each part turned and placed as its own library's footprint, so it is not turned by hand), and as a STEP model (board and part bodies) for your mechanical CAD. Steer it in words ("make the board 30 × 20 mm", "put J1 at the left edge") or drag parts to pin them.
- **Manufacturer limits**: pick JLCPCB, PCBWay or Eurocircuits (Layout → Manufacturer) and the design rules are kept above what they can make. For another manufacturer the agent reads its capabilities page and imports the limits for you to review.
- **Lines at a set impedance**: ask for "USB at 90 Ω" or "a 50 Ω feed to the antenna" and the agent works out each layer's track width and gap from the board's stack-up (JLCPCB's and PCBWay's, or one it imports from your fab's page) with a field solver, draws differential pairs side by side at their gap, fences RF lines with ground vias, and the checks hold the copper to it: width, an unbroken plane under the line, a pair kept together and matched in length, a ground via beside each via. Copper keep-outs (an antenna's clearance, the plane cleared under a wide pad or a coil) keep tracks, vias, pours or parts out of an area, and follow a part when it moves. It follows a layout guide for fast interfaces and antennas ([high-speed](docs/design/high-speed.md)).
- **Correctness first**: every AI change is a transaction that gets validated, ERC/DRC-checked and shown as a reviewable changeset.
- **Printable by construction**: the schematic flows onto pages by itself (A4, A3 or A2). The agent groups the parts into functional blocks and says roughly where each goes; each block is drawn as one framed unit, wired inside, with net labels only for what leaves it, and is never split unless it is taller than a page. **Document** writes a design document with the functional blocks, layout, assembly drawing, BOM and schematic pages.
- **Local-first**: runs on your computer, in your browser (download from [4k7.dev](https://4k7.dev), or `npx github:hoihu/4k7`). Every project is a file on your computer (`~/Documents/4k7/<name>.twd.json`), saved as you work; your API keys stay in your browser. Opt in per project (Settings → General → **Conversation**) and the file also keeps the whole AI conversation that led to the design, attachments included.

## Running it

Download it from [4k7.dev](https://4k7.dev/#download): a `4k7.app` for the Mac (Apple silicon or Intel) or a folder for Linux,
with Node inside, so nothing else is needed. Opening it opens the app in your browser; closing the tab stops it. The Mac app is
not signed yet, so the first time macOS asks you to allow it under System Settings → Privacy & Security → Open Anyway.

Or with Node 22.18+ and npm, straight from this repository:

```sh
npx -y github:hoihu/4k7          # builds once, then serves the app at http://localhost:7777 and opens it
npm install -g github:hoihu/4k7  # or install it: `4k7pcb` (add --no-open to skip the browser)
```

Either way it runs the app and the local server in one process. The server keeps the projects as files in `~/Documents/4k7`
(change it with `"projectsDir"` in `~/.4k7/server.json` or `FOURK7_PROJECTS`) and imported parts, artwork and datasheets in
`~/.4k7`; nothing is saved while it is not running. Settings and API keys are kept by the browser for `http://localhost:7777`, so
the app always opens at that address, with an access key in the path. Projects saved in the browser by earlier versions are
moved to files the first time the app opens. Nothing is published to the npm registry; see [docs/distribution.md](docs/distribution.md).

From a checkout:

```sh
npm install
npm run dev        # http://localhost:5173 with hot reload, plus the server (prints the app's link)
npm test           # kernel + agent tests (vitest)
npm run typecheck  # tsc + svelte-check
npm run build      # static build in apps/web/dist
npm start          # build, package and run it like npx does (dist/4k7pcb.js)
node scripts/bundle.mjs  # the downloads (DMGs and Linux archives) in build/
```

## Bring your own AI

4k7 ships no model. Chat in the app through a coding agent or an API key (A, B), or drive the app from your agent's own chat (C).

### A. Coding agent (chat in the app, on your plan)

The local server runs your agent's CLI headlessly for every chat message, with only the 4k7 tools (no shell, no files):

| Agent | Runs | Notes |
|---|---|---|
| Claude Code | `claude -p` | Model: default/opus/sonnet/fable/haiku. Also imports datasheets. |
| GitHub Copilot CLI | `copilot -p` | Your Copilot plan (personal or company). Model: default, `auto` or any Copilot model. |
| OpenCode | `opencode run` | Whatever providers OpenCode is logged in to (`opencode models`), e.g. `github-copilot/…`, a company gateway, local models. |

1. Install the agent and sign in once in a terminal.
2. Start the app (`npx -y github:hoihu/4k7`, or the download) and open the link it prints.
3. Pick the agent and model with the model button under the chat box.

- Switch agents or models at any time; the design stays, a new agent starts its own session. Star models to keep them under ★.
- **Effort** (next to the model button): Claude Code and Copilot take an effort level; *Default* leaves it to the agent. Copilot models without the setting answer without it. OpenCode has no effort level, but a model variant can be typed as `provider/model#variant`.
- Turn on **Web** (next to the model button) to allow read-only web lookups (datasheets).
- The server finds the CLIs on your PATH. **Settings → Coding agents** shows which program each agent runs and its version, takes a full path to run another one (kept in `~/.4k7/server.json`), and **Look again** finds an agent installed after the server started. `FOURK7_CLAUDE_BIN`, `FOURK7_COPILOT_BIN`, `FOURK7_OPENCODE_BIN` still win over the app's choice.

### B. API key (chat in the app, billed per token)

1. **Settings → API keys**, pick the **Service**: Anthropic, OpenAI, OpenRouter, Google Gemini,
   a local model (Ollama, LM Studio), or *Other* for any OpenAI- or Anthropic-compatible API (Azure OpenAI, LiteLLM, a company gateway).
2. Check the **Address**, paste the key, press **Save**.
3. Press **Chat with …**, or pick the service and a model with the model button under the chat box (it lists the API's models; any model id can be typed).

- Keys are encrypted and stored in your browser only, one per service; sent only to that service's address.
- The app calls the API from the browser: the service must allow that (CORS). Ollama needs `OLLAMA_ORIGINS` set to the app's address.
- **Session spend** shows the cost where the model's price is known (Anthropic). Empty field + **Save** removes the key.

### C. Your agent drives the app (Claude Code, Copilot, OpenCode, any MCP client)

The agent drives 4k7 over MCP, on your existing plan. Server command (needs Node 22.18+):

```sh
npx -y github:hoihu/4k7 mcp
```

1. Register the server with your agent (below).
2. Tell the agent *"connect to 4k7"*.
3. Open the link it returns.
4. Review the agent's changes in the app as a changeset.

- One tab talks to one agent's server; always use the link the agent gives you.

#### Claude Code

```sh
claude mcp add --scope user 4k7 -- npx -y github:hoihu/4k7 mcp
claude mcp list   # 4k7: ✓ Connected
```

- From a checkout: start `claude` at the repo root and approve the `4k7` server from `.mcp.json` (run `npm run build` first).
- *failed* / *connection closed*: check `node --version` and `~/.4k7/server.log`.
- In-app chat instead: see A.
- Bedrock/Vertex or another login: set `claude.configDir` / `claude.unsetEnv` in `~/.4k7/server.json`.

#### GitHub Copilot

- VS Code (agent mode): `.vscode/mcp.json`, then *MCP: List Servers → 4k7 → Start* and tick the 4k7 tools.

  ```json
  { "servers": { "4k7": { "type": "stdio", "command": "npx", "args": ["-y", "github:hoihu/4k7", "mcp"] } } }
  ```

- CLI: same server in `~/.copilot/mcp-config.json` under `mcpServers`, with `"type": "local"` and `"tools": ["*"]`.

#### OpenCode

- Add to `opencode.json`, restart OpenCode:

  ```json
  { "mcp": { "4k7": { "type": "local", "command": ["npx", "-y", "github:hoihu/4k7", "mcp"], "enabled": true } } }
  ```

#### Other MCP clients

- Register the stdio command above. **Settings → Local server** shows it.

The server binds to `127.0.0.1` and requires the access key in `~/.4k7/server.json`.

## Documents

| Document | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview, principles, components, roadmap, risks |
| [docs/design/data-model.md](docs/design/data-model.md) | Design graph, constraints, native file format |
| [docs/design/ops-api.md](docs/design/ops-api.md) | The operation catalogue that AI, MCP and UI all use |
| [docs/design/ai-loop.md](docs/design/ai-loop.md) | Agent loop, verification loop, hints, BYO AI, MCP, relay |
| [docs/design/part-ingest.md](docs/design/part-ingest.md) | Getting from a PDF datasheet to a verified part |
| [docs/design/fab-rules.md](docs/design/fab-rules.md) | Manufacturer limits: fab profiles, presets, import by the agent, DRC |
| [docs/design/sourcing.md](docs/design/sourcing.md) | Parts from the assembly houses' catalogues (JLCPCB, Eurocircuits, PCBWay); the `lcsc` and `eurocircuits` parameters, the stock and cost checks, making it cheaper, each house's BOM |
| [docs/design/cost.md](docs/design/cost.md) | The agent's guide to making a design cheaper to make |
| [docs/design/assembly.md](docs/design/assembly.md) | What the assembly house sees: which way round each part goes and the polarity marks on the silkscreen; each part's land held against the house's own footprint for it; SMD electrolytics; the pick-and-place in the house's frame |
| [docs/design/impedance.md](docs/design/impedance.md) | Lines at a set impedance: the stack-up, the field solver, impedance rules, pairs, the IMP.* checks |
| [docs/design/high-speed.md](docs/design/high-speed.md) | The agent's guide to laying out fast interfaces and RF lines |
| [docs/design/schematic.md](docs/design/schematic.md) | The agent's guide to arranging a schematic: functional blocks, their place on the pages, what goes inside a block |
| [docs/design/ui.md](docs/design/ui.md) | UI concept: workspaces, density rules |
| [docs/distribution.md](docs/distribution.md) | How the app is run and shared: downloads, `npx github:hoihu/4k7`, the package, the port |

## Repository layout

| Path | What |
|---|---|
| `packages/schema` | Design model, part cards, zod op catalogue, results, units, agent tool definitions |
| `packages/parts` | Seed part library, deterministic symbol, footprint and 3D-body generators, standard packages, datasheet import checks |
| `packages/kernel` | Transactions, ERC + datasheet checks, constraint ledger, schematic auto-layout, board placement, autorouter + ground pour, copper DRC, changesets, canonical JSON |
| `packages/fab` | Gerber X2, Excellon drill, BOM, pick-and-place, zip |
| `packages/agent` | Agent loop with kernel verification, calculators, Anthropic and OpenAI-compatible providers |
| `apps/web` | Svelte 5 app: schematic workspace (chat + canvas + inspector), parts, settings. The kernel runs in a Web Worker |
| `tools/server` | Local server: serves the built app, MCP over stdio for your agent, headless Claude Code / Copilot CLI / OpenCode for the app chat, WebSocket to the tab, access key and origin checks. Bundled with the app into the `4k7pcb` package |
