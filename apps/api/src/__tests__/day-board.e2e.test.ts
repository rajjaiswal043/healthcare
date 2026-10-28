/**
 * The home-page day board.
 *
 * Everybody in the clinic today, one row per PATIENT — the screen the front
 * desk, the doctor and the administrator land on when they sign in.
 *
 * Three properties carry this file, and each protects a decision that took a
 * conversation to reach:
 *
 * **One row per patient.** Somebody who sees a doctor and has an X-ray the same
 * day is one person in the building. Two rows would also be two entries in
 * every count, so "12 patients today" would quietly mean "12 things happened".
 *
 * **"Done" means nothing is outstanding.** A consultation that has finished
 * while the X-ray has not come back leaves the patient in the building, so they
 * stay under "At a department". Placing people by the furthest-along thing they
 * had done would make them vanish off the board while still sitting in it.
 *
 * **A walk-in test patient has no appointment at all.** `appointment_id` is
 * nullable, so a board built on `appointment` alone would miss them — which is
 * exactly the group the "At a department" tab exists for.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
let doctor: Session;
let admin: Session;
let departmentId: string;
let orderedByUserId: string;

interface Row {
  patient: { id: string; name: string; uhid: string };
  bucket: string;
  /** The visit this row acts on. Null for a walk-in test with no appointment. */
  appointmentId: string | null;
  hasVisit: boolean;
  hasTest: boolean;
  opdDone: boolean;
  testsDoneIn: string | null;
  /** What they were sent for, and where — the receptionist reads this row. */
  tests: Array<{ description: string; department: string; done: boolean; unpaid: boolean }>;
  testDepartment: string | null;
  token: number | null;
  withWhom: string | null;
  visitFee: string | null;
  testFee: string | null;
  paymentMethods: string[];
  /** Null for a caller without `invoice:read`. */
  money: { billedPaise: number; duePaise: number } | null;
  nextSteps: Array<{
    kind: string;
    invoiceId?: string;
    appointmentId?: string;
    orderId?: string;
    paymentId?: string;
    duePaise?: number;
  }>;
}

interface Board {
  date: string;
  scope: 'CLINIC' | 'OWN';
  counts: Record<string, number>;
  money: { billedPaise: number; collectedPaise: number; duePaise: number } | null;
  rows: Row[];
}

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();

  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  doctor = await login(app, fx.main.slug, 'doctor@main.test');
  // The integration suite forces MFA on, and the administrator role requires
  // TOTP — so this one account cannot use the plain helper.
  admin = await loginWithMfa(app, fx.main.slug, 'admin@main.test');

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/departments',
    headers: { cookie: admin.cookie },
    payload: { name: 'Board X-ray' },
  });
  expect(created.statusCode).toBe(201);
  departmentId = created.json<{ id: string }>().id;

  const [row] = await ownerQuery<{ id: string }>(
    fx.main.id,
    `SELECT id FROM app_user WHERE email = 'admin@main.test'`,
  );
  orderedByUserId = row!.id;
});

afterAll(async () => {
  await closeTestApp(app);
});

afterEach(async () => {
  // This file writes rows for TODAY, which is the one day every other test
  // avoids. Cleaning up after each test keeps the counts below exact rather
  // than "at least", and an exact count is the only kind that catches a patient
  // being listed twice.
  await ownerQuery(fx.main.id, 'DELETE FROM diagnostic_order WHERE tenant_id = $1', [fx.main.id]);
  // Receipts before payments: `receipt_payment_fkey` is RESTRICT, so money that
  // had a receipt cut for it cannot be deleted until the receipt goes — and the
  // print log holds the receipt the same way.
  await ownerQuery(
    fx.main.id,
    `DELETE FROM receipt_print WHERE receipt_id IN (SELECT id FROM receipt WHERE tenant_id = $1)`,
    [fx.main.id],
  );
  await ownerQuery(fx.main.id, 'DELETE FROM receipt WHERE tenant_id = $1', [fx.main.id]);
  await ownerQuery(
    fx.main.id,
    `DELETE FROM payment WHERE invoice_id IN (SELECT id FROM invoice WHERE tenant_id = $1)`,
    [fx.main.id],
  );
  await ownerQuery(fx.main.id, 'DELETE FROM invoice_line WHERE tenant_id = $1', [fx.main.id]);
  await ownerQuery(fx.main.id, 'DELETE FROM invoice WHERE tenant_id = $1', [fx.main.id]);
  await ownerQuery(
    fx.main.id,
    `DELETE FROM appointment WHERE tenant_id = $1 AND start_at >= date_trunc('day', now())`,
    [fx.main.id],
  );
});

async function board(session: Session = frontDesk): Promise<Board> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/day-board',
    headers: { cookie: session.cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json<Board>();
}

/** An appointment TODAY in `status`, for `patientIndex`, with this clinic's doctor. */
async function visit(status: string, patientIndex = 0, hoursFromNow = 1): Promise<string> {
  // Returns the id, because the tests that close a visit have to name one.
  const rows = await ownerQuery<{ id: string }>(
    fx.main.id,
    `INSERT INTO appointment (tenant_id, patient_id, practitioner_id, location_id,
                              start_at, end_at, queue_date, status, visit_type, updated_at)
     VALUES ($1, $2, $3, $4,
             now() + ($5 || ' hours')::interval,
             now() + ($5 || ' hours')::interval + interval '15 minutes',
             (now() AT TIME ZONE 'Asia/Kolkata')::date,
             $6::appointment_status, 'NEW', now())
     RETURNING id`,
    [
      fx.main.id,
      fx.main.patientIds[patientIndex],
      fx.main.practitionerId,
      fx.main.locationId,
      String(hoursFromNow),
      status,
    ],
  );

  return rows[0]!.id;
}

/**
 * A test TODAY in `status`. With no appointment it is a walk-in.
 *
 * `appointmentId` attaches it to a visit, which the database only allows on an
 * INTERNAL order — the biconditional CHECK that keeps a walk-in from claiming a
 * consultation. So the referral source follows from whether one was given.
 */
async function test(status: string, patientIndex = 0, appointmentId: string | null = null) {
  // A COMPLETED order has to name who completed it and when — the database
  // enforces that with `diagnostic_order_completion_is_attributed`, so a
  // fixture cannot mark a test done without saying who did it.
  const done = status === 'COMPLETED';

  await ownerQuery(
    fx.main.id,
    `INSERT INTO diagnostic_order (tenant_id, patient_id, department_id, ordered_by_user_id,
                                   appointment_id, description, status, referral_source,
                                   legacy_unbilled, completed_at, completed_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, $8::uuid, 'Knee X-ray', $5::diagnostic_order_status,
             CASE WHEN $8::uuid IS NULL THEN 'SELF' ELSE 'INTERNAL' END::diagnostic_referral_source,
             true, $6::timestamptz, $7::uuid, now())`,
    [
      fx.main.id,
      fx.main.patientIds[patientIndex],
      departmentId,
      orderedByUserId,
      status,
      done ? new Date().toISOString() : null,
      done ? orderedByUserId : null,
      appointmentId,
    ],
  );

  // Handed back so a test can finish one of several orders. Ignored by the
  // callers that only need the order to exist.
  const [latest] = await ownerQuery<{ id: string }>(
    fx.main.id,
    `SELECT id FROM diagnostic_order WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [fx.main.id],
  );

  return latest!.id;
}

/** Mark an order reported, the way the table insists it be attributed. */
async function finish(orderId: string) {
  await ownerQuery(
    fx.main.id,
    `UPDATE diagnostic_order
        SET status = 'COMPLETED',
            completed_at = now(),
            completed_by_user_id = $2::uuid
      WHERE id = $1::uuid`,
    [orderId, orderedByUserId],
  );
}

describe('where a patient sits on the board', () => {
  it.each([
    ['BOOKED', 'EXPECTED'],
    ['ARRIVED', 'WAITING'],
    ['IN_PROGRESS', 'WITH_DOCTOR'],
    ['AWAITING_TESTS', 'AT_DEPARTMENT'],
    /* Not DONE. The doctor has finished; nobody has said the visit is over,
       and the patient is still in the building. See the close tests below. */
    ['FULFILLED', 'READY_TO_CLOSE'],
    ['CANCELLED', 'NOT_ATTENDING'],
    ['NO_SHOW', 'NOT_ATTENDING'],
  ])('a %s visit shows as %s', async (status, bucket) => {
    await visit(status);

    const b = await board();
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]!.bucket).toBe(bucket);
  });

  it('counts everybody the clinic expected, and not the ones who did not come', async () => {
    await visit('BOOKED', 0);
    await visit('ARRIVED', 1);
    await visit('CANCELLED', 2);

    const b = await board();

    expect(b.counts.total).toBe(2);
    expect(b.counts.not_attending).toBe(1);
  });
});

describe('a patient with both a visit and a test', () => {
  it('appears once, not twice', async () => {
    await visit('ARRIVED', 0);
    await test('PENDING', 0);

    const b = await board();

    // The whole point. Two rows here would also be two in every count.
    expect(b.rows).toHaveLength(1);
    expect(b.counts.total).toBe(1);
  });

  it('carries a tag for each thing they are here for', async () => {
    await visit('ARRIVED', 0);
    await test('PENDING', 0);

    const [row] = (await board()).rows;

    expect(row!.hasVisit).toBe(true);
    expect(row!.hasTest).toBe(true);
  });

  /**
   * The rule that decides the whole board. Finished with the doctor, still
   * waiting on the film: this patient is in the building, and a board that
   * filed them under "Done" would be telling the front desk they had left.
   */
  it('is not done while the test is still outstanding', async () => {
    await visit('FULFILLED', 0);
    await test('PENDING', 0);

    const [row] = (await board()).rows;

    expect(row!.bucket).toBe('AT_DEPARTMENT');
  });

  /**
   * The two names the clinic actually says out loud.
   *
   * "OPD done" and "X-ray done" are different facts about one patient, and the
   * row has to carry both — a chip saying only "Done" on a row where the
   * doctor has finished but the film has not come back would be a lie in the
   * one place the front desk trusts.
   */
  /**
   * The receptionist reads this row, so the answer belongs on it.
   *
   * Reported from the clinic on 27 Oct 2026: "X-ray ordered ek jagah dikhe —
   * receptionist ke liye". `withWhom` names the DOCTOR for anybody who had a
   * consultation, so the board could say somebody was at a department without
   * saying which, and never what test — the answer was on another screen.
   */
  it('names the test and the department it is at', async () => {
    await visit('ARRIVED', 0);
    await test('PENDING', 0);

    const [row] = (await board()).rows;

    expect(row!.tests).toEqual([
      { description: 'Knee X-ray', department: 'Board X-ray', done: false, unpaid: false },
    ]);
    expect(row!.testDepartment).toBe('Board X-ray');
  });

  /**
   * One visit, several tests, and they finish one at a time.
   *
   * Reported from the clinic on 28 Oct 2026: an X-ray, then bloods, then
   * physio. The row carried a flat list of names, so it could not say which
   * were back — and the desk is the one pointing the patient down the
   * corridor.
   */
  it('says which tests are back and which are still running', async () => {
    await visit('AWAITING_TESTS', 0);
    const first = await test('PENDING', 0);
    await test('PENDING', 0);

    await finish(first);

    const [row] = (await board()).rows;

    expect(row!.tests.map((t) => t.done)).toEqual([true, false]);
    // Still somewhere to send them, because one is still running.
    expect(row!.testDepartment).toBe('Board X-ray');
  });

  it('has nowhere left to send them once every test is back', async () => {
    await visit('AWAITING_TESTS', 0);
    const only = await test('PENDING', 0);

    await finish(only);

    const [row] = (await board()).rows;

    /*
     * Null, and the row has moved on. It used to name the first department
     * ordered for the whole visit, long after there was anything to do there.
     */
    expect(row!.testDepartment).toBeNull();
    expect(row!.bucket).toBe('BACK_FROM_TESTS');
  });

  it('leaves them empty for a patient with no test', async () => {
    await visit('ARRIVED', 0);

    const [row] = (await board()).rows;

    expect(row!.tests).toEqual([]);
    expect(row!.testDepartment).toBeNull();
  });

  it('says nothing about a test the patient declined', async () => {
    // Not something anybody is waiting for, so not something the desk should
    // be pointing a patient down the corridor for.
    await visit('ARRIVED', 0);
    await test('DECLINED', 0);

    expect((await board()).rows[0]!.tests).toEqual([]);
  });

  it('says which parts are done, separately', async () => {
    await visit('FULFILLED', 0);
    await test('PENDING', 0);

    const [row] = (await board()).rows;

    expect(row!.opdDone).toBe(true);
    // Not finished at the department, so no name to put on a chip.
    expect(row!.testsDoneIn).toBeNull();
  });

  it('names the department once every test is back', async () => {
    await visit('AWAITING_TESTS', 0);
    await test('COMPLETED', 0);

    const [row] = (await board()).rows;

    // The chip reads "Board X-ray done" from this.
    expect(row!.testsDoneIn).toBe('Board X-ray');
    // The doctor has not signed off — they have not seen the film yet.
    expect(row!.opdDone).toBe(false);
  });

  it('is ready to close once both are finished', async () => {
    await visit('FULFILLED', 0);
    await test('COMPLETED', 0);

    const [row] = (await board()).rows;

    // Everything clinical is done; the desk has not sent them home yet.
    expect(row!.bucket).toBe('READY_TO_CLOSE');
  });

  /**
   * THE STATE THE CLINIC HAD AND THE BOARD DID NOT.
   *
   * Sent out for a film, film is back, doctor has not seen it. Until this
   * existed the patient read as AT_DEPARTMENT — identical to lying under the
   * machine — so nobody was looking for them, and they sat in the corridor
   * until they complained.
   */
  it('is back from tests once the film is in and the visit is still out', async () => {
    await visit('AWAITING_TESTS', 0);
    await test('COMPLETED', 0);

    const [row] = (await board()).rows;

    expect(row!.bucket).toBe('BACK_FROM_TESTS');
  });

  it('is still at the department while any test is outstanding', async () => {
    // One film back, one still on the machine. They have not finished there.
    await visit('AWAITING_TESTS', 0);
    await test('COMPLETED', 0);
    await test('PENDING', 0);

    const [row] = (await board()).rows;

    expect(row!.bucket).toBe('AT_DEPARTMENT');
  });

  it('does not claim somebody is back from tests who never went', async () => {
    // Sent out, nothing has come back. This is the ordinary away state.
    await visit('AWAITING_TESTS', 0);
    await test('PENDING', 0);

    expect((await board()).rows[0]!.bucket).toBe('AT_DEPARTMENT');
  });
});

/**
 * Closing a visit, which is not the same act as finishing it.
 *
 * FULFILLED is the doctor's sign-off. Closing is the desk sending the patient
 * home, and the gap between them is where a clinic's afternoon actually lives:
 * people who are finished with, still here, and still somebody's problem.
 */
/**
 * The way out for a patient who is not having their test.
 *
 * Reported 27 Oct 2026: a row at a department with an unpaid test offered
 * Collect and nothing else, so "I cannot pay for it today" was a dead end on
 * the one screen the clinic works from.
 */
describe('a test the patient is not having', () => {
  /* `kinds` further down belongs to another describe; this block sits above it. */
  const stepKinds = (row: { nextSteps: Array<{ kind: string }> }) =>
    row.nextSteps.map((s) => s.kind);

  it('offers cancel when there is no charge to take off', async () => {
    // `declineOrder` refuses an order with no invoice line — calling a legacy
    // or free-text test "declined" would put a commercial answer on a clinical
    // record. Drawing Decline here would be a button the server then refuses.
    const id = await visit('AWAITING_TESTS', 0);
    await test('PENDING', 0, id);

    const steps = stepKinds((await board()).rows[0]!);
    expect(steps).toContain('CANCEL_TEST');
    expect(steps).not.toContain('DECLINE_TEST');
  });

  it('puts it last, so it is never the thing the row is telling you to do', async () => {
    const id = await visit('AWAITING_TESTS', 0);
    await test('PENDING', 0, id);

    const steps = stepKinds((await board()).rows[0]!);

    // Whatever else is on the row, the way out is behind it.
    expect(steps[steps.length - 1]).toBe('CANCEL_TEST');
  });

  it('is not offered once the test is done', async () => {
    const id = await visit('AWAITING_TESTS', 0);
    await test('COMPLETED', 0, id);

    const steps = stepKinds((await board()).rows[0]!);
    expect(steps).not.toContain('DECLINE_TEST');
    expect(steps).not.toContain('CANCEL_TEST');
  });
});

describe('closing a visit', () => {
  async function close(appointmentId: string, session = frontDesk) {
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appointmentId}/close`,
      headers: { cookie: session.cookie },
    });
  }

  it('moves the row from ready-to-close to done', async () => {
    const id = await visit('FULFILLED', 0);

    expect((await board()).rows[0]!.bucket).toBe('READY_TO_CLOSE');

    const res = await close(id);
    expect(res.statusCode).toBe(200);

    expect((await board()).rows[0]!.bucket).toBe('DONE');
  });

  it('records who closed it and when', async () => {
    const id = await visit('FULFILLED', 0);
    await close(id);

    const [row] = await ownerQuery<{ closed_at: Date | null; closed_by_user_id: string | null }>(
      fx.main.id,
      `SELECT closed_at, closed_by_user_id FROM appointment WHERE id = $1`,
      [id],
    );

    // The whole reason this is a column and not an inference.
    expect(row?.closed_at).not.toBeNull();
    expect(row?.closed_by_user_id).not.toBeNull();
  });

  it('refuses a visit the doctor has not finished', async () => {
    const id = await visit('IN_PROGRESS', 0);

    const res = await close(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('NOT_FINISHED');
  });

  it('refuses while a test is still out', async () => {
    // Closing here would leave a film nobody is waiting for, on a visit
    // nobody is watching.
    const id = await visit('FULFILLED', 0);
    await test('PENDING', 0, id);

    const res = await close(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('TEST_STILL_PENDING');
  });

  /**
   * Closing is a press on a crowded board, so it can be a mispress.
   *
   * Reported from the clinic on 27 Oct 2026: "agar galti se OPD close kar diya
   * to bhi" — the wrong row was closed and there was no way back short of
   * editing the database.
   */
  it('can be reopened, and says so on the board', async () => {
    const id = await visit('FULFILLED', 0);
    await close(id);
    expect((await board()).rows[0]!.bucket).toBe('DONE');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${id}/reopen`,
      headers: { cookie: frontDesk.cookie },
    });
    expect(res.statusCode).toBe(200);

    expect((await board()).rows[0]!.bucket).toBe('READY_TO_CLOSE');

    const [row] = await ownerQuery<{ closed_at: Date | null; closed_by_user_id: string | null }>(
      fx.main.id,
      `SELECT closed_at, closed_by_user_id FROM appointment WHERE id = $1`,
      [id],
    );
    expect(row?.closed_at).toBeNull();
    expect(row?.closed_by_user_id).toBeNull();
  });

  it('keeps both events in the trail, so the correction is visible', async () => {
    // "Closed at 4:05, reopened at 4:06" is the truth. A visit that was never
    // closed at all is not.
    const id = await visit('FULFILLED', 0);
    await close(id);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${id}/reopen`,
      headers: { cookie: frontDesk.cookie },
    });

    const actions = await ownerQuery<{ action: string }>(
      fx.main.id,
      `SELECT action FROM audit_event WHERE resource_id = $1 ORDER BY occurred_at`,
      [id],
    );
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['appointment.close', 'appointment.reopen']),
    );
  });

  it('refuses to reopen a visit that is already open', async () => {
    const id = await visit('FULFILLED', 0);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${id}/reopen`,
      headers: { cookie: frontDesk.cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('NOT_CLOSED');
  });

  it('offers reopening as a step on a closed row', async () => {
    const id = await visit('FULFILLED', 0);
    await close(id);

    expect((await board()).rows[0]!.nextSteps.map((st: { kind: string }) => st.kind)).toContain(
      'REOPEN_VISIT',
    );
  });

  it('refuses to close the same visit twice', async () => {
    const id = await visit('FULFILLED', 0);
    expect((await close(id)).statusCode).toBe(200);

    const again = await close(id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details?.code).toBe('ALREADY_CLOSED');
  });
});

describe('a walk-in test, which has no appointment at all', () => {
  it('appears on the board', async () => {
    await test('PENDING', 0);

    const b = await board();

    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]!.bucket).toBe('AT_DEPARTMENT');
    expect(b.rows[0]!.hasTest).toBe(true);
    expect(b.rows[0]!.hasVisit).toBe(false);
  });

  it('is described by the department holding them, since there is no doctor', async () => {
    await test('PENDING', 0);

    expect((await board()).rows[0]!.withWhom).toBe('Board X-ray');
  });

  it('moves to done when the test is finished', async () => {
    await test('COMPLETED', 0);

    expect((await board()).rows[0]!.bucket).toBe('DONE');
  });

  it('is not counted when the patient declined it', async () => {
    await test('DECLINED', 0);

    const b = await board();
    expect(b.counts.total).toBe(0);
    expect(b.counts.not_attending).toBe(1);
  });
});

describe('who may see what', () => {
  it('gives the front desk the whole clinic', async () => {
    await visit('ARRIVED', 0);

    expect((await board(frontDesk)).scope).toBe('CLINIC');
  });

  it('gives an administrator the whole clinic, even though they could be a doctor', async () => {
    await visit('ARRIVED', 0);

    expect((await board(admin)).scope).toBe('CLINIC');
  });

  it('confines a doctor to their own patients', async () => {
    await visit('ARRIVED', 0);

    const b = await board(doctor);

    expect(b.scope).toBe('OWN');
    expect(b.rows).toHaveLength(1);
  });

  /**
   * A walk-in test belongs to no doctor, so it is nobody's own list. It is the
   * clinic's work, and it shows on the clinic's board only.
   */
  it('does not put a walk-in test on a doctor’s own list', async () => {
    await test('PENDING', 0);

    expect((await board(doctor)).rows).toHaveLength(0);
    expect((await board(frontDesk)).rows).toHaveLength(1);
  });

  it('never shows one clinic another’s patients', async () => {
    await visit('ARRIVED', 0);

    const otherDesk = await login(app, fx.other.slug, 'frontdesk@other.test');

    expect((await board(otherDesk)).rows).toHaveLength(0);
  });
});

describe('the money tag', () => {
  it('says nothing at all when the clinic has priced nothing', async () => {
    // Billing is opt-in per tenant. A clinic with no prices would otherwise
    // open this screen to a wall of "pending" against patients who owe nothing.
    await visit('BOOKED', 0);

    const [row] = (await board()).rows;
    expect(row!.visitFee).toBeNull();
    expect(row!.testFee).toBeNull();
  });

  it('reads pending while a bill is outstanding, and paid once it is settled', async () => {
    await visit('BOOKED', 0);

    const [appt] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM appointment WHERE tenant_id = $1 AND start_at >= date_trunc('day', now())`,
      [fx.main.id],
    );

    await ownerQuery(
      fx.main.id,
      `INSERT INTO invoice (tenant_id, appointment_id, patient_id, number, status,
                            subtotal_paise, tax_paise, total_paise, updated_at)
       VALUES ($1, $2, $3, 'BOARD-1', 'UNPAID', 50000, 0, 50000, now())`,
      [fx.main.id, appt!.id, fx.main.patientIds[0]],
    );

    expect((await board()).rows[0]!.visitFee).toBe('PENDING');

    const [invoice] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM invoice WHERE tenant_id = $1 AND number = 'BOARD-1'`,
      [fx.main.id],
    );
    await ownerQuery(
      fx.main.id,
      `INSERT INTO payment (tenant_id, invoice_id, direction, mode, amount_paise,
                            collected_by_user_id)
       VALUES ($1, $2, 'IN', 'CASH', 50000, $3)`,
      [fx.main.id, invoice!.id, orderedByUserId],
    );

    expect((await board()).rows[0]!.visitFee).toBe('PAID');
  });

  it('shows how they paid, once they have', async () => {
    await visit('BOOKED', 0);
    const invoiceId = await billVisit();

    expect((await board()).rows[0]!.paymentMethods).toEqual([]);

    await pay(invoiceId, 'UPI', 50000);

    expect((await board()).rows[0]!.paymentMethods).toEqual(['UPI']);
  });

  it('lists each method once, in the order the money came in', async () => {
    // A consultation on a card and a test settled in cash is two methods for
    // one patient. Two cash payments is still one method.
    await visit('BOOKED', 0);
    const invoiceId = await billVisit();

    await pay(invoiceId, 'CARD', 20000);
    await pay(invoiceId, 'CASH', 20000);
    await pay(invoiceId, 'CASH', 10000);

    expect((await board()).rows[0]!.paymentMethods).toEqual(['CARD', 'CASH']);
  });

  it('does not count a refund as a way the patient paid', async () => {
    // A refund carries a mode too. Listing it would read as a second way they
    // paid rather than money going back to them.
    await visit('BOOKED', 0);
    const invoiceId = await billVisit();

    await pay(invoiceId, 'UPI', 50000);
    await ownerQuery(
      fx.main.id,
      `INSERT INTO payment (tenant_id, invoice_id, direction, mode, amount_paise,
                            collected_by_user_id, correction_kind, reason)
       VALUES ($1, $2, 'REFUND', 'CASH', 50000, $3, 'PATIENT_REFUND', 'Test refund')`,
      [fx.main.id, invoiceId, orderedByUserId],
    );

    expect((await board()).rows[0]!.paymentMethods).toEqual(['UPI']);
  });

  /** The visit's invoice, unpaid. Returns its id. */
  async function billVisit(): Promise<string> {
    const [appt] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM appointment WHERE tenant_id = $1 AND start_at >= date_trunc('day', now())`,
      [fx.main.id],
    );
    const [invoice] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO invoice (tenant_id, appointment_id, patient_id, number, status,
                            subtotal_paise, tax_paise, total_paise, updated_at)
       VALUES ($1, $2, $3, 'PAY-' || floor(random() * 100000)::text, 'UNPAID', 50000, 0, 50000, now())
       RETURNING id`,
      [fx.main.id, appt!.id, fx.main.patientIds[0]],
    );
    return invoice!.id;
  }

  async function pay(invoiceId: string, mode: string, paise: number) {
    await ownerQuery(
      fx.main.id,
      `INSERT INTO payment (tenant_id, invoice_id, direction, mode, amount_paise,
                            collected_by_user_id)
       VALUES ($1, $2, 'IN', $3::payment_mode, $4, $5)`,
      [fx.main.id, invoiceId, mode, paise, orderedByUserId],
    );
  }
});

/**
 * The figures beside the tags.
 *
 * The tags came first, and deliberately: doctors and nurses read this board and
 * hold no `invoice:read`, so money was a tag and never a number. The amount
 * column does not change that rule — it answers to it. The figures are left out
 * of the RESPONSE for a caller who may not see them, rather than sent and
 * hidden by the browser, which is what the first test here pins down.
 */
describe('the amount column', () => {
  it('is left out entirely for a doctor, who holds no invoice:read', async () => {
    await visit('ARRIVED', 0);
    await bill(50000);

    const b = await board(doctor);

    // The row is theirs to see; the money on it is not.
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]!.visitFee).toBe('PENDING');
    expect(b.rows[0]!.money).toBeNull();
    expect(b.money).toBeNull();
  });

  it('reaches the front desk, which does', async () => {
    await visit('ARRIVED', 0);
    await bill(50000);

    const b = await board(frontDesk);

    expect(b.rows[0]!.money).toEqual({ billedPaise: 50000, duePaise: 50000 });
  });

  it('reads nothing charged as zero, not as refused', async () => {
    // A clinic that has priced nothing raises no invoice. That is a different
    // fact from "you may not know", and the column has to tell them apart.
    await visit('BOOKED', 0);

    expect((await board()).rows[0]!.money).toEqual({ billedPaise: 0, duePaise: 0 });
  });

  it('adds the day up: billed, collected, and what is still owed', async () => {
    await visit('ARRIVED', 0);
    const first = await bill(50000);
    await payment(first, 'CASH', 50000);

    await visit('ARRIVED', 1);
    await bill(30000, 1);

    const b = await board();

    expect(b.money).toEqual({ billedPaise: 80000, collectedPaise: 50000, duePaise: 30000 });
  });

  it('leaves a part payment as the remainder', async () => {
    await visit('ARRIVED', 0);
    const invoiceId = await bill(50000);
    await payment(invoiceId, 'UPI', 20000);

    const b = await board();

    expect(b.rows[0]!.money).toEqual({ billedPaise: 50000, duePaise: 30000 });
    expect(b.money!.collectedPaise).toBe(20000);
  });

  /**
   * The arm of the query that is easiest to leave out.
   *
   * A walk-in test has no appointment anywhere, so its bill is reached only
   * through the LINE the order points at. Without that arm the one row on this
   * board that exists purely because money is owed would read as owing nothing.
   */
  it('counts a walk-in test, whose bill hangs off a line rather than an appointment', async () => {
    await walkInTest(30000, 0);

    const b = await board(frontDesk);

    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]!.money).toEqual({ billedPaise: 30000, duePaise: 30000 });
  });

  /**
   * A cancelled bill is not a charge, and is in neither figure — while its tag
   * stays PENDING, because somebody still has to deal with it. "Fee pending"
   * beside a blank amount is the honest pairing; adding the total would report
   * the clinic as having charged for work it explicitly cancelled.
   */
  it('keeps a cancelled bill out of the figures, and still flags it', async () => {
    await visit('ARRIVED', 0);
    const invoiceId = await bill(50000);
    await ownerQuery(
      fx.main.id,
      `UPDATE invoice
          SET status = 'CANCELLED', cancelled_at = now(),
              reason = 'Board test', authorised_by_user_id = $2
        WHERE id = $1`,
      [invoiceId, orderedByUserId],
    );

    const b = await board();

    expect(b.rows[0]!.visitFee).toBe('PENDING');
    expect(b.rows[0]!.money).toEqual({ billedPaise: 0, duePaise: 0 });
    expect(b.money).toEqual({ billedPaise: 0, collectedPaise: 0, duePaise: 0 });
  });

  /** The consultation bill for today's visit, unpaid. Returns its id. */
  async function bill(paise: number, patientIndex = 0): Promise<string> {
    const [appt] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT a.id FROM appointment a
        WHERE a.tenant_id = $1
          AND a.patient_id = $2
          AND a.start_at >= date_trunc('day', now())`,
      [fx.main.id, fx.main.patientIds[patientIndex]],
    );
    const [invoice] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO invoice (tenant_id, appointment_id, patient_id, number, status,
                            subtotal_paise, tax_paise, total_paise, updated_at)
       VALUES ($1, $2, $3, 'AMT-' || floor(random() * 1000000)::text, 'UNPAID', $4, 0, $4, now())
       RETURNING id`,
      [fx.main.id, appt!.id, fx.main.patientIds[patientIndex], paise],
    );
    return invoice!.id;
  }

  /** A walk-in test, billed: no appointment anywhere, reached through its line. */
  async function walkInTest(paise: number, patientIndex = 0) {
    const [invoice] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO invoice (tenant_id, patient_id, number, status,
                            subtotal_paise, tax_paise, total_paise, updated_at)
       VALUES ($1, $2, 'WLK-' || floor(random() * 1000000)::text, 'UNPAID', $3, 0, $3, now())
       RETURNING id`,
      [fx.main.id, fx.main.patientIds[patientIndex], paise],
    );
    const [line] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO invoice_line (tenant_id, invoice_id, description, quantity,
                                 unit_price_paise, discount_paise, tax_rate_basis_points,
                                 tax_paise, total_paise)
       VALUES ($1, $2, 'Knee X-ray', 1, $3, 0, 0, 0, $3)
       RETURNING id`,
      [fx.main.id, invoice!.id, paise],
    );
    await ownerQuery(
      fx.main.id,
      `INSERT INTO diagnostic_order (tenant_id, patient_id, department_id, ordered_by_user_id,
                                     description, status, referral_source, legacy_unbilled,
                                     invoice_line_id, updated_at)
       VALUES ($1, $2, $3, $4, 'Knee X-ray', 'PENDING', 'SELF', false, $5, now())`,
      [fx.main.id, fx.main.patientIds[patientIndex], departmentId, orderedByUserId, line!.id],
    );
  }

  async function payment(invoiceId: string, mode: string, paise: number) {
    await ownerQuery(
      fx.main.id,
      `INSERT INTO payment (tenant_id, invoice_id, direction, mode, amount_paise,
                            collected_by_user_id)
       VALUES ($1, $2, 'IN', $3::payment_mode, $4, $5)`,
      [fx.main.id, invoiceId, mode, paise, orderedByUserId],
    );
  }
});

/**
 * WHAT THIS PATIENT NEEDS NEXT.
 *
 * The board stopped being a list and became the screen people work from, so
 * each row carries the steps the patient is waiting on, most blocking first.
 * Who may perform which of them is decided where the buttons are drawn and
 * enforced again by each endpoint — what is pinned down here is the ORDER, and
 * that money comes before the thing it gates.
 */
describe('what a row says to do next', () => {
  const kinds = (row: Row) => row.nextSteps.map((s) => s.kind);

  it('asks for the money before the check-in, because the gate refuses it anyway', async () => {
    await visit('BOOKED', 0);
    await bill(50000);

    const [row] = (await board()).rows;

    // Not CHECK_IN first: `blockingReason` would refuse that check-in, and a
    // button the server refuses is worse than no button. MARK_NO_SHOW rides
    // along at the end on every booked row and is never the first thing.
    expect(kinds(row!)).toEqual(['COLLECT', 'MARK_NO_SHOW']);
    expect(row!.nextSteps[0]!.duePaise).toBe(50000);
  });

  it('asks for the check-in once the bill is clear', async () => {
    await visit('BOOKED', 0);
    const invoiceId = await bill(50000);
    await payment(invoiceId, 'CASH', 50000);

    const [row] = (await board()).rows;

    expect(kinds(row!)).toEqual(['CHECK_IN', 'MARK_NO_SHOW']);
    expect(row!.nextSteps[0]!.appointmentId).toBeTruthy();
  });

  it('asks the doctor to start once they are waiting', async () => {
    await visit('ARRIVED', 0);

    expect(kinds((await board()).rows[0]!)).toEqual(['START']);
  });

  /**
   * The row that makes a LIST necessary rather than a single step.
   *
   * Sitting with the doctor, and just sent for a test they have not paid for.
   * The desk's next move is the money; the doctor's is to carry on. Both are
   * true, so both are sent, and each screen takes the first it can act on.
   */
  it('asks for both when the desk and the doctor want different things', async () => {
    await visit('IN_PROGRESS', 0);
    await bill(50000);

    // FINISH trails them both: the money is blocking, opening the consultation
    // is what the doctor wants, and closing the visit is the one that cannot be
    // undone.
    expect(kinds((await board()).rows[0]!)).toEqual(['COLLECT', 'RESUME', 'FINISH']);
  });

  /**
   * The doctor closes the OPD from the board. Offered after RESUME so that
   * opening the consultation stays the harmless default — a finished visit
   * cannot be unfinished.
   */
  it('offers finishing the visit, behind opening it', async () => {
    await visit('IN_PROGRESS', 0);

    expect(kinds((await board()).rows[0]!)).toEqual(['RESUME', 'FINISH']);
  });

  it('does not offer finishing a visit nobody has started', async () => {
    // The server only moves IN_PROGRESS to FULFILLED, so anywhere else the
    // button would be a refusal waiting to happen.
    await visit('ARRIVED', 0);
    expect(kinds((await board()).rows[0]!)).not.toContain('FINISH');

    await ownerQuery(fx.main.id, 'DELETE FROM appointment WHERE tenant_id = $1', [fx.main.id]);

    await visit('FULFILLED', 0);
    expect(kinds((await board()).rows[0]!)).not.toContain('FINISH');
  });

  /**
   * A visit with a test on it has TWO bills, and the row has to say so.
   *
   * Reported from the clinic on 27 Oct 2026 as "the money — I don't
   * understand it": the Due column summed both bills while the Collect button
   * carried the oldest one's balance alone, so the row read "₹1,000.00 due …
   * Collect ₹500.00" and nothing said a second bill existed.
   */
  it('says how many bills are owing, so the button and the column agree', async () => {
    await visit('AWAITING_TESTS', 0);
    await billedTest(0);

    const [row] = (await board()).rows;
    const collect = row!.nextSteps.find((s: { kind: string }) => s.kind === 'COLLECT') as
      { duePaise: number; billsOwing: number } | undefined;

    expect(collect).toBeDefined();
    // One unpaid bill here — the test's. The count is honest either way, and
    // the browser only writes "1 of n" when n is more than one.
    expect(collect!.billsOwing).toBe(1);
    expect(row!.money!.duePaise).toBe(collect!.duePaise);
  });

  it('counts both when the consultation and the test are each owed', async () => {
    const id = await visit('AWAITING_TESTS', 0);
    await billedTest(0);
    // A second, older bill against the visit itself — the consultation's.
    await ownerQuery(
      fx.main.id,
      `INSERT INTO invoice (tenant_id, patient_id, appointment_id, number, status,
                            subtotal_paise, tax_paise, total_paise, issued_at, updated_at)
       VALUES ($1, $2, $3, 'CONS-' || floor(random() * 1000000)::text, 'UNPAID',
               50000, 0, 50000, now() - interval '1 hour', now())`,
      [fx.main.id, fx.main.patientIds[0], id],
    );

    const [row] = (await board()).rows;
    const collect = row!.nextSteps.find((s: { kind: string }) => s.kind === 'COLLECT') as
      { duePaise: number; billsOwing: number } | undefined;

    expect(collect!.billsOwing).toBe(2);
    // The button opens the OLDEST bill, which is the consultation's — so its
    // figure is deliberately smaller than the row's total.
    expect(collect!.duePaise).toBe(50000);
    expect(row!.money!.duePaise).toBe(80000);
  });

  it('offers the department its test only once that test is paid for', async () => {
    await visit('AWAITING_TESTS', 0);
    const orderId = await billedTest(0);

    /*
     * Unpaid: the result cannot be released, so the row asks for the money and
     * says nothing about recording anything.
     *
     * DECLINE_TEST beside it since 27 Oct 2026 — "I cannot pay for it today"
     * used to be a dead end here. It is last, so the row still TELLS you to
     * collect; the browser draws it as the quiet button beside that.
     */
    expect(kinds((await board()).rows[0]!)).toEqual(['COLLECT', 'DECLINE_TEST']);

    const [invoice] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT i.id FROM invoice i
         JOIN invoice_line l ON l.invoice_id = i.id
         JOIN diagnostic_order o ON o.invoice_line_id = l.id
        WHERE o.id = $1`,
      [orderId],
    );
    await payment(invoice!.id, 'CASH', 30000);

    const after = (await board()).rows[0]!;
    /*
     * Paid: the department can get on with it. The way out stays on the row —
     * a patient who has paid can still refuse the test, and declining then is
     * the same act the finance desk's own Decline button has always done,
     * which leaves a credit on the bill for finance to settle.
     */
    expect(kinds(after)).toEqual(['RECORD_RESULT']);
    expect(after.nextSteps[0]!.orderId).toBe(orderId);
  });

  /**
   * A RECEIPT, NOT MERELY A PAYMENT.
   *
   * Money can exist without a receipt: `collectPayment` writes one, and
   * anything recorded another way — a seeded clinic, or a payment taken before
   * receipts shipped — has none. The button used to be offered for any money
   * in, and printing then answered "No receipt for that payment" with a patient
   * waiting at the counter for the paper.
   */
  it('offers no receipt for money that never had one', async () => {
    await visit('FULFILLED', 0);
    const invoiceId = await bill(50000);
    await payment(invoiceId, 'CASH', 50000);

    expect(kinds((await board()).rows[0]!)).not.toContain('RECEIPT');
  });

  it('offers a receipt once the visit is finished and the money has one', async () => {
    await visit('FULFILLED', 0);
    const invoiceId = await bill(50000);
    const paymentId = await payment(invoiceId, 'CASH', 50000);
    await receiptFor(paymentId, invoiceId, 50000);

    const row = (await board()).rows[0]!;

    /* CLOSE_VISIT first: the patient is at the desk on their way out, and
       sending them home is the step that moves them on. The receipt is still
       there, and is what the desk prints while they are standing there. */
    expect(kinds(row)).toEqual(['CLOSE_VISIT', 'RECEIPT']);
    expect(row.nextSteps[1]!.paymentId).toBe(paymentId);
  });

  /**
   * COLLECT carries a figure, so it answers to the same rule as the amount
   * column: a caller who may not see money is not sent it at all. Nothing is
   * lost — every role that may collect also holds `invoice:read`.
   */
  it('never sends the money step to somebody who may not see money', async () => {
    await visit('BOOKED', 0);
    await bill(50000);

    const row = (await board(doctor)).rows[0]!;

    expect(kinds(row)).not.toContain('COLLECT');
    expect(row.money).toBeNull();
  });

  it('asks nothing of a patient who did not come, beyond their bill', async () => {
    await visit('NO_SHOW', 0);
    await bill(50000);

    // The money is still owed. Nobody is chasing them around the clinic.
    expect(kinds((await board()).rows[0]!)).toEqual(['COLLECT']);
  });

  /** The visit's bill, unpaid. Returns its id. */
  async function bill(paise: number, patientIndex = 0): Promise<string> {
    const [appt] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM appointment
        WHERE tenant_id = $1 AND patient_id = $2 AND start_at >= date_trunc('day', now())`,
      [fx.main.id, fx.main.patientIds[patientIndex]],
    );
    const [invoice] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO invoice (tenant_id, appointment_id, patient_id, number, status,
                            subtotal_paise, tax_paise, total_paise, updated_at)
       VALUES ($1, $2, $3, 'STEP-' || floor(random() * 1000000)::text, 'UNPAID', $4, 0, $4, now())
       RETURNING id`,
      [fx.main.id, appt!.id, fx.main.patientIds[patientIndex], paise],
    );
    return invoice!.id;
  }

  /** A pending test with a charge of its own. Returns the order id. */
  async function billedTest(patientIndex = 0): Promise<string> {
    const [invoice] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO invoice (tenant_id, patient_id, number, status,
                            subtotal_paise, tax_paise, total_paise, updated_at)
       VALUES ($1, $2, 'TST-' || floor(random() * 1000000)::text, 'UNPAID', 30000, 0, 30000, now())
       RETURNING id`,
      [fx.main.id, fx.main.patientIds[patientIndex]],
    );
    const [line] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO invoice_line (tenant_id, invoice_id, description, quantity,
                                 unit_price_paise, discount_paise, tax_rate_basis_points,
                                 tax_paise, total_paise)
       VALUES ($1, $2, 'Knee X-ray', 1, 30000, 0, 0, 0, 30000)
       RETURNING id`,
      [fx.main.id, invoice!.id],
    );
    const [order] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO diagnostic_order (tenant_id, patient_id, department_id, ordered_by_user_id,
                                     description, status, referral_source, legacy_unbilled,
                                     invoice_line_id, updated_at)
       VALUES ($1, $2, $3, $4, 'Knee X-ray', 'PENDING', 'SELF', false, $5, now())
       RETURNING id`,
      [fx.main.id, fx.main.patientIds[patientIndex], departmentId, orderedByUserId, line!.id],
    );
    return order!.id;
  }

  async function payment(invoiceId: string, mode: string, paise: number): Promise<string> {
    const [row] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO payment (tenant_id, invoice_id, direction, mode, amount_paise,
                            collected_by_user_id)
       VALUES ($1, $2, 'IN', $3::payment_mode, $4, $5)
       RETURNING id`,
      [fx.main.id, invoiceId, mode, paise, orderedByUserId],
    );
    return row!.id;
  }

  /** The receipt `collectPayment` would have written for that money. */
  async function receiptFor(paymentId: string, invoiceId: string, paise: number) {
    await ownerQuery(
      fx.main.id,
      `INSERT INTO receipt
         (tenant_id, payment_id, invoice_id, number, total_charged_paise,
          discount_paise, tax_paise, payable_paise, paid_now_paise, balance_paise)
       VALUES ($1, $2, $3, 'RCT-' || floor(random() * 1000000)::text, $4, 0, 0, $4, $4, 0)`,
      [fx.main.id, paymentId, invoiceId, paise],
    );
  }
});

/**
 * A patient who never came.
 *
 * Nothing in this clinic marks a no-show: there is no nightly job, and the
 * button only landed on 27 Oct 2026. So a missed visit sits at BOOKED for ever,
 * and the board used to say "Expected" about a day three weeks gone. The bucket
 * is inferred from the date instead, which fixes every past day already in the
 * database without touching a row.
 */
/**
 * A patient seen twice in one day.
 *
 * Reported from the clinic on 28 Oct 2026: "Close visit says it is already
 * closed, but the patient is still on the board". The row took whichever
 * appointment the database returned first, so its STAGE could come from the
 * live visit and its ID from the closed one. Closing then answered about a
 * visit nobody was looking at, and the row stayed because the other was open.
 *
 * The id is the target of every action on the row, not just the close button.
 */
describe('a patient with two visits in one day', () => {
  async function closedVisit() {
    const id = await visit('FULFILLED', 0, -3);
    await ownerQuery(
      fx.main.id,
      `UPDATE appointment SET closed_at = now(), closed_by_user_id = $2::uuid WHERE id = $1::uuid`,
      [id, orderedByUserId],
    );
    return id;
  }

  it('acts on the visit that is still open, not the closed one', async () => {
    await closedVisit();
    const live = await visit('FULFILLED', 0, 1);

    const [row] = (await board()).rows;

    // Ready to close comes from the open visit, so the id must too.
    expect(row!.bucket).toBe('READY_TO_CLOSE');
    expect(row!.appointmentId).toBe(live);
  });

  it('prefers a visit in progress over one the doctor has finished', async () => {
    await visit('FULFILLED', 0, -2);
    const inRoom = await visit('IN_PROGRESS', 0, 1);

    const [row] = (await board()).rows;

    expect(row!.bucket).toBe('WITH_DOCTOR');
    expect(row!.appointmentId).toBe(inRoom);
  });

  it('falls back to the closed visit when there is nothing else', async () => {
    const only = await closedVisit();

    const [row] = (await board()).rows;

    expect(row!.bucket).toBe('DONE');
    expect(row!.appointmentId).toBe(only);
  });
});

describe('a visit nobody attended', () => {
  const stepKinds = (row: Row) => row.nextSteps.map((s) => s.kind);

  /** The clinic's own date, `days` ago, as `YYYY-MM-DD`. */
  async function clinicDaysAgo(days: number): Promise<string> {
    const rows = await ownerQuery<{ d: string }>(
      fx.main.id,
      `SELECT (((now() AT TIME ZONE 'Asia/Kolkata')::date
                 - ($1 || ' days')::interval)::date)::text AS d`,
      [String(days)],
    );

    return rows[0]!.d;
  }

  /** A BOOKED appointment on a day that has gone, left exactly as it was. */
  async function bookedDaysAgo(days: number): Promise<void> {
    await ownerQuery(
      fx.main.id,
      `INSERT INTO appointment (tenant_id, patient_id, practitioner_id, location_id,
                                start_at, end_at, queue_date, status, visit_type, updated_at)
       VALUES ($1, $2, $3, $4,
               now() - ($5 || ' days')::interval,
               now() - ($5 || ' days')::interval + interval '15 minutes',
               (((now() AT TIME ZONE 'Asia/Kolkata')::date
                   - ($5 || ' days')::interval)::date),
               'BOOKED', 'NEW', now())`,
      [fx.main.id, fx.main.patientIds[0], fx.main.practitionerId, fx.main.locationId, String(days)],
    );
  }

  async function boardOn(date: string): Promise<Board> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/day-board?date=${date}`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(200);
    return res.json<Board>();
  }

  it('did not come, on a day that has gone', async () => {
    await bookedDaysAgo(9);

    const board = await boardOn(await clinicDaysAgo(9));

    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]!.bucket).toBe('DID_NOT_COME');
  });

  it('is still merely expected on the day itself', async () => {
    // The same row, read on its own day. Somebody booked for this afternoon has
    // not failed to turn up, and this is the line between the two.
    await bookedDaysAgo(0);

    expect((await boardOn(await clinicDaysAgo(0))).rows[0]!.bucket).toBe('EXPECTED');
  });

  it('counts toward the day, because the slot was held for them', async () => {
    await bookedDaysAgo(9);

    const board = await boardOn(await clinicDaysAgo(9));

    expect(board.counts.did_not_come).toBe(1);
    // A day that quietly shrinks when patients fail to arrive cannot be
    // compared with any other day.
    expect(board.counts.total).toBe(1);
    expect(board.counts.expected).toBe(0);
  });

  it('offers the step that writes it down, and offers nothing else', async () => {
    await bookedDaysAgo(9);

    const board = await boardOn(await clinicDaysAgo(9));

    // No check-in, no consultation: nobody is chasing this patient around the
    // clinic. Only the act of recording what happened.
    expect(stepKinds(board.rows[0]!)).toEqual(['MARK_NO_SHOW']);
  });

  it('stops offering it once somebody actually arrived', async () => {
    await ownerQuery(
      fx.main.id,
      `INSERT INTO appointment (tenant_id, patient_id, practitioner_id, location_id,
                                start_at, end_at, queue_date, status, visit_type, updated_at)
       VALUES ($1, $2, $3, $4, now(), now() + interval '15 minutes',
               (now() AT TIME ZONE 'Asia/Kolkata')::date,
               'ARRIVED', 'NEW', now())`,
      [fx.main.id, fx.main.patientIds[0], fx.main.practitionerId, fx.main.locationId],
    );

    const board = await boardOn(await clinicDaysAgo(0));

    expect(board.rows[0]!.bucket).toBe('WAITING');
    expect(stepKinds(board.rows[0]!)).not.toContain('MARK_NO_SHOW');
  });
});
