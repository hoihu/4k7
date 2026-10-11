/**
 * Finding the agent CLIs (Claude Code, Copilot, OpenCode) when the server was started from the Finder or a desktop launcher
 * rather than a terminal: such a process gets a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so
 * `claude` installed by npm, Homebrew or the native installer is not on it. The directories those
 * put it in are tried first, then the user's login shell is asked for its PATH (what a terminal
 * would have). Whatever is found is added to this process's PATH, so the headless agents and the
 * programs it starts find it too.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, sep } from 'node:path';

/** Where installers put `claude`, `copilot`, `opencode` (and the node they may need), by convention. */
export function candidateDirs(home = homedir()): string[] {
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
