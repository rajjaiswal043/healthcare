/**
 * The finance desk's report — FR-FIN-03.
 *
 * The centre of this file is that GROSS, DISCOUNT and NET are three separate
 * figures. A ₹600 consultation given away free and reported as a ₹0 bill leaves
 * the clinic unable to say how much it gave away and unable to pay a doctor on
 * what they billed. Every assertion below checks all three rather than the one
 * that happens to be interesting.
 *
 * Two cases carry the rest.
 *
 * **The ₹0 visit.** A fully discounted consultation has no payment row at all,
 * so any report that counted patients from payments would lose exactly the
 * patient somebody is most likely to ask about. It has to be counted, with its
 * gross and its discount attributed.
 *
 * **The reversed discount.** A discount applied and then taken back was never
 * really given, so it must not be in the totals — but it must still be visible,
 * because a discount that appeared and vanished is something an owner should be
 * able to see and the audit trail records it either way.
 *
 * Everything is integer paise. `60000` is ₹600.00.
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
let finance: Session;
let frontDesk: Session;
let otherFinance: Session;
let adminUserId: string;

const DAY = clinicDate(7);
const CONSULT_FEE = 60000; // ₹600.00

/** Today and yesterday in the clinic's own timezone — the report's unit. */
const TODAY = clinicDate(0);
const YESTERDAY = clinicDate(-1);

beforeAll(async () => {
  fx = await seedFixtures();
  await seedBilling(fx.main.id, { consultationFeePaise: CONSULT_FEE, followUpFeePaise: 30000 });
  // The other clinic is priced too, so a cross-tenant test has something real
  // to fail to see.
  await seedBilling(fx.other.id, { consultationFeePaise: 99000, followUpFeePaise: 50000 });

  app = await createTestApp();

  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  finance = await login(app, fx.main.slug, 'finance@main.test');
  otherFinance = await login(app, fx.other.slug, 'finance@other.test');
  admin = await loginWithMfa(app, fx.main.slug, 'admin@main.test');

  const [row] = await ownerQuery<{ id: string }>(
    fx.main.id,
    `SELECT id FROM app_user WHERE email = 'admin@main.test'`,
  );
  adminUserId = row!.id;
});

afterAll(async () => {
  await closeTestApp(app);
});

// --- fixture ----------------------------------------------------------------

interface Visit {
  appointmentId: string;
  invoiceId: string;
  invoiceNumber: string;
}

/**
 * `onDay` defaults to the shared test day. Visit D needs its own, because a
 * patient may hold only ONE appointment with a given doctor on a given day —
 * and D deliberately reuses the first patient.
 */
async function bookVisit(
  patientIndex: number,
  slotIndex: number,
  onDay: string = DAY,
): Promise<Visit> {
  const day = await app.inject({
    method: 'GET',
    url: `/api/v1/availability?practitionerId=${fx.main.practitionerId}&date=${onDay}`,
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

  const appointmentId = booked.json().id as string;
  const invoice = await app.inject({
    method: 'GET',
    url: `/api/v1/appointments/${appointmentId}/invoice`,
    headers: { cookie: finance.cookie },
  });

  return {
    appointmentId,
    invoiceId: invoice.json().id,
    invoiceNumber: invoice.json().number,
  };
}

function makePromotion(code: string, value: number) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/promotions',
    headers: { cookie: admin.cookie },
    payload: {
      code,
      name: `${code} discount`,
      type: 'PERCENTAGE',
      value,
      validFrom: clinicDate(-60),
      validTo: clinicDate(60),
    },
  });
}

function applyPromotion(invoiceId: string, code: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/invoices/${invoiceId}/promotion`,
    headers: { cookie: finance.cookie },
    payload: { code, authorisedByUserId: adminUserId },
  });
}

function pay(invoiceId: string, amountPaise: number, mode = 'CASH') {
  return app.inject({
    method: 'POST',
    url: `/api/v1/invoices/${invoiceId}/payments`,
    headers: { cookie: finance.cookie },
    payload: { mode, amountPaise },
  });
}

function report(query = '', session: Session = finance) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/reports/finance${query}`,
    headers: { cookie: session.cookie },
  });
}

/**
 * Move an invoice and everything hanging off it back a day.
 *
 * Written through the owner connection because there is no API for backdating —
 * and there should not be. The report is anchored on `issued_at` and
 * `collected_at`, so a range test needs rows on more than one day, and this is
 * the only honest way to get them without waiting until tomorrow.
 */
async function backdateOneDay(invoiceId: string): Promise<void> {
  await ownerQuery(
    fx.main.id,
    `UPDATE invoice SET issued_at = issued_at - interval '1 day' WHERE id = $1`,
    [invoiceId],
  );
  await ownerQuery(
    fx.main.id,
    `UPDATE payment SET collected_at = collected_at - interval '1 day' WHERE invoice_id = $1`,
    [invoiceId],
  );
  await ownerQuery(
    fx.main.id,
    `UPDATE promotion_application SET applied_at = applied_at - interval '1 day' WHERE invoice_id = $1`,
    [invoiceId],
  );
}

/**
 * The fixture, built through the API so every row is one the application really
 * produces:
 *
 *   A  half-discounted, paid in full          ₹600 gross, ₹300 off, ₹300 in
 *   B  fully discounted, no payment at all    ₹600 gross, ₹600 off, ₹0 in
 *   C  discount applied then REVERSED         ₹600 gross, ₹0 off, ₹0 in, still owed
 *   D  yesterday: plain, paid, then refunded  ₹600 gross, ₹0 off, ₹600 in less refunds
 */
let visitA: Visit;
let visitB: Visit;
let visitC: Visit;
let visitD: Visit;

beforeEach(async () => {
  await resetAppointments();
  await ownerQuery(fx.main.id, `TRUNCATE promotion_application, promotion CASCADE`);

  await makePromotion('HALF', 50);
  await makePromotion('FREE', 100);
  await makePromotion('OOPS', 25);

  // A — half off, then paid.
  visitA = await bookVisit(0, 0);
  await applyPromotion(visitA.invoiceId, 'HALF');
  await pay(visitA.invoiceId, 30000, 'UPI');

  // B — the ₹0 visit. No payment row will ever exist for it.
  visitB = await bookVisit(1, 1);
  await applyPromotion(visitB.invoiceId, 'FREE');

  // C — applied, then taken back. Ends the day owing the full fee.
  visitC = await bookVisit(2, 2);
  await applyPromotion(visitC.invoiceId, 'OOPS');
  await app.inject({
    method: 'DELETE',
    url: `/api/v1/invoices/${visitC.invoiceId}/promotion`,
    headers: { cookie: finance.cookie },
    payload: { reversalKind: 'APPLIED_IN_ERROR' },
  });

  // D — yesterday. Paid in full, then both kinds of money going back.
  // A different clinic day, so the one-appointment-per-patient-per-doctor-per-day
  // rule does not collide with visit A. Which day the APPOINTMENT sits on does
  // not affect the report — it is anchored on when the bill was raised.
  visitD = await bookVisit(0, 0, clinicDate(8));
  await pay(visitD.invoiceId, CONSULT_FEE, 'CARD');
  await app.inject({
    method: 'POST',
    url: `/api/v1/invoices/${visitD.invoiceId}/refunds`,
    headers: { cookie: admin.cookie },
    payload: {
      mode: 'CASH',
      amountPaise: 5000,
      reason: 'Patient overpaid at the desk',
      kind: 'PATIENT_REFUND',
    },
  });
  await app.inject({
    method: 'POST',
    url: `/api/v1/invoices/${visitD.invoiceId}/refunds`,
    headers: { cookie: admin.cookie },
    payload: {
      mode: 'CARD',
      amountPaise: 2000,
      reason: 'Entered twice by mistake',
      kind: 'RECORDED_IN_ERROR',
    },
  });
  await backdateOneDay(visitD.invoiceId);
});

// --- the report -------------------------------------------------------------

describe('the range', () => {
  it('defaults to today', async () => {
    const res = await report();

    expect(res.statusCode).toBe(200);
    expect(res.json().from).toBe(TODAY);
    expect(res.json().to).toBe(TODAY);
    expect(res.json().timezone).toBe('Asia/Kolkata');
  });

  it('leaves yesterday out of a today-only report', async () => {
    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();

    // Only A's ₹300 came in today. D's ₹600 was yesterday.
    expect(body.collections.collectedPaise).toBe(30000);
  });

  it('adds both days together over a range', async () => {
    const body = (await report(`?from=${YESTERDAY}&to=${TODAY}`)).json();

    // A ₹300 today + D ₹600 yesterday.
    expect(body.collections.collectedPaise).toBe(90000);
    // D's two refunds, ₹50 and ₹20.
    expect(body.collections.refundedPaise).toBe(7000);
    expect(body.collections.netPaise).toBe(83000);
  });

  it('refuses a range that ends before it starts', async () => {
    expect((await report(`?from=${TODAY}&to=${YESTERDAY}`)).statusCode).toBe(400);
  });

  it('refuses a malformed date', async () => {
    expect((await report('?from=yesterday')).statusCode).toBe(400);
  });
});

describe('collections, split by how the money arrived', () => {
  it('splits by payment method', async () => {
    const body = (await report(`?from=${YESTERDAY}&to=${TODAY}`)).json();
    const byMode = Object.fromEntries(
      body.collections.byMode.map((m: { mode: string }) => [m.mode, m]),
    );

    expect(byMode.UPI.collectedPaise).toBe(30000); // A
    expect(byMode.CARD.collectedPaise).toBe(CONSULT_FEE); // D
    // The ₹20 recorded-in-error went back on the card, the ₹50 refund in cash.
    expect(byMode.CARD.refundedPaise).toBe(2000);
    expect(byMode.CASH.refundedPaise).toBe(5000);
  });
});

describe('by doctor', () => {
  it('counts the fully discounted visit as a patient seen', async () => {
    // The case the whole section turns on. B has no payment row, so a report
    // built from payments would not know the patient existed.
    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();
    const doctor = body.byDoctor.find(
      (d: { practitionerId: string }) => d.practitionerId === fx.main.practitionerId,
    );

    // A, B and C were all today, for three different patients.
    expect(doctor.visits).toBe(3);
    expect(doctor.patientsSeen).toBe(3);
  });

  it('keeps gross, discount and net as three separate figures', async () => {
    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();
    const doctor = body.byDoctor.find(
      (d: { practitionerId: string }) => d.practitionerId === fx.main.practitionerId,
    );

    // Gross is untouched by any discount: three visits at ₹600.
    expect(doctor.grossPaise).toBe(3 * CONSULT_FEE);
    // A's ₹300 plus B's ₹600. C's was reversed, so it is not a discount.
    expect(doctor.discountPaise).toBe(30000 + CONSULT_FEE);
    // And they reconcile.
    expect(doctor.netBilledPaise).toBe(doctor.grossPaise - doctor.discountPaise);
    // Only A paid anything today.
    expect(doctor.netCollectedPaise).toBe(30000);
  });

  it('nets a refund off the doctor collected figure', async () => {
    const body = (await report(`?from=${YESTERDAY}&to=${YESTERDAY}`)).json();
    const doctor = body.byDoctor.find(
      (d: { practitionerId: string }) => d.practitionerId === fx.main.practitionerId,
    );

    expect(doctor.grossPaise).toBe(CONSULT_FEE);
    expect(doctor.discountPaise).toBe(0);
    // ₹600 in, ₹50 and ₹20 back out.
    expect(doctor.netCollectedPaise).toBe(CONSULT_FEE - 7000);
  });
});

describe('by department, and where the work came from', () => {
  /**
   * A radiology department with one priced test, and a walk-in that buys it.
   *
   * Built inside this describe rather than in the shared fixture so the money
   * above it stays exactly as the other sections assert it — adding a test
   * sale to the day totals would have rewritten half this file.
   */
  let xrayDepartmentId: string;
  let xrayId: string;
  let walkInBillPaise: number;

  beforeAll(async () => {
    const dept = await app.inject({
      method: 'POST',
      url: '/api/v1/departments',
      headers: { cookie: admin.cookie },
      payload: { name: 'Radiology', isDiagnostic: true },
    });
    expect(dept.statusCode).toBe(201);
    xrayDepartmentId = dept.json<{ id: string }>().id;

    const service = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/services',
      headers: { cookie: admin.cookie },
      payload: {
        code: 'XR-CHEST',
        name: 'X-ray Chest',
        category: 'DIAGNOSTIC',
        pricePaise: 45000,
        departmentId: xrayDepartmentId,
      },
    });
    expect([200, 201]).toContain(service.statusCode);
    xrayId = service.json<{ id: string }>().id;
    walkInBillPaise = 45000;
  });

  /**
   * The walk-in itself is rebuilt per test, not per suite.
   *
   * The file-level `beforeEach` truncates invoices — and cascades into
   * diagnostic orders through the charge they point at — so anything raised
   * once in `beforeAll` is gone before the first assertion. The department and
   * its priced test survive, because neither is in that truncate.
   */
  beforeEach(async () => {
    const raised = await app.inject({
      method: 'POST',
      url: '/api/v1/diagnostics/walk-in-orders',
      headers: { cookie: admin.cookie },
      payload: {
        patientId: fx.main.patientIds[0],
        serviceIds: [xrayId],
        referralSource: 'EXTERNAL_DOCTOR',
        referrerName: 'Dr S Kulkarni',
      },
    });
    if (raised.statusCode !== 201) {
      throw new Error(`Could not raise the walk-in: ${raised.statusCode} ${raised.payload}`);
    }
  });

  it('gives the department its own billing line, which by-doctor cannot', async () => {
    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();

    const radiology = body.byDepartment.rows.find(
      (r: { departmentId: string }) => r.departmentId === xrayDepartmentId,
    );

    /**
     * The point of FR-DIA-15. This patient never met a doctor, so `byDoctor`
     * files their money under "Not attributed to a doctor" and radiology looks
     * idle. Here it is named.
     */
    expect(radiology.netBilledPaise).toBe(walkInBillPaise);
    expect(radiology.items).toBe(1);
    // Throughput is its own question: a department can be busy and cheap.
    expect(radiology.patientsSeen).toBe(1);
  });

  it('buckets a charge with no department rather than dropping it', async () => {
    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();

    // Consultations are priced without a department, deliberately — a
    // consultation belongs to the doctor who gave it. The money is still money.
    const unassigned = body.byDepartment.rows.find(
      (r: { departmentId: string | null }) => r.departmentId === null,
    );
    expect(unassigned.netBilledPaise).toBeGreaterThan(0);
  });

  it('reports collection at invoice level, and does not pretend it splits', async () => {
    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();

    // Two numbers that do not reconcile, on purpose (decision 10). Billing
    // happens on a line and splits exactly; payment happens on an invoice and
    // does not. The gap between them is the day's unpaid work, and smoothing
    // it away would mean inventing an allocation nobody agreed to.
    expect(body.byDepartment.totalBilledPaise).toBeGreaterThan(body.byDepartment.collectedPaise);

    // Counted against the invoices these rows describe, which is what makes
    // billed and collected comparable. `collections` answers a different
    // question — money that ARRIVED today, on any invoice — and the two are
    // equal here only because nothing older was paid today.
    expect(body.byDepartment.collectedPaise).toBe(body.collections.netPaise);

    // And no row carries a collected figure of its own to be misread.
    for (const row of body.byDepartment.rows) {
      expect(row).not.toHaveProperty('collectedPaise');
    }
  });

  it('splits the work three ways, and names the outside doctor', async () => {
    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();

    const external = body.byReferralSource.find(
      (r: { source: string }) => r.source === 'EXTERNAL_DOCTOR',
    );
    expect(external.tests).toBe(1);
    expect(external.netBilledPaise).toBe(walkInBillPaise);
    expect(external.referrers[0]).toMatchObject({ name: 'Dr S Kulkarni', tests: 1 });

    // All three buckets are always present, including the empty ones — a
    // missing row reads as "no data" and zero reads as "none of this work".
    expect(body.byReferralSource.map((r: { source: string }) => r.source).sort()).toEqual([
      'EXTERNAL_DOCTOR',
      'INTERNAL',
      'SELF',
    ]);
  });

  it("never shows one clinic another's departments", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/finance?from=${TODAY}&to=${TODAY}`,
      headers: { cookie: otherFinance.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(
      res.json().byDepartment.rows.map((r: { departmentId: string | null }) => r.departmentId),
    ).not.toContain(xrayDepartmentId);
  });
});

describe('discounts', () => {
  it('counts only discounts that were actually given', async () => {
    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();

    // A's ₹300 and B's ₹600. C's was applied and taken back, so it was never
    // given and is not here.
    expect(body.discounts.givenCount).toBe(2);
    expect(body.discounts.givenPaise).toBe(30000 + CONSULT_FEE);
    expect(
      body.discounts.given.map((d: { promotionCode: string }) => d.promotionCode).sort(),
    ).toEqual(['FREE', 'HALF']);
  });

  it('shows the reversed discount separately rather than dropping it', async () => {
    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();

    expect(body.discounts.reversedCount).toBe(1);
    expect(body.discounts.reversedPaise).toBe(15000); // 25% of ₹600.00
    expect(body.discounts.reversed[0].promotionCode).toBe('OOPS');
    expect(body.discounts.reversed[0].invoiceNumber).toBe(visitC.invoiceNumber);
    // And it says who took it back, and why.
    expect(body.discounts.reversed[0].reversal.kind).toBe('APPLIED_IN_ERROR');
    expect(body.discounts.reversed[0].reversal.by).toBe('Finance Desk');
  });

  it('keeps the reversed amount out of the given total', async () => {
    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();

    // The assertion that matters most: the two never mix.
    expect(body.discounts.givenPaise).not.toBe(
      body.discounts.givenPaise + body.discounts.reversedPaise,
    );
    expect(
      body.discounts.given.some((d: { promotionCode: string }) => d.promotionCode === 'OOPS'),
    ).toBe(false);
  });

  it('never counts a reversal row as a discount in its own right', async () => {
    // There are three application rows and one reversal row in the database.
    // Counting the reversal directly would report four discounts and double the
    // money that was taken back.
    const rows = await ownerQuery(fx.main.id, `SELECT id FROM promotion_application`);
    expect(rows).toHaveLength(4);

    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();
    expect(body.discounts.givenCount + body.discounts.reversedCount).toBe(3);
  });

  it('names who applied and who authorised each one', async () => {
    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();
    const half = body.discounts.given.find(
      (d: { promotionCode: string }) => d.promotionCode === 'HALF',
    );

    expect(half.appliedBy).toBe('Finance Desk');
    expect(half.authorisedBy).toBe('Administrator');
    expect(half.discountPaise).toBe(30000);
  });

  it('groups the given ones by promotion', async () => {
    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();
    const byCode = Object.fromEntries(
      body.discounts.byPromotion.map((p: { code: string }) => [p.code, p]),
    );

    expect(byCode.FREE.discountPaise).toBe(CONSULT_FEE);
    expect(byCode.HALF.discountPaise).toBe(30000);
    expect(byCode.OOPS).toBeUndefined();
  });
});

describe('outstanding', () => {
  it('lists only bills with something still owed', async () => {
    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();

    // A is paid, B is zero, so only C is owed — and for the full fee, because
    // its discount was taken back.
    expect(body.outstanding.count).toBe(1);
    expect(body.outstanding.totalPaise).toBe(CONSULT_FEE);
    expect(body.outstanding.invoices[0].number).toBe(visitC.invoiceNumber);
    expect(body.outstanding.invoices[0].balancePaise).toBe(CONSULT_FEE);
  });

  it('leaves the fully discounted visit out — nothing is owed on it', async () => {
    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();

    const numbers = body.outstanding.invoices.map((i: { number: string }) => i.number);
    expect(numbers).not.toContain(visitB.invoiceNumber);
  });

  it('shows a deferred bill on its own line', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${visitC.invoiceId}/defer`,
      headers: { cookie: admin.cookie },
      payload: { reason: 'Patient will pay on the next visit' },
    });

    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();

    // An unpaid bill is somebody who has not paid; a deferred one is somebody an
    // administrator decided may pay later. Different conversations.
    expect(body.outstanding.count).toBe(0);
    expect(body.outstanding.deferred.count).toBe(1);
    expect(body.outstanding.deferred.totalPaise).toBe(CONSULT_FEE);
  });

  it('derives the balance from payments, not from the stored status', async () => {
    await pay(visitC.invoiceId, 20000);

    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();
    expect(body.outstanding.invoices[0].balancePaise).toBe(CONSULT_FEE - 20000);
    expect(body.outstanding.invoices[0].paidPaise).toBe(20000);
  });
});

describe('refunds and reversals', () => {
  it('keeps money returned apart from entries recorded in error', async () => {
    const body = (await report(`?from=${YESTERDAY}&to=${YESTERDAY}`)).json();

    // Both reduce the net figure identically. An owner counting the drawer needs
    // to know which left it.
    expect(body.refundsAndReversals.patientRefundedPaise).toBe(5000);
    expect(body.refundsAndReversals.recordedInErrorPaise).toBe(2000);
    expect(body.refundsAndReversals.totalPaise).toBe(7000);
  });

  it('lists each one with its reason and who took it', async () => {
    const body = (await report(`?from=${YESTERDAY}&to=${YESTERDAY}`)).json();
    const entries = body.refundsAndReversals.entries;

    expect(entries).toHaveLength(2);
    expect(entries.map((e: { correctionKind: string }) => e.correctionKind).sort()).toEqual([
      'PATIENT_REFUND',
      'RECORDED_IN_ERROR',
    ]);
    expect(entries.every((e: { reason: string }) => e.reason.length > 0)).toBe(true);
    expect(entries.every((e: { collectedBy: string }) => e.collectedBy === 'Administrator')).toBe(
      true,
    );
  });

  it('reports nothing on a day with no money going back', async () => {
    const body = (await report(`?from=${TODAY}&to=${TODAY}`)).json();

    expect(body.refundsAndReversals.totalPaise).toBe(0);
    expect(body.refundsAndReversals.entries).toHaveLength(0);
  });
});

describe('who may read it, and whose numbers they see', () => {
  it('lets the finance desk read it', async () => {
    expect((await report()).statusCode).toBe(200);
  });

  it('refuses the front desk', async () => {
    // Takes the money, does not get the day's revenue on a screen a waiting
    // room can see.
    expect((await report('', frontDesk)).statusCode).toBe(403);
  });

  it('never shows another clinic figures', async () => {
    const body = (await report(`?from=${YESTERDAY}&to=${TODAY}`, otherFinance)).json();

    // The other clinic billed nothing. If tenant context ever leaked, its report
    // would be full of this one's money.
    expect(body.collections.collectedPaise).toBe(0);
    expect(body.byDoctor).toHaveLength(0);
    expect(body.discounts.givenCount).toBe(0);
    expect(body.outstanding.count).toBe(0);
  });
});
