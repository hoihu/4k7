import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devAccessKeyAnswer } from '../dev-access-key.ts';

const KEY = '0f1e2d3c-4b5a-4987-a654-3210fedcba98';
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), '4k7-devkey-'));
  writeFileSync(join(home, 'server.json'), JSON.stringify({ accessKey: KEY }));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const page = { host: 'localhost:5173', 'sec-fetch-site': 'same-origin' };
const keyOf = (a: { body: string }) => (JSON.parse(a.body) as { accessKey: string | null }).accessKey;

describe("the dev server's access key, for its own page", () => {
  it('gives the page of its own origin the key the server from this checkout takes', () => {
    expect(devAccessKeyAnswer(page, { FOURK7_HOME: home })).toEqual({ status: 200, body: JSON.stringify({ accessKey: KEY }) });
    expect(keyOf(devAccessKeyAnswer({ ...page, host: '127.0.0.1:5173' }, { FOURK7_HOME: home }))).toBe(KEY);
    // FOURK7_ACCESS_KEY wins, as it does for the server, unless it is no key
    const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(keyOf(devAccessKeyAnswer(page, { FOURK7_HOME: home, FOURK7_ACCESS_KEY: other }))).toBe(other);
    expect(keyOf(devAccessKeyAnswer(page, { FOURK7_HOME: home, FOURK7_ACCESS_KEY: 'secret' }))).toBe(KEY);
    // before a server first ran from a checkout: none
    expect(keyOf(devAccessKeyAnswer(page, { FOURK7_HOME: join(home, 'none') }))).toBeNull();
  });

  it('refuses another site, another port on localhost, an address typed in, and another host name', () => {
    for (const site of ['cross-site', 'same-site', 'none', undefined]) {
      expect(devAccessKeyAnswer({ ...page, 'sec-fetch-site': site }, { FOURK7_HOME: home }), String(site)).toEqual({ status: 403, body: '' });
    }
    expect(devAccessKeyAnswer({ ...page, host: 'attacker.example:5173' }, { FOURK7_HOME: home }).status).toBe(403);
  });
});
