#!/usr/bin/env node
// Stand-in for `codex exec --json` in tests. It takes its settings from the -c options like the real CLI, the rules from
// the file named there and the message from stdin, connects to the MCP server given there, calls one tool, and prints
// JSONL events. What the real CLI does with those settings is for scripts/check-codex.mjs to find out.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (args[0] === '--version') {
  console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? '0.166.0'}`);
  process.exit(0);
}
if (args[0] === 'debug') {
  out({ models: [{ slug: 'gpt-fake', visibility: 'list' }, { slug: 'gpt-internal', visibility: 'hide' }] });
  process.exit(0);
}
if (args[0] === 'mcp') {
  if (process.env.FAKE_CODEX_NO_MCP_LIST) process.exit(1);
  out([{ name: 'my.own', enabled: true }, { name: '4k7', enabled: true }]);
  process.exit(0);
}

/** A -c value as the harness writes it: JSON, but for the = in tables. */
const toml = (v) => JSON.parse(v.replace(/("(?:[^"\\]|\\.)*")|=/g, (_, string) => string ?? ':'));
const config = {};
args.forEach((a, i) => {
  if (args[i - 1] !== '-c') return;
  const at = a.indexOf('=');
  config[a.slice(0, at)] = toml(a.slice(at + 1));
});
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const resume = args[1] === 'resume';
const session = resume ? args.at(-2) : randomUUID();
let message = '';
for await (const chunk of process.stdin) message += chunk;

if (session === 'gone') {
  process.stderr.write('2026-10-30T14:33:00.000000Z ERROR codex_core: resuming\nError: thread/resume: thread/resume failed: no rollout found for thread id gone (code -32600)\n');
  process.exit(1);
}
out({ type: 'thread.started', thread_id: session });
out({ type: 'turn.started' });
const fail = (error) => {
  out({ type: 'error', message: error });
  out({ type: 'turn.failed', error: { message: error } });
  process.exit(1);
};
if (config.model_reasoning_effort === 'max' && arg('--model') === 'gpt-old') {
  fail(JSON.stringify({ error: { message: "Unsupported value: 'max' is not supported with the 'gpt-old' model. Supported values are: 'low', 'medium', and 'high'.", type: 'invalid_request_error', param: 'reasoning.effort', code: 'unsupported_value' } }));
}
if (message.includes('please fail')) fail(JSON.stringify({ error: { message: 'Your organization has run out of credits.', type: 'insufficient_quota' } }));
if (message.includes('not signed in')) {
  const refused = 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header';
  for (let i = 1; i <= 2; i++) out({ type: 'error', message: `Reconnecting... ${i}/5 (${refused})` });
  fail(refused);
}
if (message.includes('please crash')) {
  out({ type: 'error', message: 'stream disconnected' });
  process.exit(1);
}

const require = createRequire(import.meta.url);
const load = (id) => import(pathToFileURL(require.resolve(id)).href);
const { Client } = await load('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await load('@modelcontextprotocol/sdk/client/streamableHttp.js');
const tw = config.mcp_servers['4k7_chat'];
const token = process.env[tw.bearer_token_env_var];
const client = new Client({ name: 'codex-mcp-client', version: 'fake' });
await client.connect(new StreamableHTTPClientTransport(new URL(tw.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
const tools = (await client.listTools()).tools.map((t) => t.name);
await client.callTool({ name: 'get_context', arguments: {} });
await client.close();

const rules = readFileSync(config.model_instructions_file, 'utf8');
const flags = {
  json: args.includes('--json'),
  gitCheck: !args.includes('--skip-git-repo-check'),
  resume,
  model: arg('--model') ?? null,
  ...config,
  rules: rules.startsWith('You are answering messages typed into'),
  webRules: rules.includes('Web access is enabled'),
  message,
  offered: tools,
  tokenInArgs: args.some((a) => a.includes(token)),
  noProxy: process.env.NO_PROXY,
};
// the session's totals grow with every run, as the CLI reports them
const file = `codex-${session}.json`;
const runs = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).runs + 1 : 1;
writeFileSync(file, JSON.stringify({ runs }));

out({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting.' } });
out({ type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: 'Looking at the design.' } });
out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Let me look.' } });
out({ type: 'item.started', item: { id: 'item_3', type: 'mcp_tool_call', server: '4k7_chat', tool: 'get_context', status: 'in_progress' } });
out({ type: 'item.completed', item: { id: 'item_3', type: 'mcp_tool_call', server: '4k7_chat', tool: 'get_context', status: 'completed' } });
out({ type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: `Got it. flags=${JSON.stringify(flags)}` } });
out({ type: 'turn.completed', usage: { input_tokens: 1000 * runs, cached_input_tokens: 400 * runs, cache_write_input_tokens: 0, output_tokens: 50 * runs, reasoning_output_tokens: 10 * runs } });
