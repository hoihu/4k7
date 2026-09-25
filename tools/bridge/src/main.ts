#!/usr/bin/env node
/**
 * tracewise-bridge: MCP server over stdio (for Claude Code and other MCP clients) that relays
 * tool calls to the Tracewise app open in the browser.
 *
 *   claude mcp add --scope user tracewise -- node /path/to/repo/tools/bridge/src/main.ts
 *
 * stdout is reserved for the MCP protocol; all logging goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Bridge } from './bridge.ts';
import { configPath, loadConfig } from './config.ts';
import { createMcpServer, VERSION } from './mcp.ts';

const log = (msg: string) => process.stderr.write(`[tracewise-bridge] ${msg}\n`);

async function main() {
  const cfg = loadConfig();
  const bridge = new Bridge({ code: cfg.code, origins: cfg.origins, log });
  const port = await bridge.start();
  log(`v${VERSION} listening on ws://127.0.0.1:${port} · pairing code ${cfg.code} (${configPath()})`);

  const server = createMcpServer(bridge);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await bridge.stop();
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
