#!/usr/bin/env node
/**
 * Seeds the chargeable catalogue and per-doctor fees.
 *
 *   pnpm --filter @healthcloud/db seed:billing
 *
 * Safe to re-run: services are upserted on (tenant, code), and existing invoices
 * are untouched — a price change must never rewrite a bill that has already been
 * issued.
 *
 * IMPORTANT: seeding this turns the pay-first gate ON for the tenant. Before it
 * runs, nothing is priced, no invoices are raised, and check-in behaves exactly
 * as it did before the billing module existed. See
 * BillingService.ensureInvoiceForAppointment.
 *
 * All prices are in PAISE. ₹350.00 is 35000.
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

/**
 * [code, name, category, pricePaise, taxRateBasisPoints]
 *
 * Consultations carry no GST — healthcare services by a clinical establishment
 * are exempt under Notification 12/2017. Consumables are not exempt, which is
 * why the rate is a column rather than an assumption; the seeded consumable
 * carries 12% (1200 basis points) so the arithmetic is exercised by something.
 */
const SERVICES = [
  ['CONS-NEW', 'Consultation — new patient', 'CONSULTATION', 50000, 0],
  ['CONS-FOLLOWUP', 'Consultation — follow-up', 'CONSULTATION', 30000, 0],
  ['CONS-TELE', 'Teleconsultation', 'CONSULTATION', 40000, 0],
  ['PROC-DRESS', 'Dressing', 'PROCEDURE', 25000, 0],
  ['PROC-INJ', 'Injection administration', 'PROCEDURE', 15000, 0],
  ['PROC-SUTURE', 'Suturing — minor', 'PROCEDURE', 120000, 0],
  ['PROC-NEB', 'Nebulisation', 'PROCEDURE', 20000, 0],
  ['DIAG-ECG', 'ECG', 'DIAGNOSTIC', 30000, 0],
  ['DIAG-BP', 'Blood pressure monitoring', 'DIAGNOSTIC', 5000, 0],
  ['DIAG-SUGAR', 'Random blood sugar', 'DIAGNOSTIC', 10000, 0],
  ['CONSUM-KIT', 'Dressing kit', 'CONSUMABLE', 8000, 1200],
];

/** Consultants in one clinic charge differently; a flat clinic fee is a fiction. */
const DOCTOR_FEES = {
  'Vikram Rao': [60000, 35000],
  'Anjali Deshpande': [50000, 30000],
  'Suresh Iyer': [80000, 45000],
  'Priya Nair': [70000, 40000],
  'Imran Shaikh': [40000, 25000],
  'Lakshmi Menon': [45000, 25000],
};

const client = new pg.Client({ connectionString: ownerUrl });

try {
  await client.connect();

  const { rows: tenants } = await client.query('SELECT id, name FROM tenant ORDER BY slug');
  if (tenants.length === 0) {
    console.error('No tenants found. Run seed:demo first.');
    process.exit(1);
  }

  for (const tenant of tenants) {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);

    for (const [code, name, category, pricePaise, taxRate] of SERVICES) {
      await client.query(
        `INSERT INTO service
           (tenant_id, code, name, category, price_paise, tax_rate_basis_points, updated_at)
         VALUES ($1, $2, $3, $4::service_category, $5, $6, now())
         ON CONFLICT (tenant_id, code)
           DO UPDATE SET name        = EXCLUDED.name,
                         category    = EXCLUDED.category,
                         price_paise = EXCLUDED.price_paise,
                         tax_rate_basis_points = EXCLUDED.tax_rate_basis_points,
                         is_active   = true,
                         updated_at  = now()`,
        [tenant.id, code, name, category, pricePaise, taxRate],
      );
    }

    let doctors = 0;
    for (const [name, [consult, followUp]] of Object.entries(DOCTOR_FEES)) {
      const { rowCount } = await client.query(
        `UPDATE practitioner
            SET consultation_fee_paise = $2, follow_up_fee_paise = $3, updated_at = now()
          WHERE tenant_id = $1 AND full_name = $4`,
        [tenant.id, consult, followUp, name],
      );
      doctors += rowCount ?? 0;
    }

    // The receipt series. Created here rather than lazily so a clinic's first
    // invoice is INV-000001 rather than whatever a race produced.
    await client.query(
      `INSERT INTO invoice_counter (tenant_id, prefix) VALUES ($1, 'INV')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenant.id],
    );

    await client.query('COMMIT');
    console.log(
      `  ${tenant.name.padEnd(20)} ${SERVICES.length} services, ${doctors} doctor fees set`,
    );
  }

  console.log('\nBilling catalogue ready. Pay-first is now active for these clinics.\n');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Billing seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
