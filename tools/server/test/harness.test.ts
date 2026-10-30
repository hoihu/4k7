import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { SERVER_PROTOCOL, type ChatEvent, type HarnessCapability, type ServerToTab } from '@4k7/schema';
import { ChatRunner, CodexHarness, CopilotHarness, LocalServer, OpenCodeHarness, mcpHttpHandler } from '../src/index.ts';
import { rulesFile } from '../src/harness/types.ts';

const KEY = '0cd22f19-30de-4d39-9287-ab0123456789';
/** A stand-in CLI: on Windows behind an npm shim, like a real agent installed with npm. */
const fake = (name: string) => fileURLToPath(new URL(`./${process.platform === 'win32' ? name.replace('.mjs', '.cmd') : name}`, import.meta.url));
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const base = 20000 + Math.floor(Math.random() * 20000);
  const server = new LocalServer({ accessKey: KEY, ports: [base, base + 1], devPorts: [5173] });
  const port = await server.start();
  cleanups.push(() => server.stop());
  const workDir = mkdtempSync(join(tmpdir(), 'tw-chat-'));
  const copilot = new CopilotHarness(fake('fake-copilot.mjs'));
  const codex = new CodexHarness(fake('fake-codex.mjs'), workDir);
  const opencode = new OpenCodeHarness(fake('fake-opencode.mjs'), workDir);
  const harnesses: HarnessCapability[] = [copilot.detect(), codex.detect(), opencode.detect()];
  const chat = new ChatRunner({ server, claudeBin: fake('fake-claude.mjs'), workDir, harnesses: [copilot, codex, opencode] });
  server.setChatHandler(chat.handle, { available: true }, harnesses);
  server.setHttpHandler(mcpHttpHandler(server, (t) => chat.modeFor(t)));

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'http://localhost:5173' } });
  cleanups.push(() => ws.close());
  const calls: string[] = [];
  const events = new Map<string, ChatEvent[]>();
  const pushed: ServerToTab[] = [];
  const welcome = await new Promise<ServerToTab>((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: SERVER_PROTOCOL, accessKey: KEY, client: 'test' })));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerToTab;
      if (m.type === 'welcome') resolve(m);
      if (m.type === 'harnesses') pushed.push(m);
      if (m.type === 'call') {
        calls.push(m.tool);
        ws.send(JSON.stringify({ type: 'result', id: m.id, isError: false, content: [{ type: 'text', text: '<design_state>empty</design_state>' }] }));
      }
      if (m.type === 'chat_event') events.set(m.id, [...(events.get(m.id) ?? []), m.event]);
    });
  });
  const send = (msg: { id: string; text: string; harness: string; session?: string | null; model?: string; effort?: string; web?: boolean }) =>
    new Promise<ChatEvent[]>((resolve) => {
      ws.send(JSON.stringify({ type: 'chat', session: null, autonomy: 'review', ...msg }));
      const t = setInterval(() => {
        if (events.get(msg.id)?.some((e) => e.kind === 'done')) {
          clearInterval(t);
          resolve(events.get(msg.id)!);
        }
      }, 20);
    });
  return { server, welcome, pushed, calls, send, opencode, codex };
}

describe('the rules of a run', () => {
  it('are one file per text, written once and whole', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-rules-'));
    const a = rulesFile(join(dir, 'rules'), 'rule one\n"two"');
    expect(readFileSync(a, 'utf8')).toBe('rule one\n"two"');
    expect(rulesFile(join(dir, 'rules'), 'rule one\n"two"')).toBe(a);
    expect(rulesFile(join(dir, 'rules'), 'other rules')).not.toBe(a);
    expect(readdirSync(join(dir, 'rules')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

const text = (es: ChatEvent[]) => es.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).join('');
const flagsOf = (es: ChatEvent[]) => {
  const t = text(es);
  return JSON.parse(t.slice(t.indexOf('flags=') + 6));
};

describe('app chat via other coding agents', () => {
  it('tells the tab which agents the server can run', async () => {
    const { welcome } = await setup();
    expect(welcome).toMatchObject({
      type: 'welcome',
      harnesses: [
        { id: 'copilot', name: 'GitHub Copilot CLI', available: true, version: 'GitHub Copilot CLI 1.0.95 (fake).' },
        { id: 'codex', name: 'Codex CLI', available: true, version: 'codex-cli 0.166.0' },
        { id: 'opencode', name: 'OpenCode', available: true, version: '1.15.10' },
      ],
    });
  });

  it('lists OpenCode models and sends updated details to the tab', async () => {
    const { server, opencode, pushed } = await setup();
    const models = await opencode.models();
    expect(models).toEqual(['opencode/big-pickle', 'github-copilot/claude-sonnet-5']);
    server.setHarnesses([{ ...opencode.detect(), models }]);
    for (let i = 0; i < 50 && !pushed.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(pushed[0]).toMatchObject({ type: 'harnesses', harnesses: [{ id: 'opencode', models }] });
  });

  describe('GitHub Copilot CLI', () => {
    it('runs copilot with only the 4k7 tools, the chat rules in the first message, and a session id up front', async () => {
      const saved = process.env.COPILOT_ALLOW_ALL;
      process.env.COPILOT_ALLOW_ALL = '1';
      cleanups.push(() => (saved === undefined ? delete process.env.COPILOT_ALLOW_ALL : (process.env.COPILOT_ALLOW_ALL = saved)));
      const { send, calls } = await setup();
      const es = await send({ id: 'c1', text: 'build a buck', harness: 'copilot', model: 'gpt-5.2' });
      const session = (es[0] as { session: string }).session;
      expect(es[0]).toEqual({ kind: 'session', session: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      expect(calls).toEqual(['get_context']);
      expect(text(es)).toContain('Got it. ');
      expect(text(es)).not.toContain('(full message)'); // streamed deltas win over the final message
      expect(flagsOf(es)).toMatchObject({
        available: ['4k7'],
        allowed: ['4k7'],
        urls: false,
        builtinMcps: false,
        customInstructions: false,
        model: 'gpt-5.2',
        rules: true,
        message: 'build a buck',
        allowAllEnv: false, // would approve the shell too
      });
      expect(flagsOf(es).tools).toContain('design_edit');
      expect(es.at(-1)).toMatchObject({ kind: 'done', ok: true, session, tokens: { input: 2000, cacheRead: 1000, cacheWrite: 0, output: 50, model: 'gpt-fake' } });
    });

    it('continues the session with just the message, and counts only this run’s tokens', async () => {
      const { send } = await setup();
      const first = await send({ id: 'c1', text: 'hi', harness: 'copilot' });
      const session = (first[0] as { session: string }).session;
      const second = await send({ id: 'c2', text: 'and now 5 V', harness: 'copilot', session });
      expect(second[0]).toEqual({ kind: 'session', session });
      expect(flagsOf(second)).toMatchObject({ rules: false, message: 'and now 5 V' });
      // the CLI reports the session's totals (2 runs); the run's own are the difference
      expect(second.at(-1)).toMatchObject({ kind: 'done', ok: true, tokens: { input: 2000, cacheRead: 1000, output: 50 } });
    });

    it('lets it fetch web pages only when the user allows it', async () => {
      const { send } = await setup();
      const es = await send({ id: 'w1', text: 'look it up', harness: 'copilot', web: true });
      expect(flagsOf(es)).toMatchObject({ available: ['4k7', 'web_fetch'], allowed: ['4k7'], urls: true });
    });

    it('passes the effort level, and asks again without it when the model has none', async () => {
      const { send } = await setup();
      expect(flagsOf(await send({ id: 'e1', text: 'think', harness: 'copilot', model: 'gpt-5.2', effort: 'high' }))).toMatchObject({ model: 'gpt-5.2', effort: 'high' });
      const es = await send({ id: 'e2', text: 'think', harness: 'copilot', effort: 'low' }); // the default model ("auto") has no effort setting
      expect(es).toContainEqual({ kind: 'status', text: expect.stringContaining('does not take that effort level') });
      expect(flagsOf(es)).toMatchObject({ model: null, effort: null, rules: true });
      expect(es.at(-1)).toMatchObject({ kind: 'done', ok: true });
    });

    it('reports why the CLI failed', async () => {
      const { send } = await setup();
      const es = await send({ id: 'f1', text: 'please fail', harness: 'copilot' });
      expect(es.at(-1)).toMatchObject({ kind: 'done', ok: false, error: expect.stringContaining('GitHub Copilot CLI exited (1): Error: Model "nope"') });
    });
  });

  describe('Codex CLI', () => {
    it('runs codex with only the 4k7 tools, the chat rules from a file, the message on stdin and the token out of its arguments', async () => {
      const { send, calls } = await setup();
      const es = await send({ id: 'x1', text: 'build a "buck"\nwith 2 A', harness: 'codex', model: 'gpt-fake' });
      expect(es[0]).toEqual({ kind: 'session', session: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      expect(calls).toEqual(['get_context']);
      const flags = flagsOf(es);
      expect(flags).toMatchObject({
        json: true,
        gitCheck: false, // its working directory is no repository
        resume: false,
        model: 'gpt-fake',
        rules: true,
        webRules: false,
        message: 'build a "buck"\nwith 2 A', // stdin: exactly as typed
        tokenInArgs: false,
        sandbox_mode: 'read-only', // what stops apply_patch, which no setting takes away
        web_search: 'disabled',
        notify: [],
        developer_instructions: '',
        agents: { enabled: false },
        tools: { experimental_request_user_input: { enabled: false } },
        features: { shell_tool: false, view_image: false, image_generation: false, apps: false, plugins: false, multi_agent_v2: false, hooks: false, goals: false, code_mode: { direct_only_tool_namespaces: ['mcp__4k7_chat'] } },
      });
      expect(flags.mcp_servers['4k7_chat']).toMatchObject({ required: true, default_tools_approval_mode: 'approve', tool_input_schema_max_bytes: 1_000_000 });
      expect(flags.offered).toContain('design_edit');
      expect(flags.model_reasoning_effort).toBeUndefined();
      expect(text(es)).toMatch(/^Let me look\.\n\nGot it\. flags=/);
      expect(es).toContainEqual({ kind: 'thinking', text: 'Looking at the design.\n\n' });
      // cached input apart, the reasoning tokens are part of the output
      expect(es.at(-1)).toMatchObject({ kind: 'done', ok: true, session: (es[0] as { session: string }).session, tokens: { input: 600, cacheRead: 400, cacheWrite: 0, output: 50, model: 'gpt-fake' } });
    });

    it('switches off the MCP servers from the user’s settings and keeps its own apart from one they call 4k7', async () => {
      const { send } = await setup();
      const flags = flagsOf(await send({ id: 'x2', text: 'hi', harness: 'codex' }));
      expect(flags.mcp_servers).toMatchObject({ 'my.own': { enabled: false }, '4k7': { enabled: false } });
      expect(flags.mcp_servers['4k7_chat'].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    });

    it('does not start when it cannot tell which servers those are', async () => {
      process.env.FAKE_CODEX_NO_MCP_LIST = '1';
      cleanups.push(() => delete process.env.FAKE_CODEX_NO_MCP_LIST);
      const { send, calls } = await setup();
      const es = await send({ id: 'x3', text: 'hi', harness: 'codex' });
      expect(es.at(-1)).toMatchObject({ kind: 'done', ok: false, error: expect.stringContaining('Could not start Codex CLI') });
      expect(calls).toEqual([]);
    });

    it('reaches the 4k7 endpoint past a proxy, and keeps the user’s own exceptions', async () => {
      for (const k of ['NO_PROXY', 'no_proxy']) {
        const saved = process.env[k];
        cleanups.push(() => (saved === undefined ? delete process.env[k] : (process.env[k] = saved)));
        delete process.env[k];
      }
      process.env.no_proxy = 'gateway.example.com';
      const { send } = await setup();
      expect(flagsOf(await send({ id: 'x4', text: 'hi', harness: 'codex' })).noProxy).toBe('gateway.example.com,127.0.0.1');
    });

    it('continues the session with the same settings, and counts only this run’s tokens', async () => {
      const { send } = await setup();
      const first = await send({ id: 'x5', text: 'hi', harness: 'codex' });
      const session = (first[0] as { session: string }).session;
      const second = await send({ id: 'x6', text: 'and now 5 V', harness: 'codex', session });
      const flags = flagsOf(second);
      expect(flags).toMatchObject({ resume: true, rules: true, message: 'and now 5 V', sandbox_mode: 'read-only' });
      expect(flags.mcp_servers).toMatchObject({ 'my.own': { enabled: false } });
      // the CLI reports the session's totals (2 runs); the run's own are the difference
      expect(second.at(-1)).toMatchObject({ kind: 'done', ok: true, session, tokens: { input: 600, cacheRead: 400, output: 50 } });
    });

    it('allows the web only when the user does', async () => {
      const { send } = await setup();
      expect(flagsOf(await send({ id: 'x7', text: 'look it up', harness: 'codex', web: true }))).toMatchObject({ web_search: 'live', webRules: true });
    });

    it('passes the effort level, and asks again without it when the model does not have that one', async () => {
      const { send } = await setup();
      expect(flagsOf(await send({ id: 'x8', text: 'think', harness: 'codex', model: 'gpt-fake', effort: 'high' }))).toMatchObject({ model: 'gpt-fake', model_reasoning_effort: 'high' });
      const es = await send({ id: 'x9', text: 'think', harness: 'codex', model: 'gpt-old', effort: 'max' });
      expect(es).toContainEqual({ kind: 'status', text: expect.stringContaining('does not take that effort level') });
      expect(flagsOf(es).model_reasoning_effort).toBeUndefined();
      expect(es.at(-1)).toMatchObject({ kind: 'done', ok: true });
    });

    it('leaves out a version that would strip the tools’ schema, and says to update', async () => {
      process.env.FAKE_CODEX_VERSION = '0.157.1';
      cleanups.push(() => delete process.env.FAKE_CODEX_VERSION);
      const { codex } = await setup();
      expect(codex.detect()).toMatchObject({ available: false, version: 'codex-cli 0.157.1', reason: expect.stringContaining('codex update') });
      process.env.FAKE_CODEX_VERSION = '0.158.0';
      expect(codex.detect()).toMatchObject({ available: true });
    });

    it('lists the models it offers, and not the internal ones', async () => {
      const { codex } = await setup();
      expect(await codex.models()).toEqual(['gpt-fake']);
    });

    it('shows an API error as a person can read it', async () => {
      const { send } = await setup();
      const es = await send({ id: 'x10', text: 'please fail', harness: 'codex' });
      expect(es.at(-1)).toMatchObject({ kind: 'done', ok: false, error: 'Your organization has run out of credits.', session: (es[0] as { session: string }).session });
    });

    it('goes on while it reconnects, and says what to do about a refused login', async () => {
      const { send } = await setup();
      const es = await send({ id: 'x11', text: 'not signed in', harness: 'codex' });
      expect(es.filter((e) => e.kind === 'status')).toEqual([{ kind: 'status', text: expect.stringContaining('Reconnecting... 1/5') }]);
      expect(es.at(-1)).toMatchObject({ kind: 'done', ok: false, error: expect.stringContaining('codex login') });
    });

    it('reports an error when the CLI ends without finishing the turn, or says why it could not start', async () => {
      const { send } = await setup();
      expect((await send({ id: 'x12', text: 'please crash', harness: 'codex' })).at(-1)).toMatchObject({ kind: 'done', ok: false, error: 'stream disconnected' });
      expect((await send({ id: 'x13', text: 'hi', harness: 'codex', session: 'gone' })).at(-1)).toMatchObject({ kind: 'done', ok: false, error: expect.stringContaining('Codex CLI exited (1): ') });
    });
  });

  describe('OpenCode', () => {
    it('runs its own agent with only the 4k7 tools and gets the last step from the export', async () => {
      const { send, calls } = await setup();
      const es = await send({ id: 'o1', text: 'build a "buck"\nwith 2 A', harness: 'opencode', model: 'github-copilot/claude-sonnet-5' });
      expect(es[0]).toEqual({ kind: 'session', session: 'ses_fake1' });
      expect(calls).toEqual(['get_context']);
      // the stream stopped after the tool call; the reply came from `opencode export`
      const flags = flagsOf(es);
      expect(text(es)).toMatch(/^Done\. flags=/);
      expect(flags).toMatchObject({
        message: 'build a "buck"\nwith 2 A', // stdin: exactly as typed
        agentTools: { '*': false, '4k7_*': true },
        permission: { edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' },
        rules: true,
        web: false,
        model: 'github-copilot/claude-sonnet-5',
      });
      expect(flags.tools).toContain('design_edit');
      // both steps counted once (streamed and exported), reasoning as output
      expect(es.at(-1)).toMatchObject({
        kind: 'done',
        ok: true,
        session: 'ses_fake1',
        costUsd: 0.006,
        tokens: { input: 1000, output: 110, cacheRead: 11000, cacheWrite: 100, model: 'github-copilot/claude-sonnet-5' },
      });
    });

    it('continues the session and allows the web when asked', async () => {
      const { send } = await setup();
      await send({ id: 'o1', text: 'first', harness: 'opencode' });
      const es = await send({ id: 'o2', text: 'second', harness: 'opencode', session: 'ses_fake1', web: true });
      expect(es.some((e) => e.kind === 'session')).toBe(false); // same session, nothing new to tell
      expect(flagsOf(es)).toMatchObject({ message: 'second', web: true, agentTools: { webfetch: true }, permission: { webfetch: 'allow' } });
      // only the steps after this message
      expect(es.at(-1)).toMatchObject({ kind: 'done', ok: true, costUsd: 0.006 });
    });

    it('reports errors from OpenCode', async () => {
      const { send } = await setup();
      const es = await send({ id: 'o3', text: 'please fail', harness: 'opencode' });
      expect(es.at(-1)).toMatchObject({ kind: 'done', ok: false, error: 'Model not found: nope/nope' });
    });
  });

  it('refuses an agent the server does not know', async () => {
    const { send } = await setup();
    const es = await send({ id: 'x1', text: 'hi', harness: 'gemini-cli' });
    expect(es.at(-1)).toMatchObject({ kind: 'done', ok: false, error: expect.stringContaining('cannot run gemini-cli') });
  });
});
