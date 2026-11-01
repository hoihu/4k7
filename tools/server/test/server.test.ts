import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configDir, installedDir, loadConfig } from '../src/config.ts';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Kernel } from '@4k7/kernel';
import { SERVER_ACCESS_KEY, SERVER_PROTOCOL, type ServerToTab } from '@4k7/schema';
import { LocalServer, createMcpServer, storageHandler } from '../src/index.ts';
import { appHandler, appUrl, PROBE_PATH, serves4k7 } from '../src/app.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const KEY = '0cd22f19-30de-4d39-9287-ab0123456789';
const OTHER = '11111111-2222-4333-8444-555555555555';

async function startServer(accessKey = KEY) {
  const base = 20000 + Math.floor(Math.random() * 20000);
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
    const base = 20000 + Math.floor(Math.random() * 20000);
    const a = new LocalServer({ accessKey: KEY, ports: [base, base + 1] });
    const b = new LocalServer({ accessKey: OTHER, ports: [base, base + 1] });
    expect(await a.start()).toBe(base);
    expect(await b.start()).toBe(base + 1);
    cleanups.push(() => a.stop(), () => b.stop());
  });

  it('falls through a port the system keeps for itself, as Windows does with whole ranges', async () => {
    const base = 20000 + Math.floor(Math.random() * 20000);
    const listen = NetServer.prototype.listen;
    const reserved = vi.spyOn(NetServer.prototype, 'listen').mockImplementation(function (this: NetServer, ...args: unknown[]) {
      if (args[0] !== base) return listen.apply(this, args as never);
      process.nextTick(() => this.emit('error', Object.assign(new Error(`listen EACCES: permission denied 127.0.0.1:${base}`), { code: 'EACCES' })));
      return this;
    });
    cleanups.push(() => reserved.mockRestore());
    const server = new LocalServer({ accessKey: KEY, ports: [base, base + 1] });
    expect(await server.start()).toBe(base + 1);
    cleanups.push(() => server.stop());
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
    expect(tools).toEqual(['get_context', 'design_query', 'design_edit', 'calc', 'import_part', 'sourcing', 'pending_import', 'artwork', 'read_datasheet', 'get_schematic_image', 'get_board_image', 'render_enclosure', 'propose', 'wait_for_review']);

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

describe('which server a link points at', () => {
  /** Put together as main.ts does: answers the probe, and takes its key at the storage. */
  async function serveAll(accessKey: string) {
    const dir = mkdtempSync(join(tmpdir(), 'tw-all-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { server, port } = await startServer(accessKey);
    const app = appHandler(null, '9.9.9', accessKey);
    const storage = storageHandler({ accessKey, projectsDir: join(dir, 'projects'), dataDir: dir, allowedOrigin: () => true });
    server.setHttpHandler((req, res) => ((req.url ?? '').startsWith('/api/') ? storage(req, res) : app(req, res)));
    return port;
  }
  const NOTHING = 'http://127.0.0.1:9';

  it('tells a server that takes this key from one that does not', async () => {
    const port = await serveAll(KEY);
    expect(await serves4k7(port)).toBe(true);
    expect(await serves4k7(port, KEY)).toBe(true);
    expect(await serves4k7(port, OTHER)).toBe(false);
  });

  it('the app opens at the home port when a server there takes its key, else at its own', async () => {
    const home = await serveAll(KEY);
    const notes: string[] = [];
    const link = (accessKey: string, port: number) => appUrl({ port, accessKey, checkout: false, home, devApp: NOTHING, log: (m) => notes.push(m) });
    // on the home port itself: its own address
    expect(await link(KEY, home)).toBeUndefined();
    expect(notes).toEqual([]);
    // a second server of the app
    expect(await link(KEY, home + 1)).toBe(`http://localhost:${home}`);
    expect(notes).toEqual([]);
    // the home port is held by a server with another key (run from source, say): that link would be refused
    expect(await link(OTHER, home + 1)).toBeUndefined();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`http://localhost:${home + 1}`);
  });

  it('run from source, links open the dev server while it answers, else this server, never the home port', async () => {
    const home = await serveAll(KEY);
    const dev = `http://127.0.0.1:${await serveAll(OTHER)}`;
    const link = (devApp: string) => appUrl({ port: home + 1, accessKey: KEY, checkout: true, home, devApp, log: () => {} });
    expect(await link(dev)).toBe(dev);
    expect(await link(NOTHING)).toBeUndefined();
  });
});

describe('config folder', () => {
  /** Runs `fn` with a home folder of its own and none of the settings from the environment. */
  function withHome(fn: (home: string) => void) {
    const home = mkdtempSync(join(tmpdir(), '4k7-home-'));
    // the home folder comes from USERPROFILE on Windows
    const names = ['HOME', 'USERPROFILE', 'FOURK7_HOME', 'FOURK7_PROJECTS', 'FOURK7_ACCESS_KEY', 'FOURK7_APP_URL'];
    const env = names.map((n) => [n, process.env[n]] as const);
    try {
      for (const n of names) delete process.env[n];
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      fn(home);
    } finally {
      for (const [n, v] of env) {
        if (v !== undefined) process.env[n] = v;
        else delete process.env[n];
      }
      rmSync(home, { recursive: true, force: true });
    }
  }

  it('moves ~/.tracewise (the old name) to ~/.4k7 and keeps its access key', () => {
    withHome((home) => {
      mkdirSync(join(home, '.tracewise'));
      const accessKey = '8b1f4d2e-5c3a-4e6f-9a7b-0c1d2e3f4a5b';
      writeFileSync(join(home, '.tracewise', 'server.json'), JSON.stringify({ accessKey, claude: { unsetEnv: ['X'], env: {} } }));
      expect(installedDir()).toBe(join(home, '.4k7'));
      expect(existsSync(join(home, '.tracewise'))).toBe(false);
      process.env.FOURK7_HOME = installedDir();
      expect(loadConfig()).toMatchObject({ accessKey, claude: { unsetEnv: ['X'] } });
      expect(JSON.parse(readFileSync(join(home, '.4k7', 'server.json'), 'utf8')).accessKey).toBe(accessKey);
    });
  });

  it('run from source it keeps to itself: its own key and folders, with the agents and a copy of the libraries', () => {
    withHome((home) => {
      const real = join(home, '.4k7');
      mkdirSync(join(real, 'library'), { recursive: true });
      mkdirSync(join(home, 'Documents'));
      writeFileSync(join(real, 'library', 'part.json'), '{"id":"part"}');
      const realConfig = JSON.stringify({ accessKey: OTHER, claude: { configDir: '~/.other', unsetEnv: ['X'], env: {} }, bins: { codex: '/bin/codex' }, projectsDir: '/real/projects', appUrl: 'http://localhost:1' });
      writeFileSync(join(real, 'server.json'), realConfig);

      expect(configDir()).toBe(join(home, '.4k7-dev'));
      const cfg = loadConfig();
      expect(cfg.accessKey).toMatch(SERVER_ACCESS_KEY);
      expect(cfg.accessKey).not.toBe(OTHER);
      expect(cfg).toMatchObject({ claude: { configDir: join(home, '.other'), unsetEnv: ['X'] }, bins: { codex: '/bin/codex' }, projectsDir: join(home, 'Documents', '4k7-dev') });
      expect(cfg.appUrl).toBeUndefined();
      expect(readFileSync(join(home, '.4k7-dev', 'library', 'part.json'), 'utf8')).toBe('{"id":"part"}');

      // the next start finds it as it was left: the same key, and the copy is not made again
      rmSync(join(home, '.4k7-dev', 'library', 'part.json'));
      expect(loadConfig().accessKey).toBe(cfg.accessKey);
      expect(existsSync(join(home, '.4k7-dev', 'library', 'part.json'))).toBe(false);

      // the real folder is as it was; nothing left beside the new one
      expect(readFileSync(join(real, 'server.json'), 'utf8')).toBe(realConfig);
      expect(existsSync(join(real, 'library', 'part.json'))).toBe(true);
      expect(readdirSync(home).sort()).toEqual(['.4k7', '.4k7-dev', 'Documents']);
    });
  });

  it('run from source with no app set up, it starts with a key of its own and leaves ~/.4k7 alone', () => {
    withHome((home) => {
      const { accessKey, projectsDir } = loadConfig();
      expect(accessKey).toMatch(SERVER_ACCESS_KEY);
      expect(projectsDir).toBe(join(home, '4k7-dev'));
      expect(loadConfig().accessKey).toBe(accessKey);
      expect(existsSync(join(home, '.4k7'))).toBe(false);
    });
  });

  it('honours the folders it is told, also run from source', () => {
    withHome((home) => {
      process.env.FOURK7_HOME = join(home, 'elsewhere');
      process.env.FOURK7_PROJECTS = '~/designs';
      expect(configDir()).toBe(join(home, 'elsewhere'));
      expect(loadConfig().projectsDir).toBe(join(home, 'designs'));
      expect(existsSync(join(home, '.4k7-dev'))).toBe(false);
    });
  });
});
