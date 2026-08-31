#!/usr/bin/env node
/**
 * `prisma generate`, with a Windows failure mode translated into English.
 *
 * `generate` deletes and recreates `packages/db/src/generated/prisma`. On
 * Windows a directory cannot be removed while another process holds a file in
 * it, and the API dev server holds the whole generated client open — SWC watch
 * keeps it loaded. So running `pnpm install` while `pnpm --filter
 * @healthcloud/api dev` is running fails with:
 *
 *   ENOTEMPTY: directory not empty, rmdir '...\\src\\generated\\prisma\\...'
 *
 * which arrives wrapped in fifteen lines of pnpm lifecycle noise and looks like
 * a corrupted install rather than a lock. It has cost real time twice.
 *
 * This wrapper changes nothing about what runs. It catches that one class of
 * failure and says what to do. Everything else is passed through untouched,
 * because a generate that fails for a real reason must still fail loudly.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DB_PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'db');

/** The Windows lock signatures. Anything else is a real problem. */
const LOCK_PATTERN = /ENOTEMPTY|EPERM|EBUSY|resource busy or locked/i;

const result = spawnSync('npx', ['prisma', 'generate'], {
  cwd: DB_PACKAGE,
  stdio: ['inherit', 'inherit', 'pipe'],
  shell: process.platform === 'win32',
  encoding: 'utf8',
});

const stderr = result.stderr ?? '';
if (stderr) process.stderr.write(stderr);

if (result.status === 0) process.exit(0);

if (LOCK_PATTERN.test(stderr)) {
  console.error(
    [
      '',
      '  ─────────────────────────────────────────────────────────────────',
      '  The Prisma client could not be regenerated because a running',
      '  process is holding it open. On Windows this is almost always the',
      '  API dev server.',
      '',
      '    1. Stop `pnpm --filter @healthcloud/api dev`',
      '    2. Run this command again',
      '    3. Start the API again',
      '',
      '  The web dev server does not need stopping — it does not load the',
      '  generated client.',
      '  ─────────────────────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
}

process.exit(result.status ?? 1);
