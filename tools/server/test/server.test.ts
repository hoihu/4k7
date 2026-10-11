import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Kernel } from '@4k7/kernel';
import { SERVER_PROTOCOL, type ServerToTab } from '@4k7/schema';
import { LocalServer, createMcpServer } from '../src/index.ts';
import { appHandler, PROBE_PATH, serves4k7 } from '../src/app.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const KEY = '0cd22f19-30de-4d39-9287-ab0123456789';
const OTHER = '11111111-2222-4333-8444-555555555555';

async function startServer(accessKey = KEY) {
  const base = 40000 + Math.floor(Math.random() * 20000);
  const server = new LocalServer({ accessKey, ports: [base, base + 1], devPorts: [5173] });
  const port = await server.start();
  cleanups.push(() => server.stop());
  return { server, port };
}

/** A fake browser tab that executes design_edit / design_query against a real kernel. */
function connectTab(port: number, accessKey: string, origin = 'http://localhost:5173') {
  const kernel = new Kernel();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin } });
  cleanups.push(() => ws.close());
  const messages: ServerToTab[] = [];
  const closed = new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
  const welcomed = new Promise<ServerToTab>((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: SERVER_PROTOCOL, accessKey, client: 'test-tab' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerToTab;
      messages.push(msg);
      if (msg.type === 'welcome' || msg.type === 'denied') resolve(msg);
      if (msg.type === 'call') {
        let out: unknown;
        if (msg.tool === 'design_edit') out = kernel.transact(msg.input);
        else if (msg.tool === 'design_query') out = kernel.query(msg.input);
        else out = { echo: msg.tool };
        ws.send(JSON.stringify({ type: 'result', id: msg.id, isError: false, content: [{ type: 'text', text: JSON.stringify(out) }] }));
      }
    });
    ws.on('error', reject);
  });
  return { ws, kernel, messages, welcomed, closed };
}

describe('server access', () => {
  it('accepts the tab with the right access key and forwards calls', async () => {
    const { server, port } = await startServer();
    const tab = connectTab(port, KEY);
    expect(await tab.welcomed).toMatchObject({ type: 'welcome' });
    expect(server.connected).toBe(true);
    const r = await server.call('design_query', { op: 'search_parts', text: 'buck' });
    expect(r.isError).toBe(false);
    expect(JSON.parse((r.content[0] as { text: string }).text)[0].id).toBe('ti:TPS54331DR');
  });

  it('rejects a wrong access key', async () => {
    const { server, port } = await startServer();
    const tab = connectTab(port, OTHER);
    expect(await tab.welcomed).toMatchObject({ type: 'denied', reason: 'wrong access key' });
    await tab.closed;
    expect(server.connected).toBe(false);
  });

  it('rejects pages from other origins, local ones on other ports included, before the key is checked', async () => {
    const { server, port } = await startServer();
    for (const origin of ['https://evil.example', 'http://localhost:3000', 'http://127.0.0.1:8888']) {
      const tab = connectTab(port, KEY, origin);
      expect(await tab.closed).toBe(1008);
    }
    expect(server.connected).toBe(false);
  });

  it('accepts the app served by another server port', async () => {
    const { server, port } = await startServer();
    const tab = connectTab(port, KEY, 'http://localhost:7777');
    expect(await tab.welcomed).toMatchObject({ type: 'welcome' });
    expect(server.connected).toBe(true);
  });

  it('gives the agent the app link when no tab is connected', async () => {
    const { server, port } = await startServer(OTHER);
    const r = await server.call('get_context', {});
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain(`http://localhost:${port}/${OTHER}`);
  });

  it('falls through to the next port when one is taken', async () => {
    const base = 40000 + Math.floor(Math.random() * 20000);
    const a = new LocalServer({ accessKey: KEY, ports: [base, base + 1] });
    const b = new LocalServer({ accessKey: OTHER, ports: [base, base + 1] });
    expect(await a.start()).toBe(base);
    expect(await b.start()).toBe(base + 1);
    cleanups.push(() => a.stop(), () => b.stop());
  });

  it('fails pending calls when the tab goes away', async () => {
    const { server, port } = await startServer();
    const kernelLess = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: `http://127.0.0.1:${port}` } });
    await new Promise((r) => kernelLess.on('open', r));
    kernelLess.send(JSON.stringify({ type: 'hello', protocol: SERVER_PROTOCOL, accessKey: KEY, client: 'silent' }));
    await new Promise((r) => kernelLess.on('message', r));
    const pending = server.call('design_query', { op: 'get_summary' });
    kernelLess.close();
    const r = await pending;
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/disconnected/);
  });
});

describe('MCP server', () => {
  it('lists the tools and drives the kernel through a connected tab', async () => {
    const { server, port } = await startServer();
    const tab = connectTab(port, KEY);
    await tab.welcomed;

    const mcp = createMcpServer(server);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverT);
    const client = new Client({ name: 'claude-code', version: '1.0.0' });
    await client.connect(clientT);
    cleanups.push(() => client.close());

    expect(client.getInstructions()).toMatch(/4k7/);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(['get_context', 'design_query', 'design_edit', 'calc', 'import_part', 'jlc_search', 'pending_import', 'artwork', 'read_datasheet', 'get_schematic_image', 'propose', 'wait_for_review']);

    const res = await client.callTool({
      name: 'design_edit',
      arguments: { summary: 'ldo', ops: [{ op: 'add_part', part: 'ams:AMS1117-3.3', refdes: 'U1' }] },
    });
    expect(res.isError).toBe(false);
    expect(tab.kernel.state().summary.components.map((c) => c.refdes)).toEqual(['U1']);

    // the agent name reaches the tab
    await new Promise((r) => setTimeout(r, 20));
    expect(tab.messages.some((m) => m.type === 'agent' && m.name === 'Claude Code')).toBe(true);
  });
});

describe('serving the app', () => {
  async function serveApp() {
    const dir = mkdtempSync(join(tmpdir(), 'tw-app-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>4k7</title>');
    writeFileSync(join(dir, 'assets', 'index-abc.js'), 'export {}');
    writeFileSync(join(dir, '..', 'tw-secret.txt'), 'secret');
    cleanups.push(() => rmSync(join(dir, '..', 'tw-secret.txt'), { force: true }));
    const { server, port } = await startServer();
    server.setHttpHandler(appHandler(dir, '9.9.9', KEY));
    return { server, port };
  }
  const get = (port: number, path: string, host = `localhost:${port}`) =>
    new Promise<{ status: number; type: string; cache: string; body: string }>((resolve, reject) => {
      // node's fetch does not let a Host header be set; http.get does
      httpGet({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), cache: String(res.headers['cache-control']), body }));
      }).on('error', reject);
    });

  it('serves the built app at its access key, with long caching only for hashed assets', async () => {
    const { port } = await serveApp();
    for (const path of [`/${KEY}`, `/${KEY}/`]) {
      const index = await get(port, path);
      expect(index).toMatchObject({ status: 200, type: 'text/html; charset=utf-8', cache: 'no-store' });
      expect(index.body).toContain('<title>4k7</title>');
    }
    expect(await get(port, '/assets/index-abc.js')).toMatchObject({ status: 200, type: 'text/javascript; charset=utf-8', cache: 'public, max-age=31536000, immutable' });
    expect((await get(port, '/nope.js')).status).toBe(404);
  });

  it('serves the page only with the access key, and never gives it away', async () => {
    const { port } = await serveApp();
    for (const path of ['/', '/index.html', `/${OTHER}`]) {
      const r = await get(port, path);
      expect(r.status).toBe(403);
      expect(r.body).toContain('Open 4k7 with its link');
      expect(r.body).not.toContain(KEY);
    }
    expect(JSON.stringify(await get(port, PROBE_PATH))).not.toContain(KEY);
  });

  it('answers the probe, so a second server finds the first', async () => {
    const { port } = await serveApp();
    expect(JSON.parse((await get(port, PROBE_PATH)).body)).toEqual({ name: '4k7-server', version: '9.9.9' });
    expect(await serves4k7(port)).toBe(true);
  });

  it('serves nothing outside the app folder, and only to local host names', async () => {
    const { port } = await serveApp();
    expect((await get(port, '/../tw-secret.txt')).status).not.toBe(200);
    expect((await get(port, '/%2e%2e/tw-secret.txt')).status).toBe(403);
    // DNS rebinding: a website whose name resolves to 127.0.0.1
    expect((await get(port, `/${KEY}`, `evil.example:${port}`)).status).toBe(421);
  });

  it('links to the app it serves, or to the app elsewhere naming its own port', async () => {
    const { server, port } = await startServer();
    expect(server.appLink()).toBe(`http://localhost:${port}/${KEY}`);
    server.setAppUrl('http://localhost:5173/');
    expect(server.appLink()).toBe(`http://localhost:5173/${KEY}?port=${port}`);
  });
});
