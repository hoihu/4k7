/**
 * The access key is created once and kept in ~/.tracewise/bridge.json, so the app's address
 * (http://localhost:7777/<access-key>) stays the same across restarts and every bridge accepts the same tab.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_ACCESS_KEY } from '@tracewise/schema';

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
 * The built web app the bridge serves: next to the bundled CLI (dist/app) in the package, or
 * apps/web/dist in a checkout once built. TRACEWISE_APP_DIR overrides it.
 */
export function appDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.TRACEWISE_APP_DIR, join(here, 'app'), join(here, '..', '..', '..', 'apps', 'web', 'dist')];
  return candidates.find((d): d is string => !!d && existsSync(join(d, 'index.html'))) ?? null;
}

export interface BridgeConfig {
  /** In the app's address; the tab needs it to connect. */
  accessKey: string;
  /** Where app links point when set (TRACEWISE_APP_URL or "appUrl"); else the app this bridge serves. */
  appUrl?: string;
  claude: ClaudeProfile;
}

export function configDir(): string {
  return process.env.TRACEWISE_HOME ?? join(homedir(), '.tracewise');
}

export function configPath(): string {
  return join(configDir(), 'bridge.json');
}

export function loadConfig(): BridgeConfig {
  const path = configPath();
  let cfg: Partial<Omit<BridgeConfig, 'claude'>> & { claude?: Partial<ClaudeProfile> } = {};
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8')) as Partial<BridgeConfig>;
  } catch {
    // first run
  }
  const env = process.env.TRACEWISE_ACCESS_KEY;
  const accessKey = env && BRIDGE_ACCESS_KEY.test(env) ? env : cfg.accessKey && BRIDGE_ACCESS_KEY.test(cfg.accessKey) ? cfg.accessKey : randomUUID();
  if (accessKey !== cfg.accessKey && accessKey !== env) {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    // keep every other setting in the file; the 6-digit "code" of older versions is gone
    const { code: _old, ...rest } = cfg as typeof cfg & { code?: string };
    writeFileSync(path, JSON.stringify({ ...rest, accessKey }, null, 2) + '\n', { mode: 0o600 });
  }
  const appUrl = process.env.TRACEWISE_APP_URL ?? cfg.appUrl;
  const c = (cfg.claude ?? {}) as Partial<ClaudeProfile>;
  const configDir = process.env.TRACEWISE_CLAUDE_CONFIG_DIR ?? c.configDir;
  const claude: ClaudeProfile = {
    ...(configDir ? { configDir: expandHome(configDir) } : {}),
    unsetEnv: [...(c.unsetEnv ?? []), ...(process.env.TRACEWISE_CLAUDE_UNSET?.split(',').filter(Boolean) ?? [])],
    env: c.env ?? {},
  };
  return { accessKey, ...(appUrl ? { appUrl } : {}), claude };
}

function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, homedir()).replace(/^\$HOME(?=$|\/)/, homedir());
}
