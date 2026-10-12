import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { SERVER_PROTOCOL, type ChatEvent, type HarnessCapability, type ServerToTab } from '@4k7/schema';
import { ChatRunner, CopilotHarness, LocalServer, OpenCodeHarness, mcpHttpHandler } from '../src/index.ts';
import { tinyPdf } from './pdf-fixture.ts';

const KEY = '0cd22f19-30de-4d39-9287-ab0123456789';
const fake = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const base = 40000 + Math.floor(Math.random() * 20000);
  const server = new LocalServer({ accessKey: KEY, ports: [base, base + 1], devPorts: [5173] });
  const port = await server.start();
  cleanups.push(() => server.stop());
  const workDir = mkdtempSync(join(tmpdir(), 'tw-chat-'));
  const copilot = new CopilotHarness(fake('fake-copilot.mjs'));
  const opencode = new OpenCodeHarness(fake('fake-opencode.mjs'), workDir);
  const harnesses: HarnessCapability[] = [copilot.detect(), opencode.detect()];
  const ingestDir = mkdtempSync(join(tmpdir(), 'tw-ingest-'));
  const chat = new ChatRunner({ server, claudeBin: fake('fake-claude.mjs'), workDir, ingestDir, harnesses: [copilot, opencode] });
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
        const answer = m.tool === 'submit_part' ? `checked ${(m.input as { mpn: string }).mpn}` : '<design_state>empty</design_state>';
        ws.send(JSON.stringify({ type: 'result', id: m.id, isError: false, content: [{ type: 'text', text: answer }] }));
      }
      if (m.type === 'chat_event') events.set(m.id, [...(events.get(m.id) ?? []), m.event]);
    });
  });
  const send = (msg: { id: string; text: string; harness: string; session?: string | null; model?: string; web?: boolean }) =>
    new Promise<ChatEvent[]>((resolve) => {
      ws.send(JSON.stringify({ type: 'chat', session: null, autonomy: 'review', ...msg }));
      const t = setInterval(() => {
        if (events.get(msg.id)?.some((e) => e.kind === 'done')) {
          clearInterval(t);
          resolve(events.get(msg.id)!);
        }
      }, 20);
    });
  const run = (msg: Record<string, unknown>) =>
    new Promise<ChatEvent[]>((resolve) => {
      ws.send(JSON.stringify(msg));
      const t = setInterval(() => {
        if (events.get(msg.id as string)?.some((e) => e.kind === 'done')) {
          clearInterval(t);
          resolve(events.get(msg.id as string)!);
        }
      }, 20);
    });
  const ingest = (id: string, harness: string, extra: Record<string, unknown> = {}) =>
    run({ type: 'ingest', id, harness, mpn: 'STM32F777VIT6', pdf: { name: 'ds.pdf', base64: tinyPdf('Table 11. Pin definitions') }, ...extra });
  return { server, welcome, pushed, calls, send, ingest, opencode, ingestDir };
}

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
        { id: 'copilot', name: 'GitHub Copilot CLI', available: true, ingest: true, version: 'GitHub Copilot CLI 1.0.95 (fake).' },
        { id: 'opencode', name: 'OpenCode', available: true, ingest: true, version: '1.15.10' },
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
    it('lists the models of its catalogue', async () => {
      expect(await new CopilotHarness(fake('fake-copilot.mjs')).models()).toEqual(['auto', 'claude-sonnet-5', 'gpt-6-luna']);
    });

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

    it('reports why the CLI failed', async () => {
      const { send } = await setup();
      const es = await send({ id: 'f1', text: 'please fail', harness: 'copilot' });
      expect(es.at(-1)).toMatchObject({ kind: 'done', ok: false, error: expect.stringContaining('GitHub Copilot CLI exited (1): Error: Model "nope"') });
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

  describe('datasheet import', () => {
    it('runs Copilot with only its read-only file tools in the datasheet folder, and submit_part', async () => {
      const { ingest, calls, ingestDir } = await setup();
      const es = await ingest('i1', 'copilot', { model: 'claude-sonnet-5' });
      expect(es.at(-1)).toMatchObject({ kind: 'done', ok: true });
      expect(calls).toEqual(['submit_part']);
      const flags = flagsOf(es);
      expect(flags).toMatchObject({
        available: ['view', 'grep', 'glob', '4k7'],
        allowed: ['4k7'],
        tempDir: false,
        builtinMcps: false,
        customInstructions: false,
        rules: true,
        verify: false,
        model: 'claude-sonnet-5',
        files: ['datasheet.pdf', 'index.txt', 'pages'],
      });
      expect(flags.message).toBe('Create the part for STM32F777VIT6 (datasheet: ds.pdf).');
      expect(flags.tools).toEqual(['submit_part']);
      // progress like Claude Code's: pages read, pins written
      const status = es.filter((e) => e.kind === 'status').map((e) => (e as { text: string }).text);
      expect(status).toEqual(['Datasheet: 1 pages, 0.0 MB', 'Reading page 1', 'Searching for “Pinout”', 'Writing the part…', 'Writing the part: 20 pins…', 'Writing the part: 40 pins…']);
      expect(readdirSync(ingestDir)).toEqual([]); // the folder is gone
    });

    it('runs a second, independent Copilot session to verify', async () => {
      const { ingest } = await setup();
      const es = await ingest('i2', 'copilot', { passes: 2 });
      expect(es.filter((e) => e.kind === 'pass')).toEqual([{ kind: 'pass', n: 1, of: 2 }, { kind: 'pass', n: 2, of: 2 }]);
      expect([...text(es).matchAll(/"verify":(true|false)/g)].map((m) => m[1])).toEqual(['false', 'true']);
      expect(es.at(-1)).toMatchObject({ kind: 'done', ok: true });
    });

    it('runs OpenCode as an import agent with read, grep, glob and submit_part, kept inside the folder', async () => {
      const { ingest, calls } = await setup();
      const es = await ingest('i3', 'opencode', { model: 'github-copilot/claude-sonnet-5', passes: 2 });
      expect(es.at(-1)).toMatchObject({ kind: 'done', ok: true, costUsd: 0.012 });
      expect(calls).toEqual(['submit_part', 'submit_part']);
      expect(flagsOf(es.filter((e) => e.kind === 'text').slice(0, 1))).toMatchObject({
        agent: '4k7-ingest',
        agentTools: { '*': false, read: true, grep: true, glob: true, '4k7_*': true },
        permission: { edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' },
        rules: true,
        message: 'Create the part for STM32F777VIT6 (datasheet: ds.pdf).',
        files: ['datasheet.pdf', 'index.txt', 'pages'],
        tools: ['submit_part'],
      });
      expect(es).toContainEqual({ kind: 'status', text: 'Reading page 1' });
      // the closing words of each pass came from the export, run in the job folder
      expect([...text(es).matchAll(/"verify":(true|false)/g)].map((m) => m[1])).toEqual(['false', 'true']);
    });

    it('explains when the agent cannot import', async () => {
      const { ingest } = await setup();
      const es = await ingest('i4', 'gemini-cli');
      expect(es.at(-1)).toMatchObject({ kind: 'done', ok: false, error: expect.stringContaining('cannot import datasheets') });
    });
  });

  it('refuses an agent the server does not know', async () => {
    const { send } = await setup();
    const es = await send({ id: 'x1', text: 'hi', harness: 'gemini-cli' });
    expect(es.at(-1)).toMatchObject({ kind: 'done', ok: false, error: expect.stringContaining('cannot run gemini-cli') });
  });
});
