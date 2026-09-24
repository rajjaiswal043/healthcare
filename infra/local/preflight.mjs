#!/usr/bin/env node
/**
 * HealthCloud — local preflight
 *
 * Runs before `pnpm dev`. Its job is to turn the failure modes that native
 * local development introduces (ADR-017) into loud, specific, fixable messages
 * instead of a confusing stack trace three layers into the app.
 *
 * It checks, in order:
 *   1. .env exists and parses
 *   2. every required variable is present and non-placeholder
 *   3. Postgres is reachable as BOTH roles
 *   4. the server really is PostgreSQL 18            <- the one that bites
 *   5. the app role is genuinely non-superuser and non-BYPASSRLS
 *   6. the test database is not the dev database     <- protects real data
 *   7. Redis/Memurai is reachable
 *
 * Zero-tolerance on 4, 5 and 6: each of those silently disables a guarantee the
 * whole design rests on.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXPECTED_PG_MAJOR = 18;

const problems = [];
const notes = [];

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function fail(title, remedy) {
  problems.push({ title, remedy });
}

// ---------------------------------------------------------------------------
// 1. .env
// ---------------------------------------------------------------------------
const envPath = resolve(ROOT, '.env');
if (!existsSync(envPath)) {
  console.error(`\n${red('✗ No .env file found.')}\n`);
  console.error('  Fix:');
  console.error(dim('    cp .env.example .env'));
  console.error(dim('    (PowerShell:  Copy-Item .env.example .env)\n'));
  process.exit(1);
}

/** Minimal .env parser — avoids a dependency for something this small. */
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = parseEnv(readFileSync(envPath, 'utf8'));

// ---------------------------------------------------------------------------
// 2. Required variables
// ---------------------------------------------------------------------------
const REQUIRED = [
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'TEST_DATABASE_URL',
  'REDIS_URL',
  'API_PORT',
  'WEB_PORT',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
];

for (const key of REQUIRED) {
  if (!env[key]) {
    fail(`${key} is missing from .env`, `Copy the line for ${key} from .env.example.`);
  }
}

// ---------------------------------------------------------------------------
// 6. Test database must not be the dev database (checked early — pure string
//    comparison, and the consequence of getting it wrong is destroyed data)
// ---------------------------------------------------------------------------
function dbNameOf(url) {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return null;
  }
}

if (env.DATABASE_URL && env.TEST_DATABASE_URL) {
  const devDb = dbNameOf(env.DATABASE_URL);
  const testDb = dbNameOf(env.TEST_DATABASE_URL);
  if (devDb && testDb && devDb === testDb) {
    fail(
      `TEST_DATABASE_URL points at the same database as DATABASE_URL ("${devDb}")`,
      'Integration tests TRUNCATE every table. Point TEST_DATABASE_URL at healthcloud_test.',
    );
  }
}

// This PostgreSQL instance is shared with other projects on this machine
// (e.g. "routinely" on the same 5432). The integration suite truncates every
// table in TEST_DATABASE_URL on every run, so a mistyped or pasted-over URL is
// not a config error — it is data loss in somebody else's project.
//
// Hard requirement: every database this project touches is named healthcloud_*.
const DB_NAME_PREFIX = 'healthcloud';
for (const key of [
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'TEST_DATABASE_URL',
  'TEST_MIGRATION_DATABASE_URL',
]) {
  const url = env[key];
  if (!url) continue;
  const name = dbNameOf(url);
  if (name && !name.startsWith(DB_NAME_PREFIX)) {
    fail(
      `${key} points at database "${name}", which is not a HealthCloud database`,
      `This PostgreSQL server is shared with other projects, and the test suite\n` +
        `     TRUNCATES every table in the database it is given. Every URL here must\n` +
        `     name a "${DB_NAME_PREFIX}_*" database. Refusing to continue.`,
    );
  }
}

// ---------------------------------------------------------------------------
// TCP reachability helper
// ---------------------------------------------------------------------------
function checkTcp(host, port, timeoutMs = 2500) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// ---------------------------------------------------------------------------
// 3-5. Postgres
// ---------------------------------------------------------------------------
async function checkPostgres() {
  let pg;
  try {
    ({ default: pg } = await import('pg'));
  } catch {
    notes.push(
      'Skipped deep Postgres checks: the "pg" package is not installed yet. Run pnpm install.',
    );
    return;
  }

  const targets = [
    { label: 'app role (DATABASE_URL)', url: env.DATABASE_URL, isApp: true },
    { label: 'owner role (MIGRATION_DATABASE_URL)', url: env.MIGRATION_DATABASE_URL, isApp: false },
  ];

  for (const { label, url, isApp } of targets) {
    if (!url) continue;

    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 4000 });
    try {
      await client.connect();

      // --- the check that actually matters ---
      const { rows } = await client.query(
        'SELECT current_setting($1) AS num, current_user AS usr',
        ['server_version_num'],
      );
      const major = Math.floor(Number(rows[0].num) / 10000);

      if (major !== EXPECTED_PG_MAJOR) {
        fail(
          `${label}: connected to PostgreSQL ${major}, expected ${EXPECTED_PG_MAJOR}`,
          `You have several PostgreSQL servers installed (13 on 5433, 18 on 5432).\n` +
            `     This connection landed on the wrong one. Check the port in the URL.`,
        );
      }

      // --- RLS integrity: a superuser or BYPASSRLS app role silently voids
      //     every tenant isolation policy we rely on (ADR-005) ---
      if (isApp) {
        const { rows: attrs } = await client.query(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
        );
        if (attrs[0]?.rolsuper) {
          fail(
            `${label}: the application role is a SUPERUSER`,
            'Superusers bypass row-level security entirely, so tenant isolation would not apply.\n' +
              '     Re-run infra/local/bootstrap.sql, and check DATABASE_URL uses healthcloud_app.',
          );
        }
        if (attrs[0]?.rolbypassrls) {
          fail(
            `${label}: the application role has BYPASSRLS`,
            'Tenant isolation would not apply. Run:\n' +
              '     ALTER ROLE healthcloud_app NOBYPASSRLS;',
          );
        }
      }

      await client.end();
    } catch (err) {
      await client.end().catch(() => {});
      const msg = String(err?.message ?? err);

      if (/ECONNREFUSED/i.test(msg)) {
        fail(
          `${label}: cannot reach PostgreSQL`,
          'Is the service running?\n' +
            '     PowerShell:  Get-Service postgresql*\n' +
            '     Start it:    Start-Service postgresql-x64-18   (elevated)',
        );
      } else if (/does not exist/i.test(msg)) {
        fail(
          `${label}: role or database does not exist`,
          'Run the one-time bootstrap:\n' +
            '     psql -U postgres -h localhost -p 5432 -f infra/local/bootstrap.sql',
        );
      } else if (/password|authentication/i.test(msg)) {
        // Postgres reports a non-existent role as an authentication failure on
        // purpose, to stop attackers enumerating valid usernames. So this one
        // error covers two very different causes, and the common one by far is
        // that the bootstrap simply hasn't been run yet.
        fail(
          `${label}: authentication failed (role missing, or wrong password)`,
          'Most likely the one-time bootstrap has not been run yet:\n' +
            '       psql -U postgres -h localhost -p 5432 -f infra/local/bootstrap.sql\n' +
            '     If you have run it, the password in .env does not match the role —\n' +
            '     re-run bootstrap.sql with -v owner_password / -v app_password, or\n' +
            '     update the URL in .env to match what you set.',
        );
      } else {
        fail(`${label}: ${msg}`, 'See infra/local/bootstrap.sql for the expected setup.');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Redis / Memurai
// ---------------------------------------------------------------------------
async function checkRedis() {
  if (!env.REDIS_URL) return;
  let host = 'localhost';
  let port = 6379;
  try {
    const u = new URL(env.REDIS_URL);
    host = u.hostname || host;
    port = Number(u.port || 6379);
  } catch {
    fail('REDIS_URL is not a valid URL', 'Expected something like redis://localhost:6379');
    return;
  }

  const ok = await checkTcp(host, port);
  if (!ok) {
    // Deliberately a WARNING, not a failure.
    //
    // Nothing in Phase 1 touches Redis — the outbox worker and BullMQ queues
    // arrive later. Hard-failing here would block `pnpm dev` on an elevated
    // PowerShell for work that does not need it, and a gate that blocks work it
    // has no stake in is a gate people learn to bypass.
    //
    // FLIP THIS TO fail() when apps/workers lands and queues become load-bearing.
    notes.push(
      `Redis/Memurai is not running on ${host}:${port} — fine for now, nothing in ` +
        `Phase 1 uses it.\n    When you need it: Start-Service Memurai (elevated PowerShell).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
console.log(`\n${dim('HealthCloud preflight')}`);

await checkPostgres();
await checkRedis();

if (problems.length === 0) {
  console.log(`${green('✓')} Environment looks good.\n`);
  for (const n of notes) console.log(`  ${yellow('!')} ${n}`);
  if (notes.length) console.log('');
  process.exit(0);
}

console.error(`\n${red(`✗ ${problems.length} problem${problems.length > 1 ? 's' : ''} found:`)}\n`);
for (const [i, p] of problems.entries()) {
  console.error(`  ${red(`${i + 1}.`)} ${p.title}`);
  console.error(`     ${dim(p.remedy)}\n`);
}
for (const n of notes) console.error(`  ${yellow('!')} ${n}\n`);
console.error(dim('  Setup guide: README.md → Getting started\n'));
process.exit(1);
