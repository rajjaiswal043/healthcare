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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  clinicDate,
  closeTestApp,
  createDoctor,
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

  /**
   * Inverted on 22 Sep 2026. The front desk takes the consultation fee from the
   * queue and now holds `promotion:apply` — every promotion, CUSTOM included —
   * so the discount is given where the money is taken. The approver rule is the
   * same for this desk as for finance.
   */
  it('lets the front desk apply a promotion that carries its own value', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    const res = await applyPromotion(invoice.id, {}, frontDesk);

    expect(res.statusCode).toBe(201);
    expect(res.json().discountPaise).toBe(30000);
  });

  it('lets the front desk apply a CUSTOM promotion, with the amount it types', async () => {
    await createPromotion({ code: 'CUSTOM1', type: 'CUSTOM', value: undefined });
    const { invoice } = await bookedVisit();

    const res = await applyPromotion(
      invoice.id,
      { code: 'CUSTOM1', customDiscountPaise: 12500 },
      frontDesk,
    );

    expect(res.statusCode).toBe(201);
    expect((await readInvoice(invoice.id, frontDesk)).json().totalPaise).toBe(CONSULT_FEE - 12500);
  });

  it('lets the front desk take a discount back off', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();
    await applyPromotion(invoice.id, {}, frontDesk);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${invoice.id}/promotion`,
      headers: { cookie: frontDesk.cookie },
      payload: { reversalKind: 'APPLIED_IN_ERROR' },
    });

    expect(res.statusCode).toBe(200);
    expect((await readInvoice(invoice.id, frontDesk)).json().totalPaise).toBe(CONSULT_FEE);
  });

  it('lets the front desk load the list of people who can authorise one', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/approvers',
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().approvers.map((u: { id: string }) => u.id)).toContain(adminUserId);
  });

  it('still refuses the doctor, who does not take money', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();

    expect((await applyPromotion(invoice.id, {}, doctor)).statusCode).toBe(403);
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

// --- custom: the amount is typed at the desk ---------------------------------

/**
 * CUSTOM, the third type.
 *
 * PERCENTAGE and FLAT both answer "how much is this worth" before any bill
 * exists. CUSTOM exists for the discount a clinic cannot decide in advance, so
 * the amount arrives with the application and is frozen onto the application row
 * like every other discount — which is what makes it flow into the finance
 * report with no reporting work at all.
 *
 * Most of this file is refusals, and so is most of this block. A type whose
 * amount is typed by a person needs its boundaries enforced where the person is,
 * not discovered by a CHECK constraint three layers down.
 */
describe('a custom promotion', () => {
  function createCustom(body: Record<string, unknown> = {}) {
    return createPromotion({ code: 'CUSTOM1', type: 'CUSTOM', value: undefined, ...body });
  }

  async function customOnABill(customDiscountPaise?: number) {
    expect((await createCustom()).statusCode).toBe(201);
    const { invoice } = await bookedVisit();
    const res = await applyPromotion(invoice.id, {
      code: 'CUSTOM1',
      ...(customDiscountPaise === undefined ? {} : { customDiscountPaise }),
    });
    return { invoice, res };
  }

  // --- creating ------------------------------------------------------------

  it('is created with no value and no cap', async () => {
    const res = await createCustom();

    expect(res.statusCode).toBe(201);
    expect(res.json<{ type: string; value: number | null }>()).toMatchObject({
      type: 'CUSTOM',
      value: null,
    });

    const [row] = await ownerQuery<{ value: number | null; max_discount_paise: number | null }>(
      fx.main.id,
      `SELECT value, max_discount_paise FROM promotion WHERE code = 'CUSTOM1'`,
    );
    expect(row?.value).toBeNull();
    expect(row?.max_discount_paise).toBeNull();
  });

  it('refuses a value, rather than storing one nothing will read', async () => {
    expect((await createCustom({ value: 50 })).statusCode).toBe(400);
  });

  /**
   * Decision (d). The database CHECK refuses this too, but arriving there means
   * the desk gets a 500 with a constraint name in it.
   */
  it('refuses a maximum discount', async () => {
    const res = await createCustom({ maxDiscountPaise: 20000 });

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatch(/maximum/i);
  });

  /**
   * Decision (d), asserted BELOW the API.
   *
   * The DTO refuses a cap on a CUSTOM promotion, and that refusal is the one a
   * person meets. This writes straight to the table to prove the rule also
   * exists where it cannot be forgotten — a future endpoint, a seed script or a
   * migration that inserts promotions is not covered by a class-validator
   * decorator, and "the form hides it" was explicitly not enough.
   */
  it('cannot be written with a value or a cap even below the API', async () => {
    const insert = (columns: string, values: string) =>
      ownerQuery(
        fx.main.id,
        `INSERT INTO promotion (tenant_id, code, name, type, ${columns},
                                valid_from, created_by_user_id, updated_at)
         VALUES ($1, 'RAW1', 'Written directly', 'CUSTOM', ${values},
                 current_date, $2, now())`,
        [fx.main.id, adminUserId],
      );

    await expect(insert('value', '50')).rejects.toThrow(/promotion_value_within_bounds/);
    await expect(insert('value, max_discount_paise', 'NULL, 20000')).rejects.toThrow(
      /promotion_value_within_bounds/,
    );

    // And the shape the constraint does allow.
    await expect(insert('value, max_discount_paise', 'NULL, NULL')).resolves.toBeDefined();
  });

  it('cannot be given a value by editing it later', async () => {
    expect((await createCustom()).statusCode).toBe(201);
    const [row] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM promotion WHERE code = 'CUSTOM1'`,
    );

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/promotions/${row!.id}`,
      headers: { cookie: admin.cookie },
      payload: { value: 5000 },
    });

    expect(res.statusCode).toBe(409);
    expect(domainCode(res)).toBe('CUSTOM_HAS_NO_VALUE');
  });

  // --- applying ------------------------------------------------------------

  it('discounts the bill by exactly what was typed', async () => {
    const { invoice, res } = await customOnABill(17500); // ₹175.00, an odd figure on purpose

    expect(res.statusCode).toBe(201);

    const after = (await readInvoice(invoice.id)).json();
    expect(after.discountPaise).toBe(17500);
    expect(after.subtotalPaise).toBe(CONSULT_FEE);
    expect(after.totalPaise).toBe(CONSULT_FEE - 17500);

    // Frozen on the application row — this is what the finance report reads,
    // and why CUSTOM needs no reporting work of its own.
    const [row] = await ownerQuery<{ discount_paise: number }>(
      fx.main.id,
      'SELECT discount_paise FROM promotion_application WHERE invoice_id = $1',
      [invoice.id],
    );
    expect(row?.discount_paise).toBe(17500);
  });

  it('takes the whole bill when that is what was typed', async () => {
    const { invoice, res } = await customOnABill(CONSULT_FEE);

    expect(res.statusCode).toBe(201);
    expect((await readInvoice(invoice.id)).json().totalPaise).toBe(0);
  });

  /**
   * Decision (c): REFUSED, not clamped.
   *
   * The arithmetic would happily floor this at the bill and produce a correct
   * invoice. That is the wrong behaviour for a number a person just typed —
   * they entered ₹700 against a ₹600 bill because one of the two is not what
   * they think it is, and silently charging ₹0 tells them neither.
   */
  it('refuses an amount larger than the bill, naming both figures', async () => {
    const { invoice, res } = await customOnABill(CONSULT_FEE + 10000);

    expect(res.statusCode).toBe(400);
    expect(domainCode(res)).toBe('CUSTOM_AMOUNT_ABOVE_TOTAL');
    expect(res.payload).toContain('600');
    expect(res.payload).toContain('700');

    // And nothing was written: no discount, no application row.
    const after = (await readInvoice(invoice.id)).json();
    expect(after.discountPaise).toBe(0);
    expect(after.totalPaise).toBe(CONSULT_FEE);
    expect(
      await ownerQuery(fx.main.id, 'SELECT id FROM promotion_application WHERE invoice_id = $1', [
        invoice.id,
      ]),
    ).toHaveLength(0);
  });

  it('refuses zero, which is a record of a discount nobody gave', async () => {
    const { res } = await customOnABill(0);
    expect(res.statusCode).toBe(400);
  });

  it('refuses a negative amount', async () => {
    const { res } = await customOnABill(-100);
    expect(res.statusCode).toBe(400);
  });

  it('refuses being applied with no amount at all', async () => {
    const { res } = await customOnABill(undefined);

    expect(res.statusCode).toBe(400);
    expect(domainCode(res)).toBe('CUSTOM_AMOUNT_REQUIRED');
  });

  /**
   * The other direction. An amount sent for a promotion that carries its own is
   * refused rather than ignored — quietly dropping a figure somebody typed is
   * how a bill ends up disagreeing with the screen it was entered on.
   */
  it('refuses an amount sent for a percentage promotion', async () => {
    expect((await createPromotion()).statusCode).toBe(201);
    const { invoice } = await bookedVisit();

    const res = await applyPromotion(invoice.id, { customDiscountPaise: 10000 });

    expect(res.statusCode).toBe(400);
    expect(domainCode(res)).toBe('CUSTOM_AMOUNT_NOT_ALLOWED');
  });

  // --- the record ----------------------------------------------------------

  /**
   * Decision (e): an owner reading the day's discounts must be able to tell a
   * judgement made at the desk from an administrator's policy being executed.
   */
  it('records that the amount was entered by hand', async () => {
    const { invoice } = await customOnABill(17500);

    const [row] = await ownerQuery<{ reason: string }>(
      fx.main.id,
      `SELECT reason FROM audit_event
        WHERE action = 'promotion.apply' AND resource_id = $1`,
      [invoice.id],
    );
    expect(row?.reason).toContain('entered by hand');
    expect(row?.reason).toContain('175');
  });

  it('records a percentage discount as calculated, not entered', async () => {
    expect((await createPromotion()).statusCode).toBe(201);
    const { invoice } = await bookedVisit();
    expect((await applyPromotion(invoice.id)).statusCode).toBe(201);

    const [row] = await ownerQuery<{ reason: string }>(
      fx.main.id,
      `SELECT reason FROM audit_event
        WHERE action = 'promotion.apply' AND resource_id = $1`,
      [invoice.id],
    );
    expect(row?.reason).toContain('calculated from the promotion');
  });

  // --- and it is the same feature on a test bill ---------------------------

  /**
   * Consultation and diagnostics bills are two invoices, and the finance desk
   * renders ONE `PromotionPanel` against whichever is open — so a discount that
   * worked on one and not the other would be a server-side difference, not a UI
   * one. Asserted here because that is where such a difference would live.
   */
  it('works the same on a diagnostic test bill', async () => {
    expect((await createCustom()).statusCode).toBe(201);

    // A diagnostic department and one priced test, because `seedBilling` prices
    // consultations only — the test bill is a different invoice built from
    // different rows, which is exactly why it is worth asserting separately.
    const department = await app.inject({
      method: 'POST',
      url: '/api/v1/departments',
      headers: { cookie: admin.cookie },
      payload: { name: 'X-ray', isDiagnostic: true },
    });
    expect(department.statusCode).toBe(201);

    const service = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/services',
      headers: { cookie: admin.cookie },
      payload: {
        category: 'DIAGNOSTIC',
        code: 'XR-KNEE',
        name: 'Knee X-ray',
        pricePaise: 40000,
        departmentId: department.json<{ id: string }>().id,
      },
    });
    expect(service.statusCode).toBe(201);

    const raised = await app.inject({
      method: 'POST',
      url: '/api/v1/diagnostics/walk-in-orders',
      headers: { cookie: finance.cookie },
      payload: {
        patientId: fx.main.patientIds[1],
        serviceIds: [service.json<{ id: string }>().id],
        referralSource: 'SELF',
      },
    });
    if (raised.statusCode !== 201) {
      throw new Error(`Could not raise the test bill: ${raised.statusCode} ${raised.payload}`);
    }

    const invoiceId = raised.json<{ invoiceId: string }>().invoiceId;
    expect((await readInvoice(invoiceId)).json().subtotalPaise).toBe(40000);

    const res = await applyPromotion(invoiceId, { code: 'CUSTOM1', customDiscountPaise: 15000 });

    expect(res.statusCode).toBe(201);
    const after = (await readInvoice(invoiceId)).json();
    expect(after.discountPaise).toBe(15000);
    expect(after.totalPaise).toBe(25000);
  });

  it('refuses an over-the-bill amount on a test bill too', async () => {
    expect((await createCustom()).statusCode).toBe(201);

    const department = await app.inject({
      method: 'POST',
      url: '/api/v1/departments',
      headers: { cookie: admin.cookie },
      payload: { name: 'Pathology', isDiagnostic: true },
    });
    const service = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/services',
      headers: { cookie: admin.cookie },
      payload: {
        category: 'DIAGNOSTIC',
        code: 'PATH-CBC',
        name: 'Blood count',
        pricePaise: 30000,
        departmentId: department.json<{ id: string }>().id,
      },
    });

    const raised = await app.inject({
      method: 'POST',
      url: '/api/v1/diagnostics/walk-in-orders',
      headers: { cookie: finance.cookie },
      payload: {
        patientId: fx.main.patientIds[2],
        serviceIds: [service.json<{ id: string }>().id],
        referralSource: 'SELF',
      },
    });
    const invoiceId = raised.json<{ invoiceId: string }>().invoiceId;

    const res = await applyPromotion(invoiceId, { code: 'CUSTOM1', customDiscountPaise: 30001 });

    expect(res.statusCode).toBe(400);
    expect(domainCode(res)).toBe('CUSTOM_AMOUNT_ABOVE_TOTAL');
    expect((await readInvoice(invoiceId)).json().discountPaise).toBe(0);
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

  // The front desk holds promotion:apply since 22 Sep 2026 and may undo — see
  // 'lets the front desk take a discount back off'. The doctor still may not.
  it('refuses the doctor, who does not hold promotion:apply', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();
    await applyPromotion(invoice.id);

    expect((await undo(invoice.id, undefined, doctor)).statusCode).toBe(403);
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

// --- two desks at once ----------------------------------------------------------

/**
 * The same bill reached from two places at the same moment — the Finance Desk
 * and the queue's payment dialog, or two tabs. Each race is FORCED: a trigger
 * holds the first request's transaction open mid-write, and the second is sent
 * while it waits. Without the invoice lock, the second reads the bill as it was
 * before the first committed and both go through.
 */
describe('two desks on the same bill at once', () => {
  afterEach(async () => {
    for (const [name, table] of [
      ['test_slow_promotion', 'promotion_application'],
      ['test_slow_payment', 'payment'],
      ['test_slow_line_delete', 'invoice_line'],
    ] as const) {
      await ownerQuery(fx.main.id, `DROP TRIGGER IF EXISTS ${name} ON ${table}`);
      await ownerQuery(fx.main.id, `DROP FUNCTION IF EXISTS ${name}()`);
    }
  });

  /** Hold every insert into `table` for 1.5 s, inside its transaction. */
  async function slowInserts(name: string, table: string) {
    await ownerQuery(
      fx.main.id,
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fn$
       BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $fn$`,
    );
    await ownerQuery(
      fx.main.id,
      `CREATE TRIGGER ${name} BEFORE INSERT ON ${table}
         FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
  }

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function pay(invoiceId: string, amountPaise: number, session: Session = finance) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/payments`,
      headers: { cookie: session.cookie },
      payload: { mode: 'CASH', amountPaise },
    });
  }

  function undo(invoiceId: string, session: Session = finance) {
    return app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${invoiceId}/promotion`,
      headers: { cookie: session.cookie },
      payload: { reversalKind: 'APPLIED_IN_ERROR' },
    });
  }

  /** What the bill and its discount history say, straight from the tables. */
  async function state(invoiceId: string) {
    const [row] = await ownerQuery<{
      total: number;
      paid: number;
      live: number;
      active: string | null;
    }>(
      fx.main.id,
      `SELECT i.total_paise AS total,
              COALESCE((SELECT sum(amount_paise)::int FROM payment
                         WHERE invoice_id = i.id AND direction = 'IN'), 0) AS paid,
              (SELECT count(*)::int FROM promotion_application a
                WHERE a.invoice_id = i.id AND a.reversal_kind IS NULL
                  AND NOT EXISTS (SELECT 1 FROM promotion_application r
                                   WHERE r.reverses_application_id = a.id)) AS live,
              i.active_promotion_application_id AS active
         FROM invoice i WHERE i.id = $1`,
      [invoiceId],
    );
    return row!;
  }

  it('lets one of two simultaneous discounts through, and refuses the other', async () => {
    await createPromotion();
    await createPromotion({ code: 'STAFF25', value: 25 });
    const { invoice } = await bookedVisit();
    await slowInserts('test_slow_promotion', 'promotion_application');

    const first = applyPromotion(invoice.id);
    await pause(400);
    const second = applyPromotion(invoice.id, { code: 'STAFF25' });
    const results = await Promise.all([first, second]);

    expect(results.map((r) => r.statusCode)).toEqual([201, 409]);
    expect(domainCode(results[1]!)).toBe('PROMOTION_ALREADY_APPLIED');
    // One discount on record, and it is the one on the bill — no orphan that
    // the discount report would count as money given away.
    const after = await state(invoice.id);
    expect(after.live).toBe(1);
    expect(after.active).not.toBeNull();
    expect(after.total).toBe(30000);
  });

  /**
   * Discount first. The payment was typed against the old total, so it is
   * refused as more than is owed — and the new balance is then collected.
   */
  it('makes a payment typed against the old total wait for the discount, then refuses it', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();
    await slowInserts('test_slow_promotion', 'promotion_application');

    const discounting = applyPromotion(invoice.id);
    await pause(400);
    const paying = pay(invoice.id, CONSULT_FEE);
    const [applied, paid] = await Promise.all([discounting, paying]);

    expect(applied.statusCode).toBe(201);
    expect(paid.statusCode).toBe(409);
    expect(domainCode(paid)).toBe('OVERPAYMENT');

    expect((await pay(invoice.id, 30000)).statusCode).toBe(201);
    const after = await state(invoice.id);
    expect(after).toMatchObject({ total: 30000, paid: 30000, live: 1 });
  });

  /** Payment first. The discount waits for it, then finds money taken. */
  it('refuses a discount that arrives while a payment is being taken', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();
    await slowInserts('test_slow_payment', 'payment');

    const paying = pay(invoice.id, CONSULT_FEE);
    await pause(400);
    const discounting = applyPromotion(invoice.id);
    const [paid, applied] = await Promise.all([paying, discounting]);

    expect(paid.statusCode).toBe(201);
    expect(applied.statusCode).toBe(409);
    expect(domainCode(applied)).toBe('PAYMENT_ALREADY_TAKEN');
    const after = await state(invoice.id);
    expect(after).toMatchObject({ total: CONSULT_FEE, paid: CONSULT_FEE, live: 0, active: null });
  });

  /**
   * The lock order. Removing a charge used to lock the LINE and then the
   * invoice; a discount locks the invoice and then the lines. Run together,
   * each held what the other wanted — a deadlock, which Postgres breaks by
   * killing one of them, and the desk sees "Something went wrong". Both now take
   * the invoice first, so one simply waits for the other.
   */
  it('lets a charge be removed and a discount applied at once without a deadlock', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();
    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/lines`,
      headers: { cookie: finance.cookie },
      payload: { description: 'Dressing', unitPricePaise: 20000 },
    });
    expect(added.statusCode).toBe(201);
    const extra = added
      .json()
      .lines.find((l: { description: string }) => l.description === 'Dressing');

    await ownerQuery(
      fx.main.id,
      `CREATE FUNCTION test_slow_line_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
       BEGIN PERFORM pg_sleep(1.5); RETURN OLD; END $fn$`,
    );
    await ownerQuery(
      fx.main.id,
      `CREATE TRIGGER test_slow_line_delete AFTER DELETE ON invoice_line
         FOR EACH ROW EXECUTE FUNCTION test_slow_line_delete()`,
    );

    const removing = app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${invoice.id}/lines/${extra.id}`,
      headers: { cookie: finance.cookie },
    });
    await pause(400);
    const discounting = applyPromotion(invoice.id);
    const [removed, applied] = await Promise.all([removing, discounting]);

    expect(removed.statusCode).toBe(200);
    expect(applied.statusCode).toBe(201);
    // Half of what was left once the dressing came off — the discount saw the
    // bill after the removal, not before it.
    expect(await state(invoice.id)).toMatchObject({ total: CONSULT_FEE / 2, live: 1 });
  });

  // --- the administrator's exceptions --------------------------------------------

  function refund(invoiceId: string, amountPaise: number) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/refunds`,
      headers: { cookie: admin.cookie },
      payload: {
        mode: 'CASH',
        amountPaise,
        reason: 'Patient left before being seen',
        kind: 'PATIENT_REFUND',
      },
    });
  }

  function exception(invoiceId: string, kind: 'waive' | 'defer') {
    return app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/${kind}`,
      headers: { cookie: admin.cookie },
      payload: {
        reason: kind === 'waive' ? 'Staff or staff family' : 'Corporate or company account',
      },
    });
  }

  const refunded = async (invoiceId: string) =>
    (
      await ownerQuery<{ n: number }>(
        fx.main.id,
        `SELECT COALESCE(sum(amount_paise), 0)::int AS n FROM payment
          WHERE invoice_id = $1 AND direction = 'REFUND'`,
        [invoiceId],
      )
    )[0]!.n;

  const statusOf = async (invoiceId: string) =>
    (
      await ownerQuery<{ status: string }>(fx.main.id, 'SELECT status FROM invoice WHERE id = $1', [
        invoiceId,
      ])
    )[0]!.status;

  /** Two refunds that each fit on their own, and together would not. */
  it('never refunds more than was paid, however many refunds arrive at once', async () => {
    const { invoice } = await bookedVisit();
    expect((await pay(invoice.id, CONSULT_FEE)).statusCode).toBe(201);
    await slowInserts('test_slow_payment', 'payment');

    const first = refund(invoice.id, 40000);
    await pause(400);
    const second = refund(invoice.id, 40000);
    const results = await Promise.all([first, second]);

    expect(results.map((r) => r.statusCode)).toEqual([201, 409]);
    expect(domainCode(results[1]!)).toBe('REFUND_EXCEEDS_PAYMENTS');
    expect(await refunded(invoice.id)).toBe(40000);
  });

  /**
   * Money is being taken when the administrator waives the bill. The waiver
   * waits, finds the money, and is refused — the clinic never holds cash
   * against a bill it wrote off.
   */
  it('refuses to waive a bill while it is being paid', async () => {
    const { invoice } = await bookedVisit();
    await slowInserts('test_slow_payment', 'payment');

    const paying = pay(invoice.id, CONSULT_FEE);
    await pause(400);
    const waiving = exception(invoice.id, 'waive');
    const [paid, waived] = await Promise.all([paying, waiving]);

    expect(paid.statusCode).toBe(201);
    expect(waived.statusCode).toBe(409);
    expect(domainCode(waived)).toBe('HAS_PAYMENTS');
    expect(await statusOf(invoice.id)).toBe('PAID');
  });

  /**
   * A part-payment is being taken when the rest is deferred. The deferral
   * waits for it and lands on top — it is never quietly overwritten by the
   * payment's own status update.
   */
  it('does not lose a deferral to a payment that was in flight', async () => {
    const { invoice } = await bookedVisit();
    await slowInserts('test_slow_payment', 'payment');

    const paying = pay(invoice.id, 20000);
    await pause(400);
    const deferring = exception(invoice.id, 'defer');
    const [paid, deferred] = await Promise.all([paying, deferring]);

    expect(paid.statusCode).toBe(201);
    expect(deferred.statusCode).toBe(201);
    expect(await statusOf(invoice.id)).toBe('DEFERRED');
  });

  /**
   * The discounted balance is being paid when somebody takes the discount off.
   * The undo waits, finds the payment, and is refused — a bill is never paid
   * at its discounted price and then charged the full one.
   */
  it('refuses to take a discount off while its discounted balance is being paid', async () => {
    await createPromotion();
    const { invoice } = await bookedVisit();
    expect((await applyPromotion(invoice.id)).statusCode).toBe(201);
    await slowInserts('test_slow_payment', 'payment');

    const paying = pay(invoice.id, 30000);
    await pause(400);
    const undoing = undo(invoice.id);
    const [paid, undone] = await Promise.all([paying, undoing]);

    expect(paid.statusCode).toBe(201);
    expect(undone.statusCode).toBe(409);
    expect(domainCode(undone)).toBe('PAYMENT_ALREADY_TAKEN');
    const after = await state(invoice.id);
    expect(after).toMatchObject({ total: 30000, paid: 30000, live: 1 });
  });
});

// --- the front desk, from the queue ----------------------------------------------

/**
 * The whole path the decision of 22 Sep 2026 opened: the front desk opens a
 * visit's bill from the queue (the same `GET /appointments/:id/invoice` the
 * queue's Bill button calls), discounts it, takes the discounted balance — and
 * the finance report tells the truth about it afterwards: who gave the
 * discount, and which doctor the visit belongs to.
 *
 * A second doctor's undiscounted visit sits beside it, so "the right doctor"
 * is a comparison and not a report with one row in it.
 */
describe('the front desk, discounting from the queue', () => {
  it('discounts, collects the new balance, and the report credits the right people', async () => {
    const other = await createDoctor(app, fx.main, {
      email: 'queue-other@main.test',
      fullName: 'Dr Queue Other',
      linked: true,
    });

    try {
      await createPromotion();
      const { appointmentId } = await bookedVisit();

      // The queue's Bill button.
      const bill = await app.inject({
        method: 'GET',
        url: `/api/v1/appointments/${appointmentId}/invoice`,
        headers: { cookie: frontDesk.cookie },
      });
      expect(bill.statusCode).toBe(200);
      const invoiceId = bill.json().id as string;

      expect((await applyPromotion(invoiceId, {}, frontDesk)).statusCode).toBe(201);

      const discounted = (await readInvoice(invoiceId, frontDesk)).json();
      expect(discounted.balancePaise).toBe(30000);

      const paid = await app.inject({
        method: 'POST',
        url: `/api/v1/invoices/${invoiceId}/payments`,
        headers: { cookie: frontDesk.cookie },
        payload: { mode: 'CASH', amountPaise: discounted.balancePaise },
      });
      expect(paid.statusCode).toBe(201);
      expect(paid.json()).toMatchObject({ status: 'PAID', balancePaise: 0 });

      // The other doctor's visit, full price, nothing discounted.
      const walkIn = await app.inject({
        method: 'POST',
        url: '/api/v1/appointments/walk-in',
        headers: { cookie: frontDesk.cookie },
        payload: {
          patientId: fx.main.patientIds[1],
          practitionerId: other.practitionerId,
          locationId: fx.main.locationId,
        },
      });
      expect(walkIn.statusCode).toBe(201);

      const report = await app.inject({
        method: 'GET',
        url: '/api/v1/reports/finance',
        headers: { cookie: finance.cookie },
      });
      expect(report.statusCode).toBe(200);
      const body = report.json();

      const [desk] = await ownerQuery<{ full_name: string }>(
        fx.main.id,
        `SELECT full_name FROM app_user WHERE email = 'frontdesk@main.test'`,
      );
      expect(body.discounts.given).toHaveLength(1);
      expect(body.discounts.given[0]).toMatchObject({
        promotionCode: 'CAMP50',
        discountPaise: 30000,
        appliedBy: desk!.full_name,
      });

      type DoctorRow = {
        practitionerId: string | null;
        grossPaise: number;
        discountPaise: number;
        netCollectedPaise: number;
      };
      const row = (id: string | null) =>
        (body.byDoctor as DoctorRow[]).find((r) => r.practitionerId === id);

      expect(row(fx.main.practitionerId)).toMatchObject({
        grossPaise: CONSULT_FEE,
        discountPaise: 30000,
        netCollectedPaise: 30000,
      });
      expect(row(other.practitionerId)).toMatchObject({
        grossPaise: CONSULT_FEE,
        discountPaise: 0,
        netCollectedPaise: 0,
      });
    } finally {
      await resetAppointments();
      await ownerQuery(fx.main.id, `DELETE FROM practitioner WHERE full_name = 'Dr Queue Other'`);
      await ownerQuery(fx.main.id, `DELETE FROM app_user WHERE email = 'queue-other@main.test'`);
    }
  });
});
