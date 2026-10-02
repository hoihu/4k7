# Deploying the web app (Cloudflare Pages)

The app is a static site: everything runs in the visitor's browser (designs and keys stay in
its IndexedDB). Cloudflare Pages builds it from this (private) repository on every push.

## One-time setup

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
   Install the Cloudflare GitHub app for this repository only.
2. Build settings:
   - Framework preset: **None**
   - Build command: `npm run build`
   - Build output directory: `apps/web/dist`
   - Root directory: *(empty: the repository root)*
   Node comes from `.node-version` (22). Every production build is a *hosted* one: no
   sourcemaps, and the bridge offered as `npx -y tracewise-bridge` (`TW_LOCAL=1` for a build
   that runs the bridge from the checkout, like the dev server).
3. Production branch: `main`. Every other branch and pull request gets a preview address
   (`https://<hash>.<project>.pages.dev`).
4. Optional: a custom domain under the project's **Custom domains**.

### Or: Cloudflare's Workers flow (asks for a deploy command)

Creating the project under **Workers** (the newer flow) serves the same files as a Worker with
static assets, configured in `wrangler.jsonc` (its `name` is the project name):

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Non-production branches (preview) command: `npx wrangler versions upload`

The app's address is then `https://<name>.<account>.workers.dev` (or a custom domain); set it as
`HOSTED_APP` below.

## The project name and the bridge

The bridge accepts the hosted app by default: `HOSTED_APP` in `tools/bridge/src/config.ts`
(`https://tracewise.fischer-carlito.workers.dev` and its preview versions). If the Pages project gets another
name, or the app a custom domain, change that constant (or set `TRACEWISE_HOSTED_URL` when
running the bridge). Other origins: `TRACEWISE_ORIGINS=https://a.example,https://b.example`.

When the bridge runs from a checkout it prints pairing links for the local dev server
(`http://localhost:5173`) and mentions the hosted app; run from npm, the other way round.

## Checks

`.github/workflows/ci.yml` runs typecheck, tests and the hosted build on every push and pull
request. Response headers (caching, basic security) are in `apps/web/public/_headers`.

## To test once it is online

- First load, the offline demo, an API-key provider (Anthropic / OpenRouter) end to end.
- The bridge from the hosted page (an https page talking to `ws://127.0.0.1`): works in Chrome
  once "Local network access" is allowed (it asks once); Safari blocks it (no permission to give).
  Firefox and Edge still to check.
- Datasheet import, Gerber export (downloads), the 3D view, storage in a private window.
