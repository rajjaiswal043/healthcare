#!/usr/bin/env node
/**
 * Demo seed — a fictional clinic with enough realistic data to demo and to make
 * search and duplicate detection actually do something.
 *
 *   pnpm --filter @healthcloud/db seed:demo
 *
 * Two tenants are created on purpose. The second one exists so that a demo can
 * show tenant isolation working, rather than only asserting it: switch tenants
 * and the patient list is completely different.
 *
 * All data is obviously synthetic. Mobiles come from a reserved-looking range,
 * and nothing here should ever be confused with real patient data.
 *
 * Re-running wipes and rebuilds. Safe by design, so a demo can never be spoiled
 * by yesterday's poking around.
 */

import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
loadEnv({ path: resolve(REPO_ROOT, '.env') });

const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!ownerUrl) {
  console.error('MIGRATION_DATABASE_URL is not set. Run `pnpm preflight`.');
  process.exit(1);
}

const dbName = new URL(ownerUrl).pathname.replace(/^\//, '');
if (!dbName.startsWith('healthcloud')) {
  console.error(`Refusing to seed "${dbName}" — not a HealthCloud database.`);
  process.exit(1);
}

// --- Name pools. Deliberately spread across regions, and including the kind of
// --- near-duplicate spellings that make fuzzy matching worth having.
const GIVEN_MALE = [
  'Rajesh',
  'Amit',
  'Suresh',
  'Vikram',
  'Arjun',
  'Sanjay',
  'Sanjai',
  'Ramesh',
  'Karthik',
  'Mohammed',
  'Muhammad',
  'Imran',
  'Anil',
  'Deepak',
  'Ravi',
  'Prakash',
  'Nitin',
  'Harish',
  'Girish',
  'Manoj',
  'Ashok',
  'Vijay',
];
const GIVEN_FEMALE = [
  'Priya',
  'Anjali',
  'Sunita',
  'Kavita',
  'Meera',
  'Lakshmi',
  'Laxmi',
  'Fatima',
  'Aisha',
  'Divya',
  'Pooja',
  'Shreya',
  'Neha',
  'Rekha',
  'Sarita',
  'Geeta',
  'Anita',
  'Sneha',
  'Nandini',
  'Radha',
];
const SURNAMES = [
  'Sharma',
  'Verma',
  'Patil',
  'Deshmukh',
  'Joshi',
  'Kulkarni',
  'Iyer',
  'Nair',
  'Reddy',
  'Rao',
  'Gupta',
  'Agarwal',
  'Khan',
  'Shaikh',
  'Naidu',
  'Pillai',
  'Chauhan',
  'Yadav',
  'Mishra',
  'Bhat',
  'Kadam',
  'Jadhav',
];
const CITIES = [
  ['Pune', 'Maharashtra', '411001'],
  ['Pune', 'Maharashtra', '411038'],
  ['Pimpri', 'Maharashtra', '411018'],
  ['Nashik', 'Maharashtra', '422001'],
  ['Mumbai', 'Maharashtra', '400001'],
];
const BLOOD = [
  'O_POSITIVE',
  'O_POSITIVE',
  'B_POSITIVE',
  'B_POSITIVE',
  'A_POSITIVE',
  'AB_POSITIVE',
  'O_NEGATIVE',
  'A_NEGATIVE',
  'UNKNOWN',
];

/** Deterministic PRNG, so the demo dataset is identical on every reseed. */
function makeRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const rand = makeRandom(20260806);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));

function makeMobile() {
  // Indian mobiles are exactly 10 digits starting 6-9. Leading 9 plus nine more
  // digits — obviously synthetic, correct shape, and the shape is what matters:
  // duplicate detection keys on mobile, and the registration DTO enforces
  // /^[6-9]\d{9}$/, so anything shorter would make seeded data unusable.
  return `9${String(int(100000000, 999999999))}`;
}

const client = new pg.Client({ connectionString: ownerUrl });

const TENANTS = [
  {
    slug: 'sunrise-clinic',
    name: 'Sunrise Clinic',
    legalName: 'Sunrise Healthcare Services Pvt Ltd',
    prefix: 'SNC',
    patients: 240,
    locations: ['Sunrise Clinic — Kothrud', 'Sunrise Clinic — Baner'],
  },
  {
    slug: 'lotus-polyclinic',
    name: 'Lotus Polyclinic',
    legalName: 'Lotus Medical Centre LLP',
    prefix: 'LTS',
    patients: 60,
    locations: ['Lotus Polyclinic — Nashik Road'],
  },
];

async function seedTenant(t) {
  const { rows } = await client.query(
    `INSERT INTO tenant (slug, name, legal_name, uhid_prefix, uhid_padding, updated_at)
     VALUES ($1, $2, $3, $4, 5, now())
     RETURNING id`,
    [t.slug, t.name, t.legalName, t.prefix],
  );
  const tenantId = rows[0].id;

  // Tenant context is required even for the owner: FORCE ROW LEVEL SECURITY
  // means the policies apply to the table owner too, so there is no connection
  // that can write across tenants.
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

  for (const name of t.locations) {
    await client.query(
      `INSERT INTO location (tenant_id, name, city, state, updated_at)
       VALUES ($1, $2, $3, 'Maharashtra', now())`,
      [tenantId, name, name.split('—')[1]?.trim() ?? 'Pune'],
    );
  }

  let created = 0;
  for (let i = 0; i < t.patients; i++) {
    const isFemale = rand() < 0.52;
    const given = isFemale ? pick(GIVEN_FEMALE) : pick(GIVEN_MALE);
    const name = `${given} ${pick(SURNAMES)}`;
    const [city, state, pin] = pick(CITIES);

    // ~35% have no known date of birth — realistic for Indian OPD, and it
    // exercises the age-only path through registration.
    const knowsDob = rand() < 0.65;
    const age = int(1, 88);
    const birthDate = knowsDob
      ? new Date(Date.UTC(2026 - age, int(0, 11), int(1, 28))).toISOString().slice(0, 10)
      : null;

    const { rows: uhidRows } = await client.query('SELECT next_uhid($1::uuid) AS uhid', [tenantId]);

    const { rows: patientRows } = await client.query(
      `INSERT INTO patient
         (tenant_id, uhid, name, gender, birth_date, age_years, mobile,
          address_line, city, state, postal_code, blood_group, updated_at)
       VALUES ($1,$2,$3,$4::gender,$5,$6,$7,$8,$9,$10,$11,$12::blood_group, now())
       RETURNING id`,
      [
        tenantId,
        uhidRows[0].uhid,
        name,
        isFemale ? 'FEMALE' : 'MALE',
        birthDate,
        knowsDob ? null : age,
        makeMobile(),
        `${int(1, 99)}, ${pick(['Shivaji', 'Gandhi', 'Nehru', 'Tilak', 'Patil'])} Nagar`,
        city,
        state,
        pin,
        pick(BLOOD),
      ],
    );

    // Consent is captured for every patient — a patient row without one is the
    // compliance gap this schema exists to prevent.
    for (const [purpose, granted] of [
      ['CARE_DELIVERY', true],
      ['MARKETING', rand() < 0.4],
    ]) {
      await client.query(
        `INSERT INTO consent_record
           (tenant_id, patient_id, purpose, granted, notice_version)
         VALUES ($1, $2, $3::consent_purpose, $4, '2026-08-v1')`,
        [tenantId, patientRows[0].id, purpose, granted],
      );
    }

    created++;
  }

  await client.query('COMMIT');
  return { tenantId, created };
}

try {
  await client.connect();

  console.log('Resetting demo data...');
  await client.query(
    `TRUNCATE TABLE appointment, queue_counter, schedule_exception,
                    practitioner_schedule, practitioner, department,
                    session, user_role, app_user, role,
                    audit_event, consent_record, patient, location, tenant
     RESTART IDENTITY CASCADE`,
  );

  for (const t of TENANTS) {
    const { created } = await seedTenant(t);
    console.log(`  ${t.name.padEnd(20)} slug=${t.slug.padEnd(18)} ${created} patients`);
  }

  console.log('\nDemo data ready.\n');
  console.log('  Try:  curl -H "x-demo-tenant: sunrise-clinic" \\');
  console.log('             "http://localhost:3001/api/v1/patients?q=sharma"\n');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
