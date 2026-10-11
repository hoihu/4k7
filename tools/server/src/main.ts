#!/usr/bin/env node
/**
 * 4k7-server: connects the 4k7 app in the browser to a coding agent (Claude Code, Copilot, OpenCode…).
 *
 * Either way it serves the built app on its port, at http://localhost:7777/<access-key>: the key (kept
 * in ~/.4k7/server.json) is what lets the tab connect to the server.
 *
 * Two ways to use it:
 *   1. You type in the app's chat and a coding agent on this computer answers:
 *        node tools/server/src/main.ts --serve [--open]   (npm run server; `npx 4k7pcb` runs this with --open)
 *      The server runs the agent's CLI headlessly per message (`claude -p`, `copilot -p`, `opencode run`),
 *      with only the 4k7 tools.
 *      With --idle-exit (the downloaded app) it stops by itself once no tab has been connected for a while.
 *   2. Claude Code drives the app (you type in the Claude Code CLI):
 *        claude mcp add --scope user 4k7 -- node /path/to/repo/tools/server/src/main.ts
 *      Claude Code starts the server as an MCP server over stdio.
 *
 * In stdio mode stdout is reserved for the MCP protocol; all logging goes to stderr.
 */
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SERVER_PORTS, type HarnessCapability } from '@4k7/schema';
import { appHandler, reachable, serves4k7 } from './app.ts';
import { LocalServer } from './server.ts';
import { ChatRunner, detectClaude } from './chat.ts';
import { CopilotHarness } from './harness/copilot.ts';
import { OpenCodeHarness } from './harness/opencode.ts';
import type { Harness } from './harness/types.ts';
import { extendPathFor } from './claude-bin.ts';
import { appDir, configDir, configPath, DEV_APP, inCheckout, loadConfig } from './config.ts';
import { openBrowser } from './launch.ts';
import { createMcpServer, mcpHttpHandler, VERSION } from './mcp.ts';
import { checkForUpdate } from './update.ts';

const serve = process.argv.includes('--serve');
/** Open the app link in the browser (what `npx 4k7pcb` does). */
const open = process.argv.includes('--open');
/**
 * Stop when no tab is connected: the downloaded app has no terminal to Ctrl-C in and no window to
 * close, so closing the app's tab is how it is quit. A reload reconnects well within the grace period.
 */
const idleExit = process.argv.includes('--idle-exit');
/** No tab within this time of starting (the browser did not open, or the tab was closed at once). */
const IDLE_START_MS = 3 * 60_000;
/** After the last tab went away. */
const IDLE_MS = 90_000;
/** Logs go to stderr and to ~/.4k7/server.log (kept small), which helps diagnose connection issues. */
const log = (msg: string) => {
  process.stderr.write(`[4k7] ${msg}\n`);
  try {
    const file = join(configDir(), 'server.log');
    if (existsSync(file) && statSync(file).size > 512 * 1024) renameSync(file, `${file}.1`);
    appendFileSync(file, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch {
    // logging must never break the server
  }
};

async function main() {
  const cfg = loadConfig();
  let onIdle: (() => void) | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const idle = (ms: number) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => onIdle?.(), ms);
  };
  const onTab = (connected: boolean) => {
    if (connected) {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    } else idle(IDLE_MS);
  };
  const server = new LocalServer({
    accessKey: cfg.accessKey,
    log,
    ...(inCheckout() ? { devPorts: [Number(new URL(DEV_APP).port)] } : {}),
    ...(serve && idleExit ? { onTab } : {}),
  });
  const port = await server.start();
  const dir = appDir();

  // chat in the app, answered by a coding agent on this computer (Claude Code, Copilot CLI, OpenCode)
  const claudeBin = process.env.FOURK7_CLAUDE_BIN ?? 'claude';
  const workDir = join(configDir(), 'claude-workspace');
  const others: Harness[] = [new CopilotHarness(process.env.FOURK7_COPILOT_BIN ?? 'copilot'), new OpenCodeHarness(process.env.FOURK7_OPENCODE_BIN ?? 'opencode', workDir)];
  const detectAll = (): HarnessCapability[] => [{ id: 'claude-code', name: 'Claude Code', ...detectClaude(claudeBin, cfg.claude) }, ...others.map((h) => h.detect())];
  let harnesses = detectAll();
  const bins = [claudeBin, ...others.map((h) => h.bin)];
  const missing = harnesses.filter((h, i) => !h.available && !bins[i]!.includes(sep)).map((h) => h.id);
  if (missing.length) {
    // started from the Finder or a launcher: look where installers put them, then where the user's shell does
    const added = extendPathFor(() => detectAll().some((h) => h.available && missing.includes(h.id)));
    if (added) {
      harnesses = detectAll();
      log(`agent CLIs found after adding to PATH: ${added.join(', ')}`);
    }
  }
  const capability = harnesses[0]!;
  const chat = new ChatRunner({ server, claudeBin, workDir, ingestDir: join(configDir(), 'ingest'), profile: cfg.claude, harnesses: others, log });
  server.setChatHandler(chat.handle, capability, harnesses);
  // model lists can take a while (OpenCode asks its providers): the tab gets them when they are in
  for (const h of others) {
    const i = harnesses.findIndex((c) => c.id === h.id);
    if (!harnesses[i]?.available || !h.models) continue;
    void h.models().then((models) => {
      if (!models.length) return;
      harnesses = harnesses.map((c, j) => (j === i ? { ...c, models } : c));
      server.setHarnesses(harnesses);
    });
  }
  const mcpHttp = mcpHttpHandler(server, (t) => chat.modeFor(t));
  const app = appHandler(dir, VERSION, cfg.accessKey);
  server.setHttpHandler((req, res) => ((req.url ?? '').split('?')[0] === '/mcp' ? mcpHttp(req, res) : app(req, res)));
  server.setAppUrl(await appUrl(cfg.appUrl, port, dir));

  log(`v${VERSION} on 127.0.0.1:${port} · access key in ${configPath()}`);
  for (const h of harnesses) log(`app chat via ${h.name}: ${h.available ? `yes (${h.version})` : `no, ${h.reason}`}`);
  const p = cfg.claude;
  if (p.configDir || p.unsetEnv.length) {
    log(`claude profile: ${p.configDir ? `CLAUDE_CONFIG_DIR=${p.configDir}` : 'default config'}${p.unsetEnv.length ? `, without ${p.unsetEnv.join(', ')}` : ''}`);
  } else if (process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX) {
    log('note: this shell routes Claude Code to Bedrock/Vertex; set "claude" in the config file to use another login');
  }

  let stdio: ReturnType<typeof createMcpServer> | null = null;
  if (serve) {
    log(`${open ? 'opening' : 'open'} ${server.appLink()} (Ctrl-C to stop)`);
    if (open) openBrowser(server.appLink(), log);
  } else {
    stdio = createMcpServer(server);
    await stdio.connect(new StdioServerTransport());
  }

  const shutdown = async () => {
    chat.stopAll();
    await server.stop();
    await stdio?.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (serve && idleExit) {
    onIdle = () => {
      log('no tab connected; stopping');
      void shutdown();
    };
    idle(IDLE_START_MS);
  }
  // the downloaded app does not update itself the way npx did; tell the tab when a newer release is out
  if (!inCheckout() && !process.env.FOURK7_NO_UPDATE_CHECK) {
    void checkForUpdate(VERSION, join(configDir(), 'update.json'), { log }).then((u) => u && server.setUpdate(u));
  }
  if (!serve) {
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
  }
}

/**
 * Where app links point. Projects live in the browser's storage per origin (host and port), so
 * the app should always open at the same address: http://localhost:7777, served by this server or
 * by another one that started first. A checkout's dev server (npm run dev) takes precedence there.
 */
async function appUrl(configured: string | undefined, port: number, dir: string | null): Promise<string | undefined> {
  if (configured) return configured;
  if (inCheckout() && (await reachable(DEV_APP))) return DEV_APP;
  const home = SERVER_PORTS[0];
  if (port !== home) {
    if (await serves4k7(home)) return `http://localhost:${home}`;
    log(`note: port ${home} is used by another program, so the app opens at http://localhost:${port}; designs saved at another address do not show there`);
  }
  if (!dir) log('note: the app is not built (run npm run build); the app link will not load until it is');
  return undefined;
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
