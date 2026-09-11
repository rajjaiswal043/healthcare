/**
 * The Finance role — FR-FIN-01, from the clinic demos of 3 Sep 2026.
 *
 * A member of staff whose entire job is money. The requirement is written as a
 * can-do / cannot-do table, and the cannot-do half is the half worth testing: a
 * role that quietly holds one permission too many is indistinguishable from a
 * correct one until the day somebody uses it.
 *
 * Three things carry this file.
 *
 * **The permission set is exact.** Not "contains what it needs" — exactly what
 * it needs and nothing else, asserted as a set. A superset assertion would have
 * passed while the role held `payment:refund`.
 *
 * **A clinic that already existed gets the role too.** New clinics get it from
 * SYSTEM_ROLES at onboarding; existing ones only get it from the backfill
 * migration. That migration runs as the table owner under FORCE row-level
 * security, so without its `set_config` loop it matches zero rows and reports
 * success — which has happened in this repository before. The test runs the
 * real migration file against a clinic that lacks the role, rather than
 * asserting the migration merely ran.
 *
 * **Opening today's visit is not holding the diary.** `visit:open` was split
 * from `appointment:write` for this role. The split is only worth anything if
 * finance genuinely cannot book, reschedule or cancel.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSIONS, SYSTEM_ROLES } from '@healthcloud/db';
import {
  closeTestApp,
  createTestApp,
  ownerQuery,
  seedFixtures,
  TENANT_MAIN,
  type Fixtures,
} from './harness.js';

let app: NestFastifyApplication;
let fx: Fixtures;

/**
 * Exactly what the FR-FIN-01 table grants, in the order the requirement lists
 * the capabilities. Written out longhand rather than imported from SYSTEM_ROLES
 * — a test that reads its expectation from the thing under test asserts only
 * that the code equals itself.
 */
const EXPECTED_FINANCE_PERMISSIONS = [
  // "Search patients, open a record" / "Register a new patient"
  'patient:read',
  'patient:write',
  // "See which doctors are consulting today, and whether they have room"
  'appointment:read',
  // "Open today's visit for a doctor"
  'visit:open',
  // "Raise an invoice, add and remove charges"
  'invoice:read',
  'invoice:write',
  // "Take payment"
  'payment:collect',
  // "Apply an authorised promotion"
  'promotion:apply',
  // FR-DIA-12 decision 1, 11 Sep 2026: a walk-in test is priced, paid for and
  // requested at this desk in one action. Deliberately NOT `diagnostic:order`,
  // which would let finance order tests on anybody's consultation.
  'diagnostic:order:walkin',
  // "See all financial reporting"
  'report:revenue',
].sort();

/**
 * The cannot-do half of the table, plus the three ways money leaves without a
 * service behind it. Each one is a separate expectation so a failure names the
 * permission rather than the array.
 */
const FORBIDDEN_FOR_FINANCE = [
  // "Cannot book or reschedule a future appointment, cancel one"
  'appointment:write',
  'appointment:cancel',
  // "order a test"
  'diagnostic:order',
  // "open or write a consultation, prescribe, record vitals"
  'consultation:read',
  'consultation:write',
  'prescription:write',
  'vitals:write',
  // "Refunds, waivers and deferrals stay with the administrator"
  'payment:refund',
  'invoice:waive',
  'invoice:defer',
  // Applies promotions; cannot invent one.
  'promotion:manage',
  /**
   * Removed 5 Sep 2026.
   *
   * The role shipped holding these on the reasoning that registration captures
   * DPDP consent. It does, but inside the registration transaction behind
   * `patient:write` — no route checks either permission. Holding them bought
   * finance nothing and pre-granted whatever a future standalone
   * consent-management endpoint would check.
   */
  'consent:read',
  'consent:write',
];

beforeAll(async () => {
  app = await createTestApp();
  fx = await seedFixtures();
});

afterAll(async () => {
  await closeTestApp(app);
});

/**
 * The migrations that together produce the finance role, in the order
 * `prisma migrate deploy` applies them.
 *
 * BOTH, deliberately. `20260905093000` creates the role with the eleven
 * permissions it originally shipped with, and `20260905120000` strips the two
 * consent ones. Replaying only the first would assert a state that existed for
 * a few hours on 5 Sep 2026 and exists nowhere now. An applied migration is
 * never edited — Prisma checksums them, and rewriting one breaks every machine
 * that already ran it — so the correction is its own file and the test replays
 * the pair.
 *
 * `__dirname` rather than `import.meta.url`: this package compiles to CommonJS
 * (SWC, for the decorator metadata Nest dependency injection needs), so
 * `import.meta` runs fine under vitest and fails `tsc`.
 */
const FINANCE_ROLE_MIGRATIONS = [
  '20260905093000_finance_role',
  '20260905120000_finance_role_consent',
  // A walk-in test is priced and requested at this desk (FR-DIA-12, decision 1
  // of 11 Sep 2026). Listed here because this test replays the backfill for a
  // clinic that already existed, and the list has to be every migration that
  // touches the finance role — otherwise the replay produces a role the real
  // deploy would not, which is the exact drift this file exists to catch.
  '20260911120000_walkin_order_permission',
];

function financeRoleMigrationSql(): string[] {
  return FINANCE_ROLE_MIGRATIONS.map((name) =>
    readFileSync(
      resolve(__dirname, `../../../../packages/db/prisma/migrations/${name}/migration.sql`),
      'utf8',
    ),
  );
}

/** Replay them in order, as a deploy would. */
async function replayFinanceRoleMigrations(tenantId: string): Promise<void> {
  for (const sql of financeRoleMigrationSql()) {
    await ownerQuery(tenantId, sql);
  }
}

/** The finance role row as a clinic actually holds it. */
async function financeRole(tenantId: string) {
  const rows = await ownerQuery<{
    key: string;
    name: string;
    permissions: string[];
    is_system: boolean;
    requires_mfa: boolean;
  }>(
    tenantId,
    `SELECT key, name, permissions, is_system, requires_mfa FROM role WHERE key = 'finance'`,
  );
  return rows[0];
}

describe('the role a newly onboarded clinic gets', () => {
  it('ships as a system role', async () => {
    const role = await financeRole(fx.main.id);

    expect(role).toBeDefined();
    expect(role?.name).toBe('Finance');
    // System roles are seeded and cannot be deleted, only edited. A clinic that
    // deleted Finance and then wanted it back would have no way to get it.
    expect(role?.is_system).toBe(true);
  });

  it('holds exactly the permissions FR-FIN-01 grants, and no others', async () => {
    const role = await financeRole(fx.main.id);
    expect([...(role?.permissions ?? [])].sort()).toEqual(EXPECTED_FINANCE_PERMISSIONS);
  });

  it.each(FORBIDDEN_FOR_FINANCE)('does not hold %s', async (permission) => {
    const role = await financeRole(fx.main.id);
    expect(role?.permissions).not.toContain(permission);
  });

  it('matches the front desk on two-factor', async () => {
    // Both move money; neither authorises its exceptions. If MFA_ENABLED is
    // turned on and this desk is judged to need TOTP as well, that is one line
    // in SYSTEM_ROLES — and this assertion is what will notice the drift.
    const finance = SYSTEM_ROLES.find((r) => r.key === 'finance');
    const frontDesk = SYSTEM_ROLES.find((r) => r.key === 'front_desk');

    expect(finance?.requiresMfa).toBe(frontDesk?.requiresMfa);
  });

  it('is seeded for every tenant, not just the first', async () => {
    // The second clinic is not decoration. A seeding bug that wrote the role
    // once, outside the per-tenant loop, would pass every assertion above.
    expect(await financeRole(fx.other.id)).toBeDefined();
  });
});

describe('the backfill, for a clinic that already existed', () => {
  /**
   * Simulate a clinic onboarded before this feature: roles present, Finance
   * absent, and the administrator without the promotion permissions. Then run
   * the REAL migration file and see whether anything happened.
   */
  it('creates the role, and widens the roles that needed widening', async () => {
    // Put the main tenant back into its pre-migration shape. The seeded finance
    // user holds the role, and `user_role_role_id_fkey` is RESTRICT, so the
    // membership goes first — a clinic onboarded before this feature had
    // neither the role nor anybody in it.
    await ownerQuery(
      TENANT_MAIN,
      `DELETE FROM user_role
        WHERE role_id IN (SELECT id FROM role WHERE key = 'finance')`,
    );
    await ownerQuery(TENANT_MAIN, `DELETE FROM role WHERE key = 'finance'`);
    await ownerQuery(
      TENANT_MAIN,
      `UPDATE role
          SET permissions = array_remove(
                              array_remove(
                                array_remove(permissions, 'promotion:manage'),
                                'promotion:apply'),
                              'visit:open')
        WHERE key IN ('administrator', 'front_desk')`,
    );

    expect(await financeRole(TENANT_MAIN)).toBeUndefined();

    // Each migration sets its own tenant context inside its loop, so these run
    // without any — exactly as `prisma migrate deploy` would run them.
    await replayFinanceRoleMigrations(TENANT_MAIN);

    const finance = await financeRole(TENANT_MAIN);
    expect(finance).toBeDefined();
    expect([...(finance?.permissions ?? [])].sort()).toEqual(EXPECTED_FINANCE_PERMISSIONS);

    const [admin] = await ownerQuery<{ permissions: string[] }>(
      TENANT_MAIN,
      `SELECT permissions FROM role WHERE key = 'administrator'`,
    );
    expect(admin?.permissions).toContain('promotion:manage');
    expect(admin?.permissions).toContain('promotion:apply');
    expect(admin?.permissions).toContain('visit:open');

    // The front desk keeps what it always could do. `visit:open` names the
    // walk-in power separately; it does not move it away from this role.
    const [frontDesk] = await ownerQuery<{ permissions: string[] }>(
      TENANT_MAIN,
      `SELECT permissions FROM role WHERE key = 'front_desk'`,
    );
    expect(frontDesk?.permissions).toContain('visit:open');
    expect(frontDesk?.permissions).toContain('appointment:write');
  });

  it('is idempotent, so a re-run creates nothing and duplicates nothing', async () => {
    await replayFinanceRoleMigrations(TENANT_MAIN);

    const rows = await ownerQuery(TENANT_MAIN, `SELECT id FROM role WHERE key = 'finance'`);
    expect(rows).toHaveLength(1);

    const [admin] = await ownerQuery<{ permissions: string[] }>(
      TENANT_MAIN,
      `SELECT permissions FROM role WHERE key = 'administrator'`,
    );
    // array_append with no guard would have added a second copy.
    expect(admin?.permissions.filter((p) => p === 'promotion:manage')).toHaveLength(1);
  });
});

describe('the permission vocabulary', () => {
  it('defines both promotion permissions', () => {
    expect(PERMISSIONS.PROMOTION_MANAGE).toBe('promotion:manage');
    expect(PERMISSIONS.PROMOTION_APPLY).toBe('promotion:apply');
  });

  it('defines opening a visit separately from writing an appointment', () => {
    expect(PERMISSIONS.VISIT_OPEN).toBe('visit:open');
    expect(PERMISSIONS.VISIT_OPEN).not.toBe(PERMISSIONS.APPOINTMENT_WRITE);
  });

  it('gives the administrator every new permission', async () => {
    // ALL_PERMISSIONS is spread into the administrator role, so this holds by
    // construction — but only as long as new permissions are added to
    // PERMISSIONS rather than invented at a call site.
    const [admin] = await ownerQuery<{ permissions: string[] }>(
      fx.other.id,
      `SELECT permissions FROM role WHERE key = 'administrator'`,
    );

    for (const permission of ['promotion:manage', 'promotion:apply', 'visit:open']) {
      expect(admin?.permissions).toContain(permission);
    }
  });

  it('grants promotion:manage to nobody except the administrator', async () => {
    // Defining a discount is an administrative act. If a second role ever needs
    // it, that is a decision somebody makes on purpose — and this fails first.
    const holders = SYSTEM_ROLES.filter((r) =>
      (r.permissions as readonly string[]).includes('promotion:manage'),
    ).map((r) => r.key);

    expect(holders).toEqual(['administrator']);
  });
});
