/**
 * The pairing code is created once and kept in ~/.tracewise/bridge.json, so restarting
 * Claude Code does not require pairing the browser tab again.
 */
import { randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface BridgeConfig {
  code: string;
  origins: string[];
}

export function configPath(): string {
  return join(process.env.TRACEWISE_HOME ?? join(homedir(), '.tracewise'), 'bridge.json');
}

export function loadConfig(): BridgeConfig {
  const path = configPath();
  let cfg: Partial<BridgeConfig> = {};
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8')) as Partial<BridgeConfig>;
  } catch {
    // first run
  }
  const code = process.env.TRACEWISE_BRIDGE_CODE ?? (cfg.code && /^\d{6}$/.test(cfg.code) ? cfg.code : newCode());
  const origins = [...(cfg.origins ?? []), ...(process.env.TRACEWISE_ORIGINS?.split(',').filter(Boolean) ?? [])];
  if (code !== cfg.code && !process.env.TRACEWISE_BRIDGE_CODE) {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ code, origins: cfg.origins ?? [] }, null, 2) + '\n', { mode: 0o600 });
  }
  return { code, origins };
}

function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
