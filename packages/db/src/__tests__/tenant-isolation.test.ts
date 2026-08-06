/**
 * Cross-tenant isolation suite — ADR-005.
 *
 * This is the most important test file in the repository.
 *
 * It does not check that the happy path works. It checks that the ATTACK path
 * fails: that when the service layer is handed another tenant's identifier —
 * through a bug, a crafted request, or an IDOR attempt — PostgreSQL refuses.
 *
 * Every test here connects as `healthcloud_app`, exactly as the running
 * application does. Fixtures are created through a separate owner-role
 * connection, because the app role cannot see across tenants to set them up —
 * which is itself the property under test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPrismaClient } from '../client.js';
import { withTenant, InvalidTenantIdError } from '../tenancy.js';
import type { PrismaClient } from '../generated/prisma/client.js';

const TENANT_A = '01930000-0000-7000-8000-00000000000a';
const TENANT_B = '01930000-0000-7000-8000-00000000000b';

let prisma: PrismaClient;
let owner: pg.Client;

/** Ids of the seeded locations, needed to attempt direct-by-id access. */
let locationA: string;
let locationB: string;

beforeAll(async () => {
  const appUrl = process.env.TEST_DATABASE_URL;
  const ownerUrl = process.env.TEST_MIGRATION_DATABASE_URL;
  if (!appUrl || !ownerUrl) {
    throw new Error('TEST_DATABASE_URL / TEST_MIGRATION_DATABASE_URL must be set.');
  }

  prisma = createPrismaClient(appUrl);
  owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

/**
 * Seed locations for one tenant.
 *
 * Note that even the OWNER connection has to set tenant context to insert here.
 * That is `FORCE ROW LEVEL SECURITY` doing its job: policies apply to the table
 * owner as well, so there is no connection to this database — app or owner —
 * that can write across tenants. The awkwardness of this helper is the feature.
 */
async function seedLocations(
  tenantId: string,
  names: readonly string[],
): Promise<Array<{ id: string }>> {
  await owner.query('BEGIN');
  try {
    await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

    const { rows } = await owner.query(
      `INSERT INTO "location" (tenant_id, name, updated_at)
       SELECT $1::uuid, unnest($2::text[]), now()
       RETURNING id`,
      [tenantId, names],
    );

    await owner.query('COMMIT');
    return rows;
  } catch (err) {
    await owner.query('ROLLBACK');
    throw err;
  }
}

/**
 * Run a query on the owner connection with tenant context set.
 *
 * Needed for ASSERTIONS as well as fixtures: FORCE means the owner reads
 * through the policies too, so a context-less `SELECT ... WHERE tenant_id = B`
 * returns nothing regardless of what is actually stored. Verifying "B's row is
 * still intact" therefore has to be done as B.
 */
async function queryAsTenant<T extends pg.QueryResultRow = pg.QueryResultRow>(
  tenantId: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  await owner.query('BEGIN');
  try {
    await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await owner.query<T>(sql, params as unknown[]);
    await owner.query('COMMIT');
    return result.rows;
  } catch (err) {
    await owner.query('ROLLBACK');
    throw err;
  }
}

beforeEach(async () => {
  // TRUNCATE is a table-level operation and is not filtered by RLS policies,
  // so the owner can still reset fixtures.
  await owner.query('TRUNCATE TABLE "location", "tenant" RESTART IDENTITY CASCADE');

  // `tenant` is not tenant-scoped (it defines tenants), so this needs no context.
  await owner.query(
    `INSERT INTO "tenant" (id, slug, legal_name, name, updated_at) VALUES
       ($1, 'clinic-a', 'Clinic A Pvt Ltd', 'Clinic A', now()),
       ($2, 'clinic-b', 'Clinic B Pvt Ltd', 'Clinic B', now())`,
    [TENANT_A, TENANT_B],
  );

  const rowsA = await seedLocations(TENANT_A, ['A Main Branch', 'A Second Branch']);
  const rowsB = await seedLocations(TENANT_B, ['B Main Branch']);

  locationA = rowsA[0]!.id;
  locationB = rowsB[0]!.id;
});

describe('reads are confined to the current tenant', () => {
  it('returns only the current tenant rows', async () => {
    const forA = await withTenant(prisma, TENANT_A, (tx) => tx.location.findMany());
    const forB = await withTenant(prisma, TENANT_B, (tx) => tx.location.findMany());

    expect(forA).toHaveLength(2);
    expect(forA.every((l) => l.tenantId === TENANT_A)).toBe(true);

    expect(forB).toHaveLength(1);
    expect(forB[0]!.tenantId).toBe(TENANT_B);
  });

  it('hides another tenant row even when its exact id is supplied', async () => {
    // The IDOR case: the service layer has been handed a valid id belonging to
    // someone else. Application-layer filtering is bypassed entirely here — the
    // database is the only thing standing in the way.
    const stolen = await withTenant(prisma, TENANT_A, (tx) =>
      tx.location.findUnique({ where: { id: locationB } }),
    );

    expect(stolen).toBeNull();
  });

  it('does not leak another tenant row through a count', async () => {
    const count = await withTenant(prisma, TENANT_A, (tx) =>
      tx.location.count({ where: { id: locationB } }),
    );

    expect(count).toBe(0);
  });
});

describe('writes cannot cross a tenant boundary', () => {
  it('updates nothing when targeting another tenant row', async () => {
    const result = await withTenant(prisma, TENANT_A, (tx) =>
      tx.location.updateMany({ where: { id: locationB }, data: { name: 'HIJACKED' } }),
    );

    expect(result.count).toBe(0);

    const rows = await queryAsTenant<{ name: string }>(
      TENANT_B,
      'SELECT name FROM "location" WHERE id = $1',
      [locationB],
    );
    expect(rows[0]!.name).toBe('B Main Branch');
  });

  it('deletes nothing when targeting another tenant row', async () => {
    const result = await withTenant(prisma, TENANT_A, (tx) =>
      tx.location.deleteMany({ where: { id: locationB } }),
    );

    expect(result.count).toBe(0);

    const rows = await queryAsTenant<{ n: number }>(
      TENANT_B,
      'SELECT count(*)::int AS n FROM "location" WHERE id = $1',
      [locationB],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses an insert stamped with another tenant id', async () => {
    // This is what WITH CHECK exists for. Without it, a caller could write rows
    // into a tenant it cannot read from — planting data rather than stealing it.
    await expect(
      withTenant(prisma, TENANT_A, (tx) =>
        tx.location.create({
          data: { tenantId: TENANT_B, name: 'Planted by A', updatedAt: new Date() },
        }),
      ),
    ).rejects.toThrow();

    const rows = await queryAsTenant<{ n: number }>(
      TENANT_B,
      'SELECT count(*)::int AS n FROM "location" WHERE tenant_id = $1',
      [TENANT_B],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses to move a row into another tenant', async () => {
    await expect(
      withTenant(prisma, TENANT_A, (tx) =>
        tx.location.update({ where: { id: locationA }, data: { tenantId: TENANT_B } }),
      ),
    ).rejects.toThrow();
  });
});

describe('missing tenant context fails closed', () => {
  it('returns zero rows when no tenant context is set', async () => {
    // The bug we actually expect one day: a query that skipped withTenant.
    // current_tenant_id() returns NULL, `tenant_id = NULL` is NULL, the policy
    // denies. The result is empty, never everything.
    const rows = await prisma.location.findMany();
    expect(rows).toHaveLength(0);
  });

  it('cannot insert without tenant context', async () => {
    await expect(
      prisma.location.create({
        data: { tenantId: TENANT_A, name: 'No context', updatedAt: new Date() },
      }),
    ).rejects.toThrow();
  });

  it('rejects a malformed tenant id before touching the database', async () => {
    await expect(
      withTenant(prisma, 'not-a-uuid', async (tx) => tx.location.findMany()),
    ).rejects.toBeInstanceOf(InvalidTenantIdError);
  });
});

describe('tenant context does not leak between transactions', () => {
  it('does not carry context over on a pooled connection', async () => {
    // set_config(..., is_local => true) is transaction-scoped. If it were
    // session-scoped, connection reuse would hand one tenant's context to the
    // next request that happened to get the same pooled connection — a leak
    // that would only appear under concurrency, in production.
    await withTenant(prisma, TENANT_B, (tx) => tx.location.findMany());

    const afterwards = await prisma.location.findMany();
    expect(afterwards).toHaveLength(0);

    const forA = await withTenant(prisma, TENANT_A, (tx) => tx.location.findMany());
    expect(forA).toHaveLength(2);
    expect(forA.every((l) => l.tenantId === TENANT_A)).toBe(true);
  });
});

describe('the app role cannot escape RLS', () => {
  it('is not a superuser and does not have BYPASSRLS', async () => {
    // Belt and braces: if either of these were ever granted, every test above
    // would still pass while providing no protection whatsoever.
    const rows = await prisma.$queryRaw<
      Array<{ rolsuper: boolean; rolbypassrls: boolean }>
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;

    expect(rows[0]!.rolsuper).toBe(false);
    expect(rows[0]!.rolbypassrls).toBe(false);
  });

  it('does not own the tables it queries', async () => {
    // Ownership would exempt the role from its own policies unless FORCE is set.
    // We set FORCE, but relying on a single control is how single controls fail.
    const rows = await prisma.$queryRaw<Array<{ owner: string }>>`
      SELECT pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'location'
    `;

    expect(rows[0]!.owner).not.toBe('healthcloud_app');
  });
});
