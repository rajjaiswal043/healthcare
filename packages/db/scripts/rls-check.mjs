#!/usr/bin/env node
/**
 * RLS coverage gate — ADR-005.
 *
 * Fails `pnpm verify` if any tenant-scoped table is not fully protected. This
 * is the check that turns tenant isolation from a thing developers remember
 * into a thing the build enforces. It was written before the first table
 * existed, so it can never be quietly weakened to accommodate one.
 *
 * For every base table in `public`, unless explicitly allowlisted below:
 *
 *   1. has a `tenant_id` column
 *   2. row-level security is ENABLED
 *   3. row-level security is FORCED  (so it applies to the table owner too)
 *   4. at least one policy exists
 *   5. every policy has BOTH a USING and a WITH CHECK clause
 *
 * Point 5 matters more than it looks. A policy with USING but no WITH CHECK
 * filters reads while permitting an INSERT stamped with someone else's
 * tenant_id — a table you can write across but not read across. That is a
 * subtle hole, and it is exactly the kind a human review misses.
 *
 *   node scripts/rls-check.mjs              verify (exit 1 on failure)
 *   node scripts/rls-check.mjs --emit-sql   print SQL for anything missing
 */

import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
loadEnv({ path: resolve(ROOT, '.env') });

const EMIT_SQL = process.argv.includes('--emit-sql');

/**
 * Tables that are legitimately NOT tenant-scoped.
 *
 * Every entry needs a reason. "It was easier" is not one — if a table holds
 * anything tenant-specific it belongs under RLS, and the burden of proof is on
 * the exemption. A stale entry here is itself reported as an error.
 */
const ALLOWLIST = new Map([
  ['_prisma_migrations', "Prisma's own migration ledger. No application data."],
  [
    'tenant',
    'The table that DEFINES tenants — there is no tenant to filter it by. Login ' +
      'must resolve a slug before any tenant context can exist. Holds no patient ' +
      'data; which rows a session may see is enforced by the auth guard.',
  ],
  [
    'platform_user',
    'doctorsdesk.in staff, who are not users of any clinic — that is the whole ' +
      'point of the table. Scoping it to a tenant would mean the account that ' +
      'onboards a clinic has to belong to one first. Holds no patient data.',
  ],
  [
    'platform_session',
    'Sessions for platform_user. Separate from `session` so a clinic refresh ' +
      'token can never be presented as a platform one. Holds no patient data.',
  ],
]);

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error(red('MIGRATION_DATABASE_URL is not set. Run `pnpm preflight`.'));
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });

/** @type {{table: string, problems: string[]}[]} */
const failures = [];
/** @type {string[]} */
const staleAllowlist = [];
let checked = 0;

try {
  await client.connect();

  const { rows: tables } = await client.query(`
    SELECT c.relname            AS table_name,
           c.relrowsecurity     AS rls_enabled,
           c.relforcerowsecurity AS rls_forced,
           EXISTS (
             SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema = 'public'
               AND col.table_name   = c.relname
               AND col.column_name  = 'tenant_id'
           )                    AS has_tenant_id
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
    ORDER BY c.relname
  `);

  const { rows: policies } = await client.query(`
    SELECT tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
  `);

  /** @type {Map<string, typeof policies>} */
  const byTable = new Map();
  for (const p of policies) {
    if (!byTable.has(p.tablename)) byTable.set(p.tablename, []);
    byTable.get(p.tablename).push(p);
  }

  const present = new Set(tables.map((t) => t.table_name));
  for (const name of ALLOWLIST.keys()) {
    if (!present.has(name)) staleAllowlist.push(name);
  }

  for (const t of tables) {
    if (ALLOWLIST.has(t.table_name)) continue;
    checked++;

    const problems = [];

    if (!t.has_tenant_id) {
      problems.push(
        'no `tenant_id` column — every tenant-scoped table needs one. If this table ' +
          'genuinely is not tenant-scoped, add it to ALLOWLIST in this script with a reason.',
      );
    }
    if (!t.rls_enabled) {
      problems.push(
        'row-level security is NOT enabled — `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`',
      );
    }
    if (!t.rls_forced) {
      problems.push(
        'row-level security is not FORCED — policies would not apply to the table owner',
      );
    }

    const tablePolicies = byTable.get(t.table_name) ?? [];
    if (tablePolicies.length === 0) {
      problems.push('no policies defined — RLS with no policy denies everything, silently');
    }

    for (const p of tablePolicies) {
      if (!p.qual) {
        problems.push(`policy "${p.policyname}" has no USING clause — reads are unfiltered`);
      }
      if (!p.with_check) {
        problems.push(
          `policy "${p.policyname}" has no WITH CHECK clause — a caller could INSERT or ` +
            'UPDATE a row into another tenant, writing across a boundary it cannot read across',
        );
      }
    }

    if (problems.length > 0) {
      failures.push({ table: t.table_name, problems });
    }
  }
} catch (err) {
  console.error(red(`RLS check could not run: ${err.message}`));
  console.error(dim('  Is the database up and migrated? Try `pnpm preflight`.'));
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}

if (staleAllowlist.length > 0) {
  console.error(
    yellow(`\n! Allowlist references ${staleAllowlist.length} table(s) that no longer exist:`),
  );
  for (const name of staleAllowlist) console.error(`    ${name}`);
  console.error(dim('  Remove them from ALLOWLIST so the exemption list stays meaningful.\n'));
}

if (failures.length === 0) {
  console.log(
    `${green('✓')} RLS check: ${checked} tenant-scoped table(s) protected, ` +
      `${ALLOWLIST.size} allowlisted.`,
  );
  process.exit(staleAllowlist.length > 0 ? 1 : 0);
}

console.error(red(`\n✗ RLS check failed — ${failures.length} table(s) are not protected:\n`));
for (const f of failures) {
  console.error(`  ${red(f.table)}`);
  for (const p of f.problems) console.error(`    - ${p}`);
  console.error('');
}

if (EMIT_SQL) {
  console.error(dim('  SQL to fix (add to the migration that creates the table):\n'));
  for (const f of failures) {
    console.error(`-- ${f.table}`);
    console.error(`ALTER TABLE "${f.table}" ENABLE ROW LEVEL SECURITY;`);
    console.error(`ALTER TABLE "${f.table}" FORCE ROW LEVEL SECURITY;`);
    console.error(`CREATE POLICY tenant_isolation ON "${f.table}"`);
    console.error(`  FOR ALL`);
    console.error(`  USING (tenant_id = current_tenant_id())`);
    console.error(`  WITH CHECK (tenant_id = current_tenant_id());`);
    console.error(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${f.table}" TO healthcloud_app;\n`);
  }
} else {
  console.error(dim('  Run `pnpm --filter @healthcloud/db rls:generate` to print the fix SQL.\n'));
}

process.exit(1);
