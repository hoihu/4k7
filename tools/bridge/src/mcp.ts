/**
 * MCP server side: lists the Tracewise tools and forwards calls through the bridge.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BRIDGE_INSTRUCTIONS, bridgeTools } from '@tracewise/schema';
import type { Bridge } from './bridge.ts';

export const VERSION = '0.1.0';

export function createMcpServer(bridge: Bridge): Server {
  const server = new Server(
    { name: 'tracewise', version: VERSION },
    { capabilities: { tools: {} }, instructions: BRIDGE_INSTRUCTIONS },
  );
  const tools = bridgeTools();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema as { type: 'object' } })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (!tools.some((t) => t.name === name)) {
      return { isError: true, content: [{ type: 'text' as const, text: `Unknown tool ${name}` }] };
    }
    const r = await bridge.call(name, req.params.arguments ?? {});
    return { isError: r.isError, content: r.content };
  });

  server.oninitialized = () => {
    const client = server.getClientVersion();
    bridge.setAgent(client ? prettyAgent(client.name) : null);
  };
  return server;
}

function prettyAgent(name: string): string {
  if (/claude[-_ ]?code/i.test(name)) return 'Claude Code';
  if (/cursor/i.test(name)) return 'Cursor';
  return name;
}
