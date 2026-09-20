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
