import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./scripts/test-global-setup.mjs'],
    include: ['src/**/*.test.ts'],
    // These tests share one database. Running files in parallel would let one
    // file's truncate wipe another's fixtures mid-assertion.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
