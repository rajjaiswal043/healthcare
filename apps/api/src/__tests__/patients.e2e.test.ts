/**
 * The patient record, over HTTP.
 *
 * The detail endpoint assembles demographics, the current consent position and
 * recent visits in one response, so most of what is worth asserting is that the
 * assembly is correct — particularly the consent rule, which is not obvious from
 * the shape: consent records are append-only, so "do they consent" means "what
 * does the most recent row for that purpose say", not "does a row exist".
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  clinicDate,
  closeTestApp,
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
let otherFrontDesk: Session;

const DAY = clinicDate(7);

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();

  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  doctor = await login(app, fx.main.slug, 'doctor@main.test');
  otherFrontDesk = await login(app, fx.other.slug, 'frontdesk@other.test');
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  await resetAppointments();
});

function get(patientId: string, session: Session = frontDesk) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/patients/${patientId}`,
    headers: { cookie: session.cookie },
  });
}

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

describe('the patient record', () => {
  it('returns the demographics the list view leaves out', async () => {
    const res = await get(fx.main.patientIds[0] as string);

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.uhid).toBe('T000001');
    expect(body.name).toBe('Kavita Rane');
    expect(body.mobile).toBe('9800000001');

    // The fields that exist only on this endpoint. A search result stays cheap:
    // widening it would mean every keystroke of a live search pulling addresses
    // and visit history for twenty patients nobody has opened.
    expect(body).toHaveProperty('bloodGroup');
    expect(body).toHaveProperty('emergencyContactName');
    expect(body).toHaveProperty('addressLine');
    expect(body).toHaveProperty('consents');
    expect(body).toHaveProperty('appointments');
    expect(body.isActive).toBe(true);
  });

  it('starts with no visits and an honest zero', async () => {
    const body = (await get(fx.main.patientIds[1] as string)).json();

    expect(body.appointments).toEqual([]);
    expect(body.stats.totalVisits).toBe(0);
    expect(body.stats.completedVisits).toBe(0);
    expect(body.stats.lastVisitAt).toBeNull();
  });

  it('lists visits newest first, with the note when there is one', async () => {
    const appointmentId = await bookAndArrive(0, 0);

    // A second, earlier visit for the same patient with a different doctor is
    // not expressible here (one practitioner per fixture), so this checks the
    // link to the clinical note instead — the reason the list exists at all.
    const encounter = await app.inject({
      method: 'POST',
      url: '/api/v1/encounters',
      headers: { cookie: doctor.cookie },
      payload: { appointmentId },
    });
    expect(encounter.statusCode).toBe(201);

    const body = (await get(fx.main.patientIds[0] as string)).json();

    expect(body.appointments).toHaveLength(1);
    expect(body.appointments[0].id).toBe(appointmentId);
    expect(body.appointments[0].encounterId).toBe(encounter.json().id);
    expect(body.appointments[0].practitioner.fullName).toBe('Asha Menon');
    expect(body.appointments[0].reasonForVisit).toBe('Fever and body ache');
    expect(body.stats.totalVisits).toBe(1);
    // Still in progress, so not yet a completed visit.
    expect(body.stats.completedVisits).toBe(0);
  });

  it('reports no note for a visit that produced none', async () => {
    await bookAndArrive(2, 3);

    const body = (await get(fx.main.patientIds[2] as string)).json();
    expect(body.appointments[0].encounterId).toBeNull();
  });

  it('counts a finished visit and dates it', async () => {
    const appointmentId = await bookAndArrive(0, 0);

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appointmentId}/call`,
      headers: { cookie: frontDesk.cookie },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appointmentId}/complete`,
      headers: { cookie: frontDesk.cookie },
    });

    const body = (await get(fx.main.patientIds[0] as string)).json();
    expect(body.stats.completedVisits).toBe(1);
    expect(body.stats.lastVisitAt).toBeTruthy();
  });
});

describe('consent', () => {
  it('reports the latest decision per purpose, not the first', async () => {
    const patientId = fx.main.patientIds[0] as string;

    // Consent granted, then withdrawn. Both rows survive — withdrawal is a new
    // record, because proving what was agreed and when is the whole point.
    await ownerQuery(
      fx.main.id,
      `INSERT INTO consent_record (tenant_id, patient_id, purpose, granted, notice_version, granted_at)
       VALUES ($1, $2, 'MARKETING', true,  '2026-08-v1', now() - interval '2 days'),
              ($1, $2, 'MARKETING', false, '2026-08-v1', now() - interval '1 day')`,
      [fx.main.id, patientId],
    );

    const body = (await get(patientId)).json();
    const marketing = body.consents.filter((c: { purpose: string }) => c.purpose === 'MARKETING');

    // One current position, and it is the withdrawal.
    expect(marketing).toHaveLength(1);
    expect(marketing[0].granted).toBe(false);

    // And the history is still there underneath it.
    const rows = await ownerQuery(
      fx.main.id,
      `SELECT id FROM consent_record WHERE patient_id = $1 AND purpose = 'MARKETING'`,
      [patientId],
    );
    expect(rows).toHaveLength(2);
  });
});

describe('who may read a patient', () => {
  it('refuses an unauthenticated request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${fx.main.patientIds[0]}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses another clinic’s patient with a 404, not a 403', async () => {
    const res = await get(fx.main.patientIds[0] as string, otherFrontDesk);

    // Under row-level security the row is simply not visible. A 403 would
    // confirm that the id refers to a real patient somewhere, which is exactly
    // what an attacker probing ids is trying to learn.
    expect(res.statusCode).toBe(404);
  });

  it('records every read in the audit trail', async () => {
    const patientId = fx.main.patientIds[0] as string;
    await get(patientId, doctor);

    const rows = await ownerQuery<{ actor_user_id: string; action: string }>(
      fx.main.id,
      `SELECT actor_user_id, action FROM audit_event
        WHERE action = 'patient.view' AND patient_id = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [patientId],
    );

    // FR-P36-19 asks for reads as well as writes. "Who opened this patient's
    // record" is the question that actually gets asked.
    expect(rows[0]?.actor_user_id).toBeTruthy();
  });
});
