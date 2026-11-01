/**
 * The access key is created once and kept in ~/.4k7/server.json, so the app's address
 * (http://localhost:7777/<access-key>) stays the same across restarts and every server accepts the same tab.
 *
 * A server run from source keeps to itself in ~/.4k7-dev and ~/Documents/4k7-dev: with an access key of its own
 * no tab crosses between the two, and half-done code never touches the real projects and libraries.
 */
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_ACCESS_KEY, type HarnessId } from '@4k7/schema';
import { defaultProjectsDir, renameRetrying } from './storage.ts';

/**
 * How to run the headless Claude Code for the app chat. Mirrors a shell alias such as
 *   alias claude-personal='env -u CLAUDE_CODE_USE_BEDROCK … CLAUDE_CONFIG_DIR=$HOME/.claude-personal claude'
 * which a spawned process cannot use.
 */
export interface ClaudeProfile {
  /** CLAUDE_CONFIG_DIR for the headless Claude (which login/settings to use). "~" is expanded. */
  configDir?: string;
  /** Environment variables to remove, e.g. CLAUDE_CODE_USE_BEDROCK or ANTHROPIC_API_KEY. */
  unsetEnv: string[];
  /** Extra environment variables. */
  env: Record<string, string>;
}

/** The Vite dev server of a checkout (npm run dev). */
export const DEV_APP = 'http://localhost:5173';

/** Running from a checkout of the repository (with the web app next to it), not from a package. */
export function inCheckout(): boolean {
  return existsSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'web', 'package.json'));
}

/**
 * The built web app the server serves: next to the bundled CLI (dist/app) in the package, or
 * apps/web/dist in a checkout once built. FOURK7_APP_DIR overrides it.
 */
export function appDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.FOURK7_APP_DIR, join(here, 'app'), join(here, '..', '..', '..', 'apps', 'web', 'dist')];
  return candidates.find((d): d is string => !!d && existsSync(join(d, 'index.html'))) ?? null;
}

export interface ServerConfig {
  /** In the app's address; the tab needs it to connect. */
  accessKey: string;
  /** Where app links point when set (FOURK7_APP_URL or "appUrl"); else the app this server serves. */
  appUrl?: string;
  claude: ClaudeProfile;
  /** The agents' CLIs chosen in the app (absolute paths); the FOURK7_…_BIN variables win over them. */
  bins: Partial<Record<HarnessId, string>>;
  /** Where the projects are kept (FOURK7_PROJECTS or "projectsDir"); else ~/Documents/4k7, or ~/Documents/4k7-dev run from source. */
  projectsDir: string;
}

/** The folder's name before 4k7; moved to the new name on the first start (key, profile, logs, workspaces). */
const OLD_DIR = '.tracewise';

export function configDir(): string {
  if (process.env.FOURK7_HOME) return process.env.FOURK7_HOME;
  return inCheckout() ? devDir() : installedDir();
}

/** Where a server run from source keeps its things. The first time, what the installed app has set up comes along. */
function devDir(): string {
  const dev = join(homedir(), '.4k7-dev');
  if (!existsSync(dev)) seedDevDir(join(homedir(), '.4k7'), dev);
  return dev;
}

/**
 * The agents' settings and a copy of the libraries; not the access key, not the projects. Done in a temporary folder, with
 * the new key, so that servers starting at the same moment (Claude Code sessions do) all end up with the same one.
 */
function seedDevDir(from: string, dev: string) {
  const tmp = `${dev}.${process.pid}.tmp`;
  try {
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    for (const d of ['library', 'artwork', 'datasheets', 'footprints']) {
      if (existsSync(join(from, d))) cpSync(join(from, d), join(tmp, d), { recursive: true });
    }
    let kept: Pick<Partial<ServerConfig>, 'claude' | 'bins'> = {};
    try {
      const { claude, bins } = JSON.parse(readFileSync(join(from, 'server.json'), 'utf8')) as Partial<ServerConfig>;
      kept = { claude, bins };
    } catch {
      // nothing set up there
    }
    writeFileSync(join(tmp, 'server.json'), JSON.stringify({ ...kept, accessKey: randomUUID() }, null, 2) + '\n', { mode: 0o600 });
    renameRetrying(tmp, dev);
  } catch {
    // another server was first, or the copy failed: then it starts empty, and this is not tried again
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(dev, { recursive: true, mode: 0o700 });
  }
}

/** ~/.4k7, where the installed app keeps its things. */
export function installedDir(): string {
  const dir = join(homedir(), '.4k7');
  const old = join(homedir(), OLD_DIR);
  if (!existsSync(dir) && existsSync(old)) {
    try {
      renameSync(old, dir);
    } catch {
      // a fresh folder then; the old one stays where it was
    }
  }
  return dir;
}

export function configPath(): string {
  return join(configDir(), 'server.json');
}

export function loadConfig(): ServerConfig {
  const path = configPath();
  let cfg: Partial<Omit<ServerConfig, 'claude'>> & { claude?: Partial<ClaudeProfile> } = {};
  try {
    // bridge.json: the name before the bridge became the server (its claude profile and appUrl carry over)
    cfg = JSON.parse(readFileSync(existsSync(path) ? path : join(dirname(path), 'bridge.json'), 'utf8')) as Partial<ServerConfig>;
  } catch {
    // first run
  }
  const env = process.env.FOURK7_ACCESS_KEY;
  const accessKey = env && SERVER_ACCESS_KEY.test(env) ? env : cfg.accessKey && SERVER_ACCESS_KEY.test(cfg.accessKey) ? cfg.accessKey : randomUUID();
  if (accessKey !== cfg.accessKey && accessKey !== env) {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    // keep every other setting in the file; the 6-digit "code" of older versions is gone
    const { code: _old, ...rest } = cfg as typeof cfg & { code?: string };
    writeFileSync(path, JSON.stringify({ ...rest, accessKey }, null, 2) + '\n', { mode: 0o600 });
  }
  const appUrl = process.env.FOURK7_APP_URL ?? cfg.appUrl;
  const c = (cfg.claude ?? {}) as Partial<ClaudeProfile>;
  const configDir = process.env.FOURK7_CLAUDE_CONFIG_DIR ?? c.configDir;
  const claude: ClaudeProfile = {
    ...(configDir ? { configDir: expandHome(configDir) } : {}),
    unsetEnv: [...(c.unsetEnv ?? []), ...(process.env.FOURK7_CLAUDE_UNSET?.split(',').filter(Boolean) ?? [])],
    env: c.env ?? {},
  };
  const projects = process.env.FOURK7_PROJECTS ?? cfg.projectsDir;
  return {
    accessKey,
    ...(appUrl ? { appUrl } : {}),
    claude,
    bins: typeof cfg.bins === 'object' && cfg.bins ? cfg.bins : {},
    projectsDir: typeof projects === 'string' && projects ? expandHome(projects) : defaultProjectsDir(inCheckout() ? '4k7-dev' : '4k7'),
  };
}

/** Change entries of server.json, keeping the rest of the file as it is. */
export function saveConfig(patch: Record<string, unknown>): void {
  const path = configPath();
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    // no file yet
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ ...cfg, ...patch }, null, 2) + '\n', { mode: 0o600 });
}

export function expandHome(p: string): string {
  const home = /^(~|\$HOME)(?=$|[\\/])/.exec(p);
  // join: on Windows "~/designs" is C:\Users\me\designs, with one kind of slash
  return home ? join(homedir(), p.slice(home[0].length)) : p;
}
