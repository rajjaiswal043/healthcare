/**
 * The patient record, over HTTP.
 *
 * The detail endpoint assembles demographics, the current consent position and
 * recent visits in one response, so most of what is worth asserting is that the
 * assembly is correct — particularly the consent rule, which is not obvious from
 * the shape: consent records are append-only, so "do they consent" means "what
 * does the most recent row for that purpose say", not "does a row exist".
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  clinicDate,
  closeTestApp,
  createTestApp,
  login,
  ownerQuery,
  resetAppointments,
  seedFixtures,
  type Fixtures,
  type Session,
} from './harness.js';

let app: NestFastifyApplication;
let fx: Fixtures;
let frontDesk: Session;
let doctor: Session;
let otherFrontDesk: Session;

const DAY = clinicDate(7);

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();

  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  doctor = await login(app, fx.main.slug, 'doctor@main.test');
  otherFrontDesk = await login(app, fx.other.slug, 'frontdesk@other.test');
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  await resetAppointments();
});

function get(patientId: string, session: Session = frontDesk) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/patients/${patientId}`,
    headers: { cookie: session.cookie },
  });
}

async function bookAndArrive(patientIndex = 0, slotIndex = 0): Promise<string> {
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
      reasonForVisit: 'Fever and body ache',
    },
  });

  const id = booked.json().id;
  await app.inject({
    method: 'PATCH',
    url: `/api/v1/appointments/${id}/check-in`,
    headers: { cookie: frontDesk.cookie },
  });
  return id;
}

describe('the patient record', () => {
  it('returns the demographics the list view leaves out', async () => {
    const res = await get(fx.main.patientIds[0] as string);

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.uhid).toBe('T000001');
    expect(body.name).toBe('Kavita Rane');
    expect(body.mobile).toBe('9800000001');

    // The fields that exist only on this endpoint. A search result stays cheap:
    // widening it would mean every keystroke of a live search pulling addresses
    // and visit history for twenty patients nobody has opened.
    expect(body).toHaveProperty('bloodGroup');
    expect(body).toHaveProperty('emergencyContactName');
    expect(body).toHaveProperty('addressLine');
    expect(body).toHaveProperty('consents');
    expect(body).toHaveProperty('appointments');
    expect(body.isActive).toBe(true);
  });

  it('starts with no visits and an honest zero', async () => {
    const body = (await get(fx.main.patientIds[1] as string)).json();

    expect(body.appointments).toEqual([]);
    expect(body.stats.totalVisits).toBe(0);
    expect(body.stats.completedVisits).toBe(0);
    expect(body.stats.lastVisitAt).toBeNull();
  });

  it('lists visits newest first, with the note when there is one', async () => {
    const appointmentId = await bookAndArrive(0, 0);

    // A second, earlier visit for the same patient with a different doctor is
    // not expressible here (one practitioner per fixture), so this checks the
    // link to the clinical note instead — the reason the list exists at all.
    const encounter = await app.inject({
      method: 'POST',
      url: '/api/v1/encounters',
      headers: { cookie: doctor.cookie },
      payload: { appointmentId },
    });
    expect(encounter.statusCode).toBe(201);

    const body = (await get(fx.main.patientIds[0] as string)).json();

    expect(body.appointments).toHaveLength(1);
    expect(body.appointments[0].id).toBe(appointmentId);
    expect(body.appointments[0].encounterId).toBe(encounter.json().id);
    expect(body.appointments[0].practitioner.fullName).toBe('Dr Asha Menon');
    expect(body.appointments[0].reasonForVisit).toBe('Fever and body ache');
    expect(body.stats.totalVisits).toBe(1);
    // Still in progress, so not yet a completed visit.
    expect(body.stats.completedVisits).toBe(0);
  });

  it('reports no note for a visit that produced none', async () => {
    await bookAndArrive(2, 3);

    const body = (await get(fx.main.patientIds[2] as string)).json();
    expect(body.appointments[0].encounterId).toBeNull();
  });

  it('counts a finished visit and dates it', async () => {
    const appointmentId = await bookAndArrive(0, 0);

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appointmentId}/call`,
      headers: { cookie: frontDesk.cookie },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/appointments/${appointmentId}/complete`,
      headers: { cookie: frontDesk.cookie },
    });

    const body = (await get(fx.main.patientIds[0] as string)).json();
    expect(body.stats.completedVisits).toBe(1);
    expect(body.stats.lastVisitAt).toBeTruthy();
  });
});

describe('consent', () => {
  it('reports the latest decision per purpose, not the first', async () => {
    const patientId = fx.main.patientIds[0] as string;

    // Consent granted, then withdrawn. Both rows survive — withdrawal is a new
    // record, because proving what was agreed and when is the whole point.
    await ownerQuery(
      fx.main.id,
      `INSERT INTO consent_record (tenant_id, patient_id, purpose, granted, notice_version, granted_at)
       VALUES ($1, $2, 'MARKETING', true,  '2026-08-v1', now() - interval '2 days'),
              ($1, $2, 'MARKETING', false, '2026-08-v1', now() - interval '1 day')`,
      [fx.main.id, patientId],
    );

    const body = (await get(patientId)).json();
    const marketing = body.consents.filter((c: { purpose: string }) => c.purpose === 'MARKETING');

    // One current position, and it is the withdrawal.
    expect(marketing).toHaveLength(1);
    expect(marketing[0].granted).toBe(false);

    // And the history is still there underneath it.
    const rows = await ownerQuery(
      fx.main.id,
      `SELECT id FROM consent_record WHERE patient_id = $1 AND purpose = 'MARKETING'`,
      [patientId],
    );
    expect(rows).toHaveLength(2);
  });
});

describe('who may read a patient', () => {
  it('refuses an unauthenticated request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${fx.main.patientIds[0]}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses another clinic’s patient with a 404, not a 403', async () => {
    const res = await get(fx.main.patientIds[0] as string, otherFrontDesk);

    // Under row-level security the row is simply not visible. A 403 would
    // confirm that the id refers to a real patient somewhere, which is exactly
    // what an attacker probing ids is trying to learn.
    expect(res.statusCode).toBe(404);
  });

  it('records every read in the audit trail', async () => {
    const patientId = fx.main.patientIds[0] as string;
    await get(patientId, doctor);

    const rows = await ownerQuery<{ actor_user_id: string; action: string }>(
      fx.main.id,
      `SELECT actor_user_id, action FROM audit_event
        WHERE action = 'patient.view' AND patient_id = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [patientId],
    );

    // FR-P36-19 asks for reads as well as writes. "Who opened this patient's
    // record" is the question that actually gets asked.
    expect(rows[0]?.actor_user_id).toBeTruthy();
  });
});

// --- all patients, paged ------------------------------------------------------

/**
 * `GET /patients/all?page=N` — every active patient, newest first, thirty a page.
 *
 * Patients inserted here are written with a `created_at` a day in the FUTURE,
 * which puts them above the fixtures and above anything else this file
 * registered, so a test can say exactly which rows land on page 1. The
 * assertions that are about the WHOLE list — totals, every-patient-once — read
 * the active set straight from the table instead, so they hold whatever else
 * is in it.
 */
describe('the all-patients list', () => {
  const PREFIX = 'ALLP';
  const PAGE = 30;

  afterEach(async () => {
    await ownerQuery(fx.main.id, `DELETE FROM patient WHERE uhid LIKE '${PREFIX}%'`);
  });

  /**
   * `count` patients in ONE statement, so every one of them shares a single
   * `created_at` — the exact shape of seeded or imported data, where Postgres
   * gives every row in a transaction the same `now()`. The case the `id`
   * tie-break exists for.
   */
  async function insertBatch(count: number, options: { inactiveEvery?: number } = {}) {
    await ownerQuery(
      fx.main.id,
      `INSERT INTO patient (tenant_id, uhid, name, gender, age_years, mobile, is_active,
                            created_at, updated_at)
       SELECT $1,
              '${PREFIX}' || lpad(n::text, 3, '0'),
              'Listed Patient ' || lpad(n::text, 3, '0'),
              'FEMALE', 40,
              '97000' || lpad(n::text, 5, '0'),
              ${options.inactiveEvery ? `(n % ${options.inactiveEvery}) <> 0` : 'true'},
              now() + interval '1 day',
              now()
         FROM generate_series(1, $2::int) AS n`,
      [fx.main.id, count],
    );
  }

  type Row = { id: string; uhid: string };
  type Page = { patients: Row[]; page: number; pageSize: number; total: number };

  function list(page?: number | string, session: Session = frontDesk) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/patients/all${page === undefined ? '' : `?page=${page}`}`,
      headers: { cookie: session.cookie },
    });
  }

  const pageOf = async (page?: number) => (await list(page)).json<Page>();

  /** The active patients, as the table holds them — the reference answer. */
  async function activeIds(): Promise<string[]> {
    const rows = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM patient WHERE is_active ORDER BY created_at DESC, id DESC`,
    );
    return rows.map((r) => r.id);
  }

  /** Ours, highest id first — the order a tie between them must come back in. */
  async function ourIds(): Promise<string[]> {
    const rows = await ownerQuery<{ id: string }>(
      fx.main.id,
      `SELECT id FROM patient WHERE uhid LIKE '${PREFIX}%' AND is_active ORDER BY id DESC`,
    );
    return rows.map((r) => r.id);
  }

  // --- the pages -------------------------------------------------------------

  it('puts the most recently registered first', async () => {
    // Two separate rows with genuinely different `created_at`.
    await ownerQuery(
      fx.main.id,
      `INSERT INTO patient (tenant_id, uhid, name, gender, age_years, mobile, created_at, updated_at)
       VALUES ($1, '${PREFIX}OLD', 'Registered Earlier', 'MALE', 30, '9700099998',
               now() + interval '1 day', now()),
              ($1, '${PREFIX}NEW', 'Registered Later', 'MALE', 30, '9700099999',
               now() + interval '2 days', now())`,
      [fx.main.id],
    );

    const uhids = (await pageOf(1)).patients.map((p) => p.uhid);
    expect(uhids.slice(0, 2)).toEqual([`${PREFIX}NEW`, `${PREFIX}OLD`]);
  });

  it('shows the newest thirty on page 1 and the next thirty on page 2', async () => {
    await insertBatch(65);
    const ours = await ourIds();

    const one = await pageOf(1);
    const two = await pageOf(2);

    expect(one.patients.map((p) => p.id)).toEqual(ours.slice(0, PAGE));
    expect(two.patients.map((p) => p.id)).toEqual(ours.slice(PAGE, PAGE * 2));
    expect(one).toMatchObject({ page: 1, pageSize: PAGE });
    expect(two).toMatchObject({ page: 2, pageSize: PAGE });
  });

  it('is page 1 when no page is asked for', async () => {
    await insertBatch(5);
    expect(await pageOf()).toEqual(await pageOf(1));
  });

  it('reports the total of active patients, on every page alike', async () => {
    await insertBatch(40);
    const expected = (await activeIds()).length;

    expect((await pageOf(1)).total).toBe(expected);
    expect((await pageOf(2)).total).toBe(expected);
  });

  it('puts the remainder on the last page', async () => {
    await insertBatch(65);
    const total = (await activeIds()).length;
    const last = Math.ceil(total / PAGE);

    const page = await pageOf(last);

    expect(page.patients).toHaveLength(total - (last - 1) * PAGE);
    expect(page.patients.length).toBeGreaterThan(0);
  });

  /**
   * The property offset paging lives or dies by.
   *
   * Sixty-five patients share one `created_at` and straddle three pages. If the
   * order among them were not fixed, the request for page 2 could sort them
   * differently from the request for page 1, and a patient would appear twice
   * or not at all — with nothing on screen to say so.
   */
  it('shows every active patient exactly once across all the pages', async () => {
    await insertBatch(65);
    const expected = await activeIds();
    const last = Math.ceil(expected.length / PAGE);

    const seen: string[] = [];
    for (let page = 1; page <= last; page++) {
      seen.push(...(await pageOf(page)).patients.map((p) => p.id));
    }

    expect(new Set(seen).size).toBe(seen.length); // nobody twice
    expect(seen).toEqual(expected); // nobody missing, and in order
  });

  // --- the edges -------------------------------------------------------------

  /**
   * Decision (d): past the end is an empty page with the real total, not an
   * error. It happens for real — a bookmarked last page empties when a patient
   * is deactivated — and the screen turns it into "the last page is N".
   */
  it('answers a page past the end with nothing and the true total', async () => {
    await insertBatch(5);
    const total = (await activeIds()).length;
    const beyond = Math.ceil(total / PAGE) + 5;

    const res = await list(beyond);

    expect(res.statusCode).toBe(200);
    expect(res.json<Page>()).toMatchObject({ patients: [], page: beyond, total });
  });

  it('refuses a page that is not a positive whole number', async () => {
    for (const bad of ['0', '-1', 'abc', '2.5']) {
      const res = await list(bad);
      expect(res.statusCode, `page=${bad}`).toBe(400);
    }
  });

  it('leaves inactive patients out of the pages and out of the total', async () => {
    const before = (await pageOf(1)).total;

    // Nine inserted, every third switched off: six should count.
    await insertBatch(9, { inactiveEvery: 3 });

    const page = await pageOf(1);
    expect(page.total).toBe(before + 6);

    const uhids = new Set(page.patients.map((p) => p.uhid));
    for (const n of [3, 6, 9]) {
      expect(uhids.has(`${PREFIX}${String(n).padStart(3, '0')}`)).toBe(false);
    }
  });

  // --- the record ------------------------------------------------------------

  /** Page 4 shows different patients from page 1, so it is a different read. */
  it('records every page viewed, and which page', async () => {
    await insertBatch(40);
    await ownerQuery(fx.main.id, `DELETE FROM audit_event WHERE action = 'patient.list'`);

    await list(1);
    await list(2);

    const rows = await ownerQuery<{ reason: string; actor_user_id: string | null }>(
      fx.main.id,
      `SELECT reason, actor_user_id FROM audit_event
        WHERE action = 'patient.list' ORDER BY occurred_at, id`,
    );
    expect(rows.map((r) => r.reason)).toEqual(['page 1', 'page 2']);
    expect(rows.every((r) => r.actor_user_id)).toBe(true);
  });

  // --- boundaries ------------------------------------------------------------

  it('shows a clinic only its own patients', async () => {
    await insertBatch(3);

    const other = (await list(1, otherFrontDesk)).json<Page>();
    expect(other.patients.some((p) => p.uhid.startsWith(PREFIX))).toBe(false);
  });

  it('is refused without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/patients/all' });
    expect(res.statusCode).toBe(401);
  });

  /**
   * `/patients/all` and `/patients/:id` share a prefix. A static segment wins
   * in Fastify's router; this pins it, so "all" is never answered with a 400
   * from the UUID pipe.
   */
  it('is not mistaken for a patient id', async () => {
    const res = await list(1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('total');
  });
});

/**
 * Finding a patient by name.
 *
 * Names match by PREFIX, on any word: "rajesh" finds Rajesh Naidu and Kumar
 * Rajesh, and does not find Ramesh Rao.
 *
 * This replaced trigram similarity on 28 Sep 2026, after the front desk
 * reported unrelated names in the results. That rule scored the query against
 * the whole name, so the number depended on how long the rest of the name was
 * rather than on how well anything matched: "Rajesh" scored 0.333 against
 * "Ramesh Rao" and was returned, while "Muhammad Rao" scored 0.308 against its
 * own surname and was nearly lost. One threshold governed both and no value
 * separated them.
 *
 * These patients are inserted by this block and deleted after it, so the
 * assertions can be exact counts rather than "at least one" — a search test
 * that only checks the right row is present cannot catch the wrong row being
 * present beside it, which is the entire bug.
 */
describe('finding a patient by name', () => {
  const PREFIX = 'SRCH';

  const PEOPLE = [
    'Rajesh Naidu',
    'Rajesh Sharma',
    'Ramesh Rao', // The false positive: trigram-similar, a different person.
    'Kumar Rajesh', // The surname case: matches on a word that is not the first.
    'Muhammad Rao', // Scored 0.308 for its own surname under the old rule.
    'Rekha Chauhan',
  ];

  beforeAll(async () => {
    for (const [i, name] of PEOPLE.entries()) {
      await ownerQuery(
        fx.main.id,
        `INSERT INTO patient (tenant_id, uhid, name, gender, age_years, mobile, updated_at)
         VALUES ($1, $2, $3, 'MALE', 40, $4, now())`,
        [
          fx.main.id,
          `${PREFIX}${String(i).padStart(3, '0')}`,
          name,
          `96000${String(i).padStart(5, '0')}`,
        ],
      );
    }
  });

  afterAll(async () => {
    await ownerQuery(fx.main.id, `DELETE FROM patient WHERE uhid LIKE '${PREFIX}%'`);
  });

  async function search(query: string): Promise<string[]> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/patients?q=${encodeURIComponent(query)}&limit=25`,
      headers: { cookie: frontDesk.cookie },
    });
    expect(res.statusCode).toBe(200);

    // Only the patients this block inserted: the seed has its own people, and
    // a test that asserted over all of them would break every time it changed.
    return res
      .json<{ patients: Array<{ name: string; uhid: string }> }>()
      .patients.filter((p) => p.uhid.startsWith(PREFIX))
      .map((p) => p.name);
  }

  it('finds everyone whose name starts with what was typed', async () => {
    expect(await search('Rajesh')).toEqual(
      expect.arrayContaining(['Rajesh Naidu', 'Rajesh Sharma']),
    );
  });

  /** The reported bug. Ramesh is not Rajesh, however the trigrams fall. */
  it('does not find a different name that merely looks similar', async () => {
    const found = await search('Rajesh');

    expect(found).not.toContain('Ramesh Rao');
    expect(found).not.toContain('Rekha Chauhan');
  });

  it('finds a name by its second word', async () => {
    // "Kumar Rajesh" has to come back for "rajesh", or a patient whose given
    // name is recorded second is unfindable by it.
    expect(await search('Rajesh')).toContain('Kumar Rajesh');
  });

  it('finds a patient by surname whatever the rest of the name is', async () => {
    // "Muhammad Rao" scored 0.308 against "Rao" under the old rule — inside the
    // 0.3 threshold by a hair, and the reason the threshold could not simply be
    // raised to exclude Ramesh.
    expect(await search('Rao')).toEqual(expect.arrayContaining(['Muhammad Rao', 'Ramesh Rao']));
  });

  it('matches the start of a word, not the middle of one', async () => {
    // Plain "contains" would return every Rajesh here. Nobody searches by the
    // middle of a name, and the results are noise if they do.
    expect(await search('esh')).toEqual([]);
  });

  it('puts a whole-name match above a match on a later word', async () => {
    const found = await search('Rajesh');

    expect(found.indexOf('Kumar Rajesh')).toBeGreaterThan(found.indexOf('Rajesh Naidu'));
  });

  it('is case-insensitive', async () => {
    expect(await search('rAjEsH')).toContain('Rajesh Naidu');
  });

  /**
   * Matching is now entirely ILIKE, so the query reaches a pattern language.
   * Without escaping, one "%" returns every patient in the clinic — a data
   * leak wearing the costume of a search result.
   */
  it('treats a wildcard as a character, not as a wildcard', async () => {
    expect(await search('%a')).toEqual([]);
    expect(await search('_a')).toEqual([]);
    expect(await search('Ra%')).toEqual([]);
  });

  it('ignores a query too short to mean anything', async () => {
    expect(await search('R')).toEqual([]);
  });
});

/**
 * A patient needs a name, not a number.
 *
 * The same defect as the staff one reported on 28 Sep 2026, on a screen that
 * matters more. A patient recorded as "9876543210" cannot be found by the
 * search that now matches on letters, cannot be told apart from a genuine
 * duplicate, and prints as a number on their own prescription.
 *
 * The rule's own cases are in `src/common/__tests__/is-person-name.test.ts`;
 * these prove it reaches registration, correction, and the duplicate check.
 */
describe('a patient name has to be a name', () => {
  // Ten digits starting 6-9, which is what the mobile rule requires. The first
  // draft of this was nine digits long, so every request failed on the phone
  // number and the "refuses" tests passed for the wrong reason.
  let mobile = 95000000;

  function registerWith(name: unknown) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/patients',
      headers: { cookie: frontDesk.cookie },
      payload: {
        name,
        gender: 'FEMALE',
        ageYears: 30,
        mobile: `98${mobile++}`,
        confirmedNotDuplicate: true,
        consentCareDelivery: true,
      },
    });
  }

  it('refuses a number at registration', async () => {
    const res = await registerWith('9876543210');

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('two letters');
  });

  it('refuses punctuation at registration', async () => {
    expect((await registerWith('...')).statusCode).toBe(400);
  });

  it('still registers a short real name', async () => {
    expect((await registerWith('Ram')).statusCode).toBe(201);
  });

  it('still registers a name in Devanagari', async () => {
    expect((await registerWith('नरवीर सिंह')).statusCode).toBe(201);
  });

  /**
   * Correction is the second way in, and it was its own DTO with its own copy
   * of the rule — so a patient registered correctly could be renamed to a
   * number afterwards, which is the same broken record by a slower route.
   */
  it('refuses a number when correcting an existing patient', async () => {
    const registered = await registerWith('Sunita Kulkarni');
    expect(registered.statusCode).toBe(201);
    const id = registered.json<{ patient: { id: string } }>().patient.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/patients/${id}`,
      headers: { cookie: frontDesk.cookie },
      payload: { name: '12345', reason: 'Typed wrongly at the desk' },
    });

    expect(res.statusCode).toBe(400);
  });
});
