import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectFileName, storageHandler } from '../src/storage.ts';

const KEY = '0cd22f19-30de-4d39-9287-ab0123456789';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

async function start() {
  const root = mkdtempSync(join(tmpdir(), '4k7-storage-'));
  const projectsDir = join(root, 'projects');
  const dataDir = join(root, 'data');
  const revealed: string[] = [];
  const handler = storageHandler({
    accessKey: KEY,
    projectsDir,
    dataDir,
    allowedOrigin: (o) => o === 'http://localhost:5173',
    reveal: (d) => revealed.push(d),
  });
  const http: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => http.close());
  const port = (http.address() as { port: number }).port;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}/api/${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, ...(init.headers as Record<string, string>) } });
  return { api, port, projectsDir, dataDir, revealed };
}

describe('storage on this computer', () => {
  it('needs the access key and one of the app\'s origins', async () => {
    const { api, port } = await start();
    expect((await fetch(`http://127.0.0.1:${port}/api/projects`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await api('projects', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const ok = await api('projects', { headers: { origin: 'http://localhost:5173' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('keeps one file per project, named after the design', async () => {
    const { api, projectsDir } = await start();
    const created = await api('projects', { method: 'POST', body: '{"name":"LED blinker","seq":1}' });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: 'LED blinker' });
    // the same name again gets a number
    expect(await (await api('projects', { method: 'POST', body: '{"name":"LED blinker"}' })).json()).toEqual({ id: 'LED blinker 2' });
    expect(readdirSync(projectsDir).sort()).toEqual(['LED blinker 2.twd.json', 'LED blinker.twd.json']);

    expect((await api(`projects/${encodeURIComponent('LED blinker')}`, { method: 'PUT', body: '{"name":"LED blinker","seq":2}' })).status).toBe(204);
    expect(await (await api(`projects/${encodeURIComponent('LED blinker')}`)).text()).toBe('{"name":"LED blinker","seq":2}');
    const list = (await (await api('projects')).json()) as { id: string }[];
    expect(list.map((p) => p.id).sort()).toEqual(['LED blinker', 'LED blinker 2']);
    expect((await api('projects/missing')).status).toBe(404);
  });

  it('renames a project\'s file, never over another one', async () => {
    const { api, projectsDir } = await start();
    await api('projects', { method: 'POST', body: '{"name":"a"}' });
    await api('projects', { method: 'POST', body: '{"name":"b"}' });
    expect(await (await api('projects/a/rename', { method: 'POST', body: '{"name":"b"}' })).json()).toEqual({ id: 'b 2' });
    expect(readdirSync(projectsDir).sort()).toEqual(['b 2.twd.json', 'b.twd.json']);
    // its own name: nothing moves
    expect(await (await api('projects/b/rename', { method: 'POST', body: '{"name":"b"}' })).json()).toEqual({ id: 'b' });
  });

  it('refuses names that leave the folder', async () => {
    const { api } = await start();
    expect((await api(`projects/${encodeURIComponent('../escape')}`, { method: 'PUT', body: '{}' })).status).toBe(400);
    expect((await api('projects/.hidden', { method: 'PUT', body: '{}' })).status).toBe(400);
    expect(projectFileName('../a/b:c')).toBe('-a-b-c');
    expect(projectFileName('  ')).toBe('untitled');
  });

  it('keeps library records as JSON files, and leaves one in place when asked to', async () => {
    const { api, dataDir } = await start();
    expect(await (await api('records/library')).json()).toEqual([]);
    expect((await api('records/library/user%2Fne555', { method: 'PUT', body: '{"id":"user/ne555","format":1}' })).status).toBe(204);
    expect(existsSync(join(dataDir, 'library', 'user%2Fne555.json'))).toBe(true);
    await api('records/library/user%2Fne555?ifAbsent=1', { method: 'PUT', body: '{"id":"user/ne555","format":9}' });
    expect(await (await api('records/library')).json()).toEqual([{ id: 'user/ne555', format: 1 }]);
    expect((await api('records/library/x', { method: 'PUT', body: 'not json' })).status).toBe(400);
    expect((await api('records/library/user%2Fne555', { method: 'DELETE' })).status).toBe(204);
    expect(await (await api('records/library')).json()).toEqual([]);
    expect((await api('records/other')).status).toBe(404);
  });

  it('keeps datasheets by hash with their names', async () => {
    const { api, dataDir } = await start();
    const hash = 'a'.repeat(64);
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 255]);
    expect((await api(`datasheets/${hash}`, { method: 'PUT', body: pdf, headers: { 'x-name': encodeURIComponent('NE555 – TI.pdf') } })).status).toBe(204);
    const r = await api(`datasheets/${hash}`);
    expect(decodeURIComponent(r.headers.get('x-name')!)).toBe('NE555 – TI.pdf');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(pdf);
    expect(readFileSync(join(dataDir, 'datasheets', `${hash}.pdf`))).toEqual(Buffer.from(pdf));
    await api(`datasheets/${hash}`, { method: 'DELETE' });
    expect((await api(`datasheets/${hash}`)).status).toBe(404);
    expect((await api('datasheets/nothex')).status).toBe(404);
  });

  it('shows the projects folder', async () => {
    const { api, projectsDir, revealed } = await start();
    expect(await (await api('storage')).json()).toMatchObject({ projectsDir });
    expect((await api('reveal', { method: 'POST' })).status).toBe(204);
    expect(revealed).toEqual([projectsDir]);
  });
});
