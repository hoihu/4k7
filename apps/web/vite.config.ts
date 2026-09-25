import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

export default defineConfig({
  plugins: [svelte()],
  worker: { format: 'es' },
  // shown in Settings so the Claude Code setup command can be copied as-is
  define: { __REPO_ROOT__: JSON.stringify(repoRoot) },
  build: { target: 'es2022', sourcemap: true },
});
