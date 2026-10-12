#!/usr/bin/env node
// Stand-in for `copilot -p ... --output-format json` in tests. It connects to the MCP server given
// in --additional-mcp-config like the Copilot CLI would, calls one tool, and prints JSONL events.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('GitHub Copilot CLI 1.0.95 (fake).');
  process.exit(0);
}
if (args[0] === 'help' && args[1] === 'config') {
  console.log('Configuration Settings:\n\n  `model`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.\n    - "claude-sonnet-5"\n    - "gpt-6-luna"\n\n  `theme`: the theme\n    - "dark"');
  process.exit(0);
}
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
/** A variadic option: its values up to the next option. */
const list = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('-'); j++) out.push(args[j]);
  return out;
};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const prompt = arg('-p');
const session = args.find((a) => a.startsWith('--session-id='))?.slice(13);
if (prompt.includes('please fail')) {
  process.stderr.write('Error: Model "nope" from --model flag is not available.\n');
  process.exit(1);
}
const tw = JSON.parse(arg('--additional-mcp-config')).mcpServers['4k7'];
const client = new Client({ name: 'github-copilot-developer', version: 'fake' });
await client.connect(new StreamableHTTPClientTransport(new URL(tw.url), { requestInit: { headers: tw.headers } }));
const tools = (await client.listTools()).tools.map((t) => t.name);
const ingest = !tools.includes('get_context');
await (ingest ? client.callTool({ name: 'submit_part', arguments: { mpn: 'FAKE1' } }) : client.callTool({ name: 'get_context', arguments: {} }));
await client.close();

const flags = {
  available: list('--available-tools'),
  allowed: list('--allow-tool'),
  urls: args.includes('--allow-all-urls'),
  builtinMcps: !args.includes('--disable-builtin-mcps'),
  customInstructions: !args.includes('--no-custom-instructions'),
  model: arg('--model') ?? null,
  rules: prompt.startsWith(ingest ? 'You extract a part definition' : 'You are answering messages typed into'),
  verify: prompt.includes('independent verification pass'),
  tempDir: !args.includes('--disallow-temp-dir'),
  files: (await import('node:fs')).readdirSync('.').filter((f) => !f.startsWith('copilot-')).sort(),
  message: prompt.slice(prompt.lastIndexOf('\n') + 1),
  allowAllEnv: 'COPILOT_ALLOW_ALL' in process.env,
  tools,
};
// the session's totals grow with every run, as the CLI reports them
const file = `copilot-${session}.json`;
const runs = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).runs + 1 : 1;
writeFileSync(file, JSON.stringify({ runs }));

out({ type: 'session.mcp_servers_loaded', data: { servers: [{ name: '4k7', status: 'connected' }] }, ephemeral: true });
out({ type: 'session.auto_mode_resolved', data: { chosenModel: 'gpt-fake' } });
if (ingest) {
  // reads a page, then writes the part as one long tool call
  out({ type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'view', arguments: { path: `${process.cwd()}/pages/page-001.txt` } } });
  out({ type: 'tool.execution_start', data: { toolCallId: 't2', toolName: 'grep', arguments: { pattern: 'Pinout' } } });
  for (let i = 1; i <= 45; i++) out({ type: 'assistant.tool_call_delta', data: { toolCallId: 't3', toolName: '4k7-submit_part', inputDelta: `{"number":"${i}",` }, ephemeral: true });
}
out({ type: 'assistant.message', data: { messageId: 'm1', content: '', toolRequests: [{ name: '4k7-get_context' }], model: 'gpt-fake' } });
out({ type: 'assistant.message_start', data: { messageId: 'm2' }, ephemeral: true });
for (const chunk of ['Got it. ', `flags=${JSON.stringify(flags)}`]) out({ type: 'assistant.message_delta', data: { messageId: 'm2', deltaContent: chunk }, ephemeral: true });
out({ type: 'assistant.message', data: { messageId: 'm2', content: 'Got it. (full message)', model: 'gpt-fake' } });
const usage = { inputTokens: 3000 * runs, outputTokens: 50 * runs, cacheReadTokens: 1000 * runs, cacheWriteTokens: 0 };
out({ type: 'session.usage_checkpoint', data: { accountingSnapshot: { modelMetrics: { 'gpt-fake': { usage } } } } });
out({ type: 'result', sessionId: session, exitCode: 0 });
