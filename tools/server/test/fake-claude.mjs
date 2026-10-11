#!/usr/bin/env node
// Stand-in for `claude -p ... --output-format stream-json` in tests. It connects to the MCP
// server given in --mcp-config exactly like Claude Code would, calls one tool, and streams output.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('2.1.282 (Claude Code, fake)');
  process.exit(0);
}
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const session = arg('--resume') ?? 'sess-1234';
const cfg = JSON.parse(arg('--mcp-config'));
const tw = cfg.mcpServers.tracewise;

out({ type: 'system', subtype: 'init', session_id: session, mcp_servers: [{ name: 'tracewise', status: 'connected' }] });

const client = new Client({ name: 'claude-code', version: 'fake' });
await client.connect(new StreamableHTTPClientTransport(new URL(tw.url), { requestInit: { headers: tw.headers } }));
const tools = (await client.listTools()).tools.map((t) => t.name);
const instructions = client.getInstructions() ?? '';
const ctx = tools.includes('get_context')
  ? await client.callTool({ name: 'get_context', arguments: {} })
  : await client.callTool({ name: 'submit_part', arguments: { mpn: 'FAKE1' } });
await client.close();

const flags = {
  tools: arg('--tools'),
  strict: args.includes('--strict-mcp-config'),
  allowed: arg('--allowedTools'),
  permission: arg('--permission-mode'),
  model: args.includes('--model') ? arg('--model') : null,
  prompt: arg('-p'),
  appended: (arg('--append-system-prompt') ?? '').slice(0, 40),
  instructionsLength: instructions.length,
  verify: (arg('--append-system-prompt') ?? '').includes('independent verification pass'),
  files: (await import('node:fs')).readdirSync('.').sort(),
  env: {
    configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    bedrock: 'CLAUDE_CODE_USE_BEDROCK' in process.env,
    vertex: 'CLAUDE_CODE_USE_VERTEX' in process.env,
    apiKey: 'ANTHROPIC_API_KEY' in process.env,
    nested: 'CLAUDECODE' in process.env,
  },
};
// model call 1 (its prompt: fresh, from the cache, into the cache)
out({ type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1200, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500, output_tokens: 1 } } } });
if (!tools.includes('get_context')) {
  // the importer writes its part as one long tool call
  out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'mcp__tracewise__submit_part' } } });
  for (let i = 1; i <= 45; i++) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: `{"number":"${i}",` } } });
}
for (const chunk of ['Got it. ', `tools=${tools.join(',')} `, `context=${JSON.stringify(ctx.content[0].text).slice(0, 30)} `, `flags=${JSON.stringify(flags)}`]) {
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } } });
}
out({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 150 } } });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'pages/page-001.txt' } }, { type: 'text', text: 'Got it. (full message)' }] } });
// model call 2, after the tool result (mostly from the cache now)
out({ type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-sonnet-5', usage: { input_tokens: 300, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 1 } } } });
out({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 20 } } });
out({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } });
if (flags.prompt === 'please fail') {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', session_id: session });
} else {
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Got it.', total_cost_usd: 0.012, session_id: session });
}
