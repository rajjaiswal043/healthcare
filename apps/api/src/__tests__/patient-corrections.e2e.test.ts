/**
 * Correcting a patient after registration — FR-P36-20 to FR-P36-22.
 *
 * Three properties carry this file.
 *
 * **UHID and ABHA cannot be changed, and the refusal is the server's.** The
 * screen not showing a field is not the same as the API declining it, so these
 * are asserted against the endpoint rather than against the form.
 *
 * **Only what actually moved is recorded.** Re-saving an unchanged form writes
 * no history, or the trail fills with corrections nobody made and stops being
 * worth reading.
 *
 * **A correction that creates a duplicate is allowed.** Refusing it would leave
 * the clinic holding both the typo and the duplicate; the warning is what the
 * front desk acts on, and merging remains the fix.
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
let frontDesk: Session;
let nurse: Session;
let admin: Session;
let otherFrontDesk: Session;

/** A patient of our own, so the shared fixtures stay untouched. */
let patientId: string;
let currentMobile: string;

/**
 * Every fixture patient gets a distinct mobile.
 *
 * Registration refuses a STRONG duplicate, and a patient registered by an
 * earlier test in this file is still there — reusing one number makes the second
 * test fail on the fixture rather than on the thing it is testing.
 */
let nextMobile = 11100011;

async function correct(session: Session, id: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/patients/${id}`,
    headers: { cookie: session.cookie },
    payload: body,
  });
}

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();

  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  nurse = await login(app, fx.main.slug, 'nurse@main.test');
  admin = await loginWithMfa(app, fx.main.slug, 'admin@main.test');
  otherFrontDesk = await login(app, fx.other.slug, 'frontdesk@other.test');
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  await ownerQuery(fx.main.id, 'DELETE FROM patient_correction');

  currentMobile = `98${nextMobile++}`;

  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/patients',
    headers: { cookie: frontDesk.cookie },
    payload: {
      name: 'Kavtia Sharma',
      gender: 'FEMALE',
      ageYears: 34,
      mobile: currentMobile,
      // Every test in this file registers a patient with the same name, so each
      // one looks like a duplicate of the last. That check is not what is under
      // test here — confirmed through so a fixture never fails for a reason
      // belonging to a different feature.
      confirmedNotDuplicate: true,
      consentCareDelivery: true,
    },
  });

  if (registered.statusCode !== 201) {
    throw new Error(`Could not register the fixture patient: ${registered.payload}`);
  }
  patientId = registered.json<{ patient: { id: string } }>().patient.id;
});

describe('correcting a patient', () => {
  it('fixes a misspelled name and records what it said before', async () => {
    const res = await correct(frontDesk, patientId, { name: 'Kavita Sharma' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ patient: { name: string } }>().patient.name).toBe('Kavita Sharma');

    const [row] = await ownerQuery<{ field: string; old_value: string; new_value: string }>(
      fx.main.id,
      'SELECT field, old_value, new_value FROM patient_correction',
    );

    expect(row).toMatchObject({
      field: 'name',
      old_value: 'Kavtia Sharma',
      new_value: 'Kavita Sharma',
    });
  });

  it('writes one row per field changed, and none for fields that did not', async () => {
    await correct(frontDesk, patientId, {
      name: 'Kavita Sharma',
      mobile: `98${nextMobile++}`,
      // Unchanged — must not appear in the history.
      gender: 'FEMALE',
    });

    const rows = await ownerQuery<{ field: string }>(
      fx.main.id,
      'SELECT field FROM patient_correction ORDER BY field',
    );

    expect(rows.map((r) => r.field)).toEqual(['mobile', 'name']);
  });

  it('records nothing when nothing moved', async () => {
    const res = await correct(frontDesk, patientId, { name: 'Kavtia Sharma' });

    expect(res.statusCode).toBe(200);
    expect(await ownerQuery(fx.main.id, 'SELECT id FROM patient_correction')).toHaveLength(0);
  });

  /**
   * The two identity fields. Asserted at the API because the DTO's
   * `forbidNonWhitelisted` is what refuses them — a UI that stops showing a
   * field is not a server that stops accepting it.
   */
  it('refuses to change the UHID', async () => {
    const res = await correct(frontDesk, patientId, { uhid: 'SNC999999' });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to change the ABHA number', async () => {
    const res = await correct(frontDesk, patientId, { abhaNumber: '12-3456-7890-1234' });
    expect(res.statusCode).toBe(400);
  });

  /**
   * An age recorded two years ago beside a newly known birth date is worse than
   * no age at all, so setting one clears the other.
   */
  it('clears the stored age when a birth date is given', async () => {
    const res = await correct(frontDesk, patientId, { birthDate: '1991-03-12' });

    expect(res.statusCode).toBe(200);

    const [row] = await ownerQuery<{ age_years: number | null; birth_date: Date | null }>(
      fx.main.id,
      'SELECT age_years, birth_date FROM patient WHERE id = $1',
      [patientId],
    );

    expect(row?.age_years).toBeNull();
    expect(row?.birth_date).not.toBeNull();

    const cleared = await ownerQuery<{ field: string; new_value: string | null }>(
      fx.main.id,
      `SELECT field, new_value FROM patient_correction WHERE field = 'ageYears'`,
    );
    expect(cleared[0]?.new_value).toBeNull();
  });

  it('warns about a duplicate rather than refusing the correction', async () => {
    const twinMobile = `98${nextMobile++}`;

    const twin = await app.inject({
      method: 'POST',
      url: '/api/v1/patients',
      headers: { cookie: frontDesk.cookie },
      payload: {
        name: 'Kavita Sharma',
        gender: 'FEMALE',
        ageYears: 34,
        mobile: twinMobile,
        // The twin itself is a near-match for the fixture patient, so
        // registration would refuse it. Confirmed through, because the duplicate
        // this test is about is the one the CORRECTION creates.
        confirmedNotDuplicate: true,
        consentCareDelivery: true,
      },
    });
    expect(twin.statusCode).toBe(201);

    // Same name, same mobile as the patient just registered: unmistakably a
    // duplicate, and the correction still goes through.
    const res = await correct(frontDesk, patientId, {
      name: 'Kavita Sharma',
      mobile: twinMobile,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ duplicatesWarned: unknown[] }>().duplicatesWarned.length).toBeGreaterThan(0);
    expect(res.json<{ patient: { mobile: string } }>().patient.mobile).toBe(twinMobile);
  });

  it('refuses a caller without patient:write', async () => {
    const res = await correct(nurse, patientId, { name: 'Nurse Renamed This' });
    expect(res.statusCode).toBe(403);
  });

  it('cannot reach a patient at another clinic', async () => {
    const res = await correct(otherFrontDesk, patientId, { name: 'Wrong Clinic' });
    expect(res.statusCode).toBe(404);
  });
});

describe('reading the corrections', () => {
  it('shows old and new, with who and when, to an administrator', async () => {
    await correct(frontDesk, patientId, { name: 'Kavita Sharma' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${patientId}/corrections`,
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(200);
    const [entry] = res.json<{
      corrections: Array<{
        field: string;
        oldValue: string;
        newValue: string;
        correctedBy: { fullName: string };
      }>;
    }>().corrections;

    expect(entry).toMatchObject({
      field: 'name',
      oldValue: 'Kavtia Sharma',
      newValue: 'Kavita Sharma',
    });
    expect(entry?.correctedBy.fullName).toBeTruthy();
  });

  /**
   * The front desk can MAKE a correction and cannot READ the old values. That
   * asymmetry is deliberate: this table holds patient data, so seeing what a
   * record used to say is an audit power, not a clerical one.
   */
  it('refuses a caller without audit:read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${patientId}/corrections`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(403);
  });
});
