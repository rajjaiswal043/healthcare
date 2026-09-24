/**
 * The clinical note, over HTTP.
 *
 * The centre of this file is `a signed consultation cannot be changed`. That
 * property is the whole justification for the module's design — see
 * docs/02-consultation-plan.md section 2.1 — and it is worth exactly as much as
 * the enforcement behind it. A lock implemented as a disabled button is not a
 * lock, so it is asserted here against every write endpoint rather than trusted
 * because the service has an `if`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  clinicDate,
  closeTestApp,
  createDoctor,
  createTestApp,
  login,
  ownerQuery,
  resetAppointments,
  seedFixtures,
  type Fixtures,
  type Session,
} from './harness.js';

let app: NestFastifyApplication;
let fx: Fixtures;
let frontDesk: Session;
let doctor: Session;
let nurse: Session;
let otherDoctor: Session;

const DAY = clinicDate(7);

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();

  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  doctor = await login(app, fx.main.slug, 'doctor@main.test');
  nurse = await login(app, fx.main.slug, 'nurse@main.test');
  otherDoctor = await login(app, fx.other.slug, 'doctor@other.test');
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  await resetAppointments();
});

// --- helpers ----------------------------------------------------------------

async function bookAndArrive(patientIndex = 0, slotIndex = 0): Promise<string> {
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
      reasonForVisit: 'Fever and body ache',
    },
  });

  const id = booked.json().id;

  await app.inject({
    method: 'PATCH',
    url: `/api/v1/appointments/${id}/check-in`,
    headers: { cookie: frontDesk.cookie },
  });

  return id;
}

function open(appointmentId: string, session: Session = doctor) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/encounters',
    headers: { cookie: session.cookie },
    payload: { appointmentId },
  });
}

/** Book, check in, open — the state most tests start from. */
async function openConsultation(patientIndex = 0, slotIndex = 0) {
  const appointmentId = await bookAndArrive(patientIndex, slotIndex);
  const res = await open(appointmentId);
  expect(res.statusCode).toBe(201);
  return { appointmentId, encounter: res.json() };
}

const domainCode = (res: { json: () => { error: { details?: { code?: string } } } }) =>
  res.json().error.details?.code;

// --- opening ----------------------------------------------------------------

describe('opening a consultation', () => {
  it('refuses a patient who has not checked in', async () => {
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
        patientId: fx.main.patientIds[0],
        practitionerId: fx.main.practitionerId,
        locationId: fx.main.locationId,
        startAt: day.json().slots[0].startAt,
      },
    });

    const res = await open(booked.json().id);
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('NOT_ARRIVED');
  });

  /**
   * The clinical half of the X-ray round trip.
   *
   * The note is the reason the visit must not end when the patient walks out:
   * the doctor has already written the complaint and the examination, and if
   * sending for an X-ray closed the encounter, that work would either be lost or
   * be signed prematurely into an immutable record.
   */
  it('keeps the draft note across a trip to X-ray', async () => {
    const { appointmentId, encounter } = await openConsultation();

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { chiefComplaint: 'Fell on outstretched hand' },
    });

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appointmentId}/send-for-tests`,
      headers: { cookie: doctor.cookie },
      payload: { reason: 'X-ray — left wrist' },
    });

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appointmentId}/return`,
      headers: { cookie: frontDesk.cookie },
      payload: { seeNext: true },
    });

    // Reopening resumes the SAME note, still a draft, with the text intact.
    const resumed = await open(appointmentId);
    expect(resumed.statusCode).toBe(201);
    expect(resumed.json().id).toBe(encounter.id);
    expect(resumed.json().status).toBe('IN_PROGRESS');
    expect(resumed.json().chiefComplaint).toBe('Fell on outstretched hand');

    // And resuming calls them back in, so the board does not still show them
    // waiting while they sit in the room.
    const [appointment] = await ownerQuery<{ status: string }>(
      fx.main.id,
      `SELECT status FROM appointment WHERE id = $1`,
      [appointmentId],
    );
    expect(appointment?.status).toBe('IN_PROGRESS');
  });

  it('lets the doctor sign off a patient who never came back', async () => {
    const { appointmentId, encounter } = await openConsultation();

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { chiefComplaint: 'Wrist pain after a fall' },
    });

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appointmentId}/send-for-tests`,
      headers: { cookie: doctor.cookie },
      payload: { reason: 'X-ray — left wrist' },
    });

    // They went home instead. Without this the visit sits open forever, holding
    // a note nobody can finish and inflating the day's counts.
    const signed = await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/sign`,
      headers: { cookie: doctor.cookie },
    });

    expect(signed.statusCode).toBe(201);
    expect(signed.json().status).toBe('SIGNED');

    const [appointment] = await ownerQuery<{ status: string }>(
      fx.main.id,
      `SELECT status FROM appointment WHERE id = $1`,
      [appointmentId],
    );
    expect(appointment?.status).toBe('FULFILLED');
  });

  it('calls the patient in as a side effect', async () => {
    const { appointmentId, encounter } = await openConsultation();

    expect(encounter.status).toBe('IN_PROGRESS');
    expect(encounter.patient.uhid).toBe('T000001');

    // Opening the consultation IS calling the patient in. Making the doctor
    // press two buttons on two screens is bookkeeping the software should do.
    const [appointment] = await ownerQuery<{ status: string; called_at: Date | null }>(
      fx.main.id,
      `SELECT status, called_at FROM appointment WHERE id = $1`,
      [appointmentId],
    );
    expect(appointment?.status).toBe('IN_PROGRESS');
    expect(appointment?.called_at).toBeInstanceOf(Date);
  });

  it('resumes the same draft rather than starting a second', async () => {
    const appointmentId = await bookAndArrive();

    const first = await open(appointmentId);
    const second = await open(appointmentId);

    // A double-click must not produce two half-written notes with no way to tell
    // which is real.
    expect(second.json().id).toBe(first.json().id);

    const rows = await ownerQuery(
      fx.main.id,
      `SELECT id FROM encounter WHERE appointment_id = $1`,
      [appointmentId],
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a cancelled appointment', async () => {
    const appointmentId = await bookAndArrive();

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appointmentId}/cancel`,
      headers: { cookie: frontDesk.cookie },
      payload: { reason: 'Patient unwell' },
    });

    const res = await open(appointmentId);
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('NOT_CONSULTABLE');
  });
});

// --- recording --------------------------------------------------------------

describe('recording the visit', () => {
  it('saves the narrative', async () => {
    const { encounter } = await openConsultation();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: {
        chiefComplaint: 'Fever for three days',
        historyOfPresentIllness: 'Intermittent, worse at night. No travel history.',
        examinationFindings: 'Throat congested. Chest clear.',
        advice: 'Plenty of fluids. Return if fever persists beyond 48 hours.',
        followUpDate: clinicDate(14),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().chiefComplaint).toBe('Fever for three days');
    expect(String(res.json().followUpDate)).toContain(clinicDate(14));
  });

  it('derives BMI without storing it', async () => {
    const { encounter } = await openConsultation();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/vitals`,
      headers: { cookie: nurse.cookie },
      payload: {
        heightCm: 170,
        weightKg: 72.5,
        systolicMmHg: 128,
        diastolicMmHg: 82,
        pulseBpm: 88,
        temperatureC: 38.4,
        spo2Percent: 97,
      },
    });

    expect(res.statusCode).toBe(201);

    const latest = res.json().latestVitals;
    // 72.5 / 1.70^2 = 25.09...
    expect(latest.bmi).toBe(25.1);
    expect(latest.heightCm).toBe(170);
    expect(latest.temperatureC).toBe(38.4);

    // Derived at read time. Storing it means two numbers that disagree the
    // moment either input is corrected.
    const columns = await ownerQuery<{ column_name: string }>(
      fx.main.id,
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'vitals_observation' AND column_name ILIKE '%bmi%'`,
    );
    expect(columns).toHaveLength(0);
  });

  it('rejects an impossible reading', async () => {
    const { encounter } = await openConsultation();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/vitals`,
      headers: { cookie: nurse.cookie },
      payload: { weightKg: 700 },
    });

    expect(res.statusCode).toBe(400);
  });

  it('makes the first diagnosis primary when none is marked', async () => {
    const { encounter } = await openConsultation();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/encounters/${encounter.id}/diagnoses`,
      headers: { cookie: doctor.cookie },
      payload: {
        diagnoses: [
          { code: 'J06.9', display: 'Upper respiratory tract infection' },
          { code: 'R50.9', display: 'Fever, unspecified' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);

    const diagnoses = res.json().diagnoses;
    expect(diagnoses.filter((d: { isPrimary: boolean }) => d.isPrimary)).toHaveLength(1);
    expect(diagnoses[0].code).toBe('J06.9');
    expect(diagnoses[0].codeSystem).toBe('ICD-10');
  });

  it('keeps exactly one primary even when two are marked', async () => {
    const { encounter } = await openConsultation();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/encounters/${encounter.id}/diagnoses`,
      headers: { cookie: doctor.cookie },
      payload: {
        diagnoses: [
          { code: 'J06.9', display: 'URTI', isPrimary: true },
          { code: 'R50.9', display: 'Fever', isPrimary: true },
        ],
      },
    });

    // The partial unique index would reject two; the service settles it first so
    // the doctor gets a saved note rather than a database error.
    expect(res.statusCode).toBe(200);
    expect(res.json().diagnoses.filter((d: { isPrimary: boolean }) => d.isPrimary)).toHaveLength(1);
  });

  it('honours a primary marked on something other than the first entry', async () => {
    const { encounter } = await openConsultation();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/encounters/${encounter.id}/diagnoses`,
      headers: { cookie: doctor.cookie },
      payload: {
        diagnoses: [
          { code: 'R50.9', display: 'Fever' },
          { code: 'J06.9', display: 'URTI', isPrimary: true },
        ],
      },
    });

    /**
     * The "Set primary" case, and the reason it is its own test.
     *
     * The two tests above both pass against an implementation that always makes
     * entry zero primary — one marks nothing, the other marks the first. Only
     * promoting a LATER entry distinguishes correct from nearly-correct, and the
     * first implementation failed exactly here: the button appeared to do
     * nothing, because index 0 reclaimed the flag before the loop reached the
     * row the doctor picked.
     */
    const primary = res.json().diagnoses.filter((d: { isPrimary: boolean }) => d.isPrimary);
    expect(primary).toHaveLength(1);
    expect(primary[0].code).toBe('J06.9');
  });

  it('replaces the diagnosis list rather than appending to it', async () => {
    const { encounter } = await openConsultation();
    const url = `/api/v1/encounters/${encounter.id}/diagnoses`;

    await app.inject({
      method: 'PUT',
      url,
      headers: { cookie: doctor.cookie },
      payload: { diagnoses: [{ code: 'J06.9', display: 'URTI' }] },
    });

    const res = await app.inject({
      method: 'PUT',
      url,
      headers: { cookie: doctor.cookie },
      payload: { diagnoses: [{ code: 'A09', display: 'Gastroenteritis' }] },
    });

    expect(res.json().diagnoses).toHaveLength(1);
    expect(res.json().diagnoses[0].code).toBe('A09');
  });

  it('records a structured prescription', async () => {
    const { encounter } = await openConsultation();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/encounters/${encounter.id}/prescriptions`,
      headers: { cookie: doctor.cookie },
      payload: {
        prescriptions: [
          {
            drugName: 'Dolo 650',
            strength: '650 mg',
            form: 'TABLET',
            dose: '1 tablet',
            frequency: '1-0-1',
            durationDays: 5,
            instructions: 'After food',
          },
          {
            drugName: 'Azithral 500',
            strength: '500 mg',
            form: 'TABLET',
            dose: '1 tablet',
            frequency: '0-1-0',
            durationDays: 3,
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);

    const items = res.json().prescriptions;
    expect(items).toHaveLength(2);
    // Order is the doctor's, and it is preserved.
    expect(items.map((p: { drugName: string }) => p.drugName)).toEqual([
      'Dolo 650',
      'Azithral 500',
    ]);
    expect(items[0].route).toBe('ORAL');
    expect(items[0].durationDays).toBe(5);
  });

  it('refuses a prescription with neither a duration nor a quantity', async () => {
    const { encounter } = await openConsultation();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/encounters/${encounter.id}/prescriptions`,
      headers: { cookie: doctor.cookie },
      payload: {
        prescriptions: [{ drugName: 'Dolo 650', dose: '1 tablet', frequency: '1-0-1' }],
      },
    });

    // The pharmacist has to know how much. "As directed" is not a quantity.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('duration');
  });

  it('adds a typed-in drug to the clinic’s formulary', async () => {
    const { encounter } = await openConsultation();

    await app.inject({
      method: 'PUT',
      url: `/api/v1/encounters/${encounter.id}/prescriptions`,
      headers: { cookie: doctor.cookie },
      payload: {
        prescriptions: [
          {
            drugName: 'Zzyxil Forte',
            strength: '250 mg',
            dose: '1 tablet',
            frequency: '1-0-1',
            durationDays: 5,
          },
        ],
      },
    });

    // This is how the list grows into what the clinic actually prescribes,
    // instead of staying whatever we seeded.
    const [row] = await ownerQuery<{ name: string; is_custom: boolean }>(
      fx.main.id,
      `SELECT name, is_custom FROM formulary_item WHERE name = $1`,
      ['Zzyxil Forte'],
    );
    expect(row?.is_custom).toBe(true);

    // And it is the clinic's own list, not everyone's.
    const theirs = await ownerQuery(
      fx.other.id,
      `SELECT name FROM formulary_item WHERE name = $1`,
      ['Zzyxil Forte'],
    );
    expect(theirs).toHaveLength(0);
  });
});

// --- signing ----------------------------------------------------------------

describe('signing', () => {
  it('refuses to sign an empty note', async () => {
    const { encounter } = await openConsultation();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/sign`,
      headers: { cookie: doctor.cookie },
    });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('NOTHING_TO_SIGN');
  });

  it('signs, attributes, and closes the visit', async () => {
    const { appointmentId, encounter } = await openConsultation();

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { chiefComplaint: 'Fever for three days' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/sign`,
      headers: { cookie: doctor.cookie },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('SIGNED');
    expect(res.json().signedAt).toBeTruthy();
    expect(res.json().signedByUserId).toBeTruthy();

    // The visit is over. Asking the doctor to close it separately is how a queue
    // ends the day full of patients who were seen an hour ago.
    const [appointment] = await ownerQuery<{ status: string }>(
      fx.main.id,
      `SELECT status FROM appointment WHERE id = $1`,
      [appointmentId],
    );
    expect(appointment?.status).toBe('FULFILLED');
  });

  it('a signed consultation cannot be changed', async () => {
    const { encounter } = await openConsultation();

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { chiefComplaint: 'Fever for three days' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/sign`,
      headers: { cookie: doctor.cookie },
    });

    /**
     * Every write path, not a representative one.
     *
     * The lock lives in `loadDraft`, and the value of routing every mutation
     * through it is precisely that a new endpoint cannot forget the check. This
     * test is what turns that from an intention into a fact — add a write
     * endpoint that skips it and this fails.
     */
    const attempts: Array<[string, string, Record<string, unknown> | undefined]> = [
      ['PATCH', '', { chiefComplaint: 'Changed my mind' }],
      ['POST', '/vitals', { pulseBpm: 70 }],
      ['PUT', '/diagnoses', { diagnoses: [{ code: 'A09', display: 'Gastroenteritis' }] }],
      [
        'PUT',
        '/prescriptions',
        {
          prescriptions: [
            { drugName: 'Dolo 650', dose: '1 tablet', frequency: '1-0-1', durationDays: 3 },
          ],
        },
      ],
      ['POST', '/sign', undefined],
    ];

    for (const [method, suffix, payload] of attempts) {
      const res = await app.inject({
        method: method as 'PATCH' | 'POST' | 'PUT',
        url: `/api/v1/encounters/${encounter.id}${suffix}`,
        headers: { cookie: doctor.cookie },
        ...(payload ? { payload } : {}),
      });

      expect(res.statusCode, `${method} ${suffix || '(narrative)'} after signing`).toBe(409);
      expect(domainCode(res), `${method} ${suffix || '(narrative)'} after signing`).toBe(
        'ALREADY_SIGNED',
      );
    }

    // And the record is genuinely untouched.
    const [row] = await ownerQuery<{ chief_complaint: string }>(
      fx.main.id,
      `SELECT chief_complaint FROM encounter WHERE id = $1`,
      [encounter.id],
    );
    expect(row?.chief_complaint).toBe('Fever for three days');
  });

  it('the database refuses a signature with no author', async () => {
    const { encounter } = await openConsultation();

    // Belt and braces with the service. The constraint is what holds if a future
    // code path sets one field and forgets the other.
    await expect(
      ownerQuery(
        fx.main.id,
        `UPDATE encounter SET status = 'SIGNED', signed_at = now() WHERE id = $1`,
        [encounter.id],
      ),
    ).rejects.toThrow(/encounter_signature_complete/);
  });
});

// --- addenda ----------------------------------------------------------------

describe('correcting a signed note', () => {
  async function signedEncounter() {
    const { encounter } = await openConsultation();
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { chiefComplaint: 'Fever for three days' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/sign`,
      headers: { cookie: doctor.cookie },
    });
    return encounter.id as string;
  }

  it('appends an attributed addendum', async () => {
    const id = await signedEncounter();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${id}/addenda`,
      headers: { cookie: doctor.cookie },
      payload: { text: 'Blood report received after the visit — Hb 9.2, iron deficiency likely.' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().addenda).toHaveLength(1);
    // The author's name is captured at write time. Their user record may be
    // renamed; who wrote this did not change.
    expect(res.json().addenda[0].authorLabel).toBe('Dr Asha Menon');
  });

  it('refuses an addendum on a draft', async () => {
    const { encounter } = await openConsultation();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/addenda`,
      headers: { cookie: doctor.cookie },
      payload: { text: 'Something worth noting' },
    });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('NOT_SIGNED');
  });

  it('cannot be edited or deleted, by anyone', async () => {
    const id = await signedEncounter();
    await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${id}/addenda`,
      headers: { cookie: doctor.cookie },
      payload: { text: 'Original wording' },
    });

    // The application role is granted SELECT and INSERT on this table and
    // nothing else, so an addendum is append-only regardless of what the service
    // layer does. This asserts the grant, which is the guarantee that survives a
    // bug in the code above it.
    const grants = await ownerQuery<{ privilege_type: string }>(
      fx.main.id,
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'encounter_addendum' AND grantee = 'healthcloud_app'`,
    );

    const privileges = grants.map((g) => g.privilege_type).sort();
    expect(privileges).toEqual(['INSERT', 'SELECT']);
  });
});

// --- permissions ------------------------------------------------------------

describe('who may do what', () => {
  it('lets a nurse record vitals but not write the note', async () => {
    const { encounter } = await openConsultation();

    const vitals = await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/vitals`,
      headers: { cookie: nurse.cookie },
      payload: { pulseBpm: 78 },
    });
    expect(vitals.statusCode).toBe(201);

    const narrative = await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: nurse.cookie },
      payload: { chiefComplaint: 'Not the nurse’s to write' },
    });
    expect(narrative.statusCode).toBe(403);
    expect(narrative.json().error.message).toContain('consultation:write');

    const prescribing = await app.inject({
      method: 'PUT',
      url: `/api/v1/encounters/${encounter.id}/prescriptions`,
      headers: { cookie: nurse.cookie },
      payload: {
        prescriptions: [
          { drugName: 'Dolo 650', dose: '1 tablet', frequency: '1-0-1', durationDays: 3 },
        ],
      },
    });
    expect(prescribing.statusCode).toBe(403);
    expect(prescribing.json().error.message).toContain('prescription:write');
  });

  it('keeps the clinical note away from the front desk', async () => {
    const { encounter } = await openConsultation();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: frontDesk.cookie },
    });

    // A receptionist books, checks in and cancels. They have no business reading
    // what the doctor wrote, and "they could see it over the shoulder anyway" is
    // not a reason to grant it in the model.
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('consultation:read');
  });

  it('records who read the note', async () => {
    const { encounter } = await openConsultation();

    await app.inject({
      method: 'GET',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
    });

    // FR-P36-19 asks for reads, not only writes. "Who opened this record" is the
    // question that actually gets asked, usually by a lawyer.
    const rows = await ownerQuery<{ actor_user_id: string }>(
      fx.main.id,
      `SELECT actor_user_id FROM audit_event
        WHERE action = 'encounter.read' AND resource_id = $1`,
      [encounter.id],
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.actor_user_id).toBeTruthy();
  });
});

// --- ownership --------------------------------------------------------------

/**
 * A consultation belongs to the doctor the patient is booked with.
 *
 * This was the gap: `consultation:write` said what KIND of work someone does
 * and nothing about whose patient it is, so any doctor in the clinic could open,
 * write and sign any colleague's note. The only ownership tests that existed
 * were across TENANTS, where row-level security refuses the request long before
 * this code runs — so they passed throughout, and proved nothing about the rule.
 *
 * Everything here is deliberately WITHIN one tenant, which is the only place the
 * check can be observed at all.
 */
describe('whose consultation you may touch', () => {
  let colleague: Session;

  beforeAll(async () => {
    colleague = (
      await createDoctor(app, fx.main, {
        email: 'colleague@main.test',
        fullName: 'Dr Other Consultant',
        linked: true,
      })
    ).session;
  });

  it('refuses another doctor opening the appointment', async () => {
    const appointmentId = await bookAndArrive();

    const res = await open(appointmentId, colleague);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/belongs to another doctor/i);
  });

  /**
   * Opening is not a read — it calls the patient in. So a refused open must
   * also leave the appointment where it was, or the colleague has moved
   * somebody else's patient into a room by failing.
   */
  it('does not call the patient in when it refuses', async () => {
    const appointmentId = await bookAndArrive();

    await open(appointmentId, colleague);

    const [row] = await ownerQuery<{ status: string; called_at: Date | null }>(
      fx.main.id,
      'SELECT status, called_at FROM appointment WHERE id = $1',
      [appointmentId],
    );
    expect(row?.status).toBe('ARRIVED');
    expect(row?.called_at).toBeNull();
  });

  it('refuses another doctor writing the note, diagnoses or prescriptions', async () => {
    const { encounter } = await openConsultation();

    const narrative = await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: colleague.cookie },
      payload: { chiefComplaint: 'Not mine to write' },
    });
    expect(narrative.statusCode).toBe(403);

    const diagnoses = await app.inject({
      method: 'PUT',
      url: `/api/v1/encounters/${encounter.id}/diagnoses`,
      headers: { cookie: colleague.cookie },
      payload: { diagnoses: [{ code: 'R50.9', display: 'Fever', isPrimary: true }] },
    });
    expect(diagnoses.statusCode).toBe(403);

    const prescriptions = await app.inject({
      method: 'PUT',
      url: `/api/v1/encounters/${encounter.id}/prescriptions`,
      headers: { cookie: colleague.cookie },
      payload: {
        prescriptions: [
          { drugName: 'Dolo 650', dose: '1 tablet', frequency: '1-0-1', durationDays: 3 },
        ],
      },
    });
    expect(prescriptions.statusCode).toBe(403);
  });

  it('refuses another doctor signing the note', async () => {
    const { encounter } = await openConsultation();

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { chiefComplaint: 'Fever for three days' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/sign`,
      headers: { cookie: colleague.cookie },
    });

    expect(res.statusCode).toBe(403);

    const [row] = await ownerQuery<{ status: string }>(
      fx.main.id,
      'SELECT status FROM encounter WHERE id = $1',
      [encounter.id],
    );
    // The draft status is IN_PROGRESS; SIGNED is what must not have happened.
    expect(row?.status).toBe('IN_PROGRESS');
  });

  /**
   * An addendum is a correction to a signed record, in the signer's name. It
   * takes a different path from every other write — signed notes never reach
   * `loadDraft` — so it gets its own assertion rather than being assumed.
   */
  it('refuses another doctor adding an addendum', async () => {
    const { encounter } = await openConsultation();

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { chiefComplaint: 'Fever for three days' },
    });
    const signed = await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/sign`,
      headers: { cookie: doctor.cookie },
    });
    expect(signed.statusCode).toBe(201);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/addenda`,
      headers: { cookie: colleague.cookie },
      payload: { text: 'Not my note to correct.' },
    });

    expect(res.statusCode).toBe(403);
  });

  /**
   * A doctor account with no `practitioner` row is nobody, not everybody. This
   * is the account state the bug report arrived from: a doctor created in the
   * console whose Doctors-and-hours setup had not been done.
   */
  it('refuses a doctor whose account is not linked to a practitioner', async () => {
    const appointmentId = await bookAndArrive();
    const unlinked = (
      await createDoctor(app, fx.main, {
        email: 'unlinked-consult@main.test',
        fullName: 'Dr Not Linked Yet',
        linked: false,
      })
    ).session;

    const res = await open(appointmentId, unlinked);
    expect(res.statusCode).toBe(403);
  });

  // --- and the regressions, which matter as much ----------------------------

  it('lets the booked doctor open, write and sign as before', async () => {
    const { encounter } = await openConsultation();

    const narrative = await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { chiefComplaint: 'Fever for three days' },
    });
    expect(narrative.statusCode).toBe(200);

    const signed = await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/sign`,
      headers: { cookie: doctor.cookie },
    });
    expect(signed.statusCode).toBe(201);

    const addendum = await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/addenda`,
      headers: { cookie: doctor.cookie },
      payload: { text: 'Patient called back; advised rest.' },
    });
    expect(addendum.statusCode).toBe(201);
  });

  /**
   * The workflow the strict rule most easily breaks, and must not: vitals are
   * the NURSE's, on whoever's patient is in the room. A nurse is not a
   * practitioner and never will be, so a rule written as "only the treating
   * doctor may write to an encounter" would have taken this with it.
   */
  it('still lets a nurse record vitals on another’s encounter', async () => {
    const { encounter } = await openConsultation();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/vitals`,
      headers: { cookie: nurse.cookie },
      payload: { pulseBpm: 78 },
    });

    expect(res.statusCode).toBe(201);
  });

  /**
   * Same patient, two doctors, one day — confirmed intended behaviour. Each
   * doctor owns their OWN visit; ownership is per appointment, not per patient,
   * and a rule keyed on the patient would have made the second consultation
   * impossible.
   */
  it('lets two doctors each hold their own visit for the same patient', async () => {
    const mine = await openConsultation(1, 0);

    const colleaguePractitionerId = (
      await ownerQuery<{ id: string }>(
        fx.main.id,
        `SELECT p.id FROM practitioner p
           JOIN app_user u ON u.id = p.user_id
          WHERE p.tenant_id = $1 AND u.email = 'colleague@main.test'`,
        [fx.main.id],
      )
    )[0]!.id;

    // The colleague's own appointment for the SAME patient, the same day.
    const day = await app.inject({
      method: 'GET',
      url: `/api/v1/availability?practitionerId=${colleaguePractitionerId}&date=${DAY}`,
      headers: { cookie: frontDesk.cookie },
    });
    const booked = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: { cookie: frontDesk.cookie },
      payload: {
        patientId: fx.main.patientIds[1],
        practitionerId: colleaguePractitionerId,
        locationId: fx.main.locationId,
        startAt: day.json().slots[0].startAt,
      },
    });
    expect(booked.statusCode).toBe(201);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${booked.json().id}/check-in`,
      headers: { cookie: frontDesk.cookie },
    });

    const theirs = await open(booked.json().id, colleague);
    expect(theirs.statusCode).toBe(201);
    expect(theirs.json().id).not.toBe(mine.encounter.id);

    // And neither can reach into the other's.
    expect((await open(mine.appointmentId, colleague)).statusCode).toBe(403);
    expect((await open(booked.json().id, doctor)).statusCode).toBe(403);
  });
});

// --- tenant isolation -------------------------------------------------------

describe('one clinic cannot read another’s notes', () => {
  it('refuses to open another clinic’s appointment', async () => {
    const appointmentId = await bookAndArrive();

    const res = await open(appointmentId, otherDoctor);
    expect(res.statusCode).toBe(404);
  });

  it('refuses to read another clinic’s consultation', async () => {
    const { encounter } = await openConsultation();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: otherDoctor.cookie },
    });

    expect(res.statusCode).toBe(404);
  });
});

// --- reference data and history ---------------------------------------------

describe('reference data', () => {
  it('ranks the obvious diagnosis first', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnosis-codes?q=fever',
      headers: { cookie: doctor.cookie },
    });

    expect(res.statusCode).toBe(200);
    // A doctor typing "fever" wants R50.9, not "Typhoid fever" or "Dengue fever"
    // — a plain substring match returns those first.
    expect(res.json().codes[0].code).toBe('R50.9');
  });

  it('finds a diagnosis by its code', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnosis-codes?q=E11',
      headers: { cookie: doctor.cookie },
    });

    expect(res.json().codes[0].code).toBe('E11.9');
  });

  it('finds a drug by its generic name', async () => {
    // The formulary starts empty in tests; add one the way a doctor would.
    const { encounter } = await openConsultation();
    await app.inject({
      method: 'PUT',
      url: `/api/v1/encounters/${encounter.id}/prescriptions`,
      headers: { cookie: doctor.cookie },
      payload: {
        prescriptions: [
          {
            drugName: 'Dolo 650',
            strength: '650 mg',
            dose: '1 tablet',
            frequency: '1-0-1',
            durationDays: 3,
          },
        ],
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/formulary?q=dolo',
      headers: { cookie: doctor.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].name).toBe('Dolo 650');
  });
});

describe('patient history', () => {
  it('lists past consultations with their primary diagnosis', async () => {
    const { encounter } = await openConsultation();

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { chiefComplaint: 'Fever for three days' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/encounters/${encounter.id}/diagnoses`,
      headers: { cookie: doctor.cookie },
      payload: { diagnoses: [{ code: 'J06.9', display: 'URTI' }] },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/sign`,
      headers: { cookie: doctor.cookie },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${fx.main.patientIds[0]}/encounters`,
      headers: { cookie: doctor.cookie },
    });

    expect(res.statusCode).toBe(200);
    const [first] = res.json().encounters;
    expect(first.status).toBe('SIGNED');
    expect(first.chiefComplaint).toBe('Fever for three days');
    expect(first.diagnoses[0].code).toBe('J06.9');
  });
});

/**
 * FR-CON-11 — the prescription note.
 *
 * A second printed block, for what is not advice to the patient. The tests that
 * matter are the two boundaries: it is bounded at 1000 characters in three
 * places (screen, DTO, database CHECK), and it is part of the signed record, so
 * it stops being writable the moment the consultation is signed.
 */
describe('the prescription note', () => {
  const NOTE = 'Physiotherapy from Monday. No squatting for six weeks.';

  it('saves and reads back, alongside advice rather than instead of it', async () => {
    const { encounter } = await openConsultation();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: {
        advice: 'Rest the knee. Ice twice daily.',
        prescriptionNote: NOTE,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().prescriptionNote).toBe(NOTE);
    // Both, and distinct. Merging them was the cheaper design and the wrong one.
    expect(res.json().advice).toBe('Rest the knee. Ice twice daily.');
  });

  it('survives a reload', async () => {
    const { encounter } = await openConsultation();

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { prescriptionNote: NOTE },
    });

    const reread = await app.inject({
      method: 'GET',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
    });

    expect(reread.json().prescriptionNote).toBe(NOTE);
  });

  it('accepts exactly 1000 characters and refuses 1001', async () => {
    const { encounter } = await openConsultation();

    const atLimit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { prescriptionNote: 'x'.repeat(1000) },
    });
    expect(atLimit.statusCode).toBe(200);

    const overLimit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { prescriptionNote: 'x'.repeat(1001) },
    });
    expect(overLimit.statusCode).toBe(400);
  });

  it('can be cleared', async () => {
    const { encounter } = await openConsultation();

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { prescriptionNote: NOTE },
    });

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { prescriptionNote: '' },
    });

    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().prescriptionNote).toBe('');
  });

  /**
   * The immutability that matters. A prescription is dispensed against; a note
   * on it that can be rewritten after signing is not a record. The correction
   * path is an addendum, exactly as for every other field.
   */
  it('cannot be changed once the consultation is signed', async () => {
    const { encounter } = await openConsultation();

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { chiefComplaint: 'Knee pain', prescriptionNote: NOTE },
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/sign`,
      headers: { cookie: doctor.cookie },
    });

    const afterSigning = await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { prescriptionNote: 'Rewritten after the fact' },
    });

    expect(afterSigning.statusCode).toBeGreaterThanOrEqual(400);

    const reread = await app.inject({
      method: 'GET',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
    });
    expect(reread.json().prescriptionNote).toBe(NOTE);
  });
});

/**
 * FR-P36-23 — what happened last time, read from inside the current visit.
 *
 * The properties that matter: only SIGNED visits count (a half-written draft is
 * not history), only visits BEFORE this one, and the medicines come back with
 * their dose rather than as a count — a count is what the patient record already
 * gives and is not something a doctor can act on.
 */
describe('the previous visit', () => {
  async function signedVisitFor(patientIndex: number, complaint: string) {
    const { encounter } = await openConsultation(patientIndex);

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      headers: { cookie: doctor.cookie },
      payload: { chiefComplaint: complaint, advice: 'Rest' },
    });

    await app.inject({
      method: 'PUT',
      url: `/api/v1/encounters/${encounter.id}/prescriptions`,
      headers: { cookie: doctor.cookie },
      payload: {
        prescriptions: [
          {
            drugName: 'Tab Ultracet',
            strength: '37.5mg',
            dose: '1 tablet',
            frequency: '1-0-1',
            durationDays: 5,
          },
        ],
      },
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/sign`,
      headers: { cookie: doctor.cookie },
    });

    return encounter.id;
  }

  it('is empty on a first visit', async () => {
    const { encounter } = await openConsultation(2);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/encounters/${encounter.id}/previous-visits`,
      headers: { cookie: doctor.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ visits: unknown[] }>().visits).toHaveLength(0);
  });

  it('names the medicines with their dose, not a count', async () => {
    await signedVisitFor(0, 'Knee pain');
    const { encounter: today } = await openConsultation(0, 1);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/encounters/${today.id}/previous-visits`,
      headers: { cookie: doctor.cookie },
    });

    const visits = res.json<{
      visits: Array<{
        chiefComplaint: string;
        prescriptions: Array<{ drugName: string; dose: string; frequency: string }>;
      }>;
    }>().visits;

    expect(visits).toHaveLength(1);
    expect(visits[0]?.chiefComplaint).toBe('Knee pain');
    expect(visits[0]?.prescriptions[0]).toMatchObject({
      drugName: 'Tab Ultracet',
      dose: '1 tablet',
      frequency: '1-0-1',
    });
  });

  /**
   * A draft is somebody's unfinished thinking. Showing it in a later
   * consultation would put it in front of a doctor as though it were a record.
   *
   * The earlier visit is pushed back to IN_PROGRESS directly rather than by
   * leaving a real one unsigned: an unsigned visit keeps its patient in the
   * queue, so the patient cannot then be checked in for the second visit this
   * test needs. What is under test is the status filter, and this exercises it
   * without fighting the queue rules.
   */
  it('ignores an unsigned visit', async () => {
    const earlier = await signedVisitFor(1, 'Signed then unsigned');
    const { encounter: today } = await openConsultation(1, 1);

    const before = await app.inject({
      method: 'GET',
      url: `/api/v1/encounters/${today.id}/previous-visits`,
      headers: { cookie: doctor.cookie },
    });
    expect(before.json<{ visits: unknown[] }>().visits).toHaveLength(1);

    await ownerQuery(
      fx.main.id,
      `UPDATE encounter SET status = 'IN_PROGRESS', signed_at = NULL, signed_by_user_id = NULL
        WHERE id = $1`,
      [earlier],
    );

    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/encounters/${today.id}/previous-visits`,
      headers: { cookie: doctor.cookie },
    });

    expect(after.json<{ visits: unknown[] }>().visits).toHaveLength(0);
  });

  it('does not leak another clinic history', async () => {
    const { encounter } = await openConsultation(0);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/encounters/${encounter.id}/previous-visits`,
      headers: { cookie: otherDoctor.cookie },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
