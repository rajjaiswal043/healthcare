/**
 * Staff accounts, over HTTP.
 *
 * Two things here are worth more than the rest: a temporary password that
 * genuinely cannot be used for anything except setting a real one, and a seat
 * limit that counts ACTIVE users — which is the only reason deactivate exists as
 * a separate verb from delete.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  closeTestApp,
  createTestApp,
  login,
  loginWithMfa,
  ownerQuery,
  seedFixtures,
  type Fixtures,
  type Session,
} from './harness.js';

let app: NestFastifyApplication;
let fx: Fixtures;
let admin: Session;
let frontDesk: Session;
let finance: Session;
let doctor: Session;
let otherFinance: Session;
let otherAdmin: Session;

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();

  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  finance = await login(app, fx.main.slug, 'finance@main.test');
  doctor = await login(app, fx.main.slug, 'doctor@main.test');
  otherFinance = await login(app, fx.other.slug, 'finance@other.test');
  admin = await loginWithMfa(app, fx.main.slug, 'admin@main.test');
  otherAdmin = await loginWithMfa(app, fx.other.slug, 'admin@other.test');
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  // Everything created by a test, and any limit it set. The seeded five users
  // stay — they are the fixture every other file depends on.
  await ownerQuery(
    fx.main.id,
    `DELETE FROM app_user WHERE tenant_id = $1 AND email LIKE 'made-%'`,
    [fx.main.id],
  );
  await ownerQuery(fx.main.id, `DELETE FROM tenant_seat_limit WHERE tenant_id = $1`, [fx.main.id]);
});

// --- helpers ----------------------------------------------------------------

function listUsers(session: Session = admin) {
  return app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie: session.cookie } });
}

function createUser(body: Record<string, unknown>, session: Session = admin) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: { cookie: session.cookie },
    payload: { email: 'made-one@main.test', fullName: 'Made One', roleKeys: ['nurse'], ...body },
  });
}

function updateUser(id: string, body: Record<string, unknown>, session: Session = admin) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/users/${id}`,
    headers: { cookie: session.cookie },
    payload: body,
  });
}

function setActive(id: string, isActive: boolean, session: Session = admin) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/users/${id}/active`,
    headers: { cookie: session.cookie },
    payload: { isActive },
  });
}

/** A seat limit, written as the owner — the application role cannot set its own. */
function setLimit(roleKey: string, maxUsers: number) {
  return ownerQuery(
    fx.main.id,
    `INSERT INTO tenant_seat_limit (tenant_id, role_key, max_users, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, role_key) DO UPDATE SET max_users = EXCLUDED.max_users`,
    [fx.main.id, roleKey, maxUsers],
  );
}

const domainCode = (res: { json: () => { error: { details?: { code?: string } } } }) =>
  res.json().error.details?.code;

// --- the list ---------------------------------------------------------------

describe('the staff list', () => {
  it('shows who is here, what they hold, and how many seats are left', async () => {
    const res = await listUsers();
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      users: Array<{ email: string; roles: Array<{ key: string }>; isActive: boolean }>;
      seats: Array<{ key: string; used: number; limit: number | null }>;
    }>();

    const doctor = body.users.find((u) => u.email === 'doctor@main.test');
    expect(doctor?.roles.map((r) => r.key)).toEqual(['doctor']);
    expect(doctor?.isActive).toBe(true);

    // No limit configured means unlimited, so a clinic nobody has priced is
    // unaffected by any of this.
    const doctorSeat = body.seats.find((s) => s.key === 'doctor');
    expect(doctorSeat?.limit).toBeNull();
    expect(doctorSeat?.used).toBe(1);
  });

  it('is refused to everyone but an administrator', async () => {
    expect((await listUsers(frontDesk)).statusCode).toBe(403);
  });
});

// --- creating ---------------------------------------------------------------

describe('adding somebody', () => {
  it('returns a temporary password that works exactly once, for one thing', async () => {
    const created = await createUser({ email: 'made-nurse@main.test', fullName: 'Made Nurse' });
    expect(created.statusCode).toBe(201);

    const temporaryPassword = created.json().temporaryPassword as string;
    expect(temporaryPassword).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);

    // It signs in...
    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        tenantSlug: fx.main.slug,
        email: 'made-nurse@main.test',
        password: temporaryPassword,
      },
    });

    expect(signedIn.statusCode).toBe(200);
    // ...and says so immediately. The console gates every screen on this.
    expect(signedIn.json().user.mustChangePassword).toBe(true);

    // And it is not stored anywhere we could read it back.
    const [row] = await ownerQuery<{ password_hash: string }>(
      fx.main.id,
      `SELECT password_hash FROM app_user WHERE email = $1`,
      ['made-nurse@main.test'],
    );
    expect(row?.password_hash).not.toContain(temporaryPassword);
  });

  it('refuses an email already in use, and says which case it is', async () => {
    await createUser({ email: 'made-dup@main.test' });

    const again = await createUser({ email: 'made-dup@main.test' });
    expect(again.statusCode).toBe(409);
    expect(domainCode(again)).toBe('EMAIL_IN_USE');

    // A deactivated holder gets a different message, because the fix is
    // different: reactivate rather than invent a second account.
    const [row] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM app_user WHERE email = $1`,
      ['made-dup@main.test'],
    );
    await setActive(row?.id as string, false);

    const third = await createUser({ email: 'made-dup@main.test' });
    expect(third.json().error.message).toContain('Reactivate it');
  });

  it('refuses a user with no role at all', async () => {
    const res = await createUser({ roleKeys: [] });
    expect(res.statusCode).toBe(400);
  });

  it('is refused to everyone but an administrator', async () => {
    expect((await createUser({}, frontDesk)).statusCode).toBe(403);
  });
});

// --- editing --------------------------------------------------------------

/**
 * Correcting who somebody is.
 *
 * `PATCH /users/:id` has existed since the module was written and had no test
 * of any kind — the staff screen offered no way to reach it, so nothing ever
 * called it. It is now the endpoint behind the Edit button, which makes what it
 * accepts and what it refuses worth stating.
 *
 * The refusals carry as much of this as the successes. The email is the login
 * identifier and is not in the shape at all, so the global
 * `forbidNonWhitelisted` rejects a request carrying one rather than quietly
 * dropping it — "the UI does not show the field" and "the server will not take
 * it" are different guarantees, and only the second one holds.
 */
describe('editing somebody', () => {
  async function madeUser(): Promise<string> {
    const res = await createUser({ email: 'made-edit@main.test', mobile: '9811111111' });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  it('changes the name and the mobile', async () => {
    const id = await madeUser();

    const res = await updateUser(id, { fullName: 'Renamed Properly', mobile: '9822222222' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ fullName: string; mobile: string }>()).toMatchObject({
      fullName: 'Renamed Properly',
      mobile: '9822222222',
    });

    const [row] = await ownerQuery<{ full_name: string; mobile: string | null }>(
      fx.main.id,
      'SELECT full_name, mobile FROM app_user WHERE id = $1',
      [id],
    );
    expect(row).toMatchObject({ full_name: 'Renamed Properly', mobile: '9822222222' });
  });

  it('trims the name rather than storing the spaces', async () => {
    const id = await madeUser();

    await updateUser(id, { fullName: '  Padded Name  ' });

    const [row] = await ownerQuery<{ full_name: string }>(
      fx.main.id,
      'SELECT full_name FROM app_user WHERE id = $1',
      [id],
    );
    expect(row?.full_name).toBe('Padded Name');
  });

  /**
   * The way back to "we do not have a number".
   *
   * An empty string is what a cleared text input sends, and it has to mean
   * removal — otherwise a wrong number can only ever be swapped for another
   * number, never taken off the record.
   */
  it('clears the mobile when it is sent empty', async () => {
    const id = await madeUser();

    const res = await updateUser(id, { mobile: '' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ mobile: string | null }>().mobile).toBeNull();

    const [row] = await ownerQuery<{ mobile: string | null }>(
      fx.main.id,
      'SELECT mobile FROM app_user WHERE id = $1',
      [id],
    );
    expect(row?.mobile).toBeNull();
  });

  it('clears the mobile when it is sent as null', async () => {
    const id = await madeUser();

    expect((await updateUser(id, { mobile: null })).statusCode).toBe(200);

    const [row] = await ownerQuery<{ mobile: string | null }>(
      fx.main.id,
      'SELECT mobile FROM app_user WHERE id = $1',
      [id],
    );
    expect(row?.mobile).toBeNull();
  });

  it('still refuses a mobile that is not a mobile', async () => {
    const id = await madeUser();

    expect((await updateUser(id, { mobile: '12345' })).statusCode).toBe(400);
    expect((await updateUser(id, { mobile: '1234567890' })).statusCode).toBe(400);
  });

  it('refuses a name too short to be one', async () => {
    const id = await madeUser();
    expect((await updateUser(id, { fullName: 'A' })).statusCode).toBe(400);
  });

  /**
   * The login identifier, and the reason this screen shows it read-only. Not a
   * UI courtesy: the field is absent from the shape, so the request is refused
   * outright.
   */
  it('refuses an email, rather than ignoring it', async () => {
    const id = await madeUser();

    const res = await updateUser(id, { email: 'renamed@main.test' });

    expect(res.statusCode).toBe(400);

    const [row] = await ownerQuery<{ email: string }>(
      fx.main.id,
      'SELECT email FROM app_user WHERE id = $1',
      [id],
    );
    expect(row?.email).toBe('made-edit@main.test');
  });

  /**
   * The Edit form sends no `roleKeys`, and this is what that is worth: an edit
   * that omits them must leave what somebody may do exactly as it was. Deciding
   * that is a different screen and a more careful job.
   */
  it('leaves the roles alone when none are sent', async () => {
    const id = await madeUser();

    await updateUser(id, { fullName: 'Still A Nurse' });

    const rows = await ownerQuery<{ key: string }>(
      fx.main.id,
      `SELECT r.key FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [id],
    );
    expect(rows.map((r) => r.key)).toEqual(['nurse']);
  });

  it('is refused to everyone but an administrator', async () => {
    const id = await madeUser();

    for (const session of [frontDesk, doctor, finance]) {
      expect((await updateUser(id, { fullName: 'Not Yours' }, session)).statusCode).toBe(403);
    }
  });

  it('cannot reach a user at another clinic', async () => {
    const id = await madeUser();

    const res = await updateUser(id, { fullName: 'Wrong Clinic' }, otherAdmin);

    expect(res.statusCode).toBe(404);
  });

  it('records the edit in the audit trail', async () => {
    const id = await madeUser();

    await updateUser(id, { fullName: 'Audited Name' });

    const rows = await ownerQuery<{ action: string; resource_id: string }>(
      fx.main.id,
      `SELECT action, resource_id FROM audit_event
        WHERE tenant_id = $1 AND action = 'user.update' AND resource_id = $2`,
      [fx.main.id, id],
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

// --- seat limits ------------------------------------------------------------

describe('seat limits', () => {
  it('refuses once the seats are full, and names the way out', async () => {
    // One nurse is seeded, and the clinic is allowed exactly one.
    await setLimit('nurse', 1);

    const res = await createUser({ email: 'made-second-nurse@main.test' });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('SEAT_LIMIT_REACHED');
    // The refusal a receptionist reads at 9am has to say what to do next.
    expect(res.json().error.message).toContain('Deactivate one');
    expect(res.json().error.message).toContain('doctorsdesk.in');
  });

  it('frees a seat when somebody is deactivated', async () => {
    await setLimit('nurse', 1);

    const [seeded] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM app_user WHERE email = $1`,
      ['nurse@main.test'],
    );

    // Full...
    expect((await createUser({ email: 'made-nurse-2@main.test' })).statusCode).toBe(409);

    // ...deactivate the incumbent, and the seat is available. This is the whole
    // reason deactivate is a distinct verb from delete.
    expect((await setActive(seeded?.id as string, false)).statusCode).toBe(200);
    expect((await createUser({ email: 'made-nurse-2@main.test' })).statusCode).toBe(201);
  });

  it('refuses to reactivate somebody when their seat has been taken', async () => {
    await setLimit('nurse', 1);

    const [seeded] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM app_user WHERE email = $1`,
      ['nurse@main.test'],
    );

    await setActive(seeded?.id as string, false);
    await createUser({ email: 'made-nurse-3@main.test' });

    const back = await setActive(seeded?.id as string, true);
    expect(back.statusCode).toBe(409);
    expect(domainCode(back)).toBe('SEAT_LIMIT_REACHED');
  });

  it('lowering a limit below current usage deactivates nobody', async () => {
    await setLimit('doctor', 0);

    const list = await listUsers();
    const doctor = (list.json().users as Array<{ email: string; isActive: boolean }>).find(
      (u) => u.email === 'doctor@main.test',
    );

    // Still working. A limit blocks the NEXT addition; it never logs a working
    // doctor out because a plan changed.
    expect(doctor?.isActive).toBe(true);

    const seat = (list.json().seats as Array<{ key: string; used: number; limit: number }>).find(
      (s) => s.key === 'doctor',
    );
    expect(seat?.used).toBe(1);
    expect(seat?.limit).toBe(0);
  });
});

// --- deactivating -----------------------------------------------------------

describe('turning an account off', () => {
  it('ends their sessions and refuses their sign-in', async () => {
    const created = await createUser({ email: 'made-out@main.test' });
    const password = created.json().temporaryPassword as string;
    const id = created.json().id as string;

    const theirSession = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { tenantSlug: fx.main.slug, email: 'made-out@main.test', password },
    });
    expect(theirSession.statusCode).toBe(200);

    await setActive(id, false);

    // Deactivating that leaves live sessions running means the user keeps
    // working until their token expires, which is not what anyone means by it.
    const [session] = await ownerQuery<{ revoked_at: Date | null }>(
      fx.main.id,
      `SELECT revoked_at FROM session WHERE user_id = $1 ORDER BY issued_at DESC LIMIT 1`,
      [id],
    );
    expect(session?.revoked_at).not.toBeNull();

    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { tenantSlug: fx.main.slug, email: 'made-out@main.test', password },
    });
    expect(again.statusCode).toBe(401);
  });

  it('will not let an administrator switch themselves off', async () => {
    const [me] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM app_user WHERE email = $1`,
      ['admin@main.test'],
    );

    const res = await setActive(me?.id as string, false);

    expect(res.statusCode).toBe(403);
    expect(domainCode(res)).toBe('CANNOT_DEACTIVATE_SELF');
  });
});

// --- passwords --------------------------------------------------------------

describe('changing a password', () => {
  async function newUserSession() {
    const created = await createUser({ email: 'made-pw@main.test', fullName: 'Made Password' });
    const password = created.json().temporaryPassword as string;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { tenantSlug: fx.main.slug, email: 'made-pw@main.test', password },
    });

    const cookie = (res.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]).join('; ');

    return { id: created.json().id as string, password, cookie };
  }

  it('clears the flag and lets the user get on with it', async () => {
    const { cookie, password } = await newUserSession();

    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie },
      payload: { currentPassword: password, newPassword: 'a-long-enough-password' },
    });

    expect(changed.statusCode).toBe(204);

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.json().mustChangePassword).toBe(false);
  });

  it('needs the current password, session or no session', async () => {
    const { cookie } = await newUserSession();

    // Holding a session proves somebody authenticated once. It does not prove
    // they are still the owner — an unattended desk is the ordinary case here.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie },
      payload: { currentPassword: 'WRONG-WRONG-WRONG', newPassword: 'a-long-enough-password' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('refuses a password shorter than twelve characters', async () => {
    const { cookie, password } = await newUserSession();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie },
      payload: { currentPassword: password, newPassword: 'short' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('resets to a new temporary password and ends the sessions', async () => {
    const { id, cookie } = await newUserSession();

    const reset = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${id}/reset-password`,
      headers: { cookie: admin.cookie },
    });

    expect(reset.statusCode).toBe(201);
    expect(reset.json().temporaryPassword).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);

    // Every session row is revoked, so the session cannot be renewed...
    const rows = await ownerQuery<{ revoked_at: Date | null }>(
      fx.main.id,
      `SELECT revoked_at FROM session WHERE user_id = $1`,
      [id],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);

    const renewed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie },
    });
    expect(renewed.statusCode).toBe(401);

    /**
     * ...but the ACCESS TOKEN they are holding stays valid until it expires.
     *
     * This is the trade recorded in tokens.ts: the token is signed rather than
     * looked up, so the guard costs no database round trip, and the price is
     * that a revocation takes up to ACCESS_TOKEN_TTL_SECONDS (15 minutes) to
     * bite. Asserted rather than wished away — if this ever becomes a
     * session-checking guard, this expectation is what should change first and
     * loudest.
     */
    const stillIn = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(stillIn.statusCode).toBe(200);
  });
});

/**
 * The approver list — `GET /users/approvers`.
 *
 * Built for one reason: applying a promotion requires naming the person who
 * authorised it, and the finance desk had no way to get a list of people to
 * name. The alternative on the table was giving finance `user:manage`, which
 * would have handed a billing desk the power to create accounts and reset
 * passwords in order to fill a dropdown.
 *
 * So the value of this endpoint is entirely in what it does NOT return, and
 * that is what these tests assert. A test that only checked the names came back
 * would pass just as happily if the response also carried every email and
 * lockout state in the clinic.
 */
describe('the approver list', () => {
  function approvers(session: Session) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/users/approvers',
      headers: { cookie: session.cookie },
    });
  }

  it('answers the finance desk, which cannot read the staff list', async () => {
    // Both halves matter. The second is what makes the first worth having.
    expect((await approvers(finance)).statusCode).toBe(200);
    expect((await listUsers(finance)).statusCode).toBe(403);
  });

  it('returns id and full name, and nothing else at all', async () => {
    const body = (await approvers(finance)).json<{
      approvers: Array<Record<string, unknown>>;
    }>();

    expect(body.approvers.length).toBeGreaterThan(0);

    for (const row of body.approvers) {
      // Asserted as an exact key set, not with a handful of `not.toHaveProperty`
      // checks. A field added to the service's `select` later would slip past
      // those and be caught by this.
      expect(Object.keys(row).sort()).toEqual(['fullName', 'id']);
    }
  });

  it('never leaks an email address', async () => {
    // The one field most likely to be added back by accident, and the one that
    // turns a dropdown into a staff directory.
    const payload = (await approvers(finance)).payload;

    expect(payload).not.toContain('@main.test');
    expect(payload).toContain('Front Desk');
  });

  it('leaves out staff who have been switched off', async () => {
    const [nurse] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `UPDATE app_user SET is_active = false WHERE email = 'nurse@main.test' RETURNING id`,
    );

    const names = (await approvers(finance))
      .json<{ approvers: Array<{ fullName: string }> }>()
      .approvers.map((a) => a.fullName);

    // A switched-off account cannot authorise anything — the apply endpoint
    // refuses it — so offering the name would only produce a refusal later.
    expect(names).not.toContain('Nurse');

    await ownerQuery(fx.main.id, `UPDATE app_user SET is_active = true WHERE id = $1`, [nurse!.id]);
  });

  it('shows a clinic only its own staff', async () => {
    const mine = (await approvers(finance)).json<{ approvers: Array<{ fullName: string }> }>();
    const theirs = (await approvers(otherFinance)).json<{
      approvers: Array<{ fullName: string }>;
    }>();

    expect(mine.approvers.map((a) => a.fullName)).toContain('Dr Asha Menon');
    expect(theirs.approvers.map((a) => a.fullName)).toContain('Dr Rohit Bhat');
    expect(theirs.approvers.map((a) => a.fullName)).not.toContain('Dr Asha Menon');
  });

  it('refuses a role without promotion:apply', async () => {
    expect((await approvers(doctor)).statusCode).toBe(403);
  });

  /**
   * Inverted on 22 Sep 2026: the front desk applies discounts from the queue,
   * so it holds promotion:apply and must be able to name an approver. Still two
   * columns and nothing else — the gate moved, the narrow select did not.
   */
  it('answers the front desk, which applies discounts from the queue', async () => {
    const res = await approvers(frontDesk);
    expect(res.statusCode).toBe(200);
    for (const person of res.json().approvers) {
      expect(Object.keys(person).sort()).toEqual(['fullName', 'id']);
    }
  });

  it('answers the administrator, who holds every permission', async () => {
    expect((await approvers(admin)).statusCode).toBe(200);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/users/approvers' });
    expect(res.statusCode).toBe(401);
  });
});
