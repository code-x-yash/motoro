import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import type { Env } from '../src/env';

/**
 * D1 migrations are read in Node (vitest.config.mjs) and injected as a
 * test-only binding, then applied here before each test file runs.
 */
const bindings = env as unknown as Env & { TEST_MIGRATIONS: Array<{ name: string; queries: string[] }> };

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
