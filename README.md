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

Status: concept and architecture phase. No application code yet.
