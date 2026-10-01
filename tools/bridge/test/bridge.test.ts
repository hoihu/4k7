import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Kernel } from '@tracewise/kernel';
import { BRIDGE_PROTOCOL, type BridgeToTab } from '@tracewise/schema';
import { Bridge, createMcpServer } from '../src/index.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function startBridge(code = '123456') {
  const base = 40000 + Math.floor(Math.random() * 20000);
  const bridge = new Bridge({ code, ports: [base, base + 1] });
  const port = await bridge.start();
  cleanups.push(() => bridge.stop());
  return { bridge, port };
}

/** A fake browser tab that executes design_edit / design_query against a real kernel. */
function connectTab(port: number, code: string, origin = 'http://localhost:5173') {
  const kernel = new Kernel();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin } });
  cleanups.push(() => ws.close());
  const messages: BridgeToTab[] = [];
  const closed = new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
  const welcomed = new Promise<BridgeToTab>((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL, code, client: 'test-tab' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as BridgeToTab;
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

describe('bridge pairing', () => {
  it('pairs with the right code and forwards calls', async () => {
    const { bridge, port } = await startBridge();
    const tab = connectTab(port, '123456');
    expect(await tab.welcomed).toMatchObject({ type: 'welcome' });
    expect(bridge.connected).toBe(true);
    const r = await bridge.call('design_query', { op: 'search_parts', text: 'buck' });
    expect(r.isError).toBe(false);
    expect(JSON.parse((r.content[0] as { text: string }).text)[0].id).toBe('ti:TPS54331DR');
  });

  it('rejects a wrong code', async () => {
    const { bridge, port } = await startBridge();
    const tab = connectTab(port, '000000');
    expect(await tab.welcomed).toMatchObject({ type: 'denied', reason: 'wrong pairing code' });
    await tab.closed;
    expect(bridge.connected).toBe(false);
  });

  it('rejects pages from other origins before any pairing', async () => {
    const { bridge, port } = await startBridge();
    const tab = connectTab(port, '123456', 'https://evil.example');
    expect(await tab.closed).toBe(1008);
    expect(bridge.connected).toBe(false);
  });

  it('tells the agent how to pair when no tab is connected', async () => {
    const { bridge, port } = await startBridge('654321');
    const r = await bridge.call('get_context', {});
    expect(r.isError).toBe(true);
    const msg = (r.content[0] as { text: string }).text;
    expect(msg).toContain('654321');
    expect(msg).toContain(String(port));
  });

  it('falls through to the next port when one is taken', async () => {
    const base = 40000 + Math.floor(Math.random() * 20000);
    const a = new Bridge({ code: '111111', ports: [base, base + 1] });
    const b = new Bridge({ code: '222222', ports: [base, base + 1] });
    expect(await a.start()).toBe(base);
    expect(await b.start()).toBe(base + 1);
    cleanups.push(() => a.stop(), () => b.stop());
  });

  it('fails pending calls when the tab goes away', async () => {
    const { bridge, port } = await startBridge();
    const kernelLess = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'http://127.0.0.1:4173' } });
    await new Promise((r) => kernelLess.on('open', r));
    kernelLess.send(JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL, code: '123456', client: 'silent' }));
    await new Promise((r) => kernelLess.on('message', r));
    const pending = bridge.call('design_query', { op: 'get_summary' });
    kernelLess.close();
    const r = await pending;
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/disconnected/);
  });
});

describe('MCP server', () => {
  it('lists the tools and drives the kernel through a paired tab', async () => {
    const { bridge, port } = await startBridge();
    const tab = connectTab(port, '123456');
    await tab.welcomed;

    const server = createMcpServer(bridge);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: 'claude-code', version: '1.0.0' });
    await client.connect(clientT);
    cleanups.push(() => client.close());

    expect(client.getInstructions()).toMatch(/Tracewise/);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(['get_context', 'design_query', 'design_edit', 'calc', 'import_part', 'pending_import', 'artwork', 'read_datasheet', 'get_schematic_image', 'propose', 'wait_for_review']);

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
