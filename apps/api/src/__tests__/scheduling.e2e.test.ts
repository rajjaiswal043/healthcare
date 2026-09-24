/**
 * Scheduling and the OPD queue, over HTTP.
 *
 * Three of the bugs this module shipped with were invisible to a unit test and
 * to curl, and each has a test here that fails without its fix:
 *
 *   - Timestamps read back from PostgreSQL in the session timezone rather than
 *     UTC, so booked slots still showed as free. `takes the slot out of
 *     availability` is that test, and it is the reason availability is asserted
 *     after every booking rather than trusted.
 *   - Permission strings drifted between the API and the seed, so every
 *     endpoint returned 403. Roles here come from the shared definition, so a
 *     drift breaks the suite instead of the product.
 *   - A bodyless PATCH was refused before any handler ran.
 *
 * The domain error code lives at `error.details.code`; the top-level
 * `error.code` is the HTTP status name. See AllExceptionsFilter.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  clinicDate,
  createDoctor,
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
let nurse: Session;
let doctor: Session;
let otherFrontDesk: Session;

/** The clinic day every test books into. The doctor sits every weekday. */
const DAY = clinicDate(7);

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();

  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  nurse = await login(app, fx.main.slug, 'nurse@main.test');
  doctor = await login(app, fx.main.slug, 'doctor@main.test');
  otherFrontDesk = await login(app, fx.other.slug, 'frontdesk@other.test');
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  // Each test starts with an empty diary. Tests that share booked state read as
  // passing until someone reorders them.
  await resetAppointments();
});

// --- helpers ----------------------------------------------------------------

interface Slot {
  time: string;
  startAt: string;
  capacity: number;
  booked: number;
  available: number;
}

async function availability(
  session: Session,
  practitionerId = fx.main.practitionerId,
  date = DAY,
): Promise<{ slots: Slot[]; timezone: string; unavailableReason: string | null }> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/availability?practitionerId=${practitionerId}&date=${date}`,
    headers: { cookie: session.cookie },
  });

  expect(res.statusCode).toBe(200);
  return res.json();
}

async function book(
  session: Session,
  options: { patientIndex?: number; slotIndex?: number; startAt?: string } = {},
) {
  const startAt =
    options.startAt ??
    (await availability(session)).slots[options.slotIndex ?? 0]?.startAt ??
    (() => {
      throw new Error('no slot to book');
    })();

  return app.inject({
    method: 'POST',
    url: '/api/v1/appointments',
    headers: { cookie: session.cookie },
    payload: {
      patientId: fx.main.patientIds[options.patientIndex ?? 0],
      practitionerId: fx.main.practitionerId,
      locationId: fx.main.locationId,
      departmentId: fx.main.departmentId,
      startAt,
      reasonForVisit: 'Fever for three days',
    },
  });
}

const domainCode = (res: { json: () => { error: { details?: { code?: string } } } }) =>
  res.json().error.details?.code;

// --- availability -----------------------------------------------------------

describe('availability', () => {
  it('derives slots from the weekly template', async () => {
    const day = await availability(frontDesk);

    // 09:00–12:00 in 15-minute slots.
    expect(day.slots).toHaveLength(12);
    expect(day.slots[0]?.time).toBe('09:00');
    expect(day.slots.at(-1)?.time).toBe('11:45');
    expect(day.timezone).toBe('Asia/Kolkata');
    expect(day.unavailableReason).toBeNull();
  });

  it('reports the slot start as an instant matching the clinic wall clock', async () => {
    const day = await availability(frontDesk);
    const first = day.slots[0] as Slot;

    // 09:00 IST is 03:30 UTC. Written out rather than recomputed with the same
    // helper the server used — a test that reuses the implementation cannot
    // catch the implementation being wrong.
    expect(new Date(first.startAt).toISOString()).toBe(`${DAY}T03:30:00.000Z`);
  });

  it('sees an appointment that was written outside the API', async () => {
    /**
     * The timezone regression, in the shape it actually occurred.
     *
     * Booking through the API and reading it back is symmetric: if the driver
     * misreads a timestamp it also miswrites one, and the two cancel out. The
     * bug appeared because the DEMO SEED writes appointments with raw SQL and
     * the API reads them through Prisma. Twelve seeded appointments showed as
     * booked in the database and every slot showed as free on the screen.
     *
     * So this row is inserted the way the seed inserts one, and read the way
     * the app reads one. 05:00Z is 10:30 in Kolkata — a half-hour offset, which
     * also catches a whole-hour zone being applied by mistake.
     */
    await ownerQuery(
      fx.main.id,
      `INSERT INTO appointment
         (tenant_id, patient_id, practitioner_id, location_id, start_at, end_at,
          status, visit_type, source, updated_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz,
               'BOOKED', 'NEW', 'FRONT_DESK', now())`,
      [
        fx.main.id,
        fx.main.patientIds[0],
        fx.main.practitionerId,
        fx.main.locationId,
        `${DAY}T05:00:00Z`,
        `${DAY}T05:15:00Z`,
      ],
    );

    const day = await availability(frontDesk);
    const slot = day.slots.find((s) => s.time === '10:30') as Slot;

    expect(slot.booked).toBe(1);
    expect(slot.available).toBe(0);
    expect(day.slots.filter((s) => s.available === 0)).toHaveLength(1);

    const queue = await app.inject({
      method: 'GET',
      url: `/api/v1/queue?practitionerId=${fx.main.practitionerId}&date=${DAY}`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(queue.json().yetToArrive[0].localTime).toBe('10:30');
  });

  it('is refused without the read permission', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/availability?practitionerId=${fx.main.practitionerId}&date=${DAY}`,
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed date', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/availability?practitionerId=${fx.main.practitionerId}&date=07-08-2026`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('YYYY-MM-DD');
  });
});

// --- booking ----------------------------------------------------------------

describe('booking', () => {
  it('takes the slot out of availability', async () => {
    const before = await availability(frontDesk);
    const target = before.slots[3] as Slot;

    const res = await book(frontDesk, { slotIndex: 3 });
    expect(res.statusCode).toBe(201);

    const created = res.json();
    expect(created.status).toBe('BOOKED');
    // The token comes with the booking, so the patient can be handed a number
    // at the desk. What they do not have yet is a place in the queue.
    expect(created.tokenNumber).toBe(1);
    expect(created.readyAt).toBeNull();

    // The wall clock the receptionist sees must equal the one they picked. This
    // is the timezone regression: reading start_at back in the session timezone
    // instead of UTC shifted this by five and a half hours, and — because
    // availability buckets bookings by local time — left every booked slot
    // looking free.
    expect(created.localTime).toBe(target.time);
    expect(new Date(created.startAt).toISOString()).toBe(new Date(target.startAt).toISOString());

    const after = await availability(frontDesk);
    const sameSlot = after.slots.find((s) => s.time === target.time) as Slot;
    expect(sameSlot.booked).toBe(1);
    expect(sameSlot.available).toBe(0);

    // And nothing else moved.
    expect(after.slots.filter((s) => s.available === 0)).toHaveLength(1);
  });

  it('refuses a second patient in a full slot', async () => {
    await book(frontDesk, { slotIndex: 0, patientIndex: 0 });
    const res = await book(frontDesk, { slotIndex: 0, patientIndex: 1 });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('SLOT_FULL');
  });

  it('refuses the same patient twice with the same doctor that day', async () => {
    await book(frontDesk, { slotIndex: 0, patientIndex: 0 });
    const res = await book(frontDesk, { slotIndex: 5, patientIndex: 0 });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('ALREADY_BOOKED');
    // The receptionist needs to find the existing one, not just be refused.
    expect(res.json().error.details.existingAppointmentId).toBeTruthy();
  });

  it('refuses a time outside the doctor’s sessions', async () => {
    // 20:00 IST — the doctor sits 09:00–12:00.
    const res = await book(frontDesk, { startAt: `${DAY}T14:30:00.000Z` });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('SLOT_NOT_AVAILABLE');
  });

  it('frees the slot again when the appointment is cancelled', async () => {
    const created = (await book(frontDesk, { slotIndex: 2 })).json();

    const cancelled = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${created.id}/cancel`,
      headers: { cookie: frontDesk.cookie },
      payload: { reason: 'Patient unwell' },
    });
    expect(cancelled.statusCode).toBe(200);

    const after = await availability(frontDesk);
    expect(after.slots.every((s) => s.available === 1)).toBe(true);
  });

  it('rejects a field the API does not recognise', async () => {
    // forbidNonWhitelisted. A request carrying fields we do not understand is
    // one we should not guess at — that is how mass-assignment bugs happen.
    const day = await availability(frontDesk);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: { cookie: frontDesk.cookie },
      payload: {
        patientId: fx.main.patientIds[0],
        practitionerId: fx.main.practitionerId,
        locationId: fx.main.locationId,
        startAt: day.slots[0]?.startAt,
        tenantId: fx.other.id,
      },
    });

    expect(res.statusCode).toBe(400);
  });
});

// --- the queue --------------------------------------------------------------

describe('check-in and the queue', () => {
  /**
   * The reason tokens and positions had to come apart.
   *
   * Tokens are handed out in BOOKING order, so the 09:15 patient booked first
   * holds token 1. The waiting list is in ARRIVAL order, so the 11:00 patient
   * who turned up early is seen first — holding token 2.
   *
   * A queue that sorted by token would put them the other way round, which is
   * exactly the bug this split exists to prevent. The assertion is [2, 1] on
   * purpose: an implementation that quietly fell back to token order would
   * produce [1, 2] and pass every other test in this file.
   */
  it('orders the waiting list by arrival, not by token or appointment time', async () => {
    const early = (await book(frontDesk, { slotIndex: 1, patientIndex: 1 })).json();
    const late = (await book(frontDesk, { slotIndex: 8, patientIndex: 0 })).json();

    expect(early.tokenNumber).toBe(1);
    expect(late.tokenNumber).toBe(2);

    // The 11:00 patient walks in before the 09:15 one.
    const first = await checkIn(late.id);
    const second = await checkIn(early.id);

    // Their tokens did not change when they arrived — they are holding slips.
    expect(first.json().tokenNumber).toBe(2);
    expect(second.json().tokenNumber).toBe(1);

    const queue = await app.inject({
      method: 'GET',
      url: `/api/v1/queue?practitionerId=${fx.main.practitionerId}&date=${DAY}`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(queue.statusCode).toBe(200);
    const body = queue.json();
    expect(body.waiting.map((a: { tokenNumber: number }) => a.tokenNumber)).toEqual([2, 1]);
    expect(body.stats.waiting).toBe(2);
    // Nobody has been called yet, so there is no wait to average. Reporting 0
    // here would be a number the front desk repeats to patients.
    expect(body.stats.averageWaitMinutes).toBeNull();
  });

  it('keeps the diary in time order even when arrivals are not', async () => {
    // Booked out of order: the later slot is booked first and holds token 1.
    await book(frontDesk, { slotIndex: 9, patientIndex: 0 });
    await book(frontDesk, { slotIndex: 2, patientIndex: 1 });

    const queue = await app.inject({
      method: 'GET',
      url: `/api/v1/queue?practitionerId=${fx.main.practitionerId}&date=${DAY}`,
      headers: { cookie: frontDesk.cookie },
    });

    // Nobody has arrived, so "yet to arrive" is a diary and reads by the clock.
    const times = queue.json().yetToArrive.map((a: { localTime: string }) => a.localTime);
    expect(times).toEqual([...times].sort());
  });

  it('flags a patient to be seen next, ahead of everyone already waiting', async () => {
    const first = (await book(frontDesk, { slotIndex: 0, patientIndex: 0 })).json();
    const second = (await book(frontDesk, { slotIndex: 1, patientIndex: 1 })).json();

    await checkIn(first.id);
    await checkIn(second.id);

    // Phase B gives the desk a button for this. The ordering it depends on is
    // phase A's, so it is asserted here against the columns directly.
    await ownerQuery(
      fx.main.id,
      `UPDATE appointment
          SET priority_reason_code = 'BACK_FROM_TESTS',
              priority_set_at = now(),
              priority_set_by_user_id = (SELECT id FROM app_user WHERE tenant_id = $2 LIMIT 1)
        WHERE id = $1`,
      [second.id, fx.main.id],
    );

    const queue = await app.inject({
      method: 'GET',
      url: `/api/v1/queue?practitionerId=${fx.main.practitionerId}&date=${DAY}`,
      headers: { cookie: frontDesk.cookie },
    });

    const waiting = queue.json().waiting as Array<{
      id: string;
      priority: { reasonCode: string } | null;
    }>;

    expect(waiting.map((a) => a.id)).toEqual([second.id, first.id]);
    expect(waiting[0]?.priority?.reasonCode).toBe('BACK_FROM_TESTS');
    expect(waiting[1]?.priority).toBeNull();
  });

  it('takes the flag back off again', async () => {
    const appt = (await book(frontDesk)).json();
    await checkIn(appt.id);

    const flagged = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appt.id}/priority`,
      headers: { cookie: frontDesk.cookie },
      payload: { reasonCode: 'EMERGENCY', note: 'Chest pain' },
    });
    expect(flagged.statusCode).toBe(200);
    expect(flagged.json().priority.reasonCode).toBe('EMERGENCY');
    expect(flagged.json().priority.note).toBe('Chest pain');

    // Without an undo, a mis-click is repaired by cancelling the visit — which
    // costs the patient their token and their bill.
    const cleared = await app.inject({
      method: 'DELETE',
      url: `/api/v1/appointments/${appt.id}/priority`,
      headers: { cookie: frontDesk.cookie },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().priority).toBeNull();
    expect(cleared.json().tokenNumber).toBe(appt.tokenNumber);
  });

  it('refuses to flag a patient who is not waiting', async () => {
    const appt = (await book(frontDesk)).json();

    // Booked but not arrived: they hold no position, so there is none to move.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appt.id}/priority`,
      headers: { cookie: frontDesk.cookie },
      payload: { reasonCode: 'EMERGENCY' },
    });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('NOT_WAITING');
  });

  it('refuses a flag from a role without the permission', async () => {
    const appt = (await book(frontDesk)).json();
    await checkIn(appt.id);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appt.id}/priority`,
      headers: { cookie: nurse.cookie },
      payload: { reasonCode: 'EMERGENCY' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('accepts a PATCH with no body', async () => {
    const appt = (await book(frontDesk)).json();

    // Check-in carries no payload. Fastify refuses an empty body when
    // `Content-Type: application/json` is set, which is why the web client only
    // sets that header when there is something to send — this asserts the API
    // half of that contract.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appt.id}/check-in`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ARRIVED');

    // The other half of the contract, asserted so a change in Fastify's
    // behaviour is caught here rather than in the browser: announcing a JSON
    // body and sending none is refused before any handler runs.
    const appt2 = (await book(frontDesk, { slotIndex: 4, patientIndex: 1 })).json();
    const announcingAnEmptyBody = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appt2.id}/check-in`,
      headers: { cookie: frontDesk.cookie, 'content-type': 'application/json' },
    });

    expect(announcingAnEmptyBody.statusCode).toBe(400);
  });

  it('refuses to check the same patient in twice', async () => {
    const appt = (await book(frontDesk)).json();
    await checkIn(appt.id);

    const again = await checkIn(appt.id);
    expect(again.statusCode).toBe(409);
    expect(domainCode(again)).toBe('NOT_CHECKABLE');
  });

  it('walks a patient through called and completed', async () => {
    const appt = (await book(frontDesk)).json();
    await checkIn(appt.id);

    const called = await transition(appt.id, 'call', doctor);
    expect(called.statusCode).toBe(200);
    expect(called.json().status).toBe('IN_PROGRESS');
    expect(called.json().calledAt).toBeTruthy();

    const completed = await transition(appt.id, 'complete', doctor);
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe('FULFILLED');
  });

  /**
   * The X-ray round trip, which is the whole reason phase B exists.
   *
   * The point being asserted is that this is ONE visit throughout: same token,
   * same appointment, same encounter. Every temptation to model the return as a
   * new arrival produces a second token here, and a second invoice behind it.
   */
  it('sends a patient out and brings them back as the same visit', async () => {
    const appt = (await book(frontDesk)).json();
    await checkIn(appt.id);
    await transition(appt.id, 'call', doctor);

    const sent = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appt.id}/send-for-tests`,
      headers: { cookie: doctor.cookie },
      payload: { reason: 'X-ray — left wrist' },
    });

    expect(sent.statusCode).toBe(200);
    expect(sent.json().status).toBe('AWAITING_TESTS');
    expect(sent.json().sentOut.reason).toBe('X-ray — left wrist');
    // Out of the waiting list while they are gone: no position, so the doctor
    // is not handed them, and the board does not count them as waiting.
    expect(sent.json().readyAt).toBeNull();
    expect(sent.json().tokenNumber).toBe(appt.tokenNumber);

    const board = await app.inject({
      method: 'GET',
      url: `/api/v1/queue?practitionerId=${fx.main.practitionerId}&date=${DAY}`,
      headers: { cookie: frontDesk.cookie },
    });
    expect(board.json().awayForTests).toHaveLength(1);
    expect(board.json().waiting).toHaveLength(0);
    // The room is free, which is the operational point of sending them out.
    expect(board.json().nowServing).toBeNull();

    const back = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appt.id}/return`,
      headers: { cookie: frontDesk.cookie },
      payload: { seeNext: true, note: 'Film in hand' },
    });

    expect(back.statusCode).toBe(200);
    expect(back.json().status).toBe('ARRIVED');
    expect(back.json().tokenNumber).toBe(appt.tokenNumber);
    expect(back.json().priority.reasonCode).toBe('BACK_FROM_TESTS');
    expect(back.json().readyAt).not.toBeNull();
  });

  it('puts a returning patient in front of everyone waiting', async () => {
    const returning = (await book(frontDesk, { slotIndex: 0, patientIndex: 0 })).json();
    const waitingAlready = (await book(frontDesk, { slotIndex: 1, patientIndex: 1 })).json();

    await checkIn(returning.id);
    await transition(returning.id, 'call', doctor);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${returning.id}/send-for-tests`,
      headers: { cookie: doctor.cookie },
      payload: { reason: 'Blood sugar' },
    });

    // Somebody else arrives while the first patient is away.
    await checkIn(waitingAlready.id);

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${returning.id}/return`,
      headers: { cookie: frontDesk.cookie },
      payload: { seeNext: true },
    });

    const board = await app.inject({
      method: 'GET',
      url: `/api/v1/queue?practitionerId=${fx.main.practitionerId}&date=${DAY}`,
      headers: { cookie: frontDesk.cookie },
    });

    // Ahead of the patient who arrived while they were gone — they have already
    // waited once, and that is what "see next" means.
    expect(board.json().waiting.map((a: { id: string }) => a.id)).toEqual([
      returning.id,
      waitingAlready.id,
    ]);
  });

  it('lets the desk decline to jump them', async () => {
    const returning = (await book(frontDesk, { slotIndex: 0, patientIndex: 0 })).json();
    const waitingAlready = (await book(frontDesk, { slotIndex: 1, patientIndex: 1 })).json();

    await checkIn(returning.id);
    await transition(returning.id, 'call', doctor);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${returning.id}/send-for-tests`,
      headers: { cookie: doctor.cookie },
      payload: { reason: 'ECG' },
    });
    await checkIn(waitingAlready.id);

    // Where they land is the desk's decision, not the software's.
    const back = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${returning.id}/return`,
      headers: { cookie: frontDesk.cookie },
      payload: { seeNext: false },
    });
    expect(back.json().priority).toBeNull();

    const board = await app.inject({
      method: 'GET',
      url: `/api/v1/queue?practitionerId=${fx.main.practitionerId}&date=${DAY}`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(board.json().waiting.map((a: { id: string }) => a.id)).toEqual([
      waitingAlready.id,
      returning.id,
    ]);
  });

  it('serves two flagged patients in the order they were flagged', async () => {
    const first = (await book(frontDesk, { slotIndex: 0, patientIndex: 0 })).json();
    const second = (await book(frontDesk, { slotIndex: 1, patientIndex: 1 })).json();

    await checkIn(first.id);
    await checkIn(second.id);

    // A recall promised "you are next"...
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${second.id}/priority`,
      headers: { cookie: frontDesk.cookie },
      payload: { reasonCode: 'BACK_FROM_TESTS' },
    });

    // ...then an emergency, a moment later. It queues BEHIND the promise rather
    // than displacing it — the desk has already told that patient they are next,
    // and breaking that is the thing this ordering exists to prevent.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${first.id}/priority`,
      headers: { cookie: frontDesk.cookie },
      payload: { reasonCode: 'EMERGENCY' },
    });

    const board = await app.inject({
      method: 'GET',
      url: `/api/v1/queue?practitionerId=${fx.main.practitionerId}&date=${DAY}`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(board.json().waiting.map((a: { id: string }) => a.id)).toEqual([second.id, first.id]);
  });

  it('refuses to send out a patient who is not with the doctor', async () => {
    const appt = (await book(frontDesk)).json();
    await checkIn(appt.id);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appt.id}/send-for-tests`,
      headers: { cookie: doctor.cookie },
      payload: { reason: 'X-ray' },
    });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('NOT_IN_CONSULTATION');
  });

  it('refuses a return for a patient who was never sent out', async () => {
    const appt = (await book(frontDesk)).json();
    await checkIn(appt.id);

    // The guard that stops "back from tests" becoming the fast lane for anyone
    // who complains: the flag is only reachable through a recorded send-out.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appt.id}/return`,
      headers: { cookie: frontDesk.cookie },
      payload: { seeNext: true },
    });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('NOT_AWAY');
  });

  it('refuses to send someone out with no reason', async () => {
    const appt = (await book(frontDesk)).json();
    await checkIn(appt.id);
    await transition(appt.id, 'call', doctor);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appt.id}/send-for-tests`,
      headers: { cookie: doctor.cookie },
      payload: { reason: '' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('refuses to call a patient who has not arrived', async () => {
    const appt = (await book(frontDesk)).json();

    const res = await transition(appt.id, 'call', doctor);
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('INVALID_TRANSITION');
  });

  it('registers a walk-in as arrived with a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments/walk-in',
      headers: { cookie: frontDesk.cookie },
      payload: {
        patientId: fx.main.patientIds[2],
        practitionerId: fx.main.practitionerId,
        locationId: fx.main.locationId,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('ARRIVED');
    expect(res.json().source).toBe('WALK_IN');
    expect(res.json().tokenNumber).toBe(1);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments/walk-in',
      headers: { cookie: frontDesk.cookie },
      payload: {
        patientId: fx.main.patientIds[2],
        practitionerId: fx.main.practitionerId,
        locationId: fx.main.locationId,
      },
    });

    expect(duplicate.statusCode).toBe(409);
    expect(domainCode(duplicate)).toBe('ALREADY_IN_QUEUE');
  });
});

// --- rescheduling and cancelling -------------------------------------------

describe('rescheduling', () => {
  it('frees the old slot and takes the new one', async () => {
    const before = await availability(frontDesk);
    const from = before.slots[1] as Slot;
    const to = before.slots[9] as Slot;

    const appt = (await book(frontDesk, { slotIndex: 1 })).json();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appt.id}/reschedule`,
      headers: { cookie: frontDesk.cookie },
      payload: { startAt: to.startAt, reason: 'Patient requested a different time' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().localTime).toBe(to.time);

    // Implemented as cancel-then-book, so the result is a NEW appointment and
    // the original stays in the record with its reason.
    expect(res.json().id).not.toBe(appt.id);

    const after = await availability(frontDesk);
    expect(after.slots.find((s) => s.time === from.time)?.available).toBe(1);
    expect(after.slots.find((s) => s.time === to.time)?.available).toBe(0);

    const [original] = await ownerQuery<{ status: string; cancel_reason: string }>(
      fx.main.id,
      `SELECT status, cancel_reason FROM appointment WHERE id = $1`,
      [appt.id],
    );
    expect(original?.status).toBe('CANCELLED');
    expect(original?.cancel_reason).toContain('Rescheduled');
  });

  // --- one act, or nothing -------------------------------------------------

  function reschedule(id: string, startAt: unknown) {
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${id}/reschedule`,
      headers: { cookie: frontDesk.cookie },
      payload: { startAt, reason: 'Patient asked to move' },
    });
  }

  /** Everything a failed reschedule must leave exactly as it was. */
  async function snapshot(id: string) {
    const [row] = await ownerQuery(
      fx.main.id,
      `SELECT status, start_at, end_at, cancelled_at, cancel_reason, cancelled_by_user_id, updated_at
         FROM appointment WHERE id = $1`,
      [id],
    );
    const [counts] = await ownerQuery<{ appts: number; cancels: number; books: number }>(
      fx.main.id,
      `SELECT (SELECT count(*)::int FROM appointment) AS appts,
              (SELECT count(*)::int FROM audit_event
                WHERE action = 'appointment.cancel' AND resource_id = $1) AS cancels,
              (SELECT count(*)::int FROM audit_event WHERE action = 'appointment.book') AS books`,
      [id],
    );
    if (!counts) throw new Error('no counts');
    return { row, counts };
  }

  it('leaves the original untouched when the new slot is full', async () => {
    const day = await availability(frontDesk);
    const original = (await book(frontDesk, { slotIndex: 1, patientIndex: 0 })).json();
    await book(frontDesk, { slotIndex: 9, patientIndex: 1 });
    const before = await snapshot(original.id);

    const res = await reschedule(original.id, day.slots[9]?.startAt);

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('SLOT_FULL');
    expect(await snapshot(original.id)).toEqual(before);
    expect(before.row?.status).toBe('BOOKED');
  });

  it('leaves the original untouched when the time is not a slot at all', async () => {
    const original = (await book(frontDesk, { slotIndex: 1 })).json();
    const before = await snapshot(original.id);

    const res = await reschedule(original.id, `${DAY}T23:00:00+05:30`);

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('SLOT_NOT_AVAILABLE');
    expect(await snapshot(original.id)).toEqual(before);
  });

  it('leaves the original untouched when the new time does not validate', async () => {
    const original = (await book(frontDesk, { slotIndex: 1 })).json();
    const before = await snapshot(original.id);

    expect((await reschedule(original.id, 'next tuesday')).statusCode).toBe(400);
    expect(await snapshot(original.id)).toEqual(before);
  });

  /**
   * Switched off behind the front desk's back — straight in the database,
   * because the setup screen would refuse while this appointment exists.
   */
  it('leaves the original untouched when the doctor has been switched off', async () => {
    const day = await availability(frontDesk);
    const original = (await book(frontDesk, { slotIndex: 1 })).json();
    const before = await snapshot(original.id);
    await ownerQuery(fx.main.id, `UPDATE practitioner SET is_active = false WHERE id = $1`, [
      fx.main.practitionerId,
    ]);

    try {
      const res = await reschedule(original.id, day.slots[9]?.startAt);

      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe('This doctor is no longer active.');
      expect(await snapshot(original.id)).toEqual(before);
    } finally {
      await ownerQuery(fx.main.id, `UPDATE practitioner SET is_active = true WHERE id = $1`, [
        fx.main.practitionerId,
      ]);
    }
  });

  it('writes the cancel and the booking audit events only when it succeeds', async () => {
    const day = await availability(frontDesk);
    const original = (await book(frontDesk, { slotIndex: 1 })).json();
    const before = await snapshot(original.id);

    const res = await reschedule(original.id, day.slots[9]?.startAt);

    expect(res.statusCode).toBe(200);
    const after = await snapshot(original.id);
    expect(after.row?.status).toBe('CANCELLED');
    expect(after.counts).toEqual({
      appts: before.counts.appts + 1,
      cancels: before.counts.cancels + 1,
      books: before.counts.books + 1,
    });
    const [created] = await ownerQuery<{ status: string }>(
      fx.main.id,
      `SELECT status FROM appointment WHERE id = $1`,
      [res.json().id],
    );
    expect(created?.status).toBe('BOOKED');
  });

  /**
   * Into the slot it is leaving. The availability check runs in the same
   * transaction as the cancel, so it sees the original gone and the slot free —
   * checked from a transaction of its own, it would still see it taken.
   */
  it('can move an appointment into the slot it frees', async () => {
    const day = await availability(frontDesk);
    const original = (await book(frontDesk, { slotIndex: 1 })).json();

    const res = await reschedule(original.id, day.slots[1]?.startAt);

    expect(res.statusCode).toBe(200);
    expect(res.json().id).not.toBe(original.id);
  });

  it('refuses to move a patient who has already arrived', async () => {
    const day = await availability(frontDesk);
    const appt = (await book(frontDesk, { slotIndex: 0 })).json();
    await checkIn(appt.id);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appt.id}/reschedule`,
      headers: { cookie: frontDesk.cookie },
      payload: { startAt: day.slots[6]?.startAt, reason: 'Doctor running late' },
    });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('NOT_RESCHEDULABLE');
  });

  it('requires a reason to cancel', async () => {
    const appt = (await book(frontDesk)).json();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appt.id}/cancel`,
      headers: { cookie: frontDesk.cookie },
      payload: {},
    });

    // FR-APT-03 wants reason codes, and a cancellation history of empty strings
    // tells a clinic nothing about why its slots go unused.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('reason');
  });

  it('refuses a cancellation from a role without the permission', async () => {
    const appt = (await book(frontDesk)).json();

    // A doctor may call and complete, but cancelling is a front-desk action.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appt.id}/cancel`,
      headers: { cookie: doctor.cookie },
      payload: { reason: 'Patient unwell' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('appointment:cancel');
  });

  it('refuses every write from a read-only role', async () => {
    const appt = (await book(frontDesk)).json();

    for (const action of ['check-in', 'call', 'complete', 'no-show']) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/appointments/${appt.id}/${action}`,
        headers: { cookie: nurse.cookie },
      });

      expect(res.statusCode, `nurse should not be able to ${action}`).toBe(403);
    }
  });
});

// --- tenant isolation -------------------------------------------------------

describe('one clinic cannot reach another', () => {
  it('cannot read another clinic’s availability', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/availability?practitionerId=${fx.other.practitionerId}&date=${DAY}`,
      headers: { cookie: frontDesk.cookie },
    });

    // Not 403 — 404. Under row-level security the other tenant's doctor does not
    // exist as far as this session is concerned, which is the stronger answer:
    // it confirms nothing about what the id refers to.
    expect(res.statusCode).toBe(404);
  });

  it('cannot act on another clinic’s appointment', async () => {
    const theirs = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments/walk-in',
      headers: { cookie: otherFrontDesk.cookie },
      payload: {
        patientId: fx.other.patientIds[0],
        practitionerId: fx.other.practitionerId,
        locationId: fx.other.locationId,
      },
    });
    expect(theirs.statusCode).toBe(201);
    const theirAppointmentId = theirs.json().id;

    for (const action of ['check-in', 'call', 'complete', 'no-show']) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/appointments/${theirAppointmentId}/${action}`,
        headers: { cookie: frontDesk.cookie },
      });
      expect(res.statusCode, `${action} across tenants`).toBe(404);
    }

    const cancel = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${theirAppointmentId}/cancel`,
      headers: { cookie: frontDesk.cookie },
      payload: { reason: 'Not mine to cancel' },
    });
    expect(cancel.statusCode).toBe(404);

    // And it is untouched. Read under the OTHER tenant's context — this is the
    // only place in the suite that legitimately looks at their data.
    const [row] = await ownerQuery<{ status: string }>(
      fx.other.id,
      `SELECT status FROM appointment WHERE id = $1`,
      [theirAppointmentId],
    );
    expect(row?.status).toBe('ARRIVED');
  });

  it('cannot book one clinic’s patient into another clinic’s diary', async () => {
    const day = await availability(frontDesk);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: { cookie: frontDesk.cookie },
      payload: {
        patientId: fx.other.patientIds[0],
        practitionerId: fx.main.practitionerId,
        locationId: fx.main.locationId,
        startAt: day.slots[0]?.startAt,
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('shows an empty queue for another clinic’s doctor', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/appointments/walk-in',
      headers: { cookie: otherFrontDesk.cookie },
      payload: {
        patientId: fx.other.patientIds[0],
        practitionerId: fx.other.practitionerId,
        locationId: fx.other.locationId,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/queue?practitionerId=${fx.other.practitionerId}`,
      headers: { cookie: frontDesk.cookie },
    });

    // A queue endpoint filters rather than looks up, so the honest result is an
    // empty board rather than an error. What matters is that no row crosses.
    expect(res.statusCode).toBe(200);
    expect(res.json().waiting).toHaveLength(0);
    expect(res.json().stats.inQueue).toBe(0);
  });

  it('lists only its own doctors and departments', async () => {
    const practitioners = await app.inject({
      method: 'GET',
      url: '/api/v1/practitioners',
      headers: { cookie: frontDesk.cookie },
    });

    const ids = practitioners.json().practitioners.map((p: { id: string }) => p.id);
    expect(ids).toEqual([fx.main.practitionerId]);
  });
});

// --- audit ------------------------------------------------------------------

describe('the audit trail', () => {
  it('attributes the booking to the user who made it', async () => {
    const appt = (await book(frontDesk)).json();

    const [event] = await ownerQuery<{
      action: string;
      actor_user_id: string | null;
      patient_id: string | null;
      changed_fields: string[];
    }>(
      fx.main.id,
      `SELECT action, actor_user_id, patient_id, changed_fields
         FROM audit_event
        WHERE resource_id = $1 AND action = 'appointment.book'`,
      [appt.id],
    );

    expect(event?.actor_user_id).toBeTruthy();
    expect(event?.patient_id).toBe(fx.main.patientIds[0]);

    // Field NAMES only. An audit log holding values is a second copy of the data
    // it exists to protect.
    expect(event?.changed_fields).toContain('startAt');
  });
});

// --- shared request helpers -------------------------------------------------

function checkIn(appointmentId: string) {
  return transition(appointmentId, 'check-in', frontDesk);
}

function transition(appointmentId: string, action: string, session: Session) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/appointments/${appointmentId}/${action}`,
    headers: { cookie: session.cookie },
  });
}

/**
 * "In the queue" — who the clinic still has to deal with today.
 *
 * This counted every appointment of the day in any state, so it only ever went
 * up: a finished visit, a cancellation and a no-show all stayed "in the queue"
 * until midnight. Each status is asserted on its own, because the bug was
 * exactly that three of them were counted when they should not have been.
 */
describe('the in-the-queue count', () => {
  const QUEUE_DAY = clinicDate(7);

  /** One appointment in `status`, the `index`-th of the day, written directly. */
  async function appointmentIn(status: string, index = 0) {
    await ownerQuery(
      fx.main.id,
      `INSERT INTO appointment (tenant_id, patient_id, practitioner_id, location_id,
                                start_at, end_at, status, visit_type, updated_at)
       VALUES ($1, $2, $3, $4,
               ($5::date + time '10:00' + $6 * interval '15 minutes') AT TIME ZONE 'Asia/Kolkata',
               ($5::date + time '10:15' + $6 * interval '15 minutes') AT TIME ZONE 'Asia/Kolkata',
               $7::appointment_status, 'NEW', now())`,
      [
        fx.main.id,
        fx.main.patientIds[index % fx.main.patientIds.length],
        fx.main.practitionerId,
        fx.main.locationId,
        QUEUE_DAY,
        index,
        status,
      ],
    );
  }

  async function stats() {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/queue?practitionerId=${fx.main.practitionerId}&date=${QUEUE_DAY}`,
      headers: { cookie: frontDesk.cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ stats: { inQueue: number } & Record<string, unknown> }>().stats;
  }

  const COUNTED = ['BOOKED', 'ARRIVED', 'IN_PROGRESS', 'AWAITING_TESTS'];
  const NOT_COUNTED = ['FULFILLED', 'CANCELLED', 'NO_SHOW'];

  for (const status of COUNTED) {
    it(`counts a visit that is ${status}`, async () => {
      await appointmentIn(status);
      expect((await stats()).inQueue).toBe(1);
    });
  }

  for (const status of NOT_COUNTED) {
    it(`does not count a visit that is ${status}`, async () => {
      await appointmentIn(status);
      expect((await stats()).inQueue).toBe(0);
    });
  }

  it('counts only the visits not over yet, out of a full day', async () => {
    const all = [...COUNTED, ...NOT_COUNTED];
    for (const [i, status] of all.entries()) await appointmentIn(status, i);

    // Seven appointments on the day; four of them are still to be dealt with.
    expect((await stats()).inQueue).toBe(COUNTED.length);
  });

  /** The reported case, measured on the development data: 1 booked + 1 finished. */
  it('is 1, not 2, for one patient yet to arrive and one already seen', async () => {
    await appointmentIn('BOOKED', 0);
    await appointmentIn('FULFILLED', 1);

    expect((await stats()).inQueue).toBe(1);
  });

  /**
   * The every-appointment count was only ever read by the "In the queue" tile,
   * so it was replaced rather than kept under another name.
   */
  it('no longer reports the old every-appointment total', async () => {
    expect(await stats()).not.toHaveProperty('total');
  });
});

/**
 * A doctor's queue is their own.
 *
 * The rule is enforced on the server, not by hiding a dropdown: a doctor who
 * types another practitioner's id into the URL gets 403, not another doctor's
 * waiting list. Everything here is that one property from both sides.
 */
describe('whose queue you may read', () => {
  /** A second doctor at the same clinic, so "somebody else's queue" exists. */
  async function secondPractitioner(): Promise<string> {
    const [row] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO practitioner
         (tenant_id, full_name, registration_number, specialty, department_id,
          overbook_per_session, updated_at)
       VALUES ($1, 'Dr Second Opinion', 'TEST-0002', 'Dermatology', $2, 0, now())
       RETURNING id`,
      [fx.main.id, fx.main.departmentId],
    );
    return row!.id;
  }

  it('lets a doctor read their own', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/queue?practitionerId=${fx.main.practitionerId}`,
      headers: { cookie: doctor.cookie },
    });

    expect(res.statusCode).toBe(200);
  });

  it("refuses a doctor another doctor's queue", async () => {
    const other = await secondPractitioner();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/queue?practitionerId=${other}`,
      headers: { cookie: doctor.cookie },
    });

    expect(res.statusCode).toBe(403);
    expect(res.payload).toMatch(/your own queue/i);
  });

  /**
   * The third case, which used to fail OPEN.
   *
   * A doctor account that was never joined to a `practitioner` row — the state
   * every new doctor is in until somebody does their Doctors-and-hours setup —
   * looked identical to the front desk: not a practitioner, therefore not
   * confined, therefore handed any consultant's waiting list in the clinic.
   *
   * The account here is deliberately built the way the console builds one: a
   * user with the doctor role and no practitioner record. Linking it is the
   * step being skipped, and skipping it must now cost access rather than grant
   * it.
   */
  it('refuses a doctor whose account is not linked to a practitioner', async () => {
    const unlinked = await createDoctor(app, fx.main, {
      email: 'unlinked@main.test',
      fullName: 'Dr Not Linked Yet',
      linked: false,
    });
    const other = await secondPractitioner();

    for (const id of [fx.main.practitionerId, other]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/queue?practitionerId=${id}`,
        headers: { cookie: unlinked.session.cookie },
      });

      expect(res.statusCode).toBe(403);
      expect(res.payload).toMatch(/not linked to a doctor record/i);
    }
  });

  /**
   * The front desk runs the waiting room and the nurse works across it. Neither
   * is a practitioner, so neither is confined — and this is what stops the rule
   * being written as "anybody with appointment:read sees only themselves",
   * which would have broken the desk. It is also why the rule above keys on
   * `consultation:write` rather than on "has no practitioner row".
   */
  it('lets the front desk read any doctor', async () => {
    const other = await secondPractitioner();

    for (const id of [fx.main.practitionerId, other]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/queue?practitionerId=${id}`,
        headers: { cookie: frontDesk.cookie },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('lets a nurse read any doctor', async () => {
    const other = await secondPractitioner();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/queue?practitionerId=${other}`,
      headers: { cookie: nurse.cookie },
    });

    expect(res.statusCode).toBe(200);
  });

  it('tells the console which practitioner the signed-in user is', async () => {
    const asDoctor = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: doctor.cookie },
    });
    expect(asDoctor.json<{ practitionerId: string | null }>().practitionerId).toBe(
      fx.main.practitionerId,
    );

    const asFrontDesk = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: frontDesk.cookie },
    });
    expect(asFrontDesk.json<{ practitionerId: string | null }>().practitionerId).toBeNull();
  });
});
