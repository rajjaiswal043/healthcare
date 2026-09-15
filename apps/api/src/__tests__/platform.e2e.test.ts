/**
 * The platform tier, over HTTP.
 *
 * Three things here matter more than the rest:
 *
 *   - a platform credential is not a clinic credential, and neither works in the
 *     other realm;
 *   - onboarding produces a clinic that WORKS — roles, a location, and an
 *     administrator who can actually sign in;
 *   - a suspended clinic can still read, and cannot write. That is the promise
 *     made to a clinic that falls behind on payment, and it is the one most
 *     easily broken by a route added later.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The MFA escape hatches are cleared for every suite in setup-env.ts, so the
// enrolment assertions below hold whatever a developer has in their .env.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import {
  closeTestApp,
  createTestApp,
  login,
  ownerQuery,
  seedFixtures,
  type Fixtures,
} from './harness.js';

// promisify resolves to the 3-argument overload, so the options-taking form has
// to be typed explicitly — same as apps/api/src/platform/auth/password.ts.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

let app: NestFastifyApplication;
let fx: Fixtures;
let platformCookie: string;

const PLATFORM_EMAIL = 'ops@doctorsdesk.test';
const PLATFORM_PASSWORD = 'platform-password-for-tests';

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();
  platformCookie = await signInAsPlatform();
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  /**
   * Clinics a test onboarded. The two fixture tenants are left alone.
   *
   * Fiddlier than a single DELETE for two reasons worth knowing: `location` is
   * ON DELETE RESTRICT, so the children go first; and every child table is
   * under row-level security, so each delete has to run in ITS OWN tenant's
   * context rather than the fixture's. `tenant` itself is not tenant-scoped,
   * which is why the last line works from anywhere.
   */
  const made = await ownerQuery<{ id: string }>(
    fx.main.id,
    `SELECT id FROM tenant WHERE slug LIKE 'made-%'`,
  );

  for (const t of made) {
    for (const table of ['user_role', 'app_user', 'tenant_seat_limit', 'role', 'location']) {
      await ownerQuery(t.id, `DELETE FROM ${table} WHERE tenant_id = $1`, [t.id]);
    }
  }

  await ownerQuery(fx.main.id, `DELETE FROM tenant WHERE slug LIKE 'made-%'`, []);
  await ownerQuery(
    fx.main.id,
    `UPDATE tenant SET status = 'ACTIVE', suspended_at = NULL, suspended_reason = NULL WHERE id = $1`,
    [fx.main.id],
  );
});

// --- helpers ----------------------------------------------------------------

async function hashPassword(plain: string): Promise<string> {
  const N = 65536;
  const salt = randomBytes(16);
  const derived = await scrypt(plain.normalize('NFKC'), salt, 64, {
    N,
    r: 8,
    p: 1,
    maxmem: 128 * N * 8 * 2,
  });
  return ['scrypt', N, 8, 1, salt.toString('base64'), derived.toString('base64')].join('$');
}

/** Create a platform account, then walk the mandatory MFA enrolment. */
async function signInAsPlatform(): Promise<string> {
  await ownerQuery(
    fx.main.id,
    `INSERT INTO platform_user (email, full_name, password_hash, updated_at)
     VALUES ($1, 'Platform Ops', $2, now())
     ON CONFLICT (lower(email)) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, mfa_secret = NULL, mfa_enabled_at = NULL`,
    [PLATFORM_EMAIL, await hashPassword(PLATFORM_PASSWORD)],
  );

  const challenge = await app.inject({
    method: 'POST',
    url: '/api/v1/platform/auth/login',
    payload: { email: PLATFORM_EMAIL, password: PLATFORM_PASSWORD },
  });

  const secret = challenge.json().enrolmentSecret as string;
  expect(secret).toBeTruthy();

  const { generate } = await import('otplib');

  const confirmed = await app.inject({
    method: 'POST',
    url: '/api/v1/platform/auth/mfa/confirm',
    payload: {
      email: PLATFORM_EMAIL,
      password: PLATFORM_PASSWORD,
      totpCode: await generate({ secret }),
    },
  });

  expect(confirmed.statusCode).toBe(200);

  return (confirmed.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]).join('; ');
}

function onboard(body: Record<string, unknown> = {}, cookie = platformCookie) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/platform/clinics',
    headers: { cookie },
    payload: {
      name: 'Made Clinic',
      slug: 'made-clinic',
      admin: { email: 'owner@made.test', fullName: 'Made Owner' },
      ...body,
    },
  });
}

const domainCode = (res: { json: () => { error: { details?: { code?: string } } } }) =>
  res.json().error.details?.code;

// --- the two realms ---------------------------------------------------------

describe('platform credentials are not clinic credentials', () => {
  it('refuses a clinic session on a platform route', async () => {
    const clinicAdmin = await login(app, fx.main.slug, 'frontdesk@main.test');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/clinics',
      headers: { cookie: clinicAdmin.cookie },
    });

    // A clinic token carries no realm, so the platform verifier rejects its
    // shape. Not a permission check that somebody has to remember to write.
    expect(res.statusCode).toBe(401);
  });

  it('refuses a platform session on a clinic route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/patients?q=any',
      headers: { cookie: platformCookie },
    });

    // And the reverse: a platform token has no tenant, so the clinic guard has
    // nothing to scope a query to and refuses. This is the line in docs/06
    // section 2.2 — the platform cannot read a clinic's data.
    expect(res.statusCode).toBe(401);
  });

  it('requires MFA before a platform account can do anything', async () => {
    await ownerQuery(
      fx.main.id,
      `INSERT INTO platform_user (email, full_name, password_hash, updated_at)
       VALUES ('fresh@doctorsdesk.test', 'Fresh', $1, now())
       ON CONFLICT (lower(email)) DO UPDATE
         SET mfa_secret = NULL, mfa_enabled_at = NULL, password_hash = EXCLUDED.password_hash`,
      [await hashPassword(PLATFORM_PASSWORD)],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/auth/login',
      payload: { email: 'fresh@doctorsdesk.test', password: PLATFORM_PASSWORD },
    });

    // A correct password alone gets an enrolment challenge and no session.
    expect(res.statusCode).toBe(200);
    expect(res.json().mfaRequired).toBe(true);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses the platform console without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/platform/clinics' });
    expect(res.statusCode).toBe(401);
  });
});

// --- onboarding -------------------------------------------------------------

describe('onboarding a clinic', () => {
  it('produces a clinic that can be signed into and used', async () => {
    const res = await onboard({
      name: 'Made Clinic',
      slug: 'made-clinic',
      uhidPrefix: 'MDC',
      seatLimits: { doctor: 2, nurse: 1 },
      admin: { email: 'owner@made.test', fullName: 'Made Owner' },
    });

    expect(res.statusCode).toBe(201);
    const temporaryPassword = res.json().admin.temporaryPassword as string;

    /**
     * The administrator signs in immediately — an onboarding that leaves a
     * clinic nobody can enter has not finished.
     *
     * They meet MFA enrolment on the way in, because the administrator role
     * requires it and onboarding seeds roles straight from SYSTEM_ROLES.
     * The suite forces MFA_ENABLED on in setup-env.ts, so a
     * clinic created through the platform is MFA-required from its first
     * second whatever a developer has set locally.
     */
    const challenge = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        tenantSlug: 'made-clinic',
        email: 'owner@made.test',
        password: temporaryPassword,
      },
    });

    expect(challenge.statusCode).toBe(200);
    expect(challenge.json().mfaRequired).toBe(true);
    expect(challenge.json().enrolmentSecret).toBeTruthy();

    const { generate } = await import('otplib');

    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/confirm',
      payload: {
        tenantSlug: 'made-clinic',
        email: 'owner@made.test',
        password: temporaryPassword,
        totpCode: await generate({ secret: challenge.json().enrolmentSecret as string }),
      },
    });

    expect(signedIn.statusCode).toBe(200);
    // Still holding a password somebody else chose, so still gated.
    expect(signedIn.json().user.mustChangePassword).toBe(true);

    const cookie = (signedIn.headers['set-cookie'] as string[])
      .map((c) => c.split(';')[0])
      .join('; ');

    // Roles were seeded, so the administrator actually holds permissions.
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.json().roles.map((r: { key: string }) => r.key)).toEqual(['administrator']);
    expect(me.json().permissions).toContain('user:manage');

    // A location exists, so the clinic can book its first appointment without
    // visiting a settings screen first.
    const locations = await app.inject({
      method: 'GET',
      url: '/api/v1/locations',
      headers: { cookie },
    });
    expect(locations.json().locations).toHaveLength(1);

    // And the seat limits from the deal are already in force.
    const staff = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { cookie },
    });
    const seats = staff.json().seats as Array<{ key: string; limit: number | null }>;
    expect(seats.find((s) => s.key === 'doctor')?.limit).toBe(2);
    expect(seats.find((s) => s.key === 'nurse')?.limit).toBe(1);
    // A role left out of the deal stays unlimited rather than becoming zero.
    expect(seats.find((s) => s.key === 'front_desk')?.limit).toBeNull();
  });

  it('refuses a slug another clinic already signs in with', async () => {
    await onboard({ slug: 'made-twice' });
    const again = await onboard({
      slug: 'made-twice',
      admin: { email: 'second@made.test', fullName: 'Second Owner' },
    });

    expect(again.statusCode).toBe(409);
    expect(domainCode(again)).toBe('SLUG_IN_USE');
  });

  it('stores the patient ID format it was asked for', async () => {
    const res = await onboard({ slug: 'made-format', uhidPrefix: 'drviv-', uhidPadding: 4 });

    expect(res.statusCode).toBe(201);
    // Uppercased on the way in — the database stores it that way regardless,
    // so refusing lowercase would reject what the clinic ends up with anyway.
    expect(res.json().clinic).toMatchObject({ uhidPrefix: 'DRVIV-', uhidPadding: 4 });

    const [row] = await ownerQuery<{ uhid_prefix: string; uhid_padding: number }>(
      fx.main.id,
      `SELECT uhid_prefix, uhid_padding FROM tenant WHERE slug = 'made-format'`,
    );
    expect(row).toEqual({ uhid_prefix: 'DRVIV-', uhid_padding: 4 });
  });

  it('gives three letters of the name and five digits when nobody chooses', async () => {
    const res = await onboard({ slug: 'made-default', name: 'Dr. Vivek Clinic' });

    expect(res.statusCode).toBe(201);
    expect(res.json().clinic).toMatchObject({ uhidPrefix: 'DRV', uhidPadding: 5 });
  });

  it('treats a blank prefix as not chosen, rather than as a mistake', async () => {
    const res = await onboard({ slug: 'made-blank', uhidPrefix: '   ' });

    expect(res.statusCode).toBe(201);
    expect(res.json().clinic.uhidPrefix).toBe('MAD');
  });

  it.each([
    ['DRV1', 'cannot end in a digit'],
    ['1AB', 'must start with a letter'],
    ['DR V', 'only letters, digits, - and /'],
    ['DR%', 'only letters, digits, - and /'],
    ['DRVIVEK-X', 'at most 8 characters'],
  ])('refuses the prefix %j with a sentence saying it %s', async (uhidPrefix, sentence) => {
    const res = await onboard({ slug: 'made-badprefix', uhidPrefix });

    /**
     * A 400 that names the rule, not the CHECK constraint turning up as a 500.
     * The database would refuse every one of these too — this is about the
     * person onboarding learning WHAT to fix.
     */
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain(sentence);

    const made = await ownerQuery(
      fx.main.id,
      `SELECT id FROM tenant WHERE slug = 'made-badprefix'`,
    );
    expect(made).toHaveLength(0);
  });

  it.each([2, 9, 4.5])('refuses a width of %j', async (uhidPadding) => {
    const res = await onboard({ slug: 'made-badwidth', uhidPadding });

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('from 3 to 8');
  });

  it('saves a seat limit for finance, like any other role', async () => {
    const res = await onboard({ slug: 'made-finance-seats', seatLimits: { finance: 1 } });

    expect(res.statusCode).toBe(201);

    const [tenant] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM tenant WHERE slug = 'made-finance-seats'`,
    );

    // Read in the new clinic's own context: tenant_seat_limit is under
    // row-level security, so the fixture's context would see nothing at all.
    const limits = await ownerQuery<{ role_key: string; max_users: number }>(
      tenant!.id,
      'SELECT role_key, max_users FROM tenant_seat_limit WHERE tenant_id = $1',
      [tenant!.id],
    );

    /**
     * The backend never needed changing for this — seat limits are keyed by
     * role, and finance is a role every clinic has. What was missing was the
     * field on the onboarding form, so no clinic was ever onboarded with one.
     */
    expect(limits).toEqual([{ role_key: 'finance', max_users: 1 }]);
  });

  it('refuses a slug that would not work in a sign-in box', async () => {
    const res = await onboard({ slug: 'Made Clinic!' });
    expect(res.statusCode).toBe(400);
  });

  it('lists clinics with counts, and no patient names', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/clinics',
      headers: { cookie: platformCookie },
    });

    expect(res.statusCode).toBe(200);

    const clinics = res.json().clinics as Array<{ slug: string; patients: number }>;
    const main = clinics.find((c) => c.slug === fx.main.slug);

    expect(main?.patients).toBeGreaterThan(0);

    // Counts, not contents. The platform may know a clinic has patients; it may
    // not know who they are.
    const [patient] = await ownerQuery<{ name: string }>(
      fx.main.id,
      `SELECT name FROM patient LIMIT 1`,
    );
    expect(JSON.stringify(res.json())).not.toContain(patient?.name);
  });
});

// --- suspension -------------------------------------------------------------

describe('a suspended clinic', () => {
  async function suspend(reason = 'Unpaid since July') {
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/platform/clinics/${fx.main.id}/suspend`,
      headers: { cookie: platformCookie },
      payload: { reason },
    });
  }

  it('can still sign in and read', async () => {
    await suspend();

    // Sign-in still works — auth_lookup_user admits SUSPENDED. Before this
    // phase it refused anything that was not ACTIVE, which meant the clinic
    // went dark.
    const session = await login(app, fx.main.slug, 'frontdesk@main.test');

    const patients = await app.inject({
      method: 'GET',
      url: '/api/v1/patients?q=a',
      headers: { cookie: session.cookie },
    });

    expect(patients.statusCode).toBe(200);
  });

  it('cannot write, and is told why and what to do', async () => {
    await suspend('Unpaid since July');
    const session = await login(app, fx.main.slug, 'frontdesk@main.test');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/patients',
      headers: { cookie: session.cookie },
      payload: {
        name: 'Should Not Exist',
        gender: 'MALE',
        ageYears: 30,
        mobile: '9876500999',
        consentCareDelivery: true,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(domainCode(res)).toBe('CLINIC_SUSPENDED');
    // The message has to be actionable by whoever hits it, who is a receptionist
    // and not the person who owes the money.
    expect(res.json().error.message).toContain('print and export');
    expect(res.json().error.message).toContain('doctorsdesk.in');
  });

  it('still lets somebody change their own password', async () => {
    await suspend();
    const session = await login(app, fx.main.slug, 'frontdesk@main.test');

    // Locking a user out of a password change during a billing dispute has no
    // upside for anyone.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie: session.cookie },
      payload: { currentPassword: 'WRONG-ON-PURPOSE', newPassword: 'a-long-enough-password' },
    });

    // 401 for the wrong current password — NOT 403 for the suspension. The
    // request reached the handler, which is the point being asserted.
    expect(res.statusCode).toBe(401);
  });

  it('comes back exactly as it was', async () => {
    await suspend();

    const back = await app.inject({
      method: 'PATCH',
      url: `/api/v1/platform/clinics/${fx.main.id}/reactivate`,
      headers: { cookie: platformCookie },
    });

    expect(back.statusCode).toBe(200);
    expect(back.json().status).toBe('ACTIVE');

    const session = await login(app, fx.main.slug, 'frontdesk@main.test');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/patients',
      headers: { cookie: session.cookie },
      payload: {
        name: 'Back In Business',
        gender: 'FEMALE',
        ageYears: 41,
        mobile: '9876500998',
        consentCareDelivery: true,
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it('refuses a suspension with no reason', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/platform/clinics/${fx.main.id}/suspend`,
      headers: { cookie: platformCookie },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

// --- seat limits after the fact ---------------------------------------------

describe('changing what a clinic is allowed', () => {
  it('raises a limit without a re-seed or a restart', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/platform/clinics/${fx.main.id}/seat-limits`,
      headers: { cookie: platformCookie },
      payload: { seatLimits: { doctor: 7 } },
    });

    expect(res.statusCode).toBe(200);

    const [row] = await ownerQuery<{ max_users: number }>(
      fx.main.id,
      `SELECT max_users FROM tenant_seat_limit WHERE tenant_id = $1 AND role_key = 'doctor'`,
      [fx.main.id],
    );
    expect(row?.max_users).toBe(7);

    await ownerQuery(fx.main.id, `DELETE FROM tenant_seat_limit WHERE tenant_id = $1`, [
      fx.main.id,
    ]);
  });
});

/**
 * The platform sets a clinic's logo so their FIRST sign-in already looks like
 * theirs — before anybody at the clinic has an account to fix it with.
 *
 * The interesting assertion is the last one: this write must not appear in the
 * clinic's audit trail as though one of their own staff did it.
 */
describe('changing a clinic’s patient ID format', () => {
  function change(body: Record<string, unknown> = {}, cookie = platformCookie) {
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/platform/clinics/${fx.main.id}/uhid-format`,
      headers: { cookie },
      payload: {
        uhidPrefix: 'DRVIV-',
        uhidPadding: 4,
        reason: 'Dr Vivek asked on the phone',
        ...body,
      },
    });
  }

  async function issued(): Promise<number> {
    const [row] = await ownerQuery<{ n: number }>(
      fx.main.id,
      'SELECT uhid_counter::int AS n FROM tenant WHERE id = $1',
      [fx.main.id],
    );
    return row!.n;
  }

  afterEach(async () => {
    // Back to the fixture format, and the record of having changed it gone, so
    // no later file inherits a clinic numbered differently from its fixtures.
    await ownerQuery(
      fx.main.id,
      `UPDATE tenant SET uhid_prefix = 'T', uhid_padding = 6 WHERE id = $1`,
      [fx.main.id],
    );
    await ownerQuery(
      fx.main.id,
      `DELETE FROM audit_event WHERE action = 'tenant.uhid_format_change'`,
    );
  });

  it('shows each clinic’s format and how many IDs it has issued', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/clinics',
      headers: { cookie: platformCookie },
    });

    const main = (res.json().clinics as Array<Record<string, unknown>>).find(
      (c) => c.slug === fx.main.slug,
    );
    expect(main).toMatchObject({ uhidPrefix: 'T', uhidPadding: 6, uhidIssued: await issued() });
  });

  it('changes the format for new patients and carries the numbering on', async () => {
    const before = await issued();

    const res = await change();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      uhidPrefix: 'DRVIV-',
      uhidPadding: 4,
      uhidIssued: before,
      nextUhid: `DRVIV-${String(before + 1).padStart(4, '0')}`,
    });

    // Not restarted — restarting would issue a second patient whose ID differs
    // from an existing one only by prefix.
    expect(await issued()).toBe(before);

    // And the patient already holding a card keeps it.
    const [kept] = await ownerQuery<{ n: number }>(
      fx.main.id,
      `SELECT count(*)::int AS n FROM patient WHERE uhid = 'T000001'`,
    );
    expect(kept?.n).toBe(1);
  });

  it('records who changed it, why, and from what to what', async () => {
    expect((await change()).statusCode).toBe(200);

    const [row] = await ownerQuery<{
      actor_label: string;
      actor_user_id: string | null;
      reason: string;
      changed_fields: string[];
    }>(
      fx.main.id,
      `SELECT actor_label, actor_user_id, reason, changed_fields
         FROM audit_event WHERE action = 'tenant.uhid_format_change'`,
    );

    // Decision D9: the clinic's own audit trail, no new table.
    expect(row?.actor_label).toBe(`platform: ${PLATFORM_EMAIL}`);
    // A platform user is not a clinic user, so there is no id to claim here.
    expect(row?.actor_user_id).toBeNull();
    expect(row?.changed_fields).toEqual(['uhidPrefix', 'uhidPadding']);
    expect(row?.reason).toContain('Dr Vivek asked on the phone');
    expect(row?.reason).toContain('was T · 6 digits (T000001)');
    expect(row?.reason).toContain('now DRVIV- · 4 digits (DRVIV-0001)');
  });

  it('refuses a prefix that could re-issue an ID, and changes nothing', async () => {
    const res = await change({ uhidPrefix: 'DRV1' });

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('cannot end in a digit');

    const [row] = await ownerQuery<{ uhid_prefix: string }>(
      fx.main.id,
      'SELECT uhid_prefix FROM tenant WHERE id = $1',
      [fx.main.id],
    );
    expect(row?.uhid_prefix).toBe('T');
  });

  it('refuses a change that changes nothing, rather than recording one', async () => {
    const res = await change({ uhidPrefix: 't', uhidPadding: 6 });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('FORMAT_UNCHANGED');

    const rows = await ownerQuery(
      fx.main.id,
      `SELECT id FROM audit_event WHERE action = 'tenant.uhid_format_change'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('requires a reason, and both halves of the format', async () => {
    expect((await change({ reason: '' })).statusCode).toBe(400);

    const noPrefix = await change({ uhidPrefix: undefined });
    expect(noPrefix.statusCode).toBe(400);
    expect(JSON.stringify(noPrefix.json())).toContain('Give the patient IDs a prefix');

    const noWidth = await change({ uhidPadding: undefined });
    expect(noWidth.statusCode).toBe(400);
    expect(JSON.stringify(noWidth.json())).toContain('Choose how many digits');

    /**
     * Why this test exists. A missing prefix once got past validation — an
     * `@IsDefined` stacked on optional decorators is never reached — and
     * arrived at the database as NULL, surfacing as a 500 from a NOT NULL
     * constraint instead of a sentence. And nothing was changed along the way.
     */
    const [row] = await ownerQuery<{ uhid_prefix: string; uhid_padding: number }>(
      fx.main.id,
      'SELECT uhid_prefix, uhid_padding FROM tenant WHERE id = $1',
      [fx.main.id],
    );
    expect(row).toEqual({ uhid_prefix: 'T', uhid_padding: 6 });
  });

  it('cannot be done from inside a clinic', async () => {
    /**
     * Decision D3: platform only. The route sits behind PlatformGuard, and a
     * clinic session is a different realm with a different cookie — so a
     * signed-in clinic user reaches it no further than somebody with no
     * session at all. Nothing is changed either way.
     */
    const clinic = await login(app, fx.main.slug, 'frontdesk@main.test');

    expect((await change({}, clinic.cookie)).statusCode).toBe(401);
    expect((await change({}, '')).statusCode).toBe(401);
    expect(await issued()).toBeGreaterThan(0);

    const [row] = await ownerQuery<{ uhid_prefix: string }>(
      fx.main.id,
      'SELECT uhid_prefix FROM tenant WHERE id = $1',
      [fx.main.id],
    );
    expect(row?.uhid_prefix).toBe('T');
  });
});

describe('platform sets a clinic logo', () => {
  async function png(size = 120): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    return sharp({
      create: { width: size, height: size, channels: 3, background: { r: 20, g: 90, b: 160 } },
    })
      .png()
      .toBuffer();
  }

  it('lands on the clinic and is served publicly', async () => {
    const created = await onboard({ slug: 'logo-clinic', name: 'Logo Clinic' });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ clinic: { id: string } }>().clinic.id;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/platform/clinics/${id}/logo`,
      headers: { cookie: platformCookie },
      payload: { logo: (await png()).toString('base64') },
    });
    expect(res.statusCode).toBe(200);

    const publicLogo = await app.inject({
      method: 'GET',
      url: '/api/v1/branding/logo-clinic/logo',
    });
    expect(publicLogo.statusCode).toBe(200);
    expect(publicLogo.headers['content-type']).toBe('image/png');
  });

  it('refuses a clinic session', async () => {
    const created = await onboard({ slug: 'no-touch-clinic', name: 'No Touch' });
    const id = created.json<{ clinic: { id: string } }>().clinic.id;
    const clinicAdmin = await login(app, fx.main.slug, 'frontdesk@main.test');

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/platform/clinics/${id}/logo`,
      headers: { cookie: clinicAdmin.cookie },
      payload: { logo: (await png()).toString('base64') },
    });

    expect(res.statusCode).toBe(401);
  });

  it('does not attribute the change to a member of the clinic staff', async () => {
    const created = await onboard({ slug: 'attribution-clinic', name: 'Attribution' });
    const id = created.json<{ clinic: { id: string } }>().clinic.id;

    await app.inject({
      method: 'PUT',
      url: `/api/v1/platform/clinics/${id}/logo`,
      headers: { cookie: platformCookie },
      payload: { logo: (await png()).toString('base64') },
    });

    const rows = await ownerQuery<{ actor_user_id: string | null }>(
      id,
      `SELECT actor_user_id FROM audit_event WHERE tenant_id = $1 AND action = 'branding.logo.set'`,
      [id],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_user_id).toBeNull();
  });
});
