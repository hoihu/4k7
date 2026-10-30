import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { thirdPartyNotices } from '../third-party-notices.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), '4k7-notices-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A package in node_modules; returns the path of its module. */
function pkg(name: string, license: string, files: Record<string, string>): string {
  const dir = join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', license }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return join(dir, 'index.js');
}

const bundle = (modules: Record<string, number>) => ({
  'chunk.js': { type: 'chunk', modules: Object.fromEntries(Object.entries(modules).map(([id, renderedLength]) => [id, { renderedLength }])) },
  'asset.css': { type: 'asset' },
});

/** Runs the plugin's hooks as the build does: the workers first, then the app. */
function build(app: Record<string, number>, ...workers: Record<string, number>[]): string {
  const plugin = thirdPartyNotices();
  for (const w of workers) (plugin.worker()[0]!.generateBundle as Function).call({}, {}, bundle(w));
  let source = '';
  (plugin.app.generateBundle as Function).call({ emitFile: (f: { source: string }) => (source = f.source) }, {}, bundle(app));
  return source;
}

const APACHE = 'Apache License\n\nCopyright [yyyy] [name of copyright owner]';

describe('third-party notices', () => {
  it('reproduces the license files of the bundled packages, sorted, without local paths', () => {
    const zed = pkg('zed', 'MIT', { LICENSE: 'Copyright (c) 2020 Zed', 'index.js': '' });
    const scoped = pkg('@s/lib', 'ISC', { 'license.md': 'Copyright (c) 2021 Scoped', 'index.js': '' });
    const out = build({ [zed]: 1, [scoped]: 1 });
    expect(out.indexOf('@s/lib 1.2.3 (ISC)')).toBeGreaterThan(0);
    expect(out.indexOf('zed 1.2.3 (MIT)')).toBeGreaterThan(out.indexOf('@s/lib 1.2.3 (ISC)'));
    expect(out).toContain('Copyright (c) 2020 Zed');
    expect(out).toContain('Copyright (c) 2021 Scoped');
    expect(out).not.toContain(root);
  });

  it('adds the owner from the source header when the license file names none', () => {
    const id = pkg('pdf', 'Apache-2.0', { LICENSE: APACHE, 'index.js': '/**\n * Copyright 2024 Mozilla Foundation\n *\n */\nconst a = 1;' });
    expect(build({ [`${id}?url`]: 1 })).toContain('pdf 1.2.3 (Apache-2.0)\nCopyright 2024 Mozilla Foundation\n\nApache License');
  });

  it('does not search the source when the license file names the owner', () => {
    const id = pkg('mit', 'MIT', { LICENSE: 'Copyright (c) 2020 Owner', 'index.js': '// Copyright 2019 Someone quoted' });
    expect(build({ [id]: 1 })).not.toContain('Someone quoted');
  });

  it("includes a package's NOTICE file", () => {
    const id = pkg('noticed', 'Apache-2.0', { LICENSE: APACHE, NOTICE: 'Includes work by Somebody', 'index.js': '' });
    expect(build({ [id]: 1 })).toContain('Includes work by Somebody');
  });

  it('takes a file kept in the repository with the license beside it', () => {
    const dir = join(root, 'packages', 'fonts');
    mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries({ 'Liberation-Bold.ttf': '', 'LICENSE-Liberation': 'SIL Open Font License', 'other.ts': '' })) writeFileSync(join(dir, file), text);
    const out = build({ [`${join(dir, 'Liberation-Bold.ttf')}?url`]: 1, [join(dir, 'other.ts')]: 1 });
    expect(out).toContain('Liberation-Bold.ttf\n\nSIL Open Font License');
    expect(out).not.toContain('other.ts');
    expect(out).not.toContain(root);
  });

  it('counts packages only a worker bundles', () => {
    const id = pkg('workeronly', 'MIT', { LICENSE: 'Copyright (c) 2020 W', 'index.js': '' });
    expect(build({}, { [id]: 1 })).toContain('workeronly 1.2.3');
  });

  it('leaves out what was tree-shaken away and the code outside node_modules', () => {
    const id = pkg('shaken', 'MIT', { LICENSE: 'Copyright (c) 2020 S', 'index.js': '' });
    const out = build({ [id]: 0, '/repo/apps/web/src/main.ts': 10, '\0vite/preload-helper.js': 10 });
    expect(out).not.toContain('shaken');
    expect(out).not.toContain('main.ts');
    expect(out).not.toContain('preload-helper');
  });

  it('takes the license of a package that ships none from the known list', () => {
    const id = pkg('standardwebhooks', 'MIT', { 'index.js': '' });
    expect(build({ [id]: 1 })).toContain('Copyright (c) 2023 Svix');
  });

  it('fails the build for any other package without a license file', () => {
    const id = pkg('nolicense', 'MIT', { 'index.js': '' });
    expect(() => build({ [id]: 1 })).toThrow('nolicense ships no license file');
  });
});
