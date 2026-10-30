#!/usr/bin/env node
// Stand-in for `copilot --output-format json` in tests. It reads the prompt from stdin, connects to the MCP
// server given in --additional-mcp-config like the Copilot CLI would, calls one tool, and prints JSONL events.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const load = (id) => import(pathToFileURL(require.resolve(id)).href);
const { Client } = await load('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await load('@modelcontextprotocol/sdk/client/streamableHttp.js');

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('GitHub Copilot CLI 1.0.95 (fake).');
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
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const session = args.find((a) => a.startsWith('--session-id='))?.slice(13);
if (prompt.includes('please fail')) {
  process.stderr.write('Error: Model "nope" from --model flag is not available.\n');
  process.exit(1);
}
if (args.includes('--reasoning-effort') && !arg('--model')) {
  // like the CLI for its default model ("auto") and others without the setting
  process.stderr.write(`Error: Model "auto" does not support reasoning effort configuration (requested: "${arg('--reasoning-effort')}").\n`);
  process.exit(1);
}
const tw = JSON.parse(arg('--additional-mcp-config')).mcpServers['4k7'];
const client = new Client({ name: 'github-copilot-developer', version: 'fake' });
await client.connect(new StreamableHTTPClientTransport(new URL(tw.url), { requestInit: { headers: tw.headers } }));
const tools = (await client.listTools()).tools.map((t) => t.name);
await client.callTool({ name: 'get_context', arguments: {} });
await client.close();

const flags = {
  available: list('--available-tools'),
  allowed: list('--allow-tool'),
  urls: args.includes('--allow-all-urls'),
  builtinMcps: !args.includes('--disable-builtin-mcps'),
  customInstructions: !args.includes('--no-custom-instructions'),
  model: arg('--model') ?? null,
  effort: arg('--reasoning-effort') ?? null,
  rules: prompt.startsWith('You are answering messages typed into'),
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
out({ type: 'assistant.message', data: { messageId: 'm1', content: '', toolRequests: [{ name: '4k7-get_context' }], model: 'gpt-fake' } });
out({ type: 'assistant.message_start', data: { messageId: 'm2' }, ephemeral: true });
for (const chunk of ['Got it. ', `flags=${JSON.stringify(flags)}`]) out({ type: 'assistant.message_delta', data: { messageId: 'm2', deltaContent: chunk }, ephemeral: true });
out({ type: 'assistant.message', data: { messageId: 'm2', content: 'Got it. (full message)', model: 'gpt-fake' } });
const usage = { inputTokens: 3000 * runs, outputTokens: 50 * runs, cacheReadTokens: 1000 * runs, cacheWriteTokens: 0 };
out({ type: 'session.usage_checkpoint', data: { accountingSnapshot: { modelMetrics: { 'gpt-fake': { usage } } } } });
out({ type: 'result', sessionId: session, exitCode: 0 });
