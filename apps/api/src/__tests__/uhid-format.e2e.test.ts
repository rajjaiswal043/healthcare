/**
 * Patient ID format — phase P1: the allocator is safe to configure.
 *
 * The Patient ID Format requirement is mostly a screen: ask a clinic what its
 * patient numbers should look like. But once prefix and width are things a
 * person CHOOSES, two faults in the allocator stop being theoretical. This file
 * pins the database behaviour those screens will stand on.
 *
 * **`lpad` truncates.** `lpad('10000', 4, '0')` is `'1000'`. At width 4, patient
 * 10,000 was handed patient 1,000's ID — and because allocation and insert share
 * a transaction, the clash rolled the counter back and every later registration
 * failed the same way.
 *
 * **A digit-ending prefix re-issues IDs after a format change.** `DRV1` + `05`
 * and `DRV` + `105` are both `DRV105`, even though the counter only goes up.
 *
 * Every test sets its own prefix and counter, with a prefix no other test uses,
 * so the order they run in cannot manufacture a clash between them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  closeTestApp,
  createTestApp,
  login,
  ownerQuery,
  seedFixtures,
  type Fixtures,
  type Session,
} from './harness.js';

let app: NestFastifyApplication;
let fx: Fixtures;
let frontDesk: Session;

/** Distinct 10-digit mobiles starting 7, so no registration resembles another. */
let nextMobile = 7_100_000_001;

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();
  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
});

afterAll(async () => {
  await closeTestApp(app);
});

/** The format, written straight to the row the allocator reads. */
async function setFormat(prefix: string, padding: number): Promise<void> {
  await ownerQuery(
    fx.main.id,
    'UPDATE tenant SET uhid_prefix = $2, uhid_padding = $3 WHERE id = $1',
    [fx.main.id, prefix, padding],
  );
}

async function setCounter(n: number): Promise<void> {
  await ownerQuery(fx.main.id, 'UPDATE tenant SET uhid_counter = $2 WHERE id = $1', [
    fx.main.id,
    n,
  ]);
}

async function counter(): Promise<number> {
  const [row] = await ownerQuery<{ n: number }>(
    fx.main.id,
    'SELECT uhid_counter::int AS n FROM tenant WHERE id = $1',
    [fx.main.id],
  );
  return row!.n;
}

/**
 * Register through the API, and read back the UHID actually STORED.
 *
 * Read from the row rather than the response, because what matters is what
 * went onto the patient — the number printed on their card from then on.
 */
async function register() {
  const mobile = String(nextMobile++);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/patients',
    headers: { cookie: frontDesk.cookie },
    payload: {
      name: `Format Probe ${mobile}`,
      gender: 'FEMALE',
      ageYears: 30,
      mobile,
      // Every probe looks alike; duplicate detection is not under test here.
      confirmedNotDuplicate: true,
      consentCareDelivery: true,
    },
  });

  const [row] = await ownerQuery<{ uhid: string }>(
    fx.main.id,
    'SELECT uhid FROM patient WHERE mobile = $1',
    [mobile],
  );
  return { res, uhid: row?.uhid ?? null };
}

// --- the allocator ----------------------------------------------------------

describe('next_uhid never cuts a number short', () => {
  it('pads a number shorter than the width', async () => {
    await setFormat('PAD', 3);
    await setCounter(41);

    const { res, uhid } = await register();

    expect(res.statusCode).toBe(201);
    expect(uhid).toBe('PAD042');
  });

  it('writes a number longer than the width in full, and keeps going', async () => {
    await setFormat('CUT', 3);
    await setCounter(999);

    const first = await register();
    const second = await register();

    /**
     * The whole of Bug A. Before the fix, 1000 at width 3 became `lpad('1000',
     * 3)` = '100', so the first of these was CUT100 — and the second was CUT100
     * AGAIN, which the unique index refused. Every registration after that
     * refused too, because the failed insert rolled the counter back with it.
     */
    expect(first.res.statusCode).toBe(201);
    expect(first.uhid).toBe('CUT1000');
    expect(second.res.statusCode).toBe(201);
    expect(second.uhid).toBe('CUT1001');
  });
});

// --- the format rules -------------------------------------------------------

describe('what a patient ID format may be', () => {
  it.each([
    ['DRV1', 'ends in a digit — the rule that stops a format change re-issuing IDs'],
    ['drv', 'lowercase'],
    ['1AB', 'starts with a digit'],
    ['DR V', 'contains a space'],
    ['DR%', 'contains %, a wildcard in patient search'],
    ['DR_V', 'contains _, a wildcard in patient search'],
    ['', 'is empty'],
  ])('refuses the prefix %j, which %s', async (prefix) => {
    await expect(setFormat(prefix, 5)).rejects.toThrow(/tenant_uhid_prefix_format/);
  });

  it('accepts the shapes clinics actually ask for', async () => {
    for (const prefix of ['DRVIV-', 'SNC/', 'T', 'A1B', 'X-Y/']) {
      await expect(setFormat(prefix, 5)).resolves.toBeUndefined();
    }
  });

  it.each([2, 9])('refuses width %i', async (width) => {
    await expect(setFormat('WIDTH', width)).rejects.toThrow(/tenant_uhid_padding_range/);
  });

  it('accepts widths 3 through 8', async () => {
    await expect(setFormat('WIDTH', 3)).resolves.toBeUndefined();
    await expect(setFormat('WIDTH', 8)).resolves.toBeUndefined();
  });

  it('gives a clinic created without a width five digits, like every clinic so far', async () => {
    const [row] = await ownerQuery<{ id: string; uhid_padding: number }>(
      fx.main.id,
      `INSERT INTO tenant (slug, name, legal_name, uhid_prefix, updated_at)
       VALUES ('width-default-probe', 'Width Probe', 'Width Probe', 'WDP', now())
       RETURNING id, uhid_padding`,
    );

    // The column said 6 while onboarding said 5, so the "default" depended on
    // which path created the clinic. There is one answer now.
    expect(row?.uhid_padding).toBe(5);

    await ownerQuery(fx.main.id, 'DELETE FROM tenant WHERE id = $1', [row!.id]);
  });
});

// --- onboarding -------------------------------------------------------------

describe('platform_create_tenant', () => {
  it('takes the width it is given instead of hardcoding five', async () => {
    const [created] = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT platform_create_tenant(
         $1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::int,
         NULL::varchar, NULL::varchar, NULL::uuid
       ) AS id`,
      ['format-probe', 'Format Probe', 'Asia/Kolkata', 'prb', 4],
    );

    const [tenant] = await ownerQuery<{ uhid_prefix: string; uhid_padding: number }>(
      fx.main.id,
      'SELECT uhid_prefix, uhid_padding FROM tenant WHERE id = $1',
      [created!.id],
    );

    expect(tenant?.uhid_prefix).toBe('PRB');
    expect(tenant?.uhid_padding).toBe(4);

    await ownerQuery(fx.main.id, 'DELETE FROM tenant WHERE id = $1', [created!.id]);
  });

  it('has no seven-argument version left to be called by mistake', async () => {
    /**
     * Adding a parameter changes the signature, and Postgres would otherwise
     * keep the old function as an overload — so a caller still passing seven
     * arguments would quietly get the hardcoded width. The migration drops it.
     */
    await expect(
      ownerQuery(
        fx.main.id,
        `SELECT platform_create_tenant(
           'seven-args'::varchar, 'Seven'::varchar, 'Asia/Kolkata'::varchar, 'SVN'::varchar,
           NULL::varchar, NULL::varchar, NULL::uuid
         )`,
      ),
    ).rejects.toThrow(/does not exist/);
  });
});

// --- changing the format later ---------------------------------------------

describe('platform_set_uhid_format', () => {
  it('changes the next patient’s ID, and leaves the counter and every issued ID alone', async () => {
    await setFormat('OLD', 5);
    await setCounter(200);

    const existing = await register();
    expect(existing.uhid).toBe('OLD00201');
    const before = await counter();

    const [changed] = await ownerQuery<{ prefix: string; padding: number; issued: number }>(
      fx.main.id,
      `SELECT prefix, padding, issued::int AS issued
         FROM platform_set_uhid_format($1::uuid, $2::varchar, $3::int)`,
      [fx.main.id, 'snc/', 4],
    );

    expect(changed).toEqual({ prefix: 'SNC/', padding: 4, issued: before });

    // The counter is not in the function's SET list, and must never be:
    // restarting it would issue a second patient differing only by prefix.
    expect(await counter()).toBe(before);

    // The patient already holding a card keeps it.
    const [still] = await ownerQuery<{ n: number }>(
      fx.main.id,
      `SELECT count(*)::int AS n FROM patient WHERE uhid = 'OLD00201'`,
    );
    expect(still?.n).toBe(1);

    // And the next patient carries on from the same number, in the new format.
    const next = await register();
    expect(next.uhid).toBe('SNC/0202');
  });

  it('refuses a format the table refuses', async () => {
    await expect(
      ownerQuery(
        fx.main.id,
        `SELECT * FROM platform_set_uhid_format($1::uuid, 'DRV1'::varchar, 4)`,
        [fx.main.id],
      ),
    ).rejects.toThrow(/tenant_uhid_prefix_format/);
  });

  it('refuses a clinic that does not exist', async () => {
    await expect(
      ownerQuery(
        fx.main.id,
        `SELECT * FROM platform_set_uhid_format(
           '01930000-0000-7000-8000-0000000000ff'::uuid, 'NOPE'::varchar, 5
         )`,
      ),
    ).rejects.toThrow(/Unknown tenant/);
  });
});

// --- if a clash happens anyway ---------------------------------------------

describe('a UHID clash', () => {
  it('is refused with a sentence, not a 500', async () => {
    await setFormat('CLASH', 5);
    await setCounter(10);

    const first = await register();
    expect(first.uhid).toBe('CLASH00011');

    // Force the allocator to hand out an ID that is already on a patient.
    await setCounter(10);

    const second = await register();

    expect(second.res.statusCode).toBe(409);
    expect(second.res.json().error.details?.code).toBe('UHID_CLASH');
    // It names the ID, so a report of it can be acted on without a database.
    expect(second.res.json().error.message).toContain('CLASH00011');
    expect(second.uhid).toBeNull();

    /**
     * Why the sentence matters. Allocation and insert share one transaction, so
     * the failure rolled the counter back with it: the next attempt would get
     * the same number and fail the same way. A raw 500 would repeat forever
     * with nothing on screen to say why.
     */
    expect(await counter()).toBe(10);

    const [rows] = await ownerQuery<{ n: number }>(
      fx.main.id,
      `SELECT count(*)::int AS n FROM patient WHERE uhid = 'CLASH00011'`,
    );
    expect(rows?.n).toBe(1);
  });
});
