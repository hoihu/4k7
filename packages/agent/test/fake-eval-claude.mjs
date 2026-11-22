#!/usr/bin/env node
// Stand-in for `claude -p --output-format json` in the eval:mcp test: connects to the MCP server given in
// --mcp-config like Claude Code would, does the prompt's job with fixed tool calls, and prints a result object.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const load = (id) => import(pathToFileURL(require.resolve(id)).href);
const { Client } = await load('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await load('@modelcontextprotocol/sdk/client/streamableHttp.js');

const args = process.argv.slice(2);
const server = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers['4k7'];
const client = new Client({ name: 'claude-code', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
await client.callTool({ name: 'get_context', arguments: {} });
await client.callTool({ name: 'design_edit', arguments: { summary: 'R1 for 5 mA', ops: [{ op: 'set_param', ref: 'R1', params: { resistance: '270' } }] } });
await client.callTool({ name: 'propose', arguments: { summary: 'R1 for 5 mA' } });
await client.close();
const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 };
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.01, usage, result: 'Done.' }));
