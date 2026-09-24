/**
 * Integration-test harness.
 *
 * Builds the real application — the one bootstrap.ts assembles for the server —
 * and drives it through `app.inject()`, Fastify's in-process request path. No
 * port is opened, so the suite cannot collide with a dev server, and nothing is
 * stubbed: requests go through helmet, CORS, the validation pipe, the auth
 * guard, the services, and PostgreSQL with row-level security applied.
 *
 * Fixtures are written through a SEPARATE owner-role connection, because the
 * application role cannot see across tenants to set up a cross-tenant test —
 * which is the property those tests exist to prove.
 */

import pg from 'pg';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SYSTEM_ROLES } from '@healthcloud/db';
import { hashPassword } from '../platform/auth/password.js';

/** The one password every seeded user has. Local test data, never a secret. */
export const TEST_PASSWORD = 'Integration-Test-Passw0rd';

/**
 * Fixed tenant ids so a failing test names something recognisable, and so the
 * "other tenant" in a cross-tenant assertion is unmistakably not a typo.
 */
export const TENANT_MAIN = '01930000-0000-7000-8000-0000000000a1';
export const TENANT_OTHER = '01930000-0000-7000-8000-0000000000b1';

export interface SeededTenant {
  id: string;
  slug: string;
  locationId: string;
  departmentId: string;
  practitionerId: string;
  /** Deliberately more than one, so "wrong patient" is expressible. */
  patientIds: string[];
}

export interface Fixtures {
  main: SeededTenant;
  other: SeededTenant;
}

/**
 * Every table the suite writes to, in dependency order.
 *
 * TRUNCATE ... CASCADE would be shorter, but naming them keeps the list
 * reviewable: a new table that holds patient data and is missing here leaves
 * rows behind between files, and a test that passes because of leftovers is
 * worse than one that fails.
 */
const TABLES = [
  // Platform tier first: platform_user is referenced by tenant, and
  // tenant_seat_limit by role. TRUNCATE ... CASCADE would sort this out on its
  // own, but the list is explicit for the reason in the comment above.
  'platform_session',
  'tenant_seat_limit',
  // Before `payment` and `invoice`, both of which they reference.
  'receipt_print',
  'receipt',
  'receipt_counter',
  'promotion_application',
  'promotion',
  'payment',
  'invoice_line',
  'invoice',
  'invoice_counter',
  'service',
  'encounter_addendum',
  'prescription',
  'diagnosis',
  'vitals_observation',
  'encounter',
  'formulary_item',
  'display_device',
  'appointment',
  'queue_counter',
  'schedule_exception',
  'practitioner_schedule',
  'practitioner',
  'department',
  'consent_record',
  'patient',
  'audit_event',
  'session',
  'user_role',
  'role',
  'app_user',
  'location',
  'tenant',
];

let ownerClient: pg.Client | undefined;

async function owner(): Promise<pg.Client> {
  if (!ownerClient) {
    const url = process.env.TEST_MIGRATION_DATABASE_URL;
    if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL is not set.');
    ownerClient = new pg.Client({ connectionString: url });
    await ownerClient.connect();
  }
  return ownerClient;
}

/**
 * Direct database access, for assertions that need to look behind the API.
 *
 * The tenant id is the FIRST parameter and is not optional, because every
 * interesting table is under `FORCE ROW LEVEL SECURITY` — including for the
 * owner. A query without context returns zero rows rather than an error, so an
 * assertion like `expect(rows.length).toBe(0)` would pass for entirely the
 * wrong reason. Requiring the tenant makes that mistake unspellable.
 */
export async function ownerQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  tenantId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return asTenant(tenantId, async (db) => {
    const { rows } = await db.query<T>(sql, params);
    return rows;
  });
}

/**
 * Run `sql` with tenant context set, inside a transaction.
 *
 * Even the table OWNER needs this. `FORCE ROW LEVEL SECURITY` applies policies
 * to the owner too, so there is no connection to this database that can write
 * across a tenant boundary. The awkwardness is the feature.
 */
async function asTenant<T>(tenantId: string, fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = await owner();
  await db.query('BEGIN');
  try {
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

/** Boot the application once for a test file. */
export async function createTestApp(): Promise<NestFastifyApplication> {
  // Dynamic import: the module graph reads process.env at import time, and
  // setup-env.ts must have finished redirecting DATABASE_URL first.
  const { createApiApp } = await import('../bootstrap.js');
  const app = await createApiApp();
  await app.init();
  // Fastify builds its router lazily; inject() before this races the first
  // request against route registration.
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

export async function closeTestApp(app: NestFastifyApplication): Promise<void> {
  await app.close();
  if (ownerClient) {
    await ownerClient.end();
    ownerClient = undefined;
  }
}

/** Wipe everything. Called before seeding, so each file starts from nothing. */
export async function resetDatabase(): Promise<void> {
  const db = await owner();
  await db.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/**
 * Clear the scheduling and consultation state, so tests within a file do not
 * interfere. The encounter tables are named rather than left to CASCADE: an
 * encounter that outlives its appointment is not a state the app can produce,
 * and leaving one behind makes the next test pass for the wrong reason.
 */
export async function resetAppointments(): Promise<void> {
  const db = await owner();
  await db.query(
    `TRUNCATE receipt_print, receipt, promotion_application, payment, invoice_line, invoice,
              encounter_addendum, prescription, diagnosis, vitals_observation, encounter,
              appointment, queue_counter
     RESTART IDENTITY CASCADE`,
  );
}

/**
 * Seed two tenants with the same shape.
 *
 * The second tenant is not decoration. Half the value of this suite is proving
 * that a session for one clinic cannot touch another's data, and that needs a
 * real other clinic with real other ids to aim at.
 *
 * The doctor sits EVERY day of the week. A schedule that skipped Sundays would
 * make the suite pass six days out of seven, which is the worst kind of test.
 */
export async function seedFixtures(): Promise<Fixtures> {
  await resetDatabase();

  // Hash once and reuse. scrypt is deliberately ~100ms per call (see
  // password.ts); doing it per user would add a second to every file for no
  // extra coverage.
  const passwordHash = await hashPassword(TEST_PASSWORD);

  const main = await seedTenant({
    id: TENANT_MAIN,
    slug: 'main-clinic',
    name: 'Main Clinic',
    passwordHash,
    emailDomain: 'main.test',
    doctorName: 'Dr Asha Menon',
  });

  const other = await seedTenant({
    id: TENANT_OTHER,
    slug: 'other-clinic',
    name: 'Other Clinic',
    passwordHash,
    emailDomain: 'other.test',
    doctorName: 'Dr Rohit Bhat',
  });

  return { main, other };
}

async function seedTenant(input: {
  id: string;
  slug: string;
  name: string;
  passwordHash: string;
  emailDomain: string;
  doctorName: string;
}): Promise<SeededTenant> {
  const db = await owner();

  // `tenant` is the table that DEFINES tenants, so it is not itself
  // tenant-scoped and needs no context.
  // Width 6 stated explicitly rather than taken from the column default. The
  // fixture patients below are written by hand as T000001…, six digits, and
  // the default moved to 5 on 15 Sep 2026 — left implicit, every patient a
  // test registers through the API would come out one digit shorter than the
  // fixtures beside it, which is confusing to read even though it never clashes.
  await db.query(
    `INSERT INTO tenant (id, slug, legal_name, name, uhid_prefix, uhid_padding, timezone, updated_at)
     VALUES ($1, $2, $3, $3, 'T', 6, 'Asia/Kolkata', now())`,
    [input.id, input.slug, input.name],
  );

  return asTenant(input.id, async (tx) => {
    const location = await one<{ id: string }>(
      tx,
      `INSERT INTO location (tenant_id, name, city, updated_at)
       VALUES ($1, 'Main Branch', 'Pune', now()) RETURNING id`,
      [input.id],
    );

    const department = await one<{ id: string }>(
      tx,
      `INSERT INTO department (tenant_id, name, display_order, updated_at)
       VALUES ($1, 'General Medicine', 1, now()) RETURNING id`,
      [input.id],
    );

    const practitioner = await one<{ id: string }>(
      tx,
      `INSERT INTO practitioner
         (tenant_id, full_name, prefix, registration_number, specialty,
          department_id, overbook_per_session, updated_at)
       VALUES ($1, $2, NULL, 'TEST-0001', 'General Medicine', $3, 0, now())
       RETURNING id`,
      [input.id, input.doctorName, department.id],
    );

    // 09:00–12:00, 15-minute slots, capacity 1, every day. Twelve slots, which
    // is enough to book several in one test without running out.
    for (let day = 0; day <= 6; day++) {
      await tx.query(
        `INSERT INTO practitioner_schedule
           (tenant_id, practitioner_id, location_id, day_of_week, start_time, end_time,
            slot_minutes, capacity_per_slot, visit_types, valid_from, updated_at)
         VALUES ($1, $2, $3, $4, '09:00', '12:00', 15, 1, '{}',
                 current_date - interval '30 days', now())`,
        [input.id, practitioner.id, location.id, day],
      );
    }

    const patientIds: string[] = [];
    const patients = [
      ['Kavita Rane', 'FEMALE', '9800000001'],
      ['Sanjay Gupta', 'MALE', '9800000002'],
      ['Farida Sheikh', 'FEMALE', '9800000003'],
    ] as const;

    for (const [index, [name, gender, mobile]] of patients.entries()) {
      const row = await one<{ id: string }>(
        tx,
        `INSERT INTO patient (tenant_id, uhid, name, gender, age_years, mobile, updated_at)
         VALUES ($1, $2, $3, $4::gender, 34, $5, now()) RETURNING id`,
        [input.id, `T${String(index + 1).padStart(6, '0')}`, name, gender, mobile],
      );
      patientIds.push(row.id);
    }

    /**
     * Move the tenant's UHID counter past what was just inserted.
     *
     * These patients are written directly, so `next_uhid()` never saw them and
     * would hand T000001 to the first patient registered through the API —
     * colliding with the fixture. Nothing noticed until a test registered a
     * patient rather than reading a seeded one, which is exactly the kind of
     * fixture bug that waits for the test that needed it.
     */
    await tx.query(`UPDATE tenant SET uhid_counter = $2 WHERE id = $1`, [
      input.id,
      patients.length,
    ]);

    // Roles come from the shared definition rather than a copy. The last time
    // these two drifted, every scheduling endpoint returned 403 with nothing to
    // explain why — see packages/db/src/permissions.ts.
    const roleIds = new Map<string, string>();
    for (const role of SYSTEM_ROLES) {
      const row = await one<{ id: string }>(
        tx,
        `INSERT INTO role
           (tenant_id, key, name, description, permissions, is_system, requires_mfa, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, now()) RETURNING id`,
        [input.id, role.key, role.name, role.description, role.permissions, role.requiresMfa],
      );
      roleIds.set(role.key, row.id);
    }

    const users: Array<{ email: string; name: string; role: string }> = [
      { email: `frontdesk@${input.emailDomain}`, name: 'Front Desk', role: 'front_desk' },
      { email: `nurse@${input.emailDomain}`, name: 'Nurse', role: 'nurse' },
      { email: `doctor@${input.emailDomain}`, name: input.doctorName, role: 'doctor' },
      { email: `finance@${input.emailDomain}`, name: 'Finance Desk', role: 'finance' },
      { email: `admin@${input.emailDomain}`, name: 'Administrator', role: 'administrator' },
      // A user of its own for the lockout test, so counting failures on it does
      // not leave every other test fighting a locked account.
      { email: `lockout@${input.emailDomain}`, name: 'Lockout Target', role: 'front_desk' },
    ];

    for (const user of users) {
      const row = await one<{ id: string }>(
        tx,
        `INSERT INTO app_user (tenant_id, email, full_name, password_hash, updated_at)
         VALUES ($1, $2, $3, $4, now()) RETURNING id`,
        [input.id, user.email, user.name, input.passwordHash],
      );

      await tx.query(`INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, [
        input.id,
        row.id,
        roleIds.get(user.role),
      ]);

      /**
       * Link the doctor's ACCOUNT to their PRACTITIONER row.
       *
       * These are two different things — the distinction that made a real
       * clinic's booking screen come up empty — and the fixture modelled a
       * clinic where they had never been joined. The queue now scopes itself on
       * exactly this link, so a fixture without it would have tested the
       * unrestricted path and called it covered.
       */
      if (user.role === 'doctor') {
        await tx.query(`UPDATE practitioner SET user_id = $2 WHERE id = $1`, [
          practitioner.id,
          row.id,
        ]);
      }
    }

    return {
      id: input.id,
      slug: input.slug,
      locationId: location.id,
      departmentId: department.id,
      practitionerId: practitioner.id,
      patientIds,
    };
  });
}

async function one<T extends pg.QueryResultRow>(
  db: pg.Client,
  sql: string,
  params: unknown[],
): Promise<T> {
  const { rows } = await db.query<T>(sql, params);
  const row = rows[0];
  if (!row) throw new Error(`Seed statement returned no row: ${sql.slice(0, 60)}…`);
  return row;
}

// --- request helpers --------------------------------------------------------

export interface Session {
  /** Ready to send as a `cookie` header. */
  cookie: string;
  accessToken: string;
  refreshToken: string;
  permissions: string[];
}

/** Sign in and return everything a later request needs. */
export async function login(
  app: NestFastifyApplication,
  tenantSlug: string,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { tenantSlug, email, password },
  });

  if (res.statusCode !== 200) {
    throw new Error(`login failed for ${email}: ${res.statusCode} ${res.payload}`);
  }

  const body = res.json<{ user?: { permissions: string[] } }>();
  if (!body.user) {
    throw new Error(`login for ${email} returned an MFA challenge, not a session.`);
  }

  const cookies = parseSetCookies(res.headers['set-cookie']);
  const accessToken = cookies.get('hc_at');
  const refreshToken = cookies.get('hc_rt');
  if (!accessToken || !refreshToken) {
    throw new Error(`login for ${email} did not set both session cookies.`);
  }

  return {
    cookie: `hc_at=${accessToken}; hc_rt=${refreshToken}`,
    accessToken,
    refreshToken,
    permissions: body.user.permissions,
  };
}

/**
 * Sign in as a user whose role requires MFA, enrolling on the way through.
 *
 * The administrator holds the permissions that let money leave — waive, defer,
 * refund — and its role requires TOTP, so there is no way to exercise those
 * endpoints without doing the enrolment for real. Which is the point: this also
 * gives the MFA flow its only end-to-end test.
 */
export async function loginWithMfa(
  app: NestFastifyApplication,
  tenantSlug: string,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<Session> {
  const challenge = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { tenantSlug, email, password },
  });

  const body = challenge.json<{ mfaRequired?: boolean; enrolmentSecret?: string }>();
  if (!body.mfaRequired || !body.enrolmentSecret) {
    throw new Error(`${email} did not return an enrolment challenge.`);
  }

  const { generate } = await import('otplib');
  const secret = body.enrolmentSecret;

  /**
   * Confirm across a TOTP step boundary without flaking.
   *
   * A code is generated for the current 30-second window. Generate one at
   * 29.9s and the server verifies it at 30.1s, in the next window, and rejects
   * a code that was correct when it was made. That is not a bug in either side
   * — it is the protocol — and it surfaced as `billing.e2e` failing its
   * beforeAll with "Invalid code" roughly one run in twenty, which is exactly
   * often enough to be dismissed as noise and waste an afternoon later.
   *
   * So: wait out the boundary and try once more. Bounded at two attempts,
   * because a third would be hiding a real failure rather than a timing one.
   */
  let res = await confirm(await generate({ secret }));

  if (res.statusCode !== 200) {
    await new Promise((r) => setTimeout(r, msUntilNextTotpWindow() + 250));
    res = await confirm(await generate({ secret }));
  }

  if (res.statusCode !== 200) {
    throw new Error(`MFA confirm failed for ${email}: ${res.statusCode} ${res.payload}`);
  }

  function confirm(totpCode: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/confirm',
      payload: { tenantSlug, email, password, totpCode },
    });
  }

  const cookies = parseSetCookies(res.headers['set-cookie']);
  const accessToken = cookies.get('hc_at');
  const refreshToken = cookies.get('hc_rt');
  if (!accessToken || !refreshToken) {
    throw new Error(`MFA confirm for ${email} did not set both session cookies.`);
  }

  return {
    cookie: `hc_at=${accessToken}; hc_rt=${refreshToken}`,
    accessToken,
    refreshToken,
    permissions: res.json<{ user: { permissions: string[] } }>().user.permissions,
  };
}

/**
 * Turn billing on for a tenant.
 *
 * Not part of `seedFixtures`, deliberately. Billing is opt-in: a tenant with no
 * priced services raises no invoices and the check-in gate stays open, which is
 * how every scheduling test written before this module continues to pass
 * unchanged. Calling this is what switches the tenant to pay-first.
 */
/**
 * A second doctor at a tenant, built the way the console builds one.
 *
 * Two doctors are needed to express "somebody else's patient" at all, and the
 * shared fixture seeds exactly one — so every ownership rule in the clinic was
 * previously testable only across TENANTS, where row-level security refuses the
 * request before any of this code runs. A test that passes because of RLS says
 * nothing about whether the ownership check exists.
 *
 * `linked: false` reproduces the account state that a new doctor is in before
 * anybody does their Doctors-and-hours setup: the role, the permissions, and no
 * `practitioner` row. That is not a hypothetical — it is the default, and it is
 * where the fail-open lived.
 *
 * The password hash is copied from the tenant's own seeded doctor rather than
 * recomputed, so this stays in step with `TEST_PASSWORD` by construction.
 */
export async function createDoctor(
  app: NestFastifyApplication,
  tenant: SeededTenant,
  options: { email: string; fullName: string; linked: boolean },
): Promise<{ session: Session; practitionerId: string | null }> {
  const [user] = await ownerQuery<{ id: string }>(
    tenant.id,
    `INSERT INTO app_user (tenant_id, email, full_name, password_hash, updated_at)
     SELECT tenant_id, $2, $3, password_hash, now()
       FROM app_user
      WHERE tenant_id = $1 AND full_name <> '' 
      LIMIT 1
     RETURNING id`,
    [tenant.id, options.email, options.fullName],
  );
  if (!user) throw new Error('Could not create the doctor account.');

  await ownerQuery(
    tenant.id,
    `INSERT INTO user_role (tenant_id, user_id, role_id)
     SELECT $1, $2, id FROM role WHERE tenant_id = $1 AND key = 'doctor'`,
    [tenant.id, user.id],
  );

  let practitionerId: string | null = null;
  if (options.linked) {
    const [row] = await ownerQuery<{ id: string }>(
      tenant.id,
      `INSERT INTO practitioner
         (tenant_id, user_id, full_name, registration_number, specialty, department_id,
          overbook_per_session, updated_at)
       VALUES ($1, $2, $3, $4, 'General Medicine', $5, 0, now())
       RETURNING id`,
      [
        tenant.id,
        user.id,
        options.fullName,
        `TEST-${options.email.slice(0, 8)}`,
        tenant.departmentId,
      ],
    );
    practitionerId = row?.id ?? null;

    // Same hours as the seeded doctor. A practitioner without a schedule has no
    // availability, so nothing can be booked with them — which would make every
    // ownership test here fail on the fixture rather than on the rule.
    for (let day = 0; day <= 6; day++) {
      await ownerQuery(
        tenant.id,
        `INSERT INTO practitioner_schedule
           (tenant_id, practitioner_id, location_id, day_of_week, start_time, end_time,
            slot_minutes, capacity_per_slot, visit_types, valid_from, updated_at)
         VALUES ($1, $2, $3, $4, '09:00', '12:00', 15, 1, '{}',
                 current_date - interval '30 days', now())`,
        [tenant.id, practitionerId, tenant.locationId, day],
      );
    }
  }

  const session = await login(app, tenant.slug, options.email);
  return { session, practitionerId };
}

export async function seedBilling(
  tenantId: string,
  options: { consultationFeePaise?: number; followUpFeePaise?: number } = {},
): Promise<void> {
  const consultation = options.consultationFeePaise ?? 50000;
  const followUp = options.followUpFeePaise ?? 30000;

  await asTenant(tenantId, async (db) => {
    await db.query(
      `INSERT INTO service (tenant_id, code, name, category, price_paise, updated_at)
       VALUES ($1, 'CONS-NEW', 'Consultation', 'CONSULTATION', $2, now()),
              ($1, 'CONS-FOLLOWUP', 'Follow-up', 'CONSULTATION', $3, now()),
              ($1, 'PROC-DRESS', 'Dressing', 'PROCEDURE', 25000, now())
       ON CONFLICT (tenant_id, code) DO UPDATE SET price_paise = EXCLUDED.price_paise`,
      [tenantId, consultation, followUp],
    );

    await db.query(
      `UPDATE practitioner
          SET consultation_fee_paise = $2, follow_up_fee_paise = $3, updated_at = now()
        WHERE tenant_id = $1`,
      [tenantId, consultation, followUp],
    );

    await db.query(
      `INSERT INTO invoice_counter (tenant_id, prefix) VALUES ($1, 'INV')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
  });
}

/** Name → value, decoded, from a set-cookie header. */
export function parseSetCookies(header: string | string[] | undefined): Map<string, string> {
  const list = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const out = new Map<string, string>();

  for (const raw of list) {
    const [pair] = raw.split(';');
    if (!pair) continue;
    const index = pair.indexOf('=');
    if (index < 0) continue;
    out.set(pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1)));
  }

  return out;
}

/** The full attribute string of one cookie, for asserting HttpOnly and friends. */
export function cookieAttributes(
  header: string | string[] | undefined,
  name: string,
): string | undefined {
  const list = header === undefined ? [] : Array.isArray(header) ? header : [header];
  return list.find((raw) => raw.startsWith(`${name}=`));
}

// --- dates ------------------------------------------------------------------

/**
 * A clinic-local date, `days` from today.
 *
 * Tests book into the future rather than "today" so they never race a slot that
 * the seed or an earlier test already used, and so a run at 23:55 IST does not
 * quietly cross midnight into a different clinic day mid-test.
 */
export function clinicDate(days = 7, timeZone = 'Asia/Kolkata'): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Milliseconds remaining in the current 30-second TOTP step. */
function msUntilNextTotpWindow(): number {
  const STEP_MS = 30_000;
  return STEP_MS - (Date.now() % STEP_MS);
}
