/**
 * The price list — FR-PRC-01, -02, -03.
 *
 * Two properties carry this file.
 *
 * **A switched-off service stays off.** `upsertService` used to force
 * `isActive: true` in its update branch, so correcting the price of a withdrawn
 * service quietly put it back on the finance desk's dropdown — the clinic would
 * start being offered something it had stopped doing, with nothing on any screen
 * to explain how. That is the regression this file exists to prevent, and it is
 * the reason `edits a price without reviving a switched-off service` is written
 * as three separate assertions rather than one.
 *
 * **The administrator's list and the biller's list are different lists.** One
 * answers "what does this clinic charge for" and must show withdrawn services;
 * the other answers "what may I put on a bill" and must not. Serving both from
 * one endpoint means one of those two answers is wrong.
 *
 * Money is integer paise. `50000` is ₹500.00.
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
let admin: Session;
let finance: Session;
let frontDesk: Session;
let otherAdmin: Session;

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();

  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  finance = await login(app, fx.main.slug, 'finance@main.test');
  admin = await loginWithMfa(app, fx.main.slug, 'admin@main.test');
  otherAdmin = await loginWithMfa(app, fx.other.slug, 'admin@other.test');
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  await ownerQuery(fx.main.id, `DELETE FROM service`);
  await ownerQuery(fx.other.id, `DELETE FROM service`);
});

// --- helpers ----------------------------------------------------------------

function upsert(body: Record<string, unknown>, session: Session = admin) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/setup/services',
    headers: { cookie: session.cookie },
    payload: body,
  });
}

function deleteService(id: string, session: Session = admin) {
  return app.inject({
    method: 'DELETE',
    url: `/api/v1/setup/services/${id}`,
    headers: { cookie: session.cookie },
  });
}

function priceList(session: Session = admin) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/setup/services',
    headers: { cookie: session.cookie },
  });
}

function setActive(id: string, isActive: boolean, session: Session = admin) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/setup/services/${id}/active`,
    headers: { cookie: session.cookie },
    payload: { isActive },
  });
}

/** The biller's list — active only, behind invoice:read. */
function billableServices(session: Session = finance) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/services',
    headers: { cookie: session.cookie },
  });
}

async function seedService(overrides: Record<string, unknown> = {}) {
  const res = await upsert({
    code: 'XRAY-KNEE',
    name: 'X-ray, knee',
    category: 'DIAGNOSTIC',
    pricePaise: 50000,
    ...overrides,
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string; code: string }>();
}

function addTest(departmentId: string, body: Record<string, unknown>, session: Session = admin) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/departments/${departmentId}/tests`,
    headers: { cookie: session.cookie },
    payload: body,
  });
}

// --- tests belong to the room that does them --------------------------------

/**
 * Pricing a test on the department that performs it.
 *
 * A test is only orderable if its service names a department. Asking for that
 * on the price list meant choosing a category and a department correctly, and
 * getting the second one wrong produced a test that could be billed and never
 * ordered — which is what this endpoint removes: the room is the thing being
 * acted on, so it cannot be got wrong.
 */
describe('a test priced on its department', () => {
  it('lands in that department as a diagnostic, with a code nobody had to invent', async () => {
    const res = await addTest(fx.main.departmentId, { name: 'X-ray, knee', pricePaise: 50000 });

    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; code: string; name: string }>();
    /* Derived from the room and the test, because reports group by it and it
       never changes. */
    expect(created.code).toMatch(/^[A-Z0-9-]+$/);
    expect(created.code).toContain('KNEE');

    const [row] = await ownerQuery<{ category: string; department_id: string }>(
      fx.main.id,
      `SELECT category, department_id FROM service WHERE id = $1`,
      [created.id],
    );
    expect(row?.category).toBe('DIAGNOSTIC');
    expect(row?.department_id).toBe(fx.main.departmentId);
  });

  it('refuses a second test with the same name in the same room', async () => {
    expect(
      (await addTest(fx.main.departmentId, { name: 'ECG', pricePaise: 30000 })).statusCode,
    ).toBe(201);

    // Two identical lines is a slip, not a catalogue: whoever orders it would
    // be choosing between them at random.
    const again = await addTest(fx.main.departmentId, { name: 'ecg', pricePaise: 40000 });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details?.code).toBe('TEST_EXISTS');
  });

  it('generates a distinct code when the name repeats in another room', async () => {
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/departments',
      headers: { cookie: admin.cookie },
      payload: { name: 'Ultrasound' },
    });
    expect(other.statusCode).toBe(201);

    const first = await addTest(fx.main.departmentId, { name: 'Knee', pricePaise: 50000 });
    const second = await addTest(other.json<{ id: string }>().id, {
      name: 'Knee',
      pricePaise: 90000,
    });

    expect(second.statusCode).toBe(201);
    /* The codes must differ or the second would UPSERT over the first —
       `upsertService` keys on the code, so a collision overwrites a price. */
    expect(second.json<{ code: string }>().code).not.toBe(first.json<{ code: string }>().code);
  });

  it('refuses a retired room', async () => {
    await ownerQuery(fx.main.id, `UPDATE department SET is_active = false WHERE id = $1`, [
      fx.main.departmentId,
    ]);

    try {
      const res = await addTest(fx.main.departmentId, { name: 'X-ray, wrist', pricePaise: 50000 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details?.code).toBe('DEPARTMENT_INACTIVE');
    } finally {
      await ownerQuery(fx.main.id, `UPDATE department SET is_active = true WHERE id = $1`, [
        fx.main.departmentId,
      ]);
    }
  });

  it('is refused to the finance desk, which may bill a test but not price one', async () => {
    expect(
      (await addTest(fx.main.departmentId, { name: 'MRI', pricePaise: 50000 }, finance)).statusCode,
    ).toBe(403);
  });

  it("cannot reach another clinic's room", async () => {
    const res = await addTest(fx.other.departmentId, { name: 'X-ray, hip', pricePaise: 50000 });
    // Not found rather than forbidden: read through the tenant client, another
    // clinic's department simply does not exist.
    expect(res.statusCode).toBe(404);
  });
});

/**
 * A test in no room at all.
 *
 * These can be billed and never ordered, and now that tests are managed on the
 * department rather than on the price list they would have no screen at all.
 * The department listing hands them back so the one screen that owns tests can
 * offer them a room.
 */
describe('tests that belong to no department', () => {
  it('come back with the department listing', async () => {
    const orphan = await seedService({ code: 'DIAG-ECG', name: 'ECG' });
    await seedService({
      code: 'XR-CHEST',
      name: 'X-ray, chest',
      departmentId: fx.main.departmentId,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/setup/departments',
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ unassignedTests: Array<{ id: string }> }>();
    expect(body.unassignedTests.map((t) => t.id)).toEqual([orphan.id]);
  });
});

// --- deleting one -----------------------------------------------------------

/**
 * Delete is for a mistake, not for retirement.
 *
 * THIS NARROWS FR-PRC-03 RATHER THAN BREAKING IT. The requirement says a
 * service is withdrawn and never removed, and the reason it gives is that
 * reporting groups by service — a deleted one makes last month's figures
 * unexplainable. That reason binds exactly the services that APPEAR in last
 * month's figures. There used to be no delete endpoint at all, and a test here
 * asserting its absence; what replaced it is the rule with its own reason
 * applied, which is why the refusal below is the first thing tested.
 *
 * The refusal is the whole point of these. `invoice_line.service_id` and
 * `diagnostic_order.service_id` are ON DELETE SET NULL, so the database would
 * ACCEPT a delete of a service that has been billed — it would quietly null
 * the link on every past line and leave the figures unexplainable, with nothing
 * on any screen to say it happened. A test that nothing has used is a different
 * case entirely, and forcing an administrator to keep scrolling past a typo
 * forever is not a safety property.
 */
describe('deleting a service', () => {
  it('removes one nothing has used', async () => {
    const service = await seedService();

    const res = await deleteService(service.id);
    expect(res.statusCode).toBe(200);

    const [row] = await ownerQuery<{ n: number }>(
      fx.main.id,
      `SELECT count(*)::int AS n FROM service WHERE id = $1`,
      [service.id],
    );
    expect(row?.n).toBe(0);
  });

  it('refuses one that has been billed, and says to switch it off', async () => {
    const service = await seedService();

    /* A line written the way billing writes one: the name and price copied as
       charged, with the service id alongside for reporting. That id is the
       thing a delete would cut loose. */
    const invoice = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO invoice (tenant_id, patient_id, number, status, subtotal_paise,
                            discount_paise, tax_paise, total_paise, updated_at)
       VALUES ($1, $2, 'INV-DEL-1', 'UNPAID', 50000, 0, 0, 50000, now())
       RETURNING id`,
      [fx.main.id, fx.main.patientIds[0]],
    );
    await ownerQuery(
      fx.main.id,
      `INSERT INTO invoice_line (tenant_id, invoice_id, service_id, description,
                                 quantity, unit_price_paise, total_paise)
       VALUES ($1, $2, $3, 'X-ray, knee', 1, 50000, 50000)`,
      [fx.main.id, invoice[0]?.id, service.id],
    );

    const res = await deleteService(service.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details?.code).toBe('SERVICE_IN_USE');
    expect(res.json().error.message).toContain('Switch it off instead');

    // And it is still there, which is the only assertion that matters.
    const [row] = await ownerQuery<{ n: number }>(
      fx.main.id,
      `SELECT count(*)::int AS n FROM service WHERE id = $1`,
      [service.id],
    );
    expect(row?.n).toBe(1);
  });

  it('is refused to the finance desk', async () => {
    const service = await seedService();
    expect((await deleteService(service.id, finance)).statusCode).toBe(403);
  });

  it("cannot reach another clinic's service", async () => {
    const service = await seedService();
    expect((await deleteService(service.id, otherAdmin)).statusCode).toBe(404);
  });
});

// --- the bug ----------------------------------------------------------------

describe('a switched-off service stays off', () => {
  it('edits a price without reviving it', async () => {
    const service = await seedService();

    expect((await setActive(service.id, false)).statusCode).toBe(200);

    // The edit that used to undo the switch: same code, new price, nothing said
    // about isActive.
    const edited = await upsert({
      code: 'XRAY-KNEE',
      name: 'X-ray, knee',
      category: 'DIAGNOSTIC',
      pricePaise: 60000,
    });

    expect(edited.statusCode).toBe(201);
    // The price changed…
    expect(edited.json().pricePaise).toBe(60000);
    // …and the switch did not.
    expect(edited.json().isActive).toBe(false);

    // And it is still absent from what the desk may charge for, which is the
    // consequence that actually mattered.
    const billable = (await billableServices()).json<{ services: Array<{ code: string }> }>();
    expect(billable.services.map((s) => s.code)).not.toContain('XRAY-KNEE');
  });

  it('can still be switched back on deliberately', async () => {
    const service = await seedService();
    await setActive(service.id, false);

    const revived = await setActive(service.id, true);
    expect(revived.json().isActive).toBe(true);

    const billable = (await billableServices()).json<{ services: Array<{ code: string }> }>();
    expect(billable.services.map((s) => s.code)).toContain('XRAY-KNEE');
  });

  it('honours isActive when the caller states it', async () => {
    // Absent means "leave it alone"; present means what it says.
    const service = await seedService();
    await setActive(service.id, false);

    const edited = await upsert({
      code: 'XRAY-KNEE',
      name: 'X-ray, knee',
      category: 'DIAGNOSTIC',
      pricePaise: 50000,
      isActive: true,
    });

    expect(edited.json().isActive).toBe(true);
  });
});

// --- the list ---------------------------------------------------------------

describe('the administrator price list', () => {
  it('shows switched-off services, which the billable list hides', async () => {
    const off = await seedService({ code: 'OLD-PROC', name: 'Withdrawn procedure' });
    await seedService({ code: 'XRAY-KNEE', name: 'X-ray, knee' });
    await setActive(off.id, false);

    const admins = (await priceList()).json<{ services: Array<{ code: string }> }>();
    const billers = (await billableServices()).json<{ services: Array<{ code: string }> }>();

    // The whole point of two endpoints: the administrator must see the
    // withdrawn one to bring it back; the desk must never be offered it.
    expect(admins.services.map((s) => s.code).sort()).toEqual(['OLD-PROC', 'XRAY-KNEE']);
    expect(billers.services.map((s) => s.code)).toEqual(['XRAY-KNEE']);
  });

  it('returns everything the screen needs', async () => {
    await seedService({ taxRateBasisPoints: 500 });

    const row = (await priceList()).json<{
      services: Array<Record<string, unknown>>;
    }>().services[0]!;

    expect(row.code).toBe('XRAY-KNEE');
    expect(row.category).toBe('DIAGNOSTIC');
    expect(row.pricePaise).toBe(50000);
    expect(row.taxRateBasisPoints).toBe(500);
    expect(row.isActive).toBe(true);
    expect(row).toHaveProperty('department');
  });

  it('carries the departments a service can be attached to', async () => {
    const body = (await priceList()).json<{ departments: Array<{ name: string }> }>();
    // Saves the screen a second round trip to fill one dropdown.
    expect(body.departments.map((d) => d.name)).toContain('Imaging');
  });

  it('is gated on tenant:configure, not invoice:read', async () => {
    // Finance reads prices all day through /services and still must not reach
    // the screen that sets them.
    expect((await priceList(finance)).statusCode).toBe(403);
    expect((await priceList(frontDesk)).statusCode).toBe(403);
    expect((await billableServices()).statusCode).toBe(200);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/setup/services' });
    expect(res.statusCode).toBe(401);
  });

  it('shows a clinic only its own prices', async () => {
    await seedService();

    const theirs = (await priceList(otherAdmin)).json<{ services: unknown[] }>();
    expect(theirs.services).toHaveLength(0);
  });
});

// --- tax --------------------------------------------------------------------

describe('the tax rate', () => {
  it('defaults to zero', async () => {
    // Healthcare by a clinical establishment is GST-exempt, so this is the
    // right default and the column existed with no way to change it.
    const created = await seedService();
    expect(created).toMatchObject({ code: 'XRAY-KNEE' });
    expect((await priceList()).json().services[0].taxRateBasisPoints).toBe(0);
  });

  it('can be set in basis points', async () => {
    // 500 basis points is 5%. Basis points rather than a percentage because
    // every other rate in this codebase is, and the tax on an invoice line is
    // computed as Math.round(gross * rate / 10000).
    const created = await seedService({ taxRateBasisPoints: 1800 });
    expect(created).toMatchObject({ code: 'XRAY-KNEE' });
    expect((await priceList()).json().services[0].taxRateBasisPoints).toBe(1800);
  });

  it('survives an edit that does not mention it', async () => {
    await seedService({ taxRateBasisPoints: 1800 });

    await upsert({
      code: 'XRAY-KNEE',
      name: 'X-ray, knee',
      category: 'DIAGNOSTIC',
      pricePaise: 70000,
    });

    expect((await priceList()).json().services[0].taxRateBasisPoints).toBe(1800);
  });

  it('refuses a rate above 100 per cent', async () => {
    const res = await upsert({
      code: 'SILLY',
      name: 'Silly tax',
      category: 'OTHER',
      pricePaise: 1000,
      taxRateBasisPoints: 10_001,
    });

    expect(res.statusCode).toBe(400);
  });
});

// --- department -------------------------------------------------------------

describe('the department link', () => {
  it('is optional — a service may belong to nobody', async () => {
    // A consultation belongs to whichever doctor gave it; a dressing may belong
    // to nobody. Forcing a department would make the administrator invent one.
    await seedService();
    expect((await priceList()).json().services[0].department).toBeNull();
  });

  it('attaches a service to a department', async () => {
    await seedService({ departmentId: fx.main.departmentId });

    const row = (await priceList()).json().services[0];
    expect(row.department).toMatchObject({ id: fx.main.departmentId, name: 'Imaging' });
  });

  it('can be detached again', async () => {
    await seedService({ departmentId: fx.main.departmentId });

    await upsert({
      code: 'XRAY-KNEE',
      name: 'X-ray, knee',
      category: 'DIAGNOSTIC',
      pricePaise: 50000,
      departmentId: null,
    });

    expect((await priceList()).json().services[0].department).toBeNull();
  });

  it('survives an edit that does not mention it', async () => {
    await seedService({ departmentId: fx.main.departmentId });

    await upsert({
      code: 'XRAY-KNEE',
      name: 'X-ray, knee',
      category: 'DIAGNOSTIC',
      pricePaise: 90000,
    });

    expect((await priceList()).json().services[0].department).not.toBeNull();
  });

  it('refuses another clinic department', async () => {
    // Row-level security is what makes this true: the other clinic's department
    // is simply not visible, so the lookup finds nothing.
    const res = await upsert({
      code: 'SNEAK',
      name: 'Wrong department',
      category: 'OTHER',
      pricePaise: 1000,
      departmentId: fx.other.departmentId,
    });

    expect(res.statusCode).toBe(400);
  });
});

// --- FR-PRC-03 --------------------------------------------------------------

describe('a price change does not reach what is already billed', () => {
  it('leaves an existing invoice line at the price it was charged', async () => {
    await seedService({ code: 'PROC-DRESS', name: 'Dressing', pricePaise: 25000 });

    // A line written at the old price, the way billing writes one: the name and
    // the price are COPIED, not referenced.
    const [invoice] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `INSERT INTO invoice (tenant_id, number, patient_id, subtotal_paise, total_paise, updated_at)
       VALUES ($1, 'INV-TEST01', $2, 25000, 25000, now()) RETURNING id`,
      [fx.main.id, fx.main.patientIds[0]],
    );

    await ownerQuery(
      fx.main.id,
      `INSERT INTO invoice_line
         (tenant_id, invoice_id, description, quantity, unit_price_paise, total_paise)
       VALUES ($1, $2, 'Dressing', 1, 25000, 25000)`,
      [fx.main.id, invoice!.id],
    );

    // The clinic puts its prices up.
    await upsert({
      code: 'PROC-DRESS',
      name: 'Dressing',
      category: 'PROCEDURE',
      pricePaise: 40000,
    });

    const [line] = await ownerQuery<{ unit_price_paise: number; description: string }>(
      fx.main.id,
      `SELECT unit_price_paise, description FROM invoice_line WHERE invoice_id = $1`,
      [invoice!.id],
    );

    // A receipt reprinted in 2029 shows what was actually charged.
    expect(line?.unit_price_paise).toBe(25000);
    expect(line?.description).toBe('Dressing');

    await ownerQuery(fx.main.id, `DELETE FROM invoice_line WHERE invoice_id = $1`, [invoice!.id]);
    await ownerQuery(fx.main.id, `DELETE FROM invoice WHERE id = $1`, [invoice!.id]);
  });
});
