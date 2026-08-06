/**
 * Vitest global setup — prepares healthcloud_test.
 *
 * Applies migrations to the TEST database before any test runs, so the suite
 * always runs against the current schema rather than whatever was last left
 * lying around.
 *
 * Safety: this refuses to run against anything not named healthcloud_test.
 * The suite truncates tables, and this PostgreSQL instance is shared with other
 * projects on this machine. A mistyped URL here would not be a failing test —
 * it would be someone else's data gone.
 */

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');

loadEnv({ path: resolve(REPO_ROOT, '.env') });

const REQUIRED_DB_NAME = 'healthcloud_test';

function assertIsTestDatabase(key) {
  const url = process.env[key];
  if (!url) {
    throw new Error(`${key} is not set. Copy it from .env.example.`);
  }

  const name = new URL(url).pathname.replace(/^\//, '');
  if (name !== REQUIRED_DB_NAME) {
    throw new Error(
      `${key} points at database "${name}", but the test suite only runs against ` +
        `"${REQUIRED_DB_NAME}". It TRUNCATES tables, and this server hosts other ` +
        `projects. Refusing to run.`,
    );
  }
  return url;
}

export async function setup() {
  const appUrl = assertIsTestDatabase('TEST_DATABASE_URL');
  const ownerUrl = assertIsTestDatabase('TEST_MIGRATION_DATABASE_URL');

  // prisma.config.ts reads MIGRATION_DATABASE_URL, so point it at the test
  // database for this child process only.
  execFileSync(
    'node',
    [resolve(PKG_ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: PKG_ROOT,
      stdio: 'inherit',
      env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl, DATABASE_URL: appUrl },
    },
  );
}
