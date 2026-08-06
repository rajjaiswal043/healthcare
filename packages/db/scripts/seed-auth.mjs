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

const PERMISSIONS = {
  PATIENT_READ: 'patient:read',
  PATIENT_WRITE: 'patient:write',
  PATIENT_MERGE: 'patient:merge',
  CONSENT_READ: 'consent:read',
  CONSENT_WRITE: 'consent:write',
  AUDIT_READ: 'audit:read',
  USER_MANAGE: 'user:manage',
  ROLE_MANAGE: 'role:manage',
  TENANT_CONFIGURE: 'tenant:configure',
};
const ALL = Object.values(PERMISSIONS);

const ROLES = [
  {
    key: 'front_desk',
    name: 'Front desk',
    description: 'Registers patients, searches records, manages the queue.',
    permissions: [
      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.PATIENT_WRITE,
      PERMISSIONS.CONSENT_READ,
      PERMISSIONS.CONSENT_WRITE,
    ],
    requiresMfa: false,
  },
  {
    key: 'doctor',
    name: 'Doctor',
    description: 'Sees the day list, reviews history, records consultations.',
    permissions: [PERMISSIONS.PATIENT_READ, PERMISSIONS.PATIENT_WRITE, PERMISSIONS.CONSENT_READ],
    requiresMfa: false,
  },
  {
    key: 'nurse',
    name: 'Nurse',
    description: 'Captures vitals, supports clinical workflow.',
    permissions: [PERMISSIONS.PATIENT_READ, PERMISSIONS.CONSENT_READ],
    requiresMfa: false,
  },
  {
    key: 'administrator',
    name: 'Administrator',
    description: 'Configures the clinic, manages users and roles.',
    permissions: ALL,
    requiresMfa: true,
  },
  {
    key: 'owner',
    name: 'Owner / management',
    description: 'Oversight and reporting. Read-only over clinical data.',
    permissions: [PERMISSIONS.PATIENT_READ, PERMISSIONS.AUDIT_READ, PERMISSIONS.CONSENT_READ],
    requiresMfa: true,
  },
];

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
        [tenant.id, role.key, role.name, role.description, role.permissions, role.requiresMfa],
      );
      roleIds[role.key] = rows[0].id;
    }

    for (const user of USERS) {
      const passwordHash = await hashPassword(user.password);

      const { rows } = await client.query(
        `INSERT INTO app_user (tenant_id, email, full_name, password_hash, is_active, updated_at)
         VALUES ($1,$2,$3,$4,true, now())
         ON CONFLICT (tenant_id, email) DO UPDATE
           SET password_hash = EXCLUDED.password_hash, updated_at = now()
         RETURNING id`,
        [tenant.id, user.email, user.fullName, passwordHash],
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
  console.log('  admin@demo.local     / demo1234   administrator — will be forced to set up MFA\n');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Auth seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
