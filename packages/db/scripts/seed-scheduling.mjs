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
import { requireSeedableDatabase } from './seed-guard.mjs';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
loadEnv({ path: resolve(REPO_ROOT, '.env') });

const ownerUrl = process.env.MIGRATION_DATABASE_URL;
requireSeedableDatabase(ownerUrl, 'seed-scheduling');

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

/** `[name, displayOrder, isDiagnostic]`. */
const DEPARTMENTS = [
  ['General Medicine', 1, false],
  ['Paediatrics', 2, false],
  ['Orthopaedics', 3, false],
  ['Dermatology', 4, false],
  ['ENT', 5, false],
  // Diagnostic departments, added 29 Sep 2026. Without them the home board's
  // "At a department" tab is permanently empty and the walk-in test flow — a
  // patient who comes in for an X-ray and never sees a doctor — cannot be
  // demonstrated at all.
  ['X-ray', 6, true],
  ['Pathology', 7, true],
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

/**
 * A clinic-local date, `YYYY-MM-DD`, this many days back. `clinicDate(0)` is
 * today.
 *
 * Stepped in whole days against UTC midday rather than by subtracting
 * milliseconds from now, so a clinic in a zone with daylight saving cannot land
 * on the same date twice or skip one. India has none; the timezone is a column.
 */
function clinicDate(daysAgo, timeZone = 'Asia/Kolkata') {
  const at = new Date();
  at.setUTCHours(12, 0, 0, 0);
  at.setUTCDate(at.getUTCDate() - daysAgo);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
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
  // Diagnostics before billing, and both before appointments. A diagnostic
  // order holds RESTRICT references in three directions at once — to the
  // appointment it was raised on, to the invoice line that charged for it, and
  // from any film or report filed against it — so it has to come out first or
  // the teardown stops on whichever one it meets.
  //
  // Only the documents belonging to an order are cleared. A file attached to a
  // patient directly is not part of the scheduling demo and is left alone.
  await client.query(
    `DELETE FROM clinical_document
      WHERE tenant_id = $1 AND diagnostic_order_id IS NOT NULL`,
    [tenant.id],
  );
  await client.query('DELETE FROM diagnostic_order WHERE tenant_id = $1', [tenant.id]);

  // Billing first: invoice.appointment_id is ON DELETE RESTRICT, and payment
  // references the invoice, so an appointment cannot be cleared while a bill
  // points at it. Order matters — receipts, payments, lines, then invoices.
  //
  // `receipt` arrived with the printed receipt in Sep 2026 and holds a RESTRICT
  // reference to `payment`, which broke this script silently until somebody ran
  // it: every reseed failed on "violates RESTRICT setting of foreign key
  // constraint receipt_payment_fkey". A receipt is a record of a document
  // handed to a patient, so RESTRICT is right — the demo teardown simply has to
  // clear it first, like everything else here — and `receipt_print` before it,
  // which holds the same kind of reference to the receipt.
  await client.query(
    `DELETE FROM receipt_print WHERE receipt_id IN
       (SELECT id FROM receipt WHERE tenant_id = $1)`,
    [tenant.id],
  );
  await client.query('DELETE FROM receipt WHERE tenant_id = $1', [tenant.id]);
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
  for (const [name, order, isDiagnostic] of DEPARTMENTS) {
    const { rows } = await client.query(
      `INSERT INTO department (tenant_id, name, display_order, is_diagnostic, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (tenant_id, name) DO UPDATE
         SET display_order = EXCLUDED.display_order,
             is_diagnostic = EXCLUDED.is_diagnostic
       RETURNING id`,
      [tenant.id, name, order, isDiagnostic],
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
 * Seeds one day's queue for one doctor.
 *
 * TODAY is a plausible mid-morning clinic: some finished, one in the room, some
 * waiting with tokens, and some yet to arrive — every state the board has a tab
 * for, so the screen is worth looking at the moment it loads.
 *
 * A PAST DAY is a day that finished. Everybody was seen and went home, the
 * tests came back, and the money was taken — except for the one or two who left
 * owing, which is the whole reason anybody looks back at a past day. There is
 * no point seeding a Tuesday with three people still waiting: Tuesday is over,
 * and a board that says otherwise is a board nobody can trust.
 *
 * Different patients each day, stepped through the list by `daysAgo`, so the
 * same twelve people are not apparently living at the clinic.
 */
async function seedTodaysQueue(
  tenant,
  practitioner,
  locationId,
  deptId,
  diagnosticDeptIds,
  daysAgo = 0,
  doctorIndex = 0,
) {
  const today = clinicDate(daysAgo);
  const isToday = daysAgo === 0;

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

  // 4 finished, 1 with the doctor, 2 out for tests, 3 waiting, 4 still to
  // arrive. AWAITING_TESTS is the patient the doctor sent for an X-ray
  // mid-consultation: same visit, same token, same bill — out of the room and
  // out of the waiting list until they come back.
  //
  // A past day has none of those middle states. It finished: nine seen, two
  // sent for tests that came back, and one who never turned up — because a
  // no-show still owes nothing and still has to be explicable on the day-end
  // report.
  const plan = isToday
    ? [
        ...Array(4).fill('FULFILLED'),
        'IN_PROGRESS',
        ...Array(2).fill('AWAITING_TESTS'),
        ...Array(3).fill('ARRIVED'),
        ...Array(4).fill('BOOKED'),
      ]
    : [...Array(9).fill('FULFILLED'), ...Array(2).fill('AWAITING_TESTS'), 'NO_SHOW'];

  /**
   * Who walked out still owing, on a past day.
   *
   * Two of them, and they are the point of being able to look back at all: the
   * desk's question about a Tuesday is "who owes us from Tuesday", and a seeded
   * past day where everybody paid cannot answer it. Pay-first is the rule, not
   * a law of physics — a patient seen as a favour, or a bill raised after they
   * left, lands exactly here.
   */
  const leftOwing = new Set(isToday ? [] : [2, 7]);

  let created = 0;
  let token = 0;

  for (const [i, status] of plan.entries()) {
    /**
     * A different twelve people for every doctor, every day.
     *
     * Both doctors used to walk the same slice, so one patient held two
     * appointments on one morning with two different doctors — and the board,
     * which is one row per PATIENT, merged them into a single row. The day read
     * as half the size it was, which is a poor way to find out whether a busy
     * board is usable.
     *
     * Wraps rather than running out, which only shows on a clinic seeded with
     * few patients.
     */
    const slice = (daysAgo * 2 + doctorIndex) * plan.length;
    const patient = patients[(i + slice) % patients.length];
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
          sent_out_at, sent_out_reason, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::appointment_status,$9::visit_type,
               $10::appointment_source,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
       RETURNING id`,
        [
          tenant.id,
          patient.id,
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
          // Out for tests means they were called in first, so they have a
          // called_at like anyone the doctor has seen.
          ['FULFILLED', 'IN_PROGRESS', 'AWAITING_TESTS'].includes(status) ? startAt : null,
          status === 'FULFILLED' ? endAt : null,
          status === 'AWAITING_TESTS' ? new Date(startAt.getTime() + 5 * 60000) : null,
          // `appointment_send_out_is_explained`: you cannot send a patient out
          // of the room without saying what for. The flag that brings them back
          // ahead of the queue is only reachable through a recorded send-out.
          status === 'AWAITING_TESTS'
            ? i % 2 === 0
              ? 'X-ray — right knee'
              : 'Blood test — CBC'
            : null,
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
     *
     * On a past day, the two in `leftOwing` are finished AND unpaid — the row
     * the desk goes looking for when it steps back a day.
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
          patient.id,
          appointmentId,
          arrived && !leftOwing.has(i) ? 'PAID' : 'UNPAID',
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

    /**
     * The test the doctor asked for, for a patient sent out mid-visit.
     *
     * `legacy_unbilled` is true so the demo does not have to raise a second
     * invoice per test: the flag means "raised before tests were billable" and
     * is never blocked by the pay-first gate, which keeps the seeded worklist
     * workable rather than a wall of unpaid tests nobody can clear.
     */
    if (status === 'AWAITING_TESTS' && frontDeskUserId) {
      /**
       * A past day's film has been read and handed over. Leaving it PENDING
       * would park a patient under "At a department" on a day the clinic
       * closed, and put work on a technician's board that nobody can do.
       *
       * `diagnostic_order_completion_is_attributed` wants the time AND the
       * person together, so both go or neither does.
       */
      const done = !isToday;

      await client.query(
        `INSERT INTO diagnostic_order
           (tenant_id, appointment_id, patient_id, department_id, ordered_by_user_id,
            description, status, referral_source, legacy_unbilled, result_note,
            completed_at, completed_by_user_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::diagnostic_order_status,'INTERNAL',true,$8,
                 $9::timestamptz,$10::uuid,$11, now())`,
        [
          tenant.id,
          appointmentId,
          patient.id,
          i % 2 === 0 ? diagnosticDeptIds.xray : diagnosticDeptIds.pathology,
          frontDeskUserId,
          i % 2 === 0 ? 'X-ray — right knee, AP and lateral' : 'Complete blood count',
          done ? 'COMPLETED' : 'PENDING',
          done
            ? i % 2 === 0
              ? 'No fracture seen. Mild degenerative change in the medial compartment.'
              : 'Haemoglobin 12.8, counts within normal limits.'
            : null,
          done ? new Date(startAt.getTime() + 40 * 60000) : null,
          done ? frontDeskUserId : null,
          new Date(startAt.getTime() + 5 * 60000),
        ],
      );
    }

    if (arrived && !leftOwing.has(i)) {
      const payment = rows0(
        await client.query(
          `INSERT INTO payment
             (tenant_id, invoice_id, direction, mode, amount_paise, collected_by_user_id, collected_at)
           VALUES ($1, $2, 'IN', $3::payment_mode, $4, $5,
                   $6::timestamptz - interval '12 minutes')
           RETURNING id`,
          [
            tenant.id,
            invoice.id,
            pick(['CASH', 'UPI', 'UPI', 'CARD']),
            feePaise,
            frontDeskUserId,
            startAt,
          ],
        ),
      );

      /**
       * A receipt for the money, because the app writes one for every payment
       * it takes.
       *
       * Without this the seed produced payments that no receipt could be
       * printed for — and the Receipt button, which asks only whether money
       * came in, offered a sheet the server then refused with "No receipt for
       * that payment". The screens now check for the receipt rather than the
       * payment, and the seed stopped being the odd one out.
       *
       * The money block is frozen here exactly as `collectPayment` freezes it:
       * a receipt records what a document said, not what the invoice says
       * today.
       */
      const receiptNumber = rows0(
        await client.query(`SELECT next_receipt_number($1::uuid) AS number`, [tenant.id]),
      );

      await client.query(
        `INSERT INTO receipt
           (tenant_id, payment_id, invoice_id, number, total_charged_paise,
            discount_paise, tax_paise, payable_paise, paid_now_paise, balance_paise, issued_at)
         VALUES ($1, $2, $3, $4, $5, 0, 0, $5, $5, 0,
                 $6::timestamptz - interval '12 minutes')`,
        [tenant.id, payment.id, invoice.id, receiptNumber.number, feePaise, startAt],
      );
    }
  }

  /**
   * Walk-in tests: patients who came in for an X-ray and will never see a
   * doctor.
   *
   * These have NO appointment — `appointment_id` is null, which is the whole
   * point of the walk-in diagnostics work. They exist only as diagnostic
   * orders, so any screen built on the appointment table alone cannot see
   * them, and the home board's "At a department" tab is where they show up.
   *
   * Taken from the far end of the patient list so they never collide with the
   * twelve the queue above just used, and only for the first doctor seeded at
   * each clinic — a walk-in belongs to the clinic, not to a doctor, so seeding
   * them once per doctor would multiply them.
   */
  // Today only: a walk-in test that is still pending is work in progress, and
  // a day that is over has none.
  if (isToday && frontDeskUserId && practitioner.isFirst && patients.length >= 20) {
    const walkIns = [
      { offset: 1, status: 'PENDING', dept: 'xray', what: 'X-ray — chest, PA view' },
      { offset: 2, status: 'PENDING', dept: 'pathology', what: 'Lipid profile, fasting' },
      { offset: 3, status: 'COMPLETED', dept: 'xray', what: 'X-ray — left wrist' },
    ];

    for (const w of walkIns) {
      const patient = patients[patients.length - w.offset];
      const done = w.status === 'COMPLETED';

      await client.query(
        `INSERT INTO diagnostic_order
           (tenant_id, appointment_id, patient_id, department_id, ordered_by_user_id,
            description, status, referral_source, referrer_name, legacy_unbilled,
            completed_at, completed_by_user_id, created_at, updated_at)
         VALUES ($1, NULL, $2,$3,$4,$5,$6::diagnostic_order_status,$7,$8,true,
                 $9::timestamptz,$10::uuid,$11, now())`,
        [
          tenant.id,
          patient.id,
          diagnosticDeptIds[w.dept],
          frontDeskUserId,
          w.what,
          w.status,
          // One of the three was sent by a doctor at another hospital, which is
          // the case the referrer fields exist for.
          w.offset === 2 ? 'EXTERNAL_DOCTOR' : 'SELF',
          w.offset === 2 ? 'Dr S. Menon, Apollo' : null,
          done ? new Date() : null,
          done ? frontDeskUserId : null,
          new Date(Date.now() - w.offset * 40 * 60000),
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

    /**
     * Today, and the two days before it.
     *
     * The board can be stepped back a day at a time, and a date picker with
     * nothing behind it is a feature nobody can try. Two days is enough to tell
     * "yesterday" from "a past day" — the arrows, the calendar, the Today
     * button and the read-only rule all have something to act on — without
     * seeding a month nobody will look at.
     */
    let today = 0;
    let earlier = 0;

    for (const daysAgo of [0, 1, 2]) {
      for (const [index, p] of practitioners.slice(0, 2).entries()) {
        // Walk-in tests belong to the clinic, not to a doctor, so they are
        // seeded once — on the first doctor's pass — rather than once per
        // doctor.
        p.isFirst = index === 0;
        const made = await seedTodaysQueue(
          tenant,
          p,
          locations[0].id,
          deptIds[p.dept],
          { xray: deptIds['X-ray'], pathology: deptIds['Pathology'] },
          daysAgo,
          index,
        );
        if (daysAgo === 0) today += made;
        else earlier += made;
      }
    }

    console.log(
      `  ${tenant.name.padEnd(20)} ${DEPARTMENTS.length} departments, ` +
        `${practitioners.length} doctors, ${today} appointments today, ` +
        `${earlier} over the two days before`,
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
