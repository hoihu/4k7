# Tracewise (working name)

An **AI-first, browser-based PCB schematic and layout tool**. It has no pencil, wire or trace tools.
You describe what you want, give hints ("put V1 on the left", "make C1 100 µF"), and an AI you
choose does the design through a typed operation API. A deterministic kernel turns that intent into
geometry and checks every change.

- **Bring your own AI**: Anthropic, OpenAI-compatible (incl. OpenRouter), Gemini, or local models (Ollama / LM Studio).
- **Bring your own tools**: attach any MCP server (distributor stock, company part DB, simulation…).
- **Parts from datasheets**: drop a manufacturer PDF (Parts → Import from datasheet); your local Claude Code extracts the pin table and package, the app checks it, and deterministic generators build the symbol and footprint.
- **Schematic to manufacturing files**: the board is placed and routed automatically from the schematic (with a ground pour), checked by DRC, shown in 2D and 3D, and exported as Gerber, drill, BOM and pick-and-place. Steer it in words ("make the board 30 × 20 mm", "put J1 at the left edge") or drag parts to pin them.
- **Correctness first**: every AI change is a transaction that gets validated, ERC/DRC-checked and shown as a reviewable changeset.
- **Local-first**: runs entirely in the browser. Your designs and API keys stay on your machine.

## Documents

| Document | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview, principles, components, roadmap, risks |
| [docs/design/data-model.md](docs/design/data-model.md) | Design graph, constraints, native file format |
| [docs/design/ops-api.md](docs/design/ops-api.md) | The operation catalogue that AI, MCP and UI all use |
| [docs/design/ai-loop.md](docs/design/ai-loop.md) | Agent loop, verification loop, hints, BYO AI, MCP, relay |
| [docs/design/part-ingest.md](docs/design/part-ingest.md) | Getting from a PDF datasheet to a verified part |
| [docs/design/ui.md](docs/design/ui.md) | UI concept: workspaces, density rules |
| [docs/ui/prototype.html](docs/ui/prototype.html) | Clickable prototype of the chosen UI (open in a browser) |
| [docs/ui/proposals.html](docs/ui/proposals.html) | Earlier exploration: proposals A, B, C |

## Running it

Requires Node 22+.

```sh
npm install
npm run dev        # http://localhost:5173 — the schematic workspace
npm test           # kernel + agent tests (vitest)
npm run typecheck  # tsc + svelte-check
npm run build      # static build in apps/web/dist
```

Without an API key the app runs an **offline demo** (a scripted agent that goes through the real kernel):
try “12 V to 3.3 V buck, 2 A. Put C1 left of U1.”, answer the question, review the changeset, then “make C2 100uF”.
Add an Anthropic API key in **Settings** to use a real model. It is encrypted in your browser and sent only to `api.anthropic.com`.

## Using Claude Code (no API key needed)

The local bridge (`tools/bridge`) connects the app to the Claude Code on your computer, so it runs on your existing plan.

**Chat in the app (recommended).**

```sh
npm run dev       # the app
npm run bridge    # in a second terminal; prints a pairing link, restarts itself when its code changes
```

Open the pairing link, then choose **Settings → AI provider → Claude Code on this computer**. Messages you type in
the app's chat are answered by `claude -p` running headlessly with **only** the Tracewise tools (no shell, files or web),
connected back to the bridge through a token-protected MCP endpoint. Follow-up messages continue the same session.
To let it look up datasheets, enable **Settings → Web** (adds read-only WebSearch/WebFetch; still no shell or files).

**Or chat in the Claude Code CLI.** Start `claude` in this repository and approve the `tracewise` server from
`.mcp.json` (or register it for every folder with
`claude mcp add --scope user tracewise -- node /absolute/path/to/this/repo/tools/bridge/src/main.ts`). Ask Claude to
*“connect to Tracewise”* and open the pairing link it gives you.

Either way Claude works through `get_context`, `design_query`, `design_edit`, `calc`, `get_schematic_image` and `propose`
(the CLI also gets `wait_for_review`), and its changes arrive as a changeset for you to review. `propose` is refused
while the design has open errors.

**Which Claude account the app chat uses.** The bridge starts `claude` directly, so shell aliases do not apply. If your
shell routes Claude Code to Bedrock/Vertex or a different login (e.g. an alias like
`claude-personal='env -u CLAUDE_CODE_USE_BEDROCK … CLAUDE_CONFIG_DIR=$HOME/.claude-personal claude'`), put the same in
`~/.tracewise/bridge.json`:

```json
{
  "claude": {
    "configDir": "~/.claude-personal",
    "unsetEnv": ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]
  }
}
```

The bridge logs the profile it uses at startup (`TRACEWISE_CLAUDE_CONFIG_DIR` / `TRACEWISE_CLAUDE_UNSET` override it).

The pairing code lives in `~/.tracewise/bridge.json`, so you pair once. The bridge binds to `127.0.0.1`, only accepts
pages served from localhost, and needs the pairing code before anything is forwarded. Set `TRACEWISE_APP_URL` if the app
runs elsewhere and `TRACEWISE_CLAUDE_BIN` if `claude` is not on your PATH.

## Repository layout

| Path | What |
|---|---|
| `packages/schema` | Design model, part cards, zod op catalogue, results, units, agent tool definitions |
| `packages/parts` | Seed part library, deterministic symbol, footprint and 3D-body generators, standard packages, datasheet import checks |
| `packages/kernel` | Transactions, ERC + datasheet checks, constraint ledger, schematic auto-layout, board placement, autorouter + ground pour, copper DRC, changesets, canonical JSON |
| `packages/fab` | Gerber X2, Excellon drill, BOM, pick-and-place, zip |
| `packages/agent` | Agent loop with kernel verification, calculators, Anthropic + offline providers |
| `apps/web` | Svelte 5 app: schematic workspace (chat + canvas + inspector), parts, settings. The kernel runs in a Web Worker |
| `tools/bridge` | Local relay to Claude Code: MCP over stdio (CLI drives the app) or headless `claude -p` for the app chat, WebSocket to the tab, pairing and origin checks |

## Status

**M0 (schematic)** is in progress, and a first slice of **M2/M3 (board, routing, fab)** works end to end for small boards (see [ARCHITECTURE.md](docs/ARCHITECTURE.md#m2m3-first-slice-board-routing-fab-2026-09-26)). Working now: the full loop from prompt → typed ops → atomic transactions → checks →
auto-layout → reviewable changeset with per-change accept, a constraint ledger that survives re-layout, undo, and local
persistence. Deviations from the architecture for now: the kernel is TypeScript behind the same API (Rust/WASM later),
the document is stored as plain JSON (the CRDT arrives with collaboration), and there is one in-app provider (Anthropic) plus the Claude Code bridge.
See [ARCHITECTURE.md §7](docs/ARCHITECTURE.md#7-roadmap).
