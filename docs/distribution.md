# Running and sharing the app

There is no hosted website. 4k7 runs on the user's computer as one Node process that
serves the built app and runs the local server to Claude Code. People get it as a download
from [4k7.dev](https://4k7.dev/#download) (nothing to install, Node included), or run it from
the repository with npm:

```sh
npx -y github:hoihu/4k7          # or: npm install -g github:hoihu/4k7 && 4k7pcb
```

Nothing is published to the npm registry: npm installs straight from the GitHub repository.

## The downloads

`node scripts/bundle.mjs` builds, in `build/`:

| File | What it is |
|---|---|
| `4k7-macos-arm64.dmg`, `4k7-macos-x64.dmg` | A `4k7.app`: double-click opens the app in the browser |
| `4k7-linux-x64.tar.gz`, `4k7-linux-arm64.tar.gz` | A folder with a `4k7` launcher script (and a `.desktop` file) |

Each holds the package exactly as npm would install it (`dist/` and the runtime dependencies,
without sourcemaps and pdf.js's browser builds; `lib/`), the official Node binary of the major in
`.node-version` (downloaded from nodejs.org and checked against its checksums), and a launcher
that runs `node lib/node_modules/4k7pcb/dist/4k7pcb.js app`. There is no Electron and no
window: the app is the browser tab, as with npx.

`4k7pcb app` (`tools/server/src/launch.ts`) is what makes a double-click work:

- A server already running on one of the ports: open its link, done. So the app can be opened
  any number of times; the Mac launcher exits at once and is never "running" for the Finder.
- Otherwise start the server detached (`--idle-exit`, logging to `~/.4k7/server.log`),
  which opens the app itself.
- `--idle-exit`: there is no terminal to Ctrl-C and no window to close, so the server stops by
  itself 90 s after the last tab disconnected (a reload reconnects long before), or 3 min after
  starting if no tab ever connects.
- Started from the Finder or a desktop launcher, the process gets a minimal PATH without `claude`.
  `claude-bin.ts` adds the directories installers use (`~/.claude/local`, `~/.local/bin`,
  Homebrew, npm's global bin, nvm, volta, bun) and, if that does not help, the PATH of the user's
  login shell.
- The download does not update itself the way `npx` re-resolved the latest version each run, so
  the server asks GitHub for the latest release once a day (`~/.4k7/update.json`;
  `FOURK7_NO_UPDATE_CHECK=1` turns it off, a checkout never checks) and the app shows a
  banner with the download link when there is a newer one.

The launchers pass arguments through, so the CLI commands work from the download too:
`/Applications/4k7.app/Contents/MacOS/4k7 mcp` is what the app's Settings show for
`claude mcp add`, and `--no-open`, `--version` and `--help` behave as with `4k7pcb`.

**Not signed.** The Mac app carries only an ad-hoc signature (without it macOS refuses the bundle
outright on Apple silicon). Gatekeeper therefore warns that it cannot check the app for malware:
System Settings → Privacy & Security → Open Anyway, once. Signing and notarizing needs an Apple
Developer ID (99 USD/year) and a `notarytool` step in the workflow. Linux needs nothing.

**Release.** `.github/workflows/release.yml` runs on a `v*` tag: typecheck, tests, the bundles
(on a macOS runner, for `hdiutil`), then a GitHub release with the four files attached
(`gh release create`; a tag with a `-` is a pre-release). The release's notes are the version's
section of `CHANGELOG.md`, followed by GitHub's list of the pull requests since the last release. The
site links to `https://github.com/hoihu/4k7/releases/latest/download/<file>`, which always resolves
to the newest release, so the file names must not change. To release:

1. Write the version's section at the top of `CHANGELOG.md` (`## 0.3.0 — 2026-11-08`): what changed
   for the user, from the pull requests merged since the last tag. `npm run changelog`
   (`node scripts/changelog.mjs`) writes it into the site's changelog page, `site/changelog.html`
   (4k7.dev/changelog).
2. Set `version` in `package.json` and `package-lock.json`. CI checks that `CHANGELOG.md` has a
   section for it and that the site's page is up to date; the release workflow checks that the tag
   matches the version.
3. Merge to `main` (which also deploys the site), then `git tag v0.3.0 && git push origin v0.3.0`.

## What npm does (`npx github:hoihu/4k7`)

Installing from git, npm clones the repository, installs it with its dev dependencies and runs
`prepare` (`npm run package`):

1. `npm run build`: the web app into `apps/web/dist` (no sourcemaps), with
   `THIRD-PARTY-NOTICES.txt`, the licenses of the packages and fonts bundled into it
   (`apps/web/third-party-notices.ts`).
2. `scripts/package.mjs`: the server (`tools/server/src/cli.ts`) bundled with rolldown into
   `dist/4k7pcb.js` with the workspace packages inlined (Node does not strip types under
   `node_modules`), and the web app copied to `dist/app`.

Only `dist/` is packed (`files` in `package.json`); `ws`, `@modelcontextprotocol/sdk` and
`pdfjs-dist` stay npm dependencies of the root package. The first `npx` takes a few seconds and
is cached afterwards. `prepare` also runs on `npm install` in a checkout (about 3 s).

`npm start` in a checkout does the same and runs `dist/4k7pcb.js`.

## The command

- `4k7pcb`: serve the app and the server on `127.0.0.1:7777`, answer the app's chat with
  the local `claude -p`, and open the app (`http://localhost:7777/<access-key>`, see Security).
- `4k7pcb --no-open`: the same without opening the browser.
- `4k7pcb mcp`: MCP server over stdio for the Claude Code CLI
  (`claude mcp add --scope user 4k7 -- npx -y github:hoihu/4k7 mcp`). It serves the
  app too.

## The address matters

Projects are files the server writes (`~/Documents/4k7`), but the browser keeps settings and API
keys per origin (host *and* port), so the app always opens at
`http://localhost:7777`. When 7777 is taken by another 4k7 server (say the CLI's MCP
server), a second one takes the next port of 7777–7781 but still points its link at
7777, adding its own port (`?port=7778`) so the tab connects to it. When 7777 belongs to another
program, the app opens on the server's own port and the server says that settings saved at
7777 do not show there.

A checkout's dev server (`http://localhost:5173`) takes precedence: `npm run dev` points the
server's links there, and a server run on its own from the checkout does so while the
dev server answers. In a checkout, 7777 is the backend and 5173 is the dev UI: 7777 still
serves the last `npm run build`, so open the link `npm run dev` prints.

So, in a checkout: `npm run dev` while working on the code (hot reload, the server from source),
`npm start` to check the package as users get it.

## Security

Loopback only. The app's files are served only to `localhost` / `127.0.0.1` host names (a
DNS-rebinding page gets 421). The project files are read and written under `/api/`, which needs the
access key in an `authorization` header and refuses pages of other origins.

The app's address carries an access key: `http://localhost:7777/<access-key>`, a random UUID created
once and kept in `~/.4k7/server.json` (`"accessKey"`), so the address stays the same across
restarts and every server on this computer accepts it. (A `~/.4k7` folder from the app's old
name is moved to `~/.4k7` on the first start, and the browser copies its old database over the
first time the renamed app opens, so the key, the profile and saved work carry over.) The page is served only at that path (`/`
gets a page that says to use the link); the build files under `/assets` hold no secrets. The tab
reads the key from its address, remembers it, and sends it when it connects to the WebSocket,
which also accepts only the app's own pages (localhost on the server ports, the configured app
address and, in a checkout, the dev server). Other pages and programs on this computer get neither
the app nor the server. `/mcp` needs the token issued to a running chat process and refuses
browsers.

## Updating

The downloads: the app says when a newer release is out (above); download it again.
`npx -y github:hoihu/4k7` resolves the default branch each time and rebuilds when it moved.
Pin a version with a tag or commit: `npx -y github:hoihu/4k7#v0.2.0`.

## Publishing to npm (prepared, not done)

The package is ready for the npm registry but not published: `"private": true` in `package.json`
makes `npm publish` refuse. Until then the name (`4k7pcb`) can still change.

- `npm run check:package` builds the package, packs it (`4k7pcb-<version>.tgz`), installs the
  tarball into an empty folder without the workspace or dev dependencies and starts the app from
  it. CI runs it on every push. Try the tarball yourself with `npx -y ./4k7pcb-0.1.0.tgz`.
- Installed from the registry, nothing is built on the user's computer: the tarball carries `dist/`
  and npm installs only `ws`, `@modelcontextprotocol/sdk` and `pdfjs-dist`.
- The `publish` job of `.github/workflows/release.yml` (switched off with `if: false` until then)
  publishes when a `v*` tag is pushed, with provenance, using npm trusted publishing (no token in
  the repository). Pre-release versions (`0.2.0-beta.1`) go to the `next` dist-tag.

To release:

1. Remove `"private": true` and the `if: false` of the `publish` job; set `version` in
   `package.json` (the release checks it matches the tag; `4k7pcb --version` and the server
   read it from there).
2. Change `npx github:hoihu/4k7` to `npx 4k7pcb` here, in the README and in the
   `description`.
3. First version only: npm sets trusted publishers on an existing package, so publish it by hand
   from a clean checkout (`npm login`, `npm publish --access public`), then on npmjs.com add the
   trusted publisher: GitHub Actions, `hoihu/4k7`, workflow `release.yml`, environment `npm`
   (optionally require a reviewer for the `npm` environment in the repository settings).
4. Later versions: `git tag v0.2.0 && git push origin v0.2.0`.
