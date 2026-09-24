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

  it('has no delete endpoint', async () => {
    // FR-PRC-03: withdrawn, never removed. Reporting groups by service, and a
    // deleted one makes last month's figures unexplainable.
    const service = await seedService();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/setup/services/${service.id}`,
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(404);
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
    expect(body.departments.map((d) => d.name)).toContain('General Medicine');
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
    expect(row.department).toMatchObject({ id: fx.main.departmentId, name: 'General Medicine' });
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
