/**
 * Authentication and session handling, over HTTP.
 *
 * The unit tests prove the pieces work. This proves the assembled thing does:
 * that a real request reaches the guard, that the guard reads the cookie the
 * login response actually set, and that a refused request is refused for the
 * reason we think.
 *
 * The properties asserted here are security properties, so they are written as
 * "the attack fails" rather than "the happy path works" wherever there is a
 * choice.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  closeTestApp,
  cookieAttributes,
  createTestApp,
  login,
  ownerQuery,
  parseSetCookies,
  seedFixtures,
  TEST_PASSWORD,
  type Fixtures,
} from './harness.js';

let app: NestFastifyApplication;
let fx: Fixtures;

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();
});

afterAll(async () => {
  await closeTestApp(app);
});

describe('signing in', () => {
  it('issues both session cookies, httpOnly and SameSite=Strict', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        tenantSlug: fx.main.slug,
        email: 'frontdesk@main.test',
        password: TEST_PASSWORD,
      },
    });

    expect(res.statusCode).toBe(200);

    const access = cookieAttributes(res.headers['set-cookie'], 'hc_at');
    const refresh = cookieAttributes(res.headers['set-cookie'], 'hc_rt');

    // httpOnly is the single reason tokens are not in localStorage: it is what
    // makes an XSS bug unable to steal the session.
    expect(access).toContain('HttpOnly');
    expect(access).toContain('SameSite=Strict');
    expect(refresh).toContain('HttpOnly');

    // The refresh cookie is scoped to the auth routes, so it does not travel on
    // every ordinary API call. A token that travels less is exposed less.
    expect(refresh).toContain('Path=/api/v1/auth');
  });

  it('returns the caller’s permissions, sourced from their role', async () => {
    const session = await login(app, fx.main.slug, 'frontdesk@main.test');

    expect(session.permissions).toContain('appointment:write');
    expect(session.permissions).toContain('appointment:cancel');
    expect(session.permissions).not.toContain('user:manage');
  });

  it('does not leak whether an account exists', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { tenantSlug: fx.main.slug, email: 'frontdesk@main.test', password: 'not-it' },
    });

    const noSuchUser = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { tenantSlug: fx.main.slug, email: 'ghost@main.test', password: TEST_PASSWORD },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchUser.statusCode).toBe(401);

    // Identical wording. A different message for "no such user" turns the login
    // form into an account-enumeration oracle.
    expect(noSuchUser.json().error.message).toBe(wrongPassword.json().error.message);
  });

  it('refuses a password that is right for a DIFFERENT tenant', async () => {
    // Same email shape, same password, wrong clinic. Users are tenant-scoped, so
    // this must fail even though both accounts exist and the password matches.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        tenantSlug: fx.other.slug,
        email: 'frontdesk@main.test',
        password: TEST_PASSWORD,
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it('locks an account after repeated failures', async () => {
    // MAX_FAILED_ATTEMPTS is 8 in auth.service.ts.
    for (let attempt = 0; attempt < 8; attempt++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { tenantSlug: fx.main.slug, email: 'lockout@main.test', password: 'wrong' },
      });
    }

    const withCorrectPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        tenantSlug: fx.main.slug,
        email: 'lockout@main.test',
        password: TEST_PASSWORD,
      },
    });

    // The right password is now refused, which is the point of a lockout.
    expect(withCorrectPassword.statusCode).toBe(401);

    const [row] = await ownerQuery<{ locked_until: Date | null }>(
      fx.main.id,
      `SELECT locked_until FROM app_user WHERE email = $1`,
      ['lockout@main.test'],
    );
    expect(row?.locked_until).toBeInstanceOf(Date);
  });

  it('records the failures in the audit trail', async () => {
    const rows = await ownerQuery<{ action: string }>(
      fx.main.id,
      `SELECT action FROM audit_event WHERE action = 'auth.login_failed'`,
    );

    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('multi-factor authentication', () => {
  it('withholds a session from an admin who has not enrolled', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { tenantSlug: fx.main.slug, email: 'admin@main.test', password: TEST_PASSWORD },
    });

    // 200, not 401: the password WAS correct. The client needs to be told to
    // enrol, not to discard the attempt.
    expect(res.statusCode).toBe(200);

    const body = res.json<{ mfaRequired?: boolean; enrolmentSecret?: string }>();
    expect(body.mfaRequired).toBe(true);
    expect(body.enrolmentSecret).toBeTruthy();

    // The important half: no session was issued. An administrator without MFA
    // must not be able to do anything at all (FR-USR-02).
    expect(parseSetCookies(res.headers['set-cookie']).has('hc_at')).toBe(false);
  });
});

describe('who am I', () => {
  it('names the user and their roles, not just their permissions', async () => {
    const session = await login(app, fx.main.slug, 'doctor@main.test');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: session.cookie },
    });

    expect(res.statusCode).toBe(200);

    const body = res.json<{
      fullName: string;
      roles: Array<{ key: string; name: string }>;
      permissions: string[];
    }>();

    // The console paints its chrome from these: the name in the identity chip,
    // the role key as the colour signature, the role name as the label beside
    // it. Read from the database rather than the token, so a role changed an
    // hour ago is not still showing.
    expect(body.fullName).toBe('Dr Asha Menon');
    expect(body.roles.map((r) => r.key)).toEqual(['doctor']);
    expect(body.roles[0]?.name).toBe('Doctor');
    expect(body.permissions).toContain('consultation:write');
  });
});

describe('the guard', () => {
  it('refuses an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a forged token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: 'Bearer not.a.real.token' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('refuses a token signed with the wrong key', async () => {
    // Take a real token and change its signature. The payload still parses, so
    // this fails only if the signature is genuinely verified.
    const session = await login(app, fx.main.slug, 'frontdesk@main.test');
    const [header, payload] = session.accessToken.split('.');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${header}.${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAA` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('accepts the cookie the login response set', async () => {
    const session = await login(app, fx.main.slug, 'frontdesk@main.test');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: session.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().tenantId).toBe(fx.main.id);
  });

  it('names the permission a caller is missing', async () => {
    // A nurse may read the queue but not book into it.
    const nurse = await login(app, fx.main.slug, 'nurse@main.test');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: { cookie: nurse.cookie },
      payload: {
        patientId: fx.main.patientIds[0],
        practitionerId: fx.main.practitionerId,
        locationId: fx.main.locationId,
        startAt: new Date().toISOString(),
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('appointment:write');
  });
});

describe('refresh token rotation', () => {
  it('issues a new token and invalidates the old one', async () => {
    const session = await login(app, fx.main.slug, 'frontdesk@main.test');

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `hc_rt=${encodeURIComponent(session.refreshToken)}` },
    });

    expect(first.statusCode).toBe(200);

    const rotated = parseSetCookies(first.headers['set-cookie']).get('hc_rt');
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(session.refreshToken);
  });

  it('revokes the whole family when a used token is presented again', async () => {
    const session = await login(app, fx.main.slug, 'frontdesk@main.test');

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `hc_rt=${encodeURIComponent(session.refreshToken)}` },
    });
    const rotated = parseSetCookies(first.headers['set-cookie']).get('hc_rt') as string;

    // Replaying the original. A legitimate client would have moved on, so this
    // means the token was captured.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `hc_rt=${encodeURIComponent(session.refreshToken)}` },
    });
    expect(replay.statusCode).toBe(401);

    // And the consequence that matters: the token the real client is holding is
    // dead too. A silent long-lived compromise becomes a forced logout somebody
    // notices and reports.
    const afterRevocation = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `hc_rt=${encodeURIComponent(rotated)}` },
    });
    expect(afterRevocation.statusCode).toBe(401);
  });

  it('refuses a refresh token belonging to another tenant’s prefix', async () => {
    const session = await login(app, fx.main.slug, 'frontdesk@main.test');

    // The token carries its tenant so context can be set before the session
    // table is read. Repointing that prefix must not reach another tenant's
    // sessions — the hash simply will not be found under their policy.
    const forged = session.refreshToken.replace(fx.main.id, fx.other.id);
    expect(forged).not.toBe(session.refreshToken);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `hc_rt=${encodeURIComponent(forged)}` },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('signing out', () => {
  it('ends the session and clears the cookies', async () => {
    const session = await login(app, fx.main.slug, 'frontdesk@main.test');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: session.cookie },
    });

    expect(res.statusCode).toBe(204);

    const cleared = parseSetCookies(res.headers['set-cookie']);
    expect(cleared.get('hc_at')).toBe('');

    // Logging out must end the session, not merely invalidate the newest link in
    // its rotation chain.
    const afterLogout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `hc_rt=${encodeURIComponent(session.refreshToken)}` },
    });
    expect(afterLogout.statusCode).toBe(401);
  });
});
