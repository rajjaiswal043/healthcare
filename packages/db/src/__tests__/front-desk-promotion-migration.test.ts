/**
 * Migration 20260922110000 — the front desk may apply a discount.
 *
 * Run here against clinics set up the three ways that matter: a front desk as
 * shipped, a front desk the clinic has edited, and the other roles beside
 * them. The migration is plain SQL, so the test runs the file itself rather
 * than a copy of what it is meant to do.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { SYSTEM_ROLES } from '../permissions.js';

// From the package root, where vitest runs: this package builds to CommonJS,
// so `import.meta.url` is not available to find the file relative to this one.
const MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260922110000_front_desk_promotion_apply/migration.sql',
  ),
  'utf-8',
);

const AS_SHIPPED = '01930000-0000-7000-8000-0000000002a1';
const EDITED = '01930000-0000-7000-8000-0000000002b1';

const fromCode = (key: string) => SYSTEM_ROLES.find((r) => r.key === key)!.permissions;

/**
 * Permissions the front desk gained AFTER this migration, from migrations of
 * their own. Removed here so "as shipped before this change" still means what
 * it meant on 22 Sep 2026: 20260929090000 added the follow-up board.
 */
const ADDED_LATER = ['followup:read', 'followup:manage'];

/** The front desk as it shipped BEFORE this change — what the migration looks for. */
const OLD_FRONT_DESK = fromCode('front_desk').filter(
  (p) => p !== 'promotion:apply' && !ADDED_LATER.includes(p),
);

let owner: pg.Client;

beforeAll(async () => {
  const ownerUrl = process.env.TEST_MIGRATION_DATABASE_URL;
  if (!ownerUrl) throw new Error('TEST_MIGRATION_DATABASE_URL must be set.');
  owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
});

async function asTenant<T extends pg.QueryResultRow>(
  tenantId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await owner.query('BEGIN');
  try {
    await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await owner.query<T>(sql, params);
    await owner.query('COMMIT');
    return result.rows;
  } catch (err) {
    await owner.query('ROLLBACK');
    throw err;
  }
}

/** Every role in a clinic, exactly as stored — permissions in stored order. */
const roles = (tenantId: string) =>
  asTenant<{ key: string; permissions: string[]; updated_at: Date }>(
    tenantId,
    'SELECT key, permissions, updated_at FROM role ORDER BY key',
  );

const role = async (tenantId: string, key: string) =>
  (await roles(tenantId)).find((r) => r.key === key)!;

beforeEach(async () => {
  await owner.query('TRUNCATE TABLE "role", "tenant" RESTART IDENTITY CASCADE');
  await owner.query(
    `INSERT INTO "tenant" (id, slug, legal_name, name, updated_at) VALUES
       ($1, 'fd-shipped', 'Shipped Pvt Ltd', 'Shipped', now()),
       ($2, 'fd-edited', 'Edited Pvt Ltd', 'Edited', now())`,
    [AS_SHIPPED, EDITED],
  );

  for (const tenantId of [AS_SHIPPED, EDITED]) {
    // The front desk as shipped before this change, in a shuffled order — the
    // migration compares SETS, and an administrator's save can reorder them.
    const frontDesk =
      tenantId === AS_SHIPPED
        ? [...OLD_FRONT_DESK].reverse()
        : // Edited: this clinic took cancelling appointments away from its desk.
          OLD_FRONT_DESK.filter((p) => p !== 'appointment:cancel');

    await asTenant(
      tenantId,
      `INSERT INTO role (tenant_id, key, name, permissions, is_system, updated_at) VALUES
         ($1, 'front_desk', 'Front desk', $2, true, now() - interval '1 day'),
         ($1, 'finance', 'Finance', $3, true, now() - interval '1 day'),
         ($1, 'doctor', 'Doctor', $4, true, now() - interval '1 day')`,
      [tenantId, frontDesk, fromCode('finance'), fromCode('doctor')],
    );
  }
});

describe('giving the front desk promotion:apply', () => {
  it('matches what the code now ships, one permission short', () => {
    // If the front desk's default changes again, this migration's idea of
    // "as shipped" is stale — and this fails before anyone runs it.
    expect(fromCode('front_desk')).toContain('promotion:apply');
    expect([...OLD_FRONT_DESK].sort()).toEqual(
      [
        ...(MIGRATION.match(/v_default\s+text\[\] := ARRAY\[([^\]]+)\]/)![1]!.match(/'[^']+'/g) ??
          []),
      ]
        .map((p) => p.slice(1, -1))
        .sort(),
    );
  });

  it('adds it to a front desk as shipped, and nothing else', async () => {
    const before = await role(AS_SHIPPED, 'front_desk');

    await owner.query(MIGRATION);

    const after = await role(AS_SHIPPED, 'front_desk');
    expect(after.permissions).toEqual([...before.permissions, 'promotion:apply']);
  });

  it('leaves a front desk the clinic has edited exactly as it was', async () => {
    const before = await role(EDITED, 'front_desk');

    await owner.query(MIGRATION);

    expect(await role(EDITED, 'front_desk')).toEqual(before);
  });

  it('does not touch any other role', async () => {
    const before = [
      ...(await roles(AS_SHIPPED)).filter((r) => r.key !== 'front_desk'),
      ...(await roles(EDITED)).filter((r) => r.key !== 'front_desk'),
    ];

    await owner.query(MIGRATION);

    const after = [
      ...(await roles(AS_SHIPPED)).filter((r) => r.key !== 'front_desk'),
      ...(await roles(EDITED)).filter((r) => r.key !== 'front_desk'),
    ];
    expect(after).toEqual(before);
  });

  it('changes nothing the second time it runs', async () => {
    await owner.query(MIGRATION);
    const once = [...(await roles(AS_SHIPPED)), ...(await roles(EDITED))];

    await owner.query(MIGRATION);

    expect([...(await roles(AS_SHIPPED)), ...(await roles(EDITED))]).toEqual(once);
    expect(
      (await role(AS_SHIPPED, 'front_desk')).permissions.filter((p) => p === 'promotion:apply'),
    ).toHaveLength(1);
  });
});
