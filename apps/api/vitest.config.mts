import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Source only.
    //
    // Belt and braces with the `exclude` in .swcrc, which stops tests being
    // compiled into dist in the first place. (That exclusion lives in .swcrc
    // rather than tsconfig.build.json because the Nest swc builder does not read
    // the tsconfig excludes, and .swcrc rejects comment keys — hence the
    // explanation being here.)
    //
    // Without both, vitest discovers the compiled copies too and fails with
    // "Vitest cannot be imported in a CommonJS module" — an error about a file
    // nobody wrote.
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**', '.turbo/**'],

    // Applies migrations to healthcloud_test before anything runs, so the suite
    // is always checked against the current schema rather than whatever the last
    // run left behind. Shared with the db package — one definition of "prepare
    // the test database", refusing to run against any database not named
    // healthcloud_test.
    globalSetup: ['../../packages/db/scripts/test-global-setup.mjs'],

    // Redirects DATABASE_URL at the test database BEFORE any application module
    // is imported. config/env.ts caches on first parse, so this cannot be done
    // from inside a test file.
    setupFiles: ['./src/__tests__/setup-env.ts'],

    // One database, shared. Parallel files would let one file's TRUNCATE wipe
    // another's fixtures mid-assertion.
    fileParallelism: false,

    // scrypt is deliberately slow (~100ms per hash) and the lockout test spends
    // nine logins proving it, so the default 5s is too tight.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
