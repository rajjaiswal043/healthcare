#!/usr/bin/env node
/**
 * Creates a doctorsdesk.in platform account.
 *
 *   pnpm --filter @healthcloud/db platform:user -- someone@doctorsdesk.in "Their Name"
 *
 * This exists because of a bootstrapping problem with no way around it: platform
 * accounts are created by platform staff, and the first one has nobody to create
 * it. Same reason the database roles live in bootstrap.sql rather than in a
 * migration.
 *
 * The password is generated here and printed ONCE. Whether an authenticator is
 * then required depends on MFA_ENABLED, which is currently off everywhere — so
 * today this password is the whole of the credential. Guard it accordingly, and
 * do not run this from CI, where the output lands in a build log.
 */

import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

const scrypt = promisify(scryptCallback);

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
loadEnv({ path: resolve(REPO_ROOT, '.env') });

const [email, fullName] = process.argv.slice(2);

if (!email || !fullName) {
  console.error('Usage: platform:user -- <email> "<full name>"');
  process.exit(1);
}

const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!ownerUrl || !new URL(ownerUrl).pathname.includes('healthcloud')) {
  console.error('MIGRATION_DATABASE_URL must point at a HealthCloud database.');
  process.exit(1);
}

// Must match apps/api/src/platform/auth/password.ts exactly.
const N = 65536;
const R = 8;
const P = 1;

async function hashPassword(plain) {
  const salt = randomBytes(16);
  const derived = await scrypt(plain.normalize('NFKC'), salt, 64, {
    N,
    r: R,
    p: P,
    maxmem: 128 * N * R * 2,
  });
  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

/** Same alphabet as the clinic's temporary passwords: no I, l, 1, O or 0. */
const SAFE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const password = Array.from({ length: 4 }, () =>
  Array.from({ length: 4 }, () => SAFE[randomInt(SAFE.length)]).join(''),
).join('-');

const client = new pg.Client({ connectionString: ownerUrl });

try {
  await client.connect();

  const { rows } = await client.query(
    `INSERT INTO platform_user (email, full_name, password_hash, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (lower(email)) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           full_name     = EXCLUDED.full_name,
           is_active     = true,
           mfa_secret    = NULL,
           mfa_enabled_at = NULL,
           failed_login_count = 0,
           locked_until  = NULL,
           updated_at    = now()
     RETURNING id, email, (xmax = 0) AS created`,
    [email.trim().toLowerCase(), fullName.trim(), await hashPassword(password)],
  );

  const row = rows[0];

  console.log(`\n  ${row.created ? 'Created' : 'Reset'} platform account\n`);
  console.log(`    email     ${row.email}`);
  console.log(`    password  ${password}\n`);
  console.log('  Shown once. Sign in at /platform/login.\n');
  console.log('  Two-factor is currently OFF (MFA_ENABLED), so this password alone reaches');
  console.log('  every clinic on the platform. Change it after signing in.\n');
} catch (err) {
  console.error(`Could not create the platform account: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
