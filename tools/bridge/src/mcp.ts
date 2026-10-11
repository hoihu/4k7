/**
 * MCP server side: lists the Tracewise tools and forwards calls through the bridge.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BRIDGE_INSTRUCTIONS, agentTools, chatModePrompt, ingestPrompt, ingestTools } from '@tracewise/schema';
import type { Bridge, HttpHandler } from './bridge.ts';

export const VERSION = '0.1.0';

/** 'cli': Claude Code CLI drives the app; 'chat': it answers the app's chat; 'ingest': it imports a datasheet. */
export type McpMode = 'cli' | 'chat' | 'ingest';

export function createMcpServer(bridge: Bridge, opts: { mode?: McpMode } = {}): Server {
  const mode = opts.mode ?? 'cli';
  const server = new Server(
    { name: 'tracewise', version: VERSION },
    { capabilities: { tools: {} }, instructions: mode === 'chat' ? chatModePrompt() : mode === 'ingest' ? ingestPrompt() : BRIDGE_INSTRUCTIONS },
  );
  const tools = mode === 'ingest' ? ingestTools() : agentTools(mode);

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

  if (mode === 'cli') {
    server.oninitialized = () => {
      const client = server.getClientVersion();
      bridge.setAgent(client ? prettyAgent(client.name) : null);
    };
  }
  return server;
}

/**
 * Streamable-HTTP MCP endpoint (/mcp) for the headless Claude Code the bridge starts for the
 * app's chat. Stateless: one server + transport per request. Only requests carrying a token
 * issued to a running chat process are accepted; browsers (any Origin header) are refused.
 */
export function mcpHttpHandler(bridge: Bridge, modeForToken: (token: string) => McpMode | null): HttpHandler {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if ((req.url ?? '').split('?')[0] !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.origin) {
      res.writeHead(403).end('browsers may not call this endpoint');
      return;
    }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const mode = token ? modeForToken(token) : null;
    if (!mode) {
      res.writeHead(401).end('missing or invalid token');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const body = await readJson(req);
    const server = createMcpServer(bridge, { mode });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}

export function tokenMatches(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8 * 1024 * 1024) throw new Error('request too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

function prettyAgent(name: string): string {
  if (/claude[-_ ]?code/i.test(name)) return 'Claude Code';
  if (/cursor/i.test(name)) return 'Cursor';
  return name;
}
