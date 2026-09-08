/**
 * Promotions over HTTP — FR-PRO-01 and FR-PRO-02.
 *
 * Two rules carry this file, and both are about what the record still says
 * afterwards.
 *
 * **The discount is a line, not a changed price.** A ₹600 consultation given at
 * half price reads ₹600 billed and ₹300 discount, never ₹300 billed. A clinic
 * that records the second cannot say how much it gave away, and cannot pay a
 * doctor on what they billed.
 *
 * **A used promotion is frozen.** It can be switched off; it can never be edited
 * or deleted. An invoice from March has to keep explaining itself in September,
 * and it explains itself by naming a row that has not moved since.
 *
 * Everything here is in paise. `50000` is ₹500.00, and there is no float in this
 * file.
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
let doctor: Session;
let otherAdmin: Session;

/** Ids of the seeded staff, for naming an approver. */
let adminUserId: string;

const DAY = clinicDate(7);
const CONSULT_FEE = 60000; // ₹600.00 — the worked example in the requirements.

beforeAll(async () => {
  fx = await seedFixtures();
  await seedBilling(fx.main.id, { consultationFeePaise: CONSULT_FEE, followUpFeePaise: 30000 });

  app = await createTestApp();

  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  finance = await login(app, fx.main.slug, 'finance@main.test');
  doctor = await login(app, fx.main.slug, 'doctor@main.test');
  admin = await loginWithMfa(app, fx.main.slug, 'admin@main.test');
  otherAdmin = await loginWithMfa(app, fx.other.slug, 'admin@other.test');

  const [row] = await ownerQuery<{ id: string }>(
    fx.main.id,
    `SELECT id FROM app_user WHERE email = 'admin@main.test'`,
  );
  adminUserId = row!.id;
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  await resetAppointments();
  // Promotions are clinic setup, like the service catalogue, so
  // resetAppointments leaves them alone. Each test builds its own.
  await ownerQuery(fx.main.id, `TRUNCATE promotion_application, promotion CASCADE`);
});

// --- helpers ----------------------------------------------------------------

const domainCode = (res: { json: () => { error: { details?: { code?: string } } } }) =>
  res.json().error.details?.code;

function createPromotion(body: Record<string, unknown> = {}, session: Session = admin) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/promotions',
    headers: { cookie: session.cookie },
    payload: {
      code: 'CAMP50',
      name: 'Free eye camp, September',
      type: 'PERCENTAGE',
      value: 50,
      validFrom: clinicDate(-30),
      validTo: clinicDate(30),
      ...body,
    },
  });
}

/** A booked visit with its invoice already raised. */
async function bookedVisit(patientIndex = 0, slotIndex = 0) {
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
  if (res.statusCode !== 201) {
    throw new Error(`Could not book for the test: ${res.statusCode} ${res.payload}`);
  }

  const appointmentId = res.json().id as string;

  const invoice = await app.inject({
    method: 'GET',
    url: `/api/v1/appointments/${appointmentId}/invoice`,
    headers: { cookie: finance.cookie },
  });

  return { appointmentId, invoice: invoice.json() };
}

function applyPromotion(
  invoiceId: string,
  body: Record<string, unknown> = {},
  session: Session = finance,
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/invoices/${invoiceId}/promotion`,
    headers: { cookie: session.cookie },
    payload: { code: 'CAMP50', authorisedByUserId: adminUserId, ...body },
  });
}

function readInvoice(invoiceId: string, session: Session = finance) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/invoices/${invoiceId}`,
    headers: { cookie: session.cookie },
  });
}

// --- who may open today's visit ---------------------------------------------

describe('visit:open, split from holding the diary', () => {
  async function walkIn(session: Session) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/appointments/walk-in',
      headers: { cookie: session.cookie },
      payload: {
        patientId: fx.main.patientIds[2],
        practitionerId: fx.main.practitionerId,
        locationId: fx.main.locationId,
      },
    });
  }

  it('lets the front desk open a walk-in, as it always could', async () => {
    expect((await walkIn(frontDesk)).statusCode).toBe(201);
  });

  it('lets the administrator open a walk-in', async () => {
    expect((await walkIn(admin)).statusCode).toBe(201);
  });

  it('lets finance open a walk-in, so the bill has a visit to attach to', async () => {
    // The whole reason the permission was split. Before this, giving finance
    // the walk-in meant giving it the clinic's diary as well.
    expect((await walkIn(finance)).statusCode).toBe(201);
  });

  it('does not let finance book a future appointment', async () => {
    const day = await app.inject({
      method: 'GET',
      url: `/api/v1/availability?practitionerId=${fx.main.practitionerId}&date=${DAY}`,
      headers: { cookie: finance.cookie },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: { cookie: finance.cookie },
      payload: {
        patientId: fx.main.patientIds[0],
        practitionerId: fx.main.practitionerId,
        locationId: fx.main.locationId,
        startAt: day.json().slots[0].startAt,
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it('does not let finance cancel an appointment', async () => {
    const { appointmentId } = await bookedVisit();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appointmentId}/cancel`,
      headers: { cookie: finance.cookie },
      payload: { reason: 'Patient asked' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('does not let the doctor open a walk-in', async () => {
    // The doctor never held appointment:write either. This asserts the split
    // took nothing away and handed nothing out.
    expect((await walkIn(doctor)).statusCode).toBe(403);
  });
});

// --- defining a promotion ----------------------------------------------------

describe('the administrator sets one up', () => {
  it('creates a percentage promotion', async () => {
    const res = await createPromotion();

    expect(res.statusCode).toBe(201);
    expect(res.json().code).toBe('CAMP50');
    expect(res.json().isActive).toBe(true);
    expect(res.json().editable).toBe(true);
    expect(res.json().timesApplied).toBe(0);
  });

  it('upper-cases the code, so camp50 and CAMP50 are one promotion', async () => {
    const res = await createPromotion({ code: 'camp50' });
    expect(res.json().code).toBe('CAMP50');

    const clash = await createPromotion({ code: 'CAMP50' });
    expect(clash.statusCode).toBe(409);
    expect(domainCode(clash)).toBe('CODE_IN_USE');
  });

  it('lets another clinic use the same code', async () => {
    await createPromotion();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/promotions',
      headers: { cookie: otherAdmin.cookie },
      payload: {
        code: 'CAMP50',
        name: 'Their own camp',
        type: 'PERCENTAGE',
        value: 25,
        validFrom: clinicDate(-1),
      },
    });

    // Codes are unique per clinic. A global constraint would let one clinic's
    // setup fail because of a name another clinic had chosen.
    expect(res.statusCode).toBe(201);
  });

  it('accepts a 100% promotion', async () => {
    expect((await createPromotion({ code: 'FREE', value: 100 })).statusCode).toBe(201);
  });

  it('refuses a percentage above 100', async () => {
    expect((await createPromotion({ code: 'OVER', value: 101 })).statusCode).toBe(400);
  });

  it('refuses a promotion that ends before it begins', async () => {
    const res = await createPromotion({
      code: 'BACKWARDS',
      validFrom: clinicDate(30),
      validTo: clinicDate(-30),
    });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('DATES_OUT_OF_ORDER');
  });

  it('refuses a cap of zero', async () => {
    // Uncapped is "leave it out". A cap of zero would discount nothing while
    // looking like a working promotion.
    expect((await createPromotion({ code: 'CAPZERO', maxDiscountPaise: 0 })).statusCode).toBe(400);
  });

  it('refuses the finance desk', async () => {
    // The control the whole feature rests on: finance applies a known discount
    // and cannot invent one.
    const res = await createPromotion({ code: 'SNEAK' }, finance);
    expect(res.statusCode).toBe(403);
  });

  it('has no delete endpoint', async () => {
    const created = await createPromotion();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/promotions/${created.json().id}`,
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('editing one', () => {
  it('edits a promotion nobody has used', async () => {
    const created = await createPromotion();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/promotions/${created.json().id}`,
      headers: { cookie: admin.cookie },
      payload: { value: 25, name: 'Reduced to a quarter' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().value).toBe(25);
  });

  it('refuses to edit one that has ever been applied', async () => {
    const created = await createPromotion();
    const { invoice } = await bookedVisit();
    expect((await applyPromotion(invoice.id)).statusCode).toBe(201);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/promotions/${created.json().id}`,
      headers: { cookie: admin.cookie },
      payload: { value: 10 },
    });

    // FR-PRO-01. The invoice already discounted by this promotion has to keep
    // reading the same in September as it did today.
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('PROMOTION_IN_USE');
  });

  it('still lets a used promotion be switched off', async () => {
    const created = await createPromotion();
    const { invoice } = await bookedVisit();
    await applyPromotion(invoice.id);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/promotions/${created.json().id}/active`,
      headers: { cookie: admin.cookie },
      payload: { isActive: false },
    });

    // Switching off is the delete, and it stays available forever.
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
    expect(res.json().editable).toBe(false);
    expect(res.json().timesApplied).toBe(1);
  });
});

describe('listing them', () => {
  it('shows finance only what it could use today', async () => {
    await createPromotion();
    await createPromotion({
      code: 'EXPIRED',
      validFrom: clinicDate(-60),
      validTo: clinicDate(-30),
    });
    await createPromotion({ code: 'FUTURE', validFrom: clinicDate(30), validTo: clinicDate(60) });

    const off = await createPromotion({ code: 'SWITCHEDOFF' });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/promotions/${off.json().id}/active`,
      headers: { cookie: admin.cookie },
      payload: { isActive: false },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/promotions?applicable=true',
      headers: { cookie: finance.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().promotions.map((p: { code: string }) => p.code)).toEqual(['CAMP50']);
  });

  it('shows the administrator everything, with usage counts', async () => {
    await createPromotion();
    await createPromotion({
      code: 'EXPIRED',
      validFrom: clinicDate(-60),
      validTo: clinicDate(-30),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/promotions',
      headers: { cookie: admin.cookie },
    });

    expect(res.json().promotions).toHaveLength(2);
    expect(res.json().promotions.every((p: { editable: boolean }) => p.editable)).toBe(true);
  });

  it('does not show another clinic promotions', async () => {
    await createPromotion();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/promotions',
      headers: { cookie: otherAdmin.cookie },
    });

    expect(res.json().promotions).toHaveLength(0);
  });
});

// --- applying one ------------------------------------------------------------

describe('applying a promotion to a bill', () => {
  it('takes half off, and says so on the bill', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    const res = await applyPromotion(invoice.id);
    expect(res.statusCode).toBe(201);
    expect(res.json().discountPaise).toBe(30000);

    const after = (await readInvoice(invoice.id)).json();

    // The fee still reads ₹600. This is the rule the whole feature turns on.
    expect(after.subtotalPaise).toBe(CONSULT_FEE);
    expect(after.discountPaise).toBe(30000);
    expect(after.totalPaise).toBe(30000);
    expect(after.balancePaise).toBe(30000);
    expect(after.lines[0].unitPricePaise).toBe(CONSULT_FEE);
    expect(after.lines[0].discountPaise).toBe(30000);
  });

  it('records who applied it and who authorised it', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();
    await applyPromotion(invoice.id);

    const [row] = await ownerQuery<{
      discount_paise: number;
      applied_by_user_id: string;
      authorised_by_user_id: string;
    }>(
      fx.main.id,
      `SELECT discount_paise, applied_by_user_id, authorised_by_user_id
         FROM promotion_application WHERE invoice_id = $1`,
      [invoice.id],
    );

    expect(row?.discount_paise).toBe(30000);
    expect(row?.authorised_by_user_id).toBe(adminUserId);
    // Applied by the session, not by anything the caller sent.
    expect(row?.applied_by_user_id).not.toBe(adminUserId);
  });

  it('accepts the promotion by id as well as by code', async () => {
    const created = await createPromotion();
    const { invoice } = await bookedVisit();

    const res = await applyPromotion(invoice.id, {
      code: undefined,
      promotionId: created.json().id,
    });
    expect(res.statusCode).toBe(201);
  });

  it('refuses the front desk, which does not hold promotion:apply', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    expect((await applyPromotion(invoice.id, {}, frontDesk)).statusCode).toBe(403);
  });
});

describe('the guards, each with its own answer at the desk', () => {
  it('refuses a second promotion on the same bill', async () => {
    await createPromotion();
    await createPromotion({ code: 'STAFF25', value: 25 });
    const { invoice } = await bookedVisit();

    await applyPromotion(invoice.id);
    const res = await applyPromotion(invoice.id, { code: 'STAFF25' });

    // The unique index would refuse this too. This is the clean answer instead
    // of a raw constraint error.
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('PROMOTION_ALREADY_APPLIED');
  });

  it('refuses once any money has been taken', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/payments`,
      headers: { cookie: finance.cookie },
      payload: { mode: 'CASH', amountPaise: 10000 },
    });

    const res = await applyPromotion(invoice.id);

    // After payment a discount is a refund, and that is an administrator's job.
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('PAYMENT_ALREADY_TAKEN');
  });

  it('refuses a cancelled invoice', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/cancel`,
      headers: { cookie: admin.cookie },
      payload: { reason: 'Raised against the wrong patient' },
    });

    const res = await applyPromotion(invoice.id);
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('NOT_DISCOUNTABLE');
  });

  it('refuses a switched-off promotion', async () => {
    const created = await createPromotion();
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/promotions/${created.json().id}/active`,
      headers: { cookie: admin.cookie },
      payload: { isActive: false },
    });

    const { invoice } = await bookedVisit();
    const res = await applyPromotion(invoice.id);

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('PROMOTION_INACTIVE');
  });

  it('refuses an expired promotion', async () => {
    await createPromotion({
      code: 'EXPIRED',
      validFrom: clinicDate(-60),
      validTo: clinicDate(-30),
    });

    const { invoice } = await bookedVisit();
    const res = await applyPromotion(invoice.id, { code: 'EXPIRED' });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('PROMOTION_OUT_OF_DATE');
  });

  it('refuses a promotion that has not started', async () => {
    await createPromotion({ code: 'FUTURE', validFrom: clinicDate(30), validTo: clinicDate(60) });

    const { invoice } = await bookedVisit();
    const res = await applyPromotion(invoice.id, { code: 'FUTURE' });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('PROMOTION_OUT_OF_DATE');
  });

  it('refuses an unknown code', async () => {
    const { invoice } = await bookedVisit();
    expect((await applyPromotion(invoice.id, { code: 'NOSUCH' })).statusCode).toBe(404);
  });

  it('refuses when no approver is named', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/promotion`,
      headers: { cookie: finance.cookie },
      payload: { code: 'CAMP50' },
    });

    // Decision 3: naming the approver is the control, so this is a 400 from the
    // DTO rather than anything the service has to remember.
    expect(res.statusCode).toBe(400);
  });

  it('refuses an approver from another clinic', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    const [outsider] = await ownerQuery<{ id: string }>(
      fx.other.id,
      `SELECT id FROM app_user WHERE email = 'admin@other.test'`,
    );

    const res = await applyPromotion(invoice.id, { authorisedByUserId: outsider!.id });

    // Row-level security is what makes this true: the other clinic's user is
    // simply not visible here, so the lookup finds nothing.
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('APPROVER_NOT_FOUND');
  });

  it('refuses a switched-off member of staff as the approver', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    const [nurse] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `UPDATE app_user SET is_active = false WHERE email = 'nurse@main.test' RETURNING id`,
    );

    const res = await applyPromotion(invoice.id, { authorisedByUserId: nurse!.id });
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('APPROVER_INACTIVE');

    await ownerQuery(fx.main.id, `UPDATE app_user SET is_active = true WHERE id = $1`, [nurse!.id]);
  });

  it('refuses a bill with nothing on it', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${invoice.id}/lines/${invoice.lines[0].id}`,
      headers: { cookie: finance.cookie },
    });

    const res = await applyPromotion(invoice.id);
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('NOTHING_TO_DISCOUNT');
  });

  it('cannot reach another clinic invoice', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/promotion`,
      headers: { cookie: otherAdmin.cookie },
      payload: { code: 'CAMP50', authorisedByUserId: adminUserId },
    });

    expect(res.statusCode).toBe(404);
  });
});

// --- the arithmetic, end to end ----------------------------------------------

describe('the money', () => {
  it('caps a percentage at the maximum discount', async () => {
    // 50% of ₹600.00 would be ₹300.00, capped at ₹100.00.
    await createPromotion({ code: 'CAPPED', maxDiscountPaise: 10000 });
    const { invoice } = await bookedVisit();

    const res = await applyPromotion(invoice.id, { code: 'CAPPED' });
    expect(res.json().discountPaise).toBe(10000);

    const after = (await readInvoice(invoice.id)).json();
    expect(after.totalPaise).toBe(50000);
  });

  it('floors a flat discount larger than the bill at the bill', async () => {
    // ₹1,000.00 off a ₹600.00 bill is ₹600.00 off. The clinic does not end up
    // owing the patient money.
    await createPromotion({ code: 'BIGFLAT', type: 'FLAT', value: 100000 });
    const { invoice } = await bookedVisit();

    const res = await applyPromotion(invoice.id, { code: 'BIGFLAT' });
    expect(res.json().discountPaise).toBe(CONSULT_FEE);

    const after = (await readInvoice(invoice.id)).json();
    expect(after.totalPaise).toBe(0);
    expect(after.balancePaise).toBe(0);
  });

  it('spreads across several lines and sums exactly', async () => {
    await createPromotion({ code: 'THIRD', value: 33 });
    const { invoice } = await bookedVisit();

    // Two more charges: ₹250.00 dressing and a ₹99.99 oddment, so the split
    // does not divide evenly.
    for (const price of [25000, 9999]) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/invoices/${invoice.id}/lines`,
        headers: { cookie: finance.cookie },
        payload: { description: `Extra ${price}`, unitPricePaise: price },
      });
    }

    const before = (await readInvoice(invoice.id)).json();
    const subtotal = before.subtotalPaise as number; // 60000 + 25000 + 9999 = 94999

    const res = await applyPromotion(invoice.id, { code: 'THIRD' });

    // 33% of 94999 = 94999 * 3300 / 10000 = 31349.67 -> 31350
    expect(res.json().discountPaise).toBe(31350);

    const after = (await readInvoice(invoice.id)).json();
    const lineDiscounts = after.lines.map((l: { discountPaise: number }) => l.discountPaise);

    // The parts sum to the whole, exactly. This is the assertion the
    // last-line-absorbs-remainder rule exists for.
    expect(lineDiscounts.reduce((n: number, d: number) => n + d, 0)).toBe(31350);
    expect(after.discountPaise).toBe(31350);
    expect(after.subtotalPaise).toBe(subtotal);
    expect(after.totalPaise).toBe(subtotal - 31350);
  });

  it('never discounts a line below zero', async () => {
    await createPromotion({ code: 'ALLOFF', value: 100 });
    const { invoice } = await bookedVisit();

    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/lines`,
      headers: { cookie: finance.cookie },
      payload: { description: 'One paisa oddment', unitPricePaise: 1 },
    });

    await applyPromotion(invoice.id, { code: 'ALLOFF' });

    const after = (await readInvoice(invoice.id)).json();
    for (const line of after.lines) {
      expect(line.discountPaise).toBeLessThanOrEqual(line.quantity * line.unitPricePaise);
      expect(line.totalPaise).toBeGreaterThanOrEqual(0);
    }
    expect(after.totalPaise).toBe(0);
  });
});

// --- the pay-first gate reads the discounted balance -------------------------

describe('the queue gate sees the discount', () => {
  it('still holds the patient back when a partial discount leaves a balance', async () => {
    await createPromotion();
    const { appointmentId, invoice } = await bookedVisit();

    await applyPromotion(invoice.id);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appointmentId}/check-in`,
      headers: { cookie: frontDesk.cookie },
    });

    // ₹300.00 still outstanding. The gate is about the balance, not about
    // whether a discount happened.
    expect(res.statusCode).toBe(409);
    expect(res.payload).toContain('300.00');
  });

  it('lets the patient in once the discounted balance is paid', async () => {
    await createPromotion();
    const { appointmentId, invoice } = await bookedVisit();

    await applyPromotion(invoice.id);
    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/payments`,
      headers: { cookie: finance.cookie },
      payload: { mode: 'UPI', amountPaise: 30000 },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appointmentId}/check-in`,
      headers: { cookie: frontDesk.cookie },
    });

    // Paid the discounted amount, not the original. The patient reaches the
    // front desk with nothing outstanding, which is the whole finance-desk flow.
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ARRIVED');
  });

  it('opens the gate on a 100% discount with no payment at all', async () => {
    // "Don't charge this patient" — the case the feature exists for. A zero
    // balance has to open the gate, or the free patient is stuck at the desk.
    await createPromotion({ code: 'FREE', value: 100 });
    const { appointmentId, invoice } = await bookedVisit();

    const applied = await applyPromotion(invoice.id, { code: 'FREE' });
    expect(applied.json().discountPaise).toBe(CONSULT_FEE);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appointmentId}/check-in`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ARRIVED');
    expect(res.json().readyAt).toBeTruthy();
  });
});

// --- taking it back off, before payment --------------------------------------

describe('undoing a discount', () => {
  function undo(invoiceId: string, body?: Record<string, unknown>, session: Session = finance) {
    return app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${invoiceId}/promotion`,
      headers: { cookie: session.cookie },
      ...(body ? { payload: body } : {}),
    });
  }

  it('restores the bill to what it was before the discount', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    await applyPromotion(invoice.id);
    expect((await readInvoice(invoice.id)).json().totalPaise).toBe(30000);

    const res = await undo(invoice.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().discountRemovedPaise).toBe(30000);

    const after = (await readInvoice(invoice.id)).json();
    expect(after.discountPaise).toBe(0);
    expect(after.totalPaise).toBe(CONSULT_FEE);
    expect(after.balancePaise).toBe(CONSULT_FEE);
    expect(after.lines[0].discountPaise).toBe(0);
    expect(after.lines[0].totalPaise).toBe(CONSULT_FEE);
  });

  it('keeps the history — nothing is deleted', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    await applyPromotion(invoice.id);
    await undo(invoice.id);

    const rows = await ownerQuery<{
      id: string;
      reversal_kind: string | null;
      reverses_application_id: string | null;
      discount_paise: number;
    }>(
      fx.main.id,
      `SELECT id, reversal_kind, reverses_application_id, discount_paise
         FROM promotion_application WHERE invoice_id = $1 ORDER BY applied_at`,
      [invoice.id],
    );

    // Two rows: the discount, and the compensating row that took it back.
    expect(rows).toHaveLength(2);
    expect(rows[0]?.reversal_kind).toBeNull();
    expect(rows[1]?.reversal_kind).toBe('APPLIED_IN_ERROR');
    expect(rows[1]?.reverses_application_id).toBe(rows[0]?.id);
    // Positive on both, like a refund. The kind carries the sign.
    expect(rows[1]?.discount_paise).toBe(30000);
  });

  it('records who reversed it', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    await applyPromotion(invoice.id);
    await undo(invoice.id);

    const [financeUser] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM app_user WHERE email = 'finance@main.test'`,
    );

    const [reversal] = await ownerQuery<{ applied_by_user_id: string; applied_at: string }>(
      fx.main.id,
      `SELECT applied_by_user_id, applied_at FROM promotion_application
        WHERE invoice_id = $1 AND reversal_kind IS NOT NULL`,
      [invoice.id],
    );

    expect(reversal?.applied_by_user_id).toBe(financeUser!.id);
    expect(reversal?.applied_at).toBeTruthy();
  });

  it('accepts a stated reason for the reversal', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    await applyPromotion(invoice.id);
    const res = await undo(invoice.id, { reversalKind: 'AUTHORISATION_WITHDRAWN' });
    expect(res.statusCode).toBe(200);

    const [reversal] = await ownerQuery<{ reversal_kind: string }>(
      fx.main.id,
      `SELECT reversal_kind FROM promotion_application
        WHERE invoice_id = $1 AND reversal_kind IS NOT NULL`,
      [invoice.id],
    );

    expect(reversal?.reversal_kind).toBe('AUTHORISATION_WITHDRAWN');
  });

  it('lets a different promotion be applied afterwards', async () => {
    // The reason the "one active" rule is a column on the invoice rather than a
    // partial index on the application table. With the index, this row would
    // collide with the one it just reversed and a clean bill would be
    // undiscountable.
    await createPromotion();
    await createPromotion({ code: 'STAFF25', value: 25 });
    const { invoice } = await bookedVisit();

    await applyPromotion(invoice.id);
    await undo(invoice.id);

    const res = await applyPromotion(invoice.id, { code: 'STAFF25' });
    expect(res.statusCode).toBe(201);
    expect(res.json().discountPaise).toBe(15000); // 25% of ₹600.00

    const after = (await readInvoice(invoice.id)).json();
    expect(after.totalPaise).toBe(45000);

    // Three rows now: applied, reversed, applied again.
    const rows = await ownerQuery(
      fx.main.id,
      `SELECT id FROM promotion_application WHERE invoice_id = $1`,
      [invoice.id],
    );
    expect(rows).toHaveLength(3);
  });

  it('refuses once money has been taken', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    await applyPromotion(invoice.id);
    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/payments`,
      headers: { cookie: finance.cookie },
      payload: { mode: 'CASH', amountPaise: 30000 },
    });

    const res = await undo(invoice.id);

    // Removing the discount now would raise the bill under a patient who has
    // already paid the lower figure. That is a correction, not an undo.
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('PAYMENT_ALREADY_TAKEN');

    // And the bill is untouched.
    const after = (await readInvoice(invoice.id)).json();
    expect(after.totalPaise).toBe(30000);
  });

  it('refuses when there is no discount to take off', async () => {
    const { invoice } = await bookedVisit();

    const res = await undo(invoice.id);
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('NO_PROMOTION_APPLIED');
  });

  it('refuses a second undo of the same discount', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    await applyPromotion(invoice.id);
    expect((await undo(invoice.id)).statusCode).toBe(200);

    const res = await undo(invoice.id);
    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('NO_PROMOTION_APPLIED');
  });

  it('refuses the front desk, which does not hold promotion:apply', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();
    await applyPromotion(invoice.id);

    expect((await undo(invoice.id, undefined, frontDesk)).statusCode).toBe(403);
  });

  it('reopens the pay-first gate at the undiscounted amount', async () => {
    // A patient who was given a free visit, then had it withdrawn, must be
    // stopped at the desk again — the gate reads the balance, and the balance
    // went back up.
    await createPromotion({ code: 'FREE', value: 100 });
    const { appointmentId, invoice } = await bookedVisit();

    await applyPromotion(invoice.id, { code: 'FREE' });
    await undo(invoice.id);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appointmentId}/check-in`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(409);
    expect(res.payload).toContain('600.00');
  });

  it('cannot reach another clinic invoice', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();
    await applyPromotion(invoice.id);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${invoice.id}/promotion`,
      headers: { cookie: otherAdmin.cookie },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('the application table stays append-only', () => {
  it('grants the app role only SELECT and INSERT, reversal or not', async () => {
    // The reversal design would have been much simpler with an UPDATE. This is
    // the assertion that says it was not taken.
    const granted = await ownerQuery<{ privilege_type: string }>(
      fx.main.id,
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_name = 'promotion_application' AND grantee = 'healthcloud_app'
        ORDER BY privilege_type`,
    );

    expect(granted.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });
});

// --- the bill cannot be edited under a discount ------------------------------

describe('changing the charges while a discount is applied', () => {
  /**
   * WHY THIS IS REFUSED RATHER THAN RECALCULATED.
   *
   * A promotion's discount is DISTRIBUTED across the invoice lines, so adding or
   * removing one leaves the invoice arithmetically fine — `retotal` sums
   * whatever line discounts survive — while making the RECORD wrong.
   * `promotion_application.discount_paise` was frozen when the discount was
   * applied and that table is append-only, so it keeps claiming the original
   * amount, and the finance report reads exactly that row.
   *
   * The clinic would then be reported as having given away more than it did,
   * with nothing on any screen to show the discrepancy. Refusing is the cheap
   * half of the fix; the expensive half would be rewriting an append-only row.
   */
  async function billWithTwoLines() {
    const { invoice } = await bookedVisit();

    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/lines`,
      headers: { cookie: finance.cookie },
      payload: { description: 'Dressing', unitPricePaise: 25000 },
    });
    expect(added.statusCode).toBe(201);

    return added.json<{ id: string; lines: Array<{ id: string; description: string }> }>();
  }

  it('refuses to add a charge', async () => {
    await createPromotion();
    const bill = await billWithTwoLines();
    expect((await applyPromotion(bill.id)).statusCode).toBe(201);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${bill.id}/lines`,
      headers: { cookie: finance.cookie },
      payload: { description: 'Another charge', unitPricePaise: 10000 },
    });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('PROMOTION_APPLIED');
    // The message names the promotion and says what to do about it, so the desk
    // is not left guessing which discount is in the way.
    expect(res.json().error.message).toContain('CAMP50');
    expect(res.json().error.message).toContain('Take the discount off');
  });

  it('refuses to remove a charge', async () => {
    await createPromotion();
    const bill = await billWithTwoLines();
    const dressing = bill.lines.find((l) => l.description === 'Dressing')!;
    expect((await applyPromotion(bill.id)).statusCode).toBe(201);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${bill.id}/lines/${dressing.id}`,
      headers: { cookie: finance.cookie },
    });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('PROMOTION_APPLIED');
  });

  it('leaves the record intact when the edit is refused', async () => {
    await createPromotion();
    const bill = await billWithTwoLines();
    const dressing = bill.lines.find((l) => l.description === 'Dressing')!;
    await applyPromotion(bill.id);

    const [before] = await ownerQuery<{ discount_paise: number }>(
      fx.main.id,
      `SELECT discount_paise FROM promotion_application WHERE invoice_id = $1`,
      [bill.id],
    );

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${bill.id}/lines/${dressing.id}`,
      headers: { cookie: finance.cookie },
    });

    const after = (await readInvoice(bill.id)).json();
    const [record] = await ownerQuery<{ discount_paise: number }>(
      fx.main.id,
      `SELECT discount_paise FROM promotion_application WHERE invoice_id = $1`,
      [bill.id],
    );

    // The line is still there, and the frozen record still matches the invoice —
    // which is the whole point of refusing.
    expect(after.lines).toHaveLength(2);
    expect(record?.discount_paise).toBe(before?.discount_paise);
    expect(after.discountPaise).toBe(record?.discount_paise);
  });

  it('allows both again once the discount is taken off', async () => {
    await createPromotion();
    const bill = await billWithTwoLines();
    const dressing = bill.lines.find((l) => l.description === 'Dressing')!;
    await applyPromotion(bill.id);

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${bill.id}/promotion`,
      headers: { cookie: finance.cookie },
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${bill.id}/lines/${dressing.id}`,
      headers: { cookie: finance.cookie },
    });
    expect(removed.statusCode).toBe(200);

    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${bill.id}/lines`,
      headers: { cookie: finance.cookie },
      payload: { description: 'Replacement charge', unitPricePaise: 15000 },
    });
    expect(added.statusCode).toBe(201);
  });

  it('leaves an undiscounted bill freely editable', async () => {
    // The guard must not become a general block on editing bills.
    const bill = await billWithTwoLines();
    const dressing = bill.lines.find((l) => l.description === 'Dressing')!;

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${bill.id}/lines/${dressing.id}`,
      headers: { cookie: finance.cookie },
    });

    expect(removed.statusCode).toBe(200);
    expect(removed.json().lines).toHaveLength(1);
    expect(removed.json().subtotalPaise).toBe(CONSULT_FEE);
  });

  it('re-applying after the change records the NEW amount', async () => {
    // The flow the refusal is steering people into, end to end.
    await createPromotion();
    const bill = await billWithTwoLines();
    const dressing = bill.lines.find((l) => l.description === 'Dressing')!;

    await applyPromotion(bill.id);
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${bill.id}/promotion`,
      headers: { cookie: finance.cookie },
    });
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${bill.id}/lines/${dressing.id}`,
      headers: { cookie: finance.cookie },
    });

    const reapplied = await applyPromotion(bill.id);
    expect(reapplied.statusCode).toBe(201);

    // 50% of ₹600.00 now, not 50% of ₹850.00.
    expect(reapplied.json().discountPaise).toBe(30000);

    const after = (await readInvoice(bill.id)).json();
    expect(after.discountPaise).toBe(30000);
  });
});
