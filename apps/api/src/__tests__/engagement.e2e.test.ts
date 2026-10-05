/**
 * The patient's journey outside the building, over HTTP — docs/10.
 *
 * Three promises carry this file:
 *
 *   1. Nothing reaches a patient without COMMUNICATIONS consent, and the
 *      attempt is still on record.
 *   2. The link a patient holds discloses a first name, a token and a wait —
 *      never a surname, UHID or mobile — and the plaintext link is never
 *      stored.
 *   3. A check-in collects an answer and flags rising pain to the clinic. It
 *      never advises.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConsoleMessageChannel } from '../engagement/message-channel.js';
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
let nurse: Session;
let otherFrontDesk: Session;

const DAY = clinicDate(7);

/** Every message the console channel was asked to send, in order. */
let sent: Array<{ to: string; body: string }> = [];

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();

  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  doctor = await login(app, fx.main.slug, 'doctor@main.test');
  nurse = await login(app, fx.main.slug, 'nurse@main.test');
  otherFrontDesk = await login(app, fx.other.slug, 'frontdesk@other.test');

  vi.spyOn(ConsoleMessageChannel.prototype, 'send').mockImplementation(async (to, body) => {
    sent.push({ to, body });
    return { providerRef: `test-${sent.length}` };
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await closeTestApp(app);
});

beforeEach(async () => {
  await resetAppointments();
  await ownerQuery(fx.main.id, `DELETE FROM consent_record WHERE purpose = 'COMMUNICATIONS'`);
  sent = [];
});

// --- helpers ----------------------------------------------------------------

function consent(patientIndex: number, granted = true, session: Session = frontDesk) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/patients/${fx.main.patientIds[patientIndex]}/communications-consent`,
    headers: { cookie: session.cookie },
    payload: { granted },
  });
}

async function book(patientIndex = 0, slotIndex = 0): Promise<string> {
  const day = await app.inject({
    method: 'GET',
    url: `/api/v1/availability?practitionerId=${fx.main.practitionerId}&date=${DAY}`,
    headers: { cookie: frontDesk.cookie },
  });
  const res = await app.inject({
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
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

function linkIn(body: string): string {
  const match = /\/p\/([^\s]+)/.exec(body);
  if (!match?.[1]) throw new Error(`no patient link in: ${body}`);
  return match[1];
}

function openLink(key: string) {
  return app.inject({ method: 'GET', url: `/api/v1/p/${encodeURIComponent(key)}` });
}

/** Book, check in, open, write enough to sign, and set a review with check-ins. */
async function signedWithCheckins(patientIndex = 0) {
  const appointmentId = await book(patientIndex);
  await app.inject({
    method: 'PATCH',
    url: `/api/v1/appointments/${appointmentId}/check-in`,
    headers: { cookie: frontDesk.cookie },
  });
  const opened = await app.inject({
    method: 'POST',
    url: '/api/v1/encounters',
    headers: { cookie: doctor.cookie },
    payload: { appointmentId },
  });
  expect(opened.statusCode).toBe(201);
  const encounterId: string = opened.json().id;

  const updated = await app.inject({
    method: 'PATCH',
    url: `/api/v1/encounters/${encounterId}`,
    headers: { cookie: doctor.cookie },
    payload: {
      chiefComplaint: 'Left knee pain on stairs',
      advice: 'Ice pack twice a day',
      followUpDate: clinicDate(10),
      checkInIntervalDays: 3,
    },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json().checkInIntervalDays).toBe(3);

  const signed = await app.inject({
    method: 'POST',
    url: `/api/v1/encounters/${encounterId}/sign`,
    headers: { cookie: doctor.cookie },
  });
  expect(signed.statusCode).toBe(201);
  return { appointmentId, encounterId };
}

async function recoveryLink(encounterId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/encounters/${encounterId}/send-to-patient`,
    headers: { cookie: doctor.cookie },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().status).toBe('SENT');
  return linkIn(sent.at(-1)!.body);
}

function answer(key: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/p/${encodeURIComponent(key)}/checkin`,
    payload,
  });
}

// --- consent ----------------------------------------------------------------

describe('consent', () => {
  it('sends nothing without it, and records that it did not', async () => {
    const id = await book(0);

    expect(sent).toHaveLength(0);
    const rows = await ownerQuery<{ kind: string; status: string }>(
      fx.main.id,
      `SELECT kind, status FROM outbound_message WHERE appointment_id = $1`,
      [id],
    );
    expect(rows).toEqual([{ kind: 'TOKEN_ISSUED', status: 'SKIPPED_NO_CONSENT' }]);
  });

  it('sends once consent is given, and stops again when it is withdrawn', async () => {
    expect((await consent(0)).statusCode).toBe(200);
    await book(0, 0);
    expect(sent).toHaveLength(1);

    expect((await consent(0, false)).statusCode).toBe(200);
    await book(1, 1); // a different patient, no consent: nothing
    expect(sent).toHaveLength(1);
  });

  it('is recorded only by someone who may record consent', async () => {
    // The doctor role reads consent but does not record it.
    expect((await consent(0, true, doctor)).statusCode).toBe(403);
  });
});

// --- the visit link -----------------------------------------------------------

describe('the live token link', () => {
  it('shows the token and a first name, and never the surname, UHID or mobile', async () => {
    await consent(0);
    await book(0);

    const key = linkIn(sent[0]!.body);
    const res = await openLink(key);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.purpose).toBe('VISIT');
    expect(body.patientFirstName).toBe('Kavita');
    expect(body.visit.token).toBe(1);
    expect(body.visit.doctor.name).toBe('Dr Asha Menon');

    // Asserted against the raw payload, not the fields the page happens to use.
    expect(res.payload).not.toContain('Rane');
    expect(res.payload).not.toContain('9800000001');
    expect(res.payload).not.toContain('T000001');
  });

  it('keeps the link out of the message log — only its hash is stored', async () => {
    await consent(0);
    const id = await book(0);
    const key = linkIn(sent[0]!.body);

    const [row] = await ownerQuery<{ body: string }>(
      fx.main.id,
      `SELECT body FROM outbound_message WHERE appointment_id = $1`,
      [id],
    );
    expect(row!.body).toContain('[patient link]');
    expect(row!.body).not.toContain(key);

    const links = await ownerQuery<{ key_hash: string }>(
      fx.main.id,
      `SELECT key_hash FROM patient_link WHERE appointment_id = $1`,
      [id],
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.key_hash).not.toContain(key.split('.')[1]!);
  });

  it('refuses a tampered key, a malformed one, and one from nowhere, alike', async () => {
    await consent(0);
    await book(0);
    const key = linkIn(sent[0]!.body);

    expect((await openLink(`${key}x`)).statusCode).toBe(401);
    expect((await openLink('not-a-key')).statusCode).toBe(401);
    expect((await openLink(`${fx.other.id}.${key.split('.')[1]}`)).statusCode).toBe(401);
  });

  it('refuses a link that has expired, with a message that says so', async () => {
    await consent(0);
    const id = await book(0);
    const key = linkIn(sent[0]!.body);

    await ownerQuery(
      fx.main.id,
      `UPDATE patient_link SET expires_at = now() - interval '1 minute' WHERE appointment_id = $1`,
      [id],
    );
    const res = await openLink(key);
    expect(res.statusCode).toBe(410);
  });

  it('lets the patient say they are on their way, until they are checked in', async () => {
    await consent(0);
    const id = await book(0);
    const key = linkIn(sent[0]!.body);

    const said = await app.inject({
      method: 'POST',
      url: `/api/v1/p/${encodeURIComponent(key)}/arrival`,
      payload: { intent: 'ON_THE_WAY' },
    });
    expect(said.statusCode).toBe(201);

    const [row] = await ownerQuery<{ arrival_intent: string }>(
      fx.main.id,
      `SELECT arrival_intent FROM appointment WHERE id = $1`,
      [id],
    );
    expect(row!.arrival_intent).toBe('ON_THE_WAY');

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${id}/check-in`,
      headers: { cookie: frontDesk.cookie },
    });
    const late = await app.inject({
      method: 'POST',
      url: `/api/v1/p/${encodeURIComponent(key)}/arrival`,
      payload: { intent: 'RUNNING_LATE' },
    });
    expect(late.statusCode).toBe(409);
  });
});

// --- recovery ---------------------------------------------------------------

describe('recovery check-ins', () => {
  it('are scheduled at signing, every N days, stopping before the review', async () => {
    const { encounterId } = await signedWithCheckins(0);

    const rows = await ownerQuery<{ due_on: string }>(
      fx.main.id,
      `SELECT to_char(due_on, 'YYYY-MM-DD') AS due_on FROM recovery_checkin
        WHERE encounter_id = $1 ORDER BY due_on`,
      [encounterId],
    );
    expect(rows.map((r) => r.due_on)).toEqual([clinicDate(3), clinicDate(6), clinicDate(9)]);
  });

  it('take an answer, refuse a second one the same day, and flag severe pain', async () => {
    await consent(0);
    const { encounterId } = await signedWithCheckins(0);
    const key = await recoveryLink(encounterId);

    const first = await answer(key, { painScore: 6, exercisesDone: true, note: 'Stairs are hard' });
    expect(first.statusCode).toBe(201);
    expect(first.json().clinicWillCall).toBe(false);

    const again = await answer(key, { painScore: 5 });
    expect(again.statusCode).toBe(409);

    // Move the first answer to yesterday, as if a day had passed.
    await ownerQuery(
      fx.main.id,
      `UPDATE recovery_checkin
          SET due_on = due_on - 1, answered_at = answered_at - interval '1 day'
        WHERE encounter_id = $1 AND answered_at IS NOT NULL`,
      [encounterId],
    );

    const worse = await answer(key, { painScore: 8 });
    expect(worse.statusCode).toBe(201);
    expect(worse.json().clinicWillCall).toBe(true);
    // Nothing in the reply that sounds like treatment.
    expect(worse.payload).not.toMatch(/tablet|dose|take /i);

    const panel = await app.inject({
      method: 'GET',
      url: `/api/v1/encounters/${encounterId}/recovery`,
      headers: { cookie: doctor.cookie },
    });
    // The panel shows the PREVIOUS visit's recovery, and this is the first.
    expect(panel.json().recovery).toBeNull();

    const board = await app.inject({
      method: 'GET',
      url: '/api/v1/follow-ups',
      headers: { cookie: frontDesk.cookie },
    });
    expect(board.statusCode).toBe(200);
    const row = board
      .json()
      .rows.find((r: { encounterId: string }) => r.encounterId === encounterId);
    expect(row.status).toBe('FLAGGED');
    expect(row.checkins).toMatchObject({ answered: 2, firstPain: 6, lastPain: 8 });

    const cleared = await app.inject({
      method: 'POST',
      url: `/api/v1/follow-ups/checkins/${row.flag.checkinId}/clear-flag`,
      headers: { cookie: frontDesk.cookie },
    });
    expect(cleared.statusCode).toBe(201);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/follow-ups',
      headers: { cookie: frontDesk.cookie },
    });
    // Cleared, and the review is ten days out — so it leaves this week's board
    // rather than lingering as a flag somebody already dealt with.
    expect(after.json().stats.flagged).toBe(0);
    expect(after.payload).not.toContain(encounterId);
  });

  it('are sent on their day, once, whatever the timer does', async () => {
    await consent(0);
    const { encounterId } = await signedWithCheckins(0);
    await ownerQuery(
      fx.main.id,
      `UPDATE recovery_checkin SET due_on = $2::date
        WHERE encounter_id = $1 AND due_on = (SELECT min(due_on) FROM recovery_checkin WHERE encounter_id = $1)`,
      [encounterId, clinicDate(0)],
    );

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/follow-ups/dispatch-checkins',
      headers: { cookie: frontDesk.cookie },
    });
    expect(first.json().sent).toBe(1);
    expect(sent.at(-1)!.body).toMatch(/How is your pain today\?/);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/follow-ups/dispatch-checkins',
      headers: { cookie: frontDesk.cookie },
    });
    expect(second.json().sent).toBe(0);
  });
});

// --- the follow-up board ------------------------------------------------------

describe('the follow-up board', () => {
  it('shows an overdue review, reminds once, and refuses a second reminder the same day', async () => {
    await consent(0);
    const { encounterId } = await signedWithCheckins(0);
    await ownerQuery(fx.main.id, `UPDATE encounter SET follow_up_date = $2::date WHERE id = $1`, [
      encounterId,
      clinicDate(-2),
    ]);

    const board = await app.inject({
      method: 'GET',
      url: '/api/v1/follow-ups',
      headers: { cookie: frontDesk.cookie },
    });
    const row = board
      .json()
      .rows.find((r: { encounterId: string }) => r.encounterId === encounterId);
    expect(row.status).toBe('OVERDUE');
    expect(row.daysOverdue).toBe(2);
    expect(board.json().stats.overdue).toBeGreaterThanOrEqual(1);

    const remind = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/follow-ups/${encounterId}/remind`,
        headers: { cookie: frontDesk.cookie },
      });
    expect((await remind()).json().status).toBe('SENT');
    expect((await remind()).statusCode).toBe(409);
  });

  it('is read-only for a nurse', async () => {
    const { encounterId } = await signedWithCheckins(0);
    const board = await app.inject({
      method: 'GET',
      url: '/api/v1/follow-ups',
      headers: { cookie: nurse.cookie },
    });
    expect(board.statusCode).toBe(200);

    const remind = await app.inject({
      method: 'POST',
      url: `/api/v1/follow-ups/${encounterId}/remind`,
      headers: { cookie: nurse.cookie },
    });
    expect(remind.statusCode).toBe(403);
  });

  it('never shows another clinic', async () => {
    const { encounterId } = await signedWithCheckins(0);

    const theirs = await app.inject({
      method: 'GET',
      url: '/api/v1/follow-ups',
      headers: { cookie: otherFrontDesk.cookie },
    });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.payload).not.toContain(encounterId);

    const remind = await app.inject({
      method: 'POST',
      url: `/api/v1/follow-ups/${encounterId}/remind`,
      headers: { cookie: otherFrontDesk.cookie },
    });
    expect(remind.statusCode).toBe(404);
  });
});

// --- time to leave ------------------------------------------------------------

describe('time to leave', () => {
  /**
   * A patient at home whose slot has come, with nobody ahead of them. Written
   * straight into today's diary for the same reason display.e2e does: booking
   * "today" through the API passes in the morning and fails after lunch.
   */
  async function atHomeNow(patientIndex: number, minutesUntilSlot: number) {
    const [row] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO appointment
         (tenant_id, patient_id, practitioner_id, location_id, start_at, end_at,
          status, visit_type, source, token_number, queue_date, updated_at)
       VALUES ($1, $2, $3, $4,
               now() + ($5 || ' minutes')::interval,
               now() + ($5 || ' minutes')::interval + interval '15 minutes',
               'BOOKED', 'NEW', 'FRONT_DESK', $6, $7::date, now())
       RETURNING id`,
      [
        fx.main.id,
        fx.main.patientIds[patientIndex],
        fx.main.practitionerId,
        fx.main.locationId,
        String(minutesUntilSlot),
        patientIndex + 1,
        clinicDate(0),
      ],
    );
    return row!.id;
  }

  async function sweep() {
    const { EngagementService } = await import('../engagement/engagement.service.js');
    return app.get(EngagementService).sweep();
  }

  it('tells a patient whose turn is close to set off, once', async () => {
    await consent(0);
    const id = await atHomeNow(0, 5);

    expect((await sweep()).leaveNow).toBe(1);
    expect(sent.at(-1)!.body).toMatch(/^Time to leave, Kavita/);

    const [row] = await ownerQuery<{ leave_now_sent_at: Date | null }>(
      fx.main.id,
      `SELECT leave_now_sent_at FROM appointment WHERE id = $1`,
      [id],
    );
    expect(row!.leave_now_sent_at).not.toBeNull();

    expect((await sweep()).leaveNow).toBe(0);
  });

  it('does not call somebody in hours before their slot', async () => {
    await consent(0);
    await atHomeNow(0, 180);
    expect((await sweep()).leaveNow).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
