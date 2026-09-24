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
      url: `/api/v1/invoices/${invoice.id}/waive`,
      headers: { cookie: admin.cookie },
      payload: { reason: 'Staff family, waived by the medical director' },
    });
    expect(waived.statusCode).toBe(201);
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
      url: `/api/v1/invoices/${invoice.id}/waive`,
      headers: { cookie: admin.cookie },
      payload: { reason: 'Staff family, waived by the medical director' },
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

  it('refuses to waive a bill with money against it', async () => {
    const invoice = await invoiceFor(await book());
    await pay(invoice.id, 20000);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/waive`,
      headers: { cookie: admin.cookie },
      payload: { reason: 'Discretionary' },
    });

    // Otherwise the clinic is holding cash with nothing to attribute it to.
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('HAS_PAYMENTS');
  });
});

// --- the ledger is append-only ---------------------------------------------

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
