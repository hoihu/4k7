# CLAUDE.md

4k7 is an AI-first, browser-based PCB schematic and layout tool, run locally (`package.json`, README). It has no
pencil, wire or trace tools: the user (or an AI they bring) states intent through a typed operation API, and a
deterministic kernel turns it into geometry and checks every change. Alpha (0.x). Node >= 22.18 (`.node-version`: 22).

## Layout (npm workspaces: `packages/*`, `tools/*`, `apps/*`)

| Path | What it is |
|---|---|
| `packages/schema` | Design types, ops, queries, results (zod), and the agent's guides |
| `packages/kernel` | Transactions/undo, op application (`*ops.ts`), schematic layout/drawing, placer, router, ERC/DRC. Also `bench/` |
| `packages/parts` | Library: symbols, footprints, 3D bodies, packages, sourcing and costs |
| `packages/fab` | Gerber, drill, BOM, pick-and-place, STEP, panel, enclosure, and the read-back check of production files |
| `packages/agent` | Provider adapters, agent loop, tools, prompt |
| `tools/server` | Local server: serves the app, reads/writes project files, MCP relay to the open tab, coding-agent harness |
| `apps/web` | Svelte 5 app (Vite); kernel runs in a worker (`src/lib/kernel.worker.ts`) |
| `docs/` | `ARCHITECTURE.md`, `distribution.md`, `design/*.md`, `ui/` (HTML prototypes) |
| `scripts/` | `dev.sh`, `package.mjs`, `bundle.mjs`, `changelog.mjs`, `check-package.mjs`, `check-codex.mjs`, `check-download.mjs` |
| `site/` | 4k7.dev: plain HTML, no build step; deployed to Cloudflare Workers on push to `main` (`site/README.md`) |

Every capability is defined once as an op in `packages/schema`; the UI, the agent and MCP all use that catalogue
(`docs/ARCHITECTURE.md`). Tests live in each workspace's `test/` and run through the root `vitest.config.ts`.

## Commands

```sh
npm install
npm run dev            # scripts/dev.sh: Vite on :5173 + server from source
npm run typecheck      # tsc -p tsconfig.json --noEmit && svelte-check in apps/web
npm test               # vitest run
npm run test:derived   # CHECK_DERIVED=1: every remembered result is recomputed and compared (packages/kernel/src/derive.ts)
node scripts/changelog.mjs --check   # CHANGELOG.md has a section for package.json's version; site/changelog.html is up to date
npm run build          # web app -> apps/web/dist
npm run check:package  # pack the tarball, install it alone, start the app from it
```

CI (`.github/workflows/ci.yml`, on PRs and pushes to `main`): `npm ci`, typecheck, `npm test`, `npm run test:derived`,
`changelog.mjs --check`, a check that `dist/` has no sourcemaps and starts (`--version`), `check:package`. Extra
jobs run the tests and package on Windows and start the Windows download. Run typecheck + tests before pushing.

## Dev data is separate

A server run from a checkout (`npm run dev`) uses `~/Documents/4k7-dev` for projects and `~/.4k7-dev` for libraries
(copied from `~/.4k7` the first time), with its own access key and a port other than 7777. The installed app / `npm start`
use `~/Documents/4k7` and `~/.4k7`. Source: `tools/server/src/config.ts` (`inCheckout()`), `scripts/dev.sh`. Never point
dev work at real designs. `FOURK7_PROJECTS` / `projectsDir` in `~/.4k7/server.json` override the projects dir.

## CHANGELOG

`CHANGELOG.md` is user-facing and is read by users: it feeds 4k7.dev/changelog and the GitHub release notes.

- Feature and fix PRs add their entry under `## Unreleased` (top of the file) in the same change (e.g. 3f598ae,
  f5ab005). `Unreleased` is left out of the site page and the release notes.
- Sections are `###` headings by area (Schematic, Sourcing, Fixes, Gerber viewer, ...), entries are `- ` bullets.
- Each bullet starts with a **bold lead sentence** saying what changed for the user, then plain prose: what it was
  like before, what it does now, where to find it in the UI (e.g. "Settings → Appearance → Schematic colours").
  Concrete numbers help (a 2-board order estimated at $80 was billed $133). Bugs say what went wrong and since which
  version, and what the user should do (e.g. export files again).
- No internals (function names, refactors, tests) except user-visible `code` such as check ids. Contributor-only
  changes (docs, CLAUDE.md, dev tooling, tests) get no entry.
- Format is enforced by `scripts/changelog.mjs`: release heading `## 0.6.1 — 2026-11-06`, newest first, `Unreleased`
  above all releases; only paragraphs, `###`, `- ` lists, **bold**, *italics*, `code`, links.
- `node scripts/changelog.mjs` rewrites the release block of `site/changelog.html` (committed, "do not edit" markers);
  `notes <version>` prints a release's notes. Don't hand-edit `site/changelog.html`.

## Release (docs/distribution.md, as done in "Version 0.6.1")

A release PR (branch like `t3/release-0-6-1`, commit `Version 0.6.1`): rename `Unreleased` to `## <version> — <date>`
(with a short intro paragraph for the user), bump `version` in `package.json` and `package-lock.json`, run
`node scripts/changelog.mjs` to regenerate `site/changelog.html`. Merge to `main`, then `git tag vX.Y.Z && git push
origin vX.Y.Z`; `release.yml` checks the tag matches `package.json`, runs typecheck/tests, builds the five downloads
and creates the GitHub release (notes = the changelog section + generated PR list). Also run `npm run check:codex`
with the newest Codex CLI first (not in CI). Not published to npm (`"private": true`).

## Design docs: which doc describes what

Read the doc before changing its module; update it in the same PR when behaviour changes (recent PRs do, e.g. 3f598ae).
Start with `docs/ARCHITECTURE.md` (overview, package table, roadmap).

| Doc (`docs/design/`) | Area |
|---|---|
| `data-model.md` | Design types, native `*.twd.json` format (`packages/schema`, `tools/server/src/storage.ts`) |
| `ops-api.md` | Operation catalogue (`packages/schema`, `packages/kernel/src/*ops.ts`) |
| `ai-loop.md` | Agent loop, hints, BYO AI, MCP (`packages/agent`, `tools/server`) |
| `part-ingest.md` | Datasheet PDF to verified part (`packages/parts`) |
| `schematic-drawing.md`, `schematic-rules.md`, `schematic.md` | Schematic drawing, notes/checks (`packages/schema/src/rules.ts`), and the agent guide (`get_guide schematic`) |
| `layout.md`, `zoom-optimize.md`, `panel.md` | Placement/routing (`packages/kernel`), zoom & optimize, fabrication panels |
| `multi-board.md` | Designs of several boards: board focus, per-board ops and outputs, mates (`packages/kernel/src/boards.ts`) |
| `impedance.md`, `high-speed.md` | Controlled-impedance lines; agent guide `get_guide high_speed` |
| `fab-rules.md`, `fab-check.md`, `assembly.md` | Manufacturer limits; production files read back and checked (`packages/fab`); polarity marks, pick-and-place |
| `sourcing.md`, `cost.md` | Catalogue lookup, stock check, order cost (`packages/parts`); `cost.md` is the cost agent's guide |
| `enclosure.md`, `mechanics.md` | Enclosure script (`packages/fab`); agent guide `get_guide mechanics` |
| `ui.md` | UI concept (`apps/web`); prototypes in `docs/ui/` |

Several docs (`schematic.md`, `high-speed.md`, `cost.md`, `mechanics.md`) are text the agent itself reads: write them to the agent.

## Conventions

- Branches: `t3/<topic>` (e.g. `t3/schematic-themes`, `t3/release-0-6-1`); PRs are merged with merge commits
  ("Merge pull request #N from hoihu/t3/...").
- Commit subject: `<Area>: <what changed>` in sentence case, no trailing period (`Sourcing: name JLCPCB's "Standard only" parts ...`,
  `Fab files: ...`, `Docs: ...`, `Dependencies: ...`, `Version 0.6.1`). A feature commit carries code, tests, the doc update and the
  CHANGELOG entry together.
- Source comments are plain prose and point at the design doc (`See docs/design/ai-loop.md`).
