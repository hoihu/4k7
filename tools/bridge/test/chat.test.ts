import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { BRIDGE_PROTOCOL, type BridgeToTab, type ChatEvent } from '@tracewise/schema';
import { Bridge, ChatRunner, detectClaude, mcpHttpHandler, type ClaudeProfile } from '../src/index.ts';

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(bin = FAKE, profile?: ClaudeProfile) {
  const base = 40000 + Math.floor(Math.random() * 20000);
  const bridge = new Bridge({ code: '123456', ports: [base, base + 1] });
  const port = await bridge.start();
  cleanups.push(() => bridge.stop());
  const capability = detectClaude(bin, profile);
  const chat = new ChatRunner({ bridge, claudeBin: bin, workDir: mkdtempSync(join(tmpdir(), 'tw-chat-')), ...(profile ? { profile } : {}) });
  bridge.setChatHandler(chat.handle, capability);
  bridge.setHttpHandler(mcpHttpHandler(bridge, (t) => chat.isValidToken(t)));

  // a tab that answers tool calls
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'http://localhost:5173' } });
  cleanups.push(() => ws.close());
  const calls: string[] = [];
  const events = new Map<string, ChatEvent[]>();
  const welcome = await new Promise<BridgeToTab>((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL, code: '123456', client: 'test' })));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as BridgeToTab;
      if (m.type === 'welcome') resolve(m);
      if (m.type === 'call') {
        calls.push(m.tool);
        ws.send(JSON.stringify({ type: 'result', id: m.id, isError: false, content: [{ type: 'text', text: '<design_state>empty</design_state>' }] }));
      }
      if (m.type === 'chat_event') events.set(m.id, [...(events.get(m.id) ?? []), m.event]);
    });
  });
  const send = (id: string, text: string, session: string | null = null, model?: string) =>
    new Promise<ChatEvent[]>((resolve) => {
      ws.send(JSON.stringify({ type: 'chat', id, text, session, autonomy: 'review', ...(model ? { model } : {}) }));
      const t = setInterval(() => {
        if (events.get(id)?.some((e) => e.kind === 'done')) {
          clearInterval(t);
          resolve(events.get(id)!);
        }
      }, 20);
    });
  return { bridge, port, welcome, calls, send };
}

const text = (es: ChatEvent[]) => es.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).join('');

describe('app chat via Claude Code', () => {
  it('announces the capability to the tab', async () => {
    const { welcome } = await setup();
    expect(welcome).toMatchObject({ type: 'welcome', chat: { available: true, version: '2.1.282 (Claude Code, fake)' } });
  });

  it('runs claude headlessly with only the Tracewise tools and streams the reply', async () => {
    const { send, calls } = await setup();
    const es = await send('c1', 'build a buck', null, 'sonnet');
    expect(es[0]).toEqual({ kind: 'session', session: 'sess-1234' });
    expect(es.at(-1)).toMatchObject({ kind: 'done', ok: true, costUsd: 0.012, session: 'sess-1234' });

    const reply = text(es);
    expect(reply).toContain('Got it.');
    expect(reply).not.toContain('(full message)'); // streamed deltas win over the final message
    // it reached the tab through the token-protected HTTP MCP endpoint
    expect(calls).toEqual(['get_context']);
    expect(reply).toContain('tools=get_context,design_query,design_edit,calc,get_schematic_image,propose ');
    const flags = JSON.parse(reply.slice(reply.indexOf('flags=') + 6));
    expect(flags).toMatchObject({ tools: '', strict: true, allowed: 'mcp__tracewise', permission: 'dontAsk', model: 'sonnet', prompt: 'build a buck' });
    expect(flags.appended).toMatch(/^You are answering messages typed into/);
  });

  it('runs Claude with the configured profile, like a claude-personal alias', async () => {
    // a shell set up for a business account on Bedrock, started from inside a Claude Code session
    const saved = { ...process.env };
    Object.assign(process.env, { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_API_KEY: 'sk-test', CLAUDECODE: '1' });
    delete process.env.CLAUDE_CONFIG_DIR;
    cleanups.push(() => {
      for (const k of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
    const { send } = await setup(FAKE, {
      configDir: '/Users/someone/.claude-personal',
      unsetEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
      env: {},
    });
    const reply = text(await send('p1', 'hi'));
    const flags = JSON.parse(reply.slice(reply.indexOf('flags=') + 6));
    expect(flags.env).toEqual({ configDir: '/Users/someone/.claude-personal', bedrock: false, vertex: false, apiKey: false, nested: false });
  });

  it('resumes the session on the next message', async () => {
    const { send } = await setup();
    const es = await send('c2', 'and now make it 5 V', 'sess-9999');
    expect(es[0]).toEqual({ kind: 'session', session: 'sess-9999' });
  });

  it('reports errors from Claude Code', async () => {
    const { send } = await setup();
    const es = await send('c3', 'please fail');
    expect(es.at(-1)).toMatchObject({ kind: 'done', ok: false, error: 'boom' });
  });

  it('explains when the CLI is missing', async () => {
    const { welcome, send } = await setup('/nonexistent/claude');
    expect(welcome).toMatchObject({ chat: { available: false } });
    const es = await send('c4', 'hi');
    expect(es.at(-1)).toMatchObject({ kind: 'done', ok: false });
  });

  it('refuses MCP requests without a live token, and from browsers', async () => {
    const { port } = await setup();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    expect((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { ...headers, authorization: 'Bearer nope' }, body })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
  });
});
