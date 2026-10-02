import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const bridgePkg = process.env.TW_BRIDGE_PKG ?? 'tracewise-bridge';

/**
 * Every production build is a hosted one (whatever the host sets): no sourcemaps (the source
 * stays private) and the bridge started from npm. The dev server, or a build with TW_LOCAL=1,
 * runs the bridge from this checkout instead.
 */
export default defineConfig(({ command }) => {
  const hosted = command === 'build' && process.env.TW_LOCAL !== '1';
  return {
    plugins: [svelte()],
    worker: { format: 'es' },
    // shown in Settings so the Claude Code setup command can be copied as-is
    define: {
      __HOSTED__: JSON.stringify(hosted),
      // the command that runs the bridge for the app's chat, and the one Claude Code starts as MCP server
      __BRIDGE_RUN__: JSON.stringify(hosted ? `npx -y ${bridgePkg} --serve` : 'npm run bridge'),
      __BRIDGE_MCP__: JSON.stringify(hosted ? `npx -y ${bridgePkg}` : `node ${repoRoot}/tools/bridge/src/main.ts`),
      // identifies which app build a tab runs (shown in diagnostics and the bridge log)
      __BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
    },
    build: { target: 'es2022', sourcemap: !hosted },
  };
});
