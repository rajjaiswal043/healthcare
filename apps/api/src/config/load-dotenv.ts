import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

/**
 * Loads the repo-root .env as an import side effect.
 *
 * This is its own module because ES `import` statements are HOISTED: calling
 * dotenv inside main.ts after the import block runs too late, since every
 * imported module — including app.module.ts, which validates the environment at
 * module scope — has already been evaluated. Keep this the FIRST import in
 * main.ts; the ordering is load-bearing.
 *
 * The .env is found by walking up from this file rather than by a fixed number
 * of `..` segments, because the depth differs between running from `src` and
 * running from `dist/src`. A hard-coded relative path silently loads nothing in
 * one of those two cases, which then surfaces as a confusing validation error.
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

const envPath = findRepoEnv(__dirname);

if (envPath) {
  loadDotenv({ path: envPath });
}
// If nothing was found we stay silent here: the environment may legitimately be
// injected by the platform in production. config/env.ts validates what actually
// arrived and fails loudly if it is incomplete.
