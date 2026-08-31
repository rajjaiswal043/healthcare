/**
 * Roles and permissions, managed by a clinic administrator.
 *
 * Modelled on CIPCRM's role management at Narveer's request. Four properties
 * carry this file, and each protects against a way a clinic could lock itself
 * out or quietly break.
 *
 * **The Administrator role cannot be touched.** It is the way back from every
 * other change on this screen. A clinic that removed `role:manage` from it could
 * not undo that itself, and nobody at the clinic could fix it.
 *
 * **A role's key never changes.** Onboarding, seat limits and three backfill
 * migrations all address roles by key; a renamed key breaks them with no error
 * anybody would see.
 *
 * **Only permissions the code enforces can be granted.** A role holding
 * `patient:delete` would look meaningful and guard nothing.
 *
 * **Changing a role signs its holders out.** Permissions ride in the signed
 * token, so without this a permission you removed stays usable for hours.
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
let otherAdmin: Session;

async function roles(session: Session = admin) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/roles',
    headers: { cookie: session.cookie },
  });
  return res.json<{
    roles: Array<{
      id: string;
      key: string;
      name: string;
      permissions: string[];
      editable: boolean;
      deletable: boolean;
      resettable: boolean;
      staffCount: number;
    }>;
  }>().roles;
}

async function roleByKey(key: string) {
  const found = (await roles()).find((r) => r.key === key);
  if (!found) throw new Error(`No role with key ${key}`);
  return found;
}

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();

  admin = await loginWithMfa(app, fx.main.slug, 'admin@main.test');
  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  otherAdmin = await loginWithMfa(app, fx.other.slug, 'admin@other.test');
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  // Custom roles made by a previous test, and any permission edits to the
  // built-ins. Restored from SYSTEM_ROLES by the harness on the next seed, but
  // this file mutates within one seed so it cleans up after itself.
  await ownerQuery(
    fx.main.id,
    `DELETE FROM user_role WHERE role_id IN
    (SELECT id FROM role WHERE is_system = false)`,
  );
  await ownerQuery(fx.main.id, 'DELETE FROM role WHERE is_system = false');
});

describe('the permission catalogue', () => {
  it('describes every permission and groups it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions',
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(200);
    const { categories } = res.json<{
      categories: Array<{
        category: string;
        permissions: Array<{ name: string; description: string }>;
      }>;
    }>();

    const all = categories.flatMap((c) => c.permissions);

    // Every permission the code enforces is offered, described. A tickbox
    // labelled `consent:write` tells an administrator nothing.
    expect(all.length).toBeGreaterThanOrEqual(30);
    expect(all.every((p) => p.description.length > 5)).toBe(true);
    expect(all.map((p) => p.name)).toContain('patient:read');
  });

  it('is refused to somebody without role:manage', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions',
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('listing roles', () => {
  it('shows the six built-ins with how many staff hold each', async () => {
    const list = await roles();

    expect(list.map((r) => r.key)).toEqual(
      expect.arrayContaining([
        'front_desk',
        'doctor',
        'nurse',
        'diagnostics',
        'administrator',
        'owner',
      ]),
    );
    expect(list.find((r) => r.key === 'front_desk')?.staffCount).toBeGreaterThan(0);
  });

  it('marks the administrator as not editable and no built-in as deletable', async () => {
    const list = await roles();

    expect(list.find((r) => r.key === 'administrator')?.editable).toBe(false);
    expect(list.filter((r) => r.key !== 'administrator').every((r) => r.editable)).toBe(true);
    expect(list.some((r) => r.deletable)).toBe(false);
  });

  it("never shows one clinic another's roles", async () => {
    const mine = await roles();
    const theirs = await roles(otherAdmin);

    // Same keys, different rows: roles are per clinic.
    expect(new Set(mine.map((r) => r.id))).not.toEqual(new Set(theirs.map((r) => r.id)));
  });
});

describe('changing a built-in role', () => {
  it('adjusts its permissions', async () => {
    const nurse = await roleByKey('nurse');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${nurse.id}`,
      headers: { cookie: admin.cookie },
      payload: { permissions: [...nurse.permissions, 'document:write'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ permissions: string[] }>().permissions).toContain('document:write');

    // Put it back, so the rest of this file sees the shipped role.
    await app.inject({
      method: 'POST',
      url: `/api/v1/roles/${nurse.id}/reset`,
      headers: { cookie: admin.cookie },
    });
  });

  /**
   * The lock. If this ever passes, a clinic can remove `role:manage` from the
   * only role that holds it and lose the screen that would put it back.
   */
  it('refuses to change the administrator at all', async () => {
    const administrator = await roleByKey('administrator');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${administrator.id}`,
      headers: { cookie: admin.cookie },
      payload: { permissions: ['patient:read'] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.details?.code).toBe('ROLE_IS_LOCKED');
  });

  it('refuses a permission the code does not enforce', async () => {
    const nurse = await roleByKey('nurse');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${nurse.id}`,
      headers: { cookie: admin.cookie },
      payload: { permissions: ['patient:read', 'patient:delete'] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details?.code).toBe('UNKNOWN_PERMISSION');
  });

  it('leaves a built-in role its name, whatever is sent', async () => {
    const nurse = await roleByKey('nurse');

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${nurse.id}`,
      headers: { cookie: admin.cookie },
      payload: { name: 'Renamed By The Clinic' },
    });

    expect((await roleByKey('nurse')).name).toBe(nurse.name);
  });

  it('puts a changed role back with reset', async () => {
    const owner = await roleByKey('owner');

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${owner.id}`,
      headers: { cookie: admin.cookie },
      payload: { permissions: ['patient:read'] },
    });
    expect((await roleByKey('owner')).permissions).toHaveLength(1);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/roles/${owner.id}/reset`,
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(201);
    expect((await roleByKey('owner')).permissions).toEqual(owner.permissions);
  });

  it('cannot be deleted', async () => {
    const nurse = await roleByKey('nurse');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${nurse.id}`,
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.details?.code).toBe('ROLE_IS_BUILT_IN');
  });
});

describe('a role the clinic makes itself', () => {
  async function create(name: string, permissions: string[] = ['patient:read']) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { cookie: admin.cookie },
      payload: { name, permissions },
    });
  }

  it('is created with a key derived from the name', async () => {
    const res = await create('Ward sister', ['patient:read', 'vitals:write']);

    expect(res.statusCode).toBe(201);
    expect(res.json<{ key: string }>().key).toBe('ward_sister');
  });

  it('refuses a second role with the same name', async () => {
    await create('Ward sister');
    const again = await create('ward  SISTER');

    expect(again.statusCode).toBe(409);
    expect(again.json().error.details?.code).toBe('ROLE_EXISTS');
  });

  it('can be deleted while nobody holds it', async () => {
    const created = await create('Temporary');
    const id = created.json<{ id: string }>().id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${id}`,
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(200);
  });

  /**
   * Deleting a role somebody holds would leave them signed in with permissions
   * from a role that no longer exists.
   */
  it('cannot be deleted while somebody holds it', async () => {
    const created = await create('Held By Someone');
    const id = created.json<{ id: string }>().id;

    const [user] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM app_user WHERE email = 'nurse@main.test'`,
    );
    await ownerQuery(
      fx.main.id,
      'INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)',
      [fx.main.id, user!.id, id],
    );

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${id}`,
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('ROLE_IN_USE');
  });
});

/**
 * The part that makes a change mean something now.
 *
 * Permissions ride in the signed access token, which is what lets a request be
 * authorised without a database lookup — and the cost is that a token keeps
 * saying what it said when it was issued.
 */
describe('changing a role signs its holders out', () => {
  it('revokes the sessions of everybody holding it', async () => {
    const nurse = await roleByKey('nurse');
    const signedIn = await login(app, fx.main.slug, 'nurse@main.test');

    // The session works before the change.
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: signedIn.cookie },
    });
    expect(before.statusCode).toBe(200);

    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${nurse.id}`,
      headers: { cookie: admin.cookie },
      payload: { permissions: [...nurse.permissions, 'document:write'] },
    });
    expect(changed.json<{ signedOut: number }>().signedOut).toBeGreaterThan(0);

    const [row] = await ownerQuery<{ revoked_reason: string }>(
      fx.main.id,
      `SELECT revoked_reason FROM session
        WHERE user_id = (SELECT id FROM app_user WHERE email = 'nurse@main.test')
          AND revoked_at IS NOT NULL
        ORDER BY revoked_at DESC LIMIT 1`,
    );
    expect(row?.revoked_reason).toBe('role_changed');

    await app.inject({
      method: 'POST',
      url: `/api/v1/roles/${nurse.id}/reset`,
      headers: { cookie: admin.cookie },
    });
  });

  /**
   * The administrator making the change keeps their session. Signing yourself
   * out mid-edit means you cannot see whether the change worked — and they hold
   * every permission anyway, so nothing is gained.
   */
  it('leaves the administrator making the change signed in', async () => {
    const owner = await roleByKey('owner');

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${owner.id}`,
      headers: { cookie: admin.cookie },
      payload: { permissions: ['patient:read'] },
    });

    const stillIn = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: admin.cookie },
    });

    expect(stillIn.statusCode).toBe(200);
  });
});
