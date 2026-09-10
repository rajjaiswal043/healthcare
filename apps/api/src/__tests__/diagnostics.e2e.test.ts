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
      departmentId: xrayDepartmentId,
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
    expect(body.department.name).toBe('X-ray');

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
      departmentId: xrayDepartmentId,
      description: 'X-ray left knee',
    });

    expect(res.statusCode).toBe(404);
  });

  it('refuses a caller without diagnostic:order', async () => {
    const res = await order(frontDesk, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
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
      departmentId: xrayDepartmentId,
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

describe('the worklist', () => {
  it('shows pending orders oldest first, with enough to identify the patient', async () => {
    const appointmentId = mainVisit;
    await order(doctor, { appointmentId, departmentId: xrayDepartmentId, description: 'First' });
    await order(doctor, { appointmentId, departmentId: xrayDepartmentId, description: 'Second' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/diagnostics/orders?departmentId=${xrayDepartmentId}`,
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
      departmentId: xrayDepartmentId,
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
    await order(doctor, { appointmentId, departmentId: xrayDepartmentId, description: 'Knee' });

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
      departmentId: xrayDepartmentId,
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
      departmentId: xrayDepartmentId,
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
      departmentId: xrayDepartmentId,
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

describe('completing an order', () => {
  async function pendingOrder(): Promise<string> {
    const res = await order(doctor, {
      appointmentId: mainVisit,
      departmentId: xrayDepartmentId,
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
