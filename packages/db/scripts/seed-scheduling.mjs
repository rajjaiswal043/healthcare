#!/usr/bin/env node
/**
 * Seeds departments, doctors, weekly schedules and a realistic day of
 * appointments.
 *
 *   pnpm --filter @healthcloud/db seed:scheduling
 *
 * Run after seed-demo.mjs (which truncates and creates the tenants/patients).
 * Safe to re-run on its own: it clears each tenant's scheduling rows first, so
 * `seed:scheduling` alone is the quick way to restore the demo queue after
 * clicking through it.
 *
 * Today's appointments are seeded across every queue state — waiting, called,
 * finished, still to arrive — so the queue board demonstrates something on the
 * first load rather than being an empty table with a "no data" message.
 */

import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
loadEnv({ path: resolve(REPO_ROOT, '.env') });

const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!ownerUrl || !new URL(ownerUrl).pathname.includes('healthcloud')) {
  console.error('MIGRATION_DATABASE_URL must point at a HealthCloud database.');
  process.exit(1);
}

/** Deterministic PRNG so the demo dataset is identical on every reseed. */
function makeRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const rand = makeRandom(20260807);
const pick = (a) => a[Math.floor(rand() * a.length)];

const DEPARTMENTS = [
  ['General Medicine', 1],
  ['Paediatrics', 2],
  ['Orthopaedics', 3],
  ['Dermatology', 4],
  ['ENT', 5],
];

/**
 * Doctors, with the weekly sessions they actually sit.
 *
 * `days` uses JavaScript's getDay(): 0 = Sunday. Indian clinics generally run
 * Monday-Saturday with Sunday closed, and split the day into a morning and an
 * evening session with a long gap — which is why sessions are separate rows
 * rather than one long block.
 */
const DOCTORS = [
  {
    name: 'Vikram Rao',
    prefix: 'Dr',
    reg: 'MMC-2011-48213',
    qual: 'MBBS, MD (General Medicine)',
    dept: 'General Medicine',
    linkUserEmail: 'doctor@demo.local',
    sessions: [
      { days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00', slot: 15 },
      { days: [1, 3, 5], start: '17:00', end: '20:00', slot: 15 },
      { days: [6], start: '09:00', end: '12:00', slot: 15 },
    ],
  },
  {
    name: 'Anjali Deshpande',
    prefix: 'Dr',
    reg: 'MMC-2014-51907',
    qual: 'MBBS, DCH',
    dept: 'Paediatrics',
    sessions: [
      { days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '13:30', slot: 10 },
      { days: [2, 4], start: '16:30', end: '19:30', slot: 10 },
    ],
  },
  {
    name: 'Suresh Iyer',
    prefix: 'Dr',
    reg: 'MMC-2008-33120',
    qual: 'MBBS, MS (Ortho)',
    dept: 'Orthopaedics',
    sessions: [
      { days: [1, 3, 5], start: '11:00', end: '14:00', slot: 20 },
      { days: [6], start: '10:00', end: '13:00', slot: 20 },
    ],
  },
  {
    name: 'Priya Nair',
    prefix: 'Dr',
    reg: 'MMC-2016-60455',
    qual: 'MBBS, MD (Dermatology)',
    dept: 'Dermatology',
    sessions: [{ days: [2, 4, 6], start: '15:00', end: '19:00', slot: 15 }],
  },
];

/** Lotus is a smaller clinic — two doctors, one location. */
const LOTUS_DOCTORS = [
  {
    name: 'Imran Shaikh',
    prefix: 'Dr',
    reg: 'MMC-2013-49771',
    qual: 'MBBS, MD',
    dept: 'General Medicine',
    sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '13:30', slot: 15 }],
  },
  {
    name: 'Lakshmi Menon',
    prefix: 'Dr',
    reg: 'MMC-2018-71203',
    qual: 'MBBS, DLO',
    dept: 'ENT',
    sessions: [{ days: [1, 3, 5], start: '16:00', end: '19:00', slot: 15 }],
  },
];

const client = new pg.Client({ connectionString: ownerUrl });

/**
 * Builds an instant from a clinic-local wall-clock time.
 *
 * Schedule templates store "09:15" with no timezone; appointments store an
 * instant. This is the conversion, and getting it wrong shifts every
 * appointment in the system by five and a half hours.
 */
function localToInstant(dateStr, hhmm, offset = '+05:30') {
  return new Date(`${dateStr}T${hhmm}:00${offset}`);
}

/** Today, as a clinic-local YYYY-MM-DD. */
function clinicToday(timeZone = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** First row of a result, or undefined. Saves a `.rows[0]` at every call site. */
function rows0(result) {
  return result.rows[0];
}

function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

async function seedTenant(tenant, doctors) {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);

  // --- clear this tenant's scheduling data -------------------------------
  //
  // Practitioners, schedules and appointments are plain inserts, not upserts —
  // there is no natural key to conflict on, and inventing one (name + tenant)
  // would be wrong the day a clinic employs two doctors with the same name.
  //
  // So the script clears first. Without this, a second run either duplicates
  // every doctor (Lotus, whose doctors have no linked user) or dies on
  // practitioner_user_id_key (Sunrise, whose lead doctor does) — leaving the
  // tenants half-seeded and inconsistent with each other.
  //
  // The delete is scoped by tenant and runs under the tenant's RLS context. It
  // is destructive by design: this seeds a demo dataset, and a demo dataset you
  // cannot rebuild on demand is not much of a demo. Never point
  // MIGRATION_DATABASE_URL at anything holding real patient data.
  // Billing first: invoice.appointment_id is ON DELETE RESTRICT, and payment
  // references the invoice, so an appointment cannot be cleared while a bill
  // points at it. Order matters — payments, lines, then invoices.
  await client.query(
    `DELETE FROM payment WHERE invoice_id IN (SELECT id FROM invoice WHERE tenant_id = $1)`,
    [tenant.id],
  );
  await client.query('DELETE FROM invoice_line WHERE tenant_id = $1', [tenant.id]);
  await client.query('DELETE FROM invoice WHERE tenant_id = $1', [tenant.id]);

  // Consultations first. `encounter.appointment_id` is ON DELETE RESTRICT —
  // deliberately, since a clinical note must never be orphaned by tidying up an
  // appointment — so clearing appointments without clearing these fails with a
  // foreign-key error halfway through, leaving one tenant seeded and the other
  // not.
  await client.query(
    `DELETE FROM encounter_addendum WHERE encounter_id IN
       (SELECT id FROM encounter WHERE tenant_id = $1)`,
    [tenant.id],
  );
  await client.query('DELETE FROM prescription WHERE tenant_id = $1', [tenant.id]);
  await client.query('DELETE FROM diagnosis WHERE tenant_id = $1', [tenant.id]);
  await client.query('DELETE FROM vitals_observation WHERE tenant_id = $1', [tenant.id]);
  await client.query('DELETE FROM encounter WHERE tenant_id = $1', [tenant.id]);

  await client.query('DELETE FROM appointment WHERE tenant_id = $1', [tenant.id]);
  await client.query('DELETE FROM queue_counter WHERE tenant_id = $1', [tenant.id]);
  await client.query('DELETE FROM schedule_exception WHERE tenant_id = $1', [tenant.id]);
  await client.query('DELETE FROM practitioner_schedule WHERE tenant_id = $1', [tenant.id]);
  await client.query('DELETE FROM practitioner WHERE tenant_id = $1', [tenant.id]);

  // --- departments -------------------------------------------------------
  const deptIds = {};
  for (const [name, order] of DEPARTMENTS) {
    const { rows } = await client.query(
      `INSERT INTO department (tenant_id, name, display_order, updated_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (tenant_id, name) DO UPDATE SET display_order = EXCLUDED.display_order
       RETURNING id`,
      [tenant.id, name, order],
    );
    deptIds[name] = rows[0].id;
  }

  // --- locations ---------------------------------------------------------
  const { rows: locations } = await client.query(
    'SELECT id, name FROM location WHERE tenant_id = $1 ORDER BY name',
    [tenant.id],
  );
  if (locations.length === 0) throw new Error(`No locations for ${tenant.slug}`);

  // --- doctors and their weekly sessions ---------------------------------
  const practitioners = [];
  for (const doc of doctors) {
    let userId = null;
    if (doc.linkUserEmail) {
      const { rows } = await client.query(
        'SELECT id FROM app_user WHERE tenant_id = $1 AND lower(email) = lower($2)',
        [tenant.id, doc.linkUserEmail],
      );
      userId = rows[0]?.id ?? null;
    }

    const { rows } = await client.query(
      `INSERT INTO practitioner
         (tenant_id, full_name, prefix, registration_number, qualification,
          specialty, department_id, user_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       RETURNING id`,
      [tenant.id, doc.name, doc.prefix, doc.reg, doc.qual, doc.dept, deptIds[doc.dept], userId],
    );
    const practitionerId = rows[0].id;
    practitioners.push({ id: practitionerId, ...doc });

    // Primary location for this doctor — Lotus has one, Sunrise two.
    const locationId = locations[practitioners.length % locations.length].id;

    for (const session of doc.sessions) {
      for (const day of session.days) {
        await client.query(
          `INSERT INTO practitioner_schedule
             (tenant_id, practitioner_id, location_id, day_of_week,
              start_time, end_time, slot_minutes, capacity_per_slot,
              visit_types, valid_from, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,1,'{}', current_date - interval '30 days', now())`,
          [tenant.id, practitionerId, locationId, day, session.start, session.end, session.slot],
        );
      }
    }
  }

  await client.query('COMMIT');
  return { practitioners, locations, deptIds };
}

/**
 * Seeds today's queue for one doctor, spread across every state so the board
 * shows a plausible mid-morning clinic: some finished, one in the room, some
 * waiting with tokens, and some yet to arrive.
 */
async function seedTodaysQueue(tenant, practitioner, locationId, deptId) {
  const today = clinicToday();

  // Tenant context FIRST. `patient` is under FORCE row-level security, so a read
  // before set_config returns zero rows — not an error, just silently nothing,
  // which is exactly how this seeded no appointments the first time.
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);

  const { rows: patients } = await client.query(
    'SELECT id FROM patient ORDER BY created_at LIMIT 40',
  );

  // Payments are attributed to whoever took them, and the day-end report groups
  // by that. Seeded collections belong to the front desk, not to nobody.
  const frontDesk = rows0(
    await client.query(
      `SELECT u.id FROM app_user u
         JOIN user_role ur ON ur.user_id = u.id
         JOIN role r ON r.id = ur.role_id
        WHERE r.key = 'front_desk' LIMIT 1`,
    ),
  );
  const frontDeskUserId = frontDesk?.id ?? null;
  if (patients.length < 12) {
    await client.query('ROLLBACK');
    return 0;
  }

  const session = practitioner.sessions[0];
  const slot = session.slot;

  // 4 finished, 1 with the doctor, 3 waiting, 4 still to arrive.
  const plan = [
    ...Array(4).fill('FULFILLED'),
    'IN_PROGRESS',
    ...Array(3).fill('ARRIVED'),
    ...Array(4).fill('BOOKED'),
  ];

  let created = 0;
  let token = 0;

  for (const [i, status] of plan.entries()) {
    const startHHmm = addMinutes(session.start, i * slot);
    const startAt = localToInstant(today, startHHmm);
    const endAt = localToInstant(today, addMinutes(startHHmm, slot));

    const arrived = status !== 'BOOKED';

    // Everybody holds a token from the moment they are booked, including the
    // patients still to arrive — that is the rule as of 12 Aug 2026. What the
    // ones yet to arrive do NOT have is a place in the queue: no ready_at, so
    // they sit in the diary rather than the waiting list.
    token += 1;

    const { id: appointmentId } = rows0(
      await client.query(
        `INSERT INTO appointment
         (tenant_id, patient_id, practitioner_id, location_id, department_id,
          start_at, end_at, status, visit_type, source, reason_for_visit,
          token_number, queue_date, checked_in_at, ready_at, called_at, completed_at,
          updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::appointment_status,$9::visit_type,
               $10::appointment_source,$11,$12,$13,$14,$15,$16,$17, now())
       RETURNING id`,
        [
          tenant.id,
          patients[i].id,
          practitioner.id,
          locationId,
          deptId,
          startAt,
          endAt,
          status,
          pick(['NEW', 'FOLLOW_UP', 'NEW']),
          i % 4 === 0 ? 'WALK_IN' : 'FRONT_DESK',
          pick([
            'Fever and body ache',
            'Follow-up, BP review',
            'Cough for 5 days',
            'Routine check',
            'Stomach pain',
            null,
          ]),
          token,
          today,
          arrived ? new Date(startAt.getTime() - 10 * 60000) : null,
          // ready_at is the queue position, and it is deliberately the same
          // instant as check-in: the waiting list is in arrival order.
          arrived ? new Date(startAt.getTime() - 10 * 60000) : null,
          status === 'FULFILLED' || status === 'IN_PROGRESS' ? startAt : null,
          status === 'FULFILLED' ? endAt : null,
        ],
      ),
    );
    created += 1;

    /**
     * A bill for every visit, because the clinic is pay-first.
     *
     * Patients who have arrived, been seen, or are with the doctor have paid —
     * that is what pay-first means, and a queue full of people admitted without
     * paying would misrepresent the workflow on the demo's very first screen.
     * The ones still to arrive are left UNPAID on purpose: that is where the
     * check-in gate becomes visible, and it is the whole point of the module.
     */
    const invoiceRow = rows0(
      await client.query(`SELECT next_invoice_number($1::uuid) AS number`, [tenant.id]),
    );

    const feeRow = rows0(
      await client.query(
        `SELECT coalesce(pr.consultation_fee_paise, s.price_paise, 50000) AS fee
           FROM practitioner pr
           LEFT JOIN service s ON s.tenant_id = pr.tenant_id AND s.code = 'CONS-NEW'
          WHERE pr.id = $1`,
        [practitioner.id],
      ),
    );
    const feePaise = Number(feeRow?.fee ?? 50000);

    const invoice = rows0(
      await client.query(
        `INSERT INTO invoice
           (tenant_id, number, patient_id, appointment_id, status,
            subtotal_paise, tax_paise, total_paise, updated_at)
         VALUES ($1,$2,$3,$4,$5::invoice_status,$6,0,$6, now())
         RETURNING id`,
        [
          tenant.id,
          invoiceRow.number,
          patients[i].id,
          appointmentId,
          arrived ? 'PAID' : 'UNPAID',
          feePaise,
        ],
      ),
    );

    await client.query(
      `INSERT INTO invoice_line
         (tenant_id, invoice_id, description, quantity, unit_price_paise, total_paise)
       VALUES ($1, $2, 'Consultation', 1, $3, $3)`,
      [tenant.id, invoice.id, feePaise],
    );

    if (arrived) {
      await client.query(
        `INSERT INTO payment
           (tenant_id, invoice_id, direction, mode, amount_paise, collected_by_user_id, collected_at)
         VALUES ($1, $2, 'IN', $3::payment_mode, $4, $5,
                 $6::timestamptz - interval '12 minutes')`,
        [
          tenant.id,
          invoice.id,
          pick(['CASH', 'UPI', 'UPI', 'CARD']),
          feePaise,
          frontDeskUserId,
          startAt,
        ],
      );
    }
  }

  // Keep the counter consistent with the tokens just issued, or the next
  // check-in would collide with an existing token number.
  await client.query(
    `INSERT INTO queue_counter (tenant_id, practitioner_id, queue_date, last_token)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, practitioner_id, queue_date)
       DO UPDATE SET last_token = EXCLUDED.last_token`,
    [tenant.id, practitioner.id, today, token],
  );

  await client.query('COMMIT');
  return created;
}

try {
  await client.connect();

  const { rows: tenants } = await client.query('SELECT id, slug, name FROM tenant ORDER BY slug');
  if (tenants.length === 0) {
    console.error('No tenants found. Run seed:demo first.');
    process.exit(1);
  }

  for (const tenant of tenants) {
    const doctors = tenant.slug === 'lotus-polyclinic' ? LOTUS_DOCTORS : DOCTORS;
    const { practitioners, locations, deptIds } = await seedTenant(tenant, doctors);

    let appts = 0;
    for (const p of practitioners.slice(0, 2)) {
      appts += await seedTodaysQueue(tenant, p, locations[0].id, deptIds[p.dept]);
    }

    console.log(
      `  ${tenant.name.padEnd(20)} ${DEPARTMENTS.length} departments, ` +
        `${practitioners.length} doctors, ${appts} appointments today`,
    );
  }

  console.log('\nScheduling data ready.\n');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Scheduling seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
