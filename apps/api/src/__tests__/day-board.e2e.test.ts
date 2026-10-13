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
  hasVisit: boolean;
  hasTest: boolean;
  token: number | null;
  withWhom: string | null;
  visitFee: string | null;
  testFee: string | null;
  paymentMethods: string[];
  /** Null for a caller without `invoice:read`. */
  money: { billedPaise: number; duePaise: number } | null;
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
    payload: { name: 'Board X-ray', isDiagnostic: true },
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
async function visit(status: string, patientIndex = 0, hoursFromNow = 1) {
  await ownerQuery(
    fx.main.id,
    `INSERT INTO appointment (tenant_id, patient_id, practitioner_id, location_id,
                              start_at, end_at, queue_date, status, visit_type, updated_at)
     VALUES ($1, $2, $3, $4,
             now() + ($5 || ' hours')::interval,
             now() + ($5 || ' hours')::interval + interval '15 minutes',
             (now() AT TIME ZONE 'Asia/Kolkata')::date,
             $6::appointment_status, 'NEW', now())`,
    [
      fx.main.id,
      fx.main.patientIds[patientIndex],
      fx.main.practitionerId,
      fx.main.locationId,
      String(hoursFromNow),
      status,
    ],
  );
}

/** A test TODAY in `status`. With no appointment it is a walk-in. */
async function test(status: string, patientIndex = 0) {
  // A COMPLETED order has to name who completed it and when — the database
  // enforces that with `diagnostic_order_completion_is_attributed`, so a
  // fixture cannot mark a test done without saying who did it.
  const done = status === 'COMPLETED';

  await ownerQuery(
    fx.main.id,
    `INSERT INTO diagnostic_order (tenant_id, patient_id, department_id, ordered_by_user_id,
                                   description, status, referral_source, legacy_unbilled,
                                   completed_at, completed_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, 'Knee X-ray', $5::diagnostic_order_status, 'SELF', true,
             $6::timestamptz, $7::uuid, now())`,
    [
      fx.main.id,
      fx.main.patientIds[patientIndex],
      departmentId,
      orderedByUserId,
      status,
      done ? new Date().toISOString() : null,
      done ? orderedByUserId : null,
    ],
  );
}

describe('where a patient sits on the board', () => {
  it.each([
    ['BOOKED', 'EXPECTED'],
    ['ARRIVED', 'WAITING'],
    ['IN_PROGRESS', 'WITH_DOCTOR'],
    ['AWAITING_TESTS', 'AT_DEPARTMENT'],
    ['FULFILLED', 'DONE'],
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

  it('is done once both are finished', async () => {
    await visit('FULFILLED', 0);
    await test('COMPLETED', 0);

    const [row] = (await board()).rows;

    expect(row!.bucket).toBe('DONE');
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
