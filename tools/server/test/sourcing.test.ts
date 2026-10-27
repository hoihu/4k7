import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PartSource } from '@4k7/parts';
import type { HouseFootprint, SupplierPart } from '@4k7/schema';
import { partQuery, quoteRequest, sourcing } from '../src/sourcing.ts';
import { storageHandler } from '../src/storage.ts';

const KEY = '0cd22f19-30de-4d39-9287-ab0123456789';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

const part = (sku: string): SupplierPart => ({ sku, mpn: 'X', package: '0603', description: '', stock: 5, tier: 'Basic', fee: false, price: [], attributes: {}, url: '', live: true });
const land: HouseFootprint = { name: 'R0603', pads: [{ number: '1', x: -0.8, y: 0, w: 0.9, h: 0.95 }, { number: '2', x: 0.8, y: 0, w: 0.9, h: 0.95 }] };

describe('sourcing service', () => {
  it('keeps answers for a while, forgets failures, and runs three requests at a time', async () => {
    let running = 0;
    let most = 0;
    const calls: string[] = [];
    const src: PartSource = {
      async lookup(sku) {
        calls.push(sku);
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        if (sku === 'C13') throw new Error('jlcpcb.com answered HTTP 403');
        return part(sku);
      },
      search: async () => [part('C1')],
    };
    const s = sourcing({ sources: { jlcpcb: src } });
    expect(s.houses).toEqual(['jlcpcb']);
    await Promise.all(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((sku) => s.lookup('jlcpcb', sku)));
    expect(most).toBe(3);
    expect((await s.lookup('jlcpcb', 'c1 '))?.sku).toBe('C1');
    expect(calls.filter((c) => c === 'C1')).toHaveLength(1);
    await expect(s.lookup('jlcpcb', 'C13')).rejects.toMatchObject({ status: 502, message: 'jlcpcb.com answered HTTP 403' });
    await expect(s.lookup('jlcpcb', 'C13')).rejects.toThrow();
    expect(calls.filter((c) => c === 'C13')).toHaveLength(2);
    expect(() => s.lookup('pcbway', 'C1')).toThrow(/no parts catalogue/);
  });

  it('keeps footprints a day in memory and a month on disk, and asks for them one after another', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4k7-footprints-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const asked: [string, number][] = [];
    const src: PartSource = { search: async () => [], lookup: async () => null, footprint: async (sku) => (asked.push([sku, Date.now()]), sku === 'C404' ? null : land) };
    const s = sourcing({ sources: { jlcpcb: src }, footprintDir: dir });
    expect(await Promise.all(['C1', 'C2', 'C3'].map((x) => s.footprint('jlcpcb', x)))).toEqual([land, land, land]);
    // spaced out, so a whole board's check does not trip the library's limit
    expect(asked[2]![1] - asked[0]![1]).toBeGreaterThanOrEqual(2 * 150 - 30);
    expect(await s.footprint('jlcpcb', 'c1 ')).toEqual(land);
    expect(asked).toHaveLength(3);
    // a server started later reads them off the disk
    expect(await sourcing({ sources: { jlcpcb: src }, footprintDir: dir }).footprint('jlcpcb', 'C2')).toEqual(land);
    expect(asked).toHaveLength(3);
    expect(await s.footprint('jlcpcb', 'C404')).toBeNull();
    expect(() => sourcing({ sources: { jlcpcb: { search: async () => [], lookup: async () => null } } }).footprint('jlcpcb', 'C1')).toThrow(/no footprints/);
  });

  it('reads JLCPCB, Eurocircuits and PCBWay unless told otherwise, and keeps quotes like answers', async () => {
    expect(sourcing().houses).toEqual(['jlcpcb', 'eurocircuits', 'pcbway']);
    let asked = 0;
    const s = sourcing({ sources: { pcbway: { search: async () => [], lookup: async () => null, quote: async () => (asked++, { price: 29, list: 101.5 }) } } });
    const order = { boards: 10, sides: 1 as const, uniqueParts: 5, smdParts: 20, largeParts: 0, thParts: 1 };
    expect(await s.quote('pcbway', order)).toEqual({ price: 29, list: 101.5 });
    await s.quote('pcbway', { ...order });
    expect(asked).toBe(1);
    expect(() => sourcing({ sources: { jlcpcb: { search: async () => [], lookup: async () => null } } }).quote('jlcpcb', order)).toThrow(/no assembly quote/);
  });

  it('takes an order to quote only in the form it knows', () => {
    const order = { boards: 10, sides: 2, uniqueParts: 5, smdParts: 20, largeParts: 1, thParts: 0 };
    expect(quoteRequest({ ...order, extra: 1 })).toEqual(order);
    for (const bad of [null, [], { ...order, sides: 3 }, { ...order, boards: 0 }, { ...order, smdParts: 1.5 }, { ...order, thParts: '1' }]) {
      expect(() => quoteRequest(bad)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });

  it('takes a search only in the form it knows', () => {
    expect(partQuery({ text: 'buzzer', package: 'SMD', noFee: true, limit: 8 })).toEqual({ text: 'buzzer', package: 'SMD', noFee: true, limit: 8 });
    expect(partQuery({ kind: 'capacitor', value: '100nF', extra: 'ignored' })).toEqual({ kind: 'capacitor', value: '100nF' });
    for (const bad of [null, [], 'x', { text: 5 }, { kind: 'diode' }, { noFee: 'yes' }, { limit: 0 }, { limit: 401 }, { limit: 1.5 }, { text: 'x'.repeat(201) }]) {
      expect(() => partQuery(bad)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});

describe('sourcing routes', () => {
  async function start() {
    const root = mkdtempSync(join(tmpdir(), '4k7-sourcing-'));
    const asked: unknown[] = [];
    const src: PartSource = {
      search: async (q) => (asked.push(q), [part('C25804')]),
      lookup: async (sku) => (sku === 'C404' ? null : sku === 'C500' ? Promise.reject(new Error('down')) : part(sku)),
      footprint: async (sku) => (sku === 'C404' ? null : land),
    };
    const quoting: PartSource = { search: async () => [], lookup: async () => null, quote: async (o) => ({ price: o.boards * 10, days: '5-6 days' }) };
    const handler = storageHandler({ accessKey: KEY, projectsDir: join(root, 'p'), dataDir: join(root, 'd'), allowedOrigin: (o) => o === 'http://localhost:5173', sourcing: sourcing({ sources: { jlcpcb: src, pcbway: quoting } }) });
    const http: Server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cleanups.push(() => http.close());
    const port = (http.address() as { port: number }).port;
    const api = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}/api/${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, ...(init.headers as Record<string, string>) } });
    return { api, port, asked };
  }

  it('needs the access key, and answers searches and lookups for a house it knows', async () => {
    const { api, port, asked } = await start();
    expect((await fetch(`http://127.0.0.1:${port}/api/sourcing/jlcpcb/part/C25804`)).status).toBe(401);
    expect((await api('sourcing/jlcpcb/part/C25804', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect(await (await api('sourcing/jlcpcb/part/C25804')).json()).toEqual({ part: part('C25804') });
    expect(await (await api('sourcing/jlcpcb/part/C404')).json()).toEqual({ part: null });
    const found = await api('sourcing/jlcpcb/search', { method: 'POST', body: JSON.stringify({ text: 'buzzer', limit: 3 }) });
    expect(await found.json()).toEqual({ parts: [part('C25804')] });
    expect(asked).toEqual([{ text: 'buzzer', limit: 3 }]);
  });

  it("answers a part's footprint, and says when a house has none", async () => {
    const { api } = await start();
    expect(await (await api('sourcing/jlcpcb/footprint/C25804')).json()).toEqual({ footprint: land });
    expect(await (await api('sourcing/jlcpcb/footprint/C404')).json()).toEqual({ footprint: null });
    expect((await api('sourcing/pcbway/footprint/C1')).status).toBe(404);
    expect((await api('sourcing/jlcpcb/footprint/C1', { method: 'POST' })).status).toBe(405);
  });

  it("asks a house's online quote for an order", async () => {
    const { api } = await start();
    const order = { boards: 3, sides: 1, uniqueParts: 5, smdParts: 20, largeParts: 0, thParts: 0 };
    expect(await (await api('sourcing/pcbway/quote', { method: 'POST', body: JSON.stringify(order) })).json()).toEqual({ quote: { price: 30, days: '5-6 days' } });
    const bad = await api('sourcing/pcbway/quote', { method: 'POST', body: JSON.stringify({ ...order, sides: 0 }) });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe('quote: sides is 1 or 2');
    expect((await api('sourcing/jlcpcb/quote', { method: 'POST', body: JSON.stringify(order) })).status).toBe(404);
    expect((await api('sourcing/pcbway/quote')).status).toBe(405);
  });

  it('says what went wrong: an unknown house, a bad search, the house failing, the wrong method', async () => {
    const { api } = await start();
    expect((await api('sourcing/acme/part/C1')).status).toBe(404);
    const bad = await api('sourcing/jlcpcb/search', { method: 'POST', body: JSON.stringify({ kind: 'diode' }) });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe('search: kind is resistor or capacitor');
    const down = await api('sourcing/jlcpcb/part/C500');
    expect(down.status).toBe(502);
    expect(await down.text()).toBe('down');
    expect((await api('sourcing/jlcpcb/search')).status).toBe(405);
    expect((await api('sourcing/jlcpcb/part')).status).toBe(405);
  });
});
