/**
 * The waiting-room screen, over HTTP.
 *
 * The centre of this file is `never sends a patient name`. Everything else here
 * is access control; that one is the product promise. A screen on a wall is a
 * disclosure to a room full of strangers, and the only durable way to keep a
 * name off it is for the server never to send one — a client that "chooses not
 * to render" a name has already received it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  clinicDate,
  closeTestApp,
  createTestApp,
  login,
  loginWithMfa,
  ownerQuery,
  resetAppointments,
  seedFixtures,
  type Fixtures,
  type Session,
} from './harness.js';

/**
 * First name and a last initial, spelled out here rather than imported.
 *
 * Importing `publicPatientName` would make this test agree with the
 * implementation by construction — including when the implementation is wrong.
 */
function shortened(fullName: string): string {
  const words = fullName.trim().split(/\s+/);
  return words.length === 1 ? words[0]! : `${words[0]} ${words[words.length - 1]![0]}.`;
}

let app: NestFastifyApplication;
let fx: Fixtures;
let admin: Session;
let frontDesk: Session;
let doctor: Session;
let otherAdmin: Session;

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();

  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  doctor = await login(app, fx.main.slug, 'doctor@main.test');
  admin = await loginWithMfa(app, fx.main.slug, 'admin@main.test');
  otherAdmin = await loginWithMfa(app, fx.other.slug, 'admin@other.test');
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  await resetAppointments();
  await ownerQuery(fx.main.id, 'DELETE FROM display_device WHERE tenant_id = $1', [fx.main.id]);
  await ownerQuery(fx.other.id, 'DELETE FROM display_device WHERE tenant_id = $1', [fx.other.id]);
});

// --- helpers ----------------------------------------------------------------

async function pair(session: Session = admin, body: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/display-devices',
    headers: { cookie: session.cookie },
    payload: { name: 'Ground floor waiting', ...body },
  });
  return res;
}

function board(key: string) {
  return app.inject({ method: 'GET', url: `/api/v1/display/${encodeURIComponent(key)}` });
}

/**
 * Put a row on TODAY's board.
 *
 * The screen shows today and only today, so these tests cannot use the
 * book-a-week-ahead helper the rest of the suite shares. They cannot book for
 * today either: the seeded doctor sits 09:00–12:00, so a test that books through
 * the API would pass in the morning and fail after lunch.
 *
 * So the row is written the way the demo seed writes one — which is also the
 * shape the timezone regression test uses, for the same reason.
 */
async function onTodaysBoard(input: {
  patientIndex: number;
  token: number;
  status: 'ARRIVED' | 'IN_PROGRESS';
  /** Minutes ago they became ready. Lower means later in the queue. */
  readyMinutesAgo: number;
}) {
  const today = clinicDate(0);
  const readyAt = new Date(Date.now() - input.readyMinutesAgo * 60000).toISOString();

  const [row] = await ownerQuery<{ id: string }>(
    fx.main.id,
    `INSERT INTO appointment
       (tenant_id, patient_id, practitioner_id, location_id,
        start_at, end_at, status, visit_type, source,
        token_number, queue_date, checked_in_at, ready_at, called_at, updated_at)
     VALUES ($1, $2, $3, $4,
             $5::timestamptz, $5::timestamptz + interval '15 minutes',
             $6::appointment_status, 'NEW', 'FRONT_DESK',
             $7, $8::date, $9::timestamptz, $9::timestamptz,
             CASE WHEN $6 = 'IN_PROGRESS' THEN now() ELSE NULL END, now())
     RETURNING id`,
    [
      fx.main.id,
      fx.main.patientIds[input.patientIndex],
      fx.main.practitionerId,
      fx.main.locationId,
      `${today}T03:30:00Z`, // 09:00 in Kolkata
      input.status,
      input.token,
      today,
      readyAt,
    ],
  );

  return row?.id as string;
}

// --- pairing ----------------------------------------------------------------

describe('pairing a screen', () => {
  it('issues a key once and stores only its hash', async () => {
    const res = await pair();

    expect(res.statusCode).toBe(201);
    const key = res.json().accessKey as string;
    expect(key).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);

    // A database dump must yield nothing usable. The plaintext appears in the
    // response and nowhere else, ever.
    const [row] = await ownerQuery<{ access_key_hash: string }>(
      fx.main.id,
      'SELECT access_key_hash FROM display_device WHERE id = $1',
      [res.json().id],
    );
    expect(row?.access_key_hash).toHaveLength(64);
    expect(row?.access_key_hash).not.toContain(key);

    // And the listing never hands it back — not even the hash.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/display-devices',
      headers: { cookie: admin.cookie },
    });
    expect(JSON.stringify(list.json())).not.toContain(key);
    expect(JSON.stringify(list.json())).not.toContain('accessKey');
  });

  it('is refused without display:manage', async () => {
    for (const session of [frontDesk, doctor]) {
      const res = await pair(session);
      expect(res.statusCode).toBe(403);
    }
  });

  it('turns a screen off without deleting it', async () => {
    const key = (await pair()).json().accessKey as string;
    const id = (await pair()).json().id as string;

    expect((await board(key)).statusCode).toBe(200);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/display-devices/${id}`,
      headers: { cookie: admin.cookie },
    });
    expect(revoked.statusCode).toBe(200);

    // The row survives, so "when did it stop" has an answer.
    const [row] = await ownerQuery<{ is_active: boolean; revoked_at: Date | null }>(
      fx.main.id,
      'SELECT is_active, revoked_at FROM display_device WHERE id = $1',
      [id],
    );
    expect(row?.is_active).toBe(false);
    expect(row?.revoked_at).not.toBeNull();
  });
});

// --- the screen -------------------------------------------------------------

describe('what the screen reads', () => {
  it('never sends a patient name', async () => {
    const token = 7;
    await onTodaysBoard({ patientIndex: 0, token, status: 'IN_PROGRESS', readyMinutesAgo: 20 });
    const key = (await pair()).json().accessKey as string;

    const res = await board(key);
    expect(res.statusCode).toBe(200);

    const body = JSON.stringify(res.json());

    // The seeded patients, by name and by UHID. Asserted against the whole
    // payload rather than a field, because the promise is about what leaves the
    // server, not about what a client renders.
    const [patient] = await ownerQuery<{ name: string; uhid: string; mobile: string }>(
      fx.main.id,
      'SELECT name, uhid, mobile FROM patient WHERE id = $1',
      [fx.main.patientIds[0]],
    );

    expect(patient?.name).toBeTruthy();

    // The FULL name must not be in the payload. Since 26 Aug 2026 the board
    // shows "Kavita R." so that a patient can match themselves to a number —
    // but the surname is masked on the server and never leaves it, which is
    // what this asserts. A screen that received the full name and chose not to
    // paint it would have leaked it already.
    expect(body).not.toContain(patient?.name);
    expect(body).not.toContain(patient?.uhid);
    expect(body).not.toContain(patient?.mobile);

    // The surname on its own must not appear either — that is the part a
    // stranger could act on.
    const surname = patient!.name.trim().split(/\s+/).slice(1).join(' ');
    expect(surname).toBeTruthy();
    expect(body).not.toContain(surname);

    // What it DOES carry: the number, the shortened name, and who is calling.
    expect(res.json().doctors[0].nowServing).toBe(token);
    expect(res.json().doctors[0].nowServingName).toBe(shortened(patient!.name));
    expect(res.json().doctors[0].name).toBe('Dr Asha Menon');
    expect(res.json().clinic).toBe('Main Clinic');
  });

  it('shows the next few in serving order, not in token order', async () => {
    // Token 1 arrived second, token 2 arrived first. The screen has to agree
    // with the staff board — which orders by arrival — rather than sorting the
    // numbers it is about to paint.
    await onTodaysBoard({ patientIndex: 0, token: 1, status: 'ARRIVED', readyMinutesAgo: 5 });
    await onTodaysBoard({ patientIndex: 1, token: 2, status: 'ARRIVED', readyMinutesAgo: 30 });

    const key = (await pair()).json().accessKey as string;
    const res = await board(key);

    expect(res.json().doctors[0].next.map((n: { token: number }) => n.token)).toEqual([2, 1]);
    expect(res.json().doctors[0].waiting).toBe(2);
    expect(res.json().doctors[0].nowServing).toBeNull();
  });

  it('refuses an unknown, malformed or revoked key alike', async () => {
    const key = (await pair()).json().accessKey as string;

    expect((await board('not-a-key')).statusCode).toBe(401);
    expect((await board(`${fx.main.id}.wrongsecret`)).statusCode).toBe(401);

    // A real key for a screen that has been turned off is refused the same way,
    // with the same message: whoever holds it learns nothing either way.
    const devices = await app.inject({
      method: 'GET',
      url: '/api/v1/display-devices',
      headers: { cookie: admin.cookie },
    });

    for (const d of devices.json().devices as Array<{ id: string }>) {
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/display-devices/${d.id}`,
        headers: { cookie: admin.cookie },
      });
    }

    expect((await board(key)).statusCode).toBe(401);
  });

  it('records when the screen was last seen', async () => {
    const paired = (await pair()).json();
    await board(paired.accessKey);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/display-devices',
      headers: { cookie: admin.cookie },
    });

    const device = (list.json().devices as Array<{ id: string; lastSeenAt: string | null }>).find(
      (d) => d.id === paired.id,
    );

    // A dead screen and an idle one look identical on a wall; this is the only
    // way an administrator tells them apart.
    expect(device?.lastSeenAt).not.toBeNull();
  });
});

// --- tenancy ----------------------------------------------------------------

describe('one clinic cannot reach another', () => {
  it('shows only its own clinic, whoever paired it', async () => {
    await onTodaysBoard({ patientIndex: 0, token: 3, status: 'IN_PROGRESS', readyMinutesAgo: 15 });

    const theirs = await app.inject({
      method: 'POST',
      url: '/api/v1/display-devices',
      headers: { cookie: otherAdmin.cookie },
      payload: { name: 'Their waiting room' },
    });

    const res = await board(theirs.json().accessKey as string);

    expect(res.statusCode).toBe(200);
    // Their screen sees their clinic's doctors, and none of ours — even though
    // ours is the one with a patient in the room.
    expect(res.json().clinic).toBe('Other Clinic');
    expect(res.json().doctors[0].name).toBe('Dr Rohit Bhat');
    expect(res.json().doctors[0].nowServing).toBeNull();
  });

  it('cannot list another clinic’s screens', async () => {
    const mine = (await pair()).json().id as string;

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/display-devices',
      headers: { cookie: otherAdmin.cookie },
    });

    expect(list.statusCode).toBe(200);
    expect((list.json().devices as Array<{ id: string }>).map((d) => d.id)).not.toContain(mine);
  });
});
