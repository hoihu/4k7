# Running and sharing the app

There is no hosted website. 4k7 runs on the user's computer as one Node process that
serves the built app and runs the local server to Claude Code:

```sh
npx -y github:hoihu/4k7          # or: npm install -g github:hoihu/4k7 && 4k7
```

Nothing is published to the npm registry: npm installs straight from this (private) GitHub
repository, so whoever runs it needs read access (SSH key or `gh auth` credentials for git).

## What npm does

Installing from git, npm clones the repository, installs it with its dev dependencies and runs
`prepare` (`npm run package`):

1. `npm run build`: the web app into `apps/web/dist` (no sourcemaps).
2. `scripts/package.mjs`: the server (`tools/server/src/cli.ts`) bundled with rolldown into
   `dist/4k7.js` with the workspace packages inlined (Node does not strip types under
   `node_modules`), and the web app copied to `dist/app`.

Only `dist/` is packed (`files` in `package.json`); `ws`, `@modelcontextprotocol/sdk` and
`pdfjs-dist` stay npm dependencies of the root package. The first `npx` takes a few seconds and
is cached afterwards. `prepare` also runs on `npm install` in a checkout (about 3 s).

`npm start` in a checkout does the same and runs `dist/4k7.js`.

## The command

- `4k7`: serve the app and the server on `127.0.0.1:7777`, answer the app's chat with
  the local `claude -p`, and open the app (`http://localhost:7777/<access-key>`, see Security).
- `4k7 --no-open`: the same without opening the browser.
- `4k7 mcp`: MCP server over stdio for the Claude Code CLI
  (`claude mcp add --scope user 4k7 -- npx -y github:hoihu/4k7 mcp`). It serves the
  app too.

## The address matters

The browser keeps designs per origin (host *and* port), so the app always opens at
`http://localhost:7777`. When 7777 is taken by another 4k7 server (say the CLI's MCP
server), a second one takes the next port of 7777–7781 but still points its link at
7777, adding its own port (`?port=7778`) so the tab connects to it. When 7777 belongs to another
program, the app opens on the server's own port and the server says that designs saved at
7777 do not show there.

A checkout's dev server (`http://localhost:5173`) takes precedence: `npm run dev` points the
server's links there, and a server run on its own from the checkout does so while the
dev server answers.

So, in a checkout: `npm run dev` while working on the code (hot reload, the server from source),
`npm start` to check the package as users get it.

## Security

Loopback only. The app's files are served only to `localhost` / `127.0.0.1` host names (a
DNS-rebinding page gets 421).

The app's address carries an access key: `http://localhost:7777/<access-key>`, a random UUID created
once and kept in `~/.4k7/server.json` (`"accessKey"`), so the address stays the same across
restarts and every server on this computer accepts it. The page is served only at that path (`/`
gets a page that says to use the link); the build files under `/assets` hold no secrets. The tab
reads the key from its address, remembers it, and sends it when it connects to the WebSocket,
which also accepts only the app's own pages (localhost on the server ports, the configured app
address and, in a checkout, the dev server). Other pages and programs on this computer get neither
the app nor the server. `/mcp` needs the token issued to a running chat process and refuses
browsers.

## Updating

`npx -y github:hoihu/4k7` resolves the default branch each time and rebuilds when it moved.
Pin a version with a tag or commit: `npx -y github:hoihu/4k7#v0.2.0`.

## Publishing to npm (prepared, not done)

The package is ready for the npm registry but not published: `"private": true` in `package.json`
makes `npm publish` refuse. Until then the name (`4k7`) can still change.

- `npm run check:package` builds the package, packs it (`4k7-<version>.tgz`), installs the
  tarball into an empty folder without the workspace or dev dependencies and starts the app from
  it. CI runs it on every push. Try the tarball yourself with `npx -y ./4k7pcb-0.1.0.tgz`.
- Installed from the registry, nothing is built on the user's computer: the tarball carries `dist/`
  and npm installs only `ws`, `@modelcontextprotocol/sdk` and `pdfjs-dist`.
- `.github/workflows/release.yml` publishes when a `v*` tag is pushed, with provenance, using npm
  trusted publishing (no token in the repository). Pre-release versions (`0.2.0-beta.1`) go to the
  `next` dist-tag.

To release:

1. Remove `"private": true` and set `version` in `package.json` (the release checks it matches
   the tag; `4k7 --version` and the server read it from there).
2. Change `npx github:hoihu/4k7` to `npx 4k7pcb` here, in the README and in the
   `description`.
3. First version only: npm sets trusted publishers on an existing package, so publish it by hand
   from a clean checkout (`npm login`, `npm publish --access public`), then on npmjs.com add the
   trusted publisher: GitHub Actions, `hoihu/4k7`, workflow `release.yml`, environment `npm`
   (optionally require a reviewer for the `npm` environment in the repository settings).
4. Later versions: `git tag v0.2.0 && git push origin v0.2.0`.
