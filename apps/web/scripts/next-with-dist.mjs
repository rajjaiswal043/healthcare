#!/usr/bin/env node
/**
 * Runs `next <command>` against the PRODUCTION output directory.
 *
 *   node scripts/next-with-dist.mjs build
 *   node scripts/next-with-dist.mjs start
 *
 * Exists because setting an environment variable inline (`FOO=bar next build`)
 * is not portable — these scripts run on Windows, where cmd does not understand
 * that syntax. A three-line wrapper beats adding cross-env as a dependency.
 *
 * See the `distDir` comment in next.config.mjs for why the separation matters.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/next-with-dist.mjs <build|start> [...args]');
  process.exit(1);
}

const child = spawn(process.execPath, [nextBin, ...args], {
  stdio: 'inherit',
  env: { ...process.env, NEXT_DIST_DIR: '.next-build' },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
