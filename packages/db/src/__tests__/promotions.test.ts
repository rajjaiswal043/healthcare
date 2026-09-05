/**
 * Promotions — tenant isolation and the constraints that guard the money.
 *
 * Two properties, and they fail in different ways.
 *
 * **Isolation.** A promotion is a clinic's own commercial arrangement. One
 * clinic reading — or worse, applying — another's discount is the same class of
 * breach as reading their patients, and it is prevented the same way: policies
 * on the table, not a `WHERE` clause somebody has to remember.
 *
 * **The constraints.** Every rule FR-PRO-01 states in words is a CHECK here
 * rather than a service-layer test, because a discount is money leaving the
 * clinic and the service layer is one bug away from being wrong about it. These
 * tests assert the DATABASE refuses, which is the only claim worth making — a
 * validation that lives solely in a DTO is one careless `$executeRaw` from
 * being bypassed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPrismaClient } from '../client.js';
import { withTenant } from '../tenancy.js';
import type { PrismaClient } from '../generated/prisma/client.js';

const TENANT_A = '01930000-0000-7000-8000-00000000010a';
const TENANT_B = '01930000-0000-7000-8000-00000000010b';

let prisma: PrismaClient;
let owner: pg.Client;

/** A staff user per tenant — every promotion needs an author. */
let userA: string;
let userB: string;
let promoA: string;

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
 * Run on the owner connection with tenant context set.
 *
 * Needed for fixtures AND assertions. FORCE row-level security applies to the
 * table owner too, so a context-less read returns nothing whatever is stored —
 * an assertion written without this would pass for entirely the wrong reason.
 */
async function asTenant<T extends pg.QueryResultRow = pg.QueryResultRow>(
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

/** Insert a promotion, returning whatever the database said about it. */
function insertPromotion(
  tenantId: string,
  userId: string,
  overrides: {
    code?: string;
    type?: 'PERCENTAGE' | 'FLAT';
    value?: number;
    maxDiscountPaise?: number | null;
    validFrom?: string;
    validTo?: string | null;
  } = {},
) {
  return asTenant<{ id: string }>(
    tenantId,
    `INSERT INTO promotion
       (tenant_id, code, name, type, value, max_discount_paise,
        valid_from, valid_to, created_by_user_id, updated_at)
     VALUES ($1, $2, 'Camp discount', $3::promotion_type, $4, $5, $6::date, $7::date, $8, now())
     RETURNING id`,
    [
      tenantId,
      overrides.code ?? 'CAMP50',
      overrides.type ?? 'PERCENTAGE',
      overrides.value ?? 50,
      overrides.maxDiscountPaise === undefined ? null : overrides.maxDiscountPaise,
      overrides.validFrom ?? '2026-09-01',
      overrides.validTo === undefined ? '2026-09-30' : overrides.validTo,
      userId,
    ],
  );
}

beforeEach(async () => {
  await owner.query(
    'TRUNCATE TABLE "promotion_application", "promotion", "app_user", "tenant" RESTART IDENTITY CASCADE',
  );

  // `tenant` defines tenants, so it is not itself tenant-scoped.
  await owner.query(
    `INSERT INTO "tenant" (id, slug, legal_name, name, updated_at) VALUES
       ($1, 'promo-a', 'Clinic A Pvt Ltd', 'Clinic A', now()),
       ($2, 'promo-b', 'Clinic B Pvt Ltd', 'Clinic B', now())`,
    [TENANT_A, TENANT_B],
  );

  const [a] = await asTenant<{ id: string }>(
    TENANT_A,
    `INSERT INTO app_user (tenant_id, email, full_name, password_hash, updated_at)
     VALUES ($1, 'admin@promo-a.test', 'Admin A', 'scrypt$x', now()) RETURNING id`,
    [TENANT_A],
  );
  const [b] = await asTenant<{ id: string }>(
    TENANT_B,
    `INSERT INTO app_user (tenant_id, email, full_name, password_hash, updated_at)
     VALUES ($1, 'admin@promo-b.test', 'Admin B', 'scrypt$x', now()) RETURNING id`,
    [TENANT_B],
  );

  userA = a!.id;
  userB = b!.id;

  const [promo] = await insertPromotion(TENANT_A, userA);
  promoA = promo!.id;

  await insertPromotion(TENANT_B, userB, { code: 'STAFF100', type: 'FLAT', value: 20000 });
});

describe('tenant isolation', () => {
  it('shows a clinic only its own promotions', async () => {
    const forA = await withTenant(prisma, TENANT_A, (tx) => tx.promotion.findMany());
    const forB = await withTenant(prisma, TENANT_B, (tx) => tx.promotion.findMany());

    expect(forA.map((p) => p.code)).toEqual(['CAMP50']);
    expect(forB.map((p) => p.code)).toEqual(['STAFF100']);
  });

  it('hides another clinic promotion even when its id is known', async () => {
    // The exact shape of an IDOR attempt: a real id, and a session that has no
    // business with it.
    const found = await withTenant(prisma, TENANT_B, (tx) =>
      tx.promotion.findUnique({ where: { id: promoA } }),
    );

    expect(found).toBeNull();
  });

  it('refuses to write a promotion stamped with another clinic id', async () => {
    // This is what the WITH CHECK half of the policy is for. Without it the row
    // would insert and simply be invisible afterwards — a table you can write
    // across but not read across.
    await expect(
      withTenant(prisma, TENANT_B, (tx) =>
        tx.promotion.create({
          data: {
            tenantId: TENANT_A,
            code: 'SNEAK',
            name: 'Written into the wrong clinic',
            type: 'FLAT',
            value: 5000,
            validFrom: new Date('2026-09-01'),
            createdByUserId: userB,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('leaves the other clinic promotion untouched after a refused write', async () => {
    const stillThere = await asTenant(TENANT_A, `SELECT code FROM promotion WHERE id = $1`, [
      promoA,
    ]);
    expect(stillThere).toHaveLength(1);
  });

  it('lets the same code exist in two different clinics', async () => {
    // Uniqueness is per tenant, not global. Two clinics both running CAMP50 is
    // ordinary, and a global constraint would let one clinic's setup fail
    // because of a name another clinic had chosen.
    const [row] = await insertPromotion(TENANT_B, userB, { code: 'CAMP50' });
    expect(row?.id).toBeTruthy();
  });

  it('refuses the same code twice in one clinic', async () => {
    await expect(insertPromotion(TENANT_A, userA, { code: 'CAMP50' })).rejects.toThrow();
  });
});

describe('value bounds', () => {
  it('accepts a 100% promotion', async () => {
    // Allowed on purpose. "Don't charge this patient" is the case the feature
    // exists for, and refusing it would push clinics back to the hand-written
    // note this replaces.
    const [row] = await insertPromotion(TENANT_A, userA, { code: 'FREE', value: 100 });
    expect(row?.id).toBeTruthy();
  });

  it('refuses a percentage above 100', async () => {
    await expect(insertPromotion(TENANT_A, userA, { code: 'OVER', value: 101 })).rejects.toThrow(
      /promotion_value_within_bounds/,
    );
  });

  it('refuses a percentage of zero', async () => {
    // A promotion that discounts nothing is a mistake, not a policy.
    await expect(insertPromotion(TENANT_A, userA, { code: 'ZERO', value: 0 })).rejects.toThrow(
      /promotion_value_within_bounds/,
    );
  });

  it('refuses a negative value', async () => {
    await expect(
      insertPromotion(TENANT_A, userA, { code: 'NEG', type: 'FLAT', value: -100 }),
    ).rejects.toThrow(/promotion_value_within_bounds/);
  });

  it('refuses a flat amount above one crore', async () => {
    // MAX_PAISE, matching the billing DTOs: a typo of a few extra zeroes is
    // refused at the door rather than corrected in the ledger afterwards.
    await expect(
      insertPromotion(TENANT_A, userA, { code: 'HUGE', type: 'FLAT', value: 100_000_001 }),
    ).rejects.toThrow(/promotion_value_within_bounds/);
  });

  it('accepts a flat amount in paise', async () => {
    const [row] = await insertPromotion(TENANT_A, userA, {
      code: 'FLAT200',
      type: 'FLAT',
      value: 20000,
    });
    expect(row?.id).toBeTruthy();
  });
});

describe('the discount cap', () => {
  it('accepts a promotion with no cap', async () => {
    const [row] = await insertPromotion(TENANT_A, userA, {
      code: 'UNCAPPED',
      maxDiscountPaise: null,
    });
    expect(row?.id).toBeTruthy();
  });

  it('accepts a positive cap', async () => {
    const [row] = await insertPromotion(TENANT_A, userA, {
      code: 'CAPPED',
      maxDiscountPaise: 400000,
    });
    expect(row?.id).toBeTruthy();
  });

  it('refuses a cap of zero', async () => {
    // Uncapped is NULL. A cap of zero would silently make every discount
    // nothing, which is worse than refusing it outright.
    await expect(
      insertPromotion(TENANT_A, userA, { code: 'CAPZERO', maxDiscountPaise: 0 }),
    ).rejects.toThrow(/promotion_cap_positive/);
  });

  it('refuses a negative cap', async () => {
    await expect(
      insertPromotion(TENANT_A, userA, { code: 'CAPNEG', maxDiscountPaise: -1 }),
    ).rejects.toThrow(/promotion_cap_positive/);
  });
});

describe('validity dates', () => {
  it('accepts an open-ended promotion', async () => {
    const [row] = await insertPromotion(TENANT_A, userA, { code: 'FOREVER', validTo: null });
    expect(row?.id).toBeTruthy();
  });

  it('accepts a single-day promotion', async () => {
    const [row] = await insertPromotion(TENANT_A, userA, {
      code: 'ONEDAY',
      validFrom: '2026-09-10',
      validTo: '2026-09-10',
    });
    expect(row?.id).toBeTruthy();
  });

  it('refuses a promotion that ends before it begins', async () => {
    await expect(
      insertPromotion(TENANT_A, userA, {
        code: 'BACKWARDS',
        validFrom: '2026-09-30',
        validTo: '2026-09-01',
      }),
    ).rejects.toThrow(/promotion_dates_ordered/);
  });
});

describe('what the application role may do', () => {
  it('cannot delete a promotion', async () => {
    // FR-PRO-01: switched off, never deleted. An invoice from March has to keep
    // explaining itself in September. The REVOKE is what makes that true —
    // bootstrap.sql grants all four privileges on every new table, so a
    // narrower GRANT alone would be decorative.
    await expect(
      withTenant(prisma, TENANT_A, (tx) => tx.promotion.delete({ where: { id: promoA } })),
    ).rejects.toThrow();
  });

  it('can switch a promotion off', async () => {
    const updated = await withTenant(prisma, TENANT_A, (tx) =>
      tx.promotion.update({ where: { id: promoA }, data: { isActive: false } }),
    );
    expect(updated.isActive).toBe(false);
  });

  it('holds only SELECT and INSERT on promotion_application', async () => {
    // Append-only, exactly like `payment`. This is the row that answers "who
    // gave this money away, and on whose instruction"; one that can be edited
    // or removed answers nothing. Asserted against the privilege list because
    // the mistake is otherwise invisible until someone tries it in production.
    const granted = await asTenant<{ privilege_type: string }>(
      TENANT_A,
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_name = 'promotion_application' AND grantee = 'healthcloud_app'
        ORDER BY privilege_type`,
    );

    expect(granted.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });
});
