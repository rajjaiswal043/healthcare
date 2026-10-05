#!/usr/bin/env node
/**
 * Seeds the patient journey — docs/10 — so the follow-up board, the recovery
 * panel and the return-rate chart show something on first load.
 *
 *   pnpm --filter @healthcloud/db seed:journey
 *
 * Run after seed:scheduling, which clears these rows along with the
 * appointments they hang off. `seed:demo` runs both in order.
 *
 * For the doctor linked to doctor@demo.local (or the first doctor), per clinic:
 *
 *   - WhatsApp consent for every demo patient, so messages actually "send" to
 *     the console when you click through;
 *   - ten weeks of past consultations with review dates, some of whom came
 *     back — the return rate climbs, because that is the story being demoed;
 *   - this week's reviews: some back, some booked, some still due;
 *   - three overdue, and one patient whose pain is rising (flagged);
 *   - for the first patient WAITING in today's queue, a previous visit whose
 *     check-ins fall from 7 to 3 — open their consultation to see the panel.
 *
 * Every figure here is made up. It is demo data and says so on nothing, so do
 * not screenshot it into a pitch as a result.
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

const client = new pg.Client({ connectionString: ownerUrl });

const NOTICE_VERSION = '2026-09-v1';
const DAY = 86400000;

function clinicToday(timeZone = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

function at(date, hhmm) {
  return new Date(`${date}T${hhmm}:00+05:30`);
}

/** Monday on or before a date. */
function mondayOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

/** Deterministic, so the chart is the same shape on every reseed. */
function makeRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const COMPLAINTS = [
  ['Left knee pain on stairs', 'Ice pack 15 min twice a day. Avoid squatting.'],
  ['Lower back pain after lifting', 'Hot fomentation. Core exercises as shown.'],
  ['Right shoulder stiffness', 'Pendulum exercises three times a day.'],
  ['Ankle sprain, playing cricket', 'Crepe bandage. Elevate the foot when sitting.'],
  ['Neck pain, desk work', 'Chin tucks every hour. Raise the screen to eye level.'],
  ['Wrist pain after fall', 'Wrist splint at night. Avoid lifting heavy bags.'],
];

async function seedTenant(tenant) {
  const today = clinicToday();
  const rand = makeRandom(20260929);

  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);

  const doctor = (
    await client.query(
      `SELECT p.id, p.user_id, p.full_name
         FROM practitioner p
        WHERE p.is_active
        ORDER BY (p.user_id IS NULL), p.created_at
        LIMIT 1`,
    )
  ).rows[0];
  const location = (await client.query('SELECT id FROM location ORDER BY created_at LIMIT 1'))
    .rows[0];
  const signer =
    doctor?.user_id ??
    (await client.query('SELECT id FROM app_user ORDER BY created_at LIMIT 1')).rows[0]?.id;
  const { rows: patients } = await client.query(
    'SELECT id, name FROM patient ORDER BY created_at LIMIT 60',
  );

  if (!doctor || !location || !signer || patients.length < 40) {
    await client.query('ROLLBACK');
    return null;
  }

  // --- consent -------------------------------------------------------------
  const consent = await client.query(
    `INSERT INTO consent_record (tenant_id, patient_id, purpose, granted, notice_version)
     SELECT $1, p.id, 'COMMUNICATIONS', true, $2
       FROM patient p
      WHERE NOT EXISTS (
        SELECT 1 FROM consent_record c
         WHERE c.patient_id = p.id AND c.purpose = 'COMMUNICATIONS')`,
    [tenant.id, NOTICE_VERSION],
  );

  const fee = Number(
    (
      await client.query(
        `SELECT coalesce(pr.follow_up_fee_paise, s.price_paise, 35000) AS fee
           FROM practitioner pr
           LEFT JOIN service s ON s.tenant_id = pr.tenant_id AND s.code = 'CONS-FU'
          WHERE pr.id = $1`,
        [doctor.id],
      )
    ).rows[0].fee,
  );

  // Tokens on past days start high, clear of anything the queue seed issued.
  const tokens = new Map();
  const nextToken = (date) => {
    const n = (tokens.get(date) ?? 60) + 1;
    tokens.set(date, n);
    return n;
  };

  async function visit(patientId, date, status, visitType = 'NEW') {
    const start = at(date, '10:00');
    const { rows } = await client.query(
      `INSERT INTO appointment
         (tenant_id, patient_id, practitioner_id, location_id, start_at, end_at,
          status, visit_type, source, token_number, queue_date,
          checked_in_at, ready_at, called_at, completed_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$5::timestamptz + interval '15 minutes',
               $6::appointment_status, $7::visit_type, 'FRONT_DESK', $8, $9,
               $10, $10, $11, $12, now())
       RETURNING id`,
      [
        tenant.id,
        patientId,
        doctor.id,
        location.id,
        start,
        status,
        visitType,
        nextToken(date),
        date,
        status === 'BOOKED' ? null : new Date(start.getTime() - 10 * 60000),
        status === 'FULFILLED' ? start : null,
        status === 'FULFILLED' ? new Date(start.getTime() + 12 * 60000) : null,
      ],
    );
    return rows[0].id;
  }

  async function bill(patientId, appointmentId) {
    const { number } = (
      await client.query(`SELECT next_invoice_number($1::uuid) AS number`, [tenant.id])
    ).rows[0];
    await client.query(
      `INSERT INTO invoice
         (tenant_id, number, patient_id, appointment_id, status,
          subtotal_paise, tax_paise, total_paise, updated_at)
       VALUES ($1,$2,$3,$4,'PAID',$5,0,$5, now())`,
      [tenant.id, number, patientId, appointmentId, fee],
    );
  }

  async function consultation(patientId, visitDate, reviewDate, interval, complaintIndex) {
    const appointmentId = await visit(patientId, visitDate, 'FULFILLED');
    const [complaint, advice] = COMPLAINTS[complaintIndex % COMPLAINTS.length];
    const started = at(visitDate, '10:02');
    const { rows } = await client.query(
      `INSERT INTO encounter
         (tenant_id, appointment_id, patient_id, practitioner_id, status,
          chief_complaint, advice, follow_up_date, check_in_interval_days,
          started_at, signed_at, signed_by_user_id, updated_at)
       VALUES ($1,$2,$3,$4,'SIGNED',$5,$6,$7,$8,$9,$9::timestamptz + interval '11 minutes',$10, now())
       RETURNING id`,
      [
        tenant.id,
        appointmentId,
        patientId,
        doctor.id,
        complaint,
        advice,
        reviewDate,
        interval,
        started,
        signer,
      ],
    );
    return rows[0].id;
  }

  /** Answered check-ins, one per `interval` days, with these pain scores. */
  async function checkins(encounterId, patientId, visitDate, interval, pains, opts = {}) {
    for (const [i, pain] of pains.entries()) {
      const due = addDays(visitDate, (i + 1) * interval);
      if (due > today) break;
      const answered = pain === null ? null : at(due, '19:30');
      const previous = i > 0 ? pains[i - 1] : null;
      const flag =
        pain !== null && (pain >= 8 || (previous !== null && pain - previous >= 2))
          ? pain >= 8
            ? `Severe pain reported (${pain}/10)`
            : `Pain rising, ${previous} → ${pain}`
          : null;
      await client.query(
        `INSERT INTO recovery_checkin
           (tenant_id, encounter_id, patient_id, due_on, sent_at, answered_at,
            pain_score, exercises_done, note, flagged_at, flag_reason, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())`,
        [
          tenant.id,
          encounterId,
          patientId,
          due,
          at(due, '18:00'),
          answered,
          pain,
          pain === null ? null : (opts.exercises?.[i] ?? rand() > 0.25),
          opts.notes?.[i] ?? null,
          flag ? answered : null,
          flag,
        ],
      );
    }
  }

  let encounters = 0;
  let patientCursor = 12; // 0–11 are in today's queue.
  const nextPatient = () => patients[patientCursor++ % patients.length];

  // --- ten weeks of history: the return rate climbs --------------------------
  const thisMonday = mondayOf(today);
  const RATES = [0.5, 0.5, 0.55, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
  for (let w = 9; w >= 1; w--) {
    const reviewWeek = addDays(thisMonday, -7 * w);
    const due = 4 + Math.floor(rand() * 2);
    const backCount = Math.round(due * RATES[9 - w]);
    for (let k = 0; k < due; k++) {
      const p = nextPatient();
      const review = addDays(reviewWeek, Math.min(5, k));
      const visitDate = addDays(review, -14);
      const e = await consultation(p.id, visitDate, review, k % 2 === 0 ? 3 : null, k);
      encounters += 1;
      if (k % 2 === 0) {
        await checkins(
          e,
          p.id,
          visitDate,
          3,
          [7, 6, 5, 4].map((v) => v - (k % 3)),
        );
      }
      if (k < backCount) {
        const back = await visit(p.id, review, 'FULFILLED', 'FOLLOW_UP');
        await bill(p.id, back);
      }
    }
  }

  // --- this week ------------------------------------------------------------
  for (let k = 0; k < 6; k++) {
    const p = nextPatient();
    const review = addDays(thisMonday, k);
    const visitDate = addDays(review, -14);
    const e = await consultation(p.id, visitDate, review, 3, k + 2);
    encounters += 1;
    await checkins(e, p.id, visitDate, 3, [6, 5, 5, 4]);
    if (review < today && k !== 1) {
      const back = await visit(p.id, review, 'FULFILLED', 'FOLLOW_UP');
      await bill(p.id, back);
    } else if (review >= today && k % 2 === 0) {
      await visit(p.id, addDays(review, review === today ? 1 : 0), 'BOOKED', 'FOLLOW_UP');
    }
  }

  // --- overdue ----------------------------------------------------------------
  for (const daysAgo of [3, 5, 9]) {
    const p = nextPatient();
    const review = addDays(today, -daysAgo);
    await consultation(p.id, addDays(review, -21), review, null, daysAgo);
    encounters += 1;
  }

  // --- pain rising: flagged, not yet called back -------------------------------
  {
    const p = nextPatient();
    const visitDate = addDays(today, -7);
    const e = await consultation(p.id, visitDate, addDays(today, 7), 2, 1);
    encounters += 1;
    await checkins(e, p.id, visitDate, 2, [5, 6, 8], {
      notes: [null, null, 'Pain woke me up last night'],
    });
  }

  // --- the patient waiting now: a recovery to look at ---------------------
  //
  // The first ARRIVED patient in today's queue for this doctor. Their previous
  // visit was 17 days ago, check-ins every 3 days, pain 7 → 3.
  const waiting = (
    await client.query(
      `SELECT patient_id FROM appointment
        WHERE practitioner_id = $1 AND queue_date = $2 AND status = 'ARRIVED'
        ORDER BY ready_at LIMIT 1`,
      [doctor.id, today],
    )
  ).rows[0];
  if (waiting) {
    const visitDate = addDays(today, -17);
    const e = await consultation(waiting.patient_id, visitDate, today, 3, 0);
    encounters += 1;
    await checkins(e, waiting.patient_id, visitDate, 3, [7, 6, 6, 4, 4, 3], {
      exercises: [true, true, false, true, true, true],
      notes: [
        null,
        null,
        null,
        'Much easier to walk now',
        null,
        'Stairs are still hard in the morning',
      ],
    });
  }

  await client.query('COMMIT');
  return { consents: consent.rowCount, encounters, doctor: doctor.full_name };
}

try {
  await client.connect();
  const { rows: tenants } = await client.query('SELECT id, name FROM tenant ORDER BY slug');

  for (const tenant of tenants) {
    const result = await seedTenant(tenant);
    if (!result) {
      console.log(`  ${tenant.name.padEnd(20)} skipped (run seed:demo and seed:scheduling first)`);
      continue;
    }
    console.log(
      `  ${tenant.name.padEnd(20)} ${result.consents} WhatsApp consents, ` +
        `${result.encounters} past consultations for ${result.doctor}`,
    );
  }
  console.log(
    '\nPatient journey data ready. Open Follow-ups, or consult the first waiting patient.\n',
  );
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Journey seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
