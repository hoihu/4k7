import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { thirdPartyNotices } from './third-party-notices.ts';
import { devAccessKey } from './dev-access-key.ts';
import { readFileSync } from 'node:fs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
/** How people run the packaged app (installed from the private repository, not the npm registry). */
const pkg = process.env.FOURK7_PKG ?? 'github:hoihu/4k7';
/** The app's version, from the package; a development build says so. */
const version: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
/** For the downloaded app (scripts/bundle.mjs): what to open instead of running the npx command. */
const run = process.env.FOURK7_RUN;

/**
 * A production build is the packaged app, served by the local server (`npx 4k7pcb`): no sourcemaps
 * (smaller package). In development the local server runs from this checkout instead.
 */
export default defineConfig(({ command }) => {
  const packaged = command === 'build';
  const notices = thirdPartyNotices();
  return {
    // (in development: the page gets the key of the server `npm run dev` started)
    plugins: [svelte(), notices.app, devAccessKey()],
    worker: { format: 'es', plugins: notices.worker },
    // what the enclosure's worker loads: known up front, or the first render in development reloads the page
    optimizeDeps: { include: ['manifold-3d', 'opentype.js/dist/opentype.mjs'] },
    // shown in Settings so the Claude Code setup command can be copied as-is
    define: {
      __PACKAGED__: JSON.stringify(packaged),
      // the command that runs the server for the app's chat, and the one Claude Code starts as MCP server (the downloaded app's server says its own)
      __SERVER_RUN__: JSON.stringify(packaged ? (run ?? `npx -y ${pkg}`) : 'npm run server'),
      // the downloaded app opens the link itself; the commands print it
      __APP_RUN__: JSON.stringify(packaged && !!run),
      __SERVER_MCP__: JSON.stringify(packaged ? `npx -y ${pkg} mcp` : `node ${repoRoot}/tools/server/src/main.ts`),
      // identifies which app build a tab runs (shown in diagnostics and the server log)
      __BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
      // written into the production files, so a set tells which version made it
      __APP_VERSION__: JSON.stringify(packaged ? version : `${version}-dev`),
    },
    build: { target: 'es2022', sourcemap: !packaged },
  };
});
