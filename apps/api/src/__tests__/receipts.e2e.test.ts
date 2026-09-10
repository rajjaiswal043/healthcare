/**
 * Receipts — FR-RCP-01, -02, -03.
 *
 * THE RULE THIS FILE EXISTS FOR: a receipt is for a PAYMENT, not for a bill.
 *
 * A ₹1,100 bill paid ₹500 now and ₹600 on the way out is one invoice and TWO
 * receipts, each showing what was paid at that moment and what remained. A
 * receipt that restates the whole bill every time is one a patient can use to
 * claim they paid twice — so `each payment gets its own receipt` and `shows the
 * balance at that moment` are the two assertions everything else supports.
 *
 * The second is `DUPLICATE`. Two identical unmarked receipts for one payment is
 * how cash goes missing in a clinic, and the person exposed by it is the finance
 * desk who cannot prove which copy was the original. That marking depends
 * entirely on the print log, so the log is tested as carefully as the money.
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
let finance: Session;
let frontDesk: Session;
let doctor: Session;
let admin: Session;
let otherFinance: Session;

const DAY = clinicDate(7);
const CONSULT_FEE = 60000; // ₹600.00

beforeAll(async () => {
  fx = await seedFixtures();
  await seedBilling(fx.main.id, { consultationFeePaise: CONSULT_FEE, followUpFeePaise: 30000 });
  await seedBilling(fx.other.id, { consultationFeePaise: 55000, followUpFeePaise: 25000 });

  app = await createTestApp();

  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  finance = await login(app, fx.main.slug, 'finance@main.test');
  doctor = await login(app, fx.main.slug, 'doctor@main.test');
  admin = await loginWithMfa(app, fx.main.slug, 'admin@main.test');
  otherFinance = await login(app, fx.other.slug, 'finance@other.test');
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  await resetAppointments();
  await ownerQuery(fx.main.id, `TRUNCATE receipt_counter CASCADE`);
});

// --- helpers ----------------------------------------------------------------

async function bookedVisit(patientIndex = 0, slotIndex = 0) {
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
    },
  });
  if (booked.statusCode !== 201) {
    throw new Error(`Could not book: ${booked.statusCode} ${booked.payload}`);
  }

  const invoice = await app.inject({
    method: 'GET',
    url: `/api/v1/appointments/${booked.json().id}/invoice`,
    headers: { cookie: finance.cookie },
  });

  return { appointmentId: booked.json().id as string, invoice: invoice.json() };
}

/** A walk-in for a doctor, used to prove a receipt never invents one. */
async function walkInVisit(patientIndex = 2) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/appointments/walk-in',
    headers: { cookie: finance.cookie },
    payload: {
      patientId: fx.main.patientIds[patientIndex],
      practitionerId: fx.main.practitionerId,
      locationId: fx.main.locationId,
    },
  });
  expect(res.statusCode).toBe(201);

  const invoice = await app.inject({
    method: 'GET',
    url: `/api/v1/appointments/${res.json().id}/invoice`,
    headers: { cookie: finance.cookie },
  });
  return invoice.json();
}

function pay(invoiceId: string, amountPaise: number, mode = 'CASH', session: Session = finance) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/invoices/${invoiceId}/payments`,
    headers: { cookie: session.cookie },
    payload: { mode, amountPaise },
  });
}

function readReceipt(paymentId: string, session: Session = finance) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/payments/${paymentId}/receipt`,
    headers: { cookie: session.cookie },
  });
}

function printReceipt(paymentId: string, session: Session = finance) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/payments/${paymentId}/receipt/prints`,
    headers: { cookie: session.cookie },
  });
}

/** The payments on an invoice, oldest first — the ids receipts hang off. */
async function paymentIds(invoiceId: string): Promise<string[]> {
  const rows = await ownerQuery<{ id: string }>(
    fx.main.id,
    `SELECT id FROM payment WHERE invoice_id = $1 AND direction = 'IN' ORDER BY collected_at`,
    [invoiceId],
  );
  return rows.map((r) => r.id);
}

// --- numbering --------------------------------------------------------------

describe('receipt numbering', () => {
  it('is its own sequence, not the invoice number', async () => {
    const { invoice } = await bookedVisit();
    await pay(invoice.id, CONSULT_FEE);

    const [paymentId] = await paymentIds(invoice.id);
    const receipt = (await readReceipt(paymentId!)).json();

    expect(receipt.receiptNumber).toMatch(/^R-\d{6}$/);
    expect(receipt.invoiceNumber).toMatch(/^INV-\d{6}$/);
    // One invoice can produce several receipts, so they cannot share a number
    // without a suffix — and a suffix invites somebody to invent one.
    expect(receipt.receiptNumber).not.toBe(receipt.invoiceNumber);
  });

  it('increments across separate invoices', async () => {
    const first = await bookedVisit(0, 0);
    await pay(first.invoice.id, CONSULT_FEE);

    const second = await bookedVisit(1, 1);
    await pay(second.invoice.id, CONSULT_FEE);

    const [p1] = await paymentIds(first.invoice.id);
    const [p2] = await paymentIds(second.invoice.id);

    expect((await readReceipt(p1!)).json().receiptNumber).toBe('R-000001');
    expect((await readReceipt(p2!)).json().receiptNumber).toBe('R-000002');
  });

  it('runs a separate sequence per clinic', async () => {
    const { invoice } = await bookedVisit();
    await pay(invoice.id, CONSULT_FEE);

    const [ours] = await paymentIds(invoice.id);
    expect((await readReceipt(ours!)).json().receiptNumber).toBe('R-000001');

    // The other clinic's counter is its own row, so its first receipt is also
    // R-000001 and nothing collides.
    const theirs = await ownerQuery<{ last_number: string }>(
      fx.other.id,
      `SELECT last_number FROM receipt_counter`,
    );
    expect(theirs).toHaveLength(0);
  });
});

// --- the core rule ----------------------------------------------------------

describe('a receipt is for a payment, not for a bill', () => {
  it('gives a part payment the balance at that moment, not the whole bill', async () => {
    const { invoice } = await bookedVisit();

    // ₹200 of a ₹600 bill.
    await pay(invoice.id, 20000, 'CASH');

    const [first] = await paymentIds(invoice.id);
    const receipt = (await readReceipt(first!)).json();

    expect(receipt.money.totalChargedPaise).toBe(CONSULT_FEE);
    expect(receipt.money.paidNowPaise).toBe(20000);
    // The number that stops a patient claiming they paid the lot.
    expect(receipt.money.balancePaise).toBe(40000);
  });

  it('gives the second payment its own receipt, with its own balance', async () => {
    const { invoice } = await bookedVisit();

    await pay(invoice.id, 20000, 'CASH');
    await pay(invoice.id, 40000, 'UPI');

    const [first, second] = await paymentIds(invoice.id);
    const one = (await readReceipt(first!)).json();
    const two = (await readReceipt(second!)).json();

    // Two receipts, two numbers, one invoice.
    expect(one.receiptNumber).not.toBe(two.receiptNumber);
    expect(one.invoiceNumber).toBe(two.invoiceNumber);

    expect(one.money.paidNowPaise).toBe(20000);
    expect(one.money.balancePaise).toBe(40000);

    expect(two.money.paidNowPaise).toBe(40000);
    expect(two.money.balancePaise).toBe(0);

    // Neither restates the other's money.
    expect(two.money.paidNowPaise).not.toBe(CONSULT_FEE);
  });

  it('freezes the money block, so a later change cannot rewrite history', async () => {
    const { invoice } = await bookedVisit();
    await pay(invoice.id, CONSULT_FEE);

    const [paymentId] = await paymentIds(invoice.id);
    const before = (await readReceipt(paymentId!)).json();

    // The path that made deriving unsafe: refund in full, and the invoice
    // becomes editable again because loadEditable tests paid MINUS refunded.
    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/refunds`,
      headers: { cookie: admin.cookie },
      payload: {
        mode: 'CASH',
        amountPaise: CONSULT_FEE,
        reason: 'Patient left before being seen',
        kind: 'PATIENT_REFUND',
      },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/lines`,
      headers: { cookie: finance.cookie },
      payload: { description: 'Added afterwards', unitPricePaise: 25000 },
    });

    const after = (await readReceipt(paymentId!)).json();

    // The receipt still says what it said on the day. A derived figure would
    // now be reading a bill that grew by ₹250 after the fact.
    expect(after.money.totalChargedPaise).toBe(before.money.totalChargedPaise);
    expect(after.money.payablePaise).toBe(before.money.payablePaise);
    expect(after.money.balancePaise).toBe(0);
  });

  it('has no receipt for a refund', async () => {
    const { invoice } = await bookedVisit();
    await pay(invoice.id, CONSULT_FEE);

    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/refunds`,
      headers: { cookie: admin.cookie },
      payload: { mode: 'CASH', amountPaise: 10000, reason: 'Overcharged', kind: 'PATIENT_REFUND' },
    });

    const [refund] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM payment WHERE invoice_id = $1 AND direction = 'REFUND'`,
      [invoice.id],
    );

    // Nothing was received. Printing one would hand the patient a document
    // saying they paid when in fact they were paid.
    expect((await readReceipt(refund!.id)).statusCode).toBe(404);
  });
});

// --- DUPLICATE --------------------------------------------------------------

describe('the print log and DUPLICATE', () => {
  async function paidVisit() {
    const { invoice } = await bookedVisit();
    await pay(invoice.id, CONSULT_FEE);
    const [paymentId] = await paymentIds(invoice.id);
    return paymentId!;
  }

  it('marks the first print as the original', async () => {
    const paymentId = await paidVisit();

    const first = (await printReceipt(paymentId)).json();
    expect(first.print.printCount).toBe(1);
    expect(first.print.isDuplicate).toBe(false);
  });

  it('marks every print after the first as a duplicate', async () => {
    const paymentId = await paidVisit();

    await printReceipt(paymentId);
    const second = (await printReceipt(paymentId)).json();
    const third = (await printReceipt(paymentId)).json();

    expect(second.print.isDuplicate).toBe(true);
    expect(second.print.printCount).toBe(2);
    expect(third.print.printCount).toBe(3);
  });

  it('records who printed it and when', async () => {
    const paymentId = await paidVisit();

    await printReceipt(paymentId, finance);
    await printReceipt(paymentId, admin);

    const history = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/payments/${paymentId}/receipt/prints`,
        headers: { cookie: finance.cookie },
      })
    ).json<{ prints: Array<{ printedBy: string; isDuplicate: boolean }> }>();

    // The answer to "how does a second copy exist".
    expect(history.prints.map((p) => p.printedBy)).toEqual(['Finance Desk', 'Administrator']);
    expect(history.prints.map((p) => p.isDuplicate)).toEqual([false, true]);
  });

  it('does not mark a print just because the receipt was read', async () => {
    const paymentId = await paidVisit();

    // Reading is not printing. A GET that logged a print would make every
    // screen refresh produce a duplicate.
    await readReceipt(paymentId);
    await readReceipt(paymentId);

    const first = (await printReceipt(paymentId)).json();
    expect(first.print.isDuplicate).toBe(false);
  });

  it('keeps the log append-only', async () => {
    // The log is only worth having if nothing can quietly remove an entry.
    const granted = await ownerQuery<{ privilege_type: string }>(
      fx.main.id,
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_name = 'receipt_print' AND grantee = 'healthcloud_app'
        ORDER BY privilege_type`,
    );
    expect(granted.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });

  it('keeps the receipt itself append-only', async () => {
    const granted = await ownerQuery<{ privilege_type: string }>(
      fx.main.id,
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_name = 'receipt' AND grantee = 'healthcloud_app'
        ORDER BY privilege_type`,
    );
    expect(granted.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });
});

// --- what is on it ----------------------------------------------------------

describe('what the sheet carries', () => {
  it('does not invent a doctor for a walk-in without one', async () => {
    // The walk-in fixture has a practitioner, so assert the shape rather than
    // the absence: an invoice with no appointment at all has nowhere to get one.
    const [invoice] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO invoice (tenant_id, number, patient_id, subtotal_paise, total_paise, updated_at)
       VALUES ($1, 'INV-NODOC', $2, 20000, 20000, now()) RETURNING id`,
      [fx.main.id, fx.main.patientIds[0]],
    );
    await ownerQuery(
      fx.main.id,
      `INSERT INTO invoice_line (tenant_id, invoice_id, description, quantity, unit_price_paise, total_paise)
       VALUES ($1, $2, 'Dressing only', 1, 20000, 20000)`,
      [fx.main.id, invoice!.id],
    );

    await pay(invoice!.id, 20000);
    const [paymentId] = await paymentIds(invoice!.id);
    const receipt = (await readReceipt(paymentId!)).json();

    expect(receipt.doctor).toBeNull();
    // And it still has an address, from the clinic's first location rather than
    // a blank line.
    expect(receipt.clinic.name).toBe('Main Clinic');
  });

  it('names the doctor on a test bill, which has no appointment_id of its own', async () => {
    const { appointmentId } = await bookedVisit();

    // A test bill: tied to the visit through `visit_appointment_id`, and
    // deliberately NOT through `appointment_id`, which is unique and already
    // taken by the consultation invoice. Before the visit link existed this
    // receipt printed a blank doctor and fell back to the clinic's first
    // location — wrong for anyone running two branches.
    const [invoice] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO invoice (tenant_id, number, patient_id, visit_appointment_id,
                            subtotal_paise, total_paise, updated_at)
       VALUES ($1, 'INV-TEST01', $2, $3, 45000, 45000, now()) RETURNING id`,
      [fx.main.id, fx.main.patientIds[0], appointmentId],
    );
    await ownerQuery(
      fx.main.id,
      `INSERT INTO invoice_line (tenant_id, invoice_id, description, quantity, unit_price_paise, total_paise)
       VALUES ($1, $2, 'X-ray Knee', 1, 45000, 45000)`,
      [fx.main.id, invoice!.id],
    );

    await pay(invoice!.id, 45000);
    const [paymentId] = await paymentIds(invoice!.id);
    const receipt = (await readReceipt(paymentId!)).json();

    expect(receipt.doctor?.fullName).toBe('Dr Asha Menon');
  });

  it('names the doctor when there is one', async () => {
    const invoice = await walkInVisit();
    await pay(invoice.id, CONSULT_FEE);

    const [paymentId] = await paymentIds(invoice.id);
    const receipt = (await readReceipt(paymentId!)).json();

    expect(receipt.doctor?.fullName).toBe('Dr Asha Menon');
  });

  it('hides the tax line when nothing carries tax', async () => {
    const { invoice } = await bookedVisit();
    await pay(invoice.id, CONSULT_FEE);

    const [paymentId] = await paymentIds(invoice.id);
    const receipt = (await readReceipt(paymentId!)).json();

    // No clinic here is GST-registered, so the sheet stays clean.
    expect(receipt.money.taxPaise).toBe(0);
    expect(receipt.showTax).toBe(false);
  });

  it('shows the tax line when something does carry tax', async () => {
    // A taxed service, priced through the administrator's own screen.
    await app.inject({
      method: 'POST',
      url: '/api/v1/setup/services',
      headers: { cookie: admin.cookie },
      payload: {
        code: 'TAXED-ITEM',
        name: 'Taxable consumable',
        category: 'CONSUMABLE',
        pricePaise: 10000,
        taxRateBasisPoints: 1800,
      },
    });

    const { invoice } = await bookedVisit();
    const services = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/services',
        headers: { cookie: finance.cookie },
      })
    ).json<{ services: Array<{ id: string; code: string }> }>();

    const taxed = services.services.find((s) => s.code === 'TAXED-ITEM')!;
    const withLine = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/lines`,
      headers: { cookie: finance.cookie },
      payload: { serviceId: taxed.id },
    });
    expect(withLine.statusCode).toBe(201);

    await pay(invoice.id, withLine.json().totalPaise);

    const [paymentId] = await paymentIds(invoice.id);
    const receipt = (await readReceipt(paymentId!)).json();

    // 18% of ₹100.00 is ₹18.00.
    expect(receipt.money.taxPaise).toBe(1800);
    expect(receipt.showTax).toBe(true);
  });

  it('reads the price AS CHARGED, not the current price', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/setup/services',
      headers: { cookie: admin.cookie },
      payload: {
        code: 'PROC-DRESS',
        name: 'Dressing',
        category: 'PROCEDURE',
        pricePaise: 25000,
      },
    });

    const { invoice } = await bookedVisit();
    const services = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/services',
        headers: { cookie: finance.cookie },
      })
    ).json<{ services: Array<{ id: string; code: string }> }>();

    const dressing = services.services.find((s) => s.code === 'PROC-DRESS')!;
    const billed = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/lines`,
      headers: { cookie: finance.cookie },
      payload: { serviceId: dressing.id },
    });

    await pay(invoice.id, billed.json().totalPaise);

    // The clinic puts its prices up afterwards.
    await app.inject({
      method: 'POST',
      url: '/api/v1/setup/services',
      headers: { cookie: admin.cookie },
      payload: {
        code: 'PROC-DRESS',
        name: 'Dressing',
        category: 'PROCEDURE',
        pricePaise: 40000,
      },
    });

    const [paymentId] = await paymentIds(invoice.id);
    const receipt = (await readReceipt(paymentId!)).json();

    // FR-PRC-03: a reprint in 2029 shows the ₹250 that was actually charged.
    const line = receipt.lines.find((l: { description: string }) => l.description === 'Dressing');
    expect(line.unitPricePaise).toBe(25000);
  });

  it('names the promotion beside a discount', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/promotions',
      headers: { cookie: admin.cookie },
      payload: {
        code: 'CAMP50',
        name: 'Camp discount',
        type: 'PERCENTAGE',
        value: 50,
        validFrom: clinicDate(-30),
        validTo: clinicDate(30),
      },
    });

    const [adminUser] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM app_user WHERE email = 'admin@main.test'`,
    );

    const { invoice } = await bookedVisit();
    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoice.id}/promotion`,
      headers: { cookie: finance.cookie },
      payload: { code: 'CAMP50', authorisedByUserId: adminUser!.id },
    });

    await pay(invoice.id, 30000);

    const [paymentId] = await paymentIds(invoice.id);
    const receipt = (await readReceipt(paymentId!)).json();

    // Never collapsed: ₹600 charged, ₹300 off, ₹300 payable. A sheet that said
    // ₹300 charged loses the fact that anything was given away.
    expect(receipt.money.totalChargedPaise).toBe(CONSULT_FEE);
    expect(receipt.money.discountPaise).toBe(30000);
    expect(receipt.money.discountLabel).toBe('CAMP50');
    expect(receipt.money.payablePaise).toBe(30000);
  });
});

// --- who may reach it -------------------------------------------------------

describe('who may print', () => {
  async function paidPayment() {
    const { invoice } = await bookedVisit();
    await pay(invoice.id, CONSULT_FEE);
    const [paymentId] = await paymentIds(invoice.id);
    return paymentId!;
  }

  it('lets the finance desk and the front desk print', async () => {
    const paymentId = await paidPayment();
    expect((await readReceipt(paymentId, finance)).statusCode).toBe(200);
    expect((await readReceipt(paymentId, frontDesk)).statusCode).toBe(200);
  });

  it('refuses a doctor, who cannot see the bill either', async () => {
    const paymentId = await paidPayment();
    expect((await readReceipt(paymentId, doctor)).statusCode).toBe(403);
  });

  it('never reaches another clinic receipt', async () => {
    const paymentId = await paidPayment();

    // Row-level security: the payment is simply not visible, so there is no
    // receipt to find.
    expect((await readReceipt(paymentId, otherFinance)).statusCode).toBe(404);
    expect((await printReceipt(paymentId, otherFinance)).statusCode).toBe(404);
  });

  it('refuses an unauthenticated caller', async () => {
    const paymentId = await paidPayment();
    const res = await app.inject({ method: 'GET', url: `/api/v1/payments/${paymentId}/receipt` });
    expect(res.statusCode).toBe(401);
  });
});
