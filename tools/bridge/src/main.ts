#!/usr/bin/env node
/**
 * tracewise-bridge: connects the Tracewise app in the browser to Claude Code.
 *
 * Either way it serves the built app on its port, at http://localhost:7777/<access-key>: the key (kept
 * in ~/.tracewise/bridge.json) is what lets the tab connect to the bridge.
 *
 * Two ways to use it:
 *   1. You type in the app's chat and your local Claude Code answers:
 *        node tools/bridge/src/main.ts --serve [--open]   (npm run bridge; `npx tracewise` runs this with --open)
 *      The bridge runs `claude -p` headlessly per message, with only the Tracewise tools.
 *   2. Claude Code drives the app (you type in the Claude Code CLI):
 *        claude mcp add --scope user tracewise -- node /path/to/repo/tools/bridge/src/main.ts
 *      Claude Code starts the bridge as an MCP server over stdio.
 *
 * In stdio mode stdout is reserved for the MCP protocol; all logging goes to stderr.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BRIDGE_PORTS } from '@tracewise/schema';
import { appHandler, reachable, servesTracewise } from './app.ts';
import { Bridge } from './bridge.ts';
import { ChatRunner, detectClaude } from './chat.ts';
import { appDir, configDir, configPath, DEV_APP, inCheckout, loadConfig } from './config.ts';
import { createMcpServer, mcpHttpHandler, VERSION } from './mcp.ts';

const serve = process.argv.includes('--serve');
/** Open the app link in the browser (what `npx tracewise` does). */
const open = process.argv.includes('--open');
/** Logs go to stderr and to ~/.tracewise/bridge.log (kept small), which helps diagnose connection issues. */
const log = (msg: string) => {
  process.stderr.write(`[tracewise-bridge] ${msg}\n`);
  try {
    const file = join(configDir(), 'bridge.log');
    if (existsSync(file) && statSync(file).size > 512 * 1024) renameSync(file, `${file}.1`);
    appendFileSync(file, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch {
    // logging must never break the bridge
  }
};

async function main() {
  const cfg = loadConfig();
  const bridge = new Bridge({ accessKey: cfg.accessKey, log, ...(inCheckout() ? { devPorts: [Number(new URL(DEV_APP).port)] } : {}) });
  const port = await bridge.start();
  const dir = appDir();

  // chat in the app, answered by the local Claude Code
  const claudeBin = process.env.TRACEWISE_CLAUDE_BIN ?? 'claude';
  const capability = detectClaude(claudeBin, cfg.claude);
  const chat = new ChatRunner({ bridge, claudeBin, workDir: join(configDir(), 'claude-workspace'), ingestDir: join(configDir(), 'ingest'), profile: cfg.claude, log });
  bridge.setChatHandler(chat.handle, capability);
  const mcp = mcpHttpHandler(bridge, (t) => chat.modeFor(t));
  const app = appHandler(dir, VERSION, cfg.accessKey);
  bridge.setHttpHandler((req, res) => ((req.url ?? '').split('?')[0] === '/mcp' ? mcp(req, res) : app(req, res)));
  bridge.setAppUrl(await appUrl(cfg.appUrl, port, dir));

  log(`v${VERSION} on 127.0.0.1:${port} · access key in ${configPath()}`);
  log(`app chat via Claude Code: ${capability.available ? `yes (${capability.version})` : `no, ${capability.reason}`}`);
  const p = cfg.claude;
  if (p.configDir || p.unsetEnv.length) {
    log(`claude profile: ${p.configDir ? `CLAUDE_CONFIG_DIR=${p.configDir}` : 'default config'}${p.unsetEnv.length ? `, without ${p.unsetEnv.join(', ')}` : ''}`);
  } else if (process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX) {
    log('note: this shell routes Claude Code to Bedrock/Vertex; set "claude" in the config file to use another login');
  }

  let server: ReturnType<typeof createMcpServer> | null = null;
  if (serve) {
    log(`${open ? 'opening' : 'open'} ${bridge.appLink()} (Ctrl-C to stop)`);
    if (open) openBrowser(bridge.appLink());
  } else {
    server = createMcpServer(bridge);
    await server.connect(new StdioServerTransport());
  }

  const shutdown = async () => {
    chat.stopAll();
    await bridge.stop();
    await server?.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (!serve) {
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
  }
}

/**
 * Where app links point. Projects live in the browser's storage per origin (host and port), so
 * the app should always open at the same address: http://localhost:7777, served by this bridge or
 * by another one that started first. A checkout's dev server (npm run dev) takes precedence there.
 */
async function appUrl(configured: string | undefined, port: number, dir: string | null): Promise<string | undefined> {
  if (configured) return configured;
  if (inCheckout() && (await reachable(DEV_APP))) return DEV_APP;
  const home = BRIDGE_PORTS[0];
  if (port !== home) {
    if (await servesTracewise(home)) return `http://localhost:${home}`;
    log(`note: port ${home} is used by another program, so the app opens at http://localhost:${port}; designs saved at another address do not show there`);
  }
  if (!dir) log('note: the app is not built (run npm run build); the app link will not load until it is');
  return undefined;
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => log(`could not open a browser; open ${url}`)).unref();
  } catch {
    log(`could not open a browser; open ${url}`);
  }
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
