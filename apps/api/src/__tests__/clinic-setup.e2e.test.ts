/**
 * Doctors and hours — the setup screen, over HTTP.
 *
 * `PATCH /setup/practitioners/:id` had existed since the module was written and
 * had no test of any kind: the console offered no way to edit a doctor, so
 * nothing ever called it. It is the endpoint behind the Edit button now, which
 * makes both halves worth stating — what it changes, and what it refuses.
 *
 * The refusals carry most of this file. A shape that accepts a field is a shape
 * that will eventually be sent it, and two of the fields this endpoint used to
 * accept should never have been editable here at all.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  clinicDate,
  closeTestApp,
  createDoctor,
  createTestApp,
  login,
  loginWithMfa,
  ownerQuery,
  resetAppointments,
  seedBilling,
  seedFixtures,
  type Fixtures,
  type Session,
} from './harness.js';

let app: NestFastifyApplication;
let fx: Fixtures;
let admin: Session;
let frontDesk: Session;
let doctor: Session;
let otherAdmin: Session;

const DAY = clinicDate(7);
const CONSULT_FEE = 50000; // ₹500.00
const FOLLOW_UP_FEE = 30000; // ₹300.00

beforeAll(async () => {
  fx = await seedFixtures();
  await seedBilling(fx.main.id, {
    consultationFeePaise: CONSULT_FEE,
    followUpFeePaise: FOLLOW_UP_FEE,
  });

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

  // Put the doctor back the way the fixture left them, so each test starts from
  // a known profile rather than from whatever the last one wrote.
  await ownerQuery(
    fx.main.id,
    `UPDATE practitioner
        SET registration_number = 'TEST-0001',
            specialty = 'General Medicine',
            qualification = NULL,
            consultation_fee_paise = $2,
            follow_up_fee_paise = $3,
            updated_at = now()
      WHERE tenant_id = $1`,
    [fx.main.id, CONSULT_FEE, FOLLOW_UP_FEE],
  );
});

function update(body: Record<string, unknown>, session: Session = admin) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/setup/practitioners/${fx.main.practitionerId}`,
    headers: { cookie: session.cookie },
    payload: body,
  });
}

function readDoctor() {
  return ownerQuery<{
    registration_number: string | null;
    specialty: string | null;
    qualification: string | null;
    department_id: string | null;
    user_id: string | null;
    consultation_fee_paise: number | null;
    follow_up_fee_paise: number | null;
  }>(
    fx.main.id,
    `SELECT registration_number, specialty, qualification, department_id, user_id,
            consultation_fee_paise, follow_up_fee_paise
       FROM practitioner WHERE id = $1`,
    [fx.main.practitionerId],
  );
}

// --- the profile ------------------------------------------------------------

describe('editing a doctor', () => {
  it('changes the profile fields the screen offers', async () => {
    const res = await update({
      registrationNumber: 'MH-98765',
      specialty: 'Orthopaedics',
      qualification: 'MBBS, MS (Ortho)',
      consultationFeePaise: 80000,
      followUpFeePaise: 40000,
    });

    expect(res.statusCode).toBe(200);

    const [row] = await readDoctor();
    expect(row).toMatchObject({
      registration_number: 'MH-98765',
      specialty: 'Orthopaedics',
      qualification: 'MBBS, MS (Ortho)',
      consultation_fee_paise: 80000,
      follow_up_fee_paise: 40000,
    });
  });

  it('leaves out what the edit did not mention', async () => {
    await update({ specialty: 'Dermatology' });

    const [row] = await readDoctor();
    expect(row?.specialty).toBe('Dermatology');
    // Untouched, rather than overwritten with null.
    expect(row?.registration_number).toBe('TEST-0001');
    expect(row?.consultation_fee_paise).toBe(CONSULT_FEE);
  });

  /**
   * The way back to "this doctor has no override".
   *
   * Zero is a real and different answer — a doctor who does not charge — so it
   * cannot be the way to clear a fee. Null is, and it puts the doctor back on
   * the service catalogue's price.
   */
  it('clears a fee when it is sent as null', async () => {
    expect((await update({ consultationFeePaise: null, followUpFeePaise: null })).statusCode).toBe(
      200,
    );

    const [row] = await readDoctor();
    expect(row?.consultation_fee_paise).toBeNull();
    expect(row?.follow_up_fee_paise).toBeNull();
  });

  it('keeps zero as a fee of zero, not as no fee', async () => {
    expect((await update({ consultationFeePaise: 0 })).statusCode).toBe(200);

    const [row] = await readDoctor();
    expect(row?.consultation_fee_paise).toBe(0);
  });

  it('refuses a negative fee', async () => {
    expect((await update({ consultationFeePaise: -1 })).statusCode).toBe(400);
  });
});

// --- what an edit may not touch ---------------------------------------------

describe('what an edit may not touch', () => {
  /**
   * The department is the anchor two things already treat as permanent: the
   * finance report's department-wise revenue split, and where walk-in
   * diagnostics are filed. Moving a doctor would not re-file the money they
   * earned last quarter — it would change what last quarter's report MEANS.
   *
   * Refused rather than ignored. Ignoring tells the caller it worked.
   */
  it('refuses a department change outright', async () => {
    const [before] = await readDoctor();

    const res = await update({ departmentId: fx.main.departmentId });

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatch(/departmentId/i);

    const [after] = await readDoctor();
    expect(after?.department_id).toBe(before?.department_id ?? null);
  });

  it('refuses a department change even alongside legitimate fields', async () => {
    const res = await update({ specialty: 'Cardiology', departmentId: fx.main.departmentId });

    expect(res.statusCode).toBe(400);

    // The whole request is refused, so the legitimate half must not have landed
    // either — a partial write would be worse than the refusal.
    const [row] = await readDoctor();
    expect(row?.specialty).toBe('General Medicine');
  });

  /**
   * Linking a doctor to a login is a real feature; it is simply not this form,
   * and it needs its own decisions about replacing an existing link. Until it
   * has a screen, an edit cannot move it by accident.
   */
  it('refuses a login link', async () => {
    const res = await update({ userId: fx.main.patientIds[0] });
    expect(res.statusCode).toBe(400);
  });
});

// --- who may do it ----------------------------------------------------------

describe('who may edit a doctor', () => {
  it('refuses a caller without schedule:manage', async () => {
    for (const session of [frontDesk, doctor]) {
      expect((await update({ specialty: 'Nope' }, session)).statusCode).toBe(403);
    }
  });

  it('cannot reach a doctor at another clinic', async () => {
    const res = await update({ specialty: 'Wrong Clinic' }, otherAdmin);
    expect(res.statusCode).toBe(404);
  });
});

// --- the fee is a snapshot --------------------------------------------------

/**
 * A fee change applies to bills raised from now on, and to no bill already
 * raised.
 *
 * This is a property of the architecture rather than of this feature: the fee is
 * read once, when the invoice is created, and written onto `invoice_line` —
 * which the schema documents as denormalised on purpose, so an invoice reads the
 * same in ten years even if the service is repriced. Nothing re-reads the
 * practitioner for an existing invoice, and `ensureInvoiceForAppointment`
 * returns early when one exists.
 *
 * It was true before this screen existed and untested throughout. Making the fee
 * editable from the console is what turns it from a property nobody exercised
 * into one a clinic can break by accident, so it is asserted here.
 */
describe('changing a fee does not rewrite old bills', () => {
  // A different patient per bill: the same patient booking the same doctor
  // twice in one day is refused, and that check belongs to a different feature.
  async function bookAndBill(
    slotIndex: number,
    patientIndex = 0,
  ): Promise<{ id: string; totalPaise: number }> {
    const day = await app.inject({
      method: 'GET',
      url: `/api/v1/availability?practitionerId=${fx.main.practitionerId}&date=${DAY}`,
      headers: { cookie: frontDesk.cookie },
    });

    const booked = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: { cookie: frontDesk.cookie },
      payload: {
        patientId: fx.main.patientIds[patientIndex],
        practitionerId: fx.main.practitionerId,
        locationId: fx.main.locationId,
        startAt: day.json().slots[slotIndex].startAt,
      },
    });
    if (booked.statusCode !== 201) {
      throw new Error(`Could not book: ${booked.statusCode} ${booked.payload}`);
    }

    const invoice = await app.inject({
      method: 'GET',
      url: `/api/v1/appointments/${booked.json().id}/invoice`,
      headers: { cookie: frontDesk.cookie },
    });
    expect(invoice.statusCode).toBe(200);
    return invoice.json();
  }

  it('leaves the old invoice at the old fee, and prices the next one at the new', async () => {
    const before = await bookAndBill(0);
    expect(before.totalPaise).toBe(CONSULT_FEE);

    expect((await update({ consultationFeePaise: 90000 })).statusCode).toBe(200);

    // The stored line, not the response: this is the number the clinic will
    // print on a receipt a year from now.
    const [line] = await ownerQuery<{ unit_price_paise: number; total_paise: number }>(
      fx.main.id,
      `SELECT l.unit_price_paise, l.total_paise
         FROM invoice_line l WHERE l.invoice_id = $1`,
      [before.id],
    );
    expect(line?.unit_price_paise).toBe(CONSULT_FEE);
    expect(line?.total_paise).toBe(CONSULT_FEE);

    const [invoice] = await ownerQuery<{ total_paise: number }>(
      fx.main.id,
      'SELECT total_paise FROM invoice WHERE id = $1',
      [before.id],
    );
    expect(invoice?.total_paise).toBe(CONSULT_FEE);

    // And the change is not inert — the next bill is raised at the new fee.
    const after = await bookAndBill(1, 1);
    expect(after.totalPaise).toBe(90000);
  });

  it('falls back to the price list once the override is cleared', async () => {
    expect((await update({ consultationFeePaise: null })).statusCode).toBe(200);

    const billed = await bookAndBill(0);
    // seedBilling prices CONS-NEW at the same figure, which is what the doctor
    // now falls back to.
    expect(billed.totalPaise).toBe(CONSULT_FEE);
  });
});

// --- deleting a doctor added by mistake ---------------------------------------

/**
 * `DELETE /setup/practitioners/:id` — only for a doctor with no history at all.
 *
 * Every doctor here is created fresh and named `Dr Delete …`, so each test owns
 * its rows and nothing touches the shared fixture doctor.
 */
describe('deleting a doctor', () => {
  afterEach(async () => {
    await ownerQuery(fx.main.id, `DROP TRIGGER IF EXISTS test_book_during_delete ON practitioner`);
    await ownerQuery(fx.main.id, `DROP FUNCTION IF EXISTS test_book_during_delete()`);
    await ownerQuery(fx.main.id, `DROP TRIGGER IF EXISTS test_delete_attempted ON practitioner`);
    await ownerQuery(fx.main.id, `DROP FUNCTION IF EXISTS test_delete_attempted()`);
    await ownerQuery(
      fx.main.id,
      `DELETE FROM encounter WHERE practitioner_id IN (SELECT id FROM practitioner WHERE full_name LIKE 'Dr Delete%')`,
    );
    await ownerQuery(
      fx.main.id,
      `DELETE FROM appointment WHERE practitioner_id IN (SELECT id FROM practitioner WHERE full_name LIKE 'Dr Delete%')`,
    );
    await ownerQuery(fx.main.id, `DELETE FROM display_device WHERE name LIKE 'Delete test%'`);
    await ownerQuery(fx.main.id, `DELETE FROM practitioner WHERE full_name LIKE 'Dr Delete%'`);
  });

  async function newDoctor(fullName: string, body: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/practitioners',
      headers: { cookie: admin.cookie },
      payload: { fullName, registrationNumber: 'MH-DEL-01', ...body },
    });
    if (res.statusCode !== 201)
      throw new Error(`Could not create: ${res.statusCode} ${res.payload}`);
    return res.json<{ id: string }>().id;
  }

  function remove(id: string, session: Session = admin) {
    return app.inject({
      method: 'DELETE',
      url: `/api/v1/setup/practitioners/${id}`,
      headers: { cookie: session.cookie },
    });
  }

  async function appointmentFor(practitionerId: string, status: string, day = 0) {
    const [row] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO appointment (tenant_id, patient_id, practitioner_id, location_id,
                                start_at, end_at, status, visit_type, updated_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval,
               now() + ($5 || ' days')::interval + interval '15 minutes',
               $6::appointment_status, 'NEW', now())
       RETURNING id`,
      [fx.main.id, fx.main.patientIds[0], practitionerId, fx.main.locationId, String(day), status],
    );
    return row!.id;
  }

  const exists = async (id: string) =>
    (await ownerQuery(fx.main.id, 'SELECT 1 FROM practitioner WHERE id = $1', [id])).length === 1;

  // --- the zero-history case -------------------------------------------------

  it('deletes a doctor with no history, schedules and all', async () => {
    const id = await newDoctor('Dr Delete Clean');
    await ownerQuery(
      fx.main.id,
      `INSERT INTO practitioner_schedule (tenant_id, practitioner_id, location_id, day_of_week,
                                          start_time, end_time, valid_from, updated_at)
       VALUES ($1, $2, $3, 1, '09:00', '12:00', current_date, now())`,
      [fx.main.id, id, fx.main.locationId],
    );

    const res = await remove(id);

    expect(res.statusCode).toBe(200);
    expect(await exists(id)).toBe(false);
    expect(
      await ownerQuery(
        fx.main.id,
        'SELECT 1 FROM practitioner_schedule WHERE practitioner_id = $1',
        [id],
      ),
    ).toHaveLength(0);
  });

  /** The login lives on the practitioner row, so deleting the row frees it. */
  it('frees a linked login, which becomes linkable again', async () => {
    const login = await createDoctor(app, fx.main, {
      email: 'delete-login@main.test',
      fullName: 'Delete Login Owner',
      linked: false,
    });
    const [user] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM app_user WHERE email = 'delete-login@main.test'`,
    );
    const id = await newDoctor('Dr Delete Linked', { userId: user!.id });

    const linkable = async () =>
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/setup/practitioners',
          headers: { cookie: admin.cookie },
        })
      )
        .json<{ linkableUsers: Array<{ id: string }> }>()
        .linkableUsers.map((u) => u.id);

    expect(await linkable()).not.toContain(user!.id);
    expect((await remove(id)).statusCode).toBe(200);
    expect(await linkable()).toContain(user!.id);

    // And it can be linked to a correct entry straight away.
    await newDoctor('Dr Delete Relinked', { userId: user!.id });
    void login;
    await ownerQuery(fx.main.id, `DELETE FROM app_user WHERE email = 'delete-login@main.test'`);
  });

  it('takes the doctor off every waiting-room screen, and leaves the others on it', async () => {
    const id = await newDoctor('Dr Delete Screened');
    await ownerQuery(
      fx.main.id,
      `INSERT INTO display_device (tenant_id, name, access_key_hash, practitioner_ids, updated_at)
       VALUES ($1, 'Delete test screen', md5(random()::text), ARRAY[$2::uuid, $3::uuid], now())`,
      [fx.main.id, id, fx.main.practitionerId],
    );

    expect((await remove(id)).statusCode).toBe(200);

    const [screen] = await ownerQuery<{ practitioner_ids: string[] }>(
      fx.main.id,
      `SELECT practitioner_ids FROM display_device WHERE name = 'Delete test screen'`,
    );
    expect(screen?.practitioner_ids).toEqual([fx.main.practitionerId]);
  });

  /**
   * An empty list means "every doctor", so removing the last one would turn a
   * screen outside one room into the whole clinic's queue. Refused, and nothing
   * is changed — not even on a screen the doctor shares with someone else.
   */
  it('refuses when the doctor is the only one on a live screen, and names it', async () => {
    const id = await newDoctor('Dr Delete Sole');
    await ownerQuery(
      fx.main.id,
      `INSERT INTO display_device (tenant_id, name, access_key_hash, practitioner_ids, updated_at)
       VALUES ($1, 'Delete test sole', md5(random()::text), ARRAY[$2::uuid], now()),
              ($1, 'Delete test shared', md5(random()::text), ARRAY[$2::uuid, $3::uuid], now())`,
      [fx.main.id, id, fx.main.practitionerId],
    );

    const res = await remove(id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({
      code: 'PRACTITIONER_ONLY_DOCTOR_ON_SCREEN',
      screens: ['Delete test sole'],
    });
    expect(res.json().error.message).toContain('“Delete test sole”');
    expect(res.json().error.message).toMatch(/switch that screen off/i);
    expect(await exists(id)).toBe(true);

    const screens = await ownerQuery<{ name: string; practitioner_ids: string[] }>(
      fx.main.id,
      `SELECT name, practitioner_ids FROM display_device WHERE name LIKE 'Delete test%' ORDER BY name`,
    );
    expect(screens).toEqual([
      { name: 'Delete test shared', practitioner_ids: [id, fx.main.practitionerId] },
      { name: 'Delete test sole', practitioner_ids: [id] },
    ]);
  });

  /** A revoked screen shows nothing and never comes back; it is not in the way. */
  it('does not count a revoked screen, and deletes', async () => {
    const id = await newDoctor('Dr Delete Revoked Screen');
    await ownerQuery(
      fx.main.id,
      `INSERT INTO display_device (tenant_id, name, access_key_hash, practitioner_ids,
                                   is_active, revoked_at, updated_at)
       VALUES ($1, 'Delete test revoked', md5(random()::text), ARRAY[$2::uuid], false, now(), now())`,
      [fx.main.id, id],
    );

    expect((await remove(id)).statusCode).toBe(200);
    expect(await exists(id)).toBe(false);
  });

  /**
   * Every earlier audit row about this doctor points at an id that no longer
   * exists. This one has to say who it was.
   */
  it('records who was deleted, by name and registration number', async () => {
    const id = await newDoctor('Dr Delete Audited', { registrationNumber: 'MH-AUD-77' });

    await remove(id);

    const [row] = await ownerQuery<{ reason: string; actor_user_id: string | null }>(
      fx.main.id,
      `SELECT reason, actor_user_id FROM audit_event
        WHERE action = 'practitioner.delete' AND resource_id = $1`,
      [id],
    );
    expect(row?.reason).toContain('Dr Delete Audited');
    expect(row?.reason).toContain('MH-AUD-77');
    expect(row?.actor_user_id).toBeTruthy();
  });

  // --- the history case ------------------------------------------------------

  it('refuses a doctor with appointments and consultations, and says how many', async () => {
    const id = await newDoctor('Dr Delete Busy');
    const first = await appointmentFor(id, 'FULFILLED', -2);
    await appointmentFor(id, 'BOOKED', 3);
    await ownerQuery(
      fx.main.id,
      `INSERT INTO encounter (tenant_id, appointment_id, patient_id, practitioner_id, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [fx.main.id, first, fx.main.patientIds[0], id],
    );

    const res = await remove(id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({
      code: 'PRACTITIONER_HAS_HISTORY',
      appointments: 2,
      encounters: 1,
    });
    expect(res.json().error.message).toContain('2 appointments and 1 consultation');
    expect(res.json().error.message).toMatch(/switch them off/i);
    expect(await exists(id)).toBe(true);
  });

  /**
   * A cancelled appointment is still a record that this doctor was offered to
   * a patient on a date. It counts as history.
   */
  it('refuses a doctor whose only appointment was cancelled', async () => {
    const id = await newDoctor('Dr Delete Cancelled');
    await appointmentFor(id, 'CANCELLED', 1);

    const res = await remove(id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({ appointments: 1, encounters: 0 });
    expect(res.json().error.message).toContain('1 appointment');
    expect(await exists(id)).toBe(true);
  });

  /**
   * The history check on its own. The race handling below would also answer
   * 409 if the delete were attempted and tripped the foreign key, so the two
   * could hide each other. Here any attempt to delete the row fails with an
   * error that is NOT a foreign-key one — so only the check running first, and
   * never reaching the delete, can produce the 409.
   */
  it('refuses on the history check alone, without ever attempting the delete', async () => {
    const id = await newDoctor('Dr Delete Precheck');
    await appointmentFor(id, 'FULFILLED', -1);
    await ownerQuery(
      fx.main.id,
      `CREATE FUNCTION test_delete_attempted() RETURNS trigger LANGUAGE plpgsql AS $fn$
       BEGIN
         RAISE EXCEPTION 'the delete was attempted';
       END $fn$`,
    );
    await ownerQuery(
      fx.main.id,
      `CREATE TRIGGER test_delete_attempted BEFORE DELETE ON practitioner
         FOR EACH ROW WHEN (OLD.full_name = 'Dr Delete Precheck')
         EXECUTE FUNCTION test_delete_attempted()`,
    );

    const res = await remove(id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({
      code: 'PRACTITIONER_HAS_HISTORY',
      appointments: 1,
    });
    expect(await exists(id)).toBe(true);
  });

  /**
   * The race: something is booked for this doctor after the history check has
   * passed. Simulated with a trigger that inserts an appointment as the row is
   * deleted, so the RESTRICT foreign key fails inside the delete itself. It must
   * still be a 409 — never the generic 500 — and the doctor must survive.
   */
  it('turns a booking that races the delete into the same 409, not a 500', async () => {
    const id = await newDoctor('Dr Delete Race');
    await ownerQuery(
      fx.main.id,
      `CREATE FUNCTION test_book_during_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
       BEGIN
         INSERT INTO appointment (tenant_id, patient_id, practitioner_id, location_id,
                                  start_at, end_at, status, visit_type, updated_at)
         VALUES (OLD.tenant_id, '${fx.main.patientIds[0]}', OLD.id, '${fx.main.locationId}',
                 now() + interval '1 day', now() + interval '1 day 15 minutes',
                 'BOOKED', 'NEW', now());
         RETURN OLD;
       END $fn$`,
    );
    await ownerQuery(
      fx.main.id,
      `CREATE TRIGGER test_book_during_delete BEFORE DELETE ON practitioner
         FOR EACH ROW WHEN (OLD.full_name = 'Dr Delete Race')
         EXECUTE FUNCTION test_book_during_delete()`,
    );

    const res = await remove(id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('PRACTITIONER_HAS_HISTORY');
    expect(await exists(id)).toBe(true);
  });

  // --- who may, and what -----------------------------------------------------

  it('is refused without schedule:manage', async () => {
    const id = await newDoctor('Dr Delete Guarded');

    for (const session of [frontDesk, doctor]) {
      expect((await remove(id, session)).statusCode).toBe(403);
    }
    expect(await exists(id)).toBe(true);
  });

  it('cannot reach a doctor at another clinic', async () => {
    const id = await newDoctor('Dr Delete Elsewhere');

    expect((await remove(id, otherAdmin)).statusCode).toBe(404);
    expect(await exists(id)).toBe(true);
  });

  it('answers 404 for a doctor that does not exist', async () => {
    expect((await remove('019329f0-0000-7000-8000-00000000dead')).statusCode).toBe(404);
  });

  it('lists each doctor with the history that decides whether they can be deleted', async () => {
    const id = await newDoctor('Dr Delete Listed');
    await appointmentFor(id, 'CANCELLED', 1);

    const list = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/setup/practitioners',
        headers: { cookie: admin.cookie },
      })
    ).json<{ practitioners: Array<{ id: string; history: unknown }> }>();

    expect(list.practitioners.find((p) => p.id === id)?.history).toEqual({
      appointments: 1,
      encounters: 0,
    });
  });
});

// --- the login link ----------------------------------------------------------

describe('the login link', () => {
  afterEach(async () => {
    await ownerQuery(fx.main.id, `DROP TRIGGER IF EXISTS test_link_race ON practitioner`);
    await ownerQuery(fx.main.id, `DROP FUNCTION IF EXISTS test_link_race()`);
    const mine = `(SELECT id FROM practitioner WHERE full_name LIKE 'Dr Link%')`;
    await ownerQuery(fx.main.id, `DELETE FROM encounter WHERE practitioner_id IN ${mine}`);
    await ownerQuery(fx.main.id, `DELETE FROM appointment WHERE practitioner_id IN ${mine}`);
    await ownerQuery(fx.main.id, `DELETE FROM practitioner WHERE full_name LIKE 'Dr Link%'`);
    await ownerQuery(fx.main.id, `DELETE FROM app_user WHERE email LIKE 'link-%@main.test'`);
  });

  function post(path: 'link-login' | 'unlink-login', id: string, body: unknown, session: Session) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/setup/practitioners/${id}/${path}`,
      headers: { cookie: session.cookie },
      payload: body as Record<string, unknown>,
    });
  }
  const unlink = (
    id: string,
    body: unknown = { reason: 'Linked to the wrong doctor' },
    s = admin,
  ) => post('unlink-login', id, body, s);
  const link = (id: string, userId: string, reason = 'Correct doctor for this login', s = admin) =>
    post('link-login', id, { userId, reason }, s);

  /** A doctor who signs in — a login with the doctor role, and optionally its entry. */
  async function doctorLogin(tag: string, linked: boolean) {
    const made = await createDoctor(app, fx.main, {
      email: `link-${tag}@main.test`,
      fullName: `Dr Link ${tag}`,
      linked,
    });
    const [user] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM app_user WHERE email = $1`,
      [`link-${tag}@main.test`],
    );
    return { ...made, userId: user!.id };
  }

  /** A doctor entry with no login. */
  async function entry(fullName: string) {
    const [row] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO practitioner (tenant_id, full_name, updated_at) VALUES ($1, $2, now()) RETURNING id`,
      [fx.main.id, fullName],
    );
    return row!.id;
  }

  async function bookFor(practitionerId: string, withEncounter: boolean) {
    const [appt] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO appointment (tenant_id, patient_id, practitioner_id, location_id,
                                start_at, end_at, status, visit_type, updated_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 day', now() - interval '1 day' + interval '15 minutes',
               'FULFILLED', 'NEW', now())
       RETURNING id`,
      [fx.main.id, fx.main.patientIds[0], practitionerId, fx.main.locationId],
    );
    if (withEncounter) {
      await ownerQuery(
        fx.main.id,
        `INSERT INTO encounter (tenant_id, appointment_id, patient_id, practitioner_id, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [fx.main.id, appt!.id, fx.main.patientIds[0], practitionerId],
      );
    }
  }

  const userOf = async (practitionerId: string) =>
    (
      await ownerQuery<{ user_id: string | null }>(
        fx.main.id,
        'SELECT user_id FROM practitioner WHERE id = $1',
        [practitionerId],
      )
    )[0]?.user_id;

  const previousOf = async (practitionerId: string) =>
    (
      await ownerQuery<{ previous_user_id: string | null }>(
        fx.main.id,
        'SELECT previous_user_id FROM practitioner WHERE id = $1',
        [practitionerId],
      )
    )[0]?.previous_user_id;

  /**
   * The audit trail is for people, not for the rule. These rewrite or remove it
   * to prove the outcome does not move — the application role can do both to
   * audit rows, so a rule that read them could be steered.
   */
  const rewriteUnlinkAudit = (practitionerId: string, asUserId: string) =>
    ownerQuery(
      fx.main.id,
      `UPDATE audit_event SET reason = 'login ' || $2 || ' (forged) unlinked. Reason: x'
        WHERE action = 'practitioner.unlink_login' AND resource_id = $1`,
      [practitionerId, asUserId],
    );
  const deleteUnlinkAudit = (practitionerId: string) =>
    ownerQuery(
      fx.main.id,
      `DELETE FROM audit_event WHERE action = 'practitioner.unlink_login' AND resource_id = $1`,
      [practitionerId],
    );

  const resolvesTo = async (session: Session) =>
    (
      await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: session.cookie },
      })
    ).json<{ practitionerId: string | null }>().practitionerId;

  const queueStatus = async (session: Session, practitionerId: string) =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/v1/queue?practitionerId=${practitionerId}`,
        headers: { cookie: session.cookie },
      })
    ).statusCode;

  const linkable = async () =>
    (
      await app.inject({
        method: 'GET',
        url: '/api/v1/setup/practitioners',
        headers: { cookie: admin.cookie },
      })
    )
      .json<{ linkableUsers: Array<{ id: string }> }>()
      .linkableUsers.map((u) => u.id);

  const lastAudit = async (action: string, id: string) =>
    (
      await ownerQuery<{ reason: string; actor_user_id: string | null; changed_fields: string[] }>(
        fx.main.id,
        `SELECT reason, actor_user_id, changed_fields FROM audit_event
          WHERE action = $1 AND resource_id = $2 ORDER BY id DESC LIMIT 1`,
        [action, id],
      )
    )[0];

  // --- unlink ----------------------------------------------------------------

  it('unlinks: the login is linkable again, and no longer resolves to the entry', async () => {
    const dr = await doctorLogin('unlink', true);
    const id = dr.practitionerId!;
    expect(await resolvesTo(dr.session)).toBe(id);
    expect(await queueStatus(dr.session, id)).toBe(200);
    expect(await linkable()).not.toContain(dr.userId);

    const res = await unlink(id);

    expect(res.statusCode).toBe(200);
    expect(await userOf(id)).toBeNull();
    expect(await previousOf(id)).toBe(dr.userId);
    expect(await linkable()).toContain(dr.userId);
    // The same session, not a new one: the link is looked up per request.
    expect(await resolvesTo(dr.session)).toBeNull();
    // Fail-closed: a doctor with no entry has no queue — not the whole clinic's.
    expect(await queueStatus(dr.session, id)).toBe(403);
  });

  it('keeps the entry and all its history', async () => {
    const dr = await doctorLogin('keep', true);
    const id = dr.practitionerId!;
    await bookFor(id, true);
    await bookFor(id, false);

    expect((await unlink(id)).statusCode).toBe(200);

    const [row] = await ownerQuery<{ n_appt: number; n_enc: number; n_sched: number }>(
      fx.main.id,
      `SELECT (SELECT count(*)::int FROM appointment WHERE practitioner_id = $1) AS n_appt,
              (SELECT count(*)::int FROM encounter WHERE practitioner_id = $1) AS n_enc,
              (SELECT count(*)::int FROM practitioner_schedule WHERE practitioner_id = $1) AS n_sched`,
      [id],
    );
    expect(row).toEqual({ n_appt: 2, n_enc: 1, n_sched: 7 });
  });

  it('records which login was unlinked from which doctor, and why', async () => {
    const dr = await doctorLogin('audit-u', true);

    await unlink(dr.practitionerId!, { reason: 'Receptionist picked the wrong name' });

    const row = await lastAudit('practitioner.unlink_login', dr.practitionerId!);
    expect(row?.reason).toMatch(new RegExp(`^login ${dr.userId} `));
    expect(row?.reason).toContain('link-audit-u@main.test');
    expect(row?.reason).toContain('Dr Link audit-u');
    expect(row?.reason).toContain('Receptionist picked the wrong name');
    expect(row?.changed_fields).toEqual(['userId']);
    expect(row?.actor_user_id).toBeTruthy();
  });

  it('requires a reason', async () => {
    const dr = await doctorLogin('reason', true);

    for (const body of [{}, { reason: '' }, { reason: '      ' }]) {
      expect((await unlink(dr.practitionerId!, body)).statusCode).toBe(400);
    }
    expect((await link(dr.practitionerId!, dr.userId, '   ')).statusCode).toBe(400);
    expect(await userOf(dr.practitionerId!)).toBe(dr.userId);
  });

  it('refuses to unlink an entry that has no login', async () => {
    const id = await entry('Dr Link Nobody');

    const res = await unlink(id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('NO_LOGIN_LINKED');
  });

  // --- link ------------------------------------------------------------------

  it('links a login to an entry with none, and the login resolves to it', async () => {
    const dr = await doctorLogin('link', false);
    const id = await entry('Dr Link Target');
    expect(await resolvesTo(dr.session)).toBeNull();

    const res = await link(id, dr.userId, 'New doctor started Monday');

    expect(res.statusCode).toBe(200);
    expect(await userOf(id)).toBe(dr.userId);
    expect(await resolvesTo(dr.session)).toBe(id);
    expect(await queueStatus(dr.session, id)).toBe(200);
    expect(await linkable()).not.toContain(dr.userId);

    const row = await lastAudit('practitioner.link_login', id);
    expect(row?.reason).toMatch(new RegExp(`^login ${dr.userId} `));
    expect(row?.reason).toContain('link-link@main.test');
    expect(row?.reason).toContain('Dr Link Target');
    expect(row?.reason).toContain('New doctor started Monday');
  });

  it('refuses an entry that already has a login — unlink first', async () => {
    const holder = await doctorLogin('holder', true);
    const other = await doctorLogin('other', false);

    const res = await link(holder.practitionerId!, other.userId);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('PRACTITIONER_HAS_LOGIN');
    expect(res.json().error.message).toMatch(/unlink it first/i);
    expect(await userOf(holder.practitionerId!)).toBe(holder.userId);
  });

  it('refuses a login the linkable list would not offer', async () => {
    const id = await entry('Dr Link Picky');
    const inactive = await doctorLogin('inactive', false);
    await ownerQuery(fx.main.id, `UPDATE app_user SET is_active = false WHERE id = $1`, [
      inactive.userId,
    ]);
    const [frontDeskUser] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM app_user WHERE email = 'frontdesk@main.test'`,
    );
    const [linkedDoctor] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM app_user WHERE email = 'doctor@main.test'`,
    );

    const cases: Array<[string, number, string | undefined]> = [
      [inactive.userId, 409, 'LOGIN_NOT_LINKABLE'],
      [frontDeskUser!.id, 409, 'LOGIN_NOT_LINKABLE'],
      [linkedDoctor!.id, 409, 'USER_ALREADY_LINKED'],
      ['019329f0-0000-7000-8000-00000000beef', 400, undefined],
    ];
    const offered = await linkable();
    for (const [userId, status, code] of cases) {
      expect(offered).not.toContain(userId);
      const res = await link(id, userId);
      expect(res.statusCode).toBe(status);
      if (code) expect(res.json().error.details?.code).toBe(code);
    }
    expect(await userOf(id)).toBeNull();
  });

  it('allows an entry that has appointments but no consultations', async () => {
    const dr = await doctorLogin('appts', false);
    const id = await entry('Dr Link Booked');
    await bookFor(id, false);

    expect((await link(id, dr.userId)).statusCode).toBe(200);
    expect(await userOf(id)).toBe(dr.userId);
  });

  /**
   * Two administrators linking the same login to two entries at once. Forced
   * here with a trigger that gives the login to the rival entry inside the
   * update, so the unique index on `practitioner.user_id` fires every time —
   * the path the application's own check cannot close.
   */
  it('answers a link that loses the race with 409, not a 500', async () => {
    const dr = await doctorLogin('race', false);
    const id = await entry('Dr Link Race');
    const rival = await entry('Dr Link Race Rival');
    await ownerQuery(
      fx.main.id,
      `CREATE FUNCTION test_link_race() RETURNS trigger LANGUAGE plpgsql AS $fn$
       BEGIN
         UPDATE practitioner SET user_id = NEW.user_id WHERE full_name = 'Dr Link Race Rival';
         RETURN NEW;
       END $fn$`,
    );
    await ownerQuery(
      fx.main.id,
      `CREATE TRIGGER test_link_race BEFORE UPDATE OF user_id ON practitioner
         FOR EACH ROW WHEN (NEW.full_name = 'Dr Link Race' AND NEW.user_id IS NOT NULL)
         EXECUTE FUNCTION test_link_race()`,
    );

    const res = await link(id, dr.userId);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('USER_ALREADY_LINKED');
    expect(await userOf(id)).toBeNull();
    expect(await userOf(rival)).toBeNull();
  });

  it('gives exactly one success when the same login is linked twice at once', async () => {
    const dr = await doctorLogin('twice', false);
    const a = await entry('Dr Link Twice A');
    const b = await entry('Dr Link Twice B');

    const results = await Promise.all([link(a, dr.userId), link(b, dr.userId)]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const holders = [await userOf(a), await userOf(b)].filter(Boolean);
    expect(holders).toEqual([dr.userId]);
  });

  // --- link, when the entry has consultations -----------------------------------

  it('links back the login that was unlinked from an entry with consultations', async () => {
    const dr = await doctorLogin('back', true);
    const id = dr.practitionerId!;
    await bookFor(id, true);

    expect((await unlink(id)).statusCode).toBe(200);
    // With the trail gone, the column alone still knows who this was.
    await deleteUnlinkAudit(id);
    const res = await link(id, dr.userId, 'Unlinked by mistake');

    expect(res.statusCode).toBe(200);
    expect(await resolvesTo(dr.session)).toBe(id);
    // A link does not clear it: it stays the record of the last unlink.
    expect(await previousOf(id)).toBe(dr.userId);
  });

  it('refuses any other login for an entry with consultations, and says how many', async () => {
    const dr = await doctorLogin('owner', true);
    const stranger = await doctorLogin('stranger', false);
    const id = dr.practitionerId!;
    await bookFor(id, true);
    await bookFor(id, true);
    await unlink(id);
    // A trail rewritten to name the stranger does not let them in.
    await rewriteUnlinkAudit(id, stranger.userId);

    const res = await link(id, stranger.userId);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({
      code: 'LOGIN_WOULD_TAKE_OVER_NOTES',
      encounters: 2,
    });
    expect(res.json().error.message).toContain('2 consultations');
    expect(await userOf(id)).toBeNull();
  });

  /**
   * Consultations written before the ownership fix, on an entry nobody ever
   * unlinked through this screen: there is no previous login on record, so
   * there is nobody who may be linked to it.
   */
  it('refuses every login for an entry with consultations and no unlink on record', async () => {
    const dr = await doctorLogin('legacy', false);
    const id = await entry('Dr Link Legacy');
    await bookFor(id, true);
    // An unlink event that the column never saw — forged, or from before the
    // column existed — does not make anyone the previous login.
    await ownerQuery(
      fx.main.id,
      `INSERT INTO audit_event (tenant_id, action, resource_type, resource_id, changed_fields, reason)
       VALUES ($1, 'practitioner.unlink_login', 'Practitioner', $2, ARRAY['userId'],
               'login ' || $3 || ' (forged) unlinked. Reason: x')`,
      [fx.main.id, id, dr.userId],
    );

    const res = await link(id, dr.userId);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({ encounters: 1 });
  });

  it('tells the screen which login an entry has, and who alone may be linked back', async () => {
    const dr = await doctorLogin('listed', true);
    const withNotes = dr.practitionerId!;
    await bookFor(withNotes, true);
    const plain = await entry('Dr Link Plain');
    const legacy = await entry('Dr Link Listed Legacy');
    await bookFor(legacy, true);

    const before = async () =>
      new Map(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/setup/practitioners',
            headers: { cookie: admin.cookie },
          })
        )
          .json<{
            practitioners: Array<{ id: string; login: unknown; relinkOnly?: unknown }>;
          }>()
          .practitioners.map((p) => [p.id, p]),
      );

    let list = await before();
    expect(list.get(withNotes)?.login).toMatchObject({
      id: dr.userId,
      email: 'link-listed@main.test',
    });
    expect(list.get(withNotes)).not.toHaveProperty('relinkOnly');

    await unlink(withNotes);
    await deleteUnlinkAudit(withNotes);
    list = await before();
    expect(list.get(withNotes)?.login).toBeNull();
    expect(list.get(withNotes)?.relinkOnly).toMatchObject({ id: dr.userId });
    expect(list.get(plain)).not.toHaveProperty('relinkOnly');
    expect(list.get(legacy)?.relinkOnly).toBeNull();
  });

  // --- the flow this exists for ------------------------------------------------

  it('moves a login from the wrong entry to the right one, and the queue follows', async () => {
    const dr = await doctorLogin('wrong', true);
    const wrong = dr.practitionerId!;
    const right = await entry('Dr Link Right');
    expect(await queueStatus(dr.session, wrong)).toBe(200);
    expect(await queueStatus(dr.session, right)).toBe(403);

    expect((await unlink(wrong)).statusCode).toBe(200);
    expect((await link(right, dr.userId)).statusCode).toBe(200);

    expect(await resolvesTo(dr.session)).toBe(right);
    expect(await queueStatus(dr.session, right)).toBe(200);
    expect(await queueStatus(dr.session, wrong)).toBe(403);
  });

  // --- who may ---------------------------------------------------------------

  it('is administrator only', async () => {
    const dr = await doctorLogin('guard', true);
    const id = await entry('Dr Link Guarded');

    for (const session of [frontDesk, doctor]) {
      expect((await unlink(dr.practitionerId!, undefined, session)).statusCode).toBe(403);
      expect((await link(id, dr.userId, 'reason here', session)).statusCode).toBe(403);
    }
    expect(await userOf(dr.practitionerId!)).toBe(dr.userId);
    expect(await userOf(id)).toBeNull();
  });

  /**
   * The case the two above cannot tell apart: somebody who may set doctors'
   * hours (`schedule:manage`) but not manage users. The link decides whose
   * queue and notes a login opens, so hours alone do not buy it.
   */
  it('is refused to a role that has schedule:manage without user:manage', async () => {
    const dr = await doctorLogin('hours', true);
    await ownerQuery(
      fx.main.id,
      `INSERT INTO role (tenant_id, key, name, permissions, updated_at)
       VALUES ($1, 'link_test_hours', 'Hours only', ARRAY['schedule:manage'], now())`,
      [fx.main.id],
    );
    const [user] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO app_user (tenant_id, email, full_name, password_hash, updated_at)
       SELECT tenant_id, 'link-hours-admin@main.test', 'Hours Admin', password_hash, now()
         FROM app_user WHERE tenant_id = $1 AND email = 'frontdesk@main.test'
       RETURNING id`,
      [fx.main.id],
    );
    await ownerQuery(
      fx.main.id,
      `INSERT INTO user_role (tenant_id, user_id, role_id)
       SELECT $1, $2, id FROM role WHERE tenant_id = $1 AND key = 'link_test_hours'`,
      [fx.main.id, user!.id],
    );
    const hoursOnly = await login(app, fx.main.slug, 'link-hours-admin@main.test');

    try {
      // Holds schedule:manage for real — the setup list opens for them.
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/setup/practitioners',
            headers: { cookie: hoursOnly.cookie },
          })
        ).statusCode,
      ).toBe(200);

      const res = await unlink(dr.practitionerId!, undefined, hoursOnly);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain('user:manage');
      expect(await userOf(dr.practitionerId!)).toBe(dr.userId);
    } finally {
      await ownerQuery(
        fx.main.id,
        `DELETE FROM app_user WHERE email = 'link-hours-admin@main.test'`,
      );
      await ownerQuery(fx.main.id, `DELETE FROM role WHERE key = 'link_test_hours'`);
    }
  });

  it('cannot reach a doctor at another clinic', async () => {
    const dr = await doctorLogin('far', true);

    expect((await unlink(dr.practitionerId!, undefined, otherAdmin)).statusCode).toBe(404);
    expect(await userOf(dr.practitionerId!)).toBe(dr.userId);
  });

  it('answers 404 for a doctor that does not exist', async () => {
    const dr = await doctorLogin('ghost', false);
    const ghost = '019329f0-0000-7000-8000-00000000dead';

    expect((await unlink(ghost)).statusCode).toBe(404);
    expect((await link(ghost, dr.userId)).statusCode).toBe(404);
  });
});

// --- switching a doctor off -----------------------------------------------------

describe('switching a doctor off and on', () => {
  afterEach(async () => {
    for (const name of ['test_slow_insert', 'test_slow_switch_off']) {
      await ownerQuery(fx.main.id, `DROP TRIGGER IF EXISTS ${name} ON appointment`);
      await ownerQuery(fx.main.id, `DROP TRIGGER IF EXISTS ${name} ON practitioner`);
      await ownerQuery(fx.main.id, `DROP FUNCTION IF EXISTS ${name}()`);
    }
    // Walk-ins and bookings raise invoices, which hold the appointments down.
    await resetAppointments();
    await ownerQuery(fx.main.id, `DELETE FROM practitioner WHERE full_name LIKE 'Dr Switch%'`);
  });

  async function entry(fullName: string, isActive = true) {
    const [row] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO practitioner (tenant_id, full_name, is_active, updated_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [fx.main.id, fullName, isActive],
    );
    return row!.id;
  }

  /**
   * An appointment at a time relative to the start of TODAY in the clinic's
   * timezone — not to now — so "earlier today" and "late yesterday" mean the
   * same thing whenever the suite runs.
   */
  async function visit(practitionerId: string, status: string, fromStartOfToday: string) {
    const [tz] = await ownerQuery<{ timezone: string }>(
      fx.main.id,
      'SELECT timezone FROM tenant WHERE id = $1',
      [fx.main.id],
    );
    await ownerQuery(
      fx.main.id,
      `INSERT INTO appointment (tenant_id, patient_id, practitioner_id, location_id,
                                start_at, end_at, status, visit_type, updated_at)
       SELECT $1, $2, $3, $4, t, t + interval '15 minutes', $5::appointment_status, 'NEW', now()
         FROM (SELECT (date_trunc('day', now() AT TIME ZONE $6) AT TIME ZONE $6)
                      + $7::interval AS t) s`,
      [
        fx.main.id,
        fx.main.patientIds[0],
        practitionerId,
        fx.main.locationId,
        status,
        tz!.timezone,
        fromStartOfToday,
      ],
    );
  }

  function toggle(id: string, isActive: boolean, session: Session = admin) {
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/setup/practitioners/${id}`,
      headers: { cookie: session.cookie },
      payload: { isActive },
    });
  }

  const isActive = async (id: string) =>
    (
      await ownerQuery<{ is_active: boolean }>(
        fx.main.id,
        'SELECT is_active FROM practitioner WHERE id = $1',
        [id],
      )
    )[0]?.is_active;

  it('refuses while patients are still coming, and says how many', async () => {
    const id = await entry('Dr Switch Busy');
    // Every status that means "still coming", including one booked for
    // earlier today who has not been seen yet.
    await visit(id, 'BOOKED', '1 minute');
    await visit(id, 'ARRIVED', '2 hours');
    await visit(id, 'IN_PROGRESS', '3 hours');
    await visit(id, 'AWAITING_TESTS', '1 day 2 hours');
    await visit(id, 'BOOKED', '5 days');

    const res = await toggle(id, false);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({
      code: 'PRACTITIONER_HAS_UPCOMING',
      upcoming: 5,
    });
    expect(res.json().error.message).toContain('5 upcoming appointments');
    expect(await isActive(id)).toBe(true);
  });

  it('says "1 upcoming appointment" for one', async () => {
    const id = await entry('Dr Switch One');
    await visit(id, 'BOOKED', '1 day');

    const res = await toggle(id, false);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('1 upcoming appointment ');
  });

  /**
   * Nothing here is still coming: finished, cancelled, no-show — and a visit
   * left BOOKED yesterday, which is stale rather than upcoming.
   */
  it('allows it when only past, cancelled and no-show visits exist', async () => {
    const id = await entry('Dr Switch Quiet');
    await visit(id, 'FULFILLED', '-1 day');
    await visit(id, 'BOOKED', '-1 hour');
    await visit(id, 'CANCELLED', '1 day');
    await visit(id, 'NO_SHOW', '2 hours');

    const res = await toggle(id, false);

    expect(res.statusCode).toBe(200);
    expect(await isActive(id)).toBe(false);
  });

  it('allows it for a doctor with no appointments at all', async () => {
    const id = await entry('Dr Switch Empty');

    expect((await toggle(id, false)).statusCode).toBe(200);
    expect(await isActive(id)).toBe(false);
  });

  /** Switching back on puts nobody at risk, so nothing blocks it. */
  it('always switches back on', async () => {
    const id = await entry('Dr Switch Returning', false);
    await visit(id, 'BOOKED', '1 day');

    const res = await toggle(id, true);

    expect(res.statusCode).toBe(200);
    expect(await isActive(id)).toBe(true);
  });

  it('leaves other edits alone for a doctor with upcoming appointments', async () => {
    const id = await entry('Dr Switch Edited');
    await visit(id, 'BOOKED', '1 day');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/setup/practitioners/${id}`,
      headers: { cookie: admin.cookie },
      payload: { specialty: 'Dermatology' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('is refused without schedule:manage', async () => {
    const id = await entry('Dr Switch Guarded');

    for (const session of [frontDesk, doctor]) {
      expect((await toggle(id, false, session)).statusCode).toBe(403);
    }
    expect(await isActive(id)).toBe(true);
  });

  it('cannot reach a doctor at another clinic', async () => {
    const id = await entry('Dr Switch Elsewhere');

    expect((await toggle(id, false, otherAdmin)).statusCode).toBe(404);
    expect(await isActive(id)).toBe(true);
  });

  it('answers 404 for a doctor that does not exist', async () => {
    expect((await toggle('019329f0-0000-7000-8000-00000000dead', false)).statusCode).toBe(404);
  });

  // --- no new appointment for a switched-off doctor ------------------------------

  function walkIn(practitionerId: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/appointments/walk-in',
      headers: { cookie: frontDesk.cookie },
      payload: {
        patientId: fx.main.patientIds[0],
        practitionerId,
        locationId: fx.main.locationId,
      },
    });
  }

  function book(practitionerId: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: { cookie: frontDesk.cookie },
      payload: {
        patientId: fx.main.patientIds[0],
        practitionerId,
        locationId: fx.main.locationId,
        startAt: `${clinicDate(1)}T09:00:00+05:30`,
      },
    });
  }

  /** Hours every day, so tomorrow at 09:00 is a real slot. */
  async function withHours(id: string) {
    await ownerQuery(
      fx.main.id,
      `INSERT INTO practitioner_schedule
         (tenant_id, practitioner_id, location_id, day_of_week, start_time, end_time,
          slot_minutes, capacity_per_slot, visit_types, valid_from, updated_at)
       SELECT $1, $2, $3, d, '09:00', '12:00', 15, 1, '{}', current_date - 30, now()
         FROM generate_series(0, 6) d`,
      [fx.main.id, id, fx.main.locationId],
    );
  }

  const appointmentsFor = async (id: string) =>
    (
      await ownerQuery<{ n: number }>(
        fx.main.id,
        'SELECT count(*)::int AS n FROM appointment WHERE practitioner_id = $1',
        [id],
      )
    )[0]!.n;

  /** The invariant this section exists for, stated once. */
  async function neverSwitchedOffWithNewAppointment(id: string) {
    const off = !(await isActive(id));
    const n = await appointmentsFor(id);
    expect(off && n > 0, `switched off with ${n} new appointment(s)`).toBe(false);
  }

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** A trigger that holds a transaction open at a chosen moment, so the race is forced. */
  async function slowDown(name: string, table: string, when: string) {
    await ownerQuery(
      fx.main.id,
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fn$
       BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $fn$`,
    );
    await ownerQuery(
      fx.main.id,
      `CREATE TRIGGER ${name} BEFORE ${table === 'appointment' ? 'INSERT' : 'UPDATE'} ON ${table}
         FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}()`,
    );
  }

  it('refuses a walk-in for a switched-off doctor, as booking does', async () => {
    const id = await entry('Dr Switch Walked Off', false);

    const res = await walkIn(id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('SLOT_NOT_AVAILABLE');
    expect(res.json().error.message).toBe('This doctor is no longer active.');
    expect(await appointmentsFor(id)).toBe(0);
  });

  it('takes a walk-in for an active doctor', async () => {
    const id = await entry('Dr Switch Walked On');

    expect((await walkIn(id)).statusCode).toBe(201);
    expect(await appointmentsFor(id)).toBe(1);
  });

  /**
   * The walk-in gets there first and is held mid-insert. The switch-off has to
   * wait for it, then counts it, and refuses.
   */
  it('refuses the switch-off when a walk-in is already saving', async () => {
    const id = await entry('Dr Switch Race Walk First');
    await slowDown('test_slow_insert', 'appointment', `NEW.practitioner_id = '${id}'::uuid`);

    const walking = walkIn(id);
    await pause(400);
    const switching = toggle(id, false);
    const [walk, off] = await Promise.all([walking, switching]);

    expect(walk.statusCode).toBe(201);
    expect(off.statusCode).toBe(409);
    expect(off.json().error.details).toMatchObject({
      code: 'PRACTITIONER_HAS_UPCOMING',
      upcoming: 1,
    });
    expect(await isActive(id)).toBe(true);
    await neverSwitchedOffWithNewAppointment(id);
  });

  /**
   * The switch-off gets there first and is held mid-update. The walk-in has to
   * wait for it, then sees the doctor switched off, and is refused.
   */
  it('refuses a walk-in that arrives while the switch-off is saving', async () => {
    const id = await entry('Dr Switch Race Off First');
    await slowDown(
      'test_slow_switch_off',
      'practitioner',
      `OLD.is_active AND NOT NEW.is_active AND NEW.id = '${id}'::uuid`,
    );

    const switching = toggle(id, false);
    await pause(400);
    const walking = walkIn(id);
    const [off, walk] = await Promise.all([switching, walking]);

    expect(off.statusCode).toBe(200);
    expect(walk.statusCode).toBe(409);
    expect(walk.json().error.message).toBe('This doctor is no longer active.');
    await neverSwitchedOffWithNewAppointment(id);
  });

  /**
   * The same for a booking — the path whose availability check reads in a
   * transaction of its own, which is where the window was.
   */
  it('refuses a booking that arrives while the switch-off is saving', async () => {
    const id = await entry('Dr Switch Race Book');
    await withHours(id);
    await slowDown(
      'test_slow_switch_off',
      'practitioner',
      `OLD.is_active AND NOT NEW.is_active AND NEW.id = '${id}'::uuid`,
    );

    const switching = toggle(id, false);
    await pause(400);
    const booking = book(id);
    const [off, booked] = await Promise.all([switching, booking]);

    expect(off.statusCode).toBe(200);
    expect(booked.statusCode).toBe(409);
    expect(booked.json().error.message).toBe('This doctor is no longer active.');
    await neverSwitchedOffWithNewAppointment(id);
  });
});
