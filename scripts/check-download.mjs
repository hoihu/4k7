// Checks a download as it came out of its archive, by running its launcher: `--version`, the server with the
// app (`--no-open`), and what a double-click does (no arguments: the server in the background).
//   node scripts/check-download.mjs <launcher> [--agent "Claude Code"]
// --agent: that coding agent must be found on this computer. CI runs it on Windows, where nothing else starts the
// launcher (the download is built elsewhere), against a Claude Code installed with npm. Needs nothing installed.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args.splice(args.indexOf(name), 2)[1] : undefined);
const agent = opt('--agent');
const launcher = resolve(args[0] ?? '');
if (!args[0]) throw new Error('which launcher?');
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
const windows = process.platform === 'win32';
const fail = (msg) => {
  throw new Error(msg);
};

const dir = mkdtempSync(join(tmpdir(), '4k7-download-'));
const accessKey = '00000000-0000-4000-8000-000000000000';
const env = { ...process.env, FOURK7_HOME: join(dir, 'home'), FOURK7_PROJECTS: join(dir, 'projects'), FOURK7_ACCESS_KEY: accessKey, FOURK7_NO_UPDATE_CHECK: '1', FOURK7_NO_OPEN: '1' };
// a batch file takes a shell, and quotes in case of spaces
const start = (cmdArgs, opts) => (windows ? spawn(`"${launcher}"`, cmdArgs, { ...opts, shell: true, env }) : spawn(launcher, cmdArgs, { ...opts, env }));
const stop = (pid) => {
  try {
    if (windows) execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    else process.kill(pid);
  } catch {
    // already gone
  }
};
const output = (child, stream = child.stderr) =>
  new Promise((done) => {
    let out = '';
    stream.on('data', (d) => (out += d));
    child.on('close', (code) => done({ code, out }));
  });
/** What the server logged, once `pattern` is in it. */
async function waitFor(read, pattern, what) {
  for (let i = 0; i < 300; i++) {
    const m = pattern.exec(read());
    if (m) return m;
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(`no ${what} after 30 s:\n${read()}`);
}
async function servesApp(port) {
  const res = await fetch(`http://localhost:${port}/${accessKey}`);
  const html = await res.text();
  if (res.status !== 200 || !html.includes('<script')) fail(`the app page answered ${res.status}`);
}

let failed = false;
try {
  const asked = start(['--version'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const version = await output(asked, asked.stdout);
  if (version.code !== 0 || version.out.trim() !== pkg.version) fail(`--version said "${version.out.trim()}" (exit ${version.code}), package.json ${pkg.version}`);
  console.log(`--version: ${pkg.version}`);

  const served = start(['--no-open'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  served.stderr.on('data', (d) => (log += d));
  try {
    const port = Number((await waitFor(() => log, /on 127\.0\.0\.1:(\d+)/, 'port'))[1]);
    await servesApp(port);
    console.log(`--no-open: serves the app on port ${port}`);
    const command = (await waitFor(() => log, /Claude Code starts this server with: (.+)/, 'command for Claude Code'))[1].trim();
    if (!command.includes(launcher)) fail(`Settings would show "${command}", which is not ${launcher}`);
    console.log(`the command in Settings: ${command}`);
    if (agent) {
      const line = (await waitFor(() => log, new RegExp(`app chat via ${agent}: .*`), `line about ${agent}`))[0].trim();
      if (!line.includes(': yes')) fail(line);
      console.log(line);
    }
  } finally {
    stop(served.pid);
  }

  // what a double-click runs: it returns at once and the server goes on by itself (a home of its own: the log above is not this server's)
  env.FOURK7_HOME = join(dir, 'double-click');
  const opened = await output(start([], { stdio: ['ignore', 'ignore', 'pipe'] }));
  if (opened.code !== 0) fail(`no arguments: exit ${opened.code}:\n${opened.out}`);
  if (/already running/.test(opened.out)) {
    console.log('no arguments: not tried, another 4k7 server runs on this computer');
    process.exit(0);
  }
  const pid = Number(/pid (\d+)/.exec(opened.out)?.[1]);
  if (!pid) fail(`no server started:\n${opened.out}`);
  try {
    const logFile = join(env.FOURK7_HOME, 'server.log');
    const read = () => {
      try {
        return readFileSync(logFile, 'utf8');
      } catch {
        return '';
      }
    };
    const port = Number((await waitFor(read, /on 127\.0\.0\.1:(\d+)/, 'port in server.log'))[1]);
    await servesApp(port);
    await waitFor(read, /open http:\/\/localhost:\d+\/00000000-/, 'link in server.log');
    console.log(`no arguments: the server runs by itself on port ${port} (pid ${pid}) and opens the app`);
  } finally {
    stop(pid);
  }
} catch (e) {
  console.error(`check-download: ${e.message}`);
  failed = true;
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
process.exitCode = failed ? 1 : 0;
