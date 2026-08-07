#!/usr/bin/env node
/**
 * Seeds each tenant's drug list.
 *
 *   pnpm --filter @healthcloud/db seed:formulary
 *
 * Safe to re-run: rows are upserted on (tenant, name, strength), and anything a
 * doctor added by typing it into a prescription (`is_custom`) is left alone.
 *
 * WHY A LIST AT ALL, and why it does not have to be complete: with no list,
 * every prescription is a spelling variant and the structured fields on
 * `prescription` buy nothing. With a MANDATORY list, the first drug a clinic
 * stocks that we did not seed makes the software unusable mid-consultation with
 * a patient waiting. So this is a starting point that the clinic grows, and the
 * prescription field accepts anything.
 *
 * Brands are the common Indian ones because that is what gets written on an
 * Indian prescription; the generic is carried alongside so search finds either.
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

/** [brand, generic, strength, form] */
const DRUGS = [
  // --- analgesics and antipyretics -----------------------------------------
  ['Dolo 650', 'Paracetamol', '650 mg', 'TABLET'],
  ['Crocin Advance', 'Paracetamol', '500 mg', 'TABLET'],
  ['Calpol', 'Paracetamol', '250 mg/5 ml', 'SYRUP'],
  ['Combiflam', 'Ibuprofen + Paracetamol', '400/325 mg', 'TABLET'],
  ['Brufen', 'Ibuprofen', '400 mg', 'TABLET'],
  ['Zerodol-SP', 'Aceclofenac + Paracetamol + Serratiopeptidase', '100/325/15 mg', 'TABLET'],
  ['Zerodol-P', 'Aceclofenac + Paracetamol', '100/325 mg', 'TABLET'],
  ['Naprosyn', 'Naproxen', '250 mg', 'TABLET'],
  ['Ultracet', 'Tramadol + Paracetamol', '37.5/325 mg', 'TABLET'],
  ['Voveran', 'Diclofenac', '50 mg', 'TABLET'],
  ['Volini', 'Diclofenac topical', '30 g', 'OINTMENT'],

  // --- antibiotics ---------------------------------------------------------
  ['Augmentin 625', 'Amoxicillin + Clavulanic acid', '500/125 mg', 'TABLET'],
  ['Augmentin Duo', 'Amoxicillin + Clavulanic acid', '200/28.5 mg/5 ml', 'SYRUP'],
  ['Mox 500', 'Amoxicillin', '500 mg', 'CAPSULE'],
  ['Azithral 500', 'Azithromycin', '500 mg', 'TABLET'],
  ['Azee 250', 'Azithromycin', '250 mg', 'TABLET'],
  ['Cefixime', 'Cefixime', '200 mg', 'TABLET'],
  ['Taxim-O 200', 'Cefixime', '200 mg', 'TABLET'],
  ['Ciplox 500', 'Ciprofloxacin', '500 mg', 'TABLET'],
  ['Levoflox 500', 'Levofloxacin', '500 mg', 'TABLET'],
  ['Doxy-1', 'Doxycycline', '100 mg', 'CAPSULE'],
  ['Flagyl 400', 'Metronidazole', '400 mg', 'TABLET'],
  ['Norflox-TZ', 'Norfloxacin + Tinidazole', '400/600 mg', 'TABLET'],
  ['Septran DS', 'Cotrimoxazole', '800/160 mg', 'TABLET'],
  ['Monocef', 'Ceftriaxone', '1 g', 'INJECTION'],
  ['Clavam 625', 'Amoxicillin + Clavulanic acid', '500/125 mg', 'TABLET'],
  ['Roxid 150', 'Roxithromycin', '150 mg', 'TABLET'],

  // --- gastrointestinal ----------------------------------------------------
  ['Pan 40', 'Pantoprazole', '40 mg', 'TABLET'],
  ['Pan-D', 'Pantoprazole + Domperidone', '40/30 mg', 'CAPSULE'],
  ['Omez', 'Omeprazole', '20 mg', 'CAPSULE'],
  ['Rablet 20', 'Rabeprazole', '20 mg', 'TABLET'],
  ['Digene', 'Antacid gel', '170 ml', 'SYRUP'],
  ['Gelusil MPS', 'Antacid + Simethicone', '200 ml', 'SYRUP'],
  ['Ondem 4', 'Ondansetron', '4 mg', 'TABLET'],
  ['Emeset', 'Ondansetron', '2 mg/ml', 'INJECTION'],
  ['Domstal', 'Domperidone', '10 mg', 'TABLET'],
  ['Cyclopam', 'Dicyclomine + Paracetamol', '20/325 mg', 'TABLET'],
  ['Meftal Spas', 'Mefenamic acid + Dicyclomine', '250/10 mg', 'TABLET'],
  ['Duphalac', 'Lactulose', '100 ml', 'SYRUP'],
  ['Econorm', 'Saccharomyces boulardii', '250 mg', 'SACHET'],
  ['ORS', 'Oral rehydration salts', '21.8 g', 'SACHET'],
  ['Sporlac', 'Lactic acid bacillus', '60 mg', 'TABLET'],
  ['Zinc sulphate', 'Zinc', '20 mg', 'TABLET'],

  // --- respiratory and allergy ---------------------------------------------
  ['Levocet', 'Levocetirizine', '5 mg', 'TABLET'],
  ['Cetirizine', 'Cetirizine', '10 mg', 'TABLET'],
  ['Montair-LC', 'Montelukast + Levocetirizine', '10/5 mg', 'TABLET'],
  ['Montair 10', 'Montelukast', '10 mg', 'TABLET'],
  ['Allegra 120', 'Fexofenadine', '120 mg', 'TABLET'],
  ['Avil 25', 'Pheniramine', '25 mg', 'TABLET'],
  ['Ascoril LS', 'Levosalbutamol + Ambroxol + Guaifenesin', '100 ml', 'SYRUP'],
  ['Grilinctus', 'Cough syrup', '100 ml', 'SYRUP'],
  ['Asthalin', 'Salbutamol', '100 mcg', 'INHALER'],
  ['Foracort 200', 'Formoterol + Budesonide', '200 mcg', 'INHALER'],
  ['Otrivin', 'Xylometazoline', '0.1%', 'DROPS'],
  ['Sinarest', 'Paracetamol + Phenylephrine + CPM', '500 mg', 'TABLET'],
  ['Deriphyllin', 'Etophylline + Theophylline', '150 mg', 'TABLET'],
  ['Wikoryl', 'Paracetamol + Phenylephrine + CPM', '500 mg', 'TABLET'],

  // --- cardiometabolic -----------------------------------------------------
  ['Metformin', 'Metformin', '500 mg', 'TABLET'],
  ['Glycomet GP1', 'Metformin + Glimepiride', '500/1 mg', 'TABLET'],
  ['Januvia 100', 'Sitagliptin', '100 mg', 'TABLET'],
  ['Amaryl 2', 'Glimepiride', '2 mg', 'TABLET'],
  ['Telma 40', 'Telmisartan', '40 mg', 'TABLET'],
  ['Telma-H', 'Telmisartan + Hydrochlorothiazide', '40/12.5 mg', 'TABLET'],
  ['Amlong 5', 'Amlodipine', '5 mg', 'TABLET'],
  ['Losar 50', 'Losartan', '50 mg', 'TABLET'],
  ['Metolar XR 25', 'Metoprolol', '25 mg', 'TABLET'],
  ['Ecosprin 75', 'Aspirin', '75 mg', 'TABLET'],
  ['Atorva 10', 'Atorvastatin', '10 mg', 'TABLET'],
  ['Rosuvas 10', 'Rosuvastatin', '10 mg', 'TABLET'],
  ['Clopilet 75', 'Clopidogrel', '75 mg', 'TABLET'],
  ['Lasix 40', 'Furosemide', '40 mg', 'TABLET'],
  ['Thyronorm 50', 'Levothyroxine', '50 mcg', 'TABLET'],
  ['Eltroxin 100', 'Levothyroxine', '100 mcg', 'TABLET'],

  // --- vitamins and supplements --------------------------------------------
  ['Shelcal 500', 'Calcium + Vitamin D3', '500 mg', 'TABLET'],
  ['Uprise D3', 'Cholecalciferol', '60000 IU', 'SACHET'],
  ['Neurobion Forte', 'Vitamin B complex', '—', 'TABLET'],
  ['Zincovit', 'Multivitamin + Zinc', '—', 'TABLET'],
  ['Livogen', 'Ferrous fumarate + Folic acid', '152/1.5 mg', 'TABLET'],
  ['Autrin', 'Iron + Folic acid + B12', '—', 'CAPSULE'],
  ['Becosules', 'B complex + Vitamin C', '—', 'CAPSULE'],
  ['Folvite', 'Folic acid', '5 mg', 'TABLET'],
  ['Methycobal', 'Mecobalamin', '500 mcg', 'TABLET'],
  ['Limcee', 'Vitamin C', '500 mg', 'TABLET'],

  // --- skin ----------------------------------------------------------------
  ['Candid B', 'Clotrimazole + Beclometasone', '15 g', 'OINTMENT'],
  ['Betnovate-N', 'Betamethasone + Neomycin', '20 g', 'OINTMENT'],
  ['Soframycin', 'Framycetin', '30 g', 'OINTMENT'],
  ['Terbinaforce', 'Terbinafine', '250 mg', 'TABLET'],
  ['Itraconazole', 'Itraconazole', '100 mg', 'CAPSULE'],
  ['Fluconazole', 'Fluconazole', '150 mg', 'TABLET'],
  ['Permite', 'Permethrin', '5%', 'OINTMENT'],
  ['Calamine lotion', 'Calamine', '100 ml', 'OTHER'],
  ['Clinsol gel', 'Clindamycin', '15 g', 'OINTMENT'],

  // --- eye, ear and topical -------------------------------------------------
  ['Moxicip eye drops', 'Moxifloxacin', '5 ml', 'DROPS'],
  ['Ciplox eye/ear drops', 'Ciprofloxacin', '10 ml', 'DROPS'],
  ['Refresh Tears', 'Carboxymethylcellulose', '10 ml', 'DROPS'],
  ['Waxolve', 'Paradichlorobenzene ear drops', '10 ml', 'DROPS'],

  // --- neurological and psychiatric ------------------------------------------
  ['Vertin 16', 'Betahistine', '16 mg', 'TABLET'],
  ['Stemetil', 'Prochlorperazine', '5 mg', 'TABLET'],
  ['Sumo', 'Nimesulide + Paracetamol', '100/325 mg', 'TABLET'],
  ['Naxdom 250', 'Naproxen + Domperidone', '250/10 mg', 'TABLET'],
  ['Etilaam 0.25', 'Etizolam', '0.25 mg', 'TABLET'],
  ['Nexito 5', 'Escitalopram', '5 mg', 'TABLET'],
  ['Gabapin 100', 'Gabapentin', '100 mg', 'CAPSULE'],
  ['Pregabid 75', 'Pregabalin', '75 mg', 'CAPSULE'],

  // --- urology and gynaecology ----------------------------------------------
  ['Urimax 0.4', 'Tamsulosin', '0.4 mg', 'CAPSULE'],
  ['Alkasol', 'Potassium citrate', '100 ml', 'SYRUP'],
  ['Meftal Forte', 'Mefenamic acid', '500 mg', 'TABLET'],
  ['Regestrone 5', 'Norethisterone', '5 mg', 'TABLET'],
  ['Clotrimazole pessary', 'Clotrimazole', '100 mg', 'OTHER'],

  // --- steroids and others ---------------------------------------------------
  ['Wysolone 10', 'Prednisolone', '10 mg', 'TABLET'],
  ['Medrol 8', 'Methylprednisolone', '8 mg', 'TABLET'],
  ['Deriphyllin Retard', 'Etophylline + Theophylline', '150 mg', 'TABLET'],
  ['Tetanus toxoid', 'Tetanus toxoid', '0.5 ml', 'INJECTION'],
  ['Rabipur', 'Rabies vaccine', '1 ml', 'INJECTION'],
];

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
    // Tenant context first: formulary_item is under FORCE row-level security, so
    // both the insert and the conflict check need it.
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);

    let written = 0;
    for (const [name, generic, strength, form] of DRUGS) {
      const { rowCount } = await client.query(
        `INSERT INTO formulary_item
           (tenant_id, name, generic_name, strength, form, is_custom, updated_at)
         VALUES ($1, $2, $3, $4, $5::medication_form, false, now())
         ON CONFLICT (tenant_id, name, strength)
           DO UPDATE SET generic_name = EXCLUDED.generic_name,
                         form         = EXCLUDED.form,
                         is_active    = true,
                         updated_at   = now()`,
        [tenant.id, name, generic, strength, form],
      );
      written += rowCount ?? 0;
    }

    await client.query('COMMIT');
    console.log(`  ${tenant.name.padEnd(20)} ${written} formulary entries`);
  }

  console.log('\nFormulary ready.\n');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Formulary seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
