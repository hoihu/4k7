// Builds the downloadable app: the package (dist/ and its npm dependencies) with the official Node
// binary beside it, so nothing has to be installed (no Node, no npm). One folder per platform in build/:
//   4k7-macos-arm64.dmg, 4k7-macos-x64.dmg   a 4k7.app that opens the app in the browser (double-click)
//   4k7-linux-x64.tar.gz, 4k7-linux-arm64.tar.gz   a folder with a 4k7 launcher script
// Run by the release workflow; `node scripts/bundle.mjs` by hand (--target darwin-arm64,linux-x64 for
// some, --node 22.21.0 to pin Node; default: the latest release of the major in .node-version).
// DMGs need macOS (hdiutil); on another system the macOS targets come out as zip files.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const build = join(root, 'build');
const cache = join(build, 'cache');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const NAME = '4k7';
const ALL_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const targets = (opt('--target') ?? ALL_TARGETS.join(',')).split(',').filter(Boolean);
for (const t of targets) if (!ALL_TARGETS.includes(t)) throw new Error(`unknown target ${t} (${ALL_TARGETS.join(', ')})`);

const run = (cmd, cmdArgs, cwd = root, env = {}) => execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...env } });
const log = (msg) => console.log(`[bundle] ${msg}`);

mkdirSync(cache, { recursive: true });

// 1. the package, built for the downloaded app: its Settings say to open the app, not to run npx
log('building the package');
const packageEnv = {
  FOURK7_RUN: `the ${NAME} app`,
  FOURK7_MCP: process.platform === 'darwin' ? `/Applications/${NAME}.app/Contents/MacOS/${NAME} mcp` : `/path/to/${NAME}/${NAME} mcp`,
};
run('npm', ['run', 'package'], root, packageEnv);
// Some npm versions run `prepare` on pack despite --ignore-scripts, which rebuilds the package and
// prints to stdout: the same env keeps that rebuild identical, and the tarball name is derived rather
// than read from `--json` output.
run('npm', ['pack', '--ignore-scripts', '--pack-destination', build], root, packageEnv);
const tarball = join(build, `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`);
if (!existsSync(tarball)) throw new Error(`${tarball} is missing after npm pack`);

// 2. the package with its runtime dependencies only, installed into lib/ (what npm would do on the user's computer)
const lib = join(build, 'lib');
rmSync(lib, { recursive: true, force: true });
mkdirSync(lib, { recursive: true });
writeFileSync(join(lib, 'package.json'), '{"private":true}\n');
run('npm', ['install', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball], lib);
rmSync(join(lib, 'package.json'));
prune(lib);
const native = findFiles(lib, (f) => f.endsWith('.node'));
if (native.length) throw new Error(`platform-specific modules in the dependencies, which one bundle cannot carry for every platform:\n${native.join('\n')}`);
const entry = join('lib', 'node_modules', pkg.name, 'dist', `${pkg.name}.js`);
if (!existsSync(join(build, entry))) throw new Error(`${entry} is missing`);
log(`lib/: ${(dirSize(lib) / 1e6).toFixed(1)} MB`);

// 3. Node, the official build, checked against its checksums
const nodeVersion = opt('--node') ?? (await latestNode(readFileSync(join(root, '.node-version'), 'utf8').trim()));
log(`node v${nodeVersion}`);
const shasums = await fetchText(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`);

const outputs = [];
for (const target of targets) {
  const [os, arch] = target.split('-');
  const node = await nodeBinary(nodeVersion, os, arch, shasums);
  const label = `${NAME}-${os === 'darwin' ? 'macos' : os}-${arch}`;
  const out = join(build, label);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  if (os === 'darwin') outputs.push(macApp(out, label, node));
  else outputs.push(linuxFolder(out, label, node));
}
log(`done:\n${outputs.map((o) => `  ${o}`).join('\n')}`);

/* ----------------------------------- macOS ----------------------------------- */

function macApp(out, label, node) {
  const app = join(out, `${NAME}.app`);
  const contents = join(app, 'Contents');
  const res = join(contents, 'Resources');
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  mkdirSync(res, { recursive: true });
  cpSync(lib, join(res, 'lib'), { recursive: true });
  copyNode(node, res);
  const launcher = join(contents, 'MacOS', NAME);
  writeFileSync(
    launcher,
    `#!/bin/sh
# ${NAME}: opened from the Finder this opens the app in the browser (starting its server when needed).
# Other commands: "${NAME} mcp" (MCP server for the Claude Code CLI), "${NAME} --no-open", "${NAME} --help".
R="$(cd "$(dirname "$0")/../Resources" && pwd)"
case "$1" in -psn_*) shift;; esac
[ $# -eq 0 ] && set -- app
exec "$R/node" "$R/${entry}" "$@"
`,
  );
  chmodSync(launcher, 0o755);
  const icon = macIcon(res);
  writeFileSync(
    join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${NAME}</string>
  <key>CFBundleDisplayName</key><string>${NAME}</string>
  <key>CFBundleIdentifier</key><string>dev.4k7.app</string>
  <key>CFBundleVersion</key><string>${pkg.version}</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>${NAME}</string>
  ${icon ? `<key>CFBundleIconFile</key><string>${icon}</string>` : ''}
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>${pkg.license} license · ${pkg.author}</string>
</dict>
</plist>
`,
  );
  // unsigned for now: an ad-hoc signature keeps macOS from refusing the bundle outright (it still warns about the developer)
  if (process.platform === 'darwin') {
    const r = spawnSync('codesign', ['--force', '--sign', '-', app], { encoding: 'utf8' });
    if (r.status !== 0) log(`warning: codesign failed: ${r.stderr.trim()}`);
  }
  if (process.platform === 'darwin') {
    const dmg = join(build, `${label}.dmg`);
    rmSync(dmg, { force: true });
    symlinkSync('/Applications', join(out, 'Applications'));
    run('hdiutil', ['create', '-volname', NAME, '-srcfolder', out, '-ov', '-format', 'UDZO', '-quiet', dmg]);
    return `${dmg} (${(dirSize(dmg) / 1e6).toFixed(1)} MB)`;
  }
  const zip = join(build, `${label}.zip`);
  rmSync(zip, { force: true });
  run('zip', ['-qry', zip, `${NAME}.app`], out);
  return `${zip} (${(dirSize(zip) / 1e6).toFixed(1)} MB; no DMG: not on macOS)`;
}

/** The app icon from the brand avatar, when the macOS tools to make an .icns are there. */
function macIcon(res) {
  const png = join(root, 'site', 'brand', 'avatar.png');
  if (process.platform !== 'darwin' || !existsSync(png)) return null;
  const iconset = join(build, `${NAME}.iconset`);
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset);
  for (const [size, name] of [
    [16, 'icon_16x16'],
    [32, 'icon_16x16@2x'],
    [32, 'icon_32x32'],
    [64, 'icon_32x32@2x'],
    [128, 'icon_128x128'],
    [256, 'icon_128x128@2x'],
    [256, 'icon_256x256'],
    [512, 'icon_256x256@2x'],
    [512, 'icon_512x512'],
    [1024, 'icon_512x512@2x'],
  ]) {
    run('sips', ['-z', String(size), String(size), png, '--out', join(iconset, `${name}.png`)]);
  }
  const r = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', join(res, `${NAME}.icns`)], { encoding: 'utf8' });
  if (r.status !== 0) {
    log(`warning: no icon: ${r.stderr.trim()}`);
    return null;
  }
  return `${NAME}.icns`;
}

/* ----------------------------------- Linux ----------------------------------- */

function linuxFolder(out, label, node) {
  const dir = join(out, NAME);
  mkdirSync(dir);
  cpSync(lib, join(dir, 'lib'), { recursive: true });
  copyNode(node, dir);
  const launcher = join(dir, NAME);
  writeFileSync(
    launcher,
    `#!/bin/sh
# ${NAME}: with no arguments, opens the app in the browser (starting its server when needed; it stops when the tab is closed).
# Other commands: "${NAME} mcp" (MCP server for the Claude Code CLI), "${NAME} --no-open", "${NAME} --help".
D="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
[ $# -eq 0 ] && set -- app
exec "$D/node" "$D/${entry}" "$@"
`,
  );
  chmodSync(launcher, 0o755);
  writeFileSync(
    join(dir, `${NAME}.desktop`),
    `[Desktop Entry]
Type=Application
Name=${NAME}
Comment=AI-first PCB schematic and layout tool
Exec=/opt/${NAME}/${NAME} app
Icon=/opt/${NAME}/${NAME}.png
Terminal=false
Categories=Development;Electronics;
`,
  );
  const png = join(root, 'site', 'brand', 'avatar-256.png');
  if (existsSync(png)) cpSync(png, join(dir, `${NAME}.png`));
  writeFileSync(
    join(dir, 'README.txt'),
    `${NAME} ${pkg.version} for Linux (${label.replace(`${NAME}-linux-`, '')})

Unpack it anywhere and run ./${NAME}: it opens the app in your browser at http://localhost:7777
and stops when you close the tab. Nothing else to install; Node is included.

To add it to your applications menu: move this folder to /opt/${NAME} and copy ${NAME}.desktop to
~/.local/share/applications/ (edit the paths in it if the folder lives elsewhere).

The chat in the app is answered by your Claude Code, if "claude" is installed; otherwise add an API key in Settings.
Logs: ~/.4k7/server.log
`,
  );
  const tgz = join(build, `${label}.tar.gz`);
  rmSync(tgz, { force: true });
  run('tar', ['-czf', tgz, '-C', out, NAME]);
  return `${tgz} (${(dirSize(tgz) / 1e6).toFixed(1)} MB)`;
}

/* ------------------------------------ Node ------------------------------------ */

/** The latest release of a Node major ("22"). */
async function latestNode(major) {
  const index = JSON.parse(await fetchText('https://nodejs.org/dist/index.json'));
  const hit = index.find((r) => r.version.startsWith(`v${major}.`));
  if (!hit) throw new Error(`no Node ${major} release found`);
  return hit.version.slice(1);
}

/** The node binary for a platform, downloaded (once) and checked, with Node's license beside it. */
async function nodeBinary(version, os, arch, shasums) {
  const name = `node-v${version}-${os}-${arch}`;
  const archive = join(cache, `${name}.tar.gz`);
  if (!existsSync(archive)) {
    log(`downloading ${name}`);
    const r = await fetch(`https://nodejs.org/dist/v${version}/${name}.tar.gz`);
    if (!r.ok) throw new Error(`download failed: ${r.status} ${name}`);
    writeFileSync(archive, Buffer.from(await r.arrayBuffer()));
  }
  const expected = shasums.split('\n').find((l) => l.endsWith(` ${name}.tar.gz`))?.split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (!expected || expected !== actual) {
    rmSync(archive, { force: true });
    throw new Error(`checksum mismatch for ${name}.tar.gz`);
  }
  const dir = join(cache, name);
  if (!existsSync(join(dir, 'node')) || !existsSync(join(dir, 'LICENSE'))) {
    mkdirSync(dir, { recursive: true });
    run('tar', ['-xzf', archive, '-C', dir, '--strip-components=2', `${name}/bin/node`]);
    run('tar', ['-xzf', archive, '-C', dir, '--strip-components=1', `${name}/LICENSE`]);
  }
  return join(dir, 'node');
}

/** Node into a download: the binary ships, so its license goes with it. */
function copyNode(node, dir) {
  cpSync(node, join(dir, 'node'));
  chmodSync(join(dir, 'node'), 0o755);
  cpSync(join(dirname(node), 'LICENSE'), join(dir, 'LICENSE-node'));
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

/* ------------------------------------ files ------------------------------------ */

/** What the server never loads: sourcemaps, type declarations, and pdf.js's browser builds (it uses legacy/build/pdf.mjs). */
function prune(lib) {
  for (const f of findFiles(lib, (n) => n.endsWith('.map') || n.endsWith('.d.ts') || n.endsWith('.d.mts'))) rmSync(f);
  const pdfjs = join(lib, 'node_modules', 'pdfjs-dist');
  for (const d of ['build', 'web', 'types', 'image_decoders', join('legacy', 'web')]) rmSync(join(pdfjs, d), { recursive: true, force: true });
  for (const f of readdirSync(join(pdfjs, 'legacy', 'build'))) if (f.includes('.min.') || f.includes('sandbox')) rmSync(join(pdfjs, 'legacy', 'build', f));
}

function findFiles(dir, match, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findFiles(p, match, acc);
    else if (match(e.name)) acc.push(p);
  }
  return acc;
}

function dirSize(path) {
  const out = execFileSync('du', ['-sk', path], { encoding: 'utf8' });
  return Number(out.split(/\s/)[0]) * 1024;
}
