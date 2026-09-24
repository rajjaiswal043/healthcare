#!/usr/bin/env node
/**
 * Migration drift gate.
 *
 * Fails if `schema.prisma` has changes that no migration captures — the state
 * where the code compiles, tests pass locally against a hand-modified database,
 * and the deploy then fails or, worse, succeeds against a different schema.
 *
 * Written as a script rather than an inline npm script because the shell form
 * (`--shadow-database-url $MIGRATION_DATABASE_URL`) does not expand on Windows,
 * where these scripts actually run.
 */

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');

loadEnv({ path: resolve(REPO_ROOT, '.env') });

const shadowUrl = process.env.SHADOW_DATABASE_URL;
if (!shadowUrl) {
  console.error('SHADOW_DATABASE_URL is not set. Copy it from .env.example.');
  process.exit(1);
}

// Prisma replays the migration history into the shadow database, dropping and
// recreating its schema. If this ever pointed at dev or test, running the drift
// gate would destroy real data — so refuse rather than trust the config.
const shadowDbName = new URL(shadowUrl).pathname.replace(/^\//, '');
if (shadowDbName !== 'healthcloud_shadow') {
  console.error(
    `\n✗ SHADOW_DATABASE_URL points at "${shadowDbName}".\n` +
      '  Prisma DROPS AND RECREATES the shadow schema. It must be healthcloud_shadow,\n' +
      '  never dev or test. Refusing to run.\n',
  );
  process.exit(1);
}

const prismaBin = resolve(PKG_ROOT, 'node_modules/prisma/build/index.js');

try {
  execFileSync(
    'node',
    // Prisma 7 flag names: `--to-schema` (not --to-schema-datamodel), and the
    // shadow database URL comes from prisma.config.ts rather than a CLI flag.
    [
      prismaBin,
      'migrate',
      'diff',
      '--from-migrations',
      './prisma/migrations',
      '--to-schema',
      './prisma/schema.prisma',
      '--exit-code',
    ],
    { cwd: PKG_ROOT, stdio: 'inherit' },
  );
  console.log('✓ No migration drift: schema.prisma matches the migration history.');
} catch (err) {
  // prisma migrate diff --exit-code exits 2 when a difference exists.
  if (err.status === 2) {
    console.error(
      '\n✗ Migration drift detected: schema.prisma has changes with no migration.\n' +
        '  Run: pnpm --filter @healthcloud/db migrate:dev --name <describe-the-change>\n',
    );
    process.exit(1);
  }
  console.error(`\n✗ Migration check failed: ${err.message}\n`);
  process.exit(1);
}
