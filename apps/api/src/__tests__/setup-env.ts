/**
 * Vitest setup file — runs before any test module is imported.
 *
 * The ordering matters and is not incidental. `config/env.ts` parses
 * `process.env` on first call and CACHES the result, and `app.module.ts` calls
 * it at module scope. So by the time a test file's imports have been evaluated,
 * the environment is already frozen. Anything that needs to change it — chiefly
 * pointing DATABASE_URL at the test database — has to happen here.
 *
 * The safety check is the same one the database package uses, and for the same
 * reason: this PostgreSQL server also hosts the dev database and an unrelated
 * project, and the suite TRUNCATES tables. A copy-paste in .env should stop the
 * run, not empty someone's data.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

/**
 * Walk up for the repo-root .env.
 *
 * Neither `import.meta.url` nor `__dirname` is available here: the API compiles
 * as CommonJS, which rules out the first, and vitest runs the file as an ES
 * module, which rules out the second. Searching upward from the working
 * directory works under both, and does not break if the suite is ever run from
 * the repo root instead of the package.
 */
function findRepoEnv(startDir: string): string | undefined {
  let dir = startDir;

  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return undefined;
}

const envPath = findRepoEnv(process.cwd());
if (!envPath) {
  throw new Error('No .env found above the working directory. Copy .env.example to .env.');
}
loadDotenv({ path: envPath });

const REQUIRED_DB_NAME = 'healthcloud_test';

function assertTestDatabase(key: string): string {
  const url = process.env[key];
  if (!url) throw new Error(`${key} is not set. Copy it from .env.example.`);

  const name = new URL(url).pathname.replace(/^\//, '');
  if (name !== REQUIRED_DB_NAME) {
    throw new Error(
      `${key} points at database "${name}", but the API integration suite only runs ` +
        `against "${REQUIRED_DB_NAME}". It TRUNCATES tables, and this server hosts ` +
        `other databases. Refusing to run.`,
    );
  }
  return url;
}

const appUrl = assertTestDatabase('TEST_DATABASE_URL');
assertTestDatabase('TEST_MIGRATION_DATABASE_URL');

// The application reads DATABASE_URL and nothing else — it has no notion of a
// "test mode" connection, and giving it one would mean production code with a
// branch that only tests take. Redirecting the variable keeps the app identical.
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';

// Quiet, but not silent: a genuine error during a test should still be visible.
process.env.LOG_LEVEL = 'error';

/**
 * Two-factor is ON for the whole suite, whatever the environment says.
 *
 * It is currently off in every deployment (see MFA_ENABLED in config/env.ts),
 * and that is exactly why this line matters: enrolment, code verification,
 * lockout and the platform realm are all still implemented, and the only thing
 * keeping them honest is a suite that exercises them. Without this the MFA
 * tests would pass by not running, and the day somebody sets MFA_ENABLED=true
 * would be the day they find out whether it still works.
 */
process.env.MFA_ENABLED = 'true';

/**
 * Clinical documents go in a Map, not a bucket.
 *
 * The suite must run with no AWS credentials and no network. Everything worth
 * asserting about document storage — that keys are tenant-prefixed, that another
 * clinic's document is unreachable, that oversized and wrong-typed files are
 * refused — is decided before the store is reached, so a real bucket would prove
 * nothing extra and would make these tests fail on a train.
 */
process.env.CLINICAL_STORAGE_DRIVER = 'memory';

// The app refuses to start without these; a developer whose .env predates auth
// should get that message from here rather than a stack trace inside Nest.
for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
  if ((process.env[key] ?? '').length < 32) {
    throw new Error(`${key} must be set to at least 32 characters in .env before running tests.`);
  }
}
