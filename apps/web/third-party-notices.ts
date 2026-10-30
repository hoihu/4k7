/**
 * Writes THIRD-PARTY-NOTICES.txt into the build: the license of every package and font bundled into
 * the app, workers included. Minifying drops the packages' license comments and the license files
 * stay behind, so without it the licenses would not reach the user. scripts/package.mjs copies the
 * build, and this file with it, to dist/app.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Plugin, Rolldown } from 'vite';

/** For a package that ships no license file: the text from its repository. Any other such package fails the build. */
const NO_LICENSE_FILE: Record<string, string> = {
  // libraries/LICENSE there; the LICENSE in the repository's root is the specification's
  standardwebhooks: `The MIT License

Copyright (c) 2023 Svix (https://www.svix.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`,
};

const LICENSE_FILE = /^(licen[cs]e|notice|copying)/i;
/** A filled-in copyright line. The Apache and Boost texts have none (Apache's template says "[yyyy]"). */
const NAMES_OWNER = /copyright\s+(\(c\)|©|\d)/i;
const COPYRIGHT_LINE = /^[\s/*#]*(Copyright\s.*?)[\s/*]*$/gim;

function section(dir: string, ids: string[]): string {
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  const files = readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile() && LICENSE_FILE.test(f.name)).map((f) => f.name).sort();
  const license = files.map((f) => readFileSync(`${dir}/${f}`, 'utf8').trim()).join('\n\n') || NO_LICENSE_FILE[pkg.name];
  if (!license) throw new Error(`${pkg.name} ships no license file: add the one from its repository to NO_LICENSE_FILE in third-party-notices.ts`);
  // then the owner is named only in the source files' headers, which the build removes
  const owners = NAMES_OWNER.test(license) ? [] : ids.flatMap((id) => [...readFileSync(id, 'utf8').matchAll(COPYRIGHT_LINE)].map((m) => m[1]!));
  return [`${pkg.name} ${pkg.version} (${pkg.license})`, ...new Set(owners), '', license].join('\n');
}

/** A third-party file kept in the repository has its license beside it: fonts/LICENSE-LiberationSans for LiberationSans-Bold.ttf. */
function vendored(id: string): string | null {
  const [dir, name] = [dirname(id), basename(id)];
  const license = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith('LICENSE-') && name.startsWith(f.slice('LICENSE-'.length))) : undefined;
  return license ? `${name}\n\n${readFileSync(join(dir, license), 'utf8').trim()}` : null;
}

function notices(modules: Set<string>): string {
  const packages = new Map<string, string[]>();
  const sections: string[] = [];
  for (const id of modules) {
    const dir = /^.*\/node_modules\/(?:@[^/]+\/)?[^/]+/.exec(id.replaceAll('\\', '/'))?.[0];
    if (dir) packages.set(dir, [...(packages.get(dir) ?? []), id]);
    else {
      const file = vendored(id);
      if (file) sections.push(file);
    }
  }
  for (const [dir, ids] of packages) sections.push(section(dir, ids));
  return `${['Third-party packages and fonts bundled into 4k7, each under its own license, reproduced below.', ...sections.sort()].join(`\n\n${'='.repeat(80)}\n\n`)}\n`;
}

/** `app` goes in the config's `plugins`, `worker` in `worker.plugins`: Vite builds workers with their own plugins. */
export function thirdPartyNotices(): { app: Plugin; worker: () => Plugin[] } {
  const modules = new Set<string>();
  const collect = (bundle: Rolldown.OutputBundle) => {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue;
      for (const [id, { renderedLength }] of Object.entries(chunk.modules)) if (renderedLength) modules.add(id.split('?')[0]!);
    }
  };
  return {
    worker: () => [{ name: 'third-party-notices-worker', generateBundle: (_, bundle) => collect(bundle) }],
    app: {
      name: 'third-party-notices',
      apply: 'build',
      // the workers are built while the app's modules are transformed, so theirs are in by now
      generateBundle(_, bundle) {
        collect(bundle);
        this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source: notices(modules) });
      },
    },
  };
}
