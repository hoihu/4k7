import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessCapability, HarnessId } from '@4k7/schema';
import { Agents, binFor, CodexHarness, commandFor, CopilotHarness, detectClaude, findBin, OpenCodeHarness, shimTarget } from '../src/index.ts';

/** A stand-in CLI: on Windows behind an npm shim, like a real agent installed with npm. */
const fake = (name: string) => fileURLToPath(new URL(`./${process.platform === 'win32' ? name.replace('.mjs', '.cmd') : name}`, import.meta.url));
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
  const windows = process.platform === 'win32';
  const file = join(dir, windows ? 'copilot.cmd' : 'copilot');
  writeFileSync(file, windows ? '@exit /b 3\r\n' : '#!/bin/sh\nexit 3\n');
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

  it('looks for Codex under its name, or its own variable', () => {
    setEnv('FOURK7_CODEX_BIN', undefined);
    expect(binFor('codex', {})).toBe('codex');
    setEnv('FOURK7_CODEX_BIN', '/env/codex');
    expect(binFor('codex', { codex: '/x/codex' })).toBe('/env/codex');
  });

  it('refuses a Codex too old to be of use, and says so', () => {
    setEnv('FOURK7_CODEX_BIN', undefined);
    setEnv('FAKE_CODEX_VERSION', '0.150.1');
    const codex = new CodexHarness('codex', tmpdir());
    const agents = new Agents({ harnesses: [codex], bins: {}, save: () => {}, extendPath: false });
    expect(agents.setBin('codex', fake('fake-codex.mjs'))).toMatchObject({ ok: false, error: expect.stringContaining('needs 0.158.0 or newer') });
    expect(codex.bin).toBe('codex');
    setEnv('FAKE_CODEX_VERSION', '0.158.0');
    expect(agents.setBin('codex', fake('fake-codex.mjs'))).toEqual({ ok: true });
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

describe('npm shims', () => {
  // as npm writes them (cmd-shim), for a script with a node shebang and for a program
  const npmShim = (target: string) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;

  it('tells what they run', () => {
    expect(shimTarget(npmShim('node_modules\\@anthropic-ai\\claude-code\\cli.js'))).toEqual({ path: 'node_modules\\@anthropic-ai\\claude-code\\cli.js', node: true });
    // a script without an extension, which only the shim says is one for node
    expect(shimTarget(npmShim('node_modules\\opencode-ai\\bin\\opencode'))).toEqual({ path: 'node_modules\\opencode-ai\\bin\\opencode', node: true });
    expect(shimTarget('@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\x\\bin\\x.exe"   %*\r\n')).toEqual({ path: 'node_modules\\x\\bin\\x.exe', node: false });
    // pnpm's: "%~dp0" instead, and two lines naming the script
    expect(shimTarget('@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\global\\5\\x\\cli.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\global\\5\\x\\cli.js" %*\r\n)\r\n')).toEqual({ path: 'global\\5\\x\\cli.js', node: true });
  });

  it('are nothing to run when they are something else', () => {
    expect(shimTarget('@echo off\r\nset FOO=1\r\nclaude %*\r\n')).toBeNull();
    // a script for sh
    expect(shimTarget('IF EXIST "%dp0%\\sh.exe" (\r\n  SET "_prog=%dp0%\\sh.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\x\\bin\\x.sh" %*\r\n')).toBeNull();
  });

  describe.runIf(process.platform === 'win32')('on Windows', () => {
    /** A CLI as npm installs it, in a folder of its own with a space in its name; prints its arguments as its version. */
    function installed(): string {
      const dir = mkdtempSync(join(tmpdir(), 'tw npm '));
      mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'x', 'cli.js'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
      writeFileSync(join(dir, 'x.cmd'), npmShim('node_modules\\x\\cli.js'));
      return dir;
    }

    it('starts what the shim runs, found by its name on the PATH', () => {
      const dir = installed();
      setEnv('PATH', `${dir};${process.env.PATH}`);
      expect(commandFor('x')).toMatchObject({ args: [join(dir, 'node_modules', 'x', 'cli.js')] });
      expect(detectClaude('x').available).toBe(true);
      expect(detectClaude(join(dir, 'x.cmd'))).toMatchObject({ available: true, version: '["--version"]' });
    });

    it('says what to do about a batch file it cannot start', () => {
      expect(detectClaude(notAnAgent())).toMatchObject({ available: false, reason: expect.stringContaining('batch file') });
    });
  });
});
