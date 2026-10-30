/**
 * Finding the agent CLIs (Claude Code, Copilot, OpenCode) when the server was started from the Finder or a desktop launcher
 * rather than a terminal: such a process gets a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so
 * `claude` installed by npm, Homebrew or the native installer is not on it. The directories those
 * put it in are tried first, then the user's login shell is asked for its PATH (what a terminal
 * would have). Whatever is found is added to this process's PATH, so the headless agents and the
 * programs it starts find it too.
 *
 * Starting and stopping them, which on Windows is not the same as elsewhere: see commandFor and stopCli.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';

/** Whether `file` is a program this user can run. */
export function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where `bin` is: itself when it is a path, else the first match on the PATH (like `which`); null when not found. */
export function findBin(bin: string, path = process.env.PATH ?? ''): string | null {
  if (bin.includes(sep) || (process.platform === 'win32' && bin.includes('/'))) return isExecutable(bin) ? bin : null;
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').concat('') : [''];
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const ext of exts) if (isExecutable(join(dir, bin + ext))) return join(dir, bin + ext.toLowerCase());
  }
  return null;
}

/** Where installers put `claude`, `copilot`, `opencode` (and the node they may need), by convention. */
export function candidateDirs(home = homedir(), env = process.env): string[] {
  const dirs = [
    join(home, '.claude', 'local'), // the native installer and `claude install`
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.opencode', 'bin'), // OpenCode's installer
    join(home, '.fnm', 'aliases', 'default', 'bin'),
    // Windows: npm's global folder, winget's, Scoop's and Volta's
    ...(env.APPDATA ? [join(env.APPDATA, 'npm')] : []),
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'), join(env.LOCALAPPDATA, 'Volta', 'bin')] : []),
    join(home, 'scoop', 'shims'),
  ];
  // nvm: every installed node has its own bin; newest first
  const nvm = join(home, '.nvm', 'versions', 'node');
  try {
    for (const v of readdirSync(nvm).sort(compareVersionDirs).reverse()) dirs.push(join(nvm, v, 'bin'));
  } catch {
    // no nvm
  }
  return dirs.filter((d) => existsSync(d));
}

function compareVersionDirs(a: string, b: string): number {
  const na = a.replace(/^v/, '').split('.').map(Number);
  const nb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) - (nb[i] ?? 0);
  return 0;
}

/**
 * What an npm shim (`claude.cmd`) runs: a path relative to its folder, and whether node runs it; pnpm's and
 * yarn's read the same. null for any other batch file.
 */
export function shimTarget(text: string): { path: string; node: boolean } | null {
  const path = /"%~?dp0%?\\?([^"]+)"\s+%\*/.exec(text)?.[1];
  if (!path) return null;
  if (/\.(exe|com)$/i.test(path)) return { path, node: false };
  return /\bnode\b/i.test(text) ? { path, node: true } : null;
}

/**
 * What to start for `bin`, and the arguments that go before its own. Elsewhere that is `bin` itself. Windows
 * starts only real programs directly, and an agent installed with npm is a batch file (`claude.cmd`). Node
 * refuses to start one without cmd.exe, which would parse the arguments again and is what stopping the run would
 * then stop, so this starts what the batch file starts. Any other batch file stays as it is: spawning it fails
 * and `detectCli` says why.
 */
export function commandFor(bin: string, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  if (process.platform !== 'win32') return { file: bin, args: [] };
  // a copy of process.env keeps Windows' spelling (Path), which is no PATH there
  const path = env.PATH ?? process.env.PATH ?? '';
  const file = findBin(bin, path) ?? bin;
  if (!isBatchFile(file)) return { file, args: [] };
  let target: ReturnType<typeof shimTarget> = null;
  try {
    target = shimTarget(readFileSync(file, 'utf8'));
  } catch {
    // not readable: not one to start then
  }
  if (!target) return { file, args: [] };
  const dir = dirname(file);
  const script = join(dir, target.path);
  if (!target.node) return { file: script, args: [] };
  const beside = join(dir, 'node.exe');
  return { file: existsSync(beside) ? beside : (findBin('node', path) ?? process.execPath), args: [script] };
}

export function isBatchFile(file: string): boolean {
  return /\.(cmd|bat)$/i.test(file);
}

/** Start an agent's CLI. No console window on Windows: the server has none for it to share. */
export function spawnCli(bin: string, args: string[], opts: SpawnOptions): ChildProcess {
  const c = commandFor(bin, opts.env);
  return spawn(c.file, [...c.args, ...args], { ...opts, windowsHide: true });
}

export function spawnCliSync(bin: string, args: string[], opts: SpawnSyncOptionsWithStringEncoding) {
  const c = commandFor(bin, opts.env);
  return spawnSync(c.file, [...c.args, ...args], { ...opts, windowsHide: true });
}

/**
 * Stop a running CLI. Windows has no signals: `kill` ends the process at once, and what it started goes on (npm's
 * opencode starts the real program) with the output still open, so there the whole tree goes.
 */
export function stopCli(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
  } else child.kill(signal);
}

/** The PATH of the user's login shell (what a terminal gets), or null when it cannot be asked. */
export function loginShellPath(shell = process.env.SHELL): string | null {
  if (process.platform === 'win32' || !shell) return null;
  // -l reads the profile (Homebrew's shellenv lives there), -i the rc file (where npm and nvm usually go)
  const r = spawnSync(shell, ['-ilc', 'printf "%s" "$PATH"'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TERM: 'dumb' } });
  if (r.error || r.status !== 0) return null;
  // some rc files print; the PATH is what comes after the last newline
  const out = r.stdout.trim().split('\n').pop() ?? '';
  return out.includes(sep) ? out : null;
}

/**
 * Make `bin` findable when `probe` (a `claude --version`) fails on the current PATH: adds the usual
 * install directories and the login shell's PATH to process.env.PATH, in that order, until it works.
 * Returns what was added, or null when nothing helped (PATH is left as it was) or nothing was needed.
 */
export function extendPathFor(probe: () => boolean, opts: { shell?: boolean; candidates?: string[] } = {}): string[] | null {
  if (probe()) return null;
  const original = process.env.PATH ?? '';
  const present = new Set(original.split(delimiter));
  const tryWith = (dirs: string[]): string[] | null => {
    const extra = dirs.filter((d) => !present.has(d));
    if (!extra.length) return null;
    process.env.PATH = [...extra, original].filter(Boolean).join(delimiter);
    if (probe()) return extra;
    process.env.PATH = original;
    return null;
  };
  const found = tryWith(opts.candidates ?? candidateDirs());
  if (found) return found;
  if (opts.shell === false) return null;
  const shellPath = loginShellPath();
  return shellPath ? tryWith(shellPath.split(delimiter).filter(Boolean)) : null;
}
