#!/usr/bin/env node
/**
 * Runs `next <command>` against an explicit output directory.
 *
 *   node scripts/next-with-dist.mjs .next-dev   dev --port 3000
 *   node scripts/next-with-dist.mjs .next-build build
 *   node scripts/next-with-dist.mjs .next-build start --port 3000
 *
 * WHY THIS EXISTS
 *
 * `next dev` and `next build` both default to `.next`. Building while the dev
 * server is running leaves it with a half-rewritten module graph, which surfaces
 * as `Cannot find module './501.js'` or 404s on every chunk. That is not an edge
 * case: the pre-push hook runs `pnpm verify`, which builds, and you push while
 * developing.
 *
 * WHY AN ENVIRONMENT VARIABLE
 *
 * Next loads next.config.mjs in worker processes as well as the main one.
 * `process.env` is inherited by those workers; `process.argv` and `NEXT_PHASE`
 * are not — NEXT_PHASE is simply undefined during a build in Next 15.5, and a
 * worker's argv is `processChild.js`. Both were tried, and both silently fell
 * back to `.next`, which is how the dev server got clobbered a second time.
 *
 * Both real workflows now name their directory explicitly, so `.next` is left
 * unused — a stray `next build` run by hand lands there and collides with
 * nothing.
 *
 * Inline `FOO=bar next build` is not portable to cmd, which is what these
 * scripts run under on Windows; hence a wrapper rather than a shell prefix.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next');

const [distDir, ...args] = process.argv.slice(2);

if (!distDir || args.length === 0) {
  console.error('Usage: node scripts/next-with-dist.mjs <distDir> <command> [...args]');
  process.exit(1);
}

const child = spawn(process.execPath, [nextBin, ...args], {
  stdio: 'inherit',
  env: { ...process.env, NEXT_DIST_DIR: distDir },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
