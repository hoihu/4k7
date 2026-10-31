import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tools/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    setupFiles: ['packages/kernel/test/setup.ts'],
  },
});
