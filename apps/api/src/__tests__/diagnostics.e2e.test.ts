/**
 * Diagnostic departments and orders — checkpoint 2 of docs/09.
 *
 * Two properties carry this file.
 *
 * **A department does not order its own work.** The `diagnostics` role holds
 * `diagnostic:result` and deliberately not `diagnostic:order`, so a radiographer
 * cannot raise the request they are about to fulfil. That separation is the
 * reason there are three permissions here rather than one.
 *
 * **The patient comes from the visit, never from the request.** A caller
 * supplies an appointment id and gets the patient attached to it; there is no
 * field with which to file an order for one patient against another's visit.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
let doctor: Session;
let admin: Session;
let frontDesk: Session;
let otherAdmin: Session;

let xrayDepartmentId: string;
let diagnosticsUser: Session;

/** A priced X-ray on the catalogue, and a priced test the X-ray room does not do. */
let kneeXrayId: string;
let bloodCountId: string;
let pathologyDepartmentId: string;
/**
 * A diagnostic department with nothing priced against it.
 *
 * Free text is only an order where the department HAS no catalogue — once it
 * has one, "anything else" means the centre does not do it and belongs on the
 * slip instead (decision (b)). Every test below that raises an unpriced order
 * uses this department, which is the only place such an order is still legal.
 */
let plainDepartmentId: string;
let adminUserId: string;

/** A real PDF, by signature. Four bytes is all the sniffer reads. */
const REPORT = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);

/** Upload a file against an order, the way diagnostic staff would. */
async function attach(session: Session, orderId: string, fileName = 'knee-ap.pdf') {
  const form = new FormData();
  form.set('file', new File([REPORT], fileName));
  const request = new Request('http://localhost/x', { method: 'POST', body: form });

  return app.inject({
    method: 'POST',
    url: `/api/v1/diagnostics/orders/${orderId}/documents`,
    headers: {
      cookie: session.cookie,
      'content-type': request.headers.get('content-type') as string,
    },
    payload: Buffer.from(await request.arrayBuffer()),
  });
}

/** The clinic's consulting department, seeded by the harness. Not diagnostic. */
async function consultingDepartmentId(): Promise<string> {
  const [row] = await ownerQuery<{ id: string }>(
    fx.main.id,
    'SELECT id FROM department WHERE is_diagnostic = false LIMIT 1',
  );
  return row!.id;
}

/**
 * One visit per clinic, created once.
 *
 * A walk-in rather than a booked appointment: booking needs a free slot, and
 * availability returns only what is still open, so indexing that list across a
 * dozen tests produces conflicts that read like failures of the feature under
 * test. And ONE visit rather than one per test, because a patient can only be in
 * a doctor's queue once and the fixture has three of them — nothing here depends
 * on the orders being spread across different visits.
 */
async function createVisit(tenant: 'main' | 'other'): Promise<string> {
  const clinic = fx[tenant];
  const session = tenant === 'main' ? frontDesk : otherAdmin;

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/appointments/walk-in',
    headers: { cookie: session.cookie },
    payload: {
      patientId: clinic.patientIds[0],
      practitionerId: clinic.practitionerId,
      locationId: clinic.locationId,
    },
  });

  // Surfaced rather than asserted bare: "expected 409 to be 201" sends you
  // reading the wrong file.
  if (res.statusCode !== 201) {
    throw new Error(`Could not create a visit for the test: ${res.statusCode} ${res.payload}`);
  }
  return res.json<{ id: string }>().id;
}

let mainVisit: string;
let otherVisit: string;

/** Put a priced test on the clinic's catalogue, the way an administrator would. */
async function priceTest(
  session: Session,
  body: { code: string; name: string; pricePaise: number; departmentId: string | null },
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/setup/services',
    headers: { cookie: session.cookie },
    payload: { category: 'DIAGNOSTIC', ...body },
  });
  if (res.statusCode !== 201 && res.statusCode !== 200) {
    throw new Error(`Could not price a test: ${res.statusCode} ${res.payload}`);
  }
  return res.json<{ id: string }>().id;
}

async function order(session: Session, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/diagnostics/orders',
    headers: { cookie: session.cookie },
    payload: body,
  });
}

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();

  doctor = await login(app, fx.main.slug, 'doctor@main.test');
  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  admin = await loginWithMfa(app, fx.main.slug, 'admin@main.test');
  otherAdmin = await loginWithMfa(app, fx.other.slug, 'admin@other.test');

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/departments',
    headers: { cookie: admin.cookie },
    payload: { name: 'X-ray', isDiagnostic: true },
  });
  expect(created.statusCode).toBe(201);
  xrayDepartmentId = created.json<{ id: string }>().id;

  const pathology = await app.inject({
    method: 'POST',
    url: '/api/v1/departments',
    headers: { cookie: admin.cookie },
    payload: { name: 'Pathology', isDiagnostic: true },
  });
  expect(pathology.statusCode).toBe(201);
  pathologyDepartmentId = pathology.json<{ id: string }>().id;

  const plain = await app.inject({
    method: 'POST',
    url: '/api/v1/departments',
    headers: { cookie: admin.cookie },
    payload: { name: 'ECG', isDiagnostic: true },
  });
  expect(plain.statusCode).toBe(201);
  plainDepartmentId = plain.json<{ id: string }>().id;

  kneeXrayId = await priceTest(admin, {
    code: 'XR-KNEE',
    name: 'X-ray Knee',
    pricePaise: 45_000,
    departmentId: xrayDepartmentId,
  });
  bloodCountId = await priceTest(admin, {
    code: 'PATH-CBC',
    name: 'Complete Blood Count',
    pricePaise: 30_000,
    departmentId: pathologyDepartmentId,
  });

  const [adminRow] = await ownerQuery<{ id: string }>(
    fx.main.id,
    `SELECT id FROM app_user WHERE email = 'admin@main.test'`,
  );
  adminUserId = adminRow!.id;

  mainVisit = await createVisit('main');
  otherVisit = await createVisit('other');

  /**
   * A real Diagnostics user, created through the API a clinic would use.
   *
   * Asserting the role's permission list is one thing; signing in as somebody
   * holding it and finding out what they can actually reach is another, and only
   * the second catches a guard wired to the wrong permission. Every test below
   * that attaches or completes runs as this user rather than as the
   * administrator, who holds everything and would pass whatever the guards said.
   */
  const staff = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: { cookie: admin.cookie },
    payload: {
      email: 'radiographer@main.test',
      fullName: 'Meera Radiographer',
      roleKeys: ['diagnostics'],
    },
  });
  if (staff.statusCode !== 201) {
    throw new Error(`Could not create the diagnostics user: ${staff.statusCode} ${staff.payload}`);
  }

  diagnosticsUser = await login(
    app,
    fx.main.slug,
    'radiographer@main.test',
    staff.json<{ temporaryPassword: string }>().temporaryPassword,
  );
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  // Documents first: they reference orders, and the order rows cannot go while
  // a document still points at one.
  await ownerQuery(fx.main.id, 'DELETE FROM clinical_document');
  await ownerQuery(fx.other.id, 'DELETE FROM clinical_document');
  await ownerQuery(fx.main.id, 'DELETE FROM diagnostic_order');
  await ownerQuery(fx.other.id, 'DELETE FROM diagnostic_order');
  // Encounters and the past visits the history tests fabricate. Encounters
  // first: they reference the appointment rows below them.
  await ownerQuery(fx.main.id, 'DELETE FROM encounter');
  await ownerQuery(fx.main.id, `DELETE FROM appointment WHERE status = 'FULFILLED'`);

  /**
   * Test bills, and only test bills.
   *
   * The consultation invoice for each visit is raised once at walk-in and has
   * to survive, or every assertion about "two bills, one of each" would be
   * testing a clinic that never billed the consultation. A test bill is the one
   * with no `appointment_id` — see the migration for why that column means
   * something narrower than "belongs to this visit".
   */
  for (const tenant of [fx.main.id, fx.other.id]) {
    const scope = 'SELECT id FROM invoice WHERE appointment_id IS NULL';
    await ownerQuery(
      tenant,
      'UPDATE invoice SET active_promotion_application_id = NULL WHERE appointment_id IS NULL',
    );
    await ownerQuery(tenant, `DELETE FROM promotion_application WHERE invoice_id IN (${scope})`);
    await ownerQuery(
      tenant,
      `DELETE FROM receipt_print WHERE receipt_id IN (SELECT id FROM receipt WHERE invoice_id IN (${scope}))`,
    );
    await ownerQuery(tenant, `DELETE FROM receipt WHERE invoice_id IN (${scope})`);
    await ownerQuery(tenant, `DELETE FROM payment WHERE invoice_id IN (${scope})`);
    await ownerQuery(tenant, `DELETE FROM invoice_line WHERE invoice_id IN (${scope})`);
    await ownerQuery(tenant, 'DELETE FROM invoice WHERE appointment_id IS NULL');
  }
});

describe('diagnostic departments', () => {
  it('are listed separately from the booking departments', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/departments',
      headers: { cookie: doctor.cookie },
    });

    expect(res.json<{ departments: Array<{ name: string }> }>().departments).toContainEqual(
      expect.objectContaining({ name: 'X-ray' }),
    );
  });

  /**
   * The reason the flag exists. Radiology has no slots — offering it at the
   * first step of booking produces an appointment nobody can fill.
   */
  /**
   * And the mirror of it: setup MUST show what booking hides, or an
   * administrator creates an X-ray department and never sees it again.
   */
  it('do appear in the setup listing, marked as diagnostic', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/setup/departments',
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(
      res.json<{ departments: Array<{ name: string; isDiagnostic: boolean }> }>().departments,
    ).toContainEqual(expect.objectContaining({ name: 'X-ray', isDiagnostic: true }));
  });

  it('do not appear on the booking screen', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/departments',
      headers: { cookie: frontDesk.cookie },
    });

    const names = res
      .json<{ departments: Array<{ name: string }> }>()
      .departments.map((d) => d.name);

    expect(names).not.toContain('X-ray');
    expect(names.length).toBeGreaterThan(0);
  });
});

describe('raising an order', () => {
  it('records it against the visit and its patient', async () => {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: plainDepartmentId,
      description: 'X-ray left knee, AP and lateral',
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      status: string;
      description: string;
      patient: { id: string };
      department: { name: string };
    }>();

    expect(body.status).toBe('PENDING');
    expect(body.description).toBe('X-ray left knee, AP and lateral');
    expect(body.department.name).toBe('ECG');

    // The patient came from the appointment, not from the request — there is no
    // patientId field to send.
    const [row] = await ownerQuery<{ patient_id: string }>(
      fx.main.id,
      'SELECT patient_id FROM diagnostic_order',
    );
    expect(body.patient.id).toBe(row?.patient_id);
  });

  it('refuses a department that does not do tests', async () => {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: await consultingDepartmentId(),
      description: 'X-ray left knee',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details?.code).toBe('NOT_A_DIAGNOSTIC_DEPARTMENT');
  });

  it('refuses a visit from another clinic', async () => {
    const res = await order(doctor, {
      appointmentId: otherVisit,
      departmentId: plainDepartmentId,
      description: 'X-ray left knee',
    });

    expect(res.statusCode).toBe(404);
  });

  it('refuses a caller without diagnostic:order', async () => {
    const res = await order(frontDesk, {
      appointmentId: mainVisit,
      departmentId: plainDepartmentId,
      description: 'X-ray left knee',
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('the test catalogue', () => {
  it('lists the clinic\u2019s priced tests, with the fee, to whoever may order', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/catalogue',
      headers: { cookie: doctor.cookie },
    });

    expect(res.statusCode).toBe(200);
    const { tests } = res.json<{
      tests: Array<{ id: string; name: string; pricePaise: number }>;
    }>();

    const knee = tests.find((t) => t.id === kneeXrayId);
    expect(knee).toBeDefined();
    // The fee is the point of the endpoint (decision (f)). A doctor who cannot
    // see it orders a scan without knowing what it costs the patient.
    expect(knee?.pricePaise).toBe(45_000);
  });

  it('narrows to one department, so the form offers only what that room does', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/diagnostics/catalogue?departmentId=${xrayDepartmentId}`,
      headers: { cookie: doctor.cookie },
    });

    expect(res.statusCode).toBe(200);
    const ids = res.json<{ tests: Array<{ id: string }> }>().tests.map((t) => t.id);
    expect(ids).toContain(kneeXrayId);
    expect(ids).not.toContain(bloodCountId);
  });

  it('leaves out a test no department performs \u2014 it has no worklist to land on', async () => {
    const orphan = await priceTest(admin, {
      code: 'XR-ORPHAN',
      name: 'Unassigned Scan',
      pricePaise: 10_000,
      departmentId: null,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/catalogue',
      headers: { cookie: doctor.cookie },
    });

    expect(res.json<{ tests: Array<{ id: string }> }>().tests.map((t) => t.id)).not.toContain(
      orphan,
    );
  });

  it('refuses the diagnostics room, which does not order its own work', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/catalogue',
      headers: { cookie: diagnosticsUser.cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  it('reaches the finance desk, which sells these tests at the counter', async () => {
    const staff = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie: admin.cookie },
      payload: {
        email: 'catalogue-finance@main.test',
        fullName: 'Counter Finance',
        roleKeys: ['finance'],
      },
    });
    expect(staff.statusCode).toBe(201);
    const financeUser = await login(
      app,
      fx.main.slug,
      'catalogue-finance@main.test',
      staff.json<{ temporaryPassword: string }>().temporaryPassword,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/catalogue',
      headers: { cookie: financeUser.cookie },
    });

    /**
     * Finance holds `diagnostic:order:walkin` and deliberately NOT
     * `diagnostic:order` — giving it the latter would let the desk order tests
     * on anybody's consultation. This route accepts either, which is why the
     * walk-in screen can show a price list at all: it was gated on the
     * doctor's permission alone, so the fetch 403'd, the catalogue came back
     * empty and the whole section silently failed to render.
     */
    expect(res.statusCode).toBe(200);
    expect(res.json<{ tests: Array<{ id: string }> }>().tests.map((t) => t.id)).toContain(
      kneeXrayId,
    );
  });

  it('still refuses somebody who orders nothing at all', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/catalogue',
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  it("never shows one clinic another's price list", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/catalogue',
      headers: { cookie: otherAdmin.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ tests: Array<{ id: string }> }>().tests.map((t) => t.id)).not.toContain(
      kneeXrayId,
    );
  });
});

describe('ordering a catalogue test', () => {
  it('records which test it was, and keeps the description as the record', async () => {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
      description: 'X-ray Knee \u2014 left, AP and lateral',
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ service: { id: string; name: string } | null; description: string }>();
    expect(body.service?.id).toBe(kneeXrayId);
    // The doctor's own words survive the pick: laterality and view are exactly
    // what a catalogue entry cannot carry.
    expect(body.description).toBe('X-ray Knee \u2014 left, AP and lateral');
  });

  it('falls back to the catalogue name when the doctor typed nothing', async () => {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ description: string }>().description).toBe('X-ray Knee');
  });

  it('refuses the same test twice on one visit', async () => {
    const first = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });
    expect(first.statusCode).toBe(201);

    const again = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });

    expect(again.statusCode).toBe(409);
    expect(again.json().error.details?.code).toBe('TEST_ALREADY_ORDERED');
  });

  it('lets it be ordered again once the first was declined', async () => {
    const first = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/diagnostics/orders/${first.json<{ id: string }>().id}/decline`,
      headers: { cookie: frontDesk.cookie },
    });

    // The guard counts ACTIVE orders only. Counting declined ones would leave
    // a mis-click permanently blocking the test it removed.
    const again = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });
    expect(again.statusCode).toBe(201);
  });

  it('refuses a test the chosen department does not perform', async () => {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: bloodCountId,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details?.code).toBe('TEST_WRONG_DEPARTMENT');
  });

  it('refuses a test that is no longer offered', async () => {
    const retired = await priceTest(admin, {
      code: 'XR-OLD',
      name: 'Retired View',
      pricePaise: 5_000,
      departmentId: xrayDepartmentId,
    });
    const off = await app.inject({
      method: 'PATCH',
      url: `/api/v1/setup/services/${retired}/active`,
      headers: { cookie: admin.cookie },
      payload: { isActive: false },
    });
    expect(off.statusCode).toBe(200);

    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: retired,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details?.code).toBe('TEST_INACTIVE');
  });

  it("refuses another clinic's test, which is how a price list leaks", async () => {
    const res = await order(otherAdmin, {
      appointmentId: otherVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });

    // The department belongs to the main clinic too, so this never reaches the
    // service check \u2014 either refusal proves the tenant boundary held.
    expect([400, 404]).toContain(res.statusCode);
  });

  it('still takes a free-text order, for a clinic that has priced nothing', async () => {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: plainDepartmentId,
      description: 'X-ray left knee, AP and lateral',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ service: unknown }>().service).toBeNull();
  });

  it('refuses an order that says nothing at all', async () => {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details?.code).toBe('DESCRIPTION_REQUIRED');
  });
});

describe('billing a doctor-ordered test', () => {
  /** Every invoice this visit produced, newest first. */
  async function billsFor(appointmentId: string) {
    return ownerQuery<{
      id: string;
      appointment_id: string | null;
      visit_appointment_id: string | null;
      total_paise: number;
      status: string;
    }>(
      fx.main.id,
      `SELECT id, appointment_id, visit_appointment_id, total_paise, status
         FROM invoice
        WHERE visit_appointment_id = $1
        ORDER BY issued_at DESC, number DESC`,
      [appointmentId],
    );
  }

  /** The test bills only — the consultation's is the one holding appointment_id. */
  async function testBillsFor(appointmentId: string) {
    return (await billsFor(appointmentId)).filter((i) => i.appointment_id === null);
  }

  it('raises the charge on its own bill, never on the consultation invoice', async () => {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });
    expect(res.statusCode).toBe(201);

    const tests = await testBillsFor(mainVisit);

    // Its own bill: `appointment_id` null, so it is not the consultation
    // invoice — that one is settled at the desk before the doctor is reached
    // and will not take another line. This is the trade-off the clinic
    // accepted, two bills for one visit.
    expect(tests).toHaveLength(1);
    expect(tests[0]!.total_paise).toBe(45_000);

    // And still tied to the visit, which is what keeps test revenue out of the
    // finance report's "not attributed to a doctor" bucket.
    expect(tests[0]!.visit_appointment_id).toBe(mainVisit);

    // This clinic has priced no consultation, so there is no consultation bill
    // to confuse with it. Billing is opt-in per tenant — see `seedBilling`.
    expect((await billsFor(mainVisit)).filter((i) => i.appointment_id !== null)).toHaveLength(0);
  });

  it('puts a second test on the same open bill rather than a second one', async () => {
    await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });
    await order(doctor, {
      appointmentId: mainVisit,
      departmentId: pathologyDepartmentId,
      serviceId: bloodCountId,
    });

    const tests = await testBillsFor(mainVisit);
    expect(tests).toHaveLength(1);
    // 45,000 + 30,000: one bill the patient pays once.
    expect(tests[0]!.total_paise).toBe(75_000);
  });

  it('snapshots the price and the words onto the line', async () => {
    await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
      description: 'X-ray Knee — left, AP and lateral',
    });

    const [line] = await ownerQuery<{
      description: string;
      unit_price_paise: number;
      service_id: string;
    }>(
      fx.main.id,
      `SELECT l.description, l.unit_price_paise, l.service_id
         FROM invoice_line l
         JOIN invoice i ON i.id = l.invoice_id
        WHERE i.appointment_id IS NULL AND i.visit_appointment_id = $1`,
      [mainVisit],
    );

    expect(line?.description).toBe('X-ray Knee — left, AP and lateral');
    expect(line?.unit_price_paise).toBe(45_000);
    expect(line?.service_id).toBe(kneeXrayId);
  });

  it('links the order to its charge, and marks it billable', async () => {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });

    const body = res.json<{ invoiceLineId: string | null; billing: { status: string } }>();
    expect(body.invoiceLineId).not.toBeNull();
    // Raised after the migration, so the gate applies to it — and the bill is
    // open the instant it is raised. `legacyUnbilled` is deliberately not on
    // the wire: screens get the state, not the flags behind it.
    expect(body.billing.status).toBe('UNPAID');
  });

  it('raises nothing for a free-text order — the clinic has no price for it', async () => {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: plainDepartmentId,
      description: 'MRI brain, plain',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ invoiceLineId: string | null }>().invoiceLineId).toBeNull();
    expect(await testBillsFor(mainVisit)).toHaveLength(0);
  });

  it('opens a fresh bill once the open one has been paid', async () => {
    await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });
    const [first] = await testBillsFor(mainVisit);

    const paid = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${first!.id}/payments`,
      headers: { cookie: frontDesk.cookie },
      payload: { mode: 'CASH', amountPaise: 45_000 },
    });
    expect(paid.statusCode).toBe(201);

    const second = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: pathologyDepartmentId,
      serviceId: bloodCountId,
    });
    expect(second.statusCode).toBe(201);

    const tests = await testBillsFor(mainVisit);
    expect(tests).toHaveLength(2);
    // The paid one is untouched — appending to it is exactly what `loadEditable`
    // refuses, and rightly.
    expect(tests.find((i) => i.id === first!.id)?.total_paise).toBe(45_000);
  });

  it('opens a fresh bill rather than failing when finance has put a discount on the open one', async () => {
    await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });
    const [first] = await testBillsFor(mainVisit);

    const promotion = await app.inject({
      method: 'POST',
      url: '/api/v1/promotions',
      headers: { cookie: admin.cookie },
      payload: {
        code: `CAMP${Date.now() % 100000}`,
        name: 'Camp discount',
        type: 'PERCENTAGE',
        value: 10,
        validFrom: '2026-01-01',
      },
    });
    expect(promotion.statusCode).toBe(201);

    const applied = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${first!.id}/promotion`,
      headers: { cookie: admin.cookie },
      payload: {
        promotionId: promotion.json<{ id: string }>().id,
        authorisedByUserId: adminUserId,
      },
    });
    expect(applied.statusCode).toBe(201);

    /**
     * The point of the whole test.
     *
     * A promotion closes an invoice to new lines — see `loadEditable`. Finance
     * applied it in another room; the doctor cannot see it and could not undo
     * it. If the order failed here, the doctor would get a billing error about
     * a discount they know nothing about, on a screen with no way to act on it.
     */
    const second = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: pathologyDepartmentId,
      serviceId: bloodCountId,
    });
    expect(second.statusCode).toBe(201);

    const tests = await testBillsFor(mainVisit);
    expect(tests).toHaveLength(2);
    expect(tests.find((i) => i.id !== first!.id)?.total_paise).toBe(30_000);
  });

  it('leaves no charge behind when the order itself is refused', async () => {
    // The department does not perform this test, so the order fails after the
    // point where a charge could have been raised. One transaction or none.
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: bloodCountId,
    });
    expect(res.statusCode).toBe(400);

    expect(await testBillsFor(mainVisit)).toHaveLength(0);
  });
});

describe('the pay-first gate on a test', () => {
  /** Order a priced test and hand back the order id and its bill. */
  async function billedOrder(): Promise<{ orderId: string; invoiceId: string }> {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });
    expect(res.statusCode).toBe(201);

    const [bill] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM invoice WHERE appointment_id IS NULL AND visit_appointment_id = $1`,
      [mainVisit],
    );
    return { orderId: res.json<{ id: string }>().id, invoiceId: bill!.id };
  }

  async function pay(invoiceId: string, amountPaise: number) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/payments`,
      headers: { cookie: frontDesk.cookie },
      payload: { mode: 'CASH', amountPaise },
    });
    expect(res.statusCode).toBe(201);
  }

  async function complete(orderId: string) {
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/diagnostics/orders/${orderId}/complete`,
      headers: { cookie: diagnosticsUser.cookie },
      payload: { resultNote: 'No fracture.' },
    });
  }

  it('still shows the order on the worklist, with the bill flagged', async () => {
    const { orderId } = await billedOrder();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/orders',
      headers: { cookie: diagnosticsUser.cookie },
    });

    const row = res
      .json<{ orders: Array<{ id: string; billing: { status: string; balancePaise: number } }> }>()
      .orders.find((o) => o.id === orderId);

    // Decision (c). The patient is standing at the counter; a row that quietly
    // vanishes is how a clinic loses somebody in a corridor.
    expect(row).toBeDefined();
    expect(row?.billing.status).toBe('UNPAID');
    expect(row?.billing.balancePaise).toBe(45_000);
  });

  it('never puts the bill’s payments in front of the diagnostics room', async () => {
    await billedOrder();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/orders',
      headers: { cookie: diagnosticsUser.cookie },
    });

    // The state, not the ledger. This role holds no billing permission at all.
    expect(res.payload).not.toContain('"payments"');
    expect(res.payload).not.toContain('"invoiceLine"');
  });

  it('refuses to attach a result while the bill is open', async () => {
    const { orderId } = await billedOrder();

    const res = await attach(diagnosticsUser, orderId);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('TEST_NOT_PAID');
  });

  it('refuses to mark it done while the bill is open', async () => {
    const { orderId } = await billedOrder();

    const res = await complete(orderId);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('TEST_NOT_PAID');
  });

  it('still refuses after a part payment', async () => {
    const { orderId, invoiceId } = await billedOrder();
    await pay(invoiceId, 20_000);

    const res = await complete(orderId);

    expect(res.statusCode).toBe(409);
  });

  it('lets both through the moment the bill is cleared', async () => {
    const { orderId, invoiceId } = await billedOrder();
    await pay(invoiceId, 45_000);

    expect((await attach(diagnosticsUser, orderId)).statusCode).toBe(201);
    expect((await complete(orderId)).statusCode).toBe(200);
  });

  it('lets a free-text order through — it was never billed, and that is not the patient’s doing', async () => {
    const raised = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: plainDepartmentId,
      description: 'MRI brain, plain',
    });
    const orderId = raised.json<{ id: string; billing: { status: string } }>().id;

    // Shown for information, so the desk can see the gap in the price list.
    expect(raised.json<{ billing: { status: string } }>().billing.status).toBe('NOT_BILLED');

    // But never blocked: a gap in the price list is an administrator's problem,
    // not a reason to hold a patient's report.
    expect((await attach(diagnosticsUser, orderId)).statusCode).toBe(201);
    expect((await complete(orderId)).statusCode).toBe(200);
  });

  it('lets an order raised before billing existed through', async () => {
    const { orderId } = await billedOrder();

    // Exactly what the migration's column default did to every row that already
    // existed. Without this the gate would freeze a clinic's whole worklist on
    // the morning it ships.
    await ownerQuery(
      fx.main.id,
      'UPDATE diagnostic_order SET legacy_unbilled = true WHERE id = $1',
      [orderId],
    );

    expect((await complete(orderId)).statusCode).toBe(200);
  });

  it('blocks a test whose bill was cancelled, and says so', async () => {
    const { orderId, invoiceId } = await billedOrder();

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/cancel`,
      headers: { cookie: admin.cookie },
      payload: { reason: 'Raised against the wrong patient' },
    });
    expect(cancelled.statusCode).toBe(201);

    const res = await complete(orderId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('cancelled');
  });
});

describe('declining a test', () => {
  async function billedOrder(): Promise<{ orderId: string; invoiceId: string; lineId: string }> {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });
    expect(res.statusCode).toBe(201);

    const [line] = await ownerQuery<{ id: string; invoice_id: string }>(
      fx.main.id,
      `SELECT l.id, l.invoice_id
         FROM invoice_line l
         JOIN invoice i ON i.id = l.invoice_id
        WHERE i.appointment_id IS NULL AND i.visit_appointment_id = $1`,
      [mainVisit],
    );
    return {
      orderId: res.json<{ id: string }>().id,
      invoiceId: line!.invoice_id,
      lineId: line!.id,
    };
  }

  async function decline(session: Session, orderId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/diagnostics/orders/${orderId}/decline`,
      headers: { cookie: session.cookie },
    });
  }

  it('takes the charge off the bill entirely, leaving no phantom discount', async () => {
    const { orderId, invoiceId, lineId } = await billedOrder();

    const res = await decline(frontDesk, orderId);
    expect(res.statusCode).toBe(201);
    expect(res.json<{ status: string }>().status).toBe('DECLINED');

    // The line is gone. Writing its value into `discountPaise` instead printed
    // the patient a charge they never incurred beside a discount they never
    // got — and, because promotions live in that same column, broke every
    // guard that read it and inflated "discount given" in the revenue report.
    const lines = await ownerQuery(fx.main.id, `SELECT id FROM invoice_line WHERE id = $1`, [
      lineId,
    ]);
    expect(lines).toHaveLength(0);

    const [invoice] = await ownerQuery<{
      subtotal_paise: number;
      discount_paise: number;
      total_paise: number;
      status: string;
    }>(
      fx.main.id,
      `SELECT subtotal_paise, discount_paise, total_paise, status FROM invoice WHERE id = $1`,
      [invoiceId],
    );
    expect(invoice?.subtotal_paise).toBe(0);
    expect(invoice?.discount_paise).toBe(0);
    expect(invoice?.total_paise).toBe(0);
  });

  it('cancels the bill when that was the last charge on it', async () => {
    const { orderId, invoiceId } = await billedOrder();
    await decline(frontDesk, orderId);

    const [invoice] = await ownerQuery<{ status: string; reason: string | null }>(
      fx.main.id,
      `SELECT status, reason FROM invoice WHERE id = $1`,
      [invoiceId],
    );

    // Otherwise every declined single-test visit leaves a ₹0 bill on the
    // outstanding list forever, and a list full of nothing is a list nobody reads.
    expect(invoice?.status).toBe('CANCELLED');
    expect(invoice?.reason).toBeTruthy();
  });

  it('leaves a bill alone while other charges remain on it', async () => {
    const { orderId, invoiceId } = await billedOrder();
    await order(doctor, {
      appointmentId: mainVisit,
      departmentId: pathologyDepartmentId,
      serviceId: bloodCountId,
    });

    await decline(frontDesk, orderId);

    const [invoice] = await ownerQuery<{ status: string; total_paise: number }>(
      fx.main.id,
      `SELECT status, total_paise FROM invoice WHERE id = $1`,
      [invoiceId],
    );
    expect(invoice?.status).toBe('UNPAID');
    expect(invoice?.total_paise).toBe(30_000);
  });

  it('lets more than one test be taken off the same bill', async () => {
    const first = await billedOrder();
    const second = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: pathologyDepartmentId,
      serviceId: bloodCountId,
    });

    expect((await decline(frontDesk, first.orderId)).statusCode).toBe(201);

    // The old version wrote a line discount, which made `invoice.discountPaise`
    // non-zero — and the desk's Decline button was gated on that being zero, so
    // exactly one test could ever be removed.
    expect((await decline(frontDesk, second.json<{ id: string }>().id)).statusCode).toBe(201);
  });

  it('puts a declined test back, on a fresh charge', async () => {
    const { orderId } = await billedOrder();
    await decline(frontDesk, orderId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/diagnostics/orders/${orderId}/undecline`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ status: string; invoiceLineId: string | null }>();
    expect(body.status).toBe('PENDING');
    expect(body.invoiceLineId).not.toBeNull();

    // A new bill, because the old one auto-cancelled when its last line went.
    const open = await ownerQuery<{ total_paise: number }>(
      fx.main.id,
      `SELECT total_paise FROM invoice
        WHERE appointment_id IS NULL AND visit_appointment_id = $1 AND status = 'UNPAID'`,
      [mainVisit],
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.total_paise).toBe(45_000);
  });

  it('refuses to put back something that was never declined', async () => {
    const { orderId } = await billedOrder();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/diagnostics/orders/${orderId}/undecline`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details?.code).toBe('ORDER_NOT_DECLINED');
  });

  it('refuses the diagnostics room a put-back — it is a money action', async () => {
    const { orderId } = await billedOrder();
    await decline(frontDesk, orderId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/diagnostics/orders/${orderId}/undecline`,
      headers: { cookie: diagnosticsUser.cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  it('stops the department running it, and says why', async () => {
    const { orderId } = await billedOrder();
    await decline(frontDesk, orderId);

    const attached = await attach(diagnosticsUser, orderId);
    expect(attached.statusCode).toBe(400);
    expect(attached.json().error.details?.code).toBe('ORDER_DECLINED');

    const completed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/diagnostics/orders/${orderId}/complete`,
      headers: { cookie: diagnosticsUser.cookie },
      payload: { resultNote: 'No fracture.' },
    });
    expect(completed.statusCode).toBe(400);
    // Told apart from "unpaid" in as many words: nobody is coming, and no
    // money is due. A technician must not be left chasing a bill.
    expect(completed.json().error.message).toContain('declined');
  });

  it('drops off the to-do list and turns up under declined', async () => {
    const { orderId } = await billedOrder();
    await decline(frontDesk, orderId);

    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/orders?status=PENDING',
      headers: { cookie: diagnosticsUser.cookie },
    });
    expect(pending.json<{ orders: Array<{ id: string }> }>().orders).toHaveLength(0);

    const declined = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/orders?status=DECLINED',
      headers: { cookie: diagnosticsUser.cookie },
    });
    expect(declined.json<{ orders: Array<{ id: string }> }>().orders.map((o) => o.id)).toContain(
      orderId,
    );
  });

  it('refuses once money has been taken — that is a refund, not a decline', async () => {
    const { orderId, invoiceId } = await billedOrder();

    const paid = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/payments`,
      headers: { cookie: frontDesk.cookie },
      payload: { mode: 'CASH', amountPaise: 45_000 },
    });
    expect(paid.statusCode).toBe(201);

    const res = await decline(frontDesk, orderId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('ALREADY_PAID');
  });

  it('refuses while a promotion is on the bill, which is the whole reason it goes through loadEditable', async () => {
    const { orderId, invoiceId } = await billedOrder();

    const promotion = await app.inject({
      method: 'POST',
      url: '/api/v1/promotions',
      headers: { cookie: admin.cookie },
      payload: {
        code: `DECL${Date.now() % 100000}`,
        name: 'Camp discount',
        type: 'PERCENTAGE',
        value: 10,
        validFrom: '2026-01-01',
      },
    });
    const applied = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/promotion`,
      headers: { cookie: admin.cookie },
      payload: {
        promotionId: promotion.json<{ id: string }>().id,
        authorisedByUserId: adminUserId,
      },
    });
    expect(applied.statusCode).toBe(201);

    /**
     * `apply` writes the promotion's share onto the LINE, and freezes the
     * total in an append-only `promotion_application` row. Zeroing the line
     * here would overwrite that share while the frozen row kept claiming the
     * original figure — and the finance report reads the frozen row, so the
     * clinic would be reported giving away money it never gave.
     */
    const res = await decline(frontDesk, orderId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('PROMOTION_APPLIED');
  });

  it('refuses a test that was never charged for — cancelling is the right verb', async () => {
    const raised = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: plainDepartmentId,
      description: 'MRI brain, plain',
    });

    const res = await decline(frontDesk, raised.json<{ id: string }>().id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details?.code).toBe('ORDER_NOT_BILLED');
  });

  it('refuses a second time, and refuses one already done', async () => {
    const { orderId, invoiceId } = await billedOrder();
    await decline(frontDesk, orderId);

    expect((await decline(frontDesk, orderId)).statusCode).toBe(400);

    const other = await billedOrder();
    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${other.invoiceId}/payments`,
      headers: { cookie: frontDesk.cookie },
      payload: { mode: 'CASH', amountPaise: 45_000 },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/diagnostics/orders/${other.orderId}/complete`,
      headers: { cookie: diagnosticsUser.cookie },
      payload: { resultNote: 'No fracture.' },
    });

    const res = await decline(frontDesk, other.orderId);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('already been done');
    expect(invoiceId).toBeDefined();
  });

  it('refuses the diagnostics room, which does not decide what a patient pays for', async () => {
    const { orderId } = await billedOrder();

    expect((await decline(diagnosticsUser, orderId)).statusCode).toBe(403);
  });

  it('will not let the charge be deleted instead, and says what to do', async () => {
    const { invoiceId, lineId } = await billedOrder();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${invoiceId}/lines/${lineId}`,
      headers: { cookie: frontDesk.cookie },
    });

    // The foreign key is RESTRICT, so this would have failed anyway — as a
    // constraint violation reaching the desk as a 500 that explains nothing.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('LINE_IS_A_TEST');
    expect(res.json().error.message).toContain('Decline the test instead');
  });
});

describe('a test this centre does not do', () => {
  async function setNote(session: Session, note: string | null) {
    return app.inject({
      method: 'PUT',
      url: `/api/v1/appointments/${mainVisit}/external-test-note`,
      headers: { cookie: session.cookie },
      payload: { note },
    });
  }

  it('refuses to make an order out of free text once the department has a price list', async () => {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      description: 'MRI brain, plain',
    });

    // Decision (b): the centre does not do it, so there is no department to
    // send it to and no price to charge. An order would sit on a worklist
    // nobody can clear, behind a gate over money that will never arrive.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details?.code).toBe('TEST_NOT_OFFERED');
  });

  it('still takes free text where the department has priced nothing', async () => {
    const bare = await app.inject({
      method: 'POST',
      url: '/api/v1/departments',
      headers: { cookie: admin.cookie },
      payload: { name: 'Ultrasound', isDiagnostic: true },
    });
    expect(bare.statusCode).toBe(201);

    // Billing is opt-in per tenant everywhere else in this codebase, and this
    // is no place to make it compulsory: a clinic that has priced nothing must
    // keep ordering the way it always has.
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: bare.json<{ id: string }>().id,
      description: 'USG abdomen',
    });
    expect(res.statusCode).toBe(201);
  });

  it('records it on the visit, raising no order and no charge', async () => {
    const res = await setNote(doctor, 'MRI brain, plain — have done at the district hospital');
    expect(res.statusCode).toBe(200);

    const [row] = await ownerQuery<{ external_test_note: string | null }>(
      fx.main.id,
      `SELECT external_test_note FROM appointment WHERE id = $1`,
      [mainVisit],
    );
    expect(row?.external_test_note).toContain('MRI brain');

    // No order, so no worklist row and no gate.
    const worklist = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/orders',
      headers: { cookie: diagnosticsUser.cookie },
    });
    expect(worklist.json<{ orders: unknown[] }>().orders).toHaveLength(0);

    // And no charge.
    const bills = await ownerQuery(
      fx.main.id,
      `SELECT id FROM invoice WHERE visit_appointment_id = $1`,
      [mainVisit],
    );
    expect(bills).toHaveLength(0);
  });

  it('clears on a blank, because a doctor who deletes the line meant to', async () => {
    await setNote(doctor, 'MRI brain');
    const res = await setNote(doctor, null);

    expect(res.json<{ externalTestNote: string | null }>().externalTestNote).toBeNull();
  });

  it('reaches the finance desk without handing over the consultation', async () => {
    await setNote(doctor, 'MRI brain, plain — not done here');

    // Raise a test bill so finance has an invoice to open on this visit.
    await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });
    const [bill] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM invoice WHERE appointment_id IS NULL AND visit_appointment_id = $1`,
      [mainVisit],
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${bill!.id}`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(200);
    // Through `visitAppointment`: a test bill holds no `appointment_id` of its
    // own, so without that link the desk would see nothing on exactly the
    // bills where this note matters most.
    expect(
      res.json<{ visitAppointment: { externalTestNote: string } | null }>().visitAppointment
        ?.externalTestNote,
    ).toContain('MRI brain');
  });

  it('refuses a caller who may not order tests', async () => {
    expect((await setNote(diagnosticsUser, 'MRI brain')).statusCode).toBe(403);
  });

  it("never reaches another clinic's visit", async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/appointments/${otherVisit}/external-test-note`,
      headers: { cookie: doctor.cookie },
      payload: { note: 'MRI brain' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('a patient’s test history, inside the consultation', () => {
  /**
   * A completed test on an EARLIER visit for the same patient.
   *
   * Done by hand rather than through the API: a second walk-in for a patient
   * who already has one open is its own argument, and what this endpoint is
   * being asked about is a test from a visit that has already finished.
   */
  async function completedTestOnAnotherVisit(description: string): Promise<string> {
    const [past] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO appointment (tenant_id, patient_id, practitioner_id, location_id,
                                start_at, end_at, status, visit_type, updated_at)
       VALUES ($1, $2, $3, $4, now() - interval '30 days', now() - interval '30 days',
               'FULFILLED', 'NEW', now())
       RETURNING id`,
      [fx.main.id, fx.main.patientIds[0], fx.main.practitionerId, fx.main.locationId],
    );

    const [row] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO diagnostic_order (tenant_id, appointment_id, patient_id, department_id,
                                     ordered_by_user_id, description, status, result_note,
                                     completed_at, completed_by_user_id, legacy_unbilled, updated_at)
       SELECT $1, $2, $3, $4, u.id, $5, 'COMPLETED', 'No fracture seen.', now(), u.id, true, now()
         FROM app_user u WHERE u.email = 'doctor@main.test'
       RETURNING id`,
      [fx.main.id, past!.id, fx.main.patientIds[0], xrayDepartmentId, description],
    );
    return row!.id;
  }

  async function openConsultation(session: Session = doctor) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/encounters',
      headers: { cookie: session.cookie },
      payload: { appointmentId: mainVisit },
    });
    if (res.statusCode !== 201 && res.statusCode !== 200) {
      throw new Error(`Could not open the consultation: ${res.statusCode} ${res.payload}`);
    }
    return res.json<{ id: string }>().id;
  }

  async function history(session: Session, encounterId: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/encounters/${encounterId}/patient-test-history`,
      headers: { cookie: session.cookie },
    });
  }

  it('gives the doctor every earlier completed test, whatever visit it came from', async () => {
    await completedTestOnAnotherVisit('X-ray Knee — 30 days ago');
    const encounterId = await openConsultation();

    const res = await history(doctor, encounterId);

    expect(res.statusCode).toBe(200);
    const { orders } = res.json<{ orders: Array<{ description: string; resultNote: string }> }>();
    expect(orders.map((o) => o.description)).toContain('X-ray Knee — 30 days ago');
    expect(orders[0]?.resultNote).toBe('No fracture seen.');
  });

  it('reaches past the three-visit window the quick view stops at', async () => {
    // That earlier visit has no encounter at all, so `previousVisits` — which
    // takes the last three SIGNED encounters — cannot see it. This can.
    await completedTestOnAnotherVisit('CT head — long ago');
    const encounterId = await openConsultation();

    const { orders } = (await history(doctor, encounterId)).json<{
      orders: Array<{ description: string }>;
    }>();
    expect(orders.map((o) => o.description)).toContain('CT head — long ago');
  });

  it('leaves out this visit’s own tests, which are already on the screen', async () => {
    const mine = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });
    const orderId = mine.json<{ id: string }>().id;
    await ownerQuery(
      fx.main.id,
      `UPDATE diagnostic_order
          SET status = 'COMPLETED',
              completed_at = now(),
              completed_by_user_id = ordered_by_user_id
        WHERE id = $1`,
      [orderId],
    );

    const encounterId = await openConsultation();
    const { orders } = (await history(doctor, encounterId)).json<{
      orders: Array<{ id: string }>;
    }>();

    expect(orders.map((o) => o.id)).not.toContain(orderId);
  });

  it('shows a walk-in test, which a NOT filter would silently have dropped', async () => {
    const walkIn = await order(doctor, {
      patientId: fx.main.patientIds[0],
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
      referralSource: 'SELF',
    });
    const orderId = walkIn.json<{ id: string }>().id;
    await ownerQuery(
      fx.main.id,
      `UPDATE diagnostic_order
          SET status = 'COMPLETED', completed_at = now(),
              completed_by_user_id = ordered_by_user_id
        WHERE id = $1`,
      [orderId],
    );

    const encounterId = await openConsultation();
    const { orders } = (await history(doctor, encounterId)).json<{
      orders: Array<{ id: string }>;
    }>();

    /**
     * The whole point of decision 5: no new feature was needed to pull a
     * walk-in test into a later consultation, because this view is
     * patient-level. But the current-visit exclusion read
     * `appointmentId: { not: … }`, and in SQL `appointment_id <> $1` is NULL
     * for a row with no appointment — so the moment the column became
     * nullable, every walk-in test would have vanished from the one endpoint
     * built to surface it.
     */
    expect(orders.map((o) => o.id)).toContain(orderId);
  });

  it('leaves out a test that has not come back yet', async () => {
    await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });
    const encounterId = await openConsultation();

    // COMPLETED only. A pending test is not a result, and showing it as one is
    // how a doctor reads an absence as a normal finding.
    expect((await history(doctor, encounterId)).json<{ orders: unknown[] }>().orders).toHaveLength(
      0,
    );
  });

  it('refuses the administrator, who holds every permission in the clinic', async () => {
    await completedTestOnAnotherVisit('X-ray Knee');
    const encounterId = await openConsultation();

    // Decision (e): no standing access to a patient's record, and the person
    // holding every permission is exactly who that is about.
    expect((await history(admin, encounterId)).statusCode).toBe(403);
  });

  it('refuses the diagnostics room and the front desk', async () => {
    const encounterId = await openConsultation();

    expect((await history(diagnosticsUser, encounterId)).statusCode).toBe(403);
    expect((await history(frontDesk, encounterId)).statusCode).toBe(403);
  });

  it('closes overnight, so it never becomes standing access', async () => {
    await completedTestOnAnotherVisit('X-ray Knee');
    const encounterId = await openConsultation();
    expect((await history(doctor, encounterId)).statusCode).toBe(200);

    await ownerQuery(
      fx.main.id,
      `UPDATE appointment SET start_at = start_at - interval '2 days' WHERE id = $1`,
      [mainVisit],
    );

    const res = await history(doctor, encounterId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('another day');

    await ownerQuery(
      fx.main.id,
      `UPDATE appointment SET start_at = start_at + interval '2 days' WHERE id = $1`,
      [mainVisit],
    );
  });

  it('stays open after the consultation is signed, for the addendum', async () => {
    await completedTestOnAnotherVisit('X-ray Knee');
    const encounterId = await openConsultation();

    await ownerQuery(
      fx.main.id,
      `UPDATE encounter
          SET status = 'SIGNED',
              signed_at = now(),
              signed_by_user_id = (SELECT id FROM app_user WHERE email = 'doctor@main.test')
        WHERE id = $1`,
      [encounterId],
    );

    // A doctor writing an addendum an hour later is still on the same visit and
    // must not lose the history mid-sentence. The DAY is the bound, not signing.
    expect((await history(doctor, encounterId)).statusCode).toBe(200);
  });

  it("never reaches another clinic's consultation", async () => {
    const encounterId = await openConsultation();

    expect((await history(otherAdmin, encounterId)).statusCode).toBe(404);
  });
});

describe('a test nobody prescribed', () => {
  async function walkIn(session: Session, body: Record<string, unknown> = {}) {
    return order(session, {
      patientId: fx.main.patientIds[0],
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
      referralSource: 'SELF',
      ...body,
    });
  }

  it('raises an order with no consultation and no prescribing doctor', async () => {
    const res = await walkIn(doctor);

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      appointmentId: string | null;
      referralSource: string;
      patient: { id: string };
      orderedBy: { id: string };
    }>();

    expect(body.appointmentId).toBeNull();
    expect(body.referralSource).toBe('SELF');
    expect(body.patient.id).toBe(fx.main.patientIds[0]);
    // Still keyed in by somebody, and that is a different question from who
    // decided the test was needed.
    expect(body.orderedBy.id).toBeTruthy();
  });

  it('lands on the department worklist like any other order', async () => {
    await walkIn(doctor);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/diagnostics/orders?departmentId=${xrayDepartmentId}`,
      headers: { cookie: diagnosticsUser.cookie },
    });

    // The worklist never joined the appointment, so this needed no change at
    // all — the department does not have to care why an order exists.
    expect(res.json<{ orders: unknown[] }>().orders).toHaveLength(1);
  });

  it('is billed and gated exactly like a doctor-ordered test', async () => {
    const res = await walkIn(doctor);
    const orderId = res.json<{ id: string }>().id;
    expect(res.json<{ billing: { status: string } }>().billing.status).toBe('UNPAID');

    const blocked = await app.inject({
      method: 'PATCH',
      url: `/api/v1/diagnostics/orders/${orderId}/complete`,
      headers: { cookie: diagnosticsUser.cookie },
      payload: { resultNote: 'No fracture.' },
    });
    expect(blocked.statusCode).toBe(409);

    // The bill has no visit to hang off, which the invoice path already allowed.
    const [bill] = await ownerQuery<{ id: string; visit_appointment_id: string | null }>(
      fx.main.id,
      `SELECT i.id, i.visit_appointment_id
         FROM invoice i JOIN invoice_line l ON l.invoice_id = i.id
        WHERE l.service_id = $1 AND i.appointment_id IS NULL`,
      [kneeXrayId],
    );
    expect(bill?.visit_appointment_id).toBeNull();

    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${bill!.id}/payments`,
      headers: { cookie: frontDesk.cookie },
      payload: { mode: 'CASH', amountPaise: 45_000 },
    });

    const done = await app.inject({
      method: 'PATCH',
      url: `/api/v1/diagnostics/orders/${orderId}/complete`,
      headers: { cookie: diagnosticsUser.cookie },
      payload: { resultNote: 'No fracture.' },
    });
    expect(done.statusCode).toBe(200);
  });

  it('records the outside doctor who sent them, and refuses an unnamed one', async () => {
    const named = await walkIn(doctor, {
      referralSource: 'EXTERNAL_DOCTOR',
      referrerName: 'Dr S Kulkarni',
      referrerClinic: 'City Hospital',
      referrerPhone: '9876543210',
    });
    expect(named.statusCode).toBe(201);
    expect(named.json<{ referrerName: string }>().referrerName).toBe('Dr S Kulkarni');

    const unnamed = await order(doctor, {
      patientId: fx.main.patientIds[1],
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
      referralSource: 'EXTERNAL_DOCTOR',
    });
    expect(unnamed.statusCode).toBe(400);
    expect(unnamed.json().error.details?.code).toBe('REFERRER_REQUIRED');
  });

  it('refuses a walk-in attached to a consultation, and a visit order without one', async () => {
    const contradiction = await order(doctor, {
      appointmentId: mainVisit,
      patientId: fx.main.patientIds[0],
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
      referralSource: 'SELF',
    });
    expect(contradiction.statusCode).toBe(400);
    expect(contradiction.json().error.details?.code).toBe('WALK_IN_HAS_NO_VISIT');

    const noVisit = await order(doctor, {
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });
    expect(noVisit.statusCode).toBe(400);
    expect(noVisit.json().error.details?.code).toBe('VISIT_REQUIRED');
  });

  it("refuses a patient id that is not this clinic's", async () => {
    const res = await order(doctor, {
      patientId: fx.other.patientIds[0],
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
      referralSource: 'SELF',
    });

    // Looked up under the tenant policy, so another clinic's patient is simply
    // not there — the same answer as an id that never existed.
    expect(res.statusCode).toBe(404);
  });

  it('refuses the same walk-in test twice for one patient on one day', async () => {
    expect((await walkIn(doctor)).statusCode).toBe(201);

    const again = await walkIn(doctor);

    // No visit to scope the guard to, so it is scoped to the patient's day —
    // and this is the flow that most invites double entry.
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details?.code).toBe('TEST_ALREADY_ORDERED');
  });

  it('does not let a walk-in block the same test for another patient', async () => {
    expect((await walkIn(doctor)).statusCode).toBe(201);

    const other = await order(doctor, {
      patientId: fx.main.patientIds[1],
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
      referralSource: 'SELF',
    });
    expect(other.statusCode).toBe(201);
  });
});

describe('finance raises a walk-in', () => {
  let financeUser: Session;

  beforeAll(async () => {
    const staff = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie: admin.cookie },
      payload: {
        email: 'walkinfinance@main.test',
        fullName: 'Yogesh Finance',
        roleKeys: ['finance'],
      },
    });
    if (staff.statusCode !== 201) {
      throw new Error(`Could not create the finance user: ${staff.statusCode} ${staff.payload}`);
    }
    financeUser = await login(
      app,
      fx.main.slug,
      'walkinfinance@main.test',
      staff.json<{ temporaryPassword: string }>().temporaryPassword,
    );
  });

  async function raise(session: Session, body: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/diagnostics/walk-in-orders',
      headers: { cookie: session.cookie },
      payload: {
        patientId: fx.main.patientIds[0],
        serviceIds: [kneeXrayId, bloodCountId],
        referralSource: 'SELF',
        ...body,
      },
    });
  }

  it('puts several tests on ONE bill', async () => {
    const res = await raise(financeUser);

    expect(res.statusCode).toBe(201);
    const body = res.json<{ invoiceId: string; orders: Array<{ id: string }> }>();
    expect(body.orders).toHaveLength(2);

    const bills = await ownerQuery<{ id: string; total_paise: number }>(
      fx.main.id,
      `SELECT id, total_paise FROM invoice
        WHERE appointment_id IS NULL AND visit_appointment_id IS NULL`,
    );

    // The point of the batch. One invoice per test would hand the patient two
    // pieces of paper to pay separately, which FR-DIA-11 rules out.
    expect(bills).toHaveLength(1);
    expect(bills[0]?.id).toBe(body.invoiceId);
    expect(bills[0]?.total_paise).toBe(75_000);
  });

  it('sends each test to its own department', async () => {
    await raise(financeUser);

    const xray = await app.inject({
      method: 'GET',
      url: `/api/v1/diagnostics/orders?departmentId=${xrayDepartmentId}`,
      headers: { cookie: diagnosticsUser.cookie },
    });
    const path = await app.inject({
      method: 'GET',
      url: `/api/v1/diagnostics/orders?departmentId=${pathologyDepartmentId}`,
      headers: { cookie: diagnosticsUser.cookie },
    });

    expect(xray.json<{ orders: unknown[] }>().orders).toHaveLength(1);
    expect(path.json<{ orders: unknown[] }>().orders).toHaveLength(1);
  });

  it('records the referral on every test, because it describes the visit', async () => {
    const res = await raise(financeUser, {
      referralSource: 'EXTERNAL_DOCTOR',
      referrerName: 'Dr S Kulkarni',
      referrerClinic: 'City Hospital',
      referrerPhone: '9876543210',
    });

    const orders = res.json<{ orders: Array<{ referralSource: string; referrerName: string }> }>()
      .orders;
    expect(orders).toHaveLength(2);
    for (const o of orders) {
      expect(o.referralSource).toBe('EXTERNAL_DOCTOR');
      expect(o.referrerName).toBe('Dr S Kulkarni');
    }
  });

  it('writes nothing at all when one test in the list is bad', async () => {
    const res = await raise(financeUser, {
      serviceIds: [kneeXrayId, fx.main.patientIds[0]],
    });
    expect(res.statusCode).toBe(404);

    /**
     * One transaction for the lot. A half-applied batch is the worst outcome
     * available: money raised for a test no department was told about, or a
     * department told about a test nobody was charged for.
     */
    const bills = await ownerQuery(
      fx.main.id,
      `SELECT id FROM invoice WHERE appointment_id IS NULL AND visit_appointment_id IS NULL`,
    );
    const orders = await ownerQuery(
      fx.main.id,
      `SELECT id FROM diagnostic_order WHERE appointment_id IS NULL`,
    );
    expect(bills).toHaveLength(0);
    expect(orders).toHaveLength(0);
  });

  it('refuses the same test twice in one list, and again later the same day', async () => {
    const twice = await raise(financeUser, { serviceIds: [kneeXrayId, kneeXrayId] });
    expect(twice.statusCode).toBe(400);
    expect(twice.json().error.details?.code).toBe('TEST_REPEATED');

    expect((await raise(financeUser, { serviceIds: [kneeXrayId] })).statusCode).toBe(201);

    const again = await raise(financeUser, { serviceIds: [kneeXrayId] });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details?.code).toBe('TEST_ALREADY_ORDERED');
  });

  it('refuses an outside referral with no doctor named', async () => {
    const res = await raise(financeUser, { referralSource: 'EXTERNAL_DOCTOR' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details?.code).toBe('REFERRER_REQUIRED');
  });

  it('refuses the front desk, which gained no new power here', async () => {
    expect((await raise(frontDesk)).statusCode).toBe(403);
  });

  it('refuses the doctor and the diagnostics room too', async () => {
    expect((await raise(doctor)).statusCode).toBe(403);
    expect((await raise(diagnosticsUser)).statusCode).toBe(403);
  });

  it('gates the result on payment, with no new code for it', async () => {
    const res = await raise(financeUser, { serviceIds: [kneeXrayId] });
    const orderId = res.json<{ orders: Array<{ id: string }> }>().orders[0]!.id;
    const invoiceId = res.json<{ invoiceId: string }>().invoiceId;

    const blocked = await app.inject({
      method: 'PATCH',
      url: `/api/v1/diagnostics/orders/${orderId}/complete`,
      headers: { cookie: diagnosticsUser.cookie },
      payload: { resultNote: 'No fracture.' },
    });
    expect(blocked.statusCode).toBe(409);

    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/payments`,
      headers: { cookie: financeUser.cookie },
      payload: { mode: 'CASH', amountPaise: 45_000 },
    });

    const done = await app.inject({
      method: 'PATCH',
      url: `/api/v1/diagnostics/orders/${orderId}/complete`,
      headers: { cookie: diagnosticsUser.cookie },
      payload: { resultNote: 'No fracture.' },
    });
    expect(done.statusCode).toBe(200);
  });

  it('shows the bill under what the patient already owes', async () => {
    await raise(financeUser, { serviceIds: [kneeXrayId] });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/invoices',
      headers: { cookie: financeUser.cookie },
    });

    // Decision 9: `outstanding()` filters on status alone and never looked at
    // the appointment, so a walk-in bill was already reachable. Pinned here so
    // a future filter cannot quietly hide it.
    const mine = res
      .json<{ invoices: Array<{ patient: { id: string }; balancePaise: number }> }>()
      .invoices.filter((i) => i.patient.id === fx.main.patientIds[0]);
    expect(mine.some((i) => i.balancePaise === 45_000)).toBe(true);
  });
});

describe('handing the report over', () => {
  /** A completed test, ready to be collected. */
  async function reported(): Promise<string> {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: plainDepartmentId,
      description: 'USG abdomen',
    });
    const orderId = res.json<{ id: string }>().id;

    const done = await app.inject({
      method: 'PATCH',
      url: `/api/v1/diagnostics/orders/${orderId}/complete`,
      headers: { cookie: diagnosticsUser.cookie },
      payload: { resultNote: 'Normal study.' },
    });
    expect(done.statusCode).toBe(200);
    return orderId;
  }

  async function handOver(session: Session, orderId: string, handedOverTo = 'The patient') {
    return app.inject({
      method: 'POST',
      url: `/api/v1/diagnostics/orders/${orderId}/handover`,
      headers: { cookie: session.cookie },
      payload: { handedOverTo },
    });
  }

  it('records who took it and when', async () => {
    const orderId = await reported();

    const res = await handOver(diagnosticsUser, orderId, 'Sunita Sharma (daughter)');

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      handedOverAt: string;
      handedOverTo: string;
      handedOverBy: { fullName: string };
    }>();
    expect(body.handedOverAt).toBeTruthy();
    expect(body.handedOverTo).toBe('Sunita Sharma (daughter)');
    // The staff member is answerable for it — that is the point of recording.
    expect(body.handedOverBy.fullName).toBeTruthy();
  });

  it('refuses before the result exists', async () => {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: plainDepartmentId,
      description: 'USG abdomen',
    });

    const early = await handOver(diagnosticsUser, res.json<{ id: string }>().id);

    expect(early.statusCode).toBe(400);
    expect(early.json().error.details?.code).toBe('RESULT_NOT_READY');
  });

  it('refuses a second time, rather than overwriting who took it', async () => {
    const orderId = await reported();
    expect((await handOver(diagnosticsUser, orderId, 'The patient')).statusCode).toBe(201);

    const again = await handOver(diagnosticsUser, orderId, 'Somebody else');

    /**
     * This is an event that happened, not a flag. Letting it be written twice
     * would overwrite the name recorded the first time — which is precisely
     * the fact a later complaint disputes.
     */
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details?.code).toBe('ALREADY_HANDED_OVER');

    const [row] = await ownerQuery<{ handed_over_to: string }>(
      fx.main.id,
      `SELECT handed_over_to FROM diagnostic_order WHERE id = $1`,
      [orderId],
    );
    expect(row?.handed_over_to).toBe('The patient');
  });

  it('refuses with nobody named', async () => {
    const orderId = await reported();

    const res = await handOver(diagnosticsUser, orderId, '  ');

    // Validation catches the blank before the service does; either refusal is
    // the right answer, and the column's CHECK is the last line behind both.
    expect([400, 422]).toContain(res.statusCode);
  });

  it('refuses a caller who does not report results', async () => {
    const orderId = await reported();

    expect((await handOver(doctor, orderId)).statusCode).toBe(403);
    expect((await handOver(frontDesk, orderId)).statusCode).toBe(403);
  });

  it('shows on the worklist which reports are still uncollected', async () => {
    const collected = await reported();
    const waiting = await reported();
    await handOver(diagnosticsUser, collected);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/orders?status=COMPLETED',
      headers: { cookie: diagnosticsUser.cookie },
    });

    const rows = res.json<{ orders: Array<{ id: string; handedOverAt: string | null }> }>().orders;
    expect(rows.find((o) => o.id === collected)?.handedOverAt).toBeTruthy();
    expect(rows.find((o) => o.id === waiting)?.handedOverAt).toBeNull();
  });
});

describe('the worklist', () => {
  it('shows pending orders oldest first, with enough to identify the patient', async () => {
    const appointmentId = mainVisit;
    await order(doctor, { appointmentId, departmentId: plainDepartmentId, description: 'First' });
    await order(doctor, { appointmentId, departmentId: plainDepartmentId, description: 'Second' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/diagnostics/orders?departmentId=${plainDepartmentId}`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(200);
    const { orders } = res.json<{
      orders: Array<{ description: string; patient: { name: string; uhid: string } }>;
    }>();

    expect(orders.map((o) => o.description)).toEqual(['First', 'Second']);
    // A technician has to match the request to the person in front of them.
    expect(orders[0]?.patient.name).toBeTruthy();
    expect(orders[0]?.patient.uhid).toBeTruthy();
  });

  it("never shows one clinic another's orders", async () => {
    await order(doctor, {
      appointmentId: mainVisit,
      departmentId: plainDepartmentId,
      description: 'Main clinic order',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/orders',
      headers: { cookie: otherAdmin.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ orders: unknown[] }>().orders).toHaveLength(0);
  });

  it('lists what was ordered on one visit', async () => {
    const appointmentId = mainVisit;
    await order(doctor, { appointmentId, departmentId: plainDepartmentId, description: 'Knee' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/appointments/${appointmentId}/diagnostic-orders`,
      headers: { cookie: doctor.cookie },
    });

    expect(res.json<{ orders: Array<{ description: string }> }>().orders).toHaveLength(1);
  });
});

describe('cancelling', () => {
  it('marks it cancelled rather than deleting it', async () => {
    const created = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: plainDepartmentId,
      description: 'Ordered by mistake',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/diagnostics/orders/${created.json<{ id: string }>().id}/cancel`,
      headers: { cookie: doctor.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('CANCELLED');

    // The row survives. "Why was this patient sent for an X-ray" keeps its answer.
    const rows = await ownerQuery(fx.main.id, 'SELECT id FROM diagnostic_order');
    expect(rows).toHaveLength(1);
  });

  it('drops off the pending worklist once cancelled', async () => {
    const created = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: plainDepartmentId,
      description: 'Ordered by mistake',
    });

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/diagnostics/orders/${created.json<{ id: string }>().id}/cancel`,
      headers: { cookie: doctor.cookie },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/orders',
      headers: { cookie: doctor.cookie },
    });

    expect(res.json<{ orders: unknown[] }>().orders).toHaveLength(0);
  });
});

/**
 * The separation of duties, asserted directly. If `diagnostics` ever gains
 * `diagnostic:order`, a technician could raise and then fulfil their own work,
 * and nothing else in the suite would notice.
 */
describe('the diagnostics role', () => {
  it('exists in the clinic with the right powers, and cannot order its own work', async () => {
    const [row] = await ownerQuery<{ permissions: string[] }>(
      fx.main.id,
      `SELECT permissions FROM role WHERE key = 'diagnostics'`,
    );

    expect(row?.permissions).toContain('diagnostic:result');
    expect(row?.permissions).toContain('document:write');
    expect(row?.permissions).not.toContain('diagnostic:order');
  });
});

/**
 * Attaching the result — the piece the clinic actually asked for.
 *
 * Driven as the radiographer throughout, because the point of the `diagnostics`
 * role is what it can and cannot reach.
 */
describe('attaching a result', () => {
  async function pendingOrder(): Promise<string> {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: plainDepartmentId,
      description: 'X-ray left knee',
    });
    return res.json<{ id: string }>().id;
  }

  it('lets diagnostic staff attach a file against an order', async () => {
    const res = await attach(diagnosticsUser, await pendingOrder());

    expect(res.statusCode).toBe(201);
    expect(res.json<{ contentType: string }>().contentType).toBe('application/pdf');
  });

  /**
   * The patient is taken from the ORDER. There is no patient field on this
   * request, so a technician cannot file one person's film against another's.
   */
  it('files it against the order patient', async () => {
    const id = await pendingOrder();
    await attach(diagnosticsUser, id);

    const [document] = await ownerQuery<{ patient_id: string; diagnostic_order_id: string }>(
      fx.main.id,
      'SELECT patient_id, diagnostic_order_id FROM clinical_document ORDER BY created_at DESC LIMIT 1',
    );
    const [ordered] = await ownerQuery<{ patient_id: string }>(
      fx.main.id,
      'SELECT patient_id FROM diagnostic_order WHERE id = $1',
      [id],
    );

    expect(document?.diagnostic_order_id).toBe(id);
    expect(document?.patient_id).toBe(ordered?.patient_id);
  });

  it('does not complete the order on its own — a study is several images', async () => {
    const id = await pendingOrder();
    await attach(diagnosticsUser, id);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/diagnostics/orders/${id}`,
      headers: { cookie: diagnosticsUser.cookie },
    });

    expect(res.json<{ status: string }>().status).toBe('PENDING');
    expect(res.json<{ documents: unknown[] }>().documents).toHaveLength(1);
  });

  it('refuses the doctor, who orders but does not result', async () => {
    const res = await attach(doctor, await pendingOrder());
    expect(res.statusCode).toBe(403);
  });

  it('refuses attaching to a cancelled order', async () => {
    const id = await pendingOrder();
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/diagnostics/orders/${id}/cancel`,
      headers: { cookie: doctor.cookie },
    });

    const res = await attach(diagnosticsUser, id);

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details?.code).toBe('ORDER_CANCELLED');
  });
});

describe('opening an uploaded report', () => {
  it('serves the bytes when the clinic runs without a bucket', async () => {
    const raised = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: plainDepartmentId,
      description: 'USG abdomen',
    });
    const orderId = raised.json<{ id: string }>().id;
    const attached = await attach(diagnosticsUser, orderId, 'usg.pdf');
    expect(attached.statusCode).toBe(201);
    const documentId = attached.json<{ id: string }>().id;

    const url = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/url`,
      headers: { cookie: doctor.cookie },
    });
    expect(url.statusCode).toBe(200);

    /**
     * The in-memory store used to answer `memory://…`, which a browser cannot
     * follow — a doctor clicking an uploaded report got a blank tab. It now
     * points at this API's own route, which is the only honest thing a store
     * with no bucket can hand back.
     */
    const href = url.json<{ url: string }>().url;
    expect(href).toBe(`/documents/${documentId}/raw`);

    const raw = await app.inject({
      method: 'GET',
      url: `/api/v1${href}`,
      headers: { cookie: doctor.cookie },
    });

    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-type']).toContain('application/pdf');
    expect(raw.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it("never serves another clinic's file", async () => {
    const raised = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: plainDepartmentId,
      description: 'USG abdomen',
    });
    const attached = await attach(diagnosticsUser, raised.json<{ id: string }>().id, 'usg.pdf');
    const documentId = attached.json<{ id: string }>().id;

    const raw = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/raw`,
      headers: { cookie: otherAdmin.cookie },
    });

    expect(raw.statusCode).toBe(404);
  });
});

describe('completing an order', () => {
  async function pendingOrder(): Promise<string> {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: plainDepartmentId,
      description: 'X-ray left knee',
    });
    return res.json<{ id: string }>().id;
  }

  function complete(session: Session, id: string, body: Record<string, unknown> = {}) {
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/diagnostics/orders/${id}/complete`,
      headers: { cookie: session.cookie },
      payload: body,
    });
  }

  it('records who finished it and when', async () => {
    const id = await pendingOrder();
    await attach(diagnosticsUser, id);

    const res = await complete(diagnosticsUser, id, { resultNote: 'No fracture. Mild effusion.' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      status: string;
      resultNote: string;
      completedAt: string;
      completedBy: { fullName: string };
    }>();

    expect(body.status).toBe('COMPLETED');
    expect(body.resultNote).toBe('No fracture. Mild effusion.');
    expect(body.completedAt).toBeTruthy();
    expect(body.completedBy.fullName).toBe('Meera Radiographer');
  });

  /**
   * A completed order carrying nothing tells the doctor the test happened and
   * nothing about what it found — worse than a pending one, which is at least
   * visibly unfinished.
   */
  it('refuses to complete with neither a file nor a report', async () => {
    const res = await complete(diagnosticsUser, await pendingOrder());

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details?.code).toBe('RESULT_IS_EMPTY');
  });

  it('accepts a report with no file — not every result is an image', async () => {
    const res = await complete(diagnosticsUser, await pendingOrder(), {
      resultNote: 'Hb 11.2, WBC normal.',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('COMPLETED');
  });

  it('refuses to complete twice, rather than restamping who did it', async () => {
    const id = await pendingOrder();
    await complete(diagnosticsUser, id, { resultNote: 'Done' });

    const again = await complete(diagnosticsUser, id, { resultNote: 'Done again' });

    expect(again.statusCode).toBe(400);
    expect(again.json().error.details?.code).toBe('ORDER_NOT_PENDING');
  });

  it('drops off the pending worklist and appears under completed', async () => {
    const id = await pendingOrder();
    await complete(diagnosticsUser, id, { resultNote: 'Done' });

    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/orders',
      headers: { cookie: diagnosticsUser.cookie },
    });
    expect(pending.json<{ orders: unknown[] }>().orders).toHaveLength(0);

    const done = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/orders?status=COMPLETED',
      headers: { cookie: diagnosticsUser.cookie },
    });
    expect(done.json<{ orders: unknown[] }>().orders).toHaveLength(1);
  });

  /** The round trip: the doctor reads what they asked for, and opens the film. */
  it('lets the doctor read the result they asked for', async () => {
    const id = await pendingOrder();
    await attach(diagnosticsUser, id);
    await complete(diagnosticsUser, id, { resultNote: 'No fracture.' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/diagnostics/orders/${id}`,
      headers: { cookie: doctor.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ resultNote: string }>().resultNote).toBe('No fracture.');

    const documentId = res.json<{ documents: Array<{ id: string }> }>().documents[0]!.id;
    const url = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/url`,
      headers: { cookie: doctor.cookie },
    });
    expect(url.statusCode).toBe(200);
  });
});

// --- a test ordered while its bill is being discounted ---------------------------

/**
 * The doctor orders a second test at the moment the desk discounts the visit's
 * open test bill. A discounted bill takes no more lines — the discount was
 * spread over what was on it, and the discount report reads that figure — so
 * the new test must go on a NEW bill. Forced with a trigger that holds the
 * discount mid-write while the order is placed.
 */
describe('a test ordered while its bill is being discounted', () => {
  it('goes on a new bill, never onto the one being discounted', async () => {
    const [visit] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO appointment (tenant_id, patient_id, practitioner_id, location_id,
                                start_at, end_at, status, visit_type, updated_at)
       VALUES ($1, $2, $3, $4, now(), now() + interval '15 minutes', 'IN_PROGRESS', 'NEW', now())
       RETURNING id`,
      [fx.main.id, fx.main.patientIds[2], fx.main.practitionerId, fx.main.locationId],
    );

    const first = await order(doctor, {
      appointmentId: visit!.id,
      departmentId: xrayDepartmentId,
      serviceId: kneeXrayId,
    });
    expect(first.statusCode).toBe(201);
    const [bill] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT invoice_id AS id FROM invoice_line WHERE id =
         (SELECT invoice_line_id FROM diagnostic_order WHERE id = $1)`,
      [first.json<{ id: string }>().id],
    );

    const promo = await app.inject({
      method: 'POST',
      url: '/api/v1/promotions',
      headers: { cookie: admin.cookie },
      payload: {
        code: 'RACE50',
        name: 'Race test',
        type: 'PERCENTAGE',
        value: 50,
        validFrom: '2020-01-01',
      },
    });
    expect(promo.statusCode).toBe(201);

    await ownerQuery(
      fx.main.id,
      `CREATE FUNCTION test_slow_promotion() RETURNS trigger LANGUAGE plpgsql AS $fn$
       BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $fn$`,
    );
    await ownerQuery(
      fx.main.id,
      `CREATE TRIGGER test_slow_promotion BEFORE INSERT ON promotion_application
         FOR EACH ROW EXECUTE FUNCTION test_slow_promotion()`,
    );

    try {
      const discounting = app.inject({
        method: 'POST',
        url: `/api/v1/invoices/${bill!.id}/promotion`,
        headers: { cookie: admin.cookie },
        payload: { code: 'RACE50', authorisedByUserId: adminUserId },
      });
      await new Promise((r) => setTimeout(r, 400));
      const ordering = order(doctor, {
        appointmentId: visit!.id,
        departmentId: pathologyDepartmentId,
        serviceId: bloodCountId,
      });
      const [discounted, ordered] = await Promise.all([discounting, ordering]);

      expect(discounted.statusCode).toBe(201);
      expect(ordered.statusCode, ordered.payload).toBe(201);

      const lines = await ownerQuery<{ invoice_id: string }>(
        fx.main.id,
        `SELECT l.invoice_id FROM diagnostic_order o JOIN invoice_line l ON l.id = o.invoice_line_id
          WHERE o.appointment_id = $1 ORDER BY o.created_at`,
        [visit!.id],
      );
      expect(lines).toHaveLength(2);
      expect(lines[0]!.invoice_id).toBe(bill!.id);
      expect(lines[1]!.invoice_id).not.toBe(bill!.id);
    } finally {
      await ownerQuery(
        fx.main.id,
        `DROP TRIGGER IF EXISTS test_slow_promotion ON promotion_application`,
      );
      await ownerQuery(fx.main.id, `DROP FUNCTION IF EXISTS test_slow_promotion()`);
    }
  });
});
