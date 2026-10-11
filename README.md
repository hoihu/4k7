# 4k7

> **Alpha.** 4k7 is in alpha (0.1.x). The schematic side works end to end; board placement, routing and
> fabrication output work for small boards. Expect rough edges, missing parts and breaking changes to the
> project file. See the [roadmap](docs/ARCHITECTURE.md#7-roadmap).

An **AI-first, browser-based PCB schematic and layout tool**. It has no pencil, wire or trace tools.
You describe what you want, give hints ("put V1 on the left", "make C1 100 µF"), and an AI you
choose does the design through a typed operation API. A deterministic kernel turns that intent into
geometry and checks every change.

- **Bring your own AI**: chat in the app through the coding agent you already have (Claude Code, GitHub Copilot CLI or OpenCode, on your existing plan or company login), or with an API key (Anthropic, OpenAI, OpenRouter, Gemini, a local model, any OpenAI- or Anthropic-compatible gateway). Or let your agent drive 4k7 from its own chat through the MCP server.
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

## Bring your own AI

4k7 ships no model. Chat in the app through a coding agent or an API key (A, B), or drive the app from your agent's own chat (C).

### A. Coding agent (chat in the app, on your plan)

The local server runs your agent's CLI headlessly for every chat message, with only the 4k7 tools (no shell, no files):

| Agent | Runs | Notes |
|---|---|---|
| Claude Code | `claude -p` | Model: default/opus/sonnet/fable/haiku. |
| GitHub Copilot CLI | `copilot -p` | Your Copilot plan (personal or company). Model: default, `auto` or any Copilot model. |
| OpenCode | `opencode run` | Whatever providers OpenCode is logged in to (`opencode models`), e.g. `github-copilot/…`, a company gateway, local models. |

1. Install the agent and sign in once in a terminal.
2. Start the app (`npx -y github:hoihu/4k7`, or the download) and open the link it prints.
3. **Settings → Chat provider → Coding agent**, pick the agent (and a model if you like).

All three also import parts from datasheets (Parts → Import from datasheet, where you pick the agent and model).
On a Copilot plan or organisation that restricts the CLI's models, only `auto` may run; the CLI's error says so.

- Tick **Web** to allow read-only web lookups (datasheets).
- The server finds the CLIs on your PATH; `FOURK7_CLAUDE_BIN`, `FOURK7_COPILOT_BIN`, `FOURK7_OPENCODE_BIN` point it elsewhere.

### B. API key (chat in the app, billed per token)

1. **Settings → Chat provider → API key**, pick the **Service**: Anthropic, OpenAI, OpenRouter, Google Gemini,
   a local model (Ollama, LM Studio), or *Other* for any OpenAI- or Anthropic-compatible API (Azure OpenAI, LiteLLM, a company gateway).
2. Check the **Address**, paste the key, press **Save**.
3. Pick the **Model** (**List models** asks the API), then use the chat.

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
| `packages/agent` | Agent loop with kernel verification, calculators, Anthropic and OpenAI-compatible providers |
| `apps/web` | Svelte 5 app: schematic workspace (chat + canvas + inspector), parts, settings. The kernel runs in a Web Worker |
| `tools/server` | Local server: serves the built app, MCP over stdio for your agent, headless Claude Code / Copilot CLI / OpenCode for the app chat, WebSocket to the tab, access key and origin checks. Bundled with the app into the `4k7pcb` package |
