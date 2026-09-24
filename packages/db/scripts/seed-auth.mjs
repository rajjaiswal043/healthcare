#!/usr/bin/env node
/**
 * Seeds roles and demo users into every tenant.
 *
 * Run after seed-demo.mjs (which truncates). Idempotent per tenant.
 *
 * The demo passwords are weak ON PURPOSE and only weak here: they exist so a
 * demo can be run without a password manager. Real deployments invite users and
 * force a password change on first login.
 */

import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

const scrypt = promisify(scryptCallback);

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
loadEnv({ path: resolve(REPO_ROOT, '.env') });

const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!ownerUrl || !new URL(ownerUrl).pathname.includes('healthcloud')) {
  console.error('MIGRATION_DATABASE_URL must point at a HealthCloud database.');
  process.exit(1);
}

// Must match apps/api/src/platform/auth/password.ts exactly, or seeded users
// cannot log in.
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

// Permissions and roles come from @healthcloud/db so there is ONE definition.
// They used to be copied here, and the copies drifted: appointment permissions
// were added to the API but not to this file, so every scheduling endpoint
// returned 403 against freshly seeded roles.
const { SYSTEM_ROLES: ROLES } = await import('@healthcloud/db');

/**
 * DEV_DISABLE_MFA — a local convenience, and nothing more.
 *
 * The administrator and owner roles require TOTP (FR-USR-02) because they are
 * the roles that can waive a charge, refund money, change permissions and pair
 * an unattended screen. That default lives in SYSTEM_ROLES and is NOT changed by
 * this flag: the product still ships MFA-on, and the integration suite still
 * enrols for real, so the flow keeps its only end-to-end test.
 *
 * What this does is seed a DEVELOPER's database with the requirement switched
 * off, so nobody has to hold a phone to click through an admin screen fifty
 * times an afternoon. Set it in .env; remove the line to get MFA back.
 *
 * Two guards, because a flag that silently weakens auth is exactly the kind that
 * ends up somewhere it should not be:
 *   - it refuses to run under NODE_ENV=production
 *   - it announces itself loudly every single time
 */
const DISABLE_MFA = /^(1|true|yes)$/i.test(process.env.DEV_DISABLE_MFA ?? '');

if (DISABLE_MFA && process.env.NODE_ENV === 'production') {
  console.error('DEV_DISABLE_MFA is set and NODE_ENV=production. Refusing to seed.');
  process.exit(1);
}

/**
 * Demo users.
 *
 * `nurse` is included deliberately: it has patient:read but NOT patient:write,
 * so a demo can show permissions actually denying something rather than just
 * asserting they exist.
 */
const USERS = [
  {
    email: 'reception@demo.local',
    fullName: 'Asha Pawar',
    role: 'front_desk',
    password: 'demo1234',
  },
  { email: 'doctor@demo.local', fullName: 'Dr Vikram Rao', role: 'doctor', password: 'demo1234' },
  {
    // The finance desk (FR-FIN-01). Included so the single-screen flow at
    // /finance can be walked as the role it was built for, rather than as an
    // administrator who holds every permission and therefore proves nothing
    // about what finance can and cannot reach.
    email: 'finance@demo.local',
    fullName: 'Sunita Bhosale',
    role: 'finance',
    password: 'demo1234',
  },
  { email: 'nurse@demo.local', fullName: 'Meena Joshi', role: 'nurse', password: 'demo1234' },
  {
    email: 'admin@demo.local',
    fullName: 'Ravi Kulkarni',
    role: 'administrator',
    password: 'demo1234',
  },
];

const client = new pg.Client({ connectionString: ownerUrl });

try {
  await client.connect();

  const { rows: tenants } = await client.query('SELECT id, slug, name FROM tenant ORDER BY slug');
  if (tenants.length === 0) {
    console.error('No tenants found. Run seed:demo first.');
    process.exit(1);
  }

  for (const tenant of tenants) {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);

    const roleIds = {};
    for (const role of ROLES) {
      const { rows } = await client.query(
        `INSERT INTO role (tenant_id, key, name, description, permissions, is_system, requires_mfa, updated_at)
         VALUES ($1,$2,$3,$4,$5,true,$6, now())
         ON CONFLICT (tenant_id, key) DO UPDATE
           SET permissions = EXCLUDED.permissions,
               requires_mfa = EXCLUDED.requires_mfa,
               updated_at = now()
         RETURNING id`,
        [
          tenant.id,
          role.key,
          role.name,
          role.description,
          role.permissions,
          DISABLE_MFA ? false : role.requiresMfa,
        ],
      );
      roleIds[role.key] = rows[0].id;
    }

    for (const user of USERS) {
      const passwordHash = await hashPassword(user.password);

      /**
       * Clearing the enrolment matters as much as clearing the role flag.
       *
       * Login asks for a code whenever a user IS enrolled, whatever their role
       * requires — so an administrator who already set up an authenticator would
       * still be prompted, and DEV_DISABLE_MFA would look broken. Wiping the
       * secret puts them back to a plain password.
       */
      const { rows } = await client.query(
        `INSERT INTO app_user (tenant_id, email, full_name, password_hash, is_active, updated_at)
         VALUES ($1,$2,$3,$4,true, now())
         ON CONFLICT (tenant_id, email) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               mfa_secret     = CASE WHEN $5 THEN NULL ELSE app_user.mfa_secret END,
               mfa_enabled_at = CASE WHEN $5 THEN NULL ELSE app_user.mfa_enabled_at END,
               updated_at = now()
         RETURNING id`,
        [tenant.id, user.email, user.fullName, passwordHash, DISABLE_MFA],
      );

      await client.query(
        `INSERT INTO user_role (tenant_id, user_id, role_id)
         VALUES ($1,$2,$3) ON CONFLICT (user_id, role_id) DO NOTHING`,
        [tenant.id, rows[0].id, roleIds[user.role]],
      );
    }

    await client.query('COMMIT');
    console.log(`  ${tenant.name.padEnd(20)} ${ROLES.length} roles, ${USERS.length} users`);
  }

  console.log('\nDemo sign-in (any clinic):');
  console.log('  reception@demo.local / demo1234   front desk — can register');
  console.log('  nurse@demo.local     / demo1234   nurse      — read only, cannot register');
  console.log('  doctor@demo.local    / demo1234   doctor');
  console.log('  finance@demo.local   / demo1234   finance    — bills and takes payment');
  console.log(
    DISABLE_MFA
      ? '  admin@demo.local     / demo1234   administrator\n'
      : '  admin@demo.local     / demo1234   administrator — will be forced to set up MFA\n',
  );

  if (DISABLE_MFA) {
    console.log('  ⚠  DEV_DISABLE_MFA is set: every role seeded WITHOUT two-factor, and any');
    console.log('     existing enrolment was cleared. Local databases only — remove the line');
    console.log('     from .env to put the requirement back.\n');
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Auth seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
