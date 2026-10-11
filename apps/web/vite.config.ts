import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
/** How people run the packaged app (installed from the private repository, not the npm registry). */
const pkg = process.env.FOURK7_PKG ?? 'github:hoihu/4k7';

/**
 * A production build is the packaged app, served by the local server (`npx 4k7pcb`): no sourcemaps
 * (smaller package). In development the local server runs from this checkout instead.
 */
export default defineConfig(({ command }) => {
  const packaged = command === 'build';
  return {
    plugins: [svelte()],
    worker: { format: 'es' },
    // shown in Settings so the Claude Code setup command can be copied as-is
    define: {
      __PACKAGED__: JSON.stringify(packaged),
      // the command that runs the server for the app's chat, and the one Claude Code starts as MCP server
      __SERVER_RUN__: JSON.stringify(packaged ? `npx -y ${pkg}` : 'npm run server'),
      __SERVER_MCP__: JSON.stringify(packaged ? `npx -y ${pkg} mcp` : `node ${repoRoot}/tools/server/src/main.ts`),
      // identifies which app build a tab runs (shown in diagnostics and the server log)
      __BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
    },
    build: { target: 'es2022', sourcemap: !packaged },
  };
});
