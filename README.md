# 4k7

> **Alpha.** 4k7 is in alpha (0.1.x). The schematic side works end to end; board placement, routing and
> fabrication output work for small boards. Expect rough edges, missing parts and breaking changes to the
> project file. See the [roadmap](docs/ARCHITECTURE.md#7-roadmap).

An **AI-first, browser-based PCB schematic and layout tool**. It has no pencil, wire or trace tools.
You describe what you want, give hints ("put V1 on the left", "make C1 100 µF"), and an AI you
choose does the design through a typed operation API. A deterministic kernel turns that intent into
geometry and checks every change.

- **Bring your own AI**: the coding agent you already have (Claude Code, GitHub Copilot, OpenCode or any other MCP client) drives 4k7 through its MCP server, on your existing plan. Or add an Anthropic API key and chat in the app.
- **Bring your own tools**: attach any MCP server (distributor stock, company part DB, simulation…).
- **Parts from datasheets**: drop a manufacturer PDF (Parts → Import from datasheet); your agent extracts the pin table and package, the app checks it, and deterministic generators build the symbol and footprint.
- **Sourcing from JLCPCB**: parts are fetched on demand from JLCPCB's assembly catalogue (LCSC numbers, stock, price, Basic/Extended), by you in the Inspector or by the agent ("a cheap buzzer from JLC"). The BOM carries the LCSC column JLCPCB reads.
- **Schematic to manufacturing files**: the board is placed and routed automatically from the schematic (with a ground pour), checked by DRC, shown in 2D and 3D, and exported as Gerber, drill, BOM and pick-and-place. Steer it in words ("make the board 30 × 20 mm", "put J1 at the left edge") or drag parts to pin them.
- **Manufacturer limits**: pick JLCPCB, PCBWay or Eurocircuits (Layout → Manufacturer) and the design rules are kept above what they can make. For another manufacturer the agent reads its capabilities page and imports the limits for you to review.
- **Correctness first**: every AI change is a transaction that gets validated, ERC/DRC-checked and shown as a reviewable changeset.
- **Printable by construction**: the schematic flows onto pages by itself (A4, A3 or A2), never splitting a functional block. **Document** writes a design document with the functional blocks, layout, assembly drawing, BOM and schematic pages.
- **Local-first**: runs on your computer, in your browser (download from [4k7.dev](https://4k7.dev), or `npx github:hoihu/4k7`). Your designs and API keys stay on your machine.

## Running it

Download it from [4k7.dev](https://4k7.dev/#download): a `4k7.app` for the Mac (Apple silicon or Intel) or a folder for Linux,
with Node inside, so nothing else is needed. Opening it opens the app in your browser; closing the tab stops it. The Mac app is
not signed yet, so the first time macOS asks you to allow it under System Settings → Privacy & Security → Open Anyway.

Or with Node 22.18+ and npm, straight from this repository:

```sh
npx -y github:hoihu/4k7          # builds once, then serves the app at http://localhost:7777 and opens it
npm install -g github:hoihu/4k7  # or install it: `4k7pcb` (add --no-open to skip the browser)
```

Either way it runs the app and the local server in one process. Designs are kept by the browser for `http://localhost:7777`, so the app
always opens at that address, with an access key in the path. Nothing is published to the npm registry; see [docs/distribution.md](docs/distribution.md).

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

Without an AI the app runs an **offline demo** (a scripted agent that goes through the real kernel):
try “12 V to 3.3 V buck, 2 A. Put C1 left of U1.”, answer the question, review the changeset, then “make C2 100uF”.

## Bring your own AI

4k7 does not ship a model. Three ways to connect one:

**Your coding agent, via MCP.** The local server is an MCP server over stdio. Register it with the agent you use,
ask the agent to *“connect to 4k7”*, and open the link it answers with: that link connects the app to the agent's
server. The command is the same for all of them:

```sh
npx -y github:hoihu/4k7 mcp                        # or, from a checkout (Node 22.18 or newer):
node /absolute/path/to/this/repo/tools/server/src/main.ts
```

- **Claude Code**: `claude mcp add --scope user 4k7 -- npx -y github:hoihu/4k7 mcp`, or start `claude` in this repository and approve the `4k7` server from `.mcp.json`.
- **GitHub Copilot in VS Code** (agent mode): put this in `.vscode/mcp.json` of the workspace, or run *MCP: Add Server*
  from the command palette for all workspaces. Then *MCP: List Servers → 4k7 → Start*, and tick the 4k7 tools in the
  chat's tool picker.

  ```json
  { "servers": { "4k7": { "type": "stdio", "command": "npx", "args": ["-y", "github:hoihu/4k7", "mcp"] } } }
  ```

- **GitHub Copilot CLI**: the same server in `~/.copilot/mcp-config.json`, under `mcpServers` with `"type": "local"`
  and `"tools": ["*"]`.
- **OpenCode**: add it under `mcp` in `opencode.json`.
- Any other MCP client works the same way. Settings → Local server in the app shows the command to paste.

Each agent runs its own copy of the server, and a tab talks to one of them at a time, so open the link the agent gives
you rather than reusing a tab opened by another agent. The link always goes to `http://localhost:7777` (your designs
live there), with `?port=` when the agent's server runs on another port.

The agent works through `get_context`, `design_query`, `design_edit`, `calc`, `get_schematic_image`, `propose` and
`wait_for_review`, and its changes arrive in the app as a changeset for you to review. `propose` is refused while the
design has open errors.

**Chat in the app with Claude Code.** If `claude` is installed, choose **Settings → AI provider → Claude Code on this
computer**. Messages you type in the app's chat are answered by `claude -p` running headlessly with **only** the 4k7 tools
(no shell, files or web), on your existing plan. To let it look up datasheets, enable **Settings → Web** (read-only
WebSearch/WebFetch). In-app chat for other agents is on the roadmap.

If your shell routes Claude Code to Bedrock/Vertex or a different login, put the same in `~/.4k7/server.json`
(`FOURK7_CLAUDE_CONFIG_DIR` / `FOURK7_CLAUDE_UNSET` / `FOURK7_CLAUDE_BIN` override it):

```json
{
  "claude": {
    "configDir": "~/.claude-personal",
    "unsetEnv": ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]
  }
}
```

**Chat in the app with an API key.** Add an Anthropic API key in **Settings**. It is encrypted in your browser and sent
only to `api.anthropic.com`. Other API providers are on the roadmap.

The server binds to `127.0.0.1`, serves the page only at that address and needs the access key (kept in
`~/.4k7/server.json`) before anything is forwarded.

## Documents

| Document | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview, principles, components, roadmap, risks |
| [docs/design/data-model.md](docs/design/data-model.md) | Design graph, constraints, native file format |
| [docs/design/ops-api.md](docs/design/ops-api.md) | The operation catalogue that AI, MCP and UI all use |
| [docs/design/ai-loop.md](docs/design/ai-loop.md) | Agent loop, verification loop, hints, BYO AI, MCP, relay |
| [docs/design/part-ingest.md](docs/design/part-ingest.md) | Getting from a PDF datasheet to a verified part |
| [docs/design/fab-rules.md](docs/design/fab-rules.md) | Manufacturer limits: fab profiles, presets, import by the agent, DRC |
| [docs/design/sourcing.md](docs/design/sourcing.md) | Parts from JLCPCB's assembly catalogue; the `lcsc` parameter and the BOM |
| [docs/design/ui.md](docs/design/ui.md) | UI concept: workspaces, density rules |
| [docs/distribution.md](docs/distribution.md) | How the app is run and shared: downloads, `npx github:hoihu/4k7`, the package, the port |

## Repository layout

| Path | What |
|---|---|
| `packages/schema` | Design model, part cards, zod op catalogue, results, units, agent tool definitions |
| `packages/parts` | Seed part library, deterministic symbol, footprint and 3D-body generators, standard packages, datasheet import checks |
| `packages/kernel` | Transactions, ERC + datasheet checks, constraint ledger, schematic auto-layout, board placement, autorouter + ground pour, copper DRC, changesets, canonical JSON |
| `packages/fab` | Gerber X2, Excellon drill, BOM, pick-and-place, zip |
| `packages/agent` | Agent loop with kernel verification, calculators, Anthropic + offline providers |
| `apps/web` | Svelte 5 app: schematic workspace (chat + canvas + inspector), parts, settings. The kernel runs in a Web Worker |
| `tools/server` | Local server: serves the built app, MCP over stdio for your agent, headless `claude -p` for the app chat, WebSocket to the tab, access key and origin checks. Bundled with the app into the `4k7pcb` package |
