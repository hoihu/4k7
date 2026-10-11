# Running and sharing the app

There is no hosted website. Tracewise runs on the user's computer as one Node process that
serves the built app and runs the local bridge to Claude Code:

```sh
npx -y github:hoihu/tracewise          # or: npm install -g github:hoihu/tracewise && tracewise
```

Nothing is published to the npm registry: npm installs straight from this (private) GitHub
repository, so whoever runs it needs read access (SSH key or `gh auth` credentials for git).

## What npm does

Installing from git, npm clones the repository, installs it with its dev dependencies and runs
`prepare` (`npm run package`):

1. `npm run build`: the web app into `apps/web/dist` (no sourcemaps).
2. `scripts/package.mjs`: the bridge (`tools/bridge/src/cli.ts`) bundled with rolldown into
   `dist/tracewise.js` with the workspace packages inlined (Node does not strip types under
   `node_modules`), and the web app copied to `dist/app`.

Only `dist/` is packed (`files` in `package.json`); `ws`, `@modelcontextprotocol/sdk` and
`pdfjs-dist` stay npm dependencies of the root package. The first `npx` takes a few seconds and
is cached afterwards. `prepare` also runs on `npm install` in a checkout (about 3 s).

`npm start` in a checkout does the same and runs `dist/tracewise.js`.

## The command

- `tracewise`: serve the app and the bridge on `127.0.0.1:7777`, answer the app's chat with
  the local `claude -p`, and open the pairing link (`http://localhost:7777/#pair=<code>@7777`).
- `tracewise --no-open`: the same without opening the browser.
- `tracewise mcp`: MCP server over stdio for the Claude Code CLI
  (`claude mcp add --scope user tracewise -- npx -y github:hoihu/tracewise mcp`). It serves the
  app too.

## The address matters

The browser keeps designs per origin (host *and* port), so the app always opens at
`http://localhost:7777`. When 7777 is taken by another Tracewise bridge (say the CLI's MCP
server), a second one takes the next port of 7777–7781 but still points its pairing link at
7777, adding its own port (`@7778`) so the tab connects to it. When 7777 belongs to another
program, the app opens on the bridge's own port and the bridge says that designs saved at
7777 do not show there.

A checkout's dev server (`http://localhost:5173`) takes precedence: `npm run dev` points the
bridge's pairing links there, and a bridge run on its own from the checkout does so while the
dev server answers.

So, in a checkout: `npm run dev` while working on the code (hot reload, the bridge from source),
`npm start` to check the package as users get it.

## Security

Loopback only. The app's files are served only to `localhost` / `127.0.0.1` host names (a
DNS-rebinding page gets 421). The WebSocket accepts only localhost origins and needs the pairing
code; `/mcp` needs the token issued to a running chat process and refuses browsers.

## Updating

`npx -y github:hoihu/tracewise` resolves the default branch each time and rebuilds when it moved.
Pin a version with a tag or commit: `npx -y github:hoihu/tracewise#v0.2.0`.
