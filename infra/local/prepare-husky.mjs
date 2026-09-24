#!/usr/bin/env node
/**
 * Installs the husky git hooks, but only if this is actually a git repository.
 *
 * Narveer runs `git init` himself (ADR-018), so `pnpm install` may well happen
 * before the repo exists. Plain `husky` would fail there and break the install
 * for no good reason. This makes the hook setup self-healing: it becomes active
 * on the first install after `git init`.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

if (!existsSync(resolve(ROOT, '.git'))) {
  console.log('  ! Not a git repository yet — skipping husky hook install.');
  console.log('    After you run `git init`, run `pnpm install` again to activate');
  console.log('    the pre-push quality gate (ADR-016).');
  process.exit(0);
}

const { default: husky } = await import('husky');
console.log(husky() || '  husky hooks installed.');
