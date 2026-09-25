# Tracewise (working name)

An **AI-first, browser-based PCB schematic and layout tool**. It has no pencil, wire or trace tools.
You describe what you want, give hints ("put V1 on the left", "make C1 100 µF"), and an AI you
choose does the design through a typed operation API. A deterministic kernel turns that intent into
geometry and checks every change.

- **Bring your own AI**: Anthropic, OpenAI-compatible (incl. OpenRouter), Gemini, or local models (Ollama / LM Studio).
- **Bring your own tools**: attach any MCP server (distributor stock, company part DB, simulation…).
- **Parts from datasheets**: drop a manufacturer PDF; the AI reads the parameters and deterministic generators build the symbol, footprint and 3D body.
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

## Driving it with Claude Code (no API key needed)

The local bridge (`tools/bridge`) exposes the app as an MCP server, so Claude Code can design with your existing plan:

```sh
claude mcp add --scope user tracewise -- node /absolute/path/to/this/repo/tools/bridge/src/main.ts
```

1. Run the app (`npm run dev`) and open **Settings → Claude Code bridge** (it shows the exact command for your checkout).
2. Start `claude` anywhere and ask it to *“connect to Tracewise”*. It answers with a 6-digit pairing code
   (also stored in `~/.tracewise/bridge.json`, so you only pair once).
3. Enter the code in the app. Claude Code now works through `get_context`, `design_query`, `design_edit`, `calc`,
   `get_schematic_image`, `propose` and `wait_for_review`. Its changes show up as a changeset in the chat for you to review;
   `propose` is refused while the design has open errors.

The bridge binds to `127.0.0.1`, only accepts pages served from localhost, and needs the pairing code before any call is
forwarded. Stdout is reserved for MCP; logs go to stderr.

## Repository layout

| Path | What |
|---|---|
| `packages/schema` | Design model, part cards, zod op catalogue, results, units, agent tool definitions |
| `packages/parts` | Seed part library, deterministic symbol generator |
| `packages/kernel` | Transactions, ERC + datasheet checks, constraint ledger, schematic auto-layout, changesets, canonical JSON |
| `packages/agent` | Agent loop with kernel verification, calculators, Anthropic + offline providers |
| `apps/web` | Svelte 5 app: schematic workspace (chat + canvas + inspector), parts, settings. The kernel runs in a Web Worker |
| `tools/bridge` | Local relay: MCP server over stdio ↔ WebSocket ↔ browser tab, with pairing and origin checks |

## Status

**M0 (schematic)** is in progress. Working now: the full loop from prompt → typed ops → atomic transactions → checks →
auto-layout → reviewable changeset with per-change accept, a constraint ledger that survives re-layout, undo, and local
persistence. Deviations from the architecture for now: the kernel is TypeScript behind the same API (Rust/WASM later),
the document is stored as plain JSON (the CRDT arrives with collaboration), and there is one in-app provider (Anthropic) plus the Claude Code bridge.
See [ARCHITECTURE.md §7](docs/ARCHITECTURE.md#7-roadmap).
