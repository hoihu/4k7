import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
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
  const ingestDir = mkdtempSync(join(tmpdir(), 'tw-ingest-'));
  const chat = new ChatRunner({ bridge, claudeBin: bin, workDir: mkdtempSync(join(tmpdir(), 'tw-chat-')), ingestDir, ...(profile ? { profile } : {}) });
  bridge.setChatHandler(chat.handle, capability);
  bridge.setHttpHandler(mcpHttpHandler(bridge, (t) => chat.modeFor(t)));

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
        const answer = m.tool === 'submit_part' ? `checked ${(m.input as { mpn: string }).mpn}` : '<design_state>empty</design_state>';
        ws.send(JSON.stringify({ type: 'result', id: m.id, isError: false, content: [{ type: 'text', text: answer }] }));
      }
      if (m.type === 'chat_event') events.set(m.id, [...(events.get(m.id) ?? []), m.event]);
    });
  });
  const send = (id: string, text: string, session: string | null = null, model?: string, web = false) =>
    new Promise<ChatEvent[]>((resolve) => {
      ws.send(JSON.stringify({ type: 'chat', id, text, session, autonomy: 'review', web, ...(model ? { model } : {}) }));
      const t = setInterval(() => {
        if (events.get(id)?.some((e) => e.kind === 'done')) {
          clearInterval(t);
          resolve(events.get(id)!);
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
  return { bridge, port, welcome, calls, send, run, ingestDir };
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

  it('gives Claude read-only web tools only when the user allows it', async () => {
    const { send } = await setup();
    const flagsOf = (es: ChatEvent[]) => {
      const t = text(es);
      return JSON.parse(t.slice(t.indexOf('flags=') + 6));
    };
    const off = flagsOf(await send('w0', 'no web'));
    expect(off).toMatchObject({ tools: '', allowed: 'mcp__tracewise' });
    const on = flagsOf(await send('w1', 'with web', null, undefined, true));
    expect(on).toMatchObject({ tools: 'WebFetch,WebSearch', allowed: 'mcp__tracewise,WebFetch,WebSearch' });
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

/** A one-page PDF with the given line of text. */
function tinyPdf(line: string): string {
  const stream = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1').toString('base64');
}

describe('datasheet import via Claude Code', () => {
  it('unpacks the PDF into a private folder and gives Claude only files + submit_part', async () => {
    const { run, calls, ingestDir } = await setup();
    const es = await run({ type: 'ingest', id: 'i1', mpn: 'STM32F777VIT6', pdf: { name: 'ds.pdf', base64: tinyPdf('Table 11. Pin definitions') }, model: 'sonnet' });
    expect(es.at(-1)).toMatchObject({ kind: 'done', ok: true });
    expect(es).toContainEqual({ kind: 'status', text: 'Datasheet: 1 pages, 0.0 MB' });
    expect(es).toContainEqual({ kind: 'status', text: 'Reading page 1' });
    const writing = es.filter((e) => e.kind === 'status' && e.text.startsWith('Writing')).map((e) => (e as { text: string }).text);
    expect(writing).toEqual(['Writing the part…', 'Writing the part: 20 pins…', 'Writing the part: 40 pins…']);
    expect(calls).toEqual(['submit_part']);
    const reply = text(es);
    expect(reply).toContain('tools=submit_part ');
    const flags = JSON.parse(reply.slice(reply.indexOf('flags=') + 6));
    expect(flags).toMatchObject({ tools: 'Read,Grep,Glob', strict: true, allowed: 'mcp__tracewise', permission: 'dontAsk', model: 'sonnet' });
    expect(flags.prompt).toBe('Create the part for STM32F777VIT6 (datasheet: ds.pdf).');
    expect(flags.appended).toMatch(/^You extract a part definition/);
    expect(flags.files).toEqual(['datasheet.pdf', 'index.txt', 'pages']);
    // the job folder is removed afterwards
    await new Promise((r) => setTimeout(r, 100));
    expect(readdirSync(ingestDir)).toEqual([]);
    expect(existsSync(join(ingestDir, 'i1'))).toBe(false);
  });

  it('extracts page text with table cells kept apart', async () => {
    const { pdfPages } = await import('../src/index.ts');
    const pages = await pdfPages(new Uint8Array(Buffer.from(tinyPdf('PC0 | I/O'), 'base64')));
    expect(pages).toEqual(['PC0 | I/O']);
    const data = new Uint8Array(Buffer.from(tinyPdf('x'), 'base64'));
    await pdfPages(data);
    expect(data.byteLength).toBeGreaterThan(0); // the caller's buffer is left intact
  });

  it('rejects files that are not PDFs', async () => {
    const { run, calls } = await setup();
    const es = await run({ type: 'ingest', id: 'i2', mpn: 'X', pdf: { name: 'x.pdf', base64: Buffer.from('hello').toString('base64') } });
    expect(es.at(-1)).toMatchObject({ kind: 'done', ok: false, error: 'That is not a PDF file.' });
    expect(calls).toEqual([]);
  });
});
