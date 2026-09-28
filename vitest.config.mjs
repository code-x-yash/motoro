import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['apps/worker/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/.wrangler/**', 'apps/web/**', 'apps/worker/test/**'],
    passWithNoTests: false,
  },
});
