#!/usr/bin/env node
// Stand-in for `opencode run --format json` in tests. It reads its agent and MCP server from
// OPENCODE_CONFIG_CONTENT and the message from stdin, calls one tool, and, like the real CLI at
// times, exits before printing the last step: that one is only in `opencode export`.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (args[0] === '--version') {
  console.log('1.15.10');
  process.exit(0);
}
if (args[0] === 'models') {
  console.log('opencode/big-pickle\ngithub-copilot/claude-sonnet-5\nnot a model line');
  process.exit(0);
}
if (args[0] === 'export') {
  process.stdout.write('Exporting session: ' + args[1] + '\n');
  process.stdout.write(readFileSync(`opencode-${args[1]}.json`, 'utf8'));
  process.exit(0);
}
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
let message = '';
for await (const chunk of process.stdin) message += chunk;
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const agent = config.agent[arg('--agent')];
const tw = config.mcp['4k7'];
const session = arg('--session') ?? 'ses_fake1';

const client = new Client({ name: 'opencode', version: 'fake' });
await client.connect(new StreamableHTTPClientTransport(new URL(tw.url), { requestInit: { headers: tw.headers } }));
const tools = (await client.listTools()).tools.map((t) => t.name);
const ingest = !tools.includes('get_context');
await (ingest ? client.callTool({ name: 'submit_part', arguments: { mpn: 'FAKE1' } }) : client.callTool({ name: 'get_context', arguments: {} }));
await client.close();
const files = (await import('node:fs')).readdirSync('.').filter((f) => !f.startsWith('opencode-')).sort();

if (message.includes('please fail')) {
  out({ type: 'error', sessionID: session, error: { name: 'ProviderModelNotFoundError', data: { message: 'Model not found: nope/nope' } } });
  process.exit(1);
}
const flags = {
  message,
  agent: arg('--agent'),
  agentTools: agent.tools,
  permission: agent.permission,
  rules: agent.prompt.startsWith(ingest ? 'You extract a part definition' : 'You are answering messages typed into'),
  verify: agent.prompt.includes('independent verification pass'),
  web: agent.prompt.includes('Web access is enabled'),
  model: arg('--model') ?? null,
  tools,
  files,
};
const step1 = [
  { id: 'p1', type: 'step-start' },
  ...(ingest ? [{ id: 'p2r', type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: `${process.cwd()}/pages/page-001.txt` } } }] : []),
  { id: 'p2', type: 'tool', tool: ingest ? '4k7_submit_part' : '4k7_get_context', state: { status: 'completed' } },
  { id: 'p3', type: 'step-finish', reason: 'tool-calls', tokens: { input: 900, output: 40, reasoning: 10, cache: { read: 5000, write: 100 } }, cost: 0.004 },
];
const step2 = [
  { id: 'p4', type: 'step-start' },
  { id: 'p5', type: 'text', text: `Done. flags=${JSON.stringify(flags)}` },
  { id: 'p6', type: 'step-finish', reason: 'stop', tokens: { input: 100, output: 60, reasoning: 0, cache: { read: 6000, write: 0 } }, cost: 0.002 },
];
const file = `opencode-${session}.json`;
const before = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).messages : [];
const messages = [...before, { info: { role: 'user' }, parts: [{ id: 'u', type: 'text', text: message }] }, { info: { role: 'assistant' }, parts: step1 }, { info: { role: 'assistant' }, parts: step2 }];
writeFileSync(file, JSON.stringify({ info: { id: session }, messages }, null, 2));
// streamed: only the first step
out({ type: 'step_start', sessionID: session, part: step1[0] });
for (const p of step1.slice(1)) out({ type: p.type === 'step-finish' ? 'step_finish' : 'tool_use', sessionID: session, part: p });
out({ type: 'step_start', sessionID: session, part: step2[0] });
