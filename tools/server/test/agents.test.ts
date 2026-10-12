import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessCapability, HarnessId } from '@4k7/schema';
import { Agents, binFor, CopilotHarness, findBin, OpenCodeHarness } from '../src/index.ts';

const fake = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const restore: (() => void)[] = [];
afterEach(() => restore.splice(0).forEach((r) => r()));

function setEnv(k: string, v: string | undefined) {
  const before = process.env[k];
  restore.push(() => (before === undefined ? delete process.env[k] : (process.env[k] = before)));
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

/** A folder with an executable script that is not an agent (it fails --version). */
function notAnAgent(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-bins-'));
  const file = join(dir, 'copilot');
  writeFileSync(file, '#!/bin/sh\nexit 3\n');
  chmodSync(file, 0o755);
  return file;
}

function setup(bins: Partial<Record<HarnessId, string>> = {}) {
  const copilot = new CopilotHarness(binFor('copilot', bins));
  const opencode = new OpenCodeHarness(binFor('opencode', bins), tmpdir());
  const saved: Partial<Record<HarnessId, string>>[] = [];
  const changes: HarnessCapability[][] = [];
  const agents = new Agents({ harnesses: [copilot, opencode], bins, save: (b) => saved.push(b), extendPath: false, onChange: (c) => changes.push(c) });
  return { agents, copilot, saved, changes };
}

describe('the agents’ programs', () => {
  it('runs the environment variable, else the path from the app, else the name on the PATH', () => {
    setEnv('FOURK7_COPILOT_BIN', undefined);
    expect(binFor('copilot', {})).toBe('copilot');
    expect(binFor('copilot', { copilot: '/x/copilot' })).toBe('/x/copilot');
    setEnv('FOURK7_COPILOT_BIN', '/env/copilot');
    expect(binFor('copilot', { copilot: '/x/copilot' })).toBe('/env/copilot');
  });

  it('reports what it runs, where that is and who chose it', () => {
    setEnv('FOURK7_COPILOT_BIN', undefined);
    setEnv('FOURK7_OPENCODE_BIN', undefined);
    const { agents } = setup({ copilot: fake('fake-copilot.mjs') });
    const [copilot, opencode] = agents.detect();
    expect(copilot).toMatchObject({ id: 'copilot', available: true, bin: fake('fake-copilot.mjs'), path: fake('fake-copilot.mjs'), binFrom: 'settings', binEnv: 'FOURK7_COPILOT_BIN' });
    expect(opencode).toMatchObject({ id: 'opencode', bin: 'opencode', binFrom: 'auto' });
  });

  it('takes a path from the app only when it is a full path to a program that answers --version', () => {
    setEnv('FOURK7_COPILOT_BIN', undefined);
    const { agents, copilot, saved, changes } = setup();
    agents.detect();
    expect(agents.setBin('copilot', 'fake-copilot.mjs')).toMatchObject({ ok: false, error: expect.stringContaining('full path') });
    expect(agents.setBin('copilot', '/nonexistent/copilot')).toMatchObject({ ok: false, error: expect.stringContaining('not a program') });
    expect(agents.setBin('copilot', notAnAgent())).toMatchObject({ ok: false, error: expect.stringContaining('did not answer --version') });
    expect(copilot.bin).toBe('copilot'); // unchanged after a refusal
    expect(saved).toEqual([]);

    expect(agents.setBin('copilot', fake('fake-copilot.mjs'))).toEqual({ ok: true });
    expect(copilot.bin).toBe(fake('fake-copilot.mjs'));
    expect(saved.at(-1)).toEqual({ copilot: fake('fake-copilot.mjs') });
    expect(changes.at(-1)?.find((c) => c.id === 'copilot')).toMatchObject({ available: true, binFrom: 'settings' });

    // back to the name on the PATH
    expect(agents.setBin('copilot', null)).toEqual({ ok: true });
    expect(copilot.bin).toBe('copilot');
    expect(saved.at(-1)).toEqual({});
  });

  it('leaves the program to the environment variable when it is set', () => {
    setEnv('FOURK7_COPILOT_BIN', fake('fake-copilot.mjs'));
    const { agents, saved } = setup();
    expect(agents.setBin('copilot', fake('fake-copilot.mjs'))).toMatchObject({ ok: false, error: expect.stringContaining('FOURK7_COPILOT_BIN') });
    expect(saved).toEqual([]);
  });

  it('finds a name on the PATH like which', () => {
    const file = notAnAgent();
    expect(findBin('copilot', join(file, '..'))).toBe(file);
    expect(findBin('copilot', '/nonexistent')).toBeNull();
    expect(findBin(file)).toBe(file);
  });
});
