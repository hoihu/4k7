import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScadRunResult, ScadStatus } from '@4k7/schema';
import { OpenScad, openscadCandidates, sourceProblems } from '../src/scad.ts';
import { storageHandler } from '../src/storage.ts';

const KEY = '0cd22f19-30de-4d39-9287-ab0123456789';
const FAKE = join(import.meta.dirname, 'fake-openscad.mjs');
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  delete process.env.FOURK7_OPENSCAD_BIN;
});

async function start(scad: OpenScad) {
  const root = mkdtempSync(join(tmpdir(), '4k7-scad-test-'));
  const handler = storageHandler({ accessKey: KEY, projectsDir: join(root, 'p'), dataDir: join(root, 'd'), allowedOrigin: () => true, scad });
  const http: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => http.close());
  const port = (http.address() as { port: number }).port;
  return (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}/api/${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, ...(init.headers as Record<string, string>) } });
}

describe('OpenSCAD on this computer', () => {
  it('only lets a job include its own files, and read nothing', () => {
    expect(sourceProblems('include <board.scad>\ncube(1);', ['board.scad'])).toEqual([]);
    expect(sourceProblems('use <enclosure.scad>\ninclude <board.scad>', ['board.scad', 'enclosure.scad'])).toEqual([]);
    expect(sourceProblems('include </etc/passwd>', ['board.scad'])).toHaveLength(1);
    expect(sourceProblems('import("/Users/me/secret.stl");', ['board.scad'])).toHaveLength(1);
    expect(sourceProblems('// import("x.stl");\n/* surface("y") */', [])).toEqual([]);
    expect(openscadCandidates('/home/u').length).toBeGreaterThan(0);
  });

  it('finds the program, says its version, and takes a path from the app', () => {
    const scad = new OpenScad({ bin: FAKE, save: () => {} });
    const st = scad.detect();
    expect(st).toMatchObject({ available: true, version: '2025.11.24', manifold: true, from: 'settings', path: FAKE });
    const saved: (string | null)[] = [];
    const other = new OpenScad({ bin: '/nonexistent/openscad', save: (b) => saved.push(b) });
    expect(other.detect()).toMatchObject({ available: false, from: 'settings' });
    expect(other.setBin('relative/openscad')).toMatchObject({ ok: false });
    expect(other.setBin('/nope/openscad')).toMatchObject({ ok: false });
    expect(other.setBin(FAKE)).toMatchObject({ ok: true, status: { available: true } });
    expect(saved).toEqual([FAKE]);
    process.env.FOURK7_OPENSCAD_BIN = FAKE;
    expect(other.setBin('/x')).toMatchObject({ ok: false });
    expect(new OpenScad().detect()).toMatchObject({ available: true, from: 'env' });
  });

  it('renders a job over HTTP: meshes, empty intersections, errors, refused files', async () => {
    const api = await start(new OpenScad({ bin: FAKE, save: () => {} }));
    expect((await (await api('scad')).json()) as ScadStatus).toMatchObject({ available: true, version: '2025.11.24' });
    const job = {
      files: { 'board.scad': 'pcb_thickness = 1.6;', 'enclosure.scad': 'include <board.scad>\nmodule base() { cube(1); }' },
      runs: [
        { id: 'base', code: 'use <enclosure.scad>\nbase();', mesh: true },
        { id: 'collide', code: 'use <enclosure.scad>\n// EMPTY\nintersection() { base(); }' },
        { id: 'broken', code: 'SYNTAX' },
      ],
    };
    const r = await api('scad/render', { method: 'POST', body: JSON.stringify(job) });
    expect(r.status).toBe(200);
    const [base, collide, broken] = (await r.json()) as ScadRunResult[];
    expect(base).toMatchObject({ id: 'base', ok: true, empty: false, bbox: { min: [0, 0, 0], max: [10, 10, 0] } });
    expect(Buffer.from(base!.stl!, 'base64').length).toBe(134);
    expect(collide).toMatchObject({ id: 'collide', ok: true, empty: true, warnings: ['WARNING: Object may not be a valid 2-manifold'] });
    expect(collide!.stl).toBeUndefined();
    expect(broken).toMatchObject({ id: 'broken', ok: false, empty: false });
    expect(broken!.errors![0]).toMatch(/^ERROR: Parser error in file "run-2.scad", line 2/);
    // files that leave the folder, and code that reads files, are refused
    expect((await api('scad/render', { method: 'POST', body: JSON.stringify({ files: { '../x.scad': '' }, runs: [{ id: 'a', code: 'cube(1);' }] }) })).status).toBe(400);
    expect((await api('scad/render', { method: 'POST', body: JSON.stringify({ files: {}, runs: [{ id: 'a', code: 'import("/etc/hosts");' }] }) })).status).toBe(400);
    expect((await api('scad/render', { method: 'POST', body: JSON.stringify({ files: {}, runs: [] }) })).status).toBe(400);
  });

  it('says OpenSCAD is missing instead of rendering', async () => {
    const api = await start(new OpenScad({ bin: '/nonexistent/openscad', save: () => {} }));
    expect(((await (await api('scad')).json()) as ScadStatus).available).toBe(false);
    const r = await api('scad/render', { method: 'POST', body: JSON.stringify({ files: {}, runs: [{ id: 'a', code: 'cube(1);' }] }) });
    expect(r.status).toBe(409);
  });

  const real = openscadCandidates().find((p) => existsSync(p));
  it.skipIf(!real)('renders with the real OpenSCAD', async () => {
    const scad = new OpenScad({ bin: real!, save: () => {} });
    expect(scad.detect().available).toBe(true);
    const [cube, none] = await scad.render({
      files: { 'board.scad': 'module thing() { cube([10, 20, 3]); }' },
      runs: [
        { id: 'cube', code: 'include <board.scad>\nthing();', mesh: true },
        { id: 'none', code: 'include <board.scad>\nintersection() { thing(); translate([50, 0, 0]) cube(1); }' },
      ],
    });
    expect(cube).toMatchObject({ ok: true, empty: false, bbox: { min: [0, 0, 0], max: [10, 20, 3] } });
    expect(cube!.stl!.length).toBeGreaterThan(100);
    expect(none).toMatchObject({ ok: true, empty: true });
  });
});
