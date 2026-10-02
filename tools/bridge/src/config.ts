/**
 * The pairing code is created once and kept in ~/.tracewise/bridge.json, so restarting
 * Claude Code does not require pairing the browser tab again.
 */
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * The hosted app (Cloudflare Pages): allowed to connect by default, with its preview deploys
 * (https://<hash>.<project>.pages.dev), and where pairing links point unless this runs from a
 * checkout with its own dev server. TRACEWISE_HOSTED_URL overrides it (another domain).
 */
export const HOSTED_APP = (process.env.TRACEWISE_HOSTED_URL ?? 'https://tracewise.pages.dev').replace(/\/$/, '');
const LOCAL_APP = 'http://localhost:5173';

/** Origins allowed besides localhost: the hosted app and its preview deploys ("https://*." matches subdomains). */
export function hostedOrigins(): string[] {
  const u = new URL(HOSTED_APP);
  return [u.origin, `${u.protocol}//*.${u.host}`];
}

/** Running from a checkout of the repository (with the web app next to it), not from npm. */
function inCheckout(): boolean {
  return existsSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'web', 'package.json'));
}

export interface BridgeConfig {
  code: string;
  origins: string[];
  appUrl: string;
  /** The other app to mention (the hosted one when pairing links point to the local dev server, and vice versa). */
  otherAppUrl: string;
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
  const code = process.env.TRACEWISE_BRIDGE_CODE ?? (cfg.code && /^\d{6}$/.test(cfg.code) ? cfg.code : newCode());
  const origins = [...hostedOrigins(), ...(cfg.origins ?? []), ...(process.env.TRACEWISE_ORIGINS?.split(',').filter(Boolean) ?? [])];
  if (code !== cfg.code && !process.env.TRACEWISE_BRIDGE_CODE) {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    // keep every other setting in the file
    writeFileSync(path, JSON.stringify({ ...cfg, code, origins: cfg.origins ?? [] }, null, 2) + '\n', { mode: 0o600 });
  }
  const appUrl = process.env.TRACEWISE_APP_URL ?? cfg.appUrl ?? (inCheckout() ? LOCAL_APP : HOSTED_APP);
  const otherAppUrl = appUrl === LOCAL_APP ? HOSTED_APP : LOCAL_APP;
  const c = (cfg.claude ?? {}) as Partial<ClaudeProfile>;
  const configDir = process.env.TRACEWISE_CLAUDE_CONFIG_DIR ?? c.configDir;
  const claude: ClaudeProfile = {
    ...(configDir ? { configDir: expandHome(configDir) } : {}),
    unsetEnv: [...(c.unsetEnv ?? []), ...(process.env.TRACEWISE_CLAUDE_UNSET?.split(',').filter(Boolean) ?? [])],
    env: c.env ?? {},
  };
  return { code, origins, appUrl, otherAppUrl, claude };
}

function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, homedir()).replace(/^\$HOME(?=$|\/)/, homedir());
}

function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
