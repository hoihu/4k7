// Builds the `tracewise` package in dist/: the server bundled into one file (the workspace packages
// inlined: Node does not strip types under node_modules) and the built web app next to it.
// Run by `npm run package`, and by npm's `prepare` when someone installs from the repository
// (npx github:hoihu/4k7). Expects apps/web/dist to be built (npm run build).
import { chmodSync, cpSync, existsSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const root = fileURLToPath(new URL('..', import.meta.url));
const web = `${root}apps/web/dist`;
if (!existsSync(`${web}/index.html`)) throw new Error('apps/web/dist is missing: run npm run build first');

rmSync(`${root}dist`, { recursive: true, force: true });

// left to npm (the root package's dependencies): CommonJS and optional native parts, and pdf.js's large files
const external = ['ws', 'pdfjs-dist', '@modelcontextprotocol/sdk'];
const bundle = await rolldown({
  input: `${root}tools/server/src/cli.ts`,
  platform: 'node',
  external: (id) => id.startsWith('node:') || builtinModules.includes(id) || external.some((e) => id === e || id.startsWith(`${e}/`)),
});
await bundle.write({ file: `${root}dist/tracewise.js`, format: 'esm', codeSplitting: false });
await bundle.close();
chmodSync(`${root}dist/tracewise.js`, 0o755);

cpSync(web, `${root}dist/app`, { recursive: true });
console.log('dist/tracewise.js + dist/app');
