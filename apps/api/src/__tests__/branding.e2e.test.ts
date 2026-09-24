/**
 * White-label branding, over HTTP.
 *
 * Two things in this file are the point; the rest is ordinary access control.
 *
 * **An unknown slug must answer in the same shape as a known one** — 200 with
 * neutral branding, never a 404. These are the only unauthenticated reads in the
 * API. This is a weaker property than it first looks: a caller reading the body
 * still sees a real clinic's actual name, and nothing can hide that while the
 * point of the endpoint is to show it. What the uniform shape buys is a
 * sign-in page with no error path and a status-code scraper that learns
 * nothing; the rate limit is what makes bulk probing expensive.
 *
 * **An SVG must never reach storage.** The logo is served from our own origin to
 * a page nobody has authenticated on. An SVG is a document that can carry
 * script; storing one would be stored XSS with a clinic's own login screen as
 * the delivery vehicle.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import sharp from 'sharp';
import {
  TEST_PASSWORD,
  closeTestApp,
  createTestApp,
  login,
  loginWithMfa,
  ownerQuery,
  seedFixtures,
  type Fixtures,
  type Session,
} from './harness.js';
import { HttpException } from '@nestjs/common';
import { PublicRateLimitGuard } from '../common/public-rate-limit.guard.js';

let app: NestFastifyApplication;
let fx: Fixtures;
let admin: Session;
let otherAdmin: Session;
let frontDesk: Session;

/** A real image, built here so the test does not carry a binary fixture. */
async function png(width = 200, height = 120): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 10, g: 120, b: 110, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

async function jpeg(width = 200, height = 120): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 60, b: 40 } },
  })
    .jpeg()
    .toBuffer();
}

async function putLogo(session: Session, bytes: Buffer) {
  return app.inject({
    method: 'PUT',
    url: '/api/v1/branding/logo',
    headers: { cookie: session.cookie },
    payload: { logo: bytes.toString('base64') },
  });
}

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();

  admin = await loginWithMfa(app, fx.main.slug, 'admin@main.test');
  otherAdmin = await loginWithMfa(app, fx.other.slug, 'admin@other.test');
  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  // tenantId is required by the helper but does nothing here: `tenant` is the
  // tenancy root and carries no row-level security, so this clears both.
  await ownerQuery(
    fx.main.id,
    `UPDATE tenant SET logo_bytes = NULL, logo_mime_type = NULL, logo_updated_at = NULL`,
  );

  // Audit rows accumulate across tests in this file, so the one test that
  // counts them needs a clean slate rather than a tolerance.
  await ownerQuery(fx.main.id, `DELETE FROM audit_event WHERE action LIKE 'branding.%'`);

  // The rename tests mutate the display name. Restored here so no assertion
  // anywhere in this file depends on which test ran before it.
  await ownerQuery(fx.main.id, `UPDATE tenant SET name = legal_name`);
});

describe('public branding lookup', () => {
  it('returns the clinic name for a slug that exists', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/branding/${fx.main.slug}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ logoVersion: null });
    expect(res.json<{ name: string }>().name).toBeTruthy();
  });

  /**
   * The uniform-shape property. If this ever becomes a 404, every caller grows
   * an error path and bulk probing gets cheaper by exactly one HEAD request.
   */
  it('answers an unknown slug in the same shape as a known one — 200, never 404', async () => {
    const known = await app.inject({ method: 'GET', url: `/api/v1/branding/${fx.main.slug}` });
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/v1/branding/no-such-clinic-anywhere',
    });

    expect(unknown.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(known.statusCode);

    const body = unknown.json<{ name: string; logoVersion: string | null }>();
    expect(body.logoVersion).toBeNull();
    // Neutral, and specifically not our product name: under full white-label a
    // clinic never sees "HealthCloud".
    expect(body.name).not.toMatch(/healthcloud/i);
  });

  it('does not need a session', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/branding/${fx.main.slug}` });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a slug that could not exist rather than querying for it', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/branding/Not%20A%20Slug' });
    expect(res.statusCode).toBe(400);
  });

  /**
   * Suspension is read-only, not lockout (docs/06 section 2.6). Staff at a
   * suspended clinic still sign in, so they still see their own name.
   */
  it('still resolves branding for a suspended clinic', async () => {
    await ownerQuery(
      fx.other.id,
      `UPDATE tenant SET status = 'SUSPENDED', suspended_at = now(), suspended_reason = 'test'
        WHERE id = $1`,
      [fx.other.id],
    );

    try {
      const res = await app.inject({ method: 'GET', url: `/api/v1/branding/${fx.other.slug}` });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ name: string }>().name).toBeTruthy();
    } finally {
      await ownerQuery(
        fx.other.id,
        `UPDATE tenant SET status = 'ACTIVE', suspended_at = NULL, suspended_reason = NULL
          WHERE id = $1`,
        [fx.other.id],
      );
    }
  });
});

describe('uploading a logo', () => {
  it('accepts a PNG and reports the stored size', async () => {
    const res = await putLogo(admin, await png(200, 120));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ width: 200, height: 120 });
    expect(res.json<{ logoVersion: string }>().logoVersion).toMatch(/^[0-9a-f]{16}$/);
  });

  /**
   * The format is read from the bytes, never from a name or a declared type —
   * so a JPEG is recognised as a JPEG and re-encoded, and there is no filename
   * anywhere in this request to lie with.
   */
  it('accepts a JPEG and stores it re-encoded as PNG', async () => {
    expect((await putLogo(admin, await jpeg())).statusCode).toBe(200);

    const [row] = await ownerQuery<{ logo_mime_type: string; logo_bytes: Buffer }>(
      fx.main.id,
      `SELECT logo_mime_type, logo_bytes FROM tenant WHERE id = $1`,
      [fx.main.id],
    );

    expect(row?.logo_mime_type).toBe('image/png');
    // PNG magic bytes. The JPEG did not survive the trip, which is the point.
    expect(Buffer.from(row!.logo_bytes).subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it('refuses an SVG', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
        '<script>alert(1)</script><rect width="100" height="100"/></svg>',
    );

    const res = await putLogo(admin, svg);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatch(/svg/i);

    const [row] = await ownerQuery<{ logo_bytes: Buffer | null }>(
      fx.main.id,
      `SELECT logo_bytes FROM tenant WHERE id = $1`,
      [fx.main.id],
    );
    expect(row?.logo_bytes).toBeNull();
  });

  it('refuses bytes that are not an image at all', async () => {
    const res = await putLogo(admin, Buffer.from('this is not an image, it is a sentence'));
    expect(res.statusCode).toBe(400);
  });

  it('refuses an oversized payload before decoding it', async () => {
    // Larger than the cap, and deliberately not a valid image: if this returned
    // "not an image" rather than "too large", the size check would be running
    // after the decode it exists to prevent.
    const oversized = Buffer.alloc(700 * 1024, 0x41);
    const res = await putLogo(admin, oversized);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatch(/512KB|at most/i);
  });

  it('scales a large image down to the stored bound', async () => {
    const res = await putLogo(admin, await png(2000, 1000));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ width: 512, height: 256 });
  });

  it('refuses a caller without tenant:configure', async () => {
    const res = await putLogo(frontDesk, await png());
    expect(res.statusCode).toBe(403);
  });

  it('refuses a caller with no session', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/branding/logo',
      payload: { logo: (await png()).toString('base64') },
    });
    expect(res.statusCode).toBe(401);
  });

  it('records the change in the audit trail without the bytes', async () => {
    await putLogo(admin, await png());

    const rows = await ownerQuery<{ action: string; changed_fields: string[] }>(
      fx.main.id,
      `SELECT action, changed_fields FROM audit_event
        WHERE tenant_id = $1 AND action = 'branding.logo.set'`,
      [fx.main.id],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.changed_fields).toEqual(['logoBytes']);
  });
});

describe('serving the logo', () => {
  it('404s when the clinic has no logo of its own', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/branding/${fx.main.slug}/logo` });
    expect(res.statusCode).toBe(404);
  });

  it('serves the bytes publicly, cached hard and typed as PNG', async () => {
    await putLogo(admin, await png());

    const res = await app.inject({ method: 'GET', url: `/api/v1/branding/${fx.main.slug}/logo` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(res.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('answers 304 when the client already has that version', async () => {
    await putLogo(admin, await png());

    const first = await app.inject({ method: 'GET', url: `/api/v1/branding/${fx.main.slug}/logo` });
    const etag = first.headers.etag as string;

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/branding/${fx.main.slug}/logo`,
      headers: { 'if-none-match': etag },
    });

    expect(second.statusCode).toBe(304);
  });

  it('changes the version when the logo changes', async () => {
    await putLogo(admin, await png());
    const before = await app.inject({ method: 'GET', url: `/api/v1/branding/${fx.main.slug}` });

    // Moved explicitly rather than by uploading twice: two uploads a few
    // milliseconds apart would usually produce different versions, and a test
    // that is usually right is the kind that fails in CI at 2am.
    await ownerQuery(
      fx.main.id,
      `UPDATE tenant SET logo_updated_at = now() + interval '1 hour' WHERE id = $1`,
      [fx.main.id],
    );

    const after = await app.inject({ method: 'GET', url: `/api/v1/branding/${fx.main.slug}` });

    expect(after.json<{ logoVersion: string }>().logoVersion).not.toBe(
      before.json<{ logoVersion: string }>().logoVersion,
    );
  });

  /** The cross-tenant assertion. One clinic's slug, one clinic's bytes. */
  it('never serves one clinic the logo of another', async () => {
    await putLogo(admin, await png(200, 120));
    await putLogo(otherAdmin, await png(64, 64));

    const mainRes = await app.inject({
      method: 'GET',
      url: `/api/v1/branding/${fx.main.slug}/logo`,
    });
    const otherRes = await app.inject({
      method: 'GET',
      url: `/api/v1/branding/${fx.other.slug}/logo`,
    });

    expect(mainRes.statusCode).toBe(200);
    expect(otherRes.statusCode).toBe(200);
    expect(mainRes.rawPayload.equals(otherRes.rawPayload)).toBe(false);

    const meta = await sharp(otherRes.rawPayload).metadata();
    expect(meta).toMatchObject({ width: 64, height: 64 });
  });
});

describe('removing a logo', () => {
  it('clears it and falls back to no version', async () => {
    await putLogo(admin, await png());

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/v1/branding/logo',
      headers: { cookie: admin.cookie },
    });
    expect(del.statusCode).toBe(204);

    const res = await app.inject({ method: 'GET', url: `/api/v1/branding/${fx.main.slug}` });
    expect(res.json<{ logoVersion: string | null }>().logoVersion).toBeNull();

    const logo = await app.inject({ method: 'GET', url: `/api/v1/branding/${fx.main.slug}/logo` });
    expect(logo.statusCode).toBe(404);
  });

  it('refuses a caller without tenant:configure', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/branding/logo',
      headers: { cookie: frontDesk.cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

/**
 * The limiter is exercised directly rather than over HTTP.
 *
 * Sixty-one injected requests would exhaust the window for every later test in
 * this file, since they all arrive from the same address — a test that breaks
 * its neighbours is worse than one that skips a layer. What matters here is the
 * counting, and that is all in this class.
 */
describe('public rate limiting', () => {
  const request = (ip: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ ip }) }),
    }) as never;

  it('allows a normal burst and then refuses', () => {
    const guard = new PublicRateLimitGuard();

    for (let i = 0; i < 60; i++) {
      expect(guard.canActivate(request('10.0.0.1'))).toBe(true);
    }

    // Asserted on the status rather than the message: HttpException built with
    // a response object reports its message as the generic 'Http Exception',
    // and 429 is the part a caller actually reacts to.
    try {
      guard.canActivate(request('10.0.0.1'));
      throw new Error('expected the 61st request to be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(429);
    }
  });

  it('counts each address separately', () => {
    const guard = new PublicRateLimitGuard();

    for (let i = 0; i < 60; i++) guard.canActivate(request('10.0.0.1'));

    expect(guard.canActivate(request('10.0.0.2'))).toBe(true);
  });
});

/**
 * The console cannot wear a clinic's identity unless the session carries it.
 *
 * These live here rather than in auth.e2e.test.ts because what they protect is
 * the branding feature: if `tenant` quietly drops off /auth/me, every screen
 * falls back to a default logo and a blank name after one refresh, and nothing
 * else in the suite would notice.
 */
describe('clinic identity on the session', () => {
  it('is returned by login', async () => {
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
    const tenant = res.json<{
      tenant: { slug: string; name: string; logoVersion: string | null };
    }>().tenant;

    expect(tenant.slug).toBe(fx.main.slug);
    expect(tenant.name).toBeTruthy();
    expect(tenant.logoVersion).toBeNull();
  });

  it('survives a reload, and reflects a logo uploaded since sign-in', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: frontDesk.cookie },
    });
    expect(before.json<{ tenant: { logoVersion: string | null } }>().tenant.logoVersion).toBeNull();

    await putLogo(admin, await png());

    // The same session, re-read. An administrator changing the logo should
    // reach the front desk on their next refresh, not their next sign-in.
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: frontDesk.cookie },
    });

    expect(after.json<{ tenant: { logoVersion: string | null } }>().tenant.logoVersion).toMatch(
      /^[0-9a-f]{16}$/,
    );
  });

  it('never carries another clinic identity', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: otherAdmin.cookie },
    });

    expect(res.json<{ tenant: { slug: string } }>().tenant.slug).toBe(fx.other.slug);
  });
});

/**
 * A waiting-room television wears the clinic's mark too — and still must not
 * learn anything about a patient in the process.
 */
describe('the display board carries branding', () => {
  it('names the clinic and its logo version, and no patient', async () => {
    await putLogo(admin, await png());

    const paired = await app.inject({
      method: 'POST',
      url: '/api/v1/display-devices',
      headers: { cookie: admin.cookie },
      payload: { name: 'Branding check screen' },
    });
    expect(paired.statusCode).toBe(201);

    const key = paired.json<{ accessKey: string }>().accessKey;
    const board = await app.inject({ method: 'GET', url: `/api/v1/display/${key}` });

    expect(board.statusCode).toBe(200);
    const body = board.json<{
      clinic: string;
      clinicSlug: string;
      clinicLogoVersion: string | null;
    }>();

    expect(body.clinicSlug).toBe(fx.main.slug);
    expect(body.clinicLogoVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(body.clinic).toBeTruthy();
  });
});

describe('the clinic’s patient ID format', () => {
  function read(session: Session) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/settings/patient-ids',
      headers: { cookie: session.cookie },
    });
  }

  async function issued(tenantId: string): Promise<number> {
    const [row] = await ownerQuery<{ n: number }>(
      tenantId,
      'SELECT uhid_counter::int AS n FROM tenant WHERE id = $1',
      [tenantId],
    );
    return row!.n;
  }

  it('shows the format, an example, how many are issued and the next ID', async () => {
    const n = await issued(fx.main.id);

    const res = await read(admin);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      prefix: 'T',
      width: 6,
      issued: n,
      example: 'T000001',
      next: `T${String(n + 1).padStart(6, '0')}`,
      lastChanged: null,
    });
  });

  it('says when it was last changed, as platform support rather than a person', async () => {
    await ownerQuery(
      fx.main.id,
      `INSERT INTO audit_event (tenant_id, action, resource_type, resource_id, changed_fields, reason, actor_label)
       VALUES ($1::uuid, 'tenant.uhid_format_change', 'Tenant', $1::text,
               ARRAY['uhidPrefix', 'uhidPadding'], $2, $3)`,
      [fx.main.id, 'Clinic asked for DRVIV-', 'platform: ops@doctorsdesk.test'],
    );

    try {
      const body = (await read(admin)).json();

      expect(body.lastChanged).toMatchObject({
        by: 'Platform support',
        reason: 'Clinic asked for DRVIV-',
      });
      expect(body.lastChanged.at).toBeTruthy();
      // Under white-label the clinic never sees the platform's staff by name.
      // The email stays in the audit row for whoever needs it.
      expect(JSON.stringify(body)).not.toContain('doctorsdesk');
    } finally {
      await ownerQuery(
        fx.main.id,
        `DELETE FROM audit_event WHERE action = 'tenant.uhid_format_change'`,
      );
    }
  });

  it('shows each clinic only its own format', async () => {
    await ownerQuery(fx.other.id, `UPDATE tenant SET uhid_prefix = 'OTH' WHERE id = $1`, [
      fx.other.id,
    ]);

    try {
      expect((await read(admin)).json().prefix).toBe('T');
      expect((await read(otherAdmin)).json().prefix).toBe('OTH');
    } finally {
      await ownerQuery(fx.other.id, `UPDATE tenant SET uhid_prefix = 'T' WHERE id = $1`, [
        fx.other.id,
      ]);
    }
  });

  it('is refused to somebody who does not configure the clinic', async () => {
    expect((await read(frontDesk)).statusCode).toBe(403);
  });

  it('offers no way to change it from inside the clinic', async () => {
    /**
     * Decision D3. There is no write route here at all — not a guarded one.
     * The format is changed by the platform, through a different realm.
     */
    for (const method of ['PATCH', 'PUT', 'POST'] as const) {
      const res = await app.inject({
        method,
        url: '/api/v1/settings/patient-ids',
        headers: { cookie: admin.cookie },
        payload: { prefix: 'HACK-', width: 4 },
      });
      expect(res.statusCode).toBe(404);
    }
    expect((await read(admin)).json().prefix).toBe('T');
  });
});

describe('renaming the clinic', () => {
  it('changes the name everywhere it is read from', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/branding',
      headers: { cookie: admin.cookie },
      payload: { name: '  Sunrise Multispeciality Hospital  ' },
    });

    expect(res.statusCode).toBe(200);
    // Trimmed by the database function, not by the caller.
    expect(res.json<{ name: string }>().name).toBe('Sunrise Multispeciality Hospital');

    const publicLookup = await app.inject({
      method: 'GET',
      url: `/api/v1/branding/${fx.main.slug}`,
    });
    expect(publicLookup.json<{ name: string }>().name).toBe('Sunrise Multispeciality Hospital');

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: frontDesk.cookie },
    });
    expect(session.json<{ tenant: { name: string } }>().tenant.name).toBe(
      'Sunrise Multispeciality Hospital',
    );
  });

  it('refuses a name too short to be one', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/branding',
      headers: { cookie: admin.cookie },
      payload: { name: 'S' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a caller without tenant:configure', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/branding',
      headers: { cookie: frontDesk.cookie },
      payload: { name: 'Front Desk Renamed This' },
    });
    expect(res.statusCode).toBe(403);
  });

  /**
   * legal_name is a registration fact, not a display preference. If this ever
   * starts changing, a clinic can quietly alter what its documents claim it is
   * registered as.
   */
  it('leaves the registered legal name alone', async () => {
    const [before] = await ownerQuery<{ legal_name: string }>(
      fx.main.id,
      `SELECT legal_name FROM tenant WHERE id = $1`,
      [fx.main.id],
    );

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/branding',
      headers: { cookie: admin.cookie },
      payload: { name: 'Something Entirely Different' },
    });

    const [after] = await ownerQuery<{ legal_name: string }>(
      fx.main.id,
      `SELECT legal_name FROM tenant WHERE id = $1`,
      [fx.main.id],
    );

    expect(after?.legal_name).toBe(before?.legal_name);
  });

  it('cannot rename another clinic', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/branding',
      headers: { cookie: otherAdmin.cookie },
      payload: { name: 'Renamed By The Other Clinic' },
    });

    const main = await app.inject({ method: 'GET', url: `/api/v1/branding/${fx.main.slug}` });
    expect(main.json<{ name: string }>().name).not.toBe('Renamed By The Other Clinic');
  });
});
