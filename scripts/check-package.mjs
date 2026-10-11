// Checks the package as the npm registry would serve it: builds it, packs the tarball, installs the
// tarball into an empty folder (no workspace, no dev dependencies) and runs `tracewise` from there.
// Run by CI and by `prepublishOnly`; `npm run check:package` by hand. Leaves the tarball in the
// repository root (ignored by git) for trying it out: npx -y ./tracewise-<version>.tgz
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const fail = (msg) => {
  throw new Error(msg);
};

run('npm', ['run', 'package']);
const [packed] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts']));
const tarball = `${root}${packed.filename}`;

// only the build, the readme and the license; no sourcemaps, no local paths
const files = packed.files.map((f) => f.path);
const unexpected = files.filter((f) => !f.startsWith('dist/') && !['package.json', 'README.md', 'LICENSE'].includes(f));
if (unexpected.length) fail(`unexpected files in the package: ${unexpected.join(', ')}`);
for (const f of ['dist/tracewise.js', 'dist/app/index.html', 'LICENSE']) if (!files.includes(f)) fail(`${f} is missing from the package`);
if (files.some((f) => f.endsWith('.map'))) fail('the package contains sourcemaps');
const app = files.filter((f) => f.startsWith('dist/app/') && /\.(js|html)$/.test(f));
if (app.some((f) => readFileSync(`${root}${f}`, 'utf8').includes('tools/server/src/main.ts'))) fail('the app contains checkout paths (dev-only code)');
console.log(`${packed.filename}: ${files.length} files, ${(packed.size / 1e6).toFixed(1)} MB packed, ${(packed.unpackedSize / 1e6).toFixed(1)} MB unpacked`);

const dir = mkdtempSync(join(tmpdir(), 'tracewise-package-'));
let child;
try {
  writeFileSync(join(dir, 'package.json'), '{"private":true}\n');
  run('npm', ['install', '--no-audit', '--no-fund', '--omit=dev', tarball], dir);
  const bin = join(dir, 'node_modules', '.bin', 'tracewise');

  const version = run(bin, ['--version']).trim();
  if (version !== pkg.version) fail(`tracewise --version says ${version}, package.json ${pkg.version}`);

  // start it with its own home and access key, and load the app page from it
  const accessKey = '00000000-0000-4000-8000-000000000000';
  child = spawn(bin, ['--no-open'], {
    cwd: dir,
    env: { ...process.env, TRACEWISE_HOME: join(dir, 'home'), TRACEWISE_ACCESS_KEY: accessKey, TRACEWISE_CLAUDE_BIN: join(dir, 'no-claude') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no port after 20 s:\n${out}`)), 20_000);
    child.stderr.on('data', (d) => {
      out += d;
      const m = /on 127\.0\.0\.1:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => reject(new Error(`tracewise exited (${code}):\n${out}`)));
  });
  const res = await fetch(`http://localhost:${port}/${accessKey}`);
  const html = await res.text();
  if (res.status !== 200 || !html.includes('<script')) fail(`the app page answered ${res.status}`);
  console.log(`installed from the tarball: tracewise ${version} serves the app on port ${port}`);
} catch (e) {
  console.error(`check-package: ${e.message}`);
  process.exitCode = 1;
} finally {
  child?.kill();
  rmSync(dir, { recursive: true, force: true });
}
