/**
 * Billing, over HTTP.
 *
 * The centre of this file is `refuses a place in the queue while money is
 * outstanding`. Narveer's clinic collects before the consultation, and that rule
 * is worth exactly as much as the enforcement behind it — a disabled button is
 * not a gate.
 *
 * The gate withholds a POSITION, not a token: since 12 Aug 2026 the token is
 * issued at booking and the patient is holding it long before they reach the
 * desk. What an unpaid visit does not get is `ready_at`.
 *
 * Everything here is in paise. `50000` is ₹500.00. There is no float in this
 * file, and there should never be one.
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
let frontDesk: Session;
let admin: Session;
let doctor: Session;
let otherFrontDesk: Session;

const DAY = clinicDate(7);
const CONSULT_FEE = 50000; // ₹500.00
const FOLLOW_UP_FEE = 30000; // ₹300.00

beforeAll(async () => {
  fx = await seedFixtures();

  // Billing is opt-in per tenant. Only the main clinic is priced, which is what
  // lets every scheduling test written before this module keep passing.
  await seedBilling(fx.main.id, {
    consultationFeePaise: CONSULT_FEE,
    followUpFeePaise: FOLLOW_UP_FEE,
  });

  app = await createTestApp();

  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  doctor = await login(app, fx.main.slug, 'doctor@main.test');
  otherFrontDesk = await login(app, fx.other.slug, 'frontdesk@other.test');
  // The administrator's role requires TOTP, so this enrols on the way in.
  admin = await loginWithMfa(app, fx.main.slug, 'admin@main.test');
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  await resetAppointments();
});

// --- helpers ----------------------------------------------------------------

async function book(patientIndex = 0, slotIndex = 0, visitType?: string) {
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
      ...(visitType ? { visitType } : {}),
    },
  });

  // Surfaced rather than asserted bare: a booking conflict says why, and
  // "expected 409 to be 201" sends you reading the wrong file.
  if (res.statusCode !== 201) {
    throw new Error(`Could not book for the test: ${res.statusCode} ${res.payload}`);
  }
  return res.json().id as string;
}

async function invoiceFor(appointmentId: string, session: Session = frontDesk) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/appointments/${appointmentId}/invoice`,
    headers: { cookie: session.cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/**
 * Every bill a visit has produced.
 *
 * A consultation and a test are two invoices: the test raises its own, because
 * a consultation bill settled before the doctor will not take another line.
 * Until 27 Oct 2026 nothing showed both, so the finance desk took the money for
 * the one on screen and the test stayed unpaid behind a blocked department.
 */
describe('all the bills for one visit', () => {
  it('returns the consultation and the test together, oldest first', async () => {
    const appointmentId = await book();
    const consultation = await invoiceFor(appointmentId);

    // A test's bill: no appointment of its own, tied to the visit instead.
    const [testBill] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO invoice (tenant_id, patient_id, visit_appointment_id, number, status,
                            subtotal_paise, tax_paise, total_paise, issued_at, updated_at)
       VALUES ($1, $2, $3, 'XR-' || floor(random() * 1000000)::text, 'UNPAID',
               45000, 0, 45000, now() + interval '1 minute', now())
       RETURNING id`,
      [fx.main.id, fx.main.patientIds[0], appointmentId],
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/appointments/${appointmentId}/invoices`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(200);
    const { invoices } = res.json<{ invoices: Array<{ id: string }> }>();

    // Oldest first, so the consultation's is what the desk opens on.
    expect(invoices.map((i) => i.id)).toEqual([consultation.id, testBill!.id]);
  });

  it('still lists a bill that has been settled', async () => {
    // "What did this visit cost, and what is left" is one question. Hiding the
    // paid half makes the remainder unexplainable.
    const appointmentId = await book();
    const invoice = await invoiceFor(appointmentId);
    await pay(invoice.id, invoice.balancePaise);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/appointments/${appointmentId}/invoices`,
      headers: { cookie: frontDesk.cookie },
    });

    const { invoices } = res.json<{ invoices: Array<{ id: string; settled: boolean }> }>();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.settled).toBe(true);
  });

  it("never reaches another clinic's visit", async () => {
    const appointmentId = await book();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/appointments/${appointmentId}/invoices`,
      headers: { cookie: otherFrontDesk.cookie },
    });

    // Read through the tenant client, so another clinic's visit has no bills
    // rather than someone else's.
    expect(res.json<{ invoices: unknown[] }>().invoices).toHaveLength(0);
  });
});

/**
 * The money was right; the mode was wrong.
 *
 * Reported from the clinic on 27 Oct 2026: an X-ray paid by UPI and keyed as
 * cash. Nothing was missing from the bill — but the day's drawer claimed money
 * it had never held, and UPI was short by the same.
 */
describe('correcting the mode a payment was taken in', () => {
  async function settledInCash() {
    const appointmentId = await book();
    const invoice = await invoiceFor(appointmentId);
    const res = await pay(invoice.id, invoice.balancePaise, 'CASH');
    expect(res.statusCode).toBe(201);

    const payments = (await invoiceFor(appointmentId)).payments as Array<{
      id: string;
      direction: string;
    }>;
    return { invoice, paymentId: payments.find((p) => p.direction === 'IN')!.id };
  }

  function correctMode(invoiceId: string, body: Record<string, unknown>, session: Session = admin) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/payments/correct-mode`,
      headers: { cookie: session.cookie },
      payload: body,
    });
  }

  it('leaves the bill settled and the money where it really arrived', async () => {
    const { invoice, paymentId } = await settledInCash();

    const res = await correctMode(invoice.id, {
      paymentId,
      mode: 'UPI',
      reference: '4471A2938',
    });
    expect(res.statusCode).toBe(201);

    const after = res.json<{
      balancePaise: number;
      settled: boolean;
      payments: Array<{ direction: string; mode: string; correctionKind: string | null }>;
    }>();

    // The patient still owes nothing — that is the point of doing both halves
    // in one transaction.
    expect(after.balancePaise).toBe(0);
    expect(after.settled).toBe(true);

    // Three rows: the cash that came in, the cash that never really did, and
    // the UPI that did.
    const cashOut = after.payments.filter(
      (p) => p.direction === 'REFUND' && p.correctionKind === 'RECORDED_IN_ERROR',
    );
    const upiIn = after.payments.filter((p) => p.direction === 'IN' && p.mode === 'UPI');
    expect(cashOut).toHaveLength(1);
    expect(upiIn).toHaveLength(1);
  });

  it('refuses to correct a payment to the mode it already has', async () => {
    const { invoice, paymentId } = await settledInCash();

    const res = await correctMode(invoice.id, { paymentId, mode: 'CASH' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('SAME_MODE');
  });

  it('refuses to correct a reversal, which has no mode worth correcting', async () => {
    const { invoice, paymentId } = await settledInCash();
    await correctMode(invoice.id, { paymentId, mode: 'UPI' });

    // The reversal just written. Correcting IT would invent a second one.
    const reversal = (
      await app
        .inject({
          method: 'GET',
          url: `/api/v1/invoices/${invoice.id}`,
          headers: { cookie: admin.cookie },
        })
        .then((r) => r.json<{ payments: Array<{ id: string; direction: string }> }>())
    ).payments.find((p) => p.direction === 'REFUND')!;

    const res = await correctMode(invoice.id, { paymentId: reversal.id, mode: 'CARD' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('NOT_A_COLLECTION');
  });

  it('is refused to the front desk, who must not unwind their own entries', async () => {
    const { invoice, paymentId } = await settledInCash();

    const res = await correctMode(invoice.id, { paymentId, mode: 'UPI' }, frontDesk);
    expect(res.statusCode).toBe(403);
  });

  it('will not touch a payment that belongs to another bill', async () => {
    const { paymentId } = await settledInCash();

    /* A second bill, written straight to the table: booking twice would
       exhaust the slot, and this test is about which invoice a payment hangs
       off rather than about booking. */
    const [other] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO invoice (tenant_id, patient_id, number, status,
                            subtotal_paise, tax_paise, total_paise, updated_at)
       VALUES ($1, $2, 'OTH-' || floor(random() * 1000000)::text, 'UNPAID',
               50000, 0, 50000, now())
       RETURNING id`,
      [fx.main.id, fx.main.patientIds[0]],
    );

    const res = await correctMode(other!.id, { paymentId, mode: 'UPI' });
    expect(res.statusCode).toBe(404);
  });
});

function pay(
  invoiceId: string,
  amountPaise: number,
  mode = 'CASH',
  session: Session = frontDesk,
  reference?: string,
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/invoices/${invoiceId}/payments`,
    headers: { cookie: session.cookie },
    payload: { mode, amountPaise, ...(reference ? { reference } : {}) },
  });
}

function checkIn(appointmentId: string) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/appointments/${appointmentId}/check-in`,
    headers: { cookie: frontDesk.cookie },
  });
}

const domainCode = (res: { json: () => { error: { details?: { code?: string } } } }) =>
  res.json().error.details?.code;

// --- several bills, one handover of money -----------------------------------

/**
 * ONE PATIENT, THREE DOCTORS, THREE BILLS, ONE PAYMENT.
 *
 * Reported from the clinic on 29 Oct 2026: the desk had to run the Collect
 * dialog once per bill while the patient stood there, because the board could
 * only ever open the oldest — which is what its "1 of 3" label was saying.
 *
 * The money fills the OLDEST bill first rather than spreading across all of
 * them. Narveer's call: spread thinly, nothing is ever finished and the patient
 * still owes on every bill.
 */
describe('collecting several bills together', () => {
  /**
   * A second bill on the same patient, a minute newer than the consultation.
   *
   * CANCELLED, WAIVED and DEFERRED carry a reason and whoever authorised it —
   * `invoice_exception_is_explained` refuses them otherwise, which is the
   * database saying an exception without a name attached is not a record.
   */
  async function extraBill(
    appointmentId: string,
    totalPaise: number,
    patientIndex = 0,
    status = 'UNPAID',
  ) {
    const explained = status === 'CANCELLED' || status === 'WAIVED' || status === 'DEFERRED';

    const [authoriser] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM app_user WHERE tenant_id = $1 AND email = 'admin@main.test'`,
      [fx.main.id],
    );

    const [row] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO invoice (tenant_id, patient_id, visit_appointment_id, number, status,
                            subtotal_paise, tax_paise, total_paise, reason,
                            authorised_by_user_id, issued_at, updated_at)
       VALUES ($1, $2, $3, 'XR-' || floor(random() * 1000000)::text, $4,
               $5, 0, $5, $6, $7, now() + interval '1 minute', now())
       RETURNING id`,
      [
        fx.main.id,
        fx.main.patientIds[patientIndex],
        appointmentId,
        status,
        totalPaise,
        explained ? 'Raised for this test' : null,
        explained ? authoriser!.id : null,
      ],
    );
    return row!.id;
  }

  function payAcross(
    patientIndex: number,
    invoiceIds: string[],
    amountPaise: number,
    session: Session = frontDesk,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/patients/${fx.main.patientIds[patientIndex]}/payments`,
      headers: { cookie: session.cookie },
      payload: { mode: 'CASH', amountPaise, invoiceIds },
    });
  }

  /** How many receipts exist for a bill — one per payment, never one per bill. */
  async function receiptCount(invoiceId: string) {
    const rows = await ownerQuery<{ n: string }>(
      fx.main.id,
      'SELECT count(*)::text AS n FROM receipt WHERE invoice_id = $1',
      [invoiceId],
    );
    return Number(rows[0]!.n);
  }

  it('settles both bills from one payment, with a receipt for each', async () => {
    const appointmentId = await book();
    const consultation = await invoiceFor(appointmentId);
    const testBill = await extraBill(appointmentId, 45000);

    const res = await payAcross(0, [consultation.id, testBill], CONSULT_FEE + 45000);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.collectedPaise).toBe(CONSULT_FEE + 45000);
    expect(body.outstandingAfterPaise).toBe(0);
    expect(body.billsSettled).toBe(2);

    // Oldest first, and each bill got exactly its own balance.
    expect(body.allocated.map((a: { invoiceId: string }) => a.invoiceId)).toEqual([
      consultation.id,
      testBill,
    ]);
    expect(body.allocated.map((a: { amountPaise: number }) => a.amountPaise)).toEqual([
      CONSULT_FEE,
      45000,
    ]);

    // ONE RECEIPT PER BILL. Narveer's call, 29 Oct 2026: a combined slip would
    // mean a receipt pointing at many payments, which this table cannot hold.
    expect(await receiptCount(consultation.id)).toBe(1);
    expect(await receiptCount(testBill)).toBe(1);
  });

  it('fills the oldest bill first when there is not enough for both', async () => {
    const appointmentId = await book();
    const consultation = await invoiceFor(appointmentId);
    const testBill = await extraBill(appointmentId, 45000);

    // ₹500 consultation + ₹450 test = ₹950 owing; ₹600 handed over.
    const res = await payAcross(0, [consultation.id, testBill], 60000);

    expect(res.statusCode).toBe(201);
    const body = res.json();

    expect(body.billsSettled).toBe(1);
    expect(body.outstandingAfterPaise).toBe(35000);
    // The consultation is closed outright; the test takes the remainder.
    expect(body.allocated).toEqual([
      expect.objectContaining({ invoiceId: consultation.id, amountPaise: 50000, balancePaise: 0 }),
      expect.objectContaining({ invoiceId: testBill, amountPaise: 10000, balancePaise: 35000 }),
    ]);
  });

  it('leaves the newer bill untouched when the money only covers the oldest', async () => {
    const appointmentId = await book();
    const consultation = await invoiceFor(appointmentId);
    const testBill = await extraBill(appointmentId, 45000);

    const res = await payAcross(0, [consultation.id, testBill], CONSULT_FEE);

    expect(res.statusCode).toBe(201);
    // Absent, not present with zero: nothing was recorded against it, so it has
    // no payment and no receipt to explain.
    expect(res.json().allocated).toHaveLength(1);
    expect(await receiptCount(testBill)).toBe(0);
  });

  it('refuses more than is outstanding across the bills', async () => {
    const appointmentId = await book();
    const consultation = await invoiceFor(appointmentId);
    const testBill = await extraBill(appointmentId, 45000);

    const res = await payAcross(0, [consultation.id, testBill], CONSULT_FEE + 45000 + 100);

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('OVERPAYMENT');
    // Nothing partially recorded on the way to the refusal.
    expect(await receiptCount(consultation.id)).toBe(0);
  });

  it("refuses a bill that is not this patient's", async () => {
    const mine = await invoiceFor(await book(0, 0));
    const theirs = await invoiceFor(await book(1, 1));

    const res = await payAcross(0, [mine.id, theirs.id], 10000);

    expect(res.statusCode).toBe(404);
    expect(await receiptCount(mine.id)).toBe(0);
  });

  it('refuses the lot when one bill is cancelled', async () => {
    const appointmentId = await book();
    const consultation = await invoiceFor(appointmentId);
    const cancelled = await extraBill(appointmentId, 45000, 0, 'CANCELLED');

    const res = await payAcross(0, [consultation.id, cancelled], CONSULT_FEE);

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('INVOICE_CANCELLED');
    // All or nothing: the good bill is not quietly settled alongside a refusal.
    expect(await receiptCount(consultation.id)).toBe(0);
  });

  it('says so when the bills are already settled', async () => {
    const appointmentId = await book();
    const consultation = await invoiceFor(appointmentId);
    await pay(consultation.id, consultation.balancePaise);

    const res = await payAcross(0, [consultation.id], 10000);

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('NOTHING_OWING');
  });

  it("never reaches another clinic's bills", async () => {
    const appointmentId = await book();
    const consultation = await invoiceFor(appointmentId);

    const res = await payAcross(0, [consultation.id], CONSULT_FEE, otherFrontDesk);

    // The patient is not theirs either, so this never gets as far as the bill.
    expect(res.statusCode).toBe(404);
    expect(await receiptCount(consultation.id)).toBe(0);
  });
});

// --- raising the bill -------------------------------------------------------

describe('raising the bill', () => {
  it('raises an invoice with the visit, at the doctor’s fee', async () => {
    const appointmentId = await book();
    const invoice = await invoiceFor(appointmentId);

    expect(invoice.status).toBe('UNPAID');
    expect(invoice.totalPaise).toBe(CONSULT_FEE);
    expect(invoice.balancePaise).toBe(CONSULT_FEE);
    expect(invoice.settled).toBe(false);
    expect(invoice.lines).toHaveLength(1);
    // Serial, from the first number. A receipt is a financial document.
    expect(invoice.number).toMatch(/^INV-\d{6}$/);
  });

  it('charges the follow-up rate for a follow-up', async () => {
    const appointmentId = await book(1, 1, 'FOLLOW_UP');
    const invoice = await invoiceFor(appointmentId);

    expect(invoice.totalPaise).toBe(FOLLOW_UP_FEE);
  });

  it('numbers invoices serially, without gaps', async () => {
    const first = await invoiceFor(await book(0, 0));
    const second = await invoiceFor(await book(1, 1));

    const n = (s: string) => Number(s.split('-')[1]);
    expect(n(second.number)).toBe(n(first.number) + 1);
  });

  it('ties the bill to the visit through both columns, which mean different things', async () => {
    const appointmentId = await book();
    await invoiceFor(appointmentId);

    const [row] = await ownerQuery<{
      appointment_id: string | null;
      visit_appointment_id: string | null;
    }>(
      fx.main.id,
      `SELECT appointment_id, visit_appointment_id FROM invoice WHERE appointment_id = $1`,
      [appointmentId],
    );

    // `appointment_id` is unique and means "this IS the consultation bill".
    expect(row?.appointment_id).toBe(appointmentId);
    // `visit_appointment_id` is not unique and means "this money came out of
    // that visit". Reporting reads the second one, so it has to be set here
    // too — otherwise only invoices old enough to have been backfilled carry
    // it, and every bill raised from now on goes unattributed.
    expect(row?.visit_appointment_id).toBe(appointmentId);
  });

  it('raises nothing for a clinic that has priced nothing', async () => {
    // The other tenant has no services and no doctor fees. It must keep working
    // exactly as it did before this module existed, rather than finding its
    // front desk unable to admit anybody.
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
    // Admitted immediately, with a token, gate open.
    expect(theirs.json().status).toBe('ARRIVED');
    expect(theirs.json().tokenNumber).toBe(1);

    const rows = await ownerQuery(fx.other.id, `SELECT id FROM invoice WHERE appointment_id = $1`, [
      theirs.json().id,
    ]);
    expect(rows).toHaveLength(0);
  });
});

// --- the gate ---------------------------------------------------------------

describe('the pay-first gate', () => {
  it('refuses a place in the queue while money is outstanding', async () => {
    const appointmentId = await book();

    const res = await checkIn(appointmentId);

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('PAYMENT_REQUIRED');
    // The message has to be actionable at the desk: how much, on which invoice.
    expect(res.json().error.message).toContain('₹500.00');
    expect(res.json().error.message).toMatch(/INV-\d{6}/);

    /**
     * And nothing moved.
     *
     * The token is NOT the thing being withheld — it was issued at booking and
     * the patient is holding it. What is withheld is `ready_at`: without it they
     * have no position, so they are not on the waiting list and the doctor will
     * not be handed them.
     */
    const [appointment] = await ownerQuery<{
      status: string;
      token_number: number | null;
      ready_at: Date | null;
    }>(fx.main.id, `SELECT status, token_number, ready_at FROM appointment WHERE id = $1`, [
      appointmentId,
    ]);
    expect(appointment?.status).toBe('BOOKED');
    expect(appointment?.token_number).not.toBeNull();
    expect(appointment?.ready_at).toBeNull();
  });

  it('lets the patient in once the bill is settled', async () => {
    const appointmentId = await book();
    const invoice = await invoiceFor(appointmentId);

    const paid = await pay(invoice.id, CONSULT_FEE, 'UPI', frontDesk, 'UPI-9988');
    expect(paid.statusCode).toBe(201);
    expect(paid.json().status).toBe('PAID');
    expect(paid.json().balancePaise).toBe(0);
    expect(paid.json().settled).toBe(true);

    const res = await checkIn(appointmentId);
    expect(res.statusCode).toBe(200);
    expect(res.json().tokenNumber).toBe(1);
  });

  it('still refuses after a part payment', async () => {
    const appointmentId = await book();
    const invoice = await invoiceFor(appointmentId);

    await pay(invoice.id, 20000);

    const res = await checkIn(appointmentId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('₹300.00');
  });

  it('holds a walk-in at the desk until they pay', async () => {
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
    // Registered and holding a token — a walk-in is booked and registered in one
    // act. What the money governs is the WAITING LIST, so the visit stays BOOKED
    // with no readyAt until the bill is settled.
    expect(res.json().status).toBe('BOOKED');
    expect(res.json().tokenNumber).toBe(1);
    expect(res.json().readyAt).toBeNull();

    const invoice = await invoiceFor(res.json().id);
    await pay(invoice.id, CONSULT_FEE);

    const admitted = await checkIn(res.json().id);
    expect(admitted.statusCode).toBe(200);
    // The same token they were given at the desk. Re-issuing one here would
    // hand back a different number from the one on their slip.
    expect(admitted.json().tokenNumber).toBe(1);
    expect(admitted.json().readyAt).not.toBeNull();
  });

  it('opens for a waived charge', async () => {
    const appointmentId = await book();
    const invoice = await invoiceFor(appointmentId);

    const waived = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/write-offs`,
      headers: { cookie: admin.cookie },
      payload: {
        amountPaise: invoice.totalPaise,
        reason: 'Staff family, waived by the medical director',
      },
    });
    expect(waived.statusCode).toBe(201);
    // Forgiving the whole charge still ends at WAIVED, so the pay-first gate
    // and everything else reading that status are unchanged.
    expect(waived.json().status).toBe('WAIVED');

    expect((await checkIn(appointmentId)).statusCode).toBe(200);
  });

  it('opens for a deferred charge, and it stays on the outstanding list', async () => {
    const appointmentId = await book();
    const invoice = await invoiceFor(appointmentId);

    const deferred = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/defer`,
      headers: { cookie: admin.cookie },
      payload: { reason: 'Emergency, patient has no cash — collect tomorrow' },
    });
    expect(deferred.statusCode).toBe(201);

    expect((await checkIn(appointmentId)).statusCode).toBe(200);

    // Deferred is a recorded exception, not forgiveness. It must remain visible
    // or it becomes a quiet write-off.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/invoices',
      headers: { cookie: frontDesk.cookie },
    });
    const found = list.json().invoices.find((i: { id: string }) => i.id === invoice.id);
    expect(found?.status).toBe('DEFERRED');
    expect(found?.balancePaise).toBe(CONSULT_FEE);
  });

  it('refuses on a cancelled invoice', async () => {
    const appointmentId = await book();
    const invoice = await invoiceFor(appointmentId);

    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/cancel`,
      headers: { cookie: admin.cookie },
      payload: { reason: 'Raised against the wrong patient' },
    });

    const res = await checkIn(appointmentId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('cancelled');
  });
});

// --- taking money -----------------------------------------------------------

describe('taking money', () => {
  it('accepts a split across two modes', async () => {
    const invoice = await invoiceFor(await book());

    const partial = await pay(invoice.id, 20000, 'CASH');
    expect(partial.json().status).toBe('PARTIALLY_PAID');
    expect(partial.json().balancePaise).toBe(30000);

    const rest = await pay(invoice.id, 30000, 'UPI', frontDesk, 'UPI-4471');
    expect(rest.json().status).toBe('PAID');
    expect(rest.json().balancePaise).toBe(0);

    // Two rows, not one total. The drawer is counted by mode.
    expect(rest.json().payments).toHaveLength(2);
    expect(rest.json().payments.map((p: { mode: string }) => p.mode)).toEqual(['CASH', 'UPI']);
  });

  it('refuses to take more than is owed', async () => {
    const invoice = await invoiceFor(await book());

    const res = await pay(invoice.id, CONSULT_FEE + 1);

    // Absorbing it would create a debt to the patient that nobody recorded.
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('OVERPAYMENT');
  });

  it('records who took the money', async () => {
    const invoice = await invoiceFor(await book());
    await pay(invoice.id, CONSULT_FEE);

    const [row] = await ownerQuery<{ collected_by_user_id: string }>(
      fx.main.id,
      `SELECT collected_by_user_id FROM payment WHERE invoice_id = $1`,
      [invoice.id],
    );
    expect(row?.collected_by_user_id).toBeTruthy();
  });

  it('will not let a doctor collect', async () => {
    const invoice = await invoiceFor(await book());

    const res = await pay(invoice.id, CONSULT_FEE, 'CASH', doctor);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('payment:collect');
  });
});

// --- refunds ----------------------------------------------------------------

describe('refunds', () => {
  it('cannot return more than came in', async () => {
    const invoice = await invoiceFor(await book());
    await pay(invoice.id, 20000);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/refunds`,
      headers: { cookie: admin.cookie },
      payload: {
        mode: 'CASH',
        amountPaise: 30000,
        kind: 'PATIENT_REFUND',
        reason: 'Patient left before being seen',
      },
    });

    // The one rule that matters: money cannot leave that never arrived.
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('REFUND_EXCEEDS_PAYMENTS');
  });

  it('reopens the balance when money goes back', async () => {
    const invoice = await invoiceFor(await book());
    await pay(invoice.id, CONSULT_FEE);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/refunds`,
      headers: { cookie: admin.cookie },
      payload: {
        mode: 'CASH',
        amountPaise: CONSULT_FEE,
        kind: 'PATIENT_REFUND',
        reason: 'Doctor unavailable',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('UNPAID');
    expect(res.json().balancePaise).toBe(CONSULT_FEE);
    // A refund is its own row, positive, with a direction — never a negative
    // payment.
    const refund = res.json().payments.find((p: { direction: string }) => p.direction === 'REFUND');
    expect(refund.amountPaise).toBe(CONSULT_FEE);
  });

  it('is refused to the front desk', async () => {
    const invoice = await invoiceFor(await book());
    await pay(invoice.id, CONSULT_FEE);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/refunds`,
      headers: { cookie: frontDesk.cookie },
      payload: {
        mode: 'CASH',
        amountPaise: 10000,
        kind: 'PATIENT_REFUND',
        reason: 'Changed their mind',
      },
    });

    // The person at the desk must not be able to authorise their own exception.
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('payment:refund');
  });

  it('is refused without a reason', async () => {
    const invoice = await invoiceFor(await book());
    await pay(invoice.id, CONSULT_FEE);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/refunds`,
      headers: { cookie: admin.cookie },
      payload: { mode: 'CASH', amountPaise: 10000, kind: 'PATIENT_REFUND' },
    });

    expect(res.statusCode).toBe(400);
  });

  /**
   * FR-BIL-11. Both kinds net to the same figure and are completely different
   * problems: money that LEFT the drawer versus money that was never in it. A
   * default would have silently picked one of those answers for somebody.
   */
  it('is refused without saying which kind of correction it is', async () => {
    const invoice = await invoiceFor(await book());
    await pay(invoice.id, CONSULT_FEE);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/refunds`,
      headers: { cookie: admin.cookie },
      payload: { mode: 'CASH', amountPaise: 10000, reason: 'Entered twice' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('records a reversal distinctly from a refund', async () => {
    const invoice = await invoiceFor(await book());
    await pay(invoice.id, CONSULT_FEE);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/refunds`,
      headers: { cookie: admin.cookie },
      payload: {
        mode: 'CASH',
        amountPaise: CONSULT_FEE,
        kind: 'RECORDED_IN_ERROR',
        reason: 'Entered against the wrong patient',
      },
    });

    expect(res.statusCode).toBe(201);

    const [row] = await ownerQuery<{ correction_kind: string }>(
      fx.main.id,
      `SELECT correction_kind FROM payment WHERE direction = 'REFUND' AND invoice_id = $1`,
      [invoice.id],
    );
    expect(row?.correction_kind).toBe('RECORDED_IN_ERROR');
  });
});

/**
 * FR-BIL-13 — the trail on the invoice itself.
 *
 * The reason was captured from the beginning and returned to nobody. What this
 * asserts is that a FRONT DESK caller — who has no `audit:read` — can see what
 * was corrected, by whom, when and why. Sending a receptionist to find an
 * administrator to answer "why was I charged twice" is the reason clinics keep a
 * paper register.
 */
describe('the correction trail on an invoice', () => {
  it('shows the front desk who corrected it, when and why', async () => {
    const invoice = await invoiceFor(await book());
    await pay(invoice.id, CONSULT_FEE);

    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/refunds`,
      headers: { cookie: admin.cookie },
      payload: {
        mode: 'CASH',
        amountPaise: CONSULT_FEE,
        kind: 'RECORDED_IN_ERROR',
        reason: 'Entered against the wrong patient',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invoice.id}`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(200);
    const reversal = res
      .json<{
        payments: Array<{
          direction: string;
          correctionKind: string | null;
          reason: string | null;
          collectedAt: string;
          collectedBy: { fullName: string | null };
        }>;
      }>()
      .payments.find((p) => p.direction === 'REFUND');

    expect(reversal?.correctionKind).toBe('RECORDED_IN_ERROR');
    expect(reversal?.reason).toBe('Entered against the wrong patient');
    expect(reversal?.collectedBy.fullName).toBeTruthy();
    expect(reversal?.collectedAt).toBeTruthy();
  });

  it('shows the reason a bill was waived', async () => {
    const invoice = await invoiceFor(await book());

    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/write-offs`,
      headers: { cookie: admin.cookie },
      payload: {
        amountPaise: invoice.totalPaise,
        reason: 'Staff family, waived by the medical director',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invoice.id}`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.json<{ status: string; reason: string }>()).toMatchObject({
      status: 'WAIVED',
      reason: 'Staff family, waived by the medical director',
    });
  });
});

describe('the day-end report separates the two kinds', () => {
  it('counts money that left the drawer apart from money never in it', async () => {
    const first = await invoiceFor(await book());
    await pay(first.id, CONSULT_FEE);
    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${first.id}/refunds`,
      headers: { cookie: admin.cookie },
      payload: {
        mode: 'CASH',
        amountPaise: CONSULT_FEE,
        kind: 'PATIENT_REFUND',
        reason: 'Procedure not performed',
      },
    });

    // A different patient AND a different slot. Availability lists every slot,
    // full or not, so a second booking has to name the next one explicitly —
    // that is the convention every other test in this file follows.
    const second = await invoiceFor(await book(1, 1));
    await pay(second.id, CONSULT_FEE);
    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${second.id}/refunds`,
      headers: { cookie: admin.cookie },
      payload: {
        mode: 'CASH',
        amountPaise: CONSULT_FEE,
        kind: 'RECORDED_IN_ERROR',
        reason: 'Recorded twice by mistake',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/day-collection',
      headers: { cookie: admin.cookie },
    });

    const report = res.json<{
      refundedPaise: number;
      patientRefundedPaise: number;
      reversedInErrorPaise: number;
    }>();

    expect(report.patientRefundedPaise).toBe(CONSULT_FEE);
    expect(report.reversedInErrorPaise).toBe(CONSULT_FEE);
    // The existing total still means what it always did, so nothing reading this
    // report today changes behind somebody's back.
    expect(report.refundedPaise).toBe(report.patientRefundedPaise + report.reversedInErrorPaise);
  });

  it('never counts a forgiven charge as money in the drawer', async () => {
    /*
     * THE REGRESSION THIS FEATURE COULD MOST EASILY HAVE CAUSED.
     *
     * A waiver that reached the day-end totals under a payment mode would show
     * cash that was never in the till, and the clinic's count would not
     * reconcile — by exactly the amount of its own generosity, which is the
     * hardest kind of discrepancy to explain.
     *
     * This is the test that justifies `invoice_write_off` being its own table
     * rather than a third `PaymentDirection`: with a direction, three places
     * in this report would have swept it into `direction !== 'IN'` and counted
     * it as money handed back.
     */
    const invoice = await invoiceFor(await book());

    const waived = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/write-offs`,
      headers: { cookie: admin.cookie },
      payload: { amountPaise: invoice.totalPaise, reason: 'Complimentary for a relative' },
    });
    expect(waived.statusCode).toBe(201);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/finance',
      headers: { cookie: admin.cookie },
    });

    const collections = res.json<{
      collections: {
        collectedPaise: number;
        refundedPaise: number;
        writtenOffPaise: number;
        netPaise: number;
        byMode: Array<{ mode: string; collectedPaise: number; refundedPaise: number }>;
      };
    }>().collections;

    // Counted, and counted in its own column.
    expect(collections.writtenOffPaise).toBe(invoice.totalPaise);

    // Nothing was collected and nothing was handed back, so the money the
    // clinic is up by must not move either.
    expect(collections.netPaise).toBe(collections.collectedPaise - collections.refundedPaise);

    // And it belongs to no tender, because none was given.
    const fromModes = collections.byMode.reduce(
      (n, m) => n + m.collectedPaise + m.refundedPaise,
      0,
    );
    expect(fromModes).toBe(collections.collectedPaise + collections.refundedPaise);
  });
});

// --- editing ----------------------------------------------------------------

describe('changing a bill', () => {
  it('adds a chargeable item before payment', async () => {
    const invoice = await invoiceFor(await book());

    const services = await app.inject({
      method: 'GET',
      url: '/api/v1/services',
      headers: { cookie: frontDesk.cookie },
    });
    const dressing = services
      .json()
      .services.find((s: { code: string }) => s.code === 'PROC-DRESS');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/lines`,
      headers: { cookie: frontDesk.cookie },
      payload: { serviceId: dressing.id },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().totalPaise).toBe(CONSULT_FEE + 25000);
    expect(res.json().lines).toHaveLength(2);
  });

  it('refuses to change a bill that has been paid', async () => {
    const invoice = await invoiceFor(await book());
    await pay(invoice.id, CONSULT_FEE);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/lines`,
      headers: { cookie: frontDesk.cookie },
      payload: { description: 'Dressing', unitPricePaise: 25000 },
    });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('ALREADY_PAID');
  });

  it('forgives a bill that has already been paid, and hands the money back', async () => {
    /*
     * REVERSED ON 2 NOV 2026, Narveer's case.
     *
     * Waiving used to refuse any bill with money against it — the reasoning
     * being that the clinic would otherwise hold cash with nothing to
     * attribute it to. Correct as far as it went, but it made the commonest
     * real case impossible: "my relative paid at the desk, I saw him
     * afterwards, I want to make it free". Two or three a day.
     *
     * The answer is not to refuse but to do BOTH halves at once. Refunding
     * alone leaves the bill reading UNPAID, so the desk chases somebody for
     * money it has just handed back; writing off alone leaves the cash
     * unattributed, which is the original objection. One transaction does the
     * two together, so neither state can be reached on its own.
     */
    const invoice = await invoiceFor(await book());
    await pay(invoice.id, 20000);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/write-offs`,
      headers: { cookie: admin.cookie },
      payload: { amountPaise: invoice.totalPaise, reason: 'Complimentary for a relative' },
    });

    expect(res.statusCode).toBe(201);

    const body = res.json<{
      status: string;
      paidPaise: number;
      refundedPaise: number;
      writtenOffPaise: number;
      balancePaise: number;
    }>();

    expect(body.status).toBe('WAIVED');
    // The ₹200 that was actually collected went back out. The rest was never
    // taken, so there was nothing to return — the write-off cancels it.
    expect(body.refundedPaise).toBe(20000);
    expect(body.writtenOffPaise).toBe(invoice.totalPaise);
    expect(body.balancePaise).toBe(0);
  });

  it('will not forgive more than the charge', async () => {
    const invoice = await invoiceFor(await book());

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/write-offs`,
      headers: { cookie: admin.cookie },
      payload: { amountPaise: invoice.totalPaise + 1, reason: 'Complimentary for a relative' },
    });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('WRITE_OFF_EXCEEDS_CHARGE');
  });

  it('undoes a waiver put on the wrong bill, and puts the charge back', async () => {
    // Without this the only fix was editing the database by hand.
    const invoice = await invoiceFor(await book());

    const made = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/write-offs`,
      headers: { cookie: admin.cookie },
      payload: { amountPaise: invoice.totalPaise, reason: 'Complimentary for a relative' },
    });
    const writeOffId = made.json<{ writeOffId: string }>().writeOffId;

    const undone = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/write-offs/${writeOffId}/void`,
      headers: { cookie: admin.cookie },
      payload: { reason: 'Put on the wrong patient' },
    });

    expect(undone.statusCode).toBe(201);

    const body = undone.json<{
      status: string;
      writtenOffPaise: number;
      balancePaise: number;
      reason: string | null;
      writeOffs: { voidedAt: string | null; voidReason: string | null }[];
    }>();

    expect(body.status).toBe('UNPAID');
    expect(body.writtenOffPaise).toBe(0);
    expect(body.balancePaise).toBe(invoice.totalPaise);
    // The bill no longer explains a decision that no longer stands.
    expect(body.reason).toBeNull();
    // Voided, never deleted: both the waiver and the correction survive.
    expect(body.writeOffs).toHaveLength(1);
    expect(body.writeOffs[0]!.voidedAt).not.toBeNull();
    expect(body.writeOffs[0]!.voidReason).toBe('Put on the wrong patient');
  });

  it('forgives part of a bill and leaves the rest owing', async () => {
    // The X-ray made free, the consultation still charged. The old
    // all-or-nothing waive could not say this at all.
    const invoice = await invoiceFor(await book());

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/write-offs`,
      headers: { cookie: admin.cookie },
      payload: { amountPaise: 10000, reason: 'Complimentary for a relative' },
    });

    expect(res.statusCode).toBe(201);

    const body = res.json<{ status: string; balancePaise: number }>();

    /*
     * PARTIALLY_PAID, although nobody paid anything.
     *
     * The status says how much of the bill is SETTLED, and forgiven money
     * settles it exactly as collected money does — there is no
     * "partly waived" status and inventing one would mean touching every
     * reader of this enum. The distinction that matters is kept where it is
     * useful: `paidPaise` is still zero and `writtenOffPaise` carries the
     * ₹100, so the finance report can tell takings from giveaways.
     */
    expect(body.status).toBe('PARTIALLY_PAID');
    expect(body.balancePaise).toBe(invoice.totalPaise - 10000);
  });
});

// --- the ledger is append-only ---------------------------------------------

/**
 * THE EMERGENCY SURCHARGE.
 *
 * A price-list service and an ordinary invoice line — there is no emergency
 * column, no rule and no automatic charge. What the server contributes is one
 * boolean: the queue already calls this visit an emergency, so the desk can be
 * prompted rather than relying on somebody remembering.
 *
 * The charge is deliberately NOT applied by the flag. `queue:prioritise` sets
 * the flag and `invoice:write` raises charges; a flag that billed by itself
 * would let the first permission spend the second, and clearing the flag could
 * not un-bill a patient whose money is already on the invoice.
 */
describe('the emergency surcharge', () => {
  it('is an ordinary charge, added like any other', async () => {
    const invoice = await invoiceFor(await book());
    const surcharge = await service('CONS-EMERG');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/lines`,
      headers: { cookie: frontDesk.cookie },
      payload: { serviceId: surcharge.id },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().totalPaise).toBe(CONSULT_FEE + 30000);
    // Named as charged, so it prints on the receipt and reads the same in ten
    // years after the catalogue has been repriced.
    expect(res.json().lines[1].description).toBe('Emergency surcharge');
    expect(res.json().lines[1].serviceId).toBe(surcharge.id);
  });

  /**
   * The override the desk types in. An emergency is not one price — eleven at
   * night is not two in the afternoon — so the panel pre-fills the clinic's
   * figure and lets it be changed.
   *
   * The service still owns the NAME and the TAX RATE: only the price moves, and
   * the tax is recomputed on what was actually charged. A line that kept the
   * catalogue price while the patient paid something else would disagree with
   * the receipt.
   */
  it('takes the price the desk typed, keeping the service’s name', async () => {
    const invoice = await invoiceFor(await book());
    const surcharge = await service('CONS-EMERG');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/lines`,
      headers: { cookie: frontDesk.cookie },
      payload: { serviceId: surcharge.id, unitPricePaise: 75000 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().totalPaise).toBe(CONSULT_FEE + 75000);
    expect(res.json().lines[1].unitPricePaise).toBe(75000);
    expect(res.json().lines[1].description).toBe('Emergency surcharge');
    // Still the catalogue entry, which is what stops it being offered twice.
    expect(res.json().lines[1].serviceId).toBe(surcharge.id);
  });

  it('is not flagged on an ordinary visit', async () => {
    expect((await invoiceFor(await book())).emergencyVisit).toBe(false);
  });

  it('is flagged once the queue calls the visit an emergency', async () => {
    const appointmentId = await book();
    await flagAsEmergency(appointmentId);

    expect((await invoiceFor(appointmentId)).emergencyVisit).toBe(true);
  });

  /**
   * The flag prompts; it does not charge. A bill that grew a line by itself is
   * a bill nobody at the desk can explain to the patient in front of them.
   */
  it('does not put itself on the bill when the queue is flagged', async () => {
    const appointmentId = await book();
    await flagAsEmergency(appointmentId);

    const invoice = await invoiceFor(appointmentId);

    expect(invoice.totalPaise).toBe(CONSULT_FEE);
    expect(invoice.lines).toHaveLength(1);
  });

  /**
   * A test bill reaches the visit only through `visit_appointment_id`, and an
   * emergency is an emergency whichever of a visit's bills is open.
   */
  it('is flagged on a test bill raised during an emergency visit', async () => {
    const appointmentId = await book();
    await flagAsEmergency(appointmentId);

    const [invoice] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO invoice (tenant_id, number, patient_id, visit_appointment_id,
                            subtotal_paise, total_paise, updated_at)
       VALUES ($1, 'INV-EMERG1', $2, $3, 45000, 45000, now()) RETURNING id`,
      [fx.main.id, fx.main.patientIds[0], appointmentId],
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invoice!.id}`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().emergencyVisit).toBe(true);
  });

  async function service(code: string): Promise<{ id: string }> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/services',
      headers: { cookie: frontDesk.cookie },
    });
    const found = res.json().services.find((s: { code: string }) => s.code === code);
    expect(found, `${code} is not priced in the fixture`).toBeTruthy();
    return found;
  }

  /**
   * Flagged in the database rather than through the endpoint, which requires
   * the patient to be waiting. What is under test is the invoice's reading of
   * the flag; `scheduling.e2e` owns how the flag gets set.
   *
   * All three columns together: `appointment_priority_is_attributed` refuses a
   * reason with nobody and no time against it.
   */
  async function flagAsEmergency(appointmentId: string) {
    await ownerQuery(
      fx.main.id,
      `UPDATE appointment
          SET priority_reason_code = 'EMERGENCY',
              priority_set_at = now(),
              priority_set_by_user_id = (SELECT id FROM app_user WHERE tenant_id = $2 LIMIT 1),
              updated_at = now()
        WHERE id = $1`,
      [appointmentId, fx.main.id],
    );
  }
});

describe('the ledger', () => {
  it('does not let the application edit or delete a payment', async () => {
    // The service has no update path, but this asserts the grant — which is the
    // guarantee that survives a bug in the service. A payment record that can be
    // rewritten cannot reconcile a cash drawer.
    const grants = await ownerQuery<{ privilege_type: string }>(
      fx.main.id,
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'payment' AND grantee = 'healthcloud_app'`,
    );

    expect(grants.map((g) => g.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
  });

  it('does not let the application delete an invoice', async () => {
    const grants = await ownerQuery<{ privilege_type: string }>(
      fx.main.id,
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'invoice' AND grantee = 'healthcloud_app'`,
    );

    // Voided by status, never removed — "we cancelled it" has to be provable.
    expect(grants.map((g) => g.privilege_type).sort()).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });

  it('refuses a line whose total disagrees with its own arithmetic', async () => {
    const invoice = await invoiceFor(await book());

    await expect(
      ownerQuery(
        fx.main.id,
        `INSERT INTO invoice_line
           (tenant_id, invoice_id, description, quantity, unit_price_paise, total_paise)
         VALUES ($1, $2, 'Fiddled', 1, 10000, 999999)`,
        [fx.main.id, invoice.id],
      ),
    ).rejects.toThrow(/invoice_line_total_is_consistent/);
  });

  it('refuses a negative payment', async () => {
    const invoice = await invoiceFor(await book());

    await expect(
      ownerQuery(
        fx.main.id,
        `INSERT INTO payment
           (tenant_id, invoice_id, direction, mode, amount_paise, collected_by_user_id)
         VALUES ($1, $2, 'IN', 'CASH', -5000,
                 (SELECT id FROM app_user LIMIT 1))`,
        [fx.main.id, invoice.id],
      ),
    ).rejects.toThrow(/payment_amount_positive/);
  });
});

// --- the day-end report -----------------------------------------------------

describe('the day-end report', () => {
  it('totals by mode and by collector', async () => {
    const a = await invoiceFor(await book(0, 0));
    const b = await invoiceFor(await book(1, 1));

    await pay(a.id, 20000, 'CASH');
    await pay(a.id, 30000, 'UPI');
    await pay(b.id, CONSULT_FEE, 'CARD');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/day-collection',
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(200);
    const report = res.json();

    expect(report.collectedPaise).toBe(100000);
    expect(report.refundedPaise).toBe(0);
    expect(report.netPaise).toBe(100000);
    expect(report.transactionCount).toBe(3);

    const cash = report.byMode.find((m: { mode: string }) => m.mode === 'CASH');
    expect(cash.collectedPaise).toBe(20000);

    // One collector, everything attributed to them.
    expect(report.byCollector).toHaveLength(1);
    expect(report.byCollector[0].collectedPaise).toBe(100000);
    expect(report.byCollector[0].name).toBe('Front Desk');
  });

  it('nets a refund off the day', async () => {
    const invoice = await invoiceFor(await book());
    await pay(invoice.id, CONSULT_FEE, 'CASH');

    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/refunds`,
      headers: { cookie: admin.cookie },
      payload: {
        mode: 'CASH',
        amountPaise: 20000,
        kind: 'PATIENT_REFUND',
        reason: 'Procedure not performed',
      },
    });

    const report = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/reports/day-collection',
        headers: { cookie: admin.cookie },
      })
    ).json();

    expect(report.collectedPaise).toBe(CONSULT_FEE);
    expect(report.refundedPaise).toBe(20000);
    // The number the drawer is counted against.
    expect(report.netPaise).toBe(30000);
  });

  it('is refused to the front desk', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/day-collection',
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('report:revenue');
  });
});

// --- tenant isolation -------------------------------------------------------

describe('one clinic cannot see another’s money', () => {
  it('refuses to read another clinic’s invoice', async () => {
    const invoice = await invoiceFor(await book());

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invoice.id}`,
      headers: { cookie: otherFrontDesk.cookie },
    });

    expect(res.statusCode).toBe(404);
  });

  it('keeps the day-end report to one clinic', async () => {
    const invoice = await invoiceFor(await book());
    await pay(invoice.id, CONSULT_FEE);

    // The other clinic collected nothing today, and must not see this.
    const theirAdmin = await loginWithMfa(app, fx.other.slug, 'admin@other.test');
    const report = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/reports/day-collection',
        headers: { cookie: theirAdmin.cookie },
      })
    ).json();

    expect(report.collectedPaise).toBe(0);
    expect(report.transactionCount).toBe(0);
  });
});
