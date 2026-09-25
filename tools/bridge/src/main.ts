#!/usr/bin/env node
/**
 * tracewise-bridge: connects the Tracewise app in the browser to Claude Code.
 *
 * Two ways to use it:
 *   1. Claude Code drives the app (you type in the Claude Code CLI):
 *        claude mcp add --scope user tracewise -- node /path/to/repo/tools/bridge/src/main.ts
 *      Claude Code starts the bridge as an MCP server over stdio.
 *   2. You type in the app's chat and your local Claude Code answers:
 *        node tools/bridge/src/main.ts --serve      (or: npm run bridge)
 *      The bridge runs `claude -p` headlessly per message, with only the Tracewise tools.
 *
 * In stdio mode stdout is reserved for the MCP protocol; all logging goes to stderr.
 */
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Bridge } from './bridge.ts';
import { ChatRunner, detectClaude } from './chat.ts';
import { configDir, configPath, loadConfig } from './config.ts';
import { createMcpServer, mcpHttpHandler, VERSION } from './mcp.ts';

const serve = process.argv.includes('--serve');
const log = (msg: string) => process.stderr.write(`[tracewise-bridge] ${msg}\n`);

async function main() {
  const cfg = loadConfig();
  const bridge = new Bridge({ code: cfg.code, origins: cfg.origins, appUrl: cfg.appUrl, log });
  const port = await bridge.start();

  // chat in the app, answered by the local Claude Code
  const claudeBin = process.env.TRACEWISE_CLAUDE_BIN ?? 'claude';
  const capability = detectClaude(claudeBin, cfg.claude);
  const chat = new ChatRunner({ bridge, claudeBin, workDir: join(configDir(), 'claude-workspace'), profile: cfg.claude, log });
  bridge.setChatHandler(chat.handle, capability);
  bridge.setHttpHandler(mcpHttpHandler(bridge, (t) => chat.isValidToken(t)));

  log(`v${VERSION} on 127.0.0.1:${port} · pairing code ${cfg.code} (${configPath()})`);
  log(`app chat via Claude Code: ${capability.available ? `yes (${capability.version})` : `no, ${capability.reason}`}`);
  const p = cfg.claude;
  if (p.configDir || p.unsetEnv.length) {
    log(`claude profile: ${p.configDir ? `CLAUDE_CONFIG_DIR=${p.configDir}` : 'default config'}${p.unsetEnv.length ? `, without ${p.unsetEnv.join(', ')}` : ''}`);
  } else if (process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX) {
    log('note: this shell routes Claude Code to Bedrock/Vertex; set "claude" in the config file to use another login');
  }

  let server: ReturnType<typeof createMcpServer> | null = null;
  if (serve) {
    log(`open ${bridge.pairingLink()} to pair the app (Ctrl-C to stop)`);
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

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
