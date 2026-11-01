import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_PORTS } from '@4k7/schema';
import { candidateDirs, checkForUpdate, compareVersions, extendPathFor, LocalServer, storageHandler } from '../src/index.ts';
import { appHandler, serves4k7 } from '../src/app.ts';
import { launchApp, mcpCommand } from '../src/launch.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('update check', () => {
  it('orders versions, pre-releases before their release', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBe(-1);
    expect(compareVersions('0.2.0-beta.2', '0.2.0-beta.1')).toBe(1);
  });

  it('reports a newer release, remembers the answer for a day, and is quiet when up to date', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tw-update-')), 'update.json');
    let fetches = 0;
    const fetchLatest = async () => {
      fetches++;
      return '0.2.0';
    };
    let t = 1_000_000;
    const now = () => t;
    expect(await checkForUpdate('0.1.0', file, { fetchLatest, now })).toEqual({ version: '0.2.0', url: expect.stringContaining('4k7.dev') });
    expect(fetches).toBe(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).latest).toBe('0.2.0');

    // within the day: no new request, same answer
    t += 60 * 60 * 1000;
    expect(await checkForUpdate('0.1.0', file, { fetchLatest, now })).toMatchObject({ version: '0.2.0' });
    expect(fetches).toBe(1);
    // already on it (or beyond): nothing
    expect(await checkForUpdate('0.2.0', file, { fetchLatest, now })).toBeNull();
    expect(await checkForUpdate('0.3.0', file, { fetchLatest, now })).toBeNull();

    // a day later it asks again
    t += 25 * 60 * 60 * 1000;
    await checkForUpdate('0.1.0', file, { fetchLatest, now });
    expect(fetches).toBe(2);
  });

  it('treats a failed request as no update', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tw-update-')), 'update.json');
    expect(await checkForUpdate('0.1.0', file, { fetchLatest: () => Promise.reject(new Error('offline')) })).toBeNull();
    expect(existsSync(file)).toBe(false);
  });
});

describe('finding claude outside a terminal', () => {
  it('adds the install directory that makes the probe succeed to PATH, and nothing when none does', () => {
    const original = process.env.PATH;
    cleanups.push(() => {
      process.env.PATH = original;
    });
    const dir = mkdtempSync(join(tmpdir(), 'tw-claude-'));
    const bin = join(dir, 'claude');
    writeFileSync(bin, '#!/bin/sh\necho 1.0.0\n');
    chmodSync(bin, 0o755);
    // "found" = our fake is on PATH (the real claude may well be there already)
    const probe = () => (process.env.PATH ?? '').split(delimiter).includes(dir);

    expect(extendPathFor(probe, { candidates: [join(dir, 'nowhere')], shell: false })).toBeNull();
    expect(process.env.PATH).toBe(original);

    expect(extendPathFor(probe, { candidates: [join(dir, 'nowhere'), dir], shell: false })).toEqual([join(dir, 'nowhere'), dir]);
    expect(process.env.PATH!.split(delimiter)[1]).toBe(dir);
    // already found: nothing to add
    expect(extendPathFor(probe, { candidates: [dir], shell: false })).toBeNull();
  });

  it('lists only directories that exist, nvm versions newest first', () => {
    const home = mkdtempSync(join(tmpdir(), 'tw-home-'));
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    for (const v of ['v20.1.0', 'v22.10.0', 'v22.9.0']) mkdirSync(join(home, '.nvm', 'versions', 'node', v, 'bin'), { recursive: true });
    const dirs = candidateDirs(home).filter((d) => d.startsWith(home));
    expect(dirs[0]).toBe(join(home, '.local', 'bin'));
    expect(dirs.slice(1)).toEqual(['v22.10.0', 'v22.9.0', 'v20.1.0'].map((v) => join(home, '.nvm', 'versions', 'node', v, 'bin')));
  });
});

describe('the command for Claude Code', () => {
  it('is the launcher of the download, wherever it was put', () => {
    expect(mcpCommand('/Applications/4k7.app/Contents/MacOS/4k7', 'darwin')).toBe('/Applications/4k7.app/Contents/MacOS/4k7 mcp');
    expect(mcpCommand('/home/me/my apps/4k7/4k7', 'linux')).toBe('"/home/me/my apps/4k7/4k7" mcp');
    expect(mcpCommand('C:\\Users\\me\\4k7\\4k7.cmd', 'win32')).toBe('cmd /c "C:\\Users\\me\\4k7\\4k7.cmd" mcp');
  });

  it('is left to the app when not started by a launcher', () => {
    expect(mcpCommand('', 'darwin')).toBeUndefined();
  });
});

describe('idle exit', () => {
  it('tells when the first tab connects and when the last one leaves', async () => {
    const events: boolean[] = [];
    const base = 20000 + Math.floor(Math.random() * 20000);
    const server = new LocalServer({ accessKey: '0cd22f19-30de-4d39-9287-ab0123456789', ports: [base], devPorts: [5173], onTab: (c) => events.push(c) });
    const port = await server.start();
    cleanups.push(() => server.stop());
    const { default: WebSocket } = await import('ws');
    const tab = (): Promise<InstanceType<typeof WebSocket>> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'http://localhost:5173' } });
        ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 2, accessKey: '0cd22f19-30de-4d39-9287-ab0123456789', client: 'test' })));
        ws.on('message', (raw) => JSON.parse(String(raw)).type === 'welcome' && resolve(ws));
      });
    const a = await tab();
    expect(events).toEqual([true]);
    const b = await tab(); // replaces a: still one tab, no event
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toEqual([true]);
    b.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toEqual([true, false]);
    a.close();
  });
});

describe('4k7pcb app', () => {
  it('starts the server detached when none runs, and only opens the link when one does', async () => {
    // a stub `open`/`xdg-open` so no browser appears (Windows opens it through cmd, so no browser at all there); its own home so the real config is untouched
    const windows = process.platform === 'win32';
    const stub = mkdtempSync(join(tmpdir(), 'tw-stub-'));
    for (const name of ['open', 'xdg-open']) {
      writeFileSync(join(stub, name), `#!/bin/sh\necho "$1" >> "${stub}/opened"\n`);
      chmodSync(join(stub, name), 0o755);
    }
    const env = { PATH: process.env.PATH, FOURK7_HOME: process.env.FOURK7_HOME, FOURK7_ACCESS_KEY: process.env.FOURK7_ACCESS_KEY, FOURK7_NO_UPDATE_CHECK: process.env.FOURK7_NO_UPDATE_CHECK, FOURK7_NO_OPEN: process.env.FOURK7_NO_OPEN };
    cleanups.push(() => {
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    process.env.PATH = `${stub}${delimiter}${process.env.PATH}`;
    process.env.FOURK7_HOME = join(stub, 'home');
    process.env.FOURK7_ACCESS_KEY = '0cd22f19-30de-4d39-9287-ab0123456789';
    process.env.FOURK7_NO_UPDATE_CHECK = '1';
    if (windows) process.env.FOURK7_NO_OPEN = '1';

    const before = new Set<number>();
    for (const p of SERVER_PORTS) if (await serves4k7(p)) before.add(p);
    if (SERVER_PORTS.slice(1).every((p) => before.has(p))) return; // every port this one can take is busy on this machine: nothing to test

    // a server that answers with another key (one run from source, say): its page would refuse this key's link, so it does not count
    const accessKey = '11111111-2222-4333-8444-555555555555';
    const foreign = new LocalServer({ accessKey, ports: [20000 + Math.floor(Math.random() * 20000)] });
    const foreignPort = await foreign.start();
    cleanups.push(() => foreign.stop());
    const foreignStorage = storageHandler({ accessKey, projectsDir: join(stub, 'foreign'), dataDir: join(stub, 'foreign'), allowedOrigin: () => true });
    const foreignApp = appHandler(null, '9.9.9', accessKey);
    foreign.setHttpHandler((req, res) => ((req.url ?? '').startsWith('/api/') ? foreignStorage(req, res) : foreignApp(req, res)));
    expect(await serves4k7(foreignPort)).toBe(true);

    // ports that already serve (another server on this computer) are left out, so a new one is started
    const launch = { script: fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ports: [foreignPort, ...SERVER_PORTS.filter((p) => !before.has(p))] };
    const logs: string[] = [];
    await launchApp({ ...launch, log: (m) => logs.push(m) });
    const pid = Number(/pid (\d+)/.exec(logs[0] ?? '')?.[1]);
    expect(pid, logs.join('\n')).toBeGreaterThan(0);
    cleanups.push(() => {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    });
    // the detached server comes up on a free port and opens the app
    let port: number | null = null;
    for (let i = 0; i < 100 && port === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
      for (const p of SERVER_PORTS) if (!before.has(p) && (await serves4k7(p))) port = p;
    }
    expect(port).not.toBeNull();
    // run from source (this test's script): the first port stays free for the installed app
    expect(port).not.toBe(SERVER_PORTS[0]);
    if (!windows) {
      for (let i = 0; i < 50 && !existsSync(join(stub, 'opened')); i++) await new Promise((r) => setTimeout(r, 100));
      expect(readFileSync(join(stub, 'opened'), 'utf8')).toContain('/0cd22f19-30de-4d39-9287-ab0123456789');
    }

    // launched again: the running server is reused and only the link opens
    const again: string[] = [];
    await launchApp({ ...launch, log: (m) => again.push(m) });
    expect(again[0]).toMatch(/already running/);
    if (!windows) {
      const opened = () => readFileSync(join(stub, 'opened'), 'utf8').trim().split('\n');
      for (let i = 0; i < 50 && opened().length < 2; i++) await new Promise((r) => setTimeout(r, 100));
      expect(opened()).toHaveLength(2);
    }
    expect(readFileSync(join(stub, 'home', 'server.log'), 'utf8')).toContain('on 127.0.0.1:');
  });
});
